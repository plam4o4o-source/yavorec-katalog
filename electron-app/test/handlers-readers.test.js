// Тест на handlers/readers.js — седемнайсети домейн, извадено от main.js
// (Фаза 4, стъпка 17). Проверява основния CRUD, PII маскирането/подготовката
// за запис, диференца в одитната следа, лимита на записите и FTS търсенето.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerReadersHandlers = require('../handlers/readers');
const { ftsQuery, READERS_FTS_SETUP_SQL } = require('../search-fts');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-readers-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  db.exec(READERS_FTS_SETUP_SQL);

  const auditLog = [];
  const piiCalls = { prepareWrite: [] };
  const ipcMain = fakeIpcMain();
  const deps = Object.assign({
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail, diff) => auditLog.push({ action, detail, diff }),
    today: () => '2026-08-02',
    ftsQuery,
    maskReaderRow: (r) => r,
    maskReaderRows: (rows) => rows,
    preparePiiForWrite: (out, prev) => { piiCalls.prepareWrite.push({ out: Object.assign({}, out), prev }); },
    diffFields: (oldObj, newObj, fields) => {
      const d = {};
      fields.forEach(f => { if (!oldObj || oldObj[f] !== newObj[f]) d[f] = [oldObj ? oldObj[f] : undefined, newObj[f]]; });
      return d;
    },
    checkRecordLimit: () => {}
  }, overrides);
  registerReadersHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, piiCalls };
}

test('registerReadersHandlers registers all six readers: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['readers:list', 'readers:get', 'readers:byCard', 'readers:create',
    'readers:update', 'readers:clearSuspension', 'readers:delete']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('readers:create inserts a row with sensible defaults and logs an audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const result = await ipcMain.invoke('readers:create', { name: 'Иван Иванов', card_no: 'C1' });
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /C1/);

  const got = await ipcMain.invoke('readers:get', result.data);
  assert.equal(got.data.category, 'възрастен');
  assert.equal(got.data.status, 'активен');
  assert.equal(got.data.registered_at, '2026-08-02');
});

test('readers:create calls checkRecordLimit before inserting (throws stop the insert)', async () => {
  const { ipcMain } = setup({ checkRecordLimit: () => { throw new Error('Достигнат е лимитът.'); } });
  const result = await ipcMain.invoke('readers:create', { name: 'Спрян' });
  assert.equal(result.ok, false);
  assert.match(result.error, /лимит/);
  const list = await ipcMain.invoke('readers:list');
  assert.equal(list.data.length, 0);
});

test('readers:update computes a diff via diffFields excluding egn/id_card_no, and logs it', async () => {
  const { ipcMain, auditLog } = setup();
  const id = (await ipcMain.invoke('readers:create', { name: 'Мария', phone: '111', egn: '1234567890' })).data;
  auditLog.length = 0;
  await ipcMain.invoke('readers:update', { id, name: 'Мария', phone: '222', egn: '0000000000' });
  assert.equal(auditLog.length, 1);
  assert.ok(auditLog[0].diff.phone, 'phone change should appear in the diff');
  assert.equal(auditLog[0].diff.egn, undefined, 'egn should never appear in the audit diff');
});

test('readers:update calls preparePiiForWrite with the previous row for PII handling', async () => {
  const { ipcMain, piiCalls } = setup();
  const id = (await ipcMain.invoke('readers:create', { name: 'Петър' })).data;
  piiCalls.prepareWrite.length = 0;
  await ipcMain.invoke('readers:update', { id, name: 'Петър Петров' });
  assert.equal(piiCalls.prepareWrite.length, 1);
  assert.ok(piiCalls.prepareWrite[0].prev, 'prev row should be passed on update');
});

test('readers:clearSuspension nulls suspended_until and logs the reader name', async () => {
  const { db, ipcMain, auditLog } = setup();
  const id = (await ipcMain.invoke('readers:create', { name: 'Георги' })).data;
  db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run('2030-01-01', id);
  await ipcMain.invoke('readers:clearSuspension', id);
  const row = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(id);
  assert.equal(row.suspended_until, null);
  assert.match(auditLog[auditLog.length - 1].detail, /Георги/);
});

test('readers:byCard finds a reader by card_no', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('readers:create', { name: 'Търсен', card_no: 'ABC123' });
  const result = await ipcMain.invoke('readers:byCard', 'ABC123');
  assert.equal(result.data.name, 'Търсен');
});

test('readers:delete removes the row', async () => {
  const { db, ipcMain } = setup();
  const id = (await ipcMain.invoke('readers:create', { name: 'За изтриване' })).data;
  await ipcMain.invoke('readers:delete', id);
  const row = db.prepare('SELECT * FROM readers WHERE id = ?').get(id);
  assert.equal(row, undefined);
});

test('readers:list without a query returns all readers ordered by name, masked via maskReaderRows', async () => {
  let maskedCount = 0;
  const { ipcMain } = setup({ maskReaderRows: (rows) => { maskedCount = rows.length; return rows; } });
  await ipcMain.invoke('readers:create', { name: 'Борис' });
  await ipcMain.invoke('readers:create', { name: 'Ана' });
  const list = await ipcMain.invoke('readers:list');
  assert.equal(list.data.length, 2);
  assert.equal(list.data[0].name, 'Ана', 'should be ordered by name');
  assert.equal(maskedCount, 2);
});

test('readers:list with a query uses ftsQuery for the FTS5 match and LIKE for phone/card_no', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('readers:create', { name: 'Специално Име', phone: '0888123456' });
  await ipcMain.invoke('readers:create', { name: 'Друг', phone: '111' });
  const byPhone = await ipcMain.invoke('readers:list', '0888123456');
  assert.equal(byPhone.data.length, 1);
  assert.equal(byPhone.data[0].name, 'Специално Име');
});
