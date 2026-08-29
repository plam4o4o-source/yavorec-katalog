const { app, BrowserWindow, ipcMain, dialog, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');
const importers = require('./importers');
const { ftsQuery, BOOKS_FTS_SETUP_SQL, READERS_FTS_SETUP_SQL } = require('./search-fts');
const { applyEnumTriggers } = require('./db/enum-triggers');
const { createDebouncer } = require('./debounce');
const { csvCell, isValidEmail, normalizeScanCode } = require('./security-utils');
const { ensureDbFolderAvailable } = require('./db-folder');
const { ensureHolidaysSeeded } = require('./bg-holidays');
const { autoUpdater } = require('electron-updater');

let db;
let CURRENT_USER = '';

// Фиксиран курс на БНБ, същият като в интерфейса.
const EUR_RATE = 1.95583;

/* ---------------- Постоянен дневник на грешки (за диагностика от разстояние) ----------------
   Пакетираната програма няма видима конзола за библиотекаря — досега всяка грешка,
   съобщена само с console.error, изчезваше безследно. Тук всичко, минало през
   console.error/console.warn, се записва и във файл в потребителската папка, плюс
   необработените изключения/promise-и, които иначе биха убили процеса без следа.
   Ротация: един файл на ден (log-YYYY-MM-DD.txt), пазят се последните LOG_KEEP_DAYS. */
const LOG_KEEP_DAYS = 30;
function logsDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function logToFile(level, args) {
  try {
    if (!app.isReady()) return; // да не пипаме fs пътища, зависещи от userData, преди 'ready'
    const dir = logsDir();
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `log-${day}.txt`);
    const text = args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
    fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${text}\n`, 'utf8');
  } catch (e) { /* ако дори логът гръмне, няма какво повече да направим тук */ }
}
function pruneOldLogs() {
  try {
    const dir = logsDir();
    const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^log-(\d{4}-\d{2}-\d{2})\.txt$/);
      if (!m) continue;
      if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) fs.unlinkSync(path.join(dir, name));
    }
  } catch (e) { /* почистването на стари логове никога не бива да пречи на стартирането */ }
}
const _origConsoleError = console.error.bind(console);
const _origConsoleWarn = console.warn.bind(console);
console.error = (...args) => { _origConsoleError(...args); logToFile('ERROR', args); };
console.warn = (...args) => { _origConsoleWarn(...args); logToFile('WARN', args); };
process.on('uncaughtException', (err) => {
  console.error('Необработена грешка в програмата (uncaughtException):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Необработено отхвърляне на promise (unhandledRejection):', reason);
});

/* ---------------- Местоположение на базата данни (за работа в мрежа) ----------------
   Малък config.json в постоянната потребителска папка сочи къде реално живее
   library.db — по подразбиране до самата програма/userData, но може да бъде
   и папка на мрежов диск, споделена от няколко работни компютъра. */
function configPath() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'config.json');
}
/* Празен обект при ПЪРВО пускане е нормално. Празен обект при неуспешно ЧЕТЕНЕ на
   съществуващ файл е нещо съвсем друго — и дотук двете бяха неразличими. Всяка
   грешка се превръщаше в „няма настройки“, а `app:setUser` (който се вика при
   всяка смяна на служителя от горния десен ъгъл) прави чети-промени-запиши: така
   един-единствен неуспешен прочит — например докато антивирусна програма държи
   файла, обичайно под Windows — изтриваше `dbFolder` ЗАВИНАГИ. На следващата
   сутрин програмата се отваряше на празна локална база, при това мълчаливо:
   предпазната мрежа за „мрежовата папка е недостъпна“ не се задейства, защото
   според програмата такава никога не е била задавана.

   Сега провалът се различава от липсата. При повреден или непрочетен файл
   readConfig хвърля, а извикващият решава какво да прави — а `writeConfig` пази
   отделно копие `config.bad.json`, преди да презапише, за да може пътят да бъде
   възстановен ръчно. */
function readConfigOrThrow() {
  const p = configPath();
  if (!fs.existsSync(p)) return {};            // първо пускане — наистина няма настройки
  const raw = fs.readFileSync(p, 'utf8');      // при заета/недостъпна папка хвърля — и трябва
  const cfg = JSON.parse(raw);                 // при повреден JSON хвърля — и трябва
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('config.json не е обект');
  return cfg;
}
function readConfig() {
  try { return readConfigOrThrow(); }
  catch (e) {
    console.error('config.json не можа да бъде прочетен:', e.message);
    return {};
  }
}
/* Пише атомарно (настрани → преименувай), за да не остане пресечен файл при спиране
   на тока насред записа — точно този файл сочи къде е базата на библиотеката. */
function writeConfig(cfg) {
  const p = configPath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
/* Чети-промени-запиши БЕЗ риск да загуби вече записани стойности: ако четенето се
   провали, записът се отказва изцяло, вместо да презапише файла с окастрен обект.
   По-добре смяната на служителя да не се запомни, отколкото пътят до базата да
   изчезне. */
function updateConfig(mutate) {
  let cfg;
  try { cfg = readConfigOrThrow(); }
  catch (e) {
    const p = configPath();
    try {
      if (fs.existsSync(p)) fs.copyFileSync(p, p.replace(/\.json$/, '.bad.json'));
    } catch (e2) { /* копието е удобство, не условие */ }
    console.error('config.json не се прочете — записът е отказан, за да не се загуби пътят до базата:', e.message);
    return false;
  }
  mutate(cfg);
  writeConfig(cfg);
  return true;
}
function defaultDbDir() {
  return app.isPackaged ? app.getPath('userData') : path.join(__dirname, 'db');
}
function resolveDbDir() {
  const cfg = readConfig();
  if (cfg.dbFolder && fs.existsSync(cfg.dbFolder)) return cfg.dbFolder;
  return defaultDbDir();
}
function resolveDbPath() {
  const dir = resolveDbDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'library.db');
}

/* Настроена, но недостъпна папка (изключен мрежов диск) караше resolveDbDir() тихо да
   се върне към локалната папка, където веднага се създаваше НОВА, ПРАЗНА база — на
   екрана „всичко е изчезнало“, а въведеното след това остава завинаги отделено от
   общата база. Сега се пита изрично, преди базата да бъде отворена. Самото решение
   живее в db-folder.js без зависимост от Electron, за да е тестваемо. */
function askAboutMissingDbFolder(folder) {
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    noLink: true,
    buttons: ['Опитай отново', 'Работи с локална база', 'Изход'],
    defaultId: 0,
    cancelId: 2,
    title: 'Папката с базата данни не е достъпна',
    message: 'Настроената папка с базата данни не е достъпна:\n' + folder,
    detail: 'Обикновено това означава, че мрежовият диск не е свързан или че компютърът, '
      + 'който споделя папката, е изключен.\n\n'
      + '• „Опитай отново“ — свържете диска и натиснете бутона.\n'
      + '• „Работи с локална база“ — програмата ще отвори ПРАЗНА локална база. Данните, '
      + 'въведени в нея, НЯМА да попаднат в общата база.\n'
      + '• „Изход“ — затваря програмата, без да променя нищо. Това е безопасният избор.'
  });
  return choice === 0 ? 'retry' : (choice === 1 ? 'local' : 'quit');
}

// CREATE TABLE IF NOT EXISTS в schema.sql не пипа таблица, която вече съществува —
// затова колони, добавени в по-нова версия на програмата, трябва изрично да се
// добавят и към вече съществуваща база данни (иначе UPDATE/SELECT към тях гърми
// с "no such column" в стари, вече инсталирани бази). table/columns са фиксирани
// литерали в кода (не потребителски вход), затова е безопасно да се сглобяват в SQL.
function ensureColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
  for (const [name, ddl] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

/* Ключ за сортиране на сигнатури: числата се допълват с нули отпред, така че
   „Ч-9" да се нареди преди „Ч-84" (като числа), а не след него (като текст). */
function cnSortKey(s) {
  return String(s || '').toUpperCase().trim().replace(/\d+/g, m => m.padStart(6, '0'));
}
/* Засява номенклатура (authorised_values), ако категорията е празна: първо
   стандартният списък, после и стойностите, които вече се срещат в books —
   така падащото меню не губи нищо от съществуващите данни. */
function seedAuthorisedValues(category, defaults) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM authorised_values WHERE category = ?').get(category).n;
  if (n > 0) return;
  const field = { department: 'department', language: 'language', location: 'department' }[category];
  const existing = category === 'location' ? [] :
    db.prepare(`SELECT DISTINCT ${field} AS v FROM books WHERE ${field} IS NOT NULL AND TRIM(${field}) <> ''`).all().map(r => r.v);
  const values = [...defaults];
  for (const v of existing) if (!values.includes(v)) values.push(v);
  const ins = db.prepare('INSERT OR IGNORE INTO authorised_values (category, value, sort) VALUES (?, ?, ?)');
  db.transaction(() => values.forEach((v, i) => ins.run(category, v, i))).immediate();
}

function initDb() {
  const dbPath = resolveDbPath();
  const isNew = !fs.existsSync(dbPath);
  const isNetwork = !!readConfig().dbFolder; // персонализирана папка — обичайно мрежов диск
  db = new Database(dbPath);
  // WAL разчита на споделена памет (mmap) между процесите, която не работи надеждно през
  // мрежови дялове (SMB/CIFS) — там rollback journal (DELETE) е по-безопасният избор по
  // документацията на SQLite. По-дългият busy_timeout дава повече време за изчакване вместо
  // веднага да гърми "database is locked", когато няколко компютъра пишат почти едновременно.
  db.pragma(isNetwork ? 'journal_mode = DELETE' : 'journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = ' + (isNetwork ? 20000 : 8000));

  // fs.readFileSync reads transparently through app.asar for plain text files,
  // so the same path works both in dev and in a packaged build.
  const schemaSql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  ensureColumns('settings', {
    lbl_mode: "TEXT DEFAULT 'sheet'",
    lbl_w: 'INTEGER DEFAULT 40',
    lbl_h: 'INTEGER DEFAULT 30',
    lbl_cols: 'INTEGER DEFAULT 3',
    lbl_gap: 'REAL DEFAULT 3',
    lbl_margin: 'REAL DEFAULT 8',
    lbl_border: 'INTEGER DEFAULT 1',
    sig_w: 'INTEGER DEFAULT 25',
    sig_h: 'INTEGER DEFAULT 35',
    card_w: 'INTEGER DEFAULT 90',
    card_h: 'INTEGER DEFAULT 60',
    logo: 'TEXT',
    theme: "TEXT DEFAULT '1'",
    scan_sound: 'INTEGER DEFAULT 1',
    catalog_folder: 'TEXT',
    gh_user: 'TEXT',
    gh_repo: 'TEXT',
    gh_branch: "TEXT DEFAULT 'main'",
    limit_books: 'INTEGER DEFAULT 0',
    limit_readers: 'INTEGER DEFAULT 0'
  });

  ensureColumns('loans', {
    renewals: 'INTEGER DEFAULT 0'
  });

  ensureColumns('readers', {
    guarantor_name: 'TEXT',
    guarantor_relation: 'TEXT',
    guarantor_phone: 'TEXT'
  });

  ensureColumns('settings', {
    notice_subject: 'TEXT',
    notice_body: 'TEXT',
    notice_sms: 'TEXT',
    sru_endpoint: 'TEXT',
    suspend_per_day: 'REAL DEFAULT 0',
    suspend_max: 'INTEGER DEFAULT 90',
    remind2_days: 'INTEGER DEFAULT 14',
    remind3_days: 'INTEGER DEFAULT 30',
    anonymize_years: 'INTEGER DEFAULT 0'
  });

  /* Снимката на бройките в акта за отчисляване — за вече съществуващи бази. */
  ensureColumns('deaccession_items', {
    quantity: 'INTEGER'
  });
  /* Еднократно допълване на бройките за актовете, съставени ПРЕДИ тази версия.
     Без него КДБФ спира да се връзва между годините: наличността се смята по
     живите бройки на документите (3 екземпляра), а отчисленото по празната
     снимка се броеше за 1 — тоест „Наличност 01.01“, изведена от
     „31.12 − постъпили + отчислени“, не съвпадаше с отпечатаната наличност
     31.12 на предходната година. Две разпечатки една до друга в папката по
     Наредба № 3, които не се връзват.
     Стойността идва от текущия ред в inventory — за стар акт това е
     единственото, с което програмата разполага, и е точно числото, с което
     книгата е била броена във фонда преди отчисляването. След допълването
     снимката е фиксирана и повече не се променя. */
  if (db.prepare('SELECT COUNT(*) AS n FROM deaccession_items WHERE quantity IS NULL').get().n) {
    const filled = db.prepare(`
      UPDATE deaccession_items
         SET quantity = COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = deaccession_items.book_id), 1)
       WHERE quantity IS NULL
    `).run().changes;
    logToFile('info', 'Допълнени бройки в ' + filled + ' реда от актове за отчисляване отпреди v2.4.9.');
  }

  ensureColumns('books', {
    status_date: 'TEXT',
    datelastseen: 'TEXT',
    permanent_location: 'TEXT',
    cn_sort: 'TEXT'
  });

  // v1.70.0 — поредица (за многотомни/номерирани издания); липсваше напълно
  // (нито поле, нито таблица) — многотомните заглавия не можеха да се
  // групират/издирват като поредица.
  ensureColumns('books', {
    series: 'TEXT',
    series_no: 'TEXT'
  });

  ensureColumns('readers', {
    gdpr_consent_date: 'TEXT',
    parent_consent_date: 'TEXT',
    suspended_until: 'TEXT'
  });

  ensureColumns('loans', {
    anon_category: 'TEXT',
    /* CREATE TABLE IF NOT EXISTS в schema.sql НЕ добавя колона към вече
       съществуваща таблица — затова присъствието ѝ в описанието на таблицата
       важи само за нови бази. Дотук колоната се създаваше единствено от лениво
       извикваната миграция в handlers/deaccession-acts.js, тоест само след като
       библиотеката състави или анулира акт за отчисляване. Всяка заявка отвън,
       която я ползва (handlers/stats.js изключва оттук заеманията, закрити от
       акт), гърмеше с „no such column“ на всяка инсталация, която още не е
       правила отчисляване — а това е точно екранът „Справки и статистика“,
       нужен за годишния отчет. */
    deaccession_act_id: 'INTEGER'
  });

  ensureColumns('readers', {
    alert_note: 'TEXT'
  });

  ensureColumns('settings', {
    work_days: "TEXT DEFAULT '0,1,2,3,4,5,6'"
  });

  ensureColumns('audit_log', {
    diff: 'TEXT'
  });

  // Еднократни попълвания на новите колони от вече наличните данни. Условието
  // "IS NULL" ги прави безвредни при всяко следващо стартиране.
  // datelastseen — от сканиранията на минали инвентаризации (сурови данни има отдавна).
  db.exec(`UPDATE books SET datelastseen = (
    SELECT MAX(sc.scanned_at) FROM inventory_session_scans sc WHERE sc.book_id = books.id
  ) WHERE datelastseen IS NULL AND EXISTS (
    SELECT 1 FROM inventory_session_scans sc WHERE sc.book_id = books.id)`);
  // cn_sort — от съществуващите сигнатури.
  const noCn = db.prepare(`SELECT id, call_number FROM books
    WHERE cn_sort IS NULL AND call_number IS NOT NULL AND TRIM(call_number) <> ''`).all();
  if (noCn.length) {
    const upd = db.prepare('UPDATE books SET cn_sort = ? WHERE id = ?');
    db.transaction(() => noCn.forEach(b => upd.run(cnSortKey(b.call_number), b.id))).immediate();
  }
  // Датирани съгласия — при вече отбелязано съгласие без дата се записва датата на
  // регистрация: най-добрата налична долна граница, по-честна от днешната дата.
  db.exec(`UPDATE readers SET gdpr_consent_date = COALESCE(registered_at, date('now'))
    WHERE gdpr_consent = 1 AND gdpr_consent_date IS NULL`);
  db.exec(`UPDATE readers SET parent_consent_date = COALESCE(registered_at, date('now'))
    WHERE parent_consent = 1 AND parent_consent_date IS NULL`);
  // Номенклатури — при празна категория се засява от познатите списъци плюс
  // стойностите, които вече се срещат из фонда (за да не изчезне нищо от менютата).
  seedAuthorisedValues('department', ['за възрастни', 'за деца', 'краеведски', 'справочен', 'периодика', 'служебен']);
  seedAuthorisedValues('language', ['български', 'руски', 'английски', 'немски', 'френски', 'друг']);
  seedAuthorisedValues('location', []);

  // (v2.2.0) Тук стоеше еднократна поправка на данни от версии 1.7.0 – 1.7.3, зашита
  // за конкретно населено място. Отпада: всички инсталации отдавна са минали през
  // 1.7.4+, а програмата е универсална — в кода ѝ не бива да фигурира нито една
  // библиотека поименно. Настройките на всяка библиотека се попълват само през
  // „Настройки" и се пазят в нейната собствена база.

  runMigrations();

  /* Официалните празници за текущата и следващата година влизат сами в
     „Календар на библиотеката“ (виж bg-holidays.js — там е и защо всяка
     година се засява само веднъж и ръчните промени не се презаписват).
     Стои СЛЕД runMigrations(), защото ползва колоната settings.holidays_seeded
     от миграция v6. Грешка тук не бива да спре стартирането — календарът е
     удобство, не условие за работа. */
  try {
    const hol = ensureHolidaysSeeded(db, today());
    for (const y of hol.seededYears) {
      logAudit('Календар', 'официалните празници за ' + y + ' г. са добавени автоматично (' +
        hol.addedByYear[y] + ' дни)');
    }
  } catch (err) { console.error('Официални празници:', err.message); }

  if (isNew) console.log('Нова база данни създадена на:', dbPath);
}

/* ---------------- Версия на схемата (PRAGMA user_version) ----------------
   От тук нататък всяка НОВА промяна по схемата (нова колона/таблица, еднократно
   попълване на данни) се регистрира по-долу в MIGRATIONS вместо да се добавя
   свободно в initDb(). Всяка миграция се изпълнява точно веднъж, в транзакция,
   по нарастващ номер на версия; изпълнените версии се пазят в PRAGMA user_version,
   така че при следващо стартиране да е ясно кое вече е приложено.

   По-старите блокове ensureColumns()/UPDATE по-горе в initDb() НЕ са прекодирани
   в миграции — те вече са изпълнени във всички съществуващи инсталации и остават
   само като мост за тях (безвредни са, защото са идемпотентни). CURRENT_SCHEMA_VERSION
   просто маркира "всичко познато досега е приложено" за база данни, която стига дотук
   без нито една регистрирана миграция по-долу (напр. чисто нова инсталация). */
const CURRENT_SCHEMA_VERSION = 6;
const MIGRATIONS = [
  // v2 — колони за защита на ЕГН/№ ЛК на читателите с обща парола (виж
  // "Защита на лични данни" по-долу): pdp_salt (сол за извеждане на ключа) и
  // pdp_verifier (криптиран известен низ, за проверка на паролата).
  { version: 2, run: () => { ensureColumns('settings', { pdp_salt: 'TEXT', pdp_verifier: 'TEXT' }); } },
  // v3 — FTS5 индекси за търсене по книги (title/subtitle/author) и читатели
  // (name), с unicode61 токенайзер: решава едновременно пълното сканиране при
  // всяко търсене и дефекта, че кирилицата не се сгъва по регистър в LIKE
  // ("белият" не намираше "Белият"). Виж search-fts.js за подробности.
  { version: 3, run: () => { db.exec(BOOKS_FTS_SETUP_SQL); db.exec(READERS_FTS_SETUP_SQL); } },
  // v4 — два допълнителни индекса (Фаза 4, "евтини поправки" от анализа):
  // books.barcode нямаше никакъв индекс, въпреки че books:byBarcode и
  // сканирането от таблото търсят точно по него при всяко сканиране на
  // баркод; loans(book_id, date_in) е композитен индекс за най-честата
  // проверка "тази книга заета ли е в момента" (използва се в BOOK_SELECT
  // за ВСЕКИ ред от списъка с книги — коренна причина за забавяне при
  // голям фонд). Нарочно БЕЗ UNIQUE на barcode: съществуващи инсталации
  // може вече да имат дублирани/празни баркодове от по-стари данни или
  // ръчно въведени грешки — добавянето на UNIQUE constraint би счупило
  // миграцията (и оттам — стартирането на програмата) на всяка база с
  // такъв дубликат, без предварителна проверка/почистване на данните.
  // Истинското UNIQUE изисква отделна стъпка за откриване и решаване на
  // дублиращите се баркодове от библиотекаря, не тихо налагане тук.
  { version: 4, run: () => {
    db.exec('CREATE INDEX IF NOT EXISTS idx_books_barcode ON books(barcode)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_loans_book_open ON loans(book_id, date_in)');
  } },
  // v5 — "CHECK/authority на enum-подобните TEXT колони" (последната точка от
  // "евтините поправки" на анализа за Фаза 4). Логиката е в db/enum-triggers.js
  // (вижте там пълния коментар защо са тригери, а не истински CHECK constraint,
  // и списъка на изрично изключените колони) — изнесена в отделен модул, за да
  // може и тестовете да прилагат абсолютно същите тригери върху собствената си
  // тестова база, по образец на BOOKS_FTS_SETUP_SQL/READERS_FTS_SETUP_SQL.
  { version: 5, run: () => { applyEnumTriggers(db); } },
  // v6 — кои години вече имат автоматично вписани официални празници в
  // calendar_closed (виж bg-holidays.js). Пази се списък, а не флаг, за да
  // се засява всяка нова година точно веднъж и изтритото от библиотекаря да
  // не се връща само.
  { version: 6, run: () => { ensureColumns('settings', { holidays_seeded: 'TEXT' }); } },
  /* v7 (v2.3.0) — два пропуска, намерени с измерване и с одит:
     1) books(acquisition_id) нямаше индекс, макар „Постъпления" да прави по две
        корелирани подзаявки на партида точно по това поле. Измерено при 15 000
        книги: 1317 ms за 400 реда; със същия индекс — 9 ms (146× по-бързо).
     2) inventory_sessions.mode: видът на проверката (пълна / представителна по
        чл. 40, т. 2) се решаваше при приключване, но никъде не се пазеше — в
        списъка приключена представителна с 0 липсващи изглеждаше точно като пълна
        с 0 липсващи, а при проверка от регионалната библиотека няма как да се
        докаже кое е било. Старите сесии остават NULL — за тях просто не се знае. */
  { version: 7, run: () => {
    db.exec('CREATE INDEX IF NOT EXISTS idx_books_acquisition ON books(acquisition_id)');
    ensureColumns('inventory_sessions', { mode: 'TEXT' });
  } }
];
function runMigrations() {
  const from = db.pragma('user_version', { simple: true });
  const pending = MIGRATIONS.filter(m => m.version > from).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    // Одит v2.3.1 №2/№22: `from` е прочетено ЕДНОКРАТНО, извън транзакция —
    // при две станции, стартиращи едновременно срещу празна обща (мрежова)
    // база, и двете могат да изчислят еднакво `pending`, преди която и да е
    // да е приложила и една миграция. .immediate() по-долу вече сериализира
    // самия запис (виж поправката на конкурентността), но не пречи на ВТОРАТА
    // станция да опита да приложи миграция, която ПЪРВАТА вече е приложила,
    // докато ѝ е чакала реда. Проверено директно с два реални процеса
    // (test/two-process-locking.test.js): при СЕГАШНИТЕ миграции това не
    // гърми, защото всяка от тях се оказва случайно идемпотентна сама по себе
    // си (ensureColumns()/CREATE ... IF NOT EXISTS/FTS5 мълчаливо толерира
    // повторен INSERT — виж search-fts.js). Разчитането на тази случайност
    // обаче е точно рискът, който одитът посочи — бъдеща миграция може и да
    // не е идемпотентна (напр. UPDATE, който трупа стойност). Затова
    // user_version се прочита ОТНОВО тук, ВЪТРЕ в самата транзакция (под
    // заключването за запис, взето от .immediate()) — станцията, дошла
    // втора, вижда версията вече вдигната и прескача m.run() съвсем изрично.
    db.transaction(() => {
      const current = db.pragma('user_version', { simple: true });
      if (current >= m.version) return;
      m.run();
      db.pragma('user_version = ' + m.version);
    }).immediate();
    console.log(`Схемата на базата данни е обновена до версия ${m.version}.`);
  }
  const finalVersion = pending.length ? pending[pending.length - 1].version : from;
  if (finalVersion < CURRENT_SCHEMA_VERSION) db.pragma('user_version = ' + CURRENT_SCHEMA_VERSION);
}

/* ---------------- Местоположение на базата данни (за работа в мрежа) ----------------
   IPC handler-ите извадени в handlers/db-location.js (Фаза 4, стъпка 9 от
   разбиването на монолита main.js на модули по домейн). configPath/
   readConfig/writeConfig/resolveDbDir/resolveDbPath остават тук — ползва ги
   и initDb() при стартиране, извън обхвата на този модул. */
require('./handlers/db-location')(ipcMain, {
  app, dialog, fs, path,
  getDb: () => db, setDb: (v) => { db = v; }, getMainWindow: () => mainWindow,
  run, readConfig, writeConfig, updateConfig, resolveDbDir, resolveDbPath
});

/* ---------------- Резервни копия ----------------
   Извадени в handlers/backup.js (Фаза 4, стъпка 1 от разбиването на монолита
   main.js на модули по домейн) — самостоятелен домейн, никой друг код не
   вика функциите му. autoBackupIfNeeded() се извиква по-долу в
   app.whenReady(). */
const backupHandlers = require('./handlers/backup')(ipcMain, {
  app, dialog, fs, path,
  getDb: () => db, setDb: (v) => { db = v; }, getMainWindow: () => mainWindow,
  run, logAudit, resolveDbDir, resolveDbPath
});
const { autoBackupIfNeeded } = backupHandlers;

/* ---------------- Защита на лични данни: ЕГН / № лична карта (обща парола) ----------------
   Извадени в handlers/pdp.js (Фаза 4, стъпка 35). maskReaderRow/
   maskReaderRows/preparePiiForWrite се връщат обратно, защото
   handlers/readers.js (по-нататък в този файл) вече ги ползва по референция. */
const { maskReaderRow, maskReaderRows, preparePiiForWrite } = require('./handlers/pdp')(ipcMain, {
  getDb: () => db, run, logAudit
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    resizable: true,
    icon: path.join(__dirname, 'icon.ico'),
    title: 'InvLib · Библиотечна система',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  // Сигурност (Фаза 3): приложението никога легитимно не отваря нов прозорец
  // и не навигира извън заредения src/index.html (вътрешното "рутиране" по
  // изгледи е само смяна на location.hash, което не задейства тези събития —
  // виж app.js). Всеки опит — независимо дали от неочакван код, компрометиран
  // renderer или инжектирано съдържание — се отказва тук. Ако все пак дойде
  // легитимен адрес за отваряне (напр. бъдещ линк с target="_blank"), той се
  // праща към системния браузър вместо в самия прозорец на приложението.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  return win;
}

/* ---------------- Автоматично обновяване (GitHub Releases) ----------------
   Работи само в инсталирана (пакетирана) версия — при `npm start` в режим
   на разработка автоматично се прескача, за да не пречи. Изисква публичен
   GitHub Release, съдържащ инсталатора и latest.yml (виж README). */
function initAutoUpdate(win) {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
  autoUpdater.on('checking-for-update', () => send('update:status', { state: 'checking' }));
  autoUpdater.on('update-available', (info) => send('update:status', { state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send('update:status', { state: 'not-available' }));
  autoUpdater.on('download-progress', (p) => send('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update:status', { state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => send('update:status', { state: 'error', message: err.message }));
  autoUpdater.checkForUpdates().catch(err => console.error('Автообновяване:', err.message));
}
ipcMain.handle('app:checkForUpdates', () =>
  run(() => {
    if (!app.isPackaged) throw new Error('Проверката за обновления работи само в инсталираната програма.');
    autoUpdater.checkForUpdates().catch(err => console.error('Автообновяване:', err.message));
    return true;
  })
);
ipcMain.handle('app:installUpdate', () => run(() => { autoUpdater.quitAndInstall(); }));

let mainWindow;

/* Само едно копие на програмата наведнъж. Без това всяко следващо щракване върху
   иконата вдига нов процес срещу СЪЩИЯ файл на базата; а при неуспешен старт (виж
   .catch по-долу) тези процеси остават невидими и заключват файла един по един.
   Второто стартиране само изважда напред вече отворения прозорец. */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  pruneOldLogs();
  /* Повреден или непрочетим config.json е тихата версия на „базата изчезна“:
     програмата пада на локалната папка и отваря ПРАЗНА база, а библиотекарят
     вижда библиотека без нито една книга, без нищо да обяснява защо. Затова
     провалът се показва изрично, преди базата да бъде докосната. */
  try {
    readConfigOrThrow();
  } catch (err) {
    logToFile('error', 'config.json не се прочете: ' + err.message);
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      noLink: true,
      buttons: ['Изход', 'Продължи с локална база'],
      defaultId: 0,
      cancelId: 0,
      title: 'Настройките на програмата не могат да бъдат прочетени',
      message: 'Файлът с настройките (config.json) не можа да бъде прочетен.',
      detail: 'В него се пази пътят до базата данни на библиотеката. Докато не бъде прочетен, '
        + 'програмата не знае къде е базата и би отворила ПРАЗНА локална база.\n\n'
        + 'Причина: ' + err.message + '\n'
        + '(Ако до config.json се е появил файл config.bad.json, той е копие на повредения — '
        + 'от него може да се прочете пътят до базата. При заключен файл такова копие може и да липсва.)\n\n'
        + '• „Изход“ — безопасният избор. Затворете програмата на другите компютри, проверете дали '
        + 'антивирусната програма не държи файла, и опитайте пак.\n'
        + '• „Продължи с локална база“ — данните, въведени оттук нататък, НЯМА да попаднат в общата база.'
    });
    if (choice === 0) { app.exit(0); return; }
  }
  // Преди каквото и да е докосване на базата — виж askAboutMissingDbFolder по-горе.
  if (!ensureDbFolderAvailable({ readConfig, existsSync: fs.existsSync, ask: askAboutMissingDbFolder })) {
    logToFile('warn', 'Стартирането е прекратено — настроената папка с базата данни не е достъпна.');
    app.exit(0);
    return;
  }
  initDb();
  // "Кой служител работи в момента" е настройка на този компютър (не на споделената база
  // данни) — всяко работно място пази собствения си избор в локалния config.json.
  CURRENT_USER = readConfig().lastUserName || '';
  autoBackupIfNeeded();
  // Одит v2.3.1 №25: „заделена" резервация нямаше никакъв механизъм за
  // изтичане — веднъж на старт е достатъчно (срокът е в цели дни, виж
  // HOLD_EXPIRE_DAYS в handlers/holds.js), периодичен таймер е излишен.
  expireStaleHolds();
  startAutoPushTimer();
  mainWindow = createWindow();
  initAutoUpdate(mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
}).catch((err) => {
  /* Без този .catch всяка грешка при старта (най-често повредена или недостъпна
     база — прекъснато писане по мрежов дял, антивирус, лош сектор) се превръщаше в
     необработено отхвърляне на promise: createWindow() никога не се стигаше, прозорец
     не се появяваше, съобщение нямаше, а процесът оставаше жив завинаги. За
     библиотекаря това изглежда като „щраквам иконата и не се случва нищо".
     Проверено: повредена база → 0 прозореца, 0 диалога, процесът виси.
     Затова тук: разбираемо съобщение, точния технически текст в дневника, и изход. */
  const detail = (err && err.message) ? err.message : String(err);
  try { logToFile('error', 'Стартирането пропадна: ' + detail); } catch (e) { /* дневникът е последната ни грижа тук */ }
  try {
    /* Съветът дотук беше „копирайте последното копие върху library.db“ и той е
       ОПАСЕН по два начина. Първо, при включена защита на личните данни най-новото
       копие е .invbak — криптирано; копирано върху library.db то дава файл, който
       програмата не може да отвори, а оригиналът вече е презаписан. Второ, „базата
       е заключена от друга станция“ стига до същия този диалог и не е повреда
       изобщо — възстановяване там означава да се загуби работата на другия компютър.
       Затова: първо се пази копие на текущия файл, възстановяването минава през
       самата програма, а заключването се назовава отделно. */
    const locked = /locked|busy/i.test(detail);
    dialog.showErrorBox('InvLib не можа да се стартира',
      'Базата данни не можа да бъде отворена.\n\n' + detail + '\n\n' +
      (locked
        ? 'Този текст обикновено НЕ означава повреда, а че базата се ползва от друг компютър '
          + 'или от втори отворен прозорец на програмата.\nКакво да направите:\n'
          + '• Затворете програмата на другите работни места и опитайте пак.\n'
          + '• Проверете дали програмата не е останала отворена два пъти на този компютър.\n'
          + '• НЕ възстановявайте резервно копие — това би изтрило работата на другия компютър.\n'
        : 'Най-честата причина е повреден файл или недостъпна папка (изключен мрежов диск).\n'
          + 'Какво да направите:\n'
          + '• Проверете дали мрежовият диск с базата е включен и достъпен.\n'
          + '• НЕ копирайте резервно копие върху library.db. Ако защитата на личните данни е '
          + 'включена, копията са криптирани (.invbak) и така базата става неотваряема, а '
          + 'оригиналът се губи безвъзвратно.\n'
          + '• Вместо това: преименувайте library.db на library-повреден.db (не я триете — може '
          + 'да се спаси), пуснете програмата отново и възстановете копието от „Настройки“ → '
          + '„Резервни копия“, откъдето разкриптирането става само.\n') +
      '• Ако проблемът остава, изпратете дневника от папката „logs" на разработчика.');
  } catch (e) { /* ако и диалогът не тръгне, поне не увисваме */ }
  app.exit(1);
});

app.on('window-all-closed', () => {
  stopAutoPushTimer();
  flushCatalogWrite(); // не губи последната промяна, ако насроченият (debounced) запис още не е станал
  if (db) db.close();
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- Помощни функции ---------------- */
function friendlyDbError(err) {
  const m = err.message || '';
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || m.includes('UNIQUE constraint failed')) {
    if (m.includes('books.inv_number')) return 'Този инвентарен номер вече е зает от друг документ.';
    if (m.includes('books.barcode')) return 'Този баркод вече е зает от друг документ.';
    if (m.includes('readers.card_no')) return 'Тази читателска карта вече е издадена на друг читател.';
    if (m.includes('categories.name')) return 'Категория с това име вече съществува.';
    if (m.includes('employees.name')) return 'Служител с това име вече съществува.';
    return 'Стойността вече съществува и трябва да бъде уникална.';
  }
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || m.includes('FOREIGN KEY constraint failed')) {
    return 'Действието е невъзможно, защото записът е свързан с други данни.';
  }
  if (err.code === 'SQLITE_CONSTRAINT_NOTNULL' || m.includes('NOT NULL constraint failed')) {
    return 'Задължително поле липсва.';
  }
  if (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_BUSY_SNAPSHOT' || m.includes('database is locked')) {
    return 'Друг компютър записва в базата данни в момента — изчакайте малко и опитайте пак.';
  }
  if (m.includes('no such column') || m.includes('no such table')) {
    return 'Базата данни не е напълно обновена за тази версия на програмата. Затворете и рестартирайте програмата; ако грешката продължи, пишете за поддръжка. (' + m + ')';
  }
  return m;
}
function run(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    console.error(err);
    return { ok: false, error: friendlyDbError(err) };
  }
}
function logAudit(action, detail, diff) {
  db.prepare('INSERT INTO audit_log (user, action, detail, diff) VALUES (?, ?, ?, ?)')
    .run(CURRENT_USER || '', action, detail || '', diff && diff.length ? JSON.stringify(diff) : null);
}
// Сравнява старите и новите стойности само на посочените полета и връща онези, които
// реално са се променили — за одитната следа (action_logs.diff в Koha), не целия ред.
function diffFields(oldObj, newObj, fields) {
  const out = [];
  for (const f of fields) {
    const before = oldObj ? oldObj[f] : undefined;
    const after = newObj ? newObj[f] : undefined;
    const nb = before == null ? '' : String(before);
    const na = after == null ? '' : String(after);
    if (nb !== na) out.push({ field: f, before: before ?? null, after: after ?? null });
  }
  return out;
}
const today = () => new Date().toISOString().slice(0, 10);
const yearOf = (d) => (d || today()).slice(0, 4);
function value(rows) { return rows.reduce((s, r) => s + (Number(r.price) || 0), 0); }
function pctRequired(n) { return n <= 50000 ? 10 : n <= 200000 ? 5 : 2; }
function naturalLoss(n, freeAccessPct) { return (freeAccessPct > 50 ? n * 10 : n * 5) / 1000; }

/* ---------------- Текущ служител (за одитната следа) ---------------- */
ipcMain.handle('app:setUser', (e, name) =>
  run(() => {
    CURRENT_USER = (name || '').trim();
    // Не readConfig()+writeConfig(): при неуспешен прочит това презаписваше
    // файла с празен обект и трие `dbFolder`. Виж updateConfig по-горе.
    updateConfig((cfg) => { cfg.lastUserName = CURRENT_USER; });
    return CURRENT_USER;
  })
);
ipcMain.handle('app:getUser', () => run(() => CURRENT_USER));

/* ---------------- Служители ----------------
   Извадени в handlers/employees.js (Фаза 4, стъпка 6 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/employees')(ipcMain, { getDb: () => db, run, logAudit });
ipcMain.handle('app:getVersion', () => run(() => app.getVersion()));
// Отваря папката с дневниците на грешки (logs/) в системния файлов мениджър —
// удобно, за да прикачи librarianят файловете при заявка за поддръжка.
ipcMain.handle('app:openLogsFolder', () => run(() => { shell.openPath(logsDir()); }));

/* ---------------- Търсене по ISBN (Google Books, Open Library) и SRU (MARC) ----------------
   Извадени в handlers/isbn-lookup.js (Фаза 4, стъпка 10 от разбиването на
   монолита main.js на модули по домейн) — изцяло самостоятелен домейн. */
require('./handlers/isbn-lookup')(ipcMain, { net, getDb: () => db });

/* ---------------- Настройки ----------------
   Извадени в handlers/settings.js (Фаза 4, стъпка 33, един от "големите
   пет"). settings:noticeDefaults остава тук (не в handlers/settings.js) —
   вижте коментара в handlers/settings.js защо: TDZ капан като при logEvent,
   защото DEFAULT_NOTICE_* идват от handlers/notices.js, чийто require()
   стои по-нататък в този файл. LOGO_MIME/LOCAL_PHOTO_MAX_BYTES се връщат
   обратно, защото handlers/local-photo.js (по-нататък в този файл) вече ги
   ползва по референция. */
const { LOGO_MIME, LOCAL_PHOTO_MAX_BYTES } = require('./handlers/settings')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path
});
ipcMain.handle('settings:noticeDefaults', () =>
  run(() => ({
    subject: DEFAULT_NOTICE_SUBJECT, body: DEFAULT_NOTICE_BODY, sms: DEFAULT_NOTICE_SMS,
    placeholders: NOTICE_PLACEHOLDERS
  }))
);

/* ---------------- Категории ----------------
   Извадени в handlers/categories.js (Фаза 4, стъпка 7 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/categories')(ipcMain, { getDb: () => db, run });

/* ---------------- Книги (фонд) + Лимит на броя записи ----------------
   Извадени в handlers/books.js (Фаза 4, стъпка 34, последният от "големите
   пет"). BOOK_SELECT/BOOK_FIELDS/checkRecordLimit се връщат обратно, защото
   по-рано извадени модули (acquisitions.js, deaccession-acts.js, loans.js,
   catalog.js, readers.js) вече ги ползват по пряка референция в обект,
   подаден на require(), позициониран СЛЕД това място — същият модел, както
   при LOAN_SELECT/firstActiveHold. */
const { BOOK_SELECT, BOOK_FIELDS, checkRecordLimit } = require('./handlers/books')(ipcMain, {
  getDb: () => db, run, logAudit, today, ftsQuery, cnSortKey, diffFields, scheduleCatalogWrite, normalizeScanCode
});

/* ---------------- Контрол на авторитетните данни ----------------
   Извадени в handlers/authorities.js (Фаза 4, стъпка 11 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/authorities')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Контролирани номенклатури (Koha: authorised_values) ----------------
   Извадени в handlers/av.js (Фаза 4, стъпка 12 от разбиването на монолита
   main.js на модули по домейн). */
require('./handlers/av')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Инвентарна книга (Приложение № 4 към чл. 16, ал. 1) ----------------
   Извадени в handlers/inv-book.js (Фаза 4, стъпка 13 от разбиването на
   монолита main.js на модули по домейн). */
require('./handlers/inv-book')(ipcMain, { getDb: () => db, run });

/* ---------------- Постъпления (партиди) ----------------
   Извадени в handlers/acquisitions.js (Фаза 4, стъпка 14 от разбиването на
   монолита main.js на модули по домейн). BOOK_SELECT се подава по
   стойност (const низ, никога не се преприсвоява). */
require('./handlers/acquisitions')(ipcMain, { getDb: () => db, run, logAudit, BOOK_SELECT, yearOf });

/* ---------------- Отчисляване (актове) ----------------
   Извадени в handlers/deaccession-acts.js (Фаза 4, стъпка 15 от разбиването
   на монолита main.js на модули по домейн). */
require('./handlers/deaccession-acts')(ipcMain, {
  getDb: () => db, run, logAudit, BOOK_SELECT, yearOf, scheduleCatalogWrite, flushCatalogWrite, normalizeScanCode
});

/* ---------------- КДБФ — книга за движение на фонда ---------------- */
require('./handlers/kdbf')(ipcMain, { getDb: () => db, run, yearOf });

/* ---------------- Читатели ---------------- */
require('./handlers/readers')(ipcMain, {
  getDb: () => db, run, logAudit, today, ftsQuery,
  maskReaderRow, maskReaderRows, preparePiiForWrite, diffFields, checkRecordLimit,
  dialog, getMainWindow: () => mainWindow, fs, csvCell, normalizeScanCode
});

/* ---------------- Печат → PDF файл ----------------
   Директно записване на текущия печатен документ в PDF (printToPDF) —
   заобикаля системния диалог на Windows, който не визуализира Electron
   съдържание. Виж коментара в handlers/print.js. */
require('./handlers/print')(ipcMain, {
  getMainWindow: () => mainWindow, dialog, fs, path, app, shell, logAudit
});

/* ---------------- Читателска сметка (Koha: accountlines) ----------------
   amount > 0 = начислено (дължи се), amount < 0 = платено. Балансът е SUM(amount).
   Не е касов модул — само дневник на движенията + квитанция за печат. */
require('./handlers/account')(ipcMain, { getDb: () => db, run, logAudit, today });

/* ---------------- Предложения за покупка от читатели (Koha: suggestions) ----------------
   заявено → одобрено → поръчано → получено/отказано. При „получено" може да се закачи
   към партида в Постъпления, за да остане следа откъде реално е дошла книгата. */
require('./handlers/suggestions')(ipcMain, { getDb: () => db, run, logAudit, today });

/* ---------------- Обслужване по домовете (Koha: housebound) ----------------
   Извадени в handlers/housebound.js (Фаза 4, стъпка 8 от разбиването на
   монолита main.js на модули по домейн). logEvent се подава по референция
   (function declaration по-долу в "Заемания" — hoisted, вече е дефинирана
   тук). */
require('./handlers/housebound')(ipcMain, {
  getDb: () => db, run, logAudit, logEvent, today
});

/* ---------------- Лични данни: анонимизиране (Koha: pseudonymization) ----------------
   Върнати заемания, по-стари от N години, губят връзката с името: закачат се за
   служебния запис „— анонимизирани заемания —", а категорията и годината се снимат в
   anon_category — статистиката остава вярна („дете, 2024 г."), името изчезва.
   Настройка anonymize_years = 0 изключва всичко. Необратимо е — затова е ръчен бутон. */
require('./handlers/gdpr')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Календар на библиотеката ----------------
   Извадени в handlers/calendar.js (Фаза 4, стъпка 4 от разбиването на
   монолита main.js на модули по домейн). workDaysSet/isWorkDay/nextWorkDay/
   closedDaysBetween се връщат обратно тук, защото ги ползва и домейнът
   "Заемания" по-долу (все още неизваден). */
const { workDaysSet, isWorkDay, nextWorkDay, closedDaysBetween } =
  require('./handlers/calendar')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Правила за обслужване по категория читатели ----------------
   Извадени в handlers/circ-rules.js (Фаза 4, стъпка 5 от разбиването на
   монолита main.js на модули по домейн). circRule/readerCategory се връщат
   обратно тук, защото ги ползва и домейнът "Заемания" по-долу (все още
   неизваден). */
const { circRule, readerCategory } =
  require('./handlers/circ-rules')(ipcMain, { getDb: () => db, run, logAudit });

/* ---------------- Поток от събития ----------------
   logEvent остава hoisted function declaration тук (не се мести в
   handlers/loans.js), защото handlers/housebound.js вече го изисква по
   референция по-рано във файла (Фаза 4, стъпка 8) — местенето му в модул
   би счупило реда на зареждане (TDZ грешка при const местене над hoisting). */
function logEvent(kind, opts) {
  try {
    const o = opts || {};
    let bk = null, rd = null;
    if (o.bookId) {
      bk = db.prepare(`SELECT b.language, b.udk, c.name AS category_name
        FROM books b LEFT JOIN categories c ON c.id = b.category_id WHERE b.id = ?`).get(o.bookId);
    }
    if (o.readerId) rd = db.prepare('SELECT category FROM readers WHERE id = ?').get(o.readerId);
    db.prepare(`INSERT INTO events (date, kind, book_id, reader_id, reader_category, book_language, book_udk, book_category, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.date || today(), kind, o.bookId || null, o.readerId || null,
        rd ? rd.category : null, bk ? bk.language : null, bk ? bk.udk : null,
        bk ? bk.category_name : null, o.note || null);
  } catch (err) {
    /* Дотук грешката се преглъщаше тук — и това обезсмисляше транзакциите около
       заемане/връщане: уловено изключение НЕ отменя транзакция в SQLite, тоест
       UPDATE-ът на заемането се записваше, а събитието — не, и годишният отчет
       оставаше с едно заемане по-малко от инвентарната книга. Точно провалът,
       който транзакцията трябва да изключи.
       Затова изключението се препредава: извикващият е в транзакция и тя ще бъде
       отменена изцяло. Записът в дневника остава — той носи техническата причина. */
    console.error('Регистър на събитията:', err.message);
    throw new Error('Действието не беше вписано в регистъра на събитията (' + err.message
      + ') — операцията е отменена, за да не се разминат отчетите. Опитайте отново.');
  }
}

