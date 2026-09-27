'use strict';
/* v2.4.69 — ПЕЧАТ: ЕТИКЕТИ, КАРТИ, ДОКУМЕНТИ (кръг 44, находки Е1–Е10, Х1, П4 —
 * етикетната част).
 * =====================================================================
 * Тестерът печаташе ИСТИНСКИ PDF (printToPDF), растеризираше при 300 dpi, четеше
 * баркодовете с два декодера и мереше клетките в милиметри. Тук е същото, на два
 * етажа:
 *
 *   1. jsdom + истинските main.js/handlers (E.bootApp) — ВИНАГИ. Твърди онова,
 *      което програмата подава на печата: колко етикета на кой лист, какви
 *      полета на @page, какво пита и какво казва. Оформлението (милиметри, мащаб)
 *      jsdom не смята — за него са правилата от style.css, проверени като текст.
 *
 *   2. Chromium (същият печатен рендер като Electron printToPDF) — когато на
 *      машината има playwright и Chromium (PECHAT_CHROMIUM или
 *      /opt/pw-browsers/chromium). Там се мери истинският PDF: картата 90×60 мм
 *      при широк екран отдолу (Е1), етикетите в клетките на Avery L7160 и 4×10
 *      (Е2), височината на баркода при дълго име (Е3), броят страници (Е7),
 *      „стр. N от M“ (Е9), лентата на картата в прегледа (Е8), УДК в етикета (Е6).
 *      Без Chromium тези тестове се пропускат с обяснение — не минават на празно.
 *
 * Всеки тест е проверен с мутация (поправката е връщана в отделно копие на
 * дървото, /tmp/r44/pechat-mut) — вижте доклада на кръга.
 */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, cleanupTmpDirs, fakeIpcMain, freshDb, runDep } = require('./helpers/audit-fixtures');
const E = require('./helpers/e2e-app');

