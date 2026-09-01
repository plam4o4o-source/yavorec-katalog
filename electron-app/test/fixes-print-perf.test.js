'use strict';
/* Тестове v2.3.0 за седем ИЗМЕРЕНИ дефекта в печата и в изчертаването на
   големи списъци. Всеки тест пада върху кода отпреди поправката и минава след
   нея. Числата по-долу са мерени с jsdom върху истинските src/views/*.js при
   реалистичен обем (15 000 книги, 14 750 етикета) — стендът е същият като тук,
   само че кара сценария докрай:

   1) doPrint() вкарваше документа ДВА пъти в DOM (#printArea и #ppSheet).
      При 6 000 етикета: 2 × 12,53 МБ и 2 × 246 467 възела, 27 983 ms.
      След: 1 копие, 10 598 ms. При 14 750 етикета преди — процесът беше убит
      от липса на памет (8 ГБ), след поправката минава: 32,82 МБ, 36 996 ms.
   2) ppClose() не изчистваше #printArea: след затваряне на прегледа при 6 000
      етикета в паметта оставаха 12,53 МБ / 246 467 възела (и в #ppSheet още
      толкова). След: 0 и 0.
   3) Печат на етикети за целия фонд тръгваше без таван и без въпрос.
   4) На A4 три читателски карти по 90 мм искат 3×90 + 2×3 = 276 мм при
      налични 210 − 2×8 = 194 мм — Chromium режеше всяка трета карта мълчаливо.
   5) „Покажи още“ беше квадратичен: 49 натискания от 300 до 15 000 реда
      подаваха за разпарсване 382 200 реда / 183,7 МБ HTML в „Книги“ и
      382 200 реда / 196,8 МБ в „Инвентарна книга“. След: по 14 700 реда и
      7,1 / 7,6 МБ — всеки ред се чертае точно веднъж.
   6) Одитната следа е ограничена в базата (LIMIT 500), но броячът пишеше
      „500 записа“, все едно това е целият брой.
   7) razbivka() в kdbf.js стоеше дефинирана и никога извиквана; колоната
      „По вид“ (задължителна по чл. 13, ал. 3, т. 1) беше празна на екрана и
      липсваше в разпечатката. */
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

/* Същият „безопасен“ Proxy като в views-smoke/views-pagination: държи се като
   празен списък, празен низ и нула, за да може реалният код на изгледите да се
   изпълни докрай без да се изброяват над 150 форми данни. */
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

/* dom.confirms събира въпросите към библиотекаря, dom.confirmAnswer решава
   отговора — потвърждението за много етикети се проверява и в двете посоки. */
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
  dom.confirms = [];
  dom.confirmAnswer = true;
  dom.printedArea = []; // какво е стояло в #printArea в мига на window.print()
  const { window } = dom;
  window.api = apiMock(overrides || {});
  window.confirm = (msg) => { dom.confirms.push(String(msg)); return dom.confirmAnswer; };
  window.prompt = () => { throw new Error('prompt() is not supported.'); };
  window.alert = () => {};
  window.print = () => {
    const area = window.document.getElementById('printArea');
    dom.printedArea.push(area ? area.innerHTML : '');
  };
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

const LABEL_SETTINGS = {
  lib_name: 'Библиотека при НЧ', place: 'с. Яворец',
  lbl_mode: 'sheet', lbl_cols: 3, lbl_gap: 3, lbl_margin: 8,
  lbl_w: 40, lbl_h: 30, sig_w: 25, sig_h: 35, card_w: 90, card_h: 60
};
function makeBooks(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ id: i, inv_number: i, barcode: String(i), title: 'Заглавие №' + i, author: 'Вазов, Иван',
      category_name: 'книга', department: 'за възрастни', year: '2010', status: 'наличен',
      call_number: 'Ч-' + i, udk: '821.163.2', author_mark: 'В-15', quantity: 1, available: 1 });
  }
  return rows;
}
function makeReaders(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ id: i, name: 'Читател №' + i, phone: '', card_no: 'K' + i, category: 'възрастен',
      status: 'активен', registered_at: '2026-01-05' });
  }
  return rows;
}
function makeInvRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ id: i, inv_number: i, register_date: '2015-01-15', title: 'Заглавие №' + i,
      author: 'Вазов, Иван', year: '2010', price: 5, call_number: 'Ч-' + i, status: 'наличен', checks: [] });
  }
  return rows;
}

