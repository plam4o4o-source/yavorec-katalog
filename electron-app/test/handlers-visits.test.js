// Тест на handlers/visits.js — двайсет и девети домейн, извадено от main.js
// (Фаза 4, стъпка 28).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerVisitsHandlers = require('../handlers/visits');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-visits-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    }
  };
  registerVisitsHandlers(ipcMain, deps);
  return { db, ipcMain };
}

test('registerVisitsHandlers registers visits:add', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('visits:add'));
});

test('visits:add inserts a new row for a new date', async () => {
  const { db, ipcMain } = setup();
  const result = await ipcMain.invoke('visits:add', { date: '2026-08-02', count: 5 });
  assert.equal(result.ok, true);
  const row = db.prepare('SELECT count FROM visits WHERE date = ?').get('2026-08-02');
  assert.equal(row.count, 5);
});

test('visits:add accumulates (upserts) the count for the same date', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('visits:add', { date: '2026-08-02', count: 3 });
  await ipcMain.invoke('visits:add', { date: '2026-08-02', count: 4 });
  const row = db.prepare('SELECT count FROM visits WHERE date = ?').get('2026-08-02');
  assert.equal(row.count, 7);
});

test('visits:add defaults a non-numeric count to 0', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('visits:add', { date: '2026-08-03', count: undefined });
  const row = db.prepare('SELECT count FROM visits WHERE date = ?').get('2026-08-03');
  assert.equal(row.count, 0);
});
