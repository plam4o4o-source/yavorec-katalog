'use strict';
/* Тестове за десетте поправки от v2.2.0 в изгледите (src/views/*.js). Всеки от
   тях описва загуба на работа или подвеждаща информация за библиотекаря, а не
   „нечист код“ — затова е записан като отделен тест, който пада ПРЕДИ поправката:

   1) ЖУРНАЛЪТ ПРИ ЗАЕМАНЕ. След всяко сканиране loans.js викаше renderCirc(),
      която пререндира целия #view — журналът #outLog заедно с току-що добавения
      бутон „Разписка“ изчезваше веднага след появата си (разписка не можеше да
      се отпечата), а неизчаканият пререндер подменяше #bScan по средата на
      следващото сканиране и баркод четецът губеше знаци.

   2) ПРОВАЛЕН ЗАПИС ЗАТВАРЯШЕ ФОРМАТА. Моделът „…await call(…); closeModal();
      render()…“ затваря прозореца БЕЗУСЛОВНО — и когато call() е върнал null
      (грешка от базата, напр. дублиран инв. номер). Библиотекар с петнайсет
      попълнени полета губеше всичко. Правилният модел (saveAcq/saveAct/
      savePayment) затваря само при успех.

   3) ГОДИНИТЕ В ПАДАЩИТЕ МЕНЮТА. Списъкът се строеше като [избраната, текущата],
      тоест едно меню с ЕДНА опция — а избраната година се сменя само през него.
      На 05.01.2027 г. дневникът за декември 2026 и КДБФ за 2026 бяха недостижими.

   4) ТЪРСАЧКИТЕ ГУБЕХА ФОКУСА. Забавеното (debounce) търсене викаше пълния
      renderX(), който подменя #view заедно със самото поле за търсене: пауза
      над 300 ms по средата на „Иван Вазов“ и следващите клавиши отиват в нищото.

   5) НАПОМНЯНЕТО СЕ ВПИСВАШЕ ПРЕДИ ПЕЧАТА. От v1.71.0 doPrint() само отваря
      преглед с бутон „Отказ“ — а в регистъра вече пишеше „изпратено напомняне“
      на всички просрочили читатели.

   6) ВЛАЧЕНЕ НА ФАЙЛ. File.path е премахнат в Electron 32 (програмата е на 43):
      влаченето не правеше нищо и мълчеше.

   7) РАЗПИСКА С ГРЕШЕН ЧИТАТЕЛ. printLoanSlip четеше CIRC.readerId чак при
      клика, а инв. номерът минаваше през JSON.stringify — текстов баркод с
      кавичка чупеше onclick атрибута.

   8) ЦЕЛИЯТ ЗАПИС В onclick. „Редактирай“ в периодиката вграждаше обекта заедно
      с p.issues (стотици килобайта) и със собствено екраниране вместо jsq().

   10) ЗАГЛАВНАТА ОТМЕТКА ЛЪЖЕШЕ. След „Избери всички“ и махане на един ред
      #chkAll оставаше ✓.  */
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

/* Същият „безопасен“ Proxy като в views-smoke/views-regressions: държи се като
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

/* Мокът тук е разширен спрямо views-regressions.test.js с две неща, без които
   тези дефекти не могат да се проверят изобщо:
   — стойност-функция: отговорът зависи от аргументите (търсене по низ, различни
     читатели по id);
   — fail('…'): IPC извикване, което връща {ok:false} — точно случаят, при който
     формата не бива да се затваря.
   Всяко извикване се записва в dom.calls, за да се провери КОГА е направено
   (напр. вписването на напомняне — преди или след потвърден печат). */
const FAIL = Symbol('fail');
function fail(message) { return { [FAIL]: true, ok: false, error: message }; }

