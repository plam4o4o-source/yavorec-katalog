'use strict';
/* v2.4.64 — ЕТИКЕТИТЕ И ВНОСЪТ: СЪЩИЯТ РЕЗУЛТАТ, БЕЗ ИЗЛИШНАТА РАБОТА.
 * =====================================================================
 * Двете поправки тук са ЕКВИВАЛЕНТНИ преобразувания — не се променя нито един
 * отпечатан знак и нито един внесен ред. Затова тестовете тръгват от
 * ПОВЕДЕНИЕТО и чак после гледат формата на кода:
 *
 *   1. ЕТИКЕТИ. „Баркод етикети“ минаваше през activeBooks() в
 *      src/views/logo-org.js: books.list('') БЕЗ прозорец, тоест целият фонд
 *      (15 000 реда, 4,53 МБ JSON, 87 ms в SQLite), след което диапазонът се
 *      изрязваше с .filter() в JavaScript — за да се отпечатат 300 етикета.
 *      Сега диапазонът се търси в базата по уникалния индекс на инвентарния
 *      номер и се връщат само шестте полета, които се печатат върху етикет
 *      (0,52 ms, 0,03 МБ). Доказателството, че това е същото: отпечатаният лист
 *      се сглобява по СТАРИЯ начин вътре в теста (пълният списък, филтърът и
 *      устойчивото сортиране) и се сравнява ЗНАК ПО ЗНАК с листа, който излиза
 *      от истинския екран. Етикетите се режат и лепят по реда на листа — „почти
 *      същият лист“ не съществува като понятие.
 *
 *   2. ВНОС. handlers/data-import.js компилираше двете заявки за вписване
 *      (books и inventory) ВЪТРЕ в обхождането на файла, а при файл с колона
 *      „Баркод“ и assertUniqueBarcode добавяше още две на ред. Измерено
 *      (node /tmp/r41/import-split.js, 5 000 реда): 463 ms → 215 ms, а с
 *      баркодовете 586 ms. Сега се компилират веднъж. Доказателството, че
 *      вносът е същият: същият файл се внася и се сверяват ред по ред и
 *      отчетът, и записаното в базата, включително всички откази.
 *
 * ЗА ПРАГОВЕТЕ ПО ВРЕМЕ (същата честна бележка като в perf-v2448.test.js): те
 * НЕ ловят връщането назад и не бива да се четат така — на натоварена машина
 * падат и при поправен код, а при бърза машина минават и с дефекта. Затова тук
 * мерките са ДВЕ и нито една не е часовник: броят на компилираните заявки (той
 * не зависи от машината) и големината на товара по моста. Един груб праг по
 * време е оставен само срещу нещо драстично.
 *
 * Всеки тест е проверен с мутация.
 */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { APP_DIR, cleanupTmpDirs, fakeIpcMain, freshDb, runDep } = require('./helpers/audit-fixtures');
const E = require('./helpers/e2e-app');

const BOOKS_SRC = fs.readFileSync(path.join(APP_DIR, 'handlers', 'books.js'), 'utf8');
const IMPORT_SRC = fs.readFileSync(path.join(APP_DIR, 'handlers', 'data-import.js'), 'utf8');
const LOGO_SRC = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'logo-org.js'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(APP_DIR, 'preload.js'), 'utf8');

let h = null;
const Y = E.today().slice(0, 4);
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };

test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); cleanupTmpDirs(); });

/* ==================================================================
   1. Етикетите: същият лист, знак по знак
   ================================================================== */

/* Инвентарните номера са далеч от всичко останало в базата, за да може тестът
   да говори за „фонда“, без да зависи от това какво още са създали другите
   тестове в същия процес. */
const FIRST = 5000, LAST = 5039;

