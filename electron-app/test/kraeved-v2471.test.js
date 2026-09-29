'use strict';
/* ПОПРАВКИ ОТ КРЪГ 45 (v2.4.71) — КРАЕЗНАНИЕ, ПЕРИОДИКА, ДНЕВНИК, ОТЧЕТИ.
 * ===========================================================================
 * По един (или повече) тест на находка. Всеки твърди онова, което
 * библиотекарката ВИЖДА — текст на екрана, ред в базата, число на
 * разпечатката — и пада, ако поправката бъде върната (проверено поотделно):
 *
 *   Д1   статия от брой от 31.12.2025 се записваше с текущата година;
 *   Д2   годишният комплект нямаше език и Дневникът го броеше в „Език — други“;
 *   Д3   „Регистрирани читатели през 2025 г.“ се менеше при пререгистрация през 2026;
 *   Д4   брой в инвентиран комплект не влизаше в никой комплект, а значката
 *        казваше „влиза в следващия“;
 *   Д5   Дневникът, „Впиши посещения“ и посещенията по домовете приемаха бъдещи дати;
 *   Д6   файл с разширение .jpg, който не е снимка, заменяше истинската снимка;
 *   Д7   ⚡ втори път за деня не обновяваше числата от първото ⚡;
 *   Д8   „Деца до 14 г.“ > „В заемна за дома“ от клетката — без дума;
 *   Д9   картоните на статия и на периодично издание не казваха кой сочи към тях;
 *   Д10  персоналия в списъка — „няма свързани материали“ при обратни връзки;
 *   Д11  абонаментният списък говореше за отчислен комплект, какъвто няма;
 *   Д12  статия, пренасочена към книга, пазеше старото издание като източник;
 *   Д13  изборът „Годишен комплект“ се връщаше на годината на датата;
 *   Д14  часове: „7.50“, „7,5“ и „7,25“ — три различни правила;
 *   Д15  празният панел „Сочат към този запис“ под всяка книга;
 *   Д16  търсачката за връзки към летописа не намираше по година;
 *   Д17  изборът „Годишен комплект“ се режеше при 1366 px;
 *   Д18  текущата година — „приключен регистър“; „2,5“ посещения ставаха 25;
 *   Ф8   комплект → партида „без документ“: номер и дата оставаха отключени;
 *   Ч3   „Събрани обезщетения“ > „Начислени обезщетения“ в годишния отчет.
 *
 * Всичко минава през ИСТИНСКИЯ харнес (bootApp → истинският main.js +
 * истинските екрани в jsdom).
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
const TOMORROW = E.addDays(T, 1);

const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const bad = (r, what) => { assert.ok(r && r.ok === false, what + ' — прието е, а не биваше'); return r.error; };
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const cents = (x) => Math.round((Number(x) || 0) * 100);

let invSeq = 71000;
const nextInv = () => ++invSeq;
function reader(name, extra) {
  const o = Object.assign({ card_no: 'K' + (invSeq++), category: 'възрастен', registered_at: Y + '-01-02',
    gdpr_consent: 1, gdpr_consent_date: Y + '-01-02', status: 'активен' }, extra || {});
  return h.db.prepare(`INSERT INTO readers (name, card_no, category, registered_at, re_registered_at, gdpr_consent, gdpr_consent_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, o.card_no, o.category, o.registered_at, o.re_registered_at || null,
    o.gdpr_consent, o.gdpr_consent_date, o.status).lastInsertRowid;
}

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

/* Издание с броеве за миналата година и инвентиран комплект за нея. */
async function periodicalWithVolume(title, extra) {
  const pid = ok(await h.api.periodicals.create(Object.assign({ title, freq: 'седмично' }, extra || {})), 'издание ' + title);
  for (const [no, d] of [['1', Y1 + '-11-02'], ['2', Y1 + '-11-09'], ['3', Y1 + '-11-16'], ['4', Y1 + '-11-23']]) {
    ok(await h.api.periodicalIssues.add({ periodical_id: pid, issue_no: no, date: d, price: '1,20' }), 'брой ' + no);
  }
  const reg = ok(await h.api.periodicalVolumes.register({ periodical_id: pid, year: Y1, register_date: T, inv_number: nextInv() }), 'инвентиране');
  return { pid, reg };
}

