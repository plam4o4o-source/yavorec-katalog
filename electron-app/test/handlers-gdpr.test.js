// Тест на handlers/gdpr.js — деветнайсети домейн, извадено от main.js
// (Фаза 4, стъпка 20). Проверява прага anonymize_years, изчислението на
// прага (cutoff) и реалната анонимизация на заеманията/събитията.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerGdprHandlers = require('../handlers/gdpr');


/* Хигиена на временните папки. node --test не чисти нищо след себе си, а всяка
   фикстура тук създава каталог в /tmp. Одитът завари 80 431 каталога / 23 GB;
   при пълен диск поредицата започва да пада лавинообразно на съвсем несвързани
   места (# pass 302 / # fail 345) и прати диагностиката по грешна следа.
   mkTmpDir() запомня папката, test.after() я трие. */
const tmpDirs = [];
function mkTmpDir(prefixPath) {
  const d = fs.mkdtempSync(prefixPath);
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
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

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-gdpr-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail })
  };
  registerGdprHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerGdprHandlers registers gdpr:candidates and gdpr:anonymize', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('gdpr:candidates'));
  assert.ok(ipcMain.has('gdpr:anonymize'));
});

test('gdpr:candidates returns years:0, count:0 when anonymize_years is unset/0', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('gdpr:candidates');
  assert.equal(result.ok, true);
  assert.equal(result.data.years, 0);
  assert.equal(result.data.count, 0);
});

test('gdpr:anonymize refuses to run when anonymize_years is 0', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('gdpr:anonymize');
  assert.equal(result.ok, false);
  assert.match(result.error, /Първо задайте срок/);
});

test('gdpr:candidates counts returned loans older than the cutoff, excluding the anonymized-placeholder reader', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET anonymize_years = 2 WHERE id = 1').run();
  const currentYear = new Date().getFullYear();
  const oldReaderId = db.prepare("INSERT INTO readers (name) VALUES ('Стар читател')").run().lastInsertRowid;
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'Книга')").run().lastInsertRowid;
  // Достатъчно стара, върната заемка — трябва да е кандидат.
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, oldReaderId, (currentYear - 5) + '-01-01', (currentYear - 5) + '-01-31', (currentYear - 5) + '-02-01');
  // Скорошна заемка — не е кандидат.
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, oldReaderId, currentYear + '-01-01', currentYear + '-01-31', currentYear + '-02-01');

  const result = await ipcMain.invoke('gdpr:candidates');
  assert.equal(result.data.years, 2);
  assert.equal(result.data.count, 1);
  assert.equal(result.data.cutoff, (currentYear - 2) + '-01-01');
});

test('gdpr:anonymize replaces reader_id with the placeholder reader, snapshots category+year, and clears old events', async () => {
  const { db, ipcMain, auditLog } = setup();
  db.prepare('UPDATE settings SET anonymize_years = 1 WHERE id = 1').run();
  const currentYear = new Date().getFullYear();
  const readerId = db.prepare("INSERT INTO readers (name, category) VALUES ('Читател', 'дете')").run().lastInsertRowid;
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (2, 'Книга Б')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, readerId, (currentYear - 5) + '-03-01', (currentYear - 5) + '-03-31', (currentYear - 5) + '-04-01');
  db.prepare("INSERT INTO events (date, kind, reader_id) VALUES (?, 'заемане', ?)")
    .run((currentYear - 5) + '-03-01', readerId);

  const result = await ipcMain.invoke('gdpr:anonymize');
  assert.equal(result.ok, true);
  assert.equal(result.data.anonymized, 1);

  const loan = db.prepare('SELECT reader_id, anon_category FROM loans WHERE book_id = ?').get(bookId);
  assert.notEqual(loan.reader_id, readerId, 'reader_id should be replaced with the anonymized placeholder');
  assert.equal(loan.anon_category, 'дете · ' + (currentYear - 5));

  const event = db.prepare("SELECT reader_id FROM events WHERE kind = 'заемане'").get();
  assert.equal(event.reader_id, null, 'old events should lose their reader link');

  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /1 върнати заемания/);
});

test('gdpr:anonymize reuses the same placeholder reader across multiple runs', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET anonymize_years = 1 WHERE id = 1').run();
  const currentYear = new Date().getFullYear();
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (3, 'Книга В')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, readerId, (currentYear - 5) + '-01-01', (currentYear - 5) + '-01-31', (currentYear - 5) + '-02-01');
  await ipcMain.invoke('gdpr:anonymize');

  const readersCountAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM readers').get().n;
  await ipcMain.invoke('gdpr:anonymize');
  const readersCountAfterSecond = db.prepare('SELECT COUNT(*) AS n FROM readers').get().n;
  assert.equal(readersCountAfterSecond, readersCountAfterFirst, 'no duplicate placeholder reader should be created');
});

