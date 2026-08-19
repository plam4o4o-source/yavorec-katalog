'use strict';
/* Тестове за двете поправки от v2.3.1.

   1) ОГРАНИЧЕНИЕ НА ИЗЧЕРТАВАНИТЕ РЕДОВЕ В РАСТЯЩИТЕ СПИСЪЦИ.
      Прозоречният рендер (paintRowWindow/RENDER_PAGE_SIZE в core.js, v2.3.0)
      имаха само „Книги“, „Читатели“ и „Инвентарна книга“. Останалите изгледи
      чертаеха ВСИЧКИ редове наведнъж. Тук се покриват петте, при които списъкът
      реално расте с времето:

        „Просрочени“      — расте най-бързо и по нищо не се ограничава сам;
                            измерено 1 200 реда / 513 КБ, след поправката
                            300 реда / 129 КБ;
        „Аналитично описание“ — краеведският масив само се допълва;
                            4 000 / 2 275 КБ → 300 / 170 КБ;
        „Летопис“         — записано събитие остава завинаги;
                            3 000 / 3 141 КБ → 300 / 324 КБ;
        „Персоналии“      — картотека, от която не се изважда;
                            1 500 / 917 КБ → 300 / 183 КБ;
        „Постъпления“     — КДБФ част 1 е регистър: вписаното остава;
                            800 / 319 КБ → 300 / 120 КБ.

      Изрично НЕ се пипат екраните, които по устройство не могат да пораснат —
      излишният бутон „Покажи още“ там е влошаване, не подобрение. Последният
      тест в този файл пази точно това решение.

   2) ЕТИКЕТИТЕ СЕ СГЛОБЯВАХА, ПРЕДИ БИБЛИОТЕКАРЯТ ДА Е ПОТВЪРДИЛ.
      printLabelsAll() и съседните ѝ функции строяха целия HTML низ с
      rows.map(...).join('') и ЧАК ТОГАВА стигаха до потвърждението вътре в
      printLabelSheet() (confirmManyLabels, v2.3.0). При 14 750 етикета това са
      1–2 s и десетки мегабайта, изхабени преди въпроса — и напълно напразно,
      ако отговорът е „не“. */
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

/* Същият „безопасен“ Proxy като в останалите тестове за изгледите: държи се като
   празен списък, празен низ и нула, за да мине реалният код на изгледите докрай. */
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
/* Брои извикванията по endpoint (callCounts) — „Покажи още“ не бива да праща
   ново IPC извикване; данните вече са в паметта. Стойността може да е и функция
   (dynamic), за да върне различен резултат при второто извикване (търсене). */
