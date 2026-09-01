'use strict';
/* Одит v2.4.18 — преглед на поправките от седмия кръг (v2.4.17).
   =====================================================================
   Както във всеки предишен кръг, прегледът на самите поправки намери дефекти в
   тях. Тежките два са от един и същ род: и двата се проявяват в режима с ДВЕ
   работни места към обща мрежова база — изрично поддържан режим, който този
   проект документира на няколко места, — и двата подкопават точно гаранцията,
   която v2.4.17 обяви за установена (уникален номер на официален протокол;
   истинност на обявената срещу изчислената стойност).

   Всеки тест е проверен с мутация: поправката се връща в отделно копие и се
   проверява, че тестът става червен. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
/* Общите опори (freshDb, catalogSetup, buildDom …) са в helpers/audit-fixtures.js
   от одит v2.4.20 — дотук всеки кръг ги копираше дословно. */
const fx = require('./helpers/audit-fixtures');
const { fakeIpcMain, freshDb, runDep } = fx;

const APP_DIR = fx.APP_DIR;
test.after(fx.cleanupTmpDirs);

/* ==================================================================
   1. НОМЕР НА ПРОТОКОЛА ПО ЧЛ. 40 — уникален и при две работни места
   ================================================================== */
function invSetup(prefix) {
  const { db } = freshDb(prefix);
  const ipcMain = fakeIpcMain();
  require('../handlers/inventory-sessions')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {},
    pctRequired: () => 10, naturalLoss: () => 0, normalizeScanCode: (x) => x
  });
  return { db, ipcMain };
}

