'use strict';
/* КРЪГ 45 — ПОПРАВКИТЕ В ОБЛАСТТА „СИСТЕМА, КОПИЯ, ЗАЩИТА, ОРЗД“ (v2.4.71).
   =====================================================================
   По един (или повече) тест за всяка находка С1–С19 от доклада и за частта
   на М4 в handlers/gdpr.js. Всеки тест твърди онова, което библиотекарката
   вижда — файла в папката с копията, реда в одитната следа, текста в
   диалога при старта, стойността в полето — и пада, ако поправката се върне
   (проверено при подготовката, с временно връщане на всяка поправка).

   Три вида постановка:
     • модулите поотделно (handlers/backup.js, gdpr.js, reset.js) с истинска
       SQLite база във временна папка — копия, възстановяване, прекриптиране;
     • истинският main.js в ОТДЕЛЕН ПРОЦЕС (работник — този същият файл,
       пуснат с променливата SISTEMA_V2471_WORKER) — за диалозите при старта
       (С2, С4) и за копието преди обновяване (С19), където всяко пускане е
       ново зареждане на main.js;
     • истинският main.js в този процес (test/helpers/main-app.js) — за
       заличаването по ОРЗД, настройките, следата и изтриването на всичко;
     • екранът в jsdom (test/helpers/audit-fixtures.js) — за „Настройки“. */

/* ---------------------------------------------------------------------------
   РАБОТНИК: този файл, пуснат с SISTEMA_V2471_WORKER, зарежда истинския main.js
   със заглушен electron, изпълнява стъпките от описанието и отпечатва резултата
   на ред, започващ с „@@“. Връщането най-горе е позволено в CommonJS.
--------------------------------------------------------------------------- */
if (process.env.SISTEMA_V2471_WORKER) {
  runWorker().then(
    (out) => { process.stdout.write('@@' + JSON.stringify(out) + '\n'); process.exit(0); },
    (err) => { process.stdout.write('@@' + JSON.stringify({ fatal: String(err && err.stack || err) }) + '\n'); process.exit(1); });
  return;
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const registerBackupHandlers = require('../handlers/backup');
const registerGdprHandlers = require('../handlers/gdpr');
const registerResetHandlers = require('../handlers/reset');
const pii = require('../pii-crypto');
const { isEncryptedBackup, decryptBackupBuffer } = require('../backup-crypto');
const { localToday } = require('./helpers/local-day');

const APP = path.join(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(APP, 'db', 'schema.sql'), 'utf8');

const tmpDirs = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  pii.clearSession();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* временна папка */ } }
});

/* ---------------- Постановка за handlers/backup.js ---------------- */
function fakeIpc() {
  const h = new Map();
  return { handle: (c, fn) => h.set(c, fn), invoke: (c, ...a) => h.get(c)({}, ...a) };
}
const RUN = (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } };
function backupSetup(o) {
  o = o || {};
  const dir = o.dir || mkTmp('inv-s2471-');
  const dbPath = path.join(dir, 'library.db');
  let db = o.db || new Database(dbPath);
  if (!o.db && !o.noSchema) {
    db.exec(SCHEMA);
    db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
    db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
    db.pragma('journal_mode = WAL');
    const cat = db.prepare('SELECT id FROM categories LIMIT 1').get();
    const ins = db.prepare('INSERT INTO books (inv_number, title, register_date, category_id, status) VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 1; i <= (o.books || 30); i++) {
        ins.run(i, 'Книга № ' + i + ' ' + 'х'.repeat(o.titleLen || 120), '2026-09-01', cat ? cat.id : null, 'наличен');
      }
    })();
  }
  const audit = [];
  const sent = [];
  const exits = [];
  const tempDir = mkTmp('inv-s2471-temp-');
  const deps = {
    app: { getPath: (n) => (n === 'temp' ? tempDir : dir), relaunch: () => exits.push('relaunch'), exit: (c) => exits.push('exit ' + c) },
    dialog: o.dialog || { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    fs, path,
    getDb: () => db, setDb: (v) => { db = v; },
    getMainWindow: () => ({ webContents: { send: (ch, data) => sent.push({ ch, data }) }, isDestroyed: () => false }),
    run: RUN,
    logAudit: (action, detail) => audit.push({ action, detail }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath,
    readConfig: () => ({}), updateConfig: () => true, currentSchemaVersion: 99
  };
  const ipc = fakeIpc();
  const handlers = registerBackupHandlers(ipc, deps);
  return { dir, dbPath, backupsDir: path.join(dir, 'backups'), ipc, handlers, audit, sent, exits, deps, getDb: () => db };
}
const names = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return []; } };
function countBooks(file) {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try { return d.prepare('SELECT COUNT(*) AS n FROM books').get().n; } finally { d.close(); }
}
function quick(file) {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try { return d.pragma('quick_check', { simple: true }); } finally { d.close(); }
}
function setPdp(db, password) {
  const salt = pii.generateSalt(pii.CURRENT_KDF_VERSION);
  const key = pii.deriveKey(password, salt);
  db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1').run(salt.toString('base64'), pii.makeVerifier(key));
  return key;
}

/* ===========================================================================
   С1 — аварийният екран възстановява и когато базата НЕ се отваря
   =========================================================================== */
for (const kind of ['header', 'pages']) {
  test('С1: „Възстанови това“ при ' + (kind === 'header' ? 'повредено заглавие' : 'повредени страници')
    + ' — базата се подменя с копието и минава quick_check', async () => {
    const dir = mkTmp('inv-s2471-c1-');
    const dbPath = path.join(dir, 'library.db');
    // Здрава база с 200 документа и ръчно копие — както в r1-avariyno.js на тестера.
    const s0 = backupSetup({ dir, books: 200 });
    fs.mkdirSync(s0.backupsDir, { recursive: true });
    const bak = path.join(s0.backupsDir, 'Inventar-backup-2026-09-29-10-00-00.db');
    s0.handlers.doBackupTo(bak, '');
    s0.getDb().close();
    // Повреда — точно както при тестера.
    const fd = fs.openSync(dbPath, 'r+');
    if (kind === 'header') fs.writeSync(fd, Buffer.alloc(100, 0x41), 0, 100, 0);
    else fs.writeSync(fd, Buffer.alloc(4096 * 8, 0xAB), 0, 4096 * 8, 4096 * 3);
    fs.closeSync(fd);
    // main.js е стигнал до `new Database(...)` и е спрял — връзката съществува, но гърми.
    const broken = new Database(dbPath);
    const s = backupSetup({ dir, db: broken });
    const res = await s.ipc.invoke('backup:restoreFromList', { path: bak });
    assert.equal(res.ok, true, 'аварийният екран трябва да възстанови копието, а не да каже: ' + res.error);
    assert.deepEqual(s.exits, ['relaunch', 'exit 0'], 'след подмяната програмата се стартира наново');
    assert.equal(quick(dbPath), 'ok');
    assert.equal(countBooks(dbPath), 200, 'на мястото на повредената база е копието с 200-те документа');
    assert.ok(names(s.backupsDir).some(f => f.startsWith('before-restore-')), 'повредената база е запазена настрани');
  });
}

/* ===========================================================================
   С6 — неуспешното възстановяване (зает файл) не оставя програмата без база
   =========================================================================== */
