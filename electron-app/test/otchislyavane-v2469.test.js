'use strict';
/* v2.4.69 — четиридесет и четвърти кръг, област ОТЧИСЛЯВАНЕ, ИНВЕНТАРИЗАЦИЯ, ТЕЛЕФОН.
   =====================================================================
   По един (или повече) тест на всяка поправена находка. Всеки твърди онова,
   което БИБЛИОТЕКАРКАТА вижда — сметката на читателя след връщане на гишето,
   реда в дневника на сканиранията, текста на разпечатания протокол, списъка на
   телефона, съобщението след утвърждаване — и е проверен с връщане на
   поправката назад: без нея пада.

   О1  Анулиран акт по т. 5 след платена забава: връщането начисляваше забавата
       втори път за същите дни.
   О2  Вносът от телефона делеше „6 102“ на „6“ и „102“.
   О3  Изгубен документ, сканиран при инвентаризация, оставаше „изгубен“ без дума.
   О4  Представителният протокол не съвпадаше с прозореца; „допустими загуби за
       проверен фонд от <обхвата>“.
   О5  Страницата за телефон — камера, цели за пръст, iPhone без Enter, файл .txt,
       дата на списъка, дата в името на файла по UTC.
   О6  Дневникът се трие след внос; „1 документ са отчислени“ без номер на акта;
       датата на анулиране „2026-09-26“.
   К2  Инвентаризацията и вносът не насрочваха запис на онлайн каталога. */
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
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + res.error); return res.data; };
const bgD = (iso) => iso.split('-').reverse().join('.');

