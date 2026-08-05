'use strict';
/* Регресионни тестове v1.65.0 за три дефекта в изгледите (src/views/*.js), които не са
   хващаеми от smoke теста — той само рутира до всеки раздел и проверява за изключения,
   а тези се проявяват чак в парсера на браузъра или в реда на изпълнение.

   1) ВЛОЖЕНА <form>. Според алгоритъма за парсване на HTML фрагмент, <form> начален
      таг вътре в елемент, който вече е в друга <form>, е грешка и таговете просто се
      ИЗХВЪРЛЯТ (полетата остават, формата — не). loadPdpBox() вкарваше <form
      id="pdpUnlockF"> в #pdpBox, който стоеше вътре във <form id="stF">, заради което
      $('#pdpUnlockF') беше null и бутонът „Отключи" хвърляше TypeError. Ефект за
      библиотекаря: защитата на ЕГН/№ ЛК не можеше да бъде отключена НИКОГА — без
      никакво съобщение за грешка.

   2) ЕКРАНИРАНЕ НА АПОСТРОФ в onclick атрибути. esc() вече превръща ' в &#39;, затова
      всяко esc(x).replace(/'/g, …) след него беше мъртъв код; парсерът връща &#39; като
      истински апостроф точно преди тялото на handler-а да се компилира, което чупи
      низа със SyntaxError. Ефект: бутон до запис с апостроф в името („Жана д'Арк",
      витрина, категория, път на резервно копие) не прави нищо. Затова core.js вече
      има jsq() — екранира първо за JavaScript, чак после за HTML.

   3) НЕИЗЧАКАН async. savePayment() викаше accountModal() без await и веднага след
      това printReceiptLine(), която търси реда в window._ACC_LINES — списък, който
      accountModal тепърва щеше да презапише. Търсенето падаше в стария списък (отпреди
      плащането), не намираше нищо и функцията излизаше мълчаливо. Ефект: плащането се
      записва, но квитанция не се отпечатва никога. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');

function scriptOrderFromIndexHtml() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}

/* Мок на window.api с възможност за точкови изключения. Стойността по подразбиране е
   същият „безопасен“ Proxy като в views-smoke.test.js: държи се като празен списък,
   празен низ и нула при всяко разумно ползване, за да може реалният код на изгледите
   да се изпълни докрай без да се изброяват над 150 различни форми данни. Тук са
   зададени изрично само няколкото извиквания, чиято точна форма има значение. */
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
  // Точно както в Electron: window.prompt() НЕ се поддържа и хвърля. Мокът
  // трябва да е верен на средата — по-рано тук стоеше () => null и това
  // скриваше дефекта, който правеше „Витрини в каталога“ неизползваеми.
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

/* bootstrap.js стартира loadSettingsCache().then(… route()) — този microtask рендира
   началния изглед и презаписва #view. Ако тестът извика renderSetup() преди това,
   резултатът му бива изтрит „изпод краката" му. Затова първо се изчаква стартът. */
async function settled(dom) {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return dom;
}

/* --- 1. Вложена <form> --- */

test('полето за парола на защитата на ЕГН/№ ЛК оцелява в DOM (вложена <form> се изхвърля от парсера)', async () => {
  const dom = buildDom({
    'pdp.status': { configured: true, unlocked: false },
    'settings.get': { org: 'Тест', lib_name: 'Библиотека', place: 'Град' },
    'dbLocation.get': { folder: '', isCustom: false },
    'backup.list': [], 'employees.list': [], 'categories.list': [],
    'limits.usage': { books: 0, readers: 0, loans: 0 }
  });
  const { window } = dom;
  await settled(dom);
  await window.renderSetup();
  await window.loadPdpBox();

  const box = window.document.getElementById('pdpUnlockF');
  assert.ok(box, 'контейнерът #pdpUnlockF трябва да съществува в DOM след loadPdpBox()');
  const input = box.querySelector('input[name="password"]');
  assert.ok(input, 'полето за парола трябва да е вътре в #pdpUnlockF, не осиротяло другаде');

  // Точно това прави pdpDoUnlock() — преди поправката хвърляше TypeError върху null.
  input.value = 'тайна';
  // (обектът идва от jsdom realm-а, затова се сравнява по стойност, не с deepStrictEqual)
  assert.equal(window.formData('#pdpUnlockF').password, 'тайна');
});

