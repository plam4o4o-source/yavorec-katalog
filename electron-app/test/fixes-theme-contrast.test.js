'use strict';
/* Контраст по WCAG AA (>=4.5:1 за обикновен текст) за ВСИЧКИТЕ седем теми.
 *
 * Защо съществува този файл: fixes-invlib-theme.test.js проверяваше само две
 * двойки и само за тема 7 — --spine срещу текста в страничната лента, и
 * --brassL срещу --spine. Тъкмо двойката, на която --brass реално среща текст,
 * не се проверяваше никъде: .btn.pri рисува БЯЛ текст върху --brass. Заради
 * това през одита се откриха три пропуснати провала наведнъж:
 *   тема 7 (InvLib)  #fff върху --brass = 3.01:1  — и от v2.4.5 това е темата
 *                    по подразбиране за всяка НОВА инсталация, тоест стойността,
 *                    с която тръгва всяка библиотека;
 *   тема 1 (Бронз)   #fff върху --brass = 4.40:1  — темата на всички
 *                    съществуващи инсталации;
 *   тема 4 (Бордо)   --spine върху --brassL = 4.13:1 (::selection).
 *
 * Затова тестът тук не проверява една тема, а изчита ВСЯКА тема от style.css и
 * минава през всяка двойка цветове, която реално се среща в интерфейса. Нова
 * тема не може да бъде добавена, без да мине през същите прагове.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STYLE_CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');
const CORE_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'core.js'), 'utf8');

const AA = 4.5;                 // WCAG AA, обикновен текст
const SIDEBAR_TEXT = '#e9e2cf'; // фиксираният цвят на текста в #rail, виж style.css

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

/* Прочита променливите на една тема от блока, който започва на подадената
   позиция. Нарочно НЕ ползва лаком израз през целия файл: при първия опит
   регулярният израз прескачаше края на блока и смесваше --brassL на една тема
   със --spine на друга, което даде фалшив провал. */
function themeVarsAt(startIndex) {
  const seg = STYLE_CSS.slice(startIndex);
  const end = seg.indexOf('\n}');
  const block = seg.slice(0, end === -1 ? seg.length : end);
  const out = {};
  for (const m of block.matchAll(/--(\w+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2];
  return out;
}

function allThemes() {
  const themes = { 1: themeVarsAt(STYLE_CSS.indexOf(':root{')) };
  for (const m of STYLE_CSS.matchAll(/html\[data-theme="(\d)"\]\{/g)) {
    themes[m[1]] = themeVarsAt(m.index);
  }
  return themes;
}

test('style.css съдържа точно 7 теми и всяка носи пълния набор цветови променливи', () => {
  const themes = allThemes();
  assert.deepEqual(Object.keys(themes).sort(), ['1', '2', '3', '4', '5', '6', '7']);
  for (const [id, v] of Object.entries(themes)) {
    for (const key of ['paper', 'paper2', 'spine', 'brass', 'brassL', 'brassD']) {
      assert.ok(v[key], `тема ${id} няма --${key}`);
    }
  }
});

test('всяка тема: БЯЛ текст върху --brass спазва WCAG AA (.btn.pri, .rankNo, .dnvToday, .tagLocal)', () => {
  // Точно тази двойка липсваше в старата проверка и точно тя се счупи в тема 7.
  for (const [id, v] of Object.entries(allThemes())) {
    const c = contrast('#FFFFFF', v.brass);
    assert.ok(c >= AA, `тема ${id}: #fff върху --brass ${v.brass} = ${c.toFixed(2)}:1 (нужно ${AA})`);
  }
});

test('всяка тема: --brassD като цвят на текст върху --paper2 спазва WCAG AA', () => {
  for (const [id, v] of Object.entries(allThemes())) {
    const c = contrast(v.brassD, v.paper2);
    assert.ok(c >= AA, `тема ${id}: --brassD ${v.brassD} върху --paper2 ${v.paper2} = ${c.toFixed(2)}:1`);
  }
});

test('всяка тема: ::selection (--spine текст върху --brassL) спазва WCAG AA', () => {
  for (const [id, v] of Object.entries(allThemes())) {
    const c = contrast(v.spine, v.brassL);
    assert.ok(c >= AA, `тема ${id}: --spine ${v.spine} върху --brassL ${v.brassL} = ${c.toFixed(2)}:1`);
  }
});

test('всяка тема: текстът в страничната лента (#e9e2cf върху --spine) спазва WCAG AA', () => {
  for (const [id, v] of Object.entries(allThemes())) {
    const c = contrast(SIDEBAR_TEXT, v.spine);
    assert.ok(c >= AA, `тема ${id}: ${SIDEBAR_TEXT} върху --spine ${v.spine} = ${c.toFixed(2)}:1`);
  }
});

test('--brass вече не се ползва като цвят на дребен текст (само --brassD) — .authTarget', () => {
  // v1.70.0 премести текстовите ползвания на --brass върху --brassD заради
  // контраста, но пропусна .authTarget; в тема 7 това даваше 2.98:1.
  const m = STYLE_CSS.match(/\.authTarget\{([^}]*)\}/);
  assert.ok(m, '.authTarget трябва да съществува');
  assert.match(m[1], /color:var\(--brassD\)/,
    '.authTarget е 11px текст — трябва да ползва --brassD, не --brass');
});

test('THEMES в core.js и цветовете в style.css не се разминават', () => {
  // Списъкът в core.js рисува кръгчетата в „Настройки → Външен вид“. Ако се
  // разминат, библиотекарят избира тема по цвят, който не е темата.
  const themes = allThemes();
  const block = CORE_JS.match(/const THEMES = \[([\s\S]*?)\];/)[1];
  const rows = [...block.matchAll(/id:\s*'(\d)'[^}]*?spine:\s*'(#[0-9A-Fa-f]{6})'[^}]*?brass:\s*'(#[0-9A-Fa-f]{6})'[^}]*?paper:\s*'(#[0-9A-Fa-f]{6})'/g)];
  assert.equal(rows.length, 7, 'очакват се 7 реда в THEMES');
  for (const [, id, spine, brass, paper] of rows) {
    assert.equal(spine.toUpperCase(), themes[id].spine.toUpperCase(), `тема ${id}: spine се разминава`);
    assert.equal(brass.toUpperCase(), themes[id].brass.toUpperCase(), `тема ${id}: brass се разминава`);
    assert.equal(paper.toUpperCase(), themes[id].paper.toUpperCase(), `тема ${id}: paper се разминава`);
  }
});
