// Тест на handlers/loans.js — двайсет и първи домейн, извадено от main.js
// (Фаза 4, стъпка 22) — един от "големите пет". Проверява заемане/връщане/
// продължение (по ID и по баркод/инв. №), наказанията за просрочие,
// взаимодействието с резервации (holds) и логването на събития.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerLoansHandlers = require('../handlers/loans');
const { normalizeScanCode } = require('../security-utils');

const BOOK_SELECT = `
  SELECT b.*, c.name AS category_name
  FROM books b
  LEFT JOIN categories c ON c.id = b.category_id
`;

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-loans-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const events = [];
  const holds = new Map(); // bookId -> hold row, faked

  const ipcMain = fakeIpcMain();
  const deps = Object.assign({
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    today: () => '2026-08-02',
    logEvent: (kind, opts) => events.push({ kind, opts }),
    BOOK_SELECT,
    scheduleCatalogWrite: () => {},
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 1, suspend_max: 90 }),
    readerCategory: (readerId) => {
      const r = db.prepare('SELECT category FROM readers WHERE id = ?').get(readerId);
      return r ? r.category : 'възрастен';
    },
    nextWorkDay: (d) => d,
    closedDaysBetween: () => 0,
    firstActiveHold: () => null,
    consumeHoldOnCheckout: () => {},
    activateHoldOnReturn: () => null,
    normalizeScanCode
  }, overrides);
  const returned = registerLoansHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, events, returned };
}

function insertBookWithInventory(db, { inv_number = 1, quantity = 1, status = 'наличен', barcode } = {}) {
  const bookId = db.prepare('INSERT INTO books (inv_number, title, status, barcode) VALUES (?, ?, ?, ?)')
    .run(inv_number, 'Книга ' + inv_number, status, barcode || null).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(bookId, quantity);
  return bookId;
}

