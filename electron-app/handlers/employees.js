// Служители — извадени от main.js в отделен модул (Фаза 4, стъпка 6 от
// разбиването на монолита на модули по домейн). Най-прост случай досега:
// само `getDb()`, `run` и `logAudit`, никакви върнати функции назад към
// main.js — никой друг домейн не вика функции оттук.
module.exports = function registerEmployeesHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  ipcMain.handle('employees:list', () => run(() => getDb().prepare('SELECT * FROM employees ORDER BY active DESC, name').all()));
  ipcMain.handle('employees:create', (e, name) =>
    run(() => {
      if (!name || !name.trim()) throw new Error('Въведете име на служителя.');
      const info = getDb().prepare('INSERT INTO employees (name) VALUES (?)').run(name.trim());
      logAudit('Нов служител', name.trim());
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('employees:update', (e, { id, name, active }) =>
    run(() => {
      const db = getDb();
      const cur = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
      if (!cur) throw new Error('Служителят не е намерен.');
      db.prepare('UPDATE employees SET name=?, active=? WHERE id=?').run(
        name !== undefined && name !== null ? name.trim() : cur.name,
        active !== undefined && active !== null ? (active ? 1 : 0) : cur.active,
        id
      );
    })
  );
  ipcMain.handle('employees:delete', (e, id) =>
    run(() => { getDb().prepare('DELETE FROM employees WHERE id = ?').run(id); })
  );
};
