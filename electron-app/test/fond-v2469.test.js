'use strict';
/* v2.4.69 — кръг 44, област ФОНД И ПРИДОБИВАНЕ.
   =====================================================================
   По един (или повече) тест на всяка поправена находка П1–П14 (без П12 —
   таблото е на друг) и на К2 (вносът насрочва запис на онлайн каталога).
   Всеки твърди онова, което БИБЛИОТЕКАРКАТА вижда — числото в базата след
   „Запиши“, текста на екрана, реда на разпечатката — и е проверен с връщане
   на поправката назад: без нея пада.

   П1  „2,5“ ставаше 25 в кратността и в наказанието (числово поле, bg-BG).
   П2  Опис с колона „Цена (лв.)“ влизаше като евро без дума.
   П3  Неразчетен текст в полето „лв.“ ставаше мълчаливо 0,00 €.
   П4  Сигнатурата беше различна на различните места; колоната в инв. книга — празна.
   П5  Цени в лева книга по книга „се различаваха“ от фактурата с 1 евроцент.
   П6  „Акт за дарение“ за партида без документ; висящо „№ от“.
   П7  Партида без документ от друг екран (периодика) получаваше дата на документ.
   П8  Разпечатаната инвентарна книга мълчеше за прескочените и изтритите номера.
   П9  Книга без партида и без вид — без дума; вид „книга“ по подразбиране.
   П10 „Книги“ не търсеше по УДК, сигнатура, издателство… и ISBN без тирета.
   П11 Повторен ISBN — без подсказка „+ Още екземпляр“.
   П13 Запис при разгърнат списък пречертаваше всички редове.
   П14 Празните „Книги“, „Инвентарна книга“ и КДБФ не казваха откъде се започва.
   К2  Вносът от CSV не насрочваше запис на онлайн каталога. */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const W = () => h.window;
const catId = (name) => q('SELECT id FROM categories WHERE name = ?', name).id;
async function closeAll() {
  try { W().closeModal2(); } catch (e) { /* няма отворен */ }
  try { W().closeModal(); } catch (e) { /* няма отворен */ }
  await h.settle();
}
async function newAcq(o) {
  const no = (await h.api.acquisitions.nextNo(T.slice(0, 4))).data;
  const r = await h.api.acquisitions.create(Object.assign({
    no, date: T, how: 'закупуване', from_source: 'Доставчик', doc_type: 'фактура', doc_no: '1',
    doc_date: T, total_count: 3, sum: ''
  }, o));
  assert.equal(r.ok, true, r.error);
  return r.data;
}

/* ==================================================================
   П14. Празният фонд казва откъде се започва (първо — докато базата е празна)
   ================================================================== */
test('П14. празните „Книги“, „Инвентарна книга“ и КДБФ водят към „Постъпления → + Нова партида“', async () => {
  assert.equal(q('SELECT COUNT(*) AS n FROM books').n, 0, 'тестът иска празна библиотека');
  await h.go('books');
  const books = h.viewText();
  assert.match(books, /Фондът още е празен/, books.slice(0, 600));
  assert.match(books, /„Постъпления“ → „\+ Нова партида“/);
  assert.ok(h.button('Към „Постъпления“', '#view'), 'копче право към партидите');
  assert.doesNotMatch(books, /Няма намерени книги/, 'празният фонд не е неуспешно търсене');
  // Търсене в празния фонд си остава „няма намерени“ — изречението е за празния фонд.
  W().eval("BOOKS_QUERY = 'нещо'"); await W().refreshBooksList(); await h.settle();
  assert.match(h.text('#bBody'), /Няма намерени книги/);
  W().eval("BOOKS_QUERY = ''");
  await h.go('invbook');
  assert.match(h.viewText(), /Инвентарната книга е празна[\s\S]*„Постъпления“ → „\+ Нова партида“/);
  await h.go('kdbf');
  assert.match(h.viewText(), /Няма постъпления за \d{4} г\.[\s\S]*„Постъпления“ → „\+ Нова партида“/);
});

/* ==================================================================
   П1. Кратността и наказанието приемат десетична запетая
   ================================================================== */
