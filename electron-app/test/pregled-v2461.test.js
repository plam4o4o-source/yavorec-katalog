/* ПРЕГЛЕД НА КРЪГА v2.4.61 — петте поправки след прегледа на кода.
   ===========================================================================
   Всяка от петте е възпроизведена ПРЕДИ поправката и всеки тест тук е проверен
   с връщане на стария ред (мутация): без поправката пада точно той.

   Файлът работи през ИСТИНСКИЯ main.js (test/helpers/main-app.js), защото три
   от петте живеят точно в срещата между схемата, миграциите и обработчиците:
     1) миграция 16 не бива да отнема кода на вече разпознат вид документи;
     2) списъкът с проверки и протоколът по чл. 40 броят едно и също;
     3) в акта по чл. 30, т. 5 обезщетението се начислява ПРЕДИ забавата;
     4) уникалният индекс на кардекса се създава от миграция, не от schema.sql;
     5) „Инвентирани комплекти“ пита състоянието през общия ключ на фонда.

   Базата се ЗАВАРВА (seedDb): описана е така, както обновяването я намира при
   библиотекар, който е преименувал вида за периодика и е вписал част от
   годишните комплекти под „книга“. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { startMainApp } = require('./helpers/main-app.js');
const { chargeCoverage } = require('../handlers/account.js');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

/* Заварената база: вид „продължаващо издание“ е преименуван (тоест попълването
   по име няма да го намери), а годишните комплекти са разделени — повечето по
   погрешка под „книга“, останалите под преименувания вид. Точно това
   съотношение прави находката видима: „познаването по вече инвентираните
   комплекти“ вижда първо „книга“. */
function seedLegacyDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  /* База ОТПРЕДИ миграция 16: колоната categories.code още не съществува. Това
     не е украса на фикстурата — то е причината резервното разпознаване изобщо
     да е достижимо. В такава база началното засяване в schema.sql
     (`INSERT OR IGNORE INTO categories (name, code)`) не може да мине и
     преименуваният вид НЕ се възстановява под старото си име; чак миграция 16
     добавя колоната и попълва кодовете. */
  db.exec(`CREATE TABLE cat_old (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
           INSERT INTO cat_old (id, name) SELECT id, name FROM categories;
           DROP TABLE categories;
           ALTER TABLE cat_old RENAME TO categories;`);
  db.prepare("UPDATE categories SET name = 'Периодични издания' WHERE name = 'продължаващо издание'").run();
  const catBook = db.prepare("SELECT id FROM categories WHERE name = 'книга'").get().id;
  const catPer = db.prepare("SELECT id FROM categories WHERE name = 'Периодични издания'").get().id;
  const ins = db.prepare("INSERT INTO books (inv_number, title, volume, category_id, status) "
    + "VALUES (?, ?, 'годишен комплект', ?, 'наличен')");
  for (let i = 1; i <= 5; i++) ins.run(i, 'Вестник, комплект ' + i, catBook);
  for (let i = 6; i <= 7; i++) ins.run(i, 'Списание, комплект ' + i, catPer);
  db.pragma('user_version = 0');
  db.close();
}

const app = startMainApp({ seedDb: seedLegacyDb });
let db;                                  // втора връзка към същия файл — само за четене/фикстури
test.before(async () => {
  await app.ready();
  db = new Database(path.join(app.userData, 'library.db'));
});
test.after(() => { try { db.close(); } catch (e) { /* няма значение */ } app.stop(); });

/* ------------------------------------------------------------------ 1 ---- */
test('миграция 16 не отнема кода на вече разпознат вид — „книга“ си остава книга', () => {
  const byName = {};
  for (const r of db.prepare('SELECT name, code FROM categories').all()) byName[r.name] = r.code;
  assert.equal(byName['книга'], 'book',
    'видът „книга“ е разпознат по име; резервното разпознаване на периодиката не бива да му вземе кода — '
    + 'иначе Дневникът брои всяко заемане на книга в реда „Периодични издания“ на Раздел Б');
  assert.equal(byName['Периодични издания'], 'periodical',
    'преименуваният вид се разпознава по вече инвентираните годишни комплекти — това е смисълът на резервното разпознаване');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM categories WHERE code = 'book'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM categories WHERE code = 'periodical'").get().n, 1);
});

/* ------------------------------------------------------------------ 2 ---- */
test('списъкът с проверки брои липсите по СНИМКАТА — същото число, което печата протоколът по чл. 40', async () => {
  const bookId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (900, 'Неразделен запис', 'наличен')")
    .run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 3)').run(bookId);
  const sid = db.prepare("INSERT INTO inventory_sessions (date, pool_size, closed) "
    + "VALUES ('2026-01-10', 1, 1)").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory_session_missing (session_id, book_id, inv_number, title, quantity) '
    + "VALUES (?, ?, 900, 'Неразделен запис', 3)").run(sid, bookId);

  const rowOf = async () => (await app.invoke('inventorySessions:list')).data.find(r => r.id === sid);
  assert.equal((await rowOf()).missing, 3, 'преди каквато и да е поправка двете числа съвпадат');

  /* Библиотекарката поправя „Налични бройки“ на вече липсващия документ —
     СЛЕД приключената проверка. Протоколът е подписан и не се променя със
     задна дата; списъкът трябва да казва същото. */
  db.prepare('UPDATE inventory SET quantity = 1 WHERE book_id = ?').run(bookId);
  const got = (await app.invoke('inventorySessions:get', sid)).data;
  assert.equal(got.missingDocs, 3, 'протоколът чете снимката');
  assert.equal((await rowOf()).missing, 3,
    'и списъкът чете същата снимка — иначе екранът казва „липсващи 1“ до бутона, който печата „липсващи 3“');
});

