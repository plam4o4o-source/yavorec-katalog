'use strict';
/* Одитен кръг v2.4.56 — РЕЗЕРВНИТЕ КОПИЯ И ВЪЗСТАНОВЯВАНЕТО.
 * =====================================================================
 * Кръгът разгледа единственото нещо, което стои между библиотеката и загубата
 * на целия ѝ фонд от данни, и намери четири тихи дупки наведнъж:
 *
 *  1) КОПИЕ СЕ ПРАВЕШЕ САМО ПРИ СТАРТИРАНЕ. Компютърът в читалището стои
 *     включен със седмици — а точно в него се въвеждат новите постъпления.
 *     Тоест цяла седмица работа висеше на един файл отпреди седем дни. Сега има
 *     и копие по таймер (на 3 часа) и копие при затваряне, но само когато базата
 *     наистина е променяна: иначе компютър, оставен включен през уикенда, би
 *     трупал еднакви файлове.
 *  2) НИКОЙ НЕ ПРОВЕРЯВАШЕ ЗАПИСАНОТО. В целия код нямаше нито едно
 *     integrity_check: програмата записваше копие и обявяваше успех, без да е
 *     погледнала какво е записала. Прекъснат запис по мрежов дял дава файл с
 *     правилно име и правдоподобен размер, който се чупи чак в деня, в който
 *     потрябва — обикновено точно когато базата вече е загубена.
 *  3) ПРОВАЛЪТ НА САМОТО ПИСАНЕ отиваше в console.error, тоест в нищото.
 *     Картата в „Настройки“ говореше само за криптиране и показваше спокойно
 *     „🔒“, докато нов файл не се е появявал с дни.
 *  4) ПАЗЕНЕТО БЕШЕ „последните 30 дни“ — а сгрешено групово отчисляване или
 *     объркан внос излизат наяве при годишната инвентаризация, тоест месеци
 *     по-късно. Оттук нататък: всекидневни за месец, седмични за три месеца,
 *     месечни за две години.
 *
 * И петото, което не е в самия модул: преместването на базата пренасяше само
 * library.db, а папката backups/ оставаше до старото място — мълчаливо. Точно в
 * случая, за който смяната на папката е измислена (нов компютър, старият се
 * изхвърля), това е изтрита история на копията.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  APP_DIR, freshDb, mkTmpDir, fakeIpcMain, runDep, cleanupTmpDirs, currentSchemaVersion
} = require('./helpers/audit-fixtures');

const registerBackupHandlers = require(path.join(APP_DIR, 'handlers', 'backup'));
const registerDbLocationHandlers = require(path.join(APP_DIR, 'handlers', 'db-location'));
const MAIN_SRC = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');

test.after(cleanupTmpDirs);

const DAY = 86400000;
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const iso = (d) => d.toISOString().slice(0, 10);

/* Истинският handlers/backup.js върху истинска база. `fsHooks` подменя само
   отделни функции на fs — така се пресъздава онова, което тестът не може да
   направи наистина: прекъснат запис по мрежов дял. Всичко останало минава през
   истинския файлов достъп, защото проверяваното е точно поведението на диска. */
