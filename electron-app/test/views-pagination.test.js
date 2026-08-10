'use strict';
/* Регресионни тестове v1.68.1 — „Покажи още“ не праща ново IPC извикване в
   „Книги“, „Читатели“ и „Инвентарна книга“, плюс прозоречният рендер и
   debounce-ът на търсенето в „Инвентарна книга“ (въведени в v1.68.0).

   „Инвентарна книга“ рендираше ВСИЧКИ редове наведнъж и пререндираше пълния
   списък на ВСЯКО натискане на клавиш в търсенето (изцяло клиентско — разделът
   няма сървърен филтър). Измерено в истински Chromium при 15 000 записа, преди
   v1.68.0: първо изчертаване 1272 ms и 7,0 МБ HTML, а писането на осем знака —
   2298 ms блокиран интерфейс. След нея: 36 ms, 140 КБ, нула синхронна работа по
   време на писането.

   Отделно (v1.68.1): бутонът „Покажи още“ в „Книги“ и „Читатели“ викаше пълния
   render*() наново при всяко натискане, а той праща целия списък по IPC
   (categories/searchHistory включително), макар данните вече да стоят в паметта —
   разгръщане на голям фонд страница по страница пращаше едни и същи хиляди редове
   толкова пъти, колкото пъти е натиснат бутонът.

   И трите изгледа вече ползват установения модел: прозорец от 300 реда, „Покажи
   още“ разширява прозореца БЕЗ ново IPC извикване, а търсенето в „Инвентарна
   книга“ е с debounce (300 ms) на слушателя на полето, като в „Книги“ и
   „Читатели“. */
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

/* apiMock тук ДОПЪЛНИТЕЛНО брои извикванията по endpoint (callCounts), за да може
   тестът да провери, че „Покажи още“ не праща ново IPC извикване. */
function apiMock(overrides, callCounts) {
  function makeNode(parts) {
    const key = parts.join('.');
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeNode(parts.concat(prop));
      },
      apply() {
        callCounts[key] = (callCounts[key] || 0) + 1;
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
  dom.callCounts = {};
  const { window } = dom;
  window.api = apiMock(overrides || {}, dom.callCounts);
  window.confirm = () => true;
  // Точно както в Electron: window.prompt() НЕ се поддържа и хвърля.
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

function makeInvBookRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: i, inv_number: i, register_date: '2015-01-15',
      title: 'Заглавие №' + i, author: i % 7 === 0 ? 'Вазов, Иван' : 'Друг автор',
      year: '2010', price: 5, call_number: 'Ч-' + i, status: 'наличен', checks: []
    });
  }
  return rows;
}
function makeBooksRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: i, inv_number: i, title: 'Заглавие №' + i, author: 'Автор', category_name: 'книга',
      department: 'за възрастни', year: '2010', status: 'наличен', quantity: 1, available: 1
    });
  }
  return rows;
}
function makeReadersRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ id: i, name: 'Читател №' + i, phone: '', card_no: 'K' + i, category: 'възрастен', status: 'активен' });
  }
  return rows;
}

/* --- Инвентарна книга: прозоречен рендер --- */

test('Инвентарна книга: рендира прозорец от 300 реда, не всичките 1200', async () => {
  const dom = buildDom({ 'invBook.list': makeInvBookRows(1200) });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#invbook';
  await window.route();
  const rowCount = window.document.querySelectorAll('#ibBody tr').length;
  assert.equal(rowCount, 300);
  const moreBtn = window.document.querySelector('#ibMore button');
  assert.ok(moreBtn, 'бутонът „Покажи още“ трябва да присъства, когато има още редове');
  assert.match(moreBtn.textContent, /900 от общо 1\s*200|900 от общо 1200/);
});

test('Инвентарна книга: „Покажи още“ разширява прозореца без ново IPC извикване', async () => {
  const dom = buildDom({ 'invBook.list': makeInvBookRows(1200) });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#invbook';
  await window.route();
  const before = dom.callCounts['invBook.list'];
  window.document.querySelector('#ibMore button').click();
  assert.equal(window.document.querySelectorAll('#ibBody tr').length, 600);
  assert.equal(dom.callCounts['invBook.list'], before,
    '„Покажи още“ не бива да предизвиква ново извикване на invBook.list — данните вече са в паметта');
});