const CSS = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
const printBlock = (() => {
  const i = CSS.indexOf('@media print{');
  let depth = 0, j = i + '@media print'.length;
  for (; j < CSS.length; j++) {
    if (CSS[j] === '{') depth++;
    else if (CSS[j] === '}') { depth--; if (!depth) break; }
  }
  return CSS.slice(i, j + 1).replace(/\/\*[\s\S]*?\*\//g, '');
})();
const cssNoComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

let h = null;
test.before(async () => { h = await E.bootApp(); await seedOnce(); });
test.after(() => { if (h) h.stop(); cleanupTmpDirs(); });

const W = () => h.window;
const D = () => h.document;
const dynCss = () => (D().getElementById('dynPrintStyle') || {}).textContent || '';
const sheet = () => D().getElementById('ppSheet');
const labelsOn = (root) => Array.from(root.querySelectorAll('.lbl'));
async function settings(o) {
  const cols = Object.keys(o);
  h.db.prepare(`UPDATE settings SET ${cols.map(c => c + ' = @' + c).join(', ')} WHERE id = 1`).run(o);
  await W().loadSettingsCache();
}
const FORMAT_DEFAULT = { lbl_mode: 'sheet', lbl_w: 40, lbl_h: 30, lbl_cols: 3, lbl_gap: 3, lbl_margin: 8,
  lbl_mt: 8, lbl_ml: 8, lbl_gx: 3, lbl_gy: 3, lbl_border: 1, sig_w: 25, sig_h: 35, card_w: 90, card_h: 60 };
function closePreview() { if (D().getElementById('printPreview').classList.contains('on')) W().ppClose(); }
function noRendererErrors() {
  const errs = h.errors.splice(0);
  assert.equal(errs.length, 0, 'грешки в екранния слой:\n' + errs.map(e => (e && (e.stack || e.message)) || String(e)).join('\n---\n'));
}

/* Данни: 60 книги с инв. № 900001… (без дупки), 1 000 читатели с карти. */
async function seedOnce() {
  if (seedOnce.done) return; seedOnce.done = true;
  const insB = h.db.prepare(`INSERT INTO books (inv_number, title, author, udk, author_mark, call_number, register_date, status, price)
    VALUES (?, ?, 'Вазов, Иван', ?, ?, ?, '2026-09-20', 'наличен', 1)`);
  const insR = h.db.prepare(`INSERT INTO readers (name, card_no, status, category, registered_at, gdpr_consent)
    VALUES (?, ?, 'активен', 'възрастен', '2026-09-01', 1)`);
  h.db.transaction(() => {
    for (let i = 0; i < 60; i++) insB.run(900001 + i, 'Книга № ' + i, '821.163.2-31', 'В' + i, null);
    insB.run(900100, 'Внесена сигнатура', '821.163.2-31', null, '821.163.2-31 В12');
    insB.run(900101, 'Само УДК и знак', '94(497.2)"1878/1944"', 'Й 83', null);
    for (let i = 0; i < 1000; i++) insR.run('Читател № ' + i, String(500000 + i));
  })();
}

/* ==================================================================
   Е1 — разпечатката е 1:1, каквото и да има на екрана зад прегледа
   ================================================================== */
test('Е1: при печат всичко освен #printArea е ИЗВАДЕНО от подредбата (display:none), не само скрито', () => {
  /* visibility:hidden оставяше програмата в страницата с пълните ѝ размери; когато
     списъкът след търсене е по-широк от листа, Chromium смаляваше ЦЯЛАТА разпечатка
     (карта 83×55 вместо 90×60, квитанция на 78 %). */
  assert.doesNotMatch(printBlock, /body\s*\*\s*\{\s*visibility\s*:\s*hidden/,
    'скриването с visibility оставя програмата в подредбата на печата');
  assert.match(printBlock, /body\s*>\s*:not\(#printArea\)\s*\{\s*display\s*:\s*none\s*!important/,
    'всичко освен #printArea трябва да е display:none при печат');
  assert.doesNotMatch(printBlock, /#printArea\s*\{[^}]*position\s*:\s*absolute/,
    '#printArea е в нормалния поток — абсолютното позициониране върху програмата вече не е нужно');
  // #printArea наистина е пряко дете на <body> — иначе правилото не го пощадява.
  assert.equal(D().getElementById('printArea').parentElement, D().body);
});

/* ==================================================================
   Е2 — поле отгоре/отляво, разстояние по двете посоки, редове, позиция N
   ================================================================== */
test('Е2: обработчикът пази четирите числа на листа, превежда старите две и казва кое е подрязал', async () => {
  const { db } = freshDb('pechat-set-');
  db.exec(`ALTER TABLE settings ADD COLUMN lbl_mt REAL; ALTER TABLE settings ADD COLUMN lbl_ml REAL;
           ALTER TABLE settings ADD COLUMN lbl_gx REAL; ALTER TABLE settings ADD COLUMN lbl_gy REAL;`);
  const ipc = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'settings'))(ipc, { getDb: () => db, run: runDep, logAudit: () => {},
    dialog: {}, getMainWindow: () => ({}), fs, path });
  let r = await ipc.invoke('settings:updateLabelFormat', { lbl_mode: 'sheet', lbl_w: '63.5', lbl_h: '38.1', lbl_cols: 3,
    lbl_mt: '15.1', lbl_ml: '7.2', lbl_gx: '2.5', lbl_gy: '0', lbl_border: true });
  assert.ok(r.ok, r.error);
  let row = db.prepare('SELECT lbl_mt, lbl_ml, lbl_gx, lbl_gy, lbl_margin, lbl_gap FROM settings WHERE id=1').get();
  assert.deepEqual(Object.assign({}, row), { lbl_mt: 15.1, lbl_ml: 7.2, lbl_gx: 2.5, lbl_gy: 0, lbl_margin: 7.2, lbl_gap: 2.5 },
    'Avery L7160 — горе 15,1, ляво 7,2, хоризонтално 2,5, вертикално 0');
  assert.deepEqual(r.data.clamped, [], 'нищо не е подрязано');
  // Стар извикващ (само две числа) — същото като преди. Числата НЕ са фабричните
  // 8 и 3: иначе превеждането „поле → горе и ляво, разстояние → по двете посоки“
  // не се различава от подразбирането при липсващо поле и тестът не пази нищо.
  r = await ipc.invoke('settings:updateLabelFormat', { lbl_margin: 10, lbl_gap: 4 });
  row = db.prepare('SELECT lbl_mt, lbl_ml, lbl_gx, lbl_gy FROM settings WHERE id=1').get();
  assert.deepEqual(Object.assign({}, row), { lbl_mt: 10, lbl_ml: 10, lbl_gx: 4, lbl_gy: 4 });
  // „63,5“ в числово поле ставаше 635 → тихо 210. Сега подрязването се казва.
  r = await ipc.invoke('settings:updateLabelFormat', { lbl_w: 635, lbl_mt: 15.1 });
  assert.deepEqual(r.data.clamped.map(c => [c.field, c.given, c.saved]), [['lbl_w', 635, 210]]);
});

test('Е2: формата има четирите полета, приема запетая и записва 15,1 като 15,1', async () => {
  await settings(FORMAT_DEFAULT);
  await h.go('labels');
  for (const n of ['lbl_mt', 'lbl_ml', 'lbl_gx', 'lbl_gy']) assert.ok(h.$('#lblFmtF [name=' + n + ']'), 'липсва полето ' + n);
  assert.equal(h.$('#lblFmtF [name=lbl_margin]'), null, 'общото „Поле на листа“ е заменено от двете отделни');
  h.type('#lblFmtF [name=lbl_w]', '63,5'); h.type('#lblFmtF [name=lbl_h]', '38,1');
  h.type('#lblFmtF [name=lbl_mt]', '15,1'); h.type('#lblFmtF [name=lbl_ml]', '7,2');
  h.type('#lblFmtF [name=lbl_gx]', '2,5'); h.type('#lblFmtF [name=lbl_gy]', '0');
  await W().saveLabelFormat();
  await h.settle();
  const row = h.db.prepare('SELECT lbl_w, lbl_h, lbl_mt, lbl_ml, lbl_gx, lbl_gy FROM settings WHERE id=1').get();
  assert.deepEqual(Object.assign({}, row), { lbl_w: 63.5, lbl_h: 38.1, lbl_mt: 15.1, lbl_ml: 7.2, lbl_gx: 2.5, lbl_gy: 0 });
  assert.match(h.viewText(), /етикети за фонда 3 × 7/, 'екранът казва колко излизат на лист при записания формат');
  noRendererErrors();
});

test('Е2: Avery L7160 — @page с горе 15,1 и ляво 7,2, мрежа 3 × 63,5 мм, 2,5 мм между колоните и 0 между редовете, 21 на лист', async () => {
  await settings(Object.assign({}, FORMAT_DEFAULT, { lbl_w: 63.5, lbl_h: 38.1, lbl_mt: 15.1, lbl_ml: 7.2, lbl_gx: 2.5, lbl_gy: 0 }));
  await h.go('labels');
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900030');
  await W().printLabelsRange(); await h.settle();
  const css = dynCss();
  assert.match(css, /@page\{size:A4;margin:15\.1mm 0mm 0mm 7\.2mm\}/, 'полетата на листа');
  assert.match(css, /grid-template-columns:repeat\(3,63\.5mm\);grid-auto-rows:38\.1mm;column-gap:2\.5mm;row-gap:0mm/);
  const pages = sheet().querySelectorAll('.lblpage');
  assert.deepEqual(Array.from(pages).map(p => labelsOn(p).length), [21, 9], '3 × 7 = 21 на първия лист, останалите 9 — на втория');
  assert.equal(sheet().querySelectorAll('.pbreak').length, 1, 'между двата листа — нов лист');
  closePreview();
});

test('Е2: 4×10 48,5×25,4 с поле отгоре 21,5 — 10 реда на лист, не 11', async () => {
  await settings(Object.assign({}, FORMAT_DEFAULT, { lbl_cols: 4, lbl_w: 48.5, lbl_h: 25.4, lbl_mt: 21.5, lbl_ml: 8, lbl_gx: 0, lbl_gy: 0 }));
  await h.go('labels');
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900044');
  await W().printLabelsRange(); await h.settle();
  const pages = Array.from(sheet().querySelectorAll('.lblpage')).map(p => labelsOn(p).length);
  assert.deepEqual(pages, [40, 4], '4 колони × 10 реда = 40 на лист');
  assert.match(dynCss(), /repeat\(4,48\.5mm\)/, 'четирите колони се събират точно (4 × 48,5 = 194 = 210 − 2 × 8)');
  closePreview();
});

test('Е2: „Започни от позиция 5“ оставя първите 4 клетки празни и казва го; позиция извън листа — отказ с дума', async () => {
  await settings(FORMAT_DEFAULT);
  await h.go('labels');
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900024');
  h.type('[name=lblStart]', '5');
  await W().printLabelsRange(); await h.settle();
  const first = sheet().querySelector('.lblpage');
  const cells = Array.from(first.children).map(c => c.className.split(' ')[0]);
  assert.deepEqual(cells.slice(0, 5), ['lbl-skip', 'lbl-skip', 'lbl-skip', 'lbl-skip', 'lbl'], 'първият етикет е в 5-ата клетка');
  assert.equal(labelsOn(first).length, 20, 'на започнатия лист остават 24 − 4 = 20 места');
  assert.equal(labelsOn(sheet()).length, 24, 'всичките 24 етикета се отпечатват (4 минават на следващия лист)');
  assert.match(h.text('#ppHint'), /позиция 5/);
  closePreview();
  const before = h.toasts.length;
  h.type('[name=lblStart]', '25');
  await W().printLabelsRange(); await h.settle();
  assert.match((h.toastsSince(before).pop() || {}).msg || '', /от 1 до 24.*Нищо не е отпечатано/);
  assert.ok(!D().getElementById('printPreview').classList.contains('on'));
  h.type('[name=lblStart]', '1');
});

/* ==================================================================
   Е3 — баркодът с фиксирана височина, заглавието се свива/реже
   ================================================================== */
test('Е3: баркодът не се свива (flex:0 0 auto, височина от --lbh), свива се само заглавната част', async () => {
  assert.match(cssNoComments, /\.lbl svg\{[^}]*height:var\(--lbh, 11mm\)[^}]*flex:0 0 auto/, 'баркодът не отстъпва височина');
  assert.match(cssNoComments, /\.lbl \.lhead\{[^}]*flex:0 1 auto[^}]*min-height:0[^}]*overflow:hidden/, 'заглавието се свива и реже');
  await settings(Object.assign({}, FORMAT_DEFAULT, { org: 'Народно читалище „Братя Миладинови – 1869“', place: 'гр. Благоевград, кв. „Струмско“' }));
  await h.go('labels');
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900003');
  await W().printLabelsRange(); await h.settle();
  assert.match(dynCss(), /\.lbl-fund\{--lfs:[\d.]+;--lbh:11mm\}/, '40×30 → лентите 11 мм');
  const lbl = sheet().querySelector('.lbl');
  assert.ok(lbl.querySelector('.lhead .lh2'), 'името е в свиваемата .lhead');
  assert.equal(lbl.querySelector('svg').parentElement, lbl, 'баркодът е ИЗВЪН .lhead');
  closePreview();
  await settings({ lbl_h: 25.4 });
  assert.equal(W().lblBarMm(25.4), 9.2);
  assert.equal(W().lblBarMm(12), 6.5, 'никога под 6,5 мм (Code 39 иска 6,35)');
  await settings(FORMAT_DEFAULT);
});