function setup(opts) {
  const o = opts || {};
  const { db: realDb, dir } = freshDb('inv-kopiya-v2456-');
  realDb.prepare("UPDATE settings SET lib_name = 'НЧ Тест' WHERE id = 1").run();
  realDb.prepare('INSERT INTO books (inv_number, title, register_date) VALUES (1, ?, ?)')
    .run('Книга за копието', '2026-01-05');
  let db = realDb;
  const dbPath = path.join(dir, 'library.db');

  const fsView = Object.assign({}, fs, o.fsHooks || {});
  const audit = [];
  const sentToWindow = [];
  const appCalls = { relaunch: 0, exit: [] };
  const tempDir = mkTmpDir('inv-kopiya-temp-');
  const app = {
    getPath: (name) => (name === 'temp' ? tempDir : dir),
    relaunch: () => { appCalls.relaunch++; },
    exit: (code) => { appCalls.exit.push(code); }
  };
  let config = Object.assign({}, o.config || {});
  const ipcMain = fakeIpcMain();
  const deps = {
    app, fs: fsView, path,
    dialog: o.dialog || { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getDb: () => db, setDb: (v) => { db = v; },
    getMainWindow: () => ({ webContents: { send: (ch, data) => sentToWindow.push({ ch, data }) }, isDestroyed: () => false }),
    run: runDep,
    logAudit: (action, detail) => audit.push({ action, detail }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath,
    readConfig: () => config,
    updateConfig: (mutate) => { mutate(config); return true; },
    currentSchemaVersion: o.schemaVersion !== undefined ? o.schemaVersion : currentSchemaVersion()
  };
  const handlers = registerBackupHandlers(ipcMain, deps);
  const backupsDir = path.join(dir, 'backups');
  return {
    dir, dbPath, backupsDir, ipcMain, handlers, audit, sentToWindow, appCalls,
    getDb: () => db, touchDb: () => {
      db.prepare("INSERT INTO books (inv_number, title, register_date) VALUES ((SELECT MAX(inv_number)+1 FROM books), 'Нова', '2026-02-02')").run();
      // Часовникът на файловата система има зърнистост — времето се избутва
      // изрично напред, за да е сравнението „базата е по-нова от копието“ факт,
      // а не въпрос на късмет при бърз тест.
      const t = (Date.now() + 5000) / 1000;
      fs.utimesSync(dbPath, t, t);
    }
  };
}
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };
const names = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return []; } };

/* ==================================================================
   1. КОПИЕ МЕЖДУ СТАРТИРАНИЯТА — САМО ПРИ ПРОМЕНЕНА БАЗА
   ================================================================== */

test('копие при затваряне се прави, когато базата е променяна, и НЕ се прави, когато не е', () => {
  /* Работният ден на библиотекаря завършва с хиксчето, а дотук следващото копие
     идваше чак при следващото пускане: повреда през нощта означаваше изгубена
     цялата днешна работа. Обратната крайност е също толкова лоша — компютър,
     оставен включен през уикенда, не бива да трупа еднакви файлове в мрежовата
     папка. Затова условието е „базата наистина е пипана след последното копие“. */
  const t = setup();
  t.handlers.autoBackupIfNeeded();
  const daily = path.join(t.backupsDir, 'auto-' + todayStr() + '.db');
  assert.ok(fs.existsSync(daily), 'дневното копие се прави при стартиране, както досега');
  const after = names(t.backupsDir);

  assert.equal(t.handlers.backupBeforeQuit(), false, 'без промяна в базата ново копие не се прави');
  assert.deepEqual(names(t.backupsDir), after, 'и в папката не се появява нищо');

  t.touchDb();
  assert.equal(t.handlers.backupBeforeQuit(), true, 'след работа в базата — копие при затваряне');
  const added = names(t.backupsDir).filter(n => !after.includes(n));
  assert.equal(added.length, 1, 'точно едно ново копие');
  assert.match(added[0], /^auto-\d{4}-\d{2}-\d{2}-\d{4}\.db$/,
    'междинното копие носи час в името си — иначе би минало за дневното и би било прекриптирано или прескочено');
  // И то е истинска база, а не половин файл.
  assert.equal(t.handlers.checkDbFile(path.join(t.backupsDir, added[0])), null,
    'междинното копие е проверено и здраво');
});

test('таймерът се пуска и спира, а при затваряне се прави последното копие за деня', () => {
  /* Механизмът е безполезен, ако main.js не го включи: три часа е изборът, но
     решението „изобщо да има таймер“ живее в свързването. Спирането е също
     толкова важно — иначе таймерът държи процеса жив след затварянето. */
  const t = setup();
  assert.equal(typeof t.handlers.startAutoBackupTimer, 'function');
  assert.equal(typeof t.handlers.stopAutoBackupTimer, 'function');
  t.handlers.startAutoBackupTimer();
  t.handlers.startAutoBackupTimer(); // втори път не бива да пуска втори таймер
  t.handlers.stopAutoBackupTimer();  // и спирането не бива да гърми
  assert.match(MAIN_SRC, /startAutoBackupTimer\(\);/, 'main.js пуска таймера при стартиране');
  assert.match(MAIN_SRC, /stopAutoBackupTimer\(\);/, 'и го спира при затваряне');
  assert.match(MAIN_SRC, /backupBeforeQuit\(\);/, 'и прави последното копие за деня');
});

