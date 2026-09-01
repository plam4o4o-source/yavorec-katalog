'use strict';
/* Одит v2.4.14 — ОФИЦИАЛНИТЕ РАЗПЕЧАТКИ.

   Защо този файл съществува. Одитът на самия тестов пакет намери, че екранният
   слой е практически непокрит: върнах цялата поправка на v2.4.13 (actQty() и
   acqQty() да връщат 1, тоест актът пак да брои заглавия вместо документи) и
   поредицата от 981 теста остана НАПЪЛНО ЗЕЛЕНА. Нито един тест не споменаваше
   printActDoc, actCount, acqCount, drawActList или printDonationDoc; единственият,
   който изглеждаше като покритие, проверяваше отговора на IPC канала, докато
   името му обещаваше да пази разпечатката.

   А това са точно документите, по които институцията се отчита: актът по чл. 35,
   протоколът по чл. 3, ал. 2 и редовете, които влизат в Книгата за движение на
   фонда. Затова тук се проверява САМИЯТ HTML, който отива в прегледа преди печат
   — не отговорът на handler-а, не пресметната наново формула.

   Всеки тест в този файл пада върху кода отпреди поправката. */
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

/* Мокът на window.api: всяко извикване връща { ok:true, data }, взето от таблица
   по име на канала („deaccessionActs.get“). Непокритите канали връщат null —
   изгледите ги толерират. */
function apiMock(overrides) {
  function node(parts) {
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return node(parts.concat(prop));
      },
      apply(t, self, args) {
        const key = parts.join('.');
        const v = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
        return Promise.resolve({ ok: true, data: typeof v === 'function' ? v(args) : v });
      }
    });
  }
  return node([]);
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
  const { window } = dom;
  window.api = apiMock(overrides || {});
  window.confirm = () => true;
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
const settle = () => new Promise(r => setTimeout(r, 30));
// Текстът, който наистина отива в прегледа преди печат (doPrint пълни #ppSheet).
const printedText = (window) => window.document.querySelector('#ppSheet').textContent.replace(/\s+/g, ' ');

/* Три заглавия по 3 екземпляра, по 10 лв. — най-простият случай, при който
   „заглавия“ и „документи“ се разминават видимо: 3 срещу 9 и 30 срещу 90 лв. */
const ACT_3x3 = {
  id: 1, no: 4, year: '2026', date: '2026-03-01', reason_code: 1, reason_text: 'изхабени',
  disposal: 'предадени за вторични суровини', committee1: 'А', committee2: 'Б', committee3: 'В',
  items: [
    { inv_number: 101, author: 'Вазов', title: 'Под игото', year: '1894', price: 10, quantity: 3 },
    { inv_number: 102, author: 'Ботев', title: 'Стихотворения', year: '1875', price: 10, quantity: 3 },
    { inv_number: 103, author: 'Славейков', title: 'Епика', year: '1907', price: 10, quantity: 3 }
  ]
};

