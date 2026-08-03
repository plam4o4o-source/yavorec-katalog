// КДБФ — книга за движение на фонда — извадено от main.js (Фаза 4, стъпка 16).
// Единствен обобщаващ справочен handler: чете acquisitions/deaccession_acts/books
// за дадена година, не пише нищо. Зависи само от getDb, run и yearOf (по стойност).
module.exports = function registerKdbfHandlers(ipcMain, deps) {
  const { getDb, run, yearOf } = deps;

  ipcMain.handle('kdbf:report', (e, year) =>
    run(() => {
      const db = getDb();
      const y = year || yearOf();
      const part1 = db.prepare(`
        SELECT a.*, (SELECT COUNT(*) FROM books b WHERE b.acquisition_id=a.id) AS registered_count,
               (SELECT COALESCE(SUM(price),0) FROM books b WHERE b.acquisition_id=a.id) AS registered_value,
               (SELECT MIN(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS inv_from,
               (SELECT MAX(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS inv_to
        FROM acquisitions a WHERE a.year = ? ORDER BY a.no
      `).all(y);
      const part3 = db.prepare(`
        SELECT d.*, (SELECT COUNT(*) FROM deaccession_items i WHERE i.act_id=d.id) AS item_count,
               (SELECT COALESCE(SUM(price),0) FROM deaccession_items i WHERE i.act_id=d.id) AS item_value
        FROM deaccession_acts d WHERE d.year = ? ORDER BY d.no
      `).all(y);
      const end = y + '-12-31';
      const stockAt = (d) => db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS v FROM books
        WHERE register_date <= ? AND (deaccession_date IS NULL OR deaccession_date > ?)
      `).get(d, d);
      const stockEnd = stockAt(end);
      const acquiredYear = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS v FROM books WHERE substr(register_date,1,4) = ?`).get(y);
      const deaccYear = db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(i.price),0) AS v FROM deaccession_items i
        JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
      `).get(y);
      return { part1, part3, stockEnd, acquiredYear, deaccYear, year: y };
    })
  );
};
