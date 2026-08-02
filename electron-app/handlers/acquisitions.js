// Постъпления (партиди) — извадени от main.js в отделен модул (Фаза 4,
// стъпка 14 от разбиването на монолита на модули по домейн). Първи домейн
// зависим от BOOK_SELECT — споделената SQL заготовка на "Книги" (все още
// неизвадени от main.js). Подава се по стойност (низ), не getter — BOOK_SELECT
// е `const`, никога не се преприсвоява, за разлика от db/mainWindow.
// `yearOf` също по референция (const функция, дефинирана по-рано в main.js).
module.exports = function registerAcquisitionsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, BOOK_SELECT, yearOf } = deps;

  ipcMain.handle('acquisitions:list', () =>
    run(() => getDb().prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM books b WHERE b.acquisition_id = a.id) AS registered_count,
             (SELECT COALESCE(SUM(price),0) FROM books b WHERE b.acquisition_id = a.id) AS registered_value
      FROM acquisitions a ORDER BY a.date DESC, a.no DESC
    `).all())
  );
  ipcMain.handle('acquisitions:get', (e, id) =>
    run(() => {
      const db = getDb();
      const acq = db.prepare('SELECT * FROM acquisitions WHERE id = ?').get(id);
      if (!acq) return null;
      acq.items = db.prepare(`${BOOK_SELECT} WHERE b.acquisition_id = ? ORDER BY b.inv_number`).all(id);
      return acq;
    })
  );
  ipcMain.handle('acquisitions:nextNo', (e, year) =>
    run(() => {
      const y = year || yearOf();
      const row = getDb().prepare('SELECT MAX(no) AS m FROM acquisitions WHERE year = ?').get(y);
      return (row.m || 0) + 1;
    })
  );
  ipcMain.handle('acquisitions:create', (e, a) =>
    run(() => {
      const info = getDb().prepare(`
        INSERT INTO acquisitions (no, year, date, how, from_source, doc_type, doc_no, doc_date, total_count, sum, donor_address, note)
        VALUES (@no, @year, @date, @how, @from_source, @doc_type, @doc_no, @doc_date, @total_count, @sum, @donor_address, @note)
      `).run({
        no: parseInt(a.no, 10), year: yearOf(a.date), date: a.date, how: a.how || null,
        from_source: a.from_source || null, doc_type: a.doc_type || null, doc_no: a.doc_no || null,
        doc_date: a.doc_date || null, total_count: parseInt(a.total_count, 10) || 0,
        sum: a.sum ? parseFloat(a.sum) : 0, donor_address: a.donor_address || null, note: a.note || null
      });
      logAudit('Постъпление', 'партида № ' + a.no + ' — ' + a.total_count + ' бр. от ' + a.from_source);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('acquisitions:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const cnt = db.prepare('SELECT COUNT(*) AS n FROM books WHERE acquisition_id = ?').get(id).n;
      if (cnt > 0) throw new Error('Партидата има инвентирани документи и не може да бъде изтрита.');
      db.prepare('DELETE FROM acquisitions WHERE id = ?').run(id);
    })
  );
};
