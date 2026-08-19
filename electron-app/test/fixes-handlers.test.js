// Тестове към поправките по одита за v2.2.0 (девет дефекта в handler-ите).
// Всеки тест тук пада с кода отпреди поправката и минава след нея — това е
// целта му, затова над всеки блок стои кратко описание на самия дефект.
// Моделът е същият като в останалите handlers-*.test.js: фалшив ipcMain, който
// пази регистрираните callback-и, истинска временна SQLite база от db/schema.sql
// и подадени наготово зависимости (без Electron и без main.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { ftsQuery, BOOKS_FTS_SETUP_SQL, READERS_FTS_SETUP_SQL } = require('../search-fts');
const { normalizeScanCode } = require('../security-utils');
const pii = require('../pii-crypto');
const { isEncryptedBackup, decryptBackupBuffer } = require('../backup-crypto');

const registerBooksHandlers = require('../handlers/books');
const registerReadersHandlers = require('../handlers/readers');
const registerBackupHandlers = require('../handlers/backup');
const registerDbLocationHandlers = require('../handlers/db-location');
const registerDeaccessionActsHandlers = require('../handlers/deaccession-acts');
const registerAcquisitionsHandlers = require('../handlers/acquisitions');
const registerMzsHandlers = require('../handlers/mzs');
const registerStatsHandlers = require('../handlers/stats');
const registerDnevnikHandlers = require('../handlers/dnevnik');
const registerPdpHandlers = require('../handlers/pdp');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}
const RUN = (fn) => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err.message }; }
};
function tmpDir(tag) { return mkTmpDir(path.join(os.tmpdir(), 'inv-' + tag + '-')); }
function freshDb(dir, extraSql) {
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  if (extraSql) db.exec(extraSql);
  return db;
}
/* Истинският BOOK_SELECT от handlers/books.js — „опростеното" копие тук беше
   без quantity/available (вж. test/helpers/prod-values.js). */
const { BOOK_SELECT, diffFields, csvCell } = require('./helpers/prod-values.js');


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

/* ===========================================================================
   1) books:delete / readers:delete не проверяваха за заемания.
   loans.book_id и loans.reader_id са с ON DELETE CASCADE — изтриването на
   документ/читател мълчаливо триеше и текущите заемания, и цялата история.
   =========================================================================== */

function setupBooks() {
  const dir = tmpDir('fix-books');
  const db = freshDb(dir, BOOKS_FTS_SETUP_SQL);
  const ipcMain = fakeIpcMain();
  registerBooksHandlers(ipcMain, {
    getDb: () => db, run: RUN, logAudit: () => {}, today: () => '2026-08-02', ftsQuery,
    cnSortKey: (s) => String(s || ''), diffFields, scheduleCatalogWrite: () => {}, normalizeScanCode
  });
  return { db, ipcMain };
}
function setupReaders() {
  const dir = tmpDir('fix-readers');
  const db = freshDb(dir, READERS_FTS_SETUP_SQL);
  const ipcMain = fakeIpcMain();
  registerReadersHandlers(ipcMain, {
    getDb: () => db, run: RUN, logAudit: () => {}, today: () => '2026-08-02', ftsQuery,
    maskReaderRow: (r) => r, maskReaderRows: (rows) => rows, preparePiiForWrite: () => {},
    diffFields, checkRecordLimit: () => {},
    dialog: { showSaveDialog: async () => ({ canceled: true }) }, getMainWindow: () => ({}), fs,
    csvCell, normalizeScanCode
  });
  return { db, ipcMain };
}
/* Заемане направо в базата. За ОТВОРЕНО заемане трябва и наличност в inventory:
   schema.sql пази с тригер (trg_loans_capacity) правилото „активните заемания не
   надвишават бройките“. */
function lendBook(db, { bookId, readerId, dateOut, dateIn }) {
  if (!dateIn) {
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1) ON CONFLICT(book_id) DO UPDATE SET quantity = quantity + 1')
      .run(bookId);
  }
  return db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, readerId, dateOut, '2026-01-31', dateIn || null).lastInsertRowid;
}

