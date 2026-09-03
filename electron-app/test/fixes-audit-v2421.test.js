'use strict';
/* v2.4.21 — ЕДИН ИНВЕНТАРЕН НОМЕР = ЕДИН ЕКЗЕМПЛЯР.

   Правилото е потвърдено от библиотеката. Дотук програмата учеше на обратното на
   три места едновременно: полето „Налични бройки“ в картона приемаше свободно
   число, наръчникът изрично инструктираше библиотекаря да впише там броя
   екземпляри, а коментарът на самия тригер в схемата говореше за „легитимни втори
   бройки“. Върху този случай стоеше цял слой аритметика Σ(бройки) в КДБФ, в
   инвентарната книга, в актовете и в износите.

   Тестовете тук заковават три неща:
     1. програмата вече НЕ създава такъв запис (и не го сплесква мълчаливо — нито
        при създаване, нито при редакция на стар запис);
     2. вторият екземпляр е ВТОРИ ЗАПИС със свой инвентарен номер;
     3. вече съществуващ такъв запис (внесена стара база) се намира и се поправя
        БЕЗ да се променят броят документи и стойността на фонда — и отчислен
        запис не се пипа, защото нов ред без дата на отчисляване би нараснал фонда.

   Всеки тест е проверен с мутация. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  APP_DIR, cleanupTmpDirs, fakeIpcMain, freshDb, runDep, buildDom, settle, printed
} = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

function booksSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  const audit = [];
  const catalogWrites = [];
  const ipcMain = fakeIpcMain();
  require('../handlers/books')(ipcMain, {
    getDb: () => db, run: runDep,
    logAudit: (a, d) => audit.push(a + ': ' + d),
    today: () => '2026-09-01', ftsQuery: () => '', cnSortKey: () => '',
    diffFields: () => [], scheduleCatalogWrite: () => catalogWrites.push(1),
    normalizeScanCode: (c) => c
  });
  return { db, dir, ipcMain, audit, catalogWrites };
}
const qtyOf = (db, id) => db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(id).quantity;

/* ==================================================================
   1. ПРОГРАМАТА ВЕЧЕ НЕ СЪЗДАВА ТАКЪВ ЗАПИС
   ================================================================== */

test('запис с повече от един екземпляр под един инвентарен номер се отказва', async () => {
  const { ipcMain, db } = booksSetup('inv-v2421-create-');
  const res = await ipcMain.invoke('books:create', { title: 'Под игото', inv_number: 1, quantity: 3 });
  assert.equal(res.ok, false, 'такъв запис инвентарната книга не допуска');
  assert.match(res.error, /един екземпляр/i);
  assert.match(res.error, /\+ Още екземпляр/, 'съобщението казва КАК се завежда втори екземпляр');
  /* Отказ, а не мълчаливо сплескване до 1: сплескването би отнело два документа
     от фонда, без никой да разбере. */
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 0, 'нищо не се записва наполовина');
});

test('картонът не праща бройка и новият запис получава 1', async () => {
  const { ipcMain, db } = booksSetup('inv-v2421-default-');
  const id = (await ipcMain.invoke('books:create', { title: 'Т', inv_number: 1 })).data;
  assert.equal(qtyOf(db, id), 1);
});

test('редакция на стар неразделен запис НЕ сплесква бройката му', async () => {
  /* Дефект, намерен при прегледа на първата редакция на тази кръпка: картонът
     вече не праща бройка, а books:update нулираше непратената на 1. Стар запис с
     3 екземпляра, отворен за поправка на правописна грешка в заглавието, губеше
     два документа от фонда — тихо. */
  const { ipcMain, db } = booksSetup('inv-v2421-keep-');
  const id = db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'Стар')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 3)').run(id);
  const res = await ipcMain.invoke('books:update', { id, title: 'Стар, поправен' });
  assert.equal(res.ok, true, res.error);
  assert.equal(qtyOf(db, id), 3, 'непратена бройка = запазена бройка');
  assert.equal(db.prepare('SELECT title FROM books WHERE id = ?').get(id).title, 'Стар, поправен');
});

test('редакцията също не може да вдигне бройката изрично', async () => {
  const { ipcMain, db } = booksSetup('inv-v2421-update-');
  const id = (await ipcMain.invoke('books:create', { title: 'Т', inv_number: 1 })).data;
  const res = await ipcMain.invoke('books:update', { id, title: 'Т', quantity: 4 });
  assert.equal(res.ok, false);
  assert.equal(qtyOf(db, id), 1, 'старата стойност остава непокътната');
});