/* ==================================================================
   2. ЗАПИСАНОТО СЕ ПРОВЕРЯВА
   ================================================================== */

test('некриптираното копие се пише настрани и се преименува чак след проверката', () => {
  /* Дотук НЕкриптираното копие се пишеше право върху крайното име, докато
     криптираното минаваше през .tmp → проверка → преименуване. Разликата е
     важна за библиотекаря: спиране на тока или изваден USB насред записа
     оставяха отрязан .db файл с правилното име и правдоподобен размер — в
     списъка „Резервни копия“ той изглежда напълно нормален и си личи чак в деня,
     в който се възстановява. */
  const writes = [], renames = [];
  const t = setup({
    fsHooks: {
      writeFileSync: (p, data, ...rest) => { writes.push(String(p)); return fs.writeFileSync(p, data, ...rest); },
      renameSync: (a, b) => { renames.push([String(a), String(b)]); return fs.renameSync(a, b); }
    }
  });
  t.handlers.autoBackupIfNeeded();
  const daily = path.join(t.backupsDir, 'auto-' + todayStr() + '.db');

  assert.ok(writes.includes(daily + '.tmp'), 'снимката каца във временен файл до целта');
  assert.ok(!writes.includes(daily), 'крайното име НИКОГА не се пише направо');
  assert.deepEqual(renames.filter(r => r[1] === daily), [[daily + '.tmp', daily]],
    'крайният файл се появява с преименуване — операция на същото устройство, тоест атомарна');
  assert.ok(fs.existsSync(daily));
  assert.ok(!fs.existsSync(daily + '.tmp'), 'временният файл не остава в папката');
});

test('копие, което не мине проверката, НЕ се появява в папката и провалът се вписва', () => {
  /* Тук се пресъздава прекъснат запис: файлът има правилното заглавие на SQLite
     и правдоподобен размер, но е отрязан. Дотук точно такъв файл минаваше за
     здраво копие. Сега integrity_check го хваща ПРЕДИ преименуването, тоест
     предишното копие остава непокътнато, а библиотекарят научава веднага. */
  const t = setup({
    fsHooks: {
      writeFileSync: (p, data, ...rest) => {
        const cut = (String(p).endsWith('.tmp') && Buffer.isBuffer(data)) ? data.subarray(0, 200) : data;
        return fs.writeFileSync(p, cut, ...rest);
      }
    }
  });
  t.handlers.autoBackupIfNeeded();
  const daily = path.join(t.backupsDir, 'auto-' + todayStr() + '.db');
  assert.ok(!fs.existsSync(daily), 'отрязаният файл НЕ става днешното копие');
  assert.ok(!fs.existsSync(daily + '.tmp'), 'и не остава като огризка');

  const warn = t.audit.filter(a => /ВНИМАНИЕ/.test(a.detail));
  assert.ok(warn.length >= 1, 'провалът стига до одитната следа, а не до console.error');
  assert.match(warn[warn.length - 1].detail, /НЕ беше направено/);

  const st = ok(t.ipcMain.invoke('backup:autoStatus'), 'състояние');
  assert.equal(st.lastAttempt.ok, false, '„Настройки“ показва, че последният опит се е провалил');
  assert.equal(st.lastAttempt.kind, 'write', 'и че се е провалило самото ПИСАНЕ, не криптирането');
  assert.equal(st.failure, null,
    'провалът на писането нарочно не се представя като „копието е в чист текст“ — това са две различни беди');
  assert.equal(st.newest, null, 'няма нито едно копие');
  assert.equal(st.stale, true, 'и това се казва на глас');
  // И прозорецът получава известие — картата в „Настройки“ не чака отваряне.
  assert.ok(t.sentToWindow.some(m => m.ch === 'backup:autoStatusChanged' && m.data.level === 'err'));
});

