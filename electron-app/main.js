const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

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
}

app.whenReady().then(() => {
  initDb();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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

ipcMain.handle('books:list', (e, query) =>
  run(() => {
    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      return db.prepare(`${BOOK_SELECT}
        WHERE b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ? OR CAST(b.inv_number AS TEXT) LIKE ?
        ORDER BY b.title`).all(q, q, q, q);
    }
    return db.prepare(`${BOOK_SELECT} ORDER BY b.title`).all();
  })
);

ipcMain.handle('books:get', (e, id) =>
  run(() => db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id))
);

ipcMain.handle('books:create', (e, book) =>
  run(() => {
    const tx = db.transaction((b) => {
      const info = db.prepare(`
        INSERT INTO books (inv_number, title, author, category_id, year, isbn, price, description)
        VALUES (@inv_number, @title, @author, @category_id, @year, @isbn, @price, @description)
      `).run({
        inv_number: b.inv_number || null,
        title: b.title,
        author: b.author || null,
        category_id: b.category_id || null,
        year: b.year || null,
        isbn: b.isbn || null,
        price: b.price || 0,
        description: b.description || null
      });
      db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)')
        .run(info.lastInsertRowid, b.quantity != null ? b.quantity : 1);
      return info.lastInsertRowid;
    });
    return tx(book);
  })
);

ipcMain.handle('books:update', (e, book) =>
  run(() => {
    const tx = db.transaction((b) => {
      db.prepare(`
        UPDATE books SET inv_number=@inv_number, title=@title, author=@author,
          category_id=@category_id, year=@year, isbn=@isbn, price=@price, description=@description
        WHERE id=@id
      `).run({
        id: b.id,
        inv_number: b.inv_number || null,
        title: b.title,
        author: b.author || null,
        category_id: b.category_id || null,
        year: b.year || null,
        isbn: b.isbn || null,
        price: b.price || 0,
        description: b.description || null
      });
      db.prepare(`
        INSERT INTO inventory (book_id, quantity) VALUES (?, ?)
        ON CONFLICT(book_id) DO UPDATE SET quantity = excluded.quantity
      `).run(b.id, b.quantity != null ? b.quantity : 1);
    });
    tx(book);
  })
);

ipcMain.handle('books:delete', (e, id) =>
  run(() => db.prepare('DELETE FROM books WHERE id = ?').run(id))
);

/* ---------------- Читатели ---------------- */
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
ipcMain.handle('readers:get', (e, id) =>
  run(() => db.prepare('SELECT * FROM readers WHERE id = ?').get(id))
);
ipcMain.handle('readers:create', (e, r) =>
  run(() => db.prepare(`
    INSERT INTO readers (name, phone, address, email, card_no, note)
    VALUES (@name, @phone, @address, @email, @card_no, @note)
  `).run({
    name: r.name, phone: r.phone || null, address: r.address || null,
    email: r.email || null, card_no: r.card_no || null, note: r.note || null
  }))
);
ipcMain.handle('readers:update', (e, r) =>
  run(() => db.prepare(`
    UPDATE readers SET name=@name, phone=@phone, address=@address,
      email=@email, card_no=@card_no, note=@note WHERE id=@id
  `).run({
    id: r.id, name: r.name, phone: r.phone || null, address: r.address || null,
    email: r.email || null, card_no: r.card_no || null, note: r.note || null
  }))
);
ipcMain.handle('readers:delete', (e, id) =>
  run(() => db.prepare('DELETE FROM readers WHERE id = ?').run(id))
);

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

ipcMain.handle('loans:checkout', (e, { reader_id, book_id, date_out, date_due }) =>
  run(() => {
    const tx = db.transaction(() => {
      const inv = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(book_id);
      const outCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(book_id).n;
      const qty = inv ? inv.quantity : 0;
      if (outCount >= qty) throw new Error('Няма свободни бройки от тази книга.');
      return db.prepare(`
        INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)
      `).run(reader_id, book_id, date_out, date_due || null).lastInsertRowid;
    });
    return tx();
  })
);

ipcMain.handle('loans:return', (e, { id, date_in }) =>
  run(() => db.prepare('UPDATE loans SET date_in = ? WHERE id = ?').run(date_in, id))
);

/* ---------------- Табло ---------------- */
ipcMain.handle('dashboard:stats', () =>
  run(() => ({
    books: db.prepare('SELECT COUNT(*) AS n FROM books').get().n,
    readers: db.prepare('SELECT COUNT(*) AS n FROM readers').get().n,
    loansOpen: db.prepare('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').get().n,
    overdue: db.prepare(`
      SELECT COUNT(*) AS n FROM loans
      WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')
    `).get().n
  }))
);
