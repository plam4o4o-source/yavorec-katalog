// Периодика — извадени от main.js в отделен модул (Фаза 4, стъпка 26).
// Зависи само от getDb, run, logAudit, today.
module.exports = function registerPeriodicalsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  ipcMain.handle('periodicals:list', () =>
    run(() => getDb().prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM periodical_issues i WHERE i.periodical_id = p.id) AS issue_count
      FROM periodicals p ORDER BY p.title
    `).all())
  );
  ipcMain.handle('periodicals:get', (e, id) =>
    run(() => {
      const db = getDb();
      const p = db.prepare('SELECT * FROM periodicals WHERE id = ?').get(id);
      if (!p) return null;
      p.issues = db.prepare('SELECT * FROM periodical_issues WHERE periodical_id = ? ORDER BY date DESC').all(id);
      return p;
    })
  );
  ipcMain.handle('periodicals:create', (e, p) =>
    run(() => {
      const info = getDb().prepare(`
        INSERT INTO periodicals (title, freq, publisher, issn, department, note)
        VALUES (@title, @freq, @publisher, @issn, @department, @note)
      `).run({ title: p.title, freq: p.freq || null, publisher: p.publisher || null, issn: p.issn || null, department: p.department || null, note: p.note || null });
      logAudit('Ново периодично издание', p.title);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('periodicals:update', (e, p) =>
    run(() => {
      getDb().prepare(`
        UPDATE periodicals SET title=@title, freq=@freq, publisher=@publisher, issn=@issn, department=@department, note=@note
        WHERE id=@id
      `).run(p);
      logAudit('Редакция на периодично издание', p.title);
    })
  );
  ipcMain.handle('periodicals:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const cnt = db.prepare('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ?').get(id).n;
      if (cnt > 0) throw new Error('Изданието има вписани броеве и не може да бъде изтрито.');
      db.prepare('DELETE FROM periodicals WHERE id = ?').run(id);
    })
  );
  ipcMain.handle('periodicalIssues:add', (e, issue) =>
    run(() => {
      const info = getDb().prepare(`
        INSERT INTO periodical_issues (periodical_id, issue_no, date, price, note)
        VALUES (@periodical_id, @issue_no, @date, @price, @note)
      `).run({ periodical_id: issue.periodical_id, issue_no: issue.issue_no, date: issue.date || today(), price: issue.price ? parseFloat(issue.price) : 0, note: issue.note || null });
      logAudit('Постъпил брой', 'бр. ' + issue.issue_no);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('periodicalIssues:delete', (e, id) =>
    run(() => getDb().prepare('DELETE FROM periodical_issues WHERE id = ?').run(id))
  );
};
