'use strict';
/* СЦЕНАРИЙ (кръг 37, v2.4.61): ПЕРИОДИЧНИ ИЗДАНИЯ — ВЕСТНИЦИ И СПИСАНИЯ,
 * както ги води библиотекарката: картотека (кардекс) на заглавията, постъпили
 * броеве, закъснели/липсващи броеве на таблото, инвентиране на годишния
 * комплект във фонда (инв. №, партида в КДБФ Част № 1, инвентарна книга),
 * заемане на подвързан комплект и редът „Периодични издания“ в Дневника,
 * отчисляване на комплекта с акт, онлайн каталог, годишен отчет, разпечатки,
 * и ежедневник с 300+ броя в кардекса.
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
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'));
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
/* Редът на заглавие в списъка „Периодика“. */
function rowOf(title) {
  return Array.from(h.document.querySelectorAll('#view table.ledger tbody tr'))
    .find(tr => tr.firstElementChild && tr.firstElementChild.textContent.trim() === title);
}
/* Отваря картона (кардекса) на заглавие през бутона „Отвори“ на реда му. */
async function openTitle(title) {
  await h.go('periodika');
  const tr = rowOf(title);
  assert.ok(tr, 'няма ред за „' + title + '“ в списъка');
  await h.clickButton('Отвори', tr);
  await h.waitFor(() => h.$('#issueF'), 'кардексът на ' + title);
  await h.settle();
}
/* Вписва брой през формата в кардекса; връща известията след натискането. */
async function addIssueViaForm(issueNo, date, price) {
  h.type('#issueF [name=issue_no]', issueNo);
  if (date != null) h.type('#issueF [name=date]', date);
  if (price != null) h.type('#issueF [name=price]', price);
  const n = h.toasts.length;
  await h.clickButton('Добави брой', '#modal');
  await h.settle();
  return h.toastsSince(n);
}
/* Редът на брой в таблицата на кардекса (по номер на броя). */
function issueRow(issueNo) {
  return Array.from(h.document.querySelectorAll('#modal table.ledger tbody tr'))
    .find(tr => tr.firstElementChild && tr.firstElementChild.textContent.trim() === String(issueNo) && tr.querySelector('button.dgr'));
}
/* Редът на година в раздела „Годишни комплекти (фонд)“ на кардекса. */
function volumeRow(year) {
  return Array.from(h.document.querySelectorAll('#modal fieldset table.ledger tbody tr'))
    .find(tr => tr.firstElementChild && tr.firstElementChild.textContent.trim() === String(year) && !tr.querySelector('button.dgr'));
}
/* Гише: читател по карта, документ по инв. №/баркод. */
async function selectReaderAtDesk(card) {
  await h.go('circ');
  if (!h.button('Заемане', '#view').classList.contains('pri')) await h.clickButton('Заемане', '#view');
  if (h.$('#circCount')) await h.clickButton('Смени', '#view');
  await h.waitFor(() => h.$('#pScan'), 'полето за читател');
  await h.scan('#pScan', card);
  await h.waitFor(() => h.$('#bScan'), 'полето за сканиране на документ');
}
const ACT = (o) => Object.assign({
  no: 1, date: T, reason_code: 3, reason_text: 'физически изхабени',
  disposal: 'предадени за вторични суровини', committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
}, o);

/* ==================================================================
   0. Настройки — библиотека, комисия
   ================================================================== */
test('0. подготовка: настройки, комисия, служител', async () => {
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  const st = ok(await h.api.settings.get(), 'настройки');
  ok(await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека „Изпитание“', place: 'с. Яворец',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова',
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка',
    loan_days: 14
  })), 'запис на настройките');
  await h.window.loadSettingsCache();
  assert.equal(q('SELECT next_inv_number FROM settings').next_inv_number, 1, 'прясната база започва от инв. № 1');
  assert.equal(q('SELECT COUNT(*) AS n FROM books').n, 0, 'фондът е празен');
  assert.ok(q("SELECT 1 FROM categories WHERE name = 'продължаващо издание'"), 'началната категория за периодика съществува');
  noRendererErrors();
});

/* ==================================================================
   1. Празна картотека → ново заглавие през формата (вестник и списание)
   ================================================================== */