/* ЗАЩО: `gdpr:anonymize` трябва да пипа САМО ВЪРНАТИ заемания (date_in IS NOT
   NULL). Мутационен одит премахна това условие и цялата поредица остана
   зелена — а последицата е тежка: АКТИВНИТЕ заемания също губят читателя си,
   тоест книгите остават у хората, а в базата няма никаква следа кой ги държи.
   Необратимо е (изричен ръчен бутон, без отмяна). */
test('gdpr:anonymize НЕ докосва активните заемания — книгата е още у читателя', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET anonymize_years = 2 WHERE id = 1').run();
  const oldYear = new Date().getFullYear() - 5;
  const readerId = db.prepare("INSERT INTO readers (name, category) VALUES ('Иван Петров', 'възрастен')").run().lastInsertRowid;
  const bookA = db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'Върната')").run().lastInsertRowid;
  const bookB = db.prepare("INSERT INTO books (inv_number, title) VALUES (2, 'Още е у него')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookB);

  // Върнато отдавна — подлежи на анонимизиране.
  const closed = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?,?,?,?,?)')
    .run(bookA, readerId, `${oldYear}-01-05`, `${oldYear}-01-19`, `${oldYear}-01-10`).lastInsertRowid;
  // Взето също толкова отдавна, но НЕ е върнато — не подлежи.
  const open = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?,?,?,?,NULL)')
    .run(bookB, readerId, `${oldYear}-01-05`, `${oldYear}-01-19`).lastInsertRowid;

  const res = await ipcMain.invoke('gdpr:anonymize');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.anonymized, 1, 'анонимизира се точно ЕДНО заемане — само върнатото');

  const after = db.prepare('SELECT id, reader_id, anon_category, date_in FROM loans ORDER BY id').all();
  const closedRow = after.find(r => r.id === closed);
  const openRow = after.find(r => r.id === open);
  assert.notEqual(closedRow.reader_id, readerId, 'върнатото заемане губи връзката с името');
  assert.ok(closedRow.anon_category, 'и запазва категория · година за статистиката');
  assert.equal(openRow.reader_id, readerId,
    'АКТИВНОТО заемане трябва да си остане закачено за читателя — иначе книгата е у човек, '
    + 'когото програмата вече не може да назове, и няма кого да подсети да я върне');
  assert.equal(openRow.anon_category, null);
});

test('gdpr:candidates също брои само върнатите заемания', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET anonymize_years = 2 WHERE id = 1').run();
  const oldYear = new Date().getFullYear() - 5;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Иван')").run().lastInsertRowid;
  const b1 = db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'А')").run().lastInsertRowid;
  const b2 = db.prepare("INSERT INTO books (inv_number, title) VALUES (2, 'Б')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(b2);
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?,?,?,?,?)')
    .run(b1, readerId, `${oldYear}-01-05`, `${oldYear}-01-19`, `${oldYear}-01-10`);
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?,?,?,?,NULL)')
    .run(b2, readerId, `${oldYear}-01-05`, `${oldYear}-01-19`);

  const res = await ipcMain.invoke('gdpr:candidates');
  assert.equal(res.data.count, 1, 'бройката пред потребителя не бива да включва невърнати книги');
});

/* Годишна граница: cutoff е „1 януари на (текущата година − N)". Заемане,
   върнато на 31.12 предната година, е ОТВЪД прага; върнатото на 1 януари в
   годината на прага — не е. Тестовете дотук ползваха само средата на годината. */
test('gdpr: прагът минава точно по 1 януари — 31.12 отпреди прага влиза, 01.01 на прага не влиза', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET anonymize_years = 3 WHERE id = 1').run();
  const cutoffYear = new Date().getFullYear() - 3; // cutoff = `${cutoffYear}-01-01`
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const mk = (inv, dateIn) => {
    const b = db.prepare('INSERT INTO books (inv_number, title) VALUES (?, ?)').run(inv, 'Кн. ' + inv).lastInsertRowid;
    return db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?,?,?,?,?)')
      .run(b, readerId, `${cutoffYear - 1}-12-01`, `${cutoffYear - 1}-12-15`, dateIn).lastInsertRowid;
  };
  const before = mk(1, `${cutoffYear - 1}-12-31`); // последният ден преди прага
  const onCutoff = mk(2, `${cutoffYear}-01-01`);   // самият праг — НЕ влиза (< cutoff)

  const res = await ipcMain.invoke('gdpr:anonymize');
  assert.equal(res.data.anonymized, 1);
  assert.equal(res.data.cutoff, `${cutoffYear}-01-01`);
  const rows = Object.fromEntries(db.prepare('SELECT id, reader_id FROM loans').all().map(r => [r.id, r.reader_id]));
  assert.notEqual(rows[before], readerId, '31 декември преди прага се анонимизира');
  assert.equal(rows[onCutoff], readerId, 'самата 1 януари на прага НЕ се анонимизира (условието е строго <)');
});
