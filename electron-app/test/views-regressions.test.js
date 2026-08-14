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

/* --- Разписка за заемане (v1.70.0) — дотогава заемането нямаше никакъв печатен документ --- */

test('printLoanSlip() отпечатва разписка с читателя, заглавието и срока за връщане', async () => {
  const dom = buildDom({
    'readers.get': { id: 9, name: 'Мария Георгиева', card_no: '0042' },
    'settings.get': { lib_name: 'Библиотека', place: 'Град', org: 'Организация' }
  });
  const { window } = dom;
  await settled(dom);

  const printed = [];
  window.doPrint = (html) => printed.push(html);

  await window.printLoanSlip({ title: "Времеубежище", inv_number: 17, date_due: '2026-09-01' });

  assert.equal(printed.length, 1, 'разписката трябва да се отпечата');
  assert.match(printed[0], /РАЗПИСКА ЗА ЗАЕМАНЕ/);
  assert.match(printed[0], /Мария Георгиева/);
  assert.match(printed[0], /Времеубежище/);
  assert.match(printed[0], /01\.09\.2026/); // bg() формат за датата на връщане
});

/* --- Печат на Персоналии и Аналитично описание (v1.70.0) — дотогава тези два раздела
   бяха единствените краеведски раздели без бутон „Печат“ (Летопис вече имаше). --- */

test('printPersons() отпечатва списък персоналии с имена и дейност', async () => {
  const dom = buildDom({
    'persons.list': [
      { id: 1, name: 'Иван Петров', birth_date: '1930-05-01', activity: 'учител, читалищен деец', bio: 'Роден е в селото.' },
      { id: 2, name: 'Мария Георгиева', activity: 'краевед' }
    ]
  });
  const { window } = dom;
  await settled(dom);

  const printed = [];
  window.doPrint = (html) => printed.push(html);

  await window.printPersons();

  assert.equal(printed.length, 1, 'персоналиите трябва да се отпечатат');
  assert.match(printed[0], /ПЕРСОНАЛИИ/);
  assert.match(printed[0], /Иван Петров/);
  assert.match(printed[0], /Мария Георгиева/);
  assert.match(printed[0], /учител, читалищен деец/);
});

test('printPersons() показва предупреждение вместо празен печат, когато няма записи', async () => {
  const dom = buildDom({ 'persons.list': [] });
  const { window } = dom;
  await settled(dom);

  const printed = [];
  window.doPrint = (html) => printed.push(html);
  const toasts = [];
  window.toast = (msg, kind) => toasts.push({ msg, kind });

  await window.printPersons();

  assert.equal(printed.length, 0, 'не трябва да се отпечатва празен документ');
  assert.equal(toasts.length, 1);
});

test('printAnalytics() отпечатва аналитичните описания със заглавие и източник', async () => {
  const dom = buildDom({
    'analytics.list': [
      { id: 1, title: 'Читалището през годините', author: 'П. Иванов', year: '2020',
        is_local: 1, source_kind: 'периодика', periodical_title: 'Местен вестник', pages: '3' }
    ]
  });
  const { window } = dom;
  await settled(dom);

  const printed = [];
  window.doPrint = (html) => printed.push(html);

  await window.printAnalytics();

  assert.equal(printed.length, 1, 'аналитичните описания трябва да се отпечатат');
  assert.match(printed[0], /АНАЛИТИЧНО ОПИСАНИЕ/);
  assert.match(printed[0], /Читалището през годините/);
  assert.match(printed[0], /Местен вестник/);
});

/* --- Раздел „Баркод етикети“: невалиден (отрицателен) размер на етикета при
   ролков печат. printLabelSheet() изваждаше lbl_margin ДВА пъти от размера на
   самия етикет (веднъж чрез @page margin, веднъж от .lbl width/height) — за
   малък етикет от ролка (напр. 20×10 мм) с подразбиращото се поле от 8 мм
   резултатът беше `height:-6mm`, невалидна CSS стойност, която браузърът тихо
   пренебрегва вместо да покаже грешка; етикетът излизаше празен или раздут
   при печат. Полето „Поле на листа“ важи само за A4 (виж else клона по-долу
   и hint-а в barcode-labels.js) — ролковите принтери сами калибрират
   собствения си печатаем участък. */

