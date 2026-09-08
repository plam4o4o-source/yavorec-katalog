'use strict';
/* v2.4.40 — Таблицата на УДК: цялата схема + общи определители.
   =====================================================================
   Данните са в src/udk.json (официалният съкратен указател, ~1900 кода и 739
   определителя), а src/udk.js се ПРАВИ от него с tools/build-udk.js. Тук се
   проверява:

   • двата файла не могат да се разминат незабелязано;
   • нито един код от досегашната таблица не е изчезнал — иначе заварен запис
     във фонда остава с код, който вече го няма в избора;
   • дървото следва самата класификация (детето продължава кода на родителя);
   • ТЪРСЕНЕТО минава и през списъците „Включва:“ — там е думата, която човек
     ще напише („пчеларство“ го няма в заглавието на 638);
   • съставният код се СГЛОБЯВА („94“ + „(497.2)“), защото изданието не носи
     такива кодове наготово.

   Всеки тест е проверен с мутация (виж описанието на кръга в CHANGELOG). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { APP_DIR, cleanupTmpDirs, buildDom, settle } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

const SRC = path.join(APP_DIR, 'src');
const DATA = JSON.parse(fs.readFileSync(path.join(SRC, 'udk.json'), 'utf8'));
const BUILT = fs.readFileSync(path.join(SRC, 'udk.js'), 'utf8');
const builder = require(path.join(APP_DIR, 'tools', 'build-udk.js'));

/* Готовият файл се чете в собствен обхват — той обявява константи в глобалния,
   както го зарежда и самата страница. Прекопирва се през JSON нарочно: масивите,
   направени вътре в vm, са от ДРУГ обхват и deepEqual ги брои за различни. */
function loadBuilt() {
  const ctx = vm.createContext({});
  vm.runInContext(BUILT + ';this.T=UDK_TREE;this.A=UDK_AUX;this.Q=UDK_QUICK;', ctx);
  return JSON.parse(JSON.stringify({ tree: ctx.T, aux: ctx.A, quick: ctx.Q }));
}
const { tree: TREE, aux: AUX, quick: QUICK } = loadBuilt();

function walk(nodes, fn, parent) {
  for (const n of nodes) { fn(n, parent); walk(n[3], fn, n); }
}
const allNodes = () => { const a = []; walk(TREE, n => a.push(n)); return a; };
const codeSet = () => new Set(allNodes().map(n => n[0]));

test('правеният src/udk.js съвпада точно с това, което генераторът прави от src/udk.json', () => {
  /* Ако някой поправи наименование направо в udk.js, следващото пускане на
     генератора мълчаливо ще го върне назад. Затова разминаването е ГРЕШКА, а
     поправките се правят в JSON. */
  assert.equal(BUILT, builder.render(DATA),
    'src/udk.js е остарял или пипан на ръка — пуснете „node tools/build-udk.js“ и поправете src/udk.json');
});

test('нито един код от досегашната таблица не е изчезнал от избора', () => {
  /* Заварените записи във фонда носят точно тези кодове. Ако някой отпадне,
     библиотекарят вече няма как да го избере наново. */
  const before = ['0', '001', '004', '005', '006', '01', '02', '030', '050', '06', '070', '08', '09',
    '1', '11', '13', '14', '159.9', '16', '17',
    '2', '21', '23/28', '271.2', '29',
    '3', '30', '31', '32', '33', '34', '35', '36', '37', '39',
    '5', '50', '51', '52', '53', '54', '55', '56', '57', '58', '59',
    '6', '61', '62', '63', '64', '65', '66', '67/68', '69',
    '7', '71', '72', '73', '74', '75', '76', '77', '78', '791', '792', '793', '794', '796/799',
    '8', '80', '81', '811.111', '811.161.1', '811.163.2', '82', '82-1', '82-2', '82-3', '82-31',
    '82-32', '82-4', '82-5', '82-6', '82-93', '821.111', '821.112.2', '821.131.1', '821.133.1',
    '821.134.2', '821.14', '821.161.1', '821.163.2', '821.163.2-1', '821.163.2-31',
    '821.163.2-32', '821.163.2-93', '821.163.3', '821.163.41', '821.512.161',
    '9', '902/904', '908', '91', '913', '929', '93/94', '94(100)', '94(4)', '94(497.2)'];
  const have = codeSet();
  assert.deepEqual(before.filter(c => !have.has(c)), [], 'изчезнали кодове');
});

