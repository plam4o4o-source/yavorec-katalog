'use strict';
/* Одит v2.4.24 — пълен обход на всички домейни.
   =====================================================================
   Този кръг тръгна от обслужването (заемане, връщане, резервации, сканиране) и
   стигна до фонда, читателите, справките, каталога, касата и резервните копия.
   Общото между най-скъпите находки е едно и също: НЯКЪДЕ ПРОГРАМАТА ГАДАЕ,
   ВМЕСТО ДА ОТКАЖЕ.

     • Кодът от баркод четеца се търсеше с `barcode = ? OR inv_number = CAST(?)`
       и .get(). Числов баркод, който съвпада с ЧУЖД инвентарен номер, връщаше
       просто реда с по-малък rowid — заемаше се, отчисляваше се и се завеждаше
       в протокол ДРУГА книга, тихо. resolveScannedBook() дава предимство на
       баркода и отказва, вместо да гадае.
     • loans:extend изтриваше начисленото просрочие: 36 дни забава и 1.80 лв.
       изчезваха с едно натискане на „Продължи“ — бутон, който стои на всеки ред
       на екрана „Просрочени“.
     • holds:add обявяваше за свободна бройка, която consumeHoldOnCheckout после
       отказваше — читателят не можеше нито да я вземе, нито да се нареди на
       опашката. А отмяната и изтичането на заделена резервация не викаха
       следващия по ред.
     • Актът за отчисляване можеше да отчисли един и същи инв. № два пъти, а
       анулирането връщаше всеки документ на „наличен“, изтривайки „липсващ“,
       установен от инвентаризация.
     • „Бележка при заемане“ на читателя не се записваше НИКОГА — полето липсваше
       в READER_FIELDS, а точно то съществува, за да предупреди на гишето.
     • Смяната на паролата за защита на личните данни се проваляше завинаги, ако
       един-единствен ред не се разчита — със сурово английско съобщение.

   Всеки тест тук е проверен с мутация: мутира се продукционният код в отделно
   копие и се проверява, че тестът почервенява. */
/* Часовата зона се ЗАДАВА: тестът за одитната следа сравнява UTC срещу местно
   време, а в зона UTC (каквато е и машината, на която тече поредицата) двете
   съвпадат и проверката би била празна. Задава се преди първото ползване на Date. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  APP_DIR, cleanupTmpDirs, fakeIpcMain, freshDb, runDep, pdpSetup, buildDom, settle
} = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values.js');
const { resolveScannedBook } = require('../security-utils');

/* ==================================================================
   1. Сканиране: числов баркод срещу чужд инвентарен номер
   ================================================================== */

function twoBooks(prefix) {
  const { db } = freshDb(prefix);
  // Инв. № 123 — „Под игото“. И баркодът на СЪВСЕМ ДРУГА книга е „123“.
  const a = db.prepare("INSERT INTO books (inv_number, title, barcode) VALUES (123, 'Под игото', 'BC-A')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO books (inv_number, title, barcode) VALUES (500, 'Тютюн', '123')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(a);
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(b);
  return { db, a, b };
}

test('код, който е баркод на един документ и инвентарен номер на друг, се ОТКАЗВА, а не се отгатва', () => {
  const { db } = twoBooks('v2424-scan-ambig-');
  assert.throws(() => resolveScannedBook(db, '123'), (e) => {
    assert.match(e.message, /баркод на .*Тютюн/);
    assert.match(e.message, /инвентарен номер на .*Под игото/);
    return true;
  });
});

test('един и същ баркод на два документа също се отказва, вместо да върне първия', () => {
  const { db } = freshDb('v2424-scan-dupbc-');
  db.prepare("INSERT INTO books (inv_number, title, barcode) VALUES (1, 'А', 'BC')").run();
  db.prepare("INSERT INTO books (inv_number, title, barcode) VALUES (2, 'Б', 'BC')").run();
  assert.throws(() => resolveScannedBook(db, 'BC'), /стои на 2 документа/);
});

test('еднозначните кодове минават: баркодът има предимство, инв. номерът работи, непознатият дава null', () => {
  // Контрол: отказът е ТЕСЕН и не пречи на нормалната работа на гишето.
  const { db, a, b } = twoBooks('v2424-scan-ok-');
  assert.equal(resolveScannedBook(db, 'BC-A').id, a, 'баркод BC-A → „Под игото“');
  assert.equal(resolveScannedBook(db, '500').id, b, 'инв. № 500 → „Тютюн“');
  assert.equal(resolveScannedBook(db, '77777'), null, 'непознат код → нищо, без грешка');
  assert.throws(() => resolveScannedBook(db, '   '), /Не е въведен баркод/);
});

test('resolveScannedBook работи и със свързаната проекция BOOK_SELECT (ORDER BY id не е двусмислен)', () => {
  const { db, a } = twoBooks('v2424-scan-booksel-');
  const row = resolveScannedBook(db, 'BC-A', BOOK_SELECT);
  assert.equal(row.id, a);
  assert.equal(row.quantity, 1, 'проекцията носи и бройката — тоест JOIN-овете минават');
});

/* ==================================================================
   2. Обслужване: продължение, връщане по баркод
   ================================================================== */

function loansSetup(prefix, over) {
  const { db } = freshDb(prefix);
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'loans'))(ipcMain, Object.assign({
    getDb: () => db, run: runDep,
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    today: () => '2026-09-03', logEvent: () => {}, BOOK_SELECT,
    scheduleCatalogWrite: () => {},
    circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 5, extension_days: 14, suspend_per_day: 1, suspend_max: 90 }),
    readerCategory: () => 'възрастен',
    nextWorkDay: (d) => d, closedDaysBetween: () => 0,
    firstActiveHold: () => null, consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null,
    normalizeScanCode, freeCopies: () => 1, activeHolds: () => []
  }, over || {}));
  return { db, ipcMain, auditLog };
}
function book(db, inv, opts) {
  const o = opts || {};
  const id = db.prepare('INSERT INTO books (inv_number, title, barcode) VALUES (?, ?, ?)')
    .run(inv, o.title || ('Книга ' + inv), o.barcode || null).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, o.qty == null ? 1 : o.qty);
  return id;
}

