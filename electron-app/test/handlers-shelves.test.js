// Тест на handlers/shelves.js — вторият домейн, извадено от main.js (Фаза 4,
// стъпка 3). Реалната схема (db/schema.sql) се зарежда в чиста временна база,
// точно както в test/db-init.test.js, за да се тества с истинските таблици
// и foreign key ограничения (catalog_shelves/catalog_shelf_items/books).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerShelvesHandlers = require('../handlers/shelves');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-shelves-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const scheduleCalls = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    scheduleCatalogWrite: () => scheduleCalls.push(true)
  };
  registerShelvesHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, scheduleCalls };
}

function insertBook(db, overrides = {}) {
  const b = Object.assign({
    inv_number: Math.floor(Math.random() * 1000000),
    barcode: null, title: 'Тестова книга', status: 'наличен', department: 'общ'
  }, overrides);
  const info = db.prepare(
    'INSERT INTO books (inv_number, barcode, title, status, department) VALUES (?, ?, ?, ?, ?)'
  ).run(b.inv_number, b.barcode, b.title, b.status, b.department);
  return info.lastInsertRowid;
}

test('registerShelvesHandlers registers all eight shelves: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['shelves:list', 'shelves:items', 'shelves:create', 'shelves:rename',
    'shelves:delete', 'shelves:addBook', 'shelves:addBooks', 'shelves:removeBook']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('shelves:create adds a shelf and logs an audit entry; shelves:list shows it with n=0', async () => {
  const { ipcMain, auditLog } = setup();
  const created = await ipcMain.invoke('shelves:create', 'Лято 2026');
  assert.equal(created.ok, true);
  assert.ok(created.data > 0);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /Лято 2026/);

  const list = await ipcMain.invoke('shelves:list');
  assert.equal(list.ok, true);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].n, 0);
});

test('shelves:create rejects an empty/whitespace-only name', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('shelves:create', '   ');
  assert.equal(result.ok, false);
  assert.match(result.error, /задължително/);
});

test('shelves:addBook rejects deaccessioned and staff-only books, schedules a catalog write on success', async () => {
  const { ipcMain, db, scheduleCalls } = setup();
  const created = await ipcMain.invoke('shelves:create', 'Витрина');
  const shelfId = created.data;

  const deaccId = insertBook(db, { inv_number: 1, barcode: 'BC1', status: 'отчислен' });
  const deaccBc = db.prepare('SELECT barcode FROM books WHERE id=?').get(deaccId).barcode;
  const r1 = await ipcMain.invoke('shelves:addBook', { shelfId, code: deaccBc });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /отчислен/);

  insertBook(db, { inv_number: 2, barcode: 'BC2', department: 'служебен' });
  const r2 = await ipcMain.invoke('shelves:addBook', { shelfId, code: 'BC2' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /служебни/i);

  insertBook(db, { inv_number: 3, barcode: 'BC3' });
  assert.equal(scheduleCalls.length, 0);
  const r3 = await ipcMain.invoke('shelves:addBook', { shelfId, code: 'BC3' });
  assert.equal(r3.ok, true);
  assert.equal(scheduleCalls.length, 1);

  const items = await ipcMain.invoke('shelves:items', shelfId);
  assert.equal(items.data.length, 1);
});

test('shelves:addBooks bulk-adds, silently skipping deaccessioned/staff-only ids, and reports the correct count', async () => {
  const { ipcMain, db } = setup();
  const created = await ipcMain.invoke('shelves:create', 'Обемна витрина');
  const shelfId = created.data;
  const okId1 = insertBook(db, { inv_number: 10 });
  const okId2 = insertBook(db, { inv_number: 11 });
  const badId = insertBook(db, { inv_number: 12, status: 'отчислен' });

  const result = await ipcMain.invoke('shelves:addBooks', { shelfId, ids: [okId1, okId2, badId] });
  assert.equal(result.ok, true);
  assert.equal(result.data, 2, 'only the two eligible books should be counted as added');

  const items = await ipcMain.invoke('shelves:items', shelfId);
  assert.equal(items.data.length, 2);
});

test('shelves:addBooks rejects an empty ids array', async () => {
  const { ipcMain } = setup();
  const created = await ipcMain.invoke('shelves:create', 'Празна');
  const result = await ipcMain.invoke('shelves:addBooks', { shelfId: created.data, ids: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /Няма избрани/);
});

test('shelves:removeBook removes just the one item and schedules a catalog write', async () => {
  const { ipcMain, db, scheduleCalls } = setup();
  const created = await ipcMain.invoke('shelves:create', 'Витрина 2');
  const shelfId = created.data;
  const id1 = insertBook(db, { inv_number: 20, barcode: 'BC20' });
  insertBook(db, { inv_number: 21, barcode: 'BC21' });
  await ipcMain.invoke('shelves:addBooks', { shelfId, ids: [id1] });
  await ipcMain.invoke('shelves:addBook', { shelfId, code: 'BC21' });

  scheduleCalls.length = 0;
  await ipcMain.invoke('shelves:removeBook', { shelfId, bookId: id1 });
  assert.equal(scheduleCalls.length, 1);
  const items = await ipcMain.invoke('shelves:items', shelfId);
  assert.equal(items.data.length, 1);
});

test('shelves:rename validates the new name and updates it; shelves:delete removes the shelf', async () => {
  const { ipcMain, auditLog } = setup();
  const created = await ipcMain.invoke('shelves:create', 'Старо име');
  const shelfId = created.data;

  const badRename = await ipcMain.invoke('shelves:rename', { id: shelfId, name: '' });
  assert.equal(badRename.ok, false);

  const goodRename = await ipcMain.invoke('shelves:rename', { id: shelfId, name: 'Ново име' });
  assert.equal(goodRename.ok, true);
  const list = await ipcMain.invoke('shelves:list');
  assert.equal(list.data[0].name, 'Ново име');

  const del = await ipcMain.invoke('shelves:delete', shelfId);
  assert.equal(del.ok, true);
  assert.match(auditLog[auditLog.length - 1].detail, /изтрита/);
  const listAfter = await ipcMain.invoke('shelves:list');
  assert.equal(listAfter.data.length, 0);
});
