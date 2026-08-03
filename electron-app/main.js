const { app, BrowserWindow, ipcMain, dialog, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');
const importers = require('./importers');
const pii = require('./pii-crypto');
const { ftsQuery, BOOKS_FTS_SETUP_SQL, READERS_FTS_SETUP_SQL } = require('./search-fts');
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
const CURRENT_SCHEMA_VERSION = 4;
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
  } }
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
   ЕГН и номер на лична карта на читателите могат да се защитят с обща парола
   (AES-256-GCM, виж pii-crypto.js) — една и съща парола на всички компютри,
   които ползват тази база данни, включително споделена мрежова база (затова
   НЕ е обвързана с конкретния компютър — виж бележката в README). Останалите
   данни за читателя (име, адрес, телефон, история на заемания) не са засегнати
   и продължават да работят нормално без паролата.

   Ключът се пази само в паметта на текущия процес ("отключено" за тази сесия
   на програмата) — никога на диск. При затваряне на програмата или ръчно
   "Заключи" паролата трябва да се въведе отново. */
let PDP_KEY = null;
const PDP_PLACEHOLDER = 'Защитени данни';
function pdpSettingsRow() {
  return db.prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id = 1').get() || {};
}
function pdpConfigured() {
  const s = pdpSettingsRow();
  return !!(s.pdp_salt && s.pdp_verifier);
}
// Прилага се към всеки читателски ред, преди да напусне main процеса: разкрипта
// egn/id_card_no ако защитата е отключена в момента, показва плейсхолдър ако е
// заключена, и оставя непроменени старите стойности в чист текст (инсталации,
// които никога не са задавали тази защита — пълна обратна съвместимост).
function maskReaderRow(r) {
  if (!r) return r;
  for (const f of ['egn', 'id_card_no']) {
    if (!pii.isEncryptedField(r[f])) continue;
    if (!PDP_KEY) { r[f] = PDP_PLACEHOLDER; continue; }
    try { r[f] = pii.decryptField(r[f], PDP_KEY); }
    catch (e) { r[f] = PDP_PLACEHOLDER; console.error('Разкриптиране на лични данни:', e.message); }
  }
  return r;
}
function maskReaderRows(rows) { rows.forEach(maskReaderRow); return rows; }
// Подготвя egn/id_card_no за запис. Ако защитата не е зададена изобщо — без
// промяна (старо поведение, чист текст). Ако е зададена и отключена — криптира
// новите стойности. Ако е зададена, но ЗАКЛЮЧЕНА в момента: при редакция се
// пази предишната (криптирана) стойност непроменена, каквото и да е дошло от
// интерфейса — тези полета там се показват само за четене, докато не се въведе
// паролата, точно за да не презапишат криптирана стойност с плейсхолдъра. При
// нов читател без предишен ред няма какво да се пази, затова се изисква
// отключване, ако е въведено ЕГН/№ ЛК.
function preparePiiForWrite(out, prev) {
  if (!pdpConfigured()) return;
  for (const f of ['egn', 'id_card_no']) {
    if (PDP_KEY) {
      if (out[f] && !pii.isEncryptedField(out[f])) out[f] = pii.encryptField(out[f], PDP_KEY);
    } else if (prev) {
      out[f] = prev[f];
    } else if (out[f]) {
      throw new Error('Отключете защитата на лични данни от „Настройки“, за да запишете ЕГН/№ ЛК на нов читател.');
    }
  }
}
// Прекриптира всички съществуващи стойности egn/id_card_no с нов ключ — ползва
// се и при първо задаване на паролата (стойностите тогава са в чист текст), и
// при смяна на паролата (стойностите тогава вече са криптирани със стария
// ключ). readKey е null, ако стойностите в момента са в чист текст.
function reencryptAllReaders(readKey, writeKey) {
  const rows = db.prepare(`SELECT id, egn, id_card_no FROM readers
    WHERE (egn IS NOT NULL AND egn <> '') OR (id_card_no IS NOT NULL AND id_card_no <> '')`).all();
  const upd = db.prepare('UPDATE readers SET egn = ?, id_card_no = ? WHERE id = ?');
  for (const r of rows) {
    const plainEgn = readKey ? pii.decryptField(r.egn, readKey) : r.egn;
    const plainIdc = readKey ? pii.decryptField(r.id_card_no, readKey) : r.id_card_no;
    upd.run(
      plainEgn ? pii.encryptField(plainEgn, writeKey) : plainEgn,
      plainIdc ? pii.encryptField(plainIdc, writeKey) : plainIdc,
      r.id
    );
  }
  return rows.length;
}
ipcMain.handle('pdp:status', () =>
  run(() => ({ configured: pdpConfigured(), unlocked: !!PDP_KEY }))
);
ipcMain.handle('pdp:setup', (e, password) =>
  run(() => {
    if (!password || String(password).length < 4) throw new Error('Паролата трябва да е поне 4 знака.');
    if (pdpConfigured()) throw new Error('Защитата вече е зададена — за смяна на паролата ползвайте смяната на паролата.');
    const salt = pii.generateSalt();
    const key = pii.deriveKey(password, salt);
    const verifier = pii.makeVerifier(key);
    let n = 0;
    db.transaction(() => {
      db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
        .run(salt.toString('base64'), verifier);
      n = reencryptAllReaders(null, key);
    })();
    PDP_KEY = key;
    logAudit('Защита на лични данни', 'зададена е парола за защита на ЕГН/№ ЛК (' + n + ' читатели засегнати)');
    return true;
  })
);
ipcMain.handle('pdp:unlock', (e, password) =>
  run(() => {
    const s = pdpSettingsRow();
    if (!s.pdp_salt || !s.pdp_verifier) throw new Error('Защитата не е зададена.');
    const key = pii.deriveKey(password, Buffer.from(s.pdp_salt, 'base64'));
    if (!pii.checkVerifier(s.pdp_verifier, key)) throw new Error('Грешна парола.');
    PDP_KEY = key;
    return true;
  })
);
ipcMain.handle('pdp:lock', () => run(() => { PDP_KEY = null; }));
ipcMain.handle('pdp:changePassword', (e, { oldPassword, newPassword } = {}) =>
  run(() => {
    const s = pdpSettingsRow();
    if (!s.pdp_salt || !s.pdp_verifier) throw new Error('Защитата не е зададена.');
    if (!newPassword || String(newPassword).length < 4) throw new Error('Новата парола трябва да е поне 4 знака.');
    const oldKey = pii.deriveKey(oldPassword, Buffer.from(s.pdp_salt, 'base64'));
    if (!pii.checkVerifier(s.pdp_verifier, oldKey)) throw new Error('Текущата парола е грешна.');
    const newSalt = pii.generateSalt();
    const newKey = pii.deriveKey(newPassword, newSalt);
    const newVerifier = pii.makeVerifier(newKey);
    db.transaction(() => {
      db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
        .run(newSalt.toString('base64'), newVerifier);
      reencryptAllReaders(oldKey, newKey);
    })();
    PDP_KEY = newKey;
    logAudit('Защита на лични данни', 'паролата за защита на ЕГН/№ ЛК е сменена');
    return true;
  })
);

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
  if (AUTO_PUSH_TIMER) clearInterval(AUTO_PUSH_TIMER);
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

/* ---------------- Настройки ---------------- */
ipcMain.handle('settings:get', () => run(() => db.prepare('SELECT * FROM settings WHERE id = 1').get()));
ipcMain.handle('settings:update', (e, s) =>
  run(() => {
    db.prepare(`
      UPDATE settings SET org=@org, lib_name=@lib_name, place=@place, bulstat=@bulstat, reg_no=@reg_no,
        director=@director, director_role=@director_role, librarian=@librarian, cat_url=@cat_url,
        loan_days=@loan_days, max_books=@max_books, extensions_count=@extensions_count, extension_days=@extension_days,
        fine_per_day=@fine_per_day, annual_fee=@annual_fee, free_access_pct=@free_access_pct,
        next_inv_number=@next_inv_number, committee1=@committee1, committee2=@committee2, committee3=@committee3,
        sru_endpoint=@sru_endpoint, suspend_per_day=@suspend_per_day, suspend_max=@suspend_max,
        remind2_days=@remind2_days, remind3_days=@remind3_days, anonymize_years=@anonymize_years
      WHERE id = 1
    `).run(s);
    logAudit('Редакция на настройки', 'настройките на библиотеката са обновени');
  })
);
// Шаблоните за напомняния — отделен формуляр, за да не се засяга основният
// (better-sqlite3 изисква всички именувани параметри на UPDATE-а да присъстват
// в подадения обект). Празен низ = "по подразбиране", виж reminderTexts().
ipcMain.handle('settings:updateNotices', (e, o) =>
  run(() => {
    o = o || {};
    db.prepare('UPDATE settings SET notice_subject=?, notice_body=?, notice_sms=? WHERE id=1')
      .run(o.notice_subject || null, o.notice_body || null, o.notice_sms || null);
    logAudit('Редакция на шаблони', 'шаблоните за напомняния са обновени');
  })
);
ipcMain.handle('settings:noticeDefaults', () =>
  run(() => ({
    subject: DEFAULT_NOTICE_SUBJECT, body: DEFAULT_NOTICE_BODY, sms: DEFAULT_NOTICE_SMS,
    placeholders: NOTICE_PLACEHOLDERS
  }))
);
// Размерите се ограничават в разумни граници: под няколко милиметра етикетът е
// безсмислен, а над размера на A4 принтерът така или иначе не го поема.
const clampNum = (v, lo, hi, def) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
ipcMain.handle('settings:updateLabelFormat', (e, o) =>
  run(() => {
    o = o || {};
    db.prepare(`UPDATE settings SET lbl_mode=?, lbl_w=?, lbl_h=?, lbl_cols=?, lbl_gap=?, lbl_margin=?,
                lbl_border=?, sig_w=?, sig_h=?, card_w=?, card_h=? WHERE id=1`)
      .run(
        o.lbl_mode === 'roll' ? 'roll' : 'sheet',
        clampNum(o.lbl_w, 10, 210, 40), clampNum(o.lbl_h, 8, 297, 30),
        clampNum(o.lbl_cols, 1, 8, 3), clampNum(o.lbl_gap, 0, 30, 3), clampNum(o.lbl_margin, 0, 40, 8),
        o.lbl_border ? 1 : 0,
        clampNum(o.sig_w, 10, 100, 25), clampNum(o.sig_h, 10, 120, 35),
        clampNum(o.card_w, 40, 210, 90), clampNum(o.card_h, 30, 297, 60)
      );
  })
);
/* ---------------- Лого на организацията ----------------
   Логото се пази в самата база данни като data URI, а не като път до файл: така
   пътува заедно с базата при резервно копие, при пренасяне на друг компютър и при
   работа в мрежа, където другите компютри нямат достъп до локалния файл. */
const LOGO_MAX_BYTES = 512 * 1024;
// Снимките към персоналии и летопис са по-големи от логото, но пак пътуват в базата.
const LOCAL_PHOTO_MAX_BYTES = 1024 * 1024;
const LOGO_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
ipcMain.handle('settings:chooseLogo', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Изберете файл с логото на организацията',
      properties: ['openFile'],
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
    });
    if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
    const file = filePaths[0];
    const ext = path.extname(file).toLowerCase();
    const mime = LOGO_MIME[ext];
    if (!mime) return { ok: false, error: 'Неподдържан формат. Изберете PNG, JPG, GIF, WEBP или SVG.' };
    const buf = fs.readFileSync(file);
    if (buf.length > LOGO_MAX_BYTES) {
      return { ok: false, error: 'Файлът е ' + Math.round(buf.length / 1024) + ' KB, а максимумът е 512 KB. ' +
        'Смалете изображението — за печат е достатъчно около 600 пиксела ширина.' };
    }
    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
    db.prepare('UPDATE settings SET logo = ? WHERE id = 1').run(dataUri);
    logAudit('Редакция на настройки', 'зададено лого на организацията');
    return { ok: true, data: dataUri };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('settings:clearLogo', () =>
  run(() => {
    db.prepare('UPDATE settings SET logo = NULL WHERE id = 1').run();
    logAudit('Редакция на настройки', 'премахнато лого на организацията');
  })
);
ipcMain.handle('settings:updateTheme', (e, theme) =>
  run(() => { db.prepare('UPDATE settings SET theme=? WHERE id=1').run(String(theme)); })
);

/* ---------------- Категории ----------------
   Извадени в handlers/categories.js (Фаза 4, стъпка 7 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/categories')(ipcMain, { getDb: () => db, run });

/* ---------------- Книги ---------------- */
const BOOK_SELECT = `
  SELECT b.*, c.name AS category_name,
         COALESCE(i.quantity, 0) AS quantity,
         COALESCE(i.quantity, 0) - COALESCE((
           SELECT COUNT(*) FROM loans l WHERE l.book_id = b.id AND l.date_in IS NULL
         ), 0) AS available
  FROM books b
  LEFT JOIN categories c ON c.id = b.category_id
  LEFT JOIN inventory i ON i.book_id = b.id
`;
const BOOK_FIELDS = ['inv_number', 'barcode', 'register_date', 'title', 'subtitle', 'author',
  'category_id', 'year', 'volume', 'isbn', 'pages', 'language', 'udk', 'call_number', 'author_mark',
  'city', 'publisher', 'keywords', 'annotation', 'cover_url', 'department', 'permanent_location',
  'status', 'status_date', 'price', 'description', 'acquisition_id', 'cn_sort'];

/* ---------------- Контрол на авторитетните данни ----------------
   Извадени в handlers/authorities.js (Фаза 4, стъпка 11 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/authorities')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Контролирани номенклатури (Koha: authorised_values) ----------------
   Извадени в handlers/av.js (Фаза 4, стъпка 12 от разбиването на монолита
   main.js на модули по домейн). */
require('./handlers/av')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Лимит на броя записи ----------------
   Настройва се в „Настройки“ → „Ограничения“; 0 означава без ограничение.
   Проверява се само при СЪЗДАВАНЕ на нов запис — редакцията на съществуващи
   остава възможна дори ако лимитът вече е достигнат или намален след това. */