test('0. подготовка: фонд за етикети — с отчислен документ, с празни полета и с ред без инвентарен номер', async () => {
  const st = ok(await h.api.settings.get(), 'настройки');
  ok(await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека при НЧ „Изпитание – 1922“', place: 'с. Яворец',
    librarian: 'Мария Иванова'
  })), 'запис на настройките');
  await h.window.loadSettingsCache();

  for (let i = FIRST; i <= LAST; i++) {
    const n = i - FIRST;
    ok(await h.api.books.create({
      inv_number: i,
      // Заглавията НЕ вървят по реда на инвентарните номера — иначе
      // подреждането „по заглавие“ и „по инвентарен номер“ съвпадат случайно и
      // тестът би минал и при сгрешен ред.
      title: 'Заглавие ' + String((n * 7) % 40).padStart(2, '0'),
      author: 'Авторов, А.', register_date: Y + '-03-14', price: 10 + n,
      department: 'Заемна', status: 'наличен', year: 2020,
      // Всеки трети документ е БЕЗ баркод (етикетът пада към инвентарния номер),
      // а всеки седми — без УДК и авторски знак (сигнатурният етикет казва това
      // с думи). И двата пътя трябва да излязат еднакви и по стария, и по новия.
      barcode: n % 3 === 0 ? null : '77' + String(i),
      udk: n % 7 === 0 ? null : '886.7-31',
      author_mark: n % 7 === 0 ? null : 'А ' + (20 + (n % 9)),
      call_number: n % 7 === 0 ? null : 'Ч-' + (800 + n)
    }), 'документ инв. № ' + i);
  }
  /* Отчисленият документ не получава етикет (v2.4.58). Статусът се слага право
     в базата: тук се проверява ФИЛТЪРЪТ на етикетите, а не редът за съставяне
     на акт по чл. 35, ал. 2 (той си има свой тест в razpechatki.test.js). */
  h.db.prepare("UPDATE books SET status = 'отчислен' WHERE inv_number = ?").run(FIRST + 10);
  /* ДВА реда БЕЗ инвентарен номер — такива идват от внесена стара база
     (колоната допуска NULL). Те са причината подреждането да не е само по
     инвентарен номер: устойчивото сортиране в JavaScript ги държеше най-отпред
     ПО ЗАГЛАВИЕ (списъкът дотам е подреден по заглавие), а при два такива реда
     „кой преди кого“ вече се вижда. Вписват се нарочно в ОБРАТЕН на азбучния
     ред: ако подреждането се сведе само до инвентарния номер, те ще излязат по
     реда на вписване и листът ще се различава от стария. */
  const insNoInv = h.db.prepare(`INSERT INTO books (inv_number, title, author, register_date, status, price, barcode, udk, author_mark)
    VALUES (NULL, ?, 'Авторов, А.', ?, 'наличен', 1, ?, '886.7', 'Б 15')`);
  insNoInv.run('Ббб без инвентарен номер', Y + '-03-14', '7799998');
  insNoInv.run('Ааа без инвентарен номер', Y + '-03-14', '7799999');

  const all = ok(await h.api.books.list(''), 'пълният списък');
  assert.ok(all.length >= LAST - FIRST + 2, 'фондът за теста не е засят');
});

/* Листът по СТАРИЯ начин: пълният списък, филтърът „действащ фонд“ и същото
   устойчиво сортиране, което стоеше в activeBooks()/printLabels*(). Това е
   „преди“-то, срещу което се сверява „след“-ът. */
async function oldWaySheet(cardName, from, to) {
  const books = ok(await h.api.books.list(''), 'пълният списък');
  let rows = books.filter(b => b.status !== 'отчислен');
  if (from != null) rows = rows.filter(b => b.inv_number >= from && b.inv_number <= to);
  rows = rows.sort((a, b) => a.inv_number - b.inv_number);
  return { rows, html: rows.map(r => h.window[cardName](r)).join('') };
}
/* Двата низа минават през един и същ DOM, за да се сравнява СЪДЪРЖАНИЕТО, а не
   как jsdom е нормализирал кавичките в единия от тях. */
function normalized(html) {
  const d = h.document.createElement('div');
  d.innerHTML = html;
  return d.innerHTML;
}
const sheetHtml = () => h.$('#ppSheet').innerHTML;
function noRendererErrors() {
  const errs = h.errors.splice(0);
  assert.equal(errs.length, 0, 'грешки в екранния слой:\n'
    + errs.map(e => (e && (e.stack || e.message)) || String(e)).join('\n---\n'));
}
const lastListCall = () => [...h.stats.calls].reverse().find(c => c.channel === 'books:list');

test('1. „Етикети за фонда — диапазон“: листът е знак по знак същият, а по моста минава само диапазонът', async () => {
  const expected = await oldWaySheet('lblCard', FIRST + 5, FIRST + 15);
  assert.equal(expected.rows.length, 10, 'диапазонът трябва да е 11 номера без отчисления');

  await h.go('labels');
  h.type('[name=lblFrom]', String(FIRST + 5));
  h.type('[name=lblTo]', String(FIRST + 15));
  await h.window.printLabelsRange();
  await h.settle();

  assert.equal(sheetHtml(), normalized(`<div class="pdoc"><div class="lblsheet">${expected.html}</div></div>`),
    'отпечатаният лист се различава от листа по стария начин');
  assert.equal((sheetHtml().match(/<div class="lbl[ "]/g) || []).length, 10, 'броят етикети на листа');

  /* И същината на поправката: заявката вече не тегли целия фонд. */
  const call = lastListCall();
  // Object.assign: аргументът е създаден в realm-а на jsdom и deepEqual сравнява
  // и прототипите — тук се пита какво е ПОИСКАНО, не откъде е обектът.
  assert.deepEqual(Object.assign({}, call.args[2]), { labels: true, from: FIRST + 5, to: FIRST + 15 },
    'екранът трябва да поиска ДИАПАЗОН, а не целия списък');
  assert.equal(call.result.data.length, 10, 'по моста минават само редовете от диапазона');
  noRendererErrors();
});

