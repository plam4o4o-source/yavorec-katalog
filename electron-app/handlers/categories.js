// Категории (на книгите) — извадени от main.js в отделен модул (Фаза 4,
// стъпка 7 от разбиването на монолита на модули по домейн). Най-простият
// случай досега: 4 реда логика, само `getDb()`/`run`, без `logAudit`, без
// нито една върната функция назад — други места в main.js (внос, справки)
// продължават да четат таблицата `categories` директно през собствения си
// `db`, без да минават през този модул, и това е ОК — той не пази никакво
// състояние, само регистрира IPC handler-и.
module.exports = function registerCategoriesHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  ipcMain.handle('categories:list', () =>
    run(() => getDb().prepare('SELECT * FROM categories ORDER BY name').all())
  );
  ipcMain.handle('categories:create', (e, name) =>
    run(() => getDb().prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim()))
  );
  /* Със следа (одит v2.4.25): преименуването преетикетира „Вид документ“ на всяка
     книга в инвентарната книга (Приложение № 4), а изтриването е в следата от
     v2.4.14 — преименуването трябва да е също. */
  ipcMain.handle('categories:update', (e, { id, name }) =>
    run(() => {
      const db = getDb();
      const cur = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
      if (!cur) throw new Error('Видът документ не е намерен.');
      const next = String(name || '').trim();
      if (!next) throw new Error('Името не може да е празно.');
      db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(next, id);
      if (next !== cur.name) {
        const n = db.prepare('SELECT COUNT(*) AS n FROM books WHERE category_id = ?').get(id).n;
        logAudit('Преименуван вид документ', '„' + cur.name + '“ → „' + next + '“'
          + (n ? ' (' + n + (n === 1 ? ' документ' : ' документа') + ')' : ''));
      }
    })
  );
  /* books.category_id е обявена като ON DELETE SET NULL (db/schema.sql) и
     PRAGMA foreign_keys е включена, тоест изтриването на категория изчиства вида
     на документа на ВСЯКА книга, която я е ползвала — необратимо и без следа.
     Одит v2.4.14: питането на екрана казваше само „Да изтрия ли тази категория?“,
     а модулът беше регистриран без logAudit, тоест в одитната следа не оставаше
     нищо. Броят засегнати книги се връща предварително (categories:usage), за да
     влезе в питането, а самото изтриване вече се вписва. */
  ipcMain.handle('categories:usage', (e, id) =>
    run(() => getDb().prepare('SELECT COUNT(*) AS n FROM books WHERE category_id = ?').get(id).n)
  );
  ipcMain.handle('categories:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const c = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
      const n = db.prepare('SELECT COUNT(*) AS n FROM books WHERE category_id = ?').get(id).n;
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      logAudit('Категория', 'изтрита „' + (c ? c.name : id) + '“'
        + (n ? ' — ' + (n === 1 ? '1 документ остана' : n + ' документа останаха') + ' без вид' : ''));
      return n;
    })
  );
};
