'use strict';
/* v2.4.64 — четиридесет и първи кръг: производителност, части 5 – 8.
   ============================================================================
   Четирите поправки тук са намерени с ИЗМЕРВАНЕ на истинската програма върху
   истинска база (15 000 документа, 3 000 читатели, 12 000 заемания, 19,47 МБ) и
   с калибровка в истински Chromium 141 — не с четене на кода. Харнесът е в
   /tmp/r41; всяко число по-долу носи командата, с която се повтаря.

     5. СТАРТИРАНЕ. 117 от 140 ms на автоматичното копие отиваха в PRAGMA
        integrity_check ВЪРХУ ПРЯСНО ЗАПИСАНОТО КОПИЕ, докато живата база беше
        quick_check-ната 200 ms по-рано; на всичкото отгоре копието се правеше
        четири реда ПРЕДИ createWindow(), тоест библиотекарят го чакаше, преди да
        види каквото и да е.   (node /tmp/r41/backup-split.js)
     6. ПРОЗОРЕЧНИЯТ РЕНДЕР НЯМАШЕ ТАВАН. В Chromium вписването на порция е
        плоско (7 ms на всяка дълбочина), но оформлението и паметта растат:
        300 реда → 65 ms / +73 МБ; 3 000 → 283 ms / +248 МБ; 15 000 → 1 115 ms /
        +1 025 МБ и таблица, висока 751 835 px.
        (node /tmp/r41/bench-chromium.js, node /tmp/r41/mem-chromium.js)
     7. „ПЕЧАТ НА ЦЯЛАТА ИНВЕНТАРНА КНИГА“ — 195 035 възела, ~2,7 s замръзнал
        прозорец, +792 МБ. Рязането на порции по 500 прави СБОРА по-лош
        (3 575 ms), затова печатът не се реже — пита се.
     8. МЗС не беше прозоречен (500 заявки → 5 516 възела); кардексът с „всички
        години“ заобикаляше собствения си разрез по година (1 200 броя → 7 295
        възела).

   Тестовете нарочно доказват ДВЕ различни неща и ги разделят:
     • че поправеното прави същото, каквото и преди (копието пак се проверява и
       пак се отказва повредено; printInvBookDoc({from,to}) е непроменена);
     • ФОРМАТА на поправката — по текста на кода: таванът съществува и е в общата
       машинка; дълбоката проверка остава за възстановяването; копието стои след
       създаването на прозореца.

   ЗА ПРАГОВЕТЕ ПО ВРЕМЕ — същата честна бележка като в perf-v2448.test.js: те НЕ
   ловят връщането назад и не бива да се четат така. Тестовата база тук е
   няколко мегабайта, не 19,47, а машината на поредицата е споделена; праговете
   са груб предпазител срещу нещо драстично (копие, което е тръгнало да чете
   базата по ред), а истинската преграда са проверките по ФОРМАТА по-долу. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerBackupHandlers = require('../handlers/backup');
const { buildDom, settle, printed } = require('./helpers/audit-fixtures');

const APP_DIR = path.join(__dirname, '..');
const MAIN_JS = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
const BACKUP_JS = fs.readFileSync(path.join(APP_DIR, 'handlers', 'backup.js'), 'utf8');
const CORE_JS = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'core.js'), 'utf8');
const MZS_JS = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'mzs.js'), 'utf8');
const PERIODICALS_JS = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'periodicals.js'), 'utf8');
const INVBOOK_JS = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'inv-book.js'), 'utf8');

/* Хигиена на временните папки — виж същата бележка в handlers-backup.test.js:
   node --test не чисти нищо след себе си. */
const tmpDirs = [];
function mkTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-v2464-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
  }
});

/* ============================================================================
   5. СТАРТИРАНЕ: проверката на прясното копие и мястото на самото копие
   ========================================================================= */

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

/* Обвивка около fs, която РАЗВАЛЯ записа на стажирания файл — точно случаят,
   срещу който съществува проверката на прясното копие: спиране на тока, изваден
   USB или прекъснат мрежов дял насред писането оставят файл с правилно име и
   правдоподобен размер, чиито страници са боклук. Заглавието „SQLite format 3“
   се запазва нарочно — иначе би се хванало от евтината проверка на заглавието и
   нямаше да докаже нищо за самата проверка на базата. */
