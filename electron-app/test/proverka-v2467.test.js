'use strict';
/* ============================================================================
   v2.4.67 — ПРОВЕРКА ЗА ГРЕШКИ: поправките без екран.
   ============================================================================
   Находки от прегледа на по-стария код за пари и отчетни числа. Всяка е
   ВЪЗПРОИЗВЕДЕНА на истинска база, преди да бъде пипната, и всеки тест тук е
   проверен с връщане на поправката.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { APP_DIR, mkTmpDir, cleanupTmpDirs, fakeIpcMain, runDep } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

function freshDb(prefix) {
  const dir = mkTmpDir(prefix);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  return db;
}
const cat = (db) => db.prepare('SELECT id FROM categories LIMIT 1').get().id;
const addReader = (db, name) => db.prepare(
  "INSERT INTO readers (name, status, gdpr_consent) VALUES (?, 'активен', 1)").run(name).lastInsertRowid;

/* ------------------------------------------------------------------------ */
test('закръгляне до евроцент: половината се закръгля нагоре и когато двоичният запис е „под“ нея', () => {
  const { toCents } = require(path.join(APP_DIR, 'db', 'fund-sql'));
  /* 1,005 в двоичен вид е 1,00499999…; Math.round(1.005 * 100) / 100 дава 1. */
  assert.equal(Math.round(1.005 * 100) / 100, 1, 'предпоставката: досегашната формула греши');
  assert.equal(toCents(1.005), 1.01);
  assert.equal(toCents(1.015), 1.02);
  assert.equal(toCents(2.675), 2.68);
  assert.equal(toCents(-1.005), -1.01, 'плащанията са отрицателни — половината отива навън и при тях');
  assert.equal(toCents(0.1 + 0.2), 0.3);
  assert.ok(Object.is(toCents(-1e-15), 0), 'никога „-0“ — печата се като „-0.00“');
  assert.equal(toCents('12.5'), 12.5);
  assert.equal(toCents('abc'), 0);
  /* Сумите в цели стотинки не се променят нито една. */
  for (let c = 0; c < 20000; c += 7) assert.equal(toCents(c / 100), Math.round(c) / 100);
  /* И всички места, които закръглят пари, ползват нея, не свое копие. */
  for (const f of ['account.js', 'loans.js', 'deaccession-acts.js', 'fund-check.js', 'periodicals.js']) {
    const src = fs.readFileSync(path.join(APP_DIR, 'handlers', f), 'utf8');
    assert.ok(!/=\s*\(\w+\)\s*=>\s*Math\.round\(\(Number\(\w+\) \|\| 0\) \* 100\) \/ 100/.test(src),
      f + ' пак има свое копие на закръглянето');
  }
});

/* ------------------------------------------------------------------------ */
function holdsSetup(prefix) {
  const db = freshDb(prefix);
  const ipcMain = fakeIpcMain();
  const api = require(path.join(APP_DIR, 'handlers', 'holds'))(ipcMain,
    { getDb: () => db, run: runDep, logAudit: () => {}, normalizeScanCode: (x) => x });
  return { db, api };
}
test('втора върната бройка без чакащ не се заделя повторно за вече обслужения читател', () => {
  const { db, api } = holdsSetup('inv-p67-holds-');
  const b = db.prepare("INSERT INTO books (inv_number, title, category_id, status) VALUES (1, 'Учебник', ?, 'наличен')")
    .run(cat(db)).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 2)').run(b);   // стар запис с 2 бройки
  const x = addReader(db, 'Заемател 1'), y = addReader(db, 'Заемател 2'), a = addReader(db, 'Чакащ А');
  const l1 = db.prepare("INSERT INTO loans (reader_id, book_id, date_out) VALUES (?, ?, '2026-09-01')").run(x, b).lastInsertRowid;
  const l2 = db.prepare("INSERT INTO loans (reader_id, book_id, date_out) VALUES (?, ?, '2026-09-01')").run(y, b).lastInsertRowid;
  db.prepare("INSERT INTO holds (book_id, reader_id, status) VALUES (?, ?, 'чака')").run(b, a);

  db.prepare("UPDATE loans SET date_in = '2026-09-10' WHERE id = ?").run(l1);
  const first = api.activateHoldOnReturn(b);
  assert.equal(first && first.status, 'заделена', 'първото връщане заделя за А');

  db.prepare("UPDATE loans SET date_in = '2026-09-11' WHERE id = ?").run(l2);
  const second = api.activateHoldOnReturn(b);
  assert.equal(second, null, 'втората бройка е излишна — отива на рафта, не при заделените за А');
});
test('заделената бройка, заета от друг и върната, пак се връща при заделените', () => {
  const { db, api } = holdsSetup('inv-p67-holds2-');
  const b = db.prepare("INSERT INTO books (inv_number, title, category_id, status) VALUES (1, 'Роман', ?, 'наличен')")
    .run(cat(db)).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(b);
  const a = addReader(db, 'Чакащ А'), z = addReader(db, 'Друг');
  db.prepare("INSERT INTO holds (book_id, reader_id, status) VALUES (?, ?, 'заделена')").run(b, a);
  const l = db.prepare("INSERT INTO loans (reader_id, book_id, date_out) VALUES (?, ?, '2026-09-01')").run(z, b).lastInsertRowid;
  db.prepare("UPDATE loans SET date_in = '2026-09-05' WHERE id = ?").run(l);
  const r = api.activateHoldOnReturn(b);
  assert.ok(r && r.status === 'заделена', 'единствената бройка е нужна за заделената резервация на А');
});