test('1. „+ Ново периодично издание“: празна картотека, отказ без заглавие, вестник и списание', async () => {
  await h.go('periodika');
  assert.match(h.viewText(), /Няма заведени периодични издания/);
  await h.clickButton('+ Ново периодично издание', '#view');
  await h.waitFor(() => h.$('#perF'), 'формата за издание');
  assert.equal(h.$('#perF [name=freq]').value, 'месечно', 'периодичност по подразбиране');
  assert.equal(h.$('#perF [name=department]').value, 'периодика', 'отдел по подразбиране');
  const freqOpts = Array.from(h.$('#perF [name=freq]').options).map(o => o.value);
  await soft('НАХОДКА 1: няма периодичност за ЕЖЕДНЕВНИК', async () => {
    // Вестниците „Труд“, „24 часа“, „Телеграф“ — най-честата периодика в
    // читалище — излизат всеки ден. PER_FREQ (core.js) / FREQ_INTERVAL
    // (handlers/periodicals.js) / enum-тригерът предлагат само от „седмично“
    // нагоре: ежедневник трябва да се води „нередовно“ (без предвиждане, тоест
    // таблото никога не казва, че липсва брой) или „седмично“ (предвиждането е
    // грешно с 6 дни). Очаква се стойност „ежедневно“/„дневно“ с interval 1 ден.
    assert.ok(freqOpts.some(v => /дневно|ежедневно/.test(v)), 'периодичностите са: ' + freqOpts.join(', '));
  });

  // Без заглавие → отказ на самата форма, прозорецът остава.
  let n = h.toasts.length;
  await h.clickButton('Запиши', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /Заглавието е задължително/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.equal(h.modalOpen(), true);

  // Вестник „Труд“ — ежедневник; библиотекарката е принудена да избере „седмично“.
  h.type('#perF [name=title]', 'Труд');
  h.type('#perF [name=freq]', 'седмично');
  h.type('#perF [name=publisher]', '„Труд“ АД');
  h.type('#perF [name=issn]', '1313-7719');
  n = h.toasts.length;
  await h.clickButton('Запиши', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Записано.' && t.type === 'ok'), JSON.stringify(h.toastsSince(n)));
  assert.equal(h.modalOpen(), false);
  const trud = q("SELECT * FROM periodicals WHERE title = 'Труд'");
  assert.ok(trud, 'вестникът не е в базата');
  ids.trud = trud.id;
  assert.equal(trud.freq, 'седмично');
  assert.equal(trud.department, 'периодика');
  assert.equal(trud.issn, '1313-7719');
  assert.equal(lastAudit('Ново периодично издание').detail, 'Труд');
  assert.match(h.text(rowOf('Труд')), /Труд седмично „Труд“ АД 1313-7719 периодика 0 — —/, 'редът: 0 броя, без комплекти, без прогноза');

  // Списание „Читалище“ — месечно.
  await h.clickButton('+ Ново периодично издание', '#view');
  await h.waitFor(() => h.$('#perF'), 'формата');
  h.type('#perF [name=title]', 'Читалище');
  h.type('#perF [name=publisher]', 'Съюз на народните читалища');
  h.type('#perF [name=issn]', '0324-0975');
  h.type('#perF [name=note]', 'абонамент чрез „Български пощи“');
  await h.clickButton('Запиши', '#modal footer');
  ids.chit = q("SELECT id FROM periodicals WHERE title = 'Читалище'").id;
  assert.equal(q('SELECT freq FROM periodicals WHERE id = ?', ids.chit).freq, 'месечно');

  // „Наука“ — тримесечно, през API (второто работно място).
  ids.nauka = ok(await h.api.periodicals.create({ title: 'Наука', freq: 'тримесечно', publisher: 'СУБ', department: 'справочен' }), 'Наука');
  await h.go('periodika');
  assert.equal(h.document.querySelectorAll('#view table.ledger tbody tr').length, 3);
  // Подредба по заглавие: Наука, Труд, Читалище.
  const titles = Array.from(h.document.querySelectorAll('#view table.ledger tbody tr')).map(tr => tr.firstElementChild.textContent.trim());
  assert.deepEqual(titles, ['Наука', 'Труд', 'Читалище']);
  noRendererErrors();
});

/* ==================================================================
   2. Дубликати и валидиране на картона: същото заглавие, ISSN, празна периодичност
   ================================================================== */
test('2. картон — дублирано заглавие, ISSN в грешен формат, „нередовно“ и празна периодичност', async () => {
  const dup = await h.api.periodicals.create({ title: 'Труд', freq: 'седмично' });
  await soft('НАХОДКА 2: второ издание „Труд“ се завежда без дума', async () => {
    // periodicals:create не проверява за съществуващо заглавие (нито ISSN).
    // При две работни места (или второ натискане на „Запиши“) картотеката
    // получава два еднакви картона и броевете се разпръсват между тях; в
    // Дневника/аналитиката източникът вече не се различава по нищо.
    assert.equal(dup.ok, false, 'очаква се отказ/предупреждение за повторно заглавие „Труд“');
  });
  if (dup.ok) ok(await h.api.periodicals.delete(dup.data), 'чистене на дубликата');
  const badIssn = await h.api.periodicals.create({ title: 'Грешен ISSN', freq: 'месечно', issn: '12345' });
  await soft('НАХОДКА 3: ISSN „12345“ се приема', async () => {
    // ISSN е 8 знака NNNN-NNNC с контролна цифра (ISO 3297); полето се
    // записва каквото е — както ISBN при книгите поне се търси по формат.
    assert.equal(badIssn.ok, false, 'ISSN „12345“ трябва да бъде отказан');
  });
  if (badIssn.ok) ok(await h.api.periodicals.delete(badIssn.data), 'чистене');
  const badFreq = await h.api.periodicals.create({ title: 'Странна периодичност', freq: 'всеки ден' });
  assert.equal(badFreq.ok, false, 'непозната периодичност се отказва от номенклатурата');
  assert.match(badFreq.error, /periodicals\.freq|Непозната стойност/);
  // Празна периодичност (NULL) — приема се и се редактира (одит v2.4.29).
  const nof = ok(await h.api.periodicals.create({ title: 'Без периодичност', freq: '' }), 'без периодичност');
  assert.equal(q('SELECT freq FROM periodicals WHERE id = ?', nof).freq, null);
  ok(await h.api.periodicals.update({ id: nof, title: 'Без периодичност (поправено)', freq: '' }), 'редакция при NULL freq');
  ok(await h.api.periodicals.delete(nof), 'изтриване');
  assert.match(lastAudit('Изтрито периодично издание').detail, /„Без периодичност \(поправено\)“ — без вписани броеве/);
  // Редакция на изтрито издание (стар прозорец на второ работно място).
  const stale = await h.api.periodicals.update({ id: nof, title: 'Призрак', freq: 'месечно' });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /изтрито от друго работно място/);
  noRendererErrors();
});

/* ==================================================================
   3. Кардексът на „Читалище“: вписване на броеве през формата, валидиране, дубликат, изтриване
   ================================================================== */
test('3. кардекс — вписване на броеве, невалидна дата/цена, дублиран брой, изтриване с потвърждение', async () => {
  await openTitle('Читалище');
  assert.match(h.modal(), /Читалище/);
  assert.match(h.modal(), /месечно · Съюз на народните читалища · ISSN 0324-0975/);
  assert.match(h.modal(), /Все още няма вписани броеве/);
  assert.match(h.modal(), /Годините се появяват тук, щом бъде вписан първият брой/);
  assert.equal(h.$('#issueF [name=date]').value, T, 'датата на постъпване е днес');

  // Без номер на брой.
  let ts = await addIssueViaForm('', Y + '-01-15', '3.50');
  assert.ok(ts.some(t => t.type === 'err' && /Въведете номер на брой/.test(t.msg)), JSON.stringify(ts));
  assert.equal(q('SELECT COUNT(*) AS n FROM periodical_issues').n, 0);

  // Бр. 1 — 15.01, 3.50 € (цената в лева се преобразува).
  h.type('#issueF [name=issue_no]', '1');
  h.type('#issueF [name=date]', Y + '-01-15');
  h.type('#issueF [data-bgn-for=price]', '6.85');
  assert.equal(h.$('#issueF [name=price]').value, '3.50', 'левовете стават евро');
  let n = h.toasts.length;
  await h.clickButton('Добави брой', '#modal'); await h.settle();
  ts = h.toastsSince(n);
  assert.ok(ts.some(t => t.msg === 'Брой 1 е вписан в кардекса.' && t.type === 'ok'), JSON.stringify(ts));
  const i1 = q('SELECT * FROM periodical_issues WHERE periodical_id = ?', ids.chit);
  assert.equal(i1.issue_no, '1');
  assert.equal(i1.date, Y + '-01-15');
  assert.equal(i1.price, 3.5);
  assert.equal(lastAudit('Постъпил брой').detail, 'Читалище — бр. 1');
  // Кардексът се пречертава: редът на броя, годината в раздела „Годишни комплекти“.
  await h.waitFor(() => issueRow('1'), 'редът на бр. 1');
  assert.match(h.text(issueRow('1')), rx('1 15.01.' + Y + ' 3.50 € / 6.85 лв.'));
  assert.ok(volumeRow(Y), 'годината ' + Y + ' се появява в раздела за комплекти');
  assert.match(h.text(volumeRow(Y)), rx(Y + ' 1 3.50 € / 6.85 лв. не е инвентиран Инвентирай годишния комплект'));

  // Невалидна дата (30 февруари): полето type=date я изхвърля (стойност ''),
  // а през API (внос/мобилен път) обработчикът я отказва.
  h.type('#issueF [name=date]', Y + '-02-30');
  assert.equal(h.$('#issueF [name=date]').value, '', 'браузърът не приема 30 февруари');
  const badDate = await h.api.periodicalIssues.add({ periodical_id: ids.chit, issue_no: '2', date: Y + '-02-30', price: '3.50' });
  assert.equal(badDate.ok, false); assert.match(badDate.error, /невалидна/);
  assert.equal(q('SELECT COUNT(*) AS n FROM periodical_issues').n, 1);
  // Отрицателна цена → отказ.
  ts = await addIssueViaForm('2', Y + '-02-14', '-1');
  assert.ok(ts.some(t => t.type === 'err' && /Цената на броя трябва да е число/.test(t.msg)), JSON.stringify(ts));
  // Нечислова цена и липсващо издание през API.
  const bad = await h.api.periodicalIssues.add({ periodical_id: ids.chit, issue_no: '2', date: Y + '-02-14', price: 'abc' });
  assert.equal(bad.ok, false); assert.match(bad.error, /число/);
  const noPer = await h.api.periodicalIssues.add({ periodical_id: 99999, issue_no: '2', date: T, price: 1 });
  assert.equal(noPer.ok, false); assert.match(noPer.error, /Изданието не е намерено/);
  // Цена със запетая → 3.50.
  const comma = ok(await h.api.periodicalIssues.add({ periodical_id: ids.chit, issue_no: '2', date: Y + '-02-14', price: '3,50' }), 'запетая');
  assert.equal(q('SELECT price FROM periodical_issues WHERE id = ?', comma).price, 3.5);

  // Същият брой втори път (сканиран два пъти / второ работно място).
  const dup = await h.api.periodicalIssues.add({ periodical_id: ids.chit, issue_no: '2', date: Y + '-02-14', price: '3.50' });
  await soft('НАХОДКА 4: дублиран брой (същият № и дата) се вписва втори път', async () => {
    // Няма проверка за повторение в periodicalIssues:add и няма UNIQUE в
    // схемата. Кардексът брои 3 броя вместо 2, сборът за годината (и оттам
    // предложената цена на годишния комплект в инвентарната книга) е с 3.50 €
    // повече от платеното.
    assert.equal(dup.ok, false, 'очаква се отказ или предупреждение за повторен бр. 2 от ' + Y + '-02-14');
  });
  await openTitle('Читалище');
  const rows2 = Array.from(h.document.querySelectorAll('#modal table.ledger tbody tr')).filter(tr => tr.querySelector('button.dgr') && tr.firstElementChild.textContent.trim() === '2');
  if (dup.ok) {
    assert.equal(rows2.length, 2, 'двата еднакви реда са в кардекса');
    assert.match(h.text(volumeRow(Y)), rx(Y + ' 3 10.50 €'), 'сборът брои и дубликата');
    // Изтриване на дубликата през „×“ с потвърждение — отказ, после съгласие.
    h.hooks.confirmAnswer = false;
    n = h.toasts.length;
    await h.click(rows2[1].querySelector('button.dgr'));
    assert.match(h.hooks.confirms[h.hooks.confirms.length - 1], /Да изтрия ли този брой от кардекса/);
    assert.equal(q('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ?', ids.chit).n, 3, 'отказът не трие');
    h.hooks.confirmAnswer = true;
    await h.click(rows2[1].querySelector('button.dgr'));
    assert.ok(h.toastsSince(n).some(t => t.msg === 'Броят е изтрит.'), JSON.stringify(h.toastsSince(n)));
    assert.equal(q('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ?', ids.chit).n, 2);
    assert.match(lastAudit('Изтрит брой').detail, rx('„Читалище“ — бр. 2 от ' + Y + '-02-14 (' + Y + ' г.), цена 3.50 €'));
    assert.doesNotMatch(lastAudit('Изтрит брой').detail, /ВНИМАНИЕ/);
    await h.waitFor(() => issueRow('1') && h.document.querySelectorAll('#modal table.ledger tbody tr button.dgr').length === 2, 'пречертан кардекс');
  }
  // Повторно изтриване на вече изтрит брой (стар прозорец на второ работно място).
  const gone = await h.api.periodicalIssues.delete(dup.ok ? dup.data : 999999);
  assert.equal(gone.ok, false);
  assert.match(gone.error, /вече не съществува/);

  // Списъкът: 2 броя, жълта нула за комплекти, следващ очакван брой 14.03 (закъснял).
  await h.clickButton('Затвори', '#modal footer');
  await h.waitFor(() => rowOf('Читалище') && /2/.test(h.text(rowOf('Читалище'))), 'списъкът е опреснен при затваряне');
  await h.settle();
  const r = h.text(rowOf('Читалище'));
  assert.match(r, rx('Читалище месечно Съюз на народните читалища 0324-0975 периодика 2 0 14.03.' + Y));
  const badge = rowOf('Читалище').querySelector('td:nth-child(7) .badge.warn');
  assert.ok(badge, 'нула инвентирани комплекта при вписани броеве е жълт знак');
  assert.match(badge.title, /не влиза в КДБФ/);
  const nextBadge = rowOf('Читалище').querySelector('td:nth-child(8) .badge.warn');
  assert.ok(nextBadge, 'следващият брой е закъснял');
  const list = ok(await h.api.periodicals.list(), 'списък');
  const ch = list.find(p => p.id === ids.chit);
  assert.equal(ch.issue_count, 2);
  assert.equal(ch.next_expected, Y + '-03-14');
  const expDays = Math.round((new Date(T) - new Date(Y + '-03-14')) / 864e5);
  assert.equal(ch.issue_overdue_days, Math.max(0, expDays), 'дните закъснение = днес − 14.03');
  noRendererErrors();
});

/* ==================================================================
   4. Таблото: закъснели/липсващи броеве; бъдеща дата „заглушава“ предупреждението
   ================================================================== */
test('4. табло — броят на изданията със закъснял брой; брой с дата в бъдещето', async () => {
  let d = ok(await h.api.dashboard.full(), 'табло');
  assert.equal(d.today.overduePeriodicals, 1, 'само „Читалище“ е закъсняло (другите нямат броеве)');
  await h.go('dash');
  assert.match(h.viewText(), /Периодични издания — закъснял\/липсващ брой 1/);
  // „Наука“ (тримесечно) — брой отпреди 150 дни → очакван преди ~60 дни.
  const old = E.addDays(T, -150);
  ok(await h.api.periodicalIssues.add({ periodical_id: ids.nauka, issue_no: '1', date: old, price: 8 }), 'Наука бр. 1');
  d = ok(await h.api.dashboard.full(), 'табло');
  assert.equal(d.today.overduePeriodicals, 2);
  const nk = ok(await h.api.periodicals.list(), 'списък').find(p => p.id === ids.nauka);
  assert.ok(nk.issue_overdue_days > 0 && nk.issue_overdue_days < 150, 'закъснението е спрямо +3 месеца: ' + JSON.stringify(nk));

  // Брой с дата в БЪДЕЩЕТО (сгрешена година при писане: 2027 вместо 2026).
  const fut = await h.api.periodicalIssues.add({ periodical_id: ids.nauka, issue_no: '2', date: YN + '-03-01', price: 8 });
  /* v2.4.61: редът `ok(fut, …)` тук беше скеле на сценария — той ТВЪРДЕШЕ
     дефекта (че бъдещата дата се приема) и след поправката щеше да пада пръв,
     преди самото твърдение на находката. Махнат е; проверката остава в soft()
     по-долу, а клонът `if (fut.ok)` описва какво ставаше, докато вписването
     минаваше. */
  d = ok(await h.api.dashboard.full(), 'табло');
  await soft('НАХОДКА 5: брой с бъдеща дата на постъпване се приема и заглушава предупреждението за липсващ брой', async () => {
    // periodicalIssues:add проверява само дали датата е валидна. „Дата на
    // постъпване“ след днес е физически невъзможна; MAX(date) става бъдеща,
    // next_expected отива още по-напред и изданието изчезва от „За днес“ на
    // таблото, а в кардекса се появява година YN за инвентиране.
    assert.equal(fut.ok, false, 'очаква се отказ (или поне предупреждение) за дата ' + YN + '-03-01');
    assert.equal(d.today.overduePeriodicals, 2);
  });
  const nk2 = ok(await h.api.periodicals.list(), 'списък').find(p => p.id === ids.nauka);
  if (fut.ok) {
    assert.equal(nk2.next_expected, YN + '-06-01');
    assert.equal(nk2.issue_overdue_days, 0, 'бъдещият брой „оправя“ закъснението');
    const p = ok(await h.api.periodicals.get(ids.nauka), 'get');
    assert.ok(p.volumes.some(v => String(v.year) === YN), 'годината ' + YN + ' е в кардекса');
    ok(await h.api.periodicalIssues.delete(fut.data), 'махаме бъдещия брой');
    assert.equal(ok(await h.api.dashboard.full(), 'табло').today.overduePeriodicals, 2);
  }
  // Изданието без броеве (Труд) и „нередовно“ никога не се броят.
  ids.nered = ok(await h.api.periodicals.create({ title: 'Нередовен бюлетин', freq: 'нередовно' }), 'нередовно');
  ok(await h.api.periodicalIssues.add({ periodical_id: ids.nered, issue_no: '1', date: Y1 + '-01-01', price: 0 }), 'стар брой');
  assert.equal(ok(await h.api.dashboard.full(), 'табло').today.overduePeriodicals, 2, '„нередовно“ не влиза в броя');
  noRendererErrors();
});

/* ==================================================================
   5. Ежедневник „Труд“: 300+ броя за миналата година, граница на годината, време за чертане
   ================================================================== */
test('5. ежедневник — 300+ броя, 31.12/01.01 в различни години, кардексът с 300+ реда', async () => {
  // Граница на годината: бр. 300 от 31.12.Y1 и бр. 1 от 01.01.Y.
  ok(await h.api.periodicalIssues.add({ periodical_id: ids.trud, issue_no: '300', date: Y1 + '-12-31', price: 0.85 }), '31.12');
  ok(await h.api.periodicalIssues.add({ periodical_id: ids.trud, issue_no: '1', date: Y + '-01-01', price: 0.85 }), '01.01');
  // Празна дата → днес.
  const td = ok(await h.api.periodicalIssues.add({ periodical_id: ids.trud, issue_no: 'днешен', date: '', price: 0.85 }), 'празна дата');
  assert.equal(q('SELECT date FROM periodical_issues WHERE id = ?', td).date, T);
  ok(await h.api.periodicalIssues.delete(td), 'махаме го');

  // 300 броя по 0.85 € за Y1 (02.01 … ), както библиотеката ги вписва ден по ден.
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) {
    const r = await h.api.periodicalIssues.add({ periodical_id: ids.trud, issue_no: String(i + 1), date: E.addDays(Y1 + '-01-02', i), price: 0.85 });
    if (!r.ok) assert.fail('брой ' + (i + 1) + ': ' + r.error);
  }
  const tAdd = Date.now() - t0;
  assert.equal(q('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ?', ids.trud).n, 302);
  assert.ok(tAdd < 30000, '300 вписвания за ' + tAdd + ' ms');

  const p = ok(await h.api.periodicals.get(ids.trud), 'get');
  /* v2.4.61 (поправката на находка 6): periodicals:get вече връща броевете на
     ЕДНА година — по подразбиране текущата — плюс разрезa по години и общия
     брой. Дотук връщаше всичките 302 наведнъж и прозорецът ги чертаеше до един. */
  assert.equal(p.issues.length, 1, 'по подразбиране — броевете на текущата година');
  assert.equal(p.issue_year, Y);
  assert.equal(p.issue_total, 302, 'общият брой се връща, за да може прозорецът да каже „показани N от M“');
  assert.deepEqual(p.issue_years.map(x => [x.year, x.n]), [[Y, 1], [Y1, 301]]);
  assert.equal(ok(await h.api.periodicals.get(ids.trud, { year: Y1 }), 'get Y1').issues.length, 301, 'избрана година');
  assert.equal(ok(await h.api.periodicals.get(ids.trud, { year: 'всички' }), 'get всички').issues.length, 302, 'и всички наведнъж, ако поиска');
  const vY1 = p.volumes.find(v => String(v.year) === Y1);
  const vY = p.volumes.find(v => String(v.year) === Y);
  assert.equal(vY1.issue_count, 301, '300 дневни + 31.12');
  assert.equal(vY.issue_count, 1, 'само 01.01 е в ' + Y);
  assert.equal(Math.round(vY1.issue_sum * 100), 25585, '301 × 0.85 = 255.85');
  assert.equal(Math.round(vY.issue_sum * 100), 85);
  assert.deepEqual(p.volumes.map(v => String(v.year)), [Y, Y1], 'годините — низходящо');

  // Кардексът с 302 реда: време за чертане и брой редове.
  await h.go('periodika');
  const t1 = Date.now();
  await openTitle('Труд');
  const tOpen = Date.now() - t1;
  const rows = h.document.querySelectorAll('#modal table.ledger tbody tr button.dgr').length;
  /* v2.4.61 (поправката на находка 6): в прозореца стоят броевете на ИЗБРАНАТА
     година (по подразбиране текущата), а не всичките 302. Годината се сменя от
     селекта, а надписът казва колко от колко се показват. */
  assert.equal(rows, 1, 'чертаят се само броевете на текущата година');
  assert.match(h.text('#perIssueCount'), rx('Показани 1 от 302 броя — ' + Y + ' г.'));
  assert.ok(h.$('#perIssueYear'), 'има избор на година');
  h.type('#perIssueYear', Y1);
  await h.settle();
  /* ПРОМЕНЕНО ПОВЕДЕНИЕ (v2.4.64, измерване). Кардексът вече минава през общия
     прозоречен рендер (paintRowWindow/RENDER_PAGE_SIZE в core.js) — както
     „Книги“, „Читатели“ и МЗС. Дотук избраната година се чертаеше ЦЯЛАТА, а
     опцията „всички години“ заобикаляше и самия разрез по година: измерено
     1 200 броя → 7 295 DOM възела в кутия с превъртане 240 px, от които на
     екрана се виждат около петнайсет. Затова тук вече стоят първите 300 реда, а
     под тях — „Покажи още“. Находката, която този тест пази (разрезът по
     година), не се променя — променя се само колко реда се чертаят наведнъж. */
  assert.equal(h.document.querySelectorAll('#modal table.ledger tbody tr button.dgr').length, 300, 'миналата година — първата порция');
  assert.match(h.text('#perIssueCount'), rx('Показани 300 от 302 броя — ' + Y1 + ' г.'));
  assert.match(h.text('#perIssuesMore'), /Покажи още \(1 от общо 301\)/);
  // Търсене по номер в рамките на годината — „намери ми бр. 117“ без превъртане.
  h.type('#perIssueSearch', '117');
  const visible = Array.from(h.document.querySelectorAll('#modal #perIssuesBody tr')).filter(tr => tr.style.display !== 'none');
  assert.ok(visible.length && visible.length < 301, 'търсенето стеснява списъка: ' + visible.length);
  assert.match(h.text('#perIssueCount'), /филтър/);
  h.type('#perIssueYear', Y);
  await h.settle();
  assert.ok(tOpen < 4000, 'отварянето на кардекса с 302 броя отне ' + tOpen + ' ms');
  console.log('# ежедневник: 300 вписвания през API за ' + tAdd + ' ms; кардекс с 302 реда се чертае за ' + tOpen + ' ms');
  await soft('НАХОДКА 6: кардексът чертае всичките 300+ реда в прозорец с превъртане 240 px, без страници и без търсене', async () => {
    // openPeriodical вгражда p.issues изцяло (302 реда × 4 колони, всеки с бутон
    // „×“) в модален прозорец с max-height:240px. При ежедневник след 3 години
    // това са ~1000 реда при всяко отваряне И след всяко „Добави брой“ (формата
    // се пречертава изцяло). Няма страници, филтър по година или търсене по
    // номер — да се намери „бр. 117“ значи да се превърта. Очаква се поне
    // ограничение „последните N“ + филтър по година.
    assert.ok(rows <= 100 || h.$('#modal input[type=search], #modal [name=issueFilter]'), 'очаква се странициране/филтър при ' + rows + ' реда');
  });
  // Редът за годината Y1 в раздела за комплекти: 301 броя, 255.85 €.
  assert.match(h.text(volumeRow(Y1)), rx(Y1 + ' 301 ' + E.mny(255.85) + ' не е инвентиран'));
  assert.match(h.text(volumeRow(Y)), rx(Y + ' 1 0.85 € / 1.66 лв. не е инвентиран'));
  await h.clickButton('Затвори', '#modal footer');
  await h.settle();
  // Списъкът: 302 броя; седмично → следващ очакван 08.01.Y (закъснял).
  const tr = ok(await h.api.periodicals.list(), 'list').find(x => x.id === ids.trud);
  assert.equal(tr.issue_count, 302);
  assert.equal(tr.last_issue_date, Y + '-01-01');
  assert.equal(tr.next_expected, Y + '-01-08');
  assert.equal(ok(await h.api.dashboard.full(), 'табло').today.overduePeriodicals, 3);
  noRendererErrors();
});

