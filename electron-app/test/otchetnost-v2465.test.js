'use strict';
/* ОТЧЕТНОСТ И ДНЕВНИК — поправките от кръг 42 (v2.4.65).
   =====================================================================
   За всяка находка по един тест, който ПАДА, ако поправката се върне назад.
   Тестовете твърдят онова, което библиотекарката вижда: реда в базата, текста
   на известието, надписа на екрана и числото на разпечатката — не вътрешната
   форма на данните.

   Находки: Б15 (видовете DVD/говорещи книги/патент/друго), Б16 (колоната
   „Славянски“), Б17 („2,7“ в клетка), Б18 (посещенията на две места), В1
   (ден от нули), В2 (печат на празен месец), В3 (затворен ден), В4
   (обяснението за трите „Всичко“ на подписания лист), В12 (наръчникът) и
   находката за четирите „Всичко“ на Раздел А. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { APP_DIR, freshDb, fakeIpcMain, runDep, cleanupTmpDirs, buildDom, settle } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

/* --- общ стенд: Дневник + Табло + Справки върху една и съща база ------------ */
function setup(opts) {
  const o = opts || {};
  const { db } = freshDb('otchetnost-v2465-');
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db, run: runDep, logAudit: () => {},
    yearOf: () => '2026', today: () => (o.today || '2026-05-04'),
    value: () => 0,
    pctRequired: () => 10, isWorkDay: () => true, LOAN_SELECT: 'SELECT l.* FROM loans l',
    effectiveDaysLate: () => 0,
    dialog: { showSaveDialog: async () => ({ canceled: true }) }, getMainWindow: () => ({}), fs
  };
  const { dnevnikSumRow } = require(path.join(APP_DIR, 'handlers', 'dnevnik'))(ipcMain, deps);
  require(path.join(APP_DIR, 'handlers', 'stats'))(ipcMain, Object.assign({ dnevnikSumRow }, deps));
  require(path.join(APP_DIR, 'handlers', 'dashboard'))(ipcMain, deps);
  return { db, ipcMain };
}
const ok = (r) => { assert.equal(r.ok, true, r.error); return r.data; };
const fail = (r) => { assert.equal(r.ok, false, 'очакваше се отказ, а мина: ' + JSON.stringify(r.data)); return r.error; };
/* Заемане на един ден: книга от даден вид/език/УДК + събитието за него. */
function loan(db, i, { cat, lang, udk, code }) {
  let catId = null;
  if (cat) {
    const found = db.prepare('SELECT id FROM categories WHERE name = ?').get(cat);
    if (found) catId = found.id;
    else catId = db.prepare('INSERT INTO categories (name, code) VALUES (?, ?)').run(cat, code || null).lastInsertRowid;
  }
  db.prepare("INSERT INTO books (id, inv_number, title, category_id, language, udk, register_date) VALUES (?,?,?,?,?,?,'2026-01-01')")
    .run(i, String(i), 'Документ ' + i, catId, lang || 'български', udk || '0');
  db.prepare(`INSERT INTO events (date, kind, book_id, reader_id, reader_category, book_language, book_udk, book_category)
    VALUES ('2026-05-04','заемане',?,?,'над 28 г.',?,?,?)`).run(i, 500 + i, lang || 'български', udk || '0', cat || null);
}

/* ============================ Б15 ========================================= */
test('Б15: DVD и говорещите книги влизат в СВОИТЕ колони на формуляра, а не в „Книги“', () => {
  const { db, ipcMain } = setup();
  loan(db, 1, { cat: 'DVD' });
  loan(db, 2, { cat: 'говореща книга' });
  loan(db, 3, { cat: 'книга', code: 'book' });
  const s = ok(ipcMain.invoke('dnevnik:suggest', { date: '2026-05-04' })).suggestions;
  assert.equal(s.b_type_dvd, 1, 'колоната „DVD“ на официалния формуляр вече получава число');
  assert.equal(s.b_type_talking, 1, 'колоната „Говорещи книги“ — надомното обслужване на незрящи работи с тях');
  assert.equal(s.b_type_books, 1, 'в „Книги“ остава само истинската книга');
});

