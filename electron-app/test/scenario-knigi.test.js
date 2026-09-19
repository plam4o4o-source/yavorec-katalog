'use strict';
/* СЦЕНАРИЙ (кръг 37, v2.4.61): ВЪВЕЖДАНЕ НА КНИГИ и ПРИДОБИВАНЕ БЕЗ
 * СЪПРОВОДИТЕЛЕН ДОКУМЕНТ — както го минава библиотекарката, през истинския
 * екран (jsdom) и истинските обработчици върху прясна база.
 *
 * Обхват: формата „+ Нова книга“ (books), бройки, цени € / лв., дата на
 * вписване и граници на годината, дупки и дубликати в инвентарните номера,
 * отдели/номенклатури, УДК/авторски знак, ISBN (офлайн), партиди (acq) —
 * „дарение“ и „без документ — протокол на комисия“, КДБФ Част № 1/2,
 * инвентарна книга, табло, съгласуване (fund:check), онлайн каталог.
 *
 * Правило на файла: твърдение, което пада, НЕ спира сценария — записва се в
 * `findings` (виж soft()) с маркер „НАХОДКА n“ и се твърди в самия край.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./helpers/e2e-app');

let h;
const T = E.today();
const Y = T.slice(0, 4);
const Y1 = String(Number(Y) - 1);
const YN = String(Number(Y) + 1);
const ids = {};
const findings = [];

test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const lastAudit = (action) => q('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC', action);
/* Меко твърдение: провалът се записва като находка и сценарият продължава. */
async function soft(label, fn) {
  try { await fn(); }
  catch (e) { findings.push({ label, msg: (e && e.message) || String(e) }); }
}
function noRendererErrors() {
  const errs = h.errors.splice(0);
  assert.equal(errs.length, 0, 'грешки в екранния слой:\n'
    + errs.map(e => (e && (e.stack || e.message)) || String(e)).join('\n---\n'));
}
async function openNewBookForm() {
  await h.go('books');
  await h.clickButton('+ Нова книга', '#view');
  await h.waitFor(() => h.$('#bookF'), 'формата за книга');
}
async function saveBookForm(label) {
  const n = h.toasts.length;
  await h.clickButton(label || 'Запиши', '#modal footer');
  return h.toastsSince(n);
}
async function invBookEditForm(id) {
  await h.go('invbook');
  h.hooks.confirmAnswer = true;
  await h.window.invBookEdit(id);
  await h.waitFor(() => h.$('#bookF') && h.$('#bookF').dataset.id === String(id), 'формата за редакция');
  await h.settle();
}

/* ==================================================================
   0. Настройки — библиотека, комисия
   ================================================================== */
test('0. подготовка: настройки и комисия', async () => {
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  const st = ok(await h.api.settings.get(), 'настройки');
  ok(await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека „Изпитание“', place: 'с. Яворец',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова',
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
  })), 'запис на настройките');
  await h.window.loadSettingsCache();
  assert.equal(q('SELECT next_inv_number FROM settings').next_inv_number, 1, 'прясната база започва от инв. № 1');
  noRendererErrors();
});

/* ==================================================================
   1. Формата „+ Нова книга“ — подразбирания и първи запис
   ================================================================== */
test('1. „+ Нова книга“: подразбиранията на формата и първото вписване', async () => {
  await openNewBookForm();
  assert.equal(h.$('#bookF [name=inv_number]').value, '1', 'следващият инв. № се предлага наготово');
  assert.equal(h.$('#bookF [name=register_date]').value, T, 'датата на вписване е днес');
  assert.equal(h.$('#bookF [name=status]').value, 'наличен');
  assert.equal(h.$('#bookF [name=department]').value, 'за възрастни');
  assert.equal(h.$('#bookF [name=acquisition_id]').value, '', 'без партида по подразбиране');
  assert.match(h.modal(), /Чл\. 16, ал\. 1/, 'формата цитира реквизитите по чл. 16');
  // Падащото меню „Състояние“ НЕ предлага „отчислен“ (отчисляването е само с акт).
  const stOpts = Array.from(h.$('#bookF [name=status]').options).map(o => o.value);
  assert.ok(!stOpts.includes('отчислен'), 'формата не предлага „отчислен“: ' + stOpts.join(','));
  // Всички отдели от OTDELI са в менюто.
  const deptOpts = Array.from(h.$('#bookF [name=department]').options).map(o => o.value);
  for (const d of ['за възрастни', 'за деца', 'краеведски', 'справочен', 'периодика', 'служебен']) assert.ok(deptOpts.includes(d), 'липсва отдел ' + d);

  // Празно заглавие → отказ на самата форма, без обиколка до базата.
  let ts = await saveBookForm();
  assert.ok(ts.some(t => t.type === 'err' && /Заглавие е задължително поле/.test(t.msg)), JSON.stringify(ts));
  assert.equal(h.modalOpen(), true, 'формата остава отворена');

  h.type('#bookF [name=title]', 'Под игото');
  h.type('#bookF [name=author]', 'Вазов, Иван');
  h.type('#bookF [name=category_id]', q("SELECT id FROM categories WHERE name = 'книга'").id);
  h.type('#bookF [name=year]', '1894');
  h.type('#bookF [name=udk]', '821.163.2');
  h.type('#bookF [name=call_number]', 'Б-1');
  // Цена по документ в ЛЕВА (стара фактура): 19.56 лв. → 10.00 €.
  h.type('#bookF [data-bgn-for=price]', '19.56');
  assert.equal(h.$('#bookF [name=price]').value, '10.00', 'левовете се превръщат в евро при писане');
  ts = await saveBookForm();
  assert.ok(ts.some(t => t.msg === 'Книгата е добавена.' && t.type === 'ok'), JSON.stringify(ts));
  assert.equal(h.modalOpen(), false);
  const b = q('SELECT b.*, i.quantity FROM books b LEFT JOIN inventory i ON i.book_id = b.id WHERE b.inv_number = 1');
  assert.ok(b, 'книгата не е в базата');
  ids.b1 = b.id;
  assert.equal(b.price, 10);
  assert.equal(b.quantity, 1, 'един инв. № = един екземпляр');
  assert.equal(b.register_date, T);
  assert.equal(b.status, 'наличен');
  assert.equal(b.status_date, T);
  assert.equal(b.cn_sort != null, true, 'сигнатурата получава ключ за подредба');
  assert.equal(q('SELECT next_inv_number FROM settings').next_inv_number, 2, 'броячът мина на 2');
  assert.match(lastAudit('Нов документ').detail, /инв\. № 1 — Под игото/);
  assert.match(h.text(h.$(`#bBody tr[data-id="${b.id}"]`)), /1 Под игото Вазов, Иван книга за възрастни 1894 наличен 1\/1/);

  // Инвентарната книга: редът, показателите и цената в двете валути.
  await h.go('invbook');
  assert.match(h.text('#ibBody'), /1 Вазов, Иван\. Под игото 1894 10\.00 € 19\.56 лв\./);
  assert.match(h.viewText(), /1 Вписани общо/);
  assert.match(h.viewText(), /1 Неотчислени 10\.00 € \/ 19\.56 лв\./);
  noRendererErrors();
});

/* ==================================================================
   2. Цена: отрицателна, невалидна, със запетая (min=0 не се проверява)
   ================================================================== */
test('2. цена — отрицателна и нечислова стойност', async () => {
  await openNewBookForm();
  h.type('#bookF [name=title]', 'Книга с отрицателна цена');
  h.type('#bookF [name=price]', '-5');
  const ts = await saveBookForm();
  await soft('НАХОДКА: отрицателна цена през формата', async () => {
    // НАХОДКА 1: полето има min=0, но нито формата (firstMissingRequired гледа само
    // празнотата), нито bookPayload проверяват знака — цена −5 € влиза във фонда и
    // НАМАЛЯВА стойността му в КДБФ и инвентарната книга.
    assert.ok(ts.some(t => t.type === 'err'), 'отрицателната цена трябва да бъде отказана; получено: ' + JSON.stringify(ts));
    assert.equal(q("SELECT COUNT(*) AS n FROM books WHERE title = 'Книга с отрицателна цена'").n, 0);
  });
  if (h.modalOpen()) await h.clickButton('Отказ', '#modal footer');
  const neg = q("SELECT id, price FROM books WHERE title = 'Книга с отрицателна цена'");
  if (neg) {
    // Почистваме, за да не влияе на сборовете по-долу (2 натискания = изтриване).
    await h.api.books.delete(neg.id); await h.api.books.delete(neg.id);
    assert.equal(q("SELECT COUNT(*) AS n FROM books WHERE id = ?", neg.id).n, 0);
  }

  // През API (внос, мобилен път): нечислова цена се ОТКАЗВА, „12,50“ се чете като 12.50.
  // (Дотук: parseFloat('abc') = NaN → better-sqlite3 записваше NULL, тоест документът
  // изпадаше от всеки сбор; parseFloat('12,50') = 12 и 50 стотинки изчезваха мълчаливо.)
  const r1 = await h.api.books.create({ title: 'Цена abc', inv_number: 900, price: 'abc', register_date: T });
  assert.equal(r1.ok, false, 'нечислова цена трябва да бъде отказана');
  assert.match(r1.error, /Цената „abc“ не е число/);
  assert.equal(q("SELECT COUNT(*) AS n FROM books WHERE title = 'Цена abc'").n, 0);
  const r2 = ok(await h.api.books.create({ title: 'Цена със запетая', inv_number: 901, price: '12,50', register_date: T }), 'запетая');
  assert.equal(q('SELECT price FROM books WHERE id = ?', r2).price, 12.5, '„12,50“ се чете като 12.50');
  await h.api.books.delete(r2); await h.api.books.delete(r2);
  assert.equal(q('SELECT COUNT(*) AS n FROM books WHERE inv_number IN (900, 901)').n, 0);
  // Броячът е избутан от № 901 → връщаме го, за да продължи сценарият по ред.
  h.db.prepare('UPDATE settings SET next_inv_number = 2 WHERE id = 1').run();
  noRendererErrors();
});

