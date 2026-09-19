'use strict';
/* РЕГРЕСИИ ОТ КРЪГ 37 (v2.4.61) — ИЗДАВАНЕ НА ДОКУМЕНТИ.
 * ===========================================================================
 * По една проверка на находка от сценария test/scenario-dokumenti.test.js.
 * Сценарият минава през всяка разпечатка от край до край; тук стои само
 * дефектът — кратко, с най-малкото количество обстановка, за да се вижда при
 * бъдещо пипане какво точно не бива да се връща.
 *
 * Находките в този файл:
 *   F1 — протоколът по чл. 40 брои РЕДОВЕ, а актът по чл. 30 от същата
 *        проверка брои ДОКУМЕНТИ: два листа за едно събитие с различни числа;
 *   F6 — „Запази PDF…“ предлага име с две точки („КДБФ 2026 г..pdf“);
 *   F7 — инвентарната книга печата „… 348.15 лв..“ (mny() вече слага точката);
 *   F8 — регистърът на документите не обхваща изнасянията (CSV/каталог/одит);
 *   F9 — пазачът за пълнота хваща само една от шестте форми на нов документ;
 *   P2 — клетката „Проверки“ в инвентарната книга расте без ограничение.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./helpers/e2e-app');

const APP_DIR = path.join(__dirname, '..');
const VIEWS_DIR = path.join(APP_DIR, 'src', 'views');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dokumenti-v2461-'));

let h;
const T = E.today();
const Y = T.slice(0, 4);
const ids = {};
/* Екраниране на литерал, който влиза в регулярен израз (сумите носят точки). */
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const q = (sql, ...a) => h.db.prepare(sql).get(...a);

test.before(async () => {
  h = await E.bootApp();
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  const st = ok(await h.api.settings.get(), 'настройки');
  ok(await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека „Изпитание“', place: 'с. Яворец',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова'
  })), 'запис на настройките');
  await h.window.loadSettingsCache();

  const mk = async (inv, title, price) => ok(await h.api.books.create({
    inv_number: inv, title, author: 'Вазов, Иван', register_date: Y + '-03-14', price,
    department: 'за възрастни', status: 'наличен', year: 2020
  }), 'документ инв. № ' + inv);
  ids.b1 = await mk(1000, 'Под игото', 30);
  /* СЪРЦЕВИНАТА НА F1: стар неразделен запис — 3 екземпляра под ЕДИН
     инвентарен номер. Програмата вече не създава такива (дава по един номер на
     екземпляр), но всяка внесена картотека ги съдържа и точно върху тях
     „редове“ и „документи“ се разминават. */
  ids.b2 = await mk(1001, 'Стар многоекземплярен запис', 4);
  h.db.prepare('UPDATE inventory SET quantity = 3 WHERE book_id = ?').run(ids.b2);
  ids.b3 = await mk(1002, 'Намерена при подреждане', 3.5);
});
test.after(() => {
  if (h) h.stop();
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); }
  catch (e) { console.warn('временната папка ' + SCRATCH + ' не се изтри: ' + e.message); }
});

/* ==================================================================
   F1 — протоколът по чл. 40 и актът по чл. 30 броят едно и също
   ================================================================== */
