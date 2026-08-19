'use strict';
/* Тестове към поправките по одита за v2.3.0 (осем дефекта: резервации, МЗС,
   аналитични описания, изтриване с история, читателска сметка). Всеки тест тук
   пада с кода отпреди поправката и минава след нея — затова над всеки блок стои
   какъв е бил дефектът, а не какво прави тестът.

   Моделът е същият като в останалите тестове: за handler-ите — фалшив ipcMain,
   истинска временна SQLite база от db/schema.sql и подадени наготово зависимости
   (както в handlers-loans.test.js); за изгледите — jsdom върху src/index.html с
   мокнат window.api (както в views-regressions.test.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { JSDOM, VirtualConsole } = require('jsdom');

const { ftsQuery, BOOKS_FTS_SETUP_SQL, READERS_FTS_SETUP_SQL } = require('../search-fts');
/* diffFields (main.js) и csvCell (security-utils.js) — истинските, не двойници:
   двойникът на diffFields връщаше обект вместо масив, а този на csvCell не
   неутрализираше =/+/-/@. Вж. test/helpers/prod-values.js. */
const { diffFields, csvCell, normalizeScanCode } = require('./helpers/prod-values.js');

const registerHoldsHandlers = require('../handlers/holds');
const registerMzsHandlers = require('../handlers/mzs');
const registerAccountHandlers = require('../handlers/account');
const registerBooksHandlers = require('../handlers/books');
const registerReadersHandlers = require('../handlers/readers');


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
const RUN = (fn) => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err.message }; }
};
function tmpDir(tag) { return mkTmpDir(path.join(os.tmpdir(), 'inv-' + tag + '-')); }
function freshDb(dir, extraSql) {
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  if (extraSql) db.exec(extraSql);
  return db;
}

/* ===========================================================================
   1) Една резервация заключваше ВСИЧКИ свободни бройки.
   Схемата поддържа няколко екземпляра на едно заглавие (inventory.quantity,
   тригер trg_loans_capacity) и loans:checkout вече брои свободните бройки
   правилно, но consumeHoldOnCheckout отказваше заемане на всеки, различен от
   първия в опашката, без изобщо да поглежда бройките: книга с 3 екземпляра, 1
   зает и 1 чакащ ставаше незаемаема за всички останали, макар да има 2 свободни.
   =========================================================================== */

function setupHolds() {
  const db = freshDb(tmpDir('fix-holds'));
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const returned = registerHoldsHandlers(ipcMain, {
    getDb: () => db, run: RUN,
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    normalizeScanCode
  });
  return { db, ipcMain, auditLog, returned };
}
function addBook(db, { inv_number, quantity = 1 }) {
  const id = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (?, ?, 'наличен')")
    .run(inv_number, 'Книга ' + inv_number).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, quantity);
  return id;
}
function addReader(db, name) {
  return db.prepare('INSERT INTO readers (name) VALUES (?)').run(name).lastInsertRowid;
}
function lend(db, bookId, readerId) {
  return db.prepare("INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, '2026-01-01', '2026-01-31')")
    .run(bookId, readerId).lastInsertRowid;
}
function placeHold(db, bookId, readerId, status) {
  const id = db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(bookId, readerId).lastInsertRowid;
  if (status) db.prepare('UPDATE holds SET status = ? WHERE id = ?').run(status, id);
  return id;
}

test('чужда резервация не заключва свободните бройки — при 3 екземпляра, 1 зает и 1 чакащ друг читател взима книгата', () => {
  const { db, returned } = setupHolds();
  const bookId = addBook(db, { inv_number: 101, quantity: 3 });
  const petrov = addReader(db, 'Петров');
  const georgiev = addReader(db, 'Георгиев');
  lend(db, bookId, addReader(db, 'Държащ'));
  const holdId = placeHold(db, bookId, petrov);

  // Свободни са 2 бройки, пред Георгиев чака 1 резервация — стига и за двамата.
  returned.consumeHoldOnCheckout(bookId, georgiev);
  assert.equal(db.prepare('SELECT status FROM holds WHERE id=?').get(holdId).status, 'чака',
    'чуждата резервация не бива да се погасява от заемането на друг читател');
});

