'use strict';
/* ПОПРАВКИ ОТ КРЪГ 44 (v2.4.69) — КРАЕЗНАНИЕ, ПЕРИОДИКА, ДНЕВНИК, ОТЧЕТИ.
 * ===========================================================================
 * По един (или повече) тест на находка. Всеки твърди онова, което
 * библиотекарката ВИЖДА — текст на екрана, ред в базата, число на
 * разпечатката — и пада, ако поправката бъде върната (проверено поотделно
 * върху копие на дървото):
 *
 *   Л1   „8“, „7,5“, „7.30“ в „Часове“ на Дневника ставаха 0:00 или нищо;
 *   Л2   брой от 31.12, получен на 03.01, влизаше в комплекта за новата година;
 *   Л3   „⚡ Предложи“ даваше „Деца до 14 г.“ по-голямо от „В заемна за дома“;
 *   Л4   „Движение на фонда“ показваше друго число от КДБФ Част № 1, без дума;
 *   Л5   подробната форма и „⚡“ бяха достъпни само за ДНЕШНИЯ ден;
 *   Л6   картонът не казваше кой сочи към него (links:backlinks — без екран);
 *   Л7   снимките пътуваха изцяло при всяко търсене в летописа и персоналиите;
 *   Л8   „Махни“/„Смени…“ снимка — без въпрос;
 *   Л9   персоналия само с година („1890“, „ок. 1890“) не можеше да се впише;
 *   Л10  съименниците излизаха еднакви в „Намерени“ при свързване;
 *   Л11  указателят и летописът не намираха показаното („инв. № 900“,
 *        „27.05.2025“, „ок. 1930“, „1972“), а „бр. 2“ връщаше и бр. 21;
 *   Л12  дублирано име с двоен интервал, без запетая или при преименуване;
 *   Л13  изтриване на несъществуваща персоналия/статия се отчиташе за успех;
 *   Е10  Дневникът за 31-дневен месец — 4 листа; годишният отчет — 4 листа
 *        с по един ред;
 *   П4   (чужда молба) инвентарната книга не носеше УДК и авторски знак, та
 *        колоната „Сигнатура“ беше празна;
 *   Г11  (чужда молба) намерената книга в отчета — решение, заковано тук.
 *
 * Всичко минава през ИСТИНСКИЯ харнес (bootApp → истинският main.js +
 * истинските екрани в jsdom). Броят листове на PDF (Е10) се мери в истински
 * Chromium, когато такъв има на машината (иначе тази една проба се прескача
 * с обяснение, а структурната проба в jsdom остава).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('./helpers/e2e-app');

let h;
const T = E.today();
const Y = T.slice(0, 4);
const Y1 = String(Number(Y) - 1);
const M = T.slice(0, 7); // текущият месец — на него се отваря Дневникът

const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const bad = (r, what) => { assert.ok(r && r.ok === false, what + ' — прието е, а не биваше'); return r.error; };
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

test.before(async () => {
  h = await E.bootApp();
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  const st = (await h.api.settings.get()).data;
  await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека „Изпитание“', place: 'с. Яворец',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова'
  }));
  await h.window.loadSettingsCache();
});
test.after(() => { if (h) h.stop(); });

/* ================================================================= Л1 ==== */
const hoursCell = (date) => `.dnvTable input[data-date="${date}"][data-field="a_hours"]`;
const aHours = (date) => (q('SELECT a_hours FROM dnevnik_days WHERE date = ?', date) || {}).a_hours;
async function typeCell(sel, v) { h.type(sel, v); await h.settle(); }

test('Л1: „8“, „7,5“ и „7.30“ в „Часове“ влизат в базата като 8:00, 7:30 и 7:30', async () => {
  await h.go('dnevnik');
  const d1 = M + '-01', d2 = M + '-02', d3 = M + '-03';
  await typeCell(hoursCell(d1), '8');
  await typeCell(hoursCell(d2), '7,5');
  await typeCell(hoursCell(d3), '7.30');
  assert.equal(aHours(d1), 480, '„8“ = 8:00 — дотук в базата не влизаше нищо');
  assert.equal(aHours(d2), 450, '„7,5“ = 7:30');
  assert.equal(aHours(d3), 450, '„7.30“ = 7:30');
  assert.equal(h.$(hoursCell(d1)).value, '8:00', 'клетката показва записаното, в ч:мм');
  assert.equal(h.$(hoursCell(d3)).value, '7:30');
});