/* ================================================================= Д1 ==== */
test('Д1: годината на статията следва датата на броя — отказ при разминаване, от формата се води сама', async () => {
  const pid = ok(await h.api.periodicals.create({ title: 'Труд Д1', freq: 'ежедневно' }), 'издание');
  const err = bad(await h.api.analytics.create({ title: 'Стара статия', source_kind: 'периодика', periodical_id: pid,
    year: Y, issue_date: Y1 + '-12-31', issue: '250' }), 'година ' + Y + ' при брой от ' + Y1);
  assert.match(err, new RegExp('Годината „' + Y + '“ не отговаря на датата на броя 31\\.12\\.' + Y1));
  const id = ok(await h.api.analytics.create({ title: 'Статия без година', source_kind: 'периодика', periodical_id: pid,
    year: '', issue_date: Y1 + '-12-31' }), 'без година');
  assert.equal(q('SELECT year FROM analytics WHERE id = ?', id).year, Y1, 'празната година се взима от датата');
  // От формата: предложената текуща година се сменя по датата — видимо.
  await h.go('analytics');
  await h.window.analyticForm();
  await h.waitFor(() => h.$('#anlF'), 'формата');
  assert.equal(h.$('#anlF [name=year]').value, Y, 'формата предлага текущата година');
  h.type('#anlF [name=title]', 'От формата Д1');
  h.type('#anlF [name=periodical_id]', String(pid));
  h.type('#anlF [name=issue_date]', Y1 + '-12-31');
  assert.equal(h.$('#anlF [name=year]').value, Y1, 'годината вече е тази на броя');
  assert.match(h.text('#anlYearNote'), new RegExp('сменена на ' + Y1));
  await h.clickButton('Запиши', '#modal');
  assert.equal(q("SELECT year FROM analytics WHERE title = 'От формата Д1'").year, Y1);
});

/* ================================================================= Д12 === */
test('Д12: статия, пренасочена от периодика към книга, вече не сочи старото издание', async () => {
  const pid = ok(await h.api.periodicals.create({ title: 'Отечество Д12', freq: 'месечно' }), 'издание');
  const bid = ok(await h.api.books.create({ inv_number: nextInv(), register_date: T, title: 'Сборник Д12', price: 5, status: 'наличен' }), 'книга');
  const id = ok(await h.api.analytics.create({ title: 'Статия Д12', source_kind: 'периодика', periodical_id: pid, year: Y }), 'статия');
  const a = ok(await h.api.analytics.get(id), 'статията');
  ok(await h.api.analytics.update(Object.assign({}, a, { source_kind: 'книга', book_id: String(bid) })), 'пренасочване');
  const row = q('SELECT periodical_id, book_id FROM analytics WHERE id = ?', id);
  assert.equal(row.periodical_id, null, 'старото издание вече не е източник');
  assert.equal(row.book_id, bid);
  assert.match(q("SELECT detail FROM audit_log WHERE action = 'Аналитично описание' ORDER BY id DESC").detail,
    /източникът вече не е „Отечество Д12“/);
  // И изданието вече може да се изтрие — статията не е негова.
  ok(await h.api.periodicals.delete(pid), 'изтриване на изданието');
});

/* ================================================================= Д2 ==== */
test('Д2: картонът има „Език“ (по подразбиране български), той отива в комплекта, а Дневникът го брои', async () => {
  await h.go('periodika');
  await h.window.periodicalForm();
  await h.waitFor(() => h.$('#perF'), 'картонът');
  const sel = h.$('#perF [name=language]');
  assert.ok(sel, 'картонът на изданието има поле „Език“');
  assert.equal(sel.value, 'български', 'по подразбиране — български');
  h.type('#perF [name=title]', 'Руско списание Д2');
  h.type('#perF [name=language]', 'руски');
  await h.clickButton('Запиши', '#modal');
  assert.equal(q("SELECT language FROM periodicals WHERE title = 'Руско списание Д2'").language, 'руски');
  // Изданието по API без език — „български“.
  const { pid, reg } = await periodicalWithVolume('Труд Д2');
  assert.equal(q('SELECT language FROM periodicals WHERE id = ?', pid).language, 'български');
  assert.equal(q('SELECT language FROM books WHERE id = ?', reg.book_id).language, 'български', 'езикът е в реда на комплекта');
  // Заемането на комплекта — в Дневника, Раздел Б, по език „български“, не „други“.
  const rid = reader('Читател Д2');
  const day = E.addDays(T, -1);
  ok(await h.api.loans.checkoutByCode({ reader_id: rid, code: String(reg.inv_number), date_out: day }), 'заемане на комплекта');
  const sug = ok(await h.api.dnevnik.suggest({ date: day }), 'предложение').suggestions;
  assert.equal(sug.b_lang_bg, 1, 'Раздел Б — „Език — български“');
  assert.equal(sug.b_lang_other || 0, 0, 'нищо в „Език — други“');
  // Смяната на езика в картона стига и до инвентирания комплект — и се казва.
  const p = ok(await h.api.periodicals.get(pid), 'картон');
  const res = ok(await h.api.periodicals.update(Object.assign({}, p, { language: 'английски' })), 'смяна на езика');
  assert.equal(res.languageVolumes, 1);
  assert.equal(q('SELECT language FROM books WHERE id = ?', reg.book_id).language, 'английски');
});

