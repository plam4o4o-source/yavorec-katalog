/* Заемания с ИСТИНСКИЯ календар (без заглушки).
   =====================================================================
   ЗАЩО СЪЩЕСТВУВА: test/handlers-loans.test.js подава
   `nextWorkDay: (d) => d` и `closedDaysBetween: () => 0`, тоест целият
   домейн — падеж, наказание, обезщетение — се тества с ИЗКЛЮЧЕН календар.
   А точно свързването на двата модула е мястото, където се появяват грешките
   „с един ден": падеж, паднал се в неделя; наказание, изтеглено през
   национален празник; обезщетение, начислено за дни, в които библиотеката е
   била затворена и читателят няма как да е върнал книгата.

   Тук handlers/loans.js получава РЕАЛНИТЕ nextWorkDay/closedDaysBetween,
   върнати от handlers/calendar.js, върху обща база — точно както ги свързва
   main.js. Проверяват се и трите изхода на календара:
     • падеж, паднал се в затворен ден → мести се напред;
     • наказание (suspended_until) през период със затворени дни;
     • обезщетение (fine) за същия период — двете задължително се смятат от
       една и съща функция effectiveDaysLate.

   Датите нарочно излизат извън август 2026 (единственият месец, който
   досегашните тестове докосваха): 25.10.2026 е есенната смяна на часа. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerLoansHandlers = require('../handlers/loans');
const registerCalendarHandlers = require('../handlers/calendar');
const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values.js');

const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* без значение */ } }
});

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

/* today по подразбиране е 02.08.2026 — както в останалите тестове; всеки тест,
   който излиза от август, го подава изрично. */
function setup({ today = '2026-08-02', workDays = '1,2,3,4,5', closed = [], rule = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-loans-cal-'));
  tmpDirs.push(dir);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.prepare('UPDATE settings SET work_days = ?, fine_per_day = 0.10 WHERE id = 1').run(workDays);
  for (const [date, reason] of closed) {
    db.prepare('INSERT OR IGNORE INTO calendar_closed (date, reason) VALUES (?, ?)').run(date, reason);
  }

  const run = (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } };
  const auditLog = [];
  const events = [];
  const ipcMain = fakeIpcMain();

  // ИСТИНСКИТЕ календарни функции — точно както ги връща calendar.js в main.js.
  const calendar = registerCalendarHandlers(ipcMain, { getDb: () => db, run, logAudit: () => {} });

  registerLoansHandlers(ipcMain, {
    getDb: () => db, run,
    logAudit: (action, detail, diff) => auditLog.push({ action, detail, diff }),
    today: () => today,
    logEvent: (kind, opts) => events.push({ kind, opts }),
    BOOK_SELECT, scheduleCatalogWrite: () => {},
    circRule: () => Object.assign({
      loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14,
      suspend_per_day: 1, suspend_max: 90
    }, rule),
    readerCategory: () => 'възрастен',
    nextWorkDay: calendar.nextWorkDay,
    closedDaysBetween: calendar.closedDaysBetween,
    firstActiveHold: () => null, consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null,
    normalizeScanCode
  });
  return { db, ipcMain, auditLog, events, calendar };
}

function addBook(db, { inv_number = 1, barcode = 'BC1', quantity = 1 } = {}) {
  const id = db.prepare('INSERT INTO books (inv_number, title, status, barcode) VALUES (?,?,?,?)')
    .run(inv_number, 'Книга ' + inv_number, 'наличен', barcode).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, quantity);
  return id;
}
function addReader(db, name = 'Иван Петров') {
  return db.prepare("INSERT INTO readers (name, card_no, category, status) VALUES (?, ?, 'възрастен', 'активен')")
    .run(name, 'K-' + name.length + Math.random().toString(36).slice(2, 6)).lastInsertRowid;
}

/* ---------------- 1) Падеж, паднал се в затворен ден ---------------- */