function checkRecordLimit(kind) {
  const s = db.prepare('SELECT limit_books, limit_readers FROM settings WHERE id = 1').get() || {};
  const cfg = kind === 'books'
    ? { limit: s.limit_books, table: 'books', label: 'документи във фонда' }
    : { limit: s.limit_readers, table: 'readers', label: 'читатели' };
  const limit = parseInt(cfg.limit, 10) || 0;
  if (limit <= 0) return;
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${cfg.table}`).get().n;
  if (n >= limit) {
    throw new Error(`Достигнат е зададеният лимит от ${limit} ${cfg.label}. ` +
      'Увеличете или премахнете лимита в „Настройки“ → „Ограничения“, за да добавяте нови записи.');
  }
}
ipcMain.handle('limits:usage', () =>
  run(() => {
    const s = db.prepare('SELECT limit_books, limit_readers FROM settings WHERE id = 1').get() || {};
    return {
      books: db.prepare('SELECT COUNT(*) AS n FROM books').get().n,
      readers: db.prepare('SELECT COUNT(*) AS n FROM readers').get().n,
      limitBooks: parseInt(s.limit_books, 10) || 0,
      limitReaders: parseInt(s.limit_readers, 10) || 0
    };
  })
);
ipcMain.handle('limits:update', (e, { limit_books, limit_readers }) =>
  run(() => {
    db.prepare('UPDATE settings SET limit_books=?, limit_readers=? WHERE id=1')
      .run(Math.max(0, parseInt(limit_books, 10) || 0), Math.max(0, parseInt(limit_readers, 10) || 0));
    logAudit('Редакция на настройки', 'променени лимити на записите');
  })
);

/* prev — досегашният ред от базата (при редакция): status_date се обновява само
   когато статусът реално се променя, а не при всяко записване на формата. */
function bookPayload(b, prev) {
  const out = {};
  BOOK_FIELDS.forEach(f => { out[f] = b[f] === undefined || b[f] === '' ? null : b[f]; });
  if (out.inv_number != null) out.inv_number = parseInt(out.inv_number, 10);
  if (out.category_id != null) out.category_id = parseInt(out.category_id, 10);
  if (out.acquisition_id != null) out.acquisition_id = parseInt(out.acquisition_id, 10);
  out.price = b.price ? parseFloat(b.price) : 0;
  out.status = b.status || 'наличен';
  out.register_date = b.register_date || today();
  out.cn_sort = out.call_number ? cnSortKey(out.call_number) : null;
  out.status_date = !prev ? today()
    : (prev.status !== out.status ? today() : (prev.status_date || null));
  return out;
}

// sort: 'title' (по подразбиране), 'cn' (по сигнатура — cn_sort нарежда „Ч-9" преди
// „Ч-84", виж cnSortKey) или 'inv' (по инвентарен номер). Изборът е от фиксиран
// списък тук, никога суров SQL от интерфейса.
const BOOK_ORDERS = { title: 'b.title', cn: "b.cn_sort IS NULL, b.cn_sort, b.title", inv: 'b.inv_number' };
ipcMain.handle('books:list', (e, query, sort) =>
  run(() => {
    const order = BOOK_ORDERS[sort] || BOOK_ORDERS.title;
    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      // Заглавие/подзаглавие/автор минават през FTS5 (unicode61) — сгъва регистъра
      // и по кирилица ("белият" вече намира "Белият"), без пълно сканиране на
      // таблицата. Баркод/ISBN/инв. № остават на LIKE — ASCII цифри, за които
      // потребителите очакват "съдържа навсякъде", а не само префикс.
      return db.prepare(`${BOOK_SELECT}
        WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)
           OR b.isbn LIKE ? OR b.barcode LIKE ? OR CAST(b.inv_number AS TEXT) LIKE ?
        ORDER BY ${order}`).all(ftsQuery(query), q, q, q);
    }
    return db.prepare(`${BOOK_SELECT} ORDER BY ${order}`).all();
  })
);
ipcMain.handle('books:get', (e, id) => run(() => db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id)));
ipcMain.handle('books:byBarcode', (e, code) =>
  // CAST-ва се ПАРАМЕТЪРЪТ, не колоната — CAST(b.inv_number AS TEXT) = ? би
  // попречил на SQLite да ползва нито idx_books_barcode, нито уникалния индекс
  // на inv_number, и би прибягнал до пълно сканиране на фонда въпреки индекса
  // (потвърдено с EXPLAIN QUERY PLAN: с тази форма планът е MULTI-INDEX OR по
  // двата индекса).
  run(() => db.prepare(`${BOOK_SELECT} WHERE b.barcode = ? OR b.inv_number = CAST(? AS INTEGER)`).get(code, code))
);

ipcMain.handle('books:create', (e, book) =>
  run(() => {
    checkRecordLimit('books');
    const tx = db.transaction((b) => {
      const payload = bookPayload(b);
      const info = db.prepare(`
        INSERT INTO books (${BOOK_FIELDS.join(',')}, register_date)
        VALUES (${BOOK_FIELDS.map(f => '@' + f).join(',')}, @register_date)
      `).run(payload);
      const id = info.lastInsertRowid;
      db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)')
        .run(id, b.quantity != null ? parseInt(b.quantity, 10) : 1);
      if (payload.inv_number) {
        const s = db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get();
        if (payload.inv_number >= s.next_inv_number) {
          db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(payload.inv_number + 1);
        }
      }
      logAudit('Нов документ', 'инв. № ' + (payload.inv_number ?? '—') + ' — ' + b.title);
      return id;
    });
    const id = tx(book);
    scheduleCatalogWrite();
    return id;
  })
);
ipcMain.handle('books:update', (e, book) =>
  run(() => {
    const tx = db.transaction((b) => {
      const prev = db.prepare('SELECT * FROM books WHERE id = ?').get(b.id);
      const payload = bookPayload(b, prev);
      db.prepare(`
        UPDATE books SET ${BOOK_FIELDS.map(f => f + '=@' + f).join(',')} WHERE id=@id
      `).run(Object.assign({ id: b.id }, payload));
      db.prepare(`
        INSERT INTO inventory (book_id, quantity) VALUES (?, ?)
        ON CONFLICT(book_id) DO UPDATE SET quantity = excluded.quantity
      `).run(b.id, b.quantity != null ? parseInt(b.quantity, 10) : 1);
      const diff = diffFields(prev, payload, BOOK_FIELDS);
      logAudit('Редакция на документ', 'инв. № ' + (payload.inv_number ?? '—') + ' — ' + b.title, diff);
    });
    tx(book);
    scheduleCatalogWrite();
  })
);
ipcMain.handle('books:delete', (e, id) =>
  run(() => {
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    scheduleCatalogWrite();
  })
);
/* Групова редакция — смяна на едно поле на много документи наведнъж (Koha: "batch item
   modification"). Полето идва от списък с изрично позволени имена (никога суров SQL
   от renderer-а), а „отчислен“ е нарочно изваден от позволените стойности за „status“:
   отчисляването минава единствено през формален акт (раздел „Отчисляване“, чл. 30–39),
   не бива да е на един клик разстояние от таблицата с книги. По същата причина вече
   отчислени документи не се пипат от груповата редакция, дори да са били маркирани. */
const BULK_EDIT_FIELDS = ['department', 'status', 'category_id', 'language'];
const BULK_EDIT_STATUS_VALUES = ['наличен', 'липсващ', 'за реставрация'];
ipcMain.handle('books:bulkUpdate', (e, { ids, field, value }) =>
  run(() => {
    if (!BULK_EDIT_FIELDS.includes(field)) throw new Error('Непозволено поле за групова редакция.');
    if (!Array.isArray(ids) || !ids.length) throw new Error('Няма избрани документи.');
    if (field === 'status' && !BULK_EDIT_STATUS_VALUES.includes(value)) {
      throw new Error('Отчисляването на документи минава само през акт за отчисляване (раздел „Отчисляване“), не и през групова редакция.');
    }
    const v = field === 'category_id' ? (value ? parseInt(value, 10) : null) : (value || null);
    const placeholders = ids.map(() => '?').join(',');
    // Смяната на статус носи и датата си (Koha: датирани статуси) — иначе справката
    // „кога стана липсваща" няма отговор.
    const extra = field === 'status' ? ", status_date = date('now')" : '';
    const tx = db.transaction(() => db.prepare(
      `UPDATE books SET ${field} = ?${extra} WHERE id IN (${placeholders}) AND status != 'отчислен'`
    ).run(v, ...ids).changes);
    const changes = tx();
    logAudit('Групова редакция', changes + ' документ(а) — ' + field + ' → ' + (value || '—'));
    scheduleCatalogWrite();
    return changes;
  })
);
ipcMain.handle('books:addCheck', (e, { bookId, date }) =>
  run(() => db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(bookId, date || today()))
);
ipcMain.handle('books:checks', (e, bookId) =>
  run(() => db.prepare('SELECT date FROM inventory_checks WHERE book_id = ? ORDER BY date').all(bookId))
);

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

/* ---------------- Заемания ---------------- */
const LOAN_SELECT = `
  SELECT l.*, b.title, b.author, b.inv_number, r.name AS reader_name, r.card_no
  FROM loans l
  JOIN books b ON b.id = l.book_id
  JOIN readers r ON r.id = l.reader_id
`;

/* ---------------- Поток от събития ----------------
   Всяко заемане/връщане/подновяване/ползване в читалня/посещение по домовете оставя
   ред в events — със снимка на категорията на читателя и езика/УДК/вида на документа
   към момента. От тези редове дневникът предлага попълнени стойности (dnevnik:suggest),
   а справките се смятат със заявки. Грешка тук никога не проваля самата операция. */
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
// Ползване в читалня — бърз брояч от „Заемане и връщане"; читателят е незадължителен.
ipcMain.handle('events:localuse', (e, { date } = {}) =>
  run(() => { logEvent('читалня', { date }); return true; })
);

/* Наказание в дни (Koha: finedays) — за селска библиотека N дни без право на заемане
   е по-приложимо от глоба в стотинки, която никой не събира. Смята се при връщане
   със забава; натрупва се върху вече наложено наказание, но не надхвърля тавана. */
// dueDate/inDate — реалните дати (не готово число дни), защото наказанието трябва да
// извади затворените дни от периода (виж closedDaysBetween) — календарят е по-важен
// точно тук: несправедливо е падеж в затворен ден да носи наказание за самия него.
function applySuspension(readerId, dueDate, inDate) {
  const rule = circRule(readerCategory(readerId));
  const per = Number(rule.suspend_per_day) || 0;
  if (per <= 0 || !dueDate || !inDate || inDate <= dueDate) return null;
  const rawDaysLate = Math.max(0, Math.round((new Date(inDate) - new Date(dueDate)) / 864e5));
  const effDaysLate = Math.max(0, rawDaysLate - closedDaysBetween(dueDate, inDate));
  if (effDaysLate <= 0) return null;
  const penalty = Math.min(Math.ceil(effDaysLate * per), rule.suspend_max || 90);
  const r = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId);
  const base = (r && r.suspended_until && r.suspended_until > today()) ? r.suspended_until : today();
  const until = new Date(base);
  until.setDate(until.getDate() + penalty);
  const untilStr = until.toISOString().slice(0, 10);
  db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run(untilStr, readerId);
  logAudit('Наложено наказание', 'преустановено заемане до ' + untilStr + ' (' + effDaysLate + ' работни дни забава)');
  return untilStr;
}
function checkSuspended(readerId) {
  const r = db.prepare('SELECT name, suspended_until FROM readers WHERE id = ?').get(readerId);
  if (r && r.suspended_until && r.suspended_until > today()) {
    throw new Error('Заемането за ' + r.name + ' е преустановено до ' + r.suspended_until.split('-').reverse().join('.') +
      ' заради просрочени връщания. Наказанието се сваля от картона на читателя.');
  }
}

/* ---------------- Резервации ----------------
   Извадени в handlers/holds.js (Фаза 4, стъпка 21 от разбиването на
   монолита main.js на модули по домейн). firstActiveHold/
   consumeHoldOnCheckout/activateHoldOnReturn се връщат обратно тук, защото
   ги ползва и домейнът "Заемания" по-долу (все още неизваден). */
const { firstActiveHold, consumeHoldOnCheckout, activateHoldOnReturn } =
  require('./handlers/holds')(ipcMain, { getDb: () => db, run, logAudit });

ipcMain.handle('loans:list', (e, { onlyOpen } = {}) =>
  run(() => {
    if (onlyOpen) return db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL ORDER BY l.date_due`).all();
    return db.prepare(`${LOAN_SELECT} ORDER BY l.date_out DESC`).all();
  })
);
ipcMain.handle('loans:overdue', () =>
  run(() => db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.date_due`).all())
);
ipcMain.handle('loans:byReader', (e, readerId) =>
  run(() => db.prepare(`${LOAN_SELECT} WHERE l.reader_id = ? ORDER BY l.date_out DESC`).all(readerId))
);
// Насочена заявка за конкретна книга (напр. при сканиране на инвентарен номер
// в таблото) — вместо да се тегли ЦЯЛАТА история на заеманията (loans:list)
// само за да се филтрира по book_id на клиента (Фаза 2, поправка на dashLookup).
ipcMain.handle('loans:byBook', (e, bookId) =>
  run(() => db.prepare(`${LOAN_SELECT} WHERE l.book_id = ? ORDER BY l.date_out DESC`).all(bookId))
);
ipcMain.handle('loans:overdueByReader', () =>
  run(() => {
    const rows = db.prepare(`
      SELECT l.reader_id, r.name, r.address, r.address2, r.phone, r.email, SUM(1) AS n,
             SUM((julianday('now') - julianday(l.date_due)) * s.fine_per_day) AS fine
      FROM loans l JOIN readers r ON r.id = l.reader_id, settings s
      WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') AND s.id = 1
      GROUP BY l.reader_id
    `).all();
    const detail = db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.reader_id, l.date_due`).all();
    rows.forEach(r => { r.loans = detail.filter(d => d.reader_id === r.reader_id); });
    return rows;
  })
);
ipcMain.handle('loans:checkout', (e, { reader_id, book_id, date_out, date_due }) =>
  run(() => {
    const tx = db.transaction(() => {
      const inv = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(book_id);
      const outCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(book_id).n;
      const qty = inv ? inv.quantity : 0;
      if (outCount >= qty) throw new Error('Няма свободни бройки от тази книга.');
      checkSuspended(reader_id);
      consumeHoldOnCheckout(book_id, reader_id);
      const info = db.prepare(`
        INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)
      `).run(reader_id, book_id, date_out, date_due || null);
      const b = db.prepare('SELECT title, inv_number FROM books WHERE id = ?').get(book_id);
      logAudit('Заемане', 'инв. № ' + (b ? b.inv_number : '') + ' — ' + (b ? b.title : ''));
      logEvent('заемане', { bookId: book_id, readerId: reader_id, date: date_out });
      return info.lastInsertRowid;
    });
    const id = tx();
    scheduleCatalogWrite();
    return id;
  })
);
ipcMain.handle('loans:return', (e, { id, date_in }) =>
  run(() => {
    db.prepare('UPDATE loans SET date_in = ? WHERE id = ?').run(date_in, id);
    const l = db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id);
    if (l) logAudit('Връщане', 'инв. № ' + l.inv_number + ' — ' + l.title);
    const hold = l ? activateHoldOnReturn(l.book_id) : null;
    let suspendedUntil = null;
    if (l) {
      logEvent('връщане', { bookId: l.book_id, readerId: l.reader_id, date: date_in });
      suspendedUntil = applySuspension(l.reader_id, l.date_due, date_in);
    }
    scheduleCatalogWrite();
    return {
      hold: hold ? { reader_name: hold.reader_name, card_no: hold.card_no, phone: hold.phone } : null,
      suspendedUntil
    };
  })
);
ipcMain.handle('loans:extend', (e, { id }) =>
  run(() => {
    const l = db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!l || l.date_in) throw new Error('Заемането не е активно.');
    const s = circRule(readerCategory(l.reader_id));
    const max = s.extensions_count == null ? 2 : s.extensions_count; // 0 = без лимит
    const used = l.renewals || 0;
    if (max && used >= max) throw new Error('Достигнат е лимитът от ' + max + ' продължения за това заемане.');
    const h = firstActiveHold(l.book_id);
    if (h && h.reader_id !== l.reader_id) {
      throw new Error('Книгата е резервирана от ' + h.reader_name + ' — срокът не може да се продължи.');
    }
    const base = l.date_due || today();
    const next = new Date(base);
    next.setDate(next.getDate() + (s.extension_days || 30));
    const newDue = nextWorkDay(next.toISOString().slice(0, 10));
    db.prepare('UPDATE loans SET date_due = ?, renewals = ? WHERE id = ?').run(newDue, used + 1, id);
    logAudit('Продължение на заемане', 'заемане № ' + id + ' до ' + newDue + ' (' + (used + 1) + (max ? '/' + max : '') + ')');
    logEvent('подновяване', { bookId: l.book_id, readerId: l.reader_id });
    return { date_due: newDue, renewals: used + 1, max };
  })
);

