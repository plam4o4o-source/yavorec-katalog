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
  series            TEXT,               -- поредица (v1.70.0) — за многотомни/номерирани издания
  series_no         TEXT,               -- номер/книга в поредицата, напр. "кн. 3"
  keywords          TEXT,
  annotation        TEXT,
  cover_url         TEXT,
  department        TEXT,
  status            TEXT DEFAULT 'наличен',
  status_date       TEXT,               -- кога статусът е получил тази стойност (Koha: датирани статуси)
  datelastseen      TEXT,               -- последно физически видян (сканиране при инвентаризация)
  permanent_location TEXT,              -- постоянно място; department може временно да е "витрина/изложба"
  cn_sort           TEXT,               -- сигнатура, нормализирана за правилно сортиране („Ч-9" преди „Ч-84")
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
  gdpr_consent_date TEXT,               -- датирано съгласие — голият флаг е слаба защита при проверка
  parent_consent    INTEGER DEFAULT 0,
  parent_consent_date TEXT,
  suspended_until   TEXT,               -- преустановено заемане до дата (наказание в дни вместо глоба)
  guarantor_name     TEXT,   -- родител/настойник за читатели под 14 г. (Koha: "guarantor")
  guarantor_relation TEXT,   -- родител | настойник | друго
  guarantor_phone    TEXT,   -- контакт и отговорност носи гарантът, не детето
  note              TEXT,
  alert_note        TEXT,    -- изскача открояващо се при избор в „Заемане и връщане" (Koha: patron messages)
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reader_id   INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  date_out    TEXT NOT NULL,
  date_due    TEXT,
  date_in     TEXT,
  fine        REAL DEFAULT 0,
  renewals    INTEGER DEFAULT 0,
  anon_category TEXT                    -- след анонимизиране: „категория · година" вместо име
);

-- Желязна гаранция срещу двойно заемане на ниво база данни (Koha пази това с
-- UNIQUE(itemnumber); тук екземплярите на едно заглавие са books + inventory.quantity,
-- затова правилото е "активните заемания не надвишават бройките", проверено с тригер,
-- а не с уникален индекс — индекс би забранил легитимните втори бройки).
CREATE TRIGGER IF NOT EXISTS trg_loans_capacity BEFORE INSERT ON loans
WHEN NEW.date_in IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Няма свободен екземпляр от този документ — всички бройки са заети.')
  WHERE COALESCE((SELECT quantity FROM inventory WHERE book_id = NEW.book_id), 0)
        <= (SELECT COUNT(*) FROM loans WHERE book_id = NEW.book_id AND date_in IS NULL);
END;

-- Поток от събития (Koha: statistics) — append-only регистър на случилото се, от който
-- дневникът и годишният отчет се смятат със заявки, вместо с ръчни броячи. Нарочно БЕЗ
-- външни ключове: събитието е историческо и остава валидно и след изтриване/анонимизиране
-- на книгата или читателя. Категорията/езикът/УДК се снимат към момента на събитието.
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT DEFAULT (datetime('now')),
  date            TEXT NOT NULL,
  kind            TEXT NOT NULL,        -- заемане | връщане | подновяване | читалня | дома
  book_id         INTEGER,
  reader_id       INTEGER,
  reader_category TEXT,
  book_language   TEXT,
  book_udk        TEXT,
  book_category   TEXT,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date, kind);

-- Регистър на изпратените/отпечатаните напомняния (Koha: message_queue) — за да се
-- вижда кой читател на коя степен напомняне е и кога е получил последното.
CREATE TABLE IF NOT EXISTS notice_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT DEFAULT (datetime('now')),
  reader_id   INTEGER NOT NULL,
  level       INTEGER DEFAULT 1,        -- 1, 2 или 3 (степен на напомнянето)
  channel     TEXT,                     -- имейл | печат | копиране | SMS
  loans_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notice_reader ON notice_log(reader_id, ts);

-- Контролирани номенклатури (Koha: authorised_values) — един източник на истина за
-- стойностите на отдел, език, местоположение и др., вместо свободен текст, разпилян
-- по таблиците. opac_label е публичният надпис за онлайн каталога (празно = value).
CREATE TABLE IF NOT EXISTS authorised_values (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  category   TEXT NOT NULL,             -- department | language | location
  value      TEXT NOT NULL,
  opac_label TEXT,
  sort       INTEGER DEFAULT 0,
  UNIQUE(category, value)
);