function apiMock(overrides, callCounts) {
  function makeNode(parts) {
    const key = parts.join('.');
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeNode(parts.concat(prop));
      },
      apply(t, self, args) {
        callCounts[key] = (callCounts[key] || 0) + 1;
        const has = Object.prototype.hasOwnProperty.call(overrides, key);
        const v = has ? overrides[key] : safeDefault();
        const data = typeof v === 'function' ? v(args, callCounts[key]) : v;
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
  dom.confirms = [];
  dom.confirmAnswer = true;
  const { window } = dom;
  window.api = apiMock(overrides || {}, dom.callCounts);
  window.confirm = (msg) => { dom.confirms.push(String(msg)); return dom.confirmAnswer; };
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
/* mny() е const в core.js — лексикална глобална, която не стои върху window,
   затова се вика през window.eval() в собствения обхват на документа. */
function mny(window, n) { return window.eval('mny(' + n + ')'); }
async function settled() {
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
}
async function openView(dom, hash) {
  const { window } = dom;
  await settled();
  window.location.hash = '#' + hash;
  await window.route();
  // location.hash праща и hashchange, който bootstrap.js хваща и рутира ВТОРИ
  // път — асинхронно, малко след явния route() тук. Изчаква се, за да не мърда
  // броячът по средата на теста по причина извън самата поправка.
  await new Promise(r => setTimeout(r, 60));
  return window;
}
/* Разгръща списъка докрай през самия бутон и връща колко натискания е отнело. */
function expandAll(window, barSel) {
  let clicks = 0;
  for (;;) {
    const btn = window.document.querySelector(barSel + ' button');
    if (!btn || clicks > 200) return clicks;
    btn.click();
    clicks++;
  }
}
/* Ключът на реда — по него се проверява, че на границата на порцията няма нито
   дублиран, нито пропуснат ред. */
function keysOf(window, sel, read) {
  return Array.from(window.document.querySelectorAll(sel)).map(read);
}
function assertNoGapsNoDupes(keys, expected, what) {
  assert.equal(keys.length, expected.length, what + ': броят редове не съвпада');
  assert.equal(new Set(keys).size, keys.length, what + ': има дублиран ред на границата на порцията');
  assert.deepEqual(keys, expected, what + ': редът или съдържанието се разминават с пълния списък');
}

/* ---------------- реалистични данни ---------------- */
const R = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
const DAY = i => '20' + String(10 + (i % 15)).padStart(2, '0') + '-0' + (1 + i % 9) + '-1' + (i % 9);

const makeOverdue = n => R(n, i => ({
  id: i, reader_name: 'Читател №' + i, inv_number: 1000 + i, title: 'Заглавие №' + i,
  date_due: DAY(i), daysLate: 3 + (i % 400), fine: 0.1 * (3 + (i % 400))
}));
const makeAnalytics = n => R(n, i => ({
  id: i, title: 'Статия №' + i, author: 'Автор ' + i, is_local: i % 3 === 0 ? 1 : 0,
  year: String(1960 + (i % 65)), pages: String(i), source_kind: 'друго', source_text: 'Източник ' + i
}));
/* Годините вървят низходящо и на групи по 40 — точно както ги връща
   chronicle:list (ORDER BY year DESC). При порция от 300 това значи, че всяка
   порция реже някоя година по средата: точно случаят, при който старото
   групиране по <div class="chrYear"> би повторило заглавието на годината. */
const makeChronicle = n => R(n, i => ({
  id: i, year: String(2025 - Math.floor((i - 1) / 40)), date: DAY(i),
  title: 'Събитие №' + i, category: 'читалище', body: 'Описание ' + i, links: 0
}));
const makePersons = n => R(n, i => ({
  id: i, name: 'Иванов, Петър ' + i, birth_date: DAY(i), death_date: '',
  activity: 'учител и краевед', links: 0, photo: ''
}));
const makeAcq = n => R(n, i => ({
  id: i, no: i, year: '2020', date: DAY(i), from_source: 'Дарител ' + i, how: 'дарение',
  doc_type: 'фактура', doc_no: String(i), total_count: 20, registered_count: 20, registered_value: 100
}));
const makeAudit = n => R(n, i => ({
  id: i, ts: 1700000000000 + i * 1000, user: 'Библиотекар', action: 'редакция',
  detail: 'Книга инв. № ' + i, diff: null
}));

const PAGE = 300; // RENDER_PAGE_SIZE в core.js

/* ================= 1а) „Просрочени“ ================= */

test('Просрочени: изчертава прозорец от 300 реда, не всичките 1 200', async () => {
  const dom = buildDom({ 'loans.overdue': makeOverdue(1200) });
  const window = await openView(dom, 'over');
  assert.equal(window.document.querySelectorAll('#ovBody tr').length, PAGE,
    'при 1 200 просрочени се изчертават 1 200 реда с по два бутона всеки — точно това ограничава поправката');
  const btn = window.document.querySelector('#ovMore button');
  assert.ok(btn, 'трябва да има бутон „Покажи още“, щом има още редове');
  assert.match(btn.textContent, /900 от общо 1\s*200|900 от общо 1200/);
});

test('Просрочени: броячът казва „показани са N от M“, а не само общия брой', async () => {
  const dom = buildDom({ 'loans.overdue': makeOverdue(1200) });
  const window = await openView(dom, 'over');
  const bar = window.document.getElementById('ovMore');
  assert.match(bar.textContent, /Показани са 300 от 1200/,
    'скъсен списък, който изглежда пълен, е по-лош от дълъг — броячът трябва да казва истината');
  // И след разгръщането броячът трябва да е верен, а не да е останал от преди.
  window.document.querySelector('#ovMore button').click();
  assert.match(window.document.getElementById('ovMore').textContent, /Показани са 600 от 1200/);
});

test('Просрочени: „Покажи още“ разгръща без нито едно ново IPC извикване и без дублирани редове', async () => {
  const rows = makeOverdue(1200);
  const dom = buildDom({ 'loans.overdue': rows });
  const window = await openView(dom, 'over');
  const before = dom.callCounts['loans.overdue'];
  const clicks = expandAll(window, '#ovMore');
  assert.equal(clicks, 3, '1 200 реда при порция 300 = точно три натискания');
  assert.equal(dom.callCounts['loans.overdue'], before,
    'редовете вече са в паметта — разгръщането не бива да ги тегли наново по IPC');
  assertNoGapsNoDupes(
    keysOf(window, '#ovBody tr', tr => tr.cells[0].textContent),
    rows.map(r => r.reader_name), 'Просрочени');
  assert.match(window.document.getElementById('ovMore').textContent, /Показани са 1200 от 1200/);
  assert.equal(window.document.querySelector('#ovMore button'), null,
    'няма какво повече да се показва — бутонът трябва да изчезне');
});

test('Просрочени: сумата „общо дължимо“ е по ЦЕЛИЯ списък, не по видимата порция', async () => {
  const rows = makeOverdue(1200);
  const total = rows.reduce((s, l) => s + l.fine, 0);
  const dom = buildDom({ 'loans.overdue': rows });
  const window = await openView(dom, 'over');
  // Това е сумата, която библиотеката има да събира — тя не зависи от това
  // колко реда са изчертани. Прозоречният рендер не бива да я подменя.
  const shown = window.document.querySelector('.note.w').textContent;
  assert.ok(shown.includes(mny(window, total)),
    'сумата в бележката по чл. 43, ал. 2 трябва да е за всичките 1 200 просрочени: ' + shown);
});

test('Просрочени: изгледът НЕ смята дни и обезщетение — взима готовите от loans:overdue', async () => {
  // Пази поправката от v2.3.0 да не се загуби при пренаписването на редовете.
  const rows = makeOverdue(400);
  rows[0].daysLate = 17; rows[0].fine = 3.4;
  const dom = buildDom({ 'loans.overdue': rows });
  const window = await openView(dom, 'over');
  const cells = window.document.querySelectorAll('#ovBody tr')[0].cells;
  assert.equal(cells[4].textContent.trim(), '17');
  assert.equal(cells[5].textContent.trim(), mny(window, 3.4));
});

/* ================= 1б) „Аналитично описание“ ================= */

test('Аналитично описание: прозорец от 300 реда при 4 000 описания', async () => {
  const dom = buildDom({ 'analytics.list': makeAnalytics(4000), 'analytics.years': [] });
  const window = await openView(dom, 'analytics');
  assert.equal(window.document.querySelectorAll('#anlBody tr').length, PAGE);
  assert.match(window.document.getElementById('anlMore').textContent, /Показани са 300 от 4000/);
});

test('Аналитично описание: броячите горе продължават да броят ЦЕЛИЯ резултат', async () => {
  // kpi-тата отговарят на въпроса „колко описания имам“, не „колко виждам“ —
  // ако тръгнат да броят порцията, краеведът ще реши, че масивът му се е стопил.
  const rows = makeAnalytics(4000);
  const local = rows.filter(r => r.is_local).length;
  const dom = buildDom({ 'analytics.list': rows, 'analytics.years': [] });
  const window = await openView(dom, 'analytics');
  const kpis = window.document.querySelector('#anlList .kpis').textContent;
  assert.match(kpis, /4000/, 'общият брой описания е по целия резултат');
  assert.match(kpis, new RegExp(String(local)), 'и краеведските също');
});

test('Аналитично описание: „Покажи още“ разгръща без ново IPC и без пропуснат ред', async () => {
  const rows = makeAnalytics(1000);
  const dom = buildDom({ 'analytics.list': rows, 'analytics.years': [] });
  const window = await openView(dom, 'analytics');
  const before = dom.callCounts['analytics.list'];
  assert.equal(expandAll(window, '#anlMore'), 3, '1 000 реда при порция 300 = три натискания');
  assert.equal(dom.callCounts['analytics.list'], before, 'без ново analytics.list извикване');
  assertNoGapsNoDupes(
    keysOf(window, '#anlBody tr', tr => tr.cells[0].textContent.trim().split('\n')[0]),
    rows.map(r => r.title), 'Аналитично описание');
});

test('Аналитично описание: търсенето е ПЪЛЕН рендер и започва пак от първата порция', async () => {
  // Другият набор редове не бива да се долепя към стария: иначе таблицата
  // показва смес от два различни резултата и не отговаря на нищо.
  const many = makeAnalytics(1000);
  const few = makeAnalytics(5).map(r => Object.assign({}, r, { title: 'Търсено ' + r.id }));
  const dom = buildDom({
    // Ключът е самото търсене, а не поредността: openView изчаква и повторното
    // рутиране от hashchange, тоест първоначалният рендер минава два пъти.
    'analytics.list': (args) => ((args[0] || {}).q ? few : many),
    'analytics.years': []
  });
  const window = await openView(dom, 'analytics');
  expandAll(window, '#anlMore'); // разгърнато докрай — 1 000 реда стоят изчертани
  assert.equal(window.document.querySelectorAll('#anlBody tr').length, 1000);
  const input = window.document.getElementById('anlQ');
  input.value = 'търсено';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const rows = window.document.querySelectorAll('#anlBody tr');
  assert.equal(rows.length, 5, 'резултатът от търсенето е нов набор — старите редове не бива да останат');
  assert.match(rows[0].textContent, /Търсено/);
  assert.match(window.document.getElementById('anlMore').textContent, /Показани са 5 от 5/);
});

/* ================= 1в) „Летопис“ ================= */

test('Летопис: прозорец от 300 записа при 3 000', async () => {
  const dom = buildDom({ 'chronicle.list': makeChronicle(3000), 'chronicle.years': [] });
  const window = await openView(dom, 'chronicle');
  assert.equal(window.document.querySelectorAll('#chrItems .chrItem').length, PAGE);
  assert.match(window.document.getElementById('chrMore').textContent, /Показани са 300 от 3000/);
});

test('Летопис: заглавието на годината не се повтаря на границата на порцията', async () => {
  /* Тук е капанът на този екран: годините идват на групи по 40, тоест порцията
     от 300 реже 7,5-ата година по средата. При старото гнездене (група <div
     class="chrYear"> на година) следващата порция или щеше да повтори заглавието
     „2018“, или да залепи записите в чужда група. */
  const rows = makeChronicle(3000);
  const dom = buildDom({ 'chronicle.list': rows, 'chronicle.years': [] });
  const window = await openView(dom, 'chronicle');
  expandAll(window, '#chrMore');
  const heads = keysOf(window, '#chrItems .chrYearHead', el => el.textContent.trim());
  const years = [...new Set(rows.map(r => String(r.year)))];
  assert.deepEqual(heads, years,
    'всяка година трябва да има ТОЧНО едно заглавие, в същия ред както преди');
  assertNoGapsNoDupes(
    keysOf(window, '#chrItems .chrItem', el => el.getAttribute('aria-label')),
    rows.map(r => r.title), 'Летопис');
});

test('Летопис: „Покажи още“ разгръща без ново IPC извикване', async () => {
  const dom = buildDom({ 'chronicle.list': makeChronicle(900), 'chronicle.years': [] });
  const window = await openView(dom, 'chronicle');
  const before = dom.callCounts['chronicle.list'];
  assert.equal(expandAll(window, '#chrMore'), 2);
  assert.equal(dom.callCounts['chronicle.list'], before, 'без ново chronicle.list извикване');
  assert.equal(window.document.querySelectorAll('#chrItems .chrItem').length, 900);
});

/* ================= 1г) „Персоналии“ ================= */

test('Персоналии: прозорец от 300 карти при 1 500', async () => {
  const dom = buildDom({ 'persons.list': makePersons(1500) });
  const window = await openView(dom, 'persons');
  assert.equal(window.document.querySelectorAll('#prsGrid .prsCard').length, PAGE,
    'всяка карта носи и <img> — 1 500 наведнъж значат и 1 500 четения от диска');
  assert.match(window.document.getElementById('prsMore').textContent, /Показани са 300 от 1500/);
});

test('Персоналии: разгръщането не дублира и не пропуска карти', async () => {
  const rows = makePersons(1500);
  const dom = buildDom({ 'persons.list': rows });
  const window = await openView(dom, 'persons');
  const before = dom.callCounts['persons.list'];
  assert.equal(expandAll(window, '#prsMore'), 4);
  assert.equal(dom.callCounts['persons.list'], before, 'без ново persons.list извикване');
  assertNoGapsNoDupes(
    keysOf(window, '#prsGrid .prsCard', el => el.getAttribute('aria-label')),
    rows.map(r => r.name), 'Персоналии');
});

/* ================= 1д) „Постъпления“ ================= */

test('Постъпления: прозорец от 300 партиди при 800', async () => {
  const rows = makeAcq(800);
  const dom = buildDom({ 'acquisitions.list': rows });
  const window = await openView(dom, 'acq');
  assert.equal(window.document.querySelectorAll('#acqBody tr').length, PAGE);
  assert.match(window.document.getElementById('acqMore').textContent, /Показани са 300 от 800/);
  const before = dom.callCounts['acquisitions.list'];
  assert.equal(expandAll(window, '#acqMore'), 2);
  assert.equal(dom.callCounts['acquisitions.list'], before, 'без ново acquisitions.list извикване');
  assertNoGapsNoDupes(
    keysOf(window, '#acqBody tr', tr => tr.cells[0].textContent.trim()),
    rows.map(r => r.no + ' / ' + r.year), 'Постъпления');
});

/* ================= 1е) Празният случай не бива да се счупи ================= */

test('Растящите списъци показват празното си състояние, а не празна таблица с брояч', async () => {
  const cases = [
    ['analytics', { 'analytics.list': [], 'analytics.years': [] }, 'Няма описани статии'],
    ['chronicle', { 'chronicle.list': [], 'chronicle.years': [] }, 'Летописът е празен'],
    ['persons', { 'persons.list': [] }, 'Няма вписани персоналии'],
    ['acq', { 'acquisitions.list': [] }, 'Няма заведени партиди'],
    ['over', { 'loans.overdue': [] }, 'Няма просрочени заемания']
  ];
  for (const [hash, api, text] of cases) {
    const dom = buildDom(api);
    const window = await openView(dom, hash);
    assert.match(window.document.getElementById('view').textContent, new RegExp(text),
      hash + ': празният списък трябва да казва това с думи');
  }
});

/* ================= 1ж) Кои екрани НЕ се пипат и защо ================= */

test('Екрани, които по устройство не растат, остават БЕЗ „Покажи още“', () => {
  /* Излишният бутон е влошаване: библиотекарят търси нещо, което го няма отвъд
     порцията, и вместо списък получава задача. Затова прозоречният рендер
     СЪЗНАТЕЛНО не се слага там, където броят редове е ограничен по устройство:

       holds.js      — holds:list връща само АКТИВНИТЕ резервации (status IN
                       ('чака','заделена')); приключилите излизат от списъка,
                       тоест той не расте, а се върти;
       loans.js      — заемането показва документите на ЕДИН читател, а броят им
                       е ограничен от max_books в правилата за заемане;
       periodicals.js— списъкът е от ЗАГЛАВИЯ на периодични издания (десетки),
                       а не от броеве; броевете са число в колона;
       mzs.js        — междубиблиотечното заемане е рядка операция (единици
                       годишно), а списъкът е плосък регистър без подробности;
       deaccession-acts.js — един акт отчислява десетки документи наведнъж,
                       затова самите актове са малцина;
       audit.js      — audit:list е с ORDER BY id DESC LIMIT 500 в самия SQL,
                       тоест таванът вече съществува и е по-нисък от порцията,
                       която би добавил бутонът. */
  const noWindow = ['holds.js', 'loans.js', 'periodicals.js', 'mzs.js', 'deaccession-acts.js', 'audit.js'];
  for (const f of noWindow) {
    const src = fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8');
    assert.doesNotMatch(src, /paintRowWindow|Покажи още/, f + ': този екран не расте — не му трябва прозоречен рендер');
  }
});

test('Одитната следа: 500-те реда се рисуват наведнъж, но броячът казва, че списъкът е скъсен', async () => {
  /* Проверката, поискана от одита: LIMIT 500 в SQL прави екрана ограничен по
     устройство (500 реда / 245 КБ измерено — под цената на един прозорец от 300
     реда в „Летопис“), затова остава без „Покажи още“. Единственото, което
     трябва да е вярно, е броячът: при точно 500 реда той не бива да звучи като
     целия брой записи в одитната следа. */
  const dom = buildDom({ 'audit.list': makeAudit(500) });
  const window = await openView(dom, 'odit');
  assert.equal(window.document.querySelectorAll('#oditBody tr').length, 500);
  assert.match(window.document.getElementById('oditCount').textContent, /последните 500/);
  const dom2 = buildDom({ 'audit.list': makeAudit(37) });
  const w2 = await openView(dom2, 'odit');
  assert.match(w2.document.getElementById('oditCount').textContent, /37 записа/);
});

/* ================= 2) Етикетите се сглобяват СЛЕД потвърждението ================= */

const LABEL_SETTINGS = {
  lib_name: 'Библиотека при НЧ', place: 'с. Яворец',
  lbl_mode: 'sheet', lbl_cols: 3, lbl_gap: 3, lbl_margin: 8,
  lbl_w: 40, lbl_h: 30, sig_w: 25, sig_h: 35, card_w: 90, card_h: 60
};
const makeBooks = n => R(n, i => ({
  id: i, inv_number: i, barcode: String(i), title: 'Заглавие №' + i, author: 'Вазов, Иван',
  call_number: 'Ч-' + i, status: 'наличен', quantity: 1, available: 1
}));
const makeReaders = n => R(n, i => ({
  id: i, name: 'Читател №' + i, card_no: 'K' + i, category: 'възрастен', status: 'активен'
}));

/* Брои колко етикета са сглобени и запомня броя в мига на въпроса. */
function countCards(window, name) {
  const state = { calls: 0, atConfirm: -1 };
  const orig = window[name];
  window[name] = function (...a) { state.calls++; return orig.apply(this, a); };
  const origConfirm = window.confirm;
  window.confirm = (msg) => { state.atConfirm = state.calls; return origConfirm(msg); };
  return state;
}

test('Етикети за целия фонд: нито един етикет не се сглобява преди въпроса', async () => {
  const dom = buildDom({ 'books.list': makeBooks(600), 'settings.get': LABEL_SETTINGS });
  const { window } = dom;
  await settled();
  const st = countCards(window, 'lblCard');
  dom.confirmAnswer = false;
  await window.printLabelsAll();
  await settled();
  assert.equal(dom.confirms.length, 1, '600 етикета над прага трябва да питат веднъж');
  assert.equal(st.atConfirm, 0,
    'въпросът трябва да е ПРЕДИ сглобяването — при 14 750 етикета това е 1–2 s чакане преди „да“');
  assert.equal(st.calls, 0,
    'при отказ низът изобщо не бива да се строи — иначе времето и паметта отиват на вятъра');
});

test('Етикети за целия фонд: при съгласие низът се сглобява и се стига до печат', async () => {
  const dom = buildDom({ 'books.list': makeBooks(600), 'settings.get': LABEL_SETTINGS });
  const { window } = dom;
  await settled();
  const st = countCards(window, 'lblCard');
  dom.confirmAnswer = true;
  await window.printLabelsAll();
  await settled();
  assert.equal(st.atConfirm, 0, 'пак първо въпросът');
  assert.equal(st.calls, 600, 'а след съгласието — всичките 600 етикета');
  assert.match(window.document.getElementById('ppSheet').innerHTML, /lblsheet/);
  assert.equal((window.document.getElementById('ppSheet').innerHTML.match(/<div class="lbl[ "]/g) || []).length, 600);
});

test('Етикети със сигнатура и читателски карти минават по същия ред', async () => {
  for (const [fn, name, api] of [
    ['printSignatureLabelsAll', 'sigLblCard', { 'books.list': makeBooks(600) }],
    ['printCardsAll', 'readerCardHtml', { 'readers.list': makeReaders(600) }]
  ]) {
    const dom = buildDom(Object.assign({ 'settings.get': LABEL_SETTINGS }, api));
    const { window } = dom;
    await settled();
    const st = countCards(window, name);
    dom.confirmAnswer = false;
    await window[fn]();
    await settled();
    assert.equal(dom.confirms.length, 1, fn + ': трябва да пита');
    assert.equal(st.calls, 0, fn + ': при отказ нищо не се сглобява');
  }
});

test('Под прага печатът минава без въпрос и без промяна в резултата', async () => {
  const dom = buildDom({ 'books.list': makeBooks(24), 'settings.get': LABEL_SETTINGS });
  const { window } = dom;
  await settled();
  await window.printLabelsAll();
  await settled();
  assert.equal(dom.confirms.length, 0, '24 етикета са обичайна работа — без въпроси');
  assert.equal((window.document.getElementById('ppSheet').innerHTML.match(/<div class="lbl[ "]/g) || []).length, 24);
});

