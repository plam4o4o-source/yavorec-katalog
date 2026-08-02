// Тест на handlers/housebound.js — седми домейн, извадено от main.js (Фаза
// 4, стъпка 8). Освен IPC каналите, проверява и че logEvent (подадено по
// референция от main.js, hoisted function declaration) реално се извиква
// при добавяне на посещение — а не само че INSERT-ът в housebound_visits
// минава.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerHouseboundHandlers = require('../handlers/housebound');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-housebound-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const eventLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    logEvent: (kind, opts) => eventLog.push({ kind, opts }),
    today: () => '2026-08-02'
  };
  registerHouseboundHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, eventLog };
}

function insertReader(db, name = 'Тестов читател') {
  return db.prepare('INSERT INTO readers (name) VALUES (?)').run(name).lastInsertRowid;
}

test('registerHouseboundHandlers registers all five housebound: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['housebound:get', 'housebound:save', 'housebound:remove', 'housebound:addVisit', 'housebound:list']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('housebound:get on a reader with no profile returns null profile and an empty visits array', async () => {
  const { db, ipcMain } = setup();
  const readerId = insertReader(db);
  const result = await ipcMain.invoke('housebound:get', readerId);
  assert.equal(result.ok, true);
  assert.equal(result.data.profile, null);
  assert.deepEqual(result.data.visits, []);
});

test('housebound:save creates a profile (upsert) and logs an audit entry with the reader name', async () => {
  const { db, ipcMain, auditLog } = setup();
  const readerId = insertReader(db, 'Мария Петрова');
  const saved = await ipcMain.invoke('housebound:save', { reader_id: readerId, day: 'вторник', frequency: 'седмично', note: 'ключ у съседката' });
  assert.equal(saved.ok, true);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /Мария Петрова/);

  const got = await ipcMain.invoke('housebound:get', readerId);
  assert.equal(got.data.profile.day, 'вторник');
  assert.equal(got.data.profile.frequency, 'седмично');

  // Повторен save (upsert) не трябва да създава втори ред.
  await ipcMain.invoke('housebound:save', { reader_id: readerId, day: 'четвъртък', frequency: 'месечно' });
  const list = await ipcMain.invoke('housebound:list');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].day, 'четвъртък');
});

test('housebound:addVisit inserts a visit row, calls logEvent with kind="дома", and logs an audit entry', async () => {
  const { db, ipcMain, eventLog, auditLog } = setup();
  const readerId = insertReader(db, 'Георги Георгиев');
  const result = await ipcMain.invoke('housebound:addVisit', { reader_id: readerId, date: '2026-07-15', note: 'донесени 3 книги' });
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);

  assert.equal(eventLog.length, 1);
  assert.equal(eventLog[0].kind, 'дома');
  assert.equal(eventLog[0].opts.readerId, readerId);
  assert.equal(eventLog[0].opts.date, '2026-07-15');

  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /Георги Георгиев/);
  assert.match(auditLog[0].detail, /2026-07-15/);

  const got = await ipcMain.invoke('housebound:get', readerId);
  assert.equal(got.data.visits.length, 1);
  assert.equal(got.data.visits[0].note, 'донесени 3 книги');
});

test('housebound:addVisit defaults the date to today() when none is provided', async () => {
  const { db, ipcMain, eventLog } = setup();
  const readerId = insertReader(db);
  await ipcMain.invoke('housebound:addVisit', { reader_id: readerId });
  assert.equal(eventLog[0].opts.date, '2026-08-02');
});

test('housebound:remove deletes the profile but visit history rows remain (no cascading assumption)', async () => {
  const { db, ipcMain } = setup();
  const readerId = insertReader(db);
  await ipcMain.invoke('housebound:save', { reader_id: readerId, day: 'сряда' });
  await ipcMain.invoke('housebound:addVisit', { reader_id: readerId, date: '2026-07-01' });
  const removed = await ipcMain.invoke('housebound:remove', readerId);
  assert.equal(removed.ok, true);
  const got = await ipcMain.invoke('housebound:get', readerId);
  assert.equal(got.data.profile, null);
});

test('housebound:list includes the reader\'s contact info and the most recent visit date', async () => {
  const { db, ipcMain } = setup();
  const readerId = insertReader(db, 'Иван Петров');
  db.prepare('UPDATE readers SET phone=?, address=? WHERE id=?').run('0888123456', 'ул. Тестова 1', readerId);
  await ipcMain.invoke('housebound:save', { reader_id: readerId, day: 'петък' });
  await ipcMain.invoke('housebound:addVisit', { reader_id: readerId, date: '2026-06-01' });
  await ipcMain.invoke('housebound:addVisit', { reader_id: readerId, date: '2026-07-01' });

  const list = await ipcMain.invoke('housebound:list');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].name, 'Иван Петров');
  assert.equal(list.data[0].phone, '0888123456');
  assert.equal(list.data[0].last_visit, '2026-07-01', 'should report the MAX (most recent) visit date');
});
