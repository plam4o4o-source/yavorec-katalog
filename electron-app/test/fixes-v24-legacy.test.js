// Тест на поправките от bug-audit-v2.3.1.md, точки #9, #10, #15 (бонус), #20,
// #21, #24 — всичките в handlers/books.js, handlers/deaccession-acts.js и
// handlers/inventory-sessions.js. Отделен файл (не се добавя към
// handlers-books/handlers-deaccession-acts/handlers-inventory-sessions
// test.js), за да остане координацията с паралелна работа по същите
// production файлове чиста — само нови тестове, никакви промени в
// съществуващи test/*.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerBooksHandlers = require('../handlers/books');
const registerDeaccessionActsHandlers = require('../handlers/deaccession-acts');
const registerInventorySessionsHandlers = require('../handlers/inventory-sessions');
const { BOOKS_FTS_SETUP_SQL, ftsQuery } = require('../search-fts');
/* BOOK_SELECT/normalizeScanCode/pctRequired/naturalLoss — от продукцията, по
   образец на останалите handlers-*.test.js (виж test/helpers/prod-values.js). */
const { BOOK_SELECT, normalizeScanCode, pctRequired, naturalLoss } = require('./helpers/prod-values.js');

/* Хигиена на временните папки — виж същия коментар в другите test/*.js. */
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

function newDb(dirPrefix) {
  const dir = mkTmpDir(path.join(os.tmpdir(), dirPrefix));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}

// ---------------- books.js ----------------
function booksSetup() {
  const db = newDb('inv-fixes-v24-books-');
  db.exec(BOOKS_FTS_SETUP_SQL);
  const auditLog = [];
  const catalogWrites = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail, diff) => auditLog.push({ action, detail, diff }),
    today: () => '2026-08-21',
    ftsQuery,
    cnSortKey: (s) => String(s || '').toUpperCase().trim().replace(/\d+/g, m => m.padStart(6, '0')),
    diffFields: () => [],
    scheduleCatalogWrite: () => catalogWrites.push(1),
    normalizeScanCode
  };
  registerBooksHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, catalogWrites };
}

test('books:update — стар ред с непозната стойност за status (легаси база) отказва запис с ясно указание на български, не с гола SQL грешка (одит #9а)', async () => {
  const { ipcMain } = booksSetup();
  const id = (await ipcMain.invoke('books:create', { title: 'Стара книга', status: 'наличен' })).data;

  const res = await ipcMain.invoke('books:update', { id, title: 'Стара книга (редакция)', status: 'изгубена', quantity: 1 });

  assert.equal(res.ok, false, 'запис с непозната стойност за status трябва да се откаже');
  assert.match(res.error, /изгубена/, 'съобщението трябва да назове подадената непозната стойност');
  assert.match(res.error, /падащото меню/, 'съобщението трябва да упъти библиотекаря към падащото меню „Състояние“');
  assert.match(res.error, /наличен.*липсващ.*за реставрация.*отчислен/,
    'съобщението трябва да изброи валидните стойности, за да няма нужда да ги търси другаде');
});

test('books:create също отказва непозната стойност за status, със същото ясно съобщение (одит #9а)', async () => {
  const { ipcMain } = booksSetup();
  const res = await ipcMain.invoke('books:create', { title: 'Нова книга', status: 'бу-га-га' });
  assert.equal(res.ok, false);
  assert.match(res.error, /падащото меню/);
});

test('books:update пази NULL статус на съществуващ ред (стари данни, за преглед), не го превръща мълчаливо в „наличен“ (одит #9б)', async () => {
  const { db, ipcMain } = booksSetup();
  // Симулира легаси ред: NULL status, вкаран директно в базата (напр. стар
  // импорт), какъвто books:create никога не произвежда сам.
  const id = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1, 'Легаси книга', NULL)").run().lastInsertRowid;

  // Редакция на СЪВСЕМ друго поле — формата не носи изрична нова стойност за status.
  const res = await ipcMain.invoke('books:update', { id, title: 'Легаси книга (поправен печат)', quantity: 1 });
  assert.equal(res.ok, true, res.error);

  const row = db.prepare('SELECT status, title FROM books WHERE id = ?').get(id);
  assert.equal(row.title, 'Легаси книга (поправен печат)');
  assert.equal(row.status, null, 'NULL статус не бива да се превръща мълчаливо в „наличен“ при несвързана редакция');
});

