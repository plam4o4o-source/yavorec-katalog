'use strict';
/* Тестове v2.4.0 за три находки от bug-audit-v2.3.1.md — всичките "мутация
   оцеля срещу тестовия сюит" (слабо тествано поведение, а не непременно
   счупено поведение):

   #14 (core.js) — ppClose() ТРЯБВА да изчиства и самата PRINT_HTML низова
       променлива, не само DOM контейнерите (#printArea/#ppSheet). Досегашният
       тест ('ppClose() изчиства и #ppSheet, и #printArea' в
       fixes-print-perf.test.js) проверява само DOM-а — мутация, премахваща
       „PRINT_HTML = '';" вътре в ppClose(), оцелява, защото ppFreeDom()
       изпразва DOM контейнерите независимо от низа. Реалният риск е Ctrl+P
       (window beforeprint) СЛЕД затваряне на прегледа: предпазителят пълни
       #printArea от PRINT_HTML, ако низът все още не е празен — тоест отменен
       документ може да се препечата на съвсем друг, несвързан екран. Тестът
       по-долу затваря прегледа и после СИМУЛИРА точно този Ctrl+P (dispatch
       на 'beforeprint'), за да провери реалната стойност на променливата, а
       не само DOM-а. Проверено ръчно (виж отчета към задачата): мутация,
       премахваща реда „PRINT_HTML = '';" от ppClose(), кара този тест да
       пада (стария документ се появява в #printArea), а срещу истинския
       core.js (където редът вече съществува — v2.3.0) минава.

   #16 (core.js) — labelCount() е regex-базиран брояч, ползван от
       printLabelSheet() при готов HTML низ (диапазони, единична карта).
       Непокрит пряко — счупен regex (напр. винаги връщащ 0) би пропуснал
       тихо потвърждението за >500 етикета (LABEL_CONFIRM_OVER). Тества се
       директно за 0, 1, 500 (точно на прага), 501 (веднага над прага) и
       15000 (целия фонд) низа, плюс граничен случай — клас с común представка
       ("lblx"), който НЕ бива да се преброи.

   #17 (handlers/stats.js, само тест — файлът не се променя) — finesCollected
       (FIFO разпределение на плащания към начисления) вече закръгля резултата
       (Math.round(...*100)/100), но това закръгляне е непокрито пряко —
       официални справки биха показали суров плаващ низ като
       "2,9000000000000004 лв." вместо закръглено число. Сценарият по-долу е
       подбран точно да произведе класическа IEEE754 грешка: три плащания от
       0,10 + 0,20 + 2,60 лв. дават суров сбор 2.9000000000000004 в JavaScript
       (проверено), а закръгленият резултат трябва да е точно 2.9. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const Database = require('better-sqlite3');
const registerStatsHandlers = require('../handlers/stats');

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');

/* ===================== #14 и #16: истинският core.js в jsdom =====================
   Същият модел като test/fixes-print-perf.test.js (buildDom зарежда истинския
   index.html + всички src/views/*.js в ред, точно както в самото приложение) —
   дублиран тук нарочно, за да остане този файл самостоятелен и да не пипа чужди
   тестови файлове. */
function scriptOrderFromIndexHtml() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}

function safeDefault() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return (hint) => (hint === 'string' ? '' : 0);
      if (prop === 'length') return 0;
      if (['toString', 'toLocaleString', 'valueOf', 'toFixed', 'toUpperCase',
        'toLowerCase', 'trim', 'charAt', 'padStart', 'padEnd', 'repeat',
        'replace', 'replaceAll'].includes(prop)) return () => '';
      if (['map', 'filter', 'slice', 'sort', 'concat', 'split', 'match', 'flat', 'flatMap'].includes(prop)) return () => [];
      if (prop === 'forEach') return () => {};
      if (prop === 'join') return () => '';
      if (prop === 'reduce') return (fn, init) => init;
      if (['some', 'includes'].includes(prop)) return () => false;
      if (prop === 'every') return () => true;
      if (['find', 'indexOf', 'search'].includes(prop)) return () => (prop === 'indexOf' || prop === 'search' ? -1 : undefined);
      if (typeof prop === 'symbol') return undefined;
      return safeDefault();
    }
  });
}