/* ------------------------------------------------------------------------ */
test('КДБФ: наличността към 01.01 съвпада с тази към 31.12 на миналата година и при отчислен документ без дата', () => {
  const db = freshDb('inv-p67-kdbf-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'kdbf'))(ipcMain, { getDb: () => db, run: runDep, yearOf: () => '2026' });
  const c = cat(db);
  db.prepare("INSERT INTO books (id, inv_number, title, category_id, status, price, register_date) VALUES (1, 1, 'Нормален', ?, 'наличен', 10, '2025-02-01')").run(c);
  db.prepare("INSERT INTO books (id, inv_number, title, category_id, status, price, register_date) VALUES (2, 2, 'Без дата', ?, 'наличен', 5, NULL)").run(c);
  for (const id of [1, 2]) db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
  db.prepare("INSERT INTO deaccession_acts (id, no, year, date) VALUES (1, 1, '2026', '2026-03-01')").run();
  db.prepare("INSERT INTO deaccession_items (act_id, book_id, inv_number, title, price, quantity) VALUES (1, 2, 2, 'Без дата', 5, 1)").run();
  db.prepare("UPDATE books SET status = 'отчислен', deaccession_act_id = 1, deaccession_date = '2026-03-01' WHERE id = 2").run();

  const k25 = ipcMain.invoke('kdbf:report', '2025').data;
  const k26 = ipcMain.invoke('kdbf:report', '2026').data;
  /* Част № 3 си остава с всичко отчислено — актът е документ по чл. 39. */
  assert.equal(k26.deaccYear.n, 1, 'Част № 3 брои отчисления документ');
  assert.deepEqual(k26.deaccOutOfStock, { n: 1, v: 5 }, 'и казва, че той не е бил в наличността');
  /* Част № 2 вади само бившите в наличността — и веригата се затваря. */
  const inStock = k26.deaccYear.n - k26.deaccOutOfStock.n;
  const start26 = k26.stockEnd.n - k26.acquiredYear.n + inStock;
  assert.equal(start26, k25.stockEnd.n,
    'наличност към 01.01.2026 (' + start26 + ') трябва да е равна на тази към 31.12.2025 (' + k25.stockEnd.n + ')');

  /* И екранът, и разпечатката смятат Част № 2 през едно и също място. */
  const view = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'kdbf.js'), 'utf8');
  assert.match(view, /const \{ n: decN, v: decV \} = kdbfDeaccInStock\(r\);/, 'екранът — Част № 2 без отчислените извън наличността');
  assert.match(view, /<td>Отчислени през \$\{y\} г\.<\/td><td>\$\{kdbfDeaccInStock\(r\)\.n\}<\/td>/, 'разпечатката — същото');
  assert.ok(!/r\.stockEnd\.n - r\.acquiredYear\.n \+ r\.deaccYear\.n/.test(view), 'нито едно място не извежда 01.01 от целия deaccYear');
});

/* ------------------------------------------------------------------------ */
const addLine = (db, reader, date, kind, type, amount) => db.prepare(
  'INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
  .run(reader, date, kind, type, amount, 'проба').lastInsertRowid;

test('аванс: плащане, записано ден ПРЕДИ начислението, покрива начислението (сметка и писмо)', () => {
  const { chargeCoverage } = require(path.join(APP_DIR, 'handlers', 'account'));
  const { unpaidOverdueFines } = require(path.join(APP_DIR, 'handlers', 'loans'));
  const db = freshDb('inv-p67-avans-');
  const r = addReader(db, 'Платил предварително');
  addLine(db, r, '2026-03-10', 'плащане', 'плащане', -5);
  const lost = addLine(db, r, '2026-03-11', 'начисление', 'обезщетение за изгубен документ', 5);
  const cov = chargeCoverage(db, lost);
  assert.equal(cov.outstanding, 0, 'салдото е 0,00 — начислението е покрито от плащането преди него');
  assert.equal(cov.covered, 5);

  const r2 = addReader(db, 'Забава, платена предварително');
  addLine(db, r2, '2026-04-01', 'плащане', 'плащане', -1.5);
  addLine(db, r2, '2026-04-02', 'начисление', 'обезщетение', 1.5);
  assert.equal(unpaidOverdueFines(db, r2, 0), 0, 'писмото по чл. 43 не бива да иска платеното');
});

test('годишен отчет: аванс от декември се брои в годината на плащането; платената заварена забава се брои', () => {
  const db = freshDb('inv-p67-stats-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'stats'))(ipcMain, {
    getDb: () => db, run: runDep, yearOf: () => '2026', value: () => 0, dnevnikSumRow: () => ({})
  });
  const collected = (y) => ipcMain.invoke('stats:report', y).data.finesCollected;

  /* Аванс на 30.12.2026, обезщетението вписано на 02.01.2027. */
  const a = addReader(db, 'Аванс');
  addLine(db, a, '2026-12-30', 'плащане', 'плащане', -5);
  addLine(db, a, '2027-01-02', 'начисление', 'обезщетение', 5);
  assert.equal(collected('2026'), 5, 'парите са получени през 2026 г.');
  assert.equal(collected('2027'), 0, 'и не се броят втори път през 2027 г.');

  /* Заварена забава само в loans.fine (продължение под v2.4.60), платена 2026. */
  const b = addReader(db, 'Заварена забава');
  const book = db.prepare("INSERT INTO books (inv_number, title, category_id, status) VALUES (7, 'Тютюн', ?, 'наличен')")
    .run(cat(db)).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(book);
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due, fine) VALUES (?, ?, '2026-01-10', '2026-02-10', 2.7)").run(b, book);
  addLine(db, b, '2026-05-05', 'плащане', 'плащане', -2.7);
  assert.equal(collected('2026'), 7.7, 'и заварените 2,70 € за забава са събрано обезщетение (5 + 2,70)');
});

