// Краеведски модул: Летопис — извадено от main.js в отделен модул
// (Фаза 4, стъпка 31). Зависи само от getDb, run, logAudit.
const { isValidIsoDate } = require('../security-utils');

/* ТЪРСЕНЕТО В КРАЕЗНАНИЕТО: РЕГИСТЪР НА КИРИЛИЦАТА И LIKE-ЗАМЕСТИТЕЛИТЕ (v2.4.61)
   =========================================================================
   Тази бележка е за ЦЕЛИЯ краеведски дял — същите шест реда стоят и в
   handlers/persons.js, handlers/analytics.js и handlers/links.js. Нарочно са
   преписани, а не извадени в общ модул: петте краеведски подмодула са писани
   така, че да НЕ зависят един от друг (виж заглавната бележка на
   handlers/analytics.js), и една обща помощна функция би направила точно тази
   зависимост заради осем реда код.

   КАКВО БЕШЕ СЧУПЕНО. Търсенето тук минаваше през `title LIKE '%' || q || '%'`.
   SQLite сравнява LIKE без оглед на регистъра САМО за латиницата (ASCII) —
   вградената таблица не знае нищо за кирилицата. Тоест „основаване“ НЕ намираше
   „Основаване на читалището“, а „яворец“ не намираше „Яворец през вековете“.
   Библиотекарката, която пише с малки букви (а в търсачка се пише с малки
   букви), получаваше „няма намерени“ за запис, който стои на две реда под нея,
   и заключаваше, че краеведският ѝ масив не е вписан. Книгите и читателите
   отдавна нямат този проблем — те минават през FTS5 с tokenize='unicode61'
   (виж search-fts.js), който сгъва регистъра с Unicode-таблици.

   ЗАЩО НЕ FTS5 И ТУК. FTS5 индекс се строи с миграция, тригери за всяка таблица
   и rebuild — и се пише в main.js и db/schema.sql, които този кръг не се пипат.
   Освен това краеведските таблици са от порядъка на хиляди редове (не стотици
   хиляди като заеманията), а търсенето е „съдържа навсякъде“, не префиксно.
   Затова се регистрира собствена SQL функция `bglower()`, която е просто
   JavaScript-ското toLowerCase() — то знае кирилицата. Цената е, че индексът по
   title не се ползва при търсене; при 3 000 записа това е под милисекунда.

   LIKE-ЗАМЕСТИТЕЛИТЕ. Второто счупено нещо: „%“ и „_“ в текста на търсенето са
   ЗАМЕСТИТЕЛИ за LIKE, а не знаци. Търсене на „100%“ връщаше ЦЕЛИЯ летопис (и
   целия фонд в links:search), а „Н_ва“ намираше „Нова читалня“. За краеведа
   това е тихо грешен резултат: той вижда списък и няма как да разбере, че не е
   отговорът на въпроса му. Затова `%`, `_` и самата наклонена черта се
   екранират, а всяко LIKE получава ESCAPE '\'.

   `yearkey()` е същият ключ, по който разпечатката на летописа вече подрежда
   годините (виж printChronicle в src/views/chronicle.js): първото число от 3
   или 4 цифри в свободния текст на годината. Без него ORDER BY year нареждаше
   ТЕКСТОВО и „ок. 1930“ излизаше пред 2026 г., а „900“ — след „1999“. */
const KRAE_FN_READY = new WeakSet();
function ensureKraeFunctions(db) {
  if (KRAE_FN_READY.has(db)) return db;
  db.function('bglower', (s) => (s == null ? null : String(s).toLowerCase()));
  db.function('yearkey', (s) => { const m = /\d{3,4}/.exec(String(s == null ? '' : s)); return m ? Number(m[0]) : null; });
  KRAE_FN_READY.add(db);
  return db;
}
// Текстът на търсенето → безопасен аргумент за `bglower(колона) LIKE @q ESCAPE '\'`.
function bgLikeArg(raw) {
  return '%' + String(raw == null ? '' : raw).toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
}

