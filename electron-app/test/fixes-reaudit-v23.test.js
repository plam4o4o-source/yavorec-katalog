/* Тестове за втория кръг поправки в рамките на v2.3.0 — намереното от ПОВТОРНИЯ
   одит върху самата партида поправки. Половината от находките му бяха „половинчати
   поправки": промяната е направена на едното място, а близнакът ѝ е забравен. Това
   е и точният начин, по който партидата на v2.2.0 въведе четири регресии, затова
   всеки тест тук пази ДВОЙКАТА, не отделния файл. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerLoansHandlers = require('../handlers/loans');
const registerHoldsHandlers = require('../handlers/holds');
const registerDashboardHandlers = require('../handlers/dashboard');
const registerStatsHandlers = require('../handlers/stats');
const registerMzsHandlers = require('../handlers/mzs');
const registerAccountHandlers = require('../handlers/account');
const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values.js');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-reaudit-'));
  tmpDirs.push(dir);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* без значение */ } } });

function addBook(db, { inv_number = 1, quantity = 1 } = {}) {
  const id = db.prepare('INSERT INTO books (inv_number, title, status) VALUES (?, ?, ?)')
    .run(inv_number, 'Книга ' + inv_number, 'наличен').lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, quantity);
  return id;
}
const addReader = (db, name = 'Читател') =>
  db.prepare('INSERT INTO readers (name, category) VALUES (?, ?)').run(name, 'възрастен').lastInsertRowid;

/* Пълен стек заемания + резервации върху обща база, точно както ги свързва main.js —
   иначе половинчатите поправки между двата модула остават невидими. */
function setupLoansWithHolds(opts = {}) {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  const holds = registerHoldsHandlers(ipcMain, {
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02', normalizeScanCode
  });
  registerLoansHandlers(ipcMain, Object.assign({
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02', logEvent: () => {},
    BOOK_SELECT, scheduleCatalogWrite: () => {},
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 5, extension_days: 14, suspend_per_day: 1, suspend_max: 90 }),
    readerCategory: () => 'възрастен',
    nextWorkDay: (d) => d, closedDaysBetween: () => 0,
    firstActiveHold: holds.firstActiveHold,
    consumeHoldOnCheckout: holds.consumeHoldOnCheckout,
    activateHoldOnReturn: holds.activateHoldOnReturn,
    freeCopies: holds.freeCopies, activeHolds: holds.activeHolds,
    normalizeScanCode
  }, opts));
  return { db, ipcMain, holds };
}

/* --- Продължение на срока срещу свободни бройки --- */

test('loans:extend НЕ блокира, докато има свободна бройка за чакащия', async () => {
  const { db, ipcMain } = setupLoansWithHolds();
  const bookId = addBook(db, { inv_number: 1, quantity: 5 });
  const boris = addReader(db, 'Борис'), ana = addReader(db, 'Ана');
  const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(boris, bookId, '2026-07-01', '2026-08-10').lastInsertRowid;
  db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(bookId, ana);

  const res = await ipcMain.invoke('loans:extend', { id: loanId });
  assert.equal(res.ok, true,
    '4 свободни бройки при 1 чакащ — продължението не бива да се отказва; ' +
    'заемането вече брои бройки, а тук проверката беше останала на ниво заглавие: ' + res.error);
});

test('loans:extend отказва, когато свободните бройки не стигат за чакащите', async () => {
  const { db, ipcMain } = setupLoansWithHolds();
  const bookId = addBook(db, { inv_number: 1, quantity: 1 });
  const boris = addReader(db, 'Борис'), ana = addReader(db, 'Ана');
  const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(boris, bookId, '2026-07-01', '2026-08-10').lastInsertRowid;
  db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(bookId, ana);

  const res = await ipcMain.invoke('loans:extend', { id: loanId });
  assert.equal(res.ok, false, 'единствената бройка е обещана на Ана');
  assert.match(res.error, /Ана/);
});

test('собствената резервация не пречи на собственото продължение', async () => {
  const { db, ipcMain } = setupLoansWithHolds();
  const bookId = addBook(db, { inv_number: 1, quantity: 1 });
  const boris = addReader(db, 'Борис');
  const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(boris, bookId, '2026-07-01', '2026-08-10').lastInsertRowid;
  db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(bookId, boris);
  assert.equal((await ipcMain.invoke('loans:extend', { id: loanId })).ok, true);
});

