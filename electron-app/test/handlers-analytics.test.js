// Тест на handlers/analytics.js — трийсет и първи домейн (краеведски
// модул), извадено от main.js (Фаза 4, стъпка 31). Покрива
// analytics:list/get/years/create/update/delete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerAnalyticsHandlers = require('../handlers/analytics');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-analytics-test-'));
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
  registerAnalyticsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

test('registerAnalyticsHandlers registers all analytics: channels', () => {
  const { ipcMain } = setup();
  ['analytics:list', 'analytics:get', 'analytics:years', 'analytics:create', 'analytics:update', 'analytics:delete']
    .forEach(ch => assert.ok(ipcMain.has(ch), ch));
});

test('analytics:create inserts a row and logs the audit entry; analytics:get resolves joined titles', async () => {
  const { db, ipcMain, auditLog } = setup();
  const bookId = db.prepare("INSERT INTO books (title, author) VALUES ('Кн.', 'Авт.')").run().lastInsertRowid;
  const create = await ipcMain.invoke('analytics:create', { title: 'Статия', year: '2026', book_id: bookId, is_local: true });
  assert.equal(create.ok, true);
  const id = create.data;
  const got = await ipcMain.invoke('analytics:get', id);
  assert.equal(got.data.title, 'Статия');
  assert.equal(got.data.book_title, 'Кн.');
  assert.ok(auditLog.some(a => a.action === 'Аналитично описание' && /Статия/.test(a.detail)));
});

test('analytics:list filters by q and year', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('analytics:create', { title: 'Алфа', year: '2025' });
  await ipcMain.invoke('analytics:create', { title: 'Бета', year: '2026' });
  const byYear = await ipcMain.invoke('analytics:list', { year: '2026' });
  assert.equal(byYear.data.length, 1);
  assert.equal(byYear.data[0].title, 'Бета');
  const byQ = await ipcMain.invoke('analytics:list', { q: 'Алфа' });
  assert.equal(byQ.data.length, 1);
});

test('analytics:years groups by year', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('analytics:create', { title: 'А', year: '2026' });
  await ipcMain.invoke('analytics:create', { title: 'Б', year: '2026' });
  const years = await ipcMain.invoke('analytics:years');
  assert.deepEqual(years.data, [{ year: '2026', n: 2 }]);
});

test('analytics:update edits fields', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('analytics:create', { title: 'Стар' })).data;
  await ipcMain.invoke('analytics:update', { id, title: 'Нов' });
  const got = await ipcMain.invoke('analytics:get', id);
  assert.equal(got.data.title, 'Нов');
});

test('analytics:delete removes the row and any links pointing to it', async () => {
  const { db, ipcMain } = setup();
  const id = (await ipcMain.invoke('analytics:create', { title: 'X' })).data;
  db.prepare("INSERT INTO links (from_kind, from_id, to_kind, to_id) VALUES ('персона', 1, 'статия', ?)").run(id);
  const result = await ipcMain.invoke('analytics:delete', id);
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT * FROM analytics WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare("SELECT * FROM links WHERE to_kind = 'статия' AND to_id = ?").get(id), undefined);
});
