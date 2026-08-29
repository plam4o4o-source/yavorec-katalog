'use strict';
/* Трети кръг — независим преглед намери дефекти в поправките от втория кръг.
   Регресии за всяка от тях. Всеки тест пада на кода отпреди съответната
   поправка и минава след нея. */
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
const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values.js');

/* ------------------------------------------------------------------
   1. Смяната на папката не бива да оставя затворена база при отказан запис.
   ------------------------------------------------------------------ */

test('dbLocation:setFolder НЕ затваря базата, когато настройката не може да се запише', () => {
  const dir = mkdir('inv-dbloc-');
  const target = path.join(dir, 'нова-папка');
  fs.mkdirSync(target);
  const dbPath = path.join(dir, 'library.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE t (x INTEGER)');
  let closed = false;
  /* `pragma` е задължителен в двойника: dbLocation:choose прави
     wal_checkpoint(TRUNCATE) ПРЕДИ да стигне до реда, който този тест проверява.
     Без него извикването гърми още там, връща {ok:false} по съвсем друга причина
     и `closed` остава false — тоест тестът минаваше и на кода ОТПРЕДИ поправката,
     без изобщо да опре до реда на затваряне/записване. */
  const dbProxy = {
    close: () => { closed = true; db.close(); },
    prepare: (...a) => db.prepare(...a),
    pragma: (...a) => db.pragma(...a)
  };

  const handlers = new Map();
  require('../handlers/db-location')({ handle: (c, f) => handlers.set(c, f) }, {
    app: { isPackaged: true, relaunch: () => {}, exit: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [target] }), showMessageBoxSync: () => 0 },
    fs, path,
    getDb: () => dbProxy, setDb: () => {}, getMainWindow: () => ({}),
    run,
    readConfig: () => ({}), writeConfig: () => {},
    // Точният сценарий: config.json е нечетим (антивирусна програма го държи).
    updateConfig: () => false,
    resolveDbDir: () => dir,
    resolveDbPath: () => dbPath
  });
  const res = handlers.get('dbLocation:choose')({}, { mode: 'copy' });
  return Promise.resolve(res).then((r) => {
    assert.equal(r.ok, false, 'отказаният запис трябва да се съобщи');
    assert.equal(closed, false,
      'базата НЕ бива да е затворена: съобщението казва „базата остава на старото място", '
      + 'а рестарт няма — всеки следващ екран щеше да гърми до ръчно спиране на програмата');
  });
});

/* ------------------------------------------------------------------
   2. Отпечатаният акт брои същото като списъка и като КДБФ.
   ------------------------------------------------------------------ */

test('deaccessionActs:get връща бройките, за да може разпечатката да брои документи', () => {
  const { db } = freshDb('inv-act-qty-');
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date) VALUES (1,'2026','2026-06-01')").run().lastInsertRowid;
  db.prepare("INSERT INTO deaccession_items (act_id, inv_number, title, price, quantity) VALUES (?,1,'Тютюн',10,3)").run(actId);
  const acts = api('../handlers/deaccession-acts', {
    getDb: () => db, run, logAudit: () => {}, yearOf: () => '2026',
    BOOK_SELECT, scheduleCatalogWrite: () => {}, flushCatalogWrite: () => ({}), normalizeScanCode, logEvent: () => {}
  });
  const a = acts.invoke('deaccessionActs:get', actId).data;
  assert.equal(a.items[0].quantity, 3,
    'без бройката в отговора разпечатката няма как да брои документи и остава на заглавия');
});

test('списъкът с актове и КДБФ Част № 3 дават едно и също число', () => {
  const { db } = freshDb('inv-act-match-');
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date) VALUES (1,'2026','2026-06-01')").run().lastInsertRowid;
  db.prepare("INSERT INTO deaccession_items (act_id, inv_number, title, price, quantity) VALUES (?,1,'А',10,3)").run(actId);
  db.prepare("INSERT INTO deaccession_items (act_id, inv_number, title, price, quantity) VALUES (?,2,'Б',5,2)").run(actId);
  const acts = api('../handlers/deaccession-acts', {
    getDb: () => db, run, logAudit: () => {}, yearOf: () => '2026',
    BOOK_SELECT, scheduleCatalogWrite: () => {}, flushCatalogWrite: () => ({}), normalizeScanCode, logEvent: () => {}
  });
  const kdbf = api('../handlers/kdbf', { getDb: () => db, run, yearOf: () => '2026' });
  const list = acts.invoke('deaccessionActs:list').data[0];
  const p3 = kdbf.invoke('kdbf:report', '2026').data.part3[0];
  assert.equal(list.item_count, 5, '3 + 2 екземпляра');
  assert.equal(list.item_count, p3.item_count);
  assert.equal(list.item_value, p3.item_value);
  assert.equal(list.item_value, 40, '3×10 + 2×5');
});

