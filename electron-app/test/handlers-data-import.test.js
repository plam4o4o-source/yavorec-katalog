// Тест на handlers/data-import.js — трийсет и шести домейн, извадено от
// main.js (Фаза 4, стъпка 36). Покрива import:load/choose/run срещу истински
// CSV файлове (модулът изисква ../importers директно, не през deps).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerDataImportHandlers = require('../handlers/data-import');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

const BOOK_FIELDS = ['inv_number', 'barcode', 'register_date', 'title', 'subtitle', 'author',
  'category_id', 'year', 'volume', 'isbn', 'pages', 'language', 'udk', 'call_number', 'author_mark',
  'city', 'publisher', 'keywords', 'annotation', 'cover_url', 'department', 'permanent_location',
  'status', 'status_date', 'price', 'description', 'acquisition_id', 'cn_sort'];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-data-import-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const savedDialogs = { openDialog: null };
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    dialog: {
      showOpenDialog: async () => savedDialogs.openDialog || { canceled: true, filePaths: [] }
    },
    getMainWindow: () => ({}),
    fs, path, BOOK_FIELDS
  };
  registerDataImportHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, dir, savedDialogs };
}

test('registerDataImportHandlers registers import:load/choose/run', () => {
  const { ipcMain } = setup();
  ['import:load', 'import:choose', 'import:run'].forEach(ch => assert.ok(ipcMain.has(ch), ch));
});

test('import:load reports a missing file', async () => {
  const { ipcMain, dir } = setup();
  const result = await ipcMain.invoke('import:load', path.join(dir, 'nonexistent.csv'));
  assert.equal(result.ok, false);
  assert.match(result.error, /не е намерен/);
});

test('import:load reads a semicolon CSV, guesses the column mapping, and previews rows', async () => {
  const { ipcMain, dir } = setup();
  const csvPath = path.join(dir, 'export.csv');
  fs.writeFileSync(csvPath, 'Инвентарен №;Заглавие;Автор\r\n1;Под игото;Вазов, Иван\r\n2;Тихият Дон;Шолохов\r\n', 'utf8');
  const result = await ipcMain.invoke('import:load', csvPath);
  assert.equal(result.ok, true);
  assert.equal(result.data.total, 2);
  assert.deepEqual(result.data.mapping, { 0: 'inv_number', 1: 'title', 2: 'author' });
  assert.equal(result.data.preview.length, 2);
});

test('import:choose reports cancellation, then loads the chosen file on success', async () => {
  const { ipcMain, dir, savedDialogs } = setup();
  const cancelled = await ipcMain.invoke('import:choose');
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /Отказано/);

  const csvPath = path.join(dir, 'chosen.csv');
  fs.writeFileSync(csvPath, 'Заглавие\r\nX\r\n', 'utf8');
  savedDialogs.openDialog = { canceled: false, filePaths: [csvPath] };
  const result = await ipcMain.invoke('import:choose');
  assert.equal(result.ok, true);
  assert.equal(result.data.total, 1);
});

test('import:run requires a file to have been loaded first', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'title' }, options: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /Първо изберете файл/);
});

test('import:run requires a title column mapping', async () => {
  const { ipcMain, dir } = setup();
  const csvPath = path.join(dir, 'x.csv');
  fs.writeFileSync(csvPath, 'Автор\r\nВазов\r\n', 'utf8');
  await ipcMain.invoke('import:load', csvPath);
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'author' }, options: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /Заглавие/);
});

// PRE-EXISTING BUG, NOT introduced by this extraction (confirmed via git history:
// 'permanent_location' was added to BOOK_FIELDS in an older commit and the
// import:run payload literal was never updated to include it). Because the INSERT
// is built from BOOK_FIELDS with named placeholders, and the payload object never
// sets `permanent_location`, better-sqlite3 throws "Missing named parameter
// 'permanent_location'" for EVERY row, which import:run's per-row catch turns into
// a silent per-line error entry — so data import has been fully non-functional
// since that field was added. Preserved as-is per Phase 4's no-behavior-change
// rule; flagged in the CHANGELOG for a follow-up bug-fix commit (out of scope here).
test('import:run currently fails every row with a "Missing named parameter" error (pre-existing bug, not from this extraction)', async () => {
  const { db, ipcMain } = setup();
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-data-import-run-'));
  const csv = [
    'Инвентарен №;Заглавие;Автор;Език',
    '1;Под игото;Вазов, Иван;български',
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(realDir, 'in.csv'), csv, 'utf8');
  await ipcMain.invoke('import:load', path.join(realDir, 'in.csv'));
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title', 2: 'author', 3: 'language' }, options: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 0);
  assert.equal(result.data.skipped, 1);
  assert.match(result.data.errors[0].error, /Missing named parameter "permanent_location"/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books WHERE title='Под игото'").get().n, 0);
});

test('import:run with skipDuplicates=true still reaches the duplicate-skip check before the (buggy) insert', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title) VALUES (10, 'Стар')").run();
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-data-import-dup-'));
  fs.writeFileSync(path.join(dir2, 'in.csv'), 'Инвентарен №;Заглавие\r\n10;Дублиран внос\r\n', 'utf8');
  await ipcMain.invoke('import:load', path.join(dir2, 'in.csv'));
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title' }, options: { skipDuplicates: true } });
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 0);
  assert.equal(result.data.skipped, 1);
  assert.equal(result.data.errors.length, 0); // skipped via the dup check, never reached the insert
});
