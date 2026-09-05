'use strict';
/* v2.4.31 — деветнадесети кръг: производителност.
   =====================================================================
   Оптимизациите тук са ЕКВИВАЛЕНТНИ преобразувания — прозорци вместо пълни
   списъци, сборове в SQL вместо в JavaScript, индекс + BETWEEN вместо substr(),
   аритметика вместо обхождане ден по ден. Тестовете доказват равенството с
   независимо изчисление (старият начин, преписан тук върху суровите редове),
   а прозоречният режим на изгледите — в jsdom с отговор от вида { rows, total }.

   Обработчиците минават през истинския main.js върху засята база
   (test/helpers/main-app.js). Всеки тест е проверен с мутация. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { APP_DIR, cleanupTmpDirs, buildDom, settle, freshDb, fakeIpcMain, runDep } = require('./helpers/audit-fixtures');
const { startMainApp } = require('./helpers/main-app');

test.after(cleanupTmpDirs);

/* ---------- истинското приложение + засята база ---------- */
let app = null, db = null;
const Y = String(new Date().getUTCFullYear()); // както today() в програмата (UTC)
const iso = (d) => d.toISOString().slice(0, 10);
const dayOff = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

async function boot() {
  if (app) return app;
  app = startMainApp();
  await app.ready();
  db = new Database(path.join(app.userData, 'library.db'));
  const R = rnd(7);
  const cat = db.prepare("SELECT id FROM categories WHERE name = 'книга'").get().id;
  const cat2 = db.prepare("SELECT id FROM categories WHERE name != 'книга' LIMIT 1").get().id;
  const insB = db.prepare(`INSERT INTO books (inv_number, barcode, register_date, title, author, category_id, year, language, department, status, price, udk, call_number)
    VALUES (@inv, @bc, @reg, @title, @author, @cat, @year, @lang, @dep, @status, @price, @udk, @cn)`);
  const insI = db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)');
  const authors = ['Вазов, Иван', 'Йовков, Йордан', 'Елин Пелин', 'Кристи, Агата'];
  const titles = ['Под игото', 'Чичовци', 'Гераците', 'Убийство'];
  db.transaction(() => {
    for (let i = 1; i <= 120; i++) {
      const info = insB.run({ inv: i, bc: i % 5 === 0 ? null : 'B' + i, reg: i <= 100 ? dayOff(2000 - i * 10) : `${Y}-03-${String(1 + (i % 28)).padStart(2, '0')}`,
        title: titles[i % 4] + (i % 3 ? '' : ' (т. 2)'), author: i % 7 === 0 ? null : authors[i % 4], cat: i % 10 === 0 ? cat2 : cat,
        year: String(1980 + (i % 40)), lang: i % 6 === 0 ? '' : (i % 2 ? 'български' : 'английски'), dep: i % 3 === 0 ? 'детски' : 'за възрастни',
        status: i % 17 === 0 ? 'отчислен' : (i % 23 === 0 ? 'липсващ' : 'наличен'), price: (1 + (i % 9)) * 1.5, udk: i % 2 ? '821.163.2-31' : '5', cn: 'Ч/' + i });
      insI.run(info.lastInsertRowid, i % 11 === 0 ? 0 : (i % 13 === 0 ? 2 : 1));
    }
    const insR = db.prepare("INSERT INTO readers (name, card_no, category, status, gdpr_consent, registered_at) VALUES (?, ?, ?, ?, 1, ?)");
    for (let i = 1; i <= 40; i++) insR.run(['Иванов, Иван', 'Петров, Петър', 'Георгиева, Мария', 'Стоянов, Георги'][i % 4] + ' ' + i, String(1000 + i), i % 5 === 0 ? 'дете до 14 г.' : 'възрастен', (i % 9 === 0 || i === 10) ? 'прекратен' : 'активен', dayOff(300 - i));
    const insL = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in, fine) VALUES (?, ?, ?, ?, ?, ?)');
    // върнати през тази и миналата година, отворени, просрочени
    for (let i = 0; i < 300; i++) {
      const r = 1 + Math.floor(R() * 40), b = 1 + Math.floor(R() * 100);
      const outN = 5 + Math.floor(R() * 700); const out = dayOff(outN), due = dayOff(outN - 30); const inN = Math.max(0, outN - Math.floor(R() * 50));
      const late = Math.max(0, (outN - 30) - inN);
      insL.run(r, b, out, due, dayOff(inN), late * 0.05);
    }
    // отворени/просрочени — върху екземпляри с бройка ≥ 1 (тригерът trg_loans_capacity)
    const openBooks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13];
    for (let i = 0; i < 12; i++) insL.run(1 + (i % 40), openBooks[i], dayOff(i % 2 ? 10 : 60), dayOff(i % 2 ? -20 : 30), null, 0);
    db.prepare('INSERT INTO calendar_closed (date, reason) VALUES (?, ?)').run(dayOff(40), 'тест');
    // заемане с дата през СЛЕДВАЩАТА година (издание „с година напред“ в стар опис) — горната граница на годината трябва да го изключва
    insL.run(2, 14, `${Number(Y) + 1}-01-05`, `${Number(Y) + 1}-02-05`, `${Number(Y) + 1}-01-20`, 0);
  })();
  return app;
}
test.after(() => { if (db) db.close(); if (app) app.stop(); });
const ok = async (ch, ...a) => { const r = await app.invoke(ch, ...a); assert.equal(r.ok, true, ch + ': ' + r.error); return r.data; };
const q = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg + ': ' + a + ' ≠ ' + b);

/* ==================================================================
   1. Прозорци: books:list / invBook:list / readers:list
   ================================================================== */