/* ---------------- Резервации ----------------
   Извадени в handlers/holds.js (Фаза 4, стъпка 21 от разбиването на
   монолита main.js на модули по домейн). firstActiveHold/
   consumeHoldOnCheckout/activateHoldOnReturn се връщат обратно тук, защото
   ги ползва домейнът "Заемания" по-долу. */
const { firstActiveHold, consumeHoldOnCheckout, activateHoldOnReturn, freeCopies, activeHolds, expireStaleHolds } =
  require('./handlers/holds')(ipcMain, { getDb: () => db, run, logAudit, normalizeScanCode });

/* ---------------- Заемания ----------------
   Извадени в handlers/loans.js (Фаза 4, стъпка 22 от разбиването на
   монолита main.js на модули по домейн) — един от "големите пет".
   LOAN_SELECT се връща обратно, защото го ползват и все още неизвадените
   домейни "Табло" и "Просрочени: напомняния". */
const { LOAN_SELECT, effectiveDaysLate } = require('./handlers/loans')(ipcMain, {
  getDb: () => db, run, logAudit, today, logEvent, BOOK_SELECT, scheduleCatalogWrite,
  circRule, readerCategory, nextWorkDay, closedDaysBetween,
  firstActiveHold, consumeHoldOnCheckout, activateHoldOnReturn, normalizeScanCode,
  freeCopies, activeHolds
});

