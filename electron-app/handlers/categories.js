// Категории (на книгите) — извадени от main.js в отделен модул (Фаза 4,
// стъпка 7 от разбиването на монолита на модули по домейн). Най-простият
// случай досега: 4 реда логика, само `getDb()`/`run`, без `logAudit`, без
// нито една върната функция назад — други места в main.js (внос, справки)
// продължават да четат таблицата `categories` директно през собствения си
// `db`, без да минават през този модул, и това е ОК — той не пази никакво
// състояние, само регистрира IPC handler-и.
module.exports = function registerCategoriesHandlers(ipcMain, deps) {
  const { getDb, run } = deps;

  ipcMain.handle('categories:list', () =>
    run(() => getDb().prepare('SELECT * FROM categories ORDER BY name').all())
  );
  ipcMain.handle('categories:create', (e, name) =>
    run(() => getDb().prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim()))
  );
  ipcMain.handle('categories:update', (e, { id, name }) =>
    run(() => getDb().prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), id))
  );
  ipcMain.handle('categories:delete', (e, id) =>
    run(() => getDb().prepare('DELETE FROM categories WHERE id = ?').run(id))
  );
};