test('2. „Етикети за фонда — всички“: същият лист, включително редът без инвентарен номер най-отпред', async () => {
  const expected = await oldWaySheet('lblCard', null, null);
  await h.go('labels');
  await h.window.printLabelsAll();
  await h.settle();
  assert.equal(sheetHtml(), normalized(`<div class="pdoc"><div class="lblsheet">${expected.html}</div></div>`),
    'листът „Всички“ се различава от листа по стария начин');
  assert.equal(expected.rows[0].inv_number, null,
    'редовете без инвентарен номер трябва да са първи — така ги нареждаше устойчивото сортиране');
  const head = lastListCall().result.data.slice(0, 2);
  assert.deepEqual(head.map(r => r.barcode), ['7799999', '7799998'],
    'двата реда без инвентарен номер трябва да са по ЗАГЛАВИЕ (Ааа преди Ббб), не по реда на вписване');
  noRendererErrors();
});

test('3. Сигнатурните етикети (диапазон и всички) минават по същия път и дават същия лист', async () => {
  for (const [what, from, to, fn] of [
    ['диапазон', FIRST + 2, FIRST + 12, 'printSignatureLabelsRange'],
    ['всички', null, null, 'printSignatureLabelsAll']
  ]) {
    const expected = await oldWaySheet('sigLblCard', from, to);
    await h.go('labels');
    if (from != null) { h.type('[name=sigFrom]', String(from)); h.type('[name=sigTo]', String(to)); }
    await h.window[fn]();
    await h.settle();
    assert.equal(sheetHtml(), normalized(`<div class="pdoc"><div class="lblsheet">${expected.html}</div></div>`),
      'сигнатурният лист (' + what + ') се различава от листа по стария начин');
    /* Документът без УДК и без авторски знак пак си казва защо е празен — това
       е единственото място, на което сигнатурният етикет проговаря. */
    if (from == null) assert.match(sheetHtml(), /няма УДК и авторски знак/);
    noRendererErrors();
  }
});

test('4. Отчисленият документ не получава етикет — филтърът вече е в базата', async () => {
  await h.go('labels');
  h.type('[name=lblFrom]', String(FIRST + 9));
  h.type('[name=lblTo]', String(FIRST + 11));
  await h.window.printLabelsRange();
  await h.settle();
  const printed = sheetHtml();
  assert.ok(printed.includes(String(FIRST + 9)) && printed.includes(String(FIRST + 11)), 'съседните номера липсват');
  assert.ok(!printed.includes(String(FIRST + 10)), 'отчисленият документ получи етикет');
  assert.equal(lastListCall().result.data.length, 2, 'отчисленият не бива дори да минава по моста');
  noRendererErrors();
});

test('5. Празен диапазон казва това с думи, а не печата празен лист', async () => {
  await h.go('labels');
  const before = h.toasts.length;
  h.type('[name=lblFrom]', '900001');
  h.type('[name=lblTo]', '900099');
  await h.window.printLabelsRange();
  await h.settle();
  assert.match((h.toastsSince(before).pop() || {}).msg || '', /Няма документи в този диапазон/);
  noRendererErrors();
});

test('6. Таванът за много етикети важи както досега — и за „Всички“, и за огромен диапазон', async () => {
  /* confirmManyLabels (v2.3.0) пита при над 500 етикета и пита ПРЕДИ да се
     сглоби низът (v2.3.1). Поправката не пипа нито прага, нито реда — но точно
     тя сменя източника на редовете, затова се проверява наново. Диапазон
     „от 1 до 99999“ е същият печат с друго име и минава през същия въпрос. */
  const many = 520;
  const ins = h.db.prepare(`INSERT INTO books (inv_number, title, author, register_date, status, price)
    VALUES (?, ?, 'Авторов, А.', ?, 'наличен', 1)`);
  h.db.transaction(() => {
    for (let i = 0; i < many; i++) ins.run(7000 + i, 'Масов документ № ' + i, Y + '-03-14');
  })();

  await h.go('labels');
  h.hooks.confirmAnswer = false;
  const asked = h.hooks.confirms.length;
  h.type('[name=lblFrom]', '1');
  h.type('[name=lblTo]', '99999');
  const res = await h.window.printLabelsRange();
  await h.settle();
  assert.equal(res, false, 'при отказ печат не се прави');
  const q = h.hooks.confirms.slice(asked);
  assert.equal(q.length, 1, 'огромният диапазон трябва да зададе въпроса точно веднъж');
  assert.match(q[0], /ПЕЧАТ НА \d+ ЕТИКЕТА/, 'въпросът трябва да казва колко етикета са');
  assert.match(q[0], /листа A4/, 'и на колко листа излизат');

  await h.window.printLabelsAll();
  await h.settle();
  assert.equal(h.hooks.confirms.length, asked + 2, '„Всички“ също пита');
  h.hooks.confirmAnswer = true;
  noRendererErrors();
});