test('„Продължи“ на просрочено заемане НАЧИСЛЯВА забавата, вместо да я заличи', async () => {
  const { db, ipcMain, auditLog } = loansSetup('v2424-extend-');
  db.prepare('UPDATE settings SET fine_per_day = 0.05 WHERE id = 1').run();
  const b = book(db, 1);
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-07-01', '2026-07-29')").run(r, b);
  const id = db.prepare('SELECT id FROM loans').get().id;

  const res = await ipcMain.invoke('loans:extend', { id });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.daysLate, 36, '3 септември минус 29 юли');
  assert.equal(Number(res.data.fine.toFixed(2)), 1.80);
  const row = db.prepare('SELECT fine, date_due FROM loans WHERE id = ?').get(id);
  assert.equal(Number(row.fine.toFixed(2)), 1.80, 'начисленото се ЗАПИСВА, а не само се връща');
  assert.equal(row.date_due, '2026-09-17', 'новият срок тръгва от днес, не от стария падеж');
  assert.ok(db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(r).suspended_until,
    'наказанието в дни също се налага — както при връщане');
  const ext = auditLog.find(a => a.action === 'Продължение на заемане');
  assert.match(ext.detail, /начислена забава 36 дни, 1\.80 лв\./);
});

test('продължението на заемане В СРОК не начислява нищо', async () => {
  // Контрол: поправката не бива да въвежда глоба там, където няма забава.
  const { db, ipcMain } = loansSetup('v2424-extend-ok-');
  db.prepare('UPDATE settings SET fine_per_day = 0.05 WHERE id = 1').run();
  const b = book(db, 1);
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-09-01', '2026-09-20')").run(r, b);
  const id = db.prepare('SELECT id FROM loans').get().id;
  const res = await ipcMain.invoke('loans:extend', { id });
  assert.equal(res.data.daysLate, 0);
  assert.equal(res.data.fine, 0);
  assert.ok(!db.prepare('SELECT fine FROM loans WHERE id = ?').get(id).fine, 'нищо не е начислено');
  assert.equal(res.data.date_due, '2026-10-04', 'срокът се удължава от СТАРИЯ падеж, когато той е в бъдещето');
});

test('връщане по баркод отказва да гадае, когато ЕДНА бройка е заведена като заета от двама', async () => {
  // Една бройка, две отворени заемания = противоречив ред. Многоекземплярният
  // случай (bg. долу) е нормален и НЕ бива да се отказва.
  const { db, ipcMain } = loansSetup('v2424-returnbycode-ambig-');
  const b = book(db, 7, { qty: 2, barcode: 'BC7' });
  const r1 = db.prepare("INSERT INTO readers (name) VALUES ('Ана')").run().lastInsertRowid;
  const r2 = db.prepare("INSERT INTO readers (name) VALUES ('Борис')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-08-01', '2026-08-15')").run(r1, b);
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-08-02', '2026-08-16')").run(r2, b);
  /* Бройката се свива ДОПЪЛНИТЕЛНО — trg_loans_capacity не позволява втори заем
     върху една бройка, тоест точно този противоречив ред може да се появи само
     така: редакция на „Налични бройки“ след като заеманията вече съществуват. */
  db.prepare('UPDATE inventory SET quantity = 1 WHERE book_id = ?').run(b);

  const res = await ipcMain.invoke('loans:returnByCode', { code: 'BC7' });
  assert.equal(res.ok, false);
  assert.match(res.error, /при 1 налична бройка/);
  assert.match(res.error, /Ана, Борис/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n, 2,
    'нищо не е затворено — по-добре отказ, отколкото чуждо връщане');
});

