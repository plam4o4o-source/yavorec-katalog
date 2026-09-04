'use strict';
/* End-to-end харнес: ИСТИНСКИЯТ renderer (src/index.html + src/views/*.js в jsdom)
   срещу ИСТИНСКИТЕ IPC handler-и (handlers/*.js, регистрирани от самия main.js)
   върху прясна SQLite база. Без api-мокове.
   =====================================================================
   Как е сглобен:
     • main.js се зарежда през test/helpers/main-app.js (Electron е заместен със
       стъбове; app.getPath('userData') сочи временна папка; app.whenReady()
       изпълнява initDb() + миграциите, тоест регистрацията на ~200 канала е
       същата, която библиотекарят получава).
     • preload.js се ПАРСВА и от него се строи таблицата window.api.a.b → канал.
       Нищо не се гадае: несъществуващ метод хвърля веднага с името си.
     • Аргументите и резултатите минават през structuredClone(), както прави
       самият IPC мост на Electron (DOM възел или функция в аргумент би паднал
       и в истинската програма).
     • toast()/confirm()/print()/диалозите за файл се улавят, за да може тестът
       да твърди какво е видял библиотекарят. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { JSDOM, VirtualConsole } = require('jsdom');
const { startMainApp } = require('./main-app');

const APP_DIR = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(APP_DIR, 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');

/* ---------- preload.js → таблица { ns: { method: { channel } | { kind } } } ---------- */
function preloadTable() {
  const src = fs.readFileSync(path.join(APP_DIR, 'preload.js'), 'utf8');
  const start = src.indexOf("contextBridge.exposeInMainWorld('api', {");
  assert.ok(start > -1, 'preload.js: не е намерен exposeInMainWorld(\'api\')');
  const table = {};
  let ns = null;
  for (const raw of src.slice(start).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trimEnd();
    let m;
    if ((m = /^  (\w+): \{$/.exec(line))) { ns = m[1]; table[ns] = {}; continue; }
    if (/^  \},?$/.test(line)) { ns = null; continue; }
    if (!ns) continue;
    if ((m = /^\s+(\w+): invoke\('([^']+)'\)/.exec(line))) { table[ns][m[1]] = { channel: m[2] }; continue; }
    if ((m = /^\s+(\w+): \(cb\) => ipcRenderer\.on\('([^']+)'/.exec(line))) { table[ns][m[1]] = { kind: 'listener', event: m[2] }; continue; }
    if ((m = /^\s+(\w+): \(file\) => filePath\(file\)/.exec(line))) { table[ns][m[1]] = { kind: 'pathOf' }; continue; }
    if (/^\s+\w+:/.test(line)) throw new Error('preload.js: неразпознат ред в таблицата на api — ' + line.trim());
  }
  // Няколко контролни точки — ако форматът на preload.js се промени, да гръмне тук, не в тест.
  assert.equal(table.loans.checkoutByCode.channel, 'loans:checkoutByCode');
  assert.equal(table.backup.now.channel, 'backup:now');
  assert.equal(table.app.onUpdateStatus.kind, 'listener');
  assert.equal(table.importData.pathOf.kind, 'pathOf');
  return table;
}

/* IPC-подобно копие: същите ограничения като structured clone на Electron. */
function ipcClone(v) {
  if (v === undefined) return undefined;
  return structuredClone(v);
}

function makeApi(app, table, stats) {
  const api = {};
  for (const [ns, methods] of Object.entries(table)) {
    const obj = {};
    for (const [name, spec] of Object.entries(methods)) {
      if (spec.channel) {
        obj[name] = (...args) => {
          stats.inflight++;
          const rec = { channel: spec.channel, args };
          stats.calls.push(rec);
          return Promise.resolve()
            .then(() => app.invoke(spec.channel, ...args.map(ipcClone)))
            .then(res => { rec.result = res; return ipcClone(res); })
            .finally(() => { stats.inflight--; stats.last = Date.now(); });
        };
      } else if (spec.kind === 'listener') {
        obj[name] = (cb) => { (stats.listeners[spec.event] = stats.listeners[spec.event] || []).push(cb); };
      } else {
        obj[name] = (file) => (file && file.path) || '';
      }
    }
    api[ns] = new Proxy(obj, {
      get(t, p) {
        if (typeof p === 'symbol' || p === 'then' || p in t) return t[p];
        throw new Error('window.api.' + ns + '.' + String(p) + ' не е изложен в preload.js');
      }
    });
  }
  return new Proxy(api, {
    get(t, p) {
      if (typeof p === 'symbol' || p === 'then' || p in t) return t[p];
      throw new Error('window.api.' + String(p) + ' не е изложен в preload.js');
    }
  });
}

function scriptOrder() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Едно зареждане на приложение за процес (main-app.js е еднократен). */
let booted = null;
async function bootApp() {
  if (booted) return booted;
  const app = startMainApp();
  await app.ready();

  /* Electron стъбовете са споделени по референция с handler-ите — методите им
     могат да се подменят оттук, за да отговарят на „файловите“ диалози. */
  const electron = require('electron');
  const dialogs = { savePath: null, openPaths: null, calls: [] };
  electron.dialog.showSaveDialog = async (win, opts) => {
    dialogs.calls.push({ kind: 'save', opts });
    if (dialogs.savePath === false) return { canceled: true };
    return { canceled: false, filePath: dialogs.savePath || (opts && opts.defaultPath) };
  };
  electron.dialog.showOpenDialog = async (win, opts) => {
    dialogs.calls.push({ kind: 'open', opts });
    if (!dialogs.openPaths) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: dialogs.openPaths };
  };

  const dbPath = path.join(app.userData, 'library.db');
  assert.ok(fs.existsSync(dbPath), 'main.js не е създал library.db в ' + app.userData);
  const db = new Database(dbPath); // втора връзка само за твърдения (WAL — чете committed)

  const stats = { inflight: 0, last: Date.now(), calls: [], listeners: {} };
  const table = preloadTable();
  const api = makeApi(app, table, stats);

  /* ---- jsdom ---- */
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  virtualConsole.on('error', (...a) => consoleErrors.push(a.map(String).join(' ')));
  /* Необработените отхвърляния от екранния слой се СЪБИРАТ, не спират теста по
     средата: node --test иначе прекъсва текущия тест при първото такова, а
     main.js (който също слуша) само го изписва в конзолата. Тестът ги проверява
     изрично в края си (noRendererErrors) и може да отдели познат дефект от нов.
     Предишните слушатели се връщат при stop(). */
  // Грешката идва от realm-а на jsdom (не е instanceof Error на Node) — пази се както е.
  const onRejection = (reason) => errors.push(reason && typeof reason === 'object' && 'message' in reason ? reason : new Error(String(reason)));
  const priorRejectionListeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', onRejection);
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  const hooks = { confirmAnswer: true, confirms: [], alerts: [], prints: 0 };
  window.api = api;
  window.confirm = (msg) => { hooks.confirms.push(String(msg)); return hooks.confirmAnswer; };
  window.alert = (msg) => hooks.alerts.push(String(msg));
  window.print = () => { hooks.prints++; };
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const run = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  run(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  for (const f of scriptOrder()) run(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'), `views/${f}`);
  if (errors.length) assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n---\n'));

  /* toast() е глобална function declaration в core.js → свойство на window;
     всички изгледи я викат като свободен идентификатор, тоест през window. */
  const toasts = [];
  const origToast = window.toast;
  window.toast = function (msg, type) { toasts.push({ msg: String(msg ?? ''), type: type || '' }); return origToast.call(this, msg, type); };

  const $ = (sel) => window.document.querySelector(sel);
  /* Видимият текст, както го чете човек: между съседни елементи има поне интервал
     (textContent слепва „Неотчислени“ и „12.50 лв.“ от два съседни <div>). */
  const textOf = (node) => {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1 && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE') out += ' ' + textOf(c) + ' ';
    }
    return out;
  };
  const text = (sel) => {
    const el = typeof sel === 'string' ? $(sel) : sel;
    return el ? textOf(el).replace(/\s+/g, ' ').trim() : '';
  };
  async function waitFor(fn, what, timeout) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > (timeout || 4000)) throw new Error('waitFor: ' + (what || fn.toString()) + ' не настъпи за ' + (timeout || 4000) + ' ms');
      await sleep(10);
    }
  }
  /* Изчаква да няма IPC заявки в полет и да е било тихо поне quietMs — така
     веригите await api → DOM се довършват, независимо колко обиколки имат. */
  async function settle(quietMs) {
    const q = quietMs == null ? 60 : quietMs;
    const t0 = Date.now();
    for (;;) {
      await sleep(10);
      if (stats.inflight === 0 && Date.now() - stats.last >= q) return;
      if (Date.now() - t0 > 8000) throw new Error('settle: IPC заявките не спряха за 8 s (inflight=' + stats.inflight + ')');
    }
  }
  const view = () => window.eval('VIEW');
  async function go(v) {
    if (window.location.hash === '#' + v) await window.route();
    else window.location.hash = '#' + v;
    await waitFor(() => view() === v, 'route → ' + v);
    await settle();
  }
  function el(sel) {
    const e = typeof sel === 'string' ? $(sel) : sel;
    if (!e) throw new Error('Няма елемент ' + sel);
    return e;
  }
  async function click(sel, opts) {
    el(sel).click();
    if (!(opts && opts.noSettle)) await settle(opts && opts.quiet);
  }
  /* Бутон по видимия му надпис (частично съвпадение), в даден контейнер. */
  function button(label, root) {
    const scope = root ? el(root) : window.document;
    const all = Array.from(scope.querySelectorAll('button'));
    // Първо точното съвпадение („Запиши“ ≠ „Запиши и нов“), после по съдържание.
    const norm = (x) => x.textContent.replace(/\s+/g, ' ').trim();
    const b = all.find(x => norm(x) === label) || all.find(x => norm(x).includes(label));
    if (!b) throw new Error('Няма бутон „' + label + '“' + (root ? ' в ' + root : ''));
    return b;
  }
  async function clickButton(label, root, opts) { return click(button(label, root), opts); }
  function fire(e, type, init) { e.dispatchEvent(new window.Event(type, Object.assign({ bubbles: true }, init || {}))); }
  /* Попълва поле както го прави човек: стойност + input + change. */
  function type(sel, value) {
    const e = el(sel);
    if (e.type === 'checkbox' || e.type === 'radio') { e.checked = !!value; fire(e, 'change'); return e; }
    e.value = String(value);
    fire(e, 'input'); fire(e, 'change');
    return e;
  }
  /* Баркод четец: пише кода и праща Enter. */
  async function scan(sel, code, opts) {
    const e = el(sel);
    e.value = String(code);
    fire(e, 'input');
    e.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle(opts && opts.quiet);
  }
  const lastToast = () => toasts[toasts.length - 1];
  const toastsSince = (n) => toasts.slice(n);
  const printed = () => text('#ppSheet');

  booted = {
    app, db, dbPath, window, document: window.document, api, table, stats, dialogs, hooks,
    errors, consoleErrors, toasts, lastToast, toastsSince, printed,
    $, text, waitFor, settle, sleep, go, view, click, button, clickButton, type, scan, fire, el,
    modal: () => text('#modal'), modal2: () => text('#modal2'), viewText: () => text('#view'),
    modalOpen: () => $('#veil').classList.contains('on') && !$('#veil').classList.contains('closing'),
    stop: () => {
      process.off('unhandledRejection', onRejection);
      for (const fn of priorRejectionListeners) process.on('unhandledRejection', fn);
      try { db.close(); } catch (e) { /* няма значение */ }
      try { window.close(); } catch (e) { /* пак така */ }
      app.stop();
    }
  };
  return booted;
}

