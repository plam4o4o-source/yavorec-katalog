// Помощни функции и SQL за SQLite FTS5 търсене — извадени в отделен, non-Electron
// модул (по същия принцип като backup-crypto.js/pii-crypto.js), за да са
// тестваеми с node:test без да се вдига Electron.
//
// Защо FTS5, а не просто LIKE '%q%': SQLite-ият LIKE прави сравнение по регистър
// само за ASCII букви — „белият“ НЕ намира „Белият“ (кирилица). FTS5 с
// tokenize='unicode61' токенизира и сгъва регистъра с Unicode-осведомени
// таблици, което решава проблема, и същевременно избягва пълно сканиране на
// таблицата при всяко търсене. Полетата с кодове (баркод, ISBN, инв. №) остават
// на LIKE в извикващия код — те са ASCII цифри (регистърът е без значение) и
// потребителите разчитат на "съдържа навсякъде" претърсване (напр. част от
// баркод), което FTS5 префиксното съвпадение не покрива изцяло.

// Изгражда безопасен FTS5 MATCH низ от свободен потребителски текст: всяка
// дума се кавичи (escape-ва вътрешните кавички) и получава префиксно "*", за
// да работи и при частично въведена дума, както при LIKE. Кавичките правят
// низа безопасен срещу FTS5 синтактични оператори (AND/OR/NOT/скоби/колони и
// т.н.), които иначе биха могли да произведат неочаквана заявка или грешка.
function ftsQuery(raw) {
  const terms = String(raw == null ? '' : raw)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => '"' + t.replace(/"/g, '""') + '"*');
  return terms.join(' ');
}

// SQL за миграция v3: FTS5 "external content" виртуални таблици за books.title/
// subtitle/author и readers.name, синхронизирани чрез тригери (стандартният за
// SQLite шаблон — виж https://sqlite.org/fts5.html#external_content_tables).
// Пазим external-content (без дублиране на данните — books/readers си остават
// единственият източник на истина), а тригерите поддържат FTS индекса винаги
// в синхрон, без да се налага да пипаме books:create/update/delete хендлърите.
// Одит v2.3.1 №22: населяването по-долу разчиташе изцяло на "тази миграция се
// изпълнява точно веднъж" (пазено от user_version в main.js) — недокументирано
// откъм самия SQL. При две станции, стартиращи ЕДНОВРЕМЕННО срещу ПРАЗНА обща
// (мрежова) база за пръв път, и двете могат да прочетат user_version=0 ПРЕДИ
// нито една да завърши миграцията; станцията, която придобие заключването за
// запис втора, ще изпълни този SQL повторно върху вече населена books_fts.
// ВНИМАНИЕ (научено при писане на тази поправка): "WHERE id NOT IN (SELECT
// rowid FROM books_fts)" изглежда логично, но е ПОГРЕШНО за external-content
// FTS5 таблица — обикновен SELECT без MATCH чете directно през content='books'
// (т.е. през самата books, не през действителния FTS индекс), затова "вече
// съществува" излиза вярно за ВСЕКИ ред от books, дори такъв, който никога не
// е бил реално индексиран, и населяването тихо пропуска точно новите редове.
// Хванато от migration chain теста в db-init.test.js (документ, вкаран ПРЕДИ
// миграцията, преставаше да се намира). Верният, официално документиран начин
// (https://sqlite.org/fts5.html#the_rebuild_command) е специалната команда
// 'rebuild': трие целия FTS5 индекс и го препопулира наново от съдържанието —
// безопасна за повторно изпълнение по конструкция, не по late-added условие.
const BOOKS_FTS_SETUP_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
  title, subtitle, author,
  content='books', content_rowid='id', tokenize='unicode61'
);
INSERT INTO books_fts(books_fts) VALUES('rebuild');
CREATE TRIGGER IF NOT EXISTS books_fts_ai AFTER INSERT ON books BEGIN
  INSERT INTO books_fts(rowid, title, subtitle, author) VALUES (new.id, new.title, new.subtitle, new.author);
END;
CREATE TRIGGER IF NOT EXISTS books_fts_ad AFTER DELETE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, subtitle, author) VALUES('delete', old.id, old.title, old.subtitle, old.author);
END;
CREATE TRIGGER IF NOT EXISTS books_fts_au AFTER UPDATE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, subtitle, author) VALUES('delete', old.id, old.title, old.subtitle, old.author);
  INSERT INTO books_fts(rowid, title, subtitle, author) VALUES (new.id, new.title, new.subtitle, new.author);
END;
`;

const READERS_FTS_SETUP_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS readers_fts USING fts5(
  name,
  content='readers', content_rowid='id', tokenize='unicode61'
);
INSERT INTO readers_fts(readers_fts) VALUES('rebuild');
CREATE TRIGGER IF NOT EXISTS readers_fts_ai AFTER INSERT ON readers BEGIN
  INSERT INTO readers_fts(rowid, name) VALUES (new.id, new.name);
END;
CREATE TRIGGER IF NOT EXISTS readers_fts_ad AFTER DELETE ON readers BEGIN
  INSERT INTO readers_fts(readers_fts, rowid, name) VALUES('delete', old.id, old.name);
END;
CREATE TRIGGER IF NOT EXISTS readers_fts_au AFTER UPDATE ON readers BEGIN
  INSERT INTO readers_fts(readers_fts, rowid, name) VALUES('delete', old.id, old.name);
  INSERT INTO readers_fts(rowid, name) VALUES (new.id, new.name);
END;
`;

module.exports = { ftsQuery, BOOKS_FTS_SETUP_SQL, READERS_FTS_SETUP_SQL };
