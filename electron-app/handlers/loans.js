// Заемания (+ поток от събития, наказания за просрочие) — извадени от
// main.js в отделен модул (Фаза 4, стъпка 22 от разбиването на монолита на
// модули по домейн). Това е един от "големите пет" — консуматор на почти
// всичко вече извадено: circRule/readerCategory (circ-rules.js),
// nextWorkDay/closedDaysBetween (calendar.js), firstActiveHold/
// consumeHoldOnCheckout/activateHoldOnReturn (holds.js). logEvent се подава
// по референция (function declaration в main.js, ползвана и от
// handlers/housebound.js — остава в main.js, а не се мести тук, за да няма
// проблем с реда на зареждане: housebound.js се изисква по-рано във файла и
// вече разчита logEvent да е hoisted в main.js). BOOK_SELECT (по стойност)
// и scheduleCatalogWrite (по референция, hoisted по-долу в main.js) идват
// от все още неизвадения домейн "Книги"/"Онлайн каталог".
module.exports = function registerLoansHandlers(ipcMain, deps) {
  const {
    getDb, run, logAudit, today, logEvent, BOOK_SELECT, scheduleCatalogWrite,
    circRule, readerCategory, nextWorkDay, closedDaysBetween,
    firstActiveHold, consumeHoldOnCheckout, activateHoldOnReturn, normalizeScanCode
  } = deps;

  const LOAN_SELECT = `
    SELECT l.*, b.title, b.author, b.inv_number, r.name AS reader_name, r.card_no
    FROM loans l
    JOIN books b ON b.id = l.book_id
    JOIN readers r ON r.id = l.reader_id
  `;

  // Ползване в читалня — бърз брояч от „Заемане и връщане"; читателят е незадължителен.
  ipcMain.handle('events:localuse', (e, { date } = {}) =>
    run(() => { logEvent('читалня', { date }); return true; })
  );

  /* Наказание в дни (Koha: finedays) — за селска библиотека N дни без право на заемане
     е по-приложимо от глоба в стотинки, която никой не събира. Смята се при връщане
     със забава; натрупва се върху вече наложено наказание, но не надхвърля тавана. */
  // dueDate/inDate — реалните дати (не готово число дни), защото наказанието трябва да
  // извади затворените дни от периода (виж closedDaysBetween) — календарят е по-важен
  // точно тук: несправедливо е падеж в затворен ден да носи наказание за самия него.
  /* Просрочени дни, изчистени от затворените дни в периода (v1.70.0: извадено
     от applySuspension в самостоятелна функция, за да я ползва и глобата при
     връщане — виж бележката при loans:return по-долу за защо преди това
     двата пресмятания даваха различен резултат). */
  function effectiveDaysLate(dueDate, inDate) {
    if (!dueDate || !inDate || inDate <= dueDate) return 0;
    const rawDaysLate = Math.max(0, Math.round((new Date(inDate) - new Date(dueDate)) / 864e5));
    return Math.max(0, rawDaysLate - closedDaysBetween(dueDate, inDate));
  }
  function applySuspension(readerId, dueDate, inDate) {
    const db = getDb();
    const rule = circRule(readerCategory(readerId));
    const per = Number(rule.suspend_per_day) || 0;
    if (per <= 0) return null;
    const effDaysLate = effectiveDaysLate(dueDate, inDate);
    if (effDaysLate <= 0) return null;
    const penalty = Math.min(Math.ceil(effDaysLate * per), rule.suspend_max || 90);
    const r = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId);
    const base = (r && r.suspended_until && r.suspended_until > today()) ? r.suspended_until : today();
    const until = new Date(base);
    until.setDate(until.getDate() + penalty);
    const untilStr = until.toISOString().slice(0, 10);
    db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run(untilStr, readerId);
    logAudit('Наложено наказание', 'преустановено заемане до ' + untilStr + ' (' + effDaysLate + ' работни дни забава)');
    return untilStr;
  }
  function checkSuspended(readerId) {
    const r = getDb().prepare('SELECT name, suspended_until FROM readers WHERE id = ?').get(readerId);
    if (r && r.suspended_until && r.suspended_until > today()) {
      throw new Error('Заемането за ' + r.name + ' е преустановено до ' + r.suspended_until.split('-').reverse().join('.') +
        ' заради просрочени връщания. Наказанието се сваля от картона на читателя.');
    }
  }

  ipcMain.handle('loans:list', (e, { onlyOpen } = {}) =>
    run(() => {
      const db = getDb();
      if (onlyOpen) return db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL ORDER BY l.date_due`).all();
      return db.prepare(`${LOAN_SELECT} ORDER BY l.date_out DESC`).all();
    })
  );
  ipcMain.handle('loans:overdue', () =>
    run(() => getDb().prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.date_due`).all())
  );
  ipcMain.handle('loans:byReader', (e, readerId) =>
    run(() => getDb().prepare(`${LOAN_SELECT} WHERE l.reader_id = ? ORDER BY l.date_out DESC`).all(readerId))
  );
  // Насочена заявка за конкретна книга (напр. при сканиране на инвентарен номер
  // в таблото) — вместо да се тегли ЦЯЛАТА история на заеманията (loans:list)
  // само за да се филтрира по book_id на клиента (Фаза 2, поправка на dashLookup).
  ipcMain.handle('loans:byBook', (e, bookId) =>
    run(() => getDb().prepare(`${LOAN_SELECT} WHERE l.book_id = ? ORDER BY l.date_out DESC`).all(bookId))
  );
  ipcMain.handle('loans:overdueByReader', () =>
    run(() => {
      const db = getDb();
      const rows = db.prepare(`
        SELECT l.reader_id, r.name, r.address, r.address2, r.phone, r.email, SUM(1) AS n,
               SUM((julianday('now') - julianday(l.date_due)) * s.fine_per_day) AS fine
        FROM loans l JOIN readers r ON r.id = l.reader_id, settings s
        WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') AND s.id = 1
        GROUP BY l.reader_id
      `).all();
      const detail = db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.reader_id, l.date_due`).all();
      rows.forEach(r => { r.loans = detail.filter(d => d.reader_id === r.reader_id); });
      return rows;
    })
  );
  ipcMain.handle('loans:checkout', (e, { reader_id, book_id, date_out, date_due }) =>
    run(() => {
      const db = getDb();
      const tx = db.transaction(() => {
        const inv = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(book_id);
        const outCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(book_id).n;
        const qty = inv ? inv.quantity : 0;
        if (outCount >= qty) throw new Error('Няма свободни бройки от тази книга.');
        checkSuspended(reader_id);
        consumeHoldOnCheckout(book_id, reader_id);
        const info = db.prepare(`
          INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)
        `).run(reader_id, book_id, date_out, date_due || null);
        const b = db.prepare('SELECT title, inv_number FROM books WHERE id = ?').get(book_id);
        logAudit('Заемане', 'инв. № ' + (b ? b.inv_number : '') + ' — ' + (b ? b.title : ''));
        logEvent('заемане', { bookId: book_id, readerId: reader_id, date: date_out });
        return info.lastInsertRowid;
      });
      const id = tx();
      scheduleCatalogWrite();
      return id;
    })
  );
  ipcMain.handle('loans:return', (e, { id, date_in }) =>
    run(() => {
      const db = getDb();
      const inDate = date_in || today();
      const before = db.prepare('SELECT date_due FROM loans WHERE id = ?').get(id);
      // v1.70.0: тук по-рано fine никога не се пресмяташе/записваше — loans:return
      // (бутон „Приеми“ в Заемане и връщане/Просрочени) и loans:returnByCode
      // (сканиране на баркод) са двата пътя за връщане на книга, но само вторият
      // смяташе глоба, при това по календарни дни (без да изважда затворените —
      // за разлика от наказанието в дни, което ги изважда още от самото начало).
      // Резултатът: „Събрани глоби“ в справките зависеше от това кой бутон е
      // натиснат, и дори когато глоба се пресмяташе, беше с по-малко дни, отколкото
      // наказанието за същото просрочие. Сега и двата пътя ползват еднакво
      // effectiveDaysLate() (виж applySuspension по-горе) и еднакво записват fine.
      const daysLate = before ? effectiveDaysLate(before.date_due, inDate) : 0;
      const s = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get();
      const fine = daysLate * ((s && s.fine_per_day) || 0);
      db.prepare('UPDATE loans SET date_in = ?, fine = ? WHERE id = ?').run(inDate, fine, id);
      const l = db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id);
      if (l) logAudit('Връщане', 'инв. № ' + l.inv_number + ' — ' + l.title + (daysLate ? ' (забава ' + daysLate + ' дни)' : ''));
      const hold = l ? activateHoldOnReturn(l.book_id) : null;
      let suspendedUntil = null;
      if (l) {
        logEvent('връщане', { bookId: l.book_id, readerId: l.reader_id, date: inDate });
        suspendedUntil = applySuspension(l.reader_id, l.date_due, inDate);
      }
      scheduleCatalogWrite();
      return {
        hold: hold ? { reader_name: hold.reader_name, card_no: hold.card_no, phone: hold.phone } : null,
        suspendedUntil, daysLate, fine
      };
    })
  );
  ipcMain.handle('loans:extend', (e, { id }) =>
    run(() => {
      const db = getDb();
      const l = db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
      if (!l || l.date_in) throw new Error('Заемането не е активно.');
      const s = circRule(readerCategory(l.reader_id));
      const max = s.extensions_count == null ? 2 : s.extensions_count; // 0 = без лимит
      const used = l.renewals || 0;
      if (max && used >= max) throw new Error('Достигнат е лимитът от ' + max + ' продължения за това заемане.');
      const h = firstActiveHold(l.book_id);
      if (h && h.reader_id !== l.reader_id) {
        throw new Error('Книгата е резервирана от ' + h.reader_name + ' — срокът не може да се продължи.');
      }
      const base = l.date_due || today();
      const next = new Date(base);
      next.setDate(next.getDate() + (s.extension_days || 30));
      const newDue = nextWorkDay(next.toISOString().slice(0, 10));
      db.prepare('UPDATE loans SET date_due = ?, renewals = ? WHERE id = ?').run(newDue, used + 1, id);
      logAudit('Продължение на заемане', 'заемане № ' + id + ' до ' + newDue + ' (' + (used + 1) + (max ? '/' + max : '') + ')');
      logEvent('подновяване', { bookId: l.book_id, readerId: l.reader_id });
      return { date_due: newDue, renewals: used + 1, max };
    })
  );

  /* Заемане и връщане чрез баркод четец — четецът въвежда текст и Enter, точно
     както при физическа клавиатура, затова тук се приема inv. номер или баркод. */
  // normalizeScanCode() (v1.70.1) — виж books:byBarcode в handlers/books.js за
  // обяснението на кирилско/латинско разминаване при баркод четец.
  ipcMain.handle('loans:checkoutByCode', (e, { reader_id, code, date_out }) =>
    run(() => {
      const db = getDb();
      const tx = db.transaction(() => {
        const c = normalizeScanCode(code);
        const b = db.prepare(`${BOOK_SELECT} WHERE b.barcode = ? OR b.inv_number = CAST(? AS INTEGER)`).get(c, c);
        if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
        if (b.status === 'отчислен') throw new Error('Инв. № ' + b.inv_number + ' е отчислен от фонда.');
        const openLoan = db.prepare(`${LOAN_SELECT} WHERE l.book_id = ? AND l.date_in IS NULL`).get(b.id);
        if (openLoan) throw new Error('Инв. № ' + b.inv_number + ' вече е зает от ' + openLoan.reader_name + ' до ' + openLoan.date_due + '.');
        const s = circRule(readerCategory(reader_id));
        const current = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ? AND date_in IS NULL').get(reader_id).n;
        if (s.max_books && current >= s.max_books) throw new Error('Достигнат е лимитът от ' + s.max_books + ' документа за читател.');
        checkSuspended(reader_id);
        consumeHoldOnCheckout(b.id, reader_id);
        const out = date_out || today();
        const due = new Date(out); due.setDate(due.getDate() + (s.loan_days || 30));
        const dueStr = nextWorkDay(due.toISOString().slice(0, 10));
        const info = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(reader_id, b.id, out, dueStr);
        logAudit('Заемане', 'инв. № ' + b.inv_number + ' — ' + b.title);
        logEvent('заемане', { bookId: b.id, readerId: reader_id, date: out });
        return { id: info.lastInsertRowid, title: b.title, inv_number: b.inv_number, date_due: dueStr };
      });
      const result = tx();
      scheduleCatalogWrite();
      return result;
    })
  );
  ipcMain.handle('loans:returnByCode', (e, { code, date_in }) =>
    run(() => {
      const db = getDb();
      const c = normalizeScanCode(code);
      const b = db.prepare('SELECT * FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)').get(c, c);
      if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
      const loan = db.prepare(`${LOAN_SELECT} WHERE l.book_id = ? AND l.date_in IS NULL`).get(b.id);
      if (!loan) throw new Error('Инв. № ' + b.inv_number + ' не е заето в момента.');
      const inDate = date_in || today();
      const s = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get();
      // v1.70.0: effectiveDaysLate() вместо суров брой календарни дни — виж
      // бележката при loans:return по-горе; наказанието в дни за същото
      // просрочие вече ползваше изчистените от затворени дни.
      const daysLate = effectiveDaysLate(loan.date_due, inDate);
      const fine = daysLate * ((s && s.fine_per_day) || 0);
      db.prepare('UPDATE loans SET date_in = ?, fine = ? WHERE id = ?').run(inDate, fine, loan.id);
      logAudit('Връщане', 'инв. № ' + b.inv_number + ' — ' + b.title + (daysLate ? ' (забава ' + daysLate + ' дни)' : ''));
      logEvent('връщане', { bookId: b.id, readerId: loan.reader_id, date: inDate });
      const suspendedUntil = applySuspension(loan.reader_id, loan.date_due, inDate);
      const hold = activateHoldOnReturn(b.id);
      scheduleCatalogWrite();
      return {
        title: b.title, inv_number: b.inv_number, reader_name: loan.reader_name, daysLate, fine, suspendedUntil,
        hold: hold ? { reader_name: hold.reader_name, card_no: hold.card_no, phone: hold.phone } : null
      };
    })
  );

  // LOAN_SELECT се връща обратно към main.js — ползва се и от все още
  // неизвадените домейни "Табло" и "Просрочени: напомняния".
  return { LOAN_SELECT };
};
