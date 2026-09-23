'use strict';
/* v2.4.65 — четиридесет и втори кръг, област ФОНД.
   =====================================================================
   По един тест на всяка поправена находка. Всеки твърди онова, което
   БИБЛИОТЕКАРКАТА вижда — реда в базата след подписан протокол, текста на
   екрана, числото на прошнурования лист, реда в одитната следа — а не
   вътрешната форма на данните. Всеки е проверен с връщане на поправката
   назад: без нея пада.

   А2  Проектът за акт от липсите връщаше разделените екземпляри във фонда.
   Г1  Вписването на книга при свързан онлайн каталог струваше 128 ms вместо 1.
   Б7  Печатът на диапазон обявяваше фонда на диапазона за фонд на библиотеката.
   Б9  Груповата редакция не оставяше следа кои документи е пипнала.
   Б10 Партида с бъдеща дата се приемаше и изчезваше от КДБФ.
   Б11 „Отвори карта“ от Таблото заобикаляше потвърждението по чл. 17, ал. 2.
   В8  Непозната стойност за „начин на постъпване“ даваше суровото съобщение
       на SQL тригера.
   В9  Таванът от 3 000 реда се свиваше на 2 000 при първото пречертаване. */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
const Y = T.slice(0, 4);
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const lastAudit = (action) =>
  q('SELECT action, detail, diff FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1', action);

function mkBook(o) {
  const id = Number(h.db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, status_date, department)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(o.inv, o.title, o.author || 'Автор, А.',
    o.price == null ? 5 : o.price, o.date || T, o.status || 'наличен', o.date || T,
    o.department || 'за възрастни').lastInsertRowid);
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, o.qty == null ? 1 : o.qty);
  if (o.inv != null) h.db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(o.inv + 1);
  return id;
}

/* ==================================================================
   А2. Проект за акт от липсите: разделените екземпляри ОСТАВАТ липсващи
   ==================================================================
   Стар запис с 3 екземпляра под един номер не е намерен изобщо при пълна
   инвентаризация. Подписаният протокол казва „Липсващи: 3“. Проектът за акт
   разделя записа на три реда — и трите трябва да са „липсващ“. Ако комисията
   не утвърди проекта (а той е само проект), върнатите на „наличен“ екземпляри
   остават във фонда завинаги: броят се, заемат се, влизат в онлайн каталога, а
   протоколът твърди обратното.
   ================================================================== */
test('А2. разделянето от „Проект за акт от липсите“ оставя новите екземпляри ЛИПСВАЩИ — колкото казва протоколът', async () => {
  const id = mkBook({ inv: 4100, title: 'Тютюн', price: 4, qty: 3 });
  const s = await h.api.inventorySessions.start({ date: T, scope: 'пълна', department: null,
    committee1: 'Иванова', committee2: 'Петров', committee3: 'Стоянова', order_no: null });
  assert.equal(s.ok, true, s.error);
  const sid = s.data.id || s.data;
  for (const o of all(`SELECT inv_number FROM books WHERE (status != 'отчислен' OR status IS NULL)
      AND id <> ? AND id NOT IN (SELECT book_id FROM loans WHERE date_in IS NULL)`, id)) {
    await h.api.inventorySessions.scan({ sessionId: sid, code: String(o.inv_number) });
  }
  assert.equal((await h.api.inventorySessions.close({ sessionId: sid, mode: 'full' })).ok, true);
  const sess = (await h.api.inventorySessions.get(sid)).data;
  const miss = sess.missing.filter(m => m.book_id === id);
  assert.equal(Number(miss[0].quantity), 3, 'протоколът брои трите екземпляра');
  const missingBefore = q(`SELECT COALESCE(SUM(COALESCE(i.quantity, 1)), 0) AS n FROM books b
    LEFT JOIN inventory i ON i.book_id = b.id WHERE b.status = 'липсващ'`).n;

  h.hooks.confirmAnswer = true;
  await h.go('invent');
  await h.window.draftFromMissing(sid); await h.settle();
  // Комисията НЕ утвърждава проекта — точно случаят, в който разликата личи.
  const draft = q('SELECT MAX(id) AS id FROM deaccession_drafts').id;
  assert.equal((await h.api.deaccessionActs.deleteDraft(draft)).ok, true);

  const rows = all("SELECT inv_number, status FROM books WHERE title = 'Тютюн' ORDER BY inv_number");
  assert.equal(rows.length, 3, 'записът е разделен на три реда: ' + JSON.stringify(rows));
  for (const r of rows) {
    assert.equal(r.status, 'липсващ',
      'инв. № ' + r.inv_number + ' трябва да е ЛИПСВАЩ — протоколът е подписан за трите: ' + JSON.stringify(rows));
  }
  const missingAfter = q(`SELECT COALESCE(SUM(COALESCE(i.quantity, 1)), 0) AS n FROM books b
    LEFT JOIN inventory i ON i.book_id = b.id WHERE b.status = 'липсващ'`).n;
  assert.equal(missingAfter, missingBefore, 'програмата брои същия брой липсващи, какъвто казва протоколът');
});

