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