/* ==================================================================
   3. Инвентарни номера: дупка, дубликат от друго работно място, 0 и отрицателен
   ================================================================== */
test('3. инвентарен номер — прескочен, зает от друг компютър, нула, отрицателен', async () => {
  // Прескочен номер: 2 → 10, следата и предупреждението.
  await openNewBookForm();
  assert.equal(h.$('#bookF [name=inv_number]').value, '2');
  h.type('#bookF [name=inv_number]', '10');
  h.type('#bookF [name=title]', 'Тютюн');
  h.type('#bookF [name=author]', 'Димов, Димитър');
  h.type('#bookF [name=price]', '7.5');
  let ts = await saveBookForm();
  assert.ok(ts.some(t => t.msg === 'Книгата е добавена.'));
  assert.ok(ts.some(t => t.type === 'warn' && /Инв\. № 10 е въведен на ръка, а по ред следваше № 2\. Номерата от 2 до 9 \(8 на брой\)/.test(t.msg)),
    'предупреждение за дупката: ' + JSON.stringify(ts));
  assert.match(lastAudit('Прескочени инвентарни номера').detail, /8 номера: от 2 до 9/);
  assert.equal(q('SELECT next_inv_number FROM settings').next_inv_number, 11);
  ids.b10 = q('SELECT id FROM books WHERE inv_number = 10').id;

  // Второ работно място взима № 11, докато формата тук стои отворена.
  await openNewBookForm();
  assert.equal(h.$('#bookF [name=inv_number]').value, '11');
  ok(await h.api.books.create({ title: 'От другия компютър', inv_number: 11, register_date: T, price: 1 }), 'другото работно място');
  h.type('#bookF [name=title]', 'Закъснялата');
  ts = await saveBookForm();
  assert.ok(ts.some(t => t.type === 'err' && /Инв\. № 11 вече е зает от „От другия компютър“/.test(t.msg)), JSON.stringify(ts));
  assert.ok(ts.some(t => /Затворете и отворете формата отново/.test(t.msg)));
  assert.equal(h.modalOpen(), true, 'формата остава отворена с попълнените полета');
  assert.equal(h.$('#bookF [name=title]').value, 'Закъснялата');
  assert.equal(q("SELECT COUNT(*) AS n FROM books WHERE title = 'Закъснялата'").n, 0);
  await h.clickButton('Отказ', '#modal footer');
  ids.b11 = q('SELECT id FROM books WHERE inv_number = 11').id;

  // Инв. № 0 и отрицателен номер: няма такива в инвентарна книга.
  await openNewBookForm();
  h.type('#bookF [name=inv_number]', '0');
  h.type('#bookF [name=title]', 'Нулев номер');
  ts = await saveBookForm();
  await soft('НАХОДКА: инв. № 0 се приема', async () => {
    // НАХОДКА 3: полето е type=number без min, bookPayload прави parseInt без проверка —
    // инв. № 0 (и −4 по-долу) влизат в регистъра. Поредицата по чл. 16 започва от 1.
    assert.ok(ts.some(t => t.type === 'err'), 'инв. № 0 трябва да бъде отказан; ' + JSON.stringify(ts));
  });
  if (h.modalOpen()) await h.clickButton('Отказ', '#modal footer');
  const rNeg = await h.api.books.create({ title: 'Отрицателен номер', inv_number: -4, register_date: T });
  await soft('НАХОДКА: отрицателен инв. № се приема', async () => {
    assert.equal(rNeg.ok, false, 'инв. № −4 трябва да бъде отказан');
  });
  const rFrac = await h.api.books.create({ title: 'Дробен номер', inv_number: '12.7', register_date: T });
  await soft('НАХОДКА: дробен инв. № се отрязва мълчаливо', async () => {
    // parseInt('12.7') = 12 — записва се друг номер от въведения, без дума.
    assert.equal(rFrac.ok, false, 'инв. № „12.7“ трябва да бъде отказан, а не отрязан до 12');
  });
  for (const t of ['Нулев номер', 'Отрицателен номер', 'Дробен номер']) {
    const r = q('SELECT id FROM books WHERE title = ?', t);
    if (r) { await h.api.books.delete(r.id); await h.api.books.delete(r.id); }
  }
  h.db.prepare('UPDATE settings SET next_inv_number = 12 WHERE id = 1').run();
  noRendererErrors();
});

/* ==================================================================
   4. Баркод — един етикет = един екземпляр; съвпадение с чужд инв. №
   ================================================================== */
