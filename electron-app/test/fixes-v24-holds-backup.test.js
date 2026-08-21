/* Тестове v2.4 за три находки от bug-audit-v2.3.1.md:

   #25 (handlers/holds.js) — „заделена" резервация нямаше механизъм за
       изтичане: непотърсен заделен екземпляр блокираше опашката безкрайно.
       expireStaleHolds() (връщана функция, БЕЗ нов IPC канал — виж
       коментара в handlers/holds.js защо) вече отменя ('отказана', в
       schema.sql/enum-triggers.js няма отделен статус „изтекла") заделени
       резервации, непотърсени над HOLD_EXPIRE_DAYS дни.

   #19 (handlers/backup.js) — автоматичното резервно копие четеше ЖИВИЯ .db
       файл със суров fs.copyFileSync/fs.readFileSync, вместо истинско
       SQLite API. doBackupTo() вече ползва db.serialize() (better-sqlite3,
       sqlite3_serialize) — синхронно, за разлика от db.backup(), което
       връща Promise и не е съвместимо със съществуващите синхронни
       извиквания на autoBackupIfNeeded() (виж коментара в handlers/backup.js).

   #18 (handlers/backup.js, само тест) — мутация, премахваща fast-path
       проверката "todayEncryptedWith вече отговаря" в upgradeTodayAutoBackup,
       оцелява срещу останалия тестов сюит. Тестът тук я убива: при повторно
       отключване със СЪЩАТА парола декриптиращата функция не бива да се
       извиква втори път.

   Моделът е като в test/handlers-holds.test.js / test/handlers-backup.test.js /
   test/fixes-backup-v23.test.js: фалшив ipcMain, истинска временна SQLite
   база от db/schema.sql, подадени зависимости (без Electron). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const registerHoldsHandlers = require('../handlers/holds');
const registerBackupHandlers = require('../handlers/backup');
const registerPdpHandlers = require('../handlers/pdp');
const pii = require('../pii-crypto');
const backupCrypto = require('../backup-crypto');
const { normalizeScanCode } = require('../security-utils');


/* Хигиена на временните папки — виж обяснението в другите test/*.test.js:
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
const RUN = (fn) => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err.message }; }
};

/* =====================================================================
   #25 — handlers/holds.js: изтичане на заделена резервация
   ===================================================================== */

function setupHolds() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fix24-holds-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: RUN,
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    normalizeScanCode
  };
  const returned = registerHoldsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, returned };
}

// Книга с 1 бройка (без отворен заем — точно сценарият на activateHoldOnReturn:
// книгата вече Е върната на гишето, само че е заделена за конкретен читател).
function insertBookAndReader(db, { inv_number, readerName }) {
  const bookId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (?, 'Заделена книга', 'наличен')")
    .run(inv_number).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare('INSERT INTO readers (name) VALUES (?)').run(readerName).lastInsertRowid;
  return { bookId, readerId };
}
function insertHold(db, bookId, readerId, { status = 'чака', ready_at = null, placed_at = null } = {}) {
  return db.prepare(`INSERT INTO holds (book_id, reader_id, status, ready_at, placed_at)
    VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`)
    .run(bookId, readerId, status, ready_at, placed_at).lastInsertRowid;
}
// Помощна функция за дата "преди N дни" в СЪЩИЯ формат като datetime('now') в SQLite.
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

test('registerHoldsHandlers връща expireStaleHolds (по образеца на autoBackupIfNeeded — БЕЗ нов IPC канал, виж бележката в holds.js защо)', () => {
  const { ipcMain, returned } = setupHolds();
  assert.equal(typeof returned.expireStaleHolds, 'function');
  // Нарочно НЯМА holds:expireStale IPC канал — нов канал би счупил
  // test/preload-ipc-channels.test.js (регистриран, но неизложен през
  // preload.js), а preload.js/main.js не са сред файловете, които тази
  // поправка на одит #25 смее да пипа. Виж export-а в handlers/holds.js за
  // какво остава да се добави там, ако занапред потрябва и бутон в интерфейса.
  assert.equal(ipcMain.has('holds:expireStale'), false);
});

