'use strict';
/* РЕГРЕСИИ ОТ КРЪГ 37 (v2.4.61) — ПЕРИОДИКА.
 * ===========================================================================
 * По една проверка на находка от сценария test/scenario-periodika.test.js.
 * Сценарият разказва деня на библиотекарката от край до край; тук стои само
 * дефектът — кратко, с фиксирана дата и без излишна обстановка, за да се вижда
 * при бъдещо пипане какво точно не бива да се връща.
 *
 * Файлът е на две части:
 *   • обработчиците (пряко върху прясна база, както test/handlers-periodicals.js);
 *   • екраните (истинският renderer в jsdom през test/helpers/e2e-app.js) — за
 *     находките, които са ВИДИМИ: прозорецът по година, разминаването между
 *     кардекса и подвързания комплект, двете нови разпечатки и партидата, която
 *     се завеждаше два пъти.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const E = require('./helpers/e2e-app');

const APP_DIR = path.join(__dirname, '..');
const registerPeriodicals = require(path.join(APP_DIR, 'handlers', 'periodicals'));
const registerCategories = require(path.join(APP_DIR, 'handlers', 'categories'));
const registerDnevnik = require(path.join(APP_DIR, 'handlers', 'dnevnik'));
const { applyEnumTriggers } = require(path.join(APP_DIR, 'db', 'enum-triggers'));

const TODAY = '2026-06-15';
const Y = '2026';
const Y1 = '2025';

const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* временна папка — няма какво да се спасява */ }
  }
});

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

/* Прясна база по СХЕМАТА (db/schema.sql) плюс тригерите за номенклатурите —
   точно каквото получава нова инсталация. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-periodika-v2461-'));
  tmpDirs.push(dir);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  applyEnumTriggers(db);
  const audit = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: (action, detail) => audit.push({ action, detail }),
    today: () => TODAY,
    yearOf: (d) => String(d || TODAY).slice(0, 4),
    scheduleCatalogWrite: () => {},
    checkRecordLimit: () => {},
    dialog: {}, getMainWindow: () => ({}), fs
  };
  registerPeriodicals(ipcMain, deps);
  registerCategories(ipcMain, deps);
  registerDnevnik(ipcMain, deps);
  return { db, ipcMain, audit, dir };
}
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const fail = (r) => { assert.equal(r.ok, false, 'очакваше се отказ, а мина: ' + JSON.stringify(r.data)); return r.error; };
const mkPer = (t, o) => ok(t.ipcMain.invoke('periodicals:create', Object.assign({ title: 'Труд', freq: 'ежедневно' }, o)), 'издание');
const addIssue = (t, pid, no, date, price) =>
  t.ipcMain.invoke('periodicalIssues:add', { periodical_id: pid, issue_no: no, date, price });

/* ==================================================================
   Находка 1 — ежедневникът няма периодичност
   ================================================================== */
test('находка 1: вестник, който излиза всеки ден, се завежда „ежедневно“ и предвиждането е след 1 ден', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Труд', freq: 'ежедневно' });
  assert.equal(t.db.prepare('SELECT freq FROM periodicals WHERE id = ?').get(pid).freq, 'ежедневно',
    'тригерът за номенклатурата приема новата стойност');
  ok(await addIssue(t, pid, '140', '2026-06-12', 0.85), 'брой отпреди три дни');
  const p = ok(await t.ipcMain.invoke('periodicals:list'), 'списък').find(x => x.id === pid);
  assert.equal(p.next_expected, '2026-06-13', 'следващият брой се очаква на другия ден, не след седмица');
  assert.equal(p.issue_overdue_days, 2, 'два дни без вестник се виждат на таблото');
  // „нередовно“ остава без предвиждане — така ежедневникът вече няма защо да се води така.
  const nid = mkPer(t, { title: 'Бюлетин', freq: 'нередовно' });
  ok(await addIssue(t, nid, '1', '2020-01-01', 0), 'стар брой');
  assert.equal(ok(await t.ipcMain.invoke('periodicals:list'), 'списък').find(x => x.id === nid).next_expected, null);
});

test('находка 1: трите списъка за периодичност не се разминават (изглед, обработчик, база)', () => {
  const core = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'core.js'), 'utf8');
  const handler = fs.readFileSync(path.join(APP_DIR, 'handlers', 'periodicals.js'), 'utf8');
  const triggers = fs.readFileSync(path.join(APP_DIR, 'db', 'enum-triggers.js'), 'utf8');
  const main = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  const per = /const PER_FREQ = \[([^\]]+)\]/.exec(core)[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  const freqRow = /\{ table: 'periodicals', col: 'freq', values: \[([^\]]+)\]/.exec(triggers)[1]
    .split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(freqRow, per, 'изборът във формата и позволеното от базата трябва да са един списък');
  assert.match(handler, /'ежедневно': \{ days: 1 \}/, 'обработчикът знае интервала на ежедневника');
  /* Пресъздаването на тригерите за ВЕЧЕ РАБОТЕЩА база: без миграция новата
     стойност стига само до нови инсталации (виж бележката в db/enum-triggers.js). */
  const mig = main.slice(main.indexOf('{ version: 16, run: () => {'));
  assert.match(mig.slice(0, mig.indexOf('} }')), /applyEnumTriggers\(db\)/,
    'миграция 16 прилага наново тригерите, иначе заварената база отказва „ежедневно“');
});

