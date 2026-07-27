const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;
let CURRENT_USER = '';

function resolveDbPath() {
  const dir = app.isPackaged
    ? app.getPath('userData')
    : path.join(__dirname, 'db');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'library.db');
}

function initDb() {
  const dbPath = resolveDbPath();
  const isNew = !fs.existsSync(dbPath);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // fs.readFileSync reads transparently through app.asar for plain text files,
  // so the same path works both in dev and in a packaged build.
  const schemaSql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  if (isNew) console.log('Нова база данни създадена на:', dbPath);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    resizable: true,
    icon: path.join(__dirname, 'icon.ico'),
    title: 'Инвентар · Библиотечна система',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  return win;
}

let mainWindow;
app.whenReady().then(() => {
  initDb();
  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (db) db.close();
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- Помощни функции ---------------- */
function run(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    console.error(err);
    return { ok: false, error: err.message };
  }
}
function logAudit(action, detail) {
  db.prepare('INSERT INTO audit_log (user, action, detail) VALUES (?, ?, ?)')
    .run(CURRENT_USER || '', action, detail || '');
}
const today = () => new Date().toISOString().slice(0, 10);
const yearOf = (d) => (d || today()).slice(0, 4);
function value(rows) { return rows.reduce((s, r) => s + (Number(r.price) || 0), 0); }
function pctRequired(n) { return n <= 50000 ? 10 : n <= 200000 ? 5 : 2; }
function naturalLoss(n, freeAccessPct) { return (freeAccessPct > 50 ? n * 10 : n * 5) / 1000; }

/* ---------------- Текущ служител (за одитната следа) ---------------- */
ipcMain.handle('app:setUser', (e, name) => run(() => { CURRENT_USER = (name || '').trim(); return CURRENT_USER; }));
ipcMain.handle('app:getUser', () => run(() => CURRENT_USER));

/* ---------------- Настройки ---------------- */
ipcMain.handle('settings:get', () => run(() => db.prepare('SELECT * FROM settings WHERE id = 1').get()));
ipcMain.handle('settings:update', (e, s) =>
  run(() => {
    db.prepare(`
      UPDATE settings SET org=@org, lib_name=@lib_name, place=@place, bulstat=@bulstat, reg_no=@reg_no,
        director=@director, director_role=@director_role, librarian=@librarian, cat_url=@cat_url,
        loan_days=@loan_days, max_books=@max_books, extensions_count=@extensions_count, extension_days=@extension_days,
        fine_per_day=@fine_per_day, annual_fee=@annual_fee, free_access_pct=@free_access_pct,
        next_inv_number=@next_inv_number, committee1=@committee1, committee2=@committee2, committee3=@committee3
      WHERE id = 1
    `).run(s);
    logAudit('Редакция на настройки', 'настройките на библиотеката са обновени');
  })
);

/* ---------------- Категории ---------------- */
ipcMain.handle('categories:list', () =>
  run(() => db.prepare('SELECT * FROM categories ORDER BY name').all())
);
ipcMain.handle('categories:create', (e, name) =>
  run(() => db.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim()))
);
ipcMain.handle('categories:update', (e, { id, name }) =>
  run(() => db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), id))
);
ipcMain.handle('categories:delete', (e, id) =>
  run(() => db.prepare('DELETE FROM categories WHERE id = ?').run(id))
);

/* ---------------- Книги ---------------- */
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
  'city', 'publisher', 'keywords', 'annotation', 'cover_url', 'department', 'status', 'price',
  'description', 'acquisition_id'];

function bookPayload(b) {
  const out = {};
  BOOK_FIELDS.forEach(f => { out[f] = b[f] === undefined || b[f] === '' ? null : b[f]; });
  if (out.inv_number != null) out.inv_number = parseInt(out.inv_number, 10);
  if (out.category_id != null) out.category_id = parseInt(out.category_id, 10);
  if (out.acquisition_id != null) out.acquisition_id = parseInt(out.acquisition_id, 10);
  out.price = b.price ? parseFloat(b.price) : 0;
  out.status = b.status || 'наличен';
  out.register_date = b.register_date || today();
  return out;
}