test('expireStaleHolds отменя заделена резервация, непотърсена над грайс периода, и я отбелязва в одита', () => {
  const { db, auditLog, returned } = setupHolds();
  const { bookId, readerId } = insertBookAndReader(db, { inv_number: 100, readerName: 'Стар чакащ' });
  const holdId = insertHold(db, bookId, readerId, { status: 'заделена', ready_at: daysAgo(5) });

  const n = returned.expireStaleHolds();
  assert.equal(n, 1);

  const row = db.prepare('SELECT status, resolved_at, note FROM holds WHERE id = ?').get(holdId);
  assert.equal(row.status, 'отказана');
  assert.ok(row.resolved_at, 'resolved_at трябва да е попълнено');
  assert.match(row.note, /изтекла/);

  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].action, 'Изтекла резервация');
  assert.match(auditLog[0].detail, /Стар чакащ/);
});

test('expireStaleHolds НЕ пипа заделена резервация в рамките на грайс периода', () => {
  const { db, returned } = setupHolds();
  const { bookId, readerId } = insertBookAndReader(db, { inv_number: 101, readerName: 'Прясно заделен' });
  const holdId = insertHold(db, bookId, readerId, { status: 'заделена', ready_at: daysAgo(1) });

  const n = returned.expireStaleHolds();
  assert.equal(n, 0);
  assert.equal(db.prepare('SELECT status FROM holds WHERE id = ?').get(holdId).status, 'заделена');
});

test('expireStaleHolds НЕ пипа резервация в статус "чака", колкото и стара да е — редът в опашката тръгва едва след ready_at', () => {
  const { db, returned } = setupHolds();
  const { bookId, readerId } = insertBookAndReader(db, { inv_number: 102, readerName: 'Чакащ в опашка' });
  const holdId = insertHold(db, bookId, readerId, { status: 'чака', placed_at: daysAgo(30) });

  const n = returned.expireStaleHolds();
  assert.equal(n, 0);
  assert.equal(db.prepare('SELECT status FROM holds WHERE id = ?').get(holdId).status, 'чака');
});

test('след изтичане опашката напредва: следващият чакащ става "пръв на ред" вместо блокираната заделена резервация', () => {
  const { db, returned } = setupHolds();
  const { bookId, readerId: r1 } = insertBookAndReader(db, { inv_number: 103, readerName: 'Изчезнал читател' });
  const r2 = db.prepare("INSERT INTO readers (name) VALUES ('Втори в опашката')").run().lastInsertRowid;
  insertHold(db, bookId, r1, { status: 'заделена', ready_at: daysAgo(10), placed_at: daysAgo(12) });
  const hold2Id = insertHold(db, bookId, r2, { status: 'чака', placed_at: daysAgo(2) });

  // Преди изтичането книгата е заключена за първия читател.
  assert.equal(returned.firstActiveHold(bookId).reader_id, r1);

  returned.expireStaleHolds();

  const first = returned.firstActiveHold(bookId);
  assert.ok(first, 'трябва да остане активна резервация');
  assert.equal(first.id, hold2Id);
  assert.equal(first.reader_id, r2, 'опашката трябва да напредне към следващия читател');
});

test('expireStaleHolds връща броя изтекли резервации при няколко едновременно изтекли за различни книги', () => {
  const { db, returned } = setupHolds();
  const b1 = insertBookAndReader(db, { inv_number: 104, readerName: 'Читател 1' });
  const b2 = insertBookAndReader(db, { inv_number: 105, readerName: 'Читател 2' });
  insertHold(db, b1.bookId, b1.readerId, { status: 'заделена', ready_at: daysAgo(4) });
  insertHold(db, b2.bookId, b2.readerId, { status: 'заделена', ready_at: daysAgo(10) });

  assert.equal(returned.expireStaleHolds(), 2);
  assert.equal(returned.expireStaleHolds(), 0, 'втори опит не намира нищо ново за изтичане');
});

/* =====================================================================
   #19 — handlers/backup.js: db.serialize() вместо суров fs.copyFileSync/
   fs.readFileSync на живия .db файл
   ===================================================================== */

function setupBackup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fix24-backup-'));
  const dbPath = path.join(dir, 'library.db');
  let db = new Database(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('оригинал-24');

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    app: { getPath: (n) => (n === 'temp' ? os.tmpdir() : dir), relaunch: () => {}, exit: () => {} },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, 'manual-backup.db') }),
      showOpenDialog: async () => ({ canceled: true })
    },
    fs, path,
    getDb: () => db, setDb: (v) => { db = v; },
    getMainWindow: () => ({ id: 'fake-window' }),
    run: RUN,
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath
  };
  registerBackupHandlers(ipcMain, deps);
  return { dir, dbPath, ipcMain, auditLog, getDb: () => deps.getDb() };
}