/* ------------------------------------------------------------------
   3. КДБФ се връзва между годините и при актове отпреди тази версия.
   ------------------------------------------------------------------ */

test('стар акт без снимка получава бройките при мигриране, за да се върже балансът', () => {
  const { db } = freshDb('inv-backfill-');
  // Документ с 3 екземпляра, отчислен през 2024 с акт отпреди тази версия.
  const bookId = db.prepare("INSERT INTO books (inv_number, title, status, price, register_date, deaccession_date) VALUES (1,'Стара',	'отчислен',10,'2020-01-01','2024-06-01')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 3)').run(bookId);
  const actId = db.prepare("INSERT INTO deaccession_acts (no, year, date) VALUES (1,'2024','2024-06-01')").run().lastInsertRowid;
  db.prepare("INSERT INTO deaccession_items (act_id, book_id, inv_number, title, price) VALUES (?,?,1,'Стара',10)").run(actId, bookId);
  // Втори документ, който остава във фонда.
  const b2 = db.prepare("INSERT INTO books (inv_number, title, status, price, register_date) VALUES (2,'Още тук','наличен',10,'2020-01-01')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 2)').run(b2);

  const kdbf = api('../handlers/kdbf', { getDb: () => db, run, yearOf: () => '2024' });
  const before = kdbf.invoke('kdbf:report', '2024').data;
  const endBefore = before.stockEnd.n;                    // 2 (само вторият документ)
  const startBefore = endBefore - before.acquiredYear.n + before.deaccYear.n;
  assert.equal(startBefore, 3, 'без допълване: 2 − 0 + 1 = 3, а 31.12.2023 е било 5 — разминаване');

  // Точно стъпката, която main.js изпълнява веднъж при стартиране.
  db.prepare(`UPDATE deaccession_items
                 SET quantity = COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = deaccession_items.book_id), 1)
               WHERE quantity IS NULL`).run();

  const after = kdbf.invoke('kdbf:report', '2024').data;
  const startAfter = after.stockEnd.n - after.acquiredYear.n + after.deaccYear.n;
  assert.equal(after.deaccYear.n, 3, 'отчисленото вече е 3 документа, както са били броени във фонда');
  assert.equal(startAfter, 5, 'наличност 01.01.2024 = наличност 31.12.2023 — балансът се връзва');
});

test('main.js допълва бройките само веднъж и не пипа вече попълнените', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /UPDATE deaccession_items[\s\S]{0,300}WHERE quantity IS NULL/,
    'допълването трябва да е ограничено до редовете без снимка');
});

/* ------------------------------------------------------------------
   4. „Изрично 0 бройки" не се снима като 1.
   ------------------------------------------------------------------ */