/* ==================================================================
   6. Инвентиране на годишния комплект през формата (с нова партида „абонамент“)
   ================================================================== */
test('6. „Инвентирай годишния комплект“ — Читалище/Y: нова партида в КДБФ Част № 1, ред в инвентарната книга', async () => {
  await openTitle('Читалище');
  await h.clickButton('Инвентирай годишния комплект', volumeRow(Y));
  await h.waitFor(() => h.$('#volF'), 'формата за инвентиране');
  await h.settle();
  const m2 = h.modal2();
  assert.match(m2, rx('Инвентиране на годишен комплект — Читалище, ' + Y + ' г.'));
  assert.match(m2, /Чл\. 16, ал\. 1/);
  assert.match(m2, rx('„Читалище, ' + Y + '“'));
  assert.match(m2, /вид „продължаващо издание“, том „годишен комплект“/);
  assert.match(m2, rx('има 2 вписани броя на обща стойност 7.00 € / 13.69 лв.'));
  assert.equal(h.$('#volF [name=inv_number]').value, '1', 'следващият инв. № се предлага');
  assert.equal(h.$('#volF [name=register_date]').value, T);
  assert.equal(h.$('#volF [name=price]').value, '7.00', 'цената по подразбиране е сборът на броевете');
  assert.equal(h.$('#volF [name=acquisition_id]').value, '', 'без партида по подразбиране');
  assert.equal(h.$('#volAcqNew').hidden, true, 'полетата на новата партида са скрити');
  // Нова партида — абонаментът като постъпление.
  h.type('#volF [name=acquisition_id]', '__new__');
  assert.equal(h.$('#volAcqNew').hidden, false);
  // Без „откъде“ → отказ.
  let n = h.toasts.length;
  await h.clickButton('Впиши в инвентарната книга', '#modal2 footer');
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /откъде е постъпил абонаментът/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT COUNT(*) AS n FROM acquisitions').n, 0, 'партида не е създадена');
  h.type('#volF [name=acq_from_source]', 'Български пощи — абонамент');
  h.type('#volF [name=acq_how]', 'закупуване');
  h.type('#volF [name=acq_doc_type]', 'фактура');
  h.type('#volF [name=acq_doc_no]', 'Ф-2026-17');
  h.type('#volF [name=acq_doc_date]', Y + '-01-10');
  h.type('#volF [name=note]', 'подвързан в 1 том');
  n = h.toasts.length;
  await h.clickButton('Впиши в инвентарната книга', '#modal2 footer');
  await h.settle();
  const ts = h.toastsSince(n);
  assert.ok(ts.some(t => t.msg === 'Партидата е заведена в КДБФ част 1.'), JSON.stringify(ts));
  assert.ok(ts.some(t => t.type === 'ok' && t.msg === 'Годишният комплект за ' + Y + ' г. е вписан в инвентарната книга под инв. № 1.'), JSON.stringify(ts));

  // Базата: партида, ред в books, inventory, periodical_volumes, брояч, следа.
  const a = q('SELECT * FROM acquisitions WHERE year = ? AND no = 1', Y);
  assert.ok(a, 'партида № 1/' + Y);
  ids.acqChit = a.id;
  assert.equal(a.from_source, 'Български пощи — абонамент');
  assert.equal(a.how, 'закупуване');
  assert.equal(a.doc_no, 'Ф-2026-17');
  assert.equal(a.total_count, 1);
  assert.equal(a.sum, null, 'обявена стойност не се подава — NULL');
  assert.equal(a.note, 'Абонамент за периодика');
  const b = q('SELECT b.*, c.name AS cat, i.quantity FROM books b LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN inventory i ON i.book_id = b.id WHERE b.inv_number = 1');
  assert.ok(b, 'редът в books');
  ids.volChit = b.id;
  assert.equal(b.title, 'Читалище, ' + Y);
  assert.equal(b.author, null);
  assert.equal(b.cat, 'продължаващо издание');
  assert.equal(b.volume, 'годишен комплект');
  assert.equal(b.year, Y);
  assert.equal(b.series, 'Читалище');
  assert.equal(b.series_no, Y + ' г.');
  assert.equal(b.publisher, 'Съюз на народните читалища');
  assert.equal(b.department, 'периодика');
  assert.equal(b.status, 'наличен');
  assert.equal(b.status_date, T);
  assert.equal(b.register_date, T);
  assert.equal(b.price, 7);
  assert.equal(b.acquisition_id, a.id);
  assert.equal(b.description, 'подвързан в 1 том');
  assert.equal(b.quantity, 1, 'един комплект = един екземпляр');
  assert.equal(q('SELECT next_inv_number FROM settings').next_inv_number, 2);
  const v = q('SELECT * FROM periodical_volumes WHERE periodical_id = ? AND year = ?', ids.chit, Y);
  assert.equal(v.book_id, b.id);
  assert.equal(v.issue_count, 2, 'снимка на броя броеве');
  assert.equal(v.issue_sum, 7);
  assert.match(lastAudit('Инвентиран годишен комплект').detail, rx('инв. № 1 — „Читалище, ' + Y + '“ (2 бр. в кардекса), 7.00 €, вписан на ' + T + ', партида № 1/' + Y));

  // Кардексът е пречертан: редът на годината носи инв. №, датата, партидата.
  await h.waitFor(() => volumeRow(Y) && /инв\. № 1/.test(h.text(volumeRow(Y))), 'кардексът след инвентиране');
  assert.match(h.text(volumeRow(Y)), rx(Y + ' 2 7.00 € / 13.69 лв. инв. № 1 · вписан ' + E.bgDate(T) + ' · партида № 1/' + Y));
  assert.ok(!volumeRow(Y).querySelector('button'), 'бутонът за инвентиране изчезва');
  await h.clickButton('Затвори', '#modal footer');
  await h.waitFor(() => rowOf('Читалище') && !rowOf('Читалище').querySelector('td:nth-child(7) .badge'), 'списъкът: 1 комплект');
  assert.match(h.text(rowOf('Читалище')), /периодика 2 1 /, 'Броеве 2, Инвентирани комплекти 1');
  noRendererErrors();
});

