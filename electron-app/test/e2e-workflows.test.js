'use strict';
/* End-to-end: основните работни потоци на библиотекаря, задвижени през ИСТИНСКИЯ
   екранен слой (jsdom) срещу ИСТИНСКИТЕ IPC handler-и и прясна база данни.
   Виж test/helpers/e2e-app.js за харнеса. Тестовете са последователни и градят
   един върху друг (настройки → читател → книга → заемане …), както работният ден.
   Всяко твърдение е върху БАЗАТА или върху РЕНДИРАН ТЕКСТ, никога само „не гръмна“. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const E = require('./helpers/e2e-app');

let h; // харнесът (едно приложение + една база за целия файл)
const T = E.today();
const ids = {}; // идентификатори, създадени по пътя — за следващите тестове

test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

/* Проверка за „тихи“ грешки: необработени отхвърляния/изключения в екранния слой
   се събират от харнеса; всеки тест ги очаква празни. */
/* Познат дефект (документиран от теста „D1“ в края на файла): закъснелият debounce
   на полето за читател на гишето хвърля TypeError върху вече сменения екран.
   Изважда се тук, за да не скрива ДРУГИ грешки в потоците; броят му се пази. */
const KNOWN_DEFECTS = []; // D1 е поправен във v2.4.27 — нищо не се маскира.
function noRendererErrors() {
  const unknown = [];
  for (const e of h.errors) {
    const k = KNOWN_DEFECTS.find(d => d.re.test(e.message || ''));
    if (k) k.seen++; else unknown.push(e);
  }
  h.errors.length = 0;
  if (unknown.length) {
    assert.fail('грешки в екранния слой:\n' + unknown.map(e => e.stack || e.message || String(e)).join('\n---\n'));
  }
}
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);

/* ---- Помощни потоци през интерфейса (ползвани от няколко теста) ---- */
async function newReaderViaForm(o) {
  await h.go('readers');
  await h.clickButton('+ Нов читател', '#view');
  await h.waitFor(() => h.$('#readerF'), 'формата за читател');
  h.type('#readerF [name=name]', o.name);
  h.type('#readerF [name=card_no]', o.card);
  if (o.phone) h.type('#readerF [name=phone]', o.phone);
  if (o.email) h.type('#readerF [name=email]', o.email);
  if (o.category) h.type('#readerF [name=category]', o.category);
  h.type('#readerF [name=gdpr_consent]', true);
  await h.clickButton('Запиши', '#modal footer');
  const row = q('SELECT * FROM readers WHERE card_no = ?', o.card);
  assert.ok(row, 'читателят ' + o.name + ' не е в базата');
  return row.id;
}
async function newBookViaForm(o) {
  await h.go('books');
  await h.clickButton('+ Нова книга', '#view');
  await h.waitFor(() => h.$('#bookF'), 'формата за книга');
  h.type('#bookF [name=inv_number]', o.inv);
  h.type('#bookF [name=title]', o.title);
  h.type('#bookF [name=category_id]', q("SELECT id FROM categories WHERE name = 'книга'").id);
  if (o.author) h.type('#bookF [name=author]', o.author);
  if (o.barcode) h.type('#bookF [name=barcode]', o.barcode);
  if (o.department) h.type('#bookF [name=department]', o.department);
  if (o.price != null) h.type('#bookF [name=price]', o.price);
  await h.clickButton('Запиши', '#modal footer');
  const row = q('SELECT * FROM books WHERE inv_number = ?', o.inv);
  assert.ok(row, 'книгата инв. № ' + o.inv + ' не е в базата: ' + JSON.stringify(h.lastToast()));
  return row.id;
}
/* Гише: избор на читател по карта и заемане по баркод/инв. № чрез сканиране. */
async function selectReaderAtDesk(card) {
  await h.go('circ');
  if (!h.button('Заемане', '#view').classList.contains('pri')) await h.clickButton('Заемане', '#view');
  if (h.$('#circCount')) await h.clickButton('Смени', '#view');
  await h.waitFor(() => h.$('#pScan'), 'полето за читател');
  await h.scan('#pScan', card);
  await h.waitFor(() => h.$('#bScan'), 'полето за сканиране на документ');
}
async function checkoutByScan(card, code) {
  await selectReaderAtDesk(card);
  const n = h.toasts.length;
  await h.scan('#bScan', code);
  const t = h.toastsSince(n).find(x => /Заемане: инв/.test(x.msg));
  assert.ok(t, 'няма известие за заемане; последно: ' + JSON.stringify(h.lastToast()) + ' / лог: ' + h.text('#outLog'));
  const loan = q('SELECT * FROM loans WHERE date_in IS NULL ORDER BY id DESC LIMIT 1');
  return loan;
}
async function returnByScan(code) {
  await h.go('circ');
  await h.clickButton('Връщане', '#view');
  await h.waitFor(() => h.$('#inScan'), 'полето за връщане');
  const n = h.toasts.length;
  await h.scan('#inScan', code);
  return { log: h.text('#inLog'), toasts: h.toastsSince(n) };
}

/* ======================= 1. Първо пускане: настройки ======================= */
test('1. първо пускане — програмата отваря Настройки, записът стига до базата и до лентата', async () => {
  await h.waitFor(() => h.view() === 'setup', 'първото пускане да отвори Настройки');
  await h.settle();
  assert.equal(h.text('#vTitle'), 'Настройки');
  assert.match(h.viewText(), /Първоначална настройка/);
  assert.equal(h.text('#brandName'), 'Попълнете названието в „Настройки“');

  h.type('#view [data-setup-form] [name=org]', 'НЧ „Пробуда – 1927“');
  h.type('#view [data-setup-form] [name=lib_name]', 'Библиотека „Пробуда“');
  h.type('#view [data-setup-form] [name=place]', 'с. Тестово');
  h.type('#view [data-setup-form] [name=librarian]', 'Мария Иванова');
  h.type('#view [data-setup-form] [name=loan_days]', '14');
  h.type('#view [data-setup-form] [name=extensions_count]', '1');
  h.type('#view [data-setup-form] [name=extension_days]', '7');
  h.type('#view [data-setup-form] [name=fine_per_day]', '0.10');
  h.type('#view [data-setup-form] [name=annual_fee]', '5');
  h.type('#view [data-setup-form] [name=committee1]', 'Мария Иванова');
  h.type('#view [data-setup-form] [name=committee2]', 'Петър Петров');
  h.type('#view [data-setup-form] [name=committee3]', 'Ана Счетоводителка');
  await h.clickButton('Запиши настройките', '#stF');

  const s = q('SELECT * FROM settings WHERE id = 1');
  assert.equal(s.org, 'НЧ „Пробуда – 1927“');
  assert.equal(s.lib_name, 'Библиотека „Пробуда“');
  assert.equal(s.place, 'с. Тестово');
  assert.equal(s.loan_days, 14);
  assert.equal(s.extensions_count, 1);
  assert.equal(s.extension_days, 7);
  assert.equal(s.fine_per_day, 0.1);
  assert.equal(s.annual_fee, 5);
  assert.equal(s.committee3, 'Ана Счетоводителка');
  assert.ok(h.toasts.some(t => t.msg === 'Настройките са записани.' && t.type === 'ok'), JSON.stringify(h.toasts));
  assert.equal(h.text('#brandName'), 'Библиотека „Пробуда“');
  assert.equal(h.text('#brandSub'), 'с. Тестово');
  assert.doesNotMatch(h.viewText(), /Първоначална настройка/, 'подканата за първоначална настройка остава след записа');
  assert.ok(q("SELECT 1 FROM audit_log WHERE action = 'Редакция на настройки'"));

  // Служител — за да носи одитната следа име, не „—“.
  await h.clickButton('+ Нов служител', '#view');
  await h.waitFor(() => h.$('#empF, #modal input[name=name]'), 'формата за служител');
  h.type('#modal input[name=name]', 'Мария Иванова');
  await h.clickButton('Запиши', '#modal footer');
  assert.ok(q("SELECT 1 FROM employees WHERE name = 'Мария Иванова'"), 'служителят не е записан');
  await h.click('#userBadge');
  await h.waitFor(() => /Мария Иванова/.test(h.modal()), 'списъка със служители');
  await h.clickButton('Мария Иванова', '#modal');
  assert.equal(h.text('#userBadge'), 'Служител: Мария Иванова');
  const cfg = JSON.parse(fs.readFileSync(path.join(h.app.userData, 'config.json'), 'utf8'));
  assert.equal(cfg.lastUserName, 'Мария Иванова');
  noRendererErrors();
});

