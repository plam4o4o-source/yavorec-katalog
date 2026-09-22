'use strict';
/* v2.4.64 — „ИЗТРИВАНЕ НА ВСИЧКИ ДАННИ“ (започване на чисто).
   =====================================================================
   Дотук чиста база се получаваше само ръчно: затвори програмата, намери
   папката, преименувай library.db. Това е действие, което библиотекарят прави
   веднъж грешно и губи годината си работа — затова влиза в програмата с
   дума за потвърждение, задължително резервно копие и записана следа.

   Какво заковава този файл:
     1) отказ без думата за потвърждение — и то в ОБРАБОТЧИКА, не само на
        екрана: екранът е един от входовете към канала, а не пазачът му;
     2) отказ при ПРОВАЛЕНО резервно копие, с доказателство, че в този случай
        не е изтрит нито един ред (истински провал на записа, не подменена
        функция: папката с копията е заета от файл);
     3) пълно изтриване върху реалистична фикстура (/tmp/r41/fixture.js) —
        всяка таблица с данни е празна, а всяко от решенията „това остава“ е
        проверено поименно, вместо да се разчита, че никой няма да го изтрие;
     4) броячът на инвентарните номера е върнат на 1 и id-тата пак тръгват
        от 1 — иначе първата книга на новата библиотека получава № 15 001;
     5) одитната следа е ПЪРВИЯТ ред на новата, празна следа и носи ПЪЛНИЯ
        път на резервното копие — „копието е направено“ без „къде“ не помага
        на човек, който след час осъзнава, че е изтрил не каквото е искал;
     6) резервното копие отпреди изтриването НАИСТИНА съдържа старите данни —
        отваря се и се брои, а не се вярва на съществуването на файла;
     7) списъците „изтрива се“ и „остава“ ПОКРИВАТ схемата: таблица, добавена
        утре, не може да се промъкне между тях без решение (формата на
        проверката е като в perf-v2431/perf-v2448 — заковава се правилото, не
        конкретното число);
     8) каналите са регистрирани от ИСТИНСКИЯ main.js и отказът без дума важи
        и през него.
   Всеки тест е проверен и с връщане на поправката. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { APP_DIR, mkTmpDir, cleanupTmpDirs, fakeIpcMain, runDep } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

const registerReset = require(path.join(APP_DIR, 'handlers', 'reset'));
const { CONFIRM_WORD, WIPE, KEEP } = registerReset;
const pii = require(path.join(APP_DIR, 'pii-crypto'));
const { isEncryptedBackup, decryptBackupBuffer } = require(path.join(APP_DIR, 'backup-crypto'));

/* Фикстурата на измерването за този кръг. 15 000 книги не са нужни, за да се
   докаже изтриване — но ВСЯКА таблица трябва да има редове, иначе „празна е“
   не доказва нищо. Затова пълната фикстура с намален брой книги: така
   заеманията, периодиката, краезнанието, дневникът, следата и проверките си
   остават със стотици и хиляди редове. */
/* ФИКСТУРАТА Е В ХРАНИЛИЩЕТО, не в /tmp. Първата версия на този файл я четеше
   от „/tmp/r41/fixture.js“ — работен файл на машината, на която беше писан — и
   при липса я прескачаше мълчаливо (`fs.existsSync ? require : null`). На всяка
   друга машина, включително в CI, засяването не се случваше и СЕДЕМ от
   тринайсетте теста тук падаха. Тоест единственото необратимо действие в
   програмата се оказваше без действаща проверка навсякъде освен там.
   Сега пътят е задължителен: липсващ файл гърми при зареждане, вместо да
   превърне поредицата в тиха измама. */
const seedFixture = require('./helpers/nachisto-fixture').seed;

/* Базата се прави като истинската: schema.sql + FTS5 индексите + тригерите за
   изброимите колони + колоните, които миграциите добавят (pdp_salt/
   pdp_verifier от миграция 2, holidays_seeded от миграция 6). Без последните
   „ключът за личните данни остава“ нямаше какво да провери. */
