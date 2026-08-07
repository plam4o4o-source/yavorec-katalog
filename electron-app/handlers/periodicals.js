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
    'седмично': { days: 7 },
    'двуседмично': { days: 14 },
    'месечно': { months: 1 },
    'тримесечно': { months: 3 },
    'полугодишно': { months: 6 },
    'годишно': { months: 12 }
  };

  /* Прибавя месеци към дата, като ПРИТИСКА резултата към последния ден на
     целевия месец. Иначе SQLite прелива: date('2026-01-31','+1 month') връща
     '2026-03-03', а не 28 февруари — за месечно списание с брой от 31-ви
     февруари просто изчезва от предвиждането и закъснението се отчита с три
     дни закъснение. Проверено в самия SQLite:
       31.01 + 1 месец  → 2026-03-03 (вярно: 2026-02-28)
       31.03 + 1 месец  → 2026-05-01 (вярно: 2026-04-30)
       29.02 + 1 година → 2025-03-01 (вярно: 2025-02-28)
     Затова се взема по-ранната от двете: „наивното“ събиране и последния ден
     на целевия месец. */
  function addMonths(db, dateStr, n) {
    // Датата се подава два пъти с обикновени „?“ — better-sqlite3 не приема
    // повторно ползван номериран параметър (?1) заедно с позиционно подаване.
    return db.prepare(`SELECT MIN(date(?, ?), date(?, 'start of month', ?, '-1 day')) AS d`)
      .get(dateStr, '+' + n + ' months', dateStr, '+' + (n + 1) + ' months').d;
  }

  // p = { freq, last_issue_date }. Връща следващата очаквана дата (или null,
  // ако freq не е предвидим или изданието още няма нито един вписан брой) и
  // броя дни закъснение (0, ако не е закъсняло или не е предвидимо). Датата
  // на „днес“ идва от инжектираното today() (никога date('now') пряко тук),
  // за да е резултатът тестваем с фиксирана дата — виж правилото в
  // docs/ARCHITECTURE.md.
  function periodicalPrediction(p) {
    const iv = FREQ_INTERVAL[p.freq];
    if (!iv || !p.last_issue_date) return { next_expected: null, issue_overdue_days: 0 };
    const db = getDb();
    const expected = iv.days
      ? db.prepare('SELECT date(?, ?) AS d').get(p.last_issue_date, '+' + iv.days + ' days').d
      : addMonths(db, p.last_issue_date, iv.months);
    // Повредена/непразна, но невалидна дата в базата → date() връща NULL; тогава
    // няма предвиждане, вместо да се смята закъснение спрямо нищо.
    if (!expected) return { next_expected: null, issue_overdue_days: 0 };
    const diff = db.prepare('SELECT CAST(julianday(?) - julianday(?) AS INTEGER) AS d').get(today(), expected).d;
    return { next_expected: expected, issue_overdue_days: Math.max(0, diff || 0) };
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