/* ---------------- Периодика ----------------
   Преместено ПРЕДИ "Табло" (беше по-надолу), защото Табло вече ползва
   countOverduePeriodicals за реда "За днес" — периодика няма нужда от нищо,
   регистрирано между старото и новото си място, преместването е безопасно. */
const { countOverduePeriodicals } =
  require('./handlers/periodicals')(ipcMain, { getDb: () => db, run, logAudit, today });

/* ---------------- Табло ---------------- */
require('./handlers/dashboard')(ipcMain, {
  getDb: () => db, run, today, yearOf, pctRequired, isWorkDay, LOAN_SELECT, countOverduePeriodicals,
  effectiveDaysLate
});

/* ---------------- Инвентаризация ---------------- */
require('./handlers/inventory-sessions')(ipcMain, {
  getDb: () => db, run, logAudit, pctRequired, naturalLoss, normalizeScanCode
});

/* ---------------- Просрочени: напомняния ----------------
   Извадени в handlers/notices.js (Фаза 4, стъпка 25 от разбиването на
   монолита main.js на модули по домейн). Константите за шаблоните по
   подразбиране и списъкът от плейсхолдъри се връщат обратно, защото ги
   ползва все още неизвадената "Настройки" (settings:noticeDefaults). */
const { DEFAULT_NOTICE_SUBJECT, DEFAULT_NOTICE_BODY, DEFAULT_NOTICE_SMS, NOTICE_PLACEHOLDERS } =
  require('./handlers/notices')(ipcMain, {
    getDb: () => db, run, today, LOAN_SELECT, EUR_RATE, isValidEmail, shell, effectiveDaysLate
  });

