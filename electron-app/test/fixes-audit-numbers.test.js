'use strict';
/* Одит (v2.4.9) — числата, които влизат в официалните отчети към регионалната
   библиотека и Министерството на културата. Всеки тест по-долу пада на кода
   отпреди поправката и минава след нея.

   Конвенциите (freshDb/fakeIpcMain/run, чистене на временните папки) следват
   test/fixes-core-v23.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const registerStatsHandlers = require('../handlers/stats');
const registerKdbfHandlers = require('../handlers/kdbf');
const registerDashboardHandlers = require('../handlers/dashboard');
const registerLoansHandlers = require('../handlers/loans');
const registerDnevnikHandlers = require('../handlers/dnevnik');
const { BOOK_SELECT, pctRequired, normalizeScanCode } = require('./helpers/prod-values.js');

const run = (fn) => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err.message }; }
};
function fakeIpcMain() {
  const h = new Map();
  return { handle: (c, fn) => h.set(c, fn), invoke: (c, ...a) => h.get(c)({}, ...a), has: (c) => h.has(c) };
}
const tmpDirs = [];
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-audit-numbers-'));
  tmpDirs.push(dir);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* няма значение */ } } });

/* Книга с `quantity` екземпляра — точно както я създава handlers/books.js. */
function addBook(db, { inv_number = 1, quantity = 1, price = 0, register_date = '2026-03-01', status = 'наличен', language = null, department = null, udk = null } = {}) {
  const id = db.prepare(
    'INSERT INTO books (inv_number, title, status, price, register_date, language, department, udk) VALUES (?,?,?,?,?,?,?,?)'
  ).run(inv_number, 'Книга ' + inv_number, status, price, register_date, language, department, udk).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, quantity);
  return id;
}
const addReader = (db, name = 'Читател') =>
  db.prepare('INSERT INTO readers (name, category) VALUES (?, ?)').run(name, 'възрастен').lastInsertRowid;

function statsApi(db) {
  const ipcMain = fakeIpcMain();
  registerStatsHandlers(ipcMain, {
    getDb: () => db, run, yearOf: () => '2026',
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: () => ({})
  });
  return ipcMain;
}
function kdbfApi(db) {
  const ipcMain = fakeIpcMain();
  registerKdbfHandlers(ipcMain, { getDb: () => db, run, yearOf: () => '2026' });
  return ipcMain;
}
function dashboardApi(db) {
  const ipcMain = fakeIpcMain();
  registerDashboardHandlers(ipcMain, {
    getDb: () => db, run, today: () => '2026-08-02', yearOf: () => '2026',
    pctRequired, isWorkDay: () => true, LOAN_SELECT: 'SELECT l.* FROM loans l',
    countOverduePeriodicals: () => 0, effectiveDaysLate: () => 0
  });
  return ipcMain;
}

/* ------------------------------------------------------------------
   1. Няколко екземпляра от едно заглавие се броят като няколко документа.
   ------------------------------------------------------------------ */

test('фондът брои ЕКЗЕМПЛЯРИ, не заглавия — 40 заглавия по 3 бройки са 120 документа', async () => {
  const db = freshDb();
  for (let i = 1; i <= 40; i++) addBook(db, { inv_number: i, quantity: 3, price: 10 });
  const rep = (await statsApi(db).invoke('stats:report', '2026')).data;
  assert.equal(rep.fundCount, 120, 'преди поправката излизаше 40 — броеше се по един ред на заглавие');
  assert.equal(rep.fundValue, 1200, 'стойността също е за всички екземпляри: 40 × 3 × 10 лв.');
});

test('КДБФ „Наличност" и „Постъпили" също броят екземпляри', async () => {
  const db = freshDb();
  addBook(db, { inv_number: 1, quantity: 3, price: 10 });
  addBook(db, { inv_number: 2, quantity: 1, price: 5 });
  const rep = (await kdbfApi(db).invoke('kdbf:report', '2026')).data;
  assert.equal(rep.stockEnd.n, 4, '3 + 1 екземпляра');
  assert.equal(rep.stockEnd.v, 35, '3×10 + 1×5');
  assert.equal(rep.acquiredYear.n, 4);
  assert.equal(rep.acquiredYear.v, 35);
});

