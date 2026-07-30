const { app, BrowserWindow, ipcMain, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { autoUpdater } = require('electron-updater');

let db;
let CURRENT_USER = '';

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
        next_inv_number=@next_inv_number, committee1=@committee1, committee2=@committee2, committee3=@committee3
      WHERE id = 1
    `).run(s);
    logAudit('Редакция на настройки', 'настройките на библиотеката са обновени');
  })
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
  'city', 'publisher', 'keywords', 'annotation', 'cover_url', 'department', 'status', 'price',
  'description', 'acquisition_id'];

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

function bookPayload(b) {
  const out = {};
  BOOK_FIELDS.forEach(f => { out[f] = b[f] === undefined || b[f] === '' ? null : b[f]; });
  if (out.inv_number != null) out.inv_number = parseInt(out.inv_number, 10);
  if (out.category_id != null) out.category_id = parseInt(out.category_id, 10);
  if (out.acquisition_id != null) out.acquisition_id = parseInt(out.acquisition_id, 10);
  out.price = b.price ? parseFloat(b.price) : 0;
  out.status = b.status || 'наличен';
  out.register_date = b.register_date || today();
  return out;
}

ipcMain.handle('books:list', (e, query) =>
  run(() => {
    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      return db.prepare(`${BOOK_SELECT}
        WHERE b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ? OR b.barcode LIKE ? OR CAST(b.inv_number AS TEXT) LIKE ?
        ORDER BY b.title`).all(q, q, q, q, q);
    }
    return db.prepare(`${BOOK_SELECT} ORDER BY b.title`).all();
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
      const payload = bookPayload(b);
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
        db.prepare('UPDATE books SET status = ?, deaccession_act_id = ?, deaccession_date = ? WHERE id = ?')
          .run('отчислен', actId, act.date, b.id);
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
          db.prepare(`UPDATE books SET status='наличен', deaccession_act_id=NULL, deaccession_date=NULL WHERE id=?`)
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
  're_registered_at', 'status', 'gdpr_consent', 'parent_consent', 'note'];
function readerPayload(r) {
  const out = {};
  READER_FIELDS.forEach(f => { out[f] = r[f] === undefined || r[f] === '' ? null : r[f]; });
  out.gdpr_consent = r.gdpr_consent ? 1 : 0;
  out.parent_consent = r.parent_consent ? 1 : 0;
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
    const payload = readerPayload(r);
    db.prepare(`UPDATE readers SET ${READER_FIELDS.map(f => f + '=@' + f).join(',')} WHERE id=@id`)
      .run(Object.assign({ id: r.id }, payload));
    logAudit('Редакция на читател', 'карта ' + (r.card_no || '') + ' — ' + r.name);
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
      const info = db.prepare(`
        INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)
      `).run(reader_id, book_id, date_out, date_due || null);
      const b = db.prepare('SELECT title, inv_number FROM books WHERE id = ?').get(book_id);
      logAudit('Заемане', 'инв. № ' + (b ? b.inv_number : '') + ' — ' + (b ? b.title : ''));
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
    writeCatalogIfConfigured();
  })
);
ipcMain.handle('loans:extend', (e, { id, days }) =>
  run(() => {
    const l = db.prepare('SELECT date_due FROM loans WHERE id = ?').get(id);
    const base = l && l.date_due ? l.date_due : today();
    const next = new Date(base);
    next.setDate(next.getDate() + (days || 30));
    const newDue = next.toISOString().slice(0, 10);
    db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(newDue, id);
    logAudit('Продължение на заемане', 'заемане № ' + id + ' до ' + newDue);
    return newDue;
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
      const out = date_out || today();
      const due = new Date(out); due.setDate(due.getDate() + (s.loan_days || 30));
      const dueStr = due.toISOString().slice(0, 10);
      const info = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(reader_id, b.id, out, dueStr);
      logAudit('Заемане', 'инв. № ' + b.inv_number + ' — ' + b.title);
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
    writeCatalogIfConfigured();
    return { title: b.title, inv_number: b.inv_number, reader_name: loan.reader_name, daysLate, fine };
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
    return {
      fundCount: fund.n, fundValue: fund.v, activeReaders, loansOpen, overdueCount, overdueRows,
      year: y, acquiredYear, deaccessionedYear, loansYear, readersYear,
      inventoryTarget: target, inventoryScannedYear: scannedYear, inventoryPct: pct,
      upcoming
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
    if (b.status === 'липсващ') db.prepare("UPDATE books SET status='наличен' WHERE id=?").run(b.id);
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
        if (b.status !== 'отчислен') db.prepare("UPDATE books SET status='липсващ' WHERE id=?").run(b.id);
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

/* ---------------- Просрочени: вижте loans:overdue по-горе ---------------- */

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
function publicBookFields(b) {
  return {
    inv: b.inv_number, a: b.author || '', t: b.title || '', s: b.subtitle || '',
    c: b.city || '', p: b.publisher || '', y: b.year || '', v: b.category_name || '',
    l: b.language || '', u: b.udk || '', g: b.call_number || '', o: b.department || '',
    k: b.keywords || '', n: b.annotation || '', cv: b.cover_url || '', av: b.available > 0 ? 1 : 0
  };
}
function buildCatalogPayload() {
  const books = db.prepare(`${BOOK_SELECT} WHERE b.status != 'отчислен' AND b.department != 'служебен' ORDER BY b.title`).all();
  const s = db.prepare('SELECT lib_name, place FROM settings WHERE id = 1').get() || {};
  return {
    library: s.lib_name || '', place: s.place || '',
    generated: new Date().toISOString().slice(0, 10),
    items: books.map(publicBookFields)
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