function mkBook(inv, o = {}) {
  const id = Number(h.db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, status_date, department)
    VALUES (?, ?, 'Автор', ?, ?, ?, ?, ?)`)
    .run(inv, o.title || ('Книга ' + inv), o.price == null ? 10 : o.price, o.register_date || E.addDays(T, -400),
      o.status || 'наличен', T, o.department || null).lastInsertRowid);
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
  return id;
}
function mkReader(name, card) {
  return Number(h.db.prepare(`INSERT INTO readers (name, card_no, category, status, gdpr_consent, registered_at)
    VALUES (?, ?, 'възрастен', 'активен', 1, ?)`).run(name, card, E.addDays(T, -500)).lastInsertRowid);
}
async function nextNo() { return ok(await h.api.deaccessionActs.nextNo(Y), 'следващ номер'); }
async function startSess(department) {
  return ok(await h.api.inventorySessions.start({
    date: T, scope: 'отдел ' + department, department,
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка', order_no: '9', no: null
  }), 'започване на инвентаризация');
}
async function lostByReader(bookId, readerId, amount) {
  const lid = ok(await h.api.loans.checkout({ reader_id: readerId, book_id: bookId, date_out: T }), 'заемане');
  ok(await h.api.loans.markLost({ id: lid, resolution: 'обезщетение', amount, date: T }), 'изгубен');
  return lid;
}

/* ==================================================================
   О1. Анулиран акт по т. 5 след платена забава — връщането не я начислява пак
   ================================================================== */
test('О1 — платената забава от анулиран акт по т. 5 не се начислява втори път при връщането', async () => {
  h.db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const rid = mkReader('Петрова, Мария', 'O1-1001');
  const b = mkBook(46801, { title: 'Просрочена книга', price: 6 });
  const due = E.addDays(T, -120);
  const lid = Number(h.db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(rid, b, E.addDays(T, -150), due).lastInsertRowid);

  const actId = ok(await h.api.deaccessionActs.create({ act: {
    date: T, no: await nextNo(), reason_code: 5, reason_text: 'Повредени или невърнати от ползватели',
    disposal: 'унищожени', committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
  }, bookIds: [b] }), 'акт по т. 5');
  const actFine = q('SELECT deaccession_fine AS f FROM loans WHERE id = ?', lid).f;
  assert.ok(actFine > 0, 'контролно: актът е начислил забава');

  // Читателят плаща ВСИЧКО, после комисията анулира акта — през екрана.
  const bal = ok(await h.api.account.get(rid), 'сметка').balance;
  ok(await h.api.account.pay({ reader_id: rid, amount: bal, note: 'пълно' }), 'плащане');
  await h.go('acts');
  await h.window.openAct(actId); await h.settle();
  await h.clickButton('Анулирай акта', '#modal');
  h.type('#revF [name=reason]', 'читателят донесе книгата');
  const n = h.toasts.length;
  await h.clickButton('Анулирай акта', '#modal');
  const msg = h.toastsSince(n).map(t => t.msg).join(' | ');
  assert.match(msg, /Забавата до деня на акта вече е начислена и платена, затова не се начислява втори път/, msg);
  assert.ok(msg.includes('падежът е преместен от ' + bgD(due) + ' г. на ' + bgD(T) + ' г.'), msg);

  // „Просрочени“ не иска нищо — забавата до днес е платена.
  const row = ok(await h.api.loans.overdue(), 'просрочени').find(x => x.id === lid);
  assert.ok(!row || Number(row.fine) === 0, 'екранът „Просрочени“ не иска платеното: ' + JSON.stringify(row));

  // Книгата се връща на гишето — нищо ново не се начислява.
  const ret = ok(await h.api.loans.return({ id: lid, date_in: T }), 'връщане');
  assert.equal(ret.fineNow, 0, 'връщането не начислява втори път забавата за същите дни');
  assert.equal(ok(await h.api.account.get(rid), 'сметка').balance, 0, 'читателят не дължи нищо');
  const fines = all("SELECT amount FROM account_lines WHERE reader_id = ? AND kind = 'начисление' AND type = 'забава'", rid);
  assert.equal(fines.length, 1, 'в сметката има ЕДНО начисление за забава: ' + JSON.stringify(fines));
  assert.ok(all("SELECT detail FROM audit_log WHERE action = 'Анулиране на акт' ORDER BY id DESC LIMIT 1")[0]
    .detail.includes('падеж ' + bgD(due) + ' г. → ' + bgD(T) + ' г.'), 'истинският падеж остава в следата');
});

test('О1 — неплатената забава пада заедно с акта и връщането я смята за целия период (както досега)', async () => {
  const rid = mkReader('Неплатил Неплатилов', 'O1-1002');
  const b = mkBook(46802, { price: 6 });
  const due = E.addDays(T, -60);
  const lid = Number(h.db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(rid, b, E.addDays(T, -90), due).lastInsertRowid);
  const actId = ok(await h.api.deaccessionActs.create({ act: {
    date: T, no: await nextNo(), reason_code: 5, reason_text: 'Повредени или невърнати от ползватели',
    disposal: 'унищожени', committee1: 'А', committee2: 'Б', committee3: 'В'
  }, bookIds: [b] }), 'акт');
  const r = ok(await h.api.deaccessionActs.revoke(actId, { reason: 'грешка' }), 'анулиране');
  assert.equal((r.dueMoved || []).length, 0);
  assert.equal(q('SELECT date_due FROM loans WHERE id = ?', lid).date_due, due, 'падежът не се пипа');
  const ret = ok(await h.api.loans.return({ id: lid, date_in: T }), 'връщане');
  assert.ok(ret.fineNow > 0, 'цялата забава се начислява при връщането');
  assert.equal(all("SELECT 1 FROM account_lines WHERE reader_id = ? AND type = 'забава'", rid).length, 1);
});

/* ==================================================================
   О2. Един ред = един код
   ================================================================== */
test('О2 — „6 102“ от телефона не става инв. № 6 и инв. № 102; редът се изброява за ръчно въвеждане', async () => {
  const dep = 'О2-отдел';
  const b6 = mkBook(46806, { department: dep });
  const b102 = mkBook(46810, { department: dep });
  const b6102 = mkBook(46812, { department: dep });
  const sid = await startSess(dep);
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  await h.clickButton('📱 Въведи сканирания от телефон', '#view');
  h.type('#scanPaste', '# Инвентаризация — списък започнат на ' + bgD(T) + ' г., 2 номера\n46806 46810\n46812\n');
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  const call = h.stats.calls.filter(c => c.channel === 'inventorySessions:importScans').pop();
  assert.equal(JSON.stringify(call.args[0].codes), JSON.stringify(['46806 46810', '46812']),
    'екранът праща по един ред — заглавният ред отпада');
  const scanned = all('SELECT book_id FROM inventory_session_scans WHERE session_id = ?', sid).map(r => r.book_id);
  assert.deepEqual(scanned, [b6102], 'влиза само редът с един номер');
  assert.ok(!scanned.includes(b6) && !scanned.includes(b102), 'редът с интервал не се дели на два чужди документа');
  assert.match(h.modal(), /1 ред не е внесен.*„46806 46810“/, h.modal());
  await h.clickButton('Разбрах', '#modal');
});

test('О2 — правилото е и в обработчика: код с интервал/запетая вътре не се гадае', async () => {
  const dep = 'О2б-отдел';
  mkBook(46820, { department: dep });
  const sid = await startSess(dep);
  const r = ok(await h.api.inventorySessions.importScans({ sessionId: sid, codes: ['6 102', '46820', '7,8', '# заглавие'] }), 'внос');
  assert.equal(r.added, 1);
  assert.deepEqual(r.malformed.map(m => m.code), ['6 102', '7,8']);
  assert.deepEqual(r.unknown, [], 'нищо не е разделено на „непознати“ парчета');
});

/* ==================================================================
   О3. Изгубен документ, сканиран на рафта
   ================================================================== */
test('О3 — сканиран изгубен документ: предупреждение с читателя и „Документът се намери“, не зелен ред', async () => {
  const dep = 'О3-отдел';
  const rid = mkReader('Загубова, Анна', 'O3-77');
  const b = mkBook(46830, { department: dep, title: 'Изгубената' });
  await lostByReader(b, rid, 21);
  const sid = await startSess(dep);
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  await h.scan('#ivScan', '46830');
  const line = h.document.querySelector('#ivLog .scanlog');
  assert.ok(line.classList.contains('warn'), 'редът не е зелен');
  const t = h.text(line);
  assert.match(t, /ИЗГУБЕН/);
  assert.match(t, /изгубен от читател Загубова, Анна \(карта O3-77\)/i, t);
  assert.match(t, /„Документът се намери“ в „Просрочени“ → „Изгубени и невърнати документи“/);
  assert.match(t, /обезщетението 21\.00 € стои в сметката на читателя/);
  assert.ok(q('SELECT 1 FROM inventory_session_scans WHERE session_id = ? AND book_id = ?', sid, b), 'проверен е — брои се в протокола');
  assert.equal(q('SELECT status FROM books WHERE id = ?', b).status, 'изгубен', 'парите се уреждат на гишето, не тук');
});

test('О3 — същото при вноса от телефона: изгубеният се изброява поименно', async () => {
  const dep = 'О3б-отдел';
  const rid = mkReader('Телефонова, Вера', 'O3-88');
  const b = mkBook(46831, { department: dep });
  await lostByReader(b, rid, 12);
  const sid = await startSess(dep);
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  await h.clickButton('📱 Въведи сканирания от телефон', '#view');
  h.type('#scanPaste', '46831');
  const n = h.toasts.length;
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  assert.ok(h.toastsSince(n).some(x => x.type === 'warn' && /изгубени, намерени на рафта 1/.test(x.msg)), JSON.stringify(h.toastsSince(n)));
  assert.match(h.modal(), /отбелязан като ИЗГУБЕН от читател Телефонова, Вера \(карта O3-88\)/);
  assert.match(h.modal(), /Документът се намери/);
  await h.clickButton('Разбрах', '#modal');
  await h.settle();
  assert.match(h.text('#ivLog'), /ИЗГУБЕН.*Телефонова, Вера/, 'и в дневника на сканиранията');
});

/* ==================================================================
   О4. Прозорецът и протоколът казват едно и също
   ================================================================== */
async function closeViaScreen(sid, mode) {
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  await h.clickButton('Приключи и състави протокол', '#view');
  h.$('#modal input[name=ivMode][value=' + mode + ']').checked = true;
  await h.clickButton('Приключи и състави протокол', '#modal');
  await h.settle();
  const win = h.modal();
  await h.clickButton('Затвори', '#modal');
  await h.window.printInventProtocol(sid); await h.settle();
  const pr = h.printed();
  h.window.ppClose();
  return { win, pr };
}
test('О4 — изгубените: при представителна проверка в нито едно, при пълна — и в прозореца, и в протокола', async () => {
  const rid = mkReader('Протоколова, Ина', 'O4-1');
  for (const [dep, base] of [['О4р-отдел', 46840], ['О4п-отдел', 46850]]) {
    mkBook(base, { department: dep });
    await lostByReader(mkBook(base + 1, { department: dep }), rid, 5);
    mkBook(base + 2, { department: dep });
  }
  // Представителна: сканиран е един от трите.
  let sid = await startSess('О4р-отдел');
  ok(await h.api.inventorySessions.scan({ sessionId: sid, code: '46840' }), 'сканиране');
  let r = await closeViaScreen(sid, 'representative');
  assert.doesNotMatch(r.win, /изгубен/i, 'прозорецът не обявява число, което протоколът няма: ' + r.win);
  assert.doesNotMatch(r.pr, /Изгубени от ползватели/);
  // [\d,]+ — българска десетична запетая от сглобяването (Е10, lossFmt).
  assert.match(r.pr, /Допустими естествени загуби \(чл\. 41\):\s*[\d,]+ документа за фонда в обхвата на проверката \(3 документа\)\./);
  assert.doesNotMatch(r.pr, /проверен фонд/);
  // Пълна: и двете казват „1 изгубен“.
  sid = await startSess('О4п-отдел');
  ok(await h.api.inventorySessions.scan({ sessionId: sid, code: '46850' }), 'сканиране');
  r = await closeViaScreen(sid, 'full');
  assert.match(r.win, /Един документ от обхвата е изгубен от ползвател/);
  assert.match(r.pr, /Изгубени от ползватели, установени преди проверката:\s*1/);
});

/* ==================================================================
   О6. Дневникът оцелява при внос; съобщенията
   ================================================================== */
test('О6 — вносът от телефона не трие дневника на сканиранията', async () => {
  const dep = 'О6-отдел';
  mkBook(46860, { department: dep, title: 'Сканирана на компютъра' });
  mkBook(46861, { department: dep });
  const sid = await startSess(dep);
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  await h.scan('#ivScan', '46860');
  await h.scan('#ivScan', '99999999');
  await h.clickButton('📱 Въведи сканирания от телефон', '#view');
  h.type('#scanPaste', '46861');
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  const log = h.text('#ivLog');
  assert.match(log, /46860 — Сканирана на компютъра/, 'сканираното на компютъра остава: ' + log);
  assert.match(log, /Непознат баркод\/инв\. № 99999999/, 'червените редове остават за преглед');
  assert.match(log, /📱 Внос от телефон: Въведени 1/, 'вносът също влиза в дневника');
  assert.equal(h.text('#ivFound'), '2');
});

test('О6 — „Акт № N/гггг е утвърден и 1 документ е отчислен“; датата на анулиране — по български', async () => {
  const b = mkBook(46870);
  const dr = ok(await h.api.deaccessionActs.saveDraft({ draft: { date: T, reason_code: 1, reason_text: 'Остарели по съдържание',
    disposal: 'предадени', committee1: 'А', committee2: 'Б', committee3: 'В' }, bookIds: [b] }), 'проект');
  await h.go('acts');
  await h.window.openDraft(dr); await h.settle(); await h.sleep(120);
  h.hooks.confirmAnswer = true;
  const n = h.toasts.length;
  await h.clickButton('Утвърди като акт и отчисли', '#modal');
  await h.settle();
  const act = q('SELECT id, no, year FROM deaccession_acts ORDER BY id DESC LIMIT 1');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Акт № ' + act.no + '/' + act.year + ' е утвърден и 1 документ е отчислен.'),
    JSON.stringify(h.toastsSince(n)));
  ok(await h.api.deaccessionActs.revoke(act.id, { reason: 'проба' }), 'анулиране');
  await h.go('acts');
  const row = Array.from(h.document.querySelectorAll('#view table tbody tr')).find(tr => tr.textContent.includes(act.no + ' / ' + act.year));
  const t = h.text(row);
  assert.ok(t.includes('АНУЛИРАН на ' + bgD(T) + ' г.'), t);
  assert.doesNotMatch(t, /\d{4}-\d{2}-\d{2}/, 'никаква ISO дата в регистъра');
  const again = await h.api.deaccessionActs.revoke(act.id, { reason: 'пак' });
  assert.match(again.error, new RegExp('вече е анулиран на ' + bgD(T).replace(/\./g, '\\.') + ' г\\.'));
});

/* ==================================================================
   О5. Страницата за телефон (в jsdom, както я получава телефонът)
   ================================================================== */
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile-template.html'), 'utf8');
/* Всеки отворен „телефон“ се затваря след теста: жива камера върти setInterval и
   без window.close() процесът на теста не свършва, ако твърдението падне преди
   „Спри камерата“. */
const phones = [];
test.afterEach(() => {
  while (phones.length) {
    try { phones.pop().close(); } catch (e) { /* вече затворен — нищо не зависи от това */ }
  }
});
function openPhone({ url = 'https://example.org/skener.html', live = false, saved = null, now = null } = {}) {
  const state = { detected: [], clip: null, downloads: [] };
  const vc = new VirtualConsole();   // тихо: AudioContext, video.play и навигацията не са в jsdom
  const dom = new JSDOM(PAGE.replace(/__SLUG__/g, 'biblioteka'), {
    runScripts: 'dangerously', url, virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(w) {
      w.BarcodeDetector = function () { return { detect: async () => state.detected }; };
      w.createImageBitmap = async () => ({ close() {} });
      w.navigator.mediaDevices = { getUserMedia: async () => {
        if (!live) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        return { getTracks: () => [] };
      } };
      Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { state.clip = t; } } });
      w.URL.createObjectURL = () => 'blob:x';
      w.HTMLAnchorElement.prototype.click = function () { state.downloads.push(this.download); };
      w.HTMLMediaElement.prototype.play = async function () {};
      if (now != null) {
        const D = w.Date;
        w.Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
      }
      try { w.localStorage.clear(); if (saved) w.localStorage.setItem('inventar-scan-v1', JSON.stringify(saved)); }
      catch (e) { /* file:// в jsdom няма localStorage — страницата го понася */ }
    }
  });
  phones.push(dom.window);
  return { w: dom.window, d: dom.window.document, state };
}
const tick = (ms) => new Promise(r => setTimeout(r, ms || 20));

test('О5/О2 — телефонът: „Добави“ без Enter, интервалите се махат, запетаята се отказва на глас', async () => {
  const { d } = openPhone();
  const man = d.getElementById('manual');
  man.value = '6 102';
  d.getElementById('addBtn').click();
  assert.deepEqual(d.getElementById('out').value.split('\n').slice(1), ['6102'], 'добавено без Enter, като един номер');
  assert.match(d.getElementById('manualMsg').textContent, /Добавен е 6102 \(без интервалите\)/);
  man.value = '7,8';
  d.getElementById('addBtn').click();
  assert.equal(d.getElementById('cnt').textContent, '1', 'запетаята не се гадае');
  assert.equal(man.value, '7,8', 'набраното остава в полето за поправка');
  assert.match(d.getElementById('manualMsg').textContent, /съдържа запетая — въведете по един номер наведнъж/);
});

test('О5 — непотвърденият номер влиза в „Копирай списъка“ и в „Запиши файл“; списъкът носи датата', async () => {
  const { d, state } = openPhone();
  const man = d.getElementById('manual');
  man.value = '1024'; d.getElementById('addBtn').click();
  man.value = '1025';                                // набран, без „Добави“
  d.getElementById('copyBtn').click();
  await tick();
  const lines = state.clip.split('\n');
  assert.deepEqual(lines.slice(1), ['1024', '1025'], 'последният набран номер не се губи');
  assert.equal(lines[0], '# Инвентаризация — списък започнат на ' + bgD(T) + ' г., 2 номера');
  assert.match(d.getElementById('manualMsg').textContent, /Номерът 1025 от полето е добавен в списъка/);
  assert.match(d.getElementById('since').textContent, new RegExp('започнат на ' + bgD(T).replace(/\./g, '\\.')));
});

test('О5 — името на файла е по МЕСТНО време (00:30 ч. в София е вече новият ден)', async () => {
  const now = Date.UTC(2026, 8, 25, 21, 30);   // 26.09.2026 00:30 ч. EEST
  const { d, state } = openPhone({ now });
  d.getElementById('manual').value = '55';
  d.getElementById('addBtn').click();
  d.getElementById('fileBtn').click();
  assert.deepEqual(state.downloads, ['inventarizaciya-biblioteka-2026-09-26.txt']);
});

test('О5 — стар списък в телефона се обявява като стар', async () => {
  const { d } = openPhone({ saved: { codes: ['5', '6'], dups: 0, started: '2026-03-20' } });
  const old = d.getElementById('oldList');
  assert.notEqual(old.style.display, 'none');
  assert.match(old.textContent, /Този списък не е от днес — започнат е на 20\.03\.2026 г\..*„Изчисти“/);
  d.defaultView.confirm = () => true;
  d.getElementById('clearBtn').click();
  assert.equal(old.style.display, 'none', 'след „Изчисти“ предупреждението изчезва');
});

test('О5 — камерата тръгва: червената бележка изчезва, броячът и „Спри камерата“ остават; „×“ ≥ 44 px', async () => {
  const { w, d, state } = openPhone({ url: 'file:///x/skener.html', live: true });
  assert.notEqual(d.getElementById('nocam').style.display, 'none', 'контролно: от файл бележката е показана');
  d.getElementById('startBtn').click();
  await tick(50);
  assert.equal(d.getElementById('nocam').style.display, 'none', 'бележката „няма да тръгне“ вече не е вярна');
  assert.ok(d.body.classList.contains('live'));
  assert.equal(w.getComputedStyle(d.getElementById('hint')).display, 'none', 'подсказката се прибира, за да остане броячът на екрана');
  assert.equal(d.getElementById('stopBtn').style.display, 'inline-block');
  assert.match(PAGE, /#cam\{[^}]*max-height:40vh/, 'видеото не заема целия екран');
  state.detected = [{ rawValue: '121' }];
  await tick(420);
  assert.equal(d.getElementById('cnt').textContent, '1', 'камерата чете');
  const x = d.querySelector('#list li .x');
  assert.equal(w.getComputedStyle(x).minWidth, '44px');
  assert.equal(w.getComputedStyle(x).minHeight, '44px');
  d.getElementById('stopBtn').click();
  assert.ok(!d.body.classList.contains('live'));
});

test('О5 — програмата внася файла .txt от телефона и пита за списък от друг ден', async () => {
  const dep = 'О5-отдел';
  mkBook(46880, { department: dep });
  mkBook(46881, { department: dep });
  const sid = await startSess(dep);
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  await h.clickButton('📱 Въведи сканирания от телефон', '#view');
  const inp = h.$('#scanFile');
  assert.equal(inp.getAttribute('accept'), '.txt,text/plain');
  const file = new h.window.File(['# Инвентаризация — списък започнат на 20.03.2026 г., 2 номера\n46880\n46881\n'],
    'inventarizaciya-biblioteka-2026-03-20.txt', { type: 'text/plain' });
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  h.fire(inp, 'change');
  await h.waitFor(() => /46881/.test(h.$('#scanPaste').value), 'файлът е прочетен');
  h.hooks.confirmAnswer = false;
  const c0 = h.hooks.confirms.length;
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  assert.match(h.hooks.confirms[c0] || '', /Списъкът от телефона е започнат на 20\.03\.2026 г\., а тази проверка е от/);
  assert.equal(q('SELECT COUNT(*) AS n FROM inventory_session_scans WHERE session_id = ?', sid).n, 0, '„Отказ“ не внася');
  h.hooks.confirmAnswer = true;
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  assert.equal(q('SELECT COUNT(*) AS n FROM inventory_session_scans WHERE session_id = ?', sid).n, 2);
});

/* ==================================================================
   К2. Онлайн каталогът се насрочва и от инвентаризацията
   ================================================================== */
function fakeIpcMain() {
  const m = new Map();
  return { handle: (c, fn) => m.set(c, fn), invoke: (c, ...a) => m.get(c)({}, ...a) };
}
const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* временна папка — нищо не зависи от това */ } } });
function unitSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-k2-')); tmpDirs.push(dir);
  const db = new Database(path.join(dir, 'library.db'));
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const { pctRequired, naturalLoss, normalizeScanCode } = require('./helpers/prod-values.js');
  const writes = [];
  const deps = {
    getDb: () => db, run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: () => {}, pctRequired, naturalLoss, normalizeScanCode, scheduleCatalogWrite: (k) => writes.push(k || 'fund'),
    dialog: {}, getMainWindow: () => ({}), fs, path
  };
  const ipc = fakeIpcMain();
  require('../handlers/inventory-sessions')(ipc, deps);
  require('../handlers/mobile')(ipc, deps);
  const add = (inv, status) => {
    const id = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (?, 'К', ?)").run(inv, status).lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
    return id;
  };
  return { db, ipc, writes, add };
}
test('К2 — сканиране „липсващ“ → „наличен“, внос от телефона и приключена пълна проверка насрочват запис на каталога', async () => {
  const { ipc, writes, add } = unitSetup();
  add(1, 'липсващ'); add(2, 'липсващ'); add(3, 'наличен'); add(4, 'наличен');
  const st = await ipc.invoke('inventorySessions:start', { date: T, scope: 'всичко', department: null,
    committee1: 'А', committee2: 'Б', committee3: 'В', order_no: '1', no: null });
  assert.equal(st.ok, true, st.error);
  const sid = st.data;
  assert.equal((await ipc.invoke('inventorySessions:scan', { sessionId: sid, code: '3' })).ok, true);
  assert.equal(writes.length, 0, 'наличен → наличен не мени нищо на сайта');
  assert.equal((await ipc.invoke('inventorySessions:scan', { sessionId: sid, code: '1' })).ok, true);
  assert.equal(writes.length, 1, 'липсващ → наличен се публикува');
  assert.equal((await ipc.invoke('inventorySessions:importScans', { sessionId: sid, codes: ['2'] })).data.added, 1);
  assert.equal(writes.length, 2, 'вносът от телефона също');
  const r = await ipc.invoke('inventorySessions:close', { sessionId: sid, mode: 'full' });
  assert.equal(r.ok, true, r.error);
  assert.equal(writes.length, 3, 'пълната проверка направи № 4 „липсващ“ — сайтът трябва да го разбере');
});