test('цялото издание е вътре, с деветте класа и без измислен клас 4', () => {
  const have = codeSet();
  for (const e of DATA.entries) assert.ok(have.has(e.code), 'липсва код от изданието: ' + e.code);
  for (const e of DATA.additions) assert.ok(have.has(e.code), 'липсва допълнение: ' + e.code);
  assert.equal(have.size, DATA.entries.length + DATA.additions.length);
  assert.ok(have.size > 1900, 'очаквах цялата схема, намерени ' + have.size);
  assert.deepEqual(TREE.map(n => n[0]), ['0', '1', '2', '3', '5', '6', '7', '8', '9'],
    'класовете на УДК са тези девет — 4 е освободен и не се измисля');
});

test('дървото следва класификацията: детето продължава кода на родителя', () => {
  /* Това е самата подредба на схемата: „821.163.2“ стои под „821.163“, а не под
     „8“ и не някъде отстрани. Ако родителят се сметне по друг признак (по точки,
     по дължина), дървото изглежда наред, но развежда човека в грешен клон. */
  let checked = 0;
  walk(TREE, (n, parent) => {
    if (!parent) return;
    checked++;
    assert.ok(n[0].startsWith(parent[0]),
      'кодът „' + n[0] + '“ е под чужд родител „' + parent[0] + '“');
    assert.ok(n[0].length > parent[0].length);
  });
  assert.ok(checked > 1800, 'проверени ' + checked + ' връзки');

  // И родителят е НАЙ-ДЪЛГИЯТ подходящ: между дете и родител няма пропуснат код.
  const have = codeSet();
  walk(TREE, (n, parent) => {
    if (!parent) return;
    for (let i = parent[0].length + 1; i < n[0].length; i++) {
      assert.equal(have.has(n[0].slice(0, i)), false,
        '„' + n[0].slice(0, i) + '“ е пропуснат между „' + parent[0] + '“ и „' + n[0] + '“');
    }
  });
});

test('всеки код е само на едно място и братята са подредени по УДК', () => {
  const seen = new Set();
  walk(TREE, (n) => {
    assert.equal(seen.has(n[0]), false, 'кодът „' + n[0] + '“ се повтаря');
    seen.add(n[0]);
  });
  /* Кодът НЕ е число: „82“ и „821“ са два и три знака на едно ниво. Знаците на
     УДК се нареждат в Unicode точно в реда, в който се четат и на рафта:
     ( < - < . < / < цифрите. */
  const sibs = (nodes) => {
    const codes = nodes.map(n => n[0]);
    assert.deepEqual(codes, [...codes].sort(), 'неподредени братя: ' + codes.slice(0, 6).join(' '));
    for (const n of nodes) sibs(n[3]);
  };
  sibs(TREE);
  const lit = (TREE.find(n => n[0] === '8')[3].find(n => n[0] === '82') || ['', '', '', []])[3].map(n => n[0]);
  assert.ok(lit.indexOf('82-93') < lit.indexOf('82.02'), '„82-93“ трябва да е преди „82.02“: ' + lit.join(' '));
});

test('заглавието и списъкът „Включва:“ са разделени — по едното се чете, по другото се търси', () => {
  const n638 = allNodes().find(n => n[0] === '638');
  assert.ok(n638, 'липсва код 638');
  assert.equal(/Включва/.test(n638[1]), false, 'заглавието не бива да носи списъка: ' + n638[1]);
  assert.match(n638[2], /Пчеларство/, 'списъкът „Включва“ трябва да е запазен — по него се търси');
  assert.deepEqual(builder.splitLib('Заглавие Включва: едно. друго'), ['Заглавие', 'едно. друго']);
  assert.deepEqual(builder.splitLib('Само заглавие'), ['Само заглавие', '']);
});

test('допълненията извън изданието са отбелязани и са същите като в JSON', () => {
  const added = allNodes().filter(n => n[4] === 1).map(n => n[0]).sort();
  assert.deepEqual(added, DATA.additions.map(e => e.code).sort());
  const fromEdition = new Set(DATA.entries.map(e => e.code));
  for (const c of added) assert.equal(fromEdition.has(c), false, c + ' идва от изданието, не е допълнение');
  // Бързите препратки са точно допълненията — те са причината да съществуват.
  assert.deepEqual(QUICK.map(q => q[0]).sort(), added);
});

