// Тест на handlers/backup.js — първият домейн, извадено от main.js (Фаза 4,
// стъпка 1). Тъй като main.js е Electron main процес и не може да се
// require-не директно тук, тестваме извадения модул изолирано: подаваме
// фалшив ipcMain (който само пази регистрираните callback-и в Map), реална
// временна SQLite база и фалшиви app/dialog, после викаме регистрираните
// handler-и директно.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerBackupHandlers = require('../handlers/backup');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-backup-test-'));
  const dbPath = path.join(dir, 'library.db');
  let db = new Database(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('оригинал');

  const relaunchCalls = [];
  const exitCalls = [];
  const app = {
    getPath: (name) => (name === 'temp' ? os.tmpdir() : dir),
    relaunch: () => relaunchCalls.push(true),
    exit: (code) => exitCalls.push(code)
  };
  const dialog = {
    showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, 'manual-backup.db') }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(dir, 'manual-backup.db')] })
  };

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    app, dialog, fs, path,
    getDb: () => db,
    setDb: (v) => { db = v; },
    getMainWindow: () => ({ id: 'fake-window' }),
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    resolveDbDir: () => dir,
    resolveDbPath: () => dbPath
  };
  const handlers = registerBackupHandlers(ipcMain, deps);
  return { dir, dbPath, ipcMain, deps, handlers, auditLog, relaunchCalls, exitCalls, getDb: () => deps.getDb() };
}

test('registerBackupHandlers registers all four backup: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['backup:list', 'backup:now', 'backup:restoreFromList', 'backup:restoreBrowse']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('autoBackupIfNeeded creates an auto-<today>.db file and does not throw', () => {
  const { dir, handlers } = setup();
  handlers.autoBackupIfNeeded();
  const today = new Date().toISOString().slice(0, 10);
  const expected = path.join(dir, 'backups', `auto-${today}.db`);
  assert.ok(fs.existsSync(expected), 'expected auto backup file to be created');
});

test('autoBackupIfNeeded is a no-op (does not overwrite) if today\'s auto backup already exists', () => {
  const { dir, handlers } = setup();
  handlers.autoBackupIfNeeded();
  const today = new Date().toISOString().slice(0, 10);
  const expected = path.join(dir, 'backups', `auto-${today}.db`);
  const firstMtime = fs.statSync(expected).mtimeMs;
  handlers.autoBackupIfNeeded();
  const secondMtime = fs.statSync(expected).mtimeMs;
  assert.equal(firstMtime, secondMtime, 'second call should not rewrite the same-day auto backup');
});

test('backup:list returns entries with correct name/encrypted/auto metadata', async () => {
  const { ipcMain, handlers } = setup();
  handlers.autoBackupIfNeeded();
  const result = await ipcMain.invoke('backup:list');
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length >= 1);
  const entry = result.data[0];
  assert.equal(entry.auto, true);
  assert.equal(entry.encrypted, false);
});

test('backup:now writes an unencrypted copy of the live db and logs an audit entry', async () => {
  const { ipcMain, dir, auditLog } = setup();
  const result = await ipcMain.invoke('backup:now', {});
  assert.equal(result.ok, true);
  assert.equal(result.encrypted, false);
  assert.ok(fs.existsSync(path.join(dir, 'manual-backup.db')));
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /ръчно копие/);
});

test('backup:now with a password produces an encrypted (INVBAK01) backup', async () => {
  const { ipcMain, dir } = setup();
  const result = await ipcMain.invoke('backup:now', { password: 'таен-парол-123' });
  assert.equal(result.ok, true);
  assert.equal(result.encrypted, true);
  const head = fs.readFileSync(result.data).subarray(0, 8).toString('utf8');
  assert.equal(head, 'INVBAK01');
});

test('backup:restoreFromList replaces the active db file and relaunches the app', async () => {
  const { ipcMain, dir, dbPath, relaunchCalls, exitCalls, getDb } = setup();
  // Направи различима "резервна" база данни, различна от текущата.
  const backupPath = path.join(dir, 'to-restore.db');
  const bdb = new Database(backupPath);
  bdb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  bdb.prepare('INSERT INTO t (v) VALUES (?)').run('от-резервно-копие');
  bdb.close();

  const result = await ipcMain.invoke('backup:restoreFromList', { path: backupPath, password: undefined });
  assert.equal(result.ok, true);
  assert.equal(result.data.needsPassword, false);
  // performRestore трябва да е затворил старата db (setDb(null)) и презаписал файла.
  assert.equal(getDb(), null);
  assert.equal(relaunchCalls.length, 1);
  assert.equal(exitCalls.length, 1);
  assert.equal(exitCalls[0], 0);
  const restored = new Database(dbPath);
  assert.equal(restored.prepare('SELECT v FROM t').get().v, 'от-резервно-копие');
  restored.close();
});

test('backup:restoreFromList on an encrypted backup without a password reports needsPassword', async () => {
  const { ipcMain, dir } = setup();
  const { encryptBackupFile } = require('../backup-crypto');
  const plainSrc = path.join(dir, 'plain-for-enc.db');
  const pdb = new Database(plainSrc);
  pdb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  pdb.close();
  const encPath = path.join(dir, 'enc-backup.invbak');
  encryptBackupFile(plainSrc, encPath, 'парола1');

  const result = await ipcMain.invoke('backup:restoreFromList', { path: encPath, password: undefined });
  assert.equal(result.ok, true);
  assert.equal(result.data.needsPassword, true);
  assert.equal(result.data.path, encPath);
});

test('backup:restoreFromList reports a friendly error for a missing file instead of throwing', async () => {
  const { ipcMain, dir } = setup();
  const result = await ipcMain.invoke('backup:restoreFromList', { path: path.join(dir, 'nope.db'), password: undefined });
  assert.equal(result.ok, false);
  assert.match(result.error, /не е намерен/);
});