/* ================================================================= Д3 ==== */
test('Д3: „Регистрирани читатели“ за минала година не се мени при следваща пререгистрация — от историята', async () => {
  const before2020 = ok(await h.api.stats.report('2020'), 'статистика 2020').readersCount;
  // Иван: записан 2019, пререгистриран 2020 и 2021; картонът помни само последната (2021).
  const ivan = reader('Иван Д3', { registered_at: '2019-02-01', re_registered_at: '2021-02-12' });
  /* reader_key = 'r' + номер на картона — така пише и handlers/readers.js (виж db/schema.sql). */
  const insK = h.db.prepare("INSERT OR IGNORE INTO reader_registrations (reader_id, reader_key, date, kind) VALUES (?, 'r' || ?, ?, ?)");
  const ins = { run: (id, date, kind) => insK.run(id, id, date, kind) };
  ins.run(ivan, '2019-02-01', 'записване');
  ins.run(ivan, '2020-02-10', 'пререгистрация');
  ins.run(ivan, '2021-02-12', 'пререгистрация');
  // Служебният запис на ОРЗД не е читател — и с ред в историята не се брои.
  const anon = reader('— анонимизирани заемания —', { registered_at: '2020-05-05' });
  ins.run(anon, '2020-05-05', 'записване');
  const r2020 = ok(await h.api.stats.report('2020'), 'статистика 2020').readersCount;
  assert.equal(r2020 - before2020, 1, 'Иван е пререгистриран през 2020 — брои се, макар картонът да казва 2021');
  // Таблото — от същата история: читател с ред за тази година, но без дата в картона.
  const eva = reader('Ева Д3', { registered_at: '2018-01-01' });
  h.db.prepare('UPDATE readers SET registered_at = NULL, re_registered_at = NULL WHERE id = ?').run(eva);
  ins.run(eva, Y + '-01-05', 'пререгистрация');
  const d = ok(await h.api.dashboard.full(), 'табло');
  const st = ok(await h.api.stats.report(Y), 'статистика ' + Y);
  const fromHistory = q(`SELECT COUNT(*) AS n FROM (
      SELECT reader_key AS k FROM reader_registrations WHERE substr(date,1,4) = ?
        AND (reader_id IS NULL OR reader_id NOT IN (SELECT id FROM readers WHERE name = '— анонимизирани заемания —'))
      UNION SELECT 'r' || id FROM readers WHERE substr(registered_at,1,4) = ? AND name != '— анонимизирани заемания —')`, Y, Y).n;
  assert.equal(d.readersYear, fromHistory, 'таблото брои по историята');
  assert.equal(st.readersCount, fromHistory, '„Статистика“ — същото число');
  await h.go('stats');
  assert.match(h.viewText(), new RegExp(fromHistory + ' Регистрирани читатели през ' + Y));
});

