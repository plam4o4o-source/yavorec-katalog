// Краеведски модул: Аналитично описание (статии и части от книги) —
// извадено от main.js в отделен модул (Фаза 4, стъпка 31). Зависи само от
// getDb, run, logAudit — никакви споделени функции с другите краеведски
// подмодули (persons/chronicle/local-photo/links), само общи таблици.
module.exports = function registerAnalyticsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  const ANALYTIC_FIELDS = ['title', 'subtitle', 'author', 'source_kind', 'periodical_id', 'book_id',
    'source_text', 'year', 'issue', 'issue_date', 'pages', 'udk', 'keywords', 'annotation',
    'is_local', 'note'];
  // Източникът се сглобява за показване: или от свързания запис във фонда, или от
  // свободния текст, когато изданието не е налично в библиотеката.
  const ANALYTIC_SELECT = `
    SELECT a.*,
           p.title AS periodical_title,
           b.title AS book_title, b.author AS book_author, b.inv_number AS book_inv
    FROM analytics a
    LEFT JOIN periodicals p ON p.id = a.periodical_id
    LEFT JOIN books b ON b.id = a.book_id
  `;
  function analyticParams(d) {
    const o = {};
    for (const f of ANALYTIC_FIELDS) o[f] = d[f] ?? null;
    o.is_local = d.is_local ? 1 : 0;
    o.periodical_id = d.periodical_id || null;
    o.book_id = d.book_id || null;
    return o;
  }
  ipcMain.handle('analytics:list', (e, { q, year, onlyLocal } = {}) =>
    run(() => {
      const db = getDb();
      const where = [], args = {};
      if (q) {
        where.push(`(a.title LIKE @q OR a.author LIKE @q OR a.keywords LIKE @q OR a.annotation LIKE @q
                     OR a.source_text LIKE @q OR p.title LIKE @q OR b.title LIKE @q)`);
        args.q = '%' + q + '%';
      }
      if (year) { where.push('a.year = @year'); args.year = String(year); }
      if (onlyLocal) where.push('a.is_local = 1');
      const sql = ANALYTIC_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
        ' ORDER BY a.year DESC, a.title';
      return db.prepare(sql).all(args);
    })
  );
  ipcMain.handle('analytics:get', (e, id) =>
    run(() => getDb().prepare(`${ANALYTIC_SELECT} WHERE a.id = ?`).get(id))
  );
  ipcMain.handle('analytics:years', () =>
    run(() => getDb().prepare(`SELECT year, COUNT(*) AS n FROM analytics
      WHERE year IS NOT NULL AND year <> '' GROUP BY year ORDER BY year DESC`).all())
  );
  ipcMain.handle('analytics:create', (e, d) =>
    run(() => {
      const info = getDb().prepare(`INSERT INTO analytics (${ANALYTIC_FIELDS.join(', ')})
        VALUES (${ANALYTIC_FIELDS.map(f => '@' + f).join(', ')})`).run(analyticParams(d));
      logAudit('Аналитично описание', 'нова статия: ' + (d.title || ''));
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('analytics:update', (e, d) =>
    run(() => {
      getDb().prepare(`UPDATE analytics SET ${ANALYTIC_FIELDS.map(f => f + ' = @' + f).join(', ')} WHERE id = @id`)
        .run({ ...analyticParams(d), id: d.id });
      logAudit('Аналитично описание', 'редакция: ' + (d.title || ''));
    })
  );
  ipcMain.handle('analytics:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const a = db.prepare('SELECT title FROM analytics WHERE id = ?').get(id);
      db.transaction(() => {
        db.prepare("DELETE FROM links WHERE to_kind = 'статия' AND to_id = ?").run(id);
        db.prepare('DELETE FROM analytics WHERE id = ?').run(id);
      })();
      logAudit('Аналитично описание', 'изтрита статия: ' + (a ? a.title : id));
    })
  );
};
