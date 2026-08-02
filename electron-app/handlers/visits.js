// Посещения — извадени от main.js в отделен модул (Фаза 4, стъпка 28).
// Единствен handler. Зависи само от getDb, run.
module.exports = function registerVisitsHandlers(ipcMain, deps) {
  const { getDb, run } = deps;

  ipcMain.handle('visits:add', (e, { date, count }) =>
    run(() => getDb().prepare(`
      INSERT INTO visits (date, count) VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET count = count + excluded.count
    `).run(date, parseInt(count, 10) || 0))
  );
};
