'use strict';
/* Одитен кръг v2.4.56 — АКТЪТ ЗА ОТЧИСЛЯВАНЕ Е ДОКУМЕНТ, НЕ ЗАПИС.
 * =====================================================================
 * Кръгът тръгна от едно действие, което изглеждаше безобидно: бутонът „Анулирай
 * акта“. Зад него стоеше `DELETE FROM deaccession_acts`, а редовете на акта
 * падаха след него по ON DELETE CASCADE. Три отделни неща в Наредба № 3 казват,
 * че точно това не бива да се случва:
 *
 *   чл. 35 — актът се съставя от комисия (библиотекар и счетоводител), в ДВА
 *     екземпляра, и се утвърждава от ръководителя. Подписаният екземпляр е в
 *     счетоводството; никое действие в програмата не може да го отмени;
 *   чл. 35 — „актовете се номерират, като започват всяка календарна година от
 *     номер едно“. След триене nextNo (MAX(no)+1) връщаше освободения номер на
 *     СЪВСЕМ ДРУГ акт — два различни подписани акта № 1/2026 в едно и също
 *     счетоводство;
 *   чл. 39 — документацията по отчисляването се съхранява; а тук тя се
 *     изтриваше, заедно със снимката по чл. 35, ал. 2.
 *
 * Практическата последица: КДБФ Приложение № 3 за минала година, вече
 * отпечатано и подписано, при следващ печат излизаше различно.
 *
 * Затова оттук нататък актът НЕ се трие никога. Анулирането само го отбелязва
 * (revoked_at/revoke_reason/revoked_by), номерът остава зает завинаги, а
 * сборовете навсякъде минават през `revoked_at IS NULL`. Другата половина на
 * поправката е ПРОЕКТЪТ: щом утвърденият акт е вечен, грешките трябва да имат
 * къде да се случат преди него — проектът се поправя и трие свободно и нищо по
 * него не е излязло от фонда.
 *
 * Файлът заковава и трите нови неща около акта: анулирането, проекта и
 * поправката на вписана партида (acquisitions:update), плюс двете допълнения в
 * КДБФ — разбивката по видове в Част № 2 и колоната за разпореждане в Част № 3.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  APP_DIR, freshDb, fakeIpcMain, runDep, cleanupTmpDirs, buildDom, settle, printed
} = require('./helpers/audit-fixtures');
const { BOOK_SELECT, normalizeScanCode, yearOf } = require('./helpers/prod-values');

const KDBF_VIEW = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'kdbf.js'), 'utf8');
const ACTS_VIEW = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'deaccession-acts.js'), 'utf8');

test.after(cleanupTmpDirs);

/* Истинските handlers/deaccession-acts + kdbf + stats + dashboard + acquisitions
   върху ЕДНА и съща база. Нарочно заедно: цялата точка на анулирането е, че
   ЕДНА промяна в един модул трябва да се види в другите четири — проверка само
   върху deaccession-acts би минала и ако филтърът в КДБФ липсва. */
function setup() {
  const { db } = freshDb('inv-akt-v2456-');
  const audit = [];
  const catalogWrites = [];
  const deps = {
    getDb: () => db, run: runDep,
    logAudit: (action, detail, diff) => audit.push({ action, detail, diff }),
    BOOK_SELECT, yearOf,
    today: () => '2026-08-04',
    scheduleCatalogWrite: () => catalogWrites.push('debounced'),
    flushCatalogWrite: () => { catalogWrites.push('flush'); return { written: true }; },
    normalizeScanCode,
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: (rows) => ({ hours: rows.length }),
    pctRequired: () => 1, isWorkDay: () => true, LOAN_SELECT: 'SELECT * FROM loans l'
  };
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'deaccession-acts'))(ipcMain, deps);
  require(path.join(APP_DIR, 'handlers', 'kdbf'))(ipcMain, deps);
  require(path.join(APP_DIR, 'handlers', 'stats'))(ipcMain, deps);
  require(path.join(APP_DIR, 'handlers', 'dashboard'))(ipcMain, deps);
  require(path.join(APP_DIR, 'handlers', 'acquisitions'))(ipcMain, deps);
  return { db, ipcMain, audit, catalogWrites };
}

/* Документ във фонда, така както го виждат КДБФ и статистиката: с дата на
   вписване (иначе изпада от наличността) и с ред в inventory (иначе бройката
   се чете като „стара база“). */