test('inventorySessions:start отказва втори протокол със същия номер за същата година', async () => {
  /* Дефект в поправката от v2.4.17: номерът се предлагаше с MAX(no)+1, а
     коментарът твърдеше, че „проверката се повтаря в записа“ — такава проверка
     нямаше и нямаше транзакция. schema.sql няма UNIQUE(year, no) (не може да
     го получи наготово — съществуващи бази може да носят дубликати), тоест
     нищо не спираше два ЕДНАКВИ протокола по чл. 40. */
  const { db, ipcMain } = invSetup('inv-v2418-no-');
  assert.equal((await ipcMain.invoke('inventorySessions:start',
    { date: '2026-03-01', scope: 'целият фонд', no: 4, committee1: 'А', committee2: 'Б', committee3: 'В' })).ok, true);
  const dup = await ipcMain.invoke('inventorySessions:start',
    { date: '2026-03-02', scope: 'целият фонд', no: 4, committee1: 'А', committee2: 'Б', committee3: 'В' });
  assert.equal(dup.ok, false, 'вторият протокол № 4/2026 не бива да се запише');
  assert.match(dup.error, /Протокол № 4\/2026 вече съществува/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_sessions WHERE year='2026' AND no=4").get().n, 1);
  // Същият номер за ДРУГА година е напълно законен.
  assert.equal((await ipcMain.invoke('inventorySessions:start',
    { date: '2025-03-01', scope: 'целият фонд', no: 4, committee1: 'А', committee2: 'Б', committee3: 'В' })).ok, true);
});

test('автоматичното номериране продължава да дава следващия свободен номер', async () => {
  /* КОНТРОЛ, не тест на дефекта — и е проверен като такъв: при върната мутация
     (без транзакция и без проверка) този тест ОСТАВА зелен, защото при
     последователно извикване MAX(no)+1 и без проверка дава различни номера.
     Смисълът му е обратният: поправката пренесе избора на номер вътре в
     транзакция и не бива да е счупила обикновеното номериране.
     Истинската надпревара между две станции не е детерминирана в един процес;
     нея пази моделът, проверен в следващия тест (.immediate() — правото на запис
     се взима ПРЕДИ четенето), същият като в acquisitions:create. */
  const { db, ipcMain } = invSetup('inv-v2418-auto-');
  assert.equal((await ipcMain.invoke('inventorySessions:start', { date: '2026-01-05', scope: 'A', committee1: 'А', committee2: 'Б', committee3: 'В' })).ok, true);
  assert.equal(db.prepare("SELECT no FROM inventory_sessions WHERE year='2026'").get().no, 1);
  const second = await ipcMain.invoke('inventorySessions:start', { date: '2026-06-05', scope: 'Б', committee1: 'А', committee2: 'Б', committee3: 'В' });
  assert.equal(second.ok, true);
  const nos = db.prepare("SELECT no FROM inventory_sessions WHERE year='2026' ORDER BY no").all().map(r => r.no);
  assert.deepEqual(nos, [1, 2], 'номерата за една година трябва да са различни');
});

test('номерът и проверката му са в ЕДНА транзакция с право на запис', () => {
  /* Проверката има смисъл само ако между нея и INSERT-а никой не може да се
     вмъкне. Точно това дава .immediate() (заключването за запис се взима ПРЕДИ
     четенето) — същият модел като в acquisitions:create. Тестът пази модела,
     защото самото поведение при истинска надпревара не е детерминирано. */
  const src = fs.readFileSync(path.join(APP_DIR, 'handlers', 'inventory-sessions.js'), 'utf8');
  const start = src.slice(src.indexOf("ipcMain.handle('inventorySessions:start'"), src.indexOf("ipcMain.handle('inventorySessions:get'"));
  assert.match(start, /db\.transaction\(/, 'изборът на номер и записът вървят в транзакция');
  assert.match(start, /tx\.immediate\(\)/, 'транзакцията взима правото на запис предварително');
  assert.ok(start.indexOf('SELECT 1 FROM inventory_sessions WHERE year = ? AND no = ?') > start.indexOf('db.transaction('),
    'проверката за зает номер е ВЪТРЕ в транзакцията');
});

/* ==================================================================
   2. ПАЗАЧ НАПРЕД ПО ВЕРСИЯ НА СХЕМАТА
   ================================================================== */
function startAgainstDb(userVersion) {
  const out = execFileSync(process.execPath,
    [path.join(__dirname, 'helpers', 'newer-schema-worker.js'), String(userVersion)],
    { encoding: 'utf8', timeout: 60000 });
  const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
  return JSON.parse(line);
}

test('по-стара версия отказва да работи с база, мигрирана от по-нова', () => {
  /* Дефект в поправката от v2.4.17: миграция 11 обръща смисъла на
     `acquisitions.sum = 0` — от „полето не е попълнено“ на „обявена нула“. Пазач
     назад имаше (миграциите не се прилагат повторно), пазач НАПРЕД нямаше:
     станция на 2.4.16 отваряше вече мигрираната обща база без нито дума и
     продължаваше да пише 0 за непопълнено поле. Обновената станция после печата
     „Обща стойност по документа: 0.00 лв.“ като ОБЯВЕНА нула върху подписан
     счетоводен документ — точно объркването, което миграцията премахна.
     Проверява се с ИСТИНСКИЯ main.js в отделен процес (виж helpers/
     newer-schema-worker.js). */
  const r = startAgainstDb(99);
  assert.equal(r.exitCode, 1, 'стартирането спира');
  assert.equal(r.dialogs.length, 1, 'библиотекарят вижда точно едно съобщение');
  assert.match(r.dialogs[0].title, /по-стар от базата данни/);
  assert.match(r.dialogs[0].content, /версия на схемата 99/);
  /* Съветите от общия диалог за повредена база са ОПАСНИ тук: базата е здрава и
     по-нова, а възстановяването на копие би изтрило работата на другите станции. */
  assert.match(r.dialogs[0].content, /НЕ възстановявайте резервно копие/);
  assert.match(r.dialogs[0].content, /Обновете InvLib/);
  assert.ok(!/преименувайте library\.db на library-повреден/.test(r.dialogs[0].content),
    'здрава база не бива да бъде наричана повредена');
  // И най-важното: базата не е докосната.
  assert.equal(r.versionAfter, 99, 'версията на схемата остава непроменена');
  assert.equal(r.sumAfter, 0, 'миграция 11 НЕ е пипнала засадения ред');
});

test('позната версия на схемата се отваря и мигрира нормално', () => {
  /* Контролът към предишния тест: пазачът трябва да е тесен. База на версия 10
     (една под текущата) стартира докрай и получава миграция 11 — засаденият
     `sum = 0` става NULL („стойността не е обявена“). */
  const r = startAgainstDb(10);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.dialogs, [], 'нормалното стартиране не показва съобщения за грешка');
  assert.equal(r.versionAfter, 11, 'схемата е обновена до текущата версия');
  assert.equal(r.sumAfter, null, 'миграция 11 е приложена');
});

/* ==================================================================
   3. ИЗНОС — кодираните полета
   ================================================================== */
test('UNIMARC 801 $c е дата в основната форма по ISO 8601 (YYYYMMDD)', async () => {
  /* Полето 801 беше добавено в v2.4.17 именно защото е ЗАДЪЛЖИТЕЛНО и
     валидаторът на приемащата система го търси. Изнасяше се обаче „2026-09-01“,
     а подполето е дата без разделители — тоест точно този валидатор отхвърля
     точно това поле. */
  const { db, exportTo } = fx.catalogSetup('inv-v2418-801-');
  db.prepare("INSERT INTO books (inv_number, title, author, language) VALUES (7, 'Книга', 'Автор', 'български')").run();
  const xml = await exportTo('catalog:exportMarc', 'marc.xml');
  const f801 = xml.slice(xml.indexOf('tag="801"'), xml.indexOf('tag="801"') + 400);
  const c = /code="c">([^<]+)</.exec(f801);
  assert.ok(c, 'полето 801 носи подполе $c');
  assert.match(c[1], /^\d{8}$/, '$c е YYYYMMDD, без тирета: ' + c[1]);
});

test('Dublin Core изнася код на езика, не българското име', async () => {
  /* Същият дефект, който v2.4.17 поправи за UNIMARC 101 $a и пропусна тук:
     dc:language е кодирано поле по препоръката на Dublin Core, а в него влизаше
     „японски“. Приемащата система, която подрежда по код, не може да го
     класифицира. */
  const { db, exportTo } = fx.catalogSetup('inv-v2418-dc-');
  db.prepare("INSERT INTO books (inv_number, title, language) VALUES (1, 'Позната', 'български')").run();
  db.prepare("INSERT INTO books (inv_number, title, language) VALUES (2, 'Непозната', 'японски')").run();
  const xml = await exportTo('catalog:exportDc', 'dc.xml');
  const recs = xml.split('<record>');
  const known = recs.find(r => r.includes('Позната'));
  const unknown = recs.find(r => r.includes('Непозната'));
  assert.match(known, /<dc:language>bul<\/dc:language>/);
  assert.match(unknown, /<dc:language>und<\/dc:language>/, 'непознат език → und, не дословното име');
  assert.ok(!/<dc:language>японски<\/dc:language>/.test(xml), 'името няма работа в кодираното поле');
  // Сведението обаче не се губи — то е единственото, което библиотеката знае.
  assert.match(unknown, /Език по описание: японски/);
});

/* ==================================================================
   4. ЧИТАТЕЛСКИЯТ КАРТОН — вярната причина за скритите данни
   ================================================================== */
test('маскирането казва не само КОИ полета, а и ЗАЩО', () => {
  /* Дефект в поправката от v2.4.17: `pii_masked_fields` каза кои полета са
     скрити, но не и по коя от двете съвсем различни причини — заключена защита
     (оправя се с отключване) или несъвпадащ ключ (отключването НЕ помага). */
  const { db } = freshDb('inv-v2418-pdp-');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  const pii = require('../pii-crypto');
  const ipcMain = fakeIpcMain();
  const ret = require('../handlers/pdp')(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  ipcMain.invoke('pdp:setup', 'редовна-парола-11');
  const key = pii.deriveKey('редовна-парола-11',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
  const foreign = pii.deriveKey('чужда-9999', pii.generateSalt(2));
  const ins = db.prepare('INSERT INTO readers (name, egn, id_card_no) VALUES (?, ?, ?)');
  ins.run('Нечетим', pii.encryptField('7501010001', foreign), pii.encryptField('АА1234567', key));

  // Отключено, но ключът не разчита реда → 'unreadable'.
  const unlocked = ret.maskReaderRows(db.prepare('SELECT * FROM readers').all());
  assert.deepEqual(unlocked[0].pii_masked_fields, ['egn']);
  assert.equal(unlocked[0].pii_masked_reason, 'unreadable');

  // Заключено → 'locked' (нормалното състояние в началото на работния ден).
  ipcMain.invoke('pdp:lock');
  const locked = ret.maskReaderRows(db.prepare('SELECT * FROM readers').all());
  assert.equal(locked[0].pii_masked_reason, 'locked');
  assert.deepEqual(locked[0].pii_masked_fields, ['egn', 'id_card_no']);
});

/* jsdom харнесът е общият от helpers/audit-fixtures.js. */
const buildDom = fx.buildDom;
const settle = fx.settle;
const printed = fx.printed;

test('картонът не праща библиотекаря да отключва, когато отключването не помага', async () => {
  /* Дефект в поправката от v2.4.17: бележката обясняваше ВСЯКО скриване със
     „защитата е заключена в момента. Отключете я … и отпечатайте наново“. При
     несъвпадащ ключ библиотекарят изпълнява указанието, отпечатва пак — и
     получава същия картон. Подписваният документ назовава грешна причина. */
  const dom = buildDom({
    'readers.get': {
      id: 5, name: 'Читател', card_no: 'K-9', egn: 'Защитени данни (ключът не съвпада)',
      pii_masked: true, pii_masked_fields: ['egn'], pii_masked_reason: 'unreadable',
      registered_at: '2026-01-01'
    },
    'loans.byReader': []
  });
  const { window } = dom;
  await settle();
  await window.printReaderCard(5);
  await settle();
  const t = printed(window);
  assert.match(t, /не се разчита с текущата парола/, 'казва истинската причина');
  assert.match(t, /въведена наново/, 'сочи единствения път за поправка');
  assert.ok(!/Отключете я от „Настройки“/.test(t), 'не праща по път, който не води доникъде');
  assert.ok(!/Защитени данни/.test(t), 'вътрешният надпис не отива на подписван документ');
});

test('картонът при заключена защита продължава да сочи отключването', async () => {
  // Контролът: за 'locked' старото (вярно) указание остава.
  const dom = buildDom({
    'readers.get': {
      id: 6, name: 'Читател', card_no: 'K-10', egn: 'Защитени данни',
      pii_masked: true, pii_masked_fields: ['egn'], pii_masked_reason: 'locked',
      registered_at: '2026-01-01'
    },
    'loans.byReader': []
  });
  const { window } = dom;
  await settle();
  await window.printReaderCard(6);
  await settle();
  const t = printed(window);
  assert.match(t, /защитата на личните данни е заключена/);
  assert.match(t, /Отключете я от „Настройки“/);
});

test('сесия без записан обхват не печата „null“ в списъка', async () => {
  /* Дребно, но видимо: клетката „В обхвата“ преизчисляваше същия израз без
     резервата `|| 0` — наследен ред с празен pool_size изписваше „null“. */
  const dom = buildDom({
    'inventorySessions.list': [{ id: 1, no: 1, year: '2026', date: '2026-02-02', scope: 'A',
      pool_size: null, pool_final: null, scanned: 0, missing: 0, closed: 0 }],
    'inventorySessions.requirement': { pct: 10, target: 100, scannedYear: 0, active: 1000, naturalLoss: 2 }
  });
  const { window } = dom;
  await settle();
  await window.renderInvent();
  await settle();
  const t = window.document.querySelector('#view').textContent;
  assert.ok(!/null/.test(t), 'в таблицата не бива да се показва „null“');
});