test('Л1: „6“ върху записани 8:00 записва 6:00, а не 0:00; „осем“ се отказва и клетката се връща', async () => {
  await h.go('dnevnik');
  const d = M + '-04';
  await typeCell(hoursCell(d), '8:00');
  assert.equal(aHours(d), 480);
  await typeCell(hoursCell(d), '6');
  assert.equal(aHours(d), 360, 'дотук „6“ върху 8:00 записваше 0:00');
  const n = h.toasts.length;
  await typeCell(hoursCell(d), 'осем');
  const t = h.toastsSince(n).find(x => x.type === 'err');
  assert.ok(t, 'неразпознатото се казва');
  assert.match(t.msg, /„осем“ не е разпознато като часове/);
  assert.match(t.msg, /„8“.*„7:30“.*„7,5“/, 'известието казва как се пише');
  assert.equal(aHours(d), 360, 'базата не е пипната');
  assert.equal(h.$(hoursCell(d)).value, '6:00', 'клетката е върната на записаното');
  const n2 = h.toasts.length;
  await typeCell(hoursCell(d), '7,30');
  assert.ok(h.toastsSince(n2).some(x => x.type === 'err' && /7,30/.test(x.msg)), '„7,30“ е двусмислено — отказ');
  assert.equal(aHours(d), 360);
});