function apiMock(overrides, calls) {
  function makeNode(parts) {
    const key = parts.join('.');
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeNode(parts.concat(prop));
      },
      apply(t, self, args) {
        calls.push({ key, args });
        const has = Object.prototype.hasOwnProperty.call(overrides, key);
        const raw = has ? overrides[key] : safeDefault();
        const val = typeof raw === 'function' ? raw(...args) : raw;
        if (val && typeof val === 'object' && (val[FAIL] || Object.prototype.hasOwnProperty.call(val, 'ok'))) {
          return Promise.resolve({ ok: !!val.ok, data: val.data, error: val.error });
        }
        return Promise.resolve({ ok: true, data: val });
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
  dom.calls = [];
  const { window } = dom;
  window.api = apiMock(overrides || {}, dom.calls);
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

/* bootstrap.js стартира loadSettingsCache().then(… route()) — първо се изчаква
   този старт, иначе рендерът на теста бива изтрит „изпод краката“ му. */
async function settled(dom, ticks) {
  for (let i = 0; i < (ticks || 8); i++) await new Promise(r => setTimeout(r, 0));
  return dom;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const callsOf = (dom, key) => dom.calls.filter(c => c.key === key);

/* Помощно: подава формата, която save-функцията чака, без да се минава през
   пълния изглед (интересува ни само поведението при провален запис). */
function putForm(window, id, fields) {
  const box = window.document.createElement('div');
  box.id = id;
  box.innerHTML = Object.entries(fields).map(([k, v]) =>
    (typeof v === 'boolean'
      ? `<input type="checkbox" name="${k}" ${v ? 'checked' : ''}>`
      : `<input name="${k}" value="${v}">`)).join('');
  window.document.body.appendChild(box);
  return box;
}
/* closeModal() е функционална декларация в core.js, тоест свойство на window —
   подмяната ѝ прихваща и извикванията без префикс от самите изгледи. */
function spyClose(window) {
  const rec = { n: 0 };
  window.closeModal = () => { rec.n++; };
  window.closeModal2 = () => { rec.n++; };
  return rec;
}

/* ============================================================================
   1) Заемане: журналът и бутонът „Разписка“ оцеляват; фокусът остава в #bScan
   ============================================================================ */

const CIRC_READERS = {
  1: { id: 1, name: 'Иван Петров', card_no: '0001', category: 'възрастен', status: 'активен' },
  2: { id: 2, name: 'Мария Георгиева', card_no: '0002', category: 'възрастен', status: 'активен' }
};
function circDom(extra) {
  return buildDom(Object.assign({
    'settings.get': { lib_name: 'Библиотека', place: 'Град', org: 'Читалище', fine_per_day: 0.1 },
    'readers.get': (id) => CIRC_READERS[id] || CIRC_READERS[1],
    'account.get': { balance: 0 },
    'circRules.effective': { loan_days: 30, max_books: 5, extensions_count: 2 },
    'loans.byReader': [],
    'holds.list': []
  }, extra || {}));
}
async function openCirc(dom, readerId) {
  const { window } = dom;
  await settled(dom);
  window.location.hash = '#circ';
  await window.route();
  await window.selectCircReader(readerId || 1);
  await settled(dom);
  return window.document.getElementById('bScan');
}
async function scan(dom, code) {
  const { window } = dom;
  const el = window.document.getElementById('bScan');
  el.value = code;
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settled(dom);
}

test('заемането не пререндира целия изглед — журналът и бутонът „Разписка“ остават на екрана', async () => {
  const dom = circDom({
    'loans.checkoutByCode': (a) => ({ ok: true, data: { title: 'Тютюн', inv_number: a.code, date_due: '2026-09-30' } })
  });
  const { window } = dom;
  const scanEl = await openCirc(dom, 1);
  assert.ok(scanEl, 'полето за сканиране трябва да съществува');

  await scan(dom, '101');
  const log = window.document.getElementById('outLog');
  assert.ok(log, '#outLog трябва да е още в DOM след заемането (пълният пререндер го триеше)');
  assert.match(log.textContent, /Тютюн/);
  assert.ok(log.querySelector('button'), 'бутонът „Разписка“ трябва да остане — иначе разписка не може да се отпечата');

  // Журналът се натрупва, както при режим „Връщане“.
  await scan(dom, '102');
  assert.equal(window.document.querySelectorAll('#outLog .scanlog').length, 2,
    'вторият ред трябва да се добави към журнала, а не да го замести');

  // Полето за сканиране е СЪЩИЯТ елемент и фокусът е в него — иначе баркод
  // четецът праща знаците на следващата книга в подменен (или никакъв) вход.
  assert.equal(window.document.getElementById('bScan'), scanEl, '#bScan не бива да се пресъздава');
  assert.equal(window.document.activeElement, scanEl, 'фокусът трябва да остане в полето за сканиране');
});

test('след заемане броячът на заетите книги на читателя се обновява точково', async () => {
  const dom = circDom({
    'loans.checkoutByCode': { title: 'Под игото', inv_number: 7, date_due: '2026-09-30' }
  });
  const { window } = dom;
  await openCirc(dom, 1);
  assert.match(window.document.getElementById('circCount').textContent, /заети: 0 \/ 5/);
  await scan(dom, '7');
  assert.match(window.document.getElementById('circCount').textContent, /заети: 1 \/ 5/,
    'броячът е единственото променено на екрана — трябва да е обновен');
});

/* ============================================================================
   7) Разписката пази читателя от момента на заемането; кавичка в баркода
   ============================================================================ */

test('разписката излиза на читателя от момента на заемането, не на текущия', async () => {
  const dom = circDom({
    'loans.checkoutByCode': { title: 'Тютюн', inv_number: 5, date_due: '2026-09-30' }
  });
  const { window } = dom;
  await openCirc(dom, 1); // Иван Петров
  await scan(dom, '5');
  const btn = window.document.querySelector('#outLog button');
  assert.ok(btn, 'бутонът „Разписка“ трябва да съществува');

  // Междувременно на гишето застава следващият читател.
  window.eval('CIRC.readerId = 2');
  const printed = [];
  window.doPrint = (html) => printed.push(html);
  await new window.Function(btn.getAttribute('onclick'))();
  await settled(dom);

  assert.equal(printed.length, 1, 'разписката трябва да се отпечата');
  assert.match(printed[0], /Иван Петров/, 'разписката е за читателя, който е взел книгата');
  assert.doesNotMatch(printed[0], /Мария Георгиева/, 'не бива да излиза на следващия читател');
});

test('кавичка в текстов баркод не чупи onclick на бутона „Разписка“', async () => {
  const weird = 'АБ"12\'34';
  const dom = circDom({
    'loans.checkoutByCode': { title: "Жана д'Арк", inv_number: weird, date_due: '2026-09-30' }
  });
  const { window } = dom;
  await openCirc(dom, 1);
  await scan(dom, weird);
  const btn = window.document.querySelector('#outLog button');
  assert.ok(btn, 'бутонът трябва да е цял — кавичката не бива да прекъсва атрибута');

  const printed = [];
  window.doPrint = (html) => printed.push(html);
  // new Function върши същото, което браузърът прави с тялото на onclick.
  await new window.Function(btn.getAttribute('onclick'))();
  await settled(dom);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /Жана д&#39;Арк/, 'заглавието пристига непроменено');
  assert.match(printed[0], /АБ&quot;12&#39;34/, 'инв. номерът пристига непроменен');
});

/* ============================================================================
   2) Провален запис НЕ затваря формата (модел saveAcq/saveAct/savePayment)
   ============================================================================ */

/* Всеки ред: изглед, формата която save-функцията чете, попълнени стойности,
   IPC ключът, който проваляме, и самото извикване. */
const SAVE_CASES = [
  { view: 'Книги', form: 'bookF', data: { title: 'Тютюн', inv_number: '101', register_date: '2026-08-17', price: '5' },
    key: 'books.create', run: (w) => w.saveBook(null) },
  { view: 'Книги (редакция)', form: 'bookF', data: { title: 'Тютюн', inv_number: '101' },
    key: 'books.update', run: (w) => w.saveBook(3) },
  { view: 'Читатели', form: 'readerF', data: { name: 'Иван Петров', card_no: '0001', category: 'възрастен', gdpr_consent: true },
    key: 'readers.create', run: (w) => w.saveReader(null) },
  { view: 'Периодика', form: 'perF', data: { title: 'Труд', freq: 'дневно' },
    key: 'periodicals.create', run: (w) => w.savePeriodical(null) },
  { view: 'МЗС', form: 'mzsF', data: { title: 'Записки', direction: 'заявена от нас' },
    key: 'mzs.create', run: (w) => w.saveMzs(null) },
  { view: 'Персоналии', form: 'prsF', data: { name: 'Баба Тонка', bio: 'Дълга биография, преписана от хартия.' },
    key: 'persons.create', run: (w) => w.savePerson(null) },
  { view: 'Персоналии (редакция)', form: 'prsF', data: { name: 'Баба Тонка' },
    key: 'persons.update', run: (w) => w.savePerson(4) },
  { view: 'Летопис', form: 'chrF', data: { title: 'Основаване', year: '1922', body: 'Дълъг летописен текст.' },
    key: 'chronicle.create', run: (w) => w.saveChronicle(null) },
  { view: 'Летопис (редакция)', form: 'chrF', data: { title: 'Основаване', year: '1922' },
    key: 'chronicle.update', run: (w) => w.saveChronicle(6) },
  { view: 'Аналитично описание', form: 'anlF', data: { title: 'Статия за селото', author: 'И. Иванов' },
    key: 'analytics.create', run: (w) => w.saveAnalytic(null) },
  { view: 'Категории', form: 'catF', data: { name: 'Книги' },
    key: 'categories.create', run: (w) => w.saveCategory(null) },
  { view: 'Статистика (посещения)', form: 'vsF', data: { date: '2026-08-17', count: '12' },
    key: 'visits.add', run: (w) => w.saveVisits() }
];

for (const c of SAVE_CASES) {
  test(`провален запис в „${c.view}“ НЕ затваря формата (въведеното се пази)`, async () => {
    const dom = buildDom({ [c.key]: fail('Инвентарният номер вече съществува.') });
    const { window } = dom;
    await settled(dom);
    putForm(window, c.form, c.data);
    const closed = spyClose(window);
    await c.run(window);
    await settled(dom);
    assert.equal(closed.n, 0,
      `closeModal() не бива да се вика при неуспешен запис — библиотекарят губи всичко попълнено`);
    // Данните са още в полетата, готови за поправка.
    const first = Object.keys(c.data)[0];
    assert.equal(window.document.querySelector(`#${c.form} [name="${first}"]`).value, String(c.data[first]));
  });

  test(`успешен запис в „${c.view}“ затваря формата`, async () => {
    const dom = buildDom({ [c.key]: 12 });
    const { window } = dom;
    await settled(dom);
    putForm(window, c.form, c.data);
    const closed = spyClose(window);
    await c.run(window);
    await settled(dom);
    assert.ok(closed.n >= 1, 'при успех формата трябва да се затвори както преди');
  });
}

test('провален запис на книга оставя прозореца отворен с попълнените полета', async () => {
  // Същото, но през истинската форма — проверява, че наистина има какво да се
  // спаси: 15-те полета на bookForm() остават на екрана.
  const dom = buildDom({
    'books.create': fail('Дублиран инвентарен номер.'),
    'categories.list': [{ id: 1, name: 'Книги' }],
    'settings.get': { lib_name: 'Библиотека' }
  });
  const { window } = dom;
  await settled(dom);
  await window.bookForm();
  await settled(dom);
  const form = window.document.querySelector('#bookF');
  assert.ok(form, 'формата за нова книга трябва да е отворена');
  form.querySelector('[name="title"]').value = 'Тютюн';
  form.querySelector('[name="inv_number"]').value = '101';
  const price = form.querySelector('[name="price"]');
  if (price) price.value = '5';
  const rd = form.querySelector('[name="register_date"]');
  if (rd && !rd.value) rd.value = '2026-08-17';

  await window.saveBook(null);
  await settled(dom);

  const veil = window.document.getElementById('veil');
  assert.ok(veil.classList.contains('on') && !veil.classList.contains('closing'),
    'прозорецът трябва да е още отворен след отхвърления запис');
  assert.equal(window.document.querySelector('#bookF [name="title"]').value, 'Тютюн',
    'въведеното заглавие трябва да е още в полето');
});

/* ============================================================================
   3) Годините в падащите менюта — текущата и няколко назад
   ============================================================================ */

test('yearOptions() дава текущата година и пет назад, низходящо', () => {
  const dom = buildDom({});
  const { window } = dom;
  const cur = new Date().getFullYear();
  // (масивът идва от jsdom realm-а, затова се сравнява по стойност, не с deepEqual)
  const years = [...window.yearOptions(String(cur))];
  assert.equal(years.join(','), [cur, cur - 1, cur - 2, cur - 3, cur - 4, cur - 5].join(','));
  // Избрана година извън обхвата (стар отчет) не изчезва от списъка.
  const old = [...window.yearOptions(String(cur - 12))];
  assert.equal(old[old.length - 1], String(cur - 12));
  assert.ok(old.includes(String(cur - 1)));
  // numeric=true — дневникът работи с числа.
  assert.equal(window.yearOptions(cur, true)[0], cur);
});

function yearSelectValues(window, view) {
  // Менюто с години е това, чиито опции са четиризначни числа.
  const sels = [...window.document.querySelectorAll((view || '#view') + ' select')];
  const found = sels.find(s => [...s.options].length && [...s.options].every(o => /^\d{4}$/.test(o.textContent.trim())));
  return found ? [...found.options].map(o => o.textContent.trim()) : null;
}

test('КДБФ, Дневник, Статистика и Готови справки предлагат и миналите години', async () => {
  const cur = new Date().getFullYear();
  const dom = buildDom({
    'reports.list': [{ id: 'fond', title: 'Движение на фонда', needsYear: true }],
    'reports.run': { rows: [], columns: [] },
    'kdbf.report': { part1: [], part2: { in: [], out: [] }, part3: [] },
    'stats.report': { fundCount: 0, fundValue: 0, readersCount: 0, loansCount: 0, visits: 0,
      returnedOnTime: 0, returnedLate: 0, acquiredCount: 0, acquiredValue: 0,
      deaccessionedCount: 0, deaccessionedValue: 0, fundByLanguage: [], fundByDepartment: [],
      fundByCategory: [], topLoans: [], topReaders: [] }
  });
  const { window } = dom;
  await settled(dom);

  for (const [label, render] of [['КДБФ', 'renderKdbf'], ['Дневник', 'renderDnevnik'],
    ['Статистика', 'renderStats'], ['Готови справки', 'renderReports']]) {
    await window[render]();
    await settled(dom);
    const years = yearSelectValues(window);
    assert.ok(years, `в „${label}“ трябва да има меню с години`);
    assert.ok(years.length >= 6, `„${label}“: менюто има ${years.length} опция(и) — миналите години са недостижими`);
    assert.ok(years.includes(String(cur - 1)),
      `„${label}“: миналата година трябва да е в списъка (годишният отчет се прави за нея)`);
    assert.equal(years[0], String(cur), `„${label}“: списъкът е низходящ, текущата година е първа`);
  }
});

/* ============================================================================
   4) Търсачките не пресъздават полето за търсене
   ============================================================================ */

/* Пише се дума знак по знак с паузи над debounce-а — точно случаят, при който
   пълният пререндер подменяше полето и следващите клавиши отиваха в нищото. */
async function typeAndCheck(dom, input, word) {
  const { window } = dom;
  for (let i = 1; i <= word.length; i++) {
    input.value = word.slice(0, i);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    if (i === 3) await wait(400); // библиотекарят се спира да погледне картона
  }
  await wait(400);
  await settled(dom);
}

const SEARCH_CASES = [
  { view: 'Книги', render: 'renderBooks', sel: '#bSearch',
    api: { 'books.list': (q) => (q && !'Вазов'.startsWith(String(q).slice(0, 1)) ? [] : [
      { id: 1, title: 'Под игото', author: 'Иван Вазов', inv_number: 1, status: 'наличен', available: 1, quantity: 1 }]) } },
  { view: 'Читатели', render: 'renderReaders', sel: '#rSearch',
    api: { 'readers.list': [{ id: 1, name: 'Иван Вазов', card_no: '1', category: 'възрастен', status: 'активен' }] } },
  { view: 'Одитна следа', render: 'renderOdit', sel: '#oditSearch',
    api: { 'audit.list': [{ ts: '2026-08-17T10:00:00.000Z', user: 'Иван', action: 'нов', detail: 'книга', diff: '' }] } },
  { view: 'Аналитично описание', render: 'renderAnalytics', sel: '#anlQ',
    api: { 'analytics.list': [{ id: 1, title: 'Статия', year: '2026' }], 'analytics.years': [] } },
  { view: 'Персоналии', render: 'renderPersons', sel: 'input[type=search]',
    api: { 'persons.list': [{ id: 1, name: 'Баба Тонка' }] } },
  { view: 'Летопис', render: 'renderChronicle', sel: 'input[type=search]',
    api: { 'chronicle.list': [{ id: 1, title: 'Основаване', year: '1922' }], 'chronicle.years': [] } }
];

for (const c of SEARCH_CASES) {
  test(`търсенето в „${c.view}“ не пресъздава полето за търсене (фокусът се пази)`, async () => {
    const dom = buildDom(c.api);
    const { window } = dom;
    await settled(dom);
    await window[c.render]();
    await settled(dom);
    const input = window.document.querySelector('#view ' + c.sel) || window.document.querySelector(c.sel);
    assert.ok(input, `полето за търсене ${c.sel} трябва да съществува`);
    input.focus();

    await typeAndCheck(dom, input, 'Вазов, И');

    const now = window.document.querySelector('#view ' + c.sel) || window.document.querySelector(c.sel);
    assert.equal(now, input,
      'полето за търсене е пресъздадено — курсорът на библиотекаря изчезва по средата на писането');
    assert.ok(window.document.contains(input), 'полето трябва да е още в документа');
    assert.equal(input.value, 'Вазов, И', 'написаното трябва да е непокътнато');
    assert.equal(window.document.activeElement, input, 'фокусът трябва да е останал в полето');
  });
}

/* ============================================================================
   5) Напомнително писмо се вписва в регистъра само при потвърден печат
   ============================================================================ */

function noticesDom() {
  return buildDom({
    'loans.overdueByReader': [
      { reader_id: 1, name: 'Иван Петров', address: 'ул. Първа 1', n: 2, fine: 1.2,
        loans: [{ inv_number: 5, title: 'Тютюн', date_out: '2026-06-01', date_due: '2026-07-01' }] },
      { reader_id: 2, name: 'Мария Георгиева', address: 'ул. Втора 2', n: 1, fine: 0.6,
        loans: [{ inv_number: 9, title: 'Под игото', date_out: '2026-06-01', date_due: '2026-07-01' }] }
    ],
    'settings.get': { lib_name: 'Библиотека', place: 'Град', org: 'Читалище', fine_per_day: 0.1 }
  });
}

test('напомнянето НЕ се вписва в регистъра, докато прегледът стои отворен, и се отменя при „Отказ“', async () => {
  const dom = noticesDom();
  const { window } = dom;
  await settled(dom);
  await window.printOverdueNotices();
  await settled(dom);

  assert.ok(window.document.getElementById('printPreview').classList.contains('on'),
    'прегледът преди печат трябва да е отворен');
  assert.equal(callsOf(dom, 'notices.log').length, 0,
    'преди потвърден печат в регистъра не бива да пише „изпратено напомняне“');

  window.ppClose(); // бутон „Отказ“
  await settled(dom);
  assert.equal(callsOf(dom, 'notices.log').length, 0,
    'при отказ писмата не са изпратени — регистърът трябва да остане празен');
});

test('напомнянето се вписва точно веднъж за всеки читател при потвърден печат', async () => {
  const dom = noticesDom();
  const { window } = dom;
  await settled(dom);
  await window.printOverdueNotices();
  await settled(dom);
  assert.equal(callsOf(dom, 'notices.log').length, 0, 'преди печата — нищо в регистъра');
  window.ppPrint(); // бутон „Печат…“
  await settled(dom);

  const logs = callsOf(dom, 'notices.log');
  assert.equal(logs.length, 2, 'по едно вписване за всеки просрочил читател');
  assert.deepEqual(logs.map(l => l.args[0].reader_id).sort(), [1, 2]);
  assert.equal(logs[0].args[0].channel, 'печат');

  // Второ натискане на „Печат…“ не удвоява вписванията.
  window.ppPrint();
  await settled(dom);
  assert.equal(callsOf(dom, 'notices.log').length, 2, 'вписването е еднократно за един печат');
});

test('запис в PDF също се брои за изпратено напомняне', async () => {
  const dom = noticesDom();
  const { window } = dom;
  await settled(dom);
  await window.printOverdueNotices();
  await settled(dom);
  assert.equal(callsOf(dom, 'notices.log').length, 0, 'преди записа — нищо в регистъра');
  await window.ppSavePdf();
  await settled(dom);
  assert.equal(callsOf(dom, 'notices.log').length, 2,
    'записаният PDF е равностоен на отпечатан документ');
});

/* ============================================================================
   6) Влачене на файл: НИКОГА мълчаливо нищо (Electron 32+ няма File.path)

   v2.2.0 можеше само да покаже съобщение „ползвайте бутона" — мостът в
   preload.js беше извън обхвата ѝ. v2.2.1 добави importData.pathOf
   (webUtils.getPathForFile) и влаченето реално проработи, затова тук остава
   само общото изискване: каквото и да стане, библиотекарят вижда резултат —
   или файлът се зарежда, или излиза обяснение. Конкретните пътища (успешно
   влачене през моста, липсващ път, неподдържано разширение) са в
   test/fixes-v221.test.js.
   ============================================================================ */

test('влачене на файл без File.path не остава без никакъв резултат', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  const loaded = [];
  // Целият api се подменя, а не само api.importData: мокът е Proxy, чийто get
  // трап връща нов възел при всяко четене и заглушава присвояване на подобект.
  window.api = {
    importData: {
      pathOf: () => '',          // мостът не може да разчете пътя
      load: async (p) => { loaded.push(p); return { ok: true, data: {} }; }
    }
  };
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  // Точно каквото дава Electron 32+: File обект без свойство path.
  ev.dataTransfer = { files: [{ name: 'knigi.csv', size: 10 }] };
  window.document.dispatchEvent(ev);
  await settled(dom);

  const toasts = window.document.getElementById('toasts').textContent
    + window.document.getElementById('toastsTop').textContent;
  assert.equal(loaded.length, 0);
  assert.notEqual(toasts.trim(), '', 'мълчаливото нищо е най-лошият изход — трябва да има съобщение');
  assert.match(toasts, /Избери файл за въвеждане/,
    'съобщението трябва да насочва към бутона, който върши работа');
});

/* ============================================================================
   8) Периодика: в onclick влиза само id, не целият запис с историята на броевете
   ============================================================================ */

test('бутонът „Редактирай“ в периодиката подава само id (без p.issues в атрибута)', async () => {
  const issues = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, issue_no: String(i + 1), date: '2026-01-01', price: 1 }));
  const dom = buildDom({
    'periodicals.get': { id: 7, title: 'Труд', freq: 'дневно', publisher: 'Издател', issn: '1310-1', department: 'периодика', issues }
  });
  const { window } = dom;
  await settled(dom);
  await window.openPeriodical(7);
  await settled(dom);

  const btn = [...window.document.querySelectorAll('#modal footer button')]
    .find(b => b.textContent.includes('Редактирай'));
  assert.ok(btn, 'бутонът „Редактирай“ трябва да съществува');
  const attr = btn.getAttribute('onclick');
  assert.match(attr, /periodicalForm\(7\)/, 'подава се само id');
  assert.doesNotMatch(attr, /issue_no|issues/,
    'историята на броевете няма работа в onclick атрибута (стотици килобайта)');
  assert.ok(attr.length < 200, `onclick атрибутът е ${attr.length} знака — вгражда се цял запис`);
});