test('П1. „2,5“ в кратността и „0,5“ в наказанието се записват като 2,5 и 0,5 — не 25 и 5', async () => {
  await h.go('setup');
  const mult = h.$('#view [name=lost_price_multiplier]');
  const susp = h.$('#view [name=suspend_per_day]');
  assert.equal(mult.type, 'text', 'числовото поле изпуска запетаята в Chromium с bg-BG');
  assert.ok(mult.hasAttribute('data-decimal') && susp.hasAttribute('data-decimal'));
  assert.equal(mult.getAttribute('inputmode'), 'decimal', 'цифровата клавиатура остава');
  h.type('#stF [name=org]', 'НЧ „Тест“');
  h.type('#view [name=lost_price_multiplier]', '2,5');
  h.type('#view [name=suspend_per_day]', '0,5');
  const n0 = h.toasts.length;
  await h.clickButton('Запиши настройките', '#view');
  assert.ok(!h.toastsSince(n0).some(t => t.type === 'err'), JSON.stringify(h.toastsSince(n0)));
  const s = q('SELECT lost_price_multiplier AS m, suspend_per_day AS d FROM settings WHERE id = 1');
  assert.equal(s.m, 2.5, 'кратност 2,5 — обезщетението за книга от 5 € е 12,50 €, не 125 €');
  assert.equal(s.d, 0.5, 'половин ден наказание на ден забава, не пет');
});

test('П1. текст, който не е число („2,5 пъти“), не се записва мълчаливо като 2 — отказ с името на полето', async () => {
  await h.go('setup');
  h.type('#stF [name=org]', 'НЧ „Тест“');
  h.type('#view [name=lost_price_multiplier]', '2,5 пъти');
  const n0 = h.toasts.length;
  await h.clickButton('Запиши настройките', '#view');
  const t = h.toastsSince(n0);
  assert.ok(t.some(x => x.type === 'err' && /кратност/.test(x.msg) && /не е число/.test(x.msg)), JSON.stringify(t));
  assert.equal(q('SELECT lost_price_multiplier AS m FROM settings WHERE id = 1').m, 2.5, 'старата стойност остава');
});

test('П1. правилото по категория читатели: наказание „0,5“ дни на ден забава → 0,5', async () => {
  await h.go('setup');
  W().addCircRule(); await h.settle();
  const el = h.$('#crF [name=suspend_per_day]');
  assert.ok(el && el.hasAttribute('data-decimal'), 'наказанието в правилото също е десетично поле');
  const cat = h.$('#crF [name=category]');
  cat.value = cat.options[0].value; h.fire(cat, 'change');
  h.type('#crF [name=suspend_per_day]', '0,5');
  await h.clickButton('Запиши', '#modal2');
  const r = q('SELECT suspend_per_day AS d FROM circulation_rules WHERE category = ?', cat.value);
  assert.equal(r && r.d, 0.5);
  await closeAll();
});

test('П1. decField/fieldValue — помощникът за чужди екрани (гишето): „1,5“ → „1.5“, неразчетеното остава както е', async () => {
  const w = W();
  const box = w.document.createElement('form');
  box.innerHTML = w.decField('Кратност', 'multiplier', { val: 3, min: 0 });
  w.document.body.appendChild(box);
  const el = box.querySelector('[name=multiplier]');
  el.value = '1,5';
  assert.equal(w.fieldValue(el), '1.5');
  assert.equal(w.badDecimalField(box), null);
  el.value = 'три';
  assert.equal(w.fieldValue(el), 'три', 'неразчетеното не става число');
  assert.deepEqual(Object.assign({}, w.badDecimalField(box)), { label: 'Кратност', value: 'три' });
  el.value = '-1';
  assert.ok(w.badDecimalField(box), 'под минимума');
  box.remove();
});

/* ==================================================================
   П3. Неразчетен текст в полето „лв.“ не става 0,00 €
   ================================================================== */
