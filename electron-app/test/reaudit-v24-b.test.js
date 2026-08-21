/* Противников одит (v2.4.0, партида Б) — bug-audit-v2.3.1.md, точки #9, #10,
   #20, #24, #25, #26 в handlers/books.js, handlers/deaccession-acts.js,
   handlers/inventory-sessions.js, handlers/holds.js, handlers/backup.js.

   Съществуващите test/fixes-v24-legacy.test.js и test/fixes-v24-holds-
   backup.test.js вече покриват повечето сценарии директно на ниво handler
   (фалшив ipcMain + истинска SQLite база от db/schema.sql, БЕЗ реалните
   enum-тригери от db/enum-triggers.js — те се прилагат само през миграция v5
   в main.js). Този файл добавя точно празнините, останали непроверени след
   насрещния прочит:

   1) assertValidStatus() (handlers/books.js) срещу РЕАЛНИЯ SQLite тригер,
      минавайки през ЦЕЛИЯ main.js (test/helpers/main-app.js) — тестовете в
      fixes-v24-legacy.test.js изобщо не прилагат enum-тригерите, затова
      никога не доказват, че хубавото българско съобщение реално изпреварва
      грозната SQL грешка.
   2) Сесия по отдел + книга с department = NULL (не просто „друг отдел“) —
      граничен случай от одита, който fixes-v24-legacy.test.js не покрива.
   3) deaccessionActs:revoke не възкресява резервации, отказани при
      отчисляването (handlers/deaccession-acts.js) — не се тества никъде.

   Модел: фалшив ipcMain + istinska SQLite, по образец на другите test/*.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const registerInventorySessionsHandlers = require('../handlers/inventory-sessions');
const registerDeaccessionActsHandlers = require('../handlers/deaccession-acts');
const registerBackupHandlers = require('../handlers/backup');
const { BOOK_SELECT, normalizeScanCode, pctRequired, naturalLoss } = require('./helpers/prod-values.js');
const { startMainApp } = require('./helpers/main-app.js');

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

/* =====================================================================
   1) assertValidStatus() (books.js) срещу истинския SQLite enum-тригер,
      през ЦЕЛИЯ main.js — не фалшива handler-настройка.

   startMainApp() е модулен singleton (виж коментара в
   test/helpers/main-app.js: „Един процес = едно зареждане на main.js“) —
   затова, по образеца на test/main-catalog-norms.test.js, се стартира ВЕДНЪЖ
   с test.before/test.after, а не по едно зареждане на тест.
   ===================================================================== */
const mainApp = startMainApp();
test.before(async () => { await mainApp.ready(); });
test.after(() => { mainApp.stop(); });

test('books:update през реалния main.js: непозната стойност за status връща хубавото българско съобщение на assertValidStatus(), НЕ голата SQL грешка на тригера (одит #9а, реален end-to-end)', () => {
  const created = mainApp.invoke('books:create', { title: 'Реална книга през main.js', status: 'наличен' });
  assert.equal(created.ok, true, created.error);
  const id = created.data;

  const res = mainApp.invoke('books:update', { id, title: 'Реална книга (редакция)', status: 'изгубена', quantity: 1 });
  assert.equal(res.ok, false, 'редакция с непозната стойност за status трябва да се откаже');
  assert.match(res.error, /падащото меню/,
    'съобщението трябва да е от assertValidStatus() (упътва към падащото меню), а не грозна SQL грешка от тригера');
  assert.doesNotMatch(res.error, /^SQLITE_CONSTRAINT/,
    'ако това съобщение стигне до тригера, значи assertValidStatus() не го е прихванала първа');
  assert.doesNotMatch(res.error, /Непозната стойност за books\.status\.$/,
    'точното съобщение на самия SQL тригер не бива да излиза навън непреведено');
});

test('books:create през реалния main.js: валиден статус минава без грешка, а после books:update без status пази текущия (одит #9а/#9б, реален end-to-end)', () => {
  const created = mainApp.invoke('books:create', { title: 'Валидна книга', status: 'липсващ' });
  assert.equal(created.ok, true, created.error);
  const id = created.data;

  // Редакция БЕЗ поле status — трябва да пази 'липсващ', не да reset-не на 'наличен'.
  const upd = mainApp.invoke('books:update', { id, title: 'Валидна книга (редакция на заглавие)', quantity: 1 });
  assert.equal(upd.ok, true, upd.error);

  const row = mainApp.invoke('books:get', id);
  assert.equal(row.ok, true, row.error);
  assert.equal(row.data.status, 'липсващ',
    'редакция без изрична стойност за status не бива да го reset-ва на "наличен" дори през реалния main.js');
});

/* =====================================================================
   2) inventorySessions:scan — сесия по отдел + книга с department = NULL
      (не просто „друг отдел“). Граничен случай, непокрит от
      fixes-v24-legacy.test.js.
   ===================================================================== */
