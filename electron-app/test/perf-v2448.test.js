'use strict';
/* v2.4.48 — тридесет и пети кръг: производителност.
   (Кръпката дойде като „v2.4.45“; номерът беше зает и е преномерирана.)
   =====================================================================
   Трите места са намерени с ИЗМЕРВАНЕ на истинската програма върху истинска
   база от 15 000 книги, 2 000 читатели и 9 400 заемания, а не с четене на кода.
   Общото и на трите е един и същ пропуск: db.prepare() ВЪТРЕ в обхождането,
   тоест компилиране на един и същ SQL по веднъж на ред.

   Тестовете тук доказват ДВЕ различни неща и нарочно ги разделят:
     • че поправеното дава СЪЩИЯ резултат (равенство, доказано с независимо
       изчисление върху суровите редове);
     • че сглобяването на заявката е ИЗВАДЕНО от обхождането — по текста на
       кода, а не по часовника.

   ЗА ПРАГОВЕТЕ ПО ВРЕМЕ (проверка при прегледа на v2.4.49): те НЕ ловят
   връщането назад и не бива да се четат така. Измерено на тази машина: със
   стария код приключването отнема ~158 ms при праг 250 ms, тоест тестът минава
   и с дефекта; при натоварена машина същият праг пада и при поправения код.
   Оставени са като груб предпазител срещу нещо драстично, а истинската преграда
   е правилото за db.prepare() в обхождането по-долу.

   Всеки тест е проверен с мутация. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { APP_DIR, cleanupTmpDirs } = require('./helpers/audit-fixtures');
const { startMainApp } = require('./helpers/main-app');

test.after(cleanupTmpDirs);

const iso = (d) => d.toISOString().slice(0, 10);
const dayOff = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

/* ---------- истинското приложение + база при работен мащаб ----------
   4 000 документа, а не 15 000: измерването беше на 15 000, но разликата се
   вижда еднакво добре и тук, а поредицата от тестове трябва да свършва бързо.
   Праговете по-долу са изчислени за ТОЗИ мащаб. */
const BOOKS = 4000;
let app = null, db = null;

async function boot() {
  if (app) return app;
  app = startMainApp();
  await app.ready();
  db = new Database(path.join(app.userData, 'library.db'));
  const cat = db.prepare("SELECT id FROM categories WHERE name = 'книга'").get().id;
  const insB = db.prepare(`INSERT INTO books (inv_number, barcode, register_date, title, author,
      category_id, year, language, department, status, price, udk, call_number)
    VALUES (@inv,@bc,@reg,@title,@author,@cat,@year,@lang,@dep,@status,@price,@udk,@cn)`);
  const insI = db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)');
  db.transaction(() => {
    for (let i = 1; i <= BOOKS; i++) {
      const info = insB.run({ inv: i, bc: 'B' + i, reg: dayOff(2000 - Math.floor(i / 4)),
        title: 'Книга ' + i, author: 'Автор ' + (i % 300), cat, year: String(1960 + (i % 60)),
        lang: 'български', dep: i % 3 === 0 ? 'детски' : 'за възрастни',
        status: i % 200 === 0 ? 'отчислен' : 'наличен',
        price: (1 + (i % 17)) * 1.1, udk: '5', cn: 'Ч/' + (i % 400) });
      insI.run(info.lastInsertRowid, 1);
    }
  })();
  return app;
}
// Без това процесът виси: startMainApp() пуска таймера за автоматично публикуване.
test.after(() => { if (db) db.close(); if (app) app.stop(); });

/* ---------------- 1. Приключване на инвентаризация ---------------- */