test('С6: преименуването гърми (EBUSY) → съобщението казва истината и програмата пак има работеща база', async () => {
  const s = backupSetup({ books: 12 });
  fs.mkdirSync(s.backupsDir, { recursive: true });
  const bak = path.join(s.backupsDir, 'Inventar-backup-2026-09-29-10-00-00.db');
  s.handlers.doBackupTo(bak, '');
  const orig = fs.renameSync;
  fs.renameSync = function (a, b) {
    if (String(a).endsWith('.restore-tmp')) {
      const e = new Error("EBUSY: resource busy or locked, rename '" + a + "' -> '" + b + "'"); e.code = 'EBUSY'; throw e;
    }
    return orig.apply(this, arguments);
  };
  let res;
  try { res = await s.ipc.invoke('backup:restoreFromList', { path: bak }); } finally { fs.renameSync = orig; }
  assert.equal(res.ok, false);
  assert.match(res.error, /НЕ беше извършено/);
  assert.match(res.error, /продължава да работи със СЪЩАТА база/);
  assert.deepEqual(s.exits, [], 'без рестарт — програмата продължава');
  assert.ok(s.getDb(), 'след неуспешното възстановяване програмата ИМА отворена база');
  assert.equal(s.getDb().prepare('SELECT COUNT(*) AS n FROM books').get().n, 12, 'и тя е същата база');
  // Следващото действие на екрана работи — например ръчно копие.
  const again = path.join(s.backupsDir, 'Inventar-backup-2026-09-29-10-05-00.db');
  s.handlers.doBackupTo(again, '');
  assert.equal(countBooks(again), 12);
  assert.ok(!fs.existsSync(s.dbPath + '.restore-tmp'), 'подготвеното копие не остава до базата');
});

/* ===========================================================================
   С5 — две работни места в обща папка, едно и също име на копие
   =========================================================================== */
test('С5: чужд временен файл със същото име НЕ се трие, а копието се прави', () => {
  const s = backupSetup({ books: 20 });
  fs.mkdirSync(s.backupsDir, { recursive: true });
  const dest = path.join(s.backupsDir, 'auto-2026-09-29-1700.db');
  // Другото работно място пише в момента своя временен файл със старото общо име.
  fs.writeFileSync(dest + '.tmp', 'чужд полузаписан файл');
  s.handlers.doBackupTo(dest, '');
  assert.equal(fs.readFileSync(dest + '.tmp', 'utf8'), 'чужд полузаписан файл', 'чуждият временен файл е непокътнат');
  assert.equal(quick(dest), 'ok');
  assert.equal(countBooks(dest), 20);
});

test('С5: ако преименуването гърми, а крайният файл вече е здрав — за АВТОМАТИЧНОТО копие това е успех, за ръчното — не', () => {
  const s = backupSetup({ books: 20 });
  fs.mkdirSync(s.backupsDir, { recursive: true });
  const dest = path.join(s.backupsDir, 'auto-2026-09-29-1701.db');
  s.handlers.doBackupTo(dest, '');       // „другото работно място“ вече е сложило здраво копие
  const orig = fs.renameSync;
  fs.renameSync = function (a, b) {
    if (String(b) === dest) { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; }
    return orig.apply(this, arguments);
  };
  try {
    /* Преглед на кръга (v2.4.71): приемането е само за автоматичните копия на
       обща база ({ acceptExisting: true }); ръчното копие във файл по избор на
       човека със стар здрав файл под същото име е ПРОВАЛ, не „успех“. */
    assert.doesNotThrow(() => s.handlers.doBackupTo(dest, '', { acceptExisting: true }), 'здраво копие под крайното име = денят има копие');
    assert.throws(() => s.handlers.doBackupTo(dest, ''), /EPERM/, 'ръчното копие не минава за записано върху стар файл');
  } finally { fs.renameSync = orig; }
  assert.ok(!names(s.backupsDir).some(f => f.endsWith('.tmp')), 'излишният временен файл е изчистен');
});

/* Два истински процеса — както s5b-trka.js на тестера (там: 50 от 50 провалени). */
function raceChild(dbPath, dest, n, startAt) {
  const code = `
    const fs = require('fs'), os = require('os'), path = require('path');
    const Database = require(${JSON.stringify(path.join(APP, 'node_modules', 'better-sqlite3'))});
    const reg = require(${JSON.stringify(path.join(APP, 'handlers', 'backup.js'))});
    let db = new Database(${JSON.stringify(dbPath)}); db.pragma('busy_timeout = 20000');
    const api = reg({ handle() {} }, { app: { getPath: () => os.tmpdir(), relaunch() {}, exit() {} }, dialog: {}, fs, path,
      getDb: () => db, setDb: (v) => { db = v; }, getMainWindow: () => null,
      run: (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } },
      logAudit() {}, resolveDbDir: () => ${JSON.stringify(path.dirname(dbPath))}, resolveDbPath: () => ${JSON.stringify(dbPath)} });
    const out = { ok: 0, fail: [] };
    const go = () => { for (let i = 0; i < ${n}; i++) { try { api.doBackupTo(${JSON.stringify(dest)}, '', { acceptExisting: true }); out.ok++; } catch (e) { out.fail.push(e.message.slice(0, 120)); } }
      process.stdout.write('@@' + JSON.stringify(out) + '\\n'); process.exit(0); };
    setTimeout(go, Math.max(0, ${startAt} - Date.now()));`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', code]);
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.stderr.on('data', d => { o += d; });
    p.on('exit', () => {
      const line = o.split('\n').find(l => l.startsWith('@@'));
      resolve(line ? JSON.parse(line.slice(2)) : { ok: 0, fail: ['без отговор: ' + o.slice(-300)] });
    });
  });
}
test('С5: два процеса пишат едно и също копие едновременно — всички опити успяват, копието е здраво', { timeout: 240000 }, async () => {
  // ~15 МБ — колкото базата от измерването на тестера; при малка база записите не се застъпват.
  const s = backupSetup({ books: 15000, titleLen: 400 });
  s.getDb().pragma('journal_mode = DELETE'); // обща мрежова папка — както в програмата
  s.getDb().close();
  fs.mkdirSync(s.backupsDir, { recursive: true });
  const dest = path.join(s.backupsDir, 'auto-2026-09-29.db');
  const startAt = Date.now() + 1500;
  const [a, b] = await Promise.all([raceChild(s.dbPath, dest, 8, startAt), raceChild(s.dbPath, dest, 8, startAt)]);
  assert.deepEqual([a.fail, b.fail], [[], []], 'нито един провален опит');
  assert.equal(a.ok + b.ok, 16);
  assert.equal(quick(dest), 'ok');
  assert.ok(!names(s.backupsDir).some(f => /\.tmp/.test(f)), 'без остатъци: ' + names(s.backupsDir).join(', '));
});

/* ===========================================================================
   С16 — без *.tmp-shm / *.tmp-wal до копията
   =========================================================================== */
test('С16: до автоматичните копия не остават -shm/-wal (локална база в режим WAL)', () => {
  const s = backupSetup({ books: 15 });
  assert.equal(s.getDb().pragma('journal_mode', { simple: true }), 'wal');
  s.handlers.autoBackupIfNeeded();
  s.getDb().prepare("UPDATE books SET title = 'Сменено' WHERE inv_number = 1").run();
  assert.equal(s.handlers.backupBeforeQuit(), true);
  const left = names(s.backupsDir).filter(f => /-(shm|wal)$/.test(f));
  assert.deepEqual(left, [], 'остатъци до копията: ' + left.join(', '));
  // И заварените от по-стари версии се чистят при следващото копие.
  fs.writeFileSync(path.join(s.backupsDir, 'auto-2026-01-01.db.tmp-shm'), 'x');
  fs.writeFileSync(path.join(s.backupsDir, 'auto-2026-01-01.db.tmp-wal'), 'x');
  s.getDb().prepare("UPDATE books SET title = 'Пак' WHERE inv_number = 2").run();
  fs.rmSync(path.join(s.backupsDir, 'auto-' + localToday() + '.db'));
  s.handlers.autoBackupIfNeeded();
  assert.deepEqual(names(s.backupsDir).filter(f => /\.tmp-(shm|wal)$/.test(f)), []);
});

