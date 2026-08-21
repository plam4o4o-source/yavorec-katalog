// v2.4.1 — нова визуална идентичност InvLib: 7-ма цветова тема (Настройки →
// Външен вид), с точните цветове от бранд спецификацията. Проверява, че
// THEMES (src/views/core.js) и CSS блокът html[data-theme="7"] (src/style.css)
// не се разминават — двете места се поддържат ръчно синхронизирани, точно
// както при останалите 6 теми, и нищо в тестовия пакет дотогава не пазеше
// това съответствие дори за тях.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'core.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');

test('THEMES съдържа тема "7" InvLib с точните цветове от бранд спецификацията', () => {
  const m = CORE_JS.match(/const THEMES = \[([\s\S]*?)\];/);
  assert.ok(m, 'THEMES масивът трябва да е намерен в core.js');
  const themeLine = m[1].split('\n').find(l => /id:\s*'7'/.test(l));
  assert.ok(themeLine, 'трябва да има ред с id: \'7\' в THEMES');
  assert.match(themeLine, /spine:\s*'#1E3A8A'/i, 'spine на тема 7 трябва да е точното Primary Navy #1E3A8A');
  assert.match(themeLine, /brass:\s*'#0EA5A8'/i, 'brass на тема 7 трябва да е точното Teal #0EA5A8');
  assert.match(themeLine, /paper:\s*'#F8FAFC'/i, 'paper на тема 7 трябва да е точното Light Background #F8FAFC');
});

test('html[data-theme="7"] в style.css съществува и пази същите --spine/--brass/--paper', () => {
  const m = STYLE_CSS.match(/html\[data-theme="7"\]\s*\{([^}]*)\}/);
  assert.ok(m, 'CSS блокът за data-theme="7" трябва да съществува');
  const block = m[1];
  assert.match(block, /--spine:\s*#1E3A8A/i);
  assert.match(block, /--brass:\s*#0EA5A8/i);
  assert.match(block, /--paper:\s*#F8FAFC/i);
});

test('THEMES в core.js и data-theme блоковете в style.css имат точно същия брой и същите id-та', () => {
  const themesBlock = CORE_JS.match(/const THEMES = \[([\s\S]*?)\];/)[1];
  const jsIds = [...themesBlock.matchAll(/id:\s*'(\d+)'/g)].map(m => m[1]).sort();
  const cssIds = [...STYLE_CSS.matchAll(/html\[data-theme="(\d+)"\]/g)].map(m => m[1]).sort();
  // Тема "1" е зададена директно в :root (без html[data-theme="1"] блок) —
  // затова CSS страната ще има точно с едно id по-малко от JS страната.
  const expectedCssIds = jsIds.filter(id => id !== '1');
  assert.deepEqual(cssIds, expectedCssIds,
    'всяка тема освен "1" (в :root по подразбиране) трябва да има свой html[data-theme] CSS блок');
});

// WCAG AA (>=4.5:1) — същата проверка, спомената в CSS коментара при добавянето
// на темата, но сега действителна автоматична проверка, не само бележка.
function relLum(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(h1, h2) {
  const l1 = relLum(h1), l2 = relLum(h2);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

test('тема InvLib: sidebar текстът (#e9e2cf върху --spine) и --brassL/--spine спазват WCAG AA (>=4.5:1)', () => {
  const sidebarText = '#e9e2cf'; // фиксиран цвят на #rail текста, виж src/style.css
  assert.ok(contrast('#1E3A8A', sidebarText) >= 4.5, 'спайн текстът в sidebar-а трябва да е четим');
  assert.ok(contrast('#4DD0D2', '#1E3A8A') >= 4.5, 'brassL/spine (.rankRow, ::selection) трябва да е четимо');
});