ipcMain.handle('books:list', (e, query) =>
  run(() => {
    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      return db.prepare(`${BOOK_SELECT}
        WHERE b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ? OR b.barcode LIKE ? OR CAST(b.inv_number AS TEXT) LIKE ?
        ORDER BY b.title`).all(q, q, q, q, q);
    }
    return db.prepare(`${BOOK_SELECT} ORDER BY b.title`).all();
  })
);
ipcMain.handle('books:get', (e, id) => run(() => db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id)));
ipcMain.handle('books:byBarcode', (e, code) =>
  run(() => db.prepare(`${BOOK_SELECT} WHERE b.barcode = ? OR CAST(b.inv_number AS TEXT) = ?`).get(code, code))
);

ipcMain.handle('books:create', (e, book) =>
  run(() => {
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
    return tx(book);
  })
);
ipcMain.handle('books:update', (e, book) =>
  run(() => {
    const tx = db.transaction((b) => {
      const payload = bookPayload(b);
      db.prepare(`
        UPDATE books SET ${BOOK_FIELDS.map(f => f + '=@' + f).join(',')} WHERE id=@id
      `).run(Object.assign({ id: b.id }, payload));
      db.prepare(`
        INSERT INTO inventory (book_id, quantity) VALUES (?, ?)
        ON CONFLICT(book_id) DO UPDATE SET quantity = excluded.quantity
      `).run(b.id, b.quantity != null ? parseInt(b.quantity, 10) : 1);
      logAudit('Редакция на документ', 'инв. № ' + (payload.inv_number ?? '—') + ' — ' + b.title);
    });
    tx(book);
  })
);
ipcMain.handle('books:delete', (e, id) =>
  run(() => db.prepare('DELETE FROM books WHERE id = ?').run(id))
);
ipcMain.handle('books:addCheck', (e, { bookId, date }) =>
  run(() => db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(bookId, date || today()))
);
ipcMain.handle('books:checks', (e, bookId) =>
  run(() => db.prepare('SELECT date FROM inventory_checks WHERE book_id = ? ORDER BY date').all(bookId))
);

/* ---------------- Инвентарна книга (Приложение № 4 към чл. 16, ал. 1) ---------------- */
ipcMain.handle('invBook:list', () =>
  run(() => {
    const rows = db.prepare(`
      SELECT b.*, c.name AS category_name,
             a.no AS acq_no, a.date AS acq_date,
             d.no AS act_no, d.date AS act_date
      FROM books b
      LEFT JOIN categories c ON c.id = b.category_id
      LEFT JOIN acquisitions a ON a.id = b.acquisition_id
      LEFT JOIN deaccession_acts d ON d.id = b.deaccession_act_id
      ORDER BY b.inv_number
    `).all();
    const checks = db.prepare('SELECT book_id, date FROM inventory_checks ORDER BY date').all();
    const byBook = {};
    checks.forEach(c => { (byBook[c.book_id] = byBook[c.book_id] || []).push(c.date); });
    rows.forEach(r => { r.checks = byBook[r.id] || []; });
    return rows;
  })
);

