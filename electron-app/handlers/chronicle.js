// Краеведски модул: Летопис — извадено от main.js в отделен модул
// (Фаза 4, стъпка 31). Зависи само от getDb, run, logAudit.
module.exports = function registerChronicleHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  const CHRONICLE_FIELDS = ['year', 'date', 'title', 'body', 'category', 'participants', 'sources', 'note'];

  ipcMain.handle('chronicle:list', (e, { q, year } = {}) =>
    run(() => {
      const db = getDb();
      const where = [], args = {};
      if (q) { where.push('(c.title LIKE @q OR c.body LIKE @q OR c.participants LIKE @q)'); args.q = '%' + q + '%'; }
      if (year) { where.push('c.year = @year'); args.year = String(year); }
      return db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM links l WHERE l.from_kind = 'летопис' AND l.from_id = c.id) AS links
        FROM chronicle c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY c.year DESC, c.date DESC, c.id DESC`).all(args);
    })
  );
  ipcMain.handle('chronicle:get', (e, id) => run(() => getDb().prepare('SELECT * FROM chronicle WHERE id = ?').get(id)));
  ipcMain.handle('chronicle:years', () =>
    run(() => getDb().prepare(`SELECT year, COUNT(*) AS n FROM chronicle GROUP BY year ORDER BY year DESC`).all())
  );
  ipcMain.handle('chronicle:create', (e, d) =>
    run(() => {
      const o = {}; for (const f of CHRONICLE_FIELDS) o[f] = d[f] ?? null;
      if (!o.year && o.date) o.year = String(o.date).slice(0, 4);
      const info = getDb().prepare(`INSERT INTO chronicle (${CHRONICLE_FIELDS.join(', ')})
        VALUES (${CHRONICLE_FIELDS.map(f => '@' + f).join(', ')})`).run(o);
      logAudit('Летопис', 'нов запис: ' + (d.year || '') + ' — ' + (d.title || ''));
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('chronicle:update', (e, d) =>
    run(() => {
      const o = {}; for (const f of CHRONICLE_FIELDS) o[f] = d[f] ?? null;
      if (!o.year && o.date) o.year = String(o.date).slice(0, 4);
      getDb().prepare(`UPDATE chronicle SET ${CHRONICLE_FIELDS.map(f => f + ' = @' + f).join(', ')} WHERE id = @id`)
        .run({ ...o, id: d.id });
      logAudit('Летопис', 'редакция: ' + (d.title || ''));
    })
  );
  ipcMain.handle('chronicle:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const c = db.prepare('SELECT title FROM chronicle WHERE id = ?').get(id);
      db.transaction(() => {
        db.prepare("DELETE FROM links WHERE (from_kind = 'летопис' AND from_id = ?) OR (to_kind = 'летопис' AND to_id = ?)").run(id, id);
        db.prepare('DELETE FROM chronicle WHERE id = ?').run(id);
      }).immediate();
      logAudit('Летопис', 'изтрит запис: ' + (c ? c.title : id));
    })
  );
};