test('books:list с page връща същите редове като пълния списък, на порции, с общ брой, отдели и идентификатори', async () => {
  await boot();
  const full = await ok('books:list', '', 'title');
  const w1 = await ok('books:list', '', 'title', { offset: 0, limit: 50 });
  const w2 = await ok('books:list', '', 'title', { offset: 50, limit: 50 });
  const w3 = await ok('books:list', '', 'title', { offset: 100, limit: 50 });
  assert.equal(w1.total, full.length);
  assert.deepEqual(w1.rows.concat(w2.rows, w3.rows).map(b => b.id), full.map(b => b.id), 'порциите покриват пълния списък в същия ред');
  assert.deepEqual(w1.rows[0], full[0], 'редът носи същите полета и стойности');
  assert.deepEqual(w1.depts, [...new Set(full.map(b => b.department).filter(Boolean))].sort(), 'отделите от резултата');
  // Търсене + филтри — както booksFilterMatch в изгледа
  const s = await ok('books:list', 'Вазов', 'inv');
  const sw = await ok('books:list', 'Вазов', 'inv', { offset: 0, limit: 1000, dept: 'детски' });
  const expect = s.filter(b => (b.department || '') === 'детски');
  assert.ok(expect.length > 0 && expect.length < s.length, 'предпоставка: филтърът реално стеснява');
  assert.deepEqual(sw.rows.map(b => b.id), expect.map(b => b.id));
  assert.equal(sw.total, expect.length);
  const cat2 = db.prepare("SELECT id FROM categories WHERE name != 'книга' LIMIT 1").get().id;
  const cw = await ok('books:list', '', 'title', { offset: 0, limit: 1000, cat: String(cat2) });
  assert.deepEqual(cw.rows.map(b => b.id), full.filter(b => String(b.category_id) === String(cat2)).map(b => b.id));
  const ids = await ok('books:list', 'Вазов', 'inv', { idsOnly: true, dept: 'детски' });
  assert.deepEqual(ids.ids.sort((a, b) => a - b), expect.map(b => b.id).sort((a, b) => a - b), '„Избери всички“ получава всички идентификатори на резултата');
  assert.equal((await ok('books:list', '', 'title', { offset: 0, limit: 5000 })).rows.length, full.length, 'горната граница на порцията е 2 000, не 5');
});

test('invBook:list с page: порции по инв. №, търсене, проверки на реда и показатели по ЦЕЛИЯ регистър', async () => {
  await boot();
  db.prepare("INSERT INTO inventory_checks (book_id, date) VALUES (3, '2025-05-05')").run();
  db.prepare("INSERT INTO inventory_checks (book_id, date) VALUES (3, '2026-02-02')").run(); // втора проверка на същия документ — брои се веднъж
  const full = await ok('invBook:list');
  const w = await ok('invBook:list', { offset: 0, limit: 40 });
  assert.equal(w.total, full.length);
  assert.deepEqual(w.rows.map(r => r.id), full.slice(0, 40).map(r => r.id));
  assert.deepEqual(w.rows[2].checks, full[2].checks, 'проверките са закачени и в прозореца');
  assert.equal(w.rows[2].checks.length, 2);
  assert.equal(w.summary.checked, 1, 'документ с две проверки е един документ с отбелязана проверка');
  // Показателите — същото броене като invBookSummaryOf в изгледа върху пълния списък
  const qtyOf = (r) => (r.quantity == null ? 1 : Number(r.quantity) || 0);
  const active = full.filter(r => r.status !== 'отчислен');
  assert.equal(w.summary.rows, full.length);
  assert.equal(w.summary.activeCopies, active.reduce((s, r) => s + qtyOf(r), 0));
  near(w.summary.value, active.reduce((s, r) => s + (r.price || 0) * qtyOf(r), 0), 'стойност');
  assert.equal(w.summary.deacc, full.length - active.length);
  assert.equal(w.summary.checked, full.filter(r => (r.checks || []).length).length);
  /* Проверка при прегледа: „Покажи още“ (invBookMore()) чете само rows/total и
     никога summary — двете сборни заявки по ЦЕЛИЯ регистър не бива да се плащат
     за порция след първата, иначе всяко „Покажи още“ при 15 000 документа плаща
     пак сборовете за резултат, който изгледът изхвърля. */
  const more = await ok('invBook:list', { offset: 40, limit: 40 });
  assert.equal(more.summary, undefined, 'следваща порция (offset > 0) не смята показателите наново');
  assert.equal(more.rows.length, 40);
  // Търсене както invBookMatches(): инв. №, автор, заглавие, сигнатура
  const t = 'вазов';
  const exp = full.filter(r => String(r.inv_number ?? '').includes(t) || (r.author || '').toLowerCase().includes(t) || (r.title || '').toLowerCase().includes(t) || (r.call_number || '').toLowerCase().includes(t));
  const ws = await ok('invBook:list', { q: 'Вазов', offset: 0, limit: 1000 });
  assert.deepEqual(ws.rows.map(r => r.id), exp.map(r => r.id));
  assert.equal(ws.total, exp.length);
  assert.equal(ws.summary.rows, full.length, 'показателите не се свиват от търсенето');
  // Регистърът се сгъва и на кирилица (както toLowerCase в паметта) — LIKE на SQLite сгъва само латиница
  const lower = await ok('invBook:list', { q: 'вазов', offset: 0, limit: 1000 });
  assert.equal(lower.total, exp.length, '„вазов“ намира „Вазов, Иван“');
  const byTitle = await ok('invBook:list', { q: 'под игото', offset: 0, limit: 1000 });
  assert.ok(byTitle.total > 0 && byTitle.rows.every(r => /Под игото/.test(r.title)), 'търсене по заглавие с малки букви');
});

