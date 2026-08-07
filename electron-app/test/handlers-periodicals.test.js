// Тест на handlers/periodicals.js — двайсет и пети домейн, извадено от
// main.js (Фаза 4, стъпка 26).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerPeriodicalsHandlers = require('../handlers/periodicals');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-periodicals-test-'));
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
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    today: () => '2026-08-02'
  };
  const { countOverduePeriodicals } = registerPeriodicalsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, countOverduePeriodicals };
}

test('registerPeriodicalsHandlers registers all seven periodicals/periodicalIssues: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['periodicals:list', 'periodicals:get', 'periodicals:create', 'periodicals:update',
    'periodicals:delete', 'periodicalIssues:add', 'periodicalIssues:delete']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('periodicals:create inserts a row and logs an audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const result = await ipcMain.invoke('periodicals:create', { title: 'Списание Х', freq: 'месечно', issn: '1234-5678' });
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);
  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].detail, 'Списание Х');
});

test('periodicals:list includes issue_count aggregated from periodical_issues', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Вестник' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '1' });
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '2' });

  const list = await ipcMain.invoke('periodicals:list');
  assert.equal(list.data[0].issue_count, 2);
});

test('periodicals:get returns the periodical with its issues attached, ordered by date DESC', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Списание Y' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '1', date: '2026-01-01' });
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '2', date: '2026-06-01' });

  const result = await ipcMain.invoke('periodicals:get', id);
  assert.equal(result.data.issues.length, 2);
  assert.equal(result.data.issues[0].issue_no, '2', 'newest issue should be first');
});

test('periodicals:get returns null for a non-existent id', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('periodicals:get', 999999);
  assert.equal(result.data, null);
});

test('periodicals:update modifies the row and logs an audit entry', async () => {
  const { db, ipcMain, auditLog } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Старо име' })).data;
  auditLog.length = 0;
  await ipcMain.invoke('periodicals:update', { id, title: 'Ново име', freq: 'седмично', publisher: null, issn: null, department: null, note: null });
  const row = db.prepare('SELECT title, freq FROM periodicals WHERE id = ?').get(id);
  assert.equal(row.title, 'Ново име');
  assert.equal(row.freq, 'седмично');
  assert.equal(auditLog[0].detail, 'Ново име');
});

test('periodicals:delete refuses to delete a periodical with recorded issues', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Списание с броеве' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '1' });
  const result = await ipcMain.invoke('periodicals:delete', id);
  assert.equal(result.ok, false);
  assert.match(result.error, /не може да бъде изтрито/);
});

test('periodicals:delete removes a periodical with no issues', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Без броеве' })).data;
  const result = await ipcMain.invoke('periodicals:delete', id);
  assert.equal(result.ok, true);
  const list = await ipcMain.invoke('periodicals:list');
  assert.equal(list.data.length, 0);
});

test('periodicalIssues:add defaults date to today() and price to 0, and logs an audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Списание Z' })).data;
  const result = await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '5' });
  assert.equal(result.ok, true);

  const got = await ipcMain.invoke('periodicals:get', id);
  assert.equal(got.data.issues[0].date, '2026-08-02');
  assert.equal(got.data.issues[0].price, 0);
  assert.match(auditLog[auditLog.length - 1].detail, /бр\. 5/);
});

test('periodicalIssues:delete removes a specific issue', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Списание W' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '1' });
  const got = await ipcMain.invoke('periodicals:get', id);
  const issueId = got.data.issues[0].id;
  await ipcMain.invoke('periodicalIssues:delete', issueId);

  const after = await ipcMain.invoke('periodicals:get', id);
  assert.equal(after.data.issues.length, 0);
});

/* Предвиждане на следващия очакван брой (Koha: serials prediction pattern,
   облекчен вариант — виж коментара в handlers/periodicals.js). today() тук е
   ФИКСИРАНО зададено в setup() ('2026-08-02'), а изчисленията ползват само
   тази стойност и вписаните дати — без пряко date('now') — затова тестовете
   не могат тихо да изтекат с реалния часовник (правилото от ARCHITECTURE.md). */
test('periodicals:list computes next_expected and issue_overdue_days for a predictable, overdue monthly title', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Месечно списание', freq: 'месечно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '6', date: '2026-06-01' });

  const list = await ipcMain.invoke('periodicals:list');
  const p = list.data.find(x => x.id === id);
  assert.equal(p.next_expected, '2026-07-01', 'месечно + последен брой 2026-06-01 → очакван 2026-07-01');
  assert.equal(p.issue_overdue_days, 32, 'today() = 2026-08-02, 32 дни след 2026-07-01');
});

test('periodicals:list reports issue_overdue_days = 0 when the next issue is not due yet', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Седмичен вестник', freq: 'седмично' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '31', date: '2026-08-01' });

  const list = await ipcMain.invoke('periodicals:list');
  const p = list.data.find(x => x.id === id);
  assert.equal(p.next_expected, '2026-08-08');
  assert.equal(p.issue_overdue_days, 0, 'очакваната дата (08.08) е след today() (02.08) — не е закъсняло');
});

