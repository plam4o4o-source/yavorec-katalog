'use strict';
// v2.4.2 — логото на InvLib (реалната икона, не преначертана) вече стои
// центрирано най-отгоре в страничната лента, над рамката. Самата рамка,
// преди с твърдо вписан текст "ИНВЕНТАР" / "Библиотечна система", вече
// показва действителното наименование на библиотеката от Настройки
// (lib_name, с пад към org) — с #brandName, обновявано от updateBrandSub()
// в core.js всеки път при зареждане/смяна на настройките. Тестовете
// проверяват и статичната разметка (index.html/style.css), и динамичното
// поведение чрез същия jsdom харнес като views-regressions.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');
const INDEX_HTML = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(SRC_DIR, 'style.css'), 'utf8');

test('index.html: логото на InvLib (assets/brand-icon.png) стои между .brand и .brandMark — центрирано най-отгоре, над рамката', () => {
  const m = INDEX_HTML.match(/<div class="brand">\s*<img class="brandIcon" src="assets\/brand-icon\.png"[^>]*>\s*<div class="brandMark">/);
  assert.ok(m, 'очаква се <img class="brandIcon"> точно между <div class="brand"> и <div class="brandMark">');
});

test('index.html: рамката (.brandMark) вече не съдържа твърдо вписано "ИНВЕНТАР"/"Библиотечна система" — само динамичното #brandName', () => {
  assert.doesNotMatch(INDEX_HTML, /brandTitle|brandTagline/,
    'старите класове за твърдо вписания текст на приложението не трябва да съществуват вече');
  assert.match(INDEX_HTML, /<div class="brandMark">\s*<div class="brandName" id="brandName">/);
});

test('electron-app/src/assets/brand-icon.png съществува на диск (пакетира се през build.files: "src/**/*")', () => {
  const p = path.join(SRC_DIR, 'assets', 'brand-icon.png');
  assert.ok(fs.existsSync(p), 'липсва electron-app/src/assets/brand-icon.png');
  assert.ok(fs.statSync(p).size > 0, 'brand-icon.png е празен файл');
});

test('style.css: .brandIcon е центрирана (margin:0 auto), .brandMark пази старата двойна рамка', () => {
  assert.match(STYLE_CSS, /\.brandIcon\{[^}]*margin:0 auto/);
  assert.match(STYLE_CSS, /\.brandMark\{[^}]*border:1px solid var\(--brassL\)/);
  assert.match(STYLE_CSS, /\.brandMark::before\{[^}]*border:1px solid var\(--brassD\)/);
});

/* ---- динамично поведение (jsdom харнес, идентичен по дух на views-regressions.test.js) ---- */

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
function scriptOrderFromIndexHtml() {
  return Array.from(INDEX_HTML.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}
function buildDom(overrides) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(INDEX_HTML, {
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
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return dom;
}

const BASE_OVERRIDES = {
  'dbLocation.get': { folder: '', isCustom: false },
  'backup.list': [], 'employees.list': [], 'categories.list': [],
  'limits.usage': { books: 0, readers: 0, loans: 0 }
};

test('updateBrandSub(): #brandName показва "Наименование на библиотеката" (lib_name) от Настройки, не твърдо вписан текст', async () => {
  const dom = buildDom({
    ...BASE_OVERRIDES,
    'settings.get': {
      org: 'НЧ „Васил Левски – 1922“',
      lib_name: 'Библиотека при НЧ „Васил Левски – 1922“',
      place: 'с. Яворец'
    }
  });
  await settled(dom);
  const el = dom.window.document.getElementById('brandName');
  assert.ok(el, '#brandName трябва да съществува в DOM-а след bootstrap');
  assert.equal(el.textContent, 'Библиотека при НЧ „Васил Левски – 1922“');
  assert.equal(el.classList.contains('brandNameEmpty'), false);
  assert.equal(el.title, 'Библиотека при НЧ „Васил Левски – 1922“',
    'title атрибутът носи пълния текст като tooltip, ако името се пренесе на няколко реда');
});

test('updateBrandSub(): пада към "Организация" (org), ако "Наименование на библиотеката" не е попълнено', async () => {
  const dom = buildDom({
    ...BASE_OVERRIDES,
    'settings.get': { org: 'НЧ „Васил Левски – 1922“', lib_name: '', place: 'с. Яворец' }
  });
  await settled(dom);
  const el = dom.window.document.getElementById('brandName');
  assert.equal(el.textContent, 'НЧ „Васил Левски – 1922“');
});

test('updateBrandSub(): при празни org и lib_name показва подкана да се попълнят Настройките, с клас brandNameEmpty', async () => {
  const dom = buildDom({
    ...BASE_OVERRIDES,
    'settings.get': { org: '', lib_name: '', place: '' }
  });
  await settled(dom);
  const el = dom.window.document.getElementById('brandName');
  assert.match(el.textContent, /Настройки/);
  assert.ok(el.classList.contains('brandNameEmpty'));
});

test('updateBrandSub(): #brandSub показва само населеното място — организацията/името не се повтарят под рамката', async () => {
  const dom = buildDom({
    ...BASE_OVERRIDES,
    'settings.get': { org: 'НЧ „Васил Левски – 1922“', lib_name: 'Библиотека', place: 'с. Яворец' }
  });
  await settled(dom);
  const el = dom.window.document.getElementById('brandSub');
  assert.equal(el.textContent, 'с. Яворец');
  assert.doesNotMatch(el.textContent, /НЧ|Библиотека/,
    'наименованието вече стои само в рамката (#brandName) — тук не бива да се повтаря');
});

test('updateBrandSub(): #brandSub се скрива изцяло, когато населеното място не е попълнено (без празен ред, без повторна подкана)', async () => {
  const dom = buildDom({
    ...BASE_OVERRIDES,
    'settings.get': { org: 'НЧ „Васил Левски – 1922“', lib_name: 'Библиотека', place: '' }
  });
  await settled(dom);
  const el = dom.window.document.getElementById('brandSub');
  assert.equal(el.textContent, '');
  assert.equal(el.style.display, 'none');
});
