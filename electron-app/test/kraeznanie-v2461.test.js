'use strict';
/* Одитен кръг v2.4.61 — КРАЕЗНАНИЕ: ЛЕТОПИС, ПЕРСОНАЛИИ, АНАЛИТИЧНО ОПИСАНИЕ,
 * ВРЪЗКИ, СНИМКИ.
 * =====================================================================
 * Сценарият на кръга (test/scenario-kraeznanie.test.js) минава пътя на краеведа
 * от „+ Нов запис“ до разпечатания летопис и остави находки от четири вида:
 *
 *   • СВЕДЕНИЕ, КОЕТО ВЛИЗА В КРАЕВЕДСКИЯ МАСИВ ГРЕШНО И НИКОЙ НЕ РАЗБИРА —
 *     основаването на читалището (24.05.1922) се завеждаше в 2026 г., защото
 *     формата предлага текущата година; дата „24.05.1926“ ставаше година „24.0“;
 *     персоналия умираше преди да се роди; статия имаше година „abc“ и страници
 *     „-5“. Краеведският масив е ЕДИНСТВЕНИЯТ, който не може да се получи отвън
 *     — сгрешеното сведение тук не се сверява с нищо.
 *
 *   • ТЪРСАЧКА, КОЯТО ОТГОВАРЯ ГРЕШНО, БЕЗ ДА ЛИЧИ — „основаване“ не намираше
 *     „Основаване…“ (LIKE не знае кирилицата), а „%“ връщаше целия раздел.
 *     Човекът вижда списък и няма как да разбере, че това не е отговорът.
 *
 *   • ДЕЙСТВИЕ БЕЗ СЛЕДА И БЕЗ ВЪПРОС — връзките и снимките не се вписваха в
 *     одитния дневник, „Махни“ не питаше, а изтриване на несъществуващ запис
 *     се отчиташе като успех.
 *
 *   • ДОКУМЕНТ НА ХАРТИЯ, КОЙТО НЕ Е ТОВА, ЗА КОЕТО СЕ ПРЕДСТАВЯ — летописната
 *     книга се печаташе в обратен ред, без номера, без източници и без сбор;
 *     указателят на статиите — без УДК и ключови думи.
 *
 * Тук стои по един тест на находка, кръстен на дефекта, а не на кода.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  APP_DIR, freshDb, mkTmpDir, fakeIpcMain, runDep, cleanupTmpDirs, buildDom, settle, printed
} = require('./helpers/audit-fixtures');
const { csvCell } = require('../security-utils');

test.after(cleanupTmpDirs);

const TODAY = '2026-09-18';
const LOGO_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MAX_PHOTO = 1024 * 1024;

/* Истинските краеведски обработчици върху прясна база — без Electron, без
   прозорец. dialogs.openPaths подава „избрания“ файл на localPhoto:choose. */
function setup() {
  const { db, dir } = freshDb('inv-kraeznanie-v2461-');
  const audit = [];
  const dialogs = { openPaths: null, savePath: null };
  const deps = {
    getDb: () => db, run: runDep,
    logAudit: (action, detail) => audit.push({ action, detail }),
    today: () => TODAY, csvCell, fs, path,
    getMainWindow: () => ({}),
    dialog: {
      showOpenDialog: async () => (dialogs.openPaths
        ? { canceled: false, filePaths: dialogs.openPaths }
        : { canceled: true, filePaths: [] }),
      showSaveDialog: async () => (dialogs.savePath
        ? { canceled: false, filePath: dialogs.savePath }
        : { canceled: true, filePath: null })
    },
    LOGO_MIME, LOCAL_PHOTO_MAX_BYTES: MAX_PHOTO
  };
  const ipcMain = fakeIpcMain();
  for (const m of ['analytics', 'persons', 'chronicle', 'export-all']) {
    require(path.join(APP_DIR, 'handlers', m))(ipcMain, deps);
  }
  /* links и local-photo НЕ получават logAudit — точно както ги вика main.js.
     Затова следата им отива направо в audit_log (виж бележките в двата модула)
     и тестовете по-долу я четат от таблицата, а не от списъка `audit`. */
  const bezAudit = Object.assign({}, deps);
  delete bezAudit.logAudit;
  for (const m of ['links', 'local-photo']) {
    require(path.join(APP_DIR, 'handlers', m))(ipcMain, bezAudit);
  }
  return { db, dir, ipcMain, audit, dialogs };
}
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };
const bad = (res, what) => { assert.equal(res.ok, false, what + ' — прието е, а не биваше'); return res.error; };
const auditRows = (db, like) => db.prepare("SELECT * FROM audit_log WHERE action LIKE ? OR detail LIKE ?").all(like, like);