/* ---------------- МЗС ---------------- */
require('./handlers/mzs')(ipcMain, { getDb: () => db, run, logAudit, yearOf });

// Дневник на библиотеката (Раздел А / Раздел Б) → handlers/dnevnik.js
// (Фаза 4, стъпка 30). dnevnikSumRow се връща обратно, защото
// handlers/stats.js (извадено по-рано) вече го ползва по референция.
const { dnevnikSumRow } = require('./handlers/dnevnik')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs
});

/* ============================================================================
   КРАЕВЕДСКИ МОДУЛИ: аналитично описание, персоналии, летопис, снимки, връзки
   (Фаза 4, стъпка 31) → handlers/analytics.js, persons.js, chronicle.js,
   local-photo.js, links.js. Всеки подмодул чете направо от getDb() — не са
   нужни препратки между тях, освен общите таблици.
   ============================================================================ */
require('./handlers/analytics')(ipcMain, { getDb: () => db, run, logAudit });
require('./handlers/persons')(ipcMain, { getDb: () => db, run, logAudit });
require('./handlers/chronicle')(ipcMain, { getDb: () => db, run, logAudit });
require('./handlers/local-photo')(ipcMain, {
  getDb: () => db, run, dialog, getMainWindow: () => mainWindow, fs, path, LOGO_MIME, LOCAL_PHOTO_MAX_BYTES
});
require('./handlers/links')(ipcMain, { getDb: () => db, run });