function freshLibrary(prefix) {
  const dir = mkTmpDir(prefix);
  const dbPath = path.join(dir, 'library.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  const ftsSql = require(path.join(APP_DIR, 'search-fts'));
  db.exec(ftsSql.BOOKS_FTS_SETUP_SQL);
  db.exec(ftsSql.READERS_FTS_SETUP_SQL);
  require(path.join(APP_DIR, 'db', 'enum-triggers')).applyEnumTriggers(db);
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN holidays_seeded TEXT');
  return { dir, dbPath, db };
}

/* Самоличността и настройките на библиотеката, служителите и календарът —
   тоест всичко, което трябва да ПРЕЖИВЕЕ изтриването. */
function seedLibraryIdentity(db) {
  /* next_inv_number НЕ се пипа тук: фикстурата го вдига до броя книги и точно
     това изтриването трябва да върне на 1. */
  db.prepare(`UPDATE settings SET org = ?, lib_name = ?, place = ?, bulstat = ?, director = ?,
      librarian = ?, work_days = ?, loan_days = ?, max_books = ?, catalog_folder = ?, gh_user = ?,
      gh_repo = ?, theme = ?, pdp_salt = ?, pdp_verifier = ?
    WHERE id = 1`)
    .run('НЧ „Пробен“ – 1901', 'Библиотека при НЧ „Пробен“', 'с. Пробно', '000111222',
      'Иванка Петрова', 'Мария Георгиева', '1,2,3,4,5', 21, 7,
      '/home/biblioteka/katalog-repo', 'proben', 'proben-katalog', '3',
      'сол-за-лични-данни', 'проверител-за-лични-данни');
  const emp = db.prepare('INSERT INTO employees (name, active) VALUES (?, ?)');
  emp.run('Мария Георгиева', 1);
  emp.run('Иванка Петрова', 1);
  const am = db.prepare('INSERT OR REPLACE INTO author_table (prefix, mark) VALUES (?, ?)');
  am.run('ВАЗ', '14');
  am.run('ЙОВ', '75');
  db.prepare('INSERT OR REPLACE INTO circulation_rules (category, loan_days, max_books) VALUES (?, ?, ?)')
    .run('дете до 14 г.', 14, 3);
  db.prepare('INSERT OR REPLACE INTO calendar_closed (date, reason) VALUES (?, ?)')
    .run('2026-05-24', 'Ден на светите братя Кирил и Методий');
  db.prepare('INSERT OR IGNORE INTO authorised_values (category, value, opac_label) VALUES (?, ?, ?)')
    .run('department', 'за възрастни', 'Отдел за възрастни');
  db.prepare('UPDATE settings SET holidays_seeded = ? WHERE id = 1').run('2026,2027');
}

function setup(opts) {
  const o = opts || {};
  const { dir, dbPath, db } = freshLibrary(o.prefix || 'inv-nachisto-');
  /* Редът е важен: фикстурата пише и в settings (име на библиотеката, брояча на
     инвентарните номера), затова самоличността на библиотеката се задава СЛЕД
     нея — иначе тестът за „настройките остават“ би сравнявал с чужди стойности.
     Броячът нарочно остава вдигнат от фикстурата: изтриването трябва да го
     върне на 1 и това се проверява. */
  if (o.seed !== false) seedFixture(db, { books: o.books || 600, today: '2026-09-21' });
  seedLibraryIdentity(db);
  const audit = [];
  const relaunch = [];
  const exits = [];
  const ipcMain = fakeIpcMain();
  registerReset(ipcMain, {
    app: {
      getPath: () => os.tmpdir(),
      relaunch: () => relaunch.push(true),
      exit: (code) => exits.push(code)
    },
    fs, path,
    getDb: () => db,
    run: runDep,
    /* Същото, което прави logAudit в main.js — включително колоната `user`. */
    logAudit: (action, detail) => {
      audit.push({ action, detail });
      db.prepare('INSERT INTO audit_log (user, action, detail, diff) VALUES (?, ?, ?, ?)')
        .run('Мария Георгиева', action, detail || '', null);
    },
    resolveDbDir: () => dir,
    resolveDbPath: () => dbPath,
    /* Истинската проверка на прясно записано копие от handlers/backup.js —
       зареждаме модула така, както го зарежда main.js, само за нея. */
    checkDbFile: backupCheckDbFile(),
    getCurrentUser: () => 'Мария Георгиева'
  });
  return { dir, dbPath, db, ipcMain, audit, relaunch, exits };
}

/* handlers/backup.js се регистрира с минимални зависимости само за да бъде
   взета sqliteProblem() (изнесена като checkDbFile) — точно както main.js ѝ я
   подава на handlers/reset.js. Проверката „кое е здраво копие“ трябва да е
   същата и в теста, не негово второ копие. */
function backupCheckDbFile() {
  const reg = require(path.join(APP_DIR, 'handlers', 'backup'));
  const ret = reg(fakeIpcMain(), {
    app: { getPath: () => os.tmpdir() },
    dialog: {}, fs, path,
    getDb: () => null, setDb: () => {}, getMainWindow: () => null,
    run: runDep, logAudit: () => {},
    resolveDbDir: () => os.tmpdir(), resolveDbPath: () => path.join(os.tmpdir(), 'нямa.db')
  });
  assert.equal(typeof ret.checkDbFile, 'function',
    'handlers/backup.js трябва да изнася checkDbFile — през нея минава проверката на копието');
  return ret.checkDbFile;
}

const DATA_TABLES = WIPE.map(([t]) => t);
const KEPT_TABLES = KEEP.map(([t]) => t);
const countOf = (db, t) => db.prepare('SELECT COUNT(*) AS n FROM "' + t + '"').get().n;

/* ------------------------------------------------------------------ 1 ---- */
test('без думата за потвърждение обработчикът отказва и не трие нищо', () => {
  const { db, ipcMain, relaunch } = setup({ prefix: 'inv-nachisto-duma-' });
  const before = countOf(db, 'books');
  assert.ok(before > 0, 'фикстурата трябва да е засяла книги');

  for (const bad of [undefined, {}, { word: '' }, { word: 'да' }, { word: 'ДА' },
    { word: 'изтрии' }, { word: 'DELETE' }, { word: 'ИЗТРИЙТЕ' }, { word: true }]) {
    const res = ipcMain.invoke('reset:wipe', bad);
    assert.equal(res.ok, false, 'прието е потвърждение ' + JSON.stringify(bad));
    assert.match(res.error, /ИЗТРИЙ/, 'отказът трябва да каже коя е думата');
    assert.match(res.error, /Нищо не е изтрито/);
  }
  assert.equal(countOf(db, 'books'), before, 'отказан опит не бива да е изтрил нито един ред');
  assert.equal(relaunch.length, 0, 'отказан опит не бива да рестартира програмата');

  // Самата дума минава, с интервали и с малки букви — човек пише в поле, не в код.
  for (const ok of ['ИЗТРИЙ', ' ИЗТРИЙ ', 'изтрий']) {
    const fresh = setup({ prefix: 'inv-nachisto-duma-ok-', seed: false });
    const res = fresh.ipcMain.invoke('reset:wipe', { word: ok });
    assert.equal(res.ok, true, 'думата „' + ok + '“ трябва да мине: ' + res.error);
  }
});

/* ------------------------------------------------------------------ 2 ---- */
test('провалено резервно копие спира изтриването — нито един ред не пада', () => {
  const { dir, db, ipcMain, relaunch, exits } = setup({ prefix: 'inv-nachisto-bezkopie-' });
  /* Истински провал на записа, не подменена функция: на мястото на папката
     „backups“ стои ФАЙЛ, тоест mkdirSync() гърми — същото, което се случва при
     недостъпен мрежов дял или папка, заключена от антивирусна програма. */
  fs.writeFileSync(path.join(dir, 'backups'), 'това не е папка');

  const before = {};
  for (const t of DATA_TABLES) before[t] = countOf(db, t);
  assert.ok(before.books > 0 && before.loans > 0 && before.readers > 0);

  const res = ipcMain.invoke('reset:wipe', { word: CONFIRM_WORD });
  assert.equal(res.ok, false, 'при провалено копие изтриването трябва да бъде отказано');
  assert.match(res.error, /НЕ можа да бъде направено/);
  assert.match(res.error, /НИЩО не е\s+изтрито|НИЩО не е изтрито/);

  for (const t of DATA_TABLES) {
    assert.equal(countOf(db, t), before[t], 'таблица „' + t + '“ е пипната въпреки провала на копието');
  }
  assert.equal(relaunch.length, 0, 'без изтриване няма рестарт');
  assert.equal(exits.length, 0);
});

/* ------------------------------------------------------------------ 3 ---- */
test('пълно изтриване: всяка таблица с данни е празна, а решенията „остава“ са спазени', () => {
  const { db, dbPath, ipcMain, relaunch, exits } = setup({ prefix: 'inv-nachisto-pylno-' });
  const before = {};
  for (const t of DATA_TABLES) before[t] = countOf(db, t);
  const keptBefore = {};
  for (const t of KEPT_TABLES) keptBefore[t] = countOf(db, t);
  const settingsBefore = db.prepare('SELECT * FROM settings WHERE id = 1').get();

  const res = ipcMain.invoke('reset:wipe', { word: CONFIRM_WORD });
  assert.equal(res.ok, true, res.error);

  /* Всичко, което описва фонда и хората — празно. Одитната следа е
     изключението: тя е изтрита и ВЕДНАГА след това носи новия си пръв ред (виж
     отделния тест по-долу). */
  for (const t of DATA_TABLES) {
    if (t === 'audit_log') continue;
    assert.equal(countOf(db, t), 0, 'таблица „' + t + '“ не е изпразнена (имаше ' + before[t] + ' реда)');
  }
  assert.equal(countOf(db, 'audit_log'), 1, 'следата трябва да е само новият пръв ред');

  /* Всичко, което описва инсталацията — непокътнато, поименно. */
  for (const t of KEPT_TABLES) {
    assert.equal(countOf(db, t), keptBefore[t], 'таблица „' + t + '“ НЕ биваше да се пипа');
    assert.ok(keptBefore[t] > 0, 'тестът трябва да е засял редове в „' + t + '“, иначе не доказва нищо');
  }
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  for (const f of ['org', 'lib_name', 'place', 'bulstat', 'director', 'librarian', 'work_days',
    'loan_days', 'max_books', 'catalog_folder', 'gh_user', 'gh_repo', 'theme',
    'pdp_salt', 'pdp_verifier', 'holidays_seeded']) {
    assert.equal(s[f], settingsBefore[f], 'настройка „' + f + '“ е загубена при изтриването');
  }
  assert.equal(s.lib_name, 'Библиотека при НЧ „Пробен“');
  assert.equal(s.pdp_verifier, 'проверител-за-лични-данни',
    'ключът за защита на личните данни трябва да оцелее — без него вече направените криптирани копия стават невъзстановими');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employees WHERE active = 1').get().n, 2);
  assert.equal(db.prepare("SELECT mark FROM author_table WHERE prefix = 'ВАЗ'").get().mark, '14');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM categories').get().n, 10,
    'десетте начални вида документи остават — кодовете им са вътрешни ключове');

  /* Броячът на инвентарните номера — обратно на 1 (чл. 16 брои от първия документ). */
  assert.equal(s.next_inv_number, 1, 'следващият инвентарен номер трябва да е 1');
  assert.notEqual(settingsBefore.next_inv_number, 1, 'фикстурата трябваше да е вдигнала брояча');

  /* Индексите за търсене — празни. При external-content FTS5 обикновен SELECT
     чете през таблицата-източник, затова проверката е с MATCH. */
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH '\"под\"*'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM readers_fts WHERE readers_fts MATCH '\"иван\"*'").get().n, 0);

  /* ФАЙЛЪТ Е СВИТ (VACUUM). Не е козметика: изтритите редове лежат в
     освободените страници на library.db, докато не бъдат презаписани — а в тях
     са ЕГН-тата, адресите и телефоните на всички читатели. „Чиста“ база с
     мегабайти стари лични данни вътре не е чиста. */
  assert.equal(res.data.vacuum.ok, true, 'свиването на файла се провали: ' + res.data.vacuum.error);
  assert.ok(res.data.vacuum.after < res.data.vacuum.before,
    'файлът на базата трябва да се е свил: ' + res.data.vacuum.before + ' → ' + res.data.vacuum.after);
  const raw = fs.readFileSync(dbPath);
  assert.ok(!raw.includes(Buffer.from('Вазов, Иван', 'utf8')),
    'запис от изтрития фонд още се чете суров от файла на базата — VACUUM не е минал');

  assert.equal(res.data.restarting, true);
  assert.equal(relaunch.length, 1, 'програмата трябва да се стартира наново — както при смяна на папката на базата');
  assert.deepEqual(exits, [0]);
});

