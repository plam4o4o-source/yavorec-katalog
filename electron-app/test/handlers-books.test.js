// Тест на handlers/books.js — трийсет и четвърти домейн (последният от
// "големите пет"), извадено от main.js (Фаза 4, стъпка 34). Покрива
// books:list/get/byBarcode/create/update/delete/bulkUpdate/addCheck/checks
// и limits:usage/update.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ftsQuery, BOOKS_FTS_SETUP_SQL } = require('../search-fts');
const registerBooksHandlers = require('../handlers/books');
/* diffFields идва от main.js, не се преписва: тукашният двойник връщаше ОБЕКТ,
   а продукцията връща МАСИВ [{field,before,after}] — заради което всяко
   твърдение върху одитния diff проверяваше фалшификата, не програмата.
   Вж. test/helpers/prod-values.js. */
const { diffFields, normalizeScanCode } = require('./helpers/prod-values.js');


/* Хигиена на временните папки. node --test не чисти нищо след себе си, а всяка
   фикстура тук създава каталог в /tmp. Одитът завари 80 431 каталога / 23 GB;
   при пълен диск поредицата започва да пада лавинообразно на съвсем несвързани
   места (# pass 302 / # fail 345) и прати диагностиката по грешна следа.
   mkTmpDir() запомня папката, test.after() я трие. */
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

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-books-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  db.exec(BOOKS_FTS_SETUP_SQL);

  const auditLog = [];
  const catalogWrites = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail, diff) => auditLog.push({ action, detail, diff }),
    today: () => '2026-08-02',
    ftsQuery,
    cnSortKey: (s) => String(s || '').toUpperCase().trim().replace(/\d+/g, m => m.padStart(6, '0')),
    diffFields,
    scheduleCatalogWrite: () => catalogWrites.push(1),
    normalizeScanCode
  };
  const returned = registerBooksHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, catalogWrites, returned };
}

test('registerBooksHandlers registers all 9 books: + 2 limits: channels, returns BOOK_SELECT/BOOK_FIELDS/checkRecordLimit', () => {
  const { ipcMain, returned } = setup();
  ['books:list', 'books:get', 'books:byBarcode', 'books:create', 'books:update', 'books:delete',
   'books:bulkUpdate', 'books:addCheck', 'books:checks', 'limits:usage', 'limits:update']
    .forEach(ch => assert.ok(ipcMain.has(ch), ch));
  assert.match(returned.BOOK_SELECT, /FROM books b/);
  assert.ok(returned.BOOK_FIELDS.includes('inv_number'));
  assert.equal(typeof returned.checkRecordLimit, 'function');
});

test('books:create inserts a book + inventory row, advances next_inv_number, logs audit and schedules a catalog write', async () => {
  const { db, ipcMain, auditLog, catalogWrites } = setup();
  const result = await ipcMain.invoke('books:create', { title: 'Под игото', author: 'Вазов, Иван', inv_number: 5, quantity: 1 });
  assert.equal(result.ok, true);
  const id = result.data;
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  assert.equal(row.title, 'Под игото');
  assert.equal(row.status, 'наличен'); // defaulted
  assert.equal(row.register_date, '2026-08-02'); // defaulted via today()
  const inv = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(id);
  /* v2.4.21: един инвентарен номер = един екземпляр. Дотук тестът подаваше
     quantity: 2 и очакваше да се запише — а такъв запис инвентарната книга не
     допуска. Отказът е закован отделно в fixes-audit-v2421.test.js. */
  assert.equal(inv.quantity, 1);
  const nextInv = db.prepare('SELECT next_inv_number FROM settings WHERE id=1').get().next_inv_number;
  assert.equal(nextInv, 6);
  assert.ok(auditLog.some(a => a.action === 'Нов документ'));
  assert.equal(catalogWrites.length, 1);
});

test('books:create/books:update persist series/series_no (v1.70.0 — поредица); a field missing from BOOK_FIELDS silently never saves', async () => {
  const { db, ipcMain } = setup();
  const id = (await ipcMain.invoke('books:create', {
    title: 'Игра на тронове', series: 'Песен за огън и лед', series_no: 'кн. 1'
  })).data;
  const row = db.prepare('SELECT series, series_no FROM books WHERE id = ?').get(id);
  assert.equal(row.series, 'Песен за огън и лед');
  assert.equal(row.series_no, 'кн. 1');

  await ipcMain.invoke('books:update', { id, title: 'Игра на тронове', series: 'Друга поредица', series_no: 'кн. 2', quantity: 1 });
  const updated = db.prepare('SELECT series, series_no FROM books WHERE id = ?').get(id);
  assert.equal(updated.series, 'Друга поредица');
  assert.equal(updated.series_no, 'кн. 2');
});

