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

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-gdpr-test-'));
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