test('проверката на файл с база разпознава здравия, чуждия и повредения', () => {
  /* Същата функция пази и възстановяването (виж по-долу). Съобщенията са на
     български и казват какво е станало: „файлът не е база данни на SQLite“ е
     нещо съвсем различно от „файлът е повреден“ и води до различно действие. */
  const t = setup();
  assert.equal(t.handlers.checkDbFile(t.dbPath), null, 'живата база е здрава');

  const foreign = path.join(t.dir, 'snimka.jpg');
  fs.writeFileSync(foreign, Buffer.from('това изобщо не е база данни'));
  assert.match(t.handlers.checkDbFile(foreign), /не е база данни на SQLite/);

  const truncated = path.join(t.dir, 'otryazana.db');
  fs.writeFileSync(truncated, fs.readFileSync(t.dbPath).subarray(0, 300));
  assert.ok(t.handlers.checkDbFile(truncated), 'отрязаната база се разпознава като проблем');

  assert.match(t.handlers.checkDbFile(path.join(t.dir, 'няма-такъв.db')), /не съществува/);
});

/* ==================================================================
   3. ВЪЗРАСТТА НА НАЙ-НОВОТО КОПИЕ
   ================================================================== */

test('„Настройки“ казват на колко дни е най-новото копие и кога то вече не върши работа', () => {
  /* Дотук картата отговаряше само на въпроса „криптират ли се копията“ и мълчеше
     по далеч по-важния: „ИМА ЛИ изобщо скорошно копие“. Компютър, нерестартиран
     от вторник, или папка, в която нищо не се е записало заради пълен диск,
     изглеждаха съвършено наред. Прагът е два дни: библиотеката работи и събота,
     тоест копие отпреди повече от два дни значи пропуснат работен ден. */
  const t = setup();
  t.handlers.autoBackupIfNeeded();
  const fresh = ok(t.ipcMain.invoke('backup:autoStatus'), 'състояние');
  assert.ok(fresh.newest, 'най-новото копие се намира');
  assert.ok(fresh.ageDays < 1);
  assert.equal(fresh.stale, false);

  // Същото копие, но отпреди пет дни.
  const daily = path.join(t.backupsDir, 'auto-' + todayStr() + '.db');
  const old = (Date.now() - 5 * DAY) / 1000;
  fs.utimesSync(daily, old, old);
  const stale = ok(t.ipcMain.invoke('backup:autoStatus'), 'състояние');
  assert.ok(stale.ageDays > 4.5 && stale.ageDays < 5.5, 'възрастта се смята в дни: ' + stale.ageDays);
  assert.equal(stale.stale, true, 'пет дни без копие е пропуснат работен ден');
  // Правилото за пазене се връща на изгледа, вместо да е преписано там.
  assert.deepEqual(stale.keepPolicy, { dailyDays: 30, weeklyDays: 90, monthlyDays: 730 });
});

/* ==================================================================
   4. ВЪЗСТАНОВЯВАНЕТО ОТКАЗВА ОПАСНИТЕ ФАЙЛОВЕ
   ================================================================== */

test('възстановяване от файл, който не е база данни, се отказва и базата не се пипа', () => {
  /* Проверките стават ПРЕДИ да се докосне какъвто и да е файл. Дотук такъв файл
     подменяше library.db и програмата спираше да тръгва — а екранът, откъдето се
     възстановява, живее ВЪТРЕ в програмата, тоест изходът се затваря заедно с нея. */
  const t = setup();
  fs.mkdirSync(t.backupsDir, { recursive: true });
  const bad = path.join(t.backupsDir, 'auto-2026-01-01.db');
  fs.writeFileSync(bad, Buffer.from('PK това е zip, не база'));
  const before = fs.readFileSync(t.dbPath);

  const res = t.ipcMain.invoke('backup:restoreFromList', { path: bad, password: '' });
  assert.equal(res.ok, false);
  assert.match(res.error, /не може да бъде възстановен/);
  assert.match(res.error, /не е база данни на SQLite/);
  assert.deepEqual(fs.readFileSync(t.dbPath), before, 'активната база е непокътната');
  assert.equal(t.appCalls.exit.length, 0, 'програмата не се рестартира');
  assert.ok(t.getDb(), 'връзката към базата остава отворена');
});