/* ======================= 2. Нов читател ======================= */
test('2. нов читател през формата — ред в базата и в списъка', async () => {
  ids.reader1 = await newReaderViaForm({ name: 'Иван Читателов', card: '1001', phone: '0888123456', email: 'ivan@example.bg' });
  const r = q('SELECT * FROM readers WHERE id = ?', ids.reader1);
  assert.equal(r.card_no, '1001');
  assert.equal(r.category, 'възрастен');
  assert.equal(r.status, 'активен');
  assert.equal(r.gdpr_consent, 1);
  assert.equal(r.gdpr_consent_date, T);
  assert.equal(r.registered_at, T);
  assert.ok(h.toasts.some(t => t.msg === 'Читателят е добавен.'));
  assert.equal(h.modalOpen(), false, 'формата остава отворена след успешен запис');
  const row = h.$(`#rBody tr[data-id="${ids.reader1}"]`);
  assert.ok(row, 'редът на читателя липсва в таблицата');
  assert.match(h.text(row), /Иван Читателов.*0888123456.*1001.*възрастен.*активен/);
  const a = q("SELECT * FROM audit_log WHERE action = 'Нов читател' ORDER BY id DESC");
  assert.equal(a.user, 'Мария Иванова');
  assert.match(a.detail, /1001.*Иван Читателов/);
  noRendererErrors();
});

/* ======================= 3. Нова книга ======================= */
test('3. нова книга през формата — в базата, в „Книги“ и в инвентарната книга', async () => {
  ids.book1 = await newBookViaForm({ inv: 101, title: 'Под игото', author: 'Вазов, Иван', barcode: '9789540100001', price: '12.50' });
  const b = q('SELECT b.*, i.quantity FROM books b LEFT JOIN inventory i ON i.book_id = b.id WHERE b.id = ?', ids.book1);
  assert.equal(b.inv_number, 101);
  assert.equal(b.barcode, '9789540100001');
  assert.equal(b.price, 12.5);
  assert.equal(b.status, 'наличен');
  assert.equal(b.register_date, T);
  assert.equal(b.quantity, 1, 'един инвентарен номер = един екземпляр');
  assert.equal(q('SELECT next_inv_number FROM settings').next_inv_number, 102);
  assert.ok(h.toasts.some(t => t.msg === 'Книгата е добавена.'));
  const row = h.$(`#bBody tr[data-id="${ids.book1}"]`);
  assert.ok(row, 'редът на книгата липсва в „Книги“');
  assert.match(h.text(row), /101.*Под игото.*Вазов, Иван.*наличен.*1\/1/);

  await h.go('invbook');
  assert.match(h.text('#ibBody'), /101.*Вазов, Иван.*Под игото/);
  assert.match(h.viewText(), /1 Вписани общо/);
  assert.match(h.viewText(), /Неотчислени 12\.50 лв\./);
  noRendererErrors();
});

/* ======================= 4. Заемане и връщане по баркод ======================= */
test('4. заемане по баркод на гишето, връщане със забава — обезщетение по настройката', async () => {
  const loan = await checkoutByScan('1001', '9789540100001');
  assert.equal(loan.book_id, ids.book1);
  assert.equal(loan.reader_id, ids.reader1);
  assert.equal(loan.date_out, T);
  const expectedDue = E.nextWorkDay(h.db, E.addDays(T, 14));
  assert.equal(loan.date_due, expectedDue, 'падежът не е срок 14 дни + следващ работен ден');
  assert.match(h.text('#outLog'), new RegExp('Под игото \\(инв\\. 101\\) — заета до ' + E.bgDate(expectedDue).replace(/\./g, '\\.')));
  assert.match(h.text('#circCount'), /заети: 1 \/ 5/);
  assert.ok(q("SELECT 1 FROM events WHERE kind = 'заемане' AND book_id = ? AND reader_id = ?", ids.book1, ids.reader1));
  // Втори опит за същия екземпляр се отказва с името на държащия.
  await h.scan('#bScan', '101');
  assert.match(h.text('#outLog'), /Инв\. № 101 вече е зает от Иван Читателов до/);
  assert.equal(all('SELECT 1 FROM loans WHERE book_id = ? AND date_in IS NULL', ids.book1).length, 1);

  // Времето минава: срокът е изтекъл преди 10 дни (фикстура — датата се мести в базата).
  const due = E.addDays(T, -10);
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(due, loan.id);
  const daysLate = E.effectiveDaysLate(h.db, due, T);
  assert.ok(daysLate >= 7 && daysLate <= 10, 'фикстурата очаква 7–10 работни дни забава, има ' + daysLate);
  const fine = Math.round(daysLate * 0.10 * 100) / 100;

  const { log, toasts } = await returnByScan('101');
  assert.match(log, /Под игото \(инв\. 101\) — върната от Иван Читателов/);
  assert.match(log, new RegExp('Забава ' + daysLate + ' дни · обезщетение ' + E.mny(fine).replace(/[.\/]/g, '\\$&')));
  assert.ok(toasts.some(t => t.type === 'err' && t.msg.includes('Върната със забава ' + daysLate + ' дни')), JSON.stringify(toasts));
  const l2 = q('SELECT * FROM loans WHERE id = ?', loan.id);
  assert.equal(l2.date_in, T);
  assert.equal(Math.round(l2.fine * 100) / 100, fine);
  assert.ok(q("SELECT 1 FROM events WHERE kind = 'връщане' AND book_id = ?", ids.book1));
  assert.match(q("SELECT detail FROM audit_log WHERE action = 'Връщане' ORDER BY id DESC").detail, new RegExp('инв. № 101 — Под игото \\(забава ' + daysLate + ' дни\\)'));
  noRendererErrors();
});