/* ---------------------------------------------------------------- 3б ---- */
test('индексите за търсене се привеждат в съответствие дори когато са били разминати', () => {
  /* ЗАЩО ТРИГЕРИТЕ НЕ СТИГАТ. books_fts/readers_fts са external-content FTS5:
     DELETE по `books` маха своя ред от индекса чрез тригера books_fts_ad, тоест
     при СИНХРОНЕН индекс изпразването и без „rebuild“ изглежда пълно — и точно
     затова махането на rebuild оцеляваше пред останалите проверки тук.
     Ред, попаднал в индекса БЕЗ съответствие в таблицата, обаче не се маха от
     нищо: тригер за него няма какво да задейства. Такива остатъци се раждат от
     внесена база, прекъсната миграция или ръчна поправка — и после връщат
     резултат за документ, който вече не съществува (в „Книги“ това е ред, който
     гърми при отваряне). Затова изтриването свършва с 'rebuild' — документираният
     начин индексът да се приведе в съответствие със СЪДЪРЖАНИЕТО, безопасен за
     повторно изпълнение (вж. същия довод в search-fts.js). */
  const { db, ipcMain } = setup({ prefix: 'inv-nachisto-fts-', books: 60 });
  db.prepare("INSERT INTO books_fts (rowid, title, subtitle, author) VALUES (990001, 'Призрачно заглавие', NULL, 'Вазов, Иван')").run();
  db.prepare("INSERT INTO readers_fts (rowid, name) VALUES (990002, 'Призрачен читател')").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH '\"призрачно\"*'").get().n, 1,
    'предпоставка: индексът на книгите наистина е разминат с таблицата');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM readers_fts WHERE readers_fts MATCH '\"призрачен\"*'").get().n, 1,
    'предпоставка: и индексът на читателите');

  const res = ipcMain.invoke('reset:wipe', { word: CONFIRM_WORD });
  assert.equal(res.ok, true, res.error);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH '\"призрачно\"*'").get().n, 0,
    'остатъкът в индекса на книгите трябва да си отиде — иначе търсенето връща изтрит документ');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM readers_fts WHERE readers_fts MATCH '\"призрачен\"*'").get().n, 0,
    'същото и за читателите');
});

