'use strict';
/* Кръг 44 (v2.4.69) — ОНЛАЙН КАТАЛОГ И МЗС.
   =====================================================================
   Всяка находка тук има поне един тест, който ПАДА, ако поправката се върне
   (проверено с връщане на поправката в отделно копие на хранилището). Тестовете
   твърдят това, което вижда библиотекарката или читателят: реда в katalog.json,
   текста на екрана „Онлайн каталог“ и „МЗС“, реда в базата и в одитната следа,
   числата на страницата на сайта.

   Три части:
     А) обработчиците поотделно (МЗС, ОРЗД, авторитетни данни, видове,
        номенклатури, таймерът за публикуване) — бързо, без Electron;
     Б) истинският main.js + истинският екран (test/helpers/e2e-app.js) —
        предпазителят, паметта за последния запис, „налична“ в каталога,
        сигнатурата и публичните надписи;
     В) страницата на сайта (site/page-katalog.html) в jsdom — филтрите по
        екземпляри, плочките, броят налични, транслитерацията, сянката.
   Пуска се с `node --test test/katalog-mzs-v2469.test.js`. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { localDate } = require('../local-date');

const tmpDirs = [];
function mkTmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { console.error('временна папка:', e.message); }
  }
});

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}
function freshDb() {
  const dir = mkTmpDir('inv-k44-');
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}
function baseDeps(db, extra) {
  const auditLog = [];
  const deps = Object.assign({
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    yearOf: (d) => (d || localDate()).slice(0, 4)
  }, extra || {});
  return { deps, auditLog };
}
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const T = localDate();
function addBook(db, row) {
  const b = Object.assign({ inv_number: null, title: 'Книга', status: 'наличен', quantity: 1 }, row);
  const id = db.prepare('INSERT INTO books (inv_number, title, status, author) VALUES (?,?,?,?)')
    .run(b.inv_number, b.title, b.status, b.author || null).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, b.quantity);
  return id;
}
function addReader(db, name, card, phone) {
  return db.prepare("INSERT INTO readers (name, card_no, phone, category) VALUES (?, ?, ?, 'възрастен')")
    .run(name, card, phone || null).lastInsertRowid;
}

/* ==========================================================================
   А) ОБРАБОТЧИЦИТЕ
   ========================================================================== */

/* ---------- МЗС: преходи, дати, номер, връзки (К8) ---------- */
function mzsSetup() {
  const db = freshDb();
  const writes = [];
  const { deps, auditLog } = baseDeps(db, { scheduleCatalogWrite: (k) => writes.push(k || 'fund') });
  const ipc = fakeIpcMain();
  require('../handlers/mzs')(ipc, deps);
  return { db, ipc, auditLog, writes };
}

test('К8: състоянията не се прескачат — отказ с обяснение какво следва; напред — датата се попълва сама', async () => {
  const { db, ipc, auditLog } = mzsSetup();
  const id = (await ipc.invoke('mzs:create', { no: 1, date: T, partner: 'РБ Габрово', title: 'Рядка книга' })).data;
  const jump = await ipc.invoke('mzs:update', { id, status: 'върнато' });
  assert.equal(jump.ok, false, 'прескачането „заявено“ → „върнато“ е записано');
  assert.match(jump.error, /не може да стане „върнато“/);
  assert.match(jump.error, /Оттук следва „изпратено“ или „отказано“/);
  assert.equal(db.prepare('SELECT status FROM mzs_requests WHERE id = ?').get(id).status, 'заявено');

  assert.equal((await ipc.invoke('mzs:update', { id, status: 'изпратено' })).ok, true);
  assert.equal(db.prepare('SELECT date_sent FROM mzs_requests WHERE id = ?').get(id).date_sent, T, 'датата на изпращане не е попълнена');
  // Изходяща „получено“ без срок — отказ: по срока се следи просрочието.
  const noDue = await ipc.invoke('mzs:update', { id, status: 'получено' });
  assert.equal(noDue.ok, false);
  assert.match(noDue.error, /Срок за връщане/);
  assert.equal((await ipc.invoke('mzs:update', { id, status: 'получено', due_date: addDays(T, 30) })).ok, true);
  assert.equal((await ipc.invoke('mzs:update', { id, status: 'върнато' })).ok, true);
  const row = db.prepare('SELECT status, date_sent, date_received, date_returned FROM mzs_requests WHERE id = ?').get(id);
  assert.deepEqual(row, { status: 'върнато', date_sent: T, date_received: T, date_returned: T });
  assert.match(auditLog[auditLog.length - 1].detail, /състояние „получено“ → „върнато“ на /);

  // Една стъпка назад — поправка: датата на отменената стъпка се маха.
  assert.equal((await ipc.invoke('mzs:update', { id, status: 'получено' })).ok, true);
  assert.equal(db.prepare('SELECT date_returned FROM mzs_requests WHERE id = ?').get(id).date_returned, null);
  assert.match(auditLog[auditLog.length - 1].detail, /ПОПРАВКА на състоянието/);
  // „отказано“ след получаване — не.
  const late = await ipc.invoke('mzs:update', { id, status: 'отказано' });
  assert.equal(late.ok, false);
  assert.match(late.error, /отказ се отбелязва само докато документът не е получен/);
});