function addBook(db, o) {
  const b = Object.assign({ inv_number: 1, title: 'Книга', price: 10, register_date: '2026-02-01', qty: 1 }, o);
  const id = db.prepare(`INSERT INTO books (inv_number, title, price, register_date, status, status_date, category_id)
    VALUES (?, ?, ?, ?, 'наличен', ?, ?)`)
    .run(b.inv_number, b.title, b.price, b.register_date, b.register_date, b.category_id || null).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, b.qty);
  return id;
}
const ACT = (o) => Object.assign({
  no: 1, date: '2026-06-10', reason_code: 3, reason_text: 'физически изхабени',
  disposal: 'предадени за вторични суровини', committee1: 'А', committee2: 'Б', committee3: 'В'
}, o);
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };

/* ==================================================================
   1. АНУЛИРАНЕТО НЕ Е ТРИЕНЕ
   ================================================================== */

test('анулираният акт ОСТАВА в регистъра и носи кога, защо и от кого е анулиран', () => {
  /* Актът е документ по чл. 35 и чл. 39: съставен от комисия, утвърден от
     ръководителя, подписан в два екземпляра, единият от които е в
     счетоводството. Триенето на реда му означаваше, че вътрешният регистър
     твърди, че акт № 1/2026 никога не е съществувал, докато счетоводството
     държи подписания му екземпляр. */
  const { db, ipcMain } = setup();
  const bookId = addBook(db, { inv_number: 101 });
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'създаване');
  ok(ipcMain.invoke('deaccessionActs:revoke', actId,
    { reason: 'сгрешен инвентарен номер', by: 'Иванова, библиотекар' }), 'анулиране');

  const act = db.prepare('SELECT * FROM deaccession_acts WHERE id = ?').get(actId);
  assert.ok(act, 'редът на акта НЕ се трие');
  assert.ok(act.revoked_at, 'носи дата на анулиране');
  assert.equal(act.revoke_reason, 'сгрешен инвентарен номер');
  assert.equal(act.revoked_by, 'Иванова, библиотекар');
  // Снимката по чл. 35, ал. 2 също остава — тя е самото съдържание на документа.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_items WHERE act_id = ?').get(actId).n, 1,
    'редовете на акта остават като снимка по чл. 35, ал. 2');
  // А документът се връща във фонда — това е смисълът на анулирането.
  const b = db.prepare('SELECT status, deaccession_act_id, deaccession_date FROM books WHERE id = ?').get(bookId);
  assert.equal(b.status, 'наличен');
  assert.equal(b.deaccession_act_id, null);
  assert.equal(b.deaccession_date, null);
});

test('номерът на анулиран акт остава зает — следващият получава 2, не 1', () => {
  /* чл. 35: актовете се номерират от 1 всяка календарна година. Дотук
     nextNo = MAX(no)+1 върху таблица, от която редът е изтрит, връщаше
     освободената единица — и библиотеката съставяше ВТОРИ акт № 1/2026, който
     не е същият като подписания № 1/2026 в счетоводството. */
  const { db, ipcMain } = setup();
  const bookId = addBook(db, { inv_number: 102 });
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'създаване');
  ok(ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'комисията не го утвърди' }), 'анулиране');
  assert.equal(ok(ipcMain.invoke('deaccessionActs:nextNo', '2026'), 'nextNo'), 2,
    'номер 1 остава зает от анулирания акт');
  // И на практика: съставянето на нов акт с номер 1 се отказва.
  const again = ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 1 }), bookIds: [bookId] });
  assert.equal(again.ok, false, 'номер 1 не може да се преизползва');
  assert.match(again.error, /вече съществува/);
});

test('анулиране без основание се отказва — иначе до вечния ред не пише защо е отпаднал', () => {
  /* Актът остава в документацията завинаги. Щом остава, до него трябва да стои
     ЗАЩО е отпаднал: след година нито библиотекарят, нито проверяващият може да
     различи „сгрешен инвентарен номер“ от „комисията размисли“. */
  const { db, ipcMain } = setup();
  const bookId = addBook(db, { inv_number: 103 });
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'създаване');
  for (const opts of [undefined, {}, { reason: '' }, { reason: '   ' }]) {
    const res = ipcMain.invoke('deaccessionActs:revoke', actId, opts);
    assert.equal(res.ok, false, 'анулиране без основание трябва да се откаже');
    assert.match(res.error, /основание/);
  }
  // И нищо не е пипнато: документът си стои отчислен.
  assert.equal(db.prepare('SELECT status FROM books WHERE id = ?').get(bookId).status, 'отчислен');
  assert.equal(db.prepare('SELECT revoked_at FROM deaccession_acts WHERE id = ?').get(actId).revoked_at, null);
});

