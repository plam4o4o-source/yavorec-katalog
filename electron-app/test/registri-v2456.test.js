'use strict';
/* Одитен кръг v2.4.56 — РЕГИСТРИТЕ: КНИГАТА, ВНОСЪТ, ПЕРИОДИКАТА, ИЗГУБЕНОТО.
 * =====================================================================
 * Този кръг гледа нещата, които се вписват в официален регистър и после се
 * подават на проверяващия. Намереното се разпада на четири истории:
 *
 *  1) ИЗТРИВАНЕТО НА ДОКУМЕНТ. Второ потвърждение се искаше само когато
 *     документът е бил заеман, а следа в одита се пишеше САМО в същия случай.
 *     Тоест най-обичайното състояние — прясно инвентирана книга, която още никой
 *     не е взимал — си отиваше на един клик и без нито един ред следа. Редът в
 *     инвентарната книга е по чл. 16, ал. 1; книгата се води безсрочно (чл. 26,
 *     ал. 1), отчислените редове се ОТБЕЛЯЗВАТ, а не се заличават (чл. 39). След
 *     триене инвентарният номер остава дупка в поредицата и при проверка по
 *     чл. 17, ал. 2 няма какво да се каже за него.
 *
 *  2) ВНОСЪТ НА СТАР ФОНД. Ред без разчетена дата на вписване получаваше
 *     МЪЛЧАЛИВО днешната дата. При внос на стар опис от 4 000 книги — типичният
 *     първи ден с програмата — КДБФ обявява 4 000 постъпили ПРЕЗ ТЕКУЩАТА
 *     ГОДИНА, а изведената наличност към 01.01 се срива със същите 4 000.
 *     Библиотека, която просто е пренесла фонда си, получава регистър, твърдящ,
 *     че за една година е удвоила фонда си. Това число отива в НСИ.
 *
 *  3) ПЕРИОДИКАТА. Двете таблици за периодика бяха затворен свят: нито
 *     инвентарен номер, нито партида, нито ред в наличността. А заглавието на
 *     КДБФ Част № 1 гласи „Регистриране на постъпили книги, ПЕРИОДИЧНИ ИЗДАНИЯ
 *     и други материали“, Дневникът има готов ред „Периодични издания“, който
 *     винаги излизаше нула, и Наредба № 3 брои периодиката за библиотечни
 *     документи (чл. 13, ал. 3, т. 1; чл. 14; чл. 16). Тоест постъпленията бяха
 *     системно занижени — всяка година, завинаги.
 *
 *  4) ИЗГУБЕНИЯТ ДОКУМЕНТ. Нямаше го никъде: библиотекарката или оставяше
 *     книгата „налична“ (заемаема, в публичния каталог, с резервации), или я
 *     маркираше „липсващ“ — а „липсващ“ в тази програма значи „не е намерена при
 *     инвентаризация“, което води до ДРУГА точка на чл. 30 при отчисляване
 *     (т. 6 вместо т. 5), тоест до акт на грешно основание.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  APP_DIR, freshDb, fakeIpcMain, runDep, cleanupTmpDirs, buildDom, settle, printed
} = require('./helpers/audit-fixtures');
const { BOOK_SELECT, BOOK_FIELDS, normalizeScanCode, yearOf, diffFields } = require('./helpers/prod-values');

const INV_BOOK_VIEW = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'inv-book.js'), 'utf8');
const IMPORT_VIEW = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'data-import.js'), 'utf8');

test.after(cleanupTmpDirs);

const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };
const cnSortKey = (s) => String(s || '').toUpperCase().trim().replace(/\d+/g, m => m.padStart(6, '0'));

/* Обща фикстура: истински модули върху истинска схема. Кой модул се регистрира
   се решава от списъка — така всеки тест работи с точно толкова от програмата,
   колкото описва, но винаги с ИСТИНСКИЯ код, не с двойник. */
function setup(modules) {
  const { db, dir } = freshDb('inv-registri-v2456-');
  const audit = [];
  const events = [];
  const catalogWrites = [];
  const deps = {
    getDb: () => db, run: runDep,
    logAudit: (a, d, diff) => audit.push({ action: a, detail: d, diff }),
    today: () => '2026-08-04', yearOf,
    BOOK_SELECT, BOOK_FIELDS, LOAN_SELECT: null,
    ftsQuery: require(path.join(APP_DIR, 'search-fts')).ftsQuery,
    cnSortKey, diffFields, normalizeScanCode,
    scheduleCatalogWrite: () => catalogWrites.push(1),
    flushCatalogWrite: () => ({ written: true }),
    logEvent: (kind, opts) => events.push({ kind, opts }),
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 1, suspend_max: 90 }),
    readerCategory: () => 'възрастен',
    nextWorkDay: (d) => d, closedDaysBetween: () => 0,
    firstActiveHold: () => null, consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null,
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: (rows) => ({ hours: rows.length }),
    fs, path, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => ({}),
    checkRecordLimit: () => {}
  };
  const ipcMain = fakeIpcMain();
  for (const m of modules) {
    const ret = require(path.join(APP_DIR, 'handlers', m))(ipcMain, deps);
    // LOAN_SELECT се ражда при регистрацията на handlers/loans.js — точно както в
    // main.js, където следващите модули го получават по стойност.
    if (ret && ret.LOAN_SELECT) deps.LOAN_SELECT = ret.LOAN_SELECT;
  }
  return { db, dir, ipcMain, audit, events, catalogWrites, deps };
}

function addBook(db, o) {
  const b = Object.assign({ inv_number: 1, title: 'Книга', price: 10, register_date: '2026-02-01', status: 'наличен' }, o);
  const id = db.prepare(`INSERT INTO books (inv_number, title, price, register_date, status, status_date)
    VALUES (?, ?, ?, ?, ?, ?)`).run(b.inv_number, b.title, b.price, b.register_date, b.status, b.register_date).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
  return id;
}
function addReader(db, name) {
  return db.prepare("INSERT INTO readers (name, card_no, status, category) VALUES (?, ?, 'активен', 'възрастен')")
    .run(name, 'К' + Math.floor(Math.random() * 1e6)).lastInsertRowid;
}