/* ======================= 5. Продължение на просрочено, после връщане ======================= */
test('5. продължение на просрочено заемане от „Просрочени“ начислява забавата, връщането я пази', async () => {
  const loan = await checkoutByScan('1001', '101');
  const due = E.addDays(T, -8);
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(due, loan.id);
  const late = E.effectiveDaysLate(h.db, due, T);
  const fine = Math.round(late * 0.10 * 100) / 100;

  await h.go('over');
  assert.match(h.viewText(), new RegExp('Общо дължимо обезщетение: ' + E.mny(fine).replace(/[.\/]/g, '\\$&')));
  const row = h.$('#ovBody tr');
  assert.match(h.text(row), new RegExp('Иван Читателов 101 Под игото ' + E.bgDate(due).replace(/\./g, '\\.') + ' ' + late + ' ' + E.mny(fine).replace(/[.\/]/g, '\\$&')));
  const n = h.toasts.length;
  await h.clickButton('Продължи', '#ovBody');
  const ts = h.toastsSince(n);
  const expectedDue = E.nextWorkDay(h.db, E.addDays(T, 7));
  assert.ok(ts.some(t => t.type === 'ok' && t.msg === 'Срокът е продължен до ' + E.bgDate(expectedDue) + ' (продължение 1/1).'), JSON.stringify(ts));
  assert.ok(ts.some(t => t.type === 'err' && t.msg.startsWith('Начислена забава ' + late + ' дни — обезщетение ' + E.mny(fine))), JSON.stringify(ts));
  const l1 = q('SELECT * FROM loans WHERE id = ?', loan.id);
  assert.equal(l1.date_due, expectedDue);
  assert.equal(l1.renewals, 1);
  assert.equal(Math.round(l1.fine * 100) / 100, fine, 'забавата от продължението не е начислена по заемането');
  assert.match(h.viewText(), /Няма просрочени заемания/);
  assert.ok(q("SELECT 1 FROM events WHERE kind = 'подновяване' AND book_id = ?", ids.book1));

  // Второ продължение е над лимита (1) — отказ на гишето, бутонът е изключен.
  await selectReaderAtDesk('1001');
  const extBtn = h.button('Продължи', '#view');
  assert.equal(extBtn.disabled, true, 'бутонът „Продължи“ не е изключен при достигнат лимит');
  assert.match(h.viewText(), /1 \/ 1/);

  const { log, toasts } = await returnByScan('101');
  assert.match(log, new RegExp('Дължимо обезщетение по това заемане: ' + E.mny(fine).replace(/[.\/]/g, '\\$&')));
  assert.ok(toasts.some(t => t.msg.startsWith('Приета обратно: инв. № 101 — дължимо обезщетение ' + E.mny(fine))), JSON.stringify(toasts));
  const l2 = q('SELECT * FROM loans WHERE id = ?', loan.id);
  assert.equal(l2.date_in, T);
  assert.equal(Math.round(l2.fine * 100) / 100, fine, 'връщането след продължение е заличило начисленото');
  noRendererErrors();
});

