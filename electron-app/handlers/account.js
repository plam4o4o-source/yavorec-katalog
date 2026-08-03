// Читателска сметка (Koha: accountlines) — извадени от main.js в отделен
// модул (Фаза 4, стъпка 18). amount > 0 = начислено (дължи се), amount < 0 =
// платено. Балансът е SUM(amount). Не е касов модул — само дневник на
// движенията + квитанция за печат.
module.exports = function registerAccountHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  ipcMain.handle('account:get', (e, readerId) =>
    run(() => {
      const lines = getDb().prepare('SELECT * FROM account_lines WHERE reader_id = ? ORDER BY date DESC, id DESC').all(readerId);
      const balance = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
      return { lines, balance };
    })
  );
  ipcMain.handle('account:charge', (e, { reader_id, type, amount, note, date }) =>
    run(() => {
      const db = getDb();
      const amt = Math.abs(Number(amount) || 0);
      if (!amt) throw new Error('Сумата трябва да е положителна.');
      const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reader_id, date || today(), 'начисление', type || 'друго', amt, note || null);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Начисление', (r ? r.name : reader_id) + ' — ' + (type || 'друго') + ' ' + amt.toFixed(2) + ' лв.');
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('account:pay', (e, { reader_id, amount, note, date }) =>
    run(() => {
      const db = getDb();
      const amt = Math.abs(Number(amount) || 0);
      if (!amt) throw new Error('Сумата трябва да е положителна.');
      const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reader_id, date || today(), 'плащане', 'плащане', -amt, note || null);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Плащане', (r ? r.name : reader_id) + ' — ' + amt.toFixed(2) + ' лв.');
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('account:deleteLine', (e, id) =>
    run(() => { getDb().prepare('DELETE FROM account_lines WHERE id = ?').run(id); })
  );
};
