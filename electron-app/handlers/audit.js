// Одитна следа — извадени от main.js в отделен модул (Фаза 4, стъпка 28).
// Единствен read-only справочен handler. Зависи само от getDb, run.
module.exports = function registerAuditHandlers(ipcMain, deps) {
  const { getDb, run } = deps;

  ipcMain.handle('audit:list', (e, query) =>
    run(() => {
      const db = getDb();
      if (query && query.trim()) {
        const q = `%${query.trim()}%`;
        return db.prepare(`
          SELECT * FROM audit_log WHERE user LIKE ? OR action LIKE ? OR detail LIKE ?
          ORDER BY id DESC LIMIT 500
        `).all(q, q, q);
      }
      return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all();
    })
  );
};
