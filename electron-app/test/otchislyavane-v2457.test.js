'use strict';
/* Одитен кръг v2.4.57 — КАКВО ОЩЕ СЕ ПРОМЕНЯ, КОГАТО ДОКУМЕНТ ИЗЛЕЗЕ ОТ ФОНДА.
 * =====================================================================
 * Предишният кръг направи акта документ, който не се трие. Този кръг тръгна от
 * другия въпрос: какво СЛЕДВА от отчисляването. Отговорът се оказа „по-малко,
 * отколкото трябва“ — актът менеше състоянието на документа и затваряше
 * заеманията, а седем други места продължаваха да го броят, да го показват и да
 * го предлагат, все едно нищо не е станало.
 *
 * Всяко от седемте е измерено, не предположено:
 *
 *   1) ВИТРИНИТЕ. Документ във витрина „Класика“ се отчислява; shelves:list
 *      продължава да казва „Класика (2)“, а публичният katalog.json публикува
 *      само неотчислените — витрината на сайта излиза с 1 книга. Библиотекарката
 *      вижда 2, посетителят вижда 1, и нищо не казва защо.
 *   2) РЕЗЕРВАЦИИТЕ. Отказваха се правилно, но БЕЗСЛЕДНО: holds:list показва
 *      само активните, прозорецът казваше „отчислени са N документа“, а човекът,
 *      чакал книгата две седмици, научаваше на гишето. При АНУЛИРАНЕ програмата
 *      изрично предупреждава „N резервации остават отказани“, а по пътя, в който
 *      резервациите реално падат, мълчеше.
 *   3) КРАЕЗНАНИЕТО. links:add към отчислен документ минаваше без дума, а
 *      етикетът му беше неразличим от жив — краеведът праща читател да търси в
 *      каталога книга, която библиотеката вече не притежава.
 *   4) АНАЛИТИЧНИТЕ ОПИСАНИЯ. Същото, а указателят се РАЗПЕЧАТВА и се дава на
 *      читателя: „Вазов, Иван. Под игото (инв. № 5)“ — инвентарен номер, който
 *      вече не съществува.
 *   5) ИНВЕНТАРИЗАЦИЯТА. Екранът броеше СУРОВИТЕ сканирания, а протоколът — само
 *      онези в обхвата. Една книга, сканирана и отчислена същия месец: екранът
 *      обявява нормата по чл. 40 за изпълнена („проверени 1 от 1“), подписаният
 *      протокол за същата сесия гласи „проверени 0“.
 *   6) АВТОРИТЕТНИТЕ ДАННИ. „Вазов, Иван — 12 документа“ при нула на рафта.
 *   7) ЛИМИТЪТ НА ЗАПИСИТЕ. Броеше се `COUNT(*) FROM books` без условие, тоест и
 *      отчислените. Библиотека на тавана НЕ МОЖЕ да добави документ, колкото и
 *      да отчислява — а books:delete изрично забранява единствения друг изход.
 *      Двете правила се заключваха едно друго.
 *
 * Файлът заковава и седемте. Общото между тях е едно изречение: отчисленият
 * документ ОСТАВА в документацията (чл. 39) и ИЗЛИЗА от всичко, което отговаря
 * на въпроса „какво имаме днес“.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { APP_DIR, freshDb, fakeIpcMain, runDep, cleanupTmpDirs } = require('./helpers/audit-fixtures');
const { BOOK_SELECT, normalizeScanCode, pctRequired, naturalLoss } = require('./helpers/prod-values');

test.after(cleanupTmpDirs);

/* Всички засегнати модули върху ЕДНА база. Нарочно заедно: смисълът на кръга е,
   че ЕДНО действие (съставянето на акта) трябва да се види в седем други места —
   проверка само върху deaccession-acts би минала и ако витрината не се чисти. */
function setup(prefix) {
  const { db } = freshDb(prefix || 'inv-otch-v2457-');
  const audit = [];
  const deps = {
    getDb: () => db, run: runDep,
    logAudit: (action, detail, diff) => audit.push({ action, detail, diff }),
    today: () => '2026-08-04', yearOf: () => '2026',
    BOOK_SELECT, normalizeScanCode, pctRequired, naturalLoss,
    ftsQuery: (q) => q, cnSortKey: () => '', diffFields: () => [],
    scheduleCatalogWrite: () => {}, flushCatalogWrite: () => ({ written: true })
  };
  const ipcMain = fakeIpcMain();
  for (const m of ['deaccession-acts', 'shelves', 'links', 'analytics',
    'inventory-sessions', 'authorities', 'books']) {
    require(path.join(APP_DIR, 'handlers', m))(ipcMain, deps);
  }
  return { db, ipcMain, audit };
}