/* --- Таблото и „Просрочени" смятат едно и също --- */

test('таблото и „Просрочени" дават ЕДНАКЪВ брой дни забава', async () => {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  // 4 затворени дни в периода: касата и „Просрочени" ги вадят.
  const closedDaysBetween = () => 4;
  const { effectiveDaysLate } = registerLoansHandlers(ipcMain, {
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02', logEvent: () => {},
    BOOK_SELECT, scheduleCatalogWrite: () => {},
    circRule: () => ({ loan_days: 14, max_books: 5, suspend_per_day: 0, suspend_max: 90 }),
    readerCategory: () => 'възрастен', nextWorkDay: (d) => d, closedDaysBetween,
    firstActiveHold: () => null, consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null,
    normalizeScanCode
  });
  registerDashboardHandlers(ipcMain, {
    getDb: () => db, run, today: () => '2026-08-02', yearOf: () => '2026',
    pctRequired: () => 10, isWorkDay: () => true,
    LOAN_SELECT: 'SELECT l.*, b.title, b.inv_number, r.name AS reader_name FROM loans l JOIN books b ON b.id=l.book_id JOIN readers r ON r.id=l.reader_id',
    countOverduePeriodicals: () => 0, effectiveDaysLate
  });
  const bookId = addBook(db, { inv_number: 1 });
  const readerId = addReader(db, 'Просрочил');
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2026-06-01', '2026-07-13'); // 20 календарни дни забава

  const over = (await ipcMain.invoke('loans:overdue')).data[0];
  const dash = (await ipcMain.invoke('dashboard:full')).data.overdueRows[0];
  assert.equal(over.daysLate, 16, '20 календарни минус 4 затворени');
  assert.equal(dash.daysLate, over.daysLate,
    'таблото показваше 20, а „Просрочени" 16 — един и същ ред, два различни отговора');
});

test('изгледът на таблото не смята дните сам', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'dashboard.js'), 'utf8');
  assert.doesNotMatch(src, /new Date\(today\(\)\)\s*-\s*new Date\(l\.date_due\)/,
    'дните идват от dashboard:summary — иначе двата екрана пак се разминават');
});

/* --- FIFO: ред на вписване в рамките на деня --- */

function setupStats() {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerStatsHandlers(ipcMain, {
    getDb: () => db, run, yearOf: () => '2026',
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: () => ({ hours: 0 })
  });
  const line = (rid, date, kind, type, amount) =>
    db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?,?,?,?,?)')
      .run(rid, date, kind, type, amount);
  return { db, ipcMain, line };
}

test('плащане, вписано ПРЕДИ начислението в същия ден, пак се приписва правилно', async () => {
  const { db, ipcMain, line } = setupStats();
  const r = addReader(db, 'Ч');
  // На гишето редът на вписване е произволен — парите често се записват първи.
  line(r, '2026-03-01', 'плащане', 'плащане', -5);
  line(r, '2026-03-01', 'начисление', 'обезщетение', 5);
  assert.equal((await ipcMain.invoke('stats:report', '2026')).data.finesCollected, 5,
    'при подреждане само по id тези пари увисваха като „аванс" и изчезваха от отчета');
});

test('хронологията между РАЗЛИЧНИ дни се пази — по-старото задължение първо', async () => {
  const { db, ipcMain, line } = setupStats();
  const r = addReader(db, 'Ч');
  line(r, '2026-01-10', 'начисление', 'годишна такса', 10);
  line(r, '2026-02-10', 'начисление', 'обезщетение', 4);
  line(r, '2026-03-01', 'плащане', 'плащане', -10); // покрива таксата, не обезщетението
  assert.equal((await ipcMain.invoke('stats:report', '2026')).data.finesCollected, 0);
});

/* --- МЗС: частично обновяване --- */