test('общите определители са отделени от основната таблица', () => {
  const total = AUX.reduce((s, a) => s + a[1].length, 0);
  assert.equal(total, DATA.auxiliary_entries.length, 'очаквах всички определители, намерени ' + total);
  assert.ok(AUX.length >= 6, 'спомагателните таблици са шест и повече: ' + AUX.length);
  const main = codeSet();
  for (const [name, rows] of AUX) {
    assert.ok(name && rows.length, 'празна таблица ' + name);
    for (const [code] of rows) {
      assert.equal(main.has(code), false, 'определителят „' + code + '“ е влязъл в основната таблица');
    }
  }
  const place = AUX.find(a => /Място/.test(a[0]));
  assert.ok(place && place[1].some(r => r[0] === '(497.2)'), 'липсва определителят за България');
  const lang = AUX.find(a => /Език/.test(a[0]));
  assert.ok(lang && lang[1].some(r => r[0] === '=163.2'), 'липсва определителят за български език');
});

test('файлът казва откъде идва таблицата и как е проверен лицензът', () => {
  /* Условие на лиценза: УДК Summary се разпространява СЪС посочване на източника.
     Отделно се пази и следата от проверката — подаденият файл твърдеше
     „CC BY-NC 4.0“, а NonCommercial е несъвместим с GPL-3.0 и би означавал, че
     таблицата изобщо не може да стои в хранилището. */
  assert.match(BUILT, /UDC Consortium/, 'липсва посочване на източника');
  assert.match(BUILT, /Attribution-ShareAlike 3\.0/, 'липсва лицензът');
  assert.match(BUILT, /НЕ СЕ РЕДАКТИРА НА РЪКА/, 'липсва предупреждението, че файлът е правен');
  assert.equal(DATA.meta.license, 'CC BY-SA 3.0');
  assert.match(DATA.meta.license_check, /NonCommercial/, 'липсва следата от проверката в данните');
  assert.match(DATA.meta.license_check, /GPL-3\.0/);
  /* Следата трябва да пътува И с правения файл, а не само в JSON: тя е причината
     да пише CC BY-SA 3.0, при положение че подаденият файл твърдеше друго. */
  assert.match(BUILT, /NonCommercial/, 'липсва следата от проверката в самия src/udk.js');
  assert.match(BUILT, /GPL-3\.0/, 'липсва защо NonCommercial би бил проблем');
});

test('генераторът пада с ясна грешка, ако свободен текст от JSON би затворил коментара на udk.js', () => {
  /* Намерено при прегледа на предишния кръг (v2.4.41) и запазено тук: полетата
     based_on/license_note/license_check/additions_note отиват СУРОВИ в
     единствения блоков коментар на header-а. Звезда-наклонена черта в тях
     затваря коментара там, а следваща наклонена-звезда по-надолу го отваря пак —
     между двете застава суров, изпълним JavaScript в готовия файл, зареждан
     направо с <script> без модул. */
  const marker = '*' + '/' + 'window.pwn=1;' + '/' + '*';
  for (const field of ['based_on', 'license_note', 'license_check']) {
    const bad = JSON.parse(JSON.stringify(DATA));
    bad.meta[field] += ' (виж ' + marker + ')';
    assert.throws(() => builder.render(bad), /затворило|коментар/,
      'полето „' + field + '“ трябва да спре правенето, а не да остави суров код в изхода');
  }
  const badNote = JSON.parse(JSON.stringify(DATA));
  badNote.additions_note += ' ' + marker;
  assert.throws(() => builder.render(badNote), /затворило|коментар/);
  assert.doesNotMatch(BUILT, /window\.pwn/, 'в готовия файл никога не бива да има инжектиран код');
});

test('непозната спомагателна таблица не се изхвърля мълчаливо', () => {
  /* Ако утрешно издание донесе таблица, която генераторът не познава, тя трябва
     да излезе под „Други определители“, а не да изчезне без следа — мълчаливата
     загуба на данни е по-лоша от неудобното наименование. */
  const out = builder.auxOf({ auxiliary_entries: [
    { code: '(Ж1)', lib: 'Измислен определител Включва: нещо', tip: 'определител-непознат' }
  ] });
  const other = out.find(a => /Други/.test(a[0]));
  assert.ok(other, 'непознатата таблица трябва да излезе под „Други определители“');
  assert.deepEqual(other[1], [['(Ж1)', 'Измислен определител', 'нещо']]);
});

/* ---------------- екранът ---------------- */
const FORM_DEPS = { 'categories.list': [], 'authorities.values': [], 'books.suggestions': {}, 'shelves.list': [],
  'books.get': { id: 1, inv_number: 1, title: 'Т', status: 'наличен' } };

