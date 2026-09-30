'use strict';
/* v2.4.71 — ПОДПИСИТЕ НИКОГА НЕ ОСТАВАТ САМИ НА ЛИСТ (кръг 45, находка Р1;
 * регресия на Е5 от кръг 44). БАВЕН ТЕСТ — отделен файл нарочно.
 * =====================================================================
 * Тестът pechat-v2469 гледаше класовете в CSS, а не истинския PDF — и Е5 се
 * върна жив: актът за отчисляване при 44 реда имаше лист 3 само с „УТВЪРДИЛ“, при
 * 47 — комисията на два листа; актът за дарение (48–56 реда), протоколът по
 * чл. 3, ал. 2 (48–54), КДБФ (6–8 и 21–25 партиди) и инвентарната книга (21–24 и
 * 36 вписвания) — също. Затова тук се прави ИСТИНСКИ PDF в Chromium (същият
 * печатен рендер като printToPDF на Electron) през истинската програма и
 * истинските обработчици, за ПОРЕДИЦА от размери, и по текста на всеки лист се
 * проверява онова, което вижда проверяващият:
 *   • нито един лист не започва (под колонтитула) с ред за подпис;
 *   • листът с подписите носи и последните редове на описа (реда ОБЩО /
 *     последното вписване) — подписът заверява нещо на същия лист;
 *   • тримата членове на комисията и „УТВЪРДИЛ“ са на ЕДИН лист.
 * PDF-ът минава през „Запази PDF…“ на програмата (ppSavePdf → window.api.print.
 * savePdf), свързан с page.pdf() — тоест през същото пълнене на #printArea.
 *
 * Трае 1–3 минути на натоварена машина (десетки PDF-а), затова е отделно от
 * pechat-v2471.test.js. Без Chromium/playwright или pdftotext се пропуска с
 * обяснение (PECHAT_CHROMIUM, PECHAT_PLAYWRIGHT).
 */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startMainApp } = require('./helpers/main-app');
const E = require('./helpers/e2e-app');

const APP_DIR = path.join(__dirname, '..');

function findChromium() {
  let pw = null;
  for (const p of [process.env.PECHAT_PLAYWRIGHT, 'playwright', '/home/claude/.npm-global/lib/node_modules/playwright'].filter(Boolean)) {
    try { pw = require(p); break; } catch (e) { /* следващият възможен път */ }
  }
  const exe = [process.env.PECHAT_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean).find(p => fs.existsSync(p));
  return pw && exe ? { pw, exe } : null;
}
const CH = findChromium();
let hasPdftotext = false;
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); hasPdftotext = true; } catch (e) { hasPdftotext = false; }
const SKIP = !CH ? 'няма playwright/Chromium на машината (PECHAT_CHROMIUM)' : (!hasPdftotext ? 'няма pdftotext (poppler)' : false);

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pechat-v2471-podpisi-'));
const Y = String(new Date().getFullYear());

/* Редове за подпис — същото правило като sami.py на тестера. */
const SIG = /^(Комисия: 1\.|[23]\. |УТВЪРДИЛ|Дарител: …|Библиотекар:|Счетоводител:|Получил:|Съставил:|Летописец:|Подпис)/;

/* Текстът на всеки лист, ред по ред (pdftotext -layout), без колонтитулите:
   „стр. N от M“ и името на документа горе вдясно (от лист 2 нататък). */
function pdfPages(file, docName) {
  const txt = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  return txt.split('\f').filter(p => p.trim()).map(p => p.split('\n').map(l => l.trim())
    .filter(l => l && !/^стр\. \d+ от \d+$/.test(l) && l !== docName));
}

/* Проверката на един PDF. rowRe — ред от описа (последните редове/сборът), който
   трябва да стои на листа с подписите. */