/* ------------------------------------------------------------------------ */
test('миграция 17: заварените приключени протоколи получават процента, а по-късна смяна не пипа норматива им', async () => {
  const { startMainApp } = require('./helpers/main-app');
  /* Заварена база с версия 16: колоната още я няма, има приключен протокол,
     процентът на свободен достъп е 40 (под 50 → допустими 0,5 % от обхвата). */
  const app = startMainApp({
    seedDb(dbPath) {
      const db = new Database(dbPath);
      db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
      db.exec('ALTER TABLE inventory_sessions DROP COLUMN free_access_pct');
      db.prepare('UPDATE settings SET free_access_pct = 40 WHERE id = 1').run();
      db.prepare(`INSERT INTO inventory_sessions (id, date, scope, closed, mode, no, year, pool_size, pool_final,
          on_loan, at_binder, scanned_final) VALUES (1, '2025-11-20', 'пълна', 1, 'full', 1, '2025', 1000, 1000, 0, 0, 993)`).run();
      db.pragma('user_version = 16');
      db.close();
    }
  });
  try {
    await app.ready();
    const db = new Database(path.join(app.userData, 'library.db'));
    assert.equal(db.pragma('user_version', { simple: true }), 17);
    assert.equal(db.prepare('SELECT free_access_pct FROM inventory_sessions WHERE id = 1').get().free_access_pct, 40,
      'заварената приключена сесия получава процента от момента на обновяването');
    const before = (await app.invoke('inventorySessions:get', 1)).data.allowedLoss;
    assert.equal(before, 5, '1000 × 0,5 % = 5');
    /* Настройката се сменя по-късно — подписаният протокол НЕ бива да се променя. */
    db.prepare('UPDATE settings SET free_access_pct = 60 WHERE id = 1').run();
    const after = (await app.invoke('inventorySessions:get', 1)).data.allowedLoss;
    assert.equal(after, 5, 'нормативът на приключения протокол остава 5, а не става 10');
    db.close();
  } finally { app.stop(); }
});

test('чл. 41: процентът се снима при приключване — по-късна смяна на настройката не пренаписва протокола', async () => {
  const { pctRequired, naturalLoss, normalizeScanCode } = require('./helpers/prod-values.js');
  const db = freshDb('invpct-');
  const ipc = fakeIpcMain();
  require('../handlers/inventory-sessions')(ipc, {
    getDb: () => db, run: runDep, logAudit: () => {}, pctRequired, naturalLoss, normalizeScanCode
  });
  db.prepare('UPDATE settings SET free_access_pct = 40 WHERE id = 1').run();
  const ins = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (?, 'К', 'наличен')");
  for (let i = 1; i <= 400; i++) ins.run(i);
  const sessionId = (await ipc.invoke('inventorySessions:start', { date: '2026-08-02', scope: 'пълна',
    department: null, committee1: null, committee2: null, committee3: null })).data;
  const closed = await ipc.invoke('inventorySessions:close', { sessionId, mode: 'full' });
  assert.equal(closed.ok, true, closed.error);
  assert.equal(closed.data.allowedLoss, 2, '400 × 0,5 % = 2');
  assert.equal(db.prepare('SELECT free_access_pct FROM inventory_sessions WHERE id = ?').get(sessionId).free_access_pct, 40);
  db.prepare('UPDATE settings SET free_access_pct = 60 WHERE id = 1').run();
  assert.equal((await ipc.invoke('inventorySessions:get', sessionId)).data.allowedLoss, 2,
    'подписаният протокол остава с норматива към деня на приключването');
});