test('backup:now (без парола) — не чете/копира директно живия .db файл, и round-trip: съдържанието на копието съвпада с живата база', async () => {
  const { ipcMain, dir } = setupBackup();
  const calls = { copyFileSync: [], readFileSync: [] };
  const orig = { copyFileSync: fs.copyFileSync, readFileSync: fs.readFileSync };
  fs.copyFileSync = (...a) => { calls.copyFileSync.push(String(a[0])); return orig.copyFileSync.apply(fs, a); };
  fs.readFileSync = (...a) => { calls.readFileSync.push(String(a[0])); return orig.readFileSync.apply(fs, a); };
  let result;
  try {
    result = await ipcMain.invoke('backup:now', {});
  } finally {
    fs.copyFileSync = orig.copyFileSync;
    fs.readFileSync = orig.readFileSync;
  }
  assert.equal(result.ok, true);
  const destPath = path.join(dir, 'manual-backup.db');
  assert.ok(fs.existsSync(destPath));

  // #19: нито copyFileSync, нито readFileSync трябва да са били викани С ПЪТЯ
  // на живата база — доказва, че вече не се чете суровият .db файл директно.
  const dbPathReal = path.resolve(path.join(dir, 'library.db'));
  assert.ok(!calls.copyFileSync.some(p => path.resolve(p) === dbPathReal),
    'fs.copyFileSync не бива да се вика с пътя на живата база');
  assert.ok(!calls.readFileSync.some(p => path.resolve(p) === dbPathReal),
    'fs.readFileSync не бива да се вика с пътя на живата база');

  // Реален кръгов тест: копието се отваря директно като SQLite база и
  // съдържанието му е ИДЕНТИЧНО с оригинала.
  const copy = new Database(destPath, { readonly: true });
  assert.equal(copy.prepare('SELECT v FROM t').get().v, 'оригинал-24');
  copy.close();
});

test('backup:now (с парола) — реален кръгов тест: backup → декриптиране → сравнение с оригинала', async () => {
  const { ipcMain, dir } = setupBackup();
  const calls = { readFileSync: [] };
  const origRead = fs.readFileSync;
  fs.readFileSync = (...a) => { calls.readFileSync.push(String(a[0])); return origRead.apply(fs, a); };
  let result;
  try {
    result = await ipcMain.invoke('backup:now', { password: 'таен-парол-2026' });
  } finally {
    fs.readFileSync = origRead;
  }
  assert.equal(result.ok, true);
  assert.equal(result.encrypted, true);

  const head = fs.readFileSync(result.data).subarray(0, 8).toString('utf8');
  assert.equal(head, 'INVBAK01');

  // #19: encryptBackupFile вече чете от НЕКРИПТИРАН ВРЕМЕНЕН файл (снимка от
  // db.serialize()), не от живия .db — временният файл се вижда в readFileSync
  // повикванията, но директният път на живата база — не.
  const dbPathReal = path.resolve(path.join(dir, 'library.db'));
  assert.ok(!calls.readFileSync.some(p => path.resolve(p) === dbPathReal),
    'fs.readFileSync не бива да чете директно живата база дори при криптирано копие');

  // Времменият некриптиран файл (destPath + '.plain-tmp') не бива да остава на диска.
  const leftovers = fs.readdirSync(path.join(dir, 'backups')).filter(f => f.endsWith('.plain-tmp'));
  assert.deepEqual(leftovers, [], 'временният некриптиран файл трябва да се изчиства');

  // Реалният кръгов тест: разкриптиране на съдържанието и сравнение с оригинала.
  const dec = backupCrypto.decryptBackupBuffer(result.data, 'таен-парол-2026');
  assert.equal(dec.subarray(0, 15).toString('utf8'), 'SQLite format 3');
  const decDb = new Database(dec);
  assert.equal(decDb.prepare('SELECT v FROM t').get().v, 'оригинал-24');
  decDb.close();
});

/* Регресионна защита: db.backup() (better-sqlite3) е асинхронна (Promise,
   пише на части през setImmediate) и НЕ би минала този тест — виж коментара в
   handlers/backup.js защо съзнателно е избрано db.serialize() вместо нея. */
