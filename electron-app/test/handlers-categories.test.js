// Тест на handlers/categories.js — шести домейн, извадено от main.js (Фаза
// 4, стъпка 7). Най-простият случай досега: 4 реда логика, само getDb/run,
// без logAudit, без нито една върната функция.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerCategoriesHandlers = require('../handlers/categories');


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
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-categories-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  // v2.4.14: модулът вече вписва изтриването в одитната следа — изтриването на
  // категория обезличава всяка книга от нея (ON DELETE SET NULL) и дотук не
  // оставяше никаква следа.
  const auditLog = [];
  const deps = {
    getDb: () => db,
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    }
  };
  registerCategoriesHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerCategoriesHandlers registers all categories: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['categories:list', 'categories:create', 'categories:update', 'categories:usage', 'categories:delete']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('categories:create adds a trimmed name; categories:list includes it alongside the 10 seeded default categories', async () => {
  const { ipcMain } = setup();
  const before = await ipcMain.invoke('categories:list');
  assert.equal(before.data.length, 10, 'schema.sql seeds 10 default document-type categories');

  await ipcMain.invoke('categories:create', 'Романи');
  await ipcMain.invoke('categories:create', '  Детска литература  ');
  const list = await ipcMain.invoke('categories:list');
  assert.equal(list.ok, true);
  assert.equal(list.data.length, 12);
  const names = list.data.map(c => c.name);
  assert.ok(names.includes('Романи'));
  assert.ok(names.includes('Детска литература'), 'name should have been trimmed and still present');
  // Проверка за азбучна подредба: 'аудиодокумент' (seed) трябва да е преди 'книга' (seed).
  assert.ok(names.indexOf('аудиодокумент') < names.indexOf('книга'));
});

test('categories:create rejects a duplicate name (UNIQUE constraint) instead of crashing', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('categories:create', 'Поезия');
  const dup = await ipcMain.invoke('categories:create', 'Поезия');
  assert.equal(dup.ok, false);
});

test('categories:update renames a category', async () => {
  const { ipcMain } = setup();
  const created = await ipcMain.invoke('categories:create', 'Стар текст');
  const id = created.data.lastInsertRowid;
  const updated = await ipcMain.invoke('categories:update', { id, name: 'Нов текст' });
  assert.equal(updated.ok, true);
  const list = await ipcMain.invoke('categories:list');
  const names = list.data.map(c => c.name);
  assert.ok(!names.includes('Стар текст'));
  assert.ok(names.includes('Нов текст'));
});

test('categories:delete removes just the one row, leaving the 10 seeded defaults untouched', async () => {
  const { ipcMain } = setup();
  const before = await ipcMain.invoke('categories:list');
  assert.equal(before.data.length, 10);
  const created = await ipcMain.invoke('categories:create', 'За изтриване');
  const id = created.data.lastInsertRowid;
  const del = await ipcMain.invoke('categories:delete', id);
  assert.equal(del.ok, true);
  // v2.4.14: връща се броят книги, останали без вид (тук 0), за да го покаже екранът.
  assert.equal(del.data, 0);
  const list = await ipcMain.invoke('categories:list');
  assert.equal(list.data.length, 10);
  assert.ok(!list.data.map(c => c.name).includes('За изтриване'));
});