/* С16 — всяка от защитите поотделно. Горният тест гледа само крайния резултат
   (няма -shm/-wal до копията), а до него водят ДВЕ независими неща и всяко само
   би го дало: (1) копието се записва в обикновен режим (байтове 18–19 на
   заглавието = 1, не 2 = WAL), затова проверката му изобщо не създава -shm/-wal;
   (2) проверката (sqliteProblem) маха -shm/-wal, които САМА е създала. Второто
   е за копията, които ВЕЧЕ са в режим WAL — направени от v2.4.70 и по-стари
   (или донесени отвън): при старт с празна база findStartupBackups ги проверява
   едно по едно, а отварянето на WAL-файл само за четене оставя до него -shm и
   -wal (проверено: better-sqlite3, readonly, quick_check). */
test('С16: копието е в обикновен режим, а проверката на заварено WAL-копие не оставя -shm/-wal', () => {
  const s = backupSetup({ books: 5 });
  assert.equal(s.getDb().pragma('journal_mode', { simple: true }), 'wal');
  s.handlers.autoBackupIfNeeded();
  const fresh = path.join(s.backupsDir, 'auto-' + localToday() + '.db');
  const hdr = fs.readFileSync(fresh);
  assert.deepEqual([hdr[18], hdr[19]], [1, 1], 'новото копие НЕ е в режим WAL (байтове 18–19 на заглавието)');
  // Заварено копие от по-стара версия — в режим WAL; днешното се маха, за да е то най-новото.
  const old = path.join(s.backupsDir, 'auto-2026-01-02.db');
  const w = new Database(old);
  w.pragma('journal_mode = WAL');
  w.exec('CREATE TABLE t (x)');
  w.close();
  const oh = fs.readFileSync(old);
  assert.deepEqual([oh[18], oh[19]], [2, 2], 'фикстурата: завареното копие е в режим WAL');
  fs.rmSync(fresh);
  const info = s.handlers.findStartupBackups();
  assert.equal(info.newestHealthy && info.newestHealthy.name, 'auto-2026-01-02.db', JSON.stringify(info.skipped));
  const left = names(s.backupsDir).filter(f => /-(shm|wal)$/.test(f));
  assert.deepEqual(left, [], 'проверката на завареното WAL-копие остави: ' + left.join(', '));
});

/* ===========================================================================
   С17 — отваряне и затваряне без промяна НЕ прави ново копие
   =========================================================================== */
test('С17: второ „пускане“ със сервизни записи при старта и без работа → при затваряне няма ново копие', () => {
  const s1 = backupSetup({ books: 10 });
  s1.handlers.autoBackupIfNeeded();                       // първото пускане за деня — дневното копие
  s1.getDb().close();
  const before = names(s1.backupsDir);
  // Второ пускане: main.js първо пита за часа на файла, после initDb пише сервизно.
  const db2 = new Database(s1.dbPath);
  const s2 = backupSetup({ dir: s1.dir, db: db2 });
  s2.handlers.noteDbStateBeforeOpen();
  const later = (Date.now() + 3000) / 1000;
  db2.prepare("UPDATE settings SET theme = theme WHERE id = 1").run(); // сервизен запис без смисъл за данните
  fs.utimesSync(s1.dbPath, later, later);                    // и файлът е пипнат след дневното копие
  s2.handlers.startAutoBackupTimer();                        // main.js — веднага след initDb
  s2.handlers.stopAutoBackupTimer();
  s2.handlers.autoBackupIfNeeded();                          // дневното вече го има
  assert.equal(s2.handlers.backupBeforeQuit(), false, 'нищо не е вписано — копие не се прави');
  assert.deepEqual(names(s2.backupsDir), before, 'в папката няма нов ~20-мегабайтов файл');
  // А истинската работа в сесията — прави копие.
  db2.prepare('INSERT INTO books (inv_number, title, register_date) VALUES (500, ?, ?)').run('Нова', '2026-09-29');
  assert.equal(s2.handlers.backupBeforeQuit(), true);
});

test('С17: работа от сесия без копие при затваряне (спрян ток) се хваща при следващото затваряне', () => {
  const s1 = backupSetup({ books: 10 });
  s1.handlers.autoBackupIfNeeded();
  // Работа след копието — и спрян ток: никакво копие при затваряне.
  s1.getDb().prepare('INSERT INTO books (inv_number, title, register_date) VALUES (600, ?, ?)').run('Прекъсната', '2026-09-29');
  s1.getDb().close();
  const later = (Date.now() + 3000) / 1000;
  fs.utimesSync(s1.dbPath, later, later);
  const db2 = new Database(s1.dbPath);
  const s2 = backupSetup({ dir: s1.dir, db: db2 });
  s2.handlers.noteDbStateBeforeOpen();
  s2.handlers.startAutoBackupTimer(); s2.handlers.stopAutoBackupTimer();
  assert.equal(s2.handlers.backupBeforeQuit(), true, 'работата отпреди прекъсването влиза в копие');
});

/* ===========================================================================
   С9 — работата преди отключване на защитата влиза в копие
   =========================================================================== */