/* ------------------------------------------------------------------ 4 ---- */
test('id-тата пак тръгват от 1 — новата книга не получава № 15 001', () => {
  const { db, ipcMain } = setup({ prefix: 'inv-nachisto-id-' });
  const maxBookBefore = db.prepare('SELECT MAX(id) AS m FROM books').get().m;
  assert.ok(maxBookBefore > 1);

  assert.equal(ipcMain.invoke('reset:wipe', { word: CONFIRM_WORD }).ok, true);

  const cat = db.prepare("SELECT id FROM categories WHERE code = 'book'").get().id;
  db.prepare('INSERT INTO books (inv_number, title, author, category_id, register_date, status) '
    + "VALUES (1, 'Първа книга на новата библиотека', 'Вазов, Иван', ?, '2026-10-01', 'наличен')").run(cat);
  assert.equal(db.prepare('SELECT MAX(id) AS m FROM books').get().m, 1,
    'първата книга след изтриването трябва да е с id 1 (sqlite_sequence не е изчистена)');

  db.prepare("INSERT INTO readers (name, card_no, registered_at) VALUES ('Нов читател', '1', '2026-10-01')").run();
  assert.equal(db.prepare('SELECT MAX(id) AS m FROM readers').get().m, 1);
  db.prepare("INSERT INTO acquisitions (no, year, date, how) VALUES (1, '2026', '2026-10-01', 'закупуване')").run();
  assert.equal(db.prepare('SELECT MAX(id) AS m FROM acquisitions').get().m, 1);

  /* Оставените таблици НЕ бива да си губят брояча: там още има редове и id 1
     вече е зает — нулиране щеше да даде сблъсък по първичния ключ. */
  db.prepare("INSERT INTO employees (name, active) VALUES ('Трети служител', 1)").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employees').get().n, 3);
});

