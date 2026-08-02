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
    if (!category) return g;
    const r = db.prepare('SELECT * FROM circulation_rules WHERE category = ?').get(category);
    if (!r) return g;
    const pick = (k) => (r[k] != null ? r[k] : g[k]);
    return {
      loan_days: pick('loan_days'), max_books: pick('max_books'),
      extensions_count: pick('extensions_count'), extension_days: pick('extension_days'),
      suspend_per_day: pick('suspend_per_day'), suspend_max: pick('suspend_max')
    };
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
      const num = (v) => (v === '' || v == null ? null : Number(v));
      getDb().prepare(`
        INSERT INTO circulation_rules (category, loan_days, max_books, extensions_count, extension_days, suspend_per_day, suspend_max)
        VALUES (@category, @loan_days, @max_books, @extensions_count, @extension_days, @suspend_per_day, @suspend_max)
        ON CONFLICT(category) DO UPDATE SET
          loan_days=excluded.loan_days, max_books=excluded.max_books, extensions_count=excluded.extensions_count,
          extension_days=excluded.extension_days, suspend_per_day=excluded.suspend_per_day, suspend_max=excluded.suspend_max
      `).run({
        category, loan_days: num(rule.loan_days), max_books: num(rule.max_books),
        extensions_count: num(rule.extensions_count), extension_days: num(rule.extension_days),
        suspend_per_day: num(rule.suspend_per_day), suspend_max: num(rule.suspend_max)
      });
      logAudit('Правила за обслужване', 'категория „' + category + '“');
    })
  );
  ipcMain.handle('circRules:delete', (e, category) =>
    run(() => { getDb().prepare('DELETE FROM circulation_rules WHERE category = ?').run(category); })
  );
  // Ефективното правило (с падналите обратно към глобалните стойности) — за да показва
  // интерфейсът реалния срок/лимит на читателя, а не винаги глобалните настройки.
  ipcMain.handle('circRules:effective', (e, category) => run(() => circRule(category)));

  return { circRule, readerCategory };
};
