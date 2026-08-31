'use strict';
/* Одит v2.4.17 — седми кръг: ДОКУМЕНТИТЕ, които програмата издава.

   Предметът тук е различен от предишните кръгове: не какво прави програмата, а
   какво пише на листа, който излиза от нея — подписан от комисия, приложен към
   счетоводството, връчен на гражданин или подаден нагоре като официално число.
   Затова почти всяка находка е от рода „документът твърди нещо, което не е вярно“
   или „документът мълчи за нещо, без което числото в него е неразбираемо“.

   Всеки тест е проверен с мутация: production кодът се разваля в отделно копие и
   се проверява, че тестът става червен.  */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(APP_DIR, 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');
const tmpDirs = [];
function mkTmpDir(p) { const d = fs.mkdtempSync(p); tmpDirs.push(d); return d; }
test.after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* няма значение */ } }
});
function fakeIpcMain() {
  const h = new Map();
  return { handle: (c, fn) => h.set(c, fn), invoke: (c, ...a) => h.get(c)({}, ...a), has: (c) => h.has(c) };
}
function freshDb(prefix) {
  const dir = mkTmpDir(path.join(os.tmpdir(), prefix));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  return { db, dir };
}
const runDep = (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } };

/* ---------------- jsdom харнес (същият модел като в v2414-print/v2416) ------- */
function scriptOrder() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}
function apiMock(overrides, calls) {
  function node(parts) {
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return node(parts.concat(prop));
      },
      apply(t, self, args) {
        const key = parts.join('.');
        if (calls) (calls[key] = calls[key] || []).push(args[0]);
        const has = Object.prototype.hasOwnProperty.call(overrides, key);
        const v = has ? overrides[key] : null;
        const out = typeof v === 'function' ? v(args) : v;
        if (out && out.__fail) return Promise.resolve({ ok: false, error: out.__fail });
        return Promise.resolve({ ok: true, data: out });
      }
    });
  }
  return node([]);
}
function buildDom(overrides) {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  dom.calls = {};
  dom.toasts = [];
  dom.confirmAnswer = true;
  window.api = apiMock(overrides || {}, dom.calls);
  window.confirm = () => dom.confirmAnswer;
  window.alert = () => {};
  window.print = () => {};
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const run = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  run(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  for (const f of scriptOrder()) run(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'), `views/${f}`);
  if (errors.length) assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n---\n'));
  const realToast = window.toast;
  window.toast = (msg, type) => { dom.toasts.push([String(msg), type]); return realToast && realToast(msg, type); };
  return dom;
}
const settle = () => new Promise(r => setTimeout(r, 40));
const printed = (w) => w.document.querySelector('#ppSheet').textContent.replace(/\s+/g, ' ');
const printedHtml = (w) => w.document.querySelector('#ppSheet').innerHTML;

/* ==================================================================
   1. АКТОВЕ И ПРОТОКОЛИ ПО НАРЕДБА № 3
   ================================================================== */

test('актът за дарение не назовава комисията от последното отчисляване', async () => {
  /* Актовете за отчисляване ПРЕЗАПИСВАТ settings.committee1..3 при всяко
     утвърждаване (handlers/deaccession-acts.js). Актът за дарение четеше живите
     настройки, тоест препечатан акт от януари назоваваше комисията от март —
     трима души, които никога не са виждали това дарение, застават под него. */
  const acq = {
    id: 3, no: 2, year: '2026', date: '2026-01-15', how: 'дарение', from_source: 'Дарител',
    donor_address: 'гр. Х', total_count: 2, sum: 20,
    committee1: 'Иванова', committee2: 'Петров', committee3: 'Георгиев',
    items: [{ inv_number: 11, title: 'Първа', price: 10, fund_qty: 1 },
      { inv_number: 12, title: 'Втора', price: 10, fund_qty: 1 }]
  };
  const dom = buildDom({ 'acquisitions.get': acq, 'settings.get': {} });
  const { window } = dom;
  await settle();
  // Настройките КЪМ МОМЕНТА НА ПЕЧАТА са вече на друга комисия.
  /* SETTINGS_CACHE е `let` в core.js — лексикална глобална, НЕ свойство на window;
     присвояване през window.SETTINGS_CACHE не стига до кода и тестът би бил сляп. */
  window.eval("SETTINGS_CACHE = { committee1: 'Днешен', committee2: 'Друг', committee3: 'Трети' }");
  await window.printDonationDoc(3);
  await settle();
  const t = printed(window);
  assert.match(t, /Иванова, Петров, Георгиев/, 'печата се снимката от завеждането');
  assert.ok(!/Днешен/.test(t), 'живите настройки нямат работа в подписан документ отпреди месеци');
});

test('стара партида без записана комисия печата празни редове, не чужди имена', async () => {
  const acq = {
    id: 4, no: 1, year: '2019', date: '2019-05-05', how: 'дарение', from_source: 'Д', total_count: 1,
    committee1: null, committee2: null, committee3: null,
    items: [{ inv_number: 1, title: 'Т', price: 1, fund_qty: 1 }]
  };
  const dom = buildDom({ 'acquisitions.get': acq, 'settings.get': {} });
  const { window } = dom;
  await settle();
  /* SETTINGS_CACHE е `let` в core.js — лексикална глобална, НЕ свойство на window;
     присвояване през window.SETTINGS_CACHE не стига до кода и тестът би бил сляп. */
  window.eval("SETTINGS_CACHE = { committee1: 'Днешен', committee2: 'Друг', committee3: 'Трети' }");
  await window.printDonationDoc(4);
  await settle();
  const t = printed(window);
  assert.ok(!/Днешен|Друг|Трети/.test(t), 'по-добре празно, отколкото чуждо име под чужд документ');
  assert.match(t, /комисия в състав …………………/, 'мястото за имената остава празно');
  assert.match(t, /Комисия: 1\. ………… 2\. ………… 3\. …………/, 'и редът за подпис също');
});

test('обявеният брой, който не съвпада с описа, се казва в самия акт', async () => {
  /* Заглавието на акта твърди „Общ брой документи: 50“, а таблицата под него
     изброява 3. Актът отива в счетоводството подписан. */
  const acq = {
    id: 5, no: 3, year: '2026', date: '2026-03-01', how: 'дарение', from_source: 'Д',
    total_count: 50, sum: 500, committee1: 'К',
    items: [{ inv_number: 1, title: 'А', price: 10, fund_qty: 1 },
      { inv_number: 2, title: 'Б', price: 10, fund_qty: 2 }]
  };
  const dom = buildDom({ 'acquisitions.get': acq, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printDonationDoc(5);
  await settle();
  const t = printed(window);
  assert.match(t, /обявеният общ брой \(50\)/i, 'разминаването трябва да е изписано');
  assert.match(t, /изброените[^.]*документи \(3\)/i, 'и с двете числа');
  assert.match(t, /Останалите 47/, 'и с разликата, за да не се смята на ръка');
});

test('акт без нито един инвентиран документ казва, че не удостоверява опис', async () => {
  const acq = { id: 6, no: 4, year: '2026', date: '2026-03-02', how: 'дарение', from_source: 'Д',
    total_count: 12, items: [] };
  const dom = buildDom({ 'acquisitions.get': acq, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printDonationDoc(6);
  await settle();
  assert.match(printed(window), /няма нито един инвентиран документ/i);
});

test('непопълнена стойност по документа не се представя за обявена', async () => {
  /* `a.sum || acqValue(items)` печаташе ИЗЧИСЛЕНИЯ сбор под надписа „Обща
     стойност по документа“. Схемата вече пази NULL за непопълнено (миграция 11) и
     разпечатката казва откъде идва числото. */
  const items = [{ inv_number: 1, title: 'А', price: 7.5, fund_qty: 2 }];
  const dom = buildDom({ 'acquisitions.get': { id: 7, no: 5, year: '2026', date: '2026-03-03',
    how: 'дарение', from_source: 'Д', total_count: 2, sum: null, items }, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printDonationDoc(7);
  await settle();
  const t = printed(window);
  assert.match(t, /документът не обявява стойност/, 'документът трябва да каже, че числото е изчислено');
  assert.match(t, /15\.00/, 'и да покаже сбора 2 × 7.50');
});

test('изрично обявена нула се печата като нула, а не се заменя със сбора', async () => {
  const items = [{ inv_number: 1, title: 'А', price: 7.5, fund_qty: 2 }];
  const dom = buildDom({ 'acquisitions.get': { id: 8, no: 6, year: '2026', date: '2026-03-04',
    how: 'дарение', from_source: 'Д', total_count: 2, sum: 0, items }, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printDonationDoc(8);
  await settle();
  const t = printed(window);
  assert.match(t, /Обща стойност по документа:\s*0\.00/,
    'нулата е стойност, не липса на стойност');
  assert.match(t, /се различава от/, 'и разминаването със сбора се обявява');
});

test('актът за отчисляване има колона за бройка и редът ОБЩО се сумира от нея', async () => {
  /* Редът ОБЩО е Σ(цена × бройка), а колоната печаташе гола единична цена: в
     заместващ първичен счетоводен документ това е вътрешно противоречие. */
  const act = {
    id: 2, no: 1, year: '2026', date: '2026-02-02', reason_code: 3, reason_text: 'изхабени',
    disposal: 'унищожени', committee1: 'А', committee2: 'Б', committee3: 'В',
    items: [{ inv_number: 1, title: 'Първа', price: 10, quantity: 3 },
      { inv_number: 2, title: 'Втора', price: 5, quantity: 2 }]
  };
  const dom = buildDom({ 'deaccessionActs.get': act, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printActDoc(2);
  await settle();
  const html = printedHtml(window);
  assert.match(html, /<th>Бр\.<\/th>/, 'колоната за бройка липсваше изцяло');
  const t = printed(window);
  // 3 × 10 + 2 × 5 = 40, и бройката 5 стои на реда ОБЩО.
  assert.match(t, /ОБЩО\s*5\s*40\.00/, 'редът ОБЩО трябва да се сумира от собствените си колони');
});

/* ==================================================================
   2. МЗС — чужда заявка на наша бланка
   ================================================================== */

test('входящата заявка не се печата като наша', async () => {
  /* Входящата заявка е отправена КЪМ нас. Дотук се печаташе на нашата бланка, под
     заглавие „ЗАЯВКА ЗА МЗС“ и с реда за подпис „Библиотекар / Ръководител“ —
     тоест библиотеката подписваше като своя чуждата заявка. */
  const dom = buildDom({ 'mzs.list': [{ id: 1, no: 4, year: '2026', date: '2026-04-04',
    direction: 'входящо', partner: 'РБ Пловдив', title: 'Книга', status: 'изпратено' }] });
  const { window } = dom;
  await settle();
  window.eval("SETTINGS_CACHE = { org: 'НЧ Тест', librarian: 'Библиотекар' }");
  window.location.hash = '#mzs';
  await window.route();
  await settle();
  window.printMzsDoc(1);
  await settle();
  const t = printed(window);
  assert.match(t, /ВХОДЯЩА ЗАЯВКА/, 'посоката трябва да личи от заглавието');
  assert.match(t, /постъпила от РБ Пловдив/, 'и кой е заявителят');
  assert.ok(!/Ръководител: …/.test(t), 'чужда заявка не се утвърждава от нашия ръководител');
  assert.match(t, /Предал документа/, 'подписът е за предаване, не за заявяване');
});

test('номерът на заявката за МЗС носи годината си', async () => {
  /* Регистърът брои отначало всяка година и проверката за дубликат е по двойката
     (година, №) — а заглавието печаташе „№ 4 / 04.04.2026“, тоест номер, който не
     съвпада нито с регистъра, нито с името на самия файл. */
  const dom = buildDom({ 'mzs.list': [{ id: 1, no: 4, year: '2026', date: '2026-04-04',
    direction: 'изходящо', partner: 'РБ', title: 'Книга', status: 'заявено' }] });
  const { window } = dom;
  await settle();
  window.location.hash = '#mzs';
  await window.route();
  await settle();
  window.printMzsDoc(1);
  await settle();
  assert.match(printed(window), /ЗАЕМАНЕ № 4 \/ 2026/, 'номер / година, както в регистъра');
});

/* ==================================================================
   3. КДБФ — двете части и невидимите документи
   ================================================================== */

test('kdbf:report връща числата за съгласуване между Част № 1 и Част № 2', () => {
  /* Част № 1 брои по годината на ПАРТИДАТА, Част № 2 — по годината на ВПИСВАНЕ.
     Партида от 30.12.2025, чиито документи се инвентират на 05.01.2026, стои в
     Част № 1 за 2025 и в Част № 2 за 2026. */
  const { db } = freshDb('inv-v2417-kdbf-');
  const acq = db.prepare("INSERT INTO acquisitions (no, year, date, total_count) VALUES (1, '2025', '2025-12-30', 2)")
    .run().lastInsertRowid;
  const ins = db.prepare('INSERT INTO books (inv_number, title, register_date, acquisition_id, price) VALUES (?, ?, ?, ?, ?)');
  ins.run(1, 'А', '2026-01-05', acq, 10);
  ins.run(2, 'Б', '2026-01-05', acq, 10);
  const ipcMain = fakeIpcMain();
  require('../handlers/kdbf')(ipcMain, { getDb: () => db, run: runDep, yearOf: () => '2026' });

  const r25 = ipcMain.invoke('kdbf:report', '2025').data;
  assert.equal(r25.part1Sum.n, 2, 'Част № 1 за 2025 съдържа партидата с двата документа');
  assert.equal(r25.acquiredYear.n, 0, 'Част № 2 за 2025 не ги брои — вписани са през 2026');
  assert.equal(r25.crossOut.n, 2, 'и разликата е именно тези два документа');
  assert.equal(r25.crossIn.n, 0);

  const r26 = ipcMain.invoke('kdbf:report', '2026').data;
  assert.equal(r26.part1Sum.n, 0, 'през 2026 няма партиди');
  assert.equal(r26.acquiredYear.n, 2, 'но има две постъпили по датата на вписване');
  assert.equal(r26.crossIn.n, 2, 'и разликата пак е обяснена');
  assert.equal(r26.crossOut.n, 0);
});

test('kdbf:report брои документите без дата на вписване отделно', () => {
  /* stockAt() иска register_date <= дата, а NULL не е <= нищо: такъв документ е
     невидим и за наличността, и за постъпленията. Числото не се променя мълчаливо
     — справката го носи, за да може изгледът да го обяви. */
  const { db } = freshDb('inv-v2417-kdbf2-');
  const ins = db.prepare('INSERT INTO books (inv_number, title, register_date, price) VALUES (?, ?, ?, ?)');
  ins.run(1, 'С дата', '2026-02-01', 10);
  ins.run(2, 'Без дата', null, 7);
  ins.run(3, 'Празна дата', '', 3);
  const ipcMain = fakeIpcMain();
  require('../handlers/kdbf')(ipcMain, { getDb: () => db, run: runDep, yearOf: () => '2026' });
  const r = ipcMain.invoke('kdbf:report', '2026').data;
  assert.equal(r.acquiredYear.n, 1, 'постъпленията броят само документа с дата — това е дефектът');
  assert.equal(r.undated.n, 2, 'а другите два се обявяват отделно');
  assert.equal(r.undated.rows, 2);
  assert.equal(r.undated.v, 10, '7 + 3 лв. — стойността, която не е отчетена като постъпление');
  /* Двата случая НЕ са еднакви и документът не бива да ги слива: NULL не изпълнява
     `register_date <= '2026-12-31'` и изчезва и от наличността, а празният низ се
     сравнява по азбучен ред, минава и остава в нея. */
  assert.equal(r.undated.missing_from_stock, 1, 'само NULL пропада и от наличността');
  assert.equal(r.stockEnd.n, 2, 'празният низ остава в наличността — затова се броят отделно');
});

test('КДБФ обявява на хартия и разминаването, и невидимите документи', async () => {
  const report = {
    year: '2026', part1: [], part3: [],
    stockEnd: { n: 5, v: 50 }, acquiredYear: { n: 2, v: 20 }, deaccYear: { n: 0, v: 0 },
    crossIn: { n: 2, v: 20 }, crossOut: { n: 0, v: 0 },
    undated: { n: 3, v: 33, rows: 3 }, part1Sum: { n: 0, v: 0 }
  };
  const dom = buildDom({ 'kdbf.report': report, 'acquisitions.get': { items: [] } });
  const { window } = dom;
  await settle();
  window.eval('KDBF_TAB = "p2"');
  window.location.hash = '#kdbf';
  await window.route();
  await settle();
  const screen = window.document.getElementById('view').textContent.replace(/\s+/g, ' ');
  assert.match(screen, /3 записа нямат/, 'екранът обявява невидимите документи');
  window.printKdbfDoc();
  await settle();
  const t = printed(window);
  assert.match(t, /3 документа не са отчетени като постъпили през нито една година/,
    'и разпечатката — тя е документът, който се проверява');
  assert.match(t, /Съгласуване на Част № 1 с Част № 2/, 'разминаването се обяснява и на хартия');
});

/* ==================================================================
   4. „ОТЧИСЛЕН“ ОТ ФОРМАТА НА КНИГАТА
   ================================================================== */

test('формата на книгата не предлага „отчислен“ като избор', async () => {
  const dom = buildDom({ 'books.get': { id: 1, inv_number: 1, title: 'Т', status: 'наличен' },
    'categories.list': [], 'authorities.values': [], 'books.suggestions': {}, 'shelves.list': [] });
  const { window } = dom;
  await settle();
  await window.bookForm(1);
  await settle();
  const sel = window.document.querySelector('#bookF select[name="status"]');
  assert.ok(sel, 'полето „Състояние“ трябва да е падащо меню за неотчислен документ');
  const opts = [...sel.options].map(o => o.value);
  assert.ok(!opts.includes('отчислен'),
    'отчисляването е формален акт по чл. 30 – 39, не избор от списък');
  assert.deepEqual(opts, ['наличен', 'липсващ', 'за реставрация']);
});

test('отчислен документ пази състоянието си при записване на картона', async () => {
  /* Ако опцията просто отпаднеше, <select> без съвпадаща стойност избира първата —
     и всяко записване на картона на отчислен документ би го върнало „наличен“
     БЕЗ анулиране на акта, тоест би разцепило инвентарната книга от КДБФ. */
  const dom = buildDom({ 'books.get': { id: 2, inv_number: 2, title: 'О', status: 'отчислен', status_date: '2026-01-01' },
    'categories.list': [], 'authorities.values': [], 'books.suggestions': {}, 'shelves.list': [] });
  const { window } = dom;
  await settle();
  await window.bookForm(2);
  await settle();
  assert.equal(window.document.querySelector('#bookF select[name="status"]'), null,
    'за отчислен документ не се предлага меню изобщо');
  const d = window.formData('#bookF');
  assert.equal(d.status, 'отчислен', 'състоянието трябва да преживее записа непокътнато');
  const txt = window.document.querySelector('#bookF').textContent;
  assert.match(txt, /анулиране на акта/, 'и да се каже как СЕ ВРЪЩА във фонда');
});

/* ==================================================================
   5. ГОДИШНАТА СПРАВКА И ПРАЗНИЯТ ПОДПИСАН ФОРМУЛЯР
   ================================================================== */

test('годишната справка А/Б казва и на хартия колко дни обхваща', async () => {
  const dom = buildDom({
    'reports.list': [{ id: 'annual_ab', title: 'Годишен отчет', needsYear: true }],
    'reports.run': { id: 'annual_ab', year: '2026', totals: {}, daysRecorded: 0 }
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#reports';
  await window.route();
  await settle();
  window.printReportDoc();
  await settle();
  assert.match(printed(window), /няма нито един вписан ден/,
    'нулите в отчет към Министерството не бива да излизат без обяснение');
});

test('справка без готова разпечатка не издава празен подписан формуляр', async () => {
  const dom = buildDom({
    'reports.list': [{ id: 'nova_spravka', title: 'Нова справка', needsYear: false }],
    'reports.run': { id: 'nova_spravka', year: '2026' }
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#reports';
  await window.route();
  await settle();
  window.printReportDoc();
  await settle();
  assert.equal(printed(window).trim(), '', 'нищо не бива да се отпечата');
  assert.ok(dom.toasts.some(([m]) => /празен подписан формуляр/.test(m)),
    'и библиотекарят трябва да разбере защо');
});

test('групиращият ред покрива точно колоните на дневника', () => {
  /* Раздел А има четири колони „Всичко“, Раздел Б — три; без групиращ ред на
     хартия не личи коя към коя разбивка се отнася. Спановете ТРЯБВА да съвпадат с
     броя колони — иначе заглавията се разминават с данните. */
  const src = fs.readFileSync(path.join(VIEWS_DIR, 'dnevnik.js'), 'utf8');
  const sandbox = { esc: (s) => String(s) };
  // Изпълнява се само частта с константите — до първата функция за рендиране.
  const cut = src.indexOf('/* Всички реални');
  assert.ok(cut > 0, 'структурата на файла се е променила — тестът трябва да се обнови');
  const fn = new Function('esc', src.slice(0, cut) + `
    return { A: DNEVNIK_A_COLS, B: DNEVNIK_B_COLS, GA: DNEVNIK_A_GROUPS, GB: DNEVNIK_B_GROUPS };`);
  const v = fn(sandbox.esc);
  assert.equal(v.GA.reduce((s, [, n]) => s + n, 0), v.A.length,
    'Раздел А: групите трябва да покриват всички колони');
  assert.equal(v.GB.reduce((s, [, n]) => s + n, 0), v.B.length,
    'Раздел Б: същото');
  // И че групите наистина обясняват двете суми, които не са сбор на видимите колони.
  assert.ok(v.GA.some(([l]) => /включва и децата/.test(l)), 'сборът по образование включва и децата');
  assert.ok(v.GA.some(([l]) => /включва и учащите/.test(l)), 'сборът по занятие включва и учащите се');
  assert.ok(v.GB.some(([l]) => /не влиза в горните сборове/.test(l)), '„В читални“ не се сумира');
});

test('всяко поле на дневника има човешко име за CSV износа', () => {
  /* Заглавният ред беше „a_prof_agrospec;b_cat_793;…“. Нов ред в дневника без име
     тук би върнал имената от базата само за него — и разминаването не би личало. */
  const src = fs.readFileSync(path.join(APP_DIR, 'handlers', 'dnevnik.js'), 'utf8');
  // Само от двата списъка с полета — иначе низове като 'b_type_' от startsWith()
  // влизат в набора и тестът се проваля срещу нещо, което не е поле.
  const listOf = (name) => {
    const i = src.indexOf('const ' + name + ' = [');
    assert.ok(i > 0, name + ' трябва да се намери в handlers/dnevnik.js');
    return [...src.slice(i, src.indexOf('];', i)).matchAll(/'((?:a|b)_[a-z0-9_]+)'/g)].map(m => m[1]);
  };
  const uniq = [...new Set([...listOf('DNEVNIK_A_FIELDS'), ...listOf('DNEVNIK_B_FIELDS')])];
  assert.ok(uniq.length > 60, 'полетата на дневника трябва да се разчитат от източника');
  const labels = src.slice(src.indexOf('const DNEVNIK_LABELS'), src.indexOf('function daysInMonth'));
  for (const f of uniq) {
    assert.match(labels, new RegExp('\\b' + f + ':\\s*\'[^\']+\''), 'липсва човешко име за ' + f);
  }
});

/* ==================================================================
   6. ИЗНОС КЪМ ДРУГИ БИБЛИОТЕЧНИ СИСТЕМИ
   ================================================================== */
function catalogSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  db.prepare("UPDATE settings SET lib_name = 'НЧ Тест' WHERE id = 1").run();
  const stub = () => {};
  const { BOOK_SELECT } = require('../handlers/books')(fakeIpcMain(), {
    getDb: () => db, run: runDep, logAudit: stub, today: () => '2026-08-04',
    ftsQuery: stub, cnSortKey: () => '', diffFields: () => [], scheduleCatalogWrite: stub
  });
  const ipcMain = fakeIpcMain();
  const ctx = { savePath: null };
  const audit = [];
  require('../handlers/catalog')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: (a, d) => audit.push(a + ': ' + d),
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: ctx.savePath }) },
    getMainWindow: () => ({}), fs, path,
    execFile: (cmd, args, opts, cb) => cb(null, '', ''),
    BOOK_SELECT, csvCell: require('../security-utils').csvCell,
    flushCatalogWrite: () => ({ written: true }), buildCatalogPayload: () => ({ items: [] })
  });
  const exportTo = async (channel, name) => {
    ctx.savePath = path.join(dir, name);
    const res = await ipcMain.invoke(channel);
    assert.equal(res.ok, true, channel + ': ' + (res.error || ''));
    return { text: fs.readFileSync(ctx.savePath, 'utf8'), res };
  };
  return { db, exportTo, audit };
}

test('UNIMARC не изнася два записа с един и същ контролен номер 001', async () => {
  /* `b.inv_number ?? b.id`: документ БЕЗ инвентарен номер падаше към вътрешния
     rowid, който спокойно съвпада с чужд инвентарен номер. Приемащата система
     отхвърля или презаписва записа с вече срещнат 001 — тихо изгубен запис. */
  const { db, exportTo } = catalogSetup('inv-v2417-marc-');
  const ins = db.prepare('INSERT INTO books (inv_number, title, status) VALUES (?, ?, ?)');
  ins.run(null, 'Без инвентарен номер', 'наличен'); // rowid = 1
  ins.run(1, 'С инвентарен номер 1', 'наличен');    // сблъсък със същото „1“
  const { text } = await exportTo('catalog:exportMarc', 'm.xml');
  const ids = [...text.matchAll(/<controlfield tag="001">([^<]*)<\/controlfield>/g)].map(m => m[1]);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, 'двата записа НЕ бива да имат един и същ 001');
  assert.ok(ids.includes('1') && ids.some(x => /^invlib-id-/.test(x)),
    'истинският инвентарен номер остава какъвто е; резервният носи представка');
});

test('износът не праща на сводния каталог отчислени и служебни документи', async () => {
  const { db, exportTo } = catalogSetup('inv-v2417-excl-');
  const ins = db.prepare('INSERT INTO books (inv_number, title, status, department) VALUES (?, ?, ?, ?)');
  ins.run(1, 'Наличен', 'наличен', 'Заемна');
  ins.run(2, 'Отчислен', 'отчислен', 'Заемна');
  ins.run(3, 'Служебен', 'наличен', 'служебен');
  ins.run(4, 'Без статус', null, 'Заемна'); // внесена база отпреди enum тригера
  const { text, res } = await exportTo('catalog:exportMarc', 'm2.xml');
  assert.equal((text.match(/<record>/g) || []).length, 2);
  assert.ok(!/Отчислен/.test(text), 'библиотеката вече не притежава този документ');
  assert.ok(!/Служебен/.test(text), 'служебният екземпляр не се предлага на читател');
  assert.ok(/Без статус/.test(text),
    'но запис с NULL статус НЕ бива да се губи при мигриране — това е пренос, не каталог');
  assert.equal(res.data.count, 2);
  assert.equal(res.data.excluded, 2, 'броят на пропуснатите се съобщава');
});

test('непознат език не влиза дословно в кодирано поле', async () => {
  const { db, exportTo } = catalogSetup('inv-v2417-lang-');
  db.prepare("INSERT INTO books (inv_number, title, language, status) VALUES (1, 'Т', 'японски', 'наличен')").run();
  const { text } = await exportTo('catalog:exportMarc', 'm3.xml');
  assert.match(text, /tag="101"[\s\S]*?code="a">und</, '101 $a е трибуквен код по ISO 639-2');
  assert.match(text, /tag="300"[\s\S]*?Език: японски/, 'оригиналното наименование не се губи');
});

test('UNIMARC носи поле 801 с библиотеката, от която идва записът', async () => {
  const { db, exportTo } = catalogSetup('inv-v2417-801-');
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1, 'Т', 'наличен')").run();
  const { text } = await exportTo('catalog:exportMarc', 'm4.xml');
  assert.match(text, /tag="801"[\s\S]*?code="a">BG</);
  assert.match(text, /tag="801"[\s\S]*?code="b">НЧ Тест</,
    'сводният каталог трябва да знае от коя библиотека е записът');
});

test('поле 225 не се строи без заглавие на поредица', async () => {
  const { db, exportTo } = catalogSetup('inv-v2417-225-');
  const ins = db.prepare('INSERT INTO books (inv_number, title, volume, series, series_no, status) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(1, 'Само том', 'Т. 2', null, null, 'наличен');
  ins.run(2, 'С поредица', null, 'Библиотека Х', '7', 'наличен');
  const { text } = await exportTo('catalog:exportMarc', 'm5.xml');
  const recs = text.split('<record>').slice(1);
  assert.ok(!/tag="225"/.test(recs[0]), 'том без поредица не е заявка за поредица');
  assert.match(recs[0], /tag="200"[\s\S]*?code="h">Т\. 2</, 'томът върви в 200 $h');
  assert.match(recs[1], /tag="225"[\s\S]*?code="a">Библиотека Х</, 'а истинската поредица — в 225 $a');
});

test('CSV на фонда носи бройките и оставя следа в одита', async () => {
  const { db, exportTo, audit } = catalogSetup('inv-v2417-csv-');
  const id = db.prepare("INSERT INTO books (inv_number, title, price, status) VALUES (1, 'Т', 4, 'наличен')")
    .run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 3)').run(id);
  const { text } = await exportTo('catalog:exportCsv', 'f.csv');
  const lines = text.slice(1).split('\r\n');
  const h = lines[0].split(';');
  const row = lines[1].split(';');
  assert.equal(row[h.indexOf('Бройки')], '"3"');
  assert.equal(row[h.indexOf('Обща стойност (лв.)')], '"12.00"', '3 × 4.00 — иначе сборът в Excel лъже');
  assert.ok(audit.some(a => /CSV/.test(a)), 'изнасянето на целия фонд с цените се вписва в одита');
});

/* ==================================================================
   7. КРАЕВЕДСКИТЕ РАЗПЕЧАТКИ — филтърът, който не се вижда
   ================================================================== */

test('летописът обявява обхвата си и подрежда годините по число', async () => {
  const rows = [
    { id: 1, year: '878', title: 'Стара' },
    { id: 2, year: '1878', title: 'По-нова' },
    { id: 3, year: 'ок. 1900', title: 'Приблизителна' }
  ];
  const dom = buildDom({ 'chronicle.list': rows, 'chronicle.years': [] });
  const { window } = dom;
  await settle();
  window.eval('CHR_Q = "чит"');
  await window.printChronicle();
  await settle();
  const t = printed(window);
  assert.match(t, /Това НЕ е пълният летопис/, 'филтрираната разпечатка се обявява като такава');
  assert.match(t, /съдържащи „чит“/);
  const order = ['878 г.', '1878 г.', 'ок. 1900 г.'].map(s => t.indexOf(s));
  assert.ok(order[0] < order[1] && order[1] < order[2],
    'хронологията се подрежда по числото на годината, не азбучно: ' + JSON.stringify(order));
});

test('персоналиите носят източниците на сведенията', async () => {
  const dom = buildDom({ 'persons.list': [
    { id: 1, name: 'Иван Иванов', bio: 'Биография', sources: 'Летопис на читалището, 1934' },
    { id: 2, name: 'Втори', bio: 'Б' }
  ] });
  const { window } = dom;
  await settle();
  await window.printPersons();
  await settle();
  const t = printed(window);
  assert.match(t, /Източници: Летопис на читалището, 1934/,
    'краеведска справка без източник не може да бъде проверена');
  assert.match(t, /Източници: непосочени/, 'а липсата се обявява, вместо да мълчи');
  assert.match(t, /Пълен списък/, 'обхватът се казва и когато е пълен');
});

/* ==================================================================
   8. КВИТАНЦИЯТА
   ================================================================== */

test('квитанцията носи номер и състоянието на сметката', async () => {
  const dom = buildDom({
    'readers.get': { id: 1, name: 'Читател', card_no: '000123' },
    'account.get': { balance: 4.5, lines: [{ id: 77, date: '2026-05-05', kind: 'плащане', type: 'глоба', amount: -3 }] },
    'settings.get': { annual_fee: 0 }
  });
  const { window } = dom;
  await settle();
  await window.accountModal(1);
  await settle();
  window.printReceiptLine(77);
  await settle();
  const t = printed(window);
  assert.match(t, /КВИТАНЦИЯ № 77/, 'квитанция без номер не може да бъде посочена в счетоводството');
  assert.match(t, /дължими 4\.50/,
    'читателят плаща част от глобата и трябва да види какво остава');
});

/* ==================================================================
   9. ИНВЕНТАРНАТА КНИГА
   ================================================================== */

test('разпечатката на инвентарната книга казва какво точно съдържа', async () => {
  const rows = [
    { id: 1, inv_number: 1, title: 'А', register_date: '2026-01-01', price: 10, quantity: 2, status: 'наличен' },
    { id: 2, inv_number: 2, title: 'Б', register_date: '2026-01-02', price: 5, quantity: 1, status: 'отчислен' },
    { id: 3, inv_number: 3, title: 'В', register_date: '2026-01-03', price: 7, quantity: 1, status: 'липсващ' }
  ];
  const dom = buildDom({ 'invBook.list': rows });
  const { window } = dom;
  await settle();
  window.location.hash = '#invbook';
  await window.route();
  await settle();
  window.printInvBookDoc();
  await settle();
  const t = printed(window);
  // Проверява се ГЛАВАТА на документа, не подписът под таблицата — иначе долният
  // ред „Настоящата разпечатка съдържа N вписвания“ сам изпълнява условието.
  assert.match(t, /Разпечатано на [^·]+· 3 вписвания \(инвентарни номера\)/,
    'главата казва колко вписвания съдържа книгата');
  assert.match(t, /2 неотчислени и 1 отчислени/, 'а не всичките са фонд');
  assert.match(t, /Фонд по инвентарната книга \(без отчислените\): 3 библиотечни документа/,
    'документите са друго число от вписванията');
  assert.match(t, /27\.00/, 'и стойността следва бройките, не редовете');
  /* „Неотчислен“ не значи „наличен“: липсващият документ е в сбора (както в
     stockAt() на КДБФ), но листът, който се прошнурова и заверява по чл. 26,
     ал. 2, НЕ бива да го обявява за наличен — състоянията се изброяват. */
  assert.ok(!/наличен фонд/i.test(t), 'думата „наличен“ не бива да покрива липсващите');
  assert.match(t, /състояние, различно от „наличен“: липсващ — 1/,
    'липсващият се обявява поименно');
});

/* ==================================================================
   10. ПРЕГЛЕД НА СОБСТВЕНИТЕ ПОПРАВКИ ОТ ТОЗИ КРЪГ
       Всичко по-долу са дефекти, внесени от поправките в раздели 1 – 9.
   ================================================================== */

test('маскирането на лични данни е по поле, не по ред', () => {
  /* Първият вариант на поправката вдигаше ЕДИН флаг за целия ред и го ИЗТРИВАШЕ
     при следващото успешно поле. Ред с нечетим ЕГН и редовен № на лична карта
     излизаше без флаг — и картонът пак печаташе „Защитени данни (ключът не
     съвпада)“ на мястото на ЕГН, тоест точно каквото поправката трябваше да спре. */
  const { db } = freshDb('inv-v2417-pdp-');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  const pii = require('../pii-crypto');
  const ipcMain = fakeIpcMain();
  const ret = require('../handlers/pdp')(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  ipcMain.invoke('pdp:setup', 'редовна-парола-11');
  const key = pii.deriveKey('редовна-парола-11',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
  const foreign = pii.deriveKey('чужда-9999', pii.generateSalt(2));
  const ins = db.prepare('INSERT INTO readers (name, egn, id_card_no) VALUES (?, ?, ?)');
  // Ред 1: ЕГН нечетим, № на карта редовен — редът, който първата поправка изпускаше.
  ins.run('Смесен', pii.encryptField('7501010001', foreign), pii.encryptField('АА1234567', key));
  // Ред 2: ЕГН на ОТКРИТ ТЕКСТ (отпреди защитата), № на карта криптиран и редовен.
  ins.run('Отчасти открит', '7502020002', pii.encryptField('ББ7654321', key));
  // Ред 3: и двете редовни.
  ins.run('Редовен', pii.encryptField('7503030003', key), pii.encryptField('ВВ1111111', key));

  const rows = ret.maskReaderRows(db.prepare('SELECT * FROM readers ORDER BY id').all());
  assert.deepEqual(rows[0].pii_masked_fields, ['egn'],
    'скрито е САМО ЕГН — успешното следващо поле не бива да трие флага');
  assert.equal(rows[0].id_card_no, 'АА1234567');
  assert.equal(rows[1].pii_masked, undefined, 'открит текст не е маскиране');
  assert.equal(rows[1].egn, '7502020002');
  assert.equal(rows[2].pii_masked, undefined);
});

test('читателският картон скрива само това, което наистина е скрито', async () => {
  const dom = buildDom({
    'readers.get': { id: 5, name: 'Читател', card_no: 'K-9', egn: '7502020002',
      egn_plain: true, id_card_no: 'Защитени данни', pii_masked: true, pii_masked_fields: ['id_card_no'],
      registered_at: '2026-01-01' },
    'loans.byReader': []
  });
  const { window } = dom;
  await settle();
  await window.printReaderCard(5);
  await settle();
  const t = printed(window);
  assert.match(t, /ЕГН: 7502020002/, 'ЕГН е било налично и няма причина да се крие');
  assert.match(t, /Лична карта: № …/, 'а № на лична карта е скрит');
  assert.match(t, /№ на лична карта не е отпечатан/, 'бележката назовава точно скритото поле');
  assert.ok(!/ЕГН и № на лична карта не са отпечатани/.test(t));
  assert.ok(!/Защитени данни/.test(t), 'вътрешната константа никога не стига до хартията');
});

test('картонът не печата баркод на вътрешния номер при липсваща карта', async () => {
  /* Същият дефект като в readerCardHtml (core.js), пропуснат при първата
     поправка: лентите кодираха rowid, сканирането търси по номер на карта, тоест
     сочеха към читателя, чиято карта е с този номер — друг гражданин. */
  const dom = buildDom({
    'readers.get': { id: 7, name: 'Без карта', card_no: null, registered_at: '2026-01-01' },
    'loans.byReader': []
  });
  const { window } = dom;
  await settle();
  await window.printReaderCard(7);
  await settle();
  assert.equal(printedHtml(window).match(/<svg/g), null, 'няма номер — няма баркод');
  assert.match(printed(window), /Няма номер на карта/);
});

test('трите пояснения в един акт носят различни етикети', async () => {
  /* Могат да излязат едновременно; три абзаца подред, всеки започващ с
     „Забележка:“, са нечитаеми на документ, който отива подписан в
     счетоводството. */
  const acq = {
    id: 20, no: 9, year: '2026', date: '2026-06-06', how: 'закупуване', from_source: 'К',
    doc_type: 'без документ', doc_no: '1', doc_date: '2026-06-06',
    total_count: 10, sum: 100, note: 'свободна бележка',
    items: [{ inv_number: 1, title: 'А', price: 5, fund_qty: 1 }]
  };
  const dom = buildDom({ 'acquisitions.get': acq, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printAcqNoDocDoc(20);
  await settle();
  const t = printed(window);
  assert.match(t, /Относно стойността:/);
  assert.match(t, /Относно броя:/);
  assert.match(t, /Забележка по партидата: свободна бележка/);
  assert.equal((t.match(/Забележка/g) || []).length, 1, 'само една дума „Забележка“ в документа');
});

test('акт без обявена стойност и без опис не печата изчислена нула', async () => {
  /* Първата редакция печаташе „Обща стойност (изчислена по инвентираните
     документи): 0.00 лв.“ точно над бележката, че инвентирани документи няма —
     актът сам си противоречеше. */
  const dom = buildDom({ 'acquisitions.get': { id: 21, no: 10, year: '2026', date: '2026-06-07',
    how: 'дарение', from_source: 'Д', total_count: 4, sum: null, items: [] }, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printDonationDoc(21);
  await settle();
  const t = printed(window);
  assert.match(t, /не е обявена в документа и не може да бъде изчислена/);
  assert.ok(!/0\.00/.test(t), 'нула, извлечена от празен опис, не е стойност');
});
