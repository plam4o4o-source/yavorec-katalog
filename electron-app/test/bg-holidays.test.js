// Тест на bg-holidays.js — автоматичното попълване на официалните празници
// в „Календар на библиотеката“. Датите на Великден са проверени срещу
// публично известните дати на Българската православна църква; заместващите
// почивни дни (чл. 154, ал. 2 КТ) — срещу реалните постановления, вкл.
// двойния декемврийски случай от 2022 г. (27 и 28 декември).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { orthodoxEaster, bulgarianHolidays, seedYear, ensureHolidaysSeeded, FIXED_HOLIDAYS } =
  require('../bg-holidays');
const registerCalendarHandlers = require('../handlers/calendar');


/* Хигиена на временните папки. node --test не чисти нищо след себе си, а всяка
   фикстура тук създава каталог в /tmp. Одитът завари 80 431 каталога / 23 GB;
   при пълен диск поредицата започва да пада лавинообразно на съвсем несвързани
   места (# pass 302 / # fail 345) и прати диагностиката по грешна следа.
   mkTmpDir() запомня папката, test.after() я трие. */
const tmpDirs = [];
function mkTmpDir(prefixPath) {
  const d = fs.mkdtempSync(prefixPath);
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
  }
});

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function freshDb() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-holidays-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  // Мигрираната колона (v6 в main.js) — тук я добавяме направо.
  db.exec('ALTER TABLE settings ADD COLUMN holidays_seeded TEXT');
  return db;
}

test('orthodoxEaster връща известните дати на православния Великден', () => {
  assert.equal(iso(orthodoxEaster(2024)), '2024-05-05');
  assert.equal(iso(orthodoxEaster(2025)), '2025-04-20');
  assert.equal(iso(orthodoxEaster(2026)), '2026-04-12');
  assert.equal(iso(orthodoxEaster(2027)), '2027-05-02');
  assert.equal(iso(orthodoxEaster(2028)), '2028-04-16');
  // Великден е винаги неделя.
  for (let y = 1900; y <= 2060; y++) {
    assert.equal(new Date(orthodoxEaster(y)).getUTCDay(), 0, 'година ' + y);
  }
});

test('orthodoxEaster отказва шумно извън диапазона на 13-дневната поправка', () => {
  assert.throws(() => orthodoxEaster(1899), /1900/);
  assert.throws(() => orthodoxEaster(2100), /1900/);
});

test('2026 г.: фиксирани празници, Великденски дни и трите заместващи дни', () => {
  const days = bulgarianHolidays(2026);
  const byDate = new Map(days.map(d => [d.date, d.reason]));

  for (const [md] of FIXED_HOLIDAYS) assert.ok(byDate.has('2026-' + md), md);
  assert.equal(byDate.get('2026-04-10'), 'Велики петък');
  assert.equal(byDate.get('2026-04-12'), 'Великден');
  assert.equal(byDate.get('2026-04-13'), 'Великден — втори ден');

  /* 24 май и 6 септември 2026 са неделя, 26 декември — събота.
     Проверява се СМИСЪЛЪТ на автоматично сглобения текст: че денят е обявен за
     ПОЧИВЕН и че се вижда ЗА КОЙ празник е. Точната формулировка (кавичките,
     тирето, скобата „(пада се в събота или неделя)") е форматиране и
     заковаването ѝ дума по дума дава фалшив провал при всяко преформулиране. */
  const substitute = (date, forHoliday) => {
    const reason = byDate.get(date) || '';
    assert.match(reason, /почивен ден/i, date + ': липсва указание, че денят е почивен');
    assert.ok(reason.includes(forHoliday),
      date + ': от текста „' + reason + '" не личи за кой празник е заместващият ден (очаква се „' + forHoliday + '")');
  };
  substitute('2026-05-25', 'Ден на светите братя');
  substitute('2026-09-07', 'Ден на Съединението');
  substitute('2026-12-28', 'Рождество Христово');
  assert.equal(days.length, 4 + FIXED_HOLIDAYS.length + 3);
});

test('Великденските дни не пораждат заместващи дни (изключението в ал. 2)', () => {
  // Велика събота и Великден са ВИНАГИ в събота и неделя — ако изключението
  // липсваше, всяка година щеше да има фалшив „Почивен ден за Великден“.
  for (const y of [2024, 2025, 2026, 2030]) {
    const bad = bulgarianHolidays(y).filter(d => /Почивен ден за „Вели?к/.test(d.reason));
    assert.deepEqual(bad, [], 'година ' + y);
  }
});

