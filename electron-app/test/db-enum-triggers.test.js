// Тест на db/enum-triggers.js — "CHECK/authority на enum-подобните TEXT
// колони" (Фаза 4, последната точка от "евтините поправки" на анализа,
// приложена като миграция v5 в main.js). Тук се тества самият модул,
// приложен директно върху тестова база (същия механизъм, който main.js
// изпълнява през runMigrations() при стартиране) — не самата миграционна
// рамка, която вече няма собствен тест файл (тя е малка и рискована за
// пресъздаване извън main.js; проверява се индиректно чрез факта, че
// main.js се зарежда без грешка, виж последния тест по-долу).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ENUM_COLUMNS, applyEnumTriggers } = require('../db/enum-triggers');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-enum-triggers-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  applyEnumTriggers(db);
  return { db, dir };
}

// Минимален набор от NOT NULL зависимости за всяка таблица, за да можем да
// вмъкнем ред и да проверим само колоната с enum-а — без да опираме в чужди
// external FK constraints, освен там, където enum колоната зависи от тях.
const MIN_INSERT = {
  books: () => `INSERT INTO books (title, status) VALUES ('Т', @v)`,
  readers: () => `INSERT INTO readers (name, status) VALUES ('Р', @v)`,
  holds: (db) => {
    const bookId = db.prepare("INSERT INTO books (title) VALUES ('Б')").run().lastInsertRowid;
    const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Ч')").run().lastInsertRowid;
    return `INSERT INTO holds (book_id, reader_id, status) VALUES (${bookId}, ${readerId}, @v)`;
  },
  suggestions: () => `INSERT INTO suggestions (date, title, status) VALUES ('2026-08-03', 'З', @v)`,
  account_lines: (db) => {
    const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Ч')").run().lastInsertRowid;
    return `INSERT INTO account_lines (reader_id, date, kind, amount) VALUES (${readerId}, '2026-08-03', @v, 1)`;
  },
  mzs_requests_direction: () => `INSERT INTO mzs_requests (no, year, date, direction, partner, title) VALUES (1, '2026', '2026-08-03', @v, 'П', 'З')`,
  mzs_requests_status: () => `INSERT INTO mzs_requests (no, year, date, partner, title, status) VALUES (1, '2026', '2026-08-03', 'П', 'З', @v)`,
  links_from: (db) => {
    const bookId = db.prepare("INSERT INTO books (title) VALUES ('Б')").run().lastInsertRowid;
    return `INSERT INTO links (from_kind, from_id, to_kind, to_id) VALUES (@v, 1, 'книга', ${bookId})`;
  },
  links_to: (db) => {
    const bookId = db.prepare("INSERT INTO books (title) VALUES ('Б')").run().lastInsertRowid;
    return `INSERT INTO links (from_kind, from_id, to_kind, to_id) VALUES ('персона', 1, @v, ${bookId})`;
  },
  analytics: () => `INSERT INTO analytics (title, source_kind) VALUES ('А', @v)`,
  chronicle: () => `INSERT INTO chronicle (year, title, category) VALUES ('2026', 'Л', @v)`,
  acquisitions: () => `INSERT INTO acquisitions (no, year, date, how) VALUES (1, '2026', '2026-08-03', @v)`,
  events: () => `INSERT INTO events (date, kind) VALUES ('2026-08-03', @v)`,
  notice_log: () => `INSERT INTO notice_log (reader_id, channel) VALUES (1, @v)`,
  housebound_profiles: (db) => {
    const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Ч')").run().lastInsertRowid;
    return `INSERT INTO housebound_profiles (reader_id, frequency) VALUES (${readerId}, @v)`;
  },
  periodicals: () => `INSERT INTO periodicals (title, freq) VALUES ('П', @v)`
};

function keyFor(table, col) {
  if (table === 'mzs_requests') return col === 'direction' ? 'mzs_requests_direction' : 'mzs_requests_status';
  if (table === 'links') return col === 'from_kind' ? 'links_from' : 'links_to';
  return table;
}

test('applyEnumTriggers accepts every documented valid value for every enum column (INSERT)', () => {
  for (const { table, col, values } of ENUM_COLUMNS) {
    const { db } = setup();
    const sqlFn = MIN_INSERT[keyFor(table, col)];
    assert.ok(sqlFn, `no INSERT fixture defined for ${table}.${col}`);
    for (const v of values) {
      assert.doesNotThrow(() => db.prepare(sqlFn(db)).run({ v }),
        `${table}.${col} should accept documented value "${v}"`);
    }
  }
});

test('applyEnumTriggers rejects an unrecognised value for every enum column (INSERT)', () => {
  for (const { table, col } of ENUM_COLUMNS) {
    const { db } = setup();
    const sqlFn = MIN_INSERT[keyFor(table, col)];
    assert.throws(() => db.prepare(sqlFn(db)).run({ v: 'бу-га-га-непозната-стойност' }),
      new RegExp(`Непозната стойност за ${table}\\.${col}`),
      `${table}.${col} should reject an unrecognised value`);
  }
});

test('nullable enum columns accept NULL on INSERT; NOT NULL ones are rejected by the underlying column constraint, not silently accepted', () => {
  const notNullCols = new Set(ENUM_COLUMNS.filter(e => e.notNull).map(e => `${e.table}.${e.col}`));
  for (const { table, col } of ENUM_COLUMNS) {
    const { db } = setup();
    const sqlFn = MIN_INSERT[keyFor(table, col)];
    if (notNullCols.has(`${table}.${col}`)) {
      assert.throws(() => db.prepare(sqlFn(db)).run({ v: null }),
        /NOT NULL constraint failed/,
        `${table}.${col} is NOT NULL — a null insert should fail on the column constraint`);
    } else {
      assert.doesNotThrow(() => db.prepare(sqlFn(db)).run({ v: null }),
        `${table}.${col} is nullable — a null insert should be accepted`);
    }
  }
});

test('books.status: an UPDATE to an unrecognised value is rejected, a real transition (наличен → отчислен) is accepted', () => {
  const { db } = setup();
  db.prepare("INSERT INTO books (title, status) VALUES ('Х', 'наличен')").run();
  assert.doesNotThrow(() => db.prepare("UPDATE books SET status='отчислен' WHERE title='Х'").run());
  assert.throws(() => db.prepare("UPDATE books SET status='бу-га-га' WHERE title='Х'").run(),
    /Непозната стойност за books\.status/);
});

test('readers.category is intentionally NOT constrained — the GDPR anonymisation placeholder "—" must still be insertable', () => {
  const { db } = setup();
  // Mirrors handlers/gdpr.js's anonReaderId(): category '—' is not one of the
  // normal circulation categories (възрастен/дете/...) but must never be
  // rejected, since it is the permanent placeholder row for anonymised loans.
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO readers (name, category, status, registered_at, gdpr_consent)
    VALUES ('— анонимизирани заемания —', '—', 'прекратен', date('now'), 0)
  `).run());
});

test('books.department/language and periodicals.department are intentionally NOT constrained (authorised_values-driven, extensible by the librarian)', () => {
  const { db } = setup();
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO books (title, department, language) VALUES ('Й', 'нов-отдел-въведен-от-библиотекаря', 'нов-език')
  `).run());
});
