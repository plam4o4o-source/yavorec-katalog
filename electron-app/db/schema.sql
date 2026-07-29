PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

-- Партиди на постъпване (КДБФ, част № 1 — чл. 14)
CREATE TABLE IF NOT EXISTS acquisitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  no            INTEGER NOT NULL,
  year          TEXT NOT NULL,
  date          TEXT NOT NULL,
  how           TEXT,
  from_source   TEXT,
  doc_type      TEXT,
  doc_no        TEXT,
  doc_date      TEXT,
  total_count   INTEGER DEFAULT 0,
  sum           REAL DEFAULT 0,
  donor_address TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_acq_year ON acquisitions(year);

-- Актове за отчисляване (КДБФ, част № 3 — чл. 30 – 39)
CREATE TABLE IF NOT EXISTS deaccession_acts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  no           INTEGER NOT NULL,
  year         TEXT NOT NULL,
  date         TEXT NOT NULL,
  order_no     TEXT,
  reason_code  INTEGER,
  reason_text  TEXT,
  disposal     TEXT,
  attach       TEXT,
  committee1   TEXT,
  committee2   TEXT,
  committee3   TEXT
);
CREATE INDEX IF NOT EXISTS idx_acts_year ON deaccession_acts(year);

-- Книги, по образец на индивидуалната регистрация в инвентарната книга (чл. 16, ал. 1)
CREATE TABLE IF NOT EXISTS books (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  inv_number        INTEGER UNIQUE,
  barcode           TEXT,
  register_date     TEXT,
  title             TEXT NOT NULL,
  subtitle          TEXT,
  author            TEXT,
  category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  year              TEXT,
  volume            TEXT,
  isbn              TEXT,
  pages             TEXT,
  language          TEXT,
  udk               TEXT,
  call_number       TEXT,
  author_mark       TEXT,
  city              TEXT,
  publisher         TEXT,
  keywords          TEXT,
  annotation        TEXT,
  cover_url         TEXT,
  department        TEXT,
  status            TEXT DEFAULT 'наличен',
  price             REAL DEFAULT 0,
  description       TEXT,
  acquisition_id    INTEGER REFERENCES acquisitions(id) ON DELETE SET NULL,
  deaccession_act_id INTEGER REFERENCES deaccession_acts(id) ON DELETE SET NULL,
  deaccession_date  TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

-- Отчислени екземпляри — снимка на данните към момента на акта (чл. 35, ал. 2)
CREATE TABLE IF NOT EXISTS deaccession_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  act_id      INTEGER NOT NULL REFERENCES deaccession_acts(id) ON DELETE CASCADE,
  book_id     INTEGER REFERENCES books(id) ON DELETE SET NULL,
  inv_number  INTEGER,
  author      TEXT,
  title       TEXT,
  volume      TEXT,
  year        TEXT,
  price       REAL DEFAULT 0,
  udk         TEXT,
  category    TEXT,
  language    TEXT
);

-- Проверки, отбелязани в колона 3 на инвентарната книга
CREATE TABLE IF NOT EXISTS inventory_checks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  date      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL UNIQUE REFERENCES books(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS readers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  phone             TEXT,
  address           TEXT,
  address2          TEXT,
  email             TEXT,
  card_no           TEXT UNIQUE,
  egn               TEXT,
  id_card_no        TEXT,
  id_card_date      TEXT,
  id_card_issuer    TEXT,
  birth_date        TEXT,
  category          TEXT DEFAULT 'възрастен',
  registered_at     TEXT,
  re_registered_at  TEXT,
  status            TEXT DEFAULT 'активен',
  gdpr_consent      INTEGER DEFAULT 0,
  parent_consent    INTEGER DEFAULT 0,
  note              TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reader_id   INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  date_out    TEXT NOT NULL,
  date_due    TEXT,
  date_in     TEXT,
  fine        REAL DEFAULT 0
);

-- Инвентаризации по репрезентативния метод (чл. 40 – 41)
CREATE TABLE IF NOT EXISTS inventory_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  scope           TEXT,
  department      TEXT,
  committee1      TEXT,
  committee2      TEXT,
  committee3      TEXT,
  pool_size       INTEGER DEFAULT 0,
  closed          INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inventory_session_scans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  scanned_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory_session_missing (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  book_id     INTEGER REFERENCES books(id) ON DELETE SET NULL,
  inv_number  INTEGER,
  title       TEXT,
  author      TEXT,
  price       REAL DEFAULT 0
);