test('П3. „2,40 лв.“ (както е на фактурата) в полето „лв.“ дава 1,23 €, а „2,4х“ не попълва € и записът се отказва', async () => {
  const acq = await newAcq({ doc_no: 'П3', total_count: 5 });
  await W().bookForm(null, acq); await h.settle();
  h.type('#bookF [name=title]', 'Книга с цена в лева');
  h.type('#bookF [data-bgn-for=price]', '2,40 лв.');
  assert.equal(h.$('#bookF [name=price]').value, '1.23', 'означението „лв.“ в левовото поле не е грешка');
  h.type('#bookF [data-bgn-for=price]', '2,4х');
  assert.equal(h.$('#bookF [name=price]').value, '', 'полето € НЕ се попълва с 0.00');
  assert.match(h.text('#bookF .mnyNote'), /не е сума в лева/, 'полето казва защо');
  const n0 = h.toasts.length;
  await W().saveBook(null); await h.settle();
  assert.ok(h.toastsSince(n0).some(t => t.type === 'err' && /Цена: „2,4х“ не е число \(сума в лева\)/.test(t.msg)
    && /НЕ е записан/.test(t.msg)), JSON.stringify(h.toastsSince(n0)));
  /* И обработчикът, ако екранът бъде заобиколен: към него отива написаното в
     „лв.“, не празното „€“ (празно би станало цена 0). */
  const d = W().formData('#bookF');
  assert.equal(d.price, '2,4х лв.');
  const direct = await h.api.books.create(d);
  assert.equal(direct.ok, false);
  assert.match(direct.error, /Цената „2,4х лв\.“ не е число/);
  assert.equal(q("SELECT COUNT(*) AS n FROM books WHERE title = 'Книга с цена в лева'").n, 0,
    'документ с цена 0 не влиза във фонда');
  // Поправено — записва се с вярната цена.
  h.type('#bookF [data-bgn-for=price]', '2,40');
  await W().saveBook(null); await h.settle();
  assert.equal(q("SELECT price FROM books WHERE title = 'Книга с цена в лева'").price, 1.23);
  await closeAll();
});

test('П3. „1.234,50“ в полето € не показва 0.00 в полето „лв.“', async () => {
  await W().bookForm(null); await h.settle();
  h.type('#bookF [name=price]', '1.234,50');
  assert.equal(h.$('#bookF [data-bgn-for=price]').value, '', 'не „0.00“');
  assert.match(h.text('#bookF .mnyNote'), /не е сума/);
  h.type('#bookF [name=price]', '12,50');
  assert.equal(h.$('#bookF [data-bgn-for=price]').value, '24.45');
  assert.doesNotMatch(h.text('#bookF .mnyNote'), /не е сума/, 'бележката се връща');
  await closeAll();
});

/* ==================================================================
   П4. Едно правило за сигнатура
   ================================================================== */
test('П4. effectiveCallNumber — едно правило в главния процес и в екрана', () => {
  const { effectiveCallNumber } = require('../handlers/books');
  const cases = [
    { call_number: '821.163.2-31 В 15', udk: '821.163.2-31', author_mark: 'В 15' },
    { call_number: null, udk: '638(497.2)', author_mark: 'Й 83' },
    { call_number: '   ', udk: '638', author_mark: null },
    { call_number: '', udk: null, author_mark: 'Й 83' },
    { call_number: null, udk: null, author_mark: null },
    { call_number: 'Ч-9', udk: '94', author_mark: 'Б 1' }
  ];
  const expected = ['821.163.2-31 В 15', '638(497.2) Й 83', '638', 'Й 83', '', 'Ч-9'];
  cases.forEach((c, i) => {
    assert.equal(effectiveCallNumber(c), expected[i], JSON.stringify(c));
    assert.equal(W().effectiveCallNumber(c), expected[i], 'огледалото в екрана: ' + JSON.stringify(c));
  });
});

