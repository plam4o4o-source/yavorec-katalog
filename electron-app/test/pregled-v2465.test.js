'use strict';
/* ============================================================================
   ПРЕГЛЕД НА КРЪГА v2.4.65 — девет поправени находки.
   ============================================================================
   Кръгът за v2.4.65 поправи 46 неща. Прегледът му върна десет находки; девет
   бяха потвърдени напълно (трите за личните данни — на истинска база), една
   само частично (цените с валута при внос — виж CHANGELOG, не е пипана тук).
   Тестовете заковават поправките, а не намеренията. Всеки е проверен с
   връщане на своята поправка.

     Л1  „Документът се намери“ и „Изтрит читател“ се обезличават
     Л2  заличаването по чл. 17 отказва АКТИВНИТЕ резервации, не ги прехвърля
     Л3  заличаването не пипа съименник с по-дълго име или с друга карта
     П4  заварената забава само в loans.fine не се води платена
     П7  непрочетено покритие не се обявява за „изтрито“ и не къса връзката
     П8  заварен дубликат по регистър („Труд“/„ТРУД“) остава редактируем
     С9  провалено преместване на базата оставя коригиращ ред в следата
     Ч10 служебният запис не се брои за „читател без съгласие“
     Д6  формата за деня отказва „2,7“ вместо да го запише като 0
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { APP_DIR, mkTmpDir, cleanupTmpDirs, fakeIpcMain, runDep } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

const read = (...p) => fs.readFileSync(path.join(APP_DIR, ...p), 'utf8');

function freshDb(prefix) {
  const dir = mkTmpDir(prefix);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(read('db', 'schema.sql'));
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  return { db, dir };
}
function gdprSetup(prefix) {
  const { db } = freshDb(prefix);
  const ipcMain = fakeIpcMain();
  const logAudit = (a, d) => db.prepare('INSERT INTO audit_log (user, action, detail, diff) VALUES (?, ?, ?, NULL)')
    .run('Иванка Петрова', a, d || '');
  require(path.join(APP_DIR, 'handlers', 'gdpr'))(ipcMain, { getDb: () => db, run: runDep, logAudit });
  return { db, ipcMain, logAudit };
}
const addReader = (db, name, card) => db.prepare(
  "INSERT INTO readers (name, card_no, status, gdpr_consent) VALUES (?, ?, 'активен', 1)").run(name, card).lastInsertRowid;
const addBook = (db, inv, title) => db.prepare(
  "INSERT INTO books (inv_number, title, category_id, status) VALUES (?, ?, (SELECT id FROM categories LIMIT 1), 'наличен')")
  .run(inv, title).lastInsertRowid;
const auditOf = (db, action) => db.prepare('SELECT detail FROM audit_log WHERE action = ? ORDER BY id').all(action)
  .map(r => r.detail);
const fnBody = (src, name) => {
  /* С отварящата скоба: иначе „dnevnikGroup“ намира първо „dnevnikGroups(“. */
  const at = src.indexOf('function ' + name + '(');
  assert.notEqual(at, -1, 'липсва ' + name);
  let depth = 0, end = src.length;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  return src.slice(at, end);
};

/* ------------------------------------------------------------------ Л1 --- */
test('Л1: заличаването обезличава и „Документът се намери“ (като пази документа), и „Изтрит читател“', () => {
  const { db, ipcMain, logAudit } = gdprSetup('inv-p65-l1-');
  const rid = addReader(db, 'Иван Петров', '777');
  logAudit('Документът се намери', 'инв. № 5 — Тютюн; читател Иван Петров (карта 777); заемане № 3');
  logAudit('Изтрит читател', 'Иван Петров (карта 777) — без история на заемания и движения по сметката');

  const r = ipcMain.invoke('gdpr:forgetReader', { id: rid });
  assert.equal(r.ok, true, r.error);

  const found = auditOf(db, 'Документът се намери');
  assert.equal(found.length, 1);
  assert.ok(!found[0].includes('Иван Петров'), 'името трябва да отпадне: ' + found[0]);
  assert.ok(!found[0].includes('777'), 'и картата: ' + found[0]);
  /* …но документът остава — следата е длъжна да го пази (чл. 17, ал. 2). */
  assert.match(found[0], /инв\. № 5 — Тютюн/, 'инв. № и заглавието трябва да останат: ' + found[0]);

  const deleted = auditOf(db, 'Изтрит читател');
  assert.equal(deleted.length, 1);
  assert.ok(!deleted[0].includes('Иван Петров'), 'редът „Изтрит читател“ трябва да е обезличен: ' + deleted[0]);
});