test('Б15: патент/стандарт и „друго“ се броят в „Книги“, но се НАЗОВАВАТ поименно', () => {
  const { db, ipcMain } = setup();
  loan(db, 1, { cat: 'патент/стандарт', code: 'patent' });
  loan(db, 2, { cat: 'друго', code: 'other' });
  loan(db, 3, { cat: 'книга', code: 'book' });
  const r = ok(ipcMain.invoke('dnevnik:suggest', { date: '2026-05-04' }));
  // Редът „Всичко по вид“ остава равен на броя заемания — иначе формулярът не се събира.
  const byType = Object.keys(r.suggestions).filter(k => k.startsWith('b_type_'))
    .reduce((a, k) => a + r.suggestions[k], 0);
  assert.equal(byType, 3);
  const names = (r.typeFallback || []).map(([n]) => n).sort();
  assert.deepEqual(names, ['друго', 'патент/стандарт'],
    'двата вида без ред във формуляра се връщат поименно, вместо да паднат тихо в „Книги“');
});

test('Б15: вид, измислен от библиотекарката, също се назовава, а не изчезва в „Книги“', () => {
  const { db, ipcMain } = setup();
  loan(db, 1, { cat: 'настолна игра' });
  const r = ok(ipcMain.invoke('dnevnik:suggest', { date: '2026-05-04' }));
  assert.deepEqual(r.typeFallback, [['настолна игра', 1]]);
  assert.equal(r.typeMissing, 0);
});

test('Б15: документ БЕЗ посочен вид се брои отделно — изходът му е друг', () => {
  const { db, ipcMain } = setup();
  loan(db, 1, { cat: null });
  loan(db, 2, { cat: 'патент/стандарт', code: 'patent' });
  const r = ok(ipcMain.invoke('dnevnik:suggest', { date: '2026-05-04' }));
  assert.equal(r.typeMissing, 1, 'там се попълва картонът на документа, а не се мести колона');
  assert.deepEqual(r.typeFallback, [['патент/стандарт', 1]]);
});

/* ============================ Б16 ========================================= */
test('Б16: сръбски, полски, чешки и украински влизат в колоната „Славянски“', () => {
  const { db, ipcMain } = setup();
  ['сръбски', 'полски', 'чешки', 'украински'].forEach((l, i) => loan(db, i + 1, { cat: 'книга', code: 'book', lang: l }));
  loan(db, 9, { cat: 'книга', code: 'book', lang: 'испански' });
  const s = ok(ipcMain.invoke('dnevnik:suggest', { date: '2026-05-04' })).suggestions;
  assert.equal(s.b_lang_slavic, 4, 'колоната „Славянски“ на Раздел Б вече се предлага');
  assert.equal(s.b_lang_other, 1, 'в „Други“ остава само неславянският');
});

test('Б16: „руски език“ се разпознава като руски — името се сравнява нормализирано', () => {
  const { db, ipcMain } = setup();
  loan(db, 1, { cat: 'книга', code: 'book', lang: ' Руски език ' });
  const s = ok(ipcMain.invoke('dnevnik:suggest', { date: '2026-05-04' })).suggestions;
  assert.equal(s.b_lang_ru, 1);
  assert.equal(s.b_lang_other, undefined);
});

/* ============================ Б17 ========================================= */
test('Б17: „2,7“ в клетка на Дневника се ОТКАЗВА с обяснение, а клетката не влиза в базата', () => {
  const { db, ipcMain } = setup();
  const err = fail(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-04', a_age_o28: '2,7' }));
  assert.match(err, /цяло число, 0 или повече/);
  assert.match(err, /2,7/, 'съобщението показва въведеното, за да се намери клетката');
  assert.match(err, /Възраст — над 28 г/, 'и назовава колоната по името ѝ от формуляра');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dnevnik_days WHERE date='2026-05-04'").get().n, 0,
    'дотук се записваше 2, докато клетката продължаваше да показва 2,7');
});