/* ==================================================================
   1. ИЗТРИВАНЕТО НА ВПИСАН ДОКУМЕНТ
   ================================================================== */

test('изтриването на документ оставя следа ВИНАГИ — и когато документът никога не е бил заеман', () => {
  /* Дотук следа се пишеше само при документ с история на заеманията. Прясно
     инвентирана книга изчезваше от програмата без нито ред: нито в книгата, нито
     в одита, а инвентарният ѝ номер оставаше прескочен. Проверката по чл. 17,
     ал. 2 иска отговор какво е станало с всеки номер — програмата нямаше как да
     го даде. Следата носи трите неща, които после трябват: номерът, заглавието и
     дали изобщо е имало заемания. */
  const t = setup(['books']);
  const id = addBook(t.db, { inv_number: 500, title: 'Под игото' });
  // Първото натискане отказва (виж следващия тест) — второто изтрива.
  assert.equal(t.ipcMain.invoke('books:delete', id).ok, false);
  t.audit.length = 0;
  ok(t.ipcMain.invoke('books:delete', id), 'изтриване');

  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM books WHERE id = ?').get(id).n, 0);
  assert.equal(t.audit.length, 1, 'следа има и без нито едно заемане');
  assert.equal(t.audit[0].action, 'Изтрит документ');
  assert.match(t.audit[0].detail, /инв\. № 500/, 'номерът — за да може да се обясни дупката в поредицата');
  assert.match(t.audit[0].detail, /Под игото/, 'и заглавието');
  assert.match(t.audit[0].detail, /без нито едно заемане/);
});

test('вписаният документ иска второ потвърждение, а съобщението сочи нормалния път — акт за отчисляване', () => {
  /* Второто натискане се искаше САМО при документ със заемания. Вписаният ред е
     ред в официален регистър: от фонда се излиза с акт (чл. 30 – 35), а редът
     остава отбелязан, не заличен (чл. 39). */
  const t = setup(['books']);
  const id = addBook(t.db, { inv_number: 501, title: 'Тютюн' });
  const first = t.ipcMain.invoke('books:delete', id);
  assert.equal(first.ok, false, 'един клик не стига');
  assert.match(first.error, /ВПИСАН в инвентарната книга/);
  assert.match(first.error, /акт за отчисляване/, 'казва се кой е нормалният път');
  assert.match(first.error, /още веднъж/, 'и как се потвърждава, ако записът наистина е сгрешен');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM books WHERE id = ?').get(id).n, 1,
    'след първия отказ документът е на мястото си');
  ok(t.ipcMain.invoke('books:delete', id), 'второ натискане');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM books WHERE id = ?').get(id).n, 0);
});

test('документът с история пита ВЕДНЪЖ, а не два пъти — по-тежката причина се показва', () => {
  /* Ако документът е и вписан, и с история, потвърждението е ЕДНО: иначе
     библиотекарят би натискал „Изтрий“ четири пъти и всяко следващо съобщение би
     приличало на повреда в програмата. */
  const t = setup(['books']);
  const id = addBook(t.db, { inv_number: 502, title: 'Железният светилник' });
  const readerId = addReader(t.db, 'Читател');
  t.db.prepare("INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, '2026-01-01', '2026-01-15', '2026-01-10')")
    .run(id, readerId);

  const first = t.ipcMain.invoke('books:delete', id);
  assert.equal(first.ok, false);
  assert.match(first.error, /1 записа в историята|записа в историята/, 'показва се по-тежката причина');
  t.audit.length = 0;
  ok(t.ipcMain.invoke('books:delete', id), 'второ натискане');
  assert.equal(t.audit.length, 1, 'едно потвърждение, едно изтриване');
  assert.equal(t.audit[0].action, 'Изтрит документ с история',
    'двете имена се пазят различни, за да се търсят различно в одитната следа');
  assert.match(t.audit[0].detail, /инв\. № 502/);
  assert.match(t.audit[0].detail, /1 запис в историята/);
});

test('отчисленият с акт документ не се изтрива изобщо — чл. 39 е безусловен', () => {
  const t = setup(['books']);
  const id = addBook(t.db, { inv_number: 503, status: 'отчислен' });
  const res = t.ipcMain.invoke('books:delete', id);
  assert.equal(res.ok, false);
  assert.match(res.error, /чл\. 39/);
  // И второ натискане не помага: това не е потвърждение, а забрана.
  assert.equal(t.ipcMain.invoke('books:delete', id).ok, false);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM books WHERE id = ?').get(id).n, 1);
});

/* ==================================================================
   2. ВНОСЪТ НА СТАР ФОНД
   ================================================================== */

function loadCsv(t, csv) {
  const p = path.join(t.dir, 'opis.csv');
  fs.writeFileSync(p, csv, 'utf8');
  return ok(t.ipcMain.invoke('import:load', p), 'четене на файла');
}

