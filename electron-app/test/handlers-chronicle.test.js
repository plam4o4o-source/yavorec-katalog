// Тест на handlers/chronicle.js — краеведски модул "Летопис", извадено от
// main.js (Фаза 4, стъпка 31). Покрива chronicle:list/get/years/create/update/delete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerChronicleHandlers = require('../handlers/chronicle');


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
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-chronicle-test-'));
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
  registerChronicleHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerChronicleHandlers registers all chronicle: channels', () => {
  const { ipcMain } = setup();
  ['chronicle:list', 'chronicle:get', 'chronicle:years', 'chronicle:create', 'chronicle:update', 'chronicle:delete']
    .forEach(ch => assert.ok(ipcMain.has(ch), ch));
});

test('chronicle:create derives year from date when year is omitted, and logs the audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const create = await ipcMain.invoke('chronicle:create', { date: '2026-05-12', title: 'Годишнина' });
  assert.equal(create.ok, true);
  const got = await ipcMain.invoke('chronicle:get', create.data);
  assert.equal(got.data.year, '2026');
  assert.ok(auditLog.some(a => a.action === 'Летопис' && /Годишнина/.test(a.detail)));
});

test('chronicle:list filters by q and year, ordered newest first, with link counts', async () => {
  const { db, ipcMain } = setup();
  const id1 = (await ipcMain.invoke('chronicle:create', { year: '2020', title: 'Стар събор' })).data;
  await ipcMain.invoke('chronicle:create', { year: '2026', title: 'Нов събор' });
  db.prepare("INSERT INTO links (from_kind, from_id, to_kind, to_id) VALUES ('летопис', ?, 'книга', 1)").run(id1);

  const all = await ipcMain.invoke('chronicle:list');
  assert.equal(all.data.length, 2);
  assert.equal(all.data[0].year, '2026'); // ordered year DESC

  const byYear = await ipcMain.invoke('chronicle:list', { year: '2020' });
  assert.equal(byYear.data.length, 1);
  assert.equal(byYear.data[0].links, 1);

  const byQ = await ipcMain.invoke('chronicle:list', { q: 'Нов' });
  assert.equal(byQ.data.length, 1);
});

test('chronicle:years groups by year', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('chronicle:create', { year: '2026', title: 'А' });
  await ipcMain.invoke('chronicle:create', { year: '2026', title: 'Б' });
  const years = await ipcMain.invoke('chronicle:years');
  assert.deepEqual(years.data, [{ year: '2026', n: 2 }]);
});

test('chronicle:update edits fields and re-derives year from a new date', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('chronicle:create', { year: '2020', title: 'Стар' })).data;
  await ipcMain.invoke('chronicle:update', { id, date: '2026-01-01', title: 'Нов' });
  const got = await ipcMain.invoke('chronicle:get', id);
  assert.equal(got.data.title, 'Нов');
  assert.equal(got.data.year, '2026');
});

test('chronicle:delete removes the record and any links to/from it', async () => {
  const { db, ipcMain } = setup();
  const id = (await ipcMain.invoke('chronicle:create', { year: '2026', title: 'X' })).data;
  db.prepare("INSERT INTO links (from_kind, from_id, to_kind, to_id) VALUES ('летопис', ?, 'книга', 1)").run(id);
  const result = await ipcMain.invoke('chronicle:delete', id);
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT * FROM chronicle WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare("SELECT * FROM links WHERE from_kind='летопис' AND from_id = ?").get(id), undefined);
});
