/* Регресионни тестове v2.2.0 за дефектите от задълбочения одит на v2.1.0, които
   засягат ЯДРОТО: заемания (бройки, повторно връщане, падежи през смяната на
   лятното часово време, таван на наказанието), еднаквата сума на обезщетението
   във всички справки, видът на инвентаризацията и публичният флаг „налична".

   Общото между всички тях е, че съществуващите 547 теста ги пропускаха:
   тестовете за дати ползваха само август (не пресича смяната на часа), повторно
   връщане не се тестваше изобщо, а вторият екземпляр на заглавие се проверяваше
   само през loans:checkout (който винаги е броял правилно), не и през баркода. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerLoansHandlers = require('../handlers/loans');
const registerInventoryHandlers = require('../handlers/inventory-sessions');
const registerNoticesHandlers = require('../handlers/notices');
/* BOOK_SELECT/pctRequired/naturalLoss идват от продукцията, не се преписват —
   вж. test/helpers/prod-values.js за причината. */
const { BOOK_SELECT, pctRequired, naturalLoss, normalizeScanCode } = require('./helpers/prod-values.js');


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

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}
function freshDb() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fixes-core-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}
const run = (fn) => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err.message }; }
};

function setupLoans(overrides = {}) {
  const db = freshDb();
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const returned = registerLoansHandlers(ipcMain, Object.assign({
    getDb: () => db, run,
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    today: () => '2026-08-02',
    logEvent: () => {},
    BOOK_SELECT,
    scheduleCatalogWrite: () => {},
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 1, suspend_max: 90 }),
    readerCategory: () => 'възрастен',
    nextWorkDay: (d) => d,
    closedDaysBetween: () => 0,
    firstActiveHold: () => null,
    consumeHoldOnCheckout: () => {},
    activateHoldOnReturn: () => null,
    normalizeScanCode
  }, overrides));
  return { db, ipcMain, auditLog, returned };
}
function addBook(db, { inv_number = 1, quantity = 1, status = 'наличен', barcode = null } = {}) {
  const id = db.prepare('INSERT INTO books (inv_number, title, status, barcode) VALUES (?, ?, ?, ?)')
    .run(inv_number, 'Книга ' + inv_number, status, barcode).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, quantity);
  return id;
}
function addReader(db, name = 'Читател') {
  return db.prepare('INSERT INTO readers (name, category) VALUES (?, ?)').run(name, 'възрастен').lastInsertRowid;
}

/* --- Находка 2: втора бройка от заглавие с quantity ≥ 2 --- */

test('заемане с баркод пуска ВТОРАТА бройка на заглавие с quantity = 2', async () => {
  const { db, ipcMain } = setupLoans();
  const bookId = addBook(db, { inv_number: 7, quantity: 2 });
  const r1 = addReader(db, 'Първи'), r2 = addReader(db, 'Втори');
  const a = await ipcMain.invoke('loans:checkoutByCode', { reader_id: r1, code: '7' });
  assert.equal(a.ok, true, 'първата бройка се заема');
  const b = await ipcMain.invoke('loans:checkoutByCode', { reader_id: r2, code: '7' });
  assert.equal(b.ok, true, 'втората бройка също трябва да се заема — схемата я допуска изрично (trg_loans_capacity)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM loans WHERE book_id = ? AND date_in IS NULL').get(bookId).n, 2);
});

test('заемане с баркод отказва ТРЕТАТА бройка, когато quantity = 2, с ясно съобщение', async () => {
  const { db, ipcMain } = setupLoans();
  addBook(db, { inv_number: 7, quantity: 2 });
  const rs = [addReader(db, 'А'), addReader(db, 'Б'), addReader(db, 'В')];
  await ipcMain.invoke('loans:checkoutByCode', { reader_id: rs[0], code: '7' });
  await ipcMain.invoke('loans:checkoutByCode', { reader_id: rs[1], code: '7' });
  const third = await ipcMain.invoke('loans:checkoutByCode', { reader_id: rs[2], code: '7' });
  assert.equal(third.ok, false);
  assert.match(third.error, /свободна бройка|заети са всички/i);
});