test('periodicalForm(id) зарежда записа сама и попълва полетата', async () => {
  const dom = buildDom({
    'periodicals.get': { id: 7, title: 'Труд', freq: 'дневно', publisher: 'Издател', issn: '1310-1', department: 'периодика', issues: [] }
  });
  const { window } = dom;
  await settled(dom);
  await window.periodicalForm(7);
  await settled(dom);
  assert.equal(window.document.querySelector('#perF [name="title"]').value, 'Труд');
  assert.equal(window.document.querySelector('#perF [name="issn"]').value, '1310-1');
  const save = [...window.document.querySelectorAll('#modal footer button')]
    .find(b => b.textContent.includes('Запиши'));
  assert.match(save.getAttribute('onclick'), /savePeriodical\(7\)/);
});

/* ============================================================================
   10) Заглавната отметка в „Книги“ следва реалния избор
   ============================================================================ */

test('#chkAll се изчиства, когато се махне отметката на един ред', async () => {
  const rows = [1, 2, 3].map(i => ({ id: i, title: 'Книга ' + i, author: 'Автор', inv_number: i,
    status: 'наличен', available: 1, quantity: 1 }));
  const dom = buildDom({ 'books.list': rows, 'categories.list': [] });
  const { window } = dom;
  await settled(dom);
  await window.renderBooks();
  await settled(dom);

  const chkAll = window.document.getElementById('chkAll');
  assert.ok(chkAll, 'заглавната отметка трябва да съществува');

  window.toggleBookSelAll(true);
  assert.equal(chkAll.checked, true, 'след „Избери всички“ отметката е сложена');

  // Библиотекарят маха един ред от избора.
  window.toggleBookSel(2, false);
  assert.equal(chkAll.checked, false,
    'отметката „избери всички“ лъже — избраните вече не са всички');
  assert.equal(chkAll.indeterminate, true, 'частичният избор се показва като „неопределен“');

  // Връща реда обратно → пак всички.
  window.toggleBookSel(2, true);
  assert.equal(chkAll.checked, true);
  assert.equal(chkAll.indeterminate, false);
});