test('С9: прекриптираното междинно копие пази часа на снимката, а работата отпреди отключването влиза в копие', () => {
  const PW = 'parola-za-zashtita-1';
  const s = backupSetup({ books: 10 });
  const db = s.getDb();
  const key = setPdp(db, PW);
  pii.setSession(PW, key, { reason: 'unlock' });
  s.handlers.autoBackupIfNeeded();                      // дневното — криптирано
  pii.clearSession();                                   // „Заключи“
  db.prepare('INSERT INTO books (inv_number, title, register_date) VALUES (701, ?, ?)').run('Сутрешна', '2026-09-29');
  assert.equal(s.handlers.backupBeforeQuit(), true);    // междинно — в чист текст (заключено)
  const plain = names(s.backupsDir).find(f => /^auto-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(f));
  assert.ok(plain, 'фикстурата трябва да има междинно копие в чист текст');
  const snapTime = Math.floor(fs.statSync(path.join(s.backupsDir, plain)).mtimeMs / 1000);
  // Час по-късно: работа ПРЕДИ отключването.
  const old = (Date.now() - 3600 * 1000) / 1000;
  fs.utimesSync(path.join(s.backupsDir, plain), old, old);
  db.prepare('INSERT INTO books (inv_number, title, register_date) VALUES (702, ?, ?)').run('Преди отключването', '2026-09-29');
  pii.setSession(PW, key, { reason: 'unlock' });        // отключване → прекриптиране на междинното
  const enc = plain.replace(/\.db$/, '.invbak');
  assert.ok(fs.existsSync(path.join(s.backupsDir, enc)), 'междинното е криптирано');
  assert.equal(Math.floor(fs.statSync(path.join(s.backupsDir, enc)).mtimeMs / 1000), Math.floor(old),
    'в списъка копието стои с часа на СНИМКАТА си, не с часа на прекриптирането');
  assert.notEqual(Math.floor(old), snapTime);
  assert.equal(s.handlers.backupBeforeQuit(), true, 'работата отпреди отключването влиза в копие при затваряне');
  // Най-новото копие наистина съдържа реда.
  const newest = names(s.backupsDir).filter(f => /^auto-.*\.invbak$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(s.backupsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
  const tmp = path.join(mkTmp('inv-s2471-c9-'), 'x.db');
  fs.writeFileSync(tmp, decryptBackupBuffer(path.join(s.backupsDir, newest), PW));
  const d = new Database(tmp, { readonly: true });
  assert.ok(d.prepare('SELECT 1 FROM books WHERE inv_number = 702').get(), 'редът отпреди отключването е в копието');
  d.close();
  pii.clearSession();
});

/* ===========================================================================
   С11 — картата не казва „криптират се“ при заключена защита; ръчните се броят
   =========================================================================== */
test('С11: след „Заключи“ състоянието е „заключено“ и казва, че следващото копие е в чист текст', async () => {
  const PW = 'parola-za-zashtita-2';
  const s = backupSetup({ books: 5 });
  const key = setPdp(s.getDb(), PW);
  pii.setSession(PW, key, { reason: 'unlock' });
  s.handlers.autoBackupIfNeeded();
  const on = (await s.ipc.invoke('backup:autoStatus')).data;
  assert.equal(on.state, 'encrypted');
  pii.clearSession();
  const st = (await s.ipc.invoke('backup:autoStatus')).data;
  assert.equal(st.state, 'locked', 'днешният файл е криптиран, но следващото копие няма да бъде');
  assert.match(st.warning, /ЧИСТ ТЕКСТ/);
  // Ръчно копие без парола в същата папка се брои и се назовава.
  s.handlers.doBackupTo(path.join(s.backupsDir, 'Inventar-backup-2026-09-29-11-00-00.db'), '');
  const st2 = (await s.ipc.invoke('backup:autoStatus')).data;
  assert.equal(st2.plainManualCount, 1);
  assert.match(st2.warning, /1 ръчно копие БЕЗ парола/);
});

/* ===========================================================================
   С14 — ръчното копие със СОБСТВЕНА парола не е „остана със старата парола“
   =========================================================================== */
test('С14: смяна на паролата — ръчното копие със своя парола се казва отделно, не като провал', () => {
  const OLD = 'starata-parola-33', NEW = 'novata-parola-444', OWN = 'svoya-parola-5555';
  const s = backupSetup({ books: 5 });
  const db = s.getDb();
  pii.setSession(OLD, setPdp(db, OLD), { reason: 'unlock' });
  s.handlers.autoBackupIfNeeded();
  const manual = path.join(s.backupsDir, 'Inventar-backup-2026-09-29-12-00-00.invbak');
  s.handlers.doBackupTo(manual, OWN);                   // „Направи копие“ със своя парола
  pii.setSession(NEW, setPdp(db, NEW), { reason: 'change', prevPassword: OLD });
  const bad = s.audit.filter(a => /остават със старата парола/.test(a.detail));
  assert.deepEqual(bad, [], 'ръчното копие със своя парола НЕ е „остана със старата парола“');
  assert.ok(s.audit.some(a => /СОБСТВЕНА парола/.test(a.detail) && a.detail.includes(path.basename(manual))),
    'следата казва, че то се отваря със своята парола');
  assert.ok(!s.sent.some(m => m.data && m.data.level === 'err' && /старата парола/.test(m.data.message)),
    'без червено известие за него');
  assert.doesNotThrow(() => decryptBackupBuffer(manual, OWN), 'и то не е пипано');
  pii.clearSession();
});

/* ===========================================================================
   С18 — ръчното криптирано копие иска поне 10 знака
   =========================================================================== */
test('С18: парола от 6 знака за ръчното копие се отказва, преди да се запише нещо', async () => {
  let asked = 0;
  const target = path.join(mkTmp('inv-s2471-c18-'), 'kopie.invbak');
  const s = backupSetup({ books: 3, dialog: { showSaveDialog: async () => { asked++; return { canceled: false, filePath: target }; } } });
  const r = await s.ipc.invoke('backup:now', { password: 'кратка' });
  assert.equal(r.ok, false);
  assert.match(r.error, /поне 10 знака/);
  assert.equal(asked, 0, 'диалогът за запис дори не се отваря');
  assert.ok(!fs.existsSync(target));
  const ok = await s.ipc.invoke('backup:now', { password: 'достатъчно-дълга' });
  assert.equal(ok.ok, true, ok.error);
  assert.ok(isEncryptedBackup(target));
});

/* ===========================================================================
   М4 (частта в gdpr.js) — освободената при заличаване книга стига до сайта
   =========================================================================== */
test('М4: „Забрави (ОРЗД)“ на читател със заделена книга насрочва запис на онлайн каталога', async () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const cat = db.prepare('SELECT id FROM categories LIMIT 1').get();
  const book = db.prepare('INSERT INTO books (inv_number, title, register_date, category_id, status) VALUES (1, ?, ?, ?, ?)')
    .run('Под игото', '2026-01-01', cat.id, 'наличен').lastInsertRowid;
  const rid = db.prepare("INSERT INTO readers (name, card_no, gdpr_consent) VALUES ('Здравка Тестова', '901', 1)").run().lastInsertRowid;
  db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'заделена', '2026-09-20')").run(book, rid);
  const scheduled = [];
  const ipc = fakeIpc();
  registerGdprHandlers(ipc, { getDb: () => db, run: RUN, logAudit: () => {},
    activateHoldOnReturn: () => null, scheduleCatalogWrite: (kind) => scheduled.push(kind) });
  const r = await ipc.invoke('gdpr:forgetReader', rid);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(scheduled, ['circulation'], 'наличността на сайта се обновява');
  assert.match(fs.readFileSync(path.join(APP, 'main.js'), 'utf8'),
    /require\('\.\/handlers\/gdpr'\)\(ipcMain, \{[\s\S]{0,400}scheduleCatalogWrite/, 'main.js подава зависимостта');
});

/* ===========================================================================
   С13 — копието преди „Изтриване на всички данни“ носи МЕСТНИЯ час
   =========================================================================== */
test('С13: before-reset-… в 00:40 българско време носи ДНЕШНАТА местна дата и час', async (t) => {
  const prevTz = process.env.TZ;
  process.env.TZ = 'Europe/Sofia';
  const dir = mkTmp('inv-s2471-c13-');
  const dbPath = path.join(dir, 'library.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  const made = [];
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 24, 21, 40, 5) });
  try {
    const ipc = fakeIpc();
    registerResetHandlers(ipc, {
      app: { getPath: () => dir, relaunch() {}, exit() {} }, fs, path,
      getDb: () => db, run: RUN, logAudit: () => {}, resolveDbDir: () => dir, resolveDbPath: () => dbPath,
      checkDbFile: () => null, getCurrentUser: () => 'Иванка',
      makeBackup: (dest) => { made.push(path.basename(dest)); fs.copyFileSync(dbPath, dest); }
    });
    const r = await ipc.invoke('reset:wipe', { word: 'ИЗТРИЙ' });
    assert.equal(r.ok, true, r.error);
  } finally {
    t.mock.timers.reset();
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    db.close();
  }
  assert.deepEqual(made, ['before-reset-2026-09-25-00-40-05.db']);
});

/* ===========================================================================
   Истинският main.js в отделен процес — С2, С4, С19
   =========================================================================== */
