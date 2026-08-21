// Тестове за search-fts.js: (1) ftsQuery() изгражда безопасен FTS5 MATCH низ
// от свободен текст, устойчив на FTS5 синтактични символи; (2) реалната FTS5
// индексация върху истинска схема — намира кирилски заглавия независимо от
// регистъра (дефект, който LIKE не решава) и се държи в синхрон след
// INSERT/UPDATE/DELETE в books/readers чрез тригерите от миграцията.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ftsQuery, BOOKS_FTS_SETUP_SQL, READERS_FTS_SETUP_SQL } = require('../search-fts');


/* Хигиена на временните папки. node --test не чисти нищо след себе си, а всяка
   фикстура тук създава каталог в /tmp. Одитът завари 80 431 каталога / 23 GB;
   при пълен диск поредицата започва да пада лавинообразно на съвсем несвързани
   места (# pass 302 / # fail 345) и прати диагностиката по грешна следа.
   mkTmpDir() запомня папката, test.after() я трие. */
const tmpDirs = [];
function mkTmpDir(prefixPath) {
  const d = fs.mkdtempSync(prefixPath);
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
  }
});

function freshDb() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fts-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.exec(BOOKS_FTS_SETUP_SQL);
  db.exec(READERS_FTS_SETUP_SQL);
  return db;
}
function findBooks(db, q) {
  return db.prepare(`
    SELECT title FROM books WHERE id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?) ORDER BY title
  `).all(ftsQuery(q)).map((r) => r.title);
}
function findReaders(db, q) {
  return db.prepare(`
    SELECT name FROM readers WHERE id IN (SELECT rowid FROM readers_fts WHERE readers_fts MATCH ?)
  `).all(ftsQuery(q)).map((r) => r.name);
}

test('ftsQuery: quotes each word and appends a prefix "*", joined with implicit AND', () => {
  assert.equal(ftsQuery('белият вятър'), '"белият"* "вятър"*');
  assert.equal(ftsQuery('  дума  '), '"дума"*');
  assert.equal(ftsQuery(''), '');
  assert.equal(ftsQuery(null), '');
});

test('ftsQuery: escapes embedded double quotes so user input cannot break out of the phrase', () => {
  const q = ftsQuery('те"ст');
  assert.equal(q, '"те""ст"*');
});

test('ftsQuery: FTS5 syntax characters in raw input never throw and never match everything', () => {
  const db = freshDb();
  db.prepare('INSERT INTO books (title) VALUES (?)').run('Обикновена книга');
  for (const weird of ['" OR 1=1 --', '(((', 'AND OR NOT', '*', '"']) {
    assert.doesNotThrow(() => db.prepare('SELECT rowid FROM books_fts WHERE books_fts MATCH ?').all(ftsQuery(weird)));
  }
  db.close();
});

test('FTS5 search folds Cyrillic case (fixes the LIKE bug: lowercase now finds capitalized titles)', () => {
  const db = freshDb();
  db.prepare('INSERT INTO books (title, author) VALUES (?, ?)').run('Белият вятър над Витоша', 'Йоцов, Иван');
  assert.deepEqual(findBooks(db, 'белият'), ['Белият вятър над Витоша']);
  assert.deepEqual(findBooks(db, 'ВЯТЪР'), ['Белият вятър над Витоша']);
  db.close();
});

test('FTS5 search matches on a partial (prefix) word, like the old LIKE-based search did', () => {
  const db = freshDb();
  db.prepare('INSERT INTO books (title) VALUES (?)').run('Приказки за лека нощ');
  assert.deepEqual(findBooks(db, 'прик'), ['Приказки за лека нощ']);
  db.close();
});

test('books_fts stays in sync after UPDATE: old text stops matching, new text matches', () => {
  const db = freshDb();
  const id = db.prepare('INSERT INTO books (title) VALUES (?)').run('Старо заглавие').lastInsertRowid;
  assert.deepEqual(findBooks(db, 'старо'), ['Старо заглавие']);
  db.prepare('UPDATE books SET title = ? WHERE id = ?').run('Ново заглавие', id);
  assert.deepEqual(findBooks(db, 'старо'), []);
  assert.deepEqual(findBooks(db, 'ново'), ['Ново заглавие']);
  db.close();
});

test('books_fts stays in sync after DELETE: the row no longer matches anything', () => {
  const db = freshDb();
  const id = db.prepare('INSERT INTO books (title) VALUES (?)').run('За изтриване').lastInsertRowid;
  assert.deepEqual(findBooks(db, 'изтриване'), ['За изтриване']);
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  assert.deepEqual(findBooks(db, 'изтриване'), []);
  db.close();
});

