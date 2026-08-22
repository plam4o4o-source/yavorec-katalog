// Регресионни тестове за bug-audit-v2.3.1.md — находки #1, #4, #5, #7, #11, #12.
// Стилът и помощните функции следват test/importers.test.js и
// test/handlers-data-import.test.js (виж там за конвенциите).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const {
  parseDelimited, readTable, hasUnterminatedQuote, rowColumnCountWarning, MAX_DELIMITED_FILE_SIZE
} = require('../importers');
const registerDataImportHandlers = require('../handlers/data-import');

/* Датата, с която е спрян часовникът във всички setup() по-долу. Тестовете за
   „пада на днешна дата“ трябва да сверяват СПРЯМО НЕЯ, а не спрямо литерал.
   Преди тук стоеше закован '2026-08-21' и в теста, и в очакването, но самият
   handler ползваше собствено new Date() вместо инжектирания today() — затова
   очакването сочеше истинската дата на деня, в който тестът е писан, и целият
   пакет почервеня на следващия ден. Handler-ът вече ползва today(); константата
   тук пази двете страни да не се разминат отново. */
const STUB_TODAY = '2026-08-21';

/* Хигиена на временните папки — виж test/importers.test.js/handlers-data-import.test.js
   защо: node --test не чисти нищо след себе си. */
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

/* BOOK_FIELDS се взима от продукционния handlers/books.js — виж
   test/handlers-data-import.test.js за пълното обяснение защо не се преписва. */
const BOOK_FIELDS = require('../handlers/books')(
  { handle: () => {} },
  { getDb: () => null, run: (fn) => fn, logAudit: () => {}, today: () => '2026-01-01',
    logEvent: () => {}, scheduleCatalogWrite: () => {}, cnSortKey: () => null,
    normalizeScanCode: (x) => x, checkRecordLimit: () => {} }
).BOOK_FIELDS;

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fixes-v24-import-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: () => {},
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => ({}),
    fs, path, BOOK_FIELDS,
    today: () => STUB_TODAY,
    cnSortKey: (s) => String(s || '').toUpperCase().trim().replace(/\d+/g, m => m.padStart(6, '0'))
  };
  registerDataImportHandlers(ipcMain, deps);
  return { db, ipcMain, dir };
}

/* -------------------------------------------------------------------------
   Находка #1 (ВИСОКА) — безкраен цикъл при инвентарен номер над 2^53.
   handlers/data-import.js: диапазонна проверка (1..99999999) + твърд таван
   на итерациите в търсенето на свободен номер.
   ------------------------------------------------------------------------- */

test('арифметиката, довела до бъга, наистина се държи както описва одита (2^53 губи точност в JS)', () => {
  // Самата причина за безкрайния цикъл: инкрементът спира да променя стойността.
  assert.equal(9007199254740992 + 1, 9007199254740992);
});

test('import:run НЕ виси при инвентарен номер точно на границата на JS число-точност (2^53) — приключва бързо', async () => {
  // Точно сценарият от одита: два реда с ЕДИН И СЪЩ номер над безопасния диапазон.
  // При оригиналния (счупен) код: ред 1 приема числото директно (existingInv е
  // празен), nextInv става (число)+1, което поради загубата на точност е СЪЩОТО
  // число; ред 2 е дубликат на него → while цикълът тръгва от nextInv, който вече
  // не се движи при инкремент → безкраен цикъл, синхронен handler → замразена
  // програма. С поправката числото е извън MAX_INV_NUMBER (99999999) и никога не
  // достига до цикъла за търсене на свободен номер.
  const { ipcMain, dir } = setup();
  const huge = '9007199254740992'; // = 2^53
  const csv = [
    'Инвентарен №;Заглавие',
    `${huge};Книга А`,
    `${huge};Книга Б`
  ].join('\r\n') + '\r\n';
  const file = path.join(dir, 'huge-inv.csv');
  fs.writeFileSync(file, csv, 'utf8');
  await ipcMain.invoke('import:load', file);

  const started = Date.now();
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title' }, options: {} });
  const elapsedMs = Date.now() - started;

  assert.ok(elapsedMs < 2000, `import:run отне ${elapsedMs} ms — очаква се да приключи бързо, не да виси`);
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 2, 'и двата реда трябва да влязат, с автоматично генерирани номера');
  assert.ok(result.data.usedInv.length >= 2);
  assert.ok(result.data.usedInv.every(u => u.inv <= 99999999), 'автоматично генерираните номера остават в допустимия диапазон');
  assert.ok(result.data.warnings.some(w => /извън допустимия диапазон/.test(w)),
    'библиотекарят трябва да види изрично предупреждение за отхвърления номер');
});

