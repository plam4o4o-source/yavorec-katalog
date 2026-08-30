'use strict';
/* v2.4.15 — програмата се отваря на цял екран (максимизиран прозорец).

   Максимизирането само по себе си е един ред, но редът около него е
   съществен и лесен за разваляне при бъдеща редакция:

     1. show: false при създаването — иначе библиотекарят вижда за миг
        прозорец 1280×800, който подскача до цял екран;
     2. maximize() ПРЕДИ показването — иначе същият подскок, само по-късно;
     3. показване на 'ready-to-show' — прозорецът трябва да се появи, когато
        има какво да се нарисува;
     4. width/height ОСТАВАТ 1280×800 — това е размерът при „Възстанови
        надолу“; ако някой ги махне с мисълта „нали е максимизиран“, бутонът
        за възстановяване свива прозореца до minWidth/minHeight;
     5. предпазен таймер — ако 'ready-to-show' не дойде, прозорецът пак се
        показва, вместо програмата да изглежда незастартирала.

   Проверява се и че прозорецът НЕ е kiosk/fullscreen: заглавната лента и
   лентата на задачите трябва да останат достъпни.

   ЗАБЕЛЕЖКА: startMainApp() зарежда main.js веднъж за целия процес и връща
   един и същи обект. Затова прозорецът се взима веднъж тук, а stop() се вика
   в test.after() — иначе таймерът за автоматично публикуване (5 мин.) държи
   процеса на node --test жив и поредицата увисва. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startMainApp } = require('./helpers/main-app.js');

const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const app = startMainApp();
let win;
test.before(async () => {
  await app.ready();
  win = app.windows[0];
});
test.after(() => app.stop());

test('прозорецът се създава скрит; максимизира се и се показва чак на „ready-to-show"', () => {
  assert.ok(win, 'createWindow() трябва да е създал прозорец');
  assert.equal(win.opts.show, false,
    'show: false — иначе се вижда прозорец 1280×800, който после подскача до цял екран');

  /* Нищо не бива да е извикано преди събитието. maximize() сам показва скрит
     прозорец (документация на Electron), затова и той трябва да чака — иначе
     библиотекарят вижда празен бял прозорец, докато съдържанието се зарежда. */
  assert.equal(win.calls.length, 0,
    'нито maximize(), нито show() бива да се викат преди съдържанието да е готово: ' + JSON.stringify(win.calls));

  win.emit('ready-to-show');
  const iMax = win.calls.indexOf('maximize');
  const iShow = win.calls.indexOf('show');
  assert.ok(iMax >= 0, 'maximize() трябва да бъде извикан — програмата се отваря на цял екран');
  assert.ok(iShow >= 0, "show() трябва да се извика на 'ready-to-show'");
  assert.ok(iMax < iShow, 'максимизирането трябва да е ПРЕДИ показването, за да няма преоразмеряване пред очите');
});

test('повторното „ready-to-show“ не показва прозореца втори път', () => {
  win.emit('ready-to-show');
  win.emit('ready-to-show');
  assert.equal(win.calls.filter(c => c === 'show').length, 1,
    'show() веднъж — пазачът shown трябва да спре повторните извиквания');
});

test('размерът при възстановяване остава 1280×800 и минимумите не се пипат', () => {
  const o = win.opts;
  assert.equal(o.width, 1280, '„Възстанови надолу" трябва да дава използваем прозорец, не минимума');
  assert.equal(o.height, 800);
  assert.equal(o.minWidth, 1024);
  assert.equal(o.minHeight, 640);
  assert.equal(o.resizable, true);
});

test('прозорецът е максимизиран, а НЕ kiosk/fullscreen — лентата на задачите остава достъпна', () => {
  assert.notEqual(win.opts.fullscreen, true, 'fullscreen скрива заглавната лента и лентата на задачите');
  assert.notEqual(win.opts.kiosk, true, 'kiosk режим заключва потребителя в приложението');
  assert.doesNotMatch(MAIN_JS, /win\.setFullScreen\(\s*true\s*\)/,
    'setFullScreen(true) би скрил лентата на задачите — искаме максимизиран прозорец');
  assert.doesNotMatch(MAIN_JS, /win\.setKiosk\(\s*true\s*\)/);
});

test('има предпазен таймер, ако „ready-to-show" никога не дойде', () => {
  /* Събитието се симулира в тестовете, но истинският таймер не бива да се
     губи при бъдеща редакция — без него счупен рендер оставя прозореца скрит
     завинаги и програмата изглежда незастартирала. */
  assert.match(MAIN_JS, /setTimeout\(\s*showOnce\s*,/,
    'липсва предпазният таймер за показване на прозореца');
});
