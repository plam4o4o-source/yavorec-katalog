// Тест на handlers/visits.js — двайсет и девети домейн, извадено от main.js
// (Фаза 4, стъпка 28).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerVisitsHandlers = require('../handlers/visits');


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
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-visits-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: () => {}
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

test('visits:add refuses a non-numeric count instead of silently recording 0', async () => {
  // Одит v2.4.25: дотук undefined/„abc“ ставаха 0 и се записваше „Посещенията са
  // вписани.“ за нищо; сега броят е задължително цяло число ≥ 0.
  const { db, ipcMain } = setup();
  const res = await ipcMain.invoke('visits:add', { date: '2026-08-03', count: undefined });
  assert.equal(res.ok, false);
  assert.match(res.error, /цяло число/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 0);
});
