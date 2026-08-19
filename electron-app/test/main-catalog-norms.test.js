/* Истинският main.js — публичен онлайн каталог и нормативни формули.
   =====================================================================
   ЗАЩО СЪЩЕСТВУВА: до v2.3.0 main.js не се зареждаше от НИТО един тест.
   Мутационен одит вкара четири дефекта точно тук и ВСИЧКИТЕ ЧЕТИРИ минаха
   през цялата поредица със „# pass 647 / # fail 0":
     1) премахнат `WHERE b.status != 'отчислен' AND department != 'служебен'`
        от buildCatalogPayload → отчислени и служебни документи излизат в
        ПУБЛИЧНИЯ онлайн каталог на сайта;
     2) `av: b.available > 0` без проверка на статуса → книга със статус
        „липсващ"/„за реставрация" се обявява за налична онлайн и читателят
        идва специално за нея;
     3) премахната предпазната мярка „не презаписвай непразен публикуван
        каталог с празен" → едно стартиране с празна/тестова база ИЗТРИВА
        публикувания katalog.json;
     4) pctRequired 10%→1% и naturalLoss 10‰→1‰ → нормативните формули по
        Наредба № 3 се променят безнаказано.

   КАК: през test/helpers/main-app.js — истинският main.js със заглушен
   `electron`, истинската схема, истинските миграции и истински регистрирани
   IPC канали. Каталогът се проверява по РЕАЛНО записания katalog.json
   (същия файл, който сайтът чете), а не по вътрешна структура. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startMainApp } = require('./helpers/main-app.js');
const { pctRequired, naturalLoss } = require('./helpers/prod-values.js');

const app = startMainApp();
let db; // истинската база на приложението, отворена от initDb()

test.before(async () => {
  await app.ready();
  db = require('better-sqlite3')(path.join(app.userData, 'library.db'));
  catalogFolder();
});
test.after(() => {
  try { db && db.close(); } catch (e) { /* при спиране няма какво да поправяме */ }
  app.stop();
});

/* Папката за автоматичен запис на каталога — оттук main.js пише katalog.json. */
function catalogFolder() {
  const dir = path.join(app.dir, 'katalog');
  fs.mkdirSync(dir, { recursive: true });
  db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(dir);
  return dir;
}
function katalogFile() { return path.join(catalogFolder(), 'katalog.json'); }

function addBook(row) {
  const b = Object.assign({
    inv_number: null, title: 'Книга', status: 'наличен', department: null,
    author: null, quantity: 1
  }, row);
  const id = db.prepare('INSERT INTO books (inv_number, title, status, department, author) VALUES (?,?,?,?,?)')
    .run(b.inv_number, b.title, b.status, b.department, b.author).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, b.quantity);
  return id;
}
function clearBooks() {
  db.exec('DELETE FROM loans; DELETE FROM inventory; DELETE FROM catalog_shelf_items; DELETE FROM books;');
}
/* catalog:writeNow изпразва отложения запис и пише файла синхронно. */
async function writeCatalog() { return app.invoke('catalog:writeNow'); }
function readKatalog() { return JSON.parse(fs.readFileSync(katalogFile(), 'utf8')); }

/* --- 1) Кой изобщо влиза в публичния каталог --- */

test('публикуват се само неотчислени и неслужебни документи', async () => {
  clearBooks();
  addBook({ inv_number: 1, title: 'Публична книга' });
  addBook({ inv_number: 2, title: 'Отчислена книга', status: 'отчислен' });
  addBook({ inv_number: 3, title: 'Служебна книга', department: 'служебен' });
  addBook({ inv_number: 4, title: 'Отчислена И служебна', status: 'отчислен', department: 'служебен' });

  const res = await writeCatalog();
  assert.equal(res.ok, true, res.error);
  const titles = readKatalog().items.map(i => i.t).sort();
  assert.deepEqual(titles, ['Публична книга'],
    'ОТЧИСЛЕНИ и СЛУЖЕБНИ документи не бива да излизат на сайта — отчисленият вече не е '
    + 'собственост на библиотеката, а служебният фонд не се предлага на читатели');
});

test('витрина не показва документ, който е отпаднал от публикувания каталог', async () => {
  clearBooks();
  const pub = addBook({ inv_number: 11, title: 'Витрина — публична' });
  const gone = addBook({ inv_number: 12, title: 'Витрина — отчислена', status: 'отчислен' });
  const shelfId = db.prepare('INSERT INTO catalog_shelves (name, sort) VALUES (?, 1)').run('Нови книги').lastInsertRowid;
  db.prepare('INSERT INTO catalog_shelf_items (shelf_id, book_id, sort) VALUES (?, ?, 1)').run(shelfId, pub);
  db.prepare('INSERT INTO catalog_shelf_items (shelf_id, book_id, sort) VALUES (?, ?, 2)').run(shelfId, gone);

  assert.equal((await writeCatalog()).ok, true);
  const payload = readKatalog();
  assert.deepEqual(payload.shelves, [{ name: 'Нови книги', items: [11] }],
    'витрината сочи по инв. № — отчислен документ трябва да отпадне мълчаливо, '
    + 'иначе страницата показва празна карта');
});

/* --- 2) Флагът „налична" зависи и от статуса, не само от свободните бройки --- */