/* ==================================================================
   7. Комплектът е във фонда: табло, инвентарна книга, КДБФ Част № 1/2, отчет, каталог
   ================================================================== */
test('7. комплектът се вижда навсякъде: табло, инвентарна книга, КДБФ, годишен отчет, онлайн каталог', async () => {
  const d = ok(await h.api.dashboard.full(), 'табло');
  assert.equal(d.fundCount, 1);
  assert.equal(d.fundValue, 7);
  const ib = ok(await h.api.invBook.list({ offset: 0, limit: 10 }), 'инв. книга');
  assert.equal(ib.summary.activeCopies, 1);
  const row = ib.rows.find(r => r.inv_number === 1);
  assert.equal(row.title, 'Читалище, ' + Y);
  assert.equal(row.acq_no, 1);
  await h.go('invbook');
  assert.match(h.text('#ibBody'), rx('1 Читалище, ' + Y + ', т. годишен комплект ' + Y + ' 7.00 € 13.69 лв.'));
  assert.match(h.viewText(), /1 Неотчислени 7\.00 € \/ 13\.69 лв\./);

  const k = ok(await h.api.kdbf.report(Y), 'КДБФ');
  const p1 = k.part1.find(x => x.id === ids.acqChit);
  assert.equal(p1.registered_count, 1);
  assert.equal(p1.registered_value, 7);
  assert.equal(p1.inv_from, 1);
  assert.equal(k.acquiredYear.n, 1);
  assert.equal(k.acquiredYear.v, 7);
  assert.equal(k.stockEnd.n, 1);
  assert.deepEqual(k.byKind.map(x => [x.kind, x.n, x.v]), [['продължаващо издание', 1, 7]]);
  await h.go('kdbf');
  assert.match(h.viewText(), /Български пощи — абонамент закупуване фактура № Ф-2026-17/);
  assert.match(h.viewText(), /продължаващо издание: 1/);
  await h.clickButton('Печат / PDF', '#view'); await h.settle();
  const pk = h.printed();
  assert.match(pk, /КНИГА ЗА ДВИЖЕНИЕ НА БИБЛИОТЕЧНИЯ ФОНД/);
  assert.match(pk, /периодични издания/i, 'заглавието на Част № 1 изброява периодичните издания');
  assert.match(pk, /Български пощи — абонамент \/ закупуване фактура № Ф-2026-17/);
  assert.match(pk, /продължаващо издание 1 7\.00 € \/ 13\.69 лв\./);
  h.window.ppClose();

  const s = ok(await h.api.stats.report(Y), 'отчет');
  assert.equal(s.fundCount, 1);
  assert.equal(s.acquiredCount, 1);
  assert.equal(s.acquiredValue, 7);
  assert.deepEqual(s.fundByCategory, [['продължаващо издание', 1]]);
  assert.deepEqual(s.fundByDepartment, [['периодика', 1]]);
  const fb = ok(await h.api.reports.run({ id: 'fund_breakdown', year: Y }), 'справка');
  assert.deepEqual(fb.byCategory, [['продължаващо издание', 1]]);
  const fm = ok(await h.api.reports.run({ id: 'fund_movement', year: Y }), 'движение');
  assert.deepEqual(fm.acquired, [['закупуване', 1, 7]], 'партидата без обявена стойност взима сбора на документите');
  await h.go('stats');
  assert.match(h.viewText(), /продължаващо издание/);
  assert.match(h.viewText(), /\+1 · 7\.00 € \/ 13\.69 лв\./);

  // Онлайн каталог: комплектът е публикуван и наличен.
  const out = path.join(os.tmpdir(), 'katalog-periodika-' + process.pid + '.json');
  h.dialogs.savePath = out;
  ok(await h.api.catalog.export(), 'каталог');
  const cat = JSON.parse(fs.readFileSync(out, 'utf8'));
  const it = cat.items.find(x => x.inv === 1);
  assert.ok(it, 'комплектът е в katalog.json');
  assert.equal(it.t, 'Читалище, ' + Y);
  assert.equal(it.v, 'продължаващо издание');
  assert.equal(it.o, 'периодика');
  assert.equal(it.av, 1);
  assert.equal(it.p, 'Съюз на народните читалища');
  // Инвентарна книга / PDF — редът на комплекта.
  await h.go('invbook');
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  await h.waitFor(() => h.$('#ibPrintF'), 'диалогът за диапазон');
  await h.clickButton('Цялата книга', '#modal footer'); await h.settle();
  const pi = h.printed();
  assert.match(pi, /ИНВЕНТАРНА КНИГА/i);
  assert.match(pi, rx('Читалище, ' + Y + ', т. годишен комплект ' + Y + ' 1 7.00 € / 13.69 лв. № 1 / ' + E.bgDate(T) + ' наличен подвързан в 1 том'));
  assert.doesNotMatch(pi, /продължаващо издание/, 'Приложение № 4 няма колона „Вид“ — комплектът се познава само по „т. годишен комплект“');
  h.window.ppClose();
  const chk = ok(await h.api.fund.check(Y), 'съгласуване');
  assert.ok(chk.findings.every(f => f.level === 'бележка'), JSON.stringify(chk.findings.map(f => [f.key, f.level, f.title])));
  noRendererErrors();
});