test('printLabelsAll() при ролков печат не изважда полето от размера на етикета (не се получава отрицателна CSS стойност)', async () => {
  const dom = buildDom({
    'settings.get': {
      org: 'Читалище', lib_name: 'Библиотека', place: 'Село',
      lbl_mode: 'roll', lbl_w: 20, lbl_h: 10, lbl_margin: 8
    },
    'books.list': [{ id: 1, inv_number: 1, barcode: '1', title: 'Кн1', status: 'наличен' }]
  });
  const { window } = dom;
  await settled(dom);

  window.doPrint = (html) => { window._printedHtml = html; };

  await window.printLabelsAll();

  const st = window.document.getElementById('dynPrintStyle');
  assert.ok(st, 'динамичният стил за печат трябва да съществува');
  const css = st.textContent;
  assert.doesNotMatch(css, /-\d+mm/, 'няма отрицателна CSS стойност в мм в стила за печат');
  assert.match(css, /\.lbl\{width:20mm;height:10mm/,
    'етикетът трябва да заема пълния зададен размер (20×10 мм), не размера минус полето');
  assert.match(css, /@page\{size:20mm 10mm;margin:0mm\}/,
    '@page margin трябва да е 0 при ролков печат — полето не важи там');
});

test('printLabelsAll() при печат на A4 лист НЕ изважда полето от размера на етикета (само ролковият печат имаше този дефект)', async () => {
  const dom = buildDom({
    'settings.get': {
      org: 'Читалище', lib_name: 'Библиотека', place: 'Село',
      lbl_mode: 'sheet', lbl_w: 40, lbl_h: 30, lbl_margin: 8, lbl_cols: 3, lbl_gap: 3
    },
    'books.list': [{ id: 1, inv_number: 1, barcode: '1', title: 'Кн1', status: 'наличен' }]
  });
  const { window } = dom;
  await settled(dom);

  window.doPrint = (html) => { window._printedHtml = html; };

  await window.printLabelsAll();

  const css = window.document.getElementById('dynPrintStyle').textContent;
  assert.match(css, /\.lbl\{width:40mm;height:30mm/, 'A4 режимът вече беше правилен — размерът на етикета не се пипа тук');
});

// Читателските карти минават през СЪЩАТА printLabelSheet()/labelSize('card') функция
// и СПОДЕЛЯТ настройката lbl_mode с баркод етикетите за фонда — библиотека, която е
// избрала „Ролков лейбъл принтер“ заради книжните етикети, автоматично печата и
// читателските карти в ролков режим. Затова същият дефект правеше стандартната
// карта 90×60 мм по-малка (74×44 мм при подразбиращото се поле от 8 мм).
test('printCardsAll() при ролков печат дава читателска карта с точния зададен размер (90×60 мм), не размера минус полето', async () => {
  const dom = buildDom({
    'settings.get': {
      org: 'Читалище', lib_name: 'Библиотека', place: 'Село',
      lbl_mode: 'roll', card_w: 90, card_h: 60, lbl_margin: 8
    },
    'readers.list': [{ id: 1, name: 'Иванова, Мария', card_no: '000123', category: 'възрастен', status: 'активен' }]
  });
  const { window } = dom;
  await settled(dom);

  window.doPrint = (html) => { window._printedHtml = html; };

  await window.printCardsAll();

  const css = window.document.getElementById('dynPrintStyle').textContent;
  assert.doesNotMatch(css, /-\d+mm/, 'няма отрицателна CSS стойност в мм в стила за печат');
  assert.match(css, /\.lbl\{width:90mm;height:60mm/,
    'читателската карта трябва да е точно 90×60 мм, не 74×44 мм (90/60 минус 2×8 мм поле)');
});

/* --- Раздел „Баркод етикети“: заглавна част на етикета за фонда (v1.71.1).
   По изрична заявка: три реда преди баркода — фиксираният свързващ текст
   „Библиотека при“, после организацията (читалището) от Настройки, после
   населеното място. Само свързващият текст е твърдо вписан в кода —
   организацията и мястото идват изцяло от Настройки, за да остане
   етикетът верен и за друга библиотека, не само за тази, за която е
   поискана тази подредба. */
test('printLabelsAll() показва „Библиотека при“ + организацията + мястото на три реда, когато „Организация“ е зададена', async () => {
  const dom = buildDom({
    'settings.get': {
      org: 'НЧ Васил Левски - 1922', lib_name: 'Читалищна библиотека',
      place: 'с. Яворец, общ. Габрово', lbl_mode: 'sheet', lbl_w: 40, lbl_h: 30
    },
    'books.list': [{ id: 1, inv_number: 1, barcode: '1', title: 'Кн1', status: 'наличен' }]
  });
  const { window } = dom;
  await settled(dom);

  window.doPrint = (html) => { window._printedHtml = html; };

  await window.printLabelsAll();

  const html = window._printedHtml;
  assert.match(html, /<div class="lh1">Библиотека при<\/div>/, 'първи ред: фиксираният свързващ текст');
  assert.match(html, /<div class="lh2">НЧ Васил Левски - 1922<\/div>/, 'втори ред: организацията от настройките');
  assert.match(html, /<div class="lh3">с\. Яворец, общ\. Габрово<\/div>/, 'трети ред: мястото от настройките');
  const i1 = html.indexOf('Библиотека при');
  const i2 = html.indexOf('НЧ Васил Левски');
  const i3 = html.indexOf('с. Яворец');
  assert.ok(i1 >= 0 && i1 < i2 && i2 < i3, 'редовете трябва да се появят в реда: свързващ текст, организация, място');
  assert.doesNotMatch(html, /Читалищна библиотека/,
    'при зададена „Организация“ „Наименование на библиотеката“ не се показва на етикета за фонд');
});

test('printLabelsAll() пада се към едноредово наименование от „Наименование на библиотеката“, когато „Организация“ не е зададена', async () => {
  const dom = buildDom({
    'settings.get': {
      org: '', lib_name: 'Самостоятелна селска библиотека',
      place: 'с. Пример', lbl_mode: 'sheet', lbl_w: 40, lbl_h: 30
    },
    'books.list': [{ id: 1, inv_number: 1, barcode: '1', title: 'Кн1', status: 'наличен' }]
  });
  const { window } = dom;
  await settled(dom);

  window.doPrint = (html) => { window._printedHtml = html; };

  await window.printLabelsAll();

  const html = window._printedHtml;
  assert.doesNotMatch(html, /Библиотека при/, 'без организация фиксираният свързващ текст не се показва');
  assert.match(html, /<div class="lh2">Самостоятелна селска библиотека<\/div>/,
    'наименованието на библиотеката остава на един ред, когато няма организация');
  assert.match(html, /<div class="lh3">с\. Пример<\/div>/, 'мястото продължава да се показва на трети ред');
});

/* --- „Запази PDF…“ и мащаб в прегледа преди печат (v1.72.0). Системният
   диалог на Windows не визуализира Electron съдържание — единственият начин
   библиотекарят да ВИДИ какво излиза е или прегледът в програмата, или
   готов PDF файл. ppSavePdf() праща името на документа към print:savePdf
   и затваря прегледа при успех; при отказ от диалога за запис не се показва
   грешка (отказът е нормално действие). */

test('ppSavePdf() праща името на документа към print:savePdf и затваря прегледа при успех', async () => {
  const dom = buildDom({
    'print.savePdf': { path: 'C:\\Users\\b\\Documents\\Инвентарна книга.pdf' }
  });
  const { window } = dom;
  await settled(dom);
  window.setPrintPage({ name: 'Инвентарна книга — проба', landscape: false });
  window.doPrint('<div class="pdoc"><h2>ПРОБА</h2></div>');
  assert.ok(window.document.getElementById('printPreview').classList.contains('on'),
    'прегледът трябва да е отворен след doPrint()');
  assert.ok(window.document.getElementById('ppPdfBtn'), 'бутонът „Запази PDF…“ трябва да съществува');
  await window.ppSavePdf();
  assert.ok(!window.document.getElementById('printPreview').classList.contains('on'),
    'при успешен запис прегледът се затваря');
});

test('ppSavePdf() при отказ от диалога оставя прегледа отворен и не показва грешка', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  // Мокът за api връща ok:true по подразбиране — тук е нужен изричен отказ.
  window.api = { print: { savePdf: async () => ({ ok: false, error: 'Отказано от потребителя.' }) } };
  const toasts = [];
  window.toast = (m, t) => toasts.push([t, m]);
  window.setPrintPage({ name: 'Проба' });
  window.doPrint('<div class="pdoc">х</div>');
  await window.ppSavePdf();
  assert.ok(window.document.getElementById('printPreview').classList.contains('on'),
    'при отказ прегледът остава отворен — библиотекарят може да продължи с „Печат…“');
  assert.equal(toasts.filter(t => t[0] === 'err').length, 0, 'отказът не е грешка');
});

test('мащабът на прегледа се показва в проценти и се движи по стъпките с +/−', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.setPrintPage({ name: 'Проба' });
  window.doPrint('<div class="pdoc">х</div>');
  // В jsdom няма реални размери (offsetWidth = 0) — „fit“ пада към 100%.
  await new Promise(r => setTimeout(r, 30));
  const pct = () => window.document.getElementById('ppZoomPct').textContent;
  window.ppZoom('fit');
  assert.equal(pct(), '100%');
  window.ppZoom(1);
  assert.equal(pct(), '125%', 'следващата стъпка нагоре след 100% е 125%');
  window.ppZoom(-1); window.ppZoom(-1);
  assert.equal(pct(), '85%', 'две стъпки надолу от 125% дават 85%');
});

test('подсказката в прегледа сочи към „Запази PDF…“, не към „Microsoft Print to PDF“', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.setPrintPage({ name: 'Проба' });
  window.doPrint('<div class="pdoc">х</div>');
  const hint = window.document.getElementById('ppHint').textContent;
  assert.match(hint, /Запази PDF/);
  assert.doesNotMatch(hint, /Microsoft Print to PDF/,
    'старата подсказка водеше през системния диалог, който е без визуализация');
});

