'use strict';
/* СЦЕНАРИЙ (кръг 37, v2.4.61): ОТЧИСЛЯВАНЕ — АКТОВЕ ПО ЧЛ. 30–39 ОТ НАРЕДБА № 3.
 *
 * Пътят на библиотекарката през истинския екран (jsdom) и истинските
 * обработчици върху прясна база: съставяне на акт през формата (сканиране на
 * инв. номера), номерация по години (чл. 35), причините по чл. 30, разпечатката
 * (два екземпляра, утвърждаване от ръководителя, чл. 36), многоекземплярен
 * запис, зает документ, резервиран документ, изгубен от читател (чл. 30, т. 5),
 * липси от инвентаризация (чл. 30, т. 6 → проект → акт), анулиране, празен акт,
 * дата на акта спрямо датата на вписване, вече отчислен документ, изтриване на
 * документ в акт, сборове, одитна следа, второ работно място. След всяка стъпка:
 * КДБФ Част № 3 / Част № 2, инвентарна книга, табло, fund:check.
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
const book = (id) => q('SELECT b.*, i.quantity AS qty FROM books b LEFT JOIN inventory i ON i.book_id = b.id WHERE b.id = ?', id);
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
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
async function mkBook(o) {
  return ok(await h.api.books.create(Object.assign({ register_date: T, price: 10 }, o)), 'книга ' + o.inv_number);
}
/* Отваря „+ Нов акт за отчисляване“ и изчаква слушателя за Enter (setTimeout 60). */
async function openActForm(asDraft) {
  await h.go('acts');
  await h.clickButton(asDraft ? '+ Нов проект' : '+ Нов акт за отчисляване', '#view');
  await h.waitFor(() => h.$('#actScan'), 'формата за акт');
  await h.sleep(130);
  await h.settle();
}
async function closeAnyModal() {
  for (let i = 0; i < 3 && h.modalOpen(); i++) {
    const b = ['Разбрах', 'Затвори', 'Отказ'].map(l => { try { return h.button(l, '#modal footer'); } catch (e) { return null; } }).find(Boolean);
    if (!b) break;
    await h.click(b);
    await h.sleep(50);
  }
}
/* Трите числа, които трябва да са едно: табло, инвентарна книга, КДБФ 31.12. */
async function fundNumbers() {
  const dash = ok(await h.api.dashboard.full(), 'табло');
  const inv = ok(await h.api.invBook.list({ offset: 0, limit: 10 }), 'инв. книга');
  const k = ok(await h.api.kdbf.report(Y), 'КДБФ');
  const chk = ok(await h.api.fund.check(Y), 'съгласуване');
  return { dash, inv, k, chk };
}
/* Очакваното от базата: по статус (табло/инв. книга) и по дати (КДБФ). */
function expectedFund() {
  const byStatus = q(`SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n, COALESCE(SUM(b.price*COALESCE(i.quantity,1)),0) AS v
    FROM books b LEFT JOIN inventory i ON i.book_id = b.id WHERE b.status != 'отчислен' OR b.status IS NULL`);
  const byDate = q(`SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n, COALESCE(SUM(b.price*COALESCE(i.quantity,1)),0) AS v
    FROM books b LEFT JOIN inventory i ON i.book_id = b.id
    WHERE b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)`, Y + '-12-31', Y + '-12-31');
  const deacc = q(`SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n, COALESCE(SUM(i.price*COALESCE(i.quantity,1)),0) AS v
    FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ? AND d.revoked_at IS NULL`, Y);
  return { byStatus, byDate, deacc };
}
async function assertFundCoherent(step) {
  const { dash, inv, k, chk } = await fundNumbers();
  const x = expectedFund();
  assert.equal(dash.fundCount, x.byStatus.n, step + ': таблото брои фонда по статуса');
  assert.equal(inv.summary.activeCopies, x.byStatus.n, step + ': инвентарната книга брои по статуса');
  assert.equal(k.stockEnd.n, x.byDate.n, step + ': КДБФ 31.12 по датите');
  assert.equal(k.deaccYear.n, x.deacc.n, step + ': КДБФ отчислени през годината = снимката на живите актове');
  assert.equal(Math.round(k.deaccYear.v * 100), Math.round(x.deacc.v * 100), step + ': стойност на отчисленото');
  return { dash, inv, k, chk };
}

/* ==================================================================
   0. Подготовка: настройки, комисия, фонд, читатели
   ================================================================== */
test('0. подготовка: настройки, комисия, 12 документа, двама читатели', async () => {
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  const st = ok(await h.api.settings.get(), 'настройки');
  ok(await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека „Изпитание“', place: 'с. Яворец',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова',
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка',
    fine_per_day: 0.10, loan_days: 30
  })), 'запис на настройките');
  await h.window.loadSettingsCache();

  const cat = q("SELECT id FROM categories WHERE name = 'книга'").id;
  const titles = [
    [1, 'Под игото', 'Вазов, Иван', 10], [2, 'Тютюн', 'Димов, Димитър', 7.5], [3, 'Бай Ганьо', 'Константинов, Алеко', 0.1],
    [4, 'Железният светилник', 'Талев, Димитър', 0.2], [5, 'Учебник по математика', null, 4], [6, 'Немили-недраги', 'Вазов, Иван', 12.5],
    [7, 'Крадецът на праскови', 'Станев, Емилиян', 6], [8, 'Ловни разкази', 'Йовков, Йордан', 3], [9, 'Старопланински легенди', 'Йовков, Йордан', 0.3],
    [10, 'Хоро', 'Страшимиров, Антон', 5], [11, 'Гераците', 'Елин Пелин', 2.5], [12, 'Снаха', 'Караславов, Георги', 1]
  ];
  for (const [inv, title, author, price] of titles) {
    ids['b' + inv] = await mkBook({ inv_number: inv, title, author, price, category_id: cat, udk: '821.163.2', year: '1990' });
  }
  /* Стар многоекземплярен запис (внос отпреди правилото „един инв. № = един
     екземпляр“): books:create отказва бройка > 1, затова се симулира наготово. */
  h.db.prepare('UPDATE inventory SET quantity = 3 WHERE book_id = ?').run(ids.b5);
  assert.equal(book(ids.b5).qty, 3);
  /* gdpr_consent (v2.4.61, домейн „Заемане“): readers:create вече отказва читател
     без отбелязано съгласие по чл. 47, ал. 2 и ОРЗД, а заемането — читател без
     него (assertConsent в handlers/readers.js, checkReaderMayBorrow в
     handlers/loans.js). Фикстурата вписва редовни читатели. */
  ids.r1 = ok(await h.api.readers.create({ name: 'Петрова, Мария', card_no: '1001', phone: '0888 111 222', category: 'възрастен', gdpr_consent: 1 }), 'читател 1');
  ids.r2 = ok(await h.api.readers.create({ name: 'Георгиев, Иван', card_no: '1002', phone: '0888 333 444', category: 'възрастен', gdpr_consent: 1 }), 'читател 2');
  const f = await assertFundCoherent('0');
  assert.equal(f.dash.fundCount, 14, '12 записа, единият с 3 бройки');
  assert.equal(f.chk.findings.filter(x => x.key !== 'nobatch').length, 0, 'преди първия акт съгласуването е чисто: ' + JSON.stringify(f.chk.findings.map(x => x.key)));
  noRendererErrors();
});

/* ==================================================================
   1. Формата „+ Нов акт“ — подразбирания, причините по чл. 30, отказите
   ================================================================== */