/* ---------- 1) Един документ — едно вмъкване в DOM ---------- */

test('doPrint() вкарва документа само на ЕДНО място, а не и в #printArea', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.setPrintPage({ name: 'Проба' });
  window.doPrint('<div class="pdoc"><h2>ПРОБЕН ДОКУМЕНТ</h2></div>');
  const sheet = window.document.getElementById('ppSheet');
  const area = window.document.getElementById('printArea');
  assert.match(sheet.innerHTML, /ПРОБЕН ДОКУМЕНТ/, 'листът на прегледа трябва да показва документа');
  assert.equal(area.innerHTML, '',
    '#printArea не бива да се пълни при отваряне на прегледа — печат още не е поискан, '
    + 'а второто копие удвоява паметта и времето за разпарсване');
});

test('ppPrint() пълни #printArea точно за печата и го изчиства след него', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.setPrintPage({ name: 'Проба' });
  window.doPrint('<div class="pdoc"><h2>ПРОБЕН ДОКУМЕНТ</h2></div>');
  window.ppPrint();
  // ppPrint чака два кадъра и 150 ms преди window.print() — виж core.js.
  await new Promise(r => setTimeout(r, 400));
  assert.equal(dom.printedArea.length, 1, 'печатът трябва да е бил извикан веднъж');
  assert.match(dom.printedArea[0], /ПРОБЕН ДОКУМЕНТ/,
    'в мига на window.print() документът ТРЯБВА да е в #printArea — само той е видим при печат');
  assert.equal(window.document.getElementById('printArea').innerHTML, '',
    'след печата #printArea трябва да е изчистен');
});

test('Ctrl+P при отворен преглед пак печата документа, а не празна страница', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.setPrintPage({ name: 'Проба' });
  window.doPrint('<div class="pdoc"><h2>ПРОБЕН ДОКУМЕНТ</h2></div>');
  // Ctrl+P заобикаля бутона „Печат…“ — предпазителят beforeprint трябва да
  // вкара подготвения документ, вместо да съобщи, че такъв няма.
  window.dispatchEvent(new window.Event('beforeprint'));
  assert.match(window.document.getElementById('printArea').innerHTML, /ПРОБЕН ДОКУМЕНТ/);
  assert.equal(window.document.querySelectorAll('#toastsTop .toast').length, 0,
    'не бива да се оплаква, че няма подготвен документ');
});

/* ---------- 2) Затварянето освобождава паметта ---------- */

test('ppClose() изчиства и #ppSheet, и #printArea', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.setPrintPage({ name: 'Проба' });
  window.doPrint('<div class="pdoc"><h2>ЗА ИЗЧИСТВАНЕ</h2></div>');
  window.ppClose();
  assert.equal(window.document.getElementById('ppSheet').innerHTML, '',
    'листът на прегледа трябва да се освободи при затваряне');
  assert.equal(window.document.getElementById('printArea').innerHTML, '',
    'скритото копие за печат също — иначе стои в паметта до затваряне на програмата');
});

/* ---------- 3) Таван и потвърждение при много етикети ---------- */

test('Печат на етикети за целия фонд иска изрично потвърждение с броя', async () => {
  const dom = buildDom({ 'books.list': makeBooks(600), 'settings.get': LABEL_SETTINGS });
  const { window } = dom;
  await settled(dom);
  dom.confirmAnswer = false;
  await window.printLabelsAll();
  await settled(dom);
  assert.equal(dom.confirms.length, 1, '600 етикета над прага трябва да питат веднъж');
  assert.match(dom.confirms[0], /600/, 'въпросът трябва да казва КОЛКО етикета ще се печатат');
  assert.match(dom.confirms[0], /листа/, 'и на колко листа A4 излизат');
  assert.match(dom.confirms[0], /партиди/i, 'и да предлага разделяне на партиди');
  assert.equal(window.document.getElementById('ppSheet').innerHTML, '',
    'при отказ нищо не бива да се подготвя за печат');
  assert.ok(!window.document.getElementById('printPreview').classList.contains('on'),
    'при отказ прегледът не се отваря');
});