/* ------------------------------------------------------------------ Л2 --- */
test('Л2: заличаването отказва активните резервации, вместо да ги прехвърли на служебния запис', () => {
  const { db, ipcMain } = gdprSetup('inv-p65-l2-');
  const rid = addReader(db, 'Иван Петров', '777');
  const other = addReader(db, 'Мария Иванова', '800');
  const b = addBook(db, 1, 'Под игото');
  db.prepare("INSERT INTO holds (book_id, reader_id, status) VALUES (?, ?, 'заделена')").run(b, rid);
  db.prepare("INSERT INTO holds (book_id, reader_id, status) VALUES (?, ?, 'чака')").run(b, other);

  const r = ipcMain.invoke('gdpr:forgetReader', { id: rid });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.holdsCancelled, 1, 'броят на отказаните резервации трябва да стигне до екрана');

  /* Служебният запис не държи НИТО ЕДНА активна резервация — иначе заема място
     в опашката пред истинските читатели. */
  const anonActive = db.prepare(`SELECT COUNT(*) AS n FROM holds h JOIN readers r ON r.id = h.reader_id
      WHERE r.name = '— анонимизирани заемания —' AND h.status IN ('чака', 'заделена')`).get().n;
  assert.equal(anonActive, 0, 'активна резервация е прехвърлена на служебния запис');
  /* Резервацията на другия читател не е пипната. */
  assert.equal(db.prepare('SELECT status FROM holds WHERE reader_id = ?').get(other).status, 'чака');
});

/* ------------------------------------------------------------------ Л3 --- */
test('Л3: заличаването на „Иван Петров“ не пипа „Иван Петрова“, нито друг „Иван Петров“ с друга карта', () => {
  const { db, ipcMain, logAudit } = gdprSetup('inv-p65-l3-');
  const rid = addReader(db, 'Иван Петров', '777');
  addReader(db, 'Иван Петрова', '778');
  addReader(db, 'Иван Петров', '999');
  logAudit('Нов читател', 'Иван Петров (карта 777)');
  logAudit('Нов читател', 'Иван Петрова (карта 778)');
  logAudit('Редакция на читател', 'Иван Петрова (карта 778) — телефон');
  logAudit('Нов читател', 'Иван Петров (карта 999)');
  logAudit('Нов читател', 'Иван Петров-Стоянов (карта 555)');
  db.prepare("INSERT INTO search_history (user, kind, query) VALUES ('С', 'читатели', 'Иван Петров')").run();
  db.prepare("INSERT INTO search_history (user, kind, query) VALUES ('С', 'читатели', 'Иван Петрова')").run();

  const r = ipcMain.invoke('gdpr:forgetReader', { id: rid });
  assert.equal(r.ok, true, r.error);

  const rows = db.prepare(`SELECT detail FROM audit_log
      WHERE action IN ('Нов читател', 'Редакция на читател') ORDER BY id`).all().map(x => x.detail);
  assert.equal(rows[0], '[анонимизирано по GDPR]', 'редът на самия читател трябва да е обезличен');
  assert.equal(rows[1], 'Иван Петрова (карта 778)', 'чужд ред (по-дълго име) е обезличен');
  assert.equal(rows[2], 'Иван Петрова (карта 778) — телефон', 'чужд ред (по-дълго име) е обезличен');
  assert.equal(rows[3], 'Иван Петров (карта 999)', 'пълен съименник с ДРУГА карта е обезличен');
  assert.equal(rows[4], 'Иван Петров-Стоянов (карта 555)', 'двойно фамилно име е обезличено');
  assert.equal(r.data.auditCleared, 1, 'броячът трябва да брои само реда на този читател');

  const searches = db.prepare('SELECT query FROM search_history').all().map(x => x.query);
  assert.deepEqual(searches, ['Иван Петрова'], 'търсене на друг човек не бива да отпада');
});

