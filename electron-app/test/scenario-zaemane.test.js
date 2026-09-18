'use strict';
/* СЦЕНАРИЙ (кръг 37, v2.4.61): ЗАЕМАНЕ И ВРЪЩАНЕ НА КНИГИ — както го минава
 * библиотекарката на гишето, през истинския екран (jsdom) и истинските
 * обработчици върху прясна база.
 *
 * Обхват: „Заемане и връщане“ (circ — сканиране на карта, на документ, връщане,
 * „Читалня +1“, „Днес на гишето“), „Просрочени“ (over), „Читатели“ (readers —
 * картон, категории, гарант за дете, съгласие по ОРЗД, наказание), правилата по
 * категория (circRules), календарът (работни дни, затворени дни), резервациите,
 * напомнянията, изгубените документи → акт по чл. 30, т. 5, потокът от събития
 * → предложенията за Дневника, годишният отчет (stats:report).
 *
 * Правило на файла: твърдение, което пада, НЕ спира сценария — записва се в
 * `findings` (виж soft()) с маркер „НАХОДКА n“ и се твърди в самия край.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/e2e-app');

let h;
const T = E.today();
const Y = T.slice(0, 4);
const ids = {};      // читатели, книги, заемания
const findings = [];

test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const lastAudit = (action) => q('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC', action);
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'));
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
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
/* ---- календарна аритметика за фикстурите ---- */
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
function lastDow(from, wd) { let d = from; while (dow(d) !== wd) d = E.addDays(d, -1); return d; }
const W = lastDow(E.addDays(T, -15), 3);   // сряда, поне 15 дни назад
const S0 = lastDow(E.addDays(T, -40), 6);  // събота, поне 40 дни назад
const M1 = E.addDays(S0, 16);              // понеделникът след S0 + 14 (събота)

/* ---- гише ---- */
async function desk() {
  await h.go('circ');
  if (!h.button('Заемане', '#view').classList.contains('pri')) await h.clickButton('Заемане', '#view');
  if (h.$('#circCount')) await h.clickButton('Смени', '#view');
  await h.waitFor(() => h.$('#pScan'), 'полето за читател');
}
async function selectReader(card) {
  await desk();
  await h.scan('#pScan', card);
  await h.waitFor(() => h.$('#bScan'), 'полето за сканиране на документ');
}
async function scanOut(code) {
  const n = h.toasts.length;
  await h.scan('#bScan', code);
  return { log: h.text('#outLog'), toasts: h.toastsSince(n) };
}
async function returnByScan(code) {
  await h.go('circ');
  if (!h.$('#inScan')) await h.clickButton('Връщане', '#view');
  await h.waitFor(() => h.$('#inScan'), 'полето за връщане');
  const n = h.toasts.length;
  await h.scan('#inScan', code);
  return { log: h.text('#inLog'), toasts: h.toastsSince(n) };
}
/* Редът на заемане в таблицата „Заети от този читател“ по инв. №. */
function loanRow(inv) {
  const rows = Array.from(h.document.querySelectorAll('#view table.ledger tbody tr'));
  const r = rows.find(tr => tr.querySelector('td') && tr.querySelector('td').textContent.trim() === String(inv));
  if (!r) throw new Error('Няма ред за инв. № ' + inv + ' в таблицата: ' + h.viewText());
  return r;
}
async function newBook(o) {
  const cat = q("SELECT id FROM categories WHERE name = 'книга'").id;
  return ok(await h.api.books.create(Object.assign({ category_id: cat, register_date: T, language: 'български', udk: '821.163.2-31' }, o)), 'книга ' + o.title);
}
async function newReader(o) {
  return ok(await h.api.readers.create(Object.assign({ gdpr_consent: true, category: 'възрастен', registered_at: T }, o)), 'читател ' + o.name);
}
const openLoan = (bookId) => q('SELECT * FROM loans WHERE book_id = ? AND date_in IS NULL', bookId);

/* ==================================================================
   0. Подготовка: настройки, календар, правила по категория, фонд
   ================================================================== */
test('0. подготовка: настройки, работни дни пон–пет, правила по категория, фонд', async () => {
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  const st = ok(await h.api.settings.get(), 'настройки');
  ok(await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека „Изпитание“', place: 'с. Яворец',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова',
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка',
    loan_days: 14, max_books: 3, extensions_count: 2, extension_days: 14,
    fine_per_day: 0.10, suspend_per_day: 1, suspend_max: 90, remind2_days: 14, remind3_days: 30
  })), 'запис на настройките');
  await h.window.loadSettingsCache();
  const s = q('SELECT * FROM settings WHERE id = 1');
  assert.equal(s.loan_days, 14); assert.equal(s.max_books, 3); assert.equal(s.fine_per_day, 0.1); assert.equal(s.suspend_per_day, 1);

  // Календар: библиотеката работи понеделник–петък; понеделникът M1 е затворен (отпуск).
  ok(await h.api.calendar.saveWorkDays([1, 2, 3, 4, 5]), 'работни дни');
  assert.equal(q('SELECT work_days FROM settings').work_days, '1,2,3,4,5');
  const bad = await h.api.calendar.saveWorkDays([]);
  assert.equal(bad.ok, false, 'без нито един работен ден се отказва');
  ok(await h.api.calendar.addClosed({ date: M1, reason: 'отпуск' }), 'затворен ден');
  assert.equal((await h.api.calendar.addClosed({ date: '2026-02-30' })).ok, false, 'невалидна дата се отказва');
  assert.match(lastAudit('Календар').detail, /затворен ден/);

  // Правило за учениците: най-много 2 документа, 1 продължение.
  ok(await h.api.circRules.save({ category: 'ученик', max_books: 2, extensions_count: 1 }), 'правило ученик');
  const eff = ok(await h.api.circRules.effective('ученик'), 'effective');
  assert.equal(eff.max_books, 2); assert.equal(eff.extensions_count, 1); assert.equal(eff.loan_days, 14, 'срокът пада към общия');
  assert.equal((await h.api.circRules.save({ category: 'ученик', max_books: -1 })).ok, false, 'отрицателен лимит се отказва');

  // Фонд: 12 документа, всеки със свой инв. №; два екземпляра на един и същи учебник.
  ids.b1 = await newBook({ title: 'Под игото', author: 'Вазов, Иван', inv_number: 1, price: 10, barcode: 'BC0001' });
  ids.b2 = await newBook({ title: 'Тютюн', author: 'Димов, Димитър', inv_number: 2, price: 7.5 });
  ids.b3 = await newBook({ title: 'Железният светилник', author: 'Талев, Димитър', inv_number: 3, price: 8 });
  ids.b4 = await newBook({ title: 'Време разделно', author: 'Донев, Антон', inv_number: 4, price: 9 });
  ids.b5 = await newBook({ title: 'История на България', author: 'Колектив', inv_number: 5, price: 20, udk: '949.72' });
  ids.b6 = await newBook({ title: 'Пипи Дългото чорапче', author: 'Линдгрен, Астрид', inv_number: 6, price: 6, udk: '82-93', language: 'български' });
  ids.b7 = await newBook({ title: 'Книга без цена', inv_number: 7, price: 0 });
  ids.b8 = await newBook({ title: 'English Grammar', author: 'Murphy, R.', inv_number: 8, price: 15, udk: '811.111', language: 'английски' });
  ids.b9 = await newBook({ title: 'Бай Ганьо', author: 'Константинов, Алеко', inv_number: 9, price: 5 });
  ids.b10 = await newBook({ title: 'Книга без УДК', inv_number: 10, price: 4, udk: '' });
  ids.b21 = await newBook({ title: 'Учебник по математика', inv_number: 21, price: 12, udk: '51' });
  ids.b22 = await newBook({ title: 'Учебник по математика', inv_number: 22, price: 12, udk: '51' });
  assert.equal(q('SELECT COUNT(*) AS n FROM books').n, 12);
  assert.ok(all('SELECT quantity FROM inventory').every(r => r.quantity === 1), 'един инв. № = един екземпляр');
  noRendererErrors();
});

/* ==================================================================
   1. Читатели: формата, съгласие по ОРЗД, гарант за дете, API без съгласие
   ================================================================== */
