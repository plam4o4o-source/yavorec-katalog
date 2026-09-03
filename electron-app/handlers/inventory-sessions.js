// Инвентаризация — извадени от main.js в отделен модул (Фаза 4, стъпка 24).
// Зависи от pctRequired/naturalLoss (стабилни function declarations в
// main.js, hoisted) и getDb/run/logAudit.
module.exports = function registerInventorySessionsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, pctRequired, naturalLoss, normalizeScanCode } = deps;
  const { parseRegisterNo, resolveScannedBook } = require('../security-utils');

  ipcMain.handle('inventorySessions:list', () =>
    run(() => getDb().prepare(`
      SELECT s.*,
             (SELECT COUNT(*) FROM inventory_session_scans sc WHERE sc.session_id = s.id) AS scanned,
             (SELECT COUNT(*) FROM inventory_session_missing m WHERE m.session_id = s.id) AS missing
      FROM inventory_sessions s ORDER BY s.date DESC
    `).all())
  );
  ipcMain.handle('inventorySessions:requirement', () =>
    run(() => {
      const db = getDb();
      // Одит v2.3.1 №20: `status != 'отчислен'` в SQL дава NULL (не TRUE) за ред с
      // NULL status и SQLite мълчаливо го изключва от WHERE — книга с NULL status
      // (стари/внесени данни, никога прегледани) изчезваше от пула за инвентаризация,
      // докато ЕДНОВРЕМЕННО публичният каталог я броеше за налична (виж #9,
      // main.js: publicBookFields) — пропада през двете предпазни мрежи едновременно.
      // Условието включва изрично и NULL редовете навсякъде тук, където се смята пул.
      /* Мярката е РЕДОВЕ (инвентарни номера), не екземпляри — съзнателно и
         документирано решение, виж дългата бележка в handlers/dashboard.js:
         инвентаризацията се проверява чрез сканиране, а инвентарният номер в тази
         схема е един на ред в books. Двата екрана ТРЯБВА да ползват една и съща
         мярка, иначе Таблото и „Инвентаризация“ показват различни цели.

         Одит v2.4.16 отбеляза, че числото се ПОКАЗВАШЕ с етикет „Библиотечен
         фонд“ — същия, с който Таблото нарича броя екземпляри. Числата са две
         различни неща и не бива да носят едно име; поправено е в етикета
         (src/views/inventory-sessions.js), не в мярката. */
      const active = db.prepare("SELECT COUNT(*) AS n FROM books WHERE (status != 'отчислен' OR status IS NULL)").get().n;
      const s = db.prepare('SELECT free_access_pct FROM settings WHERE id = 1').get();
      const pct = pctRequired(active);
      /* Напредъкът за ГОДИНАТА се смята тук, а не чрез сумиране на сесиите в
         екрана: един и същ документ, проверен в пролетна и в есенна сесия, се
         броеше два пъти и екранът можеше да обяви нормата за изпълнена при
         неизпълнена. Същата поправка вече беше направена за Таблото
         (handlers/dashboard.js), но не и тук — класическото „поправено на едно
         от две места“. */
      const y = String(new Date().getFullYear());
      const scannedYear = db.prepare(`
        SELECT COUNT(DISTINCT sc.book_id) AS n FROM inventory_session_scans sc
        JOIN inventory_sessions s ON s.id = sc.session_id
        WHERE substr(s.date,1,4) = ?
      `).get(y).n;
      return { active, pct, target: Math.ceil(active * pct / 100), scannedYear,
        naturalLoss: naturalLoss(active, s.free_access_pct) };
    })
  );
  ipcMain.handle('inventorySessions:start', (e, s) =>
    run(() => {
      const db = getDb();
      // Одит v2.3.1 №20 — виж бележката в inventorySessions:requirement по-горе.
      const pool = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE (status != 'отчислен' OR status IS NULL) ${s.department ? 'AND department = @department' : ''}`)
        .get(s.department ? { department: s.department } : {});
      /* Номер и година на протокола. Точно както при партидите (acquisitions:create):
         schema.sql няма UNIQUE(year, no) и не може да го получи наготово — съществуващи
         бази може вече да носят дубликати и миграцията би счупила стартирането. Затова
         номерът се ИЗБИРА и се ПРОВЕРЯВА вътре в транзакция с .immediate(): правото на
         запис се взима ПРЕДИ проверката, тоест между нея и INSERT-а никой друг не може
         да вмъкне същия номер.
         Одит v2.4.18 (преглед на поправките от v2.4.17): дотук коментарът тук твърдеше,
         че „проверката се повтаря в записа“, а такава проверка нямаше — нито транзакция.
         Две работни места към обща мрежова база (изрично поддържан режим) получаваха
         един и същ MAX(no)+1 и издаваха ДВА протокола по чл. 40 с номер № N/година;
         ръчно въведен вече зает номер минаваше също така мълчаливо. */
      const year = String(s.date || '').slice(0, 4) || String(new Date().getFullYear());
      /* Празно поле → следващият свободен; въведено число → точно то, проверено.
         Дотук `parseInt(s.no) || MAX+1`: въведена нула пропадаше през || и ставаше
         следващият номер без дума, „-3“ и „1.5“ минаваха. Проверката е ПРЕДИ
         транзакцията — правото на запис не се взима заради невалиден вход. */
      const typed = parseRegisterNo(s.no, 'Протокол №', true);
      const tx = db.transaction(() => {
        const no = typed
          || ((db.prepare('SELECT MAX(no) AS m FROM inventory_sessions WHERE year = ?').get(year).m || 0) + 1);
        if (db.prepare('SELECT 1 FROM inventory_sessions WHERE year = ? AND no = ?').get(year, no)) {
          throw new Error('Протокол № ' + no + '/' + year + ' вече съществува — най-вероятно е създаден от друго '
            + 'работно място към същата база. Затворете и отворете формата отново, за да получите следващия свободен номер.');
        }
        const info = db.prepare(`
          INSERT INTO inventory_sessions (date, scope, department, committee1, committee2, committee3,
                                          pool_size, closed, no, year, order_no)
          VALUES (@date, @scope, @department, @committee1, @committee2, @committee3, @pool_size, 0, @no, @year, @order_no)
        `).run(Object.assign({}, s, {
          department: s.department || null, pool_size: pool.n, no, year, order_no: s.order_no || null
        }));
        return info.lastInsertRowid;
      });
      return tx.immediate();
    })
  );
  ipcMain.handle('inventorySessions:get', (e, id) =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(id);
      if (!s) return null;
      s.scans = db.prepare(`
        SELECT sc.*, b.inv_number, b.title FROM inventory_session_scans sc
        JOIN books b ON b.id = sc.book_id WHERE sc.session_id = ? ORDER BY sc.scanned_at DESC
      `).all(id);
      s.missing = db.prepare('SELECT * FROM inventory_session_missing WHERE session_id = ?').all(id);
      /* Допустимите естествени загуби по чл. 41 се смятат ТУК, за да може протоколът
         да ги отпечата. Одит на документите v2.4.17: приключването ги връщаше,
         прозорецът ги показваше и сравняваше с тях, екранът ги показваше — а
         документът, който излиза от сградата, ги нямаше. Тоест единственият въпрос,
         на който протоколът съществува да отговори (в рамките на допустимото ли са
         липсите), беше неотговорим от хартията. */
      const cfg = db.prepare('SELECT free_access_pct FROM settings WHERE id = 1').get() || {};
      const poolForLoss = s.pool_final != null ? s.pool_final : (s.pool_size || 0);
      s.allowedLoss = naturalLoss(poolForLoss, cfg.free_access_pct);
      return s;
    })
  );
  // normalizeScanCode() (v1.70.1) — виж books:byBarcode в handlers/books.js за
  // обяснението на кирилско/латинско разминаване при баркод четец.
  ipcMain.handle('inventorySessions:scan', (e, { sessionId, code }) =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
      if (!s || s.closed) throw new Error('Няма отворена сесия за инвентаризация.');
      const c = normalizeScanCode(code);
      // Одит v2.4.24 — виж resolveScannedBook() в security-utils.js: иначе
      // протоколът отбелязваше като „проверен" ДРУГ документ, а истинският
      // оставаше в липсите.
      const b = resolveScannedBook(db, c);
      if (!b) throw new Error('Непознат баркод/инв. № ' + code);
      /* Одит v2.4.14: тук се приемаше и ОТЧИСЛЕН документ, за разлика от
         deaccessionActs:findBook, който изрично го изключва. Пулът, спрямо който
         се смята нормата (inventorySessions:start), брои само неотчислените —
         тоест отчислен документ вдигаше числителя, без да е в знаменателя. */
      if (b.status === 'отчислен') {
        throw new Error('Инв. № ' + b.inv_number + ' е отчислен и не е част от фонда, който тази проверка обхваща. '
          + 'Документът не е записан в протокола.');
      }
      /* Одит v2.3.1 №24: сесия, ограничена до един отдел (s.department), тихо
         приемаше сканирания на книги от ДРУГИ отдели — броени като „проверени“ в
         протокола, макар да са извън декларирания обхват/pool_size (последният е
         преброен САМО за отдела при inventorySessions:start). Отказва се изрично,
         вместо да се приема мълчаливо — протоколът пред регионалната библиотека
         трябва да отговаря точно на обявения обхват. */
      if (s.department && (b.department || '') !== s.department) {
        throw new Error('Инв. № ' + b.inv_number + ' е от отдел „' + (b.department || '—') +
          '“, а тази инвентаризация обхваща само отдел „' + s.department + '“. Документът не е записан в протокола.');
      }
      /* Четирите записа минават ЗАЕДНО или никак. Одит v2.4.14: дотук бяха
         четири отделни изявления извън транзакция, докато всички съседни
         handler-и ползват .immediate() — при SQLITE_BUSY по средата (обичайно на
         мрежова база) протоколът и картонът на книгата се разминаваха.
         Уникалният индекс от миграция v8 пази същото и на ниво база: проверката
         „вече е сканиран“ в JavaScript не е достатъчна, когато две станции
         сканират едновременно. */
      const tx = db.transaction(() => {
        const already = db.prepare('SELECT 1 FROM inventory_session_scans WHERE session_id = ? AND book_id = ?').get(sessionId, b.id);
        if (already) throw new Error('Инв. № ' + b.inv_number + ' вече е сканиран.');
        db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(sessionId, b.id);
        db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(b.id, s.date);
        db.prepare("UPDATE books SET datelastseen = datetime('now') WHERE id = ?").run(b.id);
        if (b.status === 'липсващ') db.prepare("UPDATE books SET status='наличен', status_date=date('now') WHERE id=?").run(b.id);
      });
      try { tx.immediate(); } catch (err) {
        // Дубликат, спрян от уникалния индекс (другата станция ни е изпреварила).
        if (/UNIQUE constraint failed: inventory_session_scans/.test(err.message)) {
          throw new Error('Инв. № ' + b.inv_number + ' вече е сканиран (записан е от другото работно място).');
        }
        throw err;
      }
      return { inv_number: b.inv_number, title: b.title };
    })
  );
  /* Приключване на сесията. `mode` е задължителен избор на библиотекаря:

     'full'          — ПЪЛНА проверка: всичко несканирано (и незаето) се смята за
                       липсващо, вписва се в протокола и получава статус „липсващ".
     'representative'— ПРЕДСТАВИТЕЛНА проверка по чл. 40, т. 2 (минимум 10% годишно):
                       протоколът важи САМО за сканираното; несканираното НЕ се пипа.

     До v2.1.0 разлика нямаше — close() винаги се държеше като 'full'. А самата
     програма представя проверката като представителна (полето „Обхват" е
     предпопълнено с този текст, таблото мери напредък към 10% цел), затова
     библиотекар, изпълнил ТОЧНО нормативното изискване и натиснал „Приключи",
     получаваше протокол с 90% липси и презаписани статуси на почти целия фонд —
     връщането им беше само ръчно, книга по книга. Проверено: 100 книги, сканирани
     целевите 10 → 90 маркирани „липсващ".

     Стойността по подразбиране НЕ е 'full': по-безопасно е приключване без изричен
     избор да не пипа статуси, отколкото да ги презапише масово. */
  ipcMain.handle('inventorySessions:close', (e, arg) =>
    run(() => {
      const db = getDb();
      // Приема и голо id (стар подпис), и {sessionId, mode} — за съвместимост.
      const sessionId = (arg && typeof arg === 'object') ? arg.sessionId : arg;
      const mode = (arg && typeof arg === 'object' && arg.mode) ? arg.mode : 'representative';
      if (mode !== 'full' && mode !== 'representative') {
        throw new Error('Непознат вид инвентаризация: ' + mode);
      }
      const tx = db.transaction(() => {
        const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
        if (!s) throw new Error('Няма такава сесия.');
        if (s.closed) throw new Error('Тази инвентаризация вече е приключена.');
        const scannedIds = db.prepare('SELECT book_id FROM inventory_session_scans WHERE session_id = ?').all(sessionId).map(r => r.book_id);
        // Одит v2.3.1 №20 — виж бележката в inventorySessions:requirement по-горе.
        const pool = db.prepare(`SELECT * FROM books WHERE (status != 'отчислен' OR status IS NULL) ${s.department ? 'AND department = ?' : ''}`)
          .all(...(s.department ? [s.department] : []));
        const openLoanIds = new Set(db.prepare('SELECT book_id FROM loans WHERE date_in IS NULL').all().map(r => r.book_id));
        const scannedSet = new Set(scannedIds);
        /* Одит v2.4.24: извинени са само заетите. Документ „за реставрация“ е при
           подвързвача — по определение не може да бъде сканиран на място, а
           „за реставрация“ е валидно състояние, което библиотекарят задава изрично
           от картона. Дотук той влизаше в липсите: 3 книги при подвързвача правеха
           протокола „липси над норматива с 2.0 документа — прилага се редът по
           чл. 51 – 53“, а състоянието им се презаписваше на „липсващ“ наведнъж
           (връщането е ръчно, книга по книга). Броят им се връща отделно, за да го
           обяви протоколът, вместо да го скрие. */
        /* Четирите категории трябва да са ВЗАИМНО ИЗКЛЮЧВАЩИ СЕ, иначе протоколът
           не се събира. Документ „за реставрация“ може да е бил върнат от
           подвързвача и сканиран (inventorySessions:scan приема такъв документ и
           нулира само „липсващ“), а може и да е зает — броен два пъти, протоколът
           щеше да гласи „в обхвата 100 · проверени 40 · заети 5 · за реставрация 3 ·
           липсващи 53“, тоест 101 от 100. */
        const excused = pool.filter(b => b.status === 'за реставрация'
          && !scannedSet.has(b.id) && !openLoanIds.has(b.id));
        const excusedIds = new Set(excused.map(b => b.id));
        const unchecked = pool.filter(b => !scannedSet.has(b.id) && !openLoanIds.has(b.id) && !excusedIds.has(b.id));
        // При представителна проверка непроверените НЕ са липсващи — те просто не
        // са влизали в обхвата на тазгодишната извадка.
        const missing = mode === 'full' ? unchecked : [];
        const insMissing = db.prepare(`
          INSERT INTO inventory_session_missing (session_id, book_id, inv_number, title, author, price)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        missing.forEach(b => {
          insMissing.run(sessionId, b.id, b.inv_number, b.title, b.author, b.price);
          if (b.status !== 'отчислен') db.prepare("UPDATE books SET status='липсващ', status_date=date('now') WHERE id=?").run(b.id);
        });
        /* Видът се ЗАПИСВА в базата (v2.3.0). Дотогава оставаше само в отговора към
           прозореца, затова в списъка приключена представителна проверка с 0 липсващи
           изглеждаше точно като пълна с 0 липсващи — а пред проверяващ от регионалната
           библиотека няма как да се докаже кое от двете е било. */
        /* Пулът и заетите се ЗАПИСВАТ такива, каквито са в момента на приключване.
           pool_size е снимка от започването; книги, вписани докато проверката тече,
           влизат в `unchecked`/`missing`, но не и в снимката — протоколът можеше да
           гласи „в обхвата 10 · проверени 10 · липсващи 30“. Одит на документите
           v2.4.17. */
        /* Заетите се броят СРЕД НЕПРОВЕРЕНИТЕ, по същата причина като „за реставрация“
           по-горе: четирите числа в протокола трябва да се събират до обхвата.
           Заета книга, която все пак е сканирана (върната на гишето, но още
           нерегистрирана), е ПРОВЕРЕНА — тя е била в ръцете на комисията. */
        const onLoanInPool = pool.filter(b => openLoanIds.has(b.id) && !scannedSet.has(b.id)).length;
        db.prepare('UPDATE inventory_sessions SET closed = 1, mode = ?, pool_final = ?, on_loan = ?, at_binder = ? WHERE id = ?')
          .run(mode, pool.length, onLoanInPool, excused.length, sessionId);
        logAudit('Инвентаризация', (mode === 'full' ? 'пълна' : 'представителна') +
          ' — проверени ' + scannedIds.length + ', липсващи ' + missing.length + ' от ' + pool.length +
          (excused.length ? ', ' + excused.length + (excused.length === 1 ? ' документ за реставрация (не се проверява на място)'
            : ' документа за реставрация (не се проверяват на място)') : ''));
        const s2 = db.prepare('SELECT free_access_pct FROM settings WHERE id = 1').get();
        return {
          mode, scanned: scannedIds.length, missing: missing.length, pool: pool.length,
          unchecked: unchecked.length, onLoan: onLoanInPool, atBinder: excused.length,
          allowedLoss: naturalLoss(pool.length, s2.free_access_pct)
        };
      });
      return tx.immediate();
    })
  );
};