function corruptingFs(shouldCorrupt, from, to) {
  const wrapper = Object.create(fs);
  wrapper.writeFileSync = (file, data, ...rest) => {
    if (shouldCorrupt(String(file)) && Buffer.isBuffer(data) && data.length > to) {
      const bad = Buffer.from(data);
      bad.fill(0xFF, from, to); // страница 1 (схемата) остава читаема — виж по-горе защо
      return fs.writeFileSync(file, bad, ...rest);
    }
    return fs.writeFileSync(file, data, ...rest);
  };
  return wrapper;
}

/* Истинска база с достатъчно страници, за да има какво да се разваля (и за да
   значи нещо прагът по време по-долу). */
function setupBackup(opts) {
  opts = opts || {};
  const dir = mkTmpDir();
  const dbPath = path.join(dir, 'library.db');
  let db = new Database(dbPath);
  db.exec('CREATE TABLE knigi (id INTEGER PRIMARY KEY, inv INTEGER, title TEXT, author TEXT)');
  const ins = db.prepare('INSERT INTO knigi (inv, title, author) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 1; i <= (opts.rows || 20000); i++) {
      ins.run(i, 'Заглавие на документ № ' + i + ' с достатъчно дълъг текст', 'Автор ' + (i % 500));
    }
  })();
  db.exec('CREATE INDEX ix_knigi_inv ON knigi (inv)');

  const auditLog = [];
  const notices = [];
  const deps = {
    app: { getPath: (n) => (n === 'temp' ? os.tmpdir() : dir), relaunch: () => {}, exit: () => {} },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    fs: opts.fs || fs,
    path,
    getDb: () => db,
    setDb: (v) => { db = v; },
    getMainWindow: () => ({ webContents: { send: (ch, m) => notices.push([ch, m]) }, isDestroyed: () => false }),
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    resolveDbDir: () => dir,
    resolveDbPath: () => dbPath
  };
  const handlers = registerBackupHandlers(fakeIpcMain(), deps);
  return { dir, dbPath, handlers, auditLog, notices, close: () => { try { db.close(); } catch (e) { /* вече е затворена */ } } };
}

const todayStr = () => new Date().toISOString().slice(0, 10);

test('5. дневното копие продължава да се прави и продължава да бъде ПРОВЕРЕНО', () => {
  const s = setupBackup();
  try {
    s.handlers.autoBackupIfNeeded();
    const file = path.join(s.dir, 'backups', 'auto-' + todayStr() + '.db');
    assert.ok(fs.existsSync(file), 'дневното копие трябва да се направи');
    // Каквото копието обещава, това и съдържа — истинска база със същите редове.
    const ro = new Database(file, { readonly: true, fileMustExist: true });
    try {
      assert.equal(ro.pragma('quick_check', { simple: true }), 'ok');
      assert.equal(ro.pragma('integrity_check', { simple: true }), 'ok',
        'по-евтината проверка при записа не бива да пуска копие, което дълбоката би отхвърлила');
      assert.equal(ro.prepare('SELECT COUNT(*) AS n FROM knigi').get().n, 20000);
    } finally { ro.close(); }
    // Стажираният файл не бива да остава в папката с копията.
    assert.ok(!fs.readdirSync(path.join(s.dir, 'backups')).some(f => f.endsWith('.tmp')),
      'след успешно копие не бива да остава .tmp');
  } finally { s.close(); }
});

