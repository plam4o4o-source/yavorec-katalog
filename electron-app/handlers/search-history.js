// История на търсенията (Koha: search_history) — извадени от main.js в
// отделен модул (Фаза 4, стъпка 28). Записва завършени търсения (не всяко
// натискане на клавиш), за да предлага скорошните заявки в полето за
// търсене — удобство при повторно търсене, не пълноценна одитна следа.
// getCurrentUser е getter (CURRENT_USER е `let`, мутируемо в main.js —
// сменя се от app:setUser), по същия модел като getDb/setDb.
module.exports = function registerSearchHistoryHandlers(ipcMain, deps) {
  const { getDb, run, getCurrentUser } = deps;

  ipcMain.handle('searchHistory:log', (e, { kind, query }) =>
    run(() => {
      const db = getDb();
      const q = String(query || '').trim();
      if (!kind || q.length < 2) return;
      const last = db.prepare('SELECT query FROM search_history WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);
      if (last && last.query === q) return; // без дубликат на последното същото търсене
      db.prepare('INSERT INTO search_history (user, kind, query) VALUES (?, ?, ?)').run(getCurrentUser() || '', kind, q);
    })
  );
  ipcMain.handle('searchHistory:suggest', (e, kind) =>
    run(() => getDb().prepare(`
      SELECT query FROM search_history WHERE kind = ? GROUP BY query ORDER BY MAX(id) DESC LIMIT 10
    `).all(kind).map(r => r.query))
  );
};
