'use strict';
/* ============================================================================
   v2.4.69 — ПРЕГЛЕД НА КРЪГА: находките от прегледа на кода върху пълния тест.
   ============================================================================
   Всяка е възпроизведена върху кода от кръга, преди да бъде поправена, и всеки
   тест тук пада, когато поправката се върне. Минава през истинския main.js —
   връзките между модулите (МЗС ↔ резервации, книги ↔ онлайн каталог) са точно
   мястото, където тези находки живееха. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { startMainApp } = require('./helpers/main-app');
const { localDate } = require('../local-date');

const APP_DIR = path.join(__dirname, '..');
const T = localDate();
const tmp = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d; };

let app, db;
test.before(async () => {
  app = startMainApp();
  await app.ready();
  db = new Database(path.join(app.userData, 'library.db'));
});
test.after(() => {
  if (db) db.close();
  if (app) app.stop();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

const cat = () => db.prepare("SELECT id FROM categories WHERE name = 'книга'").get().id;
function addBook(inv, title, qty, extra) {
  const id = db.prepare("INSERT INTO books (inv_number, title, status, category_id, register_date, price, barcode) VALUES (?, ?, 'наличен', ?, ?, 1, ?)")
    .run(inv, title, cat(), T, (extra && extra.barcode) || null).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, qty || 1);
  return id;
}
let cardNo = 9000;
function addReader(name) {
  return db.prepare("INSERT INTO readers (name, card_no, status, gdpr_consent) VALUES (?, ?, 'активен', 1)")
    .run(name, String(cardNo++)).lastInsertRowid;
}
let mzsNo = 900;
function addMzs(row) {
  return db.prepare(`INSERT INTO mzs_requests (no, year, date, direction, partner, title, status, book_id, reader_id, due_date)
    VALUES (@no, @year, @date, @direction, @partner, @title, @status, @book_id, @reader_id, @due_date)`).run(Object.assign({
    no: mzsNo++, year: T.slice(0, 4), date: T, partner: 'РБ Габрово', title: 'Чужда книга',
    book_id: null, reader_id: null, due_date: null
  }, row)).lastInsertRowid;
}

test('резервация: единствената бройка при партньора по МЗС НЕ е „свободна — заемете я“', async () => {
  const b = addBook(7001, 'Рядка книга', 1);
  addMzs({ direction: 'входящо', status: 'изпратено', book_id: b, title: 'Рядка книга' });
  const r = addReader('Чака МЗС');
  /* Заемането отказва — документът е при партньора. */
  const co = await app.invoke('loans:checkout', { reader_id: r, book_id: b, date_out: T, date_due: null });
  assert.equal(co.ok, false);
  assert.match(co.error, /междубиблиотечно/);
  /* И резервацията вече се приема, вместо „свободен е — заемете го“. */
  const h = await app.invoke('holds:add', { reader_id: r, code: '7001' });
  assert.equal(h.ok, true, h.error);
  assert.equal(db.prepare("SELECT status FROM holds WHERE reader_id = ? AND book_id = ?").get(r, b).status, 'чака');
});

test('изтриване на читател, у когото е чужда книга по МЗС, се отказва — както заличаването по чл. 17', async () => {
  const r = addReader('Държи чужда книга');
  addMzs({ direction: 'изходящо', status: 'получено', reader_id: r, title: 'Книга на РБ Габрово', due_date: T });
  const del = await app.invoke('readers:delete', r);
  assert.equal(del.ok, false, 'изтрит');
  assert.match(del.error, /междубиблиотечно заемане/);
  assert.ok(db.prepare('SELECT 1 FROM readers WHERE id = ?').get(r));
});

test('МЗС: повторен запис на заявката пази свързания документ — и при номер, съвпадащ с чужд баркод, и без инв. №', async () => {
  const mine = addBook(7101, 'Наш документ', 1);
  addBook(7102, 'Друг документ', 1, { barcode: '7101' });          // баркодът му е инв. № на нашия
  const id1 = addMzs({ direction: 'входящо', status: 'изпратено', book_id: mine, title: 'Наш документ' });
  const u1 = await app.invoke('mzs:update', { id: id1, book_code: '7101', note: 'само бележка' });
  assert.equal(u1.ok, true, u1.error);
  assert.equal(db.prepare('SELECT book_id, note FROM mzs_requests WHERE id = ?').get(id1).book_id, mine);

  const noInv = addBook(null, 'Документ без номер', 1);
  const id2 = addMzs({ direction: 'входящо', status: 'заявено', book_id: noInv, title: 'Документ без номер' });
  const u2 = await app.invoke('mzs:update', { id: id2, book_code: '', note: 'пак бележка' });
  assert.equal(u2.ok, true, u2.error);
  assert.equal(db.prepare('SELECT book_id FROM mzs_requests WHERE id = ?').get(id2).book_id, noInv,
    'формата показа празно поле и го върна празно — връзката не бива да пада');
});