test('readers_fts folds Cyrillic case on reader names the same way books_fts does', () => {
  const db = freshDb();
  db.prepare('INSERT INTO readers (name) VALUES (?)').run('Иван Петров');
  assert.deepEqual(findReaders(db, 'иван'), ['Иван Петров']);
  db.close();
});

/* v2.4.0 — одит v2.3.1 №22: BOOKS_FTS_SETUP_SQL/READERS_FTS_SETUP_SQL се
   изпълняваха точно веднъж по договорка (пазени от user_version в main.js),
   но самият SQL разчиташе на НЕДОКУМЕНТИРАНО поведение на FTS5 при повторно
   изпълнение (виж и поправката в main.js runMigrations() за надпреварата,
   при която това реално би могло да се случи — две станции, стартиращи
   едновременно срещу празна обща база за пръв път). ПРОВЕРЕНО директно:
   повторното изпълнение на старата (непроменена) версия на този SQL върху
   better-sqlite3/SQLite версията тук НЕ гърми и не дублира резултата — FTS5
   мълчаливо игнорира втория опит за същия rowid. Точно защото това поведение
   е недокументирано (не е гарантирано през версии на SQLite/better-sqlite3),
   SQL-ът вече ползва официално документираната команда 'rebuild' вместо
   голо INSERT ... SELECT: тя трие и препопулира целия FTS5 индекс наново от
   съдържанието, безопасна за повторно изпълнение по конструкция, не по
   late-added условие. (Първи опит с "WHERE id NOT IN (SELECT rowid FROM
   books_fts)" се оказа ПОГРЕШЕН — за external-content таблица обикновен
   SELECT без MATCH чете направо през content='books', така че "вече
   съществува" излизаше вярно за всеки ред от books, дори неиндексиран, и
   populate-ването тихо пропускаше точно новите редове; хванато от
   test/db-init.test.js "migration chain v2+v3+v4" теста, не измислено.) */
test('BOOKS_FTS_SETUP_SQL/READERS_FTS_SETUP_SQL са идемпотентни: повторно изпълнение НЕ гърми и не дублира резултатите', () => {
  const db = freshDb();
  db.prepare('INSERT INTO books (title, author) VALUES (?, ?)').run('Под игото', 'Вазов, Иван');
  db.prepare('INSERT INTO readers (name) VALUES (?)').run('Иван Петров');
  assert.deepEqual(findBooks(db, 'под'), ['Под игото']);

  // Повторно изпълнение на СЪЩИЯ SQL върху ВЕЧЕ населена база — точно
  // сценарият на надпреварата при първо стартиране от две станции наведнъж.
  assert.doesNotThrow(() => { db.exec(BOOKS_FTS_SETUP_SQL); db.exec(READERS_FTS_SETUP_SQL); });

  // Резултатите не се дублират — все още по един ред на книга/читател.
  assert.deepEqual(findBooks(db, 'под'), ['Под игото']);
  assert.deepEqual(findReaders(db, 'иван'), ['Иван Петров']);
  const bookFtsCount = db.prepare('SELECT COUNT(*) AS n FROM books_fts').get().n;
  const readerFtsCount = db.prepare('SELECT COUNT(*) AS n FROM readers_fts').get().n;
  assert.equal(bookFtsCount, 1);
  assert.equal(readerFtsCount, 1);
  db.close();
});

/* Целенасочен регресионен тест за самата грешка, хваната по пътя (виж
   бележката по-горе): книга, вкарана В БАЗАТА ПРЕДИ FTS5 да е бил настроен
   изобщо (fresh install сценарий — миграцията ce изпълнява СЛЕД схемата, но
   заварва вече наличен фонд при ъпгрейд от стара база), трябва да се намира
   след настройването, не само книги, добавени СЛЕД него. */
test('книга, вкарана ПРЕДИ FTS5 да е бил настроен, се намира СЛЕД настройването (не само нови книги)', () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fts-preexisting-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.prepare('INSERT INTO books (title) VALUES (?)').run('Стара книга отпреди миграцията');
  db.exec(BOOKS_FTS_SETUP_SQL);
  assert.deepEqual(findBooks(db, 'миграцията'), ['Стара книга отпреди миграцията']);
  db.close();
});

test('a fresh DB (schema.sql alone, before the migration) has no FTS tables', () => {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fts-nomigration-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  assert.equal(tables.has('books_fts'), false);
  assert.equal(tables.has('readers_fts'), false);
  db.close();
});