test('books:delete отказва изтриване на документ с активно заемание и казва колко са', async () => {
  const { db, ipcMain } = setupBooks();
  const bookId = (await ipcMain.invoke('books:create', { title: 'Под игото', inv_number: 1 })).data;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  lendBook(db, { bookId, readerId, dateOut: '2026-01-01' });

  const result = await ipcMain.invoke('books:delete', bookId);
  assert.equal(result.ok, false, 'изтриването трябва да бъде отказано');
  assert.match(result.error, /зает в момента/);
  assert.match(result.error, /1 незавършено заемане/);
  assert.ok(db.prepare('SELECT 1 FROM books WHERE id=?').get(bookId), 'документът остава');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id=?').get(bookId).n, 1,
    'заемането не бива да е изтрито каскадно');
});

test('books:delete отказва и когато има само затворена история на заеманията (тя изчезва каскадно)', async () => {
  const { db, ipcMain } = setupBooks();
  const bookId = (await ipcMain.invoke('books:create', { title: 'Стара книга', inv_number: 2 })).data;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  lendBook(db, { bookId, readerId, dateOut: '2024-01-01', dateIn: '2024-01-20' });

  const result = await ipcMain.invoke('books:delete', bookId);
  assert.equal(result.ok, false);
  assert.match(result.error, /историята на заеманията/);
  assert.match(result.error, /акт за отчисляване/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 1);
});

test('books:delete продължава да трие документ без нито едно заемане', async () => {
  const { db, ipcMain } = setupBooks();
  const bookId = (await ipcMain.invoke('books:create', { title: 'Никога незаемана', inv_number: 3 })).data;
  const result = await ipcMain.invoke('books:delete', bookId);
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT 1 FROM books WHERE id=?').get(bookId), undefined);
});

test('readers:delete отказва изтриване на читател с невърнати документи и казва колко са', async () => {
  const { db, ipcMain } = setupReaders();
  const readerId = (await ipcMain.invoke('readers:create', { name: 'Стар читател' })).data;
  const b1 = db.prepare("INSERT INTO books (inv_number, title) VALUES (11, 'А')").run().lastInsertRowid;
  const b2 = db.prepare("INSERT INTO books (inv_number, title) VALUES (12, 'Б')").run().lastInsertRowid;
  const b3 = db.prepare("INSERT INTO books (inv_number, title) VALUES (13, 'В')").run().lastInsertRowid;
  [b1, b2, b3].forEach(bookId => lendBook(db, { bookId, readerId, dateOut: '2026-01-01' }));

  const result = await ipcMain.invoke('readers:delete', readerId);
  assert.equal(result.ok, false);
  assert.match(result.error, /3 незавърнати документа/);
  assert.ok(db.prepare('SELECT 1 FROM readers WHERE id=?').get(readerId), 'читателят остава');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n, 3,
    'активните заемания не бива да изчезват');
});

test('readers:delete отказва и при само затворена история, като сочи анонимизирането', async () => {
  const { db, ipcMain } = setupReaders();
  const readerId = (await ipcMain.invoke('readers:create', { name: 'Отдавнашен читател' })).data;
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (21, 'Г')").run().lastInsertRowid;
  lendBook(db, { bookId, readerId, dateOut: '2023-01-01', dateIn: '2023-02-01' });

  const result = await ipcMain.invoke('readers:delete', readerId);
  assert.equal(result.ok, false);
  assert.match(result.error, /Анонимизиране/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 1);
});

/* ===========================================================================
   2) dbLocation:choose затваряше базата ПРЕДИ копирането — провалено копиране
   (мрежов дял само за четене, пълен диск) оставяше програмата без работеща
   база, без рестарт и без записана настройка.
   =========================================================================== */

