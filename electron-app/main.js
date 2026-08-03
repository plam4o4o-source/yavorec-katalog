const { app, BrowserWindow, ipcMain, dialog, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');
const importers = require('./importers');
const { ftsQuery, BOOKS_FTS_SETUP_SQL, READERS_FTS_SETUP_SQL } = require('./search-fts');
const { applyEnumTriggers } = require('./db/enum-triggers');
const { createDebouncer } = require('./debounce');
const { csvCell, isValidEmail } = require('./security-utils');
const { autoUpdater } = require('electron-updater');

let db;
let CURRENT_USER = '';

// Фиксиран курс на БНБ, същият като в интерфейса.
const EUR_RATE = 1.95583;

/* ---------------- Постоянен дневник на грешки (за диагностика от разстояние) ----------------
   Пакетираната програма няма видима конзола за библиотекаря — досега всяка грешка,
   съобщена само с console.error, изчезваше безследно. Тук всичко, минало през
   console.error/console.warn, се записва и във файл в потребителската папка, плюс
   необработените изключения/promise-и, които иначе биха убили процеса без следа.
   Ротация: един файл на ден (log-YYYY-MM-DD.txt), пазят се последните LOG_KEEP_DAYS. */
const LOG_KEEP_DAYS = 30;
function logsDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function logToFile(level, args) {
  try {
    if (!app.isReady()) return; // да не пипаме fs пътища, зависещи от userData, преди 'ready'
    const dir = logsDir();
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `log-${day}.txt`);
    const text = args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
    fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${text}\n`, 'utf8');
  } catch (e) { /* ако дори логът гръмне, няма какво повече да направим тук */ }
}
function pruneOldLogs() {
  try {
    const dir = logsDir();
    const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^log-(\d{4}-\d{2}-\d{2})\.txt$/);
      if (!m) continue;
      if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) fs.unlinkSync(path.join(dir, name));
    }
  } catch (e) { /* почистването на стари логове никога не бива да пречи на стартирането */ }
}
const _origConsoleError = console.error.bind(console);
const _origConsoleWarn = console.warn.bind(console);
console.error = (...args) => { _origConsoleError(...args); logToFile('ERROR', args); };
console.warn = (...args) => { _origConsoleWarn(...args); logToFile('WARN', args); };
process.on('uncaughtException', (err) => {
  console.error('Необработена грешка в програмата (uncaughtException):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Необработено отхвърляне на promise (unhandledRejection):', reason);
});

/* ---------------- Местоположение на базата данни (за работа в мрежа) ----------------
   Малък config.json в постоянната потребителска папка сочи къде реално живее
   library.db — по подразбиране до самата програма/userData, но може да бъде
   и папка на мрежов диск, споделена от няколко работни компютъра. */
function configPath() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'config.json');
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) { return {}; }
}
function writeConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}
function defaultDbDir() {
  return app.isPackaged ? app.getPath('userData') : path.join(__dirname, 'db');
}
function resolveDbDir() {
  const cfg = readConfig();
  if (cfg.dbFolder && fs.existsSync(cfg.dbFolder)) return cfg.dbFolder;
  return defaultDbDir();
}
function resolveDbPath() {
  const dir = resolveDbDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'library.db');
}

// CREATE TABLE IF NOT EXISTS в schema.sql не пипа таблица, която вече съществува —
// затова колони, добавени в по-нова версия на програмата, трябва изрично да се
// добавят и към вече съществуваща база данни (иначе UPDATE/SELECT към тях гърми
// с "no such column" в стари, вече инсталирани бази). table/columns са фиксирани
// литерали в кода (не потребителски вход), затова е безопасно да се сглобяват в SQL.
function ensureColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
  for (const [name, ddl] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

/* Ключ за сортиране на сигнатури: числата се допълват с нули отпред, така че
   „Ч-9" да се нареди преди „Ч-84" (като числа), а не след него (като текст). */
function cnSortKey(s) {
  return String(s || '').toUpperCase().trim().replace(/\d+/g, m => m.padStart(6, '0'));
}
/* Засява номенклатура (authorised_values), ако категорията е празна: първо
   стандартният списък, после и стойностите, които вече се срещат в books —
   така падащото меню не губи нищо от съществуващите данни. */
function seedAuthorisedValues(category, defaults) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM authorised_values WHERE category = ?').get(category).n;
  if (n > 0) return;
  const field = { department: 'department', language: 'language', location: 'department' }[category];
  const existing = category === 'location' ? [] :
    db.prepare(`SELECT DISTINCT ${field} AS v FROM books WHERE ${field} IS NOT NULL AND TRIM(${field}) <> ''`).all().map(r => r.v);
  const values = [...defaults];
  for (const v of existing) if (!values.includes(v)) values.push(v);
  const ins = db.prepare('INSERT OR IGNORE INTO authorised_values (category, value, sort) VALUES (?, ?, ?)');
  db.transaction(() => values.forEach((v, i) => ins.run(category, v, i)))();
}

function initDb() {
  const dbPath = resolveDbPath();
  const isNew = !fs.existsSync(dbPath);
  const isNetwork = !!readConfig().dbFolder; // персонализирана папка — обичайно мрежов диск
  db = new Database(dbPath);
  // WAL разчита на споделена памет (mmap) между процесите, която не работи надеждно през
  // мрежови дялове (SMB/CIFS) — там rollback journal (DELETE) е по-безопасният избор по
  // документацията на SQLite. По-дългият busy_timeout дава повече време за изчакване вместо
  // веднага да гърми "database is locked", когато няколко компютъра пишат почти едновременно.
  db.pragma(isNetwork ? 'journal_mode = DELETE' : 'journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = ' + (isNetwork ? 20000 : 8000));

  // fs.readFileSync reads transparently through app.asar for plain text files,
  // so the same path works both in dev and in a packaged build.
  const schemaSql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  ensureColumns('settings', {
    lbl_mode: "TEXT DEFAULT 'sheet'",
    lbl_w: 'INTEGER DEFAULT 40',
    lbl_h: 'INTEGER DEFAULT 30',
    lbl_cols: 'INTEGER DEFAULT 3',
    lbl_gap: 'REAL DEFAULT 3',
    lbl_margin: 'REAL DEFAULT 8',
    lbl_border: 'INTEGER DEFAULT 1',
    sig_w: 'INTEGER DEFAULT 25',
    sig_h: 'INTEGER DEFAULT 35',
    card_w: 'INTEGER DEFAULT 90',
    card_h: 'INTEGER DEFAULT 60',
    logo: 'TEXT',
    theme: "TEXT DEFAULT '1'",
    catalog_folder: 'TEXT',
    gh_user: 'TEXT',
    gh_repo: 'TEXT',
    gh_branch: "TEXT DEFAULT 'main'",
    limit_books: 'INTEGER DEFAULT 0',
    limit_readers: 'INTEGER DEFAULT 0'
  });

  ensureColumns('loans', {
    renewals: 'INTEGER DEFAULT 0'
  });

  ensureColumns('readers', {
    guarantor_name: 'TEXT',
    guarantor_relation: 'TEXT',
    guarantor_phone: 'TEXT'
  });

  ensureColumns('settings', {
    notice_subject: 'TEXT',
    notice_body: 'TEXT',
    notice_sms: 'TEXT',
    sru_endpoint: 'TEXT',
    suspend_per_day: 'REAL DEFAULT 0',
    suspend_max: 'INTEGER DEFAULT 90',
    remind2_days: 'INTEGER DEFAULT 14',
    remind3_days: 'INTEGER DEFAULT 30',
    anonymize_years: 'INTEGER DEFAULT 0'
  });

  ensureColumns('books', {
    status_date: 'TEXT',
    datelastseen: 'TEXT',
    permanent_location: 'TEXT',
    cn_sort: 'TEXT'
  });

  ensureColumns('readers', {
    gdpr_consent_date: 'TEXT',
    parent_consent_date: 'TEXT',
    suspended_until: 'TEXT'
  });

  ensureColumns('loans', {
    anon_category: 'TEXT'
  });

  ensureColumns('readers', {
    alert_note: 'TEXT'
  });

  ensureColumns('settings', {
    work_days: "TEXT DEFAULT '0,1,2,3,4,5,6'"
  });

  ensureColumns('audit_log', {
    diff: 'TEXT'
  });

  // Еднократни попълвания на новите колони от вече наличните данни. Условието
  // "IS NULL" ги прави безвредни при всяко следващо стартиране.
  // datelastseen — от сканиранията на минали инвентаризации (сурови данни има отдавна).
  db.exec(`UPDATE books SET datelastseen = (
    SELECT MAX(sc.scanned_at) FROM inventory_session_scans sc WHERE sc.book_id = books.id
  ) WHERE datelastseen IS NULL AND EXISTS (
    SELECT 1 FROM inventory_session_scans sc WHERE sc.book_id = books.id)`);
  // cn_sort — от съществуващите сигнатури.
  const noCn = db.prepare(`SELECT id, call_number FROM books
    WHERE cn_sort IS NULL AND call_number IS NOT NULL AND TRIM(call_number) <> ''`).all();
  if (noCn.length) {
    const upd = db.prepare('UPDATE books SET cn_sort = ? WHERE id = ?');
    db.transaction(() => noCn.forEach(b => upd.run(cnSortKey(b.call_number), b.id)))();
  }
  // Датирани съгласия — при вече отбелязано съгласие без дата се записва датата на
  // регистрация: най-добрата налична долна граница, по-честна от днешната дата.
  db.exec(`UPDATE readers SET gdpr_consent_date = COALESCE(registered_at, date('now'))
    WHERE gdpr_consent = 1 AND gdpr_consent_date IS NULL`);
  db.exec(`UPDATE readers SET parent_consent_date = COALESCE(registered_at, date('now'))
    WHERE parent_consent = 1 AND parent_consent_date IS NULL`);
  // Номенклатури — при празна категория се засява от познатите списъци плюс
  // стойностите, които вече се срещат из фонда (за да не изчезне нищо от менютата).
  seedAuthorisedValues('department', ['за възрастни', 'за деца', 'краеведски', 'справочен', 'периодика', 'служебен']);
  seedAuthorisedValues('language', ['български', 'руски', 'английски', 'немски', 'френски', 'друг']);
  seedAuthorisedValues('location', []);

  // Еднократна поправка на данни, внесена от версии 1.7.0 – 1.7.3: тогава миграция
  // презаписваше населеното място на „с. Яворец, обл. Габрово“ по погрешното
  // допускане, че селото е в община Севлиево (то е в община Габрово, ЕКАТТЕ 87120).
  // Условието е за точно тази стойност, затова не засяга никоя друга библиотека.
  // Може да отпадне, след като всички инсталации минат през версия 1.7.4 или по-нова.
  db.prepare("UPDATE settings SET place = 'с. Яворец, общ. Габрово' WHERE id = 1 AND place = 'с. Яворец, обл. Габрово'").run();

  runMigrations();

  if (isNew) console.log('Нова база данни създадена на:', dbPath);
}

/* ---------------- Версия на схемата (PRAGMA user_version) ----------------
   От тук нататък всяка НОВА промяна по схемата (нова колона/таблица, еднократно
   попълване на данни) се регистрира по-долу в MIGRATIONS вместо да се добавя
   свободно в initDb(). Всяка миграция се изпълнява точно веднъж, в транзакция,
   по нарастващ номер на версия; изпълнените версии се пазят в PRAGMA user_version,
   така че при следващо стартиране да е ясно кое вече е приложено.

   По-старите блокове ensureColumns()/UPDATE по-горе в initDb() НЕ са прекодирани
   в миграции — те вече са изпълнени във всички съществуващи инсталации и остават
   само като мост за тях (безвредни са, защото са идемпотентни). CURRENT_SCHEMA_VERSION
   просто маркира "всичко познато досега е приложено" за база данни, която стига дотук
   без нито една регистрирана миграция по-долу (напр. чисто нова инсталация). */
const CURRENT_SCHEMA_VERSION = 5;
const MIGRATIONS = [
  // v2 — колони за защита на ЕГН/№ ЛК на читателите с обща парола (виж
  // "Защита на лични данни" по-долу): pdp_salt (сол за извеждане на ключа) и
  // pdp_verifier (криптиран известен низ, за проверка на паролата).
  { version: 2, run: () => { ensureColumns('settings', { pdp_salt: 'TEXT', pdp_verifier: 'TEXT' }); } },
  // v3 — FTS5 индекси за търсене по книги (title/subtitle/author) и читатели
  // (name), с unicode61 токенайзер: решава едновременно пълното сканиране при
  // всяко търсене и дефекта, че кирилицата не се сгъва по регистър в LIKE
  // ("белият" не намираше "Белият"). Виж search-fts.js за подробности.
  { version: 3, run: () => { db.exec(BOOKS_FTS_SETUP_SQL); db.exec(READERS_FTS_SETUP_SQL); } },
  // v4 — два допълнителни индекса (Фаза 4, "евтини поправки" от анализа):
  // books.barcode нямаше никакъв индекс, въпреки че books:byBarcode и
  // сканирането от таблото търсят точно по него при всяко сканиране на
  // баркод; loans(book_id, date_in) е композитен индекс за най-честата
  // проверка "тази книга заета ли е в момента" (използва се в BOOK_SELECT
  // за ВСЕКИ ред от списъка с книги — коренна причина за забавяне при
  // голям фонд). Нарочно БЕЗ UNIQUE на barcode: съществуващи инсталации
  // може вече да имат дублирани/празни баркодове от по-стари данни или
  // ръчно въведени грешки — добавянето на UNIQUE constraint би счупило
  // миграцията (и оттам — стартирането на програмата) на всяка база с
  // такъв дубликат, без предварителна проверка/почистване на данните.
  // Истинското UNIQUE изисква отделна стъпка за откриване и решаване на
  // дублиращите се баркодове от библиотекаря, не тихо налагане тук.
  { version: 4, run: () => {
    db.exec('CREATE INDEX IF NOT EXISTS idx_books_barcode ON books(barcode)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_loans_book_open ON loans(book_id, date_in)');
  } },
  // v5 — "CHECK/authority на enum-подобните TEXT колони" (последната точка от
  // "евтините поправки" на анализа за Фаза 4). Логиката е в db/enum-triggers.js
  // (вижте там пълния коментар защо са тригери, а не истински CHECK constraint,
  // и списъка на изрично изключените колони) — изнесена в отделен модул, за да
  // може и тестовете да прилагат абсолютно същите тригери върху собствената си
  // тестова база, по образец на BOOKS_FTS_SETUP_SQL/READERS_FTS_SETUP_SQL.
  { version: 5, run: () => { applyEnumTriggers(db); } }
];
function runMigrations() {
  const from = db.pragma('user_version', { simple: true });
  const pending = MIGRATIONS.filter(m => m.version > from).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.transaction(() => {
      m.run();
      db.pragma('user_version = ' + m.version);
    })();
    console.log(`Схемата на базата данни е обновена до версия ${m.version}.`);
  }
  const finalVersion = pending.length ? pending[pending.length - 1].version : from;
  if (finalVersion < CURRENT_SCHEMA_VERSION) db.pragma('user_version = ' + CURRENT_SCHEMA_VERSION);
}

/* ---------------- Местоположение на базата данни (за работа в мрежа) ----------------
   IPC handler-ите извадени в handlers/db-location.js (Фаза 4, стъпка 9 от
   разбиването на монолита main.js на модули по домейн). configPath/
   readConfig/writeConfig/resolveDbDir/resolveDbPath остават тук — ползва ги
   и initDb() при стартиране, извън обхвата на този модул. */
require('./handlers/db-location')(ipcMain, {
  app, dialog, fs, path,
  getDb: () => db, setDb: (v) => { db = v; }, getMainWindow: () => mainWindow,
  run, readConfig, writeConfig, resolveDbDir, resolveDbPath
});

/* ---------------- Резервни копия ----------------
   Извадени в handlers/backup.js (Фаза 4, стъпка 1 от разбиването на монолита
   main.js на модули по домейн) — самостоятелен домейн, никой друг код не
   вика функциите му. autoBackupIfNeeded() се извиква по-долу в
   app.whenReady(). */
const backupHandlers = require('./handlers/backup')(ipcMain, {
  app, dialog, fs, path,
  getDb: () => db, setDb: (v) => { db = v; }, getMainWindow: () => mainWindow,
  run, logAudit, resolveDbDir, resolveDbPath
});
const { autoBackupIfNeeded } = backupHandlers;

/* ---------------- Защита на лични данни: ЕГН / № лична карта (обща парола) ----------------
   Извадени в handlers/pdp.js (Фаза 4, стъпка 35). maskReaderRow/
   maskReaderRows/preparePiiForWrite се връщат обратно, защото
   handlers/readers.js (по-нататък в този файл) вече ги ползва по референция. */
const { maskReaderRow, maskReaderRows, preparePiiForWrite } = require('./handlers/pdp')(ipcMain, {
  getDb: () => db, run, logAudit
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    resizable: true,
    icon: path.join(__dirname, 'icon.ico'),
    title: 'Инвентар · Библиотечна система',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  // Сигурност (Фаза 3): приложението никога легитимно не отваря нов прозорец
  // и не навигира извън заредения src/index.html (вътрешното "рутиране" по
  // изгледи е само смяна на location.hash, което не задейства тези събития —
  // виж app.js). Всеки опит — независимо дали от неочакван код, компрометиран
  // renderer или инжектирано съдържание — се отказва тук. Ако все пак дойде
  // легитимен адрес за отваряне (напр. бъдещ линк с target="_blank"), той се
  // праща към системния браузър вместо в самия прозорец на приложението.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  return win;
}

/* ---------------- Автоматично обновяване (GitHub Releases) ----------------
   Работи само в инсталирана (пакетирана) версия — при `npm start` в режим
   на разработка автоматично се прескача, за да не пречи. Изисква публичен
   GitHub Release, съдържащ инсталатора и latest.yml (виж README). */
function initAutoUpdate(win) {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
  autoUpdater.on('checking-for-update', () => send('update:status', { state: 'checking' }));
  autoUpdater.on('update-available', (info) => send('update:status', { state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send('update:status', { state: 'not-available' }));
  autoUpdater.on('download-progress', (p) => send('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update:status', { state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => send('update:status', { state: 'error', message: err.message }));
  autoUpdater.checkForUpdates().catch(err => console.error('Автообновяване:', err.message));
}
ipcMain.handle('app:checkForUpdates', () =>
  run(() => {
    if (!app.isPackaged) throw new Error('Проверката за обновления работи само в инсталираната програма.');
    autoUpdater.checkForUpdates().catch(err => console.error('Автообновяване:', err.message));
    return true;
  })
);
ipcMain.handle('app:installUpdate', () => run(() => { autoUpdater.quitAndInstall(); }));

let mainWindow;
app.whenReady().then(() => {
  pruneOldLogs();
  initDb();
  // "Кой служител работи в момента" е настройка на този компютър (не на споделената база
  // данни) — всяко работно място пази собствения си избор в локалния config.json.
  CURRENT_USER = readConfig().lastUserName || '';
  autoBackupIfNeeded();
  startAutoPushTimer();
  mainWindow = createWindow();
  initAutoUpdate(mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAutoPushTimer();
  flushCatalogWrite(); // не губи последната промяна, ако насроченият (debounced) запис още не е станал
  if (db) db.close();
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- Помощни функции ---------------- */
function friendlyDbError(err) {
  const m = err.message || '';
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || m.includes('UNIQUE constraint failed')) {
    if (m.includes('books.inv_number')) return 'Този инвентарен номер вече е зает от друг документ.';
    if (m.includes('books.barcode')) return 'Този баркод вече е зает от друг документ.';
    if (m.includes('readers.card_no')) return 'Тази читателска карта вече е издадена на друг читател.';
    if (m.includes('categories.name')) return 'Категория с това име вече съществува.';
    if (m.includes('employees.name')) return 'Служител с това име вече съществува.';
    return 'Стойността вече съществува и трябва да бъде уникална.';
  }
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || m.includes('FOREIGN KEY constraint failed')) {
    return 'Действието е невъзможно, защото записът е свързан с други данни.';
  }
  if (err.code === 'SQLITE_CONSTRAINT_NOTNULL' || m.includes('NOT NULL constraint failed')) {
    return 'Задължително поле липсва.';
  }
  if (m.includes('no such column') || m.includes('no such table')) {
    return 'Базата данни не е напълно обновена за тази версия на програмата. Затворете и рестартирайте програмата; ако грешката продължи, пишете за поддръжка. (' + m + ')';
  }
  return m;
}
function run(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    console.error(err);
    return { ok: false, error: friendlyDbError(err) };
  }
}
function logAudit(action, detail, diff) {
  db.prepare('INSERT INTO audit_log (user, action, detail, diff) VALUES (?, ?, ?, ?)')
    .run(CURRENT_USER || '', action, detail || '', diff && diff.length ? JSON.stringify(diff) : null);
}
// Сравнява старите и новите стойности само на посочените полета и връща онези, които
// реално са се променили — за одитната следа (action_logs.diff в Koha), не целия ред.
function diffFields(oldObj, newObj, fields) {
  const out = [];
  for (const f of fields) {
    const before = oldObj ? oldObj[f] : undefined;
    const after = newObj ? newObj[f] : undefined;
    const nb = before == null ? '' : String(before);
    const na = after == null ? '' : String(after);
    if (nb !== na) out.push({ field: f, before: before ?? null, after: after ?? null });
  }
  return out;
}
const today = () => new Date().toISOString().slice(0, 10);
const yearOf = (d) => (d || today()).slice(0, 4);
function value(rows) { return rows.reduce((s, r) => s + (Number(r.price) || 0), 0); }
function pctRequired(n) { return n <= 50000 ? 10 : n <= 200000 ? 5 : 2; }
function naturalLoss(n, freeAccessPct) { return (freeAccessPct > 50 ? n * 10 : n * 5) / 1000; }

/* ---------------- Текущ служител (за одитната следа) ---------------- */
ipcMain.handle('app:setUser', (e, name) =>
  run(() => {
    CURRENT_USER = (name || '').trim();
    const cfg = readConfig(); cfg.lastUserName = CURRENT_USER; writeConfig(cfg);
    return CURRENT_USER;
  })
);
ipcMain.handle('app:getUser', () => run(() => CURRENT_USER));

/* ---------------- Служители ----------------
   Извадени в handlers/employees.js (Фаза 4, стъпка 6 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/employees')(ipcMain, { getDb: () => db, run, logAudit });
ipcMain.handle('app:getVersion', () => run(() => app.getVersion()));
// Отваря папката с дневниците на грешки (logs/) в системния файлов мениджър —
// удобно, за да прикачи librarianят файловете при заявка за поддръжка.
ipcMain.handle('app:openLogsFolder', () => run(() => { shell.openPath(logsDir()); }));

/* ---------------- Търсене по ISBN (Google Books, Open Library) и SRU (MARC) ----------------
   Извадени в handlers/isbn-lookup.js (Фаза 4, стъпка 10 от разбиването на
   монолита main.js на модули по домейн) — изцяло самостоятелен домейн. */
require('./handlers/isbn-lookup')(ipcMain, { net, getDb: () => db });

/* ---------------- Настройки ----------------
   Извадени в handlers/settings.js (Фаза 4, стъпка 33, един от "големите
   пет"). settings:noticeDefaults остава тук (не в handlers/settings.js) —
   вижте коментара в handlers/settings.js защо: TDZ капан като при logEvent,
   защото DEFAULT_NOTICE_* идват от handlers/notices.js, чийто require()
   стои по-нататък в този файл. LOGO_MIME/LOCAL_PHOTO_MAX_BYTES се връщат
   обратно, защото handlers/local-photo.js (по-нататък в този файл) вече ги
   ползва по референция. */
const { LOGO_MIME, LOCAL_PHOTO_MAX_BYTES } = require('./handlers/settings')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path
});
ipcMain.handle('settings:noticeDefaults', () =>
  run(() => ({
    subject: DEFAULT_NOTICE_SUBJECT, body: DEFAULT_NOTICE_BODY, sms: DEFAULT_NOTICE_SMS,
    placeholders: NOTICE_PLACEHOLDERS
  }))
);

/* ---------------- Категории ----------------
   Извадени в handlers/categories.js (Фаза 4, стъпка 7 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/categories')(ipcMain, { getDb: () => db, run });

/* ---------------- Книги (фонд) + Лимит на броя записи ----------------
   Извадени в handlers/books.js (Фаза 4, стъпка 34, последният от "големите
   пет"). BOOK_SELECT/BOOK_FIELDS/checkRecordLimit се връщат обратно, защото
   по-рано извадени модули (acquisitions.js, deaccession-acts.js, loans.js,
   catalog.js, readers.js) вече ги ползват по пряка референция в обект,
   подаден на require(), позициониран СЛЕД това място — същият модел, както
   при LOAN_SELECT/firstActiveHold. */
const { BOOK_SELECT, BOOK_FIELDS, checkRecordLimit } = require('./handlers/books')(ipcMain, {
  getDb: () => db, run, logAudit, today, ftsQuery, cnSortKey, diffFields, scheduleCatalogWrite
});

/* ---------------- Контрол на авторитетните данни ----------------
   Извадени в handlers/authorities.js (Фаза 4, стъпка 11 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/authorities')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Контролирани номенклатури (Koha: authorised_values) ----------------
   Извадени в handlers/av.js (Фаза 4, стъпка 12 от разбиването на монолита
   main.js на модули по домейн). */
require('./handlers/av')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Инвентарна книга (Приложение № 4 към чл. 16, ал. 1) ----------------
   Извадени в handlers/inv-book.js (Фаза 4, стъпка 13 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/inv-book')(ipcMain, { getDb: () => db, run });

/* ---------------- Постъпления (партиди) ----------------
   Извадени в handlers/acquisitions.js (Фаза 4, стъпка 14 от разбиването на
   монолита main.js на модули по домейн). BOOK_SELECT се подава по
   стойност (const низ, никога не се преприсвоява). */
require('./handlers/acquisitions')(ipcMain, { getDb: () => db, run, logAudit, BOOK_SELECT, yearOf });

/* ---------------- Отчисляване (актове) ----------------
   Извадени в handlers/deaccession-acts.js (Фаза 4, стъпка 15 от разбиването
   на монолита main.js на модули по домейн). */
require('./handlers/deaccession-acts')(ipcMain, {
  getDb: () => db, run, logAudit, BOOK_SELECT, yearOf, scheduleCatalogWrite
});

/* ---------------- КДБФ — книга за движение на фонда ---------------- */
require('./handlers/kdbf')(ipcMain, { getDb: () => db, run, yearOf });

/* ---------------- Читатели ---------------- */
require('./handlers/readers')(ipcMain, {
  getDb: () => db, run, logAudit, today, ftsQuery,
  maskReaderRow, maskReaderRows, preparePiiForWrite, diffFields, checkRecordLimit
});

/* ---------------- Читателска сметка (Koha: accountlines) ----------------
   amount > 0 = начислено (дължи се), amount < 0 = платено. Балансът е SUM(amount).
   Не е касов модул — само дневник на движенията + квитанция за печат. */
require('./handlers/account')(ipcMain, { getDb: () => db, run, logAudit, today });

/* ---------------- Предложения за покупка от читатели (Koha: suggestions) ----------------
   заявено → одобрено → поръчано → получено/отказано. При „получено" може да се закачи
   към партида в Постъпления, за да остане следа откъде реално е дошла книгата. */
require('./handlers/suggestions')(ipcMain, { getDb: () => db, run, logAudit, today });

/* ---------------- Обслужване по домовете (Koha: housebound) ----------------
   Извадени в handlers/housebound.js (Фаза 4, стъпка 8 от разбиването на
   монолита main.js на модули по домейн). logEvent се подава по референция
   (function declaration по-долу в "Заемания" — hoisted, вече е дефинирана
   тук). */
require('./handlers/housebound')(ipcMain, {
  getDb: () => db, run, logAudit, logEvent, today
});

/* ---------------- Лични данни: анонимизиране (Koha: pseudonymization) ----------------
   Върнати заемания, по-стари от N години, губят връзката с името: закачат се за
   служебния запис „— анонимизирани заемания —", а категорията и годината се снимат в
   anon_category — статистиката остава вярна („дете, 2024 г."), името изчезва.
   Настройка anonymize_years = 0 изключва всичко. Необратимо е — затова е ръчен бутон. */
require('./handlers/gdpr')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Календар на библиотеката ----------------
   Извадени в handlers/calendar.js (Фаза 4, стъпка 4 от разбиването на
   монолита main.js на модули по домейн). workDaysSet/isWorkDay/nextWorkDay/
   closedDaysBetween се връщат обратно тук, защото ги ползва и домейнът
   "Заемания" по-долу (все още неизваден). */
const { workDaysSet, isWorkDay, nextWorkDay, closedDaysBetween } =
  require('./handlers/calendar')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Правила за обслужване по категория читатели ----------------
   Извадени в handlers/circ-rules.js (Фаза 4, стъпка 5 от разбиването на
   монолита main.js на модули по домейн). circRule/readerCategory се връщат
   обратно тук, защото ги ползва и домейнът "Заемания" по-долу (все още
   неизваден). */
const { circRule, readerCategory } =
  require('./handlers/circ-rules')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Поток от събития ----------------
   logEvent остава hoisted function declaration тук (не се мести в
   handlers/loans.js), защото handlers/housebound.js вече го изисква по
   референция по-рано във файла (Фаза 4, стъпка 8) — местенето му в модул
   би счупило реда на зареждане (TDZ грешка при const местене над hoisting). */
function logEvent(kind, opts) {
  try {
    const o = opts || {};
    let bk = null, rd = null;
    if (o.bookId) {
      bk = db.prepare(`SELECT b.language, b.udk, c.name AS category_name
        FROM books b LEFT JOIN categories c ON c.id = b.category_id WHERE b.id = ?`).get(o.bookId);
    }
    if (o.readerId) rd = db.prepare('SELECT category FROM readers WHERE id = ?').get(o.readerId);
    db.prepare(`INSERT INTO events (date, kind, book_id, reader_id, reader_category, book_language, book_udk, book_category, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.date || today(), kind, o.bookId || null, o.readerId || null,
        rd ? rd.category : null, bk ? bk.language : null, bk ? bk.udk : null,
        bk ? bk.category_name : null, o.note || null);
  } catch (err) { console.error('Регистър на събитията:', err.message); }
}

