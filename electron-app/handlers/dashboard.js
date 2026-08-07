// Табло — извадени от main.js в отделен модул (Фаза 4, стъпка 23). Чисто
// справочен домейн (2 read-only IPC канала), но чете от почти всяка
// таблица във фонда — затова зависи от LOAN_SELECT (връщано от
// handlers/loans.js), isWorkDay (връщано от handlers/calendar.js),
// pctRequired/yearOf (стабилни функции/консти в main.js), today и
// countOverduePeriodicals (връщано от handlers/periodicals.js, регистриран
// преди Табло именно заради тази зависимост — виж main.js).
// countOverduePeriodicals е undefined-safe (== null проверка по-долу), за да
// не се чупят по-стари/директни извиквания на регистратора без тази зависимост
// (напр. по-стари тестове, извикващи регистратора без нея).
module.exports = function registerDashboardHandlers(ipcMain, deps) {
  const { getDb, run, today, yearOf, pctRequired, isWorkDay, LOAN_SELECT, countOverduePeriodicals } = deps;

  ipcMain.handle('dashboard:stats', () =>
    run(() => {
      const db = getDb();
      return {
        books: db.prepare("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен'").get().n,
        readers: db.prepare("SELECT COUNT(*) AS n FROM readers WHERE status != 'прекратен'").get().n,
        loansOpen: db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n,
        overdue: db.prepare(`
          SELECT COUNT(*) AS n FROM loans
          WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')
        `).get().n
      };
    })
  );
  ipcMain.handle('dashboard:full', () =>
    run(() => {
      const db = getDb();
      const y = yearOf();
      const fund = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS v FROM books WHERE status != 'отчислен'").get();
      const activeReaders = db.prepare("SELECT COUNT(*) AS n FROM readers WHERE status != 'прекратен'").get().n;
      const loansOpen = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n;
      const overdueRows = db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.date_due LIMIT 7`).all();
      const overdueCount = db.prepare(`SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')`).get().n;
      const acquiredYear = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE substr(register_date,1,4) = ?`).get(y).n;
      const deaccessionedYear = db.prepare(`
        SELECT COUNT(*) AS n FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
      `).get(y).n;
      const loansYear = db.prepare(`SELECT COUNT(*) AS n FROM loans WHERE substr(date_out,1,4) = ?`).get(y).n;
      const readersYear = db.prepare(`SELECT COUNT(*) AS n FROM readers WHERE substr(registered_at,1,4) = ? OR substr(re_registered_at,1,4) = ?`).get(y, y).n;
      const active = fund.n;
      const pct = pctRequired(active);
      const target = Math.ceil(active * pct / 100);
      const scannedYear = db.prepare(`
        SELECT COUNT(*) AS n FROM inventory_session_scans sc JOIN inventory_sessions s ON s.id = sc.session_id
        WHERE substr(s.date,1,4) = ?
      `).get(y).n;
      const upcoming = db.prepare(`
        ${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL
        AND l.date_due >= date('now') AND julianday(l.date_due) - julianday('now') <= 3
        ORDER BY l.date_due
      `).all();
      const holdsReady = db.prepare("SELECT COUNT(*) AS n FROM holds WHERE status = 'заделена'").get().n;
      const holdsWaiting = db.prepare("SELECT COUNT(*) AS n FROM holds WHERE status = 'чака'").get().n;
      /* „За днес" — работният списък на библиотекаря (десктоп-аналог на cron задачите
         на Koha): наближаващи падежи, дължими пререгистрации, много дълги просрочия
         (кандидати за „липсваща"), записи за анонимизиране. */
      const reregDue = db.prepare(`
        SELECT COUNT(*) AS n FROM readers
        WHERE status = 'активен' AND name != '— анонимизирани заемания —'
          AND date(COALESCE(re_registered_at, registered_at), '+1 year') <= date('now', '+14 days')
      `).get().n;
      const longOverdue = db.prepare(`
        SELECT COUNT(*) AS n FROM loans
        WHERE date_in IS NULL AND date_due IS NOT NULL AND julianday('now') - julianday(date_due) > 60
      `).get().n;
      const sAnon = db.prepare('SELECT anonymize_years FROM settings WHERE id = 1').get() || {};
      const anonYears = parseInt(sAnon.anonymize_years, 10) || 0;
      let anonCandidates = 0;
      if (anonYears) {
        anonCandidates = db.prepare(`SELECT COUNT(*) AS n FROM loans
          WHERE date_in IS NOT NULL AND date_in < ? AND anon_category IS NULL`)
          .get(`${new Date().getFullYear() - anonYears}-01-01`).n;
      }
      const suspendedNow = db.prepare(`SELECT COUNT(*) AS n FROM readers WHERE suspended_until > date('now')`).get().n;
      /* Читатели, дължащи напомняне ДНЕС — не просто "има просрочие" (това е
         overdueCount по-горе, брой ЗАЕМАНИЯ), а различни ЧИТАТЕЛИ, за които
         няма логнато напомняне (notice_log) от началото на ТЕКУЩОТО им
         просрочие насам. Огледално на r.lastNotice в handlers/notices.js →
         loans:reminders — виж коментара там защо "> oldest_due", не "> today - N". */
      const dueReminders = db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT l.reader_id, MIN(l.date_due) AS oldest_due
          FROM loans l
          WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now')
          GROUP BY l.reader_id
        ) t
        WHERE NOT EXISTS (
          SELECT 1 FROM notice_log nl WHERE nl.reader_id = t.reader_id AND nl.ts >= t.oldest_due
        )
      `).get().n;
      const overduePeriodicals = countOverduePeriodicals == null ? 0 : countOverduePeriodicals();
      const isTodayOpen = isWorkDay(today());
      return {
        fundCount: fund.n, fundValue: fund.v, activeReaders, loansOpen, overdueCount, overdueRows,
        year: y, acquiredYear, deaccessionedYear, loansYear, readersYear,
        inventoryTarget: target, inventoryScannedYear: scannedYear, inventoryPct: pct,
        upcoming, holdsReady, holdsWaiting,
        today: { reregDue, longOverdue, anonCandidates, suspendedNow, isTodayOpen, dueReminders, overduePeriodicals }
      };
    })
  );
};