/* ==================================================================
   1. ГОДИНАТА, ДАТАТА И ЧИСЛАТА НА КРАЕВЕДСКИЯ ЗАПИС
   ================================================================== */

test('запис с точна дата 24.05.1922 не остава в предложената от формата 2026 г.', async () => {
  const { ipcMain, db } = setup();
  // Точно това, което подава формата: предложената текуща година + въведена стара дата.
  const id = ok(await ipcMain.invoke('chronicle:create', { title: 'Основаване на читалището', date: '1922-05-24' }), 'без година');
  assert.equal(db.prepare('SELECT year FROM chronicle WHERE id = ?').get(id).year, '1922',
    'годината се извежда от датата, когато полето е празно');
  // Свободният текст, който вече СЪДЪРЖА годината на датата, не се пипа.
  const id2 = ok(await ipcMain.invoke('chronicle:create', { title: 'Сбирка', year: 'ок. 1930', date: '1930-06-01' }), 'ок. 1930');
  assert.equal(db.prepare('SELECT year FROM chronicle WHERE id = ?').get(id2).year, 'ок. 1930');
});

test('разминаване между годината и точната дата се отказва, вместо да се поправя мълчаливо', async () => {
  const { ipcMain } = setup();
  const err = bad(await ipcMain.invoke('chronicle:create', { title: 'Разминаване', year: '1950', date: '1951-03-03' }), 'година 1950 с дата от 1951');
  assert.match(err, /не отговаря на датата/);
  assert.match(err, /Поправете едното от двете/, 'съобщението казва какво да се направи');
});

test('датата на летописен запис се проверява: „24.05.1926“ и 30.02.1930 не стават година „24.0“', async () => {
  const { ipcMain } = setup();
  assert.match(bad(await ipcMain.invoke('chronicle:create', { title: 'Български изпис', date: '24.05.1926' }), 'дата 24.05.1926'),
    /не е валидна дата/);
  assert.match(bad(await ipcMain.invoke('chronicle:create', { title: 'Тридесети февруари', date: '1930-02-30' }), 'дата 30.02.1930'),
    /не е валидна дата/);
});

test('година „abc“ не влиза в летописа, а „ок. 1930“ остава възможна', async () => {
  const { ipcMain } = setup();
  assert.match(bad(await ipcMain.invoke('chronicle:create', { title: 'Година abc', year: 'abc' }), 'year=abc'),
    /не съдържа година/);
  ok(await ipcMain.invoke('chronicle:create', { title: 'Първа сбирка', year: 'ок. 1930' }), 'свободният текст остава');
  ok(await ipcMain.invoke('chronicle:create', { title: 'Обхват', year: '1878 – 1880' }), 'период също');
});

test('персоналия: дата „12.03.1890“ и смърт преди раждане се отказват', async () => {
  const { ipcMain } = setup();
  assert.match(bad(await ipcMain.invoke('persons:create', { name: 'Невалидна дата', birth_date: '12.03.1890' }), 'дата не по ISO'),
    /не е валидна дата на раждане/);
  assert.match(bad(await ipcMain.invoke('persons:create', { name: 'Обърнати дати', birth_date: '1950-01-01', death_date: '1940-01-01' }), 'смърт преди раждане'),
    /преди датата на раждане/);
  ok(await ipcMain.invoke('persons:create', { name: 'Само година на смъртта', death_date: '1961-07-01' }), 'само едната дата е нормално');
});

test('аналитично описание: година „abc“, страници „-5“ и дата на броя „27.05.2022“ се отказват', async () => {
  const { ipcMain } = setup();
  const p = ok(await ipcMain.invoke('persons:create', { name: 'Опора' }), 'опора');
  assert.ok(p);
  assert.match(bad(await ipcMain.invoke('analytics:create', { title: 'Лоша година', year: 'abc', source_kind: 'друго' }), 'year=abc'),
    /не съдържа година/);
  assert.match(bad(await ipcMain.invoke('analytics:create', { title: 'Лоши страници', pages: '-5', source_kind: 'друго' }), 'pages=-5'),
    /не са страници/);
  assert.match(bad(await ipcMain.invoke('analytics:create', { title: 'Лоша дата', issue_date: '27.05.2022', source_kind: 'друго', source_text: 'х' }), 'issue_date'),
    /не е валидна дата/);
  ok(await ipcMain.invoke('analytics:create', { title: 'Добра', year: '1999', pages: '12 – 14', issue_date: '1999-04-01', source_kind: 'друго', source_text: 'Родна реч' }), 'нормалните стойности минават');
});

