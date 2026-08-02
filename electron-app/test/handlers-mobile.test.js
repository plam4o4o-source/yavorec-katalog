// Тест на handlers/mobile.js — трийсет и седми домейн, извадено от main.js
// (Фаза 4, стъпка 36). Покрива mobile:generate и
// inventorySessions:importScans.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerMobileHandlers = require('../handlers/mobile');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-mobile-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const savedDialogs = { saveDialog: null };
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    dialog: {
      showSaveDialog: async () => savedDialogs.saveDialog || { canceled: false, filePath: path.join(dir, 'out.html') }
    },
    getMainWindow: () => ({}),
    fs, path
  };
  registerMobileHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, dir, savedDialogs };
}

test('registerMobileHandlers registers mobile:generate and inventorySessions:importScans', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('mobile:generate'));
  assert.ok(ipcMain.has('inventorySessions:importScans'));
});

test('mobile:generate reports cancellation from the save dialog', async () => {
  const { ipcMain, savedDialogs } = setup();
  savedDialogs.saveDialog = { canceled: true, filePath: null };
  const result = await ipcMain.invoke('mobile:generate');
  assert.equal(result.ok, false);
  assert.match(result.error, /Отказано/);
});

test('mobile:generate writes the mobile scanner page with the library name substituted in', async () => {
  const { db, ipcMain, dir } = setup();
  db.prepare("UPDATE settings SET lib_name='НЧ Васил Левски', place='с. Яворец' WHERE id=1").run();
  const outPath = path.join(dir, 'scanner.html');
  const result = await ipcMain.invoke('mobile:generate');
  assert.equal(result.ok, true);
  const html = fs.readFileSync(result.data, 'utf8');
  assert.ok(html.includes('НЧ Васил Левски · с. Яворец'));
  assert.ok(!html.includes('__LIB__'));
});

function startSession(db, overrides = {}) {
  const info = db.prepare(`INSERT INTO inventory_sessions (date, scope, department, committee1, committee2, committee3)
    VALUES (@date, @scope, @department, @committee1, @committee2, @committee3)`).run(Object.assign({
    date: '2026-08-02', scope: 'пълна', department: null, committee1: null, committee2: null, committee3: null
  }, overrides));
  return info.lastInsertRowid;
}

test('inventorySessions:importScans requires an open (non-closed) session', async () => {
  const { db, ipcMain } = setup();
  const sessionId = startSession(db);
  db.prepare('UPDATE inventory_sessions SET closed = 1 WHERE id = ?').run(sessionId);
  const result = await ipcMain.invoke('inventorySessions:importScans', { sessionId, codes: ['1'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /Няма отворена сесия/);
});

test('inventorySessions:importScans rejects an empty code list', async () => {
  const { db, ipcMain } = setup();
  const sessionId = startSession(db);
  const result = await ipcMain.invoke('inventorySessions:importScans', { sessionId, codes: ['', '  '] });
  assert.equal(result.ok, false);
  assert.match(result.error, /празен/);
});

test('inventorySessions:importScans matches by barcode or inv_number, dedupes, flags unknown codes, and un-marks "липсващ"', async () => {
  const { db, ipcMain, auditLog } = setup();
  const sessionId = startSession(db);
  const b1 = db.prepare("INSERT INTO books (title, barcode, status) VALUES ('A', 'BC1', 'наличен')").run().lastInsertRowid;
  const b2 = db.prepare("INSERT INTO books (title, inv_number, status) VALUES ('B', 42, 'липсващ')").run().lastInsertRowid;

  const result = await ipcMain.invoke('inventorySessions:importScans', { sessionId, codes: ['BC1', 'BC1', '42', 'UNKNOWN1'] });
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 2); // BC1 counted once (deduped by Set), 42 once
  assert.equal(result.data.duplicates, 0);
  assert.deepEqual(result.data.unknown, ['UNKNOWN1']);

  const b2row = db.prepare('SELECT status FROM books WHERE id=?').get(b2);
  assert.equal(b2row.status, 'наличен'); // un-marked from липсващ
  const scans = db.prepare('SELECT book_id FROM inventory_session_scans WHERE session_id=?').all(sessionId);
  assert.equal(scans.length, 2);
  assert.ok(auditLog.some(a => a.action === 'Инвентаризация' && /2 сканирания/.test(a.detail) && /1 непознати/.test(a.detail)));

  // Re-scanning the same barcode in a second call should count as a duplicate, not re-added.
  const again = await ipcMain.invoke('inventorySessions:importScans', { sessionId, codes: ['BC1'] });
  assert.equal(again.data.added, 0);
  assert.equal(again.data.duplicates, 1);
});
