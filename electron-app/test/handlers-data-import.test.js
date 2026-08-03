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
    fs, path, BOOK_FIELDS,
    // Копие на today()/cnSortKey() от main.js — виж деловете там (v1.59.0
    // bug-fix commit) защо import:run сега разчита на тях.
    today: () => '2026-08-02',
    cnSortKey: (s) => String(s || '').toUpperCase().trim().replace(/\d+/g, m => m.padStart(6, '0'))
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

// BUG FIX (v1.59.0 — виж CHANGELOG): това по-рано беше документиран,
// НЕпоправен бъг (permanent_location липсваше от payload-а на import:run,
// макар да е част от BOOK_FIELDS — better-sqlite3 хвърляше "Missing named
// parameter" за ВСЕКИ ред и вносът не работеше изобщо). При по-задълбочена
// проверка на всичките 28 полета в BOOK_FIELDS срещу payload литерала се
// оказа, че липсват НЕ едно, а три полета: permanent_location, status_date
// и cn_sort — само първото (по реда в BOOK_FIELDS) стигаше до съобщението
// за грешка, докато не се поправеше. И трите вече се подават коректно
// (виж handlers/data-import.js) — този тест сега проверява, че вносът
// реално записва реда, вместо да документира счупеното поведение.
test('import:run successfully inserts a row (regression test for the fixed permanent_location/status_date/cn_sort bug)', async () => {
  const { db, ipcMain } = setup();
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-data-import-run-'));
  const csv = [
    'Инвентарен №;Заглавие;Автор;Език;Сигнатура',
    '1;Под игото;Вазов, Иван;български;Ч-9',
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(realDir, 'in.csv'), csv, 'utf8');
  await ipcMain.invoke('import:load', path.join(realDir, 'in.csv'));
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title', 2: 'author', 3: 'language', 4: 'call_number' }, options: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 1);
  assert.equal(result.data.skipped, 0);
  assert.equal(result.data.errors.length, 0);
  const row = db.prepare("SELECT * FROM books WHERE title='Под игото'").get();
  assert.ok(row, 'the row should have actually been inserted');
  assert.equal(row.permanent_location, null);
  assert.equal(row.status_date, '2026-08-02');
  assert.equal(row.status, 'наличен');
  assert.equal(row.cn_sort, 'Ч-000009'); // cnSortKey() pads the digits in the call number
});

test('import:run with skipDuplicates=true still reaches the duplicate-skip check before the insert', async () => {
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