test('вносът БРОИ редовете, на които датата на вписване е сложена от програмата, и обяснява какво значи това за КДБФ', () => {
  /* Числото е същината: без него библиотекарят няма откъде да разбере, че нещо
     е било решено вместо него. А решеното е точно онова, което после отива в
     годишния отчет — 4 000 документа, обявени за постъпили тази година. */
  const t = setup(['data-import']);
  loadCsv(t, 'Инвентарен №;Заглавие;Дата на вписване\r\n1;Под игото;2015-03-04\r\n2;Тютюн;\r\n3;Тихият Дон;\r\n');
  const r = ok(t.ipcMain.invoke('import:run', {
    mapping: { 0: 'inv_number', 1: 'title', 2: 'register_date' }, options: {}
  }), 'внос');

  assert.equal(r.added, 3);
  assert.equal(r.registerDateDefaulted, 2, 'два реда са получили дата от програмата');
  assert.equal(r.registerDateDefault, null, 'без посочена дата за стар фонд');
  const dates = t.db.prepare('SELECT inv_number, register_date FROM books ORDER BY inv_number').all();
  assert.equal(dates[0].register_date, '2015-03-04', 'разчетената дата се пази');
  assert.equal(dates[1].register_date, '2026-08-04', 'останалите падат към днешната');
  assert.equal(dates[2].register_date, '2026-08-04');

  const warn = r.warnings.join(' ');
  assert.match(warn, /2 реда нямат дата на вписване/);
  assert.match(warn, /Книга за движение на библиотечния фонд/, 'казва се КЪДЕ ще излезе разликата');
  assert.match(warn, /наличност(та)? към 01\.01/, 'и кое точно число ще е грешно');
  // И в одитната следа: тя е единственото място, от което после може да се
  // обясни защо еди-колко си документа са вписани с една и съща дата.
  assert.match(t.audit[0].detail, /датата на вписване е сложена от програмата/);
  assert.match(t.audit[0].detail, /днешна дата: 2026-08-04/);
});

test('посочената дата за ретро-фонд се прилага и не е предупреждение, а потвърждение', () => {
  const t = setup(['data-import']);
  loadCsv(t, 'Инвентарен №;Заглавие\r\n1;Под игото\r\n2;Тютюн\r\n');
  const r = ok(t.ipcMain.invoke('import:run', {
    mapping: { 0: 'inv_number', 1: 'title' }, options: { defaultRegisterDate: '01.01.2015' }
  }), 'внос');

  assert.equal(r.registerDateDefaulted, 2);
  assert.equal(r.registerDateDefault, '2015-01-01', 'датата се разчита и в български формат');
  const dates = t.db.prepare('SELECT register_date FROM books').all().map(x => x.register_date);
  assert.deepEqual(dates, ['2015-01-01', '2015-01-01']);
  assert.deepEqual(r.warnings, [], 'посочената дата не е повод за предупреждение');
  assert.match(t.audit[0].detail, /посочена за стар фонд: 2015-01-01/);
});

test('сгрешена или бъдеща дата за ретро-фонд спира вноса ПРЕДИ да е влязъл един ред', () => {
  /* Сгрешена дата, влязла в 4 000 реда, се вади после един по един. Затова
     форматът се проверява преди транзакцията. Бъдещата дата е същият дефект в
     другата посока: инвентарната книга не приема вписване с бъдеща дата. */
  const t = setup(['data-import']);
  loadCsv(t, 'Инвентарен №;Заглавие\r\n1;Под игото\r\n');

  const bad = t.ipcMain.invoke('import:run', {
    mapping: { 0: 'inv_number', 1: 'title' }, options: { defaultRegisterDate: 'миналата година' }
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /не се разчита/);

  const future = t.ipcMain.invoke('import:run', {
    mapping: { 0: 'inv_number', 1: 'title' }, options: { defaultRegisterDate: '2030-01-01' }
  });
  assert.equal(future.ok, false);
  assert.match(future.error, /в бъдещето/);

  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 0, 'нито един ред не е влязъл');
});

test('екранът за внос пита за датата на стария фонд ПРЕДИ вноса, не след него', () => {
  /* Полето трябва да стои във формата за съответствие на колоните: след вноса
     поправката е 4 000 реда в „Редакция“. */
  assert.match(IMPORT_VIEW, /'Дата на вписване по подразбиране', 'defaultRegisterDate'/,
    'полето съществува във формата');
  assert.match(IMPORT_VIEW, /тези редове получават днешната дата/,
    'и казва какво става, ако остане празно');
  assert.match(IMPORT_VIEW, /r\.registerDateDefaulted/, 'отчетът след вноса показва числото');
});

/* ==================================================================
   3. ИНВЕНТАРНАТА КНИГА
   ================================================================== */

test('инвентарната книга брои документите без дата на вписване и казва защо не се връзва с КДБФ', () => {
  /* Инвентарната книга смята фонда по СЪСТОЯНИЕТО (всичко неотчислено), а КДБФ —
     по ДАТИТЕ. Документ без дата на вписване влиза в първото число и изпада от
     второто. Дотук КДБФ го обявяваше, а инвентарната книга мълчеше: библиотекар,
     който сравнява двата екрана преди годишния отчет, виждаше две различни числа
     за един и същ фонд без нито дума защо. */
  const t = setup(['inv-book']);
  addBook(t.db, { inv_number: 601, register_date: '2026-01-05' });
  addBook(t.db, { inv_number: 602, register_date: null });
  addBook(t.db, { inv_number: 603, register_date: '' });
  addBook(t.db, { inv_number: 604, register_date: null, status: 'отчислен' });

  const page = ok(t.ipcMain.invoke('invBook:list', { offset: 0, limit: 50 }), 'прозорец');
  assert.equal(page.summary.activeCopies, 3, 'фондът тук се брои по състоянието');
  assert.equal(page.summary.undatedRows, 2,
    'броят се само НЕотчислените без дата — за отчислените датата вече не мести нито един сбор');
  assert.equal(page.summary.undatedCopies, 2);
  // Текстът на бележката е един и същ на екрана и на разпечатката.
  assert.match(INV_BOOK_VIEW, /function invBookUndatedNote/);
  assert.match(INV_BOOK_VIEW, /Книга за движение на библиотечния фонд/);
});