/* --- Помощ и обратна връзка: имейл за съобщаване на грешки (v1.73.0) ---
   Настройки → нова карта с фиксирания имейл на разработчика. reportBug() отваря
   пощенския клиент през същия loans:mailto IPC канал, който вече валидира формата
   на адреса — тук се проверява само, че екранът показва картата и че бутоните
   подават правилно попълнено писмо/копие, не самата IPC валидация (вече покрита
   в test/handlers-notices.test.js). */

test('картата „Помощ и обратна връзка“ показва имейла на разработчика в Настройки', async () => {
  const dom = await settled(buildDom({ 'settings.get': { org: 'НЧ „Васил Левски 1922“', lib_name: '' } }));
  const { window } = dom;
  await window.renderSetup();
  const html = window.document.getElementById('view').innerHTML;
  assert.match(html, /plam4o\.4o@outlook\.com/, 'картата трябва да показва имейла plam4o.4o@outlook.com');
  assert.ok(window.document.querySelector('button[onclick="reportBug()"]'), 'трябва да има бутон „Съобщи за грешка…“');
  assert.ok(window.document.querySelector('button[onclick="copyDevEmail()"]'), 'трябва да има бутон „Копирай имейла“');
});

test('reportBug() отваря пощенския клиент с имейла на разработчика, версията и организацията', async () => {
  const calls = [];
  const dom = await settled(buildDom({}));
  const { window } = dom;
  // apiMock връща фиксирана нова заглушка при всеки достъп до window.api.<домейн> —
  // затова точковите проверки (напр. window.api.loans.mailto = fn) се губят при
  // следващото четене. Тук, както при ppSavePdf() по-горе, се подменя целият
  // window.api с обикновен обект.
  window.api = {
    app: { getVersion: async () => ({ ok: true, data: '1.73.0' }) },
    settings: { get: async () => ({ ok: true, data: { org: 'НЧ „Васил Левски 1922“', lib_name: 'Библиотека при читалището' } }) },
    loans: { mailto: async (opts) => { calls.push(opts); return { ok: true }; } }
  };
  const toasts = [];
  window.toast = (m, t) => toasts.push([t, m]);
  await window.reportBug();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].email, 'plam4o.4o@outlook.com');
  assert.match(calls[0].subject, /Инвентар/);
  assert.match(calls[0].subject, /1\.73\.0/, 'темата съдържа версията на програмата');
  assert.match(calls[0].body, /Библиотека при читалището/, 'тялото съдържа името на библиотеката за контекст');
  assert.doesNotMatch(calls[0].body, /BEGIN.*PRIVATE|password|парола/i, 'писмото не трябва да съдържа чувствителни данни по подразбиране');
  assert.equal(toasts.filter(t => t[0] === 'err').length, 0, 'успешното отваряне не е грешка');
});

