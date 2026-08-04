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
  window.prompt = () => null;
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