test('но заглавие с ДВЕ бройки и две заемания се приема — връща се най-просроченото', async () => {
  /* Контрол към предишния тест. Първата редакция на тази поправка отказваше при
     всеки втори отворен заем и правеше гишето по баркод неизползваемо за всеки
     учебник с втора бройка — намерено при прегледа на кръга. */
  const { db, ipcMain } = loansSetup('v2424-returnbycode-multi-');
  const b = book(db, 9, { qty: 2, barcode: 'BC9' });
  const r1 = db.prepare("INSERT INTO readers (name) VALUES ('Ана')").run().lastInsertRowid;
  const r2 = db.prepare("INSERT INTO readers (name) VALUES ('Борис')").run().lastInsertRowid;
  // Борис е с по-ранен падеж, тоест по-просрочен — неговото заемане се затваря.
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-08-02', '2026-08-20')").run(r1, b);
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-08-01', '2026-08-10')").run(r2, b);

  const res = await ipcMain.invoke('loans:returnByCode', { code: 'BC9' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.reader_name, 'Борис');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n, 1);
});

test('противоречието се мери спрямо БРОЙКИТЕ, не спрямо единица', async () => {
  /* Втори преглед на кръга: правилото беше „отказвай само при qty <= 1“, тоест три
     отворени заемания срещу коригирани на 2 бройки минаваха и връщането затваряше
     чуждо заемане с чужда глоба и чуждо наказание. */
  const { db, ipcMain } = loansSetup('v2424-returnbycode-qty-');
  const b = book(db, 13, { qty: 3, barcode: 'BC13' });
  const names = ['Ана', 'Борис', 'Вера'];
  const dues = ['2026-09-20', '2026-08-01', '2026-08-25'];
  names.forEach((n, i) => {
    const r = db.prepare('INSERT INTO readers (name) VALUES (?)').run(n).lastInsertRowid;
    db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-07-01', ?)").run(r, b, dues[i]);
  });
  // Един екземпляр е отписан — бройките стават 2, заеманията остават 3.
  db.prepare('UPDATE inventory SET quantity = 2 WHERE book_id = ?').run(b);

  const res = await ipcMain.invoke('loans:returnByCode', { code: 'BC13' });
  assert.equal(res.ok, false);
  assert.match(res.error, /при 2 налични бройки/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n, 3);
});

test('екранът „Просрочени“ иска СЪЩОТО, което ще поиска гишето', async () => {
  /* Втори преглед на кръга: loans:overdue и loans:overdueByReader ПРЕЗАПИСВАХА
     прочетеното `fine`, тоест начисленото при продължение не стигаше нито до
     екрана, нито до напомнителното писмо — писмото искаше 0.25 лв., гишето 2.05. */
  const { db, ipcMain } = loansSetup('v2424-overdue-fine-');
  db.prepare('UPDATE settings SET fine_per_day = 0.05 WHERE id = 1').run();
  const b = book(db, 12);
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Ана')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-07-01', '2026-07-29')").run(r, b);
  const id = db.prepare('SELECT id FROM loans').get().id;
  await ipcMain.invoke('loans:extend', { id });                       // начислява 1.80
  db.prepare("UPDATE loans SET date_due = '2026-08-29' WHERE id = ?").run(id); // и пак просрочва

  const over = await ipcMain.invoke('loans:overdue');
  assert.equal(over.ok, true, over.error);
  assert.equal(Number(over.data[0].fine.toFixed(2)), 2.05, '1.80 начислени + 0.25 нови');
  const byReader = await ipcMain.invoke('loans:overdueByReader');
  assert.equal(Number(byReader.data[0].fine.toFixed(2)), 2.05, 'и писмото иска същото');
  const ret = await ipcMain.invoke('loans:return', { id, date_in: '2026-09-03' });
  assert.equal(Number(ret.data.fine.toFixed(2)), 2.05, 'и гишето събира същото');
});