/* ---------- Календарна аритметика — огледало на handlers/calendar.js, но от
   ВТОРАТА връзка към базата, за да може тестът да сметне очакваното сам. ---------- */
function workDaysSet(db) {
  const s = db.prepare('SELECT work_days FROM settings WHERE id = 1').get() || {};
  const raw = s.work_days == null ? '0,1,2,3,4,5,6' : s.work_days;
  const set = new Set(String(raw).split(',').map(x => parseInt(x, 10)).filter(n => !isNaN(n)));
  return set.size ? set : new Set([0, 1, 2, 3, 4, 5, 6]);
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nextWorkDay(db, dateStr) {
  const wd = workDaysSet(db);
  let ds = dateStr;
  for (let i = 0; i < 400; i++) {
    const closed = db.prepare('SELECT 1 FROM calendar_closed WHERE date = ?').get(ds);
    if (wd.has(new Date(ds + 'T00:00:00Z').getUTCDay()) && !closed) return ds;
    ds = addDays(ds, 1);
  }
  return dateStr;
}
function closedDaysBetween(db, a, b) {
  if (!a || !b || a >= b) return 0;
  const wd = workDaysSet(db);
  const closed = new Set(db.prepare('SELECT date FROM calendar_closed WHERE date > ? AND date <= ?').all(a, b).map(r => r.date));
  let n = 0;
  for (let ds = addDays(a, 1); ds <= b; ds = addDays(ds, 1)) {
    if (!wd.has(new Date(ds + 'T00:00:00Z').getUTCDay()) || closed.has(ds)) n++;
  }
  return n;
}
function effectiveDaysLate(db, dueDate, inDate) {
  if (!dueDate || !inDate || inDate <= dueDate) return 0;
  const raw = Math.max(0, Math.round((new Date(inDate) - new Date(dueDate)) / 864e5));
  return Math.max(0, raw - closedDaysBetween(db, dueDate, inDate));
}
const today = () => new Date().toISOString().slice(0, 10);
const bgDate = (d) => d ? d.split('-').reverse().join('.') : '';
const mny = (n) => (Number(n) || 0).toFixed(2) + ' лв. / ' + ((Number(n) || 0) / 1.95583).toFixed(2) + ' €';

module.exports = {
  bootApp, preloadTable, addDays, nextWorkDay, closedDaysBetween, effectiveDaysLate, today, bgDate, mny, sleep
};