/* ==================================================================
   Находки 2 и 3 — двойник на изданието и ISSN
   ================================================================== */
test('находка 2: второ издание със същото заглавие или ISSN не се завежда', async () => {
  const t = setup();
  mkPer(t, { title: 'Труд', freq: 'ежедневно', issn: '1313-7719' });
  assert.match(fail(await t.ipcMain.invoke('periodicals:create', { title: 'Труд', freq: 'ежедневно' })),
    /вече е заведено в картотеката/);
  assert.match(fail(await t.ipcMain.invoke('periodicals:create', { title: '  Труд  ', freq: 'ежедневно' })),
    /вече е заведено/, 'интервалите отпред и отзад не правят ново издание');
  assert.match(fail(await t.ipcMain.invoke('periodicals:create', { title: 'Труд (в-к)', freq: 'ежедневно', issn: '1313-7719' })),
    /ISSN 1313-7719 вече е записан/);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM periodicals').get().n, 1, 'нищо не е влязло');
  // Различно заглавие и различен ISSN минават, а редакцията на САМОТО издание — също.
  const other = mkPer(t, { title: 'Читалище', freq: 'месечно', issn: '0324-0975' });
  ok(await t.ipcMain.invoke('periodicals:update', { id: other, title: 'Читалище', freq: 'месечно', issn: '0324-0975' }),
    'записът не е двойник сам на себе си');
  assert.match(fail(await t.ipcMain.invoke('periodicals:update', { id: other, title: 'Труд', freq: 'месечно' })),
    /вече е заведено/, 'и преименуването не може да направи двойник');
});

test('находка 3: ISSN се проверява по ISO 3297 — формат и контролен знак', async () => {
  const t = setup();
  assert.match(fail(await t.ipcMain.invoke('periodicals:create', { title: 'А', issn: '12345' })), /ISO 3297/);
  assert.match(fail(await t.ipcMain.invoke('periodicals:create', { title: 'Б', issn: '1313-7711' })),
    /грешен контролен знак/, 'разменена цифра се улавя от контролната цифра');
  const id = mkPer(t, { title: 'В', freq: 'месечно', issn: '13137719' });
  assert.equal(t.db.prepare('SELECT issn FROM periodicals WHERE id = ?').get(id).issn, '1313-7719',
    'тирето се поставя само — библиотекарката преписва от главата на вестника');
  const x = mkPer(t, { title: 'Г', freq: 'месечно', issn: 'ISSN 0000-006X' });
  assert.equal(t.db.prepare('SELECT issn FROM periodicals WHERE id = ?').get(x).issn, '0000-006X',
    'контролният знак „X“ е законен (означава 10)');
});

test('находка 3: сгрешеният ФОРМАТ на ISSN се назовава като формат, а не като контролен знак', async () => {
  /* Двете проверки казват РАЗЛИЧНИ неща и пращат библиотекарката на различни
     места: „не е във формат по ISO 3297“ значи „преписали сте нещо друго“, а
     „грешен контролен знак“ значи „разменена е цифра — сверете с главата на
     изданието“. Дотук горният тест искаше само низа „ISO 3297“, който стои и в
     двете съобщения — тоест ако проверката за формат отпадне, „12345“ пак се
     отказва (защото контролната цифра на пет знака е NaN) и нищо не личи, а
     съобщението говори за знак, който изданието няма. */
  const t = setup();
  for (const bad of ['12345', '1313-77190', 'АБВГ-1234']) {
    const err = fail(await t.ipcMain.invoke('periodicals:create', { title: 'Формат ' + bad, issn: bad }));
    assert.match(err, /не е във формат по ISO 3297/, 'ISSN „' + bad + '“: ' + err);
    assert.match(err, /очакват се осем знака/);
    assert.doesNotMatch(err, /грешен контролен знак/,
      'отказът за формат не бива да се представя като сгрешена контролна цифра: ' + err);
  }
  /* И обратното: осем знака с разменена цифра е ДРУГИЯТ отказ — по контролната
     цифра, с указание да се свери с главата на изданието. */
  const cd = fail(await t.ipcMain.invoke('periodicals:create', { title: 'Контролна', issn: '1313-7711' }));
  assert.match(cd, /грешен контролен знак/);
  assert.doesNotMatch(cd, /не е във формат/);
});

/* ==================================================================
   Находки 4 и 5 — дублиран брой и дата от бъдещето
   ================================================================== */
