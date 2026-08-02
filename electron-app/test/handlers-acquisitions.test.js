// Тест на handlers/acquisitions.js — тринайсети домейн, извадено от
// main.js (Фаза 4, стъпка 14). Първи домейн, зависим от BOOK_SELECT
// (споделена SQL заготовка на все още неизвадения домейн "Книги") — тук се
// подава директно като низ във фалшивите deps, не през реален main.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerAcquisitionsHandlers = require('../handlers/acquisitions');

const BOOK_SELECT = `
  SELECT b.*, c.name AS category_name,
         COALESCE(i.quantity, 0) AS quantity
  FROM books b
  LEFT JOIN categories c ON c.id = b.category_id
  LEFT JOIN inventory i ON i.book_id = b.id
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-acquisitions-test-'));
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
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    BOOK_SELECT,
    yearOf: (d) => (d || '2026-08-02').slice(0, 4)
  };
  registerAcquisitionsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerAcquisitionsHandlers registers all five acquisitions: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['acquisitions:list', 'acquisitions:get', 'acquisitions:nextNo', 'acquisitions:create', 'acquisitions:delete']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('acquisitions:create inserts a row, defaults sum/total_count sensibly, and logs an audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const result = await ipcMain.invoke('acquisitions:create', {
    no: 3, date: '2026-05-01', from_source: 'дарение', total_count: 10, sum: '25.50'
  });
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /партида № 3/);

  const list = await ipcMain.invoke('acquisitions:list');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].year, '2026');
  assert.equal(list.data[0].sum, 25.5);
});

test('acquisitions:nextNo returns 1 for a year with no acquisitions yet, and max+1 otherwise', async () => {
  const { ipcMain } = setup();
  const first = await ipcMain.invoke('acquisitions:nextNo', '2026');
  assert.equal(first.data, 1);

  await ipcMain.invoke('acquisitions:create', { no: 5, date: '2026-01-01', total_count: 1 });
  await ipcMain.invoke('acquisitions:create', { no: 3, date: '2026-02-01', total_count: 1 });
  const next = await ipcMain.invoke('acquisitions:nextNo', '2026');
  assert.equal(next.data, 6, 'should be max(no)+1, not count+1');
});

test('acquisitions:list reports registered_count and registered_value aggregated from linked books', async () => {
  const { db, ipcMain } = setup();
  const acqId = (await ipcMain.invoke('acquisitions:create', { no: 1, date: '2026-01-01', total_count: 2 })).data;
  db.prepare('INSERT INTO books (inv_number, title, acquisition_id, price) VALUES (1, ?, ?, ?)').run('Книга А', acqId, 10.5);
  db.prepare('INSERT INTO books (inv_number, title, acquisition_id, price) VALUES (2, ?, ?, ?)').run('Книга Б', acqId, 5);

  const list = await ipcMain.invoke('acquisitions:list');
  assert.equal(list.data[0].registered_count, 2);
  assert.equal(list.data[0].registered_value, 15.5);
});

test('acquisitions:get returns the acquisition with its books (via BOOK_SELECT) attached as .items', async () => {
  const { db, ipcMain } = setup();
  const acqId = (await ipcMain.invoke('acquisitions:create', { no: 1, date: '2026-01-01', total_count: 1 })).data;
  db.prepare('INSERT INTO books (inv_number, title, acquisition_id) VALUES (7, ?, ?)').run('Свързана книга', acqId);

  const result = await ipcMain.invoke('acquisitions:get', acqId);
  assert.equal(result.ok, true);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].inv_number, 7);
});

test('acquisitions:get returns null for a non-existent id', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('acquisitions:get', 999999);
  assert.equal(result.ok, true);
  assert.equal(result.data, null);
});

test('acquisitions:delete refuses to delete a batch that already has registered books', async () => {
  const { db, ipcMain } = setup();
  const acqId = (await ipcMain.invoke('acquisitions:create', { no: 1, date: '2026-01-01', total_count: 1 })).data;
  db.prepare('INSERT INTO books (inv_number, title, acquisition_id) VALUES (1, ?, ?)').run('Книга', acqId);
  const result = await ipcMain.invoke('acquisitions:delete', acqId);
  assert.equal(result.ok, false);
  assert.match(result.error, /не може да бъде изтрита/);
});

test('acquisitions:delete removes an empty batch', async () => {
  const { ipcMain } = setup();
  const acqId = (await ipcMain.invoke('acquisitions:create', { no: 1, date: '2026-01-01', total_count: 0 })).data;
  const result = await ipcMain.invoke('acquisitions:delete', acqId);
  assert.equal(result.ok, true);
  const list = await ipcMain.invoke('acquisitions:list');
  assert.equal(list.data.length, 0);
});
