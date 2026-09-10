'use strict';
/* v2.4.50 — тридесет и осми кръг: графични поправки по поръчка на библиотеката.
   =====================================================================
   Шест неща, всяко измерено в истински Chromium преди и след поправката (числата
   стоят в CHANGELOG):

   1) действията на реда — шест копчета по 24 px станаха три по 32 px, а
      останалите се събраха в меню „⋯“;
   2) групите в лявата лента се сгъват и състоянието се помни;
   4) копчетата и полетата за избор вече са с шрифта на програмата (измерено:
      72 елемента с Arial срещу 186 със Segoe UI преди поправката, 0 след нея);
   5) основното копче („+ Нова книга“ / „+ Нов читател“) стои веднага след
      търсенето и в двата регистъра;
   6) еврото в паричните клетки и надписите за състояние вече не са 10,5 / 11 px;
   7) при смяна на раздел мястото за съдържание се изчиства ВЕДНАГА и казва
      наяве, когато данните не са дошли.

   Всеки тест тук е проверен с мутация: върнат ли се поправките една по една,
   съответният тест пада. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, buildDom, settle } = require('./helpers/audit-fixtures');

const CSS = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
const view = (f) => fs.readFileSync(path.join(APP_DIR, 'src', 'views', f), 'utf8');

const READERS = [
  { id: 1, name: 'Иванов, Иван', card_no: '1', category: 'възрастен', status: 'активен', open_loans: 0, overdue_loans: 0 },
  { id: 2, name: 'Петров, Петър', card_no: '2', category: 'дете', status: 'активен', open_loans: 0, overdue_loans: 0 }
];
const READER_DEPS = { 'readers.list': READERS, 'searchHistory.suggest': [] };

/* ============================ 1) меню „⋯“ на реда ============================ */

test('Читатели: на реда остават три копчета, останалите са в менюто „⋯“', async () => {
  const dom = buildDom(READER_DEPS);
  const { window } = dom; await settle();
  await window.renderReaders(); await settle();
  const d = window.document;
  const acts = d.querySelector('#rBody tr .rowActs');
  const onRow = [...acts.children].filter(el => el.tagName === 'BUTTON');
  assert.deepEqual(onRow.map(b => b.textContent.trim()), ['Заемане', 'Редакция', '⋯']);
  /* Всяко скрито действие пази СВОЯ onclick — менюто само копира готовия HTML,
     не пресъздава действията, тоест разделът си остава единственото място, което
     знае какво прави всяко копче. */
  const more = acts.querySelector('.rowMoreItems');
  assert.deepEqual([...more.querySelectorAll('button')].map(b => b.getAttribute('onclick')),
    ['printReaderCard(1)', 'printCardOne(1)', 'accountModal(1)', 'deleteReader(1)']);
});

test('Фонд: червеното „Изтрий“ слиза от реда в менюто „⋯“', async () => {
  const dom = buildDom({ 'books.list': [{ id: 4, inv_number: '10', title: 'Под игото', author: 'Вазов',
    status: 'наличен', available: 1, quantity: 1 }], 'categories.list': [], 'searchHistory.suggest': [], 'shelves.list': [] });
  const { window } = dom; await settle();
  await window.renderBooks(); await settle();
  const d = window.document;
  const acts = d.querySelector('#bBody tr .rowActs');
  assert.ok(acts, 'редът има .rowActs');
  const onRow = [...acts.children].filter(el => el.tagName === 'BUTTON');
  assert.deepEqual(onRow.map(b => b.textContent.trim()), ['⋯'], 'на самия ред стои само „⋯“');
  assert.equal(onRow[0].classList.contains('dgr'), false, 'копчето на реда не е червено');
  const del = acts.querySelector('.rowMoreItems .btn.dgr');
  assert.equal(del.getAttribute('onclick'), 'deleteBook(4)', 'изтриването е в менюто и е същото действие');
  assert.equal(d.querySelectorAll('#bBody tr > td .btn.dgr:not(.rowMoreItems .btn.dgr)').length, 0);
});