test('описание с вид „книга“ без книга (и „периодика“ без издание) не се записва с източник „—“', async () => {
  const { ipcMain, db } = setup();
  const bookId = db.prepare("INSERT INTO books (title, author) VALUES ('Яворец през вековете', 'Петров')").run().lastInsertRowid;
  assert.match(bad(await ipcMain.invoke('analytics:create', { title: 'Без книга', source_kind: 'книга' }), 'книга без книга'),
    /книга от фонда не е избрана/);
  assert.match(bad(await ipcMain.invoke('analytics:create', { title: 'Без издание', source_kind: 'периодика' }), 'периодика без издание'),
    /периодично издание не е избрано/);
  ok(await ipcMain.invoke('analytics:create', { title: 'С книга', source_kind: 'книга', book_id: bookId }), 'с избрана книга');
  ok(await ipcMain.invoke('analytics:create', { title: 'Със свободен текст', source_kind: 'книга', source_text: '100 вести, бр. 145' }),
    'свободният текст е пълноправен източник');
});

/* ==================================================================
   2. ОТЧИСЛЕНАТА КНИГА-ИЗТОЧНИК: „1“ срещу 1
   ================================================================== */

test('редакция само на бележката при отчислена книга-източник не е „пренасочване“ (book_id идва като низ)', async () => {
  const { ipcMain, db } = setup();
  const bookId = db.prepare("INSERT INTO books (title, author, inv_number, status) VALUES ('Яворец през вековете', 'Петров', 1, 'наличен')").run().lastInsertRowid;
  const id = ok(await ipcMain.invoke('analytics:create', { title: 'Читалищното дело', source_kind: 'книга', book_id: bookId, year: '1985' }), 'описание');
  // Книгата се отчислява с утвърден акт — описанието правилно остава.
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date) VALUES (7, '2026', ?)").run(TODAY).lastInsertRowid;
  db.prepare("UPDATE books SET status = 'отчислен', deaccession_act_id = ? WHERE id = ?").run(actId, bookId);
  // Точно това подава прозорецът: скритото поле book_id е ТЕКСТ.
  const cur = ok(await ipcMain.invoke('analytics:get', id), 'get');
  ok(await ipcMain.invoke('analytics:update', Object.assign({}, cur, { note: 'поправен правопис', book_id: String(bookId) })),
    'редакция на бележката при отчислен източник');
  assert.equal(db.prepare('SELECT note FROM analytics WHERE id = ?').get(id).note, 'поправен правопис');
  // А истинското пренасочване към ДРУГА отчислена книга си остава отказано.
  const other = db.prepare("INSERT INTO books (title, status, deaccession_act_id) VALUES ('Друга', 'отчислен', ?)").run(actId).lastInsertRowid;
  assert.match(bad(await ipcMain.invoke('analytics:update', Object.assign({}, cur, { book_id: String(other) })), 'пренасочване'),
    /не може да бъде пренасочено/);
});

test('book_id и periodical_id се записват като числа, а не като текст от скритото поле', async () => {
  const { ipcMain, db } = setup();
  const bookId = db.prepare("INSERT INTO books (title) VALUES ('Кн.')").run().lastInsertRowid;
  const perId = db.prepare("INSERT INTO periodicals (title) VALUES ('Родна реч')").run().lastInsertRowid;
  const id = ok(await ipcMain.invoke('analytics:create', {
    title: 'Статия', source_kind: 'книга', book_id: String(bookId), periodical_id: String(perId)
  }), 'създаване с текстови id-та');
  const row = db.prepare('SELECT typeof(book_id) AS tb, typeof(periodical_id) AS tp FROM analytics WHERE id = ?').get(id);
  assert.equal(row.tb, 'integer', 'book_id е число в базата');
  assert.equal(row.tp, 'integer', 'periodical_id е число в базата');
});

/* ==================================================================
   3. ТЪРСЕНЕТО: КИРИЛИЦА И LIKE-ЗАМЕСТИТЕЛИ
   ================================================================== */

test('търсенето в краезнанието намира кирилица с малки букви („основаване“ → „Основаване…“)', async () => {
  const { ipcMain, db } = setup();
  db.prepare("INSERT INTO books (title, author, inv_number) VALUES ('Яворец през вековете', 'Петров, Георги', 1)").run();
  ok(await ipcMain.invoke('chronicle:create', { title: 'Основаване на читалището', year: '1922' }), 'летопис');
  ok(await ipcMain.invoke('persons:create', { name: 'Петров, Георги Иванов' }), 'персоналия');
  ok(await ipcMain.invoke('analytics:create', { title: 'Яворец празнува', source_kind: 'друго', source_text: 'х' }), 'статия');
  assert.equal(ok(await ipcMain.invoke('chronicle:list', { q: 'основаване' }), 'летопис').length, 1);
  assert.equal(ok(await ipcMain.invoke('persons:list', 'петров'), 'персоналии').length, 1);
  assert.equal(ok(await ipcMain.invoke('analytics:list', { q: 'яворец' }), 'статии').length, 1);
  assert.equal(ok(await ipcMain.invoke('links:search', { kind: 'книга', q: 'яворец' }), 'книги').length, 1);
  assert.equal(ok(await ipcMain.invoke('links:search', { kind: 'персона', q: 'петров' }), 'персони').length, 1);
});