/* ======================= 6. Резервации ======================= */
test('6. резервация на заета книга → при връщане се заделя → отказ повиква следващия', async () => {
  ids.reader2 = await newReaderViaForm({ name: 'Петя Втора', card: '1002', phone: '0899000002' });
  ids.reader3 = await newReaderViaForm({ name: 'Стоян Трети', card: '1003' });
  ids.bookFree = 110;
  await newBookViaForm({ inv: 110, title: 'Свободна книга', price: '1' });
  await checkoutByScan('1001', '101');

  // Читател 2 резервира от гишето.
  await selectReaderAtDesk('1002');
  await h.clickButton('Резервирай заета книга', '#view');
  await h.waitFor(() => h.$('#holdF'), 'формата за резервация');
  assert.match(h.modal(), /Резервацията ще се запише на Петя Втора · карта 1002/);
  h.type('#holdF [name=code]', '101');
  let n = h.toasts.length;
  await h.clickButton('Резервирай', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Резервирана: инв. № 101 за Петя Втора — на опашката е 1-ви.'), JSON.stringify(h.toastsSince(n)));
  assert.match(h.viewText(), /Резервации на този читател.*Под игото.*чака/);
  // Читател 3 се нарежда втори.
  await selectReaderAtDesk('1003');
  await h.clickButton('Резервирай заета книга', '#view');
  await h.waitFor(() => h.$('#holdF'), 'формата за резервация');
  h.type('#holdF [name=code]', '9789540100001');
  n = h.toasts.length;
  await h.clickButton('Резервирай', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Резервирана: инв. № 101 за Стоян Трети — на опашката е 2-ри.'), JSON.stringify(h.toastsSince(n)));
  assert.deepEqual(all('SELECT reader_id, status FROM holds ORDER BY id').map(x => [x.reader_id, x.status]),
    [[ids.reader2, 'чака'], [ids.reader3, 'чака']]);
  // Свободна книга не може да се резервира — заема се направо; формата остава отворена за поправка.
  await h.clickButton('Резервирай заета книга', '#view');
  await h.waitFor(() => h.$('#holdF'), 'формата за резервация');
  h.type('#holdF [name=code]', String(ids.bookFree));
  n = h.toasts.length;
  await h.clickButton('Резервирай', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && t.msg === 'Инв. № 110 е свободен — заемете го направо, без резервация.'), JSON.stringify(h.toastsSince(n)));
  assert.equal(h.modalOpen(), true);
  assert.equal(q('SELECT COUNT(*) AS n FROM holds').n, 2);
  h.window.closeModal();

  // Връщане: бройката се заделя за първия чакащ.
  const { log, toasts } = await returnByScan('101');
  assert.match(log, /НЕ връщайте на рафта — заделена за Петя Втора \(карта 1002, тел\. 0899000002\)/);
  assert.ok(toasts.some(t => t.type === 'err' && t.msg === '📌 Заделена за Петя Втора — не се връща на рафта!'), JSON.stringify(toasts));
  assert.deepEqual(all('SELECT reader_id, status FROM holds ORDER BY id').map(x => [x.reader_id, x.status]),
    [[ids.reader2, 'заделена'], [ids.reader3, 'чака']]);

  // Трети читател не може да я вземе, докато е заделена за другиго.
  await selectReaderAtDesk('1003');
  await h.scan('#bScan', '101');
  assert.match(h.text('#outLog'), /Книгата е резервирана за Петя Втора \(заделена, чака взимане\)/);
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').n, 0);

  // Отказ на заделената → следващият по опашката се повиква.
  await h.clickButton('Резервации', '#view');
  await h.waitFor(() => /заделена — чака взимане/.test(h.viewText()), 'списъка с резервации');
  const rows = Array.from(h.document.querySelectorAll('#view tbody tr'));
  assert.equal(rows.length, 2);
  assert.match(h.text(rows[0]), /101 Под игото Петя Втора \(1002\).*заделена — чака взимане/);
  assert.match(h.text(rows[1]), /101 Под игото Стоян Трети \(1003\).*чака в опашка/);
  n = h.toasts.length;
  await h.clickButton('Откажи', rows[0]);
  const ts = h.toastsSince(n);
  assert.ok(ts.some(t => t.msg === 'Резервацията е отказана.'), JSON.stringify(ts));
  assert.ok(ts.some(t => t.type === 'err' && t.msg === '📌 Бройката се заделя за Стоян Трети (карта 1003) — не се връща на рафта!'), JSON.stringify(ts));
  assert.deepEqual(all('SELECT reader_id, status FROM holds ORDER BY id').map(x => [x.reader_id, x.status]),
    [[ids.reader2, 'отказана'], [ids.reader3, 'заделена']]);
  assert.match(h.viewText(), /Стоян Трети \(1003\).*заделена — чака взимане/);
  assert.doesNotMatch(h.viewText(), /Петя Втора/);

  // Стоян взима заделената — резервацията е изпълнена.
  await checkoutByScan('1003', '101');
  assert.equal(q('SELECT status FROM holds WHERE reader_id = ?', ids.reader3).status, 'изпълнена');
  await returnByScan('101');
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').n, 0);
  noRendererErrors();
});

/* ======================= 7. Постъпления → КДБФ ======================= */
test('7. партида в „Постъпления“, инвентиран документ по нея, ред в КДБФ Част № 1', async () => {
  await h.go('acq');
  assert.match(h.viewText(), /Няма заведени партиди/);
  await h.clickButton('+ Нова партида', '#view');
  await h.waitFor(() => h.$('#acqF'), 'формата за партида');
  assert.equal(h.$('#acqF [name=no]').value, '1', 'предложеният номер на първата партида');
  assert.equal(h.$('#acqF [name=committee1]').value, 'Мария Иванова', 'комисията от Настройки');
  h.type('#acqF [name=total_count]', '2');
  h.type('#acqF [name=from_source]', 'Книжарница „Хеликон“');
  h.type('#acqF [name=doc_type]', 'фактура');
  h.type('#acqF [name=doc_no]', 'Ф-0001');
  h.type('#acqF [name=sum]', '25.00');
  await h.clickButton('Заведи партидата', '#modal footer');
  const acq = q('SELECT * FROM acquisitions WHERE no = 1');
  assert.ok(acq, 'партидата не е записана');
  ids.acq1 = acq.id;
  assert.equal(acq.year, T.slice(0, 4));
  assert.equal(acq.total_count, 2);
  assert.equal(acq.sum, 25);
  assert.equal(acq.committee1, 'Мария Иванова');
  assert.ok(h.toasts.some(t => t.msg === 'Партидата е заведена в КДБФ част 1.'));
  assert.match(h.text('#acqBody'), /1 \/ \d{4}.*Книжарница „Хеликон“ закупуване фактура № Ф-0001 2 0 0\.00 лв\./);

  // Отваряне и инвентиране на документ по партидата.
  await h.clickButton('Отвори', '#acqBody');
  await h.waitFor(() => /Партида № 1/.test(h.modal()), 'картата на партидата');
  assert.match(h.modal(), /2 Общо по документ 0 Инвентирани 2 Остават/);
  await h.clickButton('+ Инвентирай документ', '#modal footer');
  await h.waitFor(() => h.$('#bookF'), 'формата за книга');
  assert.equal(h.$('#bookF [name=acquisition_id]').value, String(ids.acq1), 'партидата не е предварително избрана');
  h.type('#bookF [name=inv_number]', '102');
  h.type('#bookF [name=title]', 'Бай Ганьо');
  h.type('#bookF [name=category_id]', q("SELECT id FROM categories WHERE name = 'книга'").id);
  h.type('#bookF [name=author]', 'Константинов, Алеко');
  h.type('#bookF [name=price]', '12.50');
  await h.clickButton('Запиши', '#modal footer');
  const b = q('SELECT * FROM books WHERE inv_number = 102');
  assert.ok(b, 'книгата по партидата не е записана: ' + JSON.stringify(h.lastToast()));
  ids.book2 = b.id;
  assert.equal(b.acquisition_id, ids.acq1);
  assert.match(h.text('#acqBody'), /Книжарница „Хеликон“.*2 1 12\.50 лв\./, 'списъкът на партидите не отчита инвентирания документ');

  await h.go('kdbf');
  assert.match(h.text('#vTitle'), /Книга за движение на библиотечния фонд/);
  const p1 = h.text('#view tbody');
  assert.match(p1, /1 Книжарница „Хеликон“ закупуване фактура № Ф-0001/);
  assert.match(p1, /2 1 12\.50 лв\. \/ 6\.39 € 102 – 102 книга: 1/, 'редът на партидата в Част № 1: ' + p1);
  assert.match(p1, /ОБЩО за \d{4} г\. 2 1 12\.50 лв\./);
  noRendererErrors();
});

/* ======================= 8. Отчисляване с акт → анулиране ======================= */
test('8. акт за отчисляване чрез сканиране → документът е отчислен → анулиране връща състоянието', async () => {
  const bookId = await newBookViaForm({ inv: 103, title: 'Стара книга', author: 'Неизвестен', price: '3.00' });
  const lent = await checkoutByScan('1001', '103'); // невърната от читател — актът я закрива, анулирането я отваря
  await h.go('acts');
  assert.match(h.viewText(), /Няма съставени актове/);
  await h.clickButton('+ Нов акт за отчисляване', '#view');
  await h.waitFor(() => h.$('#actScan'), 'формата за акт');
  await h.sleep(120); // actForm закача слушателя за Enter със setTimeout(60)
  h.type('#actF [name=reason_code]', '4');
  let n = h.toasts.length;
  await h.scan('#actScan', '103');
  assert.match(h.text('#actList'), /103 Неизвестен\. Стара книга 3\.00 лв\..*ОБЩО 1 документ 3\.00 лв\./);
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && t.msg === 'Внимание: инв. № 103 в момента е зает от читател.'), JSON.stringify(h.toastsSince(n)));
  await h.scan('#actScan', '103');
  assert.ok(h.lastToast().msg === 'Инв. № 103 вече е в списъка.', JSON.stringify(h.lastToast()));
  await h.scan('#actScan', '101');
  assert.match(h.text('#actList'), /ОБЩО 2 документа 15\.50 лв\./);
  const row101 = Array.from(h.document.querySelectorAll('#actList tbody tr')).find(tr => /Под игото/.test(tr.textContent));
  await h.click(row101.querySelector('button.dgr'));
  assert.match(h.text('#actList'), /ОБЩО 1 документ 3\.00 лв\./);
  n = h.toasts.length;
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Акт № 1: отчислен е 1 документ.'), JSON.stringify(h.toastsSince(n)));
  const act = q('SELECT * FROM deaccession_acts WHERE no = 1');
  assert.ok(act, 'актът не е записан');
  assert.equal(act.reason_code, 4);
  assert.equal(act.reason_text, 'Физически изхабени');
  const b1 = q('SELECT * FROM books WHERE id = ?', bookId);
  assert.equal(b1.status, 'отчислен');
  assert.equal(b1.deaccession_act_id, act.id);
  assert.equal(b1.deaccession_date, T);
  assert.equal(q('SELECT status FROM books WHERE id = ?', ids.book1).status, 'наличен', 'махнатият от списъка документ е отчислен');
  const item = q('SELECT * FROM deaccession_items WHERE act_id = ?', act.id);
  assert.equal(item.inv_number, 103);
  assert.equal(item.quantity, 1);
  assert.equal(item.status_before, 'наличен');
  const closed = q('SELECT * FROM loans WHERE id = ?', lent.id);
  assert.equal(closed.date_in, T, 'заемането на отчисления документ не е закрито от акта');
  assert.equal(closed.deaccession_act_id, act.id);
  assert.match(h.text('#view tbody'), /1 \/ \d{4}.*т\. 4\. Физически изхабени 1 3\.00 лв\./);

  // Отчисленият не се заема, не се сканира в акт и се вижда в инвентарната книга и в КДБФ Част № 3.
  await selectReaderAtDesk('1001');
  await h.scan('#bScan', '103');
  assert.match(h.text('#outLog'), /Инв\. № 103 е отчислен от фонда\./);
  await h.go('invbook');
  assert.match(h.viewText(), /1 Отчислени/);
  assert.match(h.text('#ibBody'), /103.*Стара книга.*отчислен/);
  await h.go('kdbf');
  await h.clickButton('Част № 3', '#view');
  await h.waitFor(() => /Приложение № 3/.test(h.viewText()), 'Част № 3');
  assert.match(h.text('#view tbody'), new RegExp(E.bgDate(T).replace(/\./g, '\\.') + ' 1 / \\d{4} т\\. 4\\. Физически изхабени 1 3\\.00 лв\\.'));
  await h.clickButton('Част № 2', '#view');
  await h.waitFor(() => /Приложение № 2/.test(h.viewText()), 'Част № 2');
  // 101, 110, 102, 103 постъпили; 103 отчислен → наличност 3 (стойност 12.50 + 1 + 12.50).
  assert.match(h.viewText(), /4 Постъпили през \d{4} 29\.00 лв\..*1 Отчислени през \d{4} 3\.00 лв\..*3 Наличност 31\.12\.\d{4} 26\.00 лв\./);

  // Анулиране.
  await h.go('acts');
  await h.clickButton('Отвори', '#view tbody');
  await h.waitFor(() => /Акт за отчисляване № 1/.test(h.modal()), 'акта');
  assert.match(h.modal(), /103 Неизвестен\. Стара книга 3\.00 лв\..*ОБЩО 1 3\.00 лв\./);
  n = h.toasts.length;
  await h.clickButton('Анулирай акта', '#modal footer');
  assert.match(h.hooks.confirms[h.hooks.confirms.length - 1], /Анулиране на акта/);
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Актът е анулиран.'), JSON.stringify(h.toastsSince(n)));
  const b2 = q('SELECT * FROM books WHERE id = ?', bookId);
  assert.equal(b2.status, 'наличен');
  assert.equal(b2.deaccession_act_id, null);
  assert.equal(b2.deaccession_date, null);
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts').n, 0);
  assert.match(h.viewText(), /Няма съставени актове/);
  assert.match(q("SELECT detail FROM audit_log WHERE action = 'Анулиране на акт'").detail, /акт № 1\/\d{4} е анулиран, документите са върнати във фонда \(1 заемане е отворено обратно\)/);
  const reopened = q('SELECT * FROM loans WHERE id = ?', lent.id);
  assert.equal(reopened.date_in, null, 'заемането, закрито от акта, не е отворено обратно');
  assert.equal(reopened.deaccession_act_id, null);
  await selectReaderAtDesk('1001');
  assert.match(h.viewText(), /Заети от този читател.*103 Стара книга/);
  await returnByScan('103');
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').n, 0);
  noRendererErrors();
});