test('1. записване на читатели — формата пази ОРЗД и гаранта, API-то не', async () => {
  await h.go('readers');
  await h.clickButton('+ Нов читател', '#view');
  await h.waitFor(() => h.$('#readerF'), 'формата за читател');
  assert.match(h.modal(), /чл\. 42, ал\. 3/, 'формата цитира чл. 42, ал. 3');
  assert.equal(h.$('#readerF [name=registered_at]').value, T);
  assert.equal(h.$('#readerF [name=category]').value, 'възрастен');
  h.type('#readerF [name=name]', 'Ани Детска');
  h.type('#readerF [name=card_no]', '2006');
  h.type('#readerF [name=category]', 'дете до 14 г.');
  assert.equal(h.$('#guarantorFs').style.display, '', 'при дете полето за гарант се показва');
  let n = h.toasts.length;
  await h.clickButton('Запиши', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /съгласието по чл\. 47 и ОРЗД/.test(t.msg)), 'без съгласие се отказва: ' + JSON.stringify(h.toastsSince(n)));
  h.type('#readerF [name=gdpr_consent]', true);
  n = h.toasts.length;
  await h.clickButton('Запиши', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /родител\/настойник/.test(t.msg)), 'дете без гарант се отказва');
  h.type('#readerF [name=guarantor_name]', 'Петя Детска (майка)');
  h.type('#readerF [name=guarantor_phone]', '0888 111 222');
  h.type('#readerF [name=parent_consent]', true);
  n = h.toasts.length;
  await h.clickButton('Запиши', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Читателят е добавен.'), JSON.stringify(h.toastsSince(n)));
  const child = q("SELECT * FROM readers WHERE card_no = '2006'");
  ids.rChild = child.id;
  assert.equal(child.category, 'дете до 14 г.');
  assert.equal(child.gdpr_consent, 1); assert.equal(child.gdpr_consent_date, T);
  assert.equal(child.parent_consent, 1); assert.equal(child.parent_consent_date, T);
  assert.equal(child.guarantor_name, 'Петя Детска (майка)');
  assert.match(lastAudit('Нов читател').detail, /карта 2006 — Ани Детска/);
  // Читателската карта и картонът на детето — гарантът е на картона.
  await h.window.printCardOne(ids.rChild); await h.settle();
  let p = h.printed();
  assert.match(p, /ЧИТАТЕЛСКА КАРТА Ани Детска Категория: дете до 14 г\./);
  assert.match(p, /2006/);
  h.window.ppClose();
  await h.window.printReaderCard(ids.rChild); await h.settle();
  p = h.printed();
  assert.match(p, /ЧИТАТЕЛСКИ КАРТОН № 2006/);
  assert.match(p, /Родител\/настойник: Петя Детска \(майка\) \(родител\) — тел\. 0888 111 222/);
  assert.match(p, rx('Съгласие за обработване на лични данни — отбелязано в библиотечната документация на ' + E.bgDate(T)));
  h.window.ppClose();

  // Останалите — през API (както мобилният път/вносът).
  ids.r1 = await newReader({ name: 'Иван Читателов', card_no: '1001', phone: '0899 000 001', address: 'ул. Първа 1', email: 'ivan@example.bg' });
  ids.r2 = await newReader({ name: 'Мария Закъсняла', card_no: '1002', address: 'ул. Втора 2' });
  ids.r3 = await newReader({ name: 'Георги Продължаващ', card_no: '1003' });
  ids.r4 = await newReader({ name: 'Стоян Чакащ', card_no: '1004', phone: '0899 000 004' });
  ids.r5 = await newReader({ name: 'Пенка Губеща', card_no: '1005', category: 'пенсионер' });
  ids.rStud = await newReader({ name: 'Елена Ученичка', card_no: '1006', category: 'ученик' });
  ids.rOff = await newReader({ name: 'Христо Прекратен', card_no: '1007', status: 'прекратен' });
  ids.rSusp = await newReader({ name: 'Наказан Читател', card_no: '1008' });
  ids.rSame = await newReader({ name: 'Двоен Учебник', card_no: '1009', category: 'студент' });
  // Читател без съгласие по ОРЗД — API-то го приема.
  const noGdpr = await h.api.readers.create({ name: 'Без Съгласие', card_no: '1010', gdpr_consent: false });
  await soft('НАХОДКА: readers:create приема читател без съгласие по ОРЗД/чл. 47', async () => {
    // НАХОДКА: формата (saveReader) отказва запис без отметнато съгласие, а обработчикът
    // readers:create — не. Всеки друг път (мобилен, внос, API) вписва читател без съгласие.
    assert.equal(noGdpr.ok, false, 'очаква се отказ, получено: ' + JSON.stringify(noGdpr));
  });
  if (noGdpr.ok) ids.rNoGdpr = noGdpr.data;
  /* v2.4.61: щом създаването вече се отказва, читателят БЕЗ съгласие се появява по
     единствения останал път — оттегляне на веднъж даденото съгласие (право на
     гражданина, затова readers:update не се отказва). Точно този читател трябва да
     не може да заема — виж стъпка 3. */
  if (!noGdpr.ok) {
    const withdrawn = await newReader({ name: 'Оттеглил Съгласие', card_no: '1010' });
    ok(await h.api.readers.update({ id: withdrawn, name: 'Оттеглил Съгласие', card_no: '1010', gdpr_consent: 0 }), 'оттегляне на съгласието');
    assert.equal(q('SELECT gdpr_consent FROM readers WHERE id = ?', withdrawn).gdpr_consent, 0);
    ids.rNoGdpr = withdrawn;
  }
  assert.equal((await h.api.readers.create({ name: 'Дубликат', card_no: '1001', gdpr_consent: true })).error,
    'Тази читателска карта вече е издадена на друг читател.');
  noRendererErrors();
});

/* ==================================================================
   2. Гише: карта, документ, разписка, същият документ втори път
   ================================================================== */
test('2. гишето: сканиране на карта и на документ, разписка за заемане, повторно сканиране', async () => {
  await desk();
  let n = h.toasts.length;
  await h.scan('#pScan', '9999');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && t.msg === 'Няма читател с тази карта.'));
  assert.ok(!h.$('#bScan'), 'без читател няма поле за документ');

  await selectReader('1001');
  assert.match(h.viewText(), /Иван Читателов Карта 1001 · възрастен · заети: 0 \/ 3/);
  assert.match(h.viewText(), /Срок за заемане: 14 дни · до 2 продължения/);

  // Заемане по баркод.
  let r = await scanOut('BC0001');
  const due1 = E.nextWorkDay(h.db, E.addDays(T, 14));
  assert.equal(due1, q('SELECT date_due FROM loans WHERE book_id = ?', ids.b1).date_due, 'падеж = 14 дни + следващ работен ден');
  assert.match(r.log, rx('Под игото (инв. 1) — заета до ' + E.bgDate(due1)));
  assert.ok(r.toasts.some(t => t.type === 'ok' && t.msg === 'Заемане: инв. № 1 до ' + E.bgDate(due1)), JSON.stringify(r.toasts));
  assert.match(h.text('#circCount'), /заети: 1 \/ 3/);
  const l1 = openLoan(ids.b1); ids.l1 = l1.id;
  assert.equal(l1.reader_id, ids.r1); assert.equal(l1.date_out, T); assert.equal(l1.renewals, 0); assert.equal(l1.fine, 0);
  const ev = q("SELECT * FROM events WHERE kind = 'заемане' AND book_id = ?", ids.b1);
  assert.ok(ev, 'събитие „заемане“'); assert.equal(ev.date, T); assert.equal(ev.reader_id, ids.r1);
  assert.equal(ev.reader_category, 'възрастен'); assert.equal(ev.book_udk, '821.163.2-31'); assert.equal(ev.book_category, 'книга');
  const a = lastAudit('Заемане');
  assert.match(a.detail, /инв\. № 1 — Под игото/);
  await soft('НАХОДКА: одитната следа „Заемане“ не назовава читателя', async () => {
    // НАХОДКА: „Заемане: инв. № 1 — Под игото“ — кой е взел книгата не личи от следата
    // (нито в „Днес на гишето“, който я показва). Проверяващият трябва да чете loans.
    assert.match(a.detail, /Иван Читателов|карта 1001/);
  });

  // Разписка за заемане.
  await h.clickButton('Разписка', '#outLog');
  const p = h.printed();
  assert.match(p, /РАЗПИСКА ЗА ЗАЕМАНЕ/);
  assert.match(p, rx('Дата: ' + E.bgDate(T)));
  assert.match(p, /Читател: Иван Читателов \(карта 1001\)/);
  assert.match(p, /Документ: Под игото \(инв\. № 1\)/);
  assert.match(p, rx('Срок за връщане: ' + E.bgDate(due1)));
  assert.match(p, /Библиотека „Изпитание“/);
  h.window.ppClose();

  // Същият документ втори път — по инв. № този път.
  r = await scanOut('1');
  assert.match(r.log, /Инв\. № 1 вече е зает от Иван Читателов до/);
  assert.equal(all('SELECT 1 FROM loans WHERE book_id = ?', ids.b1).length, 1, 'няма второ заемане');
  await soft('НАХОДКА: датата в „вече е зает от … до“ е в ISO формат', async () => {
    // НАХОДКА: съобщението казва „до 2026-10-01“, докато навсякъде другаде на гишето
    // датите са „01.10.2026“.
    assert.match(r.log, rx('до ' + E.bgDate(due1)));
  });
  // Несъществуващ код, празен код.
  r = await scanOut('НЯМА-ТАКЪВ');
  assert.match(r.log, /Няма документ с баркод\/инв\. № „НЯМА-ТАКЪВ“/);
  assert.equal(q('SELECT COUNT(*) AS n FROM loans').n, 1);
  // Гишето показва заетото в таблицата.
  await selectReader('1001');
  assert.match(h.text(loanRow(1)), rx('1 Под игото ' + E.bgDate(T) + ' ' + E.bgDate(due1) + ' 0 / 2'));
  noRendererErrors();
});

/* ==================================================================
   3. Лимит по категория на границата; наказан, прекратен, несъществуващ, без съгласие
   ================================================================== */