test('находка 4: един и същ брой (номер и дата) не се вписва два пъти', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Читалище', freq: 'месечно' });
  ok(await addIssue(t, pid, '2', '2026-02-14', 3.5), 'бр. 2');
  const err = fail(await addIssue(t, pid, '2', '2026-02-14', 3.5));
  assert.match(err, /вече е вписан в кардекса/);
  assert.match(err, /сбор|стойност|годината/, 'казва се защо е важно — сборът става цена на комплекта');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM periodical_issues').get().n, 1);
  // Същият номер с ДРУГА дата е друг физически брой и минава.
  ok(await addIssue(t, pid, '2', '2026-02-21', 3.5), 'притурка/повторно издание');
  /* И базата пази същото правило — двете работни места не се виждат едно друго.
     Уникалният индекс обаче се създава от МИГРАЦИЯ 16, не от schema.sql: върху
     заварена база с повтарящи се броеве CREATE UNIQUE INDEX се проваля, а
     schema.sql минава при всяко стартиране и db.exec() спира на първата грешка
     (виж дългата бележка при periodical_issues в db/schema.sql). Тази фикстура
     вдига само схемата, без миграциите — затова тук се проверява, че индексът
     НЕ идва от схемата, а работата му върху истински стартирала програма се
     проверява в test/pregled-v2461.test.js през истинския main.js. */
  assert.equal(t.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_per_issue_unique'").get(),
    undefined, 'индексът не бива да се създава от schema.sql — мястото му е в миграция 16');
});

test('находка 5: брой с дата от бъдещето се отказва и не заглушава предупреждението на таблото', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Наука', freq: 'тримесечно' });
  ok(await addIssue(t, pid, '1', '2026-01-10', 8), 'брой от януари');
  const err = fail(await addIssue(t, pid, '2', '2027-03-01', 8));
  assert.match(err, /в бъдещето/);
  assert.match(err, /2026-06-15/, 'казва коя е днешната дата — най-често е сгрешена годината');
  const p = ok(await t.ipcMain.invoke('periodicals:list'), 'списък').find(x => x.id === pid);
  assert.equal(p.next_expected, '2026-04-10');
  assert.ok(p.issue_overdue_days > 0, 'изданието си остава закъсняло, вместо да изчезне от таблото');
  ok(await addIssue(t, pid, '2', TODAY, 8), 'днешна дата минава');
});

/* ==================================================================
   Находка 6 — кардексът по година
   ================================================================== */
test('находка 6: periodicals:get връща броевете на ЕДНА година и казва колко са всичките', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Труд', freq: 'ежедневно' });
  for (let i = 1; i <= 5; i++) ok(await addIssue(t, pid, String(i), Y1 + '-03-0' + i, 0.85), 'минала година');
  for (let i = 1; i <= 3; i++) ok(await addIssue(t, pid, String(i), Y + '-03-0' + i, 0.85), 'тази година');
  const cur = ok(await t.ipcMain.invoke('periodicals:get', pid), 'по подразбиране');
  assert.equal(cur.issue_year, Y, 'отваря се текущата година — в нея се работи всеки ден');
  assert.equal(cur.issues.length, 3);
  assert.equal(cur.issue_total, 8, 'общият брой се връща за надписа „показани N от M“');
  assert.deepEqual(cur.issue_years.map(x => [x.year, x.n]), [[Y, 3], [Y1, 5]]);
  assert.equal(ok(await t.ipcMain.invoke('periodicals:get', pid, { year: Y1 }), 'минала').issues.length, 5);
  assert.equal(ok(await t.ipcMain.invoke('periodicals:get', pid, { year: 'всички' }), 'всички').issues.length, 8);
  /* Издание, чийто абонамент е спрян: текущата година е празна, но кардексът не
     бива да изглежда като изгубени данни — отваря се последната година с броеве. */
  const old = mkPer(t, { title: 'Спряно списание', freq: 'месечно' });
  ok(await addIssue(t, old, '1', Y1 + '-05-05', 2), 'стар брой');
  assert.equal(ok(await t.ipcMain.invoke('periodicals:get', old), 'спряно').issue_year, Y1);
});

/* ==================================================================
   Находки 7, 9, 11 — какво влиза в инвентарната книга
   ================================================================== */
test('находка 7: годишен комплект без нито един брой и без цена не влиза в инвентарната книга', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Наука', freq: 'тримесечно' });
  const err = fail(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: '2023' }));
  assert.match(err, /няма нито един вписан брой/);
  assert.match(err, /0,00 €|подвързан/, 'обяснява се кой е законният случай — вече подвързан комплект');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 0);
  // Вече подвързан комплект (дарение/откупен том) има стойност по документа и минава.
  ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: '2023', price: 40 }), 'подвързан том');
  // Изрично потвърждение — за дарен том с нулева оценка.
  ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: '2022', confirm_empty: true }), 'с потвърждение');
  // Абонаментът за ИДНАТА година се завежда през декември — тогава броеве още няма.
  ok(await t.ipcMain.invoke('periodicalVolumes:register',
    { periodical_id: pid, year: '2027', register_date: '2026-12-20' }), 'абонамент за идната година');
});