/* ------------------------------------------------------------------ П4 --- */
test('П4: забава, натрупана само в loans.fine (преди v2.4.61), не се води за платена', () => {
  const { unpaidForRows, spreadUnpaidFine } = require(path.join(APP_DIR, 'handlers', 'loans'));
  const { db } = freshDb('inv-p65-p4-');
  const rid = addReader(db, 'Иван Петров', '777');

  /* Случаят от находката: едно отворено просрочено заемане, продължено под
     v2.4.60 — fine = 2,70 в заемането, НИЩО в сметката. */
  const rows = [{ id: 1, reader_id: rid, date_due: '2026-09-01', fineCharged: 2.70, fineNew: 0.40 }];
  spreadUnpaidFine(rows, unpaidForRows(db, rid, rows));
  assert.equal(rows[0].finePaid, 0, 'нищо не е платено — нищо не е и начислявано в сметката');
  assert.equal(rows[0].fine, 3.10, 'дължимото е заварените 2,70 плюс новите 0,40');

  /* Консервативно: ако в сметката вече има начисление за забава, то покрива
     показаното — програмата не измисля дълг, който не може да докаже. */
  const { db: db2 } = freshDb('inv-p65-p4b-');
  const r2 = addReader(db2, 'Мария Иванова', '800');
  db2.prepare(`INSERT INTO account_lines (reader_id, date, kind, type, amount, note)
      VALUES (?, '2026-09-02', 'начисление', 'обезщетение', 2.70, 'Забава')`).run(r2);
  db2.prepare(`INSERT INTO account_lines (reader_id, date, kind, type, amount, note)
      VALUES (?, '2026-09-03', 'плащане', 'плащане', -2.70, 'в брой')`).run(r2);
  const rows2 = [{ id: 2, reader_id: r2, date_due: '2026-09-01', fineCharged: 2.70, fineNew: 0.40 }];
  spreadUnpaidFine(rows2, unpaidForRows(db2, r2, rows2));
  assert.equal(rows2[0].finePaid, 2.70, 'начисленото и платеното в сметката се води платено');
  assert.equal(rows2[0].fine, 0.40, 'остават само новите дни');
});