/* ============================================================================
   ПРИЕМАНЕ НА ДАННИ ОТ ДРУГИ СИСТЕМИ → handlers/data-import.js (Фаза 4,
   стъпка 36). Цел: читалище с изоставена стара база (АБ, iLib, чужд Excel)
   да мине на тази програма без преписване на ръка.
   ============================================================================ */
require('./handlers/data-import')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path, BOOK_FIELDS, today, cnSortKey
});

/* ============================================================================
   МОБИЛНО СКАНИРАНЕ → handlers/mobile.js (Фаза 4, стъпка 36). Вместо RFID:
   страница, която се отваря на телефона и ползва камерата като баркод
   четец. Списъкът се пренася обратно като текст или файл.
   ============================================================================ */
require('./handlers/mobile')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path, normalizeScanCode
});

/* ============================================================================
   ПОМОЩ СРЕЩУ АНТИВИРУСНИ БЛОКИРОВКИ → handlers/security-exclusions.js
   (Фаза 4, стъпка 36). Докато инсталаторът е без закупен цифров подпис,
   Defender и други антивирусни спират както инсталирането, така и работата
   на вече инсталираната програма.
   ============================================================================ */
require('./handlers/security-exclusions')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path, app, resolveDbDir
});

/* ---------------- Одитна следа ---------------- */
require('./handlers/audit')(ipcMain, { getDb: () => db, run });