test('Инвентарна книга: търсенето е с debounce — писане буква по буква не пририсува на всяко натискане', async () => {
  const dom = buildDom({ 'invBook.list': makeInvBookRows(1200) });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#invbook';
  await window.route();
  // location.hash = '#invbook' праща и hashchange, който bootstrap.js хваща и
  // рутира ВТОРИ път — асинхронно, малко след явния route() тук. Затова първо се
  // изчаква утихване и чак тогава се снима базата за сравнение; иначе броячът
  // мърда по време на теста по причина, която няма нищо общо с търсенето.
  await new Promise(r => setTimeout(r, 60));
  const before = window.document.getElementById('ibBody').innerHTML;
  const ipcBefore = dom.callCounts['invBook.list'];

  // Тестът минава по ИСТИНСКИЯ път на библиотекаря — събития в полето за търсене.
  // Debounce-ът стои на слушателя на полето (както в books.js/readers.js), а не в
  // invBookFilter(); програмното извикване на invBookFilter() пририсува веднага и
  // това е нарочно — забавянето има смисъл само при писане на ръка.
  const input = window.document.getElementById('ibSearch');
  for (const q of ['в', 'ва', 'ваз']) {
    input.value = q;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  assert.equal(window.document.getElementById('ibBody').innerHTML, before,
    'преди изтичане на debounce интервала тялото не бива да се променя');

  await new Promise(r => setTimeout(r, 400));
  const after = window.document.getElementById('ibBody').innerHTML;
  assert.notEqual(after, before, 'след изтичане на debounce интервала тялото трябва да е пририсувано');
  // Само редовете на „Вазов, Иван" би трябвало да минат филтъра по автор.
  const rows = window.document.querySelectorAll('#ibBody tr');
  assert.ok(rows.length > 0 && rows.length < 300, 'филтърът трябва реално да стеснява резултата');
  // Филтърът е изцяло клиентски — писането не бива да праща нито едно IPC извикване.
  assert.equal(dom.callCounts['invBook.list'], ipcBefore,
    'търсенето филтрира в паметта и не бива да презарежда списъка по IPC');
});

/* --- Книги / Читатели: „Покажи още“ без ново IPC извикване --- */

test('Книги: „Покажи още“ разширява прозореца без ново извикване на books.list/categories.list', async () => {
  const dom = buildDom({ 'books.list': makeBooksRows(900), 'categories.list': [] });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#books';
  await window.route();
  assert.equal(window.document.querySelectorAll('#bBody tr').length, 300);
  const beforeList = dom.callCounts['books.list'];
  const beforeCats = dom.callCounts['categories.list'];
  window.document.querySelector('#bMore button').click();
  assert.equal(window.document.querySelectorAll('#bBody tr').length, 600);
  assert.equal(dom.callCounts['books.list'], beforeList, 'без ново books.list извикване');
  assert.equal(dom.callCounts['categories.list'], beforeCats, 'без ново categories.list извикване');
});

test('Читатели: „Покажи още“ разширява прозореца без ново извикване на readers.list', async () => {
  const dom = buildDom({ 'readers.list': makeReadersRows(900) });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#readers';
  await window.route();
  assert.equal(window.document.querySelectorAll('#rBody tr').length, 300);
  const before = dom.callCounts['readers.list'];
  window.document.querySelector('#rMore button').click();
  assert.equal(window.document.querySelectorAll('#rBody tr').length, 600);
  assert.equal(dom.callCounts['readers.list'], before, 'без ново readers.list извикване');
});

/* --- Книги / Читатели: филтри по отдел/категория/статус (v1.70.0) --- */

test('Книги: филтърът по отдел стеснява резултата без ново IPC извикване', async () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push({
      id: i, inv_number: i, title: 'Заглавие №' + i, author: 'Автор', category_name: 'книга',
      category_id: (i % 2) + 1, department: i % 2 === 0 ? 'за възрастни' : 'за деца',
      year: '2010', status: 'наличен', quantity: 1, available: 1
    });
  }
  const cats = [{ id: 1, name: 'Роман' }, { id: 2, name: 'Приказки' }];
  const dom = buildDom({ 'books.list': rows, 'categories.list': cats });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#books';
  await window.route();
  assert.equal(window.document.querySelectorAll('#bBody tr').length, 20);
  const before = dom.callCounts['books.list'];
  const sel = window.document.getElementById('bDeptFilter');
  sel.value = 'за деца';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  const trs = window.document.querySelectorAll('#bBody tr');
  assert.equal(trs.length, 10, 'филтърът по отдел трябва да стесни резултата наполовина');
  assert.equal(dom.callCounts['books.list'], before, 'филтърът е клиентски и не бива да праща ново IPC');
});

test('Книги: филтърът по категория стеснява резултата', async () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push({
      id: i, inv_number: i, title: 'Заглавие №' + i, author: 'Автор', category_name: i % 2 === 0 ? 'Приказки' : 'Роман',
      category_id: (i % 2) + 1, department: 'за възрастни', year: '2010', status: 'наличен', quantity: 1, available: 1
    });
  }
  const cats = [{ id: 1, name: 'Роман' }, { id: 2, name: 'Приказки' }];
  const dom = buildDom({ 'books.list': rows, 'categories.list': cats });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#books';
  await window.route();
  const sel = window.document.getElementById('bCatFilter');
  sel.value = '2'; // Приказки
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.document.querySelectorAll('#bBody tr').length, 10);
});

test('Читатели: филтрите по категория и състояние стесняват резултата без ново IPC извикване', async () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push({
      id: i, name: 'Читател №' + i, phone: '', card_no: 'K' + i,
      category: i % 2 === 0 ? 'ученик' : 'възрастен', status: i <= 5 ? 'прекратен' : 'активен'
    });
  }
  const dom = buildDom({ 'readers.list': rows });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#readers';
  await window.route();
  assert.equal(window.document.querySelectorAll('#rBody tr').length, 20);
  const before = dom.callCounts['readers.list'];

  const catSel = window.document.getElementById('rCatFilter');
  catSel.value = 'ученик';
  catSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.document.querySelectorAll('#rBody tr').length, 10, 'филтърът по категория трябва да стесни резултата наполовина');

  catSel.value = '';
  catSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  const statusSel = window.document.getElementById('rStatusFilter');
  statusSel.value = 'прекратен';
  statusSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.document.querySelectorAll('#rBody tr').length, 5, 'филтърът по състояние трябва да покаже само прекратените');
  assert.equal(dom.callCounts['readers.list'], before, 'филтрите са клиентски и не бива да пращат ново IPC');
});
