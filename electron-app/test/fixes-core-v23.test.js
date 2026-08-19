/* Тестове v2.3.0 за ядрото — поправките от втория одит, включително три от
   собствените ми регресии, въведени с бързите поправки на v2.2.0:

   • екранът „Просрочени" смяташе сумата сам, по сурови календарни дни, докато
     handler-ите ползваха effectiveDaysLate → две различни суми за едно просрочие,
     макар v2.2.0 да обяви точно това за уеднаквено;
   • suspend_max = 0 смени значението си от „таван 90 дни" на „без таван" →
     наказания от над две години в база с вписана нула;
   • клампването на тавана можеше да СКЪСИ вече наложено наказание.

   Плюс: старт при повредена база, „събрани обезщетения" и записаният вид на
   инвентаризацията. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerLoansHandlers = require('../handlers/loans');
const registerStatsHandlers = require('../handlers/stats');
const registerInventoryHandlers = require('../handlers/inventory-sessions');
/* BOOK_SELECT и нормативните pctRequired/naturalLoss се ВЗИМАТ от продукцията
   (handlers/books.js и main.js), а не се преписват — вж. test/helpers/prod-values.js. */
const { BOOK_SELECT, pctRequired, naturalLoss, normalizeScanCode } = require('./helpers/prod-values.js');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-core-v23-'));
  tmpDirs.push(dir);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}
// Временните папки се чистят — иначе всяко пускане на пакета оставя десетки
// каталога в /tmp (одитът завари 80 431 броя / 23 GB, а при пълен диск пакетът
// започва да пада на съвсем несвързани места).
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* няма значение */ } } });

function setupLoans(overrides = {}) {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerLoansHandlers(ipcMain, Object.assign({
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02', logEvent: () => {},
    BOOK_SELECT, scheduleCatalogWrite: () => {},
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 1, suspend_max: 90 }),
    readerCategory: () => 'възрастен',
    nextWorkDay: (d) => d,
    closedDaysBetween: () => 0,
    firstActiveHold: () => null, consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null,
    normalizeScanCode
  }, overrides));
  return { db, ipcMain };
}
function addBook(db, { inv_number = 1, quantity = 1 } = {}) {
  const id = db.prepare('INSERT INTO books (inv_number, title, status) VALUES (?, ?, ?)')
    .run(inv_number, 'Книга ' + inv_number, 'наличен').lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, quantity);
  return id;
}
const addReader = (db, name = 'Читател') =>
  db.prepare('INSERT INTO readers (name, category) VALUES (?, ?)').run(name, 'възрастен').lastInsertRowid;

/* --- Просрочени: една и съща сума навсякъде --- */

test('loans:overdue връща готови дни забава и обезщетение, смятани като на гишето', async () => {
  // Затворени дни: 3 от периода. Касата ги вади; старият екран — не.
  const { db, ipcMain } = setupLoans({ closedDaysBetween: () => 3 });
  db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const bookId = addBook(db, { inv_number: 1 });
  const readerId = addReader(db, 'Просрочил');
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2026-07-01', '2026-07-23'); // 10 календарни дни забава

  const res = await ipcMain.invoke('loans:overdue');
  assert.equal(res.ok, true);
  const row = res.data[0];
  assert.equal(row.daysLate, 7, '10 календарни минус 3 затворени = 7 ефективни дни');
  assert.ok(Math.abs(row.fine - 0.70) < 1e-9, 'очаквано 0.70 лв., получено ' + row.fine);
});

test('книга с падеж ДНЕС не е просрочена', async () => {
  const { db, ipcMain } = setupLoans();
  const bookId = addBook(db, { inv_number: 1 });
  const readerId = addReader(db);
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,date('now'))")
    .run(readerId, bookId, '2026-07-01');
  const res = await ipcMain.invoke('loans:overdue');
  assert.equal(res.data.length, 0, 'читателят още има цял ден да я върне — не бива да влиза в напомнянията');
});

test('екранът „Просрочени" ползва сумата от backend-а, а не смята своя', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'overdue.js'), 'utf8');
  assert.doesNotMatch(src, /new Date\(today\(\)\)\s*-\s*new Date\(l\.date_due\)/,
    'екранът не бива да смята дните сам — така се появиха двете различни суми');
  assert.match(src, /l\.fine/, 'сумата идва от loans:overdue');
});

/* --- Таван на наказанието --- */

test('suspend_max = 0 се третира като тавана по подразбиране, не като „без таван"', async () => {
  const { db, ipcMain } = setupLoans({
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 1, suspend_max: 0 })
  });
  const readerId = addReader(db);
  const bookId = addBook(db, { inv_number: 1 });
  const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2024-01-01', '2024-06-14').lastInsertRowid; // ~779 дни забава
  await ipcMain.invoke('loans:return', { id: loanId });
  const until = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId).suspended_until;
  assert.equal(until, '2026-10-31', 'today (02.08.2026) + 90 дни; преди поправката излизаше 2028 г.');
});

test('таванът важи за общото натрупано наказание при връщане накуп', async () => {
  const { db, ipcMain } = setupLoans({
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 1, suspend_max: 30 })
  });
  const readerId = addReader(db);
  for (let i = 1; i <= 3; i++) {
    const bookId = addBook(db, { inv_number: i });
    const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
      .run(readerId, bookId, '2026-01-01', '2026-05-01').lastInsertRowid;
    await ipcMain.invoke('loans:return', { id: loanId });
  }
  assert.equal(db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId).suspended_until,
    '2026-09-01', 'три връщания при таван 30 дни не бива да дават 90');
});