/* ==================================================================
   2. Каналът: точно диапазонът, точно изброената проекция, по индекса
   ================================================================== */

/* Истинските handlers/books.js върху прясна база — без екран, за да може да се
   гледа какво точно подготвя и какво връща обработчикът. `spy` записва всеки
   компилиран SQL: така „подготвя се веднъж“ се мери с БРОЯЧ, а не с часовник. */
function booksSetup(prefix) {
  const { db } = freshDb(prefix);
  const sqls = [];
  const spy = new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql) => { sqls.push(String(sql)); return t.prepare(sql); };
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    }
  });
  const stub = () => {};
  const ipcMain = fakeIpcMain();
  const ret = require(path.join(APP_DIR, 'handlers', 'books'))(ipcMain, {
    getDb: () => spy, run: runDep, logAudit: stub, today: () => Y + '-08-04',
    ftsQuery: (q) => String(q || ''), cnSortKey: (s) => String(s || ''), diffFields: () => [],
    scheduleCatalogWrite: stub, flushCatalogWrite: stub, normalizeScanCode: (x) => x
  });
  const ins = db.prepare(`INSERT INTO books (inv_number, barcode, title, author, register_date, status, price, udk, call_number, author_mark, annotation, keywords)
    VALUES (?, ?, ?, 'Авторов, А.', ?, ?, 1, '886.7-31', 'Ч-84', 'А 22', ?, 'дълги ключови думи')`);
  db.transaction(() => {
    for (let i = 1; i <= 400; i++) {
      ins.run(i, '88' + i, 'Заглавие ' + String((i * 13) % 400).padStart(3, '0'), Y + '-03-14',
        i % 50 === 0 ? 'отчислен' : 'наличен', 'Дълга анотация, каквато списъкът никога не показва. '.repeat(20));
    }
  })();
  return { db, spy, ipcMain, sqls, ret };
}

test('7. Каналът за етикети връща ТОЧНО редовете от диапазона и ТОЧНО шестте полета на етикета', async () => {
  const s = booksSetup('etk-kanal-');
  const rows = ok(await s.ipcMain.invoke('books:list', '', 'inv', { labels: true, from: 100, to: 149 }), 'етикети 100–149');

  // 1) точно редовете: независимо пресметнато от суровата таблица
  const expected = s.db.prepare(`SELECT inv_number FROM books
    WHERE inv_number BETWEEN 100 AND 149 AND status != 'отчислен' ORDER BY inv_number`).pluck().all();
  assert.deepEqual(rows.map(r => r.inv_number), expected);
  assert.equal(rows.length, 49, '100–149 без отчисления № 100 са 49 документа');

  // 2) точно проекцията — изброена, не „каквото дойде“
  assert.deepEqual(Object.keys(rows[0]).sort(),
    ['author_mark', 'barcode', 'call_number', 'inv_number', 'status', 'udk'],
    'проекцията на етикета трябва да е точно тази — всяко ново поле се добавя съзнателно');
  /* И обратната страна: скъпите полета НЕ минават по моста. Анотацията е една
     трета от теглото на реда и нито един етикет не я печата. */
  const payload = JSON.stringify(rows);
  assert.ok(!/annotation|keywords|"title"/.test(payload), 'по моста минават полета, които етикетът не печата');

  // 3) и колко по-малко е това от пълния списък
  const full = ok(await s.ipcMain.invoke('books:list', ''), 'пълният списък');
  const fullBytes = JSON.stringify(full).length;
  assert.ok(payload.length < fullBytes / 20,
    'товарът на етикетите (' + payload.length + ' Б) не е драстично по-малък от пълния списък (' + fullBytes + ' Б)');
});

test('8. Диапазонът се търси ПО ИНДЕКСА на инвентарния номер, с една-единствена заявка', async () => {
  const s = booksSetup('etk-plan-');
  s.sqls.length = 0;
  ok(await s.ipcMain.invoke('books:list', '', 'inv', { labels: true, from: 100, to: 149 }), 'етикети 100–149');
  assert.equal(s.sqls.length, 1, 'един печат на етикети = една заявка, не заявка на ред');
  const sql = s.sqls[0];
  assert.ok(!/\bJOIN\b/i.test(sql), 'заявката за етикети няма какво да съединява');
  assert.ok(!/b\.\*/.test(sql), 'проекцията трябва да е изброена, не b.*');
  /* Точно планът от измерването (node /tmp/r41/explain-a.js): уникалният индекс
     на inv_number, без сканиране на фонда. Ако някой ден проекцията порасне до
     поле извън индекса, планът пак е SEARCH — тук се пази това, което дава
     0,52 ms вместо 87 ms: диапазонът НЕ се обхожда целият. */
  const plan = s.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(100, 149).map(r => r.detail).join(' | ');
  assert.match(plan, /SEARCH b USING INDEX sqlite_autoindex_books_1 \(inv_number>\? AND inv_number<\?\)/, plan);
  assert.ok(!/SCAN b\b/.test(plan), 'фондът не бива да се сканира за един диапазон: ' + plan);
});