/* ---------------- Резервации ----------------
   Извадени в handlers/holds.js (Фаза 4, стъпка 21 от разбиването на
   монолита main.js на модули по домейн). firstActiveHold/
   consumeHoldOnCheckout/activateHoldOnReturn се връщат обратно тук, защото
   ги ползва домейнът "Заемания" по-долу. */
const { firstActiveHold, consumeHoldOnCheckout, activateHoldOnReturn } =
  require('./handlers/holds')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Заемания ----------------
   Извадени в handlers/loans.js (Фаза 4, стъпка 22 от разбиването на
   монолита main.js на модули по домейн) — един от "големите пет".
   LOAN_SELECT се връща обратно, защото го ползват и все още неизвадените
   домейни "Табло" и "Просрочени: напомняния". */
const { LOAN_SELECT } = require('./handlers/loans')(ipcMain, {
  getDb: () => db, run, logAudit, today, logEvent, BOOK_SELECT, scheduleCatalogWrite,
  circRule, readerCategory, nextWorkDay, closedDaysBetween,
  firstActiveHold, consumeHoldOnCheckout, activateHoldOnReturn
});

/* ---------------- Табло ---------------- */
require('./handlers/dashboard')(ipcMain, {
  getDb: () => db, run, today, yearOf, pctRequired, isWorkDay, LOAN_SELECT
});