test('reportBug() показва грешка от toast(), ако mailto: не се отвори (напр. невалиден адрес)', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  window.api = {
    app: { getVersion: async () => ({ ok: true, data: '1.73.0' }) },
    settings: { get: async () => ({ ok: true, data: {} }) },
    loans: { mailto: async () => ({ ok: false, error: 'Записаният имейл не изглежда валиден.' }) }
  };
  const toasts = [];
  window.toast = (m, t) => toasts.push([t, m]);
  await window.reportBug();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][0], 'err');
});

test('copyDevEmail() копира имейла на разработчика в системния буфер и потвърждава с toast()', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  const written = [];
  window.navigator.clipboard = { writeText: async (t) => { written.push(t); } };
  const toasts = [];
  window.toast = (m, t) => toasts.push([t, m]);
  await window.copyDevEmail();
  assert.deepEqual(written, ['plam4o.4o@outlook.com']);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][0], 'ok');
  assert.match(toasts[0][1], /plam4o\.4o@outlook\.com/);
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
  // v1.69.0: затварянето има кратка анимация — съдържанието се изчиства чак
  // след ~140 ms (вижте closeModal() в core.js), затова се изчаква преди проверката.
  await new Promise(r => setTimeout(r, 220));
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

/* --- 6. Празна лента „Покажи още“ не бива да оставя дупка ---
   #bMore/#rMore/#ibMore са постоянни контейнери, които се пълнят чак когато има
   скрити редове — при библиотека под 300 записа стоят празни. `.toolbar` носи
   margin-bottom:14px, затова празната лента оставяше празна ивица под всяка
   таблица: измерено в Chromium точно 14 px (височина на #view 3422 → 3408 px
   след правилото). Оттам `.toolbar:empty{display:none}` — правило, което всеки
   нов такъв контейнер получава наготово. */