test('Таблото показва същия брой документи като справката — не се разминава', async () => {
  const db = freshDb();
  for (let i = 1; i <= 5; i++) addBook(db, { inv_number: i, quantity: 4, price: 2 });
  const dash = (await dashboardApi(db).invoke('dashboard:full')).data;
  const rep = (await statsApi(db).invoke('stats:report', '2026')).data;
  assert.equal(dash.fundCount, 20);
  assert.equal(dash.fundCount, rep.fundCount, 'Таблото и Справките трябва да казват едно и също');
  assert.equal(dash.fundValue, rep.fundValue);
});

test('книга без ред в inventory се брои като ЕДИН документ, не като нула', async () => {
  // Стара или внесена база: поправката може само да добави към числата,
  // никога да не отнеме спрямо досегашното броене по редове.
  const db = freshDb();
  db.prepare("INSERT INTO books (inv_number, title, status, price, register_date) VALUES (7,'Без inventory','наличен',9,'2026-02-02')").run();
  const rep = (await statsApi(db).invoke('stats:report', '2026')).data;
  assert.equal(rep.fundCount, 1);
  assert.equal(rep.fundValue, 9);
});

test('разбивките по език и отдел се събират точно до общия брой на фонда', async () => {
  const db = freshDb();
  addBook(db, { inv_number: 1, quantity: 3, language: 'български', department: 'заемна' });
  addBook(db, { inv_number: 2, quantity: 2, language: 'руски', department: 'заемна' });
  const rep = (await statsApi(db).invoke('stats:report', '2026')).data;
  const sumLang = rep.fundByLanguage.reduce((s, [, n]) => s + n, 0);
  const sumDep = rep.fundByDepartment.reduce((s, [, n]) => s + n, 0);
  assert.equal(rep.fundCount, 5);
  assert.equal(sumLang, 5, 'лентите „по езици" трябва да се събират до показателя над тях');
  assert.equal(sumDep, 5);
});

/* ------------------------------------------------------------------
   2. „Посещения" вече не се подменят с броя заемания.
   ------------------------------------------------------------------ */

test('при невписани посещения отчетът показва 0, а не броя заемания', async () => {
  const db = freshDb();
  const b = addBook(db, { inv_number: 1, quantity: 7 });
  const r = addReader(db);
  for (let i = 0; i < 7; i++) {
    db.prepare('INSERT INTO loans (reader_id, book_id, date_out) VALUES (?,?,?)').run(r, b, '2026-04-0' + (i + 1));
  }
  const rep = (await statsApi(db).invoke('stats:report', '2026')).data;
  assert.equal(rep.loansCount, 7);
  assert.equal(rep.visits, 0, 'преди поправката тук се показваха 7 „посещения", които никой не е броил');
  assert.equal(rep.visitsRecorded, false, 'изгледът трябва да може да каже „не са вписвани"');
});

test('вписаните посещения се показват както досега и се отбелязват като реални', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO visits (date, count) VALUES ('2026-05-05', 42)").run();
  const rep = (await statsApi(db).invoke('stats:report', '2026')).data;
  assert.equal(rep.visits, 42);
  assert.equal(rep.visitsRecorded, true);
});

/* ------------------------------------------------------------------
   3. Отчислените невърнати книги не са „върнати със забава".
   ------------------------------------------------------------------ */

test('заемане, закрито от акт за отчисляване, не се брои като закъсняло връщане', async () => {
  const db = freshDb();
  const b = addBook(db, { inv_number: 1 });
  const r = addReader(db);
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date) VALUES (1, 2026, '2026-06-01')").run().lastInsertRowid;
  // Заемане, което никога не се е върнало — актът го затваря с датата си.
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in, deaccession_act_id) VALUES (?,?,?,?,?,?)')
    .run(r, b, '2026-01-01', '2026-01-15', '2026-06-01', actId);
  // И едно истинско закъсняло връщане, за да личи, че филтърът не мете всичко.
  const b2 = addBook(db, { inv_number: 2 });
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in) VALUES (?,?,?,?,?)')
    .run(r, b2, '2026-02-01', '2026-02-10', '2026-02-20');
  const rep = (await statsApi(db).invoke('stats:report', '2026')).data;
  assert.equal(rep.returnedLate, 1, 'само истинското закъсняло връщане; отчисленото не е връщане изобщо');
  assert.equal(rep.returnedOnTime, 0);
});