/* ---------------- Постъпления (партиди) ---------------- */
ipcMain.handle('acquisitions:list', () =>
  run(() => db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM books b WHERE b.acquisition_id = a.id) AS registered_count,
           (SELECT COALESCE(SUM(price),0) FROM books b WHERE b.acquisition_id = a.id) AS registered_value
    FROM acquisitions a ORDER BY a.date DESC, a.no DESC
  `).all())
);
ipcMain.handle('acquisitions:get', (e, id) =>
  run(() => {
    const acq = db.prepare('SELECT * FROM acquisitions WHERE id = ?').get(id);
    if (!acq) return null;
    acq.items = db.prepare(`${BOOK_SELECT} WHERE b.acquisition_id = ? ORDER BY b.inv_number`).all(id);
    return acq;
  })
);
ipcMain.handle('acquisitions:nextNo', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const row = db.prepare('SELECT MAX(no) AS m FROM acquisitions WHERE year = ?').get(y);
    return (row.m || 0) + 1;
  })
);
ipcMain.handle('acquisitions:create', (e, a) =>
  run(() => {
    const info = db.prepare(`
      INSERT INTO acquisitions (no, year, date, how, from_source, doc_type, doc_no, doc_date, total_count, sum, donor_address, note)
      VALUES (@no, @year, @date, @how, @from_source, @doc_type, @doc_no, @doc_date, @total_count, @sum, @donor_address, @note)
    `).run({
      no: parseInt(a.no, 10), year: yearOf(a.date), date: a.date, how: a.how || null,
      from_source: a.from_source || null, doc_type: a.doc_type || null, doc_no: a.doc_no || null,
      doc_date: a.doc_date || null, total_count: parseInt(a.total_count, 10) || 0,
      sum: a.sum ? parseFloat(a.sum) : 0, donor_address: a.donor_address || null, note: a.note || null
    });
    logAudit('Постъпление', 'партида № ' + a.no + ' — ' + a.total_count + ' бр. от ' + a.from_source);
    return info.lastInsertRowid;
  })
);
ipcMain.handle('acquisitions:delete', (e, id) =>
  run(() => {
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM books WHERE acquisition_id = ?').get(id).n;
    if (cnt > 0) throw new Error('Партидата има инвентирани документи и не може да бъде изтрита.');
    db.prepare('DELETE FROM acquisitions WHERE id = ?').run(id);
  })
);

/* ---------------- Отчисляване (актове) ---------------- */
ipcMain.handle('deaccessionActs:list', () =>
  run(() => db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM deaccession_items i WHERE i.act_id = a.id) AS item_count,
           (SELECT COALESCE(SUM(price),0) FROM deaccession_items i WHERE i.act_id = a.id) AS item_value
    FROM deaccession_acts a ORDER BY a.date DESC, a.no DESC
  `).all())
);
ipcMain.handle('deaccessionActs:get', (e, id) =>
  run(() => {
    const act = db.prepare('SELECT * FROM deaccession_acts WHERE id = ?').get(id);
    if (!act) return null;
    act.items = db.prepare('SELECT * FROM deaccession_items WHERE act_id = ? ORDER BY inv_number').all(id);
    return act;
  })
);
ipcMain.handle('deaccessionActs:nextNo', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const row = db.prepare('SELECT MAX(no) AS m FROM deaccession_acts WHERE year = ?').get(y);
    return (row.m || 0) + 1;
  })
);
ipcMain.handle('deaccessionActs:findBook', (e, code) =>
  run(() => db.prepare(`${BOOK_SELECT} WHERE (b.barcode = ? OR CAST(b.inv_number AS TEXT) = ?) AND b.status != 'отчислен'`).get(code, code))
);
ipcMain.handle('deaccessionActs:create', (e, { act, bookIds }) =>
  run(() => {
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO deaccession_acts (no, year, date, order_no, reason_code, reason_text, disposal, attach, committee1, committee2, committee3)
        VALUES (@no, @year, @date, @order_no, @reason_code, @reason_text, @disposal, @attach, @committee1, @committee2, @committee3)
      `).run({
        no: parseInt(act.no, 10), year: yearOf(act.date), date: act.date, order_no: act.order_no || null,
        reason_code: parseInt(act.reason_code, 10), reason_text: act.reason_text,
        disposal: act.disposal || null, attach: act.attach || null,
        committee1: act.committee1 || null, committee2: act.committee2 || null, committee3: act.committee3 || null
      });
      const actId = info.lastInsertRowid;
      const insItem = db.prepare(`
        INSERT INTO deaccession_items (act_id, book_id, inv_number, author, title, volume, year, price, udk, category, language)
        VALUES (@act_id, @book_id, @inv_number, @author, @title, @volume, @year, @price, @udk, @category, @language)
      `);
      const closeLoans = db.prepare(`UPDATE loans SET date_in = ? WHERE book_id = ? AND date_in IS NULL`);
      bookIds.forEach(bookId => {
        const b = db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(bookId);
        if (!b) return;
        insItem.run({
          act_id: actId, book_id: b.id, inv_number: b.inv_number, author: b.author, title: b.title,
          volume: b.volume, year: b.year, price: b.price, udk: b.udk,
          category: b.category_name, language: b.language
        });
        db.prepare('UPDATE books SET status = ?, deaccession_act_id = ?, deaccession_date = ? WHERE id = ?')
          .run('отчислен', actId, act.date, b.id);
        closeLoans.run(act.date, b.id);
      });
      db.prepare('UPDATE settings SET committee1=?, committee2=?, committee3=? WHERE id=1')
        .run(act.committee1 || null, act.committee2 || null, act.committee3 || null);
      logAudit('Отчисляване', 'акт № ' + act.no + ' — ' + bookIds.length + ' документа, причина: ' + act.reason_text);
      return actId;
    });
    return tx();
  })
);
ipcMain.handle('deaccessionActs:revoke', (e, id) =>
  run(() => {
    const tx = db.transaction(() => {
      const items = db.prepare('SELECT book_id FROM deaccession_items WHERE act_id = ?').all(id);
      items.forEach(it => {
        if (it.book_id) {
          db.prepare(`UPDATE books SET status='наличен', deaccession_act_id=NULL, deaccession_date=NULL WHERE id=?`)
            .run(it.book_id);
        }
      });
      db.prepare('DELETE FROM deaccession_acts WHERE id = ?').run(id);
      logAudit('Анулиране на акт', 'акт № ' + id + ' е анулиран, документите са върнати във фонда');
    });
    tx();
  })
);

/* ---------------- КДБФ — книга за движение на фонда ---------------- */
ipcMain.handle('kdbf:report', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const part1 = db.prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM books b WHERE b.acquisition_id=a.id) AS registered_count,
             (SELECT COALESCE(SUM(price),0) FROM books b WHERE b.acquisition_id=a.id) AS registered_value,
             (SELECT MIN(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS inv_from,
             (SELECT MAX(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS inv_to
      FROM acquisitions a WHERE a.year = ? ORDER BY a.no
    `).all(y);
    const part3 = db.prepare(`
      SELECT d.*, (SELECT COUNT(*) FROM deaccession_items i WHERE i.act_id=d.id) AS item_count,
             (SELECT COALESCE(SUM(price),0) FROM deaccession_items i WHERE i.act_id=d.id) AS item_value
      FROM deaccession_acts d WHERE d.year = ? ORDER BY d.no
    `).all(y);
    const end = y + '-12-31';
    const stockAt = (d) => db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS v FROM books
      WHERE register_date <= ? AND (deaccession_date IS NULL OR deaccession_date > ?)
    `).get(d, d);
    const stockEnd = stockAt(end);
    const acquiredYear = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS v FROM books WHERE substr(register_date,1,4) = ?`).get(y);
    const deaccYear = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(i.price),0) AS v FROM deaccession_items i
      JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
    `).get(y);
    return { part1, part3, stockEnd, acquiredYear, deaccYear, year: y };
  })
);

/* ---------------- Читатели ---------------- */
const READER_FIELDS = ['name', 'phone', 'address', 'address2', 'email', 'card_no', 'egn',
  'id_card_no', 'id_card_date', 'id_card_issuer', 'birth_date', 'category', 'registered_at',
  're_registered_at', 'status', 'gdpr_consent', 'parent_consent', 'note'];
function readerPayload(r) {
  const out = {};
  READER_FIELDS.forEach(f => { out[f] = r[f] === undefined || r[f] === '' ? null : r[f]; });
  out.gdpr_consent = r.gdpr_consent ? 1 : 0;
  out.parent_consent = r.parent_consent ? 1 : 0;
  out.category = r.category || 'възрастен';
  out.status = r.status || 'активен';
  out.registered_at = r.registered_at || today();
  return out;
}
ipcMain.handle('readers:list', (e, query) =>
  run(() => {
    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      return db.prepare(`
        SELECT * FROM readers WHERE name LIKE ? OR phone LIKE ? OR card_no LIKE ? ORDER BY name
      `).all(q, q, q);
    }
    return db.prepare('SELECT * FROM readers ORDER BY name').all();
  })
);
ipcMain.handle('readers:get', (e, id) => run(() => db.prepare('SELECT * FROM readers WHERE id = ?').get(id)));
ipcMain.handle('readers:create', (e, r) =>
  run(() => {
    const payload = readerPayload(r);
    const info = db.prepare(`
      INSERT INTO readers (${READER_FIELDS.join(',')}) VALUES (${READER_FIELDS.map(f => '@' + f).join(',')})
    `).run(payload);
    logAudit('Нов читател', 'карта ' + (r.card_no || '') + ' — ' + r.name);
    return info.lastInsertRowid;
  })
);
ipcMain.handle('readers:update', (e, r) =>
  run(() => {
    const payload = readerPayload(r);
    db.prepare(`UPDATE readers SET ${READER_FIELDS.map(f => f + '=@' + f).join(',')} WHERE id=@id`)
      .run(Object.assign({ id: r.id }, payload));
    logAudit('Редакция на читател', 'карта ' + (r.card_no || '') + ' — ' + r.name);
  })
);
ipcMain.handle('readers:delete', (e, id) => run(() => db.prepare('DELETE FROM readers WHERE id = ?').run(id)));

/* ---------------- Заемания ---------------- */
const LOAN_SELECT = `
  SELECT l.*, b.title, b.author, b.inv_number, r.name AS reader_name, r.card_no
  FROM loans l
  JOIN books b ON b.id = l.book_id
  JOIN readers r ON r.id = l.reader_id