test('Л1: формата „Подробно за деня“ — „5“ е 5:00, а „пет“ не записва деня и го казва', async () => {
  await h.go('dnevnik');
  const d = M + '-05';
  await h.window.dnevnikDayForm(d);
  await h.waitFor(() => h.$('#dnvF'), 'формата');
  h.type('#dnvF [name=a_hours_hhmm]', 'пет');
  let n = h.toasts.length;
  await h.clickButton('Запиши деня', '#modal');
  const refusal = h.toastsSince(n).find(x => x.type === 'err');
  assert.ok(refusal && /Денят НЕ е записан/.test(refusal.msg), JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT COUNT(*) AS n FROM dnevnik_days WHERE date = ?', d).n, 0, 'нищо не е записано');
  h.type('#dnvF [name=a_hours_hhmm]', '5');
  n = h.toasts.length;
  await h.clickButton('Запиши деня', '#modal');
  assert.ok(h.toastsSince(n).some(x => x.msg === 'Денят е записан.'));
  assert.equal(aHours(d), 300, 'дотук „5“ ставаше 0:00, а известието казваше „Денят е записан.“');
});

test('Л1: обработчикът отказва повече от 24 часа за един ден', async () => {
  const err = bad(await h.api.dnevnik.saveDay({ date: M + '-06', a_hours: 1500 }), '1500 мин.');
  assert.match(err, /повече от 24 часа/);
});

/* ================================================================= Л2 ==== */
test('Л2: брой от края на декември, получен през януари, отива в комплекта за миналата година — от формата', async () => {
  const pid = ok(await h.api.periodicals.create({ title: 'Ежедневник Л2', freq: 'ежедневно' }), 'издание');
  await h.go('periodika');
  await h.window.openPeriodical(pid);
  await h.waitFor(() => h.$('#issueF'), 'кардексът');
  await h.settle();
  const sel = h.$('#issueF [name=volume_year]');
  assert.ok(sel, 'формата за брой има избор „Годишен комплект“');
  // Датата се сменя на 03.01 — изборът следва годината ѝ, миналата е на една стрелка.
  h.type('#issueF [name=date]', Y + '-01-03');
  assert.equal(sel.value, Y, 'по подразбиране — годината на датата');
  assert.ok(Array.from(sel.options).some(o => o.value === Y1), 'миналата година е в избора');
  h.type('#issueF [name=volume_year]', Y1);
  h.type('#issueF [name=issue_no]', '250');
  h.type('#issueF [name=price]', '1,20');
  await h.clickButton('Добави брой', '#modal');
  await h.settle();
  const row = q('SELECT date, volume_year FROM periodical_issues WHERE periodical_id = ? AND issue_no = ?', pid, '250');
  assert.equal(row.date, Y + '-01-03', 'датата на постъпване остава истинската');
  assert.equal(String(row.volume_year), Y1, 'годината на комплекта — избраната');
  // Обикновеният брой без пипане на избора — в годината на датата.
  await h.window.openPeriodical(pid, Y);
  await h.waitFor(() => h.$('#issueF'), 'кардексът');
  h.type('#issueF [name=date]', Y + '-01-04');
  h.type('#issueF [name=issue_no]', '1');
  h.type('#issueF [name=price]', '1,30');
  await h.clickButton('Добави брой', '#modal');
  await h.settle();
  assert.equal(String(q('SELECT volume_year FROM periodical_issues WHERE periodical_id = ? AND issue_no = ?', pid, '1').volume_year), Y);

  // Годишните комплекти в картона — по годината на комплекта.
  const p = ok(await h.api.periodicals.get(pid, { year: Y1 }), 'картон');
  const v1 = p.volumes.find(v => String(v.year) === Y1), v0 = p.volumes.find(v => String(v.year) === Y);
  assert.equal(v1.issue_count, 1, 'бр. 250 е в комплекта за ' + Y1);
  assert.equal(Math.round(v1.issue_sum * 100), 120, 'заедно с цената си');
  assert.equal(v0.issue_count, 1, 'в комплекта за ' + Y + ' е само бр. 1');
  assert.deepEqual(p.issues.map(i => i.issue_no), ['250'], 'кардексът за ' + Y1 + ' показва бр. 250');
  // Инвентирането на комплекта взима цената по годината на комплекта.
  const reg = ok(await h.api.periodicalVolumes.register({ periodical_id: pid, year: Y1, register_date: T }), 'инвентиране ' + Y1);
  assert.equal(reg.issue_count, 1);
  assert.equal(Math.round(reg.price * 100), 120, 'цената на комплекта в инвентарната книга включва бр. 250');
});

test('Л2: година на комплекта на повече от година от датата се отказва', async () => {
  const pid = ok(await h.api.periodicals.create({ title: 'Седмичник Л2', freq: 'седмично' }), 'издание');
  const err = bad(await h.api.periodicalIssues.add({ periodical_id: pid, issue_no: '5', date: Y + '-02-01', volume_year: String(Number(Y) - 3) }), 'три години назад');
  assert.match(err, /не може да е от комплекта/);
});

/* ================================================================= Л3 ==== */
function ev(date, kind, readerId, cat) {
  h.db.prepare(`INSERT INTO events (date, kind, reader_id, reader_category, book_category, book_language, book_udk)
    VALUES (?, ?, ?, ?, 'книга', 'български', '821.163.2-31')`).run(date, kind, readerId, cat);
}
test('Л3: „В заемна за дома“ = читателите със заемане или връщане + посещенията по домовете; децата никога не са повече', async () => {
  const d = Y + '-02-10';
  ev(d, 'заемане', 9101, 'дете до 14 г.');
  ev(d, 'заемане', 9102, 'възрастен');
  ev(d, 'връщане', 9103, 'възрастен');          // дошъл само да върне — пак е посещение
  ev(d, 'заемане', 9102, 'възрастен');          // същият читател — веднъж
  h.db.prepare("INSERT INTO events (date, kind, reader_id, reader_category) VALUES (?, 'дома', 9104, 'пенсионер')").run(d);
  const r = ok(await h.api.dnevnik.suggest({ date: d }), 'предложение');
  assert.equal(r.suggestions.a_visit_home, 4, '3 читатели на гишето + 1 посещение по домовете (дотук: 1)');
  assert.equal(r.suggestions.a_visit_child, 1);
  assert.equal(r.sectionA.visitHomeDesk, 3);
  assert.equal(r.sectionA.visitHomeHousebound, 1);

  // Два деца на гишето, без надомно — дотук „дома“ 0, „деца“ 2.
  const d2 = Y + '-02-11';
  ev(d2, 'заемане', 9201, 'дете до 14 г.');
  ev(d2, 'заемане', 9202, 'дете до 14 г.');
  const r2 = ok(await h.api.dnevnik.suggest({ date: d2 }), 'предложение 2');
  assert.ok((r2.suggestions.a_visit_child || 0) <= (r2.suggestions.a_visit_home || 0),
    'подмножеството не надхвърля множеството: ' + JSON.stringify(r2.suggestions));
  assert.equal(r2.suggestions.a_visit_home, 2);

  // На екрана: ⚡ попълва и назовава от какво е сглобено числото.
  await h.go('dnevnik');
  await h.window.dnevnikDayForm(d);
  await h.waitFor(() => h.$('#dnvF'), 'формата');
  await h.clickButton('⚡ Предложи от регистрите', '#modal');
  await h.settle();
  assert.equal(h.$('#dnvF [name=a_visit_home]').value, '4');
  assert.match(h.text('#dnvSugHint'), /„В заемна за дома“ = 3 читатели на гишето \(заемане или връщане\) \+ 1 посещение по домовете/);
  h.window.closeModal(); await h.settle();
});

/* ================================================================= Л4 ==== */
test('Л4: „Движение на фонда“ показва и числото на КДБФ Част № 1, назовано, и казва разликата', async () => {
  const acq = h.db.prepare(`INSERT INTO acquisitions (no, year, date, how, from_source, total_count, sum)
    VALUES (901, ?, ?, 'закупуване', 'Книжарница', 3, 100)`).run(Y, Y + '-03-01').lastInsertRowid;
  for (let i = 0; i < 3; i++) {
    h.db.prepare(`INSERT INTO books (inv_number, title, price, acquisition_id, register_date, status)
      VALUES (?, ?, 40, ?, ?, 'наличен')`).run(77001 + i, 'Книга Л4 ' + i, acq, Y + '-03-01');
  }
  const mv = ok(await h.api.reports.run({ id: 'fund_movement', year: Y }), 'движение');
  const kd = ok(await h.api.kdbf.report(Y), 'КДБФ');
  assert.equal(Math.round(mv.acquiredRegisteredValue * 100), Math.round(kd.part1Sum.v * 100),
    'вписаната стойност в справката = „ОБЩО“ на Част № 1');
  assert.equal(mv.acquiredRegisteredCount, kd.part1Sum.n);
  assert.ok(Math.round(mv.acquiredValue * 100) !== Math.round(kd.part1Sum.v * 100), 'двете законно се различават тук');

  await h.go('reports');
  h.type('#repSel', 'fund_movement');
  await h.settle();
  await h.waitFor(() => /Вписана стойност/.test(h.text('#repBody')), 'справката');
  const body = h.text('#repBody');
  assert.match(body, /Вписана стойност \(= КДБФ Ч\. 1\)/, 'колоната носи името на Част № 1');
  assert.ok(body.includes(h.window.eval('mny(' + kd.part1Sum.v + ')')), 'числото на Част № 1 стои на екрана: ' + body);
  assert.match(body, /се разминават/, 'разликата е казана с думи');
  const hint = h.text('#view .note');
  assert.doesNotMatch(hint, /\(както Част № 1 на КДБФ\)/, 'подсказката вече не твърди, че числото е като в Част № 1');
  // И на хартия.
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  assert.match(flat(h.printed()), /= КДБФ Част № 1/);
  h.window.ppClose && h.window.ppClose();
});

/* ================================================================= Л5 ==== */
test('Л5: числото на деня в Дневника отваря подробната форма и „⚡“ за ТОЗИ ден', async () => {
  await h.go('dnevnik');
  const d = M + '-01';
  const btn = h.$(`.dnvTable tbody tr:first-child td.dnvDay button`);
  assert.ok(btn, 'числото на деня е бутон');
  await h.click(btn);
  await h.waitFor(() => h.$('#dnvF'), 'формата за деня');
  assert.match(h.text('#modal'), new RegExp('Дневник — ' + E.bgDate(d).replace(/\./g, '\\.')), 'формата е за ' + d + ', не за днес');
  assert.ok(h.button('⚡ Предложи от регистрите', '#modal'), '„⚡“ е там');
  h.window.closeModal(); await h.settle();
});

/* ============================================================ Л6, Л10 ==== */
test('Л6: картонът на персоналия показва кой сочи към нея; към книгата сочат и статиите с източник нея', async () => {
  const pid = ok(await h.api.persons.create({ name: 'Обратнов, Петър', activity: 'учител' }), 'персоналия');
  const cid = ok(await h.api.chronicle.create({ year: '1972', title: 'Юбилей Л6' }), 'летопис');
  ok(await h.api.links.add({ fromKind: 'летопис', fromId: cid, toKind: 'персона', toId: pid }), 'връзка летопис → персона');
  await h.go('persons');
  await h.window.personView(pid);
  await h.waitFor(() => h.$('#backlinks'), 'панелът „Сочат към този запис“');
  assert.match(h.text('#backlinks'), /1972 — Юбилей Л6/, 'дотук картонът казваше само „Няма свързани материали“');
  h.window.closeModal(); await h.settle();
  // И в обратната посока: картонът на летописния запис казва коя персоналия сочи към него.
  ok(await h.api.links.add({ fromKind: 'персона', fromId: pid, toKind: 'летопис', toId: cid }), 'връзка персона → летопис');
  await h.go('chronicle');
  await h.window.chronicleView(cid);
  await h.waitFor(() => h.$('#modal #backlinks'), 'панелът „Сочат към този запис“ в летописа');
  assert.match(h.text('#modal #backlinks'), /Обратнов, Петър/, 'летописният запис не казва, че персоналията сочи към него');
  h.window.closeModal(); await h.settle();

  const bid = ok(await h.api.books.create({ inv_number: 77100, register_date: T, title: 'Сборник Л6', price: 5, status: 'наличен' }), 'книга');
  ok(await h.api.links.add({ fromKind: 'персона', fromId: pid, toKind: 'книга', toId: bid }), 'персона → книга');
  ok(await h.api.analytics.create({ title: 'Статия в сборника', source_kind: 'книга', book_id: bid, year: '2001' }), 'статия');
  const bl = ok(await h.api.links.backlinks({ toKind: 'книга', toId: bid }), 'обратни към книга');
  assert.deepEqual(bl.map(x => x.from_kind).sort(), ['персона', 'статия']);
  // Помощникът за картона на книгата (src/views/books.js го вика).
  const html = await h.window.backlinksHtmlFor('книга', bid);
  assert.match(html, /Обратнов, Петър/); assert.match(html, /Статия в сборника/); assert.match(html, /източник на статията/);
});

test('Л10: двама „Вълчев, Стефан“ се различават в „Намерени“ по години и дейност', async () => {
  ok(await h.api.persons.create({ name: 'Съименов, Стефан', birth_date: '1890', death_date: '1965', activity: 'учител' }), 'дядото');
  ok(await h.api.persons.create({ name: 'Съименов, Стефан', birth_date: '1950' }), 'внукът');
  ok(await h.api.persons.create({ name: 'Съименов, Стефан' }), 'трети без нищо');
  const found = ok(await h.api.links.search({ kind: 'персона', q: 'съименов' }), 'търсене').map(r => r.label);
  assert.equal(new Set(found).size, found.length, 'няма два еднакви реда: ' + JSON.stringify(found));
  assert.ok(found.includes('Съименов, Стефан (1890–1965, учител)'));
  assert.ok(found.includes('Съименов, Стефан (р. 1950)'));
  assert.ok(found.some(l => /^Съименов, Стефан \(картон № \d+\)$/.test(l)), 'без години и дейност — номерът на картона');
});

/* ============================================================ Л7, Л8 ==== */
const BIG = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
test('Л7: списъкът и търсенето в персоналиите и летописа не носят снимката — само „има снимка“', async () => {
  const pid = ok(await h.api.persons.create({ name: 'Снимков, Иван' }), 'персоналия');
  const cid = ok(await h.api.chronicle.create({ year: '1960', title: 'Събитие със снимка' }), 'летопис');
  h.db.prepare('UPDATE persons SET photo = ? WHERE id = ?').run(BIG, pid);
  h.db.prepare('UPDATE chronicle SET photo = ? WHERE id = ?').run(BIG, cid);
  const pl = ok(await h.api.persons.list('снимков'), 'търсене в персоналиите');
  assert.equal(pl.length, 1);
  assert.ok(!('photo' in pl[0]), 'снимката не пътува със списъка');
  assert.equal(pl[0].has_photo, 1);
  assert.ok(JSON.stringify(pl).length < 5000, 'отговорът е килобайти, не стотици: ' + JSON.stringify(pl).length);
  const cl = ok(await h.api.chronicle.list({ q: 'снимка' }), 'търсене в летописа');
  assert.ok(!('photo' in cl[0])); assert.equal(cl[0].has_photo, 1);
  assert.ok(JSON.stringify(cl).length < 5000);
  // Снимката идва при отваряне.
  assert.equal(ok(await h.api.persons.get(pid), 'картон').photo, BIG);
  await h.go('persons');
  assert.ok(!h.$('#prsGrid img'), 'списъкът не рисува снимки');
  assert.match(h.text('#prsGrid'), /има снимка/);
  await h.window.personView(pid);
  await h.waitFor(() => h.$('#modal img'), 'картонът показва снимката');
  h.window.closeModal(); await h.settle();
  await h.go('chronicle');
  assert.ok(!h.$('#chrItems img'));
  /* „📷 снимка“, не голото „снимка“: заглавието на записа („Събитие със снимка“)
     само по себе си съдържа думата и твърдението минаваше и без знака. */
  assert.match(h.text('#chrItems'), /📷 снимка/);
});

test('Л8: „Махни“ и „Смени…“ снимка питат; при „Отказ“ снимката остава', async () => {
  const pid = ok(await h.api.persons.create({ name: 'Питанов, Тодор' }), 'персоналия');
  h.db.prepare('UPDATE persons SET photo = ? WHERE id = ?').run(BIG, pid);
  await h.go('persons');
  await h.window.personView(pid);
  await h.waitFor(() => h.$('#modal img'), 'картон');
  h.hooks.confirmAnswer = false;
  let n = h.hooks.confirms.length;
  await h.clickButton('Махни', '#modal .prsViewPhoto');
  assert.match(h.hooks.confirms.slice(n).join('\n'), /Да се махне ли снимката/);
  assert.equal(q('SELECT photo FROM persons WHERE id = ?', pid).photo, BIG, 'дотук едно щракване я триеше');
  n = h.hooks.confirms.length;
  const calls = h.dialogs.calls.length;
  await h.clickButton('Смени…', '#modal .prsViewPhoto');
  assert.match(h.hooks.confirms.slice(n).join('\n'), /ЗАМЕСТИ сегашната/);
  assert.equal(h.dialogs.calls.length, calls, 'при „Отказ“ диалогът за файл не се отваря');
  assert.equal(q('SELECT photo FROM persons WHERE id = ?', pid).photo, BIG);
  h.hooks.confirmAnswer = true;
  await h.clickButton('Махни', '#modal .prsViewPhoto');
  await h.settle();
  assert.equal(q('SELECT photo FROM persons WHERE id = ?', pid).photo, null, 'при „Да“ се маха');
  h.window.closeModal(); await h.settle();
});

/* ================================================================= Л9 ==== */
test('Л9: персоналия само с година („1890“, „ок. 1890“) се вписва — и от формата', async () => {
  const a = ok(await h.api.persons.create({ name: 'Годинов, Иван', birth_date: '1890', death_date: 'ок. 1960' }), '1890 / ок. 1960');
  const r = q('SELECT birth_date, death_date FROM persons WHERE id = ?', a);
  assert.equal(r.birth_date, '1890'); assert.equal(r.death_date, 'ок. 1960');
  assert.match(bad(await h.api.persons.create({ name: 'Обратен, Иван', birth_date: 'ок. 1890', death_date: '1880' }), 'смърт преди раждане по година'),
    /преди датата на раждане/);
  assert.match(bad(await h.api.persons.create({ name: 'Безгодишен', birth_date: 'някога' }), '„някога“'), /само година/);
  // Формата: полето е текстово и приема годината.
  await h.go('persons');
  await h.clickButton('+ Нова персоналия', '#view');
  await h.waitFor(() => h.$('#prsF'), 'формата');
  assert.notEqual(h.$('#prsF [name=birth_date]').type, 'date', 'поле за дата не приема „1890“');
  h.type('#prsF [name=name]', 'Формов, Петко');
  h.type('#prsF [name=birth_date]', 'ок. 1875');
  await h.clickButton('Запиши', '#modal footer');
  await h.settle();
  assert.equal(q("SELECT birth_date FROM persons WHERE name = 'Формов, Петко'").birth_date, 'ок. 1875');
  assert.match(h.text('#modal'), /р\. ок\. 1875/, 'картонът го показва');
  h.window.closeModal(); await h.settle();
});

/* ================================================================ Л11 ==== */
test('Л11: указателят намира „инв. № 900“, „900“, датата на броя, „ок. 1930“ и „1930“; „бр. 2“ не връща бр. 21', async () => {
  const bid = ok(await h.api.books.create({ inv_number: 900, register_date: T, title: 'Сборник Яворец Л11', author: 'Колектив', price: 10, status: 'наличен' }), 'носител');
  const per = ok(await h.api.periodicals.create({ title: 'Вестник Л11', freq: 'седмично' }), 'вестник');
  ok(await h.api.analytics.create({ title: 'Статия бр. 21', source_kind: 'периодика', periodical_id: per, issue: '21', issue_date: '2025-05-27', year: '2025' }), 'бр. 21');
  ok(await h.api.analytics.create({ title: 'Статия бр. 2', source_kind: 'периодика', periodical_id: per, issue: '2', year: '2025' }), 'бр. 2');
  ok(await h.api.analytics.create({ title: 'Статия в сборника Л11', source_kind: 'книга', book_id: bid, year: 'ок. 1930', pages: '45 – 61' }), 'в сборника');
  const titles = async (s) => ok(await h.api.analytics.list({ q: s }), s).map(a => a.title);
  assert.deepEqual(await titles('инв. № 900'), ['Статия в сборника Л11']);
  assert.ok((await titles('900')).includes('Статия в сборника Л11'));
  assert.deepEqual(await titles('27.05.2025'), ['Статия бр. 21'], 'датата, както е показана');
  assert.ok((await titles('ок. 1930')).includes('Статия в сборника Л11'));
  assert.ok((await titles('1930')).includes('Статия в сборника Л11'));
  assert.deepEqual(await titles('бр. 2'), ['Статия бр. 2'], 'бр. 21 не е бр. 2');
  assert.deepEqual(await titles('бр. 21'), ['Статия бр. 21']);
  assert.deepEqual(await titles('стр. 45'), ['Статия в сборника Л11']);
});

test('Л11: летописът намира годината („1972“, „ок. 1930“) и датата, както е показана', async () => {
  ok(await h.api.chronicle.create({ date: '1972-05-24', title: 'Петдесет години Л11' }), 'с дата');
  ok(await h.api.chronicle.create({ year: '1972', title: 'Дарение Л11' }), 'само година');
  ok(await h.api.chronicle.create({ year: 'ок. 1930', title: 'Постановка Л11' }), 'ок. 1930');
  const titles = async (s) => ok(await h.api.chronicle.list({ q: s }), s).map(c => c.title).filter(t => /Л11/.test(t)).sort();
  assert.deepEqual(await titles('1972'), ['Дарение Л11', 'Петдесет години Л11']);
  assert.deepEqual(await titles('ок. 1930'), ['Постановка Л11']);
  assert.deepEqual(await titles('24.05.1972'), ['Петдесет години Л11']);
  // На екрана — същото.
  await h.go('chronicle');
  h.window.chrSearch('1972');
  await h.sleep(350); await h.settle();
  assert.match(h.text('#chrItems'), /Дарение Л11/);
  h.window.chrSearch(''); await h.sleep(350); await h.settle();
});

/* ================================================================ Л12 ==== */
test('Л12: „Вълчев,  Стефан“, „Вълчев Стефан“ и преименуване в заварено име — екранът пита, дневникът помни', async () => {
  const first = ok(await h.api.persons.create({ name: 'Дублинов, Стефан', activity: 'учител' }), 'първият');
  const other = ok(await h.api.persons.create({ name: 'Различен, Човек' }), 'друг');
  h.hooks.confirmAnswer = false;
  for (const variant of ['Дублинов,  Стефан', 'Дублинов Стефан', 'стефан дублинов']) {
    const before = q('SELECT COUNT(*) AS n FROM persons').n;
    const n = h.hooks.confirms.length;
    await h.go('persons');
    await h.clickButton('+ Нова персоналия', '#view');
    await h.waitFor(() => h.$('#prsF'), 'формата');
    h.type('#prsF [name=name]', variant);
    await h.clickButton('Запиши', '#modal footer');
    await h.settle();
    const asked = h.hooks.confirms.slice(n).join('\n');
    assert.match(asked, /вече е вписан/, '„' + variant + '“ — екранът пита');
    assert.match(asked, /учител/, 'и показва по какво да се разпознае завареният картон');
    assert.equal(q('SELECT COUNT(*) AS n FROM persons').n, before, 'при „Отказ“ не влиза');
    h.window.closeModal(); await h.settle();
  }
  // Преименуване на ДРУГ картон в заварено име.
  let n = h.hooks.confirms.length;
  await h.window.personForm(other);
  await h.waitFor(() => h.$('#prsF'), 'редакция');
  h.type('#prsF [name=name]', 'Дублинов, Стефан');
  await h.clickButton('Запиши', '#modal footer');
  await h.settle();
  assert.match(h.hooks.confirms.slice(n).join('\n'), /вече е вписан/, 'преименуването също пита');
  assert.equal(q('SELECT name FROM persons WHERE id = ?', other).name, 'Различен, Човек');
  h.hooks.confirmAnswer = true;
  await h.clickButton('Запиши', '#modal footer');
  await h.settle();
  assert.equal(q('SELECT name FROM persons WHERE id = ?', other).name, 'Дублинов, Стефан');
  const trail = h.db.prepare("SELECT detail FROM audit_log WHERE action = 'Персоналии' ORDER BY id DESC LIMIT 1").get().detail;
  assert.match(trail, /преименувано от „Различен, Човек“/);
  assert.match(trail, new RegExp('ВНИМАНИЕ: със същото име вече има картон \\(№ ' + first + '\\)'));
});

/* ================================================================ Л13 ==== */
test('Л13: изтриване на несъществуваща персоналия и статия е отказ, без ред в дневника', async () => {
  const n0 = q('SELECT COUNT(*) AS n FROM audit_log').n;
  assert.match(bad(await h.api.persons.delete(987654), 'персоналия'), /не е намерена/);
  assert.match(bad(await h.api.analytics.delete(987654), 'статия'), /не е намерено/);
  assert.equal(q('SELECT COUNT(*) AS n FROM audit_log').n, n0, 'дневникът не твърди изтриване, което не е станало');
});

/* ================================================================ Е10 ==== */
async function printDnevnik31(tab) {
  await h.go('dnevnik');
  h.window.eval(`DNEVNIK_TAB='${tab}'; DNEVNIK_YEAR=${Y}; DNEVNIK_MONTH=1;`);
  await h.window.renderDnevnik();
  await h.settle();
  h.window.printDnevnikDoc();
  await h.settle();
}
test('Е10: Дневникът — всеки лист на таблицата е цял, подписите са под последния, плътният печатен стил е подаден', async () => {
  await printDnevnik31('a');
  const parts = h.document.querySelectorAll('#ppSheet .dnvPart');
  assert.equal(parts.length, 2, 'два листа за Раздел А');
  assert.ok(parts[1].querySelector('.psig'), 'подписите са вътре в последния лист, не сами на празен');
  assert.ok(!parts[0].querySelector('.psig'));
  assert.match(parts[0].textContent, /Всичко от нач\. на годината/, 'двата сборни реда са в същия лист като дните');
  const css = h.$('#dynPrintStyle').textContent;
  assert.match(css, /\.dnvDoc \.dnvPart\{break-inside:avoid/);
  assert.match(css, /\.dnvDoc table\.dnvPrint td\{padding:0 1px/);
  h.window.ppClose && h.window.ppClose();
});

test('Е10: годишният отчет А/Б — без нов лист за всеки ред; частите са цели', async () => {
  await h.go('reports');
  h.type('#repSel', 'annual_ab');
  await h.settle();
  await h.waitFor(() => h.window._REPORT && h.window._REPORT.id === 'annual_ab', 'отчетът');
  h.window.printReportDoc();
  await h.settle();
  assert.equal(h.document.querySelectorAll('#ppSheet .pbreak').length, 0, 'дотук — три принудителни нови листа за четири реда');
  assert.equal(h.document.querySelectorAll('#ppSheet .dnvPart').length, 4);
  assert.match(flat(h.printed()), /част 1 от 2/);
  h.window.ppClose && h.window.ppClose();
});

/* Истинският брой листове — в Chromium, по същия печатен път (@media print,
   @page от setPrintPage). Прескача се само когато на машината няма Chromium. */
function findChromium() {
  const exe = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  let pw = null;
  for (const m of ['playwright', '/home/claude/.npm-global/lib/node_modules/playwright']) {
    try { pw = require(m); break; } catch (e) { /* следващият път */ }
  }
  return exe && pw ? { exe, pw } : null;
}
const CHROME = findChromium();
async function pdfPages(html, dynCss) {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');
  const browser = await CHROME.pw.chromium.launch({ executablePath: CHROME.exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html lang="bg"><head><meta charset="utf-8"><style>${css}</style>
      <style>${dynCss}</style></head><body><div id="printArea">${html}</div></body></html>`, { waitUntil: 'domcontentloaded' });
    await page.emulateMedia({ media: 'print' });
    const buf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  } finally { await browser.close(); }
}
test('Е10: PDF — Дневник за 31-дневен месец на 2 листа на раздел; годишният отчет на 1 лист', { skip: !CHROME && 'на тази машина няма Chromium' }, async () => {
  for (const tab of ['a', 'b']) {
    await printDnevnik31(tab);
    const pages = await pdfPages(h.window.eval('PRINT_HTML'), h.$('#dynPrintStyle').textContent);
    assert.equal(pages, 2, 'Раздел ' + tab.toUpperCase() + ' — дотук 4 листа');
    h.window.ppClose && h.window.ppClose();
  }
  await h.go('reports');
  h.type('#repSel', 'annual_ab');
  await h.settle();
  await h.waitFor(() => h.window._REPORT && h.window._REPORT.id === 'annual_ab', 'отчетът');
  h.window.printReportDoc();
  await h.settle();
  const pages = await pdfPages(h.window.eval('PRINT_HTML'), h.$('#dynPrintStyle').textContent);
  assert.equal(pages, 1, 'годишният отчет — дотук 4 листа с по един ред');
  h.window.ppClose && h.window.ppClose();
});

/* ================================================================= П4 ==== */
test('П4: инвентарната книга носи УДК и авторски знак — „Сигнатура“ не е празна и се търси', async () => {
  ok(await h.api.books.create({ inv_number: 77200, register_date: T, title: 'Яворец П4', author: 'Йорданов, Й.', price: 3,
    udk: '638(497.2)', author_mark: 'Й 83', status: 'наличен' }), 'книга без ръчна сигнатура');
  const w = ok(await h.api.invBook.list({ q: '638(497.2)', offset: 0, limit: 50, summary: false }), 'търсене по УДК');
  const r = w.rows.find(x => x.inv_number === 77200);
  assert.ok(r, 'намира се по показаната сигнатура');
  assert.equal(r.udk, '638(497.2)'); assert.equal(r.author_mark, 'Й 83');
  assert.equal(h.window.effectiveCallNumber(r), '638(497.2) Й 83');
  const all = ok(await h.api.invBook.list(), 'пълен списък').find(x => x.inv_number === 77200);
  assert.equal(all.udk, '638(497.2)', 'и пълният списък (печатът) ги носи');
});

/* ================================================================ Г11 ==== */
test('Г11: решението — намерената книга се брои като върната (със забава) в годината на намирането', async () => {
  /* Не е поведение, което се сменя тук, а решение: филтър в handlers/stats.js
     НЯМА, защото loans:found пише date_in = деня на намирането (виж бележката
     там). Заковано е, че заемане, върнато след срока и без белега lost
     (намерената книга след loans:found), се брои „със забава“ ВЕДНЪЖ, а още
     изгубеното (lost = 1) — не. */
  const late0 = ok(await h.api.stats.report(Y), 'статистика преди').returnedLate;
  const rd = h.db.prepare("INSERT INTO readers (name, card_no, category, registered_at) VALUES ('Намерил, Г11', 'G11', 'възрастен', ?)").run(Y + '-01-02').lastInsertRowid;
  const bk = h.db.prepare("INSERT INTO books (inv_number, title, price, register_date, status) VALUES (77300, 'Намерена Г11', 1, ?, 'наличен')").run(Y + '-01-02').lastInsertRowid;
  h.db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)')
    .run(bk, rd, Y + '-01-05', Y + '-02-05', Y + '-03-01');
  h.db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in, lost, lost_date) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(bk, rd, Y + '-01-06', Y + '-02-06', Y + '-03-02', Y + '-03-02');
  const late1 = ok(await h.api.stats.report(Y), 'статистика след').returnedLate;
  assert.equal(late1 - late0, 1, 'намерената — вътре, още изгубената — не');
});