test('К8: нова заявка започва от „заявено“ — „направо върната“ се отказва', async () => {
  const { db, ipc } = mzsSetup();
  const r = await ipc.invoke('mzs:create', { no: 1, date: T, partner: 'РБ', title: 'Направо върната', status: 'върнато' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Нова заявка започва от „заявено“/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mzs_requests').get().n, 0);
});

test('К8: номерът се пресмята по годината на ДАТАТА на заявката', async () => {
  const { db, ipc } = mzsSetup();
  const Y = Number(T.slice(0, 4));
  await ipc.invoke('mzs:create', { no: 1, date: T, partner: 'А', title: 'а' });
  await ipc.invoke('mzs:create', { no: 2, date: T, partner: 'Б', title: 'б' });
  // Празен № (формата го изпраща празен, щом годината на датата е друга) → първият за миналата година.
  const r = await ipc.invoke('mzs:create', { no: '', date: (Y - 1) + '-12-20', partner: 'В', title: 'Заявка от декември' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(db.prepare("SELECT no, year FROM mzs_requests WHERE title = 'Заявка от декември'").get(),
    { no: 1, year: String(Y - 1) });
});

test('К8: изходяща заявка се свързва с читател по картата; входяща — с наш документ, който тогава е блокиран', async () => {
  const { db, ipc, writes } = mzsSetup();
  const rid = addReader(db, 'Здравка Междубиблиотечна', '8001');
  const bid = addBook(db, { inv_number: 1, title: 'Под игото', author: 'Вазов, Иван' });
  const { mzsBlockForBook } = require('../handlers/mzs');

  const out = (await ipc.invoke('mzs:create', { no: 1, date: T, partner: 'РБ', title: 'Чужда', reader_card: '8001' })).data;
  assert.equal(db.prepare('SELECT reader_id FROM mzs_requests WHERE id = ?').get(out).reader_id, rid);
  const list = (await ipc.invoke('mzs:list')).data;
  assert.equal(list.find(x => x.id === out).reader_name, 'Здравка Междубиблиотечна', 'регистърът не показва свързания читател');
  const badCard = await ipc.invoke('mzs:create', { no: 5, date: T, partner: 'РБ', title: 'Х', reader_card: '9999' });
  assert.match(badCard.error, /Читател с карта № 9999 няма/);

  const inc = (await ipc.invoke('mzs:create', { no: 2, date: T, direction: 'входящо', partner: 'НЧ „Развитие“', title: 'Под игото' })).data;
  // „изпратено“ без документ — отказ с обяснение.
  const noBook = await ipc.invoke('mzs:update', { id: inc, status: 'изпратено' });
  assert.equal(noBook.ok, false);
  assert.match(noBook.error, /Отбележете кой наш документ изпращате/);
  // Наш читател на входяща — отказ.
  const wrong = await ipc.invoke('mzs:update', { id: inc, reader_card: '8001' });
  assert.match(wrong.error, /само ИЗХОДЯЩА/);

  writes.length = 0;
  assert.equal((await ipc.invoke('mzs:update', { id: inc, status: 'изпратено', book_code: '1', due_date: addDays(T, 20) })).ok, true);
  assert.equal(writes.length, 1, 'изпратеният наш документ не насрочи запис на онлайн каталога');
  const why = mzsBlockForBook(db, bid);
  assert.match(why || '', /изпратен по междубиблиотечно заемане на НЧ „Развитие“ \(заявка № 2\//);
  assert.match(why, /отбележете заявката „върнато“ в „МЗС“/);

  assert.equal((await ipc.invoke('mzs:update', { id: inc, status: 'получено' })).ok, true);
  assert.ok(mzsBlockForBook(db, bid), 'при партньора („получено“) документът пак не е тук');
  assert.equal((await ipc.invoke('mzs:update', { id: inc, status: 'върнато' })).ok, true);
  assert.equal(mzsBlockForBook(db, bid), null, 'върнатият документ отново може да се заема');
  assert.ok(writes.length >= 2, 'връщането не насрочи запис на онлайн каталога');
});

test('К8: нашият документ не тръгва, ако е зает на гишето', async () => {
  const { db, ipc } = mzsSetup();
  const bid = addBook(db, { inv_number: 7, title: 'Тютюн' });
  const rid = addReader(db, 'Читател', '1');
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)').run(bid, rid, T, addDays(T, 30));
  const inc = (await ipc.invoke('mzs:create', { no: 1, date: T, direction: 'входящо', partner: 'РБ', title: 'Тютюн' })).data;
  const r = await ipc.invoke('mzs:update', { id: inc, status: 'изпратено', book_code: '7' });
  assert.equal(r.ok, false);
  assert.match(r.error, /инв\. № 7 „Тютюн“ е зает от читател/);
});

/* ---------- К6: просрочените по МЗС ---------- */
test('К6: mzs:overdue връща получената чужда книга с изтекъл срок — с читателя и телефона', async () => {
  const { db, ipc } = mzsSetup();
  addReader(db, 'Здравка Междубиблиотечна', '8001', '0888 111 222');
  const id = (await ipc.invoke('mzs:create', { no: 90, date: addDays(T, -40), partner: 'РБ Габрово',
    title: 'Просрочена чужда книга', reader_card: '8001' })).data;
  await ipc.invoke('mzs:update', { id, status: 'изпратено', date_sent: addDays(T, -38) });
  await ipc.invoke('mzs:update', { id, status: 'получено', date_received: addDays(T, -35), due_date: addDays(T, -10) });
  // Невърната, но в срок — не е просрочена.
  const ok2 = (await ipc.invoke('mzs:create', { no: 91, date: T, partner: 'РБ', title: 'В срок' })).data;
  await ipc.invoke('mzs:update', { id: ok2, status: 'изпратено' });
  await ipc.invoke('mzs:update', { id: ok2, status: 'получено', due_date: addDays(T, 5) });

  const res = await ipc.invoke('mzs:overdue');
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 1);
  const o = res.data[0];
  assert.equal(o.days_over, 10);
  assert.equal(o.reader_phone, '0888 111 222');
  assert.match(o.text, /Чужда книга „Просрочена чужда книга“ от РБ Габрово \(МЗС № 90\/\d{4}\) — срокът за връщане изтече на .* \(преди 10 дни\)/);
  assert.match(o.text, /У читателя Здравка Междубиблиотечна \(карта 8001\), тел\. 0888 111 222/);
  // След връщане изчезва от списъка.
  await ipc.invoke('mzs:update', { id, status: 'върнато' });
  assert.equal((await ipc.invoke('mzs:overdue')).data.length, 0);
});

/* ---------- К7, Г7 и третата спирачка: заличаване по чл. 17 ---------- */
function gdprSetup() {
  const db = freshDb();
  const { deps, auditLog } = baseDeps(db);
  const holdsIpc = fakeIpcMain();
  const holds = require('../handlers/holds')(holdsIpc, Object.assign({}, deps, { normalizeScanCode: (s) => s }));
  const ipc = fakeIpcMain();
  require('../handlers/gdpr')(ipc, Object.assign({}, deps, { activateHoldOnReturn: holds.activateHoldOnReturn }));
  const mzsIpc = fakeIpcMain();
  require('../handlers/mzs')(mzsIpc, deps);
  return { db, ipc, mzsIpc, auditLog };
}

test('К7: заявителят в МЗС се заличава по reader_id и по „име (карта N)“; подобното име остава и се казва', async () => {
  const { db, ipc, mzsIpc } = gdprSetup();
  const rid = addReader(db, 'Здравка Междубиблиотечна', '8001');
  const linked = (await mzsIpc.invoke('mzs:create', { no: 1, date: T, partner: 'РБ', title: 'А',
    requester: 'З. М., кв. „Изток“', reader_card: '8001' })).data;
  const withCard = (await mzsIpc.invoke('mzs:create', { no: 2, date: T, partner: 'РБ', title: 'Б',
    requester: 'Здравка Междубиблиотечна (карта 8001)' })).data;
  const other = (await mzsIpc.invoke('mzs:create', { no: 3, date: T, partner: 'РБ', title: 'В',
    requester: 'Здравка Междубиблиотечна-Петрова' })).data;

  const res = await ipc.invoke('gdpr:forgetReader', { id: rid });
  assert.equal(res.ok, true, res.error);
  const req = (id) => db.prepare('SELECT requester, reader_id FROM mzs_requests WHERE id = ?').get(id);
  assert.deepEqual(req(linked), { requester: '[анонимизиран читател]', reader_id: null }, 'свързаната заявка не е заличена');
  assert.equal(req(withCard).requester, '[анонимизиран читател]', '„име (карта 8001)“ остана — точно находката К7');
  assert.equal(req(other).requester, 'Здравка Междубиблиотечна-Петрова', 'друг човек (двойно фамилно име) не бива да се пипа');
  assert.equal(res.data.mzsSimilar.length, 1);
  assert.match(res.data.mzsNote, /В регистъра на МЗС остава 1 заявка с подобно име на заявителя — № 3\/\d{4} \(„Здравка Междубиблиотечна-Петрова“\)/);
});

test('К8 + чл. 17: читател, който държи чужда книга по МЗС, не се заличава — с изход', async () => {
  const { db, ipc, mzsIpc } = gdprSetup();
  const rid = addReader(db, 'Иван Петров', '77');
  const id = (await mzsIpc.invoke('mzs:create', { no: 1, date: T, partner: 'РБ Русе', title: 'Чужда', reader_card: '77' })).data;
  await mzsIpc.invoke('mzs:update', { id, status: 'изпратено' });
  await mzsIpc.invoke('mzs:update', { id, status: 'получено', due_date: addDays(T, 20) });
  const res = await ipc.invoke('gdpr:forgetReader', { id: rid });
  assert.equal(res.ok, false);
  assert.match(res.error, /държи чужда книга, получена по междубиблиотечно заемане \(„Чужда“ от РБ Русе/);
  assert.match(res.error, /отбележете заявката „върнато“ в „МЗС“/);
  assert.ok(db.prepare('SELECT 1 FROM readers WHERE id = ?').get(rid), 'читателят е изтрит въпреки чуждата книга');
});

test('Г7: gdpr:forgetReader връща holdsActivated — кой е повикан за заделената книга, с телефона', async () => {
  const { db, ipc } = gdprSetup();
  const bid = addBook(db, { inv_number: 77, title: 'Под игото' });
  const a = addReader(db, 'Заличаван Читател', '1');
  const b = addReader(db, 'Игрек Повикан', '2', '0888 777');
  db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'заделена', datetime('now','-2 hours'))").run(bid, a);
  db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'чака', datetime('now','-1 hours'))").run(bid, b);
  const res = await ipc.invoke('gdpr:forgetReader', { id: a });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.holdsActivated, [{ name: 'Игрек Повикан', phone: '0888 777', title: 'Под игото', inv_number: 77 }]);
  assert.equal(db.prepare('SELECT status FROM holds WHERE reader_id = ?').get(b).status, 'заделена');
});

/* ---------- К2: промени, които трябва да стигнат до katalog.json ---------- */
test('К2: сливане на автори, преименуван вид, публичен надпис на отдел — насрочват запис на каталога', async () => {
  const db = freshDb();
  const writes = [];
  const { deps } = baseDeps(db, { scheduleCatalogWrite: () => writes.push(1) });
  const ipc = fakeIpcMain();
  require('../handlers/authorities')(ipc, deps);
  require('../handlers/categories')(ipc, deps);
  require('../handlers/av')(ipc, deps);
  const bid = addBook(db, { inv_number: 1, title: 'Под игото', author: 'Вазов, Иван' });
  const cat = (db.prepare("SELECT id FROM categories WHERE name = 'книга'").get()
    || { id: db.prepare("INSERT INTO categories (name) VALUES ('книга')").run().lastInsertRowid }).id;
  db.prepare('UPDATE books SET category_id = ? WHERE id = ?').run(cat, bid);

  assert.equal((await ipc.invoke('authorities:merge', { field: 'author', from: ['Вазов, Иван'], to: 'Вазов, Иван Минчов' })).ok, true);
  assert.equal(writes.length, 1, 'сливането на автори не насрочи запис на katalog.json');
  await ipc.invoke('authorities:merge', { field: 'author', from: ['Няма такъв'], to: 'Вазов, Иван Минчов' });
  assert.equal(writes.length, 1, 'сливане без засегнати документи не бива да пише');

  assert.equal((await ipc.invoke('categories:update', { id: cat, name: 'книга (печатна)' })).ok, true);
  assert.equal(writes.length, 2, 'преименуваният вид не насрочи запис на katalog.json');

  const save = (label) => ipc.invoke('av:save', { category: 'department', values: [{ value: 'за възрастни', opac_label: label }] });
  assert.equal((await save('Възрастни')).ok, true);
  assert.equal(writes.length, 3, 'публичният надпис на отдела не насрочи запис на katalog.json');
  await save('Възрастни');
  assert.equal(writes.length, 3, 'непроменен списък не бива да пише');
  await ipc.invoke('av:save', { category: 'location', values: [{ value: 'Рафт 1' }] });
  assert.equal(writes.length, 3, '„постоянно място“ не излиза в каталога');
});

/* ---------- К3: таймерът за публикуване не маха лентата за недостъпна папка ---------- */
test('К3: недостъпна свързана папка — автоматичното публикуване пази грешката, а не я изчиства', async () => {
  const db = freshDb();
  db.prepare("INSERT OR IGNORE INTO settings (id) VALUES (1)").run();
  const gone = path.join(mkTmpDir('inv-k44-gone-'), 'izklyuchen-disk');
  db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(gone);
  const { deps } = baseDeps(db, { dialog: {}, getMainWindow: () => null, fs, path, execFile: () => {},
    csvCell: (x) => x, flushCatalogWrite: () => ({ written: false }), buildCatalogPayload: () => ({ items: [] }),
    catalogJsonText: (p) => JSON.stringify(p) });
  const ipc = fakeIpcMain();
  const realSetInterval = global.setInterval;
  let tick = null;
  global.setInterval = (fn) => { tick = fn; return 1; };
  try {
    const cat = require('../handlers/catalog')(ipc, deps);
    cat.startAutoPushTimer();
  } finally { global.setInterval = realSetInterval; }
  await tick();
  const st = (await ipc.invoke('catalog:autoPushStatus')).data;
  assert.ok(st.error, 'таймерът изчисти грешката за изключения мрежов диск — червената лента изчезва');
  assert.match(st.error, /е недостъпна \(изключен мрежов диск/);
  assert.ok(st.error.includes(gone));
});

/* ==========================================================================
   Б) ИСТИНСКИЯТ main.js + ЕКРАНЪТ
   ========================================================================== */
const E = require('./helpers/e2e-app.js');
let h = null;
const folderA = mkTmpDir('inv-k44-katalog-');
const FILE = path.join(folderA, 'katalog.json');
const kat = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const item = (inv) => kat().items.find(i => i.inv === inv);
const ok = (r, what) => { assert.ok(r && r.ok, (what || '') + ': ' + (r && r.error)); return r.data; };
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const IDS = {};

test('Б0. подготовка: свързана папка, 10 книги през обработчиците', async () => {
  h = await E.bootApp();
  await h.waitFor(() => h.view() === 'setup');
  await h.settle();
  const st = ok(await h.api.settings.get());
  ok(await h.api.settings.update(Object.assign({}, st, { org: 'НЧ „Проба“', lib_name: 'Библиотека „Проба“', place: 'с. Яворец', loan_days: 30 })));
  await h.go('catalog');
  h.dialogs.openPaths = [folderA];
  await h.clickButton('Избери папката на хранилището…', '#view');
  await h.settle(100);
  const cat = q("SELECT id FROM categories WHERE name='книга'").id;
  for (let i = 1; i <= 10; i++) {
    IDS[i] = ok(await h.api.books.create({ inv_number: i, title: 'Книга ' + i, author: 'Автор, А', category_id: cat,
      register_date: T, price: 1 }), 'книга ' + i);
  }
  ok(await h.api.catalog.writeNow(), 'writeNow');
  assert.equal(kat().items.length, 10);
});

test('П4 (каталожната част): празна „Сигнатура“ → УДК + авторски знак в полето g', async () => {
  h.db.prepare("UPDATE books SET udk = '638(497.2)', author_mark = 'Й 83', call_number = NULL WHERE id = ?").run(IDS[3]);
  h.db.prepare("UPDATE books SET udk = '821', author_mark = 'В 12', call_number = '821/В 12 а' WHERE id = ?").run(IDS[4]);
  ok(await h.api.catalog.writeNow());
  assert.equal(item(3).g, '638(497.2) Й 83', 'онлайн каталогът показва празна сигнатура за книга, описана с помощниците');
  assert.equal(item(4).g, '821/В 12 а', 'попълнената „Сигнатура“ печели');
});

test('К9 (товарът): публичният надпис на отдела пътува с речник за плочките на сайта', async () => {
  h.db.prepare("UPDATE books SET department = 'за деца' WHERE id = ?").run(IDS[5]);
  const opts = ok(await h.api.av.options());
  const dep = (opts.department || []).map(x => x.value === 'за деца' ? { value: x.value, opac_label: 'Детски отдел' } : x);
  if (!dep.some(x => x.value === 'за деца')) dep.push({ value: 'за деца', opac_label: 'Детски отдел' });
  ok(await h.api.av.save({ category: 'department', values: dep }));
  ok(await h.api.catalog.writeNow());
  assert.equal(item(5).o, 'Детски отдел');
  assert.deepEqual(kat().departments, { 'за деца': 'Детски отдел' });
});

test('К4: „заделена“ резервация излиза „заета“ онлайн — и екранът брои същото', async () => {
  const A = ok(await h.api.readers.create({ name: 'Читател А', card_no: '101', gdpr_consent: true, category: 'възрастен', registered_at: T }));
  const B = ok(await h.api.readers.create({ name: 'Читател Б', card_no: '102', gdpr_consent: true, category: 'възрастен', registered_at: T }));
  ok(await h.api.loans.checkoutByCode({ reader_id: A, code: '1' }), 'заемане');
  ok(await h.api.holds.add({ reader_id: B, code: '1' }), 'резервация');
  const loan = q('SELECT id FROM loans WHERE date_in IS NULL AND book_id = ?', IDS[1]).id;
  ok(await h.api.loans.return({ id: loan }), 'връщане');
  assert.equal(q('SELECT status FROM holds WHERE reader_id = ?', B).status, 'заделена');
  ok(await h.api.catalog.writeNow());
  assert.equal(item(1).av, 0, 'заделената за Читател Б книга е „налична“ на сайта');
  const st = ok(await h.api.catalog.status());
  assert.equal(st.available, kat().items.filter(i => i.av).length, 'екранът „Онлайн каталог“ брои различно от файла');
});

test('К8 (каталогът): наш документ, изпратен по входяща МЗС, е „зает“ онлайн и блокиран за гишето', async () => {
  const id = ok(await h.api.mzs.create({ no: 1, date: T, direction: 'входящо', partner: 'НЧ „Развитие“', title: 'Книга 2' }));
  ok(await h.api.mzs.update({ id, status: 'изпратено', book_code: '2', due_date: addDays(T, 20) }));
  ok(await h.api.catalog.writeNow());
  assert.equal(item(2).av, 0, 'документът е в другата библиотека, а сайтът го показва наличен');
  assert.equal(ok(await h.api.catalog.status()).available, kat().items.filter(i => i.av).length);
  const { mzsBlockForBook } = require('../handlers/mzs');
  assert.match(mzsBlockForBook(h.db, IDS[2]) || '', /изпратен по междубиблиотечно заемане на НЧ „Развитие“/);
  // Регистърът на екрана показва нашия инв. №.
  await h.go('mzs');
  assert.match(h.text('#mzsBody'), /наш инв\. № 2/);
  ok(await h.api.mzs.update({ id, status: 'получено' }));
  ok(await h.api.mzs.update({ id, status: 'върнато' }));
  ok(await h.api.catalog.writeNow());
  assert.equal(item(2).av, 1, 'върнатият документ остава „зает“ онлайн');
});

test('К6 (екранът): просрочената чужда книга се вижда в регистъра на МЗС', async () => {
  const id = ok(await h.api.mzs.create({ date: addDays(T, -40), partner: 'РБ Габрово', title: 'Просрочена чужда книга' }));
  ok(await h.api.mzs.update({ id, status: 'изпратено', date_sent: addDays(T, -39) }));
  ok(await h.api.mzs.update({ id, status: 'получено', date_received: addDays(T, -38), due_date: addDays(T, -10) }));
  await h.go('mzs');
  assert.match(h.text('#mzsBody'), /просрочена 10 дни/);
  assert.match(h.viewText(), /Изтекъл срок за връщане: 1 заявка/);
  assert.match(h.viewText(), /Чужда книга „Просрочена чужда книга“ от РБ Габрово/);
});

test('К3: недостъпна папка — грешката на АВТОМАТИЧНИЯ запис се помни, показва и вписва; изчезва, когато записът мине', async () => {
  const away = folderA + '-izklyuchen';
  fs.renameSync(folderA, away);
  try {
    const before = h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'Онлайн каталог' AND detail LIKE 'ВНИМАНИЕ: записът на онлайн каталога%не успя%'").get().n;
    // Промяна по фонда → отложен запис след 4 s. Вписан документ се трие с второ натискане (books.js).
    const first = await h.api.books.delete(IDS[10]);
    if (!first.ok) ok(await h.api.books.delete(IDS[10]), 'изтриване');
    await E.sleep(4600);
    const st = ok(await h.api.catalog.autoPushStatus());
    assert.ok(st.write && st.write.ok === false, 'провалът на автоматичния запис не е запомнен');
    assert.match(st.write.message, /не успя/);
    await h.go('catalog');
    assert.match(h.viewText(), /Записът на онлайн каталога не успява\./);
    assert.match(h.viewText(), /Проверете дали папката е достъпна/);
    const after = h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'Онлайн каталог' AND detail LIKE 'ВНИМАНИЕ: записът на онлайн каталога%не успя%'").get().n;
    assert.equal(after - before, 1, 'провалът не е в одитната следа (или е вписан повече от веднъж)');
  } finally {
    fs.renameSync(away, folderA);
  }
  ok(await h.api.catalog.writeNow());
  const st2 = ok(await h.api.catalog.autoPushStatus());
  assert.equal(st2.write.ok, true);
  await h.go('catalog');
  assert.doesNotMatch(h.viewText(), /Записът на онлайн каталога не успява/);
  assert.ok(q("SELECT 1 AS x FROM audit_log WHERE action = 'Онлайн каталог' AND detail LIKE 'записът на katalog.json%отново минава%'"),
    'възстановяването не е вписано');
});

test('К1 + К11: пробна база с 1 книга НЕ заменя публикуваните 9 — спира, казва го и дава изход', async () => {
  const published = kat().items.length;
  assert.equal(published, 9);
  // „Нова база“: целият досегашен фонд излиза от публикуването (втора връзка — както друго работно място).
  h.db.prepare("UPDATE books SET status = 'отчислен'").run();
  const cat = q("SELECT id FROM categories WHERE name='книга'").id;
  ok(await h.api.books.create({ inv_number: 500, title: 'Пробна книга', author: 'Проба, Нова', category_id: cat, register_date: T, price: 1 }));
  await E.sleep(4600);
  assert.equal(kat().items.length, published, 'една пробна книга замени целия публикуван каталог');
  const st = ok(await h.api.catalog.autoPushStatus());
  assert.equal(st.write.blocked, true);
  assert.equal(st.write.published, 9);
  assert.equal(st.write.now, 1);

  // Ръчният запис казва същото и сочи СЪЩЕСТВУВАЩ бутон (К11).
  const w = await h.api.catalog.writeNow();
  assert.equal(w.ok, false);
  assert.match(w.error, /публикуваният katalog\.json има 9 записа, а тази база би го свела до 1/);
  assert.match(w.error, /„Запиши въпреки това…“/);
  assert.doesNotMatch(w.error, /Ръчен запис/);

  // Свързване на папката наново: екранът казва, че записът е спрян (не „обновява се автоматично“).
  ok(await h.api.catalog.disconnectFolder());
  await h.go('catalog');
  h.dialogs.openPaths = [folderA];
  const n = h.toasts.length;
  await h.clickButton('Избери папката на хранилището…', '#view');
  await h.settle(100);
  const ts = h.toastsSince(n);
  assert.ok(ts.some(t => t.type === 'err' && /записът на онлайн каталога е СПРЯН/.test(t.msg)), JSON.stringify(ts));
  assert.ok(!ts.some(t => /обновява автоматично/.test(t.msg)), 'екранът обеща автоматично обновяване при спрян запис');

  // Екранът показва лентата и бутона; бутонът минава през въпрос и записва.
  assert.match(h.viewText(), /Записът на онлайн каталога е спрян\./);
  h.hooks.confirmAnswer = true;
  await h.clickButton('Запиши въпреки това…', '#view');
  await h.settle(100);
  assert.ok(h.hooks.confirms.some(c => /има 9 записа, а тази база ще го замени с 1/.test(c)), 'въпросът не казва двете числа');
  assert.equal(kat().items.length, 1, '„Запиши въпреки това…“ не записа');
  assert.ok(q("SELECT 1 AS x FROM audit_log WHERE action = 'Онлайн каталог' AND detail LIKE '%ВЪПРЕКИ предпазителя%9 записа са заменени с 1%'"),
    'съзнателното свиване не е в одитната следа');
  assert.doesNotMatch(h.viewText(), /Записът на онлайн каталога е спрян/);
});

test('Б-край: без грешки в екранния слой', () => {
  const errs = h.errors.splice(0);
  assert.equal(errs.length, 0, errs.map(e => (e && (e.stack || e.message)) || String(e)).join('\n---\n'));
  h.stop();
});

/* ==========================================================================
   В) СТРАНИЦАТА НА САЙТА
   ========================================================================== */
const PAGE = path.join(__dirname, '..', '..', 'site', 'page-katalog.html');
const GH = 'https://raw.githubusercontent.com/plam4o4o-source/yavorec-katalog/main/katalog.json';
async function openPage(cat) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(fs.readFileSync(PAGE, 'utf8'), {
    runScripts: 'dangerously', url: 'https://localhost/', pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, 'localStorage', { value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, configurable: true });
      w.fetch = (url) => url.startsWith(GH)
        ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(cat))) })
        : Promise.reject(new Error('няма резервен път в този тест'));
      w.scrollTo = () => {};
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    }
  });
  const d = dom.window.document;
  const t0 = Date.now();
  while (!/Каталогът е актуален/.test((d.getElementById('katFt') || {}).innerHTML || '')) {
    if (Date.now() - t0 > 20000) throw new Error('страницата не се зареди');
    await E.sleep(20);
  }
  return dom;
}
const it = (o) => Object.assign({ a: '', s: '', c: '', p: '', y: '', v: 'книга', l: 'български', u: '8', g: '', o: 'за възрастни', k: '', n: '', cv: '', av: 1, d: '2020-01-01' }, o);
const SITE_CAT = {
  generated: '2026-09-26',
  departments: { 'за деца': 'Детски отдел' },
  items: [
    // „Малкият принц“ — 1 за възрастни (заета, първа), 2 за деца (налични), единият — аудио.
    it({ inv: 1, t: 'Малкият принц', a: 'Екзюпери, Антоан дьо', o: 'за възрастни', g: '84/Е 99', av: 0 }),
    it({ inv: 2, t: 'Малкият принц', a: 'Екзюпери, Антоан дьо', o: 'Детски отдел', g: '84/Е 99 д', av: 1 }),
    it({ inv: 3, t: 'Малкият принц', a: 'Екзюпери, Антоан дьо', o: 'Детски отдел', g: '84/Е 99 д', v: 'аудиодокумент', av: 1 }),
    it({ inv: 4, t: 'Под игото', a: 'Вазов, Иван', u: '821.163.2', av: 1 }),
    it({ inv: 5, t: 'The Hobbit', a: 'Tolkien, J. R. R.', l: 'английски', av: 0 }),
    it({ inv: 6, t: 'Hamlet', a: 'Shakespeare, William', l: 'английски', av: 1 }),
    // „Приказки“ — и двата екземпляра налични, ПЪРВИЯТ е за възрастни: детският филтър трябва да го види.
    it({ inv: 7, t: 'Приказки', a: 'Елин Пелин', o: 'за възрастни', av: 1 }),
    it({ inv: 8, t: 'Приказки', a: 'Елин Пелин', o: 'Детски отдел', av: 1 })
  ]
};

