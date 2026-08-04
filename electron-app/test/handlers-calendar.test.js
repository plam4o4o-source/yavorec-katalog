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

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-calendar-test-'));
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
  await ipcMain.invoke('calendar:addClosed', { date: '2026-08-05', reason: 'скоро' });
  db.prepare('INSERT OR REPLACE INTO calendar_closed (date, reason) VALUES (?, ?)').run('2020-01-01', 'много старо');
  const result = await ipcMain.invoke('calendar:get');
  assert.equal(result.ok, true);
  assert.equal(result.data.workDays.length, 7);
  const dates = result.data.closed.map(c => c.date);
  assert.ok(dates.includes('2026-08-05'));
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