test('3. лимитът от документи на границата и читатели, на които не бива да се заема', async () => {
  await selectReader('1006');
  assert.match(h.viewText(), /Елена Ученичка Карта 1006 · ученик · заети: 0 \/ 2/);
  assert.match(h.viewText(), /Срок за заемане: 14 дни · до 1 продължение/);
  let r = await scanOut('2'); assert.match(r.log, /Тютюн \(инв\. 2\) — заета до/);
  r = await scanOut('3'); assert.match(r.log, /Железният светилник \(инв\. 3\) — заета до/);
  assert.match(h.text('#circCount'), /заети: 2 \/ 2/);
  r = await scanOut('4');
  assert.match(r.log, /Достигнат е лимитът от 2 документа за читател/);
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ? AND date_in IS NULL', ids.rStud).n, 2);
  assert.equal(q('SELECT COUNT(*) AS n FROM events WHERE reader_id = ?', ids.rStud).n, 2, 'отказът не оставя събитие');
  // Върната една — веднага може пак.
  ok(await h.api.loans.return({ id: openLoan(ids.b3).id, date_in: T }), 'връщане');
  ok(await h.api.loans.checkoutByCode({ reader_id: ids.rStud, code: '4', date_out: T }), 'след връщане лимитът пуска');
  ok(await h.api.loans.return({ id: openLoan(ids.b4).id, date_in: T }), 'връщане');
  ok(await h.api.loans.return({ id: openLoan(ids.b2).id, date_in: T }), 'връщане');

  // Наказан читател: до утре — отказ; точно до днес — пуска (границата е „> днес“).
  h.db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run(E.addDays(T, 1), ids.rSusp);
  await selectReader('1008');
  assert.match(h.viewText(), rx('Заемането е преустановено до ' + E.bgDate(E.addDays(T, 1))));
  r = await scanOut('2');
  assert.match(r.log, rx('Заемането за Наказан Читател е преустановено до ' + E.bgDate(E.addDays(T, 1)) + ' заради просрочени връщания'));
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ?', ids.rSusp).n, 0);
  h.db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run(T, ids.rSusp);
  ok(await h.api.loans.checkoutByCode({ reader_id: ids.rSusp, code: '2', date_out: T }), 'наказание до днес включително не спира');
  ok(await h.api.loans.return({ id: openLoan(ids.b2).id, date_in: T }), 'връщане');
  // „Снеми“ от гишето — следа.
  h.db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run(E.addDays(T, 30), ids.rSusp);
  await selectReader('1008');
  h.hooks.confirmAnswer = true;
  await h.clickButton('Снеми', '#view');
  assert.equal(q('SELECT suspended_until FROM readers WHERE id = ?', ids.rSusp).suspended_until, null);
  assert.equal(lastAudit('Снето наказание').detail, 'Наказан Читател');

  // Прекратен читател.
  await selectReader('1007');
  /* v2.4.61: гишето го КАЗВА още при избора на читателя — както казва и
     наказанието, — а не чак след сканирането на книгата. */
  assert.match(h.viewText(), /Регистрацията на този читател е прекратена — заемане не се допуска/);
  r = await scanOut('2');
  await soft('НАХОДКА: заемане на читател със състояние „прекратен“', async () => {
    // НАХОДКА: нито гишето, нито loans:checkout/checkoutByCode гледат readers.status —
    // прекратената регистрация заема като активна.
    assert.ok(/прекратен/.test(r.log), 'очаква се отказ; журнал: ' + r.log);
    assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ?', ids.rOff).n, 0);
  });
  const offLoan = openLoan(ids.b2);
  if (offLoan && offLoan.reader_id === ids.rOff) ok(await h.api.loans.return({ id: offLoan.id, date_in: T }), 'връщане');

  // Читател без съгласие по ОРЗД (създаден през API).
  if (ids.rNoGdpr) {
    const rr = await h.api.loans.checkoutByCode({ reader_id: ids.rNoGdpr, code: '2', date_out: T });
    await soft('НАХОДКА: заемане на читател без съгласие по ОРЗД/чл. 47', async () => {
      assert.equal(rr.ok, false, 'очаква се отказ, получено: ' + JSON.stringify(rr));
    });
    if (rr.ok) ok(await h.api.loans.return({ id: rr.data.id, date_in: T }), 'връщане');
  }
  // Несъществуващ читател.
  const nx = await h.api.loans.checkoutByCode({ reader_id: 99999, code: '2', date_out: T });
  assert.equal(nx.ok, false, 'несъществуващ читател се отказва');
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE reader_id = 99999').n, 0);
  await soft('НАХОДКА: съобщението при несъществуващ читател е неразбираемо', async () => {
    // НАХОДКА: отказът идва чак от външния ключ и гласи „Действието е невъзможно, защото
    // записът е свързан с други данни.“ — нищо за читателя.
    assert.match(nx.error, /читател/i);
  });
  const nx2 = await h.api.loans.checkout({ reader_id: 99999, book_id: ids.b2, date_out: T });
  assert.equal(nx2.ok, false);
  noRendererErrors();
});

/* ==================================================================
   4. Падеж през уикенд и затворен ден; отчислен документ
   ================================================================== */
test('4. падежът прескача събота/неделя и затворения ден; отчислен документ не се заема', async () => {
  // S0 е събота: S0 + 14 = събота → понеделник M1, но M1 е затворен → вторник.
  const lid = ok(await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b5, date_out: S0 }), 'заемане със задна дата');
  const l = q('SELECT * FROM loans WHERE id = ?', lid);
  assert.equal(dow(E.addDays(S0, 14)), 6, 'фикстурата: S0+14 е събота');
  assert.equal(l.date_due, E.addDays(M1, 1), 'падежът прескача уикенда И затворения понеделник');
  assert.equal(l.date_due, E.nextWorkDay(h.db, E.addDays(S0, 14)), 'съвпада с огледалото');
  assert.equal(q('SELECT date FROM events WHERE kind = ? AND book_id = ?', 'заемане', ids.b5).date, S0, 'събитието носи датата на заемане');
  // Без затворения ден — понеделник.
  ok(await h.api.calendar.removeClosed(M1), 'махане на затворения ден');
  const lid2 = ok(await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b9, date_out: S0 }), 'заемане 2');
  assert.equal(q('SELECT date_due FROM loans WHERE id = ?', lid2).date_due, M1, 'без затворен ден падежът е понеделник');
  ok(await h.api.calendar.addClosed({ date: M1, reason: 'отпуск' }), 'затвореният ден се връща');
  ok(await h.api.loans.return({ id: lid2, date_in: M1 }), 'върната на падежа');
  assert.equal(q('SELECT fine FROM loans WHERE id = ?', lid2).fine, 0);
  // Заемане на неработен ден (събота) — програмата го приема; падежът е работен.
  assert.equal(dow(S0), 6);
  // Отчислен документ — акт по чл. 30, т. 4.
  ok(await h.api.loans.return({ id: lid, date_in: E.addDays(M1, 1) }), 'връщане на падежа (вторник)');
  const actId = ok(await h.api.deaccessionActs.create({
    act: { no: 1, date: T, reason_code: 4, reason_text: 'физически изхабени', disposal: 'вторични суровини',
      committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' },
    bookIds: [ids.b9]
  }), 'акт');
  ids.act1 = actId;
  assert.equal(q('SELECT status FROM books WHERE id = ?', ids.b9).status, 'отчислен');
  await selectReader('1001');
  const r = await scanOut('9');
  assert.match(r.log, /Инв\. № 9 е отчислен от фонда/);
  assert.equal((await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b9, date_out: T })).error, 'Инв. № 9 е отчислен от фонда.');
  assert.equal((await h.api.holds.add({ reader_id: ids.r1, code: '9' })).error, 'Инв. № 9 е отчислен от фонда.');
  noRendererErrors();
});

/* ==================================================================
   5. Връщане: на падежа, ден по-късно, през затворен период — глоба и наказание
   ================================================================== */
