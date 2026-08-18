// МЗС (междубиблиотечно заемане) — извадени от main.js в отделен модул
// (Фаза 4, стъпка 27). Зависи само от getDb, run, logAudit, yearOf.
module.exports = function registerMzsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, yearOf } = deps;

  ipcMain.handle('mzs:list', () => run(() => getDb().prepare('SELECT * FROM mzs_requests ORDER BY date DESC, no DESC').all()));
  ipcMain.handle('mzs:nextNo', (e, year) =>
    run(() => {
      const y = year || yearOf();
      const row = getDb().prepare('SELECT MAX(no) AS m FROM mzs_requests WHERE year = ?').get(y);
      return (row.m || 0) + 1;
    })
  );
  ipcMain.handle('mzs:create', (e, m) =>
    run(() => {
      const db = getDb();
      const no = parseInt(m.no, 10);
      const year = yearOf(m.date);
      /* Същото като при актовете за отчисляване и партидите на постъпленията:
         номерът се предлага с MAX(no)+1 при отваряне на формата, схемата няма
         UNIQUE(year, no), а две работни места към една мрежова база получават
         един и същ номер. Проверката се повтаря при самия запис, в транзакция с
         .immediate() (правото на запис се взима преди проверката). */
      const tx = db.transaction(() => {
        if (db.prepare('SELECT 1 FROM mzs_requests WHERE year = ? AND no = ?').get(year, no)) {
          throw new Error('Заявка № ' + no + '/' + year + ' вече съществува — най-вероятно е създадена от друго работно място '
            + 'към същата база. Затворете и отворете формата отново, за да получите следващия свободен номер.');
        }
        const info = db.prepare(`
          INSERT INTO mzs_requests (no, year, date, direction, partner, author, title, isbn, requester, status, due_date, note)
          VALUES (@no, @year, @date, @direction, @partner, @author, @title, @isbn, @requester, @status, @due_date, @note)
        `).run({
          no, year, date: m.date, direction: m.direction || 'изходящо',
          partner: m.partner, author: m.author || null, title: m.title, isbn: m.isbn || null,
          requester: m.requester || null, status: m.status || 'заявено', due_date: m.due_date || null, note: m.note || null
        });
        logAudit('Нова МЗС заявка', '№ ' + m.no + ' — ' + m.title + ' (' + m.direction + ')');
        return info.lastInsertRowid;
      });
      return tx.immediate();
    })
  );
  ipcMain.handle('mzs:update', (e, m) =>
    run(() => {
      getDb().prepare(`
        UPDATE mzs_requests SET direction=@direction, partner=@partner, author=@author, title=@title, isbn=@isbn,
          requester=@requester, status=@status, due_date=@due_date, note=@note WHERE id=@id
      `).run(m);
      logAudit('Редакция на МЗС заявка', '№ ' + m.no + ' — ' + m.title);
    })
  );
  ipcMain.handle('mzs:delete', (e, id) => run(() => getDb().prepare('DELETE FROM mzs_requests WHERE id = ?').run(id)));
};