test('А2 (другата страна). „Раздели“ на НАЛИЧЕН запис пак нулира състоянието на новите екземпляри', async () => {
  /* Нулирането от v2.4.22 си остава вярно там, където е измислено: скъсаната
     книга в ръката на комисията е ЕДИН физически екземпляр, а не всичките под
     номера. Тестът пази поправката на А2 от това да поправи и него. */
  const id = mkBook({ inv: 4200, title: 'Железният светилник', price: 6, qty: 3 });
  h.db.prepare("UPDATE books SET description = 'скъсана корица' WHERE id = ?").run(id);
  const r = await h.api.books.splitCopies(id);
  assert.equal(r.ok, true, r.error);
  const rows = all("SELECT inv_number, status, description FROM books WHERE title = 'Железният светилник' AND id <> ? ORDER BY inv_number", id);
  assert.equal(rows.length, 2);
  for (const x of rows) {
    assert.equal(x.status, 'наличен', 'новият екземпляр на здрав запис е наличен');
    assert.equal(x.description, null, 'бележката за повреда е за един екземпляр, не за трите');
  }
});

/* ==================================================================
   Г1. Вписването на книга вече не пренаписва целия katalog.json
   ==================================================================
   Измерено (15 000 документа, katalog.json 4,82 МБ): 128 ms на книга и
   5 132 ms за партида от 40 книги преди поправката; 1 ms и 37 ms след нея.
   Тук се проверява УСТРОЙСТВОТО, което дава тези числа — че записът е един за
   партидата, не един на книга — и че намерението от v2.4.57 (постъплението да
   не се проваля мълчаливо) е останало непокътнато.
   ================================================================== */
test('Г1. партида от книги при свързан онлайн каталог прави ЕДИН запис на katalog.json, не по един на книга', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-fond-v2465-cat-'));
  h.db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(dir);
  const file = path.join(dir, 'katalog.json');
  try {
    const n0 = h.toasts.length;
    const created = [];
    for (let k = 1; k <= 5; k++) {
      const res = await h.api.books.create({ title: 'Партидна книга № ' + k, author: 'Партиден, П.',
        register_date: T, price: 9.9, department: 'за възрастни' });
      assert.equal(res.ok, true, res.error);
      assert.equal(res.catalogWarning, null, 'работеща папка — няма какво да се каже');
      created.push(res.data);
      assert.ok(!fs.existsSync(file),
        'книга № ' + k + ': вписването НЕ бива да пренаписва целия katalog.json (4,82 МБ при истински фонд)');
    }
    assert.ok(!h.toastsSince(n0).some(t => t.type === 'err'), JSON.stringify(h.toastsSince(n0)));
    // Това, което прави таймерът от 4 секунди за промените по фонда.
    assert.equal((await h.api.catalog.writeNow()).ok, true);
    const cat = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let k = 1; k <= 5; k++) {
      assert.ok(cat.items.some(x => x.t === 'Партидна книга № ' + k),
        'книга № ' + k + ' стига до сайта с отложения запис');
    }
  } finally {
    h.db.prepare('UPDATE settings SET catalog_folder = NULL WHERE id = 1').run();
  }
});

