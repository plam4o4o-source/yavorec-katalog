'use strict';
/* Реодит на самите поправки (v2.4.9) — независим преглед намери дефекти В ТЯХ.
   Тук стоят регресиите за най-тежките, за да не се върнат:

     1) прекриптирането на старите копия при смяна на паролата презаписваше
        всеки исторически файл със СНИМКА НА ДНЕШНАТА база;
     2) `loans.deaccession_act_id` съществуваше само в schema.sql, тоест липсваше
        във вече създадените бази и „Справки и статистика" гърмеше при тях;
     3) SQL и JS страните брояха различно при изрично нулеви бройки;
     4) отчетната бройка се четеше живо от inventory и променяше отпечатан
        КДБФ за минала година със задна дата. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const run = (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } };
const tmpDirs = [];
const mkdir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* няма значение */ } } });

function freshDb(prefix) {
  const dir = mkdir(prefix);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return { db, dir };
}
function api(mod, deps) {
  const h = new Map();
  require(mod)({ handle: (c, f) => h.set(c, f) }, deps);
  return { invoke: (c, ...a) => h.get(c)({}, ...a) };
}

/* ------------------------------------------------------------------
   1. Прекриптирането пази СЪДЪРЖАНИЕТО на всяко старо копие.
   ------------------------------------------------------------------ */

test('прекриптирането на старо копие запазва неговите данни, а не снима днешната база', () => {
  const { encryptBackupFile, decryptBackupBuffer } = require('../backup-crypto');
  const dir = mkdir('inv-reenc-');
  // „Старо копие“ — база с едно-единствено, разпознаваемо съдържание.
  const oldDbPath = path.join(dir, 'old.db');
  const oldDb = new Database(oldDbPath);
  oldDb.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('СТАРО СЪСТОЯНИЕ');");
  oldDb.close();
  const backup = path.join(dir, 'auto-2026-07-01.invbak');
  encryptBackupFile(oldDbPath, backup, 'старата-парола-1234');

  // Точно стъпките на reencryptOldBackups: разкриптирай със старата парола →
  // запиши криптирано с новата → провери → преименувай.
  const buf = decryptBackupBuffer(backup, 'старата-парола-1234');
  const plainTmp = backup + '.plain.tmp';
  const staged = backup + '.tmp';
  fs.writeFileSync(plainTmp, buf);
  encryptBackupFile(plainTmp, staged, 'новата-парола-5678');
  fs.renameSync(staged, backup);
  fs.unlinkSync(plainTmp);

  const out = path.join(dir, 'restored.db');
  fs.writeFileSync(out, decryptBackupBuffer(backup, 'новата-парола-5678'));
  const v = new Database(out).prepare('SELECT v FROM marker').get().v;
  assert.equal(v, 'СТАРО СЪСТОЯНИЕ',
    'копието трябва да пази СВОЕТО съдържание; ако тук излезе днешната база, '
    + 'тридесетдневният прозорец за връщане назад е изтрит');
  assert.ok(!fs.existsSync(plainTmp), 'разшифрованият близнак не бива да остава на диска');
  assert.ok(!fs.existsSync(staged));
});