test('Под прага печатът на етикети минава без излишни въпроси', async () => {
  const dom = buildDom({ 'books.list': makeBooks(24), 'settings.get': LABEL_SETTINGS });
  const { window } = dom;
  await settled(dom);
  await window.printLabelsAll();
  await settled(dom);
  assert.equal(dom.confirms.length, 0, '24 етикета са обичайна работа — без въпроси');
  assert.match(window.document.getElementById('ppSheet').innerHTML, /lblsheet/);
});

/* ---------- 4) Колоните трябва да се съберат на листа ---------- */

test('Читателските карти (90 мм) намаляват колоните до толкова, колкото се събират на A4', async () => {
  const dom = buildDom({ 'readers.list': makeReaders(4), 'settings.get': LABEL_SETTINGS });
  const { window } = dom;
  await settled(dom);
  await window.printCardsAll();
  await settled(dom);
  const css = window.document.getElementById('dynPrintStyle').textContent;
  // Налични 210 − 2×8 = 194 мм. 3 карти искат 3×90 + 2×3 = 276 мм (не се
  // събират), 2 карти — 2×90 + 1×3 = 183 мм (събират се).
  assert.match(css, /repeat\(2,90mm\)/,
    'колоните трябва да се смалят до 2 — при 3 Chromium реже всяка трета карта без предупреждение');
  assert.ok(!/repeat\(3,90mm\)/.test(css), 'три колони по 90 мм не се побират в A4');
});

test('Етикетът за фонда (40 мм) си остава на 3 колони — там намаляване не е нужно', async () => {
  const dom = buildDom({ 'books.list': makeBooks(6), 'settings.get': LABEL_SETTINGS });
  const { window } = dom;
  await settled(dom);
  await window.printLabelsAll();
  await settled(dom);
  const css = window.document.getElementById('dynPrintStyle').textContent;
  // 3×40 + 2×3 = 126 мм ≤ 194 мм.
  assert.match(css, /repeat\(3,40mm\)/);
});

/* ---------- 5) „Покажи още“ добавя, вместо да преизчертава ---------- */

test('Книги: „Покажи още“ чертае САМО новите 300 реда, не всичките 600', async () => {
  const dom = buildDom({ 'books.list': makeBooks(1200) });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#books';
  await window.route();
  await new Promise(r => setTimeout(r, 60));
  // Белег върху първия ред: ако той оцелее, редът НЕ е бил изчертан наново.
  const first = window.document.querySelector('#bBody tr');
  first.setAttribute('data-probe', 'жив');
  const sizes = [];
  const orig = window.booksRowsHtml;
  window.booksRowsHtml = function (part) { sizes.push(part.length); return orig.apply(this, arguments); };
  window.document.querySelector('#bMore button').click();
  window.booksRowsHtml = orig;
  assert.equal(window.document.querySelectorAll('#bBody tr').length, 600);
  assert.deepEqual(sizes, [300],
    'подава се само новата порция — презаписът на целия <tbody> е квадратичен: '
    + '49 натискания до 15 000 реда чертаеха 382 200 реда вместо 14 700');
  assert.equal(window.document.querySelector('#bBody tr').getAttribute('data-probe'), 'жив',
    'вече показаните редове не бива да се пресъздават');
});

test('Инвентарна книга: „Покажи още“ също добавя само новата порция', async () => {
  const dom = buildDom({ 'invBook.list': makeInvRows(1200) });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#invbook';
  await window.route();
  await new Promise(r => setTimeout(r, 60));
  const first = window.document.querySelector('#ibBody tr');
  first.setAttribute('data-probe', 'жив');
  const sizes = [];
  const orig = window.invBookRowsHtml;
  window.invBookRowsHtml = function (part) { sizes.push(part.length); return orig.apply(this, arguments); };
  window.document.querySelector('#ibMore button').click();
  window.invBookRowsHtml = orig;
  assert.equal(window.document.querySelectorAll('#ibBody tr').length, 600);
  assert.deepEqual(sizes, [300]);
  assert.equal(window.document.querySelector('#ibBody tr').getAttribute('data-probe'), 'жив');
});