test('резервация втори в опашката се изпълнява, когато свободните бройки стигат за двамата', () => {
  const { db, returned } = setupHolds();
  const bookId = addBook(db, { inv_number: 102, quantity: 3 });
  const petrov = addReader(db, 'Петров');
  const georgiev = addReader(db, 'Георгиев');
  const first = placeHold(db, bookId, petrov);
  const second = placeHold(db, bookId, georgiev);

  returned.consumeHoldOnCheckout(bookId, georgiev);
  assert.equal(db.prepare('SELECT status FROM holds WHERE id=?').get(second).status, 'изпълнена',
    'погасява се собствената резервация на заемащия, а не първата в опашката');
  assert.equal(db.prepare('SELECT status FROM holds WHERE id=?').get(first).status, 'чака');
});

test('единствената свободна бройка си остава на чакащия — трети читател се отказва', () => {
  const { db, returned } = setupHolds();
  const bookId = addBook(db, { inv_number: 103, quantity: 1 });
  const petrov = addReader(db, 'Петров');
  const georgiev = addReader(db, 'Георгиев');
  placeHold(db, bookId, petrov, 'заделена');

  assert.throws(() => returned.consumeHoldOnCheckout(bookId, georgiev),
    /резервирана за Петров \(заделена, чака взимане\)/);
});