/* ------------------------------------------------------------------ 5 ---- */
test('одитната следа е първият ред на новата следа и носи пълния път на копието', () => {
  const { db, ipcMain } = setup({ prefix: 'inv-nachisto-sleda-' });
  const auditBefore = countOf(db, 'audit_log');
  assert.ok(auditBefore > 100, 'фикстурата трябва да е засяла стара следа');

  const res = ipcMain.invoke('reset:wipe', { word: CONFIRM_WORD });
  assert.equal(res.ok, true, res.error);

  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  assert.equal(rows.length, 1, 'новата следа трябва да има точно един ред — този за изтриването');
  const row = rows[0];
  assert.equal(row.id, 1, 'редът трябва да е ПЪРВИЯТ на новата, празна следа');
  assert.equal(row.action, 'Изтриване на всички данни');
  assert.equal(row.user, 'Мария Георгиева', 'следата трябва да е подписана с името на служителя');
  assert.ok(row.detail.includes(res.data.backup.path),
    'следата трябва да носи ПЪЛНИЯ път на резервното копие, а не само „копието е направено“:\n' + row.detail);
  assert.match(row.detail, /ИЗТРИЙ/);
  assert.match(row.detail, /Изтрити редове: \d+/);
  assert.match(row.detail, /ЗАПАЗЕНИ/);
  /* Изтичането, което изтриването НЕ поправя, влиза и в следата: публикуваният
     katalog.json остава онлайн със записите на старата библиотека и няма да се
     изчисти сам (main.js отказва да презапише непразен каталог с празен). */
  assert.ok(row.detail.includes('katalog.json'), 'следата трябва да каже за публикувания каталог');
  assert.ok(row.detail.includes('/home/biblioteka/katalog-repo'));
  assert.ok(res.data.deleted.total > 0);
  assert.ok(res.data.message.includes(res.data.backup.path),
    'съобщението на екрана също трябва да каже КЪДЕ е копието');
});

