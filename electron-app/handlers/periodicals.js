// Периодика — извадени от main.js в отделен модул (Фаза 4, стъпка 26).
// Зависи само от getDb, run, logAudit, today. countOverduePeriodicals се връща
// обратно към main.js, за да го подаде на handlers/dashboard.js — виж коментара
// там (Koha: serials — prediction pattern, силно облекчен за мащаба на една
// читалищна библиотека: само следващата очаквана дата, без пълен календар от
// предвидени броеве и без рекламации).
module.exports = function registerPeriodicalsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  // Периодичност → SQLite модификатор на date(), за да се пресметне следващият
  // очакван брой от датата на последния постъпил. Стойностите съвпадат с
  // PER_FREQ в src/views/core.js. „нередовно“ (и всяка непозната стойност,
  // напр. празно поле) умишлено остават без предвиждане — за издание с
  // непостоянна периодичност изчислена „закъснялост“ би била само шум.
  const FREQ_INTERVAL = {
    'седмично': '+7 days',
    'двуседмично': '+14 days',
    'месечно': '+1 month',
    'тримесечно': '+3 months',
    'полугодишно': '+6 months',
    'годишно': '+1 year'
  };

  // p = { freq, last_issue_date }. Връща следващата очаквана дата (или null,
  // ако freq не е предвидим или изданието още няма нито един вписан брой) и
  // броя дни закъснение (0, ако не е закъсняло или не е предвидимо). Датата
  // на „днес“ идва от инжектираното today() (никога date('now') пряко тук),
  // за да е резултатът тестваем с фиксирана дата — виж правилото в
  // docs/ARCHITECTURE.md.
  function periodicalPrediction(p) {
    const mod = FREQ_INTERVAL[p.freq];
    if (!mod || !p.last_issue_date) return { next_expected: null, issue_overdue_days: 0 };
    const db = getDb();
    const expected = db.prepare('SELECT date(?, ?) AS d').get(p.last_issue_date, mod).d;
    const diff = db.prepare('SELECT CAST(julianday(?) - julianday(?) AS INTEGER) AS d').get(today(), expected).d;
    return { next_expected: expected, issue_overdue_days: Math.max(0, diff) };
  }

  // Брой издания, за които е минал повече от очаквания интервал без нов
  // постъпил брой — за таблото ("За днес"). Само предвидимите (freq в
  // FREQ_INTERVAL) с поне един вписан брой участват.
  function countOverduePeriodicals() {
    const rows = getDb().prepare(`
      SELECT p.freq, (SELECT MAX(date) FROM periodical_issues i WHERE i.periodical_id = p.id) AS last_issue_date
      FROM periodicals p WHERE p.freq IS NOT NULL
    `).all();
    let n = 0;
    for (const p of rows) if (periodicalPrediction(p).issue_overdue_days > 0) n++;
    return n;
  }

  ipcMain.handle('periodicals:list', () =>
    run(() => {
      const rows = getDb().prepare(`
        SELECT p.*, (SELECT COUNT(*) FROM periodical_issues i WHERE i.periodical_id = p.id) AS issue_count,
               (SELECT MAX(date) FROM periodical_issues i WHERE i.periodical_id = p.id) AS last_issue_date
        FROM periodicals p ORDER BY p.title
      `).all();
      for (const p of rows) Object.assign(p, periodicalPrediction(p));
      return rows;
    })
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

  return { countOverduePeriodicals };
};