test('holds:add отказва резервация, докато има свободна бройка (2 от 3 екземпляра)', async () => {
  const { db, ipcMain } = setupHolds();
  const bookId = addBook(db, { inv_number: 104, quantity: 3 });
  lend(db, bookId, addReader(db, 'Държащ'));
  const petrov = addReader(db, 'Петров');

  const res = await ipcMain.invoke('holds:add', { reader_id: petrov, code: '104' });
  assert.equal(res.ok, false, 'заета е само 1 от 3 бройки — няма какво да се чака');
  assert.match(res.error, /2 свободни бройки/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM holds').get().n, 0);
});

/* ===========================================================================
   2) Заделена книга: трети читател получаваше две противоречащи съобщения —
   holds:add го пращаше да я заеме направо („свободен е“), а веднага след това
   loans:checkoutByCode отказваше със „заделена, чака взимане“. holds:add
   виждаше само отворените заемания и не знаеше за състоянието „заделена“.
   =========================================================================== */

test('заделена книга не е свободна — третият читател може да се нареди на опашката', async () => {
  const { db, ipcMain } = setupHolds();
  const bookId = addBook(db, { inv_number: 105, quantity: 1 });
  const ivanov = addReader(db, 'Иванов');
  const petrov = addReader(db, 'Петров');
  const georgiev = addReader(db, 'Георгиев');
  // Заемане → резервация → връщане → заделяне (точно последователността от одита).
  const loanId = lend(db, bookId, ivanov);
  placeHold(db, bookId, petrov);
  db.prepare("UPDATE loans SET date_in = '2026-01-20' WHERE id = ?").run(loanId);
  db.prepare("UPDATE holds SET status = 'заделена' WHERE book_id = ?").run(bookId);

  const res = await ipcMain.invoke('holds:add', { reader_id: georgiev, code: '105' });
  assert.equal(res.ok, true, 'книгата чака Петров — Георгиев не може да я вземе, значи трябва да се нареди');
  assert.equal(res.data.queue, 2, 'той е втори в опашката');
});

/* ===========================================================================
   3) Резервацията мълчаливо се записваше на читателя от раздел „Заемане“:
   CIRC.readerId оцелява при смяна на подраздела, формата питаше само за
   книгата и името на читателя не се показваше никъде — нито преди записа,
   нито в потвърждението.
   =========================================================================== */

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');

function safeDefault() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return (hint) => (hint === 'string' ? '' : 0);
      if (prop === 'length') return 0;
      if (['toString', 'toLocaleString', 'valueOf', 'toFixed', 'toUpperCase',
        'toLowerCase', 'trim', 'charAt', 'padStart', 'padEnd', 'repeat',
        'replace', 'replaceAll'].includes(prop)) return () => '';
      if (['map', 'filter', 'slice', 'sort', 'concat', 'split', 'match', 'flat', 'flatMap'].includes(prop)) return () => [];
      if (prop === 'forEach') return () => {};
      if (prop === 'join') return () => '';
      if (prop === 'reduce') return (fn, init) => init;
      if (['some', 'includes'].includes(prop)) return () => false;
      if (prop === 'every') return () => true;
      if (['find', 'indexOf', 'search'].includes(prop)) return () => (prop === 'indexOf' || prop === 'search' ? -1 : undefined);
      if (typeof prop === 'symbol') return undefined;
      return safeDefault();
    }
  });
}
function apiMock(overrides, calls) {
  function makeNode(parts) {
    const key = parts.join('.');
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeNode(parts.concat(prop));
      },
      apply(t, self, args) {
        if (calls) calls.push({ key, args });
        const data = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : safeDefault();
        return Promise.resolve({ ok: true, data });
      }
    });
  }
  return makeNode([]);
}
function buildDom(overrides, calls) {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  window.api = apiMock(overrides || {}, calls);
  window.confirm = () => true;
  window.prompt = () => { throw new Error('prompt() is not supported.'); };
  window.alert = () => {};
  window.print = () => {};
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const run = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  run(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  const order = Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
  for (const f of order) run(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'), `views/${f}`);
  if (errors.length) assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n---\n'));
  return dom;
}
async function settled(dom) {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return dom;
}

test('формата за резервация показва ЧИЙ е записът, преди да го запише', async () => {
  const dom = buildDom({ 'readers.get': { id: 5, name: 'Иван Петров', card_no: '0005' } });
  const { window } = dom;
  await settled(dom);
  // CIRC е top-level let в loans.js — стига се до него през глобалния обхват.
  window.eval('CIRC.readerId = 5');
  /* Не се чака докрай: askText() (пътят отпреди поправката) виси, докато някой
     не щракне бутон, а тук интересното е какво се вижда във формата. */
  await Promise.race([window.holdPrompt(), settled(dom)]);
  await settled(dom);

  const modalText = window.document.getElementById('modal').textContent;
  assert.match(modalText, /Иван Петров/, 'името на читателя трябва да се вижда във формата');
  assert.ok(window.document.querySelector('#modal [name="code"]'), 'полето за книгата остава');
  assert.ok(/Друг читател/.test(modalText), 'трябва да има и изричен път за смяна на читателя');
});

test('потвърждението след резервация казва на кого е записана', async () => {
  const dom = buildDom({
    'readers.get': { id: 5, name: 'Иван Петров', card_no: '0005' },
    'holds.add': { id: 1, title: 'Под игото', inv_number: 101, queue: 1 }
  });
  const { window } = dom;
  await settled(dom);
  const toasts = [];
  window.toast = (msg) => toasts.push(msg);
  window.markSaved = () => {};
  window.eval('CIRC.readerId = 5');
  /* Не се чака докрай: askText() (пътят отпреди поправката) виси, докато някой
     не щракне бутон, а тук интересното е какво се вижда във формата. */
  await Promise.race([window.holdPrompt(), settled(dom)]);
  await settled(dom);
  window.document.querySelector('#modal [name="code"]').value = '101';
  await window.saveHold(5);
  await settled(dom);

  assert.equal(toasts.length, 1, 'очаква се точно едно съобщение');
  assert.match(toasts[0], /Иван Петров/, 'потвърждението трябва да казва чия е резервацията');
  assert.match(toasts[0], /101/);
});

/* ===========================================================================
   4) mzs:update мълчаливо игнорираше no/year/date — липсваха в SET, а формата
   ги показва като редактируеми (№ е дори задължително поле). Сгрешен номер в
   регистъра на МЗС не можеше да се поправи по никакъв начин.
   =========================================================================== */

function setupMzs() {
  const db = freshDb(tmpDir('fix-mzs'));
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  registerMzsHandlers(ipcMain, {
    getDb: () => db, run: RUN,
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    yearOf: (d) => (d || '2026-08-02').slice(0, 4)
  });
  return { db, ipcMain, auditLog };
}

test('mzs:update поправя номера и датата на заявката', async () => {
  const { db, ipcMain } = setupMzs();
  const id = (await ipcMain.invoke('mzs:create', { no: 1, date: '2026-08-02', partner: 'X', title: 'Заявка' })).data;

  const res = await ipcMain.invoke('mzs:update', {
    id, no: 7, date: '2025-08-01', direction: 'изходящо', partner: 'X', title: 'Заявка', status: 'заявено'
  });
  assert.equal(res.ok, true);
  const row = db.prepare('SELECT no, year, date FROM mzs_requests WHERE id = ?').get(id);
  assert.equal(row.no, 7, 'номерът трябва да се обнови наистина');
  assert.equal(row.date, '2025-08-01');
  assert.equal(row.year, '2025', 'годината следва датата, както при mzs:create');
});

test('mzs:update отказва номер, зает от друга заявка за същата година', async () => {
  const { db, ipcMain } = setupMzs();
  await ipcMain.invoke('mzs:create', { no: 1, date: '2026-08-02', partner: 'X', title: 'Първа' });
  const id2 = (await ipcMain.invoke('mzs:create', { no: 2, date: '2026-08-03', partner: 'Y', title: 'Втора' })).data;

  const res = await ipcMain.invoke('mzs:update', { id: id2, no: 1, date: '2026-08-03', partner: 'Y', title: 'Втора' });
  assert.equal(res.ok, false);
  assert.match(res.error, /вече съществува/);
  assert.equal(db.prepare('SELECT no FROM mzs_requests WHERE id = ?').get(id2).no, 2, 'редът остава непокътнат');
});

test('mzs:update без подадени № и дата запазва старите (частична редакция)', async () => {
  const { db, ipcMain } = setupMzs();
  const id = (await ipcMain.invoke('mzs:create', { no: 4, date: '2026-03-03', partner: 'X', title: 'Заявка' })).data;
  const res = await ipcMain.invoke('mzs:update', { id, partner: 'Нов партньор', status: 'получено' });
  assert.equal(res.ok, true);
  const row = db.prepare('SELECT no, date, partner, status FROM mzs_requests WHERE id = ?').get(id);
  assert.deepEqual([row.no, row.date, row.partner, row.status], [4, '2026-03-03', 'Нов партньор', 'получено']);
});

/* ===========================================================================
   5) Редакцията на аналитично описание мълчаливо късаше връзката към книгата:
   полето се попълваше с „Автор. Заглавие“, а links:search връща
   „инв. № 5 · Автор. Заглавие“ — двата формата никога не съвпадаха, точното
   сравнение не намираше нищо и book_id се изпразваше само от докосване.
   =========================================================================== */

test('връзката към книгата оцелява при редакция на аналитично описание', async () => {
  const dom = buildDom({
    'analytics.get': {
      id: 1, title: 'Статия', source_kind: 'книга', year: '2019',
      book_id: 5, book_title: 'Под игото', book_author: 'Вазов, Иван', book_inv: 5
    },
    'periodicals.list': [],
    'links.search': [{ id: 5, label: 'инв. № 5 · Вазов, Иван. Под игото' }]
  });
  const { window } = dom;
  await settled(dom);
  await window.analyticForm(1);
  await settled(dom);

  const bp = window.document.querySelector('#anlF [name=book_pick]');
  const hidden = window.document.querySelector('#anlF [name=book_id]');
  assert.equal(hidden.value, '5', 'при отваряне връзката е налице');
  assert.equal(bp.value, 'инв. № 5 · Вазов, Иван. Под игото',
    'полето се попълва точно както го връща търсенето');

  // Докосване на полето (библиотекарят щраква в него и пише) — това чупеше връзката.
  bp.dispatchEvent(new window.Event('input'));
  await settled(dom);
  assert.equal(hidden.value, '5', 'book_id не бива да се изпразва само от докосване на полето');
});

test('нов запис остава без връзка към книга (полето е празно)', async () => {
  const dom = buildDom({ 'periodicals.list': [] });
  const { window } = dom;
  await settled(dom);
  await window.analyticForm(null);
  await settled(dom);
  assert.equal(window.document.querySelector('#anlF [name=book_pick]').value, '');
  assert.equal(window.document.querySelector('#anlF [name=book_id]').value, '');
});

/* ===========================================================================
   6) Затворената история правеше запис неизтриваем ЗАВИНАГИ: път за изтриване
   на заемане в програмата няма, затова сгрешен запис (сканиран погрешно инв.
   номер, приет обратно веднага, чак после разпознат като дубликат) оставаше
   вечно, а съобщението пращаше библиотекаря към акт за отчисляване на книга,
   която никога не е съществувала. Отказът при ОТВОРЕНО заемане си остава.
   =========================================================================== */

function setupBooks() {
  const db = freshDb(tmpDir('fix-books2'), BOOKS_FTS_SETUP_SQL);
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  registerBooksHandlers(ipcMain, {
    getDb: () => db, run: RUN, logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    today: () => '2026-08-02', ftsQuery, cnSortKey: (s) => String(s || ''),
    diffFields, scheduleCatalogWrite: () => {}, normalizeScanCode
  });
  return { db, ipcMain, auditLog };
}
function setupReaders() {
  const db = freshDb(tmpDir('fix-readers2'), READERS_FTS_SETUP_SQL);
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  registerReadersHandlers(ipcMain, {
    getDb: () => db, run: RUN, logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    today: () => '2026-08-02', ftsQuery,
    maskReaderRow: (r) => r, maskReaderRows: (rows) => rows, preparePiiForWrite: () => {},
    diffFields, checkRecordLimit: () => {},
    dialog: { showSaveDialog: async () => ({ canceled: true }) }, getMainWindow: () => ({}), fs,
    csvCell, normalizeScanCode
  });
  return { db, ipcMain, auditLog };
}
function closedLoan(db, bookId, readerId) {
  db.prepare("INSERT INTO loans (book_id, reader_id, date_out, date_due, date_in) VALUES (?, ?, '2024-01-01', '2024-01-31', '2024-01-20')")
    .run(bookId, readerId);
}

test('books:delete предупреждава първия път и изтрива при повторно натискане (сгрешен запис)', async () => {
  const { db, ipcMain, auditLog } = setupBooks();
  const bookId = (await ipcMain.invoke('books:create', { title: 'Сгрешен запис', inv_number: 7 })).data;
  closedLoan(db, bookId, addReader(db, 'Читател'));

  const first = await ipcMain.invoke('books:delete', bookId);
  assert.equal(first.ok, false, 'първото натискане само предупреждава');
  assert.match(first.error, /историята на заеманията/);
  assert.match(first.error, /акт за отчисляване/, 'правилният път за истинска книга си остава актът');
  assert.match(first.error, /още веднъж/, 'но изходът трябва да е показан');
  assert.ok(db.prepare('SELECT 1 FROM books WHERE id=?').get(bookId), 'книгата остава след първото натискане');

  const second = await ipcMain.invoke('books:delete', bookId);
  assert.equal(second.ok, true, 'повторното натискане изтрива');
  assert.equal(db.prepare('SELECT 1 FROM books WHERE id=?').get(bookId), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 0, 'историята си отива каскадно, както казва съобщението');
  assert.ok(auditLog.some(a => /Изтрит документ с история/.test(a.action)), 'изтриването остава в одитната следа');
});

test('books:delete не се поддава на второ натискане, докато заемането е ОТВОРЕНО', async () => {
  const { db, ipcMain } = setupBooks();
  const bookId = (await ipcMain.invoke('books:create', { title: 'Заета', inv_number: 8, quantity: 1 })).data;
  lend(db, bookId, addReader(db, 'Читател'));

  for (const attempt of [1, 2]) {
    const res = await ipcMain.invoke('books:delete', bookId);
    assert.equal(res.ok, false, 'опит № ' + attempt);
    assert.match(res.error, /зает в момента/);
  }
  assert.ok(db.prepare('SELECT 1 FROM books WHERE id=?').get(bookId));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 1);
});

test('readers:delete предупреждава първия път и изтрива при повторно натискане', async () => {
  const { db, ipcMain, auditLog } = setupReaders();
  const readerId = (await ipcMain.invoke('readers:create', { name: 'Дубликат' })).data;
  const bookId = db.prepare("INSERT INTO books (inv_number, title) VALUES (9, 'Книга')").run().lastInsertRowid;
  closedLoan(db, bookId, readerId);

  const first = await ipcMain.invoke('readers:delete', readerId);
  assert.equal(first.ok, false);
  assert.match(first.error, /Анонимизиране/, 'правилният път за истински читател си остава анонимизирането');
  assert.match(first.error, /още веднъж/);
  assert.ok(db.prepare('SELECT 1 FROM readers WHERE id=?').get(readerId));

  const second = await ipcMain.invoke('readers:delete', readerId);
  assert.equal(second.ok, true);
  assert.equal(db.prepare('SELECT 1 FROM readers WHERE id=?').get(readerId), undefined);
  assert.ok(auditLog.some(a => /Изтрит читател с история/.test(a.action)));
});

test('readers:delete не се поддава на второ натискане при невърнат документ', async () => {
  const { db, ipcMain } = setupReaders();
  const readerId = (await ipcMain.invoke('readers:create', { name: 'Държащ' })).data;
  const bookId = addBook(db, { inv_number: 10, quantity: 1 });
  lend(db, bookId, readerId);

  for (const attempt of [1, 2]) {
    const res = await ipcMain.invoke('readers:delete', readerId);
    assert.equal(res.ok, false, 'опит № ' + attempt);
    assert.match(res.error, /незавърнат документ/);
  }
  assert.ok(db.prepare('SELECT 1 FROM readers WHERE id=?').get(readerId));
});

/* ===========================================================================
   7) account:charge приема отрицателна сума. Защитата (Math.abs) съществува, но
   не беше покрита от нито един тест — премахването ѝ минаваше незабелязано, а
   знакът е носителят на смисъла в този дневник (минус = плащане).
   =========================================================================== */

function setupAccount() {
  const db = freshDb(tmpDir('fix-account'));
  const ipcMain = fakeIpcMain();
  registerAccountHandlers(ipcMain, {
    getDb: () => db, run: RUN, logAudit: () => {}, today: () => '2026-08-02'
  });
  const readerId = addReader(db, 'Читател');
  return { db, ipcMain, readerId };
}

test('account:charge превръща отрицателна сума в начисление, а не в скрито плащане', async () => {
  const { ipcMain, readerId } = setupAccount();
  const res = await ipcMain.invoke('account:charge', { reader_id: readerId, type: 'глоба', amount: -5 });
  assert.equal(res.ok, true);
  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.lines[0].amount, 5, 'начислението е положително число');
  assert.equal(got.data.lines[0].kind, 'начисление');
  assert.equal(got.data.balance, 5, 'дългът расте, не намалява');
});