function setupDbLocation(fsPatch) {
  const dir = tmpDir('fix-dbloc');
  const dbFolder = path.join(dir, 'defaultdb');
  fs.mkdirSync(dbFolder, { recursive: true });
  let db = new Database(path.join(dbFolder, 'library.db'));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare("INSERT INTO t (v) VALUES ('оригинал')").run();

  let config = {};
  const relaunchCalls = [], exitCalls = [];
  const newDir = mkTmpDir(path.join(os.tmpdir(), 'inv-fix-dbloc-target-'));
  const ipcMain = fakeIpcMain();
  registerDbLocationHandlers(ipcMain, {
    app: { isPackaged: false, relaunch: () => relaunchCalls.push(true), exit: (c) => exitCalls.push(c) },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [newDir] }),
      showMessageBox: async () => ({ response: 0 })
    },
    // fs има само-за-четене свойства, затова се обгръща, а не се копира
    // (същият похват като в handlers-backup.test.js).
    fs: fsPatch ? new Proxy(fs, { get: (t, p) => (p in fsPatch ? fsPatch[p] : t[p]) }) : fs,
    path,
    getDb: () => db, setDb: (v) => { db = v; }, getMainWindow: () => ({}),
    run: RUN,
    readConfig: () => config, writeConfig: (cfg) => { config = cfg; },
    resolveDbDir: () => dbFolder,
    resolveDbPath: () => path.join(dbFolder, 'library.db')
  });
  return { ipcMain, newDir, relaunchCalls, exitCalls, getConfig: () => config, getDb: () => db };
}

test('провалено копиране при смяна на папката на базата оставя програмата с работеща база', async () => {
  let sawStaged = null;
  const { ipcMain, newDir, relaunchCalls, exitCalls, getConfig, getDb } = setupDbLocation({
    copyFileSync: (src, dest) => {
      if (String(dest).endsWith('.copy-tmp')) { sawStaged = dest; throw new Error('EROFS: дялът е само за четене'); }
      return fs.copyFileSync(src, dest);
    }
  });

  const result = await ipcMain.invoke('dbLocation:choose');
  assert.equal(result.ok, false, 'провалът трябва да се съобщи');
  assert.match(result.error, /не можа да бъде копирана/);
  assert.ok(sawStaged, 'копието се прави настрани, а не направо върху целевия файл');
  // Най-важното: базата да е още отворена и програмата да работи.
  assert.doesNotThrow(() => getDb().prepare('SELECT v FROM t').get(),
    'базата трябва да е останала отворена — иначе всяко следващо действие гърми с „database connection is not open“');
  assert.equal(getConfig().dbFolder, undefined, 'настройката не се променя при провал');
  assert.equal(relaunchCalls.length, 0);
  assert.equal(exitCalls.length, 0);
  assert.equal(fs.existsSync(path.join(newDir, 'library.db.copy-tmp')), false, 'временният файл се почиства');
});

test('успешната смяна на папката копира базата, записва настройката и рестартира', async () => {
  const { ipcMain, newDir, relaunchCalls, exitCalls, getConfig } = setupDbLocation();
  const result = await ipcMain.invoke('dbLocation:choose');
  assert.equal(result.ok, true);
  const copied = new Database(path.join(newDir, 'library.db'));
  assert.equal(copied.prepare('SELECT v FROM t').get().v, 'оригинал');
  copied.close();
  assert.equal(getConfig().dbFolder, newDir);
  assert.equal(relaunchCalls.length, 1);
  assert.equal(exitCalls.length, 1);
});

/* ===========================================================================
   3) Номерът на акт/партида/заявка се вземаше с MAX(no)+1 при отваряне на
   формата и не се проверяваше при записа: две работни места към една мрежова
   база правеха два акта № 5/2026.
   =========================================================================== */

function setupDeacc() {
  const dir = tmpDir('fix-deacc');
  const db = freshDb(dir);
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  registerDeaccessionActsHandlers(ipcMain, {
    getDb: () => db, run: RUN, logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    BOOK_SELECT, yearOf: (d) => (d || '2026-08-02').slice(0, 4),
    scheduleCatalogWrite: () => {}, normalizeScanCode
  });
  return { db, ipcMain, auditLog };
}
function setupAcq() {
  const dir = tmpDir('fix-acq');
  const db = freshDb(dir);
  const ipcMain = fakeIpcMain();
  registerAcquisitionsHandlers(ipcMain, {
    getDb: () => db, run: RUN, logAudit: () => {}, BOOK_SELECT, yearOf: (d) => (d || '2026-08-02').slice(0, 4)
  });
  return { db, ipcMain };
}
function setupMzs() {
  const dir = tmpDir('fix-mzs');
  const db = freshDb(dir);
  const ipcMain = fakeIpcMain();
  registerMzsHandlers(ipcMain, {
    getDb: () => db, run: RUN, logAudit: () => {}, yearOf: (d) => (d || '2026-08-02').slice(0, 4)
  });
  return { db, ipcMain };
}