/* ======================= 9. Инвентаризация ======================= */
test('9. инвентаризация: започване, сканиране, приключване — протоколът се събира', async () => {
  const dept = 'справочен';
  const a = await newBookViaForm({ inv: 201, title: 'Речник А', department: dept, price: '20' });
  const bLoaned = await newBookViaForm({ inv: 202, title: 'Речник Б', department: dept, price: '30' });
  const c = await newBookViaForm({ inv: 203, title: 'Речник В', department: dept, price: '40' });
  await checkoutByScan('1001', '202');

  await h.go('invent');
  assert.match(h.viewText(), /Няма извършени проверки/);
  await h.clickButton('Започни нова проверка', '#view');
  await h.waitFor(() => h.$('#ivF'), 'формата за проверка');
  h.type('#ivF [name=scope]', 'справочен фонд');
  h.type('#ivF [name=order_no]', '7');
  h.type('#ivF [name=committee1]', 'Мария Иванова');
  h.type('#ivF [name=department]', dept);
  await h.clickButton('Започни сканиране', '#modal footer');
  await h.waitFor(() => h.$('#ivScan'), 'екрана за сканиране');
  const sess = q('SELECT * FROM inventory_sessions ORDER BY id DESC');
  assert.equal(sess.pool_size, 3);
  assert.equal(sess.no, 1);
  assert.equal(sess.department, dept);
  assert.match(h.viewText(), /В обхвата 3 Намерени 0 Остават 3/);

  await h.scan('#ivScan', '201');
  assert.match(h.text('#ivLog'), /201 — Речник А/);
  assert.match(h.viewText(), /Намерени 1 Остават 2/);
  await h.scan('#ivScan', '201');
  assert.match(h.text('#ivLog'), /Инв\. № 201 вече е сканиран\./);
  await h.scan('#ivScan', '101'); // от друг отдел — извън обхвата
  assert.match(h.text('#ivLog'), /Инв\. № 101 е от отдел „за възрастни“, а тази инвентаризация обхваща само отдел „справочен“/);
  assert.equal(q('SELECT COUNT(*) AS n FROM inventory_session_scans WHERE session_id = ?', sess.id).n, 1);
  assert.ok(q('SELECT datelastseen FROM books WHERE id = ?', a).datelastseen, 'datelastseen не е попълнена при сканиране');

  await h.clickButton('Приключи и състави протокол', '#view');
  await h.waitFor(() => h.$('[name=ivMode]'), 'въпроса за вида');
  assert.match(h.modal(), /Проверени са 1 от 3 документа в обхвата\. Останалите 2 не са сканирани\./);
  h.type('[name=ivMode][value=full]', true);
  await h.clickButton('Приключи и състави протокол', '#modal footer');
  await h.waitFor(() => /Инвентаризацията е приключена/.test(h.modal()), 'обобщението');
  assert.match(h.modal(), /Вид: пълна проверка 1 Проверени 1 Липсващи/);
  const s2 = q('SELECT * FROM inventory_sessions WHERE id = ?', sess.id);
  assert.equal(s2.closed, 1);
  assert.equal(s2.mode, 'full');
  assert.equal(s2.pool_final, 3);
  assert.equal(s2.on_loan, 1);
  assert.equal(s2.at_binder, 0);
  const scanned = q('SELECT COUNT(*) AS n FROM inventory_session_scans WHERE session_id = ?', sess.id).n;
  const missing = all('SELECT * FROM inventory_session_missing WHERE session_id = ?', sess.id);
  assert.equal(scanned + missing.length + s2.on_loan + s2.at_binder, s2.pool_final, 'протоколът не се събира');
  assert.deepEqual(missing.map(m => m.inv_number), [203]);
  assert.equal(q('SELECT status FROM books WHERE id = ?', c).status, 'липсващ');
  assert.equal(q('SELECT status FROM books WHERE id = ?', bLoaned).status, 'наличен', 'заетата е обявена за липсваща');

  await h.clickButton('Печат на протокола', '#modal footer');
  await h.waitFor(() => /ПРОТОКОЛ/.test(h.printed()), 'протокола');
  const p = h.printed();
  assert.match(p, /ПРОТОКОЛ № 1 \/ \d{4} \/ /);
  assert.match(p, /заповед № 7/);
  assert.match(p, /пълна инвентаризация \(чл\. 40, т\. 1\)/);
  assert.match(p, /Какво е проверявано: справочен фонд · отдел „справочен“/);
  assert.match(p, /Документи в обхвата: 3 Проверени документи: 1 Липсващи: 1/);
  assert.match(p, /Заети от читатели към деня на проверката: 1/);
  assert.match(p, /203 Речник В 40\.00 лв\..*ОБЩО 1 документ 40\.00 лв\./);
  h.window.ppClose();
  assert.match(h.text('#view tbody'), /1 \/ \d{4}.*справочен фонд 3 1.*1 Мария Иванова.*приключена пълна/);
  await returnByScan('202');
  noRendererErrors();
});

