// Тест на handlers/circ-rules.js — четвърти домейн, извадено от main.js
// (Фаза 4, стъпка 5). Освен IPC каналите, тестваме и връщаните функции
// (circRule/readerCategory), защото се ползват пряко от main.js (домейнът
// "Заемания", все още неизваден) — регресия тук би развалила изчисляването
// на реалния срок/лимит на заемане на читателя.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerCircRulesHandlers = require('../handlers/circ-rules');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-circrules-test-'));
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
  const returned = registerCircRulesHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, returned };
}

test('registerCircRulesHandlers registers all four circRules: IPC channels and returns circRule/readerCategory', () => {
  const { ipcMain, returned } = setup();
  for (const ch of ['circRules:list', 'circRules:save', 'circRules:delete', 'circRules:effective']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
  assert.equal(typeof returned.circRule, 'function');
  assert.equal(typeof returned.readerCategory, 'function');
});

test('circRule() with no category falls back to the global settings defaults', () => {
  const { returned } = setup();
  const rule = returned.circRule(null);
  assert.equal(rule.loan_days, 30);
  assert.equal(rule.max_books, 5);
  assert.equal(rule.extensions_count, 2);
  assert.equal(rule.extension_days, 30);
  assert.equal(rule.suspend_per_day, 0);
  assert.equal(rule.suspend_max, 90);
});

test('circRule() for a category with no override row also falls back to global settings', () => {
  const { returned } = setup();
  const rule = returned.circRule('дете');
  assert.equal(rule.loan_days, 30);
  assert.equal(rule.max_books, 5);
});

test('circRules:save creates a category override; circRule() picks overridden fields and falls back for the rest (partial NULL)', async () => {
  const { ipcMain, returned, auditLog } = setup();
  const result = await ipcMain.invoke('circRules:save', {
    category: 'дете', loan_days: 14, max_books: 3,
    extensions_count: '', extension_days: null, suspend_per_day: '', suspend_max: ''
  });
  assert.equal(result.ok, true);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /дете/);

  const rule = returned.circRule('дете');
  assert.equal(rule.loan_days, 14, 'overridden field should win');
  assert.equal(rule.max_books, 3, 'overridden field should win');
  assert.equal(rule.extensions_count, 2, 'blank override field should fall back to global');
  assert.equal(rule.extension_days, 30, 'null override field should fall back to global');
  assert.equal(rule.suspend_per_day, 0, 'blank override field should fall back to global');
  assert.equal(rule.suspend_max, 90, 'blank override field should fall back to global');
});

test('circRules:save rejects an empty category', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('circRules:save', { category: '  ', loan_days: 10 });
  assert.equal(result.ok, false);
  assert.match(result.error, /задължителна/);
});

test('circRules:save upserts on conflict (ON CONFLICT DO UPDATE), not duplicate rows', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('circRules:save', { category: 'студент', loan_days: 21 });
  await ipcMain.invoke('circRules:save', { category: 'студент', loan_days: 25 });
  const list = await ipcMain.invoke('circRules:list');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].loan_days, 25);
});

test('circRules:delete removes the override; circRule() falls back to global again afterward', async () => {
  const { ipcMain, returned } = setup();
  await ipcMain.invoke('circRules:save', { category: 'дете', loan_days: 14 });
  assert.equal(returned.circRule('дете').loan_days, 14);
  const del = await ipcMain.invoke('circRules:delete', 'дете');
  assert.equal(del.ok, true);
  assert.equal(returned.circRule('дете').loan_days, 30);
});

test('circRules:effective returns the same shape as circRule() for a given category', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('circRules:save', { category: 'дете', loan_days: 14, max_books: 3 });
  const result = await ipcMain.invoke('circRules:effective', 'дете');
  assert.equal(result.ok, true);
  assert.equal(result.data.loan_days, 14);
  assert.equal(result.data.max_books, 3);
});

test('readerCategory() returns the reader\'s category, defaulting to "възрастен" for a new reader', () => {
  const { db, returned } = setup();
  const info = db.prepare('INSERT INTO readers (name) VALUES (?)').run('Тестов читател');
  assert.equal(returned.readerCategory(info.lastInsertRowid), 'възрастен');
});

test('readerCategory() returns null for a non-existent reader id', () => {
  const { returned } = setup();
  assert.equal(returned.readerCategory(999999), null);
});