test('П4. книга, описана с „Избери…“ и „Предложи“, показва сигнатура в „Книги“ и в инвентарната книга (екран и печат)', async () => {
  const r = await h.api.books.create({ title: 'Пчеларство за начинаещи', author: 'Йорданов, Петър',
    udk: '638(497.2)', author_mark: 'Й 83', price: '15', register_date: T, category_id: catId('книга') });
  assert.equal(r.ok, true, r.error);
  await h.go('books');
  const heads = Array.from(h.document.querySelectorAll('#view thead th')).map(x => x.textContent.trim());
  assert.ok(heads.includes('Сигнатура'), 'колона „Сигнатура“ в „Книги“: ' + heads.join(' | '));
  assert.match(h.text(`#bBody tr[data-id="${r.data}"]`), /638\(497\.2\) Й 83/);
  /* Инвентарната книга: клетката „Сигнатура“ по същото правило. Редовете идват от
     invBook:list (handlers/inv-book.js — чужд файл), който трябва да връща и
     b.udk, b.author_mark — виж доклада. Тук се заковава частта на екрана. */
  const row = { id: 1, inv_number: 7, register_date: T, title: 'Пчеларство', author: 'Йорданов, Петър',
    price: 15, udk: '638(497.2)', author_mark: 'Й 83', call_number: null, status: 'наличен', checks: [] };
  const tmp = h.document.createElement('tbody');
  tmp.innerHTML = W().invBookRowsHtml([row]);
  assert.equal(tmp.querySelectorAll('td')[7].textContent.trim(), '638(497.2) Й 83', 'екран: колона „Сигнатура“');
  tmp.innerHTML = W().invBookPrintRow(row);
  assert.equal(tmp.querySelectorAll('td')[8].textContent.trim(), '638(497.2) Й 83', 'печат: колона „Сигнатура“');
  // Подредбата „По сигнатура“ вече знае за нея (cn_sort по същото правило).
  assert.ok(q('SELECT cn_sort FROM books WHERE id = ?', r.data).cn_sort, 'ключ за подредба по сигнатура');
});

/* ==================================================================
   П10. „Книги“ търси и по описанието
   ================================================================== */
test('П10. „Книги“ намира по УДК, сигнатура, авторски знак, издателство, ключова дума, поредица, език, място и ISBN без тирета', async () => {
  const r = await h.api.books.create({ title: 'Под игото (П10)', author: 'Вазов, Иван', isbn: '978-954-09-1234-5',
    udk: '821.163.2-31', author_mark: 'В 15', publisher: 'Захарий Стоянов', keywords: 'класика, роман',
    series: 'Събрани съчинения', language: 'старобългарски', city: 'Велико Търново', price: '9', register_date: T,
    inv_number: '777',
    category_id: catId('книга') });
  assert.equal(r.ok, true, r.error);
  const id = r.data;
  const found = async (s) => {
    const res = await h.api.books.list(s, 'title', { offset: 0, limit: 300 });
    assert.equal(res.ok, true, res.error);
    return res.data.rows.some(x => x.id === id);
  };
  for (const s of ['821.163.2', '821.163.2-31 В 15', 'В 15', 'захарий', 'Захарий', 'класика', 'Събрани',
    'старобългарски', 'Търново', '9789540912345', '978 954 09 1234 5']) {
    assert.equal(await found(s), true, '„' + s + '“ не намира документа');
  }
  assert.equal(await found('9789540912346'), false, 'друг ISBN не бива да съвпада');
  // И през самия екран, с писане в полето.
  await h.go('books');
  h.type('#bSearch', '9789540912345');
  await h.sleep(380); await h.settle();
  assert.match(h.text('#bBody'), /Под игото \(П10\)/);
  W().eval("BOOKS_QUERY = ''"); h.$('#bSearch').value = '';
});

/* ==================================================================
   П11. Повторен ISBN
   ================================================================== */