test('повторно анулиране на вече анулиран акт се отказва, вместо да върне „готово“', () => {
  /* Второто натискане не бива да изглежда успешно: то би презаписало датата и
     основанието на първото анулиране и би върнало в дневника събитие за нещо,
     което не се е случило. */
  const { db, ipcMain } = setup();
  const bookId = addBook(db, { inv_number: 104 });
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [bookId] }), 'създаване');
  ok(ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'първо анулиране' }), 'първо анулиране');
  const second = ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'второ анулиране' });
  assert.equal(second.ok, false);
  assert.match(second.error, /вече е анулиран/);
  assert.equal(db.prepare('SELECT revoke_reason FROM deaccession_acts WHERE id = ?').get(actId).revoke_reason,
    'първо анулиране', 'основанието на първото анулиране не се подменя');
});

/* ==================================================================
   2. АНУЛИРАНИЯТ АКТ НЕ СЕ БРОИ НИКЪДЕ
   ================================================================== */

test('анулираният акт не отнема нищо от фонда: КДБФ, статистиката и таблото показват нула отчислени', () => {
  /* Това е половината от поправката, която може да се сбърка най-лесно: щом
     редът вече НЕ се трие, всяко място, което брои отчислени, трябва да го
     изключи изрично. Иначе анулирането започва да краде от фонда на хартия —
     фондът се връща в наличността (документите са налични), но в графата
     „отчислени през годината“ си стоят, тоест КДБФ спира да се връзва:
     наличност 01.01 + постъпили − отчислени вече не дава наличността 31.12. */
  const { db, ipcMain } = setup();
  const keep = addBook(db, { inv_number: 201, price: 10 });
  const drop = addBook(db, { inv_number: 202, price: 25 });
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [drop] }), 'създаване');

  // Преди анулирането числата са ненулеви — иначе тестът би минавал и на празна база.
  const before = ok(ipcMain.invoke('kdbf:report', '2026'), 'КДБФ преди');
  assert.equal(before.deaccYear.n, 1);
  assert.equal(before.deaccYear.v, 25);

  ok(ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'сгрешен акт' }), 'анулиране');

  const kdbf = ok(ipcMain.invoke('kdbf:report', '2026'), 'КДБФ след');
  assert.equal(kdbf.deaccYear.n, 0, 'КДБФ Част № 2: отчисляване по анулиран акт не е имало');
  assert.equal(kdbf.deaccYear.v, 0);
  assert.equal(kdbf.stockEnd.n, 2, 'и двата документа са в наличността към 31.12');
  assert.equal(kdbf.stockEnd.v, 35);

  const stats = ok(ipcMain.invoke('stats:report', '2026'), 'годишен отчет');
  assert.equal(stats.deaccessionedCount, 0, 'годишният отчет също не брои анулирания акт');
  assert.equal(stats.deaccessionedValue, 0);

  const dash = ok(ipcMain.invoke('dashboard:full'), 'табло');
  assert.equal(dash.deaccessionedYear, 0, 'таблото показва същото число като регистъра');

  // И справката „Движение на фонда“ — четвъртото място, което брои същото.
  const rep = ok(ipcMain.invoke('reports:run', { id: 'fund_movement', year: '2026' }), 'справка');
  assert.equal(rep.deaccessionedTotal, 0, 'справката за движението не брои анулирания акт');
  assert.equal(rep.deaccessionedValue, 0);
  assert.deepEqual(rep.deaccessioned, [], 'и не изрежда причината му');
  assert.equal(keep > 0, true);
});

test('КДБФ Част № 3 ПОКАЗВА анулирания акт — редът не изчезва от регистъра', () => {
  /* Обратната грешка на горната: ако филтърът се сложи и в Част № 3, актът
     изчезва от Приложение № 3 и регистърът пак твърди, че никога не е бил
     съставен. Част № 3 е СПИСЪКЪТ на актовете — там анулираният стои, само че
     зачертан и с нула; сборовете (Част № 2) са другото място. */
  const { db, ipcMain } = setup();
  const drop = addBook(db, { inv_number: 203, price: 25 });
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 7 }), bookIds: [drop] }), 'създаване');
  ok(ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'сгрешен инвентарен номер' }), 'анулиране');

  const r = ok(ipcMain.invoke('kdbf:report', '2026'), 'КДБФ');
  assert.equal(r.part3.length, 1, 'редът на акта остава в Част № 3');
  const row = r.part3[0];
  assert.equal(row.no, 7);
  assert.ok(row.revoked_at, 'и носи белега за анулиране, за да може печатът да го зачертае');
  assert.equal(row.revoke_reason, 'сгрешен инвентарен номер');
  // Собствените му числа остават каквито са били — зануляването е решение на
  // документа (печата), не на данните: снимката по чл. 35, ал. 2 не се пипа.
  assert.equal(row.item_count, 1);
  assert.equal(row.item_value, 25);
});

