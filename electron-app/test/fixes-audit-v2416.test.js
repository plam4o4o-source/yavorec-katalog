'use strict';
/* Одит v2.4.16 — шести кръг.

   Този кръг гледаше три неща, които предишните не бяха: поправките, направени
   СЛЕД независимия преглед на v2.4.14 (тях никой не беше преглеждал), екранния
   слой, и съответствието с Наредба № 3.

   Половината находки тук са дефекти в собствените ми предишни поправки — включително
   един, при който отключването успяваше, а първото изчертаване на списъка убиваше
   сесията и заключваше библиотекаря извън всичките му читатели.

   Всеки тест е проверен с мутация. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');
const tmpDirs = [];
function mkTmpDir(p) { const d = fs.mkdtempSync(p); tmpDirs.push(d); return d; }
test.after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* няма значение */ } }
});
function fakeIpcMain() {
  const h = new Map();
  return { handle: (c, fn) => h.set(c, fn), invoke: (c, ...a) => h.get(c)({}, ...a), has: (c) => h.has(c) };
}
function freshDb(prefix) {
  const dir = mkTmpDir(path.join(os.tmpdir(), prefix));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return { db, dir };
}
const runDep = (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } };

/* ---------------- jsdom, същият модел като в v2414-print ---------------- */
function scriptOrder() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}
function apiMock(overrides, calls) {
  function node(parts) {
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return node(parts.concat(prop));
      },
      apply(t, self, args) {
        const key = parts.join('.');
        if (calls) (calls[key] = calls[key] || []).push(args[0]);
        const has = Object.prototype.hasOwnProperty.call(overrides, key);
        const v = has ? overrides[key] : null;
        const out = typeof v === 'function' ? v(args) : v;
        // Стойност { __fail: '…' } симулира {ok:false} от главния процес.
        if (out && out.__fail) return Promise.resolve({ ok: false, error: out.__fail });
        return Promise.resolve({ ok: true, data: out });
      }
    });
  }
  return node([]);
}
function buildDom(overrides) {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  dom.calls = {};
  dom.toasts = [];
  dom.confirmAnswer = true;
  window.api = apiMock(overrides || {}, dom.calls);
  window.confirm = () => dom.confirmAnswer;
  window.alert = () => {};
  window.print = () => {};
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const run = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  run(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  for (const f of scriptOrder()) run(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'), `views/${f}`);
  if (errors.length) assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n---\n'));
  // toast() се прихваща СЛЕД зареждането, за да записва без да пипа core.js.
  const realToast = window.toast;
  window.toast = (msg, type) => { dom.toasts.push([String(msg), type]); return realToast && realToast(msg, type); };
  return dom;
}
const settle = () => new Promise(r => setTimeout(r, 40));
const printed = (w) => w.document.querySelector('#ppSheet').textContent.replace(/\s+/g, ' ');

/* ==================================================================
   1. ЛИЧНИ ДАННИ — дефект в собствената ми поправка
   ================================================================== */

test('частично повредени записи не заключват достъпа до останалите', () => {
  /* Виж fixes-audit-v2414.test.js за пълния разказ. Тук се пази обратната
     посока: сесия, в която ЧАСТ от редовете не се четат, трябва да остане
     използваема, а само засегнатите полета да носят надписа. */
  const { db, dir } = freshDb('inv-v2416-pdp-');
  db.exec("ALTER TABLE settings ADD COLUMN pdp_salt TEXT");
  db.exec("ALTER TABLE settings ADD COLUMN pdp_verifier TEXT");
  const pii = require('../pii-crypto');
  const ipcMain = fakeIpcMain();
  const audit = [];
  const ret = require('../handlers/pdp')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: (a, d) => audit.push(d)
  });
  ipcMain.invoke('pdp:setup', 'редовна-парола-11');
  const key = pii.deriveKey('редовна-парола-11',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
  const ins = db.prepare("INSERT INTO readers (name, egn) VALUES (?, ?)");
  ins.run('Повреден', pii.encryptField('0000000000', pii.deriveKey('чужда-9999', pii.generateSalt(2))));
  for (let i = 1; i <= 5; i++) ins.run('Читател ' + i, pii.encryptField('750101000' + i, key));

  const rows = ret.maskReaderRows(db.prepare('SELECT * FROM readers ORDER BY id').all());
  assert.equal(ipcMain.invoke('pdp:status').data.stale, false);
  assert.equal(rows.filter(r => /ключът не съвпада/.test(r.egn)).length, 1, 'само повреденият ред');
  assert.equal(rows[2].egn, '7501010002', 'останалите се четат');
  assert.ok(audit.some(d => /не се разчитат/.test(d)),
    'засегнатите записи трябва да влязат в ОДИТНАТА СЛЕДА, не само в дневника за грешки');
});

/* ==================================================================
   2. ЕКРАНЪТ
   ================================================================== */

test('смяната на филтър в „Книги“ изчиства избора', async () => {
  /* Търсенето изчистваше избора, двата филтъра — не. Отмяташ 200 детски книги,
     сменяш филтъра на „за възрастни“, отмяташ още 3 и натискаш „Групова
     редакция“ — към главния процес тръгват 203 идента, от които 200 за документи,
     които не се виждат никъде на екрана. Груповата редакция сама предупреждава, че
     не може да бъде отменена. */
  const books = [
    { id: 1, inv_number: 1, title: 'Детска', author: 'А', department: 'за деца', status: 'наличен', quantity: 1, available: 1 },
    { id: 2, inv_number: 2, title: 'Детска 2', author: 'Б', department: 'за деца', status: 'наличен', quantity: 1, available: 1 },
    { id: 3, inv_number: 3, title: 'Възрастна', author: 'В', department: 'за възрастни', status: 'наличен', quantity: 1, available: 1 }
  ];
  const dom = buildDom({ 'books.list': books, 'categories.list': [], 'authorities.values': [] });
  const { window } = dom;
  await settle();
  window.location.hash = '#books';
  await window.route();
  await settle();
  // BOOKS_SELECTED е лексикална глобална в core-обхвата на документа, не върху
  // window — затова се чете през window.eval, както прави и fixes-render-limits.
  window.eval('BOOKS_SELECTED.add(1); BOOKS_SELECTED.add(2);');
  assert.equal(window.eval('BOOKS_SELECTED.size'), 2);
  window.eval("BOOKS_FILTER_DEPT = 'за възрастни';");
  window.booksFilterChanged();
  assert.equal(window.eval('BOOKS_SELECTED.size'), 0,
    'редове, които вече не се виждат, не бива да остават избрани');
});

test('„Инвентаризация“ не поваля екрана, когато базата е заета', async () => {
  /* call() връща null при {ok:false} — на мрежов дял това е SQLITE_BUSY. Рендерът
     гърмеше на sessions.length: заглавието и менюто вече казваха
     „Инвентаризация“, а в тялото стоеше предишният екран. */
  const dom = buildDom({
    'inventorySessions.requirement': { active: 100, pct: 10, target: 10, scannedYear: 0, naturalLoss: 0 },
    'inventorySessions.list': { __fail: 'database is locked' },
    'settings.get': {}
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#invent';
  await window.route();
  await settle();
  const body = window.document.querySelector('#view').textContent;
  assert.match(body, /Чл\. 40/, 'екранът трябва да се изчертае, а не да остане предишният');
  assert.match(body, /Няма извършени проверки/);
});

test('протоколът от инвентаризация се отпечатва', async () => {
  /* Домейн находка: и двата бутона се казваха „Приключи и състави протокол“, а
     такъв документ никъде не се съставяше — от 22 разпечатки в програмата нито
     една не беше този протокол. Инвентаризацията по чл. 40 е основна точка при
     проверка, а протоколът с подписите на комисията е това, което се предава. */
  const dom = buildDom({
    'inventorySessions.get': {
      id: 3, date: '2026-04-01', scope: 'целият фонд', department: null, mode: 'representative',
      pool_size: 120, closed: 1, committee1: 'А. Иванова', committee2: 'Б. Петров', committee3: 'В. Георгиев',
      scans: [{ inv_number: 1, title: 'Едно' }, { inv_number: 2, title: 'Две' }],
      missing: [{ inv_number: 7, author: 'Вазов', title: 'Под игото', price: 10 }]
    },
    'settings.get': {}
  });
  const { window } = dom;
  await settle();
  await window.printInventProtocol(3);
  await settle();
  const t = printed(window);
  assert.match(t, /ПРОТОКОЛ/);
  assert.match(t, /от извършена инвентаризация/);
  assert.match(t, /чл\. 40/, 'основанието трябва да е изписано');
  assert.match(t, /А\. Иванова/, 'комисията трябва да е поименно');
  assert.match(t, /Документи в обхвата: 120/);
  assert.match(t, /Проверени документи: 2/);
  assert.match(t, /Под игото/, 'липсващите се изброяват поименно');
  assert.match(t, /два екземпляра/);
  assert.match(t, /представителна/, 'видът на проверката трябва да е изписан — той е нормативно различен');
  // И бутонът, който го извиква, съществува в списъка с приключени проверки.
  const src = fs.readFileSync(path.join(VIEWS_DIR, 'inventory-sessions.js'), 'utf8');
  assert.match(src, /printInventProtocol\(\$\{s\.id\}\)/, 'протоколът трябва да е достижим от списъка');
  assert.match(src, /window\.printInventProtocol = printInventProtocol/);
});

test('излизането от проверка казва истината и сесията остава достижима', async () => {
  /* „Прекрати“ питаше „Прекратяване без запис?“ — но всяко сканиране вече е в
     базата. По-лошото: INVENT_SESSION беше единственият път към отворена сесия, а
     редовете в списъка нямаха нито един бутон. Изоставената проверка оставаше
     отворена завинаги и продължаваше да брои към годишната норма. */
  const src = fs.readFileSync(path.join(VIEWS_DIR, 'inventory-sessions.js'), 'utf8');
  assert.ok(!/confirm\('Прекратяване без запис\?'\)/.test(src),
    'въпросът беше неверен — сканиранията вече са записани в базата');
  assert.match(src, /function resumeInvent/, 'отворена сесия трябва да се отваря отново');

  const dom = buildDom({
    'inventorySessions.requirement': { active: 100, pct: 10, target: 10, scannedYear: 4, naturalLoss: 0 },
    'inventorySessions.list': [{ id: 5, date: '2026-04-01', scope: 'целият фонд', pool_size: 100, scanned: 4, missing: 0, closed: 0 }],
    'settings.get': {}
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#invent';
  await window.route();
  await settle();
  const html = window.document.querySelector('#view').innerHTML;
  assert.match(html, /resumeInvent\(5\)/, 'отворената сесия трябва да има бутон „Продължи“');
});

test('справка, която се провали, не оставя старата под новото заглавие', async () => {
  /* `if (!r) return;` се връщаше преди да пипне каквото и да е: #repBody оставаше
     на „Зареждане…“, а window._REPORT продължаваше да сочи ПРЕДИШНАТА справка —
     тоест „Печат / PDF“ отпечатваше старите числа под заглавието на
     новоизбраната справка. */
  const dom = buildDom({
    'reports.list': [{ id: 'readers_by_category', title: 'Читатели по категории' }],
    'reports.run': { __fail: 'database is locked' },
    'settings.get': {}
  });
  const { window } = dom;
  await settle();
  // Предишна, успешно заредена справка стои в паметта.
  window._REPORT = { id: 'fund_breakdown', title: 'Разбивка на фонда', rows: [['Книги', 5]] };
  window.eval("REPORT_ID = 'readers_by_category';");
  await window.renderReports();
  await settle();
  assert.equal(window._REPORT, null,
    'провалената справка не бива да остави предишната заредена — иначе печатът дава чужди числа');
  const body = window.document.querySelector('#repBody').textContent;
  assert.ok(!/Зареждане/.test(body), 'екранът не бива да остане на „Зареждане…“');
  assert.match(body, /не можа да бъде изготвена/);
  // И печатът вече не мълчи, а казва защо не прави нищо.
  window.printReportDoc();
  assert.ok(dom.toasts.some(t => /изберете справка/i.test(t[0])));
});

test('изтриването на МЗС заявка не съобщава успех след провал', async () => {
  const dom = buildDom({ 'mzs.delete': { __fail: 'database is locked' }, 'mzs.list': [], 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.delMzs(1);
  await settle();
  assert.ok(!dom.toasts.some(t => t[0] === 'Изтрито.'),
    'при провал не бива да излиза зелено „Изтрито.“ — дотук излизаха ДВЕ противоречиви съобщения');
});

test('читателският картон казва, че историята е отрязана', async () => {
  const loans = Array.from({ length: 32 }, (_, i) => ({
    date_out: '2026-01-0' + (i % 9 + 1), inv_number: i + 1, title: 'Книга ' + i, date_due: '2026-02-01', date_in: null
  }));
  const dom = buildDom({
    'readers.get': { id: 1, name: 'Иван', card_no: 'INV-1', category: 'възрастен', registered_at: '2020-01-01' },
    'loans.byReader': loans, 'settings.get': {}
  });
  const { window } = dom;
  await settle();
  await window.printReaderCard(1);
  await settle();
  const t = printed(window);
  assert.match(t, /Показани са последните 14 заемания от общо 32/,
    'срязването беше зашито и не се споменаваше никъде на листа');
});

test('КДБФ разпечатката казва, когато няма движение, и показва наличността към 01.01', async () => {
  const dom = buildDom({ 'settings.get': {} });
  const { window } = dom;
  await settle();
  window._KDBF_REPORT = {
    year: '2026', part1: [], part3: [], stockEnd: { n: 100, v: 1000 },
    acquiredYear: { n: 0, v: 0 }, deaccYear: { n: 0, v: 0 }
  };
  window.printKdbfDoc();
  await settle();
  const t = printed(window);
  assert.match(t, /няма регистрирани постъпления/, 'празна таблица без дума изглежда като дефект на печата');
  assert.match(t, /няма отчислени документи/);
  assert.match(t, /Наличност към 01\.01\.2026/, 'началната наличност е началото на самото движение');
  assert.match(t, /Наличност към 31\.12\.2026/);
});

/* ==================================================================
   3. ОФИЦИАЛНИ ДОКУМЕНТИ И ЦИТАТИ
   ================================================================== */

test('обявена стойност, равна на сбора до стотинка, не ражда „Забележка“', async () => {
  /* Дефект в собствената ми поправка от v2.4.14: `total !== acqValue(items)`
     сравняваше две числа с плаваща запетая. 10.10 + 20.20 дава 30.299999…, а
     обявеното е 30.30 — измерено, бележката излизаше на около една от всеки три
     партиди, при това с ДВА ОТПЕЧАТАНИ ЕДНАКВИ израза от двете страни на „се
     различава от“. Тоест поправката, която махаше вътрешното противоречие от
     заместващ първичен счетоводен документ, го създаваше сама. */
  const acq = {
    id: 1, no: 1, year: '2026', date: '2026-02-02', how: 'закупуване', from_source: 'Книжарница',
    doc_type: 'без документ', doc_no: '1', doc_date: '2026-02-02', total_count: 2, sum: 30.30,
    items: [
      { inv_number: 1, author: 'А', title: 'Първа', year: '2020', price: 10.10, fund_qty: 1 },
      { inv_number: 2, author: 'Б', title: 'Втора', year: '2021', price: 20.20, fund_qty: 1 }
    ]
  };
  assert.notEqual(10.10 + 20.20, 30.30, 'предпоставката: сборът НЕ е точно равен като число');
  const dom = buildDom({ 'acquisitions.get': acq, 'settings.get': {} });
  const { window } = dom;
  await settle();
  await window.printAcqNoDocDoc(1);
  await settle();
  /* v2.4.17 преименува трите пояснения на „Относно стойността / броя / описа“,
     защото могат да излязат едновременно и три абзаца „Забележка:“ подред са
     нечитаеми. Проверява се самото ТВЪРДЕНИЕ, а не етикетът. */
  assert.ok(!/се различава от/.test(printed(window)),
    'равни до стотинка суми не бива да раждат бележка за разминаване');

  // А истинско разминаване продължава да се съобщава.
  const dom2 = buildDom({ 'acquisitions.get': Object.assign({}, acq, { sum: 25 }), 'settings.get': {} });
  await settle();
  await dom2.window.printAcqNoDocDoc(1);
  await settle();
  assert.match(printed(dom2.window), /Относно стойността[\s\S]{0,120}се различава от/);
});

test('чл. 30, т. 7 се отпечатва цял', () => {
  /* На подписан акт се печаташе „Неизползваеми носители на информация“ без
     квалификацията „които нямат статута на културна ценност“ — а тя е цялата
     предпазна мярка срещу отчисляване на културна ценност. */
  const src = fs.readFileSync(path.join(VIEWS_DIR, 'core.js'), 'utf8');
  assert.match(src, /Неизползваеми носители на информация, които нямат статута на културна ценност/);
});

test('напомнителното писмо не приписва размера на обезщетението на наредбата', () => {
  /* чл. 43, ал. 2 предвижда обезщетение, „регламентирано в правилата“ на самата
     библиотека — размер в наредбата няма. Писмото искаше пари от гражданин,
     позовавайки се на норматив, който не съдържа сумата. */
  const src = fs.readFileSync(path.join(VIEWS_DIR, 'logo-org.js'), 'utf8');
  assert.ok(!/лв\.\/ден забава по чл\. 43, ал\. 2/.test(src), 'старата формулировка не бива да остава');
  assert.match(src, /Правилата за обслужване/, 'основанието е правилата на библиотеката');
  assert.match(src, /приети на основание чл\. 43, ал\. 2/, 'а те се приемат на основание чл. 43, ал. 2');
});

test('напомнителните писма се вписват с текущата степен, не със сутрешната', () => {
  /* Степените се четяха от window._REMINDERS, което се пълни само при отваряне на
     прозореца „Напомняния“ и после живее до края на сесията: изпращаш няколко по
     имейл (всяко вдига степента на следващото), после печаташ — вписваше се
     сутрешната степен и ескалацията спираше. Ако прозорецът изобщо не е отварян,
     всички се вписваха като степен 1. */
  const src = fs.readFileSync(path.join(VIEWS_DIR, 'logo-org.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function printOverdueNotices'), src.indexOf('window.printOverdueNotices'));
  assert.match(fn, /await call\(window\.api\.loans\.reminders\(\)\)/,
    'степените трябва да се изтеглят наново в момента на печата');
});

/* ==================================================================
   4. ДАННИ И СХЕМА
   ================================================================== */

test('отчислен документ не се изтрива — минали години не се променят със задна дата', () => {
  /* stockAt() в КДБФ чете живата таблица books за наличността на ВСЯКА минала
     година, а отчисленията идват от замразената снимка. Изтриването на отчислен
     ред променяше наличността към 31.12 на години, чиито КДБФ вече е отпечатан.
     Груповата редакция отдавна беше защитена; пътят за изтриване — не. */
  const { db } = freshDb('inv-v2416-del-');
  const ipcMain = fakeIpcMain();
  require('../handlers/books')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-01-01',
    dialog: {}, getMainWindow: () => null, fs, path, csvCell: (x) => String(x ?? ''),
    normalizeScanCode: (c) => String(c || '').trim() || null,
    scheduleCatalogWrite: () => {}, cnSortKey: (x) => String(x || ''), ftsSync: () => {}
  });
  const id = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (9, 'Отчислена', 'отчислен')").run().lastInsertRowid;
  const res = ipcMain.invoke('books:delete', id);
  assert.equal(res.ok, false, 'отчислен документ не се заличава');
  assert.match(res.error, /чл\. 39/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 1);

  // Наличен документ без история продължава да се изтрива както преди.
  const ok = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (10, 'Сгрешена', 'наличен')").run().lastInsertRowid;
  assert.equal(ipcMain.invoke('books:delete', ok).ok, true);
});

test('разделителят на изявления издържа враждебен SQL', () => {
  /* Три отделни дупки, всяка от които мълчаливо разрушава схемата по РЕЗЕРВНАТА
     пътека: CASE…END вътре в тригер се четеше за край на блока (тригерът
     изчезваше, а остатъкът от тялото му се изпълняваше като обикновени
     изявления върху живата база); идентификатор `end_date` също минаваше за
     ключовата дума; а блоков коментар с апостроф вътре отваряше състояние „низ“,
     което никога не се затваря — целият остатък от файла се слепваше в едно
     изявление. */
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function splitSqlStatements'), main.indexOf('function resolveDbDir'));
  const split = new Function(fn + '; return splitSqlStatements;')();

  const trigWithCase = "CREATE TRIGGER t AFTER INSERT ON b BEGIN SELECT CASE WHEN NEW.s IS NULL THEN RAISE(ABORT,'x') END; DELETE FROM tmp; END;";
  assert.equal(split(trigWithCase).length, 1, 'CASE…END вътре в тригер не затваря блока');
  const trigWithIdent = "CREATE TRIGGER t2 AFTER INSERT ON b BEGIN UPDATE x SET end_date = NULL; UPDATE x SET k=1; END;";
  assert.equal(split(trigWithIdent).length, 1, '`end_date` не е ключовата дума END');
  const withBlockComment = "/* librarian's note */ CREATE TABLE q2 (a); CREATE TABLE q3 (b);";
  assert.equal(split(withBlockComment).length, 2, 'апострофът в блоков коментар не бива да поглъща файла');

  // И истинската схема продължава да се разделя вярно и да се изпълнява цяла.
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const parts = split(schema);
  assert.equal(parts.filter(p => /CREATE TRIGGER/i.test(p)).length, 1);
  const { db } = freshDb('inv-v2416-split-');
  db.exec('DROP TRIGGER IF EXISTS trg_loans_capacity');
  const failed = [];
  for (const st of parts) { try { db.exec(st); } catch (e) { failed.push(e.message + ' || ' + st.slice(0, 50)); } }
  assert.deepEqual(failed, []);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_loans_capacity'").get());
});

test('годишният напредък по чл. 40 брои различни документи и в екрана „Инвентаризация“', () => {
  /* Същата поправка беше направена за Таблото във v2.4.14, но не и тук —
     „поправено на едно от две места“. Екранът сумираше s.scanned по сесии, тоест
     документ, проверен в пролетна и в есенна проверка, се броеше два пъти и
     програмата можеше да обяви нормата за изпълнена при неизпълнена. */
  const { db } = freshDb('inv-v2416-norm-');
  const ipcMain = fakeIpcMain();
  require('../handlers/inventory-sessions')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {},
    pctRequired: () => 10, naturalLoss: () => 0,
    normalizeScanCode: (c) => String(c || '').trim() || null
  });
  const y = new Date().getFullYear();
  const b = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1,'К','наличен')").run().lastInsertRowid;
  const s1 = db.prepare('INSERT INTO inventory_sessions (date) VALUES (?)').run(y + '-03-01').lastInsertRowid;
  const s2 = db.prepare('INSERT INTO inventory_sessions (date) VALUES (?)').run(y + '-10-01').lastInsertRowid;
  db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?,?)').run(s1, b);
  db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?,?)').run(s2, b);
  const req = ipcMain.invoke('inventorySessions:requirement');
  assert.equal(req.ok, true, req.error);
  assert.equal(req.data.scannedYear, 1, 'един документ в две проверки е ЕДИН проверен документ');

  // И екранът вече чете това число, вместо да сумира сесиите сам.
  const src = fs.readFileSync(path.join(VIEWS_DIR, 'inventory-sessions.js'), 'utf8');
  assert.match(src, /req\.scannedYear/);
  assert.ok(!/yearSessions\.reduce/.test(src), 'сумирането по сесии не бива да остава');
});