test('печатът на инвентарната книга подбира диапазон — по номер, по период и по търсенето на екрана', () => {
  /* При фонд от 15 000 документа безусловният печат е стотици листа, а най-често
     трябват 200-те реда от последната партида или редовете за една година, които
     се прошнуроват и заверяват (чл. 26, ал. 2). Празно поле не ограничава нищо:
     „от 1 до празно“ значи „от 1 нататък“, не „нищо“. */
  const dom = buildDom({});
  const { window } = dom;
  const rows = [
    { inv_number: 1, register_date: '2015-01-01', author: 'Вазов', title: 'Под игото' },
    { inv_number: 5, register_date: '2026-02-01', author: 'Димов', title: 'Тютюн' },
    { inv_number: 9, register_date: '2026-07-01', author: 'Талев', title: 'Железният светилник' },
    { inv_number: null, register_date: null, author: '', title: 'Без номер' }
  ];
  const sel = (range) => window.invBookSelectRange(rows, range);

  assert.equal(sel(undefined).rows.length, 4, 'без диапазон се печата цялата книга');
  assert.equal(sel(undefined).limited, false);

  const byNo = sel({ from: '5', to: '9' });
  assert.deepEqual(byNo.rows.map(r => r.inv_number), [5, 9]);
  assert.match(byNo.label, /инв\. № 5 – 9/, 'разпечатката НОСИ означението какъв диапазон е — иначе '
    + 'прошнурован лист с 200 реда е неотличим от фалшива „цяла“ инвентарна книга');

  assert.deepEqual(sel({ from: '5' }).rows.map(r => r.inv_number), [5, 9], 'празното „до“ не отрязва нищо');
  assert.deepEqual(sel({ to: '5' }).rows.map(r => r.inv_number), [1, 5]);

  const byDate = sel({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });
  assert.deepEqual(byDate.rows.map(r => r.inv_number), [5, 9]);
  assert.match(byDate.label, /вписани от/);

  const byText = sel({ q: 'Тютюн' });
  assert.deepEqual(byText.rows.map(r => r.inv_number), [5]);

  // Ред без номер не попада в числов диапазон, а ред без дата — в никакъв период.
  assert.equal(sel({ from: '1', to: '9999' }).rows.some(r => r.inv_number == null), false);
  assert.equal(sel({ dateFrom: '2000-01-01' }).rows.some(r => !r.register_date), false);

  // И самият избор е достъпен от екрана, а не само като функция.
  assert.match(INV_BOOK_VIEW, /invBookPrintDialog/);
  assert.match(INV_BOOK_VIEW, /Цялата книга/, '„цялата книга“ остава на едно натискане');
});

/* ==================================================================
   4. ЧИТАТЕЛСКИЯТ КАРТОН
   ================================================================== */

test('читателският картон носи декларацията, под която стои подписът, и датата на съгласието', async () => {
  /* Дотук картонът свършваше направо с „Подпис на читателя: ………“, а в целия
     документ нямаше нито едно изречение, под което този подпис да стои. Двете
     неща, които той трябва да удостоверява, липсваха изобщо: запознаването с
     Правилата за обслужване (чл. 47, ал. 2) и съгласието за обработване на
     лични данни. При проверка доказателството е ХАРТИЯТА с подписа — записът в
     програмата е само вътрешно твърдение на самата библиотека. */
  const reader = {
    id: 1, name: 'Иванова, Мария', card_no: '000123', category: 'възрастен',
    status: 'активен', gdpr_consent: 1, gdpr_consent_date: '2026-03-17'
  };
  const dom = buildDom({ 'readers.get': reader, 'loans.byReader': [], 'settings.get': { org: 'НЧ Тест', librarian: 'Петрова' } });
  const { window } = dom;
  await settle();
  await window.printReaderCard(1);
  await settle();
  const t = printed(window);

  assert.match(t, /ДЕКЛАРАЦИЯ НА ЧИТАТЕЛЯ/);
  assert.match(t, /Правилата за обслужване на читателите/, 'чл. 47, ал. 2');
  assert.match(t, /чл\. 47, ал\. 2/);
  assert.match(t, /съгласието си библиотеката да обработва личните ми данни/);
  assert.match(t, /2016\/679/, 'и на кое основание');
  assert.match(t, /17\.03\.2026/, 'датата на съгласието се печата, когато я има');
  assert.match(t, /Подпис на читателя/);
  assert.match(t, /Дата: …/, 'и ред за дата — подписът без дата не установява кога е даден');
});

test('когато съгласие не е отбелязано, картонът го КАЗВА, вместо да остави празно място', async () => {
  /* Празнотата се чете като пропуск на библиотекаря; тук тя значи друго —
     съгласието не е вписано в програмата и подписът с датата отдолу е това,
     което го установява. */
  const dom = buildDom({
    'readers.get': { id: 2, name: 'Петров, Иван', card_no: '000124', status: 'активен' },
    'loans.byReader': [], 'settings.get': { org: 'НЧ Тест' }
  });
  const { window } = dom;
  await settle();
  await window.printReaderCard(2);
  await settle();
  const t = printed(window);
  assert.match(t, /няма отбелязано съгласие за обработване на лични данни/);
  assert.match(t, /подписът и датата по-долу са документът за него/);
});

/* ==================================================================
   5. ПЕРИОДИКАТА ВЛИЗА ВЪВ ФОНДА
   ================================================================== */

function addPeriodical(db, title) {
  return db.prepare("INSERT INTO periodicals (title, freq, department) VALUES (?, 'седмично', 'периодика')")
    .run(title).lastInsertRowid;
}