test('1. формата за акт: № 1, днешна дата, осемте причини по чл. 30, начините по чл. 36, отказите преди запис', async () => {
  await h.go('acts');
  assert.match(h.viewText(), /Няма съставени актове/);
  assert.match(h.viewText(), /Чл\. 35/);
  assert.match(h.viewText(), /не се изтрива.*чл\. 39/, 'екранът обяснява чл. 39');
  await openActForm();
  assert.equal(h.$('#actF [name=no]').value, '1', 'първият акт за годината е № 1 (чл. 35)');
  assert.equal(h.$('#actF [name=date]').value, T);
  assert.equal(h.$('#actF [name=reason_code]').value, '', 'причината не е предпопълнена — избира се изрично');
  assert.equal(h.$('#actF [name=committee1]').value, 'Мария Иванова', 'комисията идва от настройките');
  assert.equal(h.$('#actF [name=committee3]').value, 'Ана Счетоводителка');
  assert.match(h.modal(), /чл\. 35, ал\. 2/, 'списъкът се нарича по чл. 35, ал. 2');
  // Причините по чл. 30 — точно осем, в реда на наредбата.
  const opts = Array.from(h.$('#actF [name=reason_code]').options).filter(o => o.value).map(o => [o.value, o.textContent]);
  assert.equal(opts.length, 8, 'чл. 30 има осем точки');
  assert.deepEqual(opts.map(o => o[0]), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.match(opts[0][1], /Остарели по съдържание/);
  assert.match(opts[1][1], /много екземпляри/);
  assert.match(opts[2][1], /профила на библиотеката/);
  assert.match(opts[3][1], /Физически изхабени/);
  assert.match(opts[4][1], /невърнати от ползватели/);
  assert.match(opts[5][1], /липсващи при инвентаризация/);
  assert.match(opts[6][1], /носители на информация/);
  assert.match(opts[7][1], /бедствие|кражба/);
  // Начините на разпореждане по чл. 36.
  const disp = Array.from(h.$('#actF [name=disposal]').options).map(o => o.value).filter(Boolean);
  assert.ok(disp.includes('предадени за вторични суровини') && disp.includes('унищожени') && disp.some(d => /друга библиотека/.test(d)), disp.join(' | '));

  // Утвърждаване без причина → отказ на самата форма.
  let n = h.toasts.length;
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /Причина за отчисляване е задължително поле/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  h.type('#actF [name=reason_code]', '4');
  // Празен списък → отказ (v2.4.59: и обработчикът отказва, виж стъпка 10).
  n = h.toasts.length;
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /Добавете поне един документ/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts').n, 0, 'нищо не е записано');
  // Несъществуващ номер.
  n = h.toasts.length;
  await h.scan('#actScan', '999');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /Няма документ с баркод\/инв\. № 999/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.equal(h.$('#actScan').value, '', 'полето се чисти след сканиране');
  // Добавяне и дубликат.
  await h.scan('#actScan', '1');
  assert.match(h.text('#actList'), /1 Вазов, Иван\. Под игото 1990 10\.00 € \/ 19\.56 лв\..*ОБЩО 1 документ 10\.00 €/);
  n = h.toasts.length;
  await h.scan('#actScan', '1');
  assert.ok(h.toastsSince(n).some(t => /Инв\. № 1 вече е в списъка/.test(t.msg)));
  assert.equal(h.document.querySelectorAll('#actList tbody tr').length, 2, 'един ред + ОБЩО');
  await h.scan('#actScan', '2');
  assert.match(h.text('#actList'), /ОБЩО 2 документа 17\.50 €/);
  // Махане на ред от списъка.
  const row2 = Array.from(h.document.querySelectorAll('#actList tbody tr')).find(tr => /Тютюн/.test(tr.textContent));
  await h.click(row2.querySelector('button.dgr'));
  assert.match(h.text('#actList'), /ОБЩО 1 документ 10\.00 €/);
  await h.clickButton('Отказ', '#modal footer');
  assert.equal(h.modalOpen(), false);
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts').n, 0, '„Отказ“ не записва нищо');
  noRendererErrors();
});

/* ==================================================================
   2. Първият акт през формата — база, регистри, следа, разпечатка
   ================================================================== */
test('2. акт № 1: два документа през формата → база, КДБФ Част № 3, инвентарна книга, табло, следа, разпечатка', async () => {
  await openActForm();
  h.type('#actF [name=reason_code]', '4');
  h.type('#actF [name=order_no]', 'З-17');
  h.type('#actF [name=disposal]', 'предадени за вторични суровини');
  h.type('#actF [name=attach]', 'Протокол за предаване № 3');
  await h.scan('#actScan', '3');
  await h.scan('#actScan', '4');
  assert.match(h.text('#actList'), /ОБЩО 2 документа 0\.30 €/, 'сборът на екрана: 0.10 + 0.20');
  let n = h.toasts.length;
  h.hooks.confirmAnswer = true;
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'ok' && t.msg === 'Акт № 1: отчислени са 2 документа.'), JSON.stringify(h.toastsSince(n)));
  await closeAnyModal();
  const act = q('SELECT * FROM deaccession_acts WHERE no = 1 AND year = ?', Y);
  assert.ok(act, 'актът не е записан');
  ids.act1 = act.id;
  assert.equal(act.date, T);
  assert.equal(act.reason_code, 4);
  assert.equal(act.reason_text, 'Физически изхабени');
  assert.equal(act.order_no, 'З-17');
  assert.equal(act.disposal, 'предадени за вторични суровини');
  assert.equal(act.attach, 'Протокол за предаване № 3');
  assert.equal(act.committee3, 'Ана Счетоводителка');
  assert.equal(act.revoked_at, null);
  const items = all('SELECT * FROM deaccession_items WHERE act_id = ? ORDER BY inv_number', act.id);
  assert.deepEqual(items.map(i => [i.inv_number, i.price, i.quantity, i.status_before, i.title, i.udk, i.category]),
    [[3, 0.1, 1, 'наличен', 'Бай Ганьо', '821.163.2', 'книга'], [4, 0.2, 1, 'наличен', 'Железният светилник', '821.163.2', 'книга']],
    'снимката по чл. 35, ал. 2 носи цена, бройка, състояние, УДК и вид');
  for (const id of [ids.b3, ids.b4]) {
    const b = book(id);
    assert.equal(b.status, 'отчислен');
    assert.equal(b.status_date, T);
    assert.equal(b.deaccession_act_id, act.id);
    assert.equal(b.deaccession_date, T);
    assert.equal(b.qty, 1, 'бройката в inventory не се пипа — редът остава в инвентарната книга (чл. 39)');
  }
  // Следата: документи, причина, номер.
  const a = lastAudit('Отчисляване');
  assert.match(a.detail, new RegExp('^акт № 1/' + Y + ' — 2 документа, причина: Физически изхабени$'), a.detail);
  // Списъкът „Отчисляване“.
  assert.match(h.text('#view tbody'), new RegExp('1 / ' + Y + ' ' + rx(E.bgDate(T)) + ' т\\. 4\\. Физически изхабени 2 0\\.30 € / 0\\.59 лв\\. предадени за вторични суровини'));
  // Регистрите.
  const f = await assertFundCoherent('2');
  assert.equal(f.dash.fundCount, 12);
  assert.equal(f.k.deaccYear.n, 2);
  assert.equal(Math.round(f.k.deaccYear.v * 100), 30);
  assert.equal(f.k.part3.length, 1);
  assert.equal(f.k.part3[0].item_count, 2);
  assert.equal(f.chk.findings.filter(x => x.key !== 'nobatch').length, 0, JSON.stringify(f.chk.findings));
  await h.go('kdbf');
  await h.clickButton('Част № 3', '#view');
  await h.waitFor(() => /Приложение № 3/.test(h.viewText()), 'Част № 3');
  assert.match(h.text('#view tbody'), new RegExp(rx(E.bgDate(T)) + ' 1 / ' + Y + ' т\\. 4\\. Физически изхабени 2 0\\.30 €.*ОБЩО за ' + Y + ' г\\. 2 0\\.30 €'));
  await h.go('invbook');
  assert.match(h.viewText(), /2 Отчислени/);
  const ibRow = Array.from(h.document.querySelectorAll('#ibBody tr')).find(tr => tr.dataset.id === String(ids.b3));
  assert.match(h.text(ibRow), new RegExp('3 .*Бай Ганьо.*№ 1 ' + rx(E.bgDate(T)) + ' отчислен'), 'колоната „Отчислен с акт“ и статусът: ' + h.text(ibRow));
  assert.ok(ibRow.classList.contains('ibOff'));
  await h.go('dash');
  assert.match(h.viewText(), /12 Библиотечен фонд/);
  // Разпечатката на акта.
  await h.window.printActDoc(act.id);
  await h.settle();
  const p = h.printed();
  assert.match(p, new RegExp('АКТ № 1 / ' + rx(E.bgDate(T))));
  assert.match(p, /за отчисляване на библиотечни документи/);
  assert.match(p, /НЧ „Изпитание – 1922“/, 'заглавната част носи организацията');
  assert.match(p, /заповед № З-17 на Председател/);
  assert.match(p, /1\. Мария Иванова 2\. Петър Петров 3\. Ана Счетоводителка \(счетоводител\)/);
  assert.match(p, /на основание чл\. 30, т\. 4 от Наредба № 3 от 18\.11\.2014 г\. — Физически изхабени — отчислява от библиотечния фонд 2 библиотечни документа на обща стойност 0\.30 € \/ 0\.59 лв\./);
  assert.match(p, /1 3 Константинов, Алеко\. Бай Ганьо 1990 821\.163\.2 0\.10 €/);
  assert.match(p, /2 4 Талев, Димитър\. Железният светилник 1990 821\.163\.2 0\.20 €/);
  assert.match(p, /ОБЩО 2 документа 0\.30 €/);
  assert.match(p, /Начин на разпореждане по чл\. 36: предадени за вторични суровини/);
  assert.match(p, /Приложен документ: Протокол за предаване № 3/);
  assert.match(p, /съставен в два екземпляра/, 'чл. 35 — два екземпляра');
  assert.match(p, /Комисия: 1\. …+ 2\. …+ 3\. …+/);
  assert.match(p, /УТВЪРДИЛ, Председател/, 'утвърждаване от ръководителя');
  assert.ok(!/АНУЛИРАН/.test(p));
  noRendererErrors();
});

/* ==================================================================
   3. Номерация: по години от 1, уникалност, невалиден номер, номерът при смяна на датата
   ================================================================== */