test('връщането НЕ заличава обезщетението, начислено при продължение', async () => {
  /* Преглед на поправките от този кръг: loans:extend ДОБАВЯ начисленото, а двата
     пътя за връщане ПРИСВОЯВАХА — след продължение падежът е в бъдещето, тоест
     при връщането забавата е 0 и присвояването изтриваше точно това, което
     продължението току-що начисли. */
  const { db, ipcMain } = loansSetup('v2424-fine-keep-');
  db.prepare('UPDATE settings SET fine_per_day = 0.05 WHERE id = 1').run();
  const b = book(db, 11, { barcode: 'BC11' });
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Ана')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-07-01', '2026-07-29')").run(r, b);
  const id = db.prepare('SELECT id FROM loans').get().id;

  const ext = await ipcMain.invoke('loans:extend', { id });
  assert.equal(ext.ok, true, ext.error);
  assert.equal(Number(db.prepare('SELECT fine FROM loans WHERE id = ?').get(id).fine.toFixed(2)), 1.80);

  const ret = await ipcMain.invoke('loans:return', { id, date_in: '2026-09-03' });
  assert.equal(ret.ok, true, ret.error);
  assert.equal(ret.data.daysLate, 0, 'спрямо новия падеж няма забава');
  assert.equal(Number(db.prepare('SELECT fine FROM loans WHERE id = ?').get(id).fine.toFixed(2)), 1.80,
    'начисленото при продължението остава');
  assert.equal(Number(ret.data.fine.toFixed(2)), 1.80, 'на гишето се иска ЦЯЛОТО дължимо, не днешната част');
  assert.equal(ret.data.fineNow, 0);
});

test('връщане по баркод при едно заемане минава както винаги', async () => {
  // Контрол: отказът по-горе не бива да спира обичайното гише.
  const { db, ipcMain } = loansSetup('v2424-returnbycode-ok-');
  db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const b = book(db, 8, { barcode: 'BC8' });
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Ана')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-08-01', '2026-08-29')").run(r, b);
  const res = await ipcMain.invoke('loans:returnByCode', { code: 'BC8' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.reader_name, 'Ана');
  assert.equal(res.data.daysLate, 5);
  assert.equal(Number(res.data.fine.toFixed(2)), 0.50);
  assert.equal(db.prepare('SELECT date_in FROM loans').get().date_in, '2026-09-03');
});

/* ==================================================================
   3. Резервации: свободна за едните, заета за другите
   ================================================================== */

function holdsSetup(prefix) {
  const { db } = freshDb(prefix);
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const ret = require(path.join(APP_DIR, 'handlers', 'holds'))(ipcMain, {
    getDb: () => db, run: runDep,
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    today: () => '2026-09-03', normalizeScanCode
  });
  return { db, ipcMain, auditLog, ret };
}

test('заделената бройка НЕ е свободна: третият читател се нарежда на опашката, вместо да го пращат да я вземе', async () => {
  const { db, ipcMain } = holdsSetup('v2424-holds-queue-');
  const b = book(db, 1, { barcode: 'BC1' });
  const r1 = db.prepare("INSERT INTO readers (name) VALUES ('Първи')").run().lastInsertRowid;
  const r2 = db.prepare("INSERT INTO readers (name) VALUES ('Втори')").run().lastInsertRowid;
  // Бройката ЧАКА първия читател — тя не е нито заета, нито свободна.
  db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'заделена', '2026-09-01')").run(b, r1);

  const res = await ipcMain.invoke('holds:add', { reader_id: r2, code: 'BC1' });
  assert.equal(res.ok, true, res.error);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM holds WHERE status = 'чака'").get().n, 1,
    'вторият чака, вместо да получи „свободен е — заемете го направо“');
});

test('отмяната на ЗАДЕЛЕНА резервация вика следващия по ред', async () => {
  const { db, ipcMain, auditLog } = holdsSetup('v2424-holds-cancel-');
  const b = book(db, 2, { barcode: 'BC2' });
  const r1 = db.prepare("INSERT INTO readers (name, card_no) VALUES ('Първи', 'A1')").run().lastInsertRowid;
  const r2 = db.prepare("INSERT INTO readers (name, card_no) VALUES ('Втори', 'A2')").run().lastInsertRowid;
  const h1 = db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'заделена', '2026-09-01')").run(b, r1).lastInsertRowid;
  db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'чака', '2026-09-02')").run(b, r2);

  const res = await ipcMain.invoke('holds:cancel', h1);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.next.reader_name, 'Втори', 'библиотекарят вижда кого да повика');
  assert.equal(db.prepare('SELECT status FROM holds WHERE reader_id = ?').get(r2).status, 'заделена');
  assert.ok(auditLog.some(a => a.action === 'Заделена книга'));
});