/* ================================================================= Д4 ==== */
test('Д4: брой за вече инвентиран комплект — отказ с предложение; от формата отива в следващия', async () => {
  const { pid, reg } = await periodicalWithVolume('Седмичник Д4');
  const err = bad(await h.api.periodicalIssues.add({ periodical_id: pid, issue_no: '5', date: T, volume_year: Y1, price: '1,20' }), 'брой в подвързан комплект');
  assert.match(err, new RegExp('вече е подвързан и вписан в инвентарната книга като инв\\. № ' + reg.inv_number));
  assert.match(err, new RegExp('Изберете „' + Y + ' г\\.“'), 'предлага следващата година');
  assert.equal(q('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ? AND issue_no = ?', pid, '5').n, 0);
  // От формата: изборът на миналата година пита и вписва в следващия комплект.
  await h.go('periodika');
  await h.window.openPeriodical(pid);
  await h.waitFor(() => h.$('#issueF'), 'кардексът');
  await h.settle();
  h.type('#issueF [name=issue_no]', '6');
  h.type('#issueF [name=volume_year]', Y1);
  h.type('#issueF [name=price]', '1,20');
  h.hooks.confirmAnswer = true;
  const nc = h.hooks.confirms.length;
  await h.clickButton('Добави брой', '#modal');
  await h.settle();
  assert.match(h.hooks.confirms.slice(nc).join('\n'), new RegExp('Да впиша ли бр\\. 6 в комплекта за ' + Y));
  assert.equal(String(q('SELECT volume_year FROM periodical_issues WHERE periodical_id = ? AND issue_no = ?', pid, '6').volume_year), Y);
  // Изрично „само в кардекса“ — вписва се, а значката и абонаментният списък казват истината.
  ok(await h.api.periodicalIssues.add({ periodical_id: pid, issue_no: '7', date: T, volume_year: Y1, price: '1,20', outside_volume: true }), 'само в кардекса');
  await h.window.openPeriodical(pid, Y1);
  await h.waitFor(() => h.$('#issueF'), 'кардексът');
  const txt = h.modal();
  assert.match(txt, /излишните са само в кардекса, извън фонда/);
  const badge = Array.from(h.document.querySelectorAll('#modal .badge.warn')).map(b => b.getAttribute('title') || '').join(' ');
  assert.doesNotMatch(badge, /новите броеве влизат в следващия комплект/, 'старото невярно обещание го няма');
  assert.match(badge, /не влизат в нито един документ във фонда/);
  h.window.closeModal();
  await h.settle();
  await h.go('periodika');
  h.type('#perPrintYear', Y1);
  await h.window.printPeriodikaYear();
  await h.settle();
  assert.match(h.printed(), /„Седмичник Д4“: комплектът е подвързан с 4 бр\. за 4\.80 €[^;]*; 1 бр\. за 1\.20 €[^е]* е вписан в кардекса след инвентирането и не влиза във фонда/);
});

/* ================================================================= Д5 ==== */
test('Д5: бъдещ ден — отказ в Дневника, „Впиши посещения“ и посещенията по домовете; клетката е само за четене', async () => {
  const e1 = bad(await h.api.dnevnik.saveDay({ date: TOMORROW, b_type_books: 40 }), 'Дневник утре');
  assert.match(e1, /още не е настъпил/);
  assert.equal(q('SELECT COUNT(*) AS n FROM dnevnik_days WHERE date = ?', TOMORROW).n, 0);
  const e2 = bad(await h.api.visits.add({ date: TOMORROW, count: 30 }), 'посещения утре');
  assert.match(e2, /още не е настъпил/);
  assert.equal(q('SELECT COUNT(*) AS n FROM visits WHERE date = ?', TOMORROW).n, 0);
  const rid = reader('Домашен Д5');
  const e3 = bad(await h.api.housebound.addVisit({ reader_id: rid, date: TOMORROW }), 'посещение по домовете утре');
  assert.match(e3, /още не е настъпила/);
  assert.equal(q('SELECT COUNT(*) AS n FROM housebound_visits WHERE reader_id = ?', rid).n, 0);
  ok(await h.api.housebound.addVisit({ reader_id: rid, date: T }), 'днес минава');
  ok(await h.api.dnevnik.saveDay({ date: T, b_type_books: 0 }), 'днешният ден минава');
  // Екранът: редът на утрешния ден (ако е в този месец) е само за четене.
  if (TOMORROW.slice(0, 7) === T.slice(0, 7)) {
    await h.go('dnevnik');
    const cell = h.$(`.dnvTable input[data-date="${TOMORROW}"][data-field="a_hours"]`);
    assert.ok(cell && cell.readOnly, 'бъдещият ден не се попълва от таблицата');
  }
});