test('при единствена бройка съобщението продължава да казва КОЙ я е взел и докога', async () => {
  const { db, ipcMain } = setupLoans();
  addBook(db, { inv_number: 3, quantity: 1 });
  const r1 = addReader(db, 'Иван Вазов'), r2 = addReader(db, 'Друг');
  await ipcMain.invoke('loans:checkoutByCode', { reader_id: r1, code: '3' });
  const res = await ipcMain.invoke('loans:checkoutByCode', { reader_id: r2, code: '3' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Иван Вазов/);
});

/* --- Находка 9: повторно връщане --- */

test('loans:return отказва ВТОРО връщане на същото заемане и не удвоява наказанието', async () => {
  const { db, ipcMain } = setupLoans();
  const bookId = addBook(db, { inv_number: 1 });
  const readerId = addReader(db);
  // Заемане с падеж далеч в миналото — 16 дни забава спрямо today() = 2026-08-02.
  const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2026-07-01', '2026-07-17').lastInsertRowid;

  const first = await ipcMain.invoke('loans:return', { id: loanId });
  assert.equal(first.ok, true);
  const afterFirst = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId).suspended_until;

  const second = await ipcMain.invoke('loans:return', { id: loanId });
  assert.equal(second.ok, false, 'второто връщане трябва да бъде отказано');
  assert.match(second.error, /вече е върнато/);
  const afterSecond = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId).suspended_until;
  assert.equal(afterSecond, afterFirst, 'наказанието не бива да се натрупва втори път');
});

/* --- Находка 11: таванът важи за общото натрупано наказание --- */

test('таванът на наказанието важи за ОБЩОТО натрупано, не за всяко връщане поотделно', async () => {
  // Три книги, всяка с голяма забава, върнати в един и същи ден, таван 30 дни.
  const { db, ipcMain } = setupLoans({
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 1, suspend_max: 30 })
  });
  const readerId = addReader(db);
  for (let i = 1; i <= 3; i++) {
    const bookId = addBook(db, { inv_number: i });
    const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
      .run(readerId, bookId, '2026-01-01', '2026-05-01').lastInsertRowid; // ~93 дни забава
    const res = await ipcMain.invoke('loans:return', { id: loanId });
    assert.equal(res.ok, true);
  }
  const until = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId).suspended_until;
  // today() = 2026-08-02 + таван 30 дни = 2026-09-01. Преди поправката: 3×30 дни.
  assert.equal(until, '2026-09-01', 'три връщания при таван 30 дни не бива да дават 90 дни наказание');
});

/* ОБЪРНАТ във v2.3.0. Тук стоеше твърдението „suspend_max = 0 означава «без таван»".
   То кодираше регресия, въведена със самата поправка на v2.2.0: до нея изразът беше
   `rule.suspend_max || 90`, тоест вписана нула значеше „таван 90 дни", а v2.2.0 я
   преобърна на „без таван". Ефектът в реална база с нула в полето: 779 дни забава →
   преустановено заемане до 2028 г. вместо до +90 дни.
   Нулата в това поле не значи „без ограничение" — никой библиотекар не вписва 0 с
   намерение „наказвай неограничено". Изключването на наказанието става с
   suspend_per_day = 0, както пише и подсказката на съседното поле. */
test('suspend_max = 0 се третира като тавана по подразбиране, не като „без таван"', async () => {
  const { db, ipcMain } = setupLoans({
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 1, suspend_max: 0 })
  });
  const readerId = addReader(db);
  const bookId = addBook(db, { inv_number: 1 });
  const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2026-01-01', '2026-01-11').lastInsertRowid; // 203 дни забава
  await ipcMain.invoke('loans:return', { id: loanId });
  const until = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId).suspended_until;
  assert.equal(until, '2026-10-31', 'today (02.08.2026) + 90 дни по подразбиране');
});