function apiMock(overrides) {
  function makeNode(parts) {
    const key = parts.join('.');
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeNode(parts.concat(prop));
      },
      apply() {
        const data = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : safeDefault();
        return Promise.resolve({ ok: true, data });
      }
    });
  }
  return makeNode([]);
}

function buildDom(overrides) {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole
  });
  dom.jsErrors = errors;
  const { window } = dom;
  window.api = apiMock(overrides || {});
  window.confirm = () => true;
  window.prompt = () => { throw new Error('prompt() is not supported.'); };
  window.alert = () => {};
  window.print = () => {};
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const run = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  run(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  for (const f of scriptOrderFromIndexHtml()) {
    run(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'), `views/${f}`);
  }
  if (errors.length) {
    assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n---\n'));
  }
  return dom;
}

async function settled(dom) {
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
  return dom;
}

/* ---------- #14: PRINT_HTML се изчиства при затваряне, не само DOM-а ---------- */

test('ppClose() изчиства САМАТА PRINT_HTML — Ctrl+P след затваряне не препечатва отменен документ', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.setPrintPage({ name: 'Проба' });
  window.doPrint('<div class="pdoc"><h2>ОТМЕНЕН ДОКУМЕНТ</h2></div>');
  window.ppClose();
  // Дотук е проверено само DOM-а (виж fixes-print-perf.test.js). За да се
  // провери РЕАЛНАТА стойност на PRINT_HTML (лексикален `let`, недостъпен
  // директно през window), се симулира точно сценарият от одита: Ctrl+P на
  // несвързан екран СЛЕД затваряне на прегледа. beforeprint пълни #printArea
  // от PRINT_HTML само ако низът все още не е изчистен — затова резултатът
  // тук доказва състоянието на самата променлива, не само на DOM-а.
  window.dispatchEvent(new window.Event('beforeprint'));
  const area = window.document.getElementById('printArea');
  assert.equal(area.innerHTML, '',
    'PRINT_HTML трябва да е бил изчистен в ppClose() — иначе beforeprint го връща в #printArea');
  assert.ok(!/ОТМЕНЕН ДОКУМЕНТ/.test(area.innerHTML),
    'отмененият документ не бива да може да се препечата на друг екран');
  assert.equal(window.document.querySelectorAll('#toastsTop .toast').length, 1,
    'предпазителят трябва да предупреди, че няма подготвен документ за печат');
  assert.match(window.document.querySelector('#toastsTop .toast').textContent,
    /няма подготвен документ/);
});

test('ppPrint() също изчиства PRINT_HTML след самия печат (не само #printArea)', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.setPrintPage({ name: 'Проба' });
  window.doPrint('<div class="pdoc"><h2>ЩЕ СЕ ОТПЕЧАТА</h2></div>');
  window.ppPrint();
  // ppPrint() чака два кадъра и 150 ms преди window.print() — виж core.js.
  await new Promise(r => setTimeout(r, 400));
  window.dispatchEvent(new window.Event('beforeprint'));
  assert.equal(window.document.getElementById('printArea').innerHTML, '',
    'след действителния печат PRINT_HTML трябва да е празен — не само DOM контейнерите');
});

/* ---------- #16: labelCount() брои коректно за различни обеми ---------- */

