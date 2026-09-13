'use strict';
/* Одитен кръг v2.4.57 — КАКВО СЕ ОТРАЗЯВА, КОГАТО ДОКУМЕНТ ВЛЕЗЕ ВЪВ ФОНДА.
 * =====================================================================
 * Другата половина на кръга. Отчисляването беше премълчавало седем неща; при
 * придобиването се оказаха шест, и всичките от един и същ вид — програмата ЗНАЕ
 * нещо, а човекът пред формата не научава.
 *
 *   1) ПРЕСКОЧЕНИЯТ ИНВЕНТАРЕН НОМЕР. Ръчно въведен номер, по-голям от следващия
 *      по ред, просто избутваше брояча напред: `if (inv >= next) next = inv + 1`.
 *      Проверено: при next_inv № 3 и документ с № 5000 остават 4997 неизползвани
 *      номера, за които в програмата няма НИКАКВА следа. Инвентарната книга е
 *      поредица и проверката по чл. 17, ал. 2 иска отговор за ВСЕКИ номер в нея;
 *      самата програма вече знае това — books:delete отказва изтриване именно с
 *      довода, че номерът „остава празно място в поредицата“. Същият довод важи
 *      дословно и при създаването, само че там дупката е не един номер, а хиляди.
 *   2) ЗАЕТИЯТ НОМЕР. Формата се предпопълва при ОТВАРЯНЕ, а номерът се заема при
 *      записа; два компютъра към една мрежова база отварят „Нов документ“ с № 512
 *      и вторият пада върху UNIQUE индекса. Общият превод на SQLite грешката не
 *      казва нито защо, нито какво да се направи — типичната реакция е да се
 *      въведе „свободен“ номер на ръка, което пробива точно дупката от т. 1.
 *   3) ПУБЛИЧНИЯТ КАТАЛОГ. Отчисляването отдавна вика flushCatalogWrite()
 *      синхронно и вписва провала в дневника; постъплението ползваше debounced
 *      запис, чийто резултат се изхвърля. Измерено на изключена мрежова папка:
 *      цяла новопостъпила партида от 40 книги не стига до сайта, а в дневника
 *      няма нито ред.
 *   4) ПРЕДЛОЖЕНИЯТА ЗА ПОКУПКА. Читател предлага книга, книгата постъпва,
 *      suggestions:list продължава да показва „заявено“. Предложението е
 *      единственият случай, в който за конкретен читател СЕ ЗНАЕ СИГУРНО, че
 *      иска конкретно заглавие — и той беше последният, който научава.
 *   5) „ОСТАВАТ“ В ПАРТИДАТА. `Math.max(0, обявени − инвентирани)` показваше
 *      кръгла нула и при партида за 5 с 6 инвентирани — същото число, което
 *      показва и изрядно приключена партида.
 *   6) МЕНЮТО „ОТДЕЛ“. Отдел, в който са останали само отчислени документи,
 *      продължаваше да стои в падащия филтър, а изборът му връщаше точно тях.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  APP_DIR, freshDb, fakeIpcMain, runDep, cleanupTmpDirs, buildDom, settle
} = require('./helpers/audit-fixtures');
const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values');

const { findOpenSuggestionsForBook } = require(path.join(APP_DIR, 'handlers', 'suggestions'));

test.after(cleanupTmpDirs);

/* `flush` е нарочно подменяем: точката на т. 3 е, че постъплението вече ЧЕТЕ
   резултата от записа на каталога, вместо да го изхвърля. */
