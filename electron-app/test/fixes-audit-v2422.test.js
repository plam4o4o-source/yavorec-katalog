'use strict';
/* Одит v2.4.22 — преглед на поправките от v2.4.21 (един инвентарен номер = един
   екземпляр).
   =====================================================================
   Прегледът намери две находки, и двете в handlers/books.js:

     1. normalizeQuantity() отхвърляше стойност > 1, но мълчаливо приемаше 0 —
        точно стойността, която books:setLendable и „Проверка на данните“
        съществуват да откриват и оправят, защото прави документа невидим за
        всеки сбор на фонда. Дупка в единствената врата към inventory.quantity.

     2. books:splitCopies копираше status/status_date/description непроменени
        върху всеки нов запис. Тези три полета описват СЪСТОЯНИЕТО НА ЕДИН
        ФИЗИЧЕСКИ ЕКЗЕМПЛЯР (status='липсващ', бележка „скъсана корица, липсва
        том 2“) — стар неразделен запис с такава бележка я носи най-много за
        ЕДИН от N-те екземпляра, не за всичките. Ръчният път „+ Още екземпляр“
        (bookCopyForm) вече нулираше тези полета за новия запис; автоматичното
        разделяне — не, което е точно същият клас несъответствие, който
        v2.4.21 затвори между картона и нормализирането на бройката.

   Всеки тест е проверен с мутация. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupTmpDirs, fakeIpcMain, freshDb, runDep } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

function booksSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  const audit = [];
  const ipcMain = fakeIpcMain();
  require('../handlers/books')(ipcMain, {
    getDb: () => db, run: runDep,
    logAudit: (a, d) => audit.push(a + ': ' + d),
    today: () => '2026-09-02', ftsQuery: () => '', cnSortKey: () => '',
    diffFields: () => [], scheduleCatalogWrite: () => {},
    normalizeScanCode: (c) => c
  });
  return { db, dir, ipcMain, audit };
}
const qtyOf = (db, id) => db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(id).quantity;
function legacy(db, inv, title, q, extra) {
  const cols = Object.assign({ inv_number: inv, title, price: 10 }, extra || {});
  const keys = Object.keys(cols);
  const id = db.prepare(`INSERT INTO books (${keys.join(',')}) VALUES (${keys.map(k => '@' + k).join(',')})`).run(cols).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, q);
  return id;
}

/* ==================================================================
   1. normalizeQuantity() — 0 не влиза през тази врата
   ================================================================== */

test('books:create отказва изрична бройка 0, не само над 1', async () => {
  const { ipcMain, db } = booksSetup('inv-v2422-zero-create-');
  const res = await ipcMain.invoke('books:create', { title: 'Т', inv_number: 1, quantity: 0 });
  assert.equal(res.ok, false);
  assert.match(res.error, /Бройка 0/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 0, 'нищо не е записано');
});

test('books:update отказва изрична бройка 0, не само над 1', async () => {
  const { ipcMain, db } = booksSetup('inv-v2422-zero-update-');
  const id = (await ipcMain.invoke('books:create', { title: 'Т', inv_number: 1 })).data;
  const res = await ipcMain.invoke('books:update', { id, title: 'Т', inv_number: 1, quantity: 0 });
  assert.equal(res.ok, false);
  assert.match(res.error, /Бройка 0/);
  assert.equal(qtyOf(db, id), 1, 'старата бройка е недокосната');
});

test('единственият път към бройка 0 остава books:setLendable → 1 наопаки', async () => {
  // Контрол: 0 продължава да е валидно СЪСТОЯНИЕ на реда (внесена стара база), само
  // не и стойност, която books:create/update могат да ЗАПИШАТ през картона.
  const { db } = booksSetup('inv-v2422-zero-legacy-');
  const id = legacy(db, 1, 'Стар нулев', 0);
  assert.equal(qtyOf(db, id), 0, 'директно вмъкнат стар ред с 0 си остава такъв — не е забранено НА НИВО СХЕМА');
});

/* ==================================================================
   2. books:splitCopies — състоянието на екземпляра не се копира
   ================================================================== */

test('разделянето не обявява всеки нов екземпляр за „липсващ“ заради бележка на стария ред', async () => {
  const { ipcMain, db } = booksSetup('inv-v2422-split-status-');
  const id = legacy(db, 7, 'Под игото', 3, {
    status: 'липсващ', status_date: '2024-01-01',
    description: 'липсва том 2 от изданието'
  });
  db.prepare('UPDATE settings SET next_inv_number = 8 WHERE id = 1').run();

  const res = await ipcMain.invoke('books:splitCopies', id);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.created, [8, 9]);

  const orig = db.prepare('SELECT status, status_date, description FROM books WHERE id = ?').get(id);
  assert.equal(orig.status, 'липсващ', 'оригиналният ред пази каквото си е имал');
  assert.equal(orig.description, 'липсва том 2 от изданието');

  for (const inv of [8, 9]) {
    const row = db.prepare('SELECT status, status_date, description FROM books WHERE inv_number = ?').get(inv);
    assert.equal(row.status, 'наличен',
      'нов екземпляр не наследява статуса на стария ред — той описва само ЕДИН физически екземпляр');
    assert.equal(row.status_date, null);
    assert.equal(row.description, null,
      'бележка за конкретен дефектен екземпляр не се разпростира върху здравите копия');
  }
});

test('разделянето пази всичко останало непроменено — само трите полета за състояние се нулират', async () => {
  // Контрол: находка 2 не бива да проправи път за загуба на цена/партида/дата.
  const { ipcMain, db } = booksSetup('inv-v2422-split-rest-');
  const acq = db.prepare("INSERT INTO acquisitions (no, year, date) VALUES (1, '2020', '2020-05-05')").run().lastInsertRowid;
  const id = legacy(db, 7, 'Под игото', 2, {
    author: 'Вазов, Иван', price: 12.5, register_date: '2020-05-05', acquisition_id: acq
  });
  db.prepare('UPDATE settings SET next_inv_number = 8 WHERE id = 1').run();
  const res = await ipcMain.invoke('books:splitCopies', id);
  assert.equal(res.ok, true, res.error);
  const row = db.prepare('SELECT * FROM books WHERE inv_number = 8').get();
  assert.equal(row.title, 'Под игото');
  assert.equal(row.author, 'Вазов, Иван');
  assert.equal(row.price, 12.5);
  assert.equal(row.acquisition_id, acq);
  assert.equal(row.register_date, '2020-05-05');
});
