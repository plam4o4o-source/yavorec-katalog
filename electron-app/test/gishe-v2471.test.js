'use strict';
/* v2.4.71 — кръг 45 (пълен тест на v2.4.70), област ГИШЕ И ЧИТАТЕЛИ.
   =====================================================================
   По един (или повече) тест на всяка находка от група „Ч“ (Ч1–Ч15) и на
   частите на гишето от М4, М8 и Д3. Всеки твърди онова, което БИБЛИОТЕКАРКАТА
   вижда — дали книгата остава у читателя след сканирана карта, сумата в писмото
   по чл. 43, текста на известието, документа на листа, реда в одитната следа,
   реда в историята на записванията — а не вътрешната форма на данните. Всеки е
   проверен с връщане на поправката назад: без нея пада.
   Т1 (scenario-zaemane т. 9 и т. 12 в определени дни от седмицата) се заковава в
   самия test/scenario-zaemane.test.js — проверен с подменен часовник. */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
const Y = T.slice(0, 4);
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + res.error); return res.data; };
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
const lastAudit = (action) => q('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC', action);

let invSeq = 700;
function mkBook(o = {}) {
  const inv = o.inv || ++invSeq;
  const id = Number(h.db.prepare(`INSERT INTO books (inv_number, title, author, barcode, price, status, register_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(inv, o.title || ('Книга ' + inv), 'Автор, А.', o.barcode === undefined ? ('BC' + inv) : o.barcode,
      10, o.status || 'наличен', '2026-01-05').lastInsertRowid);
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
  return { id, inv, code: o.barcode === undefined ? 'BC' + inv : String(inv) };
}
let cardSeq = 7000;
function mkReader(name, o = {}) {
  const card = o.card || String(++cardSeq);
  const id = Number(h.db.prepare(`INSERT INTO readers (name, card_no, category, status, gdpr_consent, gdpr_consent_date,
      registered_at, email, phone, egn) VALUES (?, ?, 'възрастен', ?, 1, '2026-01-02', ?, ?, ?, ?)`)
    .run(name, card, o.status || 'активен', o.registered_at || T, o.email || null, o.phone || null, o.egn || null).lastInsertRowid);
  return { id, card };
}
function mkLoan(readerId, bookId, out, due) {
  return Number(h.db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, out, due).lastInsertRowid);
}
/* Отговори на askConfirm (в тестовата среда минава през window.confirm). */
function answers(...seq) {
  const asked = [];
  h.window.confirm = (m) => { asked.push(String(m)); return seq.length ? seq.shift() : false; };
  return asked;
}
function restoreConfirm() { h.window.confirm = (m) => { h.hooks.confirms.push(String(m)); return h.hooks.confirmAnswer; }; }
async function desk(readerId) {
  await h.go('circ');
  h.window.eval("CIRC.mode='out'");
  h.window.selectCircReader(readerId);
  await h.settle();
  await h.waitFor(() => h.$('#bScan'), 'полето за документи');
}
async function returnByScan(code) {
  await h.go('circ');
  h.window.eval("CIRC.mode='in'");
  await h.window.renderCirc();
  await h.waitFor(() => h.$('#inScan'), 'полето за връщане');
  const n = h.toasts.length;
  await h.scan('#inScan', code);
  return { log: h.text('#inLog'), toasts: h.toastsSince(n) };
}

test('подготовка: ставка 0,10 €/ден, всички дни работни', async () => {
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  h.db.prepare(`UPDATE settings SET fine_per_day = 0.10, loan_days = 14, max_books = 5, extensions_count = 5,
    extension_days = 14, lib_name = 'Библиотека „Проба“', librarian = 'Мария Иванова', place = 'с. Проба' WHERE id = 1`).run();
  await h.window.loadSettingsCache();
  assert.equal(q('SELECT work_days FROM settings').work_days, '0,1,2,3,4,5,6');
});

/* ==================================================================
   Ч1. Читателска карта, сканирана в „Връщане“
   ================================================================== */
test('Ч1 — карта на читател в полето „Връщане“ не връща чужда книга', async () => {
  const first = mkReader('Първи Читател', { card: '951' });
  mkReader('Пети Читател', { card: '952' });
  const b = mkBook({ inv: 952, barcode: null });   // инв. № 952 = картата на „Пети Читател“
  const loan = mkLoan(first.id, b.id, E.addDays(T, -3), E.addDays(T, 11));
  // И карта, и документ: питаме — при „Не — това е карта“ нищо не се записва.
  const asked = answers(false);
  const r1 = await returnByScan('952');
  restoreConfirm();
  assert.equal(asked.length, 1, 'пита „карта или документ?“');
  assert.match(asked[0], /едновременно читателската карта на Пети Читател и инв\. № 952/);
  assert.equal(q('SELECT date_in FROM loans WHERE id = ?', loan).date_in, null, 'книгата остава у Първи Читател');
  assert.match(r1.log, /картата на Пети Читател; нищо не е върнато/);
  // Само карта (няма документ с този код): нищо не се връща, гишето предлага заемане.
  const onlyCard = mkReader('Само Карта', { card: 'K-951' });
  const r2 = await returnByScan('K-951');
  assert.match(r2.log, /читателската карта на Само Карта\s*, не документ — нищо не е върнато/);
  assert.ok(h.button('Заемане за Само Карта', '#inLog'), 'бутон към заемане за читателя');
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ?', onlyCard.id).n, 0);
  // Документът — с потвърждение — се приема.
  answers(true);
  await returnByScan('952');
  restoreConfirm();
  assert.equal(q('SELECT date_in FROM loans WHERE id = ?', loan).date_in, T);
});

/* ==================================================================
   Ч2. Опростена („✕“) забава не се връща в писмото, SMS-а и журнала
   ================================================================== */
test('Ч2 — изтритият ред „забава“ намалява и сумата по заемането: писмото иска само новата забава', async () => {
  const r = mkReader('Мария Опростена', { email: 'maria@example.bg', phone: '0888 1' });
  const b = mkBook();
  const loan = mkLoan(r.id, b.id, E.addDays(T, -30), E.addDays(T, -2));
  const ext = ok(await h.api.loans.extend({ id: loan }), 'продължение на просрочено');
  assert.equal(ext.fine, 0.2, 'начислени 2 дни × 0,10 €');
  const line = q("SELECT * FROM account_lines WHERE reader_id = ? AND type = 'забава'", r.id);
  assert.ok(line, 'редът „забава“ е в сметката');
  // Опрощаване от картона: „✕“ на реда.
  await h.go('readers');
  await h.window.accountModal(r.id); await h.settle();
  const asked = answers(true);
  const n = h.toasts.length;
  await h.window.deleteAccountLine(r.id, line.id); await h.settle();
  restoreConfirm();
  assert.match(asked[0], /Сумата се маха и от заемането/);
  assert.ok(h.toastsSince(n).some(t => /Забавата по заемането на инв\. № \d+ е намалена от 0\.20 € .* на 0\.00 €/.test(t.msg)),
    JSON.stringify(h.toastsSince(n)));
  h.window.closeModal();
  assert.equal(q('SELECT fine FROM loans WHERE id = ?', loan).fine, 0, 'loans.fine е намалено със същото');
  assert.match(lastAudit('Изтрит ред от сметката').detail, /забавата по заемането на инв\. № \d+ е намалена от 0\.20 € на 0\.00 €/);
  // Времето минава: срокът пак е изтекъл преди 4 дни → нова забава 0,40 €.
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(E.addDays(T, -4), loan);
  const letter = ok(await h.api.loans.overdueByReader(), 'писма').find(x => x.reader_id === r.id);
  assert.equal(letter.fine, 0.4, 'писмото по чл. 43 иска 0,40 €, не 0,60 €');
  const rem = ok(await h.api.loans.reminders(), 'напомняния').find(x => x.reader_id === r.id);
  assert.match(rem.sms, /обезщетение 0\.40 €/);
  const over = ok(await h.api.loans.overdue(), 'просрочени').find(x => x.id === loan);
  assert.equal(over.fine, 0.4);
  // И журналът при връщане: 0,40 €, без опростените 0,20 €.
  const back = await returnByScan(b.code);
  assert.match(back.log, rx('Забава 4 дни · обезщетение ' + E.mny(0.4)));
  assert.equal(q('SELECT fine FROM loans WHERE id = ?', loan).fine, 0.4);
});

/* ==================================================================
   Ч3 (връзката с Ч2): годишният отчет е на друг агент — тук само това, че
   след опрощаване И loans.fine, И сметката казват едно и също.
   Ч4. Затворен ден на падежа
   ================================================================== */
test('Ч4 — забавата тръгва от първия работен ден след затворен падеж', async () => {
  /* Денят D и двата след него трябва да са РАБОТНИ по седмичния график, иначе
     „първият отворен ден“ не е D+1 и числата зависят от деня от седмицата (при
     работни дни вт–сб и D в неделя тестът падаше в сряда — същото като Т1).
     Затова D се търси назад от T−10, докато D, D+1 и D+2 не са работни. */
  let D = E.addDays(T, -10);
  const workDay = (d) => E.nextWorkDay(h.db, d) === d;
  while (!(workDay(D) && workDay(E.addDays(D, 1)) && workDay(E.addDays(D, 2)))) D = E.addDays(D, -1);
  ok(await h.api.calendar.addClosed({ date: D, reason: 'ремонт' }), 'затворен ден без падежи');
  // Заварено заемане с падеж точно в затворения ден (отпреди тази версия).
  const r = mkReader('Затворен Падеж');
  const b = mkBook();
  const loan = mkLoan(r.id, b.id, E.addDays(D, -14), D);
  const res = ok(await h.api.loans.return({ id: loan, date_in: E.addDays(D, 1) }), 'връщане в първия отворен ден');
  assert.equal(res.daysLate, 0, 'първият отворен ден след затворен падеж не е забава');
  assert.equal(res.fine, 0);
  assert.equal(q('SELECT COUNT(*) AS n FROM account_lines WHERE reader_id = ?', r.id).n, 0, 'нищо не е начислено');
  // Ден по-късно — 1 ден забава (не 2).
  const loan2 = mkLoan(r.id, mkBook().id, E.addDays(D, -14), D);
  assert.equal(ok(await h.api.loans.return({ id: loan2, date_in: E.addDays(D, 2) }), 'връщане').daysLate, 1);
  ok(await h.api.calendar.removeClosed(D), 'махане');
});

test('Ч4 — затворен ден, обявен след заемането, мести падежа; „Просрочени“ и таблото не го броят', async () => {
  const r = mkReader('Вчерашен Падеж');
  const b = mkBook();
  const Dy = E.addDays(T, -1);
  const loan = mkLoan(r.id, b.id, E.addDays(T, -15), Dy);
  const before = ok(await h.api.dashboard.full(), 'табло').overdueCount;
  const res = ok(await h.api.calendar.addClosed({ date: Dy, reason: 'празник' }), 'затворен ден');
  assert.equal(res.moved, 1);
  assert.match(res.message, rx('падежът на 1 отворено заемане е преместен на първия работен ден (' + E.bgDate(Dy) + ' → ' + E.bgDate(T) + ')'));
  assert.equal(q('SELECT date_due FROM loans WHERE id = ?', loan).date_due, T);
  assert.match(lastAudit('Календар').detail, /преместен/);
  assert.ok(!ok(await h.api.loans.overdue(), 'просрочени').some(x => x.id === loan), 'не е в „Просрочени“');
  assert.ok(!ok(await h.api.loans.overdueByReader(), 'писма').some(x => x.reader_id === r.id), 'няма писмо по чл. 43');
  assert.equal(ok(await h.api.dashboard.full(), 'табло').overdueCount, before - 1, 'таблото не го брои');
  ok(await h.api.calendar.removeClosed(Dy), 'махане');
  assert.equal(q('SELECT date_due FROM loans WHERE id = ?', loan).date_due, T, 'срокът не се скъсява обратно');
  h.db.prepare('UPDATE loans SET date_in = ? WHERE id = ?').run(T, loan);
});

/* ==================================================================
   Ч5, Ч6, Ч10. Връщане: забавата се казва и при резервация; трите числа
   поотделно; сумите — кръгли до стотинка
   ================================================================== */
test('Ч5 — „Приеми“ на просрочена книга с резервация казва И заделянето, И забавата', async () => {
  const r = mkReader('Просрочил Резервирана');
  const w = mkReader('Чакащ Читател', { phone: '0888 2' });
  const b = mkBook();
  const loan = mkLoan(r.id, b.id, E.addDays(T, -20), E.addDays(T, -3));
  ok(await h.api.holds.add({ reader_id: w.id, code: b.code }), 'резервация');
  await desk(r.id);
  const n = h.toasts.length;
  await h.window.returnBook(loan); await h.settle();
  const ts = h.toastsSince(n).map(t => t.msg);
  assert.ok(ts.some(m => /📌 Заделена за Чакащ Читател/.test(m)), JSON.stringify(ts));
  assert.ok(ts.some(m => m.includes('Върната със забава 3 дни (' + E.mny(0.3) + ')')), 'забавата се казва: ' + JSON.stringify(ts));
});

test('Ч6 и Ч10 — „забава 4 дни“ носи 0,40 €, общото и по-ранното отделно; loans.fine е точно 0.6', async () => {
  const r = mkReader('Продължил Закъснял');
  const b = mkBook();
  const loan = mkLoan(r.id, b.id, E.addDays(T, -30), E.addDays(T, -2));
  assert.equal(ok(await h.api.loans.extend({ id: loan }), 'продължение').fine, 0.2);
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(E.addDays(T, -4), loan);
  const back = await returnByScan(b.code);
  // Видимият текст слага интервал след всеки <b>…</b> — затова „\s*,“.
  assert.match(back.log, new RegExp(rx('Забава 4 дни · обезщетение ' + E.mny(0.4) + ' (начислени сега); общо по заемането '
    + E.mny(0.6)).source + '\\s*' + rx(', от тях ' + E.mny(0.2) + ' начислени по-рано (при продължение)').source));
  assert.ok(back.toasts.some(t => t.msg.startsWith('Върната със забава 4 дни (' + E.mny(0.4) + ' начислени сега')), JSON.stringify(back.toasts));
  assert.match(lastAudit('Връщане').detail, /\(забава 4 дни\); начислени 0\.40 €; общо по заемането 0\.60 €/);
  // Ч10: сборът е закръглен — 0.2 + 0.4 в плаваща запетая е 0.6000000000000001.
  assert.equal(q('SELECT fine FROM loans WHERE id = ?', loan).fine, 0.6);
  // Същото по бутона „Приеми“.
  const r2 = mkReader('Приет С Бутон');
  const b2 = mkBook();
  const loan2 = mkLoan(r2.id, b2.id, E.addDays(T, -30), E.addDays(T, -2));
  ok(await h.api.loans.extend({ id: loan2 }), 'продължение');
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(E.addDays(T, -4), loan2);
  await desk(r2.id);
  const n = h.toasts.length;
  await h.window.returnBook(loan2); await h.settle();
  assert.ok(h.toastsSince(n).some(t => t.msg.includes(E.mny(0.4) + ' начислени сега; общо по заемането ' + E.mny(0.6))),
    JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT fine FROM loans WHERE id = ?', loan2).fine, 0.6);
});

/* ==================================================================
   Ч7, Ч13. Резервация: прекратен читател; изгубен документ
   ================================================================== */
test('Ч7 — резервация за читател с прекратена регистрация се отказва', async () => {
  const holder = mkReader('Държащ Книгата');
  const gone = mkReader('Прекратен Читател', { status: 'прекратен' });
  const b = mkBook();
  mkLoan(holder.id, b.id, E.addDays(T, -2), E.addDays(T, 12));
  const res = await h.api.holds.add({ reader_id: gone.id, code: b.code });
  assert.equal(res.ok, false);
  assert.match(res.error, /Регистрацията на Прекратен Читател е прекратена и резервация не се допуска/);
  assert.equal(q('SELECT COUNT(*) AS n FROM holds WHERE reader_id = ?', gone.id).n, 0);
  // Екранът го казва по-рано, в прозореца „Нова резервация“.
  await h.go('circ');
  await h.window.holdPrompt(gone.id); await h.settle();
  assert.match(h.modal(), /Регистрацията на Прекратен Читател е прекратена — резервация не се допуска/);
  h.window.closeModal();
});

test('Ч13 — резервация на изгубен документ казва „изгубен“, не „свободен“', async () => {
  const r = mkReader('Иска Изгубената');
  const b = mkBook({ status: 'изгубен' });
  const res = await h.api.holds.add({ reader_id: r.id, code: b.code });
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.error, /свободен/);
  assert.match(res.error, /отбелязан като изгубен\/невърнат .*„Документът се намери“/);
});

/* ==================================================================
   Ч8, Ч12. Сметката: квитанция само за плащане; анулиране с причина
   ================================================================== */
test('Ч8 — за начисление се печата „ИЗВЕСТИЕ ЗА НАЧИСЛЕНИЕ“, квитанция — само за плащане', async () => {
  const r = mkReader('Сметка Известие');
  const chg = ok(await h.api.account.charge({ reader_id: r.id, type: 'годишна такса', amount: 5, date: T }), 'начисление');
  const pay = ok(await h.api.account.pay({ reader_id: r.id, amount: 2, date: T }), 'плащане');
  await h.go('readers');
  await h.window.accountModal(r.id); await h.settle();
  const row = (id) => Array.from(h.document.querySelectorAll('#modal table.ledger tbody tr'))
    .find(tr => tr.querySelector(`button[onclick="printReceiptLine(${id})"]`));
  assert.equal(h.text(row(chg).querySelector(`button[onclick="printReceiptLine(${chg})"]`)), 'Известие');
  assert.equal(h.text(row(pay).querySelector(`button[onclick="printReceiptLine(${pay})"]`)), 'Квитанция');
  h.window.printReceiptLine(chg); await h.settle();
  const p = h.printed();
  assert.match(p, rx('ИЗВЕСТИЕ ЗА НАЧИСЛЕНИЕ № ' + chg));
  assert.match(p, rx('Дължима сума: ' + E.mny(5)));
  assert.doesNotMatch(p, /КВИТАНЦИЯ|Получил/);
  if (h.window.ppClose) h.window.ppClose();
  h.window.printReceiptLine(pay); await h.settle();
  assert.match(h.printed(), rx('КВИТАНЦИЯ № ' + pay));
  if (h.window.ppClose) h.window.ppClose();
  h.window.closeModal();
});

test('Ч12 — „✕“ на плащане с квитанция иска причина; следата носи номера на квитанцията', async () => {
  const r = mkReader('Анулирано Плащане');
  const pay = ok(await h.api.account.pay({ reader_id: r.id, amount: 1.25, date: T }), 'плащане');
  const bare = await h.api.account.deleteLine(pay);
  assert.equal(bare.ok, false, 'без причина — отказ');
  assert.match(bare.error, rx('квитанция № ' + pay + ' — анулирането ѝ изисква причина'));
  assert.ok(q('SELECT 1 FROM account_lines WHERE id = ?', pay), 'плащането е на мястото си');
  // През екрана: прозорец за причина.
  await h.go('readers');
  await h.window.accountModal(r.id); await h.settle();
  const n = h.toasts.length;
  const pr = h.window.deleteAccountLine(r.id, pay);
  await h.waitFor(() => h.$('#askTextF [name=v]'), 'прозореца за причина');
  assert.match(h.text('#modal2'), rx('Квитанция № ' + pay + ' за ' + E.mny(1.25) + ' вече е издадена на читателя'));
  h.type('#askTextF [name=v]', 'грешно въведена сума');
  h.$('#modal2 [data-ask=ok]').click();
  await pr; await h.settle();
  assert.equal(q('SELECT COUNT(*) AS n FROM account_lines WHERE id = ?', pay).n, 0);
  assert.match(lastAudit('Изтрит ред от сметката').detail,
    rx('Анулирано Плащане — ' + T + ', плащане 1.25 €; анулирана квитанция № ' + pay + '; причина: грешно въведена сума'));
  assert.ok(h.toastsSince(n).some(t => t.msg.includes('поискайте квитанцията обратно')), JSON.stringify(h.toastsSince(n)));
  h.window.closeModal();
});

/* ==================================================================
   Ч9. „Отвори в пощата“ с дълго писмо
   ================================================================== */
test('Ч9 — дълго писмо: пощата се отваря с адреса, темата и кратка бележка', async () => {
  const long = 'Уважаеми читателю, '.repeat(120);
  const res = await h.api.loans.mailto({ email: 'reader@example.bg', subject: 'Просрочени материали', body: long,
    fallbackBody: 'Поставете текста с Ctrl+V.' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.shortened, true);
  const mail = h.app.shellCalls[h.app.shellCalls.length - 1];
  assert.match(mail, /^mailto:reader%40example\.bg/);
  assert.ok(mail.length <= 1900, 'адресът се побира: ' + mail.length);
  assert.ok(decodeURIComponent(mail).includes('Поставете текста с Ctrl+V.'));
  // Без кратък текст — досегашният отказ (другите места не губят текста мълчаливо).
  const old = await h.api.loans.mailto({ email: 'reader@example.bg', subject: 'x', body: long });
  assert.equal(old.ok, false); assert.match(old.error, /твърде дълго/);
  // През екрана, когато и буферът откаже (jsdom няма navigator.clipboard): пощата пак се отваря.
  const r = mkReader('Имейл Дълъг', { email: 'dalag@example.bg' });
  const b = mkBook();
  const loan = mkLoan(r.id, b.id, E.addDays(T, -20), E.addDays(T, -5));
  await h.go('over');
  await h.window.openReminders(); await h.settle();
  const i = (h.window._REMINDERS || []).findIndex(x => x.reader_id === r.id);
  assert.ok(i >= 0);
  h.$('#remB' + i).value = long;
  const calls = h.app.shellCalls.length;
  const n = h.toasts.length;
  await h.window.remMail(i); await h.settle();
  assert.equal(h.app.shellCalls.length, calls + 1, 'пощата е отворена');
  assert.match(h.app.shellCalls[calls], /^mailto:dalag%40example\.bg/);
  assert.ok(h.toastsSince(n).some(t => /Писмото е отворено с адреса и темата/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  h.window.closeModal();
  h.db.prepare('UPDATE loans SET date_in = ? WHERE id = ?').run(T, loan);
});

/* ==================================================================
   Ч11. ЕГН
   ================================================================== */
test('Ч11 — ЕГН: не 10 цифри се отказва; грешна контролна цифра се записва с бележка в следата', async () => {
  for (const egn of ['12345', 'abcdefghij']) {
    const res = await h.api.readers.create({ name: 'Грешно ЕГН ' + egn, gdpr_consent: true, egn });
    assert.equal(res.ok, false, egn + ' се записа');
    assert.match(res.error, /трябва да е точно 10 цифри/);
  }
  const good = ok(await h.api.readers.create({ name: 'Изправно ЕГН', gdpr_consent: true, egn: '8001011236' }), 'изправно ЕГН');
  assert.equal(q('SELECT egn FROM readers WHERE id = ?', good).egn, '8001011236');
  assert.doesNotMatch(lastAudit('Нов читател').detail, /ВНИМАНИЕ/);
  ok(await h.api.readers.create({ name: 'ЛНЧ Или Грешка', gdpr_consent: true, egn: '800101 1234' }), 'грешна контролна цифра');
  assert.match(lastAudit('Нов читател').detail, /ВНИМАНИЕ: ЕГН с контролната цифра не съвпада \(очаква се 6\)/);
  // Заварено неправилно ЕГН не спира смяната на телефона.
  const legacy = mkReader('Заварен С Грешка', { egn: '12345' });
  const cur = ok(await h.api.readers.get(legacy.id), 'картон');
  ok(await h.api.readers.update(Object.assign({}, cur, { phone: '0888 999' })), 'смяна на телефона');
  // Екранът предупреждава по-рано със същата сметка.
  assert.equal(h.window.egnProblem('8001011236'), '');
  assert.match(h.window.egnProblem('8001011234'), /контролната цифра/);
});

/* ==================================================================
   Ч14. Изборът на служител, когато всички са деактивирани
   ================================================================== */
test('Ч14 — всички служители деактивирани: изборът казва това, не „няма добавени“', async () => {
  h.db.prepare("INSERT INTO employees (name, active) VALUES ('Петя Стара', 0), ('Иван Стар', 0)").run();
  await h.window.chooseEmployeeModal(); await h.settle();
  const t = h.modal();
  assert.doesNotMatch(t, /Все още няма добавени служители/);
  assert.match(t, /всички 2 вписани служители са деактивирани/);
  h.window.closeModal();
  h.db.prepare("DELETE FROM employees WHERE name IN ('Петя Стара', 'Иван Стар')").run();
});

/* ==================================================================
   Ч15. Затворените дни, които още влизат в забавата, се виждат
   ================================================================== */
test('Ч15 — списъкът на затворените дни стига до най-стария падеж на невърнато заемане', async () => {
  const py = String(Number(Y) - 1);
  const r = mkReader('Много Стар Падеж');
  const loan = mkLoan(r.id, mkBook().id, py + '-05-15', py + '-06-01');
  ok(await h.api.calendar.addClosed({ date: py + '-06-15', reason: 'стар ремонт' }), 'стар затворен ден');
  const cal = ok(await h.api.calendar.get(), 'календар');
  assert.ok(cal.closed.some(c => c.date === py + '-06-15'), 'старият затворен ден, който още влиза в забавата, се вижда');
  assert.equal(cal.from, py + '-06-01');
  h.db.prepare('UPDATE loans SET date_in = ? WHERE id = ?').run(T, loan);
  const cal2 = ok(await h.api.calendar.get(), 'календар');
  assert.equal(cal2.from, Y + '-01-01', 'без стари невърнати — от началото на годината');
  ok(await h.api.calendar.removeClosed(py + '-06-15'), 'махане');
});

/* ==================================================================
   М8. Чужда книга по МЗС у читателя — на гишето
   ================================================================== */
test('М8 — гишето казва, че читателят държи чужда книга по МЗС; просрочената — в червено', async () => {
  const r = mkReader('Държи Чужда');
  h.db.prepare(`INSERT INTO mzs_requests (no, year, date, direction, partner, title, author, status, due_date, reader_id, date_received)
    VALUES (17, ?, ?, 'изходящо', 'НЧ „Съседи“', 'Чужда книга', 'Автор', 'получено', ?, ?, ?)`)
    .run(Y, E.addDays(T, -30), E.addDays(T, -2), r.id, E.addDays(T, -25));
  await desk(r.id);
  const note = h.$('[data-mzs-held]');
  assert.ok(note, 'редът за МЗС е на гишето');
  assert.match(h.text(note), rx('📌 Държи чужда книга по МЗС № 17/' + Y + ': Автор. Чужда книга от НЧ „Съседи“, срок ' + E.bgDate(E.addDays(T, -2))));
  assert.match(h.text(note), /срокът е изтекъл/);
  assert.match(note.getAttribute('style') || '', /--red/);
});

/* ==================================================================
   Д3. Историята на записванията — при записване и пререгистрация
   ================================================================== */
test('Д3 — записването и всяка нова пререгистрация остават в историята', async () => {
  const id = ok(await h.api.readers.create({ name: 'Пререгистриран Два Пъти', gdpr_consent: true, registered_at: '2024-03-01' }), 'нов читател');
  const rows = () => h.db.prepare('SELECT date, kind FROM reader_registrations WHERE reader_id = ? ORDER BY date').all(id)
    .map(x => x.date + ' ' + x.kind);
  assert.deepEqual(rows(), ['2024-03-01 записване']);
  let cur = ok(await h.api.readers.get(id), 'картон');
  ok(await h.api.readers.update(Object.assign({}, cur, { re_registered_at: '2025-02-10' })), 'пререгистрация 2025');
  cur = ok(await h.api.readers.get(id), 'картон');
  ok(await h.api.readers.update(Object.assign({}, cur, { re_registered_at: '2026-02-12' })), 'пререгистрация 2026');
  cur = ok(await h.api.readers.get(id), 'картон');
  ok(await h.api.readers.update(Object.assign({}, cur, { phone: '0888 3' })), 'друга редакция');
  assert.deepEqual(rows(), ['2024-03-01 записване', '2025-02-10 пререгистрация', '2026-02-12 пререгистрация'],
    'пререгистрацията през 2026 не изтрива тази през 2025');
});

/* ==================================================================
   М4. Изтриване на читател със заделена книга → запис на каталога
   ================================================================== */
test('М4 — изтриването на читател, което освобождава заделена книга, насрочва запис на каталога', async () => {
  const Database = require('better-sqlite3');
  const { READERS_FTS_SETUP_SQL } = require('../search-fts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-gishe-v2471-'));
  try {
    const db = new Database(path.join(dir, 'library.db'));
    db.pragma('foreign_keys = ON');
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    db.exec(READERS_FTS_SETUP_SQL);
    const handlers = new Map();
    const ipc = { handle: (c, fn) => handlers.set(c, fn) };
    const scheduled = [];
    const activated = [];
    require('../handlers/readers')(ipc, {
      getDb: () => db, run: (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } },
      logAudit: () => {}, today: () => T,
      activateHoldOnReturn: (bookId) => { activated.push(bookId); return null; },
      scheduleCatalogWrite: (kind) => scheduled.push(kind)
    });
    const rid = db.prepare("INSERT INTO readers (name, card_no) VALUES ('Със Заделена', '1')").run().lastInsertRowid;
    const bid = db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'Заделена книга')").run().lastInsertRowid;
    db.prepare("INSERT INTO holds (book_id, reader_id, status, ready_at) VALUES (?, ?, 'заделена', datetime('now'))").run(bid, rid);
    const del = (id) => handlers.get('readers:delete')({}, id);
    assert.equal(del(rid).ok, false, 'първото натискане пита');
    assert.equal(del(rid).ok, true, 'второто изтрива');
    assert.deepEqual(activated, [Number(bid)]);
    assert.deepEqual(scheduled, ['circulation'], 'онлайн каталогът се пише');
    // Без заделена книга — нищо не се насрочва.
    const r2 = db.prepare("INSERT INTO readers (name, card_no) VALUES ('Без Нищо', '2')").run().lastInsertRowid;
    assert.equal(del(r2).ok, true);
    assert.deepEqual(scheduled, ['circulation']);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
