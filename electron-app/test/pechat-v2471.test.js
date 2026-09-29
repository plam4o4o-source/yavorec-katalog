'use strict';
/* v2.4.71 — ПЕЧАТ (кръг 45, находки Р1–Р5; Р6 — наръчникът — е извън този файл).
 * =====================================================================
 * Два етажа, както в pechat-v2469:
 *   1. jsdom + истинските main.js/handlers (E.bootApp) — винаги: какво подава
 *      програмата на печата (опашката с подписите в реда на таблицата, ширината на
 *      лентите), какво пита (листовете при партиди) и какво казва (грешката при
 *      запис на PDF — на български и с изход).
 *   2. Chromium (същият печатен рендер като printToPDF на Electron) — когато на
 *      машината има playwright и Chromium: тихата зона на етикета за фонда в
 *      милиметри и модули, цели редове на малките етикети, отстъпът под .pdoc
 *      при печат. Без Chromium тези тестове се пропускат с обяснение.
 * Самата поредица от истински PDF-и за Р1 (акт 40–82 реда, дарение, протоколи,
 * КДБФ, инвентарна книга) е в pechat-v2471-podpisi.test.js — бавна, затова отделно.
 *
 * Всеки тест е проверен с връщане на поправката (вижте доклада на кръга).
 */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { APP_DIR, cleanupTmpDirs, fakeIpcMain } = require('./helpers/audit-fixtures');
const E = require('./helpers/e2e-app');
const registerPrintHandlers = require('../handlers/print');

const CSS = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
const cssNoComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const printBlock = (() => {
  const i = cssNoComments.indexOf('@media print{');
  let depth = 0, j = i + '@media print'.length;
  for (; j < cssNoComments.length; j++) {
    if (cssNoComments[j] === '{') depth++;
    else if (cssNoComments[j] === '}') { depth--; if (!depth) break; }
  }
  return cssNoComments.slice(i, j + 1);
})();

let h = null;
test.before(async () => { h = await E.bootApp(); await seedOnce(); });
test.after(() => { if (h) h.stop(); cleanupTmpDirs(); });

const W = () => h.window;
const D = () => h.document;
const sheet = () => D().getElementById('ppSheet');
async function settings(o) {
  const cols = Object.keys(o);
  h.db.prepare(`UPDATE settings SET ${cols.map(c => c + ' = @' + c).join(', ')} WHERE id = 1`).run(o);
  await W().loadSettingsCache();
}
function closePreview() { if (D().getElementById('printPreview').classList.contains('on')) W().ppClose(); }
function noRendererErrors() {
  const errs = h.errors.splice(0);
  assert.equal(errs.length, 0, 'грешки в екранния слой:\n' + errs.map(e => (e && (e.stack || e.message)) || String(e)).join('\n---\n'));
}
const FORMAT_DEFAULT = { lbl_mode: 'sheet', lbl_w: 40, lbl_h: 30, lbl_cols: 3, lbl_gap: 3, lbl_margin: 8,
  lbl_mt: 8, lbl_ml: 8, lbl_gx: 3, lbl_gy: 3, lbl_border: 1 };

/* 500 книги с инв. № 700001… (без дупки) — за акта и за партидите етикети. */
async function seedOnce() {
  const ins = h.db.prepare(`INSERT INTO books (inv_number, title, author, year, udk, register_date, status, price)
    VALUES (?, ?, 'Вазов, Иван', '1990', '821.163.2-31', '2026-09-20', 'наличен', 2.5)`);
  h.db.transaction(() => { for (let i = 0; i < 500; i++) ins.run(700001 + i, 'Книга № ' + i); })();
  await settings(Object.assign({}, FORMAT_DEFAULT, { org: 'НЧ „Проба – 1922“', place: 'с. Проба', director_role: 'Председател' }));
}

/* ==================================================================
   Р1 — опашката (бележка + подписи) е последният ред на таблицата
   ================================================================== */