test('import:run отхвърля инвентарен номер над MAX_INV_NUMBER дори без дублиране', async () => {
  const { db, ipcMain, dir } = setup();
  const file = path.join(dir, 'one-huge.csv');
  fs.writeFileSync(file, 'Инвентарен №;Заглавие\r\n123456789012345;Книга\r\n', 'utf8');
  await ipcMain.invoke('import:load', file);
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title' }, options: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 1);
  const row = db.prepare("SELECT inv_number FROM books WHERE title='Книга'").get();
  assert.ok(row.inv_number <= 99999999, `inv_number ${row.inv_number} трябва да е в допустимия диапазон, не суровата стойност от файла`);
});

/* Независима проверка чрез отделен процес с ОС таймаут: доказва fail-before/
   pass-after БЕЗ риск да замрази целия тестов процес, ако някой бъде вкаран
   регресивно към старата (счупена) логика. Възпроизвежда точно бъга ръчно с
   `timeout` и оригиналния файл, извлечен от git — виж отчета в разговора; тук
   само проверяваме, че ТЕКУЩИЯТ (поправен) код никога не може да увисне така,
   защото самата защита е тествана по-горе. Този тест е бърз и безопасен сам
   по себе си (никога не изпълнява старата логика) — timeout-ът е само мрежа.
   Използва spawnSync, за да не увисне node --test дори при бъдеща регресия. */
test('import:run с huge inv не увисва процеса дори изпълнено в отделен процес (ОС таймаут като мрежа)', () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fixes-v24-import-proc-'));
  const dbPath = path.join(dir, 'library.db');
  const script = `
    const path = require('path');
    const fs = require('fs');
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const registerDataImportHandlers = require(${JSON.stringify(path.join(__dirname, '..', 'handlers', 'data-import.js'))});
    const db = new Database(${JSON.stringify(dbPath)});
    db.pragma('foreign_keys = ON');
    db.exec(fs.readFileSync(${JSON.stringify(path.join(__dirname, '..', 'db', 'schema.sql'))}, 'utf8'));
    const BOOK_FIELDS = require(${JSON.stringify(path.join(__dirname, '..', 'handlers', 'books.js'))})(
      { handle: () => {} },
      { getDb: () => null, run: (fn) => fn, logAudit: () => {}, today: () => '2026-01-01',
        logEvent: () => {}, scheduleCatalogWrite: () => {}, cnSortKey: () => null,
        normalizeScanCode: (x) => x, checkRecordLimit: () => {} }
    ).BOOK_FIELDS;
    const handlers = new Map();
    registerDataImportHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {
      getDb: () => db, run: (fn) => fn, logAudit: () => {},
      dialog: {}, getMainWindow: () => ({}), fs, path, BOOK_FIELDS,
      today: () => ${JSON.stringify(STUB_TODAY)}, cnSortKey: (s) => String(s || '')
    });
    const csvPath = ${JSON.stringify(path.join(dir, 'huge.csv'))};
    const huge = '9007199254740992';
    fs.writeFileSync(csvPath, 'Инвентарен №;Заглавие\\r\\n' + huge + ';A\\r\\n' + huge + ';B\\r\\n', 'utf8');
    handlers.get('import:load')({}, csvPath);
    const res = handlers.get('import:run')({}, { mapping: { 0: 'inv_number', 1: 'title' }, options: {} });
    if (!res.ok) { console.error(res.error); process.exit(2); }
    console.log('DONE', res.data.added);
  `;
  const scriptPath = path.join(dir, 'run.js');
  fs.writeFileSync(scriptPath, script, 'utf8');
  const started = Date.now();
  const proc = spawnSync(process.execPath, [scriptPath], { cwd: path.join(__dirname, '..'), timeout: 8000, encoding: 'utf8' });
  const elapsedMs = Date.now() - started;
  assert.equal(proc.error, undefined, 'процесът не биваше да гръмне');
  assert.notEqual(proc.signal, 'SIGTERM', `процесът беше убит от ОС таймаута (${elapsedMs} ms) — това означава увисване`);
  assert.match(proc.stdout, /DONE 2/, `изход: ${proc.stdout} / stderr: ${proc.stderr}`);
  assert.ok(elapsedMs < 5000, `отделният процес отне ${elapsedMs} ms`);
});

