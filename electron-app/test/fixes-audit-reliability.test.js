'use strict';
/* Одит (v2.4.9) — надеждност: настройките, резервните копия, личните данни и
   атомарността на връщането. Всеки тест пада на кода отпреди поправката.

   main.js се зарежда през test/helpers/main-app.js (истинският файл, със
   заглушен `electron`) — виж коментара там защо не се преписва нищо. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { startMainApp } = require('./helpers/main-app.js');

const app = startMainApp();
test.before(async () => { await app.ready(); });
test.after(() => app.stop());

const configFile = () => path.join(app.userData, 'config.json');

/* ------------------------------------------------------------------
   1. Един неуспешен прочит на config.json не бива да трие пътя до базата.
   ------------------------------------------------------------------ */

test('смяната на служителя запазва dbFolder в config.json', async () => {
  fs.writeFileSync(configFile(), JSON.stringify({ dbFolder: '\\\\server\\biblioteka', lastUserName: 'Мария' }), 'utf8');
  await app.invoke('app:setUser', 'Иван');
  const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  assert.equal(cfg.lastUserName, 'Иван');
  assert.equal(cfg.dbFolder, '\\\\server\\biblioteka', 'пътят до базата трябва да оцелее при смяна на служителя');
});

test('ПОВРЕДЕН config.json НЕ се презаписва с окастрен обект — пътят до базата не се губи', async () => {
  // Точният сценарий от одита: файлът е нечетим/повреден (антивирусна програма,
  // прекъснат запис). Дотук readConfig() връщаше {} при всяка грешка, а
  // app:setUser веднага записваше този празен обект обратно — dbFolder изчезваше
  // завинаги и на следващата сутрин програмата отваряше ПРАЗНА локална база.
  const corrupt = '{"dbFolder":"\\\\\\\\server\\\\biblioteka","lastUse';
  fs.writeFileSync(configFile(), corrupt, 'utf8');
  await app.invoke('app:setUser', 'Петър');
  const after = fs.readFileSync(configFile(), 'utf8');
  assert.equal(after, corrupt, 'повреденият файл трябва да остане непокътнат, а не да бъде презаписан');
  assert.ok(!/^\{\s*"lastUserName"/.test(after), 'файлът не бива да е сведен само до името на служителя');
});

test('повреденият config.json се запазва настрани като config.bad.json за възстановяване', async () => {
  fs.writeFileSync(configFile(), '{ това не е JSON', 'utf8');
  await app.invoke('app:setUser', 'Георги');
  const bad = path.join(app.userData, 'config.bad.json');
  assert.ok(fs.existsSync(bad), 'очаква се копие config.bad.json, за да може пътят да се прочете ръчно');
});

test('config.json се записва атомарно — не остава .tmp файл след успешен запис', async () => {
  fs.writeFileSync(configFile(), JSON.stringify({ dbFolder: 'X' }), 'utf8');
  await app.invoke('app:setUser', 'Анна');
  assert.ok(!fs.existsSync(configFile() + '.tmp'), 'временният файл трябва да е преименуван, не изоставен');
  assert.equal(JSON.parse(fs.readFileSync(configFile(), 'utf8')).dbFolder, 'X');
});

/* ------------------------------------------------------------------
   2. Анонимизирането по GDPR чисти и одитната следа.
   ------------------------------------------------------------------ */

function gdprDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-gdpr-audit-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return { db, dir };
}
function gdprApi(db) {
  const handlers = new Map();
  require('../handlers/gdpr')({ handle: (c, f) => handlers.set(c, f) }, {
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } },
    logAudit: () => {},
    today: () => '2026-08-02'
  });
  return { invoke: (c, ...a) => handlers.get(c)({}, ...a) };
}

/* Одит v2.4.14: датите тук бяха зашити ('2026-05-05', '2026-01-01') при
   anonymize_years = 3, докато прагът се извежда от истинския часовник
   (handlers/gdpr.js: anonCutoff). На 1 януари 2030 г. тези два теста щяха да
   почервенеят сами, без нищо в програмата да се е счупило. Изчисляват се от
   текущата година, както вече прави test/handlers-gdpr.test.js. */
const Y = new Date().getFullYear();
const OLD_TS = (Y - 7) + '-05-05 10:00:00';   // далеч преди прага при 3 години
const NEW_TS = Y + '-05-05 10:00:00';         // тази година — не се пипа