test('копие от ПО-НОВА версия на програмата се отказва, вместо да спре програмата след рестарта', () => {
  /* Копие от другото работно място, което вече е обновено, се отваря без грешка —
     но веднага след рестарта пазачът за схемата спира програмата, и то ВЕЧЕ
     върху подменената база: библиотекарят остава и без старите данни, и без
     работеща програма. По-добре отказ сега, докато всичко е на място. */
  const known = currentSchemaVersion();
  const t = setup();
  fs.mkdirSync(t.backupsDir, { recursive: true });
  const src = path.join(t.backupsDir, 'auto-2027-01-01.db');
  const newer = new Database(src);
  newer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  newer.pragma('user_version = ' + (known + 5));
  newer.close();
  const before = fs.readFileSync(t.dbPath);

  const res = t.ipcMain.invoke('backup:restoreFromList', { path: src, password: '' });
  assert.equal(res.ok, false);
  assert.match(res.error, /ПО-НОВА версия/);
  assert.match(res.error, new RegExp('версия на схемата ' + (known + 5)));
  assert.deepEqual(fs.readFileSync(t.dbPath), before, 'базата НЕ е променяна');
  assert.equal(t.appCalls.exit.length, 0);
});

test('копие от позната версия се възстановява — отказът по-горе не е глух отказ на всичко', () => {
  /* Проверката трябва да пуска нормалния случай: иначе „по-безопасно“ би значело
     „резервните копия не вършат работа“. */
  const t = setup();
  fs.mkdirSync(t.backupsDir, { recursive: true });
  const src = path.join(t.backupsDir, 'auto-2026-01-02.db');
  const good = new Database(src);
  good.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)');
  good.pragma('user_version = 1');
  good.close();

  const res = ok(t.ipcMain.invoke('backup:restoreFromList', { path: src, password: '' }), 'възстановяване');
  assert.equal(res.needsPassword, false);
  assert.equal(t.appCalls.relaunch, 1, 'програмата се стартира наново с новата база');
  assert.deepEqual(t.appCalls.exit, [0]);
  // Предпазното копие на предишната база остава — единственият изход от
  // сгрешено възстановяване.
  assert.ok(names(t.backupsDir).some(n => n.startsWith('before-restore-')),
    'предишният файл е запазен настрани');
  const restored = new Database(t.dbPath, { readonly: true });
  assert.ok(restored.prepare("SELECT 1 FROM sqlite_master WHERE name = 'marker'").get(),
    'на мястото на базата наистина легна избраното копие');
  restored.close();
});

test('възстановяване от произволен път извън папката с копията се отказва', () => {
  /* Пътят идва от renderer-а. Приема се само файл, който наистина е в папката с
     резервните копия — тоест нещо, което backup:list е показал; всичко друго е
     произволен файл, инсталиран като активна база. */
  const t = setup();
  const outside = path.join(t.dir, 'чужд.db');
  const other = new Database(outside);
  other.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  other.close();
  const res = t.ipcMain.invoke('backup:restoreFromList', { path: outside, password: '' });
  assert.equal(res.ok, false);
  assert.match(res.error, /папката с резервните копия/);
});

/* ==================================================================
   5. СТЕПЕНУВАНО ПАЗЕНЕ
   ================================================================== */

/* Създава копие с дадена дата в името и със същата дата като време на файла —
   така се пресъздава папка, трупана месеци наред. */
function fakeBackup(dir, name, when) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'копие ' + name);
  const t = when.getTime() / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