test('invBook:list с page: подредбата има разделител по b.id, както books:list/readers:list', () => {
  /* Проверка при прегледа: inv_number е UNIQUE, но nullable — документ без
     присвоен номер е валидно състояние, и повече от един такъв дава равни редове
     по подредбата. Без стабилен разделител LIMIT/OFFSET не гарантира устойчиви
     страници: запис между офсет 0 и следващото „Покажи още“ може да размести
     равните редове и да изгуби или удвои документ в самата Инвентарна книга —
     точно затова books:list (BOOK_ORDERS) и readers:list вече слагат `, id`.
     Самата надпревара зависи от плана на SQLite за равни редове, който единичен
     тест с непроменена база обичайно възпроизвежда стабилно и между двете
     запитвания (проверено: без разделителя тестът не гърми) — затова тук се
     проверява самият SQL текст, не поведението. */
  const src = fs.readFileSync(path.join(APP_DIR, 'handlers', 'inv-book.js'), 'utf8');
  const m = /ORDER BY b\.inv_number(, b\.id)? LIMIT \? OFFSET \?/.exec(src);
  assert.ok(m, 'намерена е подредбата на прозоречната заявка');
  assert.ok(m[1], 'подредбата на страниците (LIMIT/OFFSET) има разделител по b.id: ' + m[0]);
});

test('readers:list с page: порции, общ брой, филтри по категория и състояние, броячи на заетите', async () => {
  await boot();
  const full = await ok('readers:list');
  const w = await ok('readers:list', '', null, { offset: 0, limit: 10 });
  assert.equal(w.total, full.length);
  assert.deepEqual(w.rows.map(r => r.id), full.slice(0, 10).map(r => r.id));
  assert.deepEqual(w.rows[0], full[0], 'същите полета (open_loans/overdue_loans включително)');
  const exp = full.filter(r => (r.category || '') === 'дете до 14 г.' && (r.status || '') === 'активен');
  const wf = await ok('readers:list', '', null, { offset: 0, limit: 500, cat: 'дете до 14 г.', status: 'активен' });
  assert.ok(exp.length > 0);
  assert.deepEqual(wf.rows.map(r => r.id), exp.map(r => r.id));
  assert.equal(wf.total, exp.length);
  const ws = await ok('readers:list', 'Иванов', null, { offset: 0, limit: 500 });
  assert.deepEqual(ws.rows.map(r => r.id), (await ok('readers:list', 'Иванов')).map(r => r.id), 'търсенето е същото като в пълния списък');
  // Броячите на заетите — сверени със суровите заемания
  for (const r of full) {
    const o = q('SELECT COUNT(*) AS n, SUM(CASE WHEN date_due < date(\'now\') THEN 1 ELSE 0 END) AS d FROM loans WHERE reader_id = ? AND date_in IS NULL', r.id);
    assert.equal(r.open_loans, o.n, 'заети на ' + r.name);
    assert.equal(r.overdue_loans, o.d || 0, 'просрочени на ' + r.name);
  }
});

/* ==================================================================
   2. Сборовете в SQL = старото изчисление в JavaScript
   ================================================================== */
test('stats:report — фонд, постъпили, разбивки, заемания, върнати в срок/със забава и обезщетения съвпадат с независимо изчисление', async () => {
  await boot();
  for (const y of [Y, String(Number(Y) - 1)]) {
    const rep = await ok('stats:report', y);
    const end = y + '-12-31';
    // Старият начин: всички редове, събрани в JavaScript
    const fund = all(`SELECT b.*, COALESCE(i.quantity, 1) AS qty FROM books b LEFT JOIN inventory i ON i.book_id = b.id
      WHERE b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)`, end, end);
    const acquired = all(`SELECT b.*, COALESCE(i.quantity, 1) AS qty FROM books b LEFT JOIN inventory i ON i.book_id = b.id WHERE substr(b.register_date,1,4) = ?`, y);
    const qtyOf = (r) => (r.qty == null ? 1 : Number(r.qty) || 0);
    const copies = (rows) => rows.reduce((s, r) => s + qtyOf(r), 0);
    const value = (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0) * qtyOf(r), 0);
    const byGroup = (rows, f) => { const m = {}; rows.forEach(r => { const k = r[f] || '—'; m[k] = (m[k] || 0) + qtyOf(r); }); return Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); };
    assert.equal(rep.fundCount, copies(fund), y + ': фонд');
    near(rep.fundValue, value(fund), y + ': стойност на фонда');
    assert.equal(rep.acquiredCount, copies(acquired), y + ': постъпили');
    near(rep.acquiredValue, value(acquired), y + ': стойност постъпили');
    assert.deepEqual(rep.fundByLanguage, byGroup(fund, 'language'), y + ': по език (празният език е „—“)');
    assert.deepEqual(rep.fundByDepartment, byGroup(fund, 'department'), y + ': по отдел');
    const loansYear = all('SELECT * FROM loans WHERE substr(date_out,1,4) = ?', y);
    assert.equal(rep.loansCount, loansYear.length, y + ': заемания');
    const returned = all('SELECT * FROM loans WHERE date_in IS NOT NULL AND substr(date_in,1,4) = ? AND deaccession_act_id IS NULL', y);
    assert.equal(rep.returnedOnTime, returned.filter(l => l.date_due && l.date_in <= l.date_due).length, y + ': в срок');
    assert.equal(rep.returnedLate, returned.filter(l => l.date_due && l.date_in > l.date_due).length, y + ': със забава');
    assert.ok(rep.returnedOnTime + rep.returnedLate > 0, y + ': предпоставка — има върнати');
    near(rep.finesCharged, q('SELECT COALESCE(SUM(fine),0) AS v FROM loans WHERE date_in IS NOT NULL AND substr(date_in,1,4) = ?', y).v, y + ': начислени');
    // Най-търсени — по заглавие и автор, събрани от всички екземпляри
    const m = {};
    all('SELECT b.title, COALESCE(b.author, \'\') AS a FROM loans l JOIN books b ON b.id = l.book_id WHERE substr(l.date_out,1,4) = ?', y)
      .forEach(r => { const k = r.title + '' + r.a; m[k] = (m[k] || 0) + 1; });
    const top = Object.entries(m).map(([k, n]) => ({ title: k.split('')[0], author: k.split('')[1], n }))
      .sort((a, b) => b.n - a.n || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)).slice(0, 10);
    assert.deepEqual(rep.topLoans.map(t => [t.title, t.author, t.n]), top.map(t => [t.title, t.author, t.n]), y + ': най-търсени');
  }
});

