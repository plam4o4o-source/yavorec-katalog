// Тест на handlers/settings.js — трийсет и трети домейн, извадено от
// main.js (Фаза 4, стъпка 33). Покрива settings:get/update/updateNotices/
// updateLabelFormat/chooseLogo/clearLogo/updateTheme. settings:noticeDefaults
// умишлено остава в main.js (виж коментара в handlers/settings.js) и не се
// тества тук.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerSettingsHandlers = require('../handlers/settings');


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

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

// better-sqlite3 изисква всички именувани параметри на UPDATE-а да присъстват
// в подадения обект дори когато е null — settings:update ползва @named стил.
function fullSettingsPayload(overrides = {}) {
  return Object.assign({
    org: 'НЧ', lib_name: 'Читалище X', place: 'Село Y', bulstat: '123', reg_no: '456',
    director: 'Иван', director_role: 'Председател', librarian: 'Мария', cat_url: '',
    loan_days: 30, max_books: 5, extensions_count: 2, extension_days: 30,
    fine_per_day: 0.05, annual_fee: 0, free_access_pct: 60,
    next_inv_number: 1, committee1: null, committee2: null, committee3: null,
    sru_endpoint: null, suspend_per_day: 0, suspend_max: 90,
    remind2_days: 14, remind3_days: 30, anonymize_years: 0
  }, overrides);
}

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-settings-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const savedDialogs = { openDialog: null };
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    dialog: {
      showOpenDialog: async () => savedDialogs.openDialog || { canceled: true, filePaths: [] }
    },
    getMainWindow: () => ({}),
    fs, path
  };
  const returned = registerSettingsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, dir, savedDialogs, returned };
}

test('registerSettingsHandlers registers the 7 settings: channels it owns, and returns LOGO_MIME/LOCAL_PHOTO_MAX_BYTES', () => {
  const { ipcMain, returned } = setup();
  ['settings:get', 'settings:update', 'settings:updateNotices', 'settings:updateLabelFormat',
   'settings:chooseLogo', 'settings:clearLogo', 'settings:updateTheme']
    .forEach(ch => assert.ok(ipcMain.has(ch), ch));
  assert.equal(ipcMain.has('settings:noticeDefaults'), false); // stays in main.js
  assert.deepEqual(returned.LOGO_MIME['.png'], 'image/png');
  assert.equal(returned.LOCAL_PHOTO_MAX_BYTES, 1024 * 1024);
});

test('settings:get returns the single settings row (id=1, seeded by schema.sql)', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('settings:get');
  assert.equal(result.ok, true);
  assert.equal(result.data.id, 1);
});

test('settings:update writes all fields and logs the audit entry', async () => {
  const { db, ipcMain, auditLog } = setup();
  const result = await ipcMain.invoke('settings:update', fullSettingsPayload({ lib_name: 'Ново име', max_books: 7 }));
  assert.equal(result.ok, true);
  const row = db.prepare('SELECT lib_name, max_books FROM settings WHERE id=1').get();
  assert.equal(row.lib_name, 'Ново име');
  assert.equal(row.max_books, 7);
  assert.ok(auditLog.some(a => a.action === 'Редакция на настройки'));
});

test('settings:updateNotices writes the reminder templates, treating empty as "use default" (null)', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('settings:updateNotices', { notice_subject: 'Тема', notice_body: '', notice_sms: 'SMS текст' });
  const row = db.prepare('SELECT notice_subject, notice_body, notice_sms FROM settings WHERE id=1').get();
  assert.equal(row.notice_subject, 'Тема');
  assert.equal(row.notice_body, null);
  assert.equal(row.notice_sms, 'SMS текст');
});

test('settings:updateLabelFormat clamps out-of-range values to their bounds and defaults an invalid lbl_mode to "sheet"', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('settings:updateLabelFormat', { lbl_mode: 'bogus', lbl_w: 999, lbl_h: 1, lbl_cols: 20 });
  const row = db.prepare('SELECT lbl_mode, lbl_w, lbl_h, lbl_cols FROM settings WHERE id=1').get();
  assert.equal(row.lbl_mode, 'sheet');
  assert.equal(row.lbl_w, 210); // clamped to max
  assert.equal(row.lbl_h, 8);   // clamped to min
  assert.equal(row.lbl_cols, 8); // clamped to max
});

test('settings:updateLabelFormat accepts "roll" mode and falls back to defaults for non-numeric input', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('settings:updateLabelFormat', { lbl_mode: 'roll', lbl_w: 'not-a-number' });
  const row = db.prepare('SELECT lbl_mode, lbl_w FROM settings WHERE id=1').get();
  assert.equal(row.lbl_mode, 'roll');
  assert.equal(row.lbl_w, 40); // default fallback
});

test('settings:chooseLogo reports cancellation, rejects an unsupported extension, and stores a data URI on success', async () => {
  const { db, ipcMain, savedDialogs, dir, auditLog } = setup();
  const cancelled = await ipcMain.invoke('settings:chooseLogo');
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /Отказано/);

  const txtPath = path.join(dir, 'logo.txt');
  fs.writeFileSync(txtPath, 'not an image');
  savedDialogs.openDialog = { canceled: false, filePaths: [txtPath] };
  const badExt = await ipcMain.invoke('settings:chooseLogo');
  assert.equal(badExt.ok, false);
  assert.match(badExt.error, /Неподдържан формат/);

  const pngPath = path.join(dir, 'logo.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  savedDialogs.openDialog = { canceled: false, filePaths: [pngPath] };
  const ok = await ipcMain.invoke('settings:chooseLogo');
  assert.equal(ok.ok, true);
  assert.match(ok.data, /^data:image\/png;base64,/);
  const row = db.prepare('SELECT logo FROM settings WHERE id=1').get();
  assert.equal(row.logo, ok.data);
  assert.ok(auditLog.some(a => /зададено лого/.test(a.detail)));
});

test('settings:chooseLogo rejects a file over the 512 KB limit', async () => {
  const { ipcMain, savedDialogs, dir } = setup();
  const bigPath = path.join(dir, 'big.png');
  fs.writeFileSync(bigPath, Buffer.alloc(600 * 1024));
  savedDialogs.openDialog = { canceled: false, filePaths: [bigPath] };
  const result = await ipcMain.invoke('settings:chooseLogo');
  assert.equal(result.ok, false);
  assert.match(result.error, /512 KB/);
});

test('settings:clearLogo nulls the logo column and logs the audit entry', async () => {
  const { db, ipcMain, auditLog } = setup();
  db.prepare("UPDATE settings SET logo = 'data:image/png;base64,AAAA' WHERE id=1").run();
  const result = await ipcMain.invoke('settings:clearLogo');
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT logo FROM settings WHERE id=1').get().logo, null);
  assert.ok(auditLog.some(a => /премахнато лого/.test(a.detail)));
});

test('settings:updateTheme stores the theme as a string', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('settings:updateTheme', 2);
  assert.equal(db.prepare('SELECT theme FROM settings WHERE id=1').get().theme, '2');
});