test('отмяната на ЧАКАЩА резервация не мести никого', async () => {
  // Контрол: повикването е само когато наистина се освобождава заделена бройка.
  const { db, ipcMain } = holdsSetup('v2424-holds-cancel-wait-');
  const b = book(db, 3, { barcode: 'BC3' });
  const r1 = db.prepare("INSERT INTO readers (name) VALUES ('Първи')").run().lastInsertRowid;
  const r2 = db.prepare("INSERT INTO readers (name) VALUES ('Втори')").run().lastInsertRowid;
  db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'заделена', '2026-09-01')").run(b, r1);
  const h2 = db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'чака', '2026-09-02')").run(b, r2).lastInsertRowid;
  const res = await ipcMain.invoke('holds:cancel', h2);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data, null, 'няма кого да повикаме');
  assert.equal(db.prepare('SELECT status FROM holds WHERE reader_id = ?').get(r1).status, 'заделена');
});

/* ==================================================================
   4. Фонд: актът за отчисляване
   ================================================================== */

function actsSetup(prefix) {
  const { db } = freshDb(prefix);
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'deaccession-acts'))(ipcMain, {
    getDb: () => db, run: runDep,
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    today: () => '2026-09-03', BOOK_SELECT, scheduleCatalogWrite: () => {},
    yearOf: (d) => String(d || '2026').slice(0, 4),
    normalizeScanCode, flushCatalogWrite: () => ({ written: true })
  });
  return { db, ipcMain, auditLog };
}
const ACT = { no: 1, date: '2026-09-03', reason_code: 6, reason_text: 'липсващи', committee1: 'А' };

test('един и същ инв. № не влиза във втори акт — КДБФ не отчита два пъти една книга', async () => {
  const { db, ipcMain } = actsSetup('v2424-act-twice-');
  const b = book(db, 100);
  db.prepare('UPDATE books SET price = 10 WHERE id = ?').run(b);
  const first = await ipcMain.invoke('deaccessionActs:create', { act: ACT, bookIds: [b] });
  assert.equal(first.ok, true, first.error);
  // Второто работно място е държало формата отворена и записва свой акт № 2.
  const second = await ipcMain.invoke('deaccessionActs:create',
    { act: Object.assign({}, ACT, { no: 2 }), bookIds: [b] });
  assert.equal(second.ok, false);
  assert.match(second.error, /вече е отчислен с акт/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_acts').get().n, 1,
    'вторият акт изобщо не се съставя — иначе фондът губи 20 лв. вместо 10');
});

test('изчезнал документ спира съставянето на акта, вместо да го скъси мълчаливо', async () => {
  const { db, ipcMain } = actsSetup('v2424-act-missing-');
  const b1 = book(db, 101);
  const b2 = book(db, 102);
  db.prepare('DELETE FROM books WHERE id = ?').run(b2);
  const res = await ipcMain.invoke('deaccessionActs:create', { act: ACT, bookIds: [b1, b2] });
  assert.equal(res.ok, false);
  assert.match(res.error, /вече не съществува/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_acts').get().n, 0);
});

test('анулирането връща предишното състояние, а не обявява липсващата книга за налична', async () => {
  const { db, ipcMain, auditLog } = actsSetup('v2424-act-revoke-');
  const b = book(db, 42);
  db.prepare("UPDATE books SET status = 'липсващ' WHERE id = ?").run(b);
  const created = await ipcMain.invoke('deaccessionActs:create', { act: ACT, bookIds: [b] });
  assert.equal(created.ok, true, created.error);
  const actId = created.data;

  const rev = await ipcMain.invoke('deaccessionActs:revoke', actId);
  assert.equal(rev.ok, true, rev.error);
  assert.equal(db.prepare('SELECT status FROM books WHERE id = ?').get(b).status, 'липсващ',
    'книгата физически я няма — анулирането на сгрешен акт не я намира');
  const line = auditLog.find(a => a.action === 'Анулиране на акт');
  assert.match(line.detail, /акт № 1\/2026/, 'следата сочи номера на акта, а не вътрешния rowid');
});

test('анулиране на несъществуващ акт се отказва, вместо да върне „готово“', async () => {
  const { ipcMain, auditLog } = actsSetup('v2424-act-revoke-none-');
  const res = await ipcMain.invoke('deaccessionActs:revoke', 999);
  assert.equal(res.ok, false);
  assert.match(res.error, /не е намерен/);
  assert.equal(auditLog.length, 0, 'няма следа за акт, който никога не е съществувал');
});

/* ==================================================================
   5. Инвентаризация: документите при подвързвача
   ================================================================== */

test('„за реставрация“ не е липса, а протоколът се събира точно', async () => {
  const { db } = freshDb('v2424-invent-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'inventory-sessions'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-09-03', normalizeScanCode,
    // От продукцията, не преписани — виж бележката в test/helpers/prod-values.js.
    pctRequired: require('./helpers/prod-values.js').pctRequired,
    naturalLoss: require('./helpers/prod-values.js').naturalLoss
  });
  for (let i = 1; i <= 10; i++) book(db, i);
  db.prepare("UPDATE books SET status = 'за реставрация' WHERE inv_number IN (9, 10)").run();
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Ч')").run().lastInsertRowid;
  const lent = db.prepare('SELECT id FROM books WHERE inv_number = 8').get().id;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-08-01', '2026-09-30')").run(r, lent);

  const s = await ipcMain.invoke('inventorySessions:start',
    { date: '2026-09-03', scope: 'целият фонд', committee1: 'А', committee2: 'Б', committee3: 'В' });
  assert.equal(s.ok, true, s.error);
  const sid = s.data.id || s.data;
  for (let i = 1; i <= 6; i++) await ipcMain.invoke('inventorySessions:scan', { sessionId: sid, code: String(i) });
  const c = await ipcMain.invoke('inventorySessions:close', { sessionId: sid, mode: 'full' });
  assert.equal(c.ok, true, c.error);
  const d = c.data;
  assert.equal(d.atBinder, 2, 'двете при подвързвача се обявяват отделно');
  assert.equal(d.missing, 1, 'липсва само инв. № 7');
  assert.equal(d.scanned + d.onLoan + d.atBinder + d.missing, d.pool,
    'протоколът се СЪБИРА: в обхвата = проверени + заети + за реставрация + липсващи');
  assert.equal(db.prepare("SELECT status FROM books WHERE inv_number = 9").get().status, 'за реставрация',
    'състоянието на книгата при подвързвача не се презаписва на „липсващ“');
});

