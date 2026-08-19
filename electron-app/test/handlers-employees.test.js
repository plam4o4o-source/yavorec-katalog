// Тест на handlers/employees.js — пети домейн, извадено от main.js (Фаза 4,
// стъпка 6). Най-простият случай досега: само CRUD над една таблица, без
// нито една върната функция назад към main.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerEmployeesHandlers = require('../handlers/employees');


/* Хигиена на временните папки. node --test не чисти нищо след себе си, а всяка
   фикстура тук създава каталог в /tmp. Одитът завари 80 431 каталога / 23 GB;
   при пълен диск поредицата започва да пада лавинообразно на съвсем несвързани
   места (# pass 302 / # fail 345) и прати диагностиката по грешна следа.
   mkTmpDir() запомня папката, test.after() я трие. */
const tmpDirs = [];
function mkTmpDir(prefixPath) {
  const d = fs.mkdtempSync(prefixPath);
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
  }
});

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-employees-test-'));
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
  registerEmployeesHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerEmployeesHandlers registers all four employees: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['employees:list', 'employees:create', 'employees:update', 'employees:delete']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('employees:create adds an employee (trimmed), active by default, logs an audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const result = await ipcMain.invoke('employees:create', '  Иван Иванов  ');
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);
  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].detail, 'Иван Иванов');

  const list = await ipcMain.invoke('employees:list');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].name, 'Иван Иванов');
  assert.equal(list.data[0].active, 1);
});

test('employees:create rejects an empty/whitespace-only name', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('employees:create', '   ');
  assert.equal(result.ok, false);
  assert.match(result.error, /Въведете име/);
});

test('employees:create rejects a duplicate name (UNIQUE constraint) with a friendly-ish error, not a crash', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('employees:create', 'Мария Петрова');
  const dup = await ipcMain.invoke('employees:create', 'Мария Петрова');
  assert.equal(dup.ok, false);
});

test('employees:list orders active employees before inactive ones, then by name', async () => {
  const { ipcMain } = setup();
  const idA = (await ipcMain.invoke('employees:create', 'Борис')).data;
  await ipcMain.invoke('employees:create', 'Ана');
  await ipcMain.invoke('employees:update', { id: idA, active: false });

  const list = await ipcMain.invoke('employees:list');
  assert.equal(list.data.length, 2);
  assert.equal(list.data[0].name, 'Ана', 'active employees sort first');
  assert.equal(list.data[1].name, 'Борис');
});

test('employees:update partially updates only the provided fields, keeping the rest', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('employees:create', 'Георги')).data;
  const onlyActive = await ipcMain.invoke('employees:update', { id, active: false });
  assert.equal(onlyActive.ok, true);
  let list = await ipcMain.invoke('employees:list');
  assert.equal(list.data[0].name, 'Георги', 'name should be unchanged');
  assert.equal(list.data[0].active, 0);

  const onlyName = await ipcMain.invoke('employees:update', { id, name: 'Георгиев' });
  assert.equal(onlyName.ok, true);
  list = await ipcMain.invoke('employees:list');
  assert.equal(list.data[0].name, 'Георгиев');
  assert.equal(list.data[0].active, 0, 'active should remain unchanged from the previous update');
});

test('employees:update on a non-existent id reports a friendly error', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('employees:update', { id: 999999, name: 'X' });
  assert.equal(result.ok, false);
  assert.match(result.error, /не е намерен/);
});

test('employees:delete removes the row', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('employees:create', 'За изтриване')).data;
  const del = await ipcMain.invoke('employees:delete', id);
  assert.equal(del.ok, true);
  const list = await ipcMain.invoke('employees:list');
  assert.equal(list.data.length, 0);
});