/* ------------------------------------------------------------------ 6 ---- */
test('резервното копие отпреди изтриването наистина съдържа старите данни', () => {
  const { db, ipcMain } = setup({ prefix: 'inv-nachisto-kopie-' });
  const before = {
    books: countOf(db, 'books'), readers: countOf(db, 'readers'),
    loans: countOf(db, 'loans'), audit: countOf(db, 'audit_log')
  };
  const firstTitle = db.prepare('SELECT title FROM books ORDER BY id LIMIT 1').get().title;

  const res = ipcMain.invoke('reset:wipe', { word: CONFIRM_WORD });
  assert.equal(res.ok, true, res.error);
  const bak = res.data.backup.path;
  assert.ok(fs.existsSync(bak), 'файлът с копието трябва да съществува: ' + bak);
  assert.match(path.basename(bak), /^before-reset-/,
    'името трябва да е от семейството „before-restore-…“, а не „auto-…“ — иначе изчистването на '
    + 'автоматичните копия го маха след 30 дни');
  assert.equal(res.data.backup.encrypted, false, 'без отключена защита копието е некриптирано');

  // Копието се ОТВАРЯ и се брои — съществуването на файл не е доказателство.
  const old = new Database(bak, { readonly: true, fileMustExist: true });
  try {
    assert.equal(old.prepare('SELECT COUNT(*) AS n FROM books').get().n, before.books);
    assert.equal(old.prepare('SELECT COUNT(*) AS n FROM readers').get().n, before.readers);
    assert.equal(old.prepare('SELECT COUNT(*) AS n FROM loans').get().n, before.loans);
    assert.equal(old.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, before.audit);
    assert.equal(old.prepare('SELECT title FROM books ORDER BY id LIMIT 1').get().title, firstTitle);
    assert.equal(old.prepare('SELECT lib_name FROM settings WHERE id = 1').get().lib_name,
      'Библиотека при НЧ „Пробен“');
  } finally {
    old.close();
  }
  // А живата база вече е празна — копието не е „вместо“ изтриването.
  assert.equal(countOf(db, 'books'), 0);
});

/* ------------------------------------------------------------------ 7 ---- */
test('при отключена защита на личните данни копието е криптирано', () => {
  const { db, ipcMain } = setup({ prefix: 'inv-nachisto-kriptirano-' });
  const books = countOf(db, 'books');
  pii.setSession('парола-за-лични-данни-11', null);
  let res;
  try {
    res = ipcMain.invoke('reset:wipe', { word: CONFIRM_WORD });
  } finally {
    pii.clearSession();
  }
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.backup.encrypted, true,
    'папката с копията по документиран сценарий е споделена в мрежата — копие с ЕГН в чист текст там не бива');
  assert.match(path.basename(res.data.backup.path), /\.invbak$/);
  assert.equal(isEncryptedBackup(res.data.backup.path), true);

  // И се отваря с паролата, и вътре са старите данни.
  const buf = decryptBackupBuffer(res.data.backup.path, 'парола-за-лични-данни-11');
  const tmp = path.join(os.tmpdir(), 'nachisto-test-' + process.pid + '.db');
  fs.writeFileSync(tmp, buf);
  try {
    const old = new Database(tmp, { readonly: true, fileMustExist: true });
    assert.equal(old.prepare('SELECT COUNT(*) AS n FROM books').get().n, books);
    old.close();
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* временен файл */ }
  }
  assert.equal(countOf(db, 'books'), 0);
});

