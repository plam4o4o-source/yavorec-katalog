// МЗС (междубиблиотечно заемане) — извадени от main.js в отделен модул
// (Фаза 4, стъпка 27). Зависи само от getDb, run, logAudit, yearOf.
module.exports = function registerMzsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, yearOf } = deps;
  const { parseRegisterNo, isValidIsoDate } = require('../security-utils');

  ipcMain.handle('mzs:list', () => run(() => getDb().prepare('SELECT * FROM mzs_requests ORDER BY date DESC, no DESC').all()));
  ipcMain.handle('mzs:nextNo', (e, year) =>
    run(() => {
      const y = year || yearOf();
      const row = getDb().prepare('SELECT MAX(no) AS m FROM mzs_requests WHERE year = ?').get(y);
      return (row.m || 0) + 1;
    })
  );
  /* Одит v2.4.29: заявка без дата минаваше (year се вземаше от днес, разпечатката
     показваше „Дата на вписване:  г.“), а после нямаше как да се поправи —
     mzs:update пази старата стойност при празно поле. Невалидни дати („2026-13-45“)
     също влизаха. Проверява се като при актовете, партидите и заеманията. */
  function assertMzsDates(date, due) {
    if (!isValidIsoDate(date)) throw new Error('Датата на заявката липсва или е невалидна.');
    if (due != null && due !== '' && !isValidIsoDate(due)) throw new Error('Срокът за връщане (' + due + ') е невалиден.');
    if (due && due < date) throw new Error('Срокът за връщане (' + due + ') е преди датата на заявката (' + date + ').');
  }
  ipcMain.handle('mzs:create', (e, m) =>
    run(() => {
      const db = getDb();
      const no = parseRegisterNo(m.no, '№ на заявката');
      assertMzsDates(m.date, m.due_date);
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
  /* № и датата се обновяват наистина. Формата ги показва като редактируеми (№ е
     дори задължително поле), но дотук просто липсваха в SET: mzs:update връщаше
     {ok:true}, а редът оставаше със стария номер — сгрешен номер в регистъра на
     МЗС не можеше да се поправи по никакъв начин. Проверката за дубликат е
     същата като в mzs:create (схемата няма UNIQUE(year, no)) и по същата причина
     е в транзакция с .immediate(); тук самият ред се изключва от проверката.
     Непратено/празно поле не изтрива стойността, за да продължат да работят и
     частичните извиквания (само статус, само партньор). */
  ipcMain.handle('mzs:update', (e, m) =>
    run(() => {
      const db = getDb();
      const cur = db.prepare('SELECT * FROM mzs_requests WHERE id = ?').get(m.id);
      if (!cur) throw new Error('Заявката не е намерена.');
      const given = (v) => v !== undefined && v !== null && v !== '';
      const no = given(m.no) ? parseRegisterNo(m.no, '№ на заявката') : cur.no;
      const date = given(m.date) ? m.date : cur.date;
      /* Проверява се само подаденото: частично извикване (само статус) на стар ред
         с празна дата минава, а формата, която праща всичко, се проверява изцяло. */
      if (given(m.date)) assertMzsDates(m.date, m.due_date !== undefined ? m.due_date : cur.due_date);
      else if (m.due_date !== undefined && m.due_date !== '' && m.due_date !== null) assertMzsDates(cur.date || m.due_date, m.due_date);
      const year = yearOf(date);
      const tx = db.transaction(() => {
        if (db.prepare('SELECT 1 FROM mzs_requests WHERE year = ? AND no = ? AND id <> ?').get(year, no, m.id)) {
          throw new Error('Заявка № ' + no + '/' + year + ' вече съществува — изберете друг номер.');
        }
        db.prepare(`
          UPDATE mzs_requests SET no=@no, year=@year, date=@date, direction=@direction, partner=@partner,
            author=@author, title=@title, isbn=@isbn, requester=@requester, status=@status,
            due_date=@due_date, note=@note WHERE id=@id
        `).run({
          id: m.id, no, year, date,
          direction: m.direction || cur.direction, partner: given(m.partner) ? m.partner : cur.partner,
          /* Непратено (undefined) поле пази старата стойност; ИЗРИЧНО празно го
             изчиства. Дотогава `m.author ?? null` триеше автора, ISBN, заявителя,
             срока и бележката при всяко частично извикване — обратното на обещаното
             два реда по-горе. Днес единственият извикващ праща цялата форма, тоест
             не гърми, но това е капан за следващия бърз бутон „смени статуса". */
          author: m.author !== undefined ? (m.author || null) : cur.author,
          title: given(m.title) ? m.title : cur.title,
          isbn: m.isbn !== undefined ? (m.isbn || null) : cur.isbn,
          requester: m.requester !== undefined ? (m.requester || null) : cur.requester,
          status: m.status || cur.status,
          due_date: m.due_date !== undefined ? (m.due_date || null) : cur.due_date,
          note: m.note !== undefined ? (m.note || null) : cur.note
        });
      });
      tx.immediate();
      logAudit('Редакция на МЗС заявка', '№ ' + no + ' — ' + (given(m.title) ? m.title : cur.title));
    })
  );
  /* Регистър с номера (v2.4.29): изтриването се вписва в следата, както при
     партидите (v2.4.24), и не мълчи при несъществуващ ред. */
  ipcMain.handle('mzs:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const cur = db.prepare('SELECT no, year, title, direction FROM mzs_requests WHERE id = ?').get(id);
      if (!cur) throw new Error('Заявката вече не съществува — вероятно е изтрита от друго работно място.');
      db.prepare('DELETE FROM mzs_requests WHERE id = ?').run(id);
      logAudit('Изтрита МЗС заявка', '№ ' + cur.no + '/' + cur.year + ' — ' + cur.title + ' (' + cur.direction + ')');
    })
  );
};