function setup(opts) {
  const { db } = freshDb('inv-prid-v2457-');
  const audit = [];
  const catalog = { result: { written: true } };
  const deps = {
    getDb: () => db, run: runDep,
    logAudit: (action, detail, diff) => audit.push({ action, detail, diff }),
    today: () => '2026-08-04', yearOf: () => '2026',
    BOOK_SELECT, normalizeScanCode,
    ftsQuery: (q) => q, cnSortKey: () => '', diffFields: () => [],
    scheduleCatalogWrite: () => audit.push({ action: '(debounced)', detail: '' }),
    flushCatalogWrite: (opts && opts.noFlush) ? undefined : () => catalog.result
  };
  const ipcMain = fakeIpcMain();
  for (const m of ['books', 'suggestions', 'deaccession-acts']) {
    require(path.join(APP_DIR, 'handlers', m))(ipcMain, deps);
  }
  return { db, ipcMain, audit, catalog };
}
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };
const NEW = (o) => Object.assign({ title: 'Нова книга', register_date: '2026-02-01' }, o);

/* ==================================================================
   1. ПРЕСКОЧЕНИЯТ ИНВЕНТАРЕН НОМЕР
   ================================================================== */

test('прескочените инвентарни номера оставят следа в дневника — с ТОЧНИЯ им брой', () => {
  /* Номерът НЕ се отказва: скокът е законен и обичаен (нова хилядна поредица,
     продължение на стара книга, дарение с отделен блок) и отказът би спрял
     редовна работа. Отказва се само МЪЛЧАНИЕТО — при проверка по чл. 17, ал. 2
     трябва да има какво да се каже за всеки празен номер. */
  const { db, ipcMain, audit } = setup();
  db.prepare('UPDATE settings SET next_inv_number = 3 WHERE id = 1').run();

  const res = ipcMain.invoke('books:create', NEW({ inv_number: 5000, title: 'Нова поредица' }));
  assert.equal(res.ok, true, 'вписването МИНАВА — скокът е законен');

  assert.equal(res.invGap.skipped, 4997, 'точният брой прескочени номера: от 3 до 4999');
  assert.equal(res.invGap.from, 3);
  assert.equal(res.invGap.to, 4999);
  assert.equal(res.invGap.inv_number, 5000);
  assert.match(res.invGap.message, /чл. 17, ал. 2/, 'съобщението казва защо това има значение');
  assert.match(res.invGap.message, /поправете го сега, докато документът е сам в поредицата/,
    'и какво може да се направи, докато още е лесно');

  const trail = audit.find(a => a.action === 'Прескочени инвентарни номера');
  assert.ok(trail, 'следата е ЗАДЪЛЖИТЕЛНА — прозорецът се затваря, дневникът остава');
  assert.match(trail.detail, /остават неизползвани 4997 номера: от 3 до 4999/);
  assert.match(trail.detail, /Нова поредица/, 'следата казва при вписването на кой документ е станало');

  // Редът за дупката се пише ПРЕДИ „Нов документ“ нарочно: последният ред в
  // дневника трябва да остане самото вписване.
  const kinds = audit.filter(a => a.action !== '(debounced)').map(a => a.action);
  assert.deepEqual(kinds, ['Прескочени инвентарни номера', 'Нов документ']);
  assert.equal(db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get().next_inv_number, 5001);
});

test('един прескочен номер се брои като един — и се назовава поименно, а не като „1 номера“', () => {
  const { db, ipcMain, audit } = setup();
  db.prepare('UPDATE settings SET next_inv_number = 7 WHERE id = 1').run();
  const res = ipcMain.invoke('books:create', NEW({ inv_number: 8 }));
  assert.equal(res.invGap.skipped, 1);
  assert.match(res.invGap.message, /Номер 7 остава празен в инвентарната книга/);
  assert.match(audit.find(a => a.action === 'Прескочени инвентарни номера').detail, /остават неизползвани инв. № 7/);
});

