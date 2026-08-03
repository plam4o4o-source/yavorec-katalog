// Тест на handlers/stats.js — двайсет и осми домейн, извадено от main.js
// (Фаза 4, стъпка 29). Покрива stats:report и всяка от шестте готови
// справки (reports:run), плюс reports:list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerStatsHandlers = require('../handlers/stats');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-stats-test-'));
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
    yearOf: () => '2026',
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: (rows) => ({ hours: rows.reduce((s, r) => s + (r.a_hours || 0), 0) })
  };
  registerStatsHandlers(ipcMain, deps);
  return { db, ipcMain };
}

test('registerStatsHandlers registers stats:report and reports:list/run', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('stats:report'));
  assert.ok(ipcMain.has('reports:list'));
  assert.ok(ipcMain.has('reports:run'));
});

test('reports:list returns the fixed 6-report catalog', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('reports:list');
  assert.equal(result.data.length, 6);
  assert.ok(result.data.some(r => r.id === 'annual_ab'));
  assert.ok(result.data.every(r => r.needsYear === true));
});

test('stats:report aggregates fund/acquisitions/deaccessions/loans/readers for the given year', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, price, register_date, language) VALUES (1, 'А', 10, '2026-03-01', 'бг')").run();
  db.prepare("INSERT INTO books (inv_number, title, price, register_date) VALUES (2, 'Б', 5, '2025-01-01')").run();
  const bookId = db.prepare("SELECT id FROM books WHERE inv_number=1").get().id;
  const readerId = db.prepare("INSERT INTO readers (name, registered_at) VALUES ('Читател', '2026-02-01')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, readerId, '2026-01-01', '2026-01-15', '2026-01-10');

  const result = await ipcMain.invoke('stats:report', '2026');
  assert.equal(result.ok, true);
  assert.equal(result.data.acquiredCount, 1);
  assert.equal(result.data.acquiredValue, 10);
  assert.equal(result.data.readersCount, 1);
  assert.equal(result.data.loansCount, 1);
  assert.equal(result.data.returnedOnTime, 1);
  assert.equal(result.data.returnedLate, 0);
  // book2 (no language, registered 2025) is also in the year-end fund — it just
  // predates the acquisition-year filter, not the fund-at-year-end filter.
  assert.equal(result.data.fundByLanguage.length, 2);
  assert.ok(result.data.fundByLanguage.some(([lang, n]) => lang === 'бг' && n === 1));
});

test('reports:run annual_ab reads dnevnik_days and delegates totals to dnevnikSumRow', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO dnevnik_days (date, a_hours) VALUES ('2026-03-01', 5)").run();
  db.prepare("INSERT INTO dnevnik_days (date, a_hours) VALUES ('2026-03-02', 7)").run();

  const result = await ipcMain.invoke('reports:run', { id: 'annual_ab', year: '2026' });
  assert.equal(result.ok, true);
  assert.equal(result.data.daysRecorded, 2);
  assert.equal(result.data.totals.hours, 12);
});

test('reports:run fund_breakdown groups the year-end fund by department/language/category', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, price, register_date, department, language) VALUES (1, 'А', 15, '2026-01-01', 'дет.', 'бг')").run();

  const result = await ipcMain.invoke('reports:run', { id: 'fund_breakdown', year: '2026' });
  assert.equal(result.data.fundCount, 1);
  assert.equal(result.data.fundValue, 15);
  assert.deepEqual(result.data.byDepartment, [['дет.', 1]]);
});

test('reports:run readers_by_category groups active readers and counts new registrations', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO readers (name, category, status, registered_at) VALUES ('А', 'дете', 'активен', '2026-01-01')").run();
  db.prepare("INSERT INTO readers (name, category, status, registered_at) VALUES ('Б', 'дете', 'прекратен', '2020-01-01')").run();

  const result = await ipcMain.invoke('reports:run', { id: 'readers_by_category', year: '2026' });
  assert.equal(result.data.total, 1, 'only non-terminated readers count');
  assert.equal(result.data.newThisYear, 1);
});

test('reports:run fund_movement summarizes acquisitions and deaccessions by reason/method', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO acquisitions (no, year, date, how, total_count, sum) VALUES (1, '2026', '2026-01-01', 'покупка', 5, 100)").run();
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date, reason_code, reason_text) VALUES (1, '2026', '2026-01-01', 1, 'износени')").run().lastInsertRowid;
  db.prepare('INSERT INTO deaccession_items (act_id, inv_number, title, price) VALUES (?, 1, ?, ?)').run(actId, 'X', 20);

  const result = await ipcMain.invoke('reports:run', { id: 'fund_movement', year: '2026' });
  assert.equal(result.data.acquiredTotal, 5);
  assert.equal(result.data.acquiredValue, 100);
  assert.equal(result.data.deaccessionedTotal, 1);
  assert.equal(result.data.deaccessionedValue, 20);
});

test('reports:run mzs_annual summarizes requests by direction/status', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO mzs_requests (no, year, date, direction, partner, title, status) VALUES (1, '2026', '2026-01-01', 'изходящо', 'X', 'Y', 'заявено')").run();

  const result = await ipcMain.invoke('reports:run', { id: 'mzs_annual', year: '2026' });
  assert.equal(result.data.total, 1);
  assert.deepEqual(result.data.byDirection, [['изходящо', 1]]);
});

test('reports:run fees_income summarizes charges and payments from account_lines', async () => {
  const { db, ipcMain } = setup();
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-01', 'начисление', 'глоба', 5)").run(readerId);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-02', 'плащане', 'плащане', -3)").run(readerId);

  const result = await ipcMain.invoke('reports:run', { id: 'fees_income', year: '2026' });
  assert.equal(result.data.chargedValue, 5);
  assert.equal(result.data.paidValue, 3);
});

test('reports:run rejects an unknown report id', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('reports:run', { id: 'nonexistent', year: '2026' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Непозната справка/);
});
