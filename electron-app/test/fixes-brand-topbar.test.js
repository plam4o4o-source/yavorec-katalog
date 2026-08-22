'use strict';
// v2.4.6 — логото на InvLib (пълният хоризонтален вариант: икона + InvLib +
// „LIBRARY MANAGEMENT SYSTEM“ + „Инвентар — библиотечна система“) застава
// центрирано в горната лента. Горната лента става решетка от три колони, за
// да стои логото на едно и също място във всеки раздел, а в тесен прозорец
// се връща точно старото подреждане с flex и логото се скрива.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const INDEX_HTML = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(SRC_DIR, 'style.css'), 'utf8');
const LOGO = path.join(SRC_DIR, 'assets', 'brand-lockup.png');

test('index.html: логото стои в горната лента между заглавието и .topRight — тоест в средната колона', () => {
  const m = INDEX_HTML.match(
    /<div id="vSub"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*(?:<!--[\s\S]*?-->\s*)?<img class="topbarLogo" src="assets\/brand-lockup\.png"[^>]*>\s*<div class="topRight">/);
  assert.ok(m, '<img class="topbarLogo"> трябва да е точно между блока със заглавието и <div class="topRight">');
});

test('index.html: логото в лентата е с alt="" — украса е, името вече се обявява от иконата вляво', () => {
  const m = INDEX_HTML.match(/<img class="topbarLogo"[^>]*>/);
  assert.ok(m);
  assert.match(m[0], /alt=""/,
    'дублирано обявяване на името на програмата от екранен четец — иконата в лентата вляво вече има alt="InvLib"');
});

test('assets/brand-lockup.png съществува и е PNG с алфа канал (прозрачен фон, не светъл правоъгълник)', () => {
  assert.ok(fs.existsSync(LOGO), 'липсва electron-app/src/assets/brand-lockup.png');
  const buf = fs.readFileSync(LOGO);
  assert.ok(buf.length > 0, 'файлът е празен');
  // PNG сигнатура + IHDR: ширина(4) височина(4) битова дълбочина(1) тип цвят(1)
  assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'не е валиден PNG');
  assert.equal(buf.slice(12, 16).toString('ascii'), 'IHDR');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf.readUInt8(25);
  assert.equal(colorType, 6, 'тип цвят 6 = RGBA; без алфа фонът щеше да е плътен светъл правоъгълник ' +
    'върху --paper2, който е различен нюанс във всяка от 7-те теми');
  assert.ok(width > height * 3,
    `хоризонтален lockup се очаква (широк, нисък), а е ${width}x${height}`);
});

test('style.css: #topbar е решетка с три колони и равни свиваеми страни — логото стои точно в центъра', () => {
  const m = STYLE_CSS.match(/#topbar\{([^}]*)\}/);
  assert.ok(m, 'блокът #topbar трябва да съществува');
  assert.match(m[1], /display:grid/);
  assert.match(m[1], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/,
    'страничните колони трябва да са равни и свиваеми, иначе логото се мести между разделите');
});

test('style.css: .topbarLogo е центрирана в своята колона и не прихваща мишката', () => {
  const m = STYLE_CSS.match(/\.topbarLogo\{([^}]*)\}/);
  assert.ok(m, 'блокът .topbarLogo трябва да съществува');
  assert.match(m[1], /justify-self:center/);
  assert.match(m[1], /pointer-events:none/, 'украса е — не бива да поема кликове върху лентата');
  assert.match(m[1], /height:\d+px/, 'фиксирана височина, за да не се мени лентата между разделите');
});

test('style.css: в тесен прозорец логото се скрива И решетката се връща на старото flex подреждане', () => {
  // Без връщането към flex свиваемата колона minmax(0,1fr) пренася дългите
  // заглавия на два реда дори когато логото вече е скрито — тоест тесните
  // прозорци щяха да платят цената, без да получат логото.
  // едно ниво вложени блокове вътре в media query-то
  const all = [...STYLE_CSS.matchAll(/@media \(max-width:\s*(\d+)px\)\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  const m = all.find(x => x[2].includes('display:none'));
  assert.ok(m, 'очаква се media query, който скрива .topbarLogo');
  const block = m[2];
  assert.match(block, /\.topbarLogo\{display:none\}/);
  assert.match(block, /#topbar\{display:flex;\s*justify-content:space-between\}/,
    'старото подреждане трябва да се възстанови изцяло, за да няма разлика спрямо преди промяната');
});

test('прагът, под който логото се скрива, е ПОД ширината, с която прозорецът се отваря', () => {
  /* Одит: прагът беше 1280px, а createWindow отваря прозореца на width:1280 —
     и това е ВЪНШНАТА ширина на прозореца (няма useContentSize:true), тоест CSS
     ширината е с рамката по-малко и media query-ят max-width:1280px хваща.
     Резултат: логото — цялата причина за версия 2.4.7 — не се виждаше никога
     при размера, с който програмата се отваря. Виждаше се едва след ръчно
     максимизиране на монитор над 1280 CSS px.
     Тестът чете реалната стойност от main.js, за да не може двете да се
     разминат отново. */
  const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const wm = MAIN_JS.match(/new BrowserWindow\(\{[\s\S]*?width:\s*(\d+)/);
  assert.ok(wm, 'ширината по подразбиране трябва да се намери в createWindow');
  const defaultWidth = Number(wm[1]);

  const minM = MAIN_JS.match(/minWidth:\s*(\d+)/);
  const minWidth = minM ? Number(minM[1]) : defaultWidth;

  const all = [...STYLE_CSS.matchAll(/@media \(max-width:\s*(\d+)px\)\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  const hide = all.find(x => x[2].includes('.topbarLogo{display:none}'));
  assert.ok(hide, 'очаква се media query, който скрива логото');
  const threshold = Number(hide[1]);

  assert.ok(threshold < defaultWidth,
    `прагът (${threshold}px) трябва да е под ширината по подразбиране на прозореца ` +
    `(${defaultWidth}px), иначе логото не се вижда при размера, с който програмата се отваря`);
  assert.ok(threshold <= minWidth,
    `прагът (${threshold}px) трябва да е до минималната ширина на прозореца (${minWidth}px), ` +
    'за да не изчезва логото при нормално преоразмеряване');
});