/* ---------------- Инвентаризация ---------------- */
require('./handlers/inventory-sessions')(ipcMain, {
  getDb: () => db, run, logAudit, pctRequired, naturalLoss
});

/* ---------------- Просрочени: напомняния ----------------
   Извадени в handlers/notices.js (Фаза 4, стъпка 25 от разбиването на
   монолита main.js на модули по домейн). Константите за шаблоните по
   подразбиране и списъкът от плейсхолдъри се връщат обратно, защото ги
   ползва все още неизвадената "Настройки" (settings:noticeDefaults). */
const { DEFAULT_NOTICE_SUBJECT, DEFAULT_NOTICE_BODY, DEFAULT_NOTICE_SMS, NOTICE_PLACEHOLDERS } =
  require('./handlers/notices')(ipcMain, {
    getDb: () => db, run, today, LOAN_SELECT, EUR_RATE, isValidEmail, shell
  });

/* ---------------- Периодика ---------------- */
require('./handlers/periodicals')(ipcMain, { getDb: () => db, run, logAudit, today });

/* ---------------- МЗС ---------------- */
require('./handlers/mzs')(ipcMain, { getDb: () => db, run, logAudit, yearOf });

// Дневник на библиотеката (Раздел А / Раздел Б) → handlers/dnevnik.js
// (Фаза 4, стъпка 30). dnevnikSumRow се връща обратно, защото
// handlers/stats.js (извадено по-рано) вече го ползва по референция.
const { dnevnikSumRow } = require('./handlers/dnevnik')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs
});

