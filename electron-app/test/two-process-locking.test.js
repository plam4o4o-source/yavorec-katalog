/* Одит v2.3.1, ВИСОКА №2: „поправи всичките, анализирай след края" (v2.4.0).
   ============================================================================
   Одитът твърдеше — с два РЕАЛНИ os процеса — че DEFERRED транзакциите в
   handlers/*.js (checkout, extend и т.н.) под истинска надпревара между два
   компютъра водят до сурова „database is locked" грешка вместо да изчакат
   busy_timeout. Тук се ВЪЗПРОИЗВЕЖДА твърдението директно чрез два реални
   child_process процеса, споделящи ЕДИН файл с база данни (симулация на
   мрежов диск — виж isNetwork в main.js), а не се приема на доверие.

   Всяка от следните проверки forkва по един работник (two-process-worker.js),
   който зарежда истинския main.js (заглушен само electron/electron-updater),
   така че транзакциите, busy_timeout и journal_mode са ТОЧНО каквито ще
   изпълнява библиотекарят. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { boot, invokeHandler, closeApp } = require('./helpers/two-process-worker.js');

const WORKER = path.join(__dirname, 'helpers', 'two-process-worker.js');

function makeSharedFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inv-shared-db-'));
}

/* Засява споделената база В ГЛАВНИЯ тестов процес (директно require, без fork),
   после я затваря чисто (db.close()), за да могат следващите два процеса да я
   отворят без грешка "database is locked" при самото отваряне. */
async function seed(dbFolder, { bookQty = 1, readers = 2 } = {}) {
  await boot(dbFolder);
  const bookId = invokeHandler('books:create', { title: 'Под игото', quantity: bookQty }).data;
  const readerIds = [];
  for (let i = 0; i < readers; i++) {
    readerIds.push(invokeHandler('readers:create', { name: 'Читател ' + (i + 1) }).data);
  }
  closeApp();
  return { bookId, readerIds };
}

function spawnWorker(dbFolder) {
  const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const pending = [];
  child.on('message', (msg) => {
    const p = pending.shift();
    if (p) p(msg);
  });
  const send = (msg) => new Promise((resolve) => { pending.push(resolve); child.send(msg); });
  return {
    ready: () => send({ cmd: 'init', dbFolder }),
    invoke: (channel, args) => send({ cmd: 'invoke', channel, args }),
    exit: () => new Promise((resolve) => { child.once('exit', resolve); child.send({ cmd: 'exit' }); })
  };
}

test('два реални процеса, надпревара за ЕДИНСТВЕНАТА свободна бройка: точно един печели, вторият получава ясна грешка, НЕ „database is locked" (15 кръга)', async () => {
  const ROUNDS = 15;
  let doubleCheckouts = 0;
  let rawLockErrors = 0;
  let friendlyRefusals = 0;
  let neitherSucceeded = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const dbFolder = makeSharedFolder();
    const { bookId, readerIds } = await seed(dbFolder, { bookQty: 1, readers: 2 });

    const w1 = spawnWorker(dbFolder);
    const w2 = spawnWorker(dbFolder);
    await Promise.all([w1.ready(), w2.ready()]);

    // Пращаме и двете заявки „едновременно" — без await между тях — точно
    // сценарият на одита: двама души на две гишета натискат бутона в един и
    // същи момент.
    const [r1, r2] = await Promise.all([
      w1.invoke('loans:checkout', { reader_id: readerIds[0], book_id: bookId, date_out: '2026-08-21' }),
      w2.invoke('loans:checkout', { reader_id: readerIds[1], book_id: bookId, date_out: '2026-08-21' })
    ]);
    await Promise.all([w1.exit(), w2.exit()]);
    fs.rmSync(dbFolder, { recursive: true, force: true });

    const results = [r1, r2];
    const oks = results.filter(r => r.ok && r.data && r.data.ok);
    const fails = results.filter(r => !(r.ok && r.data && r.data.ok));

    if (oks.length > 1) doubleCheckouts++;
    if (oks.length === 0) neitherSucceeded++;
    for (const f of fails) {
      // r.ok=false е фатален срив на самия IPC извикване (не би трябвало да е
      // възможен — run() винаги връща {ok:false,...}, а не хвърля навън).
      const msg = f.ok ? String(f.data.error || '') : ('ФАТАЛНО: ' + f.error);
      if (/database is locked/i.test(msg) || /SQLITE_BUSY/.test(msg)) rawLockErrors++;
      else if (/Няма свободни бройки/.test(msg)) friendlyRefusals++;
    }
  }

  assert.equal(doubleCheckouts, 0, 'НИТО ЕДИН кръг не трябва да пусне двама читатели с една бройка');
  assert.equal(neitherSucceeded, 0, 'във всеки кръг точно един от двамата трябва да успее — заетата бройка не бива да остане неизползвана заради грешка при заключване');
  assert.equal(rawLockErrors, 0, '.immediate() транзакциите не трябва да произвеждат сурова "database is locked"/SQLITE_BUSY грешка към губещата станция — busy_timeout трябва да изчака и надпреварата да се разреши предвидимо');
  assert.equal(friendlyRefusals, ROUNDS, 'губещата станция трябва да получи точно съобщението „Няма свободни бройки от тази книга." — не грешка от заключване');
});