test('5. връщане на падежа / с един ден / през затворен период — обезщетение и наказание в дни', async () => {
  assert.equal(dow(W), 3, 'фикстурата: W е сряда');
  const mk = async (bookId) => {
    const id = ok(await h.api.loans.checkout({ reader_id: ids.r2, book_id: bookId, date_out: E.addDays(W, -14) }), 'заемане');
    h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(W, id);
    return id;
  };
  // Четирите заемания се вписват ПРЕДИ връщанията: наказаният читател (виж (б) по-долу)
  // не може да получи заемане дори със задна дата — checkSuspended гледа днес.
  const la = await mk(ids.b2), lb = await mk(ids.b3), lc = await mk(ids.b4);
  assert.match((await h.api.loans.checkout({ reader_id: ids.r2, book_id: ids.b6, date_out: E.addDays(W, -14) })).error, /Достигнат е лимитът от 3 документа/);
  // (а) на падежа
  let res = ok(await h.api.loans.return({ id: la, date_in: W }), 'връщане на падежа');
  const ld = await mk(ids.b6); // след връщането има място за четвъртото
  assert.deepEqual([res.daysLate, res.fine, res.suspendedUntil, res.hold], [0, 0, null, null]);
  assert.equal(q('SELECT suspended_until FROM readers WHERE id = ?', ids.r2).suspended_until, null);
  assert.equal(q('SELECT date_in FROM loans WHERE id = ?', la).date_in, W);
  // (б) един ден (четвъртък) — 1 работен ден забава, 0.10 €, наказание до утре (базата е ДНЕС)
  res = ok(await h.api.loans.return({ id: lb, date_in: E.addDays(W, 1) }), 'връщане с 1 ден');
  assert.equal(res.daysLate, 1);
  assert.equal(cents(res.fine), 0.10);
  assert.equal(res.suspendedUntil, E.addDays(T, 1), 'наказанието тръгва от днес, не от датата на връщане');
  assert.match(lastAudit('Връщане').detail, /инв\. № 3 — Железният светилник \(забава 1 ден\)/);
  assert.match(lastAudit('Наложено наказание').detail, rx('преустановено заемане до ' + E.addDays(T, 1) + ' (1 работен ден забава)'));
  assert.equal(q("SELECT COUNT(*) AS n FROM events WHERE kind = 'връщане' AND book_id = ? AND date = ?", ids.b3, E.addDays(W, 1)).n, 1, 'събитието носи датата на връщане');
  // (в) 12 календарни дни по-късно (понеделник) — минус 4 уикенд дни (и затворения M1, ако е в периода)
  const inC = E.addDays(W, 12);
  const effC = E.effectiveDaysLate(h.db, W, inC);
  assert.ok(effC >= 7 && effC <= 8, 'фикстурата: 12 календарни дни = 7–8 работни, има ' + effC);
  res = ok(await h.api.loans.return({ id: lc, date_in: inC }), 'връщане през затворен период');
  assert.equal(res.daysLate, effC);
  assert.equal(cents(res.fine), cents(effC * 0.10));
  assert.equal(cents(q('SELECT fine FROM loans WHERE id = ?', lc).fine), cents(effC * 0.10));
  // Наказанието се натрупва върху вече наложеното (T+1), не върху днес.
  assert.equal(res.suspendedUntil, E.addDays(E.addDays(T, 1), effC));
  assert.equal(q('SELECT suspended_until FROM readers WHERE id = ?', ids.r2).suspended_until, res.suspendedUntil);
  // Повторно „Приеми“ на същото заемане — отказ, наказанието не се удвоява.
  const again = await h.api.loans.return({ id: lc, date_in: T });
  assert.equal(again.ok, false); assert.match(again.error, /вече е върнато/);
  assert.equal(q('SELECT suspended_until FROM readers WHERE id = ?', ids.r2).suspended_until, res.suspendedUntil);
  // Таванът: 200 дни забава при таван 90 → до днес + 90, но не под вече наложеното.
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(E.addDays(T, -300), ld);
  // Заемане със задна дата на наказан читател — отказ (правилото гледа днес).
  const sd = await h.api.loans.checkout({ reader_id: ids.r2, book_id: ids.b7, date_out: E.addDays(W, -14) });
  assert.equal(sd.ok, false); assert.match(sd.error, /преустановено до/);
  res = ok(await h.api.loans.return({ id: ld, date_in: T }), 'връщане с огромна забава');
  assert.equal(res.suspendedUntil, E.addDays(T, 90), 'таванът е 90 дни от днес');
  assert.equal(cents(res.fine), cents(res.daysLate * 0.10));
  await soft('НАХОДКА: loans.fine се записва с плаваща грешка (не е закръглено до стотинка)', async () => {
    // Бележка: daysLate * fine_per_day (напр. 3 × 0.10 = 0.30000000000000004) влиза в базата
    // незакръглено; markLost закръгля (toCents), return/extend — не.
    const bad = all('SELECT id, fine FROM loans WHERE reader_id = ?', ids.r2).filter(x => x.fine !== cents(x.fine));
    assert.equal(bad.length, 0, 'незакръглени: ' + JSON.stringify(bad));
  });
  // Снемане на наказание на несъществуващ читател.
  const cs = await h.api.readers.clearSuspension(99999);
  await soft('НАХОДКА: readers:clearSuspension на несъществуващ читател връща ok и вписва следа', async () => {
    assert.equal(cs.ok, false, 'получено: ' + JSON.stringify(cs) + '; следа: ' + lastAudit('Снето наказание').detail);
  });
  // Глобата НЕ стига до читателската сметка — гишето казва „Дължи по сметка“ само за account_lines.
  const acc = ok(await h.api.account.get(ids.r2), 'сметка');
  const finesR2 = cents(all('SELECT fine FROM loans WHERE reader_id = ?', ids.r2).reduce((s, l) => s + (l.fine || 0), 0));
  assert.ok(finesR2 > 0);
  await soft('НАХОДКА: начисленото обезщетение за забава не влиза в читателската сметка', async () => {
    // НАХОДКА: loans.fine се начислява при връщане, но никой не го вписва в account_lines;
    // гишето показва „Дължи по сметка“ без него, а „Събрани обезщетения“ в годишния отчет
    // брои само ръчно вписани начисления от вид „обезщетение“.
    assert.equal(cents(acc.balance), finesR2, 'сметката трябва да носи начисленото обезщетение');
  });
  await selectReader('1002');
  assert.match(h.viewText(), rx('Заемането е преустановено до ' + E.bgDate(E.addDays(T, 90))));
  ok(await h.api.readers.clearSuspension(ids.r2), 'снемане');
  noRendererErrors();
});

/* ==================================================================
   6. Продължения: брой и лимит, продължение на просрочено, връщане след това
   ================================================================== */
test('6. продължения — броят, лимитът, просрочено заемане и връщането след него', async () => {
  await selectReader('1003');
  let r = await scanOut('2');
  assert.match(r.log, /Тютюн \(инв\. 2\) — заета до/);
  const loan = openLoan(ids.b2); ids.lExt = loan.id;
  await selectReader('1003');
  // 1-во продължение от бутона на гишето.
  let n = h.toasts.length;
  await h.clickButton('Продължи', loanRow(2));
  const due2 = E.nextWorkDay(h.db, E.addDays(loan.date_due, 14));
  assert.ok(h.toastsSince(n).some(t => t.type === 'ok' && t.msg === 'Срокът е продължен до ' + E.bgDate(due2) + ' (продължение 1/2).'), JSON.stringify(h.toastsSince(n)));
  let l = q('SELECT * FROM loans WHERE id = ?', loan.id);
  assert.equal(l.date_due, due2); assert.equal(l.renewals, 1);
  assert.equal(q("SELECT COUNT(*) AS n FROM events WHERE kind = 'подновяване' AND book_id = ?", ids.b2).n, 1);
  const ea = lastAudit('Продължение на заемане');
  assert.match(ea.detail, rx('заемане № ' + loan.id + ' до ' + due2 + ' (1/2)'));
  await soft('НАХОДКА: следата „Продължение на заемане“ не назовава нито документа, нито читателя', async () => {
    assert.match(ea.detail, /Тютюн|инв\. № 2/);
  });
  assert.match(h.text(loanRow(2)), /1 \/ 2/);
  // 2-ро — от екрана „Просрочени“ го няма (не е просрочено); от гишето.
  await h.clickButton('Продължи', loanRow(2));
  l = q('SELECT * FROM loans WHERE id = ?', loan.id);
  assert.equal(l.renewals, 2);
  const due3 = E.nextWorkDay(h.db, E.addDays(due2, 14));
  assert.equal(l.date_due, due3);
  // 3-то: бутонът е изключен, а API отказва.
  const btn = h.button('Продължи', loanRow(2));
  assert.equal(btn.disabled, true, 'бутонът „Продължи“ е изключен при достигнат лимит');
  const over = await h.api.loans.extend({ id: loan.id });
  assert.equal(over.ok, false); assert.equal(over.error, 'Достигнат е лимитът от 2 продължения за това заемане.');
  assert.equal(q('SELECT renewals FROM loans WHERE id = ?', loan.id).renewals, 2);
  ok(await h.api.loans.return({ id: loan.id, date_in: T }), 'връщане');
  assert.equal((await h.api.loans.extend({ id: loan.id })).error, 'Заемането не е активно.');
  // Ученик: 1 продължение.
  const ls = ok(await h.api.loans.checkoutByCode({ reader_id: ids.rStud, code: '2', date_out: T }), 'ученик');
  ok(await h.api.loans.extend({ id: ls.id }), 'първо продължение на ученик');
  assert.equal((await h.api.loans.extend({ id: ls.id })).error, 'Достигнат е лимитът от 1 продължения за това заемане.');
  ok(await h.api.loans.return({ id: ls.id, date_in: T }), 'връщане');

  // Продължение на ПРОСРОЧЕНО заемане от „Просрочени“: урежда забавата, срокът тръгва от днес.
  const lo = ok(await h.api.loans.checkout({ reader_id: ids.r3, book_id: ids.b2, date_out: E.addDays(W, -14) }), 'заемане');
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(W, lo);
  const late = E.effectiveDaysLate(h.db, W, T);
  assert.ok(late > 0);
  await h.go('over');
  assert.match(h.viewText(), rx('Общо дължимо обезщетение: ' + E.mny(cents(late * 0.10))));
  assert.match(h.text('#ovBody'), rx('Георги Продължаващ 2 Тютюн ' + E.bgDate(W) + ' ' + late + ' '));
  n = h.toasts.length;
  await h.clickButton('Продължи', '#ovBody');
  const ts = h.toastsSince(n);
  const dueO = E.nextWorkDay(h.db, E.addDays(T, 14));
  assert.ok(ts.some(t => t.msg === 'Срокът е продължен до ' + E.bgDate(dueO) + ' (продължение 1/2).'), JSON.stringify(ts));
  assert.ok(ts.some(t => t.type === 'err' && t.msg === 'Начислена забава ' + late + (late === 1 ? ' ден' : ' дни') + ' — обезщетение ' + E.mny(cents(late * 0.10)) + '.'), JSON.stringify(ts));
  assert.ok(ts.some(t => t.type === 'err' && /Наложено наказание: заемането е преустановено до/.test(t.msg)), JSON.stringify(ts));
  l = q('SELECT * FROM loans WHERE id = ?', lo);
  assert.equal(l.date_due, dueO); assert.equal(l.renewals, 1); assert.equal(cents(l.fine), cents(late * 0.10));
  assert.equal(q('SELECT suspended_until FROM readers WHERE id = ?', ids.r3).suspended_until, E.addDays(T, late));
  assert.match(h.viewText(), /Няма просрочени заемания|Показани са/);
  assert.ok(!/Георги Продължаващ/.test(h.text('#ovBody') || ''), 'слиза от списъка на просрочените');
  // Връщането след продължението пази начисленото.
  const rr = ok(await h.api.loans.return({ id: lo, date_in: T }), 'връщане');
  assert.equal(rr.daysLate, 0); assert.equal(cents(rr.fine), cents(late * 0.10)); assert.equal(rr.fineNow, 0);
  assert.equal(rr.suspendedUntil, null, 'без нова забава няма ново наказание');
  assert.equal(cents(q('SELECT fine FROM loans WHERE id = ?', lo).fine), cents(late * 0.10));
  ok(await h.api.readers.clearSuspension(ids.r3), 'снемане');
  noRendererErrors();
});