function checkSigs(file, docName, rowRe, label) {
  const pages = pdfPages(file, docName);
  const bad = [];
  pages.forEach((lines, i) => {
    if (i > 0 && lines.length && SIG.test(lines[0])) bad.push(`${label}: лист ${i + 1} от ${pages.length} започва с „${lines[0].slice(0, 50)}“`);
  });
  const sigPages = pages.map((lines, i) => (lines.some(l => SIG.test(l)) ? i : -1)).filter(i => i >= 0);
  for (const i of sigPages) {
    if (!pages[i].some(l => rowRe.test(l))) bad.push(`${label}: на лист ${i + 1} от ${pages.length} има подписи, но нито ред от описа`);
  }
  const at = (re) => pages.findIndex(lines => lines.some(l => re.test(l)));
  const c1 = at(/^Комисия: 1\./);
  if (c1 >= 0) {
    const c3 = pages.findIndex(lines => lines.some(l => /(^|\s)3\. /.test(l) && !/^Комисия/.test(l)) && lines.some(l => /УТВЪРДИЛ/.test(l)));
    const u = at(/УТВЪРДИЛ/);
    if (c3 !== c1 || u !== c1) bad.push(`${label}: комисията е разделена — „Комисия: 1.“ на лист ${c1 + 1}, „3.“ и „УТВЪРДИЛ“ на лист ${u + 1}`);
  }
  return { bad, pages: pages.length };
}

let app = null, Database = null, db = null, browser = null, page = null;
const pdfs = [];

const AUTHORS = ['Вазов, Иван', 'Елин Пелин', 'Йовков, Йордан', 'Радичков, Йордан', 'Кристи, Агата', 'Хайтов, Николай',
  'Талев, Димитър', 'Славейков, Пенчо', 'Димитрова, Блага', 'Толстой, Лев', 'Ботев, Христо', 'Кинг, Стивън'];
const TITLES = ['Под игото', 'Гераците', 'Старопланински легенди', 'Вечери в Антимовския хан', 'Диви разкази',
  'Железният светилник', 'Кървава песен', 'Избрани съчинения', 'Война и мир', 'Сияние',
  'Разкази за животните и хората от Пирин планина', 'Неосветените дворове', 'Тютюн', 'Време разделно'];
const UDK = ['821.163.2-31', '821.163.2-32', '94(497.2)', '087.5', '820-31', '821.161.1-31', '5', '61'];

test.before(async () => {
  if (SKIP) return;
  app = startMainApp();
  await app.ready();
  Database = require(path.join(APP_DIR, 'node_modules', 'better-sqlite3'));
  db = new Database(path.join(app.userData, 'library.db'));
  db.prepare(`UPDATE settings SET org = 'Народно читалище „Проба – 1922“', lib_name = 'Библиотека', place = 'с. Проба',
    director_role = 'Председател', librarian = 'Петрова, Дора', committee1 = 'Иванова, Мария',
    committee2 = 'Петров, Петър', committee3 = 'Георгиева, Елена' WHERE id = 1`).run();
  const ins = db.prepare(`INSERT INTO books (inv_number, title, author, year, udk, register_date, status, price)
    VALUES (?, ?, ?, ?, ?, ?, 'наличен', ?)`);
  db.transaction(() => {
    for (let i = 1; i <= 2000; i++) {
      ins.run(i, TITLES[(i * 7) % TITLES.length] + (i % 9 === 0 ? ', т. ' + (1 + i % 4) : ''), AUTHORS[(i * 5) % AUTHORS.length],
        String(1950 + (i * 3) % 75), UDK[i % UDK.length], Y + '-01-02', Math.round((1 + (i * 37) % 2800) ) / 100);
    }
  })();

  browser = await CH.pw.chromium.launch({ executablePath: CH.exe, args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-dev-shm-usage'] });
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.exposeBinding('__ipc', async (_src, channel, args) => {
    let res;
    try { res = await app.invoke(channel, ...(args || [])); } catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
    return res === undefined ? null : JSON.parse(JSON.stringify(res, (k, v) => (v && v.type === 'Buffer' ? null : v)));
  });
  /* „Запази PDF…“ → page.pdf() със СЪЩИТЕ опции, които handlers/print.js подава на
     webContents.printToPDF (printBackground, preferCSSPageSize). */
  let target = null;
  await page.exposeBinding('__savePdf', async () => {
    const file = path.join(OUT, (target || 'doc') + '.pdf');
    await page.pdf({ path: file, printBackground: true, preferCSSPageSize: true });
    pdfs.push(file);
    return { ok: true, data: { path: file } };
  });
  page.setTarget = (t) => { target = t; };
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
    api.print.savePdf = (o) => window.__savePdf(o);
    window.api = api;
  }, E.preloadTable());
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto('file://' + path.join(APP_DIR, 'src', 'index.html'));
  await page.waitForFunction(() => typeof printActDoc === 'function' && typeof SETTINGS_CACHE !== 'undefined' && SETTINGS_CACHE);
});
test.after(async () => {
  if (browser) await browser.close();
  if (db) db.close();
  if (app) app.stop();
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* временната папка — нищо не зависи от нея */ }
});