test('К5: филтрите по отдел/вид гледат всеки екземпляр; сигнатурата „по нея се намира на рафта“ е на наличния', async () => {
  const dom = await openPage(SITE_CAT);
  const d = dom.window.document;
  const tile = (name) => Array.from(d.querySelectorAll('#katTiles .kat-tile')).find(b => b.getAttribute('data-tile') === name);
  const kids = tile('Детски книги');
  assert.ok(kids, 'плочката „Детски книги“ липсва — отделът се взима само от първия екземпляр (или надписът я крие)');
  kids.click();
  await E.sleep(30);
  const titles = Array.from(d.querySelectorAll('#katR .kat-row-t')).map(e => e.textContent);
  assert.deepEqual(titles, ['Малкият принц', 'Приказки'], 'заглавие с детски екземпляр, чийто пръв екземпляр е за възрастни, липсва');
  assert.ok(tile('Аудио, видео и други носители'), 'плочката за аудио не се появява, защото първият екземпляр е книга');
  // Картата: сигнатурата под „по нея се намира на рафта“ е на НАЛИЧЕН екземпляр.
  d.querySelector('#katR .kat-row').click();
  const sig = d.querySelector('#katDr .kat-sig').textContent;
  assert.equal(sig, '84/Е 99 д', 'сигнатурата е на заетия екземпляр в друг отдел');
  /* Филтърът по ВИД (чиповете над резултатите) — също по екземпляри. Плочката за
     аудио по-горе минава през отрицанието („всичко освен книга“); чипът
     „аудиодокумент“ е положителният клон — „Малкият принц“ има аудио екземпляр,
     макар първият му да е книга. */
  d.getElementById('katAllBtn').click();
  await E.sleep(30);
  const chip = d.querySelector('.kat-fchip[data-vid="аудиодокумент"]');
  assert.ok(chip, 'чипът за вид „аудиодокумент“ липсва');
  chip.click();
  await E.sleep(30);
  assert.deepEqual(Array.from(d.querySelectorAll('#katR .kat-row-t')).map(e => e.textContent), ['Малкият принц'],
    'филтърът по вид гледа само първия екземпляр');
  dom.window.close();
});