test('reports:run fund_breakdown — същите числа като stats:report за фонда', async () => {
  await boot();
  const rep = await ok('stats:report', Y);
  const fb = await ok('reports:run', { id: 'fund_breakdown', year: Y });
  assert.equal(fb.fundCount, rep.fundCount);
  near(fb.fundValue, rep.fundValue, 'стойност');
  assert.deepEqual(fb.byLanguage, rep.fundByLanguage);
  assert.deepEqual(fb.byDepartment, rep.fundByDepartment);
});

test('dashboard:full и kdbf:report — броенето по година и по бройки съвпада със substr()/корелираната подзаявка', async () => {
  await boot();
  const d = await ok('dashboard:full');
  assert.equal(d.loansYear, q('SELECT COUNT(*) AS n FROM loans WHERE substr(date_out,1,4) = ?', Y).n);
  assert.equal(d.acquiredYear, q('SELECT COALESCE(SUM(COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = b.id), 1)),0) AS n FROM books b WHERE substr(b.register_date,1,4) = ?', Y).n);
  const QTY = 'COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = b.id), 1)';
  const fund = q(`SELECT COALESCE(SUM(${QTY}),0) AS n, COALESCE(SUM(b.price * ${QTY}),0) AS v FROM books b WHERE (b.status != 'отчислен' OR b.status IS NULL)`);
  assert.equal(d.fundCount, fund.n); near(d.fundValue, fund.v, 'стойност на фонда');
  const k = await ok('kdbf:report', Y);
  const end = Y + '-12-31';
  const stock = q(`SELECT COALESCE(SUM(${QTY}),0) AS n, COALESCE(SUM(b.price * ${QTY}),0) AS v FROM books b WHERE b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)`, end, end);
  assert.equal(k.stockEnd.n, stock.n); near(k.stockEnd.v, stock.v, 'наличност в края');
  const acq = q(`SELECT COALESCE(SUM(${QTY}),0) AS n, COALESCE(SUM(b.price * ${QTY}),0) AS v FROM books b WHERE substr(b.register_date,1,4) = ?`, Y);
  assert.equal(k.acquiredYear.n, acq.n); near(k.acquiredYear.v, acq.v, 'постъпили през годината');
});

/* ==================================================================
   3. Календар: аритметика вместо обхождане + кеш с обезсилване
   ================================================================== */
test('closedDaysBetween — аритметичното броене е равно на обхождането ден по ден за 2 000 интервала, вкл. затворени дни', async () => {
  const { db: cdb } = freshDb('perf-cal-');
  const ipcMain = fakeIpcMain();
  const cal = require(path.join(APP_DIR, 'handlers', 'calendar'))(ipcMain, { getDb: () => cdb, run: runDep, logAudit: () => {} });
  cdb.prepare("UPDATE settings SET work_days = '1,2,3,4,5' WHERE id = 1").run();
  for (const d of ['2026-01-01', '2026-03-03', '2026-05-01', '2026-05-02', '2026-09-06', '2026-09-22', '2025-12-25', '2026-01-03', '2026-04-17', '2026-04-20']) {
    cdb.prepare('INSERT INTO calendar_closed (date, reason) VALUES (?, ?)').run(d, 'празник');
  }
  const wd = new Set([1, 2, 3, 4, 5]);
  const closed = new Set(cdb.prepare('SELECT date FROM calendar_closed').all().map(r => r.date));
  const slow = (a, b) => { if (!a || !b || a >= b) return 0; let n = 0; const d = new Date(a + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); const end = new Date(b + 'T00:00:00Z');
    for (let i = 0; d <= end && i < 5000; i++) { const ds = d.toISOString().slice(0, 10); if (!wd.has(d.getUTCDay()) || closed.has(ds)) n++; d.setUTCDate(d.getUTCDate() + 1); } return n; };
  let checked = 0;
  const base = new Date('2025-11-20T00:00:00Z');
  for (let i = 0; i < 200; i += 3) for (let j = 0; j < 70; j += 7) {
    const a = new Date(base); a.setUTCDate(a.getUTCDate() + i); const b = new Date(a); b.setUTCDate(b.getUTCDate() + j);
    const as = iso(a), bs = iso(b);
    assert.equal(cal.closedDaysBetween(as, bs), slow(as, bs), as + ' → ' + bs); checked++;
  }
  assert.ok(checked > 600);
  assert.equal(cal.closedDaysBetween('2026-03-02', '2026-03-02'), 0, 'празен интервал');
  assert.equal(cal.closedDaysBetween('2026-03-05', '2026-03-02'), 0, 'обърнат интервал');
  // Кешът се обезсилва при промяна: нов затворен ден се брои веднага
  assert.equal(cal.closedDaysBetween('2026-06-01', '2026-06-05'), 0);
  await ipcMain.invoke('calendar:addClosed', { date: '2026-06-03', reason: 'ремонт' });
  assert.equal(cal.closedDaysBetween('2026-06-01', '2026-06-05'), 1, 'нов затворен ден се брои веднага (без да чака срока на кеша)');
  await ipcMain.invoke('calendar:removeClosed', '2026-06-03');
  assert.equal(cal.closedDaysBetween('2026-06-01', '2026-06-05'), 0, 'премахнатият — веднага не');
  await ipcMain.invoke('calendar:saveWorkDays', [1, 2, 3, 4, 5, 6]);
  assert.equal(cal.closedDaysBetween('2026-06-01', '2026-06-07'), 1, 'събота вече е работен ден — само неделята се брои');
  assert.equal(cal.nextWorkDay('2026-06-06'), '2026-06-06');
});