test('пазенето е степенувано: всекидневни за месец, по едно на седмица за три месеца, по едно на месец за две години', () => {
  /* Правилото „последните 30 дни“ отговаря на грешки, които се забелязват
     веднага. А сгрешено групово отчисляване, изтрит читател или объркан внос
     излизат наяве при годишната инвентаризация или при сверката по Наредба № 3 —
     месеци по-късно, когато 30-дневният прозорец отдавна е минал. */
  const t = setup();
  const B = t.backupsDir;

  // а) в рамките на месеца — всички дни се пазят
  const recent = [iso(daysAgo(3)), iso(daysAgo(10)), iso(daysAgo(25))];
  recent.forEach((d, i) => fakeBackup(B, 'auto-' + d + '.db', daysAgo([3, 10, 25][i])));

  // б) 30 – 90 дни: две дати от ЕДНА И СЪЩА календарна седмица (вторник и сряда)
  let wed = daysAgo(45);
  while (wed.getUTCDay() !== 3) wed = new Date(wed.getTime() - DAY);
  const tue = new Date(wed.getTime() - DAY);
  fakeBackup(B, 'auto-' + iso(wed) + '.db', wed);
  fakeBackup(B, 'auto-' + iso(tue) + '.db', tue);

  // в) 90 – 730 дни: две дати от ЕДИН И СЪЩ месец
  const mon = iso(daysAgo(200)).slice(0, 7);
  const early = new Date(mon + '-05T12:00:00Z');
  const late = new Date(mon + '-20T12:00:00Z');
  fakeBackup(B, 'auto-' + mon + '-05.db', early);
  fakeBackup(B, 'auto-' + mon + '-20.db', late);

  // г) над две години — не се пази
  const ancient = daysAgo(800);
  fakeBackup(B, 'auto-' + iso(ancient) + '.db', ancient);

  t.handlers.autoBackupIfNeeded(); // прави днешното копие и чисти по правилото
  const left = new Set(names(B));

  for (const d of recent) assert.ok(left.has('auto-' + d + '.db'), 'всекидневните за последния месец се пазят: ' + d);
  assert.ok(left.has('auto-' + iso(wed) + '.db'), 'от седмицата остава ПО-НОВОТО копие (сряда)');
  assert.ok(!left.has('auto-' + iso(tue) + '.db'), 'а по-старото от същата седмица пада');
  assert.ok(left.has('auto-' + mon + '-20.db'), 'от месеца остава по-новото копие');
  assert.ok(!left.has('auto-' + mon + '-05.db'), 'а по-старото от същия месец пада');
  assert.ok(!left.has('auto-' + iso(ancient) + '.db'), 'копие отпреди две години вече не се пази');
  assert.ok(left.has('auto-' + todayStr() + '.db'), 'днешното, разбира се, остава');
});

test('седмичният етаж е СЕДМИЧЕН: две дати от един месец, но от различни седмици, оцеляват ЗАЕДНО', () => {
  /* Горният тест пази двете крайности (всекидневно и месечно), но не заковава
     СРЕДНИЯ етаж: дата на 45 дни, която падне в същия месец като друга, оцелява и
     по месечното правило, ако седмичният прозорец бъде свит обратно до 30 дни.
     Тоест „по едно на седмица за три месеца“ би могло да изчезне, без нито един
     тест да мигне — а точно то е разликата между „последният запис за март“ и
     „четири записа от март“, когато сгрешеният внос се търси месеци по-късно.
     Затова тук двете дати са в ЕДИН И СЪЩ календарен месец и на 14 дни една от
     друга (тоест със сигурност в различни ISO седмици): при вярното правило и
     двете се пазят, при месечно — оцелява само по-новата. */
  const t = setup();
  const B = t.backupsDir;

  // Двойка в прозореца 31–90 дни, в един и същ месец, на 14 дни една от друга.
  let older = null, newer = null;
  for (let a = 33; a <= 74 && !newer; a++) {
    const n = daysAgo(a), o = daysAgo(a + 14);
    if (iso(n).slice(0, 7) === iso(o).slice(0, 7)) { newer = n; older = o; }
  }
  assert.ok(newer && older, 'има такава двойка дати — прозорецът 31–90 дни съдържа цял календарен месец');

  fakeBackup(B, 'auto-' + iso(newer) + '.db', newer);
  fakeBackup(B, 'auto-' + iso(older) + '.db', older);
  t.handlers.autoBackupIfNeeded();
  const left = new Set(names(B));

  assert.ok(left.has('auto-' + iso(newer) + '.db'), 'по-новата дата се пази: ' + iso(newer));
  assert.ok(left.has('auto-' + iso(older) + '.db'),
    'и ПО-СТАРАТА от същия месец се пази, защото е от друга седмица: ' + iso(older)
    + ' — иначе седмичният етаж е изчезнал и остава само по едно копие на месец');
});

