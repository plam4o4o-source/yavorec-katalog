'use strict';
/* Общи опори за тестовете от одитните кръгове.
   =====================================================================
   Изнесено тук в одит v2.4.20: catalogSetup() и обвръзката за защитата на лични
   данни се копираха дословно от кръг в кръг (fixes-audit-v2418 → v2419), а всяка
   промяна по зависимостите на handlers/catalog.js (например добавянето на
   scheduleCatalogWrite) трябваше да се прави в няколко леко различни копия —
   точно класът дефект „разминали се тестови двойници“, който тези кръгове вече
   срещнаха веднъж (два независими FakeBrowserWindow при v2.4.15).

   Файлът стои в test/helpers/ и `node --test` го брои като тривиален „тест“ —
   както другите двойници тук; без страничен ефект при пряко изпълнение. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const APP_DIR = path.join(__dirname, '..', '..');

const tmpDirs = [];
function mkTmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
/* Всеки тестов файл регистрира това в своя test.after() — node --test пуска всеки
   файл в отделен процес, така че списъкът не се дели между файлове. */
function cleanupTmpDirs() {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* няма значение */ } }
}
function fakeIpcMain() {
  const h = new Map();
  return { handle: (c, fn) => h.set(c, fn), invoke: (c, ...a) => h.get(c)({}, ...a), has: (c) => h.has(c) };
}
function freshDb(prefix) {
  const dir = mkTmpDir(prefix);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  return { db, dir };
}
const runDep = (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } };

/* Истинските handlers/books + handlers/catalog върху прясна база; exportTo(канал,
   име) изпълнява износ до файл във временната папка и връща съдържанието му. */
function catalogSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  db.prepare("UPDATE settings SET lib_name = 'НЧ Тест' WHERE id = 1").run();
  const stub = () => {};
  const { BOOK_SELECT } = require(path.join(APP_DIR, 'handlers', 'books'))(fakeIpcMain(), {
    getDb: () => db, run: runDep, logAudit: stub, today: () => '2026-08-04',
    ftsQuery: stub, cnSortKey: () => '', diffFields: () => [], scheduleCatalogWrite: stub
  });
  const ipcMain = fakeIpcMain();
  const ctx = { savePath: null };
  require(path.join(APP_DIR, 'handlers', 'catalog'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: stub,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: ctx.savePath }) },
    getMainWindow: () => ({}), fs, path,
    execFile: (cmd, args, opts, cb) => cb(null, '', ''),
    BOOK_SELECT, csvCell: require(path.join(APP_DIR, 'security-utils')).csvCell,
    flushCatalogWrite: () => ({ written: true }), buildCatalogPayload: () => ({ items: [] })
  });
  const exportTo = async (channel, name) => {
    ctx.savePath = path.join(dir, name);
    const res = await ipcMain.invoke(channel);
    assert.equal(res.ok, true, channel + ': ' + (res.error || ''));
    return fs.readFileSync(ctx.savePath, 'utf8');
  };
  return { db, exportTo };
}

/* Истинският handlers/pdp върху прясна база със зададена парола; връща и изведения
   верен ключ, за да могат тестовете да криптират „правилни“ стойности. */
function pdpSetup(prefix, password) {
  const { db } = freshDb(prefix);
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  const pii = require(path.join(APP_DIR, 'pii-crypto'));
  const ipcMain = fakeIpcMain();
  const ret = require(path.join(APP_DIR, 'handlers', 'pdp'))(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  const pass = password || 'редовна-парола-11';
  ipcMain.invoke('pdp:setup', pass);
  const key = pii.deriveKey(pass,
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
  return { db, ipcMain, ret, pii, key, password: pass };
}

module.exports = { APP_DIR, mkTmpDir, cleanupTmpDirs, fakeIpcMain, freshDb, runDep, catalogSetup, pdpSetup };

/* jsdom харнес — целият renderer (src/index.html + всички views) в jsdom, с
   api-заместител, който отговаря по канали. Същият модел, който кръговете
   v2.4.17 – v2.4.19 копираха локално. */
const { JSDOM, VirtualConsole } = require('jsdom');
const SRC_DIR = path.join(APP_DIR, 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');
function scriptOrder() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}
function apiMock(overrides, calls) {
  function node(parts) {
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return node(parts.concat(prop));
      },
      apply(t, self, args) {
        const key = parts.join('.');
        if (calls) (calls[key] = calls[key] || []).push(args[0]);
        const has = Object.prototype.hasOwnProperty.call(overrides, key);
        const v = has ? overrides[key] : null;
        const out = typeof v === 'function' ? v(args) : v;
        return Promise.resolve({ ok: true, data: out });
      }
    });
  }
  return node([]);
}
function buildDom(overrides) {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  dom.calls = {};
  window.api = apiMock(overrides || {}, dom.calls);
  window.confirm = () => true;
  window.alert = () => {};
  window.print = () => {};
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const run = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  run(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  for (const f of scriptOrder()) run(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'), `views/${f}`);
  if (errors.length) assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n---\n'));
  return dom;
}
const settle = () => new Promise(r => setTimeout(r, 40));
const printed = (w) => w.document.querySelector('#ppSheet').textContent.replace(/\s+/g, ' ');

module.exports.buildDom = buildDom;
module.exports.settle = settle;
module.exports.printed = printed;