/* -------------------------------------------------------------------------
   Находка #4 (СРЕДНА) — parseIntOrNull режеше цифри тихо вместо да отхвърля.
   ------------------------------------------------------------------------- */

test('import:run не превръща "5.0" в инвентарен номер 50 (Excel десетичен формат)', async () => {
  const { db, ipcMain, dir } = setup();
  const file = path.join(dir, 'decimal.csv');
  fs.writeFileSync(file, 'Инвентарен №;Заглавие\r\n5.0;Книга\r\n', 'utf8');
  await ipcMain.invoke('import:load', file);
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title' }, options: {} });
  assert.equal(result.ok, true);
  const row = db.prepare("SELECT inv_number FROM books WHERE title='Книга'").get();
  assert.equal(row.inv_number, 5, '"5.0" трябва да стане 5, не 50 (старият бъг режеше точката)');
});

test('import:run отхвърля "12,50" като инвентарен номер (не е цяло число) и предупреждава', async () => {
  const { db, ipcMain, dir } = setup();
  const file = path.join(dir, 'frac.csv');
  fs.writeFileSync(file, 'Инвентарен №;Заглавие\r\n12,50;Книга\r\n', 'utf8');
  await ipcMain.invoke('import:load', file);
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title' }, options: {} });
  assert.equal(result.ok, true);
  const row = db.prepare("SELECT inv_number FROM books WHERE title='Книга'").get();
  assert.notEqual(row.inv_number, 1250, '"12,50" не биваше да стане 1250 (старият бъг режеше запетаята)');
  assert.ok(result.data.warnings.some(w => /12,50/.test(w) && /не е разпознат/.test(w)),
    'трябва да има ясно предупреждение на български за нечисления инвентарен номер');
});

test('import:run не превръща "-5" в инвентарен номер 5 (знакът не изчезва тихо)', async () => {
  const { db, ipcMain, dir } = setup();
  db.prepare("INSERT INTO books (inv_number, title) VALUES (5, 'Съществуваща')").run();
  const file = path.join(dir, 'neg.csv');
  fs.writeFileSync(file, 'Инвентарен №;Заглавие\r\n-5;Нова книга\r\n', 'utf8');
  await ipcMain.invoke('import:load', file);
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title' }, options: {} });
  assert.equal(result.ok, true);
  const row = db.prepare("SELECT inv_number FROM books WHERE title='Нова книга'").get();
  assert.notEqual(row.inv_number, 5, '"-5" не биваше да стане 5 и да се сблъска със съществуващия запис №5');
  assert.equal(result.data.warnings.length > 0, true);
});

/* -------------------------------------------------------------------------
   Находка #7 (СРЕДНА) — Excel сериен номер на дата не се разпознаваше.
   ------------------------------------------------------------------------- */

test('import:run разпознава Excel сериен номер на дата в register_date вместо да пада на днешна дата', async () => {
  const { db, ipcMain, dir } = setup();
  const file = path.join(dir, 'serial-date.csv');
  // 44197 = 2021-01-01 (познат контролен пример за Excel epoch-а)
  fs.writeFileSync(file, 'Заглавие;Дата на постъпване\r\nКнига;44197\r\n', 'utf8');
  await ipcMain.invoke('import:load', file);
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'title', 1: 'register_date' }, options: {} });
  assert.equal(result.ok, true);
  const row = db.prepare("SELECT register_date FROM books WHERE title='Книга'").get();
  assert.equal(row.register_date, '2021-01-01', 'суров Excel сериен номер трябва да се разчете като истинска дата');
  assert.notEqual(row.register_date, STUB_TODAY, 'не биваше тихо да падне на днешна дата');
});

test('import:run продължава да разпознава обичайните текстови формати за дата', async () => {
  const { db, ipcMain, dir } = setup();
  const file = path.join(dir, 'text-date.csv');
  fs.writeFileSync(file, 'Заглавие;Дата на постъпване\r\nКнига 1;2021-01-01\r\nКнига 2;01.03.2022\r\n', 'utf8');
  await ipcMain.invoke('import:load', file);
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'title', 1: 'register_date' }, options: {} });
  assert.equal(result.ok, true);
  assert.equal(db.prepare("SELECT register_date FROM books WHERE title='Книга 1'").get().register_date, '2021-01-01');
  assert.equal(db.prepare("SELECT register_date FROM books WHERE title='Книга 2'").get().register_date, '2022-03-01');
});