`;
ipcMain.handle('loans:list', (e, { onlyOpen } = {}) =>
  run(() => {
    if (onlyOpen) return db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL ORDER BY l.date_due`).all();
    return db.prepare(`${LOAN_SELECT} ORDER BY l.date_out DESC`).all();
  })
);
ipcMain.handle('loans:overdue', () =>
  run(() => db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.date_due`).all())
);
ipcMain.handle('loans:checkout', (e, { reader_id, book_id, date_out, date_due }) =>
  run(() => {
    const tx = db.transaction(() => {
      const inv = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(book_id);
      const outCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(book_id).n;
      const qty = inv ? inv.quantity : 0;
      if (outCount >= qty) throw new Error('Няма свободни бройки от тази книга.');
      const info = db.prepare(`
        INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)
      `).run(reader_id, book_id, date_out, date_due || null);
      const b = db.prepare('SELECT title, inv_number FROM books WHERE id = ?').get(book_id);
      logAudit('Заемане', 'инв. № ' + (b ? b.inv_number : '') + ' — ' + (b ? b.title : ''));
      return info.lastInsertRowid;
    });
    return tx();
  })
);
ipcMain.handle('loans:return', (e, { id, date_in }) =>
  run(() => {
    db.prepare('UPDATE loans SET date_in = ? WHERE id = ?').run(date_in, id);
    const l = db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id);
    if (l) logAudit('Връщане', 'инв. № ' + l.inv_number + ' — ' + l.title);
  })
);
ipcMain.handle('loans:extend', (e, { id, days }) =>
  run(() => {
    const l = db.prepare('SELECT date_due FROM loans WHERE id = ?').get(id);
    const base = l && l.date_due ? l.date_due : today();
    const next = new Date(base);
    next.setDate(next.getDate() + (days || 30));
    const newDue = next.toISOString().slice(0, 10);
    db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(newDue, id);
    logAudit('Продължение на заемане', 'заемане № ' + id + ' до ' + newDue);
    return newDue;
  })
);

/* ---------------- Табло ---------------- */
ipcMain.handle('dashboard:stats', () =>
  run(() => ({
    books: db.prepare("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен'").get().n,
    readers: db.prepare("SELECT COUNT(*) AS n FROM readers WHERE status != 'прекратен'").get().n,
    loansOpen: db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n,
    overdue: db.prepare(`
      SELECT COUNT(*) AS n FROM loans
      WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')
    `).get().n
  }))
);

/* ---------------- Инвентаризация ---------------- */
ipcMain.handle('inventorySessions:list', () =>
  run(() => db.prepare('SELECT * FROM inventory_sessions ORDER BY date DESC').all())
);
ipcMain.handle('inventorySessions:requirement', () =>
  run(() => {
    const active = db.prepare("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен'").get().n;
    const s = db.prepare('SELECT free_access_pct FROM settings WHERE id = 1').get();
    const pct = pctRequired(active);
    return { active, pct, target: Math.ceil(active * pct / 100), naturalLoss: naturalLoss(active, s.free_access_pct) };
  })
);
ipcMain.handle('inventorySessions:start', (e, s) =>
  run(() => {
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
    const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
    if (!s || s.closed) throw new Error('Няма отворена сесия за инвентаризация.');
    const b = db.prepare(`SELECT * FROM books WHERE barcode = ? OR CAST(inv_number AS TEXT) = ?`).get(code, code);
    if (!b) throw new Error('Непознат баркод/инв. № ' + code);
    const already = db.prepare('SELECT 1 FROM inventory_session_scans WHERE session_id = ? AND book_id = ?').get(sessionId, b.id);
    if (already) throw new Error('Инв. № ' + b.inv_number + ' вече е сканиран.');
    db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(sessionId, b.id);
    db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)').run(b.id, s.date);
    if (b.status === 'липсващ') db.prepare("UPDATE books SET status='наличен' WHERE id=?").run(b.id);
    return { inv_number: b.inv_number, title: b.title };
  })
);
ipcMain.handle('inventorySessions:close', (e, sessionId) =>
  run(() => {
    const tx = db.transaction(() => {
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
      if (!s) throw new Error('Няма такава сесия.');
      const scannedIds = db.prepare('SELECT book_id FROM inventory_session_scans WHERE session_id = ?').all(sessionId).map(r => r.book_id);
      const placeholders = scannedIds.length ? scannedIds.map(() => '?').join(',') : 'NULL';
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
        if (b.status !== 'отчислен') db.prepare("UPDATE books SET status='липсващ' WHERE id=?").run(b.id);
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

/* ---------------- Просрочени: вижте loans:overdue по-горе ---------------- */

/* ---------------- Периодика ---------------- */
ipcMain.handle('periodicals:list', () =>
  run(() => db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM periodical_issues i WHERE i.periodical_id = p.id) AS issue_count
    FROM periodicals p ORDER BY p.title
  `).all())
);
ipcMain.handle('periodicals:get', (e, id) =>
  run(() => {
    const p = db.prepare('SELECT * FROM periodicals WHERE id = ?').get(id);
    if (!p) return null;
    p.issues = db.prepare('SELECT * FROM periodical_issues WHERE periodical_id = ? ORDER BY date DESC').all(id);
    return p;
  })
);
ipcMain.handle('periodicals:create', (e, p) =>
  run(() => {
    const info = db.prepare(`
      INSERT INTO periodicals (title, freq, publisher, issn, department, note)
      VALUES (@title, @freq, @publisher, @issn, @department, @note)
    `).run({ title: p.title, freq: p.freq || null, publisher: p.publisher || null, issn: p.issn || null, department: p.department || null, note: p.note || null });
    logAudit('Ново периодично издание', p.title);
    return info.lastInsertRowid;
  })
);
ipcMain.handle('periodicals:update', (e, p) =>
  run(() => {
    db.prepare(`
      UPDATE periodicals SET title=@title, freq=@freq, publisher=@publisher, issn=@issn, department=@department, note=@note
      WHERE id=@id
    `).run(p);
    logAudit('Редакция на периодично издание', p.title);
  })
);
ipcMain.handle('periodicals:delete', (e, id) =>
  run(() => {
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ?').get(id).n;
    if (cnt > 0) throw new Error('Изданието има вписани броеве и не може да бъде изтрито.');
    db.prepare('DELETE FROM periodicals WHERE id = ?').run(id);
  })
);
ipcMain.handle('periodicalIssues:add', (e, issue) =>
  run(() => {
    const info = db.prepare(`
      INSERT INTO periodical_issues (periodical_id, issue_no, date, price, note)
      VALUES (@periodical_id, @issue_no, @date, @price, @note)
    `).run({ periodical_id: issue.periodical_id, issue_no: issue.issue_no, date: issue.date || today(), price: issue.price ? parseFloat(issue.price) : 0, note: issue.note || null });
    logAudit('Постъпил брой', 'бр. ' + issue.issue_no);
    return info.lastInsertRowid;
  })
);
ipcMain.handle('periodicalIssues:delete', (e, id) =>
  run(() => db.prepare('DELETE FROM periodical_issues WHERE id = ?').run(id))
);