-- Периодика (картотека / кардекс)
CREATE TABLE IF NOT EXISTS periodicals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  freq        TEXT,
  publisher   TEXT,
  issn        TEXT,
  department  TEXT,
  note        TEXT
);
CREATE TABLE IF NOT EXISTS periodical_issues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  periodical_id INTEGER NOT NULL REFERENCES periodicals(id) ON DELETE CASCADE,
  issue_no      TEXT NOT NULL,
  date          TEXT,
  price         REAL DEFAULT 0,
  note          TEXT
);

-- Междубиблиотечно заемане (МЗС)
CREATE TABLE IF NOT EXISTS mzs_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  no          INTEGER NOT NULL,
  year        TEXT NOT NULL,
  date        TEXT NOT NULL,
  direction   TEXT NOT NULL DEFAULT 'изходящо',
  partner     TEXT NOT NULL,
  author      TEXT,
  title       TEXT NOT NULL,
  isbn        TEXT,
  requester   TEXT,
  status      TEXT DEFAULT 'заявено',
  due_date    TEXT,
  note        TEXT
);

-- Одитна следа — кой служител какво е извършил
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT DEFAULT (datetime('now')),
  user    TEXT,
  action  TEXT NOT NULL,
  detail  TEXT
);

-- Посещения (за годишния статистически отчет, БДС ISO 2789)
CREATE TABLE IF NOT EXISTS visits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  date    TEXT NOT NULL UNIQUE,
  count   INTEGER NOT NULL DEFAULT 0
);