test('5. ПОВРЕДЕНО прясно копие се ОТКАЗВА — денят остава с предишното копие, а не с боклук', () => {
  /* Точно това пази проверката на прясното копие и точно то трябва да продължи
     да работи с по-евтиния quick_check: разваленият запис (прекъснат ток, изваден
     USB, мрежов дял) дава файл с вярно заглавие и правдоподобен размер. */
  const s = setupBackup({ fs: corruptingFs((f) => f.endsWith('.tmp'), 4096, 16384) });
  try {
    s.handlers.autoBackupIfNeeded();
    const file = path.join(s.dir, 'backups', 'auto-' + todayStr() + '.db');
    assert.ok(!fs.existsSync(file), 'копие, което не е минало проверката, НЕ бива да получи крайното име');
    assert.ok(!fs.existsSync(file + '.tmp'), 'отказаният стажиран файл се изтрива');
    const said = s.auditLog.map(x => x.detail).join(' | ');
    assert.match(said, /НЕ беше направено|не мина проверката/,
      'провалът трябва да стигне до одитната следа, а не само до console.error: ' + said);
    assert.ok(s.notices.some(([, m]) => m && m.level === 'err'),
      'и до интерфейса — библиотекарят трябва да научи, че няма копие за деня');
  } finally { s.close(); }
});

test('5. и повредата ДЪЛБОКО във файла (страници 250 – 300) пак се хваща', () => {
  /* Проверката на заглавието не вижда такава повреда, отварянето на базата —
     също: тя се хваща единствено от обхода на страниците. Точно този обход
     прави и quick_check — той е цялата разлика между „записахме файл“ и
     „записахме ЗДРАВ файл“. */
  const s = setupBackup({ fs: corruptingFs((f) => f.endsWith('.tmp'), 1024 * 1024, 1024 * 1024 + 65536) });
  try {
    s.handlers.autoBackupIfNeeded();
    assert.ok(!fs.existsSync(path.join(s.dir, 'backups', 'auto-' + todayStr() + '.db')),
      'повреда на 1 МБ навътре също спира копието');
    assert.match(s.auditLog.map(x => x.detail).join(' | '), /НЕ беше направено/);
  } finally { s.close(); }
});

test('5. ФОРМА: прясното копие се проверява с quick_check, ВЪЗСТАНОВЯВАНЕТО — с integrity_check', () => {
  /* Разликата е смислова, не козметична, затова се пази по текста на кода:
       • прясното копие идва от база, която main.js току-що е quick_check-нал —
         въпросът тук е само „стигна ли всичко до диска“;
       • файлът за възстановяване идва отвън, никой не го е проверявал и той
         предстои да ЗАМЕНИ живата база — там дълбоката проверка си струва. */
  assert.match(BACKUP_JS, /function verifyFreshBackup[\s\S]*?sqliteProblem\(filePath,\s*\{\s*quick:\s*true\s*\}\)/,
    'verifyFreshBackup трябва да иска евтината проверка изрично');
  assert.match(BACKUP_JS, /const problem = sqliteProblem\(realSource\);/,
    'пътят на възстановяването трябва да остане с дълбоката проверка (без opts)');
  assert.match(BACKUP_JS, /const deep = !\(opts && opts\.quick\);/,
    'подразбиращата се проверка остава дълбоката — евтината се иска изрично');
  // И обяснението с измерените числа — иначе следващият кръг ще го „оптимизира“ обратно.
  assert.match(BACKUP_JS, /117/, 'коментарът трябва да носи измереното число');
  assert.match(BACKUP_JS, /quick_check/);
  assert.match(BACKUP_JS, /КАКВО НЕ ХВАЩА/, 'коментарът трябва да казва и какво проверката НЕ лови');
});

