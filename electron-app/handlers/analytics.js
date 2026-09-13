// Краеведски модул: Аналитично описание (статии и части от книги) —
// извадено от main.js в отделен модул (Фаза 4, стъпка 31). Зависи само от
// getDb, run, logAudit — никакви споделени функции с другите краеведски
// подмодули (persons/chronicle/local-photo/links), само общи таблици.
module.exports = function registerAnalyticsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  const ANALYTIC_FIELDS = ['title', 'subtitle', 'author', 'source_kind', 'periodical_id', 'book_id',
    'source_text', 'year', 'issue', 'issue_date', 'pages', 'udk', 'keywords', 'annotation',
    'is_local', 'note'];
  // Източникът се сглобява за показване: или от свързания запис във фонда, или от
  // свободния текст, когато изданието не е налично в библиотеката.
  /* ИЗТОЧНИКЪТ, КОЙТО ВЕЧЕ ГО НЯМА ВЪВ ФОНДА (v2.4.57).
     =====================================================================
     Аналитичното описание сочи статия В КНИГА от фонда. Когато книгата се
     отчисли с утвърден акт, описанието правилно остава — то описва статията, а
     не притежанието. Но analytics:list показваше източника като жив: „Вазов,
     Иван. Под игото (инв. № 5)“, дума по дума същото както преди акта. Списъкът
     „Аналитични описания“ е и указател, който се РАЗПЕЧАТВА и се дава на
     читателя; така библиотеката праща човек да иска инвентарен номер, който вече
     не съществува, и научава за това чак на гишето.

     Белегът се долепя към book_title, а не се връща като отделно поле, и това е
     съзнателно: същият низ се ползва от прозореца на две места (описанието на
     източника и полето „Книга от фонда“), а полето „Книга от фонда“ се сравнява
     ЗНАК ПО ЗНАК с етикета от links:search, за да намери book_id (виж дългата
     бележка в src/views/analytics.js, одит v2.4.29). Затова белегът е точно
     същият и точно на същото място, както в links.js — така двата етикета
     остават еднакви и връзката не се къса при редакция.

     Анулиран акт не се брои: документът по него е върнат във фонда. */
  const ANALYTIC_SELECT = `
    SELECT a.*,
           p.title AS periodical_title,
           b.title || CASE WHEN b.status = 'отчислен'
             THEN COALESCE(' (отчислен с акт № ' || da.no || '/' || da.year || ')', ' (отчислен)')
             ELSE '' END AS book_title,
           b.author AS book_author, b.inv_number AS book_inv,
           b.status AS book_status
    FROM analytics a
    LEFT JOIN periodicals p ON p.id = a.periodical_id
    LEFT JOIN books b ON b.id = a.book_id
    LEFT JOIN deaccession_acts da ON da.id = b.deaccession_act_id AND da.revoked_at IS NULL
  `;
  /* Дали книгата, към която се сочи, е отчислена — и с кой акт. Ползва се от
     отказа при НОВО описание (виж analytics:create). Анулираните актове не се
     броят, както навсякъде. */
  function deaccNote(db, bookId) {
    if (!bookId) return null;
    const b = db.prepare(`
      SELECT b.status, da.no, da.year FROM books b
      LEFT JOIN deaccession_acts da ON da.id = b.deaccession_act_id AND da.revoked_at IS NULL
      WHERE b.id = ?`).get(bookId);
    if (!b || b.status !== 'отчислен') return null;
    return b.no != null ? 'отчислен с акт № ' + b.no + '/' + b.year : 'отчислен';
  }
  function analyticParams(d) {
    const o = {};
    for (const f of ANALYTIC_FIELDS) o[f] = d[f] ?? null;
    o.is_local = d.is_local ? 1 : 0;
    o.periodical_id = d.periodical_id || null;
    o.book_id = d.book_id || null;
    return o;
  }
  ipcMain.handle('analytics:list', (e, { q, year, onlyLocal } = {}) =>
    run(() => {
      const db = getDb();
      const where = [], args = {};
      if (q) {
        where.push(`(a.title LIKE @q OR a.author LIKE @q OR a.keywords LIKE @q OR a.annotation LIKE @q
                     OR a.source_text LIKE @q OR p.title LIKE @q OR b.title LIKE @q)`);
        args.q = '%' + q + '%';
      }
      if (year) { where.push('a.year = @year'); args.year = String(year); }
      if (onlyLocal) where.push('a.is_local = 1');
      const sql = ANALYTIC_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
        ' ORDER BY a.year DESC, a.title';
      return db.prepare(sql).all(args);
    })
  );
  ipcMain.handle('analytics:get', (e, id) =>
    run(() => getDb().prepare(`${ANALYTIC_SELECT} WHERE a.id = ?`).get(id))
  );
  ipcMain.handle('analytics:years', () =>
    run(() => getDb().prepare(`SELECT year, COUNT(*) AS n FROM analytics
      WHERE year IS NOT NULL AND year <> '' GROUP BY year ORDER BY year DESC`).all())
  );
  ipcMain.handle('analytics:create', (e, d) =>
    run(() => {
      /* НОВО описание към ОТЧИСЛЕН документ се отказва (v2.4.57).
         Огледалната грижа вече съществува от другата страна: books:delete
         изрично отказва изтриване на документ, към който има аналитични
         описания — за да не останат висящи. Тук същото правило липсваше и
         висящата връзка можеше да се направи НАРОЧНО, без нито дума.
         Отказът е само за НОВИ описания. Редакцията на вече съществуващо
         описание не се пипа (виж analytics:update): книгата може да е отчислена
         години след като статията е описана, а забраната да се поправи правописна
         грешка в анотацията не помага на никого. */
      const note = deaccNote(getDb(), d.book_id || null);
      if (note) {
        throw new Error('Книгата източник е ' + note + ' и вече не е част от фонда — ново аналитично описание '
          + 'към нея не се прави. Опишете изданието в полето „Описание на източника със свободен текст“.');
      }
      const info = getDb().prepare(`INSERT INTO analytics (${ANALYTIC_FIELDS.join(', ')})
        VALUES (${ANALYTIC_FIELDS.map(f => '@' + f).join(', ')})`).run(analyticParams(d));
      logAudit('Аналитично описание', 'нова статия: ' + (d.title || ''));
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('analytics:update', (e, d) =>
    run(() => {
      /* При редакция се проверява само ПРЕНАСОЧВАНЕТО към нова книга. Ако
         описанието вече сочи отчислен документ, то си остава — виж защо в
         analytics:create. Но да се ЗАКАЧИ описание за отчислен документ днес е
         същото решение като новото описание и се отказва по същия начин. */
      const cur = getDb().prepare('SELECT book_id FROM analytics WHERE id = ?').get(d.id);
      const nextBook = d.book_id || null;
      if (nextBook && (!cur || cur.book_id !== nextBook)) {
        const note = deaccNote(getDb(), nextBook);
        if (note) {
          throw new Error('Книгата източник е ' + note + ' и вече не е част от фонда — описанието не може да бъде '
            + 'пренасочено към нея. Опишете изданието в полето „Описание на източника със свободен текст“.');
        }
      }
      /* Липсващият ред е ОТКАЗ, а не тиха успешна редакция: при обща мрежова
         база записът може да е изтрит от другото работно място, а одитната
         следа не бива да твърди редакция, каквато не се е случвала. */
      const info = getDb().prepare(`UPDATE analytics SET ${ANALYTIC_FIELDS.map(f => f + ' = @' + f).join(', ')} WHERE id = @id`)
        .run({ ...analyticParams(d), id: d.id });
      if (!info.changes) throw new Error('Описанието не е намерено — вероятно е изтрито от друго работно място.');
      logAudit('Аналитично описание', 'редакция: ' + (d.title || ''));
    })
  );
  ipcMain.handle('analytics:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const a = db.prepare('SELECT title FROM analytics WHERE id = ?').get(id);
      db.transaction(() => {
        db.prepare("DELETE FROM links WHERE to_kind = 'статия' AND to_id = ?").run(id);
        db.prepare('DELETE FROM analytics WHERE id = ?').run(id);
      }).immediate();
      logAudit('Аналитично описание', 'изтрита статия: ' + (a ? a.title : id));
    })
  );
};
