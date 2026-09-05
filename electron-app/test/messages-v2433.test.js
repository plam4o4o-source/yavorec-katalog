'use strict';
/* v2.4.33 — двадесет и втори кръг: графично подобрение на съобщенията.
   =====================================================================
   • toast(): светла картичка с цвят по вида (--tc), SVG икона (data-kind),
     нов вид 'warn' (горе в центъра, 6 s, role=status).
   • askConfirm(): заместител на родния confirm() — прозорец на програмата
     (икона, заглавие, текст с редовете, „Отказ“ + бутон с името на действието;
     червен при изтриване/необратимо), Promise<boolean>, собствен слой над
     отворените форми, Esc = отказ, фокусът се връща. Подменен (не-native) confirm() отговаря
     вместо прозореца — така всички досегашни тестове важат непроменени.
   • Нито един екран не вика родния confirm() повече (проверка по изходния код).
   Всеки тест е проверен с мутация (виж /tmp/mut33.py в описанието на кръга). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, cleanupTmpDirs, buildDom, settle } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);
const VIEWS = path.join(APP_DIR, 'src', 'views');

/* Отваря прозореца наистина: родният confirm() е „native“, а jsdom-ският — не, и
   buildDom() го подменя с () => true. За прозореца го махаме изобщо. */
function domWithDialog(overrides) {
  const dom = buildDom(overrides || {});
  dom.window.confirm = null;
  return dom;
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('toast: четирите вида са една кутийка с различен клас; warn и err излизат горе, SVG икона с data-kind', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom, d = window.document;
  window.toast('Записано.', 'ok');
  window.toast('Проблем.', 'err');
  window.toast('Внимавайте.', 'warn');
  window.toast('Информация.');
  assert.equal(d.querySelectorAll('#toasts .toast').length, 2, 'успехът и информацията са долу вдясно');
  assert.equal(d.querySelectorAll('#toastsTop .toast').length, 2, 'грешката и предупреждението са горе в центъра');
  const warn = d.querySelector('#toastsTop .toast.warn');
  assert.ok(warn, 'липсва вид warn');
  assert.equal(warn.getAttribute('role'), 'status', 'предупреждението не е alert — само грешката прекъсва екранния четец');
  assert.equal(warn.querySelector('.tico').getAttribute('data-kind'), 'warn');
  assert.ok(warn.querySelector('.tico svg path'), 'иконата е SVG');
  assert.equal(warn.style.getPropertyValue('--tdur'), '6000ms', 'предупреждението стои 6 s');
  assert.equal(d.querySelector('#toasts .toast:not(.ok) .tico').getAttribute('data-kind'), 'info');
  assert.equal(d.querySelector('#toasts .toast.ok .tico svg').getAttribute('aria-hidden'), 'true');
  // Иконите са различни по вид — не една и съща картинка с друг цвят.
  const paths = ['ok', 'err', 'warn'].map(k => d.querySelector(`.toast.${k} .tico svg`).innerHTML);
  assert.equal(new Set(paths).size, 3);
});

