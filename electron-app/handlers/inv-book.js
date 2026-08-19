// Инвентарна книга (Приложение № 4 към чл. 16, ал. 1) — извадени от main.js
// в отделен модул (Фаза 4, стъпка 13 от разбиването на монолита на модули
// по домейн). Един-единствен read-only handler, изцяло самостоятелен: не
// ползва BOOK_SELECT/BOOK_FIELDS (свои собствени JOIN-и), само getDb()/run.
module.exports = function registerInvBookHandlers(ipcMain, deps) {
  const { getDb, run } = deps;

  ipcMain.handle('invBook:list', () =>
    run(() => {
      const db = getDb();
      /* Лека проекция (v2.3.1) — както при books:list. Инвентарната книга показва
         точно колоните от Приложение № 4; `b.*` мъкнеше и анотацията, ключовите
         думи и адреса на корицата, които тук не се показват никъде. Измерено при
         15 000 документа: 13,28 МБ товар за 300 изчертани реда.
         Редакцията НЕ ползва този списък — bookForm(id) дърпа целия запис през
         books:get. Ползваните полета са заковани с тест. */
      const rows = db.prepare(`
        SELECT b.id, b.inv_number, b.register_date, b.title, b.author, b.volume,
               b.year, b.price, b.call_number, b.status, b.description,
               c.name AS category_name,
               a.no AS acq_no, a.date AS acq_date,
               d.no AS act_no, d.date AS act_date
        FROM books b
        LEFT JOIN categories c ON c.id = b.category_id
        LEFT JOIN acquisitions a ON a.id = b.acquisition_id
        LEFT JOIN deaccession_acts d ON d.id = b.deaccession_act_id
        ORDER BY b.inv_number
      `).all();
      const checks = db.prepare('SELECT book_id, date FROM inventory_checks ORDER BY date').all();
      const byBook = {};
      checks.forEach(c => { (byBook[c.book_id] = byBook[c.book_id] || []).push(c.date); });
      rows.forEach(r => { r.checks = byBook[r.id] || []; });
      return rows;
    })
  );
};