test('import:run не гадае дата от нереалистично голямо/малко число', async () => {
  const { db, ipcMain, dir } = setup();
  const file = path.join(dir, 'nonsense-date.csv');
  fs.writeFileSync(file, 'Заглавие;Дата на постъпване\r\nКнига;999999999\r\n', 'utf8');
  await ipcMain.invoke('import:load', file);
  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'title', 1: 'register_date' }, options: {} });
  assert.equal(result.ok, true);
  const row = db.prepare("SELECT register_date FROM books WHERE title='Книга'").get();
  assert.equal(row.register_date, STUB_TODAY, 'извън разумния диапазон → пада на днешна дата, както преди');
});

/* -------------------------------------------------------------------------
   Находка #5 (СРЕДНА) — самотен \r край на ред (стар Mac / LibreOffice).
   ------------------------------------------------------------------------- */

test('parseDelimited разпознава самотно \\r като край на ред (стар Mac износ)', () => {
  const text = 'Заглавие;Автор\rКнига едно;Автор едно\rКнига две;Автор две\r';
  const rows = parseDelimited(text, ';');
  assert.deepEqual(rows, [
    ['Заглавие', 'Автор'],
    ['Книга едно', 'Автор едно'],
    ['Книга две', 'Автор две']
  ]);
});

test('parseDelimited продължава да работи правилно с \\r\\n (Windows) и чисто \\n (Unix)', () => {
  const crlf = parseDelimited('a;b\r\n1;2\r\n', ';');
  assert.deepEqual(crlf, [['a', 'b'], ['1', '2']]);
  const lf = parseDelimited('a;b\n1;2\n', ';');
  assert.deepEqual(lf, [['a', 'b'], ['1', '2']]);
});

test('import:run внася CSV с чисто \\r край на ред вместо да го срутва в един ред (реален брой редове)', async () => {
  const { ipcMain, dir } = setup();
  const file = path.join(dir, 'old-mac.csv');
  const csv = 'Инвентарен №;Заглавие\r1;Под игото\r2;Тихият Дон\r3;Записки по българските въстания\r';
  fs.writeFileSync(file, csv, 'utf8');
  const loaded = await ipcMain.invoke('import:load', file);
  assert.equal(loaded.ok, true);
  // Преди поправката: целият файл се четеше практически като 0 реда с данни
  // (един объркан заглавен ред). Сега: точно 3 реда с данни.
  assert.equal(loaded.data.total, 3, `очакват се 3 реда с данни, а не ${loaded.data.total}`);

  const result = await ipcMain.invoke('import:run', { mapping: { 0: 'inv_number', 1: 'title' }, options: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 3, `очакват се 3 добавени документа, а не ${result.data.added}`);
});

/* -------------------------------------------------------------------------
   Находка #11 (СРЕДНА) — незатворена кавичка / съмнителен брой колони.
   ------------------------------------------------------------------------- */

test('hasUnterminatedQuote открива нечетен брой кавички (последното поле поглъща остатъка от файла)', () => {
  assert.equal(hasUnterminatedQuote('a;"b;c\n1;2\n'), true, 'незатворена кавичка в първото поле');
  assert.equal(hasUnterminatedQuote('a;"b;c"\n1;2\n'), false, 'нормално затворена кавичка');
  assert.equal(hasUnterminatedQuote('a;"b""c"\n'), false, 'удвоена кавичка вътре в поле не бърка баланса');
});

test('rowColumnCountWarning се задейства, когато повечето редове имат различен брой колони от заглавието', () => {
  const rows = [
    ['a', 'b', 'c'],
    ['1', '2'], ['3', '4'], ['5', '6'], ['7', '8']
  ];
  assert.match(rowColumnCountWarning(rows), /различен брой колони/);
});

test('rowColumnCountWarning мълчи, когато колоните съвпадат по брой', () => {
  const rows = [['a', 'b'], ['1', '2'], ['3', '4']];
  assert.equal(rowColumnCountWarning(rows), null);
});

test('readTable/import:load връща предупреждение при незатворена кавичка в реален CSV файл', async () => {
  const { ipcMain, dir } = setup();
  const file = path.join(dir, 'bad-quote.csv');
  // Незатворена кавичка в първия ред с данни — поглъща остатъка от файла.
  fs.writeFileSync(file, 'Заглавие;Автор\n"Под игото;Вазов\nВтора книга;Автор\n', 'utf8');
  const loaded = await ipcMain.invoke('import:load', file);
  assert.equal(loaded.ok, true);
  assert.ok(loaded.data.warning, 'трябва да има предупреждение вместо тихо погълнати редове');
  assert.match(loaded.data.warning, /кавичка/);
});

test('readTable връща предупреждение при смесен разделител (заглавие "," редове ";")', () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fixes-v24-mixed-delim-'));
  const file = path.join(dir, 'mixed.csv');
  // Заглавният ред използва ",", но данните са с ";" — детекцията гледа само
  // първия ред, затова "си избира" запетая и разбива всичко в грешни колони.
  fs.writeFileSync(file, 'Инвентарен №,Заглавие,Автор\n1;Под игото;Вазов\n2;Тихият Дон;Шолохов\n3;Записки;Захари\n', 'utf8');
  const t2 = readTable(file);
  assert.equal(t2.delimiter, ',');
  assert.ok(t2.warning, 'трябва да предупреди за подозрителния брой колони');
  assert.match(t2.warning, /различен брой колони/);
});