test('periodicals:list leaves next_expected null for freq="нередовно" even with issues recorded', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Непериодично издание', freq: 'нередовно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '1', date: '2020-01-01' });

  const list = await ipcMain.invoke('periodicals:list');
  const p = list.data.find(x => x.id === id);
  assert.equal(p.next_expected, null);
  assert.equal(p.issue_overdue_days, 0);
});

test('periodicals:list leaves next_expected null for a predictable freq with no issues yet', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('periodicals:create', { title: 'Ново издание без броеве', freq: 'месечно' });

  const list = await ipcMain.invoke('periodicals:list');
  const p = list.data.find(x => x.title === 'Ново издание без броеве');
  assert.equal(p.next_expected, null);
});

test('countOverduePeriodicals counts only predictable titles past their expected next issue', async () => {
  const { ipcMain, countOverduePeriodicals } = setup();
  const overdueId = (await ipcMain.invoke('periodicals:create', { title: 'Закъсняло', freq: 'месечно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: overdueId, issue_no: '1', date: '2026-06-01' }); // очаква се 07-01, закъсняло

  const onTimeId = (await ipcMain.invoke('periodicals:create', { title: 'Навреме', freq: 'седмично' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: onTimeId, issue_no: '1', date: '2026-08-01' }); // очаква се 08-08, не е закъсняло

  const irregularId = (await ipcMain.invoke('periodicals:create', { title: 'Нередовно', freq: 'нередовно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: irregularId, issue_no: '1', date: '2020-01-01' }); // непредвидимо, не бива да се брои

  await ipcMain.invoke('periodicals:create', { title: 'Без броеве', freq: 'месечно' }); // предвидимо по freq, но без нито един брой — не бива да се брои

  assert.equal(countOverduePeriodicals(), 1, 'само „Закъсняло“ отговаря на условието');
});

/* Краят на месеца — SQLite прелива при събиране на месеци:
   date('2026-01-31','+1 month') връща '2026-03-03', а не 28 февруари. За
   месечно издание с брой от 31-ви това означава предвиждане в грешен месец и
   закъснение, отчетено три дни по-късно. Затова handlers/periodicals.js
   притиска резултата към последния ден на целевия месец. */
test('предвиждането се притиска към последния ден на месеца (31.01 + месец = 28.02, не 03.03)', async () => {
  const { ipcMain } = setup(); // today() = '2026-08-02'
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Месечник от 31-ви', freq: 'месечно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '1', date: '2026-01-31' });

  const p = (await ipcMain.invoke('periodicals:list')).data.find(x => x.id === id);
  assert.equal(p.next_expected, '2026-02-28', 'февруари 2026 има 28 дни — предвиждането не бива да прелива в март');
});

test('предвиждането не прелива и при 31.03 (април има 30 дни) и при 29.02 → година', async () => {
  const { ipcMain } = setup();
  const monthly = (await ipcMain.invoke('periodicals:create', { title: 'Месечник от 31.03', freq: 'месечно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: monthly, issue_no: '3', date: '2026-03-31' });

  const yearly = (await ipcMain.invoke('periodicals:create', { title: 'Годишник от 29.02', freq: 'годишно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: yearly, issue_no: '1', date: '2024-02-29' });

  const list = (await ipcMain.invoke('periodicals:list')).data;
  assert.equal(list.find(x => x.id === monthly).next_expected, '2026-04-30');
  assert.equal(list.find(x => x.id === yearly).next_expected, '2025-02-28');
});

test('обичайните дати не се променят от притискането (01.06 + месец = 01.07)', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('periodicals:create', { title: 'Обикновен месечник', freq: 'месечно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: id, issue_no: '6', date: '2026-06-01' });

  const p = (await ipcMain.invoke('periodicals:list')).data.find(x => x.id === id);
  assert.equal(p.next_expected, '2026-07-01');
  assert.equal(p.issue_overdue_days, 32);
});

test('тримесечно и полугодишно също се смятат в месеци, не в дни', async () => {
  const { ipcMain } = setup();
  const q = (await ipcMain.invoke('periodicals:create', { title: 'Тримесечник', freq: 'тримесечно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: q, issue_no: '1', date: '2025-12-31' });
  const h = (await ipcMain.invoke('periodicals:create', { title: 'Полугодишник', freq: 'полугодишно' })).data;
  await ipcMain.invoke('periodicalIssues:add', { periodical_id: h, issue_no: '1', date: '2025-08-31' });

  const list = (await ipcMain.invoke('periodicals:list')).data;
  assert.equal(list.find(x => x.id === q).next_expected, '2026-03-31');
  assert.equal(list.find(x => x.id === h).next_expected, '2026-02-28', 'февруари 2026 има 28 дни');
});
