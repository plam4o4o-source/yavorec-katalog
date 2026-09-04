// Одитна следа — извадени от main.js в отделен модул (Фаза 4, стъпка 28).
// Единствен read-only справочен handler. Зависи само от getDb, run.
module.exports = function registerAuditHandlers(ipcMain, deps) {
  const { getDb, run } = deps;

  /* Екранът е ограничен до 500 реда (и го казва); ИЗНОСЪТ — не (одит v2.4.25).
     Дотук CSV-то минаваше през същия LIMIT 500 и файлът, който проверяващият
     получава, съдържаше последните 500 от 12 000 записа, без нищо в него да го
     казва. Износът вика с { all: true }. */
  function listAudit(query, all) {
    const db = getDb();
    const limit = all ? '' : 'LIMIT 500';
    if (query && String(query).trim()) {
      const q = `%${String(query).trim()}%`;
      return db.prepare(`
        SELECT * FROM audit_log WHERE user LIKE ? OR action LIKE ? OR detail LIKE ?
        ORDER BY id DESC ${limit}
      `).all(q, q, q);
    }
    return db.prepare(`SELECT * FROM audit_log ORDER BY id DESC ${limit}`).all();
  }
  ipcMain.handle('audit:list', (e, query) => run(() => listAudit(query, false)));
  ipcMain.handle('audit:export', (e, query) => run(() => listAudit(query, true)));
};