/* ==================================================================
   2. НАМИРАНЕ И ПОПРАВЯНЕ НА СТАРИТЕ ЗАПИСИ
   ================================================================== */

function legacy(db, inv, title, q, extra) {
  const cols = Object.assign({ inv_number: inv, title, price: 10 }, extra || {});
  const keys = Object.keys(cols);
  const id = db.prepare(`INSERT INTO books (${keys.join(',')}) VALUES (${keys.map(k => '@' + k).join(',')})`).run(cols).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, q);
  return id;
}

test('books:multiCopyRecords намира всяка бройка ≠ 1, но не и отчислените', async () => {
  const { ipcMain, db } = booksSetup('inv-v2421-find-');
  legacy(db, 1, 'Един', 1);
  const three = legacy(db, 2, 'Три', 3);
  const zero = legacy(db, 3, 'Нула', 0);
  legacy(db, 4, 'Отчислен с три', 3, { status: 'отчислен', deaccession_date: '2025-01-01' });
  const rows = (await ipcMain.invoke('books:multiCopyRecords')).data;
  assert.deepEqual(rows.map(r => r.id).sort(), [three, zero].sort(),
    'нулата е също отклонение (документът изчезва от всеки сбор); отчисленият е история');
  assert.equal(rows.find(r => r.id === three).open_loans, 0);
});

test('разделянето не променя нито броя документи, нито стойността на фонда', async () => {
  const { ipcMain, db, audit } = booksSetup('inv-v2421-split-');
  const acq = db.prepare("INSERT INTO acquisitions (no, year, date) VALUES (1, '2020', '2020-05-05')").run().lastInsertRowid;
  const id = legacy(db, 7, 'Под игото', 3, { author: 'Вазов, Иван', price: 12.5, register_date: '2020-05-05',
    department: 'за възрастни', acquisition_id: acq, barcode: 'BC-7' });
  db.prepare('UPDATE settings SET next_inv_number = 8 WHERE id = 1').run();

  const fund = () => db.prepare(`SELECT COALESCE(SUM(i.quantity),0) AS n, COALESCE(SUM(b.price * i.quantity),0) AS v
    FROM books b JOIN inventory i ON i.book_id = b.id`).get();
  const before = fund();
  assert.deepEqual(before, { n: 3, v: 37.5 });

  const res = await ipcMain.invoke('books:splitCopies', id);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.created, [8, 9]);
  assert.deepEqual(fund(), before, 'СЪЩИЯТ брой документи и СЪЩАТА стойност — променя се само записът');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 3);
  for (const row of db.prepare('SELECT b.*, i.quantity FROM books b JOIN inventory i ON i.book_id=b.id ORDER BY b.inv_number').all()) {
    assert.equal(row.quantity, 1);
    assert.equal(row.title, 'Под игото');
    assert.equal(row.price, 12.5);
    assert.equal(row.acquisition_id, acq, 'партидата в КДБФ се пази — иначе Част № 1 губи документи');
    assert.equal(row.register_date, '2020-05-05', 'датата на вписване също — иначе Част № 2 ги мести в друга година');
  }
  const barcodes = db.prepare('SELECT barcode FROM books ORDER BY inv_number').all().map(r => r.barcode);
  assert.deepEqual(barcodes, ['BC-7', null, null], 'баркодът е залепен на един екземпляр и не се копира');
  assert.equal(db.prepare('SELECT next_inv_number FROM settings WHERE id=1').get().next_inv_number, 10);
  assert.ok(audit.some(a => /Разделяне на екземпляри/.test(a)), 'действието влиза в одитната следа');
});

test('отчислен стар запис не се разделя — нов ред без дата на отчисляване би нараснал фонда', async () => {
  /* Дефект от прегледа на първата редакция на кръпката: deaccession_date не е в
     BOOK_FIELDS и не се копира; нов ред със status 'отчислен', но с NULL дата, минава
     проверката на stockAt() в КДБФ и влиза в наличността като жив документ. */
  const { ipcMain, db } = booksSetup('inv-v2421-deacc-');
  const id = legacy(db, 1, 'Отчислен', 3, { status: 'отчислен', deaccession_date: '2025-01-01' });
  const res = await ipcMain.invoke('books:splitCopies', id);
  assert.equal(res.ok, false);
  assert.match(res.error, /отчислен/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 1, 'нищо не е създадено');
});