/* ------------------------------------------------------------------
   4. Продължаване на просрочено заемане дава срок В БЪДЕЩЕТО.
   ------------------------------------------------------------------ */

test('продължаването на просрочено заемане тръгва от днес, не от изтеклия срок', async () => {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerLoansHandlers(ipcMain, {
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02', logEvent: () => {},
    BOOK_SELECT, scheduleCatalogWrite: () => {},
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 30, suspend_per_day: 0, suspend_max: 0 }),
    readerCategory: () => 'възрастен', nextWorkDay: (d) => d, closedDaysBetween: () => 0,
    firstActiveHold: () => null, activeHolds: () => [], freeCopies: () => 5,
    consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null, normalizeScanCode
  });
  const b = addBook(db, { inv_number: 1 });
  const r = addReader(db);
  const id = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(r, b, '2026-01-01', '2026-01-15').lastInsertRowid;
  const res = await ipcMain.invoke('loans:extend', { id });
  assert.equal(res.ok, true, res.error);
  assert.ok(res.data.date_due > '2026-08-02',
    `новият срок трябва да е в бъдещето, а е ${res.data.date_due} — преди поправката излизаше 2026-02-14, пак в миналото`);
  assert.equal(res.data.date_due, '2026-09-01', '30 дни от днес (2026-08-02)');
});

test('продължаването на НЕпросрочено заемане тръгва от стария срок, както досега', async () => {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerLoansHandlers(ipcMain, {
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02', logEvent: () => {},
    BOOK_SELECT, scheduleCatalogWrite: () => {},
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 30, suspend_per_day: 0, suspend_max: 0 }),
    readerCategory: () => 'възрастен', nextWorkDay: (d) => d, closedDaysBetween: () => 0,
    firstActiveHold: () => null, activeHolds: () => [], freeCopies: () => 5,
    consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null, normalizeScanCode
  });
  const b = addBook(db, { inv_number: 1 });
  const r = addReader(db);
  const id = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(r, b, '2026-08-01', '2026-09-10').lastInsertRowid;
  const res = await ipcMain.invoke('loans:extend', { id });
  assert.equal(res.data.date_due, '2026-10-10', '30 дни от стария срок — това поведение не се променя');
});

/* ------------------------------------------------------------------
   5. Записи без статус не изпадат от броенето.
   ------------------------------------------------------------------ */

test('книга с NULL статус (стара база) влиза в броя на фонда в Таблото', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO books (inv_number, title, status, register_date) VALUES (1,'Със статус','наличен','2026-01-01')").run();
  db.prepare("INSERT INTO books (inv_number, title, status, register_date) VALUES (2,'Без статус',NULL,'2026-01-01')").run();
  const st = (await dashboardApi(db).invoke('dashboard:stats')).data;
  assert.equal(st.books, 2, 'преди поправката NULL редът изпадаше — SQL сравнението с NULL не дава TRUE');
});

test('целта по чл. 40 съвпада между Таблото и екрана „Инвентаризация"', async () => {
  const db = freshDb();
  // 96 със статус + 4 без статус = 100 заглавия.
  for (let i = 1; i <= 96; i++) addBook(db, { inv_number: i, quantity: 2 });
  for (let i = 97; i <= 100; i++) {
    db.prepare("INSERT INTO books (inv_number, title, status, register_date) VALUES (?,?,NULL,'2026-01-01')").run(i, 'Без статус ' + i);
  }
  const dash = (await dashboardApi(db).invoke('dashboard:full')).data;
  const registerInventoryHandlers = require('../handlers/inventory-sessions');
  const invApi = fakeIpcMain();
  registerInventoryHandlers(invApi, {
    getDb: () => db, run, today: () => '2026-08-02', pctRequired,
    naturalLoss: () => 0, logAudit: () => {}, normalizeScanCode, BOOK_SELECT
  });
  const req = (await invApi.invoke('inventorySessions:requirement')).data;
  assert.equal(req.active, 100, 'всичките 100 заглавия, включително тези без статус');
  assert.equal(dash.inventoryTarget, req.target,
    `Таблото показва цел ${dash.inventoryTarget}, а „Инвентаризация" — ${req.target}`);
  /* Целта се смята от ЗАГЛАВИЯТА (сканира се по инв. №), не от бройките: тук
     заглавията са 100 и всяко е с по 2 екземпляра, тоест 192 документа във фонда.
     Ако целта тръгваше от бройките, тя щеше да е близо двойно по-голяма. */
  assert.equal(dash.inventoryTarget, Math.ceil(100 * pctRequired(100) / 100));
  const rep = (await statsApi(db).invoke('stats:report', '2026')).data;
  assert.equal(rep.fundCount, 96 * 2 + 4, 'фондът пък се брои по екземпляри — двете мерки са различни нарочно');
});

