'use strict';
/* v2.4.44 — тридесет и трети кръг: пълна проверка на работата.
   =====================================================================
   Всяко от поправеното тук беше ВЪЗПРОИЗВЕДЕНО преди поправката — на истински
   бази при реален мащаб (15 000 книги) и в истински прозорец. Тестовете държат
   точно тези сценарии, не общи твърдения.

   Всеки тест е проверен с мутация (виж описанието на кръга в CHANGELOG). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, cleanupTmpDirs, freshDb, fakeIpcMain, runDep, buildDom, settle } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

const H = (name) => require(path.join(APP_DIR, 'handlers', name));
const SRC = path.join(APP_DIR, 'src');
const CSS = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');

/* ---------------- 1. Пари и официална статистика: едно щракване = едно вписване ---------------- */

test('двойно щракване по бутон в прозорец не праща действието два пъти', async () => {
  /* closeModal() маха прозореца чак след 140 ms, а бутонът дотук не се
     заключваше: измерено в jsdom, „Плати“ с 4,50 лв. пращаше account.pay ДВА
     ПЪТИ и читателят се кредитираше с 9,00 лв.; „Впиши посещения“ пращаше
     visits.add два пъти, а handlers/visits.js събира — 50 посещения ставаха 100
     в официалната статистика, без грешка и без второ съобщение. */
  const dom = buildDom({
    'readers.get': { id: 7, name: 'Иван Петров', card_no: '0007' },
    'account.get': { balance: 0, lines: [] },
    'settings.get': {}, 'account.pay': 5
  });
  const { window } = dom, d = window.document;
  await settle();
  window.payAccount(7);
  await settle();
  d.querySelector('#payF [name=amount]').value = '4.50';
  const btn = [...d.querySelectorAll('#modal2 footer .btn')].find(b => b.textContent === 'Плати');
  assert.ok(btn, 'липсва бутонът „Плати“');
  btn.focus();
  btn.click();
  btn.click();                     // второто попадение на обикновено двойно щракване
  await settle();
  assert.equal((dom.calls['account.pay'] || []).length, 1,
    'плащането трябва да тръгне ВЕДНЪЖ, а не веднъж на щракване');

  /* Заключването на бутона е ВТОРАТА преграда, не единствената: браузърът сам
     не задейства изключен бутон, тоест ако тестът спре дотук, той проверява
     поведението на браузъра, а не пазача. Enter в поле, повикване от код,
     клавишна комбинация — при тях фокусът не е върху бутон, „lock“ е null и
     остава единствено наборът ONCE_RUNNING. Затова второто повикване се прави
     БЕЗ бутон: точно то живееше при мутация, докато го нямаше. */
  window.payAccount(7);
  await settle();
  d.querySelector('#payF [name=amount]').value = '4.50';
  d.body.focus();
  assert.notEqual(d.activeElement && d.activeElement.tagName, 'BUTTON', 'фокусът не бива да е на бутон');
  const before = (dom.calls['account.pay'] || []).length;
  window.savePayment(7);
  window.savePayment(7);           // същият тик — само наборът може да го спре
  await settle();
  assert.equal((dom.calls['account.pay'] || []).length - before, 1,
    'без бутон за заключване второто повикване се спира от самия пазач');
});

