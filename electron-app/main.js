const { app, BrowserWindow, ipcMain, dialog, net, shell, Menu } = require('electron');
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
/* Приема и масив (от обвивките на console.*), и обикновени аргументи. Одит
   v2.4.14: пет от седемте места подаваха НИЗ, `args.map` хвърляше TypeError,
   собственият catch на функцията го поглъщаше и в дневника не влизаше нищо —
   включително при „Стартирането пропадна“, тоест точно когато библиотекарят е
   помолен да изпрати дневника. */
function logToFile(level, args, ...rest) {
  if (!Array.isArray(args)) args = [args, ...rest];
  return logToFileArr(level, args);
}
function logToFileArr(level, args) {
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
/* Разделя SQL текст на отделни изявления. Пропуска низовете в кавички и
   коментарите, за да не реже вътре в тях, и — съществено — разпознава тялото
   BEGIN … END на тригер: db/schema.sql съдържа точно един такъв
   (trg_loans_capacity), чието тяло има собствена точка и запетая. Първата версия
   го режеше на две негодни половини и при резервната пътека тригерът, който пази
   срещу двойно заемане на един екземпляр, изчезваше безшумно. */
function splitSqlStatements(sql) {
  const out = [];
  let cur = '', q = null, depth = 0;
  /* Думата се приема само ако е ЦЯЛА от двете страни: `end_date` и `ENDING`
     не са ключовата дума END. Дотук се проверяваше само лявата граница, а
     [A-Za-z]+ спира на `_` и на цифра — тоест идентификатор в тялото на тригер
     се четеше като край на блок. */
  const wordAt = (i) => {
    const m = /^[A-Za-z]+/.exec(sql.slice(i, i + 12));
    if (!m) return '';
    const after = sql[i + m[0].length];
    if (after && /[A-Za-z0-9_]/.test(after)) return '';
    return m[0].toUpperCase();
  };
  const isWordBoundary = (i) => i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]);
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; cur += '\n'; continue; }
    /* Блоковите коментари се пропускат изцяло. Дотук се разпознаваха само
       редовите: db/schema.sql вече съдържа блокови, а апостроф вътре в такъв
       отваряше състояние „низ“, което никога не се затваря — целият остатък от
       файла се слепваше в едно изявление. */
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 1;
      cur += ' ';
      continue;
    }
    if (isWordBoundary(i)) {
      const w = wordAt(i);
      // BEGIN брои само вътре в CREATE TRIGGER — иначе би хванало и BEGIN TRANSACTION,
      // каквото schema.sql не съдържа, но по-добре да не разчитаме на това.
      if (w === 'BEGIN' && /CREATE\s+TRIGGER/i.test(cur)) depth++;
      /* CASE … END вътре в тялото на тригер НЕ затваря блока. SQLite допуска
         такъв израз и старата версия го приемаше за край: тригерът изчезваше, а
         остатъкът от тялото му (например DELETE) се изпълняваше като обикновено
         изявление върху живата база. Затова CASE увеличава дълбочината заедно с
         BEGIN, а END намалява — така двете се съкращават взаимно. */
      else if (w === 'CASE' && depth > 0) depth++;
      else if (w === 'END' && depth > 0) {
        depth--;
        cur += sql.slice(i, i + 3); i += 2;
        // Точката и запетаята след последния END затваря целия CREATE TRIGGER.
        continue;
      }
    }
    if (ch === ';' && depth === 0) { if (cur.trim()) out.push(cur.trim() + ';'); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function resolveDbDir() {
  const cfg = readConfig();
  if (cfg.dbFolder && fs.existsSync(cfg.dbFolder)) return cfg.dbFolder;
  return defaultDbDir();
}
/* Обща ли е базата (мрежова папка)? Дотук отговорът се вземаше от
   `!!readConfig().dbFolder` — но resolveDbDir() пада към ЛОКАЛНАТА папка, когато
   dbFolder е зададена, а е недостъпна, и ensureDbFolderAvailable() с отговор
   „Работи с локална база“ НЕ маха реда от config.json. Тогава journal_mode се
   слагаше DELETE върху локален файл, а диалогът за по-нова база съветваше
   „изтрийте реда dbFolder“ за база, която изобщо не е мрежова (одит v2.4.21).
   Мрежова е тази база, чиято папка НЕ е локалната по подразбиране. */
function dbIsNetwork() {
  try { return path.resolve(resolveDbDir()) !== path.resolve(defaultDbDir()); }
  catch (e) { return !!readConfig().dbFolder; }
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
  const isNetwork = dbIsNetwork(); // папката НЕ е локалната по подразбиране — обичайно мрежов диск
  db = new Database(dbPath);
  /* busy_timeout е настройка на връзката, не запис във файла — и трябва да е ПРЕДИ
     пазача: първото четене на user_version иначе чака подразбиращите се 5 s, а
     миграция над 5 s на другата станция по мрежов дял дава „locked“ вместо
     изчакване (одит v2.4.21). */
  db.pragma('busy_timeout = ' + (isNetwork ? 20000 : 8000));
  /* ПЪРВОТО нещо след отварянето — преди journal_mode (който преобразува файла и
     оставя -wal/-shm до него), преди schema.sql и преди старите backfill-и
     по-долу. Виж дългата бележка при самата функция за какво беше измерено, че се
     случва, когато проверката стои по-късно. */
  assertSchemaNotNewer();
  // WAL разчита на споделена памет (mmap) между процесите, която не работи надеждно през
  // мрежови дялове (SMB/CIFS) — там rollback journal (DELETE) е по-безопасният избор по
  // документацията на SQLite. По-дългият busy_timeout дава повече време за изчакване вместо
  // веднага да гърми "database is locked", когато няколко компютъра пишат почти едновременно.
  db.pragma(isNetwork ? 'journal_mode = DELETE' : 'journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // fs.readFileSync reads transparently through app.asar for plain text files,
  // so the same path works both in dev and in a packaged build.
  const schemaSql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  /* Изпълнява се като едно цяло, но с изрична резервна пътека. Одит v2.4.14:
     db.exec() спира на ПЪРВАТА грешка и всичко след нея във файла остава
     неизпълнено — а целият schema.sql минава ПРЕДИ който и да е ensureColumns().
     Днес това е латентно, защото всяка издадена схема има колоните, върху които
     стъпват индексите; активира се в мига, в който някой добави в schema.sql
     индекс върху колона, която ensureColumns() създава — напълно естествена
     бъдеща стъпка (точно такъв беше idx_books_acquisition във версия 7). Тогава
     един ред отнасяше целия краеведски модул, който стои по-надолу във файла, а
     програмата казваше на библиотекаря „повреден файл, възстановете копие“ при
     напълно здрава база.

     Затова при провал файлът се изпълнява изявление по изявление: успелите си
     остават, неуспелите се запомнят и се ОПИТВАТ ОТНОВО след блоковете
     ensureColumns() (виж retryPendingSchema по-долу), когато липсващите колони
     вече съществуват. Остатъкът се вписва в дневника, вместо да спира
     стартирането. */
  let pendingSchema = [];
  try {
    db.exec(schemaSql);
  } catch (e) {
    console.error('Схемата не се изпълни наведнъж (' + e.message + ') — минава се изявление по изявление.');
    pendingSchema = splitSqlStatements(schemaSql).filter(stmt => {
      try { db.exec(stmt); return false; } catch (e2) { return true; }
    });
  }

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

  /* Изявленията от schema.sql, които не минаха при първия опит, се опитват пак —
     сега липсващите колони вече са добавени от блоковете ensureColumns() по-горе.
     Виж дългата бележка при db.exec(schemaSql). */
  if (pendingSchema.length) {
    const still = pendingSchema.filter(stmt => {
      try { db.exec(stmt); return false; } catch (e) { return true; }
    });
    logToFile(still.length ? 'error' : 'info',
      'Схемата: ' + (pendingSchema.length - still.length) + ' от ' + pendingSchema.length
      + ' отложени изявления минаха след допълването на колоните.'
      + (still.length ? ' Останали неизпълнени: ' + still.length + '.' : ''));
    pendingSchema = still;
  }

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
/* Одит v2.4.14: константата беше останала на 6, докато най-високата миграция вече
   е 8 — тоест последният ред на runMigrations() (изравняването за база, стигнала
   дотук без нито една регистрирана миграция) беше недостижим, а коментарът
   по-горе вече не описваше кода. Държи се изрично равна на последната миграция. */
const CURRENT_SCHEMA_VERSION = 13;
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
  } },
  /* v8 (v2.4.14) — три находки от одита на схемата, всичките измерени:

     1) inventory_session_scans нямаше НИКАКЪВ индекс освен първичния ключ.
        Допълването на datelastseen по-долу в initDb() прави корелирана подзаявка
        по book_id за ВСЯКА книга: измерено при 15 000 книги и 12 000 сканирания —
        6607 ms при първото стартиране след обновяване и 912 ms при ВСЯКО
        следващо (книгите, които никога не са били сканирани, остават с
        datelastseen IS NULL завинаги и плащат пълното сканиране пак и пак).
        Със същия индекс: 31 ms и ~0 ms. Същият прецедент като idx_books_acquisition
        във версия 7.

     2) Нямаше UNIQUE(session_id, book_id): дедупликацията беше само проверка в
        JavaScript, при това извън транзакция, докато по документиран сценарий две
        работни места работят срещу обща мрежова база — двете минават проверката
        едновременно и базата приема дубликата. Един и същ физически документ се
        брои два пъти в протокола пред регионалната библиотека и в изпълнението на
        нормата по чл. 40. Съществуващите дубликати се изчистват ПРЕДИ индекса
        (иначе създаването му гърми и спира стартирането): пази се най-ранното
        сканиране — то е това, което протоколът реално документира.

     3) Индексите по чужди ключове, които се четат често: deaccession_items(act_id)
        (по две корелирани подзаявки на акт в КДБФ и в списъка с актове),
        inventory_checks(book_id) и periodical_issues(periodical_id). */
  { version: 8, run: () => {
    const dup = db.prepare(`
      DELETE FROM inventory_session_scans WHERE id NOT IN (
        SELECT MIN(id) FROM inventory_session_scans GROUP BY session_id, book_id
      )`).run().changes;
    if (dup) console.log(`Премахнати ${dup} дублирани сканирания при инвентаризация.`);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_iss_session_book ON inventory_session_scans(session_id, book_id);
      CREATE INDEX IF NOT EXISTS idx_iss_book ON inventory_session_scans(book_id);
      CREATE INDEX IF NOT EXISTS idx_deacc_items_act ON deaccession_items(act_id);
      CREATE INDEX IF NOT EXISTS idx_inv_checks_book ON inventory_checks(book_id);
      CREATE INDEX IF NOT EXISTS idx_periodical_issues_pid ON periodical_issues(periodical_id);
    `);
  } },
  /* v9 (v2.4.14) — тригерите за enum колоните се прилагат ОТНОВО.

     applyEnumTriggers() се извикваше само от миграция 5, а всяка вече издадена
     инсталация е на user_version >= 7 — тоест трите нови пазача от v2.4.14
     (account_lines.type, inventory_sessions.mode, authorised_values.category)
     стигаха САМО до чисто нови инсталации. Точно за account_lines.type
     съществува поправката: handlers/stats.js сравнява буквално с 'обезщетение',
     и начисление с друг етикет се показва под чуждо име в едната справка и
     изчезва от другата. Функцията ползва CREATE TRIGGER IF NOT EXISTS, тоест
     повторното прилагане е безвредно и за вече покритите колони. */
  { version: 9, run: () => { applyEnumTriggers(db); } },
  /* v10 (v2.4.17) — протоколът по чл. 40 става истински документ: номер, година,
     заповед за комисията, и числата КЪМ ПРИКЛЮЧВАНЕТО (пул и заети), защото
     pool_size е снимка от започването и разминаването правеше протокола
     аритметично невъзможен. Старите сесии остават с NULL — за тях протоколът
     пада обратно към pool_size и не твърди нищо, което не знае. */
  { version: 10, run: () => {
    ensureColumns('inventory_sessions', {
      no: 'INTEGER', year: 'TEXT', order_no: 'TEXT', pool_final: 'INTEGER', on_loan: 'INTEGER'
    });
  } },
  /* v11 (v2.4.17) — актът за дарение и протоколът по чл. 3, ал. 2 спират да лъжат
     за две неща:
     1) КОМИСИЯТА. Дотук се печатаха живите имена от Настройки, а
        handlers/deaccession-acts.js ги презаписва при всеки утвърден акт за
        отчисляване. Тоест актът за дарение от януари, препечатан през април,
        назоваваше комисията от последното отчисляване. Сега партидата пази
        собствена снимка; старите партиди остават с NULL и се печатат с празни
        редове за подпис вместо с нечии чужди имена.
     2) ОБЯВЕНАТА СТОЙНОСТ. `sum` беше `REAL DEFAULT 0` и празното поле влизаше
        като 0, което изгледът четеше с `a.sum || acqValue(...)` — тоест мълчаливо
        печаташе ИЗЧИСЛЕНИЯ сбор на реда „Обща стойност по документа“. Нулата се
        превръща в NULL („не е обявена“): за съществуващите редове това е точно
        каквото са означавали (изрична нула беше невъзможна за въвеждане, защото
        `a.sum ? parseFloat(a.sum) : 0` я сплескваше до същата нула), затова нито
        едно отпечатано число не се променя — само вече се знае кое е обявено и
        кое изчислено. */
  { version: 11, run: () => {
    ensureColumns('acquisitions', { committee1: 'TEXT', committee2: 'TEXT', committee3: 'TEXT' });
    db.prepare('UPDATE acquisitions SET sum = NULL WHERE sum = 0').run();
  } },
  /* v12 (v2.4.24) — протоколът по чл. 40 трябва да се СЪБИРА. Документ „за
     реставрация“ е при подвързвача и по определение не може да бъде сканиран на
     място; дотук той влизаше в липсите наравно с изчезналите и състоянието му се
     презаписваше на „липсващ“. Сега се извинява като заетите — а за да не остане
     необяснима разлика между „в обхвата“ и сбора на редовете, броят му се снима
     до pool_final/on_loan и се отпечатва в протокола. Старите сесии остават с
     NULL и протоколът не твърди нищо за тях. */
  { version: 12, run: () => {
    ensureColumns('inventory_sessions', { at_binder: 'INTEGER' });
    /* Изчистените числови настройки, записани като ПРАЗЕН НИЗ преди v2.4.24
       (handlers/settings.js вече ги нормализира при запис). SQLite пази '' като
       текст, а `x == null ? подразбиращо : x` го подминава — remind2_days = ''
       правеше всяко напомняне ниво 3, extensions_count = '' махаше лимита от
       продължения. Празно поле значи „по подразбиране“, тоест NULL. */
    for (const col of ['loan_days', 'max_books', 'extensions_count', 'extension_days',
      'fine_per_day', 'annual_fee', 'free_access_pct', 'next_inv_number',
      'suspend_per_day', 'suspend_max', 'remind2_days', 'remind3_days', 'anonymize_years']) {
      db.prepare(`UPDATE settings SET ${col} = NULL WHERE typeof(${col}) = 'text' AND trim(${col}) = ''`).run();
    }
  } },
  /* v13 (одит v2.4.26, преглед на поправките от v2.4.25) — същото изчистване като
     v12, но за circulation_rules (правилата по категория), не за settings
     (общите стойности). circRules:save преди v2.4.25 приемаше срока за заемане и
     дните за продължение без никаква проверка на границата — заварен ред с 0 или
     отрицателно число показваше грешен срок на гишето, докато handlers/loans.js
     мълчаливо прилагаше 30 дни (`s.loan_days || 30`). NULL значи „общата
     стойност“ навсякъде другаде в тази таблица — редовете тук се привеждат към
     същия смисъл, вместо да останат заклещени с невъзможна за прилагане цифра. */
  { version: 13, run: () => {
    db.prepare("UPDATE circulation_rules SET loan_days = NULL WHERE loan_days IS NOT NULL AND loan_days <= 0").run();
    db.prepare("UPDATE circulation_rules SET extension_days = NULL WHERE extension_days IS NOT NULL AND extension_days <= 0").run();
  } }
];
/* Пазач НАПРЕД по версия на схемата (одит v2.4.18, преглед на поправките от
   v2.4.17). Дотук по-стара версия отваряше без възражение база, мигрирана от
   по-нова: филтърът в runMigrations() просто не намираше нищо за прилагане. Това
   не е теоретично — режимът с две работни места към обща мрежова база е изрично
   поддържан, а те се обновяват едно по едно, тоест разминаването е НОРМАЛНОТО
   състояние в деня на обновяването. Пример от самата версия 2.4.17: миграция 11
   обръща смисъла на `acquisitions.sum = 0` от „празно поле“ на „обявена нула“.
   Станция на 2.4.16 срещу вече мигрирана база продължава да пише 0 за непопълнено
   поле, а обновената станция после печата „Обща стойност по документа: 0.00 лв.“
   като ОБЯВЕНА нула върху подписан счетоводен документ.

   ЗАЩО НА ДВЕ МЕСТА (одит v2.4.20, преглед на поправката от v2.4.19): първият
   вариант на този пазач (v2.4.18) стоеше само в runMigrations() — тоест СЛЕД
   `journal_mode`, след schema.sql, след всички ensureColumns() и след старите
   backfill-и в initDb(). Измерено с истинския main.js срещу здрава база с
   user_version = 99: файлът сменяше контролната си сума, `readers
   .gdpr_consent_date` се пренаписваше от NULL на дата от стария backfill, базата
   се преобразуваше в WAL и оставаше с -wal/-shm файлове до нея — а диалогът
   твърдеше „не ѝ е направено нищо“. v2.4.19 премести проверката като ПЪРВОТО
   нещо след отварянето (`PRAGMA user_version` само чете) — но САМО я премести,
   и това отвори обратния процеп: в деня на обновяването другото, вече обновено
   работно място може да мигрира общата база в секундите, В КОИТО този initDb()
   тече (проверката при отварянето вече е минала). Възпроизведено детерминирано
   (test/helpers/newer-schema-worker.js, режим 'race'): версията скача на 99 по
   средата на initDb() и програмата отваряше ПЪЛНА работна сесия срещу по-новата
   база — точно каквото пазачът съществува да спре. Затова проверката се повтаря
   в началото на runMigrations(), под същия err.code; `late` отличава втория
   случай, защото диалогът има право на твърдението „нищо не е записано“ само за
   първия.

   Функцията е `function` (hoisted), затова initDb() може да я вика, макар да е
   определена по-долу; CURRENT_SCHEMA_VERSION е инициализирана много преди първото
   извикване (initDb() тръгва чак в app.whenReady()). */
function assertSchemaNotNewer(late) {
  const v = db.pragma('user_version', { simple: true });
  /* Връща прочетената версия: runMigrations() я ползва за `from`, вместо да чете
     втори път. Две четения = процеп, в който скок на версията между тях минава
     пазача и дава празен списък миграции (одит v2.4.21, възпроизведено с кука). */
  if (v <= CURRENT_SCHEMA_VERSION) return v;
  /* Дръжката се затваря веднага: файлът е на споделена папка и няма причина да
     стои заключен от нас, докато библиотекарят чете съобщението. */
  try { db.close(); } catch (e) { /* при отказ няма какво да поправяме */ }
  const err = new Error('Базата данни е с версия на схемата ' + v + ', а тази инсталация на InvLib '
    + 'познава до версия ' + CURRENT_SCHEMA_VERSION + '. Базата е обновена от по-нова версия на програмата.');
  err.code = 'DB_NEWER_SCHEMA';
  err.late = !!late;
  /* Диалогът разграничава двата случая: при обща (мрежова) папка изходът минава
     през реда dbFolder в config.json; при чисто локална база такъв ред НЯМА и
     съветът да бъде изтрит би бил невярна инструкция (одит v2.4.20 — дотук се
     печаташе безусловно, включително „базата е обща (мрежова папка)“ за база,
     която не е). */
  err.isNetwork = dbIsNetwork();
  err.configPath = configPath();
  err.dbPath = path.join(resolveDbDir(), 'library.db');
  throw err;
}
function runMigrations() {
  // Повторение на пазача под прозореца на initDb() — виж дългата бележка горе.
  const from = assertSchemaNotNewer(true);
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
    /* width/height остават РАЗМЕРЪТ ПРИ ВЪЗСТАНОВЯВАНЕ: прозорецът се отваря
       максимизиран (виж maximize() по-долу), но „Възстанови надолу“ трябва да
       даде използваем прозорец, а не да се свие до минимума. */
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    resizable: true,
    /* Прозорецът се създава СКРИТ и се показва чак когато съдържанието е
       готово за рисуване. Иначе библиотекарят вижда за миг прозорец 1280×800,
       който след това подскача до цял екран. Показването става на
       'ready-to-show' по-долу. */
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    title: 'InvLib · Библиотечна система',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  /* Отваря се на цял екран (МАКСИМИЗИРАН, не kiosk/fullscreen): лентата на
     задачите и заглавната лента остават достъпни, а прозорецът може да се
     възстанови и премести както обикновено.

     И максимизирането, и показването стават чак на 'ready-to-show'. Причината
     maximize() да НЕ е по-рано: по документацията на Electron „maximize() ще
     покаже прозореца, ако той още не се показва“ — тоест извикан веднага след
     създаването, той сам би отменил show:false и библиотекарят би видял празен
     бял прозорец, докато съдържанието се зарежда. Затова редът е:
     скрит → съдържанието е готово → максимизирай → покажи.

     Ако 'ready-to-show' по някаква причина не дойде (счупен рендер), прозорецът
     щеше да остане скрит завинаги и програмата би изглеждала като незастартирала
     — затова има и предпазен таймер, който прави същото независимо от всичко. */
  let shown = false;
  const showOnce = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.maximize();
    win.show();
  };
  win.once('ready-to-show', showOnce);
  setTimeout(showOnce, 5000).unref?.();
  win.setMenuBarVisibility(false);
  /* Скритото меню НЕ маха ускорителите му (одит v2.4.27): Ctrl+R / Ctrl+Shift+R
     презареждаха renderer-а и изтриваха отворената форма или сесията за
     инвентаризация без дума, Ctrl+Shift+I отваряше DevTools с пълен достъп до
     window.api, F11 — цял екран. Menu.setApplicationMenu(null) ги премахва;
     Ctrl+C/V/X в полетата продължават да работят от системата. */
  if (Menu && typeof Menu.setApplicationMenu === 'function' && typeof Menu.buildFromTemplate === 'function') {
    // Мащабът (Ctrl+= / Ctrl+- / Ctrl+0) остава — библиотекар с по-слабо зрение го
    // ползва; менюто е скрито (setMenuBarVisibility), ускорителите работят.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Изглед', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] }
    ]));
  }
  // Сигурност (Фаза 3): приложението никога легитимно не отваря нов прозорец
  // и не навигира извън заредения src/index.html (вътрешното "рутиране" по
  // изгледи е само смяна на location.hash, което не задейства тези събития —
  // виж app.js). Всеки опит — независимо дали от неочакван код, компрометиран
  // renderer или инжектирано съдържание — се отказва тук. Ако все пак дойде
  // легитимен адрес за отваряне (напр. бъдещ линк с target="_blank"), той се
  // праща към системния браузър вместо в самия прозорец на приложението.
  win.webContents.setWindowOpenHandler(({ url }) => {
    /* Отварянето в нов прозорец се отказва винаги. Пропускането към браузъра е
       СПРЯНО (одит v2.4.14): в програмата няма нито една връзка с target="_blank"
       — проверено с търсене — тоест този клон не обслужваше нищо, а оставяше
       изходен канал: всяка бъдеща дупка в екранния слой можеше да извика
       window.open('https://…?d=' + данни) и главният процес щеше послушно да го
       отвори в браузъра. Единственото външно отваряне, което програмата прави, е
       mailto: в handlers/notices.js, където адресът минава през проверка.
       Ако някога потрябва истинска външна връзка, тя се добавя тук с изричен
       списък на разрешените адреси, а не с общо правило за http(s). */
    if (url) console.warn('Отказано отваряне на външен адрес от екранния слой:', url);
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
    /* Между createWindow() и 'ready-to-show' прозорецът е СКРИТ, а не минимизиран
       (v2.4.15 въведе show:false). focus() не показва скрит прозорец — тоест в
       този промеждутък второто щракване по иконата не правеше нищо и
       библиотекарят щракаше пак, защото „нищо не се случва“. */
    if (!mainWindow.isDestroyed()) mainWindow.show();
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
  /* Изтичането на резервации е удобство, не условие за старт (одит v2.4.27):
     по мрежов дял SQLITE_BUSY оттук падаше в общия .catch и показваше „Базата
     данни не можа да бъде отворена“ при напълно здрава база. */
  try { expireStaleHolds(); } catch (e) { console.error('Изтекли резервации при старт:', e.message); }
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
  /* Прекласифициране (одит v2.4.21). Между двата пазача старият код изпълнява СВОЯ
     DDL и своите еднократни попълвания срещу схема, която не познава. Ако която и да
     е от тези стъпки гръмне (бъдеща миграция с преименувана колона стига), грешката
     няма code DB_NEWER_SCHEMA и падаше в общия диалог — „преименувайте library.db
     … възстановете копието“ — върху здрава, по-нова база: точно съветът, срещу
     който пазачът съществува. Затова тук се отваря втора връзка САМО за четене и се
     пита версията; ако е по-висока от познатата, това е по-нова база, каквато и да е
     била конкретната грешка. */
  if (!(err && err.code === 'DB_NEWER_SCHEMA')) {
    try {
      const p = path.join(resolveDbDir(), 'library.db');
      if (fs.existsSync(p)) {
        const ro = new Database(p, { readonly: true });
        let v;
        try { v = ro.pragma('user_version', { simple: true }); } finally { try { ro.close(); } catch (e) { /* няма значение */ } }
        if (Number.isFinite(v) && v > CURRENT_SCHEMA_VERSION) {
          // Както прави самият пазач: файлът на споделената папка не стои заключен от нас.
          try { if (db) db.close(); } catch (e) { /* няма какво да поправяме */ }
          const e2 = new Error('Базата данни е с версия на схемата ' + v + ', а тази инсталация на InvLib познава до версия '
            + CURRENT_SCHEMA_VERSION + '. Базата е обновена от по-нова версия на програмата. (Спряно при: ' + detail + ')');
          e2.code = 'DB_NEWER_SCHEMA'; e2.late = true; e2.isNetwork = dbIsNetwork(); e2.configPath = configPath(); e2.dbPath = p;
          err = e2;
        }
      }
    } catch (e) { /* не можем да прекласифицираме — остава общият диалог */ }
  }
  try {
    /* Съветът дотук беше „копирайте последното копие върху library.db“ и той е
       ОПАСЕН по два начина. Първо, при включена защита на личните данни най-новото
       копие е .invbak — криптирано; копирано върху library.db то дава файл, който
       програмата не може да отвори, а оригиналът вече е презаписан. Второ, „базата
       е заключена от друга станция“ стига до същия този диалог и не е повреда
       изобщо — възстановяване там означава да се загуби работата на другия компютър.
       Затова: първо се пази копие на текущия файл, възстановяването минава през
       самата програма, а заключването се назовава отделно. */
    /* Базата е ЗДРАВА, просто по-нова от тази инсталация (виж assertSchemaNotNewer).
       Отделен диалог, защото съветите по-долу — „преименувайте library.db“ и
       „възстановете резервно копие“ — тук биха унищожили работата, въведена с
       по-новата версия. Диалогът внимава с две разлики (одит v2.4.20):
         • err.late — базата е станала по-нова ПО ВРЕМЕ на стартирането (другото,
           вече обновено работно място я е мигрирало в същите секунди). Тогава
           твърдението „не е записала нищо“ не ни се полага: сервизната част на
           стартирането вече е минала. Казва се само каквото е вярно.
         • err.isNetwork — изходът през реда dbFolder в config.json съществува само
           когато такъв ред ИМА. За чисто локална база (пуснат по-стар инсталатор
           върху вече мигрирани данни) съветът да бъде изтрит несъществуващ ред е
           невярна инструкция и се пропуска. */
    if (err && err.code === 'DB_NEWER_SCHEMA') {
      dialog.showErrorBox('InvLib на този компютър е по-стар от базата данни',
        (err.message || detail) + '\n\nФайл: ' + (err.dbPath || '') + '\n\n'
        /* Одит v2.4.21: при късния отказ сервизната част на стартирането ВЕЧЕ е
           записала — журнал, липсващи колони, еднократни попълвания (измерено:
           readers.gdpr_consent_date от NULL на дата, authorised_values, WAL). Това
           са данни на библиотеката, пренаписани по стария начин, и „не е записала
           ваши данни“ беше невярно. Казва се точно какво е станало и защо базата
           все пак не бива да се пипа. */
        + (err.late
          ? 'Друго работно място обнови базата, докато тази програма стартираше. Програмата спря, преди да '
            + 'отвори работна сесия — нищо от вашата работа не е въведено. Сервизната част на стартирането обаче '
            + 'вече беше минала (журнал, липсващи колони, еднократни попълвания по стария начин), затова обновете '
            + 'ТОЗИ компютър, преди отново да работите с базата.'
          : 'Базата НЕ е повредена и програмата не е записала нищо в нея — спря веднага '
            + 'след като я отвори, за да не запише данни по стария си начин.')
        + '\n\nКакво да направите:\n'
        + '• Обновете InvLib на ТОЗИ компютър до версията, която ползват останалите работни места '
        + '(„Настройки“ → „Обновяване“ → „Провери сега“ на обновен компютър показва коя е тя).\n'
        + '• НЕ възстановявайте резервно копие и НЕ преименувайте library.db — това би изтрило '
        + 'работата, въведена с по-новата версия.'
        + (err.isNetwork
          /* Прозорецът изобщо не се отваря, тоест „Настройки“ → „Работа в мрежа“ е
             недостижимо: работно място, насочено към споделената папка, няма как да
             се върне към локална база през самата програма. Затова пътят се назовава
             тук — с точния файл, вместо да остане да се търси. */
          ? '\n\nАко обновяването не е възможно веднага, а компютърът трябва да работи: базата е обща '
            + '(мрежова папка), а „Настройки“ не могат да се отворят, докато програмата не тръгне. '
            + 'Върнете я към локалната, като изтриете реда „dbFolder“ от файла:\n' + (err.configPath || '')
            + '\nВниманието е важно: така този компютър работи със СОБСТВЕНА база и въведеното в нея '
            + 'няма да попадне в общата.'
          : ''));
      app.exit(1);
      return;
    }
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
  // Само ако наистина има насрочен (debounced) запис (одит v2.4.27) — иначе всяко
  // затваряне пренаписваше многомегабайтния каталог в (мрежовата) папка и
  // произвеждаше git commit без промяна във фонда.
  if (catalogWriteDebouncer.pending()) flushCatalogWrite();
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
require('./handlers/employees')(ipcMain, {
  getDb: () => db, run, logAudit,
  syncCurrentUser: (name) => {
    if (name === undefined) return CURRENT_USER;
    CURRENT_USER = (name || '').trim();
    updateConfig((cfg) => { cfg.lastUserName = CURRENT_USER; });
    // Значката в прозореца се обновява при следващото ѝ прочитане; тук се праща и
    // изрично, ако прозорецът е жив.
    try { const w = BrowserWindow.getAllWindows()[0]; if (w && !w.isDestroyed()) w.webContents.send('app:userChanged', CURRENT_USER); } catch (e) { /* без прозорец */ }
    return CURRENT_USER;
  }
});
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
require('./handlers/categories')(ipcMain, { getDb: () => db, run, logAudit });

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
require('./handlers/visits')(ipcMain, { getDb: () => db, run, logAudit });

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
  /* v2.4.31 (производителност): BOOK_SELECT тегли `b.*` (38 колони, 20 МБ при
     15 000 книги) и брои отворените заемания с корелирана подзаявка на ред;
     каталогът ползва 18 полета (publicBookFields) и „налична“ — един агрегат по
     idx_loans_open върши същото. Измерено: 547 ms → ~150 ms на запис на каталога,
     който се пуска след всяка промяна във фонда и на всеки 5 минути. */
  const books = db.prepare(`
    SELECT b.inv_number, b.author, b.title, b.subtitle, b.city, b.publisher, b.year, b.language,
           b.udk, b.call_number, b.department, b.keywords, b.annotation, b.cover_url, b.status, b.register_date,
           c.name AS category_name,
           COALESCE(i.quantity, 0) - COALESCE(o.n, 0) AS available
    FROM books b
    LEFT JOIN categories c ON c.id = b.category_id
    LEFT JOIN inventory i ON i.book_id = b.id
    LEFT JOIN (SELECT book_id, COUNT(*) AS n FROM loans WHERE date_in IS NULL GROUP BY book_id) o ON o.book_id = b.id
    WHERE b.status != 'отчислен' AND COALESCE(b.department,'') != 'служебен' ORDER BY b.title`).all();
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
    /* Записва се настрани и се преименува (одит v2.4.24) — точно както writeConfig
       по-горе, и по същата причина, само че тук залогът е по-голям: файлът е
       няколко мегабайта при 15 000 заглавия и по проект стои в git/мрежова папка.
       Обикновеният запис първо ИЗПРАЗВА файла; прекъсване насред него (спиране на
       тока, паднал мрежов диск) оставяше пресечен JSON, а публичният каталог на
       сайта тъмнееше до следващата успешна редакция на книга, без нищо на екрана
       да го каже. Преименуването на едно и също устройство е атомарно. */
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
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
