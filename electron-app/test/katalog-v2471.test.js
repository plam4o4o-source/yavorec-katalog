'use strict';
/* Кръг 45 (v2.4.71) — ОНЛАЙН КАТАЛОГ, МЗС, ИЗНОС (група „М“, агент „каталог“).
   =====================================================================
   Всяка находка тук има поне един тест, който ПАДА, ако поправката се върне
   (проверено с временно връщане на поправката). Тестовете твърдят това, което
   вижда библиотекарката: реда в katalog.json и в качения в „GitHub“ файл,
   клетката в CSV-то и полето в UNIMARC, файла в архива на пълния износ,
   въпроса на екрана „МЗС“ и реда в одитната следа.

     М3  пълен износ при заключена защита — търсенията в „Читатели“ скрити,
         PROCHETI-ME казва истината;
     М5  автоматичното публикуване генерира katalog.json наново, ако базата е
         писана от друго работно място (PRAGMA data_version);
     М6  груповото попълване на авторски знак насрочва запис на каталога;
     М7  UNIMARC 995$k и CSV „Сигнатура“ — по effectiveCallNumber();
     М10 изтриването на МЗС заявка „изпратено“/„получено“ назовава документа и
         последицата.

   Две части:
     А) обработчикът на авторския знак поотделно (М6) — без Electron; main.js
        още НЕ подава scheduleCatalogWrite на handlers/author-mark.js (виж
        доклада), затова тук се проверява самият обработчик;
     Б) истинският main.js + истинският екран (test/helpers/e2e-app.js) — М5,
        М7, М10, М3 (в този ред: М3 заключва защитата и е последен).
   Пуска се с `node --test test/katalog-v2471.test.js`. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const tmpDirs = [];
function mkTmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
/* Едно „след“ за целия файл: първо се спира програмата (при изход тя още пише
   katalog.json в свързаната папка), после се махат временните папки. */
let h = null;
test.after(() => {
  if (h) h.stop();
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { console.error('временна папка:', e.message); }
  }
});
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args)
  };
}

/* ==========================================================================
   А) М6 — ОБРАБОТЧИКЪТ НА АВТОРСКИЯ ЗНАК
   ========================================================================== */
test('М6: груповото попълване на авторски знак насрочва запис на katalog.json (само ако е попълнен знак)', async () => {
  const dir = mkTmpDir('inv-k45-am-');
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const writes = [];
  const audit = [];
  const ipc = fakeIpcMain();
  require('../handlers/author-mark')(ipc, {
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: (a, d) => audit.push(a + ': ' + d), dialog: {}, getMainWindow: () => null, fs, path,
    importers: require('../importers'),
    scheduleCatalogWrite: (kind) => writes.push(kind === undefined ? 'фонд' : kind)
  });
  assert.equal((await ipc.invoke('authorMark:loadBuiltin')).ok, true, 'вградената таблица не се зареди');
  db.prepare("INSERT INTO books (inv_number, title, author, udk, status) VALUES (1, 'Под игото', 'Вазов, Иван', '821.163.2-31', 'наличен')").run();
  db.prepare("INSERT INTO books (inv_number, title, author, udk, status) VALUES (2, 'Тютюн', 'Димов, Димитър', '821.163.2-31', 'наличен')").run();

  const r = await ipc.invoke('authorMark:fillApply');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data, 2, 'и двата празни знака трябваше да се попълнят');
  const mark = db.prepare('SELECT author_mark FROM books WHERE inv_number = 1').get().author_mark;
  assert.match(mark, /^В\s*-?\s*\d+$/, 'знакът на „Вазов“ е „В …“');
  assert.deepEqual(writes, ['фонд'], 'попълнените знаци сменят сигнатурата в онлайн каталога, а запис не беше насрочен '
    + '(или беше насрочен по бавната пътека на гишето)');

  // Втори път няма какво да се попълни — многомегабайтният файл не се пренаписва напразно.
  const r2 = await ipc.invoke('authorMark:fillApply');
  assert.equal(r2.data, 0);
  assert.deepEqual(writes, ['фонд'], 'празно групово попълване не бива да пише katalog.json');
  db.close();
});

/* ==========================================================================
   Б) ИСТИНСКИЯТ main.js + ЕКРАНЪТ
   ========================================================================== */
