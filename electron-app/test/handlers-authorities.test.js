// Тест на handlers/authorities.js — десети домейн, извадено от main.js
// (Фаза 4, стъпка 11). Дедупликация на "разпилени" стойности (автор,
// издателство и др.) — покрива стриктния (authKey) и хлабавия (looseMatch,
// съкратени имена) режим на откриване на дубликати.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerAuthoritiesHandlers = require('../handlers/authorities');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-authorities-test-'));
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
  registerAuthoritiesHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

function insertBook(db, fields) {
  const cols = Object.keys(fields);
  const info = db.prepare(
    `INSERT INTO books (title, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`
  ).run('Книга', ...cols.map(c => fields[c]));
  return info.lastInsertRowid;
}

test('registerAuthoritiesHandlers registers all five authorities: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['authorities:fields', 'authorities:list', 'authorities:suggest', 'authorities:duplicates', 'authorities:merge']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('authorities:fields returns the fixed set of field labels', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('authorities:fields');
  assert.equal(result.ok, true);
  assert.equal(result.data.author, 'автор');
  assert.equal(result.data.publisher, 'издателство');
});

test('authorities:list groups by value and counts, ordered most-frequent first', async () => {
  const { db, ipcMain } = setup();
  insertBook(db, { author: 'Иван Вазов' });
  insertBook(db, { author: 'Иван Вазов' });
  insertBook(db, { author: 'Елин Пелин' });
  const result = await ipcMain.invoke('authorities:list', 'author');
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].value, 'Иван Вазов');
  assert.equal(result.data[0].n, 2);
});

test('authorities:list rejects an unknown field', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('authorities:list', 'not_a_real_field');
  assert.equal(result.ok, false);
  assert.match(result.error, /Непознато поле/);
});

test('authorities:suggest returns lists for all fields at once', async () => {
  const { db, ipcMain } = setup();
  insertBook(db, { author: 'Йордан Йовков', publisher: 'Хемус' });
  const result = await ipcMain.invoke('authorities:suggest');
  assert.equal(result.ok, true);
  assert.ok(result.data.author.includes('Йордан Йовков'));
  assert.ok(result.data.publisher.includes('Хемус'));
});

test('authorities:duplicates (strict) groups only exact reordered-word matches, e.g. "Вазов, Иван" = "Иван Вазов"', async () => {
  const { db, ipcMain } = setup();
  insertBook(db, { author: 'Вазов, Иван' });
  insertBook(db, { author: 'Иван Вазов' });
  insertBook(db, { author: 'Съвсем различен автор' });
  const result = await ipcMain.invoke('authorities:duplicates', { field: 'author', loose: false });
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 1, 'only one duplicate group should be found');
  assert.equal(result.data[0].items.length, 2);
  assert.equal(result.data[0].total, 2);
});

test('authorities:duplicates (strict) does NOT merge an abbreviated name like "И. Вазов"', async () => {
  const { db, ipcMain } = setup();
  insertBook(db, { author: 'И. Вазов' });
  insertBook(db, { author: 'Иван Вазов' });
  const result = await ipcMain.invoke('authorities:duplicates', { field: 'author', loose: false });
  assert.equal(result.data.length, 0, 'strict mode should not consider these duplicates');
});

test('authorities:duplicates (loose) DOES catch the abbreviated name "И. Вазов" = "Иван Вазов"', async () => {
  const { db, ipcMain } = setup();
  insertBook(db, { author: 'И. Вазов' });
  insertBook(db, { author: 'Иван Вазов' });
  const result = await ipcMain.invoke('authorities:duplicates', { field: 'author', loose: true });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].items.length, 2);
});

test('authorities:duplicates (loose) correctly REJECTS "Димитър Колев" vs "Димитър Костов" as different people', async () => {
  const { db, ipcMain } = setup();
  insertBook(db, { author: 'Димитър Колев' });
  insertBook(db, { author: 'Димитър Костов' });
  const result = await ipcMain.invoke('authorities:duplicates', { field: 'author', loose: true });
  assert.equal(result.data.length, 0, 'these are two different surnames sharing a first name, not a duplicate');
});

test('authorities:merge rewrites all matching books to the target value and logs an audit entry', async () => {
  const { db, ipcMain, auditLog } = setup();
  insertBook(db, { author: 'Вазов, Иван' });
  insertBook(db, { author: 'И. Вазов' });
  insertBook(db, { author: 'друг автор' });
  const result = await ipcMain.invoke('authorities:merge', { field: 'author', from: ['Вазов, Иван', 'И. Вазов'], to: 'Иван Вазов' });
  assert.equal(result.ok, true);
  assert.equal(result.data.changed, 2);
  assert.equal(result.data.merged, 2);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /Иван Вазов/);
  const remaining = db.prepare("SELECT DISTINCT author FROM books WHERE author != 'друг автор'").all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].author, 'Иван Вазов');
});

test('authorities:merge rejects a missing target value or an empty from-list', async () => {
  const { ipcMain } = setup();
  const noTarget = await ipcMain.invoke('authorities:merge', { field: 'author', from: ['x'], to: '' });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.error, /Липсва стойност/);

  const noFrom = await ipcMain.invoke('authorities:merge', { field: 'author', from: [], to: 'x' });
  assert.equal(noFrom.ok, false);
  assert.match(noFrom.error, /Няма избрани/);
});
