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

/* BOOK_FIELDS се ВЗИМА от продукционния handlers/books.js, а не се преписва тук.
   Преписаното копие беше дефект само по себе си: през v1.70.0 в истинския списък
   влязоха series/series_no, копието остана с 28 полета, и целият внос на данни
   гърмеше в продукцията („Missing named parameter «series»" за всеки ред, „0
   добавени"), докато този тест светеше зелено — тестваше конфигурация, която
   main.js никога не подава. Сега всяко ново поле в BOOK_FIELDS чупи теста веднага.
   registerBooksHandlers се вика с минимални заглушки — интересува ни само
   върнатият BOOK_FIELDS, не самите handler-и. */
const BOOK_FIELDS = require('../handlers/books')(
  { handle: () => {} },
  { getDb: () => null, run: (fn) => fn, logAudit: () => {}, today: () => '2026-01-01',
    logEvent: () => {}, scheduleCatalogWrite: () => {}, cnSortKey: () => null,
    normalizeScanCode: (x) => x, checkRecordLimit: () => {} }
).BOOK_FIELDS;

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-data-import-test-'));
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
  const realDir = mkTmpDir(path.join(os.tmpdir(), 'inv-data-import-run-'));
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
  const dir2 = mkTmpDir(path.join(os.tmpdir(), 'inv-data-import-dup-'));
  fs.writeFileSync(path.join(dir2, 'in.csv'), 'Инвентарен №;Заглавие\r\n10;Дублиран внос\r\n', 'utf8');
  await ipcMain.invoke('import:load', path.join(dir2, 'in.csv'));
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title' }, options: { skipDuplicates: true } });
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 0);
  assert.equal(result.data.skipped, 1);
  assert.equal(result.data.errors.length, 0); // skipped via the dup check, never reached the insert
});

/* ---------------------------------------------------------------------------
   Регресия v1.65.0 — колона „Състояние“ проваляше ЦЕЛИЯ внос.

   importers.js съпоставя заглавие „състояние“ към books.status, но в наследените
   таблици (АБ, стар Excel) тази колона почти винаги описва ФИЗИЧЕСКОТО състояние на
   екземпляра — „добро“, „скъсана корица“, „пожълтяла“. Тригерът за изброими стойности
   (db/enum-triggers.js) допуска само четирите статуса, затова всеки ред се отхвърляше
   и вносът връщаше нула добавени при иначе напълно годни данни.

   Досегашният тестов пакет не го хващаше, защото тук тригерите изобщо не се прилагаха,
   докато main.js ги прилага при всяко стартиране — тоест тестът работеше върху база,
   различна от реалната. Затова този тест ги прилага изрично.
   --------------------------------------------------------------------------- */
const { applyEnumTriggers } = require('../db/enum-triggers');


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

test('колона „Състояние“ с физическо състояние не проваля вноса — пази се в забележката', async () => {
  const { db, ipcMain } = setup();
  applyEnumTriggers(db); // както прави main.js при всяко стартиране
  const realDir = mkTmpDir(path.join(os.tmpdir(), 'inv-import-status-'));
  const csv = [
    'Инвентарен №;Заглавие;Състояние;Забележка',
    '1;Под игото;добро;дарение',
    '2;Тихият Дон;скъсана корица;',
    '3;Записки;липсващ;'
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(realDir, 'in.csv'), csv, 'utf8');
  await ipcMain.invoke('import:load', path.join(realDir, 'in.csv'));
  const result = await ipcMain.invoke('import:run', {
    mapping: { 0: 'inv_number', 1: 'title', 2: 'status', 3: 'description' }, options: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.added, 3, 'и трите реда трябва да влязат, не нула');

  const rows = db.prepare('SELECT title, status, description FROM books ORDER BY inv_number').all();
  assert.equal(rows[0].status, 'наличен', 'непознато състояние → статус по подразбиране');
  assert.equal(rows[0].description, 'дарение · Състояние: добро', 'оригиналната стойност не се губи');
  assert.equal(rows[1].status, 'наличен');
  assert.equal(rows[1].description, 'Състояние: скъсана корица');
  assert.equal(rows[2].status, 'липсващ', 'познат статус се приема както преди');
  assert.equal(rows[2].description, null);
});
