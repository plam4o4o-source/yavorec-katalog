// Читателска сметка (Koha: accountlines) — извадени от main.js в отделен
// модул (Фаза 4, стъпка 18). amount > 0 = начислено (дължи се), amount < 0 =
// платено. Балансът е SUM(amount). Не е касов модул — само дневник на
// движенията + квитанция за печат.
module.exports = function registerAccountHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  /* Балансът се закръгля до стотинки, преди да излезе оттук. Сумите се пазят
     като REAL и 1.10+1.10+1.10−3.30 дава 4.44e-16, а не 0 — платената докрай
     сметка светваше в червено с „0.00 лв. (дължи)". Закръглянето е тук, а не в
     изгледа, защото балансът тръгва оттук към всички екрани (сметка, „Заемане и
     връщане", квитанции) и трябва да е един и същ навсякъде. */
  const toCents = (n) => Math.round((Number(n) || 0) * 100) / 100;
  ipcMain.handle('account:get', (e, readerId) =>
    run(() => {
      const lines = getDb().prepare('SELECT * FROM account_lines WHERE reader_id = ? ORDER BY date DESC, id DESC').all(readerId);
      const balance = toCents(lines.reduce((s, l) => s + Number(l.amount || 0), 0));
      return { lines, balance };
    })
  );
  ipcMain.handle('account:charge', (e, { reader_id, type, amount, note, date }) =>
    run(() => {
      const db = getDb();
      /* Math.abs НЕ е излишно: знакът е носителят на смисъла в този дневник
         (плюс = дължи се, минус = платено). Начисление с подадена отрицателна
         сума би влязло като плащане и би намалило дълга — затова сумата се
         привежда към положителна, а нула/нечислово/безкрайност се отказват. */
      const raw = Math.abs(Number(amount) || 0);
      if (!Number.isFinite(raw)) throw new Error('Сумата трябва да е положителна.');
      /* Проверява се ЗАКРЪГЛЕНАТА сума — същото число, което ще влезе в базата.
         Дотогава проверката гледаше суровата, а записът — закръглената, затова
         0.004 лв. минаваше и се записваше ред от 0.00 лв. */
      const amt = toCents(raw);
      if (!amt) throw new Error('Сумата трябва да е положителна (поне 0.01 лв.).');
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
      const amt = Math.abs(Number(amount) || 0); // виж account:charge за знака
      if (!amt || !Number.isFinite(amt)) throw new Error('Сумата трябва да е положителна.');
      const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reader_id, date || today(), 'плащане', 'плащане', -toCents(amt), note || null);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Плащане', (r ? r.name : reader_id) + ' — ' + amt.toFixed(2) + ' лв.');
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('account:deleteLine', (e, id) =>
    run(() => { getDb().prepare('DELETE FROM account_lines WHERE id = ?').run(id); })
  );
};
