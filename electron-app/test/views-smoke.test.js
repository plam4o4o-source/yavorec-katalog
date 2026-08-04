'use strict';
// Smoke test за разбиването на бившия src/app.js (5441 реда) в src/views/*.js
// (по един файл на раздел от интерфейса + core.js/navigation.js/bootstrap.js
// инфраструктура, вижте docs/ARCHITECTURE.md). app.js/views нямаше НИКАКВО
// тестово покритие преди това — този файл е "safety net"-ът, изграден ПРЕДИ
// самото разбиване, за да хване регресии от неправилен ред на <script>
// таговете (hoisting/TDZ хазарти, специфични за browser script tags, вижте
// обяснителния коментар в началото на src/views/bootstrap.js).
//
// Зарежда всеки src/views/*.js файл в ТОЧНО реда от src/index.html, в реален
// jsdom DOM (изграден от истинския index.html+style.css), с фалшив
// window.api (Proxy, който връща {ok:true, data:[]} за произволен път —
// целта тук не е да проверява конкретни данни, а че всеки изглед се
// рендира БЕЗ да хвърли изключение при route() към всеки раздел от NAV).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');

// Точно същият ред като <script> таговете в src/index.html (без udk.js —
// зарежда се отделно по-долу, преди всичко останало).
const SCRIPT_ORDER = [
  'core.js', 'navigation.js', 'employee-badge.js', 'auto-update.js',
  'dashboard.js', 'categories.js', 'books.js', 'notices.js', 'authorities.js',
  'inv-book.js', 'kdbf.js', 'acquisitions.js', 'deaccession-acts.js',
  'readers.js', 'account.js', 'suggestions.js', 'loans.js', 'housebound.js',
  'holds.js', 'overdue.js', 'inventory-sessions.js', 'periodicals.js',
  'mzs.js', 'dnevnik.js', 'stats.js', 'reports.js', 'catalog.js',
  'barcode-labels.js', 'logo-org.js', 'audit.js', 'settings.js',
  'analytics.js', 'persons.js', 'chronicle.js', 'links.js', 'av.js',
  'data-import.js', 'mobile.js', 'bootstrap.js'
];

// Проверка, че index.html наистина зарежда точно този списък, в този ред —
// ако някой добави/премахне/размести файл в index.html без да обнови теста
// (или обратно), тестът гърми ясно, вместо тихо да пропусне разлика.
function scriptOrderFromIndexHtml() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const re = /<script src="views\/([^"]+)"><\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

// window.api.<domain>.<method>(...) винаги връща {ok:true/false, data}
// (конвенцията run(fn) от главния процес). За целите на този smoke тест НЕ ни
// интересуват конкретните данни — целта е да хванем регресии от самото
// разбиване на файлове (грешен ред, липсващ идентификатор), не да проверяваме
// бизнес логика. С над 150 различни api.<домейн>.<метод>() извиквания из
// всичките view-файлове, ръчно моделиране на всяка форма данни би било
// непропорционално усилие за smoke тест — затова "safe default": обект,
// който при ВСЯКО обръщение към несъществуващо свойство връща себе си
// отново (верижно, за произволна дълбочина: r.today.reregDue работи), се
// държи като празен масив (.length===0, .map/.forEach/.filter → [], for..of
// → нищо), и при опит да бъде преобразуван в число/низ (шаблонен низ,
// toLocaleString, аритметика) дава 0 / ''. Това стига render-функциите да
// изпълнят реалния си код (условия, map по списъци, вложени полета) без
// хвърляне на изключение — именно това искаме да хванем тук, не точните
// показани числа. Изрични изключения в OBJECT_OVERRIDES по-долу — само
// където нещо специфично наистина е нужно (засега няма).
const OBJECT_OVERRIDES = {};