test('mzs:update не изтрива непратените полета', async () => {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerMzsHandlers(ipcMain, { getDb: () => db, run, logAudit: () => {}, yearOf: () => '2026' });
  const created = await ipcMain.invoke('mzs:create', {
    no: 1, date: '2026-03-01',
    direction: 'получаване', partner: 'РБ Габрово', author: 'Вазов, Иван', title: 'Под игото',
    isbn: '954', requester: 'Иван', status: 'заявено', due_date: '2026-04-01', note: 'спешно'
  });
  assert.equal(created.ok, true, created.error);
  const id = created.data;

  // Частично извикване — само статусът, както би направил бърз бутон „смени статуса".
  const upd = await ipcMain.invoke('mzs:update', { id, status: 'изпратено' });
  assert.equal(upd.ok, true, upd.error);
  const row = db.prepare('SELECT * FROM mzs_requests WHERE id = ?').get(id);
  assert.equal(row.status, 'изпратено');
  assert.equal(row.author, 'Вазов, Иван', 'авторът не бива да се трие при частично обновяване');
  assert.equal(row.isbn, '954');
  assert.equal(row.requester, 'Иван');
  assert.equal(row.due_date, '2026-04-01');
  assert.equal(row.note, 'спешно');
});

test('изрично празно поле в mzs:update ГИ изчиства — за да може бележка да се маха', async () => {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerMzsHandlers(ipcMain, { getDb: () => db, run, logAudit: () => {}, yearOf: () => '2026' });
  const id = (await ipcMain.invoke('mzs:create', {
    no: 1, date: '2026-03-01',
    direction: 'получаване', partner: 'РБ', title: 'Т', note: 'стара бележка', status: 'заявено'
  })).data;
  await ipcMain.invoke('mzs:update', { id, note: '' });
  assert.equal(db.prepare('SELECT note FROM mzs_requests WHERE id = ?').get(id).note, null);
});

/* --- Каса: проверява се сумата, която ще се запише --- */

test('начисление под стотинка се отказва, вместо да запише ред от 0.00 лв.', async () => {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerAccountHandlers(ipcMain, { getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02' });
  const readerId = addReader(db);
  const res = await ipcMain.invoke('account:charge', { reader_id: readerId, type: 'обезщетение', amount: 0.004 });
  assert.equal(res.ok, false, 'проверката гледаше суровата сума, а записът — закръглената');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_lines').get().n, 0);
});

test('нормално начисление продължава да минава', async () => {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerAccountHandlers(ipcMain, { getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02' });
  const readerId = addReader(db);
  assert.equal((await ipcMain.invoke('account:charge', { reader_id: readerId, type: 'обезщетение', amount: 1.15 })).ok, true);
  assert.equal(db.prepare('SELECT amount FROM account_lines').get().amount, 1.15);
});

/* --- Изгледи: половинчатите поправки --- */

test('видът на инвентаризацията се показва в списъка, не само в базата', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'inventory-sessions.js'), 'utf8');
  assert.match(src, /s\.mode/,
    'записването на mode без показване не решава нищо — точно това беше заявеният проблем');
  assert.match(src, /представителна/);
});

test('второто щракване за изтриване показва дословното предупреждение, не пак „Да изтрия ли…"', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'books.js'), 'utf8');
  assert.match(src, /confirmDangerousDelete/,
    'иначе рефлексът „не стана — да натисна пак" заличава историята на заеманията без път назад');
  assert.match(src, /НЕОБРАТИМО/);
  const readers = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'readers.js'), 'utf8');
  assert.match(readers, /confirmDangerousDelete/, 'близнакът при читателите също');
});

test('подсказката за таван по категория съответства на кода (0 → 90, не „общото")', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'settings.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes("'suspend_max'") && l.includes('Таван'));
  assert.ok(line, 'редът трябва да съществува');
  assert.doesNotMatch(line, /0 = общото/,
    'circRule връща 0 като 0, а applySuspension го превръща в 90 — не в глобалната стойност');
  assert.match(line, /90/);
});

test('прагът за етикети не говори за „листа A4" при печат на ролка', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'core.js'), 'utf8');
  assert.match(src, /ролка/, 'при perSheet = 1 броят листове е безсмислен');
});

test('твърде широк етикет получава СВОЕТО предупреждение, не успокоителното за колоните', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'core.js'), 'utf8');
  const wide = src.indexOf('Етикетът е широк');
  const cols = src.indexOf('Колоните са намалени');
  assert.ok(wide > 0 && cols > 0);
  assert.ok(wide < cols,
    'проверката за твърде широк етикет трябва да е ПЪРВА — иначе при нея се показва ' +
    '„колоните са намалени, готово", а етикетът пак излиза отрязан');
});