async function runWorker() {
  const cfg = JSON.parse(process.env.SISTEMA_V2471_WORKER);
  const fsW = require('fs');
  const pathW = require('path');
  const Module = require('module');
  const APPW = pathW.join(__dirname, '..');
  const stub = (id, exports) => { const m = new Module(id, null); m.filename = id; m.loaded = true; m.exports = exports; require.cache[id] = m; };
  const ud = cfg.userData;
  const tempDir = ud + '-temp';
  fsW.mkdirSync(tempDir, { recursive: true });
  const handlers = new Map(), appEvents = new Map();
  const dialogs = [], exits = [], windows = [];
  const answers = (cfg.answers || []).slice();
  let atQuitAndInstall = null;
  let catalogAtQuit = null;   // С19: колко документа има katalog.json в мига на quitAndInstall
  let readyResolve;
  const readyP = new Promise((r) => { readyResolve = r; });
  const wc = { setWindowOpenHandler() {}, on() {}, once() {}, send() {} };
  class BW {
    constructor(o) { this.opts = o; this.webContents = wc; this.loaded = null; windows.push(this); }
    setMenuBarVisibility() {} loadFile(f) { this.loaded = String(f); } isDestroyed() { return false; }
    isMinimized() { return false; } restore() {} focus() {} maximize() {} show() {} once() {}
    static getAllWindows() { return windows; }
  }
  const backupsNow = () => { try { return fsW.readdirSync(pathW.join(ud, 'backups')).sort(); } catch (e) { return []; } };
  const app = {
    isPackaged: true,
    getPath: (n) => { const p = n === 'userData' ? ud : (n === 'temp' ? tempDir : pathW.join(ud + '-p', n)); fsW.mkdirSync(p, { recursive: true }); return p; },
    getVersion: () => '2.4.71-test', isReady: () => true, requestSingleInstanceLock: () => true, whenReady: () => readyP,
    on: (ev, fn) => { if (!appEvents.has(ev)) appEvents.set(ev, []); appEvents.get(ev).push(fn); },
    exit: (c) => exits.push('exit ' + c), relaunch: () => exits.push('relaunch'), quit: () => exits.push('quit')
  };
  const dialog = {
    showMessageBoxSync: (o) => {
      const a = answers.length ? answers.shift() : (o.cancelId != null ? o.cancelId : 0);
      dialogs.push({ title: o.title, message: o.message, detail: o.detail, buttons: o.buttons, answer: a });
      return a;
    },
    showMessageBox: async () => ({ response: 0 }),
    showErrorBox: (title, detail) => dialogs.push({ title, detail, kind: 'errorBox' }),
    showSaveDialog: async () => ({ canceled: true }),
    /* cfg.openDir — папката, която „избира“ човекът (catalog:chooseFolder за С19). */
    showOpenDialog: async () => (cfg.openDir ? { canceled: false, filePaths: [cfg.openDir] } : { canceled: true, filePaths: [] })
  };
  stub(require.resolve('electron', { paths: [APPW] }), {
    app, BrowserWindow: BW, ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, dialog,
    net: { request: () => { throw new Error('без мрежа'); }, fetch: async () => { throw new Error('без мрежа'); } },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (t) => t }, webUtils: { getPathForFile: () => '' }
  });
  stub(require.resolve('electron-updater', { paths: [APPW] }), {
    autoUpdater: { on() {}, checkForUpdates: async () => ({}),
      quitAndInstall: () => {
        exits.push('quitAndInstall'); atQuitAndInstall = backupsNow();
        if (cfg.openDir) {
          try { catalogAtQuit = JSON.parse(fsW.readFileSync(pathW.join(cfg.openDir, 'katalog.json'), 'utf8')).items.length; }
          catch (e) { catalogAtQuit = 'няма katalog.json: ' + e.message; }
        }
      } }
  });
  require(pathW.join(APPW, 'main.js'));
  readyResolve();
  await readyP;
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  const invoke = async (ch, ...a) => { const fn = handlers.get(ch); if (!fn) return { ok: false, error: 'няма канал ' + ch }; return fn({}, ...a); };
  const results = [];
  for (const st of cfg.steps || []) {
    if (st.books) {
      const cats = (await invoke('categories:list')).data || [];
      const base = 1000 + Math.floor(Math.random() * 80000);   // всяко пускане — свои номера
      for (let i = 1; i <= st.books; i++) {
        results.push((await invoke('books:create', { inv_number: base + i, barcode: 'S' + (base + i), register_date: '2026-09-01',
          title: 'Книга ' + i, category_id: cats[0] && cats[0].id, price: '2', status: 'наличен' })).ok);
      }
    } else if (st.invoke) {
      results.push(await invoke(st.invoke[0], st.invoke[1]));
    } else if (st.close) {
      for (const fn of appEvents.get('window-all-closed') || []) { try { fn(); } catch (e) { results.push('close: ' + e.message); } }
    }
  }
  return { dialogs, exits, results, atQuitAndInstall, catalogAtQuit, mainWindows: windows.filter(w => /index\.html$/.test(w.loaded || '')).length,
    emergency: windows.filter(w => /invlib-restore-/.test(w.loaded || '')).length, backups: backupsNow() };
}
function worker(cfg) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [__filename], { env: Object.assign({}, process.env, { SISTEMA_V2471_WORKER: JSON.stringify(cfg) }) });
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.stderr.on('data', d => { o += d; });
    p.on('exit', () => {
      const line = o.split('\n').find(l => l.startsWith('@@'));
      if (!line) return reject(new Error('работникът не отговори: ' + o.slice(-1500)));
      const out = JSON.parse(line.slice(2));
      if (out.fatal) return reject(new Error(out.fatal));
      resolve(out);
    });
  });
}
async function seededUserData(books) {
  const ud = path.join(mkTmp('inv-s2471-ud-'), 'userData');
  fs.mkdirSync(ud, { recursive: true });
  const out = await worker({ userData: ud, steps: [{ books }, { close: true }] });
  assert.ok(out.results.slice(0, books).every(Boolean), 'фикстурата: документите са записани');
  assert.ok(out.backups.some(f => /^auto-/.test(f)), 'фикстурата: при затваряне има копие');
  return ud;
}
const booksIn = (ud) => countBooks(path.join(ud, 'library.db'));

test('С2: изтрит library.db при налични копия → въпрос „Базата не е намерена“ → най-новото здраво копие е върнато', { timeout: 120000 }, async () => {
  const ud = await seededUserData(3);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(path.join(ud, 'library.db' + s), { force: true });
  const out = await worker({ userData: ud, answers: [0] });
  const q = out.dialogs.find(d => d.title === 'Базата данни не е намерена');
  assert.ok(q, 'при старта се пита: ' + JSON.stringify(out.dialogs.map(d => d.title)));
  assert.equal(q.message, 'Базата не е намерена — да възстановя ли копие?');
  assert.equal(q.buttons[0], 'Възстанови най-новото здраво копие');
  assert.match(q.detail, /Най-новото здраво копие е „auto-/);
  assert.deepEqual(out.exits, ['relaunch', 'exit 0'], 'възстановяването рестартира програмата');
  assert.equal(out.mainWindows, 0, 'прозорецът на празната база изобщо не се отваря');
  assert.equal(booksIn(ud), 3, 'на мястото на изчезналата база е копието с трите документа');
  assert.ok(!fs.readdirSync(path.join(ud, 'backups')).some(f => f.startsWith('before-restore-')),
    'празната база НЕ става най-новият файл в папката с копията');
});