/* ------------------------------------------------------------------
   6. Дневникът: трите реда „Всичко" на Раздел Б се събират.
   ------------------------------------------------------------------ */

function dnevnikApi(db) {
  const ipcMain = fakeIpcMain();
  registerDnevnikHandlers(ipcMain, {
    getDb: () => db, run, logAudit: () => {}, dialog: {}, getMainWindow: () => ({}), fs
  });
  return ipcMain;
}
const addLoanEvent = (db, udk) =>
  db.prepare(`INSERT INTO events (date, kind, book_category, book_language, book_udk, reader_id, reader_category)
              VALUES ('2026-05-05','заемане','книга','български',?,NULL,'възрастен')`).run(udk);

test('заемане с УДК 81 (езикознание) влиза в колоната по съдържание', async () => {
  const db = freshDb();
  addLoanEvent(db, '81');
  const res = (await dnevnikApi(db).invoke('dnevnik:suggest', { date: '2026-05-05' })).data;
  assert.equal(res.suggestions.b_cat_80, 1, 'УДК 81 не съвпадаше с никой префикс и не се броеше никъде');
  assert.equal(res.unclassified, 0);
});

test('заемане с УДК 65-68 (приложни науки) влиза в колоната по съдържание', async () => {
  const db = freshDb();
  ['65', '66', '67', '68'].forEach(u => addLoanEvent(db, u));
  const res = (await dnevnikApi(db).invoke('dnevnik:suggest', { date: '2026-05-05' })).data;
  assert.equal(res.suggestions.b_cat_62, 4);
  assert.equal(res.unclassified, 0);
});

test('трите реда „Всичко" на Раздел Б се събират до едно и също число', async () => {
  const db = freshDb();
  ['0', '1', '2', '3', '5', '61', '62', '63', '7', '793', '80', '81', '82', '9', '91', '65', '8', '6'].forEach(u => addLoanEvent(db, u));
  const res = (await dnevnikApi(db).invoke('dnevnik:suggest', { date: '2026-05-05' })).data;
  const s = res.suggestions;
  const sumOf = (prefix) => Object.keys(s).filter(k => k.startsWith(prefix)).reduce((a, k) => a + s[k], 0);
  assert.equal(sumOf('b_type_'), 18);
  assert.equal(sumOf('b_lang_'), 18);
  assert.equal(sumOf('b_cat_'), 18,
    'по съдържание се броеше само при съвпадение на префикс — затова тази сума изоставаше');
});

test('заемане на книга без УДК се отчита отделно, вместо да бъде набутано в чужда колона', async () => {
  const db = freshDb();
  addLoanEvent(db, null);
  addLoanEvent(db, '82');
  const res = (await dnevnikApi(db).invoke('dnevnik:suggest', { date: '2026-05-05' })).data;
  assert.equal(res.unclassified, 1, 'библиотекарят трябва да види колко реда да допълни ръчно');
  assert.equal(res.suggestions.b_cat_82, 1);
});

test('всяка цифра 0-9 като УДК попада в някоя колона — таблицата няма дупки', async () => {
  for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    const db = freshDb();
    addLoanEvent(db, d);
    const res = (await dnevnikApi(db).invoke('dnevnik:suggest', { date: '2026-05-05' })).data;
    // Клас 4 е незает в УДК, но и той не бива да изчезва мълчаливо: или се брои,
    // или се отчита като некласифициран — никога „никъде".
    const counted = Object.keys(res.suggestions).some(k => k.startsWith('b_cat_')) || res.unclassified > 0;
    assert.ok(counted, `УДК "${d}" не се брои никъде и не се отчита като некласифициран`);
  }
});
