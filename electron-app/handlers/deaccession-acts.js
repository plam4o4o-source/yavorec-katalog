// Отчисляване (актове) — извадени от main.js в отделен модул (Фаза 4,
// стъпка 15 от разбиването на монолита на модули по домейн). Зависи от
// BOOK_SELECT (по стойност, const низ) и scheduleCatalogWrite (по
// референция, функция дефинирана в main.js — отчисляването/анулирането
// сменят видимостта на документи в онлайн каталога, затова насрочват
// запис на katalog.json, точно както shelves.js).
module.exports = function registerDeaccessionActsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, BOOK_SELECT, yearOf, scheduleCatalogWrite, normalizeScanCode } = deps;

  ipcMain.handle('deaccessionActs:list', () =>
    run(() => getDb().prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM deaccession_items i WHERE i.act_id = a.id) AS item_count,
             (SELECT COALESCE(SUM(price),0) FROM deaccession_items i WHERE i.act_id = a.id) AS item_value
      FROM deaccession_acts a ORDER BY a.date DESC, a.no DESC
    `).all())
  );
  ipcMain.handle('deaccessionActs:get', (e, id) =>
    run(() => {
      const db = getDb();
      const act = db.prepare('SELECT * FROM deaccession_acts WHERE id = ?').get(id);
      if (!act) return null;
      act.items = db.prepare('SELECT * FROM deaccession_items WHERE act_id = ? ORDER BY inv_number').all(id);
      return act;
    })
  );
  ipcMain.handle('deaccessionActs:nextNo', (e, year) =>
    run(() => {
      const y = year || yearOf();
      const row = getDb().prepare('SELECT MAX(no) AS m FROM deaccession_acts WHERE year = ?').get(y);
      return (row.m || 0) + 1;
    })
  );
  // normalizeScanCode() (v1.70.1) — виж books:byBarcode в handlers/books.js за
  // обяснението на кирилско/латинско разминаване при баркод четец.
  ipcMain.handle('deaccessionActs:findBook', (e, code) => run(() => {
    const c = normalizeScanCode(code);
    return getDb().prepare(`${BOOK_SELECT} WHERE (b.barcode = ? OR b.inv_number = CAST(? AS INTEGER)) AND b.status != 'отчислен'`).get(c, c);
  }));
  ipcMain.handle('deaccessionActs:create', (e, { act, bookIds }) =>
    run(() => {
      const db = getDb();
      const tx = db.transaction(() => {
        const info = db.prepare(`
          INSERT INTO deaccession_acts (no, year, date, order_no, reason_code, reason_text, disposal, attach, committee1, committee2, committee3)
          VALUES (@no, @year, @date, @order_no, @reason_code, @reason_text, @disposal, @attach, @committee1, @committee2, @committee3)
        `).run({
          no: parseInt(act.no, 10), year: yearOf(act.date), date: act.date, order_no: act.order_no || null,
          reason_code: parseInt(act.reason_code, 10), reason_text: act.reason_text,
          disposal: act.disposal || null, attach: act.attach || null,
          committee1: act.committee1 || null, committee2: act.committee2 || null, committee3: act.committee3 || null
        });
        const actId = info.lastInsertRowid;
        const insItem = db.prepare(`
          INSERT INTO deaccession_items (act_id, book_id, inv_number, author, title, volume, year, price, udk, category, language)
          VALUES (@act_id, @book_id, @inv_number, @author, @title, @volume, @year, @price, @udk, @category, @language)
        `);
        const closeLoans = db.prepare(`UPDATE loans SET date_in = ? WHERE book_id = ? AND date_in IS NULL`);
        bookIds.forEach(bookId => {
          const b = db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(bookId);
          if (!b) return;
          insItem.run({
            act_id: actId, book_id: b.id, inv_number: b.inv_number, author: b.author, title: b.title,
            volume: b.volume, year: b.year, price: b.price, udk: b.udk,
            category: b.category_name, language: b.language
          });
          db.prepare('UPDATE books SET status = ?, status_date = ?, deaccession_act_id = ?, deaccession_date = ? WHERE id = ?')
            .run('отчислен', act.date, actId, act.date, b.id);
          closeLoans.run(act.date, b.id);
        });
        db.prepare('UPDATE settings SET committee1=?, committee2=?, committee3=? WHERE id=1')
          .run(act.committee1 || null, act.committee2 || null, act.committee3 || null);
        logAudit('Отчисляване', 'акт № ' + act.no + ' — ' + bookIds.length + ' документа, причина: ' + act.reason_text);
        return actId;
      });
      const actId = tx();
      scheduleCatalogWrite();
      return actId;
    })
  );
  ipcMain.handle('deaccessionActs:revoke', (e, id) =>
    run(() => {
      const db = getDb();
      const tx = db.transaction(() => {
        const items = db.prepare('SELECT book_id FROM deaccession_items WHERE act_id = ?').all(id);
        items.forEach(it => {
          if (it.book_id) {
            db.prepare(`UPDATE books SET status='наличен', status_date=date('now'), deaccession_act_id=NULL, deaccession_date=NULL WHERE id=?`)
              .run(it.book_id);
          }
        });
        db.prepare('DELETE FROM deaccession_acts WHERE id = ?').run(id);
        logAudit('Анулиране на акт', 'акт № ' + id + ' е анулиран, документите са върнати във фонда');
      });
      tx();
      scheduleCatalogWrite();
    })
  );
};