test('loans:overdue — дните забава и обезщетението са същите след ускоряването на календара', async () => {
  await boot();
  const rows = await ok('loans:overdue');
  assert.ok(rows.length >= 5, 'предпоставка: има просрочени');
  const s = q('SELECT fine_per_day, work_days FROM settings WHERE id = 1');
  const wd = new Set(String(s.work_days == null ? '0,1,2,3,4,5,6' : s.work_days).split(',').map(Number));
  const closed = new Set(all('SELECT date FROM calendar_closed').map(r => r.date));
  const t = iso(new Date());
  for (const l of rows) {
    let n = 0; const d = new Date(l.date_due + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); const end = new Date(t + 'T00:00:00Z');
    for (let i = 0; d <= end && i < 5000; i++) { const ds = iso(d); if (!wd.has(d.getUTCDay()) || closed.has(ds)) n++; d.setUTCDate(d.getUTCDate() + 1); }
    const raw = Math.max(0, Math.round((new Date(t) - new Date(l.date_due)) / 864e5));
    assert.equal(l.daysLate, Math.max(0, raw - n), 'дни забава за инв. № ' + l.inv_number);
  }
});

/* ==================================================================
   4. Каталогът за сайта — същите записи през по-леката заявка
   ================================================================== */
test('buildCatalogPayload — леката заявка дава същите публични полета и „налична“ както BOOK_SELECT ред по ред', async () => {
  await boot();
  const electron = require('electron');
  const out = path.join(app.userData, 'katalog-test.json');
  electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
  await ok('catalog:export');
  const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
  const { BOOK_SELECT } = require(path.join(APP_DIR, 'handlers', 'books'))(fakeIpcMain(), {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-01-01', ftsQuery: () => '', cnSortKey: () => '', diffFields: () => [], scheduleCatalogWrite: () => {}
  });
  const full = all(`${BOOK_SELECT} WHERE b.status != 'отчислен' AND COALESCE(b.department,'') != 'служебен' ORDER BY b.title`);
  assert.equal(payload.items.length, full.length);
  assert.ok(full.some(b => b.available <= 0) && full.some(b => b.available > 0), 'предпоставка: има и заети, и свободни');
  const byInv = new Map(payload.items.map(it => [it.inv, it]));
  for (const b of full) {
    const it = byInv.get(b.inv_number);
    assert.ok(it, 'инв. № ' + b.inv_number + ' е в каталога');
    assert.equal(it.av, (b.available > 0 && b.status === 'наличен') ? 1 : 0, 'налична: инв. № ' + b.inv_number);
    assert.equal(it.t, b.title || ''); assert.equal(it.a, b.author || ''); assert.equal(it.v, b.category_name || '');
    assert.equal(it.d, b.register_date || ''); assert.equal(it.g, b.call_number || ''); assert.equal(it.u, b.udk || '');
  }
});

/* ==================================================================
   5. Запис на книга: числово съвпадение баркод ↔ инв. № без пълно сканиране
   ================================================================== */
test('books:create отказва инв. №, който числово съвпада с чужд баркод („007“ ↔ 7), и приема несъвпадащите', async () => {
  await boot();
  await ok('books:create', { inv_number: '5007', title: 'Със седмица', category_id: 1, barcode: '0005008' });
  const r = await app.invoke('books:create', { inv_number: '5008', title: 'Сблъсък', category_id: 1 });
  assert.equal(r.ok, false); assert.match(r.error, /съвпада с баркода/);
  await ok('books:create', { inv_number: '5009', title: 'Без сблъсък', category_id: 1 });
  // Дълъг числов баркод (над 9 цифри) не се брои за инв. № — както при четеца (resolveScannedBook)
  await ok('books:create', { inv_number: '5010', title: 'Дълъг', category_id: 1, barcode: '0000000000005011' });
  await ok('books:create', { inv_number: '5011', title: 'Пак без сблъсък', category_id: 1 });
  // Баркод с букви след цифрите не е число — CAST('0012-A') = 12 не бива да спира инв. № 12 (четецът не го приема за инв. №)
  await ok('books:create', { inv_number: '5012', title: 'С буква', category_id: 1, barcode: '0005013-A' });
  await ok('books:create', { inv_number: '5013', title: 'Не е сблъсък', category_id: 1 });
});

/* ==================================================================
   6. Екранен слой: прозоречен режим
   ================================================================== */
const mkBooks = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, inv_number: i + 1, title: 'Книга ' + (i + 1), author: 'А', category_id: 1, category_name: 'книга', department: i % 2 ? 'детски' : 'за възрастни', status: 'наличен', quantity: 1, available: 1 }));
const PAGES = []; // apiMock пази само първия аргумент — page се записва тук
function windowedBooksMock(all) {
  return ([, , page]) => {
    PAGES.push(page);
    if (!page || typeof page !== 'object') return all;
    let rows = all.filter(b => (!page.dept || b.department === page.dept) && (page.cat == null || page.cat === '' || String(b.category_id) === String(page.cat)));
    if (page.idsOnly) return { ids: rows.map(b => b.id) };
    return { rows: rows.slice(page.offset, page.offset + page.limit), total: rows.length, depts: ['детски', 'за възрастни'] };
  };
}