test('П11. повторен ISBN: подсказка „+ Още екземпляр“ в картона и предупреждение след записа', async () => {
  const first = q("SELECT id, inv_number FROM books WHERE title = 'Под игото (П10)'");
  await W().bookForm(null); await h.settle();
  h.type('#bookF [name=isbn]', '9789540912345'); // от четеца — без тирета
  await W().bookIsbnCheck(h.$('#bookF [name=isbn]')); await h.settle();
  const hint = h.text('#isbnHint');
  assert.match(hint, new RegExp('вече е вписан на инв\\. № ' + first.inv_number));
  assert.ok(h.button('+ Още екземпляр от инв. № ' + first.inv_number, '#isbnHint'), hint);
  h.type('#bookF [name=title]', 'Под игото (втори, на ръка)');
  const n0 = h.toasts.length;
  await W().saveBook(null); await h.settle();
  assert.ok(h.toastsSince(n0).some(t => t.type === 'warn' && /\+ Още екземпляр/.test(t.msg)), JSON.stringify(h.toastsSince(n0)));
  // Копие по правилния път — без упрек.
  const n1 = h.toasts.length;
  await W().bookCopyForm(first.id); await h.settle();
  await W().saveBook(null); await h.settle();
  assert.ok(!h.toastsSince(n1).some(t => /ISBN/.test(t.msg)), 'копието от „+ Още екземпляр“ не получава упрек: '
    + JSON.stringify(h.toastsSince(n1)));
  await closeAll();
});

/* ==================================================================
   П9. Без партида и без вид
   ================================================================== */
test('П9. новият картон стои на вид „книга“, а запис без партида предупреждава и казва изхода', async () => {
  await W().bookForm(null); await h.settle();
  const sel = h.$('#bookF [name=category_id]');
  assert.equal(sel.value, String(catId('книга')), 'вид „книга“ по подразбиране');
  assert.match(h.text(sel.closest('.field')), /по подразбиране — „книга“/, 'подразбирането се вижда');
  assert.equal(h.$('#bookF [name=acquisition_id]').value, '', 'без партида');
  h.type('#bookF [name=title]', 'Книга без партида (П9)');
  const n0 = h.toasts.length;
  await W().saveBook(null); await h.settle();
  const t = h.toastsSince(n0);
  assert.ok(t.some(x => x.type === 'warn' && /БЕЗ ПАРТИДА/.test(x.msg) && /Постъпления → \+ Нова партида/.test(x.msg)),
    JSON.stringify(t));
  assert.equal(q("SELECT category_id FROM books WHERE title = 'Книга без партида (П9)'").category_id, catId('книга'));
  // Без вид (друг път към канала) — също се казва.
  const r = await h.api.books.create({ title: 'Без вид (П9)', price: '1', register_date: T });
  assert.equal(r.ok, true, r.error);
  assert.match(r.kindWarning || '', /без „Вид документ“/);
  assert.match(r.acqWarning || '', /БЕЗ ПАРТИДА/);
  // По партида — нито дума.
  const acq = await newAcq({ doc_no: 'П9' });
  const ok = await h.api.books.create({ title: 'По партида (П9)', price: '1', register_date: T, acquisition_id: acq, category_id: catId('книга') });
  assert.equal(ok.acqWarning, null);
  assert.equal(ok.kindWarning, null);
});

/* ==================================================================
   П5. Цени в лева книга по книга срещу фактурата
   ================================================================== */
test('П5. партида 7,20 лв. и три книги по 2,40 лв.: актът казва, че разликата от 0,01 € е от превръщането', async () => {
  const id = await newAcq({ how: 'дарение', from_source: 'Стефан Николов', doc_type: 'акт (разписка)', doc_no: '7',
    donor_address: 'гр. Тетевен', total_count: 3, sum: (7.20 / 1.95583).toFixed(2) });
  assert.equal(q('SELECT sum FROM acquisitions WHERE id = ?', id).sum, 3.68);
  for (let i = 1; i <= 3; i++) {
    const r = await h.api.books.create({ title: 'Стара книга ' + i, price: (2.40 / 1.95583).toFixed(2), register_date: T,
      acquisition_id: id, category_id: catId('книга') });
    assert.equal(r.ok, true, r.error);
  }
  await W().printDonationDoc(id); await h.settle();
  const p = h.printed();
  assert.match(p, /разликата идва от превръщането лв\. → €/, p.slice(0, 1500));
  assert.doesNotMatch(p, /се различава от сбора/, 'в допуска няма „се различава“');
  await W().printAcqNoDocDoc(id); await h.settle();
  // Над допуска (0,05 € при 3 документа) — пак „се различава“.
  const id2 = await newAcq({ doc_no: 'П5-2', total_count: 3, sum: '3.74' });
  for (let i = 1; i <= 3; i++) {
    await h.api.books.create({ title: 'Над допуска ' + i, price: '1.23', register_date: T, acquisition_id: id2, category_id: catId('книга') });
  }
  await W().printAcqNoDocDoc(id2); await h.settle();
  assert.match(h.printed(), /се различава от\s+сбора/);
  assert.doesNotMatch(h.printed(), /идва от превръщането/);
});

