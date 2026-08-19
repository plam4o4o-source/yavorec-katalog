// Тест на handlers/db-location.js — осми домейн, извадено от main.js (Фаза
// 4, стъпка 9). Същия DI модел като backup.js: db/mainWindow като getter/
// setter, app.relaunch()/app.exit(0) — процесът приключва веднага след
// записа в config.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerDbLocationHandlers = require('../handlers/db-location');


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

function setup(opts = {}) {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-dbloc-test-'));
  const dbFolder = path.join(dir, 'defaultdb');
  fs.mkdirSync(dbFolder, { recursive: true });
  const dbPath = path.join(dbFolder, 'library.db');
  let db = new Database(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');

  let config = opts.initialConfig ? { ...opts.initialConfig } : {};
  const relaunchCalls = [];
  const exitCalls = [];
  const app = {
    isPackaged: false,
    relaunch: () => relaunchCalls.push(true),
    exit: (code) => exitCalls.push(code)
  };
  const dialog = {
    showOpenDialog: opts.showOpenDialog || (async () => ({ canceled: true, filePaths: [] })),
    showMessageBox: opts.showMessageBox || (async () => ({ response: 0 }))
  };

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
    readConfig: () => config,
    writeConfig: (cfg) => { config = cfg; },
    resolveDbDir: () => (config.dbFolder && fs.existsSync(config.dbFolder)) ? config.dbFolder : dbFolder,
    resolveDbPath: () => path.join((config.dbFolder && fs.existsSync(config.dbFolder)) ? config.dbFolder : dbFolder, 'library.db')
  };
  registerDbLocationHandlers(ipcMain, deps);
  return { dir, dbFolder, dbPath, ipcMain, relaunchCalls, exitCalls, getConfig: () => config, getDb: () => deps.getDb() };
}

test('registerDbLocationHandlers registers all three dbLocation: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['dbLocation:get', 'dbLocation:choose', 'dbLocation:resetDefault']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('dbLocation:get reports the default folder and isDefault=true when no custom folder is configured', async () => {
  const { ipcMain, dbFolder } = setup();
  const result = await ipcMain.invoke('dbLocation:get');
  assert.equal(result.ok, true);
  assert.equal(result.data.folder, dbFolder);
  assert.equal(result.data.isDefault, true);
  assert.equal(result.data.isPackaged, false);
});

test('dbLocation:get reports isDefault=false when a custom dbFolder is already configured', async () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-dbloc-custom-'));
  const { ipcMain } = setup({ initialConfig: { dbFolder: dir } });
  const result = await ipcMain.invoke('dbLocation:get');
  assert.equal(result.data.isDefault, false);
  assert.equal(result.data.folder, dir);
});

test('dbLocation:choose reports a friendly error when the user cancels the dialog', async () => {
  const { ipcMain } = setup({ showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
  const result = await ipcMain.invoke('dbLocation:choose');
  assert.equal(result.ok, false);
  assert.match(result.error, /Отказано/);
});

test('dbLocation:choose rejects choosing the same folder the database is already in', async () => {
  const { ipcMain, dbFolder } = setup({ showOpenDialog: async () => ({ canceled: false, filePaths: [dbFolder] }) });
  const result = await ipcMain.invoke('dbLocation:choose');
  assert.equal(result.ok, false);
  assert.match(result.error, /текущата папка/);
});

test('dbLocation:choose copies the db to a new empty folder, writes config, closes db, and relaunches', async () => {
  const newDir = mkTmpDir(path.join(os.tmpdir(), 'inv-dbloc-newdir-'));
  const { ipcMain, relaunchCalls, exitCalls, getConfig, getDb } = setup({
    showOpenDialog: async () => ({ canceled: false, filePaths: [newDir] })
  });
  const result = await ipcMain.invoke('dbLocation:choose');
  assert.equal(result.ok, true);
  assert.equal(result.data, newDir);
  assert.ok(fs.existsSync(path.join(newDir, 'library.db')), 'db should have been copied to the new folder');
  assert.equal(getConfig().dbFolder, newDir);
  assert.equal(relaunchCalls.length, 1);
  assert.equal(exitCalls.length, 1);
  // Забележка: за разлика от performRestore() в backup.js, dbLocation:choose
  // затваря db (db.close()) но НЕ вика setDb(null) — process.exit() веднага
  // след това прави разликата без практическо значение, но getDb() тук все
  // още връща обекта (вече затворен), не null.
  assert.notEqual(getDb(), null);
});

test('dbLocation:choose, when the target folder already has a library.db, asks the user and honors "use existing" (no overwrite)', async () => {
  const newDir = mkTmpDir(path.join(os.tmpdir(), 'inv-dbloc-existing-'));
  const existingDb = new Database(path.join(newDir, 'library.db'));
  existingDb.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY); INSERT INTO marker (id) VALUES (42)");
  existingDb.close();

  const { ipcMain } = setup({
    showOpenDialog: async () => ({ canceled: false, filePaths: [newDir] }),
    showMessageBox: async () => ({ response: 1 }) // "Ползвай съществуващата база"
  });
  const result = await ipcMain.invoke('dbLocation:choose');
  assert.equal(result.ok, true);
  const check = new Database(path.join(newDir, 'library.db'));
  const marker = check.prepare('SELECT id FROM marker').get();
  assert.equal(marker.id, 42, 'existing db content must survive untouched');
  check.close();
});

test('dbLocation:choose, when the user cancels the "folder already has a db" prompt, reports a friendly error', async () => {
  const newDir = mkTmpDir(path.join(os.tmpdir(), 'inv-dbloc-existing2-'));
  new Database(path.join(newDir, 'library.db')).close();
  const { ipcMain, getConfig } = setup({
    showOpenDialog: async () => ({ canceled: false, filePaths: [newDir] }),
    showMessageBox: async () => ({ response: 0 }) // "Отказ"
  });
  const result = await ipcMain.invoke('dbLocation:choose');
  assert.equal(result.ok, false);
  assert.match(result.error, /Отказано/);
  assert.equal(getConfig().dbFolder, undefined, 'config should not have been changed');
});

test('dbLocation:resetDefault clears the configured dbFolder and relaunches', async () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-dbloc-reset-'));
  const { ipcMain, relaunchCalls, exitCalls, getConfig } = setup({ initialConfig: { dbFolder: dir } });
  const result = await ipcMain.invoke('dbLocation:resetDefault');
  assert.equal(result.ok, true);
  assert.equal(getConfig().dbFolder, undefined);
  assert.equal(relaunchCalls.length, 1);
  assert.equal(exitCalls.length, 1);
});