test('находка 9: дата на вписване преди годината на комплекта се отказва', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Наука', freq: 'тримесечно' });
  ok(await addIssue(t, pid, '1', Y + '-02-10', 8), 'брой');
  const err = fail(await t.ipcMain.invoke('periodicalVolumes:register',
    { periodical_id: pid, year: Y, register_date: Y1 + '-06-01' }));
  assert.match(err, /преди годината на комплекта/);
  assert.match(err, new RegExp('КДБФ за ' + Y1), 'казва в чий регистър би влязъл документът');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 0);
  // Декемврийската граница остава отворена — абонаментът се плаща преди годината.
  ok(await t.ipcMain.invoke('periodicalVolumes:register',
    { periodical_id: pid, year: Y, register_date: Y1 + '-12-05' }), 'декември на предходната година');
});

test('находка 11: цената на комплекта и снимката на сбора се записват в цели центове', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Труд', freq: 'ежедневно' });
  for (let i = 0; i < 301; i++) {
    ok(await addIssue(t, pid, String(i + 1), E.addDays(Y1 + '-01-02', i), 0.85), 'брой ' + (i + 1));
  }
  const out = ok(await t.ipcMain.invoke('periodicalVolumes:register',
    { periodical_id: pid, year: Y1, register_date: Y + '-01-05' }), 'инвентиране');
  const price = t.db.prepare('SELECT price FROM books WHERE id = ?').get(out.book_id).price;
  assert.equal(price, 255.85, 'не 255.85000000000005 — стойността на документа е пари, не сбор с плаваща опашка');
  assert.equal(t.db.prepare('SELECT issue_sum FROM periodical_volumes WHERE periodical_id = ?').get(pid).issue_sum, 255.85);
});

test('находка 11: сбор с плаваща опашка (3 × 0,10 €) не влиза нито в цената, нито в снимката', async () => {
  /* 301 × 0,85 € излиза точно при днешната SQLite (sum() в нея се смята с
     компенсация по Кахан), тоест горният тест вече не докосва закръглянето и
     една премахната обвивка cents() би минала незабелязано. Три броя по 0,10 €
     обаче дават 0.30000000000000004 и в SQLite, и в JavaScript — най-малкият
     възможен пример за същия дефект, и точно той пази правилото живо: цената на
     документа по чл. 16 и снимката issue_sum са ПАРИ и имат два знака. */
  const t = setup();
  const pid = mkPer(t, { title: 'Стотинки', freq: 'месечно' });
  for (let i = 0; i < 3; i++) ok(await addIssue(t, pid, String(i + 1), Y + '-0' + (i + 1) + '-10', 0.1), 'брой');
  const raw = t.db.prepare('SELECT SUM(price) AS s FROM periodical_issues WHERE periodical_id = ?').get(pid).s;
  assert.notEqual(raw, 0.3, 'самият сбор в базата НОСИ опашката — иначе тестът не проверява нищо');

  const out = ok(await t.ipcMain.invoke('periodicalVolumes:register',
    { periodical_id: pid, year: Y, register_date: Y + '-12-20' }), 'инвентиране');
  assert.equal(t.db.prepare('SELECT price FROM books WHERE id = ?').get(out.book_id).price, 0.3);
  assert.equal(t.db.prepare('SELECT issue_sum FROM periodical_volumes WHERE periodical_id = ?').get(pid).issue_sum, 0.3);
  assert.equal(out.price, 0.3, 'и числото, което прозорецът показва на библиотекарката');
});

/* ==================================================================
   Находки 8, 10, 15, 16 — животът на комплекта във фонда
   ================================================================== */
test('находка 8: след изтриване на сгрешен комплект годината не остава призрак в кардекса', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Наука', freq: 'тримесечно' });
  const out = ok(await t.ipcMain.invoke('periodicalVolumes:register',
    { periodical_id: pid, year: '2023', price: 40 }), 'инвентиране');
  t.db.prepare('DELETE FROM books WHERE id = ?').run(out.book_id); // както „Фонд“ трие сгрешен картон
  assert.equal(t.db.prepare('SELECT book_id FROM periodical_volumes WHERE periodical_id = ?').get(pid).book_id, null);
  const p = ok(await t.ipcMain.invoke('periodicals:get', pid), 'кардекс');
  assert.equal(p.volumes.length, 0, 'годината без броеве и без документ изчезва от картона');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM periodical_volumes WHERE periodical_id = ?').get(pid).n, 0);
  assert.ok(t.audit.some(a => a.action === 'Изчистена връзка към изтрит годишен комплект'),
    'изчистването се вписва — иначе годината изглежда изчезнала сама');
  // И годината може да бъде инвентирана отново.
  ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: '2023', price: 40 }), 'наново');
});

