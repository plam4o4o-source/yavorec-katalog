'use strict';
/* v2.4.62 — ОТЧИСЛЯВА СЕ САМО ЕКЗЕМПЛЯРЪТ С ИНВЕНТАРНИЯ НОМЕР В АКТА.
 * =====================================================================
 * Инвентарната книга вписва всеки библиотечен документ със СВОЙ инвентарен
 * номер (чл. 16), а актът по чл. 35 описва отчислените документи поотделно,
 * по номер. Програмата спазва правилото за всеки нов запис от v2.4.21 насам
 * (втори екземпляр = втори запис с нов номер), но остава стар запис от внесена
 * база, в който няколко екземпляра стоят под ЕДИН номер (inventory.quantity > 1).
 *
 * Дотук такъв запис, сканиран в акт, отчисляваше ВСИЧКИ свои екземпляри
 * наведнъж: библиотеката вадеше една скъсана книга, а от фонда, от КДБФ и от
 * инвентарната книга излизаха три. Двете здрави оставаха на рафта, невидими за
 * програмата, до следващата инвентаризация.
 *
 * Тези тестове заковават новото правило по всичките пътища към акта:
 *   1) ядрото на акта отказва неразделен запис и не пише нищо;
 *   2) след разделяне актът взема ТОЧНО един екземпляр — този с номера в акта —
 *      а останалите остават във фонда с новите си номера;
 *   3) три отделни екземпляра от едно заглавие: отчислява се само сканираният;
 *   4) екранът за акта разделя записа при сканиране, с потвърждение, и казва
 *      новите номера; отказът не добавя нищо и не разделя нищо;
 *   5) проект, записан преди правилото, показва неразделения ред с бутон
 *      „Раздели“ и не се утвърждава, докато редът не е разделен;
 *   6) проектът от липсите при инвентаризация: изцяло липсващ стар запис влиза
 *      с ВСИЧКИТЕ си екземпляри, всеки със свой номер — бройката и стойността
 *      съвпадат с протокола.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/e2e-app');

let h;
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const T = E.today();
const Y = T.slice(0, 4);
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);

/* Стар запис: N екземпляра под един номер. Вписването вече не приема бройка
   различна от 1 (books:create) — точно затова такъв ред може да дойде само от
   внесена база и тук се създава направо в базата. */