test('разпечатката на Приложение № 3 зачертава анулирания акт, изважда го от сбора и казва защо', async () => {
  /* Разпечатката Е документът, който се подписва и подава при проверка. Ако
     анулираният акт се печата като действащ, от принтера излиза лист,
     неразличим от редовен — при това с число, което не отговаря на фонда. */
  const report = {
    year: '2026', part1: [], part1Sum: { n: 0, v: 0 },
    stockEnd: { n: 5, v: 50 }, acquiredYear: { n: 0, v: 0 }, deaccYear: { n: 2, v: 20 },
    crossIn: { n: 0, v: 0 }, crossOut: { n: 0, v: 0 }, undated: { n: 0, v: 0, rows: 0 },
    byKind: [],
    part3: [
      { id: 1, no: 1, year: '2026', date: '2026-03-01', reason_code: 3, reason_text: 'физически изхабени',
        disposal: 'предадени за вторични суровини', item_count: 2, item_value: 20, revoked_at: null },
      { id: 2, no: 2, year: '2026', date: '2026-04-02', reason_code: 5, reason_text: 'липсващи',
        disposal: 'унищожени', item_count: 40, item_value: 400,
        revoked_at: '2026-05-06 10:00:00', revoke_reason: 'сгрешен инвентарен номер' }
    ]
  };
  const dom = buildDom({ 'kdbf.report': report, 'acquisitions.get': { items: [] } });
  const { window } = dom;
  await settle();
  window.location.hash = '#kdbf';
  await window.route();
  await settle();
  window.printKdbfDoc();
  await settle();
  const sheet = window.document.querySelector('#ppSheet');
  const t = printed(window);

  // 1) Анулираният ред е ОТБЕЛЯЗАН като такъв — по клас, не по случайна дума.
  assert.equal(sheet.querySelectorAll('tr.revokedRow').length, 1,
    'точно един ред е зачертан — анулираният');
  assert.match(t, /АНУЛИРАН/, 'на листа пише, че актът е анулиран');
  assert.match(t, /сгрешен инвентарен номер/, 'и основанието, което проверяващият чете');

  // 2) Сборът НЕ включва анулирания акт: 2 документа и 20 €, не 42 и 420 €.
  const rows = [...sheet.querySelectorAll('table')].flatMap(tb => [...tb.querySelectorAll('tr')]);
  const total = rows.find(tr => /ОБЩО за 2026/.test(tr.textContent));
  assert.ok(total, 'разпечатката носи ред ОБЩО — Приложение № 3 се подава със сбор');
  const cells = [...total.querySelectorAll('td')].map(td => td.textContent.trim());
  assert.equal(cells[cells.length - 2], '2', 'в сбора влизат само документите по действащите актове');
  assert.match(cells[cells.length - 1], /^20[,.]00/, 'същото и за стойността');

  // 3) Колоната „Начин на разпореждане“ (чл. 36) слиза от акта в регистъра.
  assert.match(t, /Начин на разпореждане/, 'Част № 3 носи колоната по чл. 36');
  assert.match(t, /предадени за вторични суровини/, 'и стойността ѝ от самия акт');
  // 4) Обяснение какво значи зачертаният ред — иначе изглежда като дефект на печата.
  assert.match(t, /Зачертаните редове са АНУЛИРАНИ актове/);
});

