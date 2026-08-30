// Тест на handlers/security-exclusions.js — трийсет и осми домейн, извадено
// от main.js (Фаза 4, стъпка 36). Покрива security:exclusionInfo и
// security:writeExclusionScript.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerSecurityExclusionsHandlers = require('../handlers/security-exclusions');


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

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-security-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const savedDialogs = { saveDialog: null };
  const ipcMain = fakeIpcMain();
  const userDataDir = path.join(dir, 'userData');
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    dialog: {
      showSaveDialog: async () => savedDialogs.saveDialog || { canceled: false, filePath: path.join(dir, 'out.bat') }
    },
    getMainWindow: () => ({}),
    fs, path,
    app: { getPath: () => userDataDir },
    resolveDbDir: () => path.join(dir, 'db-dir')
  };
  registerSecurityExclusionsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, dir, savedDialogs, userDataDir };
}

test('registerSecurityExclusionsHandlers registers both security: channels', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('security:exclusionInfo'));
  assert.ok(ipcMain.has('security:writeExclusionScript'));
});

test('security:exclusionInfo lists the program/userData/db-dir folders plus the exe path', async () => {
  const { db, ipcMain, userDataDir } = setup();
  const result = await ipcMain.invoke('security:exclusionInfo');
  assert.equal(result.ok, true);
  assert.equal(result.data.exe, process.execPath);
  assert.ok(result.data.dirs.includes(userDataDir));
  assert.ok(result.data.dirs.includes(path.dirname(process.execPath)));
});

test('security:exclusionInfo also includes the connected catalog_folder when set', async () => {
  const { db, ipcMain, dir } = setup();
  const catalogDir = path.join(dir, 'catalog-repo');
  db.prepare('UPDATE settings SET catalog_folder = ? WHERE id=1').run(catalogDir);
  const result = await ipcMain.invoke('security:exclusionInfo');
  assert.ok(result.data.dirs.includes(catalogDir));
});

test('security:writeExclusionScript reports cancellation from the save dialog', async () => {
  const { ipcMain, savedDialogs } = setup();
  savedDialogs.saveDialog = { canceled: true, filePath: null };
  const result = await ipcMain.invoke('security:writeExclusionScript');
  assert.equal(result.ok, false);
  assert.match(result.error, /Отказано/);
});

test('security:writeExclusionScript writes a pure-ASCII .bat with an admin check and PowerShell Add-MpPreference lines, and logs audit', async () => {
  const { ipcMain, dir, auditLog } = setup();
  const outPath = path.join(dir, 'exclusions.bat');
  const result = await ipcMain.invoke('security:writeExclusionScript');
  assert.equal(result.ok, true);
  const content = fs.readFileSync(result.data, 'utf8');
  assert.match(content, /^@echo off/);
  assert.match(content, /net session/);
  /* v2.4.14, след повторния одит: командите вече НЕ се вграждат в cmd. Целият
     полезен товар е PowerShell скрипт в base64 (-EncodedCommand), защото при
     вграждане стойност от базата (catalog_folder) можеше да смени смисъла на
     команда, а опитът да се затвори това с кодировка 'ascii' беше по-лош от
     проблема: маскирането до 7 бита превръща „К“ в байт 0x1A (край на batch
     файл) и „Ц“ в `&`. Съдържанието се проверява в декодирания вид. */
  const m = content.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
  assert.ok(m, 'полезният товар трябва да е кодиран');
  const ps = Buffer.from(m[1], 'base64').toString('utf16le');
  assert.match(ps, /Add-MpPreference -ExclusionPath/);
  assert.match(ps, /Add-MpPreference -ExclusionProcess/);
  assert.match(ps, /Add-MpPreference -ControlledFolderAccessAllowedApplications/);
  /* Одит v2.4.14: тестът се казваше „pure-ASCII“, а проверяваше единствено
     наличието на реда `chcp 65001` — тоест минаваше при файл, пълен с кирилица.
     Скилът за този проект documentira, че точно тази комбинация вече веднъж е
     дала нацепен изход на този компютър, а веднъж и парчета от коментар,
     изпълнени като команди; работещото решение беше целият файл да мине на чист
     ASCII. Сега проверката е байтова. */
  const bytes = fs.readFileSync(result.data);
  const nonAscii = [...bytes].filter(b => b > 127);
  assert.equal(nonAscii.length, 0, 'скриптът трябва да е чист ASCII, а има ' + nonAscii.length + ' байта над 127');
  assert.ok(!/chcp/.test(content), 'при чист ASCII смяната на кодовата страница е излишна');
  // Резултатът се обобщава честно — „Готово“ вече не се печата безусловно.
  assert.match(ps, /ВНИМАНИЕ: добавени/);
  assert.match(ps, /if \(\$fail -eq 0\)/);
  assert.ok(auditLog.some(a => a.action === 'Антивирусна защита'));
});

test('psQuote escaping: a catalog folder path containing a single quote does not break the generated PowerShell command', async () => {
  const { db, ipcMain, dir } = setup();
  const weirdDir = path.join(dir, "o'brien-repo");
  db.prepare('UPDATE settings SET catalog_folder = ? WHERE id=1').run(weirdDir);
  const result = await ipcMain.invoke('security:writeExclusionScript');
  assert.equal(result.ok, true);
  // Единичната кавичка се удвоява — единственото екраниране, което остава
  // след като пътищата спряха да минават през cmd (виж бележката по-горе).
  const content = fs.readFileSync(result.data, 'latin1');
  const ps = Buffer.from(content.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf16le');
  assert.ok(ps.includes("o''brien-repo"), 'валидно PowerShell екраниране на апострофа');
});