test('връщане не СКЪСЯВА наказание, наследено отвъд тавана от по-стара версия', async () => {
  const { db, ipcMain } = setupLoans({
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 1, suspend_max: 90 })
  });
  const readerId = addReader(db);
  // Стойност, натрупана от v2.1.0 (3 × 90 дни) — далеч отвъд тавана.
  db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run('2027-04-30', readerId);
  const bookId = addBook(db, { inv_number: 1 });
  const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2026-07-01', '2026-08-01').lastInsertRowid; // 1 ден забава
  await ipcMain.invoke('loans:return', { id: loanId });
  const until = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId).suspended_until;
  assert.ok(until >= '2027-04-30',
    'наказанието не бива да пада от 2027-04-30 на ~90 дни — читателят би спечелил от това, че е закъснял пак; получено ' + until);
});

/* --- „Събрани обезщетения" --- */

function setupStats() {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerStatsHandlers(ipcMain, {
    getDb: () => db, run, yearOf: () => '2026',
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: (rows) => ({ hours: rows.reduce((s, r) => s + (r.a_hours || 0), 0) })
  });
  const line = (rid, date, kind, type, amount) =>
    db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?,?,?,?,?)')
      .run(rid, date, kind, type, amount);
  return { db, ipcMain, line };
}

test('плащане на годишна такса НЕ се приписва на обезщетение', async () => {
  const { db, ipcMain, line } = setupStats();
  const r = addReader(db, 'Ч1');
  line(r, '2026-02-01', 'начисление', 'годишна такса', 12);
  line(r, '2026-02-05', 'начисление', 'обезщетение', 2);
  line(r, '2026-02-10', 'плащане', 'плащане', -12); // плаща само таксата
  const rep = (await ipcMain.invoke('stats:report', '2026')).data;
  assert.equal(rep.finesCollected, 0,
    'обезщетението не е платено; преди поправката отчетът показваше 2,00 лв. „събрани"');
});

test('обезщетение от декември, платено през януари, влиза в годината на ПЛАЩАНЕТО', async () => {
  const { db, ipcMain, line } = setupStats();
  const r = addReader(db, 'Ч2');
  line(r, '2025-12-20', 'начисление', 'обезщетение', 7);
  line(r, '2026-01-15', 'плащане', 'плащане', -7);
  assert.equal((await ipcMain.invoke('stats:report', '2026')).data.finesCollected, 7);
  assert.equal((await ipcMain.invoke('stats:report', '2025')).data.finesCollected, 0,
    'преди поправката сумата изчезваше и от двете години');
});

test('плащанията покриват най-старото задължение първо', async () => {
  const { db, ipcMain, line } = setupStats();
  const r = addReader(db, 'Ч3');
  line(r, '2026-01-10', 'начисление', 'обезщетение', 5);
  line(r, '2026-02-01', 'начисление', 'годишна такса', 12);
  line(r, '2026-03-01', 'плащане', 'плащане', -5); // покрива обезщетението
  assert.equal((await ipcMain.invoke('stats:report', '2026')).data.finesCollected, 5);
});

/* --- Вид на инвентаризацията в базата --- */

test('видът на инвентаризацията се записва в базата, не само в отговора', async () => {
  const db = freshDb();
  const ipcMain = fakeIpcMain();
  registerInventoryHandlers(ipcMain, {
    getDb: () => db, run, logAudit: () => {}, pctRequired,
    naturalLoss, normalizeScanCode
  });
  for (let i = 1; i <= 10; i++) addBook(db, { inv_number: i });
  const open = await ipcMain.invoke('inventorySessions:start',
    { date: '2026-08-02', scope: '', department: null, committee1: null, committee2: null, committee3: null });
  const sid = open.data;
  await ipcMain.invoke('inventorySessions:scan', { sessionId: sid, code: '1' });
  await ipcMain.invoke('inventorySessions:close', { sessionId: sid, mode: 'representative' });
  assert.equal(db.prepare('SELECT mode FROM inventory_sessions WHERE id = ?').get(sid).mode, 'representative',
    'иначе приключена представителна проверка с 0 липсващи не се различава от пълна с 0 липсващи');
});

/* --- Старт на програмата --- */

test('стартът се пази от .catch и от втори едновременен процес', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  /* Без .catch всяка грешка при старта (повредена база, изключен мрежов диск) се
     превръщаше в необработено отхвърляне: нито прозорец, нито съобщение, а процесът
     остава жив завинаги — за библиотекаря „щраквам иконата и не става нищо".
     Проверено при одита с реално повредена база: 0 прозореца, 0 диалога, висящ процес. */
  assert.match(src, /app\.whenReady\(\)[\s\S]*?\}\)\.catch\(/,
    'app.whenReady() трябва да има .catch()');
  assert.match(src, /showErrorBox/, 'при провал библиотекарят трябва да види съобщение, не мълчание');
  assert.match(src, /requestSingleInstanceLock/,
    'иначе всяко следващо щракване вдига нов невидим процес срещу същата база');
});

/* --- Миграцията --- */

test('нова база има индекса и колоната mode още от схемата', () => {
  const db = freshDb();
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_books_acquisition'").get(),
    'без този индекс „Постъпления" се бави 1,3 s при 15 000 книги');
  assert.ok(db.prepare('PRAGMA table_info(inventory_sessions)').all().some(c => c.name === 'mode'));
});

test('миграция v7 добавя същото към вече съществуваща база', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /version:\s*7/, 'старите бази получават индекса и колоната през миграция');
  assert.match(src, /idx_books_acquisition/);
});
