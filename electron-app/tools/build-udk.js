#!/usr/bin/env node
'use strict';
/* Прави src/udk.js от src/udk.json.
   =====================================================================
   Данните живеят в JSON (един ред на код, лесен за преглед и за подмяна с
   по-ново издание), а екранът чете обикновен скрипт: подготвената страница
   се зарежда от file:// без модули и без fetch, затова таблицата се ВГРАЖДА
   като готов JavaScript вместо да се чете по време на работа.

   Пуска се на ръка след промяна в JSON:   node tools/build-udk.js
   Тестът udk-tablica.test.js проверява, че вграденото съвпада с JSON —
   така двата файла не могат да се разминат незабелязано. */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'udk.json');
const OUT = path.join(__dirname, '..', 'src', 'udk.js');

/* Шестте спомагателни таблици, в реда, в който се ползват на практика: първо
   тези, с които се допълва художествената литература (език, форма, място), после
   останалите. Наименованията са с номера на таблицата, за да може да се сверява
   с печатното издание. */
const AUX_TABLES = [
  ['определител-език', 'Език (Таблица 1c)'],
  ['определител-форма', 'Форма (Таблица 1d)'],
  ['определител-място', 'Място (Таблица 1e)'],
  ['определител-етнос', 'Народност (Таблица 1f)'],
  ['определител-време', 'Време (Таблица 1g)'],
  ['определител-лице', 'Лица (Таблица 1k)'],
  ['определител-свойство', 'Свойства (Таблица 1k)'],
  ['определител-материал', 'Материали (Таблица 1k)'],
  ['определител-отношение', 'Отношения (Таблица 1k)']
];

/* Подредба: ЗНАК ПО ЗНАК, като обикновен текст.

   Изглежда прекалено просто, но е точно вярното за УДК — и е нарочно, а не по
   недоглеждане. Кодът НЕ е число: „82“ и „821“ са два и три знака на едно и също
   ниво, а не осемдесет и две и осемстотин двайсет и едно, затова parseFloat би
   разбъркал цялата литература. А знаците, с които УДК разделя, се нареждат в
   Unicode точно в реда, в който се четат и на рафта:

       (  40   <   -  45   <   .  46   <   /  47   <   цифрите 48…57

   тоест „94(100)“ преди „949.72“, „82-93“ преди „82.0“, „82.09“ преди „821“ и
   „93/94“ преди „930“. Проверено е и че localeCompare('bg') дава същото —
   по-сложното сравняване не носи нищо и затова го няма. */
const cmpCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* Заглавието на реда и списъкът „Включва:“ се разделят, защото се ползват за
   различни неща: заглавието се ПОКАЗВА, а по „Включва“ се ТЪРСИ. Думата, която
   библиотекарката ще напише, обикновено е точно там — „Пчеларство“ го няма в
   заглавието на 638 („Отглеждане и развъждане на насекоми“), а стои в списъка. */
function splitLib(lib) {
  const s = String(lib || '');
  const i = s.indexOf(' Включва:');
  return i < 0 ? [s.trim(), ''] : [s.slice(0, i).trim(), s.slice(i + ' Включва:'.length).trim()];
}

function build(data) {
  const entries = data.entries.concat(data.additions || []);
  const added = new Set((data.additions || []).map(e => e.code));
  const byCode = new Map();
  for (const e of entries) if (!byCode.has(e.code)) byCode.set(e.code, e);
  const codes = [...byCode.keys()].sort(cmpCode);
  const have = new Set(codes);

  /* Родителят е НАЙ-ДЪЛГИЯТ съществуващ код, който стои в началото на този:
     „821.163.2“ → „821.163“, а ако го няма — „821.16“, и т.н. Така дървото
     следва самата класификация, вместо да се гадае по дължина или по точки.

     Изключение: обобщаващ код-диапазон („017/019“, „271/279“) започва буквално
     със своя пръв член — „017/019“ носи „017“ като низов префикс, но „017“ Е
     ЧЛЕН на диапазона, а не негов родител: диапазонът стои РАВНОСТОЙНО на
     017/018/019, не над тях (проверено: 017/019 „Каталози“ обобщава именно
     017+018+019, не е подраздел на 017). Наивното най-дълго-съвпадение го
     нанизваше като дете на собствения си пръв член — низово, не по смисъла на
     класификацията. Затова точно тази дължина (частта преди „/“) се прескача:
     търсенето продължава по-нагоре и намира истинския родител („01“). */
  const parentOf = (code) => {
    const slash = code.indexOf('/');
    const ownStart = slash < 0 ? -1 : slash;
    for (let i = code.length - 1; i > 0; i--) {
      if (i === ownStart) continue;
      if (have.has(code.slice(0, i))) return code.slice(0, i);
    }
    return null;
  };

  const node = new Map();
  for (const c of codes) {
    const [head, also] = splitLib(byCode.get(c).lib);
    node.set(c, { code: c, head, also, added: added.has(c), kids: [] });
  }
  const roots = [];
  for (const c of codes) {
    const p = parentOf(c);
    (p ? node.get(p).kids : roots).push(node.get(c));
  }
  return { roots, count: codes.length };
}

function auxOf(data) {
  const list = data.auxiliary_entries || [];
  const out = [];
  for (const [tip, name] of AUX_TABLES) {
    const rows = list.filter(e => e.tip === tip)
      .map(e => { const [head, also] = splitLib(e.lib); return [e.code, head, also]; });
    if (rows.length) out.push([name, rows]);
  }
  /* Ако издание донесе непозната таблица, тя не се изхвърля мълчаливо. */
  const known = new Set(AUX_TABLES.map(t => t[0]));
  const rest = list.filter(e => !known.has(e.tip));
  if (rest.length) {
    out.push(['Други определители', rest.map(e => { const [h, a] = splitLib(e.lib); return [e.code, h, a]; })]);
  }
  return out;
}

