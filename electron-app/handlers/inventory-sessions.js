// Инвентаризация — извадени от main.js в отделен модул (Фаза 4, стъпка 24).
// Зависи от pctRequired/naturalLoss (стабилни function declarations в
// main.js, hoisted) и getDb/run/logAudit.
module.exports = function registerInventorySessionsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, pctRequired, naturalLoss } = deps;

  ipcMain.handle('inventorySessions:list', () =>
    run(() => getDb().prepare(`
      SELECT s.*,
             (SELECT COUNT(*) FROM inventory_session_scans sc WHERE sc.session_id = s.id) AS scanned,
             (SELECT COUNT(*) FROM inventory_session_missing m WHERE m.session_id = s.id) AS missing
      FROM inventory_sessions s ORDER BY s.date DESC
    `).all())
  );
  ipcMain.handle('inventorySessions:requirement', () =>
    run(() => {
      const db = getDb();
      const active = db.prepare("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен'").get().n;
      const s = db.prepare('SELECT free_access_pct FROM settings WHERE id = 1').get();
      const pct = pctRequired(active);
      return { active, pct, target: Math.ceil(active * pct / 100), naturalLoss: naturalLoss(active, s.free_access_pct) };
    })
  );
  ipcMain.handle('inventorySessions:start', (e, s) =>
    run(() => {
      const db = getDb();
      const pool = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен' ${s.department ? 'AND department = @department' : ''}`)
        .get(s.department ? { department: s.department } : {});
      const info = db.prepare(`
        INSERT INTO inventory_sessions (date, scope, department, committee1, committee2, committee3, pool_size, closed)
        VALUES (@date, @scope, @department, @committee1, @committee2, @committee3, @pool_size, 0)
      `).run(Object.assign({}, s, { department: s.department || null, pool_size: pool.n }));
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('inventorySessions:get', (e, id) =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(id);
      if (!s) return null;
      s.scans = db.prepare(`
        SELECT sc.*, b.inv_number, b.title FROM inventory_session_scans sc
        JOIN books b ON b.id = sc.book_id WHERE sc.session_id = ? ORDER BY sc.scanned_at DESC
      `).all(id);
      s.missing = db.prepare('SELECT * FROM inventory_session_missing WHERE session_id = ?').all(id);
      return s;
    })
  );
  ipcMain.handle('inventorySessions:scan', (e, { sessionId, code }) =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
      if (!s || s.closed) throw new Error('Няма отворена сесия за инвентаризация.');
      const b = db.prepare(`SELECT * FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)`).get(code, code);
      if (!b) throw new Error('Непознат баркод/инв. № ' + code);
      const already = db.prepare('SELECT 1 FROM inventory_session_scans WHERE session_id = ? AND book_id = ?').get(sessionId, b.id);
      if (already) throw new Error('Инв. № ' + b.inv_number + ' вече е сканиран.');
      db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(sessionId, b.id);
      db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(b.id, s.date);
      db.prepare("UPDATE books SET datelastseen = datetime('now') WHERE id = ?").run(b.id);
      if (b.status === 'липсващ') db.prepare("UPDATE books SET status='наличен', status_date=date('now') WHERE id=?").run(b.id);
      return { inv_number: b.inv_number, title: b.title };
    })
  );
  ipcMain.handle('inventorySessions:close', (e, sessionId) =>
    run(() => {
      const db = getDb();
      const tx = db.transaction(() => {
        const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
        if (!s) throw new Error('Няма такава сесия.');
        const scannedIds = db.prepare('SELECT book_id FROM inventory_session_scans WHERE session_id = ?').all(sessionId).map(r => r.book_id);
        const pool = db.prepare(`SELECT * FROM books WHERE status != 'отчислен' ${s.department ? 'AND department = ?' : ''}`)
          .all(...(s.department ? [s.department] : []));
        const openLoanIds = new Set(db.prepare('SELECT book_id FROM loans WHERE date_in IS NULL').all().map(r => r.book_id));
        const missing = pool.filter(b => !scannedIds.includes(b.id) && !openLoanIds.has(b.id));
        const insMissing = db.prepare(`
          INSERT INTO inventory_session_missing (session_id, book_id, inv_number, title, author, price)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        missing.forEach(b => {
          insMissing.run(sessionId, b.id, b.inv_number, b.title, b.author, b.price);
          if (b.status !== 'отчислен') db.prepare("UPDATE books SET status='липсващ', status_date=date('now') WHERE id=?").run(b.id);
        });
        db.prepare('UPDATE inventory_sessions SET closed = 1 WHERE id = ?').run(sessionId);
        logAudit('Инвентаризация', 'проверени ' + scannedIds.length + ', липсващи ' + missing.length + ' от ' + pool.length);
        const s2 = db.prepare('SELECT free_access_pct FROM settings WHERE id = 1').get();
        return {
          scanned: scannedIds.length, missing: missing.length, pool: pool.length,
          allowedLoss: naturalLoss(pool.length, s2.free_access_pct)
        };
      });
      return tx();
    })
  );
};
