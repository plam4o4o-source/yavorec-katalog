'use strict';
/* Одитен кръг v2.4.57 — ФОНДЪТ Е ЕДНО ЧИСЛО, А СЕ СМЯТАШЕ НА ДВАНАЙСЕТ МЕСТА.
 * =====================================================================
 * Кръгът тръгна от най-безобидния възможен въпрос: „колко документа има
 * библиотеката“. Отговорът зависеше от това кой екран се гледа. Измерено върху
 * една и съща база, с един и същ документ:
 *
 *   случай                        | КДБФ / годишен отчет | табло / инв. книга
 *   ------------------------------|----------------------|--------------------
 *   без разпознаваема дата         |          0           |         1
 *   отчислен БЕЗ акт               |          1           |         0
 *   вписан с дата в бъдещето       |          0           |         1
 *
 * Нито едно от трите не е случайност. Двата ключа отговарят на два РАЗЛИЧНИ
 * въпроса и всеки е верен за своя: „какво пише в регистъра към 31.12“ (по
 * датите — това се подписва) и „какво стои на рафта днес“ (по състоянието —
 * това се проверява физически). Грешката беше друга и тройна:
 *   (1) условията се пишеха наново на всяко от дванайсетте места и се
 *       разминаваха при всяка промяна (две копия бяха забравили, че ред със
 *       status NULL от внесена база НЕ е отчислен);
 *   (2) двата ключа носеха едно и също име на екрана — „Библиотечен фонд“;
 *   (3) разликата между тях не се проверяваше от НИЩО.
 *
 * Най-скъпият единичен случай беше третият ред отгоре — датата, която не е
 * дата. Документ с register_date = „НЕВАЛИДНА-99-99“ пропадаше през всичките
 * три мрежи наведнъж: не е <= '2026-12-31' (кирилското „Н“ сортира след
 * цифрите), substr(…,1,4) не е година, а броячът „без дата“ търсеше само IS
 * NULL или празен низ. Документ за 99 лв. се брои на таблото, може да се заема
 * и НЕ СЪЩЕСТВУВА в официалния регистър по Наредба № 3 — без нито един екран,
 * на който да се види, че нещо липсва.
 *
 * Файлът заковава и трите части на поправката: единственото място, където
 * живеят условията (db/fund-sql.js), отказът на невалидна дата още при
 * вписването (handlers/books.js) и проверката, която СРАВНЯВА ключовете и
 * обяснява разликата на човешки език (handlers/fund-check.js). Плюс една
 * проверка по изходния код: че петте модула наистина ползват общия източник, а
 * не свое копие на условието — иначе поправката се разпада при първата следваща
 * промяна, точно както се разпадна предишния път.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, freshDb, fakeIpcMain, runDep, cleanupTmpDirs } = require('./helpers/audit-fixtures');
const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values');

const F = require(path.join(APP_DIR, 'db', 'fund-sql'));

test.after(cleanupTmpDirs);

/* Истинските handlers/fund-check + books + deaccession-acts върху ЕДНА база.
   Нарочно заедно: цялата точка на кръга е, че вписването, отчисляването и
   съгласуването трябва да броят едно и също — проверка само върху fund-check би
   минала и ако books:create пак приема „НЕВАЛИДНА-99-99“. */
function setup(prefix) {
  const { db } = freshDb(prefix || 'inv-fond-v2457-');
  const audit = [];
  const deps = {
    getDb: () => db, run: runDep,
    logAudit: (action, detail, diff) => audit.push({ action, detail, diff }),
    today: () => '2026-08-04', yearOf: () => '2026',
    BOOK_SELECT, normalizeScanCode,
    ftsQuery: (q) => q, cnSortKey: () => '', diffFields: () => [],
    scheduleCatalogWrite: () => {}, flushCatalogWrite: () => ({ written: true })
  };
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'fund-check'))(ipcMain, deps);
  require(path.join(APP_DIR, 'handlers', 'books'))(ipcMain, deps);
  require(path.join(APP_DIR, 'handlers', 'deaccession-acts'))(ipcMain, deps);
  return { db, ipcMain, audit };
}