test('style.css скрива празните ленти .toolbar (иначе оставят 14 px дупка)', () => {
  const css = fs.readFileSync(path.join(SRC_DIR, 'style.css'), 'utf8');
  assert.match(css, /\.toolbar:empty\s*\{[^}]*display\s*:\s*none/,
    'липсва .toolbar:empty{display:none} — празните ленти „Покажи още“ ще оставят дупка');
  // Правилото има смисъл само защото .toolbar носи долен отстъп.
  assert.match(css, /\.toolbar\s*\{[^}]*margin-bottom/);
});

test('лентите „Покажи още“ са празни, а не липсващи, при малък списък', async () => {
  const dom = await settled(buildDom({ 'invBook.list': invBookRows(10) }));
  const { window } = dom;
  await window.renderInvBook();
  const bar = window.document.querySelector('#ibMore');
  assert.ok(bar, 'контейнерът трябва да съществува, за да може „Покажи още“ да се появи по-късно');
  assert.equal(bar.innerHTML.trim(), '', 'при 10 реда няма какво да се показва още');
});

/* --- Преглед преди печат (v1.71.0) ---
   Системният печатен диалог на Windows не визуализира Electron прозорци
   („Това приложение не поддържа визуализация на печата“) — библиотекарят
   натискаше „Печат“ на сляпо. doPrint() вече показва документа на екрана
   (#printPreview) и вика window.print() чак след изричното „Печат…“. */