-- Обслужване по домовете (Koha: housebound) — график и дневник на посещенията при
-- читатели, които не могат да идват до библиотеката. Посещенията влизат и в
-- колоната a_visit_home на месечния дневник (чрез events kind='дома').
CREATE TABLE IF NOT EXISTS housebound_profiles (
  reader_id  INTEGER PRIMARY KEY REFERENCES readers(id) ON DELETE CASCADE,
  day        TEXT,                      -- предпочитан ден от седмицата
  frequency  TEXT,                      -- седмично | двуседмично | месечно
  note       TEXT
);
CREATE TABLE IF NOT EXISTS housebound_visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  reader_id  INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_hb_visits ON housebound_visits(reader_id, date);

-- Тематични витрини в онлайн каталога (Koha: virtualshelves) — ръчно подбрани
-- списъци („Лято 2026", „Краезнание"), които страницата на сайта показва като
-- бутони над резултатите. „Нови постъпления" НЕ е витрина — страницата я
-- извежда сама от датата на постъпване (полето d на записите в katalog.json).
CREATE TABLE IF NOT EXISTS catalog_shelves (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  sort  INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS catalog_shelf_items (
  shelf_id INTEGER NOT NULL REFERENCES catalog_shelves(id) ON DELETE CASCADE,
  book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  sort     INTEGER DEFAULT 0,
  PRIMARY KEY (shelf_id, book_id)
);

-- Правила за обслужване по категория читатели (Koha: circulation_rules). Всяко поле,
-- оставено празно (NULL), пада обратно към глобалната настройка в settings — така
-- библиотека, която не пипа нищо тук, работи точно както преди тази версия.
CREATE TABLE IF NOT EXISTS circulation_rules (
  category          TEXT PRIMARY KEY,
  loan_days         INTEGER,
  max_books         INTEGER,
  extensions_count  INTEGER,
  extension_days    INTEGER,
  suspend_per_day   REAL,
  suspend_max       INTEGER
);

-- Календар на библиотеката (Koha: repeatable_holidays + special_holidays). work_days
-- в settings пази кои дни от седмицата библиотеката работи (0=неделя…6=събота);
-- calendar_closed добавя конкретни затворени дати (официални празници, отпуск).
-- Падеж, който се пада в затворен ден, се измества към следващия работен ден;
-- наказанието в дни не брои затворени дни (виж closedDaysBetween в main.js).
CREATE TABLE IF NOT EXISTS calendar_closed (
  date    TEXT PRIMARY KEY,
  reason  TEXT
);

-- Читателска сметка (Koha: accountlines) — начисления (годишна такса, обезщетение за
-- изгубена книга) и плащания в един ред на движение. amount > 0 = начислено (дължи се),
-- amount < 0 = платено. Балансът на читателя е SUM(amount).
CREATE TABLE IF NOT EXISTS account_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reader_id   INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- начисление | плащане
  type        TEXT,            -- годишна такса | обезщетение | друго
  amount      REAL NOT NULL,
  note        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_reader ON account_lines(reader_id, date);

-- Предложения за покупка от читатели (Koha: suggestions) — от устна/писмена заявка на
-- гишето до получаване. reader_id е незадължителен (читателят може вече да не е в базата
-- или предложението да идва анонимно); reader_name пази името дори читателят да отпадне.
CREATE TABLE IF NOT EXISTS suggestions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL,
  reader_id      INTEGER REFERENCES readers(id) ON DELETE SET NULL,
  reader_name    TEXT,
  author         TEXT,
  title          TEXT NOT NULL,
  note           TEXT,
  status         TEXT DEFAULT 'заявено',  -- заявено | одобрено | поръчано | получено | отказано
  acquisition_id INTEGER REFERENCES acquisitions(id) ON DELETE SET NULL,
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, date);

-- Резервации: читател чака заета книга. Опашката е по реда на заявяване.
-- status: чака (книгата е още у друг) → заделена (върната е и стои настрана
-- за читателя, не се връща на рафта) → изпълнена (той я е заел) / отказана.
-- Приключените резервации остават като история.
CREATE TABLE IF NOT EXISTS holds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  reader_id   INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  placed_at   TEXT DEFAULT (datetime('now')),
  status      TEXT DEFAULT 'чака',
  ready_at    TEXT,
  resolved_at TEXT,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_holds_book   ON holds(book_id, status);