const E = require('./helpers/e2e-app.js');
let autoPushTick = null;
const T = E.today();
const ok = (r, what) => { assert.ok(r && r.ok, (what || '') + ': ' + (r && r.error)); return r.data; };
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const WORK = mkTmpDir('inv-k45-kat-');
const REMOTE = path.join(WORK, 'remote.git');
const REPO = path.join(WORK, 'kat');
const FILE = path.join(REPO, 'katalog.json');
const kat = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const item = (inv) => kat().items.find(i => i.inv === inv);
/* Какво е качено „в GitHub“: katalog.json от върха на клона в отдалеченото хранилище. */
const pushed = () => JSON.parse(execFileSync('git', ['--git-dir', REMOTE, 'show', 'main:katalog.json'], { encoding: 'utf8' }));
const pushedItem = (inv) => pushed().items.find(i => i.inv === inv);
const IDS = {};

test('Б0. подготовка: истинският main.js, хранилище с отдалечено копие, 10 книги', async () => {
  /* Таймерът за автоматично публикуване (setInterval на 5 минути в
     handlers/catalog.js) се улавя, за да може тестът да го „удари“, без да чака
     5 минути. Всички други таймери минават непроменени. */
  const realSetInterval = global.setInterval;
  global.setInterval = function (fn, ms, ...rest) {
    if (ms === 5 * 60 * 1000 && !autoPushTick) {
      autoPushTick = fn;
      const dummy = realSetInterval(() => {}, 1 << 30);
      if (dummy && typeof dummy.unref === 'function') dummy.unref();
      return dummy;
    }
    return realSetInterval(fn, ms, ...rest);
  };
  try { h = await E.bootApp(); }
  finally { global.setInterval = realSetInterval; }
  assert.equal(typeof autoPushTick, 'function', 'таймерът за автоматично публикуване не беше пуснат от main.js');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', REMOTE]);
  execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
  execFileSync('git', ['-C', REPO, 'remote', 'add', 'origin', REMOTE]);

  await h.waitFor(() => h.view() === 'setup');
  await h.settle();
  const st = ok(await h.api.settings.get());
  ok(await h.api.settings.update(Object.assign({}, st, { org: 'НЧ „Проба“', lib_name: 'Библиотека „Проба“', place: 'с. Яворец', loan_days: 30 })));
  await h.go('catalog');
  h.dialogs.openPaths = [REPO];
  await h.clickButton('Избери папката на хранилището…', '#view');
  await h.settle(100);
  const cat = q("SELECT id FROM categories WHERE name='книга'").id;
  const titles = ['Бай Ганьо', 'Тютюн', 'Под игото', 'Нова земя', 'Железният светилник', 'Хайдушки песни',
    'Гераците', 'Чичовци', 'Бащи и синове', 'Хамлет'];
  for (let i = 1; i <= 10; i++) {
    IDS[i] = ok(await h.api.books.create({ inv_number: i, title: titles[i - 1], author: 'Автор ' + i, category_id: cat,
      register_date: T, price: 1 }), 'книга ' + i);
  }
  ok(await h.api.readers.create({ name: 'Читател Проба', card_no: '9001', gdpr_consent: 1 }), 'читател');
  ok(await h.api.catalog.writeNow(), 'writeNow');
  assert.equal(kat().items.length, 10);
});

/* ---------- М5: промяна от друго работно място → нов katalog.json преди качването ---------- */
test('М5: автоматичното публикуване генерира katalog.json наново, ако базата е писана от друго работно място', async () => {
  // Първи цикъл: публикува наличното състояние (и снима отпечатъка на базата).
  await autoPushTick();
  let st = ok(await h.api.catalog.autoPushStatus());
  assert.equal(st.error, null, 'първото автоматично публикуване се провали: ' + st.error);
  assert.equal(pushedItem(3).av, 1, '„Под игото“ е налична и така е качена');

  // „Станция Б“: отделна връзка към същия файл заема „Под игото“ — нищо в ТОЗИ процес не го знае.
  const b = new Database(h.dbPath);
  b.pragma('busy_timeout = 5000');
  const rid = b.prepare("SELECT id FROM readers WHERE card_no = '9001'").get().id;
  b.prepare("INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?, ?, date('now'), date('now', '+30 day'))")
    .run(IDS[3], rid);
  b.close();
  assert.equal(item(3).av, 1, 'предпоставка: katalog.json още не знае за заемането на другата станция');

  await autoPushTick();
  st = ok(await h.api.catalog.autoPushStatus());
  assert.equal(st.error, null, st.error);
  assert.equal(item(3).av, 0, 'katalog.json не беше генериран наново: книгата, заета на другото работно място, стои „налична“');
  assert.equal(pushedItem(3).av, 0, 'в GitHub е качен старият файл — сайтът показва заетата книга като налична');

  // Без промяна никъде — файлът не се пренаписва напразно на всеки 5 минути.
  const m0 = fs.statSync(FILE).mtimeMs;
  await autoPushTick();
  assert.equal(fs.statSync(FILE).mtimeMs, m0, 'без промяна в базата таймерът не бива да пренаписва katalog.json');
});