test('находка 10: ръчно въведен инв. №, който прескача номера, оставя предупреждение и следа', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Наука', freq: 'тримесечно' });
  ok(await addIssue(t, pid, '1', Y + '-02-10', 8), 'брой');
  const out = ok(await t.ipcMain.invoke('periodicalVolumes:register',
    { periodical_id: pid, year: Y, inv_number: 40 }), 'инв. № 40');
  assert.ok(out.invGap, 'прозорецът получава какво да покаже');
  assert.equal(out.invGap.from, 1);
  assert.equal(out.invGap.to, 39);
  assert.equal(out.invGap.skipped, 39);
  assert.match(out.invGap.message, /чл\. 17, ал\. 2/);
  const trail = t.audit.find(a => a.action === 'Прескочени инвентарни номера');
  assert.ok(trail, 'следа за проверката: ' + JSON.stringify(t.audit.map(a => a.action)));
  assert.match(trail.detail, /от 1 до 39/);
  assert.equal(t.db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get().next_inv_number, 41);
  // Автоматичният номер (без ръчно въвеждане) не е дупка и не вдига шум.
  ok(await addIssue(t, pid, '2', Y1 + '-02-10', 8), 'брой за миналата година');
  const next = ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y1 }), 'по ред');
  assert.equal(next.invGap, null);
});

test('находка 15: отчисленият комплект не се брои в „Инвентирани комплекти“', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Читалище', freq: 'месечно' });
  ok(await addIssue(t, pid, '1', Y + '-01-15', 3.5), 'брой');
  const out = ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y }), 'инвентиране');
  assert.equal(ok(await t.ipcMain.invoke('periodicals:list'), 'списък').find(x => x.id === pid).volume_count, 1);
  t.db.prepare("UPDATE books SET status = 'отчислен', deaccession_date = ? WHERE id = ?").run(TODAY, out.book_id);
  assert.equal(ok(await t.ipcMain.invoke('periodicals:list'), 'списък').find(x => x.id === pid).volume_count, 0,
    'заглавие, чийто единствен комплект е излязъл от фонда, пак свети с предупредителната нула');
  // Анулиран акт връща документа във фонда — и колоната също.
  t.db.prepare("UPDATE books SET status = 'наличен', deaccession_date = NULL WHERE id = ?").run(out.book_id);
  assert.equal(ok(await t.ipcMain.invoke('periodicals:list'), 'списък').find(x => x.id === pid).volume_count, 1);
});

test('находка 16: след отчисляване годината може да приеме заместващ комплект', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Читалище', freq: 'месечно' });
  ok(await addIssue(t, pid, '1', Y + '-01-15', 3.5), 'брой');
  const first = ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y }), 'първи комплект');
  // Докато е ВЪВ ФОНДА, повторното инвентиране си остава отказано.
  assert.match(fail(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y })),
    /вече е инвентиран/);
  t.db.prepare("UPDATE books SET status = 'отчислен', deaccession_date = ? WHERE id = ?").run(TODAY, first.book_id);
  const repl = ok(await t.ipcMain.invoke('periodicalVolumes:register',
    { periodical_id: pid, year: Y, price: 0, confirm_empty: true }), 'заместващ комплект');
  assert.notEqual(repl.book_id, first.book_id);
  assert.equal(t.db.prepare('SELECT book_id FROM periodical_volumes WHERE periodical_id = ? AND year = ?').get(pid, Y).book_id,
    repl.book_id, 'кардексът сочи живия документ');
  assert.ok(t.db.prepare('SELECT 1 FROM books WHERE id = ?').get(first.book_id), 'отчисленият остава в регистрите');
  assert.match(t.audit.filter(a => a.action === 'Инвентиран годишен комплект').pop().detail,
    new RegExp('замества отчисления комплект инв\\. № ' + first.inv_number));
});

/* ==================================================================
   Находки 19, 20, 21 — видът документ и преименуванията
   ================================================================== */