test('toast: стиловете носят цвета през --tc, без плътни цветни плочи, и warn има собствен цвят', () => {
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  assert.match(css, /\.toast\.warn\{--tc:var\(--amber\)\}/);
  assert.match(css, /\.toast\.err\{--tc:var\(--red\)\}/);
  assert.match(css, /\.toast\.ok\{--tc:var\(--green\)\}/);
  assert.match(css, /--amber:#[0-9A-Fa-f]{6}/, 'кехлибареният цвят е дефиниран в :root');
  assert.doesNotMatch(css, /\.toast\.err\{background:var\(--red\)/, 'старата плътна червена плоча');
  assert.match(css, /\.toast \.tprog\{[^}]*background:var\(--tc\)/, 'лентичката-брояч е в цвета на вида');
  assert.match(css, /\.empty::before\{[^}]*mask:url\("data:image\/svg\+xml/, 'празното състояние е SVG, не емоджи');
  assert.match(css, /\.note\.w::before\{/, 'предупредителната бележка има знак');
});

test('askConfirm: подменен confirm() отговаря вместо прозореца (съвместимост с тестовете и автоматизацията)', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom;
  const asked = [];
  window.confirm = (m) => { asked.push(m); return false; };
  assert.equal(await window.askConfirm('Да изтрия ли?'), false);
  window.confirm = () => true;
  assert.equal(await window.askConfirm('Да изтрия ли?'), true);
  assert.deepEqual(asked, ['Да изтрия ли?']);
  assert.equal(window.document.querySelector('#veilC').classList.contains('on'), false, 'прозорецът не се отваря');
});

test('askConfirm: прозорец с икона, заглавие, текст и бутони; „Изтрий“ разрешава true, „Отказ“ — false', async () => {
  const dom = domWithDialog(); await settle();
  const { window } = dom, d = window.document;
  const p = window.askConfirm('Да изтрия ли тази книга?');
  await tick();
  const veil = d.querySelector('#veilC'), box = d.querySelector('#modalC');
  assert.ok(veil.classList.contains('on'), 'прозорецът не е отворен');
  assert.deepEqual([...box.classList], ['modal', 'cfm', 'delete'], 'видът се извежда от текста (изтриване)');
  assert.equal(box.querySelector('.cfmTitle').textContent, 'Изтриване');
  assert.equal(box.querySelector('.cfmMsg').textContent, 'Да изтрия ли тази книга?');
  assert.ok(box.querySelector('.cfmIco svg'), 'липсва икона');
  const ok = box.querySelector('[data-ask="ok"]'), cancel = box.querySelector('[data-ask="cancel"]');
  assert.equal(ok.textContent, 'Изтрий');
  assert.equal(cancel.textContent, 'Отказ');
  assert.ok(ok.classList.contains('dgr'), 'изтриването е червен бутон');
  assert.equal(d.activeElement, cancel, 'при необратимо действие фокусът е на „Отказ“ — Enter не изтрива по инерция');
  assert.equal(box.querySelector('.body').getAttribute('role'), 'alertdialog');
  ok.click();
  assert.equal(await p, true);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(veil.classList.contains('on'), false, 'прозорецът не се затвори');
  assert.equal(box.innerHTML, '', 'съдържанието на въпроса остава');
  // Отказ
  const p2 = window.askConfirm('Изтриване на партидата?'); await tick();
  d.querySelector('#modalC [data-ask="cancel"]').click();
  assert.equal(await p2, false);
});

test('askConfirm: обикновен въпрос — основен бутон „Да“ с фокус върху него; Esc и × са отказ и разрешават обещанието', async () => {
  const dom = domWithDialog(); await settle();
  const { window } = dom, d = window.document;
  const p = window.askConfirm('Начисли годишна такса 5.00 лв.?', { okLabel: 'Начисли' }); await tick();
  const box = d.querySelector('#modalC');
  assert.deepEqual([...box.classList], ['modal', 'cfm', 'ask']);
  assert.equal(box.querySelector('.cfmTitle').textContent, 'Потвърждение');
  const ok = box.querySelector('[data-ask="ok"]');
  assert.equal(ok.textContent, 'Начисли');
  assert.ok(ok.classList.contains('pri') && !ok.classList.contains('dgr'));
  assert.equal(d.activeElement, ok, 'при обикновен въпрос Enter потвърждава');
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await p, false, 'Esc е отказ');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(d.querySelector('#veilC').classList.contains('on'), false);
  // Второ Esc, без отворен прозорец, не бива да прави нищо (слушателят е свален).
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});

test('askConfirm: първият ред с празен ред след него става заглавие (главните букви се свалят), редовете в текста се пазят; изричните opts надделяват', async () => {
  const dom = domWithDialog(); await settle();
  const { window } = dom, d = window.document;
  const p = window.askConfirm('РЕДАКЦИЯ НА ЗАПИС В ИНВЕНТАРНАТА КНИГА\n\n„Под игото“ (инв. № 5)\n\nДа продължа ли към редакция?', { kind: 'ask', okLabel: 'Към редакцията' });
  await tick();
  const box = d.querySelector('#modalC');
  assert.equal(box.querySelector('.cfmTitle').textContent, 'Редакция на запис в инвентарната книга');
  assert.equal(box.querySelector('.cfmMsg').textContent, '„Под игото“ (инв. № 5)\n\nДа продължа ли към редакция?', 'редът-заглавие не се повтаря; редовете остават');
  assert.equal(box.querySelector('[data-ask="ok"]').textContent, 'Към редакцията');
  assert.ok(box.classList.contains('ask'), 'изричният kind надделява над думите в текста');
  box.querySelector('[data-ask="cancel"]').click(); await p;
  await new Promise(r => setTimeout(r, 200));
  // Изрично заглавие + необратимо: редът „НЕОБРАТИМО“ пак отпада от текста.
  const p2 = window.askConfirm('НЕОБРАТИМО\n\nИсторията ще бъде заличена.\n\nНаистина ли да продължа?', { kind: 'delete', title: 'Необратимо изтриване', okLabel: 'Изтрий окончателно' });
  await tick();
  assert.equal(box.querySelector('.cfmTitle').textContent, 'Необратимо изтриване');
  assert.equal(box.querySelector('.cfmMsg').textContent, 'Историята ще бъде заличена.\n\nНаистина ли да продължа?');
  assert.equal(box.querySelector('[data-ask="ok"]').textContent, 'Изтрий окончателно');
  box.querySelector('[data-ask="cancel"]').click(); await p2;
  await new Promise(r => setTimeout(r, 200));
  // Вид 'warn' (кехлибарен): основен бутон, фокус на „Отказ“, заглавие по подразбиране „Внимание“.
  const p3 = window.askConfirm('Програмата ще се рестартира. Продължавате ли?', { kind: 'warn' }); await tick();
  assert.ok(box.classList.contains('warn'));
  assert.equal(box.querySelector('.cfmTitle').textContent, 'Внимание');
  assert.ok(box.querySelector('[data-ask="ok"]').classList.contains('pri'));
  assert.equal(d.activeElement, box.querySelector('[data-ask="cancel"]'));
  // Без изричен вид думата „рестартира“ прави въпроса необратим (червен).
  box.querySelector('[data-ask="cancel"]').click(); await p3;
  await new Promise(r => setTimeout(r, 200));
  const p4 = window.askConfirm('Програмата ще се рестартира. Продължавате ли?'); await tick();
  assert.ok(box.classList.contains('danger'));
  assert.equal(box.querySelector('[data-ask="ok"]').textContent, 'Продължи');
  box.querySelector('[data-ask="cancel"]').click(); await p4;
});

test('askConfirm: собствен слой над отворените форми — и първият, и вторият слой остават непокътнати; фокусът се връща на бутона', async () => {
  const dom = domWithDialog(); await settle();
  const { window } = dom, d = window.document;
  window.modal('Карта на читател', '<form id="readerF"><input name="name" value="Иванов"></form>');
  window.modal2('Правило', '<form id="ruleF"><input name="days" value="30"><button type="button" id="delRule">Изтрий</button></form>');
  d.getElementById('delRule').focus();
  const p = window.askConfirm('Изтриване на правилото?'); await tick();
  assert.ok(d.querySelector('#veilC').classList.contains('on'), 'въпросът не е в собствения слой');
  assert.ok(d.querySelector('#modalC').classList.contains('cfm'));
  assert.ok(d.querySelector('#readerF') && d.querySelector('#ruleF'), 'форма отдолу е изтрита');
  assert.ok(d.querySelector('#veil2').classList.contains('on') && d.querySelector('#veil').classList.contains('on'));
  d.querySelector('#modalC [data-ask="cancel"]').click();
  assert.equal(await p, false);
  assert.equal(d.activeElement, d.getElementById('delRule'), 'фокусът не се върна на бутона, задал въпроса');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(d.querySelector('#veilC').classList.contains('on'), false);
  assert.ok(d.querySelector('#ruleF') && d.querySelector('#readerF'), 'при „Отказ“ формите остават с попълненото');
  assert.equal(d.querySelector('#ruleF input').value, '30');
  // Слоят е над прегледа преди печат и под съобщенията.
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  const z = (sel) => parseInt((css.match(new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\{[^}]*z-index:(\\d+)')) || [])[1], 10);
  assert.ok(z('.veilC') > z('.veil2') && z('.veilC') > 80 && z('.veilC') < 100, 'z-index на слоя на въпросите: ' + z('.veilC'));
});

test('нито един екран не вика родния confirm(); печатът на етикети изчаква въпроса', async () => {
  for (const f of fs.readdirSync(VIEWS)) {
    const src = fs.readFileSync(path.join(VIEWS, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const bare = src.match(/(?<![\w.])confirm\(/g) || [];
    assert.deepEqual(bare, [], f + ': родният confirm() още се ползва');
    const sites = src.match(/(?<![\w.])askConfirm\(/g) || [];
    if (f === 'core.js') continue;
    for (const m of src.matchAll(/(?<![\w.])askConfirm\(/g)) {
      const before = src.slice(Math.max(0, m.index - 12), m.index);
      assert.match(before, /await\s*$/, f + ': askConfirm() без await — резултатът е обещание, което винаги е „истина“');
    }
    void sites;
  }
  // printLabelSheet() е async и връща false при отказ — извикващите го връщат, за да може да се изчака.
  const dom = buildDom({ 'settings.get': { lbl_cols: 3, lbl_w: 50, lbl_h: 25 } }); await settle();
  const { window } = dom;
  window.confirm = () => false;
  const many = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, inv_number: i + 1, title: 'Т' + i }));
  const r = window.printLabelSheet({ rows: many, card: () => '<div></div>' }, 'fund');
  assert.ok(r && typeof r.then === 'function', 'printLabelSheet трябва да връща обещание');
  assert.equal(await r, false);
});