test('С2: файл с дължина 0 → „Изход“ не пипа нищо; „Започни с празна база“ се вписва в следата', { timeout: 120000 }, async () => {
  const ud = await seededUserData(2);
  for (const s of ['-wal', '-shm']) fs.rmSync(path.join(ud, 'library.db' + s), { force: true });
  fs.truncateSync(path.join(ud, 'library.db'), 0);
  const before = fs.readdirSync(path.join(ud, 'backups')).sort();
  const q1 = await worker({ userData: ud, answers: [3] });
  assert.ok(q1.dialogs.some(d => d.message === 'Базата не е намерена — да възстановя ли копие?'), 'нулевият файл се третира като изчезнал');
  assert.deepEqual(q1.exits, ['exit 0']);
  assert.equal(q1.mainWindows, 0);
  assert.deepEqual(fs.readdirSync(path.join(ud, 'backups')).sort(), before, 'в папката с копията не се е появило нищо');
  assert.ok(!fs.existsSync(path.join(ud, 'library.db')) || fs.statSync(path.join(ud, 'library.db')).size === 0,
    'празната база, създадена при старта, не остава — иначе следващото пускане би тръгнало с нея, без да пита');

  const q2 = await worker({ userData: ud, answers: [2] });
  assert.ok(q2.dialogs.some(d => d.message === 'Базата не е намерена — да възстановя ли копие?'), 'и при второто пускане се пита');
  assert.equal(q2.mainWindows, 1, 'по изричен избор програмата тръгва с празна база');
  const d = new Database(path.join(ud, 'library.db'), { readonly: true });
  const row = d.prepare("SELECT detail FROM audit_log WHERE action = 'База данни' ORDER BY id DESC").get();
  d.close();
  assert.ok(row && /По изричен избор/.test(row.detail) && /НОВА, ПРАЗНА база/.test(row.detail), 'изборът е в следата');
});

test('С4: мрежовата папка я няма → „Работи с локална база“ назовава СТАРАТА база с дата и брой, не „ПРАЗНА“', { timeout: 120000 }, async () => {
  const ud = await seededUserData(4);
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ dbFolder: path.join(ud, '..', 'nyama-takava-papka') }));
  const out = await worker({ userData: ud, answers: [2] }); // „Изход“ — важно е какво казва диалогът
  const q = out.dialogs.find(d => d.title === 'Папката с базата данни не е достъпна');
  assert.ok(q, JSON.stringify(out.dialogs.map(d => d.title)));
  assert.match(q.detail, /СТАРАТА локална база/);
  assert.match(q.detail, /4 документа във фонда/);
  assert.match(q.detail, /последна промяна на \d\d\.\d\d\.\d{4} г\./);
  assert.doesNotMatch(q.detail, /ПРАЗНА/);

  // Повреден config.json — същото обещание в другия диалог.
  fs.writeFileSync(path.join(ud, 'config.json'), '{"dbFolder": "Z:\\\\obshta", "lastUse');
  const bad = await worker({ userData: ud, answers: [0] });
  const q2 = bad.dialogs.find(d => d.title === 'Настройките на програмата не могат да бъдат прочетени');
  assert.ok(q2);
  assert.match(q2.detail, /СТАРАТА локална база/);
  assert.doesNotMatch(q2.detail, /ПРАЗНА/);
});

test('С4: без локален файл диалогът честно казва „НОВА, ПРАЗНА“', { timeout: 60000 }, async () => {
  const ud = path.join(mkTmp('inv-s2471-ud-'), 'userData');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ dbFolder: path.join(ud, '..', 'nyama') }));
  const out = await worker({ userData: ud, answers: [2] });
  const q = out.dialogs.find(d => d.title === 'Папката с базата данни не е достъпна');
  assert.match(q.detail, /НОВА, ПРАЗНА локална база/);
});

test('С17 (истинският main.js): пускане и затваряне без работа не оставя ново копие; с работа — оставя', { timeout: 180000 }, async () => {
  const ud = await seededUserData(2);                     // първо пускане: работа и копие при затваряне
  const first = fs.readdirSync(path.join(ud, 'backups')).filter(f => /\.(db|invbak)$/.test(f)).sort();
  const idle = await worker({ userData: ud, steps: [{ close: true }] });
  assert.deepEqual(idle.backups.filter(f => /\.(db|invbak)$/.test(f)), first,
    'отваряне и затваряне без нито едно действие — в папката няма нов файл (дотук: ново ~20-МБ копие всеки път)');
  const idle2 = await worker({ userData: ud, steps: [{ close: true }] });
  assert.deepEqual(idle2.backups.filter(f => /\.(db|invbak)$/.test(f)), first, 'и при второто празно пускане');
  const work = await worker({ userData: ud, steps: [{ books: 1 }, { close: true }] });
  assert.equal(work.results[0], true, 'фикстурата: документът е записан');
  assert.ok(work.backups.some(f => /^auto-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(f)), 'истинската работа влиза в копие при затваряне');
});

test('С19: „Инсталирай и рестартирай“ прави копие ПРЕДИ quitAndInstall', { timeout: 60000 }, async () => {
  const ud = path.join(mkTmp('inv-s2471-ud-'), 'userData');
  fs.mkdirSync(ud, { recursive: true });
  const out = await worker({ userData: ud, steps: [{ books: 2 }, { invoke: ['app:installUpdate'] }] });
  assert.ok(out.exits.includes('quitAndInstall'), JSON.stringify(out.exits));
  assert.ok((out.atQuitAndInstall || []).includes('auto-' + localToday() + '.db'),
    'в мига на quitAndInstall копието вече е в папката: ' + JSON.stringify(out.atQuitAndInstall));
});

/* С19 (сглобяване): насроченият запис на онлайн каталога също стига до
   katalog.json ПРЕДИ quitAndInstall. Папката на каталога е свързана при празен
   фонд (първият запис: 0 документа), после се вписват две книги — записът им е
   само НАСРОЧЕН (4 s), — и веднага „Инсталирай и рестартирай“. Без
   `if (catalogWriteDebouncer.pending()) flushCatalogWrite();` в app:installUpdate
   програмата излиза със стария файл (0 документа), а сайтът показва фонд без
   последните вписвания до следващото пускане на вече обновената програма. */
test('С19: „Инсталирай и рестартирай“ записва и насрочения katalog.json преди quitAndInstall', { timeout: 60000 }, async () => {
  const ud = path.join(mkTmp('inv-s2471-ud-'), 'userData');
  fs.mkdirSync(ud, { recursive: true });
  const kat = mkTmp('inv-s2471-kat-');
  const out = await worker({ userData: ud, openDir: kat,
    steps: [{ invoke: ['catalog:chooseFolder'] }, { books: 2 }, { invoke: ['app:installUpdate'] }] });
  assert.equal(out.results[0] && out.results[0].ok, true, 'папката на каталога е свързана: ' + JSON.stringify(out.results[0]));
  assert.ok(out.exits.includes('quitAndInstall'), JSON.stringify(out.exits));
  assert.equal(out.catalogAtQuit, 2, 'в мига на quitAndInstall katalog.json вече носи двете нови книги');
});

/* ===========================================================================
   Истинският main.js в ТОЗИ процес — С3, С8, С10, С12, С15
   =========================================================================== */
const { startMainApp } = require('./helpers/main-app');
let MAIN = null;
async function main() {
  if (MAIN) return MAIN;
  MAIN = startMainApp();
  await MAIN.ready();
  await MAIN.invoke('app:setUser', 'Иванка Служителска');
  return MAIN;
}
test.after(() => { if (MAIN) MAIN.stop(); });
const ok = (r, what) => { assert.equal(r && r.ok, true, what + ': ' + (r && r.error)); return r.data; };
function liveDb(h) { return new Database(path.join(h.userData, 'library.db')); }