/* ---------------- История на търсенията (Koha: search_history) ---------------- */
require('./handlers/search-history')(ipcMain, { getDb: () => db, run, getCurrentUser: () => CURRENT_USER });

/* ---------------- Посещения ---------------- */
require('./handlers/visits')(ipcMain, { getDb: () => db, run });

/* ---------------- Справки и статистика + Готови справки ----------------
   Извадени в handlers/stats.js (Фаза 4, стъпка 29 от разбиването на
   монолита main.js на модули по домейн). dnevnikSumRow е hoisted function
   declaration от все още неизвадения домейн "Дневник на библиотеката". */
require('./handlers/stats')(ipcMain, { getDb: () => db, run, yearOf, value, dnevnikSumRow });

// Полетата и обвивката {library, place, generated, items} трябва да съвпадат ТОЧНО с
// формàта, който `inventar-biblioteka.html` и страницата page-katalog.html на сайта вече
// очакват (кратки ключове inv/a/t/s/c/p/y/v/l/u/g/o/k/n/cv/av) — сайтът чете това по
// живо от GitHub и не знае нищо за схемата на Electron версията.
/* opacMap: вътрешна стойност → публичен надпис от номенклатурите (opac_label).
   Навън не трябва да се вижда вътрешният жаргон — затова отделът и езикът минават
   през превода, ако библиотекарят е задал публичен надпис. */
