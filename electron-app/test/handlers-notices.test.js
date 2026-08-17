// Тест на handlers/notices.js — двайсет и четвърти домейн, извадено от
// main.js (Фаза 4, стъпка 25). Проверява сглобяването на напомняния (степен,
// плейсхолдъри, обезщетение), логването и валидацията на имейла за mailto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerNoticesHandlers = require('../handlers/notices');

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

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-notices-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const shellCalls = [];
  const ipcMain = fakeIpcMain();
  const deps = Object.assign({
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    today: () => '2026-08-02',
    LOAN_SELECT,
    EUR_RATE: 1.95583,
    isValidEmail: (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e),
    shell: { openExternal: (url) => shellCalls.push(url) },
    /* v2.2.0: напомнянията вече смятат обезщетението със същата функция, с която то
       реално се начислява при връщане (effectiveDaysLate, върната от handlers/loans.js),
       вместо със собствен SQL израз с ДРОБНИ дни от julianday('now'). Тук се подава
       същата логика при closedDaysBetween = 0, както в тестовете на заеманията. */
    effectiveDaysLate: (dueDate, inDate) => {
      if (!dueDate || !inDate || inDate <= dueDate) return 0;
      return Math.max(0, Math.round((new Date(inDate) - new Date(dueDate)) / 864e5));
    }
  }, overrides);
  const returned = registerNoticesHandlers(ipcMain, deps);
  return { db, ipcMain, shellCalls, returned };
}

test('registerNoticesHandlers registers loans:reminders/mailto and notices:log, and returns notice defaults', () => {
  const { ipcMain, returned } = setup();
  for (const ch of ['loans:reminders', 'notices:log', 'loans:mailto']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
  assert.match(returned.DEFAULT_NOTICE_SUBJECT, /\{library\}/);
  assert.match(returned.DEFAULT_NOTICE_BODY, /\{reader\}/);
  assert.match(returned.DEFAULT_NOTICE_SMS, /\{count_phrase\}/);
  assert.ok(Array.isArray(returned.NOTICE_PLACEHOLDERS));
});

test('loans:reminders groups overdue loans by reader and fills the default templates', async () => {
  const { db, ipcMain } = setup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title, author) VALUES (5, 'Книга', 'Автор')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Иван Иванов')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-01-01', '2026-01-15');

  const result = await ipcMain.invoke('loans:reminders');
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 1);
  const r = result.data[0];
  assert.equal(r.n, 1);
  assert.match(r.subject, /Просрочени материали от/);
  assert.match(r.body, /Иван Иванов/);
  assert.ok(r.loans.length === 1 && r.loans[0].inv_number === 5);
});

test('loans:reminders escalates the level based on remind2_days/remind3_days thresholds', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET remind2_days = 10, remind3_days = 20 WHERE id = 1').run();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'А')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Просрочил силно')").run().lastInsertRowid;
  // due 2026-07-01, today() = 2026-08-02 → 32 days overdue → level 3
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-06-01', '2026-07-01');

  const result = await ipcMain.invoke('loans:reminders');
  assert.equal(result.data[0].level, 3);
  assert.match(result.data[0].body, /ТРЕТО напомняне/);
});

test('loans:reminders computes fine in leva and euro and includes it in the body/sms when positive', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET fine_per_day = 0.50 WHERE id = 1').run();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (2, 'Б')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Дължащ')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-07-01', '2026-07-15');

  const result = await ipcMain.invoke('loans:reminders');
  assert.ok(result.data[0].fine > 0);
  assert.match(result.data[0].body, /Начислено обезщетение/);
  assert.match(result.data[0].sms, /обезщетение/);
});

test('loans:reminders reflects custom templates from settings, and lastNotice reflects only notices sent after oldest_due', async () => {
  const { db, ipcMain } = setup();
  db.prepare("UPDATE settings SET notice_subject = 'Персонализиран: {reader}' WHERE id = 1").run();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (3, 'В')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Персонален')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(bookId, readerId, '2026-07-01', '2026-07-15');
  // Стар notice_log запис, ОТПРЕДИ падежа — не бива да брои като "изпратено за текущото просрочие".
  db.prepare("INSERT INTO notice_log (reader_id, level, ts) VALUES (?, 1, '2026-06-01')").run(readerId);

  const result = await ipcMain.invoke('loans:reminders');
  assert.match(result.data[0].subject, /Персонализиран: Персонален/);
  assert.equal(result.data[0].lastNotice, null, 'a notice logged before the current overdue period should not count');
});

test('notices:log records a notice_log row', async () => {
  const { db, ipcMain } = setup();
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Логнат')").run().lastInsertRowid;
  const result = await ipcMain.invoke('notices:log', { reader_id: readerId, level: 2, channel: 'имейл', loans_count: 3 });
  assert.equal(result.ok, true);
  const row = db.prepare('SELECT * FROM notice_log WHERE reader_id = ?').get(readerId);
  assert.equal(row.level, 2);
  assert.equal(row.channel, 'имейл');
  assert.equal(row.loans_count, 3);
});

test('loans:mailto refuses a missing or invalid email, and opens mailto: via shell for a valid one', async () => {
  const { ipcMain, shellCalls } = setup();
  const noEmail = await ipcMain.invoke('loans:mailto', { email: '', subject: 'X', body: 'Y' });
  assert.equal(noEmail.ok, false);
  assert.match(noEmail.error, /няма записан имейл/);

  const bad = await ipcMain.invoke('loans:mailto', { email: 'not-an-email', subject: 'X', body: 'Y' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /не изглежда валиден/);

  const good = await ipcMain.invoke('loans:mailto', { email: 'reader@example.com', subject: 'Тема', body: 'Текст' });
  assert.equal(good.ok, true);
  assert.equal(shellCalls.length, 1);
  assert.match(shellCalls[0], /^mailto:reader%40example\.com/);
});