/* ==================================================================
   6. Читатели: бележката при заемане и служебният запис
   ================================================================== */

function readersSetup(prefix) {
  const { db } = freshDb(prefix);
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'readers'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    today: () => '2026-09-03', ftsQuery: () => '',
    maskReaderRow: (r) => r, maskReaderRows: (r) => r, preparePiiForWrite: (v) => v,
    diffFields: () => [], checkRecordLimit: () => {},
    dialog: {}, getMainWindow: () => ({}), fs: require('fs'),
    csvCell: (v) => v, normalizeScanCode
  });
  return { db, ipcMain, auditLog };
}

test('„Бележка при заемане“ наистина се записва — и при създаване, и при редакция', async () => {
  const { db, ipcMain } = readersSetup('v2424-alertnote-');
  const c = await ipcMain.invoke('readers:create',
    { name: 'Иван', card_no: 'K1', alert_note: 'Носи още старата книга на брат си' });
  assert.equal(c.ok, true, c.error);
  const id = c.data;
  assert.equal(db.prepare('SELECT alert_note FROM readers WHERE id = ?').get(id).alert_note,
    'Носи още старата книга на брат си', 'иначе гишето никога не показва предупреждението');

  const u = await ipcMain.invoke('readers:update', { id, name: 'Иван', card_no: 'K1', alert_note: 'Плати таксата' });
  assert.equal(u.ok, true, u.error);
  assert.equal(db.prepare('SELECT alert_note FROM readers WHERE id = ?').get(id).alert_note, 'Плати таксата');
});

test('служебният запис за анонимизирани заемания не може да бъде изтрит', async () => {
  const { db, ipcMain } = readersSetup('v2424-anon-delete-');
  const { ANON_READER_NAME } = require('../security-utils');
  const id = db.prepare("INSERT INTO readers (name, status) VALUES (?, 'прекратен')").run(ANON_READER_NAME).lastInsertRowid;
  const b = book(db, 1);
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_in, anon_category) VALUES (?, ?, '2019-01-01', '2019-02-01', 'дете·2019')").run(id, b);

  const first = await ipcMain.invoke('readers:delete', id);
  assert.equal(first.ok, false);
  assert.match(first.error, /служебният запис/);
  // Дори втори опит (пътят „натиснете още веднъж“) не минава.
  const second = await ipcMain.invoke('readers:delete', id);
  assert.equal(second.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 1, 'анонимизираната история е непокътната');
});

test('единственият запис в историята се брои в единствено число', async () => {
  const { db, ipcMain } = readersSetup('v2424-plural-');
  const id = db.prepare("INSERT INTO readers (name) VALUES ('Дубликат')").run().lastInsertRowid;
  const b = book(db, 5);
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_in) VALUES (?, ?, '2026-01-01', '2026-01-10')").run(id, b);
  const res = await ipcMain.invoke('readers:delete', id);
  assert.equal(res.ok, false);
  assert.match(res.error, /1 запис в историята/);
  assert.ok(!/1 записа/.test(res.error));
});

/* ==================================================================
   7. Напомняния: изчистено поле не бива да значи „трето напомняне“
   ================================================================== */