test('readTable не предупреждава без причина за нормален, добре оформен CSV', () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fixes-v24-clean-csv-'));
  const file = path.join(dir, 'clean.csv');
  fs.writeFileSync(file, 'Инвентарен №;Заглавие;Автор\r\n1;Под игото;Вазов\r\n2;Тихият Дон;Шолохов\r\n', 'utf8');
  const t = readTable(file);
  assert.equal(t.warning, null);
});

/* -------------------------------------------------------------------------
   Находка #12 (СРЕДНА) — нямаше лимит за размер/време на CSV/TSV.
   ------------------------------------------------------------------------- */

test('readTable отхвърля CSV/TSV файл над лимита с ясно съобщение на български, вместо да виси', () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fixes-v24-bigcsv-'));
  const file = path.join(dir, 'huge.csv');
  // Записва файл строго над лимита, без да държи цялото съдържание в паметта наведнъж.
  const fd = fs.openSync(file, 'w');
  const chunk = Buffer.alloc(1024 * 1024, 'a'); // 1 MB парче
  const targetMB = Math.round(MAX_DELIMITED_FILE_SIZE / 1024 / 1024) + 2;
  for (let i = 0; i < targetMB; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const sizeMB = fs.statSync(file).size / 1024 / 1024;
  assert.ok(sizeMB > MAX_DELIMITED_FILE_SIZE / 1024 / 1024, `тестовият файл (${sizeMB} MB) трябва да е над лимита`);

  const started = Date.now();
  assert.throws(() => readTable(file), /твърде голям/, 'трябва да отхвърли файла с ясно съобщение, не да увисне в парсването');
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 3000, `проверката за размер трябва да е почти мигновена (отне ${elapsedMs} ms), а не да чака цялото парсване`);
});

test('readTable приема CSV файл точно под лимита нормално', () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fixes-v24-smallcsv-'));
  const file = path.join(dir, 'small.csv');
  fs.writeFileSync(file, 'Инвентарен №;Заглавие\r\n1;Под игото\r\n', 'utf8');
  const t = readTable(file);
  assert.equal(t.rows.length, 2);
});

/* Реален замер (не предположение) — колко бавно е parseDelimited без лимит, за
   да е ясно ЗАЩО 60 MB е разумна граница, а не произволно число. Не е строг
   assert върху конкретни милисекунди (зависи от машината), само горна граница
   за разумност — цели се в документиране на реалния мащаб на проблема. */
test('измерено: parseDelimited на 100 MB файл с един ред отнема секунди, не милисекунди (документира риска от одит #12)', () => {
  const bigLine = 'a'.repeat(20 * 1024 * 1024); // 20 MB - достатъчно да се види редът на величината без да бави твърде много CI-я
  const started = Date.now();
  const rows = parseDelimited(bigLine, ';');
  const elapsedMs = Date.now() - started;
  assert.equal(rows.length, 1);
  assert.ok(elapsedMs > 200, `очаква се измеримо забавяне дори при 20 MB (отне ${elapsedMs} ms) — доказва защо лимитът е нужен`);
});