/* Заемане и връщане чрез баркод четец — четецът въвежда текст и Enter, точно
   както при физическа клавиатура, затова тук се приема inv. номер или баркод. */
ipcMain.handle('loans:checkoutByCode', (e, { reader_id, code, date_out }) =>
  run(() => {
    const tx = db.transaction(() => {
      const b = db.prepare(`${BOOK_SELECT} WHERE b.barcode = ? OR b.inv_number = CAST(? AS INTEGER)`).get(code, code);
      if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
      if (b.status === 'отчислен') throw new Error('Инв. № ' + b.inv_number + ' е отчислен от фонда.');
      const openLoan = db.prepare(`${LOAN_SELECT} WHERE l.book_id = ? AND l.date_in IS NULL`).get(b.id);
      if (openLoan) throw new Error('Инв. № ' + b.inv_number + ' вече е зает от ' + openLoan.reader_name + ' до ' + openLoan.date_due + '.');
      const s = circRule(readerCategory(reader_id));
      const current = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ? AND date_in IS NULL').get(reader_id).n;
      if (s.max_books && current >= s.max_books) throw new Error('Достигнат е лимитът от ' + s.max_books + ' документа за читател.');
      checkSuspended(reader_id);
      consumeHoldOnCheckout(b.id, reader_id);
      const out = date_out || today();
      const due = new Date(out); due.setDate(due.getDate() + (s.loan_days || 30));
      const dueStr = nextWorkDay(due.toISOString().slice(0, 10));
      const info = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(reader_id, b.id, out, dueStr);
      logAudit('Заемане', 'инв. № ' + b.inv_number + ' — ' + b.title);
      logEvent('заемане', { bookId: b.id, readerId: reader_id, date: out });
      return { id: info.lastInsertRowid, title: b.title, inv_number: b.inv_number, date_due: dueStr };
    });
    const result = tx();
    scheduleCatalogWrite();
    return result;
  })
);
ipcMain.handle('loans:returnByCode', (e, { code, date_in }) =>
  run(() => {
    const b = db.prepare('SELECT * FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)').get(code, code);
    if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
    const loan = db.prepare(`${LOAN_SELECT} WHERE l.book_id = ? AND l.date_in IS NULL`).get(b.id);
    if (!loan) throw new Error('Инв. № ' + b.inv_number + ' не е заето в момента.');
    const inDate = date_in || today();
    const s = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get();
    const daysLate = loan.date_due ? Math.max(0, Math.round((new Date(inDate) - new Date(loan.date_due)) / 864e5)) : 0;
    const fine = daysLate * (s.fine_per_day || 0);
    db.prepare('UPDATE loans SET date_in = ?, fine = ? WHERE id = ?').run(inDate, fine, loan.id);
    logAudit('Връщане', 'инв. № ' + b.inv_number + ' — ' + b.title + (daysLate ? ' (забава ' + daysLate + ' дни)' : ''));
    logEvent('връщане', { bookId: b.id, readerId: loan.reader_id, date: inDate });
    const suspendedUntil = applySuspension(loan.reader_id, loan.date_due, inDate);
    const hold = activateHoldOnReturn(b.id);
    scheduleCatalogWrite();
    return {
      title: b.title, inv_number: b.inv_number, reader_name: loan.reader_name, daysLate, fine, suspendedUntil,
      hold: hold ? { reader_name: hold.reader_name, card_no: hold.card_no, phone: hold.phone } : null
    };
  })
);