test('books:create enforces the configured record limit', async () => {
  const { db, ipcMain } = setup();
  db.prepare('UPDATE settings SET limit_books = 1 WHERE id=1').run();
  const first = await ipcMain.invoke('books:create', { title: 'Кн1' });
  assert.equal(first.ok, true);
  const second = await ipcMain.invoke('books:create', { title: 'Кн2' });
  assert.equal(second.ok, false);
  assert.match(second.error, /Достигнат е зададеният лимит/);
});

test('books:get and books:byBarcode resolve via BOOK_SELECT (with category_name and available)', async () => {
  const { db, ipcMain } = setup();
  const catId = db.prepare("INSERT INTO categories (name) VALUES ('Роман')").run().lastInsertRowid;
  const id = (await ipcMain.invoke('books:create', { title: 'X', category_id: catId, barcode: 'BC1', quantity: 1 })).data;
  const got = await ipcMain.invoke('books:get', id);
  assert.equal(got.data.category_name, 'Роман');
  assert.equal(got.data.available, 1);
  const byBarcode = await ipcMain.invoke('books:byBarcode', 'BC1');
  assert.equal(byBarcode.data.id, id);
});

// v1.70.1: баркод четецът въвежда текста буква по буква като физическа
// клавиатура — при активна кирилска (фонетична) разредба на Windows баркод
// "BC1" пристига в програмата като "БЦ1" и книгата не се намираше при
// сканиране, макар да е сканирана правилно. normalizeScanCode() го поправя.
test('books:byBarcode намира книгата дори баркодът да пристигне с кирилски букви от четеца (v1.70.1)', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('books:create', { title: 'Y', barcode: 'BC1', quantity: 1 })).data;
  const byBarcode = await ipcMain.invoke('books:byBarcode', 'БЦ1');
  assert.equal(byBarcode.data && byBarcode.data.id, id, 'книгата трябва да се намери въпреки кирилския вход');
});

test('books:list finds by title/author via FTS, and by ISBN/barcode/inv_number via LIKE', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('books:create', { title: 'Тихият Дон', author: 'Шолохов', isbn: '9781234567890', inv_number: 100 });
  await ipcMain.invoke('books:create', { title: 'Друга книга', inv_number: 200 });

  const byTitle = await ipcMain.invoke('books:list', 'Тихият');
  assert.equal(byTitle.data.length, 1);
  assert.equal(byTitle.data[0].title, 'Тихият Дон');

  const byIsbn = await ipcMain.invoke('books:list', '978123');
  assert.equal(byIsbn.data.length, 1);

  const byInv = await ipcMain.invoke('books:list', '200');
  assert.equal(byInv.data.length, 1);
  assert.equal(byInv.data[0].inv_number, 200);

  const all = await ipcMain.invoke('books:list');
  assert.equal(all.data.length, 2);
});

test('books:list sorts by cn (signature) using cn_sort so numbers compare correctly, not lexicographically', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('books:create', { title: 'B', call_number: 'Ч-84' });
  await ipcMain.invoke('books:create', { title: 'A', call_number: 'Ч-9' });
  const result = await ipcMain.invoke('books:list', '', 'cn');
  assert.deepEqual(result.data.map(b => b.call_number), ['Ч-9', 'Ч-84']);
});

test('books:update records a diff in the audit log and only touches status_date when status actually changes', async () => {
  const { db, ipcMain, auditLog } = setup();
  const id = (await ipcMain.invoke('books:create', { title: 'Стар', status: 'наличен' })).data;
  const created = db.prepare('SELECT status_date FROM books WHERE id=?').get(id);

  // No status change: status_date must be preserved, not bumped to "today" again.
  await ipcMain.invoke('books:update', { id, title: 'Нов', status: 'наличен', quantity: 1 });
  const afterTitleOnly = db.prepare('SELECT title, status_date FROM books WHERE id=?').get(id);
  assert.equal(afterTitleOnly.title, 'Нов');
  assert.equal(afterTitleOnly.status_date, created.status_date);
  assert.ok(auditLog.some(a => a.action === 'Редакция на документ'
    && Array.isArray(a.diff) && a.diff.some(d => d.field === 'title' && d.before === 'Стар' && d.after === 'Нов')),
    'diff-ът в одита е масив [{field,before,after}] — точно както го записва main.js');

  // Status change: status_date should now be set (today() stub).
  await ipcMain.invoke('books:update', { id, title: 'Нов', status: 'липсващ', quantity: 1 });
  const afterStatus = db.prepare('SELECT status, status_date FROM books WHERE id=?').get(id);
  assert.equal(afterStatus.status, 'липсващ');
  assert.equal(afterStatus.status_date, '2026-08-02');
});

test('books:delete removes the row and schedules a catalog write', async () => {
  const { db, ipcMain, catalogWrites } = setup();
  const id = (await ipcMain.invoke('books:create', { title: 'X' })).data;
  catalogWrites.length = 0;
  const result = await ipcMain.invoke('books:delete', id);
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT * FROM books WHERE id=?').get(id), undefined);
  assert.equal(catalogWrites.length, 1);
});