/* --- Находка 10: смяна на лятното часово време ---
   Тези тестове имат смисъл САМО под TZ=Europe/Sofia (под UTC двете скàли съвпадат
   и старият код също минаваше) — точно затова дефектът оцеля 547 теста. npm test
   се пуска и в двете зони, така че тук просто проверяваме резултата и в двете. */

test('падежът при заемане не се измества с ден назад през смяната на лятното часово време', async () => {
  const { db, ipcMain } = setupLoans({
    today: () => '2026-03-05',
    circRule: () => ({ loan_days: 30, max_books: 5, extensions_count: 2, extension_days: 30, suspend_per_day: 0, suspend_max: 90 })
  });
  addBook(db, { inv_number: 5 });
  const readerId = addReader(db);
  const res = await ipcMain.invoke('loans:checkoutByCode', { reader_id: readerId, code: '5' });
  assert.equal(res.ok, true);
  // 05.03 + 30 дни = 04.04. Преди поправката под Europe/Sofia излизаше 03.04.
  assert.equal(res.data.date_due, '2026-04-04');
});

test('продължението на срока също не губи ден през смяната на часа', async () => {
  const { db, ipcMain } = setupLoans({
    today: () => '2026-03-20',
    circRule: () => ({ loan_days: 30, max_books: 5, extensions_count: 2, extension_days: 30, suspend_per_day: 0, suspend_max: 90 })
  });
  const bookId = addBook(db, { inv_number: 6 });
  const readerId = addReader(db);
  const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2026-03-20', '2026-03-20').lastInsertRowid;
  const res = await ipcMain.invoke('loans:extend', { id: loanId });
  assert.equal(res.ok, true);
  assert.equal(res.data.date_due, '2026-04-19'); // преди поправката: 18.04
});

/* --- Находка 12: една и съща сума на обезщетението навсякъде --- */

test('справката за просрочени дава ЦЕЛИ дни забава и същата сума, каквато ще се начисли при връщане', async () => {
  const { db, ipcMain } = setupLoans();
  db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const bookId = addBook(db, { inv_number: 1 });
  const readerId = addReader(db, 'Просрочил');
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2026-07-01', '2026-07-26'); // 7 дни забава спрямо 2026-08-02

  const res = await ipcMain.invoke('loans:overdueByReader');
  assert.equal(res.ok, true);
  const row = res.data.find(r => r.reader_id === readerId);
  // 7 цели дни × 0.10 = 0.70. Старият SQL даваше дробни дни (7.6xx) и зависеше от часа.
  assert.ok(Math.abs(row.fine - 0.70) < 1e-9, 'очаквано 0.70 лв., получено ' + row.fine);
});

test('напомнителното писмо иска същата сума като справката (не дробни дни от julianday)', async () => {
  const db = freshDb();
  db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const bookId = addBook(db, { inv_number: 1 });
  const readerId = addReader(db, 'Просрочил');
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2026-07-01', '2026-07-26');

  const loansIpc = fakeIpcMain();
  const { LOAN_SELECT, effectiveDaysLate } = registerLoansHandlers(loansIpc, {
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02', logEvent: () => {},
    BOOK_SELECT, scheduleCatalogWrite: () => {},
    circRule: () => ({ loan_days: 14, max_books: 5, suspend_per_day: 0, suspend_max: 90 }),
    readerCategory: () => 'възрастен', nextWorkDay: (d) => d, closedDaysBetween: () => 0,
    firstActiveHold: () => null, consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null,
    normalizeScanCode
  });
  assert.equal(typeof effectiveDaysLate, 'function', 'loans.js трябва да върне effectiveDaysLate за напомнянията');

  const noticesIpc = fakeIpcMain();
  registerNoticesHandlers(noticesIpc, {
    getDb: () => db, run, today: () => '2026-08-02', LOAN_SELECT,
    EUR_RATE: 1.95583, isValidEmail: () => true, shell: { openExternal: () => {} }, effectiveDaysLate
  });
  const res = await noticesIpc.invoke('loans:reminders');
  assert.equal(res.ok, true);
  const row = res.data.find(r => r.reader_id === readerId);
  assert.ok(Math.abs(row.fine - 0.70) < 1e-9, 'писмото трябва да иска 0.70 лв., а иска ' + row.fine);
});