test('флагът „налична" (av) отчита статуса, а не само свободните бройки', async () => {
  clearBooks();
  addBook({ inv_number: 21, title: 'Налична', status: 'наличен' });
  addBook({ inv_number: 22, title: 'Липсваща', status: 'липсващ' });
  addBook({ inv_number: 23, title: 'За реставрация', status: 'за реставрация' });
  /* Ред с NULL статус не е достижим през интерфейса (books:create винаги оставя
     „наличен"), а SQL филтърът `status != 'отчислен'` е NULL-безопасен в
     консервативната посока: такъв ред просто НЕ се публикува. Пише се тук, за да
     не се приеме по погрешка, че NULL минава за „наличен" навън. */
  addBook({ inv_number: 24, title: 'Ред от стар внос без статус', status: null });

  assert.equal((await writeCatalog()).ok, true);
  const byInv = Object.fromEntries(readKatalog().items.map(i => [i.inv, i]));
  assert.equal(byInv[21].av, 1);
  assert.equal(byInv[24], undefined, 'ред с NULL статус не се публикува изобщо');
  assert.equal(byInv[22].av, 0,
    'по „липсващ" документ няма отворено заемане, затова свободните бройки са > 0 — '
    + 'но книгата физически я няма и каталогът не бива да я обявява за налична');
  assert.equal(byInv[23].av, 0, 'документ за реставрация не е на рафта');
});

test('заета книга е 0, а върнатата пак става 1 — броенето на бройки не е счупено', async () => {
  clearBooks();
  const id = addBook({ inv_number: 31, title: 'Единствен екземпляр', quantity: 1 });
  const readerId = db.prepare("INSERT INTO readers (name, category) VALUES ('Читател', 'възрастен')").run().lastInsertRowid;
  const loanId = db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(id, readerId, '2026-08-02', '2026-08-16').lastInsertRowid;

  assert.equal((await writeCatalog()).ok, true);
  assert.equal(readKatalog().items.find(i => i.inv === 31).av, 0, 'заетата книга не е налична');

  db.prepare("UPDATE loans SET date_in = '2026-08-10' WHERE id = ?").run(loanId);
  assert.equal((await writeCatalog()).ok, true);
  assert.equal(readKatalog().items.find(i => i.inv === 31).av, 1, 'върнатата книга пак е налична');
});

/* --- 3) Предпазната мярка срещу изтриване на публикуван каталог --- */

test('празен фонд НЕ презаписва вече публикуван непразен katalog.json', async () => {
  clearBooks();
  addBook({ inv_number: 41, title: 'Реален фонд' });
  assert.equal((await writeCatalog()).ok, true);
  const published = fs.readFileSync(katalogFile(), 'utf8');
  assert.equal(JSON.parse(published).items.length, 1);

  // Сега базата е празна — точно случаят „прясна/тестова инсталация, свързана
  // към папката с истинския публикуван каталог".
  clearBooks();
  const res = await writeCatalog();
  assert.equal(res.ok, false, 'записът трябва да бъде СПРЯН, а не мълчаливо изпълнен');
  assert.match(res.error, /празен/i);
  assert.equal(fs.readFileSync(katalogFile(), 'utf8'), published,
    'публикуваният katalog.json трябва да е непокътнат — без тази мярка едно стартиране '
    + 'с празна база изтрива каталога на цялата библиотека от сайта');
});

test('празен фонд върху празен/липсващ публикуван каталог се записва нормално', async () => {
  clearBooks();
  fs.rmSync(katalogFile(), { force: true });
  const res = await writeCatalog();
  assert.equal(res.ok, true, 'мярката пази само НЕПРАЗЕН публикуван файл: ' + res.error);
  assert.deepEqual(readKatalog().items, []);
});

/* --- 4) Нормативните формули по Наредба № 3 --- */

test('pctRequired следва праговете по Наредба № 3 (10% / 5% / 2%)', () => {
  // Стойностите са ЗАКОНОВИ, не са избор на реализацията — затова се твърдят
  // изрично тук, върху функцията, извлечена от самия main.js.
  assert.equal(pctRequired(1), 10);
  assert.equal(pctRequired(50000), 10, 'до 50 000 включително — 10 %');
  assert.equal(pctRequired(50001), 5);
  assert.equal(pctRequired(200000), 5, 'до 200 000 включително — 5 %');
  assert.equal(pctRequired(200001), 2, 'над 200 000 — 2 %');
});

test('naturalLoss следва нормите 10‰ при свободен достъп над 50% и 5‰ иначе', () => {
  assert.equal(naturalLoss(10000, 60), 100, '10 ‰ от 10 000');
  assert.equal(naturalLoss(10000, 51), 100);
  assert.equal(naturalLoss(10000, 50), 50, 'точно 50 % НЕ е „над 50 %" — 5 ‰');
  assert.equal(naturalLoss(10000, 0), 50);
});

test('inventorySessions:requirement връща нормативните числа, а не преписани в теста', async () => {
  clearBooks();
  for (let i = 1; i <= 200; i++) addBook({ inv_number: 1000 + i, title: 'Кн. ' + i });
  db.prepare('UPDATE settings SET free_access_pct = 60 WHERE id = 1').run();

  const res = await app.invoke('inventorySessions:requirement');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.active, 200);
  assert.equal(res.data.pct, 10, 'фонд от 200 документа изисква проверка на 10 %');
  assert.equal(res.data.target, 20, '10 % от 200 = 20 документа');
  assert.equal(res.data.naturalLoss, 2, '10 ‰ от 200 при свободен достъп над 50 %');

  db.prepare('UPDATE settings SET free_access_pct = 20 WHERE id = 1').run();
  const res2 = await app.invoke('inventorySessions:requirement');
  assert.equal(res2.data.naturalLoss, 1, '5 ‰ от 200 при свободен достъп под 50 %');
});

test('dashboard:full ползва същия нормативен процент като инвентаризацията', async () => {
  clearBooks();
  for (let i = 1; i <= 100; i++) addBook({ inv_number: 2000 + i, title: 'Кн. ' + i });
  const res = await app.invoke('dashboard:full');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.fundCount, 100);
  assert.equal(res.data.inventoryPct, 10);
  assert.equal(res.data.inventoryTarget, 10, '10 % от 100 документа');
});