/* ======================= 10. Напомняния ======================= */
test('10. просрочен читател — екранът „Напомняния“ и печатът на писмата, вписани в регистъра', async () => {
  const loan = await checkoutByScan('1001', '9789540100001');
  const due = E.addDays(T, -20);
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(due, loan.id);
  const late = E.effectiveDaysLate(h.db, due, T);
  const fine = Math.round(late * 0.10 * 100) / 100;

  await h.go('over');
  assert.match(h.text('#ovBody'), new RegExp('Иван Читателов 101 Под игото ' + E.bgDate(due).replace(/\./g, '\\.') + ' ' + late + ' '));
  await h.clickButton('Напомняния (имейл и SMS)', '#view');
  await h.waitFor(() => /Напомняния за просрочени материали/.test(h.modal()), 'прозореца с напомнянията');
  const m = h.modal();
  assert.match(m, /Иван Читателов 1 просрочен Напомняне № 2 няма пращано досега/);
  assert.match(m, /Имейл: ivan@example\.bg · Телефон: 0888123456/);
  const body = h.$('#remB0').value;
  assert.match(body, /Иван Читателов/);
  assert.match(body, /Под игото/);
  assert.match(body, /ВТОРО напомняне/);
  assert.equal(h.button('Отвори в пощата', '#modal').disabled, false);

  await h.clickButton('Печат на всички', '#modal footer');
  await h.waitFor(() => /НАПОМНИТЕЛНО ПИСМО/.test(h.printed()), 'писмата');
  const p = h.printed();
  assert.match(p, /Библиотека „Пробуда“/);
  assert.match(p, /До: Иван Читателов/);
  assert.match(p, new RegExp('101 Под игото ' + E.bgDate(T).replace(/\./g, '\\.') + ' ' + E.bgDate(due).replace(/\./g, '\\.')));
  assert.match(p, /Това е ВТОРО напомняне\./);
  assert.match(p, new RegExp('Общо дължимо обезщетение: ' + E.mny(fine).replace(/[.\/]/g, '\\$&') + ' \\(0\\.10 лв\\./ден забава'));
  assert.match(p, /Библиотекар: Мария Иванова/);
  assert.equal(q('SELECT COUNT(*) AS n FROM notice_log').n, 0, 'напомнянето е вписано преди печатът да е потвърден');
  h.window.ppPrint();
  await h.settle();
  await h.waitFor(() => q('SELECT COUNT(*) AS n FROM notice_log').n === 1, 'вписването в регистъра след печат', 2000);
  const nl = q('SELECT * FROM notice_log');
  assert.equal(nl.reader_id, ids.reader1);
  assert.equal(nl.level, 2);
  assert.equal(nl.channel, 'печат');
  assert.equal(nl.loans_count, 1);
  await h.waitFor(() => h.hooks.prints === 1, 'window.print() (rAF + 150 ms в ppPrint)');
  h.window.closeModal();

  // Повторно отваряне: вижда се последното напомняне (пътят по имейл — виж теста D2).
  await h.go('over');
  await h.clickButton('Напомняния (имейл и SMS)', '#view');
  await h.waitFor(() => h.$('#remB0'), 'прозореца с напомнянията');
  assert.match(h.modal(), new RegExp('Напомняне № 2 последно: № 2 · ' + E.bgDate(T).replace(/\./g, '\\.')));
  h.window.closeModal();
  await returnByScan('101');
  noRendererErrors();
});

/* ======================= 11. Читателска сметка ======================= */
test('11. сметка: начисление, плащане, квитанция със салдо', async () => {
  await h.go('readers');
  await h.clickButton('Сметка', `#rBody tr[data-id="${ids.reader1}"]`);
  await h.waitFor(() => /Сметка — Иван Читателов/.test(h.modal()), 'сметката');
  assert.match(h.modal(), /Карта 1001 0\.00 лв\./);
  assert.match(h.modal(), /Няма движения/);
  assert.equal(h.button('Годишна такса', '#modal').disabled, false);

  await h.clickButton('+ Друго начисление', '#modal');
  await h.waitFor(() => h.$('#chgF'), 'формата за начисление');
  h.type('#chgF [name=type]', 'обезщетение');
  h.type('#chgF [name=amount]', '1.50');
  h.type('#chgF [name=note]', 'забава по инв. № 101');
  let n = h.toasts.length;
  await h.clickButton('Начисли', '#modal2 footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Начислено.'), JSON.stringify(h.toastsSince(n)));
  await h.waitFor(() => /1\.50 лв\./.test(h.modal()), 'обновената сметка');
  assert.match(h.modal(), /1\.50 лв\. \/ 0\.77 € \(дължи\)/);
  assert.match(h.modal(), new RegExp(E.bgDate(T).replace(/\./g, '\\.') + ' обезщетение \\+1\\.50 лв\\. \\/ 0\\.77 € забава по инв\\. № 101'));
  const charge = q("SELECT * FROM account_lines WHERE kind = 'начисление'");
  assert.equal(charge.amount, 1.5);
  assert.equal(charge.type, 'обезщетение');

  await h.clickButton('Годишна такса', '#modal');
  await h.waitFor(() => /6\.50 лв\./.test(h.modal()), 'таксата');
  assert.match(h.modal(), /6\.50 лв\. \/ 3\.32 € \(дължи\)/);

  await h.clickButton('Плащане…', '#modal');
  await h.waitFor(() => h.$('#payF'), 'формата за плащане');
  h.type('#payF [name=amount]', '6.50');
  h.type('#payF [name=note]', 'в брой');
  n = h.toasts.length;
  await h.clickButton('Плати', '#modal2 footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Записано плащане.'), JSON.stringify(h.toastsSince(n)));
  await h.waitFor(() => /КВИТАНЦИЯ/.test(h.printed()), 'квитанцията');
  const pay = q("SELECT * FROM account_lines WHERE kind = 'плащане'");
  assert.equal(pay.amount, -6.5);
  assert.equal(Math.round(q('SELECT SUM(amount) AS s FROM account_lines WHERE reader_id = ?', ids.reader1).s * 100), 0);
  const p = h.printed();
  assert.match(p, new RegExp('КВИТАНЦИЯ № ' + pay.id + ' / ' + E.bgDate(T).replace(/\./g, '\\.')));
  assert.match(p, /Читател: Иван Читателов \(карта 1001\)/);
  assert.match(p, /Платена сума: 6\.50 лв\. \/ 3\.32 €/);
  assert.match(p, /Основание: плащане Бележка: в брой/);
  assert.match(p, /няма задължение \(0\.00 лв\.\)/);
  h.window.ppClose();
  assert.match(h.modal(), /0\.00 лв\. \/ 0\.00 €/);
  assert.doesNotMatch(h.modal(), /\(дължи\)/);
  assert.match(h.modal(), /плащане -6\.50 лв\./);
  h.window.closeModal();
  assert.deepEqual(all("SELECT action FROM audit_log WHERE action IN ('Начисление','Плащане') ORDER BY id").map(x => x.action),
    ['Начисление', 'Начисление', 'Плащане']);
  noRendererErrors();
});

