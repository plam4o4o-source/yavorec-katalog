// Тест на handlers/audit.js — двайсет и седми домейн, извадено от main.js
// (Фаза 4, стъпка 28).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerAuditHandlers = require('../handlers/audit');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-audit-test-'));
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
  registerAuditHandlers(ipcMain, deps);
  return { db, ipcMain };
}

test('registerAuditHandlers registers audit:list', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('audit:list'));
});

test('audit:list returns all rows ordered by id DESC when no query is given', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('Иван', 'Вход', '')").run();
  db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('Петър', 'Изход', '')").run();

  const result = await ipcMain.invoke('audit:list');
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].user, 'Петър', 'newest first');
});

test('audit:list filters by user/action/detail LIKE when a query is given', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('Иван', 'Вход', 'бележка')").run();
  db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('Петър', 'Изход', 'друго')").run();

  const byUser = await ipcMain.invoke('audit:list', 'Иван');
  assert.equal(byUser.data.length, 1);

  const byDetail = await ipcMain.invoke('audit:list', 'бележка');
  assert.equal(byDetail.data.length, 1);
  assert.equal(byDetail.data[0].user, 'Иван');
});