test('анулираният ред в Приложение № 3 излиза с НУЛА в собствените си клетки, не със своите числа', async () => {
  /* Сборът отдолу и зачертаването на реда са двете половини на едно и също нещо,
     но всяка от тях може да отпадне поотделно. Ако сборът е верен, а самият ред
     продължава да показва „40 документа, 400 €“, листът противоречи сам на себе
     си: проверяващият събира колоната наум и получава друго число от отпечатаното
     ОБЩО. Зануляването е решение на ДОКУМЕНТА, не на данните — снимката по
     чл. 35, ал. 2 в базата не се пипа (виж теста за kdbf:report по-горе, където
     item_count на анулирания акт си остава 1). */
  const report = {
    year: '2026', part1: [], part1Sum: { n: 0, v: 0 },
    stockEnd: { n: 5, v: 50 }, acquiredYear: { n: 0, v: 0 }, deaccYear: { n: 2, v: 20 },
    crossIn: { n: 0, v: 0 }, crossOut: { n: 0, v: 0 }, undated: { n: 0, v: 0, rows: 0 },
    byKind: [],
    part3: [
      { id: 1, no: 1, year: '2026', date: '2026-03-01', reason_code: 3, reason_text: 'физически изхабени',
        disposal: 'предадени за вторични суровини', item_count: 2, item_value: 20, revoked_at: null },
      { id: 2, no: 2, year: '2026', date: '2026-04-02', reason_code: 5, reason_text: 'липсващи',
        disposal: 'унищожени', item_count: 40, item_value: 400,
        revoked_at: '2026-05-06 10:00:00', revoke_reason: 'сгрешен инвентарен номер' }
    ]
  };
  const dom = buildDom({ 'kdbf.report': report, 'acquisitions.get': { items: [] } });
  const { window } = dom;
  await settle();
  window.location.hash = '#kdbf';
  await window.route();
  await settle();
  window.printKdbfDoc();
  await settle();
  const sheet = window.document.querySelector('#ppSheet');

  const revoked = sheet.querySelector('tr.revokedRow');
  assert.ok(revoked, 'анулираният ред е на листа и е отбелязан');
  const cells = [...revoked.querySelectorAll('td')].map(td => td.textContent.trim());
  assert.equal(cells[cells.length - 2], '0',
    'броят документи по анулирания акт се печата като НУЛА — отчисляване по него не е имало');
  assert.match(cells[cells.length - 1], /^0[,.]00/, 'същото и за стойността');
  // А действащият акт до него запазва своите числа — зануляването е само за анулирания.
  const liveRow = [...sheet.querySelectorAll('tbody tr')].find(tr => !tr.classList.contains('revokedRow')
    && /№ 1 \//.test(tr.textContent));
  assert.ok(liveRow, 'действащият акт също е на листа');
  const liveCells = [...liveRow.querySelectorAll('td')].map(td => td.textContent.trim());
  assert.equal(liveCells[liveCells.length - 2], '2', 'неанулираният акт си носи своите числа');
});

test('КДБФ Част № 2 носи разбивката по видове документи, която образецът изисква', () => {
  /* Приложение № 2 съдържа разпределение по видове документи; Част № 1 вече го
     дава („По вид документи“), а Част № 2 излизаше само с трите общи реда —
     данните ги имаше, но не стигаха до документа. */
  const { db, ipcMain } = setup();
  const kniga = db.prepare("SELECT id FROM categories WHERE name = 'книга'").get()
    || { id: db.prepare("INSERT INTO categories (name) VALUES ('книга')").run().lastInsertRowid };
  const per = db.prepare("SELECT id FROM categories WHERE name = 'продължаващо издание'").get()
    || { id: db.prepare("INSERT INTO categories (name) VALUES ('продължаващо издание')").run().lastInsertRowid };
  addBook(db, { inv_number: 301, price: 10, category_id: kniga.id });
  addBook(db, { inv_number: 302, price: 10, category_id: kniga.id, qty: 2 });
  addBook(db, { inv_number: 303, price: 40, category_id: per.id });

  const r = ok(ipcMain.invoke('kdbf:report', '2026'), 'КДБФ');
  assert.ok(Array.isArray(r.byKind) && r.byKind.length >= 2, 'разбивката по видове съществува');
  const byKind = Object.fromEntries(r.byKind.map(k => [k.kind, k]));
  assert.equal(byKind['книга'].n, 3, 'броят е по ДОКУМЕНТИ (екземпляри), както навсякъде в КДБФ');
  assert.equal(byKind['книга'].v, 30);
  assert.equal(byKind['продължаващо издание'].n, 1);
  assert.equal(byKind['продължаващо издание'].v, 40);
  // Разбивката се връзва с общото число за фонда — иначе документът противоречи сам на себе си.
  assert.equal(r.byKind.reduce((s, k) => s + k.n, 0), r.stockEnd.n);
  assert.equal(r.byKind.reduce((s, k) => s + k.v, 0), r.stockEnd.v);
  // И изгледът наистина я печата (не само я получава).
  assert.match(KDBF_VIEW, /Разпределение по видове документи/,
    'разпечатката на Част № 2 показва разбивката');
});

/* ==================================================================
   3. ПРОЕКТЪТ — МЯСТОТО, КЪДЕТО ГРЕШКАТА Е ПОЗВОЛЕНА
   ================================================================== */

test('проектът не отчислява нищо: документите остават „наличен“ и се заемат както преди', () => {
  /* Щом утвърденият акт е вечен, подготовката му трябва да има свое място.
     Дотук нямаше: един клик върху „Утвърди акта и отчисли“ и сгрешеният акт
     вече беше съставен, тоест ТРИЕНЕТО беше единствената поправка — оттам и
     навикът да се трие. */
  const { db, ipcMain } = setup();
  const b1 = addBook(db, { inv_number: 401 });
  const b2 = addBook(db, { inv_number: 402 });
  const draftId = ok(ipcMain.invoke('deaccessionActs:saveDraft', {
    id: null, draft: { date: '2026-06-10', reason_code: 3, reason_text: 'физически изхабени' },
    bookIds: [b1, b2]
  }), 'запис на проект');
  assert.ok(draftId > 0);

  for (const id of [b1, b2]) {
    const b = db.prepare('SELECT status, deaccession_act_id, deaccession_date FROM books WHERE id = ?').get(id);
    assert.equal(b.status, 'наличен', 'проектът НЕ отчислява');
    assert.equal(b.deaccession_act_id, null);
    assert.equal(b.deaccession_date, null);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_acts').get().n, 0,
    'проектът не е акт и не заема номер');
  assert.equal(ok(ipcMain.invoke('deaccessionActs:nextNo', '2026'), 'nextNo'), 1,
    'номер 1 още е свободен — проектът не го е взел');

  const list = ok(ipcMain.invoke('deaccessionActs:drafts'), 'списък с проекти');
  assert.equal(list.length, 1);
  assert.equal(list[0].title_count, 2);
});

test('проектът се поправя — новият списък документи заменя стария, без да се трупа', () => {
  const { db, ipcMain } = setup();
  const b1 = addBook(db, { inv_number: 411 });
  const b2 = addBook(db, { inv_number: 412 });
  const b3 = addBook(db, { inv_number: 413 });
  const draftId = ok(ipcMain.invoke('deaccessionActs:saveDraft', {
    id: null, draft: { date: '2026-06-10', reason_code: 1, reason_text: 'морално остарели' }, bookIds: [b1, b2]
  }), 'запис');
  ok(ipcMain.invoke('deaccessionActs:saveDraft', {
    id: draftId, draft: { date: '2026-07-01', reason_code: 3, reason_text: 'физически изхабени' }, bookIds: [b3]
  }), 'поправка');

  const d = ok(ipcMain.invoke('deaccessionActs:getDraft', draftId), 'четене');
  assert.equal(d.date, '2026-07-01');
  assert.equal(d.reason_code, 3);
  assert.equal(d.items.length, 1, 'списъкът се ЗАМЕНЯ, а не се допълва');
  assert.equal(d.items[0].inv_number, 413);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_drafts').get().n, 1,
    'поправката не създава втори проект');
});

