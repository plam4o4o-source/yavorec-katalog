const { app, BrowserWindow, ipcMain, dialog, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const importers = require('./importers');
const { autoUpdater } = require('electron-updater');

let db;
let CURRENT_USER = '';

// Фиксиран курс на БНБ, същият като в интерфейса.
const EUR_RATE = 1.95583;

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

  if (isNew) console.log('Нова база данни създадена на:', dbPath);
}

ipcMain.handle('dbLocation:get', () =>
  run(() => ({ folder: resolveDbDir(), isDefault: !readConfig().dbFolder, isPackaged: app.isPackaged }))
);
ipcMain.handle('dbLocation:choose', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Изберете папка за базата данни (локална или мрежова)',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
    const newDir = filePaths[0];
    const oldPath = resolveDbPath();
    const newPath = path.join(newDir, 'library.db');
    if (path.resolve(oldPath) === path.resolve(newPath)) return { ok: false, error: 'Това е текущата папка на базата данни.' };
    if (db) { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); }
    if (fs.existsSync(oldPath)) fs.copyFileSync(oldPath, newPath);
    const cfg = readConfig();
    cfg.dbFolder = newDir;
    writeConfig(cfg);
    app.relaunch();
    app.exit(0);
    return { ok: true, data: newDir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('dbLocation:resetDefault', () =>
  run(() => {
    const cfg = readConfig();
    delete cfg.dbFolder;
    writeConfig(cfg);
    app.relaunch();
    app.exit(0);
  })
);

/* ---------------- Резервни копия ----------------
   Автоматично, веднъж на ден (при първото стартиране за деня — програмата не
   тече постоянно на заден фон, затова "веднъж на ден" на практика означава
   "при следващото пускане"), плюс ръчно копие по всяко време. Копията служат
   за възстановяване след срив на компютъра/програмата, или за пренасяне на
   базата данни на друг компютър със същата програма. */
const AUTO_BACKUP_KEEP_DAYS = 30;
function backupsDir() {
  const dir = path.join(resolveDbDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
/* Криптиране на резервни копия (по избор, с парола) ----------------------------
   AES-256-GCM; ключът се извежда от паролата чрез scrypt със случайна сол за всеки
   файл. GCM дава и проверка за цялост — повреден или подправен файл се засича при
   разшифроването, вместо да се възстанови мълчаливо счупена база данни.

   Формат: "INVBAK01" (8B) | сол (16B) | iv (12B) | authTag (16B) | шифрован SQLite файл

   Криптират се само РЪЧНИТЕ копия (тези, които реално пътуват на USB/друг компютър).
   Автоматичните дневни копия остават некриптирани — те лежат до самата база данни,
   която също е некриптирана, така че парола там не би добавила реална защита, а
   само риск от заключване на данните. */
const BACKUP_MAGIC = Buffer.from('INVBAK01', 'utf8');
function deriveBackupKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
}
function isEncryptedBackup(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(BACKUP_MAGIC.length);
    const read = fs.readSync(fd, head, 0, BACKUP_MAGIC.length, 0);
    fs.closeSync(fd);
    return read === BACKUP_MAGIC.length && head.equals(BACKUP_MAGIC);
  } catch (e) {
    return false;
  }
}
function encryptBackupFile(plainPath, destPath, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveBackupKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = fs.readFileSync(plainPath);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  fs.writeFileSync(destPath, Buffer.concat([BACKUP_MAGIC, salt, iv, cipher.getAuthTag(), enc]));
}
function decryptBackupToTemp(srcPath, password) {
  const buf = fs.readFileSync(srcPath);
  const salt = buf.subarray(8, 24);
  const iv = buf.subarray(24, 36);
  const tag = buf.subarray(36, 52);
  const enc = buf.subarray(52);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveBackupKey(password, salt), iv);
  decipher.setAuthTag(tag);
  let dec;
  try {
    dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch (e) {
    throw new Error('Грешна парола или повреден файл с резервно копие.');
  }
  const tmp = path.join(app.getPath('temp'), 'inventar-restore-' + Date.now() + '.db');
  fs.writeFileSync(tmp, dec);
  return tmp;
}

function doBackupTo(destPath, password) {
  if (db) db.pragma('wal_checkpoint(TRUNCATE)');
  if (password) encryptBackupFile(resolveDbPath(), destPath, password);
  else fs.copyFileSync(resolveDbPath(), destPath);
}
function pruneOldAutoBackups() {
  const dir = backupsDir();
  const cutoff = Date.now() - AUTO_BACKUP_KEEP_DAYS * 86400000;
  fs.readdirSync(dir).forEach(f => {
    if (!f.startsWith('auto-')) return;
    const full = path.join(dir, f);
    try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch (e) { /* игнорирай */ }
  });
}
function autoBackupIfNeeded() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dest = path.join(backupsDir(), `auto-${today}.db`);
    if (!fs.existsSync(dest)) {
      doBackupTo(dest);
      pruneOldAutoBackups();
      console.log('Автоматично резервно копие:', dest);
    }
  } catch (err) {
    console.error('Автоматично резервно копие — грешка:', err.message);
  }
}
function backupTimestamp() {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
}
ipcMain.handle('backup:list', () =>
  run(() => {
    const dir = backupsDir();
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.db') || f.endsWith('.invbak'))
      .map(f => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return {
          name: f, path: full, size: st.size, mtime: st.mtimeMs,
          auto: f.startsWith('auto-'), encrypted: isEncryptedBackup(full)
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  })
);
ipcMain.handle('backup:now', async (e, opts) => {
  try {
    const password = opts && opts.password ? String(opts.password) : '';
    const ext = password ? 'invbak' : 'db';
    const defaultPath = path.join(backupsDir(), `Inventar-backup-${backupTimestamp()}.${ext}`);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Направи резервно копие (може да е и на USB/мрежов диск за пренасяне на друг компютър)',
      defaultPath,
      filters: password
        ? [{ name: 'Криптирано резервно копие', extensions: ['invbak'] }]
        : [{ name: 'SQLite база данни', extensions: ['db'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
    doBackupTo(filePath, password);
    logAudit('Резервно копие', (password ? 'ръчно криптирано копие: ' : 'ръчно копие: ') + filePath);
    return { ok: true, data: filePath, encrypted: !!password };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
function performRestore(sourcePath, password) {
  let realSource = sourcePath;
  let tmpToClean = null;
  if (isEncryptedBackup(sourcePath)) {
    if (!password) throw new Error('Файлът е криптиран — необходима е парола.');
    realSource = decryptBackupToTemp(sourcePath, password);
    tmpToClean = realSource;
  }
  const safetyPath = path.join(backupsDir(), `before-restore-${backupTimestamp()}.db`);
  if (db) { db.pragma('wal_checkpoint(TRUNCATE)'); }
  const activePath = resolveDbPath();
  if (fs.existsSync(activePath)) fs.copyFileSync(activePath, safetyPath);
  if (db) { db.close(); db = null; }
  fs.copyFileSync(realSource, activePath);
  if (tmpToClean) { try { fs.unlinkSync(tmpToClean); } catch (e) { /* временният файл ще се изчисти от системата */ } }
  app.relaunch();
  app.exit(0);
}
ipcMain.handle('backup:restoreFromList', (e, { path: sourcePath, password }) =>
  run(() => {
    if (!fs.existsSync(sourcePath)) throw new Error('Файлът с резервното копие не е намерен.');
    if (isEncryptedBackup(sourcePath) && !password) return { needsPassword: true, path: sourcePath };
    performRestore(sourcePath, password);
    return { needsPassword: false };
  })
);
ipcMain.handle('backup:restoreBrowse', async (e, opts) => {
  try {
    let target = opts && opts.path;
    if (!target) {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Изберете файл с резервно копие за възстановяване',
        properties: ['openFile'],
        filters: [
          { name: 'Резервни копия (.db, .invbak)', extensions: ['db', 'invbak'] },
          { name: 'Всички файлове', extensions: ['*'] }
        ]
      });
      if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
      target = filePaths[0];
    }
    const password = opts && opts.password ? String(opts.password) : '';
    if (isEncryptedBackup(target) && !password) {
      return { ok: true, data: { needsPassword: true, path: target } };
    }
    performRestore(target, password);
    return { ok: true, data: { needsPassword: false } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
function logAudit(action, detail) {
  db.prepare('INSERT INTO audit_log (user, action, detail) VALUES (?, ?, ?)')
    .run(CURRENT_USER || '', action, detail || '');
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

/* ---------------- Служители ---------------- */
ipcMain.handle('employees:list', () => run(() => db.prepare('SELECT * FROM employees ORDER BY active DESC, name').all()));
ipcMain.handle('employees:create', (e, name) =>
  run(() => {
    if (!name || !name.trim()) throw new Error('Въведете име на служителя.');
    const info = db.prepare('INSERT INTO employees (name) VALUES (?)').run(name.trim());
    logAudit('Нов служител', name.trim());
    return info.lastInsertRowid;
  })
);
ipcMain.handle('employees:update', (e, { id, name, active }) =>
  run(() => {
    const cur = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!cur) throw new Error('Служителят не е намерен.');
    db.prepare('UPDATE employees SET name=?, active=? WHERE id=?').run(
      name !== undefined && name !== null ? name.trim() : cur.name,
      active !== undefined && active !== null ? (active ? 1 : 0) : cur.active,
      id
    );
  })
);
ipcMain.handle('employees:delete', (e, id) =>
  run(() => { db.prepare('DELETE FROM employees WHERE id = ?').run(id); })
);
ipcMain.handle('app:getVersion', () => run(() => app.getVersion()));

/* ---------------- Търсене по ISBN (Google Books и Open Library) ----------------
   Заявките се правят от главния процес, а не от интерфейса, защото Content-Security-Policy
   на страницата допуска само собствени ресурси. net.fetch минава през мрежовия стек на
   Chromium, тоест ползва системните настройки за прокси, за разлика от обикновения https
   модул на Node. */
function normalizeIsbn(raw) {
  const s = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return (s.length === 10 || s.length === 13) ? s : '';
}
// Езиковите кодове на двете услуги са двубуквени (bg, en…), а програмата пази езика с
// думи на български, както е в падащото меню.
const ISBN_LANG = {
  bg: 'български', en: 'английски', ru: 'руски', de: 'немски', fr: 'френски',
  es: 'испански', it: 'италиански', tr: 'турски', el: 'гръцки', ro: 'румънски',
  sr: 'сръбски', mk: 'македонски', pl: 'полски', cs: 'чешки', uk: 'украински'
};
// Осем секунди таван на заявка: при недостъпна услуга бутонът в интерфейса не бива да
// стои „зает“ неопределено дълго. Двете услуги се питат едновременно, така че общото
// изчакване също е около осем секунди.
async function fetchJson(url) {
  const res = await net.fetch(url, {
    headers: { 'User-Agent': 'Inventar-Library-System' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    // 4xx/5xx е отговор на услугата, а не липса на връзка — двете се разграничават,
    // за да не се каже „няма интернет“, когато книгата просто я няма.
    const err = new Error('HTTP ' + res.status); err.httpStatus = res.status; throw err;
  }
  return await res.json();
}
async function lookupGoogleBooks(isbn) {
  const d = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
  const v = d && d.items && d.items[0] && d.items[0].volumeInfo;
  if (!v) return null;
  const img = v.imageLinks || {};
  return {
    source: 'Google Books',
    title: v.title || '',
    subtitle: v.subtitle || '',
    author: (v.authors || []).join(', '),
    publisher: v.publisher || '',
    year: (v.publishedDate || '').slice(0, 4),
    pages: v.pageCount ? String(v.pageCount) : '',
    language: ISBN_LANG[v.language] || '',
    annotation: v.description || '',
    keywords: (v.categories || []).join(', '),
    // Изображенията идват през http; https е нужно, за да се покажат в каталога на сайта.
    cover_url: (img.thumbnail || img.smallThumbnail || '').replace(/^http:/, 'https:'),
    city: ''
  };
}
async function lookupOpenLibrary(isbn) {
  const d = await fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  const v = d && d['ISBN:' + isbn];
  if (!v) return null;
  const pub = (v.publish_places || [])[0];
  return {
    source: 'Open Library',
    title: v.title || '',
    subtitle: v.subtitle || '',
    author: (v.authors || []).map(a => a.name).join(', '),
    publisher: (v.publishers || []).map(p => p.name).join(', '),
    year: String(v.publish_date || '').match(/\d{4}/)?.[0] || '',
    pages: v.number_of_pages ? String(v.number_of_pages) : '',
    language: '',
    annotation: (v.notes && (v.notes.value || v.notes)) || '',
    keywords: (v.subjects || []).slice(0, 8).map(s => s.name).join(', '),
    cover_url: (v.cover && (v.cover.large || v.cover.medium || v.cover.small)) || '',
    city: pub ? pub.name : ''
  };
}
/* ---------------- SRU (Search/Retrieve via URL) — внасяне на MARC записи ----------------
   За разлика от Google Books/Open Library (търговски метаданни), SRU носи истински
   библиотечни MARC записи. НБКМ и COBISS изискват подписано споразумение за достъп до
   техните SRU/Z39.50 сървъри, затова по подразбиране се ползва каталогът на Library of
   Congress — публичен, безплатен, без регистрация. Адресът е сменяем от Настройки, за
   да проработи веднага, ако библиотеката получи достъп до българско хранилище. */
const SRU_ENDPOINT_DEFAULT = 'http://lx2.loc.gov:210/lcdb';
const MARC_LANG = {
  bul: 'български', eng: 'английски', rus: 'руски', ger: 'немски', deu: 'немски',
  gre: 'гръцки', ell: 'гръцки', fre: 'френски', fra: 'френски', spa: 'испански',
  ita: 'италиански', tur: 'турски', rum: 'румънски', ron: 'румънски',
  scr: 'сръбски', srp: 'сръбски', mac: 'македонски', mkd: 'македонски',
  pol: 'полски', cze: 'чешки', ces: 'чешки', ukr: 'украински'
};
function xmlUnescape(str) {
  return String(str || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}
// Целенасочен парсер само за MARCXML структурата (leader/controlfield/datafield/subfield),
// не общ XML парсер — MARCXML е достатъчно регулярен формат за това. Записите се
// разпознават по <leader>, който е уникален за всеки MARC запис в отговора.
function parseMarcXml(xml) {
  const records = [];
  const parts = String(xml || '').split(/<leader>/i).slice(1);
  for (const part of parts) {
    const endIdx = part.search(/<\/record>/i);
    const chunk = endIdx >= 0 ? part.slice(0, endIdx) : part;
    const fields = {};
    const dfRe = /<datafield\s+tag="(\d{3})"[^>]*>([\s\S]*?)<\/datafield>/gi;
    let m;
    while ((m = dfRe.exec(chunk))) {
      const subs = [];
      const sfRe = /<subfield\s+code="([^"]*)"\s*>([\s\S]*?)<\/subfield>/gi;
      let sm;
      while ((sm = sfRe.exec(m[2]))) subs.push({ code: sm[1], text: xmlUnescape(sm[2]).trim() });
      (fields[m[1]] = fields[m[1]] || []).push(subs);
    }
    records.push(fields);
  }
  return records;
}
function subVal(subs, code) {
  const s = (subs || []).find(x => x.code === code);
  return s ? s.text : '';
}
// MARC подполетата свършват с ISBD пунктуация (" /", " :", " ,"...), която тук не ни
// трябва — маха се последната пунктуационна group заедно с празнините около нея.
const trimMarcPunct = (s) => String(s || '').replace(/\s*[:;,./]+\s*$/, '').trim();
function marcToBook(fields) {
  const f245 = (fields['245'] || [])[0] || [];
  const title = trimMarcPunct(subVal(f245, 'a'));
  const subtitle = trimMarcPunct(subVal(f245, 'b'));
  const authorSubs = (fields['100'] || [])[0] || (fields['700'] || [])[0] || [];
  const author = trimMarcPunct(subVal(authorSubs, 'a'));
  const fPub = (fields['264'] || [])[0] || (fields['260'] || [])[0] || [];
  const city = trimMarcPunct(subVal(fPub, 'a'));
  const publisher = trimMarcPunct(subVal(fPub, 'b'));
  const year = (subVal(fPub, 'c').match(/\d{4}/) || [])[0] || '';
  const f300 = (fields['300'] || [])[0] || [];
  const pages = (subVal(f300, 'a').match(/\d+/) || [])[0] || '';
  const langCode = subVal((fields['041'] || [])[0] || [], 'a').toLowerCase();
  const keywords = (fields['650'] || [])
    .map(s => trimMarcPunct(subVal(s, 'a'))).filter(Boolean).join(', ');
  const isbn = subVal((fields['020'] || [])[0] || [], 'a').replace(/\s*\(.*\)\s*$/, '').trim();
  return {
    source: 'SRU (MARC)', title, subtitle, author, publisher, city, year, pages,
    language: MARC_LANG[langCode] || '', keywords, annotation: '', cover_url: '', isbn
  };
}
async function sruLookupIsbn(isbn, endpoint) {
  const url = `${endpoint}?version=1.1&operation=searchRetrieve&recordSchema=marcxml&maximumRecords=1` +
    `&query=${encodeURIComponent('bath.isbn=' + isbn)}`;
  const res = await net.fetch(url, {
    headers: { 'User-Agent': 'Inventar-Library-System' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) { const err = new Error('HTTP ' + res.status); err.httpStatus = res.status; throw err; }
  const xml = await res.text();
  if (/<numberOfRecords>0<\/numberOfRecords>/i.test(xml)) return null;
  const records = parseMarcXml(xml);
  if (!records.length) return null;
  const book = marcToBook(records[0]);
  return book.title ? book : null;
}
ipcMain.handle('sru:lookup', async (e, raw) => {
  const isbn = normalizeIsbn(raw);
  if (!isbn) return { ok: false, error: 'Невалиден ISBN — очакват се 10 или 13 цифри.' };
  const s = db.prepare('SELECT sru_endpoint FROM settings WHERE id = 1').get() || {};
  const endpoint = (s.sru_endpoint || '').trim() || SRU_ENDPOINT_DEFAULT;
  try {
    const data = await sruLookupIsbn(isbn, endpoint);
    if (!data) return { ok: false, error: 'Няма намерен MARC запис с този ISBN в „' + endpoint + '“.' };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: 'Няма връзка със SRU сървъра (' + endpoint + ') или той не отговаря.' };
  }
});

ipcMain.handle('isbn:lookup', async (e, raw) => {
  const isbn = normalizeIsbn(raw);
  if (!isbn) return { ok: false, error: 'Невалиден ISBN — очакват се 10 или 13 цифри.' };
  // Двете услуги се питат заедно и се допълват: Google Books обикновено дава език и
  // анотация, Open Library — място на издаване и предметни рубрики.
  const [rg, ro] = await Promise.allSettled([lookupGoogleBooks(isbn), lookupOpenLibrary(isbn)]);
  const g = rg.status === 'fulfilled' ? rg.value : null;
  const o = ro.status === 'fulfilled' ? ro.value : null;
  if (!g && !o) {
    // Ако и двете услуги са се провалили с изключение, проблемът е във връзката, а не в
    // това, че книгата липсва — съобщението трябва да казва правилното нещо.
    const bothFailed = rg.status === 'rejected' && ro.status === 'rejected';
    return {
      ok: false,
      error: bothFailed
        ? 'Няма връзка с Google Books и Open Library. Проверете интернет връзката и опитайте пак.'
        : 'Няма намерено заглавие с този ISBN в Google Books и Open Library.'
    };
  }
  const pick = (k) => (g && g[k]) || (o && o[k]) || '';
  const sources = [g && g.source, o && o.source].filter(Boolean);
  return {
    ok: true, data: {
      isbn,
      title: pick('title'), subtitle: pick('subtitle'), author: pick('author'),
      publisher: pick('publisher'), city: pick('city'), year: pick('year'),
      pages: pick('pages'), language: pick('language'), keywords: pick('keywords'),
      annotation: pick('annotation'), cover_url: pick('cover_url'),
      sources: sources.join(' и ')
    }
  };
});

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

/* ---------------- Категории ---------------- */
ipcMain.handle('categories:list', () =>
  run(() => db.prepare('SELECT * FROM categories ORDER BY name').all())
);
ipcMain.handle('categories:create', (e, name) =>
  run(() => db.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim()))
);
ipcMain.handle('categories:update', (e, { id, name }) =>
  run(() => db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), id))
);
ipcMain.handle('categories:delete', (e, id) =>
  run(() => db.prepare('DELETE FROM categories WHERE id = ?').run(id))
);

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
   Едно и също име се въвежда по различен начин („Вазов, Иван“, „Иван Вазов“,
   „И. Вазов“) и записите се разпиляват. Тук се събират наличните стойности за
   автодовършване и се откриват вероятните дублети, за да бъдат слети. */
const AUTHORITY_FIELDS = {
  author: 'автор', publisher: 'издателство', city: 'място на издаване',
  language: 'език', udk: 'УДК', keywords: 'ключови думи', department: 'отдел'
};
// Ключ за сравнение: без пунктуация и главни букви, думите подредени по азбучен
// ред. Така „Вазов, Иван“ и „Иван Вазов“ дават един и същ ключ.
function authKey(v) {
  return String(v || '').toLowerCase()
    .replace(/[.,;:„“"'`()\[\]]/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}
function nameTokens(v) {
  return String(v || '').toLowerCase()
    .replace(/[.,;:„“"'`()\[\]]/g, ' ')
    .split(/\s+/).filter(Boolean);
}
/* Хлабаво сравнение, което хваща и съкратените имена: „И. Вазов“ = „Иван Вазов“.
   Правилото е по-строго, отколкото изглежда — по-късото име трябва да се съдържа
   изцяло в по-дългото, а всяка инициала да съвпада с началото на останала дума.
   Затова „Димитър Колев“ и „Димитър Костов“ НЕ съвпадат: втората пълна дума е
   различна. (Първият вариант сравняваше само „най-дългата дума“ плюс инициали и
   ги смяташе за дубликати, защото за „Димитър Колев“ приемаше „Димитър“ за
   фамилия.) */
function looseMatch(a, b) {
  const A = nameTokens(a), B = nameTokens(b);
  if (!A.length || !B.length) return false;
  const fullA = A.filter(t => t.length > 1), fullB = B.filter(t => t.length > 1);
  const initA = A.filter(t => t.length === 1), initB = B.filter(t => t.length === 1);
  const aShorter = fullA.length <= fullB.length;
  const short = aShorter ? fullA : fullB;
  const long = (aShorter ? fullB : fullA).slice();
  const shortInit = aShorter ? initA : initB;
  for (const w of short) {
    const i = long.indexOf(w);
    if (i < 0) return false;
    long.splice(i, 1);
  }
  for (const ini of shortInit) {
    const i = long.findIndex(w => w[0] === ini);
    if (i < 0) return false;
    long.splice(i, 1);
  }
  return true;
}
function authorityValues(field) {
  if (!(field in AUTHORITY_FIELDS)) throw new Error('Непознато поле: ' + field);
  return db.prepare(
    `SELECT ${field} AS value, COUNT(*) AS n FROM books
     WHERE ${field} IS NOT NULL AND TRIM(${field}) <> '' GROUP BY ${field} ORDER BY n DESC, ${field}`
  ).all();
}
ipcMain.handle('authorities:fields', () => run(() => AUTHORITY_FIELDS));
ipcMain.handle('authorities:list', (e, field) => run(() => authorityValues(field)));
// Стойностите за автодовършване във формата за книга — всички полета наведнъж.
ipcMain.handle('authorities:suggest', () =>
  run(() => {
    const out = {};
    for (const f of Object.keys(AUTHORITY_FIELDS)) out[f] = authorityValues(f).map(r => r.value);
    return out;
  })
);
// Групи вероятни дублети. strict=true сравнява само разместени думи, иначе се
// включват и съкратените имена, което е по-широко и изисква повече внимание.
ipcMain.handle('authorities:duplicates', (e, { field, loose }) =>
  run(() => {
    const rows = authorityValues(field).filter(r => authKey(r.value));
    let buckets;
    if (!loose) {
      const m = new Map();
      for (const r of rows) {
        const k = authKey(r.value);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      buckets = [...m.values()];
    } else {
      // Сравнение всеки-с-всеки през union-find. Стойностите са няколкостотин,
      // затова цената е нищожна, а резултатът е далеч по-точен от ключ.
      const parent = rows.map((_, i) => i);
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          if (looseMatch(rows[i].value, rows[j].value)) {
            const a = find(i), b = find(j);
            if (a !== b) parent[a] = b;
          }
        }
      }
      const m = new Map();
      rows.forEach((r, i) => {
        const k = find(i);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      });
      buckets = [...m.values()];
    }
    return buckets
      .filter(g => g.length > 1)
      .map(g => ({ items: g.sort((a, b) => b.n - a.n), total: g.reduce((s, r) => s + r.n, 0) }))
      .sort((a, b) => b.total - a.total);
  })
);
ipcMain.handle('authorities:merge', (e, { field, from, to }) =>
  run(() => {
    if (!(field in AUTHORITY_FIELDS)) throw new Error('Непознато поле: ' + field);
    const target = String(to || '').trim();
    if (!target) throw new Error('Липсва стойност, към която да се слее.');
    const list = (from || []).map(v => String(v)).filter(v => v && v !== target);
    if (!list.length) throw new Error('Няма избрани стойности за сливане.');
    const stmt = db.prepare(`UPDATE books SET ${field} = ? WHERE ${field} = ?`);
    let changed = 0;
    db.transaction(() => { for (const v of list) changed += stmt.run(target, v).changes; })();
    logAudit('Авторитетни данни', `${AUTHORITY_FIELDS[field]}: ${list.length} стойности слети в „${target}“ (${changed} документа)`);
    return { changed, merged: list.length };
  })
);

/* ---------------- Контролирани номенклатури (Koha: authorised_values) ----------------
   Един източник на истина за списъчните стойности. Категориите са фиксирани тук;
   стойностите се редактират в Настройки → „Номенклатури". opac_label е публичният
   надпис за онлайн каталога — навън не трябва да личи вътрешният жаргон. */
const AV_CATEGORIES = {
  department: 'Отдел / местонахождение',
  language: 'Език',
  location: 'Постоянно място (рафт, витрина, шкаф)'
};
function avOptions() {
  const out = {};
  for (const c of Object.keys(AV_CATEGORIES)) {
    out[c] = db.prepare('SELECT value, opac_label FROM authorised_values WHERE category = ? ORDER BY sort, value').all(c);
  }
  return out;
}
ipcMain.handle('av:categories', () => run(() => AV_CATEGORIES));
ipcMain.handle('av:options', () => run(() => avOptions()));
// Замества целия списък на една категория наведнъж — редакторът в Настройки подава
// пълния нов ред на стойностите (ред по ред), затова частични UPDATE-и не са нужни.
ipcMain.handle('av:save', (e, { category, values }) =>
  run(() => {
    if (!(category in AV_CATEGORIES)) throw new Error('Непозната номенклатура.');
    const list = (values || [])
      .map(v => ({ value: String(v.value || '').trim(), opac_label: String(v.opac_label || '').trim() || null }))
      .filter(v => v.value);
    const seen = new Set();
    for (const v of list) {
      if (seen.has(v.value)) throw new Error('Стойността „' + v.value + '“ се повтаря в списъка.');
      seen.add(v.value);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM authorised_values WHERE category = ?').run(category);
      const ins = db.prepare('INSERT INTO authorised_values (category, value, opac_label, sort) VALUES (?, ?, ?, ?)');
      list.forEach((v, i) => ins.run(category, v.value, v.opac_label, i));
    })();
    logAudit('Номенклатури', AV_CATEGORIES[category] + ': ' + list.length + ' стойности');
    return list.length;
  })
);

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
      return db.prepare(`${BOOK_SELECT}
        WHERE b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ? OR b.barcode LIKE ? OR CAST(b.inv_number AS TEXT) LIKE ?
        ORDER BY ${order}`).all(q, q, q, q, q);
    }
    return db.prepare(`${BOOK_SELECT} ORDER BY ${order}`).all();
  })
);
ipcMain.handle('books:get', (e, id) => run(() => db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id)));
ipcMain.handle('books:byBarcode', (e, code) =>
  run(() => db.prepare(`${BOOK_SELECT} WHERE b.barcode = ? OR CAST(b.inv_number AS TEXT) = ?`).get(code, code))
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
    writeCatalogIfConfigured();
    return id;
  })
);
ipcMain.handle('books:update', (e, book) =>
  run(() => {
    const tx = db.transaction((b) => {
      const prev = db.prepare('SELECT status, status_date FROM books WHERE id = ?').get(b.id);
      const payload = bookPayload(b, prev);
      db.prepare(`
        UPDATE books SET ${BOOK_FIELDS.map(f => f + '=@' + f).join(',')} WHERE id=@id
      `).run(Object.assign({ id: b.id }, payload));
      db.prepare(`
        INSERT INTO inventory (book_id, quantity) VALUES (?, ?)
        ON CONFLICT(book_id) DO UPDATE SET quantity = excluded.quantity
      `).run(b.id, b.quantity != null ? parseInt(b.quantity, 10) : 1);
      logAudit('Редакция на документ', 'инв. № ' + (payload.inv_number ?? '—') + ' — ' + b.title);
    });
    tx(book);
    writeCatalogIfConfigured();
  })
);
ipcMain.handle('books:delete', (e, id) =>
  run(() => {
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    writeCatalogIfConfigured();
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
    writeCatalogIfConfigured();
    return changes;
  })
);
ipcMain.handle('books:addCheck', (e, { bookId, date }) =>
  run(() => db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(bookId, date || today()))
);
ipcMain.handle('books:checks', (e, bookId) =>
  run(() => db.prepare('SELECT date FROM inventory_checks WHERE book_id = ? ORDER BY date').all(bookId))
);

/* ---------------- Инвентарна книга (Приложение № 4 към чл. 16, ал. 1) ---------------- */
ipcMain.handle('invBook:list', () =>
  run(() => {
    const rows = db.prepare(`
      SELECT b.*, c.name AS category_name,
             a.no AS acq_no, a.date AS acq_date,
             d.no AS act_no, d.date AS act_date
      FROM books b
      LEFT JOIN categories c ON c.id = b.category_id
      LEFT JOIN acquisitions a ON a.id = b.acquisition_id
      LEFT JOIN deaccession_acts d ON d.id = b.deaccession_act_id
      ORDER BY b.inv_number
    `).all();
    const checks = db.prepare('SELECT book_id, date FROM inventory_checks ORDER BY date').all();
    const byBook = {};
    checks.forEach(c => { (byBook[c.book_id] = byBook[c.book_id] || []).push(c.date); });
    rows.forEach(r => { r.checks = byBook[r.id] || []; });
    return rows;
  })
);

/* ---------------- Постъпления (партиди) ---------------- */
ipcMain.handle('acquisitions:list', () =>
  run(() => db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM books b WHERE b.acquisition_id = a.id) AS registered_count,
           (SELECT COALESCE(SUM(price),0) FROM books b WHERE b.acquisition_id = a.id) AS registered_value
    FROM acquisitions a ORDER BY a.date DESC, a.no DESC
  `).all())
);
ipcMain.handle('acquisitions:get', (e, id) =>
  run(() => {
    const acq = db.prepare('SELECT * FROM acquisitions WHERE id = ?').get(id);
    if (!acq) return null;
    acq.items = db.prepare(`${BOOK_SELECT} WHERE b.acquisition_id = ? ORDER BY b.inv_number`).all(id);
    return acq;
  })
);
ipcMain.handle('acquisitions:nextNo', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const row = db.prepare('SELECT MAX(no) AS m FROM acquisitions WHERE year = ?').get(y);
    return (row.m || 0) + 1;
  })
);
ipcMain.handle('acquisitions:create', (e, a) =>
  run(() => {
    const info = db.prepare(`
      INSERT INTO acquisitions (no, year, date, how, from_source, doc_type, doc_no, doc_date, total_count, sum, donor_address, note)
      VALUES (@no, @year, @date, @how, @from_source, @doc_type, @doc_no, @doc_date, @total_count, @sum, @donor_address, @note)
    `).run({
      no: parseInt(a.no, 10), year: yearOf(a.date), date: a.date, how: a.how || null,
      from_source: a.from_source || null, doc_type: a.doc_type || null, doc_no: a.doc_no || null,
      doc_date: a.doc_date || null, total_count: parseInt(a.total_count, 10) || 0,
      sum: a.sum ? parseFloat(a.sum) : 0, donor_address: a.donor_address || null, note: a.note || null
    });
    logAudit('Постъпление', 'партида № ' + a.no + ' — ' + a.total_count + ' бр. от ' + a.from_source);
    return info.lastInsertRowid;
  })
);
ipcMain.handle('acquisitions:delete', (e, id) =>
  run(() => {
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM books WHERE acquisition_id = ?').get(id).n;
    if (cnt > 0) throw new Error('Партидата има инвентирани документи и не може да бъде изтрита.');
    db.prepare('DELETE FROM acquisitions WHERE id = ?').run(id);
  })
);

/* ---------------- Отчисляване (актове) ---------------- */
ipcMain.handle('deaccessionActs:list', () =>
  run(() => db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM deaccession_items i WHERE i.act_id = a.id) AS item_count,
           (SELECT COALESCE(SUM(price),0) FROM deaccession_items i WHERE i.act_id = a.id) AS item_value
    FROM deaccession_acts a ORDER BY a.date DESC, a.no DESC
  `).all())
);
ipcMain.handle('deaccessionActs:get', (e, id) =>
  run(() => {
    const act = db.prepare('SELECT * FROM deaccession_acts WHERE id = ?').get(id);
    if (!act) return null;
    act.items = db.prepare('SELECT * FROM deaccession_items WHERE act_id = ? ORDER BY inv_number').all(id);
    return act;
  })
);
ipcMain.handle('deaccessionActs:nextNo', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const row = db.prepare('SELECT MAX(no) AS m FROM deaccession_acts WHERE year = ?').get(y);
    return (row.m || 0) + 1;
  })
);
ipcMain.handle('deaccessionActs:findBook', (e, code) =>
  run(() => db.prepare(`${BOOK_SELECT} WHERE (b.barcode = ? OR CAST(b.inv_number AS TEXT) = ?) AND b.status != 'отчислен'`).get(code, code))
);
ipcMain.handle('deaccessionActs:create', (e, { act, bookIds }) =>
  run(() => {
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO deaccession_acts (no, year, date, order_no, reason_code, reason_text, disposal, attach, committee1, committee2, committee3)
        VALUES (@no, @year, @date, @order_no, @reason_code, @reason_text, @disposal, @attach, @committee1, @committee2, @committee3)
      `).run({
        no: parseInt(act.no, 10), year: yearOf(act.date), date: act.date, order_no: act.order_no || null,
        reason_code: parseInt(act.reason_code, 10), reason_text: act.reason_text,
        disposal: act.disposal || null, attach: act.attach || null,
        committee1: act.committee1 || null, committee2: act.committee2 || null, committee3: act.committee3 || null
      });
      const actId = info.lastInsertRowid;
      const insItem = db.prepare(`
        INSERT INTO deaccession_items (act_id, book_id, inv_number, author, title, volume, year, price, udk, category, language)
        VALUES (@act_id, @book_id, @inv_number, @author, @title, @volume, @year, @price, @udk, @category, @language)
      `);
      const closeLoans = db.prepare(`UPDATE loans SET date_in = ? WHERE book_id = ? AND date_in IS NULL`);
      bookIds.forEach(bookId => {
        const b = db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(bookId);
        if (!b) return;
        insItem.run({
          act_id: actId, book_id: b.id, inv_number: b.inv_number, author: b.author, title: b.title,
          volume: b.volume, year: b.year, price: b.price, udk: b.udk,
          category: b.category_name, language: b.language
        });
        db.prepare('UPDATE books SET status = ?, status_date = ?, deaccession_act_id = ?, deaccession_date = ? WHERE id = ?')
          .run('отчислен', act.date, actId, act.date, b.id);
        closeLoans.run(act.date, b.id);
      });
      db.prepare('UPDATE settings SET committee1=?, committee2=?, committee3=? WHERE id=1')
        .run(act.committee1 || null, act.committee2 || null, act.committee3 || null);
      logAudit('Отчисляване', 'акт № ' + act.no + ' — ' + bookIds.length + ' документа, причина: ' + act.reason_text);
      return actId;
    });
    const actId = tx();
    writeCatalogIfConfigured();
    return actId;
  })
);
ipcMain.handle('deaccessionActs:revoke', (e, id) =>
  run(() => {
    const tx = db.transaction(() => {
      const items = db.prepare('SELECT book_id FROM deaccession_items WHERE act_id = ?').all(id);
      items.forEach(it => {
        if (it.book_id) {
          db.prepare(`UPDATE books SET status='наличен', status_date=date('now'), deaccession_act_id=NULL, deaccession_date=NULL WHERE id=?`)
            .run(it.book_id);
        }
      });
      db.prepare('DELETE FROM deaccession_acts WHERE id = ?').run(id);
      logAudit('Анулиране на акт', 'акт № ' + id + ' е анулиран, документите са върнати във фонда');
    });
    tx();
    writeCatalogIfConfigured();
  })
);

/* ---------------- КДБФ — книга за движение на фонда ---------------- */
ipcMain.handle('kdbf:report', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const part1 = db.prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM books b WHERE b.acquisition_id=a.id) AS registered_count,
             (SELECT COALESCE(SUM(price),0) FROM books b WHERE b.acquisition_id=a.id) AS registered_value,
             (SELECT MIN(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS inv_from,
             (SELECT MAX(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS inv_to
      FROM acquisitions a WHERE a.year = ? ORDER BY a.no
    `).all(y);
    const part3 = db.prepare(`
      SELECT d.*, (SELECT COUNT(*) FROM deaccession_items i WHERE i.act_id=d.id) AS item_count,
             (SELECT COALESCE(SUM(price),0) FROM deaccession_items i WHERE i.act_id=d.id) AS item_value
      FROM deaccession_acts d WHERE d.year = ? ORDER BY d.no
    `).all(y);
    const end = y + '-12-31';
    const stockAt = (d) => db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS v FROM books
      WHERE register_date <= ? AND (deaccession_date IS NULL OR deaccession_date > ?)
    `).get(d, d);
    const stockEnd = stockAt(end);
    const acquiredYear = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS v FROM books WHERE substr(register_date,1,4) = ?`).get(y);
    const deaccYear = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(i.price),0) AS v FROM deaccession_items i
      JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
    `).get(y);
    return { part1, part3, stockEnd, acquiredYear, deaccYear, year: y };
  })
);

/* ---------------- Читатели ---------------- */
const READER_FIELDS = ['name', 'phone', 'address', 'address2', 'email', 'card_no', 'egn',
  'id_card_no', 'id_card_date', 'id_card_issuer', 'birth_date', 'category', 'registered_at',
  're_registered_at', 'status', 'gdpr_consent', 'gdpr_consent_date', 'parent_consent',
  'parent_consent_date', 'guarantor_name', 'guarantor_relation', 'guarantor_phone', 'note'];
/* prev — досегашният ред (при редакция). Датата на съгласието се записва в момента
   на отбелязване и се пази при следващи записи; голият флаг 0/1 без дата е слаба
   защита при проверка по ЗЗЛД/GDPR. Сваленото съгласие сваля и датата. */
function readerPayload(r, prev) {
  const out = {};
  READER_FIELDS.forEach(f => { out[f] = r[f] === undefined || r[f] === '' ? null : r[f]; });
  out.gdpr_consent = r.gdpr_consent ? 1 : 0;
  out.parent_consent = r.parent_consent ? 1 : 0;
  out.gdpr_consent_date = out.gdpr_consent ? ((prev && prev.gdpr_consent_date) || today()) : null;
  out.parent_consent_date = out.parent_consent ? ((prev && prev.parent_consent_date) || today()) : null;
  out.category = r.category || 'възрастен';
  out.status = r.status || 'активен';
  out.registered_at = r.registered_at || today();
  return out;
}
ipcMain.handle('readers:list', (e, query) =>
  run(() => {
    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      return db.prepare(`
        SELECT * FROM readers WHERE name LIKE ? OR phone LIKE ? OR card_no LIKE ? ORDER BY name
      `).all(q, q, q);
    }
    return db.prepare('SELECT * FROM readers ORDER BY name').all();
  })
);
ipcMain.handle('readers:get', (e, id) => run(() => db.prepare('SELECT * FROM readers WHERE id = ?').get(id)));
ipcMain.handle('readers:byCard', (e, card) => run(() => db.prepare('SELECT * FROM readers WHERE card_no = ?').get(card)));
ipcMain.handle('readers:create', (e, r) =>
  run(() => {
    checkRecordLimit('readers');
    const payload = readerPayload(r);
    const info = db.prepare(`
      INSERT INTO readers (${READER_FIELDS.join(',')}) VALUES (${READER_FIELDS.map(f => '@' + f).join(',')})
    `).run(payload);
    logAudit('Нов читател', 'карта ' + (r.card_no || '') + ' — ' + r.name);
    return info.lastInsertRowid;
  })
);
ipcMain.handle('readers:update', (e, r) =>
  run(() => {
    const prev = db.prepare('SELECT gdpr_consent_date, parent_consent_date FROM readers WHERE id = ?').get(r.id);
    const payload = readerPayload(r, prev);
    db.prepare(`UPDATE readers SET ${READER_FIELDS.map(f => f + '=@' + f).join(',')} WHERE id=@id`)
      .run(Object.assign({ id: r.id }, payload));
    logAudit('Редакция на читател', 'карта ' + (r.card_no || '') + ' — ' + r.name);
  })
);
// Сваля наказанието „преустановено заемане" предсрочно — решение на библиотекаря.
ipcMain.handle('readers:clearSuspension', (e, id) =>
  run(() => {
    db.prepare('UPDATE readers SET suspended_until = NULL WHERE id = ?').run(id);
    const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(id);
    logAudit('Снето наказание', r ? r.name : ('читател № ' + id));
  })
);

/* ---------------- Обслужване по домовете (Koha: housebound) ----------------
   График и дневник на посещенията при читатели, които не могат да идват сами.
   Всяко посещение влиза в потока от събития (kind='дома') и оттам дневникът
   предлага стойността за колоната a_visit_home („В заемна за дома"). */
ipcMain.handle('housebound:get', (e, readerId) =>
  run(() => {
    const p = db.prepare('SELECT * FROM housebound_profiles WHERE reader_id = ?').get(readerId) || null;
    const visits = db.prepare('SELECT * FROM housebound_visits WHERE reader_id = ? ORDER BY date DESC LIMIT 30').all(readerId);
    return { profile: p, visits };
  })
);
ipcMain.handle('housebound:save', (e, { reader_id, day, frequency, note }) =>
  run(() => {
    db.prepare(`INSERT INTO housebound_profiles (reader_id, day, frequency, note) VALUES (?, ?, ?, ?)
      ON CONFLICT(reader_id) DO UPDATE SET day=excluded.day, frequency=excluded.frequency, note=excluded.note`)
      .run(reader_id, day || null, frequency || null, note || null);
    const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
    logAudit('Обслужване по домовете', 'график за ' + (r ? r.name : reader_id));
  })
);
ipcMain.handle('housebound:remove', (e, readerId) =>
  run(() => { db.prepare('DELETE FROM housebound_profiles WHERE reader_id = ?').run(readerId); })
);
ipcMain.handle('housebound:addVisit', (e, { reader_id, date, note }) =>
  run(() => {
    const d = date || today();
    const info = db.prepare('INSERT INTO housebound_visits (reader_id, date, note) VALUES (?, ?, ?)').run(reader_id, d, note || null);
    logEvent('дома', { readerId: reader_id, date: d, note });
    const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
    logAudit('Посещение по домовете', (r ? r.name : reader_id) + ' — ' + d);
    return info.lastInsertRowid;
  })
);
ipcMain.handle('housebound:list', () =>
  run(() => db.prepare(`
    SELECT p.*, r.name, r.phone, r.address, r.address2,
           (SELECT MAX(v.date) FROM housebound_visits v WHERE v.reader_id = p.reader_id) AS last_visit
    FROM housebound_profiles p JOIN readers r ON r.id = p.reader_id ORDER BY r.name
  `).all())
);

/* ---------------- Лични данни: анонимизиране (Koha: pseudonymization) ----------------
   Върнати заемания, по-стари от N години, губят връзката с името: закачат се за
   служебния запис „— анонимизирани заемания —", а категорията и годината се снимат в
   anon_category — статистиката остава вярна („дете, 2024 г."), името изчезва.
   Настройка anonymize_years = 0 изключва всичко. Необратимо е — затова е ръчен бутон. */
function anonReaderId() {
  const NAME = '— анонимизирани заемания —';
  const r = db.prepare('SELECT id FROM readers WHERE name = ?').get(NAME);
  if (r) return r.id;
  return db.prepare(`INSERT INTO readers (name, category, status, registered_at, gdpr_consent)
    VALUES (?, '—', 'прекратен', date('now'), 0)`).run(NAME).lastInsertRowid;
}
function anonCutoff(years) { return `${new Date().getFullYear() - years}-01-01`; }
ipcMain.handle('gdpr:candidates', () =>
  run(() => {
    const s = db.prepare('SELECT anonymize_years FROM settings WHERE id = 1').get() || {};
    const years = parseInt(s.anonymize_years, 10) || 0;
    if (!years) return { years: 0, count: 0 };
    const anonId = db.prepare('SELECT id FROM readers WHERE name = ?').get('— анонимизирани заемания —');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM loans
      WHERE date_in IS NOT NULL AND date_in < ? AND anon_category IS NULL ${anonId ? 'AND reader_id != ?' : ''}`)
      .get(...(anonId ? [anonCutoff(years), anonId.id] : [anonCutoff(years)])).n;
    return { years, count, cutoff: anonCutoff(years) };
  })
);
ipcMain.handle('gdpr:anonymize', () =>
  run(() => {
    const s = db.prepare('SELECT anonymize_years FROM settings WHERE id = 1').get() || {};
    const years = parseInt(s.anonymize_years, 10) || 0;
    if (!years) throw new Error('Първо задайте срок в „Настройки“ → „Лични данни“ (0 = изключено).');
    const cutoff = anonCutoff(years);
    const anonId = anonReaderId();
    const tx = db.transaction(() => {
      const n = db.prepare(`
        UPDATE loans SET
          anon_category = COALESCE((SELECT r.category FROM readers r WHERE r.id = loans.reader_id), '—')
                          || ' · ' || substr(loans.date_out, 1, 4),
          reader_id = ?
        WHERE date_in IS NOT NULL AND date_in < ? AND anon_category IS NULL AND reader_id != ?
      `).run(anonId, cutoff, anonId).changes;
      // Събитията също губят връзката с читателя; категорията им е снимана още при записа.
      db.prepare('UPDATE events SET reader_id = NULL WHERE date < ? AND reader_id IS NOT NULL AND reader_id != ?')
        .run(cutoff, anonId);
      return n;
    });
    const n = tx();
    logAudit('Анонимизиране', n + ' върнати заемания отпреди ' + cutoff + ' са анонимизирани');
    return { anonymized: n, cutoff };
  })
);
ipcMain.handle('readers:delete', (e, id) => run(() => db.prepare('DELETE FROM readers WHERE id = ?').run(id)));

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
function applySuspension(readerId, daysLate) {
  const s = db.prepare('SELECT suspend_per_day, suspend_max FROM settings WHERE id = 1').get() || {};
  const per = Number(s.suspend_per_day) || 0;
  if (per <= 0 || daysLate <= 0) return null;
  const penalty = Math.min(Math.ceil(daysLate * per), s.suspend_max || 90);
  const r = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId);
  const base = (r && r.suspended_until && r.suspended_until > today()) ? r.suspended_until : today();
  const until = new Date(base);
  until.setDate(until.getDate() + penalty);
  const untilStr = until.toISOString().slice(0, 10);
  db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run(untilStr, readerId);
  logAudit('Наложено наказание', 'преустановено заемане до ' + untilStr + ' (' + daysLate + ' дни забава)');
  return untilStr;
}
function checkSuspended(readerId) {
  const r = db.prepare('SELECT name, suspended_until FROM readers WHERE id = ?').get(readerId);
  if (r && r.suspended_until && r.suspended_until > today()) {
    throw new Error('Заемането за ' + r.name + ' е преустановено до ' + r.suspended_until.split('-').reverse().join('.') +
      ' заради просрочени връщания. Наказанието се сваля от картона на читателя.');
  }
}

