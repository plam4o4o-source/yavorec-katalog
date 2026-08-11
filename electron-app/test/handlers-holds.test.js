// Тест на handlers/holds.js — двайсети домейн, извадено от main.js
// (Фаза 4, стъпка 21). Проверява добавяне/отказ/списък на резервации, а
// също и вътрешните функции, върнати за бъдещо ползване от "Заемания"
// (firstActiveHold/consumeHoldOnCheckout/activateHoldOnReturn).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerHoldsHandlers = require('../handlers/holds');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-holds-test-'));
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
    normalizeScanCode
  };
  const returned = registerHoldsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, returned };
}

function insertBookWithOpenLoan(db, { inv_number = 1, byReaderId } = {}) {
  const bookId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (?, 'Книга', 'наличен')").run(inv_number).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const holderId = byReaderId || db.prepare("INSERT INTO readers (name) VALUES ('Държащ')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookId, holderId, '2026-01-01', '2026-01-31');
  return { bookId, holderId };
}

test('registerHoldsHandlers registers all three holds: IPC channels and returns internal helpers', () => {
  const { ipcMain, returned } = setup();
  for (const ch of ['holds:list', 'holds:add', 'holds:cancel']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
  assert.equal(typeof returned.firstActiveHold, 'function');
  assert.equal(typeof returned.consumeHoldOnCheckout, 'function');
  assert.equal(typeof returned.activateHoldOnReturn, 'function');
});

test('holds:add refuses a book that is not currently on loan (nothing to reserve)', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (inv_number, title, status) VALUES (5, 'Свободна книга', 'наличен')").run();
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  const result = await ipcMain.invoke('holds:add', { reader_id: readerId, code: '5' });
  assert.equal(result.ok, false);
  assert.match(result.error, /свободен/);
});

test('holds:add refuses a duplicate active hold by the same reader', async () => {
  const { db, ipcMain } = setup();
  const { bookId } = insertBookWithOpenLoan(db, { inv_number: 10 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Резервиращ')").run().lastInsertRowid;
  const first = await ipcMain.invoke('holds:add', { reader_id: readerId, code: '10' });
  assert.equal(first.ok, true);
  assert.equal(first.data.queue, 1);
  const second = await ipcMain.invoke('holds:add', { reader_id: readerId, code: '10' });
  assert.equal(second.ok, false);
  assert.match(second.error, /вече има резервация/);
});

test('holds:add refuses when the requesting reader is the one currently holding the book', async () => {
  const { db, ipcMain } = setup();
  const { bookId, holderId } = insertBookWithOpenLoan(db, { inv_number: 11 });
  const result = await ipcMain.invoke('holds:add', { reader_id: holderId, code: '11' });
  assert.equal(result.ok, false);
  assert.match(result.error, /държи тази книга/);
});

test('holds:list returns only active holds (чака/заделена), ordered заделена first', async () => {
  const { db, ipcMain } = setup();
  const { bookId } = insertBookWithOpenLoan(db, { inv_number: 20 });
  const r1 = db.prepare("INSERT INTO readers (name) VALUES ('Първи')").run().lastInsertRowid;
  const r2 = db.prepare("INSERT INTO readers (name) VALUES ('Втори')").run().lastInsertRowid;
  await ipcMain.invoke('holds:add', { reader_id: r1, code: '20' });
  const h2 = await ipcMain.invoke('holds:add', { reader_id: r2, code: '20' });
  db.prepare("UPDATE holds SET status='заделена' WHERE id=?").run(h2.data.id);

  const list = await ipcMain.invoke('holds:list');
  assert.equal(list.data.length, 2);
  assert.equal(list.data[0].status, 'заделена', 'заделена holds should sort first');
});

test('holds:cancel marks the hold отказана and logs an audit entry', async () => {
  const { db, ipcMain, auditLog } = setup();
  insertBookWithOpenLoan(db, { inv_number: 30 });
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Отказващ')").run().lastInsertRowid;
  const added = await ipcMain.invoke('holds:add', { reader_id: readerId, code: '30' });
  auditLog.length = 0;
  await ipcMain.invoke('holds:cancel', added.data.id);

  const row = db.prepare('SELECT status FROM holds WHERE id=?').get(added.data.id);
  assert.equal(row.status, 'отказана');
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /Отказана резервация|инв. № 30/);
});

test('consumeHoldOnCheckout throws when a different reader tries to check out a book reserved for someone else', () => {
  const { db, returned } = setup();
  const { bookId } = insertBookWithOpenLoan(db, { inv_number: 40 });
  const holderReaderId = db.prepare("INSERT INTO readers (name) VALUES ('Резервирал')").run().lastInsertRowid;
  const otherReaderId = db.prepare("INSERT INTO readers (name) VALUES ('Друг')").run().lastInsertRowid;
  db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(bookId, holderReaderId);

  assert.throws(() => returned.consumeHoldOnCheckout(bookId, otherReaderId), /резервирана за Резервирал/);
  // Разрешено е за читателя, за когото е резервирано.
  returned.consumeHoldOnCheckout(bookId, holderReaderId);
  const row = db.prepare('SELECT status FROM holds WHERE book_id=?').get(bookId);
  assert.equal(row.status, 'изпълнена');
});

test('activateHoldOnReturn promotes the oldest чака hold to заделена and logs an audit entry', () => {
  const { db, returned, auditLog } = setup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (50, 'Книга')").run().lastInsertRowid;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Чакащ')").run().lastInsertRowid;
  db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(bookId, readerId);

  const hold = returned.activateHoldOnReturn(bookId);
  assert.equal(hold.status, 'заделена');
  const row = db.prepare('SELECT status FROM holds WHERE book_id=?').get(bookId);
  assert.equal(row.status, 'заделена');
  assert.equal(auditLog.length, 1);
});

test('activateHoldOnReturn returns null when there is no active hold for the book', () => {
  const { db, returned } = setup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (60, 'Книга без резервация')").run().lastInsertRowid;
  const hold = returned.activateHoldOnReturn(bookId);
  assert.equal(hold, null);
});