test('Читатели: „Покажи още“ добавя само новата порция', async () => {
  const dom = buildDom({ 'readers.list': makeReaders(1200) });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#readers';
  await window.route();
  await new Promise(r => setTimeout(r, 60));
  const first = window.document.querySelector('#rBody tr');
  first.setAttribute('data-probe', 'жив');
  const sizes = [];
  const orig = window.readersRowsHtml;
  window.readersRowsHtml = function (part) { sizes.push(part.length); return orig.apply(this, arguments); };
  window.document.querySelector('#rMore button').click();
  window.readersRowsHtml = orig;
  assert.equal(window.document.querySelectorAll('#rBody tr').length, 600);
  assert.deepEqual(sizes, [300]);
  assert.equal(window.document.querySelector('#rBody tr').getAttribute('data-probe'), 'жив');
});

test('Търсенето и филтърът остават ПЪЛЕН рендер след „Покажи още“', async () => {
  const books = makeBooks(1200);
  books.forEach((b, i) => { if (i % 2) b.department = 'за деца'; });
  const dom = buildDom({ 'books.list': books });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#books';
  await window.route();
  await new Promise(r => setTimeout(r, 60));
  window.document.querySelector('#bMore button').click();
  assert.equal(window.document.querySelectorAll('#bBody tr').length, 600);
  const first = window.document.querySelector('#bBody tr');
  first.setAttribute('data-probe', 'жив');
  // Смяна на филтъра: наборът редове е ДРУГ — добавяне тук би долепило новите
  // редове към стария резултат.
  const sel = window.document.getElementById('bDeptFilter');
  sel.value = 'за деца';
  sel.dispatchEvent(new window.Event('change'));
  assert.equal(window.document.querySelectorAll('#bBody tr').length, 300,
    'филтърът се връща на първата страница от новия резултат');
  assert.equal(window.document.querySelector('#bBody tr').getAttribute('data-probe'), null,
    'при смяна на филтъра таблицата се преизчертава изцяло');
  const rows = [...window.document.querySelectorAll('#bBody tr td:nth-child(6)')].map(td => td.textContent);
  assert.ok(rows.every(x => x === 'за деца'), 'показват се само редовете от филтъра');
});

test('Груповият избор оцелява при „Покажи още“ — новите редове идват вече отметнати', async () => {
  const dom = buildDom({ 'books.list': makeBooks(1200) });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#books';
  await window.route();
  await new Promise(r => setTimeout(r, 60));
  window.toggleBookSelAll(true); // „Избери всички“ — и отвъд видимия прозорец
  window.document.querySelector('#bMore button').click();
  const boxes = [...window.document.querySelectorAll('#bBody .bkChk')];
  assert.equal(boxes.length, 600);
  assert.ok(boxes.every(b => b.checked), 'и новодобавените редове трябва да са отметнати');
  const chkAll = window.document.getElementById('chkAll');
  assert.equal(chkAll.checked, true, 'заглавната отметка следва реалния избор (syncChkAll)');
  assert.equal(chkAll.indeterminate, false);
});

/* ---------- 6) Общ помощник за прозоречен рендер ---------- */