/* ============================================================================
   КРАЕВЕДСКИ МОДУЛИ: аналитично описание, персоналии, летопис, снимки, връзки
   (Фаза 4, стъпка 31) → handlers/analytics.js, persons.js, chronicle.js,
   local-photo.js, links.js. Всеки подмодул чете направо от getDb() — не са
   нужни препратки между тях, освен общите таблици.
   ============================================================================ */
require('./handlers/analytics')(ipcMain, { getDb: () => db, run, logAudit });
require('./handlers/persons')(ipcMain, { getDb: () => db, run, logAudit });
require('./handlers/chronicle')(ipcMain, { getDb: () => db, run, logAudit });
require('./handlers/local-photo')(ipcMain, {
  getDb: () => db, run, dialog, getMainWindow: () => mainWindow, fs, path, LOGO_MIME, LOCAL_PHOTO_MAX_BYTES
});
require('./handlers/links')(ipcMain, { getDb: () => db, run });

/* ============================================================================
   ПРИЕМАНЕ НА ДАННИ ОТ ДРУГИ СИСТЕМИ → handlers/data-import.js (Фаза 4,
   стъпка 36). Цел: читалище с изоставена стара база (АБ, iLib, чужд Excel)
   да мине на тази програма без преписване на ръка.
   ============================================================================ */