test('„%“ и „_“ в текста на търсенето са знаци, а не LIKE-заместители', async () => {
  const { ipcMain, db } = setup();
  db.prepare("INSERT INTO books (title, inv_number) VALUES ('Под игото', 2)").run();
  db.prepare("INSERT INTO books (title, inv_number) VALUES ('100% истина_за_селото', 3)").run();
  ok(await ipcMain.invoke('chronicle:create', { title: 'Нова читалня', year: '2026' }), 'летопис');
  ok(await ipcMain.invoke('persons:create', { name: "O'Neil, Джон", bio: '100% местен' }), 'персоналия');
  ok(await ipcMain.invoke('analytics:create', { title: 'Кооперацията', source_kind: 'друго', source_text: 'х' }), 'статия');
  assert.equal(ok(await ipcMain.invoke('chronicle:list', { q: '%' }), 'летопис %').length, 0, '„%“ не връща целия летопис');
  assert.equal(ok(await ipcMain.invoke('chronicle:list', { q: 'Н_ва' }), 'летопис _').length, 0, '„_“ не е заместител');
  assert.equal(ok(await ipcMain.invoke('persons:list', '%'), 'персоналии %').length, 1, 'намира се само истинският знак „%“');
  assert.equal(ok(await ipcMain.invoke('analytics:list', { q: '%' }), 'статии %').length, 0);
  assert.equal(ok(await ipcMain.invoke('links:search', { kind: 'книга', q: '%' }), 'книги %').length, 1, 'само книгата със знака „%“');
  assert.equal(ok(await ipcMain.invoke('links:search', { kind: 'книга', q: 'Под_игото' }), 'книги _').length, 0);
  assert.equal(ok(await ipcMain.invoke('links:search', { kind: 'книга', q: 'истина_за' }), 'истинска подчертавка').length, 1);
});

test('търсенето в летописа хваща и „Източници“, а в статиите — подзаглавие, УДК и брой', async () => {
  const { ipcMain } = setup();
  ok(await ipcMain.invoke('chronicle:create', { title: 'Основаване', year: '1922', sources: 'Протокол № 1/1922', note: 'сверено с оригинала' }), 'летопис');
  ok(await ipcMain.invoke('analytics:create', {
    title: 'Народните носии', subtitle: 'репортаж', udk: '391(497.2)', issue: '21',
    source_kind: 'друго', source_text: 'Родна реч'
  }), 'статия');
  assert.equal(ok(await ipcMain.invoke('chronicle:list', { q: 'протокол' }), 'по източник').length, 1);
  assert.equal(ok(await ipcMain.invoke('chronicle:list', { q: 'сверено' }), 'по забележка').length, 1);
  assert.equal(ok(await ipcMain.invoke('analytics:list', { q: 'репортаж' }), 'по подзаглавие').length, 1);
  assert.equal(ok(await ipcMain.invoke('analytics:list', { q: '391(497.2)' }), 'по УДК').length, 1);
  assert.equal(ok(await ipcMain.invoke('analytics:list', { q: '21' }), 'по брой').length, 1);
});

test('годините се подреждат по число, а не по текст („ок. 1930“ не излиза пред 2026)', async () => {
  const { ipcMain } = setup();
  for (const y of ['1922', 'ок. 1930', '2026', '900']) {
    ok(await ipcMain.invoke('chronicle:create', { title: 'Запис ' + y, year: y }), y);
  }
  const years = ok(await ipcMain.invoke('chronicle:years'), 'години').map(y => y.year);
  assert.deepEqual(years, ['2026', 'ок. 1930', '1922', '900'], 'подредба по числото на годината');
  const list = ok(await ipcMain.invoke('chronicle:list', {}), 'списък').map(c => c.year);
  assert.deepEqual(list, ['2026', 'ок. 1930', '1922', '900'], 'същата подредба и в списъка на екрана');
});