/* ------------------------------------------------------------------ 8 ---- */
test('reset:plan казва какво изчезва, какво остава и къде ще е копието — ПРЕДИ потвърждението', () => {
  const { dir, db, ipcMain } = setup({ prefix: 'inv-nachisto-plan-' });
  const res = ipcMain.invoke('reset:plan');
  assert.equal(res.ok, true, res.error);
  const p = res.data;

  assert.equal(p.word, CONFIRM_WORD, 'думата идва от обработчика, за да не се разминат екранът и проверката');
  assert.ok(p.totalRows > 0);
  assert.equal(p.totalRows, DATA_TABLES.reduce((s, t) => s + countOf(db, t), 0),
    'общият брой трябва да отговаря на това, което наистина ще бъде изтрито');
  assert.ok(p.groups.length >= 5, 'числата се показват по разбираеми групи, не по имена на таблици');
  for (const g of p.groups) assert.ok(g.rows > 0 && typeof g.group === 'string');

  assert.equal(p.keep.length, KEEP.length);
  for (const k of p.keep) {
    assert.ok(k.label && k.why && k.why.length > 40,
      'всяко оставено нещо трябва да носи причината си на екрана, не само име: ' + JSON.stringify(k));
  }
  assert.equal(p.backupFolder, path.join(dir, 'backups'));
  /* Публикуваният katalog.json е в ЧУЖДА папка и вече е качен в интернет —
     изтриването не го маха и екранът трябва да го каже. */
  assert.equal(p.catalogFolder, '/home/biblioteka/katalog-repo');
  assert.equal(p.catalogRepo, 'proben/proben-katalog');
  assert.equal(p.library.employees, 2);
  assert.equal(p.library.authorMarks, 2);

  // Планът е само поглед — не пипа нищо.
  assert.ok(countOf(db, 'books') > 0);
});

/* ------------------------------------------------------------------ 9 ---- */
test('списъците „изтрива се“ и „остава“ покриват цялата схема', () => {
  const { db } = setup({ prefix: 'inv-nachisto-shema-', seed: false });
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(r => r.name)
    // Вътрешните таблици на FTS5 (books_fts_data и т.н.) се водят от самия индекс.
    .filter(n => !/_fts(_(data|idx|content|docsize|config))?$/.test(n));

  const decided = new Set([...DATA_TABLES, ...KEPT_TABLES]);
  for (const t of tables) {
    assert.ok(decided.has(t),
      'таблица „' + t + '“ не е нито в списъка за изтриване, нито в списъка на оставените в '
      + 'handlers/reset.js. Всяка таблица иска ИЗРИЧНО решение с причина — мълчаливото пропускане '
      + 'оставя данни на старата библиотека в „чистата“ база.');
  }
  for (const t of decided) {
    assert.ok(tables.includes(t), 'таблица „' + t + '“ от списъците в handlers/reset.js вече не е в схемата');
  }
  // И нито една таблица не е и в двата списъка.
  for (const t of KEPT_TABLES) assert.ok(!DATA_TABLES.includes(t), 'таблица „' + t + '“ е и в двата списъка');
  // Одитната следа се изтрива ПОСЛЕДНА — новият ѝ пръв ред идва веднага след това.
  assert.equal(DATA_TABLES[DATA_TABLES.length - 1], 'audit_log');
});

/* ----------------------------------------------------------------- 10 ---- */
test('каналите са регистрирани от истинския main.js и отказват без думата', async () => {
  const { startMainApp } = require('./helpers/main-app.js');
  const app = startMainApp();
  await app.ready();
  try {
    assert.ok(app.has('reset:plan'), 'main.js не регистрира reset:plan');
    assert.ok(app.has('reset:wipe'), 'main.js не регистрира reset:wipe');

    const plan = app.invoke('reset:plan');
    assert.equal(plan.ok, true, plan.error);
    assert.equal(plan.data.word, CONFIRM_WORD);

    /* Празна инсталация — отказът без дума пак трябва да е отказ, и то ПРЕДИ
       каквото и да е пипане по базата. (Успешно изтриване не се пуска тук:
       двойникът на app.exit() в main-app.js нарочно хвърля.) */
    const res = app.invoke('reset:wipe', { word: 'да' });
    assert.equal(res.ok, false);
    assert.match(res.error, /ИЗТРИЙ/);
  } finally {
    app.stop();
  }
});

