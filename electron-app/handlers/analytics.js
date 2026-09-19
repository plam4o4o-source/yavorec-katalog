// Краеведски модул: Аналитично описание (статии и части от книги) —
// извадено от main.js в отделен модул (Фаза 4, стъпка 31). Зависи само от
// getDb, run, logAudit — никакви споделени функции с другите краеведски
// подмодули (persons/chronicle/local-photo/links), само общи таблици.
const { isValidIsoDate } = require('../security-utils');

/* Регистър на кирилицата, LIKE-заместителите и ключът за подредба по година —
   ПЪЛНАТА бележка защо е така и защо не е FTS5 стои в handlers/chronicle.js
   (v2.4.61). Накратко: „яворец“ не намираше „Яворец през вековете“, „%“ връщаше
   целия указател, а ORDER BY year нареждаше годините текстово. */
const KRAE_FN_READY = new WeakSet();
function ensureKraeFunctions(db) {
  if (KRAE_FN_READY.has(db)) return db;
  db.function('bglower', (s) => (s == null ? null : String(s).toLowerCase()));
  db.function('yearkey', (s) => { const m = /\d{3,4}/.exec(String(s == null ? '' : s)); return m ? Number(m[0]) : null; });
  KRAE_FN_READY.add(db);
  return db;
}
function bgLikeArg(raw) {
  return '%' + String(raw == null ? '' : raw).toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
}

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
  /* ЧИСЛОВИТЕ ВРЪЗКИ СЕ ПАЗЯТ КАТО ЧИСЛА (v2.4.61).
     =====================================================================
     Формата подава book_id от СКРИТО поле, а скритото поле на HTML е текст:
     оттам id-то идва като „1“, не като 1. Дотук analyticParams го подаваше на
     SQLite както си е и в колоната book_id (INTEGER REFERENCES books(id))
     лягаше НИЗ. SQLite приема това мълчаливо (динамични типове), но всяко
     сравнение в JavaScript след това е между 1 и „1“ — и точно на това се
     спъна analytics:update по-долу.

     Затова нормализирането е ТУК, на едно място: и вмъкването, и редакцията,
     и проверката за пренасочване гледат едно и също число. Number() върху
     празен низ дава 0, затова празното се превежда изрично в NULL. */
  function idOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  }
  /* ЕДНО ОПИСАНИЕ БЕЗ ПРОВЕРЕНИ ЧИСЛА И ДАТИ Е ГРЕШЕН БИБЛИОГРАФСКИ ЗАПИС
     (v2.4.61). Указателят на статиите се РАЗПЕЧАТВА и се дава на читателя — по
     него човек търси статията в конкретен брой на вестника. Дотук през този
     канал минаваха: година „abc“ (която после стоеше като избираема година във
     филтъра „— всички години —“), страници „-5“ и дата на броя „27.05.2022“
     (български изпис вместо ISO), която bg() показва като безсмислица, а
     подредбата по дата подминава.

     Годината остава СВОБОДЕН текст по замисъл (статия от „ок. 1930 г.“ е
     истинско краеведско сведение) — иска се само да съдържа число от 3 или 4
     цифри. Страниците също са свободен текст („12 – 14“, „45 – 61“, „с. 7“),
     затова проверката е най-слабата възможна, но достатъчна: трябва да има
     цифра и да не започва с минус — отрицателна страница няма. */
  function checkAnalytic(o) {
    if (!String(o.title ?? '').trim()) throw new Error('Заглавието на статията е задължително.');
    const year = String(o.year ?? '').trim();
    if (year && !/(^|\D)\d{3,4}(\D|$)/.test(year)) {
      throw new Error('Годината „' + year + '“ не съдържа година. Впишете число от 3 или 4 цифри — '
        + 'самò („1999“) или с уточнение („ок. 1930“).');
    }
    o.year = year || null;
    const pages = String(o.pages ?? '').trim();
    if (pages && (!/\d/.test(pages) || /^-/.test(pages))) {
      throw new Error('Страниците „' + pages + '“ не са страници. Впишете ги както стоят в изданието — '
        + 'напр. „12 – 14“ или „7“.');
    }
    o.pages = pages || null;
    const issueDate = String(o.issue_date ?? '').trim();
    if (issueDate && !isValidIsoDate(issueDate)) {
      throw new Error('Датата на броя „' + issueDate + '“ не е валидна дата. Въведете ден, месец и '
        + 'година (напр. 27.05.2022) или оставете полето празно.');
    }
    o.issue_date = issueDate || null;
    /* ИЗТОЧНИКЪТ Е ЗАДЪЛЖИТЕЛЕН (v2.4.61). Описание с вид „книга“, но без
       избрана книга (и без свободен текст) се записваше и в указателя, и на
       хартия излизаше с източник „—“. Аналитичното описание описва статия В
       НЕЩО; без източника то не е библиографски запис, а бележка — читателят
       държи разпечатка, на която пише заглавие и нищо повече. Свободният текст
       остава пълноправен изход за издание, което библиотеката не притежава. */
    const freeText = String(o.source_text ?? '').trim();
    if (o.source_kind === 'книга' && !o.book_id && !freeText) {
      throw new Error('Вид източник „книга“, но книга от фонда не е избрана. Изберете документа от '
        + 'полето „Книга от фонда“ или опишете изданието в полето „Описание на източника със '
        + 'свободен текст“.');
    }
    if (o.source_kind === 'периодика' && !o.periodical_id && !freeText) {
      throw new Error('Вид източник „периодика“, но периодично издание не е избрано. Изберете изданието '
        + 'или опишете броя в полето „Описание на източника със свободен текст“.');
    }
    return o;
  }
  function analyticParams(d) {
    const o = {};
    for (const f of ANALYTIC_FIELDS) o[f] = d[f] ?? null;
    o.is_local = d.is_local ? 1 : 0;
    o.periodical_id = idOrNull(d.periodical_id);
    o.book_id = idOrNull(d.book_id);
    return checkAnalytic(o);
  }
  ipcMain.handle('analytics:list', (e, { q, year, onlyLocal } = {}) =>
    run(() => {
      const db = ensureKraeFunctions(getDb());
      const where = [], args = {};
      /* Търсенето обхваща и ПОДЗАГЛАВИЕТО, УДК и БРОЯ (v2.4.61): подзаглавието
         носи вида на материала („репортаж“, „интервю“), по УДК се търси цял
         раздел от краеведския масив, а „бр. 21“ е начинът, по който човек пита
         за конкретен вестник. */
      if (q) {
        where.push(`(bglower(a.title) LIKE @q ESCAPE '\\' OR bglower(a.subtitle) LIKE @q ESCAPE '\\'
                     OR bglower(a.author) LIKE @q ESCAPE '\\' OR bglower(a.keywords) LIKE @q ESCAPE '\\'
                     OR bglower(a.annotation) LIKE @q ESCAPE '\\' OR bglower(a.source_text) LIKE @q ESCAPE '\\'
                     OR bglower(a.udk) LIKE @q ESCAPE '\\' OR bglower(a.issue) LIKE @q ESCAPE '\\'
                     OR bglower(p.title) LIKE @q ESCAPE '\\' OR bglower(b.title) LIKE @q ESCAPE '\\')`);
        args.q = bgLikeArg(q);
      }
      if (year) { where.push('a.year = @year'); args.year = String(year); }
      if (onlyLocal) where.push('a.is_local = 1');
      const sql = ANALYTIC_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
        ' ORDER BY yearkey(a.year) DESC, a.year DESC, a.title';
      return db.prepare(sql).all(args);
    })
  );
  ipcMain.handle('analytics:get', (e, id) =>
    run(() => getDb().prepare(`${ANALYTIC_SELECT} WHERE a.id = ?`).get(id))
  );
  ipcMain.handle('analytics:years', () =>
    run(() => ensureKraeFunctions(getDb()).prepare(`SELECT year, COUNT(*) AS n FROM analytics
      WHERE year IS NOT NULL AND year <> '' GROUP BY year ORDER BY yearkey(year) DESC, year DESC`).all())
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
      const note = deaccNote(getDb(), idOrNull(d.book_id));
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
         същото решение като новото описание и се отказва по същия начин.

         СРАВНЕНИЕТО Е ЧИСЛОВО (v2.4.61). Дотук тук стоеше `cur.book_id !==
         nextBook`: от базата идва ЧИСЛО (1), а от формата — НИЗ („1“, скритото
         поле на HTML), и строгото сравнение обявяваше всяка редакция за
         „пренасочване към нова книга“. Последицата беше точно обратното на
         замисленото: коментарът три реда по-горе обещава, че съществуващо
         описание НЕ се пренасочва и че правописна грешка в анотацията се
         поправя винаги — а на практика описание, чиято книга-източник е
         отчислена, ставаше НЕРЕДАКТИРУЕМО от екрана. Библиотекарката поправя
         бележката, натиска „Запиши“ и получава „описанието не може да бъде
         пренасочено към нея“ за книга, която изобщо не е пипала; редакцията
         минаваше само през API с числов book_id, тоест никъде от прозореца.
         Двете страни вече минават през idOrNull() и се сравняват като числа. */
      const cur = getDb().prepare('SELECT book_id FROM analytics WHERE id = ?').get(d.id);
      const nextBook = idOrNull(d.book_id);
      if (nextBook && (!cur || idOrNull(cur.book_id) !== nextBook)) {
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
