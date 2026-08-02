// Тест на handlers/dashboard.js — двайсет и втори домейн, извадено от
// main.js (Фаза 4, стъпка 23). Чисто справочен домейн — проверява само
// агрегираните числа, без никакви записи.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerDashboardHandlers = require('../handlers/dashboard');

const LOAN_SELECT = `
  SELECT l.*, b.title, b.author, b.inv_number, r.name AS reader_name, r.card_no
  FROM loans l
  JOIN books b ON b.id = l.book_id
  JOIN readers r ON r.id = l.reader_id
`;

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-dashboard-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    today: () => '2026-08-02',
    yearOf: () => '2026',
    pctRequired: (n) => (n <= 50000 ? 10 : n <= 200000 ? 5 : 2),
    isWorkDay: () => true,
    LOAN_SELECT
  };
  registerDashboardHandlers(ipcMain, deps);
  return { db, ipcMain };
}

test('registerDashboardHandlers registers dashboard:stats and dashboard:full', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('dashboard:stats'));
  assert.ok(ipcMain.has('dashboard:full'));
});

test('dashboard:stats counts active books/readers, open loans, and overdue loans', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1, 'А', 'наличен')").run();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (2, 'Б', 'отчислен')").run();
  db.prepare("INSERT INTO readers (name, status) VALUES ('Читател 1', 'активен')").run();
  db.prepare("INSERT INTO readers (name, status) VALUES ('Читател 2', 'прекратен')").run();
  const bookId = db.prepare("SELECT id FROM books WHERE inv_number=1").get().id;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("SELECT id FROM readers WHERE name='Читател 1'").get().id;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-01-01', '2026-01-15');

  const result = await ipcMain.invoke('dashboard:stats');
  assert.equal(result.ok, true);
  assert.equal(result.data.books, 1, 'only non-deaccessioned books count');
  assert.equal(result.data.readers, 1, 'only non-terminated readers count');
  assert.equal(result.data.loansOpen, 1);
  assert.equal(result.data.overdue, 1);
});

test('dashboard:full aggregates fund value, upcoming due dates (via LOAN_SELECT), and inventory target (via pctRequired)', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, status, price, register_date) VALUES (1, 'А', 'наличен', 10, '2026-01-01')").run();
  const bookId = db.prepare("SELECT id FROM books WHERE inv_number=1").get().id;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  // Due in 2 days from "today" (2026-08-02) — within the 3-day "upcoming" window.
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-07-20', '2026-08-04');

  const result = await ipcMain.invoke('dashboard:full');
  assert.equal(result.ok, true);
  assert.equal(result.data.fundCount, 1);
  assert.equal(result.data.fundValue, 10);
  assert.equal(result.data.upcoming.length, 1);
  assert.equal(result.data.upcoming[0].inv_number, 1);
  assert.equal(result.data.inventoryTarget, Math.ceil(1 * 10 / 100)); // pctRequired(1) = 10%
  assert.equal(result.data.today.isTodayOpen, true);
});

test('dashboard:full computes anonCandidates only when anonymize_years is set', async () => {
  const { db, ipcMain } = setup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (2, 'Б')").run().lastInsertRowid;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Стар читател')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, readerId, '2020-01-01', '2020-01-15', '2020-01-20');

  const withoutSetting = await ipcMain.invoke('dashboard:full');
  assert.equal(withoutSetting.data.today.anonCandidates, 0);

  db.prepare('UPDATE settings SET anonymize_years = 1 WHERE id = 1').run();
  const withSetting = await ipcMain.invoke('dashboard:full');
  assert.equal(withSetting.data.today.anonCandidates, 1);
});

test('dashboard:full counts currently suspended readers', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO readers (name, suspended_until) VALUES ('Наказан', '2030-01-01')").run();
  db.prepare("INSERT INTO readers (name, suspended_until) VALUES ('Изтекъл', '2020-01-01')").run();

  const result = await ipcMain.invoke('dashboard:full');
  assert.equal(result.data.today.suspendedNow, 1);
});
