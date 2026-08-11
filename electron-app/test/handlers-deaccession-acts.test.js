// Тест на handlers/deaccession-acts.js — четиринайсети домейн, извадено от
// main.js (Фаза 4, стъпка 15). Пресъздава BOOK_SELECT като низ и следи дали
// scheduleCatalogWrite реално се вика при отчисляване/анулиране (тъй като
// отчислените документи изчезват от онлайн каталога).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerDeaccessionActsHandlers = require('../handlers/deaccession-acts');
const { normalizeScanCode } = require('../security-utils');

const BOOK_SELECT = `
  SELECT b.*, c.name AS category_name
  FROM books b
  LEFT JOIN categories c ON c.id = b.category_id
`;

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-deacc-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const scheduleCalls = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    BOOK_SELECT,
    yearOf: (d) => (d || '2026-08-02').slice(0, 4),
    scheduleCatalogWrite: () => scheduleCalls.push(true),
    normalizeScanCode
  };
  registerDeaccessionActsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, scheduleCalls };
}

function insertBook(db, overrides = {}) {
  const b = Object.assign({ inv_number: Math.floor(Math.random() * 1e6), title: 'Книга', status: 'наличен', price: 5 }, overrides);
  return db.prepare('INSERT INTO books (inv_number, title, status, price) VALUES (?, ?, ?, ?)')
    .run(b.inv_number, b.title, b.status, b.price).lastInsertRowid;
}

test('registerDeaccessionActsHandlers registers all six deaccessionActs: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['deaccessionActs:list', 'deaccessionActs:get', 'deaccessionActs:nextNo',
    'deaccessionActs:findBook', 'deaccessionActs:create', 'deaccessionActs:revoke']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('deaccessionActs:findBook rejects an already-deaccessioned book (cannot deaccession twice)', async () => {
  const { db, ipcMain } = setup();
  const id = insertBook(db, { inv_number: 5, status: 'отчислен' });
  db.prepare('UPDATE books SET barcode=? WHERE id=?').run('BC5', id);
  const result = await ipcMain.invoke('deaccessionActs:findBook', 'BC5');
  assert.equal(result.ok, true);
  assert.equal(result.data, undefined, 'already-deaccessioned books should not be findable for a new act');
});

test('deaccessionActs:create marks books as отчислен, closes open loans, records committee members, and schedules a catalog write', async () => {
  const { db, ipcMain, auditLog, scheduleCalls } = setup();
  const bookId = insertBook(db, { inv_number: 10, price: 12 });
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  db.prepare('INSERT INTO readers (name) VALUES (?)').run('Читател');
  const readerId = db.prepare('SELECT id FROM readers').get().id;
  db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(bookId, readerId, '2026-01-01', '2026-01-31');

  const result = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-08-01', reason_code: 3, reason_text: 'износени', committee1: 'А', committee2: 'Б', committee3: 'В' },
    bookIds: [bookId]
  });
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);

  const book = db.prepare('SELECT status, deaccession_act_id FROM books WHERE id=?').get(bookId);
  assert.equal(book.status, 'отчислен');
  assert.equal(book.deaccession_act_id, result.data);

  const loan = db.prepare('SELECT date_in FROM loans WHERE book_id=?').get(bookId);
  assert.equal(loan.date_in, '2026-08-01', 'open loan should be closed on the act date');

  const settings = db.prepare('SELECT committee1, committee2, committee3 FROM settings WHERE id=1').get();
  assert.equal(settings.committee1, 'А');

  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /акт № 1/);
  assert.equal(scheduleCalls.length, 1);

  const got = await ipcMain.invoke('deaccessionActs:get', result.data);
  assert.equal(got.data.items.length, 1);
  assert.equal(got.data.items[0].inv_number, 10);
  assert.equal(got.data.items[0].price, 12);
});

test('deaccessionActs:nextNo returns max(no)+1 per year', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('deaccessionActs:create', { act: { no: 4, date: '2026-01-01', reason_code: 1, reason_text: 'x' }, bookIds: [] });
  const next = await ipcMain.invoke('deaccessionActs:nextNo', '2026');
  assert.equal(next.data, 5);
});

test('deaccessionActs:revoke restores books to наличен and removes the act', async () => {
  const { db, ipcMain, scheduleCalls } = setup();
  const bookId = insertBook(db, { inv_number: 20 });
  const created = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-08-01', reason_code: 1, reason_text: 'грешка' },
    bookIds: [bookId]
  });
  scheduleCalls.length = 0;
  const revoked = await ipcMain.invoke('deaccessionActs:revoke', created.data);
  assert.equal(revoked.ok, true);
  assert.equal(scheduleCalls.length, 1);

  const book = db.prepare('SELECT status, deaccession_act_id FROM books WHERE id=?').get(bookId);
  assert.equal(book.status, 'наличен');
  assert.equal(book.deaccession_act_id, null);

  const act = db.prepare('SELECT * FROM deaccession_acts WHERE id=?').get(created.data);
  assert.equal(act, undefined, 'the act row itself should be deleted');
});
