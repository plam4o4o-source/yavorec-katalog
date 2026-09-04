'use strict';
/* Одит v2.4.25 — петнадесети кръг: екранният слой и поправките от v2.4.24 с нови
   очи.
   =====================================================================
   Трите тежки находки:
     • loans:reminders (имейл/SMS/екран „Напомняния“) не добавяше начисленото при
       продължение — пропуск в поправката от v2.4.24, която научи другите два пътя.
       Писмото искаше 2,05 лв., имейлът 0,25 лв., гишето 2,05 лв.
     • Актът за отчисляване се утвърждаваше без причина и печаташе „чл. 30, т. null“.
     • Дневникът изхвърляше вписана клетка без дума, след като „Подробно за днес…“
       беше презаписало общата снимка с друг месец.

   Всеки тест е проверен с мутация. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  APP_DIR, cleanupTmpDirs, fakeIpcMain, freshDb, runDep, buildDom, settle
} = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

const { BOOK_SELECT, LOAN_SELECT, normalizeScanCode } = require('./helpers/prod-values.js');

function book(db, inv, opts) {
  const o = opts || {};
  const id = db.prepare('INSERT INTO books (inv_number, title, barcode, status) VALUES (?, ?, ?, ?)')
    .run(inv, o.title || ('Книга ' + inv), o.barcode || null, o.status || 'наличен').lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, o.qty == null ? 1 : o.qty);
  return id;
}
const CIRC = () => ({ loan_days: 14, max_books: 5, extensions_count: 5, extension_days: 14, suspend_per_day: 1, suspend_max: 90 });
function loansSetup(prefix) {
  const { db } = freshDb(prefix);
  const ipcMain = fakeIpcMain();
  const ret = require(path.join(APP_DIR, 'handlers', 'loans'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-09-03', logEvent: () => {},
    BOOK_SELECT, scheduleCatalogWrite: () => {}, circRule: CIRC, readerCategory: () => 'възрастен',
    nextWorkDay: (d) => d, closedDaysBetween: () => 0, firstActiveHold: () => null,
    consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null, normalizeScanCode,
    freeCopies: () => 1, activeHolds: () => []
  });
  return { db, ipcMain, effectiveDaysLate: ret.effectiveDaysLate };
}

/* ==================================================================
   1. Напомнянията искат същото, което иска гишето
   ================================================================== */

test('имейлът/SMS-ът (loans:reminders) иска СЪЩАТА сума като писмото и гишето', async () => {
  const { db, ipcMain, effectiveDaysLate } = loansSetup('v2425-reminders-');
  require(path.join(APP_DIR, 'handlers', 'notices'))(ipcMain, {
    getDb: () => db, run: runDep, today: () => '2026-09-03', LOAN_SELECT, EUR_RATE: 1.95583,
    isValidEmail: () => true, shell: {}, effectiveDaysLate
  });
  db.prepare('UPDATE settings SET fine_per_day = 0.05 WHERE id = 1').run();
  const b = book(db, 1);
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Ана')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-07-01', '2026-07-29')").run(r, b);
  const id = db.prepare('SELECT id FROM loans').get().id;
  await ipcMain.invoke('loans:extend', { id });                            // начислява 1.80
  db.prepare("UPDATE loans SET date_due = '2026-08-29' WHERE id = ?").run(id); // и пак просрочва (5 дни)

  const letter = await ipcMain.invoke('loans:overdueByReader');
  const rem = await ipcMain.invoke('loans:reminders');
  assert.equal(rem.ok, true, rem.error);
  assert.equal(Number(rem.data[0].fine.toFixed(2)), 2.05, '1.80 начислени + 0.25 нови');
  assert.equal(Number(rem.data[0].fine.toFixed(2)), Number(letter.data[0].fine.toFixed(2)), 'имейлът и писмото са едно');
  assert.match(rem.data[0].body, /2\.05 лв\./, 'и текстът на писмото носи истинската сума');
});

/* ==================================================================
   2. Актът за отчисляване: причината е задължителна
   ================================================================== */

function actsSetup(prefix) {
  const { db } = freshDb(prefix);
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'deaccession-acts'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-09-03', BOOK_SELECT,
    scheduleCatalogWrite: () => {}, yearOf: (d) => String(d || '2026').slice(0, 4),
    normalizeScanCode, flushCatalogWrite: () => ({ written: true })
  });
  return { db, ipcMain };
}