test('редовното вписване по ред НЕ вдига тревога и НЕ пише нищо в дневника', () => {
  /* Иначе следата се пълни с шум и престава да се чете — а точно нейната
     стойност е, че когато има ред, той значи нещо. */
  const { db, ipcMain, audit } = setup();
  db.prepare('UPDATE settings SET next_inv_number = 3 WHERE id = 1').run();
  const res = ipcMain.invoke('books:create', NEW({ inv_number: 3 }));
  assert.equal(res.invGap, null, 'няма дупка — няма предупреждение');
  assert.equal(audit.filter(a => a.action === 'Прескочени инвентарни номера').length, 0);

  // По-МАЛЪК номер (запълване на стара дупка) също не е скок.
  db.prepare('UPDATE settings SET next_inv_number = 10 WHERE id = 1').run();
  assert.equal(ipcMain.invoke('books:create', NEW({ inv_number: 5 })).invGap, null,
    'попълването на по-стар свободен номер не пробива нищо');
});

/* ==================================================================
   2. ЗАЕТИЯТ ИНВЕНТАРЕН НОМЕР
   ================================================================== */

test('заетият инвентарен номер казва КОЙ го държи и какво да се направи — „затворете и отворете формата отново“', () => {
  /* Общият превод на SQLite грешката („Този инвентарен номер вече е зает от друг
     документ.“) е вярно изречение, което не казва нито защо се е случило, нито
     какво да се направи; типичната реакция е да се въведе „свободен“ номер на
     ръка, което пробива дупка в поредицата. Актът за отчисляване, протоколът по
     чл. 40, МЗС и партидата в КДБФ всички вече обясняват точно този случай с
     едно и също изречение — инвентарният номер беше единственият без него. */
  const { ipcMain, db } = setup();
  ok(ipcMain.invoke('books:create', NEW({ inv_number: 512, title: 'Първата' })), 'първо вписване');

  const res = ipcMain.invoke('books:create', NEW({ inv_number: 512, title: 'Втората' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /Инв. № 512 вече е зает от „Първата“/, 'казва КОЙ документ държи номера');
  assert.match(res.error, /от друго работно място към същата база/, 'и най-вероятната причина');
  assert.match(res.error, /Затворете и отворете формата отново, за да получите следващия свободен номер/,
    'и точното действие — вместо библиотекарката да си измисля „свободен“ номер');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 1, 'вторият документ не е влязъл');
});

/* ==================================================================
   3. ЗАПИСЪТ НА ПУБЛИЧНИЯ КАТАЛОГ
   ================================================================== */

test('провален запис на каталога при постъпление дава ред в дневника И предупреждение обратно към прозореца', () => {
  /* Мълчаливият провал при ПОСТЪПЛЕНИЕ е точно толкова тежък, колкото при
     отчисляване — разликата беше само че единият път е бил поправен, а другият
     не. Читателят търси новите книги онлайн и не ги намира; библиотекарят е
     сигурен, че ги е въвел, защото програмата не е казала нищо. */
  const { ipcMain, audit, catalog } = setup();
  catalog.result = { written: false, error: 'мрежовият диск не е свързан' };

  const res = ipcMain.invoke('books:create', NEW({ inv_number: 1 }));
  assert.equal(res.ok, true, 'документът ВЛИЗА — каталогът е второто, вписването е първото');
  assert.match(res.catalogWarning, /записът на каталога след нов документ инв. № 1 не успя/);
  assert.match(res.catalogWarning, /мрежовият диск не е свързан/, 'носи истинската причина');
  assert.match(res.catalogWarning, /няма да се появи на сайта/);

  const row = audit.find(a => a.action === 'Онлайн каталог');
  assert.ok(row, 'и в дневника, защото прозорецът се затваря, а провалът остава');
  assert.equal(row.detail, res.catalogWarning, 'едно и също изречение на двете места');
});

test('спряният от предпазната мярка запис се отличава от провалилия се — двата случая искат различно действие', () => {
  const { ipcMain, audit, catalog } = setup();
  catalog.result = { written: false, blocked: true };

  const res = ipcMain.invoke('books:create', NEW({ inv_number: 1 }));
  assert.match(res.catalogWarning, /спрян — фондът в тази база излиза празен/);
  assert.match(res.catalogWarning, /Ръчен запис/, 'казва как се минава нарочно, ако това наистина се иска');
  assert.ok(audit.some(a => a.action === 'Онлайн каталог'));
});

test('несвързана папка за онлайн каталог не е провал — books:create мълчи, а не лъже за грешка (v2.4.58)', () => {
  /* writeCatalogIfConfigured (main.js) връща точно { written: false } — БЕЗ
     error и БЕЗ blocked — когато settings.catalog_folder изобщо не е зададена
     (подразбирането на всяка библиотека, докато не свърже онлайн каталог).
     Старото условие `w.written !== undefined` броеше и този случай за провал,
     тоест ВСЯКО едно постъпление в такава библиотека показваше лъжливото
     „записът на каталога... не успя“, без нито ред да е сгрешен никъде. */
  const { ipcMain, audit, catalog } = setup();
  catalog.result = { written: false };

  const res = ipcMain.invoke('books:create', NEW({ inv_number: 1 }));
  assert.equal(res.ok, true);
  assert.equal(res.catalogWarning, null,
    'несвързана папка не е грешка, за да се съобщава — библиотеката може изобщо да не иска онлайн каталог');
  assert.ok(!audit.some(a => a.action === 'Онлайн каталог'),
    'и в дневника не бива да остане лъжлив ред за провал');
});

test('успешният запис не казва нищо, а стара обвръзка без flushCatalogWrite продължава с отложения запис', () => {
  /* Новото е НЕЗАДЪЛЖИТЕЛНО: подава се от main.js, а по-старите обвръзки, които
     не го знаят, трябва да продължат да работят — същият модел като в
     handlers/deaccession-acts.js. */
  const a = setup();
  assert.equal(a.ipcMain.invoke('books:create', NEW({ inv_number: 1 })).catalogWarning, null,
    'при успешен запис няма какво да се каже');

  const b = setup({ noFlush: true });
  const res = b.ipcMain.invoke('books:create', NEW({ inv_number: 1 }));
  assert.equal(res.ok, true);
  assert.equal(res.catalogWarning, null);
  assert.ok(b.audit.some(a2 => a2.action === '(debounced)'), 'пада обратно към отложения запис');
});

/* ==================================================================
   4. ПРЕДЛОЖЕНИЯТА ЗА ПОКУПКА
   ================================================================== */

function suggest(db, o) {
  const s = Object.assign({ date: '2026-01-15', reader_name: 'Петрова, Мария', author: null,
    title: 'Под игото', status: 'заявено' }, o);
  return db.prepare('INSERT INTO suggestions (date, reader_id, reader_name, author, title, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(s.date, s.reader_id || null, s.reader_name, s.author, s.title, s.status).lastInsertRowid;
}

test('съвпадението хваща ОБЪРНАТИЯ ред на имената — „Вазов, Иван“ на картона срещу „Иван Вазов“ на гишето', () => {
  /* Картонът по чл. 16 иска „Фамилия, Име“, а читателят на гишето казва „Иван
     Вазов“. Затова авторът се сравнява като МНОЖЕСТВО от думи, а не като низ. */
  const { db } = setup();
  suggest(db, { author: 'Иван Вазов', title: 'Под игото' });
  const m = findOpenSuggestionsForBook(db, { title: 'Под игото', author: 'Вазов, Иван' });
  assert.equal(m.length, 1, 'съвпада въпреки обърнатия ред');
  assert.equal(m[0].author_match, true, 'и авторът е потвърден, не само заглавието');
  assert.equal(m[0].reader_name, 'Петрова, Мария');
  assert.equal(m[0].status, 'заявено');
});

test('съвпадението хваща и ИНИЦИАЛА — „Вазов, И.“ срещу „Иван Вазов“', () => {
  const { db } = setup();
  suggest(db, { author: 'Вазов, И.', title: 'Под игото' });
  assert.equal(findOpenSuggestionsForBook(db, { title: 'Под игото', author: 'Иван Вазов' }).length, 1);
});

test('съвпадението не се бърка от регистър, кавички и точка — едно заглавие се въвежда по три начина на едно гише', () => {
  const { db } = setup();
  suggest(db, { title: '„Под игото“', author: null });
  const m = findOpenSuggestionsForBook(db, { title: 'под игото.', author: 'Вазов, Иван' });
  assert.equal(m.length, 1);
  assert.equal(m[0].author_match, false,
    'празният автор от страна на предложението НЕ отменя съвпадението, но се отбелязва');
});

test('ДРУГ автор при същото заглавие НЕ е съвпадение — „Пътеписи“ от двама автори са две различни книги', () => {
  const { db } = setup();
  suggest(db, { author: 'Константинов, Алеко', title: 'Пътеписи' });
  assert.deepEqual(findOpenSuggestionsForBook(db, { title: 'Пътеписи', author: 'Вазов, Иван' }), [],
    'различният автор е различна книга, а не пропуск в набирането');
});

test('затворените предложения не се отварят наново — „отказано“ е решение на библиотеката', () => {
  const { db } = setup();
  suggest(db, { title: 'Под игото', status: 'отказано' });
  suggest(db, { title: 'Под игото', status: 'получено' });
  const open = suggest(db, { title: 'Под игото', status: 'поръчано' });
  const m = findOpenSuggestionsForBook(db, { title: 'Под игото' });
  assert.deepEqual(m.map(x => x.id), [open], 'само отвореното — „поръчано“ още чака книгата');
});

test('вписването НАМИРА предложението, но НЕ пипа статуса му — решението е на човека', () => {
  /* Програмата няма как да знае, че постъпилият „Под игото“ (издание 2019, меки
     корици) е същата книга, която читателят е имал предвид. Автоматичното
     „получено“ би заключило чуждо предложение и би пратило писмо за книга, която
     не е дошла. Затова тук се ТЪРСИ и се ВРЪЩА — същият модел, по който
     програмата вече отказва да отчислява и да сплесква записи без питане. */
  const { db, ipcMain } = setup();
  const sid = suggest(db, { author: 'Иван Вазов', title: 'Под игото' });

  const res = ipcMain.invoke('books:create', NEW({ inv_number: 1, title: 'Под игото', author: 'Вазов, Иван' }));
  assert.equal(res.ok, true);
  assert.equal(res.suggestions.length, 1, 'вписването връща чакащото предложение');
  assert.equal(res.suggestions[0].id, sid);
  assert.equal(res.suggestions[0].reader_name, 'Петрова, Мария', 'и КОЙ го е направил');
  assert.equal(db.prepare('SELECT status FROM suggestions WHERE id = ?').get(sid).status, 'заявено',
    'статусът НЕ се мени сам');

  // Същото и през отделния канал — за картон на вече вписан документ.
  const viaChannel = ok(ipcMain.invoke('suggestions:matchBook', { title: 'Под игото', author: 'Вазов, Иван' }), 'канал');
  assert.equal(viaChannel.length, 1);
  assert.equal(viaChannel[0].id, sid);
});

test('вписване без нито едно чакащо предложение връща празен списък, а не грешка', () => {
  const { ipcMain } = setup();
  const res = ipcMain.invoke('books:create', NEW({ inv_number: 1, title: 'Никой не я е искал' }));
  assert.deepEqual(res.suggestions, []);
});

/* ==================================================================
   5. „ОСТАВАТ“ В ИЗГЛЕДА НА ПАРТИДАТА
   ================================================================== */

const ACQ = (o) => Object.assign({
  id: 1, no: 4, year: '2026', date: '2026-02-01', doc_type: 'фактура', doc_no: '77',
  doc_date: '2026-01-30', how: 'покупка', from_source: 'Книжарница', total_count: 5,
  sum: null, committee1: 'А', items: []
}, o);
const item = (n) => ({ id: n, inv_number: n, title: 'Книга ' + n, author: 'Автор', price: 10, year: '2020' });

async function openBatch(acq) {
  const dom = buildDom({ 'acquisitions.get': () => acq, 'acquisitions.list': [] });
  await settle();
  await dom.window.openAcq(acq.id);
  await settle();
  return dom.window.document.querySelector('#modal').textContent.replace(/\s+/g, ' ');
}

test('„Остават“ показва НАДХВЪРЛЯНЕТО, а не кръгла нула — иначе сгрешената партида изглежда като приключена', async () => {
  /* Партидата е ред в Част № 1 на КДБФ, а обявеният общ брой идва от първичния
     счетоводен документ (фактура, акт за дарение). Инвентиран документ в повече
     значи едно от две: или документ е вписан по грешна партида (и липсва от
     своята), или обявеният брой е сгрешен — и в двата случая КДБФ и фактурата се
     разминават. Разпечатката отдавна го казва; екранът, който се гледа всеки
     ден, мълчеше. */
  const html = await openBatch(ACQ({ total_count: 5, items: [1, 2, 3, 4, 5, 6].map(item) }));
  assert.match(html, /6\s*Инвентирани\s*\+1\s*Над обявения брой/, 'излишъкът се показва като „+1“, а не като 0')
  assert.match(html, /Над обявения брой/, 'и с ДРУГ надпис — за да не може да се сбърка с остатък');
  assert.match(html, /Изброените надхвърлят обявения брой с 1/, 'под картите стои и обяснението');
  assert.match(html, /вписан по грешна партида/, 'с двете възможни причини');
});

test('изрядната и недовършената партида продължават да четат както преди — нулата вече значи само едно', async () => {
  const done = await openBatch(ACQ({ total_count: 5, items: [1, 2, 3, 4, 5].map(item) }));
  assert.match(done, /5\s*Инвентирани\s*0\s*Остават/, 'точно колкото пише в документа')
  assert.ok(!/Над обявения брой/.test(done));

  const partial = await openBatch(ACQ({ total_count: 5, items: [1, 2].map(item) }));
  assert.match(partial, /2\s*Инвентирани\s*3\s*Остават/, 'три още не са инвентирани')
  assert.ok(!/надхвърлят обявения брой/.test(partial));
});

/* ==================================================================
   6. МЕНЮТО „ОТДЕЛ“
   ================================================================== */

test('отдел, в който са останали САМО отчислени документи, изпада от падащия филтър', () => {
  /* Отчисленият документ пази отдела си нарочно — той е част от снимката и от
     справките за минали години. Но менюто отговаря на въпроса „къде да търся
     книга“, а там отговорът е само фондът: дотук изборът на такъв отдел връщаше
     точно отчислените документи. */
  const { db, ipcMain } = setup();
  const mk = (inv, dept) => {
    const id = db.prepare(`INSERT INTO books (inv_number, title, register_date, status, status_date, department)
      VALUES (?, ?, '2026-02-01', 'наличен', '2026-02-01', ?)`).run(inv, 'Книга ' + inv, dept).lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
    return id;
  };
  const gone = mk(1, 'Стар фонд');
  mk(2, 'Заемна');
  const mixedOff = mk(3, 'Детски');
  mk(4, 'Детски');

  const before = ok(ipcMain.invoke('books:list', '', 'title', { offset: 0, limit: 100 }), 'преди');
  assert.deepEqual(before.depts, ['Детски', 'Заемна', 'Стар фонд']);

  ok(ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-06-10', reason_code: 3, reason_text: 'изхабени', disposal: 'вторични суровини',
      committee1: 'А', committee2: 'Б', committee3: 'В' },
    bookIds: [gone, mixedOff]
  }), 'акт');

  const after = ok(ipcMain.invoke('books:list', '', 'title', { offset: 0, limit: 100 }), 'след');
  assert.deepEqual(after.depts, ['Детски', 'Заемна'],
    '„Стар фонд“ пада (само отчислени), „Детски“ остава (има и жив документ)');
  assert.equal(after.total, 4, 'самият списък продължава да показва и отчислените — те се четат и след акта');
});
