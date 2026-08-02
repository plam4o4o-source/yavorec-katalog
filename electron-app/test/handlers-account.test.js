// Тест на handlers/account.js — седемнайсети домейн, извадено от main.js
// (Фаза 4, стъпка 18). amount > 0 = начисление, amount < 0 = плащане;
// балансът е сумата им.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerAccountHandlers = require('../handlers/account');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-account-test-'));
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
    today: () => '2026-08-02'
  };
  registerAccountHandlers(ipcMain, deps);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  return { db, ipcMain, auditLog, readerId };
}

test('registerAccountHandlers registers all four account: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['account:get', 'account:charge', 'account:pay', 'account:deleteLine']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('account:charge rejects a non-positive amount', async () => {
  const { ipcMain, readerId } = setup();
  const result = await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /положителна/);
});

test('account:charge inserts a positive начисление line and logs an audit entry', async () => {
  const { ipcMain, auditLog, readerId } = setup();
  const result = await ipcMain.invoke('account:charge', { reader_id: readerId, type: 'глоба', amount: '5.50', note: 'просрочие' });
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /Читател/);
  assert.match(auditLog[0].detail, /5\.50/);

  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.balance, 5.5);
  assert.equal(got.data.lines[0].kind, 'начисление');
});

test('account:pay inserts a negative плащане line, reducing the balance', async () => {
  const { ipcMain, readerId } = setup();
  await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 10 });
  const result = await ipcMain.invoke('account:pay', { reader_id: readerId, amount: 4 });
  assert.equal(result.ok, true);

  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.balance, 6);
  const payLine = got.data.lines.find(l => l.kind === 'плащане');
  assert.equal(payLine.amount, -4);
});

test('account:pay rejects a zero amount (Math.abs of a negative amount would just pay that much)', async () => {
  const { ipcMain, readerId } = setup();
  const result = await ipcMain.invoke('account:pay', { reader_id: readerId, amount: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /положителна/);
});

test('account:deleteLine removes a line and updates the balance', async () => {
  const { ipcMain, readerId } = setup();
  const lineId = (await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 8 })).data;
  await ipcMain.invoke('account:deleteLine', lineId);
  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.balance, 0);
  assert.equal(got.data.lines.length, 0);
});

test('account:get defaults date to today() when not provided', async () => {
  const { ipcMain, readerId } = setup();
  await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 1 });
  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.lines[0].date, '2026-08-02');
});