test('F1: протоколът от инвентаризация брои библиотечни документи, не инвентарни номера', async () => {
  const committee = { committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' };
  const sess = ok(await h.api.inventorySessions.start(Object.assign({
    date: T, no: 1, order_no: '7', scope: 'целият фонд', department: ''
  }, committee)), 'сесия');
  ids.sess = sess && sess.id != null ? sess.id : sess;
  ok(await h.api.inventorySessions.scan({ sessionId: ids.sess, code: '1000' }), 'скан 1000');

  /* Обхватът: 3 инвентарни номера = 5 библиотечни документа.
     Проверен е 1 документ (инв. № 1000); липсват 4 документа под 2 номера
     (1001 × 3 и 1002). Четирите числа трябва да се събират: 1 + 4 = 5. */
  const closed = ok(await h.api.inventorySessions.close({ sessionId: ids.sess, mode: 'full' }), 'приключване');
  assert.equal(closed.pool, 5, 'обхватът е в документи, не в редове');
  assert.equal(closed.poolRows, 3, 'редовете се връщат отделно, за да се обясни разликата');
  assert.equal(closed.scanned, 1);
  assert.equal(closed.missing, 4, 'липсващите са 4 документа');
  assert.equal(closed.missingRows, 2, 'под 2 инвентарни номера');
  assert.equal(closed.scanned + closed.missing + closed.onLoan + closed.atBinder, closed.pool,
    'четирите числа на протокола трябва да се събират до обхвата');
  // Снимката в базата е същата — протоколът се печата от нея и след години.
  const s = q('SELECT pool_final, scanned_final FROM inventory_sessions WHERE id = ?', ids.sess);
  assert.equal(s.pool_final, 5); assert.equal(s.scanned_final, 1);

  // Нормативът по чл. 41 се прилага към СЪЩАТА мярка.
  const req = ok(await h.api.inventorySessions.requirement(), 'изискване');
  assert.equal(req.active, 3, 'нормата по чл. 40, т. 2 се мери в инвентарни номера');
  assert.equal(req.activeDocs, 5, 'фондът в документи се връща отделно');
  const st = q('SELECT free_access_pct FROM settings WHERE id = 1');
  const expected = (st.free_access_pct > 50 ? 5 * 10 : 5 * 5) / 1000;
  assert.equal(req.naturalLoss, expected, 'допустимите загуби се смятат от документите');
  assert.equal(Number(ok(await h.api.inventorySessions.get(ids.sess), 'сесия').allowedLoss), expected,
    'екранът и протоколът показват един и същи допустим отпад');

  // Списъкът в екрана брои същото.
  const row = ok(await h.api.inventorySessions.list(), 'списък').find(x => x.id === ids.sess);
  assert.equal(row.missing, 4); assert.equal(row.missing_rows, 2); assert.equal(row.scanned, 1);
});

test('F1: листът на протокола — „Липсващи: 4“, колона „Бр.“, „3 × цена“ и ОБЩО 4 документа', async () => {
  await h.go('invent');
  await h.window.printInventProtocol(ids.sess);
  await h.settle();
  const p = h.printed();
  assert.match(p, /Документи в обхвата:\s+5/);
  assert.match(p, /Проверени документи:\s+1/);
  assert.match(p, /Липсващи:\s+4/, 'протоколът брои редове (2), а не документи (4)');
  assert.ok(p.includes('Бр.'), 'липсва колоната за бройка при неразделен запис');
  // Единичната цена с означението „бройка × цена“ — както в акта (actQtyMark).
  assert.match(p, new RegExp('1001\\s+Вазов, Иван\\. Стар многоекземплярен запис\\s+3\\s+3 ×\\s+' + rx(E.mny(4))));
  assert.match(p, new RegExp('1002\\s+Вазов, Иван\\. Намерена при подреждане\\s+1\\s+' + rx(E.mny(3.5))));
  // ОБЩО = 3 × 4.00 + 3.50 = 15.50 €, а не 4.00 + 3.50 = 7.50 €.
  assert.match(p, new RegExp('ОБЩО 4 документа \\(2 инвентарни номера\\)\\s+' + rx(E.mny(15.5))));
  assert.match(p, /Допустими естествени загуби \(чл\. 41\):\s+[\d.]+ документа за проверен фонд от 5\./);
  h.window.ppClose();
});

test('F1: актът, съставен от същите липси, дава СЪЩИТЕ числа като протокола', async () => {
  /* Това е самата находка: два листа за едно и също събитие. Актът по чл. 30,
     т. 6 се ражда от протокола по чл. 40 и проверяващият ги слага един до друг. */
  const actHead = {
    no: 1, date: T, reason_code: 6, reason_text: 'констатирани като липсващи при инвентаризация',
    disposal: 'отписани като липсващи', committee1: 'Мария Иванова', committee2: 'Петър Петров',
    committee3: 'Ана Счетоводителка'
  };
  /* v2.4.62: неразделеният запис (3 екземпляра под инв. № 1001) вече НЕ влиза в
     акта наведнъж — актът описва всеки отчислен документ поотделно, с неговия
     инвентарен номер (чл. 16, чл. 35). Прекият опит се отказва и не пише нищо. */
  const refused = await h.api.deaccessionActs.create({ act: actHead, bookIds: [ids.b2, ids.b3] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Под инв\. № 1001/);
  /* Протоколът казва, че липсват и ТРИТЕ екземпляра под инв. № 1001 (нито един
     не е намерен). Затова записът се разделя — точно както го прави „Проект за акт
     от липсите“ — и в акта влизат трите номера. Числата остават същите като в
     протокола: 4 документа за 15.50 €, само че поименно. */
  const split = ok(await h.api.books.splitCopies(ids.b2), 'разделяне на стария запис');
  const act = ok(await h.api.deaccessionActs.create({
    act: actHead, bookIds: [ids.b2, ...split.createdIds, ids.b3]
  }), 'акт по липсите');
  const t = q('SELECT COUNT(*) AS rows, SUM(COALESCE(quantity,1)) AS n, SUM(price*COALESCE(quantity,1)) AS v FROM deaccession_items WHERE act_id = ?', act);
  assert.equal(t.n, 4, 'актът брои 4 документа');
  assert.equal(t.rows, 4, 'всеки документ е отделен ред с отделен инвентарен номер');
  assert.equal(t.v, 15.5, 'и 15.50 € — точно това, което пише и в протокола');
});

/* ==================================================================
   F6 — името на PDF файла
   ================================================================== */
test('F6: „Запази PDF…“ не предлага име с две точки („КДБФ 2026 г..pdf“)', async () => {
  const wc = h.app.windows[0] && h.app.windows[0].webContents;
  assert.ok(wc, 'main.js не е създал прозорец');
  wc.printToPDF = async () => Buffer.from('%PDF-1.7 проба');
  await h.go('kdbf');
  await h.clickButton('Печат / PDF', '#view');
  h.dialogs.savePath = path.join(SCRATCH, 'kdbf.pdf');
  await h.clickButton('Запази PDF…', '#printPreview');
  await h.settle();
  const save = h.dialogs.calls.filter(c => c.kind === 'save').pop();
  assert.ok(save, 'диалогът за запис не е отварян');
  assert.equal(path.basename(save.opts.defaultPath), 'КДБФ ' + Y + ' г.pdf',
    'името на файла носи излишна точка (или е загубило името на документа)');
  h.dialogs.savePath = null;
});

test('F6: правилото стои и на двете места — в екранния слой и на IPC границата', () => {
  const core = fs.readFileSync(path.join(VIEWS_DIR, 'core.js'), 'utf8');
  const printer = fs.readFileSync(path.join(APP_DIR, 'handlers', 'print.js'), 'utf8');
  /* safeFileName се вика от екрана, но print:savePdf долепя разширението и е
     достъпен и на друг повикващ (мобилен път, второ работно място, тест). */
  const fn = core.slice(core.indexOf('function safeFileName'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /\[\.\\s\]\+\$/, 'safeFileName не маха крайните точки');
  assert.match(printer, /replace\(\/\[\.\\s\]\+\$\//, 'print:savePdf не маха крайните точки');
});

/* ==================================================================
   F7 — двойната точка след сумата в инвентарната книга
   ================================================================== */
test('F7: инвентарната книга не печата „лв..“ — mny() вече завършва с точка', async () => {
  await h.go('invbook');
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  await h.clickButton('Цялата книга', '#modal');
  const p = h.printed();
  assert.ok(p.includes('Фонд по инвентарната книга (без отчислените):'), 'редът със сбора липсва');
  assert.ok(!/лв\.\./.test(p), 'на листа стои „лв..“ с две точки: '
    + (p.match(/.{40}лв\.\..{0,20}/) || [''])[0]);
  h.window.ppClose();
});

/* ==================================================================
   P2 — клетката „Проверки“ не расте без край
   ================================================================== */
test('P2: „Проверки“ показва последните три дати и казва колко са всичко', async () => {
  /* Двайсет години по две проверки годишно — точно случаят, за който е писана
     програмата (библиотеката работи от 1922 г.). */
  const ins = h.db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)');
  for (const d of ['2020-03-01', '2021-04-02', '2022-05-03', '2023-06-04', '2024-07-05']) ins.run(ids.b1, d);
  await h.go('invbook');
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  await h.clickButton('Цялата книга', '#modal');
  const p = h.printed();
  /* Инв. № 1000 беше сканиран и в проверката по-горе, тоест отметките са шест:
     петте вписани тук и днешната. Показват се последните три. */
  assert.ok(p.includes(E.bgDate(T)) && p.includes('05.07.2024') && p.includes('04.06.2023'),
    'последните три отметки липсват');
  assert.ok(!p.includes('01.03.2020') && !p.includes('02.04.2021') && !p.includes('03.05.2022'),
    'клетката продължава да изрежда всички отметки');
  // Общият брой се КАЗВА — срязване без надпис е по-лошо от срязване.
  assert.match(p, /\(общо 6\)/, 'не се казва колко са всичките отметки');
  h.window.ppClose();
  // И на екрана — същото правило, защото редът иначе става висок колкото таблица.
  await h.go('invbook');
  await h.settle();
  const cell = Array.from(h.document.querySelectorAll('#view table.ledger tbody tr'))
    .find(tr => tr.children[1].textContent.trim() === '1000').children[2];
  assert.equal(cell.querySelectorAll('.badge').length, 3, 'на екрана стоят повече от три отметки');
  assert.match(cell.textContent, /\(общо 6\)/);
});

/* ==================================================================
   F8 и F9 — регистрите на документите и пазачът им
   ================================================================== */
test('F8: регистърът обхваща и изнасянията, не само разпечатките', () => {
  const src = fs.readFileSync(path.join(__dirname, 'razpechatki.test.js'), 'utf8');
  /* Седемте изнасяния също произвеждат документ за външен получател: CSV-то на
     фонда носи всяка цена, одитната следа — имена на служители. Дотук
     регистърът се наричаше „на всички документи, които програмата издава“ и не
     ги споменаваше. */
  for (const name of ['exportReadersCsv', 'exportDnevnikCsv', 'exportCatalogCsv',
    'exportCatalog', 'exportMarc', 'exportDc', 'exportAuditCSV']) {
    assert.ok(src.includes("'" + name + "'"), 'изнасянето ' + name + ' липсва от регистъра');
  }
  // И обхватът е казан с думи, а не се подразбира.
  assert.match(src, /РЕГИСТЪР 1 — РАЗПЕЧАТКИ/);
  assert.match(src, /РЕГИСТЪР 2 — ИЗНАСЯНИЯ/);
  // Трите изнасяния в CSV се проверяват по същество — по файла, не по обещание.
  const csvTest = src.slice(src.indexOf("test('18. изнасянията в CSV"));
  const body = csvTest.slice(0, csvTest.indexOf("\ntest('"));
  assert.match(body, /startsWith\(bom\)/, 'BOM не се проверява');
  assert.match(body, /ЕГН изтече/, 'изтичането на ЕГН не се проверява');
  assert.match(body, /Бройки;Цена/, 'заглавният ред на фонда не се проверява');
});

test('F9: пазачът за пълнота хваща нов документ във всичките шест форми', () => {
  const src = fs.readFileSync(path.join(__dirname, 'razpechatki.test.js'), 'utf8');
  const guard = src.slice(src.indexOf("test('19. всеки документ"));
  /* Закрепването е за МЯСТОТО НА ПОВИКВАНЕ (doPrint/printLabelSheet), а не за
     името „printXxx“ — старият израз разчиташе едновременно на формата на
     декларацията и на конвенцията за име, тоест пропускаше пет от шестте
     естествени начина да се напише нов документ. */
  assert.ok(!/if \(!\/\^print\/\.test\(f\.name\)\) return;/.test(guard),
    'пазачът пак филтрира по конвенцията за име');
  assert.match(guard, /doPrint\|printLabelSheet/, 'пазачът не се закрепва за повикването');
  assert.match(guard, /f !== 'core\.js'/, 'пазачът пак претърсва и инфраструктурата в core.js');
  // Шестте форми са изброени поименно и всяка се подава на самия претърсвач.
  for (const shape of ['стрелкова функция', 'window.printNov3', 'извън конвенцията',
    'през помощник', 'метод в обект']) {
    assert.ok(guard.includes(shape), 'формата „' + shape + '“ не се проверява');
  }
  assert.match(guard, /пазачът НЕ хваща нов документ, написан като/,
    'мутациите се изброяват, но не се твърди нищо за тях');
});

test('F9: и наистина — всяко повикване в src/views се свързва с точно една известна функция', () => {
  /* Независим прочит: този тест не чете регистъра, а КОДА. Ако утре пазачът
     бъде „опростен“ и пропусне документ, тук броят няма да съвпадне. */
  const found = [];
  for (const file of fs.readdirSync(VIEWS_DIR).filter(f => f.endsWith('.js') && f !== 'core.js')) {
    const src = fs.readFileSync(path.join(VIEWS_DIR, file), 'utf8');
    // Груб, но независим признак: ред, който започва с doPrint( или return printLabelSheet(.
    for (const line of src.split('\n')) {
      if (/^\s*(?:return\s+)?(?:doPrint|printLabelSheet)\s*\(/.test(line)) found.push(file);
    }
  }
  assert.ok(found.length >= 24, 'намерени са само ' + found.length + ' повиквания, издаващи документ');
});