test('инвентирането на годишен комплект създава ред в инвентарната книга с инвентарен номер от общата поредица', () => {
  /* Броевете за една година се подвързват и се водят като ЕДИН библиотечен
     документ — така го брои и статистиката. Обратното (52 номера за годишен
     абонамент за седмичник) би надуло фонда и би направило инвентаризацията
     невъзможна: 52 „екземпляра“, които физически са една книга на рафта.
     Номерът е от СЪЩАТА поредица като книгите — инвентарната книга е една и
     номерацията ѝ е непрекъсната (чл. 16, ал. 2). */
  const t = setup(['periodicals']);
  const pid = addPeriodical(t.db, 'Труд');
  t.db.prepare("INSERT INTO periodical_issues (periodical_id, issue_no, date, price) VALUES (?, '1', '2024-01-05', 2.50)").run(pid);
  t.db.prepare("INSERT INTO periodical_issues (periodical_id, issue_no, date, price) VALUES (?, '2', '2024-01-12', 2.50)").run(pid);
  // Книгите вече са стигнали до № 100 — комплектът взима следващия свободен.
  t.db.prepare('UPDATE settings SET next_inv_number = 100 WHERE id = 1').run();

  const out = ok(t.ipcMain.invoke('periodicalVolumes:register', {
    periodical_id: pid, year: '2024', register_date: '2025-01-10'
  }), 'инвентиране');

  assert.equal(out.inv_number, 100);
  assert.equal(out.issue_count, 2);
  assert.equal(out.price, 5, 'празната цена = сборът на вписаните броеве');

  const b = t.db.prepare('SELECT * FROM books WHERE id = ?').get(out.book_id);
  assert.equal(b.inv_number, 100);
  assert.equal(b.title, 'Труд, 2024', 'така го изписва инвентарната книга и така го търси библиотекарят');
  assert.equal(b.volume, 'годишен комплект', 'вижда се, че редът не е една книга');
  assert.equal(b.register_date, '2025-01-10');
  assert.equal(b.status, 'наличен');
  assert.equal(b.price, 5);
  const cat = t.db.prepare('SELECT name FROM categories WHERE id = ?').get(b.category_id);
  assert.equal(cat.name, 'продължаващо издание',
    'видът е този, който Дневникът, Раздел Б, преобразува в ред „Периодични издания“');
  assert.equal(t.db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(out.book_id).quantity, 1,
    'един инвентарен номер = един екземпляр');
  assert.equal(t.db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get().next_inv_number, 101,
    'поредицата продължава нататък');
  assert.match(t.audit.map(a => a.detail).join(' '), /инв\. № 100 — „Труд, 2024“/);
  assert.equal(t.catalogWrites.length, 1, 'новият документ се появява и в публичния онлайн каталог');
});

test('инвентираният комплект влиза в КДБФ Част № 1 през своята партида', () => {
  /* Заглавието на Част № 1 обещава „книги, ПЕРИОДИЧНИ ИЗДАНИЯ и други материали“,
     а дотук в него нямаше нито един ред периодика: абонаментът беше постъпление,
     което регистърът не виждаше. */
  const t = setup(['periodicals', 'acquisitions', 'kdbf']);
  const acqId = ok(t.ipcMain.invoke('acquisitions:create', {
    no: 3, year: '2025', date: '2025-01-10', how: 'закупуване', from_source: 'Български пощи',
    doc_type: 'фактура', doc_no: 'А-12', doc_date: '2024-12-20', total_count: 1, sum: 120
  }), 'партида');
  const pid = addPeriodical(t.db, 'Труд');
  const out = ok(t.ipcMain.invoke('periodicalVolumes:register', {
    periodical_id: pid, year: '2024', price: 120, register_date: '2025-01-10', acquisition_id: acqId
  }), 'инвентиране');

  const r = ok(t.ipcMain.invoke('kdbf:report', '2025'), 'КДБФ');
  assert.equal(r.part1.length, 1, 'партидата е в Част № 1');
  assert.equal(r.part1[0].registered_count, 1, 'и носи инвентирания комплект');
  assert.equal(r.part1[0].registered_value, 120);
  assert.equal(r.part1[0].inv_from, out.inv_number);
  assert.equal(r.acquiredYear.n, 1, 'Част № 2 го брои като постъпление за годината на вписване');
  assert.equal(r.acquiredYear.v, 120);
  const byKind = Object.fromEntries(r.byKind.map(k => [k.kind, k.n]));
  assert.equal(byKind['продължаващо издание'], 1, 'и разбивката по видове го показва като периодика');
});

test('повторно инвентиране на същата година се отказва и казва какво да се направи вместо това', () => {
  /* Един комплект се вписва в инвентарната книга ВЕДНЪЖ. Правилото стои на две
     места — тук с обяснение, и в самата база с UNIQUE(periodical_id, year), за
     да държи и когато две работни места пишат едновременно в обща мрежова база. */
  const t = setup(['periodicals']);
  const pid = addPeriodical(t.db, 'Труд');
  const first = ok(t.ipcMain.invoke('periodicalVolumes:register', {
    periodical_id: pid, year: '2024', price: 100, register_date: '2025-01-10'
  }), 'първо инвентиране');

  const again = t.ipcMain.invoke('periodicalVolumes:register', {
    periodical_id: pid, year: '2024', price: 100, register_date: '2025-02-01'
  });
  assert.equal(again.ok, false);
  assert.match(again.error, new RegExp('вече е инвентиран като инв\\. № ' + first.inv_number));
  assert.match(again.error, /отчислете го с акт/, 'сочи се правилното действие');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM books WHERE volume = 'годишен комплект'").get().n, 1,
    'втори ред във фонда не се създава');

  // Другата година на същото издание обаче е отделен документ и минава.
  ok(t.ipcMain.invoke('periodicalVolumes:register', {
    periodical_id: pid, year: '2025', price: 110, register_date: '2026-01-10'
  }), 'следваща годишнина');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM books WHERE volume = 'годишен комплект'").get().n, 2);
});

