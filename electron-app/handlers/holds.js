// Резервации — извадени от main.js в отделен модул (Фаза 4, стъпка 21).
// firstActiveHold/consumeHoldOnCheckout/activateHoldOnReturn се връщат
// обратно към main.js, защото ги ползва и все още неизвадения домейн
// "Заемания" (loans:checkout/return/extend/checkoutByCode/returnByCode) —
// същият модел, както calendar.js/circ-rules.js по-рано.
module.exports = function registerHoldsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  const HOLD_ACTIVE = "('чака','заделена')";
  const HOLD_SELECT = `
    SELECT h.*, b.title, b.author, b.inv_number, b.barcode,
           r.name AS reader_name, r.card_no, r.phone
    FROM holds h
    JOIN books b ON b.id = h.book_id
    JOIN readers r ON r.id = h.reader_id
  `;

  // Най-старата активна резервация за книгата — тя определя кой е „наред“.
  function firstActiveHold(bookId) {
    return getDb().prepare(`${HOLD_SELECT} WHERE h.book_id = ? AND h.status IN ${HOLD_ACTIVE} ORDER BY h.placed_at, h.id`).get(bookId);
  }
  // При заемане: читателят, който е наред, минава (резервацията му се изпълнява);
  // всеки друг се отказва, докато резервацията стои — иначе заделената книга
  // тихо заминава при трети човек.
  function consumeHoldOnCheckout(bookId, readerId) {
    const h = firstActiveHold(bookId);
    if (!h) return;
    if (h.reader_id !== readerId) {
      throw new Error('Книгата е резервирана за ' + h.reader_name +
        (h.status === 'заделена' ? ' (заделена, чака взимане)' : '') +
        '. Откажете резервацията, ако все пак трябва да я заемете другиму.');
    }
    getDb().prepare("UPDATE holds SET status = 'изпълнена', resolved_at = datetime('now') WHERE id = ?").run(h.id);
  }
  // При връщане: най-старата чакаща резервация става „заделена“, за да не се
  // върне книгата на рафта. Връща резервацията, за да я покаже екранът.
  function activateHoldOnReturn(bookId) {
    const db = getDb();
    const h = firstActiveHold(bookId);
    if (!h) return null;
    if (h.status === 'чака') {
      db.prepare("UPDATE holds SET status = 'заделена', ready_at = datetime('now') WHERE id = ?").run(h.id);
      h.status = 'заделена';
      logAudit('Заделена книга', 'инв. № ' + h.inv_number + ' — ' + h.title + ' за ' + h.reader_name);
    }
    return h;
  }

  ipcMain.handle('holds:list', () =>
    run(() => getDb().prepare(`${HOLD_SELECT} WHERE h.status IN ${HOLD_ACTIVE}
      ORDER BY CASE h.status WHEN 'заделена' THEN 0 ELSE 1 END, h.placed_at, h.id`).all())
  );
  ipcMain.handle('holds:add', (e, { reader_id, code }) =>
    run(() => {
      const db = getDb();
      const b = db.prepare('SELECT * FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)').get(code, code);
      if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
      if (b.status === 'отчислен') throw new Error('Инв. № ' + b.inv_number + ' е отчислен от фонда.');
      const openLoan = db.prepare('SELECT reader_id FROM loans WHERE book_id = ? AND date_in IS NULL').get(b.id);
      if (!openLoan) throw new Error('Инв. № ' + b.inv_number + ' е свободен — заемете го направо, без резервация.');
      if (openLoan.reader_id === reader_id) throw new Error('Читателят в момента държи тази книга.');
      const dup = db.prepare(`SELECT 1 FROM holds WHERE book_id = ? AND reader_id = ? AND status IN ${HOLD_ACTIVE}`).get(b.id, reader_id);
      if (dup) throw new Error('Този читател вече има резервация за книгата.');
      const info = db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(b.id, reader_id);
      const queue = db.prepare(`SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND status IN ${HOLD_ACTIVE}`).get(b.id).n;
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Резервация', 'инв. № ' + b.inv_number + ' — ' + b.title + ' за ' + (r ? r.name : reader_id));
      return { id: info.lastInsertRowid, title: b.title, inv_number: b.inv_number, queue };
    })
  );
  ipcMain.handle('holds:cancel', (e, id) =>
    run(() => {
      const db = getDb();
      const h = db.prepare(`${HOLD_SELECT} WHERE h.id = ?`).get(id);
      db.prepare("UPDATE holds SET status = 'отказана', resolved_at = datetime('now') WHERE id = ?").run(id);
      if (h) logAudit('Отказана резервация', 'инв. № ' + h.inv_number + ' — ' + h.title + ' (' + h.reader_name + ')');
    })
  );

  return { firstActiveHold, consumeHoldOnCheckout, activateHoldOnReturn };
};
