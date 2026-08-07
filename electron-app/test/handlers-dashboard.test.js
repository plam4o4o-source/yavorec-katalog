// Тест на handlers/dashboard.js — двайсет и втори домейн, извадено от
// main.js (Фаза 4, стъпка 23). Чисто справочен домейн — проверява само
// агрегираните числа, без никакви записи.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerDashboardHandlers = require('../handlers/dashboard');
const registerPeriodicalsHandlers = require('../handlers/periodicals');

const LOAN_SELECT = `
  SELECT l.*, b.title, b.author, b.inv_number, r.name AS reader_name, r.card_no
  FROM loans l
  JOIN books b ON b.id = l.book_id
  JOIN readers r ON r.id = l.reader_id
`;

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-dashboard-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    today: () => '2026-08-02',
    yearOf: () => '2026',
    pctRequired: (n) => (n <= 50000 ? 10 : n <= 200000 ? 5 : 2),
    isWorkDay: () => true,
    LOAN_SELECT
  };
  registerDashboardHandlers(ipcMain, deps);
  return { db, ipcMain };
}

/* За тестовете на countOverduePeriodicals: истинската функция идва от
   handlers/periodicals.js, окачена в handlers/dashboard.js — точно както в
   main.js (периодика се регистрира преди табло заради тази зависимост).
   Регистрираме и двата модула върху една и съща db, за да проверим реалната
   връзка между тях, не заглушка. */
function setupWithPeriodicals() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-dashboard-per-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  const run = (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } };
  const today = () => '2026-08-02';
  const { countOverduePeriodicals } = registerPeriodicalsHandlers(ipcMain, {
    getDb: () => db, run, logAudit: () => {}, today
  });
  registerDashboardHandlers(ipcMain, {
    getDb: () => db, run, today, yearOf: () => '2026',
    pctRequired: (n) => (n <= 50000 ? 10 : n <= 200000 ? 5 : 2),
    isWorkDay: () => true, LOAN_SELECT, countOverduePeriodicals
  });
  return { db, ipcMain };
}

test('registerDashboardHandlers registers dashboard:stats and dashboard:full', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('dashboard:stats'));
  assert.ok(ipcMain.has('dashboard:full'));
});

test('dashboard:stats counts active books/readers, open loans, and overdue loans', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1, 'А', 'наличен')").run();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (2, 'Б', 'отчислен')").run();
  db.prepare("INSERT INTO readers (name, status) VALUES ('Читател 1', 'активен')").run();
  db.prepare("INSERT INTO readers (name, status) VALUES ('Читател 2', 'прекратен')").run();
  const bookId = db.prepare("SELECT id FROM books WHERE inv_number=1").get().id;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("SELECT id FROM readers WHERE name='Читател 1'").get().id;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-01-01', '2026-01-15');

  const result = await ipcMain.invoke('dashboard:stats');
  assert.equal(result.ok, true);
  assert.equal(result.data.books, 1, 'only non-deaccessioned books count');
  assert.equal(result.data.readers, 1, 'only non-terminated readers count');
  assert.equal(result.data.loansOpen, 1);
  assert.equal(result.data.overdue, 1);
});

test('dashboard:full aggregates fund value, upcoming due dates (via LOAN_SELECT), and inventory target (via pctRequired)', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, status, price, register_date) VALUES (1, 'А', 'наличен', 10, '2026-01-01')").run();
  const bookId = db.prepare("SELECT id FROM books WHERE inv_number=1").get().id;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  // Падеж 2 дни СЛЕД реалното „днес" — вътре в 3-дневния прозорец „наближаващи".
  // Датата се смята динамично: първата версия на теста я беше записала твърдо
  // ('2026-08-04', с коментар „днес е 2026-08-02") и тестът тихо ИЗТЕЧЕ — от
  // 2026-08-05 нататък се проваляше вечно, без какъвто и да е дефект в кода.
  // Твърди дати в тестове са допустими само когато и „сега" е твърдо зададено.
  const dueSoon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-07-20', dueSoon);

  const result = await ipcMain.invoke('dashboard:full');
  assert.equal(result.ok, true);
  assert.equal(result.data.fundCount, 1);
  assert.equal(result.data.fundValue, 10);
  assert.equal(result.data.upcoming.length, 1);
  assert.equal(result.data.upcoming[0].inv_number, 1);
  assert.equal(result.data.inventoryTarget, Math.ceil(1 * 10 / 100)); // pctRequired(1) = 10%
  assert.equal(result.data.today.isTodayOpen, true);
});

