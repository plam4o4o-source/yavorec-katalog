// Инвентарна книга (Приложение № 4 към чл. 16, ал. 1) — извадени от main.js
// в отделен модул (Фаза 4, стъпка 13 от разбиването на монолита на модули
// по домейн). Един-единствен read-only handler, изцяло самостоятелен: не
// ползва BOOK_SELECT/BOOK_FIELDS (свои собствени JOIN-и), само getDb()/run.
const { ftsQuery } = require('../search-fts');

module.exports = function registerInvBookHandlers(ipcMain, deps) {
  const { getDb, run } = deps;

  /* invBook:list() — пълният регистър като масив (както досега).
     invBook:list(page) — прозорец (v2.4.31, производителност): { q, offset, limit }
     връща { rows, total, summary }, където summary носи числата за четирите
     показателя над таблицата (вписани, неотчислени екземпляри и стойност,
     отчислени, с отбелязана проверка) по ЦЕЛИЯ регистър, а не по порцията.
     Търсенето е по инв. №, автор, заглавие и сигнатура, както беше в паметта. */
  ipcMain.handle('invBook:list', (e, page) =>
    run(() => {
      const db = getDb();
      if (page && typeof page === 'object') return invBookWindow(db, page);
      /* Лека проекция (v2.3.1) — както при books:list. Инвентарната книга показва
         точно колоните от Приложение № 4; `b.*` мъкнеше и анотацията, ключовите
         думи и адреса на корицата, които тук не се показват никъде. Измерено при
         15 000 документа: 13,28 МБ товар за 300 изчертани реда.
         Редакцията НЕ ползва този списък — bookForm(id) дърпа целия запис през
         books:get. Ползваните полета са заковани с тест. */
      const rows = db.prepare(`
        SELECT b.id, b.inv_number, b.register_date, b.title, b.author, b.volume,
               b.year, b.price, b.call_number, b.status, b.description,
               -- бройки екземпляри: „Налични: N · стойност" под таблицата брои
               -- документи, както навсякъде другаде (виж handlers/kdbf.js)
               COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = b.id), 1) AS quantity,
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

  const INV_BOOK_SELECT = `
    SELECT b.id, b.inv_number, b.register_date, b.title, b.author, b.volume,
           b.year, b.price, b.call_number, b.status, b.description,
           COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = b.id), 1) AS quantity,
           c.name AS category_name,
           a.no AS acq_no, a.date AS acq_date,
           d.no AS act_no, d.date AS act_date
    FROM books b
    LEFT JOIN categories c ON c.id = b.category_id
    LEFT JOIN acquisitions a ON a.id = b.acquisition_id
    LEFT JOIN deaccession_acts d ON d.id = b.deaccession_act_id`;
  function invBookWindow(db, page) {
    const q = String(page.q || '').trim();
    let where = '', params = [];
    if (q) {
      /* Търсенето в паметта сгъваше регистъра и на кирилица (toLowerCase); LIKE на
         SQLite сгъва само латиница, затова автор/заглавие минават и през FTS5
         (unicode61, както в books:list), а LIKE остава за инв. №, сигнатура и
         „съдържа навсякъде“ по автор/заглавие. */
      const like = `%${q}%`;
      where = `WHERE (b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)
        OR CAST(b.inv_number AS TEXT) LIKE ? OR b.author LIKE ? OR b.title LIKE ? OR b.call_number LIKE ?)`;
      params = [ftsQuery(q), like, like, like, like];
    }
    const limit = Math.min(Math.max(parseInt(page.limit, 10) || 300, 1), 2000);
    const offset = Math.max(parseInt(page.offset, 10) || 0, 0);
    const rows = db.prepare(`${INV_BOOK_SELECT} ${where}
      ORDER BY b.inv_number LIMIT ? OFFSET ?`).all(...params, limit, offset);
    if (rows.length) {
      const ids = rows.map(r => r.id);
      const checks = db.prepare(`SELECT book_id, date FROM inventory_checks WHERE book_id IN (${ids.map(() => '?').join(',')}) ORDER BY date`).all(...ids);
      const byBook = {};
      checks.forEach(c => { (byBook[c.book_id] = byBook[c.book_id] || []).push(c.date); });
      rows.forEach(r => { r.checks = byBook[r.id] || []; });
    }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM books b ${where}`).get(...params).n;
    // Показателите над таблицата — по целия регистър (без търсенето), както бяха в изгледа.
    const s = db.prepare(`
      SELECT COUNT(*) AS rows,
             COALESCE(SUM(CASE WHEN b.status != 'отчислен' OR b.status IS NULL THEN COALESCE(i.quantity, 1) ELSE 0 END), 0) AS activeCopies,
             COALESCE(SUM(CASE WHEN b.status != 'отчислен' OR b.status IS NULL THEN COALESCE(b.price, 0) * COALESCE(i.quantity, 1) ELSE 0 END), 0) AS value,
             COALESCE(SUM(CASE WHEN b.status = 'отчислен' THEN 1 ELSE 0 END), 0) AS deacc
      FROM books b LEFT JOIN inventory i ON i.book_id = b.id`).get();
    s.checked = db.prepare('SELECT COUNT(DISTINCT book_id) AS n FROM inventory_checks').get().n;
    return { rows, total, offset, limit, summary: s };
  }
};