test('файлът за изключения не носи подписа на замаскиран PowerShell и казва какво прави', () => {
  /* -ExecutionPolicy Bypass при -EncodedCommand не прави НИЩО (политиката важи за
     скриптови файлове), но заедно с -NoProfile и -EncodedCommand допълва точно
     подписа, по който Defender („Block execution of potentially obfuscated
     scripts“) и SmartScreen разпознават замаскиран PowerShell. Това е
     единственият файл в програмата, чиято цел е да оцелее пред недоволна
     антивирусна. Освен това след @echo off не се печаташе нищо: при блокиран
     PowerShell библиотекарят виждаше черен прозорец и „натиснете клавиш“. */
  const cap = {};
  require('../handlers/security-exclusions')({ handle: (n, fn) => { cap[n] = fn; } }, {
    getDb: () => ({ prepare: () => ({ get: () => ({ catalog_folder: 'C:\\Каталог' }) }) }),
    run: runDep, logAudit: () => {}, dialog: {}, getMainWindow: () => null, fs, path,
    app: { getPath: () => 'C:\\Users\\bib\\AppData\\Roaming\\inventar-desktop' },
    resolveDbDir: () => '\\\\SERVER\\biblioteka'
  });
  const info = cap['security:exclusionInfo']().data;
  assert.equal(info.rejected.length, 0);
  assert.ok(info.safe.includes('C:\\Каталог'));

  // Самото съдържание на файла, не само отчетът за него.
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-v2416-bat-'));
  const out = path.join(dir, 'excl.bat');
  const cap2 = {};
  require('../handlers/security-exclusions')({ handle: (n, fn) => { cap2[n] = fn; } }, {
    getDb: () => ({ prepare: () => ({ get: () => ({ catalog_folder: 'C:\\Каталог' }) }) }),
    run: runDep, logAudit: () => {},
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: out }) },
    getMainWindow: () => null, fs, path,
    app: { getPath: () => 'C:\\Users\\bib\\AppData\\Roaming\\inventar-desktop' },
    resolveDbDir: () => '\\\\SERVER\\biblioteka'
  });
  return cap2['security:writeExclusionScript']().then(() => {
    const txt = fs.readFileSync(out, 'latin1');
    assert.ok(!/ExecutionPolicy/.test(txt),
      'ключът не прави нищо при -EncodedCommand, но допълва подписа за евристиките на антивирусните');
    assert.match(txt, /echo Adding Windows Defender exclusions/,
      'при блокиран PowerShell библиотекарят вижда черен прозорец и „натиснете клавиш“ — трябва поне един ред');
    assert.equal([...fs.readFileSync(out)].filter(b => b > 127).length, 0, 'файлът остава чист ASCII');
  });
});