test('books:create по подразбиране запазва status „наличен“ за НОВ документ (без регресия от поправката на #9б)', async () => {
  const { db, ipcMain } = booksSetup();
  const id = (await ipcMain.invoke('books:create', { title: 'Съвсем нова книга' })).data;
  const row = db.prepare('SELECT status FROM books WHERE id = ?').get(id);
  assert.equal(row.status, 'наличен');
});

test('books:list връща документите подредени по заглавие (ORDER BY b.title, подразбиращата се подредба) — покрива празнината от мутационния одит (одит #15, бонус тест)', async () => {
  const { ipcMain } = booksSetup();
  // Вмъкнати НАРОЧНО в разбъркан ред спрямо азбучната подредба.
  await ipcMain.invoke('books:create', { title: 'Вечери в Антимовския хан', inv_number: 3 });
  await ipcMain.invoke('books:create', { title: 'Автобиография', inv_number: 1 });
  await ipcMain.invoke('books:create', { title: 'Бай Ганьо', inv_number: 2 });

  const res = await ipcMain.invoke('books:list');
  assert.equal(res.ok, true, res.error);
  const titles = res.data.map(b => b.title);
  assert.deepEqual(titles, ['Автобиография', 'Бай Ганьо', 'Вечери в Антимовския хан'],
    'books:list трябва да връща документите по азбучен ред на заглавието — обърнат ORDER BY е точно регресията, която мутационният одит не хвана');
});

test('books:findDuplicateBarcodes открива групи документи със същия ненулев баркод, без да пипа реда сам (одит #21)', async () => {
  const { ipcMain } = booksSetup();
  assert.ok(ipcMain.has('books:findDuplicateBarcodes'), 'каналът трябва да е регистриран');

  const dupA1 = (await ipcMain.invoke('books:create', { title: 'Копие А', barcode: 'BC-1', inv_number: 10 })).data;
  const dupA2 = (await ipcMain.invoke('books:create', { title: 'Копие Б', barcode: 'BC-1', inv_number: 20 })).data;
  await ipcMain.invoke('books:create', { title: 'Уникален баркод', barcode: 'BC-2', inv_number: 30 });
  await ipcMain.invoke('books:create', { title: 'Без баркод', inv_number: 40 }); // barcode остава NULL

  const res = await ipcMain.invoke('books:findDuplicateBarcodes');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.length, 1, 'само BC-1 е дублиран');
  assert.equal(res.data[0].barcode, 'BC-1');
  const ids = res.data[0].books.map(b => b.id);
  assert.deepEqual(ids.sort(), [dupA1, dupA2].sort());
});

// ---------------- deaccession-acts.js ----------------
function deaccSetup(overrides = {}) {
  const db = newDb('inv-fixes-v24-deacc-');
  const auditLog = [];
  const scheduleCalls = [];
  const ipcMain = fakeIpcMain();
  const deps = Object.assign({
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    BOOK_SELECT,
    yearOf: (d) => (d || '2026-08-21').slice(0, 4),
    scheduleCatalogWrite: () => scheduleCalls.push(true),
    normalizeScanCode
  }, overrides);
  registerDeaccessionActsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, scheduleCalls };
}
function insertBook(db, overrides = {}) {
  const b = Object.assign({ inv_number: Math.floor(Math.random() * 1e6), title: 'Книга', status: 'наличен', price: 5 }, overrides);
  return db.prepare('INSERT INTO books (inv_number, title, status, price) VALUES (?, ?, ?, ?)')
    .run(b.inv_number, b.title, b.status, b.price).lastInsertRowid;
}
function actPayload(overrides = {}) {
  return Object.assign({
    no: 1, date: '2026-08-21', order_no: null, reason_code: 1, reason_text: 'амортизация',
    disposal: null, attach: null, committee1: null, committee2: null, committee3: null
  }, overrides);
}