test('приключената проверка отбелязва СЪЩИТЕ документи като липсващи — и то с една заявка, не с една на документ', async () => {
  await boot();
  const sid = (await app.invoke('inventorySessions:start', { date: dayOff(0), scope: 'целият фонд',
    committee1: 'А. Иванова', committee2: 'Б. Петров', committee3: 'В. Георгиева', order_no: '1' })).data;
  // Комисията минава всеки трети документ.
  const scanned = [];
  for (let i = 1; i <= BOOKS; i += 3) {
    const r = await app.invoke('inventorySessions:scan', { sessionId: sid, code: 'B' + i });
    if (r.ok) scanned.push(i);
  }
  /* Независимо изчисление: липсващи са тези в обхвата, които не са сканирани и
     не са заети. Смята се ТУК, от суровите редове, преди приключването. */
  const poolIds = db.prepare("SELECT id FROM books WHERE status != 'отчислен' OR status IS NULL").all().map(r => r.id);
  const scannedIds = new Set(db.prepare('SELECT book_id FROM inventory_session_scans WHERE session_id = ?')
    .all(sid).map(r => r.book_id));
  const onLoan = new Set(db.prepare('SELECT book_id FROM loans WHERE date_in IS NULL').all().map(r => r.book_id));
  const expected = poolIds.filter(id => !scannedIds.has(id) && !onLoan.has(id)).sort((a, b) => a - b);

  const t0 = Date.now();
  const r = await app.invoke('inventorySessions:close', { sessionId: sid, mode: 'full' });
  const ms = Date.now() - t0;
  assert.equal(r.ok, true, r.error);

  const got = db.prepare('SELECT book_id FROM inventory_session_missing WHERE session_id = ? ORDER BY book_id')
    .all(sid).map(x => x.book_id);
  assert.deepEqual(got, expected, 'вписаните липсващи трябва да са същите като изчислените независимо');
  assert.equal(r.data.missing, expected.length);

  const marked = db.prepare("SELECT id FROM books WHERE status = 'липсващ' ORDER BY id").all().map(x => x.id);
  assert.deepEqual(marked, expected, 'СЪЩИТЕ документи трябва да са отбелязани в картона си');
  const sample = db.prepare('SELECT status_date FROM books WHERE id = ?').get(expected[0]);
  assert.equal(sample.status_date, dayOff(0), 'датата на състоянието е днешната');

  /* Прагът: старият начин (db.prepare вътре в обхождането + по едно UPDATE на
     ред) отнемаше 657 ms при 15 000 документа и ~200 ms при тези 4 000.
     Поправеният — под 60 ms. 250 ms лови връщането назад с голям запас. */
  assert.ok(ms < 250, 'приключването отне ' + ms + ' ms — прозорецът стои залепнал точно при „Приключи“');
});