/* ------------------------------------------------------------------ П7 --- */
test('П7: непрочетено покритие не се обявява за „изтрито по-рано“ и не къса връзката с начислението', () => {
  const src = read('handlers', 'loans.js');
  const at = src.indexOf("ipcMain.handle('loans:found'");
  assert.notEqual(at, -1, 'липсва loans:found');
  const body = src.slice(at, at + 12000);
  /* Провалът при четене се помни отделно от „няма начисление“. */
  assert.match(body, /covErr = err;/, 'провалът при четене трябва да се запомни');
  assert.match(body, /if \(covErr\) \{[\s\S]{0,120}keepChargeLink = true;/,
    'при провал връзката към начислението трябва да остане');
  /* „Изтрито по-рано“ е само когато наистина няма какво да се прочете. */
  assert.match(body, /else if \(!cov\) \{ chargeAction = 'начислението е изтрито от картона по-рано'; \}/,
    '„изтрито по-рано“ не бива да покрива и случая с провалено четене');
  assert.match(body, /lost_account_line_id = CASE WHEN \? THEN lost_account_line_id ELSE NULL END/,
    'UPDATE-ът трябва да пази връзката, когато keepChargeLink е вдигнат');
});

/* ------------------------------------------------------------------ П8 --- */
test('П8: заварен дубликат по регистър („Труд“ и „ТРУД“) остава редактируем, но не може да бъде създаден нов', () => {
  const { db } = freshDb('inv-p65-p8-');
  const ipcMain = fakeIpcMain();
  const logAudit = () => {};
  require(path.join(APP_DIR, 'handlers', 'periodicals'))(ipcMain,
    { getDb: () => db, run: runDep, logAudit, today: () => '2026-09-23' });
  /* Двата картона са създадени, докато NOCASE не сгъваше кирилица — направо в
     базата, покрай днешната проверка. */
  const a = db.prepare("INSERT INTO periodicals (title, freq) VALUES ('Труд', 'ежедневно')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO periodicals (title, freq) VALUES ('ТРУД', 'ежедневно')").run().lastInsertRowid;

  const upd = ipcMain.invoke('periodicals:update', { id: b, title: 'ТРУД', freq: 'седмично' });
  assert.equal(upd.ok, true, 'смяна само на периодичността трябва да мине: ' + upd.error);
  assert.equal(db.prepare('SELECT freq FROM periodicals WHERE id = ?').get(b).freq, 'седмично');

  /* Правилото все пак важи: преименуване В съществуващо заглавие се отказва. */
  const c = db.prepare("INSERT INTO periodicals (title, freq) VALUES ('Стандарт', 'ежедневно')").run().lastInsertRowid;
  const clash = ipcMain.invoke('periodicals:update', { id: c, title: 'труд', freq: 'ежедневно' });
  assert.equal(clash.ok, false, 'преименуване в заглавие, което вече съществува, трябва да се откаже');
  assert.ok(a);
});

/* ------------------------------------------------------------------ С9 --- */
test('С9: провалено преместване на базата оставя в следата коригиращ ред', () => {
  const src = read('handlers', 'db-location.js');
  const at = src.indexOf('fs.copyFileSync(oldPath, stagedPath);');
  assert.notEqual(at, -1, 'липсва копирането');
  const tail = src.slice(at, at + 2500);
  const catchAt = tail.indexOf('} catch (err) {');
  assert.notEqual(catchAt, -1);
  const handler = tail.slice(catchAt, tail.indexOf("return { ok: false", catchAt));
  assert.match(handler, /noteInLiveDb\('Папка на базата данни'/,
    'при провал живата база трябва да получи коригиращ ред — предходният твърди преместване');
  assert.match(handler, /НЕ УСПЯ/, 'коригиращият ред трябва да казва изрично, че опитът е неуспешен');
});

/* ------------------------------------------------------------------ Ч10 -- */
test('Ч10: служебният запис не се брои за „читател без съгласие“', () => {
  const src = read('handlers', 'readers.js');
  /* Правилото се чете от самия файл и се пуска срещу истинска база: така
     тестът проверява точно SQL-а, който програмата ползва. */
  const m = /const ANON_NAME_SQL = [^\n]+\nconst NO_CONSENT_SQL = `([\s\S]*?)`;/.exec(src);
  assert.ok(m, 'правилото NO_CONSENT_SQL трябва да изключва служебния запис');
  const { ANON_READER_NAME } = require(path.join(APP_DIR, 'security-utils'));
  const childCat = (/const CHILD_CATEGORY = '([^']+)'/.exec(src) || [])[1] || 'дете до 14 г.';
  const sql = m[1].replace(/\$\{ANON_NAME_SQL\}/g, ANON_READER_NAME.replace(/'/g, "''"))
    .replace(/\$\{CHILD_CATEGORY\}/g, childCat);

  const { db } = freshDb('inv-p65-c10-');
  addReader(db, 'Иван Петров', '777');   // със съгласие
  db.prepare(`INSERT INTO readers (name, category, status, registered_at, gdpr_consent)
      VALUES (?, '—', 'прекратен', date('now', 'localtime'), 0)`).run(ANON_READER_NAME);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM readers r WHERE ${sql}`).get().n;
  assert.equal(n, 0, 'библиотека, в която всеки истински читател има съгласие, не бива да вижда „1 без съгласие“');

  db.prepare("INSERT INTO readers (name, card_no, status, gdpr_consent) VALUES ('Без Съгласие', '5', 'активен', 0)").run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM readers r WHERE ${sql}`).get().n, 1,
    'истински читател без съгласие трябва да се брои');
});

/* ------------------------------------------------------------------ Д6 --- */
test('Д6: формата „Подробно за деня“ е текстова и отказва „2,7“, вместо да го запише като 0', () => {
  const src = read('src', 'views', 'dnevnik.js');
  const group = fnBody(src, 'dnevnikGroup');
  assert.ok(!/type="number"/.test(group),
    'при type="number" Chromium връща празен низ за „2,7“, а празното се записва като 0');
  assert.match(group, /type="text" inputmode="numeric"/);
  assert.match(group, /data-label=/, 'полето трябва да носи етикета си, за да бъде отказано поименно');

  const save = fnBody(src, 'saveDnevnikDay');
  const guardAt = save.search(/\/\^\\d\+\$\/\.test\(raw\)/);
  const sendAt = save.indexOf('window.api.dnevnik.saveDay');
  assert.notEqual(guardAt, -1, 'записът трябва да проверява, че броят е цяло число');
  assert.ok(guardAt < sendAt, 'проверката трябва да е ПРЕДИ заявката към базата');
  assert.match(save, /Денят НЕ е записан/, 'отказът трябва да казва, че нищо не е записано');
});
