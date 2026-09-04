'use strict';
// Втори бутон "Запиши настройките" в самата карта "Библиотека" в Настройки.
// Формата #stF е дълга (Библиотека/Обслужване/Постоянна комисия/Правила по
// категория/Календар...), а единственият бутон стоеше чак на дъното —
// библиотекар, който само смени наименованието/адреса горе, трябваше да
// скролва до края, за да разбере, че въобще има бутон "Запиши". И двата
// бутона записват ЦЯЛАТА форма (не само картата "Библиотека") — извикват
// същата saveSetup(). Хармата е същата по дух като fixes-brand-sidebar.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');
const INDEX_HTML = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(VIEWS_DIR, 'settings.js'), 'utf8');

test('settings.js: картата "Библиотека" съдържа собствен бутон "Запиши настройките", преди картата "Обслужване"', () => {
  /* v2.4.27: Настройките са преустроени в раздели; картата „Библиотека“ е първата
     в раздел #setup-biblioteka, „Обслужване“ — в #setup-obsluzhvane. Смисълът на
     теста е същият: бутонът е горе, при полетата, не само в дъното. */
  const libCardIdx = SETTINGS_JS.indexOf('<div class="card setupCard"><h3 style="margin-top:0">Библиотека</h3>');
  const serviceCardIdx = SETTINGS_JS.indexOf('<div class="card setupCard"><h3 style="margin-top:0">Обслужване</h3>');
  assert.ok(libCardIdx >= 0, 'липсва картата "Библиотека"');
  assert.ok(serviceCardIdx > libCardIdx, 'липсва картата "Обслужване" след "Библиотека"');
  const libCard = SETTINGS_JS.slice(libCardIdx, serviceCardIdx);
  assert.match(libCard, /onclick="saveSetup\(\)"/,
    'картата "Библиотека" трябва да съдържа бутон, извикващ saveSetup() — не собствена нова функция');
  assert.match(libCard, />Запиши настройките</);
});

/* ---- динамично поведение: реалният бутон в картата действително вика saveSetup() ---- */

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
function apiMock(overrides, onCall) {
  function makeNode(parts) {
    const key = parts.join('.');
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeNode(parts.concat(prop));
      },
      apply(t, thisArg, args) {
        if (onCall) onCall(key, args);
        const data = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : safeDefault();
        return Promise.resolve({ ok: true, data });
      }
    });
  }
  return makeNode([]);
}
function scriptOrderFromIndexHtml() {
  return Array.from(INDEX_HTML.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}
function buildDom(overrides, onCall) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(INDEX_HTML, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  window.api = apiMock(overrides || {}, onCall);
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
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return dom;
}

const BASE_OVERRIDES = {
  'dbLocation.get': { folder: '', isCustom: false },
  'backup.list': [], 'employees.list': [], 'categories.list': [],
  'limits.usage': { books: 0, readers: 0, loans: 0 },
  'settings.get': { org: 'НЧ Тест', lib_name: 'Библиотека Тест', place: 'с. Тест' }
};

test('бутонът "Запиши настройките" в картата "Библиотека" реално вика settings:update с текущите стойности на формата', async () => {
  const calls = [];
  const dom = buildDom(BASE_OVERRIDES, (key, args) => calls.push({ key, args }));
  dom.window.go('setup');
  await settled(dom);

  const libNameInput = dom.window.document.querySelector('[name=lib_name]');
  assert.ok(libNameInput, 'липсва полето lib_name в изрендерената форма');
  libNameInput.value = 'Ново наименование от теста';

  // Бутонът вътре в самата карта "Библиотека" — не бъркаме го с този на дъното,
  // затова взимаме първия "Запиши настройките" на страницата.
  const btn = Array.from(dom.window.document.querySelectorAll('button'))
    .find(b => b.textContent.trim() === 'Запиши настройките');
  assert.ok(btn, 'няма бутон "Запиши настройките" в изрендерираната страница');
  btn.click();
  await settled(dom);

  const updateCall = calls.find(c => c.key === 'settings.update');
  assert.ok(updateCall, 'кликването върху бутона трябва да извика window.api.settings.update(...)');
  assert.equal(updateCall.args[0].lib_name, 'Ново наименование от теста',
    'изпратените данни трябва да съдържат новата стойност от полето, не старата');
});