test('9. „Всички“ е същият канал без граници, а сгрешена граница се отказва с обяснение', async () => {
  const s = booksSetup('etk-granici-');
  const all = ok(await s.ipcMain.invoke('books:list', '', 'inv', { labels: true, from: null, to: null }), 'всички');
  assert.equal(all.length, s.db.prepare("SELECT COUNT(*) n FROM books WHERE status != 'отчислен'").get().n);
  // само долна граница — горната липсва; това е пак диапазон, не „целият фонд“
  const tail = ok(await s.ipcMain.invoke('books:list', '', 'inv', { labels: true, from: 390 }), 'от 390 нататък');
  assert.deepEqual(tail.map(r => r.inv_number), s.db.prepare(
    "SELECT inv_number FROM books WHERE inv_number >= 390 AND status != 'отчислен' ORDER BY inv_number").pluck().all());
  assert.ok(tail.length && tail[0].inv_number === 390, 'границата е ВКЛЮЧИТЕЛНА — както при .filter(b => b.inv_number >= from)');
  assert.ok(!tail.some(r => r.inv_number === 400), 'отчисленият № 400 не получава етикет');

  const bad = await s.ipcMain.invoke('books:list', '', 'inv', { labels: true, from: 'сто', to: 149 });
  assert.equal(bad.ok, false, 'нечислова граница не бива да се подминава — подмината, тя разширява печата до целия фонд');
  assert.match(bad.error, /не е инвентарен номер/);
  const rev = await s.ipcMain.invoke('books:list', '', 'inv', { labels: true, from: 200, to: 100 });
  assert.equal(rev.ok, false);
  assert.match(rev.error, /по-малък от началния/);
});

test('10. Старите режими на books:list не са пипнати', async () => {
  const s = booksSetup('etk-stari-');
  const full = ok(await s.ipcMain.invoke('books:list', ''), 'пълен списък');
  assert.equal(full.length, 400, 'пълният списък пак връща всичко, включително отчисленото');
  assert.ok('title' in full[0] && 'available' in full[0], 'и пак с проекцията на списъка');
  const win = ok(await s.ipcMain.invoke('books:list', '', 'title', { offset: 0, limit: 10 }), 'прозорец');
  assert.equal(win.rows.length, 10);
  assert.equal(win.total, 400);
  const ids = ok(await s.ipcMain.invoke('books:list', '', 'title', { idsOnly: true }), 'само идентификатори');
  assert.equal(ids.ids.length, 400);
});