test('празна настройка за напомняне пада към стойността по подразбиране, а не към ниво 3', async () => {
  const { db } = freshDb('v2424-notices-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'notices'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-09-03',
    shell: {}, LOAN_SELECT: require('./helpers/prod-values.js').LOAN_SELECT,
    effectiveDaysLate: (due, t) => Math.max(0, Math.round((new Date(t) - new Date(due)) / 864e5))
  });
  // Точно това пише формулярът на настройките за изчистено числово поле.
  db.prepare("UPDATE settings SET remind2_days = '', remind3_days = '' WHERE id = 1").run();
  const b = book(db, 1);
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Ч')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-08-01', '2026-09-01')").run(r, b);

  const res = await ipcMain.invoke('loans:reminders');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data[0].level, 1,
    'два дни забава е ПЪРВО напомняне — не заплаха за спиране на достъпа');
});

test('settings:update записва изчистеното числово поле като NULL, не като празен низ', async () => {
  const { db } = freshDb('v2424-settings-num-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'settings'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {},
    dialog: {}, getMainWindow: () => ({}), fs: require('fs'), path
  });
  const base = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const res = await ipcMain.invoke('settings:update',
    Object.assign({}, base, { remind2_days: '', extensions_count: '', loan_days: '21' }));
  assert.equal(res.ok, true, res.error);
  const row = db.prepare('SELECT remind2_days, extensions_count, loan_days FROM settings WHERE id = 1').get();
  assert.equal(row.remind2_days, null);
  assert.equal(row.extensions_count, null, 'иначе лимитът от продължения тихо отпада');
  assert.equal(row.loan_days, 21, 'попълнените стойности си остават числа');
});

/* ==================================================================
   8. Защита на личните данни: смяна на паролата при повреден ред
   ================================================================== */

test('един неразчитаем ред не спира смяната на паролата', async () => {
  const { db, ipcMain, pii } = pdpSetup('v2424-pdp-change-', 'старата-парола-1');
  // Три читателя, единият презаписан с чужд ключ (станция с мъртва парола —
  // точно случаят, заради който съществува проверката при отключване).
  for (const n of ['А', 'Б', 'В']) {
    const id = db.prepare('INSERT INTO readers (name) VALUES (?)').run(n).lastInsertRowid;
    const key = pii.deriveKey('старата-парола-1',
      Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
    db.prepare('UPDATE readers SET egn = ? WHERE id = ?').run(pii.encryptField('000000000' + id, key), id);
  }
  const foreign = pii.deriveKey('чужда-парола-9', pii.generateSalt(pii.CURRENT_KDF_VERSION));
  const victim = db.prepare("SELECT id FROM readers WHERE name = 'Б'").get().id;
  db.prepare('UPDATE readers SET egn = ? WHERE id = ?').run(pii.encryptField('9999999999', foreign), victim);

  const res = await ipcMain.invoke('pdp:changePassword',
    { oldPassword: 'старата-парола-1', newPassword: 'новата-парола-2' });
  assert.equal(res.ok, true, res.error);

  // Здравите редове се четат с НОВАТА парола…
  const newKey = pii.deriveKey('новата-парола-2',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
  const ok = db.prepare("SELECT egn FROM readers WHERE name = 'А'").get().egn;
  assert.ok(pii.decryptField(ok, newKey), 'здравият ред е прекриптиран');
  // …а повреденият е оставен както си е, а не изтрит.
  assert.ok(db.prepare('SELECT egn FROM readers WHERE id = ?').get(victim).egn,
    'нечетимата стойност не се губи — просто остава нечетима');
});

/* ==================================================================
   9. Каса и периодика
   ================================================================== */

function accountSetup(prefix) {
  const { db } = freshDb(prefix);
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'account'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    today: () => '2026-09-03'
  });
  return { db, ipcMain, auditLog };
}

test('изтриването на ред от сметката оставя следа и отказва за несъществуващ ред', async () => {
  const { db, ipcMain, auditLog } = accountSetup('v2424-account-del-');
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Иванка')").run().lastInsertRowid;
  const line = await ipcMain.invoke('account:pay', { reader_id: r, amount: 12, date: '2025-03-11' });
  assert.equal(line.ok, true, line.error);
  auditLog.length = 0;

  const del = await ipcMain.invoke('account:deleteLine', line.data);
  assert.equal(del.ok, true, del.error);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /Иванка/);
  assert.match(auditLog[0].detail, /2025-03-11/);
  assert.match(auditLog[0].detail, /12\.00 лв\./);

  const again = await ipcMain.invoke('account:deleteLine', line.data);
  assert.equal(again.ok, false, 'изтрит ред не се „изтрива“ втори път с ok:true');
  assert.match(again.error, /вече не съществува/, 'и то с обяснение, а не със сурова техническа грешка');
});