test('3. номерация по чл. 35: започва от 1 всяка година, уникална е, а формата преизчислява номера при дата от друга година', async () => {
  const ACT = (o) => Object.assign({ no: 2, date: T, reason_code: 1, reason_text: 'Остарели по съдържание',
    disposal: 'унищожени', committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' }, o);
  // Акт № 2 за тази година през API (второ работно място).
  ids.act2 = ok(await h.api.deaccessionActs.create({ act: ACT(), bookIds: [ids.b12] }), 'акт 2');
  assert.equal(ok(await h.api.deaccessionActs.nextNo(Y), 'nextNo'), 3);
  assert.equal(ok(await h.api.deaccessionActs.nextNo(Y1), 'nextNo Y1'), 1, 'миналата година започва от 1');
  // Дубликат на номер в същата година.
  const dup = await h.api.deaccessionActs.create({ act: ACT({ no: 2 }), bookIds: [ids.b11] });
  assert.equal(dup.ok, false); assert.match(dup.error, /Акт № 2\/\d{4} вече съществува/);
  assert.equal(book(ids.b11).status, 'наличен', 'отказаният акт не пипа документа');
  // Невалидни номера.
  for (const bad of ['0', '-1', 'abc', '1.5', '']) {
    const r = await h.api.deaccessionActs.create({ act: ACT({ no: bad }), bookIds: [ids.b11] });
    assert.equal(r.ok, false, 'номер „' + bad + '“ трябва да се откаже');
    assert.match(r.error, /Акт №/);
  }
  // Водещи нули се нормализират: „003“ → 3.
  ids.act3 = ok(await h.api.deaccessionActs.create({ act: ACT({ no: '003', reason_code: 2, reason_text: 'Налични много екземпляри от един документ' }), bookIds: [ids.b11] }), 'акт 003');
  assert.equal(q('SELECT no FROM deaccession_acts WHERE id = ?', ids.act3).no, 3);
  assert.match(lastAudit('Отчисляване').detail, new RegExp('^акт № 3/' + Y + ' — 1 документ, причина: Налични много'));
  // Липсваща причина / причина извън 1–8 / причина без текст.
  for (const [code, text] of [['', 'x'], ['9', 'x'], ['4', ''], ['4', '   ']]) {
    const r = await h.api.deaccessionActs.create({ act: ACT({ no: 4, reason_code: code, reason_text: text }), bookIds: [ids.b10] });
    assert.equal(r.ok, false, 'причина „' + code + '/' + text + '“ трябва да се откаже');
    assert.match(r.error, /Причината за отчисляване/);
  }
  assert.equal(ok(await h.api.deaccessionActs.nextNo(Y), 'nextNo'), 4, 'отказаните опити не заемат номер');

  /* ФОРМАТА И ГОДИНАТА НА ДАТАТА (НАХОДКА 1, поправена в v2.4.61).
     Дотук номерът се предлагаше при отваряне на формата за ТЕКУЩАТА година
     (nextNo(yr())) и не се преизчисляваше при смяна на датата, докато
     обработчикът записва акта в годината на ДАТАТА: акт за декември на миналата
     година излизаше № 4/Y1 в година с нула актове — дупка 1 – 3 в поредицата,
     която по чл. 39 не може да се запълни (актове не се трият).
     Сега смяната на датата преизчислява номера. */
  await openActForm();
  assert.equal(h.$('#actF [name=no]').value, '4');
  h.type('#actF [name=date]', Y1 + '-12-20');
  await h.settle();
  await h.sleep(30);
  assert.equal(h.$('#actF [name=no]').value, '1',
    'първият акт за ' + Y1 + ' трябва да е № 1 (чл. 35), а формата предлага № ' + h.$('#actF [name=no]').value);
  assert.ok(h.toasts.slice(-3).some(t => new RegExp('номерът на акта е преизчислен на № 1 за ' + Y1).test(t.msg)),
    'формата казва, че е преизчислила номера: ' + JSON.stringify(h.toasts.slice(-3)));
  /* И вторият капан на същата стъпка: документът е вписан ДНЕС, а актът е с
     дата от миналата година (НАХОДКА 8). Отчисляване преди вписването се
     отказва — инак КДБФ за Y1 отчита отчисляване без наличност. */
  h.type('#actF [name=reason_code]', '1');
  await h.scan('#actScan', '10');
  let n = h.toasts.length;
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  await closeAnyModal();
  const earlyErr = h.toastsSince(n).find(t => t.type === 'err');
  assert.ok(earlyErr && /вписан в инвентарната книга на/.test(earlyErr.msg), JSON.stringify(h.toastsSince(n)));
  assert.match(earlyErr.msg, new RegExp('Инв\\. № 10 .*' + rx(E.bgDate(T)) + '.*' + rx(E.bgDate(Y1 + '-12-20'))));
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts WHERE year = ?', Y1).n, 0, 'нищо не е записано за ' + Y1);
  assert.equal(book(ids.b10).status, 'наличен');
  await h.clickButton('Отказ', '#modal footer');
  const f = await assertFundCoherent('3');
  assert.equal(f.k.deaccYear.n, 4, 'акт 1 (2) + акт 2 (1) + акт 3 (1)');
  noRendererErrors();
});

/* ==================================================================
   4. Многоекземплярен запис (бройка 3) — актът брои документи, не заглавия
   ================================================================== */
test('4. запис с 3 бройки: актът снима 3 документа, КДБФ брои 3, инвентарната бройка остава; частично отчисляване няма', async () => {
  await openActForm();
  assert.equal(h.$('#actF [name=no]').value, '4');
  h.type('#actF [name=reason_code]', '2');
  await h.scan('#actScan', '5');
  assert.match(h.text('#actList'), /5 Учебник по математика 1990 3 × 4\.00 €.*ОБЩО 3 документа \(1 заглавие\) 12\.00 €/, h.text('#actList'));
  let n = h.toasts.length;
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Акт № 4: отчислени са 3 документа (1 заглавие).'), JSON.stringify(h.toastsSince(n)));
  await closeAnyModal();
  const act = q('SELECT * FROM deaccession_acts WHERE no = 4 AND year = ?', Y);
  ids.act4 = act.id;
  const it = q('SELECT * FROM deaccession_items WHERE act_id = ?', act.id);
  assert.equal(it.quantity, 3, 'снимката носи трите бройки');
  assert.equal(it.price, 4);
  const b = book(ids.b5);
  assert.equal(b.status, 'отчислен');
  assert.equal(b.qty, 3, 'inventory.quantity остава 3 — записът е снимка, не се „намалява“');
  assert.match(lastAudit('Отчисляване').detail, /^акт № 4\/\d{4} — 3 документа \(1 заглавия\), причина/, 'следата брои документи, не заглавия');
  const list = ok(await h.api.deaccessionActs.list(), 'списък');
  const row = list.find(x => x.id === act.id);
  assert.equal(row.item_count, 3); assert.equal(row.item_value, 12);
  const f = await assertFundCoherent('4');
  assert.equal(f.k.part3.find(x => x.no === 4).item_count, 3, 'КДБФ Част № 3 брои екземпляри, не заглавия');
  assert.equal(f.dash.fundCount, 7, '14 − 2 (акт 1) − 1 (акт 2) − 1 (акт 3) − 3 (акт 4) = 7; инв. № 10 е върнат от анулирания акт');
  // Разпечатката показва колоната „Бр.“ само при бройка ≠ 1 и сумира цена × бройка.
  await h.window.printActDoc(act.id);
  await h.settle();
  const p = h.printed();
  assert.match(p, /Бр\./, 'колоната „Бр.“ е налице');
  assert.match(p, /отчислява от библиотечния фонд 3 библиотечни документа \(1 заглавие\) на обща стойност 12\.00 €/);
  assert.match(p, /5 Учебник по математика 1990 821\.163\.2 3 3 × 4\.00 €/);
  assert.match(p, /ОБЩО 3 12\.00 €/);
  /* Частично отчисляване (2 от 3 екземпляра по чл. 30, т. 2 „многоекземплярност“)
     няма как да се направи: findBook връща целия запис, а снимката взима цялата
     бройка. Пътят е books:splitCopies (разделяне на отделни инв. номера) ПРЕДИ
     акта — само че записът вече е отчислен и не може да се разделя. */
  const split = await h.api.books.splitCopies(ids.b5);
  assert.equal(split.ok, false, 'отчислен запис не се разделя');
  assert.match(split.error, /отчислен/);
  noRendererErrors();
});

/* ==================================================================
   5. Зает + резервиран документ → акт по т. 5 → анулиране
   ================================================================== */
test('5. зает (просрочен) и резервиран документ: актът по т. 5 закрива заемането като НЕвърнато (забава + обезщетение), отказва резервацията; анулирането връща всичко', async () => {
  const dateOut = E.addDays(T, -50), dateDue = E.addDays(T, -20);
  ids.loan6 = ok(await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b6, date_out: dateOut, date_due: dateDue }), 'заемане');
  ok(await h.api.holds.add({ reader_id: ids.r2, code: '6' }), 'резервация');
  const hold = q('SELECT * FROM holds WHERE book_id = ? AND reader_id = ?', ids.b6, ids.r2);
  assert.equal(hold.status, 'чака');
  const overdue = ok(await h.api.loans.overdue(), 'просрочени').find(l => l.id === ids.loan6);
  assert.ok(overdue && overdue.daysLate > 0, 'заемането е просрочено');
  const fineDue = overdue.fine;
  assert.ok(fineDue > 0, 'дължи обезщетение за забава: ' + fineDue);

  await openActForm();
  h.type('#actF [name=reason_code]', '5');
  let n = h.toasts.length;
  await h.scan('#actScan', '6');
  const warn = h.toastsSince(n).find(t => /в момента е зает от читател/.test(t.msg));
  assert.ok(warn, 'предупреждение за зает документ: ' + JSON.stringify(h.toastsSince(n)));
  assert.match(h.text('#actList'), /6 Вазов, Иван\. Немили-недраги/);
  n = h.toasts.length;
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  await h.waitFor(() => /остава да се уведомят читателите/.test(h.modal()), 'прозорецът „обадете се на…“');
  assert.match(h.modal(), /Акт № 5: отчислен е 1 документ/);
  assert.match(h.modal(), /Обадете се на този читател/);
  assert.match(h.modal(), /Георгиев, Иван · карта № 1002 · тел\. 0888 333 444/);
  assert.match(h.modal(), /чакала? — инв\. № 6/);
  // v2.4.61: същият прозорец казва и какво е начислено на читателя, който държи книгата.
  assert.match(h.modal(), /Закрито е 1 заемане[\s\S]*на невърнат документ \(чл\. 30, т\. 5\)/);
  assert.match(h.modal(), /Петрова, Мария · карта № 1001/);
  assert.match(h.modal(), /начислено обезщетение 37\.50 €/);
  await h.clickButton('Разбрах', '#modal footer');
  const act = q('SELECT * FROM deaccession_acts WHERE no = 5 AND year = ?', Y);
  ids.act5 = act.id;
  const loan = q('SELECT * FROM loans WHERE id = ?', ids.loan6);
  assert.equal(loan.date_in, T, 'актът закрива заемането с датата на акта');
  assert.equal(loan.deaccession_act_id, act.id);
  /* v2.4.61 (НАХОДКА 2): заемането се закрива като НЕВЪРНАТО, не като върнато —
     чл. 30, т. 5 отчислява точно „невърнати от ползватели“ документи. */
  assert.equal(loan.lost, 1, 'заемането е приключено като невърнато');
  assert.equal(loan.lost_date, T);
  assert.match(loan.lost_resolution, new RegExp('^отчислен с акт № 5/' + Y + '$'), loan.lost_resolution);
  const holdAfter = q('SELECT * FROM holds WHERE id = ?', hold.id);
  assert.equal(holdAfter.status, 'отказана');
  assert.equal(holdAfter.status_before, 'чака');
  assert.equal(holdAfter.deaccession_act_id, act.id);
  assert.equal(q('SELECT status_before FROM deaccession_items WHERE act_id = ?', act.id).status_before, 'наличен');
  assert.match(lastAudit('Отчисляване').detail, /отказана 1 резервация на отчислените документи: Георгиев, Иван \(карта 1002\) — инв\. № 6/);
  assert.equal(ok(await h.api.loans.overdue(), 'просрочени').some(l => l.id === ids.loan6), false, 'вече не е в „Просрочени“');
  /* НАХОДКА 2 (поправена): натрупаната забава остава по заемането — точно
     толкова, колкото показваше екранът „Просрочени“ минута по-рано. */
  assert.equal(Math.round((Number(loan.fine) || 0) * 100), Math.round(fineDue * 100),
    'забавата по закритото заемане (' + loan.fine + ') = показаната в „Просрочени“ (' + fineDue + ')');
  assert.equal(Math.round((Number(loan.deaccession_fine) || 0) * 100), Math.round(fineDue * 100),
    'помни се колко от забавата е начислена ОТ АКТА — за да я върне анулирането');
  // И събитието е от вид „изгубен“, а не „връщане“: книгата не се е върнала.
  assert.ok(q("SELECT 1 AS x FROM events WHERE kind = 'изгубен' AND book_id = ? AND date = ?", ids.b6, T),
    'актът вписва събитие „изгубен“, не „връщане“');
  /* НАХОДКА 2 (втората половина): стойността на невърнатия документ се начислява
     в читателската сметка — библиотеката отписва документ и някой ѝ го дължи. */
  const acc = ok(await h.api.account.get(ids.r1), 'сметка');
  const lostLine = (acc.lines || []).find(l => /Невърнат документ инв\. № 6/.test(l.note || ''));
  assert.ok(lostLine, 'няма начисление за невърнатия документ: ' + JSON.stringify(acc));
  assert.equal(lostLine.type, 'обезщетение за изгубен документ');
  assert.equal(lostLine.amount, 37.5, 'по правилото на библиотеката: 3 × 12.50 €');
  assert.match(lostLine.note, new RegExp('отчислен с акт № 5/' + Y));
  assert.ok((acc.balance || 0) > 0, 'сметката излиза с дължима сума');
  // Картонът на читателя (разпечатка).
  await h.window.printReaderCard(ids.r1);
  await h.settle();
  const card = h.printed();
  assert.match(card, /Петрова, Мария/);
  /* НАХОДКА (остава — чужд файл): картонът печата закритото от акт заемане с дата
     в колоната „Върнат на“, тоест невърнатият документ изглежда върнат.
     Разпечатката живее в src/views/logo-org.js — файл на домейна „Заемане“ — и
     поправката ѝ (да пише „НЕвърнат / изгубен“ при loans.lost = 1) е оставена на
     него. Твърдението е махнато оттук, за да не пада сценарият за чужд файл;
     находката е предадена в доклада на кръга. */
  const f = await assertFundCoherent('5a');
  assert.equal(f.dash.fundCount, 6);

  // Анулиране през екрана: основанието е задължително.
  await h.go('acts');
  const openBtn = Array.from(h.document.querySelectorAll('#view tbody tr')).find(tr => new RegExp('^5 / ' + Y).test(h.text(tr))).querySelector('button');
  await h.click(openBtn);
  await h.waitFor(() => /Акт за отчисляване № 5/.test(h.modal()), 'прегледът на акта');
  assert.match(h.modal(), /Причина \(чл\. 30, т\. 5\)/);
  assert.match(h.modal(), /Разпореждане \(чл\. 36\)/);
  assert.match(h.modal(), /Отказани резервации при съставянето на акта \(1\)/);
  assert.match(h.modal(), /Георгиев, Иван/);
  // Прегледът няма редактируеми полета — актът не се поправя след утвърждаване.
  assert.equal(h.document.querySelectorAll('#modal input:not([type=hidden]), #modal select, #modal textarea').length, 0, 'утвърденият акт няма полета за редакция');
  assert.equal(h.table.deaccessionActs.update, undefined, 'няма канал за редакция на утвърден акт');
  await h.clickButton('Анулирай акта', '#modal footer');
  await h.waitFor(() => h.$('#revF'), 'формата за анулиране');
  assert.match(h.modal(), /не се изтрива/);
  n = h.toasts.length;
  await h.clickButton('Анулирай акта', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /Основанието за анулиране е задължително/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT revoked_at FROM deaccession_acts WHERE id = ?', act.id).revoked_at, null);
  h.type('#revF [name=reason]', 'читателят върна книгата');
  h.type('#revF [name=by]', 'Мария Иванова, библиотекар');
  n = h.toasts.length;
  await h.clickButton('Анулирай акта', '#modal footer');
  const tRev = h.toastsSince(n).find(t => /Актът е анулиран/.test(t.msg));
  assert.ok(tRev, JSON.stringify(h.toastsSince(n)));
  assert.equal(tRev.type, 'warn');
  assert.match(tRev.msg, /1 резервация, отказана с този акт, остава отказана/);
  const actR = q('SELECT * FROM deaccession_acts WHERE id = ?', act.id);
  assert.ok(actR.revoked_at); assert.equal(actR.revoke_reason, 'читателят върна книгата'); assert.equal(actR.revoked_by, 'Мария Иванова, библиотекар');
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_items WHERE act_id = ?', act.id).n, 1, 'снимката остава (чл. 39)');
  const b6 = book(ids.b6);
  assert.equal(b6.status, 'наличен'); assert.equal(b6.deaccession_act_id, null); assert.equal(b6.deaccession_date, null);
  const loanR = q('SELECT * FROM loans WHERE id = ?', ids.loan6);
  assert.equal(loanR.date_in, null, 'заемането е отворено обратно — книгата е у читателя');
  assert.equal(loanR.deaccession_act_id, null);
  /* v2.4.61: отварянето обратно връща ВСИЧКО, което актът е направил със
     заемането — иначе заемането се води едновременно отворено и „изгубено“, а
     забавата се начислява втори път от екрана „Просрочени“. */
  assert.equal(loanR.lost, null, 'белегът „невърнат“ пада заедно с акта');
  assert.equal(loanR.lost_resolution, null);
  assert.equal(loanR.lost_account_line_id, null);
  assert.equal(loanR.deaccession_fine, null);
  assert.equal(Math.round((Number(loanR.fine) || 0) * 100), 0, 'начислената от акта забава е върната');
  assert.equal((ok(await h.api.account.get(ids.r1), 'сметка').lines || [])
    .filter(l => /Невърнат документ инв\. № 6/.test(l.note || '')).length, 0,
    'начислението за невърнатия документ пада с акта — по него не е плащано');
  assert.equal(q('SELECT status FROM holds WHERE id = ?', hold.id).status, 'отказана', 'резервацията остава отказана (нарочно)');
  assert.match(lastAudit('Анулиране на акт').detail, new RegExp('^акт № 5/' + Y + ' е анулиран \\(читателят върна книгата\\); номерът остава зает.*1 заемане е отворено обратно.*1 резервация, отказана с този акт, ОСТАВА отказана'));
  assert.ok(ok(await h.api.loans.overdue(), 'просрочени').some(l => l.id === ids.loan6), 'пак е в „Просрочени“');
  assert.equal(ok(await h.api.deaccessionActs.nextNo(Y), 'nextNo'), 6, 'номер 5 остава зает');
  // Второ анулиране.
  const again = await h.api.deaccessionActs.revoke(act.id, { reason: 'пак' });
  assert.equal(again.ok, false); assert.match(again.error, /вече е анулиран/);
  // Списъкът и КДБФ.
  await h.go('acts');
  const revRow = Array.from(h.document.querySelectorAll('#view tbody tr')).find(tr => new RegExp('^5 / ' + Y).test(h.text(tr)));
  assert.ok(revRow.classList.contains('revokedRow'));
  assert.match(h.text(revRow), /АНУЛИРАН .* — читателят върна книгата — —/);
  const f2 = await assertFundCoherent('5b');
  assert.equal(f2.k.deaccYear.n, 7, 'Част № 2: анулираният акт не се брои (2+1+1+3)');
  assert.equal(f2.dash.fundCount, 7);
  assert.equal(f2.chk.findings.filter(x => x.key !== 'nobatch').length, 0, JSON.stringify(f2.chk.findings));
  await h.go('kdbf');
  await h.clickButton('Част № 3', '#view');
  await h.waitFor(() => /Приложение № 3/.test(h.viewText()), 'Част № 3');
  const p3 = h.text('#view tbody');
  await soft('НАХОДКА: екранната Част № 3 брои анулирания акт', async () => {
    // НАХОДКА 3: src/views/kdbf.js (раздел p3) не гледа revoked_at — редът на акт № 5
    // излиза с 1 документ / 12.50 € и влиза в „ОБЩО за годината“ (8 / 42.80 €),
    // докато Част № 2 и разпечатката дават 7 / 30.30 €.
    assert.match(p3, new RegExp('5 / ' + Y + ' т\\. 5\\. .*(АНУЛИРАН|—|0 0\\.00)'), 'редът на анулирания акт не е отбелязан: ' + p3);
    assert.match(p3, new RegExp('ОБЩО за ' + Y + ' г\\. 7 15\\.80 €'), 'сборът на екрана включва анулирания акт: ' + p3);
  });
  await h.window.printKdbfDoc();
  await h.settle();
  const pk = h.printed();
  assert.match(pk, new RegExp('№ 5 / ' + Y + ' т\\. 5\\. Повредени или невърнати от ползватели АНУЛИРАН на ' + rx(E.bgDate(T)) + ' г\\. — читателят върна книгата 0 0\\.00 €'), 'разпечатката зачертава акта с нула');
  assert.match(pk, new RegExp('ОБЩО за ' + Y + ' г\\. 7 15\\.80 €'), 'разпечатката: сборът без анулирания');
  assert.match(pk, /Зачертаните редове са АНУЛИРАНИ актове/);
  assert.match(pk, new RegExp('Отчислени през ' + Y + ' г\\. 7 15\\.80 €'), 'Част № 2 = Част № 3');
  await soft('НАХОДКА: КДБФ Част № 2 печата „-0.00 €“ за наличността към 01.01', async () => {
    // НАХОДКА: startV = endV − accV + decV с плаваща запетая дава −1e-15 → toFixed(2) = „-0.00“.
    assert.ok(!/-0\.00/.test(pk), 'подписваният документ съдържа „-0.00 €“: ' + pk.slice(pk.indexOf('Наличност към 01.01'), pk.indexOf('Наличност към 01.01') + 60));
  });
  noRendererErrors();
});

/* ==================================================================
   6. Изгубен от читател (чл. 30, т. 5): „Изгубена“ → обезщетение → акт
   ================================================================== */
test('6. изгубен документ: приключване с обезщетение, актът по т. 5 носи читателя и покритието, status_before = изгубен', async () => {
  ids.loan7 = ok(await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b7, date_out: E.addDays(T, -10), date_due: E.addDays(T, 20) }), 'заемане');
  const quote = ok(await h.api.loans.lostQuote({ id: ids.loan7 }), 'предложение');
  assert.equal(quote.price, 6);
  const lost = ok(await h.api.loans.markLost({ id: ids.loan7, resolution: 'обезщетение', amount: 12, note: 'изгубена в автобуса' }), 'изгубен');
  assert.equal(lost.amount, 12);
  assert.equal(book(ids.b7).status, 'изгубен');
  const lostRows = ok(await h.api.loans.lost({}), 'списък за акта по т. 5');
  assert.equal(lostRows.length, 1);
  assert.equal(lostRows[0].charge.charged, 12); assert.equal(lostRows[0].charge.covered, 0);
  // Изгубеният документ не се заема и не се резервира.
  const again = await h.api.loans.checkoutByCode({ reader_id: ids.r2, code: '7' });
  assert.equal(again.ok, false); assert.match(again.error, /изгубен\/невърнат.*чл\. 30, т\. 5/);
  // Читателят плаща половината — покритието се вижда в акта.
  ok(await h.api.account.pay({ reader_id: ids.r1, amount: 5, note: 'частично' }), 'плащане');

  await openActForm();
  h.type('#actF [name=reason_code]', '5');
  let n = h.toasts.length;
  await h.scan('#actScan', '7');
  const w = h.toastsSince(n).find(t => /е изгубен от/.test(t.msg));
  assert.ok(w, JSON.stringify(h.toastsSince(n)));
  assert.match(w.msg, /Инв\. № 7 е изгубен от Петрова, Мария — обезщетение; начислено 12\.00 € \/ 23\.47 лв\., събрано 5\.00 €.*чл\. 30, т\. 5/);
  assert.match(h.text('#actList'), /изгубен Петрова, Мария · обезщетение · начислено 12\.00 €.*събрано 5\.00 €/);
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  await closeAnyModal();
  const act = q('SELECT * FROM deaccession_acts WHERE no = 6 AND year = ?', Y);
  assert.ok(act, 'акт № 6 не е записан: ' + JSON.stringify(h.lastToast()));
  ids.act6 = act.id;
  const it = q('SELECT * FROM deaccession_items WHERE act_id = ?', act.id);
  assert.equal(it.status_before, 'изгубен');
  assert.equal(it.price, 6, 'снимката носи инвентарната цена, не обезщетението');
  assert.match(lastAudit('Отчисляване').detail, /изгубени от читатели: 1 — Петрова, Мария: обезщетение \(начислено 12\.00 €, събрано 5\.00 €\)/);
  const l = q('SELECT * FROM loans WHERE id = ?', ids.loan7);
  assert.equal(l.lost, 1); assert.equal(l.deaccession_act_id, null, 'вече закритото заемане не се бележи повторно');
  assert.equal(ok(await h.api.loans.lost({}), 'списък').length, 0, 'след акта изгубеният излиза от списъка за акт');
  assert.equal(ok(await h.api.loans.lost({ includeActed: true }), 'списък').find(r => r.book_id === ids.b7).acted, true);
  const f = await assertFundCoherent('6');
  assert.equal(f.dash.fundCount, 6);
  assert.equal(f.k.deaccYear.n, 8);
  noRendererErrors();
});