test('изданието с инвентиран комплект не се изтрива — документът във фонда се маха само с акт', () => {
  /* periodical_volumes.periodical_id е ON DELETE CASCADE: изтриването на
     изданието би отнесло ВРЪЗКАТА, но не и документите. Редовете в books остават
     във фонда и в КДБФ с инвентарен номер, който вече не сочи наникъде — картонът
     гласи „Труд, 2024“, но програмата не знае от кое издание е. */
  const t = setup(['periodicals']);
  const pid = addPeriodical(t.db, 'Труд');
  const out = ok(t.ipcMain.invoke('periodicalVolumes:register', {
    periodical_id: pid, year: '2024', price: 100, register_date: '2025-01-10'
  }), 'инвентиране');
  const res = t.ipcMain.invoke('periodicals:delete', pid);
  assert.equal(res.ok, false);
  assert.match(res.error, new RegExp('инв\\. № ' + out.inv_number));
  assert.match(res.error, /акт за отчисляване/);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM periodicals WHERE id = ?').get(pid).n, 1);
});

test('изтриването на брой оставя следа, а когато годината е инвентирана — и предупреждение кой документ вече не отговаря на кардекса', () => {
  /* Триенето не се отказва: сгрешено вписване трябва да може да се поправи. Но
     ако годината вече е инвентирана, този брой е физическа част от подвързан
     документ с инвентарен номер, и следата трябва да каже точно кой документ от
     фонда вече не отговаря на картотеката си — иначе разминаването е неоткриваемо. */
  const t = setup(['periodicals']);
  const pid = addPeriodical(t.db, 'Труд');
  const issueId = ok(t.ipcMain.invoke('periodicalIssues:add', {
    periodical_id: pid, issue_no: '7', date: '2024-02-16', price: 2.5
  }), 'брой');
  const vol = ok(t.ipcMain.invoke('periodicalVolumes:register', {
    periodical_id: pid, year: '2024', register_date: '2025-01-10'
  }), 'инвентиране');

  t.audit.length = 0;
  ok(t.ipcMain.invoke('periodicalIssues:delete', issueId), 'изтриване на брой');
  assert.equal(t.audit.length, 1, 'следа има');
  assert.equal(t.audit[0].action, 'Изтрит брой');
  assert.match(t.audit[0].detail, /бр\. 7/);
  assert.match(t.audit[0].detail, /\(2024 г\.\)/, 'годината влиза отделно — по нея се подвързва комплектът');
  assert.match(t.audit[0].detail, /2\.50 €/);
  assert.match(t.audit[0].detail, new RegExp('годината вече е инвентирана като инв\\. № ' + vol.inv_number));
});

test('годината на комплекта не може да е от бъдещето или печатна грешка', () => {
  /* 2205 иначе би влязло в инвентарната книга завинаги. Горната граница е
     СЛЕДВАЩАТА година, защото абонаментът за идната година се плаща и получава
     през декември и комплектът му законно се завежда тогава. */
  const t = setup(['periodicals']);
  const pid = addPeriodical(t.db, 'Труд');
  for (const year of ['2205', '1700', 'догодина']) {
    const res = t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year, register_date: '2026-01-10' });
    assert.equal(res.ok, false, 'година ' + year + ' не бива да минава');
  }
  ok(t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: '2027', register_date: '2026-12-20' }),
    'абонаментът за идната година се завежда през декември');
});

/* ==================================================================
   6. ИЗГУБЕНИЯТ ДОКУМЕНТ
   ================================================================== */

/* Заемане, което чака да бъде приключено — по общия път, през loans:checkout. */
function openLoan(t, bookId, readerId, dates) {
  const d = dates || {};
  return ok(t.ipcMain.invoke('loans:checkout', {
    book_id: bookId, reader_id: readerId, date_out: d.out || '2026-01-05', date_due: d.due || '2026-01-19'
  }), 'заемане');
}

test('loans:markLost затваря заемането с изричен белег „изгубен“ и сменя състоянието на документа', () => {
  /* Заемането СЕ затваря (иначе документът виси зает завинаги), но книгата
     никога не се е върнала — оттам нуждата от изрична отметка вместо досещане по
     дати. Документът НЕ се отчислява тук: отчисляването е акт на комисия по
     чл. 30 и чл. 35 и се прави от „Отчисляване“; дотогава документът стои във
     фонда със състояние „изгубен“. */
  const t = setup(['loans']);
  const bookId = addBook(t.db, { inv_number: 700, title: 'Тютюн', price: 12 });
  const readerId = addReader(t.db, 'Петров, Иван');
  const loanId = openLoan(t, bookId, readerId);

  const out = ok(t.ipcMain.invoke('loans:markLost', {
    id: loanId, resolution: 'обезщетение', amount: 36, date: '2026-03-02', note: 'читателят призна'
  }), 'приключване като изгубен');

  const l = t.db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  assert.equal(l.lost, 1, 'белегът е изричен');
  assert.equal(l.date_in, '2026-03-02', 'заемането е затворено — документът не виси зает завинаги');
  assert.equal(l.lost_date, '2026-03-02');
  assert.equal(l.lost_resolution, 'обезщетение');
  assert.equal(l.lost_amount, 36);

  const b = t.db.prepare('SELECT status, deaccession_act_id FROM books WHERE id = ?').get(bookId);
  assert.equal(b.status, 'изгубен',
    '„изгубен“, а НЕ „липсващ“ — липсващ значи „не е намерен при инвентаризация“ и води до друга точка на чл. 30');
  assert.equal(b.deaccession_act_id, null, 'отчисляването е отделно действие на комисия');

  // Събитието е от вид „изгубен“, не „връщане“ — книгата не се е върнала.
  assert.ok(t.events.some(e => e.kind === 'изгубен'), 'вписва се събитие от собствен вид');
  assert.ok(!t.events.some(e => e.kind === 'връщане'));
  assert.equal(out.amount, 36);
});

