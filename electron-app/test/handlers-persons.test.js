// Тест на handlers/persons.js — краеведски модул "Персоналии", извадено от
// main.js (Фаза 4, стъпка 31). Покрива persons:list/get/create/update/delete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerPersonsHandlers = require('../handlers/persons');


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
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-persons-test-'));
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
  registerPersonsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerPersonsHandlers registers all persons: channels', () => {
  const { ipcMain } = setup();
  ['persons:list', 'persons:get', 'persons:create', 'persons:update', 'persons:delete']
    .forEach(ch => assert.ok(ipcMain.has(ch), ch));
});

test('persons:create inserts a row and logs; persons:get reads it back', async () => {
  const { ipcMain, auditLog } = setup();
  const create = await ipcMain.invoke('persons:create', { name: 'Иван Вазов', activity: 'писател' });
  assert.equal(create.ok, true);
  const got = await ipcMain.invoke('persons:get', create.data);
  assert.equal(got.data.name, 'Иван Вазов');
  assert.ok(auditLog.some(a => a.action === 'Персоналии' && /Иван Вазов/.test(a.detail)));
});

test('persons:list filters by q across name/alt_names/activity/bio and reports link counts', async () => {
  const { db, ipcMain } = setup();
  const id1 = (await ipcMain.invoke('persons:create', { name: 'Петко Славейков' })).data;
  await ipcMain.invoke('persons:create', { name: 'Друг' });
  db.prepare("INSERT INTO links (from_kind, from_id, to_kind, to_id) VALUES ('персона', ?, 'книга', 1)").run(id1);

  const all = await ipcMain.invoke('persons:list');
  assert.equal(all.data.length, 2);
  const p1 = all.data.find(p => p.id === id1);
  assert.equal(p1.links, 1);

  const filtered = await ipcMain.invoke('persons:list', 'Славейков');
  assert.equal(filtered.data.length, 1);
  assert.equal(filtered.data[0].name, 'Петко Славейков');
});

test('persons:update edits fields', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('persons:create', { name: 'Стар' })).data;
  await ipcMain.invoke('persons:update', { id, name: 'Нов' });
  const got = await ipcMain.invoke('persons:get', id);
  assert.equal(got.data.name, 'Нов');
});

test('persons:delete removes the person and any links to/from them', async () => {
  const { db, ipcMain } = setup();
  const id = (await ipcMain.invoke('persons:create', { name: 'X' })).data;
  db.prepare("INSERT INTO links (from_kind, from_id, to_kind, to_id) VALUES ('персона', ?, 'книга', 1)").run(id);
  db.prepare("INSERT INTO links (from_kind, from_id, to_kind, to_id) VALUES ('летопис', 1, 'персона', ?)").run(id);
  const result = await ipcMain.invoke('persons:delete', id);
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT * FROM persons WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM links WHERE from_id = ? OR to_id = ?").get(id, id).n, 0);
});