/* Полетата, които отиват СУРОВИ в единствения блоков коментар на header-а
   (based_on, license_note, license_check, additions_note). Комбинацията
   звезда-наклонена черта в тях затваря коментара там, а следваща
   наклонена-звезда по-надолу в същия текст го отваря пак — между двете застава
   суров, изпълним JavaScript в готовия файл, зареждан направо с
   <script src="udk.js"> без модул, който да го изолира. Данните тук идват от
   библиотекаря/разработчика, не от читател, но грешка в свободния текст на
   бележка не бива да пробутва изпълним код в продукцията безшумно — затова пада
   още при правенето, вместо да пропадне в src/udk.js.
   (Намерено при прегледа на предишния кръг; при пренаписването на генератора
   проверката се пренася заедно с новото поле license_check.) */
function assertSafeComment(label, text) {
  if (String(text).includes('*/')) {
    throw new Error('src/udk.json: полето „' + label + '“ съдържа „*/“ — това би затворило '
      + 'блоковия коментар на src/udk.js по средата и оставило суров код в готовия файл. '
      + 'Махнете „*/“ от текста.');
  }
}

const js = (v) => JSON.stringify(v);

/* Възелът се записва като [код, заглавие, „Включва“, деца, допълнение?].
   Празните полета остават празни низове/масиви, за да е една и съща формата — на
   екрана се чете без проверки за дължина. */
function nodeJs(n, indent) {
  const pad = '  '.repeat(indent);
  const kids = n.kids.length
    ? '[\n' + n.kids.map(k => nodeJs(k, indent + 1)).join(',\n') + '\n' + pad + ']'
    : '[]';
  return pad + '[' + js(n.code) + ',' + js(n.head) + ',' + js(n.also) + ',' + kids +
    (n.added ? ',1' : '') + ']';
}

function render(data) {
  const { roots, count } = build(data);
  const aux = auxOf(data);
  const m = data.meta || {};
  const quick = (data.additions || []).map(e => [e.code, splitLib(e.lib)[0]]);
  const opac = [];
  for (const e of data.entries.concat(data.additions || [])) {
    if (e.lib_opac && e.lib_opac !== e.lib) opac.push([e.code, e.lib_opac]);
  }
  const wrap = (s) => String(s || '').replace(/\n/g, '\n   ');
  assertSafeComment('meta.based_on', m.based_on || '');
  assertSafeComment('meta.license_note', m.license_note || '');
  assertSafeComment('meta.license_check', m.license_check || '');
  assertSafeComment('additions_note', data.additions_note || '');

  const head = `/* ТАБЛИЦА НА УДК (Универсална десетична класификация).
   =====================================================================
   ПРАВЕН ФАЙЛ — НЕ СЕ РЕДАКТИРА НА РЪКА.
   Прави се от src/udk.json с:   node tools/build-udk.js

   ${count} основни кода и ${aux.reduce((s, a) => s + a[1].length, 0)} общи определителя.

   Източник: ${wrap(m.based_on)}

   ${wrap(m.license_note)}

   ${wrap(m.license_check)}

   ${wrap(data.additions_note)}
   Тези редове носят пети елемент 1 в масива; екраните го подминават.

   Полето „УДК“ във формата остава СВОБОДЕН ТЕКСТ. Таблицата помага да се въведе
   правилният код и да се СГЛОБИ съставен („94“ + „(497.2)“ → „94(497.2)“), но не
   го налага: пълната схема не е тук и има какво да се допише на ръка. */
`;

  const treeJs = roots.map(n => nodeJs(n, 1)).join(',\n');
  const auxJs = aux.map(([name, rows]) =>
    '  [' + js(name) + ', [\n' + rows.map(r => '    ' + js(r)).join(',\n') + '\n  ]]').join(',\n');

  const opacBlock = opac.length
    ? '\n/* Публичен надпис за онлайн каталога там, където се различава от вътрешния. */\n' +
      'const UDK_OPAC = {\n' + opac.map(([c, t]) => `  ${js(c)}: ${js(t)}`).join(',\n') + '\n};\n'
    : '\n/* Публичните надписи (lib_opac в JSON) са еднакви с вътрешните в цялата\n' +
      '   подборка, затова тук няма отделна таблица. Различат ли се, tools/build-udk.js\n' +
      '   ще я добави сам. */\n';

  return head +
    '\n/* [код, заглавие, „Включва“ (за търсене), деца, 1 = извън изданието] */\n' +
    'const UDK_TREE = [\n' + treeJs + '\n];\n' +
    '\n/* Общи определители по спомагателните таблици. НЕ са самостоятелни кодове —\n' +
    '   добавят се към основен код: „63“ + „(497.2)“ = „63(497.2)“. */\n' +
    'const UDK_AUX = [\n' + auxJs + '\n];\n' +
    '\n/* Кодове, които изданието не носи като готови редове, а този фонд ползва —\n' +
    '   стоят като бързи препратки над дървото. */\n' +
    'const UDK_QUICK = [\n' + quick.map(q => '  ' + js(q)).join(',\n') + '\n];\n' +
    opacBlock;
}

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
if (require.main === module) {
  fs.writeFileSync(OUT, render(data), 'utf8');
  const b = build(data);
  process.stdout.write('src/udk.js — ' + b.count + ' кода, ' +
    auxOf(data).reduce((s, a) => s + a[1].length, 0) + ' определителя, ' +
    Math.round(fs.statSync(OUT).size / 1024) + ' KB\n');
}
module.exports = { render, build, auxOf, cmpCode, splitLib, assertSafeComment, AUX_TABLES };