function mkLabels(n, cls) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<div class="${cls || 'lbl fund'}" data-i="${i}"></div>`;
  return s;
}

test('labelCount(): 0 при празен/липсващ низ', async () => {
  const dom = buildDom({});
  await settled(dom);
  const { window } = dom;
  assert.equal(window.labelCount(''), 0);
  assert.equal(window.labelCount(null), 0);
  assert.equal(window.labelCount(undefined), 0);
  assert.equal(window.labelCount('<div class="other">без етикети</div>'), 0);
});

test('labelCount(): брои точно 1 етикет', async () => {
  const dom = buildDom({});
  await settled(dom);
  const { window } = dom;
  assert.equal(window.labelCount(mkLabels(1)), 1);
});

test('labelCount(): брои точно на прага (500) — LABEL_CONFIRM_OVER не бива да пропусне потвърждението', async () => {
  const dom = buildDom({});
  await settled(dom);
  const { window } = dom;
  assert.equal(window.labelCount(mkLabels(500)), 500);
});

test('labelCount(): брои точно 501 — веднага над прага', async () => {
  const dom = buildDom({});
  await settled(dom);
  const { window } = dom;
  assert.equal(window.labelCount(mkLabels(501)), 501);
});

test('labelCount(): брои коректно 15000 етикета (целия фонд)', async () => {
  const dom = buildDom({});
  await settled(dom);
  const { window } = dom;
  assert.equal(window.labelCount(mkLabels(15000)), 15000);
});

test('labelCount(): различните видове етикети (fund/sig/card) се смятат заедно, но чужд клас с "lbl" представка не се брои', async () => {
  const dom = buildDom({});
  await settled(dom);
  const { window } = dom;
  const mixed = mkLabels(3, 'lbl fund') + mkLabels(2, 'lbl sig') + mkLabels(1, 'lbl card');
  assert.equal(window.labelCount(mixed), 6, 'и трите вида етикети започват с <div class="lbl…" и трябва да се преброят');
  // Граница на regex-а: клас "lblx" не е "lbl" — не бива да се преброи (за
  // разлика от мутация, разхлабваща границата на съвпадението).
  const withDecoy = mixed + '<div class="lblxDecoy">не е етикет</div>';
  assert.equal(window.labelCount(withDecoy), 6, 'клас "lblxDecoy" не е истински етикет и не бива да се преброи');
});

/* ===================== #17: истинският handlers/stats.js (само тест) =====================
   Дублира модела от test/handlers-stats.test.js (fakeIpcMain + временна
   SQLite база от db/schema.sql) — файлът handlers/stats.js НЕ се пипа. */

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

function setupStats() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-stats-v24-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    yearOf: () => '2026',
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: (rows) => ({ hours: rows.reduce((s, r) => s + (r.a_hours || 0), 0) })
  };
  registerStatsHandlers(ipcMain, deps);
  return { db, ipcMain };
}

test('stats:report finesCollected е закръглено до 2 знака, не суров плаващ низ (0.10+0.20+2.60 лв.)', async () => {
  const { db, ipcMain } = setupStats();
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  // Едно начисление „обезщетение“ от 3 лв., покрито от три отделни плащания
  // през същата година — точно комбинацията, позната да дава IEEE754 грешка:
  // 0.1 + 0.2 + 2.6 = 2.9000000000000004 в чист JavaScript сбор.
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-01', 'начисление', 'обезщетение', 3)").run(readerId);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-02-01', 'плащане', 'плащане', -0.1)").run(readerId);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-02-02', 'плащане', 'плащане', -0.2)").run(readerId);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-02-03', 'плащане', 'плащане', -2.6)").run(readerId);

  const result = await ipcMain.invoke('stats:report', '2026');
  assert.equal(result.ok, true);
  // Строго равенство на числото 2.9 — без закръгляне резултатът би бил
  // 2.9000000000000004 и това сравнение би паднало.
  assert.equal(result.data.finesCollected, 2.9,
    'официалната справка не бива да показва суров плаващ низ като "2.9000000000000004 лв."');
  assert.equal(result.data.finesCollected.toFixed(2), '2.90');
  // Санитарна проверка, че сценарият изобщо произвежда IEEE754 грешка без
  // закръгляне — иначе тестът не би доказвал нищо специфично за #17.
  assert.notEqual(0.1 + 0.2 + 2.6, 2.9, 'сценарият трябва да е познат случай на плаваща грешка');
});
