'use strict';
/* v2.4.40 — Таблицата на УДК.
   =====================================================================
   Таблицата вече идва от src/udk.json (официалното национално издание 2017 +
   УДК Summary, CC BY-SA 3.0), а src/udk.js се ПРАВИ от него с
   tools/build-udk.js. Затова тук се проверяват три неща:

   • двата файла не могат да се разминат незабелязано (правеният файл трябва да
     съвпада знак по знак с това, което генераторът прави сега);
   • нито един код от досегашната таблица не е изчезнал — иначе заварен запис
     във фонда остава с код, който вече го няма в избора;
   • подредбата вътре в класа е по УДК, а не по число или по азбука.

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
   както го зарежда и самата страница. */
function loadBuilt() {
  const ctx = vm.createContext({});
  vm.runInContext(BUILT + ';this.T=UDK_TREE;this.M=UDK_MODIFIERS;', ctx);
  /* Прекопирва се през JSON нарочно: масивите, направени вътре в vm, са от ДРУГ
     обхват и deepEqual ги отчита като „същата стойност, но друг Array“. */
  return { tree: JSON.parse(JSON.stringify(ctx.T)), modifiers: JSON.parse(JSON.stringify(ctx.M)) };
}
const { tree: TREE, modifiers: MODS } = loadBuilt();
const allRows = () => TREE.flatMap(([, , subs]) => subs);
const codeSet = () => new Set(TREE.flatMap(([code, , subs]) => [code, ...subs.map(s => s[0])]));

test('правеният src/udk.js съвпада точно с това, което генераторът прави от src/udk.json', () => {
  /* Ако някой поправи наименование направо в udk.js, следващото пускане на
     генератора мълчаливо ще го върне назад. Затова разминаването е ГРЕШКА, а
     поправките се правят в JSON. */
  assert.equal(BUILT, builder.render(DATA),
    'src/udk.js е остарял или пипан на ръка — пуснете „node tools/build-udk.js“ и запишете поправката в src/udk.json');
});

test('нито един код от досегашната таблица не е изчезнал от избора', () => {
  /* Заварените записи във фонда носят точно тези кодове. Ако някой отпадне от
     таблицата, библиотекарят вече няма как да го избере наново — а описанието
     по Наредба № 3 остава негова отговорност. */
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
  const lost = before.filter(c => !have.has(c));
  assert.deepEqual(lost, [], 'изчезнали кодове: ' + lost.join(', '));
});

test('новата подборка е вътре, с класовете и без измислен клас 4', () => {
  const have = codeSet();
  for (const e of DATA.entries) assert.ok(have.has(e.code), 'липсва код от подборката: ' + e.code);
  for (const e of DATA.additions) assert.ok(have.has(e.code), 'липсва допълнение: ' + e.code);
  assert.deepEqual(TREE.map(g => g[0]), ['0', '1', '2', '3', '5', '6', '7', '8', '9'],
    'класовете на УДК са тези девет — 4 е освободен и не се измисля');
  // Класът е заглавие на групата, а не ред вътре в нея.
  for (const [code, , subs] of TREE) {
    assert.ok(!subs.some(s => s[0] === code), 'класът „' + code + '“ не бива да е и ред в себе си');
  }
});

test('всеки код е само на едно място и е в своя клас', () => {
  const seen = new Map();
  for (const [cls, , subs] of TREE) for (const [code] of subs) {
    assert.equal(seen.has(code), false, 'кодът „' + code + '“ се повтаря (в ' + seen.get(code) + ' и ' + cls + ')');
    seen.set(code, cls);
    assert.equal(code.charAt(0), cls, 'кодът „' + code + '“ стои в чужд клас ' + cls);
  }
});

test('подредбата вътре в класа е по УДК: знак по знак, не като число', () => {
  /* Кодът НЕ е число: „82“ и „821“ са два и три знака на едно и също ниво, а не
     82 и 821 — при числово сравняване цялата литература се разбърква. Капаните:
     „006“ преди „01“ (не 6 преди 1), „82-93“ преди „82.0“ (тирето е преди
     точката), „82.09“ преди „821“ (точката е преди цифрите) и „94(100)“ преди
     „949.72“ (скобата е преди цифрите). */
  const cls = (c) => TREE.find(g => g[0] === c)[2].map(s => s[0]);
  const pos = (c, code) => cls(c).indexOf(code);
  const before = (c, a, b) => assert.ok(pos(c, a) >= 0 && pos(c, b) >= 0 && pos(c, a) < pos(c, b),
    '„' + a + '“ трябва да е преди „' + b + '“');
  before('0', '006', '01');
  before('0', '01', '02');
  before('0', '07', '070');
  before('8', '82-93', '82.0');
  before('8', '82.09', '821');
  before('8', '82', '821');
  before('8', '821.11', '821.163.2');
  before('8', '821.163.2-31', '821.163.3');
  before('9', '93/94', '949.72');
  before('9', '94(100)', '949.72');
  before('7', '79', '793');

  // И целият клас е подреден — не само проверените двойки.
  for (const [, , subs] of TREE) {
    const codes = subs.map(s => s[0]);
    assert.deepEqual(codes, [...codes].sort(), 'клас не е подреден: ' + codes.slice(0, 6).join(' '));
  }
});