module.exports = function registerChronicleHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  const CHRONICLE_FIELDS = ['year', 'date', 'title', 'body', 'category', 'participants', 'sources', 'note'];

  /* ГОДИНАТА СЕ ВОДИ ОТ ДАТАТА, А НЕ ОТ ТОВА, КОЕТО ФОРМАТА Е ПРЕДЛОЖИЛА (v2.4.61).
     =======================================================================
     Дотук тук стоеше `if (!o.year && o.date) o.year = ...` — годината се
     извеждаше САМО когато липсва. А формата „Нов запис в летописа“ предлага
     текущата година в полето (така и трябва: повечето записи са от тази
     година). Тоест краеведът, който вписва основаването на читалището и
     въвежда точната дата 24.05.1922, получаваше запис с ГОДИНА 2026: на екрана
     под заглавието „2026“, в разпечатания летопис — в последната група, а във
     филтъра по години 1922 г. изобщо я няма. Летописът е хронология; запис в
     грешната година е загубен запис, а грешката личи чак когато някой чете
     разпечатката и се чуди защо читалището е основано тази година.

     Затова: когато има точна дата, тя е по-силна от текста в полето „Година“.
     Ако полето е празно — годината се взема от датата. Ако не е празно, но
     НЕ съдържа годината на датата (1950 срещу дата от 1951 г.), записът се
     ОТКАЗВА вместо да се поправя мълчаливо: разминаването е грешка на въвеждане
     и само човекът знае кое от двете е вярното. Свободният текст остава
     възможен („ок. 1930“, „1878 – 1880“) — проверява се само че съдържа
     годината на датата, а не че е равен на нея.

     ДАТАТА СЕ ПРОВЕРЯВА (isValidIsoDate, както books/loans/актовете). Дотук
     `'24.05.1926'` (български изпис вместо ISO) влизаше както си е и годината
     ставаше „24.0“ — първите четири знака. Такъв запис не се намира по година,
     не се подрежда и не се вижда в нито един филтър.

     ГОДИНАТА е свободен текст по замисъл („ок. 1930“ е истинско краеведско
     сведение), но текст БЕЗ число не е година: „abc“ влизаше в базата и после
     стоеше в падащото меню „— всички години —“ като избираема година. Затова
     единственото изискване е да има число от 3 или 4 цифри. */
  function prepareChronicle(d) {
    const o = {};
    for (const f of CHRONICLE_FIELDS) o[f] = d[f] ?? null;
    const date = String(o.date ?? '').trim();
    const year = String(o.year ?? '').trim();
    if (date) {
      if (!isValidIsoDate(date)) {
        throw new Error('„' + date + '“ не е валидна дата. Точната дата на събитието се въвежда като '
          + 'ден, месец и година (напр. 24.05.1922) — ако точният ден не е известен, оставете полето '
          + 'празно и попълнете само годината.');
      }
      o.date = date;
      const fromDate = date.slice(0, 4);
      const inYear = year.match(/\d{3,4}/g) || [];
      if (!year) o.year = fromDate;
      else if (!inYear.includes(fromDate)) {
        throw new Error('Годината „' + year + '“ не отговаря на датата ' + date.slice(8) + '.' + date.slice(5, 7)
          + '.' + fromDate + ' г. Поправете едното от двете — записът трябва да попадне в годината, '
          + 'в която се е случило събитието.');
      } else o.year = year;
    } else {
      o.date = null;
      o.year = year;
    }
    if (!String(o.year).trim()) {
      throw new Error('Годината е задължителна — летописът се води по години. Ако точната година не е '
        + 'известна, впишете я както е известна: напр. „ок. 1930“.');
    }
    if (!/(^|\D)\d{3,4}(\D|$)/.test(String(o.year))) {
      throw new Error('Годината „' + o.year + '“ не съдържа година. Впишете число от 3 или 4 цифри — '
        + 'самò („1922“) или с уточнение („ок. 1930“, „1878 – 1880“).');
    }
    o.year = String(o.year).trim();
    return o;
  }

  ipcMain.handle('chronicle:list', (e, { q, year } = {}) =>
    run(() => {
      const db = ensureKraeFunctions(getDb());
      const where = [], args = {};
      /* Търсенето обхваща и ИЗТОЧНИЦИТЕ и ЗАБЕЛЕЖКАТА (v2.4.61): краеведът
         най-често търси „по кой протокол сме го записали това“ — а именно
         протоколът, вестникът и споменът стоят в „Източници“. */
      if (q) {
        where.push(`(bglower(c.title) LIKE @q ESCAPE '\\' OR bglower(c.body) LIKE @q ESCAPE '\\'
                     OR bglower(c.participants) LIKE @q ESCAPE '\\' OR bglower(c.sources) LIKE @q ESCAPE '\\'
                     OR bglower(c.note) LIKE @q ESCAPE '\\')`);
        args.q = bgLikeArg(q);
      }
      if (year) { where.push('c.year = @year'); args.year = String(year); }
      return db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM links l WHERE l.from_kind = 'летопис' AND l.from_id = c.id) AS links
        FROM chronicle c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY yearkey(c.year) DESC, c.year DESC, c.date DESC, c.id DESC`).all(args);
    })
  );
  ipcMain.handle('chronicle:get', (e, id) => run(() => getDb().prepare('SELECT * FROM chronicle WHERE id = ?').get(id)));
  ipcMain.handle('chronicle:years', () =>
    run(() => ensureKraeFunctions(getDb()).prepare(`SELECT year, COUNT(*) AS n FROM chronicle
      GROUP BY year ORDER BY yearkey(year) DESC, year DESC`).all())
  );
  ipcMain.handle('chronicle:create', (e, d) =>
    run(() => {
      const o = prepareChronicle(d);
      const info = getDb().prepare(`INSERT INTO chronicle (${CHRONICLE_FIELDS.join(', ')})
        VALUES (${CHRONICLE_FIELDS.map(f => '@' + f).join(', ')})`).run(o);
      logAudit('Летопис', 'нов запис: ' + (o.year || '') + ' — ' + (o.title || ''));
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('chronicle:update', (e, d) =>
    run(() => {
      /* Липсващият ред е ОТКАЗ, а не тиха успешна редакция: при обща мрежова
         база записът може да е изтрит от другото работно място, а одитната
         следа не бива да твърди редакция, каквато не се е случвала.
         Проверката е ПРЕДИ проверките на съдържанието (v2.4.61): когато записът
         вече го няма, вярното съобщение е „изтрит е от друго работно място“, а
         не забележка за годината — иначе библиотекарката тръгва да поправя поле
         в запис, който не съществува. */
      if (!getDb().prepare('SELECT id FROM chronicle WHERE id = ?').get(d.id)) {
        throw new Error('Записът не е намерен — вероятно е изтрит от друго работно място.');
      }
      const o = prepareChronicle(d);
      const info = getDb().prepare(`UPDATE chronicle SET ${CHRONICLE_FIELDS.map(f => f + ' = @' + f).join(', ')} WHERE id = @id`)
        .run({ ...o, id: d.id });
      if (!info.changes) throw new Error('Записът не е намерен — вероятно е изтрит от друго работно място.');
      logAudit('Летопис', 'редакция: ' + (o.title || ''));
    })
  );
  ipcMain.handle('chronicle:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const c = db.prepare('SELECT title FROM chronicle WHERE id = ?').get(id);
      /* ИЗТРИВАНЕ НА НЕСЪЩЕСТВУВАЩ ЗАПИС НЕ Е УСПЕХ (v2.4.61).
         Дотук липсващият запис минаваше по тихия път: DELETE не пипаше нищо,
         каналът връщаше успех, екранът казваше „Записът е изтрит.“ и в одитния
         дневник оставаше ред „изтрит запис: 41“ — изтриване, което не се е
         случило, вписано като случило се. При обща мрежова база това е точно
         случаят „другото работно място вече го изтри“, а при проверка одитната
         следа трябва да отговаря на действителността ред по ред: два реда за
         едно изтриване са две изтривания. Затова отказ, с обяснение защо. */
      if (!c) throw new Error('Записът не е намерен — вероятно вече е изтрит от друго работно място. '
        + 'Нищо не е променено.');
      db.transaction(() => {
        db.prepare("DELETE FROM links WHERE (from_kind = 'летопис' AND from_id = ?) OR (to_kind = 'летопис' AND to_id = ?)").run(id, id);
        db.prepare('DELETE FROM chronicle WHERE id = ?').run(id);
      }).immediate();
      logAudit('Летопис', 'изтрит запис: ' + c.title);
    })
  );
};