test('находки 19 и 20: преименуваният вид не се създава втори път и Дневникът пак брои периодика', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Читалище', freq: 'месечно' });
  ok(await addIssue(t, pid, '1', Y + '-01-15', 3.5), 'брой');
  const first = ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y }), 'инвентиране');
  const cat = t.db.prepare("SELECT id, code FROM categories WHERE name = 'продължаващо издание'").get();
  assert.equal(cat.code, 'periodical', 'началният вид носи непроменлив код');
  ok(await t.ipcMain.invoke('categories:update', { id: cat.id, name: 'периодично издание' }), 'преименуване');

  ok(await addIssue(t, pid, '2', Y1 + '-01-15', 3.5), 'брой за миналата година');
  const second = ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y1 }), 'второ инвентиране');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM categories WHERE code = 'periodical'").get().n, 1);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM categories').get().n, 10, 'нова категория не се ражда');
  assert.equal(t.db.prepare('SELECT category_id FROM books WHERE id = ?').get(second.book_id).category_id, cat.id);

  // Дневникът: заемане на двата комплекта се брои по ВИД, независимо от името.
  for (const b of [first.book_id, second.book_id]) {
    t.db.prepare(`INSERT INTO events (date, kind, book_id, book_category, reader_category)
      VALUES (?, 'заемане', ?, 'продължаващо издание', 'възрастен')`).run(TODAY, b);
  }
  const sug = ok(await t.ipcMain.invoke('dnevnik:suggest', { date: TODAY }), 'предложение');
  assert.equal(sug.suggestions.b_type_period, 2, 'и двете влизат в реда „Периодични издания“: ' + JSON.stringify(sug.suggestions));
  assert.equal(sug.suggestions.b_type_books, undefined, 'нито едно не пада в „Книги“');

  // А ако видът наистина липсва — създава се наново, но със следа (находка 20).
  t.db.prepare('UPDATE books SET category_id = NULL').run();
  t.db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  ok(await addIssue(t, pid, '3', '2024-01-15', 3.5), 'брой за 2024');
  ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: '2024' }), 'инвентиране без вид');
  assert.ok(t.audit.some(a => a.action === 'Възстановен вид документ'),
    'мълчаливото INSERT OR IGNORE вече оставя ред в дневника');
});

test('находка 19: заемане СЛЕД преименуването се брои по код — снимката в събитието носи новото име', async () => {
  /* Горният тест вписва събития със СТАРОТО име („продължаващо издание“) — то
     стои в резервната карта по име и затова минава дори без търсенето по код.
     Истинският случай обаче е другият: след преименуването всяко ново заемане
     записва в events.book_category НОВОТО име, а него картата по име не познава
     и редът пада в „Книги“. Точно това е находка 19 — и само този ред пази
     търсенето по categories.code живо. */
  const t = setup();
  const pid = mkPer(t, { title: 'Читалище', freq: 'месечно' });
  ok(await addIssue(t, pid, '1', Y + '-01-15', 3.5), 'брой');
  const vol = ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y }), 'инвентиране');
  const cat = t.db.prepare("SELECT id FROM categories WHERE code = 'periodical'").get();
  ok(await t.ipcMain.invoke('categories:update', { id: cat.id, name: 'периодично издание' }), 'преименуване');

  // Заемане СЛЕД преименуването: снимката в събитието е новото име.
  t.db.prepare(`INSERT INTO events (date, kind, book_id, book_category, reader_category)
    VALUES (?, 'заемане', ?, 'периодично издание', 'възрастен')`).run(TODAY, vol.book_id);

  const sug = ok(await t.ipcMain.invoke('dnevnik:suggest', { date: TODAY }), 'предложение');
  assert.equal(sug.suggestions.b_type_period, 1,
    'комплектът пак е периодика — програмата го намира по кода: ' + JSON.stringify(sug.suggestions));
  assert.equal(sug.suggestions.b_type_books, undefined, 'и не пада в реда „Книги“');
  assert.equal(sug.unclassified, 0, 'нито се брои за „книга без УДК“');
  assert.equal(sug.periodicalsByType, 1);
});

test('находка 19: начален вид документ, по който има записи, не се изтрива', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Читалище', freq: 'месечно' });
  ok(await addIssue(t, pid, '1', Y + '-01-15', 3.5), 'брой');
  ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y }), 'инвентиране');
  const cat = t.db.prepare("SELECT id FROM categories WHERE code = 'periodical'").get();
  assert.match(fail(await t.ipcMain.invoke('categories:delete', cat.id)), /началните видове документи/);
  assert.ok(t.db.prepare('SELECT 1 FROM categories WHERE id = ?').get(cat.id));
  // Празен вид (никой документ не го ползва) си остава изтриваем.
  const unused = t.db.prepare("SELECT id FROM categories WHERE code = 'patent'").get();
  ok(await t.ipcMain.invoke('categories:delete', unused.id), 'празният начален вид');
});

test('находка 21: преименуването на издание с инвентирани комплекти казва кои документи остават със старото име', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Трд', freq: 'месечно' });
  ok(await addIssue(t, pid, '1', Y + '-01-15', 3.5), 'брой');
  const out = ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y }), 'инвентиране');
  ok(await t.ipcMain.invoke('periodicals:update', { id: pid, title: 'Труд', freq: 'месечно' }), 'поправка на печатна грешка');
  const trail = t.audit.filter(a => a.action === 'Редакция на периодично издание').pop();
  assert.match(trail.detail, /преименувано от „Трд“/);
  assert.match(trail.detail, new RegExp('инв\\. № ' + out.inv_number + ' за ' + Y + ' г\\.'));
  assert.equal(t.db.prepare('SELECT title FROM books WHERE id = ?').get(out.book_id).title, 'Трд, ' + Y,
    'инвентарната книга не се преименува със задна дата');
  // Редакция без преименуване (или без комплекти) не наводнява дневника.
  ok(await t.ipcMain.invoke('periodicals:update', { id: pid, title: 'Труд', freq: 'месечно', publisher: 'Труд АД' }), 'издател');
  assert.equal(t.audit.filter(a => a.action === 'Редакция на периодично издание').pop().detail, 'Труд');
});