test('account:charge/pay отказват нула, нечислово и безкрайност', async () => {
  const { ipcMain, readerId } = setupAccount();
  for (const amount of [0, '', 'абв', null, undefined, Infinity, -Infinity, NaN]) {
    for (const ch of ['account:charge', 'account:pay']) {
      const res = await ipcMain.invoke(ch, { reader_id: readerId, amount });
      assert.equal(res.ok, false, ch + ' с ' + String(amount));
      assert.match(res.error, /положителна/);
    }
  }
  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.lines.length, 0, 'нито един ред не е влязъл в сметката');
});

/* ===========================================================================
   8) Баланс „0.00 лв. (дължи)“ в червено след пълно плащане: сумите са REAL и
   1.10+1.10+1.10−3.30 дава 4.44e-16, което е > 0.
   =========================================================================== */

test('платена докрай сметка има баланс точно 0', async () => {
  const { ipcMain, readerId } = setupAccount();
  for (let i = 0; i < 3; i++) await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 1.10 });
  await ipcMain.invoke('account:pay', { reader_id: readerId, amount: 3.30 });

  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.balance, 0, 'остатъкът от плаващата запетая не бива да излиза навън');
  assert.ok(!(got.data.balance > 0), 'сметката не бива да се води „дължи“');
});

test('балансът остава верен при реални суми (стотинки не се губят)', async () => {
  const { ipcMain, readerId } = setupAccount();
  await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 12.35 });
  await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 0.07 });
  await ipcMain.invoke('account:pay', { reader_id: readerId, amount: 5.01 });
  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.balance, 7.41);
});

test('сметката не свети в червено с „(дължи)“ при остатък от плаваща запетая', async () => {
  const dom = buildDom({
    'readers.get': { id: 5, name: 'Иван Петров', card_no: '0005' },
    'account.get': { balance: 4.44e-16, lines: [{ id: 1, kind: 'плащане', type: 'плащане', amount: -3.30, date: '2026-08-02', note: '' }] },
    'settings.get': { annual_fee: 5 }
  });
  const { window } = dom;
  await settled(dom);
  await window.accountModal(5);
  await settled(dom);

  const box = window.document.getElementById('modal');
  assert.doesNotMatch(box.textContent, /\(дължи\)/, 'платената сметка не се води „дължи“');
  assert.doesNotMatch(box.innerHTML, /color:var\(--red\)">0\.00/, 'нулевият баланс не бива да е в червено');
  assert.match(box.textContent, /0\.00 лв\./);
});
