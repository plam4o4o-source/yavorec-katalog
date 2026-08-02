// Тест на handlers/suggestions.js — осемнайсети домейн, извадено от main.js
// (Фаза 4, стъпка 19). Поток: заявено → одобрено → поръчано → получено/отказано.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerSuggestionsHandlers = require('../handlers/suggestions');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-suggestions-test-'));
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
  registerSuggestionsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerSuggestionsHandlers registers all four suggestions: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['suggestions:list', 'suggestions:create', 'suggestions:setStatus', 'suggestions:delete']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('suggestions:create requires a non-empty title', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('suggestions:create', { title: '   ' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Заглавието/);
});

test('suggestions:create inserts with status заявено by default and logs an audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const result = await ipcMain.invoke('suggestions:create', { title: 'Нова книга', author: 'Автор' });
  assert.equal(result.ok, true);
  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].detail, 'Нова книга');

  const list = await ipcMain.invoke('suggestions:list');
  assert.equal(list.data[0].status, 'заявено');
  assert.equal(list.data[0].date, '2026-08-02');
});

test('suggestions:setStatus rejects an unknown status', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('suggestions:create', { title: 'X' })).data;
  const result = await ipcMain.invoke('suggestions:setStatus', { id, status: 'непознато' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Непознато/);
});

test('suggestions:setStatus to получено keeps acquisition_id; any other status clears it', async () => {
  const { db, ipcMain } = setup();
  const acqId = db.prepare("INSERT INTO acquisitions (no, year, date, total_count) VALUES (1, '2026', '2026-01-01', 0)").run().lastInsertRowid;
  const id = (await ipcMain.invoke('suggestions:create', { title: 'Y' })).data;

  await ipcMain.invoke('suggestions:setStatus', { id, status: 'получено', acquisition_id: acqId });
  let row = db.prepare('SELECT status, acquisition_id FROM suggestions WHERE id=?').get(id);
  assert.equal(row.status, 'получено');
  assert.equal(row.acquisition_id, acqId);

  await ipcMain.invoke('suggestions:setStatus', { id, status: 'отказано', acquisition_id: acqId });
  row = db.prepare('SELECT status, acquisition_id FROM suggestions WHERE id=?').get(id);
  assert.equal(row.status, 'отказано');
  assert.equal(row.acquisition_id, null, 'acquisition_id should be cleared for non-получено statuses');
});

test('suggestions:list filters by status when provided', async () => {
  const { ipcMain } = setup();
  const id1 = (await ipcMain.invoke('suggestions:create', { title: 'А' })).data;
  await ipcMain.invoke('suggestions:create', { title: 'Б' });
  await ipcMain.invoke('suggestions:setStatus', { id: id1, status: 'одобрено' });

  const approved = await ipcMain.invoke('suggestions:list', 'одобрено');
  assert.equal(approved.data.length, 1);
  assert.equal(approved.data[0].title, 'А');
});

test('suggestions:list prefers the live reader name over the stored snapshot', async () => {
  const { db, ipcMain } = setup();
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Старо име')").run().lastInsertRowid;
  await ipcMain.invoke('suggestions:create', { title: 'В', reader_id: readerId, reader_name: 'Старо име' });
  db.prepare('UPDATE readers SET name = ? WHERE id = ?').run('Ново име', readerId);

  const list = await ipcMain.invoke('suggestions:list');
  assert.equal(list.data[0].reader_name, 'Ново име');
});

test('suggestions:delete removes the row', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('suggestions:create', { title: 'За изтриване' })).data;
  await ipcMain.invoke('suggestions:delete', id);
  const list = await ipcMain.invoke('suggestions:list');
  assert.equal(list.data.length, 0);
});