test('и УКАЗАТЕЛЯТ НА СТАТИИТЕ се подрежда по числото на годината, не по текста ѝ', async () => {
  /* Същият дефект и същата поправка (собствена SQL-функция yearkey), но в друг
     модул — handlers/analytics.js. Летописът и указателят се четат един до друг
     в краеведската справка и не бива да се подреждат по различен начин; а
     дотук нищо не пазеше втория, тоест функцията му можеше да отпадне
     незабелязано и „ок. 1930“ пак да излиза пред 2026 г. */
  const { ipcMain } = setup();
  for (const y of ['1922', 'ок. 1930', '2026', '900']) {
    ok(await ipcMain.invoke('analytics:create', { title: 'Статия ' + y, source_kind: 'друго', source_text: 'ръкопис', year: y }), y);
  }
  const years = ok(await ipcMain.invoke('analytics:years'), 'години').map(y => y.year);
  assert.deepEqual(years, ['2026', 'ок. 1930', '1922', '900'], 'подредба по числото на годината');
  const list = ok(await ipcMain.invoke('analytics:list', {}), 'списък').map(a => a.year);
  assert.deepEqual(list, ['2026', 'ок. 1930', '1922', '900'], 'същата подредба и в списъка на екрана');
});

/* ==================================================================
   4. ВРЪЗКИТЕ: СИРАЦИ, ЕТИКЕТ, ИНВЕНТАРЕН НОМЕР, СЛЕДА
   ================================================================== */

test('връзка към (и от) несъществуващ запис не се приема — сираци „(изтрит запис)“ не се раждат', async () => {
  const { ipcMain, db } = setup();
  const personId = ok(await ipcMain.invoke('persons:create', { name: 'Петров' }), 'персоналия');
  const bookId = db.prepare("INSERT INTO books (title) VALUES ('Кн.')").run().lastInsertRowid;
  assert.match(bad(await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: 999999 }), 'към несъществуваща книга'),
    /не съществува в базата/);
  assert.match(bad(await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: 777777, toKind: 'книга', toId: bookId }), 'от несъществуваща персоналия'),
    /вече не съществува/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM links').get().n, 0, 'нито един ред не е влязъл');
  ok(await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId }), 'истинската връзка минава');
});

test('книга без инвентарен номер получава ЕДИН и същ етикет от links:search и от links:list', async () => {
  const { ipcMain, db } = setup();
  const personId = ok(await ipcMain.invoke('persons:create', { name: 'Петров' }), 'персоналия');
  const bookId = db.prepare("INSERT INTO books (title, author) VALUES ('Без номер', 'Аноним')").run().lastInsertRowid;
  const found = ok(await ipcMain.invoke('links:search', { kind: 'книга', q: 'Без номер' }), 'търсене');
  ok(await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId }), 'връзка');
  const listed = ok(await ipcMain.invoke('links:list', { fromKind: 'персона', fromId: personId }), 'списък');
  assert.equal(listed[0].label, found[0].label,
    'прозорецът „Аналитично описание“ сравнява точно тези два низа знак по знак');
  assert.doesNotMatch(listed[0].label, /инв\. № —/, 'липсващият номер се пропуска, а не се изписва като „—“');
  /* И никакъв друг заместител на липсващия номер: „инв. № null“ / „инв. № undefined“
     е същият дефект, само с друга дума. Празната скоба на етикета се проверява
     по СЪСТАВА му, а не по един конкретен низ — етикетът е и текстът, по който
     прозорецът сверява двата списъка знак по знак. */
  assert.doesNotMatch(listed[0].label, /инв\. №/,
    'документ без инвентарен номер не бива да носи „инв. №“ изобщо: ' + listed[0].label);
  assert.equal(listed[0].label, 'Аноним. Без номер', 'етикетът е само авторът и заглавието');
  // А документът, който ИМА номер, продължава да го носи отпред.
  const withNo = db.prepare("INSERT INTO books (title, author, inv_number) VALUES ('С номер', 'Вазов', 44)").run().lastInsertRowid;
  ok(await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: withNo }), 'втора връзка');
  const both = ok(await ipcMain.invoke('links:list', { fromKind: 'персона', fromId: personId }), 'списък');
  assert.ok(both.some(l => l.label === 'инв. № 44 · Вазов. С номер'),
    'номерът стои отпред, когато го има: ' + JSON.stringify(both.map(l => l.label)));
});

