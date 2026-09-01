'use strict';
/* Дъщерен процес за пазача НАПРЕД по версия на схемата (одит v2.4.18).
   =====================================================================
   ЗАЩО ОТДЕЛЕН ПРОЦЕС: проверява се какво прави програмата при СТАРТИРАНЕ —
   тоест целият път app.whenReady() → initDb() → runMigrations() → .catch() →
   диалог → app.exit(). Общият двойник (helpers/main-app.js) не става за това:
   там app.exit() ХВЪРЛЯ (за да улови неочакван изход), а тук изходът е самото
   очаквано поведение; освен това main.js се зарежда веднъж на процес и базата
   трябва да е засята ПРЕДИ зареждането.

   Извиква се с: node newer-schema-worker.js <user_version>
   Отпечатва един ред JSON: { exitCode, dialogs, sumAfter, versionAfter,
   consentAfter, journalAfter, untouched, sidecarsAfter }.

   Всичко след `dialogs` се чете ОТНОВО след опита за стартиране и доказва
   най-важното: при отказ базата не е докосната. `untouched` сравнява контролната
   сума на целия файл и наличието на -wal/-shm до него, а `consentAfter` и
   `journalAfter` назовават поименно двете места, където по-ранен вариант на
   пазача остави следа. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const Database = require('better-sqlite3');

const APP_DIR = path.join(__dirname, '..', '..');
const ELECTRON_ID = require.resolve('electron');
const UPDATER_ID = require.resolve('electron-updater');
const MAIN_ID = require.resolve(path.join(APP_DIR, 'main.js'));

/* `node --test` събира ВСИЧКИ файлове под test/, включително двойниците тук, и
   пуска всеки от тях като тестов файл. Без този изход целият старт на програмата
   щеше да се изпълнява по веднъж на всяко пускане на пакета — с временна папка,
   четиритесекундния предпазен таймер по-долу и ред JSON в изхода, без нищо да го
   чете. Без аргумент файлът не прави нищо (същото поведение като на другите
   двойници в тази папка). */
const wantVersion = parseInt(process.argv[2], 10);
if (!Number.isFinite(wantVersion)) return;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-newer-db-'));
const userData = path.join(dir, 'userData');
fs.mkdirSync(userData, { recursive: true });
const dbPath = path.join(userData, 'library.db');

/* Напълно ЗДРАВА база: истинската схема, плюс версия на схемата, каквато подадем.
   Два засадени реда, всеки — мярка за нещо различно:
     • партида със `sum = 0` — стойността, чийто смисъл миграция 11 обръща
       (празно поле → обявена нула);
     • читател с отбелязано съгласие БЕЗ дата — точно редът, който пренаписва един
       от СТАРИТЕ backfill-и в initDb(), много преди миграциите. Той показва дали
       отказът идва преди писането (одит v2.4.19). */
{
  const seed = new Database(dbPath);
  seed.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  seed.prepare("INSERT INTO acquisitions (no, year, date, sum, total_count) VALUES (1, '2026', '2026-02-02', 0, 1)").run();
  seed.prepare("INSERT INTO readers (name, registered_at, gdpr_consent) VALUES ('Читател', '2020-01-01', 1)").run();
  seed.pragma('user_version = ' + wantVersion);
  seed.close();
}
const hashOf = () => (fs.existsSync(dbPath)
  ? crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')
  : null);
const sidecarsOf = () => fs.readdirSync(userData).filter(f => f.startsWith('library.db-')).sort();
const hashBefore = hashOf();
const sidecarsBefore = sidecarsOf();

const dialogs = [];
let finished = false;
function finish(exitCode) {
  if (finished) return;
  finished = true;
  let sumAfter = null, versionAfter = null, consentAfter = null, journalAfter = null;
  const hashAfter = hashOf();
  const sidecarsAfter = sidecarsOf();
  try {
    const chk = new Database(dbPath, { readonly: true });
    const row = chk.prepare('SELECT sum FROM acquisitions WHERE no = 1').get();
    sumAfter = row ? row.sum : null;
    versionAfter = chk.pragma('user_version', { simple: true });
    consentAfter = chk.prepare('SELECT gdpr_consent_date AS d FROM readers WHERE id = 1').get().d;
    journalAfter = chk.pragma('journal_mode', { simple: true });
    chk.close();
  } catch (e) { /* докладваме каквото имаме */ }
  process.stdout.write(JSON.stringify({
    exitCode, dialogs, sumAfter, versionAfter, consentAfter, journalAfter,
    untouched: hashBefore === hashAfter && sidecarsBefore.length === sidecarsAfter.length,
    sidecarsAfter
  }) + '\n');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* няма значение */ }
  process.exit(0);
}

function stubModule(id, exports) {
  const m = new Module(id, null);
  m.filename = id;
  m.loaded = true;
  m.exports = exports;
  require.cache[id] = m;
}

let readyResolve;
const readyPromise = new Promise((res) => { readyResolve = res; });
class FakeBrowserWindow {
  constructor(opts) { this.opts = opts; this.webContents = { setWindowOpenHandler: () => {}, on: () => {}, send: () => {} }; }
  setMenuBarVisibility() {} loadFile() {} isDestroyed() { return false; }
  isMinimized() { return false; } restore() {} focus() {}
  maximize() {} show() {} once() {}
  static getAllWindows() { return []; }
}
const app = {
  isPackaged: true,
  getPath: (name) => {
    const p = name === 'userData' ? userData : path.join(dir, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  },
  getVersion: () => '0.0.0-test',
  isReady: () => true,
  requestSingleInstanceLock: () => true,
  whenReady: () => readyPromise,
  on: () => {},
  exit: (code) => finish(code),
  quit: () => finish(0)
};
stubModule(ELECTRON_ID, {
  app, BrowserWindow: FakeBrowserWindow,
  ipcMain: { handle: () => {} },
  dialog: {
    showMessageBoxSync: () => 1,
    showErrorBox: (title, content) => dialogs.push({ title, content }),
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  },
  net: { request: () => { throw new Error('мрежата е изключена'); } },
  shell: { openExternal: async () => {}, openPath: async () => {} }
});
stubModule(UPDATER_ID, {
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: false,
    on: () => {}, checkForUpdates: async () => ({}), quitAndInstall: () => {}
  }
});

require(MAIN_ID);
readyResolve();
/* Ако програмата НЕ спре сама (контролният пуск с позната версия), стартирането
   е минало — докладваме успех, вместо да висим. */
setTimeout(() => finish(0), 4000);