/* ==================================================================
   8. Отказите при инвентиране: повторно, година, цена, дата, партида, инв. №, лимит
   ================================================================== */
test('8. periodicalVolumes:register — повторно инвентиране, невалидни година/цена/дата/партида/инв. №, лимит', async () => {
  const reg = (o) => h.api.periodicalVolumes.register(Object.assign({ periodical_id: ids.chit, year: Y }, o));
  let r = await reg({});
  assert.equal(r.ok, false);
  assert.match(r.error, rx('Годишният комплект на „Читалище“ за ' + Y + ' г. вече е инвентиран като инв. № 1 (вписан на ' + T + ')'));
  assert.match(r.error, /отчислете го с акт/);
  // През формата: бутонът го няма, а прекият път връща известие.
  await openTitle('Читалище');
  let n = h.toasts.length;
  await h.window.volumeForm(ids.chit, Y); await h.settle();
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /вече е инвентиран като инв\. № 1/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.equal(h.$('#volF'), null, 'формата не се отваря');
  n = h.toasts.length;
  await h.window.volumeForm(ids.chit, '1999'); await h.settle();
  assert.ok(h.toastsSince(n).some(t => /Годината вече не е налична в кардекса/.test(t.msg)));
  await h.clickButton('Затвори', '#modal footer');

  for (const [year, why] of [['20255', 'петцифрена'], ['abc', 'текст'], ['', 'празна'], [String(Number(Y) + 2), 'след следващата'], ['1799', 'преди 1800']]) {
    r = await reg({ year });
    assert.equal(r.ok, false, 'година ' + why + ' се приема');
    assert.match(r.error, /Годината/);
  }
  r = await reg({ periodical_id: ids.nauka, year: Y, price: '-1' });
  assert.equal(r.ok, false); assert.match(r.error, /Цената на годишния комплект/);
  r = await reg({ periodical_id: ids.nauka, year: Y, price: 'abc' });
  assert.equal(r.ok, false); assert.match(r.error, /Цената/);
  r = await reg({ periodical_id: ids.nauka, year: Y, register_date: Y + '-02-30' });
  assert.equal(r.ok, false); assert.match(r.error, /Датата на вписване/);
  r = await reg({ periodical_id: ids.nauka, year: Y, acquisition_id: 99999 });
  assert.equal(r.ok, false); assert.match(r.error, /Избраната партида не съществува/);
  r = await reg({ periodical_id: ids.nauka, year: Y, acquisition_id: 'abc' });
  assert.equal(r.ok, false); assert.match(r.error, /Номерът на партидата е невалиден/);
  r = await reg({ periodical_id: ids.nauka, year: Y, inv_number: 1 });
  assert.equal(r.ok, false); assert.match(r.error, /Инв\. № 1 вече е зает/);
  r = await reg({ periodical_id: ids.nauka, year: Y, inv_number: 0 });
  assert.equal(r.ok, false); assert.match(r.error, /цяло положително число/);
  r = await reg({ periodical_id: ids.nauka, year: Y, inv_number: -3 });
  assert.equal(r.ok, false);
  r = await reg({ periodical_id: 99999, year: Y });
  assert.equal(r.ok, false); assert.match(r.error, /Изданието не е намерено/);
  // Лимитът на записите пази и тази врата.
  ok(await h.api.limits.update({ limit_books: 1, limit_readers: 0 }), 'лимит 1');
  r = await reg({ periodical_id: ids.nauka, year: Y });
  assert.equal(r.ok, false); assert.match(r.error, /Достигнат е зададеният лимит от 1 документи/);
  ok(await h.api.limits.update({ limit_books: 0, limit_readers: 0 }), 'без лимит');
  assert.equal(q('SELECT COUNT(*) AS n FROM books').n, 1, 'нищо от отказите не е записано');
  assert.equal(q('SELECT COUNT(*) AS n FROM periodical_volumes').n, 1);
  assert.equal(q('SELECT next_inv_number FROM settings').next_inv_number, 2);
  noRendererErrors();
});

/* ==================================================================
   9. Ръбове на инвентирането: година без броеве, дата на вписване преди годината, прескочен инв. №, дробна цена
   ================================================================== */
test('9. комплект без нито един брой; вписан преди годината на комплекта; прескочен инв. № без следа; плаваща цена', async () => {
  const yEmpty = String(Number(Y) - 3);
  const r0 = await h.api.periodicalVolumes.register({ periodical_id: ids.nauka, year: yEmpty });
  await soft('НАХОДКА 7: годишен комплект за година БЕЗ нито един вписан брой се инвентира с цена 0', async () => {
    // Формата показва само годините с броеве, но обработчикът приема всяка
    // година 1800..YN. Комплект „Наука, Y−3“ с 0 бр. и 0.00 € влиза в
    // инвентарната книга и в КДБФ като документ — а след изтриването на
    // сгрешения ред годината остава в кардекса завинаги (виж по-долу).
    assert.equal(r0.ok, false, 'очаква се отказ или изрично потвърждение за комплект без броеве; записано: ' + JSON.stringify(r0.data));
  });
  if (r0.ok) {
    assert.equal(q('SELECT price FROM books WHERE id = ?', r0.data.book_id).price, 0);
    // Библиотекарката забелязва и трие сгрешения ред (две натискания).
    await h.api.books.delete(r0.data.book_id);
    ok(await h.api.books.delete(r0.data.book_id), 'изтриване');
    const pv = q('SELECT * FROM periodical_volumes WHERE periodical_id = ? AND year = ?', ids.nauka, yEmpty);
    assert.ok(pv && pv.book_id == null, 'връзката остава с book_id NULL');
    const p = ok(await h.api.periodicals.get(ids.nauka), 'get');
    await soft('НАХОДКА 8: след изтриване на сгрешен комплект годината остава в кардекса като „не е инвентиран“ без нито един брой и без начин да се махне', async () => {
      assert.ok(!p.volumes.some(v => String(v.year) === yEmpty && !v.issue_count), 'призрачна година ' + yEmpty + ' в кардекса: ' + JSON.stringify(p.volumes));
    });
    h.db.prepare('DELETE FROM periodical_volumes WHERE id = ?').run(pv.id);
    h.db.prepare('UPDATE settings SET next_inv_number = 2 WHERE id = 1').run();
  }

  // Комплект за Y, вписан с дата от Y1 (преди да е излязъл първият брой).
  const rBack = await h.api.periodicalVolumes.register({ periodical_id: ids.nauka, year: Y, register_date: Y1 + '-06-01' });
  await soft('НАХОДКА 9: комплектът за ' + Y + ' г. се вписва с дата на вписване ' + Y1 + '-06-01 — преди годината на комплекта', async () => {
    // Няма проверка register_date >= year-01-01. Документът влиза като
    // постъпление в КДБФ Част № 2 за Y1 (година, чийто регистър вече е
    // отпечатан и подписан) и в наличността към 31.12.Y1 — за комплект, чиито
    // броеве още не са съществували.
    assert.equal(rBack.ok, false, 'очаква се отказ');
  });
  if (rBack.ok) {
    const k1 = ok(await h.api.kdbf.report(Y1), 'КДБФ ' + Y1);
    assert.equal(k1.acquiredYear.n, 1, 'постъпление в миналата година');
    await h.api.books.delete(rBack.data.book_id); ok(await h.api.books.delete(rBack.data.book_id), 'чистене');
    h.db.prepare('DELETE FROM periodical_volumes WHERE periodical_id = ? AND year = ?').run(ids.nauka, Y);
    h.db.prepare('UPDATE settings SET next_inv_number = 2 WHERE id = 1').run();
  }

  // Прескочен инв. № (2 → 40): при книгите има предупреждение и следа „Прескочени инвентарни номера“.
  const nAudit = q('SELECT COUNT(*) AS n FROM audit_log').n;
  const rGap = ok(await h.api.periodicalVolumes.register({ periodical_id: ids.nauka, year: Y, inv_number: 40, price: '8' }), 'инв. № 40');
  ids.volNauka = rGap.book_id;
  assert.equal(rGap.inv_number, 40);
  assert.equal(q('SELECT next_inv_number FROM settings').next_inv_number, 41, 'броячът прескача след 40');
  await soft('НАХОДКА 10: прескочените инв. № 2–39 при инвентиране на комплект не оставят нито предупреждение, нито следа', async () => {
    // books:create връща invGap и вписва „Прескочени инвентарни номера“; тук
    // 38 номера изчезват от поредицата (чл. 16, ал. 2) без дума.
    assert.ok(rGap.invGap || q("SELECT 1 FROM audit_log WHERE action = 'Прескочени инвентарни номера' AND id > ?", nAudit), 'няма следа за 38 прескочени номера');
  });
  // Комплектът за Y1 на „Труд“: цена по подразбиране = 301 × 0.85.
  const rT = ok(await h.api.periodicalVolumes.register({ periodical_id: ids.trud, year: Y1, register_date: Y + '-01-05' }), 'Труд ' + Y1);
  ids.volTrud = rT.book_id;
  assert.equal(rT.inv_number, 41);
  assert.equal(rT.issue_count, 301);
  const priceT = q('SELECT price FROM books WHERE id = ?', ids.volTrud).price;
  assert.equal(Math.round(priceT * 100), 25585);
  await soft('НАХОДКА 11: цената на комплекта се записва като необработен сбор с плаваща запетая', async () => {
    // SUM(0.85 × 301) в SQLite = 255.85000000000005 (или подобно); в books.price
    // влиза точно това, вместо закръглено до стотинка, както е по фактура.
    assert.equal(priceT, 255.85, 'записано: ' + priceT);
  });
  // Цената в списъка на фонда и в КДБФ излиза закръглена.
  const k = ok(await h.api.kdbf.report(Y), 'КДБФ');
  assert.equal(Math.round(k.acquiredYear.v * 100), Math.round((7 + 8 + 255.85) * 100));
  assert.equal(k.acquiredYear.n, 3);
  noRendererErrors();
});