test('Р1: актът — бележката и подписите са в ПОСЛЕДНИЯ РЕД на таблицата, една клетка през всички колони; и в прегледа, и в печата', async () => {
  const ids = h.db.prepare('SELECT id FROM books WHERE inv_number BETWEEN 700001 AND 700005 ORDER BY inv_number').all().map(r => r.id);
  const no = (await h.app.invoke('deaccessionActs:nextNo', '2026')).data;
  const r = await h.app.invoke('deaccessionActs:create', { act: { no, date: '2026-09-25', order_no: 'РД-45', reason_code: 1,
    reason_text: 'физически изхабени', disposal: 'за вторични суровини', committee1: 'Иванова, Мария',
    committee2: 'Петров, Петър', committee3: 'Георгиева, Елена' }, bookIds: ids });
  assert.ok(r.ok, r.error);
  await W().printActDoc(r.data); await h.settle();
  for (const root of ['preview', 'print']) {
    if (root === 'print') W().ppFillPrintArea();
    const el = root === 'print' ? D().getElementById('printArea') : sheet();
    const doc = el.querySelector('.pdoc');
    assert.equal(doc.querySelectorAll(':scope > .psig').length, 0, root + ': подписите вече не са съседни блокове на таблицата');
    const table = doc.querySelector(':scope > table');
    const rows = Array.from(table.tBodies[table.tBodies.length - 1].rows);
    const tail = rows[rows.length - 1];
    assert.ok(tail.classList.contains('ptailRow'), root + ': последният ред на таблицата е опашката');
    assert.match(rows[rows.length - 2].textContent, /ОБЩО 5 документа/, root + ': точно над опашката е сборът');
    const td = tail.cells[0];
    assert.equal(tail.cells.length, 1);
    assert.equal(td.colSpan, table.tHead.rows[0].cells.length, root + ': клетката е през всички колони');
    assert.equal(td.querySelectorAll('.psig').length, 2, root + ': комисията и „УТВЪРДИЛ“ — в опашката');
    assert.match(td.textContent, /Начин на разпореждане по чл\. 36[\s\S]*Комисия: 1\. Иванова, Мария[\s\S]*3\. Георгиева, Елена[\s\S]*УТВЪРДИЛ, Председател/);
  }
  D().getElementById('printArea').innerHTML = '';
  closePreview();
  // Правилата, които държат опашката с последните два реда на описа.
  assert.match(cssNoComments, /\.pdoc table tr\.ptailRow\{break-inside:avoid;[^}]*break-before:avoid/);
  assert.match(cssNoComments, /\.pdoc table tbody tr:has\(\+ tr\.ptailRow\), \.pdoc table tbody tr:has\(\+ tr \+ tr\.ptailRow\)\{break-before:avoid/);
  noRendererErrors();
});

test('Р1: документ без таблица над подписите — подписите и последната бележка са един неделим блок (.ptail)', async () => {
  const no = (await h.app.invoke('acquisitions:nextNo', '2026')).data;
  const r = await h.app.invoke('acquisitions:create', { no, date: '2026-09-10', how: 'дарение', from_source: 'Иванов, Георги',
    donor_address: 'с. Проба', doc_type: 'дарителски акт', doc_no: 'Д-1', doc_date: '2026-09-10', total_count: 3, total_value: 9 });
  assert.ok(r.ok, r.error);
  await W().printDonationDoc(r.data && (r.data.id || r.data)); await h.settle();
  const doc = sheet().querySelector('.pdoc');
  const tail = doc.lastElementChild;
  assert.ok(tail.classList.contains('ptail'), 'опашката е последното в документа');
  assert.equal(tail.querySelectorAll(':scope > .psig').length, 2);
  assert.match(tail.firstElementChild.textContent, /съставен в три екземпляра/, 'бележката над подписите е в същия блок');
  assert.ok(!tail.previousElementSibling.classList.contains('ptail'));
  assert.match(cssNoComments, /\.pdoc \.ptail\{break-inside:avoid/);
  closePreview();
});

test('Р1: при печат .pdoc няма отстъп в края — отстоянието между документите е новият лист', () => {
  assert.match(printBlock, /#printArea \.pdoc\{page-break-after:always; break-after:page; padding:0\}/);
  assert.doesNotMatch(printBlock, /#printArea \.pdoc\{[^}]*12mm/, 'отстъпът 12 мм в края избутваше опашката на нов лист');
});

/* ==================================================================
   Р2 — етикетът за фонда: модули × модул, поне 10 модула празно
   ================================================================== */
function fundBar(inv) {
  const html = W().lblCard({ inv_number: inv });
  const m = html.match(/<svg style="--bw:([\d.]+)mm"/);
  assert.ok(m, 'лентите имат изчислена ширина (--bw), не 100 % от етикета');
  return +m[1];
}
test('Р2: L7160 (63,5 мм), инв. № 1 — модул 0,5 мм и над 10 модула празно; 7 цифри при 40 мм — пак поне 10', async () => {
  await settings({ lbl_w: 63.5, lbl_h: 38.1, lbl_border: 1 });
  const units1 = W().code39Units('1');
  const bw1 = fundBar(1);
  const mod1 = bw1 / units1;
  assert.ok(mod1 <= 0.5 + 1e-9, 'модулът е до 0,5 мм (беше 1,31)');
  const quiet1 = (63.5 - 5 - 0.6 - bw1) / 2 / mod1;
  assert.ok(quiet1 >= 10, 'тихата зона е ' + quiet1.toFixed(1) + ' модула (беше 2)');
  await settings({ lbl_w: 40, lbl_h: 30 });
  const units7 = W().code39Units('1234567');
  const bw7 = fundBar(1234567);
  const mod7 = bw7 / units7;
  assert.ok((40 - 5 - 0.6 - bw7) / 2 / mod7 >= 10, 'и най-дългият обичаен номер има 10 модула празно');
  assert.match(cssNoComments, /\.lbl\.lbl-fund svg\{width:var\(--bw, 100%\)/);
  await settings(FORMAT_DEFAULT);
});

/* ==================================================================
   Р4 — грешката при запис на PDF: на български и с изход
   ================================================================== */
function printSetup(writeErr, pdfErr) {
  const ipcMain = fakeIpcMain();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pechat-v2471-'));
  registerPrintHandlers(ipcMain, {
    getMainWindow: () => ({ webContents: { printToPDF: async () => { if (pdfErr) throw pdfErr; return Buffer.from('%PDF'); } } }),
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, 'КДБФ 2026 г.pdf') }) },
    fs: Object.assign({}, fs, { writeFileSync: (...a) => { if (writeErr) throw writeErr; return fs.writeFileSync(...a); } }),
    path, app: { getPath: () => dir }, shell: { openPath: () => {} }, logAudit: () => {}
  });
  return { ipcMain, dir };
}
const nodeErr = (code, msg) => Object.assign(new Error(code + ': ' + msg), { code });
test('Р4: EBUSY, EPERM, EACCES, ENOENT — на български, с името на файла и с изход; никакъв суров английски', async () => {
  const cases = [
    ['EBUSY', 'resource busy or locked, open', /отворен в друга програма \(най-често Adobe Reader или браузърът\)\. Затворете го там и натиснете „Запази PDF…“ отново — или изберете друго име/],
    ['EPERM', 'operation not permitted, open', /Windows не разрешава запис — файл със същото име е отворен в друга програма[\s\S]*Затворете файла или изберете друго име или друга папка/],
    ['EACCES', 'permission denied, open', /нямате права в папката[\s\S]*друга папка/],
    ['ENOENT', 'no such file or directory, open', /папката „[^“]+“ не съществува[\s\S]*Изберете друга папка/],
  ];
  for (const [code, msg, re] of cases) {
    const { ipcMain, dir } = printSetup(nodeErr(code, msg));
    const res = await ipcMain.invoke('print:savePdf', { fileName: 'КДБФ 2026 г.' });
    res.error = String(res.error).split(dir).join('<папка>');
    assert.equal(res.ok, false);
    assert.match(res.error, /^PDF файлът „КДБФ 2026 г\.pdf“ не е записан: /, code);
    assert.match(res.error, re, code + ': ' + res.error);
    assert.doesNotMatch(res.error, /[A-Z]{4,}|no such file|permission|busy|locked/, code + ': суров текст на Node — ' + res.error);
  }
  // Непознатата грешка — пак с изречение пред нея и със същия изход.
  const { ipcMain: other } = printSetup(nodeErr('EIO', 'i/o error, write'));
  assert.match((await other.invoke('print:savePdf', { fileName: 'Акт' })).error, /не е записан: непозната грешка при запис \(EIO[\s\S]*Изберете друго име или друга папка/);
  // Самото превръщане в PDF се казва отделно — там папката не е виновна.
  const { ipcMain: pdf } = printSetup(null, new Error('Printing failed'));
  assert.match((await pdf.invoke('print:savePdf', { fileName: 'Акт' })).error, /^Документът не можа да се превърне в PDF \(Printing failed\)\. Нищо не е записано\./);
});

test('Р4: през екрана — „Запази PDF…“ в несъществуваща папка: известието е на български, прегледът остава отворен', async () => {
  const wc = h.app.windows[0].webContents;
  const had = wc.printToPDF;
  wc.printToPDF = async () => Buffer.from('%PDF-1.7');
  h.dialogs.savePath = path.join(os.tmpdir(), 'nyama-takava-papka-' + process.pid, 'x.pdf');
  try {
    W().setPrintPage({ name: 'Проба', landscape: false });
    W().doPrint('<div class="pdoc"><h2>ПРОБА</h2></div>');
    const before = h.toasts.length;
    await W().ppSavePdf(); await h.settle();
    const msg = (h.toastsSince(before).find(t => t.type === 'err') || {}).msg || '';
    assert.match(msg, /^PDF файлът „x\.pdf“ не е записан: папката „[^“]*nyama-takava-papka[^“]*“ не съществува/);
    assert.doesNotMatch(msg, /ENOENT|no such file/);
    assert.ok(D().getElementById('printPreview').classList.contains('on'), 'прегледът остава — може да се опита с друга папка');
  } finally {
    wc.printToPDF = had; h.dialogs.savePath = null; closePreview();
  }
});

/* ==================================================================
   Р5 — въпросът преди печат на партиди брои и празните позиции
   ================================================================== */
test('Р5: 400 етикета от позиция 20 на лист 3 × 8 — въпросът казва 18 листа (ceil((400 + 19) / 24)), не 17', async () => {
  await settings(FORMAT_DEFAULT);
  await h.go('labels');
  const asked = h.hooks.confirms.length;
  h.hooks.confirmAnswer = true;
  // 700101–700500: без отчислените в Р1 номера — иначе първо идва въпросът за липсващите.
  h.type('[name=lblFrom]', '700101'); h.type('[name=lblTo]', '700500');
  h.type('[name=lblStart]', '20');
  await W().printLabelsRange(); await h.settle();
  const q = h.hooks.confirms.slice(asked).find(x => /^ПЕЧАТ НА 400/.test(x));
  assert.ok(q, 'въпросът за партидите е зададен');
  assert.match(q, /Това са 18 листа A4 при сегашния формат \(24 на лист\), като първите 19 клетки на първия лист остават празни\./);
  // И листовете наистина са толкова: първата партида е 12 листа (288 клетки), втората — 6.
  assert.equal(sheet().querySelectorAll('.lblpage').length, 12);
  W().ppPrint();
  await h.waitFor(() => /партида 2 от 2/.test(h.text('#ppTitle')) && D().getElementById('printPreview').classList.contains('on'), 'втората партида', 3000);
  assert.equal(sheet().querySelectorAll('.lblpage').length, 6, '12 + 6 = 18 листа, колкото каза въпросът');
  closePreview();
  h.type('[name=lblStart]', '1');
  noRendererErrors();
});

/* ==================================================================
   Chromium — истинският рендер (пропуска се без Chromium)
   ================================================================== */
function findChromium() {
  let pw = null;
  for (const p of [process.env.PECHAT_PLAYWRIGHT, 'playwright', '/home/claude/.npm-global/lib/node_modules/playwright'].filter(Boolean)) {
    try { pw = require(p); break; } catch (e) { /* следващият възможен път */ }
  }
  const exe = [process.env.PECHAT_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean).find(p => fs.existsSync(p));
  return pw && exe ? { pw, exe } : null;
}
const CH = findChromium();
const SKIP = !CH ? 'няма playwright/Chromium на машината (PECHAT_CHROMIUM)' : false;

async function chromiumPage(settingsRow) {
  const browser = await CH.pw.chromium.launch({ executablePath: CH.exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.addInitScript((st) => {
    const data = { 'settings.get': st };
    const node = (parts) => new Proxy(function () {}, {
      get(t, p) { return p === 'then' || typeof p === 'symbol' ? undefined : node(parts.concat(p)); },
      apply() { const k = parts.join('.'); return Promise.resolve({ ok: true, data: k in data ? data[k] : [] }); }
    });
    window.api = node([]);
  }, settingsRow);
  await page.goto('file://' + path.join(APP_DIR, 'src', 'index.html'));
  await page.waitForFunction(() => typeof printLabelSheet === 'function' && SETTINGS_CACHE);
  return { browser, page };
}
const printFund = (page, invs) => page.evaluate((list) => printLabelSheet({ rows: list.map(n => ({ inv_number: n })), card: lblCard }, 'fund'), invs);

test('Chromium Р2: Avery L7160 — лентите ≤ 0,5 мм модул и поне 10 модула празно до ръба на етикета; фабричният 40×30 — също', { skip: SKIP }, async () => {
  const L7160 = { org: 'НЧ „Пример – 1922“', place: 'с. Пример', lbl_mode: 'sheet', lbl_cols: 3, lbl_mt: 15.1, lbl_ml: 7.2,
    lbl_gx: 2.5, lbl_gy: 0, lbl_w: 63.5, lbl_h: 38.1, lbl_border: 1 };
  for (const [st, invs] of [[L7160, [1, 22, 1000, 1234567]], [Object.assign({}, L7160, FORMAT_DEFAULT), [1, 1234567]]]) {
    const { browser, page } = await chromiumPage(st);
    try {
      await printFund(page, invs);
      const got = await page.evaluate(() => {
        const s = document.getElementById('ppSheet');
        s.style.zoom = 1;
        return Array.from(s.querySelectorAll('.lbl-fund')).map(l => {
          const r = l.getBoundingClientRect(), b = l.querySelector('svg').getBoundingClientRect();
          const pxmm = r.width / SETTINGS_CACHE.lbl_w;
          const code = l.querySelector('.l3').textContent;
          const mod = b.width / pxmm / code39Units(code);
          return { code, mod, qL: (b.left - r.left) / pxmm / mod, qR: (r.right - b.right) / pxmm / mod };
        });
      });
      assert.equal(got.length, invs.length);
      for (const g of got) {
        assert.ok(g.mod <= 0.5 + 0.01, `${st.lbl_w} мм, № ${g.code}: модул ${g.mod.toFixed(2)} мм (до 0,5)`);
        assert.ok(g.qL >= 10 && g.qR >= 10, `${st.lbl_w} мм, № ${g.code}: празно ${g.qL.toFixed(1)} / ${g.qR.toFixed(1)} модула (поне 10)`);
      }
    } finally { await browser.close(); }
  }
});

let hasDecoders = false;
try { execFileSync('python3', ['-c', 'import zxingcpp, pymupdf; from pyzbar import pyzbar'], { stdio: 'ignore' }); hasDecoders = true; } catch (e) { hasDecoders = false; }
test('Chromium Р2: целият лист L7160 в PDF при 300 dpi — двата декодера (zxing-cpp и zbar) четат всеки номер', { skip: SKIP || (!hasDecoders && 'няма python3 с zxingcpp, pyzbar и pymupdf') }, async () => {
  const { browser, page } = await chromiumPage({ org: 'НЧ „Пример – 1922“', place: 'с. Пример', lbl_mode: 'sheet', lbl_cols: 3,
    lbl_mt: 15.1, lbl_ml: 7.2, lbl_gx: 2.5, lbl_gy: 0, lbl_w: 63.5, lbl_h: 38.1, lbl_border: 1 });
  const file = path.join(os.tmpdir(), 'pechat-v2471-' + process.pid + '-l7160.pdf');
  try {
    const invs = Array.from({ length: 21 }, (_, i) => 1 + i * 47);
    await printFund(page, invs);
    await page.evaluate(() => ppFillPrintArea());
    await page.pdf({ path: file, printBackground: true, preferCSSPageSize: true });
    const out = JSON.parse(execFileSync('python3', ['-c', `
import sys, json, zxingcpp, pymupdf as fitz
from pyzbar import pyzbar
from PIL import Image
p = fitz.open(sys.argv[1])[0]; pix = p.get_pixmap(dpi=300, alpha=False)
img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
print(json.dumps({'zx': sorted(r.text for r in zxingcpp.read_barcodes(img)), 'zb': sorted(r.data.decode() for r in pyzbar.decode(img))}))`, file], { encoding: 'utf8' }));
    const want = invs.map(String).sort();
    assert.deepEqual(out.zx, want, 'zxing-cpp');
    assert.deepEqual(out.zb, want, 'zbar');
  } finally { await browser.close(); try { fs.rmSync(file, { force: true }); } catch (e) { /* временен файл */ } }
});

test('Chromium Р3: L7651 (38,1 × 21,2) — отпадат ЦЕЛИ редове и се казва кои; нищо не е разрязано', { skip: SKIP }, async () => {
  const { browser, page } = await chromiumPage({ org: 'НЧ „Васил Левски – 1922“', place: 'с. Яворец', lbl_mode: 'sheet', lbl_cols: 5,
    lbl_mt: 10.7, lbl_ml: 4.75, lbl_gx: 2.5, lbl_gy: 0, lbl_w: 38.1, lbl_h: 21.2, lbl_border: 1 });
  try {
    await printFund(page, [1, 2, 1234567]);
    const r = await page.evaluate(() => ({
      hint: document.getElementById('ppHint').textContent,
      labels: Array.from(document.querySelectorAll('#ppSheet .lbl-fund')).map(l => {
        const head = l.querySelector('.lhead');
        const shown = head && getComputedStyle(head).display !== 'none'
          ? Array.from(head.children).filter(c => getComputedStyle(c).display !== 'none').map(c => c.textContent) : [];
        return { shown, headCut: !!(head && getComputedStyle(head).display !== 'none' && head.scrollHeight > head.clientHeight + 1),
          boxCut: l.scrollHeight > l.clientHeight + 1 };
      })
    }));
    assert.match(r.hint, /Етикетът 38,1 × 21,2 мм е нисък за цялата заглавна част: отпадат редовете „Библиотека при“ и „с\. Яворец“ — името, баркодът и номерът остават цели\./);
    assert.match(r.hint, /Актовете, КДБФ и другите документи не се променят/, 'изходът не е „съкратете Организация“');
    for (const l of r.labels) {
      assert.deepEqual(l.shown, ['НЧ „Васил Левски – 1922“'], 'остава само името — цял ред');
      assert.equal(l.headCut, false, 'заглавието не е разрязано по средата на реда');
      assert.equal(l.boxCut, false, 'нищо не излиза от етикета');
    }
  } finally { await browser.close(); }
});

test('Chromium Р3: L7656 (46 × 11,1) — баркодът и номерът не се събират и програмата го казва, с нужната височина', { skip: SKIP }, async () => {
  const { browser, page } = await chromiumPage({ org: 'НЧ „Васил Левски – 1922“', place: 'с. Яворец', lbl_mode: 'sheet', lbl_cols: 4,
    lbl_mt: 10.7, lbl_ml: 9.75, lbl_gx: 2.5, lbl_gy: 0, lbl_w: 46, lbl_h: 11.1, lbl_border: 1 });
  try {
    await printFund(page, [1, 2]);
    const hint = await page.evaluate(() => document.getElementById('ppHint').textContent);
    assert.match(hint, /В етикет 46 × 11,1 мм не се събират дори баркодът и номерът под него — номерът ще излезе отрязан \(нужни са поне \d+(,5)? мм височина\), а заглавната част е махната\./);
    assert.doesNotMatch(hint, /не са засегнати/, 'дотук прегледът твърдеше, че баркодът и номерът не са засегнати');
    const heads = await page.evaluate(() => Array.from(document.querySelectorAll('#ppSheet .lbl-fund .lhead')).map(x => getComputedStyle(x).display));
    assert.ok(heads.every(d => d === 'none'), 'без заглавна част, щом и номерът не влиза');
  } finally { await browser.close(); }
});

test('Chromium Р1: при печат последният ред на таблицата (опашката) не мести колоните на описа', { skip: SKIP }, async () => {
  const { browser, page } = await chromiumPage({ org: 'НЧ „Проба“', director_role: 'Председател' });
  try {
    /* КДБФ Част № 1 (пейзаж, кратки клетки) — точно там Chromium иначе разпределя
       ширината на дългата бележка по колоните: без правилото „ширина 0 за
       сметката“ колоните излизат 107/38/184… вместо 89/31/212… */
    const widths = await page.evaluate(() => {
      const rows = Array.from({ length: 3 }, (_, i) => `<tr><td>0${i + 1}.02.2026</td><td>${i + 1}</td><td>Книжарница „Хеликон“ / закупуване</td><td>фактура № Ф-${i}</td><td>1</td><td>1</td><td>10.00 € / 19.56 лв.</td><td>${100 + i}–${100 + i}</td><td>книги — 1</td></tr>`).join('');
      const html = `<div class="pdoc"><h2>КДБФ</h2><table><thead><tr><th>Дата</th><th>№</th><th>Откъде и как</th><th>Вид, № и дата на документа</th><th>Общо</th><th>Инвентирани</th><th>Стойност</th><th>Инв. № от – до</th><th>По вид документи</th></tr></thead><tbody>${rows}
        <tr style="font-weight:700"><td colspan="4">ОБЩО за 2026 г.</td><td>3</td><td>3</td><td>30.00 € / 58.67 лв.</td><td></td><td></td></tr></tbody></table>
        <div class="pmeta">${'Съгласуване на Част № 1 с Част № 2: постъпилите през годината по регистъра са равни на постъпилите по инвентарната книга. '.repeat(3)}</div>
        ${ssig(['Библиотекар: …………………', 'Счетоводител: …………………', 'Председател: …………………'])}</div>`;
      document.getElementById('printPreview').classList.add('on');
      const meas = (keep) => {
        const s = document.getElementById('ppSheet');
        s.style.width = '297mm'; s.style.padding = '10mm'; s.style.zoom = 1;
        s.innerHTML = html; if (keep) ppKeepTails(s);
        const w = Array.from(s.querySelector('thead tr').cells).map(c => Math.round(c.getBoundingClientRect().width));
        s.innerHTML = '';
        return w;
      };
      return { plain: meas(false), kept: meas(true) };
    });
    assert.deepEqual(widths.kept, widths.plain, 'ширините на колоните са същите като без опашката');
  } finally { await browser.close(); }
});