test('40 едновременни заемания на РАЗЛИЧНИ книги от 4 работника (по 10 всеки) — нула загубени записи, нула сурови грешки за заключване', async () => {
  const dbFolder = makeSharedFolder();
  await boot(dbFolder);
  const bookIds = [];
  for (let i = 0; i < 40; i++) {
    bookIds.push(invokeHandler('books:create', { title: 'Книга ' + i, quantity: 1 }).data);
  }
  const readerId = invokeHandler('readers:create', { name: 'Многолюден читател' }).data;
  /* Лимитът от документи за читател се вдига ИЗРИЧНО: този тест проверява
     заключването при 40 паралелни записа, а не правилата на обслужването.
     От v2.4.24 loans:checkout спазва max_books наравно с loans:checkoutByCode
     (дотук само вторият го правеше), тоест при подразбиращите се 5 останалите 35
     заемания получават съвсем правилния отказ „Достигнат е лимитът…“ и тестът
     мери него вместо конкуренцията. 0 = без лимит (виж circRule). */
  invokeHandler('settings:update', Object.assign(
    invokeHandler('settings:get').data, { max_books: 0 }));
  closeApp();

  const WORKERS = 4;
  const PER_WORKER = 10;
  const workers = Array.from({ length: WORKERS }, () => spawnWorker(dbFolder));
  await Promise.all(workers.map(w => w.ready()));

  const calls = [];
  for (let i = 0; i < bookIds.length; i++) {
    const w = workers[i % WORKERS];
    calls.push(w.invoke('loans:checkout', { reader_id: readerId, book_id: bookIds[i], date_out: '2026-08-21' })
      .then(r => ({ bookId: bookIds[i], r })));
  }
  const settled = await Promise.all(calls);
  await Promise.all(workers.map(w => w.exit()));

  let succeeded = 0, rawLockErrors = 0, otherErrors = [];
  for (const { bookId, r } of settled) {
    if (r.ok && r.data && r.data.ok) { succeeded++; continue; }
    const msg = r.ok ? String(r.data.error || '') : ('ФАТАЛНО: ' + r.error);
    if (/database is locked/i.test(msg) || /SQLITE_BUSY/.test(msg)) rawLockErrors++;
    else otherErrors.push({ bookId, msg });
  }

  assert.equal(succeeded, 40, 'всичките 40 заемания на РАЗЛИЧНИ книги (без конкуренция помежду им) трябва да успеят — ' + JSON.stringify(otherErrors));
  assert.equal(rawLockErrors, 0, 'нито едно заемане на различна книга не бива да срещне сурова грешка за заключване');

  // Проверка, че НИТО ЕДИН запис не е изгубен — броим редовете в базата директно.
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dbFolder, 'library.db'), { readonly: true });
  const n = db.prepare('SELECT COUNT(*) AS n FROM loans').get().n;
  db.close();
  assert.equal(n, 40, 'в таблицата loans трябва да има точно 40 реда — нито един изгубен запис под натоварване');

  fs.rmSync(dbFolder, { recursive: true, force: true });
});

/* Одит v2.3.1 №22, съчетан с №2: две станции, отваряйки ЕДНА обща (мрежова),
   все още НЕСЪЩЕСТВУВАЩА база данни за пръв път ЕДНОВРЕМЕННО — двете могат
   да прочетат user_version=0, преди която и да е приложила и една миграция
   (виж коментара в main.js runMigrations()). Проверява се директно, с два
   реални процеса, надпреварващи се за самото СЪЗДАВАНЕ + МИГРИРАНЕ на
   базата — не само за запис в нея. ПРОВЕРЕНО директно: върху версията на
   SQLite/better-sqlite3 тук тази надпревара не гърми дори БЕЗ поправките
   (FTS5 мълчаливо толерира повторното INSERT — виж бележката в
   search-fts.test.js) — но зависимостта от точно това недокументирано
   поведение беше самата точка на одита. Тестът остава като гаранция срещу
   регресия, ако бъдеща миграция НЕ е случайно идемпотентна (напр. UPDATE,
   който трупа стойност, а не я задава), а не като възпроизвеждане на срив,
   който реално не се случва тук. */
test('два реални процеса, отварящи ЕДНА все още несъздадена база ЕДНОВРЕМЕННО: никой не гърми, FTS индексът не се дублира (10 кръга)', async () => {
  const ROUNDS = 10;
  for (let round = 0; round < ROUNDS; round++) {
    const dbFolder = makeSharedFolder(); // само папката — файлът library.db НЕ съществува
    const w1 = spawnWorker(dbFolder);
    const w2 = spawnWorker(dbFolder);
    // Без await между двете — точно сценарият „две станции, включени в един момент".
    const [r1, r2] = await Promise.all([w1.ready(), w2.ready()]);
    assert.notEqual(r1.evt, 'fatal', 'първата станция не биваше да гръмне при стартиране: ' + (r1.error || ''));
    assert.notEqual(r2.evt, 'fatal', 'втората станция не биваше да гръмне при стартиране: ' + (r2.error || ''));

    // И двете виждат същата (вече мигрирана) база — books:create в едната
    // трябва да е видимо през books:list в другата, без дублиран FTS ред.
    const created = await w1.invoke('books:create', { title: 'Под игото', quantity: 1 });
    assert.equal(created.ok, true, 'books:create след надпреварата на миграциите трябва да работи: ' + JSON.stringify(created));

    await Promise.all([w1.exit(), w2.exit()]);

    const Database = require('better-sqlite3');
    const db = new Database(path.join(dbFolder, 'library.db'), { readonly: true });
    const userVersion = db.pragma('user_version', { simple: true });
    const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM books_fts').get().n;
    const bookCount = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
    db.close();
    assert.ok(userVersion >= 3, 'миграциите трябва да са приложени докрай (кръг ' + round + ')');
    assert.equal(ftsCount, bookCount, 'books_fts не бива да има дублирани/липсващи редове спрямо books (кръг ' + round + ')');

    fs.rmSync(dbFolder, { recursive: true, force: true });
  }
});
