// Тест на handlers/mzs.js — двайсет и шести домейн, извадено от main.js
// (Фаза 4, стъпка 27).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerMzsHandlers = require('../handlers/mzs');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-mzs-test-'));
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
    yearOf: (d) => (d || '2026-08-02').slice(0, 4)
  };
  registerMzsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerMzsHandlers registers all five mzs: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['mzs:list', 'mzs:nextNo', 'mzs:create', 'mzs:update', 'mzs:delete']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('mzs:create inserts with defaults (direction/status) and logs an audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const result = await ipcMain.invoke('mzs:create', { no: 1, date: '2026-08-02', partner: 'Друга библиотека', title: 'Книга' });
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /№ 1/);
  // Забележка: логът показва m.direction както е подадено (undefined тук), не
  // подразбиращата се стойност, приложена към самия ред — вярно на оригинала.
  assert.match(auditLog[0].detail, /undefined/);

  const list = await ipcMain.invoke('mzs:list');
  assert.equal(list.data[0].direction, 'изходящо');
  assert.equal(list.data[0].status, 'заявено');
  assert.equal(list.data[0].year, '2026');
});

test('mzs:nextNo returns max(no)+1 per year', async () => {
  const { ipcMain } = setup();
  const first = await ipcMain.invoke('mzs:nextNo', '2026');
  assert.equal(first.data, 1);

  await ipcMain.invoke('mzs:create', { no: 3, date: '2026-01-01', partner: 'X', title: 'A' });
  await ipcMain.invoke('mzs:create', { no: 7, date: '2026-02-01', partner: 'Y', title: 'B' });
  const next = await ipcMain.invoke('mzs:nextNo', '2026');
  assert.equal(next.data, 8);
});

test('mzs:update modifies fields and logs an audit entry', async () => {
  const { db, ipcMain, auditLog } = setup();
  const id = (await ipcMain.invoke('mzs:create', { no: 1, date: '2026-08-02', partner: 'X', title: 'Оригинал' })).data;
  auditLog.length = 0;
  await ipcMain.invoke('mzs:update', {
    id, no: 1, direction: 'входящо', partner: 'Нов партньор', author: null, title: 'Оригинал',
    isbn: null, requester: null, status: 'получено', due_date: null, note: null
  });
  const row = db.prepare('SELECT direction, partner, status FROM mzs_requests WHERE id = ?').get(id);
  assert.equal(row.direction, 'входящо');
  assert.equal(row.partner, 'Нов партньор');
  assert.equal(row.status, 'получено');
  assert.equal(auditLog[0].detail, '№ 1 — Оригинал');
});

test('mzs:delete removes the row', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('mzs:create', { no: 1, date: '2026-08-02', partner: 'X', title: 'За изтриване' })).data;
  await ipcMain.invoke('mzs:delete', id);
  const list = await ipcMain.invoke('mzs:list');
  assert.equal(list.data.length, 0);
});

test('mzs:list orders by date DESC, no DESC', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('mzs:create', { no: 1, date: '2026-01-01', partner: 'X', title: 'Стара' });
  await ipcMain.invoke('mzs:create', { no: 2, date: '2026-06-01', partner: 'Y', title: 'Нова' });
  const list = await ipcMain.invoke('mzs:list');
  assert.equal(list.data[0].title, 'Нова');
});