/* ------------------------------------------------------------------ 3 ---- */
test('акт по чл. 30, т. 5: първите платени пари покриват ОБЕЗЩЕТЕНИЕТО, не забавата', async () => {
  db.prepare('UPDATE settings SET fine_per_day = 0.20 WHERE id = 1').run();
  const bookId = db.prepare("INSERT INTO books (inv_number, title, status, price) "
    + "VALUES (901, 'Невърната книга', 'наличен', 10) ").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Невърнал читател')").run().lastInsertRowid;
  db.prepare("INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, '2026-01-01', '2026-01-31')")
    .run(bookId, readerId);

  const created = await app.invoke('deaccessionActs:create', {
    act: { no: 71, date: '2026-03-02', reason_code: 5, reason_text: 'невърнати от ползватели',
      committee1: 'А', committee2: 'Б', committee3: 'В' },
    bookIds: [bookId]
  });
  assert.equal(created.ok, true, created.error);

  const l = db.prepare('SELECT lost_amount, lost_account_line_id, deaccession_fine, deaccession_fine_line_id '
    + 'FROM loans WHERE book_id = ?').get(bookId);
  assert.ok(l.lost_amount > 0 && l.deaccession_fine > 0, 'и двете начисления са реални суми');
  assert.ok(l.lost_account_line_id < l.deaccession_fine_line_id,
    'обезщетението за документа е ПЪРВИЯТ ред в сметката, забавата — вторият; '
    + 'плащанията се разнасят по реда на възникване (chargeCoverage) и в рамките на един ден решава точно този ред');

  // Читателят плаща точно колкото е обезщетението за самия документ.
  const paid = await app.invoke('account:pay', { reader_id: readerId, amount: l.lost_amount, date: '2026-03-05' });
  assert.equal(paid.ok, true, paid.error);
  const covLost = chargeCoverage(db, l.lost_account_line_id);
  const covFine = chargeCoverage(db, l.deaccession_fine_line_id);
  assert.equal(covLost.outstanding, 0,
    'отчисленото по акта е обезщетено — това е въпросът, който стои пред комисията по чл. 30, т. 5');
  assert.equal(covFine.outstanding, l.deaccession_fine, 'забавата остава дължима');
});

/* ------------------------------------------------------------------ 4 ---- */
test('уникалният индекс на кардекса се създава от миграция 16, а schema.sql минава и върху база с дубликати', () => {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_per_issue_unique'").get(),
    'защитата „един брой — един ред“ е налице след стартирането');
  /* И наистина работи: заобикалянето на обработчика (второто работно място,
     което пише в същата мрежова база) също се отказва. */
  const pid = db.prepare("INSERT INTO periodicals (title) VALUES ('Вестник за индекса')").run().lastInsertRowid;
  const dup = db.prepare("INSERT INTO periodical_issues (periodical_id, issue_no, date, price) VALUES (?, '2', '2026-02-14', 3.5)");
  dup.run(pid);
  assert.throws(() => dup.run(pid), /UNIQUE/, 'един и същ брой (номер и дата) не влиза два пъти');

  /* Заварена база с повтарящи се броеве (единствената, заради която проверката
     изобщо съществува): schema.sql се изпълнява при ВСЯКО стартиране и НЕ бива
     да пада върху нея — db.exec() спира на първата грешка и останалата част от
     файла не се изпълнява. Затова уникалният индекс стои в миграция 16, където
     провалът се хваща и се обяснява в одитната следа. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-dup-kardex-'));
  const old = new Database(path.join(dir, 'library.db'));
  try {
    old.exec(SCHEMA_SQL);
    const pid = old.prepare("INSERT INTO periodicals (title) VALUES ('Вестник')").run().lastInsertRowid;
    const ins = old.prepare("INSERT INTO periodical_issues (periodical_id, issue_no, date, price) VALUES (?, '117', '2025-06-02', 1)");
    ins.run(pid); ins.run(pid);
    old.exec(SCHEMA_SQL);   // следващото стартиране
  } finally {
    old.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ 5 ---- */
test('„Инвентирани комплекти“ брои и комплект с непопълнено състояние (NULL-безопасният ключ на фонда)', async () => {
  const pid = db.prepare("INSERT INTO periodicals (title) VALUES ('Вестник с внесени данни')").run().lastInsertRowid;
  const b1 = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (910, 'комплект 2024', 'наличен')").run().lastInsertRowid;
  const b2 = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (911, 'комплект 2025', NULL)").run().lastInsertRowid;
  db.prepare('INSERT INTO periodical_volumes (periodical_id, year, book_id) VALUES (?, 2024, ?)').run(pid, b1);
  db.prepare('INSERT INTO periodical_volumes (periodical_id, year, book_id) VALUES (?, 2025, ?)').run(pid, b2);

  const row = (await app.invoke('periodicals:list')).data.find(p => p.id === pid);
  assert.equal(row.volume_count, 2,
    'ред с NULL състояние (внесени данни, никога отваряни) Е във фонда — `status <> \'отчислен\'` дава NULL за него '
    + 'и колоната показваше предупредителната нула за издание, което влиза в КДБФ');
});