test('dashboard:full computes anonCandidates only when anonymize_years is set', async () => {
  const { db, ipcMain } = setup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (2, 'Б')").run().lastInsertRowid;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Стар читател')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, readerId, '2020-01-01', '2020-01-15', '2020-01-20');

  const withoutSetting = await ipcMain.invoke('dashboard:full');
  assert.equal(withoutSetting.data.today.anonCandidates, 0);

  db.prepare('UPDATE settings SET anonymize_years = 1 WHERE id = 1').run();
  const withSetting = await ipcMain.invoke('dashboard:full');
  assert.equal(withSetting.data.today.anonCandidates, 1);
});

test('dashboard:full counts currently suspended readers', async () => {
  const { db, ipcMain } = setup();
  // Заявката сравнява с реалния часовник (suspended_until > date('now')) — твърда
  // бъдеща дата тук тихо изтича (тестът щеше да се счупи на 01.01.2030 г.).
  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO readers (name, suspended_until) VALUES ('Наказан', ?)").run(future);
  db.prepare("INSERT INTO readers (name, suspended_until) VALUES ('Изтекъл', '2020-01-01')").run();

  const result = await ipcMain.invoke('dashboard:full');
  assert.equal(result.data.today.suspendedNow, 1);
});

/* today.dueReminders — читатели, дължащи напомняне, за които няма логнато
   напомняне (notice_log) от началото на ТЕКУЩОТО им просрочие. Заявката
   сравнява с реалния часовник (date_due < date('now')), затова датите тук са
   изчислени динамично спрямо Date.now(), не твърдо зададени — виж коментара
   в „dashboard:full aggregates..." по-горе за защо това е задължително. */
test('dashboard:full counts a reader as needing a reminder when no notice has been logged for the current overdue period', async () => {
  const { db, ipcMain } = setup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'А')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const overdueDue = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookId, readerId, '2026-01-01', overdueDue);

  const result = await ipcMain.invoke('dashboard:full');
  assert.equal(result.data.today.dueReminders, 1);
});

test('dashboard:full excludes a reader whose already-logged notice covers the current overdue period', async () => {
  const { db, ipcMain } = setup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'А')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const overdueDue = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookId, readerId, '2026-01-01', overdueDue);
  // Напомняне, логнато СЛЕД падежа (покрива текущото просрочие) — не е нужно ново.
  db.prepare("INSERT INTO notice_log (reader_id, level, ts) VALUES (?, 1, datetime('now'))").run(readerId);

  const result = await ipcMain.invoke('dashboard:full');
  assert.equal(result.data.today.dueReminders, 0);
});

test('dashboard:full still counts a reader whose logged notice predates their current overdue period', async () => {
  const { db, ipcMain } = setup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'А')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const overdueDue = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookId, readerId, '2026-01-01', overdueDue);
  // Старо напомняне, логнато ПРЕДИ падежа на ТЕКУЩОТО просрочие — за старо, вече
  // приключило просрочие. Не бива да "покрива" новото — читателят пак дължи напомняне.
  db.prepare("INSERT INTO notice_log (reader_id, level, ts) VALUES (?, 1, '2020-01-01 00:00:00')").run(readerId);

  const result = await ipcMain.invoke('dashboard:full');
  assert.equal(result.data.today.dueReminders, 1);
});

/* today.overduePeriodicals — виж setupWithPeriodicals() по-горе. today() тук е
   ФИКСИРАНО ('2026-08-02'), а изчислението е изцяло спрямо тази стойност и
   вписаните дати — не пипа date('now'), затова е безопасно с твърда дата. */
test('dashboard:full surfaces overduePeriodicals via the real countOverduePeriodicals from handlers/periodicals.js', async () => {
  const { ipcMain } = setupWithPeriodicals();
  await ipcMain.invoke('periodicals:create', { title: 'Месечно списание', freq: 'месечно' });
  const list = await ipcMain.invoke('periodicals:list');
  const id = list.data[0].id;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '6', date: '2026-06-01' }); // очаква се 07-01 → закъсняло спрямо 08-02

  const result = await ipcMain.invoke('dashboard:full');
  assert.equal(result.data.today.overduePeriodicals, 1);
});

test('dashboard:full reports overduePeriodicals = 0 when countOverduePeriodicals dep is absent (back-compat)', async () => {
  const { ipcMain } = setup(); // setup() без countOverduePeriodicals в deps
  const result = await ipcMain.invoke('dashboard:full');
  assert.equal(result.data.today.overduePeriodicals, 0);
});