test('обезщетението се начислява в читателската сметка, а не остава само като бележка', () => {
  /* Дотук уреждането с читателя, начислението и актът се правеха като три
     несвързани действия и никъде не оставаше, че този документ е покрит с
     обезщетение — а точно това пита счетоводството. */
  const t = setup(['loans']);
  const bookId = addBook(t.db, { inv_number: 701, title: 'Тютюн', price: 12 });
  const readerId = addReader(t.db, 'Петров, Иван');
  const loanId = openLoan(t, bookId, readerId);
  ok(t.ipcMain.invoke('loans:markLost', { id: loanId, resolution: 'обезщетение', amount: 36, date: '2026-03-02' }), 'изгубен');

  const line = t.db.prepare('SELECT * FROM account_lines WHERE reader_id = ? ORDER BY id DESC').get(readerId);
  assert.ok(line, 'в сметката на читателя има ред');
  assert.equal(line.type, 'обезщетение за изгубен документ',
    'отделен вид от „обезщетение“ (забавата) — иначе ревизията не може да отговори кое колко е');
  assert.equal(line.amount, 36);
  assert.match(line.note, /инв\. № 701/);
  assert.equal(t.db.prepare('SELECT lost_account_line_id FROM loans WHERE id = ?').get(loanId).lost_account_line_id, line.id,
    'заемането и редът в сметката се знаят един друг');
});

test('замяна без указание кой документ е приет се отказва — „донесе друга книга“ не е следа', () => {
  const t = setup(['loans']);
  const bookId = addBook(t.db, { inv_number: 702, price: 12 });
  const readerId = addReader(t.db, 'Петров');
  const loanId = openLoan(t, bookId, readerId);
  const res = t.ipcMain.invoke('loans:markLost', { id: loanId, resolution: 'замяна с равностоен документ', date: '2026-03-02' });
  assert.equal(res.ok, false);
  assert.match(res.error, /кой документ е приет/);
  assert.equal(t.db.prepare('SELECT date_in FROM loans WHERE id = ?').get(loanId).date_in, null,
    'заемането остава отворено — нищо не е приключено наполовина');

  // С описание минава и описанието се пази.
  ok(t.ipcMain.invoke('loans:markLost', {
    id: loanId, resolution: 'замяна с равностоен документ', replacement_note: 'Ботев, Съчинения, 2019', date: '2026-03-02'
  }), 'замяна с описание');
  assert.equal(t.db.prepare('SELECT lost_replacement_note FROM loans WHERE id = ?').get(loanId).lost_replacement_note,
    'Ботев, Съчинения, 2019');
});

test('изгубеният документ НЕ се брои като върнат в годишния отчет', () => {
  /* Заемането се затваря с date_in, но книгата я няма. Без този филтър
     показателят „спазени срокове“ броеше като върната в срок книга, която
     библиотеката вече не притежава — число, което отива в отчета към
     регионалната библиотека. */
  const t = setup(['loans', 'stats']);
  const readerId = addReader(t.db, 'Петров, Иван');
  const returnedBook = addBook(t.db, { inv_number: 710, price: 10 });
  const lostBook = addBook(t.db, { inv_number: 711, price: 12 });

  const l1 = openLoan(t, returnedBook, readerId, { out: '2026-01-05', due: '2026-01-19' });
  ok(t.ipcMain.invoke('loans:return', { id: l1, date_in: '2026-01-15' }), 'нормално връщане');
  const l2 = openLoan(t, lostBook, readerId, { out: '2026-01-05', due: '2026-01-19' });
  ok(t.ipcMain.invoke('loans:markLost', { id: l2, resolution: 'обезщетение', amount: 36, date: '2026-03-02' }), 'изгубен');

  const s = ok(t.ipcMain.invoke('stats:report', '2026'), 'годишен отчет');
  assert.equal(s.returnedOnTime, 1, 'върната е ЕДНА книга — другата не се е връщала');
  assert.equal(s.returnedLate, 0);
  // И трите книги си остават във фонда: изгубеният документ се отчислява с акт,
  // а дотогава е част от наличността, както изисква наредбата.
  assert.equal(s.fundCount, 2);
});

test('изгубеният документ НЕ се брои като върнат и когато е приключен ПРЕДИ падежа', () => {
  /* Другата половина на същия филтър. Читателят признава загубата на третия ден
     от заемането — тоест date_in ЛЕЖИ ПРЕДИ date_due и заемането влиза точно в
     клона „върнат в срок“. Без `COALESCE(lost,0) = 0` и в ТОЯ клон показателят
     „спазени срокове“ се подобрява от книга, която библиотеката вече няма: числото
     отива в отчета към регионалната библиотека и е по-добро от действителното. */
  const t = setup(['loans', 'stats']);
  const readerId = addReader(t.db, 'Петров, Иван');
  const lostBook = addBook(t.db, { inv_number: 712, price: 12 });
  const l = openLoan(t, lostBook, readerId, { out: '2026-01-05', due: '2026-01-19' });
  ok(t.ipcMain.invoke('loans:markLost', {
    id: l, resolution: 'обезщетение', amount: 20, date: '2026-01-08'
  }), 'изгубен ПРЕДИ срока');

  const s = ok(t.ipcMain.invoke('stats:report', '2026'), 'годишен отчет');
  assert.equal(s.returnedOnTime, 0,
    'книга, приключена като изгубена преди падежа, не е „върната в срок“ — тя изобщо не е върната');
  assert.equal(s.returnedLate, 0);
});