test('представителната проверка не отбелязва нищо като липсващо', async () => {
  await boot();
  db.prepare("UPDATE books SET status='наличен' WHERE status='липсващ'").run();
  const sid = (await app.invoke('inventorySessions:start', { date: dayOff(0), scope: 'извадка',
    committee1: 'А', committee2: 'Б', committee3: 'В', order_no: '2' })).data;
  await app.invoke('inventorySessions:scan', { sessionId: sid, code: 'B7' });
  const r = await app.invoke('inventorySessions:close', { sessionId: sid, mode: 'representative' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.missing, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books WHERE status = 'липсващ'").get().n, 0,
    'при представителна проверка непроверените НЕ са липсващи');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_session_missing WHERE session_id = ?').get(sid).n, 0);
});

/* ---------------- 2. Акт за отчисляване ---------------- */

test('акт за много документи се съставя и анулира вярно — и без по една сглобена заявка на документ', async () => {
  await boot();
  db.prepare("UPDATE books SET status='наличен' WHERE status='липсващ'").run();
  const ids = db.prepare("SELECT id FROM books WHERE status='наличен' ORDER BY id LIMIT 1200").all().map(r => r.id);
  const before = new Map(db.prepare('SELECT id, status FROM books WHERE id IN (' + ids.join(',') + ')')
    .all().map(r => [r.id, r.status]));

  const t0 = Date.now();
  const cr = await app.invoke('deaccessionActs:create', {
    act: { date: dayOff(0), reason_code: 1, reason_text: 'морално остарели', no: 1, year: dayOff(0).slice(0, 4) },
    bookIds: ids
  });
  const msCreate = Date.now() - t0;
  assert.equal(cr.ok, true, cr.error);
  const actId = cr.data;

  const items = db.prepare('SELECT book_id, inv_number FROM deaccession_items WHERE act_id = ? ORDER BY book_id').all(actId);
  assert.deepEqual(items.map(i => i.book_id), ids, 'в акта трябва да влязат точно подадените документи');
  const off = db.prepare("SELECT COUNT(*) AS n FROM books WHERE status='отчислен' AND deaccession_act_id = ?").get(actId).n;
  assert.equal(off, ids.length, 'всички трябва да са отчислени');

  const t1 = Date.now();
  const rv = await app.invoke('deaccessionActs:revoke', actId, { reason: 'сгрешен акт (тест)' });
  const msRevoke = Date.now() - t1;
  assert.equal(rv.ok, true, rv.error);

  const after = db.prepare('SELECT id, status, deaccession_act_id, deaccession_date FROM books WHERE id IN ('
    + ids.join(',') + ')').all();
  for (const b of after) {
    assert.equal(b.status, before.get(b.id), 'анулирането връща предишното състояние на инв. ред ' + b.id);
    assert.equal(b.deaccession_act_id, null);
    assert.equal(b.deaccession_date, null);
  }
  /* v2.4.56: актът НЕ се трие при анулиране — той е документ по чл. 39, а и
     номерът му не бива да отива на друг акт (чл. 35). Редът остава, отбелязан
     като анулиран, а всяко броене на отчислени го подминава. */
  const revokedAct = db.prepare('SELECT revoked_at, no FROM deaccession_acts WHERE id = ?').get(actId);
  assert.ok(revokedAct, 'редът на акта остава');
  assert.ok(revokedAct.revoked_at, 'и носи дата на анулиране');

  /* Измерено при 2 000 документа преди поправката: 223 ms за съставянето и
     212 ms за анулирането; след нея — 126 ms и 45 ms. При тези 1 200 праговете
     са с двоен запас. */
  assert.ok(msCreate < 400, 'съставянето на акта отне ' + msCreate + ' ms');
  assert.ok(msRevoke < 200, 'анулирането отне ' + msRevoke + ' ms');
});

/* ---------------- 3. Публичният katalog.json ---------------- */

test('katalog.json се разчита като точно същия обект — и е с една трета по-малък', async () => {
  await boot();
  const dir = path.join(app.userData, 'kat-test');
  fs.mkdirSync(dir, { recursive: true });
  db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(dir);
  const r = await app.invoke('catalog:writeNow');
  assert.equal(r.ok, true, r.error);
  const file = path.join(dir, 'katalog.json');
  const text = fs.readFileSync(file, 'utf8');

  const parsed = JSON.parse(text);                       // 1) валиден JSON
  assert.ok(Array.isArray(parsed.items) && parsed.items.length > 0, 'каталогът има записи');
  assert.equal(typeof parsed.library, 'string');
  assert.equal(typeof parsed.generated, 'string');

  /* 2) СЪЩИТЕ данни — сверени с НЕЗАВИСИМ източник, самата база, а не с
     повторно разчитане на същия текст (проверка при прегледа на v2.4.49:
     дотук тук стоеше JSON.stringify(parsed) === JSON.stringify(JSON.parse(
     JSON.stringify(parsed))), което е вярно за всеки обект и не проверява нищо). */
  const inDb = db.prepare(`SELECT COUNT(*) AS n FROM books
    WHERE status != 'отчислен' AND COALESCE(department,'') != 'служебен'`).get().n;
  assert.equal(parsed.items.length, inDb, 'във файла трябва да са всички публикуеми документи');
  const sample = parsed.items[0];
  const row = db.prepare('SELECT title, author, inv_number FROM books WHERE inv_number = ?').get(sample.inv);
  assert.ok(row, 'записът от файла съществува в базата: инв. № ' + sample.inv);
  assert.equal(sample.t, row.title, 'заглавието във файла е това от базата');
  assert.equal(sample.a, row.author, 'авторът във файла е този от базата');

  /* 3) Един запис на ред: точно толкова реда, колкото са записите. Това е
     смисълът на формата — заради git diff-а и заради големината на файла. */
  const itemLines = text.split('\n').filter(l => /^ {4}\{/.test(l));
  assert.equal(itemLines.length, parsed.items.length + (parsed.shelves ? parsed.shelves.length : 0),
    'всеки запис трябва да е на свой ред');

  /* 4) По-малък от стария начин. Измерено при 14 644 заглавия: 6,01 → 4,00 МБ. */
  const old = JSON.stringify(parsed, null, 2);
  assert.ok(text.length < old.length * 0.8,
    'новият файл е ' + text.length + ' байта срещу ' + old.length + ' по стария начин — очакваше се поне 20 % по-малко');

  /* 5) Всеки ред със запис сам по себе си е валиден JSON — това е, което прави
     разликата в git смислена, а файла — четим от човек. */
  const one = JSON.parse(itemLines[0].trim().replace(/,$/, ''));
  assert.ok(one && typeof one === 'object', 'редът със запис е самостоятелен обект');
});

test('сглобяването на katalog.json пада обратно към стария начин, ако проверката не мине', () => {
  /* Функцията се ИЗПЪЛНЯВА, а не се чете (проверка при прегледа на v2.4.49:
     дотук тестът само търсеше редове в main.js — празно тяло би минало).
     Вади се от main.js и се пуска върху три товара: обикновен, със зли знаци и
     такъв, който НЕ може да се запише вярно. */
  const src = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  const body = src.match(/function catalogJsonText\(payload\) \{[\s\S]*?\n\}/);
  assert.ok(body, 'липсва сглобяването');
  const silent = { error() {} };                       // без шум в изхода на теста
  const catalogJsonText = new Function('console', body[0] + '; return catalogJsonText;')(silent);

  const normal = { library: 'Б', generated: '2026-09-10', items: [{ inv: 1, t: 'Т' }, { inv: 2, t: 'Д' }] };
  assert.equal(JSON.stringify(JSON.parse(catalogJsonText(normal))), JSON.stringify(normal),
    'обикновеният товар се разчита като същия обект');
  assert.match(catalogJsonText(normal), /\n {4}\{"inv":1,"t":"Т"\},\n/, 'по един запис на ред');

  /* Зли знаци, каквито има в истински фонд: кавички, нов ред, обратна наклонена
     черта, кирилица, емоджи, „</script>“. */
  const nasty = { library: 'Б "х" \\ у', items: [{ inv: 3, t: 'ред1\nред2\tтаб "цитат"' },
    { inv: 4, t: '</script><img src=x onerror=alert(1)>', a: '😀' }] };
  assert.equal(JSON.stringify(JSON.parse(catalogJsonText(nasty))), JSON.stringify(nasty),
    'и злите знаци се разчитат като същия обект');

  /* Товар, който НЕ може да се сглоби вярно (undefined не е JSON): трябва да
     падне обратно към стария начин, а не да произведе счупен файл. */
  const bad = { a: 1, u: undefined, items: [{ inv: 5 }] };
  const out = catalogJsonText(bad);
  assert.equal(out, JSON.stringify(bad, null, 2), 'при разминаване се пише по стария начин');
  JSON.parse(out);                                    // и той е валиден JSON

  assert.match(src, /fs\.writeFileSync\(tmp, catalogJsonText\(payload\), 'utf8'\)/,
    'записът трябва да минава през сглобяването');
  const cat = fs.readFileSync(path.join(APP_DIR, 'handlers', 'catalog.js'), 'utf8');
  assert.match(cat, /fs\.writeFileSync\(filePath, catalogJsonText\(payload\), 'utf8'\)/,
    'ръчното извеждане пише в СЪЩИЯ формат — иначе изведен файл в папката на каталога прави 2 МБ разлика в git');
});

/* ---------------- 4. Пропускът, който е общ и на трите ---------------- */

/* Тялото на едно обхождане, отрязано по БАЛАНСИРАНИ скоби, а не по брой знаци:
   правило, което гледа „600 знака след еди-кое си“, пропуска нарушение малко
   по-надолу в същото обхождане — точно това се случи с UPDATE-а при съставянето
   на акта (намерен при прегледа на v2.4.49). */
function loopBody(src, marker) {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, 'липсва обхождането „' + marker + '“');
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(i, j + 1); }
  }
  throw new Error('незатворено обхождане: ' + marker);
}

