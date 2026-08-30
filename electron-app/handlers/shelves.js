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
  const { getDb, run, logAudit, scheduleCatalogWrite, normalizeScanCode } = deps;

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
  // normalizeScanCode() (v1.70.1) — виж books:byBarcode в handlers/books.js за
  // обяснението на кирилско/латинско разминаване при баркод четец.
  ipcMain.handle('shelves:addBook', (e, { shelfId, code }) =>
    run(() => {
      const c = normalizeScanCode(code);
      const b = getDb().prepare('SELECT id, inv_number, title, status, department FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)')
        .get(c, c);
      if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
      if (b.status === 'отчислен') throw new Error('Инв. № ' + b.inv_number + ' е отчислен — не се публикува в каталога.');
      /* Същото условие като в износа на каталога (buildCatalogPayload в main.js) и
         в груповото добавяне по-долу: там е SQL `status != 'отчислен'`, което за
         ред с НЕПОЗНАТ статус (внос отпреди enum тригера) не е вярно — тоест
         такъв документ не се публикува. Проверката в JS тук обаче пропускаше
         NULL и редът влизаше във витрината: програмата казваше „добавена“, а
         витрината на сайта излизаше празна, без никъде да пише защо. */
      if (b.status == null) {
        throw new Error('Инв. № ' + b.inv_number + ' е без попълнен статус (обикновено запис от по-стар внос) и '
          + 'затова не се публикува в онлайн каталога. Отворете документа, задайте статус „наличен“ и опитайте пак.');
      }
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
        -- Същата консервативна проверка като в износа на каталога (виж бележката в
        -- handlers/catalog.js): документ, който няма да бъде публикуван, не бива да
        -- влиза и във витрина — иначе страницата показва празна карта.
        SELECT ?, id FROM books WHERE id = ? AND status != 'отчислен' AND COALESCE(department,'') != 'служебен'
      `);
      /* Одит v2.4.14: пропуснатите се връщат ПОИМЕННО, а не се подминават тихо.
         shelves:addBook (единичното сканиране) обяснява подробно защо документ без
         статус не се публикува; тук — пътят, по който витрината реално се пълни
         (отметки в „Книги“) — SQL филтърът просто ги изпускаше и на екрана
         оставаше само число: „17 документа добавени“ за 20 отметнати, без нито
         дума кои три липсват и защо. Причината се изчислява по СЪЩИТЕ условия
         като филтъра по-горе. */
      const look = db.prepare('SELECT id, inv_number, title, status, department FROM books WHERE id = ?');
      let added = 0;
      const skipped = [];
      db.transaction(() => {
        for (const id of ids) {
          const n = ins.run(shelfId, id).changes;
          if (n) { added += n; continue; }
          const b = look.get(id);
          if (!b) { skipped.push({ id, reason: 'документът вече не съществува' }); continue; }
          if (b.status === 'отчислен') skipped.push({ inv_number: b.inv_number, title: b.title, reason: 'отчислен' });
          else if (b.status == null) skipped.push({ inv_number: b.inv_number, title: b.title, reason: 'без попълнен статус (запис от по-стар внос)' });
          else if (b.department === 'служебен') skipped.push({ inv_number: b.inv_number, title: b.title, reason: 'служебен документ' });
          // Останалото е INSERT OR IGNORE заради вече съществуващ ред — не е пропуск.
        }
      }).immediate();
      const sh = db.prepare('SELECT name FROM catalog_shelves WHERE id = ?').get(shelfId);
      logAudit('Витрина в каталога', added + ' документа добавени в „' + (sh ? sh.name : shelfId) + '“'
        + (skipped.length ? ', ' + skipped.length + ' пропуснати' : ''));
      scheduleCatalogWrite();
      return { added, skipped };
    })
  );
  ipcMain.handle('shelves:removeBook', (e, { shelfId, bookId }) =>
    run(() => {
      getDb().prepare('DELETE FROM catalog_shelf_items WHERE shelf_id = ? AND book_id = ?').run(shelfId, bookId);
      scheduleCatalogWrite();
    })
  );
};
