PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS books (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inv_number    INTEGER UNIQUE,
  title         TEXT NOT NULL,
  author        TEXT,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  year          TEXT,
  isbn          TEXT,
  price         REAL DEFAULT 0,
  description   TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL UNIQUE REFERENCES books(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS readers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  phone     TEXT,
  address   TEXT,
  email     TEXT,
  card_no   TEXT UNIQUE,
  note      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reader_id   INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  date_out    TEXT NOT NULL,
  date_due    TEXT,
  date_in     TEXT
);

CREATE INDEX IF NOT EXISTS idx_books_title    ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author   ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_category ON books(category_id);
CREATE INDEX IF NOT EXISTS idx_readers_name   ON readers(name);
CREATE INDEX IF NOT EXISTS idx_loans_reader   ON loans(reader_id);
CREATE INDEX IF NOT EXISTS idx_loans_book     ON loans(book_id);
CREATE INDEX IF NOT EXISTS idx_loans_open     ON loans(date_in);

-- Начални категории — по образец на „Вид документ“ от inventar-biblioteka.html
INSERT OR IGNORE INTO categories (name) VALUES
  ('книга'), ('продължаващо издание'), ('графично издание'),
  ('картографско издание'), ('нотно издание'), ('аудиодокумент'),
  ('видеодокумент'), ('електронен документ'), ('патент/стандарт'), ('друго');