/* ---------------- МЗС ---------------- */
ipcMain.handle('mzs:list', () => run(() => db.prepare('SELECT * FROM mzs_requests ORDER BY date DESC, no DESC').all()));
ipcMain.handle('mzs:nextNo', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const row = db.prepare('SELECT MAX(no) AS m FROM mzs_requests WHERE year = ?').get(y);
    return (row.m || 0) + 1;
  })
);
ipcMain.handle('mzs:create', (e, m) =>
  run(() => {
    const info = db.prepare(`
      INSERT INTO mzs_requests (no, year, date, direction, partner, author, title, isbn, requester, status, due_date, note)
      VALUES (@no, @year, @date, @direction, @partner, @author, @title, @isbn, @requester, @status, @due_date, @note)
    `).run({
      no: parseInt(m.no, 10), year: yearOf(m.date), date: m.date, direction: m.direction || 'изходящо',
      partner: m.partner, author: m.author || null, title: m.title, isbn: m.isbn || null,
      requester: m.requester || null, status: m.status || 'заявено', due_date: m.due_date || null, note: m.note || null
    });
    logAudit('Нова МЗС заявка', '№ ' + m.no + ' — ' + m.title + ' (' + m.direction + ')');
    return info.lastInsertRowid;
  })
);
ipcMain.handle('mzs:update', (e, m) =>
  run(() => {
    db.prepare(`
      UPDATE mzs_requests SET direction=@direction, partner=@partner, author=@author, title=@title, isbn=@isbn,
        requester=@requester, status=@status, due_date=@due_date, note=@note WHERE id=@id
    `).run(m);
    logAudit('Редакция на МЗС заявка', '№ ' + m.no + ' — ' + m.title);
  })
);
ipcMain.handle('mzs:delete', (e, id) => run(() => db.prepare('DELETE FROM mzs_requests WHERE id = ?').run(id)));