test('търсене по инвентарен номер връща документа с този номер, а не всяко заглавие, в което има цифрата', async () => {
  const { ipcMain, db } = setup();
  db.prepare("INSERT INTO books (title, author, inv_number) VALUES ('Яворец през вековете', 'Петров, Георги', 1)").run();
  db.prepare("INSERT INTO books (title, inv_number) VALUES ('100% истина', 3)").run();
  const byPrefix = ok(await ipcMain.invoke('links:search', { kind: 'книга', q: 'инв. № 1' }), 'с представка');
  assert.equal(byPrefix.length, 1, 'намереното: ' + JSON.stringify(byPrefix.map(b => b.label)));
  assert.equal(byPrefix[0].label, 'инв. № 1 · Петров, Георги. Яворец през вековете');
  const bare = ok(await ipcMain.invoke('links:search', { kind: 'книга', q: '1' }), 'голо число');
  assert.equal(bare.length, 1, 'едноцифреният номер е истинско питане');
  // Голо число без такъв инвентарен номер пада обратно към заглавието — иначе
  // „1985“ в заглавие не би се намирало.
  db.prepare("INSERT INTO books (title, inv_number) VALUES ('Сборник 1985', 9)").run();
  assert.equal(ok(await ipcMain.invoke('links:search', { kind: 'книга', q: '1985' }), '1985').length, 1);
});

test('добавянето и махането на връзка оставят следа в одитния дневник', async () => {
  const { ipcMain, db } = setup();
  const personId = ok(await ipcMain.invoke('persons:create', { name: 'Петров, Георги' }), 'персоналия');
  const bookId = db.prepare("INSERT INTO books (title, inv_number) VALUES ('Под игото', 2)").run().lastInsertRowid;
  ok(await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId }), 'връзка');
  const added = auditRows(db, '%връзк%');
  assert.equal(added.length, 1, 'нова връзка → един ред');
  assert.match(added[0].detail, /Петров, Георги/);
  assert.match(added[0].detail, /инв\. № 2 · Под игото/);
  const linkId = db.prepare('SELECT id FROM links').get().id;
  ok(await ipcMain.invoke('links:delete', linkId), 'махане');
  assert.equal(auditRows(db, '%връзк%').length, 2, 'махането също оставя ред');
  assert.match(bad(await ipcMain.invoke('links:delete', linkId), 'повторно махане'), /вече е махната/);
});

test('изтриване на несъществуващ летописен запис не се отчита като успех и не се вписва като изтриване', async () => {
  const { ipcMain, audit } = setup();
  const id = ok(await ipcMain.invoke('chronicle:create', { title: 'Временен запис', year: '1999' }), 'запис');
  ok(await ipcMain.invoke('chronicle:delete', id), 'първото изтриване');
  const n = audit.filter(a => /изтрит запис/.test(a.detail)).length;
  assert.match(bad(await ipcMain.invoke('chronicle:delete', id), 'повторно изтриване'), /вече е изтрит от друго работно място/);
  assert.equal(audit.filter(a => /изтрит запис/.test(a.detail)).length, n, 'втори ред за същото изтриване не се вписва');
});

/* ==================================================================
   5. СНИМКИТЕ
   ================================================================== */

test('липсващ файл за снимка се обяснява на български, а не с „ENOENT: no such file“', async () => {
  const { ipcMain, dialogs, dir } = setup();
  const personId = ok(await ipcMain.invoke('persons:create', { name: 'Петров' }), 'персоналия');
  dialogs.openPaths = [path.join(dir, 'nyama.png')];
  const err = (await ipcMain.invoke('localPhoto:choose', { table: 'persons', id: personId })).error;
  assert.doesNotMatch(err, /ENOENT|no such file/);
  assert.match(err, /вече не е на това място/);
  assert.match(err, /флашка|мрежова папка/, 'казва и къде да се търси причината');
});

