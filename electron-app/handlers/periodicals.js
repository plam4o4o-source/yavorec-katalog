// Периодика — извадени от main.js в отделен модул (Фаза 4, стъпка 26).
// Зависи само от getDb, run, logAudit, today. countOverduePeriodicals се връща
// обратно към main.js, за да го подаде на handlers/dashboard.js — виж коментара
// там (Koha: serials — prediction pattern, силно облекчен за мащаба на една
// читалищна библиотека: само следващата очаквана дата, без пълен календар от
// предвидени броеве и без рекламации).
const { isValidIsoDate } = require('../security-utils');

module.exports = function registerPeriodicalsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  /* Одит v2.4.29: създаването нормализираше празните полета до NULL, а редакцията
     подаваше формата сурова — издание с периодичност „—“ (freq = NULL) не можеше
     да се редактира изобщо: селектът праща '', тригерът за номенклатурата го отказва
     („Непозната стойност за periodicals.freq“) дори при поправка само на заглавието.
     Един и същ вид запис по двата пътя. */
  function periodicalPayload(p) {
    const title = String(p.title || '').trim();
    if (!title) throw new Error('Заглавието на изданието е задължително.');
    const nz = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
    return { title, freq: nz(p.freq), publisher: nz(p.publisher), issn: nz(p.issn), department: nz(p.department), note: nz(p.note) };
  }

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
      const row = periodicalPayload(p);
      const info = getDb().prepare(`
        INSERT INTO periodicals (title, freq, publisher, issn, department, note)
        VALUES (@title, @freq, @publisher, @issn, @department, @note)
      `).run(row);
      logAudit('Ново периодично издание', row.title);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('periodicals:update', (e, p) =>
    run(() => {
      const row = periodicalPayload(p);
      const upd = getDb().prepare(`
        UPDATE periodicals SET title=@title, freq=@freq, publisher=@publisher, issn=@issn, department=@department, note=@note
        WHERE id=@id
      `).run({ ...row, id: p.id });
      if (!upd.changes) throw new Error('Изданието не е намерено — вероятно е изтрито от друго работно място.');
      logAudit('Редакция на периодично издание', row.title);
    })
  );
  ipcMain.handle('periodicals:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const cnt = db.prepare('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ?').get(id).n;
      if (cnt > 0) throw new Error('Изданието има вписани броеве и не може да бъде изтрито.');
      /* Второто дете на изданието — аналитичните описания (одит v2.4.24). Там
         връзката е ON DELETE SET NULL (db/schema.sql), а не CASCADE, тоест
         изтриването не се проваля: то тихо ЗАЛИЧАВА ИЗТОЧНИКА на всяка статия.
         Читалище, което описва статии от вестник, без да води самия вестник брой
         по брой, има празен кардекс — проверката по-горе минава — и след един клик
         всичките му краеведски описания печатат източник „—“, безвъзвратно.
         Изтриването се и вписва в следата: това е последният от трите пътя тук,
         който мълчеше, докато създаването и редакцията вписват. */
      const anl = db.prepare('SELECT COUNT(*) AS n FROM analytics WHERE periodical_id = ?').get(id).n;
      if (anl > 0) {
        throw new Error('Към изданието има ' + anl + (anl === 1 ? ' аналитично описание' : ' аналитични описания')
          + ' и то не може да бъде изтрито — източникът им ще изчезне. Първо пренасочете или изтрийте статиите.');
      }
      const p0 = db.prepare('SELECT title FROM periodicals WHERE id = ?').get(id);
      if (!p0) throw new Error('Изданието не е намерено.');
      db.transaction(() => {
        db.prepare('DELETE FROM periodicals WHERE id = ?').run(id);
        // Краеведските връзки към изданието (v2.4.29) — иначе „Персоналии“/„Летопис“
        // показват „(изтрит запис)“ и броят мъртви връзки.
        db.prepare("DELETE FROM links WHERE (from_kind = 'периодика' AND from_id = ?) OR (to_kind = 'периодика' AND to_id = ?)").run(id, id);
      })();
      logAudit('Изтрито периодично издание', p0.title);
    })
  );
  ipcMain.handle('periodicalIssues:add', (e, issue) =>
    run(() => {
      /* Одит v2.4.29: без проверки „2026-02-30“ влизаше както е — а прогнозата за
         следващия брой взима MAX(date), date() на невалидна дата е NULL и
         предупреждението „закъснял брой“ угасваше мълчаливо за това издание;
         празен № на брой и цена „abc“ (NaN → NULL) също минаваха. */
      const db = getDb();
      const issueNo = String(issue.issue_no || '').trim();
      if (!issueNo) throw new Error('Номерът на броя е задължителен.');
      const date = issue.date || today();
      if (!isValidIsoDate(date)) throw new Error('Датата на броя (' + issue.date + ') е невалидна.');
      const price = issue.price == null || String(issue.price).trim() === '' ? 0 : Number(String(issue.price).replace(',', '.'));
      if (!Number.isFinite(price) || price < 0) throw new Error('Цената на броя трябва да е число (лв.).');
      const per = db.prepare('SELECT title FROM periodicals WHERE id = ?').get(issue.periodical_id);
      if (!per) throw new Error('Изданието не е намерено.');
      const info = db.prepare(`
        INSERT INTO periodical_issues (periodical_id, issue_no, date, price, note)
        VALUES (@periodical_id, @issue_no, @date, @price, @note)
      `).run({ periodical_id: issue.periodical_id, issue_no: issueNo, date, price, note: issue.note || null });
      logAudit('Постъпил брой', per.title + ' — бр. ' + issueNo);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('periodicalIssues:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const row = db.prepare(`SELECT i.issue_no, i.date, p.title FROM periodical_issues i
        LEFT JOIN periodicals p ON p.id = i.periodical_id WHERE i.id = ?`).get(id);
      if (!row) throw new Error('Броят вече не съществува — вероятно е изтрит от друго работно място.');
      db.prepare('DELETE FROM periodical_issues WHERE id = ?').run(id);
      logAudit('Изтрит брой', (row.title || '') + ' — бр. ' + row.issue_no + ' от ' + row.date);
    })
  );

  return { countOverduePeriodicals };
};