test('отчисляване на документ с изрично 0 бройки снима 0, а не 1', () => {
  const { db } = freshDb('inv-zero-snap-');
  const bookId = db.prepare("INSERT INTO books (inv_number, title, status, price, register_date) VALUES (1,'Изгубена','наличен',10,'2026-01-01')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 0)').run(bookId);
  const noInv = db.prepare("INSERT INTO books (inv_number, title, status, price, register_date) VALUES (2,'Стар внос','наличен',10,'2026-01-01')").run().lastInsertRowid;

  const acts = api('../handlers/deaccession-acts', {
    getDb: () => db, run, logAudit: () => {}, yearOf: () => '2026',
    BOOK_SELECT, scheduleCatalogWrite: () => {}, flushCatalogWrite: () => ({}), normalizeScanCode, logEvent: () => {}
  });
  const res = acts.invoke('deaccessionActs:create', {
    act: { no: 1, year: '2026', date: '2026-06-01', reason_code: 1, reason_text: 'амортизация' },
    bookIds: [bookId, noInv]
  });
  assert.equal(res.ok, true, res.error);
  const rows = db.prepare('SELECT inv_number, quantity FROM deaccession_items ORDER BY inv_number').all();
  assert.equal(rows[0].quantity, 0,
    'фондът брои този документ за 0; ако актът го снима като 1, отчита се документ, който фондът не е имал');
  assert.equal(rows[1].quantity, 1, 'липсващ ред в inventory значи един физически документ');
});

/* ------------------------------------------------------------------
   5. Двете справки за фонда дават едно и също число.
   ------------------------------------------------------------------ */

test('stats:report и reports:run(fund_breakdown) не се разминават при нулеви бройки', () => {
  const { db } = freshDb('inv-two-reports-');
  const mk = (inv, qty) => {
    const id = db.prepare("INSERT INTO books (inv_number, title, status, price, register_date, language, department) VALUES (?,?,'наличен',10,'2026-02-02','български','заемна')")
      .run(inv, 'Кн ' + inv).lastInsertRowid;
    if (qty !== null) db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?,?)').run(id, qty);
  };
  mk(1, 3); mk(2, 0); mk(3, null);
  const stats = api('../handlers/stats', {
    getDb: () => db, run, yearOf: () => '2026', value: () => 0, dnevnikSumRow: () => ({})
  });
  const a = stats.invoke('stats:report', '2026').data;
  const b = stats.invoke('reports:run', { id: 'fund_breakdown', year: '2026' }).data;
  assert.equal(a.fundCount, 4);
  assert.equal(b.fundCount, a.fundCount, 'двата екрана показват фонда за една и съща година');
  assert.equal(b.fundValue, a.fundValue);
  const sumDep = b.byDepartment.reduce((s, [, n]) => s + n, 0);
  const sumCat = b.byCategory.reduce((s, [, n]) => s + n, 0);
  assert.equal(sumDep, b.fundCount, 'разбивката по отдели трябва да се събира до заглавието си');
  assert.equal(sumCat, b.fundCount, 'и разбивката по вид');
});

/* ------------------------------------------------------------------
   6. Надомното посещение не остава записано, когато събитието се провали.
   ------------------------------------------------------------------ */

test('housebound:addVisit е неделимо — провалено събитие не оставя записано посещение', () => {
  const { db } = freshDb('inv-hb-tx-');
  const readerId = db.prepare("INSERT INTO readers (name, category) VALUES ('Читател','възрастен')").run().lastInsertRowid;
  const hb = api('../handlers/housebound', {
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02',
    logEvent: () => { throw new Error('симулиран провал при вписване на събитието'); }
  });
  const res = hb.invoke('housebound:addVisit', { reader_id: readerId, date: '2026-08-02', note: 'бележка' });
  assert.equal(res.ok, false, 'провалът трябва да се върне като грешка');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housebound_visits').get().n, 0,
    'съобщението казва „операцията е отменена… Опитайте отново" — ако редът остане, всеки нов опит трупа дубликат');
});

test('успешното надомно посещение записва и посещението, и събитието', () => {
  const { db } = freshDb('inv-hb-ok-');
  const readerId = db.prepare("INSERT INTO readers (name, category) VALUES ('Читател','възрастен')").run().lastInsertRowid;
  const events = [];
  const hb = api('../handlers/housebound', {
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02',
    logEvent: (kind) => events.push(kind)
  });
  const res = hb.invoke('housebound:addVisit', { reader_id: readerId, date: '2026-08-02' });
  assert.equal(res.ok, true, res.error);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housebound_visits').get().n, 1);
  assert.deepEqual(events, ['дома']);
});

/* ------------------------------------------------------------------
   7. Витрината отказва документ, който няма да бъде публикуван.
   ------------------------------------------------------------------ */

