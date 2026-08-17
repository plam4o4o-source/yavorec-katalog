// Книги (фонд) — извадени от main.js в отделен модул (Фаза 4, стъпка 34,
// последният от "големите пет"). Включва и "Лимит на броя записи"
// (limits:usage/update, checkRecordLimit) — физически вложена в същата
// секция на main.js и пряко ползвана от books:create.
//
// BOOK_SELECT/BOOK_FIELDS/checkRecordLimit се връщат обратно към main.js,
// защото по-рано извадени модули (acquisitions.js, deaccession-acts.js,
// loans.js, catalog.js, readers.js) вече ги ползват по пряка референция в
// обект, подаден на техния require(), който трябва да е позициониран СЛЕД
// require('./handlers/books') в main.js, за да няма TDZ — точно както при
// LOAN_SELECT/firstActiveHold и другите вече установени модели за връщане
// на споделена стойност напред.
module.exports = function registerBooksHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today, ftsQuery, cnSortKey, diffFields, scheduleCatalogWrite, normalizeScanCode } = deps;

  const BOOK_SELECT = `
    SELECT b.*, c.name AS category_name,
           COALESCE(i.quantity, 0) AS quantity,
           COALESCE(i.quantity, 0) - COALESCE((
             SELECT COUNT(*) FROM loans l WHERE l.book_id = b.id AND l.date_in IS NULL
           ), 0) AS available
    FROM books b
    LEFT JOIN categories c ON c.id = b.category_id
    LEFT JOIN inventory i ON i.book_id = b.id
  `;
  const BOOK_FIELDS = ['inv_number', 'barcode', 'register_date', 'title', 'subtitle', 'author',
    'category_id', 'year', 'volume', 'isbn', 'pages', 'language', 'udk', 'call_number', 'author_mark',
    'city', 'publisher', 'series', 'series_no', // v1.70.0 — поредица
    'keywords', 'annotation', 'cover_url', 'department', 'permanent_location',
    'status', 'status_date', 'price', 'description', 'acquisition_id', 'cn_sort'];

  /* ---------------- Лимит на броя записи ----------------
     Настройва се в „Настройки“ → „Ограничения“; 0 означава без ограничение.
     Проверява се само при СЪЗДАВАНЕ на нов запис — редакцията на съществуващи
     остава възможна дори ако лимитът вече е достигнат или намален след това. */
  function checkRecordLimit(kind) {
    const db = getDb();
    const s = db.prepare('SELECT limit_books, limit_readers FROM settings WHERE id = 1').get() || {};
    const cfg = kind === 'books'
      ? { limit: s.limit_books, table: 'books', label: 'документи във фонда' }
      : { limit: s.limit_readers, table: 'readers', label: 'читатели' };
    const limit = parseInt(cfg.limit, 10) || 0;
    if (limit <= 0) return;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${cfg.table}`).get().n;
    if (n >= limit) {
      throw new Error(`Достигнат е зададеният лимит от ${limit} ${cfg.label}. ` +
        'Увеличете или премахнете лимита в „Настройки“ → „Ограничения“, за да добавяте нови записи.');
    }
  }
  ipcMain.handle('limits:usage', () =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT limit_books, limit_readers FROM settings WHERE id = 1').get() || {};
      return {
        books: db.prepare('SELECT COUNT(*) AS n FROM books').get().n,
        readers: db.prepare('SELECT COUNT(*) AS n FROM readers').get().n,
        limitBooks: parseInt(s.limit_books, 10) || 0,
        limitReaders: parseInt(s.limit_readers, 10) || 0
      };
    })
  );
  ipcMain.handle('limits:update', (e, { limit_books, limit_readers }) =>
    run(() => {
      getDb().prepare('UPDATE settings SET limit_books=?, limit_readers=? WHERE id=1')
        .run(Math.max(0, parseInt(limit_books, 10) || 0), Math.max(0, parseInt(limit_readers, 10) || 0));
      logAudit('Редакция на настройки', 'променени лимити на записите');
    })
  );

  /* prev — досегашният ред от базата (при редакция): status_date се обновява само
     когато статусът реално се променя, а не при всяко записване на формата. */
  function bookPayload(b, prev) {
    const out = {};
    BOOK_FIELDS.forEach(f => { out[f] = b[f] === undefined || b[f] === '' ? null : b[f]; });
    if (out.inv_number != null) out.inv_number = parseInt(out.inv_number, 10);
    if (out.category_id != null) out.category_id = parseInt(out.category_id, 10);
    if (out.acquisition_id != null) out.acquisition_id = parseInt(out.acquisition_id, 10);
    out.price = b.price ? parseFloat(b.price) : 0;
    out.status = b.status || 'наличен';
    out.register_date = b.register_date || today();
    out.cn_sort = out.call_number ? cnSortKey(out.call_number) : null;
    out.status_date = !prev ? today()
      : (prev.status !== out.status ? today() : (prev.status_date || null));
    return out;
  }

  // sort: 'title' (по подразбиране), 'cn' (по сигнатура — cn_sort нарежда „Ч-9" преди
  // „Ч-84", виж cnSortKey) или 'inv' (по инвентарен номер). Изборът е от фиксиран
  // списък тук, никога суров SQL от интерфейса.
  const BOOK_ORDERS = { title: 'b.title', cn: "b.cn_sort IS NULL, b.cn_sort, b.title", inv: 'b.inv_number' };
  ipcMain.handle('books:list', (e, query, sort) =>
    run(() => {
      const db = getDb();
      const order = BOOK_ORDERS[sort] || BOOK_ORDERS.title;
      if (query && query.trim()) {
        const q = `%${query.trim()}%`;
        // Заглавие/подзаглавие/автор минават през FTS5 (unicode61) — сгъва регистъра
        // и по кирилица ("белият" вече намира "Белият"), без пълно сканиране на
        // таблицата. Баркод/ISBN/инв. № остават на LIKE — ASCII цифри, за които
        // потребителите очакват "съдържа навсякъде", а не само префикс.
        return db.prepare(`${BOOK_SELECT}
          WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)
             OR b.isbn LIKE ? OR b.barcode LIKE ? OR CAST(b.inv_number AS TEXT) LIKE ?
          ORDER BY ${order}`).all(ftsQuery(query), q, q, q);
      }
      return db.prepare(`${BOOK_SELECT} ORDER BY ${order}`).all();
    })
  );
  ipcMain.handle('books:get', (e, id) => run(() => getDb().prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id)));
  ipcMain.handle('books:byBarcode', (e, code) =>
    // CAST-ва се ПАРАМЕТЪРЪТ, не колоната — CAST(b.inv_number AS TEXT) = ? би
    // попречил на SQLite да ползва нито idx_books_barcode, нито уникалния индекс
    // на inv_number, и би прибягнал до пълно сканиране на фонда въпреки индекса
    // (потвърдено с EXPLAIN QUERY PLAN: с тази форма планът е MULTI-INDEX OR по
    // двата индекса). normalizeScanCode() (v1.70.1) — виж security-utils.js:
    // баркод четецът е клавиатура, а активна кирилска разредба на Windows
    // превръща букви от Code 39 баркода (напр. B) в кирилски еквивалент (Б).
    run(() => { const c = normalizeScanCode(code); return getDb().prepare(`${BOOK_SELECT} WHERE b.barcode = ? OR b.inv_number = CAST(? AS INTEGER)`).get(c, c); })
  );

  ipcMain.handle('books:create', (e, book) =>
    run(() => {
      const db = getDb();
      checkRecordLimit('books');
      const tx = db.transaction((b) => {
        const payload = bookPayload(b);
        const info = db.prepare(`
          INSERT INTO books (${BOOK_FIELDS.join(',')}, register_date)
          VALUES (${BOOK_FIELDS.map(f => '@' + f).join(',')}, @register_date)
        `).run(payload);
        const id = info.lastInsertRowid;
        db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)')
          .run(id, b.quantity != null ? parseInt(b.quantity, 10) : 1);
        if (payload.inv_number) {
          const s = db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get();
          if (payload.inv_number >= s.next_inv_number) {
            db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(payload.inv_number + 1);
          }
        }
        logAudit('Нов документ', 'инв. № ' + (payload.inv_number ?? '—') + ' — ' + b.title);
        return id;
      });
      const id = tx(book);
      scheduleCatalogWrite();
      return id;
    })
  );
  ipcMain.handle('books:update', (e, book) =>
    run(() => {
      const db = getDb();
      const tx = db.transaction((b) => {
        const prev = db.prepare('SELECT * FROM books WHERE id = ?').get(b.id);
        const payload = bookPayload(b, prev);
        db.prepare(`
          UPDATE books SET ${BOOK_FIELDS.map(f => f + '=@' + f).join(',')} WHERE id=@id
        `).run(Object.assign({ id: b.id }, payload));
        db.prepare(`
          INSERT INTO inventory (book_id, quantity) VALUES (?, ?)
          ON CONFLICT(book_id) DO UPDATE SET quantity = excluded.quantity
        `).run(b.id, b.quantity != null ? parseInt(b.quantity, 10) : 1);
        const diff = diffFields(prev, payload, BOOK_FIELDS);
        logAudit('Редакция на документ', 'инв. № ' + (payload.inv_number ?? '—') + ' — ' + b.title, diff);
      });
      tx(book);
      scheduleCatalogWrite();
    })
  );
  /* loans.book_id е с ON DELETE CASCADE (db/schema.sql): изтриването на документ
     мълчаливо трие и заеманията му — и текущите (книгата остава физически у
     читателя, но в програмата изчезва всяка следа за това), и цялата минала
     история, от която живее статистиката за минали години. Затова изтриването се
     отказва по вече установения в програмата модел (acquisitions:delete,
     periodicals:delete): свързаните записи спират изтриването и съобщението казва
     кой е правилният път. Отказва се И при само затворена история — документ,
     който някога е бил заеман, се маха от фонда с АКТ за отчисляване (същата
     логика, поради която books:bulkUpdate не позволява статус „отчислен“), а не с
     тихо изтриване на реда заедно с историята му. */
  ipcMain.handle('books:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const open = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(id).n;
      if (open > 0) {
        throw new Error('Документът е зает в момента (' +
          (open === 1 ? '1 незавършено заемане' : open + ' незавършени заемания') +
          ') и не може да бъде изтрит. Първо приемете върнатия документ от „Заемане и връщане“.');
      }
      const past = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ?').get(id).n;
      if (past > 0) {
        throw new Error('Документът има ' + past + ' записа в историята на заеманията и изтриването би заличило и тях '
          + '(статистиката за минали години ще се промени). Извадете го от фонда с акт за отчисляване (раздел „Отчисляване“).');
      }
      db.prepare('DELETE FROM books WHERE id = ?').run(id);
      scheduleCatalogWrite();
    })
  );
  /* Групова редакция — смяна на едно поле на много документи наведнъж (Koha: "batch item
     modification"). Полето идва от списък с изрично позволени имена (никога суров SQL
     от renderer-а), а „отчислен“ е нарочно изваден от позволените стойности за „status“:
     отчисляването минава единствено през формален акт (раздел „Отчисляване“, чл. 30–39),
     не бива да е на един клик разстояние от таблицата с книги. По същата причина вече
     отчислени документи не се пипат от груповата редакция, дори да са били маркирани. */
  const BULK_EDIT_FIELDS = ['department', 'status', 'category_id', 'language'];
  const BULK_EDIT_STATUS_VALUES = ['наличен', 'липсващ', 'за реставрация'];
  ipcMain.handle('books:bulkUpdate', (e, { ids, field, value }) =>
    run(() => {
      const db = getDb();
      if (!BULK_EDIT_FIELDS.includes(field)) throw new Error('Непозволено поле за групова редакция.');
      if (!Array.isArray(ids) || !ids.length) throw new Error('Няма избрани документи.');
      if (field === 'status' && !BULK_EDIT_STATUS_VALUES.includes(value)) {
        throw new Error('Отчисляването на документи минава само през акт за отчисляване (раздел „Отчисляване“), не и през групова редакция.');
      }
      const v = field === 'category_id' ? (value ? parseInt(value, 10) : null) : (value || null);
      const placeholders = ids.map(() => '?').join(',');
      // Смяната на статус носи и датата си (Koha: датирани статуси) — иначе справката
      // „кога стана липсваща" няма отговор.
      const extra = field === 'status' ? ", status_date = date('now')" : '';
      const tx = db.transaction(() => db.prepare(
        `UPDATE books SET ${field} = ?${extra} WHERE id IN (${placeholders}) AND status != 'отчислен'`
      ).run(v, ...ids).changes);
      const changes = tx();
      logAudit('Групова редакция', changes + ' документ(а) — ' + field + ' → ' + (value || '—'));
      scheduleCatalogWrite();
      return changes;
    })
  );
  ipcMain.handle('books:addCheck', (e, { bookId, date }) =>
    run(() => getDb().prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(bookId, date || today()))
  );
  ipcMain.handle('books:checks', (e, bookId) =>
    run(() => getDb().prepare('SELECT date FROM inventory_checks WHERE book_id = ? ORDER BY date').all(bookId))
  );

  return { BOOK_SELECT, BOOK_FIELDS, checkRecordLimit };
};