/* ==================================================================
   10. Кардексът след инвентиране: нов брой, изтриване на брой от подвързан комплект, второ работно място
   ================================================================== */
test('10. брой, добавен/изтрит след инвентирането; второто работно място инвентира първо', async () => {
  // Нов брой към вече инвентирана година → живият брой 3 срещу снимката 2.
  ok(await h.api.periodicalIssues.add({ periodical_id: ids.chit, issue_no: '3', date: Y + '-03-12', price: 3.5 }), 'бр. 3');
  const p = ok(await h.api.periodicals.get(ids.chit), 'get');
  const v = p.volumes.find(x => String(x.year) === Y);
  assert.equal(v.issue_count, 3, 'живият брой');
  assert.equal(v.registered_issue_count, 2, 'снимката при инвентирането');
  assert.equal(v.volume_price, 7, 'цената на документа не се променя със задна дата');
  assert.equal(Math.round(v.issue_sum * 100), 1050);
  await openTitle('Читалище');
  await soft('НАХОДКА 12: кардексът не показва, че подвързаният комплект (2 бр., 7.00 €) вече не отговаря на кардекса (3 бр., 10.50 €)', async () => {
    // periodicals:get връща registered_issue_count, но
    // periodicalVolumesSection печата само живия брой до „инв. № 1“ — редът
    // изглежда като „3 броя, 7.00 €, инв. № 1“, без знак, че комплектът е
    // подвързан с 2. При проверка разминаването се открива само в одитната
    // следа при изтриване.
    assert.match(h.text(volumeRow(Y)), /разминав|снимка|подвързан[а-я]* (с|при)|при инвентиране/i, 'редът: ' + h.text(volumeRow(Y)));
  });
  // Изтриване на брой от инвентирана година: питането казва инв. №, следата — ВНИМАНИЕ.
  h.hooks.confirmAnswer = true;
  const n = h.toasts.length;
  await h.click(issueRow('3').querySelector('button.dgr'));
  assert.match(h.hooks.confirms[h.hooks.confirms.length - 1], /част от годишния комплект, инвентиран като инв\. № 1/);
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Броят е изтрит.'), JSON.stringify(h.toastsSince(n)));
  assert.match(lastAudit('Изтрит брой').detail, /бр\. 3 .*ВНИМАНИЕ: годината вече е инвентирана като инв\. № 1 — кардексът вече не отговаря на подвързания комплект/);
  await h.clickButton('Затвори', '#modal footer');

  // Поправка на заглавието в картона след инвентиране: документите във фонда пазят старото.
  ok(await h.api.periodicals.update({ id: ids.chit, title: 'Читалище (сп.)', freq: 'месечно', publisher: 'Съюз на народните читалища', issn: '0324-0975', department: 'периодика' }), 'редакция');
  const bt = q('SELECT title, series FROM books WHERE id = ?', ids.volChit);
  assert.equal(bt.title, 'Читалище, ' + Y, 'редът в инвентарната книга не се преименува със задна дата');
  assert.equal(bt.series, 'Читалище');
  await soft('НАХОДКА 21: преименуването на издание с инвентирани комплекти минава без предупреждение, че 1 документ във фонда остава със старото заглавие', async () => {
    // periodicals:update не поглежда periodical_volumes; следата казва само
    // „Редакция на периодично издание — Читалище (сп.)“. При поправена печатна
    // грешка („Трд“ → „Труд“) инвентарната книга и каталогът остават с „Трд, 2025“.
    assert.match(lastAudit('Редакция на периодично издание').detail, /комплект|инв\. №/);
  });
  ok(await h.api.periodicals.update({ id: ids.chit, title: 'Читалище', freq: 'месечно', publisher: 'Съюз на народните читалища', issn: '0324-0975', department: 'периодика' }), 'обратно');

  // Нова партида + отказан запис → втори опит създава ВТОРА партида.
  await openTitle('Нередовен бюлетин');
  await h.clickButton('Инвентирай годишния комплект', volumeRow(Y1));
  await h.waitFor(() => h.$('#volF'), 'формата');
  await h.settle();
  const acqBefore = q('SELECT COUNT(*) AS n FROM acquisitions').n;
  h.type('#volF [name=acquisition_id]', '__new__');
  h.type('#volF [name=acq_from_source]', 'Български пощи — бюлетин');
  h.type('#volF [name=inv_number]', '1'); // зает номер → инвентирането ще бъде отказано
  let nn = h.toasts.length;
  await h.clickButton('Впиши в инвентарната книга', '#modal2 footer');
  await h.settle();
  let tt = h.toastsSince(nn);
  assert.ok(tt.some(t => t.msg === 'Партидата е заведена в КДБФ част 1.'), JSON.stringify(tt));
  assert.ok(tt.some(t => t.type === 'err' && /Инв\. № 1 вече е зает/.test(t.msg)), JSON.stringify(tt));
  assert.equal(q('SELECT COUNT(*) AS n FROM acquisitions').n, acqBefore + 1, 'партидата остава (документирано поведение)');
  assert.ok(h.$('#volF'), 'формата остава отворена');
  /* v2.4.61 (поправката на находка 22): дотук изборът оставаше на „__new__“ и
     точно затова второто натискане завеждаше ВТОРА партида. Сега вече
     заведената партида е ИЗБРАНАТА — както ако библиотекарят я беше избрал от
     списъка, — а полетата за нова партида са скрити. */
  const newAcqId = q("SELECT id FROM acquisitions WHERE from_source = 'Български пощи — бюлетин' ORDER BY id DESC").id;
  assert.equal(h.$('#volF [name=acquisition_id]').value, String(newAcqId), 'току-що заведената партида стои избрана');
  assert.equal(h.$('#volAcqNew').hidden, true, 'полетата за нова партида са скрити');
  h.type('#volF [name=inv_number]', String(q('SELECT next_inv_number FROM settings').next_inv_number));
  nn = h.toasts.length;
  await h.clickButton('Впиши в инвентарната книга', '#modal2 footer');
  await h.settle();
  tt = h.toastsSince(nn);
  assert.ok(tt.some(t => /е вписан в инвентарната книга под инв\. №/.test(t.msg)), JSON.stringify(tt));
  const acqAfter = q('SELECT COUNT(*) AS n FROM acquisitions').n;
  await soft('НАХОДКА 22: след отказано инвентиране повторното натискане със „нова партида“ завежда ВТОРА партида за същия абонамент', async () => {
    // saveVolume() създава партидата преди инвентирането; при отказ формата
    // остава с избор „__new__“ и попълнени полета, вторият опит вика
    // acquisitions.create наново — КДБФ Част № 1 получава две партиди
    // „Български пощи — бюлетин“, едната празна (обявен 1, инвентирани 0).
    assert.equal(acqAfter, acqBefore + 1, 'партиди: ' + JSON.stringify(all("SELECT no, year, from_source, total_count FROM acquisitions WHERE from_source LIKE '%бюлетин%'")));
  });
  const orphan = all(`SELECT a.id FROM acquisitions a WHERE a.from_source = 'Български пощи — бюлетин'
    AND NOT EXISTS (SELECT 1 FROM books b WHERE b.acquisition_id = a.id)`);
  for (const a of orphan) ok(await h.api.acquisitions.delete(a.id), 'чистене на празната партида');
  await h.clickButton('Затвори', '#modal footer');

  // Второто работно място инвентира „Наука, Y1“, докато тук формата стои отворена.
  ok(await h.api.periodicalIssues.add({ periodical_id: ids.nauka, issue_no: '4', date: Y1 + '-11-01', price: 8 }), 'Наука бр. 4/' + Y1);
  await openTitle('Наука');
  await h.clickButton('Инвентирай годишния комплект', volumeRow(Y1));
  await h.waitFor(() => h.$('#volF'), 'формата');
  await h.settle();
  const nextInv = q('SELECT next_inv_number FROM settings').next_inv_number;
  assert.equal(h.$('#volF [name=inv_number]').value, String(nextInv));
  const other = ok(await h.api.periodicalVolumes.register({ periodical_id: ids.nauka, year: Y1, inv_number: nextInv, price: 8 }), 'другото работно място');
  ids.volNaukaY1 = other.book_id;
  ids.invNaukaY1 = nextInv;
  const n2 = h.toasts.length;
  await h.clickButton('Впиши в инвентарната книга', '#modal2 footer');
  await h.settle();
  const ts = h.toastsSince(n2);
  assert.ok(ts.some(t => t.type === 'err' && new RegExp('Инв\\. № ' + nextInv + ' вече е зает|вече е инвентиран').test(t.msg)), JSON.stringify(ts));
  assert.ok(h.$('#volF'), 'формата остава отворена');
  assert.equal(q('SELECT COUNT(*) AS n FROM periodical_volumes WHERE periodical_id = ? AND year = ?', ids.nauka, Y1).n, 1);
  // Със свободен номер също се отказва — годината е вече инвентирана.
  h.type('#volF [name=inv_number]', String(nextInv + 1));
  const n3 = h.toasts.length;
  await h.clickButton('Впиши в инвентарната книга', '#modal2 footer');
  await h.settle();
  assert.ok(h.toastsSince(n3).some(t => t.type === 'err' && new RegExp('вече е инвентиран като инв\\. № ' + nextInv).test(t.msg)), JSON.stringify(h.toastsSince(n3)));
  assert.equal(q('SELECT COUNT(*) AS n FROM books').n, 5);
  h.window.closeModal2();
  await h.clickButton('Затвори', '#modal footer');
  noRendererErrors();
});

/* ==================================================================
   11. Изтриване на заглавие: с броеве, с комплекти, без нищо; през бутона
   ================================================================== */