test('11. Изгледът и мостът казват едно и също за новия режим', () => {
  assert.doesNotMatch(LOGO_SRC, /window\.api\.books\.list\(''\)/,
    'етикетите пак теглят целия фонд през window.api.books.list(\'\')');
  assert.match(LOGO_SRC, /books\.list\('', 'inv', \{ labels: true, from, to \}\)/,
    'етикетите трябва да искат диапазон');
  assert.equal((LOGO_SRC.match(/labelRows\(/g) || []).length, 5,
    'четирите печатни пътя за етикети трябва да минават през едно място');
  assert.match(PRELOAD_SRC, /labels: true, from, to/, 'режимът трябва да е документиран на моста');
  assert.match(BOOKS_SRC, /const LABEL_SELECT = `\s*\n\s*SELECT b\.inv_number, b\.barcode, b\.call_number, b\.author_mark, b\.udk, b\.status/,
    'проекцията на етикета се изброява в handlers/books.js');
});

/* ==================================================================
   3. Вносът: същият резултат, с подготвени веднъж заявки
   ================================================================== */

function importSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  const sqls = [];
  const spy = new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql) => { sqls.push(String(sql)); return t.prepare(sql); };
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    }
  });
  const stub = () => {};
  const BOOK_FIELDS = require(path.join(APP_DIR, 'handlers', 'books'))(fakeIpcMain(), {
    getDb: () => spy, run: runDep, logAudit: stub, today: () => Y + '-08-04',
    ftsQuery: (q) => q, cnSortKey: (s) => String(s || ''), diffFields: () => [],
    scheduleCatalogWrite: stub, normalizeScanCode: (x) => x
  }).BOOK_FIELDS;
  const ipcMain = fakeIpcMain();
  const audit = [];
  require(path.join(APP_DIR, 'handlers', 'data-import'))(ipcMain, {
    getDb: () => spy, run: runDep, logAudit: (a, d) => audit.push({ a, d }),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => ({}), fs, path, BOOK_FIELDS,
    today: () => Y + '-08-04', cnSortKey: (s) => String(s || '').toUpperCase().trim()
  });
  return { db, spy, ipcMain, sqls, dir, audit };
}

/* Файлът, който се внася. Освен обикновените редове носи и всичко, което вносът
   ТРЯБВА да откаже или да поправи — точно случаите, които минават през
   assertUniqueBarcode и през автоматичния инвентарен номер. */
function writeCsv(dir, rows) {
  const p = path.join(dir, 'vnos.csv');
  fs.writeFileSync(p, '﻿' + rows.join('\r\n'), 'utf8');
  return p;
}
const CSV_HEAD = 'Инв. №;Заглавие;Автор;Баркод;Година;Цена;Отдел;Дата на вписване';
function csvRows(n, start) {
  const out = [CSV_HEAD];
  for (let i = 0; i < n; i++) {
    const inv = (start || 1000) + i;
    out.push([inv, 'Внесено заглавие № ' + i, 'Вносов, Иван', '99' + inv, 1990 + (i % 30),
      ((i % 100) / 10).toFixed(2), 'за възрастни', '2015-01-05'].join(';'));
  }
  return out;
}

async function runImport(s, rows, options) {
  const file = writeCsv(s.dir, rows);
  const loaded = ok(await s.ipcMain.invoke('import:load', file), 'прочит на файла');
  return ok(await s.ipcMain.invoke('import:run', { mapping: loaded.mapping, options: options || {} }), 'внос');
}

test('12. Вносът вписва същото, отказва същото и отчита същото — включително сблъсъците на баркодове', async () => {
  const s = importSetup('vnos-povedenie-');
  // Заварен документ с етикет „700“ — внесен ред с инв. № 700 става неразличим
  // от него при сканиране и трябва да бъде отказан (assertUniqueBarcode).
  s.db.prepare(`INSERT INTO books (inv_number, title, register_date, status, price, barcode)
    VALUES (12, 'Тютюн', '2015-01-05', 'наличен', 1, '700')`).run();

  const rows = csvRows(20, 1000);
  rows.push(['700', 'Под игото', 'Вазов, Иван', '', 1894, '12.00', 'за възрастни', '2015-01-05'].join(';'));
  rows.push(['1500', 'Двойният етикет — първи', 'Вносов, Иван', '8800001', 2001, '5.00', 'за възрастни', '2015-01-05'].join(';'));
  rows.push(['1501', 'Двойният етикет — втори', 'Вносов, Иван', '8800001', 2002, '5.00', 'за възрастни', '2015-01-05'].join(';'));
  rows.push(['', 'Без инвентарен номер', 'Вносов, Иван', '', 2003, '5.00', 'за възрастни', '2015-01-05'].join(';'));
  // Ред без заглавие — пропуска се мълчаливо (заглавието е единственото, без
  // което документ няма; останалите клетки не помагат).
  rows.push(['9999', '', 'Вносов, Иван', '', '', '', '', ''].join(';'));

  const rep = await runImport(s, rows);

  assert.equal(rep.added, 22, 'вписани редове');
  assert.equal(rep.skipped, 3, 'пропуснати редове');
  assert.equal(rep.errors.length, 2, 'два отказа с обяснение');
  assert.deepEqual(rep.errors.map(e => e.line), [22, 24],
    'отказите трябва да сочат точните редове на файла');
  assert.match(rep.errors[0].error, /съвпада с баркода на друг документ/,
    'инв. № 700 срещу заварения етикет „700“');
  assert.match(rep.errors[1].error, /вече е на инв. № 1500/,
    'вторият ред със същия баркод — сблъсъкът трябва да се види В САМИЯ ФАЙЛ, преди записът да е потвърден');

  // И самите редове в базата — не само отчетът.
  const got = s.db.prepare(`SELECT inv_number, title, barcode, price, register_date, status
    FROM books WHERE title LIKE 'Внесено%' OR title LIKE 'Двойният%' OR title LIKE 'Без инвентарен%'
    ORDER BY inv_number`).all();
  assert.equal(got.length, 22);
  assert.deepEqual(got[0], { inv_number: 1000, title: 'Внесено заглавие № 0', barcode: '991000',
    price: 0, register_date: '2015-01-05', status: 'наличен' });
  assert.equal(got.find(r => r.title === 'Двойният етикет — първи').barcode, '8800001');
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM books WHERE title LIKE 'Двойният%'").get().n, 1,
    'вторият документ със същия етикет не бива да влиза');
  /* Редът без инвентарен номер получава следващия свободен — и това се казва. */
  const auto = got.find(r => r.title === 'Без инвентарен номер');
  assert.ok(auto.inv_number > 0);
  assert.deepEqual(rep.usedInv.map(u => u.line), [25]);
  // Всеки вписан документ има и ред в „Наличности“ с бройка 1.
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM inventory').get().n, 22);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM inventory WHERE quantity != 1').get().n, 0);
});

test('13. Заявките на вноса се компилират ВЕДНЪЖ: броят им не расте с редовете', async () => {
  /* ТОВА Е ИСТИНСКАТА ПРЕГРАДА, а не праг по време: db.prepare() компилира SQL,
     а в обхождане на 5 000 реда това са 10 000 компилации на два неизменни низа
     (плюс още две на ред от assertUniqueBarcode при файл с баркодове).
     Измерено: 463 ms → 215 ms за 5 000 реда (node /tmp/r41/import-split.js).
     Броячът не зависи от машината: ако prepare() се върне в цикъла, числото
     тръгва с редовете и тестът пада — независимо колко е бърз компютърът. */
  const small = importSetup('vnos-broy-malko-');
  small.sqls.length = 0;
  const r1 = await runImport(small, csvRows(10, 2000));
  const n1 = small.sqls.length;

  const big = importSetup('vnos-broy-mnogo-');
  big.sqls.length = 0;
  const r2 = await runImport(big, csvRows(120, 2000));
  const n2 = big.sqls.length;

  assert.equal(r1.added, 10);
  assert.equal(r2.added, 120);
  assert.equal(n2, n1, 'компилираните заявки при 120 реда (' + n2 + ') трябва да са толкова, колкото при 10 (' + n1 + ')');
  assert.ok(n1 < 25, 'вносът компилира ' + n1 + ' заявки — повече, отколкото има отделни заявки');
  // Двете вписвания ги има — просто са подготвени веднъж.
  assert.equal(big.sqls.filter(q => /INSERT INTO books/.test(q)).length, 1);
  assert.equal(big.sqls.filter(q => /INSERT INTO inventory/.test(q)).length, 1);
});

/* Тялото на едно обхождане, отрязано по БАЛАНСИРАНИ скоби — същата опора, която
   ползва test/perf-v2448.test.js (правило, което брои знаци, пропуска
   нарушение малко по-надолу в същото обхождане). */
function loopBody(src, marker) {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, 'липсва обхождането „' + marker + '“');
  const i = src.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(i, j + 1); }
  }
  throw new Error('незатворено обхождане: ' + marker);
}

test('14. В обхождането на файла и в проверката за баркод няма db.prepare()', () => {
  const body = loopBody(IMPORT_SRC, 'IMPORT_CACHE.body.forEach(');
  assert.equal(/db\.prepare\(/.test(body), false,
    'db.prepare() е вътре в обхождането на редовете — компилира се наново на всеки документ');
  assert.match(IMPORT_SRC, /const insertBook = db\.prepare\(/, 'вписването на документа — подготвено веднъж');
  assert.match(IMPORT_SRC, /const insertInv = db\.prepare\(/, 'бройката в „Наличности“ — веднъж');
  assert.match(body, /insertBook\.run\(payload\)/);
  assert.match(body, /insertInv\.run\(info\.lastInsertRowid\)/);

  const check = loopBody(BOOKS_SRC, 'function assertUniqueBarcode(');
  assert.equal(/db\.prepare\(/.test(check), false,
    'проверката за баркод компилира заявка при всяко извикване — а вносът я вика на всеки ред');
  assert.match(BOOKS_SRC, /const BARCODE_STMTS = new WeakMap\(\);/,
    'подготвените заявки се пазят ПО ВРЪЗКА — заявка от друга база не се ползва');
});

/* ==================================================================
   4. Проверката за баркод: същите откази, дума по дума
   ================================================================== */

/* СТАРИЯТ вид на проверката, преписан тук дословно (три db.prepare() на
   извикване). Твърдението „нищо не се е променило“ се доказва със сравнение
   срещу него, а не с преразказ. */
function assertUniqueBarcodeOld(db, barcode, invNumber, selfId) {
  const code = barcode == null ? '' : String(barcode).trim();
  const self = selfId || -1;
  if (code) {
    const other = db.prepare('SELECT id, inv_number FROM books WHERE barcode = ? AND id != ? LIMIT 1').get(code, self);
    if (other) {
      throw new Error('Баркод ' + code + ' вече е на инв. № ' + (other.inv_number ?? other.id)
        + ' — един баркод се лепи само на един екземпляр. Дайте на този документ друг етикет '
        + '(„Баркод етикети“) или оставете полето празно.');
    }
    if (/^\d{1,9}$/.test(code)) {
      const byInv = db.prepare('SELECT id, inv_number FROM books WHERE inv_number = ? AND id != ? LIMIT 1').get(parseInt(code, 10), self);
      if (byInv) {
        throw new Error('Баркод ' + code + ' съвпада с инвентарния номер на друг документ (инв. № ' + byInv.inv_number
          + ') — при сканиране програмата няма как да различи двата. Дайте на този документ друг етикет.');
      }
    }
  }
  if (invNumber != null) {
    const byCode = db.prepare(`SELECT id, inv_number, barcode FROM books
      WHERE id != ? AND (barcode = ? OR (barcode GLOB '0*' AND barcode NOT GLOB '*[^0-9]*' AND length(barcode) <= 9 AND CAST(barcode AS INTEGER) = ?))
      LIMIT 1`).get(self, String(invNumber), invNumber);
    if (byCode) {
      throw new Error('Инв. № ' + invNumber + ' съвпада с баркода на друг документ (инв. № ' + (byCode.inv_number ?? byCode.id)
        + ') — при сканиране програмата няма как да различи двата. Сменете етикета на другия документ или изберете друг номер.');
    }
  }
}

test('15. Подготвените веднъж заявки дават ДУМА ПО ДУМА същите откази, както преди', () => {
  const { db } = freshDb('vnos-barkod-');
  const { assertUniqueBarcode } = require(path.join(APP_DIR, 'handlers', 'books'));
  const ins = db.prepare(`INSERT INTO books (inv_number, title, barcode, register_date, price, status)
    VALUES (?, ?, ?, '2015-01-05', 1, 'наличен')`);
  ins.run(12, 'Тютюн', '700');
  ins.run(700, 'Под игото', null);
  ins.run(9, 'Водолей', '007');          // водещи нули — числово равен на инв. № 7
  const self = db.prepare('SELECT id FROM books WHERE inv_number = 12').get().id;

  const verdict = (fn, args) => {
    try { fn(db, ...args); return 'ok'; }
    catch (e) { return e.message; }
  };
  const cases = [
    ['700', 5, null],        // същият етикет на втори документ
    ['12', 9, null],         // етикет, равен на ЧУЖД инвентарен номер
    [null, 9, null],         // празен етикет е редовен
    [null, 7, null],         // инв. № 7 срещу баркода „007“
    ['700', 5, self],        // същият документ — не се сблъсква сам със себе си
    ['нов-етикет', 4000, null],
    ['', 4001, null],
    ['0012', 4002, null]
  ];
  for (const c of cases) {
    const now = verdict(assertUniqueBarcode, c);
    const before = verdict(assertUniqueBarcodeOld, c);
    assert.equal(now, before, 'различен резултат за ' + JSON.stringify(c));
  }
  // И че отказите наистина са откази, не мълчаливо „ok“ и от двете страни.
  assert.match(verdict(assertUniqueBarcode, ['700', 5, null]), /вече е на инв. № 12/);
  assert.match(verdict(assertUniqueBarcode, ['12', 9, null]), /съвпада с инвентарния номер/);
  assert.match(verdict(assertUniqueBarcode, [null, 7, null]), /съвпада с баркода на друг документ/);
  assert.equal(verdict(assertUniqueBarcode, [null, 9, null]), 'ok');
  db.close();
});

test('16. Подготвената заявка вижда и редовете, вписани в СЪЩАТА транзакция', async () => {
  /* Това е единственото място, на което кеширането наистина би могло да смени
     поведението: ако подготвената заявка гледаше „стара снимка“ на базата,
     двата еднакви баркода в един и същи файл щяха да минат и дефектът щеше да
     се появи чак на гишето, при сканиране. Тестът в № 12 го покрива през
     пълния внос; тук — направо, ред по ред, в една транзакция. */
  const { db } = freshDb('vnos-tranzakciya-');
  const { assertUniqueBarcode } = require(path.join(APP_DIR, 'handlers', 'books'));
  const ins = db.prepare(`INSERT INTO books (inv_number, title, barcode, register_date, price, status)
    VALUES (?, ?, ?, '2015-01-05', 1, 'наличен')`);
  let refused = null;
  db.transaction(() => {
    assertUniqueBarcode(db, '5555', 300, null);
    ins.run(300, 'Първи', '5555');
    try { assertUniqueBarcode(db, '5555', 301, null); } catch (e) { refused = e.message; }
  })();
  assert.match(refused || '', /вече е на инв. № 300/,
    'вторият еднакъв баркод в същата транзакция трябва да бъде отказан');
  db.close();
});

test('17. Груб предпазител по време (виж честната бележка в началото на файла)', async () => {
  const s = importSetup('vnos-vreme-');
  const t0 = Date.now();
  const rep = await runImport(s, csvRows(1000, 3000));
  const ms = Date.now() - t0;
  assert.equal(rep.added, 1000);
  /* Измерено на тази машина: 1 000 реда с баркодове минават за ~120 ms с
     подготвени заявки и ~200 ms без тях — тоест прагът НЕ лови връщането назад
     и не бива да се чете така. Оставен е срещу нещо драстично (заявка на ред
     върху растяща таблица), а истинската преграда е броячът в тест № 13. */
  assert.ok(ms < 4000, 'вносът на 1 000 реда отне ' + ms + ' ms');
});