/* ================================================================= Д6 ==== */
test('Д6: файл .jpg, който не е снимка, се отказва и сегашната снимка остава', async () => {
  const pid = ok(await h.api.persons.create({ name: 'Снимков, Д6' }), 'персоналия');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-'));
  const png = path.join(dir, 'portret.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  h.dialogs.openPaths = [png];
  ok(await h.api.localPhoto.choose({ table: 'persons', id: pid }), 'истинската снимка');
  const before = q('SELECT photo FROM persons WHERE id = ?', pid).photo;
  assert.match(before, /^data:image\/png;base64,/);
  const fake = path.join(dir, 'falshiva.jpg');
  fs.writeFileSync(fake, 'това е текст, а не снимка — 44 байта точно!!');
  h.dialogs.openPaths = [fake];
  const err = bad(await h.api.localPhoto.choose({ table: 'persons', id: pid }), 'фалшива снимка');
  assert.match(err, /„falshiva\.jpg“ не е снимка/);
  assert.equal(q('SELECT photo FROM persons WHERE id = ?', pid).photo, before, 'сегашната снимка е непокътната');
  // PNG, кръстен .jpg, е снимка — записва се с истинския си вид.
  const mis = path.join(dir, 'kruksten.jpg');
  fs.copyFileSync(png, mis);
  h.dialogs.openPaths = [mis];
  const uri = ok(await h.api.localPhoto.choose({ table: 'persons', id: pid }), 'PNG с разширение .jpg');
  assert.match(uri, /^data:image\/png;base64,/);
  h.dialogs.openPaths = null;
});

/* ================================================================= Д7 ==== */
function ev(date, readerId) {
  h.db.prepare(`INSERT INTO events (date, kind, reader_id, reader_category, book_category, book_language, book_udk)
    VALUES (?, 'заемане', ?, 'възрастен', 'книга', 'български', '821.163.2-31')`).run(date, readerId);
}
test('Д7: ⚡ втори път обновява своето предложение, а записаното по-рано не нарича „ръчно въведено“', async () => {
  const day = E.addDays(T, -3);
  const r1 = reader('Първи Д7'), r2 = reader('Втори Д7');
  ev(day, r1);
  await h.go('dnevnik');
  await h.window.dnevnikDayForm(day);
  await h.waitFor(() => h.$('#dnvF'), 'формата');
  await h.clickButton('Предложи от регистрите', '#modal');
  assert.equal(h.$('#dnvF [name=b_type_books]').value, '1');
  // Същият прозорец: ново заемане, ⚡ пак — предложеното се обновява само.
  ev(day, r2);
  await h.clickButton('Предложи от регистрите', '#modal');
  assert.equal(h.$('#dnvF [name=b_type_books]').value, '2', 'предложеното от ⚡ се обновява');
  assert.doesNotMatch(h.text('#dnvSugHint'), /ръчно въведен/, 'програмата не нарича своите числа „ръчно въведени“');
  await h.clickButton('Запиши деня', '#modal');
  assert.equal(q('SELECT b_type_books FROM dnevnik_days WHERE date = ?', day).b_type_books, 2);
  // Друг ден: записаното по-рано се изброява и се обновява с един бутон.
  ev(day, reader('Трети Д7'));
  await h.window.dnevnikDayForm(day);
  await h.waitFor(() => h.$('#dnvF'), 'формата');
  await h.clickButton('Предложи от регистрите', '#modal');
  const hint = h.text('#dnvSugHint');
  assert.doesNotMatch(hint, /ръчно въведен/);
  assert.match(hint, /Книги — записано 2, регистрите дават 3/);
  assert.equal(h.$('#dnvF [name=b_type_books]').value, '2', 'записаното не се сменя само');
  await h.clickButton('Обнови', '#dnvSugHint');
  assert.equal(h.$('#dnvF [name=b_type_books]').value, '3');
  await h.clickButton('Запиши деня', '#modal');
  assert.equal(q('SELECT b_type_books FROM dnevnik_days WHERE date = ?', day).b_type_books, 3);
});

/* ================================================================= Д8 ==== */
test('Д8: „Деца до 14 г.“ над „В заемна за дома“ от клетката на таблицата — предупреждение', async () => {
  const day = E.addDays(T, -2);
  await h.go('dnevnik');
  if (day.slice(0, 7) !== T.slice(0, 7)) {
    // В началото на месеца клетката е в предишния месец — проверява се обработчикът.
    ok(await h.api.dnevnik.saveDay({ date: day, a_visit_home: 2 }), 'дома');
    const r = ok(await h.api.dnevnik.saveDay({ date: day, a_visit_child: 5 }), 'деца');
    assert.ok(r.warnings.some(w => /деца до 14 г\.“ \(5\) надхвърля/.test(w)));
    return;
  }
  const cell = (f) => `.dnvTable input[data-date="${day}"][data-field="${f}"]`;
  h.type(cell('a_visit_home'), '2'); await h.settle();
  const n = h.toasts.length;
  h.type(cell('a_visit_child'), '5'); await h.settle();
  const w = h.toastsSince(n).find(t => t.type === 'err' && /деца до 14 г\.“ \(5\) надхвърля/.test(t.msg));
  assert.ok(w, 'клетката предупреждава: ' + JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT a_visit_child FROM dnevnik_days WHERE date = ?', day).a_visit_child, 5, 'записано е — предупреждение, не отказ');
});

/* ================================================================ Д9/Д15 == */
test('Д9: картоните на статия и на периодично издание показват кой сочи към тях', async () => {
  const pid = ok(await h.api.periodicals.create({ title: 'Бюлетин Д9', freq: 'месечно' }), 'издание');
  const aid = ok(await h.api.analytics.create({ title: 'Статия Д9', source_kind: 'периодика', periodical_id: pid, year: Y }), 'статия');
  const per = ok(await h.api.persons.create({ name: 'Свързан, Д9' }), 'персоналия');
  ok(await h.api.links.add({ fromKind: 'персона', fromId: per, toKind: 'статия', toId: aid }), 'персона → статия');
  const chr = ok(await h.api.chronicle.create({ year: Y, title: 'Събитие Д9' }), 'летопис');
  ok(await h.api.links.add({ fromKind: 'летопис', fromId: chr, toKind: 'периодика', toId: pid }), 'летопис → издание');
  await h.go('analytics');
  await h.window.analyticForm(aid);
  await h.waitFor(() => h.$('#backlinks'), 'панелът в картона на статията');
  assert.match(h.text('#backlinks'), /Сочат към този запис.*Свързан, Д9/);
  h.window.closeModal(); await h.settle();
  await h.go('periodika');
  await h.window.openPeriodical(pid);
  await h.waitFor(() => h.$('#backlinks'), 'панелът в картона на изданието');
  const t = h.text('#backlinks');
  assert.match(t, /Събитие Д9/, 'летописът, който сочи към изданието');
  assert.match(t, /Статия Д9.*източник на статията/, 'и статията с източник изданието');
  h.window.closeModal(); await h.settle();
});

test('Д15: картонът на книга без обратни връзки не носи празния панел', async () => {
  const bid = ok(await h.api.books.create({ inv_number: nextInv(), register_date: T, title: 'Самотна Д15', price: 2, status: 'наличен' }), 'книга');
  await h.go('books');
  await h.window.bookForm(bid);
  await h.waitFor(() => h.$('#bookF'), 'картонът');
  await h.settle(120);
  assert.equal(h.$('#backlinks'), null, 'няма каре „Сочат към този запис — Нито една…“');
  assert.doesNotMatch(h.modal(), /Нито една персоналия/);
  h.window.closeModal(); await h.settle();
});

/* ================================================================= Д10 === */
test('Д10: картата на персоналия в списъка брои и записите, които сочат към нея', async () => {
  const pid = ok(await h.api.persons.create({ name: 'Вълчев, Стефан Д10' }), 'персоналия');
  const chr = ok(await h.api.chronicle.create({ year: '1972', title: 'Юбилей Д10' }), 'летопис');
  ok(await h.api.links.add({ fromKind: 'летопис', fromId: chr, toKind: 'персона', toId: pid }), 'летопис → персона');
  await h.go('persons');
  const card = Array.from(h.document.querySelectorAll('.prsCard')).find(c => /Вълчев, Стефан Д10/.test(c.textContent));
  assert.ok(card, 'картата е в списъка');
  const t = h.text(card);
  assert.doesNotMatch(t, /няма свързани материали/);
  assert.match(t, /1 запис сочи към нея/);
});

/* ================================================================= Д11 === */
test('Д11: абонаментният списък не говори за отчислен комплект, когато няма такъв', async () => {
  ok(await h.api.periodicals.create({ title: 'Неинвентиран Д11', freq: 'месечно' }), 'издание');
  const pid = q("SELECT id FROM periodicals WHERE title = 'Неинвентиран Д11'").id;
  ok(await h.api.periodicalIssues.add({ periodical_id: pid, issue_no: '1', date: T, price: 2 }), 'брой');
  await h.go('periodika');
  h.type('#perPrintYear', Y);
  await h.window.printPeriodikaYear();
  await h.settle();
  const p = h.printed();
  assert.match(p, /без инвентиран годишен комплект/, 'предупреждението за неинвентираното остава');
  assert.ok(!/ОТЧИСЛЕН/.test(p), 'предпоставка: няма отчислен комплект');
  assert.doesNotMatch(p, /Отчисленият комплект е бил вписан/);
});

/* ============================================================ Д13/Д17 ==== */
test('Д13/Д17: изборът „Годишен комплект“ е кратък и не се връща сам при смяна на датата', async () => {
  const pid = ok(await h.api.periodicals.create({ title: 'Ежедневник Д13', freq: 'ежедневно' }), 'издание');
  await h.go('periodika');
  await h.window.openPeriodical(pid);
  await h.waitFor(() => h.$('#issueF'), 'кардексът');
  const sel = h.$('#issueF [name=volume_year]');
  for (const o of sel.options) assert.ok(o.textContent.length <= 16, 'кратко: „' + o.textContent + '“');
  assert.equal(sel.options[0].textContent, Y + ' г.');
  h.type('#issueF [name=date]', Y + '-01-03');
  h.type('#issueF [name=volume_year]', Y1);
  h.type('#issueF [name=date]', Y + '-01-06');
  assert.equal(sel.value, Y1, 'изборът остава — брой от края на декември');
  // Годината вече не е допустима за новата дата — връща се, и това се казва.
  h.type('#issueF [name=date]', String(Number(Y) - 3) + '-05-05');
  assert.equal(sel.value, String(Number(Y) - 3));
  assert.match(h.text('#perIssueVolHint'), new RegExp('Избраната година ' + Y1 + ' не е допустима'));
  h.window.closeModal(); await h.settle();
});

/* ================================================================= Д14 === */
test('Д14: запетаята е дроб от часа, двоеточието и точката — минути', async () => {
  const P = (s) => h.window.parseHhmm(s);
  assert.equal(P('7,5'), 450);
  assert.equal(P('7,25'), 435, '„7,25“ = 7:15 — дотук се отказваше');
  assert.equal(P('7,75'), 465);
  assert.equal(P('7.50'), 470, 'точката отделя минутите — „7.50 ч.“');
  assert.equal(P('7:30'), 450);
  assert.equal(P('7.5'), null, '„7.5“ е двусмислено — отказ');
  assert.equal(P('7,333'), null, 'не дава цели минути');
  // „7,30“ — по правилото 7:18, но клетката казва как е разчела.
  const day = E.addDays(T, -1);
  if (day.slice(0, 7) === T.slice(0, 7)) {
    await h.go('dnevnik');
    const n = h.toasts.length;
    h.type(`.dnvTable input[data-date="${day}"][data-field="a_hours"]`, '7,30'); await h.settle();
    assert.equal(q('SELECT a_hours FROM dnevnik_days WHERE date = ?', day).a_hours, 438);
    assert.ok(h.toastsSince(n).some(t => /„7,30“ е записано като 7:18 — запетаята е дроб от часа/.test(t.msg)));
  }
});

/* ================================================================= Д16 === */
test('Д16: търсачката за връзки намира записа в летописа по година', async () => {
  ok(await h.api.chronicle.create({ year: '1930', title: 'Построена е сградата Д16' }), 'летопис');
  const rows = ok(await h.api.links.search({ kind: 'летопис', q: '1930' }), 'търсене');
  assert.ok(rows.some(r => /Построена е сградата Д16/.test(r.label)), JSON.stringify(rows));
});

/* ================================================================= Д18 === */
test('Д18: текущата година не е „приключен регистър“; „2,5“ посещения се отказва, а не става 25', async () => {
  const pid = ok(await h.api.periodicals.create({ title: 'Идно Д18', freq: 'месечно' }), 'издание');
  const next = String(Number(Y) + 1);
  const e1 = bad(await h.api.periodicalVolumes.register({ periodical_id: pid, year: next, register_date: T }), 'комплект за ' + next);
  assert.match(e1, new RegExp('КДБФ за ' + Y + ' г\\., а комплектът за ' + next));
  assert.doesNotMatch(e1, /приключен/, 'регистърът за текущата година е отворен');
  const e2 = bad(await h.api.periodicalVolumes.register({ periodical_id: pid, year: Y, register_date: Y1 + '-06-01', price: 3 }), 'минала година');
  assert.match(e2, /приключен/, 'за минала година — вярно');
  await h.go('stats');
  await h.clickButton('Впиши посещения');
  h.type('#vsF [name=date]', E.addDays(T, -1));
  h.type('#vsF [name=count]', '2,5');
  const n = h.toasts.length;
  await h.clickButton('Впиши', '#modal');
  const t = h.toastsSince(n).find(x => x.type === 'err');
  assert.ok(t && /„2,5“ не е брой посещения/.test(t.msg), JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT COUNT(*) AS n FROM visits WHERE date = ?', E.addDays(T, -1)).n, 0, 'нищо не е вписано');
  h.window.closeModal(); await h.settle();
});

/* ================================================================== Ф8 === */
test('Ф8: комплект → нова партида „без документ“ заключва номера и датата на документа', async () => {
  const pid = ok(await h.api.periodicals.create({ title: 'Партиден Ф8', freq: 'месечно' }), 'издание');
  ok(await h.api.periodicalIssues.add({ periodical_id: pid, issue_no: '1', date: T, price: 3 }), 'брой');
  await h.go('periodika');
  await h.window.openPeriodical(pid);
  await h.waitFor(() => h.$('#issueF'), 'кардексът');
  await h.window.volumeForm(pid, Y);
  await h.waitFor(() => h.$('#volF'), 'формата за инвентиране');
  h.type('#volF [name=acquisition_id]', '__new__');
  h.type('#volF [name=acq_doc_no]', '123');
  h.type('#volF [name=acq_doc_type]', 'без документ — протокол на комисия');
  const no = h.$('#volF [name=acq_doc_no]'), dt = h.$('#volF [name=acq_doc_date]');
  assert.equal(no.value, '', 'написаното не остава да отпадне мълчаливо');
  assert.ok(no.readOnly && dt.readOnly, 'заключени, както в „Постъпления“');
  assert.equal(dt.value, '');
  h.type('#volF [name=acq_doc_type]', 'фактура');
  assert.ok(!no.readOnly && !dt.readOnly, 'при друг вид — отново за попълване');
  h.window.closeModal2(); h.window.closeModal(); await h.settle();
});

/* ================================================================== Ч3 === */
test('Ч3: начислени и събрани — от сметката, по едни и същи видове; събраното не надхвърля начисленото без обяснение', async () => {
  const YR = '2019';
  const r = reader('Платец Ч3', { registered_at: '2019-01-02' });
  const line = h.db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)');
  line.run(r, '2019-03-01', 'начисление', 'забава', 0.4, 'Забава 4 дни');
  line.run(r, '2019-04-01', 'начисление', 'обезщетение за изгубен документ', 10.5, 'Изгубена книга');
  line.run(r, '2019-04-02', 'начисление', 'годишна такса', 5, 'такса');
  line.run(r, '2019-05-01', 'плащане', 'плащане', -5.5, null);
  // Опростена забава (изтрита от сметката) — не се брои, дори loans.fine да я помни.
  const bk = h.db.prepare("INSERT INTO books (inv_number, title, price, register_date, status) VALUES (?, 'Ч3', 1, '2019-01-01', 'наличен')").run(nextInv()).lastInsertRowid;
  h.db.prepare("INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in, fine) VALUES (?, ?, '2019-01-05', '2019-02-05', '2019-03-01', 1.2)").run(bk, r);
  // Стар дълг, платен през годината.
  const r2 = reader('Длъжник Ч3', { registered_at: '2018-01-02' });
  line.run(r2, '2018-12-20', 'начисление', 'забава', 2, 'Забава');
  line.run(r2, '2019-01-05', 'плащане', 'плащане', -2, null);
  const rep = ok(await h.api.stats.report(YR), 'отчет ' + YR);
  assert.equal(cents(rep.fines.late.charged), 40);
  assert.equal(cents(rep.fines.loss.charged), 1050);
  assert.equal(cents(rep.finesCharged), 1090, 'начислени = забави + изгубени, без таксата и без опростеното');
  assert.equal(cents(rep.fines.late.collected), 240, '0,40 за тази година + 2,00 стар дълг');
  assert.equal(cents(rep.fines.loss.collected), 510);
  assert.equal(cents(rep.finesCollected), 750);
  assert.equal(cents(rep.fines.late.otherYears), 200, 'старият дълг се брои отделно');
  assert.ok(rep.finesCollected - (rep.fines.late.otherYears + rep.fines.loss.otherYears) <= rep.finesCharged + 0.001,
    'събраното по начисленията на годината не надхвърля начисленото');
  // Екранът назовава видовете и обяснява разликата.
  await h.window.eval('STATS_YEAR = "' + YR + '"');
  await h.go('stats');
  const t = h.viewText();
  assert.match(t, new RegExp('Начислени обезщетения ' + E.mny(10.9).replace(/[.]/g, '\\.')));
  assert.match(t, /· забави \(чл\. 43\) 0\.40 €/);
  assert.match(t, /· за изгубени и повредени документи 10\.50 €/);
  assert.match(t, /от събраните — по начисления от други години 2\.00 €/);
  assert.match(t, /„Начислени“ — сумите, вписани в сметките на читателите през 2019 г\./);
  await h.window.eval('STATS_YEAR = null');
});