test('К9: плочката „Детски книги“ не изчезва при публичен надпис на отдела', async () => {
  const cat = JSON.parse(JSON.stringify(SITE_CAT));
  cat.items = cat.items.map(i => Object.assign(i, { o: i.o === 'Детски отдел' ? 'Детски отдел' : i.o }));
  const dom = await openPage(cat);
  const d = dom.window.document;
  const kids = Array.from(d.querySelectorAll('#katTiles .kat-tile')).find(b => b.getAttribute('data-tile') === 'Детски книги');
  assert.ok(kids, 'плочката изчезна');
  assert.match(kids.textContent, /2 заглавия/);
  dom.window.close();
});

test('К10: „налични сега“ брои екземпляри и го казва', async () => {
  const dom = await openPage(SITE_CAT);
  const stats = dom.window.document.getElementById('katStats').textContent.replace(/\s+/g, ' ');
  const avCopies = SITE_CAT.items.filter(i => i.av).length;   // 6 екземпляра (а заглавия с наличен — 4)
  assert.equal(avCopies, 6);
  assert.match(stats, /6 налични екземпляра сега/);
  assert.match(stats, /8 екземпляра/);
  dom.window.close();
});

test('К12: търсене с транслитерация (vazov ↔ Вазов, толкин ↔ Tolkien, хамлет ↔ Hamlet) и латински букви в азбучника', async () => {
  const dom = await openPage(SITE_CAT);
  const w = dom.window, d = w.document;
  const search = async (s) => {
    const qEl = d.getElementById('katQ'); qEl.value = s;
    qEl.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await E.sleep(30);
    return Array.from(d.querySelectorAll('#katR .kat-row-t')).map(e => e.textContent);
  };
  assert.deepEqual(await search('vazov'), ['Под игото']);
  assert.deepEqual(await search('толкин'), ['The Hobbit']);
  assert.deepEqual(await search('хамлет'), ['Hamlet']);
  assert.deepEqual(await search('Вазов'), ['Под игото'], 'дословното търсене продължава да работи');
  assert.deepEqual(await search('няматакова'), []);
  const T_btn = d.querySelector('#katAbc button[data-abc="T"]');
  assert.ok(T_btn && !T_btn.disabled, 'Tolkien е недостъпен от азбучника');
  w.close();
});

test('К12: затворената карта на записа няма сянка по десния край', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  const closed = /\n\.kat-dr\{([^}]*)\}/.exec(html)[1];
  const open = /\n\.kat-dr\.kat-on\{([^}]*)\}/.exec(html)[1];
  assert.match(closed, /box-shadow:none/, 'затворената карта (translateX(102%)) хвърля сянка върху страницата');
  assert.match(closed, /visibility:hidden/);
  assert.match(open, /box-shadow:-20px 0 60px/);
  assert.match(open, /visibility:visible/);
});