/* ==================================================================
   Е4 — голям печат на партиди, всяка отделен документ
   ================================================================== */
test('Е4: 1 000 карти — въпросът казва истината (4 партиди, листове, памет), а партидите идват една след друга', async () => {
  await settings(Object.assign({}, FORMAT_DEFAULT, { org: 'НЧ „Проба“', place: 'с. Проба' }));
  await h.go('labels');
  h.stats.calls.length = 0;
  const asked = h.hooks.confirms.length;
  h.hooks.confirmAnswer = true;
  await W().printCardsAll(); await h.settle();
  const q = h.hooks.confirms.slice(asked);
  assert.equal(q.length, 1);
  assert.match(q[0], /^ПЕЧАТ НА 1000 ЧИТАТЕЛСКИ КАРТИ/, 'картите се казват карти, не „етикета“');
  assert.match(q[0], /125 листа A4 .*8 на лист/, 'листовете са истинските: 2 × 4 карти');
  assert.match(q[0], /4 отделни документа по до 296/);
  assert.doesNotMatch(q[0], /десетки секунди/, 'старото обещание не отговаряше на измереното');
  assert.equal(labelsOn(sheet()).length, 296, 'в паметта е само първата партида (37 листа)');
  assert.match(h.text('#ppTitle'), /партида 1 от 4/);
  assert.match(h.text('#ppHint'), /Партида 1 от 4 .*1–296 от 1000/);
  // „Печат…“ на първата → след диалога се отваря втората.
  W().ppPrint();
  await h.waitFor(() => /партида 2 от 4/.test(h.text('#ppTitle')) && D().getElementById('printPreview').classList.contains('on'),
    'втората партида', 3000);
  assert.equal(labelsOn(sheet()).length, 296);
  // Редът е този, в който „Читатели“ ги връща — 297-ият от списъка открива втората партида.
  const list = (h.stats.calls.find(c => c.channel === 'readers:list').result.data || []).filter(r => r.status !== 'прекратен');
  const r297 = list[296].name;
  assert.equal(labelsOn(sheet())[0].querySelector('.rc-reader').textContent, r297,
    'втората партида продължава оттам, докъдето е стигнала първата');
  // „Отказ“ на втората — казва докъде е стигнал печатът.
  const before = h.toasts.length;
  W().ppClose();
  const msg = (h.toastsSince(before).find(t => t.type === 'warn') || {}).msg || '';
  assert.match(msg, /отпечатани са партиди 1–1 от 4 \(296 от 1000 читателски карти\)\. Останалите 704 не са отпечатани/);
  assert.ok(msg.includes('Първата неотпечатана е на „' + r297 + '“'), msg);
  noRendererErrors();
});

