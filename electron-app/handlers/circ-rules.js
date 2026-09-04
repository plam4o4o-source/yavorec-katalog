// Правила за обслужване по категория читатели — извадени от main.js в
// отделен модул (Фаза 4, стъпка 5 от разбиването на монолита на модули по
// домейн). Всяко поле в circulation_rules, оставено NULL, пада обратно към
// глобалната настройка от settings — библиотека, която не пипа тази
// таблица, работи точно както преди (нулев риск от регресия при първо
// стартиране след ъпгрейд).
//
// Същия модел като handlers/calendar.js: circRule/readerCategory се връщат
// обратно към main.js, защото ги ползва и домейнът "Заемания" (все още
// неизваден) — за да изчислява ефективния срок за заемане/лимит на конкретния
// читател вместо винаги глобалните настройки.
module.exports = function registerCircRulesHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  function circRule(category) {
    const db = getDb();
    const g = db.prepare(`SELECT loan_days, max_books, extensions_count, extension_days,
      suspend_per_day, suspend_max FROM settings WHERE id = 1`).get() || {};
    if (!category) return withDefaults(g);
    const r = db.prepare('SELECT * FROM circulation_rules WHERE category = ?').get(category);
    // И тук с подразбиращите се (преглед на кръга): това е НАЙ-честият път —
    // читател с категория, за която няма отделно правило.
    if (!r) return withDefaults(g);
    const pick = (k) => (r[k] != null ? r[k] : g[k]);
    return withDefaults({
      loan_days: pick('loan_days'), max_books: pick('max_books'),
      extensions_count: pick('extensions_count'), extension_days: pick('extension_days'),
      suspend_per_day: pick('suspend_per_day'), suspend_max: pick('suspend_max')
    });
  }
  /* Сроковете винаги са число (одит v2.4.25). От v2.4.24 изчистена обща настройка е
     NULL, а обработчиците на заемането падат към 30 (`s.loan_days || 30`) — екранът
     на гишето обаче печаташе „Срок за заемане: null дни“. Подразбиращото се живее
     на ЕДНО място, тук, и екранът и гишето казват едно и също. Останалите полета
     нарочно остават NULL: за тях NULL значи „без лимит“/„изключено“ и консуматорите
     го тълкуват сами. */
  /* Одит v2.4.26 (преглед на поправките от v2.4.25): дотук тук минаваха покрай
     подразбиращото се само null/'' — а редове, записани ПРЕДИ валидацията в
     circRules:save по-горе (всяка версия преди v2.4.25 приемаше `Number(v)` без
     граница), можеха да носят буквално 0 или отрицателно число. Такъв ред се
     показваше на екрана като „Срок за заемане: 0 дни“ (или отрицателен), докато
     handlers/loans.js смята датата с `s.loan_days || 30` — 0 е falsy, тоест
     реално се прилагат 30 дни. Точно разминаването между показано и приложено,
     което тази поредица от кръгове съществува да затваря. Миграция 13 чисти
     заварените редове; тази проверка е предпазна мрежа за база, отворена преди
     обновяването на друго работно място. */
  function withDefaults(o) {
    o.loan_days = o.loan_days == null || o.loan_days === '' || o.loan_days <= 0 ? 30 : o.loan_days;
    o.extension_days = o.extension_days == null || o.extension_days === '' || o.extension_days <= 0 ? 30 : o.extension_days;
    return o;
  }
  function readerCategory(readerId) {
    const r = getDb().prepare('SELECT category FROM readers WHERE id = ?').get(readerId);
    return r ? r.category : null;
  }

  ipcMain.handle('circRules:list', () => run(() => getDb().prepare('SELECT * FROM circulation_rules ORDER BY category').all()));
  ipcMain.handle('circRules:save', (e, rule) =>
    run(() => {
      const category = String((rule && rule.category) || '').trim();
      if (!category) throw new Error('Категорията е задължителна.');
      /* Проверка на стойностите (одит v2.4.25). Дотук Number() без граница:
         max_books = -1 правеше `s.max_books && current >= -1` винаги вярно и всяко
         заемане получаваше „Достигнат е лимитът от -1 документа“; loan_days = -5
         даваше падеж преди заемането; 1.5 влизаше в INTEGER колона; „abc“ → NaN →
         NULL мълчаливо. Празно = „общото“ (NULL). Сроковете са ≥ 1; лимитът и
         броят продължения — ≥ 0 (0 = без лимит, както казва подсказката);
         наказанието — ≥ 0 с половинки; таванът — ≥ 0. Нулев срок не значи нищо
         смислено и също пада към „общото“. */
      const LABELS = {
        loan_days: 'Срок за заемане', max_books: 'Макс. документи', extensions_count: 'Брой продължения',
        extension_days: 'Дни за продължение', suspend_per_day: 'Наказание на ден', suspend_max: 'Таван на наказанието'
      };
      const num = (v, k) => {
        if (v === '' || v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error('Стойността на „' + LABELS[k] + '“ трябва да е число или празно (= общата стойност).');
        const integer = k !== 'suspend_per_day';
        if (integer && !Number.isInteger(n)) throw new Error('Стойността на „' + LABELS[k] + '“ трябва да е цяло число.');
        if (n < 0) throw new Error('Стойността на „' + LABELS[k] + '“ не може да е отрицателна.');
        if ((k === 'loan_days' || k === 'extension_days') && n === 0) return null; // 0 дни = общата стойност
        return n;
      };
      getDb().prepare(`
        INSERT INTO circulation_rules (category, loan_days, max_books, extensions_count, extension_days, suspend_per_day, suspend_max)
        VALUES (@category, @loan_days, @max_books, @extensions_count, @extension_days, @suspend_per_day, @suspend_max)
        ON CONFLICT(category) DO UPDATE SET
          loan_days=excluded.loan_days, max_books=excluded.max_books, extensions_count=excluded.extensions_count,
          extension_days=excluded.extension_days, suspend_per_day=excluded.suspend_per_day, suspend_max=excluded.suspend_max
      `).run({
        category, loan_days: num(rule.loan_days, 'loan_days'), max_books: num(rule.max_books, 'max_books'),
        extensions_count: num(rule.extensions_count, 'extensions_count'), extension_days: num(rule.extension_days, 'extension_days'),
        suspend_per_day: num(rule.suspend_per_day, 'suspend_per_day'), suspend_max: num(rule.suspend_max, 'suspend_max')
      });
      logAudit('Правила за обслужване', 'категория „' + category + '“');
    })
  );
  ipcMain.handle('circRules:delete', (e, category) =>
    run(() => {
      const info = getDb().prepare('DELETE FROM circulation_rules WHERE category = ?').run(category);
      if (!info.changes) throw new Error('Няма правило за категория „' + category + '“.');
      logAudit('Правила за обслужване', 'категория „' + category + '“ — правилото е изтрито, важи общото');
    })
  );
  // Ефективното правило (с падналите обратно към глобалните стойности) — за да показва
  // интерфейсът реалния срок/лимит на читателя, а не винаги глобалните настройки.
  ipcMain.handle('circRules:effective', (e, category) => run(() => circRule(category)));

  return { circRule, readerCategory };
};