test('плащане под стотинка се отказва, вместо да отпечата квитанция за 0.00 лв.', async () => {
  const { db, ipcMain } = accountSetup('v2424-account-cents-');
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Иванка')").run().lastInsertRowid;
  const res = await ipcMain.invoke('account:pay', { reader_id: r, amount: 0.004 });
  assert.equal(res.ok, false);
  assert.match(res.error, /поне 0\.01/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_lines').get().n, 0);
});

test('изданието не се трие, докато към него има аналитични описания', async () => {
  const { db } = freshDb('v2424-periodicals-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'periodicals'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-09-03'
  });
  const pid = db.prepare("INSERT INTO periodicals (title) VALUES ('Литературен вестник')").run().lastInsertRowid;
  db.prepare("INSERT INTO analytics (title, source_kind, periodical_id) VALUES ('Статия', 'периодика', ?)").run(pid);

  const res = await ipcMain.invoke('periodicals:delete', pid);
  assert.equal(res.ok, false);
  assert.match(res.error, /1 аналитично описание/);
  assert.equal(db.prepare('SELECT periodical_id FROM analytics').get().periodical_id, pid,
    'източникът на статията не е заличен');
});

/* ==================================================================
   10. Одитната следа: часът е UTC, показва се като местен
   ================================================================== */

test('одитната следа показва часа в местно време, а не суровия UTC', async () => {
  const dom = buildDom({
    'audit.list': [{ id: 1, ts: '2026-01-03 22:40:00', user: 'Библиотекар', action: 'Заемане', detail: 'инв. № 1' }]
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#odit';
  await window.route();
  await settle();
  const shown = window.document.querySelector('#view .num').textContent;
  const expected = new Date('2026-01-03T22:40:00Z').toLocaleString('bg-BG');
  const naive = new Date('2026-01-03 22:40:00').toLocaleString('bg-BG');
  assert.notEqual(expected, naive, 'предпоставка: зоната наистина е различна от UTC');
  assert.equal(shown, expected, 'часът е ПРЕВЪРНАТ от UTC в местно време');
  assert.notEqual(shown, naive,
    'иначе действие в 00:40 на 4 януари се вписва като 22:40 на 3 януари — в ДРУГ ДЕН');
});

/* ==================================================================
   11. Проверка на данните: отчислен без акт
   ================================================================== */

test('„отчислен“ без акт се показва в проверката на данните и се връща във фонда', async () => {
  const { db } = freshDb('v2424-orphan-deacc-');
  const auditLog = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'books'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    today: () => '2026-09-03', ftsQuery: () => '', cnSortKey: () => '',
    diffFields: () => [], scheduleCatalogWrite: () => {}, normalizeScanCode
  });
  const orphan = book(db, 1);
  db.prepare("UPDATE books SET status = 'отчислен' WHERE id = ?").run(orphan);
  const proper = book(db, 2);
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date, reason_code, reason_text) VALUES (1, '2026', '2026-05-05', 6, 'липсващи')").run().lastInsertRowid;
  db.prepare("UPDATE books SET status = 'отчислен', deaccession_date = '2026-05-05', deaccession_act_id = ? WHERE id = ?").run(actId, proper);

  const list = await ipcMain.invoke('books:deaccessionedWithoutAct');
  assert.equal(list.ok, true, list.error);
  assert.equal(list.data.length, 1, 'редовно отчисленият с акт НЕ е отклонение');
  assert.equal(list.data[0].inv_number, 1);

  const fix = await ipcMain.invoke('books:clearOrphanDeaccession', orphan);
  assert.equal(fix.ok, true, fix.error);
  assert.equal(db.prepare('SELECT status FROM books WHERE id = ?').get(orphan).status, 'наличен');
  assert.match(auditLog[0].detail, /без акт/);

  const refused = await ipcMain.invoke('books:clearOrphanDeaccession', proper);
  assert.equal(refused.ok, false, 'документ, отчислен с акт, не се пипа оттук');
  assert.match(refused.error, /анулирайте го/);
});

test('вносът не приема „отчислен“ като състояние — отчисляване има само с акт', async () => {
  const { db } = freshDb('v2424-import-deacc-');
  const importers = require(path.join(APP_DIR, 'handlers', 'data-import'));
  assert.ok(typeof importers === 'function');
  // Проверява се самият източник: единственото място, което решава дали суровият
  // статус влиза като статус. Пълният път на вноса се тества в собствения си файл.
  const src = require('fs').readFileSync(path.join(APP_DIR, 'handlers', 'data-import.js'), 'utf8');
  assert.match(src, /const deaccStatus = rawStatus === 'отчислен';/);
  assert.match(src, /const knownStatus = !deaccStatus && BOOK_STATUSES\.includes\(rawStatus\);/);
  db.close();
});
