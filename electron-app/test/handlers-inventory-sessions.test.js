// Тест на handlers/inventory-sessions.js — двайсет и трети домейн, извадено
// от main.js (Фаза 4, стъпка 24). Проверява откриване/сканиране/затваряне на
// сесия за инвентаризация, откриване на липсващи документи и защитата им от
// заети (заемани в момента) книги.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerInventorySessionsHandlers = require('../handlers/inventory-sessions');
const { normalizeScanCode } = require('../security-utils');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-sessions-test-'));
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
    pctRequired: (n) => (n <= 50000 ? 10 : n <= 200000 ? 5 : 2),
    naturalLoss: (n, freeAccessPct) => (freeAccessPct > 50 ? n * 10 : n * 5) / 1000,
    normalizeScanCode
  };
  registerInventorySessionsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog };
}

// better-sqlite3 бинди именувани параметри стриктно — inventorySessions:start
// изисква committee1/committee2/committee3 да присъстват (дори null), точно
// както рендерерът винаги ги изпраща.
function startSession(ipcMain, overrides = {}) {
  return ipcMain.invoke('inventorySessions:start', Object.assign({
    date: '2026-08-02', scope: 'пълна', department: null,
    committee1: null, committee2: null, committee3: null
  }, overrides));
}

test('registerInventorySessionsHandlers registers all six inventorySessions: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['inventorySessions:list', 'inventorySessions:requirement', 'inventorySessions:start',
    'inventorySessions:get', 'inventorySessions:scan', 'inventorySessions:close']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('inventorySessions:requirement computes target via pctRequired and naturalLoss via free_access_pct', async () => {
  const { db, ipcMain } = setup();
  for (let i = 1; i <= 10; i++) db.prepare("INSERT INTO books (inv_number, title, status) VALUES (?, ?, 'наличен')").run(i, 'Книга ' + i);
  db.prepare('UPDATE settings SET free_access_pct = 60 WHERE id = 1').run();

  const result = await ipcMain.invoke('inventorySessions:requirement');
  assert.equal(result.data.active, 10);
  assert.equal(result.data.pct, 10); // pctRequired(10) = 10%
  assert.equal(result.data.target, 1);
  assert.equal(result.data.naturalLoss, 0.1); // 10*10/1000
});

test('inventorySessions:start records pool_size at the time of opening', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1, 'А', 'наличен')").run();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (2, 'Б', 'отчислен')").run();

  const id = (await startSession(ipcMain)).data;
  const row = db.prepare('SELECT pool_size, closed FROM inventory_sessions WHERE id = ?').get(id);
  assert.equal(row.pool_size, 1, 'only non-deaccessioned books count toward the pool');
  assert.equal(row.closed, 0);
});

test('inventorySessions:scan refuses an unknown code, a duplicate scan, and a closed session', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, barcode) VALUES (1, 'А', 'BC1')").run();
  const sessionId = (await startSession(ipcMain)).data;

  const unknown = await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'NOPE' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Непознат баркод/);

  const first = await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC1' });
  assert.equal(first.ok, true);
  const dup = await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC1' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /вече е сканиран/);

  db.prepare('UPDATE inventory_sessions SET closed = 1 WHERE id = ?').run(sessionId);
  const closed = await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC1' });
  assert.equal(closed.ok, false);
  assert.match(closed.error, /Няма отворена сесия/);
});

test('inventorySessions:scan clears a липсващ status back to наличен when the book is found', async () => {
  const { db, ipcMain } = setup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title, barcode, status) VALUES (2, 'Б', 'BC2', 'липсващ')").run().lastInsertRowid;
  const sessionId = (await startSession(ipcMain)).data;
  await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC2' });
  const row = db.prepare('SELECT status FROM books WHERE id = ?').get(bookId);
  assert.equal(row.status, 'наличен');
});

test('inventorySessions:close finds missing books but excludes ones currently on open loan', async () => {
  const { db, ipcMain, auditLog } = setup();
  const scannedId = db.prepare("INSERT INTO books (inv_number, title, barcode, status) VALUES (1, 'Сканирана', 'BC1', 'наличен')").run().lastInsertRowid;
  const missingId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (2, 'Изгубена', 'наличен')").run().lastInsertRowid;
  const onLoanId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (3, 'Заета', 'наличен')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(onLoanId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(onLoanId, readerId, '2026-08-01', '2026-08-15');

  const sessionId = (await startSession(ipcMain)).data;
  await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC1' });

  const result = await ipcMain.invoke('inventorySessions:close', sessionId);
  assert.equal(result.ok, true);
  assert.equal(result.data.scanned, 1);
  assert.equal(result.data.missing, 1, 'only the truly missing book counts — the on-loan one is excluded');
  assert.equal(result.data.pool, 3);

  const missingRow = db.prepare('SELECT status FROM books WHERE id = ?').get(missingId);
  assert.equal(missingRow.status, 'липсващ');
  const onLoanRow = db.prepare('SELECT status FROM books WHERE id = ?').get(onLoanId);
  assert.equal(onLoanRow.status, 'наличен', 'an on-loan book should never be marked липсващ');

  const missingSessionRow = db.prepare('SELECT * FROM inventory_session_missing WHERE session_id = ? AND book_id = ?').get(sessionId, missingId);
  assert.ok(missingSessionRow);

  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /проверени 1, липсващи 1 от 3/);

  const sessionRow = db.prepare('SELECT closed FROM inventory_sessions WHERE id = ?').get(sessionId);
  assert.equal(sessionRow.closed, 1);
});

test('inventorySessions:get returns the session with its scans and missing rows attached', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, barcode) VALUES (1, 'А', 'BC1')").run();
  const sessionId = (await startSession(ipcMain)).data;
  await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC1' });

  const result = await ipcMain.invoke('inventorySessions:get', sessionId);
  assert.equal(result.data.scans.length, 1);
  assert.equal(result.data.scans[0].inv_number, 1);
  assert.equal(result.data.missing.length, 0);
});

test('inventorySessions:list includes scanned/missing counts per session', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, barcode) VALUES (1, 'А', 'BC1')").run();
  const sessionId = (await startSession(ipcMain)).data;
  await ipcMain.invoke('inventorySessions:scan', { sessionId, code: 'BC1' });

  const list = await ipcMain.invoke('inventorySessions:list');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].scanned, 1);
  assert.equal(list.data[0].missing, 0);
});