CREATE INDEX IF NOT EXISTS idx_holds_reader ON holds(reader_id, status);

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
  closed          INTEGER DEFAULT 0,
  -- Вид на проверката, записан при приключване: 'full' (пълна — несканираното се
  -- смята за липсващо) или 'representative' (по чл. 40, т. 2 — протоколът важи само
  -- за сканираното). NULL = сесия отпреди v2.3.0, за която видът не е записван.
  mode            TEXT
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
  detail  TEXT,
  diff    TEXT   -- JSON [{field, before, after}] — само за редакции; кои полета реално са се променили
);

-- История на търсенията (Koha: search_history) — какво е търсено, кога и от кого;
-- захранва предложенията за скорошни търсения в полетата за търсене (без лични данни
-- в самата заявка — самите текстове на търсенето могат да включват имена на читатели,
-- затова таблицата не се изнася никъде извън локалната база).
CREATE TABLE IF NOT EXISTS search_history (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT DEFAULT (datetime('now')),
  user   TEXT,
  kind   TEXT NOT NULL,
  query  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_history_kind ON search_history(kind, id DESC);

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

-- Настройки на библиотеката — единствен ред (id = 1).
-- Полетата за самоличност на библиотеката (наименование, населено място, ЕИК,
-- ръководител и т.н.) нарочно са празни: програмата е универсална и се попълва
-- от всяка библиотека през „Настройки“. Стойности по подразбиране има само
-- там, където съществува общоприета норма (срок на заемане, обезщетение и др.).
CREATE TABLE IF NOT EXISTS settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  org               TEXT,
  lib_name          TEXT,
  place             TEXT,
  bulstat           TEXT,
  reg_no            TEXT,
  director          TEXT,
  director_role     TEXT DEFAULT 'Председател',
  librarian         TEXT,
  cat_url           TEXT,
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
  lbl_cols          INTEGER DEFAULT 3,      -- колони при печат на A4 лист
  lbl_gap           REAL    DEFAULT 3,      -- разстояние между етикетите, мм
  lbl_margin        REAL    DEFAULT 8,      -- поле на листа/ролката, мм
  lbl_border        INTEGER DEFAULT 1,      -- пунктирана рамка около етикета
  sig_w             INTEGER DEFAULT 25,     -- етикет за сигнатура (гръбче), мм
  sig_h             INTEGER DEFAULT 35,
  card_w            INTEGER DEFAULT 90,     -- читателска карта, мм (стандарт 90x60)
  card_h            INTEGER DEFAULT 60,
  logo              TEXT,                   -- лого на организацията, data URI
  theme             TEXT DEFAULT '7',      -- '7' = InvLib (нова инсталация); съществуващи бази пазят избора си
  scan_sound        INTEGER DEFAULT 1,      -- звуков сигнал при сканиране (1 = включен)
  catalog_folder    TEXT,
  sru_endpoint      TEXT,     -- SRU каталог за внасяне на записи; празно = LOC по подразбиране
  suspend_per_day   REAL DEFAULT 0,     -- дни преустановено заемане за всеки ден забава; 0 = изключено
  suspend_max       INTEGER DEFAULT 90, -- таван на наказанието в дни
  remind2_days      INTEGER DEFAULT 14, -- след толкова дни просрочие напомнянето става 2-ра степен
  remind3_days      INTEGER DEFAULT 30, -- ... и 3-та степен
  notice_subject    TEXT,      -- шаблон за тема на имейл напомняне
  notice_body       TEXT,      -- шаблон за текст на имейл напомняне
  notice_sms        TEXT,      -- шаблон за SMS напомняне
  anonymize_years   INTEGER DEFAULT 0,  -- анонимизиране на върнати заемания, по-стари от N години; 0 = изключено
  work_days         TEXT DEFAULT '0,1,2,3,4,5,6',  -- работни дни от седмицата (0=нед…6=съб); по подразбиране всички — без промяна за библиотеки, които не пипат календара
  gh_user           TEXT,
  gh_repo           TEXT,
  gh_branch         TEXT DEFAULT 'main',
  limit_books       INTEGER DEFAULT 0,
  limit_readers     INTEGER DEFAULT 0
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_books_title    ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author   ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_category ON books(category_id);
CREATE INDEX IF NOT EXISTS idx_books_status   ON books(status);
-- „Постъпления" прави по две корелирани подзаявки на партида точно по това поле;
-- без индекса измерено 1317 ms за 400 партиди при 15 000 книги, с него — 9 ms.
CREATE INDEX IF NOT EXISTS idx_books_acquisition ON books(acquisition_id);
CREATE INDEX IF NOT EXISTS idx_readers_name   ON readers(name);
CREATE INDEX IF NOT EXISTS idx_loans_reader   ON loans(reader_id);
CREATE INDEX IF NOT EXISTS idx_loans_book     ON loans(book_id);
CREATE INDEX IF NOT EXISTS idx_loans_open     ON loans(date_in);

-- Начални категории — по образец на „Вид документ“ от inventar-biblioteka.html
INSERT OR IGNORE INTO categories (name) VALUES
  ('книга'), ('продължаващо издание'), ('графично издание'),
  ('картографско издание'), ('нотно издание'), ('аудиодокумент'),
  ('видеодокумент'), ('електронен документ'), ('патент/стандарт'), ('друго');

/* ============================================================================
   КРАЕВЕДСКИ МОДУЛИ
   Аналитично описание, персоналии и летопис. Това са данните, които никоя друга
   библиотека няма и никой не може да ги достави отвън — създават се тук.
   ============================================================================ */

-- Аналитично описание: статии в периодични издания и части от книги.
-- Източникът може да сочи към запис във фонда (периодично издание или книга),
-- или да е описан свободно, когато изданието не е налично в библиотеката.
CREATE TABLE IF NOT EXISTS analytics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  author        TEXT,
  source_kind   TEXT DEFAULT 'периодика',   -- периодика | книга | друго
  periodical_id INTEGER REFERENCES periodicals(id) ON DELETE SET NULL,
  book_id       INTEGER REFERENCES books(id) ON DELETE SET NULL,
  source_text   TEXT,                        -- когато източникът не е във фонда
  year          TEXT,
  issue         TEXT,                        -- брой / № на свитъка
  issue_date    TEXT,
  pages         TEXT,                        -- напр. „12 – 14“
  udk           TEXT,
  keywords      TEXT,
  annotation    TEXT,
  is_local      INTEGER DEFAULT 1,           -- краеведски материал
  note          TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analytics_year  ON analytics(year);
CREATE INDEX IF NOT EXISTS idx_analytics_title ON analytics(title);
CREATE INDEX IF NOT EXISTS idx_analytics_local ON analytics(is_local);

-- Персоналии: видни местни жители и дейци.
CREATE TABLE IF NOT EXISTS persons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,                -- Фамилия, Име Бащино
  alt_names    TEXT,                         -- псевдоними и други изписвания
  birth_date   TEXT,
  birth_place  TEXT,
  death_date   TEXT,
  death_place  TEXT,
  activity     TEXT,                         -- с какво е известен, накратко
  bio          TEXT,                         -- биографична справка
  awards       TEXT,
  sources      TEXT,                         -- откъде са сведенията
  photo        TEXT,                         -- снимка, data URI
  note         TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(name);

-- Летопис: хронологични записи за дейността на читалището.
CREATE TABLE IF NOT EXISTS chronicle (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  year         TEXT NOT NULL,
  date         TEXT,                         -- пълна дата, ако е известна
  title        TEXT NOT NULL,
  body         TEXT,
  category     TEXT,                         -- читалище | библиотека | самодейност | дарение | строителство | друго
  participants TEXT,
  sources      TEXT,
  photo        TEXT,                         -- снимка, data URI
  note         TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chronicle_year ON chronicle(year);

-- Връзки между краеведските записи и фонда. Една таблица за всички посоки:
-- персоналия → книга/статия/летопис, летопис → книга/статия/персоналия.
CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_kind  TEXT NOT NULL,                  -- персона | летопис
  from_id    INTEGER NOT NULL,
  to_kind    TEXT NOT NULL,                  -- книга | статия | летопис | персона | периодика
  to_id      INTEGER NOT NULL,
  note       TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_kind, to_id);