function addBook(db, o) {
  const b = Object.assign({
    inv_number: 1, title: 'Под игото', author: 'Вазов, Иван', price: 10,
    register_date: '2026-02-01', status: 'наличен', qty: 1, department: null
  }, o);
  const id = db.prepare(`INSERT INTO books
    (inv_number, title, author, price, register_date, status, status_date, department)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(b.inv_number, b.title, b.author, b.price, b.register_date, b.status, b.register_date, b.department)
    .lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, b.qty);
  return id;
}
function addReader(db, o) {
  const r = Object.assign({ name: 'Петрова, Мария', card_no: 'К-1', phone: '0888 12 34 56' }, o);
  return db.prepare('INSERT INTO readers (name, card_no, phone) VALUES (?, ?, ?)')
    .run(r.name, r.card_no, r.phone).lastInsertRowid;
}
const ACT = (o) => Object.assign({
  no: 1, date: '2026-06-10', reason_code: 3, reason_text: 'физически изхабени',
  disposal: 'предадени за вторични суровини', committee1: 'А', committee2: 'Б', committee3: 'В'
}, o);
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };

/* ==================================================================
   1. ВИТРИНИТЕ В ОНЛАЙН КАТАЛОГА
   ================================================================== */

test('съставянето на акта МАХА документа от витрините — иначе екранът и сайтът показват различен брой', () => {
  /* Дупката е точно огледална на тази при резервациите и е пробита от същата
     страна: shelves:addBook отдавна отказва отчислен документ, тоест грижата
     съществува по пътя „първо отчислен, после във витрина“, а обратният път —
     „първо във витрина, после отчислен“ — стоеше отворен. */
  const { db, ipcMain } = setup();
  const shelfId = ok(ipcMain.invoke('shelves:create', 'Класика'), 'витрина');
  const stay = addBook(db, { inv_number: 1, title: 'Остава' });
  const goes = addBook(db, { inv_number: 2, title: 'Отчислената' });
  ok(ipcMain.invoke('shelves:addBooks', { shelfId, ids: [stay, goes] }), 'подреждане');
  assert.equal(ok(ipcMain.invoke('shelves:list'), 'преди')[0].n, 2, 'преди акта витрината е с две книги');

  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [goes] }), 'акт');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_shelf_items WHERE book_id = ?').get(goes).n, 0,
    'редът във витрината е изтрит, а не само скрит — иначе katalog.json и екранът пак се разминават');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_shelf_items WHERE book_id = ?').get(stay).n, 1,
    'останалата книга не е пипната');
  const sh = ok(ipcMain.invoke('shelves:list'), 'след')[0];
  assert.equal(sh.n, 1, 'shelves:list вече брои една — толкова, колкото ще види и посетителят на сайта');
  assert.equal(sh.stale, 0, 'и нищо не е останало „в кофата“ като непубликуван ред');
  assert.equal(ok(ipcMain.invoke('shelves:items', shelfId), 'редове').length, 1);
});

test('стара база, в която отчислен документ е ОСТАНАЛ във витрина, ПОКАЗВА разликата, вместо да я крие', () => {
  /* Отчисляванията отпреди поправката са оставили такива редове и те няма да
     изчезнат сами. Празната разлика между екрана („Класика (2)“) и сайта (една
     книга) е точно това, което библиотекарката не можеше да види — затова
     непубликуваните редове се броят ОТДЕЛНО и се обявяват, а не се крият.
     Условието е нарочно ПО-ТЯСНО от фондовия ключ: служебният документ е част
     от фонда, но не се публикува, а ред със status NULL (стар внос) за фонда Е
     наличен, докато `status != 'отчислен'` в SQL дава NULL и го изхвърля. */
  const { db, ipcMain } = setup();
  const shelfId = ok(ipcMain.invoke('shelves:create', 'Класика'), 'витрина');
  const live = addBook(db, { inv_number: 1, title: 'Жива' });
  const old = addBook(db, { inv_number: 2, title: 'Отчислена по стария ред' });
  ok(ipcMain.invoke('shelves:addBooks', { shelfId, ids: [live, old] }), 'подреждане');
  // Отчисляване „по стария ред“: статусът се сменя, редът във витрината остава.
  db.prepare("UPDATE books SET status = 'отчислен' WHERE id = ?").run(old);

  const sh = ok(ipcMain.invoke('shelves:list'), 'витрини')[0];
  assert.equal(sh.n, 1, 'броят на екрана е този, който ще види и посетителят на сайта');
  assert.equal(sh.stale, 1, 'а останалият ред се ОБЯВЯВА, вместо да се брои или да се скрие');

  const items = ok(ipcMain.invoke('shelves:items', shelfId), 'редове');
  assert.deepEqual(items.map(i => [i.inv_number, i.published]), [[1, 1], [2, 0]],
    'всеки ред казва сам дали стига до сайта');
});

test('имената на витрините се запазват В РЕДА НА АКТА — подборът е правен от човек и някой трябва да може да го върне', () => {
  /* Витрината не се възстановява автоматично при анулиране — по същата причина,
     по която не се възстановяват и резервациите: анулирането поправя регистъра,
     а не пресъздава подбора на библиотекаря. Но щом не се връща само, трябва да
     е ЗАПИСАНО какво да се върне ръчно. Имената, а не номерата: редът на акта е
     документ и трябва да се чете и след като витрината бъде преименувана или
     изтрита. */
  const { db, ipcMain } = setup();
  const a = ok(ipcMain.invoke('shelves:create', 'Класика'), 'витрина 1');
  const b = ok(ipcMain.invoke('shelves:create', 'Нови постъпления'), 'витрина 2');
  const bookId = addBook(db, { inv_number: 5 });
  ok(ipcMain.invoke('shelves:addBooks', { shelfId: a, ids: [bookId] }), 'подреждане 1');
  ok(ipcMain.invoke('shelves:addBooks', { shelfId: b, ids: [bookId] }), 'подреждане 2');

  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'акт');
  const item = db.prepare('SELECT shelves_before FROM deaccession_items WHERE act_id = ?').get(actId);
  assert.equal(item.shelves_before, 'Класика; Нови постъпления', 'и двете витрини, по реда си');

  // Витрината се изтрива — снимката в акта продължава да казва какво е било.
  ok(ipcMain.invoke('shelves:delete', a), 'изтриване на витрина');
  assert.equal(db.prepare('SELECT shelves_before FROM deaccession_items WHERE act_id = ?').get(actId).shelves_before,
    'Класика; Нови постъпления', 'снимката преживява изтриването на самата витрина');

  // Анулирането връща документа във фонда, но НЕ пресъздава подбора: то поправя
  // регистъра, а не връща времето. Затова връща и списък какво да се върне ръчно.
  const info = ok(ipcMain.invoke('deaccessionActs:revoke', actId,
    { reason: 'сгрешен инв. номер', by: 'Иванова' }), 'анулиране');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_shelf_items WHERE book_id = ?').get(bookId).n, 0,
    'витрината НЕ се възстановява сама — подборът е човешко решение');
  assert.deepEqual(info.shelvesToRestore, [{ inv_number: 5, shelves: 'Класика; Нови постъпления' }],
    'но прозорецът получава точно какво да върне обратно');
});

test('анулирането казва ПОИМЕННО кои документи от кои витрини трябва да се върнат ръчно', () => {
  const { db, ipcMain, audit } = setup();
  const shelfId = ok(ipcMain.invoke('shelves:create', 'Класика'), 'витрина');
  const bookId = addBook(db, { inv_number: 77 });
  ok(ipcMain.invoke('shelves:addBooks', { shelfId, ids: [bookId] }), 'подреждане');
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'акт');
  ok(ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'сгрешен инв. номер', by: 'Иванова' }), 'анулиране');

  const row = audit.filter(a => a.action === 'Анулиране на акт').pop();
  assert.match(row.detail, /анулиран/);
  assert.match(row.detail, /витрини в онлайн каталога|витрина в онлайн каталога/,
    'следата казва, че документът е бил махнат от витрина');
  assert.match(row.detail, /инв. № 77 → Класика/, 'и назовава точно кой документ къде се връща');
  assert.match(row.detail, /НЕ се връщат автоматично/, 'и че това няма да стане само');
});

test('следата при съставяне назовава витрините — това е единственото място, което библиотекарката чете на другия ден', () => {
  const { db, ipcMain, audit } = setup();
  const shelfId = ok(ipcMain.invoke('shelves:create', 'Класика'), 'витрина');
  const bookId = addBook(db, { inv_number: 9 });
  ok(ipcMain.invoke('shelves:addBooks', { shelfId, ids: [bookId] }), 'подреждане');
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'акт');

  const row = audit.filter(a => a.action === 'Отчисляване').pop();
  assert.match(row.detail, /излизат от витрините в онлайн каталога \(Класика\)/);
});

/* ==================================================================
   2. ЧИТАТЕЛИТЕ, КОИТО СА ЧАКАЛИ
   ================================================================== */

function placeHold(db, bookId, readerId, status) {
  return db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, ?, ?)")
    .run(bookId, readerId, status || 'чака', '2026-05-01 10:00:00').lastInsertRowid;
}

test('актът назовава ПОИМЕННО читателите, чиито резервации е отказал — с име и номер на карта', () => {
  /* Предишният кръг затвори дупката „резервацията остава жива върху отчислен
     документ“ и сложи брояч в следата. Останалото счупено беше по-просто и
     по-скъпо: НИКОЙ ЧОВЕК НЕ НАУЧАВА. Броят („отказани 2 резервации“) не помага
     на никого — по него не може да се вдигне телефон. Телефонът нарочно НЕ влиза
     в дневника: той се изнася и разпечатва, а за обаждането името и картата
     стигат, за да се намери читателят в „Читатели“. */
  const { db, ipcMain, audit } = setup();
  const bookId = addBook(db, { inv_number: 42, title: 'Чакана книга' });
  const r1 = addReader(db, { name: 'Петрова, Мария', card_no: 'К-1', phone: '0888 000 111' });
  const r2 = addReader(db, { name: 'Георгиев, Иван', card_no: 'К-2', phone: '0888 222 333' });
  placeHold(db, bookId, r1, 'чака');
  placeHold(db, bookId, r2, 'заделена');

  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'акт');

  const row = audit.filter(a => a.action === 'Отчисляване').pop();
  assert.match(row.detail, /отказани 2 резервации/);
  assert.match(row.detail, /Петрова, Мария \(карта К-1\) — инв. № 42/);
  assert.match(row.detail, /Георгиев, Иван \(карта К-2\) — инв. № 42/);
  assert.ok(!/0888/.test(row.detail), 'телефонът НЕ влиза в разпечатвания дневник');
});

test('deaccessionActs:get връща чакалите с име, карта И телефон — за да може да им се звънне', () => {
  /* Сведението е ТРАЙНО, а не еднократно съобщение: актът се отваря и след
     седмица. holds:list показва само активните, тоест отказаната резервация
     изчезва от екрана в мига на отчисляването и няма друго място, от което да
     се научи кой е чакал. */
  const { db, ipcMain } = setup();
  const bookId = addBook(db, { inv_number: 42, title: 'Чакана книга' });
  const readerId = addReader(db, { name: 'Петрова, Мария', card_no: 'К-7', phone: '0888 12 34 56' });
  placeHold(db, bookId, readerId, 'чака');

  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'акт');
  const act = ok(ipcMain.invoke('deaccessionActs:get', actId), 'преглед на акта');

  assert.equal(act.holds.length, 1, 'прегледът на акта носи отказаните резервации');
  const h = act.holds[0];
  assert.equal(h.reader_name, 'Петрова, Мария');
  assert.equal(h.card_no, 'К-7');
  assert.equal(h.phone, '0888 12 34 56', 'телефонът стига до екрана — това е самата цел');
  assert.equal(h.inv_number, 42, 'и за коя книга е бил редът');
  assert.equal(h.title, 'Чакана книга');
  assert.equal(h.status_before, 'чака', 'и какво е било състоянието преди акта');
  assert.equal(h.status, 'отказана');
});

test('deaccessionActs:get работи и върху база, в която никога не е съставян акт — колоните се добавят при четене', () => {
  /* Колоните deaccession_act_id/status_before върху holds и shelves_before върху
     deaccession_items се добавят от ensureLoanActColumn. Четящият път дотук не го
     викаше; базата може да е отворена и прегледана, без изобщо да е съставян акт. */
  const { db, ipcMain } = setup();
  const actId = db.prepare(`INSERT INTO deaccession_acts (no, year, date, reason_text) VALUES (1, '2026', '2026-06-10', 'стар акт')`)
    .run().lastInsertRowid;
  const act = ok(ipcMain.invoke('deaccessionActs:get', actId), 'преглед');
  assert.deepEqual(act.holds, [], 'празен списък, а не грешка „няма такава колона“');
});

/* ==================================================================
   3. КРАЕЗНАНИЕТО И АНАЛИТИЧНИТЕ ОПИСАНИЯ
   ================================================================== */

function deaccessioned(db, ipcMain, o) {
  const bookId = addBook(db, o);
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(o && o.act), bookIds: [bookId] }), 'акт');
  return { bookId, actId };
}

test('links:add към отчислен документ се ОТКАЗВА и казва какво да се направи вместо това', () => {
  /* Съществуващите връзки се БЕЛЕЖАТ, не се трият: краеведската връзка описва
     какво е ползвано, а не какво стои на рафта. Но новата връзка е решение,
     взето днес — жив указател към несъществуващ инвентарен номер праща читател
     да търси книга, която библиотеката вече няма. */
  const { db, ipcMain } = setup();
  const personId = db.prepare("INSERT INTO persons (name) VALUES ('Вазов, Иван')").run().lastInsertRowid;
  const { bookId } = deaccessioned(db, ipcMain, { inv_number: 5 });
  const live = addBook(db, { inv_number: 6, title: 'Жива книга' });

  const res = ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId });
  assert.equal(res.ok, false, 'отказва се');
  assert.match(res.error, /отчислен с акт № 1\/2026/, 'и казва С КОЙ акт е излязъл документът');
  assert.match(res.error, /опишете го в бележката/i, 'и какво да се направи вместо това');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM links').get().n, 0);

  ok(ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: live }), 'жива книга');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM links').get().n, 1, 'живият документ се свързва както преди');
});

test('етикетът на вече съществуваща връзка носи „(отчислен с акт № N/год.)“ — и в списъка, и в търсенето', () => {
  const { db, ipcMain } = setup();
  const personId = db.prepare("INSERT INTO persons (name) VALUES ('Вазов, Иван')").run().lastInsertRowid;
  const bookId = addBook(db, { inv_number: 5, title: 'Под игото', author: 'Вазов, Иван' });
  ok(ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId }), 'връзка преди акта');
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 3 }), bookIds: [bookId] }), 'акт');

  const list = ok(ipcMain.invoke('links:list', { fromKind: 'персона', fromId: personId }), 'списък');
  assert.equal(list.length, 1, 'връзката ОСТАВА — тя описва какво е ползвано');
  assert.equal(list[0].label, 'инв. № 5 · Вазов, Иван. Под игото (отчислен с акт № 3/2026)');

  const search = ok(ipcMain.invoke('links:search', { kind: 'книга', q: 'игото' }), 'търсене');
  assert.equal(search[0].label, 'инв. № 5 · Вазов, Иван. Под игото (отчислен с акт № 3/2026)',
    'търсенето го НАМИРА (иначе търсещият по стара картотека получава „няма такъв документ“), но с белега');

  const back = ok(ipcMain.invoke('links:backlinks', { toKind: 'книга', toId: bookId }), 'обратни връзки');
  assert.equal(back[0].to_label, 'инв. № 5 · Вазов, Иван. Под игото (отчислен с акт № 3/2026)',
    'и обратната посока отговаря на въпроса „а документът още ли е във фонда“');
});

test('анулираният акт НЕ бележи документа — по него отчисляване не е имало', () => {
  const { db, ipcMain } = setup();
  const personId = db.prepare("INSERT INTO persons (name) VALUES ('Вазов, Иван')").run().lastInsertRowid;
  const bookId = addBook(db, { inv_number: 5 });
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'акт');
  ok(ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'сгрешен номер', by: 'Иванова' }), 'анулиране');

  ok(ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId }),
    'нова връзка след анулиране');
  const list = ok(ipcMain.invoke('links:list', { fromKind: 'персона', fromId: personId }), 'списък');
  assert.ok(!/отчислен/.test(list[0].label), 'белегът пада заедно с акта');
});

test('analytics:create към отчислена книга се ОТКАЗВА, а вече описаната статия остава — с белег в източника', () => {
  /* Огледалната грижа вече съществуваше от другата страна: books:delete отказва
     изтриване на документ, към който има аналитични описания. Тук същото
     правило липсваше и висящата връзка можеше да се направи НАРОЧНО. Отказът е
     само за НОВИ описания: книгата може да се отчисли години след като статията
     е описана, а забраната да се поправи правописна грешка в анотацията не
     помага на никого. */
  const { db, ipcMain } = setup();
  const bookId = addBook(db, { inv_number: 5, title: 'Под игото', author: 'Вазов, Иван' });
  const old = ok(ipcMain.invoke('analytics:create',
    { title: 'Статия отпреди акта', source_kind: 'книга', book_id: bookId }), 'описание преди акта');
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 4 }), bookIds: [bookId] }), 'акт');

  const res = ipcMain.invoke('analytics:create', { title: 'Нова статия', source_kind: 'книга', book_id: bookId });
  assert.equal(res.ok, false, 'ново описание към отчислена книга се отказва');
  assert.match(res.error, /отчислен с акт № 4\/2026/);
  assert.match(res.error, /свободен текст/, 'и предлага работещия изход');

  const rows = ok(ipcMain.invoke('analytics:list', {}), 'списък');
  const kept = rows.find(r => r.id === old);
  assert.ok(kept, 'вече описаната статия ОСТАВА — тя описва статията, не притежанието');
  assert.equal(kept.book_title, 'Под игото (отчислен с акт № 4/2026)',
    'но указателят, който се разпечатва и се дава на читателя, вече го казва');
  assert.equal(kept.book_status, 'отчислен');

  // Редакцията на съществуващото описание не се пипа…
  ok(ipcMain.invoke('analytics:update', { id: old, title: 'Поправено заглавие', source_kind: 'книга', book_id: bookId }),
    'редакция на съществуващо описание');
  // …но ПРЕНАСОЧВАНЕ към отчислена книга е същото решение като новото описание.
  const other = ok(ipcMain.invoke('analytics:create', { title: 'Друга статия' }), 'второ описание');
  const redirect = ipcMain.invoke('analytics:update', { id: other, title: 'Друга статия', book_id: bookId });
  assert.equal(redirect.ok, false, 'пренасочване към отчислена книга се отказва');
  assert.match(redirect.error, /не може да бъде пренасочено/);
});

/* ==================================================================
   4. ИНВЕНТАРИЗАЦИЯТА — ЕКРАНЪТ И ПРОТОКОЛЪТ
   ================================================================== */

test('„сканиран, после отчислен“: екранът и протоколът дават ЕДНО И СЪЩО число', () => {
  /* Дотук екранът броеше СУРОВИТЕ сканирания за годината, а близването на
     сесията брои проверените СРЕЩУ ОБХВАТА. Разминават се при най-обикновено
     събитие: документ, сканиран от комисията и отчислен с акт същия месец.
     Измерено върху една книга и една сесия — екранът обявяваше нормата по чл. 40
     за изпълнена („проверени 1 от 1“), а подписаният протокол за същата сесия
     гласеше „проверени 0“. Числото на екрана е това, по което библиотекарката
     решава дали да продължи; протоколът е това, което се подписва. */
  const { db, ipcMain } = setup();
  const y = String(new Date().getFullYear());
  const scannedThenOff = addBook(db, { inv_number: 1, title: 'Сканирана и отчислена' });
  const stays = addBook(db, { inv_number: 2, title: 'Остава във фонда' });

  const sessionId = ok(ipcMain.invoke('inventorySessions:start',
    { date: y + '-03-10', scope: 'по чл. 40, т. 2', committee1: 'А', committee2: 'Б', committee3: 'В' }), 'сесия');
  ok(ipcMain.invoke('inventorySessions:scan', { sessionId, code: '1' }), 'сканиране 1');
  ok(ipcMain.invoke('inventorySessions:scan', { sessionId, code: '2' }), 'сканиране 2');
  assert.equal(ok(ipcMain.invoke('inventorySessions:requirement'), 'преди акта').scannedYear, 2,
    'преди акта и двете се броят');

  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ date: y + '-04-01' }), bookIds: [scannedThenOff] }), 'акт');

  const req = ok(ipcMain.invoke('inventorySessions:requirement'), 'екранът');
  const closed = ok(ipcMain.invoke('inventorySessions:close', { sessionId, mode: 'representative' }), 'протоколът');
  assert.equal(req.scannedYear, 1, 'екранът вече не брои излезлия от обхвата');
  assert.equal(closed.scanned, 1, 'протоколът брои същото');
  assert.equal(req.scannedYear, closed.scanned, 'ЕДНО И СЪЩО число — това е цялата поправка');
  assert.equal(closed.outOfScope, 1, 'а излезлият от обхвата се ОБЯВЯВА отделно, вместо да се скрие');
  assert.equal(req.active, 1, 'и обхватът вече е един документ');
  assert.ok(stays);
});

/* ==================================================================
   5. АВТОРИТЕТНИТЕ ДАННИ
   ================================================================== */

test('authorities:list връща и `avail` — „12 документа“ при нула на рафта е верният отговор на друг въпрос', () => {
  /* `n` брои ВСИЧКИ описани документи и не бива да се пипа: имената се предлагат
     за автодовършване, за да се пише еднакво, а инспекторът по чл. 39 чете по име
     и в отчислените актове. На екрана обаче същото число стои под колона
     „Документи“ и се чете като „толкова книги имаме от този автор“. Затова
     числата са ДВЕ и всяко казва на какво отговаря. */
  const { db, ipcMain } = setup();
  const a = addBook(db, { inv_number: 1, author: 'Вазов, Иван' });
  const b = addBook(db, { inv_number: 2, author: 'Вазов, Иван' });
  addBook(db, { inv_number: 3, author: 'Вазов, Иван', status: null });   // стар внос — В наличност
  addBook(db, { inv_number: 4, author: 'Габе, Дора' });
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [a, b] }), 'акт');

  const rows = ok(ipcMain.invoke('authorities:list', 'author'), 'списък');
  const vazov = rows.find(r => r.value === 'Вазов, Иван');
  assert.equal(vazov.n, 3, '„описани документи“ остава три — това е за автодовършването и за чл. 39');
  assert.equal(vazov.avail, 1, 'а „в наличност“ е един — и NULL статусът се брои като наличен');
  assert.equal(rows.find(r => r.value === 'Габе, Дора').avail, 1);
});

/* ==================================================================
   6. ЛИМИТЪТ НА ЗАПИСИТЕ
   ================================================================== */

test('отчисляването ОСВОБОЖДАВА място по лимита — иначе двете правила се заключват едно друго', () => {
  /* Дотук лимитът броеше `COUNT(*) FROM books` без условие, тоест и отчислените.
     А отчисленият ред по чл. 39 остава в инвентарната книга отбелязан, не
     заличен, и books:delete изрично отказва да го изтрие. Резултатът: библиотека,
     стигнала тавана, НЕ МОЖЕ да добави нов документ, колкото и да отчислява —
     единственият позволен начин да освободи място е точно този, който програмата
     забранява, а съобщението съветва да се махне самата мярка. */
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET limit_books = 2 WHERE id = 1').run();
  const a = addBook(db, { inv_number: 1 });
  addBook(db, { inv_number: 2 });

  const blocked = ipcMain.invoke('books:create', { inv_number: 3, title: 'Трета', register_date: '2026-02-01' });
  assert.equal(blocked.ok, false, 'на тавана вписването се отказва');
  assert.match(blocked.error, /лимит от 2 документи във фонда/);
  assert.match(blocked.error, /отчислените с акт не заемат място/,
    'съобщението казва работещия изход, а не само „увеличете лимита“');

  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [a] }), 'акт');
  ok(ipcMain.invoke('books:create', { inv_number: 3, title: 'Трета', register_date: '2026-02-01' }),
    'след отчисляването има място');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 3,
    'редът на отчисления документ ОСТАВА в базата — освободило се е място, не е изтрит документ');
});

test('„Ограничения“ показва ТОЧНО числото, което проверката брои — иначе екранът лъже в едната или в другата посока', () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET limit_books = 10, limit_readers = 5 WHERE id = 1').run();
  const a = addBook(db, { inv_number: 1 });
  addBook(db, { inv_number: 2 });
  addReader(db, { card_no: 'К-1' });
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [a] }), 'акт');

  const u = ok(ipcMain.invoke('limits:usage'), 'заетост');
  assert.equal(u.books, 1, 'заети са толкова места, колкото пази и проверката');
  assert.equal(u.limitBooks, 10);
  assert.equal(u.readers, 1, 'читателите нямат отчисляване — техният брояч остава какъвто е');
  assert.equal(u.limitReaders, 5);
});