test('Г1. недостъпна папка пак предупреждава библиотекарката И оставя ред в дневника (намерението от v2.4.57)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-fond-v2465-cat2-'));
  h.db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(path.join(dir, 'няма', 'такава', 'папка'));
  try {
    const res = await h.api.books.create({ title: 'Книга при изключен диск', author: 'Мрежов, М.',
      inv_number: 4600, register_date: T, price: 4, department: 'за възрастни' });
    assert.equal(res.ok, true, 'документът ВЛИЗА — каталогът е второто, вписването е първото');
    assert.match(String(res.catalogWarning), /записът на каталога след нов документ инв\. № \d+ не успя/);
    assert.match(String(res.catalogWarning), /няма да се появи на сайта/);
    assert.equal(lastAudit('Онлайн каталог').detail, res.catalogWarning, 'едно и също изречение и в дневника');
  } finally {
    h.db.prepare('UPDATE settings SET catalog_folder = NULL WHERE id = 1').run();
  }
});

test('Г1. библиотека без свързан онлайн каталог не получава лъжливо предупреждение', async () => {
  const res = await h.api.books.create({ title: 'Книга без онлайн каталог', author: 'Тихов, Т.',
    register_date: T, price: 2, department: 'за възрастни' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.catalogWarning, null,
    'несвързана папка не е грешка — библиотеката може изобщо да не иска онлайн каталог');
});

/* ==================================================================
   Б9. Груповата редакция казва КОИ документи е пипнала
   ================================================================== */
test('Б9. следата от групова редакция носи инвентарните номера и „от какво на какво“ за всеки ред', async () => {
  const a = mkBook({ inv: 4300, title: 'Групова А' });
  const b = mkBook({ inv: 4301, title: 'Групова Б' });
  const c = mkBook({ inv: 4302, title: 'Групова В', status: 'липсващ' });
  const res = await h.api.books.bulkUpdate({ ids: [a, b, c], field: 'status', value: 'липсващ' });
  assert.equal(res.ok, true, res.error);

  const row = lastAudit('Групова редакция');
  assert.match(row.detail, /състояние → липсващ/, 'полето е на български, а не „status“');
  assert.match(row.detail, /инв\. № /, 'следата назовава документите: ' + row.detail);
  assert.ok(row.detail.includes('4300') && row.detail.includes('4301'),
    'в следата стоят номерата на РЕАЛНО променените: ' + row.detail);
  assert.ok(!row.detail.includes('4302'),
    'инв. № 4302 вече беше „липсващ“ — за него няма промяна, която да се вписва: ' + row.detail);

  assert.ok(row.diff, 'чл. 17, ал. 2 иска отговор за всеки вписан ред — diff не бива да е празен');
  const diff = JSON.parse(row.diff);
  assert.equal(diff.length, 2, JSON.stringify(diff));
  assert.deepEqual(diff.map(d => d.field).sort(), ['Инв. № 4300 — Групова А', 'Инв. № 4301 — Групова Б']);
  for (const d of diff) {
    assert.equal(d.before, 'наличен');
    assert.equal(d.after, 'липсващ');
  }
});

/* ==================================================================
   Б10. Партида с бъдеща дата — през самия екран „Постъпления“
   ================================================================== */
test('Б10. партида с печатна грешка в годината (2062 вместо 2026) се отказва и не влиза в регистъра', async () => {
  await h.go('acq');
  await h.clickButton('+ Нова партида');
  h.type('#acqF [name=date]', '2062-09-22');
  h.type('#acqF [name=from_source]', 'Книжарница „Хеликон“');
  h.type('#acqF [name=total_count]', '40');
  h.type('#acqF [name=doc_type]', 'фактура');
  h.type('#acqF [name=doc_no]', '1234');
  const n0 = h.toasts.length;
  await h.clickButton('Заведи партидата', '#modal');
  const t = h.toastsSince(n0).find(x => x.type === 'err');
  assert.ok(t, 'партидата трябва да се откаже: ' + JSON.stringify(h.toastsSince(n0)));
  assert.match(t.msg, /Датата на партидата \(22\.09\.2062 г\.\) е в бъдещето/);
  assert.match(t.msg, /разместени цифри в годината \(2062 вместо 2026\)/, 'казва коя е най-честата причина');
  assert.match(t.msg, /Въведете датата от първичния документ/, 'и какво да направи');
  assert.equal(q("SELECT COUNT(*) AS n FROM acquisitions WHERE year = '2062'").n, 0,
    'нищо не е влязло в регистъра по чл. 14');
});

test('Б10. и поправката на вече заведена партида не може да я изпрати в бъдещето', async () => {
  const ok1 = await h.api.acquisitions.create({ no: 91, date: T, how: 'закупуване',
    from_source: 'Дарител', doc_type: 'фактура', doc_no: '77', total_count: '3' });
  assert.equal(ok1.ok, true, ok1.error);
  const id = q('SELECT MAX(id) AS id FROM acquisitions').id;
  const bad = await h.api.acquisitions.update({ id, acq: { date: '2062-01-05', how: 'закупуване',
    from_source: 'Дарител', doc_type: 'фактура', doc_no: '77', total_count: '3' } });
  assert.equal(bad.ok, false, 'поправката минава през същата проверка');
  assert.match(bad.error, /е в бъдещето/);
  assert.equal(q('SELECT date FROM acquisitions WHERE id = ?', id).date, T, 'датата в регистъра не е пипната');
});

/* ==================================================================
   В8. Непознат „начин на постъпване“ — обяснение, не съобщение на тригера
   ================================================================== */
test('В8. непознат начин на постъпване се отказва на български, с позволените стойности и с изхода', async () => {
  const res = await h.api.acquisitions.create({ no: 92, date: T, how: 'подарък',
    from_source: 'Читател', doc_type: 'фактура', doc_no: '5', total_count: '1' });
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.error, /Непозната стойност за acquisitions\.how/,
    'суровото съобщение на тригера не стига до библиотекарката: ' + res.error);
  assert.match(res.error, /Начинът на постъпване „подарък“ не е познат на програмата/);
  assert.match(res.error, /закупуване \/ депозит \/ обмен \/ дарение/, 'изрежда позволените стойности');
  assert.match(res.error, /падащото меню „Начин на постъпване“/, 'назовава полето така, както е на екрана');
});