/* ==================================================================
   7. Резервации: заета книга, връщане „НЕ връщайте на рафта“, заемане от резервиралия
   ================================================================== */
test('7. резервация върху заета книга — при връщане не се връща на рафта, взима я само чакащият', async () => {
  // Свободна книга не се резервира.
  const free = await h.api.holds.add({ reader_id: ids.r4, code: '2' });
  assert.equal(free.ok, false); assert.match(free.error, /Инв\. № 2 е свободен — заемете го направо/);
  // Иван държи инв. № 1 (от стъпка 2); Стоян я резервира; Георги опитва да я заеме.
  assert.ok(openLoan(ids.b1), 'инв. № 1 е у Иван');
  const hd = ok(await h.api.holds.add({ reader_id: ids.r4, code: 'BC0001' }), 'резервация');
  assert.equal(hd.queue, 1);
  assert.equal((await h.api.holds.add({ reader_id: ids.r4, code: '1' })).error, 'Този читател вече има резервация за книгата.');
  assert.equal((await h.api.holds.add({ reader_id: ids.r1, code: '1' })).error, 'Читателят в момента държи тази книга.');
  assert.match(lastAudit('Резервация').detail, /инв\. № 1 — Под игото за Стоян Чакащ/);
  // Иван не може да продължи — резервирана е за друг.
  const ext = await h.api.loans.extend({ id: ids.l1 });
  assert.equal(ext.ok, false); assert.match(ext.error, /резервирана от Стоян Чакащ/);
  // Резервациите на читателя се виждат на гишето.
  await selectReader('1004');
  assert.match(h.viewText(), /Резервации на този читател/);
  assert.match(h.viewText(), /1 Под игото .* чака/);
  // Връщане чрез сканиране → „НЕ връщайте на рафта“.
  const rb = await returnByScan('BC0001');
  assert.match(rb.log, /Под игото \(инв\. 1\) — върната от Иван Читателов/);
  assert.match(rb.log, /НЕ връщайте на рафта — заделена за Стоян Чакащ \(карта 1004, тел\. 0899 000 004\)/);
  assert.ok(rb.toasts.some(t => t.type === 'err' && t.msg === '📌 Заделена за Стоян Чакащ — не се връща на рафта!'), JSON.stringify(rb.toasts));
  const hold = q('SELECT * FROM holds WHERE id = ?', hd.id);
  assert.equal(hold.status, 'заделена'); assert.ok(hold.ready_at);
  assert.match(lastAudit('Заделена книга').detail, /инв\. № 1 — Под игото за Стоян Чакащ/);
  assert.equal(ok(await h.api.books.get(ids.b1), 'get').available, 1, 'книгата вече не е заета');
  // Георги (трети) не може да я вземе; списъкът „Резервации“ я показва.
  await selectReader('1003');
  let r = await scanOut('1');
  assert.match(r.log, /Книгата е резервирана за Стоян Чакащ \(заделена, чака взимане\)/);
  await h.go('circ'); await h.clickButton('Резервации', '#view');
  assert.match(h.viewText(), /1 Под игото Стоян Чакащ \(1004\) .* заделена — чака взимане/);
  // Стоян я взима — резервацията става „изпълнена“.
  await selectReader('1004');
  r = await scanOut('1');
  assert.match(r.log, /Под игото \(инв\. 1\) — заета до/);
  assert.equal(q('SELECT status FROM holds WHERE id = ?', hd.id).status, 'изпълнена');
  assert.equal(openLoan(ids.b1).reader_id, ids.r4);
  // Втора резервация от Иван; при отказ на заделената следващият се повиква.
  ok(await h.api.holds.add({ reader_id: ids.r1, code: '1' }), 'резервация 2');
  ok(await h.api.holds.add({ reader_id: ids.r3, code: '1' }), 'резервация 3');
  const rb2 = ok(await h.api.loans.returnByCode({ code: '1', date_in: T }), 'връщане');
  assert.equal(rb2.hold.reader_name, 'Иван Читателов');
  const hIvan = q("SELECT * FROM holds WHERE reader_id = ? AND book_id = ? AND status = 'заделена'", ids.r1, ids.b1);
  const cn = ok(await h.api.holds.cancel(hIvan.id), 'отказ');
  assert.equal(cn.next.reader_name, 'Георги Продължаващ', 'следващият по опашката се повиква');
  const hG = q("SELECT * FROM holds WHERE reader_id = ? AND book_id = ? AND status = 'заделена'", ids.r3, ids.b1);
  ok(await h.api.holds.cancel(hG.id), 'отказ и на нея');
  assert.equal(q("SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND status IN ('чака','заделена')", ids.b1).n, 0);
  noRendererErrors();
});

/* ==================================================================
   8. Връщане на незаето / несъществуващо; двете бройки от едно заглавие
   ================================================================== */
test('8. връщане на незает документ; два екземпляра от едно заглавие у един читател', async () => {
  let rb = await returnByScan('2');
  assert.match(rb.log, /Инв\. № 2 не е заето в момента/);
  rb = await returnByScan('777');
  assert.match(rb.log, /Няма документ с баркод\/инв\. № „777“/);
  rb = await returnByScan('9');
  assert.match(rb.log, /Инв\. № 9 не е заето в момента/, 'отчисленият също не е зает');
  assert.equal(q("SELECT COUNT(*) AS n FROM events WHERE kind = 'връщане' AND date = ?", T).n,
    q("SELECT COUNT(*) AS n FROM loans WHERE date_in = ? AND deaccession_act_id IS NULL AND COALESCE(lost,0) = 0", T).n, 'отказите не оставят събития');

  await selectReader('1009');
  let r = await scanOut('21'); assert.match(r.log, /Учебник по математика \(инв\. 21\)/);
  r = await scanOut('22'); assert.match(r.log, /Учебник по математика \(инв\. 22\)/);
  r = await scanOut('21'); assert.match(r.log, /Инв\. № 21 вече е зает от Двоен Учебник/);
  await selectReader('1009');
  assert.match(h.text('#circCount'), /заети: 2 \/ 3/);
  assert.ok(loanRow(21) && loanRow(22), 'и двата екземпляра са в таблицата');
  // Сканирано връщане на 22 приключва точно заемането на 22.
  rb = await returnByScan('22');
  assert.match(rb.log, /Учебник по математика \(инв\. 22\) — върната от Двоен Учебник/);
  assert.ok(openLoan(ids.b21), 'инв. 21 остава зает');
  assert.equal(openLoan(ids.b22), undefined);
  rb = await returnByScan('21');
  assert.match(rb.log, /върната от Двоен Учебник/);
  assert.ok(rb.toasts.some(t => t.msg === 'Приета обратно: инв. № 21' && t.type === 'ok'), JSON.stringify(rb.toasts));
  noRendererErrors();
});

/* ==================================================================
   9. Заемане и връщане със задна дата; бъдеща дата; връщане преди заемане
   ================================================================== */