test('11. изтриване на издание — отказ при броеве, отказ при инвентирани комплекти (и след изтрити броеве), успех при празен картон', async () => {
  await openTitle('Читалище');
  h.hooks.confirmAnswer = true;
  let n = h.toasts.length;
  await h.clickButton('Изтрий изданието', '#modal footer');
  assert.match(h.hooks.confirms[h.hooks.confirms.length - 1], /Изтриване на периодичното издание/);
  assert.ok(h.toastsSince(n).some(t => t.type === 'err' && /има вписани броеве и не може да бъде изтрито/.test(t.msg)), JSON.stringify(h.toastsSince(n)));
  assert.ok(h.modalOpen(), 'картонът остава');
  await h.clickButton('Затвори', '#modal footer');
  assert.ok(q('SELECT 1 FROM periodicals WHERE id = ?', ids.chit));

  // „Наука“: махаме всички броеве → остават само комплектите → пак отказ, с инв. номерата.
  for (const i of all('SELECT id FROM periodical_issues WHERE periodical_id = ?', ids.nauka)) ok(await h.api.periodicalIssues.delete(i.id), 'брой');
  const r = await h.api.periodicals.delete(ids.nauka);
  assert.equal(r.ok, false);
  assert.match(r.error, rx('има 2 инвентирани годишни комплекта във фонда (инв. № ' + ids.invNaukaY1 + ' за ' + Y1 + ' г., 40 за ' + Y + ' г.)'));
  assert.match(r.error, /акт за отчисляване \(чл\. 35\)/);
  assert.equal(q('SELECT COUNT(*) AS n FROM books WHERE series = ?', 'Наука').n, 2, 'документите са във фонда');
  // Годините остават в кардекса и без броеве.
  const p = ok(await h.api.periodicals.get(ids.nauka), 'get');
  assert.deepEqual(p.volumes.map(v => [String(v.year), v.issue_count, v.inv_number]), [[Y, 0, 40], [Y1, 0, ids.invNaukaY1]]);
  // Празен картон → изтрива се, със следа.
  const tmp = ok(await h.api.periodicals.create({ title: 'Временен', freq: 'месечно', issn: '1234-5679' }), 'временен');
  await openTitle('Временен');
  n = h.toasts.length;
  await h.clickButton('Изтрий изданието', '#modal footer');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Изтрито.'), JSON.stringify(h.toastsSince(n)));
  assert.equal(h.modalOpen(), false);
  assert.equal(q('SELECT COUNT(*) AS n FROM periodicals WHERE id = ?', tmp).n, 0);
  assert.equal(lastAudit('Изтрито периодично издание').detail, '„Временен“, ISSN 1234-5679, месечно — без вписани броеве и без инвентирани годишни комплекти');
  assert.ok(!rowOf('Временен'));
  // Изтриване на несъществуващо (второ работно място).
  const gone = await h.api.periodicals.delete(tmp);
  assert.equal(gone.ok, false);
  noRendererErrors();
});

/* ==================================================================
   12. Заемане на подвързан комплект от гишето → Дневник, Раздел Б „Периодични издания“
   ================================================================== */
test('12. заемане на комплекта през „Заемане и връщане“; предложението за Дневника брои „Периодични издания“', async () => {
  ids.reader = ok(await h.api.readers.create({ name: 'Иван Читателов', card_no: '1001', gdpr_consent: true }), 'читател');
  await selectReaderAtDesk('1001');
  let n = h.toasts.length;
  await h.scan('#bScan', '1');
  const t = h.toastsSince(n).find(x => /Заемане: инв/.test(x.msg));
  assert.ok(t, 'няма известие за заемане: ' + JSON.stringify(h.toastsSince(n)) + ' / ' + h.text('#outLog'));
  assert.match(t.msg, /Заемане: инв\. № 1 до /);
  assert.match(h.text('#outLog'), rx('Читалище, ' + Y), 'дневникът на гишето показва заглавието на комплекта');
  const loan = q('SELECT * FROM loans WHERE book_id = ? AND date_in IS NULL', ids.volChit);
  assert.ok(loan, 'заемането е записано');
  ids.loan = loan.id;
  const ev = q("SELECT * FROM events WHERE kind = 'заемане' AND book_id = ?", ids.volChit);
  assert.equal(ev.book_category, 'продължаващо издание', 'събитието носи вида на документа');
  assert.equal(ev.date, T);
  // Кардексът и каталогът знаят, че е зает.
  const b = ok(await h.api.books.get(ids.volChit), 'get');
  assert.equal(b.available, 0);
  const out = path.join(os.tmpdir(), 'katalog-periodika-loan-' + process.pid + '.json');
  h.dialogs.savePath = out;
  ok(await h.api.catalog.export(), 'каталог');
  const it = JSON.parse(fs.readFileSync(out, 'utf8')).items.find(x => x.inv === 1);
  assert.equal(it.av, 0, 'в онлайн каталога комплектът вече не е „налична“');

  // Дневникът: „⚡ Предложи от регистрите“ → Раздел Б, по вид: Периодични издания = 1, Книги = 0.
  const sug = ok(await h.api.dnevnik.suggest({ date: T }), 'предложение');
  assert.equal(sug.suggestions.b_type_period, 1);
  assert.equal(sug.suggestions.b_type_books, undefined);
  assert.equal(sug.suggestions.b_lang_other, 1, 'комплектът няма език → „други“');
  /* v2.4.61 (поправката на находка 13): заетата периодика вече не влиза в
     `unclassified` („книги без УДК, допълнете ги ръчно“), а се брои отделно —
     тя е напълно отчетена по ВИД и по съдържание не се класира по природа. */
  assert.equal(sug.unclassified, 0, 'комплектът не е „книга без УДК“');
  assert.equal(sug.periodicalsByType, 1, 'броят се отделно — по вид, не по съдържание');
  await h.go('dnevnik');
  await h.window.dnevnikDayForm(T);
  await h.waitFor(() => h.$('#dnvF'), 'формата за деня');
  await h.settle();
  await h.clickButton('⚡ Предложи от регистрите', '#dnvF');
  await h.settle();
  assert.equal(h.$('#dnvF [name=b_type_period]').value, '1');
  assert.equal(h.$('#dnvF [name=b_type_books]').value, '0', 'книги — 0');
  /* Дотук подсказката гласеше „1 заемане е на книга без УДК … допълнете го
     ръчно“ — за годишен комплект на списание. Обработчикът вече не подава това
     заемане като некласирано, затова изречението изчезва. Собственият текст за
     периодиката („N заемания са на периодични издания — броят се по вид“) е в
     src/views/dnevnik.js, който в този кръг се пипа от друг: подадено е в
     доклада заедно с новото поле `periodicalsByType`. */
  assert.doesNotMatch(h.text('#dnvSugHint'), /без УДК/);
  await soft('НАХОДКА 13: подсказката на Дневника нарича годишния комплект „книга без УДК“', async () => {
    // Комплектът на списание няма УДК по природа (периодиката не се
    // класира по съдържание в Раздел Б — там се брои по вид). Текстът
    // „заемане е на книга без УДК … допълнете го ръчно“ подвежда
    // библиотекарката да търси УДК за вестник.
    assert.doesNotMatch(h.text('#dnvSugHint'), /на книга без УДК/);
  });
  await h.clickButton('Запиши деня', '#modal footer');
  await h.settle();
  assert.equal(q('SELECT b_type_period FROM dnevnik_days WHERE date = ?', T).b_type_period, 1);
  const ab = ok(await h.api.reports.run({ id: 'annual_ab', year: Y }), 'Раздел А/Б');
  assert.equal(ab.totals.b_type_period, 1);
  assert.equal(ab.totals.b_total_type, 1);

  /* Отчисляване на ЗАЕТ комплект — актът трябва да откаже.
     НАХОДКА 14 (актът приема зает документ) НЕ се твърди тук: тя не е дефект на
     периодиката, а на handlers/deaccession-acts.js, и се поправя от прегледа на
     отчисляването в същия кръг — там ѝ е и регресионният тест. Стъпката остава,
     защото сценарият продължава с този комплект: ако актът мине (както дотук),
     той се анулира веднага отдолу и заемането се връща нормално. */
  const actLent = await h.api.deaccessionActs.create({ act: ACT(), bookIds: [ids.volChit] });
  if (actLent.ok) {
    ok(await h.api.deaccessionActs.revoke(actLent.data, { reason: 'сгрешен документ', by: 'Мария Иванова' }), 'анулиране');
  }
  // Връщане през гишето.
  await h.go('circ');
  await h.clickButton('Връщане', '#view');
  await h.waitFor(() => h.$('#inScan'), 'полето за връщане');
  n = h.toasts.length;
  await h.scan('#inScan', '1');
  assert.ok(q('SELECT date_in FROM loans WHERE id = ?', ids.loan).date_in, 'върнат: ' + JSON.stringify(h.toastsSince(n)));
  assert.equal(ok(await h.api.books.get(ids.volChit), 'get').available, 1);
  noRendererErrors();
});

/* ==================================================================
   13. Отчисляване на комплекта с акт → КДБФ Част № 3, кардексът, каталогът; анулиране
   ================================================================== */
