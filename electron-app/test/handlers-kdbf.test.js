// Тест на handlers/kdbf.js — шестнайсети домейн, извадено от main.js
// (Фаза 4, стъпка 16). Единствен read-only справочен handler — не пише нищо,
// затова тестовете само подготвят acquisitions/deaccession_acts/books и
// проверяват агрегираните числа в отговора.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerKdbfHandlers = require('../handlers/kdbf');


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
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-kdbf-test-'));
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
    },
    yearOf: (d) => (d || '2026-08-02').slice(0, 4)
  };
  registerKdbfHandlers(ipcMain, deps);
  return { db, ipcMain };
}

test('registerKdbfHandlers registers kdbf:report', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('kdbf:report'));
});

test('kdbf:report defaults to the current year (via yearOf) when no year is passed', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('kdbf:report');
  assert.equal(result.ok, true);
  assert.equal(result.data.year, '2026');
});

test('kdbf:report part1 aggregates registered_count/registered_value/inv_from/inv_to per acquisition batch', async () => {
  const { db, ipcMain } = setup();
  const acqId = db.prepare(`
    INSERT INTO acquisitions (no, year, date, total_count) VALUES (1, '2026', '2026-01-01', 2)
  `).run().lastInsertRowid;
  db.prepare('INSERT INTO books (inv_number, title, acquisition_id, price, register_date) VALUES (5, ?, ?, ?, ?)')
    .run('Книга А', acqId, 10, '2026-01-05');
  db.prepare('INSERT INTO books (inv_number, title, acquisition_id, price, register_date) VALUES (8, ?, ?, ?, ?)')
    .run('Книга Б', acqId, 6, '2026-01-06');

  const result = await ipcMain.invoke('kdbf:report', '2026');
  assert.equal(result.data.part1.length, 1);
  const row = result.data.part1[0];
  assert.equal(row.registered_count, 2);
  assert.equal(row.registered_value, 16);
  assert.equal(row.inv_from, 5);
  assert.equal(row.inv_to, 8);
});

test('kdbf:report part3 aggregates item_count/item_value per deaccession act', async () => {
  const { db, ipcMain } = setup();
  const actId = db.prepare(`
    INSERT INTO deaccession_acts (no, year, date, reason_code, reason_text)
    VALUES (1, '2026', '2026-02-01', 1, 'износени')
  `).run().lastInsertRowid;
  db.prepare('INSERT INTO deaccession_items (act_id, inv_number, title, price) VALUES (?, 3, ?, ?)').run(actId, 'В', 7);
  db.prepare('INSERT INTO deaccession_items (act_id, inv_number, title, price) VALUES (?, 4, ?, ?)').run(actId, 'Г', 3);

  const result = await ipcMain.invoke('kdbf:report', '2026');
  assert.equal(result.data.part3.length, 1);
  assert.equal(result.data.part3[0].item_count, 2);
  assert.equal(result.data.part3[0].item_value, 10);
});

test('kdbf:report stockEnd counts books registered by year-end and not yet deaccessioned by then', async () => {
  const { db, ipcMain } = setup();
  // В наличност към края на годината: регистрирана преди края, не отчислена.
  db.prepare('INSERT INTO books (inv_number, title, price, register_date) VALUES (1, ?, ?, ?)')
    .run('В наличност', 20, '2025-06-01');
  // Отчислена преди края на годината — не бива да се брои в наличност.
  db.prepare('INSERT INTO books (inv_number, title, price, register_date, deaccession_date) VALUES (2, ?, ?, ?, ?)')
    .run('Отчислена', 15, '2025-01-01', '2026-06-01');
  // Регистрирана след края на годината — не бива да се брои.
  db.prepare('INSERT INTO books (inv_number, title, price, register_date) VALUES (3, ?, ?, ?)')
    .run('Бъдеща', 30, '2027-01-01');

  const result = await ipcMain.invoke('kdbf:report', '2026');
  assert.equal(result.data.stockEnd.n, 1);
  assert.equal(result.data.stockEnd.v, 20);
});

test('kdbf:report acquiredYear and deaccYear count only rows within the given year', async () => {
  const { db, ipcMain } = setup();
  db.prepare('INSERT INTO books (inv_number, title, price, register_date) VALUES (1, ?, ?, ?)')
    .run('Тази година', 10, '2026-03-01');
  db.prepare('INSERT INTO books (inv_number, title, price, register_date) VALUES (2, ?, ?, ?)')
    .run('Миналата година', 40, '2025-03-01');

  const actId = db.prepare(`
    INSERT INTO deaccession_acts (no, year, date, reason_code, reason_text)
    VALUES (1, '2026', '2026-04-01', 1, 'x')
  `).run().lastInsertRowid;
  db.prepare('INSERT INTO deaccession_items (act_id, inv_number, title, price) VALUES (?, 9, ?, ?)').run(actId, 'Д', 5);

  const result = await ipcMain.invoke('kdbf:report', '2026');
  assert.equal(result.data.acquiredYear.n, 1);
  assert.equal(result.data.acquiredYear.v, 10);
  assert.equal(result.data.deaccYear.n, 1);
  assert.equal(result.data.deaccYear.v, 5);
});