test('акт без причина се отказва — вместо да се утвърди и да печата „чл. 30, т. null“', async () => {
  const { db, ipcMain } = actsSetup('v2425-act-reason-');
  const b = book(db, 5);
  for (const bad of [{ reason_code: '', reason_text: '' }, { reason_code: '9', reason_text: 'x' }, { reason_code: 'abc', reason_text: 'x' }]) {
    const res = await ipcMain.invoke('deaccessionActs:create',
      { act: Object.assign({ no: 1, date: '2026-09-03', committee1: 'А' }, bad), bookIds: [b] });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.match(res.error, /Причината за отчисляване/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_acts').get().n, 0);
  const ok = await ipcMain.invoke('deaccessionActs:create',
    { act: { no: 1, date: '2026-09-03', committee1: 'А', reason_code: '4', reason_text: 'Физически изхабени' }, bookIds: [b] });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(db.prepare('SELECT reason_code FROM deaccession_acts').get().reason_code, 4);
});

test('формата на акта отбелязва причината като задължителна', async () => {
  const dom = buildDom({ 'deaccessionActs.nextNo': 1, 'settings.get': {} });
  await settle();
  await dom.window.actForm();
  await settle();
  const sel = dom.window.document.querySelector('#actF [name=reason_code]');
  assert.ok(sel, 'полето съществува');
  assert.ok(sel.hasAttribute('required'));
  assert.equal(dom.window.firstMissingRequired('#actF'), 'Причина за отчисляване');
});

test('„отчислен“ БЕЗ акт (внесен стар ред) може да влезе в акт — съветът от „Проверка на данните“ работи', async () => {
  const { db, ipcMain } = actsSetup('v2425-act-orphan-');
  const orphan = book(db, 7, { barcode: 'BC7', status: 'отчислен' });
  const found = await ipcMain.invoke('deaccessionActs:findBook', 'BC7');
  assert.equal(found.ok, true);
  assert.ok(found.data && found.data.id === orphan, 'сканирането го намира');
  const res = await ipcMain.invoke('deaccessionActs:create',
    { act: { no: 1, date: '2026-09-03', committee1: 'А', reason_code: '6', reason_text: 'липсващи' }, bookIds: [orphan] });
  assert.equal(res.ok, true, res.error);
  const row = db.prepare('SELECT deaccession_act_id, deaccession_date FROM books WHERE id = ?').get(orphan);
  assert.ok(row.deaccession_act_id && row.deaccession_date, 'вече е отчислен С акт');
  // А вече отчисленият с акт — не влиза втори път.
  const again = await ipcMain.invoke('deaccessionActs:findBook', 'BC7');
  assert.equal(again.data, undefined);
});

/* ==================================================================
   3. Дневникът: клетката се записва независимо от снимката
   ================================================================== */

test('вписана клетка се записва и след „Подробно за днес…“ за друг месец', async () => {
  const saved = [];
  const dom = buildDom({
    'dnevnik.getMonth': ([a]) => ({
      year: a.year, month: a.month, daysInMonth: 31,
      days: Array.from({ length: 31 }, (_, i) => ({ day: i + 1, date: `${a.year}-${String(a.month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}` })),
      monthTotal: {}, ytdTotal: {}
    }),
    'dnevnik.saveDay': ([d]) => { saved.push(d); return true; },
    'settings.get': {}
  });
  const { window } = dom;
  await settle();
  // Екранът е на ДЕКЕМВРИ 2026; днес е януари 2027.
  window.eval('DNEVNIK_YEAR = 2026; DNEVNIK_MONTH = 12;'); // let-променливи в classic script
  window.location.hash = '#dnevnik';
  await window.route();
  await settle();
  await window.dnevnikDayForm('2027-01-05'); // „Подробно за днес…“ за друг месец
  await settle();
  window.closeModal();
  assert.equal(window._DNEVNIK.month, 12, 'общата снимка остава на месеца, който е на екрана');

  const cell = window.document.querySelector('[data-date="2026-12-07"][data-field="a_visit_reading"]');
  assert.ok(cell, 'клетката за 7 декември е на екрана');
  cell.value = '7';
  await window.dnevnikSaveCell(cell);
  await settle();
  assert.equal(saved.length, 1, 'клетката СЕ записва');
  assert.equal(JSON.stringify(saved[0]), JSON.stringify({ date: '2026-12-07', a_visit_reading: 7 }));

  // Втората половина на поправката: и при СГРЕШЕНА снимка (какъвто и да е
  // причината) записът на официален формуляр не зависи от кеша.
  window._DNEVNIK = { year: 2027, month: 1, days: [] };
  const cell2 = window.document.querySelector('[data-date="2026-12-08"][data-field="a_visit_reading"]');
  cell2.value = '3';
  await window.dnevnikSaveCell(cell2);
  await settle();
  assert.equal(saved.length, 2, 'записва се и без ред в снимката');
  assert.equal(JSON.stringify(saved[1]), JSON.stringify({ date: '2026-12-08', a_visit_reading: 3 }));
});

/* ==================================================================
   4–7. Празни полета, които влизаха в регистрите
   ================================================================== */

test('инвентаризация без дата се отказва', async () => {
  const { db } = freshDb('v2425-invent-date-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'inventory-sessions'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-09-03', normalizeScanCode,
    pctRequired: require('./helpers/prod-values.js').pctRequired,
    naturalLoss: require('./helpers/prod-values.js').naturalLoss
  });
  const res = await ipcMain.invoke('inventorySessions:start', { date: '', scope: 'целият фонд' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Датата на проверката/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_sessions').get().n, 0);
});

function readersSetup(prefix) {
  const { db } = freshDb(prefix);
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'readers'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-09-03', ftsQuery: () => '',
    maskReaderRow: (r) => r, maskReaderRows: (r) => r, preparePiiForWrite: (v) => v,
    diffFields: () => [], checkRecordLimit: () => {}, dialog: {}, getMainWindow: () => ({}),
    fs: require('fs'), csvCell: (v) => v, normalizeScanCode
  });
  return { db, ipcMain };
}

test('редакция на читател без дата на регистрация НЕ му слага днешната', async () => {
  const { db, ipcMain } = readersSetup('v2425-reg-date-');
  const id = db.prepare("INSERT INTO readers (name, category, status) VALUES ('Стар', 'възрастен', 'активен')").run().lastInsertRowid;
  const res = await ipcMain.invoke('readers:update', { id, name: 'Стар', phone: '0888', registered_at: '', category: '', status: '' });
  assert.equal(res.ok, true, res.error);
  const row = db.prepare('SELECT registered_at, category, status FROM readers WHERE id = ?').get(id);
  assert.equal(row.registered_at, null, 'иначе става „новорегистриран през 2026“ в отчета');
  assert.equal(row.category, 'възрастен');
  assert.equal(row.status, 'активен');
  // Контрол: новият читател получава днешната дата, както винаги.
  const c = await ipcMain.invoke('readers:create', { name: 'Нов' });
  assert.equal(db.prepare('SELECT registered_at FROM readers WHERE id = ?').get(c.data).registered_at, '2026-09-03');
});

test('календарът отказва „нито един работен ден“, вместо да направи всички дни работни', async () => {
  const { db } = freshDb('v2425-workdays-');
  const ipcMain = fakeIpcMain();
  const cal = require(path.join(APP_DIR, 'handlers', 'calendar'))(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  db.prepare("UPDATE settings SET work_days = '1,2,3,4,5' WHERE id = 1").run();
  const res = await ipcMain.invoke('calendar:saveWorkDays', []);
  assert.equal(res.ok, false);
  assert.match(res.error, /поне един работен ден/);
  assert.equal(db.prepare('SELECT work_days FROM settings WHERE id = 1').get().work_days, '1,2,3,4,5', 'старата настройка е недокосната');
  assert.equal(cal.isWorkDay('2026-09-06'), false, 'неделята си остава неработна');
});

test('посещения: празна дата се отказва, а отговорът носи общото за деня', async () => {
  const { db } = freshDb('v2425-visits-');
  const audit = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'visits'))(ipcMain, { getDb: () => db, run: runDep, logAudit: (a, d) => audit.push(d) });
  const bad = await ipcMain.invoke('visits:add', { date: '', count: '3' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Датата на посещенията/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 0, 'няма фантомен ред с date = \'\'');
  const neg = await ipcMain.invoke('visits:add', { date: '2026-09-03', count: '-5' });
  assert.equal(neg.ok, false);

  const a = await ipcMain.invoke('visits:add', { date: '2026-09-03', count: '5' });
  const b = await ipcMain.invoke('visits:add', { date: '2026-09-03', count: '50' });
  assert.equal(b.data.total, 55, 'натрупването се вижда');
  assert.equal(b.data.before, 5);
  const fix = await ipcMain.invoke('visits:add', { date: '2026-09-03', count: '5', replace: true });
  assert.equal(fix.data.total, 5, '„замени“ поправя сгрешеното число');
  assert.equal(a.data.total, 5);
  assert.ok(audit.some(d => /общо за деня 55/.test(d)));
});

/* ==================================================================
   8–12. Екран, износ, анонимизиране, правила
   ================================================================== */

test('инвентарната книга на екрана показва „липсващ“, а не „наличен“', async () => {
  const dom = buildDom({
    'invBook.list': [
      { id: 1, inv_number: 1, title: 'А', register_date: '2026-01-01', price: 10, quantity: 1, status: 'липсващ' },
      { id: 2, inv_number: 2, title: 'Б', register_date: '2026-01-02', price: 5, quantity: 1, status: 'наличен' }
    ], 'settings.get': {}
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#invbook';
  await window.route();
  await settle();
  const badges = [...window.document.querySelectorAll('#view .badge')].map(b => b.textContent.trim());
  assert.ok(badges.includes('липсващ'), 'липсващата книга се вижда като такава: ' + badges.join(','));
  assert.equal(badges.filter(b => b === 'наличен').length, 1);
});

test('CSV-то на одитната следа изнася всичко, не последните 500', async () => {
  const { db } = freshDb('v2425-audit-csv-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'audit'))(ipcMain, { getDb: () => db, run: runDep });
  const ins = db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('u', 'a', ?)");
  for (let i = 0; i < 620; i++) ins.run('ред ' + i);
  assert.equal((await ipcMain.invoke('audit:list', '')).data.length, 500, 'екранът остава ограничен и го казва');
  assert.equal((await ipcMain.invoke('audit:export', '')).data.length, 620, 'файлът за проверяващия е пълен');
  assert.equal((await ipcMain.invoke('audit:export', 'ред 61')).data.length, 11, 'търсенето важи и за износа (61, 610–619)');
});

test('„Изтрит ред от сметката“ се обезличава при анонимизиране', async () => {
  const { db } = freshDb('v2425-gdpr-account-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'gdpr'))(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  db.prepare('UPDATE settings SET anonymize_years = 1 WHERE id = 1').run();
  db.prepare("INSERT INTO audit_log (ts, user, action, detail) VALUES ('2020-03-01 10:00:00', 'u', 'Изтрит ред от сметката', 'Иван Петров — 2020-03-01, обезщетение 1.80 лв.')").run();
  const c = await ipcMain.invoke('gdpr:candidates');
  assert.equal(c.data.auditCount, 1, 'броячът го вижда');
  await ipcMain.invoke('gdpr:anonymize');
  const d = db.prepare('SELECT detail FROM audit_log WHERE action = ?').get('Изтрит ред от сметката').detail;
  assert.equal(d, '[анонимизиран читател] — 2020-03-01, обезщетение 1.80 лв.');
});

test('правилата по категория отказват отрицателни, дробни и нечислови стойности', async () => {
  const { db } = freshDb('v2425-circrules-');
  const ipcMain = fakeIpcMain();
  const cr = require(path.join(APP_DIR, 'handlers', 'circ-rules'))(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  for (const bad of [{ max_books: '-1' }, { loan_days: '1.5' }, { extension_days: 'abc' }, { suspend_max: '-3' }]) {
    const res = await ipcMain.invoke('circRules:save', Object.assign({ category: 'дете' }, bad));
    assert.equal(res.ok, false, JSON.stringify(bad));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM circulation_rules').get().n, 0);
  const ok = await ipcMain.invoke('circRules:save', { category: 'дете', loan_days: '0', max_books: '3', suspend_per_day: '0.5' });
  assert.equal(ok.ok, true, ok.error);
  const row = db.prepare('SELECT * FROM circulation_rules WHERE category = ?').get('дете');
  assert.equal(row.loan_days, null, '0 дни = общата стойност, не закован 30');
  assert.equal(row.max_books, 3);
  assert.equal(row.suspend_per_day, 0.5);
  // Срокът винаги е число — и при изчистена обща настройка (v2.4.24 я пази като NULL).
  db.prepare('UPDATE settings SET loan_days = NULL WHERE id = 1').run();
  assert.equal(cr.circRule('дете').loan_days, 30, 'екранът вече не печата „null дни“');
  assert.equal(cr.circRule(null).loan_days, 30);
  // Най-честият път — категория БЕЗ отделно правило (преглед на кръга: тук
  // подразбиращото се липсваше и екранът пак печаташе „null дни“).
  assert.equal(cr.circRule('възрастен').loan_days, 30);
  assert.equal(cr.circRule('възрастен').extension_days, 30);
});

/* ==================================================================
   13–14. Обслужване — дребните
   ================================================================== */

test('отказ на несъществуваща/вече неактивна резервация се отказва, не се „потвърждава“', async () => {
  const { db } = freshDb('v2425-holds-cancel-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'holds'))(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-09-03', normalizeScanCode });
  const none = await ipcMain.invoke('holds:cancel', 999);
  assert.equal(none.ok, false);
  assert.match(none.error, /не е намерена/);
  const b = book(db, 1);
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Ч')").run().lastInsertRowid;
  const h = db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'отказана', '2026-09-01')").run(b, r).lastInsertRowid;
  const stale = await ipcMain.invoke('holds:cancel', h);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /вече не е активна/);
});

test('връщане по баркод на стар ред с бройка 0 и ЕДНО заемане минава', async () => {
  const { db, ipcMain } = loansSetup('v2425-return-qty0-');
  const b = book(db, 3, { barcode: 'BC3' });
  const r = db.prepare("INSERT INTO readers (name) VALUES ('Иван')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-08-01', '2026-08-20')").run(r, b);
  db.prepare('UPDATE inventory SET quantity = 0 WHERE book_id = ?').run(b); // стар ред, нулиран след заемането
  const res = await ipcMain.invoke('loans:returnByCode', { code: 'BC3' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.reader_name, 'Иван');
});

/* ==================================================================
   15–19. Екран: часове, следи, навигация
   ================================================================== */

test('списъкът с резервни копия показва дата и час от една и съща зона', async () => {
  const dom = buildDom({ 'settings.get': {} });
  const { window } = dom;
  await settle();
  // 03.09.2026 01:15 местно (Europe/Sofia, UTC+3) — по UTC е още 02.09.
  const ms = new Date('2026-09-03T01:15:00+03:00').getTime();
  const shown = window.fmtDateTime(ms);
  assert.match(shown, /^03\.09\.2026 01:15$/);
});

test('преименуването на вид документ и изтриването на служител оставят следа', async () => {
  const { db } = freshDb('v2425-audit-trail-');
  const audit = [];
  const ipcMain = fakeIpcMain();
  const deps = { getDb: () => db, run: runDep, logAudit: (a, d) => audit.push(a + ': ' + d) };
  require(path.join(APP_DIR, 'handlers', 'categories'))(ipcMain, deps);
  require(path.join(APP_DIR, 'handlers', 'employees'))(ipcMain, deps);
  const cid = db.prepare("INSERT INTO categories (name) VALUES ('ноти')").run().lastInsertRowid;
  book(db, 1); db.prepare('UPDATE books SET category_id = ?').run(cid);
  await ipcMain.invoke('categories:update', { id: cid, name: 'нотни издания' });
  assert.ok(audit.some(x => /„ноти“ → „нотни издания“ \(1 документ\)/.test(x)), audit.join(' | '));
  const eid = db.prepare("INSERT INTO employees (name) VALUES ('Иван')").run().lastInsertRowid;
  await ipcMain.invoke('employees:update', { id: eid, name: 'Иван Петров' });
  await ipcMain.invoke('employees:delete', eid);
  assert.ok(audit.some(x => /Преименуван служител: „Иван“ → „Иван Петров“/.test(x)));
  assert.ok(audit.some(x => /Изтрит служител: „Иван Петров“/.test(x)));
});

test('„+ Нов читател“ от гишето избира новия читател за заемане', async () => {
  const dom = buildDom({
    'readers.create': 42, 'readers.list': [],
    'readers.get': ([id]) => (id === 42 ? { id: 42, name: 'Нов Читател', card_no: 'K42', category: 'възрастен', status: 'активен' } : null),
    'settings.get': {},
    'loans.byReader': [], 'holds.byReader': [], 'circRules.effective': { loan_days: 14 }, 'readers.byCard': null,
    'pdp.status': {}, 'account.get': { lines: [], balance: 0 }
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#circ';
  await window.route();
  await settle();
  window.readerForm();
  await settle();
  const f = window.document.querySelector('#readerF');
  assert.ok(f, 'формата за читател е отворена от гишето');
  f.querySelector('[name=name]').value = 'Нов Читател';
  f.querySelector('[name=card_no]').value = 'K42';
  const consent = f.querySelector('[name=gdpr_consent]'); if (consent) consent.checked = true;
  await window.saveReader(null);
  await settle();
  assert.equal(window.eval('VIEW'), 'circ', 'библиотекарят остава на гишето');
  assert.equal(window.eval('CIRC.readerId'), 42, 'новият читател е избран за заемане');
});