test('междинните копия за един ден се трупат до четири, а дневното не се пипа', () => {
  /* Таймерът работи на 3 часа: при работен ден от 8 часа това са до 3 нови файла
     на ден. Без таван папката щеше да расте с по едно копие на всеки три часа
     завинаги; четири е „днешното плюс вчерашният край на деня“. */
  const t = setup();
  const B = t.backupsDir;
  const d5 = iso(daysAgo(5));
  fakeBackup(B, 'auto-' + d5 + '.db', daysAgo(5));
  const hours = ['0800', '1000', '1200', '1400', '1600', '1800'];
  hours.forEach((h, i) => fakeBackup(B, 'auto-' + d5 + '-' + h + '.db', new Date(daysAgo(5).getTime() + i * 3600000)));

  t.handlers.autoBackupIfNeeded();
  const left = names(B).filter(n => n.startsWith('auto-' + d5));
  assert.ok(left.includes('auto-' + d5 + '.db'), 'дневното копие за деня остава винаги');
  const intraday = left.filter(n => /-\d{4}\.db$/.test(n));
  assert.equal(intraday.length, 4, 'от междинните остават последните четири, а не всичките шест');
  assert.ok(intraday.includes('auto-' + d5 + '-1800.db'), 'най-новото е сред тях');
  assert.ok(!intraday.includes('auto-' + d5 + '-0800.db'), 'най-старото пада');
});

test('чужд файл в папката не се трие по нашето правило, докато не остарее напълно', () => {
  /* Папката с копията по документиран сценарий е споделена в мрежата и в нея
     може да има файл, писан от друг компютър или от друга програма. Правилото
     винаги клони към ПАЗЕНЕ: сгрешено изтриване на копие е необратимо, а едно
     излишно копие не вреди на никого. */
  const t = setup();
  const B = t.backupsDir;
  fakeBackup(B, 'auto-ot-drug-kompyutar.db', daysAgo(200));
  fakeBackup(B, 'auto-mnogo-staro.db', daysAgo(900));
  t.handlers.autoBackupIfNeeded();
  const left = new Set(names(B));
  assert.ok(left.has('auto-ot-drug-kompyutar.db'), 'непознато име не се чисти по чужда логика');
  assert.ok(!left.has('auto-mnogo-staro.db'), 'но и то не остава завинаги — след целия прозорец на пазене пада');
});

/* ==================================================================
   6. ПРЕМЕСТВАНЕТО НА БАЗАТА ПРЕНАСЯ И КОПИЯТА
   ================================================================== */

/* Отделна фикстура: преместването живее в handlers/db-location.js. */
function setupMove(opts) {
  const o = opts || {};
  const root = mkTmpDir('inv-kopiya-move-');
  const oldDir = path.join(root, 'stara');
  const newDir = path.join(root, 'nova');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldPath = path.join(oldDir, 'library.db');
  let db = new Database(oldPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');

  let config = {};
  const messages = [];
  const appCalls = { relaunch: 0, exit: [] };
  const ipcMain = fakeIpcMain();
  registerDbLocationHandlers(ipcMain, {
    app: { isPackaged: true, relaunch: () => { appCalls.relaunch++; }, exit: (c) => appCalls.exit.push(c) },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [newDir] }),
      showMessageBox: async (win, opt) => { messages.push(opt); return { response: o.response == null ? 2 : o.response }; }
    },
    fs: Object.assign({}, fs, o.fsHooks || {}), path,
    getDb: () => db, setDb: (v) => { db = v; },
    getMainWindow: () => ({}), run: runDep,
    readConfig: () => config, writeConfig: (c) => { config = c; },
    updateConfig: (mutate) => { mutate(config); return true; },
    resolveDbDir: () => oldDir, resolveDbPath: () => oldPath
  });
  return { root, oldDir, newDir, ipcMain, messages, appCalls, getConfig: () => config };
}

