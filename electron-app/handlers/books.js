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
  /* Одит v2.3.1 №9(a) — позволените стойности се четат от същия списък, който
     създава enum тригера на books.status (db/enum-triggers.js), по образец на
     handlers/data-import.js, за да не могат двата да се разминат. */
  const { ENUM_COLUMNS } = require('../db/enum-triggers');
  const BOOK_STATUS_VALUES = (ENUM_COLUMNS.find(c => c.table === 'books' && c.col === 'status') || {}).values || [];
  /* Стар ред, редактиран на ръка в базата преди тригерът да съществува (или внесен
     от чужда система), може да носи статус извън enum-а (напр. „изгубена“). Самият
     SQL тригер (BEFORE INSERT/UPDATE) отхвърля записа с general SQLite съобщение
     ("Непозната стойност за books.status."), без никакво упътване — библиотекарят
     не разбира защо документът внезапно „не се записва“. Тук проверката се прави
     ПРЕДИ да се стигне до тригера, за да излезе ясно съобщение на български какво
     точно да направи. */
  function assertValidStatus(status) {
    if (status != null && !BOOK_STATUS_VALUES.includes(status)) {
      throw new Error(
        `Документът има непознат за програмата статус „${status}“ (най-вероятно от стара база, ` +
        'редактирана на ръка, или внесени данни отпреди въвеждането на списъка с позволени статуси). ' +
        'Записът не може да бъде запазен с тази стойност. Отворете документа за редакция и изберете ' +
        'валиден статус от падащото меню „Състояние“ (наличен / липсващ / за реставрация / отчислен), ' +
        'след което запазете отново.'
      );
    }
  }

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
  /* Лека проекция за СПИСЪЦИТЕ (v2.3.1). `b.*` мъкне и анотацията, ключовите думи,
     забележката и адреса на корицата — полета, които нито един списък не показва, но
     които правят по-голямата част от товара: измерено при 15 000 книги товарът на
     books:list беше 20,29 МБ и 38 колони на ред, докато на екрана се рисуват 300 реда
     от 14 колони. Целият този JSON се сериализира, минава по IPC и се разпарсва при
     всяко отваряне на раздела и при всяко търсене.

     Тук са САМО полетата, които реално се ползват от консуматорите на books:list:
       • src/views/books.js — id, inv_number, title, author, category_id/_name,
         department, status, quantity, available, series, series_no, year;
       • src/views/logo-org.js → lblCard (barcode, inv_number) и sigLblCard
         (call_number, author_mark, udk), плюс status за филтъра „действащ фонд".
     Формата за редакция НЕ ползва списъка — bookForm(id) дърпа целия запис през
     books:get, който продължава да връща BOOK_SELECT. Ако нов екран потрябва от
     друго поле, тестът в test/fixes-ipc-payload.test.js пада и казва точно кое. */
  const BOOK_LIST_SELECT = `
    SELECT b.id, b.inv_number, b.barcode, b.title, b.author, b.category_id, b.year,
           b.udk, b.call_number, b.author_mark, b.department, b.status,
           b.series, b.series_no,
           c.name AS category_name,
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
    /* Одит v2.3.1 №9(b): досега липсваща/празна стойност за status ставаше винаги
       'наличен' — вярно за НОВ запис (разумна стойност по подразбиране), но при
       РЕДАКЦИЯ на съществуващ ред мълчаливо превръщаше NULL статус (стари данни,
       все още непрегледани от библиотекаря) в 'наличен' — включително в публичния
       онлайн каталог (main.js: publicBookFields), макар NULL да не значи „наличен“
       никъде в програмата. Редакция без изрична нова стойност вече пази текущия
       статус на реда какъвто и да е — NULL или непозната стара стойност включително;
       'наличен' по подразбиране остава само когато записът реално се създава (prev
       липсва).*/
    out.status = b.status || (prev ? prev.status : 'наличен');
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
        return db.prepare(`${BOOK_LIST_SELECT}
          WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)
             OR b.isbn LIKE ? OR b.barcode LIKE ? OR CAST(b.inv_number AS TEXT) LIKE ?
          ORDER BY ${order}`).all(ftsQuery(query), q, q, q);
      }
      return db.prepare(`${BOOK_LIST_SELECT} ORDER BY ${order}`).all();
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
        assertValidStatus(payload.status);
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
      const id = tx.immediate(book);
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
        assertValidStatus(payload.status);
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
      tx.immediate(book);
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
     тихо изтриване на реда заедно с историята му.

     Само затворената история обаче беше глух коловоз: в програмата няма НИКЪДЕ
     път за изтриване на заемане (нито IPC канал, нито бутон), затова сгрешен
     запис — сканиран погрешно инв. номер, приет обратно веднага и чак после
     разпознат като дубликат — оставаше в базата завинаги, а съобщението пращаше
     библиотекаря да съставя акт за отчисляване на книга, която никога не е
     съществувала. Затова отказът вече не е окончателен: първото натискане пак
     отказва и обяснява (правилният път за истинска книга си остава актът), но
     казва и че повторно натискане до 2 минути ще изтрие записа ЗАЕДНО с толкова
     на брой заемания. Отчетността не страда — дневникът и годишният отчет се
     смятат от events (append-only, нарочно без външни ключове), а самото
     изтриване се вписва в одитната следа. Отказът при ОТВОРЕНО заемане остава
     безусловен: там книгата е физически у читателя. */
  const FORCE_DELETE_MS = 2 * 60 * 1000;
  const pendingBookDelete = new Map(); // id → кога е отказано първия път
  // Същият похват и в readers:delete (handlers/readers.js) — нарочно повторен на
  // двете места, вместо да ражда общ модул за десет реда състояние в паметта.
  function askedTwice(pending, id) {
    const now = Date.now();
    for (const [k, t] of pending) if (now - t > FORCE_DELETE_MS) pending.delete(k);
    if (pending.has(id)) { pending.delete(id); return true; }
    pending.set(id, now);
    return false;
  }
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
      if (past > 0 && !askedTwice(pendingBookDelete, id)) {
        throw new Error('Документът има ' + past + ' записа в историята на заеманията и изтриването би заличило и тях '
          + '(статистиката за минали години ще се промени). Извадете го от фонда с акт за отчисляване (раздел „Отчисляване“). '
          + 'Ако записът е сгрешен и изобщо не е трябвало да съществува, натиснете „Изтрий“ още веднъж до 2 минути — '
          + 'документът ще бъде изтрит заедно с '
          + (past === 1 ? 'единствения запис' : 'всичките ' + past + ' записа') + ' в историята.');
      }
      const b = db.prepare('SELECT inv_number, title FROM books WHERE id = ?').get(id);
      db.prepare('DELETE FROM books WHERE id = ?').run(id);
      if (past > 0) {
        logAudit('Изтрит документ с история', 'инв. № ' + ((b && b.inv_number) ?? '—') + ' — ' + ((b && b.title) || '') +
          ' (заедно с ' + past + ' записа в историята на заеманията)');
      }
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
        `UPDATE books SET ${field} = ?${extra} WHERE id IN (${placeholders}) AND (status != 'отчислен' OR status IS NULL)`
      ).run(v, ...ids).changes);
      const changes = tx.immediate();
      logAudit('Групова редакция', changes + ' документ(а) — ' + field + ' → ' + (value || '—'));
      scheduleCatalogWrite();
      return changes;
    })
  );
  /* Одит v2.3.1 №21: миграция v4 (db/schema.sql) нарочно НЕ сложи UNIQUE на
     books.barcode — рискова промяна върху „мръсна“ стара/внесена база с вече
     съществуващи дубликати — и коментарът там обещаваше „отделна стъпка за
     откриване и разрешаване на дубликати“, която така и не се появи никъде.
     Дотогава сканирането тихо съвпада с ПЪРВИЯ намерен ред (books:byBarcode,
     deaccessionActs:findBook, inventorySessions:scan — навсякъде `WHERE barcode
     = ?` без LIMIT 1, но SQLite го връща имплицитно с .get()) — може да завери
     или отчисли грешен физически екземпляр. Каналът тук е само за ОТКРИВАНЕ/
     справка: връща групи книги със същия ненулев баркод, библиотекарят решава
     ръчно какво да поправи (UI за самата справка е отделен слой, не тук). */
  ipcMain.handle('books:findDuplicateBarcodes', () =>
    run(() => {
      const db = getDb();
      const dupBarcodes = db.prepare(`
        SELECT barcode FROM books
        WHERE barcode IS NOT NULL AND TRIM(barcode) != ''
        GROUP BY barcode HAVING COUNT(*) > 1
      `).all().map(r => r.barcode);
      if (!dupBarcodes.length) return [];
      const stmt = db.prepare(`
        SELECT id, inv_number, barcode, title, author, status
        FROM books WHERE barcode = ? ORDER BY inv_number
      `);
      return dupBarcodes.map(barcode => ({ barcode, books: stmt.all(barcode) }));
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