test('reencryptOldBackups НЕ ползва writeEncryptedDaily — то снима живата база', () => {
  /* Проверка на самия код, защото разликата не личи от поведението при чиста
     тестова база (там „живата" и „старата" са едно и също). */
  const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'backup.js'), 'utf8');
  const fn = src.slice(src.indexOf('function reencryptOldBackups'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.ok(!/writeEncryptedDaily\s*\(/.test(body),
    'writeEncryptedDaily вика doBackupTo (живата база) и изобщо не чете подадения plainDest');
  assert.ok(/encryptBackupFile\s*\(/.test(body), 'очаква се шифроване на самия разчетен файл');
  assert.ok(/decryptBackupBuffer\s*\(/.test(body), 'очаква се разчитане със старата парола');
});

/* ------------------------------------------------------------------
   2. Колоната deaccession_act_id я има и в СТАРА база.
   ------------------------------------------------------------------ */

test('стара база без loans.deaccession_act_id получава колоната при стартиране', () => {
  const dir = mkdir('inv-legacy-loans-');
  const p = path.join(dir, 'library.db');
  const db = new Database(p);
  // Таблицата вече съществува — CREATE TABLE IF NOT EXISTS няма да я пипне.
  db.exec(`CREATE TABLE loans (id INTEGER PRIMARY KEY AUTOINCREMENT, reader_id INTEGER, book_id INTEGER,
    date_out TEXT NOT NULL, date_due TEXT, date_in TEXT, fine REAL DEFAULT 0, renewals INTEGER DEFAULT 0);`);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const before = db.prepare('PRAGMA table_info(loans)').all().map(c => c.name);
  assert.ok(!before.includes('deaccession_act_id'),
    'самата схема НЕ добавя колона към съществуваща таблица — точно затова трябва миграция');

  // Същата стъпка, която main.js изпълнява при стартиране (ensureColumns).
  db.exec('ALTER TABLE loans ADD COLUMN deaccession_act_id INTEGER');
  const after = db.prepare('PRAGMA table_info(loans)').all().map(c => c.name);
  assert.ok(after.includes('deaccession_act_id'));

  // И най-важното: справката вече минава.
  const stats = api('../handlers/stats', {
    getDb: () => db, run, yearOf: () => '2026', value: () => 0, dnevnikSumRow: () => ({})
  });
  db.exec(`CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, inv_number INTEGER, title TEXT,
    status TEXT, price REAL, register_date TEXT, language TEXT, department TEXT, category_id INTEGER, deaccession_date TEXT);`);
  const res = stats.invoke('stats:report', '2026');
  assert.equal(res.ok, true, 'справката не бива да гърми с „no such column“: ' + res.error);
});

test('main.js мигрира deaccession_act_id, а не разчита само на handlers/deaccession-acts.js', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // ensureColumns('loans', …) се среща повече от веднъж — търси се във всички.
  const blocks = [...main.matchAll(/ensureColumns\('loans',\s*\{([\s\S]*?)\}\)/g)].map(x => x[1]);
  assert.ok(blocks.length, 'очаква се ensureColumns за loans в main.js');
  assert.match(blocks.join('\n'), /deaccession_act_id/,
    'колоната се ползва от stats.js при всяко отваряне на „Справки", а лениво се '
    + 'създаваше само след съставяне на акт за отчисляване');
});

/* ------------------------------------------------------------------
   3. SQL и JS броят еднакво при изрично нулеви бройки.
   ------------------------------------------------------------------ */

test('изрично нулеви бройки се броят еднакво в общия сбор и в разбивката по вид', () => {
  const { db } = freshDb('inv-qty-zero-');
  const mk = (inv, qty, price) => {
    const id = db.prepare("INSERT INTO books (inv_number, title, status, price, register_date, language) VALUES (?,?,?,?,?,?)")
      .run(inv, 'Кн ' + inv, 'наличен', price, '2026-02-02', 'български').lastInsertRowid;
    if (qty !== null) db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?,?)').run(id, qty);
    return id;
  };
  mk(1, 3, 10);     // 3 екземпляра
  mk(2, 0, 10);     // изрично нула — библиотекарят е въвел 0
  mk(3, null, 10);  // стара база без ред в inventory → 1 документ

  const stats = api('../handlers/stats', {
    getDb: () => db, run, yearOf: () => '2026', value: () => 0, dnevnikSumRow: () => ({})
  });
  const rep = stats.invoke('stats:report', '2026').data;
  const byLang = rep.fundByLanguage.reduce((s, [, n]) => s + n, 0);
  assert.equal(rep.fundCount, 4, '3 + 0 + 1');
  assert.equal(byLang, rep.fundCount,
    'JS сборът и SQL разбивката трябва да дават едно и също — „Number(qty) || 1" превръщаше нулата в единица');
  assert.equal(rep.fundValue, 40, 'книга с 0 бройки не носи стойност');
});

/* ------------------------------------------------------------------
   4. КДБФ за минала година не се променя със задна дата.
   ------------------------------------------------------------------ */

test('отчислените се броят по СНИМКАТА в акта — по-късна редакция на бройките не пипа стар КДБФ', () => {
  const { db } = freshDb('inv-deacc-snap-');
  const bookId = db.prepare("INSERT INTO books (inv_number, title, status, price, register_date) VALUES (1,'Тютюн','отчислен',10,'2020-01-01')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 3)').run(bookId);
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date) VALUES (1,'2024','2024-06-01')").run().lastInsertRowid;
  // Снимка към момента на акта: 3 екземпляра.
  db.prepare("INSERT INTO deaccession_items (act_id, book_id, inv_number, title, price, quantity) VALUES (?,?,1,'Тютюн',10,3)").run(actId, bookId);

  const kdbf = api('../handlers/kdbf', { getDb: () => db, run, yearOf: () => '2024' });
  const before = kdbf.invoke('kdbf:report', '2024').data;
  assert.equal(before.deaccYear.n, 3);
  assert.equal(before.deaccYear.v, 30);

  // Библиотекарят редактира бройките на документа две години по-късно.
  db.prepare('UPDATE inventory SET quantity = 1 WHERE book_id = ?').run(bookId);
  const after = kdbf.invoke('kdbf:report', '2024').data;
  assert.equal(after.deaccYear.n, 3, 'отпечатаният КДБФ за 2024 г. не бива да се променя със задна дата');
  assert.equal(after.deaccYear.v, 30);

  // И дори при изтрит документ (book_id → NULL) актът си остава верен.
  db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
  const gone = kdbf.invoke('kdbf:report', '2024').data;
  assert.equal(gone.deaccYear.n, 3, 'изтриването на документа не бива да свива стар акт');
});

test('акт отпреди тази версия (quantity IS NULL) се брои по един документ на ред', () => {
  const { db } = freshDb('inv-deacc-legacy-');
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date) VALUES (1,'2023','2023-06-01')").run().lastInsertRowid;
  db.prepare("INSERT INTO deaccession_items (act_id, inv_number, title, price) VALUES (?,1,'Стар акт',5)").run(actId);
  db.prepare("INSERT INTO deaccession_items (act_id, inv_number, title, price) VALUES (?,2,'Стар акт 2',5)").run(actId);
  const kdbf = api('../handlers/kdbf', { getDb: () => db, run, yearOf: () => '2023' });
  const r = kdbf.invoke('kdbf:report', '2023').data;
  assert.equal(r.deaccYear.n, 2, 'NULL бройки = както се броеше и преди: един ред, един документ');
  assert.equal(r.deaccYear.v, 10);
});

