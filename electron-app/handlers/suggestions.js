// Предложения за покупка от читатели (Koha: suggestions) — извадени от
// main.js в отделен модул (Фаза 4, стъпка 19). Поток: заявено → одобрено →
// поръчано → получено/отказано. При „получено" може да се закачи към
// партида в Постъпления, за да остане следа откъде реално е дошла книгата.
module.exports = function registerSuggestionsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  const SUGGESTION_STATUSES = ['заявено', 'одобрено', 'поръчано', 'получено', 'отказано'];

  ipcMain.handle('suggestions:list', (e, status) =>
    run(() => {
      const db = getDb();
      const sql = `SELECT s.*, r.name AS reader_name_live, a.no AS acq_no, a.year AS acq_year
        FROM suggestions s LEFT JOIN readers r ON r.id = s.reader_id
        LEFT JOIN acquisitions a ON a.id = s.acquisition_id`;
      const rows = status ? db.prepare(sql + ' WHERE s.status = ? ORDER BY s.date DESC').all(status)
                           : db.prepare(sql + ' ORDER BY s.date DESC').all();
      rows.forEach(r => { if (r.reader_name_live) r.reader_name = r.reader_name_live; });
      return rows;
    })
  );
  ipcMain.handle('suggestions:create', (e, sug) =>
    run(() => {
      if (!(sug.title || '').trim()) throw new Error('Заглавието е задължително.');
      const info = getDb().prepare(`
        INSERT INTO suggestions (date, reader_id, reader_name, author, title, note, status)
        VALUES (?, ?, ?, ?, ?, ?, 'заявено')
      `).run(sug.date || today(), sug.reader_id || null, sug.reader_name || null, sug.author || null, sug.title.trim(), sug.note || null);
      logAudit('Предложение за покупка', sug.title);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('suggestions:setStatus', (e, { id, status, acquisition_id }) =>
    run(() => {
      const db = getDb();
      if (!SUGGESTION_STATUSES.includes(status)) throw new Error('Непознато състояние.');
      const s = db.prepare('SELECT title FROM suggestions WHERE id = ?').get(id);
      if (!s) throw new Error('Предложението вече не съществува — вероятно е изтрито от друго работно място.');
      db.prepare('UPDATE suggestions SET status = ?, acquisition_id = ? WHERE id = ?')
        .run(status, status === 'получено' ? (acquisition_id || null) : null, id);
      logAudit('Предложение за покупка', s.title + ' → ' + status);
    })
  );
  ipcMain.handle('suggestions:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT title FROM suggestions WHERE id = ?').get(id);
      if (!s) throw new Error('Предложението не е намерено.');
      db.prepare('DELETE FROM suggestions WHERE id = ?').run(id);
      logAudit('Изтрито предложение за покупка', s.title || ('№ ' + id));
    })
  );
};