test('2022 г.: декемврийската група поражда ДВА заместващи дни — 27 и 28 декември', () => {
  // 24.12.2022 бе събота, 25.12 — неделя: реално почивни бяха 27 и 28 декември.
  const byDate = new Map(bulgarianHolidays(2022).map(d => [d.date, d.reason]));
  // Пак по смисъл, не по буква — виж бележката при теста за 2026 г.
  for (const [date, forHoliday] of [['2022-12-27', 'Бъдни вечер'], ['2022-12-28', 'Рождество Христово']]) {
    const reason = byDate.get(date) || '';
    assert.match(reason, /почивен ден/i, date);
    assert.ok(reason.includes(forHoliday), date + ': „' + reason + '" не сочи ' + forHoliday);
  }
  // 26.12 (вторият ден) е ПОНЕДЕЛНИК през 2022 г. и не поражда заместващ ден —
  // затова 28-и е за ПЪРВИЯ ден на Рождество, не за втория.
  assert.doesNotMatch(byDate.get('2022-12-28') || '', /втори ден/);
  assert.equal(byDate.has('2022-12-29'), false);
});

test('никоя година няма дублирани дати (сблъсък Великден/Гергьовден — 2013 г.)', () => {
  for (let y = 2000; y <= 2060; y++) {
    const days = bulgarianHolidays(y);
    assert.equal(new Set(days.map(d => d.date)).size, days.length, 'година ' + y);
  }
  // През 2013 г. вторият ден на Великден се падна на 6 май: една дата, една причина.
  const d2013 = bulgarianHolidays(2013).filter(d => d.date === '2013-05-06');
  assert.equal(d2013.length, 1);
  assert.equal(d2013[0].reason, 'Великден — втори ден');
});

test('seedYear е идемпотентен и не презаписва ръчно въведена причина', () => {
  const db = freshDb();
  db.prepare('INSERT INTO calendar_closed (date, reason) VALUES (?, ?)')
    .run('2026-12-25', 'Инвентаризация');

  const added = seedYear(db, 2026);
  assert.equal(added, bulgarianHolidays(2026).length - 1); // 25.12 вече е зает

  // Ръчната причина на библиотекаря остава непокътната (INSERT OR IGNORE).
  assert.equal(db.prepare('SELECT reason FROM calendar_closed WHERE date = ?')
    .get('2026-12-25').reason, 'Инвентаризация');

  assert.equal(seedYear(db, 2026), 0); // второ извикване — нищо ново
});

test('ensureHolidaysSeeded засява текущата и следващата година, точно по веднъж', () => {
  const db = freshDb();
  const first = ensureHolidaysSeeded(db, '2026-08-04');
  assert.deepEqual(first.seededYears, [2026, 2027]);
  assert.equal(first.addedByYear[2026], bulgarianHolidays(2026).length);
  assert.equal(first.addedByYear[2027], bulgarianHolidays(2027).length);
  assert.equal(db.prepare('SELECT holidays_seeded FROM settings WHERE id = 1').get().holidays_seeded,
    '2026,2027');

  // Библиотекарят решава да работи на 3 март — трие го от календара.
  db.prepare('DELETE FROM calendar_closed WHERE date = ?').run('2026-03-03');

  // Следващо стартиране същата година: нищо не се презасява, изтритото остава изтрито.
  const second = ensureHolidaysSeeded(db, '2026-12-30');
  assert.deepEqual(second.seededYears, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_closed WHERE date = ?')
    .get('2026-03-03').n, 0);

  // Нова година: досява се само 2028 (2027 вече е готова от декември).
  const third = ensureHolidaysSeeded(db, '2027-01-02');
  assert.deepEqual(third.seededYears, [2028]);
  assert.equal(db.prepare('SELECT holidays_seeded FROM settings WHERE id = 1').get().holidays_seeded,
    '2026,2027,2028');
});

test('интеграция: след засяване календарният модул смята празниците за неработни', () => {
  const db = freshDb();
  db.prepare('UPDATE settings SET work_days = ? WHERE id = 1').run('1,2,3,4,5'); // пон–пет
  ensureHolidaysSeeded(db, '2026-08-04');
  const ipcMain = { handle: () => {} };
  const { isWorkDay, nextWorkDay } = registerCalendarHandlers(ipcMain, {
    getDb: () => db,
    run: (fn) => ({ ok: true, data: fn() }),
    logAudit: () => {}
  });
  assert.equal(isWorkDay('2026-12-25'), false); // Рождество Христово (петък)
  assert.equal(isWorkDay('2026-12-28'), false); // заместващ ден
  assert.equal(isWorkDay('2027-01-01'), false); // следващата година е засята отрано
  // Падеж, изчислен около Коледа, прескача празници, събота/неделя и заместващия ден.
  assert.equal(nextWorkDay('2026-12-24'), '2026-12-29');
});