test('deaccessionActs:create отказва втори акт със същия номер за същата година', async () => {
  const { db, ipcMain } = setupDeacc();
  const first = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 5, date: '2026-03-01', reason_code: 1, reason_text: 'износени' }, bookIds: []
  });
  assert.equal(first.ok, true);
  // Второто работно място е взело същия № 5 при отваряне на формата.
  const second = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 5, date: '2026-04-01', reason_code: 1, reason_text: 'липсващи' }, bookIds: []
  });
  assert.equal(second.ok, false);
  assert.match(second.error, /Акт № 5\/2026 вече съществува/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM deaccession_acts WHERE year='2026' AND no=5").get().n, 1);
  // Друга година със същия номер е напълно законна.
  const otherYear = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 5, date: '2025-04-01', reason_code: 1, reason_text: 'износени' }, bookIds: []
  });
  assert.equal(otherYear.ok, true);
});

test('acquisitions:create отказва втора партида със същия номер за същата година', async () => {
  const { db, ipcMain } = setupAcq();
  assert.equal((await ipcMain.invoke('acquisitions:create', { no: 7, date: '2026-02-01', total_count: 3 })).ok, true);
  const dup = await ipcMain.invoke('acquisitions:create', { no: 7, date: '2026-02-02', total_count: 1 });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /Партида № 7\/2026 вече съществува/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM acquisitions WHERE year='2026'").get().n, 1);
});

test('mzs:create отказва втора заявка със същия номер за същата година', async () => {
  const { db, ipcMain } = setupMzs();
  assert.equal((await ipcMain.invoke('mzs:create', { no: 2, date: '2026-05-01', partner: 'РБ', title: 'Книга' })).ok, true);
  const dup = await ipcMain.invoke('mzs:create', { no: 2, date: '2026-05-02', partner: 'РБ', title: 'Друга' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /Заявка № 2\/2026 вече съществува/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mzs_requests WHERE year='2026'").get().n, 1);
});

/* ===========================================================================
   4) Автоматичното дневно копие никога не се криптираше, макар да съдържа
      всички лични данни на читателите и да стои 30 дни в папката на базата
      (по документиран сценарий — споделен мрежов дял).
   6) backup:restoreFromList/restoreBrowse приемаха произволен път от renderer-а
      и го инсталираха като активна база.
   =========================================================================== */

function setupBackup() {
  const dir = tmpDir('fix-backup');
  const dbPath = path.join(dir, 'library.db');
  let db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');

  const auditLog = [];
  const relaunchCalls = [], exitCalls = [];
  const dialogChoice = { filePaths: [] };
  const ipcMain = fakeIpcMain();
  const handlers = registerBackupHandlers(ipcMain, {
    app: {
      getPath: (n) => (n === 'temp' ? os.tmpdir() : dir),
      relaunch: () => relaunchCalls.push(true), exit: (c) => exitCalls.push(c)
    },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, 'ryachno.db') }),
      showOpenDialog: async () => (dialogChoice.filePaths.length
        ? { canceled: false, filePaths: dialogChoice.filePaths }
        : { canceled: true, filePaths: [] })
    },
    fs, path,
    getDb: () => db, setDb: (v) => { db = v; }, getMainWindow: () => ({}),
    run: RUN, logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath
  });
  return { dir, dbPath, ipcMain, handlers, auditLog, dialogChoice, relaunchCalls, exitCalls, getDb: () => db };
}
// Защитата на лични данни, „зададена и отключена“ — точно състоянието, при
// което авто-копието вече може да се криптира (виж handlers/pdp.js).
function unlockPdp(db, password) {
  const salt = pii.generateSalt(pii.CURRENT_KDF_VERSION);
  const key = pii.deriveKey(password, salt);
  db.prepare('UPDATE settings SET pdp_salt=?, pdp_verifier=? WHERE id=1')
    .run(salt.toString('base64'), pii.makeVerifier(key));
  pii.setSession(password, key);
}

