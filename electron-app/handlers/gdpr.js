// Лични данни: анонимизиране (Koha: pseudonymization) — извадени от main.js
// в отделен модул (Фаза 4, стъпка 20). Върнати заемания, по-стари от N
// години, губят връзката с името: закачат се за служебния запис
// „— анонимизирани заемания —", а категорията и годината се снимат в
// anon_category — статистиката остава вярна („дете, 2024 г."), името
// изчезва. Настройка anonymize_years = 0 изключва всичко. Необратимо е —
// затова е ръчен бутон.
const { ANON_READER_NAME } = require('../security-utils');

module.exports = function registerGdprHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  function anonReaderId() {
    const db = getDb();
    const NAME = ANON_READER_NAME;
    const r = db.prepare('SELECT id FROM readers WHERE name = ?').get(NAME);
    if (r) return r.id;
    return db.prepare(`INSERT INTO readers (name, category, status, registered_at, gdpr_consent)
      VALUES (?, '—', 'прекратен', date('now'), 0)`).run(NAME).lastInsertRowid;
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
  const NAME_ACTIONS = `('Нов читател', 'Редакция на читател', 'Изтрит читател с история',
                     'Снето наказание',
                     -- резервации: handlers/holds.js вписва името на читателя
                     'Заделена книга', 'Резервация', 'Отказана резервация', 'Изтекла резервация',
                     -- надомно обслужване: handlers/housebound.js
                     'Обслужване по домовете', 'Посещение по домовете')`;
  const AUDIT_MONEY_WHERE = `substr(ts, 1, 10) < ? AND action IN ${MONEY_ACTIONS}
      AND detail IS NOT NULL AND instr(detail, ' — ') > 0
      AND detail NOT LIKE '[анонимизиран читател]%'`;
  const AUDIT_NAME_WHERE = `substr(ts, 1, 10) < ? AND action IN ${NAME_ACTIONS}
      AND COALESCE(detail, '') != '[анонимизирано по GDPR]'`;

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
      const auditCount = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${AUDIT_MONEY_WHERE}`).get(cutoff).n
        + db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${AUDIT_NAME_WHERE}`).get(cutoff).n;
      const searchCount = db.prepare('SELECT COUNT(*) AS n FROM search_history WHERE substr(ts, 1, 10) < ?').get(cutoff).n;
      return { years, count, auditCount, searchCount, cutoff };
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
        const auditCleared = anonMoney + anonNames;

        /* Историята на търсенията пази свободния текст, който библиотекарят е
           набрал — а той често е точно име на читател. Тя не е документ и няма
           стойност след срока, затова старите редове отпадат. */
        const searchCleared = db.prepare('DELETE FROM search_history WHERE substr(ts, 1, 10) < ?')
          .run(cutoff).changes;

        return { n, auditCleared, searchCleared };
      });
      const { n, auditCleared, searchCleared } = tx.immediate();
      // Съгласуване в единствено число (одит v2.4.24) — този ред отива в следата,
      // която проверяващият чете.
      logAudit('Анонимизиране',
        (n === 1 ? '1 върнато заемане отпреди ' + cutoff + ' е анонимизирано'
                 : n + ' върнати заемания отпреди ' + cutoff + ' са анонимизирани')
        + (auditCleared ? '; ' + (auditCleared === 1 ? '1 запис в одитната следа е обезличен'
            : auditCleared + ' записа в одитната следа са обезличени') : '')
        + (searchCleared ? '; ' + (searchCleared === 1 ? '1 старо търсене е изтрито'
            : searchCleared + ' стари търсения са изтрити') : ''));
      return { anonymized: n, auditCleared, searchCleared, cutoff };
    })
  );
};