test('5. ФОРМА: прозорецът се създава ПРЕДИ автоматичното копие', () => {
  const win = MAIN_JS.indexOf('mainWindow = createWindow();');
  const bak = MAIN_JS.indexOf('autoBackupIfNeeded();', win);
  assert.ok(win > 0, 'createWindow() трябва да се вика при стартиране');
  assert.ok(bak > win,
    'autoBackupIfNeeded() трябва да стои СЛЕД създаването на прозореца — 64 ms копие не бива '
    + 'да стоят между щракането върху иконата и първото нещо, което библиотекарят вижда');
  // Гаранцията, че копие за деня пак се прави, минава по три пътя — и трите са в кода.
  assert.match(MAIN_JS, /did-finish-load['"],\s*startupAutoBackup/, 'път 1: щом прозорецът е зареден');
  assert.match(MAIN_JS, /setTimeout\(startupAutoBackup, 5000\)/, 'път 2: предпазен таймер');
  assert.match(MAIN_JS, /backupBeforeQuit\(\)/, 'път 3: при затваряне на програмата');
  /* И нищо ИЗПЪЛНИМО между двете не чака копието. Проверява се върху текста без
     коментари — обяснението защо копието е преместено естествено споменава
     самата функция, а то не е код. */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const between = stripComments(MAIN_JS.slice(win, bak));
  assert.ok(!/lastAutoBackup|backup:autoStatus|autoBackupIfNeeded/.test(between),
    'между прозореца и копието не бива да се е промъкнала зависимост от него: ' + between.trim());

  /* И ДВЕТЕ ПОСОКИ — върху текста БЕЗ коментари. Проверките по-горе гледат
     ПЪРВОТО повикване СЛЕД createWindow(): те не падат, ако някой върне
     autoBackupIfNeeded() и ПРЕДИ прозореца (тогава копието пак се плаща преди
     първия екран, само че два пъти), нито ако път 3 остане само като дума в
     обяснителния коментар. Затова: (а) в app.whenReady() преди прозореца не
     бива да има НИТО ЕДНО повикване на копието; (б) backupBeforeQuit() трябва
     да е ИЗПЪЛНИМ ред, а не спомената функция. */
  const code = stripComments(MAIN_JS);
  const ready = code.slice(code.indexOf('app.whenReady()'), code.indexOf("app.on('window-all-closed'"));
  const winIn = ready.indexOf('mainWindow = createWindow();');
  assert.ok(winIn > 0, 'createWindow() трябва да се вика в app.whenReady()');
  assert.ok(!ready.slice(0, winIn).includes('autoBackupIfNeeded('),
    'копието пак се прави ПРЕДИ прозореца — 64 ms между щракването върху иконата и първия екран');
  assert.match(code, /try \{ backupBeforeQuit\(\); \}/,
    'път 3 трябва да е повикване в кода, а не само спомената функция в коментар');
});

test('5. праг по време (ГРУБ предпазител, виж бележката в главата на файла)', () => {
  const s = setupBackup();
  try {
    const t0 = Date.now();
    s.handlers.autoBackupIfNeeded();
    const ms = Date.now() - t0;
    console.log('# авто-копие на база с 20 000 реда: ' + ms + ' ms');
    assert.ok(ms < 8000, 'автоматичното копие отне ' + ms + ' ms — това е груб предпазител, не мерило');
  } finally { s.close(); }
});

/* ============================================================================
   6. ТАВАН НА ПРОЗОРЕЧНИЯ РЕНДЕР
   ========================================================================= */

const R = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
const DAY = (i) => '20' + String(10 + (i % 15)).padStart(2, '0') + '-0' + (1 + i % 9) + '-1' + (i % 9);
const makeOverdue = (n) => R(n, i => ({
  id: i, reader_name: 'Читател №' + i, inv_number: 1000 + i, title: 'Заглавие №' + i,
  date_due: DAY(i), daysLate: 3 + (i % 400), fine: 0.1 * (3 + (i % 400))
}));

async function openView(dom, hash) {
  const { window } = dom;
  await settle();
  window.location.hash = '#' + hash;
  await window.route();
  await settle();
  return window;
}
/* Разгръща списъка докрай през самия бутон и връща колко натискания е отнело. */
function expandAll(window, barSel) {
  let clicks = 0;
  for (;;) {
    const btn = window.document.querySelector(barSel + ' button');
    if (!btn || clicks > 500) return clicks;
    btn.click();
    clicks++;
  }
}
/* bg-BG слага интервал в хилядите („15 000“), но не и при четири цифри
   („3000“) — затова сравненията са през нормализиран текст. */
const flat = (s) => String(s).replace(/[\s  ]+/g, ' ').trim();

test('6. прозоречният рендер СПИРА на тавана — и казва защо, вместо да мълчи', async () => {
  const dom = buildDom({ 'loans.overdue': makeOverdue(15000) });
  const window = await openView(dom, 'over');
  assert.equal(window.document.querySelectorAll('#ovBody tr').length, 300, 'първата порция е 300 реда');
  const clicks = expandAll(window, '#ovMore');
  const rows = window.document.querySelectorAll('#ovBody tr').length;
  assert.equal(rows, window.RENDER_MAX_ROWS,
    'разгръщането трябва да спре на тавана (' + window.RENDER_MAX_ROWS + '), а не да стигне до 15 000');
  assert.equal(rows, 3000, 'таванът е 3 000 реда — последната измерена стъпка, при която прозорецът остава използваем');
  assert.ok(clicks < 20, 'до тавана се стига за ' + clicks + ' натискания');
  // Лентата отдолу: вече няма бутон, а честно изречение.
  assert.equal(window.document.querySelector('#ovMore button'), null, 'на тавана бутонът „Покажи още“ пада');
  const bar = flat(window.document.getElementById('ovMore').textContent);
  assert.match(bar, /Показани са първите 3000 реда от 15 000/, 'казва колко от колко: ' + bar);
  assert.match(bar, /Стеснете търсенето/, 'и какво да се направи вместо това');
  assert.match(bar, /филтрите/);
  assert.match(bar, /диапазон/);
});

test('6. под тавана нищо не се променя — бутонът си е бутон и редовете не се губят', async () => {
  const dom = buildDom({ 'loans.overdue': makeOverdue(1200) });
  const window = await openView(dom, 'over');
  expandAll(window, '#ovMore');
  assert.equal(window.document.querySelectorAll('#ovBody tr').length, 1200,
    'списък под тавана се разгръща докрай, както досега');
  assert.equal(flat(window.document.getElementById('ovMore').textContent).indexOf('Показани са първите'), -1,
    'под тавана не бива да излиза надписът за отрязване');
});

test('6. в прозоречен режим надписът брои ЦЕЛИЯ резултат, не само изтеглените порции', async () => {
  /* „Книги“, „Читатели“ и „Инвентарна книга“ теглят порции от базата: в
     paintRowWindow влизат само заредените редове, а истинският общ брой идва
     отделно (o.total). Без него надписът при тавана би гласял „показани 3 000 от
     3 000“ — тоест точно обратното на истината. */
  const dom = buildDom({});
  const { window } = dom;
  await settle();
  const body = window.document.createElement('tbody');
  const bar = window.document.createElement('div');
  window.document.body.append(body, bar);
  const loaded = R(3000, i => i);
  const painted = window.paintRowWindow({
    body, bar, rows: loaded, limit: loaded.length, total: 15000,
    rowsHtml: (part) => part.map(i => '<tr><td>' + i + '</td></tr>').join(''),
    moreHtml: () => '<button>Покажи още</button>'
  });
  assert.equal(painted, 3000);
  assert.equal(bar.querySelector('button'), null, 'на тавана бутонът пада');
  assert.match(flat(bar.textContent), /Показани са първите 3000 реда от 15 000/);
});

test('6. ФОРМА: таванът е в ОБЩАТА машинка, а бележката цитира Chromium, не jsdom', () => {
  assert.match(CORE_JS, /const RENDER_MAX_ROWS = 3000;/, 'таванът е едно число на едно място');
  assert.match(CORE_JS, /Math\.min\(limit, rows\.length, RENDER_MAX_ROWS\)/,
    'таванът трябва да се прилага в самата paintRowWindow, за да важи за ВСЕКИ прозоречен списък');
  /* Старото jsdom число не бива да стои като действащо измерване. Допуска се
     САМО цитирано — заедно с изричното „вече не описва действителността“, което
     обяснява откъде е идвало и защо е сменено; иначе следващият кръг ще го
     възстанови като истина. */
  const coreFlat = flat(CORE_JS);
  assert.ok(!/112 ?462/.test(coreFlat) || /112 462 ms“\. То вече не описва действителността/.test(coreFlat),
    'jsdom числото „112 462 ms“ може да стои само като цитат, обявен за невалиден');
  // Новите числа — с името на двигателя до всяко.
  assert.match(CORE_JS, /Chromium/, 'бележката трябва да казва КОЙ двигател дава числата');
  assert.match(CORE_JS, /jsdom/, 'и защо старите не важат');
  for (const n of ['65 ms', '283 ms', '1 115 ms', '1 025 МБ', '751 835 px', '54 075']) {
    assert.ok(CORE_JS.includes(n), 'измереното число „' + n + '“ липсва в бележката');
  }
  assert.match(CORE_JS, /24,8×|17–41/, 'и колко пъти jsdom е по-бавен от Chromium');
});

/* ============================================================================
   7. ПЕЧАТ НА ИНВЕНТАРНАТА КНИГА
   ========================================================================= */

const makeInvBook = (n) => R(n, i => ({
  id: i, inv_number: i, title: 'Документ № ' + i, author: 'Автор ' + (i % 100),
  register_date: (i <= n / 2 ? '2024' : '2026') + '-0' + (1 + i % 9) + '-1' + (i % 9),
  price: 10, quantity: 1, status: 'наличен', checks: []
}));

async function openInvBook(rows) {
  const dom = buildDom({ 'invBook.list': rows, 'settings.get': {} });
  const { window } = dom;
  await settle();
  window.location.hash = '#invbook';
  await window.route();
  await settle();
  return window;
}

test('7. printInvBookDoc({from,to}) е НЕПРОМЕНЕНА — печата точно диапазона и го обявява', async () => {
  const window = await openInvBook(makeInvBook(500));
  await window.printInvBookDoc({ from: '10', to: '19' });
  await settle();
  const t = printed(window);
  assert.match(t, /10 вписвания/, 'в диапазона 10 – 19 има точно 10 реда');
  assert.match(t, /инв\. № 10 – 19/, 'главата назовава границите — листът се прошнурова и заверява');
  assert.match(t, /НЕ е пълната инвентарна книга/);
  assert.match(t, /съдържа общо 500 вписвания/, 'и колко е цялата книга');
  const sheet = window.document.querySelector('#ppSheet').innerHTML;
  assert.ok(sheet.includes('Документ № 10') && sheet.includes('Документ № 19'));
  assert.ok(!sheet.includes('Документ № 9<') && !sheet.includes('Документ № 20<'),
    'извън диапазона не бива да попада нито един ред');
  // И без диапазон — пак както досега.
  await window.printInvBookDoc();
  await settle();
  assert.match(printed(window), /500 вписвания \(инвентарни номера\) от началото на книгата/);
});

test('7. диалогът предлага ГОДИНА по подразбиране и казва какво струва цялата книга', async () => {
  const window = await openInvBook(makeInvBook(15000));
  window.invBookPrintDialog();
  await settle();
  const y = new Date().getFullYear();
  assert.equal(window.document.querySelector('#ibPrintF [name=dateFrom]').value, y + '-01-01',
    'по подразбиране — една година, а не цялата книга');
  assert.equal(window.document.querySelector('#ibPrintF [name=dateTo]').value, y + '-12-31');
  assert.ok(window.document.querySelector('#ibPrintYear'), 'има бърз избор на година');
  const note = flat(window.document.getElementById('ibPrintCost').textContent);
  assert.match(note, /Цялата книга е 15 000 вписвания/, 'казва колко е цялата книга: ' + note);
  assert.match(note, /листа А4/, 'и колко хартия е това');
  assert.match(note, /секунди/, 'и колко време прозорецът не отговаря');
  assert.match(note, /МБ памет/, 'и колко памет');
  // Годината само попълва двете дати — не отваря втори път за рязане.
  window.invBookPrintYearChanged('2024');
  assert.equal(window.document.querySelector('#ibPrintF [name=dateFrom]').value, '2024-01-01');
  window.invBookPrintYearChanged('');
  assert.equal(window.document.querySelector('#ibPrintF [name=dateTo]').value, '', 'и се изчиства');
});

test('7. „Цялата книга“ ПИТА преди да печата — и при „не“ не печата нищо', async () => {
  const window = await openInvBook(makeInvBook(15000));
  const asked = [];
  window.confirm = (msg) => { asked.push(String(msg)); return false; };
  window.document.querySelector('#ppSheet').innerHTML = '';
  window.invBookPrintDialog();
  await settle();
  await window.invBookPrintAll();
  await settle();
  assert.equal(asked.length, 1, 'трябва да попита точно веднъж');
  const q = flat(asked[0]);
  assert.match(q, /ПЕЧАТ НА ЦЯЛАТА ИНВЕНТАРНА КНИГА/);
  assert.match(q, /15 000 вписвания/, 'въпросът носи истинското число');
  assert.match(q, /листа А4/);
  assert.match(q, /без отговор/, 'и казва какво значи това за прозореца');
  assert.match(q, /по години или по диапазон/, 'и предлага по-добрия път');
  assert.equal(window.document.querySelector('#ppSheet').innerHTML, '',
    'при отказ не бива да се е изчертал нито един ред');
  assert.ok(window.document.querySelector('#ibPrintF'),
    'диалогът остава отворен, за да може да се избере диапазон');
});

test('7. „Цялата книга“ при „да“ печата цялата книга, както досега', async () => {
  const window = await openInvBook(makeInvBook(1500));
  window.confirm = () => true;
  window.invBookPrintDialog();
  await settle();
  await window.invBookPrintAll();
  await settle();
  assert.match(printed(window), /1500 вписвания \(инвентарни номера\) от началото на книгата/);
});

test('7. малка книга не пита — въпрос без повод е само пречка', async () => {
  const window = await openInvBook(makeInvBook(40));
  const asked = [];
  window.confirm = (msg) => { asked.push(String(msg)); return true; };
  window.invBookPrintDialog();
  await settle();
  await window.invBookPrintAll();
  await settle();
  assert.equal(asked.length, 0, 'под прага въпросът не се задава');
  assert.match(printed(window), /40 вписвания/);
});

test('7. ФОРМА: печатът НЕ е нарязан на порции — измерено, че така е по-зле', () => {
  assert.ok(!/SHEET_CHUNK|печат.*на порции по 500/i.test(INVBOOK_JS.replace(/по порции по 500 реда, струва 3 575 ms/, '')),
    'рязането на печатния лист беше измерено (3 575 ms срещу 2 581 ms) и е по-лошо — не бива да се появява');
  assert.match(INVBOOK_JS, /3 575 ms/, 'а измерването да стои в коментара, за да не се „оптимизира“ обратно');
  assert.match(INVBOOK_JS, /195 035/, 'както и цената на самия лист');
  assert.match(INVBOOK_JS, /792 МБ/);
});

/* ============================================================================
   8. МЗС и кардексът „всички години“
   ========================================================================= */

const makeMzs = (n) => R(n, i => ({
  id: i, no: i, year: '2026', date: DAY(i), direction: i % 2 ? 'изходящо' : 'входящо',
  partner: 'Библиотека ' + i, author: 'Автор ' + i, title: 'Заглавие ' + i,
  requester: 'Читател ' + i, status: 'заявено'
}));

test('8. МЗС: регистърът вече е прозоречен — 300 реда от 500, не 500', async () => {
  const dom = buildDom({ 'mzs.list': makeMzs(500) });
  const window = await openView(dom, 'mzs');
  assert.equal(window.document.querySelectorAll('#mzsBody tr').length, 300,
    'при 500 заявки се изчертаваха 500 реда (5 516 DOM възела) — точно това ограничава поправката');
  const btn = window.document.querySelector('#mzsMore button');
  assert.ok(btn, 'трябва да има „Покажи още“, щом има още заявки');
  assert.match(flat(btn.textContent), /Покажи още \(200 от общо 500\)/);
  // Разгръщането не праща ново IPC — списъкът вече е в паметта.
  const before = (dom.calls['mzs.list'] || []).length;
  btn.click();
  assert.equal(window.document.querySelectorAll('#mzsBody tr').length, 500, 'втората порция допълва първата');
  assert.equal((dom.calls['mzs.list'] || []).length, before, '„Покажи още“ не бива да праща нова заявка');
  // И без дублирани/пропуснати редове на границата на порцията.
  const nums = Array.from(window.document.querySelectorAll('#mzsBody tr td:first-child')).map(td => flat(td.textContent));
  assert.equal(new Set(nums).size, 500, 'няма дублиран ред на границата на порцията');
});

test('8. МЗС: малък регистър си остава без бутон', async () => {
  const dom = buildDom({ 'mzs.list': makeMzs(12) });
  const window = await openView(dom, 'mzs');
  assert.equal(window.document.querySelectorAll('#mzsBody tr').length, 12);
  assert.equal(window.document.querySelector('#mzsMore button'), null, 'излишен бутон е влошаване, не подобрение');
});

const makeIssues = (n) => R(n, i => ({
  id: i, issue_no: String(i), date: (i <= n / 2 ? '2025' : '2026') + '-0' + (1 + i % 9) + '-1' + (i % 9), price: 0.85
}));

function periodicalAll(n) {
  return {
    id: 7, title: 'Труд', freq: 'ежедневник', publisher: 'Издател', issn: '1234-5678',
    issues: makeIssues(n), issue_year: 'всички', issue_total: n, volumes: [],
    issue_years: [['2026', Math.ceil(n / 2)], ['2025', Math.floor(n / 2)]].map(([year, k]) => ({ year, n: k }))
  };
}

test('8. кардексът „всички години“ вече минава през същия прозорец', async () => {
  const dom = buildDom({ 'periodicals.list': [], 'periodicals.get': periodicalAll(1200) });
  const { window } = dom;
  await openView(dom, 'periodika');
  await window.openPeriodical(7, 'всички');
  await settle();
  assert.equal(window.document.querySelectorAll('#perIssuesBody tr').length, 300,
    '1 200 броя се чертаеха до един (7 295 DOM възела) в кутия с превъртане 240 px');
  const btn = window.document.querySelector('#perIssuesMore button');
  assert.ok(btn, 'има „Покажи още“');
  assert.match(flat(btn.textContent), /Покажи още \(900 от общо 1200\)/);
  assert.match(flat(window.document.getElementById('perIssueCount').textContent),
    /Показани 300 от 1200 броя — всички години/, 'надписът казва колко от колко и за кой разрез');
  btn.click();
  assert.equal(window.document.querySelectorAll('#perIssuesBody tr').length, 600, 'втората порция допълва първата');
  assert.match(flat(window.document.getElementById('perIssueCount').textContent), /Показани 600 от 1200/);
});

test('8. „×“ на реда от втората порция сочи към СВОЯ брой, а не към чужд', async () => {
  const dom = buildDom({ 'periodicals.list': [], 'periodicals.get': periodicalAll(600) });
  const { window } = dom;
  await openView(dom, 'periodika');
  await window.openPeriodical(7, 'всички');
  await settle();
  window.perIssuesMore();
  const rows = window.document.querySelectorAll('#perIssuesBody tr');
  assert.equal(rows.length, 600);
  const last = rows[rows.length - 1];
  assert.equal(flat(last.children[0].textContent), '600', 'последният ред е брой № 600');
  assert.match(last.querySelector('button.dgr').getAttribute('onclick'), /delIssue\(600,7,/,
    'бутонът „×“ носи ident-а на СВОЯ брой и на своето издание');
});

test('8. ФОРМА: и двата екрана ползват ОБЩАТА машинка, а не собствено копие', () => {
  for (const [name, src] of [['mzs.js', MZS_JS], ['periodicals.js', PERIODICALS_JS]]) {
    assert.match(src, /paintRowWindow\(\{/, name + ': прозоречният рендер трябва да е общият от core.js');
    assert.match(src, /RENDER_PAGE_SIZE/, name + ': и порцията да е общата, а не ново число');
    assert.ok(!/const .*_MAX_ROWS\s*=/.test(src), name + ': таванът е един, в core.js — не се преоткрива тук');
  }
  assert.match(MZS_JS, /5 516/, 'измереното число стои в коментара');
  assert.match(PERIODICALS_JS, /7 295/);
});