/* ==================================================================
   Б7. Печатът на диапазон не обявява своето число за фонд на библиотеката
   ================================================================== */
test('Б7. прошнурованият лист за една година казва, че сборът е НА ДИАПАЗОНА, и дава фонда на цялата книга', async () => {
  mkBook({ inv: 4400, title: 'Стара от 2024', price: 10, date: '2024-03-03' });
  mkBook({ inv: 4401, title: 'Стара от 2024 втора', price: 10, date: '2024-04-04' });
  mkBook({ inv: 4402, title: 'Тазгодишна', price: 20, date: T });
  await h.go('invbook');
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  h.type('#ibPrintF [name=dateFrom]', '2024-01-01');
  h.type('#ibPrintF [name=dateTo]', '2024-12-31');
  await h.clickButton('Печат на диапазона', '#modal');
  const sheet = h.printed().replace(/\s+/g, ' ');

  assert.match(sheet, /Фонд в отпечатания диапазон \(без отчислените\): 2 библиотечни документа/,
    'листът казва чий е сборът: ' + sheet.slice(0, 700));
  assert.match(sheet, /Това НЕ е фондът на библиотеката/);
  const whole = q(`SELECT COALESCE(SUM(COALESCE(i.quantity, 1)), 0) AS n FROM books b
    LEFT JOIN inventory i ON i.book_id = b.id WHERE COALESCE(b.status, '') != 'отчислен'`).n;
  assert.match(sheet, new RegExp('по цялата инвентарна книга[^]*?неотчислените са ' + whole + ' библиотечни документа'),
    'и дава фонда на цялата книга (' + whole + '): ' + sheet.slice(0, 900));
  assert.doesNotMatch(sheet, /лв\.\. /, 'без втора точка след сумата (v2.4.61)');
});

test('Б7. печатът на ЦЯЛАТА книга остава дума по дума какъвто беше', async () => {
  await h.go('invbook');
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  h.hooks.confirmAnswer = true;
  await h.clickButton('Цялата книга…', '#modal');
  await h.settle();
  const sheet = h.printed().replace(/\s+/g, ' ');
  assert.match(sheet, /Фонд по инвентарната книга \(без отчислените\): \d+ библиотечни документа/);
  assert.doesNotMatch(sheet, /Това НЕ е фондът на библиотеката/,
    'при цялата книга няма какво да се уточнява — листът Е книгата');
});