test('разделянето прескача вече заетите инвентарни номера', async () => {
  const { ipcMain, db } = booksSetup('inv-v2421-skip-');
  const id = legacy(db, 5, 'А', 3);
  legacy(db, 6, 'Б', 1);
  db.prepare('UPDATE settings SET next_inv_number = 6 WHERE id = 1').run();
  const res = await ipcMain.invoke('books:splitCopies', id);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.created, [7, 8], 'зает номер не се презаписва — inv_number е UNIQUE');
});

test('разделянето се отказва, докато има повече от едно отворено заемане', async () => {
  const { ipcMain, db } = booksSetup('inv-v2421-loans-');
  const id = legacy(db, 1, 'А', 3);
  const r1 = db.prepare("INSERT INTO readers (name) VALUES ('Ч1')").run().lastInsertRowid;
  const r2 = db.prepare("INSERT INTO readers (name) VALUES ('Ч2')").run().lastInsertRowid;
  const loan = db.prepare('INSERT INTO loans (reader_id, book_id, date_out) VALUES (?, ?, ?)');
  loan.run(r1, id, '2026-01-01');
  loan.run(r2, id, '2026-01-02');
  const res = await ipcMain.invoke('books:splitCopies', id);
  assert.equal(res.ok, false, 'заеманията сочат към стария общ ред — не се знае кой държи кой екземпляр');
  assert.match(res.error, /2 незавършени заемания/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 1);
});

test('бройка 0 се връща на 1 с изрично действие и следа в одита', async () => {
  const { ipcMain, db, audit } = booksSetup('inv-v2421-zero-');
  const id = legacy(db, 1, 'Нула', 0);
  const res = await ipcMain.invoke('books:setLendable', id);
  assert.equal(res.ok, true, res.error);
  assert.equal(qtyOf(db, id), 1);
  assert.ok(audit.some(a => /Поправка на бройка/.test(a)));
});

/* ==================================================================
   3. ЕКРАНЪТ И НАРЪЧНИКЪТ
   ================================================================== */
const BOOK_FORM_API = { 'categories.list': [], 'acquisitions.list': [], 'av.options': {}, 'books.suggestions': {}, 'shelves.list': [] };

test('картонът не предлага поле за брой екземпляри', async () => {
  const dom = buildDom(Object.assign({ 'books.get': { id: 1, inv_number: 1, title: 'Т', status: 'наличен', quantity: 1 } }, BOOK_FORM_API));
  const { window } = dom;
  await settle();
  await window.bookForm(1);
  await settle();
  assert.equal(window.document.querySelector('#bookF [name="quantity"]'), null,
    'бройка не се праща изобщо — картонът е за един екземпляр');
  const txt = window.document.querySelector('#bookF').textContent;
  assert.ok(!/Налични бройки/.test(txt), 'старото име подсказваше брой');
  // Текстът стои в стойността на изключено поле, не в текста на формата.
  const ro = [...window.document.querySelectorAll('#bookF input[disabled]')].map(e => e.value).join(' | ');
  assert.match(ro, /един инвентарен номер, един екземпляр/);
  assert.ok(window.document.querySelector('[onclick="bookCopyForm(1)"]'), 'бутонът „+ Още екземпляр“');
});

test('стар запис с друга бройка се показва като предупреждение, без поле за редакция', async () => {
  const dom = buildDom(Object.assign({ 'books.get': { id: 2, inv_number: 2, title: 'Т', status: 'наличен', quantity: 3 } }, BOOK_FORM_API));
  const { window } = dom;
  await settle();
  await window.bookForm(2);
  await settle();
  assert.equal(window.document.querySelector('#bookF [name="quantity"]'), null,
    'нищо за пращане — books:update запазва непратената бройка');
  const ro = [...window.document.querySelectorAll('#bookF input[disabled]')].map(e => e.value).join(' | ');
  assert.match(ro, /3 — стар запис/);
  assert.match(window.document.querySelector('#bookF').textContent, /Проверка на данните/, 'и казва къде се поправя');
});