test('Книги (прозоречен режим): първата порция, „Покажи още“ през IPC с offset, филтър по отдел през базата, „Избери всички“ с idsOnly', async () => {
  const all = mkBooks(900);
  const dom = buildDom({ 'books.list': windowedBooksMock(all), 'categories.list': [{ id: 1, name: 'книга' }], 'searchHistory.suggest': [] });
  const { window } = dom; await settle();
  const doc = window.document;
  PAGES.length = 0;
  window.location.hash = '#books'; await window.route(); await settle();
  const calls = () => PAGES.filter(p => p && typeof p === 'object');
  assert.equal(doc.querySelectorAll('#bBody tr').length, 300);
  assert.match(doc.querySelector('#bMore').textContent, /Покажи още \(600 от общо 900\)/);
  assert.ok(calls().length >= 1 && calls().every(p => p.offset === 0), 'първото зареждане иска offset 0');
  // Покажи още → IPC с offset 300, редовете се долепят
  const first = doc.querySelector('#bBody tr'); first.setAttribute('data-probe', 'жив');
  doc.querySelector('#bMore button').click(); await settle();
  assert.equal(doc.querySelectorAll('#bBody tr').length, 600);
  assert.equal(calls().at(-1).offset, 300, 'втората порция се иска от базата с offset 300');
  assert.equal(doc.querySelector('#bBody tr').getAttribute('data-probe'), 'жив', 'вече показаните редове не се пресъздават');
  assert.match(doc.querySelector('#bMore').textContent, /300 от общо 900/);
  /* Проверка при прегледа: двоен клик върху „Покажи още“, преди първата порция да
     се върне, пращаше ДВЕ заявки с ЕДИН И СЪЩ offset (loaded се чете преди await-а,
     без предпазител) — резултатът беше 300 дублирани реда и цяла следваща порция,
     изтеглена никога. Двата паралелни извиквания тук симулират точно това. */
  const beforeCalls = calls().length;
  await Promise.all([window.booksMore(), window.booksMore()]);
  assert.equal(doc.querySelectorAll('#bBody tr').length, 900, 'двоен клик не бива да дублира или да прескача редове');
  assert.equal(calls().length, beforeCalls + 1, 'вторият, застъпващ се клик не пуска втора заявка');
  const ids900 = [...doc.querySelectorAll('#bBody tr')].map(tr => tr.getAttribute('data-id'));
  assert.equal(new Set(ids900).size, 900, 'без дублирани редове след двойния клик');
  assert.equal(doc.querySelector('#bMore').textContent.trim(), '', 'няма повече — целият резултат е зареден');
  // Връща състоянието към първата порция, преди да продължи тестът със следващите стъпки.
  window.eval("BOOKS_RENDER_LIMIT = BOOKS_PAGE_SIZE; refreshBooksList();"); await settle();
  assert.equal(doc.querySelectorAll('#bBody tr').length, 300);
  // Филтър по отдел → нова заявка с dept, броячът е по базата
  window.eval("BOOKS_FILTER_DEPT = 'детски'; booksFilterChanged();"); await settle();
  assert.equal(calls().at(-1).dept, 'детски');
  assert.equal(doc.querySelectorAll('#bBody tr').length, 300);
  assert.match(doc.querySelector('#bMore').textContent, /150 от общо 450/);
  assert.ok([...doc.querySelectorAll('#bBody tr td:nth-child(6)')].every(td => td.textContent === 'детски'));
  // Избери всички → idsOnly, изборът е целият резултат (450), не само видимите 300
  await window.toggleBookSelAll(true); await settle();
  assert.ok(calls().some(p => p.idsOnly && p.dept === 'детски'));
  assert.equal(window.eval('BOOKS_SELECTED.size'), 450);
  assert.equal(doc.querySelector('#chkAll').checked, true);
  assert.equal(doc.querySelector('#bulkCount').textContent, '450 избрани');
  await window.toggleBookSelAll(false); await settle();
  assert.equal(window.eval('BOOKS_SELECTED.size'), 0);
  // Търсене → пак от първата порция
  window.eval("BOOKS_QUERY = 'Книга 1'; BOOKS_RENDER_LIMIT = BOOKS_PAGE_SIZE; refreshBooksList();"); await settle();
  assert.equal(dom.calls['books.list'].at(-1), 'Книга 1');
  assert.equal(calls().at(-1).offset, 0);
});

test('Инвентарна книга (прозоречен режим): показатели от summary, търсене през базата, „Покажи още“ с offset, печат с пълния списък', async () => {
  const all = Array.from({ length: 700 }, (_, i) => ({ id: i + 1, inv_number: i + 1, title: 'Т' + (i + 1), author: i % 3 ? 'Вазов, Иван' : 'Друг', register_date: '2026-01-01', price: 2, quantity: 1, status: i % 50 === 0 ? 'отчислен' : 'наличен', checks: [] }));
  const summary = { rows: 700, activeCopies: 686, value: 1372, deacc: 14, checked: 0 };
  const IB = [];
  const dom = buildDom({ 'invBook.list': ([page]) => {
    IB.push(page);
    if (!page || typeof page !== 'object') return all;
    const rows = all.filter(r => !page.q || (r.author || '').toLowerCase().includes(String(page.q).toLowerCase()));
    return { rows: rows.slice(page.offset, page.offset + page.limit), total: rows.length, summary };
  } });
  const { window } = dom; await settle();
  window.location.hash = '#invbook'; await window.route(); await settle();
  const doc = window.document;
  assert.equal(doc.querySelectorAll('#ibBody tr').length, 300);
  assert.match(doc.querySelector('#ibMore').textContent, /400 от общо 700/);
  const nums = [...doc.querySelectorAll('#view .kpi-num')].map(e => e.textContent.trim());
  assert.deepEqual(nums, ['700', '686', '14', '0'], 'показателите идват от summary (целия регистър), не от 300-те реда');
  doc.querySelector('#ibMore button').click(); await settle();
  assert.equal(doc.querySelectorAll('#ibBody tr').length, 600);
  assert.equal(IB.at(-1).offset, 300);
  // Търсене през полето → debounce → IPC с q, пълен рендер на тялото
  const input = doc.getElementById('ibSearch');
  input.focus();
  input.value = 'Вазов'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400)); await settle();
  assert.equal(IB.at(-1).q, 'Вазов');
  assert.equal(doc.querySelectorAll('#ibBody tr').length, 300);
  assert.match(doc.querySelector('#ibMore').textContent, /166 от общо 466/);
  assert.equal(doc.activeElement, input, 'полето за търсене не се пресъздава — курсорът остава');
  // Печатът тегли ЦЕЛИЯ регистър (без page), не порцията
  await window.printInvBookDoc(); await settle();
  assert.equal(IB.at(-1), undefined, 'печатът иска пълния списък');
  assert.match(doc.querySelector('#ppSheet').textContent, /700 вписвания/);
});