test('авто-копието се криптира с паролата на защитата на личните данни, когато тя е отключена', async () => {
  const { dir, handlers, auditLog, getDb } = setupBackup();
  try {
    unlockPdp(getDb(), 'парола-на-библиотеката');
    handlers.autoBackupIfNeeded();

    const today = new Date().toISOString().slice(0, 10);
    const enc = path.join(dir, 'backups', `auto-${today}.invbak`);
    assert.ok(fs.existsSync(enc), 'очаква се криптирано авто-копие (.invbak)');
    assert.equal(fs.existsSync(path.join(dir, 'backups', `auto-${today}.db`)), false,
      'не бива да остава и некриптирано копие със същите данни');
    assert.equal(isEncryptedBackup(enc), true);
    // Копието трябва да се отключва със СЪЩАТА парола, която библиотекарят знае.
    const plain = decryptBackupBuffer(enc, 'парола-на-библиотеката');
    assert.equal(plain.subarray(0, 15).toString('utf8'), 'SQLite format 3');
    assert.ok(auditLog.some(a => /автоматично криптирано копие/.test(a.detail)));
  } finally {
    pii.clearSession();
  }
});

test('без защита на личните данни авто-копието продължава да се прави, но с предупреждение в одита и за интерфейса', async () => {
  const { dir, ipcMain, handlers, auditLog } = setupBackup();
  pii.clearSession();
  handlers.autoBackupIfNeeded();

  const today = new Date().toISOString().slice(0, 10);
  assert.ok(fs.existsSync(path.join(dir, 'backups', `auto-${today}.db`)),
    'копието трябва да се прави и без парола — липсата на копия е по-голямата беда');
  assert.ok(auditLog.some(a => /ВНИМАНИЕ/.test(a.detail) && /НЕ е криптирано/.test(a.detail)),
    'некриптираното копие се вписва в одитната следа');

  const status = await ipcMain.invoke('backup:autoStatus');
  assert.equal(status.ok, true);
  assert.equal(status.data.encrypted, false);
  assert.match(status.data.warning, /НЕ са криптирани/,
    'интерфейсът трябва да може да покаже предупреждението');
});

test('отключването на защитата презаписва днешното некриптирано копие с криптирано', async () => {
  const { dir, handlers, auditLog, getDb } = setupBackup();
  try {
    pii.clearSession();
    handlers.autoBackupIfNeeded(); // при стартиране защитата още е заключена
    const today = new Date().toISOString().slice(0, 10);
    const plain = path.join(dir, 'backups', `auto-${today}.db`);
    const enc = path.join(dir, 'backups', `auto-${today}.invbak`);
    assert.ok(fs.existsSync(plain));

    unlockPdp(getDb(), 'парола-на-библиотеката'); // библиотекарят отключва по-късно

    assert.ok(fs.existsSync(enc), 'копието за деня трябва да стане криптирано');
    assert.equal(fs.existsSync(plain), false, 'некриптираното копие с лични данни не бива да остава');
    assert.equal(decryptBackupBuffer(enc, 'парола-на-библиотеката').subarray(0, 15).toString('utf8'), 'SQLite format 3');
    assert.ok(auditLog.some(a => /презаписано криптирано/.test(a.detail)));
  } finally { pii.clearSession(); }
});

test('backup:restoreFromList отказва път извън папката с резервните копия', async () => {
  const { dir, dbPath, ipcMain, relaunchCalls } = setupBackup();
  // „Чужд“ файл, подхвърлен от renderer-а (или от компрометирана страница).
  const foreign = path.join(dir, 'podhvyrlena.db');
  const f = new Database(foreign);
  f.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  f.close();

  const result = await ipcMain.invoke('backup:restoreFromList', { path: foreign, password: undefined });
  assert.equal(result.ok, false);
  assert.match(result.error, /папката с резервните копия/);
  assert.equal(relaunchCalls.length, 0, 'нищо не се възстановява и програмата не се рестартира');
  assert.ok(fs.existsSync(dbPath), 'активната база не е пипана');
});