test('„+ Още екземпляр“ отваря НОВ запис със следващия номер и без баркод', async () => {
  const src = {
    id: 1, inv_number: 4, title: 'Под игото', author: 'Вазов, Иван', price: 12.5,
    barcode: 'BC-4', description: 'скъсана корица', status: 'липсващ', status_date: '2026-01-01',
    datelastseen: '2026-02-02', register_date: '2020-05-05', acquisition_id: 3, quantity: 1
  };
  const dom = buildDom(Object.assign({}, BOOK_FORM_API, {
    'books.get': src, 'settings.get': { next_inv_number: 9 },
    'acquisitions.list': [{ id: 3, no: 1, year: '2020', from_source: 'Х' }]
  }));
  const { window } = dom;
  await settle();
  await window.bookCopyForm(1);
  await settle();
  const val = (n) => { const e = window.document.querySelector(`#bookF [name="${n}"]`); return e ? e.value : null; };
  assert.equal(window.document.querySelector('#bookF').dataset.id, undefined, 'това е НОВ запис, не редакция на стария');
  assert.equal(val('inv_number'), '9', 'следващият свободен инвентарен номер');
  assert.equal(val('barcode'), '', 'етикетът се лепи на конкретния екземпляр');
  assert.equal(val('title'), 'Под игото', 'описанието се копира');
  assert.equal(val('price'), '12.5');
  assert.equal(val('acquisition_id'), '3', 'партидата в КДБФ също');
  assert.equal(val('description'), '', 'бележката е за онзи екземпляр, не за този');
  assert.equal(val('status'), 'наличен', 'новият екземпляр е наличен, не „липсващ“ като стария');
});

test('проверката на данните показва трите вида отклонения', async () => {
  const dom = buildDom({
    'settings.get': {}, 'limits.usage': null, 'av.options': {}, 'employees.list': [],
    'circRules.list': [], 'calendar.list': [], 'backup.status': null, 'gdpr.status': null,
    'pdp.status': {}, 'securityExclusions.status': null, 'autoUpdate.status': null,
    'books.multiCopyRecords': [
      { id: 5, inv_number: 7, title: 'Под игото', author: 'Вазов', quantity: 3, open_loans: 0 },
      { id: 6, inv_number: 8, title: 'Нула', quantity: 0, status: 'наличен', open_loans: 0 }
    ],
    'books.findDuplicateBarcodes': [{ barcode: 'BC1', books: [
      { id: 1, inv_number: 1, title: 'А', status: 'наличен' },
      { id: 2, inv_number: 2, title: 'Б', status: 'наличен' }] }],
    // Четвъртата проверка (одит v2.4.24) — тук нарочно празна, за да остане този
    // тест за трите отклонения; собственият ѝ тест е в fixes-audit-v2424.test.js.
    'books.deaccessionedWithoutAct': []
  });
  const { window } = dom;
  await settle();
  /* Изгледът се рендира ИЗРИЧНО — runDataChecks() пише в #dataChecks, който
     съществува само в Настройки. Първата редакция на този тест го викаше направо
     и при около един пуск от три четеше празен низ. */
  window.location.hash = '#settings';
  await window.route();
  await settle();
  assert.ok(window.document.querySelector('[onclick="runDataChecks()"]'), 'бутонът „Провери сега“ е в Настройки');
  await window.runDataChecks();
  await settle();
  const t = window.document.getElementById('dataChecks').textContent.replace(/\s+/g, ' ');
  assert.match(t, /носи общо 3 екземпляра/);
  assert.match(t, /броят документи и стойността на фонда остават същите/i);
  assert.match(t, /Раздели на 3 записа/);
  assert.match(t, /Записи с бройка 0/);
  assert.match(t, /Върни бройката на 1/);
  assert.match(t, /Баркод BC1/, 'и висящият канал findDuplicateBarcodes най-после има екран');
});

test('наръчниците вече не учат броят екземпляри да се вписва в поле', () => {
  const md = fs.readFileSync(path.join(APP_DIR, 'README-bibliotekar.md'), 'utf8');
  const sec = md.slice(md.indexOf('### Няколко екземпляра от едно заглавие'));
  const body = sec.slice(0, sec.indexOf('\n### ', 5));
  assert.match(body, /Един инвентарен номер отговаря на един екземпляр/);
  assert.match(body, /\+ Още екземпляр/);
  assert.ok(!/впишете\s*\n?броя в полето/.test(body), 'старата инструкция трябва да е махната');
  assert.match(body, /Проверка на данните/);
  const html = fs.readFileSync(path.join(APP_DIR, '..', 'docs', 'narachnik.html'), 'utf8');
  assert.match(html, /Един\s+инвентарен номер отговаря на един екземпляр/, 'и HTML наръчникът казва правилото');
  assert.ok(!/1 зает\s*\nи 1 чакащ пред опашката остават 2 свободни/.test(html),
    'примерът с „3 екземпляра под едно заглавие“ в резервациите е махнат');
});

/* ==================================================================
   4. РАЗПЕЧАТКИТЕ
   ================================================================== */
const rowWidths = (window) => new Set([...window.document.querySelectorAll('#ppSheet table tr')]
  .map(tr => [...tr.children].reduce((s, td) => s + (parseInt(td.getAttribute('colspan'), 10) || 1), 0)));

