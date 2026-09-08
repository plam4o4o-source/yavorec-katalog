#!/usr/bin/env node
'use strict';
/* Прави src/udk.js от src/udk.json.
   =====================================================================
   Данните живеят в JSON (един ред на код, лесен за преглед и за подмяна с
   по-ново издание), а екранът чете обикновен скрипт: подготвената страница
   се зарежда от file:// без модули и без fetch, затова таблицата се ВГРАЖДА
   като готов JavaScript вместо да се чете по време на работа.

   Пуска се на ръка след промяна в JSON:   node tools/build-udk.js
   Тестът udk-tabler.test.js проверява, че вграденото съвпада с JSON —
   така двата файла не могат да се разминат незабелязано. */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'udk.json');
const OUT = path.join(__dirname, '..', 'src', 'udk.js');

/* Общи определители. Те НЕ са в подборката (тя е за основната таблица), а са
   от спомагателните таблици на УДК и се добавят след основния код. */
const MODIFIERS = [
  ['(0.053.2)', 'за деца'],
  ['(035)', 'наръчници. Справочници'],
  ['(038)', 'речници'],
  ['(075)', 'учебници'],
  ['(091)', 'исторически преглед'],
  ['(497.2)', 'България'],
  ['(=163.2)', 'на български език']
];

/* Класът на един код е първата му цифра: „502/504“ и „949.72“ са в 5 и 9.
   УДК няма клас 4 — той е освободен и нарочно не се измисля. */
const classOf = (code) => String(code).charAt(0);

function build(data) {
  const entries = data.entries.concat(data.additions || []);
  const added = new Set((data.additions || []).map(e => e.code));
  const classes = new Map();
  for (const e of data.entries) if (e.tip === 'клас') classes.set(e.code, e.lib);

  const groups = new Map();
  for (const e of entries) {
    if (classes.has(e.code)) continue;              // самият клас е заглавие, не ред
    const c = classOf(e.code);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(e);
  }
  const order = [...classes.keys()].sort();
  for (const c of groups.keys()) if (!classes.has(c)) order.push(c);

  const tree = [];
  for (const c of order) {
    const subs = (groups.get(c) || []).slice().sort(cmpCode);
    if (!subs.length) continue;
    tree.push([c, classes.get(c) || ('Клас ' + c), subs.map(e =>
      added.has(e.code) ? [e.code, e.lib, 1] : [e.code, e.lib])]);
  }
  return tree;
}

/* Подредба вътре в класа: ЗНАК ПО ЗНАК, като обикновен текст.

   Изглежда прекалено просто, но е точно вярното за УДК — и е нарочно, а не по
   недоглеждане. Кодът НЕ е число: „82“ и „821“ са два и три знака на едно и също
   ниво, а не осемдесет и две и осемстотин двайсет и едно, затова parseFloat би
   разбъркал цялата литература. А знаците, с които УДК разделя, се нареждат в
   Unicode точно в реда, в който се четат и на рафта:

       (  40   <   -  45   <   .  46   <   /  47   <   цифрите 48…57

   тоест „94(100)“ преди „949.72“, „82-93“ преди „82.0“, „82.09“ преди „821“ и
   „93/94“ преди „930“. Проверено е и че localeCompare('bg') дава същото —
   по-сложното сравняване не носи нищо и затова го няма. */
function cmpCode(a, b) {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

const js = (v) => JSON.stringify(v);

/* Полетата по-долу (based_on, license_note, additions_note) отиват СУРОВИ в
   единствения блоков коментар на header-а. Комбинацията звезда-наклонена
   черта в тях затваря коментара там, а следваща наклонена-звезда по-надолу в
   същия текст го отваря пак — между двете застава суров, изпълним JavaScript
   в готовия файл, зареждан направо с <script src="udk.js"> без модул, който
   да го изолира. Данните тук идват от библиотекаря/разработчика, не от
   читател, но грешка в свободния текст на бележка не бива да пробутва
   изпълним код в продукцията безшумно — затова пада още при правенето,
   вместо да пропадне в src/udk.js. */
function assertSafeComment(label, text) {
  if (text.includes('*/')) {
    throw new Error('src/udk.json: полето „' + label + '“ съдържа „*/“ — това би затворило '
      + 'блоковия коментар на src/udk.js по средата и оставило суров код в готовия файл. '
      + 'Махнете „*/“ от текста.');
  }
}

function render(data) {
  const tree = build(data);
  const m = data.meta || {};
  assertSafeComment('meta.based_on', m.based_on || '');
  assertSafeComment('meta.license_note', m.license_note || '');
  assertSafeComment('additions_note', data.additions_note || '');
  const opac = [];
  for (const e of data.entries.concat(data.additions || [])) {
    if (e.lib_opac && e.lib_opac !== e.lib) opac.push([e.code, e.lib_opac]);
  }
  const head = `/* ТАБЛИЦА НА УДК (Универсална десетична класификация).
   =====================================================================
   ПРАВЕН ФАЙЛ — НЕ СЕ РЕДАКТИРА НА РЪКА.
   Прави се от src/udk.json с:   node tools/build-udk.js

   Източник: ${m.based_on || '—'}

   ${(m.license_note || '').replace(/\n/g, '\n   ')}

   Затова таблицата ИДВА с програмата (за разлика от авторската таблица, която е
   чуждо издание и се внася от библиотеката) — УДК Summary е свободна за
   разпространение с посочване на източника и при същия лиценз.

   ${(data.additions_note || '').replace(/\n/g, '\n   ')}
   Тези редове носят трети елемент 1 в масива; екраните го подминават.

   Полето „УДК“ във формата остава СВОБОДЕН ТЕКСТ — таблицата само помага да се
   въведе правилният код, без да го налага: съставни кодове, каквито подборката
   не покрива, се пишат на ръка. */
`;
  const body = tree.map(([code, name, subs]) =>
    `  [${js(code)}, ${js(name)}, [\n` +
    subs.map(s => '    ' + js(s)).join(',\n') +
    '\n  ]]').join(',\n');

  /* Публичните надписи (lib_opac) се вграждат САМО ако някъде се различават от
     вътрешните. В сегашната подборка са еднакви навсякъде, затова файлът не носи
     празна таблица — по-добре нищо, отколкото име, което не върши работа. */
  const opacBlock = opac.length
    ? '\n/* Публичен надпис за онлайн каталога там, където се различава от вътрешния. */\n' +
      'const UDK_OPAC = {\n' + opac.map(([c, t]) => `  ${js(c)}: ${js(t)}`).join(',\n') + '\n};\n'
    : '\n/* Публичните надписи (lib_opac в JSON) са еднакви с вътрешните в цялата\n' +
      '   подборка, затова тук няма отделна таблица. Различат ли се, tools/build-udk.js\n' +
      '   ще я добави сам. */\n';

  return head + '\nconst UDK_TREE = [\n' + body + '\n];\n' +
    '\n/* Най-често използваните общи определители, които се добавят след основния код. */\n' +
    'const UDK_MODIFIERS = [\n' +
    MODIFIERS.map(x => '  ' + js(x)).join(',\n') + '\n];\n' + opacBlock;
}

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const out = render(data);
if (require.main === module) {
  fs.writeFileSync(OUT, out, 'utf8');
  const n = build(data).reduce((s, g) => s + g[2].length, 0);
  process.stdout.write('src/udk.js — ' + n + ' кода в ' + build(data).length + ' класа\n');
}
module.exports = { render, build, cmpCode, MODIFIERS, assertSafeComment };