function publicBookFields(b, opacMap) {
  const pub = (cat, v) => (opacMap && opacMap[cat] && opacMap[cat][v]) || v || '';
  return {
    inv: b.inv_number, a: b.author || '', t: b.title || '', s: b.subtitle || '',
    c: b.city || '', p: b.publisher || '', y: b.year || '', v: b.category_name || '',
    l: pub('language', b.language), u: b.udk || '', g: b.call_number || '', o: pub('department', b.department),
    // „Налична" зависи и от състоянието, не само от свободните бройки: книга със
    // статус „липсващ" или „за реставрация" физически я няма на рафта, а публичният
    // каталог я обявяваше за налична само защото по нея няма отворено заемане —
    // читателят идва специално за книга, за която библиотеката вече знае, че липсва.
    k: b.keywords || '', n: b.annotation || '', cv: b.cover_url || '',
    // Одит v2.3.1 №9: NULL status (стари/непрегледани данни — обикновено от
    // внос отпреди enum тригера) МИНАВАШЕ за „наличен" тук, значи и в
    // публичния онлайн каталог — читател виждаше „налична" книга, чието
    // реално състояние библиотеката дори не е потвърдила. NULL вече не се
    // третира като наличност никъде — само изричното 'наличен'.
    av: (b.available > 0 && b.status === 'наличен') ? 1 : 0,
    // d = дата на постъпване: страницата извежда „Нови постъпления" сама от нея.
    // Старите версии на страницата не познават ключа и просто го подминават.
    d: b.register_date || ''
  };
}
function buildCatalogPayload() {
  /* НЕ NULL-безопасно, и това е нарочно — виж бележката при catalog:status в
     handlers/catalog.js: документ с непознат статус не се публикува навън. */
  const books = db.prepare(`${BOOK_SELECT} WHERE b.status != 'отчислен' AND COALESCE(b.department,'') != 'служебен' ORDER BY b.title`).all();
  const s = db.prepare('SELECT lib_name, place FROM settings WHERE id = 1').get() || {};
  const opacMap = {};
  for (const r of db.prepare(`SELECT category, value, opac_label FROM authorised_values WHERE opac_label IS NOT NULL AND TRIM(opac_label) <> ''`).all()) {
    (opacMap[r.category] = opacMap[r.category] || {})[r.value] = r.opac_label;
  }
  // Витрините сочат книги по публичния им ключ (инв. №). Книга, която е спряла да
  // се публикува (отчислена/служебна), отпада мълчаливо; празна витрина не се излъчва.
  const published = new Set(books.map(b => b.inv_number));
  const shelves = db.prepare(`
    SELECT sh.name, b.inv_number FROM catalog_shelves sh
    JOIN catalog_shelf_items si ON si.shelf_id = sh.id
    JOIN books b ON b.id = si.book_id
    ORDER BY sh.sort, sh.name, si.sort, b.title
  `).all().reduce((m, r) => {
    if (!published.has(r.inv_number)) return m;
    (m[r.name] = m[r.name] || []).push(r.inv_number);
    return m;
  }, {});
  const shelfList = Object.entries(shelves).map(([name, items]) => ({ name, items }));
  return {
    library: s.lib_name || '', place: s.place || '',
    generated: new Date().toISOString().slice(0, 10),
    items: books.map(b => publicBookFields(b, opacMap)),
    ...(shelfList.length ? { shelves: shelfList } : {})
  };
}
function catalogPayloadItemCount(payload) {
  return Array.isArray(payload) ? payload.length : (payload && Array.isArray(payload.items) ? payload.items.length : 0);
}
// Връща {written:true} при успешен запис, {written:false, blocked:true} ако предпазната
// мярка е спряла записа (виж коментара долу), или {written:false} при обикновена грешка/
// липсваща папка. Автоматичните извиквания (след запис на книга, заемане и т.н.) само
// подминават резултата; ръчните бутони го ползват, за да покажат ясно съобщение.
//
// Декъплинг на записа при всяка мутация (Фаза 2): вместо да презаписваме
// целия katalog.json синхронно при всяко книга/заемане (write amplification
// — файлът може да е няколко MB при 15 000+ записа), натрупваме "мръсен"
// флаг и записваме веднъж, известно време след последната промяна. Ръчните
// действия (writeNow, gitPublishNow) вместо това "изпразват" веднага текущия
// таймер и пишат синхронно, за да дадат точна обратна връзка на потребителя.
const CATALOG_WRITE_DEBOUNCE_MS = 4000;
function writeCatalogIfConfigured() {
  try {
    const s = db.prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
    if (!s || !s.catalog_folder) return { written: false };
    const file = path.join(s.catalog_folder, 'katalog.json');
    const payload = buildCatalogPayload();
    // Предпазна мярка: не презаписвай непразен публикуван каталог с празен. Това пази от
    // случаен запис от прясна/тестова инсталация (празен фонд) върху вече публикувани
    // реални данни — например, ако папката е свързана, преди фондът да е зареден в тази база.
    if (payload.items.length === 0 && fs.existsSync(file)) {
      try {
        const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (catalogPayloadItemCount(existing) > 0) {
          console.error('Пропуснат автоматичен запис на каталога: новите данни са празни, а публикуваният файл не е.');
          return { written: false, blocked: true };
        }
      } catch (e) { /* повреден/нечетим съществуващ файл — продължи с обичайния запис */ }
    }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return { written: true };
  } catch (err) {
    console.error('Автоматичен запис на каталога:', err.message);
    // Одит v2.3.1 №8: до тук стигаше само конзолата — catalog:writeNow
    // проверяваше единствено полето `blocked`, така че реален провал на
    // записа (напр. изключен мрежов диск: ENOENT) минаваше за успех и
    // библиотекарят виждаше зелено "Каталогът е обновен.", докато
    // публикуваният katalog.json си оставаше стар/недокоснат. `error` тук
    // носи причината до самия IPC канал, за да я покаже интерфейсът.
    return { written: false, error: err.message };
  }
}
// generic debounce/coalesce помощник (debounce.js) — schedule() слива много
// бързи последователни мутации в един-единствен запис; flush() го изпълнява
// веднага (използва се от ръчните действия writeNow/gitPublishNow/chooseFolder
// и при затваряне на приложението, за да не се загуби последната промяна).
const catalogWriteDebouncer = createDebouncer(writeCatalogIfConfigured, CATALOG_WRITE_DEBOUNCE_MS);
function scheduleCatalogWrite() { catalogWriteDebouncer.schedule(); }
function flushCatalogWrite() { return catalogWriteDebouncer.flush(); }