test('полето за парола не попада в главната форма на настройките (иначе се праща към settings:update)', async () => {
  const dom = buildDom({
    'pdp.status': { configured: true, unlocked: false },
    'settings.get': { org: 'Тест', lib_name: 'Библиотека', place: 'Град' },
    'dbLocation.get': { folder: '', isCustom: false },
    'backup.list': [], 'employees.list': [], 'categories.list': [],
    'limits.usage': { books: 0, readers: 0, loans: 0 }
  });
  const { window } = dom;
  await settled(dom);
  await window.renderSetup();
  await window.loadPdpBox();
  const stF = window.document.getElementById('stF');
  assert.ok(stF, 'главната форма #stF трябва да съществува');
  assert.equal(stF.querySelector('input[name="password"]'), null,
    'паролата за защита на личните данни не бива да е част от формата с настройките');
});

test('нито един изглед не влага <form> в друга <form>', async () => {
  const dom = buildDom({ 'pdp.status': { configured: true, unlocked: false } });
  const { window } = dom;
  await settled(dom);
  const sections = Array.from(window.document.querySelectorAll('#nav a[href]'))
    .map(a => a.getAttribute('href').replace(/^#/, ''));
  assert.ok(sections.length > 15, 'очакваме поне 15 раздела в менюто');
  for (const key of sections) {
    window.location.hash = '#' + key;
    await window.route();
    const nested = window.document.querySelectorAll('form form');
    assert.equal(nested.length, 0,
      `раздел „${key}“ съдържа вложена <form> — HTML парсерът я изхвърля мълчаливо`);
  }
});

/* --- 2. Апостроф в onclick --- */

test('jsq() оцелява през HTML парсера и връща точната стойност в handler-а', () => {
  const dom = buildDom({});
  const { window } = dom;
  // jsq е top-level const в core.js — такива НЕ стават свойства на window (само var и
  // функционални декларации стават), затова се взима през глобалния лексикален обхват.
  const jsq = window.eval('jsq');
  const cases = [
    "Жана д'Арк",
    'C:\\Users\\Иван\'s\\Резервни копия',
    'обикновено име',
    '<script>alert(1)</script>',
    'кавичка " и амперсанд &',
    "завършва с наклонена \\",
    "две '' поред"
  ];
  for (const value of cases) {
    const div = window.document.createElement('div');
    div.innerHTML = `<button onclick="cb('${jsq(value)}')">x</button>`;
    const attr = div.querySelector('button').getAttribute('onclick');
    let got = null;
    // new Function върши същото, което браузърът прави с тялото на onclick атрибута.
    const fn = new window.Function('cb', attr); // хвърля SyntaxError при счупено екраниране
    fn((s) => { got = s; });
    assert.equal(got, value, `стойността трябва да пристигне непроменена: ${JSON.stringify(value)}`);
  }
});

test('в изгледите не е останало обърнатото екраниране esc(x).replace(/\'/g, …)', () => {
  const offenders = [];
  for (const f of fs.readdirSync(VIEWS_DIR)) {
    if (f === 'core.js') continue; // там живее самото обяснение и дефиницията на jsq
    const src = fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/esc\([^)]*\)\s*\.replace\(\s*\/'/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    'екранирането на апостроф трябва да минава през jsq() — esc() първо е мъртъв код');
});

/* --- 3. Неизчакан async преди печат на квитанция --- */

test('квитанцията след плащане се отпечатва (accountModal се изчаква преди printReceiptLine)', async () => {
  const NEW_LINE_ID = 77;
  const dom = buildDom({
    'readers.get': { id: 5, name: 'Иван Петров', card_no: '0005' },
    // Сметката, каквато я връща сървърът СЛЕД плащането — новият ред е вътре.
    'account.get': {
      balance: 0,
      lines: [{ id: NEW_LINE_ID, kind: 'плащане', type: 'членски внос', amount: 5, date: '2026-08-04', note: '' }]
    },
    'settings.get': { annual_fee: 5, lib_name: 'Библиотека', place: 'Град', org: 'Организация' },
    'account.pay': NEW_LINE_ID
  });
  const { window } = dom;
  await settled(dom);

  // Прихващаме печата — интересува ни само дали изобщо се стига дотам.
  const printed = [];
  window.doPrint = (html) => printed.push(html);
  window.closeModal2 = () => {};
  window.markSaved = () => {};

  // Полето за сума, каквото го чака savePayment().
  const form = window.document.createElement('div');
  form.id = 'payF';
  form.innerHTML = '<input name="amount" value="5"><input name="note" value="">';
  window.document.body.appendChild(form);

  await window.savePayment(5);

  assert.equal(printed.length, 1, 'квитанцията трябва да се отпечата точно веднъж');
  assert.match(printed[0], /КВИТАНЦИЯ/);
  assert.match(printed[0], /Иван Петров/);
});

// Всеки клас за решетка в този CSS носи собствено `display:grid` — няма общо
// правило за `.grid`. Затова, ако класът бъде преименуван/премахнат от
// style.css, докато разметката още го ползва, редът тихо се разпада на
// вертикална колона, без грешка никъде. Тази проверка важи за всички класове
// за решетка, ползвани в изгледите, не само за новия.
test('всеки клас за решетка, ползван в изгледите, има правило в style.css', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src');
  const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');

  const used = new Set();
  for (const f of fs.readdirSync(path.join(dir, 'views'))) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, 'views', f), 'utf8');
    for (const m of src.matchAll(/class="grid ([a-zA-Z0-9_ -]+)"/g)) {
      m[1].trim().split(/\s+/).forEach(c => used.add(c));
    }
  }
  assert.ok(used.size > 0, 'не са намерени класове за решетка в изгледите');

  for (const cls of used) {
    assert.match(css, new RegExp('\\.grid\\.' + cls + '\\s*\\{[^}]*display\\s*:\\s*grid'),
      `class="grid ${cls}" се ползва в изгледите, но в style.css няма ` +
      `.grid.${cls}{display:grid…} — редът ще се подреди вертикално`);
  }
});