test('проектът СЕ трие — за разлика от акта — и триенето пак оставя следа', () => {
  /* Разликата е по същество: проектът не е излизал от библиотеката, не е
     подписван и не е вписан в КДБФ. Следа обаче остава, защото изчезването на
     подготвена комисийна работа иначе е необяснимо. */
  const { db, ipcMain, audit } = setup();
  const b1 = addBook(db, { inv_number: 421 });
  const draftId = ok(ipcMain.invoke('deaccessionActs:saveDraft', {
    id: null, draft: { date: '2026-06-10' }, bookIds: [b1]
  }), 'запис');
  audit.length = 0;
  ok(ipcMain.invoke('deaccessionActs:deleteDraft', draftId), 'изтриване');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_drafts').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_draft_items').get().n, 0,
    'редовете на проекта падат с него');
  assert.equal(db.prepare('SELECT status FROM books WHERE id = ?').get(b1).status, 'наличен',
    'нищо не е било отчислено, значи нищо не се връща');
  assert.equal(audit.length, 1, 'следа остава');
  assert.match(audit[0].detail, /изтрит проект/);
  // Второ изтриване вече няма какво да изтрие и го казва.
  assert.equal(ipcMain.invoke('deaccessionActs:deleteDraft', draftId).ok, false);
});

test('утвърждаването взима номер, отчислява документите и изтрива проекта — в едно действие', () => {
  /* Актът и изтриването на проекта минават или падат ЗАЕДНО. Иначе прекъсване
     между двете оставя утвърден акт и жив проект — и второто утвърждаване
     съставя ВТОРИ акт за същите документи, тоест КДБФ отчита двойно отчисляване
     на едни и същи инвентарни номера. */
  const { db, ipcMain } = setup();
  const b1 = addBook(db, { inv_number: 431, price: 12 });
  const b2 = addBook(db, { inv_number: 432, price: 8 });
  const draftId = ok(ipcMain.invoke('deaccessionActs:saveDraft', {
    id: null,
    draft: { date: '2026-06-10', reason_code: 3, reason_text: 'физически изхабени',
      disposal: 'унищожени', committee1: 'А', committee2: 'Б', committee3: 'В' },
    bookIds: [b1, b2]
  }), 'запис');
  const actId = ok(ipcMain.invoke('deaccessionActs:approveDraft', { id: draftId }), 'утвърждаване');

  const act = db.prepare('SELECT * FROM deaccession_acts WHERE id = ?').get(actId);
  assert.equal(act.no, 1, 'номерът се взима при утвърждаването, не по-рано');
  assert.equal(act.year, '2026');
  assert.equal(act.reason_code, 3);
  assert.equal(act.disposal, 'унищожени', 'всички полета на проекта стават полета на акта');
  for (const id of [b1, b2]) {
    assert.equal(db.prepare('SELECT status FROM books WHERE id = ?').get(id).status, 'отчислен');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_drafts WHERE id = ?').get(draftId).n, 0,
    'проектът изчезва в мига, в който стане документ');
  // И числата стигат до регистъра.
  const r = ok(ipcMain.invoke('kdbf:report', '2026'), 'КДБФ');
  assert.equal(r.deaccYear.n, 2);
  assert.equal(r.deaccYear.v, 20);
  // Второ утвърждаване няма какво да утвърди.
  assert.equal(ipcMain.invoke('deaccessionActs:approveDraft', { id: draftId }).ok, false);
});