test('books:bulkUpdate only allows whitelisted fields, forbids setting status to "отчислен", and skips already-deaccessioned rows', async () => {
  const { db, ipcMain, auditLog } = setup();
  const id1 = (await ipcMain.invoke('books:create', { title: 'A', department: 'заемна' })).data;
  const id2 = (await ipcMain.invoke('books:create', { title: 'B', department: 'заемна', status: 'отчислен' })).data;

  const badField = await ipcMain.invoke('books:bulkUpdate', { ids: [id1], field: 'title', value: 'x' });
  assert.equal(badField.ok, false);
  assert.match(badField.error, /Непозволено поле/);

  const badStatus = await ipcMain.invoke('books:bulkUpdate', { ids: [id1], field: 'status', value: 'отчислен' });
  assert.equal(badStatus.ok, false);
  assert.match(badStatus.error, /акт за отчисляване/);

  const result = await ipcMain.invoke('books:bulkUpdate', { ids: [id1, id2], field: 'department', value: 'служебен' });
  assert.equal(result.ok, true);
  assert.equal(result.data, 1); // id2 already 'отчислен', excluded
  assert.equal(db.prepare('SELECT department FROM books WHERE id=?').get(id1).department, 'служебен');
  assert.equal(db.prepare('SELECT department FROM books WHERE id=?').get(id2).department, 'заемна'); // unchanged
  assert.ok(auditLog.some(a => a.action === 'Групова редакция'));
});

test('books:addCheck/books:checks record and list inventory check dates for a book', async () => {
  const { ipcMain } = setup();
  const id = (await ipcMain.invoke('books:create', { title: 'X' })).data;
  await ipcMain.invoke('books:addCheck', { bookId: id, date: '2026-01-15' });
  await ipcMain.invoke('books:addCheck', { bookId: id }); // defaults to today()
  const result = await ipcMain.invoke('books:checks', id);
  assert.deepEqual(result.data.map(r => r.date), ['2026-01-15', '2026-08-02']);
});

test('limits:usage reports current counts and configured limits; limits:update clamps to non-negative integers', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('books:create', { title: 'X' });
  db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run();

  await ipcMain.invoke('limits:update', { limit_books: -5, limit_readers: '10' });
  const row = db.prepare('SELECT limit_books, limit_readers FROM settings WHERE id=1').get();
  assert.equal(row.limit_books, 0);
  assert.equal(row.limit_readers, 10);

  const usage = await ipcMain.invoke('limits:usage');
  assert.equal(usage.data.books, 1);
  assert.equal(usage.data.readers, 1);
  assert.equal(usage.data.limitBooks, 0);
  assert.equal(usage.data.limitReaders, 10);
});

/* ЗАЩО: BOOK_FIELDS е списъкът колони, които books:create/update реално
   записват. Мутационен одит махна от него 'price' и цялата поредица остана
   зелена — а последицата е, че цената спира да се записва за ВСЕКИ НОВ запис:
   инвентарната книга и „стойност на фонда" показват 0,00 лв. само за новите
   документи, което изглежда като счетоводна грешка, а не като софтуерна.
   Затова проверката е през реалния запис в базата, не през списъка. */
test('books:create и books:update записват ВСЯКО поле от BOOK_FIELDS, включително цената', async () => {
  const { db, ipcMain, returned } = setup();
  assert.ok(returned.BOOK_FIELDS.includes('price'), 'price трябва да е сред записваните полета');

  const id = (await ipcMain.invoke('books:create', {
    title: 'Под игото', inv_number: 1, price: 12.5, udk: '886.7-31',
    barcode: 'BC-1', register_date: '2026-03-04', series: 'Библиотека', series_no: '7'
  })).data;
  const created = db.prepare('SELECT price, udk, barcode, register_date, series, series_no FROM books WHERE id=?').get(id);
  assert.equal(created.price, 12.5, 'цената трябва да стигне до базата — иначе стойността на фонда е 0,00 лв.');
  assert.equal(created.udk, '886.7-31');
  assert.equal(created.barcode, 'BC-1');
  assert.equal(created.register_date, '2026-03-04');
  assert.equal(created.series, 'Библиотека');
  assert.equal(created.series_no, '7');

  await ipcMain.invoke('books:update', { id, title: 'Под игото', price: 19.99, quantity: 1 });
  assert.equal(db.prepare('SELECT price FROM books WHERE id=?').get(id).price, 19.99, 'редакцията също трябва да пише цената');
});

test('всяко име в BOOK_FIELDS е истинска колона в таблицата books', () => {
  /* Обратната посока: излишно/сгрешено име в BOOK_FIELDS чупи целия запис на
     документ с „no such column", а списъкът се пипа при всяко ново поле. */
  const { db, returned } = setup();
  const columns = new Set(db.prepare('PRAGMA table_info(books)').all().map(c => c.name));
  const unknown = returned.BOOK_FIELDS.filter(f => !columns.has(f));
  assert.deepEqual(unknown, [], 'BOOK_FIELDS съдържа полета, каквито таблицата books няма');
});