async function openPicker(extra) {
  const dom = buildDom({ ...FORM_DEPS, ...(extra || {}) });
  const { window } = dom;
  await settle();
  await window.bookForm(1);
  await settle();
  const t0 = Date.now();
  window.udkPicker();
  const ms = Date.now() - t0;
  await settle();
  return { dom, window, d: window.document, ms };
}
const vis = (d, sel) => [...d.querySelectorAll(sel)].filter(e => e.style.display !== 'none');

test('прозорецът показва деветте класа свити, а разгръщането отваря подразделите', async () => {
  const { window, d, ms } = await openPicker();
  /* Цялата схема се сглобява наведнъж — ако това стане бавно, прозорецът увисва
     при всяко отваряне на нова книга. */
  assert.ok(ms < 4000, 'прозорецът се сглоби за ' + ms + ' ms');

  const tops = d.querySelectorAll('#udkList > .udkNode.udkTop');
  assert.equal(tops.length, 9, 'деветте класа');
  assert.equal(d.querySelectorAll('#udkList .udkNode').length, codeSet().size, 'всички кодове са в дървото');
  assert.equal(d.querySelectorAll('#udkList .udkNode.on').length, 0, 'в началото всичко е свито');

  const eight = d.querySelector('.udkNode[data-code="8"]');
  eight.querySelector('.udkRow').click();
  assert.equal(eight.classList.contains('on'), true, 'натискането разгръща класа');
  assert.equal(eight.querySelector('.udkTw').textContent, '▾');
  eight.querySelector('.udkRow').click();
  assert.equal(eight.classList.contains('on'), false, 'второто натискане го свива');

  // Ред без подраздели се ИЗБИРА направо, а не се опитва да се разгръща.
  const leaf = [...d.querySelectorAll('#udkList .udkNode')].find(n => !n.querySelector(':scope > .udkKids'));
  leaf.querySelector('.udkRow').click();
  assert.equal(d.getElementById('udkB').textContent, leaf.dataset.code);
  window.closeModal2();
});

test('търсенето намира и по „Включва:“, показва пътя и казва колко е намерило', async () => {
  const { window, d } = await openPicker();
  /* „Пчеларство“ го няма в заглавието на 638 („Отглеждане и развъждане на
     насекоми“) — стои в списъка „Включва“. Само по заглавията това търсене
     връща нищо, а библиотекарката ще напише точно тази дума. */
  d.getElementById('udkQ').value = 'пчеларство';
  window.udkFilter();
  const shown = vis(d, '#udkList .udkNode');
  assert.deepEqual(shown.map(n => n.dataset.code), ['6', '63', '638'],
    'трябва да се види целият път до намереното: ' + shown.map(n => n.dataset.code).join(' '));
  assert.equal(d.querySelector('.udkNode[data-code="638"]').classList.contains('udkHit'), true);
  assert.equal(d.querySelector('.udkNode[data-code="63"]').classList.contains('on'), true, 'пътят се отваря');
  assert.match(d.getElementById('udkHits').textContent, /1 намерен ред/);
  assert.equal(d.getElementById('udkNone').style.display, 'none');

  // Търсене по код работи също.
  d.getElementById('udkQ').value = '821.163.2';
  window.udkFilter();
  assert.ok(vis(d, '#udkList .udkNode.udkHit').length >= 1, 'по код не намери нищо');

  d.getElementById('udkQ').value = 'няматакъвраздел';
  window.udkFilter();
  assert.equal(vis(d, '#udkList .udkNode.udkHit').length, 0);
  assert.notEqual(d.getElementById('udkNone').style.display, 'none', 'липсва съобщението „няма намерен раздел“');
  assert.equal(d.getElementById('udkHits').textContent, '');

  d.getElementById('udkQ').value = '';
  window.udkFilter();
  assert.equal(vis(d, '#udkList .udkNode').length, codeSet().size, 'изчистеното търсене връща всички');
  assert.equal(d.querySelectorAll('#udkList .udkNode.on').length, 0, 'и ги свива обратно');
  window.closeModal2();
});