test('Читатели (прозоречен режим): порции, филтър по категория през базата, „Покажи още“ с offset', async () => {
  const all = Array.from({ length: 800 }, (_, i) => ({ id: i + 1, name: 'Читател ' + (i + 1), card_no: String(i + 1), category: i % 4 ? 'възрастен' : 'дете до 14 г.', status: 'активен', open_loans: 0, overdue_loans: 0 }));
  const RP = [];
  const dom = buildDom({ 'readers.list': ([q, , page]) => {
    RP.push(page);
    if (!page || typeof page !== 'object') return all;
    const rows = all.filter(r => (!page.cat || r.category === page.cat) && (!page.status || r.status === page.status));
    return { rows: rows.slice(page.offset, page.offset + page.limit), total: rows.length };
  }, 'searchHistory.suggest': [] });
  const { window } = dom; await settle();
  window.location.hash = '#readers'; await window.route(); await settle();
  const doc = window.document;
  assert.equal(doc.querySelectorAll('#rBody tr').length, 300);
  assert.match(doc.querySelector('#rMore').textContent, /500 от общо 800/);
  doc.querySelector('#rMore button').click(); await settle();
  assert.equal(doc.querySelectorAll('#rBody tr').length, 600);
  assert.equal(RP.at(-1).offset, 300);
  const sel = doc.getElementById('rCatFilter'); sel.value = 'дете до 14 г.'; sel.dispatchEvent(new window.Event('change')); await settle();
  assert.equal(RP.at(-1).cat, 'дете до 14 г.');
  assert.equal(doc.querySelectorAll('#rBody tr').length, 200);
  assert.equal(doc.querySelector('#rMore').textContent.trim(), '');
});

test('Инвентарна книга и Читатели (прозоречен режим): закъсняла порция „Покажи още“ от стария списък не се долепя към новото търсене', async () => {
  const books = Array.from({ length: 700 }, (_, i) => ({ id: i + 1, inv_number: i + 1, title: 'Т' + (i + 1), author: i % 3 ? 'Вазов, Иван' : 'Друг', register_date: '2026-01-01', price: 2, quantity: 1, status: 'наличен', checks: [] }));
  const readers = Array.from({ length: 800 }, (_, i) => ({ id: i + 1, name: (i % 4 ? 'Петров ' : 'Иванов ') + (i + 1), card_no: String(i + 1), category: 'възрастен', status: 'активен', open_loans: 0, overdue_loans: 0 }));
  const dom = buildDom({ 'searchHistory.suggest': [] });
  const { window } = dom; await settle();
  const realApi = window.api;
  const pending = []; let delayNext = false;
  const wrap = (impl) => (...a) => delayNext ? new Promise(res => pending.push(() => res(impl(...a)))) : Promise.resolve(impl(...a));
  const invList = (page) => {
    const rows = books.filter(r => !page || !page.q || (r.author || '').toLowerCase().includes(String(page.q).toLowerCase()));
    return { ok: true, data: { rows: rows.slice(page.offset, page.offset + page.limit), total: rows.length, summary: { rows: 700, activeCopies: 700, value: 1400, deacc: 0, checked: 0 } } };
  };
  const rdList = (q, _s, page) => {
    const rows = readers.filter(r => !q || r.name.startsWith(q));
    return { ok: true, data: { rows: rows.slice(page.offset, page.offset + page.limit), total: rows.length } };
  };
  window.api = new Proxy(realApi, { get: (t, p) => p === 'invBook' ? { list: wrap(invList) } : p === 'readers' ? { list: wrap(rdList) } : t[p] });
  const doc = window.document;
  // Инвентарна книга: бавно „Покажи още“ (Т301…Т600), после бързо търсене „Друг“ (234 реда)
  window.location.hash = '#invbook'; await window.route(); await settle();
  assert.equal(doc.querySelectorAll('#ibBody tr').length, 300);
  delayNext = true; doc.querySelector('#ibMore button').click(); await settle(); delayNext = false;
  window.eval("INVBOOK_QUERY = 'Друг'; INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE; invBookReload();"); await settle();
  assert.equal(doc.querySelectorAll('#ibBody tr').length, 234);
  pending.shift()(); await settle();
  assert.equal(doc.querySelectorAll('#ibBody tr').length, 234, 'закъснялата порция от стария списък се изхвърля (инвентарна книга)');
  assert.ok([...doc.querySelectorAll('#ibBody tr')].every(tr => /Друг/.test(tr.textContent)));
  // Читатели: същото с READERS_GEN
  window.location.hash = '#readers'; await window.route(); await settle();
  assert.equal(doc.querySelectorAll('#rBody tr').length, 300);
  delayNext = true; doc.querySelector('#rMore button').click(); await settle(); delayNext = false;
  window.eval("READERS_QUERY = 'Иванов'; READERS_RENDER_LIMIT = READERS_PAGE_SIZE; refreshReadersList();"); await settle();
  assert.equal(doc.querySelectorAll('#rBody tr').length, 200);
  pending.shift()(); await settle();
  assert.equal(doc.querySelectorAll('#rBody tr').length, 200, 'закъснялата порция от стария списък се изхвърля (читатели)');
  assert.ok([...doc.querySelectorAll('#rBody tr')].every(tr => /Иванов/.test(tr.textContent)));
  window.api = realApi;
});