test('rowMenu(): отваря, затваря се при второ натискане, при Esc и при щракване встрани', async () => {
  const dom = buildDom(READER_DEPS);
  const { window } = dom; await settle();
  await window.renderReaders(); await settle();
  const d = window.document;
  const pop = d.getElementById('rowMenuPop');
  assert.ok(pop, 'общото изскачащо меню стои в index.html');
  const btns = [...d.querySelectorAll('#rBody .rowMore')];
  assert.equal(btns.length, 2);

  window.rowMenu(btns[0]);
  assert.ok(pop.classList.contains('on'));
  assert.equal(btns[0].getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...pop.querySelectorAll('button')].map(b => b.textContent.trim()),
    ['Картон', 'Читателска карта', 'Сметка', 'Изтрий']);

  // второ натискане по СЪЩОТО копче затваря
  window.rowMenu(btns[0]);
  assert.equal(pop.classList.contains('on'), false);
  assert.equal(btns[0].getAttribute('aria-expanded'), 'false');
  assert.equal(pop.innerHTML, '', 'съдържанието не остава да виси');

  // натискане по ДРУГО копче пренарежда менюто към другия ред
  window.rowMenu(btns[0]);
  window.rowMenu(btns[1]);
  assert.ok(pop.classList.contains('on'));
  assert.equal(btns[0].getAttribute('aria-expanded'), 'false', 'старото копче се отбелязва като затворено');
  assert.equal(pop.querySelector('.btn.dgr').getAttribute('onclick'), 'deleteReader(2)', 'менюто е на втория ред');

  // Esc затваря
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(pop.classList.contains('on'), false);

  // щракване встрани затваря
  window.rowMenu(btns[1]);
  d.getElementById('vTitle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(pop.classList.contains('on'), false);
});

test('менюто на реда се обявява като меню и се обхожда със стрелки', async () => {
  const dom = buildDom(READER_DEPS);
  const { window } = dom; await settle();
  await window.renderReaders(); await settle();
  const d = window.document, pop = d.getElementById('rowMenuPop');
  window.rowMenu(d.querySelector('#rBody .rowMore'));
  /* role="menu" на кутията без role="menuitem" по редовете кара четеца да
     съобщи „меню, 0 елемента“ — затова ролите се слагат при копирането. */
  assert.deepEqual([...pop.querySelectorAll('button')].map(b => b.getAttribute('role')),
    ['menuitem', 'menuitem', 'menuitem', 'menuitem']);
  const key = (k) => d.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const тук = () => d.activeElement.textContent.trim();
  assert.equal(тук(), 'Картон', 'първият ред получава фокуса при отваряне');
  key('ArrowDown'); assert.equal(тук(), 'Читателска карта');
  key('End'); assert.equal(тук(), 'Изтрий');
  key('ArrowDown'); assert.equal(тук(), 'Картон', 'от последния надолу се минава в началото');
  key('ArrowUp'); assert.equal(тук(), 'Изтрий');
  key('Home'); assert.equal(тук(), 'Картон');
});

test('менюто се затваря, когато фокусът излезе от него', async () => {
  const dom = buildDom(READER_DEPS);
  const { window } = dom; await settle();
  await window.renderReaders(); await settle();
  const d = window.document, pop = d.getElementById('rowMenuPop');
  const btn = d.querySelector('#rBody .rowMore');
  window.rowMenu(btn);
  assert.ok(pop.classList.contains('on'));
  /* Tab след последния ред оставя фокуса върху <body>: focusin изобщо не се
     обажда (проверено в Chromium), затова се слуша focusout с relatedTarget. */
  const item = pop.querySelector('button');
  item.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  assert.equal(pop.classList.contains('on'), false, 'иначе менюто виси отворено насред страницата');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');

  // движение ВЪТРЕ в менюто не го затваря
  window.rowMenu(btn);
  const items = [...pop.querySelectorAll('button')];
  items[0].dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: items[1] }));
  assert.equal(pop.classList.contains('on'), true);
});