test('autoBackupIfNeeded остава напълно синхронна — файлът съществува веднага, без await, точно както main.js я вика', () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fix24-auto-'));
  const dbPath = path.join(dir, 'library.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('авто-24');
  const ipcMain = fakeIpcMain();
  const deps = {
    app: { getPath: (n) => (n === 'temp' ? os.tmpdir() : dir), relaunch: () => {}, exit: () => {} },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    fs, path,
    getDb: () => db, setDb: () => {},
    getMainWindow: () => ({ id: 'fake' }),
    run: RUN, logAudit: () => {},
    resolveDbDir: () => dir, resolveDbPath: () => dbPath
  };
  const handlers = registerBackupHandlers(ipcMain, deps);
  handlers.autoBackupIfNeeded(); // без await — точно както main.js я вика
  const today = new Date().toISOString().slice(0, 10);
  const expected = path.join(dir, 'backups', `auto-${today}.db`);
  assert.ok(fs.existsSync(expected), 'auto-backup файлът трябва да съществува веднага, синхронно');
  const copy = new Database(expected, { readonly: true });
  assert.equal(copy.prepare('SELECT v FROM t').get().v, 'авто-24');
  copy.close();
});

/* =====================================================================
   #18 — todayEncryptedWith fast-path: повторно отключване със СЪЩАТА
   парола не бива да декриптира/прекриптира днешното копие повторно.
   ===================================================================== */

function setupBackupWithPdp() {
  /* Важно: backup-crypto се require-ва наново вътре в registerBackupHandlers
     (виж backup.js: `const { decryptBackupBuffer } = require('../backup-crypto')`
     СТАВА ВЪТРЕ във функцията, изпълнявана точно тук, при registerBackupHandlers(...)
     по-долу). Затова шпионирането трябва да е монтирано ВЕЧЕ, ПРЕДИ да се
     извика registerBackupHandlers — иначе закритата (closure) референция си
     остава сочеща към оригиналната функция и подмяната на
     backupCrypto.decryptBackupBuffer СЛЕД това не се вижда никъде (проверено:
     без тази поредност тестът минаваше дори с премахнат fast-path — не
     хващаше нищо). */
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fix24-pdp-'));
  const dbPath = path.join(dir, 'library.db');
  let db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    app: { getPath: (n) => (n === 'temp' ? os.tmpdir() : dir), relaunch: () => {}, exit: () => {} },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    fs, path,
    getDb: () => db, setDb: (v) => { db = v; },
    getMainWindow: () => ({ webContents: { send: () => {} }, isDestroyed: () => false }),
    run: RUN,
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath
  };
  const handlers = registerBackupHandlers(ipcMain, deps);
  registerPdpHandlers(ipcMain, { getDb: () => db, run: RUN, logAudit: (a, d) => auditLog.push({ action: a, detail: d }) });
  return { dir, dbPath, ipcMain, handlers, auditLog, close: () => { try { db.close(); } catch (e) { /* вече затворена */ } pii.clearSession(); } };
}

test('#18: повторно отключване със СЪЩАТА парола не декриптира повторно днешното криптирано копие (fast path)', async () => {
  // Шпионирането се монтира ПРЕДИ registerBackupHandlers (виж бележката в
  // setupBackupWithPdp) — иначе закритата референция в backup.js сочи към
  // оригиналната функция и подмяната по-долу остава невидима за нея.
  let decryptCalls = 0;
  const origDecrypt = backupCrypto.decryptBackupBuffer;
  backupCrypto.decryptBackupBuffer = (...a) => { decryptCalls++; return origDecrypt(...a); };
  let s;
  try {
    s = setupBackupWithPdp();
    const PASS = 'парола-за-теста-1';
    assert.equal((await s.ipcMain.invoke('pdp:setup', PASS)).ok, true);
    // pdp:setup вече отключи сесията и предизвика upgradeTodayAutoBackup(reason:'setup'),
    // който (тъй като още няма нищо за деня) вика autoBackupIfNeeded() — днешното
    // копие вече е криптирано и todayEncryptedWith е запомнен.
    const encPath = path.join(s.dir, 'backups', `auto-${new Date().toISOString().slice(0, 10)}.invbak`);
    assert.ok(fs.existsSync(encPath), 'днешното копие трябва вече да е криптирано');

    const callsBeforeSecondUnlock = decryptCalls;
    // Повторно "отключване" със СЪЩАТА парола (напр. библиотекарят е
    // заключил и отключил отново защитата в рамките на деня).
    const r = await s.ipcMain.invoke('pdp:unlock', PASS);
    assert.equal(r.ok, true);
    assert.equal(decryptCalls, callsBeforeSecondUnlock,
      'todayEncryptedWith вече отговаря на паролата — повторното отключване не бива да добавя нито едно ново извикване на decryptBackupBuffer (одит #18)');
  } finally {
    backupCrypto.decryptBackupBuffer = origDecrypt;
    if (s) s.close();
  }
});