test('shelves:addBook отказва документ с непопълнен статус, вместо да го приеме мълчаливо', () => {
  const { db } = freshDb('inv-shelf-null-');
  db.prepare("INSERT INTO catalog_shelves (name) VALUES ('Нови книги')").run();
  db.prepare("INSERT INTO books (inv_number, barcode, title, status) VALUES (5,'5','Без статус',NULL)").run();
  const sh = api('../handlers/shelves', {
    getDb: () => db, run, logAudit: () => {}, scheduleCatalogWrite: () => {}, normalizeScanCode: (x) => String(x)
  });
  const res = sh.invoke('shelves:addBook', { shelfId: 1, code: '5' });
  assert.equal(res.ok, false, 'иначе програмата казва „добавена", а витрината на сайта излиза празна');
  assert.match(res.error, /статус/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_shelf_items').get().n, 0);
});

/* ------------------------------------------------------------------
   8. Броячът „Налични" отговаря на етикетите в изнесения файл.
   ------------------------------------------------------------------ */

test('catalog:status „Налични" брои само документи със статус „наличен", както в изнесения файл', () => {
  const { db } = freshDb('inv-avail-');
  const mk = (inv, status) => {
    const id = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (?,?,?)").run(inv, 'Кн ' + inv, status).lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?,1)').run(id);
  };
  mk(1, 'наличен'); mk(2, 'липсващ'); mk(3, 'за реставрация');
  const cat = api('../handlers/catalog', {
    getDb: () => db, run, logAudit: () => {}, dialog: {}, getMainWindow: () => ({}),
    fs, path, execFile: () => {}, BOOK_SELECT, csvCell: (x) => x,
    flushCatalogWrite: () => ({}), buildCatalogPayload: () => ({})
  });
  const st = cat.invoke('catalog:status').data;
  assert.equal(st.available, 1,
    'по „липсващ"/„за реставрация" няма отворено заемане, тоест свободните бройки са > 0 — '
    + 'но каталогът не ги обявява за налични (publicBookFields в main.js)');
});

/* ------------------------------------------------------------------
   9. Обезличаването пази сумите, които не са лични данни.
   ------------------------------------------------------------------ */

test('обезличаването маха името от касовите записи, но запазва сумата', () => {
  const { db } = freshDb('inv-gdpr-money-');
  db.prepare('UPDATE settings SET anonymize_years = 3 WHERE id = 1').run();
  db.prepare("INSERT INTO audit_log (ts, user, action, detail) VALUES ('2019-01-01 09:00:00','М','Начисление','Иван Петров — годишна такса 12.00 лв.')").run();
  db.prepare("INSERT INTO audit_log (ts, user, action, detail) VALUES ('2019-01-02 09:00:00','М','Нов читател','карта 1 — Иван Петров')").run();
  const g = api('../handlers/gdpr', { getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02' });
  assert.equal(g.invoke('gdpr:anonymize').ok, true);
  const rows = db.prepare('SELECT action, detail FROM audit_log ORDER BY id').all();
  assert.equal(rows[0].detail, '[анонимизиран читател] — годишна такса 12.00 лв.',
    'сумата е част от отчетността и не е личен данни — не бива да се трие заедно с името');
  assert.equal(rows[1].detail, '[анонимизирано по GDPR]', 'там целият текст е самоличност');
});

test('повторно обезличаване не пипа вече обработените касови записи', () => {
  const { db } = freshDb('inv-gdpr-money2-');
  db.prepare('UPDATE settings SET anonymize_years = 3 WHERE id = 1').run();
  db.prepare("INSERT INTO audit_log (ts, user, action, detail) VALUES ('2019-01-01 09:00:00','М','Плащане','Иван Петров — 5.00 лв.')").run();
  const g = api('../handlers/gdpr', { getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02' });
  assert.equal(g.invoke('gdpr:anonymize').data.auditCleared, 1);
  assert.equal(g.invoke('gdpr:anonymize').data.auditCleared, 0, 'вторият път няма какво да се чисти');
  assert.equal(db.prepare('SELECT detail FROM audit_log').get().detail, '[анонимизиран читател] — 5.00 лв.');
});

/* ------------------------------------------------------------------
   10. Разшифрованото копие не отива в споделената папка.
   ------------------------------------------------------------------ */

test('прекриптирането пише разшифрования файл във временната папка, не до копията', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'backup.js'), 'utf8');
  const fn = src.slice(src.indexOf('function reencryptOldBackups'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.match(body, /plainTmp = path\.join\(app\.getPath\('temp'\)/,
    'папката с копията обикновено е споделена в мрежата, а този файл съдържа ЕГН и № ЛК на всички читатели');
  assert.ok(!/plainTmp = full \+/.test(body));
});