test('менюто се затваря при превъртане на вътрешна кутия и при преоразмеряване', async () => {
  const dom = buildDom(READER_DEPS);
  const { window } = dom; await settle();
  await window.renderReaders(); await settle();
  const d = window.document, pop = d.getElementById('rowMenuPop');
  const btn = d.querySelector('#rBody .rowMore');

  /* „scroll“ на .wrap НЕ се качва нагоре по дървото — хваща се само при
     прихващане (третият параметър true). Без него менюто оставаше на фиксираното
     си място, а редът под него си отиваше. */
  window.rowMenu(btn);
  d.querySelector('#view .wrap').dispatchEvent(new window.Event('scroll'));
  assert.equal(pop.classList.contains('on'), false);

  window.rowMenu(btn);
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(pop.classList.contains('on'), false);
});

test('червеното „Изтрий“ в менюто е с ЧЕРВЕНИ БУКВИ, не бяло върху светло', () => {
  /* Открито върху снимка на екрана, не от тест: „.rowMenuPop .btn“ маха червения
     ФОН на „.btn.dgr“ (еднаква тежест, но е по-долу във файла), а „color:#fff“
     остава — надписът излизаше бял върху светлото меню. Измерен контраст преди
     поправката: 1.01, тоест невидим; след нея 6.72–7.10 във всичките седем теми
     и 5.53 при посочване. */
  assert.match(CSS, /\.rowMenuPop \.btn\.dgr\{[^}]*color:var\(--red\)/);
  assert.match(CSS, /\.rowMenuPop \.btn\.dgr:hover\{[^}]*color:var\(--red\)/,
    'и при посочване: инак „.btn.dgr:hover{background:#7C1F18}“ дава тъмночервено под червени букви');
  /* Правилото ТРЯБВА да стои след „.btn.dgr“ — при еднаква тежест печели
     по-долното. Ако някой го премести нагоре, поправката пак се губи. */
  assert.ok(CSS.indexOf('.rowMenuPop .btn.dgr{') > CSS.indexOf('.btn.dgr{'), 'редът във файла има значение');
});

test('менюто на реда стои в <body>, а не в таблицата — .wrap изрязва и по вертикала', () => {
  const html = fs.readFileSync(path.join(APP_DIR, 'src', 'index.html'), 'utf8');
  assert.match(html, /<div id="rowMenuPop" class="rowMenuPop" role="menu"><\/div>/);
  assert.match(CSS, /\.rowMenuPop\{[^}]*position:fixed/, 'фиксирано, за да не го реже .wrap{overflow-x:auto}');
  assert.match(CSS, /\.rowActs \.rowMoreItems\{display:none\}/);
});