test('падеж, паднал се в събота, се мести напред до понеделник', async () => {
  // 02.11.2026 (понеделник) + 14 дни = 16.11.2026 (понеделник) — местим го
  // изкуствено, като вземем 04.11 → 18.11 (сряда). Затова тук: 07.11 е събота.
  const { db, ipcMain } = setup({ today: '2026-10-24', rule: { loan_days: 14 } });
  const bookId = addBook(db, { inv_number: 1, barcode: 'BC1' });
  addReader(db);
  // 24.10.2026 е събота; + 14 дни = 07.11.2026 — също събота.
  const res = await ipcMain.invoke('loans:checkoutByCode', { code: 'BC1', reader_id: 1 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.date_due, '2026-11-09',
    'падеж в събота (07.11) трябва да се премести на понеделник 09.11, а не да остане в затворен ден');
  assert.equal(db.prepare('SELECT date_due FROM loans WHERE book_id = ?').get(bookId).date_due, '2026-11-09');
});

test('падеж, паднал се в национален празник, също се мести напред', async () => {
  // 24.05.2026 е неделя; 25.05 е понеделник, но нека библиотеката е затворена
  // и на 25-и, и на 26-и — падежът трябва да стигне до 27-и.
  const { db, ipcMain } = setup({
    today: '2026-05-11',
    closed: [['2026-05-25', 'официален празник'], ['2026-05-26', 'неработен ден']],
    rule: { loan_days: 14 }
  });
  addBook(db, { inv_number: 2, barcode: 'BC2' });
  addReader(db);
  const res = await ipcMain.invoke('loans:checkoutByCode', { code: 'BC2', reader_id: 1 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.date_due, '2026-05-27',
    '11.05 + 14 дни = 25.05 (затворен) → 26.05 (затворен) → 27.05');
});

test('продължението на срока също минава през календара', async () => {
  const { db, ipcMain } = setup({ today: '2026-10-19', rule: { extension_days: 14 } });
  const bookId = addBook(db, { inv_number: 3, barcode: 'BC3' });
  const readerId = addReader(db);
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(bookId, readerId, '2026-10-19', '2026-10-24').lastInsertRowid; // падеж в събота
  const res = await ipcMain.invoke('loans:extend', { id: loanId });
  assert.equal(res.ok, true, res.error);
  // 24.10 + 14 = 07.11.2026 — събота → 09.11 (понеделник)
  assert.equal(res.data.date_due, '2026-11-09', 'новият падеж не бива да е в затворен ден');
});

/* ---------------- 2) Наказание през период със затворени дни ---------------- */

test('наказанието НЕ брои затворените дни — библиотеката е била затворена', async () => {
  /* Падеж петък 23.10.2026, връщане вторник 27.10.2026 = 4 календарни дни
     закъснение. Но 24 и 25 са уикенд, а 26-и е обявен за затворен —
     остава 1 ефективен ден. При suspend_per_day = 1 наказанието е 1 ден.
     Периодът нарочно пресича есенната смяна на часа (25.10.2026). */
  const { db, ipcMain } = setup({
    today: '2026-10-27',
    closed: [['2026-10-26', 'ремонт']],
    rule: { suspend_per_day: 1, suspend_max: 90 }
  });
  const bookId = addBook(db, { inv_number: 4 });
  const readerId = addReader(db);
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(bookId, readerId, '2026-10-09', '2026-10-23').lastInsertRowid;

  const res = await ipcMain.invoke('loans:return', { id: loanId, date_in: '2026-10-27' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.daysLate, 1,
    'от 4 календарни дни закъснение 3 са затворени (24, 25, 26) — остава 1');
  assert.equal(res.data.suspendedUntil, '2026-10-28', 'наказание 1 ден от днес (27.10)');
  assert.equal(db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId).suspended_until, '2026-10-28');
});

test('връщане изцяло в затворени дни не води до никакво наказание', async () => {
  const { db, ipcMain } = setup({
    today: '2026-10-26',
    closed: [['2026-10-26', 'ремонт']],
    rule: { suspend_per_day: 1 }
  });
  const bookId = addBook(db, { inv_number: 5 });
  const readerId = addReader(db);
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(bookId, readerId, '2026-10-09', '2026-10-23').lastInsertRowid;

  const res = await ipcMain.invoke('loans:return', { id: loanId, date_in: '2026-10-26' });
  assert.equal(res.data.daysLate, 0, '24, 25 и 26 октомври са затворени — забава няма');
  assert.equal(res.data.suspendedUntil, null, 'без ефективна забава няма и наказание');
  assert.equal(db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId).suspended_until, null);
});

/* ---------------- 3) Обезщетение за същия период ---------------- */

test('обезщетението се смята от СЪЩИТЕ ефективни дни като наказанието', async () => {
  const { db, ipcMain } = setup({
    today: '2026-10-27',
    closed: [['2026-10-26', 'ремонт']],
    rule: { suspend_per_day: 1 }
  });
  const bookId = addBook(db, { inv_number: 6 });
  const readerId = addReader(db);
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(bookId, readerId, '2026-10-09', '2026-10-23').lastInsertRowid;

  const res = await ipcMain.invoke('loans:return', { id: loanId, date_in: '2026-10-27' });
  assert.equal(res.data.daysLate, 1);
  assert.ok(Math.abs(res.data.fine - 0.10) < 1e-9, 'обезщетение за 1 ефективен ден по 0,10 лв., а е ' + res.data.fine);
  const stored = db.prepare('SELECT fine, date_in FROM loans WHERE id = ?').get(loanId);
  assert.ok(Math.abs(stored.fine - 0.10) < 1e-9, 'записаната в базата сума трябва да е същата');
  assert.equal(stored.date_in, '2026-10-27');
});

test('loans:overdue показва същото обезщетение, каквото ще се начисли при връщане', async () => {
  /* Дотук справката и самото начисляване можеха да се разминат — тук се
     проверява, че двете тръгват от една и съща сметка при ИСТИНСКИ календар.
     Забележка за датите: филтърът на loans:overdue е `date_due < date('now')`
     със СИСТЕМНОТО днес, затова падежът тук е в реалното минало (юни 2026),
     докато today() остава заместител. */
  const { db, ipcMain } = setup({
    today: '2026-06-30',
    closed: [['2026-06-29', 'ремонт']], // понеделник
    rule: { suspend_per_day: 1 }
  });
  const bookId = addBook(db, { inv_number: 7 });
  const readerId = addReader(db);
  // падеж петък 26.06; 27–28 са уикенд, 29-и е затворен → само 30-и е ефективен
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(bookId, readerId, '2026-06-12', '2026-06-26').lastInsertRowid;

  const list = await ipcMain.invoke('loans:overdue');
  assert.equal(list.ok, true, list.error);
  const row = list.data.find(r => r.id === loanId);
  assert.ok(row, 'просроченото заемане трябва да е в справката');
  assert.equal(row.daysLate, 1, 'справката вижда 1 ефективен ден');
  assert.ok(Math.abs(row.fine - 0.10) < 1e-9);

  const ret = await ipcMain.invoke('loans:return', { id: loanId, date_in: '2026-06-30' });
  assert.equal(ret.data.daysLate, row.daysLate, 'справката и начисляването не бива да се разминават');
  assert.ok(Math.abs(ret.data.fine - row.fine) < 1e-9);
});

test('период през годишната граница: затворените 31.12 и 01.01 не се броят за забава', async () => {
  const { db, ipcMain } = setup({
    today: '2027-01-04',
    workDays: '0,1,2,3,4,5,6', // всички дни работни, за да се вижда само ефектът на затворените
    closed: [['2026-12-31', 'Нова година'], ['2027-01-01', 'Нова година']],
    rule: { suspend_per_day: 1 }
  });
  const bookId = addBook(db, { inv_number: 8 });
  const readerId = addReader(db);
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(bookId, readerId, '2026-12-16', '2026-12-30').lastInsertRowid;

  const res = await ipcMain.invoke('loans:return', { id: loanId, date_in: '2027-01-04' });
  assert.equal(res.data.daysLate, 3,
    'от 5 дни (31.12, 01–04.01) два са затворени — остават 3');
  assert.equal(res.data.suspendedUntil, '2027-01-07');
});

/* ---------------- 4) Ръбовете на календарната аритметика ----------------
   addDays() в handlers/loans.js смята изцяло в UTC; проверява се през
   loans:checkoutByCode (date_out + loan_days), защото самата функция не се
   изнася от модула. Работни са ВСИЧКИ дни, за да е видима само аритметиката,
   без намесата на nextWorkDay. Досегашните тестове по дати не излизаха от
   01–04.08.2026 — тоест нито един от тези три ръба не беше докоснат. */
function allDaysOpen(overrides) {
  return setup(Object.assign({ workDays: '0,1,2,3,4,5,6' }, overrides));
}

test('addDays през есенната смяна на часа (25.10.2026 — 25-часов ден) не губи ден', async () => {
  const { db, ipcMain } = allDaysOpen({ today: '2026-10-20', rule: { loan_days: 14 } });
  addBook(db, { inv_number: 101, barcode: 'D1' });
  addReader(db);
  const res = await ipcMain.invoke('loans:checkoutByCode', { code: 'D1', reader_id: 1 });
  assert.equal(res.data.date_due, '2026-11-03',
    '20.10 + 14 дни = 03.11 дори когато интервалът съдържа 25-часовия ден на смяната');
});

test('addDays през пролетната смяна на часа (29.03.2026 — 23-часов ден) не добавя ден', async () => {
  const { db, ipcMain } = allDaysOpen({ today: '2026-03-25', rule: { loan_days: 14 } });
  addBook(db, { inv_number: 102, barcode: 'D2' });
  addReader(db);
  const res = await ipcMain.invoke('loans:checkoutByCode', { code: 'D2', reader_id: 1 });
  assert.equal(res.data.date_due, '2026-04-08', '25.03 + 14 дни = 08.04 и през 23-часовия ден');
});

test('addDays през 29 февруари във високосна година брои и самия ден', async () => {
  const { db, ipcMain } = allDaysOpen({ today: '2028-02-20', rule: { loan_days: 14 } });
  addBook(db, { inv_number: 103, barcode: 'D3' });
  addReader(db);
  const res = await ipcMain.invoke('loans:checkoutByCode', { code: 'D3', reader_id: 1 });
  assert.equal(res.data.date_due, '2028-03-05',
    '20.02.2028 + 14 дни = 05.03, защото 2028 е високосна и февруари има 29 дни');
});

test('addDays в НЕвисокосна година дава ден по-рано за същия период', async () => {
  const { db, ipcMain } = allDaysOpen({ today: '2027-02-20', rule: { loan_days: 14 } });
  addBook(db, { inv_number: 104, barcode: 'D4' });
  addReader(db);
  const res = await ipcMain.invoke('loans:checkoutByCode', { code: 'D4', reader_id: 1 });
  assert.equal(res.data.date_due, '2027-03-06', '2027 не е високосна — 20.02 + 14 = 06.03');
});

test('addDays през границата на годината 31.12 → 01.01 сменя и годината', async () => {
  const { db, ipcMain } = allDaysOpen({ today: '2026-12-27', rule: { loan_days: 14 } });
  addBook(db, { inv_number: 105, barcode: 'D5' });
  addReader(db);
  const res = await ipcMain.invoke('loans:checkoutByCode', { code: 'D5', reader_id: 1 });
  assert.equal(res.data.date_due, '2027-01-10', '27.12.2026 + 14 дни = 10.01.2027, не 10.01.2026');
});

test('заемане точно на 31.12 с еднодневен срок дава падеж 01.01 следващата година', async () => {
  const { db, ipcMain } = allDaysOpen({ today: '2026-12-31', rule: { loan_days: 1 } });
  addBook(db, { inv_number: 106, barcode: 'D6' });
  addReader(db);
  const res = await ipcMain.invoke('loans:checkoutByCode', { code: 'D6', reader_id: 1 });
  assert.equal(res.data.date_due, '2027-01-01');
});

test('наказание, което пресича границата на годината, се изчислява правилно', async () => {
  const { db, ipcMain } = allDaysOpen({ today: '2026-12-28', rule: { suspend_per_day: 5, suspend_max: 90 } });
  const bookId = addBook(db, { inv_number: 107 });
  const readerId = addReader(db);
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(bookId, readerId, '2026-12-10', '2026-12-26').lastInsertRowid;
  const res = await ipcMain.invoke('loans:return', { id: loanId, date_in: '2026-12-28' });
  assert.equal(res.data.daysLate, 2);
  assert.equal(res.data.suspendedUntil, '2027-01-07',
    '28.12.2026 + 10 дни наказание = 07.01.2027 — наказанието трябва да мине в новата година');
});
