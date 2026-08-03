// Тест на handlers/search-history.js — двайсет и осми домейн, извадено от
// main.js (Фаза 4, стъпка 28). getCurrentUser е getter, тъй като
// CURRENT_USER е мутируемо `let` в main.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerSearchHistoryHandlers = require('../handlers/search-history');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-search-history-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  let currentUser = 'Библиотекар';
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    getCurrentUser: () => currentUser
  };
  registerSearchHistoryHandlers(ipcMain, deps);
  return { db, ipcMain, setCurrentUser: (u) => { currentUser = u; } };
}

test('registerSearchHistoryHandlers registers searchHistory:log/suggest', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('searchHistory:log'));
  assert.ok(ipcMain.has('searchHistory:suggest'));
});

test('searchHistory:log ignores empty kind or queries shorter than 2 characters', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('searchHistory:log', { kind: 'books', query: 'a' });
  await ipcMain.invoke('searchHistory:log', { kind: '', query: 'дълга заявка' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM search_history').get().n;
  assert.equal(count, 0);
});

test('searchHistory:log records the query with the current user, and skips an exact duplicate of the last one', async () => {
  const { db, ipcMain, setCurrentUser } = setup();
  setCurrentUser('Мария');
  await ipcMain.invoke('searchHistory:log', { kind: 'books', query: 'Иван Вазов' });
  await ipcMain.invoke('searchHistory:log', { kind: 'books', query: 'Иван Вазов' });
  const rows = db.prepare('SELECT * FROM search_history').all();
  assert.equal(rows.length, 1, 'an exact repeat of the last query should not duplicate');
  assert.equal(rows[0].user, 'Мария');
});

test('searchHistory:log allows the same query again if a different one came in between', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('searchHistory:log', { kind: 'books', query: 'Иван Вазов' });
  await ipcMain.invoke('searchHistory:log', { kind: 'books', query: 'Йордан Йовков' });
  await ipcMain.invoke('searchHistory:log', { kind: 'books', query: 'Иван Вазов' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM search_history').get().n;
  assert.equal(count, 3);
});

test('searchHistory:suggest returns distinct recent queries for a kind, most recent first', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('searchHistory:log', { kind: 'readers', query: 'Петров' });
  await ipcMain.invoke('searchHistory:log', { kind: 'readers', query: 'Georgiev' });
  await ipcMain.invoke('searchHistory:log', { kind: 'books', query: 'нещо друго' });

  const result = await ipcMain.invoke('searchHistory:suggest', 'readers');
  assert.deepEqual(result.data, ['Georgiev', 'Петров']);
});