test('утвърждаване на проект, чиито документи вече са отчислени с друг акт, се отказва', () => {
  /* Между подготовката и утвърждаването може да мине седмица, а другото работно
     място да е съставило акт за същите документи. Мълчаливото пропускане би
     дало акт с по-малко документи от списъка, който комисията е подписала —
     затова отказ, а не тих недоимък. */
  const { db, ipcMain } = setup();
  const b1 = addBook(db, { inv_number: 441 });
  const draftId = ok(ipcMain.invoke('deaccessionActs:saveDraft', {
    id: null, draft: { date: '2026-06-10', reason_code: 3, reason_text: 'физически изхабени' }, bookIds: [b1]
  }), 'запис');
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 1 }), bookIds: [b1] }), 'друг акт');

  const res = ipcMain.invoke('deaccessionActs:approveDraft', { id: draftId });
  assert.equal(res.ok, false, 'утвърждаването се отказва');
  assert.match(res.error, /вече са отчислени|нито един документ/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_acts').get().n, 1,
    'втори акт за същия документ не се съставя');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_drafts WHERE id = ?').get(draftId).n, 1,
    'проектът остава — има какво да се поправи в него');
});

test('прегледът на проекта показва живото състояние на фонда, а не стара снимка', () => {
  /* Проектът още не е документ: ако междувременно някой отчисли документ с друг
     акт, редът трябва да изчезне от списъка сам — иначе комисията подписва
     списък, който вече не отговаря на фонда. */
  const { db, ipcMain } = setup();
  const b1 = addBook(db, { inv_number: 451 });
  const b2 = addBook(db, { inv_number: 452 });
  const draftId = ok(ipcMain.invoke('deaccessionActs:saveDraft', {
    id: null, draft: { date: '2026-06-10' }, bookIds: [b1, b2]
  }), 'запис');
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 1 }), bookIds: [b1] }), 'друг акт');
  const d = ok(ipcMain.invoke('deaccessionActs:getDraft', draftId), 'четене');
  assert.equal(d.items.length, 1, 'вече отчисленият документ отпада от прегледа');
  assert.equal(d.items[0].inv_number, 452);
});