test('пазачът срещу двойно вписване покрива всяко действие от списъка си', async () => {
  /* Списъкът е по ИМЕ. Преименувана функция иначе би останала без пазач, без
     нищо да се счупи и без нищо да проличи — затова се проверява, че всяко име
     наистина съществува. */
  const dom = buildDom({});
  const { window } = dom;
  await settle();
  const src = fs.readFileSync(path.join(SRC, 'views', 'bootstrap.js'), 'utf8');
  const list = /const ONCE_ACTIONS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(list, 'липсва списъкът ONCE_ACTIONS');
  const names = [...list[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(names.length >= 20, 'очаквах поне двайсет пазени действия, намерени ' + names.length);
  const missing = names.filter(n => typeof window[n] !== 'function');
  assert.deepEqual(missing, [], 'тези имена от списъка не съществуват');
});

test('второто вписване се пуска нормално, след като първото приключи', async () => {
  // Пазачът НЕ бива да заключва действието завинаги — иначе едно плащане на ден.
  const dom = buildDom({
    'readers.get': { id: 7, name: 'И. П.' }, 'account.get': { balance: 0, lines: [] },
    'settings.get': {}, 'account.pay': 5
  });
  const { window } = dom, d = window.document;
  await settle();
  for (let i = 0; i < 2; i++) {
    window.payAccount(7);
    await settle();
    d.querySelector('#payF [name=amount]').value = '1';
    [...d.querySelectorAll('#modal2 footer .btn')].find(b => b.textContent === 'Плати').click();
    await settle();
  }
  assert.equal((dom.calls['account.pay'] || []).length, 2, 'две отделни плащания трябва да минат');
});

/* ---------------- 2. Внос от файл: баркодове ---------------- */

function importSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  const ipcMain = fakeIpcMain();
  const books = H('books.js');
  return { db, dir, ipcMain, assertUniqueBarcode: books.assertUniqueBarcode };
}

test('вносът от файл не си измисля баркод, равен на инвентарния номер', () => {
  /* Дотук при файл БЕЗ колона за баркод вносът слагаше String(inv) — точно
     сблъсъкът, който assertUniqueBarcode пази: заварен документ с етикет „700“
     и внесен документ с инв. № 700 стават неразличими при сканиране и
     resolveScannedBook() отказва И ДВАТА, седмици по-късно и далеч от причината. */
  const src = fs.readFileSync(path.join(APP_DIR, 'handlers', 'data-import.js'), 'utf8');
  assert.equal(/barcode:\s*cell\(row,\s*'barcode'\)\s*\|\|\s*String\(inv\)/.test(src), false,
    'вносът пак си измисля баркод от инвентарния номер');
  assert.match(src, /barcode:\s*cell\(row,\s*'barcode'\)\s*\|\|\s*null/);
  assert.match(src, /assertUniqueBarcode\(db, payload\.barcode, payload\.inv_number, null\)/,
    'вносът трябва да минава през същата проверка, която пази формата');
});

test('проверката за баркод отказва и двата сблъсъка, които чупят сканирането', () => {
  const s = importSetup('aud-bc');
  const ins = s.db.prepare(`INSERT INTO books (inv_number, title, barcode, register_date, price)
    VALUES (?, ?, ?, '2026-01-01', 1)`);
  ins.run(12, 'Тютюн', '700');
  // 1) същият етикет на втори документ
  assert.throws(() => s.assertUniqueBarcode(s.db, '700', 5, null), /вече е на инв. № 12/);
  // 2) етикет, равен на ЧУЖД инвентарен номер
  ins.run(700, 'Под игото', null);
  assert.throws(() => s.assertUniqueBarcode(s.db, '12', 9, null), /съвпада с инвентарния номер/);
  // празен баркод си е редовен — етикетът се печата после
  assert.doesNotThrow(() => s.assertUniqueBarcode(s.db, null, 9, null));
});

/* ---------------- 3. Протоколът по чл. 40 трябва да се събира ---------------- */

test('приключената инвентаризация брои проверените СРЕЩУ обхвата, не всички сканирания', async () => {
  /* Обхватът се смята наново при приключване, а сканиранията са всичко, което
     комисията е минала. Книга, отчислена по време на проверката, излиза от
     обхвата, но си остава сканирана — дотук протоколът гласеше „в обхвата 9 ·
     проверени 6 · липсващи 4“, тоест 10 от 9 в подписан документ. */
  const { db } = freshDb('aud-inv');
  const ipcMain = fakeIpcMain();
  const { normalizeScanCode, pctRequired } = require('./helpers/prod-values.js');
  const deps = { getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-09-09',
    pctRequired, naturalLoss: () => 0, normalizeScanCode };
  H('inventory-sessions.js')(ipcMain, deps);
  const ins = db.prepare(`INSERT INTO books (inv_number, title, barcode, department, status, register_date, price)
    VALUES (?, ?, ?, 'за възрастни', 'наличен', '2026-01-01', 1)`);
  for (let i = 1; i <= 10; i++) ins.run(i, 'Книга ' + i, 'BC' + i);
  const ok = async (ch, ...a) => { const r = await ipcMain.invoke(ch, ...a); assert.equal(r.ok, true, ch + ': ' + r.error); return r.data; };
  const sid = await ok('inventorySessions:start', {
    date: '2026-09-09', scope: 'целият фонд', department: 'за възрастни',
    committee1: 'А. Иванова', committee2: 'Б. Петров', committee3: 'В. Георгиева', order_no: '3'
  });
  for (let i = 1; i <= 6; i++) await ok('inventorySessions:scan', { sessionId: sid, code: 'BC' + i });
  // Инв. № 3 се оказва похабена и се отчислява ДОКАТО проверката тече.
  db.prepare("UPDATE books SET status='отчислен' WHERE inv_number=3").run();
  const r = await ok('inventorySessions:close', { sessionId: sid, mode: 'full' });
  assert.equal(r.pool, 9, 'обхватът към приключването');
  assert.equal(r.scanned, 5, 'проверени СРЕЩУ обхвата (шестата вече не е в него)');
  assert.equal(r.outOfScope, 1, 'излязлото от обхвата се обявява, а не се скрива');
  assert.equal(r.scanned + r.missing + r.onLoan + r.atBinder, r.pool,
    'четирите числа трябва да се събират до обхвата: ' +
    [r.scanned, r.missing, r.onLoan, r.atBinder].join('+') + ' ≠ ' + r.pool);
  const row = db.prepare('SELECT pool_final, scanned_final FROM inventory_sessions WHERE id = ?').get(sid);
  assert.deepEqual([row.pool_final, row.scanned_final], [9, 5], 'снимката към приключването се записва');
});

/* ---------------- 4. Липсващият ред е отказ, не тиха успешна редакция ---------------- */

test('редакция на изтрит от друго работно място запис се отказва, вместо да остави следа', async () => {
  const { db } = freshDb('aud-missing');
  const ipcMain = fakeIpcMain();
  const audit = [];
  const deps = { getDb: () => db, run: runDep, logAudit: (a, d2) => audit.push(a + ': ' + d2) };
  H('readers.js')(ipcMain, { ...deps, pdp: { enabled: () => false }, today: () => '2026-09-09' });
  const r = await ipcMain.invoke('readers:update', { id: 1, name: 'Иван Иванов', card_no: 'B001' });
  assert.equal(r.ok, false, 'върна „ok“ за несъществуващ читател');
  assert.match(r.error, /не е намерен/);
  assert.deepEqual(audit, [], 'в одитната следа не бива да влиза редакция, каквато не се е случвала');
});

test('и останалите редакции по краезнанието отказват липсващ ред', async () => {
  for (const [file, channel, payload] of [
    ['analytics.js', 'analytics:update', { id: 999, title: 'Няма' }],
    ['persons.js', 'persons:update', { id: 999, name: 'Няма' }],
    ['chronicle.js', 'chronicle:update', { id: 999, title: 'Няма' }]
  ]) {
    const { db } = freshDb('aud-' + channel.replace(':', '-'));
    const ipcMain = fakeIpcMain();
    H(file)(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
    const r = await ipcMain.invoke(channel, payload);
    assert.equal(r.ok, false, channel + ' върна „ok“ за несъществуващ ред');
    assert.match(r.error, /не е намерен/);
  }
});

/* ---------------- 5. Търсенето на дублети при реален мащаб ---------------- */

test('хлабавото търсене на дублети е симетрично и не зависи от реда на редовете', async () => {
  /* При равен брой пълни думи за „по-късо“ се взимаше ПЪРВОТО име и се гледаха
     само неговите инициали. Затова „Иванов“ ≈ „Г. Иванов“ излизаше вярно, а
     обратното — невярно, тоест дали двата записа изобщо ще бъдат предложени за
     сливане зависеше от това кой от двата има повече книги. */
  const groups = async (values) => {
    const { db } = freshDb('aud-dup-' + Math.random().toString(36).slice(2, 8));
    const ipcMain = fakeIpcMain();
    H('authorities.js')(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
    const ins = db.prepare("INSERT INTO books (inv_number,title,author,register_date,price) VALUES (?,?,?,'2026-01-01',1)");
    values.forEach((v, i) => { for (let k = 0; k <= i; k++) ins.run(i * 100 + k + 1, 'К', v); });
    const r = await ipcMain.invoke('authorities:duplicates', { field: 'author', loose: true });
    assert.equal(r.ok, true, r.error);
    return r.data.map(g => g.items.map(x => x.value).sort().join('|')).sort();
  };
  // Един и същ чифт, разменен по брой книги — резултатът трябва да е един и същ.
  assert.deepEqual(await groups(['Иванов', 'Г. Иванов']), ['Г. Иванов|Иванов']);
  assert.deepEqual(await groups(['Г. Иванов', 'Иванов']), ['Г. Иванов|Иванов']);
  // И не разхлабва правилото:
  assert.deepEqual(await groups(['Димитър Колев', 'Димитър Костов']), [], 'различни фамилии не се сливат');
  assert.deepEqual(await groups(['Г. Иванов', 'П. Иванов']), [], 'различни инициали не се сливат');
  /* Съвпадението не е задължително с ПЪРВИЯ ред в думата. Тук „Иванов“ държи
     трима, а слива се вторият с третия — ако проверката тръгва само от първия,
     групата изобщо не се получава и никой не забелязва: изходът е празен, а
     празен изход изглежда като „няма дублети“. */
  /* Редът е по БРОЙ КНИГИ (ORDER BY n DESC) — тук нарочно най-много книги има
     несъвпадащият „А. Иванов“, за да НЕ е първи някой от съвпадащите. */
  assert.deepEqual(await groups(['Б. Иванов', 'Борис Иванов', 'А. Иванов']),
    ['Б. Иванов|Борис Иванов'], 'съвпадението е между втория и третия ред в думата');
  /* Име БЕЗ нито една пълна дума не попада в нито една дума — стеснението по
     думи би го оставило да не се сравни с нищо. Затова такива се сравняват с
     всички редове; заварени данни ги имат („И. П.“). */
  assert.deepEqual(await groups(['И. П.', 'Иван Петров']), ['И. П.|Иван Петров'],
    'име само от инициали трябва да се сравни и извън думите');
});

test('търсенето на дублети свършва бързо и при 15 000 документа', async () => {
  /* Повикването е синхронно — докато трае, прозорецът не се прерисува и
     програмата изглежда увиснала. Измерено преди поправката: 2 мин. 21 сек. */
  const { db } = freshDb('aud-dup-perf');
  const ipcMain = fakeIpcMain();
  H('authorities.js')(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  /* Тежестта зависи от броя РАЗЛИЧНИ стойности, не от броя книги: сравняват се
     имената, не документите. Затова тук се раждат ~15 000 различни автора (150
     фамилии × 100 имена), а не 15 000 книги на двеста автора — при второто
     дори напълно неоптимизираното търсене свършва мигновено и тестът би мерил
     нищо. Точно този обем стоеше 2 мин. 21 сек. */
  const ROOT = ['Иван', 'Петр', 'Георги', 'Димитр', 'Никол', 'Христ', 'Стоян', 'Тодор', 'Атанас', 'Ангел',
    'Васил', 'Кирил', 'Марин', 'Или', 'Кост', 'Петк', 'Ян', 'Кол', 'Дянк', 'Влад',
    'Богдан', 'Драг', 'Ради', 'Слав', 'Тошк', 'Хаджи', 'Цвет', 'Чакър', 'Шоп', 'Ябланск'];
  const SUF = ['ов', 'ев', 'ски', 'арев', 'ински'];
  const FAM = [];
  for (const r of ROOT) for (const s of SUF) FAM.push(r + s);      // 150
  const IROOT = ['Ив', 'Пет', 'Гер', 'Дим', 'Ник', 'Хрис', 'Сто', 'Тод', 'Мар', 'Ел',
    'Бор', 'Вел', 'Здр', 'Люб', 'Мил', 'Огн', 'Рум', 'Сил', 'Цан', 'Яв'];
  const IEND = ['ан', 'омир', 'ослав', 'ина', 'ена'];
  const IME = [];
  for (const r of IROOT) for (const e of IEND) IME.push(r + e);    // 100
  const ins = db.prepare("INSERT INTO books (inv_number,title,author,register_date,price) VALUES (?,?,?,'2026-01-01',1)");
  db.transaction(() => {
    for (let i = 0; i < 15000; i++) {
      const f = FAM[i % FAM.length], im = IME[Math.floor(i / FAM.length) % IME.length];
      // Всеки четвърти е записан само с инициал — истинската работа по сливането.
      ins.run(i + 1, 'Книга ' + (i + 1), i % 4 === 3 ? f + ', ' + im[0] + '.' : f + ', ' + im);
    }
    /* И имена БЕЗ нито една пълна дума („И. В.“) — заварени данни ги имат.
       Те не попадат в нито една дума и по необходимост се сравняват с ВСИЧКИ
       редове: единственото, което ги удържа, е пропускането на вече слетите
       двойки. Без тези редове онзи клон изобщо не се изпълнява и тестът не мери
       най-скъпото място в повикването. */
    const AZ = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЮЯ';
    let n = 15001;
    for (const a of AZ) for (const b of AZ.slice(0, 8)) ins.run(n++, 'Книга ' + n, a + '. ' + b + '.');
  }).immediate();
  assert.equal(db.prepare('SELECT COUNT(DISTINCT author) AS n FROM books').get().n > 12000, true,
    'фикстурата трябва да носи над 12 000 РАЗЛИЧНИ автора, иначе не мери нищо');
  const t0 = Date.now();
  const r = await ipcMain.invoke('authorities:duplicates', { field: 'author', loose: true });
  const ms = Date.now() - t0;
  assert.equal(r.ok, true, r.error);
  assert.ok(ms < 1500, 'хлабавото търсене отне ' + ms + ' ms — програмата стои залепнала през това време');
});

/* ---------------- 6. Екраните ---------------- */

test('бележката за читателя се показва като текст, а не като кода, който я изписва', async () => {
  const dom = buildDom({
    'readers.list': [{ id: 1, name: 'Иван Вазов', card_no: '0001', status: 'активен',
      alert_note: 'носи още старата книга на брат си', open_loans: 0 }]
  });
  const { window } = dom, d = window.document;
  await settle();
  window.location.hash = '#readers';
  await window.route();
  await settle();
  const badge = d.querySelector('#view .badge.w');
  assert.ok(badge, 'липсва значката „бележка“');
  assert.equal(badge.getAttribute('title'), 'носи още старата книга на брат си',
    'подсказката трябва да е самата бележка — тя е единственото място, където текстът ѝ се вижда в списъка');
});

test('„Баркод етикети“ се отваря и когато базата не върне настройки', async () => {
  /* call() връща null при отказ от базата (заета от другото работно място).
     Разделът беше единственият, който гърми — заглавието ставаше „Баркод
     етикети“ върху съдържанието на предишния раздел. */
  const dom = buildDom({ 'settings.get': null });
  const { window } = dom, d = window.document;
  await settle();
  window.location.hash = '#labels';
  await window.route();
  await settle();
  assert.match(d.getElementById('view').innerHTML, /Формат на печат за етикети/,
    'разделът не се отвори: ' + d.getElementById('view').innerHTML.slice(0, 120));
});

test('кардексът опреснява списъка и при затваряне с ✕ или с Esc, не само с бутона', async () => {
  const dom = buildDom({
    'periodicals.list': [{ id: 1, title: 'в-к Труд', issues_count: 1 }],
    'periodicals.get': { id: 1, title: 'в-к Труд', issues: [] }
  });
  const { window } = dom, d = window.document;
  await settle();
  window.location.hash = '#periodika';
  await window.route();
  await settle();
  const before = (dom.calls['periodicals.list'] || []).length;

  await window.openPeriodical(1);
  await settle();
  d.querySelector('#modal .x').click();          // ✕ в заглавието
  await settle();
  assert.ok((dom.calls['periodicals.list'] || []).length > before, 'затварянето с ✕ не опресни списъка');

  const mid = (dom.calls['periodicals.list'] || []).length;
  await window.openPeriodical(1);
  await settle();
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  assert.ok((dom.calls['periodicals.list'] || []).length > mid, 'затварянето с Esc не опресни списъка');
});

test('вече въведеният автор се предлага и в следващата форма', async () => {
  /* Списъкът за автодовършване се смяташе веднъж на пускане. При „Запиши и нов“
     с партида от 40 книги нито едно от въведените имена не се подсказваше —
     точно раздвояването („Вазов, Иван“ / „Иван Вазов“), което помощта пази. */
  let suggest = { author: ['Ботев, Христо'] };
  const dom = buildDom({
    'authorities.suggest': () => suggest,
    'books.create': 5, 'categories.list': [], 'shelves.list': [], 'books.list': { rows: [], total: 0 },
    'settings.get': { next_inv_number: 2 }
  });
  const { window, calls } = dom, d = window.document;
  await settle();
  await window.bookForm(null);
  await settle();
  const first = (calls['authorities.suggest'] || []).length;

  suggest = { author: ['Ботев, Христо', 'Вазов, Иван'] };
  window.forgetAuthSuggest();                      // това прави saveBook при успех
  await window.bookForm(null);
  await settle();
  assert.ok((calls['authorities.suggest'] || []).length > first, 'списъкът не беше поискан наново');
  const opts = [...d.querySelectorAll('#dl_author option')].map(o => o.value);
  assert.ok(opts.includes('Вазов, Иван'), 'току-що въведеният автор липсва в подсказките: ' + opts.join(', '));
});

test('записът на книга и вносът от файл забравят стария списък за автодовършване', () => {
  const books = fs.readFileSync(path.join(SRC, 'views', 'books.js'), 'utf8');
  const imp = fs.readFileSync(path.join(SRC, 'views', 'data-import.js'), 'utf8');
  assert.match(books, /forgetAuthSuggest\(\)/, 'saveBook не забравя списъка');
  assert.match(imp, /forgetAuthSuggest\(\)/, 'вносът не забравя списъка');
});

/* ---------------- 7. Клавиатура и екранен четец ---------------- */

test('фокусът се върти в прозореца, вместо да излиза в менюто зад затъмнението', async () => {
  const dom = buildDom({ 'settings.get': {}, 'categories.list': [], 'shelves.list': [] });
  const { window } = dom, d = window.document;
  await settle();
  window.modal('Проба', '<input id="a"><input id="b">', '<button class="btn" id="c">Затвори</button>');
  await settle();
  const box = d.getElementById('modal');
  assert.equal(box.getAttribute('role'), 'dialog', 'прозорецът трябва да се обяви като диалог');
  assert.equal(box.getAttribute('aria-modal'), 'true');

  /* Първият елемент по обхода е ✕ в заглавието — то стои преди тялото. */
  const x = box.querySelector('header button.x');
  assert.ok(x, 'липсва бутонът за затваряне');

  const last = d.getElementById('c');
  last.focus();
  const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  d.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'Tab от последния елемент трябва да се прихване');
  assert.equal(d.activeElement, x, 'фокусът се връща в началото на прозореца, не в менюто');

  x.focus();
  const back = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  d.dispatchEvent(back);
  assert.equal(back.defaultPrevented, true, 'Shift+Tab от първия трябва да се прихване');
  assert.equal(d.activeElement.id, 'c', 'Shift+Tab от първия отива на последния');
});

test('въпросът „Сигурни ли сте“ също държи фокуса при себе си', async () => {
  /* Въпросът стои НАД отворената форма: ако обходът излезе от него, Tab минава
     през полетата на формата отдолу, а Enter там задейства нейния бутон —
     тоест точно действието, което въпросът още не е потвърдил. */
  const dom = buildDom({ 'settings.get': {} });
  const { window } = dom, d = window.document;
  await settle();
  delete window.confirm;                       // иначе askConfirm минава по краткия път
  const p = window.askConfirm('Да изтрия ли записа?', { kind: 'delete' });
  await settle();
  const box = d.getElementById('modalC');
  assert.equal(box.getAttribute('role'), 'alertdialog');
  const btns = [...box.querySelectorAll('[data-ask]')];
  assert.equal(btns.length, 2, 'въпросът има два бутона');
  btns[1].focus();
  const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  d.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'Tab от последния бутон на въпроса трябва да се прихване');
  assert.equal(d.activeElement, btns[0], 'фокусът се връща на „Отказ“, не влиза във формата отдолу');
  btns[0].click();
  assert.equal(await p, false);
});

/* ---------------- 8. Стилове: измеримото ---------------- */

const hex = (h) => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); };
const lum = (c) => { const s = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]; };
const ratio = (a, b) => { const A = lum(hex(a)), B = lum(hex(b)); return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05); };
function themes() {
  return CSS.split(/(?=:root\{|html\[data-theme)/).filter(b => /--spine:/.test(b)).map((b, i) => {
    const g = (n) => (b.match(new RegExp('--' + n + ':\\s*(#[0-9A-Fa-f]{6})')) || [])[1];
    return { name: (b.match(/data-theme="(\d)"/) || [, '1'])[1], spine: g('spine'),
      paper: g('paper'), paper2: g('paper2'), paper3: g('paper3'), brassL: g('brassL'), brassD: g('brassD') };
  });
}

test('приглушеният текст в лентата се чете във ВСЯКА тема', () => {
  /* Зашитото #8A8168 падаше до 2,67:1 върху темата по подразбиране при
     изискване 4,5:1 — а лентата стои на всичките 24 екрана. */
  const dim = (CSS.match(/--spineDim:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
  assert.ok(dim, 'липсва токенът --spineDim');
  assert.equal(/#8A8168/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'зашитият цвят се е върнал');
  const list = themes();
  assert.ok(list.length >= 7, 'очаквах поне седем теми, намерени ' + list.length);
  for (const t of list) {
    const r = ratio(dim, t.spine);
    assert.ok(r >= 4.5, 'тема ' + t.name + ': ' + r.toFixed(2) + ':1 при изискване 4,5:1');
  }
});

test('пръстенът на фокуса се вижда и върху хартията, и в тъмната лента', () => {
  assert.match(CSS, /:where\(button,a,select\):focus-visible\{outline:2px solid var\(--brassD\)/,
    'пръстенът върху светлото трябва да е с --brassD (светлият тон пада до 1,63:1)');
  assert.match(CSS, /#rail :where\(button,a,select\):focus-visible\{outline-color:var\(--brassL\)\}/,
    'в тъмната лента е обратното — там --brassD пада до 1,19:1');
  for (const t of themes()) {
    for (const bg of ['paper', 'paper2', 'paper3']) {
      const r = ratio(t.brassD, t[bg]);
      assert.ok(r >= 3, 'тема ' + t.name + ' върху --' + bg + ': ' + r.toFixed(2) + ':1 при изискване 3:1');
    }
    assert.ok(ratio(t.brassL, t.spine) >= 3, 'тема ' + t.name + ' в лентата: ' + ratio(t.brassL, t.spine).toFixed(2));
  }
});

test('официалните документи се печатат на бяло', () => {
  /* body носи var(--paper) — кремаво, синкаво или розово според темата — а
     „Запази PDF…“ печата с printBackground:true. Инвентарната книга, която се
     прошнурова и заверява по чл. 26, ал. 2, излизаше цветна от край до край. */
  const print = CSS.slice(CSS.indexOf('@media print{'));
  assert.match(print.slice(0, 900), /body\{background:#fff\}/, 'печатът не изсветлява фона на страницата');
});

test('читателската карта се печата така, както изглежда в прегледа', () => {
  /* Картата носи ДВАТА класа (.lbl .rcard), а setPrintPage() влага правило за
     .lbl (align-items:center) в <style> СЛЕД този файл — при еднаква тежест
     печелеше то и отпечатаната карта се подреждаше по средата (измерено:
     заглавната лента 64 px вместо 338 px). */
  assert.match(CSS, /\.lbl\.rcard, \.rcard\{/, 'правилото за картата трябва да е с по-висока тежест от .lbl');
  const core = fs.readFileSync(path.join(SRC, 'views', 'core.js'), 'utf8');
  assert.match(core, /<div class="lbl rcard">/, 'картата пак ли носи двата класа?');
});

test('„намалено движение“ спира и последните три движения', () => {
  /* Блокът свършва при затваряща скоба в НАЧАЛОТО на ред — вътрешните правила
     също завършват с „}“ и наивното търсене отрязва след първото от тях. */
  const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce){'));
  const first = block.slice(0, block.indexOf('\n}') + 2);
  assert.ok(first.length > 60 && first.length < 900, 'блокът е отрязан на грешно място');
  for (const sel of ['.quickBtn', '.prsCard', '.chrItem', '.bar-fill']) {
    assert.ok(first.includes(sel), 'липсва ' + sel + ' в блока за намалено движение');
  }
});

test('записаната клетка в Дневника се вижда, че е на фокус, и не се предава само с цвят', () => {
  /* „.saved“ идваше СЛЕД „:focus“ при еднаква тежест и го надвиваше: току-що
     записана клетка нямаше никакъв признак на фокус — точно когато човек се
     връща да я поправи. А самото „записано“ се предаваше единствено с цвят. */
  assert.match(CSS, /\.dnvCell\.saved:focus\{/, 'липсва фокусът върху записана клетка');
  assert.match(CSS, /\.dnvCell:focus\{[^}]*outline:2px solid var\(--brassD\)/,
    'пръстенът трябва да е истински outline — сянката при 15 % мери 1,19:1');
  const saved = CSS.slice(CSS.indexOf('.dnvCell.saved{'));
  const block = saved.slice(0, saved.indexOf('}') + 1);
  assert.match(block, /background-image:url\("data:image\/svg\+xml/,
    'записаното трябва да има и признак извън цвета');
  /* Само картинката не стига: без размер отметката се рисува в естествения си
     размер, а без отстъп надясно ляга ВЪРХУ числото — клетката е тясна (62 px)
     и текстът в нея е подравнен вдясно. */
  assert.match(block, /background-size:\s*11px 11px/, 'отметката трябва да е смалена до клетката');
  assert.match(block, /padding-right:\s*17px/, 'числото трябва да отстъпи място на отметката');
});

test('полето „Екземпляр“ е изречение, а не отрязана стойност', () => {
  const books = fs.readFileSync(path.join(SRC, 'views', 'books.js'), 'utf8');
  assert.equal(/value="1 — един инвентарен номер, един екземпляр" disabled/.test(books), false,
    'пак е <input disabled> — надписът се реже с 93 px и не може нито да се превърти, нито да се маркира');
  assert.match(books, /<div class="fieldRead">1 — един инвентарен номер, един екземпляр<\/div>/);
  assert.match(CSS, /\.fieldRead\{/);
});