/* ----------------------------------------------------------------- 11 ---- */
test('екранът „Настройки“ води до изтриването и предупреждава за публикувания каталог', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'settings.js'), 'utf8');
  assert.match(src, /onclick="resetAllForm\(\)"/, 'няма бутон, който да отвори прозореца');
  assert.match(src, /window\.resetAllForm = resetAllForm/);
  assert.match(src, /window\.resetAllRun = resetAllRun/);
  assert.match(src, /window\.api\.reset\.plan\(\)/, 'екранът трябва да покаже какво изчезва ПРЕДИ потвърждението');
  assert.match(src, /window\.api\.reset\.wipe\(\{ word/, 'думата трябва да стигне до обработчика');
  assert.match(src, /katalog\.json/, 'екранът трябва да каже, че публикуваният каталог остава публикуван');
  assert.match(src, /стартира наново/, 'екранът трябва да каже, че програмата ще се рестартира');
  /* Думата НЕ бива да е зашита в екрана като условие — идва от reset:plan. */
  assert.match(src, /RESET_PLAN && RESET_PLAN\.word/);

  const preload = fs.readFileSync(path.join(APP_DIR, 'preload.js'), 'utf8');
  assert.match(preload, /plan: invoke\('reset:plan'\)/);
  assert.match(preload, /wipe: invoke\('reset:wipe'\)/);
});

/* ----------------------------------------------------------------- 12 ---- */
test('прозорецът показва числата, оставащото, пътя на копието и предупреждението — преди потвърждението', async () => {
  const { buildDom, settle } = require('./helpers/audit-fixtures');
  const plan = {
    word: CONFIRM_WORD,
    totalRows: 41234,
    groups: [{ group: 'Заемания', rows: 12000 }, { group: 'Фонд', rows: 15000 }],
    keep: KEEP.map(([table, label, why]) => ({ table, label, why })),
    library: { name: 'Библиотека при НЧ „Пробен“', employees: 2, authorMarks: 2 },
    backupFolder: '/данни/library/backups',
    backupEncrypted: false,
    pdpConfigured: false,
    dbFolder: '/данни/library',
    catalogFolder: '/home/biblioteka/katalog-repo',
    catalogRepo: 'proben/proben-katalog'
  };
  const wiped = [];
  const dom = buildDom({
    'reset.plan': plan,
    'reset.wipe': (args) => { wiped.push(args[0]); return { backup: { path: '/данни/library/backups/before-reset-x.db' }, message: 'готово' }; }
  });
  const w = dom.window;
  try {
    await w.resetAllForm();
    await settle();
    const box = w.document.querySelector('#modal');
    const text = box.textContent.replace(/\s+/g, ' ');

    assert.match(text, /Изтриване на всички данни — започване на чисто/);
    assert.match(text, /Това действие е необратимо/);
    assert.match(text, /пълно резервно копие/i);
    assert.ok(text.includes('/данни/library/backups'), 'пътят на копието трябва да се вижда: ' + text);
    assert.match(text, /Ако копието не успее, не се изтрива нищо/);
    // Числата на онова, което изчезва — по групи и общо.
    assert.match(text, /Изчезва \(41 234 записа общо\)/);
    assert.match(text, /Заемания — 12 000/);
    // Списъкът на оставащото — с причината за всяко.
    assert.match(text, /Остава/);
    for (const [, label] of KEEP) assert.ok(text.includes(label), 'липсва оставащо: ' + label);
    assert.match(text, /авторски знак/i);
    assert.match(text, /Следващият инвентарен номер се връща на 1/);
    assert.match(text, /Резервните копия .*не се изтриват/);
    // Изтичането, което изтриването не поправя.
    assert.match(text, /Онлайн каталогът остава публикуван/);
    assert.ok(text.includes('katalog.json'));
    assert.ok(text.includes('/home/biblioteka/katalog-repo'));
    assert.ok(text.includes('proben/proben-katalog'));
    // Рестартът — казан ПРЕДИ потвърждението.
    assert.match(text, /програмата ще се стартира наново/i);
    // Самото потвърждение е поле за писане, не отметка.
    const field = box.querySelector('[name="word"]');
    assert.ok(field, 'няма поле за думата за потвърждение');
    assert.notEqual(field.type, 'checkbox', 'отметка не стига за необратимо действие');
    assert.match(text, /Напишете думата ИЗТРИЙ/);

    /* Грешна дума → екранът не вика канала изобщо (същинският отказ пак е в
       обработчика — виж тест 1). */
    field.value = 'да';
    await w.resetAllRun();
    await settle();
    assert.equal(wiped.length, 0, 'при грешна дума екранът не бива да вика изтриването');

    field.value = 'ИЗТРИЙ';
    await w.resetAllRun();
    await settle();
    assert.equal(wiped.length, 1);
    // equal, не deepEqual: обектът идва от друга среда (jsdom) и прототипът му е друг.
    assert.equal(wiped[0].word, 'ИЗТРИЙ', 'думата трябва да стигне до обработчика такава, каквато е написана');
  } finally {
    w.close();
  }
});