test('doPrint() показва преглед на екрана и НЕ вика window.print() преди потвърждение', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  let printed = 0;
  window.print = () => printed++;

  window.setPrintPage({ name: 'Тестов документ', landscape: false, margin: '14mm 12mm' });
  window.doPrint('<div class="pdoc"><h2>ТЕСТОВ ДОКУМЕНТ</h2></div>');

  const pp = window.document.getElementById('printPreview');
  assert.ok(pp.classList.contains('on'), 'прегледът трябва да се отвори');
  assert.match(window.document.getElementById('ppSheet').innerHTML, /ТЕСТОВ ДОКУМЕНТ/);
  assert.equal(window.document.getElementById('ppTitle').textContent, 'Тестов документ');
  assert.equal(printed, 0, 'window.print() не бива да тръгва преди бутона „Печат…“');
  // Листът на прегледа взима размера на страницата от setPrintPage.
  assert.equal(window.document.getElementById('ppSheet').style.width, '210mm');
});

test('бутонът „Печат…“ в прегледа затваря слоя, вика window.print() и връща заглавието на прозореца', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  const appTitle = window.document.title;
  let printed = 0;
  window.print = () => {
    printed++;
    assert.equal(window.document.title, 'Разписка проба', 'по време на печат заглавието е името на документа (име на PDF файла)');
  };

  window.setPrintPage({ name: 'Разписка проба', landscape: false, margin: '10mm' });
  window.doPrint('<div class="pdoc">съдържание</div>');
  window.ppPrint();

  assert.ok(!window.document.getElementById('printPreview').classList.contains('on'),
    'прегледът се затваря преди отварянето на системния диалог');
  await new Promise(r => setTimeout(r, 450)); // двоен rAF + 150 ms в ppPrint()
  assert.equal(printed, 1, 'window.print() трябва да се извика точно веднъж');
  assert.equal(window.document.title, appTitle, 'след печата заглавието се връща');
});

test('„Отказ“/Esc затварят прегледа, без изобщо да се стига до печат', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  let printed = 0;
  window.print = () => printed++;

  window.setPrintPage({ name: 'Документ', margin: '10mm' });
  window.doPrint('<div class="pdoc">x</div>');
  window.ppClose();
  assert.ok(!window.document.getElementById('printPreview').classList.contains('on'));

  window.doPrint('<div class="pdoc">y</div>');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!window.document.getElementById('printPreview').classList.contains('on'), 'Esc затваря прегледа');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(printed, 0);
});