test('printLabelSheet приема и готов HTML низ — старите извиквания не се чупят', async () => {
  // Единичната читателска карта (printCardOne) няма какво да спестява и остава
  // на стария вид; всички печатни пътища извън logo-org.js също.
  const dom = buildDom({ 'readers.get': makeReaders(1)[0], 'settings.get': LABEL_SETTINGS });
  const { window } = dom;
  await settled();
  await window.printCardOne(1);
  await settled();
  assert.equal(dom.confirms.length, 0);
  assert.equal((window.document.getElementById('ppSheet').innerHTML.match(/<div class="lbl[ "]/g) || []).length, 1);
});

/* --- Дребните находки от адверсариалния преглед на v2.3.1 --- */

test('празният регистър на постъпленията не казва „Показани са 0 от 0 партиди."', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'acquisitions.js'), 'utf8');
  const fn = src.slice(src.indexOf('function acqMoreHtml'), src.indexOf('function paintAcqRows'));
  assert.match(fn, /if\s*\(!total\)\s*return\s*''/,
    'таблицата вече казва „Няма заведени партиди." — втори надпис за същото звучи като повреда');
});

test('„Приеми"/„Продължи" НЕ свива разгърнатия списък с просрочени', () => {
  const over = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'overdue.js'), 'utf8');
  assert.match(over, /async function renderOver\(keepWindow\)/,
    'пречертаването след приемане трябва да може да запази прозореца');
  assert.match(over, /if \(!keepWindow\) OVER_RENDER_LIMIT/);
  for (const f of ['loans.js', 'housebound.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', f), 'utf8');
    assert.match(src, /renderOver\(true\)/,
      f + ' вика renderOver след приемане — при над 300 просрочени библиотекарят иначе ' +
      'разгръща наново след ВСЯКО върнато копие');
  }
});

test('влизането в раздела от менюто пак започва от първата порция', () => {
  const over = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'overdue.js'), 'utf8');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'bootstrap.js'), 'utf8');
  assert.match(boot, /over:\s*renderOver\b/, 'рутерът вика renderOver БЕЗ аргумент');
  assert.doesNotMatch(boot, /over:\s*\(\)\s*=>\s*renderOver\(true\)/);
  assert.match(over, /OVER_RENDER_LIMIT > rows\.length/,
    'скъсен списък не бива да оставя прозорец, който обещава несъществуващи редове');
});
