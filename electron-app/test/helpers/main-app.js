/* Контролирано зареждане на main.js в обикновен Node (без Electron).
   =====================================================================
   ЗАЩО СЪЩЕСТВУВА: до v2.3.0 main.js не се зареждаше от НИТО един тест.
   Вътре обаче живеят неща, чиято повреда е тиха и скъпа: изборът кои
   документи изобщо влизат в ПУБЛИЧНИЯ онлайн каталог, флагът „налична",
   предпазната мярка срещу презаписване на публикуван каталог с празен и
   нормативните формули по Наредба № 3 (pctRequired/naturalLoss).
   Мутационен одит показа, че всяка от тези четири повреди минава през
   цялата поредица незабелязано.

   ЗАЩО ИМЕННО ТАКА: разгледани бяха три възможности.
     1) Да се изнесат функциите в отделен модул — това е промяна на
        продукционен код, а задачата е втвърдяване на ТЕСТОВЕТЕ.
     2) Да се преписват формулите в теста — точно този клас дефект
        („дублирана продукционна константа") вече е причина за одита.
     3) Да се зареди истинският main.js със заглушен `electron` и да се
        тества през РЕАЛНО регистрираните IPC канали. Избрано.
   Трето решение дава най-много: изпълняват се истинската схема, истинските
   миграции, истинската регистрация на ~200 канала и истинските зависимости
   между модулите (реда на require(), TDZ капаните, споделените BOOK_SELECT/
   LOAN_SELECT). Тества се това, което наистина ще работи при библиотекаря.

   КАК: `electron` и `electron-updater` се подменят в require.cache ПРЕДИ
   require('../../main.js'). app.getPath('userData') сочи временна папка, а
   app.isPackaged = true, за да НЕ пише базата в repo-то (defaultDbDir()
   връща __dirname/db в режим на разработка). app.whenReady() резолва, с
   което main.js сам изпълнява initDb() + миграциите.

   ПОЧИСТВАНЕ: stop() вика регистрирания 'window-all-closed' обработчик —
   така се спира таймерът за автоматично публикуване (setInterval на 5 мин.,
   иначе процесът на node --test виси) и се изпразва отложеният запис на
   каталога. Временната папка се трие. */
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

/* Един процес = едно зареждане на main.js (require.cache). node --test пуска
   всеки тестов ФАЙЛ в отделен процес, затова това не пречи на изолацията. */
let started = null;

function startMainApp() {
  if (started) return started;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-main-app-'));
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData, { recursive: true });

  const handlers = new Map();          // канал → обработчик (ipcMain.handle)
  const sent = [];                     // webContents.send(channel, data)
  const appEvents = new Map();         // app.on(...)
  const windows = [];                  // всеки създаден FakeBrowserWindow
  const dialogCalls = [];
  const shellCalls = [];
  let readyResolve;
  const readyPromise = new Promise((res) => { readyResolve = res; });
  let isReady = false;

  const fakeWebContents = {
    setWindowOpenHandler: () => {},
    on: () => {},
    send: (channel, data) => sent.push({ channel, data })
  };
  /* maximize/show/once съществуват, защото createWindow() отваря прозореца
     максимизиран и скрит, а го показва на 'ready-to-show' (v2.4.15).
     Двойникът записва дали са извикани, за да може тест да провери реда:
     максимизиране ПРЕДИ показване. */
  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.webContents = fakeWebContents;
      this.calls = [];
      this.listeners = new Map();
      windows.push(this);
    }
    setMenuBarVisibility() {}
    loadFile() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    restore() {}
    focus() {}
    maximize() { this.calls.push('maximize'); }
    show() { this.calls.push('show'); }
    once(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, []);
      this.listeners.get(ev).push(fn);
    }
    emit(ev) { (this.listeners.get(ev) || []).forEach(fn => fn()); }
    static getAllWindows() { return []; }
  }

  const app = {
    isPackaged: true, // иначе базата отива в <repo>/db/library.db
    getPath: (name) => {
      const p = name === 'userData' ? userData : path.join(dir, name);
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
    getVersion: () => '0.0.0-test',
    isReady: () => isReady,
    requestSingleInstanceLock: () => true,
    whenReady: () => readyPromise,
    on: (ev, fn) => { (appEvents.get(ev) || appEvents.set(ev, []).get(ev)).push(fn); },
    exit: (code) => { throw new Error('app.exit(' + code + ') при зареждане на main.js в тест'); },
    quit: () => {}
  };
  // app.on с Map по-горе е трудно четимо — пренаписваме ясно:
  app.on = (ev, fn) => { if (!appEvents.has(ev)) appEvents.set(ev, []); appEvents.get(ev).push(fn); };

  const ipcMain = {
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error('Двойна регистрация на IPC канал: ' + channel);
      handlers.set(channel, fn);
    }
  };

  const dialog = {
    showMessageBoxSync: (opts) => { dialogCalls.push({ kind: 'messageBoxSync', opts }); return 1; },
    showErrorBox: (title, content) => dialogCalls.push({ kind: 'errorBox', title, content }),
    showSaveDialog: async (opts) => { dialogCalls.push({ kind: 'save', opts }); return { canceled: true }; },
    showOpenDialog: async (opts) => { dialogCalls.push({ kind: 'open', opts }); return { canceled: true, filePaths: [] }; }
  };
  const shell = {
    openExternal: async (url) => { shellCalls.push(url); },
    openPath: async (p) => { shellCalls.push(p); }
  };
  const net = { request: () => { throw new Error('мрежата е изключена в тестовата среда'); } };

  stubModule(ELECTRON_ID, { app, BrowserWindow: FakeBrowserWindow, ipcMain, dialog, net, shell });
  stubModule(UPDATER_ID, {
    autoUpdater: {
      autoDownload: false, autoInstallOnAppQuit: false,
      on: () => {}, checkForUpdates: async () => ({}), quitAndInstall: () => {}
    }
  });

  delete require.cache[MAIN_ID];
  require(MAIN_ID);

  started = {
    dir, userData, handlers, sent, dialogCalls, shellCalls, windows,
    /* Изпълнява канала точно както го вика renderer-ът през preload.js. */
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error('Няма регистриран IPC канал ' + channel);
      return fn({}, ...args);
    },
    has: (channel) => handlers.has(channel),
    channels: () => [...handlers.keys()],
    ready: async () => {
      isReady = true;
      readyResolve();
      // изчакваме .then(...) веригата на main.js (initDb + миграции) да мине
      await readyPromise;
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    stop: () => {
      // Ако ready() не е викан, базата не е отворена и 'window-all-closed'
      // (flushCatalogWrite → db.prepare) би гръмнал върху undefined.
      for (const fn of (isReady ? appEvents.get('window-all-closed') : null) || []) {
        try { fn(); } catch (e) { /* при спиране няма какво да поправяме */ }
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* пак така */ }
    }
  };
  return started;
}

module.exports = { startMainApp };
