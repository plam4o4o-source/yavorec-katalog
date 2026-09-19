'use strict';
/* v2.4.63 — ВНЕСЕНАТА ТАБЛИЦА ОЦЕЛЯВА ПРИ ОБНОВЯВАНЕТО.
   =====================================================================
   Библиотека, която вече е внесла СВОЕТО издание на авторските таблици, не бива
   да го загуби при обновяване до версията, която носи вградена таблица: нейните
   авторски знаци са изчислени по нейните числа и подреждат нейния рафт. Две
   различни издания дават различни числа за една и съща фамилия — тихата подмяна
   значи, че от този ден нататък новите книги застават на друго място от старите
   със същия автор, и никой не разбира защо.

   Тестът е ОТДЕЛЕН файл, защото едно зареждане на main.js на процес значи една
   база (виж test/helpers/main-app.js), а тук базата трябва да е ЗАВАРЕНА: с
   чужда таблица вътре. Проверява се истинското засяване в initDb(), не негов
   препис в теста. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { startMainApp } = require('./helpers/main-app.js');

const APP_DIR = path.join(__dirname, '..');
const { builtinRows } = require(path.join(APP_DIR, 'handlers', 'author-mark')).pure;

/* Заварената база: схемата и СВОЯ таблица за авторски знак. Засяването при
   стартиране проверява точно това — има ли вече редове вътре. */
const OWN = [['ВАЗ', '77'], ['АА', '11'], ['ЯЯ', '99']];
function seedOwnTable(dbPath) {
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  const ins = db.prepare('INSERT OR REPLACE INTO author_table (prefix, mark) VALUES (?, ?)');
  for (const [p, m] of OWN) ins.run(p, m);
  db.close();
}

const app = startMainApp({ seedDb: seedOwnTable });
let db;
test.before(async () => {
  await app.ready();
  db = new Database(path.join(app.userData, 'library.db'));
});
test.after(() => { try { db.close(); } catch (e) { /* няма значение */ } app.stop(); });

test('стартирането НЕ пипа вече внесена таблица', () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM author_table').get().n;
  assert.equal(n, OWN.length,
    'таблицата на библиотеката е презаписана с вградената (' + builtinRows().length + ' реда) — '
    + 'нейните авторски знаци са по нейните числа');
  assert.equal(db.prepare("SELECT mark FROM author_table WHERE prefix = 'ВАЗ'").get().mark, '77',
    'числото на библиотеката трябва да остане каквото е било');
});

test('предложението върви по ВНЕСЕНАТА таблица, а екранът не я представя за вградената', async () => {
  const s = await app.invoke('authorMark:suggest', { author: 'Вазов, Иван' });
  assert.equal(s.ok, true, s.error);
  assert.equal(s.data.num, '77', 'предлага се числото на библиотеката, не вграденото 14');

  const st = await app.invoke('authorMark:status');
  assert.equal(st.data.isBuiltin, false);
  assert.equal(st.data.rows, OWN.length);
  assert.equal(st.data.builtinRows, builtinRows().length,
    'екранът все пак знае, че вградена таблица има — за копчето „Върни вградената“');
});
