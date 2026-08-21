/* Реадит v2.4.0, продължение: двете находки, докладвани от Reaudit Agent A
   като „извън обхвата" (не поправени от него) — решени тук от координатора,
   след като първата бе доказана изпълнима, а втората — потвърдена реална
   раса чрез два РЕАЛНИ os процеса (същият метод като two-process-locking.test.js).

   1) deaccessionActs:create записваше act.date НЕВАЛИДИРАНА право в
      loans.date_in / books.status_date / books.deaccession_date —
      доказано с буквален боклук низ, приет и записан.
   2) holds:add правеше проверка-после-запис БЕЗ транзакция — доказано с два
      реални процеса: същият читател, резервиращ два пъти „едновременно",
      в 10 от 15 кръга получаваше ДВА реда в holds вместо втория коректно
      отказан. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const Database = require('better-sqlite3');
const { boot, invokeHandler, closeApp } = require('./helpers/two-process-worker.js');
const registerDeaccessionActsHandlers = require('../handlers/deaccession-acts');
const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values.js');

const WORKER = path.join(__dirname, 'helpers', 'two-process-worker.js');

const tmpDirs = [];
function mkTmpDir(prefixPath) {
  const d = fs.mkdtempSync(prefixPath);
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
  }
});

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function newDb(dirPrefix) {
  const dir = mkTmpDir(path.join(os.tmpdir(), dirPrefix));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}

function deaccSetup(overrides = {}) {
  const db = newDb('inv-reaudit-followup-deacc-');
  const auditLog = [];
  const scheduleCalls = [];
  const ipcMain = fakeIpcMain();
  const deps = Object.assign({
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    BOOK_SELECT,
    yearOf: (d) => (d || '2026-08-21').slice(0, 4),
    scheduleCatalogWrite: () => scheduleCalls.push(true),
    normalizeScanCode
  }, overrides);
  registerDeaccessionActsHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, scheduleCalls };
}

test('deaccessionActs:create отказва акт с невалидна/липсваща дата (реадит, следваща находка на Agent A)', async () => {
  const { db, ipcMain } = deaccSetup();
  db.prepare("INSERT INTO books (title, inv_number, status) VALUES ('Книга', 900, 'наличен')").run();
  const bookId = db.prepare("SELECT id FROM books WHERE inv_number = 900").get().id;

  const bad = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: 'НЕВАЛИДНА-ДАТА-99-99', reason_code: 1, reason_text: 'износени' },
    bookIds: [bookId]
  });
  assert.equal(bad.ok, false, 'акт с боклук вместо дата не бива да се приема');
  assert.match(bad.error, /дата/i);

  const missing = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '', reason_code: 1, reason_text: 'износени' },
    bookIds: [bookId]
  });
  assert.equal(missing.ok, false, 'акт без дата не бива да се приема');

  const impossible = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-02-30', reason_code: 1, reason_text: 'износени' },
    bookIds: [bookId]
  });
  assert.equal(impossible.ok, false, 'календарно невъзможна дата (30 февруари) не бива да се приема');

  // Никой от опитите по-горе не бива да е пипнал книгата.
  const book = db.prepare('SELECT status FROM books WHERE id = ?').get(bookId);
  assert.equal(book.status, 'наличен', 'книгата не биваше да е отчислена от нито един невалиден опит');

  const ok = await ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-08-21', reason_code: 1, reason_text: 'износени' },
    bookIds: [bookId]
  });
  assert.equal(ok.ok, true, 'валидна дата трябва да работи както преди: ' + JSON.stringify(ok));
});

function makeSharedFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inv-shared-db-'));
}

function spawnWorker(dbFolder) {
  const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const pending = [];
  child.on('message', (msg) => {
    const p = pending.shift();
    if (p) p(msg);
  });
  const send = (msg) => new Promise((resolve) => { pending.push(resolve); child.send(msg); });
  return {
    ready: () => send({ cmd: 'init', dbFolder }),
    invoke: (channel, args) => send({ cmd: 'invoke', channel, args }),
    exit: () => new Promise((resolve) => { child.once('exit', resolve); child.send({ cmd: 'exit' }); })
  };
}

test('два реални процеса, същият читател резервира ЕДНА И СЪЩА книга „едновременно": точно едно ще успее, второто получава ясен отказ — не дублиран ред (реадит, следваща находка на Agent A, 12 кръга)', async () => {
  const ROUNDS = 12;
  let dupRows = 0;
  let bothOk = 0;
  let neitherOk = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const dbFolder = makeSharedFolder();
    await boot(dbFolder);
    const bookId = invokeHandler('books:create', {
      title: 'Под игото', quantity: 1, inv_number: 2000 + round, barcode: 'H' + (2000 + round)
    }).data;
    const readerIds = [
      invokeHandler('readers:create', { name: 'Читател 1' }).data,
      invokeHandler('readers:create', { name: 'Читател 2' }).data
    ];
    // Книгата е заета от читател 2, за да е нужна резервация на читател 1.
    const co = invokeHandler('loans:checkout', { reader_id: readerIds[1], book_id: bookId, date_out: '2026-08-21' });
    assert.equal(co.ok, true, 'подготовка: заемане на книгата трябва да успее: ' + JSON.stringify(co));
    closeApp();

    const w1 = spawnWorker(dbFolder);
    const w2 = spawnWorker(dbFolder);
    await Promise.all([w1.ready(), w2.ready()]);

    const book = { inv_number: 2000 + round };
    const [r1, r2] = await Promise.all([
      w1.invoke('holds:add', { reader_id: readerIds[0], code: String(book.inv_number) }),
      w2.invoke('holds:add', { reader_id: readerIds[0], code: String(book.inv_number) })
    ]);
    await Promise.all([w1.exit(), w2.exit()]);

    const results = [r1, r2];
    const oks = results.filter(r => r.ok && r.data && r.data.ok);
    if (oks.length > 1) bothOk++;
    if (oks.length === 0) neitherOk++;

    const Database = require('better-sqlite3');
    const db = new Database(path.join(dbFolder, 'library.db'), { readonly: true });
    const n = db.prepare(
      "SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND reader_id = ? AND status IN ('чака','заделена')"
    ).get(bookId, readerIds[0]).n;
    db.close();
    if (n > 1) dupRows++;

    fs.rmSync(dbFolder, { recursive: true, force: true });
  }

  assert.equal(dupRows, 0, 'НИТО ЕДИН кръг не бива да остави два реда в holds за същия читател/книга');
  assert.equal(bothOk, 0, 'НИТО ЕДИН кръг не бива да позволи и на двата конкурентни опита да успеят');
  assert.equal(neitherOk, 0, 'във всеки кръг точно единият опит трябва да успее — резервацията не бива да пропадне и за двамата заради заключване');
});