test('в нито едно обхождане не се сглобява заявка наново на всеки ред', () => {
  /* Това е ПРАВИЛОТО, а не отделен случай: db.prepare() компилира SQL. Вътре в
     обхождане на 15 000 реда това са 15 000 компилации на един и същ низ.
     Проверяват се четирите обхождания от този кръг — за целия проект правилото
     би било гадаене, защото има и напълно основателни db.prepare() в цикъл
     (напр. по РАЗЛИЧНИ таблици). */
  const inv = fs.readFileSync(path.join(APP_DIR, 'handlers', 'inventory-sessions.js'), 'utf8');
  const acts = fs.readFileSync(path.join(APP_DIR, 'handlers', 'deaccession-acts.js'), 'utf8');
  const closeBody = inv.slice(inv.indexOf("ipcMain.handle('inventorySessions:close'"));

  for (const [src, marker, what] of [
    [closeBody, 'missing.forEach(', 'отбелязването на липсващите'],
    [acts, 'bookIds.forEach(', 'съставянето на акта'],
    [acts, 'items.forEach(', 'анулирането на акта']
  ]) {
    const body = loopBody(src, marker);
    assert.equal(/db\.prepare\(/.test(body), false,
      'db.prepare() е вътре в обхождането при ' + what + ' — компилира се наново на всеки документ');
  }

  /* И положителната страна: заявките наистина съществуват, сглобени веднъж. */
  assert.match(closeBody, /UPDATE books SET status='липсващ'[\s\S]{0,200}id IN \(SELECT book_id FROM inventory_session_missing/,
    'отбелязването трябва да е ЕДНА заявка върху вписаните редове');
  assert.match(closeBody, /SELECT id, inv_number, title, author, price, status FROM books/,
    'обхватът трябва да тегли шестте ползвани полета, а не всичките 38');
  assert.match(acts, /const bookStmt = db\.prepare\(/, 'заявката за документа — веднъж');
  assert.match(acts, /const offStmt = db\.prepare\(/, 'отчисляването на документа — веднъж');
  assert.match(acts, /const backStmt = db\.prepare\(/, 'връщането на състоянието — веднъж');
});
