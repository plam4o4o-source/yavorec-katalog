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
const { ANON_READER_NAME } = require('../security-utils');

module.exports = function registerDashboardHandlers(ipcMain, deps) {
  const { getDb, run, today, yearOf, pctRequired, isWorkDay, LOAN_SELECT, countOverduePeriodicals,
    effectiveDaysLate } = deps;

  // Бройки екземпляри, не заглавия — виж дългата бележка при QTY в handlers/kdbf.js.
  const QTY = "COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = b.id), 1)";
  /* v2.4.31 (производителност): същата бройка през LEFT JOIN — корелираната
     подзаявка се изпълняваше ДВА пъти на ред (в SUM(QTY) и в SUM(price*QTY)),
     30 000 търсения в inventory при 15 000 книги; съединението минава веднъж.
     Измерено: 16,6 ms → ~7 ms за фонда на таблото. */
  const QTYJ = "COALESCE(inv.quantity, 1)";
  const BOOKS_INV = "FROM books b LEFT JOIN inventory inv ON inv.book_id = b.id";

  ipcMain.handle('dashboard:stats', () =>
    run(() => {
      const db = getDb();
      return {
        // Бройки, не заглавия — виж бележката при QTY в handlers/kdbf.js.
        books: db.prepare(`SELECT COALESCE(SUM(${QTY}),0) AS n FROM books b WHERE (b.status != 'отчислен' OR b.status IS NULL)`).get().n,
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
      const fund = db.prepare(
        `SELECT COALESCE(SUM(${QTYJ}),0) AS n, COALESCE(SUM(b.price * ${QTYJ}),0) AS v
         ${BOOKS_INV} WHERE (b.status != 'отчислен' OR b.status IS NULL)`
      ).get();
      const activeReaders = db.prepare("SELECT COUNT(*) AS n FROM readers WHERE status != 'прекратен'").get().n;
      const loansOpen = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n;
      const overdueRows = db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.date_due LIMIT 7`).all();
      /* Дните забава се смятат тук, със същата функция както в „Просрочени" и на
         гишето (v2.3.0). Дотогава таблото ги смяташе в изгледа по сурови календарни
         дни — и след като „Просрочени" мина на ефективните дни, едно и също заемане
         показваше различен брой дни на двата екрана (проверено: 30 срещу 22). */
      overdueRows.forEach(r => {
        r.daysLate = effectiveDaysLate ? effectiveDaysLate(r.date_due, today()) : null;
      });
      const overdueCount = db.prepare(`SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')`).get().n;
      // Бройки, не заглавия — на едно и също табло „Библиотечен фонд" по-горе вече
      // брои документи; ако тези два реда останеха на заглавия, Таблото щеше да си
      // противоречи само със себе си.
      const acquiredYear = db.prepare(
        `SELECT COALESCE(SUM(${QTYJ}),0) AS n ${BOOKS_INV} WHERE b.register_date BETWEEN ? AND ?`
      ).get(y + '-01-01', y + '-12-31').n;
      const deaccessionedYear = db.prepare(`
        SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n
        FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
      `).get(y).n;
      // BETWEEN по idx_loans_date_out вместо substr() — пълно сканиране на 100 000 реда при всяко отваряне на таблото (v2.4.31).
      const loansYear = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_out BETWEEN ? AND ?').get(y + '-01-01', y + '-12-31').n;
      const readersYear = db.prepare(`SELECT COUNT(*) AS n FROM readers
        WHERE (substr(registered_at,1,4) = ? OR substr(re_registered_at,1,4) = ?) AND name != ?`).get(y, y, ANON_READER_NAME).n;
      /* Целта по чл. 40 се смята от ЗАГЛАВИЯТА (редовете), не от бройките — умишлено
         различно от `fund.n` точно над него. Инвентаризацията се проверява чрез
         сканиране, а инвентарният номер в тази схема е един на ред в books; затова
         пулът, който handlers/inventory-sessions.js съставя, също са редове. Ако тук
         се ползваше `fund.n` (вече бройки), Таблото щеше да показва една цел, а
         екранът „Инвентаризация“ — друга. Условието е дословно същото като там,
         включително NULL-безопасната проверка на статуса. */
      const active = db.prepare("SELECT COUNT(*) AS n FROM books WHERE (status != 'отчислен' OR status IS NULL)").get().n;
      const pct = pctRequired(active);
      const target = Math.ceil(active * pct / 100);
      /* COUNT(DISTINCT sc.book_id), не COUNT(*). Одит v2.4.14: нормата по
         чл. 40, т. 2 е дял от ФОНДА, тоест брои различни документи. Един и същ
         документ, сканиран в пролетна и в есенна проверка през една календарна
         година, се броеше два пъти — таблото рапортуваше 200% изпълнение при
         100% неизпълнение. `target` по-горе се смята от броя активни книги,
         тоест другата страна на дробта винаги е броила различни документи. */
      const scannedYear = db.prepare(`
        SELECT COUNT(DISTINCT sc.book_id) AS n FROM inventory_session_scans sc
        JOIN inventory_sessions s ON s.id = sc.session_id
        WHERE substr(s.date,1,4) = ?
      `).get(y).n;
      /* ПРОЗОРЕЦ, а не целият списък (v2.4.52). Дотук тук нямаше лимит — за разлика
         от `overdueRows` точно отгоре, което си има LIMIT 7 — и таблото рисуваше по
         един ред на всяко предстоящо връщане. Измерено при истински фонд със 160
         предстоящи: таблото ставаше 9 830 px високо при екран от 768, тоест над
         девет екрана превъртане, а картата с връщанията сама разтягаше съседките си
         в същия ред. Изгледът показва първите няколко, групирани по ден; общият брой
         идва отделно, за да не лъже нито показателят горе, нито бутонът „Всички“. */
      const UPCOMING_WINDOW = 40;
      const upcomingWhere = `l.date_in IS NULL AND l.date_due IS NOT NULL
        AND l.date_due >= date('now') AND julianday(l.date_due) - julianday('now') <= 3`;
      const upcoming = db.prepare(`
        ${LOAN_SELECT} WHERE ${upcomingWhere} ORDER BY l.date_due LIMIT ${UPCOMING_WINDOW}
      `).all();
      const upcomingCount = db.prepare(`SELECT COUNT(*) AS n FROM loans l WHERE ${upcomingWhere}`).get().n;
      /* Броят ПО ДНИ идва от базата, а не от преброяване на показаните редове:
         прозорецът отрязва списъка, тоест броенето в изгледа би дало „Днес · 40“
         при 154 действителни. Дните са най-много четири (днес + три напред), затова
         това е едно евтино групиране, а не още един списък. */
      const upcomingByDay = db.prepare(`
        SELECT l.date_due AS date, COUNT(*) AS n FROM loans l WHERE ${upcomingWhere}
        GROUP BY l.date_due ORDER BY l.date_due
      `).all();
      /* Просрочията ПО ТЕЖЕСТ. „240 просрочени“ не казва какво да се направи, а
         разликата между три дни и три месеца е разликата между напомняне и акт по
         чл. 30. Броенето е в SQL по същото условие като `overdueCount` — по
         КАЛЕНДАРНИ дни, защото е групиране на едро; точните дни забава (с
         приспаднати затворени дни) стоят на реда във всеки от седемте показани. */
      const overdueBuckets = db.prepare(`
        SELECT
          SUM(CASE WHEN julianday('now') - julianday(date_due) <= 7 THEN 1 ELSE 0 END) AS d7,
          SUM(CASE WHEN julianday('now') - julianday(date_due) > 7
                    AND julianday('now') - julianday(date_due) <= 30 THEN 1 ELSE 0 END) AS d30,
          SUM(CASE WHEN julianday('now') - julianday(date_due) > 30 THEN 1 ELSE 0 END) AS more
        FROM loans WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')
      `).get();
      for (const k of ['d7', 'd30', 'more']) overdueBuckets[k] = overdueBuckets[k] || 0;
      /* Заеманията по седмици за последните 12 седмици — посоката, която едно число
         („400 заети“) не носи. Едно групиране по индекса idx_loans_date_out, а не 12
         отделни заявки; седмица 0 е текущата. Масивът е винаги с дължина 12, с нули
         за седмиците без заемания, за да не се налага изгледът да ги допълва. */
      const weekRows = db.prepare(`
        SELECT CAST((julianday('now') - julianday(date_out)) / 7 AS INTEGER) AS w, COUNT(*) AS n
        FROM loans WHERE date_out >= date('now', '-84 days') AND date_out <= date('now')
        GROUP BY w
      `).all();
      /* Прозорецът е определен на ЕДНО място — в условието на заявката. Тук стоеше и
         втора проверка (`w >= 0 && w < 12`), но при вече отрязани от SQL редове тя не
         може да се задейства: мутационната проверка показа, че премахването ѝ не
         променя нищо. Два предпазителя за едно и също правят и двата непроверими —
         остава този, който освен това пази и от пълно сканиране на таблицата. */
      const loansWeeks = new Array(12).fill(0);
      for (const row of weekRows) loansWeeks[11 - row.w] = row.n;
      const holdsReady = db.prepare("SELECT COUNT(*) AS n FROM holds WHERE status = 'заделена'").get().n;
      const holdsWaiting = db.prepare("SELECT COUNT(*) AS n FROM holds WHERE status = 'чака'").get().n;
      /* „За днес" — работният списък на библиотекаря (десктоп-аналог на cron задачите
         на Koha): наближаващи падежи, дължими пререгистрации, много дълги просрочия
         (кандидати за „липсваща"), записи за анонимизиране. */
      const reregDue = db.prepare(`
        SELECT COUNT(*) AS n FROM readers
        WHERE status = 'активен' AND name != ?
          AND date(COALESCE(re_registered_at, registered_at), '+1 year') <= date('now', '+14 days')
      `).get(ANON_READER_NAME).n;
      const longOverdue = db.prepare(`
        SELECT COUNT(*) AS n FROM loans
        WHERE date_in IS NULL AND date_due IS NOT NULL AND julianday('now') - julianday(date_due) > 60
      `).get().n;
      const sAnon = db.prepare('SELECT anonymize_years FROM settings WHERE id = 1').get() || {};
      const anonYears = parseInt(sAnon.anonymize_years, 10) || 0;
      let anonCandidates = 0;
      if (anonYears) {
        anonCandidates = db.prepare(`SELECT COUNT(*) AS n FROM loans
          WHERE date_in < ? AND anon_category IS NULL`)
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
      /* Попълнен ли е дневникът за днес (v2.4.27, A9): формулярът, който
         регионалната библиотека проверява, беше на четири стъпки от таблото. */
      const dnevnikFilled = !!db.prepare('SELECT 1 FROM dnevnik_days WHERE date = ?').get(today());
      return {
        fundCount: fund.n, fundValue: fund.v, activeReaders, loansOpen, overdueCount, overdueRows,
        overdueBuckets, loansWeeks,
        year: y, acquiredYear, deaccessionedYear, loansYear, readersYear,
        inventoryTarget: target, inventoryScannedYear: scannedYear, inventoryPct: pct,
        upcoming, upcomingCount, upcomingByDay, holdsReady, holdsWaiting,
        today: { reregDue, longOverdue, anonCandidates, suspendedNow, isTodayOpen, dueReminders, overduePeriodicals, dnevnikFilled }
      };
    })
  );
};