/* Отваря прегледа с печатната функция, натиска „Запази PDF…“ и връща файла и
   името на документа (то е колонтитулът от лист 2 нататък). */
async function savePdf(name, printFn, arg) {
  page.setTarget(name);
  const before = pdfs.length;
  await page.evaluate(([fn, a]) => window[fn](a), [printFn, arg]);
  await page.waitForFunction(() => document.getElementById('printPreview').classList.contains('on'), null, { timeout: 60000 });
  const docName = await page.evaluate(() => String(PRINT_DOC_NAME || '').slice(0, 110));
  await page.evaluate(() => ppSavePdf());
  await page.waitForFunction(() => !document.getElementById('printPreview').classList.contains('on'), null, { timeout: 120000 });
  assert.equal(pdfs.length, before + 1, name + ': PDF не е записан');
  return { file: pdfs[pdfs.length - 1], docName };
}

let nextBook = 1;
const takeBooks = (n) => { const ids = db.prepare('SELECT id FROM books WHERE inv_number >= ? ORDER BY inv_number LIMIT ?').all(nextBook, n).map(r => r.id); nextBook += n; return ids; };
const COMMITTEE = { committee1: 'Иванова, Мария', committee2: 'Петров, Петър', committee3: 'Георгиева, Елена' };

test('Р1: актът за отчисляване — 40–50 и 72–82 реда: подписите не са сами, комисията е на един лист', { skip: SKIP }, async () => {
  const bad = [];
  for (const n of [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82]) {
    const no = (await app.invoke('deaccessionActs:nextNo', Y)).data;
    const r = await app.invoke('deaccessionActs:create', { act: Object.assign({ no, date: Y + '-01-20', order_no: 'РД-45', reason_code: 1,
      reason_text: 'физически изхабени', disposal: 'за вторични суровини' }, COMMITTEE), bookIds: takeBooks(n) });
    assert.ok(r.ok, 'актът не е създаден: ' + r.error);
    const { file, docName } = await savePdf('akt-' + n, 'printActDoc', r.data);
    bad.push(...checkSigs(file, docName, /^ОБЩО /, 'акт с ' + n + ' реда').bad);
  }
  assert.deepEqual(bad, []);
});

async function acquisition(how, extra) {
  const no = (await app.invoke('acquisitions:nextNo', Y)).data;
  const r = await app.invoke('acquisitions:create', Object.assign({ no, date: Y + '-01-10', how, from_source: 'Иванов, Георги',
    donor_address: 'с. Проба, ул. „Първа“ 1', doc_type: 'дарителски акт', doc_no: 'Д-1', doc_date: Y + '-01-10',
    total_count: 60, total_value: 300 }, COMMITTEE, extra || {}));
  assert.ok(r.ok, 'партидата не е създадена: ' + r.error);
  return r.data && (r.data.id || r.data);
}

test('Р1: актът за дарение 44–58 реда и протоколът по чл. 3, ал. 2 при 46–56 реда', { skip: SKIP }, async () => {
  const bad = [];
  const don = await acquisition('дарение');
  const pool = takeBooks(60);
  for (const n of [44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58]) {
    db.prepare(`UPDATE books SET acquisition_id = NULL WHERE id IN (${pool.join(',')})`).run();
    db.prepare(`UPDATE books SET acquisition_id = ? WHERE id IN (${pool.slice(0, n).join(',')})`).run(don);
    const { file, docName } = await savePdf('darenie-' + n, 'printDonationDoc', don);
    bad.push(...checkSigs(file, docName, /^ОБЩО /, 'дарение с ' + n + ' реда').bad);
  }
  const prot = await acquisition('закупуване', { doc_type: 'без документ — протокол на комисия', doc_no: '', doc_date: '' });
  for (const n of [46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]) {
    db.prepare(`UPDATE books SET acquisition_id = NULL WHERE id IN (${pool.join(',')})`).run();
    db.prepare(`UPDATE books SET acquisition_id = ? WHERE id IN (${pool.slice(0, n).join(',')})`).run(prot);
    const { file, docName } = await savePdf('protokol-pr-' + n, 'printAcqNoDocDoc', prot);
    bad.push(...checkSigs(file, docName, /^ОБЩО /, 'протокол по чл. 3, ал. 2 с ' + n + ' реда').bad);
  }
  db.prepare(`UPDATE books SET acquisition_id = NULL WHERE id IN (${pool.join(',')})`).run();
  assert.deepEqual(bad, []);
});

