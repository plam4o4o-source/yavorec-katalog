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
  registerPeriodicalsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
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