test('отчисляването отказва/анулира активна резервация ("чака") на отчисления документ и го отбелязва в одитната следа (одит #10)', async () => {
  const { db, ipcMain, auditLog } = deaccSetup();
  const bookId = insertBook(db, { inv_number: 501, title: 'Резервирана и после отчислена' });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const holdId = db.prepare("INSERT INTO holds (book_id, reader_id, status) VALUES (?, ?, 'чака')").run(bookId, readerId).lastInsertRowid;

  const res = await ipcMain.invoke('deaccessionActs:create', { act: actPayload(), bookIds: [bookId] });
  assert.equal(res.ok, true, res.error);

  const hold = db.prepare('SELECT status, resolved_at FROM holds WHERE id = ?').get(holdId);
  assert.equal(hold.status, 'отказана', 'резервацията на отчисления документ трябва да е отказана, не да остане "чака" завинаги');
  assert.ok(hold.resolved_at, 'отказаната резервация трябва да носи дата на разрешаване');

  const entry = auditLog.find(a => a.action === 'Отчисляване');
  assert.ok(entry, 'трябва да има запис в одитната следа за отчисляването');
  assert.match(entry.detail, /отказани\s+1\s+резерваци/, 'одитната следа трябва да спомене отказаните резервации');
});

test('отчисляването на документ БЕЗ резервации не пипа чужди активни резервации на друг документ (одит #10, без странични ефекти)', async () => {
  const { db, ipcMain } = deaccSetup();
  const targetId = insertBook(db, { inv_number: 601, title: 'За отчисляване' });
  const otherId = insertBook(db, { inv_number: 602, title: 'Друга книга' });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const otherHoldId = db.prepare("INSERT INTO holds (book_id, reader_id, status) VALUES (?, ?, 'чака')").run(otherId, readerId).lastInsertRowid;

  const res = await ipcMain.invoke('deaccessionActs:create', { act: actPayload({ no: 2 }), bookIds: [targetId] });
  assert.equal(res.ok, true, res.error);

  const otherHold = db.prepare('SELECT status FROM holds WHERE id = ?').get(otherHoldId);
  assert.equal(otherHold.status, 'чака', 'резервация на НЕотчислен документ не бива да се пипа');
});

/* Одит v2.3.1 №26: библиотека с точно 1 книга — отчисляването ѝ прави фонда
   празен; предпазната мярка "не презаписвай непразен каталог с празен" (в
   main.js, тук симулирана през flushCatalogWrite mock) отказва записа, а
   библиотекарят трябва да го ВИДИ (одитна следа), не само в конзолата. */
test('deaccessionActs:create записва предупреждение в одитната следа, когато записът на каталога е спрян (одит #26)', async () => {
  const { db, ipcMain, auditLog } = deaccSetup({
    flushCatalogWrite: () => ({ written: false, blocked: true })
  });
  const bookId = insertBook(db, { inv_number: 701, title: 'Последната книга във фонда' });

  const res = await ipcMain.invoke('deaccessionActs:create', { act: actPayload({ no: 3 }), bookIds: [bookId] });
  assert.equal(res.ok, true, res.error);

  const warn = auditLog.find(a => a.action === 'Онлайн каталог' && /акт № 3/.test(a.detail) && /спрян/.test(a.detail));
  assert.ok(warn, 'трябва да има видимо за библиотекаря предупреждение в одитната следа, не само console.error');
});

test('deaccessionActs:create записва предупреждение в одитната следа, когато записът на каталога реално се провали (одит #26)', async () => {
  const { db, ipcMain, auditLog } = deaccSetup({
    flushCatalogWrite: () => ({ written: false, error: 'ENOENT: изключен мрежов диск' })
  });
  const bookId = insertBook(db, { inv_number: 702 });

  const res = await ipcMain.invoke('deaccessionActs:create', { act: actPayload({ no: 4 }), bookIds: [bookId] });
  assert.equal(res.ok, true, res.error);

  const warn = auditLog.find(a => a.action === 'Онлайн каталог' && /не успя/.test(a.detail) && /ENOENT/.test(a.detail));
  assert.ok(warn, 'причината за провала трябва да стигне до одитната следа');
});