test('анонимизирането обезличава старите записи в одитната следа, но не ги трие', () => {
  const { db, dir } = gdprDb();
  try {
    db.prepare('UPDATE settings SET anonymize_years = 3 WHERE id = 1').run();
    db.prepare("INSERT INTO audit_log (ts, user, action, detail, diff) VALUES (@old,'Мария','Редакция на читател','карта 123 — Иван Петров Иванов','[{\"field\":\"phone\",\"before\":\"0888111222\",\"after\":\"0888333444\"}]')").run({ old: OLD_TS });
    db.prepare("INSERT INTO audit_log (ts, user, action, detail) VALUES (@new,'Мария','Редакция на читател','карта 999 — Скорошен Читател')").run({ new: NEW_TS });
    db.prepare("INSERT INTO audit_log (ts, user, action, detail) VALUES (@old,'Мария','Ново заемане','инв. № 5 — Тютюн')").run({ old: OLD_TS });

    const res = gdprApi(db).invoke('gdpr:anonymize');
    assert.equal(res.ok, true, res.error);

    const rows = db.prepare('SELECT ts, action, detail, diff FROM audit_log ORDER BY id').all();
    assert.equal(rows.length, 3, 'редовете НЕ се трият — одитната следа е документ');
    assert.equal(rows[0].detail, '[анонимизирано по GDPR]', 'старото име трябва да е махнато');
    assert.equal(rows[0].diff, null, 'старият и новият телефон също');
    assert.equal(rows[1].detail, 'карта 999 — Скорошен Читател', 'скорошният запис не се пипа');
    assert.equal(rows[2].detail, 'инв. № 5 — Тютюн', 'действия без лични данни не се пипат');
    assert.ok(res.data.auditCleared >= 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('анонимизирането изтрива старата история на търсенията (тя често съдържа имена)', () => {
  const { db, dir } = gdprDb();
  try {
    db.prepare('UPDATE settings SET anonymize_years = 3 WHERE id = 1').run();
    db.prepare("INSERT INTO search_history (ts, user, kind, query) VALUES (@old,'Мария','readers','Иван Петров')").run({ old: OLD_TS });
    db.prepare("INSERT INTO search_history (ts, user, kind, query) VALUES (@new,'Мария','readers','Скорошно търсене')").run({ new: NEW_TS });
    const res = gdprApi(db).invoke('gdpr:anonymize');
    assert.equal(res.ok, true, res.error);
    const left = db.prepare('SELECT query FROM search_history').all().map(r => r.query);
    assert.deepEqual(left, ['Скорошно търсене']);
    assert.equal(res.data.searchCleared, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('повторно анонимизиране не брои наново вече обезличените редове', () => {
  const { db, dir } = gdprDb();
  try {
    db.prepare('UPDATE settings SET anonymize_years = 3 WHERE id = 1').run();
    db.prepare("INSERT INTO audit_log (ts, user, action, detail) VALUES ('2019-05-05 10:00:00','Мария','Нов читател','карта 1 — Име')").run();
    const api = gdprApi(db);
    assert.equal(api.invoke('gdpr:anonymize').data.auditCleared, 1);
    assert.equal(api.invoke('gdpr:anonymize').data.auditCleared, 0, 'вторият път няма какво да се чисти');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------
   3. Връщането на книга е неделимо.
   ------------------------------------------------------------------ */

test('връщането пише в loans И в events в една транзакция — при провал не остава наполовина', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-return-tx-'));
  try {
    const db = new Database(path.join(dir, 'library.db'));
    db.pragma('foreign_keys = ON');
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values.js');
    const handlers = new Map();
    require('../handlers/loans')({ handle: (c, f) => handlers.set(c, f) }, {
      getDb: () => db,
      run: (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } },
      logAudit: () => {}, today: () => '2026-08-02',
      // Пада НАКРАЯ на поредицата — точно както би паднал запис при спиране на
      // тока или прекъсната мрежа към споделената база.
      logEvent: () => { throw new Error('симулиран провал при вписване на събитието'); },
      BOOK_SELECT, scheduleCatalogWrite: () => {},
      circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 0, suspend_max: 0 }),
      readerCategory: () => 'възрастен', nextWorkDay: (d) => d, closedDaysBetween: () => 0,
      firstActiveHold: () => null, activeHolds: () => [], freeCopies: () => 1,
      consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null, normalizeScanCode
    });
    const bookId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1,'Тютюн','наличен')").run().lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
    const readerId = db.prepare("INSERT INTO readers (name, category) VALUES ('Читател','възрастен')").run().lastInsertRowid;
    const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
      .run(readerId, bookId, '2026-07-01', '2026-07-15').lastInsertRowid;

    const res = handlers.get('loans:return')({}, { id: loanId });
    assert.equal(res.ok, false, 'провалът трябва да се върне като грешка, не да бъде преглътнат');

    const loan = db.prepare('SELECT date_in FROM loans WHERE id = ?').get(loanId);
    assert.equal(loan.date_in, null,
      'заемането НЕ бива да остане затворено, щом събитието не е записано — иначе годишният отчет тихо губи едно заемане');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('успешното връщане записва и заемането, и събитието', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-return-ok-'));
  try {
    const db = new Database(path.join(dir, 'library.db'));
    db.pragma('foreign_keys = ON');
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values.js');
    const handlers = new Map();
    const events = [];
    require('../handlers/loans')({ handle: (c, f) => handlers.set(c, f) }, {
      getDb: () => db,
      run: (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } },
      logAudit: () => {}, today: () => '2026-08-02',
      logEvent: (kind) => events.push(kind),
      BOOK_SELECT, scheduleCatalogWrite: () => {},
      circRule: () => ({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14, suspend_per_day: 0, suspend_max: 0 }),
      readerCategory: () => 'възрастен', nextWorkDay: (d) => d, closedDaysBetween: () => 0,
      firstActiveHold: () => null, activeHolds: () => [], freeCopies: () => 1,
      consumeHoldOnCheckout: () => {}, activateHoldOnReturn: () => null, normalizeScanCode
    });
    const bookId = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1,'Тютюн','наличен')").run().lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
    const readerId = db.prepare("INSERT INTO readers (name, category) VALUES ('Читател','възрастен')").run().lastInsertRowid;
    const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
      .run(readerId, bookId, '2026-07-01', '2026-07-15').lastInsertRowid;

    const res = handlers.get('loans:return')({}, { id: loanId });
    assert.equal(res.ok, true, res.error);
    assert.equal(db.prepare('SELECT date_in FROM loans WHERE id = ?').get(loanId).date_in, '2026-08-02');
    assert.deepEqual(events, ['връщане']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------
   4. Търсенето на читатели за подсказващите полета носи LIMIT.
   ------------------------------------------------------------------ */

test('readers:list с limit връща най-много толкова реда; без limit — всички', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-readers-limit-'));
  try {
    const db = new Database(path.join(dir, 'library.db'));
    db.pragma('foreign_keys = ON');
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    // readers_fts се създава от миграция (search-fts.js), не от schema.sql —
    // ползва се истинският продукционен SQL, не преписан.
    const { ftsQuery, READERS_FTS_SETUP_SQL } = require('../search-fts');
    db.exec(READERS_FTS_SETUP_SQL);
    const handlers = new Map();
    require('../handlers/readers')({ handle: (c, f) => handlers.set(c, f) }, {
      getDb: () => db,
      run: (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } },
      logAudit: () => {}, today: () => '2026-08-02',
      ftsQuery,
      maskReaderRow: (r) => r, maskReaderRows: (rows) => rows,
      preparePiiForWrite: (x) => x, diffFields: () => [], checkRecordLimit: () => {},
      normalizeScanCode: (x) => x
    });
    for (let i = 1; i <= 50; i++) {
      db.prepare('INSERT INTO readers (name, category) VALUES (?, ?)').run('Иванов ' + i, 'възрастен');
    }
    const capped = handlers.get('readers:list')({}, 'Иванов', 20);
    assert.equal(capped.ok, true, capped.error);
    assert.ok(capped.data.length <= 20, 'подсказващото поле не бива да получава всички 50 реда, а получаваше точно това');
    const all = handlers.get('readers:list')({}, 'Иванов');
    assert.equal(all.data.length, 50, 'екранът „Читатели“ трябва да продължи да получава всички съвпадения');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
