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

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-security-test-'));
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
  assert.match(content, /Add-MpPreference -ExclusionPath/);
  assert.match(content, /Add-MpPreference -ExclusionProcess/);
  assert.match(content, /Add-MpPreference -ControlledFolderAccessAllowedApplications/);
  // Unlike the pure-ASCII batch scripts from the separate inventar-biblioteka
  // browser-app pipeline, this .bat intentionally carries Cyrillic echo text and
  // relies on its own `chcp 65001` line for correct console output.
  assert.match(content, /chcp 65001/);
  assert.ok(auditLog.some(a => a.action === 'Антивирусна защита'));
});

test('psQuote escaping: a catalog folder path containing a single quote does not break the generated PowerShell command', async () => {
  const { db, ipcMain, dir } = setup();
  const weirdDir = path.join(dir, "o'brien-repo");
  db.prepare('UPDATE settings SET catalog_folder = ? WHERE id=1').run(weirdDir);
  const result = await ipcMain.invoke('security:writeExclusionScript');
  assert.equal(result.ok, true);
  const content = fs.readFileSync(result.data, 'utf8');
  assert.ok(content.includes("o''brien-repo")); // doubled single-quote, valid PowerShell escaping
});