test('прескочени номера: заглавие „Задачи от 1 до 100“ не се чете като прескочени 1–100', async () => {
  for (const n of [8001, 8002, 8004]) addBook(n, 'Поредица ' + n, 1);
  db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('', 'Прескочени инвентарни номера', ?)")
    .run('при вписване на инв. № 8004 („Задачи от 1 до 100“) остават неизползвани инв. № 8003 — въведени на ръка, без документ по тях');
  const gaps = (await app.invoke('books:invGaps')).data;
  const g = gaps.find(x => x.from <= 8003 && x.to >= 8003);
  assert.ok(g, JSON.stringify(gaps));
  assert.equal(g.from, 8003);
  assert.equal(g.to, 8003);
  assert.ok(g.skippedAt || g.ts || g.day || JSON.stringify(g).includes(T), 'прескоченият номер е познат от следата: ' + JSON.stringify(g));
});

test('изтриване на читател: вече заделената резервация на друг НЕ се обявява като ново повикване', async () => {
  const b = addBook(7201, 'Учебник', 2);
  const a = addReader('Изтрит А'), bb = addReader('Вече заделено Б'), c = addReader('Държи бройка');
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)").run(c, b, T, T);
  db.prepare("INSERT INTO holds (reader_id, book_id, status, ready_at) VALUES (?, ?, 'заделена', datetime('now'))").run(a, b);
  db.prepare("INSERT INTO holds (reader_id, book_id, status, ready_at) VALUES (?, ?, 'заделена', datetime('now'))").run(bb, b);
  /* Изтриване на читател с история иска второ натискане (защитата от v2.4.6x). */
  const first = await app.invoke('readers:delete', a);
  const del = first.ok ? first : await app.invoke('readers:delete', a);
  assert.equal(del.ok, true, del.error);
  assert.deepEqual(del.data.holdsActivated, [], 'Б беше заделена и преди — „съобщете му“ е невярно');
});

test('онлайн каталог: книга в пробна база, която би свила публикувания каталог, го казва ВЕДНАГА на формата', async () => {
  const folder = mk('inv-p69-kat-');
  const items = Array.from({ length: 40 }, (_, i) => ({ inv: 100000 + i, title: 'Публикувана ' + i }));
  fs.writeFileSync(path.join(folder, 'katalog.json'), JSON.stringify({ library: 'Б', items }));
  db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(folder);
  const res = await app.invoke('books:create', { inv_number: 8501, title: 'Пробна книга', category_id: cat(), register_date: T, price: 1 });
  assert.equal(res.ok, true, res.error);
  assert.match(String(res.catalogWarning || ''), /СПРЯН: публикуваният katalog\.json има 40 записа/,
    'формата мълчи, а отложеният запис ще бъде спрян');
  db.prepare('UPDATE settings SET catalog_folder = NULL WHERE id = 1').run();
});

test('съименници: етикетът на връзката различава двата картона и следи преименуването', async () => {
  const p1 = db.prepare("INSERT INTO persons (name) VALUES ('Вълчев, Стефан')").run().lastInsertRowid;
  const p2 = db.prepare("INSERT INTO persons (name) VALUES ('Стефан Вълчев')").run().lastInsertRowid;
  const ch = db.prepare("INSERT INTO chronicle (year, title, category) VALUES (1930, 'Сбор', 'читалище')").run().lastInsertRowid;
  assert.equal((await app.invoke('links:add', { fromKind: 'летопис', fromId: ch, toKind: 'персона', toId: p1 })).ok, true);
  const label = async () => (await app.invoke('links:list', { fromKind: 'летопис', fromId: ch })).data[0].label;
  assert.equal(await label(), 'Вълчев, Стефан (картон № ' + p1 + ')');
  /* Преименуването маха съименника — броят не остава от предишното четене. */
  db.prepare("UPDATE persons SET name = 'Вълчев, Петър' WHERE id = ?").run(p2);
  assert.equal(await label(), 'Вълчев, Стефан');
  const links = fs.readFileSync(path.join(APP_DIR, 'handlers', 'links.js'), 'utf8');
  assert.match(links, /require\('\.\/persons'\)/, 'ключът на името идва от handlers/persons.js, не е второ копие');
});

test('печат на партиди: съобщението не твърди „отпечатани“, когато програмата не може да го знае', () => {
  const core = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'core.js'), 'utf8');
  assert.doesNotMatch(core, /Отпечатани са всички/);
  assert.match(core, /партиди са изпратени за печат/);
});