/* ------------------------------------------------------------------
   5. Екраните за постъпления и отчисляване не си противоречат с КДБФ.
   ------------------------------------------------------------------ */

test('„Постъпления" и КДБФ Част № 1 показват едно и също число за една партида', () => {
  const { db } = freshDb('inv-acq-match-');
  const acqId = db.prepare("INSERT INTO acquisitions (no, year, date) VALUES (7,'2026','2026-03-01')").run().lastInsertRowid;
  for (let i = 1; i <= 4; i++) {
    const id = db.prepare("INSERT INTO books (inv_number, title, status, price, register_date, acquisition_id) VALUES (?,?,'наличен',10,'2026-03-01',?)")
      .run(i, 'Кн ' + i, acqId).lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 3)').run(id);
  }
  const acq = api('../handlers/acquisitions', {
    getDb: () => db, run, logAudit: () => {}, yearOf: () => '2026',
    BOOK_SELECT: require('./helpers/prod-values.js').BOOK_SELECT
  });
  const kdbf = api('../handlers/kdbf', { getDb: () => db, run, yearOf: () => '2026' });
  const list = acq.invoke('acquisitions:list').data.find(a => a.id === acqId);
  const part1 = kdbf.invoke('kdbf:report', '2026').data.part1.find(a => a.id === acqId);
  assert.equal(list.registered_count, 12, '4 заглавия по 3 екземпляра');
  assert.equal(list.registered_count, part1.registered_count,
    'екранът „Постъпления" и отпечатаният КДБФ не бива да показват различни числа за една партида');
  assert.equal(list.registered_value, part1.registered_value);
});

test('acquisitions:get дава fund_qty, отделно от наличността quantity', () => {
  const { db } = freshDb('inv-fundqty-');
  const acqId = db.prepare("INSERT INTO acquisitions (no, year, date) VALUES (1,'2026','2026-03-01')").run().lastInsertRowid;
  // Книга БЕЗ ред в inventory — стара/внесена база.
  db.prepare("INSERT INTO books (inv_number, title, status, price, register_date, acquisition_id) VALUES (9,'Без inventory','наличен',5,'2026-03-01',?)").run(acqId);
  const acq = api('../handlers/acquisitions', {
    getDb: () => db, run, logAudit: () => {}, yearOf: () => '2026',
    BOOK_SELECT: require('./helpers/prod-values.js').BOOK_SELECT
  });
  const it = acq.invoke('acquisitions:get', acqId).data.items[0];
  assert.equal(it.quantity, 0, 'наличност за заемане: липсващият ред значи, че документът не може да се заеме');
  assert.equal(it.fund_qty, 1, 'брой документи във фонда: вписаният документ е поне един');
});