-- Служители — избират се като "текущо работещ" (за одитната следа); общ списък за
-- всички компютри, свързани към същата база данни (локална мрежа).
CREATE TABLE IF NOT EXISTS employees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  active     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Дневник на библиотеката — Раздел А (читатели/посещения) и Раздел Б (заети материали),
-- по образец на официалния месечен статистически дневник (e_Dnevnik_AB_CH2). Един ред на
-- календарен ден; месечните и годишните тотали се смятат живо (SUM), не се пазят отделно.
-- Полетата не са задължителни — попълва се наличната информация.
CREATE TABLE IF NOT EXISTS dnevnik_days (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  date                 TEXT NOT NULL UNIQUE,
  -- Раздел А — часове на обслужване (в минути) и разпределение на записаните читатели
  a_hours              INTEGER DEFAULT 0,
  a_age_u14            INTEGER DEFAULT 0,
  a_age_15_18          INTEGER DEFAULT 0,
  a_age_19_28          INTEGER DEFAULT 0,
  a_age_o28            INTEGER DEFAULT 0,
  a_sex_boys           INTEGER DEFAULT 0,
  a_sex_men            INTEGER DEFAULT 0,
  a_sex_girls          INTEGER DEFAULT 0,
  a_sex_women          INTEGER DEFAULT 0,
  a_edu_basic          INTEGER DEFAULT 0,
  a_edu_sec            INTEGER DEFAULT 0,
  a_edu_high           INTEGER DEFAULT 0,
  a_prof_industry      INTEGER DEFAULT 0,
  a_prof_agri          INTEGER DEFAULT 0,
  a_prof_eng           INTEGER DEFAULT 0,
  a_prof_agrospec      INTEGER DEFAULT 0,
  a_prof_med           INTEGER DEFAULT 0,
  a_prof_sci           INTEGER DEFAULT 0,
  a_prof_hum           INTEGER DEFAULT 0,
  a_prof_creative      INTEGER DEFAULT 0,
  a_prof_teach         INTEGER DEFAULT 0,
  a_prof_other         INTEGER DEFAULT 0,
  a_stud_uni           INTEGER DEFAULT 0,
  a_stud_high          INTEGER DEFAULT 0,
  a_stud_sec           INTEGER DEFAULT 0,
  a_stud_elem          INTEGER DEFAULT 0,
  a_visit_home         INTEGER DEFAULT 0,
  a_visit_child        INTEGER DEFAULT 0,
  a_visit_reading      INTEGER DEFAULT 0,
  a_visit_internet     INTEGER DEFAULT 0,
  -- Раздел Б — часове на обслужване (в минути) и разпределение на заетите материали
  b_hours              INTEGER DEFAULT 0,
  b_type_books         INTEGER DEFAULT 0,
  b_type_period        INTEGER DEFAULT 0,
  b_type_graphic       INTEGER DEFAULT 0,
  b_type_carto         INTEGER DEFAULT 0,
  b_type_music         INTEGER DEFAULT 0,
  b_type_audio         INTEGER DEFAULT 0,
  b_type_video         INTEGER DEFAULT 0,
  b_type_electronic    INTEGER DEFAULT 0,
  b_type_dvd           INTEGER DEFAULT 0,
  b_type_talking       INTEGER DEFAULT 0,
  b_lang_bg            INTEGER DEFAULT 0,
  b_lang_ru            INTEGER DEFAULT 0,
  b_lang_slavic        INTEGER DEFAULT 0,
  b_lang_en            INTEGER DEFAULT 0,
  b_lang_de            INTEGER DEFAULT 0,
  b_lang_fr            INTEGER DEFAULT 0,
  b_lang_other         INTEGER DEFAULT 0,
  b_cat_0              INTEGER DEFAULT 0,
  b_cat_1              INTEGER DEFAULT 0,
  b_cat_2              INTEGER DEFAULT 0,
  b_cat_3              INTEGER DEFAULT 0,
  b_cat_5              INTEGER DEFAULT 0,
  b_cat_61             INTEGER DEFAULT 0,
  b_cat_62             INTEGER DEFAULT 0,
  b_cat_63             INTEGER DEFAULT 0,
  b_cat_7              INTEGER DEFAULT 0,
  b_cat_793            INTEGER DEFAULT 0,
  b_cat_80             INTEGER DEFAULT 0,
  b_cat_82             INTEGER DEFAULT 0,
  b_cat_9              INTEGER DEFAULT 0,
  b_cat_91             INTEGER DEFAULT 0,
  b_cat_fiction        INTEGER DEFAULT 0,
  b_cat_child_nf       INTEGER DEFAULT 0,
  b_cat_child_f        INTEGER DEFAULT 0,
  b_cat_reading_used   INTEGER DEFAULT 0,
  note                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_dnevnik_date ON dnevnik_days(date);

-- Настройки на библиотеката — единствен ред (id = 1)
CREATE TABLE IF NOT EXISTS settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  org               TEXT DEFAULT 'Народно читалище „Васил Левски – 1922“',
  lib_name          TEXT DEFAULT 'Библиотека при НЧ „Васил Левски – 1922“',
  place             TEXT DEFAULT 'с. Яворец, обл. Габрово',
  bulstat           TEXT,
  reg_no            TEXT,
  director          TEXT,
  director_role     TEXT DEFAULT 'Председател',
  librarian         TEXT,
  cat_url           TEXT DEFAULT 'https://chyavorec.org',
  loan_days         INTEGER DEFAULT 30,
  max_books         INTEGER DEFAULT 5,
  extensions_count  INTEGER DEFAULT 2,
  extension_days    INTEGER DEFAULT 30,
  fine_per_day      REAL DEFAULT 0.05,
  annual_fee        REAL DEFAULT 0,
  free_access_pct   INTEGER DEFAULT 60,
  next_inv_number   INTEGER DEFAULT 1,
  committee1        TEXT,
  committee2        TEXT,
  committee3        TEXT,
  lbl_mode          TEXT DEFAULT 'sheet',
  lbl_w             INTEGER DEFAULT 40,
  lbl_h             INTEGER DEFAULT 30,
  theme             TEXT DEFAULT '1',
  catalog_folder    TEXT,
  gh_user           TEXT DEFAULT 'plam4o4o-source',
  gh_repo           TEXT DEFAULT 'yavorec-katalog',
  gh_branch         TEXT DEFAULT 'main',
  limit_books       INTEGER DEFAULT 0,
  limit_readers     INTEGER DEFAULT 0
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_books_title    ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author   ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_category ON books(category_id);
CREATE INDEX IF NOT EXISTS idx_books_status   ON books(status);
CREATE INDEX IF NOT EXISTS idx_readers_name   ON readers(name);
CREATE INDEX IF NOT EXISTS idx_loans_reader   ON loans(reader_id);
CREATE INDEX IF NOT EXISTS idx_loans_book     ON loans(book_id);
CREATE INDEX IF NOT EXISTS idx_loans_open     ON loans(date_in);

-- Начални категории — по образец на „Вид документ“ от inventar-biblioteka.html
INSERT OR IGNORE INTO categories (name) VALUES
  ('книга'), ('продължаващо издание'), ('графично издание'),
  ('картографско издание'), ('нотно издание'), ('аудиодокумент'),
  ('видеодокумент'), ('електронен документ'), ('патент/стандарт'), ('друго');