test('9. задна дата — падежът и събитието следват датата на заемане; невъзможни дати', async () => {
  const out = E.addDays(T, -20);
  const lid = ok(await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b8, date_out: out }), 'задна дата');
  const l = q('SELECT * FROM loans WHERE id = ?', lid);
  assert.equal(l.date_due, E.nextWorkDay(h.db, E.addDays(out, 14)));
  assert.equal(q("SELECT date FROM events WHERE kind = 'заемане' AND book_id = ?", ids.b8).date, out);
  const sug = ok(await h.api.dnevnik.suggest({ date: out }), 'дневник');
  assert.equal(sug.suggestions.b_type_books, 1); assert.equal(sug.suggestions.b_lang_en, 1); assert.equal(sug.suggestions.b_cat_80, 1, '811 → езикознание');
  assert.equal(sug.suggestions.a_age_o28, 1);
  // Просрочено е (падежът е преди днес) → в „Просрочени“ със същите дни като огледалото.
  const ov = ok(await h.api.loans.overdue(), 'просрочени').find(x => x.id === lid);
  assert.ok(ov); assert.equal(ov.daysLate, E.effectiveDaysLate(h.db, l.date_due, T));
  // Връщане със задна дата (преди 3 дни).
  const inD = E.addDays(T, -3);
  const rr = ok(await h.api.loans.return({ id: lid, date_in: inD }), 'връщане със задна дата');
  assert.equal(rr.daysLate, E.effectiveDaysLate(h.db, l.date_due, inD));
  assert.equal(q("SELECT date FROM events WHERE kind = 'връщане' AND book_id = ?", ids.b8).date, inD);
  ok(await h.api.readers.clearSuspension(ids.r1), 'снемане');

  // Невалидни дати.
  assert.equal((await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b8, date_out: '17.09.2026' })).error, 'Датата на заемане липсва или е невалидна.');
  assert.equal((await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b8, date_out: '' })).error, 'Датата на заемане липсва или е невалидна.');
  assert.match((await h.api.loans.return({ id: lid, date_in: '2026-13-01' })).error || '', /невалидна/);
  const before = q('SELECT COUNT(*) AS n FROM loans').n;
  // Бъдеща дата на заемане.
  const fut = await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b8, date_out: E.addDays(T, 10) });
  await soft('НАХОДКА: заемане с БЪДЕЩА дата се приема', async () => {
    assert.equal(fut.ok, false, 'очаква се отказ, получено: ' + JSON.stringify(fut));
  });
  if (fut.ok) { h.db.prepare('DELETE FROM loans WHERE id = ?').run(fut.data); h.db.prepare("DELETE FROM events WHERE kind = 'заемане' AND book_id = ? AND date = ?").run(ids.b8, E.addDays(T, 10)); }
  // Падеж преди датата на заемане.
  const badDue = await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b8, date_out: T, date_due: E.addDays(T, -5) });
  await soft('НАХОДКА: loans:checkout приема падеж ПРЕДИ датата на заемане', async () => {
    assert.equal(badDue.ok, false, 'очаква се отказ, получено: ' + JSON.stringify(badDue));
  });
  if (badDue.ok) { h.db.prepare('DELETE FROM loans WHERE id = ?').run(badDue.data); h.db.prepare("DELETE FROM events WHERE kind = 'заемане' AND book_id = ? AND date = ? AND id = (SELECT MAX(id) FROM events WHERE book_id = ?)").run(ids.b8, T, ids.b8); }
  // Връщане с дата ПРЕДИ заемането.
  const lx = ok(await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b8, date_out: T }), 'заемане');
  const rbefore = await h.api.loans.return({ id: lx, date_in: E.addDays(T, -2) });
  await soft('НАХОДКА: връщане с дата преди датата на заемане се приема', async () => {
    assert.equal(rbefore.ok, false, 'очаква се отказ, получено: ' + JSON.stringify(rbefore));
  });
  if (!rbefore.ok) ok(await h.api.loans.return({ id: lx, date_in: T }), 'връщане');
  else { h.db.prepare("UPDATE loans SET date_in = ? WHERE id = ?").run(T, lx); h.db.prepare("UPDATE events SET date = ? WHERE kind = 'връщане' AND book_id = ? AND date = ?").run(T, ids.b8, E.addDays(T, -2)); }
  // Бъдеща дата на връщане.
  const ly = ok(await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b8, date_out: T }), 'заемане');
  const rfut = await h.api.loans.return({ id: ly, date_in: E.addDays(T, 5) });
  await soft('НАХОДКА: връщане с БЪДЕЩА дата се приема', async () => {
    assert.equal(rfut.ok, false, 'очаква се отказ, получено: ' + JSON.stringify(rfut));
  });
  if (!rfut.ok) ok(await h.api.loans.return({ id: ly, date_in: T }), 'връщане');
  else { h.db.prepare("UPDATE loans SET date_in = ? WHERE id = ?").run(T, ly); h.db.prepare("UPDATE events SET date = ? WHERE kind = 'връщане' AND book_id = ? AND date = ?").run(T, ids.b8, E.addDays(T, 5)); }
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL AND book_id = ?', ids.b8).n, 0);
  assert.equal(q('SELECT COUNT(*) AS n FROM loans').n, before + 2);
  noRendererErrors();
});

/* ==================================================================
   10. Изгубен документ → обезщетение (чл. 43, ал. 2) → акт по чл. 30, т. 5
   ================================================================== */
test('10. изгубен документ: прозорецът, начислението, състоянието, актът по чл. 30, т. 5', async () => {
  const lid = ok(await h.api.loans.checkout({ reader_id: ids.r5, book_id: ids.b5, date_out: E.addDays(W, -14) }), 'заемане');
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(W, lid);
  const late = E.effectiveDaysLate(h.db, W, T);
  await selectReader('1005');
  assert.match(h.viewText(), /Читателят има просрочени документи/);
  await h.clickButton('Изгубена', loanRow(5));
  await h.waitFor(() => h.$('#lostF'), 'прозорецът за изгубен документ');
  const m = h.modal();
  assert.match(m, /Документът е изгубен — инв\. № 5/);
  assert.match(m, /История на България · Колектив \(инв\. № 5\)/);
  assert.match(m, /Читател: Пенка Губеща \(карта 1005\)/);
  assert.match(m, rx('Забава ' + late + ' дни — начислява се отделно ' + E.mny(cents(late * 0.10))));
  assert.match(m, /Чл\. 43, ал\. 2 от Наредба № 3/);
  assert.match(m, rx('3 × цена по инвентарната книга (' + E.mny(20) + ') = ' + E.mny(60)));
  assert.equal(h.$('#lostF [name=amount]').value, '60.00');
  assert.equal(h.$('#lostF [name=resolution]').value, 'обезщетение');
  // Замяна без указан документ — отказ.
  h.type('#lostF [name=resolution]', 'замяна с идентичен документ');
  h.window.lostFormToggle();
  assert.equal(h.$('#lostRepl').hidden, false); assert.equal(h.$('#lostMoney').hidden, true);
  let n = h.toasts.length;
  await h.clickButton('Приключи като изгубен', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /кой документ е приет вместо изгубения/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT lost FROM loans WHERE id = ?', lid).lost, null);
  // Обезщетение в пари — потвърждение и запис.
  h.type('#lostF [name=resolution]', 'обезщетение');
  h.window.lostFormToggle();
  h.type('#lostF [name=note]', 'Читателката съобщи по телефона.');
  h.hooks.confirmAnswer = true;
  n = h.toasts.length;
  await h.clickButton('Приключи като изгубен', '#modal footer');
  assert.match(h.hooks.confirms[h.hooks.confirms.length - 1], rx('Инв. № 5 се приключва като НЕВЪРНАТ от читателя — ще бъдат начислени ' + E.mny(60) + ' в сметката на Пенка Губеща'));
  const ts = h.toastsSince(n);
  assert.ok(ts.some(t => t.msg === 'Инв. № 5 е приключен като изгубен — начислени ' + E.mny(60) + ' на Пенка Губеща.'), JSON.stringify(ts));
  assert.ok(ts.some(t => /Отчислете документа с акт по чл\. 30, т\. 5/.test(t.msg)));
  assert.ok(ts.some(t => /Наложено наказание/.test(t.msg)));
  const l = q('SELECT * FROM loans WHERE id = ?', lid);
  assert.equal(l.lost, 1); assert.equal(l.date_in, T); assert.equal(l.lost_date, T); assert.equal(l.lost_resolution, 'обезщетение');
  assert.equal(l.lost_amount, 60); assert.equal(cents(l.fine), cents(late * 0.10)); assert.equal(l.lost_note, 'Читателката съобщи по телефона.');
  const line = q('SELECT * FROM account_lines WHERE id = ?', l.lost_account_line_id);
  assert.equal(line.kind, 'начисление'); assert.equal(line.type, 'обезщетение за изгубен документ'); assert.equal(line.amount, 60);
  assert.equal(line.note, 'Невърнат документ инв. № 5 — История на България');
  assert.equal(q('SELECT status, status_date FROM books WHERE id = ?', ids.b5).status, 'изгубен');
  assert.equal(q("SELECT COUNT(*) AS n FROM events WHERE kind = 'изгубен' AND book_id = ?", ids.b5).n, 1);
  assert.equal(q("SELECT COUNT(*) AS n FROM events WHERE kind = 'връщане' AND book_id = ?", ids.b5).n, 1, 'само старото връщане от стъпка 4 — изгубването не е връщане');
  const a = lastAudit('Изгубен документ');
  assert.match(a.detail, /инв\. № 5 — История на България; читател Пенка Губеща \(карта 1005\); обезщетение 60\.00 € \(начислено в читателската сметка\)/);
  assert.match(a.detail, rx('начислена забава ' + late + ' дни'));
  assert.equal(q('SELECT suspended_until FROM readers WHERE id = ?', ids.r5).suspended_until, E.addDays(T, late));
  /* ПРОМЕНЕНО ПОВЕДЕНИЕ (v2.4.61, находка 8 от този сценарий): обезщетението за
     ЗАБАВА вече също влиза в читателската сметка, а не само в loans.fine — виж
     chargeOverdueFine в handlers/account.js. Затова приключването като изгубен
     оставя ДВА реда: обезщетението за самия документ (60.00 €, вид „обезщетение
     за изгубен документ“) и забавата до деня на приключването (вид
     „обезщетение“). Балансът е сборът им; редът на забавата е ВТОРИ, за да се
     покрива пръв онзи по акта (виж бележката при markLost). */
  const lateFine5 = cents(late * 0.10);
  assert.equal(cents(ok(await h.api.account.get(ids.r5), 'сметка').balance), cents(60 + lateFine5));
  // Второ приключване — отказ; загубеният не се заема по нито една врата.
  assert.match((await h.api.loans.markLost({ id: lid, resolution: 'обезщетение', amount: 5 })).error, /вече е приключено .* като изгубен документ/);
  assert.equal(q('SELECT COUNT(*) AS n FROM account_lines WHERE reader_id = ?', ids.r5).n, 2,
    'обезщетението за документа + обезщетението за забавата (v2.4.61)');
  assert.equal(q("SELECT amount FROM account_lines WHERE reader_id = ? AND type = 'обезщетение'", ids.r5).amount, lateFine5);
  await selectReader('1001');
  const r = await scanOut('5');
  assert.match(r.log, /Инв\. № 5 е отбелязан като изгубен\/невърнат/);
  assert.match((await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b5, date_out: T })).error || '', /изгубен\/невърнат/);
  // Гишето при Пенка: дължи по сметка.
  await selectReader('1005');
  // v2.4.61: „Дължи по сметка“ вече включва и обезщетението за забава — точно
  // това беше находка 8 („начисленото обезщетение за забава не влиза в сметката“).
  assert.match(h.viewText(), rx('Дължи по сметка: ' + E.mny(cents(60 + lateFine5))));
  // „Просрочени“ показва панела с изгубените; списъкът за акта.
  await h.go('over');
  assert.match(h.text('#ovLost'), /Изгубени и невърнати документи/);
  assert.match(h.text('#ovLost'), rx('5 История на България Пенка Губеща (1005) ' + E.bgDate(T) + ' обезщетение 60.00 €'));
  assert.match(h.text('#ovLost'), rx('остават ' + E.mny(60)));
  let lost = ok(await h.api.loans.lost({}), 'списък');
  assert.equal(lost.length, 1); assert.equal(lost[0].acted, false); assert.equal(lost[0].charge.outstanding, 60);
  // Частично плащане → „остават“.
  ok(await h.api.account.pay({ reader_id: ids.r5, amount: 25, date: T }), 'плащане');
  lost = ok(await h.api.loans.lost({}), 'списък');
  assert.equal(lost[0].charge.covered, 25); assert.equal(lost[0].charge.outstanding, 35);
  // Актът по чл. 30, т. 5.
  ids.act2 = ok(await h.api.deaccessionActs.create({
    act: { no: 2, date: T, reason_code: 5, reason_text: 'повредени или невърнати от ползватели', disposal: '—',
      committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' },
    bookIds: [ids.b5]
  }), 'акт по т. 5');
  assert.equal(q('SELECT status FROM books WHERE id = ?', ids.b5).status, 'отчислен');
  assert.equal(ok(await h.api.loans.lost({}), 'списък').length, 0, 'след акта изчезва от чакащите');
  lost = ok(await h.api.loans.lost({ includeActed: true }), 'с актуваните');
  assert.equal(lost.length, 1); assert.equal(lost[0].acted, true); assert.equal(lost[0].charge.outstanding, 35);
  assert.match((await h.api.loans.checkoutByCode({ reader_id: ids.r1, code: '5', date_out: T })).error, /отчислен от фонда/);
  // Читателският картон на Пенка.
  await h.go('readers');
  await h.window.printReaderCard(ids.r5); await h.settle();
  const card = h.printed();
  assert.match(card, /ЧИТАТЕЛСКИ КАРТОН № 1005/);
  assert.match(card, /Пенка Губеща/);
  assert.match(card, rx(E.bgDate(E.addDays(W, -14)) + ' 5 История на България ' + E.bgDate(W)));
  await soft('НАХОДКА: картонът печата изгубения документ като „Върнат на“ днес', async () => {
    // НАХОДКА: колоната „Върнат на“ показва date_in и за заемане с lost = 1 — на подписания
    // картон невърнатата книга излиза като върната на датата на приключването.
    assert.ok(!card.includes('История на България ' + E.bgDate(W) + ' ' + E.bgDate(T)), 'изгубеното не бива да е „върнато на ' + E.bgDate(T) + '“; картон: ' + card);
  });
  h.window.ppClose();
  ok(await h.api.readers.clearSuspension(ids.r5), 'снемане');
  noRendererErrors();
});