/* Документ, вписан направо в базата — за случаите, които самата програма вече
   НЕ позволява да се създадат (счупена дата), но които съществуват в заварените
   бази и точно затова трябва да бъдат намирани. */
function addBook(db, o) {
  const b = Object.assign({
    inv_number: 1, title: 'Книга', price: 10, register_date: '2026-02-01',
    status: 'наличен', qty: 1, department: null, acquisition_id: null,
    deaccession_date: null, deaccession_act_id: null
  }, o);
  const id = db.prepare(`INSERT INTO books
    (inv_number, title, price, register_date, status, status_date, department, acquisition_id,
     deaccession_date, deaccession_act_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(b.inv_number, b.title, b.price, b.register_date, b.status, '2026-02-01',
      b.department, b.acquisition_id, b.deaccession_date, b.deaccession_act_id).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, b.qty);
  return id;
}
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };
const finding = (r, key) => r.findings.find(f => f.key === key);

/* ==================================================================
   1. ДВАТА КЛЮЧА — И ТРИТЕ СЛУЧАЯ, В КОИТО СЕ РАЗМИНАВАТ
   ================================================================== */

/* Заявките са сглобени ТОЧНО от парчетата в db/fund-sql.js — не са преписани.
   Ако някой промени условието там, тези числа се местят заедно с продукцията, а
   не заедно с теста. */
const countByDate = (db, extra) => db.prepare(
  `SELECT COALESCE(SUM(${F.QTY_JOIN}),0) AS n, COALESCE(SUM(b.price * ${F.QTY_JOIN}),0) AS v
   ${F.FROM_BOOKS_INV} WHERE ${F.fundByDate('?')}${extra ? ' AND ' + extra : ''}`);
const countByStatus = (db, extra) => db.prepare(
  `SELECT COALESCE(SUM(${F.QTY_JOIN}),0) AS n, COALESCE(SUM(b.price * ${F.QTY_JOIN}),0) AS v
   ${F.FROM_BOOKS_INV} WHERE ${F.fundByStatus}${extra ? ' AND ' + extra : ''}`);

test('ключът „регистър“ и ключът „налично днес“ дават РАЗЛИЧНИ числа в трите случая, за които са различни', () => {
  /* Това е самата находка на кръга, заедно с числата ѝ. Всеки от трите реда е
     истински документ в истинска библиотека:
       • „НЕВАЛИДНА-99-99“ — сгрешено въвеждане, минавало е без проверка;
       • отчислен без акт — внос от стара таблица или ръчна поправка на статуса;
       • дата в бъдещето — партида, заведена предварително („от 01.01. догодина“).
     Ако някой ден двата ключа започнат да дават едно и също за тези три реда,
     значи някой е „уеднаквил“ условията — и с това е счупил или регистъра
     (който трябва да може да гледа назад във времето), или наличността (която
     трябва да отговаря на въпроса какво стои на рафта ДНЕС). */
  const { db } = setup();
  const good = addBook(db, { inv_number: 1, price: 10, register_date: '2026-02-01' });
  const badDate = addBook(db, { inv_number: 2, price: 99, register_date: 'НЕВАЛИДНА-99-99' });
  const orphan = addBook(db, { inv_number: 3, price: 50, register_date: '2026-03-01', status: 'отчислен' });
  const future = addBook(db, { inv_number: 4, price: 20, register_date: '2027-05-01' });

  const at = '2026-12-31';
  const one = (id) => ({
    byDate: countByDate(db, 'b.id = ?').get(at, at, id).n,
    byStatus: countByStatus(db, 'b.id = ?').get(id).n
  });
  assert.deepEqual(one(good), { byDate: 1, byStatus: 1 }, 'изряден документ се брои и от двата ключа');
  assert.deepEqual(one(badDate), { byDate: 0, byStatus: 1 },
    'документ с неразпознаваема дата: няма го в регистъра, а таблото го брои');
  assert.deepEqual(one(orphan), { byDate: 1, byStatus: 0 },
    'отчислен БЕЗ акт: регистърът още го брои (няма дата на отчисляване), таблото — не');
  assert.deepEqual(one(future), { byDate: 0, byStatus: 1 },
    'дата в бъдещето: още не е постъпил по регистър, но вече стои на рафта');

  // И сборовете, защото точно те се разминават на двата екрана.
  const all = { byDate: countByDate(db).get(at, at), byStatus: countByStatus(db).get() };
  assert.equal(all.byDate.n, 2, 'КДБФ/годишен отчет към 31.12.2026: два документа');
  assert.equal(all.byDate.v, 60, 'и 60 € — 99-те и 20-те лева ги няма в регистъра');
  assert.equal(all.byStatus.n, 3, 'табло/инвентарна книга: три документа');
  assert.equal(all.byStatus.v, 129, 'и 129 € — тук липсват само отчислените 50');
});

test('ключът „налично днес“ брои и реда със status NULL — той идва от внесена база и НЕ е отчислен', () => {
  /* Дотук условието се пишеше на осем места и две от копията бяха забравили
     точно това. `status != 'отчислен'` в SQL дава NULL (не TRUE) за ред с NULL
     статус и SQLite мълчаливо го изхвърля от WHERE — книга от стар внос
     изчезваше от пула за инвентаризация, докато публичният каталог я броеше за
     налична. Пропада през две предпазни мрежи наведнъж. */
  const { db } = setup();
  addBook(db, { inv_number: 7, status: null, price: 12 });
  assert.equal(countByStatus(db).get().n, 1, 'NULL статус е В наличност');
  assert.match(F.fundByStatus, /IS NULL/, 'условието трябва да остане NULL-безопасно');
  assert.match(F.fundByStatusPlain, /IS NULL/, 'същото и за варианта без псевдоним на таблицата');
});

/* ==================================================================
   2. ДАТАТА, КОЯТО НЕ Е ДАТА
   ================================================================== */

test('BAD_DATE хваща и NULL, и празния низ, и НЕРАЗПОЗНАВАЕМАТА дата — третото е същината', () => {
  /* Дотук „без дата на вписване“ навсякъде значеше `IS NULL OR = ''`. Двата
     случая се хващаха, третият — не, и точно той е опасният: NULL и празното
     поне се броят от предупреждението за недатирани документи, а
     „НЕВАЛИДНА-99-99“ не се брои от НИЩО. Затова проверката е на трите заедно:
     мутация, която върне старото условие, оставя първите две верни и този тест
     е единственото, което ще падне. */
  const { db } = setup();
  const nul = addBook(db, { inv_number: 1, register_date: null });
  const empty = addBook(db, { inv_number: 2, register_date: '' });
  const broken = addBook(db, { inv_number: 3, register_date: 'НЕВАЛИДНА-99-99' });
  const fine = addBook(db, { inv_number: 4, register_date: '2026-02-01' });

  const bad = db.prepare(`SELECT b.id FROM books b WHERE ${F.BAD_DATE} ORDER BY b.id`).pluck().all();
  assert.deepEqual(bad, [nul, empty, broken], 'и трите се намират, а изрядният — не');
  assert.ok(!bad.includes(fine));
  // Изрично: НЕ е достатъчно да се хванат само първите два.
  const onlyOldWay = db.prepare(
    "SELECT COUNT(*) AS n FROM books b WHERE b.register_date IS NULL OR b.register_date = ''").get().n;
  assert.equal(onlyOldWay, 2, 'старото условие намираше два от трите документа');
  assert.equal(bad.length, 3, 'новото намира и третия — този, който изчезваше от регистъра');
});

test('books:create ОТКАЗВА невалидна дата на вписване, приема валидната, а празната пада към днес', () => {
  /* Най-често въвежданият път в цялата програма беше единственият непроверен: в
     handlers/books.js нямаше нито едно повикване на isValidIsoDate, докато
     актът за отчисляване, протоколът по чл. 40, МЗС и заемането всички го
     правят изрично. Датата на вписване е реквизит по чл. 16, ал. 2 и решава в
     коя година се брои постъплението — невалидна дата не е „по-добра от нищо“,
     тя е по-лоша от липсваща. */
  const { ipcMain, db } = setup();
  const bad = ipcMain.invoke('books:create', { inv_number: 10, title: 'Счупена дата', register_date: 'НЕВАЛИДНА-99-99' });
  assert.equal(bad.ok, false, 'вписването се отказва');
  assert.match(bad.error, /не е валидна дата/);
  assert.match(bad.error, /Книгата за движение на фонда/, 'съобщението казва ЗАЩО има значение');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 0, 'нищо не е влязло в базата');

  // Проверката не е „всичко с тире“: и 2026-13-45 е невалидна дата.
  assert.equal(ipcMain.invoke('books:create', { inv_number: 10, title: 'Тринайсети месец', register_date: '2026-13-45' }).ok,
    false, 'добре подредена, но несъществуваща дата също се отказва');

  const okId = ok(ipcMain.invoke('books:create', { inv_number: 10, title: 'Редовна', register_date: '2026-02-01' }), 'валидна дата');
  assert.equal(db.prepare('SELECT register_date FROM books WHERE id = ?').get(okId).register_date, '2026-02-01');

  const emptyId = ok(ipcMain.invoke('books:create', { inv_number: 11, title: 'Без дата', register_date: '' }), 'празна дата');
  assert.equal(db.prepare('SELECT register_date FROM books WHERE id = ?').get(emptyId).register_date, '2026-08-04',
    'празното поле пада към днес — документът влиза в регистъра, вместо да изчезне от него');
});

/* ==================================================================
   3. ПРОВЕРКАТА, КОЯТО СРАВНЯВА И ОБЯСНЯВА
   ================================================================== */

test('fund:check намира документите без валидна дата и казва КОЛКО ЕВРО липсват от регистъра', () => {
  /* Без това число находката е „има някакъв проблем“. С него е изречение, което
     библиотекарката може да занесе на счетоводителя: „99 € стоят във фонда и ги
     няма в Книгата за движение на фонда“. */
  const { db, ipcMain } = setup();
  addBook(db, { inv_number: 1, price: 10, register_date: '2026-02-01' });
  addBook(db, { inv_number: 2, price: 99, register_date: 'НЕВАЛИДНА-99-99', title: 'Изчезналата' });
  addBook(db, { inv_number: 3, price: 50, register_date: '2026-03-01' });

  const r = ok(ipcMain.invoke('fund:check', 2026), 'проверка');
  const f = finding(r, 'baddate');
  assert.ok(f, 'находката съществува');
  assert.equal(f.level, 'тежко');
  assert.equal(f.title, '1 документ е без валидна дата на вписване');
  assert.equal(f.a.n, 1, 'един документ');
  assert.equal(f.a.v, 99, 'и точно 99 € — толкова липсват от регистъра');
  assert.deepEqual(f.list.map(x => x.inv_number), [2], 'находката назовава КОЙ документ е');
  assert.equal(f.list[0].title, 'Изчезналата');
  assert.match(f.why, /чл. 16, ал. 2/, 'казва на кой член се опира');
  assert.match(f.todo, /въведете датата/i, 'и какво да се направи');
  assert.equal(r.ok, false, 'проверката НЕ мълчи при такава находка');

  // Същата причина излиза и в обяснението защо двата ключа не съвпадат.
  const keys = finding(r, 'keys');
  assert.ok(keys, 'разминаването между таблото и отчета също се обявява');
  assert.equal(keys.a.n, 2, 'годишен отчет: два документа');
  assert.equal(keys.b.n, 3, 'табло: три документа');
  assert.match(keys.why, /1 без разпознаваема дата на вписване/, 'разликата се обяснява ИЗЦЯЛО, не само се обявява');
  /* SQLite сравнява текст побайтово: кирилският низ „НЕВАЛИДНА-99-99“ е
     ПО-ГОЛЯМ от всяка чисто цифрова дата, тоест без изричното изключване на
     BAD_DATE от проверката за бъдеща дата ЕДИН документ се брои ДВА пъти —
     и като „без дата“, и като „с бъдеща дата“ — а разликата е точно 1 (v2.4.58). */
  assert.doesNotMatch(keys.why, /с дата на вписване след/,
    'документът с нечетима дата не бива да се брои ВТОРИ път и като „бъдеща“ — разликата е точно 1, не 2');
});

test('fund:check намира документите, вписани без партида — двете части на КДБФ се разминават точно с тях', () => {
  /* Част № 1 регистрира ПАРТИДИТЕ на постъпване (чл. 14), а Част № 2 брои
     вписаните документи. Документ без партида влиза във втората и липсва в
     първата; разминаването се вижда чак когато някой събере двете колони. */
  const { db, ipcMain } = setup();
  const acqId = db.prepare(`INSERT INTO acquisitions (no, year, date, total_count) VALUES (1, '2026', '2026-01-10', 1)`)
    .run().lastInsertRowid;
  addBook(db, { inv_number: 1, register_date: '2026-02-01', acquisition_id: acqId });
  addBook(db, { inv_number: 2, register_date: '2026-03-01' });
  addBook(db, { inv_number: 3, register_date: '2026-04-01' });
  addBook(db, { inv_number: 4, register_date: '2025-04-01' });   // друга година — не влиза

  const f = finding(ok(ipcMain.invoke('fund:check', 2026), 'проверка'), 'nobatch');
  assert.ok(f, 'находката съществува');
  assert.equal(f.title, '2 документа са вписани без партида', 'броят е точно на вписаните през 2026 г. без партида');
  assert.match(f.why, /чл. 14/);
  assert.equal(f.level, 'бележка', 'това е бележка, не тревога — партидата се завежда и после');
});

test('fund:check МЪЛЧИ (ok:true), когато числата се връзват — иначе екранът става фонов шум', () => {
  /* Проверка, която винаги намира нещо, не се чете. Затова изрядната база трябва
     да дава празен списък: тогава редът в дневника „числата се връзват“ значи
     нещо. */
  const { db, ipcMain } = setup();
  const acqId = db.prepare(`INSERT INTO acquisitions (no, year, date, total_count) VALUES (1, '2025', '2025-01-10', 2)`)
    .run().lastInsertRowid;
  addBook(db, { inv_number: 1, price: 10, register_date: '2025-06-01', acquisition_id: acqId });
  addBook(db, { inv_number: 2, price: 20, register_date: '2025-06-01', acquisition_id: acqId });

  const r = ok(ipcMain.invoke('fund:check', 2026), 'проверка');
  assert.deepEqual(r.findings, [], 'нито една находка');
  assert.equal(r.ok, true);
  assert.equal(r.year, 2026);
});

test('fund:checkLogged вписва проверката в одитната следа — и когато намери, и когато не намери нищо', () => {
  /* Проверката се вика при всяко отваряне на екрана и НЕ бива да пълни следата с
     еднакви редове — затова вписването е отделен канал. Но щом библиотекарката
     е натиснала „Провери“, в дневника трябва да остане какво е излязло: това е
     единственото доказателство пред проверяващия, че съгласуването е правено. */
  const { db, ipcMain, audit } = setup();
  addBook(db, { inv_number: 1, price: 99, register_date: 'НЕВАЛИДНА-99-99' });

  ok(ipcMain.invoke('fund:check', 2026), 'тиха проверка');
  assert.equal(audit.length, 0, 'самото отваряне на екрана НЕ пише в дневника');

  ok(ipcMain.invoke('fund:checkLogged', 2026), 'вписана проверка');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'Съгласуване на фонда');
  assert.match(audit[0].detail, /проверка за 2026 г/);
  assert.match(audit[0].detail, /без валидна дата на вписване/, 'следата назовава находката, не само че е имало проверка');

  // Изрядна база — редът пак се пише, но казва другото.
  const clean = setup('inv-fond-log-clean-');
  clean.db.prepare(`INSERT INTO acquisitions (no, year, date, total_count) VALUES (1, '2025', '2025-01-10', 1)`).run();
  addBook(clean.db, { inv_number: 1, price: 10, register_date: '2025-06-01', acquisition_id: 1 });
  ok(clean.ipcMain.invoke('fund:checkLogged', 2026), 'вписана проверка на изрядна база');
  assert.equal(clean.audit.length, 1);
  assert.match(clean.audit[0].detail, /числата се връзват/);
});

/* ==================================================================
   4. ВЕРИГАТА 31.12.(Y−1) → 01.01.Y
   ================================================================== */

test('поправка на „Налични бройки“ на ВЕЧЕ отчислен документ къса веригата 31.12.2025 → 01.01.2026 — и проверката го ЛОВИ', () => {
  /* Това е случаят, заради който проверката изобщо съществува, и той не е
     хипотетичен. „Наличност към 01.01.Y“ в КДБФ Част № 2 се извежда като
     31.12 − постъпили + отчислени, а двете събираеми идват от НЕСЪВМЕСТИМИ
     източници: наличността се брои ЖИВО от books+inventory, а отчисленото — от
     СНИМКАТА в акта (чл. 35, ал. 2), която нарочно не се променя.
     Тоест поправка на „Налични бройки“ на документ, който вече е отчислен, мени
     затворена, ВЕЧЕ ОТПЕЧАТАНА година със задна дата. Две разпечатки в една
     папка, които не се връзват, и дотук нищо, което да го каже.
     Тук: книга от 2024 г., отчислена с акт през 2026 г. със снимка „1 брой,
     10 €“, на която после някой поправя бройката на 3. */
  const { db, ipcMain } = setup();
  const bookId = addBook(db, { inv_number: 501, price: 10, register_date: '2024-01-01', qty: 1 });
  ok(ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-06-10', reason_code: 3, reason_text: 'физически изхабени',
      disposal: 'вторични суровини', committee1: 'А', committee2: 'Б', committee3: 'В' },
    bookIds: [bookId]
  }), 'съставяне на акт');

  // Преди поправката всичко се връзва — това е важното, иначе тестът щеше да
  // лови просто „проверката винаги се оплаква“.
  assert.equal(finding(ok(ipcMain.invoke('fund:check', 2026), 'преди'), 'chain'), undefined,
    'изрядният акт не къса веригата');

  db.prepare('UPDATE inventory SET quantity = 3 WHERE book_id = ?').run(bookId);

  const f = finding(ok(ipcMain.invoke('fund:check', 2026), 'след'), 'chain');
  assert.ok(f, 'проверката ЛОВИ разминаването');
  assert.equal(f.level, 'важно');
  assert.equal(f.title, 'Наличността към 01.01.2026 не се връзва с 31.12.2025');
  assert.equal(f.a.n, 1, 'изведената в Част № 2 наличност: 0 − 0 + 1 (от снимката в акта)');
  assert.equal(f.a.v, 10, 'и 10 € — цената, снимана в акта');
  assert.equal(f.b.n, 3, 'а пряко преброената към 31.12.2025 вече дава 3 — живата, поправена бройка');
  assert.equal(f.b.v, 30);
  assert.match(f.why, /СНИМКАТА в акта/, 'обяснението назовава истинската причина');
  assert.match(f.why, /Налични бройки/, 'и точното действие, което я е предизвикало');
  assert.match(f.todo, /остава вярна за деня, в който е подписана/,
    'и казва, че отпечатаният документ НЕ става невалиден — това е първият въпрос на библиотекаря');
});

/* ==================================================================
   5. ЕДИН ИЗТОЧНИК НА УСЛОВИЯТА — ПРОВЕРКА ПО ИЗХОДНИЯ КОД
   ================================================================== */

test('kdbf, stats, dashboard, inv-book и books РЕАЛНО ползват db/fund-sql.js, а не свое копие на условието', () => {
  /* Без тази проверка поправката е еднократна. Условията вече бяха „оправяни“
     веднъж — и се разпаднаха, защото всяко място си държеше копие: два от
     осемте екземпляра бяха забравили NULL-безопасността на статуса, а КДБФ и
     таблото се оказаха два различни ключа под едно име.
     Тук се брои КОЛКО ПЪТИ всеки модул взима условието от общия източник.
     Мутация, която върне дори едно преписано условие на мястото му, сваля
     брояча и този тест пада — а без него мутацията минава мълчаливо, защото
     преписаното условие дава същите числа… докато някой не промени едното. */
  const expected = {
    // v2.4.57: kdbf.js взима и BAD_DATE — броячът „без дата на вписване“ в самия
    // КДБФ беше последното място с преписано условие и пропускаше точно
    // неразпознаваемата дата (виж теста по-долу).
    'handlers/kdbf.js': { 'FUND.fundByDate(': 2, 'BAD_DATE': 3 },
    'handlers/stats.js': { 'FUND.fundByDate(': 4 },
    'handlers/dashboard.js': { 'FUND.fundByStatus': 3 },   // 2 × с псевдоним + 1 × Plain
    'handlers/inv-book.js': { 'FUND.fundByStatus': 3, 'FUND.BAD_DATE': 1 },
    // 3 × Plain: лимитът, limits:usage и груповата редакция (последната беше
    // преписана до v2.4.57 — днешните ѝ числа съвпадаха, но следващата промяна
    // на ключа щеше да я разсинхронизира мълчаливо).
    'handlers/books.js': { 'fundByStatusPlain': 3, 'FUND.fundByStatus': 1 }
  };
  for (const [rel, wants] of Object.entries(expected)) {
    const src = fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
    assert.match(src, /require\('\.\.\/db\/fund-sql'\)/, rel + ' трябва да взима условията от db/fund-sql.js');
    for (const [needle, n] of Object.entries(wants)) {
      const got = src.split(needle).length - 1;
      assert.equal(got, n, rel + ': очаквани ' + n + ' ползвания на ' + needle + ', намерени ' + got);
    }
  }
});

test('двата ключа живеят САМО в db/fund-sql.js — самият модул не ги изчислява наново', () => {
  /* Огледалната половина на предишния тест: ако някой ден fund-sql.js започне да
     сглобява условието от парчета на две места, разминаването се връща вътре в
     самия източник. */
  assert.equal(typeof F.fundByDate, 'function', 'ключът „регистър“ е функция на датата — той гледа НАЗАД във времето');
  assert.equal(F.fundByDate('?'), F.fundByDate('?'), 'един и същ параметър дава едно и също условие');
  assert.match(F.fundByDate('?'), /register_date/, 'брои по ДАТИТЕ');
  assert.match(F.fundByDate('?'), /deaccession_date/, 'и по двете дати, не само по едната');
  assert.doesNotMatch(F.fundByDate('?'), /status/, 'ключът „регистър“ НЕ гледа статуса — иначе не може да гледа назад');
  assert.match(F.fundByStatus, /status/, 'ключът „налично днес“ брои по СЪСТОЯНИЕТО');
  assert.doesNotMatch(F.fundByStatus, /register_date|deaccession_date/, 'и не по датите');
});

test('fund-check сглобява своите заявки от същите парчета — не от преписани условия', () => {
  /* Проверката, която съди двата ключа, не бива да има ТРЕТИ ключ. */
  const src = fs.readFileSync(path.join(APP_DIR, 'handlers', 'fund-check.js'), 'utf8');
  assert.match(src, /require\('\.\.\/db\/fund-sql'\)/);
  for (const needle of ['F.fundByDate(', 'F.fundByStatus', 'F.BAD_DATE', 'F.ACT_LIVE', 'F.QTY_JOIN']) {
    assert.ok(src.includes(needle), 'handlers/fund-check.js трябва да ползва ' + needle);
  }
  assert.ok(!/register_date <= \?/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    'нито едно условие не е преписано на ръка');
});

test('и самият КДБФ вижда документите с неразпознаваема дата в собствения си ред „без дата“', () => {
  /* Намерено от мутационната проверка на този кръг: inv-book.js и „Проверка на
     данните“ вече ползваха общото условие, но броячът `undated` в handlers/kdbf.js
     беше останал на „IS NULL или празно“. Тоест точно документът, който се
     ПЕЧАТА и ПОДПИСВА, обявяваше „0 недатирани“, докато собственото му число за
     наличността беше с 99 € по-малко. Числата в един документ не бива да си
     противоречат — това е първото, което проверяващият забелязва. */
  const { db } = freshDb('inv-kdbf-bad-');
  const ipc = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'kdbf.js'))(ipc, { getDb: () => db, run: runDep, yearOf: () => '2026' });
  const ins = db.prepare('INSERT INTO books (inv_number,title,price,register_date,status,language) VALUES (?,?,?,?,?,?)');
  ins.run(1, 'Добра', 10, '2026-01-01', 'наличен', 'български');
  ins.run(2, 'Счупена дата', 99, 'НЕВАЛИДНА-99-99', 'наличен', 'български');
  ins.run(3, 'Втора добра', 50, '2026-02-01', 'наличен', 'български');
  const r = ipc.invoke('kdbf:report', '2026').data;
  assert.equal(r.stockEnd.n, 2, 'счупената дата изпада от наличността — това е вярно');
  assert.equal(r.undated.rows, 1, '… и точно затова трябва да се брои от реда „без дата на вписване“');
  assert.equal(r.undated.v, 99, 'със стойността си, за да се види колко липсва от регистъра');
});

test('таблото САМО показва предупреждението, когато числата не се връзват — и мълчи, когато се връзват', async () => {
  /* Намерено при писането на наръчника: функцията dashFundCheck() съществуваше,
     но контейнерът #dashFundCheck не се рисуваше никъде — тоест проверката се
     изпълняваше и излизаше тихо, а предупреждението НЕ се виждаше НИКОГА.
     Точно този клас дефект кръгът поправя другаде: код, който изглежда готов,
     но не стига до човека. Бутонът сочеше и към несъществуващ раздел
     ('settings' вместо 'setup'). */
  const { buildDom, settle } = require('./helpers/audit-fixtures');
  const DASH = {
    fundCount: 1000, fundValue: 500, loansOpen: 0, activeReaders: 0,
    overdueCount: 0, overdueBuckets: { d7: 0, d30: 0, more: 0 }, overdueRows: [],
    loansWeeks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], upcoming: [], upcomingCount: 0, upcomingByDay: [],
    holdsReady: 0, holdsWaiting: 0, year: 2026, acquiredYear: 0, deaccessionedYear: 0,
    loansYear: 0, readersYear: 0, inventoryScannedYear: 0, inventoryTarget: 1000, inventoryPct: 10,
    today: { dueReminders: 0, reregDue: 0, longOverdue: 0, dnevnikFilled: true, isTodayOpen: true }
  };
  const render = async (findings) => {
    const dom = buildDom({ 'dashboard.full': DASH, 'fund.check': { year: 2026, ok: !findings.length, findings } });
    const w = dom.window;
    await settle();
    await w.renderDash();
    await settle(); await settle();
    return w.document.getElementById('dashFundCheck');
  };
  const warn = await render([{ level: 'тежко', title: '1 документ е без валидна дата на вписване' }]);
  assert.ok(warn, 'контейнерът трябва да СЪЩЕСТВУВА — иначе проверката няма къде да се покаже');
  assert.match(warn.textContent, /не се връзват/, 'предупреждението се вижда');
  assert.match(warn.textContent, /без валидна дата/, '… и казва точно какво е намерено');
  assert.match(warn.innerHTML, /go\('setup'\)/, 'бутонът сочи към съществуващ раздел');

  const quiet = await render([{ level: 'бележка', title: '1 документ е вписан без партида' }]);
  assert.equal(quiet.innerHTML, '', 'обикновена бележка НЕ вдига предупреждение на таблото');
});
