// Тест на handlers/inv-book.js — дванайсети домейн, извадено от main.js
// (Фаза 4, стъпка 13). Единствен read-only handler — проверява JOIN-ите
// (категория/постъпление/акт за отчисляване) и групирането на инвентарните
// проверки по книга.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerInvBookHandlers = require('../handlers/inv-book');


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
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-invbook-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
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
  registerInvBookHandlers(ipcMain, deps);
  return { db, ipcMain };
}

test('registerInvBookHandlers registers invBook:list', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('invBook:list'));
});

test('invBook:list returns books ordered by inventory number, with category/acquisition/deaccession joined in', async () => {
  const { db, ipcMain } = setup();
  const catId = db.prepare("SELECT id FROM categories WHERE name = 'книга'").get().id;
  const acqId = db.prepare("INSERT INTO acquisitions (no, year, date) VALUES (5, '2026', '2026-01-10')").run().lastInsertRowid;
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date) VALUES (2, '2026', '2026-02-01')").run().lastInsertRowid;

  db.prepare('INSERT INTO books (inv_number, title, category_id, acquisition_id) VALUES (?, ?, ?, ?)')
    .run(2, 'Втора книга', catId, acqId);
  db.prepare('INSERT INTO books (inv_number, title, category_id, deaccession_act_id) VALUES (?, ?, ?, ?)')
    .run(1, 'Първа книга', catId, actId);

  const result = await ipcMain.invoke('invBook:list');
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].inv_number, 1, 'should be ordered by inv_number ascending');
  assert.equal(result.data[0].category_name, 'книга');
  assert.equal(result.data[0].act_no, 2);
  assert.equal(result.data[1].acq_no, 5);
});

test('invBook:list groups inventory check dates per book, in date order, and reports an empty array for unchecked books', async () => {
  const { db, ipcMain } = setup();
  const id1 = db.prepare('INSERT INTO books (inv_number, title) VALUES (1, ?)').run('Книга А').lastInsertRowid;
  const id2 = db.prepare('INSERT INTO books (inv_number, title) VALUES (2, ?)').run('Книга Б').lastInsertRowid;
  db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(id1, '2026-06-01');
  db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(id1, '2025-01-01');

  const result = await ipcMain.invoke('invBook:list');
  const rowA = result.data.find(r => r.id === id1);
  const rowB = result.data.find(r => r.id === id2);
  assert.deepEqual(rowA.checks, ['2025-01-01', '2026-06-01']);
  assert.deepEqual(rowB.checks, []);
});