test('актовете не носят колона „Бр.“, когато всеки ред е един екземпляр', async () => {
  const items = [{ inv_number: 1, title: 'А', price: 10, fund_qty: 1 }, { inv_number: 2, title: 'Б', price: 5, fund_qty: 1 }];
  const dom = buildDom({ 'acquisitions.get': { id: 1, no: 1, year: '2026', date: '2026-01-01',
    how: 'дарение', from_source: 'Д', total_count: 2, sum: 15, items }, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printDonationDoc(1);
  await settle();
  assert.ok(!/<th>Бр\.<\/th>/.test(window.document.querySelector('#ppSheet').innerHTML),
    'колона, която навсякъде е 1, е шум в подписан документ');
  assert.equal(rowWidths(window).size, 1, 'всички редове остават еднакво широки');
});

test('но я носят, ако актът стъпва върху неразделен стар запис', async () => {
  const items = [{ inv_number: 1, title: 'А', price: 10, fund_qty: 3 }, { inv_number: 2, title: 'Б', price: 5, fund_qty: 1 }];
  const dom = buildDom({ 'acquisitions.get': { id: 1, no: 1, year: '2026', date: '2026-01-01',
    how: 'дарение', from_source: 'Д', total_count: 4, sum: 35, items }, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printDonationDoc(1);
  await settle();
  assert.match(window.document.querySelector('#ppSheet').innerHTML, /<th>Бр\.<\/th>/,
    'иначе редът ОБЩО (35.00) не се сумира от колоната над него');
  assert.equal(rowWidths(window).size, 1);
  assert.match(printed(window), /ОБЩО 4 документа/);
});

test('актът за отчисляване — същото правило', async () => {
  const act = (items) => ({ id: 2, no: 1, year: '2026', date: '2026-02-02', reason_code: 3, reason_text: 'изхабени',
    disposal: 'унищожени', committee1: 'А', items });
  const one = buildDom({ 'deaccessionActs.get': act([{ inv_number: 1, title: 'П', price: 10, quantity: 1 }]), 'settings.get': {} });
  await settle(); await one.window.printActDoc(2); await settle();
  assert.ok(!/<th>Бр\.<\/th>/.test(one.window.document.querySelector('#ppSheet').innerHTML));
  // Съгласуване в единствено число (одит v2.4.24) — актът се подписва.
  assert.match(printed(one.window), /ОБЩО 1 документ\s*10\.00/);
  assert.equal(rowWidths(one.window).size, 1);
  const many = buildDom({ 'deaccessionActs.get': act([{ inv_number: 1, title: 'П', price: 10, quantity: 3 }]), 'settings.get': {} });
  await settle(); await many.window.printActDoc(2); await settle();
  assert.match(many.window.document.querySelector('#ppSheet').innerHTML, /<th>Бр\.<\/th>/);
  assert.match(printed(many.window), /ОБЩО\s*3\s*30\.00/);
  assert.equal(rowWidths(many.window).size, 1);
});

test('инвентарната книга не обявява разлика между вписвания и документи, когато няма такава', async () => {
  const rows = [
    { id: 1, inv_number: 1, title: 'А', register_date: '2026-01-01', price: 10, quantity: 1, status: 'наличен' },
    { id: 2, inv_number: 2, title: 'Б', register_date: '2026-01-02', price: 5, quantity: 1, status: 'наличен' }
  ];
  const dom = buildDom({ 'invBook.list': rows });
  const { window } = dom;
  await settle();
  window.location.hash = '#invbook';
  await window.route();
  await settle();
  window.printInvBookDoc();
  await settle();
  const t = printed(window);
  assert.match(t, /2 вписвания/);
  assert.match(t, /2 библиотечни документа/);
  assert.ok(!/един инвентарен номер може да обхваща повече/.test(t), 'това е точно твърдението, което правилото отрича');
  assert.ok(!/Внимание:/.test(t), 'няма разминаване — няма и предупреждение');
});

test('но обявява разликата, ако базата още носи неразделен запис', async () => {
  const dom = buildDom({ 'invBook.list': [
    { id: 1, inv_number: 1, title: 'А', register_date: '2026-01-01', price: 10, quantity: 3, status: 'наличен' }] });
  const { window } = dom;
  await settle();
  window.location.hash = '#invbook';
  await window.route();
  await settle();
  window.printInvBookDoc();
  await settle();
  const t = printed(window);
  assert.match(t, /1 инвентарни номера дават 3 документа/);
  assert.match(t, /Проверка на данните/, 'и казва къде се поправя');
});