/* ---------------- Одитна следа ---------------- */
ipcMain.handle('audit:list', (e, query) =>
  run(() => {
    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      return db.prepare(`
        SELECT * FROM audit_log WHERE user LIKE ? OR action LIKE ? OR detail LIKE ?
        ORDER BY id DESC LIMIT 500
      `).all(q, q, q);
    }
    return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all();
  })
);

/* ---------------- Посещения ---------------- */
ipcMain.handle('visits:add', (e, { date, count }) =>
  run(() => db.prepare(`
    INSERT INTO visits (date, count) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET count = count + excluded.count
  `).run(date, parseInt(count, 10) || 0))
);

/* ---------------- Справки и статистика ---------------- */
ipcMain.handle('stats:report', (e, year) =>
  run(() => {
    const y = year || yearOf();
    const end = y + '-12-31';
    const fund = db.prepare(`
      SELECT * FROM books WHERE register_date <= ? AND (deaccession_date IS NULL OR deaccession_date > ?)
    `).all(end, end);
    const acquired = db.prepare(`SELECT * FROM books WHERE substr(register_date,1,4) = ?`).all(y);
    const deaccessioned = db.prepare(`
      SELECT i.* FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
    `).all(y);
    const loansYear = db.prepare(`SELECT * FROM loans WHERE substr(date_out,1,4) = ?`).all(y);
    const readersYear = db.prepare(`
      SELECT * FROM readers WHERE substr(registered_at,1,4) = ? OR substr(re_registered_at,1,4) = ?
    `).all(y, y);
    const visitsYear = db.prepare(`SELECT COALESCE(SUM(count),0) AS n FROM visits WHERE substr(date,1,4) = ?`).get(y).n;
    const byGroup = (rows, field) => {
      const m = {};
      rows.forEach(r => { const k = r[field] || '—'; m[k] = (m[k] || 0) + 1; });
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    const topLoans = db.prepare(`
      SELECT b.title, COUNT(*) AS n FROM loans l JOIN books b ON b.id = l.book_id
      GROUP BY l.book_id ORDER BY n DESC LIMIT 10
    `).all();
    const fundByCategory = db.prepare(`
      SELECT COALESCE(c.name,'—') AS k, COUNT(*) AS n FROM books b LEFT JOIN categories c ON c.id=b.category_id
      WHERE b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)
      GROUP BY k ORDER BY n DESC
    `).all(end, end).map(r => [r.k, r.n]);
    return {
      year: y,
      fundCount: fund.length, fundValue: value(fund),
      acquiredCount: acquired.length, acquiredValue: value(acquired),
      deaccessionedCount: deaccessioned.length, deaccessionedValue: value(deaccessioned),
      loansCount: loansYear.length,
      readersCount: readersYear.length,
      visits: visitsYear || loansYear.length,
      returnedOnTime: loansYear.filter(l => l.date_in && l.date_due && l.date_in <= l.date_due).length,
      returnedLate: loansYear.filter(l => l.date_in && l.date_due && l.date_in > l.date_due).length,
      finesCollected: loansYear.reduce((s, l) => s + (l.fine || 0), 0),
      fundByLanguage: byGroup(fund, 'language'),
      fundByDepartment: byGroup(fund, 'department'),
      fundByCategory,
      topLoans
    };
  })
);

/* ---------------- Онлайн каталог — локален експорт (без git-sync конвейера) ---------------- */
ipcMain.handle('catalog:export', async () => {
  try {
    const books = db.prepare(`${BOOK_SELECT} WHERE b.status != 'отчислен' ORDER BY b.title`).all();
    const payload = books.map(b => ({
      inv: b.inv_number, title: b.title, author: b.author, year: b.year,
      category: b.category_name, isbn: b.isbn, cover: b.cover_url, available: b.available > 0
    }));
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Експорт на онлайн каталог',
      defaultPath: 'katalog.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    logAudit('Експорт на каталог', filePath + ' — ' + payload.length + ' записа');
    return { ok: true, data: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
