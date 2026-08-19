// Справки и статистика + Готови справки — извадени от main.js в отделен
// модул (Фаза 4, стъпка 29). Koha предлага споделена библиотека от стотици
// готови отчети; тукашният аналог (reports:run) е малък и фиксиран набор от
// справки, всяка от които съответства на нещо, което читалищна библиотека
// реално подава към регионалната библиотека/Министерството на културата.
// Зависи от value/dnevnikSumRow (стабилни function declarations в main.js,
// hoisted — dnevnikSumRow е от все още неизвадения домейн "Дневник на
// библиотеката") и getDb/run/yearOf.
module.exports = function registerStatsHandlers(ipcMain, deps) {
  const { getDb, run, yearOf, value, dnevnikSumRow } = deps;

  ipcMain.handle('stats:report', (e, year) =>
    run(() => {
      const db = getDb();
      const y = year || yearOf();
      const end = y + '-12-31';
      const fund = db.prepare(`
        SELECT * FROM books WHERE register_date <= ? AND (deaccession_date IS NULL OR deaccession_date > ?)
      `).all(end, end);
      const acquired = db.prepare(`SELECT * FROM books WHERE substr(register_date,1,4) = ?`).all(y);
      const deaccessioned = db.prepare(`
        SELECT i.* FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
      `).all(y);
      const loansYear = db.prepare(`SELECT * FROM loans WHERE substr(date_out,1,4) = ?`).all(y);
      // Върнатите ПРЕЗ тази година — независимо кога са заети (виж returnedOnTime).
      const returnedYear = db.prepare(`SELECT * FROM loans WHERE date_in IS NOT NULL AND substr(date_in,1,4) = ?`).all(y);
      const readersYear = db.prepare(`
        SELECT * FROM readers WHERE substr(registered_at,1,4) = ? OR substr(re_registered_at,1,4) = ?
      `).all(y, y);
      const visitsYear = db.prepare(`SELECT COALESCE(SUM(count),0) AS n FROM visits WHERE substr(date,1,4) = ?`).get(y).n;
      const byGroup = (rows, field) => {
        const m = {};
        rows.forEach(r => { const k = r[field] || '—'; m[k] = (m[k] || 0) + 1; });
        return Object.entries(m).sort((a, b) => b[1] - a[1]);
      };
      // „Най-търсени документи“ стои в справка за отчетен период 01.01–31.12, а
      // дотук се броеше за ЦЯЛАТА история на базата — заглавие, търсено само през
      // 2019 г., излизаше начело в отчета за 2026 г. Филтрира се по годината на
      // заемане, както всичко останало в тази справка.
      const topLoans = db.prepare(`
        SELECT b.title, COUNT(*) AS n FROM loans l JOIN books b ON b.id = l.book_id
        WHERE substr(l.date_out,1,4) = ?
        GROUP BY l.book_id ORDER BY n DESC LIMIT 10
      `).all(y);
      /* „Събрани обезщетения“ (така пише в интерфейса) сумираше loans.fine —
         НАЧИСЛЕНИ глоби, и то по годината на ЗАЕМАНЕ: глоба за книга, заета през
         декември и върната през февруари, влизаше в миналата година, а пари, които
         никой не е плащал, се водеха „събрани“.
         Реалните пари са в account_lines (единственото място, където се записва
         плащане) — точно както ги смята справката „Приходи от такси“ по-долу.
         Плащанията в програмата не носят вид (account:pay записва type='плащане'),
         затова към обезщетения се отнася платеното до размера на начислените
         обезщетения на същия читател за същата година — предпазливо отчитане,
         което никога не приписва на глобите пари, платени за годишна такса.
         Начисленото не се губи — излиза като finesCharged, вече по годината на
         ВРЪЩАНЕ (тогава се начислява глобата). */
      /* v2.3.0 — предишната сметка (SUM(MIN(платено, начислено)) за годината) беше
         грешна в двете посоки, проверено с изпълнение:
           • читател дължи 12 лв. такса и 2 лв. обезщетение, плаща само таксата →
             отчетът показваше 2,00 лв. „събрани обезщетения", които никой не е плащал
             (p.paid сумира ВСИЧКИ плащания, а плащанията не носят вид);
           • обезщетение, начислено през декември и платено през януари, изчезваше и
             от двете години (вътрешно съединение).
         Плащанията наистина не носят вид, затова се разнасят по начисленията по реда
         на възникването им — както се води всяка сметка: най-старото задължение се
         покрива първо. Така парите попадат в годината, в която реално са платени, и
         никога не се приписват на обезщетение, докато има по-старо задължение. */
      /* В рамките на ЕДИН ДЕН начисленията се подреждат преди плащанията. На гишето
         редът на вписване е произволен — библиотекарят често взима парите и записва
         плащането първо, а начислението веднага след него. При подреждане само по
         `id` тези пари увисваха като „аванс" и не влизаха в отчета. Между различните
         дни редът си остава хронологичен, а вътре в деня — по id. */
      const lines = db.prepare(`
        SELECT reader_id, date, kind, type, amount FROM account_lines
        ORDER BY reader_id, date, (CASE kind WHEN 'начисление' THEN 0 ELSE 1 END), id
      `).all();
      let finesCollected = 0;
      const outstanding = new Map(); // reader_id → [{type, left}] по реда на възникване
      for (const l of lines) {
        const q = outstanding.get(l.reader_id) || [];
        if (l.kind === 'начисление') {
          q.push({ type: l.type || 'друго', left: Number(l.amount) || 0 });
        } else if (l.kind === 'плащане') {
          let money = Math.abs(Number(l.amount) || 0);
          const inYear = String(l.date || '').slice(0, 4) === String(y);
          while (money > 0.0001 && q.length) {
            const head = q[0];
            const used = Math.min(money, head.left);
            if (inYear && head.type === 'обезщетение') finesCollected += used;
            head.left -= used;
            money -= used;
            if (head.left <= 0.0001) q.shift();
          }
          // Надплатеното (аванс) не се приписва на нищо — остава извън отчета.
        }
        outstanding.set(l.reader_id, q);
      }
      finesCollected = Math.round(finesCollected * 100) / 100;
      const finesCharged = db.prepare(`
        SELECT COALESCE(SUM(fine), 0) AS val FROM loans
        WHERE date_in IS NOT NULL AND substr(date_in,1,4) = ?
      `).get(y).val;
      const fundByCategory = db.prepare(`
        SELECT COALESCE(c.name,'—') AS k, COUNT(*) AS n FROM books b LEFT JOIN categories c ON c.id=b.category_id
        WHERE b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)
        GROUP BY k ORDER BY n DESC
      `).all(end, end).map(r => [r.k, r.n]);
      return {
        year: y,
        fundCount: fund.length, fundValue: value(fund),
        acquiredCount: acquired.length, acquiredValue: value(acquired),
        deaccessionedCount: deaccessioned.length, deaccessionedValue: value(deaccessioned),
        loansCount: loansYear.length,
        readersCount: readersYear.length,
        visits: visitsYear || loansYear.length,
        /* „Спазване на сроковете" се брои по годината на ВРЪЩАНЕ, не на заемане —
           същата поправка като при глобите (finesCharged) в v2.2.0. Книга, заета
           през декември и върната със забава през февруари, е събитие от новата
           година: показателят за миналата вече е отпечатан в годишния отчет и не
           бива да се променя със задна дата. Дотогава `loansYear` (филтриран по
           date_out) означаваше точно това. */
        returnedOnTime: returnedYear.filter(l => l.date_due && l.date_in <= l.date_due).length,
        returnedLate: returnedYear.filter(l => l.date_due && l.date_in > l.date_due).length,
        finesCollected, finesCharged,
        fundByLanguage: byGroup(fund, 'language'),
        fundByDepartment: byGroup(fund, 'department'),
        fundByCategory,
        topLoans
      };
    })
  );

  const REPORTS_CATALOG = [
    { id: 'annual_ab', title: 'Годишен статистически отчет — Раздел А и Б', needsYear: true,
      hint: 'Обобщение на дневника на библиотеката за цялата година — по образеца, подаван към регионалната библиотека.' },
    { id: 'fund_breakdown', title: 'Библиотечен фонд по отдели, категории и езици', needsYear: true,
      hint: 'Състояние на фонда към 31.12. на избраната година — таблици вместо диаграми, за прилагане към отчета.' },
    { id: 'readers_by_category', title: 'Читатели по възрастови категории', needsYear: true,
      hint: 'Брой активни читатели по категория и новорегистрирани през годината.' },
    { id: 'fund_movement', title: 'Движение на фонда — постъпления и отчисления', needsYear: true,
      /* Изрично уточнение (v2.3.0): тази справка чете ДЕКЛАРИРАНОТО в партидите
         (acquisitions.total_count / sum) — колона „Общо" на КДБФ Част № 1. КДБФ Част
         № 2 брои реално инвентираните книги. Двете законно се разминават, докато
         партида не е инвентирана докрай, и двете се прилагат към годишния отчет —
         затова разликата трябва да е написана, а не да изглежда като грешка. */
      hint: 'По начин на придобиване/причина за отчисляване, по ДЕКЛАРИРАНОТО в партидите (както Част № 1 на КДБФ). Част № 2 брои реално инвентираните — при неинвентирана докрай партида двете законно се различават.' },
    { id: 'mzs_annual', title: 'Междубиблиотечно заемане (МЗС) — обобщение', needsYear: true,
      hint: 'Брой заявки по посока и състояние през годината.' },
    { id: 'fees_income', title: 'Приходи от такси и обезщетения', needsYear: true,
      hint: 'Начислено и събрано по вид (годишна такса, обезщетения) от читателската сметка през годината.' }
  ];
  ipcMain.handle('reports:list', () => run(() => REPORTS_CATALOG));
  ipcMain.handle('reports:run', (e, { id, year }) =>
    run(() => {
      const db = getDb();
      const y = String(year || yearOf());
      if (id === 'annual_ab') {
        const rows = db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ?').all(`${y}-01-01`, `${y}-12-31`);
        return { id, year: y, totals: dnevnikSumRow(rows), daysRecorded: rows.length };
      }
      if (id === 'fund_breakdown') {
        const end = y + '-12-31';
        const fund = db.prepare(`
          SELECT * FROM books WHERE register_date <= ? AND (deaccession_date IS NULL OR deaccession_date > ?)
        `).all(end, end);
        const byGroup = (rows, field) => {
          const m = {};
          rows.forEach(r => { const k = r[field] || '—'; m[k] = (m[k] || 0) + 1; });
          return Object.entries(m).sort((a, b) => b[1] - a[1]);
        };
        const byCategory = db.prepare(`
          SELECT COALESCE(c.name,'—') AS k, COUNT(*) AS n FROM books b LEFT JOIN categories c ON c.id=b.category_id
          WHERE b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)
          GROUP BY k ORDER BY n DESC
        `).all(end, end).map(r => [r.k, r.n]);
        return {
          id, year: y, fundCount: fund.length, fundValue: value(fund),
          byDepartment: byGroup(fund, 'department'), byLanguage: byGroup(fund, 'language'), byCategory
        };
      }
      if (id === 'readers_by_category') {
        const byCategory = db.prepare(`
          SELECT COALESCE(category,'—') AS k, COUNT(*) AS n FROM readers WHERE status != 'прекратен' GROUP BY k ORDER BY n DESC
        `).all().map(r => [r.k, r.n]);
        const total = byCategory.reduce((s, [, n]) => s + n, 0);
        const newThisYear = db.prepare(`SELECT COUNT(*) AS n FROM readers WHERE substr(registered_at,1,4) = ?`).get(y).n;
        return { id, year: y, total, byCategory, newThisYear };
      }
      if (id === 'fund_movement') {
        const acquired = db.prepare(`
          SELECT COALESCE(how,'—') AS k, COUNT(*) AS n, COALESCE(SUM(total_count),0) AS cnt, COALESCE(SUM(sum),0) AS val
          FROM acquisitions WHERE year = ? GROUP BY k ORDER BY cnt DESC
        `).all(y);
        const deaccessioned = db.prepare(`
          SELECT COALESCE(d.reason_text,'—') AS k, COUNT(*) AS cnt, COALESCE(SUM(i.price),0) AS val
          FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ? GROUP BY k ORDER BY cnt DESC
        `).all(y);
        return {
          id, year: y,
          acquired: acquired.map(r => [r.k, r.cnt, r.val]),
          acquiredTotal: acquired.reduce((s, r) => s + r.cnt, 0),
          acquiredValue: acquired.reduce((s, r) => s + r.val, 0),
          deaccessioned: deaccessioned.map(r => [r.k, r.cnt, r.val]),
          deaccessionedTotal: deaccessioned.reduce((s, r) => s + r.cnt, 0),
          deaccessionedValue: deaccessioned.reduce((s, r) => s + r.val, 0)
        };
      }
      if (id === 'mzs_annual') {
        const byDirection = db.prepare(`
          SELECT direction AS k, COUNT(*) AS n FROM mzs_requests WHERE year = ? GROUP BY direction ORDER BY k
        `).all(y).map(r => [r.k, r.n]);
        const byStatus = db.prepare(`
          SELECT COALESCE(status,'—') AS k, COUNT(*) AS n FROM mzs_requests WHERE year = ? GROUP BY k ORDER BY n DESC
        `).all(y).map(r => [r.k, r.n]);
        const total = byDirection.reduce((s, [, n]) => s + n, 0);
        return { id, year: y, total, byDirection, byStatus };
      }
      if (id === 'fees_income') {
        const charged = db.prepare(`
          SELECT COALESCE(type,'друго') AS k, COUNT(*) AS n, COALESCE(SUM(amount),0) AS val
          FROM account_lines WHERE kind = 'начисление' AND substr(date,1,4) = ? GROUP BY k ORDER BY val DESC
        `).all(y);
        const paid = db.prepare(`
          SELECT COALESCE(SUM(-amount),0) AS val, COUNT(*) AS n FROM account_lines
          WHERE kind = 'плащане' AND substr(date,1,4) = ?
        `).get(y);
        return {
          id, year: y,
          charged: charged.map(r => [r.k, r.n, r.val]),
          chargedTotal: charged.reduce((s, r) => s + r.n, 0),
          chargedValue: charged.reduce((s, r) => s + r.val, 0),
          paidCount: paid.n, paidValue: paid.val
        };
      }
      throw new Error('Непозната справка.');
    })
  );
};
