'use strict';
/* Противников реодит (v2.4.0, порция "в") на находки #13 (page-katalog.html),
   #14/#16/#17 (core.js/stats.js) от bug-audit-v2.3.1.md — виж отчета в
   съответната задача. Тези тестове НЕ дублират test/fixes-v24-print-tests.test.js
   (той е проверен адверсариално чрез реална мутация — виж отчета — и
   действително пада срещу счупен ppClose()); те добавят покритие за
   гранични случаи, които предишният агент НЕ бе тествал пряко:

   #16 labelCount() — точната продукционна форма `class="lbl"` (без втора
       дума в класа), каквато реално произвежда lblCard(), плюс интеграционна
       проверка с истинските трите генератора на етикети конкатенирани заедно
       (какъвто е реалният път през printLabelSheet()).

   #17 finesCollected — други комбинации от плаваща грешка (0.29×3), плюс
       структурна проверка, че резултатът НЕ МОЖЕ да излезе отрицателен през
       нормалния UI път (account:charge/account:pay винаги привеждат сумата
       към положителна — виж handlers/account.js), включително при явно
       надплащане (аванс), което не бива да влияе на finesCollected. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const Database = require('better-sqlite3');
const registerStatsHandlers = require('../handlers/stats');
const registerAccountHandlers = require('../handlers/account');

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');

/* ===================== #16: истинският core.js в jsdom =====================
   Същият модел като fixes-v24-print-tests.test.js / fixes-print-perf.test.js. */
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

/* ---------- #16: labelCount() върху ТОЧНАТА продукционна форма ---------- */

test('labelCount(): продукционния изход на lblCard() (гол class="lbl", без втора дума) се брои коректно', async () => {
  const dom = buildDom({ 'settings.get': { org: 'НЧ „Васил Левски – 1922"', lbl_w: 40, lbl_h: 30 } });
  await settled(dom);
  const { window } = dom;
  const html3 = window.lblCard({ inv_number: 1, barcode: '1' }) +
    window.lblCard({ inv_number: 2, barcode: '2' }) +
    window.lblCard({ inv_number: 3, barcode: '3' });
  // Санитарна проверка: lblCard() наистина произвежда гол `class="lbl">`
  // (без интервал/втора дума), точно граничният случай от одита.
  assert.match(html3, /<div class="lbl">/);
  assert.equal(window.labelCount(html3), 3);
});

test('labelCount(): трите реални генератора (lblCard/sigLblCard/readerCardHtml), конкатенирани — какъвто е реалният път през printLabelSheet()', async () => {
  const dom = buildDom({ 'settings.get': {} });
  await settled(dom);
  const { window } = dom;
  const mixed =
    window.lblCard({ inv_number: 1, barcode: '1' }) +
    window.lblCard({ inv_number: 2, barcode: '2' }) +
    window.sigLblCard({ udk: '886.7', author_mark: 'В 42' }) +
    window.readerCardHtml({ id: 7, card_no: '7', name: 'Иван Иванов', category: 'възрастен' });
  assert.equal(window.labelCount(mixed), 4,
    'нито един от трите реални генератора не влага ВЪТРЕШЕН div с клас "lbl…" в друг такъв — броенето трябва да съвпадне с броя истински извиквания');
});

test('labelCount(): вложен decoy div с частично съвпадащ клас ВЪТРЕ в истински етикет не се брои двойно', async () => {
  const dom = buildDom({});
  await settled(dom);
  const { window } = dom;
  // Синтетичен, нарочно враждебен случай: label, съдържащ ВЪТРЕ друг div с
  // клас, започващ с "lbl", но не точно "lbl" (напр. хипотетично бъдещо
  // поле). Регексът е линеен (не е наясно с влагане/затваряне на тагове),
  // затова всяко ОТДЕЛНО съвпадение на `<div class="lbl "` / `<div class="lbl"`
  // се брои поотделно — тук е само ЕДНО истинско съвпадение, decoy класът
  // "lblxInner" не отговаря на границата на regex-а (lbl, следвано СРАЗУ от
  // интервал или кавичка) и не се брои.
  const nested = '<div class="lbl fund"><div class="lblxInner">не е етикет</div></div>';
  assert.equal(window.labelCount(nested), 1);
  // Ако вложеният div БЕШЕ истински "lbl "/"lbl"" клас, регексът (нарочно
  // линеен, не наясно с влагане) би го преброил ОТДЕЛНО — документирано тук
  // изрично, за да не изненада бъдещ агент, ако добави генератор с реално
  // влагане на етикети:
  const nestedReal = '<div class="lbl fund"><div class="lbl inner-real"></div></div>';
  assert.equal(window.labelCount(nestedReal), 2,
    'ако production код НЯКОГА вложи истински "lbl " клас в друг такъв, labelCount() ще го преброи два пъти — документирано ограничение, не бъг (текущите три генератора не влагат)');
});