test('registerLoansHandlers registers events:localuse plus all ten loans: IPC channels, and returns LOAN_SELECT', () => {
  const { ipcMain, returned } = setup();
  for (const ch of ['events:localuse', 'loans:list', 'loans:overdue', 'loans:byReader', 'loans:byBook',
    'loans:overdueByReader', 'loans:checkout', 'loans:return', 'loans:extend',
    'loans:checkoutByCode', 'loans:returnByCode']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
  assert.match(returned.LOAN_SELECT, /SELECT l\.\*/);
});

test('loans:checkout refuses when there are no free copies, and succeeds otherwise, logging an event and audit entry', async () => {
  const { db, ipcMain, auditLog, events } = setup();
  const bookId = insertBookWithInventory(db, { inv_number: 1, quantity: 0 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;

  const full = await ipcMain.invoke('loans:checkout', { reader_id: readerId, book_id: bookId, date_out: '2026-08-02' });
  assert.equal(full.ok, false);
  assert.match(full.error, /Няма свободни бройки/);

  db.prepare('UPDATE inventory SET quantity = 1 WHERE book_id = ?').run(bookId);
  const result = await ipcMain.invoke('loans:checkout', { reader_id: readerId, book_id: bookId, date_out: '2026-08-02', date_due: '2026-08-16' });
  assert.equal(result.ok, true);
  assert.equal(auditLog.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'заемане');
});

test('loans:checkout refuses a suspended reader via checkSuspended', async () => {
  const { db, ipcMain } = setup();
  const bookId = insertBookWithInventory(db, { inv_number: 2 });
  const readerId = db.prepare("INSERT INTO readers (name, suspended_until) VALUES ('Наказан', '2030-01-01')").run().lastInsertRowid;
  const result = await ipcMain.invoke('loans:checkout', { reader_id: readerId, book_id: bookId, date_out: '2026-08-02' });
  assert.equal(result.ok, false);
  assert.match(result.error, /преустановено/);
});

test('loans:checkout defers to consumeHoldOnCheckout, which can block the checkout', async () => {
  const { db, ipcMain } = setup({
    consumeHoldOnCheckout: () => { throw new Error('Книгата е резервирана за друг.'); }
  });
  const bookId = insertBookWithInventory(db, { inv_number: 3 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const result = await ipcMain.invoke('loans:checkout', { reader_id: readerId, book_id: bookId, date_out: '2026-08-02' });
  assert.equal(result.ok, false);
  assert.match(result.error, /резервирана/);
});

test('loans:return closes the loan, logs an event/audit entry, calls activateHoldOnReturn, and applies suspension when overdue', async () => {
  const { db, ipcMain, auditLog, events } = setup({
    activateHoldOnReturn: (bookId) => ({ reader_name: 'Чакащ', card_no: 'C9', phone: '999' })
  });
  const bookId = insertBookWithInventory(db, { inv_number: 4 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Просрочил')").run().lastInsertRowid;
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookId, readerId, '2026-07-01', '2026-07-15').lastInsertRowid;

  const result = await ipcMain.invoke('loans:return', { id: loanId, date_in: '2026-08-02' });
  assert.equal(result.ok, true);
  assert.equal(result.data.hold.reader_name, 'Чакащ');
  assert.ok(result.data.suspendedUntil, 'a suspension should be applied for an overdue return');

  const loan = db.prepare('SELECT date_in FROM loans WHERE id = ?').get(loanId);
  assert.equal(loan.date_in, '2026-08-02');
  assert.equal(events.some(e => e.kind === 'връщане'), true);
  assert.ok(auditLog.some(a => a.action === 'Връщане'));
});

test('loans:extend refuses when the extension limit is reached, and refuses when the book is held by someone else', async () => {
  const { db, ipcMain } = setup({
    circRule: () => ({ extensions_count: 1, extension_days: 14 })
  });
  const bookId = insertBookWithInventory(db, { inv_number: 5 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Продължаващ')").run().lastInsertRowid;
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, renewals) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, readerId, '2026-08-01', '2026-08-15', 1).lastInsertRowid;

  const result = await ipcMain.invoke('loans:extend', { id: loanId });
  assert.equal(result.ok, false);
  assert.match(result.error, /Достигнат е лимитът/);
});

test('loans:extend succeeds, advances date_due by extension_days, and increments renewals', async () => {
  const { db, ipcMain, events } = setup();
  const bookId = insertBookWithInventory(db, { inv_number: 6 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Продължаващ Б')").run().lastInsertRowid;
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, renewals) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, readerId, '2026-08-01', '2026-08-15', 0).lastInsertRowid;

  const result = await ipcMain.invoke('loans:extend', { id: loanId });
  assert.equal(result.ok, true);
  assert.equal(result.data.date_due, '2026-08-29'); // +14 дни
  assert.equal(result.data.renewals, 1);
  assert.equal(events.some(e => e.kind === 'подновяване'), true);
});

test('loans:extend refuses a hold placed by a different reader', async () => {
  const { db, ipcMain } = setup({
    firstActiveHold: () => ({ reader_id: 999999, reader_name: 'Друг читател' })
  });
  const bookId = insertBookWithInventory(db, { inv_number: 7 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Държащ')").run().lastInsertRowid;
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookId, readerId, '2026-08-01', '2026-08-15').lastInsertRowid;

  const result = await ipcMain.invoke('loans:extend', { id: loanId });
  assert.equal(result.ok, false);
  assert.match(result.error, /резервирана от Друг читател/);
});

test('loans:checkoutByCode finds the book by barcode/inv_number via BOOK_SELECT, enforces max_books, and computes date_due via nextWorkDay', async () => {
  const { db, ipcMain } = setup({ nextWorkDay: (d) => d === '2026-08-16' ? '2026-08-17' : d });
  insertBookWithInventory(db, { inv_number: 8, barcode: 'BC8' });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Кодов читател')").run().lastInsertRowid;

  const result = await ipcMain.invoke('loans:checkoutByCode', { reader_id: readerId, code: 'BC8', date_out: '2026-08-02' });
  assert.equal(result.ok, true);
  assert.equal(result.data.inv_number, 8);
  assert.equal(result.data.date_due, '2026-08-17', 'nextWorkDay override bumps the raw +loan_days due date forward by a day');
});

test('loans:checkoutByCode refuses a deaccessioned book and an already-loaned book', async () => {
  const { db, ipcMain } = setup();
  insertBookWithInventory(db, { inv_number: 9, barcode: 'BC9', status: 'отчислен' });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Х')").run().lastInsertRowid;
  const deaccResult = await ipcMain.invoke('loans:checkoutByCode', { reader_id: readerId, code: 'BC9', date_out: '2026-08-02' });
  assert.equal(deaccResult.ok, false);
  assert.match(deaccResult.error, /отчислен/);

  const bookId = insertBookWithInventory(db, { inv_number: 10, barcode: 'BC10' });
  const otherReaderId = db.prepare("INSERT INTO readers (name) VALUES ('Друг')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, otherReaderId, '2026-08-01', '2026-08-15');
  const busyResult = await ipcMain.invoke('loans:checkoutByCode', { reader_id: readerId, code: 'BC10', date_out: '2026-08-02' });
  assert.equal(busyResult.ok, false);
  assert.match(busyResult.error, /вече е зает/);
});

test('loans:returnByCode computes a fine for late returns and applies suspension', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const bookId = insertBookWithInventory(db, { inv_number: 11, barcode: 'BC11' });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Закъснял')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-07-01', '2026-07-15');

  const result = await ipcMain.invoke('loans:returnByCode', { code: 'BC11', date_in: '2026-08-02' });
  assert.equal(result.ok, true);
  assert.ok(result.data.daysLate > 0);
  assert.ok(result.data.fine > 0);
});

test('loans:return computes and stores a fine identical to loans:returnByCode for the same overdue scenario (v1.70.0 fix)', async () => {
  // Преди v1.70.0: loans:return изобщо не пресмяташе/записваше fine (оставаше
  // NULL/0), докато loans:returnByCode го пресмяташе — двата бутона за връщане
  // на просрочена книга ("Приеми" срещу сканиране на баркод) даваха различен
  // резултат за иначе идентично закъснение.
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const readerA = db.prepare("INSERT INTO readers (name) VALUES ('Чрез бутон')").run().lastInsertRowid;
  const readerB = db.prepare("INSERT INTO readers (name) VALUES ('Чрез баркод')").run().lastInsertRowid;
  const bookA = insertBookWithInventory(db, { inv_number: 20, barcode: 'BC20A' });
  const bookB = insertBookWithInventory(db, { inv_number: 21, barcode: 'BC20B' });
  const loanIdA = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookA, readerA, '2026-07-01', '2026-07-15').lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookB, readerB, '2026-07-01', '2026-07-15');

  const viaButton = await ipcMain.invoke('loans:return', { id: loanIdA, date_in: '2026-08-02' });
  const viaBarcode = await ipcMain.invoke('loans:returnByCode', { code: 'BC20B', date_in: '2026-08-02' });

  assert.equal(viaButton.ok, true); assert.equal(viaBarcode.ok, true);
  assert.ok(viaButton.data.daysLate > 0, 'loans:return should now report daysLate');
  assert.equal(viaButton.data.daysLate, viaBarcode.data.daysLate, 'identical overdue period should give identical daysLate');
  assert.equal(viaButton.data.fine, viaBarcode.data.fine, 'identical overdue period should give identical fine');

  const storedFine = db.prepare('SELECT fine FROM loans WHERE id = ?').get(loanIdA).fine;
  assert.equal(storedFine, viaButton.data.fine, 'loans:return must persist the fine to loans.fine, not just return it');
  assert.ok(storedFine > 0);
});

test('loans:return excludes closed days from the fine, matching the suspension calculation', async () => {
  // И двете пресмятания (наказание в дни, глоба) минават през effectiveDaysLate()
  // — тук closedDaysBetween връща фиксирано 3, за да се провери, че fine пада
  // спрямо суровите календарни дни.
  const { db, ipcMain } = setup({ closedDaysBetween: () => 3 });
  db.prepare('UPDATE settings SET fine_per_day = 1 WHERE id = 1').run();
  const bookId = insertBookWithInventory(db, { inv_number: 22 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Затворени дни')").run().lastInsertRowid;
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookId, readerId, '2026-07-01', '2026-07-15').lastInsertRowid;

  // Сурово закъснение 2026-07-15 → 2026-08-02 = 18 календарни дни; минус 3
  // затворени = 15 работни дни закъснение.
  const result = await ipcMain.invoke('loans:return', { id: loanId, date_in: '2026-08-02' });
  assert.equal(result.ok, true);
  assert.equal(result.data.daysLate, 15);
  assert.equal(result.data.fine, 15);
});

test('loans:returnByCode refuses a code for a book that is not currently on loan', async () => {
  const { db, ipcMain } = setup();
  insertBookWithInventory(db, { inv_number: 12, barcode: 'BC12' });
  const result = await ipcMain.invoke('loans:returnByCode', { code: 'BC12', date_in: '2026-08-02' });
  assert.equal(result.ok, false);
  assert.match(result.error, /не е заето/);
});

test('events:localuse calls logEvent with читалня and returns true', async () => {
  const { ipcMain, events } = setup();
  const result = await ipcMain.invoke('events:localuse', { date: '2026-08-02' });
  assert.equal(result.ok, true);
  assert.equal(result.data, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'читалня');
});

test('loans:list filters by onlyOpen, loans:overdue/byReader/byBook return the right subsets', async () => {
  const { db, ipcMain } = setup();
  const bookId = insertBookWithInventory(db, { inv_number: 13, quantity: 2 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Списъчен')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-01-01', '2026-01-15');
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)').run(bookId, readerId, '2026-02-01', '2026-02-15', '2026-02-10');

  const open = await ipcMain.invoke('loans:list', { onlyOpen: true });
  assert.equal(open.data.length, 1);
  const all = await ipcMain.invoke('loans:list', {});
  assert.equal(all.data.length, 2);

  const overdue = await ipcMain.invoke('loans:overdue');
  assert.equal(overdue.data.length, 1);

  const byReader = await ipcMain.invoke('loans:byReader', readerId);
  assert.equal(byReader.data.length, 2);

  const byBook = await ipcMain.invoke('loans:byBook', bookId);
  assert.equal(byBook.data.length, 2);
});

test('loans:overdueByReader groups overdue loans by reader with a computed fine', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET fine_per_day = 0.20 WHERE id = 1').run();
  const bookId = insertBookWithInventory(db, { inv_number: 14 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Групиран')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-01-01', '2026-01-15');

  const result = await ipcMain.invoke('loans:overdueByReader');
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].n, 1);
  assert.equal(result.data[0].loans.length, 1);
});