test('Р1: протоколът от инвентаризация — 20–60 липсващи', { skip: SKIP }, async () => {
  const bad = [];
  const pool = db.prepare('SELECT id, inv_number, title, author, price FROM books WHERE inv_number >= ? ORDER BY inv_number LIMIT 60').all(nextBook);
  nextBook += 60;
  let k = 0;
  for (const n of [20, 26, 30, 34, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 60]) {
    const sid = db.prepare(`INSERT INTO inventory_sessions (date, scope, committee1, committee2, committee3, pool_size, closed, mode,
      no, year, order_no, pool_final, on_loan, at_binder, scanned_final, free_access_pct)
      VALUES (?, 'целият фонд', ?, ?, ?, 4000, 1, 'full', ?, ?, 'РД-7', 4000, 0, 0, ?, 100)`)
      .run(Y + '-02-01', COMMITTEE.committee1, COMMITTEE.committee2, COMMITTEE.committee3, ++k, Y, 4000 - n).lastInsertRowid;
    const insM = db.prepare('INSERT INTO inventory_session_missing (session_id, book_id, inv_number, title, author, price, quantity) VALUES (?, ?, ?, ?, ?, ?, 1)');
    for (const b of pool.slice(0, n)) insM.run(sid, b.id, b.inv_number, b.title, b.author, b.price);
    const { file, docName } = await savePdf('protokol-inv-' + n, 'printInventProtocol', Number(sid));
    bad.push(...checkSigs(file, docName, /^ОБЩО /, 'протокол от инвентаризация с ' + n + ' липсващи').bad);
  }
  assert.deepEqual(bad, []);
});

test('Р1: КДБФ — Част № 1 с 5–9 и 20–26 партиди; и трите части', { skip: SKIP }, async () => {
  const bad = [];
  let have = db.prepare('SELECT COUNT(*) n FROM acquisitions WHERE year = ?').get(Y).n;
  for (const n of [5, 6, 7, 8, 9, 20, 21, 22, 23, 24, 25, 26]) {
    while (have < n) {
      const no = (await app.invoke('acquisitions:nextNo', Y)).data;
      const r = await app.invoke('acquisitions:create', { no, date: Y + '-01-' + String(1 + have % 28).padStart(2, '0'), how: 'закупуване',
        from_source: 'Книжарница „Хеликон“', doc_type: 'фактура', doc_no: 'Ф-' + have, doc_date: Y + '-01-01', total_count: 1, total_value: 10 });
      assert.ok(r.ok, r.error);
      have++;
    }
    await page.evaluate(async (y) => {
      const r = await call(window.api.kdbf.report(y));
      await kdbfLoadByKind(r.part1);
      window._KDBF_REPORT = r;
    }, Y);
    const { file, docName } = await savePdf('kdbf-' + n, 'printKdbfDoc');
    // Всяка част има своя ред ОБЩО (Част № 2 — „Наличност към 31.12.“).
    bad.push(...checkSigs(file, docName, /^(ОБЩО|Наличност към 31\.12\.)/, 'КДБФ с ' + n + ' партиди').bad);
  }
  assert.deepEqual(bad, []);
});

test('Р1: инвентарната книга — 18–40 вписвания', { skip: SKIP }, async () => {
  const bad = [];
  await page.evaluate(() => { location.hash = '#invbook'; });
  await page.waitForFunction(() => Array.isArray(window._INVBOOK_ROWS) || INVBOOK_WINDOWED, null, { timeout: 60000 });
  const first = nextBook;
  for (const n of [18, 20, 21, 22, 23, 24, 25, 28, 32, 34, 35, 36, 37, 38, 40]) {
    const { file, docName } = await savePdf('inv-' + n, 'printInvBookDoc', { from: first, to: first + n - 1 });
    bad.push(...checkSigs(file, docName, /^\d\d\.\d\d\.\d{4}\s+\d+\s/, 'инвентарна книга с ' + n + ' вписвания').bad);
  }
  assert.deepEqual(bad, []);
});