test('М5: спрян от предпазителя запис — старият файл НЕ се качва, а причината стои в лентата', async () => {
  const before = execFileSync('git', ['--git-dir', REMOTE, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  // Другата станция „отчислява“ 8 от 10 — точно пробната/непълна база, от която пази предпазителят.
  const b = new Database(h.dbPath);
  b.pragma('busy_timeout = 5000');
  b.prepare("UPDATE books SET status = 'отчислен' WHERE inv_number BETWEEN 3 AND 10").run();
  b.close();
  try {
    await autoPushTick();
    const st = ok(await h.api.catalog.autoPushStatus());
    assert.ok(st.error, 'спреният запис не стигна до лентата на „Онлайн каталог“');
    assert.match(st.error, /СПРЯН/);
    assert.match(st.error, /НЕ качи стария файл/);
    assert.equal(execFileSync('git', ['--git-dir', REMOTE, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), before,
      'при спрян запис не бива да се качва нищо');
    assert.equal(kat().items.length, 10, 'публикуваният katalog.json остава непроменен');
  } finally {
    // Обратно — за следващите тестове (и когато горните твърдения паднат).
    const b2 = new Database(h.dbPath);
    b2.pragma('busy_timeout = 5000');
    b2.prepare("UPDATE books SET status = 'наличен' WHERE inv_number BETWEEN 3 AND 10").run();
    b2.close();
  }
  await autoPushTick();
  assert.equal(ok(await h.api.catalog.autoPushStatus()).error, null, 'след поправката на базата публикуването трябва да тръгне пак');
  assert.equal(pushed().items.length, 10);
});

/* ---------- М7: сигнатурата в UNIMARC и CSV — по едното правило ---------- */
test('М7: UNIMARC 995$k и CSV „Сигнатура“ = УДК + авторски знак, когато „Сигнатура“ е празна; попълнената печели', async () => {
  const cat = q("SELECT id FROM categories WHERE name='книга'").id;
  ok(await h.api.books.create({ inv_number: 101, title: 'Под игото (ново издание)', author: 'Вазов, Иван', category_id: cat,
    udk: '821.163.2-31', author_mark: 'В 14', register_date: T, price: 5 }), 'книга 101');
  ok(await h.api.books.create({ inv_number: 102, title: 'Малкият принц', author: 'Сент-Екзюпери, Антоан дьо', category_id: cat,
    udk: '821.133.1-93', author_mark: 'С 34', call_number: 'Д 821.133.1/С 34', register_date: T, price: 5 }), 'книга 102');
  ok(await h.api.catalog.writeNow(), 'writeNow');
  assert.equal(item(101).g, '821.163.2-31 В 14', 'предпоставка: онлайн каталогът показва сигнатурата по общото правило');

  const dir = mkTmpDir('inv-k45-iznos-');
  h.dialogs.savePath = path.join(dir, 'fond-unimarc.xml');
  ok(await h.api.catalog.exportMarc(), 'UNIMARC');
  h.dialogs.savePath = path.join(dir, 'fond.csv');
  ok(await h.api.catalog.exportCsv(), 'CSV');
  h.dialogs.savePath = null;

  const marc = fs.readFileSync(path.join(dir, 'fond-unimarc.xml'), 'utf8');
  const rec = (inv) => marc.split('<record>').find(r => r.includes('<controlfield tag="001">' + inv + '</controlfield>')) || '';
  const k995 = (inv) => ((rec(inv).match(/<datafield tag="995"[\s\S]*?<\/datafield>/) || [''])[0]
    .match(/<subfield code="k">([^<]*)<\/subfield>/) || [null, null])[1];
  assert.equal(k995(101), '821.163.2-31 В 14', 'UNIMARC 995$k е празно, а етикетът и katalog.json показват „821.163.2-31 В 14“');
  assert.equal(k995(102), 'Д 821.133.1/С 34', 'попълнената „Сигнатура“ печели');

  const lines = fs.readFileSync(path.join(dir, 'fond.csv'), 'utf8').replace(/^﻿/, '').split('\r\n');
  const head = lines[0].split(';').map(x => x.replace(/^"|"$/g, ''));
  const col = head.indexOf('Сигнатура');
  assert.ok(col > -1, 'колоната „Сигнатура“ изчезна от CSV');
  const cell = (inv) => (lines.find(l => l.startsWith('"' + inv + '";')) || '').split(';')[col].replace(/^"|"$/g, '');
  assert.equal(cell(101), '821.163.2-31 В 14', 'CSV „Сигнатура“ е празна за книга, описана с УДК + авторски знак');
  assert.equal(cell(102), 'Д 821.133.1/С 34');
});

/* ---------- М10: изтриване на МЗС заявка при партньора ---------- */
test('М10: изтриването на заявка „изпратено“ назовава документа и последицата; отказът пази заявката', async () => {
  const id = ok(await h.api.mzs.create({ date: T, direction: 'входящо', partner: 'НЧ „Съседно“', title: 'Железният светилник',
    book_code: '5' }), 'МЗС');
  ok(await h.api.mzs.update({ id, status: 'изпратено' }), 'изпратено');
  await h.go('mzs');
  await h.window.openMzs(id);
  await h.settle();
  const n0 = h.hooks.confirms.length;
  h.hooks.confirmAnswer = false;
  await h.clickButton('Изтрий', '#modal');
  await h.settle();
  const asked = h.hooks.confirms.slice(n0);
  assert.equal(asked.length, 1, 'изтриването не попита');
  const text = asked[0];
  assert.notEqual(text.trim(), 'Изтриване на заявката?', 'въпросът е голият „Изтриване на заявката?“');
  assert.match(text, /заявка № 1\/\d{4}/);
  assert.match(text, /инв\. № 5/, 'въпросът не назовава нашия документ');
  assert.match(text, /„Железният светилник“/);
  assert.match(text, /НЧ „Съседно“/, 'въпросът не казва при кого е книгата');
  assert.match(text, /книгата ще стане налична в каталога и на гишето, макар да е при партньора/);
  assert.match(text, /„върнато“/, 'въпросът не предлага правилния път');
  assert.ok(q('SELECT id FROM mzs_requests WHERE id = ?', id), '„Отказ“ изтри заявката');

  // Потвърдено изтриване: следата казва последицата.
  h.hooks.confirmAnswer = true;
  await h.clickButton('Изтрий', '#modal');
  await h.settle();
  h.hooks.confirmAnswer = true;
  assert.equal(q('SELECT id FROM mzs_requests WHERE id = ?', id), undefined, 'потвърденото изтриване не мина');
  const a = q("SELECT detail FROM audit_log WHERE action = 'Изтрита МЗС заявка' ORDER BY id DESC LIMIT 1");
  assert.match(a.detail, /нашият документ инв\. № 5 отново е наличен за гишето и в онлайн каталога/);
});

test('М10: изходяща заявка „получено“ у наш читател — въпросът казва, че срокът вече няма да се следи', async () => {
  const id = ok(await h.api.mzs.create({ date: E.addDays(T, -10), direction: 'изходящо', partner: 'РБ Русе', title: 'Чужда книга',
    reader_card: '9001' }), 'МЗС');
  ok(await h.api.mzs.update({ id, status: 'изпратено' }), 'изпратено');
  ok(await h.api.mzs.update({ id, status: 'получено', due_date: E.addDays(T, 20) }), 'получено');
  await h.go('mzs');
  await h.window.openMzs(id);
  await h.settle();
  const n0 = h.hooks.confirms.length;
  h.hooks.confirmAnswer = false;
  await h.clickButton('Изтрий', '#modal');
  await h.settle();
  h.hooks.confirmAnswer = true;
  const text = h.hooks.confirms.slice(n0)[0] || '';
  assert.match(text, /„Чужда книга“ от РБ Русе/);
  assert.match(text, /у читателя Читател Проба \(карта 9001\)/);
  assert.match(text, /срокът ѝ вече няма да се следи/);
  assert.ok(q('SELECT id FROM mzs_requests WHERE id = ?', id), '„Отказ“ изтри заявката');
});

/* ---------- М3: пълен износ при заключена защита ---------- */
function unzip(file) {
  const b = fs.readFileSync(file);
  let e = b.length - 22; while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  const n = b.readUInt16LE(e + 10); let off = b.readUInt32LE(e + 16);
  const out = {};
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(off + 10), csize = b.readUInt32LE(off + 20);
    const nlen = b.readUInt16LE(off + 28), xlen = b.readUInt16LE(off + 30), clen = b.readUInt16LE(off + 32);
    const lho = b.readUInt32LE(off + 42);
    const name = b.slice(off + 46, off + 46 + nlen).toString('utf8');
    const lnl = b.readUInt16LE(lho + 26), lxl = b.readUInt16LE(lho + 28);
    const data = b.slice(lho + 30 + lnl + lxl, lho + 30 + lnl + lxl + csize);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    off += 46 + nlen + xlen + clen;
  }
  return out;
}
test('М3: пълен износ при заключена защита — търсенията в „Читатели“ са скрити, в „Книги“ остават, PROCHETI-ME го казва', async () => {
  ok(await h.api.readers.create({ name: 'Лъчезар Уникалнов', card_no: '7002', phone: '0877654321', gdpr_consent: 1 }), 'читател');
  // Търсенията — от екрана, както ги пише библиотекарката.
  await h.go('readers');
  h.type('#rSearch', '0877654321'); await h.settle(150);
  h.type('#rSearch', 'Уникалнов'); await h.settle(150);
  await h.go('books');
  h.type('#bSearch', 'Под игото'); await h.settle(150);
  const hist = h.db.prepare('SELECT kind, query FROM search_history ORDER BY id').all();
  assert.ok(hist.some(r => r.kind === 'readers' && r.query === '0877654321'), 'предпоставка: търсенето по телефон е записано');
  assert.ok(hist.some(r => r.kind === 'books' && r.query === 'Под игото'), 'предпоставка: търсенето в „Книги“ е записано');

  // Отключена/незадавана защита: телефонът излиза — и PROCHETI-ME казва, че файлът носи лични данни.
  const dir = mkTmpDir('inv-k45-all-');
  h.dialogs.savePath = path.join(dir, 'otvoreno.zip');
  ok(await h.api.exportAll.run(), 'износ без защита');
  let files = unzip(path.join(dir, 'otvoreno.zip'));
  assert.ok(files['istoria-tarsenia.csv'].includes('0877654321'), 'без защита износът е пълно копие');
  assert.match(files['PROCHETI-ME.txt'], /istoria-tarsenia\.csv\s+съдържат лични данни/,
    'PROCHETI-ME не казва, че историята на търсенията носи лични данни');

  // Зададена и заключена защита.
  ok(await h.api.pdp.setup('Парола-Изпит-2026!'), 'pdp setup');
  ok(await h.api.pdp.lock(), 'pdp lock');
  h.dialogs.savePath = path.join(dir, 'zaklyucheno.zip');
  const res = ok(await h.api.exportAll.run(), 'износ при заключена защита');
  h.dialogs.savePath = null;
  assert.equal(res.pdpLocked, true);
  files = unzip(path.join(dir, 'zaklyucheno.zip'));
  const csv = files['istoria-tarsenia.csv'];
  assert.ok(csv, 'istoria-tarsenia.csv липсва от архива');
  assert.ok(!csv.includes('0877654321'), 'телефонът на читателя излиза в istoria-tarsenia.csv при заключена защита');
  assert.ok(!csv.includes('Уникалнов'), 'фамилията на читателя излиза в istoria-tarsenia.csv при заключена защита');
  assert.match(csv, /"readers";"\(скрито\)"/, 'на мястото на търсенето в „Читатели“ стои „(скрито)“');
  assert.ok(csv.includes('Под игото'), 'търсенията в „Книги“ не са лични данни и трябва да останат');
  assert.ok(!files['chitateli.csv'].includes('0877654321'), 'телефонът в chitateli.csv');
  const readme = files['PROCHETI-ME.txt'];
  assert.match(readme, /istoria-tarsenia\.csv — търсенията в „Читатели“/, 'PROCHETI-ME не казва, че търсенията в „Читатели“ са скрити');
  assert.match(readme, /istoria-tarsenia\.csv → query — само търсенията в „Читатели“/, 'списъкът „Скрити колони“ не го изброява');
});