test('Е4: до 300 етикета — един документ и без въпрос', async () => {
  await h.go('labels');
  const asked = h.hooks.confirms.length;
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900060');
  await W().printLabelsRange(); await h.settle();
  assert.equal(h.hooks.confirms.length, asked, '60 етикета са обичайна работа');
  assert.equal(labelsOn(sheet()).length, 60);
  assert.doesNotMatch(h.text('#ppTitle'), /партида/);
  closePreview();
});

/* ==================================================================
   Е5 — подписите не остават сами
   ================================================================== */
test('Е5: подписите не се отделят от последния блок; декларацията на картона е в един блок с подписа', async () => {
  assert.match(cssNoComments, /\.pdoc \.psig\{[^}]*break-inside:avoid[^}]*break-before:avoid/);
  assert.match(cssNoComments, /\.pdoc :has\(\+ \.psig\)\{break-after:avoid/);
  assert.match(cssNoComments, /\.pdoc table:has\(\+ \.psig\) tbody tr:nth-last-child\(-n\+2\)\{break-before:avoid/,
    'таблицата пренася последните си редове заедно с подписите');
  assert.match(cssNoComments, /\.pdoc \.psigKeep\{break-inside:avoid/);
  const rid = h.db.prepare("SELECT id FROM readers WHERE card_no = '500001'").get().id;
  await W().printReaderCard(rid); await h.settle();
  const keep = sheet().querySelector('.psigKeep');
  assert.ok(keep, 'декларацията и подписът са в .psigKeep');
  assert.match(keep.textContent, /ДЕКЛАРАЦИЯ НА ЧИТАТЕЛЯ[\s\S]*чл\. 47, ал\. 2/);
  assert.ok(keep.querySelector('.psig') && /Подпис на читателя/.test(keep.querySelector('.psig').textContent),
    'подписът на читателя е в същия блок като декларацията');
  closePreview();
});

/* ==================================================================
   Е6 и П4 — сигнатурният етикет
   ================================================================== */
test('Е6: УДК се пренася само между смислените части и никога след тире; нищо не излиза от етикета', async () => {
  const segs = (udk) => {
    const d = D().createElement('div');
    d.innerHTML = W().sigLblCard({ udk, author_mark: 'В12', inv_number: 1 });
    return Array.from(d.querySelectorAll('.ls-udk .ls-seg')).map(s => s.textContent);
  };
  assert.deepEqual(segs('821.163.2-31'), ['821.163.2', '-31'], 'допълнителният определител не се откъсва като „…-“ / „31“');
  assert.deepEqual(segs('94(497.2)"1878/1944"'), ['94', '(497.2)', '"1878/1944"'], 'кавичките на времевия определител са едно цяло');
  assert.deepEqual(segs('908(497.2-37 Яворец)'), ['908', '(497.2-37', 'Яворец)'], 'интервалът се пази');
  assert.match(cssNoComments, /\.lbl\{[^}]*overflow:hidden/, 'етикетът реже всичко, което не се е събрало');
  assert.match(cssNoComments, /\.lbl-sig \.ls-udk\{[^}]*font-size:calc\(8\.5pt \* var\(--sfs, 1\)\)[^}]*overflow-wrap:anywhere/);
});

test('П4: попълнената „Сигнатура“ се печата САМА — УДК не излиза два пъти; иначе УДК и авторски знак на два реда', async () => {
  await h.go('labels');
  h.type('[name=sigFrom]', '900100'); h.type('[name=sigTo]', '900101');
  await W().printSignatureLabelsRange(); await h.settle();
  const [own, pair] = labelsOn(sheet());
  assert.equal(own.textContent.replace(/\s+/g, ' ').trim(), '821.163.2-31 В12');
  assert.equal((own.textContent.match(/821\.163\.2/g) || []).length, 1, 'УДК веднъж');
  assert.equal(pair.querySelector('.ls-udk').textContent, '94(497.2)"1878/1944"');
  assert.equal(pair.querySelector('.ls-avt').textContent, 'Й 83');
  closePreview();
});

/* ==================================================================
   Е7 — празни страници в края
   ================================================================== */
test('Е7: точно пълен лист е една страница; ролката не изхвърля празен етикет накрая', async () => {
  assert.match(printBlock, /#printArea \.pdoc:last-child\{[^}]*padding-bottom:0/, 'отстъпът под последния документ не прелива на нов лист');
  assert.match(printBlock, /#printArea \.pdoc\.lbldoc\{padding:0\}/);
  await settings(Object.assign({}, FORMAT_DEFAULT, { lbl_w: 70, lbl_h: 37, lbl_mt: 0, lbl_ml: 0, lbl_gx: 0, lbl_gy: 0 }));
  await h.go('labels');
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900024');
  await W().printLabelsRange(); await h.settle();
  assert.equal(sheet().querySelectorAll('.lblpage').length, 1, '24 етикета 70×37 = точно един лист 3 × 8');
  assert.equal(sheet().querySelectorAll('.pbreak').length, 0, 'без нов лист след последния');
  assert.ok(sheet().querySelector('.pdoc.lbldoc'));
  closePreview();
  await settings(Object.assign({}, FORMAT_DEFAULT, { lbl_mode: 'roll', lbl_w: 50, lbl_h: 25 }));
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900003');
  await W().printLabelsRange(); await h.settle();
  const css = dynCss();
  assert.doesNotMatch(css, /page-break-after:always/, 'новата страница СЛЕД всеки етикет дава празна накрая');
  assert.match(css, /\.lbl \+ \.lbl\{break-before:page/);
  assert.match(css, /@page\{size:50mm 25mm;margin:0mm\}/);
  closePreview();
  await settings(FORMAT_DEFAULT);
});

/* ==================================================================
   Е8 — прегледът на картата = отпечатаната карта
   ================================================================== */
test('Е8: правилата от setPrintPage носят само размера и рамката — подредбата на картата е една и съща в прегледа и в печата', async () => {
  await h.go('labels');
  const rid = h.db.prepare("SELECT id FROM readers WHERE card_no = '500001'").get().id;
  await W().printCardOne(rid); await h.settle();
  const css = dynCss(), scoped = D().getElementById('ppExtraStyle').textContent;
  for (const c of [css, scoped]) {
    assert.doesNotMatch(c, /\.lbl\{[^}]*(align-items|justify-content|display)/,
      'подредбата в extraCss се ограничава с #ppSheet в прегледа и надделява над .lbl.rcard само там');
  }
  assert.match(cssNoComments, /\.lbl\.rcard, \.rcard\{[^}]*align-items:stretch/);
  closePreview();
});

/* ==================================================================
   Е9 — „стр. N от M“ и № на документа на следващите листове
   ================================================================== */
test('Е9: всеки A4 документ получава „стр. N от M“ и името си от лист 2 нататък; етикетите и писмата — не', async () => {
  W().setPrintPage({ name: 'Акт за отчисляване № 11-2026', landscape: false, margin: '14mm 12mm' });
  let css = dynCss();
  assert.match(css, /@bottom-right\{content:"стр\. " counter\(page\) " от " counter\(pages\)/);
  assert.match(css, /@top-right\{content:"Акт за отчисляване № 11-2026"/);
  assert.match(css, /@page:first\{@top-right\{content:none\}\}/, 'на лист 1 заглавието е в самия документ');
  W().setPrintPage({ name: 'Пример "в кавички"' });
  assert.match(dynCss(), /content:"Пример \\"в кавички\\""/, 'кавичките в името не чупят правилото');
  await h.go('labels');
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900003');
  await W().printLabelsRange(); await h.settle();
  assert.doesNotMatch(dynCss(), /counter\(page/, 'полето на листа с етикети е мястото на първия ред');
  closePreview();
  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'logo-org.js'), 'utf8');
  assert.match(src, /name: 'Напомнителни писма — ' \+ bg\(today\(\)\)[^)]*pageNumbers: false/,
    'писмото до един читател не носи „стр. 37 от 173“');
});

/* ==================================================================
   Е10 — дребните
   ================================================================== */
test('Е10: сигнатурните етикети — в толкова колони, колкото се събират (49 на лист), без общите 3', async () => {
  await settings(FORMAT_DEFAULT);
  await h.go('labels');
  h.type('[name=sigFrom]', '900001'); h.type('[name=sigTo]', '900060');
  await W().printSignatureLabelsRange(); await h.settle();
  assert.match(dynCss(), /repeat\(7,25mm\)/);
  assert.equal(labelsOn(sheet().querySelector('.lblpage')).length, 49);
  closePreview();
});

test('Е10 и Х1: читателската карта с фабричните настройки — без „Колоните са намалени…“; тиха зона ≥ 10 модула', async () => {
  const before = h.toasts.length;
  const rid = h.db.prepare("SELECT id FROM readers WHERE card_no = '500001'").get().id;
  await W().printCardOne(rid); await h.settle();
  assert.equal(h.toastsSince(before).filter(t => /Колоните са намалени/.test(t.msg)).length, 0);
  assert.match(dynCss(), /repeat\(2,90mm\)/);
  const bar = sheet().querySelector('.rc-bar');
  const bw = parseFloat((bar.getAttribute('style') || '').replace(/.*--bw:/, ''));
  const units = W().code39Units('500001');
  const module = bw / units;
  const quiet = (90 - bw) / 2; // до ръба на картата
  assert.ok(quiet >= 10 * module - 1e-9, `тиха зона ${quiet.toFixed(2)} мм < 10 модула (${(10 * module).toFixed(2)} мм)`);
  assert.ok(module <= 0.5 + 1e-9);
  closePreview();
});

test('Е10: празна библиотека — етикетът излиза без име, но програмата го казва', async () => {
  const s = h.db.prepare('SELECT org, lib_name FROM settings WHERE id=1').get();
  await settings({ org: null, lib_name: null });
  await h.go('labels');
  const before = h.toasts.length;
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900001');
  await W().printLabelsRange(); await h.settle();
  const w = h.toastsSince(before).filter(t => t.type === 'warn').map(t => t.msg).join(' ');
  assert.match(w, /не е попълнено наименованието на библиотеката — етикетите излизат без име/);
  assert.match(h.text('#ppHint'), /без име/);
  closePreview();
  await settings({ org: s.org, lib_name: s.lib_name });
});

test('Е10: „Липсва 1 номер“, не „Липсват 1 номера“', async () => {
  const b5 = h.db.prepare('SELECT * FROM books WHERE inv_number = 900005').get();
  h.db.prepare('DELETE FROM books WHERE inv_number = 900005').run();
  await h.go('labels');
  const asked = h.hooks.confirms.length;
  h.hooks.confirmAnswer = false;
  h.type('[name=lblFrom]', '900001'); h.type('[name=lblTo]', '900006');
  await W().printLabelsRange(); await h.settle();
  h.hooks.confirmAnswer = true;
  const q = h.hooks.confirms.slice(asked).join('\n');
  assert.match(q, /ще излязат 5 етикета\. Липсва 1 номер: 900005\./);
  const cols = Object.keys(b5);
  h.db.prepare(`INSERT INTO books (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(b5);
});

/* ==================================================================
   Х1 — известието не държи бутоните
   ================================================================== */
test('Х1: тялото на известието не хваща мишката и не спира таймера; спира го само ×', async () => {
  assert.match(cssNoComments, /\.toast\{pointer-events:none\}/, 'щракването минава към бутона под известието');
  assert.match(cssNoComments, /\.toast \.tx\{pointer-events:auto\}/);
  assert.match(cssNoComments, /body:has\(#printPreview\.on\) #toasts, body:has\(\.veil\.on\) #toasts\{bottom:/,
    'докато е отворен прегледът или прозорец, известията са над бутоните');
  W().toast('Проба за мишката.', 'ok');
  const t = Array.from(D().querySelectorAll('#toasts .toast')).find(x => /Проба за мишката/.test(x.textContent));
  t.dispatchEvent(new (W().MouseEvent)('mouseenter'));
  await h.sleep(4000);
  assert.ok(!t.isConnected || t.classList.contains('out'), 'посочването на текста вече не държи известието вечно');
  W().toast('Проба за ×.', 'ok');
  const t2 = Array.from(D().querySelectorAll('#toasts .toast')).find(x => /Проба за ×/.test(x.textContent));
  t2.querySelector('.tx').dispatchEvent(new (W().MouseEvent)('mouseenter'));
  await h.sleep(4000);
  assert.ok(t2.isConnected && !t2.classList.contains('out'), 'посочено ×, известието чака');
  t2.querySelector('.tx').click();
});

/* ==================================================================
   Chromium — истинският PDF (пропуска се, ако на машината няма Chromium)
   ================================================================== */
function findChromium() {
  let pw = null;
  for (const p of [process.env.PECHAT_PLAYWRIGHT, 'playwright', '/home/claude/.npm-global/lib/node_modules/playwright'].filter(Boolean)) {
    try { pw = require(p); break; } catch (e) { /* следващият */ }
  }
  const exe = [process.env.PECHAT_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean).find(p => fs.existsSync(p));
  return pw && exe ? { pw, exe } : null;
}
const CH = findChromium();
const MM = 72 / 25.4;
/* Текстът и позицията му в PDF — през pdftotext -bbox (poppler); без него Chromium
   тестовете също се пропускат. */
function pdfWords(file) {
  const { execFileSync } = require('child_process');
  const xml = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
  const pages = [];
  for (const pg of xml.split('<page ').slice(1)) {
    const words = [];
    for (const m of pg.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
      words.push({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: m[5].replace(/&quot;/g, '"').replace(/&amp;/g, '&') });
    }
    pages.push(words);
  }
  return pages;
}
let hasPdftotext = false;
try { require('child_process').execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); hasPdftotext = true; } catch (e) { hasPdftotext = false; }
const SKIP = !CH ? 'няма playwright/Chromium на машината (PECHAT_CHROMIUM)' : (!hasPdftotext ? 'няма pdftotext (poppler)' : false);

async function chromiumPage(settingsRow, extra) {
  const browser = await CH.pw.chromium.launch({ executablePath: CH.exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.addInitScript(([st, extra]) => {
    const data = { 'settings.get': st, 'readers.get': extra.reader || null, 'readers.list': [], 'books.list': [] };
    const node = (parts) => new Proxy(function () {}, {
      get(t, p) { return p === 'then' || typeof p === 'symbol' ? undefined : node(parts.concat(p)); },
      apply() { const k = parts.join('.'); return Promise.resolve({ ok: true, data: k in data ? data[k] : [] }); }
    });
    window.api = node([]);
  }, [settingsRow, extra || {}]);
  await page.goto('file://' + path.join(APP_DIR, 'src', 'index.html'));
  await page.waitForFunction(() => typeof printLabelSheet === 'function' && SETTINGS_CACHE);
  return { browser, page };
}
async function pdfOf(page, file) {
  await page.evaluate(() => ppFillPrintArea());
  await page.pdf({ path: file, printBackground: true, preferCSSPageSize: true });
  return file;
}
const tmpPdf = (n) => path.join(require('os').tmpdir(), 'pechat-v2469-' + process.pid + '-' + n + '.pdf');
const pdfPages = (file) => (fs.readFileSync(file, 'latin1').match(/\/Type\s*\/Page\b/g) || []).length;

/* Истинската програма в Chromium, свързана с истинските обработчици (h.app) — като
   тестера: „Читатели“ → търсене по № на карта → карта. */
async function chromiumRealApp() {
  const browser = await CH.pw.chromium.launch({ executablePath: CH.exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.exposeBinding('__ipc', async (_src, channel, args) => {
    let res;
    try { res = await h.app.invoke(channel, ...(args || [])); } catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
    return res === undefined ? null : JSON.parse(JSON.stringify(res, (k, v) => (v && v.type === 'Buffer' ? null : v)));
  });
  await page.addInitScript((tbl) => {
    const api = {};
    for (const [ns, methods] of Object.entries(tbl)) {
      const o = {};
      for (const [name, spec] of Object.entries(methods)) {
        if (spec.channel) o[name] = (...args) => window.__ipc(spec.channel, args);
        else if (spec.kind === 'listener') o[name] = () => {};
        else o[name] = (f) => (f && f.path) || '';
      }
      api[ns] = o;
    }
    window.api = api;
  }, E.preloadTable());
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto('file://' + path.join(APP_DIR, 'src', 'index.html'));
  await page.waitForFunction(() => typeof printLabelSheet === 'function' && SETTINGS_CACHE);
  return { browser, page };
}

test('Chromium Е1: карта 90×60 мм и след търсене в „Читатели“ (дотук 83×55, мащаб 0,917)', { skip: SKIP }, async () => {
  await settings(Object.assign({}, FORMAT_DEFAULT, { org: 'НЧ „Проба“', lib_name: 'Библиотека', place: 'с. Проба' }));
  const { browser, page } = await chromiumRealApp();
  try {
    await page.evaluate(() => { location.hash = '#readers'; });
    await page.waitForSelector('#rSearch');
    await page.fill('#rSearch', '500001'); await page.press('#rSearch', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#rBody tr').length === 1);
    await page.evaluate(() => printCardOne(+document.querySelector('#rBody tr').dataset.id));
    await page.waitForSelector('#printPreview.on');
    const f = await pdfOf(page, tmpPdf('e1'));
    const w = pdfWords(f)[0];
    const cat = w.find(x => x.t === 'Категория:'), reg = w.find(x => /^\d\d\.\d\d\.\d{4}$/.test(x.t));
    // „Категория:“ е на левия отстъп (3 мм), датата — на десния: разстоянието е 84 мм × мащаба.
    const inner = (reg.x1 - cat.x0) / MM;
    assert.ok(Math.abs(inner - 84) < 1.2, `вътрешната ширина на картата е ${inner.toFixed(1)} мм вместо 84 (мащаб ${(inner / 84).toFixed(3)})`);
  } finally { await browser.close(); }
});

test('Chromium Е2: Avery L7160 и 4×10 — всеки номер е в своята клетка; 4×10 дава 10 реда', { skip: SKIP }, async () => {
  for (const [id, fmt, n, cols, rows] of [
    ['l7160', { lbl_cols: 3, lbl_w: 63.5, lbl_h: 38.1, lbl_mt: 15.1, lbl_ml: 7.2, lbl_gx: 2.5, lbl_gy: 0 }, 21, 3, 7],
    ['4x10', { lbl_cols: 4, lbl_w: 48.5, lbl_h: 25.4, lbl_mt: 21.5, lbl_ml: 8, lbl_gx: 0, lbl_gy: 0 }, 44, 4, 10]
  ]) {
    const st = Object.assign({}, FORMAT_DEFAULT, fmt, { org: 'НЧ „Проба“', place: 'с. Проба', lbl_border: 0 });
    const { browser, page } = await chromiumPage(st);
    try {
      await page.evaluate((n) => printLabelSheet({ rows: Array.from({ length: n }, (_, i) => ({ inv_number: 7000 + i })), card: lblCard }, 'fund'), n);
      const f = await pdfOf(page, tmpPdf('e2-' + id));
      const pages = pdfWords(f);
      const per = cols * rows;
      assert.equal(pages.length, Math.ceil(n / per), id + ': брой листове');
      for (let i = 0; i < n; i++) {
        const pg = pages[Math.floor(i / per)], k = i % per, r = Math.floor(k / cols), c = k % cols;
        const word = pg.find(x => x.t === String(7000 + i));
        assert.ok(word, id + ': номерът ' + (7000 + i) + ' липсва');
        const x0 = (fmt.lbl_ml + c * (fmt.lbl_w + fmt.lbl_gx)) * MM, y0 = (fmt.lbl_mt + r * (fmt.lbl_h + fmt.lbl_gy)) * MM;
        const cx = (word.x0 + word.x1) / 2, cy = (word.y0 + word.y1) / 2;
        assert.ok(cx > x0 && cx < x0 + fmt.lbl_w * MM && cy > y0 && cy < y0 + fmt.lbl_h * MM,
          `${id}: № ${7000 + i} (ред ${r + 1}, колона ${c + 1}) не е в клетката си`);
      }
    } finally { await browser.close(); }
  }
});

test('Chromium Е3, Е6, Е8: баркодът е 11 мм при дълго име; УДК не излиза от етикета; лентата на картата е през цялата карта', { skip: SKIP }, async () => {
  const st = Object.assign({}, FORMAT_DEFAULT, { org: 'Народно читалище „Просвещение – 1870“ при Община Благоевград', place: 'гр. Благоевград, кв. „Струмско“' });
  const { browser, page } = await chromiumPage(st);
  try {
    const r = await page.evaluate(async () => {
      const mm = (px) => px * 25.4 / 96;
      await printLabelSheet(lblCard({ inv_number: 1234567 }), 'fund');
      const z = parseFloat(document.getElementById('ppSheet').style.zoom) || 1;
      const svg = document.querySelector('#ppSheet .lbl svg').getBoundingClientRect();
      const num = document.querySelector('#ppSheet .lbl .l3').getBoundingClientRect();
      const lbl = document.querySelector('#ppSheet .lbl').getBoundingClientRect();
      const out = { bar: mm(svg.height / z), numInside: num.bottom <= lbl.bottom + 0.5 };
      ppClose();
      // Име, което не се събира дори с най-дребния шрифт — предупреждение в прегледа.
      const org = SETTINGS_CACHE.org;
      SETTINGS_CACHE.org = org.repeat(6);
      await printLabelSheet(lblCard({ inv_number: 1 }), 'fund');
      out.hint = document.getElementById('ppHint').textContent;
      out.bar2 = mm(document.querySelector('#ppSheet .lbl svg').getBoundingClientRect().height / (parseFloat(document.getElementById('ppSheet').style.zoom) || 1));
      SETTINGS_CACHE.org = org;
      ppClose();
      const udk = ['821.111(73)-31', '94(497.2)"1878/1944"', '821.111(73)-311.6.09+929Хемингуей,Ърнест1899-1961'];
      await printLabelSheet(udk.map(u => sigLblCard({ udk: u, author_mark: 'В12', inv_number: 1 })).join(''), 'sig');
      out.spill = Array.from(document.querySelectorAll('#ppSheet .lbl-sig')).map(l => {
        const b = l.getBoundingClientRect();
        return Array.from(l.querySelectorAll('.ls-seg')).some(s => { const q = s.getBoundingClientRect(); return q.left < b.left - 0.5 || q.right > b.right + 0.5 || q.bottom > b.bottom + 0.5; });
      });
      ppClose();
      await printLabelSheet(readerCardHtml({ name: 'Иванова, Мария', card_no: '100001', category: 'възрастен' }), 'card');
      const c = document.querySelector('#ppSheet .rcard'), t = c.querySelector('.rc-top');
      out.band = t.getBoundingClientRect().width / c.getBoundingClientRect().width;
      ppClose();
      return out;
    });
    assert.ok(r.bar >= 10.9, `баркодът е ${r.bar.toFixed(2)} мм (дотук при това име — 1,2 мм)`);
    assert.ok(r.numInside, 'номерът под баркода е в етикета');
    assert.match(r.hint, /Името на библиотеката не се побира в етикет 40×30 мм/, 'невместимото име се казва в прегледа');
    assert.ok(r.bar2 >= 10.9, 'и тогава баркодът остава 11 мм');
    assert.deepEqual(r.spill, [false, false, false], 'УДК излиза извън сигнатурния етикет');
    assert.ok(r.band > 0.97, `лентата на картата в прегледа е ${(r.band * 100).toFixed(0)} % от картата (дотук 56 %)`);
  } finally { await browser.close(); }
});

/* Е6 — СМАЛЯВАНЕТО. Горният тест мери УДК, които се събират в 25×35 мм и само с
   пренасяне на части; тук етикетът е нисък (25×18), за да се види, че шрифтът
   наистина се смалява (--sfs < 1), докато всичко влезе, а сигнатура, която не
   влиза и с най-дребния шрифт, се казва в прегледа поименно. Печатът е като от
   „Етикети за сигнатура“ — с редовете ({ rows, card }), не с готов низ. */
test('Chromium Е6: дълга УДК в нисък етикет се смалява (--sfs), докато влезе; невместимата се казва', { skip: SKIP }, async () => {
  const st = Object.assign({}, FORMAT_DEFAULT, { sig_w: 25, sig_h: 18 });
  const { browser, page } = await chromiumPage(st);
  try {
    const r = await page.evaluate(async () => {
      const long = '821.111(73)-311.6.09+929Хемингуей,Ърнест1899-1961';
      await printLabelSheet({ rows: [{ udk: long, author_mark: 'Х 45', inv_number: 1 }], card: sigLblCard }, 'sig');
      const l = document.querySelector('#ppSheet .lbl-sig');
      const b = l.getBoundingClientRect();
      const out = {
        sfs: l.style.getPropertyValue('--sfs'),
        spill: Array.from(l.querySelectorAll('.ls-seg')).some(s => {
          const q = s.getBoundingClientRect(); return q.right > b.right + 0.5 || q.bottom > b.bottom + 0.5;
        }),
        hint1: document.getElementById('ppHint').textContent
      };
      ppClose();
      await printLabelSheet({ rows: [{ udk: long.repeat(5), author_mark: 'Х 45', inv_number: 2 }], card: sigLblCard }, 'sig');
      out.hint2 = document.getElementById('ppHint').textContent;
      ppClose();
      return out;
    });
    assert.ok(r.sfs !== '' && Number(r.sfs) < 1, 'шрифтът не е смален (--sfs = „' + r.sfs + '“)');
    assert.equal(r.spill, false, 'смалената УДК пак излиза от етикета');
    assert.doesNotMatch(r.hint1, /не се събира/, 'вместилата се не е невместима');
    assert.match(r.hint2, /1 сигнатура не се събира в етикета 25×18 мм дори с най-дребния шрифт/);
  } finally { await browser.close(); }
});

test('Chromium Е7 и Е9: пълен лист — една страница, ролка — без празен етикет; документът — „стр. N от M“', { skip: SKIP }, async () => {
  const st = Object.assign({}, FORMAT_DEFAULT, { org: 'НЧ „Проба“', place: 'с. Проба', lbl_w: 70, lbl_h: 37, lbl_mt: 0, lbl_ml: 0, lbl_gx: 0, lbl_gy: 0 });
  const { browser, page } = await chromiumPage(st);
  try {
    const rows = (n) => Array.from({ length: n }, (_, i) => ({ inv_number: 100 + i }));
    await page.evaluate((r) => printLabelSheet({ rows: r, card: lblCard }, 'fund'), rows(24));
    assert.equal(pdfPages(await pdfOf(page, tmpPdf('e7a'))), 1, '24 етикета 70×37 — една страница (дотук 2)');
    await page.evaluate(() => ppClose());
    await page.evaluate(() => { SETTINGS_CACHE.lbl_mode = 'roll'; SETTINGS_CACHE.lbl_w = 50; SETTINGS_CACHE.lbl_h = 25; });
    await page.evaluate((r) => printLabelSheet({ rows: r, card: lblCard }, 'fund'), rows(3));
    assert.equal(pdfPages(await pdfOf(page, tmpPdf('e7b'))), 3, '3 етикета на ролка — 3 страници (дотук 4)');
    await page.evaluate(() => ppClose());
    await page.evaluate(() => {
      setPrintPage({ name: 'Акт за отчисляване № 11-2026', landscape: false, margin: '14mm 12mm' });
      const rows = Array.from({ length: 90 }, (_, i) => `<tr><td>${i + 1}</td><td>Ред ${i + 1}</td></tr>`).join('');
      doPrint(`<div class="pdoc"><h2>АКТ</h2><table><tbody>${rows}</tbody></table>${ssig(['Председател: …', 'Член: …'])}</div>`);
    });
    const f = await pdfOf(page, tmpPdf('e9'));
    const pages = pdfWords(f).map(ws => ws.map(w => w.t).join(' '));
    assert.ok(pages.length >= 2);
    pages.forEach((t, i) => assert.match(t, new RegExp('стр\\. ' + (i + 1) + ' от ' + pages.length), 'лист ' + (i + 1)));
    assert.doesNotMatch(pages[0], /Акт за отчисляване № 11-2026/, 'на лист 1 заглавието е в документа');
    assert.match(pages[1], /Акт за отчисляване № 11-2026/, 'лист 2 казва на кой документ е');
    // Е5: последният лист с подписите носи и редове от таблицата.
    assert.match(pages[pages.length - 1], /Ред \d+[\s\S]*Председател/);
  } finally { await browser.close(); }
});
