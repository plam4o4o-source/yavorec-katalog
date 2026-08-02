// Витрини в онлайн каталога — извадени от main.js в отделен модул (Фаза 4,
// стъпка 3 от разбиването на монолита на модули по домейн). Ръчно подбрани
// тематични списъци, показвани от страницата на сайта като бутони.
//
// По-лек случай от handlers/backup.js: тук няма mainWindow/dialog/app, само
// db (инжектиран като getDb(), по същата причина както в backup.js — не се
// презаписва тук, но пазим единния стил на достъп до споделеното състояние)
// и три вече дефинирани функции от main.js, подадени directly by reference
// (безопасно, защото са затваряния (closures) над каквото им трябва, не
// стойности, които се преприсвояват с времето):
//   - run(fn) — обвивка за { ok, data/error }, дефинирана в main.js
//   - logAudit(action, detail) — запис в одитната следа
//   - scheduleCatalogWrite() — насрочва (debounced) запис на katalog.json,
//     за да се отрази промяната при следващото автоматично публикуване
module.exports = function registerShelvesHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, scheduleCatalogWrite } = deps;

  ipcMain.handle('shelves:list', () =>
    run(() => getDb().prepare(`
      SELECT sh.*, (SELECT COUNT(*) FROM catalog_shelf_items si WHERE si.shelf_id = sh.id) AS n
      FROM catalog_shelves sh ORDER BY sh.sort, sh.name
    `).all())
  );
  ipcMain.handle('shelves:items', (e, shelfId) =>
    run(() => getDb().prepare(`
      SELECT b.id, b.inv_number, b.title, b.author, b.status, b.department
      FROM catalog_shelf_items si JOIN books b ON b.id = si.book_id
      WHERE si.shelf_id = ? ORDER BY si.sort, b.title
    `).all(shelfId))
  );
  ipcMain.handle('shelves:create', (e, name) =>
    run(() => {
      const n = String(name || '').trim();
      if (!n) throw new Error('Името на витрината е задължително.');
      const info = getDb().prepare('INSERT INTO catalog_shelves (name) VALUES (?)').run(n);
      logAudit('Витрина в каталога', 'създадена „' + n + '“');
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('shelves:rename', (e, { id, name }) =>
    run(() => {
      const n = String(name || '').trim();
      if (!n) throw new Error('Името на витрината е задължително.');
      getDb().prepare('UPDATE catalog_shelves SET name = ? WHERE id = ?').run(n, id);
      scheduleCatalogWrite();
    })
  );
  ipcMain.handle('shelves:delete', (e, id) =>
    run(() => {
      const sh = getDb().prepare('SELECT name FROM catalog_shelves WHERE id = ?').get(id);
      getDb().prepare('DELETE FROM catalog_shelves WHERE id = ?').run(id);
      if (sh) logAudit('Витрина в каталога', 'изтрита „' + sh.name + '“');
      scheduleCatalogWrite();
    })
  );
  // CAST-ва се ПАРАМЕТЪРЪТ, не колоната — виж books:byBarcode в main.js за
  // подробното обяснение (v1.25.0): така SQLite може да ползва idx_books_barcode
  // и уникалния индекс на inv_number едновременно (MULTI-INDEX OR), вместо да
  // прибегне до пълно сканиране на фонда.
  ipcMain.handle('shelves:addBook', (e, { shelfId, code }) =>
    run(() => {
      const b = getDb().prepare('SELECT id, inv_number, title, status, department FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)')
        .get(code, code);
      if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
      if (b.status === 'отчислен') throw new Error('Инв. № ' + b.inv_number + ' е отчислен — не се публикува в каталога.');
      if (b.department === 'служебен') throw new Error('Служебните документи не се публикуват в каталога.');
      getDb().prepare('INSERT OR IGNORE INTO catalog_shelf_items (shelf_id, book_id) VALUES (?, ?)').run(shelfId, b.id);
      scheduleCatalogWrite();
      return { inv_number: b.inv_number, title: b.title };
    })
  );
  // Групово добавяне — от отметките в „Книги". Отчислените/служебните се подминават тихо.
  ipcMain.handle('shelves:addBooks', (e, { shelfId, ids }) =>
    run(() => {
      if (!Array.isArray(ids) || !ids.length) throw new Error('Няма избрани документи.');
      const db = getDb();
      const ins = db.prepare(`
        INSERT OR IGNORE INTO catalog_shelf_items (shelf_id, book_id)
        SELECT ?, id FROM books WHERE id = ? AND status != 'отчислен' AND department != 'служебен'
      `);
      let added = 0;
      db.transaction(() => { for (const id of ids) added += ins.run(shelfId, id).changes; })();
      const sh = db.prepare('SELECT name FROM catalog_shelves WHERE id = ?').get(shelfId);
      logAudit('Витрина в каталога', added + ' документа добавени в „' + (sh ? sh.name : shelfId) + '“');
      scheduleCatalogWrite();
      return added;
    })
  );
  ipcMain.handle('shelves:removeBook', (e, { shelfId, bookId }) =>
    run(() => {
      getDb().prepare('DELETE FROM catalog_shelf_items WHERE shelf_id = ? AND book_id = ?').run(shelfId, bookId);
      scheduleCatalogWrite();
    })
  );
};