test('съставният код се сглобява: „94“ + „(497.2)“ → „94(497.2)“', async () => {
  const { window, d } = await openPicker();
  assert.equal(d.getElementById('udkTake').disabled, true, 'без избран код няма какво да се вземе');

  window.udkAddAux('(497.2)');
  await settle();
  assert.equal(d.getElementById('udkB').textContent, 'още нищо не е избрано',
    'определител без основен код не бива да прави нищо');

  d.querySelector('.udkNode[data-code="94"] .udkRow .udkPlus').click();
  assert.equal(d.getElementById('udkB').textContent, '94');
  /* Нов избор от дървото ЗАМЕСТВА основния код, а не се долепя до него: човек,
     който се е отказал от „94“ и е натиснал „8“, иска „8“, а не „948“. */
  d.querySelector('.udkNode[data-code="8"] .udkRow .udkPlus').click();
  assert.equal(d.getElementById('udkB').textContent, '8');
  d.querySelector('.udkNode[data-code="94"] .udkRow .udkPlus').click();
  assert.equal(d.getElementById('udkB').textContent, '94');
  window.udkAddAux('(497.2)');
  assert.equal(d.getElementById('udkB').textContent, '94(497.2)');
  assert.match(d.getElementById('udkBL').textContent, /\+/, 'изписва се от какво е сглобен');

  window.udkUndo();
  assert.equal(d.getElementById('udkB').textContent, '94', '„Назад“ маха последната стъпка');
  window.udkAddAux('(497.2)');
  window.udkTake();
  await settle();
  assert.equal(d.querySelector('#bookF [name=udk]').value, '94(497.2)');
});

test('определител с кавички в самия код се добавя, вместо да счупи бутона', async () => {
  /* Определителите за време са в кавички („"19"“ = ХХ век), а езиковите носят
     обратни апострофи — 110 кода в таблицата съдържат такъв знак. Ако кодът се
     сложи в onclick="…" без правилно екраниране, бутонът мълчаливо не прави нищо
     (SyntaxError в тялото на handler-а), без съобщение и без следа. */
  const { window, d } = await openPicker();
  const time = AUX.find(a => /Време/.test(a[0]));
  const quoted = time[1].find(r => /["`]/.test(r[0]));
  assert.ok(quoted, 'очаквах определител с кавичка в кода');

  d.querySelector('.udkNode[data-code="94"] .udkRow .udkPlus').click();
  window.udkAuxTab(AUX.indexOf(time));
  await settle();
  const row = [...d.querySelectorAll('#udkAuxList .udkRow')]
    .find(r => r.querySelector('.udkCode').textContent === quoted[0]);
  assert.ok(row, 'редът с кавичка липсва в списъка');
  row.click();                                   // минава през onclick, както в програмата
  assert.equal(d.getElementById('udkB').textContent, '94' + quoted[0],
    'кодът с кавичка трябва да се добави непроменен');
  window.closeModal2();
});

test('бързите препратки дават кодовете, които изданието не носи наготово', async () => {
  const { window, d } = await openPicker();
  const chips = d.querySelectorAll('.udkQuick .udkQ1');
  assert.equal(chips.length, QUICK.length);
  const dete = [...chips].find(b => b.textContent.includes('82-93'));
  assert.ok(dete, 'липсва препратката за детската литература');
  dete.click();
  await settle();
  assert.equal(d.querySelector('#bookF [name=udk]').value, '82-93');
});

test('определителите са по таблици и се сменят с бутоните', async () => {
  const { window, d } = await openPicker();
  const tabs = d.querySelectorAll('.udkTab');
  assert.equal(tabs.length, AUX.length);
  assert.equal(tabs[0].classList.contains('on'), true, 'първата таблица е отворена');
  assert.equal(d.querySelectorAll('#udkAuxList .udkNode').length, AUX[0][1].length);

  const iPlace = AUX.findIndex(a => /Място/.test(a[0]));
  window.udkAuxTab(iPlace);
  await settle();
  assert.equal(tabs[iPlace].classList.contains('on'), true);
  assert.equal(tabs[0].classList.contains('on'), false, 'старата таблица се затваря');
  assert.equal(d.querySelectorAll('#udkAuxList .udkNode').length, AUX[iPlace][1].length);
  assert.ok([...d.querySelectorAll('#udkAuxList .udkCode')].some(e => e.textContent === '(497.2)'));
  window.closeModal2();
});

test('падащият списък до полето „УДК“ предлага и кодовете от дълбочината', async () => {
  const { d } = await openPicker({ 'authorities.suggest': { udk: ['886.7-31'] } });
  const opts = [...d.querySelectorAll('#dl_udk option')].map(o => o.value);
  assert.ok(opts.includes('821.163.2'), 'липсва код от дълбочината на дървото');
  assert.ok(opts.includes('8') && opts.includes('82'), 'липсват кодовете от горните нива');
  assert.ok(opts.includes('886.7-31'), 'заварените кодове от фонда също трябва да се предлагат');
});