/* ==================================================================
   Б11. „Отвори карта“ от Таблото пита, преди да отвори формата
   ================================================================== */
test('Б11. „Отвори карта“ от Таблото минава през потвърждението по чл. 17, ал. 2 и назовава документа', async () => {
  const id = mkBook({ inv: 4500, title: 'Под игото', author: 'Вазов, Иван', price: 12 });
  h.db.prepare("UPDATE books SET barcode = 'BC4500' WHERE id = ?").run(id);
  await h.go('dash');
  await h.scan('#dashScan', 'BC4500');
  assert.match(h.text('#dashScanResult'), /Под игото/, 'сканирането намира документа');

  // Отказ на въпроса — формата НЕ се отваря.
  h.hooks.confirmAnswer = false;
  const c0 = h.hooks.confirms.length;
  await h.clickButton('Отвори карта', '#dashScanResult');
  await h.settle();
  const asked = h.hooks.confirms.slice(c0).join('\n');
  assert.match(asked, /РЕДАКЦИЯ НА ЗАПИС В ИНВЕНТАРНАТА КНИГА/,
    'Таблото трябва да пита същото, каквото пита „Инвентарна книга“: ' + JSON.stringify(h.hooks.confirms.slice(c0)));
  assert.match(asked, /Вазов, Иван\. Под игото/, 'въпросът назовава документа, а не „този запис“');
  assert.match(asked, /инв\. № 4500/);
  assert.ok(!h.$('#bookF'), 'при отказ формата за редакция не се отваря');

  // Съгласие — формата се отваря, както обещава надписът.
  h.hooks.confirmAnswer = true;
  await h.clickButton('Отвори карта', '#dashScanResult');
  await h.settle();
  await h.waitFor(() => h.$('#bookF'), 'формата за редакция след потвърждение');
  assert.equal(h.$('#bookF [name=title]').value, 'Под игото');
  await h.clickButton('Отказ', '#modal');
  await h.settle();
});

/* ==================================================================
   В9. Таванът от 3 000 реда не се свива на 2 000 при пречертаване
   ================================================================== */
test('В9. разгърнатият до тавана списък не се свива след запис на книга, а честният надпис остава', async () => {
  const ins = h.db.prepare("INSERT INTO books (inv_number, title, author, register_date, status, price, department) VALUES (?,?,?,?,'наличен',1,'за възрастни')");
  const insI = h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)');
  const base = 10000;
  h.db.transaction(() => {
    for (let i = 1; i <= 3500; i++) {
      const info = ins.run(base + i, 'Тавански ' + String(i).padStart(5, '0'), 'Автор', T);
      insI.run(info.lastInsertRowid);
    }
  })();
  h.db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(base + 4000);

  await h.go('books');
  const total = q('SELECT COUNT(*) AS n FROM books').n;
  // „Покажи още“ до тавана.
  for (let k = 0; k < 40 && /Покажи още/.test(h.text('#bMore')); k++) {
    await h.clickButton('Покажи още', '#bMore');
  }
  const rowsAtCap = h.$('#bBody').querySelectorAll('tr').length;
  assert.equal(rowsAtCap, 3000, 'таванът е 3 000 реда (RENDER_MAX_ROWS)');
  assert.match(h.text('#bMore'), /Показани са първите 3[  ]?000 реда от/,
    'честният надпис: ' + h.text('#bMore').slice(0, 160));
  assert.match(h.text('#bMore'), new RegExp('реда от ' + String(total).replace(/\B(?=(\d{3})+(?!\d))/g, '[  ]?')),
    'и казва колко са всички (' + total + '): ' + h.text('#bMore').slice(0, 160));

  // Библиотекарката записва една книга — списъкът се пречертава.
  const res = await h.api.books.create({ title: 'Тавански нов документ', author: 'Автор',
    register_date: T, price: 3, department: 'за възрастни' });
  assert.equal(res.ok, true, res.error);
  await h.window.refreshBooksList(); await h.settle();

  assert.equal(h.$('#bBody').querySelectorAll('tr').length, 3000,
    'списъкът остава разгърнат до тавана, а не се свива на 2 000');
  assert.match(h.text('#bMore'), /Показани са първите 3[  ]?000 реда от/,
    'и честният надпис не изчезва: ' + h.text('#bMore').slice(0, 160));
});