test('копчетата на реда са поне 32 px висок отпечатък', () => {
  assert.match(CSS, /\.rowActs \.btn\.sm\{padding:6px 10px; font-size:12px; min-height:32px\}/,
    'дотук бяха padding:4px 6px — измерени 24 px в Chromium');
  assert.match(CSS, /\.rowMenuPop \.btn\{[^}]*min-height:32px/);
  /* Правилото за трите точки трябва да е ПО-ТЕЖКО от „.rowActs .btn.sm“ (0-3-0),
     иначе не важи изобщо: копчето винаги е class="btn sm rowMore" вътре в
     .rowActs. Измерено в Chromium преди поправката: 12 px вместо 15. */
  assert.match(CSS, /\.rowActs \.btn\.sm\.rowMore\{font-size:16px;/);
  assert.doesNotMatch(CSS, /^\.rowMore\{/m, 'самичкото .rowMore е мъртво правило');
});

/* ====================== 2) сгъване на групите в лентата ====================== */

test('лявата лента: заглавието на групата е копче, което сгъва редовете ѝ', async () => {
  const dom = buildDom({});
  const { window } = dom; await settle();
  const d = window.document;
  window.drawNav();
  const grps = [...d.querySelectorAll('#nav .nav-grp')];
  assert.equal(grps.length, 7);
  assert.ok(grps.every(g => g.tagName === 'BUTTON'), 'заглавието е <button>, за да се стига с клавиатура');
  assert.ok(grps.every(g => g.getAttribute('aria-expanded') === 'true'),
    'по подразбиране всичко е отворено — при надграждане нищо не изчезва под ръцете на човека');
  assert.equal(d.querySelectorAll('#nav .nav-items[hidden]').length, 0);
  /* Скриването стъпва на [hidden], но правилото се пише ИЗРИЧНО: браузърското
     `[hidden]{display:none}` е по атрибут и всяко бъдещо `.nav-items{display:…}`
     (по клас, по-тежко) би го надвило и сгънатата група пак би заемала място. */
  assert.match(CSS, /\.nav-items\[hidden\], #nav a\[hidden\]\{display:none\}/);
  const редове = d.querySelectorAll('#nav a').length;

  window.toggleNavGroup('Краезнание');
  const сгънати = [...d.querySelectorAll('#nav .nav-grp.folded .nav-grpTx')].map(x => x.textContent);
  assert.deepEqual(сгънати, ['Краезнание']);
  const box = [...d.querySelectorAll('#nav .nav-grp')].find(b => b.classList.contains('folded')).nextElementSibling;
  assert.ok(box.classList.contains('nav-items') && box.hasAttribute('hidden'), 'редовете ѝ се махат от подредбата');
  assert.equal(box.querySelectorAll('a').length, 3, 'самите връзки остават в дървото, само скрити');
  assert.equal(d.querySelectorAll('#nav a').length, редове, 'нищо не се губи — само се скрива');
  assert.equal([...d.querySelectorAll('#nav .nav-grp')].find(b => b.classList.contains('folded')).getAttribute('aria-expanded'), 'false');

  window.toggleNavGroup('Краезнание');
  assert.equal(d.querySelectorAll('#nav .nav-grp.folded').length, 0, 'второто натискане разгъва');
});

test('сгъната група показва текущия раздел, но само него', async () => {
  const dom = buildDom(READER_DEPS);
  const { window } = dom; await settle();
  const d = window.document;
  window.location.hash = '#readers';
  await window.route(); await settle();
  const име = (b) => b.querySelector('.nav-grpTx').textContent;
  const грп = () => [...d.querySelectorAll('#nav .nav-grp')].find(b => име(b) === 'Читатели');

  window.toggleNavGroup('Читатели');
  /* Заглавието се поддава на натискане като всяко друго — иначе копчето изглежда
     счупено: щракваш и не се променя нищо (открито при прегледа на кръга). */
  assert.equal(грп().classList.contains('folded'), true);
  assert.equal(грп().getAttribute('aria-expanded'), 'false');
  const кутия = грп().nextElementSibling;
  assert.equal(кутия.hasAttribute('hidden'), false, 'кутията остава — в нея стои текущият раздел');
  const видими = [...кутия.querySelectorAll('a')].filter(a => !a.hasAttribute('hidden'));
  assert.deepEqual(видими.map(a => a.textContent.trim()), ['Читатели'],
    'вижда се САМО текущият раздел — иначе лявата лента не показва къде си');
  /* jsdom не смята подредба: скриването наистина ли работи, се вижда само от
     правилото. „#nav a{display:flex}“ (1-0-1) надвива браузърското
     „[hidden]{display:none}“ (0-1-0) — измерено в Chromium: и четирите реда на
     сгънатата текуща група си стояха на екрана. */
  assert.match(CSS, /#nav a\[hidden\]\{display:none\}|\[hidden\], #nav a\[hidden\]\{display:none\}/);
  assert.equal(видими[0].getAttribute('aria-current'), 'page');

  /* А в друга сгъната група не се вижда нищо. */
  window.toggleNavGroup('Краезнание');
  const друга = [...d.querySelectorAll('#nav .nav-grp')].find(b => име(b) === 'Краезнание');
  assert.equal(друга.nextElementSibling.hasAttribute('hidden'), true);

  // щом се отиде другаде, „Читатели“ се сгъва изцяло
  window.location.hash = '#dash';
  window.eval("VIEW = 'dash'");
  window.drawNav();
  assert.equal(грп().nextElementSibling.hasAttribute('hidden'), true);
});

test('сгъването не изпуска фокуса и не дърпа лентата настрани', async () => {
  const dom = buildDom(READER_DEPS);
  const { window } = dom; await settle();
  const d = window.document;
  window.location.hash = '#readers';
  await window.route(); await settle();

  /* drawNav() пресъздава лентата и заедно с нея натиснатото копче: без връщане
     на фокуса той пада в <body> и следващият Tab тръгва от началото на страницата
     (проверено в Chromium). */
  window.toggleNavGroup('Фонд');
  assert.equal(d.activeElement.className.includes('nav-grp'), true, 'фокусът остава на заглавието');
  assert.equal(d.activeElement.querySelector('.nav-grpTx').textContent, 'Фонд');

  /* Превъртането до текущия раздел е само при СМЯНА на раздел: иначе всяко
     сгъване дърпа лентата обратно и изнася натиснатото заглавие извън екрана. */
  let превъртания = 0;
  /* Броячът стои на прототипа: drawNav() пресъздава връзките, тоест закачен на
     самите елементи щеше да отчита само предишния рисунък. */
  window.HTMLElement.prototype.scrollIntoView = function () { if (this.closest('#nav')) превъртания++; };
  window.drawNav();
  const преди = превъртания;
  window.toggleNavGroup('Краезнание');
  assert.equal(превъртания, преди, 'сгъването не превърта');
  window.eval("VIEW = 'dash'");
  window.drawNav();
  assert.equal(превъртания, преди + 1, 'смяната на раздел превърта');
});

test('сгънатото се записва в localStorage и се чете при пускане', () => {
  const nav = view('navigation.js');
  assert.match(nav, /const NAV_FOLD_KEY = 'invlib-nav-folded'/);
  assert.match(nav, /localStorage\.setItem\(NAV_FOLD_KEY, JSON\.stringify\(\[\.\.\.NAV_FOLDED\]\)\)/);
  assert.match(nav, /JSON\.parse\(localStorage\.getItem\(NAV_FOLD_KEY\) \|\| '\[\]'\)/);
  /* Четенето и писането са в try/catch: при file:// origin браузърът отказва
     достъп до localStorage със SecurityError, а лявата лента не бива да пада
     заедно с него. Точно това състояние е в сила и в jsdom-а на тестовете —
     ако някой махне пазача, всички тестове по-горе падат. */
  for (const m of [/try \{ NAV_FOLDED = new Set\(JSON\.parse/, /try \{ localStorage\.setItem\(NAV_FOLD_KEY/]) {
    assert.match(nav, m, 'достъпът до localStorage е в try/catch');
  }
});

test('името на групата минава през jsq() в onclick', () => {
  assert.match(view('navigation.js'), /onclick="toggleNavGroup\('\$\{jsq\(g\.g\)\}'\)"/);
});

/* ===================== 4) един шрифт за целия интерфейс ===================== */

test('копчетата и полетата за избор носят шрифта на програмата', () => {
  assert.match(CSS, /^button, select, textarea\{font-family:var\(--sans\)\}$/m,
    'без това <button> се рисува със системния шрифт (Arial), а текстът до него — със Segoe UI');
  assert.match(CSS, /^select, textarea\{font-size:13px; color:var\(--ink\)\}$/m);
  assert.match(CSS, /\.toolbar select\{padding:8px 10px;[^}]*min-height:36px\}/,
    'полето за избор се изравнява по височина с полето за търсене (36 px)');
});

/* ================= 5) основното копче веднага след търсенето ================= */

test('и в двата регистъра основното копче стои веднага след полето за търсене', async () => {
  const cases = [
    ['books.js', /id="bSearch"[\s\S]{0,900}?<button class="btn pri" onclick="bookForm\(\)">\+ Нова книга<\/button>/],
    ['readers.js', /id="rSearch"[\s\S]{0,900}?<button class="btn pri" onclick="readerForm\(\)">\+ Нов читател<\/button>/]
  ];
  for (const [f, re] of cases) assert.match(view(f), re, f);

  /* И наистина ли е ВТОРИЯТ елемент в лентата, а не някъде след филтрите. */
  const dom = buildDom(READER_DEPS);
  const { window } = dom; await settle();
  await window.renderReaders(); await settle();
  const bar = [...window.document.querySelectorAll('#view .toolbar')][0].children;
  assert.equal(bar[0].id, 'rSearch');
  assert.equal(bar[1].textContent.trim(), '+ Нов читател');
  assert.ok(bar[1].classList.contains('pri'));
});

/* =========================== 6) без дребен текст =========================== */

test('mnyCell(): двете валути на един ред, еврото 12 px в скоби', async () => {
  const dom = buildDom({});
  const { window } = dom; await settle();
  const html = window.eval('mnyCell(12)');
  assert.match(html, /^<span class="money" title="12\.00 лв\. \/ 6\.14 €">12\.00 лв\. <small>6\.14 €<\/small><\/span>$/);
  assert.ok(/лв\. <small>/.test(html), 'интервалът пред <small> е задължителен — иначе „12.00 лв.(6.14 €)“');
  assert.match(CSS, /\.money\{display:inline; white-space:nowrap; font-family:var\(--mono\)\}/,
    'дотук беше inline-flex column: левовете НАД евровете');
  assert.match(CSS, /\.money small\{font-size:12px; color:var\(--ink3\)\}/, 'еврото беше 10,5 px');
  assert.match(CSS, /\.money small::before\{content:'\('\}/);
  assert.match(CSS, /\.money small::after\{content:'\)'\}/);
});

test('надписите за състояние (.badge) са 12 px, не 11', () => {
  const rules = CSS.match(/^\.badge\{[^}]*\}$/gm) || [];
  assert.equal(rules.length, 2, 'двете места, където се задава .badge');
  for (const r of rules) assert.match(r, /font-size:12px/, r);
});

/* ============ 7) смяна на раздел: мястото се изчиства и си казва ============ */

test('route() маха стария раздел веднага и показва „Зарежда се…“', async () => {
  const dom = buildDom({ ...READER_DEPS, 'books.list': [], 'categories.list': [], 'shelves.list': [] });
  const { window } = dom; const d = window.document; await settle();
  window.location.hash = '#readers';
  await window.route(); await settle();
  assert.ok(d.querySelector('#rBody'), 'Читатели се зареди');

  /* Раздел, чиито данни се бавят: докато route() чака, мястото НЕ бива да държи
     чуждата таблица под новото заглавие. */
  let пусни;
  const бавно = new Promise(r => { пусни = r; });
  window.__бавно = бавно;
  window.eval('window.__истински = RENDERERS.books; RENDERERS.books = async () => { await window.__бавно; return window.__истински(); };');
  window.location.hash = '#books';
  const върви = window.route();
  await settle();
  assert.equal(d.querySelector('#vTitle').textContent, 'Библиотечен фонд');
  assert.equal(d.querySelector('#rBody'), null, 'таблицата на читателите вече я няма');
  const плейс = d.querySelector('#view .viewLoading');
  assert.ok(плейс, 'на нейно място стои надпис, че се зарежда');
  assert.equal(плейс.getAttribute('role'), 'status');
  пусни(); await върви; await settle();
  assert.ok(d.querySelector('#bBody'), 'после идва таблицата на фонда');
  assert.equal(d.querySelector('.viewLoading'), null, 'надписът не остава');
});

test('route() казва наяве, когато рендерът е излязъл тихо или е хвърлил', async () => {
  const dom = buildDom({ ...READER_DEPS, 'books.list': [], 'categories.list': [], 'shelves.list': [] });
  const { window } = dom; const d = window.document; await settle();
  window.location.hash = '#books';
  await window.route(); await settle();

  // а) тихо излизане (`if (!r) return;` — така се държи почти всеки раздел при отказана заявка)
  window.eval('RENDERERS.readers = async () => {};');
  window.location.hash = '#readers';
  await window.route(); await settle();
  assert.equal(d.querySelector('#bBody'), null, 'чуждата таблица на фонда не остава под заглавието „Читатели“');
  const кутия = d.querySelector('#view .viewFailed');
  assert.ok(кутия, 'има съобщение вместо тих празен екран');
  assert.equal(кутия.getAttribute('role'), 'alert');
  assert.match(кутия.textContent.replace(/\s+/g, ' '), /Разделът не се зареди\..*Опитай пак/);
  assert.equal(кутия.querySelector('button').getAttribute('onclick'), 'route()');

  // „Опитай пак“ след като заявката проработи
  window.eval('RENDERERS.readers = renderReaders;');
  кутия.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.ok(d.querySelector('#rBody'), 'повторният опит зарежда раздела');
  assert.equal(d.querySelector('.viewFailed'), null);

  /* б) хвърлена грешка — заради finally мястото пак не остава на „Зарежда се…“.
     Адресът НЕ се сменя: иначе hashchange пуска втори route(), чието отхвърляне
     никой не хваща и тестът пада върху него, а не върху проверката. */
  window.eval("RENDERERS.readers = async () => { throw new Error('нарочна грешка'); };");
  await window.route().catch(() => {});
  await settle();
  assert.equal(d.querySelector('.viewLoading'), null, 'без finally тук би останало „Зарежда се…“ завинаги');
  assert.ok(d.querySelector('.viewFailed'));
});

test('закъснял рендер не щампова грешка върху раздела, който вече се зарежда', async () => {
  /* Открито при прегледа на кръга: библиотекарката натиска „Читатели“, базата се
     бави, натиска „Книги“ — и когато закъснелият рендер на „Читатели“ излезе по
     тихия път, той намираше НОВОТО „Зарежда се…“ и лепваше отгоре му червената
     кутия, макар „Книги“ да се зарежда съвсем нормално. */
  const dom = buildDom({ ...READER_DEPS, 'books.list': [], 'categories.list': [], 'shelves.list': [] });
  const { window } = dom; const d = window.document; await settle();
  window.location.hash = '#dash';
  window.eval("VIEW = 'dash'");

  let пусниЧитатели, пусниКниги;
  window.__чит = new Promise(r => { пусниЧитатели = r; });
  window.__кни = new Promise(r => { пусниКниги = r; });
  window.eval('RENDERERS.readers = async () => { await window.__чит; };');           // тих изход
  window.eval('window.__книгиИстински = RENDERERS.books;'
    + 'RENDERERS.books = async () => { await window.__кни; return window.__книгиИстински(); };');

  window.location.hash = '#readers';
  const А = window.route();
  await settle();
  window.location.hash = '#books';
  const Б = window.route();
  await settle();
  assert.equal(d.querySelector('#vTitle').textContent, 'Библиотечен фонд');

  пусниЧитатели(); await А; await settle();
  assert.equal(d.querySelector('.viewFailed'), null,
    'закъснелият раздел мълчи — на екрана е ДРУГ раздел и той още се зарежда');
  assert.ok(d.querySelector('.viewLoading'), '„Книги“ продължава да се зарежда');

  пусниКниги(); await Б; await settle();
  assert.ok(d.querySelector('#bBody'), 'и се зарежда докрай');
  assert.equal(d.querySelector('.viewFailed'), null);
});

test('стилът на двете състояния съществува', () => {
  assert.match(CSS, /\.viewLoading\{/);
  assert.match(CSS, /\.viewFailed\{/);
});
