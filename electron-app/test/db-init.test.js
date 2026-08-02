// Функционален тест на инициализацията на схемата: нова база данни трябва да
// съдържа всички колони на settings (включително notice_subject/body/sms, чиято
// липса от каноничната схема беше открита при анализа), а PRAGMA user_version
// трябва да отрази CURRENT_SCHEMA_VERSION след първото стартиране.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { BOOKS_FTS_SETUP_SQL, READERS_FTS_SETUP_SQL } = require('../search-fts');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-db-test-'));
  const dbPath = path.join(dir, 'library.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  return db;
}

test('settings table includes notice_subject/notice_body/notice_sms on a fresh DB (schema drift fix)', () => {
  const db = freshDb();
  const cols = new Set(db.prepare('PRAGMA table_info(settings)').all().map(r => r.name));
  for (const c of ['notice_subject', 'notice_body', 'notice_sms', 'sru_endpoint', 'suspend_per_day', 'work_days']) {
    assert.ok(cols.has(c), `settings.${c} missing from canonical schema.sql`);
  }
  db.close();
});

test('settings singleton row exists after fresh init (id=1)', () => {
  const db = freshDb();
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  assert.ok(row, 'expected a settings row with id=1');
  db.close();
});

test('runMigrations-equivalent: PRAGMA user_version can be set and read back', () => {
  const db = freshDb();
  assert.equal(db.pragma('user_version', { simple: true }), 0);
  db.pragma('user_version = 1');
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  db.close();
});

test('foreign_keys enforcement is on and loans capacity trigger exists', () => {
  const db = freshDb();
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  const trg = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_loans_capacity'").get();
  assert.ok(trg, 'expected trg_loans_capacity trigger to exist');
  db.close();
});

// Мигрира db-init.test.js-версия на runMigrations() (main.js не може да се
// require-не директно тук — той е Electron main процес). Проверява точно
// сценария от main.js: schema.sql сам по себе си НЕ декларира pdp_salt/
// pdp_verifier (нарочно, per дизайна "MIGRATIONS е източникът на истина за
// нови промени по схемата отсега нататък") — те трябва да пристигнат само
// през миграцията, независимо дали базата е чисто нова или "стара".
function ensureColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
  for (const [name, ddl] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}
function runMigrationsLike(db, migrations, currentVersion) {
  const from = db.pragma('user_version', { simple: true });
  const pending = migrations.filter(m => m.version > from).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.transaction(() => { m.run(); db.pragma('user_version = ' + m.version); })();
  }
  const finalVersion = pending.length ? pending[pending.length - 1].version : from;
  if (finalVersion < currentVersion) db.pragma('user_version = ' + currentVersion);
}

test('schema.sql alone does NOT declare pdp_salt/pdp_verifier (must come from the migration)', () => {
  const db = freshDb();
  const cols = new Set(db.prepare('PRAGMA table_info(settings)').all().map(r => r.name));
  assert.equal(cols.has('pdp_salt'), false);
  assert.equal(cols.has('pdp_verifier'), false);
  db.close();
});

test('migration v2 adds pdp_salt/pdp_verifier and advances user_version, for both fresh and already-versioned DBs', () => {
  const MIGRATIONS = [
    { version: 2, run: (db) => ensureColumns(db, 'settings', { pdp_salt: 'TEXT', pdp_verifier: 'TEXT' }) }
  ];
  // "Fresh" DB (user_version starts at 0, same as any brand-new install).
  const dbA = freshDb();
  runMigrationsLike(dbA, MIGRATIONS.map(m => ({ version: m.version, run: () => m.run(dbA) })), 2);
  let cols = new Set(dbA.prepare('PRAGMA table_info(settings)').all().map(r => r.name));
  assert.ok(cols.has('pdp_salt') && cols.has('pdp_verifier'));
  assert.equal(dbA.pragma('user_version', { simple: true }), 2);
  dbA.close();

  // "Old" DB already at user_version 1 (simulating a real install that already
  // ran through the Phase 0 migration) — must still pick up v2 correctly and
  // must not lose existing data (a settings row already present).
  const dbB = freshDb();
  dbB.pragma('user_version = 1');
  dbB.prepare("UPDATE settings SET lib_name = 'Читалище Тест' WHERE id = 1").run();
  runMigrationsLike(dbB, MIGRATIONS.map(m => ({ version: m.version, run: () => m.run(dbB) })), 2);
  cols = new Set(dbB.prepare('PRAGMA table_info(settings)').all().map(r => r.name));
  assert.ok(cols.has('pdp_salt') && cols.has('pdp_verifier'));
  assert.equal(dbB.pragma('user_version', { simple: true }), 2);
  assert.equal(dbB.prepare('SELECT lib_name FROM settings WHERE id = 1').get().lib_name, 'Читалище Тест');
  dbB.close();
});

test('migration chain v2+v3 (PII columns + FTS5 search indexes) reaches user_version 3 from scratch', () => {
  const MIGRATIONS = [
    { version: 2, run: (db) => ensureColumns(db, 'settings', { pdp_salt: 'TEXT', pdp_verifier: 'TEXT' }) },
    { version: 3, run: (db) => { db.exec(BOOKS_FTS_SETUP_SQL); db.exec(READERS_FTS_SETUP_SQL); } }
  ];
  const db = freshDb();
  db.prepare('INSERT INTO books (title) VALUES (?)').run('Преди миграцията вече вкаран документ');
  runMigrationsLike(db, MIGRATIONS.map(m => ({ version: m.version, run: () => m.run(db) })), 3);
  assert.equal(db.pragma('user_version', { simple: true }), 3);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  assert.ok(tables.has('books_fts') && tables.has('readers_fts'));
  // Документ, добавен ПРЕДИ миграцията, трябва да е обхванат от еднократното
  // INSERT INTO ... SELECT в BOOKS_FTS_SETUP_SQL, не само бъдещите вмъквания.
  const hit = db.prepare("SELECT rowid FROM books_fts WHERE books_fts MATCH '\"миграцията\"*'").all();
  assert.equal(hit.length, 1);
  db.close();
});
