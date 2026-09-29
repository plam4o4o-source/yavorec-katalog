'use strict';
/* v2.4.71 — кръг 45, област ОТЧИСЛЯВАНЕ, ИНВЕНТАРИЗАЦИЯ, ТЕЛЕФОН (+ МЗС в тях).
   =====================================================================
   По един (или повече) тест на всяка поправена находка. Всеки твърди онова,
   което БИБЛИОТЕКАРКАТА вижда — прозореца преди и след приключването,
   текста на разпечатания протокол, състоянието на книгата, отказа на акта,
   полетата на формата, реда в дневника, списъка на телефона — и е проверен с
   връщане на поправката назад: без нея пада.

   И1  Книга, вписана след началото на пълна инвентаризация, ставаше „липсващ“,
       а прозорецът обещаваше „5 от 5“.
   И2  Акт без член 1 и член 3 на комисията се утвърждаваше и триеше комисията
       от „Настройки“.
   И3  Протокол за отдел: „Какво е проверявано: целият фонд · отдел „за деца““.
   И4  „Нова инвентаризация“ не предлагаше комисията от „Настройки“.
   И5  Страницата за телефон прерисуваше целия списък при всяко добавяне.
   М1  Документ при партньора по МЗС ставаше „липсващ“ при пълна проверка.
   М2  Документ при партньора по МЗС се отчисляваше с акт.
   М9  „Проверете папката … в „Настройки““ — папката е в „Отчети“ → „Онлайн каталог“.

   КОЛОНИТЕ НА КРЪГА. Приключването снима две нови числа (mzs_away, added_late)
   и помни при започването last_book_id. Добавя ги миграция 19 (main.js) и
   db/schema.sql — тестът само проверява, че ги има в базата, която програмата
   сама е създала. */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { JSDOM, VirtualConsole } = require('jsdom');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
const Y = T.slice(0, 4);
const bgD = (iso) => iso.split('-').reverse().join('.');
function ensureRoundCols(db) {
  const have = new Set(db.prepare('PRAGMA table_info(inventory_sessions)').all().map(r => r.name));
  for (const c of ['last_book_id', 'mzs_away', 'added_late']) {
    assert.ok(have.has(c), 'колоната inventory_sessions.' + c + ' идва от схемата/миграция 19');
  }
}
test.before(async () => { h = await E.bootApp(); ensureRoundCols(h.db); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + res.error); return res.data; };
const flat = (s) => String(s || '').replace(/\s+/g, ' ');