/* ======================= 12. Резервно копие ======================= */
test('12. ръчно резервно копие (некриптирано) — файлът съществува, отваря се и е в списъка', async () => {
  await h.go('setup');
  await h.clickButton('Направи резервно копие сега', '#view');
  await h.waitFor(() => h.$('#bkF'), 'формата за копие');
  h.dialogs.savePath = null; // приема предложения път (папката backups до базата)
  const n = h.toasts.length;
  await h.clickButton('Направи копие', '#modal footer');
  await h.settle(150);
  const t = h.toastsSince(n).find(x => x.msg.startsWith('Резервно копие записано: '));
  assert.ok(t, JSON.stringify(h.toastsSince(n)));
  const file = t.msg.replace('Резервно копие записано: ', '');
  assert.ok(fs.existsSync(file), 'файлът ' + file + ' не съществува');
  assert.match(path.basename(file), /^Inventar-backup-.*\.db$/);
  const copy = new Database(file, { readonly: true });
  try {
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM books').get().n, q('SELECT COUNT(*) AS n FROM books').n);
    assert.equal(copy.prepare('SELECT lib_name FROM settings').get().lib_name, 'Библиотека „Пробуда“');
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM readers').get().n, 3);
  } finally { copy.close(); }
  assert.match(q("SELECT detail FROM audit_log WHERE action = 'Резервно копие' ORDER BY id DESC").detail, /ръчно копие: /);
  await h.waitFor(() => h.viewText().includes(path.basename(file)), 'списъка с копия');
  const rows = Array.from(h.document.querySelectorAll('#view table tr')).filter(r => r.textContent.includes(path.basename(file)));
  assert.equal(rows.length, 1);
  assert.match(h.text(rows[0]), /ръчно/);
  assert.doesNotMatch(h.text(rows[0]), /криптирано/);
  noRendererErrors();
});

/* ======================= 13. Дневник ======================= */
test('13. дневник — редакция на клетка се записва, сборовете се преизчисляват, стойността се пази', async () => {
  await h.go('dnevnik');
  const cell = h.$(`.dnvCell[data-date="${T}"][data-field="a_age_o28"]`);
  assert.ok(cell, 'няма клетка за днешния ден');
  assert.equal(cell.value, '0');
  h.type(cell, '3');
  await h.settle();
  const row = q('SELECT * FROM dnevnik_days WHERE date = ?', T);
  assert.ok(row, 'редът за деня не е записан');
  assert.equal(row.a_age_o28, 3);
  // Полетата за въвеждане нямат текст — редът показва деня и четирите изчислени „Всичко“.
  const tr = cell.closest('tr');
  assert.equal(h.text(tr), new Date(T).getUTCDate() + ' 3 0 0 0', 'колоната „Всичко“ по възраст не е преизчислена');
  const totals = h.document.querySelectorAll('.dnvTable tbody tr.dnvTotal');
  assert.match(h.text(totals[0]), /^Всичко за месеца 0:00 3 0 0 0 3 /);
  assert.match(h.text(totals[1]), /^Всичко от нач\. на годината 0:00 3 0 0 0 3 /);

  const hrs = h.$(`.dnvCell[data-date="${T}"][data-field="a_hours"]`);
  h.type(hrs, '8:30');
  await h.settle();
  assert.equal(q('SELECT a_hours FROM dnevnik_days WHERE date = ?', T).a_hours, 510);
  assert.equal(hrs.value, '8:30');

  await h.go('dash');
  await h.go('dnevnik');
  assert.equal(h.$(`.dnvCell[data-date="${T}"][data-field="a_age_o28"]`).value, '3');
  assert.equal(h.$(`.dnvCell[data-date="${T}"][data-field="a_hours"]`).value, '8:30');
  await h.clickButton('Раздел Б', '#view');
  await h.waitFor(() => h.$(`.dnvCell[data-date="${T}"][data-field="b_type_books"]`), 'Раздел Б');
  h.type(h.$(`.dnvCell[data-date="${T}"][data-field="b_type_books"]`), '5');
  await h.settle();
  const r2 = q('SELECT * FROM dnevnik_days WHERE date = ?', T);
  assert.equal(r2.b_type_books, 5);
  assert.equal(r2.a_age_o28, 3, 'записът на клетка от Раздел Б е нулирал Раздел А');
  noRendererErrors();
});

/* ======================= 14. Проверка на данните ======================= */
test('14. „Проверка на данните“ рендира трите проверки и намира заварените несъответствия', async () => {
  await h.go('setup');
  await h.clickButton('Провери сега', '#view');
  await h.waitFor(() => /Един и същ баркод/.test(h.text('#dataChecks')), 'резултата от проверката');
  let dc = h.text('#dataChecks');
  assert.match(dc, /Няма такива записи — навсякъде един инвентарен номер отговаря на един екземпляр/);
  assert.match(dc, /Няма повтарящи се баркодове/);
  assert.doesNotMatch(dc, /без акт за отчисляване/);

  /* Заварени данни от внос на стара база (фикстура направо в базата — картонът
     нарочно не позволява нито бройка ≠ 1, нито „отчислен“ без акт). */
  h.db.prepare("INSERT INTO books (inv_number, title, barcode, register_date, status) VALUES (301, 'Стар многоекземплярен', '9789540100001', ?, 'наличен')").run(T);
  const multi = q('SELECT id FROM books WHERE inv_number = 301').id;
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 3)').run(multi);
  h.db.prepare("INSERT INTO books (inv_number, title, register_date, status, status_date) VALUES (302, 'Отчислен без акт', ?, 'отчислен', ?)").run(T, T);
  const orphan = q('SELECT id FROM books WHERE inv_number = 302').id;
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(orphan);

  await h.clickButton('Провери сега', '#view');
  await h.waitFor(() => /Стар многоекземплярен/.test(h.text('#dataChecks')), 'преизчислената проверка');
  dc = h.text('#dataChecks');
  assert.match(dc, /Един запис носи общо 3 екземпляра/);
  assert.match(dc, /301 Стар многоекземплярен 3 0 Раздели на 3 записа/);
  assert.match(dc, /Този документ е в състояние „отчислен“ без акт/);
  assert.match(dc, /302 Отчислен без акт/);
  assert.match(dc, /Баркод 9789540100001.*101 Вазов, Иван\. Под игото наличен.*301 Стар многоекземплярен наличен/);

  await h.clickButton('Раздели на 3 записа', '#dataChecks');
  await h.waitFor(() => !/Стар многоекземплярен 3 0/.test(h.text('#dataChecks')), 'разделянето');
  const parts = all("SELECT b.inv_number, i.quantity FROM books b JOIN inventory i ON i.book_id = b.id WHERE b.title = 'Стар многоекземплярен' ORDER BY b.inv_number");
  assert.equal(parts.length, 3);
  assert.ok(parts.every(p => p.quantity === 1));
  assert.ok(h.toasts.some(t => /Инв\. № 301: добавени са нови инвентарни номера/.test(t.msg)), JSON.stringify(h.lastToast()));
  await h.clickButton('Върни във фонда', '#dataChecks');
  await h.waitFor(() => !/без акт за отчисляване/.test(h.text('#dataChecks')), 'връщането във фонда');
  assert.equal(q('SELECT status FROM books WHERE id = ?', orphan).status, 'наличен');
  noRendererErrors();
});