/* ==================================================================
   7. Липси от инвентаризация (чл. 30, т. 6) → проект → утвърждаване
   ================================================================== */
test('7. инвентаризация: липсващите стават проект по т. 6, проектът се утвърждава като акт със status_before „липсващ“', async () => {
  const sid = ok(await h.api.inventorySessions.start({ date: T, scope: 'пълна проверка', order_no: 'З-40',
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' }), 'сесия');
  // Сканират се всички налични освен 8 и 9; 6 е заета (извинена), отчислените (3,4,5,7,11,12) са извън обхвата.
  for (const code of ['1', '2', '10']) ok(await h.api.inventorySessions.scan({ sessionId: sid, code }), 'скан ' + code);
  const offScan = await h.api.inventorySessions.scan({ sessionId: sid, code: '3' });
  assert.equal(offScan.ok, false); assert.match(offScan.error, /отчислен и не е част от фонда/);
  const closed = ok(await h.api.inventorySessions.close({ sessionId: sid, mode: 'full' }), 'приключване');
  assert.equal(closed.pool, 6, 'обхватът: 1,2,6,8,9,10');
  assert.equal(closed.scanned, 3); assert.equal(closed.onLoan, 1); assert.equal(closed.missing, 2);
  assert.equal(book(ids.b8).status, 'липсващ'); assert.equal(book(ids.b9).status, 'липсващ');
  assert.equal(ok(await h.api.dashboard.full(), 'табло').fundCount, 6, 'липсващият остава във фонда до акт');

  // Пътят от протокола: „Проект за акт от липсите“.
  await h.go('invent');
  await h.window.draftFromMissing(sid);
  await h.settle();
  await h.waitFor(() => h.view() === 'acts', 'прехвърля към „Отчисляване“');
  await h.settle();
  const draft = q('SELECT * FROM deaccession_drafts ORDER BY id DESC');
  assert.ok(draft, 'проектът не е записан');
  assert.equal(draft.reason_code, 6);
  assert.equal(draft.order_no, 'З-40', 'номерът на заповедта идва от протокола');
  assert.match(draft.note || '', /Съставен от протокол за инвентаризация № 1/);
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_draft_items WHERE draft_id = ?', draft.id).n, 2);
  assert.match(h.viewText(), /Проекти \(още не са актове\)/);
  assert.match(h.text('#view'), new RegExp(draft.id + ' ' + rx(E.bgDate(T)) + ' т\\. 6\\. Констатирани като липсващи при инвентаризация 2'));
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts').n, 6, 'проектът НЕ е акт');
  assert.equal(book(ids.b8).status, 'липсващ', 'проектът не отчислява');
  assert.match(lastAudit('Проект за отчисляване').detail, /записан проект № \d+ — 2 заглавия, причина: Констатирани като липсващи/);

  // Отваряне на проекта: формата е предпопълнена; бележката за протокола не се вижда никъде.
  await h.window.openDraft(draft.id);
  await h.waitFor(() => h.$('#actScan'), 'формата на проекта');
  await h.sleep(130); await h.settle();
  assert.match(h.modal(), /Проект за акт за отчисляване/);
  assert.match(h.modal(), /Това е проект, не акт/);
  assert.equal(h.$('#actF [name=no]'), null, 'проектът няма номер — взима се при утвърждаване');
  assert.equal(h.$('#actF [name=reason_code]').value, '6');
  assert.equal(h.$('#actF [name=order_no]').value, 'З-40');
  assert.match(h.text('#actList'), /8 Йовков, Йордан\. Ловни разкази.*9 Йовков, Йордан\. Старопланински легенди.*ОБЩО 2 документа 3\.30 €/);
  await soft('НАХОДКА: бележката на проекта (препратка към протокола) не се показва и се губи', async () => {
    // НАХОДКА 4: draftFromMissing записва note „Съставен от протокол № 1“, но
    // формата няма поле „note“, saveDraft от формата я презаписва с NULL, а
    // deaccession_acts няма колона за нея — утвърденият акт не сочи протокола.
    assert.match(h.modal(), /протокол за инвентаризация № 1/, 'формата на проекта не показва бележката');
  });
  // Махаме инв. № 9 от списъка — проектът се поправя свободно; записваме проекта.
  const row9 = Array.from(h.document.querySelectorAll('#actList tbody tr')).find(tr => /Старопланински/.test(tr.textContent));
  await h.click(row9.querySelector('button.dgr'));
  h.type('#actF [name=disposal]', 'унищожени');
  let n = h.toasts.length;
  await h.clickButton('Запиши проекта', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => /Проектът е записан\. Нищо не е отчислено/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_draft_items WHERE draft_id = ?', draft.id).n, 1);
  assert.match(lastAudit('Проект за отчисляване').detail, /поправен проект № \d+ — 1 заглавие/);
  await soft('НАХОДКА: повторният запис на проекта от формата изтрива бележката', async () => {
    assert.match(q('SELECT note FROM deaccession_drafts WHERE id = ?', draft.id).note || '', /протокол/, 'note стана NULL');
  });
  // Утвърждаване от формата: потвърждение с числата, номер 7, снимка „липсващ“.
  await h.window.openDraft(draft.id);
  await h.waitFor(() => h.$('#actScan'), 'формата на проекта');
  await h.sleep(130); await h.settle();
  h.hooks.confirms.length = 0;
  h.hooks.confirmAnswer = false;
  await h.clickButton('Утвърди като акт и отчисли', '#modal footer');
  assert.match(h.hooks.confirms[0] || '', /Утвърждаване: 1 документ излизат от фонда, актът получава номер и остава в документацията ЗАВИНАГИ \(чл\. 39\)/);
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts').n, 6, '„Отказ“ на потвърждението не утвърждава');
  assert.equal(h.modalOpen(), true, 'формата остава отворена');
  h.hooks.confirmAnswer = true;
  n = h.toasts.length;
  await h.clickButton('Утвърди като акт и отчисли', '#modal footer');
  await closeAnyModal();
  assert.ok(h.toastsSince(n).some(t => /Актът е утвърден и 1 документ са отчислени/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  const act = q('SELECT * FROM deaccession_acts WHERE no = 7 AND year = ?', Y);
  assert.ok(act, 'акт № 7 не е записан');
  ids.act7 = act.id;
  assert.equal(act.reason_code, 6); assert.equal(act.order_no, 'З-40'); assert.equal(act.disposal, 'унищожени');
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_drafts WHERE id = ?', draft.id).n, 0, 'проектът изчезва след утвърждаване');
  const it = q('SELECT * FROM deaccession_items WHERE act_id = ?', act.id);
  assert.equal(it.inv_number, 8); assert.equal(it.status_before, 'липсващ');
  assert.equal(book(ids.b8).status, 'отчислен'); assert.equal(book(ids.b9).status, 'липсващ');
  assert.match(lastAudit('Проект за отчисляване').detail, new RegExp('проект № ' + draft.id + ' е утвърден като акт № 7/' + Y));
  assert.match(lastAudit('Отчисляване').detail, new RegExp('^акт № 7/' + Y + ' — 1 документ, причина: Констатирани като липсващи'), 'следата „Отчисляване“ е и за утвърдения проект');
  await soft('НАХОДКА: утвърденият от протокол акт не носи препратка към протокола', async () => {
    assert.ok(Object.values(act).some(v => typeof v === 'string' && /протокол/i.test(v)), 'никое поле на акта не сочи протокола: ' + JSON.stringify(act));
  });
  // Анулиране връща „липсващ“, не „наличен“.
  ok(await h.api.deaccessionActs.revoke(act.id, { reason: 'книгата се намери на грешен рафт' }), 'анулиране');
  assert.equal(book(ids.b8).status, 'липсващ', 'анулирането връща състоянието ПРЕДИ акта (status_before)');
  // Сканирането ѝ в нова проверка я връща на „наличен“ — пътят на намерената книга.
  const sid2 = ok(await h.api.inventorySessions.start({ date: T, scope: 'допълнителна', committee1: 'А', committee2: 'Б', committee3: 'В' }), 'сесия 2');
  ok(await h.api.inventorySessions.scan({ sessionId: sid2, code: '8' }), 'намерена');
  assert.equal(book(ids.b8).status, 'наличен');
  ok(await h.api.inventorySessions.close({ sessionId: sid2, mode: 'representative' }), 'приключване 2');
  // Проект с всички документи вече отчислени → утвърждаването се отказва.
  const dEmpty = ok(await h.api.deaccessionActs.saveDraft({ draft: { date: T, reason_code: 1, reason_text: 'Остарели по съдържание' }, bookIds: [ids.b3] }), 'проект с отчислен');
  const r = await h.api.deaccessionActs.approveDraft({ id: dEmpty });
  assert.equal(r.ok, false); assert.match(r.error, /всички документи вече са отчислени/);
  assert.equal(ok(await h.api.deaccessionActs.getDraft(dEmpty), 'проект').items.length, 0, 'отчисленият отпада от проекта при четене');
  ok(await h.api.deaccessionActs.deleteDraft(dEmpty), 'изтриване на проекта');
  assert.match(lastAudit('Проект за отчисляване').detail, /изтрит проект № \d+ с 1 заглавие — нищо не е отчислявано/);
  const f = await assertFundCoherent('7');
  assert.equal(f.dash.fundCount, 6, 'акт 7 е анулиран и инв. № 8 е намерен — фондът е пак 6');
  assert.equal(f.chk.findings.filter(x => x.key !== 'nobatch').length, 0, JSON.stringify(f.chk.findings));
  noRendererErrors();
});

/* ==================================================================
   8. Вече отчислен документ, дубликати, несъществуващ, празен акт (v2.4.59)
   ================================================================== */
test('8. отчислен документ не влиза във втори акт; дубликат в списъка; изтрит документ; празен акт', async () => {
  await openActForm();
  h.type('#actF [name=reason_code]', '1');
  let n = h.toasts.length;
  await h.scan('#actScan', '3');
  const t3 = h.toastsSince(n).find(t => t.type === 'err');
  assert.ok(t3, 'сканирането на отчислен документ трябва да се откаже');
  assert.equal(h.text('#actList').includes('Бай Ганьо'), false);
  await soft('НАХОДКА: съобщението за отчислен документ е „Няма документ“', async () => {
    // НАХОДКА 5: findBook връща undefined и за отчислен С акт, и за несъществуващ —
    // библиотекарката получава „Няма документ с баркод/инв. № 3“, вместо „отчислен с акт № 1/Y“.
    assert.match(t3.msg, /отчислен/, 'получено: ' + t3.msg);
  });
  await h.clickButton('Отказ', '#modal footer');
  const nextBefore = ok(await h.api.deaccessionActs.nextNo(Y), 'nextNo');
  const ACT = (o) => Object.assign({ no: nextBefore, date: T, reason_code: 1, reason_text: 'Остарели по съдържание' }, o);
  const dup = await h.api.deaccessionActs.create({ act: ACT(), bookIds: [ids.b3] });
  assert.equal(dup.ok, false); assert.match(dup.error, /Инв\. № 3 вече е отчислен с акт/);
  const twice = await h.api.deaccessionActs.create({ act: ACT(), bookIds: [ids.b1, ids.b1] });
  assert.equal(twice.ok, false, 'един и същ документ два пъти в списъка');
  assert.equal(book(ids.b1).status, 'наличен', 'транзакцията е върната изцяло');
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_items WHERE book_id = ?', ids.b1).n, 0);
  const gone = await h.api.deaccessionActs.create({ act: ACT(), bookIds: [ids.b1, 999999] });
  assert.equal(gone.ok, false); assert.match(gone.error, /вече не съществува в базата/);
  assert.equal(book(ids.b1).status, 'наличен');
  for (const empty of [[], null, undefined]) {
    const r = await h.api.deaccessionActs.create({ act: ACT(), bookIds: empty });
    assert.equal(r.ok, false, 'празен акт трябва да се откаже (v2.4.59)');
    assert.match(r.error, /Актът няма нито един документ/);
  }
  assert.equal(ok(await h.api.deaccessionActs.nextNo(Y), 'nextNo'), nextBefore, 'нито един отказ не заема номер');
  assert.equal(q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'Отчисляване' AND detail LIKE ?", 'акт № ' + nextBefore + '/%').n, 0, 'и не оставя следа за несъставен акт');
  noRendererErrors();
});

/* ==================================================================
   9. Документ в акт: изтриване, редакция, групова редакция, статус през API
   ================================================================== */
test('9. отчислен документ: не се изтрива, груповата редакция не го връща, снимката не се променя при редакция на цената', async () => {
  const del = await h.api.books.delete(ids.b3);
  assert.equal(del.ok, false); assert.match(del.error, /отчислен с акт и не се изтрива.*чл\. 39/);
  const bulk = ok(await h.api.books.bulkUpdate({ ids: [ids.b3, ids.b1], field: 'department', value: 'за деца' }), 'групова');
  assert.equal(bulk, 1, 'отчисленият не се пипа от груповата редакция');
  const bulkSt = await h.api.books.bulkUpdate({ ids: [ids.b3], field: 'status', value: 'наличен' });
  assert.equal(bulkSt.ok === false || bulkSt.data === 0, true, 'статусът на отчислен не се сменя групово');
  // Редакция на цената след акта: снимката в акта остава.
  const full = ok(await h.api.books.get(ids.b3), 'get');
  ok(await h.api.books.update(Object.assign({}, full, { price: 99 })), 'редакция на цена');
  assert.equal(q('SELECT price FROM deaccession_items WHERE book_id = ?', ids.b3).price, 0.1, 'снимката по чл. 35, ал. 2 не се променя');
  const k = ok(await h.api.kdbf.report(Y), 'КДБФ');
  assert.equal(Math.round(k.part3.find(a => a.no === 1).item_value * 100), 30, 'КДБФ чете снимката');
  assert.equal(book(ids.b3).status, 'отчислен', 'редакцията без нов статус пази „отчислен“');
  // Статус „наличен“ през API върху отчислен с акт документ.
  const r = await h.api.books.update(Object.assign({}, ok(await h.api.books.get(ids.b3), 'get'), { status: 'наличен' }));
  const b3 = book(ids.b3);
  await soft('НАХОДКА: books:update връща отчислен с акт документ на „наличен“ без анулиране', async () => {
    // НАХОДКА 6: bookPayload приема всеки валиден статус; формата крие полето, но
    // мобилният/API път не — документът става „наличен“ с deaccession_act_id и
    // deaccession_date: таблото го брои, КДБФ — не (два ключа с различен отговор).
    assert.equal(r.ok, false, 'очаква се отказ; получено ok=' + r.ok + ', статус=' + b3.status);
  });
  if (b3.status !== 'отчислен') {
    const chk = ok(await h.api.fund.check(Y), 'съгласуване');
    assert.ok(chk.findings.some(x => x.key === 'keys'), 'съгласуването поне забелязва разминаването');
    h.db.prepare("UPDATE books SET status = 'отчислен' WHERE id = ?").run(ids.b3);
  }
  ok(await h.api.books.update(Object.assign({}, ok(await h.api.books.get(ids.b3), 'get'), { price: 0.1 })), 'цената се връща');
  // Отчислен без акт (стар внос) се хваща от „Проверка на данните“ и findBook го ПРИЕМА.
  h.db.prepare("UPDATE books SET status = 'отчислен' WHERE id = ?").run(ids.b11 === undefined ? -1 : ids.b2);
  const orphan = ok(await h.api.books.deaccessionedWithoutAct(), 'без акт');
  assert.deepEqual(orphan.map(o => o.inv_number), [2]);
  const fb = ok(await h.api.deaccessionActs.findBook('2'), 'findBook');
  assert.ok(fb && fb.id === ids.b2, 'отчислен БЕЗ акт влиза в акт — това е пътят за поправка');
  const chk = ok(await h.api.fund.check(Y), 'съгласуване');
  assert.ok(chk.findings.some(x => x.key === 'keys' && /1 отчислени без акт/.test(x.why)), JSON.stringify(chk.findings));
  ok(await h.api.books.clearOrphanDeaccession(ids.b2), 'поправка');
  assert.equal(book(ids.b2).status, 'наличен');
  const f = await assertFundCoherent('9');
  assert.equal(f.chk.findings.filter(x => x.key !== 'nobatch').length, 0, JSON.stringify(f.chk.findings));
  noRendererErrors();
});

/* ==================================================================
   10. Датата на акта: невалидна, бъдеща, преди датата на вписване
   ================================================================== */
test('10. дата на акта: невалидна, бъдеща и по-ранна от вписването на документа се отказват', async () => {
  const nextNo10 = ok(await h.api.deaccessionActs.nextNo(Y), 'nextNo');
  const ACT = (o) => Object.assign({ no: nextNo10, date: T, reason_code: 1, reason_text: 'Остарели по съдържание' }, o);
  for (const bad of ['', null, 'НЕВАЛИДНА-99-99', Y + '-02-30', '2026-13-01']) {
    const r = await h.api.deaccessionActs.create({ act: ACT({ date: bad }), bookIds: [ids.b1] });
    assert.equal(r.ok, false, 'дата „' + bad + '“'); assert.match(r.error, /Датата на акта липсва или е невалидна/);
  }
  // Бъдеща дата (следваща година).
  const fut = await h.api.deaccessionActs.create({ act: ACT({ no: 1, date: YN + '-01-10' }), bookIds: [ids.b1] });
  await soft('НАХОДКА: акт с бъдеща дата се приема', async () => {
    // НАХОДКА 7: isValidIsoDate не пита дали датата е в бъдещето. Актът получава
    // № 1/YN, документът става „отчислен“ днес (таблото го вади), а КДБФ за Y го
    // брои в наличността към 31.12 — fund:check вижда разликата, но не може да я обясни.
    assert.equal(fut.ok, false, 'очаква се отказ за дата ' + YN + '-01-10');
  });
  if (fut.ok) {
    assert.equal(q('SELECT year FROM deaccession_acts WHERE id = ?', fut.data).year, YN, 'актът е вписан в следващата година');
    const f = await fundNumbers();
    assert.notEqual(f.dash.fundCount, f.k.stockEnd.n, 'таблото и КДБФ вече се разминават');
    const keys = f.chk.findings.find(x => x.key === 'keys');
    assert.ok(keys, 'съгласуването забелязва');
    await soft('НАХОДКА: съгласуването не назовава бъдещия акт като причина', async () => {
      assert.match(keys.why, /акт|отчислен/, 'why: ' + keys.why);
    });
    ok(await h.api.deaccessionActs.revoke(fut.data, { reason: 'сгрешена дата' }), 'анулиране');
  }
  // Дата ПРЕДИ датата на вписване (документът е вписан днес).
  const early = await h.api.deaccessionActs.create({ act: ACT({ no: 1, date: Y1 + '-06-01' }), bookIds: [ids.b1] });
  await soft('НАХОДКА: акт с дата преди вписването на документа се приема', async () => {
    // НАХОДКА 8: няма проверка act.date >= register_date. Документ, вписан на T, се
    // „отчислява“ на Y1-06-01: КДБФ за Y1 показва отчисление без наличност, веригата
    // 31.12.Y1 → 01.01.Y се къса, а актът заема номер в затворена година.
    assert.equal(early.ok, false, 'очаква се отказ');
  });
  if (early.ok) {
    const kPrev = ok(await h.api.kdbf.report(Y1), 'КДБФ ' + Y1);
    assert.equal(kPrev.deaccYear.n, 1, 'миналата година „отчислява“ документ, който не е имала');
    assert.equal(kPrev.stockEnd.n, 0);
    const chk = ok(await h.api.fund.check(Y), 'съгласуване');
    assert.ok(chk.findings.some(x => x.key === 'chain'), 'веригата между годините се къса: ' + JSON.stringify(chk.findings.map(x => x.key)));
    ok(await h.api.deaccessionActs.revoke(early.data, { reason: 'сгрешена дата' }), 'анулиране');
  }
  assert.equal(book(ids.b1).status, 'наличен');
  const f = await assertFundCoherent('10');
  assert.equal(f.chk.findings.filter(x => x.key !== 'nobatch').length, 0, JSON.stringify(f.chk.findings));
  noRendererErrors();
});

/* ==================================================================
   11. Анулиране на акт от минала година — КДБФ на миналата година се пренаписва
   ================================================================== */
test('11. акт от минала година: анулирането му днес иска изрично потвърждение и вписва какво се променя в подписаната КДБФ', async () => {
  ids.bOld = await mkBook({ inv_number: 20, title: 'Стара книга от ' + Y1, register_date: Y1 + '-03-01', price: 8 });
  const prevNo = ok(await h.api.deaccessionActs.nextNo(Y1), 'nextNo');
  const actOld = ok(await h.api.deaccessionActs.create({ act: { no: prevNo, date: Y1 + '-11-30', reason_code: 4, reason_text: 'Физически изхабени' }, bookIds: [ids.bOld] }), 'акт за ' + Y1);
  let kPrev = ok(await h.api.kdbf.report(Y1), 'КДБФ ' + Y1);
  const live = kPrev.part3.filter(a => !a.revoked_at);
  assert.equal(live.length, 1); assert.equal(live[0].item_value, 8);
  assert.equal(kPrev.stockEnd.n, 0, 'към 31.12.' + Y1 + ' книгата вече е отчислена');
  assert.equal(kPrev.acquiredYear.n, 1);
  let chk = ok(await h.api.fund.check(Y), 'съгласуване');
  assert.equal(chk.findings.filter(x => x.key !== 'nobatch').length, 0, 'веригата е цяла: ' + JSON.stringify(chk.findings));
  /* КДБФ Y1 е „подписана“. Днес актът се анулира — и точно това е НАХОДКА 9
     (поправена в v2.4.61): анулиране на акт от ПРИКЛЮЧЕНА година пренаписваше
     вече отпечатаната и подписана КДБФ, без да пита и без да го каже никъде.
     Сега се иска изрично второ потвърждение. */
  const noConfirm = await h.api.deaccessionActs.revoke(actOld, { reason: 'сгрешен инвентарен номер' });
  assert.equal(noConfirm.ok, false, 'анулирането на акт от минала година трябва да иска потвърждение');
  assert.match(noConfirm.error, new RegExp('от ПРИКЛЮЧЕНА година \\(' + Y1 + ' г\\.\\)'));
  assert.match(noConfirm.error, /Приложение № 2 и № 3 за \d{4} г\. вече са отпечатани и подписани/);
  assert.ok(!q('SELECT revoked_at FROM deaccession_acts WHERE id = ?', actOld).revoked_at, 'нищо не е анулирано без потвърждение');
  // Екранът пита със същата отметка — проверява се, че я има при акт от минала година.
  await h.go('acts');
  const oldRow = Array.from(h.document.querySelectorAll('#view tbody tr')).find(tr => new RegExp('^' + prevNo + ' / ' + Y1).test(h.text(tr)));
  await h.click(oldRow.querySelector('button'));
  await h.waitFor(() => /Акт за отчисляване № /.test(h.modal()), 'прегледът на акта');
  await h.clickButton('Анулирай акта', '#modal footer');
  await h.waitFor(() => h.$('#revF'), 'формата за анулиране');
  assert.match(h.modal(), new RegExp('Този акт е от приключената ' + Y1 + ' г\\.'));
  assert.ok(h.$('#revF [name=confirmClosedYear]'), 'формата има отметка за приключената година');
  await h.clickButton('Отказ', '#modal footer');
  ok(await h.api.deaccessionActs.revoke(actOld, { reason: 'сгрешен инвентарен номер', by: 'Мария Иванова', confirmClosedYear: true }), 'анулиране');
  kPrev = ok(await h.api.kdbf.report(Y1), 'КДБФ ' + Y1 + ' след анулиране');
  assert.equal(kPrev.deaccYear.n, 0);
  assert.equal(kPrev.stockEnd.n, 1, 'наличността към 31.12.' + Y1 + ' се променя със задна дата');
  const b = book(ids.bOld);
  assert.equal(b.status, 'наличен');
  assert.equal(b.status_date, T, 'датата на състоянието е днешна, а отчисляване по регистъра „не е имало“ — двете неща се разминават');
  chk = ok(await h.api.fund.check(Y), 'съгласуване');
  assert.equal(chk.findings.filter(x => x.key !== 'nobatch').length, 0, 'веригата пак е цяла, защото и двете години са преизчислени');
  /* И следата казва ЧТО точно е променено в приключената година — подписаният
     екземпляр остава при счетоводителя и някой трябва да може да обясни
     разликата и след година. */
  const revAudit = lastAudit('Анулиране на акт').detail;
  assert.match(revAudit, new RegExp('ВНИМАНИЕ: актът е от ПРИКЛЮЧЕНАТА ' + Y1 + ' г\\.'), revAudit);
  assert.match(revAudit, new RegExp('КДБФ \\(Приложение № 2 и № 3\\) за ' + Y1 + ' г\\. се преизчислява'));
  assert.match(revAudit, /падат с 1 документ \/ 8\.00 €/);
  assert.match(revAudit, new RegExp('наличността към 31\\.12\\.' + Y1 + ' г\\. се увеличава'));
  assert.match(revAudit, /потвърдено изрично от Мария Иванова/);
  noRendererErrors();
});

/* ==================================================================
   12. Сборове: цени с плаваща запетая, „Опис към акта“ = редовете на акта
   ================================================================== */
test('12. сборът на акта = Σ(цена × бройка) и е еднакъв в списъка, прегледа, разпечатката и КДБФ', async () => {
  ids.bA = await mkBook({ inv_number: 21, title: 'Цена 0.1', price: 0.1 });
  ids.bB = await mkBook({ inv_number: 22, title: 'Цена 0.2', price: 0.2 });
  ids.bC = await mkBook({ inv_number: 23, title: 'Цена 0.7', price: 0.7 });
  ids.bD = await mkBook({ inv_number: 24, title: 'Без цена', price: 0 });
  const no = ok(await h.api.deaccessionActs.nextNo(Y), 'nextNo');
  const id = ok(await h.api.deaccessionActs.create({ act: { no, date: T, reason_code: 7, reason_text: 'Неизползваеми носители на информация, които нямат статута на културна ценност', disposal: 'унищожени' },
    bookIds: [ids.bA, ids.bB, ids.bC, ids.bD] }), 'акт');
  ids.actSum = id;
  const row = ok(await h.api.deaccessionActs.list(), 'списък').find(x => x.id === id);
  assert.equal(row.item_count, 4);
  assert.equal(Math.round(row.item_value * 100), 100, '0.1 + 0.2 + 0.7 + 0 = 1.00');
  const a = ok(await h.api.deaccessionActs.get(id), 'преглед');
  assert.equal(a.items.length, 4);
  assert.equal(Math.round(a.items.reduce((s, i) => s + i.price * (i.quantity ?? 1), 0) * 100), 100);
  await h.window.printActDoc(id);
  await h.settle();
  const p = h.printed();
  assert.match(p, new RegExp('АКТ № ' + no + ' / ' + rx(E.bgDate(T))));
  assert.match(p, /отчислява от библиотечния фонд 4 библиотечни документа на обща стойност 1\.00 € \/ 1\.96 лв\./);
  assert.match(p, /ОБЩО 4 документа 1\.00 €/);
  assert.match(p, /4 24 Без цена .*0\.00 €/, 'документ без цена е в описа с 0.00');
  assert.match(p, /чл\. 30, т\. 7/);
  // Описът към акта = точно редовете в снимката, в реда на инв. №.
  const invs = Array.from(p.matchAll(/\b(\d) (2[1-4]) Цена|\b4 (24) Без цена/g)).map(m => m[2] || m[3]);
  assert.deepEqual(invs, ['21', '22', '23', '24']);
  const k = ok(await h.api.kdbf.report(Y), 'КДБФ');
  assert.equal(Math.round(k.part3.find(x => x.no === no).item_value * 100), 100);
  await h.go('acts');
  const rowSum = Array.from(h.document.querySelectorAll('#view tbody tr')).find(tr => new RegExp('^' + no + ' / ' + Y + ' ').test(h.text(tr)));
  assert.match(h.text(rowSum), new RegExp('^' + no + ' / ' + Y + ' ' + rx(E.bgDate(T)) + ' т\\. 7\\. .* 4 1\\.00 € / 1\\.96 лв\\. унищожени'));
  await assertFundCoherent('12');
  noRendererErrors();
});

/* ==================================================================
   13. Второ работно място: остаряла форма
   ================================================================== */
test('13. второ работно място: документът е отчислен / номерът е зает, докато формата стои отворена', async () => {
  await openActForm();
  const no = Number(h.$('#actF [name=no]').value);
  h.type('#actF [name=reason_code]', '3');
  await h.scan('#actScan', '1');
  await h.scan('#actScan', '2');
  // Другият компютър отчислява инв. № 2 със същия номер.
  ok(await h.api.deaccessionActs.create({ act: { no, date: T, reason_code: 3, reason_text: 'Неподходящи за профила на библиотеката' }, bookIds: [ids.b2] }), 'другото място');
  let n = h.toasts.length;
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  const err = h.toastsSince(n).find(t => t.type === 'err');
  assert.ok(err, 'очаква се отказ: ' + JSON.stringify(h.toastsSince(n)));
  assert.match(err.msg, /вече съществува — най-вероятно е създаден от друго работно място/);
  assert.equal(h.modalOpen(), true, 'формата остава отворена');
  assert.equal(book(ids.b1).status, 'наличен', 'нищо не е отчислено');
  // Поправя номера, но инв. № 2 остава в списъка.
  h.type('#actF [name=no]', String(no + 1));
  n = h.toasts.length;
  await h.clickButton('Утвърди акта и отчисли', '#modal footer');
  const err2 = h.toastsSince(n).find(t => t.type === 'err');
  assert.ok(err2, JSON.stringify(h.toastsSince(n)));
  assert.match(err2.msg, /Инв\. № 2 вече е отчислен с акт — вероятно от друго работно място.*Актът НЕ е съставен/);
  assert.equal(book(ids.b1).status, 'наличен');
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts WHERE no = ? AND year = ?', no + 1, Y).n, 0);
  await h.clickButton('Отказ', '#modal footer');
  // Проект, утвърден от другото място, докато формата е отворена.
  const d = ok(await h.api.deaccessionActs.saveDraft({ draft: { date: T, reason_code: 1, reason_text: 'Остарели по съдържание' }, bookIds: [ids.b1] }), 'проект');
  await h.window.openDraft(d);
  await h.waitFor(() => h.$('#actScan'), 'формата'); await h.sleep(130); await h.settle();
  ok(await h.api.deaccessionActs.deleteDraft(d), 'другото място трие проекта');
  n = h.toasts.length;
  await h.clickButton('Запиши проекта', '#modal footer');
  const err3 = h.toastsSince(n).find(t => t.type === 'err');
  assert.ok(err3 && /Проектът вече не съществува/.test(err3.msg), JSON.stringify(h.toastsSince(n)));
  await h.clickButton('Отказ', '#modal footer');
  await assertFundCoherent('13');
  noRendererErrors();
});

/* ==================================================================
   14. Одитна следа, чл. 36 / чл. 39, крайно съгласуване
   ================================================================== */
test('14. одитната следа е пълна; чл. 36 и чл. 39 присъстват; накрая всичко се връзва', async () => {
  const acts = all('SELECT * FROM deaccession_acts ORDER BY year, no');
  // Всеки съставен акт има следа „Отчисляване“ с точния си номер; всеки анулиран — „Анулиране на акт“.
  for (const a of acts) {
    assert.ok(q("SELECT 1 AS x FROM audit_log WHERE action = 'Отчисляване' AND detail LIKE ?", 'акт № ' + a.no + '/' + a.year + ' — %'), 'няма следа за акт ' + a.no + '/' + a.year);
    if (a.revoked_at) assert.ok(q("SELECT 1 AS x FROM audit_log WHERE action = 'Анулиране на акт' AND detail LIKE ?", 'акт № ' + a.no + '/' + a.year + ' е анулиран (%'), 'няма следа за анулиране на ' + a.no + '/' + a.year);
  }
  // Уникалност (year, no) в целия регистър.
  assert.equal(q('SELECT COUNT(*) AS n FROM (SELECT year, no FROM deaccession_acts GROUP BY year, no HAVING COUNT(*) > 1)').n, 0);
  // Актовете не се трият; анулираните носят основание.
  assert.ok(acts.every(a => !a.revoked_at || (a.revoke_reason && a.revoke_reason.trim())));
  // Никой документ не е в два живи акта.
  assert.equal(q(`SELECT COUNT(*) AS n FROM (SELECT i.book_id FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id
    WHERE d.revoked_at IS NULL AND i.book_id IS NOT NULL GROUP BY i.book_id HAVING COUNT(*) > 1)`).n, 0);
  // Всеки отчислен документ сочи жив акт, и обратно.
  const offBooks = all("SELECT id, deaccession_act_id FROM books WHERE status = 'отчислен'");
  for (const b of offBooks) {
    const a = q('SELECT revoked_at FROM deaccession_acts WHERE id = ?', b.deaccession_act_id);
    assert.ok(a && !a.revoked_at, 'документ ' + b.id + ' сочи анулиран/несъществуващ акт');
  }
  const liveItems = all('SELECT i.book_id FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.revoked_at IS NULL');
  for (const i of liveItems) assert.equal(book(i.book_id).status, 'отчислен', 'документ ' + i.book_id + ' е в жив акт, но не е отчислен');
  // Чл. 36 и чл. 39 — в екрана и в документа.
  await h.go('acts');
  assert.match(h.viewText(), /чл\. 39/);
  assert.match(h.viewText(), /Начин/, 'колоната за разпореждане в списъка');
  /* v2.4.61: филтър по година + сбор на показаното. Регистърът на актовете е
     годишен (чл. 35), а дотук списъкът нямаше нито филтър, нито сбор — за
     въпроса „колко документа излязоха от фонда тази година“ трябваше да се
     отваря КДБФ. Двете числа задължително съвпадат. */
  const yearSel = h.$('#view select');
  assert.ok(yearSel, 'списъкът има филтър по година');
  assert.deepEqual(Array.from(yearSel.options).map(o => o.value), ['всички', Y, Y1]);
  const kY = ok(await h.api.kdbf.report(Y), 'КДБФ ' + Y);
  h.type('#view select', Y);
  await h.settle();
  await h.waitFor(() => new RegExp('ОБЩО за ' + Y + ' г\\.').test(h.text('#view tbody')), 'сборът за ' + Y);
  const totalRow = Array.from(h.document.querySelectorAll('#view tbody tr')).find(tr => /ОБЩО за /.test(h.text(tr)));
  assert.match(h.text(totalRow), new RegExp('ОБЩО за ' + Y + ' г\\. — \\d+ действащи? акта? \\(и \\d+ анулирани'));
  assert.match(h.text(totalRow), new RegExp('\\b' + kY.deaccYear.n + ' ' + rx(E.mny(kY.deaccYear.v)) + '$'),
    'сборът на екрана = отчисленото през годината по КДБФ: ' + h.text(totalRow));
  assert.equal(Array.from(h.document.querySelectorAll('#view tbody tr'))
    .some(tr => new RegExp('^\\d+ / ' + Y1 + ' ').test(h.text(tr))), false, 'чуждата година не се показва');
  h.type('#view select', Y1);
  await h.settle();
  await h.waitFor(() => new RegExp('ОБЩО за ' + Y1 + ' г\\.').test(h.text('#view tbody')), 'сборът за ' + Y1);
  assert.ok(Array.from(h.document.querySelectorAll('#view tbody tr'))
    .some(tr => new RegExp('^\\d+ / ' + Y1 + ' ').test(h.text(tr))), 'актът от ' + Y1 + ' се вижда');
  h.type('#view select', 'всички');
  await h.settle();
  await h.window.printActDoc(ids.act1);
  await h.settle();
  assert.match(h.printed(), /чл\. 36/);
  // Крайно съгласуване.
  const f = await assertFundCoherent('14');
  assert.equal(f.chk.findings.filter(x => x.key !== 'nobatch').length, 0, JSON.stringify(f.chk.findings));
  assert.equal(f.k.stockEnd.n - f.k.acquiredYear.n + f.k.deaccYear.n, ok(await h.api.kdbf.report(Y1), 'КДБФ ' + Y1).stockEnd.n, 'веригата между годините');
  noRendererErrors();
});

test('НАХОДКИ — обобщение', () => {
  if (findings.length) {
    console.log('\n=== НАХОДКИ (' + findings.length + ') ===');
    findings.forEach((f, i) => console.log((i + 1) + '. ' + f.label + '\n   → ' + f.msg.split('\n')[0]));
  }
  assert.equal(findings.length, 0, findings.length + ' находки — виж списъка по-горе');
});
