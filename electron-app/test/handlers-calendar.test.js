// Тест на handlers/calendar.js — трети домейн, извадено от main.js (Фаза 4,
// стъпка 4). Освен IPC каналите, тестваме и връщаните функции
// (workDaysSet/isWorkDay/nextWorkDay/closedDaysBetween), защото те се ползват
// пряко от main.js (домейнът "Заемания", все още неизваден) — регресия тук
// би счупила изчисляването на падежи/наказания навсякъде, не само в самия
// календарен екран.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
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

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-calendar-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail })
  };
  const returned = registerCalendarHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, returned };
}

test('registerCalendarHandlers registers all four calendar: IPC channels and returns four helper functions', () => {
  const { ipcMain, returned } = setup();
  for (const ch of ['calendar:get', 'calendar:saveWorkDays', 'calendar:addClosed', 'calendar:removeClosed']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
  for (const fn of ['workDaysSet', 'isWorkDay', 'nextWorkDay', 'closedDaysBetween']) {
    assert.equal(typeof returned[fn], 'function', `expected ${fn} to be returned`);
  }
});

test('workDaysSet defaults to all 7 days when settings.work_days is untouched', () => {
  const { returned } = setup();
  const set = returned.workDaysSet();
  assert.equal(set.size, 7);
});

test('calendar:saveWorkDays restricts to weekdays only; workDaysSet reflects it afterward', async () => {
  const { ipcMain, returned, auditLog } = setup();
  const result = await ipcMain.invoke('calendar:saveWorkDays', [1, 2, 3, 4, 5]);
  assert.equal(result.ok, true);
  assert.equal(auditLog.length, 1);
  const set = returned.workDaysSet();
  assert.deepEqual([...set].sort(), [1, 2, 3, 4, 5]);
  assert.equal(returned.isWorkDay('2026-08-01'), false, '2026-08-01 is a Saturday'); // сб
  assert.equal(returned.isWorkDay('2026-08-03'), true, '2026-08-03 is a Monday'); // пон
});

test('calendar:addClosed marks a work day as closed; isWorkDay reflects it; calendar:removeClosed reopens it', async () => {
  const { ipcMain, returned } = setup();
  await ipcMain.invoke('calendar:saveWorkDays', [1, 2, 3, 4, 5]);
  assert.equal(returned.isWorkDay('2026-08-03'), true);

  const added = await ipcMain.invoke('calendar:addClosed', { date: '2026-08-03', reason: 'Национален празник' });
  assert.equal(added.ok, true);
  assert.equal(returned.isWorkDay('2026-08-03'), false);

  const removed = await ipcMain.invoke('calendar:removeClosed', '2026-08-03');
  assert.equal(removed.ok, true);
  assert.equal(returned.isWorkDay('2026-08-03'), true);
});

test('calendar:addClosed rejects a missing date', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('calendar:addClosed', { date: '', reason: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Изберете дата/);
});

test('calendar:get returns workDays and only closed dates from the last 30 days onward', async () => {
  const { ipcMain, db } = setup();
  // Заявката в handler-а сравнява с реалния часовник (date('now','-30 days')), затова
  // „скорошната" дата се смята динамично — твърда дата тук тихо изтича след 30 дни.
  const recent = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await ipcMain.invoke('calendar:addClosed', { date: recent, reason: 'скоро' });
  db.prepare('INSERT OR REPLACE INTO calendar_closed (date, reason) VALUES (?, ?)').run('2020-01-01', 'много старо');
  const result = await ipcMain.invoke('calendar:get');
  assert.equal(result.ok, true);
  assert.equal(result.data.workDays.length, 7);
  const dates = result.data.closed.map(c => c.date);
  assert.ok(dates.includes(recent));
  assert.ok(!dates.includes('2020-01-01'), 'closed dates older than 30 days should not be returned');
});

test('nextWorkDay skips weekends and closed dates forward to the next real work day', async () => {
  const { ipcMain, returned } = setup();
  await ipcMain.invoke('calendar:saveWorkDays', [1, 2, 3, 4, 5]);
  // 2026-08-01 е събота, 2026-08-02 неделя, 2026-08-03 понеделник е обявен за затворен.
  await ipcMain.invoke('calendar:addClosed', { date: '2026-08-03', reason: 'офиц. празник' });
  assert.equal(returned.nextWorkDay('2026-08-01'), '2026-08-04');
});

test('closedDaysBetween counts weekends and closed dates strictly within (a, b]', async () => {
  const { ipcMain, returned } = setup();
  await ipcMain.invoke('calendar:saveWorkDays', [1, 2, 3, 4, 5]);
  // (2026-07-31, 2026-08-04]: 08-01 (сб), 08-02 (нед) са затворени дни от седмицата = 2.
  assert.equal(returned.closedDaysBetween('2026-07-31', '2026-08-04'), 2);
  assert.equal(returned.closedDaysBetween(null, '2026-08-04'), 0);
  assert.equal(returned.closedDaysBetween('2026-08-04', '2026-08-04'), 0, 'a >= b must return 0');
});

/* ---------------------------------------------------------------------------
   Регресия v1.65.0 — часова зона.

   nextWorkDay/isWorkDay/closedDaysBetween четяха датата като „…T00:00:00" (МЕСТНА
   полунощ), а я записваха обратно през toISOString() (UTC). При UTC+2/+3 — тоест в
   България, където програмата реално работи — това връщаше ден ПО-РАНО и проверяваше
   грешния ден от седмицата: всеки падеж излизаше с ден по-рано, а падеж в събота се
   местеше НАЗАД в петък вместо напред в понеделник.

   Дефектът остана невидим точно защото целият пакет се изпълняваше под TZ=UTC, където
   двете скàли съвпадат. Затова тук зоната се сменя изрично по време на изпълнение
   (Node прилага process.env.TZ към следващите Date операции) и се проверяват часови
   зони и на изток, и на запад от UTC.
   --------------------------------------------------------------------------- */
test('датите не зависят от часовата зона на компютъра (падежи в България)', async () => {
  const original = process.env.TZ;
  try {
    for (const tz of ['UTC', 'Europe/Sofia', 'Pacific/Auckland', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      const { ipcMain, returned } = setup();
      await ipcMain.invoke('calendar:saveWorkDays', [1, 2, 3, 4, 5]);
      await ipcMain.invoke('calendar:addClosed', { date: '2026-08-03', reason: 'офиц. празник' });

      assert.equal(returned.nextWorkDay('2026-08-04'), '2026-08-04', `${tz}: работен ден не се мести`);
      assert.equal(returned.nextWorkDay('2026-08-01'), '2026-08-04', `${tz}: събота → следващият работен ден`);
      assert.equal(returned.nextWorkDay('2026-08-03'), '2026-08-04', `${tz}: затворен ден → напред, не назад`);
      assert.equal(returned.isWorkDay('2026-08-01'), false, `${tz}: 01.08.2026 е събота`);
      assert.equal(returned.isWorkDay('2026-08-04'), true, `${tz}: 04.08.2026 е вторник`);
      assert.equal(returned.closedDaysBetween('2026-07-31', '2026-08-04'), 3,
        `${tz}: събота, неделя и обявеният празник`);
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

/* ===========================================================================
   Границите на интервала (a, b] и датите-ръбове.
   ЗАЩО: closedDaysBetween брои затворените дни в интервала (a, b] — денят на
   ПАДЕЖА не се брои, денят на ВРЪЩАНЕТО се брои. Това не е стилистичен избор:
   така резултатът съответства едно към едно на „дни забава" на повикващия код
   (наказание и обезщетение). Мутационен одит смени интервала на [a, b] и
   поредицата остана зелена — а последицата е, че обезщетението и наказанието
   се разминават с цял ден за всеки читател, върнал книга след затворен ден.

   Отделно: досегашните тестове по дати ползваха изключително 01–04.08.2026.
   Липсваха напълно есенната смяна на часа (25.10.2026 — 25-часов ден),
   високосният ден (29.02) и годишната граница 31.12 → 01.01. И трите са
   класически места, където сметки с дати мълчаливо се разминават с ден.
   =========================================================================== */

function closeDay(db, date, reason) {
  db.prepare('INSERT OR IGNORE INTO calendar_closed (date, reason) VALUES (?, ?)').run(date, reason || 'тест');
}
// Само делнични дни за работни — за да е ясно кой ден защо е затворен.
function workWeekdays(db) {
  db.prepare('UPDATE settings SET work_days = ? WHERE id = 1').run('1,2,3,4,5');
}

test('closedDaysBetween: денят на падежа НЕ се брои, денят на връщане СЕ брои — интервалът е (a, b]', async () => {
  const { db, returned } = setup();
  db.prepare('UPDATE settings SET work_days = ? WHERE id = 1').run('0,1,2,3,4,5,6'); // всички дни работни
  // Затваряме точно двата края и един ден по средата.
  closeDay(db, '2026-08-10', 'краят a — НЕ бива да се брои');
  closeDay(db, '2026-08-11', 'по средата — брои се');
  closeDay(db, '2026-08-12', 'краят b — брои се');

  assert.equal(returned.closedDaysBetween('2026-08-10', '2026-08-12'), 2,
    'от трите затворени дни се броят само 11 и 12 — 10-и е денят на падежа');
  assert.equal(returned.closedDaysBetween('2026-08-09', '2026-08-10'), 1,
    'самият 10-и се брои, когато е ДЕНЯТ НА ВРЪЩАНЕ, а не денят на падежа');
  assert.equal(returned.closedDaysBetween('2026-08-11', '2026-08-11'), 0, 'a === b дава 0');
  assert.equal(returned.closedDaysBetween('2026-08-12', '2026-08-10'), 0, 'обърнат интервал дава 0');
});

test('есенна смяна на часа: 25.10.2026 е 25-часов ден и не отмества нито един резултат', async () => {
  /* В България лятното часово време свършва в последната неделя на октомври
     (25.10.2026) — денят има 25 часа. Сметка с денонощия по 864e5 ms или с
     МЕСТНА полунощ там се разминава с един ден. Календарът смята изцяло в UTC,
     затова тук се проверява именно това: резултатът не зависи от смяната. */
  const { db, returned } = setup();
  workWeekdays(db);
  closeDay(db, '2026-10-26', 'понеделник след смяната на часа');

  // 24–25.10.2026 са събота и неделя; 26-и е затворен понеделник.
  assert.equal(returned.isWorkDay('2026-10-23'), true, 'петък преди смяната е работен');
  assert.equal(returned.isWorkDay('2026-10-24'), false, 'събота');
  assert.equal(returned.isWorkDay('2026-10-25'), false, 'неделята на смяната на часа');
  assert.equal(returned.isWorkDay('2026-10-26'), false, 'затворен понеделник');
  assert.equal(returned.nextWorkDay('2026-10-24'), '2026-10-27',
    'първият работен ден след уикенда и затворения понеделник е вторник 27-и');
  assert.equal(returned.closedDaysBetween('2026-10-23', '2026-10-27'), 3,
    'събота, неделя (25-часовият ден) и затворения понеделник — точно три');
});

test('пролетна смяна на часа: 29.03.2026 е 23-часов ден и също не мърда резултата', async () => {
  const { db, returned } = setup();
  workWeekdays(db);
  assert.equal(returned.isWorkDay('2026-03-29'), false, 'неделя, 23-часов ден');
  assert.equal(returned.nextWorkDay('2026-03-28'), '2026-03-30', 'събота → понеделник, не назад в петък');
  assert.equal(returned.closedDaysBetween('2026-03-27', '2026-03-30'), 2, 'събота и неделята на смяната');
});

test('високосен ден: 29.02.2028 се брои като истински ден', async () => {
  const { db, returned } = setup();
  db.prepare('UPDATE settings SET work_days = ? WHERE id = 1').run('0,1,2,3,4,5,6');
  closeDay(db, '2028-02-29', 'високосен ден, затворено');
  assert.equal(returned.isWorkDay('2028-02-29'), false);
  assert.equal(returned.nextWorkDay('2028-02-29'), '2028-03-01', '29 февруари → 1 март');
  assert.equal(returned.closedDaysBetween('2028-02-28', '2028-03-01'), 1,
    'между 28.02 и 01.03 във високосна година има точно един ден — 29-и');
  // За контраст: 2026 НЕ е високосна и 28.02 се следва направо от 01.03.
  assert.equal(returned.closedDaysBetween('2026-02-28', '2026-03-01'), 0);
});

test('годишна граница: 31.12 → 01.01 не губи и не добавя ден', async () => {
  const { db, returned } = setup();
  db.prepare('UPDATE settings SET work_days = ? WHERE id = 1').run('0,1,2,3,4,5,6');
  closeDay(db, '2026-12-31', 'Нова година — затворено');
  closeDay(db, '2027-01-01', 'Нова година — затворено');

  assert.equal(returned.nextWorkDay('2026-12-31'), '2027-01-02',
    'прескачането на границата на годината трябва да върне дата от НОВАТА година');
  assert.equal(returned.closedDaysBetween('2026-12-30', '2027-01-01'), 2,
    '31 декември и 1 януари — по един ден от всяка година');
  assert.equal(returned.closedDaysBetween('2026-12-31', '2027-01-01'), 1,
    'денят на падежа (31-и) не се брои и през границата на годината');
});

test('дълъг интервал през годишната граница брои всички уикенди правилно', async () => {
  const { db, returned } = setup();
  workWeekdays(db);
  // 2026-12-25 (петък) → 2027-01-08 (петък): уикендите са 26–27.12, 2–3.01 и 9–10.01(извън).
  assert.equal(returned.closedDaysBetween('2026-12-25', '2027-01-08'), 4,
    'два уикенда по два дни в интервал, който пресича 31 декември');
});
