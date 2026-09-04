// Служители — извадени от main.js в отделен модул (Фаза 4, стъпка 6 от
// разбиването на монолита на модули по домейн). Най-прост случай досега:
// само `getDb()`, `run` и `logAudit`, никакви върнати функции назад към
// main.js — никой друг домейн не вика функции оттук.
module.exports = function registerEmployeesHandlers(ipcMain, deps) {
  // syncCurrentUser(name?) — чете/задава текущия служител на тази станция (main.js).
  const { getDb, run, logAudit, syncCurrentUser } = deps;

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
      const nextName = name !== undefined && name !== null ? name.trim() : cur.name;
      if (!nextName) throw new Error('Името на служителя не може да е празно.');
      const nextActive = active !== undefined && active !== null ? (active ? 1 : 0) : cur.active;
      db.prepare('UPDATE employees SET name=?, active=? WHERE id=?').run(nextName, nextActive, id);
      /* Следа (одит v2.4.25): служителят е самоличността зад audit_log.user —
         преименуването и изтриването му трябва да личат, иначе „кой е бил Иван“ не
         може да се възстанови. */
      if (nextName !== cur.name) logAudit('Преименуван служител', '„' + cur.name + '“ → „' + nextName + '“');
      if (nextActive !== cur.active) logAudit('Служител', '„' + nextName + '“ — ' + (nextActive ? 'активиран' : 'деактивиран'));
      /* Значката „Служител: …“ следва промяната (одит v2.4.27): дотук след
         преименуване или деактивиране всяко следващо действие — и всяка следваща
         сесия — се вписваше в следата на старото име. */
      if (syncCurrentUser && cur.name === syncCurrentUser()) syncCurrentUser(nextActive ? nextName : '');
    })
  );
  ipcMain.handle('employees:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const cur = db.prepare('SELECT name FROM employees WHERE id = ?').get(id);
      if (!cur) throw new Error('Служителят не е намерен.');
      db.prepare('DELETE FROM employees WHERE id = ?').run(id);
      logAudit('Изтрит служител', '„' + cur.name + '“ — старите записи в следата остават с името му');
      if (syncCurrentUser && cur.name === syncCurrentUser()) syncCurrentUser('');
    })
  );
};