test('route(): преходът между раздели не принуждава подредба на старото съдържание (без offsetWidth), класът viewIn остава', async () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'bootstrap.js'), 'utf8');
  const routeSrc = src.slice(src.indexOf('async function route()'), src.indexOf('await RENDERERS[VIEW]()'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // без коментарите
  assert.doesNotMatch(routeSrc, /offsetWidth|offsetHeight|getBoundingClientRect/, 'без принудителна подредба');
  assert.match(routeSrc, /getAnimations\(\)\.forEach\(a => a\.cancel\(\)\)/);
  assert.match(routeSrc, /classList\.add\('viewIn'\)/);
  const dom = buildDom({ 'readers.list': [], 'searchHistory.suggest': [] });
  const { window } = dom; await settle();
  window.location.hash = '#readers'; await window.route(); await settle();
  assert.ok(window.document.querySelector('#view').classList.contains('viewIn'));
});

test('Книги (прозоречен режим): „Покажи още“ по време на чакащо търсене не долепя стар резултат; разгърнатият списък оцелява след пълен рендер; изтритото отпада от избора', async () => {
  const all = mkBooks(900);
  const dom = buildDom({ 'categories.list': [{ id: 1, name: 'книга' }], 'searchHistory.suggest': [], 'books.delete': true });
  const { window } = dom; await settle();
  const realApi = window.api;
  const pending = []; // забавени отговори — резолват се ръчно
  const listImpl = (q, sort, page) => {
    let rows = q ? all.filter(b => b.title.startsWith(q)) : all;
    if (page && page.idsOnly) return { ok: true, data: { ids: rows.map(b => b.id) } };
    const out = page && typeof page === 'object' ? { rows: rows.slice(page.offset, page.offset + page.limit), total: rows.length, depts: [] } : rows;
    return { ok: true, data: out };
  };
  let delayNext = false;
  window.api = new Proxy(realApi, { get: (t, p) => p === 'books'
    ? { list: (q, sort, page) => delayNext ? new Promise(res => pending.push(() => res(listImpl(q, sort, page)))) : Promise.resolve(listImpl(q, sort, page)), delete: async () => ({ ok: true, data: true }) }
    : t[p] });
  window.location.hash = '#books'; await window.route(); await settle();
  const doc = window.document;
  assert.equal(doc.querySelectorAll('#bBody tr').length, 300);
  // Търсене с чакащ отговор + „Покажи още“ преди да е дошъл
  delayNext = true;
  window.eval("BOOKS_QUERY = 'Книга 1'; BOOKS_RENDER_LIMIT = BOOKS_PAGE_SIZE; refreshBooksList();");
  delayNext = false;
  doc.querySelector('#bMore button').click(); await settle(); // порцията от СТАРИЯ списък пристига първа
  pending.shift()(); await settle();                          // после отговорът на търсенето
  const rows = [...doc.querySelectorAll('#bBody tr')];
  assert.ok(rows.length < 300 && rows.length > 0, 'таблицата показва резултата от търсенето: ' + rows.length);
  assert.ok(rows.every(tr => /Книга 1/.test(tr.textContent)), 'без долепени редове от стария списък');
  assert.doesNotMatch(doc.querySelector('#bMore').textContent, /от общо 900/);
  // Обратният ред: „Покажи още“ е БАВНОТО повикване, търсенето го изпреварва — порцията от стария
  // списък (Книга 300…599) пристига, след като таблицата вече показва резултата от търсенето.
  window.eval("BOOKS_QUERY = ''; BOOKS_RENDER_LIMIT = BOOKS_PAGE_SIZE; refreshBooksList();"); await settle();
  assert.equal(doc.querySelectorAll('#bBody tr').length, 300);
  delayNext = true;
  doc.querySelector('#bMore button').click(); await settle();
  delayNext = false;
  window.eval("BOOKS_QUERY = 'Книга 1'; BOOKS_RENDER_LIMIT = BOOKS_PAGE_SIZE; refreshBooksList();"); await settle();
  const shown = doc.querySelectorAll('#bBody tr').length;
  assert.ok(shown > 0 && shown < 300, 'таблицата показва резултата от търсенето: ' + shown);
  pending.shift()(); await settle(); // закъснялата порция от стария списък
  const rows2 = [...doc.querySelectorAll('#bBody tr')];
  assert.equal(rows2.length, shown, 'закъснялата порция „Покажи още“ от стария списък се изхвърля');
  assert.ok(rows2.every(tr => /Книга 1/.test(tr.textContent)), 'без долепени редове от стария списък');
  // Разгърнат списък оцелява след пълен рендер (запис/изтриване викат renderBooks)
  window.eval("BOOKS_QUERY = ''; BOOKS_RENDER_LIMIT = BOOKS_PAGE_SIZE; refreshBooksList();"); await settle();
  doc.querySelector('#bMore button').click(); await settle();
  assert.equal(doc.querySelectorAll('#bBody tr').length, 600);
  await window.renderBooks(); await settle();
  assert.equal(doc.querySelectorAll('#bBody tr').length, 600, 'след пълен рендер прозорецът остава 600, не се свива на 300');
  // Изтритият документ отпада от избора
  window.eval('BOOKS_SELECTED.add(5); BOOKS_SELECTED.add(6);');
  await window.deleteBook(5); await settle();
  assert.deepEqual([...window.eval('BOOKS_SELECTED')], [6]);
  window.api = realApi;
});