function mkBook(inv, o = {}) {
  const id = Number(h.db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, status_date, department)
    VALUES (?, ?, 'Автор', ?, ?, ?, ?, ?)`)
    .run(inv, o.title || ('Книга ' + inv), o.price == null ? 10 : o.price, o.register_date || E.addDays(T, -400),
      o.status || 'наличен', T, o.department || null).lastInsertRowid);
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
  return id;
}
const COMM = { committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' };
async function startSess(department, extra) {
  return ok(await h.api.inventorySessions.start(Object.assign({
    date: T, scope: 'отдел ' + department, department, order_no: '9', no: null
  }, COMM, extra || {})), 'започване на инвентаризация');
}
/* Наш документ, изпратен на друга библиотека по входяща заявка — така, както го
   записва „МЗС“ (handlers/mzs.js): book_id, „изпратено“, дата на изпращане. */
let mzsNo = 900;
function sendByMzs(bookId, partner) {
  mzsNo++;
  h.db.prepare(`INSERT INTO mzs_requests (no, year, date, direction, partner, title, status, book_id, date_sent, due_date)
    VALUES (?, ?, ?, 'входящо', ?, 'Изпратена книга', 'изпратено', ?, ?, ?)`)
    .run(mzsNo, Y, T, partner, bookId, T, E.addDays(T, 30));
  return mzsNo;
}
/* Приключване през самия екран: прозорецът с избора, после прозорецът с числата,
   после протоколът — трите неща, които библиотекарката вижда. */
async function closeViaScreen(sid, mode) {
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  await h.clickButton('Приключи и състави протокол', '#view');
  const ask = flat(h.modal());
  h.$('#modal input[name=ivMode][value=' + mode + ']').checked = true;
  await h.clickButton('Приключи и състави протокол', '#modal');
  await h.settle();
  const win = flat(h.modal());
  await h.clickButton('Затвори', '#modal');
  await h.window.printInventProtocol(sid); await h.settle();
  const pr = flat(h.printed());
  h.window.ppClose();
  return { ask, win, pr };
}

/* ==================================================================
   И1. Вписаната след началото книга не е липса; прозорецът брои като приключването
   ================================================================== */
test('И1 — книга, вписана след началото на пълна проверка, не става „липсващ“ и е на отделен ред в протокола', async () => {
  const dep = 'И1-отдел';
  for (let i = 0; i < 5; i++) mkBook(47101 + i, { department: dep });
  const sid = await startSess(dep);
  for (let i = 0; i < 5; i++) ok(await h.api.inventorySessions.scan({ sessionId: sid, code: String(47101 + i) }), 'сканиране');
  // Докато проверката тече, постъпва шеста книга — през истинското вписване.
  const cat = q("SELECT id FROM categories ORDER BY id LIMIT 1");
  const late = ok(await h.api.books.create({ inv_number: 47106, title: 'Днес постъпила', author: 'Б', price: 12,
    department: dep, category_id: cat ? cat.id : null, register_date: T }), 'вписване на нова книга');
  const lateId = typeof late === 'object' ? late.id : late;

  const r = await closeViaScreen(sid, 'full');
  // Прозорецът преди приключването брои от СЪЩИЯ обхват като приключването.
  assert.match(r.ask, /Проверени са 5 от 6 документа в обхвата\. Останалите 1 не са сканирани\./, r.ask);
  assert.match(r.ask, /От тях не стават липсващи: 1 постъпил след началото на проверката/, r.ask);
  assert.match(r.ask, /Пълна проверка на целия обхват — 0 несканирани документа се вписват в протокола като липсващи/, r.ask);
  // Прозорецът след приключването.
  assert.match(r.win, /5 Проверени 0 Липсващи/, r.win);
  assert.match(r.win, /Един документ е вписан след началото на проверката и не е сканиран/, r.win);
  // Базата: книгата не е „липсващ“, няма ред в липсите, снимката е записана.
  assert.equal(q('SELECT status FROM books WHERE id = ?', lateId).status, 'наличен', 'състоянието не се пипа');
  assert.equal(q('SELECT COUNT(*) AS n FROM inventory_session_missing WHERE session_id = ?', sid).n, 0);
  const s = q('SELECT pool_final, scanned_final, added_late FROM inventory_sessions WHERE id = ?', sid);
  assert.deepEqual([s.pool_final, s.scanned_final, s.added_late], [6, 5, 1]);
  // Протоколът: отделен ред, 0 липсващи, без „изгубени от ползватели“ от остатъка.
  assert.match(r.pr, /Документи в обхвата: 6 Проверени документи: 5 Липсващи: 0/, r.pr);
  assert.match(r.pr, /Постъпили след началото на проверката: 1 — вписани в инвентарната книга, докато проверката е текла/, r.pr);
  assert.doesNotMatch(r.pr, /Изгубени от ползватели/, 'остатъкът не бива да ги обяви за изгубени');
  assert.match(r.pr, /При проверката не са установени липсващи документи/);
});

test('И1 — диалогът при приключване показва обхвата към ПРИКЛЮЧВАНЕТО, не снимката при започването', async () => {
  /* Обратният случай на горния: книга ИЗЛИЗА от обхвата (отчислена), докато
     проверката тече. Снимката pool_size казва 3, приключването ще брои 2. */
  const dep = 'И1б-отдел';
  const a = mkBook(47111, { department: dep });
  mkBook(47112, { department: dep });
  const gone = mkBook(47113, { department: dep });
  const sid = await startSess(dep);
  ok(await h.api.inventorySessions.scan({ sessionId: sid, code: '47111' }), 'сканиране');
  h.db.prepare("UPDATE books SET status = 'отчислен', deaccession_date = ? WHERE id = ?").run(T, gone);
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  await h.clickButton('Приключи и състави протокол', '#view');
  const ask = flat(h.modal());
  assert.match(ask, /Проверени са 1 от 2 документа в обхвата\. Останалите 1 не са сканирани\./, ask);
  assert.match(ask, /При започването обхватът беше 3 — междувременно документи са излезли от обхвата/, ask);
  assert.match(ask, /Пълна проверка на целия обхват — 1 несканиран документ се вписва в протокола като липсващ/, ask);
  await h.clickButton('Отказ', '#modal');
  assert.ok(a);
});

/* ==================================================================
   М1. Документ при партньора по МЗС не е липса
   ================================================================== */
test('М1 — документ, изпратен по МЗС, не става „липсващ“: извинява се като заетите, с отделен ред в протокола', async () => {
  const dep = 'М1-отдел';
  mkBook(47121, { department: dep });
  const away = mkBook(47122, { department: dep, title: 'При партньора' });
  mkBook(47123, { department: dep });
  sendByMzs(away, 'НЧ „Развитие“, Габрово');
  const sid = await startSess(dep);
  ok(await h.api.inventorySessions.scan({ sessionId: sid, code: '47121' }), 'сканиране');
  ok(await h.api.inventorySessions.scan({ sessionId: sid, code: '47123' }), 'сканиране');
  const r = await closeViaScreen(sid, 'full');
  assert.match(r.ask, /От тях не стават липсващи: 1 при друга библиотека по МЗС/, r.ask);
  assert.match(r.win, /2 Проверени 0 Липсващи/, r.win);
  assert.match(r.win, /Един документ е при друга библиотека по МЗС/, r.win);
  assert.equal(q('SELECT status FROM books WHERE id = ?', away).status, 'наличен', 'не е „липсващ“');
  assert.equal(q('SELECT COUNT(*) AS n FROM inventory_session_missing WHERE session_id = ?', sid).n, 0,
    'не влиза в липсите — нито в протокола, нито в проекта за акт по т. 6');
  assert.match(r.pr, /Липсващи: 0/, r.pr);
  assert.match(r.pr, /При други библиотеки по междубиблиотечно заемане \(МЗС\) към деня на проверката: 1/, r.pr);
  assert.doesNotMatch(r.pr, /Изгубени от ползватели/, r.pr);
  assert.match(q("SELECT detail FROM audit_log WHERE action = 'Инвентаризация' ORDER BY id DESC LIMIT 1").detail,
    /1 документ при друга библиотека по МЗС \(не е липса\)/);
});

/* ==================================================================
   М2. Акт за документ при партньора по МЗС — отказ с обяснение
   ================================================================== */
test('М2 — документ при партньора по МЗС не се отчислява: ни при сканирането в акта, ни при утвърждаването', async () => {
  const b = mkBook(47131, { title: 'В Габрово' });
  sendByMzs(b, 'НЧ „Развитие“, Габрово');
  const found = await h.api.deaccessionActs.findBook('47131');
  assert.equal(found.ok, false);
  assert.match(found.error, /Инв\. № 47131 \(„В Габрово“\) е изпратен по междубиблиотечно заемане на НЧ „Развитие“, Габрово \(заявка № \d+\/\d{4}/);
  assert.match(found.error, /Когато се върне, отбележете заявката „върнато“ в „МЗС“/);
  assert.match(found.error, /Документът не е добавен в списъка\./);
  const res = await h.api.deaccessionActs.create({ act: Object.assign({
    date: T, no: ok(await h.api.deaccessionActs.nextNo(Y), 'номер'), reason_code: 3, reason_text: 'Физически изхабени'
  }, COMM), bookIds: [b] });
  assert.equal(res.ok, false, 'актът се отказва');
  assert.match(res.error, /изпратен по междубиблиотечно заемане .* Актът НЕ е съставен\./);
  assert.equal(q('SELECT status FROM books WHERE id = ?', b).status, 'наличен');
  assert.equal(q("SELECT status FROM mzs_requests WHERE book_id = ?", b).status, 'изпратено');
  // Екранът: сканирането в акта казва същото и не добавя реда.
  await h.go('acts');
  await h.clickButton('+ Нов акт за отчисляване', '#view');
  await h.waitFor(() => h.$('#actScan'), 'формата за акт'); await h.sleep(120); await h.settle();
  const n = h.toasts.length;
  await h.scan('#actScan', '47131');
  assert.ok(h.toastsSince(n).some(t => /изпратен по междубиблиотечно заемане/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.match(h.text('#actList'), /Списъкът е празен/);
  h.window.closeModal();
});

/* ==================================================================
   И2. Акт без член 1 и член 3 — отказ; Настройки не се трият
   ================================================================== */
test('И2 — акт без член 1 (библиотекар) и член 3 (счетоводител) не се утвърждава и не трие комисията от Настройки', async () => {
  h.db.prepare("UPDATE settings SET committee1 = 'Мария Иванова', committee2 = 'Петър Петров', committee3 = 'Ана Счетоводителка' WHERE id = 1").run();
  const b = mkBook(47141);
  const base = { date: T, reason_code: 3, reason_text: 'Физически изхабени' };
  const res = await h.api.deaccessionActs.create({ act: Object.assign({}, base, {
    no: ok(await h.api.deaccessionActs.nextNo(Y), 'номер'), committee1: '', committee2: '', committee3: '  ' }), bookIds: [b] });
  assert.equal(res.ok, false);
  assert.match(res.error, /Актът не може да се утвърди без член 1 \(библиотекар\) и член 3 \(счетоводител\) на комисията: по чл\. 35/);
  assert.equal(q('SELECT status FROM books WHERE id = ?', b).status, 'наличен', 'нищо не е отчислено');
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts WHERE year = ? AND no = ?', Y,
    ok(await h.api.deaccessionActs.nextNo(Y), 'номер')).n, 0, 'номерът не е зает');
  // Проектът се утвърждава по СЪЩИЯ път — и той отказва.
  const did = ok(await h.api.deaccessionActs.saveDraft({ draft: Object.assign({}, base, { committee1: 'Мария Иванова' }), bookIds: [b] }), 'проект');
  const ap = await h.api.deaccessionActs.approveDraft({ id: did });
  assert.equal(ap.ok, false);
  assert.match(ap.error, /без член 3 \(счетоводител\) на комисията/);
  // Акт с член 1 и 3, без член 2 — минава; Настройки пазят член 2.
  const actId = ok(await h.api.deaccessionActs.create({ act: Object.assign({}, base, {
    no: ok(await h.api.deaccessionActs.nextNo(Y), 'номер'), committee1: 'Нова Библиотекарка', committee2: '', committee3: 'Ана Счетоводителка' }),
  bookIds: [b] }), 'акт с комисия');
  assert.ok(actId);
  const st = q('SELECT committee1, committee2, committee3 FROM settings WHERE id = 1');
  assert.deepEqual([st.committee1, st.committee2, st.committee3], ['Нова Библиотекарка', 'Петър Петров', 'Ана Счетоводителка'],
    'празният член 2 не трие записания в Настройки');
  ok(await h.api.deaccessionActs.deleteDraft(did), 'проектът се маха');
});

test('И2 — формата за акт отбелязва член 1 и член 3 като задължителни и казва това преди утвърждаване', async () => {
  mkBook(47142);
  await h.go('acts');
  await h.clickButton('+ Нов акт за отчисляване', '#view');
  await h.waitFor(() => h.$('#actScan'), 'формата за акт'); await h.sleep(120); await h.settle();
  h.type('#actF [name=reason_code]', '3');
  await h.scan('#actScan', '47142');
  h.type('#actF [name=committee1]', '');
  h.type('#actF [name=committee3]', '');
  const n = h.toasts.length;
  await h.clickButton('Утвърди акта и отчисли', '#modal');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /Член на комисия 1 \(библиотекар\) е задължително поле/.test(t.msg)),
    JSON.stringify(h.toastsSince(n)));
  assert.equal(q("SELECT status FROM books WHERE inv_number = 47142").status, 'наличен');
  h.window.closeModal();
});

/* ==================================================================
   И3 и И4. Формата „Нова инвентаризация“
   ================================================================== */
test('И3/И4 — формата предлага комисията от Настройки, „Какво се проверява“ следва отдела, протоколът е без противоречие', async () => {
  h.db.prepare("UPDATE settings SET committee1 = 'Мария Иванова', committee2 = 'Петър Петров', committee3 = 'Ана Счетоводителка' WHERE id = 1").run();
  const dep = 'за деца И3';
  mkBook(47151, { department: dep });
  await h.go('invent');
  await h.clickButton('Започни нова проверка', '#view');
  await h.waitFor(() => h.$('#ivF'), 'формата за проверка');
  assert.deepEqual(['committee1', 'committee2', 'committee3'].map(k => h.$('#ivF [name=' + k + ']').value),
    ['Мария Иванова', 'Петър Петров', 'Ана Счетоводителка'], 'И4: комисията идва от Настройки');
  assert.equal(h.$('#ivF [name=scope]').value, 'целият фонд');
  const sel = h.$('#ivF [name=department]');
  if (!Array.from(sel.options).some(o => o.value === dep)) sel.add(new h.window.Option(dep, dep));
  h.type('#ivF [name=department]', dep);
  assert.equal(h.$('#ivF [name=scope]').value, 'отдел „' + dep + '“', 'И3: непипнатото поле следва отдела');
  await h.clickButton('Започни сканиране', '#modal footer');
  await h.waitFor(() => h.$('#ivScan'), 'екрана за сканиране');
  const s = q('SELECT id, scope, committee1, committee3 FROM inventory_sessions ORDER BY id DESC LIMIT 1');
  assert.equal(s.scope, 'отдел „' + dep + '“');
  assert.deepEqual([s.committee1, s.committee3], ['Мария Иванова', 'Ана Счетоводителка']);
  ok(await h.api.inventorySessions.scan({ sessionId: s.id, code: '47151' }), 'сканиране');
  const r = await closeViaScreen(s.id, 'representative');
  assert.match(r.pr, new RegExp('Какво е проверявано: отдел „' + dep + '“ Документи в обхвата'), r.pr);
  assert.doesNotMatch(r.pr, /целият фонд/, 'И3: протоколът не твърди два обхвата');
});

test('И3 — обработчикът не допуска „целият фонд“ при отдел; написаното от човек остава', async () => {
  const dep = 'И3б-отдел';
  mkBook(47161, { department: dep });
  const a = await startSess(dep, { scope: 'целият фонд' });
  assert.equal(q('SELECT scope FROM inventory_sessions WHERE id = ?', a).scope, 'отдел „' + dep + '“');
  const b = await startSess(dep, { scope: 'рафтове 3 – 5' });
  assert.equal(q('SELECT scope FROM inventory_sessions WHERE id = ?', b).scope, 'рафтове 3 – 5');
  // Заварена проверка (отпреди поправката) — протоколът пак без противоречие.
  h.db.prepare("UPDATE inventory_sessions SET scope = 'целият фонд' WHERE id = ?").run(a);
  ok(await h.api.inventorySessions.close({ sessionId: a, mode: 'representative' }), 'приключване');
  await h.window.printInventProtocol(a); await h.settle();
  const pr = flat(h.printed()); h.window.ppClose();
  assert.match(pr, new RegExp('Какво е проверявано: отдел „' + dep + '“ Документи'), pr);
  ok(await h.api.inventorySessions.close({ sessionId: b, mode: 'representative' }), 'приключване');
});

/* ==================================================================
   М9. Неуспешен запис на каталога сочи вярното място
   ================================================================== */
test('М9 — неуспешният запис на каталога след акт сочи „Отчети“ → „Онлайн каталог“', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-v2471-'));
  try {
    const db = new Database(path.join(dir, 'library.db'));
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    const handlers = new Map();
    const audit = [];
    const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values.js');
    require('../handlers/deaccession-acts')({ handle: (c, fn) => handlers.set(c, fn) }, {
      getDb: () => db,
      run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
      logAudit: (action, detail) => audit.push({ action, detail }),
      BOOK_SELECT, normalizeScanCode, yearOf: (d) => String(d).slice(0, 4),
      scheduleCatalogWrite: () => {},
      flushCatalogWrite: () => ({ written: false, error: 'папката не е достъпна' })
    });
    const bid = db.prepare("INSERT INTO books (inv_number, title, status, price) VALUES (1, 'К', 'наличен', 5)").run().lastInsertRowid;
    const res = handlers.get('deaccessionActs:create')({}, { act: Object.assign({
      no: 1, date: T, reason_code: 3, reason_text: 'Физически изхабени' }, COMM), bookIds: [bid] });
    assert.equal(res.ok, true, res.error);
    const line = audit.find(a => a.action === 'Онлайн каталог');
    assert.ok(line, JSON.stringify(audit));
    assert.match(line.detail, /не успя: папката не е достъпна\. Проверете папката за онлайн каталога в „Отчети“ → „Онлайн каталог“\./);
    assert.doesNotMatch(line.detail, /„Настройки“/);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ==================================================================
   И5. Страницата за телефон — добавянето не прерисува целия списък
   ================================================================== */
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile-template.html'), 'utf8');
function openPhone(saved) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(PAGE.replace(/__SLUG__/g, 'biblioteka'), {
    runScripts: 'dangerously', url: 'https://example.org/skener.html', virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(w) {
      w.BarcodeDetector = function () { return { detect: async () => [] }; };
      w.navigator.mediaDevices = { getUserMedia: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); } };
      Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} } });
      w.localStorage.clear();
      if (saved) w.localStorage.setItem('inventar-scan-v1', JSON.stringify(saved));
    }
  });
  return dom.window;
}
test('И5 — добавянето вмъква само новия ред: старите редове остават същите, на екрана — последните 100', async () => {
  const codes = []; for (let i = 1; i <= 1250; i++) codes.push(String(100000 + i));
  const w = openPhone({ codes, dups: 0, started: T });
  try {
    const d = w.document, ul = d.getElementById('list');
    assert.equal(ul.children.length, 100, 'на екрана стоят последните 100 номера');
    assert.match(d.getElementById('moreTxt').textContent, /Показани са последните 100 от 1250 номера/);
    const keep = ul.children[0];                        // най-новият дотук — трябва да оцелее
    const man = d.getElementById('manual');
    man.value = '777777';
    d.getElementById('addBtn').click();
    assert.equal(ul.children.length, 100, 'дължината на екрана не расте с дължината на списъка');
    assert.equal(ul.children[0].textContent.replace('×', '').trim(), '777777', 'новият ред е най-отгоре');
    assert.strictEqual(ul.children[1], keep, 'старите редове НЕ се сглобяват наново — същият елемент');
    assert.equal(d.getElementById('cnt').textContent, '1251');
    assert.match(d.getElementById('moreTxt').textContent, /от 1251 номера/);
    // Паметта на браузъра е вече записана — нито номер не изостава.
    assert.equal(JSON.parse(w.localStorage.getItem('inventar-scan-v1')).codes.length, 1251);
    // Изнесеният текст е ЦЕЛИЯТ списък (полето се попълва при докосване).
    d.getElementById('out').dispatchEvent(new w.Event('focus'));
    const lines = d.getElementById('out').value.split('\n');
    assert.equal(lines.length, 1252);
    assert.equal(lines[1], '100001');
    assert.equal(lines[1251], '777777');
    // Повторен номер сменя само брояча — списъкът не се пипа.
    man.value = '100005';
    d.getElementById('addBtn').click();
    assert.equal(d.getElementById('dupCnt').textContent, '1');
    assert.strictEqual(ul.children[1], keep);
    // „Покажи всички“ — целият списък, и махането на стар номер работи по него.
    d.getElementById('moreBtn').click();
    assert.equal(ul.children.length, 1251);
    const oldest = ul.lastElementChild.querySelector('.x');
    assert.equal(oldest.getAttribute('aria-label'), 'Махни 100001');
    oldest.click();
    assert.equal(d.getElementById('cnt').textContent, '1250');
    assert.equal(JSON.parse(w.localStorage.getItem('inventar-scan-v1')).codes[0], '100002');
  } finally { w.close(); }
});