/* ==================================================================
   11. Второ работно място: остарял екран на гишето и в „Просрочени“
   ================================================================== */
test('11. второто работно място връща книгата, докато екранът тук е стар', async () => {
  const l = ok(await h.api.loans.checkoutByCode({ reader_id: ids.r4, code: '3', date_out: T }), 'заемане');
  await selectReader('1004');
  assert.ok(loanRow(3));
  // Другото място приема връщането.
  const evBefore = q("SELECT COUNT(*) AS n FROM events WHERE kind = 'връщане' AND book_id = ?", ids.b3).n;
  ok(await h.api.loans.returnByCode({ code: '3', date_in: T }), 'връщане от другото място');
  let n = h.toasts.length;
  await h.clickButton('Приеми', loanRow(3));
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /вече е върнато на/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.equal(q("SELECT COUNT(*) AS n FROM events WHERE kind = 'връщане' AND book_id = ?", ids.b3).n, evBefore + 1, 'второто „Приеми“ не вписва второ връщане');
  assert.equal(q('SELECT suspended_until FROM readers WHERE id = ?', ids.r4).suspended_until, null);
  // Продължение на вече върнатото.
  assert.equal((await h.api.loans.extend({ id: l.id })).error, 'Заемането не е активно.');
  // Изгубен — на вече върнатото.
  assert.match((await h.api.loans.lostQuote({ id: l.id })).error, /вече е приключено/);
  noRendererErrors();
});

/* ==================================================================
   12. Напомняния: писмо, степени, регистър; детето и гарантът
   ================================================================== */
test('12. напомняния — сумата е същата като в „Просрочени“, печатът се вписва при потвърждение', async () => {
  // Иван: 2 просрочени (една с 20 дни → степен 2). Ани (дете): 1 просрочена.
  const mkOver = async (rid, bookId, daysAgo) => {
    const id = ok(await h.api.loans.checkout({ reader_id: rid, book_id: bookId, date_out: E.addDays(T, -daysAgo - 14) }), 'заемане');
    h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(E.addDays(T, -daysAgo), id);
    return id;
  };
  ids.lOv1 = await mkOver(ids.r1, ids.b2, 20);
  ids.lOv2 = await mkOver(ids.r1, ids.b3, 3);
  ids.lOvChild = await mkOver(ids.rChild, ids.b6, 5);
  const over = ok(await h.api.loans.overdue(), 'просрочени');
  const sumIvan = cents(over.filter(x => x.reader_id === ids.r1).reduce((s, x) => s + x.fine, 0));
  const rem = ok(await h.api.loans.reminders(), 'напомняния');
  const ivan = rem.find(x => x.reader_id === ids.r1);
  assert.equal(ivan.n, 2); assert.equal(ivan.level, 2, '20 дни ≥ remind2_days=14 → степен 2');
  assert.equal(cents(ivan.fine), sumIvan, 'писмото иска същата сума като „Просрочени“');
  assert.match(ivan.body, /Уважаем\(а\) Иван Читателов/);
  assert.match(ivan.body, /2 просрочени документа/);
  assert.match(ivan.body, /• Димов, Димитър\. Тютюн \(инв\. № 2\), срок/);
  assert.match(ivan.body, rx('Начислено обезщетение към днешна дата: ' + sumIvan.toFixed(2) + ' € (' + (sumIvan * 1.95583).toFixed(2) + ' лв.)'));
  assert.match(ivan.body, /Това е ВТОРО напомняне\./);
  assert.match(ivan.body, /Мария Иванова\nБиблиотека „Изпитание“\nс\. Яворец/);
  assert.match(ivan.sms, rx('Библиотека „Изпитание“: имате 2 просрочени документа, обезщетение ' + sumIvan.toFixed(2) + ' €. Моля, върнете ги.'));
  assert.equal(ivan.lastNotice, null);
  const child = rem.find(x => x.reader_id === ids.rChild);
  assert.equal(child.level, 1);
  await soft('НАХОДКА: напомнянето за дете под 14 г. е до детето, а не до родителя/настойника', async () => {
    // НАХОДКА: loans:reminders чете r.phone/r.email на детето; guarantor_name/guarantor_phone
    // не участват нито в текста, нито в контактите — а формата казва, че „контактът при
    // просрочие е на родителя/настойника“.
    assert.ok(/Петя Детска/.test(child.body) || child.phone === '0888 111 222', 'писмо: ' + child.body + ' / тел.: ' + child.phone);
  });
  // Списъкът „Читатели“ показва заетите и „!“ за просрочие.
  await h.go('readers');
  assert.match(h.text(h.$(`#rBody tr[data-id="${ids.r1}"]`)), /Иван Читателов .* 1001 възрастен активен 2 !/);
  assert.match(h.text(h.$(`#rBody tr[data-id="${ids.rChild}"]`)), /Ани Детска 2006 дете до 14 г\. активен 1 !/);
  // Печат на напомнителните писма от „Просрочени“.
  await h.go('over');
  assert.match(h.viewText(), rx('Общо дължимо обезщетение: ' + E.mny(cents(over.reduce((s, x) => s + x.fine, 0)))));
  await h.clickButton('Печат на напомняния / PDF', '#view');
  const p = h.printed();
  assert.match(p, /НАПОМНИТЕЛНО ПИСМО/);
  assert.match(p, /До: Иван Читателов Адрес: ул\. Първа 1/);
  assert.match(p, /чл\. 43, ал\. 1 от Наредба № 3/);
  assert.match(p, /2 Тютюн/);
  assert.match(p, /Това е ВТОРО напомняне\./);
  assert.match(p, rx('Общо дължимо обезщетение: ' + E.mny(sumIvan) + ' (0.10 €/ден забава'));
  /* ПРОМЕНЕНО ПОВЕДЕНИЕ (v2.4.61, находки 15 и 16 от този сценарий): писмото за
     читател под 14 г. вече е адресирано до родителя/настойника, „чрез“ когото се
     води детето — затова редът „До:“ носи неговото име, а името на детето стои в
     скобата и в текста. Старото твърдение („До: Ани Детска“) беше самата находка. */
  assert.match(p, /До: Петя Детска \(майка\) \(родител на Ани Детска — читател под 14 г\.\)/);
  assert.match(p, /Уважаеми\/а родителю\/настойнико/);
  assert.match(p, /документи, заети от Ани Детска, е изтекъл/);
  // D-F3: писмото носи дата — сумата в него е „към днешна дата“ и без нея е непроверима.
  assert.match(p, rx('Дата: ' + E.bgDate(T) + ' г.'));
  assert.equal(q('SELECT COUNT(*) AS n FROM notice_log').n, 0, 'прегледът не вписва нищо');
  await h.clickButton('Печат…', '#printPreview');
  await h.sleep(400);
  const logs = all('SELECT * FROM notice_log ORDER BY id');
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(x => [x.reader_id, x.level, x.channel, x.loans_count]).sort((a, b) => a[0] - b[0]),
    [[ids.rChild, 1, 'печат', 1], [ids.r1, 2, 'печат', 2]].sort((a, b) => a[0] - b[0]));
  const rem2 = ok(await h.api.loans.reminders(), 'напомняния');
  assert.equal(rem2.find(x => x.reader_id === ids.r1).lastNotice.level, 2);
  // Имейл без валиден адрес.
  assert.equal((await h.api.loans.mailto({ email: '', subject: 'x', body: 'y' })).error, 'Читателят няма записан имейл.');
  noRendererErrors();
});