test('изгледът предлага проект и отказва „Изтрий“ върху утвърден акт', () => {
  /* Поправката не е само в базата: ако на екрана няма как да се направи проект
     и „Анулирай“ продължава да изглежда като триене, библиотекарят ще прави
     същото, което правеше досега. */
  assert.match(ACTS_VIEW, /saveActDraft/, 'екранът може да запише проект');
  assert.match(ACTS_VIEW, /approveActDraft/, 'и да го утвърди');
  assert.match(ACTS_VIEW, /deaccessionActs\.deleteDraft/, 'проектът се трие от екрана');
  // Анулирането вече пита за основание с формуляр, а не с едно „Да продължа?“.
  assert.match(ACTS_VIEW, /Основание за анулиране/);
  assert.match(ACTS_VIEW, /revoke\(id, \{ reason: d\.reason, by: d\.by \}\)/,
    'основанието и името стигат до главния процес');
  // И бутонът „Анулирай“ не се показва върху вече анулиран акт.
  assert.match(ACTS_VIEW, /a\.revoked_at \? '' : `<button class="btn l dgr" onclick="revokeAct/);
});

/* ==================================================================
   4. ПОПРАВКА НА ВПИСАНА ПАРТИДА
   ================================================================== */

test('acquisitions:update поправя партидата и вписва всяка промяна поименно в одитната следа', () => {
  /* Дотук имаше само create и delete, а delete отказва, щом поне един документ е
     инвентиран в партидата. Тоест сгрешен номер на фактура или сгрешена дата на
     документа оставаха ЗАВИНАГИ в КДБФ Част № 1 и излизаха при всяка проверка.
     Поправката е позволена, но не е мълчалива: редът е в официален регистър. */
  const { db, ipcMain, audit } = setup();
  const acqId = ok(ipcMain.invoke('acquisitions:create', {
    no: 5, year: '2026', date: '2026-03-01', how: 'покупка', from_source: 'Книжарница',
    doc_type: 'фактура', doc_no: '111', doc_date: '2026-02-28', total_count: 10, sum: 100
  }), 'създаване');

  audit.length = 0;
  const changed = ok(ipcMain.invoke('acquisitions:update', {
    id: acqId,
    acq: { date: '2026-03-01', how: 'покупка', from_source: 'Книжарница',
      doc_type: 'фактура', doc_no: '222', doc_date: '2026-02-28', total_count: 12, sum: 100 }
  }), 'поправка');
  assert.equal(changed, 2, 'две променени полета — номер на документа и общ брой');

  const row = db.prepare('SELECT * FROM acquisitions WHERE id = ?').get(acqId);
  assert.equal(row.doc_no, '222');
  assert.equal(row.total_count, 12);
  assert.equal(row.no, 5, 'номерът и годината на реда в регистъра не се пипат оттук');
  assert.equal(row.year, '2026');

  assert.equal(audit.length, 1, 'следа има');
  assert.match(audit[0].detail, /партида № 5\/2026/);
  assert.match(audit[0].detail, /номер на документа: „111“ → „222“/, 'старата и новата стойност поименно');
  assert.match(audit[0].detail, /общ брой: „10“ → „12“/);

  // Записване без нито една промяна пак оставя следа: отварянето и записването
  // на ред от официален регистър е събитие само по себе си.
  audit.length = 0;
  ok(ipcMain.invoke('acquisitions:update', {
    id: acqId,
    acq: { date: '2026-03-01', how: 'покупка', from_source: 'Книжарница',
      doc_type: 'фактура', doc_no: '222', doc_date: '2026-02-28', total_count: 12, sum: 100 }
  }), 'запис без промяна');
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail, /записана без промяна/);
});

test('поправката на партида не е дупка в проверките: дарение без адрес и невалидна дата се отказват', () => {
  /* При дарение адресът на дарителя е задължителен по чл. 6, ал. 5. Ако
     проверката пази само създаването, поправката става заобиколният път:
     въвеждам като покупка, после сменям начина на „дарение“. */
  const { db, ipcMain } = setup();
  const acqId = ok(ipcMain.invoke('acquisitions:create', {
    no: 1, year: '2026', date: '2026-03-01', how: 'покупка', doc_type: 'фактура', total_count: 3
  }), 'създаване');

  const noAddr = ipcMain.invoke('acquisitions:update', {
    id: acqId, acq: { date: '2026-03-01', how: 'дарение', total_count: 3 }
  });
  assert.equal(noAddr.ok, false);
  assert.match(noAddr.error, /адресът на дарителя/);

  const badDate = ipcMain.invoke('acquisitions:update', {
    id: acqId, acq: { date: 'НЕВАЛИДНА-99-99', how: 'покупка', total_count: 3 }
  });
  assert.equal(badDate.ok, false);
  assert.match(badDate.error, /[Дд]атата/);

  // Нищо от отказаните не е влязло в базата.
  const row = db.prepare('SELECT * FROM acquisitions WHERE id = ?').get(acqId);
  assert.equal(row.how, 'покупка');
  assert.equal(row.date, '2026-03-01');

  // А с адрес дарението минава.
  ok(ipcMain.invoke('acquisitions:update', {
    id: acqId, acq: { date: '2026-03-01', how: 'дарение', donor_address: 'с. Яворец, ул. Първа 1', total_count: 3 }
  }), 'дарение с адрес');
  assert.equal(db.prepare('SELECT donor_address FROM acquisitions WHERE id = ?').get(acqId).donor_address,
    'с. Яворец, ул. Първа 1');
});


test('поправката на партида е ДОСТЪПНА от екрана, не само като канал', () => {
  /* Каналът acquisitions:update съществуваше, но нито един изглед не го викаше —
     тоест сгрешеният номер на фактура в КДБФ Част № 1 пак си оставаше завинаги,
     само че вече имаше код, който би могъл да го поправи. Мъртъв канал е по-лошо
     от липсващ: изглежда като готова функция при следващия преглед. */
  const V = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'acquisitions.js'), 'utf8');
  assert.match(V, /onclick="editAcq\(/, 'прозорецът на партидата трябва да има бутон „Поправи“');
  assert.match(V, /window\.api\.acquisitions\.update\(/, 'и той трябва да вика канала');
  assert.match(V, /async function editAcq/);
  // Номерът и годината не се пипат от поправката — те са мястото на реда в регистъра.
  assert.match(V, /ro: edit \? 1 : 0/, 'номерът на вписана партида е само за четене');
  const CORE = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'core.js'), 'utf8');
  assert.match(CORE, /opts\.ro \? 'readonly' : ''/,
    'readonly, а не disabled — disabled поле не влиза във formData() и стойността изчезва от записа');
});