test('4. баркод — дубликат и съвпадение с чужд инвентарен номер', async () => {
  const dup = await h.api.books.create({ title: 'Баркод = чужд инв. №', inv_number: 12, register_date: T, barcode: '10' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /Баркод 10 съвпада с инвентарния номер на друг документ \(инв\. № 10\)/);
  ok(await h.api.books.create({ title: 'С етикет', inv_number: 12, register_date: T, barcode: 'BC-0001', price: 3 }), 'с етикет');
  const dup2 = await h.api.books.create({ title: 'Същият етикет', inv_number: 13, register_date: T, barcode: ' BC-0001 ' });
  assert.equal(dup2.ok, false, 'баркодът се подрязва и се сравнява — дубликатът се отказва');
  assert.match(dup2.error, /Баркод BC-0001 вече е на инв\. № 12/);
  const dup3 = await h.api.books.create({ title: 'Инв. № = чужд баркод', inv_number: 13, register_date: T, barcode: null, price: 3 });
  ok(dup3, 'обикновен запис');
  ids.b13 = dup3.data;
  // Баркод „007“ на един документ и инв. № 7 на друг — числовото съвпадение също се отказва.
  ok(await h.api.books.create({ title: 'С водещи нули', inv_number: 14, register_date: T, barcode: '007' }), '007');
  const dup4 = await h.api.books.create({ title: 'Седмица', inv_number: 7, register_date: T });
  assert.equal(dup4.ok, false);
  assert.match(dup4.error, /Инв\. № 7 съвпада с баркода на друг документ/);
  noRendererErrors();
});

/* ==================================================================
   5. Бройки — само 1; „+ Още екземпляр“ прави нов запис
   ================================================================== */
test('5. бройка > 1 се отказва; „+ Още екземпляр“ създава втори запис със свой номер', async () => {
  const r = await h.api.books.create({ title: 'Три бройки', inv_number: 20, register_date: T, quantity: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Един инвентарен номер отговаря на ЕДИН екземпляр/);
  const r0 = await h.api.books.create({ title: 'Нула бройки', inv_number: 20, register_date: T, quantity: 0 });
  assert.equal(r0.ok, false);
  assert.match(r0.error, /Бройка 0 прави документа невидим/);
  assert.equal(q('SELECT COUNT(*) AS n FROM books WHERE inv_number = 20').n, 0);

  // Редакция на инв. № 1 от инвентарната книга → „+ Още екземпляр“.
  await invBookEditForm(ids.b1);
  assert.match(h.hooks.confirms[h.hooks.confirms.length - 1], /РЕДАКЦИЯ НА ЗАПИС В ИНВЕНТАРНАТА КНИГА/);
  assert.match(h.modal(), /Инв\. № 1 — редакция/);
  assert.match(h.modal(), /1 — един инвентарен номер, един екземпляр/);
  await h.clickButton('+ Още екземпляр', '#modal footer');
  await h.waitFor(() => /Още един екземпляр от „Под игото“/.test(h.modal()), 'формата за копие');
  await h.settle();
  const next = q('SELECT next_inv_number FROM settings').next_inv_number;
  assert.equal(h.$('#bookF [name=inv_number]').value, String(next), 'копието взима следващия номер');
  assert.equal(h.$('#bookF [name=barcode]').value, '', 'баркодът не се копира');
  assert.equal(h.$('#bookF [name=title]').value, 'Под игото');
  assert.equal(h.$('#bookF [name=price]').value, '10.00', 'цената се копира');
  const ts = await saveBookForm();
  assert.ok(ts.some(t => t.msg === 'Книгата е добавена.'), JSON.stringify(ts));
  const copy = q('SELECT b.*, i.quantity FROM books b JOIN inventory i ON i.book_id = b.id WHERE b.inv_number = ?', next);
  assert.ok(copy, 'копието не е записано');
  ids.b1copy = copy.id;
  assert.equal(copy.title, 'Под игото');
  assert.equal(copy.price, 10);
  assert.equal(copy.quantity, 1);
  assert.equal(copy.barcode, null);
  assert.equal(q('SELECT COUNT(*) AS n FROM books WHERE title = ?', 'Под игото').n, 2, 'две заглавия = два реда');
  noRendererErrors();
});

/* ==================================================================
   6. Дата на вписване — невалидна, граница на годината, бъдеща
   ================================================================== */
test('6. дата на вписване — невалидна се отказва; 31.12 / 01.01 попадат в различни години на КДБФ', async () => {
  const bad = await h.api.books.create({ title: 'Счупена дата', inv_number: 30, register_date: 'НЕВАЛИДНА-99-99' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /не е валидна дата/);
  const bad2 = await h.api.books.create({ title: 'Несъществуващ ден', inv_number: 30, register_date: Y + '-02-30' });
  assert.equal(bad2.ok, false, '30 февруари не е дата');

  ids.bDec = ok(await h.api.books.create({ title: 'Последният ден на миналата година', inv_number: 30, register_date: Y1 + '-12-31', price: 4 }), 'дек');
  ids.bJan = ok(await h.api.books.create({ title: 'Първият ден на тази година', inv_number: 31, register_date: Y + '-01-01', price: 6 }), 'ян');
  const kPrev = ok(await h.api.kdbf.report(Y1), 'КДБФ ' + Y1);
  const kCur = ok(await h.api.kdbf.report(Y), 'КДБФ ' + Y);
  assert.equal(kPrev.acquiredYear.n, 1, 'постъпил през ' + Y1 + ' е само декемврийският');
  assert.equal(kPrev.acquiredYear.v, 4);
  assert.equal(kPrev.stockEnd.n, 1, 'наличност към 31.12.' + Y1);
  assert.ok(kCur.acquiredYear.n >= 1);
  const invFund = ok(await h.api.invBook.list({ offset: 0, limit: 10 }), 'инв. книга');
  // Началното салдо на текущата година = крайното на миналата.
  assert.equal(kCur.stockEnd.n - kCur.acquiredYear.n + kCur.deaccYear.n, kPrev.stockEnd.n, 'веригата между годините');
  assert.equal(invFund.summary.activeCopies, kCur.stockEnd.n, 'инвентарна книга = КДБФ 31.12 (няма бъдещи/недатирани)');

  // Бъдеща дата (следваща година): приема се без дума — фондът на таблото и в КДБФ се разминават.
  const fut = await h.api.books.create({ title: 'Вписана в бъдещето', inv_number: 32, register_date: YN + '-01-15', price: 9 });
  ok(fut, 'бъдеща дата');
  const chk = ok(await h.api.fund.check(Y), 'съгласуване');
  const keys = chk.findings.find(f => f.key === 'keys');
  assert.ok(keys, 'съгласуването забелязва разминаването');
  assert.match(keys.why, /1 с дата на вписване след 31\.12\./);
  await soft('НАХОДКА: бъдеща дата на вписване минава без предупреждение', async () => {
    // НАХОДКА 4: books:create връща само invGap/suggestions/catalogWarning; дата в
    // бъдещето (грешка при писане на годината — 2027 вместо 2026) е най-честият
    // начин един документ да изпадне от годишния отчет, а формата мълчи.
    assert.ok(fut.dateWarning || fut.catalogWarning, 'очаква се предупреждение за дата след днешния ден');
  });
  await h.api.books.delete(fut.data); await h.api.books.delete(fut.data);
  assert.equal(ok(await h.api.fund.check(Y), 'пак').findings.some(f => f.key === 'keys'), false, 'след поправката двата ключа са равни');
  noRendererErrors();
});

/* ==================================================================
   7. Табло / инвентарна книга / КДБФ — едно и също число
   ================================================================== */
test('7. таблото, инвентарната книга и КДБФ показват един и същ фонд', async () => {
  const dash = ok(await h.api.dashboard.full(), 'табло');
  const inv = ok(await h.api.invBook.list({ offset: 0, limit: 10 }), 'инв. книга');
  const k = ok(await h.api.kdbf.report(Y), 'КДБФ');
  const dbN = q("SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS v FROM books WHERE status != 'отчислен' OR status IS NULL");
  assert.equal(dash.fundCount, dbN.n);
  assert.equal(inv.summary.activeCopies, dbN.n);
  assert.equal(k.stockEnd.n, dbN.n);
  assert.equal(Math.round(dash.fundValue * 100), Math.round(dbN.v * 100));
  assert.equal(Math.round(k.stockEnd.v * 100), Math.round(dbN.v * 100));
  await h.go('dash');
  assert.match(h.viewText(), new RegExp(dbN.n + ' Библиотечен фонд ' + E.mny(dbN.v).replace(/[.\/]/g, '\\$&')));
  noRendererErrors();
});

/* ==================================================================
   8. УДК, авторски знак, ISBN офлайн — помощниците във формата
   ================================================================== */
test('8. УДК от таблицата, авторски знак от вградената таблица, ISBN без интернет — нищо не гърми', async () => {
  await openNewBookForm();
  h.type('#bookF [name=title]', 'Помощници');
  h.type('#bookF [name=author]', 'Йовков, Йордан');
  await h.clickButton('Избери…', '#bookF');
  await h.waitFor(() => /Универсална десетична класификация/.test(h.modal2()), 'прозорецът на УДК');
  h.window.udkSet('94', 'История');
  h.window.udkAddAux('(497.2)');
  await h.click(h.$('#udkTake'));
  assert.equal(h.$('#bookF [name=udk]').value, '94(497.2)', 'сглобеният код влиза в полето');
  /* Авторски знак: таблицата идва с програмата (v2.4.63, миграция 17), затова
     „Предложи“ наистина предлага — без библиотекарката да е внасяла нищо.
     „Йовков“ е и проверката на правилото „Й се търси от буква И“: числото идва
     от реда „ИОВК“, а буквата на знака остава Й, за да стои книгата при другите
     Й-автори на рафта. Подсказката казва и двете, за да не изглежда сгрешено. */
  let n = h.toasts.length;
  await h.clickButton('Предложи', '#bookF');
  await h.settle();
  const hint = h.text('#amHint');
  assert.doesNotMatch(hint, /Няма как да предложа/, hint);
  assert.match(hint, /фамилия „Йовков“/, hint);
  assert.match(hint, /ред „ИОВК“/, hint);
  assert.match(hint, /Й се търси от буква И/, hint);
  const mark = h.$('#bookF [name=author_mark]').value;
  assert.match(mark, /^Й-\d+$/, 'знакът носи буквата на фамилията: ' + mark);
  assert.ok(h.toastsSince(n).some(t => t.type === 'ok' && t.msg === 'Авторски знак ' + mark),
    JSON.stringify(h.toastsSince(n)));
  // ISBN: няма мрежа.
  h.type('#bookF [name=isbn]', '9789540100001');
  n = h.toasts.length;
  await h.clickButton('Търси', '#bookF');
  await h.settle();
  assert.match(h.text('#isbnHint'), /Няма връзка с Google Books и Open Library/);
  assert.ok(h.toastsSince(n).some(t => t.type === 'err'));
  assert.equal(h.$('#bookF [name=title]').value, 'Помощници', 'въведеното не се пипа');
  assert.equal(h.$('#isbnBtn').disabled, false, 'копчето се отключва след неуспеха');
  await h.clickButton('Отказ', '#modal footer');
  noRendererErrors();
});

/* ==================================================================
   9. Партида „дарение“ през формата — адресът по чл. 6, ал. 5
   ================================================================== */
test('9. партида „дарение“ без адрес на дарителя — завеждане и поправка', async () => {
  await h.go('acq');
  assert.match(h.viewText(), /Няма заведени партиди/);
  await h.clickButton('+ Нова партида', '#view');
  await h.waitFor(() => h.$('#acqF'), 'формата за партида');
  assert.equal(h.$('#acqF [name=no]').value, '1');
  assert.equal(h.$('#acqF [name=committee3]').value, 'Ана Счетоводителка', 'комисията идва от Настройки');
  const docTypes = Array.from(h.$('#acqF [name=doc_type]').options).map(o => o.value);
  assert.ok(docTypes.includes('без документ — протокол на комисия'), 'видът „без документ“ е в менюто');
  h.type('#acqF [name=how]', 'дарение');
  h.type('#acqF [name=from_source]', 'Иван Дарителов');
  h.type('#acqF [name=doc_type]', 'акт (разписка)');
  h.type('#acqF [name=doc_no]', 'Д-1');
  h.type('#acqF [name=total_count]', '2');
  h.type('#acqF [data-bgn-for=sum]', '39.12');
  assert.equal(h.$('#acqF [name=sum]').value, '20.00');
  let n = h.toasts.length;
  await h.clickButton('Заведи партидата', '#modal footer');
  let ts = h.toastsSince(n);
  await soft('НАХОДКА: дарение без адрес на дарителя се завежда', async () => {
    // НАХОДКА 5: acquisitions:update отказва дарение без адрес („чл. 6, ал. 5“),
    // а acquisitions:create — не; формата също не проверява. Актът за дарение
    // после излиза с „Адрес: …………………“.
    assert.ok(ts.some(t => t.type === 'err' && /адрес/.test(t.msg)), 'очаква се отказ по чл. 6, ал. 5; ' + JSON.stringify(ts));
  });
  if (h.modalOpen()) {
    h.type('#acqF [name=donor_address]', 'с. Яворец, ул. Първа 1');
    n = h.toasts.length;
    await h.clickButton('Заведи партидата', '#modal footer');
    ts = h.toastsSince(n);
  }
  assert.ok(ts.some(t => t.msg === 'Партидата е заведена в КДБФ част 1.'), JSON.stringify(ts));
  const a = q('SELECT * FROM acquisitions WHERE no = 1 AND year = ?', Y);
  assert.ok(a, 'партидата не е в базата');
  ids.acqDar = a.id;
  assert.equal(a.sum, 20);
  assert.equal(a.how, 'дарение');
  assert.equal(a.committee1, 'Мария Иванова');
  assert.match(lastAudit('Постъпление').detail, /партида № 1\/\d{4} — 2 бр\. от Иван Дарителов/);
  assert.match(h.text('#acqBody'), /1 \/ \d{4}.*Иван Дарителов дарение акт \(разписка\) № Д-1 2 0 0\.00 €/);

  // Поправка: адресът се добавя; без адрес поправката се отказва.
  if (!a.donor_address) {
    const bad = await h.api.acquisitions.update({ id: a.id, acq: Object.assign({}, a, { donor_address: '' }) });
    assert.equal(bad.ok, false, 'поправката без адрес се отказва');
    assert.match(bad.error, /чл\. 6, ал\. 5/);
    ok(await h.api.acquisitions.update({ id: a.id, acq: Object.assign({}, a, { donor_address: 'с. Яворец, ул. Първа 1' }) }), 'адрес');
    assert.match(lastAudit('Поправена партида').detail, /адрес на дарителя: „—“ → „с\. Яворец, ул\. Първа 1“/);
  }

  // Инвентиране на двете книги по партидата от картата ѝ.
  await h.window.openAcq(a.id); await h.settle();
  assert.match(h.modal(), /2 Общо по документ 0 Инвентирани 2 Остават/);
  assert.match(h.modal(), /Обявена стойност по документа: 20\.00 €/);
  await h.clickButton('+ Инвентирай документ', '#modal footer');
  await h.waitFor(() => h.$('#bookF'), 'формата за книга от партидата');
  assert.equal(h.$('#bookF [name=acquisition_id]').value, String(a.id), 'партидата е предварително избрана');
  h.type('#bookF [name=title]', 'Дарена книга 1');
  h.type('#bookF [name=author]', 'Дарителов, Иван');
  h.type('#bookF [name=price]', '12');
  h.type('#bookF [name=category_id]', q("SELECT id FROM categories WHERE name = 'книга'").id);
  ts = await saveBookForm('Запиши и нов');
  assert.ok(ts.some(t => t.msg === 'Книгата е добавена.'), JSON.stringify(ts));
  await h.waitFor(() => h.$('#bookF') && h.$('#bookF [name=title]').value === '', 'новата форма след „Запиши и нов“');
  await h.settle();
  assert.equal(h.$('#bookF [name=acquisition_id]').value, String(a.id), 'партидата се пренася');
  assert.equal(h.$('#bookF [name=category_id]').value, String(q("SELECT id FROM categories WHERE name = 'книга'").id), 'видът се пренася');
  const nextInv = q('SELECT next_inv_number FROM settings').next_inv_number;
  assert.equal(h.$('#bookF [name=inv_number]').value, String(nextInv), 'следващият номер е опреснен');
  h.type('#bookF [name=title]', 'Дарена книга 2');
  h.type('#bookF [name=price]', '8');
  ts = await saveBookForm();
  assert.ok(ts.some(t => t.msg === 'Книгата е добавена.'), JSON.stringify(ts));
  const items = all('SELECT id, inv_number, price FROM books WHERE acquisition_id = ? ORDER BY inv_number', a.id);
  assert.equal(items.length, 2);
  ids.dar1 = items[0].id; ids.dar2 = items[1].id;
  noRendererErrors();
});

/* ==================================================================
   10. Актът за дарение, редът в КДБФ Част № 1, сумите по партида
   ================================================================== */
test('10. акт за дарение / PDF и редът в Част № 1 — обявена срещу изчислена стойност', async () => {
  await h.go('acq');
  await h.window.openAcq(ids.acqDar); await h.settle();
  assert.match(h.modal(), /2 Общо по документ 2 Инвентирани 0 Остават/);
  await h.clickButton('Акт за дарение / PDF', '#modal footer');
  await h.settle();
  const p = h.printed();
  assert.match(p, /НЧ „Изпитание – 1922“/);
  assert.match(p, new RegExp('АКТ № 1 / ' + Y + ' за приемане на дарение'));
  assert.match(p, /чл\. 6 от Наредба № 3/);
  assert.match(p, /Мария Иванова, Петър Петров, Ана Счетоводителка/);
  assert.match(p, /Дарител: Иван Дарителов/);
  assert.match(p, /Адрес: с\. Яворец, ул\. Първа 1/);
  assert.match(p, /Общ брой документи по документа: 2/);
  assert.match(p, /Обща стойност по документа: 20\.00 € \/ 39\.12 лв\./);
  assert.match(p, /ОБЩО 2 документа 20\.00 € \/ 39\.12 лв\./, 'сборът на инвентираните = 12 + 8');
  assert.doesNotMatch(p, /Относно стойността/, 'обявена = изчислена → без бележка');
  assert.doesNotMatch(p, /Относно броя/);
  assert.match(p, /Комисия: 1\. Мария Иванова 2\. Петър Петров 3\. Ана Счетоводителка/);
  h.window.ppClose();

  // Сборът на партидата в списъка и в КДБФ Част № 1 = сбор на книгите.
  const list = ok(await h.api.acquisitions.list(), 'списък');
  const row = list.find(x => x.id === ids.acqDar);
  assert.equal(row.registered_count, 2);
  assert.equal(row.registered_value, 20);
  const k = ok(await h.api.kdbf.report(Y), 'КДБФ');
  const p1 = k.part1.find(x => x.id === ids.acqDar);
  assert.equal(p1.registered_count, 2);
  assert.equal(p1.registered_value, 20);
  assert.equal(p1.inv_from, q('SELECT inv_number FROM books WHERE id = ?', ids.dar1).inv_number);
  assert.equal(p1.inv_to, q('SELECT inv_number FROM books WHERE id = ?', ids.dar2).inv_number);

  // Цената на един документ се поправя → партидата вече се различава от обявеното.
  const b = ok(await h.api.books.get(ids.dar2), 'get');
  ok(await h.api.books.update(Object.assign({}, b, { price: '8.10' })), 'поправка на цената');
  await h.window.openAcq(ids.acqDar); await h.settle();
  await h.clickButton('Акт за дарение / PDF', '#modal footer');
  await h.settle();
  const p2 = h.printed();
  assert.match(p2, /Относно стойността: обявената стойност \(20\.00 € \/ 39\.12 лв\.\) се различава от сбора на инвентираните до момента документи \(20\.10 € \/ 39\.31 лв\.\)/);
  h.window.ppClose();
  ok(await h.api.books.update(Object.assign({}, ok(await h.api.books.get(ids.dar2), 'get2'), { price: '8' })), 'обратно');
  noRendererErrors();
});

/* ==================================================================
   11. Партида „без документ — протокол на комисия“
   ================================================================== */
test('11. придобиване без съпроводителен документ — партида, инвентиране, протокол', async () => {
  await h.go('acq');
  await h.clickButton('+ Нова партида', '#view');
  await h.waitFor(() => h.$('#acqF'), 'формата за партида');
  assert.equal(h.$('#acqF [name=no]').value, '2', 'номерът продължава поредицата за годината');
  h.type('#acqF [name=how]', 'дарение');
  h.type('#acqF [name=from_source]', 'неизвестен дарител — намерени при подреждане');
  h.type('#acqF [name=doc_type]', 'без документ — протокол на комисия');
  h.type('#acqF [name=doc_no]', '');
  h.type('#acqF [name=total_count]', '2');
  h.type('#acqF [name=sum]', '');
  h.type('#acqF [name=donor_address]', 'неизвестен');
  h.type('#acqF [name=note]', 'Оценка на комисията по чл. 3, ал. 2');
  let n = h.toasts.length;
  await h.clickButton('Заведи партидата', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Партидата е заведена в КДБФ част 1.'), JSON.stringify(h.toastsSince(n)));
  const a = q('SELECT * FROM acquisitions WHERE no = 2 AND year = ?', Y);
  assert.ok(a);
  ids.acqNoDoc = a.id;
  assert.equal(a.sum, null, 'празна стойност = NULL, не 0');
  assert.equal(a.doc_type, 'без документ — протокол на комисия');

  // Картата: протокол за придобиване, а НЕ акт за дарение (макар „как“ = дарение).
  await h.window.openAcq(a.id); await h.settle();
  assert.match(h.modal(), /Документът не обявява стойност — разпечатките сумират оценките/);
  assert.ok(h.button('Протокол за придобиване / PDF', '#modal footer'));
  // Протокол без нито един инвентиран документ: казва го изрично.
  await h.clickButton('Протокол за придобиване / PDF', '#modal footer');
  await h.settle();
  let p = h.printed();
  assert.match(p, new RegExp('ПРОТОКОЛ № 2 / ' + Y + ' за придобиване на библиотечни документи без съпроводителен документ'));
  assert.match(p, /липсва първичен счетоводен документ по чл\. 3, ал\. 2/);
  assert.match(p, /Обща оценена стойност: не е определена — по партидата още няма инвентирани документи/);
  assert.match(p, /Относно описа: към момента на отпечатване по партидата няма нито един инвентиран документ/);
  assert.match(p, /УТВЪРДИЛ, Председател/);
  h.window.ppClose();

  // Три документа по партида за два → надхвърляне.
  const mk = (title, price) => h.api.books.create({ title, inv_number: undefined, register_date: T, price, acquisition_id: a.id, category_id: 1, author: 'Неизвестен' });
  const nextInv = q('SELECT next_inv_number FROM settings').next_inv_number;
  ids.nd1 = ok(await h.api.books.create({ title: 'Намерена 1', inv_number: nextInv, register_date: T, price: 2.5, acquisition_id: a.id, category_id: 1 }), 'н1');
  ids.nd2 = ok(await h.api.books.create({ title: 'Намерена 2', inv_number: nextInv + 1, register_date: T, price: 3.5, acquisition_id: a.id, category_id: 2 }), 'н2');
  ids.nd3 = ok(await h.api.books.create({ title: 'Намерена 3', inv_number: nextInv + 2, register_date: T, price: 1, acquisition_id: a.id, category_id: 1 }), 'н3');
  void mk;
  await h.go('acq');
  const rowTxt = h.text(Array.from(h.document.querySelectorAll('#acqBody tr')).find(tr => /неизвестен дарител/.test(h.text(tr))));
  assert.match(rowTxt, /2 3 7\.00 €/, 'списъкът: обявени 2, инвентирани 3, 7.00 €');
  await h.window.openAcq(a.id); await h.settle();
  assert.match(h.modal(), /3 Инвентирани \+1 Над обявения брой/);
  assert.match(h.modal(), /Изброените надхвърлят обявения брой с 1/);
  await h.clickButton('Протокол за придобиване / PDF', '#modal footer');
  await h.settle();
  p = h.printed();
  assert.match(p, /Общ брой документи: 2/);
  assert.match(p, /Обща стойност по описа \(сбор на оценките на изброените документи\): 7\.00 € \/ 13\.69 лв\./);
  assert.match(p, /Относно броя: обявеният общ брой \(2\) не съвпада със сбора на изброените по-долу инвентирани документи \(3\)\. Изброените надхвърлят обявения брой с 1/);
  assert.match(p, /Забележка по партидата: Оценка на комисията по чл\. 3, ал\. 2/);
  assert.match(p, /ОБЩО 3 документа 7\.00 € \/ 13\.69 лв\./);
  assert.match(p, /Комисия: 1\. Мария Иванова 2\. Петър Петров 3\. Ана Счетоводителка/);
  assert.match(p, /заместващ първичен документ/);
  h.window.ppClose();

  // Поправка на обявения брой → 3; следата носи старо → ново.
  await h.window.openAcq(a.id); await h.settle();
  await h.clickButton('Поправи', '#modal footer');
  await h.waitFor(() => h.$('#acqF') && h.$('#acqF [name=no]').readOnly, 'формата за поправка');
  h.type('#acqF [name=total_count]', '3');
  h.type('#acqF [name=sum]', '7');
  n = h.toasts.length;
  await h.clickButton('Запиши поправката', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => /Партидата е поправена/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.match(lastAudit('Поправена партида').detail, /общ брой: „2“ → „3“; обявена стойност: „—“ → „7“/);
  await h.window.openAcq(a.id); await h.settle();
  assert.match(h.modal(), /3 Инвентирани 0 Остават/);
  await h.clickButton('Затвори', '#modal footer');

  // Част № 1: колоната „По вид“ и сборът.
  await h.go('kdbf');
  const p1 = h.viewText();
  // Колоната „Документ“ при партида без документ: само видът, без висящо „№“ и без дата.
  assert.match(p1, /неизвестен дарител — намерени при подреждане дарение без документ — протокол на комисия 3 3 7\.00 €/);
  assert.doesNotMatch(p1, /протокол на комисия №/, 'няма знак „№“ без номер');
  // Формата вече не предпопълва doc_date при вид „без документ“ (иначе в Част № 1
  // излизаше „без документ — протокол на комисия № 17.09.2026“ — дата на документ,
  // който по определение липсва).
  assert.equal(q('SELECT doc_date FROM acquisitions WHERE id = ?', a.id).doc_date, null, 'партида без документ не носи дата на документ');
  assert.equal(q('SELECT doc_no FROM acquisitions WHERE id = ?', a.id).doc_no, null, 'нито номер на документ');
  assert.match(p1, /книга: 2, продължаващо издание: 1/);
  noRendererErrors();
});

/* ==================================================================
   12. Партида и вписване в различни години; поправка на датата през година
   ================================================================== */
test('12. партида от 30.12 миналата година, вписана през тази — Част № 1 срещу Част № 2', async () => {
  ids.acqOld = ok(await h.api.acquisitions.create({
    no: 7, date: Y1 + '-12-30', how: 'закупуване', from_source: 'Книжарница', doc_type: 'фактура', doc_no: 'Ф-99',
    doc_date: Y1 + '-12-29', total_count: 1, sum: '5'
  }), 'стара партида');
  assert.equal(q('SELECT year FROM acquisitions WHERE id = ?', ids.acqOld).year, Y1, 'годината идва от датата');
  const nextInv = q('SELECT next_inv_number FROM settings').next_inv_number;
  ids.bOld = ok(await h.api.books.create({ title: 'Закъсняло вписване', inv_number: nextInv, register_date: Y + '-01-05', price: 5, acquisition_id: ids.acqOld }), 'книга');
  const kPrev = ok(await h.api.kdbf.report(Y1), 'КДБФ ' + Y1);
  const kCur = ok(await h.api.kdbf.report(Y), 'КДБФ ' + Y);
  assert.ok(kPrev.part1.some(a => a.id === ids.acqOld), 'партидата е в Част № 1 за ' + Y1);
  assert.ok(!kCur.part1.some(a => a.id === ids.acqOld));
  assert.equal(kPrev.crossOut.n, 1, 'един документ по партида от ' + Y1 + ', вписан през друга година');
  assert.equal(kCur.crossIn.n >= 1, true);
  assert.equal(kPrev.part1Sum.n - kPrev.acquiredYear.n, kPrev.crossOut.n - kPrev.crossIn.n, 'Част 1 − Част 2 = crossOut − crossIn');
  await h.go('kdbf');
  h.type('#view select', Y1); await h.settle();
  assert.match(h.viewText(), new RegExp('за ' + Y1 + ' г\\.'));
  assert.match(h.viewText(), /Книжарница закупуване фактура № Ф-99/);
  await h.clickButton('Част № 2', '#view');
  assert.match(h.viewText(), /Съгласуване на Част № 1 с Част № 2/);
  assert.match(h.viewText(), new RegExp('1 документа по партиди от ' + Y1 + ' г\\., вписани в инвентарната книга през друга година'));
  await h.clickButton('Част № 1', '#view');
  h.type('#view select', Y); await h.settle();

  // Поправка на датата на партидата в ДРУГА година: отказва се (колоната year е
  // мястото на реда в регистъра и № 7/Y може вече да е зает от друга партида).
  const a = q('SELECT * FROM acquisitions WHERE id = ?', ids.acqOld);
  const moved = await h.api.acquisitions.update({ id: a.id, acq: Object.assign({}, a, { date: Y + '-01-03' }) });
  assert.equal(moved.ok, false, 'дата извън годината на партидата се отказва');
  assert.match(moved.error, new RegExp('Партида № 7/' + Y1 + ' не може да получи дата от ' + Y + ' г\\.'));
  const after = q('SELECT no, year, date FROM acquisitions WHERE id = ?', a.id);
  assert.equal(after.date.slice(0, 4), after.year, 'датата и годината на партидата съвпадат: ' + JSON.stringify(after));
  // Поправка ВЪТРЕ в годината остава възможна.
  ok(await h.api.acquisitions.update({ id: a.id, acq: Object.assign({}, a, { date: Y1 + '-12-29' }) }), 'дата в същата година');
  ok(await h.api.acquisitions.update({ id: a.id, acq: Object.assign({}, a, { date: Y1 + '-12-30' }) }), 'обратно');
  noRendererErrors();
});

/* ==================================================================
   13. Книга без партида → свързване; изтриване на партида със свързани книги
   ================================================================== */
test('13. книга без партида, после свързана; изтриване на партида с/без свързани документи', async () => {
  const before = ok(await h.api.fund.check(Y), 'преди');
  const nb = before.findings.find(f => f.key === 'nobatch');
  assert.ok(nb, 'има документи без партида (инв. № 1, 10, 11 …)');
  const nBefore = Number(nb.title.match(/^(\d+)/)[1]);
  const b = ok(await h.api.books.get(ids.b13), 'get');
  assert.equal(b.acquisition_id, null);
  ok(await h.api.books.update(Object.assign({}, b, { acquisition_id: String(ids.acqDar) })), 'свързване');
  assert.equal(q('SELECT acquisition_id FROM books WHERE id = ?', ids.b13).acquisition_id, ids.acqDar);
  assert.match(lastAudit('Редакция на документ').detail, /инв\. № 13/);
  const after = ok(await h.api.fund.check(Y), 'след');
  const nb2 = after.findings.find(f => f.key === 'nobatch');
  assert.equal(Number(nb2.title.match(/^(\d+)/)[1]), nBefore - 1, 'един документ по-малко без партида');
  const row = ok(await h.api.acquisitions.list(), 'списък').find(x => x.id === ids.acqDar);
  assert.equal(row.registered_count, 3, 'партидата вече брои и свързаната книга');
  assert.equal(row.registered_value, 23);
  // Инвентарната книга показва № / дата в КДБФ за свързаната книга.
  const ib = ok(await h.api.invBook.list({ q: 'Инв. № = чужд баркод', offset: 0, limit: 5 }), 'инв. книга');
  assert.equal(ib.rows[0].acq_no, 1);

  // Изтриване на партида със свързани документи → отказ; след откачане → минава и оставя следа.
  await h.go('acq');
  await h.window.openAcq(ids.acqDar); await h.settle();
  h.hooks.confirmAnswer = true;
  let n = h.toasts.length;
  await h.clickButton('Изтрий', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /има инвентирани документи и не може да бъде изтрита/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.ok(q('SELECT 1 FROM acquisitions WHERE id = ?', ids.acqDar), 'партидата остава');
  await h.clickButton('Затвори', '#modal footer');

  const tmpAcq = ok(await h.api.acquisitions.create({ no: 3, date: T, how: 'обмен', from_source: 'Друга библиотека', total_count: 1 }), 'временна');
  const nextInv = q('SELECT next_inv_number FROM settings').next_inv_number;
  const tb = ok(await h.api.books.create({ title: 'Обменена', inv_number: nextInv, register_date: T, price: 2, acquisition_id: tmpAcq }), 'книга по нея');
  const bad = await h.api.acquisitions.delete(tmpAcq);
  assert.equal(bad.ok, false);
  ok(await h.api.books.update(Object.assign({}, ok(await h.api.books.get(tb), 'get'), { acquisition_id: '' })), 'откачане');
  ok(await h.api.acquisitions.delete(tmpAcq), 'изтриване');
  assert.equal(q('SELECT COUNT(*) AS n FROM acquisitions WHERE id = ?', tmpAcq).n, 0);
  assert.match(lastAudit('Изтрита партида').detail, /партида № 3\/\d{4} — 1 бр\. от Друга библиотека; номерът се освобождава/);
  assert.equal(ok(await h.api.acquisitions.nextNo(Y), 'следващ №'), 3, 'номерът на изтритата партида се предлага наново');
  assert.equal(q('SELECT acquisition_id FROM books WHERE id = ?', tb).acquisition_id, null);
  noRendererErrors();
});

/* ==================================================================
   14. Партида през API — валидиране на датата, броя и стойността
   ================================================================== */
test('14. acquisitions:create без проверка на датата и знака', async () => {
  const r1 = await h.api.acquisitions.create({ no: 50, date: 'abc', how: 'закупуване', from_source: 'X', total_count: 1 });
  const r2 = await h.api.acquisitions.create({ no: 51, date: '', how: 'закупуване', from_source: 'X', total_count: 1 });
  const r3 = await h.api.acquisitions.create({ no: 52, date: Y + '-02-30', how: 'закупуване', from_source: 'X', total_count: 1 });
  const r4 = await h.api.acquisitions.create({ no: 53, date: T, how: 'закупуване', from_source: 'X', total_count: -3, sum: '-10' });
  await soft('НАХОДКА: партида с нечетима/празна дата се завежда', async () => {
    // НАХОДКА 7: acquisitions:update вика isValidIsoDate, acquisitions:create — не.
    // date 'abc' → year 'abc' (yearOf = slice(0,4)) → партидата не излиза в
    // НИТО една година на КДБФ Част № 1; date '' → year = текущата, date ''.
    assert.equal(r1.ok, false, 'дата „abc“ трябва да се откаже; записано: ' + JSON.stringify(q('SELECT no, year, date FROM acquisitions WHERE no = 50')));
    assert.equal(r2.ok, false, 'празна дата трябва да се откаже; записано: ' + JSON.stringify(q('SELECT no, year, date FROM acquisitions WHERE no = 51')));
    assert.equal(r3.ok, false, '30 февруари трябва да се откаже');
  });
  await soft('НАХОДКА: отрицателен общ брой и отрицателна стойност на партида', async () => {
    // НАХОДКА 8: parseInt/parseFloat без проверка на знака.
    assert.equal(r4.ok, false, 'общ брой −3 / стойност −10 трябва да се откажат; записано: ' + JSON.stringify(q('SELECT total_count, sum FROM acquisitions WHERE no = 53')));
  });
  for (const r of [r1, r2, r3, r4]) if (r.ok) await h.api.acquisitions.delete(r.data);
  // Дублиран номер в една година — второто работно място.
  const d1 = ok(await h.api.acquisitions.create({ no: 9, date: T, how: 'закупуване', from_source: 'А', total_count: 1 }), 'първата');
  const d2 = await h.api.acquisitions.create({ no: 9, date: T, how: 'закупуване', from_source: 'Б', total_count: 1 });
  assert.equal(d2.ok, false);
  assert.match(d2.error, /Партида № 9\/\d{4} вече съществува/);
  const nn = ok(await h.api.acquisitions.nextNo(Y), 'nextNo');
  assert.equal(nn, 10, 'MAX+1 след № 9');
  ok(await h.api.acquisitions.delete(d1), 'чистене');
  noRendererErrors();
});

/* ==================================================================
   15. Редакция на инв. № — броячът и дупката
   ================================================================== */
test('15. смяна на инвентарния номер при редакция не мести брояча и не оставя следа за дупката', async () => {
  const next = q('SELECT next_inv_number FROM settings').next_inv_number;
  const b = ok(await h.api.books.get(ids.b11), 'get');
  ok(await h.api.books.update(Object.assign({}, b, { inv_number: String(next + 5) })), 'нов номер при редакция');
  assert.equal(q('SELECT inv_number FROM books WHERE id = ?', ids.b11).inv_number, next + 5);
  const s = q('SELECT next_inv_number FROM settings').next_inv_number;
  await soft('НАХОДКА: редакцията на инв. № не мести брояча и не отбелязва дупката', async () => {
    // НАХОДКА 9: books:update няма нито assertInvNumberFree (UNIQUE го хваща с общото
    // съобщение), нито invGapNotice, нито `if (inv >= next) next = inv + 1`. Следващата
    // нова книга получава № next, а № next..next+4 остават празни без ред в дневника;
    // а ако редакцията вземе точно № next, следващото „+ Нова книга“ пада на „вече е зает“.
    assert.equal(s, next + 6, 'броячът трябва да е след най-големия номер');
    const gap = lastAudit('Прескочени инвентарни номера');
    assert.ok(gap && new RegExp('от ' + next + ' до ' + (next + 4)).test(gap.detail),
      'следа за дупката: ' + JSON.stringify(gap && gap.detail));
  });
  // Ако редакцията вземе ТОЧНО номера на брояча, всяко следващо „+ Нова книга“ пада
  // с „Затворете и отворете формата отново“ — а отварянето наново дава същия зает номер.
  ok(await h.api.books.update(Object.assign({}, ok(await h.api.books.get(ids.b11), 'g'), { inv_number: String(next) })), 'редакция към номера на брояча');
  const loop = await h.api.books.create({ title: 'Следващата нова', inv_number: q('SELECT next_inv_number FROM settings').next_inv_number, register_date: T });
  await soft('НАХОДКА: след редакция към номера на брояча „+ Нова книга“ е в задънена улица', async () => {
    assert.equal(loop.ok, true, 'предложеният номер трябва да е свободен; получено: ' + loop.error);
  });
  if (loop.ok) { await h.api.books.delete(loop.data); await h.api.books.delete(loop.data); }
  // Редакция към ЗАЕТ номер: съобщението е общото от SQLite, без „кой“ и „какво да се направи“.
  const b2 = ok(await h.api.books.get(ids.b11), 'get2');
  const taken = await h.api.books.update(Object.assign({}, b2, { inv_number: '10' }));
  assert.equal(taken.ok, false);
  await soft('НАХОДКА: зает номер при редакция — общото съобщение', async () => {
    assert.match(taken.error, /вече е зает от „/, 'при редакция съобщението не казва кой държи номера: ' + taken.error);
  });
  ok(await h.api.books.update(Object.assign({}, ok(await h.api.books.get(ids.b11), 'get3'), { inv_number: '11' })), 'обратно на 11');
  h.db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(next);
  noRendererErrors();
});

/* ==================================================================
   16. Второ работно място — остарял картон
   ================================================================== */
test('16. остарял картон: другото работно място е записало междувременно — записът се отказва', async () => {
  await invBookEditForm(ids.b10);
  const other = ok(await h.api.books.get(ids.b10), 'get');
  ok(await h.api.books.update(Object.assign({}, other, { description: 'скъсана корица' })), 'другото работно място');
  h.type('#bookF [name=title]', 'Тютюн (поправено тук)');
  const ts = await saveBookForm();
  assert.ok(ts.some(t => t.type === 'err' && /променен от друго работно място/.test(t.msg)), JSON.stringify(ts));
  assert.equal(h.modalOpen(), true, 'формата остава отворена');
  assert.equal(q('SELECT title FROM books WHERE id = ?', ids.b10).title, 'Тютюн', 'чуждата промяна не е заличена');
  assert.equal(q('SELECT description FROM books WHERE id = ?', ids.b10).description, 'скъсана корица');
  await h.clickButton('Отказ', '#modal footer');
  noRendererErrors();
});

/* ==================================================================
   17. Отчислен документ — картонът и API
   ================================================================== */
test('17. отчислен с акт документ: картонът пази „отчислен“, а API приема връщане на „наличен“', async () => {
  ok(await h.api.deaccessionActs.create({
    act: { no: 1, date: T, reason_code: 4, reason_text: 'Физически изхабени', disposal: 'вторични суровини',
      committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' },
    bookIds: [ids.b1copy]
  }), 'акт');
  const d = q('SELECT status, deaccession_date, deaccession_act_id FROM books WHERE id = ?', ids.b1copy);
  assert.equal(d.status, 'отчислен');
  assert.ok(d.deaccession_date && d.deaccession_act_id);
  await invBookEditForm(ids.b1copy);
  assert.match(h.modal(), /Състояние променя се само с акт/);
  assert.equal(h.$('#bookF [name=status]').value, 'отчислен', 'скритото поле носи „отчислен“');
  h.type('#bookF [name=description]', 'бележка към отчисления');
  const ts = await saveBookForm();
  assert.ok(ts.some(t => t.msg === 'Книгата е обновена.'), JSON.stringify(ts));
  assert.equal(q('SELECT status FROM books WHERE id = ?', ids.b1copy).status, 'отчислен', 'записът на картона не връща документа във фонда');

  // През API (внос, мобилно, стар клиент): статус „наличен“ на отчислен с акт документ.
  const b = ok(await h.api.books.get(ids.b1copy), 'get');
  const r = await h.api.books.update(Object.assign({}, b, { status: 'наличен' }));
  await soft('НАХОДКА: books:update приема „наличен“ за документ, отчислен с акт', async () => {
    // НАХОДКА 10: assertValidStatus проверява само enum-а. Редът остава с
    // deaccession_date → КДБФ/отчетът го броят отчислен, таблото/инвентарната
    // книга — наличен; books:clearOrphanDeaccession нарочно отказва обратното.
    assert.equal(r.ok, false, 'връщането във фонда става само с анулиране на акта');
    assert.equal(q('SELECT status FROM books WHERE id = ?', ids.b1copy).status, 'отчислен');
  });
  if (r.ok) {
    const chk = ok(await h.api.fund.check(Y), 'съгласуване');
    const keys = chk.findings.find(f => f.key === 'keys');
    assert.ok(keys, 'таблото и КДБФ вече броят различен фонд');
    await soft('НАХОДКА: съгласуването не разпознава „наличен по статус, но с дата на отчисляване“', async () => {
      // fund-check изброява само три причини (лоша дата, бъдеща дата, отчислен без акт);
      // този случай остава „бележка“ с обяснение „документи, вписани след 31.12“ — невярно.
      assert.equal(keys.level, 'важно', 'разминаването е с причина и трябва да е „важно“, а не „бележка“: ' + keys.why);
    });
    h.db.prepare("UPDATE books SET status = 'отчислен' WHERE id = ?").run(ids.b1copy);
  }
  // Създаване направо със статус „отчислен“ (без акт) през API.
  const nextInv = q('SELECT next_inv_number FROM settings').next_inv_number;
  const r2 = await h.api.books.create({ title: 'Родена отчислена', inv_number: nextInv, register_date: T, status: 'отчислен' });
  await soft('НАХОДКА: books:create приема статус „отчислен“ без акт', async () => {
    // НАХОДКА 11: вносът вече отказва такива редове (data-import.js), каналът — не.
    assert.equal(r2.ok, false, 'нов документ не може да се роди отчислен');
  });
  if (r2.ok) { h.db.prepare('DELETE FROM books WHERE id = ?').run(r2.data); h.db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(nextInv); }
  noRendererErrors();
});

/* ==================================================================
   18. Групова редакция — „изгубен“ от менюто
   ================================================================== */
test('18. групова редакция: менюто предлага „изгубен“, обработчикът го отказва като „отчисляване“', async () => {
  await h.go('books');
  const chk = h.$(`#bBody .bkChk[data-id="${ids.b13}"]`);
  assert.ok(chk, 'редът на инв. № 13');
  h.type(chk, true);
  await h.settle();
  assert.equal(h.$('#bulkBtn').disabled, false);
  await h.clickButton('Групова редакция…', '#view');
  await h.waitFor(() => h.$('#bulkF'), 'формата за групова редакция');
  h.type('#bulkF [name=bulkField]', 'status');
  await h.settle();
  const vals = Array.from(h.$('#bulkF [name=bulkValue]').options).map(o => o.value);
  assert.ok(vals.includes('изгубен'), 'менюто предлага „изгубен“: ' + vals.join(','));
  h.type('#bulkF [name=bulkValue]', 'изгубен');
  const n = h.toasts.length;
  await h.clickButton('Приложи върху', '#modal footer');
  const ts = h.toastsSince(n);
  await soft('НАХОДКА: „изгубен“ в груповата редакция', async () => {
    // НАХОДКА 12: BULK_EDIT_STATUS_VALUES в handlers/books.js е ['наличен','липсващ',
    // 'за реставрация'] — без „изгубен“ (добавен в менюто във v2.4.56). Отказът
    // при това лъже: „Отчисляването на документи минава само през акт“.
    assert.ok(ts.some(t => /обновени/.test(t.msg)), 'очаква се „1 документ(а) обновени.“; получено: ' + JSON.stringify(ts));
    assert.equal(q('SELECT status FROM books WHERE id = ?', ids.b13).status, 'изгубен');
  });
  if (h.modalOpen()) await h.clickButton('Отказ', '#modal footer');
  h.window.eval('BOOKS_SELECTED.clear()');
  // „липсващ“ минава и носи дата на статуса.
  ok(await h.api.books.bulkUpdate({ ids: [ids.b13], field: 'status', value: 'липсващ' }), 'липсващ');
  const r = q('SELECT status, status_date FROM books WHERE id = ?', ids.b13);
  assert.equal(r.status, 'липсващ');
  assert.equal(r.status_date, T);
  ok(await h.api.books.bulkUpdate({ ids: [ids.b13], field: 'status', value: 'наличен' }), 'обратно');
  noRendererErrors();
});

/* ==================================================================
   19. Предложение за покупка → постъпление
   ================================================================== */
test('19. читателско предложение се намира при вписването и се затваря само с потвърждение', async () => {
  const sid = ok(await h.api.suggestions.create({ title: 'Време разделно', author: 'Антон Дончев', reader_name: 'Петрова, Мария', date: Y + '-01-15' }), 'предложение');
  await openNewBookForm();
  h.type('#bookF [name=title]', 'Време разделно');
  h.type('#bookF [name=author]', 'Дончев, Антон');
  h.type('#bookF [name=price]', '15');
  h.hooks.confirmAnswer = true;
  const nC = h.hooks.confirms.length;
  const ts = await saveBookForm();
  assert.ok(ts.some(t => t.msg === 'Книгата е добавена.'), JSON.stringify(ts));
  const asked = h.hooks.confirms.slice(nC).find(c => /Петрова, Мария е поискал\(а\) „Време разделно“/.test(c));
  assert.ok(asked, 'въпросът към библиотекаря: ' + JSON.stringify(h.hooks.confirms.slice(nC)));
  assert.equal(q('SELECT status FROM suggestions WHERE id = ?', sid).status, 'получено');
  assert.ok(ts.some(t => /Предложението на Петрова, Мария е отбелязано като получено/.test(t.msg)));
  noRendererErrors();
});

/* ==================================================================
   20. Онлайн каталог — нов документ веднага, редакция отложено, провал с предупреждение
   ================================================================== */
test('20. онлайн каталог: katalog.json след вписване, след редакция и при недостъпна папка', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-katalog-'));
  h.db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(dir);
  const file = path.join(dir, 'katalog.json');
  await openNewBookForm();
  h.type('#bookF [name=title]', 'Публикувана книга');
  h.type('#bookF [name=author]', 'Каталогов, К.');
  h.type('#bookF [name=department]', 'за деца');
  h.type('#bookF [name=price]', '3');
  let ts = await saveBookForm();
  assert.ok(ts.some(t => t.msg === 'Книгата е добавена.'), JSON.stringify(ts));
  assert.ok(!ts.some(t => t.type === 'warn' && /каталога/.test(t.msg)), 'успешният запис не предупреждава');
  assert.ok(fs.existsSync(file), 'katalog.json е записан веднага след вписването');
  let cat = JSON.parse(fs.readFileSync(file, 'utf8'));
  const inv = q("SELECT inv_number FROM books WHERE title = 'Публикувана книга'").inv_number;
  let it = cat.items.find(x => x.inv === inv);
  assert.ok(it, 'новата книга е в каталога');
  assert.equal(it.t, 'Публикувана книга');
  assert.equal(it.av, 1);
  assert.equal(it.d, T, 'датата на постъпване е в каталога');
  assert.equal(it.o, 'за деца');
  assert.ok(!cat.items.some(x => x.t === 'Под игото' && x.inv === q('SELECT inv_number FROM books WHERE id = ?', ids.b1copy).inv_number), 'отчисленият не се публикува');
  assert.equal(cat.library, 'Библиотека „Изпитание“');

  // Редакция: отложен запис (4 s) — файлът не се променя веднага; „Ръчен запис“ го обновява.
  const bid = q("SELECT id FROM books WHERE title = 'Публикувана книга'").id;
  ok(await h.api.books.update(Object.assign({}, ok(await h.api.books.get(bid), 'get'), { title: 'Публикувана книга (2. изд.)' })), 'редакция');
  cat = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cat.items.find(x => x.inv === inv).t, 'Публикувана книга', 'редакцията е отложена (debounce) — файлът още е стар');
  ok(await h.api.catalog.writeNow(), 'ръчен запис');
  cat = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cat.items.find(x => x.inv === inv).t, 'Публикувана книга (2. изд.)');
  // Служебен отдел → изпада от каталога.
  ok(await h.api.books.update(Object.assign({}, ok(await h.api.books.get(bid), 'get'), { department: 'служебен' })), 'служебен');
  ok(await h.api.catalog.writeNow(), 'ръчен запис');
  cat = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!cat.items.some(x => x.inv === inv), 'служебният отдел не се публикува');

  // Недостъпна папка (изключен мрежов диск): вписването минава, но предупреждава и оставя следа.
  h.db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(path.join(dir, 'няма', 'такава', 'папка'));
  await openNewBookForm();
  h.type('#bookF [name=title]', 'Книга при изключен диск');
  ts = await saveBookForm();
  assert.ok(ts.some(t => t.msg === 'Книгата е добавена.'), 'документът ВЛИЗА');
  const w = ts.find(t => t.type === 'warn' && /записът на каталога след нов документ инв\. № \d+ не успя/.test(t.msg));
  assert.ok(w, 'предупреждението за каталога: ' + JSON.stringify(ts));
  assert.match(w.msg, /няма да се появи на сайта/);
  assert.equal(lastAudit('Онлайн каталог').detail, w.msg, 'същото изречение и в дневника');
  h.db.prepare('UPDATE settings SET catalog_folder = NULL WHERE id = 1').run();
  noRendererErrors();
});

/* ==================================================================
   21. Лимит на записите — отчислените не заемат място
   ================================================================== */
test('21. лимитът брои само фонда; при достигане вписването се отказва с указание', async () => {
  const n = q("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен' OR status IS NULL").n;
  ok(await h.api.limits.update({ limit_books: n, limit_readers: 0 }), 'лимит');
  const u = ok(await h.api.limits.usage(), 'usage');
  assert.equal(u.books, n);
  const nextInv = q('SELECT next_inv_number FROM settings').next_inv_number;
  const r = await h.api.books.create({ title: 'Над лимита', inv_number: nextInv, register_date: T });
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp('Достигнат е зададеният лимит от ' + n + ' документи във фонда'));
  assert.match(r.error, /отчислените с акт не заемат място/);
  ok(await h.api.limits.update({ limit_books: 0, limit_readers: 0 }), 'без лимит');
  noRendererErrors();
});

/* ==================================================================
   22. Изтриване на вписан документ — двойно потвърждение
   ================================================================== */
test('22. изтриването на вписан документ първо отказва и обяснява пътя с акт', async () => {
  const nextInv = q('SELECT next_inv_number FROM settings').next_inv_number;
  const id = ok(await h.api.books.create({ title: 'Сгрешен запис', inv_number: nextInv, register_date: T }), 'сгрешен');
  await h.go('books');
  h.hooks.confirmAnswer = true;
  const n = h.toasts.length;
  await h.window.deleteBook(id); await h.settle();
  const ts = h.toastsSince(n);
  assert.ok(ts.some(t => t.type === 'err' && /е ВПИСАН в инвентарната книга/.test(t.msg) && /акт за отчисляване/.test(t.msg)), JSON.stringify(ts));
  assert.ok(q('SELECT 1 FROM books WHERE id = ?', id), 'първото натискане не трие');
  await h.window.deleteBook(id); await h.settle();
  assert.match(h.hooks.confirms[h.hooks.confirms.length - 1], /НЕОБРАТИМО/);
  assert.equal(q('SELECT COUNT(*) AS n FROM books WHERE id = ?', id).n, 0, 'второто — трие');
  assert.match(lastAudit('Изтрит документ').detail, new RegExp('инв\\. № ' + nextInv + ' — Сгрешен запис · без нито едно заемане'));
  assert.equal(q('SELECT next_inv_number FROM settings').next_inv_number, nextInv + 1, 'броячът НЕ се връща — номерът остава празен (следата го обяснява)');
  noRendererErrors();
});

/* ==================================================================
   22а. Зает документ — редакция, бройка, изтриване
   ================================================================== */
test('22а. зает документ: картонът се редактира, бройката остава 1, изтриването се отказва', async () => {
  const rid = ok(await h.api.readers.create({ name: 'Иван Читателов', card_no: '1001', gdpr_consent: true }), 'читател');
  ok(await h.api.loans.checkoutByCode({ reader_id: rid, code: '10', date_out: T }), 'заемане на инв. № 10');
  const b = ok(await h.api.books.get(ids.b10), 'get');
  assert.equal(b.available, 0, 'зает → наличност 0/1');
  // Редакция на зает документ: описанието се поправя, бройката не се пипа.
  ok(await h.api.books.update(Object.assign({}, b, { year: '1951' })), 'редакция на зает');
  assert.equal(q('SELECT quantity FROM inventory WHERE book_id = ?', ids.b10).quantity, 1);
  const del = await h.api.books.delete(ids.b10);
  assert.equal(del.ok, false);
  assert.match(del.error, /зает в момента \(1 незавършено заемане\)/);
  await h.go('books');
  assert.match(h.text(h.$(`#bBody tr[data-id="${ids.b10}"]`)), /Тютюн.*наличен 0\/1/, 'списъкът показва 0/1');
  // Върнат — пак 1/1.
  const loan = q('SELECT id FROM loans WHERE book_id = ? AND date_in IS NULL', ids.b10);
  ok(await h.api.loans.return({ id: loan.id, date_in: T }), 'връщане');
  assert.equal(ok(await h.api.books.get(ids.b10), 'get2').available, 1);
  noRendererErrors();
});

/* ==================================================================
   23. КДБФ — разпечатката съдържа партидите, Част № 2 се връзва
   ================================================================== */
test('23. КДБФ / PDF: Част № 1 с двете партиди, Част № 2 със салдата, Част № 3 с акта', async () => {
  await h.go('kdbf');
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  const p = h.printed();
  assert.match(p, /КНИГА ЗА ДВИЖЕНИЕ НА БИБЛИОТЕЧНИЯ ФОНД/);
  assert.match(p, /Иван Дарителов \/ дарение акт \(разписка\) № Д-1/);
  // Партидата без първичен документ се печата само с вида — без „№“ и без „/“ след него.
  assert.match(p, /неизвестен дарител — намерени при подреждане \/ дарение без документ — протокол на комисия/);
  assert.doesNotMatch(p, /протокол на комисия № \//);
  const k = ok(await h.api.kdbf.report(Y), 'КДБФ');
  const startN = k.stockEnd.n - k.acquiredYear.n + k.deaccYear.n;
  assert.match(p, new RegExp('Наличност към 01\\.01\\.' + Y + ' г\\. ' + startN + ' '));
  assert.match(p, new RegExp('Постъпили през ' + Y + ' г\\. ' + k.acquiredYear.n + ' '));
  assert.match(p, new RegExp('Отчислени през ' + Y + ' г\\. 1 ' + E.mny(10).replace(/[.\/]/g, '\\$&')));
  assert.match(p, new RegExp('Наличност към 31\\.12\\.' + Y + ' г\\. ' + k.stockEnd.n + ' '));
  assert.match(p, /№ 1 \/ \d{4} т\. 4\. Физически изхабени вторични суровини 1/);
  assert.match(p, /Разпределение по видове документи/);
  const prevEnd = ok(await h.api.kdbf.report(Y1), 'КДБФ ' + Y1).stockEnd.n;
  assert.equal(startN, prevEnd, 'началното салдо е крайното на миналата година');
  h.window.ppClose();
  const chk = ok(await h.api.fund.checkLogged(Y), 'съгласуване');
  assert.ok(chk.findings.every(f => f.level === 'бележка'), 'само бележки: ' + JSON.stringify(chk.findings.map(f => [f.key, f.level, f.title])));
  assert.match(lastAudit('Съгласуване на фонда').detail, /числата се връзват/);
  noRendererErrors();
});

/* ==================================================================
   Край: находките
   ================================================================== */
test('Z. находки от сценария', () => {
  console.log('\n=== НАХОДКИ (' + findings.length + ') ===');
  findings.forEach((f, i) => console.log((i + 1) + '. ' + f.label + '\n   ' + f.msg.split('\n')[0]));
  assert.equal(findings.length, 0, findings.length + ' находки — виж списъка по-горе');
});