test('преместването на базата пренася и папката с резервните копия', async () => {
  /* Дотук се пренасяше само library.db. Веднага след рестарта програмата чете и
     пише копия в НОВАТА папка, тоест списъкът в „Настройки“ осъмва празен, а
     тридесетдневната история виси в стара папка, за която никой не знае. Точно
     в случая, за който смяната на папката е измислена — преместване на нов
     компютър, преди старият да бъде изхвърлен — това е изтрита история. */
  const t = setupMove();
  const oldBackups = path.join(t.oldDir, 'backups');
  fakeBackup(oldBackups, 'auto-2026-01-01.db', daysAgo(10));
  fakeBackup(oldBackups, 'auto-2026-01-02.invbak', daysAgo(9));
  fakeBackup(oldBackups, 'auto-2026-01-03.db.tmp', daysAgo(9)); // огризка — не се пренася

  const res = await t.ipcMain.invoke('dbLocation:choose');
  assert.equal(res.ok, true, res.error || '');
  const moved = names(path.join(t.newDir, 'backups'));
  assert.deepEqual(moved, ['auto-2026-01-01.db', 'auto-2026-01-02.invbak'],
    'копията са в новата папка, а недописаните огризки — не');
  // Копира се, не се мести: старите файлове остават, докато човек сам не реши.
  assert.equal(names(oldBackups).length, 3, 'старата папка не се изпразва сама');
  assert.equal(t.appCalls.relaunch, 1);
});

test('когато в целевата папка вече живее ДРУГА библиотека, копията не се пренасят при нея', () => {
  /* „Ползвай съществуващата база от тази папка“ значи свързване към чужда
     (споделена) база. Нашите копия там само биха подвели кой какво възстановява
     — библиотекарят би възстановил своя фонд върху общата база. */
  const t = setupMove({ response: 1 }); // „Ползвай съществуващата база“
  fakeBackup(path.join(t.oldDir, 'backups'), 'auto-2026-01-01.db', daysAgo(10));
  const existing = new Database(path.join(t.newDir, 'library.db'));
  existing.exec('CREATE TABLE chuzhda (id INTEGER PRIMARY KEY)');
  existing.close();

  return t.ipcMain.invoke('dbLocation:choose').then((res) => {
    assert.equal(res.ok, true, res.error || '');
    assert.deepEqual(names(path.join(t.newDir, 'backups')), [],
      'чуждата папка не получава нашите копия');
    const check = new Database(path.join(t.newDir, 'library.db'), { readonly: true });
    assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chuzhda'").get(),
      'и самата чужда база е непокътната');
    check.close();
  });
});

test('непренесено копие не проваля преместването, а се казва къде е останало', async () => {
  /* Провалът тук НЕ бива да отменя преместването на базата: по-полезно е да се
     каже къде са останали копията, отколкото да се откаже цялото действие. */
  const t = setupMove({
    fsHooks: {
      copyFileSync: (a, b, ...rest) => {
        if (String(a).includes(path.sep + 'backups' + path.sep)) throw new Error('дискът е пълен');
        return fs.copyFileSync(a, b, ...rest);
      }
    }
  });
  fakeBackup(path.join(t.oldDir, 'backups'), 'auto-2026-01-01.db', daysAgo(10));
  const res = await t.ipcMain.invoke('dbLocation:choose');
  assert.equal(res.ok, true, 'базата пак се премества');
  assert.ok(fs.existsSync(path.join(t.newDir, 'library.db')));
  const warn = t.messages.find(m => /резервните копия/i.test(m.title || ''));
  assert.ok(warn, 'човекът е предупреден ПРЕДИ рестарта — след него няма кой да го каже');
  assert.match(warn.detail, /auto-2026-01-01\.db/, 'и вижда кои файлове са останали');
  assert.match(warn.detail, new RegExp(path.join(t.oldDir, 'backups').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')),
    'заедно с точния път — копията са единственият изход при повреда');
});