function safeDefault() {
  const handler = {
    get(target, prop) {
      if (prop === 'then') return undefined; // да не се третира като thenable
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
  };
  return new Proxy({}, handler);
}

function apiMock() {
  function makeNode(pathParts) {
    const pathStr = pathParts.join('.');
    const handler = {
      get(target, prop) {
        if (prop === 'then') return undefined; // да не се третира като thenable
        if (typeof prop === 'symbol') return undefined;
        return makeNode(pathParts.concat(prop));
      },
      apply() {
        const data = Object.prototype.hasOwnProperty.call(OBJECT_OVERRIDES, pathStr)
          ? OBJECT_OVERRIDES[pathStr] : safeDefault();
        return Promise.resolve({ ok: true, data });
      }
    };
    return new Proxy(function () {}, handler);
  }
  return makeNode([]);
}

// ВАЖНО: използваме истински <script> елементи, вмъкнати в документа (с
// runScripts:"dangerously"), а НЕ window.eval(). window.eval() изпълнява
// кода в собствен, временен "eval scope" — декларациите с let/const там НЕ
// се качват в споделения глобален лексикален обхват и изчезват веднага след
// самия eval() извикване. Истинските <script> тагове (класически, не
// модули) обаче ползват СПОДЕЛЕН глобален лексикален обхват за let/const
// между отделните тагове — точно както в реален браузър и точно както
// разчита цялото разбиване на app.js на src/views/*.js файлове. Проверено
// експериментално с jsdom: `let x=1` в един <script>, четено от следващ
// <script>, работи. window.eval() би дал невярно "not defined" тук, въпреки
// че истинската страница работи коректно.
// jsdom НЕ хвърля изключение от appendChild(), когато вмъкнат <script> гръмне
// по време на изпълнение (точно като реален браузър — грешката отива в
// конзолата/window.onerror, не се връща на кода, извикал appendChild).
// Затова следим грешките през VirtualConsole ("jsdomError" събитие) вместо
// try/catch около самото зареждане.
function buildDom() {
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
  window.api = apiMock();
  window.confirm = () => true;
  // Точно както в Electron: window.prompt() НЕ се поддържа и хвърля. Мокът
  // трябва да е верен на средата — по-рано тук стоеше () => null и това
  // скриваше дефекта, който правеше „Витрини в каталога“ неизползваеми.
  window.prompt = () => { throw new Error('prompt() is not supported.'); };
  window.alert = () => {};
  // index.html вече съдържа <script src="udk.js"> и <script src="views/...">
  // тагове, но jsdom няма да ги зареди сам (не правим мрежова/файлова
  // резолюция тук) — изтриваме ги и ги заместваме с вмъкнати <script>
  // елементи с textContent, в същия ред, за пълен контрол върху товара.
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const udkSrc = fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8');
  runScript(window, udkSrc, 'udk.js');
  return dom;
}

function runScript(window, src, label) {
  const el = window.document.createElement('script');
  el.textContent = `//# sourceURL=${label}\n` + src;
  window.document.body.appendChild(el);
}

function loadViews(dom, files) {
  for (const f of files) {
    const src = fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8');
    runScript(dom.window, src, `views/${f}`);
  }
}

function assertNoErrors(dom, context) {
  if (dom.jsErrors.length) {
    const msg = dom.jsErrors.map(e => e.stack || e.message || String(e)).join('\n---\n');
    assert.fail(`${context}: заловени ${dom.jsErrors.length} грешки в jsdom конзолата:\n${msg}`);
  }
}

test('src/index.html зарежда точно очаквания списък view-файлове, в очаквания ред', () => {
  assert.deepEqual(scriptOrderFromIndexHtml(), SCRIPT_ORDER);
});

test('всички src/views/*.js файлове се зареждат без грешка, в реда от index.html', () => {
  const dom = buildDom();
  loadViews(dom, SCRIPT_ORDER);
  assertNoErrors(dom, 'зареждане на views/*.js');
});

test('bootstrap.js трябва да е последният файл в списъка (RENDERERS/route/hashchange зависят от това)', () => {
  assert.equal(SCRIPT_ORDER[SCRIPT_ORDER.length - 1], 'bootstrap.js');
});

test('всеки раздел от NAV се рендира през route() без грешка и с непразно съдържание', async () => {
  const dom = buildDom();
  loadViews(dom, SCRIPT_ORDER);
  assertNoErrors(dom, 'първоначално зареждане');
  const { window } = dom;

  // Изчакваме bootstrap.js-ия loadSettingsCache().then(...) microtask да
  // приключи (той сам вика route() за първоначалния изглед).
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  assertNoErrors(dom, 'първоначален route() (bootstrap)');

  // window.TITLES не е достъпно оттук: top-level const/let в класически
  // <script> НЕ стават свойства на window (за разлика от var/function) —
  // те живеят в споделения "script scope" лексикален обхват, четим само от
  // друг код вътре в скриптовете, не отвън през window.*. Затова вземаме
  // истинския списък раздели от вече изрендирания <nav> (drawNav() пълни
  // #nav с <a href="#key">) — черна кутия, точно каквото би видял browser-ът.
  const navKeys = Array.from(window.document.querySelectorAll('#nav a[href]'))
    .map(a => a.getAttribute('href').replace(/^#/, ''));
  assert.ok(navKeys.length >= 20, `очакват се поне 20 раздела в #nav, намерени ${navKeys.length}`);

  for (const key of navKeys) {
    window.location.hash = '#' + key;
    // route() се вика от hashchange listener-а, регистриран в bootstrap.js;
    // jsdom изпраща hashchange синхронно при промяна на location.hash, но
    // самата route() е async — изчакваме microtask/macrotask опашката.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    assertNoErrors(dom, `route() към "${key}"`);
    const view = window.document.getElementById('view');
    assert.ok(view, `#view липсва в DOM след рутиране към ${key}`);
    assert.ok(
      view.innerHTML.trim().length > 0,
      `раздел "${key}" се рендира с празно съдържание — вероятна грешка, прихваната тихо`
    );
  }
});