/* ---------------- Резервации ---------------- */
const HOLD_ACTIVE = "('чака','заделена')";
const HOLD_SELECT = `
  SELECT h.*, b.title, b.author, b.inv_number, b.barcode,
         r.name AS reader_name, r.card_no, r.phone
  FROM holds h
  JOIN books b ON b.id = h.book_id
  JOIN readers r ON r.id = h.reader_id
`;
// Най-старата активна резервация за книгата — тя определя кой е „наред“.
function firstActiveHold(bookId) {
  return db.prepare(`${HOLD_SELECT} WHERE h.book_id = ? AND h.status IN ${HOLD_ACTIVE} ORDER BY h.placed_at, h.id`).get(bookId);
}
// При заемане: читателят, който е наред, минава (резервацията му се изпълнява);
// всеки друг се отказва, докато резервацията стои — иначе заделената книга
// тихо заминава при трети човек.
function consumeHoldOnCheckout(bookId, readerId) {
  const h = firstActiveHold(bookId);
  if (!h) return;
  if (h.reader_id !== readerId) {
    throw new Error('Книгата е резервирана за ' + h.reader_name +
      (h.status === 'заделена' ? ' (заделена, чака взимане)' : '') +
      '. Откажете резервацията, ако все пак трябва да я заемете другиму.');
  }
  db.prepare("UPDATE holds SET status = 'изпълнена', resolved_at = datetime('now') WHERE id = ?").run(h.id);
}
// При връщане: най-старата чакаща резервация става „заделена“, за да не се
// върне книгата на рафта. Връща резервацията, за да я покаже екранът.
function activateHoldOnReturn(bookId) {
  const h = firstActiveHold(bookId);
  if (!h) return null;
  if (h.status === 'чака') {
    db.prepare("UPDATE holds SET status = 'заделена', ready_at = datetime('now') WHERE id = ?").run(h.id);
    h.status = 'заделена';
    logAudit('Заделена книга', 'инв. № ' + h.inv_number + ' — ' + h.title + ' за ' + h.reader_name);
  }
  return h;
}