test('снимка към несъществуващ запис не се отчита като „Снимката е добавена“', async () => {
  const { ipcMain, dialogs, dir } = setup();
  const png = path.join(dir, 'portret.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  dialogs.openPaths = [png];
  const res = await ipcMain.invoke('localPhoto:choose', { table: 'chronicle', id: 999999 });
  assert.equal(res.ok, false);
  assert.match(res.error, /вече не съществува/);
  assert.match(res.error, /НЕ е запазена/);
});

test('файл от 1 048 577 байта не се отказва със „Файлът е 1024 KB, а максимумът е 1024 KB“', async () => {
  const { ipcMain, dialogs, dir } = setup();
  const personId = ok(await ipcMain.invoke('persons:create', { name: 'Петров' }), 'персоналия');
  const big = path.join(dir, 'golyama.jpg');
  fs.writeFileSync(big, Buffer.alloc(MAX_PHOTO + 1));
  dialogs.openPaths = [big];
  const err = (await ipcMain.invoke('localPhoto:choose', { table: 'persons', id: personId })).error;
  assert.match(err, /максимумът е 1024 KB/);
  assert.doesNotMatch(err, /е 1024 KB, а максимумът е 1024 KB/, 'числата не бива да излизат равни');
  assert.match(err, /Файлът е 1025 KB/);
});

test('добавянето и махането на снимка оставят следа в одитния дневник', async () => {
  const { ipcMain, db, dialogs, dir } = setup();
  const personId = ok(await ipcMain.invoke('persons:create', { name: 'Петров' }), 'персоналия');
  const png = path.join(dir, 'portret.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  dialogs.openPaths = [png];
  ok(await ipcMain.invoke('localPhoto:choose', { table: 'persons', id: personId }), 'снимка');
  ok(await ipcMain.invoke('localPhoto:clear', { table: 'persons', id: personId }), 'махане');
  const rows = auditRows(db, '%снимк%');
  assert.equal(rows.length, 2, 'по един ред за добавяне и за махане');
  assert.match(rows[0].detail, /добавена снимка към персоналия/);
  assert.match(rows[1].detail, /махната снимка от персоналия/);
});

/* ==================================================================
   6. ХАРТИЯТА И ЕКРАНЪТ
   ================================================================== */

test('разпечатаният летопис върви възходящо, с номера, източници и сбор за годината', async () => {
  // Списъкът идва от chronicle:list — най-новото отгоре (вярно за екрана).
  const rows = [
    { id: 4, year: '1972', date: '1972-05-24', title: 'Юбилей', category: 'юбилей', sources: 'Протокол № 3/1972' },
    { id: 5, year: '1972', date: '1972-01-15', title: 'Ремонт на салона', category: 'строителство' },
    { id: 6, year: '1972', title: 'Дарение на 200 тома', category: 'дарение' },
    { id: 1, year: '1922', date: '1922-05-24', title: 'Основаване на читалището', sources: 'Протокол № 1/1922' }
  ];
  const dom = buildDom({ 'chronicle.list': rows, 'chronicle.years': [] });
  const { window } = dom;
  await settle();
  await window.printChronicle();
  await settle();
  const t = printed(window);
  assert.ok(t.indexOf('Основаване на читалището') < t.indexOf('Ремонт на салона'), 'годините: 1922 преди 1972');
  assert.ok(t.indexOf('Ремонт на салона') < t.indexOf('Юбилей'),
    'вътре в 1972 г.: 15.01 преди 24.05 — летописът се чете отпред назад');
  assert.ok(t.indexOf('Юбилей') < t.indexOf('Дарение на 200 тома'), 'записът без точна дата е накрая на годината');
  assert.match(t, /№ 1\. Ремонт на салона/, 'записите са номерирани в рамките на годината');
  assert.match(t, /№ 3\. Дарение на 200 тома/);
  assert.match(t, /Източници: Протокол № 1\/1922/, 'източникът го има на екрана — вече и на хартия');
  assert.match(t, /Общо за 1972 г\.: 3 записа/, 'годишен сбор — личи дали листът е пълен');
  assert.match(t, /Общо за 1922 г\.: 1 запис\./, 'един запис е „запис“, не „записа“');
});

test('указателят на статиите излиза с УДК и ключови думи, а таблицата на екрана има колона УДК', async () => {
  const rows = [{
    id: 1, title: 'Народните носии от Яворец', author: 'Иванова, Мария', year: '1999', is_local: 1,
    source_kind: 'периодика', periodical_title: 'Родна реч', issue: '4', issue_date: '1999-04-01',
    pages: '12 – 14', udk: '391(497.2)', keywords: 'носии, етнография'
  }];
  const dom = buildDom({ 'analytics.list': rows, 'analytics.years': [] });
  const { window } = dom;
  await settle();
  window.location.hash = '#analytics';
  await window.route();
  await settle();
  const head = window.document.querySelector('#view thead').textContent;
  assert.match(head, /УДК/, 'въведеният УДК трябва да се вижда и да може да се провери');
  assert.match(window.document.querySelector('#anlBody').textContent, /391\(497\.2\)/);
  await window.printAnalytics();
  await settle();
  const t = printed(window);
  assert.match(t, /УДК 391\(497\.2\)/, 'УДК е реквизит на аналитичното описание');
  assert.match(t, /Ключови думи: носии, етнография/, 'по тях се влиза в краеведския масив по тема');
  assert.match(t, /Родна реч, бр\. 4 от 01\.04\.1999, стр\. 12 – 14/, 'източникът остава непокътнат');
});

test('картонът на персоналията на хартия носи и свързаните материали', async () => {
  const dom = buildDom({
    'persons.list': [{ id: 1, name: 'Петров, Георги Иванов', activity: 'учител', sources: 'Летопис на училището' }],
    'links.list': [
      { id: 1, to_kind: 'книга', label: 'инв. № 1 · Петров, Георги. Яворец през вековете' },
      { id: 2, to_kind: 'летопис', label: '1922 — Основаване на читалището' }
    ]
  });
  const { window } = dom;
  await settle();
  await window.printPersons();
  await settle();
  const t = printed(window);
  assert.match(t, /Свързани материали: книга: инв\. № 1 · Петров, Георги\. Яворец през вековете; летопис: 1922 — Основаване/);
});

test('отложеното търсене (300 ms) не изчертава краеведски раздел върху вече отворен друг', async () => {
  const dom = buildDom({
    'chronicle.list': [], 'chronicle.years': [], 'persons.list': [], 'analytics.list': [], 'analytics.years': []
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#chronicle';
  await window.route();
  await settle();
  const before = dom.calls['chronicle.list'].length;
  window.chrSearch('Ремонт');            // задейства 300 ms отлагане
  window.location.hash = '#persons';     // и веднага се сменя разделът
  await window.route();
  await new Promise(r => setTimeout(r, 400));
  await settle();
  assert.equal(dom.calls['chronicle.list'].length, before, 'закъснялото търсене не пита базата за чужд раздел');
  assert.match(window.document.querySelector('#view').textContent, /Персоналии\./, 'на екрана си остава разделът, който е отворен');
});

test('панелът „Свързани материали“ маха представката „инв. №“ и търси и по едноцифрен номер', async () => {
  const dom = buildDom({
    'persons.get': { id: 1, name: 'Петров' }, 'links.list': [],
    'links.search': ([a]) => (a.q === '2' ? [{ id: 9, label: 'инв. № 2 · Вазов, Иван. Под игото' }] : [])
  });
  const { window } = dom;
  await settle();
  await window.personView(1);
  await settle();
  window.document.querySelector('#lnkKind').value = 'книга';
  const q = window.document.querySelector('#lnkQ');
  q.value = 'инв. № 2';
  await window.lnkSearch();
  await settle();
  assert.equal(dom.calls['links.search'].at(-1).q, '2', 'на канала се подава самият номер');
  assert.equal(window.document.querySelector('#lnkPick').options[0].text, 'инв. № 2 · Вазов, Иван. Под игото');
  q.value = '2';
  await window.lnkSearch();
  await settle();
  assert.equal(dom.calls['links.search'].at(-1).q, '2', 'едноцифреният номер вече не се спъва в прага от два знака');
});

test('„Махни“ на връзка пита, преди да я премахне', async () => {
  const dom = buildDom({
    'persons.get': { id: 1, name: 'Петров' },
    'links.list': [{ id: 5, to_kind: 'книга', label: 'инв. № 2 · Вазов, Иван. Под игото' }]
  });
  const { window } = dom;
  await settle();
  const asked = [];
  window.confirm = (msg) => { asked.push(String(msg)); return false; };
  await window.personView(1);
  await settle();
  const btn = Array.from(window.document.querySelectorAll('#linkList button')).find(b => b.textContent === 'Махни');
  btn.click();
  await settle();
  assert.equal(asked.length, 1, 'въпрос преди махането');
  assert.match(asked[0], /Под игото/, 'въпросът казва КОЯ връзка се маха');
  assert.equal(dom.calls['links.delete'], undefined, 'отказаният въпрос не маха нищо');
});

/* ==================================================================
   7. ПЪЛНИЯТ ИЗНОС
   ================================================================== */

test('в ПРОЧЕТИ-МЕ.txt таблицата „links“ е краеведският указател, а не „Полезни връзки“', async () => {
  const { ipcMain, dir, dialogs } = setup();
  dialogs.savePath = path.join(dir, 'iznos.zip');
  ok(await ipcMain.invoke('exportAll:run'), 'износ');
  const buf = fs.readFileSync(dialogs.savePath);
  // Минимален четец на ZIP — само локалните заглавни блокове (както в сценария).
  const files = new Map();
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + compSize);
    files.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    off = start + compSize;
  }
  const readme = files.get('PROCHETI-ME.txt').toString('utf8');
  assert.doesNotMatch(readme, /vrazki\.csv[^\n]*Полезни връзки/, 'в тази таблица няма нито един интернет адрес');
  assert.match(readme, /vrazki\.csv[^\n]*Краеведски връзки/);
  assert.match(readme, /персоналия\/летопис → документ, статия, персоналия, периодика/);
});

/* Папката с временните бази се трие от cleanupTmpDirs(); mkTmpDir се ползва
   само през freshDb(), но се внася изрично, за да е видно откъде идва. */
assert.equal(typeof mkTmpDir, 'function');