require('./handlers/data-import')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path, BOOK_FIELDS, today, cnSortKey
});

/* ============================================================================
   МОБИЛНО СКАНИРАНЕ → handlers/mobile.js (Фаза 4, стъпка 36). Вместо RFID:
   страница, която се отваря на телефона и ползва камерата като баркод
   четец. Списъкът се пренася обратно като текст или файл.
   ============================================================================ */
require('./handlers/mobile')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path
});

/* ============================================================================
   ПОМОЩ СРЕЩУ АНТИВИРУСНИ БЛОКИРОВКИ → handlers/security-exclusions.js
   (Фаза 4, стъпка 36). Докато инсталаторът е без закупен цифров подпис,
   Defender и други антивирусни спират както инсталирането, така и работата
   на вече инсталираната програма.
   ============================================================================ */
require('./handlers/security-exclusions')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path, app, resolveDbDir
});

/* ---------------- Одитна следа ---------------- */
require('./handlers/audit')(ipcMain, { getDb: () => db, run });

/* ---------------- История на търсенията (Koha: search_history) ---------------- */
require('./handlers/search-history')(ipcMain, { getDb: () => db, run, getCurrentUser: () => CURRENT_USER });

/* ---------------- Посещения ---------------- */
require('./handlers/visits')(ipcMain, { getDb: () => db, run });