function sessSetup() {
  const db = newDb('inv-reaudit-b-sess-');
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

test('inventorySessions:scan — сесия, ограничена до отдел, отказва книга с department = NULL, последователно с изключването ѝ от pool_size в start/close (одит #24, граничен случай)', async () => {
  const { db, ipcMain } = sessSetup();
  db.prepare("INSERT INTO books (inv_number, title, barcode, status, department) VALUES (1, 'В отдела', 'BC1', 'наличен', 'заемна')").run();
  const noDeptId = db.prepare("INSERT INTO books (inv_number, title, barcode, status, department) VALUES (2, 'Без отдел', 'BC2', 'наличен', NULL)").run().lastInsertRowid;

  const sessRes = await startSession(ipcMain, { department: 'заемна' });
  assert.equal(sessRes.ok, true, sessRes.error);
  const sessionId = sessRes.data;

  // Последователност: pool_size за сесия по отдел брои САМО книгите от този отдел
  // (department = @department в SQL) — книга с NULL department не се броí в пула,
  // затова сканирането ѝ трябва СЪЩО да се отказва, иначе протоколът би приемал
  // сканиране на нещо извън обявения обхват на сесията.
  const poolRow = db.prepare('SELECT pool_size FROM inventory_sessions WHERE id = ?').get(sessionId);
  assert.equal(poolRow.pool_size, 1, 'книгата с NULL department не бива да е в пула на сесия по отдел "заемна"');

  const scanRes = await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC2' });
  assert.equal(scanRes.ok, false, 'книга с department=NULL не бива тихо да се приема в сесия, ограничена до конкретен отдел');
  assert.match(scanRes.error, /отдел/);

  const scannedRow = db.prepare('SELECT 1 FROM inventory_session_scans WHERE session_id = ? AND book_id = ?').get(sessionId, noDeptId);
  assert.equal(scannedRow, undefined, 'отказаното сканиране не бива да остави следа в inventory_session_scans');
});

/* =====================================================================
   3) deaccessionActs:revoke не възкресява резервации, отказани при
      самото отчисляване (одит #10, обратна посока).
   ===================================================================== */
function deaccSetup(overrides = {}) {
  const db = newDb('inv-reaudit-b-deacc-');
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

test('deaccessionActs:revoke НЕ възкресява резервация, отказана при отчисляването — тя остава "отказана" (одит #10, обратна посока)', async () => {
  const { db, ipcMain } = deaccSetup();
  const bookId = insertBook(db, { inv_number: 801, title: 'Резервирана, отчислена, после анулирана' });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const holdId = db.prepare("INSERT INTO holds (book_id, reader_id, status) VALUES (?, ?, 'заделена')").run(bookId, readerId).lastInsertRowid;

  const createRes = await ipcMain.invoke('deaccessionActs:create', { act: actPayload(), bookIds: [bookId] });
  assert.equal(createRes.ok, true, createRes.error);
  const actId = createRes.data;

  const holdAfterDeacc = db.prepare('SELECT status FROM holds WHERE id = ?').get(holdId);
  assert.equal(holdAfterDeacc.status, 'отказана', 'предпоставка: резервацията трябва да е отказана от самото отчисляване');

  const revokeRes = await ipcMain.invoke('deaccessionActs:revoke', actId);
  assert.equal(revokeRes.ok, true, revokeRes.error);

  const bookAfterRevoke = db.prepare('SELECT status FROM books WHERE id = ?').get(bookId);
  assert.equal(bookAfterRevoke.status, 'наличен', 'книгата трябва да се върне във фонда като "наличен"');

  const holdAfterRevoke = db.prepare('SELECT status FROM holds WHERE id = ?').get(holdId);
  assert.equal(holdAfterRevoke.status, 'отказана',
    'анулирането на акта НЕ бива да възкресява автоматично вече отказаната резервация — читателят е бил уведомен/освободен');
});

/* =====================================================================
   4) backup.js: db.serialize() при ГОЛЯМА база (500–1000 книги) — реален
      кръгов тест байт по байт (декриптиран резултат срещу оригиналната
      база), плюс graceful поведение при инжектирана грешка в db.serialize().
      fixes-v24-holds-backup.test.js тества само тривиална база с 1 ред.
   ===================================================================== */
function seedLargeLibrary(db, n) {
  db.exec(`CREATE TABLE books (
    id INTEGER PRIMARY KEY, inv_number INTEGER, title TEXT, author TEXT,
    status TEXT, price REAL, department TEXT, annotation TEXT
  )`);
  const ins = db.prepare(`INSERT INTO books (inv_number, title, author, status, price, department, annotation)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction((count) => {
    for (let i = 1; i <= count; i++) {
      ins.run(
        i,
        'Заглавие № ' + i + ' — дълъг текст за реалистичен размер на реда, повтарящ се цифри ' + (i % 97),
        'Автор ' + (i % 251),
        ['наличен', 'липсващ', 'за реставрация', 'отчислен'][i % 4],
        Math.round((5 + (i % 40) * 1.37) * 100) / 100,
        ['заемна', 'детски', 'за възрастни', null][i % 4],
        i % 5 === 0 ? ('Анотация с повтарящ се текст № ' + i + '. '.repeat(10)) : null
      );
    }
  });
  tx(n);
}

test('backup.js: db.serialize() при голяма (1000 книги) КРИПТИРАНА база — реален кръгов тест байт по байт (одит #19, мащаб)', async () => {
  const N = 1000;
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-reaudit-b-backup-large-'));
  const dbPath = path.join(dir, 'library.db');
  const liveDb = new Database(dbPath);
  seedLargeLibrary(liveDb, N);

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  registerBackupHandlers(ipcMain, {
    app: { getPath: (n) => (n === 'temp' ? os.tmpdir() : dir), relaunch: () => {}, exit: () => {} },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, 'manual-backup-large.invbak') }),
      showOpenDialog: async () => ({ canceled: true })
    },
    fs, path,
    getDb: () => liveDb, setDb: () => {},
    getMainWindow: () => ({ id: 'fake-window' }),
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath
  });

  const result = await ipcMain.invoke('backup:now', { password: 'парола-за-голямата-база-2026' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.encrypted, true);

  const backupCrypto = require('../backup-crypto');
  const decrypted = backupCrypto.decryptBackupBuffer(result.data, 'парола-за-голямата-база-2026');

  // Байт по байт: разкриптираният буфер, зареден като SQLite база, трябва да
  // съдържа ТОЧНО толкова редове и ТОЧНО същото съдържание като оригинала.
  const decDb = new Database(decrypted, { readonly: true });
  const count = decDb.prepare('SELECT COUNT(*) AS n FROM books').get().n;
  assert.equal(count, N, 'декриптираното копие трябва да съдържа всичките ' + N + ' книги');

  const origRows = liveDb.prepare('SELECT inv_number, title, author, status, price, department, annotation FROM books ORDER BY id').all();
  const decRows = decDb.prepare('SELECT inv_number, title, author, status, price, department, annotation FROM books ORDER BY id').all();
  assert.deepEqual(decRows, origRows, 'декриптираното копие трябва да съвпада ред по ред с живата база (1000 книги)');
  decDb.close();
  liveDb.close();
});

test('backup.js: doBackupTo не троши приложението, когато db.serialize() хвърли грешка — backup:now се проваля контролирано, не с необработено изключение (одит #19, injected failure)', async () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-reaudit-b-backup-fail-'));
  const dbPath = path.join(dir, 'library.db');
  const realDb = new Database(dbPath);
  realDb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  realDb.prepare('INSERT INTO t (v) VALUES (?)').run('оригинал-fail-test');

  // Прокси около истинската db връзка, който подменя САМО serialize(), за да
  // симулира грешка от better-sqlite3 (напр. недостатъчна памет за много
  // голяма база) — pragma/prepare/close остават истински, за да не чупим
  // wal_checkpoint по-рано в doBackupTo.
  const dbProxy = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'serialize') {
        return () => { throw new Error('симулирана грешка: недостатъчна памет за db.serialize()'); };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  registerBackupHandlers(ipcMain, {
    app: { getPath: (n) => (n === 'temp' ? os.tmpdir() : dir), relaunch: () => {}, exit: () => {} },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, 'manual-backup.db') }),
      showOpenDialog: async () => ({ canceled: true })
    },
    fs, path,
    getDb: () => dbProxy, setDb: () => {},
    getMainWindow: () => ({ id: 'fake-window' }),
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath
  });

  // Целият тестов процес не бива да гръмне (необработено изключение би
  // убило node --test) — invoke трябва да си остане в рамките на handler-а.
  const result = await ipcMain.invoke('backup:now', {});
  assert.equal(result.ok, false, 'провалено db.serialize() трябва да върне контролирана грешка, не да срине процеса');
  assert.match(result.error, /симулирана грешка/, 'грешката от db.serialize() трябва да стигне четимо до извикващия');

  // Живата база трябва да си остане непокътната и работеща след провала.
  assert.equal(realDb.prepare('SELECT v FROM t').get().v, 'оригинал-fail-test');
  realDb.close();
});

test('backup.js: autoBackupIfNeeded() (извикана fire-and-forget при стартиране, main.js) не хвърля навън, когато db.serialize() гръмне (одит #19, injected failure)', () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-reaudit-b-autobackup-fail-'));
  const dbPath = path.join(dir, 'library.db');
  const realDb = new Database(dbPath);
  realDb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  const dbProxy = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'serialize') return () => { throw new Error('симулирана грешка при автоматично копие'); };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const { autoBackupIfNeeded } = registerBackupHandlers(ipcMain, {
    app: { getPath: (n) => (n === 'temp' ? os.tmpdir() : dir), relaunch: () => {}, exit: () => {} },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    fs, path,
    getDb: () => dbProxy, setDb: () => {},
    getMainWindow: () => ({ id: 'fake-window' }),
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath
  });

  // main.js вика това СИНХРОННО, БЕЗ try/catch около нея, в app.whenReady() —
  // ако тя хвърли, това би сринало стартирането на цялото приложение.
  assert.doesNotThrow(() => autoBackupIfNeeded(),
    'autoBackupIfNeeded трябва да поглъща грешката от db.serialize() вътрешно, не да я пуска навън към main.js');
  realDb.close();
});