/* ==================================================================
   Находка 13 — Дневникът и годишният комплект
   ================================================================== */
test('находка 13: заетата периодика не се отчита като „книга без УДК“', async () => {
  const t = setup();
  const pid = mkPer(t, { title: 'Читалище', freq: 'месечно' });
  ok(await addIssue(t, pid, '1', Y + '-01-15', 3.5), 'брой');
  const vol = ok(await t.ipcMain.invoke('periodicalVolumes:register', { periodical_id: pid, year: Y }), 'инвентиране');
  const bookId = t.db.prepare(`INSERT INTO books (title, status, category_id) VALUES ('Роман', 'наличен',
    (SELECT id FROM categories WHERE code = 'book'))`).run().lastInsertRowid;
  t.db.prepare(`INSERT INTO events (date, kind, book_id, book_category, reader_category)
    VALUES (?, 'заемане', ?, 'продължаващо издание', 'възрастен')`).run(TODAY, vol.book_id);
  t.db.prepare(`INSERT INTO events (date, kind, book_id, book_category, reader_category)
    VALUES (?, 'заемане', ?, 'книга', 'възрастен')`).run(TODAY, bookId);
  const sug = ok(await t.ipcMain.invoke('dnevnik:suggest', { date: TODAY }), 'предложение');
  assert.equal(sug.unclassified, 1, 'само книгата без УДК чака ръчно допълване');
  assert.equal(sug.periodicalsByType, 1, 'комплектът се брои отделно — по вид, не по съдържание');
  assert.equal(sug.suggestions.b_type_period, 1);
  assert.equal(sug.suggestions.b_type_books, 1);
});

/* ==================================================================
   ЕКРАНИТЕ — находки 6, 12, 17, 18, 22
   ================================================================== */
let h;
const T = E.today();
const YY = T.slice(0, 4);
const YY1 = String(Number(YY) - 1);
const view = {};
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
  view.trud = (await h.api.periodicals.create({ title: 'Труд', freq: 'ежедневно', issn: '1313-7719', department: 'периодика' })).data;
  for (let i = 1; i <= 4; i++) await h.api.periodicalIssues.add({ periodical_id: view.trud, issue_no: 'м' + i, date: YY1 + '-04-0' + i, price: 0.85 });
  for (let i = 1; i <= 2; i++) await h.api.periodicalIssues.add({ periodical_id: view.trud, issue_no: 'т' + i, date: YY + '-02-0' + i, price: 0.85 });
});
test.after(() => { if (h) h.stop(); });

async function openTrud() {
  await h.go('periodika');
  const tr = Array.from(h.document.querySelectorAll('#view table.ledger tbody tr'))
    .find(x => x.firstElementChild.textContent.trim() === 'Труд');
  await h.clickButton('Отвори', tr);
  await h.waitFor(() => h.$('#issueF'), 'кардексът');
  await h.settle();
}

test('находка 6 (екран): кардексът се отваря на текущата година, с избор на година, търсачка и надпис „показани N от M“', async () => {
  await openTrud();
  assert.equal(h.document.querySelectorAll('#perIssuesBody tr').length, 2, 'само тазгодишните броеве');
  /* ПРОМЕНЕН НАДПИС (v2.4.65, находка Б14). Дотук знаменателят беше целият
     кардекс (6 броя за двете години), а числителят — показаните за ИЗБРАНАТА
     година (2). Двете бройки не бяха от един и същ въпрос и до тях стоеше бутон
     „Покажи още“, който брои по трети начин: „Показани 300 от 405 броя — 2025 г.“
     до „Покажи още (65 от общо 365)“. Сега надписът брои в избрания обхват, а
     целият кардекс се назовава отделно, накрая. Находката, която този тест пази
     (разрезът по година и че изобщо има надпис), не се променя. */
  assert.match(h.text('#perIssueCount'), new RegExp('Показани 2 от 2 броя — ' + YY + ' г\\.'));
  assert.match(h.text('#perIssueCount'), /целият кардекс: 6 броя/);
  h.type('#perIssueYear', YY1);
  await h.settle();
  assert.equal(h.document.querySelectorAll('#perIssuesBody tr').length, 4, 'миналата година');
  h.type('#perIssueSearch', 'м3');
  const visible = Array.from(h.document.querySelectorAll('#perIssuesBody tr')).filter(tr => tr.style.display !== 'none');
  assert.equal(visible.length, 1, 'търсачката намира броя без превъртане');
  assert.match(h.text('#perIssueCount'), /филтър: 1 от 4/);
  await h.clickButton('Затвори', '#modal footer');
});

