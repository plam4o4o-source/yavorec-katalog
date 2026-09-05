// Справки и статистика + Готови справки — извадени от main.js в отделен
// модул (Фаза 4, стъпка 29). Koha предлага споделена библиотека от стотици
// готови отчети; тукашният аналог (reports:run) е малък и фиксиран набор от
// справки, всяка от които съответства на нещо, което читалищна библиотека
// реално подава към регионалната библиотека/Министерството на културата.
// Зависи от value/dnevnikSumRow (стабилни function declarations в main.js,
// hoisted — dnevnikSumRow е от все още неизвадения домейн "Дневник на
// библиотеката") и getDb/run/yearOf.
const { ANON_READER_NAME } = require('../security-utils');

module.exports = function registerStatsHandlers(ipcMain, deps) {
  const { getDb, run, yearOf, value, dnevnikSumRow } = deps;

  ipcMain.handle('stats:report', (e, year) =>
    run(() => {
      const db = getDb();
      const y = year || yearOf();
      const end = y + '-12-31';
      /* Всеки ред носи и бройката си екземпляри (`qty`), защото отчетът брои
         БИБЛИОТЕЧНИ ДОКУМЕНТИ, не заглавия — виж дългата бележка при QTY в
         handlers/kdbf.js. COALESCE(...,1): ред без запис в inventory (стара или
         внесена база) е поне един документ. */
      /* v2.4.31 (производителност): дотук фондът се теглеше като 15 000 реда `b.*`
         (измерено 182 ms), само за да бъдат събрани в JavaScript. Същите сборове —
         брой, стойност и разбивки по език/отдел — се смятат от SQLite за ~25 ms.
         Формулите са същите: COALESCE(quantity, 1) е един документ при липсващ
         ред в inventory, изрична нула си остава нула. */
      const FUND_WHERE = '+b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)';
      const fundAgg = db.prepare(`
        SELECT COALESCE(SUM(COALESCE(i.quantity, 1)), 0) AS n,
               COALESCE(SUM(COALESCE(b.price, 0) * COALESCE(i.quantity, 1)), 0) AS v
        FROM books b LEFT JOIN inventory i ON i.book_id = b.id WHERE ${FUND_WHERE}
      `).get(end, end);
      const fundGroups = (field) => db.prepare(`
        SELECT COALESCE(NULLIF(b.${field}, ''), '—') AS k, COALESCE(SUM(COALESCE(i.quantity, 1)), 0) AS n
        FROM books b LEFT JOIN inventory i ON i.book_id = b.id WHERE ${FUND_WHERE}
        GROUP BY k ORDER BY n DESC, k
      `).all(end, end).map(r => [r.k, r.n]);
      const acquiredAgg = db.prepare(`
        SELECT COALESCE(SUM(COALESCE(i.quantity, 1)), 0) AS n,
               COALESCE(SUM(COALESCE(b.price, 0) * COALESCE(i.quantity, 1)), 0) AS v
        FROM books b LEFT JOIN inventory i ON i.book_id = b.id
        WHERE b.register_date BETWEEN ? AND ?
      `).get(y + '-01-01', end);
      // Снимката в самия акт, не живото inventory — виж бележката в handlers/kdbf.js.
      const deaccessioned = db.prepare(`
        SELECT i.*, COALESCE(i.quantity, 1) AS qty FROM deaccession_items i
        JOIN deaccession_acts d ON d.id = i.act_id
        WHERE d.year = ?
      `).all(y);
      /* Локални заместители на споделените value()/COUNT: претеглят по бройки.
         Споделеният value() в main.js нарочно НЕ се пипа — ползва се и от места,
         които наистина броят редове (напр. липсите при инвентаризация). */
      /* `qty == null ? 1 : Number(qty)`, а НЕ `Number(qty) || 1`: второто превръща
         изричната нула в единица и тогава JS страната (fundCount) и SQL страната
         (fundByCategory) дават различни числа в един и същи отговор. Липсващият
         ред в inventory е 1 документ; изрично въведени 0 бройки са 0. */
      const qtyOf = (r) => (r.qty == null ? 1 : Number(r.qty) || 0);
      const copies = (rows) => rows.reduce((s, r) => s + qtyOf(r), 0);
      const valueCopies = (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0) * qtyOf(r), 0);
      // BETWEEN вместо substr(…,1,4) — ползва idx_loans_date_out (v2.4.31).
      const loansYearCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_out BETWEEN ? AND ?').get(y + '-01-01', end).n;
      /* Върнатите ПРЕЗ тази година — независимо кога са заети (виж returnedOnTime).
         `deaccession_act_id IS NULL` е задължително: актът за отчисляване затваря
         откритите заемания на отчислената книга с датата на акта
         (handlers/deaccession-acts.js), за да не увисне бройката. Тези заемания
         обаче НЕ са връщания — книгата никога не се е върнала, отписана е тъкмо
         защото е изгубена. Без филтъра всяко такова заемане влиза в
         `returnedLate` и сваля показателя „спазени срокове“ без причина. */
      /* Едно минаване по върнатите през годината (idx_loans_open): в срок / със
         забава / начислени обезщетения. finesCharged брои и затворените от акт
         (както досега — сумата им е начислена при затварянето). */
      const returned = db.prepare(`
        SELECT SUM(CASE WHEN deaccession_act_id IS NULL AND date_due IS NOT NULL AND date_in <= date_due THEN 1 ELSE 0 END) AS onTime,
               SUM(CASE WHEN deaccession_act_id IS NULL AND date_due IS NOT NULL AND date_in > date_due THEN 1 ELSE 0 END) AS late,
               COALESCE(SUM(fine), 0) AS finesCharged
        FROM loans WHERE date_in BETWEEN ? AND ?
      `).get(y + '-01-01', end);
      /* Служебният запис на GDPR се вписва с ДНЕШНА дата на регистрация и без
         него годишните броячи го включват в „нови читатели“ — виж бележката при
         ANON_READER_NAME в security-utils.js. */
      const readersYearCount = db.prepare(`
        SELECT COUNT(*) AS n FROM readers WHERE (substr(registered_at,1,4) = ? OR substr(re_registered_at,1,4) = ?)
          AND name != ?
      `).get(y, y, ANON_READER_NAME).n;
      const visitsYear = db.prepare(`SELECT COALESCE(SUM(count),0) AS n FROM visits WHERE substr(date,1,4) = ?`).get(y).n;
      /* Разбивките („Фонд по езици“, „по отдели“) също броят екземпляри, за да
         се събират до fundCount — иначе лентите щяха да сочат едно, а показателят
         над тях — друго. Редовете, които нямат `qty` (напр. читатели), се броят по
         едно, както преди. */
      // „Най-търсени документи“ стои в справка за отчетен период 01.01–31.12, а
      // дотук се броеше за ЦЯЛАТА история на базата — заглавие, търсено само през
      // 2019 г., излизаше начело в отчета за 2026 г. Филтрира се по годината на
      // заемане, както всичко останало в тази справка.
      // Първо по екземпляр (цяло число, idx_loans_date_out), после по заглавие — по-евтино от групиране по текст върху всички заемания.
      const topLoans = db.prepare(`
        SELECT b.title, COALESCE(b.author, '') AS author, SUM(l.n) AS n
        FROM (SELECT book_id, COUNT(*) AS n FROM loans WHERE date_out BETWEEN ? AND ? GROUP BY book_id) l
        JOIN books b ON b.id = l.book_id
        GROUP BY b.title, COALESCE(b.author, '') ORDER BY n DESC, b.title LIMIT 10
      `).all(y + '-01-01', end);
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
      const finesCharged = returned.finesCharged;
      /* Начислено по ОЩЕ НЕВЪРНАТИ заемания (v2.4.24). От този кръг loans:extend
         начислява при продължение на просрочено заемане, тоест сумата стои върху
         отворен ред, а finesCharged по построение брои затворените (годината се
         взима от date_in — датата на връщане). Такова начисление нямаше как да се
         види никъде: показва се отделно, вместо да се приписва на година, за която
         базата не пази дата на начисляване. Числото е КЪМ ДНЕС, не за годината —
         затова и се връща само за текущата година. */
      const finesOpen = String(y) === String(new Date().getFullYear())
        ? db.prepare('SELECT COALESCE(SUM(fine), 0) AS val FROM loans WHERE date_in IS NULL').get().val
        : 0;
      /* Одит v2.4.29: „Спазване на сроковете“ броеше само ВЪРНАТИТЕ — библиотека с
         десетки книги, просрочени от месеци, четеше „100 % в срок“, докато „Просрочени“
         на таблото ги брои. Просрочените в момента са КЪМ ДНЕС (както finesOpen), затова
         се връщат само за текущата година, и се показват отделно от процента. */
      const openOverdue = String(y) === String(new Date().getFullYear())
        ? db.prepare(`SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')`).get().n
        : 0;
      const fundByCategory = db.prepare(`
        SELECT COALESCE(c.name,'—') AS k,
               COALESCE(SUM(COALESCE(i.quantity, 1)),0) AS n
        FROM books b
        LEFT JOIN categories c ON c.id=b.category_id
        LEFT JOIN inventory i ON i.book_id = b.id
        WHERE +b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)
        GROUP BY k ORDER BY n DESC
      `).all(end, end).map(r => [r.k, r.n]);
      return {
        year: y,
        fundCount: fundAgg.n, fundValue: fundAgg.v,
        acquiredCount: acquiredAgg.n, acquiredValue: acquiredAgg.v,
        deaccessionedCount: copies(deaccessioned), deaccessionedValue: valueCopies(deaccessioned),
        loansCount: loansYearCount,
        readersCount: readersYearCount,
        /* Посещенията са показател по БДС ISO 2789 и се вписват в „Статистика →
           Посещения“. Дотук стоеше `visitsYear || loansYear.length` — при невписани
           посещения отчетът тихо показваше БРОЯ ЗАЕМАНИЯ на тяхно място. Числото не
           е дори приблизително: читател, взел три книги наведнъж, е едно посещение,
           не три. Нищо на екрана не подсказваше, че стойността е подменена, а
           отчетът отива към регионалната библиотека. Сега се връща действителната
           стойност, а `visitsRecorded` казва дали изобщо са вписвани, за да може
           изгледът да покаже „не са вписвани“ вместо подведено число. */
        visits: visitsYear,
        visitsRecorded: visitsYear > 0,
        /* „Спазване на сроковете" се брои по годината на ВРЪЩАНЕ, не на заемане —
           същата поправка като при глобите (finesCharged) в v2.2.0. Книга, заета
           през декември и върната със забава през февруари, е събитие от новата
           година: показателят за миналата вече е отпечатан в годишния отчет и не
           бива да се променя със задна дата. Дотогава `loansYear` (филтриран по
           date_out) означаваше точно това. */
        returnedOnTime: returned.onTime || 0,
        returnedLate: returned.late || 0,
        finesCollected, finesCharged, finesOpen, openOverdue,
        fundByLanguage: fundGroups('language'),
        fundByDepartment: fundGroups('department'),
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
        // Същото броене по екземпляри като в stats:report — двете справки показват
        // едно и също число за фонда и не бива да се разминават.
        // v2.4.31: сборовете в SQL (виж stats:report) — без 15 000 реда `b.*` в паметта.
        const FUND_WHERE = '+b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)';
        const agg = db.prepare(`
          SELECT COALESCE(SUM(COALESCE(i.quantity, 1)), 0) AS n,
                 COALESCE(SUM(COALESCE(b.price, 0) * COALESCE(i.quantity, 1)), 0) AS v
          FROM books b LEFT JOIN inventory i ON i.book_id = b.id WHERE ${FUND_WHERE}
        `).get(end, end);
        const byGroup = (field) => db.prepare(`
          SELECT COALESCE(NULLIF(b.${field}, ''), '—') AS k, COALESCE(SUM(COALESCE(i.quantity, 1)), 0) AS n
          FROM books b LEFT JOIN inventory i ON i.book_id = b.id WHERE ${FUND_WHERE}
          GROUP BY k ORDER BY n DESC, k
        `).all(end, end).map(r => [r.k, r.n]);
        const byCategory = db.prepare(`
          SELECT COALESCE(c.name,'—') AS k, COALESCE(SUM(COALESCE(i.quantity, 1)),0) AS n
          FROM books b
          LEFT JOIN categories c ON c.id=b.category_id
          LEFT JOIN inventory i ON i.book_id = b.id
          WHERE +b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)
          GROUP BY k ORDER BY n DESC
        `).all(end, end).map(r => [r.k, r.n]);
        return {
          id, year: y,
          fundCount: agg.n, fundValue: agg.v,
          byDepartment: byGroup('department'), byLanguage: byGroup('language'), byCategory
        };
      }
      if (id === 'readers_by_category') {
        /* Снимка КЪМ КРАЯ НА ИЗБРАНАТА ГОДИНА (одит v2.4.24). Справката е обявена с
           needsYear и се печата със заглавие „… — 2024“ и подписи, но и таблицата, и
           общият брой се четяха НАЖИВО: препечатана през 2026 г. справка за 2024 г.
           показваше 312 читатели под заглавие „2024“, където истината е 180. Съседната
           справка (fund_breakdown) отдавна се води „към 31.12.Y“. */
        const asOf = y + '-12-31';
        /* Границата е ДАТАТА НА РЕГИСТРАЦИЯ, не пререгистрацията (преглед на
           поправките от този кръг). re_registered_at е ГОДИШНАТА пререгистрация —
           тоест носи скорошна дата точно за читателите, които СА били активни през
           стара година; COALESCE(re_registered_at, registered_at) <= 31.12.2024
           изхвърляше именно тях и справката за 2024 г. отчиташе 1 вместо 3. Ред без
           дата на регистрация (внесена стара база) се БРОИ, вместо да отпада тихо.
           Състоянието „прекратен“ се чете живо: програмата не пази история на
           състоянията, затова числото е „регистрирани до 31.12.Y, активни днес“ —
           и екранът и разпечатката го казват точно така, вместо да обещават снимка,
           каквато базата не може да даде. */
        const byCategory = db.prepare(`
          SELECT COALESCE(category,'—') AS k, COUNT(*) AS n FROM readers
          WHERE status != 'прекратен' AND name != ?
            AND (registered_at IS NULL OR registered_at = '' OR registered_at <= ?)
          GROUP BY k ORDER BY n DESC
        `).all(ANON_READER_NAME, asOf).map(r => [r.k, r.n]);
        /* Читателите БЕЗ вписана дата на регистрация (внесена стара база) се броят
           — иначе цял внесен фонд от читатели изчезва от справката — но се и
           ОБЯВЯВАТ, защото за тях годината не значи нищо: същите 180 души излизат
           под заглавие 2019, 2020 и 2021. Същият подход като „undated“ в КДБФ. */
        const undated = db.prepare(`SELECT COUNT(*) AS n FROM readers
          WHERE status != 'прекратен' AND name != ? AND (registered_at IS NULL OR registered_at = '')`)
          .get(ANON_READER_NAME).n;
        const total = byCategory.reduce((s, [, n]) => s + n, 0);
        /* Същият филтър за състояние като при общия брой — иначе „новорегистрирани
           през Y“ надхвърляше „активни читатели“ и справката излизаше аритметично
           невъзможна (20 нови срещу 12 активни). */
        const newThisYear = db.prepare(`SELECT COUNT(*) AS n FROM readers
          WHERE substr(registered_at,1,4) = ? AND name != ? AND status != 'прекратен'`).get(y, ANON_READER_NAME).n;
        return { id, year: y, total, byCategory, newThisYear, asOf, undated };
      }
      if (id === 'fund_movement') {
        /* Стойността пада обратно към ВПИСАНАТА, когато документът не обявява
           стойност (одит v2.4.24). acquisitions.sum е нарочно nullable — NULL значи
           „стойност не е обявена в първичния документ“, а самият формуляр подканя да
           се остави празно. SUM() прескача NULL, тоест дарение от 30 книги по 8 лв.
           се отпечатваше като „30 бр., 0,00 лв.“ — в справка, чиято подсказка твърди,
           че чете „както Част № 1 на КДБФ“, а Част № 1 печата точно вписаната
           стойност (registered_value в handlers/kdbf.js), не a.sum. */
        const acquired = db.prepare(`
          SELECT COALESCE(a.how,'—') AS k, COUNT(*) AS n, COALESCE(SUM(a.total_count),0) AS cnt,
                 COALESCE(SUM(COALESCE(a.sum, (
                   SELECT COALESCE(SUM(b.price * COALESCE(i.quantity, 1)), 0)
                   FROM books b LEFT JOIN inventory i ON i.book_id = b.id
                   WHERE b.acquisition_id = a.id
                 ))), 0) AS val
          FROM acquisitions a WHERE a.year = ? GROUP BY k ORDER BY cnt DESC
        `).all(y);
        // Бройки, за да се събира до deaccessionedCount в stats:report — двете
        // числа влизат в един и същи годишен отчет.
        const deaccessioned = db.prepare(`
          SELECT COALESCE(d.reason_text,'—') AS k,
                 COALESCE(SUM(COALESCE(i.quantity,1)),0) AS cnt,
                 COALESCE(SUM(i.price * COALESCE(i.quantity,1)),0) AS val
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
