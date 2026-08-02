// Краеведски модул: Връзки между краеведските записи и фонда — извадено от
// main.js в отделен модул (Фаза 4, стъпка 31). linkLabel() чете направо от
// books/analytics/chronicle/persons/periodicals по getDb() — не са нужни
// препратки към другите вече извадени/неизвадени модули.
module.exports = function registerLinksHandlers(ipcMain, deps) {
  const { getDb, run } = deps;

  const LINK_FROM = ['персона', 'летопис'];
  const LINK_TO = ['книга', 'статия', 'летопис', 'персона', 'периодика'];
  // Описанието на всяка връзка се сглобява от съответната таблица, за да се
  // показва смислен ред, а не само номер.
  function linkLabel(kind, id) {
    const db = getDb();
    if (kind === 'книга') {
      const b = db.prepare('SELECT inv_number, author, title FROM books WHERE id = ?').get(id);
      return b ? `инв. № ${b.inv_number ?? '—'} · ${[b.author, b.title].filter(Boolean).join('. ')}` : '(изтрит запис)';
    }
    if (kind === 'статия') {
      const a = db.prepare('SELECT author, title, year FROM analytics WHERE id = ?').get(id);
      return a ? `${[a.author, a.title].filter(Boolean).join('. ')}${a.year ? ' (' + a.year + ')' : ''}` : '(изтрит запис)';
    }
    if (kind === 'летопис') {
      const c = db.prepare('SELECT year, title FROM chronicle WHERE id = ?').get(id);
      return c ? `${c.year} — ${c.title}` : '(изтрит запис)';
    }
    if (kind === 'персона') {
      const p = db.prepare('SELECT name FROM persons WHERE id = ?').get(id);
      return p ? p.name : '(изтрит запис)';
    }
    if (kind === 'периодика') {
      const p = db.prepare('SELECT title FROM periodicals WHERE id = ?').get(id);
      return p ? p.title : '(изтрит запис)';
    }
    return String(id);
  }
  ipcMain.handle('links:list', (e, { fromKind, fromId }) =>
    run(() => {
      const rows = getDb().prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? ORDER BY to_kind, id')
        .all(fromKind, fromId);
      rows.forEach(r => { r.label = linkLabel(r.to_kind, r.to_id); });
      return rows;
    })
  );
  // Обратната посока: кои персоналии и записи в летописа сочат към даден документ.
  ipcMain.handle('links:backlinks', (e, { toKind, toId }) =>
    run(() => {
      const rows = getDb().prepare('SELECT * FROM links WHERE to_kind = ? AND to_id = ? ORDER BY from_kind, id')
        .all(toKind, toId);
      rows.forEach(r => { r.label = linkLabel(r.from_kind, r.from_id); });
      return rows;
    })
  );
  ipcMain.handle('links:add', (e, { fromKind, fromId, toKind, toId, note }) =>
    run(() => {
      const db = getDb();
      if (!LINK_FROM.includes(fromKind) || !LINK_TO.includes(toKind)) throw new Error('Непозната връзка.');
      if (fromKind === toKind && Number(fromId) === Number(toId)) throw new Error('Записът не може да сочи към себе си.');
      const dup = db.prepare('SELECT id FROM links WHERE from_kind=? AND from_id=? AND to_kind=? AND to_id=?')
        .get(fromKind, fromId, toKind, toId);
      if (dup) throw new Error('Тази връзка вече съществува.');
      db.prepare('INSERT INTO links (from_kind, from_id, to_kind, to_id, note) VALUES (?, ?, ?, ?, ?)')
        .run(fromKind, fromId, toKind, toId, note || null);
    })
  );
  ipcMain.handle('links:delete', (e, id) => run(() => getDb().prepare('DELETE FROM links WHERE id = ?').run(id)));
  // Търсене на записи, към които да се направи връзка.
  ipcMain.handle('links:search', (e, { kind, q }) =>
    run(() => {
      const db = getDb();
      const like = '%' + (q || '') + '%';
      if (kind === 'книга') {
        return db.prepare(`SELECT id, (COALESCE('инв. № ' || inv_number || ' · ', '') ||
          COALESCE(author || '. ', '') || title) AS label FROM books
          WHERE title LIKE ? OR author LIKE ? OR CAST(inv_number AS TEXT) = ? ORDER BY title LIMIT 40`)
          .all(like, like, q || '');
      }
      if (kind === 'статия') {
        return db.prepare(`SELECT id, (COALESCE(author || '. ', '') || title ||
          COALESCE(' (' || year || ')', '')) AS label FROM analytics
          WHERE title LIKE ? OR author LIKE ? ORDER BY year DESC, title LIMIT 40`).all(like, like);
      }
      if (kind === 'летопис') {
        return db.prepare(`SELECT id, (year || ' — ' || title) AS label FROM chronicle
          WHERE title LIKE ? OR body LIKE ? ORDER BY year DESC LIMIT 40`).all(like, like);
      }
      if (kind === 'персона') {
        return db.prepare(`SELECT id, name AS label FROM persons
          WHERE name LIKE ? OR alt_names LIKE ? ORDER BY name LIMIT 40`).all(like, like);
      }
      if (kind === 'периодика') {
        return db.prepare(`SELECT id, title AS label FROM periodicals WHERE title LIKE ? ORDER BY title LIMIT 40`).all(like);
      }
      throw new Error('Непознат вид запис.');
    })
  );
};