function legacyRecord({ inv, title, price, qty, date }) {
  const id = h.db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, status_date)
    VALUES (?, ?, 'Автор', ?, ?, 'наличен', ?)`).run(inv, title, price, date || T, date || T).lastInsertRowid;
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, qty);
  const next = q('SELECT next_inv_number AS n FROM settings WHERE id = 1').n || 1;
  if (inv >= next) h.db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(inv + 1);
  return Number(id);
}
function single({ inv, title, price }) { return legacyRecord({ inv, title, price, qty: 1 }); }
/* Документите във фонда по ключа „налично днес“ (db/fund-sql.js). */
function fundDocs() {
  return q(`SELECT COALESCE(SUM(COALESCE(i.quantity, 1)), 0) AS n FROM books b
    LEFT JOIN inventory i ON i.book_id = b.id WHERE (b.status != 'отчислен' OR b.status IS NULL)`).n;
}
const ACT = (o) => Object.assign({
  date: T, reason_code: 3, reason_text: 'Физически изхабени', disposal: 'за унищожаване',
  committee1: 'Иванова', committee2: 'Петров', committee3: 'Стоянова'
}, o);
async function nextNo() { return (await h.api.deaccessionActs.nextNo(Y)).data; }

test('1. ядрото на акта отказва стар запис с 3 екземпляра под един номер — и не пише нищо', async () => {
  const id = legacyRecord({ inv: 501, title: 'Тютюн', price: 8, qty: 3 });
  const before = fundDocs();
  const acts = q('SELECT COUNT(*) AS n FROM deaccession_acts').n;
  const res = await h.api.deaccessionActs.create({ act: ACT({ no: await nextNo() }), bookIds: [id] });
  assert.equal(res.ok, false, 'неразделеният запис не бива да влиза в акт');
  assert.match(res.error, /Под инв\. № 501 \(„Тютюн“\) са вписани 3 екземпляра/);
  assert.match(res.error, /само екземпляра с номера, записан в него, а не всички наведнъж/);
  assert.match(res.error, /Актът НЕ е съставен/);
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts').n, acts, 'не е записан акт');
  assert.equal(q('SELECT status FROM books WHERE id = ?', id).status, 'наличен');
  assert.equal(q('SELECT quantity FROM inventory WHERE book_id = ?', id).quantity, 3, 'бройката не е пипната');
  assert.equal(fundDocs(), before, 'фондът не е намалял');
});

test('2. след разделяне актът отчислява ТОЧНО екземпляра с номера в акта; другите остават във фонда', async () => {
  const id = legacyRecord({ inv: 510, title: 'Железният светилник', price: 6, qty: 3 });
  const before = fundDocs();
  const split = await h.api.books.splitCopies(id);
  assert.equal(split.ok, true, split.error);
  assert.equal(split.data.created.length, 2);
  assert.equal(split.data.createdIds.length, 2, 'разделянето връща и редовете — нужни са на проекта от липсите');
  assert.equal(fundDocs(), before, 'разделянето не променя бройката на фонда');

  const kdbfBefore = (await h.api.kdbf.report(Y)).data.deaccYear.n;
  const res = await h.api.deaccessionActs.create({ act: ACT({ no: await nextNo() }), bookIds: [id] });
  assert.equal(res.ok, true, res.error);
  const items = all('SELECT inv_number, quantity, price FROM deaccession_items WHERE act_id = ?', res.data);
  assert.deepEqual(items, [{ inv_number: 510, quantity: 1, price: 6 }], 'в акта е един ред, един екземпляр');
  assert.equal(fundDocs(), before - 1, 'от фонда излиза един документ, не три');
  assert.equal((await h.api.kdbf.report(Y)).data.deaccYear.n, kdbfBefore + 1, 'КДБФ Част № 3 отчита един документ');
  for (const inv of split.data.created) {
    const b = q('SELECT status, deaccession_act_id FROM books WHERE inv_number = ?', inv);
    assert.equal(b.status, 'наличен', 'инв. № ' + inv + ' остава във фонда');
    assert.equal(b.deaccession_act_id, null);
  }
});

test('3. три отделни екземпляра от едно заглавие: отчислява се само сканираният номер', async () => {
  const a = single({ inv: 520, title: 'Бай Ганьо', price: 5 });
  const b = single({ inv: 521, title: 'Бай Ганьо', price: 5 });
  const c = single({ inv: 522, title: 'Бай Ганьо', price: 5 });
  const found = await h.api.deaccessionActs.findBook('521');
  assert.equal(found.ok, true, found.error);
  assert.equal(found.data.id, b, 'сканирането намира точно екземпляра с този номер');
  const res = await h.api.deaccessionActs.create({ act: ACT({ no: await nextNo() }), bookIds: [found.data.id] });
  assert.equal(res.ok, true, res.error);
  assert.equal(q('SELECT status FROM books WHERE id = ?', b).status, 'отчислен');
  assert.equal(q('SELECT status FROM books WHERE id = ?', a).status, 'наличен');
  assert.equal(q('SELECT status FROM books WHERE id = ?', c).status, 'наличен');
});

async function openActForm() {
  await h.go('acts');
  await h.clickButton('+ Нов акт за отчисляване', '#view');
  await h.waitFor(() => h.$('#actScan'), 'формата за акт');
  await h.sleep(120); // actForm закача слушателя за Enter със setTimeout(60)
}
async function closeForm() {
  const cancel = Array.from(h.document.querySelectorAll('#modal footer button')).find(x => /Отказ|Затвори/.test(x.textContent));
  if (cancel) await h.click(cancel);
}

test('4a. екранът за акта: сканиран стар запис се разделя след потвърждение и в списъка влиза един екземпляр', async () => {
  const id = legacyRecord({ inv: 530, title: 'Под игото', price: 10, qty: 3 });
  await openActForm();
  h.hooks.confirmAnswer = true;
  const c0 = h.hooks.confirms.length, n0 = h.toasts.length;
  await h.scan('#actScan', '530');
  const asked = h.hooks.confirms.slice(c0).join('\n');
  assert.match(asked, /Под инв\. № 530 \(„Под игото“\) са вписани 3 екземпляра под един номер/);
  assert.match(asked, /Актът отчислява само екземпляра с този номер, не всички наведнъж/);
  assert.equal(q('SELECT quantity FROM inventory WHERE book_id = ?', id).quantity, 1, 'записът е разделен');
  const created = all("SELECT inv_number FROM books WHERE title = 'Под игото' AND id <> ? ORDER BY inv_number", id).map(r => r.inv_number);
  assert.equal(created.length, 2);
  const t = h.toastsSince(n0).map(x => x.msg).join('\n');
  assert.match(t, new RegExp('В акта влиза само инв\\. № 530\\. Другите екземпляри получиха инв\\. № ' + created.join(', ')));
  assert.match(t, /надпишете ги с новите номера/);
  assert.match(h.text('#actList'), /530 Автор\. Под игото 10\.00 €.*ОБЩО 1 документ 10\.00 €/,
    'в списъка е един документ, не три: ' + h.text('#actList'));
  await closeForm();
});

test('4b. екранът за акта: отказ от разделянето не добавя документа и не пипа записа', async () => {
  const id = legacyRecord({ inv: 540, title: 'Нова земя', price: 7, qty: 2 });
  await openActForm();
  h.hooks.confirmAnswer = false;
  const n0 = h.toasts.length;
  await h.scan('#actScan', '540');
  h.hooks.confirmAnswer = true;
  assert.equal(q('SELECT quantity FROM inventory WHERE book_id = ?', id).quantity, 2, 'нищо не е разделено');
  assert.ok(h.toastsSince(n0).some(x => x.msg === 'Инв. № 540 не е добавен в акта.'), JSON.stringify(h.toastsSince(n0)));
  assert.match(h.text('#actList'), /Списъкът е празен/);
  await closeForm();
});

test('5. проект отпреди правилото: неразделеният ред се вижда, не се утвърждава и се разделя с бутона на реда', async () => {
  const id = legacyRecord({ inv: 550, title: 'Време разделно', price: 9, qty: 3 });
  // Проектът се записва направо през канала — така, както е бил записан преди v2.4.62.
  const draftId = (await h.api.deaccessionActs.saveDraft({
    draft: { date: T, reason_code: 3, reason_text: 'Физически изхабени', committee1: 'Иванова' }, bookIds: [id]
  })).data;
  // Ядрото отказва утвърждаването и проектът остава.
  const direct = await h.api.deaccessionActs.approveDraft({ id: draftId });
  assert.equal(direct.ok, false);
  assert.match(direct.error, /Под инв\. № 550/);
  assert.ok(q('SELECT id FROM deaccession_drafts WHERE id = ?', draftId), 'отказаното утвърждаване не трие проекта');

  await h.sleep(300); // предишната форма да довърши затварянето си
  await h.go('acts');
  await h.window.openDraft(draftId); await h.settle();
  await h.waitFor(() => /екземпляра под един номер/.test(h.text('#actList')), 'редът на проекта');
  assert.match(h.text('#actList'), /3 екземпляра под един номер/);
  // Утвърждаването от екрана казва кой ред и какво да се направи — преди да стигне до ядрото.
  let n0 = h.toasts.length;
  await h.clickButton('Утвърди', '#modal footer');
  assert.ok(h.toastsSince(n0).some(x => x.type === 'err'
    && /Под инв\. № 550 са вписани 3 екземпляра под един номер\. Натиснете „Раздели“ на реда/.test(x.msg)),
    JSON.stringify(h.toastsSince(n0)));
  assert.equal(q('SELECT status FROM books WHERE id = ?', id).status, 'наличен');
  // Бутонът на реда разделя записа и редът остава за един екземпляр.
  n0 = h.toasts.length;
  await h.clickButton('Раздели — отчисли само този', '#actList');
  assert.equal(q('SELECT quantity FROM inventory WHERE book_id = ?', id).quantity, 1);
  assert.doesNotMatch(h.text('#actList'), /екземпляра под един номер/);
  assert.match(h.text('#actList'), /ОБЩО 1 документ 9\.00 €/);
  await closeForm();
});

test('6. проект от липсите: изцяло липсващ стар запис влиза с ВСИЧКИТЕ си екземпляри, всеки със свой номер', async () => {
  /* Пълна инвентаризация, в която стар запис с 3 екземпляра по 4 € не е намерен
     изобщо: липсват и трите. Протоколът казва „3 документа — 12.00 €“, актът
     трябва да каже същото — но поименно, по номер. */
  const legacy = legacyRecord({ inv: 560, title: 'Хайдушки песни', price: 4, qty: 3 });
  const s = await h.api.inventorySessions.start({ date: T, scope: 'пълна', department: null,
    committee1: 'Иванова', committee2: 'Петров', committee3: 'Стоянова', order_no: null });
  assert.equal(s.ok, true, s.error);
  const sid = s.data.id || s.data;
  // Сканират се всички ОСВЕН стария запис — той остава липсващ.
  const others = all(`SELECT b.inv_number FROM books b WHERE (b.status != 'отчислен' OR b.status IS NULL)
    AND b.id <> ? AND b.id NOT IN (SELECT book_id FROM loans WHERE date_in IS NULL)`, legacy);
  for (const o of others) await h.api.inventorySessions.scan({ sessionId: sid, code: String(o.inv_number) });
  const closed = await h.api.inventorySessions.close({ sessionId: sid, mode: 'full' });
  assert.equal(closed.ok, true, closed.error);
  const sess = (await h.api.inventorySessions.get(sid)).data;
  const miss = sess.missing.filter(m => m.book_id === legacy);
  assert.equal(miss.length, 1);
  assert.equal(Number(miss[0].quantity), 3, 'протоколът брои трите екземпляра');

  h.hooks.confirmAnswer = true;
  const c0 = h.hooks.confirms.length;
  await h.window.draftFromMissing(sid); await h.settle();
  assert.match(h.hooks.confirms.slice(c0).join('\n'), /инв\. № 560 × 3/);
  const draft = q('SELECT MAX(id) AS id FROM deaccession_drafts').id;
  const rows = all(`SELECT b.inv_number, COALESCE(i.quantity, 1) AS qty, b.price FROM deaccession_draft_items d
    JOIN books b ON b.id = d.book_id LEFT JOIN inventory i ON i.book_id = b.id
    WHERE d.draft_id = ? AND b.title = 'Хайдушки песни' ORDER BY b.inv_number`, draft);
  assert.equal(rows.length, 3, 'трите липсващи екземпляра влизат поименно: ' + JSON.stringify(rows));
  assert.equal(rows[0].inv_number, 560);
  assert.ok(rows.every(r => r.qty === 1), 'всеки ред е един екземпляр');
  assert.equal(rows.reduce((v, r) => v + r.price * r.qty, 0), 12, 'стойността е същата като в протокола');
});

test('7. проектът от липсите разделя НЯКОЛКО стари записа в ЕДНА транзакция: истинска грешка по един не оставя другите наполовина разделени (преглед на кръга)', async () => {
  /* Два стари записа липсват едновременно: 570 (3 екземпляра) и 571 (2 екземпляра).
     books:splitCopiesBatch трябва да разделя двата записа в ЕДНА транзакция: щом 571
     откаже, 570 НЕ бива да остане разделен — иначе следващият опит го подминава по
     пътя „вече е разделен“ и новите му номера падат от проекта без следа, а екранът
     твърди грешна бройка.
     До v2.4.66 отказът тук идваше от ДВЕ заемания на 571 след проверката. От
     v2.4.67 заетата след проверката бройка е НАМЕРЕНА и изобщо не влиза в проекта
     (виж test/pari-v2467.test.js), затова истинската грешка е друга: 571 е
     отчислен от друго работно място между приключването и проекта. */
  const a = legacyRecord({ inv: 570, title: 'Дядо Йоцо гледа', price: 6, qty: 3 });
  const b = legacyRecord({ inv: 571, title: 'Записки по българските въстания', price: 3, qty: 2 });
  const s = await h.api.inventorySessions.start({ date: T, scope: 'пълна', department: null,
    committee1: 'Иванова', committee2: 'Петров', committee3: 'Стоянова', order_no: null });
  assert.equal(s.ok, true, s.error);
  const sid = s.data.id || s.data;
  const others = all(`SELECT b.inv_number FROM books b WHERE (b.status != 'отчислен' OR b.status IS NULL)
    AND b.id NOT IN (?, ?) AND b.id NOT IN (SELECT book_id FROM loans WHERE date_in IS NULL)`, a, b);
  for (const o of others) await h.api.inventorySessions.scan({ sessionId: sid, code: String(o.inv_number) });
  const closed = await h.api.inventorySessions.close({ sessionId: sid, mode: 'full' });
  assert.equal(closed.ok, true, closed.error);

  // 571 е отчислен от друго работно място — след приключването, преди проекта.
  h.db.prepare("UPDATE books SET status = 'отчислен', deaccession_date = ? WHERE id = ?").run(T, b);

  const draftsBefore = q('SELECT COUNT(*) AS n FROM deaccession_drafts').n;
  await h.go('invent');
  h.hooks.confirmAnswer = true;
  const n0 = h.toasts.length;
  await h.window.draftFromMissing(sid); await h.settle();
  assert.ok(h.toastsSince(n0).some(t => t.type === 'err' && /571 е отчислен/.test(t.msg)),
    JSON.stringify(h.toastsSince(n0)));
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_drafts').n, draftsBefore, 'неуспешният опит не съставя никакъв проект');
  assert.equal(q('SELECT quantity FROM inventory WHERE book_id = ?', a).quantity, 3,
    'записът, който щеше да мине пръв в партидата, НЕ остава разделен, докато вторият отказва');
  assert.equal(all("SELECT 1 FROM books WHERE title = 'Дядо Йоцо гледа' AND id <> ?", a).length, 0,
    'нито един нов ред не е създаден от отменената партида');

  // Отчисляването е отменено — вторият опит минава изцяло.
  h.db.prepare("UPDATE books SET status = 'липсващ', deaccession_date = NULL WHERE id = ?").run(b);
  const n1 = h.toasts.length;
  await h.window.draftFromMissing(sid); await h.settle();
  assert.ok(h.toastsSince(n1).some(t => /е съставен от 5 липсващи документа/.test(t.msg)), JSON.stringify(h.toastsSince(n1)));
  const draft = q('SELECT MAX(id) AS id FROM deaccession_drafts').id;
  const rowsA = all(`SELECT b.inv_number FROM deaccession_draft_items d JOIN books b ON b.id = d.book_id
    WHERE d.draft_id = ? AND b.title = 'Дядо Йоцо гледа' ORDER BY b.inv_number`, draft);
  assert.equal(rowsA.length, 3, 'и трите екземпляра на 570 влизат — нито един не е изгубен по пътя: ' + JSON.stringify(rowsA));
});