/* --- 4. window.prompt() в Electron ---
   Electron НЕ поддържа window.prompt(): извикването хвърля „prompt() is not
   supported.“ право в handler-а на бутона — без прозорец, без съобщение, без
   следа на екрана. Проверено с истинския Electron 43 от package.json:
   executeJavaScript("window.prompt('Име:')") връща THREW prompt() is not
   supported. Ефект за библиотекаря: „Витрини в каталога“ бяха напълно
   неизползваеми — „+ Нова витрина“ не правеше НИЩО, а без витрина и всичко
   останало в раздела е безсмислено. Същият дефект убиваше „Нова резервация“
   и вписването на посещение по домовете.

   Двата теста по-долу: първият пази срещу всяко ново ползване на prompt(),
   вторият проверява, че замяната (askText() в core.js) наистина работи —
   отваря прозорец, връща въведеното и се разрешава при отказ, вместо да
   увисне. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('нито един изглед не вика prompt() — Electron не го поддържа (ползвайте askText)', () => {
  const bad = [];
  for (const f of fs.readdirSync(VIEWS_DIR)) {
    if (!f.endsWith('.js')) continue;
    const src = stripComments(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'));
    for (const m of src.matchAll(/\bprompt\s*\(/g)) {
      const before = src.slice(0, m.index);
      const line = before.split('\n').length;
      bad.push(`${f}:${line}`);
    }
  }
  assert.deepEqual(bad, [], 'prompt() хвърля в Electron и действието умира тихо; ' +
    'ползвайте askText(title, opts) от core.js');
});

// Мок на window.api, който ЗАПОМНЯ извикванията — тук ни трябват точните
// аргументи на shelves:create, не само че не е гръмнало.
function recordingApi(calls, results) {
  const node = (parts) => new Proxy(function () {}, {
    get(t, p) { if (p === 'then' || typeof p === 'symbol') return undefined; return node(parts.concat(p)); },
    apply(t, self, args) {
      const key = parts.join('.');
      calls.push({ key, args });
      return Promise.resolve({ ok: true, data: results && key in results ? results[key] : [] });
    }
  });
  return node([]);
}

test('„+ Нова витрина“ работи и когато prompt() хвърля, както в Electron', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  // Точно поведението на Electron — ако кодът пак посегне към prompt(), гърми.
  window.prompt = () => { throw new Error('prompt() is not supported.'); };
  const calls = [];
  window.api = recordingApi(calls, { 'shelves.create': 7 });

  const p = window.createShelf();
  await new Promise(r => setTimeout(r, 0));
  const input = window.document.querySelector('#modal input[name="v"]');
  assert.ok(input, 'прозорецът за име на новата витрина не се отвори');
  input.value = 'Лято 2026';
  window.document.querySelector('#modal [data-ask="ok"]').click();
  await p;

  const create = calls.find(c => c.key === 'shelves.create');
  assert.ok(create, 'shelves:create не беше извикан');
  // Аргументите идват от друга realm (jsdom), затова се сравняват поелементно.
  assert.equal(create.args.length, 1);
  assert.equal(create.args[0], 'Лято 2026');
  // След създаване списъкът се презарежда и новата витрина се отваря.
  assert.ok(calls.some(c => c.key === 'shelves.list'), 'списъкът с витрини не се презареди');
  assert.ok(calls.some(c => c.key === 'shelves.items' && c.args[0] === 7), 'новата витрина не се отвори');
});

test('отказ (Esc) в askText разрешава обещанието с null, вместо да увисне', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  const calls = [];
  window.api = recordingApi(calls, {});

  const p = window.createShelf();
  await new Promise(r => setTimeout(r, 0));
  assert.ok(window.document.querySelector('#modal input[name="v"]'), 'прозорецът не се отвори');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  // Ако обещанието не се разреши, тук се увисва — затова с изричен краен срок.
  const outcome = await Promise.race([p.then(() => 'разрешено'),
    new Promise(r => setTimeout(() => r('УВИСНА'), 500))]);
  assert.equal(outcome, 'разрешено');
  assert.equal(calls.length, 0, 'при отказ не трябва да се вика нищо');
  assert.equal(window.document.querySelector('#modal input[name="v"]'), null, 'прозорецът остана отворен');
});

/* --- 5. „Инвентарна книга“: прозоречен рендер и забавено търсене ---
   Преди поправката целият списък се чертаеше наведнъж, а полето за търсене
   имаше inline oninput без debounce. Измерено в истински Chromium при 15 000
   записа: първо изчертаване 1272 ms и 7 МБ HTML, а писането на осем знака —
   2298 ms блокиран интерфейс (~287 ms на знак). След поправката: 36 ms,
   140 КБ, и нула синхронна работа по време на писане.

   Тук се пази същността, а не милисекундите: най-много INVBOOK_PAGE_SIZE реда
   в таблицата, бутон „Покажи още“ за останалите, никакъв inline oninput (той
   заобикаля debounce-а) и непокътнат източник за печата. */
function invBookRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, inv_number: i + 1, register_date: '2020-01-01',
    author: i % 2 ? 'Вазов, Иван' : 'Йовков, Йордан', title: 'Заглавие ' + (i + 1),
    year: '1980', price: 5, call_number: 'Б/Ваз', status: 'наличен', checks: []
  }));
}

test('„Инвентарна книга“ чертае най-много една страница редове, с бутон „Покажи още“', async () => {
  const N = 1000;
  const dom = await settled(buildDom({ 'invBook.list': invBookRows(N) }));
  const { window } = dom;
  await window.renderInvBook();

  // Размерът на страницата се чете от самия DOM (INVBOOK_PAGE_SIZE е const в
  // глобалния лексикален обхват на скриптовете, не свойство на window).
  const size = window.document.querySelectorAll('#ibBody tr').length;
  assert.ok(size > 0 && size < N,
    `в таблицата се чертаят ${size} от ${N} реда — при пълния списък интерфейсът замръзва`);
  assert.match(window.document.querySelector('#ibMore').textContent, /Покажи още \((\d+) от общо 1000\)/);

  // „Покажи още“ добавя следващата страница, без да презарежда данните.
  window.document.querySelector('#ibMore button').click();
  assert.equal(window.document.querySelectorAll('#ibBody tr').length, size * 2);

  // Печатът ползва целия списък, независимо какво се вижда на екрана.
  assert.equal(window._INVBOOK_ROWS.length, N);
});

test('търсенето в „Инвентарна книга“ е с debounce и не е инline oninput', async () => {
  const dom = await settled(buildDom({ 'invBook.list': invBookRows(1000) }));
  const { window } = dom;
  await window.renderInvBook();

  const input = window.document.querySelector('#ibSearch');
  assert.equal(input.getAttribute('oninput'), null,
    'inline oninput заобикаля debounce-а — всяко натискане на клавиш пререндира списъка');

  // Осем натискания на клавиш → таблицата НЕ се пипа веднага…
  const before = window.document.querySelector('#ibBody').innerHTML;
  const word = 'Вазов, И';
  for (let i = 1; i <= word.length; i++) {
    input.value = word.slice(0, i);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  assert.equal(window.document.querySelector('#ibBody').innerHTML, before,
    'таблицата не бива да се пререндира по време на писането');

  // …а веднъж, след затихване.
  await new Promise(r => setTimeout(r, 400));
  const rows = [...window.document.querySelectorAll('#ibBody tr')];
  assert.ok(rows.length > 0);
  assert.ok(rows.every(tr => /Вазов/.test(tr.textContent)), 'показани са само съвпаденията');
  // Полето за търсене не се пресъздава — курсорът на библиотекаря остава в него.
  assert.equal(window.document.querySelector('#ibSearch'), input);
});