test('находка 12 (екран): кардексът казва, когато подвързаният комплект вече не отговаря на картона', async () => {
  const reg = await h.api.periodicalVolumes.register({ periodical_id: view.trud, year: YY1 });
  assert.ok(reg.ok, 'инвентиране: ' + reg.error);
  view.inv = reg.data.inv_number;
  await openTrud();
  const row = () => Array.from(h.document.querySelectorAll('#modal fieldset table.ledger tbody tr'))
    .find(tr => tr.firstElementChild.textContent.trim() === YY1);
  assert.doesNotMatch(h.text(row()), /разминаване/, 'докато числата съвпадат, няма какво да се казва');
  await h.api.periodicalIssues.add({ periodical_id: view.trud, issue_no: 'м5', date: YY1 + '-04-05', price: 0.85 });
  await openTrud();
  assert.match(h.text(row()), /разминаване: подвързан с 4 бр\. при инвентирането, в кардекса 5/);
  await h.clickButton('Затвори', '#modal footer');
});

/* Тези две проверки покриват и пазача за пълнота на разпечатките
   (test/razpechatki.test.js, т. 18): двата нови документа на периодиката се
   издават от printPeriodikaYear() и printPeriodicalCard(). */
test('находка 17 (екран): „Печат / PDF“ на екрана „Периодика“ дава абонаментния списък за годината със сборове', async () => {
  await h.go('periodika');
  h.type('#perPrintYear', YY1);
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  const p = h.printed();
  assert.match(p, /ПЕРИОДИЧНИ ИЗДАНИЯ — АБОНАМЕНТЕН СПИСЪК/);
  assert.match(p, new RegExp('за ' + YY1 + ' г\\.'));
  assert.match(p, /НЧ „Изпитание – 1922“/, 'главата на читалището, както в другите документи');
  assert.match(p, /Труд 1313-7719 ежедневно периодика 5/, 'заглавие, ISSN, периодичност, отдел, получени броеве');
  assert.match(p, new RegExp('инв\\. № ' + view.inv), 'и дали комплектът е инвентиран');
  assert.match(p, /ОБЩО за/);
  assert.match(p, /Библиотекар: /);
  h.window.ppClose();
});

test('находка 18 (екран): картонът на изданието (кардексът) се печата', async () => {
  await openTrud();
  await h.clickButton('Печат / PDF на картона', '#modal footer');
  await h.settle();
  const p = h.printed();
  assert.match(p, /КАРТОН НА ПЕРИОДИЧНО ИЗДАНИЕ \(КАРДЕКС\)/);
  assert.match(p, /Труд · ISSN 1313-7719 · ежедневно/);
  assert.match(p, /Годишни комплекти във фонда/);
  assert.match(p, new RegExp(YY1 + ' 5 \\(подвързан с 4\\)'), 'разминаването личи и на хартия');
  h.window.ppClose();
  await h.clickButton('Затвори', '#modal footer');
});

test('находка 22 (екран): отказаното инвентиране не завежда втора партида за същия абонамент', async () => {
  await openTrud();
  const volRow = Array.from(h.document.querySelectorAll('#modal fieldset table.ledger tbody tr'))
    .find(tr => tr.firstElementChild.textContent.trim() === YY);
  await h.clickButton('Инвентирай годишния комплект', volRow);
  await h.waitFor(() => h.$('#volF'), 'формата за инвентиране');
  await h.settle();
  const before = h.db.prepare('SELECT COUNT(*) AS n FROM acquisitions').get().n;
  h.type('#volF [name=acquisition_id]', '__new__');
  h.type('#volF [name=acq_from_source]', 'Български пощи — абонамент');
  h.type('#volF [name=inv_number]', String(view.inv)); // зает номер → инвентирането ще бъде отказано
  await h.clickButton('Впиши в инвентарната книга', '#modal2 footer');
  await h.settle();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM acquisitions').get().n, before + 1, 'партидата е заведена веднъж');
  const acqId = h.db.prepare('SELECT id FROM acquisitions ORDER BY id DESC').get().id;
  assert.equal(h.$('#volF [name=acquisition_id]').value, String(acqId), 'и вече стои избрана');
  assert.equal(h.$('#volAcqNew').hidden, true);
  h.type('#volF [name=inv_number]', String(h.db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get().next_inv_number));
  await h.clickButton('Впиши в инвентарната книга', '#modal2 footer');
  await h.settle();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM acquisitions').get().n, before + 1,
    'вторият опит НЕ завежда втора партида: ' + JSON.stringify(h.db.prepare('SELECT id, no, from_source FROM acquisitions').all()));
  assert.equal(h.db.prepare('SELECT acquisition_id FROM books WHERE inv_number = (SELECT MAX(inv_number) FROM books)').get().acquisition_id,
    acqId, 'документът влиза в заведената партида — не остава извън КДБФ Част № 1');
});