/* ---------------- Справки и статистика + Готови справки ----------------
   Извадени в handlers/stats.js (Фаза 4, стъпка 29 от разбиването на
   монолита main.js на модули по домейн). dnevnikSumRow е hoisted function
   declaration от все още неизвадения домейн "Дневник на библиотеката". */
require('./handlers/stats')(ipcMain, { getDb: () => db, run, yearOf, value, dnevnikSumRow });

// Полетата и обвивката {library, place, generated, items} трябва да съвпадат ТОЧНО с
// формàта, който `inventar-biblioteka.html` и страницата page-katalog.html на сайта вече
// очакват (кратки ключове inv/a/t/s/c/p/y/v/l/u/g/o/k/n/cv/av) — сайтът чете това по
// живо от GitHub и не знае нищо за схемата на Electron версията.
/* opacMap: вътрешна стойност → публичен надпис от номенклатурите (opac_label).
   Навън не трябва да се вижда вътрешният жаргон — затова отделът и езикът минават
   през превода, ако библиотекарят е задал публичен надпис. */
function publicBookFields(b, opacMap) {
  const pub = (cat, v) => (opacMap && opacMap[cat] && opacMap[cat][v]) || v || '';
  return {
    inv: b.inv_number, a: b.author || '', t: b.title || '', s: b.subtitle || '',
    c: b.city || '', p: b.publisher || '', y: b.year || '', v: b.category_name || '',
    l: pub('language', b.language), u: b.udk || '', g: b.call_number || '', o: pub('department', b.department),
    k: b.keywords || '', n: b.annotation || '', cv: b.cover_url || '', av: b.available > 0 ? 1 : 0,
    // d = дата на постъпване: страницата извежда „Нови постъпления" сама от нея.
    // Старите версии на страницата не познават ключа и просто го подминават.
    d: b.register_date || ''
  };
}
function buildCatalogPayload() {
  const books = db.prepare(`${BOOK_SELECT} WHERE b.status != 'отчислен' AND b.department != 'служебен' ORDER BY b.title`).all();
  const s = db.prepare('SELECT lib_name, place FROM settings WHERE id = 1').get() || {};
  const opacMap = {};
  for (const r of db.prepare(`SELECT category, value, opac_label FROM authorised_values WHERE opac_label IS NOT NULL AND TRIM(opac_label) <> ''`).all()) {
    (opacMap[r.category] = opacMap[r.category] || {})[r.value] = r.opac_label;
  }
  // Витрините сочат книги по публичния им ключ (инв. №). Книга, която е спряла да
  // се публикува (отчислена/служебна), отпада мълчаливо; празна витрина не се излъчва.
  const published = new Set(books.map(b => b.inv_number));
  const shelves = db.prepare(`
    SELECT sh.name, b.inv_number FROM catalog_shelves sh
    JOIN catalog_shelf_items si ON si.shelf_id = sh.id
    JOIN books b ON b.id = si.book_id
    ORDER BY sh.sort, sh.name, si.sort, b.title
  `).all().reduce((m, r) => {
    if (!published.has(r.inv_number)) return m;
    (m[r.name] = m[r.name] || []).push(r.inv_number);
    return m;
  }, {});
  const shelfList = Object.entries(shelves).map(([name, items]) => ({ name, items }));
  return {
    library: s.lib_name || '', place: s.place || '',
    generated: new Date().toISOString().slice(0, 10),
    items: books.map(b => publicBookFields(b, opacMap)),
    ...(shelfList.length ? { shelves: shelfList } : {})
  };
}
function catalogPayloadItemCount(payload) {
  return Array.isArray(payload) ? payload.length : (payload && Array.isArray(payload.items) ? payload.items.length : 0);
}
// Връща {written:true} при успешен запис, {written:false, blocked:true} ако предпазната
// мярка е спряла записа (виж коментара долу), или {written:false} при обикновена грешка/
// липсваща папка. Автоматичните извиквания (след запис на книга, заемане и т.н.) само
// подминават резултата; ръчните бутони го ползват, за да покажат ясно съобщение.
//
// Декъплинг на записа при всяка мутация (Фаза 2): вместо да презаписваме
// целия katalog.json синхронно при всяко книга/заемане (write amplification
// — файлът може да е няколко MB при 15 000+ записа), натрупваме "мръсен"
// флаг и записваме веднъж, известно време след последната промяна. Ръчните
// действия (writeNow, gitPublishNow) вместо това "изпразват" веднага текущия
// таймер и пишат синхронно, за да дадат точна обратна връзка на потребителя.
const CATALOG_WRITE_DEBOUNCE_MS = 4000;
function writeCatalogIfConfigured() {
  try {
    const s = db.prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
    if (!s || !s.catalog_folder) return { written: false };
    const file = path.join(s.catalog_folder, 'katalog.json');
    const payload = buildCatalogPayload();
    // Предпазна мярка: не презаписвай непразен публикуван каталог с празен. Това пази от
    // случаен запис от прясна/тестова инсталация (празен фонд) върху вече публикувани
    // реални данни — например, ако папката е свързана, преди фондът да е зареден в тази база.
    if (payload.items.length === 0 && fs.existsSync(file)) {
      try {
        const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (catalogPayloadItemCount(existing) > 0) {
          console.error('Пропуснат автоматичен запис на каталога: новите данни са празни, а публикуваният файл не е.');
          return { written: false, blocked: true };
        }
      } catch (e) { /* повреден/нечетим съществуващ файл — продължи с обичайния запис */ }
    }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return { written: true };
  } catch (err) {
    console.error('Автоматичен запис на каталога:', err.message);
    return { written: false };
  }
}
// generic debounce/coalesce помощник (debounce.js) — schedule() слива много
// бързи последователни мутации в един-единствен запис; flush() го изпълнява
// веднага (използва се от ръчните действия writeNow/gitPublishNow/chooseFolder
// и при затваряне на приложението, за да не се загуби последната промяна).
const catalogWriteDebouncer = createDebouncer(writeCatalogIfConfigured, CATALOG_WRITE_DEBOUNCE_MS);
function scheduleCatalogWrite() { catalogWriteDebouncer.schedule(); }
function flushCatalogWrite() { return catalogWriteDebouncer.flush(); }

/* ---------------- Онлайн каталог (публикуване през GitHub) + Витрини +
   Експорт в библиотечни формати ----------------
   Извадени в handlers/catalog.js (Фаза 4, стъпка 32 от разбиването на
   монолита main.js на модули по домейн) и handlers/shelves.js (стъпка 3).
   scheduleCatalogWrite/flushCatalogWrite/buildCatalogPayload остават тук
   (виж коментарите по-горе при дефиницията им) — по-рано извадени модули
   вече ги ползват по пряка референция в обект, подаден на техния require(),
   изпълнен ПРЕДИ това място; преместването им би било TDZ капан като при
   logEvent. startAutoPushTimer/stopAutoPushTimer се връщат обратно, защото
   app.whenReady()/window-all-closed ги викат само вътре в отложени
   callback-и — редът там няма значение. */
require('./handlers/shelves')(ipcMain, {
  getDb: () => db, run, logAudit, scheduleCatalogWrite
});
const { startAutoPushTimer, stopAutoPushTimer } = require('./handlers/catalog')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path, execFile,
  BOOK_SELECT, csvCell, flushCatalogWrite, buildCatalogPayload
});