test('paintRowWindow(): пълен рендер при painted=0, добавяне при вече изчертани редове', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.document.getElementById('view').innerHTML =
    '<table><tbody id="tb"></tbody></table><div id="bar"></div>';
  const rows = [];
  for (let i = 1; i <= 1000; i++) rows.push(i);
  const seen = [];
  const rowsHtml = (part) => { seen.push(part.length); return part.map(i => `<tr data-i="${i}"><td>${i}</td></tr>`).join(''); };
  const moreHtml = (more, total) => (more > 0 ? `<button>още ${more} от ${total}</button>` : '');
  let painted = window.paintRowWindow({ body: '#tb', bar: '#bar', rows, limit: 300, painted: 0, rowsHtml, moreHtml });
  assert.equal(painted, 300);
  assert.equal(window.document.querySelectorAll('#tb tr').length, 300);
  assert.match(window.document.getElementById('bar').innerHTML, /още 700 от 1000/);
  window.document.querySelector('#tb tr').setAttribute('data-probe', 'жив');
  painted = window.paintRowWindow({ body: '#tb', bar: '#bar', rows, limit: 600, painted, rowsHtml, moreHtml });
  assert.equal(painted, 600);
  assert.deepEqual(seen, [300, 300], 'втория път се подава само новата порция');
  assert.equal(window.document.querySelector('#tb tr').getAttribute('data-probe'), 'жив');
  // Ако броячът не отговаря на DOM-а (нов резултат в старото тяло), се чертае
  // всичко наново — иначе таблицата би показала смес от два набора.
  painted = window.paintRowWindow({ body: '#tb', bar: '#bar', rows, limit: 900, painted: 42, rowsHtml, moreHtml });
  assert.equal(painted, 900);
  assert.equal(window.document.querySelectorAll('#tb tr').length, 900);
  assert.equal(window.document.querySelector('#tb tr').getAttribute('data-probe'), null);
});

test('Одитната следа казва, че списъкът е скъсен на 500, вместо да се представя за пълен', async () => {
  const rows = [];
  for (let i = 1; i <= 500; i++) {
    rows.push({ id: i, ts: '2026-08-19T10:00:00.000Z', user: 'Библиотекар', action: 'Редакция',
      detail: 'Книга №' + i, diff: null });
  }
  const dom = buildDom({ 'audit.list': rows });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#odit';
  await window.route();
  await new Promise(r => setTimeout(r, 30));
  const cnt = window.document.getElementById('oditCount').textContent;
  assert.match(cnt, /последните 500/,
    'при точно толкова редове, колкото е таванът на audit:list, това трябва да се каже — '
    + 'иначе „500 записа“ се чете като целия брой записи в одитната следа');
});

/* ---------- 7) КДБФ: колоната „По вид“ ---------- */

const KDBF_REPORT = {
  year: 2026,
  part1: [{ id: 7, date: '2026-03-04', no: 1, from_source: 'Дарение от читател', how: 'дарение',
    doc_type: 'протокол', doc_no: '2', doc_date: '2026-03-01', total_count: 3, registered_count: 3,
    registered_value: 30, inv_from: 101, inv_to: 103 }],
  part3: [], stockEnd: { n: 3, v: 30 }, acquiredYear: { n: 3, v: 30 }, deaccYear: { n: 0, v: 0 }
};
const KDBF_ACQ = { id: 7, items: [{ category_name: 'книга' }, { category_name: 'книга' },
  { category_name: 'периодично издание' }] };

test('КДБФ Част № 1: колоната „По вид“ показва разбивка по видове документи', async () => {
  const dom = buildDom({ 'kdbf.report': KDBF_REPORT, 'acquisitions.get': KDBF_ACQ });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#kdbf';
  await window.route();
  await new Promise(r => setTimeout(r, 30));
  /* Одит v2.4.17: Част № 1 вече има и ред ОБЩО, затова „последната клетка на
     таблицата" вече не е колоната „По вид" на партидата, а празната клетка на
     сбора. Взима се последната клетка на ПЪРВИЯ ред с данни — това е колоната,
     за която е тестът. */
  const firstRow = window.document.querySelector('.ledger tbody tr');
  const last = firstRow.querySelector('td:last-child').textContent;
  assert.match(last, /книга: 2/, 'разбивката се изисква от чл. 13, ал. 3, т. 1 и данните за нея ги има');
  assert.match(last, /периодично издание: 1/);
});

test('КДБФ: разпечатката съдържа колоната „По вид“, а не само екранът', async () => {
  const dom = buildDom({ 'kdbf.report': KDBF_REPORT, 'acquisitions.get': KDBF_ACQ });
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#kdbf';
  await window.route();
  await new Promise(r => setTimeout(r, 30));
  window.printKdbfDoc();
  const html = window.document.getElementById('ppSheet').innerHTML;
  assert.match(html, /По вид/, 'в печатната Част № 1 колоната изобщо липсваше');
  assert.match(html, /книга: 2/);
  assert.match(html, /периодично издание: 1/);
});