/* ---------------- Табло ---------------- */
ipcMain.handle('dashboard:stats', () =>
  run(() => ({
    books: db.prepare("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен'").get().n,
    readers: db.prepare("SELECT COUNT(*) AS n FROM readers WHERE status != 'прекратен'").get().n,
    loansOpen: db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n,
    overdue: db.prepare(`
      SELECT COUNT(*) AS n FROM loans
      WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')
    `).get().n
  }))
);
ipcMain.handle('dashboard:full', () =>
  run(() => {
    const y = yearOf();
    const fund = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS v FROM books WHERE status != 'отчислен'").get();
    const activeReaders = db.prepare("SELECT COUNT(*) AS n FROM readers WHERE status != 'прекратен'").get().n;
    const loansOpen = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n;
    const overdueRows = db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.date_due LIMIT 7`).all();
    const overdueCount = db.prepare(`SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')`).get().n;
    const acquiredYear = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE substr(register_date,1,4) = ?`).get(y).n;
    const deaccessionedYear = db.prepare(`
      SELECT COUNT(*) AS n FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
    `).get(y).n;
    const loansYear = db.prepare(`SELECT COUNT(*) AS n FROM loans WHERE substr(date_out,1,4) = ?`).get(y).n;
    const readersYear = db.prepare(`SELECT COUNT(*) AS n FROM readers WHERE substr(registered_at,1,4) = ? OR substr(re_registered_at,1,4) = ?`).get(y, y).n;
    const active = fund.n;
    const pct = pctRequired(active);
    const target = Math.ceil(active * pct / 100);
    const scannedYear = db.prepare(`
      SELECT COUNT(*) AS n FROM inventory_session_scans sc JOIN inventory_sessions s ON s.id = sc.session_id
      WHERE substr(s.date,1,4) = ?
    `).get(y).n;
    const upcoming = db.prepare(`
      ${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL
      AND l.date_due >= date('now') AND julianday(l.date_due) - julianday('now') <= 3
      ORDER BY l.date_due
    `).all();
    const holdsReady = db.prepare("SELECT COUNT(*) AS n FROM holds WHERE status = 'заделена'").get().n;
    const holdsWaiting = db.prepare("SELECT COUNT(*) AS n FROM holds WHERE status = 'чака'").get().n;
    /* „За днес" — работният списък на библиотекаря (десктоп-аналог на cron задачите
       на Koha): наближаващи падежи, дължими пререгистрации, много дълги просрочия
       (кандидати за „липсваща"), записи за анонимизиране. */
    const reregDue = db.prepare(`
      SELECT COUNT(*) AS n FROM readers
      WHERE status = 'активен' AND name != '— анонимизирани заемания —'
        AND date(COALESCE(re_registered_at, registered_at), '+1 year') <= date('now', '+14 days')
    `).get().n;
    const longOverdue = db.prepare(`
      SELECT COUNT(*) AS n FROM loans
      WHERE date_in IS NULL AND date_due IS NOT NULL AND julianday('now') - julianday(date_due) > 60
    `).get().n;
    const sAnon = db.prepare('SELECT anonymize_years FROM settings WHERE id = 1').get() || {};
    const anonYears = parseInt(sAnon.anonymize_years, 10) || 0;
    let anonCandidates = 0;
    if (anonYears) {
      anonCandidates = db.prepare(`SELECT COUNT(*) AS n FROM loans
        WHERE date_in IS NOT NULL AND date_in < ? AND anon_category IS NULL`)
        .get(`${new Date().getFullYear() - anonYears}-01-01`).n;
    }
    const suspendedNow = db.prepare(`SELECT COUNT(*) AS n FROM readers WHERE suspended_until > date('now')`).get().n;
    const isTodayOpen = isWorkDay(today());
    return {
      fundCount: fund.n, fundValue: fund.v, activeReaders, loansOpen, overdueCount, overdueRows,
      year: y, acquiredYear, deaccessionedYear, loansYear, readersYear,
      inventoryTarget: target, inventoryScannedYear: scannedYear, inventoryPct: pct,
      upcoming, holdsReady, holdsWaiting,
      today: { reregDue, longOverdue, anonCandidates, suspendedNow, isTodayOpen }
    };
  })
);

/* ---------------- Инвентаризация ---------------- */
ipcMain.handle('inventorySessions:list', () =>
  run(() => db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM inventory_session_scans sc WHERE sc.session_id = s.id) AS scanned,
           (SELECT COUNT(*) FROM inventory_session_missing m WHERE m.session_id = s.id) AS missing
    FROM inventory_sessions s ORDER BY s.date DESC
  `).all())
);
ipcMain.handle('inventorySessions:requirement', () =>
  run(() => {
    const active = db.prepare("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен'").get().n;
    const s = db.prepare('SELECT free_access_pct FROM settings WHERE id = 1').get();
    const pct = pctRequired(active);
    return { active, pct, target: Math.ceil(active * pct / 100), naturalLoss: naturalLoss(active, s.free_access_pct) };
  })
);
ipcMain.handle('inventorySessions:start', (e, s) =>
  run(() => {
    const pool = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен' ${s.department ? 'AND department = @department' : ''}`)
      .get(s.department ? { department: s.department } : {});
    const info = db.prepare(`
      INSERT INTO inventory_sessions (date, scope, department, committee1, committee2, committee3, pool_size, closed)
      VALUES (@date, @scope, @department, @committee1, @committee2, @committee3, @pool_size, 0)
    `).run(Object.assign({}, s, { department: s.department || null, pool_size: pool.n }));
    return info.lastInsertRowid;
  })
);
ipcMain.handle('inventorySessions:get', (e, id) =>
  run(() => {
    const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(id);
    if (!s) return null;
    s.scans = db.prepare(`
      SELECT sc.*, b.inv_number, b.title FROM inventory_session_scans sc
      JOIN books b ON b.id = sc.book_id WHERE sc.session_id = ? ORDER BY sc.scanned_at DESC
    `).all(id);
    s.missing = db.prepare('SELECT * FROM inventory_session_missing WHERE session_id = ?').all(id);
    return s;
  })
);
ipcMain.handle('inventorySessions:scan', (e, { sessionId, code }) =>
  run(() => {
    const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
    if (!s || s.closed) throw new Error('Няма отворена сесия за инвентаризация.');
    const b = db.prepare(`SELECT * FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)`).get(code, code);
    if (!b) throw new Error('Непознат баркод/инв. № ' + code);
    const already = db.prepare('SELECT 1 FROM inventory_session_scans WHERE session_id = ? AND book_id = ?').get(sessionId, b.id);
    if (already) throw new Error('Инв. № ' + b.inv_number + ' вече е сканиран.');
    db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(sessionId, b.id);
    db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(b.id, s.date);
    db.prepare("UPDATE books SET datelastseen = datetime('now') WHERE id = ?").run(b.id);
    if (b.status === 'липсващ') db.prepare("UPDATE books SET status='наличен', status_date=date('now') WHERE id=?").run(b.id);
    return { inv_number: b.inv_number, title: b.title };
  })
);
ipcMain.handle('inventorySessions:close', (e, sessionId) =>
  run(() => {
    const tx = db.transaction(() => {
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
      if (!s) throw new Error('Няма такава сесия.');
      const scannedIds = db.prepare('SELECT book_id FROM inventory_session_scans WHERE session_id = ?').all(sessionId).map(r => r.book_id);
      const placeholders = scannedIds.length ? scannedIds.map(() => '?').join(',') : 'NULL';
      const pool = db.prepare(`SELECT * FROM books WHERE status != 'отчислен' ${s.department ? 'AND department = ?' : ''}`)
        .all(...(s.department ? [s.department] : []));
      const openLoanIds = new Set(db.prepare('SELECT book_id FROM loans WHERE date_in IS NULL').all().map(r => r.book_id));
      const missing = pool.filter(b => !scannedIds.includes(b.id) && !openLoanIds.has(b.id));
      const insMissing = db.prepare(`
        INSERT INTO inventory_session_missing (session_id, book_id, inv_number, title, author, price)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      missing.forEach(b => {
        insMissing.run(sessionId, b.id, b.inv_number, b.title, b.author, b.price);
        if (b.status !== 'отчислен') db.prepare("UPDATE books SET status='липсващ', status_date=date('now') WHERE id=?").run(b.id);
      });
      db.prepare('UPDATE inventory_sessions SET closed = 1 WHERE id = ?').run(sessionId);
      logAudit('Инвентаризация', 'проверени ' + scannedIds.length + ', липсващи ' + missing.length + ' от ' + pool.length);
      const s2 = db.prepare('SELECT free_access_pct FROM settings WHERE id = 1').get();
      return {
        scanned: scannedIds.length, missing: missing.length, pool: pool.length,
        allowedLoss: naturalLoss(pool.length, s2.free_access_pct)
      };
    });
    return tx();
  })
);

/* ---------------- Просрочени: напомняния ----------------
   Текстовете се сглобяват тук, за да са еднакви на всички работни места, а
   изпращането остава ръчно: библиотекарят преглежда и решава. Шаблоните
   (subject/body/sms) се редактират в Настройки — плейсхолдъри във фигурни
   скоби, вижте DEFAULT_NOTICE_*. Празна настройка = стойността по подразбиране,
   затова нищо не се променя за инсталации, които не са пипали шаблона. */
const DEFAULT_NOTICE_SUBJECT = 'Просрочени материали от {library}';
const DEFAULT_NOTICE_BODY =
`Уважаем(а) {reader},

Според регистъра на {library} при Вас има {count_phrase}:

{list}
{fine_line}
{level_line}Молим да ги върнете при първа възможност или да заявите удължаване на срока.

С уважение,
{librarian_line}{library}{place_line}`;
const DEFAULT_NOTICE_SMS = '{library_short}: имате {count_phrase}{fine_sms}. Моля, върнете {it_them}.';
const NOTICE_PLACEHOLDERS = [
  ['reader', 'име на читателя'], ['library', 'име на библиотеката'],
  ['library_short', 'скъсено име (за SMS, до 40 знака)'],
  ['count', 'брой просрочени (само числото)'],
  ['count_phrase', 'напр. „3 просрочени документа“'],
  ['it_them', '„го“ или „ги“, според броя'],
  ['list', 'списък на просрочените документи'],
  ['fine', 'сума на обезщетението, напр. „1.23 лв. (0.63 €)“'],
  ['fine_line', 'ред с обезщетението (или празно, ако е 0)'],
  ['fine_sms', ', обезщетение ... лв (или празно, ако е 0)'],
  ['librarian', 'име на библиотекаря'], ['librarian_line', 'библиотекар + нов ред (или празно)'],
  ['place', 'населено място'], ['place_line', 'нов ред + място (или празно)'],
  ['date', 'днешна дата'],
  ['level', 'степен на напомнянето: 1, 2 или 3'],
  ['level_line', 'ред „Това е ВТОРО/ТРЕТО напомняне…“ (празно при първо)']
];
/* Тонът се покачва със степента: първото напомняне е любезна подкана, третото
   предупреждава за преустановяване на заемането. Степента идва от давността на
   най-старото просрочие (праговете remind2_days/remind3_days в Настройки). */
const LEVEL_LINES = {
  1: '',
  2: 'Това е ВТОРО напомняне.\n\n',
  3: 'Това е ТРЕТО напомняне. При ново неизпълнение достъпът до заемане ще бъде временно преустановен.\n\n'
};
function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
function reminderTexts(r, s) {
  const lib = s.lib_name || s.org || 'библиотеката';
  const list = (r.loans || []).map(l =>
    `• ${[l.author, l.title].filter(Boolean).join('. ')} (инв. № ${l.inv_number ?? '—'}), срок ${bgDate(l.date_due)}`
  ).join('\n');
  const fine = Number(r.fine || 0);
  const one = r.n === 1;
  const shortLib = lib.length > 40 ? lib.slice(0, 37).trim() + '…' : lib;
  const vars = {
    reader: r.name, library: lib, library_short: shortLib,
    count: r.n, count_phrase: `${r.n} просрочен${one ? ' документ' : 'и документа'}`,
    it_them: one ? 'го' : 'ги', list,
    fine: fine > 0 ? `${fine.toFixed(2)} лв. (${(fine / EUR_RATE).toFixed(2)} €)` : '',
    fine_line: fine > 0 ? `\nНачислено обезщетение към днешна дата: ${fine.toFixed(2)} лв. (${(fine / EUR_RATE).toFixed(2)} €).` : '',
    fine_sms: fine > 0 ? `, обезщетение ${fine.toFixed(2)} лв` : '',
    librarian: s.librarian || '', librarian_line: s.librarian ? s.librarian + '\n' : '',
    place: s.place || '', place_line: s.place ? '\n' + s.place : '',
    date: bgDate(today()),
    level: r.level || 1, level_line: LEVEL_LINES[r.level] || ''
  };
  return {
    subject: fillTemplate(s.notice_subject || DEFAULT_NOTICE_SUBJECT, vars),
    body: fillTemplate(s.notice_body || DEFAULT_NOTICE_BODY, vars),
    sms: fillTemplate(s.notice_sms || DEFAULT_NOTICE_SMS, vars)
  };
}
const bgDate = (d) => d ? String(d).split('-').reverse().join('.') : '';
ipcMain.handle('loans:reminders', () =>
  run(() => {
    const s = db.prepare(`SELECT lib_name, org, place, librarian, notice_subject, notice_body, notice_sms,
      remind2_days, remind3_days FROM settings WHERE id = 1`).get() || {};
    const rows = db.prepare(`
      SELECT l.reader_id, r.name, r.phone, r.email, COUNT(*) AS n,
             MIN(l.date_due) AS oldest_due,
             SUM((julianday('now') - julianday(l.date_due)) * st.fine_per_day) AS fine
      FROM loans l JOIN readers r ON r.id = l.reader_id, settings st
      WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') AND st.id = 1
      GROUP BY l.reader_id ORDER BY r.name
    `).all();
    const detail = db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.date_due`).all();
    const d2 = s.remind2_days == null ? 14 : s.remind2_days, d3 = s.remind3_days == null ? 30 : s.remind3_days;
    const lastNoticeQ = db.prepare(`SELECT level, ts FROM notice_log WHERE reader_id = ? ORDER BY ts DESC LIMIT 1`);
    for (const r of rows) {
      r.loans = detail.filter(d => d.reader_id === r.reader_id);
      const overdueDays = Math.round((new Date(today()) - new Date(r.oldest_due)) / 864e5);
      r.level = overdueDays >= d3 ? 3 : overdueDays >= d2 ? 2 : 1;
      const last = lastNoticeQ.get(r.reader_id);
      // Показва се само напомняне, изпратено ПО ТЕКУЩОТО просрочие — старите не броят.
      r.lastNotice = (last && last.ts >= r.oldest_due) ? { level: last.level, ts: last.ts } : null;
      Object.assign(r, reminderTexts(r, s));
    }
    return rows;
  })
);
/* Отбелязва, че напомняне е реално минало към читателя (печат/копиране/поща) —
   така се вижда кой на коя степен е и повторните не се дублират на сляпо. */
ipcMain.handle('notices:log', (e, { reader_id, level, channel, loans_count }) =>
  run(() => {
    db.prepare('INSERT INTO notice_log (reader_id, level, channel, loans_count) VALUES (?, ?, ?, ?)')
      .run(reader_id, level || 1, channel || null, loans_count || 0);
    return true;
  })
);
// Отваря пощенския клиент на потребителя. Адресът се сглобява тук, за да не се
// налага интерфейсът да навигира към mailto:, което Electron би отворил в прозореца.
// Груба, но достатъчна проверка на формата на имейла (Фаза 3, сигурност) — схемата
// на URL-а е фиксирана буквално на 'mailto:' (не идва от полето), но валидирането
// пази от подаване на съвсем несвързан низ от читателската картотека към
// shell.openExternal, а не само от техническа коректност на адреса (виж
// security-utils.js за isValidEmail).
ipcMain.handle('loans:mailto', (e, { email, subject, body }) => {
  try {
    if (!email) return { ok: false, error: 'Читателят няма записан имейл.' };
    if (!isValidEmail(email)) return { ok: false, error: 'Записаният имейл не изглежда валиден.' };
    const url = 'mailto:' + encodeURIComponent(email) +
      '?subject=' + encodeURIComponent(subject || '') +
      '&body=' + encodeURIComponent(body || '');
    shell.openExternal(url);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

/* ---------------- Периодика ---------------- */
ipcMain.handle('periodicals:list', () =>
  run(() => db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM periodical_issues i WHERE i.periodical_id = p.id) AS issue_count
    FROM periodicals p ORDER BY p.title
  `).all())
);
ipcMain.handle('periodicals:get', (e, id) =>
  run(() => {
    const p = db.prepare('SELECT * FROM periodicals WHERE id = ?').get(id);
    if (!p) return null;
    p.issues = db.prepare('SELECT * FROM periodical_issues WHERE periodical_id = ? ORDER BY date DESC').all(id);
    return p;
  })
);
ipcMain.handle('periodicals:create', (e, p) =>
  run(() => {
    const info = db.prepare(`
      INSERT INTO periodicals (title, freq, publisher, issn, department, note)
      VALUES (@title, @freq, @publisher, @issn, @department, @note)
    `).run({ title: p.title, freq: p.freq || null, publisher: p.publisher || null, issn: p.issn || null, department: p.department || null, note: p.note || null });
    logAudit('Ново периодично издание', p.title);
    return info.lastInsertRowid;
  })
);
ipcMain.handle('periodicals:update', (e, p) =>
  run(() => {
    db.prepare(`
      UPDATE periodicals SET title=@title, freq=@freq, publisher=@publisher, issn=@issn, department=@department, note=@note
      WHERE id=@id
    `).run(p);
    logAudit('Редакция на периодично издание', p.title);
  })
);
ipcMain.handle('periodicals:delete', (e, id) =>
  run(() => {
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ?').get(id).n;
    if (cnt > 0) throw new Error('Изданието има вписани броеве и не може да бъде изтрито.');
    db.prepare('DELETE FROM periodicals WHERE id = ?').run(id);
  })
);
ipcMain.handle('periodicalIssues:add', (e, issue) =>
  run(() => {
    const info = db.prepare(`
      INSERT INTO periodical_issues (periodical_id, issue_no, date, price, note)
      VALUES (@periodical_id, @issue_no, @date, @price, @note)
    `).run({ periodical_id: issue.periodical_id, issue_no: issue.issue_no, date: issue.date || today(), price: issue.price ? parseFloat(issue.price) : 0, note: issue.note || null });
    logAudit('Постъпил брой', 'бр. ' + issue.issue_no);
    return info.lastInsertRowid;
  })
);
ipcMain.handle('periodicalIssues:delete', (e, id) =>
  run(() => db.prepare('DELETE FROM periodical_issues WHERE id = ?').run(id))
);

/* ---------------- МЗС ---------------- */
ipcMain.handle('mzs:list', () => run(() => db.prepare('SELECT * FROM mzs_requests ORDER BY date DESC, no DESC').all()));
ipcMain.handle('mzs:nextNo', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const row = db.prepare('SELECT MAX(no) AS m FROM mzs_requests WHERE year = ?').get(y);
    return (row.m || 0) + 1;
  })
);
ipcMain.handle('mzs:create', (e, m) =>
  run(() => {
    const info = db.prepare(`
      INSERT INTO mzs_requests (no, year, date, direction, partner, author, title, isbn, requester, status, due_date, note)
      VALUES (@no, @year, @date, @direction, @partner, @author, @title, @isbn, @requester, @status, @due_date, @note)
    `).run({
      no: parseInt(m.no, 10), year: yearOf(m.date), date: m.date, direction: m.direction || 'изходящо',
      partner: m.partner, author: m.author || null, title: m.title, isbn: m.isbn || null,
      requester: m.requester || null, status: m.status || 'заявено', due_date: m.due_date || null, note: m.note || null
    });
    logAudit('Нова МЗС заявка', '№ ' + m.no + ' — ' + m.title + ' (' + m.direction + ')');
    return info.lastInsertRowid;
  })
);
ipcMain.handle('mzs:update', (e, m) =>
  run(() => {
    db.prepare(`
      UPDATE mzs_requests SET direction=@direction, partner=@partner, author=@author, title=@title, isbn=@isbn,
        requester=@requester, status=@status, due_date=@due_date, note=@note WHERE id=@id
    `).run(m);
    logAudit('Редакция на МЗС заявка', '№ ' + m.no + ' — ' + m.title);
  })
);
ipcMain.handle('mzs:delete', (e, id) => run(() => db.prepare('DELETE FROM mzs_requests WHERE id = ?').run(id)));

/* ---------------- Дневник на библиотеката (Раздел А / Раздел Б) ----------------
   Електронен вариант на официалния месечен статистически дневник. Един ред в
   dnevnik_days на календарен ден; месечните и годишните (от началото на
   годината) тотали НЕ се пазят — смятат се живо със SUM() при всяко зареждане,
   за да остават винаги верни, независимо кой ден е бил редактиран последно. */
const DNEVNIK_A_FIELDS = [
  'a_hours', 'a_age_u14', 'a_age_15_18', 'a_age_19_28', 'a_age_o28',
  'a_sex_boys', 'a_sex_men', 'a_sex_girls', 'a_sex_women',
  'a_edu_basic', 'a_edu_sec', 'a_edu_high',
  'a_prof_industry', 'a_prof_agri', 'a_prof_eng', 'a_prof_agrospec', 'a_prof_med', 'a_prof_sci',
  'a_prof_hum', 'a_prof_creative', 'a_prof_teach', 'a_prof_other',
  'a_stud_uni', 'a_stud_high', 'a_stud_sec', 'a_stud_elem',
  'a_visit_home', 'a_visit_child', 'a_visit_reading', 'a_visit_internet'
];
const DNEVNIK_B_FIELDS = [
  'b_hours',
  'b_type_books', 'b_type_period', 'b_type_graphic', 'b_type_carto', 'b_type_music',
  'b_type_audio', 'b_type_video', 'b_type_electronic', 'b_type_dvd', 'b_type_talking',
  'b_lang_bg', 'b_lang_ru', 'b_lang_slavic', 'b_lang_en', 'b_lang_de', 'b_lang_fr', 'b_lang_other',
  'b_cat_0', 'b_cat_1', 'b_cat_2', 'b_cat_3', 'b_cat_5', 'b_cat_61', 'b_cat_62', 'b_cat_63',
  'b_cat_7', 'b_cat_793', 'b_cat_80', 'b_cat_82', 'b_cat_9', 'b_cat_91',
  'b_cat_fiction', 'b_cat_child_nf', 'b_cat_child_f', 'b_cat_reading_used'
];
const DNEVNIK_FIELDS = [...DNEVNIK_A_FIELDS, ...DNEVNIK_B_FIELDS];

function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
function dnevnikTotals(row) {
  const g = (k) => (row ? (row[k] || 0) : 0);
  const a_total_age = g('a_age_u14') + g('a_age_15_18') + g('a_age_19_28') + g('a_age_o28');
  const a_total_sex = g('a_sex_boys') + g('a_sex_men') + g('a_sex_girls') + g('a_sex_women');
  const a_total_edu = g('a_age_u14') + g('a_age_15_18') + g('a_edu_basic') + g('a_edu_sec') + g('a_edu_high');
  const a_total_prof = g('a_prof_industry') + g('a_prof_agri') + g('a_prof_eng') + g('a_prof_agrospec') +
    g('a_prof_med') + g('a_prof_sci') + g('a_prof_hum') + g('a_prof_creative') + g('a_prof_teach') + g('a_prof_other') +
    g('a_stud_uni') + g('a_stud_high') + g('a_stud_sec') + g('a_stud_elem');
  const b_total_type = DNEVNIK_B_FIELDS.filter(f => f.startsWith('b_type_')).reduce((s, f) => s + g(f), 0);
  const b_total_lang = DNEVNIK_B_FIELDS.filter(f => f.startsWith('b_lang_')).reduce((s, f) => s + g(f), 0);
  const b_total_content = ['b_cat_0', 'b_cat_1', 'b_cat_2', 'b_cat_3', 'b_cat_5', 'b_cat_61', 'b_cat_62', 'b_cat_63',
    'b_cat_7', 'b_cat_793', 'b_cat_80', 'b_cat_82', 'b_cat_9', 'b_cat_91',
    'b_cat_fiction', 'b_cat_child_nf', 'b_cat_child_f'].reduce((s, f) => s + g(f), 0);
  return { a_total_age, a_total_sex, a_total_edu, a_total_prof, b_total_type, b_total_lang, b_total_content };
}
function dnevnikSumRow(rows) {
  const sum = {};
  DNEVNIK_FIELDS.forEach(f => { sum[f] = rows.reduce((s, r) => s + (r[f] || 0), 0); });
  return Object.assign(sum, dnevnikTotals(sum));
}
ipcMain.handle('dnevnik:getMonth', (e, { year, month }) =>
  run(() => {
    const y = parseInt(year, 10), m = parseInt(month, 10);
    const dim = daysInMonth(y, m);
    const pad = (n) => String(n).padStart(2, '0');
    const from = `${y}-${pad(m)}-01`, to = `${y}-${pad(m)}-${pad(dim)}`;
    const rows = db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to);
    const byDate = {}; rows.forEach(r => { byDate[r.date] = r; });
    const days = [];
    for (let d = 1; d <= dim; d++) {
      const date = `${y}-${pad(m)}-${pad(d)}`;
      const row = byDate[date] || { date };
      days.push(Object.assign({ day: d, date }, row, dnevnikTotals(row)));
    }
    const monthTotal = dnevnikSumRow(rows);
    const ytdRows = db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ?').all(`${y}-01-01`, to);
    const ytdTotal = dnevnikSumRow(ytdRows);
    return { year: y, month: m, daysInMonth: dim, days, monthTotal, ytdTotal };
  })
);
ipcMain.handle('dnevnik:saveDay', (e, d) =>
  run(() => {
    const payload = { date: d.date };
    DNEVNIK_FIELDS.forEach(f => { payload[f] = parseInt(d[f], 10) || 0; });
    payload.note = d.note || null;
    db.prepare(`
      INSERT INTO dnevnik_days (date, ${DNEVNIK_FIELDS.join(',')}, note)
      VALUES (@date, ${DNEVNIK_FIELDS.map(f => '@' + f).join(',')}, @note)
      ON CONFLICT(date) DO UPDATE SET
        ${DNEVNIK_FIELDS.map(f => f + '=excluded.' + f).join(',')}, note=excluded.note
    `).run(payload);
    logAudit('Дневник', 'вписан ден ' + d.date);
  })
);
/* Предложени стойности за един ден на дневника, изведени от потока събития (events).
   Ръчното въвеждане ОСТАВА меродавно — официалният формуляр се потвърждава от
   библиотекаря; тук програмата само предлага числата, които може да изведе сама:
   Раздел Б по вид/език/съдържание от заеманията, посещенията в читалня и по домовете,
   и разпределението на читателите по възрастови категории. */
const DNEVNIK_TYPE_MAP = {
  'книга': 'b_type_books', 'продължаващо издание': 'b_type_period', 'графично издание': 'b_type_graphic',
  'картографско издание': 'b_type_carto', 'нотно издание': 'b_type_music', 'аудиодокумент': 'b_type_audio',
  'видеодокумент': 'b_type_video', 'електронен документ': 'b_type_electronic'
};
const DNEVNIK_LANG_MAP = {
  'български': 'b_lang_bg', 'руски': 'b_lang_ru', 'английски': 'b_lang_en',
  'немски': 'b_lang_de', 'френски': 'b_lang_fr'
};
// Проверява се от най-дългия префикс към най-късия — иначе „793" би хванало „7".
const DNEVNIK_UDK_PREFIXES = [
  ['793', 'b_cat_793'], ['799', 'b_cat_793'], ['91', 'b_cat_91'], ['80', 'b_cat_80'],
  ['82', 'b_cat_82'], ['61', 'b_cat_61'], ['62', 'b_cat_62'], ['63', 'b_cat_63'],
  ['64', 'b_cat_62'], ['69', 'b_cat_62'], ['0', 'b_cat_0'], ['1', 'b_cat_1'], ['2', 'b_cat_2'],
  ['3', 'b_cat_3'], ['5', 'b_cat_5'], ['7', 'b_cat_7'], ['9', 'b_cat_9']
];
const DNEVNIK_AGE_MAP = {
  'дете до 14 г.': 'a_age_u14', 'ученик': 'a_age_15_18', 'студент': 'a_age_19_28'
};
ipcMain.handle('dnevnik:suggest', (e, { date }) =>
  run(() => {
    const events = db.prepare('SELECT * FROM events WHERE date = ?').all(date);
    const out = {};
    const add = (k, n) => { if (k) out[k] = (out[k] || 0) + (n == null ? 1 : n); };
    const seenReaders = new Set();
    for (const ev of events) {
      if (ev.kind === 'читалня') { add('a_visit_reading'); continue; }
      if (ev.kind === 'дома') { add('a_visit_home'); continue; }
      if (ev.kind !== 'заемане') continue;
      // Раздел Б — по вид, език и съдържание, само за реално заетите този ден.
      add(DNEVNIK_TYPE_MAP[ev.book_category] || 'b_type_books');
      add(DNEVNIK_LANG_MAP[ev.book_language] || 'b_lang_other');
      const udk = String(ev.book_udk || '').trim();
      if (udk) {
        const hit = DNEVNIK_UDK_PREFIXES.find(([p]) => udk.startsWith(p));
        if (hit) add(hit[1]);
      }
      // Раздел А — всеки читател се брои веднъж на ден, по категорията му към момента.
      const rk = ev.reader_id || ('cat:' + ev.reader_category + ':' + ev.id);
      if (!seenReaders.has(rk)) {
        seenReaders.add(rk);
        add(DNEVNIK_AGE_MAP[ev.reader_category] || 'a_age_o28');
        if (ev.reader_category === 'дете до 14 г.') add('a_visit_child');
      }
    }
    return { date, suggestions: out, eventsCount: events.length };
  })
);
ipcMain.handle('dnevnik:exportCsv', async (e, { year, month }) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Експорт на дневника (CSV)',
      defaultPath: `dnevnik-${year}-${String(month).padStart(2, '0')}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
    const y = parseInt(year, 10), m = parseInt(month, 10);
    const dim = daysInMonth(y, m);
    const pad = (n) => String(n).padStart(2, '0');
    const rows = db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ? ORDER BY date')
      .all(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(dim)}`);
    const byDate = {}; rows.forEach(r => { byDate[r.date] = r; });
    const esc = (x) => '"' + String(x ?? '').replace(/"/g, '""') + '"';
    const h = ['Дата', ...DNEVNIK_FIELDS];
    const csv = [h.join(';')].concat(
      Array.from({ length: dim }, (_, i) => {
        const date = `${y}-${pad(m)}-${pad(i + 1)}`;
        const row = byDate[date] || {};
        return [date, ...DNEVNIK_FIELDS.map(f => row[f] || 0)].map(esc).join(';');
      })
    ).join('\r\n');
    fs.writeFileSync(filePath, '﻿' + csv, 'utf8');
    return { ok: true, data: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ============================================================================
   КРАЕВЕДСКИ МОДУЛИ: аналитично описание, персоналии, летопис
   ============================================================================ */

/* --- Аналитично описание (статии и части от книги) --- */
const ANALYTIC_FIELDS = ['title', 'subtitle', 'author', 'source_kind', 'periodical_id', 'book_id',
  'source_text', 'year', 'issue', 'issue_date', 'pages', 'udk', 'keywords', 'annotation',
  'is_local', 'note'];
// Източникът се сглобява за показване: или от свързания запис във фонда, или от
// свободния текст, когато изданието не е налично в библиотеката.
const ANALYTIC_SELECT = `
  SELECT a.*,
         p.title AS periodical_title,
         b.title AS book_title, b.author AS book_author, b.inv_number AS book_inv
  FROM analytics a
  LEFT JOIN periodicals p ON p.id = a.periodical_id
  LEFT JOIN books b ON b.id = a.book_id
`;
function analyticParams(d) {
  const o = {};
  for (const f of ANALYTIC_FIELDS) o[f] = d[f] ?? null;
  o.is_local = d.is_local ? 1 : 0;
  o.periodical_id = d.periodical_id || null;
  o.book_id = d.book_id || null;
  return o;
}
ipcMain.handle('analytics:list', (e, { q, year, onlyLocal } = {}) =>
  run(() => {
    const where = [], args = {};
    if (q) {
      where.push(`(a.title LIKE @q OR a.author LIKE @q OR a.keywords LIKE @q OR a.annotation LIKE @q
                   OR a.source_text LIKE @q OR p.title LIKE @q OR b.title LIKE @q)`);
      args.q = '%' + q + '%';
    }
    if (year) { where.push('a.year = @year'); args.year = String(year); }
    if (onlyLocal) where.push('a.is_local = 1');
    const sql = ANALYTIC_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY a.year DESC, a.title';
    return db.prepare(sql).all(args);
  })
);
ipcMain.handle('analytics:get', (e, id) =>
  run(() => db.prepare(`${ANALYTIC_SELECT} WHERE a.id = ?`).get(id))
);
ipcMain.handle('analytics:years', () =>
  run(() => db.prepare(`SELECT year, COUNT(*) AS n FROM analytics
    WHERE year IS NOT NULL AND year <> '' GROUP BY year ORDER BY year DESC`).all())
);
ipcMain.handle('analytics:create', (e, d) =>
  run(() => {
    const info = db.prepare(`INSERT INTO analytics (${ANALYTIC_FIELDS.join(', ')})
      VALUES (${ANALYTIC_FIELDS.map(f => '@' + f).join(', ')})`).run(analyticParams(d));
    logAudit('Аналитично описание', 'нова статия: ' + (d.title || ''));
    return info.lastInsertRowid;
  })
);
ipcMain.handle('analytics:update', (e, d) =>
  run(() => {
    db.prepare(`UPDATE analytics SET ${ANALYTIC_FIELDS.map(f => f + ' = @' + f).join(', ')} WHERE id = @id`)
      .run({ ...analyticParams(d), id: d.id });
    logAudit('Аналитично описание', 'редакция: ' + (d.title || ''));
  })
);
ipcMain.handle('analytics:delete', (e, id) =>
  run(() => {
    const a = db.prepare('SELECT title FROM analytics WHERE id = ?').get(id);
    db.transaction(() => {
      db.prepare("DELETE FROM links WHERE to_kind = 'статия' AND to_id = ?").run(id);
      db.prepare('DELETE FROM analytics WHERE id = ?').run(id);
    })();
    logAudit('Аналитично описание', 'изтрита статия: ' + (a ? a.title : id));
  })
);

/* --- Персоналии --- */
const PERSON_FIELDS = ['name', 'alt_names', 'birth_date', 'birth_place', 'death_date', 'death_place',
  'activity', 'bio', 'awards', 'sources', 'note'];
ipcMain.handle('persons:list', (e, q) =>
  run(() => {
    // Броят на свързаните материали се показва в списъка, за да личи кои
    // персоналии вече имат подкрепящи документи във фонда.
    const sql = `
      SELECT p.*, (SELECT COUNT(*) FROM links l WHERE l.from_kind = 'персона' AND l.from_id = p.id) AS links
      FROM persons p ${q ? 'WHERE p.name LIKE @q OR p.alt_names LIKE @q OR p.activity LIKE @q OR p.bio LIKE @q' : ''}
      ORDER BY p.name`;
    return db.prepare(sql).all(q ? { q: '%' + q + '%' } : {});
  })
);
ipcMain.handle('persons:get', (e, id) => run(() => db.prepare('SELECT * FROM persons WHERE id = ?').get(id)));
ipcMain.handle('persons:create', (e, d) =>
  run(() => {
    const o = {}; for (const f of PERSON_FIELDS) o[f] = d[f] ?? null;
    const info = db.prepare(`INSERT INTO persons (${PERSON_FIELDS.join(', ')})
      VALUES (${PERSON_FIELDS.map(f => '@' + f).join(', ')})`).run(o);
    logAudit('Персоналии', 'нова персоналия: ' + (d.name || ''));
    return info.lastInsertRowid;
  })
);
ipcMain.handle('persons:update', (e, d) =>
  run(() => {
    const o = {}; for (const f of PERSON_FIELDS) o[f] = d[f] ?? null;
    db.prepare(`UPDATE persons SET ${PERSON_FIELDS.map(f => f + ' = @' + f).join(', ')} WHERE id = @id`)
      .run({ ...o, id: d.id });
    logAudit('Персоналии', 'редакция: ' + (d.name || ''));
  })
);
ipcMain.handle('persons:delete', (e, id) =>
  run(() => {
    const p = db.prepare('SELECT name FROM persons WHERE id = ?').get(id);
    db.transaction(() => {
      db.prepare("DELETE FROM links WHERE (from_kind = 'персона' AND from_id = ?) OR (to_kind = 'персона' AND to_id = ?)").run(id, id);
      db.prepare('DELETE FROM persons WHERE id = ?').run(id);
    })();
    logAudit('Персоналии', 'изтрита персоналия: ' + (p ? p.name : id));
  })
);

/* --- Летопис --- */
const CHRONICLE_FIELDS = ['year', 'date', 'title', 'body', 'category', 'participants', 'sources', 'note'];
ipcMain.handle('chronicle:list', (e, { q, year } = {}) =>
  run(() => {
    const where = [], args = {};
    if (q) { where.push('(c.title LIKE @q OR c.body LIKE @q OR c.participants LIKE @q)'); args.q = '%' + q + '%'; }
    if (year) { where.push('c.year = @year'); args.year = String(year); }
    return db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM links l WHERE l.from_kind = 'летопис' AND l.from_id = c.id) AS links
      FROM chronicle c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.year DESC, c.date DESC, c.id DESC`).all(args);
  })
);
ipcMain.handle('chronicle:get', (e, id) => run(() => db.prepare('SELECT * FROM chronicle WHERE id = ?').get(id)));
ipcMain.handle('chronicle:years', () =>
  run(() => db.prepare(`SELECT year, COUNT(*) AS n FROM chronicle GROUP BY year ORDER BY year DESC`).all())
);
ipcMain.handle('chronicle:create', (e, d) =>
  run(() => {
    const o = {}; for (const f of CHRONICLE_FIELDS) o[f] = d[f] ?? null;
    if (!o.year && o.date) o.year = String(o.date).slice(0, 4);
    const info = db.prepare(`INSERT INTO chronicle (${CHRONICLE_FIELDS.join(', ')})
      VALUES (${CHRONICLE_FIELDS.map(f => '@' + f).join(', ')})`).run(o);
    logAudit('Летопис', 'нов запис: ' + (d.year || '') + ' — ' + (d.title || ''));
    return info.lastInsertRowid;
  })
);
ipcMain.handle('chronicle:update', (e, d) =>
  run(() => {
    const o = {}; for (const f of CHRONICLE_FIELDS) o[f] = d[f] ?? null;
    if (!o.year && o.date) o.year = String(o.date).slice(0, 4);
    db.prepare(`UPDATE chronicle SET ${CHRONICLE_FIELDS.map(f => f + ' = @' + f).join(', ')} WHERE id = @id`)
      .run({ ...o, id: d.id });
    logAudit('Летопис', 'редакция: ' + (d.title || ''));
  })
);
ipcMain.handle('chronicle:delete', (e, id) =>
  run(() => {
    const c = db.prepare('SELECT title FROM chronicle WHERE id = ?').get(id);
    db.transaction(() => {
      db.prepare("DELETE FROM links WHERE (from_kind = 'летопис' AND from_id = ?) OR (to_kind = 'летопис' AND to_id = ?)").run(id, id);
      db.prepare('DELETE FROM chronicle WHERE id = ?').run(id);
    })();
    logAudit('Летопис', 'изтрит запис: ' + (c ? c.title : id));
  })
);

/* --- Снимки към персоналии и летопис ---
   Пазят се в базата като data URI, по същата причина както логото: пътуват
   заедно с базата при резервно копие и при работа в мрежа. */
ipcMain.handle('localPhoto:choose', async (e, { table, id }) => {
  try {
    if (!['persons', 'chronicle'].includes(table)) return { ok: false, error: 'Непозната таблица.' };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Изберете снимка',
      properties: ['openFile'],
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    });
    if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
    const file = filePaths[0];
    const mime = LOGO_MIME[path.extname(file).toLowerCase()];
    if (!mime || mime === 'image/svg+xml') return { ok: false, error: 'Изберете PNG, JPG, GIF или WEBP.' };
    const buf = fs.readFileSync(file);
    if (buf.length > LOCAL_PHOTO_MAX_BYTES) {
      return { ok: false, error: 'Файлът е ' + Math.round(buf.length / 1024) + ' KB, а максимумът е ' +
        Math.round(LOCAL_PHOTO_MAX_BYTES / 1024) + ' KB. Смалете изображението преди да го добавите.' };
    }
    const uri = `data:${mime};base64,${buf.toString('base64')}`;
    db.prepare(`UPDATE ${table} SET photo = ? WHERE id = ?`).run(uri, id);
    return { ok: true, data: uri };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('localPhoto:clear', (e, { table, id }) =>
  run(() => {
    if (!['persons', 'chronicle'].includes(table)) throw new Error('Непозната таблица.');
    db.prepare(`UPDATE ${table} SET photo = NULL WHERE id = ?`).run(id);
  })
);

/* --- Връзки между краеведските записи и фонда --- */
const LINK_FROM = ['персона', 'летопис'];
const LINK_TO = ['книга', 'статия', 'летопис', 'персона', 'периодика'];
// Описанието на всяка връзка се сглобява от съответната таблица, за да се
// показва смислен ред, а не само номер.
function linkLabel(kind, id) {
  if (kind === 'книга') {
    const b = db.prepare('SELECT inv_number, author, title FROM books WHERE id = ?').get(id);
    return b ? `инв. № ${b.inv_number ?? '—'} · ${[b.author, b.title].filter(Boolean).join('. ')}` : '(изтрит запис)';
  }
  if (kind === 'статия') {
    const a = db.prepare('SELECT author, title, year FROM analytics WHERE id = ?').get(id);
    return a ? `${[a.author, a.title].filter(Boolean).join('. ')}${a.year ? ' (' + a.year + ')' : ''}` : '(изтрит запис)';
  }
  if (kind === 'летопис') {
    const c = db.prepare('SELECT year, title FROM chronicle WHERE id = ?').get(id);
    return c ? `${c.year} — ${c.title}` : '(изтрит запис)';
  }
  if (kind === 'персона') {
    const p = db.prepare('SELECT name FROM persons WHERE id = ?').get(id);
    return p ? p.name : '(изтрит запис)';
  }
  if (kind === 'периодика') {
    const p = db.prepare('SELECT title FROM periodicals WHERE id = ?').get(id);
    return p ? p.title : '(изтрит запис)';
  }
  return String(id);
}
ipcMain.handle('links:list', (e, { fromKind, fromId }) =>
  run(() => {
    const rows = db.prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? ORDER BY to_kind, id')
      .all(fromKind, fromId);
    rows.forEach(r => { r.label = linkLabel(r.to_kind, r.to_id); });
    return rows;
  })
);
// Обратната посока: кои персоналии и записи в летописа сочат към даден документ.
ipcMain.handle('links:backlinks', (e, { toKind, toId }) =>
  run(() => {
    const rows = db.prepare('SELECT * FROM links WHERE to_kind = ? AND to_id = ? ORDER BY from_kind, id')
      .all(toKind, toId);
    rows.forEach(r => { r.label = linkLabel(r.from_kind, r.from_id); });
    return rows;
  })
);
ipcMain.handle('links:add', (e, { fromKind, fromId, toKind, toId, note }) =>
  run(() => {
    if (!LINK_FROM.includes(fromKind) || !LINK_TO.includes(toKind)) throw new Error('Непозната връзка.');
    if (fromKind === toKind && Number(fromId) === Number(toId)) throw new Error('Записът не може да сочи към себе си.');
    const dup = db.prepare('SELECT id FROM links WHERE from_kind=? AND from_id=? AND to_kind=? AND to_id=?')
      .get(fromKind, fromId, toKind, toId);
    if (dup) throw new Error('Тази връзка вече съществува.');
    db.prepare('INSERT INTO links (from_kind, from_id, to_kind, to_id, note) VALUES (?, ?, ?, ?, ?)')
      .run(fromKind, fromId, toKind, toId, note || null);
  })
);
ipcMain.handle('links:delete', (e, id) => run(() => db.prepare('DELETE FROM links WHERE id = ?').run(id)));
// Търсене на записи, към които да се направи връзка.
ipcMain.handle('links:search', (e, { kind, q }) =>
  run(() => {
    const like = '%' + (q || '') + '%';
    if (kind === 'книга') {
      return db.prepare(`SELECT id, (COALESCE('инв. № ' || inv_number || ' · ', '') ||
        COALESCE(author || '. ', '') || title) AS label FROM books
        WHERE title LIKE ? OR author LIKE ? OR CAST(inv_number AS TEXT) = ? ORDER BY title LIMIT 40`)
        .all(like, like, q || '');
    }
    if (kind === 'статия') {
      return db.prepare(`SELECT id, (COALESCE(author || '. ', '') || title ||
        COALESCE(' (' || year || ')', '')) AS label FROM analytics
        WHERE title LIKE ? OR author LIKE ? ORDER BY year DESC, title LIMIT 40`).all(like, like);
    }
    if (kind === 'летопис') {
      return db.prepare(`SELECT id, (year || ' — ' || title) AS label FROM chronicle
        WHERE title LIKE ? OR body LIKE ? ORDER BY year DESC LIMIT 40`).all(like, like);
    }
    if (kind === 'персона') {
      return db.prepare(`SELECT id, name AS label FROM persons
        WHERE name LIKE ? OR alt_names LIKE ? ORDER BY name LIMIT 40`).all(like, like);
    }
    if (kind === 'периодика') {
      return db.prepare(`SELECT id, title AS label FROM periodicals WHERE title LIKE ? ORDER BY title LIMIT 40`).all(like);
    }
    throw new Error('Непознат вид запис.');
  })
);

/* ============================================================================
   ПРИЕМАНЕ НА ДАННИ ОТ ДРУГИ СИСТЕМИ
   Цел: читалище с изоставена стара база (АБ, iLib, чужд Excel) да мине на тази
   програма без преписване на ръка.
   ============================================================================ */
const IMPORT_FIELDS = {
  inv_number: 'Инвентарен №', title: 'Заглавие', subtitle: 'Подзаглавие', author: 'Автор',
  publisher: 'Издателство', city: 'Място на издаване', year: 'Година', isbn: 'ISBN / ISSN',
  pages: 'Страници', language: 'Език', udk: 'УДК', call_number: 'Сигнатура',
  author_mark: 'Авторски знак', keywords: 'Ключови думи', annotation: 'Анотация',
  price: 'Цена', department: 'Отдел', category_name: 'Вид документ', status: 'Състояние',
  volume: 'Том / част', barcode: 'Баркод', register_date: 'Дата на вписване',
  description: 'Забележка'
};
let IMPORT_CACHE = null; // прочетеният файл се пази между прегледа и внасянето

// Разчита файла и подготвя прегледа. Ползва се и от диалога за избор, и когато
// файлът е провлачен върху прозореца на програмата.
function loadImportFile(filePath) {
  const t = importers.readTable(filePath);
  if (!t.rows.length) throw new Error('Файлът е празен или не се разчита като таблица.');
  const headers = t.rows[0].map(h => String(h || '').trim());
  const body = t.rows.slice(1);
  IMPORT_CACHE = { path: filePath, headers, body };
  return {
    path: filePath, encoding: t.encoding, delimiter: t.delimiter,
    headers, mapping: importers.guessMapping(headers),
    preview: body.slice(0, 8), total: body.length, fields: IMPORT_FIELDS
  };
}
ipcMain.handle('import:load', (e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Файлът не е намерен.' };
    return { ok: true, data: loadImportFile(filePath) };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('import:choose', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Изберете файл за внасяне (износ от друга библиотечна система)',
      properties: ['openFile'],
      filters: [
        { name: 'Таблици', extensions: ['csv', 'txt', 'tsv', 'xlsx'] },
        { name: 'Всички файлове', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
    return { ok: true, data: loadImportFile(filePaths[0]) };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Числата в стари износи идват с интервали за хилядни и със запетая за десетичен знак.
function parseNum(v) {
  const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function parseIntOrNull(v) {
  const s = String(v ?? '').replace(/[^\d]/g, '');
  return s ? parseInt(s, 10) : null;
}
// Дати в износите са в най-различен вид; приемат се трите обичайни, иначе полето
// се оставя празно, вместо да се запише безсмислица.
function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return null;
}
ipcMain.handle('import:run', (e, { mapping, options }) => {
  try {
    if (!IMPORT_CACHE) return { ok: false, error: 'Първо изберете файл.' };
    const opt = options || {};
    const cols = {};
    for (const [idx, field] of Object.entries(mapping || {})) if (field) cols[field] = Number(idx);
    if (cols.title == null) return { ok: false, error: 'Задължително е да посочите коя колона е „Заглавие“.' };

    const cats = new Map(db.prepare('SELECT id, name FROM categories').all().map(c => [c.name.toLowerCase(), c.id]));
    const insertCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
    const existingInv = new Set(db.prepare('SELECT inv_number FROM books WHERE inv_number IS NOT NULL')
      .all().map(r => String(r.inv_number)));
    const existingIsbn = new Set(db.prepare("SELECT isbn FROM books WHERE isbn IS NOT NULL AND isbn <> ''")
      .all().map(r => String(r.isbn).replace(/[^0-9Xx]/g, '')));
    // Трета проверка за дубликат: ред без инвентарен номер и без ISBN не може да се
    // разпознае по нищо друго освен по заглавие и автор. Без нея повторното внасяне
    // на същия файл удвоява точно тези редове.
    const titleKey = (t, a) => (String(t || '') + '|' + String(a || '')).toLowerCase().replace(/\s+/g, ' ').trim();
    const existingTitles = new Set(db.prepare('SELECT title, author FROM books').all()
      .map(r => titleKey(r.title, r.author)));

    const report = { added: 0, skipped: 0, errors: [], usedInv: [] };
    const cell = (row, field) => cols[field] == null ? '' : String(row[cols[field]] ?? '').trim();

    const tx = db.transaction(() => {
      let nextInv = (db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get() || {}).next_inv_number || 1;
      IMPORT_CACHE.body.forEach((row, i) => {
        const lineNo = i + 2; // +1 за заглавния ред, +1 за човешко броене
        try {
          const title = cell(row, 'title');
          if (!title) { report.skipped++; return; }

          let inv = parseIntOrNull(cell(row, 'inv_number'));
          const isbnRaw = cell(row, 'isbn');
          const isbnKey = isbnRaw.replace(/[^0-9Xx]/g, '');

          const author = cell(row, 'author');
          if (opt.skipDuplicates) {
            if (inv != null && existingInv.has(String(inv))) { report.skipped++; return; }
            if (!inv && isbnKey && existingIsbn.has(isbnKey)) { report.skipped++; return; }
            if (!inv && !isbnKey && existingTitles.has(titleKey(title, author))) { report.skipped++; return; }
          }
          existingTitles.add(titleKey(title, author));
          // Зает или липсващ инвентарен номер: дава се следващият свободен, за да
          // не се губи записът и да не се чупи уникалността в инвентарната книга.
          if (inv == null || existingInv.has(String(inv))) {
            while (existingInv.has(String(nextInv))) nextInv++;
            inv = nextInv;
            report.usedInv.push({ line: lineNo, inv });
          }
          existingInv.add(String(inv));
          if (isbnKey) existingIsbn.add(isbnKey);

          let categoryId = null;
          const catName = cell(row, 'category_name') || opt.defaultCategory || '';
          if (catName) {
            const key = catName.toLowerCase();
            if (!cats.has(key)) cats.set(key, insertCat.run(catName).lastInsertRowid);
            categoryId = cats.get(key);
          }
          const payload = {
            inv_number: inv,
            barcode: cell(row, 'barcode') || String(inv),
            register_date: parseDate(cell(row, 'register_date')) || new Date().toISOString().slice(0, 10),
            title,
            subtitle: cell(row, 'subtitle') || null,
            author: author || null,
            category_id: categoryId,
            year: cell(row, 'year') || null,
            volume: cell(row, 'volume') || null,
            isbn: isbnRaw || null,
            pages: cell(row, 'pages') || null,
            language: cell(row, 'language') || opt.defaultLanguage || null,
            udk: cell(row, 'udk') || null,
            call_number: cell(row, 'call_number') || null,
            author_mark: cell(row, 'author_mark') || null,
            city: cell(row, 'city') || null,
            publisher: cell(row, 'publisher') || null,
            keywords: cell(row, 'keywords') || null,
            annotation: cell(row, 'annotation') || null,
            cover_url: null,
            department: cell(row, 'department') || opt.defaultDepartment || 'за възрастни',
            status: cell(row, 'status') || 'наличен',
            price: parseNum(cell(row, 'price')),
            description: cell(row, 'description') || null,
            acquisition_id: null
          };
          const info = db.prepare(`INSERT INTO books (${BOOK_FIELDS.join(',')})
            VALUES (${BOOK_FIELDS.map(f => '@' + f).join(',')})`).run(payload);
          db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(info.lastInsertRowid);
          if (inv >= nextInv) nextInv = inv + 1;
          report.added++;
        } catch (err) {
          // Грешката на един ред не бива да проваля целия внос — събира се и се
          // показва накрая, а останалите редове продължават.
          if (report.errors.length < 100) report.errors.push({ line: lineNo, error: err.message });
          report.skipped++;
        }
      });
      db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(nextInv);
    });
    tx();
    logAudit('Внасяне на данни', `${report.added} документа от ${path.basename(IMPORT_CACHE.path)}` +
      (report.skipped ? `, пропуснати ${report.skipped}` : ''));
    return { ok: true, data: report };
  } catch (err) { return { ok: false, error: err.message }; }
});

/* ============================================================================
   МОБИЛНО СКАНИРАНЕ
   Вместо RFID: страница, която се отваря на телефона и ползва камерата като
   баркод четец. Списъкът се пренася обратно като текст или файл.
   ============================================================================ */
/* ============================================================================
   ПОМОЩ СРЕЩУ АНТИВИРУСНИ БЛОКИРОВКИ
   Докато инсталаторът е без закупен цифров подпис, Defender и други антивирусни
   спират както инсталирането, така и работата на вече инсталираната програма —
   най-често като заключват записа в базата данни, резервните копия или папката
   на каталога. Скриптът по-долу добавя изключенията наведнъж; пуска се веднъж,
   като администратор. Съдържанието се показва на екрана преди записване, за да
   се вижда какво точно ще бъде изключено.
   ============================================================================ */
function psQuote(v) { return String(v).replace(/'/g, "''"); }
function buildAvExclusionScript() {
  const exePath = process.execPath;
  const dirs = new Set([
    path.dirname(exePath),          // папката на програмата
    app.getPath('userData'),        // база данни, настройки, резервни копия
    resolveDbDir()                  // мрежова папка, ако базата е преместена
  ]);
  try {
    const s = db.prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
    if (s && s.catalog_folder) dirs.add(s.catalog_folder); // работното копие на каталога
  } catch (e) {}
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'net session >nul 2>&1',
    'if %errorlevel% neq 0 (',
    '  echo Този файл трябва да се изпълни като администратор:',
    '  echo десен бутон върху файла - "Изпълни като администратор".',
    '  pause',
    '  exit /b 1',
    ')',
    'echo Добавяне на изключения в Windows Defender...'
  ];
  for (const d of dirs) {
    lines.push(`powershell -NoProfile -Command "Add-MpPreference -ExclusionPath '${psQuote(d)}'"`);
  }
  lines.push(
    `powershell -NoProfile -Command "Add-MpPreference -ExclusionProcess '${psQuote(path.basename(exePath))}'"`,
    // Controlled Folder Access ("Защита от рансъмуер") блокира записа в Documents
    // дори при добавена папка-изключение — програмата трябва да е разрешено приложение.
    `powershell -NoProfile -Command "Add-MpPreference -ControlledFolderAccessAllowedApplications '${psQuote(exePath)}'"`,
    'echo.',
    'echo Готово. Изключенията са добавени.',
    'echo Ако ползвате друга антивирусна (Avast, ESET и др.), добавете същите папки',
    'echo в нейните настройки за изключения.',
    'pause'
  );
  return { content: lines.join('\r\n') + '\r\n', dirs: [...dirs], exe: exePath };
}
ipcMain.handle('security:exclusionInfo', () =>
  run(() => {
    const b = buildAvExclusionScript();
    return { dirs: b.dirs, exe: b.exe };
  })
);
ipcMain.handle('security:writeExclusionScript', async () => {
  try {
    const b = buildAvExclusionScript();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Запишете скрипта за изключения в Defender',
      defaultPath: 'Inventar-Defender-izklyuchenia.bat',
      filters: [{ name: 'Команден файл', extensions: ['bat'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
    fs.writeFileSync(filePath, b.content, 'utf8');
    logAudit('Антивирусна защита', 'генериран скрипт за изключения: ' + filePath);
    return { ok: true, data: filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('mobile:generate', async () => {
  try {
    const s = db.prepare('SELECT lib_name, org, place FROM settings WHERE id = 1').get() || {};
    const name = [s.lib_name || s.org || '', s.place || ''].filter(Boolean).join(' · ');
    const tpl = fs.readFileSync(path.join(__dirname, 'src', 'mobile-template.html'), 'utf8');
    const html = tpl.replace('__LIB__', name.replace(/[<>&]/g, ''));
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Запишете страницата за сканиране с телефон',
      defaultPath: 'inventarizaciya-skener.html',
      filters: [{ name: 'HTML страница', extensions: ['html'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
    fs.writeFileSync(filePath, html, 'utf8');
    return { ok: true, data: filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Внасяне на сканираните с телефона номера в отворена сесия за инвентаризация.
ipcMain.handle('inventorySessions:importScans', (e, { sessionId, codes }) =>
  run(() => {
    const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
    if (!s || s.closed) throw new Error('Няма отворена сесия за инвентаризация.');
    const list = [...new Set((codes || []).map(c => String(c).trim()).filter(Boolean))];
    if (!list.length) throw new Error('Списъкът е празен.');
    const find = db.prepare('SELECT * FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)');
    const already = db.prepare('SELECT 1 FROM inventory_session_scans WHERE session_id = ? AND book_id = ?');
    const addScan = db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)');
    const addCheck = db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)');
    const res = { added: 0, duplicates: 0, unknown: [] };
    db.transaction(() => {
      for (const code of list) {
        const b = find.get(code, code);
        if (!b) { res.unknown.push(code); continue; }
        if (already.get(sessionId, b.id)) { res.duplicates++; continue; }
        addScan.run(sessionId, b.id);
        addCheck.run(b.id, s.date);
        db.prepare("UPDATE books SET datelastseen = datetime('now') WHERE id = ?").run(b.id);
        if (b.status === 'липсващ') db.prepare("UPDATE books SET status='наличен', status_date=date('now') WHERE id=?").run(b.id);
        res.added++;
      }
    })();
    logAudit('Инвентаризация', `внесени ${res.added} сканирания от телефон` +
      (res.unknown.length ? `, ${res.unknown.length} непознати` : ''));
    return res;
  })
);

/* ---------------- Одитна следа ---------------- */
ipcMain.handle('audit:list', (e, query) =>
  run(() => {
    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      return db.prepare(`
        SELECT * FROM audit_log WHERE user LIKE ? OR action LIKE ? OR detail LIKE ?
        ORDER BY id DESC LIMIT 500
      `).all(q, q, q);
    }
    return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all();
  })
);

/* ---------------- История на търсенията (Koha: search_history) ----------------
   Записва завършени търсения (не всяко натискане на клавиш), за да предлага
   скорошните заявки в полето за търсене — удобство при повторно търсене, не
   пълноценна одитна следа. */
ipcMain.handle('searchHistory:log', (e, { kind, query }) =>
  run(() => {
    const q = String(query || '').trim();
    if (!kind || q.length < 2) return;
    const last = db.prepare('SELECT query FROM search_history WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);
    if (last && last.query === q) return; // без дубликат на последното същото търсене
    db.prepare('INSERT INTO search_history (user, kind, query) VALUES (?, ?, ?)').run(CURRENT_USER || '', kind, q);
  })
);
ipcMain.handle('searchHistory:suggest', (e, kind) =>
  run(() => db.prepare(`
    SELECT query FROM search_history WHERE kind = ? GROUP BY query ORDER BY MAX(id) DESC LIMIT 10
  `).all(kind).map(r => r.query))
);

/* ---------------- Посещения ---------------- */
ipcMain.handle('visits:add', (e, { date, count }) =>
  run(() => db.prepare(`
    INSERT INTO visits (date, count) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET count = count + excluded.count
  `).run(date, parseInt(count, 10) || 0))
);

/* ---------------- Справки и статистика ---------------- */
ipcMain.handle('stats:report', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const end = y + '-12-31';
    const fund = db.prepare(`
      SELECT * FROM books WHERE register_date <= ? AND (deaccession_date IS NULL OR deaccession_date > ?)
    `).all(end, end);
    const acquired = db.prepare(`SELECT * FROM books WHERE substr(register_date,1,4) = ?`).all(y);
    const deaccessioned = db.prepare(`
      SELECT i.* FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
    `).all(y);
    const loansYear = db.prepare(`SELECT * FROM loans WHERE substr(date_out,1,4) = ?`).all(y);
    const readersYear = db.prepare(`
      SELECT * FROM readers WHERE substr(registered_at,1,4) = ? OR substr(re_registered_at,1,4) = ?
    `).all(y, y);
    const visitsYear = db.prepare(`SELECT COALESCE(SUM(count),0) AS n FROM visits WHERE substr(date,1,4) = ?`).get(y).n;
    const byGroup = (rows, field) => {
      const m = {};
      rows.forEach(r => { const k = r[field] || '—'; m[k] = (m[k] || 0) + 1; });
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    const topLoans = db.prepare(`
      SELECT b.title, COUNT(*) AS n FROM loans l JOIN books b ON b.id = l.book_id
      GROUP BY l.book_id ORDER BY n DESC LIMIT 10
    `).all();
    const fundByCategory = db.prepare(`
      SELECT COALESCE(c.name,'—') AS k, COUNT(*) AS n FROM books b LEFT JOIN categories c ON c.id=b.category_id
      WHERE b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)
      GROUP BY k ORDER BY n DESC
    `).all(end, end).map(r => [r.k, r.n]);
    return {
      year: y,
      fundCount: fund.length, fundValue: value(fund),
      acquiredCount: acquired.length, acquiredValue: value(acquired),
      deaccessionedCount: deaccessioned.length, deaccessionedValue: value(deaccessioned),
      loansCount: loansYear.length,
      readersCount: readersYear.length,
      visits: visitsYear || loansYear.length,
      returnedOnTime: loansYear.filter(l => l.date_in && l.date_due && l.date_in <= l.date_due).length,
      returnedLate: loansYear.filter(l => l.date_in && l.date_due && l.date_in > l.date_due).length,
      finesCollected: loansYear.reduce((s, l) => s + (l.fine || 0), 0),
      fundByLanguage: byGroup(fund, 'language'),
      fundByDepartment: byGroup(fund, 'department'),
      fundByCategory,
      topLoans
    };
  })
);

/* ---------------- Готови справки ----------------
   Koha предлага споделена библиотека от стотици готови отчети. Тукашният аналог е малък
   и фиксиран набор от справки, всяка от които съответства на нещо, което читалищна
   библиотека реално подава към регионалната библиотека/Министерството на културата —
   не общи "конструктор на справки" възможности, а точно тези таблици, готови за печат.
   REPORTS_CATALOG описва какво се показва в списъка за избор; reports:run връща данните. */
const REPORTS_CATALOG = [
  { id: 'annual_ab', title: 'Годишен статистически отчет — Раздел А и Б', needsYear: true,
    hint: 'Обобщение на дневника на библиотеката за цялата година — по образеца, подаван към регионалната библиотека.' },
  { id: 'fund_breakdown', title: 'Библиотечен фонд по отдели, категории и езици', needsYear: true,
    hint: 'Състояние на фонда към 31.12. на избраната година — таблици вместо диаграми, за прилагане към отчета.' },
  { id: 'readers_by_category', title: 'Читатели по възрастови категории', needsYear: true,
    hint: 'Брой активни читатели по категория и новорегистрирани през годината.' },
  { id: 'fund_movement', title: 'Движение на фонда — постъпления и отчисления', needsYear: true,
    hint: 'Обобщено по начин на придобиване/причина за отчисляване — извадка от КДБФ за прилагане към годишния отчет.' },
  { id: 'mzs_annual', title: 'Междубиблиотечно заемане (МЗС) — обобщение', needsYear: true,
    hint: 'Брой заявки по посока и състояние през годината.' },
  { id: 'fees_income', title: 'Приходи от такси и обезщетения', needsYear: true,
    hint: 'Начислено и събрано по вид (годишна такса, обезщетения) от читателската сметка през годината.' }
];
ipcMain.handle('reports:list', () => run(() => REPORTS_CATALOG));
ipcMain.handle('reports:run', (e, { id, year }) =>
  run(() => {
    const y = String(year || yearOf());
    if (id === 'annual_ab') {
      const rows = db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ?').all(`${y}-01-01`, `${y}-12-31`);
      return { id, year: y, totals: dnevnikSumRow(rows), daysRecorded: rows.length };
    }
    if (id === 'fund_breakdown') {
      const end = y + '-12-31';
      const fund = db.prepare(`
        SELECT * FROM books WHERE register_date <= ? AND (deaccession_date IS NULL OR deaccession_date > ?)
      `).all(end, end);
      const byGroup = (rows, field) => {
        const m = {};
        rows.forEach(r => { const k = r[field] || '—'; m[k] = (m[k] || 0) + 1; });
        return Object.entries(m).sort((a, b) => b[1] - a[1]);
      };
      const byCategory = db.prepare(`
        SELECT COALESCE(c.name,'—') AS k, COUNT(*) AS n FROM books b LEFT JOIN categories c ON c.id=b.category_id
        WHERE b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)
        GROUP BY k ORDER BY n DESC
      `).all(end, end).map(r => [r.k, r.n]);
      return {
        id, year: y, fundCount: fund.length, fundValue: value(fund),
        byDepartment: byGroup(fund, 'department'), byLanguage: byGroup(fund, 'language'), byCategory
      };
    }
    if (id === 'readers_by_category') {
      const byCategory = db.prepare(`
        SELECT COALESCE(category,'—') AS k, COUNT(*) AS n FROM readers WHERE status != 'прекратен' GROUP BY k ORDER BY n DESC
      `).all().map(r => [r.k, r.n]);
      const total = byCategory.reduce((s, [, n]) => s + n, 0);
      const newThisYear = db.prepare(`SELECT COUNT(*) AS n FROM readers WHERE substr(registered_at,1,4) = ?`).get(y).n;
      return { id, year: y, total, byCategory, newThisYear };
    }
    if (id === 'fund_movement') {
      const acquired = db.prepare(`
        SELECT COALESCE(how,'—') AS k, COUNT(*) AS n, COALESCE(SUM(total_count),0) AS cnt, COALESCE(SUM(sum),0) AS val
        FROM acquisitions WHERE year = ? GROUP BY k ORDER BY cnt DESC
      `).all(y);
      const deaccessioned = db.prepare(`
        SELECT COALESCE(d.reason_text,'—') AS k, COUNT(*) AS cnt, COALESCE(SUM(i.price),0) AS val
        FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ? GROUP BY k ORDER BY cnt DESC
      `).all(y);
      return {
        id, year: y,
        acquired: acquired.map(r => [r.k, r.cnt, r.val]),
        acquiredTotal: acquired.reduce((s, r) => s + r.cnt, 0),
        acquiredValue: acquired.reduce((s, r) => s + r.val, 0),
        deaccessioned: deaccessioned.map(r => [r.k, r.cnt, r.val]),
        deaccessionedTotal: deaccessioned.reduce((s, r) => s + r.cnt, 0),
        deaccessionedValue: deaccessioned.reduce((s, r) => s + r.val, 0)
      };
    }
    if (id === 'mzs_annual') {
      const byDirection = db.prepare(`
        SELECT direction AS k, COUNT(*) AS n FROM mzs_requests WHERE year = ? GROUP BY direction ORDER BY k
      `).all(y).map(r => [r.k, r.n]);
      const byStatus = db.prepare(`
        SELECT COALESCE(status,'—') AS k, COUNT(*) AS n FROM mzs_requests WHERE year = ? GROUP BY k ORDER BY n DESC
      `).all(y).map(r => [r.k, r.n]);
      const total = byDirection.reduce((s, [, n]) => s + n, 0);
      return { id, year: y, total, byDirection, byStatus };
    }
    if (id === 'fees_income') {
      const charged = db.prepare(`
        SELECT COALESCE(type,'друго') AS k, COUNT(*) AS n, COALESCE(SUM(amount),0) AS val
        FROM account_lines WHERE kind = 'начисление' AND substr(date,1,4) = ? GROUP BY k ORDER BY val DESC
      `).all(y);
      const paid = db.prepare(`
        SELECT COALESCE(SUM(-amount),0) AS val, COUNT(*) AS n FROM account_lines
        WHERE kind = 'плащане' AND substr(date,1,4) = ?
      `).get(y);
      return {
        id, year: y,
        charged: charged.map(r => [r.k, r.n, r.val]),
        chargedTotal: charged.reduce((s, r) => s + r.n, 0),
        chargedValue: charged.reduce((s, r) => s + r.val, 0),
        paidCount: paid.n, paidValue: paid.val
      };
    }
    throw new Error('Непозната справка.');
  })
);

/* ---------------- Онлайн каталог (публикуване през GitHub) ----------------
   Изнасят се само библиографски данни и наличност — никога читатели, цени
   или служебни бележки. Свързаната папка е работно копие (git clone) на
   GitHub хранилището, от което сайтът чете каталога чрез
   raw.githubusercontent.com. katalog.json се записва там автоматично при
   всяка промяна във фонда; за разлика от браузърното приложение (което се
   нуждаеше от отделен Windows Task Scheduler + .bat, защото браузърът не
   може да изпълнява git), тук Electron изпълнява git add/commit/push пряко:
   веднъж на 5 минути автоматично (ако има промяна) и по желание веднага
   чрез бутона „Публикувай в GitHub сега“. Изисква git да е инсталиран и
   вече удостоверен (git credential manager) на компютъра. */
function gitRun(folder, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: folder, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? error.code : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}
function isGitRepo(folder) {
  return folder && fs.existsSync(path.join(folder, '.git'));
}
// Разчита "потребител/хранилище" от адреса на origin — и за https, и за ssh адрес.
async function gitRemoteSlug(folder) {
  if (!isGitRepo(folder)) return null;
  // Нарочно се чете суровата стойност от конфигурацията, а не "git remote get-url":
  // второто прилага правилата url.<база>.insteadOf и може да върне пренаписан адрес,
  // който вече не показва към кое хранилище в GitHub сочи папката.
  const r = await gitRun(folder, ['config', '--get', 'remote.origin.url']);
  if (!r.ok || !r.stdout) return null;
  const m = r.stdout.match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
  return m ? { user: m[1], repo: m[2], url: r.stdout } : { user: '', repo: '', url: r.stdout };
}
// Пази всяка библиотека да не публикува в чуждо хранилище: сравнява къде наистина сочи
// папката с това, което е записано в настройките. Точно това е случаят, при който един
// каталог може да бъде презаписан с данните на друга библиотека.
async function catalogRemoteCheck(folder, s) {
  const slug = await gitRemoteSlug(folder);
  const u = (s.gh_user || '').trim(), r = (s.gh_repo || '').trim();
  if (!slug || !slug.user || !u || !r) return { slug, mismatch: false };
  const mismatch = slug.user.toLowerCase() !== u.toLowerCase() || slug.repo.toLowerCase() !== r.toLowerCase();
  return { slug, mismatch };
}
async function gitPublish(folder) {
  if (!isGitRepo(folder)) return { ok: false, error: 'Папката не е git хранилище (липсва .git). Клонирайте хранилището с "git clone" веднъж, преди да я свържете тук.' };

  const s = db.prepare('SELECT gh_user, gh_repo FROM settings WHERE id = 1').get() || {};
  const chk = await catalogRemoteCheck(folder, s);
  if (chk.mismatch) {
    return { ok: false, error: 'Спряно: свързаната папка сочи към хранилището ' +
      chk.slug.user + '/' + chk.slug.repo + ', а в настройките е записано ' +
      (s.gh_user || '—') + '/' + (s.gh_repo || '—') +
      '. Публикуването е спряно, за да не се презапише чужд каталог. ' +
      'Проверете дали сте клонирали собственото си хранилище.' };
  }

  const branchRes = await gitRun(folder, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.ok && branchRes.stdout ? branchRes.stdout : 'main';

  const add = await gitRun(folder, ['add', 'katalog.json']);
  if (!add.ok) return { ok: false, error: 'git add: ' + (add.stderr || 'грешка') };
  const commit = await gitRun(folder, ['commit', '-m', 'Автоматично обновяване на каталога — ' + new Date().toISOString()]);
  if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    return { ok: false, error: 'git commit: ' + (commit.stderr || commit.stdout || 'грешка') };
  }

  let push = await gitRun(folder, ['push', '-u', 'origin', branch]);

  // Отхвърлен push (non-fast-forward) означава, че хранилището е било обновено отдругаде —
  // друг работен компютър, който също публикува каталога, или промяна направена в GitHub.
  // Това е нормално, а не грешка: изтегляме новото състояние, пренасяме нашия commit върху
  // него и опитваме пак. При разминаване в katalog.json печели нашата версия, защото файлът
  // е изцяло генериран от тази база данни — няма ръчни редакции, които да се загубят.
  if (!push.ok && /rejected|non-fast-forward|fetch first|behind/i.test(push.stderr)) {
    const fetch = await gitRun(folder, ['fetch', 'origin', branch]);
    if (!fetch.ok) return { ok: false, error: 'git fetch: ' + (fetch.stderr || 'грешка при изтегляне от GitHub') };

    const rebase = await gitRun(folder, ['rebase', '-X', 'theirs', 'origin/' + branch]);
    if (!rebase.ok) {
      await gitRun(folder, ['rebase', '--abort']);
      return { ok: false, error: 'Хранилището е обновено отдругаде и промените не можаха да се обединят ' +
        'автоматично. Отворете папката на хранилището и изпълнете „git pull“ ръчно, после опитайте пак. ' +
        '(' + (rebase.stderr || rebase.stdout || '') + ')' };
    }
    push = await gitRun(folder, ['push', 'origin', branch]);
  }

  if (!push.ok) return { ok: false, error: 'git push: ' + (push.stderr || 'грешка — проверете интернет връзката и удостоверяването пред GitHub') };
  return { ok: true, committed: commit.ok };
}
let AUTO_PUSH_TIMER = null;
function startAutoPushTimer() {
  if (AUTO_PUSH_TIMER) return;
  AUTO_PUSH_TIMER = setInterval(async () => {
    try {
      const s = db.prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
      if (!s || !s.catalog_folder || !isGitRepo(s.catalog_folder)) return;
      const r = await gitPublish(s.catalog_folder);
      if (r.ok && r.committed) console.log('Автоматично публикувано в GitHub:', s.catalog_folder);
      else if (!r.ok) console.error('Автоматично публикуване в GitHub — грешка:', r.error);
    } catch (err) {
      console.error('Автоматично публикуване в GitHub — грешка:', err.message);
    }
  }, 5 * 60 * 1000);
}
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
function ghRawUrl(s) {
  const u = (s.gh_user || '').trim(), r = (s.gh_repo || '').trim(), b = (s.gh_branch || 'main').trim() || 'main';
  if (!u || !r) return null;
  return `https://raw.githubusercontent.com/${u}/${r}/${b}/katalog.json`;
}
// Предлага име на хранилище по името на библиотеката — на латиница, с тирета, защото
// GitHub не приема кирилица и интервали в имената на хранилища.
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sht',ъ:'a',ь:'',ю:'yu',я:'ya' };
function suggestRepoName(s) {
  const base = (s.lib_name || s.org || '').toLowerCase()
    .replace(/[а-я]/g, c => (c in TRANSLIT ? TRANSLIT[c] : c))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  const short = base.split('-').filter(w => w.length > 2).slice(0, 4).join('-');
  return (short || 'biblioteka') + '-katalog';
}
/* ---------------- Витрини в онлайн каталога ----------------
   Извадени в handlers/shelves.js (Фаза 4, стъпка 3 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/shelves')(ipcMain, {
  getDb: () => db, run, logAudit, scheduleCatalogWrite
});

ipcMain.handle('catalog:status', () =>
  run(() => {
    const s = db.prepare('SELECT catalog_folder, gh_user, gh_repo, gh_branch, lib_name, org FROM settings WHERE id = 1').get();
    const pub = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен' AND department != 'служебен'`).get().n;
    const avail = db.prepare(`
      SELECT COUNT(*) AS n FROM books b WHERE b.status != 'отчислен' AND b.department != 'служебен'
      AND COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id=b.id),0) >
          (SELECT COUNT(*) FROM loans l WHERE l.book_id=b.id AND l.date_in IS NULL)
    `).get().n;
    return {
      folder: s.catalog_folder || null, total: pub, available: avail,
      isGitRepo: isGitRepo(s.catalog_folder), rawUrl: ghRawUrl(s),
      ghUser: s.gh_user, ghRepo: s.gh_repo, ghBranch: s.gh_branch,
      suggestedRepo: suggestRepoName(s), libName: s.lib_name || s.org || ''
    };
  })
);
// Проверява накъде наистина сочи свързаната папка. Извиква се от интерфейса, за да се
// покаже предупреждение, преди да се стигне до публикуване.
ipcMain.handle('catalog:remoteCheck', async () => {
  try {
    const s = db.prepare('SELECT catalog_folder, gh_user, gh_repo FROM settings WHERE id = 1').get() || {};
    if (!s.catalog_folder) return { ok: true, data: null };
    const chk = await catalogRemoteCheck(s.catalog_folder, s);
    return { ok: true, data: { mismatch: chk.mismatch, remote: chk.slug } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('catalog:updateGh', (e, { gh_user, gh_repo, gh_branch }) =>
  run(() => {
    db.prepare('UPDATE settings SET gh_user=?, gh_repo=?, gh_branch=? WHERE id=1')
      .run((gh_user || '').trim(), (gh_repo || '').trim(), (gh_branch || 'main').trim() || 'main');
  })
);
ipcMain.handle('catalog:chooseFolder', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Изберете локалното работно копие (git clone) на GitHub хранилището с каталога',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
    const folder = filePaths[0];
    db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(folder);

    // Ако потребителят и хранилището още не са попълнени, се вземат от самата папка —
    // така новата библиотека получава своите настройки, без да ги въвежда на ръка.
    const s = db.prepare('SELECT gh_user, gh_repo FROM settings WHERE id = 1').get() || {};
    const chk = await catalogRemoteCheck(folder, s);
    let adopted = null;
    if (chk.slug && chk.slug.user && !(s.gh_user || '').trim() && !(s.gh_repo || '').trim()) {
      db.prepare('UPDATE settings SET gh_user = ?, gh_repo = ? WHERE id = 1').run(chk.slug.user, chk.slug.repo);
      adopted = chk.slug;
    }

    flushCatalogWrite();
    logAudit('Онлайн каталог', 'папка за автоматичен запис: ' + folder);
    return { ok: true, data: folder, adopted, mismatch: chk.mismatch, remote: chk.slug };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('catalog:disconnectFolder', () =>
  run(() => { db.prepare('UPDATE settings SET catalog_folder = NULL WHERE id = 1').run(); })
);
ipcMain.handle('catalog:gitPublishNow', async () => {
  const s = db.prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
  if (!s || !s.catalog_folder) return { ok: false, error: 'Първо изберете папка (git clone на хранилището).' };
  const w = flushCatalogWrite();
  if (w.blocked) return { ok: false, error: 'Спряно: фондът в тази база данни излиза празен, а публикуваният каталог не е — за да публикувате наистина празен каталог, използвайте „Ръчен експорт“.' };
  const r = await gitPublish(s.catalog_folder);
  if (r.ok) logAudit('Онлайн каталог', 'публикувано в GitHub' + (r.committed ? '' : ' (нямаше промяна)'));
  return r;
});
ipcMain.handle('catalog:writeNow', () =>
  run(() => {
    const s = db.prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
    if (!s || !s.catalog_folder) throw new Error('Първо изберете папка за автоматичен запис.');
    const w = flushCatalogWrite();
    if (w.blocked) throw new Error('Спряно: фондът в тази база данни излиза празен, а публикуваният каталог не е — за да публикувате наистина празен каталог, използвайте „Ръчен експорт“.');
    return true;
  })
);
/* ---------------- Експорт в библиотечни формати ----------------
   UNIMARC/MARCXML и Dublin Core. Целта е данните да не са заключени в тази
   програма: при преминаване към COBISS или към сводния каталог се подава файл,
   вместо да се преписват записите на ръка. */
const xesc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Управляващите знаци правят XML файла невалиден и някои редактори го отхвърлят
  // изцяло; табулация, нов ред и връщане на каретката са допустими и се пазят.
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
const LANG_ISO = {
  'български': 'bul', 'английски': 'eng', 'руски': 'rus', 'немски': 'ger', 'френски': 'fre',
  'испански': 'spa', 'италиански': 'ita', 'турски': 'tur', 'гръцки': 'gre', 'румънски': 'rum',
  'сръбски': 'srp', 'македонски': 'mac', 'полски': 'pol', 'чешки': 'cze', 'украински': 'ukr'
};
// „Вазов, Иван“ → фамилия $a + име $b, както изисква UNIMARC 700.
function splitName(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  const i = s.indexOf(',');
  if (i > 0) return { a: s.slice(0, i).trim(), b: s.slice(i + 1).trim() };
  const w = s.split(/\s+/);
  return w.length > 1 ? { a: w[w.length - 1], b: w.slice(0, -1).join(' ') } : { a: s, b: '' };
}
function marcRecord(b) {
  const df = [];
  const add = (tag, i1, i2, subs) => {
    const parts = subs.filter(([, v]) => String(v ?? '').trim() !== '');
    if (!parts.length) return;
    df.push(`    <datafield tag="${tag}" ind1="${i1}" ind2="${i2}">\n` +
      parts.map(([c, v]) => `      <subfield code="${c}">${xesc(v)}</subfield>`).join('\n') +
      `\n    </datafield>`);
  };
  if (b.isbn) add('010', ' ', ' ', [['a', b.isbn]]);
  if (b.language) add('101', '0', ' ', [['a', LANG_ISO[b.language] || b.language]]);
  add('200', '1', ' ', [['a', b.title], ['e', b.subtitle], ['f', b.author]]);
  add('210', ' ', ' ', [['a', b.city], ['c', b.publisher], ['d', b.year]]);
  add('215', ' ', ' ', [['a', b.pages]]);
  if (b.volume) add('225', ' ', ' ', [['v', b.volume]]);
  add('330', ' ', ' ', [['a', b.annotation]]);
  for (const kw of String(b.keywords || '').split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
    add('606', ' ', ' ', [['a', kw]]);
  }
  add('675', ' ', ' ', [['a', b.udk]]);
  const n = splitName(b.author);
  if (n) add('700', ' ', '1', [['a', n.a], ['b', n.b]]);
  // 995 е полето за екземпляри в българската практика (COMARC).
  add('995', ' ', ' ', [['f', b.inv_number], ['d', b.department], ['k', b.call_number],
    ['o', b.category_name], ['r', b.status]]);
  return `  <record>\n` +
    `    <leader>     nam  22     3a 4500</leader>\n` +
    `    <controlfield tag="001">${xesc(b.inv_number ?? b.id)}</controlfield>\n` +
    df.join('\n') + `\n  </record>`;
}
function buildMarcXml(books) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- UNIMARC в MARCXML структура. Изнесено от библиотечна система „Инвентар“. -->\n` +
    `<collection xmlns="http://www.loc.gov/MARC21/slim">\n` +
    books.map(marcRecord).join('\n') + `\n</collection>\n`;
}
function buildDublinCore(books, s) {
  const rec = (b) => {
    const el = [];
    const put = (t, v) => { if (String(v ?? '').trim() !== '') el.push(`      <dc:${t}>${xesc(v)}</dc:${t}>`); };
    put('title', [b.title, b.subtitle].filter(Boolean).join(': '));
    put('creator', b.author);
    put('publisher', b.publisher);
    put('date', b.year);
    put('language', LANG_ISO[b.language] || b.language);
    put('description', b.annotation);
    put('type', b.category_name || 'text');
    put('format', b.pages);
    put('identifier', b.isbn ? 'ISBN ' + b.isbn : '');
    put('identifier', 'inv:' + (b.inv_number ?? b.id));
    put('coverage', b.city);
    put('rights', s.lib_name || s.org || '');
    for (const kw of String(b.keywords || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)) put('subject', kw);
    if (b.udk) put('subject', 'УДК ' + b.udk);
    return `    <record>\n${el.join('\n')}\n    </record>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    books.map(rec).join('\n') + `\n</metadata>\n`;
}
function exportBooksFor() {
  return db.prepare(`${BOOK_SELECT} ORDER BY b.inv_number`).all();
}
ipcMain.handle('catalog:exportMarc', async () => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Експорт в UNIMARC / MARCXML',
      defaultPath: 'fond-unimarc.xml',
      filters: [{ name: 'MARCXML', extensions: ['xml'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
    const books = exportBooksFor();
    fs.writeFileSync(filePath, buildMarcXml(books), 'utf8');
    logAudit('Експорт UNIMARC', filePath + ' — ' + books.length + ' записа');
    return { ok: true, data: { path: filePath, count: books.length } };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('catalog:exportDc', async () => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Експорт в Dublin Core',
      defaultPath: 'fond-dublincore.xml',
      filters: [{ name: 'XML', extensions: ['xml'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
    const books = exportBooksFor();
    const s = db.prepare('SELECT lib_name, org FROM settings WHERE id = 1').get() || {};
    fs.writeFileSync(filePath, buildDublinCore(books, s), 'utf8');
    logAudit('Експорт Dublin Core', filePath + ' — ' + books.length + ' записа');
    return { ok: true, data: { path: filePath, count: books.length } };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('catalog:export', async () => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Експорт на онлайн каталог',
      defaultPath: 'katalog.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
    const payload = buildCatalogPayload();
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    logAudit('Експорт на каталог', filePath + ' — ' + payload.items.length + ' записа');
    return { ok: true, data: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('catalog:exportCsv', async () => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Експорт на фонда (CSV)',
      defaultPath: 'fond.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
    const rows = db.prepare(`${BOOK_SELECT} ORDER BY b.inv_number`).all();
    const h = ['Инв. №', 'Баркод', 'Дата на вписване', 'Категория', 'Автор', 'Заглавие', 'Място', 'Издателство',
      'Година', 'ISBN', 'Език', 'УДК', 'Сигнатура', 'Отдел', 'Цена (лв.)', 'Цена (€)', 'Състояние'];
    // Защита срещу CSV/formula injection (Фаза 3): свободните текстови полета (заглавие,
    // автор и т.н.) идват от каталогизатора и биха могли случайно или нарочно да
    // започват с =, +, -, @ — символи, които Excel/LibreOffice изпълняват като формула
    // при отваряне на файла (напр. заглавие "=cmd|'/c calc'!A1"). Водещ апостроф
    // отпред неутрализира изпълнението, без видимо да променя стойността.
    const esc = csvCell;
    const csv = [h.join(';')].concat(rows.map(b => [
      b.inv_number, b.barcode, b.register_date, b.category_name, b.author, b.title, b.city, b.publisher,
      b.year, b.isbn, b.language, b.udk, b.call_number, b.department,
      (b.price || 0).toFixed(2), ((b.price || 0) / 1.95583).toFixed(2), b.status
    ].map(esc).join(';'))).join('\r\n');
    fs.writeFileSync(filePath, '﻿' + csv, 'utf8');
    return { ok: true, data: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