test('актът по чл. 35 брои ДОКУМЕНТИ и умножава цената по бройката', async () => {
  const dom = buildDom({ 'deaccessionActs.get': ACT_3x3, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printActDoc(1);
  await settle();
  const t = printedText(window);
  assert.match(t, /отчислява от библиотечния фонд 9 библиотечни документа/,
    'актът трябва да брои 9 документа (3 заглавия по 3 екземпляра), не 3');
  assert.match(t, /\(3 заглавия\)/, 'броят заглавия трябва да е изписан, за да няма съмнение кое се брои');
  assert.ok(t.includes('90.00'), 'общата стойност е 3 × 3 × 10 = 90 лв., а не 30');
  assert.ok(!/обща стойност 30\.00 лв/.test(t), 'старото число (сбор от единични цени) не бива да се появява');
  assert.match(t, /3 × 10\.00/, 'всеки ред трябва да носи означението за бройка');
});

test('екранът за съставяне на акта показва СЪЩИТЕ числа, които ще влязат в акта', async () => {
  /* Това е находката, заради която файлът съществува: библиотекарят сглобяваше
     акта на екран, който казва „ОБЩО 3 документа, 30.00 лв.“, натискаше „Утвърди
     акта и отчисли“ и получаваше потвърждение „отчислени са 3 документа“ — а от
     фонда излизаха 9 документа за 90 лв. и точно това пишеше в акта, който отива
     при счетоводителя. */
  const dom = buildDom({
    'settings.get': {},
    'deaccessionActs.nextNo': 4,
    // findBook връща и fund_qty — суровата бройка от inventory, същата, която
    // deaccessionActs:create снима в акта.
    'deaccessionActs.findBook': (args) => ({
      id: Number(args[0]), inv_number: Number(args[0]), author: 'Вазов', title: 'Под игото',
      year: '1894', price: 10, quantity: 3, available: 3, fund_qty: 3
    })
  });
  const { window } = dom;
  await settle();
  await window.actForm();
  await new Promise(r => setTimeout(r, 120));
  for (const code of ['101', '102', '103']) {
    window.document.querySelector('#actScan').value = code;
    await window.actAdd();
    await settle();
  }
  const list = window.document.querySelector('#actList').textContent.replace(/\s+/g, ' ');
  assert.match(list, /ОБЩО 9 документа/, 'екранът трябва да брои документи, както ги брои актът');
  assert.match(list, /\(3 заглавия\)/);
  assert.ok(list.includes('90.00'), 'сборът на екрана трябва да е Σ(цена × бройка) = 90 лв.');
  assert.ok(!/ОБЩО 3 документа/.test(list), 'старото броене по заглавия не бива да остава');
});

test('ред с изрично 0 екземпляра се вижда като такъв и пояснението „N заглавия“ не изчезва', async () => {
  /* Случаят, при който старото условие (actCount !== items.length) съвпада
     СЛУЧАЙНО: 0 + 2 = 2 документа при 2 заглавия. Пояснението изчезваше точно
     когато е най-нужно, а в таблицата оставаше ред с цена, който не участва нито
     в бройката, нито в сбора — необяснен ред в подписан документ. */
  const act = Object.assign({}, ACT_3x3, {
    items: [
      { inv_number: 201, author: 'А', title: 'Нулев', year: '1990', price: 10, quantity: 0 },
      { inv_number: 202, author: 'Б', title: 'Двоен', year: '1991', price: 10, quantity: 2 }
    ]
  });
  const dom = buildDom({ 'deaccessionActs.get': act, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printActDoc(1);
  await settle();
  const t = printedText(window);
  assert.match(t, /2 библиотечни документа/);
  assert.match(t, /\(2 заглавия\)/, 'пояснението трябва да се появи при смесени бройки, дори числата да съвпадат');
  assert.match(t, /0 × 10\.00/, 'нулевият ред трябва да е изрично означен, а не да изглежда като обикновена цена');
});

test('протоколът за придобиване: редът ОБЩО е равен на сбора на собствената си колона', async () => {
  /* „ПРОТОКОЛ за придобиване без съпроводителен документ“ се подрежда като
     ЗАМЕСТВАЩ първичен счетоводен документ по чл. 3, ал. 2. Редът ОБЩО вече беше
     Σ(цена × бройка), но всеки ред печаташе гола единична цена и в таблицата
     нямаше нито колона за бройка, нито означение: колоната се сумираше на 15 лв.,
     а редът ОБЩО казваше 40. */
  const acq = {
    id: 7, no: 2, year: '2026', date: '2026-02-02', how: 'закупуване', from_source: 'Книжарница',
    doc_type: 'без документ', doc_no: '—', doc_date: '2026-02-02', total_count: 6, sum: null,
    items: [
      { inv_number: 301, author: 'А', title: 'Първа', year: '2020', price: 10, fund_qty: 3 },
      { inv_number: 302, author: 'Б', title: 'Втора', year: '2021', price: 5, fund_qty: 2 }
    ]
  };
  const dom = buildDom({ 'acquisitions.get': acq, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printAcqNoDocDoc(7);
  await settle();
  const t = printedText(window);
  assert.match(t, /ОБЩО 5 документа/, 'редът ОБЩО трябва да казва и колко документа са това');
  assert.match(t, /3 × 10\.00/, 'редът трябва да показва бройката, за да се сумира визуално до ОБЩО');
  assert.match(t, /2 × 5\.00/);
  assert.ok(t.includes('40.00'), 'Σ(цена × бройка) = 3×10 + 2×5 = 40 лв.');
});

test('актът за дарение също показва бройките в таблицата си', async () => {
  const acq = {
    id: 8, no: 3, year: '2026', date: '2026-02-03', how: 'дарение', from_source: 'Дарител',
    donor_address: 'с. Яворец', doc_type: 'дарение', doc_no: '1', doc_date: '2026-02-03',
    total_count: 4, sum: null,
    items: [{ inv_number: 401, author: 'В', title: 'Дарена', year: '2019', price: 7, fund_qty: 4 }]
  };
  const dom = buildDom({ 'acquisitions.get': acq, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printDonationDoc(8);
  await settle();
  const t = printedText(window);
  assert.match(t, /ОБЩО 4 документа/);
  assert.match(t, /4 × 7\.00/);
  assert.ok(t.includes('28.00'), '4 × 7 = 28 лв.');
});

test('баркод, който не може да бъде отпечатан вярно, се заменя с предупреждение', async () => {
  /* code39svg() вдигаше регистъра и мълчаливо изхвърляше всичко извън азбуката на
     Code 39 — тоест кирилицата. Читателска карта „Ч-1042“ се отпечатваше като
     баркод, кодиращ „-1042“, докато под него човешки се четеше „Ч-1042“: четецът
     връща низ, който readers:byCard не намира, и картата просто „не работи“. */
  const dom = buildDom({});
  const { window } = dom;
  await settle();
  const bad = window.eval('code39svg("Ч-1042", 200, 34)');
  assert.ok(!/<rect/.test(bad), 'не бива да се чертае баркод, който кодира друг низ');
  assert.match(bad, /не може да се отпечата като баркод/);
  assert.ok(bad.includes('Ч-1042'), 'предупреждението трябва да казва за кой номер става дума');

  const good = window.eval('code39svg("INV-1042", 200, 34)');
  assert.match(good, /<rect/, 'съвместим номер се чертае както преди');
  assert.ok(!/не може да се отпечата/.test(good));
  assert.equal(window.eval('code39Fits("ЧИТ-1")'), false);
  assert.equal(window.eval('code39Fits("CIT-1")'), true);
  assert.equal(window.eval('code39Fits("cit-1")'), false, 'малките букви също се променят при печат');
});

test('csvSafe в екранния слой е точно копие на csvCell от security-utils.js', () => {
  /* Изнасянето на одитната следа беше ЕДИНСТВЕНОТО, което преизмисляше
     цитирането на място и не неутрализираше водещите = + - @ — а точно този файл
     инспекторът от регионалната библиотека най-вероятно ще отвори в Excel. Двете
     реализации се сравняват по поведение, за да не се разминат отново. */
  const { csvCell } = require('../security-utils');
  const dom = buildDom({});
  const { window } = dom;
  const cases = ['=1+1', '+ok', '-5', '@x', 'обикновен текст', 'с "кавички"', '', null, '\tтаб'];
  for (const c of cases) {
    assert.equal(window.eval('csvSafe(' + JSON.stringify(c) + ')'), csvCell(c),
      'csvSafe и csvCell трябва да дават еднакъв резултат за ' + JSON.stringify(c));
  }
  const src = fs.readFileSync(path.join(VIEWS_DIR, 'audit.js'), 'utf8');
  assert.match(src, /\.map\(csvSafe\)/, 'изнасянето на одитната следа минава през csvSafe');
});

/* ---- дефекти, намерени в самите поправки (повторен одит) ---- */

test('протоколът остава вътрешно съгласуван и когато е обявена отделна обща стойност', async () => {
  /* Дефект, който САМАТА поправка внесе: редът ОБЩО ползваше `a.sum || …`, тоест
     обявената от библиотекаря стойност по документа, докато новата колона показва
     Σ(цена × бройка). Преди поправката таблицата нямаше колона за бройка и
     противоречието не се виждаше на хартия — новата колона го изкара наяве в
     заместващ първичен счетоводен документ по чл. 3, ал. 2. */
  const acq = {
    id: 9, no: 4, year: '2026', date: '2026-02-04', how: 'закупуване', from_source: 'Книжарница',
    doc_type: 'без документ', doc_no: '—', doc_date: '2026-02-04', total_count: 5,
    sum: 25, // библиотекарят е обявил 25 лв., а редовете дават 40 лв.
    items: [
      { inv_number: 501, author: 'А', title: 'Първа', year: '2020', price: 10, fund_qty: 3 },
      { inv_number: 502, author: 'Б', title: 'Втора', year: '2021', price: 5, fund_qty: 2 }
    ]
  };
  const dom = buildDom({ 'acquisitions.get': acq, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printAcqNoDocDoc(9);
  await settle();
  const t = printedText(window);
  // Редът ОБЩО е сборът на СОБСТВЕНАТА си колона: 3×10 + 2×5 = 40.
  assert.match(t, /ОБЩО 5 документа\s*40\.00/, 'редът ОБЩО трябва да отговаря на колоната над него');
  // А разминаването с обявената стойност е изписано, вместо да мълчи.
  // v2.4.17 преформулира реда („обявената при завеждането стойност…“), затова се
  // проверява ТВЪРДЕНИЕТО, а не точната редакция.
  assert.match(t, /обявената[\s\S]{0,40}стойност[\s\S]{0,80}се различава от/,
    'разликата трябва да е обяснена в самия документ');
  assert.ok(t.includes('25.00'), 'обявената стойност също се вижда — тя е част от документа');
});

test('полетата ЕГН/№ ЛК са заключени, когато защитата е негодна, не само когато е заключена', async () => {
  /* Ключалка №1 има две половини: главният процес връща unlocked:false, а екранът
     трябва да НАПРАВИ нещо с това. Втората половина не се пазеше от нищо — можеше
     да бъде изключена с напълно зелен пакет, и тогава полето стои редактируемо с
     плейсхолдър вътре, тоест критичната находка се връща. */
  const dom = buildDom({
    'readers.get': { id: 5, name: 'Иван', egn: 'Защитени данни (ключът не съвпада)', id_card_no: '', category: 'възрастен', status: 'активен' },
    'pdp.status': { configured: true, unlocked: false, stale: true },
    'circRules.list': [], 'settings.get': {}
  });
  const { window } = dom;
  await settle();
  await window.readerForm(5);
  await settle();
  const egn = window.document.querySelector('#readerF [name=egn]');
  assert.ok(egn, 'полето трябва да съществува');
  assert.equal(egn.disabled, true, 'при негодна защита полето ЕГН трябва да е заключено за редакция');
  const idc = window.document.querySelector('#readerF [name=id_card_no]');
  assert.equal(idc.disabled, true);

  // А при изправна, отключена защита полето е редактируемо както преди.
  const dom2 = buildDom({
    'readers.get': { id: 5, name: 'Иван', egn: '7001011234', id_card_no: '', category: 'възрастен', status: 'активен' },
    'pdp.status': { configured: true, unlocked: true, stale: false },
    'circRules.list': [], 'settings.get': {}
  });
  await settle();
  await dom2.window.readerForm(5);
  await settle();
  assert.equal(dom2.window.document.querySelector('#readerF [name=egn]').disabled, false);
});
