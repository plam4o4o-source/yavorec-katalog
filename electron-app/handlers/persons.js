// Краеведски модул: Персоналии — извадено от main.js в отделен модул
// (Фаза 4, стъпка 31). Зависи само от getDb, run, logAudit.
module.exports = function registerPersonsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  const PERSON_FIELDS = ['name', 'alt_names', 'birth_date', 'birth_place', 'death_date', 'death_place',
    'activity', 'bio', 'awards', 'sources', 'note'];

  ipcMain.handle('persons:list', (e, q) =>
    run(() => {
      // Броят на свързаните материали се показва в списъка, за да личи кои
      // персоналии вече имат подкрепящи документи във фонда.
      const sql = `
        SELECT p.*, (SELECT COUNT(*) FROM links l WHERE l.from_kind = 'персона' AND l.from_id = p.id) AS links
        FROM persons p ${q ? 'WHERE p.name LIKE @q OR p.alt_names LIKE @q OR p.activity LIKE @q OR p.bio LIKE @q' : ''}
        ORDER BY p.name`;
      return getDb().prepare(sql).all(q ? { q: '%' + q + '%' } : {});
    })
  );
  ipcMain.handle('persons:get', (e, id) => run(() => getDb().prepare('SELECT * FROM persons WHERE id = ?').get(id)));
  ipcMain.handle('persons:create', (e, d) =>
    run(() => {
      const o = {}; for (const f of PERSON_FIELDS) o[f] = d[f] ?? null;
      const info = getDb().prepare(`INSERT INTO persons (${PERSON_FIELDS.join(', ')})
        VALUES (${PERSON_FIELDS.map(f => '@' + f).join(', ')})`).run(o);
      logAudit('Персоналии', 'нова персоналия: ' + (d.name || ''));
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('persons:update', (e, d) =>
    run(() => {
      const o = {}; for (const f of PERSON_FIELDS) o[f] = d[f] ?? null;
      getDb().prepare(`UPDATE persons SET ${PERSON_FIELDS.map(f => f + ' = @' + f).join(', ')} WHERE id = @id`)
        .run({ ...o, id: d.id });
      logAudit('Персоналии', 'редакция: ' + (d.name || ''));
    })
  );
  ipcMain.handle('persons:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const p = db.prepare('SELECT name FROM persons WHERE id = ?').get(id);
      db.transaction(() => {
        db.prepare("DELETE FROM links WHERE (from_kind = 'персона' AND from_id = ?) OR (to_kind = 'персона' AND to_id = ?)").run(id, id);
        db.prepare('DELETE FROM persons WHERE id = ?').run(id);
      })();
      logAudit('Персоналии', 'изтрита персоналия: ' + (p ? p.name : id));
    })
  );
};
