// Тест на handlers/av.js — единайсети домейн, извадено от main.js (Фаза 4,
// стъпка 12). За разлика от authorised_values seeding-а (в main.js, извън
// обхвата на този модул), тук базата НЕ се засява автоматично — тестовете
// проверяват av:save/av:options директно.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerAvHandlers = require('../handlers/av');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-av-test-'));
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
  registerAvHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerAvHandlers registers all three av: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['av:categories', 'av:options', 'av:save']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('av:categories returns the three fixed categories with Bulgarian labels', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('av:categories');
  assert.equal(result.ok, true);
  assert.equal(result.data.department, 'Отдел / местонахождение');
  assert.equal(result.data.language, 'Език');
  assert.equal(result.data.location, 'Постоянно място (рафт, витрина, шкаф)');
});

test('av:options returns an empty list per category on a fresh (unseeded) database', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('av:options');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.department, []);
  assert.deepEqual(result.data.language, []);
  assert.deepEqual(result.data.location, []);
});

test('av:save replaces the entire category list, in order, and logs an audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const saved = await ipcMain.invoke('av:save', {
    category: 'language',
    values: [{ value: 'български' }, { value: 'английски', opac_label: 'English' }]
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.data, 2);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /Език/);

  const options = await ipcMain.invoke('av:options');
  assert.equal(options.data.language.length, 2);
  assert.equal(options.data.language[0].value, 'български');
  assert.equal(options.data.language[1].opac_label, 'English');
});

test('av:save trims values, drops blanks, and a second save fully replaces the first (not appends)', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('av:save', { category: 'department', values: [{ value: 'за възрастни' }, { value: 'за деца' }] });
  const second = await ipcMain.invoke('av:save', { category: 'department', values: [{ value: '  краеведски  ' }, { value: '   ' }] });
  assert.equal(second.ok, true);
  assert.equal(second.data, 1, 'blank entries should be dropped');
  const options = await ipcMain.invoke('av:options');
  assert.equal(options.data.department.length, 1);
  assert.equal(options.data.department[0].value, 'краеведски', 'should be trimmed and be the ONLY row (fully replaced)');
});

test('av:save rejects an unknown category', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('av:save', { category: 'not_real', values: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /Непозната номенклатура/);
});

test('av:save rejects a duplicate value within the same submitted list', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('av:save', {
    category: 'location',
    values: [{ value: 'Рафт 1' }, { value: 'Рафт 1' }]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /се повтаря/);
});