/* ==================================================================
   13. Читалня +1, посещения, „Днес на гишето“
   ================================================================== */
test('13. „Читалня +1“, посещения и „Днес на гишето“', async () => {
  await desk();
  const before = q("SELECT COUNT(*) AS n FROM events WHERE kind = 'читалня' AND date = ?", T).n;
  let n = h.toasts.length;
  await h.clickButton('Читалня +1', '#view');
  await h.clickButton('Читалня +1', '#view');
  assert.equal(h.toastsSince(n).filter(t => t.msg === '📖 Отбелязано ползване в читалнята за днес.').length, 2);
  assert.equal(q("SELECT COUNT(*) AS n FROM events WHERE kind = 'читалня' AND date = ?", T).n, before + 2);
  ok(await h.api.visits.add({ date: T, count: 5 }), 'посещения');
  assert.equal((await h.api.visits.add({ date: T, count: 0 })).ok, false);
  assert.equal((await h.api.visits.add({ date: T, count: -2 })).ok, false);
  assert.equal(ok(await h.api.visits.get(T), 'get'), 5);
  // „Днес на гишето“: броят е от одитната следа.
  await desk();
  await h.waitFor(() => /заеман/.test(h.text('#circToday')), 'панелът');
  const out = q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'Заемане' AND substr(ts,1,10) = ?", T).n;
  const back = q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'Връщане' AND substr(ts,1,10) = ?", T).n;
  const panel = h.text('#circToday');
  assert.match(panel, rx(out + ' заеман'));
  assert.match(panel, rx(back + ' връщан'));
  assert.ok(out > q('SELECT COUNT(*) AS n FROM loans WHERE date_out = ?', T).n, 'панелът брои и заеманията със задна дата, вписани днес');
  noRendererErrors();
});

/* ==================================================================
   14. Дневник: предложенията за деня срещу потока от събития и заеманията
   ================================================================== */
test('14. дневникът предлага Раздел А/Б от събитията; събитията не удвояват заеманията', async () => {
  const evs = all('SELECT * FROM events WHERE date = ?', T);
  const loansOut = q('SELECT COUNT(*) AS n FROM loans WHERE date_out = ?', T).n;
  assert.equal(evs.filter(e => e.kind === 'заемане').length, loansOut, 'едно събитие „заемане“ на заемане от днес');
  assert.equal(evs.filter(e => e.kind === 'връщане').length,
    q("SELECT COUNT(*) AS n FROM loans WHERE date_in = ? AND deaccession_act_id IS NULL AND COALESCE(lost,0) = 0", T).n, 'едно събитие „връщане“ на връщане от днес');
  assert.equal(evs.filter(e => e.kind === 'изгубен').length, q('SELECT COUNT(*) AS n FROM loans WHERE lost = 1 AND lost_date = ?', T).n);
  const sug = ok(await h.api.dnevnik.suggest({ date: T }), 'предложения').suggestions;
  const outEv = evs.filter(e => e.kind === 'заемане');
  assert.equal(sug.b_type_books, outEv.length);
  assert.equal(sug.b_lang_bg || 0, outEv.filter(e => e.book_language === 'български').length);
  assert.equal(sug.b_cat_fiction || 0, outEv.filter(e => e.book_udk === '821.163.2-31').length);
  assert.equal(sug.b_cat_5 || 0, outEv.filter(e => e.book_udk === '51').length);
  assert.equal(sug.b_cat_child_f || 0, outEv.filter(e => e.book_udk === '82-93').length);
  assert.equal(sug.a_visit_reading, evs.filter(e => e.kind === 'читалня').length);
  const byCat = (c) => new Set(outEv.filter(e => e.reader_category === c).map(e => e.reader_id)).size;
  assert.equal(sug.a_age_15_18 || 0, byCat('ученик'));
  assert.equal(sug.a_age_19_28 || 0, byCat('студент'));
  assert.equal(sug.a_age_o28 || 0, new Set(outEv.filter(e => !['дете до 14 г.', 'ученик', 'студент'].includes(e.reader_category)).map(e => e.reader_id)).size);
  assert.equal(sug.a_age_u14 || 0, byCat('дете до 14 г.'));
  // Върналият, без да е заемал, не е „посещение“ в предложенията — казва се като подобрение.
  // През екрана: „Предложи от регистрите“ пълни само празните полета.
  await h.go('dnevnik');
  await h.window.dnevnikDayForm(T);
  await h.waitFor(() => h.$('#dnvF'), 'формата за деня');
  h.type('#dnvF [name=b_type_books]', 99);
  await h.clickButton('Предложи от регистрите', '#modal');
  assert.equal(h.$('#dnvF [name=b_type_books]').value, '99', 'ръчното число остава');
  assert.equal(h.$('#dnvF [name=a_visit_reading]').value, String(sug.a_visit_reading));
  assert.match(h.text('#dnvSugHint'), /ръчно въведен/);
  await h.clickButton('Отказ', '#modal footer');
  noRendererErrors();
});

/* ==================================================================
   15. Годишен отчет: заемания, читатели, посещения, срокове, обезщетения
   ================================================================== */
test('15. годишният отчет брои заеманията по датата на заемане и връщанията по датата на връщане', async () => {
  const r = ok(await h.api.stats.report(Y), 'отчет');
  assert.equal(r.loansCount, q('SELECT COUNT(*) AS n FROM loans WHERE date_out BETWEEN ? AND ?', Y + '-01-01', Y + '-12-31').n);
  assert.equal(r.readersCount, q("SELECT COUNT(*) AS n FROM readers WHERE substr(registered_at,1,4) = ?", Y).n);
  assert.equal(r.visits, 5); assert.equal(r.visitsRecorded, true);
  const ret = q(`SELECT
      SUM(CASE WHEN deaccession_act_id IS NULL AND COALESCE(lost,0)=0 AND date_in <= date_due THEN 1 ELSE 0 END) AS onTime,
      SUM(CASE WHEN deaccession_act_id IS NULL AND COALESCE(lost,0)=0 AND date_in > date_due THEN 1 ELSE 0 END) AS late,
      SUM(fine) AS fines FROM loans WHERE date_in BETWEEN ? AND ?`, Y + '-01-01', Y + '-12-31');
  assert.equal(r.returnedOnTime, ret.onTime); assert.equal(r.returnedLate, ret.late);
  assert.equal(cents(r.finesCharged), cents(ret.fines));
  assert.equal(r.openOverdue, q("SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL AND date_due < date('now')").n);
  assert.equal(cents(r.finesCollected), 25, 'платените 25 € по изгубения документ са събрано обезщетение');
  assert.ok(r.topLoans.some(x => x.title === 'Тютюн'), 'най-търсеното: ' + JSON.stringify(r.topLoans));
  await h.go('stats');
  assert.match(h.viewText(), rx('Върнати в срок ' + r.returnedOnTime));
  assert.match(h.viewText(), rx('Върнати със забава ' + r.returnedLate));
  assert.match(h.viewText(), rx('Начислени обезщетения ' + E.mny(r.finesCharged)));
  assert.match(h.viewText(), rx('Събрани обезщетения ' + E.mny(25)));
  // Таблото: просрочени и заети.
  const d = ok(await h.api.dashboard.full(), 'табло');
  assert.equal(d.overdueCount, r.openOverdue);
  assert.equal(d.loansOpen, q('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').n);
  assert.equal(d.loansYear, r.loansCount, 'таблото и отчетът броят еднакво');
  assert.ok(d.overdueRows.every(x => x.daysLate === E.effectiveDaysLate(h.db, x.date_due, T)), 'дните на таблото са същите като на гишето');
  await h.go('dash');
  assert.match(h.viewText(), rx(String(d.overdueCount)));
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