/* ======================= 15. Одитна следа ======================= */
test('15. одитната следа показва действията от работния ден с името на служителя', async () => {
  await h.go('odit');
  const body = h.text('#oditBody');
  const expected = ['Редакция на настройки', 'Нов служител', 'Нов читател', 'Нов документ', 'Заемане', 'Връщане',
    'Наложено наказание', 'Продължение на заемане', 'Резервация', 'Заделена книга', 'Отказана резервация',
    'Отчисляване', 'Анулиране на акт', 'Инвентаризация', 'Начисление', 'Плащане', 'Резервно копие'];
  const dbActions = new Set(all('SELECT DISTINCT action FROM audit_log').map(x => x.action));
  for (const a of expected) {
    if (!dbActions.has(a)) continue; // напр. наказание не се налага при suspend_per_day = 0
    assert.ok(body.includes(a), 'одитният екран не показва „' + a + '“');
  }
  assert.ok(dbActions.has('Заемане') && dbActions.has('Отчисляване') && dbActions.has('Плащане'));
  assert.match(body, /Мария Иванова Нов читател карта 1001 — Иван Читателов/);
  assert.match(body, /Заемане инв\. № 101 — Под игото/);
  assert.match(body, /Отчисляване акт № 1\/\d{4} — 1 документ, причина: Физически изхабени/);
  const total = q('SELECT COUNT(*) AS n FROM audit_log').n;
  assert.match(h.text('#oditCount'), new RegExp('^' + total + ' записа$'));
  assert.equal(h.document.querySelectorAll('#oditBody tr').length, total);
  // Редакция на читател — диференцът се показва като „поле: преди → след“.
  await h.go('readers');
  await h.clickButton('Редакция', `#rBody tr[data-id="${ids.reader1}"]`);
  await h.waitFor(() => h.$('#readerF'), 'формата за читател');
  h.type('#readerF [name=phone]', '0888999999');
  await h.clickButton('Запиши', '#modal footer');
  assert.equal(q('SELECT phone FROM readers WHERE id = ?', ids.reader1).phone, '0888999999');
  await h.go('odit');
  h.type('#oditSearch', 'Редакция на читател');
  await h.sleep(350); // debounce 300 ms
  await h.settle();
  assert.match(h.text('#oditBody'), /Редакция на читател карта 1001 — Иван Читателов Телефон: 0888123456 → 0888999999/);
  noRendererErrors();
});

/* ======================= Д. Документирани дефекти ======================= */
/* D1. src/views/loans.js:136-145 — полето #pScan има И debounce(200 ms) слушател за
   'input' (подсказки по име), И слушател за Enter (карта → selectCircReader →
   renderCirc, който ПРЕЗАПИСВА #view). Баркод четецът изпраща знаците и Enter за
   няколко ms: Enter минава, екранът се сменя, и 200 ms по-късно закъснелият
   debounce чете стария (откачен) #pScan, праща излишна заявка readers:list и
   пише в $('#pSug'), който вече не съществува → TypeError „Cannot set properties
   of null (setting 'innerHTML')“ като необработено отхвърляне в renderer-а.
   Библиотекарят не вижда нищо (грешката е само в конзолата), но всяко сканиране
   на карта прави една излишна обиколка до базата и оставя грешка в дневника на
   разработчика. Поправка: `const box = $('#pSug'); if (!box) return;` след await. */
test('D1. гише: сканирана читателска карта не бива да оставя TypeError от закъснелия debounce', async () => {
  h.errors.length = 0;
  const before = h.stats.calls.length;
  await selectReaderAtDesk('1001');
  await h.sleep(320); // debounce(…, 200) в loans.js
  await h.settle();
  const late = h.stats.calls.slice(before).filter(c => c.channel === 'readers:list');
  const errs = h.errors.filter(e => /innerHTML/.test(e.message || ''));
  h.errors.length = 0;
  assert.equal(errs.length, 0, 'src/views/loans.js:142 — ' + (errs[0] && errs[0].message)
    + ' (закъснели readers:list заявки след сканирането: ' + late.length + ')');
});

/* D2. handlers/notices.js (loans:mailto) + DEFAULT_NOTICE_BODY.
   Пазачът `url.length > 1900` е нарочен (Windows реже mailto: около 2000 знака), но
   кирилицата се кодира по 6 знака на буква и ШАБЛОНЪТ ПО ПОДРАЗБИРАНЕ не се побира
   при съвсем обичайни данни: име на библиотека от ~20 знака, попълнени
   „Библиотекар“ и „Населено място“, ЕДИН просрочен документ с обезщетение → 2077
   знака още на първа степен. Дотук (v2.4.26) бутонът „Отвори в пощата“ стоеше
   активен и отказваше всеки път — пътят по имейл не работеше с шаблона по
   подразбиране. От v2.4.27 текстът се копира в буфера, а писмото се отваря с
   адресата, темата и бележка „поставете с Ctrl+V“; регистърът се пипа само тогава. */
test('D2. „Отвори в пощата“ с дълго писмо: текстът в буфера, писмото — отворено', async () => {
  const loan = await checkoutByScan('1001', '101');
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(E.addDays(T, -5), loan.id); // първа степен
  const clip = [];
  Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { clip.push(t); } } });
  await h.go('over');
  await h.clickButton('Напомняния (имейл и SMS)', '#view');
  await h.waitFor(() => h.$('#remB0'), 'прозореца с напомнянията');
  assert.match(h.modal(), /Напомняне № 1/);
  const body = h.$('#remB0').value;
  const n = h.toasts.length;
  await h.clickButton('Отвори в пощата', '#modal');
  const ts = h.toastsSince(n);
  h.window.closeModal();
  await returnByScan('101');
  assert.ok(ts.some(t => /Писмото е отворено/.test(t.msg) && t.type !== 'err'),
    'пощата се отваря и за писмо от ' + body.length + ' знака: ' + JSON.stringify(ts));
  const mail = h.app.shellCalls.find(u => /^mailto:ivan%40example\.bg/.test(u));
  assert.ok(mail, 'mailto: е отворен');
  assert.ok(mail.length <= 1900, 'адресът се побира: ' + mail.length);
  assert.equal(clip[0], body, 'пълният текст е в системния буфер');
  assert.ok(decodeURIComponent(mail).includes('Ctrl+V'), 'писмото казва къде е текстът');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM notice_log WHERE channel = 'имейл'").get().n, 1, 'напомнянето е вписано веднъж');
});