test('всеки ред носи код и наименование, а допълненията са отбелязани', () => {
  for (const [code, name, subs] of TREE) {
    assert.ok(code && name, 'клас без наименование: ' + code);
    for (const s of subs) {
      assert.ok(s[0] && s[1], 'ред без наименование: ' + JSON.stringify(s));
      assert.ok(s.length === 2 || s[2] === 1, 'непознат трети елемент: ' + JSON.stringify(s));
    }
  }
  const added = allRows().filter(s => s[2] === 1).map(s => s[0]).sort();
  assert.equal(added.length, DATA.additions.length, 'отбелязаните допълнения трябва да са точно тези от JSON');
  assert.deepEqual(added, DATA.additions.map(e => e.code).sort());
  // Онова, което идва от подборката, НЕ бива да е отбелязано като допълнение.
  const fromSummary = new Set(DATA.entries.map(e => e.code));
  for (const s of allRows()) if (s[2] === 1) assert.equal(fromSummary.has(s[0]), false, s[0]);
});

test('файлът казва откъде идва таблицата — това е условие на лиценза ѝ', () => {
  /* УДК Summary е CC BY-SA 3.0: разпространява се СЪС посочване на източника.
     Затова бележката не е украса и не бива да отпада при следващо правене. */
  assert.match(BUILT, /UDC Consortium/, 'липсва посочване на източника');
  assert.match(BUILT, /Creative Commons Attribution-ShareAlike/, 'липсва лицензът');
  assert.match(BUILT, /НЕ СЕ РЕДАКТИРА НА РЪКА/, 'липсва предупреждението, че файлът е правен');
  assert.match(DATA.meta.license_note, /Creative Commons/);
});

test('генераторът пада с ясна грешка, ако свободен текст от JSON би затворил коментара на udk.js по средата', () => {
  /* based_on/license_note/additions_note отиват СУРОВИ в единствения блоков
     коментар на header-а на udk.js. Звезда-наклонена-черта в тях затваря
     коментара там, а следваща наклонена-звезда по-надолу в същия текст го
     отваря пак — между двете застава суров, изпълним JavaScript в готовия
     файл (зареждан направо с <script>, без модул). v2.4.40 review: grep за
     на пробив (echo -n '*' '/' конкатенирано) на free-text полетата, ПРЕДИ
     да се пише файлът — иначе правенето мълчаливо пробутва изпълним код. */
  const bad = JSON.parse(JSON.stringify(DATA));
  const marker = '*' + '/' + 'window.pwn=1;' + '/' + '*';
  bad.meta.based_on += ' (виж ' + marker + ')';
  assert.throws(() => builder.render(bad), /затворило|коментар/,
    'трябва да откаже да прави файла, вместо да остави суров код в него');

  // И самият произведен низ никога не бива да съдържа неекраниран инжектиран код.
  const safe = JSON.parse(JSON.stringify(DATA));
  const out = builder.render(safe);
  assert.doesNotMatch(out, /window\.pwn/, 'проверката трябва да не пропусне инжекция в изхода');
});

test('общите определители остават — те не са в подборката, а в спомагателните таблици', () => {
  const codes = MODS.map(m => m[0]);
  for (const c of ['(0.053.2)', '(035)', '(038)', '(075)', '(091)', '(497.2)', '(=163.2)']) {
    assert.ok(codes.includes(c), 'липсва определител ' + c);
  }
  // Определителите не бива да се смесят с основната таблица.
  const main = codeSet();
  for (const c of codes) assert.equal(main.has(c), false, 'определителят ' + c + ' е влязъл в основната таблица');
});

/* ---------------- екранът ---------------- */
const FORM_DEPS = { 'categories.list': [], 'authorities.values': [], 'books.suggestions': {}, 'shelves.list': [] };