/* ==================================================================
   П6 и П7. Партида без документ
   ================================================================== */
test('П7. партида „без документ“ от друг екран (периодика): без номер и дата на документа, с комисията', async () => {
  h.db.prepare("UPDATE settings SET committee1 = 'Мария Иванова', committee2 = 'Петър Георгиев', committee3 = 'Анна Стоянова' WHERE id = 1").run();
  // Точно това, което праща src/views/periodicals.js (saveVolume): дата на документа
  // от полето (днешната по подразбиране), без комисия.
  const id = await newAcq({ how: 'закупуване', from_source: 'Абонамент — редакция',
    doc_type: 'без документ — протокол на комисия', doc_no: '', doc_date: T, total_count: 1, sum: '',
    note: 'Абонамент за периодика' });
  const a = q('SELECT doc_no, doc_date, committee1, committee2, committee3 FROM acquisitions WHERE id = ?', id);
  assert.equal(a.doc_no, null);
  assert.equal(a.doc_date, null, 'дата на несъществуващ документ не влиза в регистъра');
  assert.deepEqual([a.committee1, a.committee2, a.committee3], ['Мария Иванова', 'Петър Георгиев', 'Анна Стоянова'],
    'протоколът по чл. 3, ал. 2 се подписва от комисията към завеждането');
  const audit = q("SELECT detail FROM audit_log WHERE action = 'Постъпление' ORDER BY id DESC LIMIT 1").detail;
  assert.match(audit, /дата .* на документа не са вписани/, 'нищо мълчаливо: ' + audit);
  assert.match(audit, /комисията е взета от Настройки/);
  // КДБФ Част № 1 — без „/ дата“ след „без документ“.
  await h.go('kdbf');
  const row = Array.from(h.document.querySelectorAll('#view tbody tr')).find(tr => /Абонамент — редакция/.test(tr.textContent));
  assert.ok(row, 'партидата е в КДБФ Част № 1');
  const docCell = h.text(row.querySelectorAll('td')[3]);
  assert.match(docCell, /без документ — протокол на комисия/);
  assert.doesNotMatch(docCell, /\d{2}\.\d{2}\.\d{4}/, 'клетката „Документ“ без дата: ' + docCell);
  // Поправката (acquisitions:update) пази същото правило.
  const u = await h.api.acquisitions.update({ id, acq: Object.assign({}, q('SELECT * FROM acquisitions WHERE id = ?', id),
    { doc_no: '99', doc_date: T }) });
  assert.equal(u.ok, true, u.error);
  assert.equal(q('SELECT doc_no FROM acquisitions WHERE id = ?', id).doc_no, null);
});

test('П6. партида без документ: няма „Акт за дарение“, няма висящо „№ от“; актът се отказва и по друг път', async () => {
  const id = await newAcq({ how: 'дарение', from_source: 'намерени при подреждане',
    doc_type: 'без документ — протокол на комисия', doc_no: '', doc_date: '', total_count: 4, sum: '8' });
  await W().openAcq(id); await h.settle();
  const buttons = Array.from(h.document.querySelectorAll('#modal footer button')).map(b => b.textContent.trim());
  assert.ok(!buttons.some(b => /Акт за дарение/.test(b)), buttons.join(' | '));
  assert.ok(buttons.some(b => /Протокол за придобиване/.test(b)));
  const card = h.modal();
  assert.doesNotMatch(card, /№\s+от/, 'висящо „№ от“: ' + card.slice(0, 400));
  assert.match(card, /без документ — протокол на комисия/);
  await closeAll();
  const n0 = h.toasts.length, prints = h.hooks.prints;
  const sheetBefore = h.printed();
  await W().printDonationDoc(id); await h.settle();
  assert.ok(h.toastsSince(n0).some(t => t.type === 'err' && /чл\. 3, ал\. 2/.test(t.msg)), JSON.stringify(h.toastsSince(n0)));
  assert.equal(h.printed(), sheetBefore, 'акт за дарение не се сглобява');
  assert.equal(h.hooks.prints, prints);
});