/* --- Находка 3: вид на инвентаризацията --- */

function setupInvent() {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  const auditLog = [];
  registerInventoryHandlers(ipcMain, {
    getDb: () => db, run,
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    // Нормативните формули по Наредба № 3 идват от main.js (виж заглавието на
    // файла) — преписаното тук `pool * 0.002` беше вече РАЗМИНАТО с нормата.
    pctRequired,
    naturalLoss,
    normalizeScanCode
  });
  return { db, ipcMain, auditLog };
}

test('представителна инвентаризация НЕ маркира несканираните като липсващи', async () => {
  const { db, ipcMain } = setupInvent();
  for (let i = 1; i <= 100; i++) addBook(db, { inv_number: i });
  const open = await ipcMain.invoke('inventorySessions:start',
    { date: '2026-08-02', scope: 'представителна', department: null, committee1: null, committee2: null, committee3: null });
  assert.equal(open.ok, true);
  const sid = open.data;
  for (let i = 1; i <= 10; i++) await ipcMain.invoke('inventorySessions:scan', { sessionId: sid, code: String(i) });

  const res = await ipcMain.invoke('inventorySessions:close', { sessionId: sid, mode: 'representative' });
  assert.equal(res.ok, true);
  assert.equal(res.data.missing, 0, 'при представителна проверка липсващи няма');
  assert.equal(res.data.unchecked, 90, 'непроверените се отчитат отделно, без да са липсващи');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM books WHERE status = 'липсващ'").get().n, 0,
    'нито един статус не бива да е презаписан');
});

test('пълна инвентаризация продължава да маркира несканираните като липсващи', async () => {
  const { db, ipcMain } = setupInvent();
  for (let i = 1; i <= 20; i++) addBook(db, { inv_number: i });
  const open = await ipcMain.invoke('inventorySessions:start',
    { date: '2026-08-02', scope: 'пълна', department: null, committee1: null, committee2: null, committee3: null });
  const sid = open.data;
  for (let i = 1; i <= 15; i++) await ipcMain.invoke('inventorySessions:scan', { sessionId: sid, code: String(i) });

  const res = await ipcMain.invoke('inventorySessions:close', { sessionId: sid, mode: 'full' });
  assert.equal(res.ok, true);
  assert.equal(res.data.missing, 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM books WHERE status = 'липсващ'").get().n, 5);
});

test('приключване БЕЗ изричен вид е представителното (безопасното), а не масово маркиране', async () => {
  const { db, ipcMain } = setupInvent();
  for (let i = 1; i <= 10; i++) addBook(db, { inv_number: i });
  const open = await ipcMain.invoke('inventorySessions:start',
    { date: '2026-08-02', scope: '', department: null, committee1: null, committee2: null, committee3: null });
  const sid = open.data;
  await ipcMain.invoke('inventorySessions:scan', { sessionId: sid, code: '1' });
  const res = await ipcMain.invoke('inventorySessions:close', sid); // стар подпис, голо id
  assert.equal(res.ok, true);
  assert.equal(res.data.missing, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM books WHERE status = 'липсващ'").get().n, 0);
});

test('вече приключена инвентаризация не се приключва втори път', async () => {
  const { db, ipcMain } = setupInvent();
  addBook(db, { inv_number: 1 });
  const open = await ipcMain.invoke('inventorySessions:start',
    { date: '2026-08-02', scope: '', department: null, committee1: null, committee2: null, committee3: null });
  const sid = open.data;
  await ipcMain.invoke('inventorySessions:close', { sessionId: sid, mode: 'representative' });
  const again = await ipcMain.invoke('inventorySessions:close', { sessionId: sid, mode: 'full' });
  assert.equal(again.ok, false);
  assert.match(again.error, /вече е приключена/);
});