test('deaccessionActs:create НЕ записва предупреждение, когато каталогът е записан успешно (одит #26, без фалшиви аларми)', async () => {
  const { db, ipcMain, auditLog } = deaccSetup({
    flushCatalogWrite: () => ({ written: true })
  });
  const bookId = insertBook(db, { inv_number: 703 });

  const res = await ipcMain.invoke('deaccessionActs:create', { act: actPayload({ no: 5 }), bookIds: [bookId] });
  assert.equal(res.ok, true, res.error);

  const warn = auditLog.find(a => a.action === 'Онлайн каталог');
  assert.equal(warn, undefined, 'успешен запис не бива да оставя предупреждение');
});

// ---------------- inventory-sessions.js ----------------
function sessSetup() {
  const db = newDb('inv-fixes-v24-sess-');
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    pctRequired,
    naturalLoss,
    normalizeScanCode
  };
  registerInventorySessionsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}
function startSession(ipcMain, overrides = {}) {
  return ipcMain.invoke('inventorySessions:start', Object.assign({
    date: '2026-08-21', scope: 'пълна', department: null,
    committee1: null, committee2: null, committee3: null
  }, overrides));
}

test('inventorySessions:requirement брои и книги с NULL status в активния фонд, не само изрично различните от "отчислен" (одит #20)', async () => {
  const { db, ipcMain } = sessSetup();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1, 'А', 'наличен')").run();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (2, 'Б', NULL)").run(); // легаси, никога прегледана
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (3, 'В', 'отчислен')").run();

  const res = await ipcMain.invoke('inventorySessions:requirement');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.active, 2, 'NULL-status книгата трябва да се брои в активния фонд заедно с "наличен", не да пропада');
});

test('inventorySessions:start брои NULL-status книга в pool_size, а inventorySessions:close я включва в непроверените (одит #20)', async () => {
  const { db, ipcMain } = sessSetup();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1, 'Сканирана', 'наличен')").run();
  const nullId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (2, 'Легаси NULL', NULL)").run().lastInsertRowid;

  const sessionId = (await startSession(ipcMain)).data;
  const row = db.prepare('SELECT pool_size FROM inventory_sessions WHERE id = ?').get(sessionId);
  assert.equal(row.pool_size, 2, 'pool_size трябва да включва и NULL-status книгата');

  const closeRes = await ipcMain.invoke('inventorySessions:close', { sessionId, mode: 'full' });
  assert.equal(closeRes.ok, true, closeRes.error);
  assert.equal(closeRes.data.pool, 2);

  const missingRow = db.prepare('SELECT book_id FROM inventory_session_missing WHERE session_id = ? AND book_id = ?').get(sessionId, nullId);
  assert.ok(missingRow, 'NULL-status книгата, несканирана при пълна проверка, трябва да попадне в протокола за липсващи');
});

test('inventorySessions:scan отказва сканиране на книга от ДРУГ отдел, когато сесията е ограничена до конкретен отдел (одит #24)', async () => {
  const { db, ipcMain } = sessSetup();
  db.prepare("INSERT INTO books (inv_number, title, barcode, status, department) VALUES (1, 'В отдела', 'BC1', 'наличен', 'заемна')").run();
  db.prepare("INSERT INTO books (inv_number, title, barcode, status, department) VALUES (2, 'Друг отдел', 'BC2', 'наличен', 'детски')").run();

  const sessionId = (await startSession(ipcMain, { department: 'заемна' })).data;

  const inScope = await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC1' });
  assert.equal(inScope.ok, true, inScope.error);

  const outOfScope = await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC2' });
  assert.equal(outOfScope.ok, false, 'сканиране на книга от друг отдел трябва да се откаже, не тихо да се приеме');
  assert.match(outOfScope.error, /отдел/);

  const scanned = db.prepare('SELECT COUNT(*) AS n FROM inventory_session_scans WHERE session_id = ?').get(sessionId).n;
  assert.equal(scanned, 1, 'само книгата от правилния отдел трябва да е записана като сканирана');
});

test('inventorySessions:scan НЕ ограничава по отдел, когато сесията не е ограничена (department = null)', async () => {
  const { db, ipcMain } = sessSetup();
  db.prepare("INSERT INTO books (inv_number, title, barcode, status, department) VALUES (1, 'Кой да е отдел', 'BC1', 'наличен', 'детски')").run();
  const sessionId = (await startSession(ipcMain)).data; // department: null
  const res = await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC1' });
  assert.equal(res.ok, true, res.error);
});