ipcMain.handle('holds:list', () =>
  run(() => db.prepare(`${HOLD_SELECT} WHERE h.status IN ${HOLD_ACTIVE}
    ORDER BY CASE h.status WHEN 'заделена' THEN 0 ELSE 1 END, h.placed_at, h.id`).all())
);
ipcMain.handle('holds:add', (e, { reader_id, code }) =>
  run(() => {
    const b = db.prepare('SELECT * FROM books WHERE barcode = ? OR CAST(inv_number AS TEXT) = ?').get(code, code);
    if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
    if (b.status === 'отчислен') throw new Error('Инв. № ' + b.inv_number + ' е отчислен от фонда.');
    const openLoan = db.prepare('SELECT reader_id FROM loans WHERE book_id = ? AND date_in IS NULL').get(b.id);
    if (!openLoan) throw new Error('Инв. № ' + b.inv_number + ' е свободен — заемете го направо, без резервация.');
    if (openLoan.reader_id === reader_id) throw new Error('Читателят в момента държи тази книга.');
    const dup = db.prepare(`SELECT 1 FROM holds WHERE book_id = ? AND reader_id = ? AND status IN ${HOLD_ACTIVE}`).get(b.id, reader_id);
    if (dup) throw new Error('Този читател вече има резервация за книгата.');
    const info = db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(b.id, reader_id);
    const queue = db.prepare(`SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND status IN ${HOLD_ACTIVE}`).get(b.id).n;
    const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
    logAudit('Резервация', 'инв. № ' + b.inv_number + ' — ' + b.title + ' за ' + (r ? r.name : reader_id));
    return { id: info.lastInsertRowid, title: b.title, inv_number: b.inv_number, queue };
  })
);
ipcMain.handle('holds:cancel', (e, id) =>
  run(() => {
    const h = db.prepare(`${HOLD_SELECT} WHERE h.id = ?`).get(id);
    db.prepare("UPDATE holds SET status = 'отказана', resolved_at = datetime('now') WHERE id = ?").run(id);
    if (h) logAudit('Отказана резервация', 'инв. № ' + h.inv_number + ' — ' + h.title + ' (' + h.reader_name + ')');
  })
);
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
    writeCatalogIfConfigured();
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
      const daysLate = l.date_due ? Math.max(0, Math.round((new Date(date_in) - new Date(l.date_due)) / 864e5)) : 0;
      suspendedUntil = applySuspension(l.reader_id, daysLate);
    }
    writeCatalogIfConfigured();
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
    const s = db.prepare('SELECT extensions_count, extension_days FROM settings WHERE id = 1').get();
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
    const newDue = next.toISOString().slice(0, 10);
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
      const b = db.prepare(`${BOOK_SELECT} WHERE b.barcode = ? OR CAST(b.inv_number AS TEXT) = ?`).get(code, code);
      if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
      if (b.status === 'отчислен') throw new Error('Инв. № ' + b.inv_number + ' е отчислен от фонда.');
      const openLoan = db.prepare(`${LOAN_SELECT} WHERE l.book_id = ? AND l.date_in IS NULL`).get(b.id);
      if (openLoan) throw new Error('Инв. № ' + b.inv_number + ' вече е зает от ' + openLoan.reader_name + ' до ' + openLoan.date_due + '.');
      const s = db.prepare('SELECT max_books, loan_days FROM settings WHERE id = 1').get();
      const current = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ? AND date_in IS NULL').get(reader_id).n;
      if (s.max_books && current >= s.max_books) throw new Error('Достигнат е лимитът от ' + s.max_books + ' документа за читател.');
      checkSuspended(reader_id);
      consumeHoldOnCheckout(b.id, reader_id);
      const out = date_out || today();
      const due = new Date(out); due.setDate(due.getDate() + (s.loan_days || 30));
      const dueStr = due.toISOString().slice(0, 10);
      const info = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(reader_id, b.id, out, dueStr);
      logAudit('Заемане', 'инв. № ' + b.inv_number + ' — ' + b.title);
      logEvent('заемане', { bookId: b.id, readerId: reader_id, date: out });
      return { id: info.lastInsertRowid, title: b.title, inv_number: b.inv_number, date_due: dueStr };
    });
    const result = tx();
    writeCatalogIfConfigured();
    return result;
  })
);
ipcMain.handle('loans:returnByCode', (e, { code, date_in }) =>
  run(() => {
    const b = db.prepare('SELECT * FROM books WHERE barcode = ? OR CAST(inv_number AS TEXT) = ?').get(code, code);
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
    const suspendedUntil = applySuspension(loan.reader_id, daysLate);
    const hold = activateHoldOnReturn(b.id);
    writeCatalogIfConfigured();
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
    return {
      fundCount: fund.n, fundValue: fund.v, activeReaders, loansOpen, overdueCount, overdueRows,
      year: y, acquiredYear, deaccessionedYear, loansYear, readersYear,
      inventoryTarget: target, inventoryScannedYear: scannedYear, inventoryPct: pct,
      upcoming, holdsReady, holdsWaiting,
      today: { reregDue, longOverdue, anonCandidates, suspendedNow }
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
    const b = db.prepare(`SELECT * FROM books WHERE barcode = ? OR CAST(inv_number AS TEXT) = ?`).get(code, code);
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
ipcMain.handle('loans:mailto', (e, { email, subject, body }) => {
  try {
    if (!email) return { ok: false, error: 'Читателят няма записан имейл.' };
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
    const find = db.prepare('SELECT * FROM books WHERE barcode = ? OR CAST(inv_number AS TEXT) = ?');
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
    hint: 'Брой заявки по посока и състояние през годината.' }
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
    k: b.keywords || '', n: b.annotation || '', cv: b.cover_url || '', av: b.available > 0 ? 1 : 0
  };
}
function buildCatalogPayload() {
  const books = db.prepare(`${BOOK_SELECT} WHERE b.status != 'отчислен' AND b.department != 'служебен' ORDER BY b.title`).all();
  const s = db.prepare('SELECT lib_name, place FROM settings WHERE id = 1').get() || {};
  const opacMap = {};
  for (const r of db.prepare(`SELECT category, value, opac_label FROM authorised_values WHERE opac_label IS NOT NULL AND TRIM(opac_label) <> ''`).all()) {
    (opacMap[r.category] = opacMap[r.category] || {})[r.value] = r.opac_label;
  }
  return {
    library: s.lib_name || '', place: s.place || '',
    generated: new Date().toISOString().slice(0, 10),
    items: books.map(b => publicBookFields(b, opacMap))
  };
}
function catalogPayloadItemCount(payload) {
  return Array.isArray(payload) ? payload.length : (payload && Array.isArray(payload.items) ? payload.items.length : 0);
}
// Връща {written:true} при успешен запис, {written:false, blocked:true} ако предпазната
// мярка е спряла записа (виж коментара долу), или {written:false} при обикновена грешка/
// липсваща папка. Автоматичните извиквания (след запис на книга, заемане и т.н.) само
// подминават резултата; ръчните бутони го ползват, за да покажат ясно съобщение.
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

    writeCatalogIfConfigured();
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
  const w = writeCatalogIfConfigured();
  if (w.blocked) return { ok: false, error: 'Спряно: фондът в тази база данни излиза празен, а публикуваният каталог не е — за да публикувате наистина празен каталог, използвайте „Ръчен експорт“.' };
  const r = await gitPublish(s.catalog_folder);
  if (r.ok) logAudit('Онлайн каталог', 'публикувано в GitHub' + (r.committed ? '' : ' (нямаше промяна)'));
  return r;
});
ipcMain.handle('catalog:writeNow', () =>
  run(() => {
    const s = db.prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
    if (!s || !s.catalog_folder) throw new Error('Първо изберете папка за автоматичен запис.');
    const w = writeCatalogIfConfigured();
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
    const esc = (x) => '"' + String(x ?? '').replace(/"/g, '""') + '"';
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