test('backup:restoreFromList отказва и заобикаляне с „..“ в пътя', async () => {
  const { dir, ipcMain } = setupBackup();
  // Нарочно НЕнормализиран низ — точно каквото би подал renderer-ът.
  const sneaky = path.join(dir, 'backups') + path.sep + '..' + path.sep + 'podhvyrlena2.db';
  const f = new Database(path.join(dir, 'podhvyrlena2.db'));
  f.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  f.close();
  const result = await ipcMain.invoke('backup:restoreFromList', { path: sneaky, password: undefined });
  assert.equal(result.ok, false);
  assert.match(result.error, /папката с резервните копия/);
});

test('backup:restoreBrowse не приема път-низ от renderer-а, а само избран през системния диалог', async () => {
  const { dir, ipcMain, dialogChoice, relaunchCalls } = setupBackup();
  const usb = path.join(dir, 'ot-usb.db');
  const u = new Database(usb);
  u.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  u.prepare("INSERT INTO t (v) VALUES ('от-usb')").run();
  u.close();

  // 1) Директно подаден път — отказ.
  const injected = await ipcMain.invoke('backup:restoreBrowse', { path: usb });
  assert.equal(injected.ok, false);
  assert.match(injected.error, /избран през диалога/);
  assert.equal(relaunchCalls.length, 0);

  // 2) Същият файл, но избран от потребителя през диалога — минава, и оттам
  //    нататък пътят е одобрен (интерфейсът го връща втори път заедно с парола).
  dialogChoice.filePaths = [usb];
  const chosen = await ipcMain.invoke('backup:restoreBrowse', {});
  assert.equal(chosen.ok, true);
  assert.equal(relaunchCalls.length, 1);
  const again = await ipcMain.invoke('backup:restoreBrowse', { path: usb, password: '' });
  assert.equal(again.ok, true, 'вече одобреният от диалога път се приема при второто извикване');
});

/* ===========================================================================
   5) Защита на личните данни: минимум 4 знака за паролата и евтин scrypt, при
      сол/проверител, които стоят в базата на споделен мрежов дял.
   =========================================================================== */

function setupPdp() {
  const dir = tmpDir('fix-pdp');
  const db = freshDb(dir, 'ALTER TABLE settings ADD COLUMN pdp_salt TEXT; ALTER TABLE settings ADD COLUMN pdp_verifier TEXT;');
  const ipcMain = fakeIpcMain();
  const returned = registerPdpHandlers(ipcMain, { getDb: () => db, run: RUN, logAudit: () => {} });
  return { db, ipcMain, returned };
}

test('pdp:setup изисква поне 10 знака за нова парола', async () => {
  const { ipcMain } = setupPdp();
  try {
    const short = await ipcMain.invoke('pdp:setup', 'parola1'); // 7 знака — допустимо преди
    assert.equal(short.ok, false);
    assert.match(short.error, /поне 10 знака/);
    const ok = await ipcMain.invoke('pdp:setup', 'dostatychno-dylga');
    assert.equal(ok.ok, true);
  } finally { pii.clearSession(); }
});

test('pdp:changePassword също изисква поне 10 знака за новата парола', async () => {
  const { ipcMain } = setupPdp();
  try {
    await ipcMain.invoke('pdp:setup', 'dostatychno-dylga');
    const short = await ipcMain.invoke('pdp:changePassword', { oldPassword: 'dostatychno-dylga', newPassword: 'kratka12' });
    assert.equal(short.ok, false);
    assert.match(short.error, /поне 10 знака/);
  } finally { pii.clearSession(); }
});

test('новата парола ползва по-скъпите параметри на scrypt (версия в самата сол)', async () => {
  const { db, ipcMain } = setupPdp();
  try {
    await ipcMain.invoke('pdp:setup', 'dostatychno-dylga');
    const salt = Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64');
    assert.equal(pii.saltVersion(salt), pii.CURRENT_KDF_VERSION, 'солта трябва да носи текущата версия на параметрите');
    assert.notEqual(pii.saltVersion(salt), 1);
  } finally { pii.clearSession(); }
});