test('изборът от таблицата показва всички кодове и позволява да се избере самият клас', async () => {
  const dom = buildDom({ ...FORM_DEPS,
    'books.get': { id: 1, inv_number: 1, title: 'Т', status: 'наличен' } });
  const { window } = dom, d = window.document;
  await settle();
  await window.bookForm(1);
  await settle();
  window.udkPicker();
  await settle();

  const items = d.querySelectorAll('#udkList .udkSubs .udkItem');
  assert.equal(items.length, allRows().length, 'в прозореца трябва да са всички редове');
  assert.equal(d.querySelectorAll('#udkList .udkMain').length, TREE.length);

  /* Класът се избира от собственото си заглавие — книга, класирана само на „8“,
     е обичайна и дотук такъв код се пишеше на ръка. */
  const head = d.querySelector('#udkList .udkGroup:nth-child(8) .udkMain');
  assert.ok(head.tagName === 'BUTTON', 'заглавието на класа трябва да е бутон');
  head.click();
  assert.equal(d.querySelector('#bookF [name=udk]').value, '8');

  window.udkPicker();
  await settle();
  const dance = [...d.querySelectorAll('#udkList .udkSubs .udkItem')]
    .find(b => b.textContent.includes('Танци'));
  assert.ok(dance, 'кодът за танците трябва да го има — читалището има ансамбъл');
  dance.click();
  assert.equal(d.querySelector('#bookF [name=udk]').value, '793');
});

test('търсенето стеснява редовете, но оставя заглавието на класа', async () => {
  const dom = buildDom({ ...FORM_DEPS,
    'books.get': { id: 1, inv_number: 1, title: 'Т', status: 'наличен' } });
  const { window } = dom, d = window.document;
  await settle();
  await window.bookForm(1);
  await settle();
  window.udkPicker();
  await settle();

  const vis = (sel) => [...d.querySelectorAll(sel)].filter(e => e.style.display !== 'none');
  d.getElementById('udkQ').value = 'танци';
  window.udkFilter();
  assert.equal(vis('#udkList .udkSubs .udkItem').length, 1, 'по „танци“ остава един ред');
  const groups = vis('#udkList .udkGroup');
  assert.equal(groups.length, 1, 'и една група');
  assert.ok(vis('#udkList .udkMain').length === 1 && groups[0].querySelector('.udkMain').style.display !== 'none',
    'заглавието на класа не бива да изчезва — то казва в кой клас е намереното');

  // Търсене по код работи също.
  d.getElementById('udkQ').value = '821.163.2';
  window.udkFilter();
  assert.ok(vis('#udkList .udkSubs .udkItem').length >= 4, 'по код се намират българските литератури');

  /* Търсене по името на КЛАСА: съвпада само заглавието, нито един ред. Групата
     пак се показва — иначе „религия“ не намира нищо, при положение че цял клас
     се казва така. */
  d.getElementById('udkQ').value = 'теология';
  window.udkFilter();
  const only = vis('#udkList .udkGroup');
  assert.equal(only.length, 1, 'класът „Религия. Теология“ трябва да се намери по името си');
  assert.equal(only[0].querySelector('.udkMain').textContent.includes('Теология'), true);
  assert.equal(vis('#udkList .udkSubs .udkItem').length, 0, 'нито един ред не съвпада — само класът');

  d.getElementById('udkQ').value = 'няматакъвкод';
  window.udkFilter();
  assert.equal(vis('#udkList .udkGroup').length, 0, 'при нищо намерено не остава празна група');

  d.getElementById('udkQ').value = '';
  window.udkFilter();
  assert.equal(vis('#udkList .udkSubs .udkItem').length, allRows().length, 'изчистеното търсене връща всички');
});

test('падащият списък до полето „УДК“ предлага същите кодове', async () => {
  const dom = buildDom({ ...FORM_DEPS,
    'books.get': { id: 1, inv_number: 1, title: 'Т', status: 'наличен' },
    'authorities.suggest': { udk: ['886.7-31'] } });
  const { window } = dom, d = window.document;
  await settle();
  await window.bookForm(1);
  await settle();
  const opts = [...d.querySelectorAll('#dl_udk option')].map(o => o.value);
  assert.ok(opts.includes('793') && opts.includes('821.163.2'), 'липсват кодове от таблицата');
  assert.ok(opts.includes('886.7-31'), 'заварените кодове от фонда също трябва да се предлагат');
});