test('extraCss от setPrintPage важи в прегледа, но ограничен до листа (#ppSheet), не за примерите на екрана', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settled(dom);
  window.print = () => {};

  window.setPrintPage({ name: 'Етикети', widthMm: 20, heightMm: 10, margin: '0mm',
    extraCss: '.lblsheet{display:block}.lbl{width:20mm;height:10mm}' });
  window.doPrint('<div class="pdoc"><div class="lblsheet"><div class="lbl">A</div></div></div>');

  const st = window.document.getElementById('ppExtraStyle').textContent;
  assert.match(st, /#ppSheet \.lblsheet\{/, 'правилата трябва да са с префикс #ppSheet');
  assert.match(st, /#ppSheet \.lbl\{/);
  assert.doesNotMatch(st, /(^|\})\s*\.lbl\{/, 'не бива да остава неограничено .lbl правило');
  const sheet = window.document.getElementById('ppSheet');
  assert.equal(sheet.style.width, '20mm', 'листът взима точния размер на ролката');
  assert.equal(sheet.style.minHeight, '10mm');
});

/* --- Карта за отделен читател (v1.71.0) --- */

test('printCardOne() печата карта САМО за посочения читател (бутонът „Карта“ на реда)', async () => {
  const dom = buildDom({
    'readers.get': { id: 9, name: 'Георгиева, Мария', card_no: 'B00108', category: 'възрастен',
      registered_at: '2026-01-10', status: 'активен' },
    'settings.get': { lib_name: 'Библиотека', place: 'Село', card_w: 90, card_h: 60 }
  });
  const { window } = dom;
  await settled(dom);
  const printed = [];
  window.doPrint = (html) => printed.push(html);

  await window.printCardOne(9);

  assert.equal(printed.length, 1);
  assert.match(printed[0], /Георгиева, Мария/);
  const cards = (printed[0].match(/class="lbl rcard"/g) || []).length;
  assert.equal(cards, 1, 'точно една карта — не всички');
});

test('списъкът Читатели има бутон „Карта“ на всеки ред', async () => {
  const dom = buildDom({
    'readers.list': [{ id: 3, name: 'Иванов, Иван', card_no: 'B00001', category: 'възрастен', status: 'активен' }]
  });
  const { window } = dom;
  await settled(dom);
  await window.renderReaders();
  const btn = window.document.querySelector('#rBody button[onclick="printCardOne(3)"]');
  assert.ok(btn, 'редът трябва да предлага печат на картата на конкретния читател');
});

/* --- Редакция на книга — само от Инвентарна книга, с изрично потвърждение (v1.71.0) --- */

test('списъкът Книги вече НЯМА бутон „Редакция“ на ред (редакцията е в Инвентарна книга)', async () => {
  const dom = buildDom({
    'books.list': [{ id: 5, inv_number: 5, title: 'Книга', status: 'наличен', quantity: 1, available: 1 }]
  });
  const { window } = dom;
  await settled(dom);
  await window.renderBooks();
  const rows = window.document.getElementById('bBody').innerHTML;
  assert.doesNotMatch(rows, /bookForm\(\d/, 'редовете не бива да отварят формата за редакция');
  assert.match(rows, /deleteBook\(5\)/, 'изтриването остава на реда');
  // „+ Нова книга“ (без id) остава в лентата.
  assert.ok(window.document.querySelector('#view button[onclick="bookForm()"]'), 'добавянето на нова книга остава');
});

test('Инвентарна книга: „Редакция“ иска изрично потвърждение и отваря формата само при съгласие', async () => {
  const dom = buildDom({
    'invBook.list': [{ id: 7, inv_number: 7, author: 'Вазов', title: 'Под игото', status: 'наличен',
      register_date: '2026-01-05', price: 12, checks: [] }],
    'books.get': { id: 7, inv_number: 7, title: 'Под игото', author: 'Вазов', status: 'наличен' }
  });
  const { window } = dom;
  await settled(dom);
  await window.renderInvBook();

  const btn = window.document.querySelector('#ibBody button[onclick="invBookEdit(7)"]');
  assert.ok(btn, 'редът в инвентарната книга трябва да има бутон „Редакция“');

  // Отказ — формата не се отваря.
  let asked = '';
  window.confirm = (msg) => { asked = msg; return false; };
  window.invBookEdit(7);
  assert.match(asked, /ИНВЕНТАРНАТА КНИГА/, 'съобщението назовава изрично инвентарната книга');
  assert.match(asked, /Под игото/, 'съобщението назовава конкретния запис');
  assert.ok(!window.document.querySelector('#veil').classList.contains('on'), 'при отказ формата не се отваря');

  // Съгласие — формата се отваря.
  window.confirm = () => true;
  window.invBookEdit(7);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(window.document.querySelector('#veil').classList.contains('on'), 'при съгласие се отваря формата за редакция');
  assert.ok(window.document.querySelector('#bookF'), 'отворена е именно формата за книга');
});
