// "CHECK/authority на enum-подобните TEXT колони" (Фаза 4, последната точка
// от "евтините поправки" на анализа). Изнесено в отделен модул, за да може
// и main.js (миграция v5), и тестовете да прилагат СЪЩИТЕ тригери върху
// съответната им база данни — по образец на BOOKS_FTS_SETUP_SQL/
// READERS_FTS_SETUP_SQL в search-fts.js.
//
// Истински SQLite CHECK constraint не може да се добави с ALTER TABLE към
// съществуваща таблица — изисква пълно пресъздаване (нова таблица +
// копиране на данните + DROP + RENAME), което е рисковано върху вече
// работеща база с непозната „мръсна" история (същата причина, поради която
// миграция v4 нарочно НЕ сложи UNIQUE на books.barcode). Затова тук — по
// образец на вече съществуващия trg_loans_capacity в db/schema.sql —
// единствено BEFORE INSERT/UPDATE тригери, които ограничават само БЪДЕЩИ
// записи; нищо съществуващо не се пипа и не може да счупи миграцията.
//
// Всеки списък стойности е извлечен от истинския избор в интерфейса
// (действителният избор на потребителя — src/views/books.js, src/views/
// chronicle.js и т.н., след разбиването на бившия src/app.js по домейни),
// НЕ от коментарите в db/schema.sql — двете вече се бяха разминали на две
// места: books.status в коментара нямаше „отчислен" (задава се от
// handlers/deaccession-acts.js), а chronicle.category в коментара нямаше
// „юбилей" (CHR_CATS в src/views/chronicle.js).
//
// Нарочно ИЗКЛЮЧЕНИ (не са рутинен fixed enum): readers.category (обвързана
// с редактируемата от библиотекаря circulation_rules.category — при това
// handlers/gdpr.js пише буквално „—" за анонимизирания служебен читател),
// books.department/language и periodicals.department (управляват се от
// authorised_values, разширяема от библиотекаря номенклатура, не fixed
// списък), inventory_sessions.scope (обикновено текстово поле с само
// предварително попълнена стойност, не select).
const ENUM_COLUMNS = [
  { table: 'books', col: 'status', values: ['наличен', 'липсващ', 'за реставрация', 'отчислен'] },
  { table: 'readers', col: 'status', values: ['активен', 'прекратен'] },
  { table: 'holds', col: 'status', values: ['чака', 'заделена', 'изпълнена', 'отказана'] },
  { table: 'suggestions', col: 'status', values: ['заявено', 'одобрено', 'поръчано', 'получено', 'отказано'] },
  { table: 'account_lines', col: 'kind', values: ['начисление', 'плащане'], notNull: true },
  { table: 'mzs_requests', col: 'direction', values: ['изходящо', 'входящо'], notNull: true },
  { table: 'mzs_requests', col: 'status', values: ['заявено', 'изпратено', 'получено', 'върнато', 'отказано'] },
  { table: 'links', col: 'from_kind', values: ['персона', 'летопис'], notNull: true },
  { table: 'links', col: 'to_kind', values: ['книга', 'статия', 'летопис', 'персона', 'периодика'], notNull: true },
  { table: 'analytics', col: 'source_kind', values: ['периодика', 'книга', 'друго'] },
  { table: 'chronicle', col: 'category', values: ['читалище', 'библиотека', 'самодейност', 'дарение', 'строителство', 'юбилей', 'друго'] },
  { table: 'acquisitions', col: 'how', values: ['закупуване', 'депозит', 'обмен', 'дарение'] },
  { table: 'events', col: 'kind', values: ['заемане', 'връщане', 'подновяване', 'читалня', 'дома'], notNull: true },
  { table: 'notice_log', col: 'channel', values: ['имейл', 'печат', 'копиране', 'SMS'] },
  { table: 'housebound_profiles', col: 'frequency', values: ['седмично', 'двуседмично', 'месечно'] },
  { table: 'periodicals', col: 'freq', values: ['седмично', 'двуседмично', 'месечно', 'тримесечно', 'полугодишно', 'годишно', 'нередовно'] }
];

function buildSql() {
  let sql = '';
  for (const { table, col, values, notNull } of ENUM_COLUMNS) {
    const list = values.map(v => `'${v}'`).join(',');
    const guard = notNull ? `NEW.${col} NOT IN (${list})` : `NEW.${col} IS NOT NULL AND NEW.${col} NOT IN (${list})`;
    sql += `CREATE TRIGGER IF NOT EXISTS trg_${table}_${col}_ins BEFORE INSERT ON ${table}
      WHEN ${guard} BEGIN SELECT RAISE(ABORT, 'Непозната стойност за ${table}.${col}.'); END;\n`;
    sql += `CREATE TRIGGER IF NOT EXISTS trg_${table}_${col}_upd BEFORE UPDATE OF ${col} ON ${table}
      WHEN ${guard} BEGIN SELECT RAISE(ABORT, 'Непозната стойност за ${table}.${col}.'); END;\n`;
  }
  return sql;
}

function applyEnumTriggers(db) {
  db.exec(buildSql());
}

module.exports = { ENUM_COLUMNS, applyEnumTriggers };