test('С3: „Забрави (ОРЗД)“ обезличава и старото име, „(карта N)“, запазения PDF и търсенията по телефон/карта/фамилия — и брои вярно', async () => {
  const h = await main();
  const today = localToday();
  const cats = ok(await h.invoke('categories:list'), 'видове');
  const bookId = ok(await h.invoke('books:create', { inv_number: 71, barcode: 'G71', register_date: '2026-09-01',
    title: 'Тютюн', category_id: cats[0].id, price: '3', status: 'наличен' }), 'книга');
  const bid = typeof bookId === 'object' ? bookId.id : bookId;
  const rid = ok(await h.invoke('readers:create', { name: 'Мария Иванова', card_no: '27', phone: '0888000111',
    category: 'възрастен', gdpr_consent: 1, gdpr_consent_date: today, registered_at: today }), 'читател');
  // Друг читател със същата фамилия — неговото НЕ се пипа.
  ok(await h.invoke('readers:create', { name: 'Иван Иванов', card_no: '3', phone: '0877123456',
    category: 'възрастен', gdpr_consent: 1, gdpr_consent_date: today, registered_at: today }), 'друг читател');
  const loan = ok(await h.invoke('loans:checkout', { reader_id: rid, book_id: bid, date_out: '2026-08-01', date_due: '2026-08-22' }), 'заемане');
  ok(await h.invoke('loans:return', { id: loan.id || loan, date_in: '2026-08-20' }), 'връщане');
  ok(await h.invoke('searchHistory:log', { kind: 'readers', query: 'Мария Иванова' }), 'търсене');
  // Брак: смяна на фамилията и телефона — през обработчика, както я праща формата.
  const full = ok(await h.invoke('readers:get', rid), 'картон');
  ok(await h.invoke('readers:update', Object.assign({}, full, { name: 'Мария Петрова', phone: '0899111222' })), 'редакция');
  for (const q of ['Петрова', '0899 111 222', '27', 'Иванов']) ok(await h.invoke('searchHistory:log', { kind: 'readers', query: q }), 'търсене');
  ok(await h.invoke('searchHistory:log', { kind: 'books', query: 'Петрова' }), 'търсене на автор');
  // „Запазен PDF“ — редът, който handlers/print.js вписва при запис на картона в PDF.
  const db = liveDb(h);
  db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('Иванка Служителска', 'Запазен PDF', ?)")
    .run('/home/biblioteka/Документи/Читателски картон — Мария Петрова.pdf');
  const snapshot = () => db.prepare('SELECT id, detail, diff FROM audit_log ORDER BY id').all();
  const before = snapshot();

  const r = ok(await h.invoke('gdpr:forgetReader', rid), 'заличаване');
  const after = snapshot();
  const changed = after.filter(a => { const b = before.find(x => x.id === a.id); return b && (b.detail !== a.detail || b.diff !== a.diff); }).length;
  assert.equal(r.auditCleared, changed, 'отговорът брои точно пипнатите редове');

  const leftovers = db.prepare(`SELECT action, detail, diff FROM audit_log
      WHERE instr(detail, 'Мария Иванова') > 0 OR instr(detail, 'Мария Петрова') > 0
         OR instr(COALESCE(diff, ''), 'Иванова') > 0 OR instr(COALESCE(diff, ''), '0888000111') > 0
         OR instr(detail, '(карта 27)') > 0 OR instr(detail, 'карта 27 —') > 0`).all();
  assert.deepEqual(leftovers, [], 'в следата не остава нищо от читателката');
  const pdf = db.prepare("SELECT detail FROM audit_log WHERE action = 'Запазен PDF'").get().detail;
  assert.equal(pdf, '/home/biblioteka/Документи/Читателски картон — [анонимизиран читател].pdf', 'видът на документа остава, името — не');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE detail LIKE 'инв. № 71 — Тютюн%'").get(), 'заемането остава в следата без читателя');
  const hist = db.prepare('SELECT kind, query FROM search_history ORDER BY id').all();
  db.close();
  assert.deepEqual(hist.filter(x => x.kind === 'readers').map(x => x.query), ['Иванов'], 'търсенията по старо име, фамилия, телефон и карта са изтрити; чуждата фамилия остава');
  assert.ok(hist.some(x => x.kind === 'books' && x.query === 'Петрова'), 'търсене на автор в „Книги“ не се пипа');
  assert.equal(r.searchCleared, 4);
  assert.ok(ok(await h.invoke('readers:list', ''), 'списък').some(x => x.name === 'Иван Иванов'), 'другият читател е непокътнат');
});

