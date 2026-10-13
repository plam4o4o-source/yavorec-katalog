'use strict';
/* v2.4.84 — ДОСТЪПНОСТ И ГРАФИКАТА В ДВИЖЕНИЕ.
   =====================================================================
   Цялостен преглед на екраните в истински Chromium (голяма база, axe-core във
   всичките 7 цветови теми) намери:
     Д1  полетата във формите — етикетът стоеше ДО полето, без for/id: екранен
         четец обявяваше „поле за текст“ без име (axe „label“, critical) — за
         всяко поле, направено с fld(), тоест почти всяка форма в програмата;
     Д2  падащи менюта без име (година, месец, справка, филтри) — „select-name“;
     Д3  празни заглавни клетки над колоните с бутони — „empty-table-header“;
     Д4  клетките на Дневника и отметките в „Книги“ — без име;
     Д5  хоризонтално превъртащи се таблици, недостъпни от клавиатурата.
   След поправката axe не намира нищо критично, сериозно или дребно в нито една
   тема (остава само подредбата на заглавията — умерено).
   Графиката: скелет при зареждане и кратко движение на плочките, лентите,
   пръстените и стълбчетата — само при влизане в раздела и само без „намалено
   движение“. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('./helpers/e2e-app');

const APP = path.join(__dirname, '..');
const VIEWS = path.join(APP, 'src', 'views');
const CSS = fs.readFileSync(path.join(APP, 'src', 'style.css'), 'utf8');
const viewSrc = fs.readdirSync(VIEWS).filter(f => f.endsWith('.js')).map(f => [f, fs.readFileSync(path.join(VIEWS, f), 'utf8')]);

let h = null;
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

test('Д1 — fld(): етикетът е свързан с полето (for/id) — текст, число, падащо меню, многоредово', () => {
  const w = h.window;
  const host = w.document.createElement('div');
  host.innerHTML = w.fld('Заглавие', 'title') + w.fld('Отдел', 'dep', { type: 'select', opts: ['а', 'б'] })
    + w.fld('Бележка', 'note', { type: 'textarea' }) + w.fld('Заглавие', 'title');
  w.document.body.appendChild(host);
  const labels = [...host.querySelectorAll('.field > label')];
  assert.equal(labels.length, 4);
  const ids = new Set();
  for (const l of labels) {
    const ctl = l.control || w.document.getElementById(l.htmlFor);
    assert.ok(ctl, 'етикетът „' + l.textContent.trim() + '“ сочи поле');
    assert.equal(ctl.closest('.field'), l.closest('.field'), 'полето е в същото .field');
    ids.add(ctl.id);
  }
  assert.equal(ids.size, 4, 'две полета със същото име получават различни id');
  host.remove();
});

test('Д1 — формата на нова книга: всяко поле с етикет има име за екранен четец', async () => {
  await h.go('books');
  await h.clickButton('+ Нова книга', '#view');
  const fields = [...h.document.querySelectorAll('#modal .field')].filter(f => f.querySelector('label') && f.querySelector('input,select,textarea'));
  assert.ok(fields.length >= 10, 'формата има полета: ' + fields.length);
  for (const f of fields) {
    const l = f.querySelector('label'), c = f.querySelector('input,select,textarea');
    assert.equal(l.htmlFor, c.id, 'етикет „' + l.textContent.trim() + '“');
  }
  h.window.closeModal();
});

test('Д2 — всяко падащо меню в изгледите има име (aria-label, свързан етикет или идва от fld())', () => {
  const bad = [];
  for (const [f, src] of viewSrc) {
    const s = src.replace(/\/\*[\s\S]*?\*\//g, '');          // коментарите не са разметка
    for (const m of s.matchAll(/<select\b[^>]*>/g)) {
      const tag = m[0];
      if (/aria-label=|name="\$\{name\}"/.test(tag)) continue;
      const id = (tag.match(/\bid="([^"$]+)"/) || [])[1];
      if (id && new RegExp('for="' + id + '"').test(s)) continue;
      const before = s.slice(Math.max(0, m.index - 300), m.index);   // обвито в <label>…</label>
      if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
      bad.push(f + ': ' + tag.slice(0, 90));
    }
  }
  assert.deepEqual(bad, []);
});

test('Д3 — няма празни заглавни клетки над колоните с бутони', () => {
  const bad = [];
  for (const [f, s] of viewSrc) for (const m of s.matchAll(/<th(?:\s[^>]*)?><\/th>/g)) bad.push(f + ': ' + m[0]);
  assert.deepEqual(bad, []);
  assert.match(CSS, /\.vh\{position:absolute !important; width:1px; height:1px;[^}]*clip:rect\(0 0 0 0\)/, '.vh — видимо само за четеца');
});

test('Д4 — отметките в „Книги“ и клетките на Дневника имат имена', async () => {
  const s = (f) => viewSrc.find(x => x[0] === f)[1];
  assert.match(s('books.js'), /id="chkAll" aria-label="Избери всички намерени"/);
  assert.match(s('books.js'), /class="bkChk"[^>]*aria-label="Избери инв\. № /);
  await h.go('dnevnik');
  const cells = [...h.document.querySelectorAll('#view input.dnvCell')];
  assert.ok(cells.length > 100);
  assert.ok(cells.every(c => /^\d{1,2} — \S/.test(c.getAttribute('aria-label') || '')), 'ден и колона: ' + cells[0].getAttribute('aria-label'));
});

test('Д5 — хоризонтално превъртащите се таблици в „Готови справки“ са достъпни от клавиатурата', () => {
  const s = viewSrc.find(x => x[0] === 'reports.js')[1];
  const wraps = [...s.matchAll(/<div class="wrap" tabindex="0" role="region" aria-label="([^"]+)">/g)].map(m => m[1]);
  assert.equal(wraps.length, 2);
  assert.notEqual(wraps[0], wraps[1], 'двете области са с различни имена');
});

test('Скелет при зареждане: надписът остава за четеца, лентите се появяват със закъснение', async () => {
  const w = h.window;
  await h.go('dash');
  w.eval('window.__orig = RENDERERS.books; RENDERERS.books = () => new Promise(r => { window.__go = r; });');
  w.location.hash = '#books';                 // route() тръгва от смяната на адреса
  await E.sleep(40);
  const l = h.document.querySelector('#view .viewLoading');
  assert.ok(l);
  assert.equal(l.getAttribute('role'), 'status');
  assert.match(l.textContent, /Зарежда се…/);
  assert.equal(l.querySelectorAll('.skel[aria-hidden="true"] i').length, 5);
  w.eval('RENDERERS.books = window.__orig;');
  w.__go(); await h.settle();
  assert.match(CSS, /@media \(prefers-reduced-motion: no-preference\)\{\s*\.viewLoading\{animation:loadIn \.25s \.15s both\}/, 'бързият раздел не мига');
});

test('Движението е само при влизане в раздела и само без „намалено движение“', async () => {
  await h.go('stats');
  const v = h.document.querySelector('#view');
  assert.equal(v.dataset.enter, '1', 'влизане в раздела');
  await E.sleep(1250);
  assert.equal(v.dataset.enter, undefined, 'после — без движение при вътрешно пречертаване');
  const block = CSS.match(/@media \(prefers-reduced-motion: no-preference\)\{([\s\S]*?)\n\}/)[1];
  for (const sel of ['#view[data-enter] .chartFill', '#view[data-enter] .spark rect', '#view[data-enter] .ringSvg circle + circle', '#view[data-enter] .kpi']) {
    assert.ok(block.includes(sel), sel + ' — само в блока за движение');
  }
  const outside = CSS.replace(block, '');
  assert.doesNotMatch(outside, /animation:enter(Bar|Spark|Ring|Kpi)/, 'нито едно движение извън блока');
  for (const k of ['enterBar', 'enterSpark', 'enterRing', 'enterKpi', 'loadIn', 'skelShine']) assert.match(CSS, new RegExp('@keyframes ' + k + '\\{'));
});