test('Б17: „2.7“ и „3abc“ също не се отрязват мълчаливо; „-5“ пази старото съобщение; празна клетка е 0', () => {
  const { db, ipcMain } = setup();
  assert.match(fail(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-04', a_age_o28: '2.7' })), /цяло число/);
  assert.match(fail(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-04', a_age_o28: '3abc' })), /цяло число/);
  assert.match(fail(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-04', a_age_u14: '-5' })), /не може да бъде отрицателно/);
  ok(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-04', a_age_o28: '', a_age_u14: 3 }));
  const row = db.prepare("SELECT a_age_o28, a_age_u14 FROM dnevnik_days WHERE date='2026-05-04'").get();
  assert.deepEqual(row, { a_age_o28: 0, a_age_u14: 3 }, 'празното поле си остава 0, както в хартиения дневник');
});

/* ============================ Б18 ========================================= */
test('Б18: „Статистика“ връща и двата източника за посещения, разликата и обяснението', () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO visits (date, count) VALUES ('2026-03-02', 40)").run();
  db.prepare("INSERT INTO dnevnik_days (date, a_visit_home, a_visit_child, a_visit_reading) VALUES ('2026-03-02', 52, 7, 0)").run();
  const r = ok(ipcMain.invoke('stats:report', '2026'));
  assert.equal(r.visits, 40, 'показателят продължава да брои СВОЯ източник — не се подменя с трето число');
  assert.equal(r.dnevnikVisits.total, 52, '„деца до 14 г.“ е подмножество и не се събира отделно');
  assert.equal(r.visitsCheck.diff, -12);
  assert.match(r.visitsCheck.a.label, /Впиши посещения/);
  assert.match(r.visitsCheck.b.label, /Дневник на библиотеката/);
  assert.match(r.visitsCheck.why, /нито едното не попълва другото/);
  assert.match(r.visitsCheck.todo, /Дневникът е воден/);
});

test('Б18: воден Дневник без ред в „Впиши посещения“ вече не се чете като „не са вписвани“', () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO dnevnik_days (date, a_visit_home) VALUES ('2026-03-02', 52)").run();
  const r = ok(ipcMain.invoke('stats:report', '2026'));
  assert.equal(r.visitsRecorded, false);
  assert.equal(r.visitsAnyRecorded, true, 'Дневникът е воден изрядно — надписът „не са вписвани“ би бил неверен');
});

test('Б18: „Впиши посещения“ връща какво пише в Дневника за СЪЩИЯ ден', () => {
  const { db } = setup();
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'visits'))(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  db.prepare("INSERT INTO dnevnik_days (date, a_visit_home, a_visit_child, a_visit_reading) VALUES ('2026-05-04', 12, 3, 1)").run();
  const r = ok(ipcMain.invoke('visits:add', { date: '2026-05-04', count: 5 }));
  assert.equal(r.total, 5);
  assert.equal(r.dnevnik.recorded, true);
  assert.equal(r.dnevnik.total, 13, 'деца до 14 г. е подмножество и не се събира отделно');
  assert.equal(r.dnevnik.home, 12);
  const r2 = ok(ipcMain.invoke('visits:add', { date: '2026-05-05', count: 5 }));
  assert.equal(r2.dnevnik.recorded, false, 'ден без ред в Дневника не се обявява за разминаване');
});

/* ============================ В1 ========================================== */
test('В1: „Запиши деня“ върху празен формуляр не прави деня „попълнен“ нито на таблото, нито в отчета', () => {
  const { ipcMain } = setup({ today: '2026-05-04' });
  const A = ['a_hours', 'a_age_u14', 'a_age_15_18', 'a_age_19_28', 'a_age_o28', 'a_sex_boys', 'a_sex_men',
    'a_sex_girls', 'a_sex_women', 'a_edu_basic', 'a_edu_sec', 'a_edu_high'];
  const empty = { date: '2026-05-04' };
  A.forEach(f => { empty[f] = 0; });
  empty.b_type_books = 0;
  ok(ipcMain.invoke('dnevnik:saveDay', empty));
  assert.equal(ok(ipcMain.invoke('dashboard:full')).today.dnevnikFilled, false,
    'подсещалката на таблото не бива да изчезва заради ден от нули');
  const ann = ok(ipcMain.invoke('reports:run', { id: 'annual_ab', year: '2026' }));
  assert.equal(ann.daysRecorded, 0, 'ден от нули не е „вписан работен ден“ в годишния отчет');
  assert.equal(ann.daysWithRow, 1, '… но редът си стои и разликата се казва на екрана');
});

test('В1: ден само с бележка СЕ брои — „затворено, ремонт“ е валидно вписване', () => {
  const { ipcMain } = setup({ today: '2026-05-04' });
  ok(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-04', note: 'затворено — ремонт' }));
  assert.equal(ok(ipcMain.invoke('dashboard:full')).today.dnevnikFilled, true);
  assert.equal(ok(ipcMain.invoke('reports:run', { id: 'annual_ab', year: '2026' })).daysRecorded, 1);
});

/* ============================ В3 ========================================== */
test('В3: затворен по календара ден е отбелязан в месеца и работата в него се съобщава', () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO calendar_closed (date, reason) VALUES ('2026-05-04', 'ремонт')").run();
  const m = ok(ipcMain.invoke('dnevnik:getMonth', { year: 2026, month: 5 }));
  const d4 = m.days.find(d => d.date === '2026-05-04');
  assert.equal(d4.closed, true);
  assert.equal(d4.closedReason, 'ремонт');
  assert.equal(m.days.find(d => d.date === '2026-05-05').closed, false);
  const res = ok(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-04', a_age_o28: 5 }));
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /затворен ден/);
  assert.match(res.warnings[0], /ремонт/);
  assert.match(res.warnings[0], /Настройки → Календар/, 'съобщението назовава изхода, не само проблема');
});

test('В3: неработен ден от седмицата също е затворен ден, а годишният отчет го обявява', () => {
  const { db, ipcMain } = setup();
  db.prepare("UPDATE settings SET work_days = '1,2,3,4,5' WHERE id = 1").run();
  const m = ok(ipcMain.invoke('dnevnik:getMonth', { year: 2026, month: 5 }));
  assert.equal(m.days.find(d => d.date === '2026-05-03').closed, true, '3 май 2026 е неделя');
  assert.equal(m.days.find(d => d.date === '2026-05-04').closed, false, '4 май 2026 е понеделник');
  ok(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-03', a_age_o28: 4 }));
  ok(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-04', a_age_o28: 4 }));
  const ann = ok(ipcMain.invoke('reports:run', { id: 'annual_ab', year: '2026' }));
  assert.equal(ann.daysRecorded, 2);
  assert.equal(ann.daysOnClosed, 1, 'вписаният затворен ден се брои поименно, а не тихо за работен');
});

/* ======================= находка А (Раздел А) ============================= */
test('А: предложението връща четирите „Всичко“ на Раздел А, за да се види какво остава ръчно', () => {
  const { db, ipcMain } = setup();
  loan(db, 1, { cat: 'книга', code: 'book' });
  db.prepare(`INSERT INTO events (date, kind, book_id, reader_id, reader_category, book_language, book_udk, book_category)
    VALUES ('2026-05-04','заемане',1,777,'дете до 14 г.','български','0','книга')`).run();
  const r = ok(ipcMain.invoke('dnevnik:suggest', { date: '2026-05-04' }));
  assert.deepEqual(
    { age: r.sectionA.age, sex: r.sectionA.sex, edu: r.sectionA.edu, prof: r.sectionA.prof },
    { age: 2, sex: 0, edu: 1, prof: 0 },
    'разминаването се ВРЪЩА — програмата не измисля пол, образование и занятие, но ги казва');
  assert.equal(r.sectionA.visitHome, 0);
  assert.equal(r.sectionA.visitChild, 1);
});

test('А: „Запиши деня“ казва, че четирите „Всичко“ не съвпадат и че децата надхвърлят заемната', () => {
  const { ipcMain } = setup();
  const d = { date: '2026-05-04' };
  ['a_hours', 'a_age_u14', 'a_age_15_18', 'a_age_19_28', 'a_age_o28', 'a_sex_boys', 'a_sex_men', 'a_sex_girls',
    'a_sex_women', 'a_edu_basic', 'a_edu_sec', 'a_edu_high', 'a_prof_industry', 'a_prof_agri', 'a_prof_eng',
    'a_prof_agrospec', 'a_prof_med', 'a_prof_sci', 'a_prof_hum', 'a_prof_creative', 'a_prof_teach', 'a_prof_other',
    'a_stud_uni', 'a_stud_high', 'a_stud_sec', 'a_stud_elem', 'a_visit_home', 'a_visit_child', 'a_visit_reading',
    'a_visit_internet'].forEach(f => { d[f] = 0; });
  d.a_age_u14 = 1; d.a_age_o28 = 1; d.a_visit_child = 1;
  const res = ok(ipcMain.invoke('dnevnik:saveDay', d));
  const txt = res.warnings.join(' | ');
  assert.match(txt, /по възраст 2, по пол 0, по образование 1, по занятие 0/);
  assert.match(txt, /не се пазят в картона на читателя/);
  assert.match(txt, /„деца до 14 г\.“ \(1\) надхвърля/);
});

test('А: редакцията на ЕДНА клетка не вдига предупреждението за Раздел А', () => {
  const { ipcMain } = setup();
  const res = ok(ipcMain.invoke('dnevnik:saveDay', { date: '2026-05-04', a_age_u14: 3 }));
  assert.deepEqual(res.warnings, [], 'иначе би се обаждало при всяко число, вписано по реда си');
});

/* ============================ В12 ========================================= */
test('В12: наръчникът вече не учи на премахнатото поведение на записа', () => {
  const md = fs.readFileSync(path.join(APP_DIR, 'README-bibliotekar.md'), 'utf8');
  const i = md.indexOf('### Дневник на библиотеката');
  const section = md.slice(i, md.indexOf('###', i + 10));
  assert.ok(!/изпраща и стойностите на другия/.test(section),
    'твърдението, че записът на клетка изпраща и другия раздел, е невярно от v2.4.14/v2.4.25');
  assert.match(section, /само тази колона/);
  assert.match(section, /цели числа, 0 или повече/);
  assert.match(section, /Славянски/);
  assert.match(section, /говорещи(те)? книги/i);
  assert.match(section, /на две места/, 'двата дневника за посещения са описани');
});

/* ==================== екранът и разпечатката (jsdom) ====================== */
const A_ZERO = {};
['a_hours', 'a_age_u14', 'a_age_15_18', 'a_age_19_28', 'a_age_o28'].forEach(k => { A_ZERO[k] = 0; });
function monthStub(over) {
  const days = [];
  for (let d = 1; d <= 31; d++) {
    days.push(Object.assign({ day: d, date: '2026-05-' + String(d).padStart(2, '0'), closed: false, filled: false }, A_ZERO));
  }
  return Object.assign({ year: 2026, month: 5, daysInMonth: 31, days, monthTotal: {}, ytdTotal: {},
    daysFilled: 0, daysFilledClosed: 0, ytdDaysFilled: 0 }, over || {});
}

test('В2: печатът на Дневника за месец без нито един вписан ден си го казва на листа', async () => {
  const dom = buildDom({ 'dnevnik.getMonth': monthStub() });
  const w = dom.window;
  await settle();
  await w.renderDnevnik();
  await settle();
  assert.match(w.document.querySelector('#view').textContent, /няма нито един вписан ден/, 'и на екрана');
  w.printDnevnikDoc();
  const p = w.document.querySelector('#ppSheet').textContent.replace(/\s+/g, ' ');
  assert.match(p, /ДНЕВНИК НА БИБЛИОТЕКАТА/);
  assert.match(p, /няма нито един вписан ден/,
    'дотук листът излизаше като готов за подпис формуляр от нули, без нито дума защо');
});

test('В3: затвореният ден е отбелязан в таблицата на екрана', async () => {
  const st = monthStub();
  st.days[3].closed = true; st.days[3].closedReason = 'ремонт';
  const dom = buildDom({ 'dnevnik.getMonth': st });
  const w = dom.window;
  await settle();
  await w.renderDnevnik();
  await settle();
  const tr = w.document.querySelector('.dnvCell[data-date="2026-05-04"]').closest('tr');
  assert.match(tr.className, /dnvClosed/, 'редът на затворения ден се различава от останалите');
  assert.match(tr.textContent, /затв/);
  assert.match(w.document.querySelector('#view').textContent, /затворени по календара/);
});

test('В4: отпечатаният Раздел Б носи обяснението защо трите „Всичко“ се разминават', async () => {
  const totals = { b_total_type: 2, b_total_lang: 2, b_total_content: 1, b_type_books: 1, b_type_period: 1 };
  const st = monthStub({ monthTotal: totals, daysFilled: 1 });
  const dom = buildDom({ 'dnevnik.getMonth': st });
  const w = dom.window;
  await settle();
  w.eval("DNEVNIK_TAB = 'b'");
  await w.renderDnevnik();
  await settle();
  w.printDnevnikDoc();
  const p = w.document.querySelector('#ppSheet').textContent.replace(/\s+/g, ' ');
  assert.match(p, /по вид 2, по език 2, по съдържание 1/,
    'проверяващият вижда трите числа обяснени на самия подписан лист');
  assert.match(p, /периодичните издания се броят по вид, не по съдържание/);
});

test('В4: годишният отчет носи същото обяснение — на екрана и на хартията', async () => {
  const REP = { id: 'annual_ab', year: '2026', daysRecorded: 1, daysWithRow: 1, daysOnClosed: 0,
    totals: { b_total_type: 3, b_total_lang: 3, b_total_content: 1 } };
  const dom = buildDom({
    'reports.list': [{ id: 'annual_ab', title: 'Годишен статистически отчет — Раздел А и Б', needsYear: true }],
    'reports.run': REP
  });
  const w = dom.window;
  await settle();
  await w.renderReports();
  await settle();
  assert.match(w.document.querySelector('#view').textContent, /по вид 3, по език 3, по съдържание 1/);
  w.printReportDoc();
  assert.match(w.document.querySelector('#ppSheet').textContent.replace(/\s+/g, ' '),
    /по вид 3, по език 3, по съдържание 1/);
});

test('В1/В3: надписът на годишния отчет казва и празните дни, и вписаните в затворен ден', async () => {
  const dom = buildDom({
    'reports.list': [{ id: 'annual_ab', title: 'Годишен статистически отчет — Раздел А и Б', needsYear: true }],
    'reports.run': { id: 'annual_ab', year: '2026', daysRecorded: 12, daysWithRow: 15, daysOnClosed: 2, totals: {} }
  });
  const w = dom.window;
  await settle();
  await w.renderReports();
  await settle();
  const t = w.document.querySelector('#view').textContent.replace(/\s+/g, ' ');
  assert.match(t, /обхваща 12 вписани работни дни/);
  assert.match(t, /3 дни са отваряни в Дневника, но са останали без нито едно число/);
  assert.match(t, /2 са в дни, отбелязан\(и\) като затворен\(и\)/);
});

test('Б18: „Статистика“ казва кое число откъде идва и сравнява двата дневника', async () => {
  const R = {
    year: '2026', fundCount: 0, fundValue: 0, readersCount: 0, loansCount: 0,
    acquiredCount: 0, acquiredValue: 0, deaccessionedCount: 0, deaccessionedValue: 0,
    returnedOnTime: 0, returnedLate: 0, finesCollected: 0, finesCharged: 0, finesOpen: 0, openOverdue: 0,
    fundByLanguage: [], fundByDepartment: [], fundByCategory: [], topLoans: [],
    visits: 40, visitsRecorded: true, visitsAnyRecorded: true,
    dnevnikVisits: { home: 52, child: 7, reading: 0, internet: 0, total: 52 },
    visitsCheck: {
      a: { label: 'Статистика → „Впиши посещения“ (дневник на посещенията по БДС ISO 2789)', n: 40 },
      b: { label: 'Дневник на библиотеката, Раздел А (в заемна за дома + в читалня + интернет)', n: 52 },
      diff: -12, why: 'Двете се водят на различни места и нито едното не попълва другото.',
      todo: 'Дневникът е воден, а дневникът на посещенията изостава.'
    }
  };
  const dom = buildDom({ 'stats.report': R });
  const w = dom.window;
  await settle();
  await w.renderStats();
  await settle();
  const t = w.document.querySelector('#view').textContent.replace(/\s+/g, ' ');
  assert.match(t, /Посещения — „Впиши посещения“/, 'показателят вече назовава източника си');
  assert.match(t, /Посещенията се водят на две места/);
  assert.match(t, /Дневник на библиотеката, Раздел А/);
  assert.match(t, /-12|−12/, 'разликата стои на екрана, както при съгласуването на фонда');
  assert.match(t, /подмножество, не се събира отделно/);
});

test('Б17: клетка с „2,7“ не се праща към базата и се връща на предишната стойност', async () => {
  const st = monthStub();
  st.days[9].a_age_o28 = 3;
  const dom = buildDom({ 'dnevnik.getMonth': st });
  const w = dom.window;
  await settle();
  await w.renderDnevnik();
  await settle();
  const cell = w.document.querySelector('.dnvCell[data-date="2026-05-10"][data-field="a_age_o28"]');
  assert.ok(cell, 'няма клетка');
  cell.value = '2,7';
  cell.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  assert.equal(cell.value, '3', 'клетката се връща на вписаното преди това');
  assert.equal(dom.calls['dnevnik.saveDay'], undefined, 'нищо не тръгва към базата');
});

test('А: подсказката под „⚡ Предложи от регистрите“ изписва четирите „Всичко“ и видовете без ред', async () => {
  const dom = buildDom({
    'dnevnik.getMonth': monthStub(),
    'dnevnik.suggest': {
      date: '2026-05-04', eventsCount: 3, unclassified: 0, periodicalsByType: 0,
      suggestions: { a_age_u14: 1, a_age_o28: 1, a_edu_basic: 0, a_visit_child: 1, b_type_books: 2 },
      typeFallback: [['патент/стандарт', 1]],
      sectionA: { age: 2, sex: 0, edu: 1, prof: 0, visitHome: 0, visitChild: 1 }
    }
  });
  const w = dom.window;
  await settle();
  await w.dnevnikDayForm('2026-05-04');
  await settle();
  await w.dnevnikSuggest('2026-05-04');
  await settle();
  const hint = w.document.querySelector('#dnvSugHint').textContent.replace(/\s+/g, ' ');
  assert.match(hint, /по възраст 2, по пол 0, по образование 1, по занятие 0/);
  assert.match(hint, /не се пазят в картона на читателя/);
  assert.match(hint, /патент\/стандарт/);
  assert.match(hint, /без собствен ред във формуляра/);
});