test('С8: „Фонд на свободен достъп (%)“ — „40,5“ е 40,5, а 405 се отказва, без да се пипне нищо', async () => {
  const h = await main();
  const s = ok(await h.invoke('settings:get'), 'настройки');
  const good = Object.assign({}, s, { free_access_pct: '40,5' });
  ok(await h.invoke('settings:update', good), 'запис');
  assert.equal(ok(await h.invoke('settings:get'), 'настройки').free_access_pct, 40.5);
  const bad = await h.invoke('settings:update', Object.assign({}, s, { free_access_pct: 405, loan_days: 7 }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /между 0 и 100/);
  const s2 = ok(await h.invoke('settings:get'), 'настройки');
  assert.equal(s2.free_access_pct, 40.5, 'процентът не е станал 405');
  assert.equal(s2.loan_days, s.loan_days, 'и нищо друго от същия запис не е записано');
});

test('С10: „Редакция на настройки“ носи преди/след за срока, забавата и следващия инв. №', async () => {
  const h = await main();
  const s = ok(await h.invoke('settings:get'), 'настройки');
  const prevLoan = s.loan_days, prevNext = s.next_inv_number;
  ok(await h.invoke('settings:update', Object.assign({}, s, { loan_days: 21, fine_per_day: '0,15', next_inv_number: 555 })), 'запис');
  const db = liveDb(h);
  const row = db.prepare("SELECT detail, diff FROM audit_log WHERE action = 'Редакция на настройки' ORDER BY id DESC").get();
  db.close();
  const diff = JSON.parse(row.diff);
  const f = (k) => diff.find(d => d.field === k);
  assert.deepEqual([f('loan_days').before, f('loan_days').after], [prevLoan, 21]);
  assert.equal(f('fine_per_day').after, 0.15);
  assert.deepEqual([f('next_inv_number').before, f('next_inv_number').after], [prevNext, 555]);
  assert.match(row.detail, /Срок за заемане \(дни\) \S+ → 21/);
  assert.match(row.detail, /Следващ инвентарен номер \S+ → 555/);
});

test('С12: търсене в следата по датата, както я вижда човек („ДД.ММ“)', async () => {
  const h = await main();
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const shown = pad(d.getDate()) + '.' + pad(d.getMonth() + 1);
  const rows = ok(await h.invoke('audit:list', shown), 'търсене');
  assert.ok(rows.length > 0, 'днешните редове се намират по „' + shown + '“');
  const visible = d.toLocaleString('bg-BG').split(',')[0];         // „29.09.2026 г.“ / „4.09.2026 г.“
  assert.ok(ok(await h.invoke('audit:list', visible), 'търсене').length > 0, 'и по пълната дата от екрана');
  assert.equal(ok(await h.invoke('audit:list', '31.02'), 'търсене').length, 0, 'несъществуваща дата — нищо');
});

test('С15: прозорецът за изтриване казва „N документа“, не сбора от книги и инвентар', async () => {
  const h = await main();
  const db = liveDb(h);
  const books = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
  const inv = db.prepare('SELECT COUNT(*) AS n FROM inventory').get().n;
  db.close();
  const p = ok(await h.invoke('reset:plan'), 'план');
  const fund = p.groups.find(g => g.group === 'Фонд');
  assert.ok(inv > 0, 'фикстурата: инвентарът има редове');
  assert.equal(fund.main, books);
  assert.match(fund.text, new RegExp('^' + books + ' (документ|документа)'));
  assert.equal(fund.rows > books, true, 'редовете в базата наистина са повече — затова числото беше двойно');
});

/* ===========================================================================
   Екранът „Настройки“ в jsdom — С2 (бележката), С7, С8, С12 (CSV), С15, С18
   =========================================================================== */
const { cleanupTmpDirs, buildDom, settle } = require('./helpers/audit-fixtures');
test.after(cleanupTmpDirs);
const SETTINGS_MOCK = {
  'settings.get': { org: 'НЧ Тест', lib_name: 'Библиотека', place: 'с. Т', director: 'Стар Председател', loan_days: 30,
    max_books: 5, next_inv_number: 12, committee1: 'А', theme: '1', free_access_pct: 60 },
  'dbLocation.get': { folder: 'C:\\x', isDefault: true },
  'backup.list': [], 'employees.list': [{ id: 1, name: 'Мария', active: 1 }],
  'categories.list': [], 'limits.usage': { books: 0, readers: 0, loans: 0, limitBooks: 0, limitReaders: 0 },
  'pdp.status': { configured: false, unlocked: false }, 'calendar.get': { workDays: [1, 2, 3, 4, 5], closed: [] },
  'circRules.list': [], 'gdpr.candidates': { years: 0, count: 0 }, 'backup.autoStatus': null,
  'av.categories': {}, 'av.options': {}, 'settings.noticeDefaults': { placeholders: [] }, 'app.getUser': 'Мария'
};
async function openSetup(over) {
  const dom = buildDom(Object.assign({}, SETTINGS_MOCK, over || {}));
  await settle();
  dom.window.location.hash = '#setup';
  await dom.window.route();
  await settle();
  return dom;
}
const toasts = (w) => [...w.document.querySelectorAll('#toasts > *, .toast')].map(x => x.textContent);

test('С7: събития за обновяване и смяна на темата НЕ изтриват написаното в „Настройки“', async () => {
  let updateCb = null;
  const dom = await openSetup({ 'app.onUpdateStatus': (args) => { updateCb = args[0]; return null; } });
  const w = dom.window, d = w.document;
  if (!updateCb && typeof w.initAutoUpdateUI === 'function') { w.initAutoUpdateUI(); await settle(); }
  assert.equal(typeof updateCb, 'function', 'екранът слуша за обновяване');
  d.querySelector('#view [name="director"]').value = 'Нов председател';
  d.querySelector('#view [name="place"]').value = 'гр. Нов град (незаписано)';
  updateCb({ state: 'checking' });
  updateCb({ state: 'available', version: '2.4.72' });
  for (let p = 5; p <= 25; p += 10) updateCb({ state: 'downloading', percent: p });
  await settle();
  assert.equal(d.querySelector('#view [name="director"]').value, 'Нов председател', 'написаното остава');
  assert.match(d.getElementById('updBox').textContent, /25%/, 'а картата „Обновяване“ показва хода');
  await w.setTheme('5');
  await settle();
  assert.equal(d.querySelector('#view [name="place"]').value, 'гр. Нов град (незаписано)', 'темата не пречертава формата');
  assert.match(d.querySelector('.themeSw[data-theme-id="5"]').textContent, /✓/, 'отметката е върху новата тема');
  assert.doesNotMatch(d.querySelector('.themeSw[data-theme-id="1"]').textContent, /✓/);
  w.close();
});

test('С8: полето „Фонд на свободен достъп (%)“ чете запетаята и спира над 100 още на екрана', async () => {
  const dom = await openSetup();
  const w = dom.window, d = w.document;
  const el = d.querySelector('#view [name="free_access_pct"]');
  assert.ok(el.hasAttribute('data-decimal'), 'decField, не type="number"');
  el.value = '62,5';
  await w.saveSetup();
  await settle();
  const sent = dom.calls['settings.update'] || [];
  assert.equal(sent.length, 1);
  assert.equal(Number(sent[0].free_access_pct), 62.5, '„62,5“ стига до обработчика като 62,5, не 625');
  el.value = '405';
  await w.saveSetup();
  await settle();
  assert.equal((dom.calls['settings.update'] || []).length, 1, '405 % не се праща');
  w.close();
});

test('С2: първоначалната настройка при налични копия казва колко са и откъде се възстановява', async () => {
  const dom = await openSetup({
    'settings.get': { theme: '1' },
    'backup.list': [{ name: 'auto-2026-09-28.db', path: '/x/auto-2026-09-28.db', mtime: Date.parse('2026-09-28T15:00:00Z'), size: 5e6, auto: 1 },
      { name: 'auto-2026-09-27.db', path: '/x/auto-2026-09-27.db', mtime: Date.parse('2026-09-27T15:00:00Z'), size: 5e6, auto: 1 }]
  });
  const note = dom.window.document.getElementById('setupBackupsNote');
  assert.ok(note, 'бележката за копията е на екрана');
  assert.match(note.textContent, /2 копия/);
  assert.match(note.textContent, /Възстанови/);
  dom.window.close();
});

test('С12: CSV на одитната следа има колона „Преди/след“ с текста от екрана', async () => {
  const dom = buildDom({
    'audit.list': [], 'audit.export': [{ ts: '2026-09-29 10:00:00', user: 'Иванка', action: 'Редакция на читател',
      detail: 'карта 7 — Петър', diff: JSON.stringify([{ field: 'phone', before: '0888', after: '0899' }]) }]
  });
  const w = dom.window;
  await settle();
  let blob = null;
  w.URL.createObjectURL = (b) => { blob = b; return 'blob:proba'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {};
  await w.exportAuditCSV();
  const text = await blob.text();
  const lines = text.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], 'Дата/час;Служител;Действие;Подробност;Преди/след');
  assert.match(lines[1], /;"Телефон: 0888 → 0899"$/);
  w.close();
});

test('С15: прозорецът „Изтриване на всички данни“ показва текста на групата', async () => {
  const dom = buildDom({ 'reset.plan': { word: 'ИЗТРИЙ', groups: [{ group: 'Фонд', rows: 60, main: 30,
    text: '30 документа (общо 60 реда в базата, заедно със свързаните записи)' }], keep: [], totalRows: 60, library: {} } });
  const w = dom.window;
  await settle();
  await w.resetAllForm();
  await settle();
  const t = w.document.querySelector('#modal').textContent.replace(/\s+/g, ' ');
  assert.match(t, /Фонд — 30 документа/);
  assert.doesNotMatch(t, /Фонд — 60 записа/);
  w.close();
});

test('С18: екранът спира парола под 10 знака за ръчното копие, без да вика обработчика', async () => {
  const dom = await openSetup();
  const w = dom.window, d = w.document;
  w.backupNowForm();
  await settle();
  d.getElementById('bkEnc').checked = true;
  d.querySelector('#bkF [name="password"]').value = 'кратка';
  d.querySelector('#bkF [name="password2"]').value = 'кратка';
  await w.backupNow();
  await settle();
  assert.equal((dom.calls['backup.now'] || []).length, 0);
  w.close();
});
