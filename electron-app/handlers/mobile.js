// Мобилно сканиране — извадено от main.js в отделен модул (Фаза 4,
// стъпка 36). Вместо RFID: страница (mobile-template.html), която се отваря
// на телефона и ползва камерата като баркод четец. Списъкът се пренася
// обратно като текст или файл и се внася в отворена сесия за инвентаризация.
module.exports = function registerMobileHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, dialog, getMainWindow, fs, path, normalizeScanCode } = deps;

  ipcMain.handle('mobile:generate', async () => {
    try {
      const s = getDb().prepare('SELECT lib_name, org, place FROM settings WHERE id = 1').get() || {};
      const name = [s.lib_name || s.org || '', s.place || ''].filter(Boolean).join(' · ');
      const tpl = fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile-template.html'), 'utf8');
      const html = tpl.replace('__LIB__', name.replace(/[<>&]/g, ''));
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Запишете страницата за сканиране с телефон',
        defaultPath: 'inventarizaciya-skener.html',
        filters: [{ name: 'HTML страница', extensions: ['html'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      fs.writeFileSync(filePath, html, 'utf8');
      return { ok: true, data: filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // Внасяне на сканираните с телефона номера в отворена сесия за инвентаризация.
  ipcMain.handle('inventorySessions:importScans', (e, { sessionId, codes }) =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
      if (!s || s.closed) throw new Error('Няма отворена сесия за инвентаризация.');
      // normalizeScanCode() (v1.70.1) — предпазна мярка и тук, за случаите, в
      // които страницата за телефонно сканиране позволи и ръчно въвеждане на
      // номер (виж books:byBarcode в handlers/books.js за пълното обяснение).
      const list = [...new Set((codes || []).map(c => normalizeScanCode(c)).filter(Boolean))];
      if (!list.length) throw new Error('Списъкът е празен.');
      const find = db.prepare('SELECT * FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)');
      const already = db.prepare('SELECT 1 FROM inventory_session_scans WHERE session_id = ? AND book_id = ?');
      const addScan = db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)');
      const addCheck = db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)');
      const res = { added: 0, duplicates: 0, unknown: [] };
      db.transaction(() => {
        for (const code of list) {
          const b = find.get(code, code);
          if (!b) { res.unknown.push(code); continue; }
          if (already.get(sessionId, b.id)) { res.duplicates++; continue; }
          addScan.run(sessionId, b.id);
          addCheck.run(b.id, s.date);
          db.prepare("UPDATE books SET datelastseen = datetime('now') WHERE id = ?").run(b.id);
          if (b.status === 'липсващ') db.prepare("UPDATE books SET status='наличен', status_date=date('now') WHERE id=?").run(b.id);
          res.added++;
        }
      })();
      logAudit('Инвентаризация', `внесени ${res.added} сканирания от телефон` +
        (res.unknown.length ? `, ${res.unknown.length} непознати` : ''));
      return res;
    })
  );
};