test('стара база (сол по стария образец) продължава да се отключва със старите параметри', async () => {
  const { db, ipcMain, returned } = setupPdp();
  try {
    // Точно каквото би оставила предишната версия на програмата: 16-байтова сол
    // и ключ, изведен с евтиния scrypt — включително КЪСА парола отпреди правилото.
    const legacySalt = pii.generateSalt(); // v1, 16 байта
    assert.equal(legacySalt.length, 16);
    const legacyKey = pii.deriveKey('стар1', legacySalt);
    db.prepare('UPDATE settings SET pdp_salt=?, pdp_verifier=? WHERE id=1')
      .run(legacySalt.toString('base64'), pii.makeVerifier(legacyKey));
    const readerId = db.prepare("INSERT INTO readers (name, egn) VALUES ('Иван', ?)")
      .run(pii.encryptField('7501011234', legacyKey)).lastInsertRowid;

    const unlocked = await ipcMain.invoke('pdp:unlock', 'стар1');
    assert.equal(unlocked.ok, true, 'старата парола трябва да отключва и след вдигането на цената');
    // И данните да се четат наистина, а не само проверителят да съвпадне.
    const row = returned.maskReaderRow(db.prepare('SELECT * FROM readers WHERE id=?').get(readerId));
    assert.equal(row.egn, '7501011234');
  } finally { pii.clearSession(); }
});

/* ===========================================================================
   7) Отчисляване с причина „невърнати от ползватели" затваряше активния заем, а
   анулирането на акта връщаше книгата „наличен", без да отвори заема обратно —
   книгата се водеше свободна, макар да е у читателя.
   =========================================================================== */

test('анулирането на акт отваря обратно заеманията, закрити принудително от него', async () => {
  const { db, ipcMain } = setupDeacc();
  const bookId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (31, 'Невърната', 'наличен')").run().lastInsertRowid;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const loanId = lendBook(db, { bookId, readerId, dateOut: '2025-11-01' });

  const created = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-06-01', reason_code: 6, reason_text: 'невърнати от ползватели' },
    bookIds: [bookId]
  });
  assert.equal(created.ok, true);
  assert.equal(db.prepare('SELECT date_in FROM loans WHERE id=?').get(loanId).date_in, '2026-06-01');

  const revoked = await ipcMain.invoke('deaccessionActs:revoke', created.data);
  assert.equal(revoked.ok, true);
  const loan = db.prepare('SELECT date_in FROM loans WHERE id=?').get(loanId);
  assert.equal(loan.date_in, null, 'заемът трябва да е отворен обратно — книгата реално е у читателя');
  assert.equal(db.prepare('SELECT status FROM books WHERE id=?').get(bookId).status, 'наличен');
});

test('анулирането не отваря заемане, което е било върнато нормално в деня на акта', async () => {
  const { db, ipcMain } = setupDeacc();
  const bookId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (32, 'Върната и отчислена', 'наличен')").run().lastInsertRowid;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  // Читателят връща повредената книга, същия ден тя се отчислява с акт.
  const returnedLoan = lendBook(db, { bookId, readerId, dateOut: '2026-05-01', dateIn: '2026-06-01' });

  const created = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 2, date: '2026-06-01', reason_code: 3, reason_text: 'износени' }, bookIds: [bookId]
  });
  await ipcMain.invoke('deaccessionActs:revoke', created.data);
  assert.equal(db.prepare('SELECT date_in FROM loans WHERE id=?').get(returnedLoan).date_in, '2026-06-01',
    'нормално върнат документ не бива да се „отзаема“ обратно');
});

/* ===========================================================================
   8) stats:report: finesCollected сумираше НАЧИСЛЕНИТЕ глоби по годината на
   ЗАЕМАНЕ (а етикетът в интерфейса е „Събрани обезщетения“), а topLoans нямаше
   филтър по година, макар да стои под „отчетен период 01.01–31.12“.
   =========================================================================== */

function setupStats() {
  const dir = tmpDir('fix-stats');
  const db = freshDb(dir);
  const ipcMain = fakeIpcMain();
  registerStatsHandlers(ipcMain, {
    getDb: () => db, run: RUN, yearOf: () => '2026',
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: () => ({})
  });
  return { db, ipcMain };
}