/* ==================================================================
   П8. Прескочените и изтритите номера на хартия
   ================================================================== */
test('П8. разпечатката на инвентарната книга вписва № 6–10 (прескочени) и № 13 (изтрит) на мястото им', async () => {
  const base = 9000;
  h.db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(base + 1);
  const mk = async (inv, title) => {
    const r = await h.api.books.create({ inv_number: String(inv), title, price: '1', register_date: T, category_id: catId('книга') });
    assert.equal(r.ok, true, r.error);
    return r.data;
  };
  for (let i = 1; i <= 5; i++) await mk(base + i, 'Поредица ' + i);
  await mk(base + 11, 'Поредица 11');            // прескача 9006–9010
  await mk(base + 12, 'Поредица 12');
  const del = await mk(base + 13, 'Сборник песни');
  await mk(base + 14, 'Поредица 14');
  await h.api.books.delete(del);                   // първото натискане пита
  const d2 = await h.api.books.delete(del);
  assert.equal(d2.ok, true, d2.error);
  await h.go('invbook');
  await W().printInvBookDoc(); await h.settle();
  const p = h.printed();
  assert.match(p, new RegExp('№ ' + (base + 6) + ' – ' + (base + 10) + ' — НЕИЗПОЛЗВАНИ \\(прескочени на ' + E.bgDate(T)), p.slice(-3000));
  assert.match(p, new RegExp('№ ' + (base + 13) + ' — ИЗТРИТ на ' + E.bgDate(T) + ' г\\. \\(„Сборник песни“\\)'));
  // На мястото си: след № 9005 и преди № 9011.
  const i5 = p.indexOf('Поредица 5'), iGap = p.indexOf('№ ' + (base + 6) + ' – '), i11 = p.indexOf('Поредица 11');
  assert.ok(i5 < iGap && iGap < i11, 'редът за празното място стои между № 9005 и № 9011');
  assert.match(p, /Празни места в поредицата между отпечатаните номера:/);
});

/* ==================================================================
   П13. Запис при разгърнат списък не пречертава всичко
   ================================================================== */