/* ---------------- Онлайн каталог (публикуване през GitHub) + Витрини +
   Експорт в библиотечни формати ----------------
   Извадени в handlers/catalog.js (Фаза 4, стъпка 32 от разбиването на
   монолита main.js на модули по домейн) и handlers/shelves.js (стъпка 3).
   scheduleCatalogWrite/flushCatalogWrite/buildCatalogPayload остават тук
   (виж коментарите по-горе при дефиницията им) — по-рано извадени модули
   вече ги ползват по пряка референция в обект, подаден на техния require(),
   изпълнен ПРЕДИ това място; преместването им би било TDZ капан като при
   logEvent. startAutoPushTimer/stopAutoPushTimer се връщат обратно, защото
   app.whenReady()/window-all-closed ги викат само вътре в отложени
   callback-и — редът там няма значение. */
require('./handlers/shelves')(ipcMain, {
  getDb: () => db, run, logAudit, scheduleCatalogWrite, normalizeScanCode
});
const { startAutoPushTimer, stopAutoPushTimer } = require('./handlers/catalog')(ipcMain, {
  getDb: () => db, run, logAudit, dialog, getMainWindow: () => mainWindow, fs, path, execFile,
  BOOK_SELECT, csvCell, flushCatalogWrite, buildCatalogPayload
});
