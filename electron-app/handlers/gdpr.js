// Лични данни: анонимизиране (Koha: pseudonymization) — извадени от main.js
// в отделен модул (Фаза 4, стъпка 20). Върнати заемания, по-стари от N
// години, губят връзката с името: закачат се за служебния запис
// „— анонимизирани заемания —", а категорията и годината се снимат в
// anon_category — статистиката остава вярна („дете, 2024 г."), името
// изчезва. Настройка anonymize_years = 0 изключва всичко. Необратимо е —
// затова е ръчен бутон.
const { ANON_READER_NAME } = require('../security-utils');
/* Видът на промяната за онлайн каталога — същата стойност като
   CATALOG_WRITE_CIRCULATION в main.js и CIRCULATION в loans.js/holds.js: отказът
   на заделена резервация при заличаване е промяна от гишето (М4, v2.4.71). */
const CIRCULATION = 'circulation';

module.exports = function registerGdprHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  function anonReaderId() {
    const db = getDb();
    const NAME = ANON_READER_NAME;
    const r = db.prepare('SELECT id FROM readers WHERE name = ?').get(NAME);
    if (r) return r.id;
    return db.prepare(`INSERT INTO readers (name, category, status, registered_at, gdpr_consent)
      VALUES (?, '—', 'прекратен', date('now', 'localtime'), 0)`).run(NAME).lastInsertRowid;
  }
  function anonCutoff(years) { return `${new Date().getFullYear() - years}-01-01`; }

  /* Списъците стоят тук (а не вътре в gdpr:anonymize), защото gdpr:candidates
     трябва да брои ТОЧНО каквото анонимизирането после ще пипне — одит v2.4.24:
     дотук броячът гледаше само заеманията, а бутонът се заключваше от него
     (src/views/settings.js: `if (!r.count) return toast('Няма заемания за
     анонимизиране.')`). Библиотека, компютризирана през 2020 г. и започнала да
     заема през 2023 г., получаваше „няма нищо за анонимизиране“, докато 400 имена,
     адреса и телефона от ръчното въвеждане си стояха в audit_log и в търсенията —
     завинаги, включително в резервните копия на споделения диск. */
  // „Изтрит ред от сметката“ (v2.4.24) носи същия формат „име — остатък“ и влиза
  // тук (одит v2.4.25) — иначе името оставаше в следата след срока.
  const MONEY_ACTIONS = "('Начисление', 'Плащане', 'Изтрит ред от сметката')";
  /* „Изтрит читател“ (без история) — от v2.4.65 readers.js вписва и него, с име
     и карта (виж readers.js при readers:delete). Дотук тук стоеше само вариантът
     „с история“, тоест изтрит читател без заемания оставаше поименно в следата
     завинаги, а анонимизирането и заличаването по чл. 17 обявяваха успех. */
  const NAME_ACTIONS = `('Нов читател', 'Редакция на читател', 'Изтрит читател с история',
                     'Изтрит читател',
                     'Снето наказание',
                     -- резервации: handlers/holds.js вписва името на читателя
                     'Заделена книга', 'Резервация', 'Отказана резервация', 'Изтекла резервация',
                     -- надомно обслужване: handlers/housebound.js
                     'Обслужване по домовете', 'Посещение по домовете')`;
  /* ЗАЕМАНИЯТА — третият вид ред, и най-многобройният (v2.4.65, кръг 42, А7).
     ============================================================================
     (а) КАКВО СТАВАШЕ ДОТУК. `NAME_ACTIONS` изброяваше редовете, в които ЦЕЛИЯТ
     текст е самоличност („карта 777 — Иван Петров Стоянов“), и ги заменяше с
     „[анонимизирано по GDPR]“. В този списък обаче не влизаха трите действия на
     гишето — „Заемане“, „Продължение на заемане“ и „Изгубен документ“ — а от
     v2.4.61 следата им назовава и читателя:
         инв. № 101 — Под игото; читател Иван Петров Стоянов (карта 777); срок 03.04.2019
     Тоест след „Анонимизиране“ редът „Нов читател“ вече беше обезличен, а
     редовете „Заемане“ пазеха името и номера на картата дословно. И това не са
     единични редове: при 50–150 сканирания на ден следата трупа по един такъв
     ред на всяко заемане — десетки хиляди реда с имена, които остават и в
     резервните копия на споделения мрежов диск.
     Отгоре на това `gdpr:candidates` брояше само MONEY+NAME: в пробата на кръга
     обявяваше „1 запис в одитната следа ще бъде обезличен“, когато редовете с
     име бяха 4. Библиотекарката вижда числото 1, приема, че това е всичко, и
     подписва, че личните данни са заличени в срок.

     (б) ЗАЩО Е ГРЕШНО. По чл. 5, ал. 1, б. „д“ от ОРЗД срокът на съхранение
     важи за ВСЯКО копие на данните, не за най-видното. А по чл. 17, ал. 2 от
     Наредба № 3 одитната следа трябва да остане документ за това КОЙ СЛУЖИТЕЛ
     какво е извършил с КОЙ ДОКУМЕНТ — изискване за фонда, не за читателя.
     Двете се съвместяват само ако от реда отпадне ЧИТАТЕЛЯТ, а документът
     остане.

     (в) ЗАЩО ПОПРАВКАТА Е ТОЧНО ТАЗИ. Редовете НЕ се заменят изцяло (както при
     NAME_ACTIONS), защото инв. № и заглавието са самото съдържание на следата:
     без тях остава „на 04.03.2019 г. някой е заел нещо“, което не документира
     нищо. Маха се САМО частта „; читател … (карта …)“ — и то с една и съща
     функция (stripReaderSegment) и за трите действия, защото и трите пишат
     сегмента в един и същ вид (handlers/loans.js:400, :634, :934).
     Резултатът е „инв. № 101 — Под игото; срок 03.04.2019“. */
  /* ЕДИН СПИСЪК, ОТ КОЙТО СЕ ПРАВЯТ И SQL-ЪТ, И МНОЖЕСТВОТО ЗА JS (v2.4.65).
     „Документът се намери“ (loans:found) пише читателя в същия вид „; читател
     … (карта …); “ като останалите три, затова минава през същото рязане на
     сегмента. Дотук списъкът стоеше два пъти — като SQL низ тук и като
     твърдо написан Set вътре в gdpr:forgetReader — и новото действие щеше да
     влезе само в единия: SQL-ът щеше да го намери, а JS да го пусне през
     клона за пълна замяна, тоест да изтрие и инв. № и заглавието, които
     следата е длъжна да пази (чл. 17, ал. 2 от Наредба № 3). */
  const LOAN_ACTION_LIST = ['Заемане', 'Продължение на заемане', 'Изгубен документ', 'Документът се намери'];
  const LOAN_ACTION_SET = new Set(LOAN_ACTION_LIST);
  const LOAN_ACTIONS = '(' + LOAN_ACTION_LIST.map(a => "'" + a + "'").join(', ') + ')';
  const READER_SEG = '; читател ';
  /* Сегментът винаги започва с „; читател “ и свършва на следващото „; “
     (или в края на реда, ако читателят е последното нещо в текста). Списъкът
     от кандидати се стеснява в SQL по същото условие, по което JS после реже —
     така броячът брои точно колкото ще бъдат пипнати. */
  function stripReaderSegment(detail) {
    const at = String(detail).indexOf(READER_SEG);
    if (at < 0) return String(detail);
    const s = String(detail);
    const next = s.indexOf('; ', at + READER_SEG.length);
    return s.slice(0, at) + (next < 0 ? '' : s.slice(next));
  }
  const AUDIT_MONEY_WHERE = `substr(ts, 1, 10) < ? AND action IN ${MONEY_ACTIONS}
      AND detail IS NOT NULL AND instr(detail, ' — ') > 0
      AND detail NOT LIKE '[анонимизиран читател]%'`;
  const AUDIT_NAME_WHERE = `substr(ts, 1, 10) < ? AND action IN ${NAME_ACTIONS}
      AND COALESCE(detail, '') != '[анонимизирано по GDPR]'`;
  const AUDIT_LOAN_WHERE = `substr(ts, 1, 10) < ? AND action IN ${LOAN_ACTIONS}
      AND detail IS NOT NULL AND instr(detail, '${READER_SEG}') > 0`;

  /* Одит v2.4.29: читателят оставаше свързан с документи и по ДРУГИ пътища,
     които анонимизирането не пипаше — резервациите (кой коя книга е чакал),
     предложенията за покупка (име на заявителя), заявителят в регистъра на МЗС,
     дневникът на изпратените напомняния и посещенията по домовете. Всичко това
     стоеше в базата и в резервните копия, а броячът казваше „няма нищо“.
     Същите условия се броят тук и се прилагат в gdpr:anonymize — по един ред
     на таблица, за да не се разминат. Параметри: @cutoff и @anon (id на служебния
     запис; -1, докато такъв още няма). */
  const ANON_MARK = '[анонимизиран читател]';
  /* Напомняне, зад което още стои НЕЗАВЪРШЕНО просрочено заемане, не е стар
     запис: то е състоянието „писмото по чл. 43 е изпратено“ за таблото
     (handlers/dashboard.js) и за степента на следващото напомняне
     (handlers/notices.js). Такова се пази, докато книгата не се върне. */
  const NOTICE_NOT_LIVE = `NOT EXISTS (SELECT 1 FROM loans l WHERE l.reader_id = notice_log.reader_id
       AND l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due <= substr(notice_log.ts, 1, 10))`;
  const OTHER_COUNTS = [
    `SELECT COUNT(*) AS n FROM holds WHERE status IN ('изпълнена', 'отказана')
       AND substr(COALESCE(resolved_at, placed_at), 1, 10) < @cutoff AND reader_id != @anon`,
    `SELECT COUNT(*) AS n FROM suggestions WHERE date < @cutoff
       AND (reader_id IS NOT NULL OR (reader_name IS NOT NULL AND reader_name != '${ANON_MARK}'))`,
    `SELECT COUNT(*) AS n FROM mzs_requests WHERE date < @cutoff
       AND requester IS NOT NULL AND requester != '${ANON_MARK}'`,
    `SELECT COUNT(*) AS n FROM notice_log WHERE substr(ts, 1, 10) < @cutoff AND ${NOTICE_NOT_LIVE}`,
    `SELECT COUNT(*) AS n FROM housebound_visits WHERE date < @cutoff AND reader_id != @anon`
  ];
  const OTHER_UPDATES = [
    `UPDATE holds SET reader_id = @anon WHERE status IN ('изпълнена', 'отказана')
       AND substr(COALESCE(resolved_at, placed_at), 1, 10) < @cutoff AND reader_id != @anon`,
    `UPDATE suggestions SET reader_id = NULL, reader_name = CASE WHEN reader_name IS NULL THEN NULL ELSE '${ANON_MARK}' END
       WHERE date < @cutoff AND (reader_id IS NOT NULL OR (reader_name IS NOT NULL AND reader_name != '${ANON_MARK}'))`,
    `UPDATE mzs_requests SET requester = '${ANON_MARK}'
       WHERE date < @cutoff AND requester IS NOT NULL AND requester != '${ANON_MARK}'`,
    `DELETE FROM notice_log WHERE substr(ts, 1, 10) < @cutoff AND ${NOTICE_NOT_LIVE}`,
    `UPDATE housebound_visits SET reader_id = @anon WHERE date < @cutoff AND reader_id != @anon`
  ];

  ipcMain.handle('gdpr:candidates', () =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT anonymize_years FROM settings WHERE id = 1').get() || {};
      const years = parseInt(s.anonymize_years, 10) || 0;
      if (!years) return { years: 0, count: 0, auditCount: 0, searchCount: 0 };
      const anonId = db.prepare('SELECT id FROM readers WHERE name = ?').get(ANON_READER_NAME);
      const count = db.prepare(`SELECT COUNT(*) AS n FROM loans
        WHERE date_in IS NOT NULL AND date_in < ? AND anon_category IS NULL ${anonId ? 'AND reader_id != ?' : ''}`)
        .get(...(anonId ? [anonCutoff(years), anonId.id] : [anonCutoff(years)])).n;
      const cutoff = anonCutoff(years);
      /* Трите брояча се събират в едно число, защото на екрана стои едно
         изречение („N записа в одитната следа ще бъдат обезличени“) и то трябва
         да отговаря на онова, което gdpr:anonymize после наистина промени —
         иначе библиотекарката подписва по числото, а не по действието (А7). */
      const auditCount = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${AUDIT_MONEY_WHERE}`).get(cutoff).n
        + db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${AUDIT_NAME_WHERE}`).get(cutoff).n
        + db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${AUDIT_LOAN_WHERE}`).get(cutoff).n;
      const searchCount = db.prepare('SELECT COUNT(*) AS n FROM search_history WHERE substr(ts, 1, 10) < ?').get(cutoff).n;
      const otherCount = OTHER_COUNTS.reduce((sum, sql) => sum + db.prepare(sql).get({ cutoff, anon: anonId ? anonId.id : -1 }).n, 0);
      return { years, count, auditCount, searchCount, otherCount, cutoff };
    })
  );
  ipcMain.handle('gdpr:anonymize', () =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT anonymize_years FROM settings WHERE id = 1').get() || {};
      const years = parseInt(s.anonymize_years, 10) || 0;
      if (!years) throw new Error('Първо задайте срок в „Настройки“ → „Лични данни“ (0 = изключено).');
      const cutoff = anonCutoff(years);
      const anonId = anonReaderId();
      const tx = db.transaction(() => {
        const n = db.prepare(`
          UPDATE loans SET
            anon_category = COALESCE((SELECT r.category FROM readers r WHERE r.id = loans.reader_id), '—')
                            || ' · ' || substr(loans.date_out, 1, 4),
            reader_id = ?
          WHERE date_in IS NOT NULL AND date_in < ? AND anon_category IS NULL AND reader_id != ?
        `).run(anonId, cutoff, anonId).changes;
        // Събитията също губят връзката с читателя; категорията им е снимана още при записа.
        db.prepare('UPDATE events SET reader_id = NULL WHERE date < ? AND reader_id IS NOT NULL AND reader_id != ?')
          .run(cutoff, anonId);

        /* Одитната следа също носи лични данни и дотук не се чистеше НИКОГА:
           `detail` пази „карта 123 — Иван Иванов“, а `diff` — стария и новия
           телефон, адрес и имейл при всяка редакция. Тоест след анонимизиране
           заеманията вече не сочеха към читателя, но самото му име, адрес и
           телефон си стояха в базата — и в резервните копия, които отиват на
           споделения диск.

           Редовете НЕ се трият: одитната следа е документът, който проверяващият
           от регионалната библиотека чете, и в нея трябва да личи, че на тази дата
           този служител е извършил това действие. Маха се само самоличността.
           Само за действията, които наистина носят лични данни на читател, и само
           за редове отпреди срока — точно както при заеманията. Списъкът беше
           съставен само от очевидните четири и пропускаше резервациите, касата и
           надомното обслужване — тоест името, адресът и телефонът на всеки, който
           някога е резервирал книга или е платил такса, оставаха в базата и в
           копията. „Извеждане на читатели (CSV)" пък беше в списъка напразно: там
           има само път до файл и брой записи, без лични данни. */
        /* Касовите записи пазят СУМАТА след тирето („Иван Петров — годишна такса
           12.00 лв."). Сумата не е личен данни и е част от отчетността — затова
           тук се маха само името, а остатъкът се запазва. При останалите действия
           целият текст е самоличност и отпада изцяло. */
        const anonMoney = db.prepare(`
          UPDATE audit_log
             SET detail = '[анонимизиран читател]' || substr(detail, instr(detail, ' — ')),
                 diff = NULL
           WHERE ${AUDIT_MONEY_WHERE}
        `).run(cutoff).changes;
        const anonNames = db.prepare(`
          UPDATE audit_log SET detail = '[анонимизирано по GDPR]', diff = NULL
          WHERE ${AUDIT_NAME_WHERE}
        `).run(cutoff).changes;
        /* ЗАЕМАНИЯТА (А7): тук се маха само сегментът за читателя, а инв. № и
           заглавието остават — следата продължава да документира кой документ
           е бил зает и кога, каквото иска чл. 17, ал. 2. Рязането става в JS, а
           не с вложени substr/instr в SQL: изразът в SQL би бил четири нива
           дълбок и нечетим, а редът е точно мястото, на което следващият
           поправящ трябва да види какво се маха. `diff` отпада изцяло — при
           тези действия в него няма нищо освен данни за човека. */
        const loanRows = db.prepare(`SELECT id, detail FROM audit_log WHERE ${AUDIT_LOAN_WHERE}`).all(cutoff);
        const setLoan = db.prepare('UPDATE audit_log SET detail = ?, diff = NULL WHERE id = ?');
        let anonLoans = 0;
        for (const row of loanRows) anonLoans += setLoan.run(stripReaderSegment(row.detail), row.id).changes;
        const auditCleared = anonMoney + anonNames + anonLoans;

        /* Историята на търсенията пази свободния текст, който библиотекарят е
           набрал — а той често е точно име на читател. Тя не е документ и няма
           стойност след срока, затова старите редове отпадат. */
        const searchCleared = db.prepare('DELETE FROM search_history WHERE substr(ts, 1, 10) < ?')
          .run(cutoff).changes;
        // Резервации, предложения, МЗС, напомняния, посещения по домовете (v2.4.29).
        const otherCleared = OTHER_UPDATES.reduce((sum, sql) => sum + db.prepare(sql).run({ cutoff, anon: anonId }).changes, 0);

        return { n, auditCleared, searchCleared, otherCleared };
      });
      const { n, auditCleared, searchCleared, otherCleared } = tx.immediate();
      // Съгласуване в единствено число (одит v2.4.24) — този ред отива в следата,
      // която проверяващият чете.
      logAudit('Анонимизиране',
        (n === 1 ? '1 върнато заемане отпреди ' + cutoff + ' е анонимизирано'
                 : n + ' върнати заемания отпреди ' + cutoff + ' са анонимизирани')
        + (auditCleared ? '; ' + (auditCleared === 1 ? '1 запис в одитната следа е обезличен'
            : auditCleared + ' записа в одитната следа са обезличени') : '')
        + (searchCleared ? '; ' + (searchCleared === 1 ? '1 старо търсене е изтрито'
            : searchCleared + ' стари търсения са изтрити') : '')
        + (otherCleared ? '; ' + (otherCleared === 1 ? '1 запис в резервации, предложения, МЗС, напомняния и посещения е обезличен'
            : otherCleared + ' записа в резервации, предложения, МЗС, напомняния и посещения са обезличени') : ''));
      return { anonymized: n, auditCleared, searchCleared, otherCleared, cutoff };
    })
  );

  /* ==========================================================================
     ЗАЛИЧАВАНЕ ПО ИСКАНЕ НА КОНКРЕТЕН ЧИТАТЕЛ — `gdpr:forgetReader`
     (v2.4.65, кръг 42, находка Б6)
     ==========================================================================
     (а) КАКВО СТАВАШЕ ДОТУК. Програмата имаше ЕДИН път към заличаване —
     „Анонимизиране“ в „Настройки“ → „Лични данни“, а той работи само по СРОК
     назад: anonCutoff(years) взема 1 януари на годината „преди N години“ и
     пипа всичко по-старо. За човек, който днес дойде и поиска данните му да
     бъдат заличени (чл. 17 ОРЗД), такъв път нямаше изобщо: неговите редове са
     ОТ ТАЗИ година, тоест са от вътрешната страна на срока и анонимизирането
     ги подминава по строеж. Единственото останало беше „Изтрий“ в картона, а
     `readers:delete` (handlers/readers.js) трие реда в `readers` и НЕ пипа
     одитната следа — там остават името, картата, старият и новият телефон и
     адрес в `diff` на „Редакция на читател“. Съобщението при отказ отгоре на
     всичко съветваше „ползвайте «Анонимизиране»“ — съвет, който за скорошен
     читател не върши нищо.

     (б) ЗАЩО Е ГРЕШНО. Заличаването по чл. 17 от ОРЗД има срок (месец) и не е
     по преценка: щом библиотеката няма основание да пази данните, тя ги
     заличава. Библиотекарката натискаше „Изтрий“, виждаше читателя да изчезва
     от списъка и отговаряше писмено, че искането е изпълнено — докато следата
     и резервните копия продължаваха да носят името и адреса. Това е по-лошо от
     липсващ бутон, защото създава увереност.

     (в) ЗАЩО ПОПРАВКАТА Е ТОЧНО ТАЗИ. Каналът прилага ДОСЛОВНО същите правила
     като `gdpr:anonymize` (същият служебен запис, същите замени, същото рязане
     на сегмента за читателя), но по КОНКРЕТНИЯ човек и БЕЗ срок. Не е ново
     правило — правилото е едно, входът е втори. Отделно:
       • Заеманията и сметката се ПРЕВКЛЮЧВАТ към служебния запис, а не се
         трият: броят заемания за 2026 г. е отчетно число по чл. 30 и не бива
         да мръдне, защото един човек е поискал заличаване.
       • Незавърнат документ и неплатена сметка СПИРАТ действието и казват
         изхода — това са задължения към библиотеката (чл. 17, ал. 3, б. „б“ и
         „д“ ОРЗД: заличаването отстъпва пред установяването на правни
         претенции). Иначе програмата би забравила у кого е книгата.
       • Следата получава ред за самото заличаване, но БЕЗ името — иначе
         действието, което трие самоличността, я вписва обратно на последния
         ред. Затова в реда стоят само броевете.
       • РЕЗЕРВНИТЕ КОПИЯ НЕ СЕ ПИПАТ и това се КАЗВА — и в следата, и в
         отговора към екрана. Те са криптирани, пазят се до 30/90/365 дни и
         тяхното изтриване би обезсмислило целия модул „Резервно копие“.
         Библиотекарката трябва да знае, че данните живеят там до изтичането
         на копията, за да отговори честно на човека.
     Връща `{ readerCleared, auditCleared, name }` — името се дава САМО на
     екрана (за изречението „Данните на … са заличени“) и никъде не се записва.
  ========================================================================== */
  const FORGET_ACTIONS_SQL = `action IN ${MONEY_ACTIONS} OR action IN ${NAME_ACTIONS} OR action IN ${LOAN_ACTIONS}`;

  /* ТОЗИ ЛИ ЧИТАТЕЛ Е В РЕДА — А НЕ СЪИМЕНЕНИК С ПО-ДЪЛГО ИМЕ (v2.4.65).
     =====================================================================
     Дотук редовете се намираха с instr(detail, name) > 0, тоест като ПОДНИЗ.
     Заличаването на „Иван Петров“ хващаше и „Иван Петрова“, и „Иван
     Петров-Стоянов“ — и техните редове ставаха „[анонимизирано по GDPR]“ с
     изтрит diff. Необратимо, върху следата на ДРУГ човек, който нищо не е
     искал. При кратко име („Ана“) това е голяма част от следата.
     Измерено: заличаване на „Иван Петров“ при наличен читател „Иван Петрова“
     обезличи и двата реда на Иван Петрова („Нов читател“ и „Редакция“).

     ПРАВИЛОТО. Името трябва да стои като ЦЯЛО: знакът преди него и знакът
     след него не бива да са буква, цифра или тире (тирето е част от двойно
     фамилно име). А ако веднага след името следва „ (карта N)“ — какъвто е
     видът, в който loans.js, readers.js и holds.js пишат читателя — N трябва
     да е картата на ТОЗИ читател: иначе е пълен съименник с друга карта.
     SQL-ът продължава да стеснява с instr (евтино, по индекс няма), а
     решението е тук, в JS, върху вече малкото кандидати. */
  const NAME_CHAR = /[\p{L}\p{N}-]/u;
  function mentionsReader(detail, name, cardNo) {
    const s = String(detail || '');
    if (!name) return false;
    let from = 0;
    for (;;) {
      const at = s.indexOf(name, from);
      if (at < 0) return false;
      from = at + 1;
      const before = at > 0 ? s[at - 1] : '';
      const after = s[at + name.length] || '';
      if (before && NAME_CHAR.test(before)) continue;
      if (after && NAME_CHAR.test(after)) continue;
      /* Картата: ако я има в реда веднага след името, решава тя. */
      const tail = s.slice(at + name.length);
      const card = /^ \(карта ([^)]+)\)/.exec(tail);
      if (card && cardNo != null && String(cardNo) !== '' && card[1] !== String(cardNo)) continue;
      return true;
    }
  }
  /* ВСИЧКИ ИМЕНА, КАРТИ И ТЕЛЕФОНИ, С КОИТО ЧИТАТЕЛЯТ Е МИНАЛ ПРЕЗ СЛЕДАТА
     (v2.4.71, кръг 45, находка С3).
     (а) КАКВО СТАВАШЕ ДОТУК. Заличаването търсеше в следата САМО текущото пълно
     име. Тестерите (s6-gdpr.js и сценарият на каталога) заличиха „Мария
     Петрова“ (карта 2), която доскоро беше „Мария Иванова“ (брак — „Редакция на
     читател“). Останаха: „карта 2 — Мария Иванова“ (редът „Нов читател“),
     „…; читател Мария Иванова (карта 2); срок …“ (заемането отпреди смяната),
     „Запазен PDF: …/Читателски картон — Мария Петрова.pdf“, и търсенията в
     „Читатели“ по старото име, по фамилията и по телефона. Отговорът казваше
     „обезличени 4 реда“ — числото на пипнатото, не на останалото.
     (б) ЗАЩО Е ГРЕШНО. Чл. 17 ОРЗД иска заличаване на данните на ЧОВЕКА, не на
     един правопис на името му. Старото име е точно личната информация, която
     най-лесно води до човека (моминското име); файлът на картона в следата
     назовава и него. Библиотекарката отговаря писмено „заличено“ по числото на
     екрана.
     (в) ЗАЩО ТОЧНО ТАКА. Самоличността се събира от следата на самата програма:
     редовете „Нов читател“/„Редакция на читател“ са „карта N — Име“, а `diff`
     на редакцията пази преди/след за името, картата и телефона. Ред се приема
     за ред на ТОЗИ читател, когато картата в него е негова И името в него (или
     в diff-а му) вече е познато — така от „Мария Петрова, карта 2“ се стига до
     „Мария Иванова“, а от смяна на картата — до старата карта. Повтаря се,
     докато нищо ново не се появи (верига от няколко смени). Чужд читател, държал
     същата карта преди, не влиза: името му не е в познатите. Началото на
     самоличността (първият приет ред или датата на записване) ограничава и
     правилото „(карта N)“, по което се хващат редовете със СТАРО име, което не
     е минало през редакция (напр. сгрешено и поправено на гишето). */
  function readerIdentity(db, r) {
    const names = new Set();
    const cards = new Set();
    const phones = new Set();
    const add = (set, v) => { const s = v == null ? '' : String(v).trim(); if (s) set.add(s); };
    add(names, r.name); add(cards, r.card_no); add(phones, r.phone);
    const rows = db.prepare(`SELECT id, ts, detail, diff FROM audit_log
        WHERE action IN ('Нов читател', 'Редакция на читател') AND detail LIKE 'карта %'`).all();
    const accepted = new Set();
    let firstSeen = r.registered_at ? String(r.registered_at).slice(0, 10) : '';
    /* ПРОЗОРЕЦ ЗА ВСЯКА КАРТА (преглед на кръга, v2.4.71). Карта, от която
       читателят е минал на друга, после се дава на ДРУГ читател — редовете
       „(карта 2)“ след смяната са негови. Затова всяка карта носи от кога е
       станала на този читател (cardFrom — денят на смяната към нея) и до кога
       (cardUntil — денят на смяната от нея); текущата карта няма край. */
    const cardFrom = new Map(), cardUntil = new Map();
    const current = String(r.card_no == null ? '' : r.card_no).trim();
    for (let round = 0; round < 10; round++) {
      let grew = false;
      for (const row of rows) {
        if (accepted.has(row.id)) continue;
        const m = /^карта (.*?) — (.+)$/.exec(String(row.detail || ''));
        if (!m) continue;
        /* „Нов читател“ може да носи и „; ВНИМАНИЕ: ЕГН …“ след името (Ч11) —
           името свършва на първото „; “. */
        const card = m[1].trim(), nm = m[2].split('; ')[0].trim();
        let diff = [];
        try { diff = row.diff ? JSON.parse(row.diff) : []; } catch (e) { diff = []; }
        if (!Array.isArray(diff)) diff = [];
        const f = (field) => diff.find(d => d && d.field === field) || null;
        const dName = f('name'), dCard = f('card_no'), dPhone = f('phone');
        const cardOurs = card ? cards.has(card) || (dCard && [dCard.before, dCard.after].some(v => cards.has(String(v == null ? '' : v).trim())))
          : cards.size === 0;
        const nameOurs = names.has(nm) || (dName && [dName.before, dName.after].some(v => names.has(String(v == null ? '' : v).trim())));
        if (!cardOurs || !nameOurs) continue;
        accepted.add(row.id);
        const before = names.size + cards.size + phones.size;
        add(names, nm); add(cards, card);
        if (dName) { add(names, dName.before); add(names, dName.after); }
        if (dCard) { add(cards, dCard.before); add(cards, dCard.after); }
        if (dPhone) { add(phones, dPhone.before); add(phones, dPhone.after); }
        const day = String(row.ts || '').slice(0, 10);
        if (dCard && day) {
          const was = String(dCard.before == null ? '' : dCard.before).trim();
          const now = String(dCard.after == null ? '' : dCard.after).trim();
          if (was && was !== current && !(cardUntil.get(was) > day)) cardUntil.set(was, day);
          if (now && !(cardFrom.get(now) < day)) cardFrom.set(now, day);
        }
        if (day && (!firstSeen || day < firstSeen)) firstSeen = day;
        if (names.size + cards.size + phones.size > before) grew = true;
      }
      if (!grew) break;
    }
    return { names, cards, phones, firstSeen, cardFrom, cardUntil };
  }
  /* Цяло име с граница — като mentionsReader, но за НЯКОЕ от имената, и
     картата след името може да е НЯКОЯ от картите на читателя. */
  function mentionsIdentity(detail, id) {
    for (const nm of id.names) {
      const s = String(detail || '');
      let from = 0;
      for (;;) {
        const at = s.indexOf(nm, from);
        if (at < 0) break;
        from = at + 1;
        const before = at > 0 ? s[at - 1] : '';
        const after = s[at + nm.length] || '';
        if (before && NAME_CHAR.test(before)) continue;
        if (after && NAME_CHAR.test(after)) continue;
        const card = /^ \(карта ([^)]+)\)/.exec(s.slice(at + nm.length));
        if (card && id.cards.size && !id.cards.has(card[1].trim())) continue;
        return true;
      }
    }
    return false;
  }
  /* „(карта N)“ с карта на читателя, в ред отпосле началото на самоличността. */
  function mentionsCard(detail, ts, id) {
    if (!id.cards.size) return false;
    if (id.firstSeen && String(ts || '').slice(0, 10) < id.firstSeen) return false;
    const re = /\(карта ([^)]+)\)/g;
    let m;
    const day = String(ts || '').slice(0, 10);
    while ((m = re.exec(String(detail || '')))) {
      const c = m[1].trim();
      if (!id.cards.has(c)) continue;
      /* Извън прозореца на картата редът е на друг читател със същата карта. */
      if (day && id.cardFrom && id.cardFrom.has(c) && day < id.cardFrom.get(c)) continue;
      if (day && id.cardUntil && id.cardUntil.has(c) && day > id.cardUntil.get(c)) continue;
      return true;
    }
    return false;
  }
  /* Заменя всяко цяло срещане на някое от имената с ANON_MARK — за редовете,
     в които името е ЧАСТ от иначе нужен текст (пътят на запазения PDF). */
  function replaceNames(detail, id) {
    let s = String(detail || '');
    const list = [...id.names].sort((a, b) => b.length - a.length); // първо по-дългите
    for (const nm of list) {
      let out = '', from = 0;
      for (;;) {
        const at = s.indexOf(nm, from);
        if (at < 0) { out += s.slice(from); break; }
        const before = at > 0 ? s[at - 1] : '';
        const after = s[at + nm.length] || '';
        const whole = !(before && NAME_CHAR.test(before)) && !(after && NAME_CHAR.test(after));
        out += s.slice(from, at) + (whole ? ANON_MARK : nm);
        from = at + nm.length;
      }
      s = out;
    }
    return s;
  }
  const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');

  ipcMain.handle('gdpr:forgetReader', /** @param {unknown} e @param {IpcArg<'gdpr:forgetReader'>} arg */ (e, arg) =>
    run(() => {
      const db = getDb();
      const id = parseInt(/** @type {Id} */ ((arg && typeof arg === 'object') ? arg.id : arg), 10);
      if (!Number.isFinite(id) || id <= 0) {
        throw new Error('Не е посочен читател. Отворете картона на читателя и повторете действието.');
      }
      const r = db.prepare('SELECT id, name, card_no, phone, registered_at FROM readers WHERE id = ?').get(id);
      if (!r) throw new Error('Такъв читател няма в базата — може вече да е изтрит.');
      if (r.name === ANON_READER_NAME) {
        throw new Error('Това не е читател, а служебният запис, под който се пазят анонимизираните заемания. '
          + 'В него няма лични данни за заличаване, а изтриването му би заличило статистиката за минали години.');
      }
      /* Двете спирачки — със същите думи и същия изход като в readers:delete,
         за да не се учи библиотекарката на две различни обяснения за едно и
         също положение. */
      const open = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ? AND date_in IS NULL').get(id).n;
      if (open) {
        throw new Error('Читателят държи ' + open + (open === 1 ? ' незавърнат документ' : ' незавърнати документа')
          + ' и данните му не могат да бъдат заличени, докато библиотеката не си получи документите обратно. '
          + 'Приемете връщането (или отчислете документа като изгубен) от „Заемания“ и повторете заличаването.');
      }
      const balance = Number(db.prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM account_lines WHERE reader_id = ?')
        .get(id).b) || 0;
      if (balance > 0.005) {
        throw new Error('Читателят дължи ' + balance.toFixed(2) + ' € по сметката си и данните му не могат да бъдат '
          + 'заличени, докато задължението стои. Отчетете плащането или отпишете задължението от „Сметка“ в '
          + 'картона на читателя и повторете заличаването.');
      }
      /* ТРЕТАТА СПИРАЧКА — ЧУЖДА КНИГА ПО МЗС (v2.4.69, кръг 44, К8).
         От v2.4.69 получена по изходяща МЗС заявка книга се дава на читателя по
         самата заявка (reader_id), без да минава през „Заемания“. Тя е
         задължение на читалището към ДРУГА библиотека — заличен читател значи
         библиотека, която не знае на кого да се обади за нея. Същото правило
         като при незавърнатите документи, със същия вид изход. */
      const mzsHeld = db.prepare(`SELECT no, year, title, partner FROM mzs_requests
           WHERE reader_id = ? AND direction = 'изходящо' AND status = 'получено'`).all(id);
      if (mzsHeld.length) {
        throw new Error('Читателят държи ' + (mzsHeld.length === 1 ? 'чужда книга, получена' : mzsHeld.length + ' чужди книги, получени')
          + ' по междубиблиотечно заемане (' + mzsHeld.map(x => '„' + x.title + '“ от ' + x.partner + ', МЗС № '
            + x.no + '/' + x.year).join('; ') + '), и данните му не могат да бъдат заличени, докато книгата не '
          + 'се върне. Приемете я от читателя, отбележете заявката „върнато“ в „МЗС“ и повторете заличаването.');
      }
      const name = r.name || '';
      const anonId = anonReaderId();
      /* Съименници: следата пази СВОБОДЕН ТЕКСТ с име, не номер на читател —
         друг начин да се намерят редовете на този човек няма. Ако в базата има
         втори читател със същото име, неговите редове ще бъдат обезличени
         заедно с тези на искателя. Това е в безопасната посока (по-малко лични
         данни, не повече), но се БРОИ и се казва — иначе библиотекарката вижда
         необяснимо голямо число. */
      const namesakes = name
        ? db.prepare('SELECT COUNT(*) AS n FROM readers WHERE name = ? AND id != ?').get(name, id).n
        : 0;
      /* С3: самоличността се събира ПРЕДИ транзакцията — тя трие diff-овете,
         от които старите имена и карти се четат. */
      const ident = readerIdentity(db, r);

      const tx = db.transaction(() => {
        /* 1) ЗАЕМАНИЯТА — както в gdpr:anonymize, само без условието за срок и
              само за този читател. Всички са затворени (спирачката по-горе). */
        const loansMoved = db.prepare(`
          UPDATE loans SET
            anon_category = COALESCE(anon_category,
              COALESCE((SELECT r2.category FROM readers r2 WHERE r2.id = loans.reader_id), '—')
              || ' · ' || substr(loans.date_out, 1, 4)),
            reader_id = ?
          WHERE reader_id = ?
        `).run(anonId, id).changes;
        /* 2) СМЕТКАТА се превключва, а не се трие: годишните такси и платените
              обезщетения са отчетност на читалището (чл. 30) и сборът им за
              годината не бива да падне заради заличаване. Балансът е нула. */
        const accountMoved = db.prepare('UPDATE account_lines SET reader_id = ? WHERE reader_id = ?')
          .run(anonId, id).changes;
        const eventsCleared = db.prepare('UPDATE events SET reader_id = NULL WHERE reader_id = ?').run(id).changes;
        /* АКТИВНИТЕ РЕЗЕРВАЦИИ СЕ ОТМЕНЯТ, ПРЕДИ ДА БЪДАТ ПРЕМЕСТЕНИ (v2.4.65).
           Дотук ВСИЧКИ резервации отиваха на служебния запис, включително
           „чака“ и „заделена“. Тогава служебният запис заемаше място в опашката:
           при връщане holds.js заделяше книгата за „— анонимизирани заемания —“,
           а истинските читатели зад него чакаха, докато фантомната резервация
           изтече. gdpr:anonymize нарочно мести само приключените
           („изпълнена“/„отказана“) — тук правилото е същото, но човекът е
           поискал заличаване, тоест неговото желание да вземе книгата вече не
           съществува: резервацията се отказва, а заделеният документ се
           освобождава за следващия. */
        /* Кои документи са били ЗАДЕЛЕНИ за този читател — след отказа следващият
           в опашката трябва да бъде повикан (виж по-долу). */
        const setAsideBooks = db.prepare(`SELECT DISTINCT book_id FROM holds
             WHERE reader_id = ? AND status = 'заделена'`).all(id).map(h => h.book_id);
        const holdsCancelled = db.prepare(`UPDATE holds
             SET status = 'отказана', resolved_at = date('now', 'localtime'),
                 note = 'отказана при заличаване по искане на читателя (чл. 17 ОРЗД)'
           WHERE reader_id = ? AND status IN ('чака', 'заделена')`).run(id).changes;
        const holdsMoved = db.prepare('UPDATE holds SET reader_id = ? WHERE reader_id = ?').run(anonId, id).changes;
        /* СЛЕДВАЩИЯТ В ОПАШКАТА СЕ ПОВИКВА (v2.4.67). Отказът на заделена
           резервация не стига: документът не е зает, тоест никое връщане няма да
           повика следващия чакащ — а activateHoldOnReturn() е единственият път,
           по който „чака“ става „заделена“. Дотук чакащият оставаше „чака“ завинаги,
           а другите читатели бяха отказвани на гишето, защото той е пред тях.
           Точно така прави и обикновеният отказ (holds:cancel) и изтичането на
           заделена резервация. Незадължителна зависимост: main.js я подава;
           отделните тестове на този модул могат да я пропуснат. */
        /* КОЙ Е ПОВИКАН — ПО ИМЕ И ТЕЛЕФОН (v2.4.69, кръг 44, Г7 — обработчикът).
           (а) Дотук тук се събираха само имената, а към екрана отиваше единствено
               броят (`promoted`) — известието казваше „Личните данни са
               заличени“, без да спомене, че за заделената книга е повикан друг.
           (б) Повиканият не знае, че книгата го чака; тридневният срок тече и
               книгата отива на следващия, без той да е разбрал.
           (в) Връща се `holdsActivated: [{ name, phone, title, inv_number }]` —
               точно формата, която „Читатели“ (toastHoldsActivated) вече чака и
               която readers:delete връща при изтриване. Повикан е ДРУГ читател,
               тоест името му не е лична информация на заличавания. */
        const promoted = [];
        if (typeof deps.activateHoldOnReturn === 'function') {
          for (const bookId of setAsideBooks) {
            const next = deps.activateHoldOnReturn(bookId);
            if (next && next.justActivated && next.reader_id !== id) {
              promoted.push({ name: next.reader_name, phone: next.phone || null, title: next.title || '',
                inv_number: next.inv_number ?? null });
            }
          }
        }
        const visitsMoved = db.prepare('UPDATE housebound_visits SET reader_id = ? WHERE reader_id = ?')
          .run(anonId, id).changes;
        const noticesGone = db.prepare('DELETE FROM notice_log WHERE reader_id = ?').run(id).changes;
        const suggCleared = db.prepare(`UPDATE suggestions
             SET reader_id = NULL,
                 reader_name = CASE WHEN reader_name IS NULL THEN NULL ELSE '${ANON_MARK}' END
           WHERE reader_id = ?`).run(id).changes;
        const suggByName = name ? db.prepare(`UPDATE suggestions SET reader_name = '${ANON_MARK}'
           WHERE reader_id IS NULL AND reader_name = ?`).run(name).changes : 0;
        /* ЗАЯВИТЕЛЯТ В МЗС — ПО КАРТАТА, А НЕ ПО ДОСЛОВНО ИМЕ (v2.4.69, кръг 44, К7).
           (а) Дотук се обезличаваше само `requester = име` — дословно. Тестер № 5:
               „Здравка Междубиблиотечна (карта 8001)“ остана непокътната, защото
               библиотекарката е дописала картата, а отговорът не каза, че нещо
               е останало.
           (б) Чл. 17 ОРЗД иска заличаване на данните на човека, не на един
               правопис на името му. Останал заявител в регистъра е точно
               личните данни, които библиотеката е обещала да заличи.
           (в) Три стъпки:
               1) заявките, свързани с читателя (reader_id — от v2.4.69), се
                  обезличават и връзката се маха — сигурно, без гадаене;
               2) старите записи без reader_id — по същото правило като
                  одитната следа (mentionsReader): цялото име като цяло, а ако
                  след него стои „(карта N)“, N трябва да е неговата карта;
               3) каквото все пак прилича (фамилията или името, но не цялото
                  име; или същото име с ДРУГА карта) НЕ се пипа — може да е
                  друг човек, — но се връща на екрана (`mzsSimilar`) и се
                  казва с изречение (`mzsNote`), за да реши библиотекарката. */
        const mzsById = db.prepare(`UPDATE mzs_requests SET requester = CASE WHEN requester IS NULL THEN NULL
             ELSE '${ANON_MARK}' END, reader_id = NULL WHERE reader_id = ?`).run(id).changes;
        let mzsByName = 0;
        const mzsSimilar = [];
        if (name) {
          const setReq = db.prepare(`UPDATE mzs_requests SET requester = '${ANON_MARK}' WHERE id = ?`);
          const parts = name.split(/[\s,]+/).filter(w => w.length >= 3).map(w => w.toLocaleLowerCase('bg'));
          for (const q of db.prepare(`SELECT id, no, year, requester FROM mzs_requests
               WHERE reader_id IS NULL AND requester IS NOT NULL AND requester <> '${ANON_MARK}'`).all()) {
            if (mentionsReader(q.requester, name, r.card_no)) { mzsByName += setReq.run(q.id).changes; continue; }
            const low = String(q.requester).toLocaleLowerCase('bg');
            if (parts.some(w => low.includes(w))) mzsSimilar.push({ id: q.id, no: q.no, year: q.year, requester: q.requester });
          }
        }
        const mzsCleared = mzsById + mzsByName;
        /* 3) САМИЯТ КАРТОН. Изтрива се, а не се обезличава: профилът за надомно
              обслужване виси на него с ON DELETE CASCADE и неговата „Забележка“
              е свободно поле, в което реално пише адрес („живее при дъщеря си
              на ул. …“). Заеманията, сметката, резервациите и посещенията вече
              сочат към служебния запис, тоест каскадата няма какво да отнесе. */
        const readerGone = db.prepare('DELETE FROM readers WHERE id = ?').run(id).changes;

        /* 4) ОДИТНАТА СЛЕДА — трите замени от gdpr:anonymize, приложени ред по
              ред само върху редовете, в които стои името на този човек. */
        let auditCleared = 0;
        if (ident.names.size || ident.cards.size) {
          /* С3: всяко име от самоличността (текущото и старите), и „(карта N)“
             с негова карта. Дали редът наистина е за ТОЗИ читател, решават
             mentionsIdentity()/mentionsCard() — цяло име и негова карта.
             „Запазен PDF“ (handlers/print.js) влиза тук за първи път: пътят на
             файла носи името („Читателски картон — Мария Петрова.pdf“). В него
             се заменя само името — видът на документа и папката остават, защото
             следата документира КАКВО е изнесено. */
          const rows = db.prepare(`SELECT id, ts, action, detail FROM audit_log
             WHERE detail IS NOT NULL AND ((${FORGET_ACTIONS_SQL}) OR action = 'Запазен PDF')`).all()
            .filter(row => mentionsIdentity(row.detail, ident)
              || (row.action !== 'Запазен PDF' && mentionsCard(row.detail, row.ts, ident)));
          const setDetail = db.prepare('UPDATE audit_log SET detail = ?, diff = NULL WHERE id = ?');
          const MONEY = new Set(['Начисление', 'Плащане', 'Изтрит ред от сметката']);
          for (const row of rows) {
            let next;
            if (row.action === 'Запазен PDF') {
              next = replaceNames(row.detail, ident);
            } else if (LOAN_ACTION_SET.has(row.action)) {
              next = stripReaderSegment(row.detail);
            } else if (MONEY.has(row.action)) {
              const at = row.detail.indexOf(' — ');
              // Сумата след тирето е отчетност и остава — както в gdpr:anonymize.
              next = at < 0 ? ANON_MARK : ANON_MARK + row.detail.slice(at);
            } else {
              next = '[анонимизирано по GDPR]';
            }
            if (next === row.detail) continue;
            auditCleared += setDetail.run(next, row.id).changes;
          }
        }
        /* 5) ИСТОРИЯТА НА ТЪРСЕНИЯТА — библиотекарката често търси читателя по
              име, тоест името стои и тук. Не е документ и отпада. */
        /* Същото правило за цяло име: търсене „Иван Петрова“ е търсене на
           друг човек и не бива да отпада заради заличаването на „Иван Петров“.
           Търсенията не носят карта, затова решава само границата на името. */
        /* С3: и търсенията в „Читатели“ по ТЕЛЕФОНА (поне 6 цифри, с или без
           интервали), по КАРТАТА (точно номерът) и по ФАМИЛИЯТА (цяла дума, без
           значение от главни/малки букви) — по всяко от познатите имена и
           телефони, не само по текущото. Тези три правила важат само за вида
           „readers“: „Петрова“, търсено в „Книги“, е автор, не читател. Цялото
           име се хваща във всеки вид търсене, както досега. Посоката е
           безопасната — отпада ред от историята на търсенията, не данни. */
        let searchCleared = 0;
        if (ident.names.size) {
          const delSearch = db.prepare('DELETE FROM search_history WHERE id = ?');
          const lower = (x) => String(x || '').toLocaleLowerCase('bg');
          const surnames = new Set([...ident.names].map(n => lower(n.split(/\s+/).filter(Boolean).pop()))
            .filter(w => w.length >= 3));
          const phoneDigits = [...ident.phones].map(digitsOf).filter(d => d.length >= 6);
          for (const s of db.prepare('SELECT id, kind, query FROM search_history').all()) {
            const q = String(s.query || '').trim();
            if (!q) continue;
            let hit = mentionsIdentity(q, { names: ident.names, cards: new Set() });
            if (!hit && s.kind === 'readers') {
              const qd = digitsOf(q);
              if (qd.length >= 6 && qd.length >= q.replace(/[\s()+\-./]/g, '').length
                && phoneDigits.some(pd => pd.includes(qd) || qd.includes(pd))) hit = true;
              else if (ident.cards.has(q)) hit = true;
              else if (q.split(/[\s,;]+/).some(w => surnames.has(lower(w)))) hit = true;
            }
            if (hit) searchCleared += delSearch.run(s.id).changes;
          }
        }

        const readerCleared = readerGone + loansMoved + accountMoved + eventsCleared + holdsMoved
          + visitsMoved + noticesGone + suggCleared + suggByName + mzsCleared;
        return { readerCleared, auditCleared, searchCleared, loansMoved, accountMoved, holdsCancelled,
          promoted: promoted.length, holdsActivated: promoted, mzsCleared, mzsSimilar,
          setAside: setAsideBooks.length };
      });
      const res = tx.immediate();
      /* ОСВОБОДЕНАТА КНИГА СТИГА ДО САЙТА (v2.4.71, кръг 45, находка М4).
         (а) Отказът на заделената резервация сменя наличността на документа
         („заета“ за читателя → свободна или заделена за следващия), а
         онлайн каталогът (katalog.json) я показваше „заета“ до следващата
         случайна промяна във фонда — зависимостта scheduleCatalogWrite беше
         подадена на модула от main.js, но никой не я викаше (сценарият на
         тестера: чакане 97 s, файлът не се променя).
         (б) Читателите на сайта виждат книгата недостъпна и не идват за нея.
         (в) Записът се насрочва СЛЕД транзакцията (промяната вече е в базата) и
         само ако наистина е имало заделена книга; видът е 'circulation' — същият,
         който ползват заеманията и резервациите. Незадължителна зависимост:
         отделните тестове на модула може да я пропуснат. */
      if (res.setAside && typeof deps.scheduleCatalogWrite === 'function') {
        try { deps.scheduleCatalogWrite(CIRCULATION); }
        catch (err) { console.error('Онлайн каталогът не можа да бъде насрочен за запис след заличаването:', err.message); }
      }
      /* v2.4.76: заличеният читател отпада и от снимката за мобилното приложение
         (само при активиран онлайн достъп; иначе повикването е празно). */
      if (typeof deps.scheduleOnlineSync === 'function') {
        try { deps.scheduleOnlineSync(); } catch (err) { console.error('Онлайн достъпът не можа да бъде насрочен след заличаването:', err.message); }
      }

      /* Редът в следата — БЕЗ името и БЕЗ номера на картата. Действието, което
         заличава самоличността, не бива да я вписва обратно на последния ред;
         затова тук стоят само броевете и изричното напомняне за копията. */
      logAudit('Заличаване по искане на читател',
        'по чл. 17 от ОРЗД. Картонът на читателя е изтрит; '
        + res.loansMoved + (res.loansMoved === 1 ? ' заемане и ' : ' заемания и ')
        + res.accountMoved + (res.accountMoved === 1 ? ' движение по сметката са прехвърлени' : ' движения по сметката са прехвърлени')
        + ' към служебния запис „' + ANON_READER_NAME + '“, за да не мръдне отчетността. '
        + 'Обезличени записа в одитната следа: ' + res.auditCleared + '; '
        + 'изтрити стари търсения: ' + res.searchCleared + '; '
        + 'останали обезличени записа (резервации, предложения, МЗС, напомняния, посещения по домовете): '
        + (res.readerCleared - res.loansMoved - res.accountMoved - 1) + '. '
        + (res.holdsCancelled
          ? 'Отказани активни резервации: ' + res.holdsCancelled
            + (res.promoted ? '; повикан е следващият в опашката за ' + res.promoted
              + (res.promoted === 1 ? ' документ' : ' документа') : '') + '. '
          : '')
        + (res.mzsSimilar.length
          ? 'В регистъра на МЗС остават ' + res.mzsSimilar.length + (res.mzsSimilar.length === 1 ? ' заявка' : ' заявки')
            + ' с подобно име на заявителя, които НЕ са пипани (може да е друг човек) — прегледайте ги ръчно. '
          : '')
        + 'Самоличността на читателя нарочно НЕ се вписва тук. '
        + 'ВНИМАНИЕ: резервните копия НЕ са пипани — данните на този читател остават в тях, '
        + 'докато копията не изтекат по правилото за пазене или не бъдат изтрити ръчно.');

      return {
        readerCleared: res.readerCleared,
        auditCleared: res.auditCleared,
        name,
        searchCleared: res.searchCleared,
        holdsCancelled: res.holdsCancelled,
        /* Г7: кой е повикан за заделената книга — вж. коментара при `promoted`. */
        holdsActivated: res.holdsActivated,
        /* К7: колко заявки в МЗС са обезличени и кои подобни са оставени. */
        mzsCleared: res.mzsCleared,
        mzsSimilar: res.mzsSimilar,
        mzsNote: res.mzsSimilar.length
          ? 'В регистъра на МЗС ' + (res.mzsSimilar.length === 1 ? 'остава 1 заявка' : 'остават ' + res.mzsSimilar.length + ' заявки')
            + ' с подобно име на заявителя — ' + res.mzsSimilar.map(q => '№ ' + q.no + '/' + q.year + ' („' + q.requester + '“)').join(', ')
            + '. Не са пипани, защото може да е друг човек. Ако са на същия читател, отворете ги в „МЗС“ и изтрийте '
            + 'името от „Заявител“.'
          : null,
        namesakes,
        /* Изречението пътува до екрана готово: това, което библиотекарката ще
           препише в отговора си до читателя, не бива да се съчинява на две
           места с два различни текста. */
        backupsNote: 'Резервните копия НЕ са пипани. Данните на този читател остават в тях, докато копията '
          + 'не изтекат по правилото за пазене (или не бъдат изтрити ръчно от папката с копията). '
          + 'Копията са предпазната мрежа на цялата библиотека и програмата не ги променя заради '
          + 'заличаване на един читател.'
      };
    })
  );
};
