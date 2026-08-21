/* Работник за тестове с ДВА РЕАЛНИ ОС процеса, свързани към ЕДИН И СЪЩ файл с база
   данни — симулира два компютъра в читалището, пишещи едновременно по мрежов дял.

   Двоен режим:
   - require()-нат директно (в главния тестов процес) — за ЗАСЯВАНЕ на общата база
     преди состезанието: boot(dbFolder) + invokeHandler(channel,args) + closeApp().
   - пуснат чрез child_process.fork() — говори по IPC протокол (виж по-долу),
     използва се от test/two-process-locking.test.js за самото надпреварване.

   Протокол по IPC (process.send / process.on('message')), само във fork-нат режим:
     родителят -> {cmd:'init', dbFolder}         еднократно, преди 'ready'
     работникът -> {evt:'ready'}                 щом main.js е зареден
     родителят -> {cmd:'invoke', channel, args}   изпълни канал точно сега
     работникът -> {evt:'result', ok, data|error, tookMs}
     родителят -> {cmd:'exit'}                    затвори чисто и излез
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ELECTRON_ID = require.resolve('electron');
const UPDATER_ID = require.resolve('electron-updater');
const MAIN_ID = require.resolve('../../main.js');

function stubModule(id, exports) {
  const m = new Module(id, null);
  m.filename = id;
  m.loaded = true;
  m.exports = exports;
  require.cache[id] = m;
}

let handlers = null;
let appEvents = null;
let bootDir = null;

function boot(dbFolder) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-2proc-'));
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  // config.json сочи към СПОДЕЛЕНАТА папка — точно както при мрежов диск.
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ dbFolder }), 'utf8');
  bootDir = dir;

  handlers = new Map();
  appEvents = new Map();
  const fakeWebContents = { setWindowOpenHandler: () => {}, on: () => {}, send: () => {} };
  class FakeBrowserWindow {
    constructor(opts) { this.opts = opts; this.webContents = fakeWebContents; }
    setMenuBarVisibility() {}
    loadFile() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    restore() {}
    focus() {}
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
    whenReady: () => Promise.resolve(),
    on: (ev, fn) => { if (!appEvents.has(ev)) appEvents.set(ev, []); appEvents.get(ev).push(fn); },
    exit: (code) => { throw new Error('app.exit(' + code + ') в 2-процесен тест'); },
    quit: () => {}
  };
  const ipcMain = {
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error('Двойна регистрация на IPC канал: ' + channel);
      handlers.set(channel, fn);
    }
  };
  const dialog = {
    showMessageBoxSync: () => 1,
    showErrorBox: () => {},
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  };
  const shell = { openExternal: async () => {}, openPath: async () => {} };
  const net = { request: () => { throw new Error('мрежата е изключена в тестовата среда'); } };

  stubModule(ELECTRON_ID, { app, BrowserWindow: FakeBrowserWindow, ipcMain, dialog, net, shell });
  stubModule(UPDATER_ID, {
    autoUpdater: { autoDownload: false, autoInstallOnAppQuit: false, on: () => {}, checkForUpdates: async () => ({}), quitAndInstall: () => {} }
  });
  delete require.cache[MAIN_ID];
  require(MAIN_ID);
  // app.whenReady().then(initDb + регистрация на ~200 канала) е АСИНХРОННО —
  // изчакваме опашката от микротаски да се изпразни, преди да върнем управлението
  // (същия модел като test/helpers/main-app.js).
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(() => setImmediate(resolve)));
  });
}

function invokeHandler(channel, args) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error('няма регистриран IPC канал ' + channel);
  return fn({}, args);
}

function closeApp() {
  for (const fn of (appEvents.get('window-all-closed') || [])) {
    try { fn(); } catch (e) { /* при спиране няма какво да поправяме */ }
  }
  try { fs.rmSync(bootDir, { recursive: true, force: true }); } catch (e) { /* пак така */ }
}

if (require.main === module) {
  process.on('message', async (msg) => {
    try {
      if (msg.cmd === 'init') {
        await boot(msg.dbFolder);
        process.send({ evt: 'ready' });
      } else if (msg.cmd === 'invoke') {
        const t0 = process.hrtime.bigint();
        try {
          const data = invokeHandler(msg.channel, msg.args);
          const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
          process.send({ evt: 'result', ok: true, data, tookMs });
        } catch (err) {
          const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
          process.send({ evt: 'result', ok: false, error: String(err && err.message || err), tookMs });
        }
      } else if (msg.cmd === 'exit') {
        try { closeApp(); } catch (e) { /* игнорира се — процесът и без друго спира */ }
        process.exit(0);
      }
    } catch (err) {
      process.send({ evt: 'fatal', error: String(err && err.stack || err) });
    }
  });
}

module.exports = { boot, invokeHandler, closeApp };