test('13. отчисляване на годишния комплект с акт; кардексът, КДБФ и каталогът; анулиране връща всичко', async () => {
  const before = ok(await h.api.kdbf.report(Y), 'КДБФ преди');
  const nextNo = ok(await h.api.deaccessionActs.nextNo(Y), 'следващ №');
  const actId = ok(await h.api.deaccessionActs.create({ act: ACT({ no: nextNo }), bookIds: [ids.volChit] }), 'акт');
  const b = q('SELECT status, deaccession_date FROM books WHERE id = ?', ids.volChit);
  assert.equal(b.status, 'отчислен');
  assert.equal(b.deaccession_date, T);
  const item = q('SELECT * FROM deaccession_items WHERE act_id = ?', actId);
  assert.equal(item.title, 'Читалище, ' + Y);
  assert.equal(item.category, 'продължаващо издание');
  assert.equal(item.volume, 'годишен комплект');
  assert.equal(item.price, 7);
  assert.equal(item.quantity == null ? 1 : item.quantity, 1);
  const k = ok(await h.api.kdbf.report(Y), 'КДБФ след');
  assert.equal(k.deaccYear.n, before.deaccYear.n + 1);
  assert.equal(k.deaccYear.v, before.deaccYear.v + 7);
  assert.equal(k.stockEnd.n, before.stockEnd.n - 1);
  const alive = q("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен'").n;
  assert.equal(k.byKind.find(x => x.kind === 'продължаващо издание').n, alive, 'останалите комплекти са във фонда');
  const s = ok(await h.api.stats.report(Y), 'отчет');
  assert.equal(s.deaccessionedCount, 1);
  assert.equal(s.deaccessionedValue, 7);
  // Кардексът: годината носи знак „отчислен“; списъкът: „Инвентирани комплекти“.
  await openTitle('Читалище');
  assert.match(h.text(volumeRow(Y)), /инв\. № 1 .*отчислен/);
  assert.ok(!volumeRow(Y).querySelector('button'), 'няма бутон за повторно инвентиране');
  await h.clickButton('Затвори', '#modal footer');
  await h.settle();
  const lst = ok(await h.api.periodicals.list(), 'list').find(p => p.id === ids.chit);
  await soft('НАХОДКА 15: „Инвентирани комплекти“ брои и ОТЧИСЛЕНИЯ комплект — колоната обещава „влиза в КДБФ и отчета за фонда“', async () => {
    // periodicals:list: volume_count = COUNT(volumes JOIN books) без условие за
    // status; подсказката на нулата гласи „това издание не влиза в КДБФ и в
    // отчета за фонда“, тоест колоната се чете като „във фонда“. Издание с
    // единствен отчислен комплект показва 1.
    assert.equal(lst.volume_count, 0, 'отчисленият комплект се брои като инвентиран: ' + lst.volume_count);
  });
  // Онлайн каталог: отчисленият вече не се публикува.
  const out = path.join(os.tmpdir(), 'katalog-periodika-deacc-' + process.pid + '.json');
  h.dialogs.savePath = out;
  ok(await h.api.catalog.export(), 'каталог');
  assert.ok(!JSON.parse(fs.readFileSync(out, 'utf8')).items.some(x => x.inv === 1), 'отчисленият комплект не е в katalog.json');
  // Повторно инвентиране на същата година след отчисляване (заместващ комплект — дарение).
  const again = await h.api.periodicalVolumes.register({ periodical_id: ids.chit, year: Y, price: 0 });
  await soft('НАХОДКА 16: след отчисляване годината не може да се инвентира наново, а съобщението праща към „отчислете го с акт“ — той вече е отчислен', async () => {
    // periodicalVolumes:register гледа само prev.book_id != null. Заместващ
    // (дарен) комплект за същата година няма как да влезе във фонда; текстът
    // на отказа е верен за наличен комплект и объркващ за отчислен.
    assert.equal(again.ok, true, 'очаква се да може да се впише нов документ за годината (старият е отчислен): ' + again.error);
  });
  if (again.ok) { await h.api.books.delete(again.data.book_id); await h.api.books.delete(again.data.book_id); }
  // Изтриване на отчисления ред — отказ по чл. 39.
  const del = await h.api.books.delete(ids.volChit);
  assert.equal(del.ok, false); assert.match(del.error, /чл\. 39/);
  // Анулиране на акта → комплектът се връща.
  ok(await h.api.deaccessionActs.revoke(actId, { reason: 'сгрешен документ', by: 'Мария Иванова' }), 'анулиране');
  assert.equal(q('SELECT status FROM books WHERE id = ?', ids.volChit).status, 'наличен');
  const k2 = ok(await h.api.kdbf.report(Y), 'КДБФ след анулиране');
  assert.equal(k2.deaccYear.n, before.deaccYear.n);
  assert.equal(k2.stockEnd.n, before.stockEnd.n);
  assert.equal(ok(await h.api.stats.report(Y), 'отчет').deaccessionedCount, 0);
  await openTitle('Читалище');
  assert.doesNotMatch(h.text(volumeRow(Y)), /отчислен/);
  await h.clickButton('Затвори', '#modal footer');
  noRendererErrors();
});

/* ==================================================================
   14. Разпечатки за периодиката: списък на абонаментите / кардекс
   ================================================================== */
test('14. разпечатки — периодиката няма нито един печатен документ (абонаменти, кардекс)', async () => {
  await h.go('periodika');
  const btns = Array.from(h.document.querySelectorAll('#view button')).map(b => b.textContent.trim());
  await soft('НАХОДКА 17: екранът „Периодика“ няма „Печат / PDF“ — нито списък на абонаментите, нито регистър на постъпилите броеве', async () => {
    // Всички останали регистри (КДБФ, инвентарна книга, партиди, актове,
    // справки) имат разпечатка. Абонаментният списък за годината (заглавие,
    // ISSN, периодичност, получени/очаквани броеве, сума) е това, което се
    // подава към счетоводството при абониране и към проверката за периодиката.
    assert.ok(btns.some(t => /Печат|PDF/.test(t)), 'бутони: ' + btns.join(' | '));
  });
  await openTitle('Труд');
  const mb = Array.from(h.document.querySelectorAll('#modal button')).map(b => b.textContent.trim());
  await soft('НАХОДКА 18: кардексът (картонът на изданието) не се печата', async () => {
    assert.ok(mb.some(t => /Печат|PDF/.test(t)), 'бутони в картона: ' + mb.filter(t => t !== '×').join(' | '));
  });
  await h.clickButton('Затвори', '#modal footer');
  noRendererErrors();
});

/* ==================================================================
   15. Преименуване на категорията „продължаващо издание“ → Дневникът и инвентирането се разминават
   ================================================================== */
test('15. преименуван вид „продължаващо издание“ — Дневникът брои комплекта като книга, инвентирането създава втори вид', async () => {
  const cat = q("SELECT id FROM categories WHERE name = 'продължаващо издание'");
  ok(await h.api.categories.update({ id: cat.id, name: 'периодично издание' }), 'преименуване');
  const nDocs = q('SELECT COUNT(*) AS n FROM books WHERE category_id = ?', cat.id).n;
  assert.match(lastAudit('Преименуван вид документ').detail, rx('„продължаващо издание“ → „периодично издание“ (' + nDocs + ' документа)'));
  // Ново заемане на „Наука, Y“ (инв. № 40) → събитието носи новото име.
  ok(await h.api.loans.checkoutByCode({ reader_id: ids.reader, code: '40', date_out: T }), 'заемане на инв. № 40');
  const sug = ok(await h.api.dnevnik.suggest({ date: T }), 'предложение');
  await soft('НАХОДКА 19: след преименуване на вида заемането на комплект се предлага в Дневника като „Книги“', async () => {
    // DNEVNIK_TYPE_MAP в handlers/dnevnik.js е закачена за буквалното име
    // „продължаващо издание“; categories:update позволява преименуване без
    // предупреждение, а резервната стойност е b_type_books.
    assert.equal(sug.suggestions.b_type_period, 2, 'очакват се 2 периодични (вчерашното + днешното): ' + JSON.stringify(sug.suggestions));
  });
  // Ново инвентиране → втора категория със старото име.
  ok(await h.api.periodicalIssues.add({ periodical_id: ids.nered, issue_no: '2', date: Y + '-05-05', price: 0 }), 'брой');
  const rv = ok(await h.api.periodicalVolumes.register({ periodical_id: ids.nered, year: Y, price: 0 }), 'бюлетин ' + Y);
  const cats = all("SELECT id, name FROM categories WHERE name IN ('продължаващо издание', 'периодично издание') ORDER BY id");
  await soft('НАХОДКА 20: инвентирането след преименуване създава наново „продължаващо издание“ — фондът излиза с два вида за периодика', async () => {
    assert.equal(cats.length, 1, 'категории: ' + JSON.stringify(cats));
  });
  const newCat = q('SELECT c.name FROM books b JOIN categories c ON c.id = b.category_id WHERE b.id = ?', rv.book_id).name;
  if (cats.length === 2) {
    assert.equal(newCat, 'продължаващо издание');
    const k = ok(await h.api.kdbf.report(Y), 'КДБФ');
    assert.ok(k.byKind.some(x => x.kind === 'периодично издание') && k.byKind.some(x => x.kind === 'продължаващо издание'), JSON.stringify(k.byKind));
  }
  // Връщане на заемането; обратно преименуване (ако е възможно — UNIQUE).
  const l = q('SELECT id FROM loans WHERE book_id = ? AND date_in IS NULL', ids.volNauka);
  ok(await h.api.loans.return({ id: l.id, date_in: T }), 'връщане');
  if (cats.length === 2) {
    h.db.prepare('UPDATE books SET category_id = ? WHERE category_id = ?').run(cats[1].id, cats[0].id);
    ok(await h.api.categories.delete(cats[0].id), 'махаме преименуваната');
  } else {
    ok(await h.api.categories.update({ id: cat.id, name: 'продължаващо издание' }), 'обратно');
  }
  assert.equal(all("SELECT id FROM categories WHERE name = 'продължаващо издание'").length, 1);
  noRendererErrors();
});

/* ==================================================================
   16. Годишен отчет и КДБФ за миналата година — комплектите не пренареждат Y1
   ================================================================== */
test('16. КДБФ за ' + Y1 + ' и ' + Y + ' — комплектът за ' + Y1 + ', вписан през ' + Y + ', е постъпление на ' + Y, async () => {
  const kPrev = ok(await h.api.kdbf.report(Y1), 'КДБФ ' + Y1);
  const kCur = ok(await h.api.kdbf.report(Y), 'КДБФ ' + Y);
  assert.equal(kPrev.acquiredYear.n, 0, 'нищо не е вписано през ' + Y1);
  assert.equal(kPrev.stockEnd.n, 0);
  const n = q("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен'").n;
  assert.equal(kCur.stockEnd.n, n);
  assert.equal(kCur.acquiredYear.n, n, 'всички комплекти са постъпления на ' + Y);
  assert.equal(kCur.stockEnd.n - kCur.acquiredYear.n + kCur.deaccYear.n, kPrev.stockEnd.n, 'веригата между годините');
  const s = ok(await h.api.stats.report(Y), 'отчет');
  assert.equal(s.fundCount, n);
  assert.equal(s.fundByCategory.find(x => x[0] === 'продължаващо издание')[1], n);
  assert.equal(s.loansCount, 2, 'две заемания на периодика през годината');
  assert.deepEqual(s.topLoans.map(x => x.title).sort(), ['Наука, ' + Y, 'Читалище, ' + Y].sort(), 'най-търсени — двата комплекта');
  const chk = ok(await h.api.fund.checkLogged(Y), 'съгласуване');
  assert.ok(chk.findings.every(f => f.level === 'бележка'), JSON.stringify(chk.findings.map(f => [f.key, f.level, f.title])));
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