test('stats:report брои реално платените обезщетения, а не начислените глоби', async () => {
  const { db, ipcMain } = setupStats();
  const bookId = db.prepare("INSERT INTO books (inv_number, title, register_date) VALUES (41, 'А', '2025-01-01')").run().lastInsertRowid;
  const readerId = db.prepare("INSERT INTO readers (name, registered_at) VALUES ('Читател', '2025-01-01')").run().lastInsertRowid;
  // Книга, заета през декември 2025 и върната със закъснение през февруари 2026.
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in, fine) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bookId, readerId, '2025-12-01', '2025-12-31', '2026-02-01', 5);
  // Обезщетението е начислено и платено през 2026 г.
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-02-01', 'начисление', 'обезщетение', 5)").run(readerId);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-02-01', 'плащане', 'плащане', -5)").run(readerId);

  const y2026 = (await ipcMain.invoke('stats:report', '2026')).data;
  assert.equal(y2026.finesCollected, 5, 'събраното се брои в годината на плащането');
  assert.equal(y2026.finesCharged, 5, 'начисленото се брои в годината на ВРЪЩАНЕ');

  const y2025 = (await ipcMain.invoke('stats:report', '2025')).data;
  assert.equal(y2025.finesCollected, 0, 'нищо не е било събрано през 2025 г.');
  assert.equal(y2025.finesCharged, 0);
});

test('stats:report не приписва на обезщетенията пари, платени за годишна такса', async () => {
  const { db, ipcMain } = setupStats();
  const readerId = db.prepare("INSERT INTO readers (name, registered_at) VALUES ('Читател', '2026-01-01')").run().lastInsertRowid;
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-10', 'начисление', 'годишна такса', 12)").run(readerId);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-10', 'плащане', 'плащане', -12)").run(readerId);

  const r = (await ipcMain.invoke('stats:report', '2026')).data;
  assert.equal(r.finesCollected, 0);
});

test('stats:report ограничава „най-търсени документи“ до отчетната година', async () => {
  const { db, ipcMain } = setupStats();
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const oldBook = db.prepare("INSERT INTO books (inv_number, title, register_date) VALUES (51, 'Хит от 2019', '2019-01-01')").run().lastInsertRowid;
  const newBook = db.prepare("INSERT INTO books (inv_number, title, register_date) VALUES (52, 'Хит от 2026', '2026-01-01')").run().lastInsertRowid;
  for (let i = 0; i < 5; i++) lendBook(db, { bookId: oldBook, readerId, dateOut: '2019-05-0' + (i + 1), dateIn: '2019-06-01' });
  lendBook(db, { bookId: newBook, readerId, dateOut: '2026-05-01', dateIn: '2026-06-01' });

  const r = (await ipcMain.invoke('stats:report', '2026')).data;
  assert.deepEqual(r.topLoans.map(t => t.title), ['Хит от 2026'],
    'заглавие, търсено само през 2019 г., няма място в отчета за 2026 г.');
});

/* ===========================================================================
   9) dnevnik:exportCsv ползваше собствен esc() без защита срещу
   formula-injection, за разлика от всички останали CSV пътища (csvCell).
   =========================================================================== */

test('dnevnik:exportCsv минава през общата защита срещу формули (csvCell)', async () => {
  const dir = tmpDir('fix-dnevnik');
  const db = freshDb(dir);
  const outPath = path.join(dir, 'dnevnik.csv');
  const ipcMain = fakeIpcMain();
  registerDnevnikHandlers(ipcMain, {
    getDb: () => db, run: RUN, logAudit: () => {},
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: outPath }) },
    getMainWindow: () => ({}), fs
  });
  // SQLite е с динамични типове: в „числовата“ колона може да се окаже текст —
  // напр. при внос от чужд файл или ръчна намеса в базата.
  db.prepare('INSERT INTO dnevnik_days (date, a_hours) VALUES (?, ?)').run('2026-03-01', '=cmd|\'/c calc\'!A1');

  const result = await ipcMain.invoke('dnevnik:exportCsv', { year: 2026, month: 3 });
  assert.equal(result.ok, true);
  const raw = fs.readFileSync(outPath, 'utf8');
  assert.match(raw, /"'=cmd/, 'опасната клетка трябва да е неутрализирана с водещ апостроф');
  assert.doesNotMatch(raw, /;"=cmd/, 'не бива да остава клетка, започваща направо с „=“');
});