test('П13. запис на нова книга при разгърнати над 300 реда пипа само един ред — без books:list', async () => {
  const ins = h.db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, status_date, department)
    VALUES (?, ?, 'Мащабов, М.', 1, ?, 'наличен', ?, 'за възрастни')`);
  const inv = h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)');
  h.db.transaction(() => {
    for (let i = 0; i < 700; i++) inv.run(ins.run(20000 + i, 'Мащаб ' + String(i).padStart(4, '0'), T, T).lastInsertRowid);
  })();
  h.db.prepare('UPDATE settings SET next_inv_number = 20700 WHERE id = 1').run();
  await h.go('books');
  await h.clickButton('Покажи още', '#bMore');
  assert.ok(h.document.querySelectorAll('#bBody tr').length > 300, 'списъкът е разгърнат');
  const painted = h.document.querySelectorAll('#bBody tr').length;
  await W().bookForm(null); await h.settle();
  h.type('#bookF [name=title]', 'Мащаб — нова книга');
  const c0 = h.stats.calls.length;
  await W().saveBook(null); await h.settle();
  const channels = h.stats.calls.slice(c0).map(c => c.channel);
  assert.ok(!channels.includes('books:list'), 'целият прозорец не се тегли наново: ' + channels.join(', '));
  assert.equal(h.document.querySelectorAll('#bBody tr').length, painted + 1, 'точно един ред повече');
  assert.match(h.text('#bBody tr:first-child'), /Мащаб — нова книга/, 'новият запис е най-отгоре');
  assert.match(h.text('#bMore'), /най-отгоре/, 'и се казва защо е там');
  // Малък списък (една порция) — пълното пречертаване остава: там дава и подредбата.
  W().eval('BOOKS_RENDER_LIMIT = 300');
  await h.go('books');
});

/* ==================================================================
   П2. Колона „Цена (лв.)“ от стар опис
   ================================================================== */
async function importCsv(name, text, mapping) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-fond-v2469-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, text, 'utf8');
  const l = await h.api.importData.load(f);
  assert.equal(l.ok, true, l.error);
  const r = await h.api.importData.run({ mapping, options: { defaultRegisterDate: '1985-03-15' } });
  assert.equal(r.ok, true, r.error);
  return r.data;
}
test('П2. числата под „Цена (лв.)“ са левове за цялата колона; отчетът казва колко са превърнати и колко приети за евро', async () => {
  const rep = await importCsv('opis-leva.csv',
    'Инв. №;Заглавие;Цена (лв.)\n30001;Чичовци;2,4\n30002;Суматоха;1.6\n30003;Съчинения;€ 12,50\n30004;Без цена;\n',
    { 0: 'inv_number', 1: 'title', 2: 'price' });
  const price = (inv) => q('SELECT price FROM books WHERE inv_number = ?', inv).price;
  assert.equal(price(30001), 1.23, '2,4 лв. → 1,23 € (не 2,40 €)');
  assert.equal(price(30002), 0.82, '1,6 лв. → 0,82 €');
  assert.equal(price(30003), 12.5, 'изрично означената клетка печели пред заглавието');
  assert.match(rep.priceNote, /1 ред е приет за евро/, rep.priceNote);
  assert.match(rep.priceNote, /2 реда са превърнати от левове/);
  assert.match(rep.priceNote, /1 ред е без цена/);
  assert.match(rep.priceNote, /„Цена \(лв\.\)“ — казва левове/);
  assert.ok(rep.warnings.some(w => /приети за левове, защото заглавието на колоната/.test(w)), rep.warnings.join('\n'));
});
test('П2. без валута в заглавието — отчетът ВИНАГИ казва, че всичко е прието за евро (и как се поправя)', async () => {
  const rep = await importCsv('opis-bez.csv', 'Инв. №;Заглавие;Цена\n30101;Едно;2,40\n30102;Две;3\n',
    { 0: 'inv_number', 1: 'title', 2: 'price' });
  assert.equal(q('SELECT price FROM books WHERE inv_number = 30101').price, 2.4);
  assert.match(rep.priceNote, /2 реда са приети за евро, от левове — 0 реда/, rep.priceNote);
  assert.match(rep.priceNote, /Цена \(лв\)/, 'казва как се чете колона в левове');
  // Екранът на отчета го показва.
  await h.go('setup');
});

/* ==================================================================
   К2. Вносът насрочва запис на онлайн каталога
   ================================================================== */
test('К2. import:run насрочва запис на katalog.json (scheduleCatalogWrite), както другите обработчици на фонда', async () => {
  const Database = require('better-sqlite3');
  const handlers = new Map();
  const ipc = { handle: (c, fn) => handlers.set(c, fn) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-fond-v2469-k2-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const BOOK_FIELDS = require('../handlers/books')({ handle: () => {} },
    { getDb: () => null, run: (fn) => fn, logAudit: () => {}, today: () => T, scheduleCatalogWrite: () => {},
      cnSortKey: () => null, normalizeScanCode: (x) => x }).BOOK_FIELDS;
  let scheduled = 0;
  require('../handlers/data-import')(ipc, {
    getDb: () => db, run: (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } },
    logAudit: () => {}, dialog: {}, getMainWindow: () => ({}), fs, path, BOOK_FIELDS, today: () => T,
    cnSortKey: (s) => String(s || '').toUpperCase(), EUR_RATE: 1.95583,
    scheduleCatalogWrite: () => { scheduled++; }
  });
  const f = path.join(dir, 'k2.csv');
  fs.writeFileSync(f, 'Инв. №;Заглавие\n1;Нова в каталога\n', 'utf8');
  assert.equal((await handlers.get('import:load')({}, f)).ok, true);
  const r = await handlers.get('import:run')({}, { mapping: { 0: 'inv_number', 1: 'title' }, options: {} });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.added, 1);
  assert.equal(scheduled, 1, 'вписаният документ стига до сайта с отложения запис');
  db.close();
});