test('събраното обезщетение за изгубен документ влиза в годишния отчет като приход', () => {
  /* Начислението за изгубен документ е от СВОЙ вид („обезщетение за изгубен
     документ“), различен от обезщетението за просрочие — точно за да може
     ревизията да отговори кое колко е. Разделянето обаче създава и свой риск:
     справката „Събрани обезщетения“ сравняваше буквално с една стойност и новият
     вид просто нямаше да се появи в нея. Тоест библиотеката събира парите, вписва
     ги в сметката на читателя и после ги няма в годишния отчет — приход, който
     изчезва между два екрана. */
  const t = setup(['loans', 'account', 'stats']);
  const readerId = addReader(t.db, 'Петров, Иван');
  const bookId = addBook(t.db, { inv_number: 713, title: 'Тютюн', price: 12 });
  const loanId = openLoan(t, bookId, readerId);
  ok(t.ipcMain.invoke('loans:markLost', {
    id: loanId, resolution: 'обезщетение', amount: 36, date: '2026-03-02'
  }), 'изгубен');

  // Нищо събрано още — начисленото само по себе си не е приход.
  assert.equal(ok(t.ipcMain.invoke('stats:report', '2026'), 'отчет преди плащането').finesCollected, 0);

  ok(t.ipcMain.invoke('account:pay', { reader_id: readerId, amount: 18, date: '2026-03-10' }), 'частично плащане');
  assert.equal(ok(t.ipcMain.invoke('stats:report', '2026'), 'отчет след плащането').finesCollected, 18,
    'събраното по обезщетението за изгубен документ е приход на библиотеката и се брои');

  // И остатъкът, когато читателят доплати.
  ok(t.ipcMain.invoke('account:pay', { reader_id: readerId, amount: 18, date: '2026-03-20' }), 'доплащане');
  assert.equal(ok(t.ipcMain.invoke('stats:report', '2026'), 'отчет накрая').finesCollected, 36);
});

test('loans:lost връща списъка за акта по чл. 30, т. 5 — с читателя, уреждането и колко е СЪБРАНО', () => {
  /* Отчисляването на невърнат документ се прави по-късно и от друг човек
     (комисията). Дотогава изгубените документи нямаше къде да се видят заедно:
     библиотекарката трябваше да ги помни. */
  const t = setup(['loans', 'account']);
  const readerId = addReader(t.db, 'Петров, Иван');
  const bookId = addBook(t.db, { inv_number: 720, title: 'Тютюн', price: 12 });
  const loanId = openLoan(t, bookId, readerId);
  ok(t.ipcMain.invoke('loans:markLost', { id: loanId, resolution: 'обезщетение', amount: 36, date: '2026-03-02' }), 'изгубен');
  // Читателят плаща половината.
  ok(t.ipcMain.invoke('account:pay', { reader_id: readerId, amount: 18, date: '2026-03-10' }), 'плащане');

  const rows = ok(t.ipcMain.invoke('loans:lost', {}), 'списък');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.inv_number, 720);
  assert.equal(r.title, 'Тютюн');
  assert.equal(r.reader_name, 'Петров, Иван');
  assert.equal(r.lost_resolution, 'обезщетение');
  assert.equal(r.acted, false, 'още не е влязъл в акт');
  assert.ok(r.charge, 'начислението се чете');
  assert.equal(r.charge.charged, 36);
  assert.equal(r.charge.covered, 18, 'и колко от него е събрано — точно това пита счетоводството');
});

test('deaccessionActs:findBook носи данните за изгубения документ право във формата на акта', () => {
  /* Актът по чл. 30, т. 5 трябва да носи кой читател е изгубил документа, какво е
     уредено и дали обезщетението е събрано. Дотук трите неща не се срещаха
     никъде и комисията съставяше акт, без да знае, че вече има начислено. */
  const t = setup(['loans', 'account', 'deaccession-acts']);
  const readerId = addReader(t.db, 'Петров, Иван');
  const bookId = addBook(t.db, { inv_number: 730, title: 'Тютюн', price: 12 });
  const loanId = openLoan(t, bookId, readerId);
  ok(t.ipcMain.invoke('loans:markLost', { id: loanId, resolution: 'обезщетение', amount: 36, date: '2026-03-02' }), 'изгубен');
  ok(t.ipcMain.invoke('account:pay', { reader_id: readerId, amount: 36, date: '2026-03-10' }), 'плащане докрай');

  const found = ok(t.ipcMain.invoke('deaccessionActs:findBook', '730'), 'намиране по инв. №');
  assert.equal(found.inv_number, 730);
  assert.ok(found.lost, 'формата на акта вижда, че документът е изгубен');
  assert.equal(found.lost.reader_name, 'Петров, Иван');
  assert.equal(found.lost.lost_resolution, 'обезщетение');
  assert.equal(found.lost.charge.charged, 36);
  assert.equal(found.lost.charge.covered, 36, 'обезщетението е събрано изцяло');

  // И когато актът бъде съставен, следата назовава изгубените поименно.
  t.audit.length = 0;
  ok(t.ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-04-01', reason_code: 5, reason_text: 'невърнати от ползватели' },
    bookIds: [bookId]
  }), 'акт');
  const trail = t.audit.map(a => a.detail).join(' ');
  assert.match(trail, /изгубени от читатели: 1/);
  assert.match(trail, /Петров, Иван: обезщетение/);
  assert.match(trail, /начислено 36\.00 €, събрано 36\.00 €/);
});

test('заемане, приключено като изгубено, не се приключва втори път', () => {
  /* Бутонът стои на два екрана („Заемане и връщане“ и „Просрочени“), а второто
     натискане би начислило обезщетението ВТОРИ път в сметката на читателя. */
  const t = setup(['loans']);
  const readerId = addReader(t.db, 'Петров');
  const bookId = addBook(t.db, { inv_number: 740, price: 12 });
  const loanId = openLoan(t, bookId, readerId);
  ok(t.ipcMain.invoke('loans:markLost', { id: loanId, resolution: 'обезщетение', amount: 36, date: '2026-03-02' }), 'изгубен');
  const again = t.ipcMain.invoke('loans:markLost', { id: loanId, resolution: 'обезщетение', amount: 36, date: '2026-03-03' });
  assert.equal(again.ok, false);
  assert.match(again.error, /вече е приключено/);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM account_lines WHERE reader_id = ?').get(readerId).n, 1,
    'второ начисление не се появява');
});