/* ===================== #17: истинският handlers/stats.js (само тест) =====================
   Дублира модела от test/handlers-stats.test.js — файлът handlers/stats.js НЕ се пипа. */

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

function setupStatsAndAccount() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-stats-v24c-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  const statsDeps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    yearOf: () => '2026',
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: (rows) => ({ hours: rows.reduce((s, r) => s + (r.a_hours || 0), 0) })
  };
  registerStatsHandlers(ipcMain, statsDeps);
  const accountDeps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: () => {},
    today: () => '2026-02-01'
  };
  registerAccountHandlers(ipcMain, accountDeps);
  return { db, ipcMain };
}

test('stats:report finesCollected: друга комбинация от плаваща грешка (0.29+0.29+0.29 лв.)', async () => {
  const { db, ipcMain } = setupStatsAndAccount();
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател 0.29')").run().lastInsertRowid;
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-01', 'начисление', 'обезщетение', 1)").run(readerId);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-02-01', 'плащане', 'плащане', -0.29)").run(readerId);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-02-02', 'плащане', 'плащане', -0.29)").run(readerId);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-02-03', 'плащане', 'плащане', -0.29)").run(readerId);

  const result = await ipcMain.invoke('stats:report', '2026');
  assert.equal(result.ok, true);
  assert.equal(result.data.finesCollected, 0.87,
    'официалната справка не бива да показва суров плаващ низ като "0.8699999999999999 лв."');
  // Санитарна проверка: сценарият наистина произвежда позната плаваща грешка.
  assert.notEqual(0.29 + 0.29 + 0.29, 0.87, 'сценарият трябва да е познат случай на плаваща грешка');
});

test('stats:report finesCollected: НЕ може да излезе отрицателно дори при изрично надплащане (аванс)', async () => {
  /* Проверка на структурен инвариант: и account:charge, и account:pay
     привеждат сумата към Math.abs() ПРЕДИ да я запишат (виж handlers/account.js) —
     затова "връщане на надвнесена сума" не съществува като директен UI път.
     Тук се минава ИМЕННО през тези истински handler-и (не се пише директно в
     базата), за да остане проверката вярна и ако account.js по-късно се
     промени. Надплатеното над начисленото обезщетение остава "аванс" — извън
     finesCollected — а самото finesCollected никога не пада под 0. */
  const { db, ipcMain } = setupStatsAndAccount();
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател надплащане')").run().lastInsertRowid;

  var chg = await ipcMain.invoke('account:charge', { reader_id: readerId, type: 'обезщетение', amount: 1, date: '2026-01-01' });
  assert.equal(chg.ok, true);
  // Читателят плаща 5 лв. на гишето срещу начислен 1 лв. — явно надплащане.
  var pay = await ipcMain.invoke('account:pay', { reader_id: readerId, amount: 5, date: '2026-02-01' });
  assert.equal(pay.ok, true);

  const result = await ipcMain.invoke('stats:report', '2026');
  assert.equal(result.ok, true);
  assert.ok(result.data.finesCollected >= 0,
    'finesCollected не бива да е отрицателно дори при надплащане: ' + result.data.finesCollected);
  assert.equal(result.data.finesCollected, 1,
    'при надвнесена сума finesCollected спира точно до начисленото (1 лв.) — надвнесеното е аванс извън тази справка');

  // account:get потвърждава, че балансът пада под 0 (в полза на читателя,
  // 4 лв. аванс), без това да ѝ повлияе.
  const acc = await ipcMain.invoke('account:get', readerId);
  assert.equal(acc.ok, true);
  assert.equal(acc.data.balance, -4, 'балансът на читателя показва аванс от 4 лв. — сам по себе си коректен и незасягащ finesCollected');
});
