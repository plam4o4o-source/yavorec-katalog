'use strict';
/* v2.4.38 — Авторски знак по фамилията (Й се търси от буква И).
   =====================================================================
   Таблицата с числата е чуждо издание и НЕ идва с програмата — внася се от
   файл на самата библиотека. Затова тук се проверява МЕХАНИЗМЪТ, а числата в
   тестовете са измислени: разчитане на файл в непознат формат, правилото за
   търсене („най-голямото буквосъчетание, което не надминава фамилията“), по
   какво се подписва документът, изведеният разделител, груповото попълване
   (само празни знаци) и проверката на заварените знаци.
   Всеки тест е проверен с мутация (виж описанието на кръга в CHANGELOG). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, cleanupTmpDirs, freshDb, fakeIpcMain, runDep, buildDom, settle } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

const MOD = path.join(APP_DIR, 'handlers', 'author-mark');
const { basisOf, keyOf, parseTable, lookup, formatMark, detectSeparator, decodeCp1251,
        isNamed, prefixLabel, refinements, extractPairs, foldJot } = require(MOD).pure;

/* Измислена таблица със свойствата на истинската: вътре в буквата числата
   растат заедно с буквосъчетанието. */
const SYL = ['А', 'Е', 'И', 'О', 'Р', 'У'];
function makeTable() {
  const rows = [];
  for (const L of 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩ') {
    let n = 11;
    for (const a of SYL) {
      rows.push({ prefix: L + a, mark: String(n) });
      n += 7;
      for (const b of SYL) { rows.push({ prefix: L + a + b, mark: String(n) }); n += 1; }
    }
  }
  return rows;
}
const TBL = makeTable();
const asCsv = (rows) => rows.map(r => r.prefix + ',' + r.mark).join('\n');
/* „Записана страница“: същите редове, разпилени в разметка, плюс шум, който
   изглежда като двойки (стилове, години, идентификатори). */
function asHtml(rows) {
  const cells = rows.map(r => `<td class="c7">${r.prefix}</td><td>${r.mark}</td>`).join('\n');
  return `<html><head><style>.c7{width:40px;margin:12px}</style></head><body>
    <h1>Авторски таблици</h1><p>София 1976 г., второ издание, стр. 24</p>
    <table>${cells}</table>
    <script>var cfg={ver:3,id:"кв17",w:1280};</script>
    <p>обратна връзка: mail@example.com</p></body></html>`;
}

/* ---------- разчитане ---------- */
test('разчита CSV и записана страница, изхвърля шума и не се лъже от подредбата на колоните', () => {
  const csv = parseTable(asCsv(TBL));
  assert.equal(csv.rows.length, TBL.length, 'CSV: очаквах всички редове, намерени ' + csv.rows.length);
  assert.deepEqual(csv.rows[0], TBL[0]);
  assert.equal(csv.how, 'буквосъчетание, после число',
    'при равен брой редове печели ПЪРВОТО разчитане — обичайната подредба, върху текста без етикети');

  const html = parseTable(asHtml(TBL));
  assert.equal(html.rows.length, TBL.length, 'страница: намерени ' + html.rows.length);
  const map = new Map(html.rows.map(r => [r.prefix, r.mark]));
  for (const r of TBL) assert.equal(map.get(r.prefix), r.mark, 'ред ' + r.prefix);
  assert.equal(map.has('КВ'), false, 'идентификаторът „кв17“ от скрипта не бива да влиза в таблицата');

  // Обърнати колони („15 ВАЗ“) — разчитат се също.
  const flipped = parseTable(TBL.map(r => r.mark + '\t' + r.prefix).join('\n'));
  assert.equal(flipped.rows.length, TBL.length);
  assert.match(flipped.how, /число, после/);
  const fmap = new Map(flipped.rows.map(r => [r.prefix, r.mark]));
  for (const r of TBL) assert.equal(fmap.get(r.prefix), r.mark, 'разместен ред ' + r.prefix);

  /* Предпазителят срещу тихо разместване: същият файл, прочетен НАОПАКИ, не бива
     да събира числото на един ред с буквосъчетанието от следващия. Проверява се
     направо върху extractPairs, защото при parseTable обичайната подредба и без
     това печели — и грешката би останала скрита, докато не даде повече редове. */
  assert.deepEqual(extractPairs('ВАЗ 14\nВАН 15', true), [],
    'при „число, после буквосъчетание“ буквите от следващия ред не са двойка на това число');
  assert.deepEqual(extractPairs('14\tВАЗ\n15\tВАН', true), [['ВАЗ', '14'], ['ВАН', '15']],
    'а истински обърнат файл се чете както си е');
});

test('водещата нула в числото се пази, а редовете, които развалят реда, отпадат', () => {
  const r = parseTable('АА 05\nАБ 06\nАВ 07');
  assert.deepEqual(r.rows.map(x => x.mark), ['05', '06', '07'], '„05“ не бива да става „5“');
  // Ред с по-малко число след по-голямо е шум (или сгрешено разчетено) — маха се.
  const noisy = parseTable('БА 20\nБАБ 21\nБВ 3\nБГ 30');
  assert.deepEqual(noisy.rows.map(x => x.prefix), ['БА', 'БАБ', 'БГ']);
  assert.equal(noisy.dropped, 1);

  /* Едно и също буквосъчетание може да се появи повторно като колонтитул в
     началото на следващата страница, до НОМЕРА НА СТРАНИЦАТА. Истинският ред е
     първият; ако спечели вторият, той разваля растежа и редът отпада изцяло. */
  const header = parseTable('ВА 11\nВАЗ 14\nВАН 17\nВЕ 30\nВАЗ 3\nВИ 33');
  assert.equal(lookup(header.rows, 'ВАЗОВ').mark, '14', 'първото срещане на реда печели');
  assert.equal(header.dropped, 0, 'повторението не бива да маха истинския ред');
});

test('файл, записан в Windows-1251, се разчита вместо да излезе празен', () => {
  const cyr = 'ВАЗ 15\nВАН 16\n';
  const win = Buffer.from([...cyr].map(ch => {
    const i = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'.indexOf(ch);
    return i >= 0 ? 0xC0 + i : ch.charCodeAt(0);
  }));
  assert.match(decodeCp1251(win), /ВАЗ 15/);
  const r = parseTable(decodeCp1251(win));
  assert.deepEqual(r.rows, [{ prefix: 'ВАЗ', mark: '15' }, { prefix: 'ВАН', mark: '16' }]);
});

/* ---------- правилото за търсене ---------- */
test('взима най-голямото буквосъчетание, което не надминава фамилията', () => {
  const rows = [
    { prefix: 'ВА', mark: '11' }, { prefix: 'ВАЗ', mark: '15' },
    { prefix: 'ВАН', mark: '17' }, { prefix: 'ВЕ', mark: '30' }, { prefix: 'ГА', mark: '11' }
  ];
  assert.equal(lookup(rows, 'ВАЗОВ').prefix, 'ВАЗ', 'ВАЗОВ трябва да падне на „ВАЗ“, не на „ВА“');
  assert.equal(lookup(rows, 'ВАЗ').prefix, 'ВАЗ', 'точно съвпадение');
  assert.equal(lookup(rows, 'ВАКАРЕЛСКИ').prefix, 'ВАЗ', 'няма „ВАК“ — взима се най-близкото ПРЕДИ него');
  assert.equal(lookup(rows, 'ВЪЛЧЕВ').prefix, 'ВЕ', 'след последното за буквата — пак последното');
  assert.equal(lookup(rows, 'В').prefix, 'ВА', 'по-къса от всички — първото за буквата');
  assert.equal(lookup(rows, 'ДИМОВ'), null, 'буква без нито един ред няма какво да даде');
  assert.equal(lookup(rows, ''), null);
  // Не прескача в чужда буква: „ГА 11“ не бива да излезе при фамилия на „В“.
  assert.equal(lookup(rows, 'ВЯ').prefix.charAt(0), 'В');
});

/* ---------- Й се търси от буква И ---------- */
/* В авторските таблици Й изобщо не се изписва: „Йовков“ стои като „Иовк“,
   „Найденов“ — като „Наи“, „Койчев“ — като „Коич“. Числото идва от буква И,
   но знакът пази буквата на фамилията: „Й 77“, за да стои книгата при другите
   Й-автори на рафта. Ь няма — нито в таблиците, нито като начална буква. */
const JOT_ROWS = parseTable([
  'Бои 59', 'Боич 60',
  'Ио 74', 'Иоан 75', 'Иов 76', 'Иовк 77', 'Иовч 79', 'Ионк 80', 'Иорд 83', 'Иот 85',
  'Ива 16', 'Иван 18', 'Иванов 21',
  'Наи 17', 'Нак 18',
  'Раи 27', 'Раин 28', 'Раич 29'
].join('\n')).rows;

test('Й се търси от буква И, но знакът пази буквата на фамилията', () => {
  assert.equal(foldJot('ЙОВКОВ'), 'ИОВКОВ');
  assert.equal(foldJot('РАЙКОВ'), 'РАИКОВ', 'и вътре в думата, не само в началото');

  const hit = lookup(JOT_ROWS, 'ЙОВКОВ');
  assert.equal(hit.prefix, 'ИОВК', 'намерен е ' + (hit && hit.prefix));
  assert.equal(hit.mark, '77');
  assert.equal(formatMark('ЙОВКОВ'.charAt(0), hit.mark, ' '), 'Й 77',
    'числото идва от И, но буквата остава Й — книгата стои при Й-авторите');
  assert.equal(lookup(JOT_ROWS, 'ЙОРДАНОВ').mark, '83');
  assert.equal(lookup(JOT_ROWS, 'ЙОНКОВ').mark, '80');

  /* Вътрешното Й е същият случай и е по-коварен: без замяната „Райков“ пада на
     „Раич“, защото Й се нарежда СЛЕД И — тоест мълчаливо ГРЕШЕН знак, а не
     липсващ. Затова се проверява точно този ред. */
  assert.equal(lookup(JOT_ROWS, 'РАЙКОВ').prefix, 'РАИ', 'Райков е „Раи“, не „Раич“');
  assert.equal(lookup(JOT_ROWS, 'РАЙЧЕВ').prefix, 'РАИЧ');
  assert.equal(lookup(JOT_ROWS, 'НАЙДЕНОВ').prefix, 'НАИ');
  assert.equal(lookup(JOT_ROWS, 'БОЙЧЕВ').prefix, 'БОИЧ');
  // Фамилия на И не се променя от нищо от горното.
  assert.equal(lookup(JOT_ROWS, 'ИВАНОВ').prefix, 'ИВАНОВ');
});

test('ако някое издание все пак има раздел Й, той се ползва, вместо да се замества', () => {
  const own = parseTable(['Ио 74', 'Иов 76', 'Йо 90', 'Йов 91', 'Йовк 92'].join('\n')).rows;
  const hit = lookup(own, 'ЙОВКОВ');
  assert.equal(hit.prefix, 'ЙОВК', 'собственият раздел Й има предимство: ' + hit.prefix);
  assert.equal(hit.mark, '92');
});

/* ---------- по какво се подписва ---------- */
test('фамилията се взима от първия автор, а без автор — от заглавието', () => {
  assert.deepEqual(basisOf({ author: 'Вазов, Иван' }), { basis: 'Вазов', from: 'author', exact: true });
  assert.equal(basisOf({ author: 'Габе, Дора Петрова; Шишкова, Магдалена' }).basis, 'Габе', 'втори автор не се ползва');
  const noComma = basisOf({ author: 'Петър Здравков' });
  assert.equal(noComma.basis, 'Здравков', 'без запетая се взима последната дума');
  assert.equal(noComma.exact, false, 'и това се отбелязва — може да е псевдоним, не фамилия');
  assert.equal(basisOf({ author: 'Ботев' }).basis, 'Ботев');
  const byTitle = basisOf({ author: '', title: '„Български народни приказки' });
  assert.deepEqual([byTitle.basis, byTitle.from], ['Български', 'title'], 'сборник без автор — по заглавието');
  assert.equal(basisOf({ author: '', title: '' }), null);
  assert.equal(keyOf('Вазов, Иван'), 'ВАЗОВИВАН');
});

/* ---------- форматът се извежда, не се налага ---------- */
test('разделителят се извежда от вече въведените знаци', () => {
  assert.equal(detectSeparator(['В-15', 'Г-13', 'С-42']), '-');
  assert.equal(detectSeparator(['В 15', 'Г 13', 'С 42']), ' ');
  assert.equal(detectSeparator(['В15', 'Г13']), '');
  assert.equal(detectSeparator(['', 'няма число']), null, 'без данни не се гадае');
  assert.equal(formatMark('В', '15', '-'), 'В-15');
  assert.equal(formatMark('В', '15', ' '), 'В 15');
  assert.equal(formatMark('В', '15', ''), 'В15');
});

/* ---------- целият модул върху истинска база ---------- */
function setup(prefix) {
  const { db, dir } = freshDb(prefix);
  const audit = [];
  const ipcMain = fakeIpcMain();
  const chosen = { path: null };
  require(MOD)(ipcMain, {
    getDb: () => db, run: runDep, logAudit: (a, d) => audit.push(a + ': ' + d),
    dialog: { showOpenDialog: async () => (chosen.path ? { canceled: false, filePaths: [chosen.path] } : { canceled: true, filePaths: [] }) },
    getMainWindow: () => ({}), fs, path, importers: require(path.join(APP_DIR, 'importers.js'))
  });
  const ok = async (ch, ...a) => { const r = await ipcMain.invoke(ch, ...a); assert.equal(r.ok, true, ch + ': ' + r.error); return r.data; };
  const err = async (ch, ...a) => { const r = await ipcMain.invoke(ch, ...a); assert.equal(r.ok, false, ch + ' трябваше да откаже'); return r.error; };
  const addBook = (o) => db.prepare(`INSERT INTO books (inv_number, title, author, author_mark, call_number, register_date, price)
    VALUES (@inv, @title, @author, @mark, @cn, '2026-01-01', 1)`).run({
      inv: o.inv, title: o.title || 'Заглавие', author: o.author ?? null, mark: o.mark ?? null, cn: o.cn ?? null });
  const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text, 'utf8'); chosen.path = p; return p; };
  return { db, dir, ipcMain, ok, err, audit, addBook, write, chosen };
}

test('внасяне: преглед преди запис, отказ при негоден файл, и чак тогава предложения', async () => {
  const s = setup('am-import');
  assert.deepEqual(await s.ok('authorMark:status'), { rows: 0, letters: 0, separator: '-', example: null, sample: [] });
  assert.match(await s.err('authorMark:suggest', { author: 'Вазов, Иван' }), /Няма внесена таблица/);
  assert.match(await s.err('authorMark:confirm'), /Няма разчетена таблица/, 'запис без преглед не бива да минава');

  // Негоден файл — казва какво е намерил, вместо да запише боклук.
  s.write('грешен.txt', 'Това е обикновен текст за 2026 година без таблица.');
  assert.match(await s.err('authorMark:choose'), /разчетоха само \d+ реда/);
  assert.equal((await s.ok('authorMark:status')).rows, 0, 'негодният файл не бива да е стигнал до базата');

  // Годен файл: преглед → потвърждение.
  s.write('tablica.html', asHtml(TBL));
  const pv = await s.ok('authorMark:choose');
  assert.equal(pv.rows, TBL.length);
  assert.ok(pv.letters >= 20 && pv.sample.length > 0, 'прегледът показва букви и мостра');
  assert.equal((await s.ok('authorMark:status')).rows, 0, 'прегледът сам по себе си НЕ записва');
  assert.deepEqual(await s.ok('authorMark:confirm'), { rows: TBL.length });
  assert.equal((await s.ok('authorMark:status')).rows, TBL.length);
  assert.ok(s.audit.some(a => /внесена — \d+ реда/.test(a)), 'внасянето трябва да остави следа');

  const sug = await s.ok('authorMark:suggest', { author: 'Вазов, Иван' });
  assert.equal(sug.ok, true);
  assert.equal(sug.basis, 'Вазов');
  assert.equal(sug.mark.charAt(0), 'В');
  assert.match(sug.mark, /^В-\d+$/, 'без данни в базата разделителят е „-“ (както е и подсказката във формата)');
  assert.equal(sug.prefix.charAt(0), 'В', 'предложението казва по кой ред е сметнато');

  // Изтриване на таблицата.
  assert.equal(await s.ok('authorMark:clear'), TBL.length);
  assert.equal((await s.ok('authorMark:status')).rows, 0);
});

test('разделителят следва заварените знаци на библиотеката, а не подразбирането', async () => {
  const s = setup('am-sep');
  s.write('t.csv', asCsv(TBL)); await s.ok('authorMark:choose'); await s.ok('authorMark:confirm');
  s.addBook({ inv: 1, author: 'Ботев, Христо', mark: 'Б 21' });
  s.addBook({ inv: 2, author: 'Яворов, Пейо', mark: 'Я 30' });
  assert.equal((await s.ok('authorMark:status')).separator, ' ');
  assert.match((await s.ok('authorMark:suggest', { author: 'Вазов, Иван' })).mark, /^В \d+$/);

  // Само сигнатура, без авторски знак — разделителят се чете и оттам.
  const s2 = setup('am-sep2');
  s2.write('t.csv', asCsv(TBL)); await s2.ok('authorMark:choose'); await s2.ok('authorMark:confirm');
  /* Нарочно с ИНТЕРВАЛ, а не с тире: подразбирането е тире, и ако сигнатурата
     изобщо не се четеше, тестът пак щеше да мине. */
  s2.addBook({ inv: 1, author: 'Ботев, Христо', cn: '886.7/Б 21' });
  assert.equal((await s2.ok('authorMark:status')).separator, ' ');
  assert.match((await s2.ok('authorMark:suggest', { author: 'Вазов, Иван' })).mark, /^В \d+$/);
});

test('групово попълване пипа само празните знаци и показва какво ще стане, преди да го направи', async () => {
  const s = setup('am-fill');
  s.write('t.csv', asCsv(TBL)); await s.ok('authorMark:choose'); await s.ok('authorMark:confirm');
  s.addBook({ inv: 1, author: 'Вазов, Иван', mark: null });
  s.addBook({ inv: 2, author: 'Ботев, Христо', mark: 'Б-99' });      // въведен на ръка — не се пипа
  s.addBook({ inv: 3, author: '', title: 'Приказки от цял свят' });   // по заглавието
  s.addBook({ inv: 4, author: 'Smith, John' });                       // не е на кирилица
  s.addBook({ inv: 5, author: 'Ювов, Юрий' });                        // буква без редове в таблицата (Ю)

  const pv = await s.ok('authorMark:fillPreview');
  assert.equal(pv.willTotal, 2, 'ще се попълнят точно два — Вазов и сборникът');
  assert.deepEqual(pv.will.map(w => w.inv_number).sort(), [1, 3]);
  assert.equal(pv.will.find(w => w.inv_number === 3).from, 'title');
  assert.equal(pv.skipTotal, 2, 'латиницата и буквата без редове се пропускат');
  assert.ok(pv.skip.every(x => x.reason), 'за всеки пропуснат се казва защо');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM books WHERE author_mark IS NOT NULL').get().n, 1,
    'прегледът не бива да е записал нищо');

  assert.equal(await s.ok('authorMark:fillApply'), 2);
  const rows = s.db.prepare('SELECT inv_number, author_mark FROM books ORDER BY inv_number').all();
  assert.equal(rows[0].author_mark.charAt(0), 'В');
  assert.equal(rows[1].author_mark, 'Б-99', 'вече въведеният знак остава непокътнат');
  assert.equal(rows[2].author_mark.charAt(0), 'П', 'сборникът се подписва по заглавието');
  assert.equal(rows[3].author_mark, null);
  assert.equal(rows[4].author_mark, null);
  assert.ok(s.audit.some(a => /групово попълнени 2/.test(a)));

  assert.equal(await s.ok('authorMark:fillApply'), 0, 'второ пускане няма какво да попълни');
});

test('проверката посочва знаците, чиято буква не отговаря на фамилията', async () => {
  const s = setup('am-audit');
  s.write('t.csv', asCsv(TBL)); await s.ok('authorMark:choose'); await s.ok('authorMark:confirm');
  s.addBook({ inv: 1, author: 'Габе, Дора', mark: 'Г-13' });                 // вярно
  s.addBook({ inv: 2, author: 'Вазова, Вера', mark: 'Г-13' });               // сгрешено — както в истинската база
  s.addBook({ inv: 3, author: 'Славейков, Пенчо', mark: 'С 42' });           // вярно, друг разделител
  s.addBook({ inv: 4, author: 'Йовков, Йордан', mark: null });               // липсва
  /* Проверка при прегледа: полето е свободен текст, без насилствено главни
     букви при запис — малка буква е също толкова валиден ръчен запис. */
  s.addBook({ inv: 5, author: 'Талев, Димитър', mark: 'г-15' });             // сгрешено, малка буква
  const a = await s.ok('authorMark:audit');
  assert.equal(a.mismatchedTotal, 2);
  assert.deepEqual(a.mismatched.map(x => x.inv_number).sort(), [2, 5]);
  assert.deepEqual([a.mismatched[0].expected, a.mismatched[0].basis], ['В', 'Вазова']);
  const lower = a.mismatched.find(x => x.inv_number === 5);
  assert.deepEqual([lower.expected, lower.basis], ['Т', 'Талев'], 'малката буква на знака се разпознава и сравнява');
  assert.equal(a.missingTotal, 1, 'и колко са изобщо без знак');
  assert.equal(a.total, 5);
});

test('Й-фамилия през целия модул: знак „Й“ с числото от И, и без фалшива тревога в проверката', async () => {
  const s = setup('am-jot');
  /* Таблица с раздел И, който покрива и Й-имената („Иовк“ за Йовков), както е в
     истинските авторски таблици — там раздел Й изобщо няма. */
  const iSection = [['ИВ', '70'], ['ИВАНОВ', '72'], ['ИО', '74'], ['ИОАН', '75'], ['ИОВ', '76'],
    ['ИОВК', '77'], ['ИОНК', '80'], ['ИОРД', '83'], ['ИОТ', '85']].map(([prefix, mark]) => ({ prefix, mark }));
  s.write('t.csv', asCsv(TBL.filter(r => 'ЙИ'.indexOf(r.prefix.charAt(0)) < 0).concat(iSection)));
  await s.ok('authorMark:choose'); await s.ok('authorMark:confirm');

  const sug = await s.ok('authorMark:suggest', { author: 'Йовков, Йордан' });
  assert.equal(sug.ok, true, sug.reason);
  assert.equal(sug.mark, 'Й-77', 'числото идва от реда „Иовк“, а буквата остава Й');
  assert.equal(sug.prefix, 'ИОВК', 'предложението показва истинския ред от таблицата');
  assert.equal(sug.fromLetter, 'И', 'и казва, че редът е под друга буква — иначе изглежда като грешка');

  const plain = await s.ok('authorMark:suggest', { author: 'Вазов, Иван' });
  assert.equal(plain.fromLetter, null, 'при обикновена фамилия няма какво да се обяснява');

  /* Проверката на заварените знаци не бива да вдига тревога за нито един от
     двата редовни навика: една библиотека пише „Й 77“, друга — „И 77“. */
  s.addBook({ inv: 1, author: 'Йовков, Йордан', mark: 'Й 77' });
  s.addBook({ inv: 2, author: 'Йорданов, Петър', mark: 'И 83' });
  s.addBook({ inv: 3, author: 'Йовков, Йордан', mark: 'Г 13' });   // истинска грешка
  const a = await s.ok('authorMark:audit');
  assert.equal(a.mismatchedTotal, 1, 'само сгрешеният ред: ' + JSON.stringify(a.mismatched.map(x => x.inv_number)));
  assert.equal(a.mismatched[0].inv_number, 3);
});

test('при 15 000 документа груповото попълване свършва бързо и не изпуска нищо', async () => {
  const s = setup('am-scale');
  s.write('t.csv', asCsv(TBL)); await s.ok('authorMark:choose'); await s.ok('authorMark:confirm');
  const A = ['Вазов, Иван', 'Йовков, Йордан', 'Ботев, Христо', 'Габе, Дора', 'Талев, Димитър', ''];
  const ins = s.db.prepare(`INSERT INTO books (inv_number, title, author, register_date, price)
    VALUES (?, ?, ?, '2026-01-01', 1)`);
  s.db.transaction(() => {
    for (let i = 1; i <= 15000; i++) ins.run(i, 'Книга № ' + i, A[i % A.length] || null);
  }).immediate();
  const t0 = Date.now();
  const pv = await s.ok('authorMark:fillPreview');
  const tPreview = Date.now() - t0;
  const t1 = Date.now();
  const n = await s.ok('authorMark:fillApply');
  const tApply = Date.now() - t1;
  assert.equal(pv.willTotal, 15000, 'всички имат или автор, или заглавие');
  assert.equal(n, 15000);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM books WHERE author_mark IS NULL OR author_mark = ''").get().n, 0);
  assert.ok(tPreview < 8000 && tApply < 8000, 'преглед ' + tPreview + ' ms, запис ' + tApply + ' ms');
});

/* ---------- формите, с които истинската таблица събори първия разчитач ----------
   Трите неща по-долу не са измислени случаи: точно те се счупиха, когато
   разчитачът беше пуснат върху таблицата на библиотеката. */
const REAL_SHAPED = [
  'Аб 11', 'Ав 12', 'Аг 13',
  'Диме 57', 'Димитров, Г. 58', 'Дими 59', 'Димо 60',
  'Ела 50', 'Еле 52', 'Елин Пелин 53', 'Елио 55',
  'Христов 79', 'Христович 80', 'Христозов 81'
].join('\n');

test('дълъг запис остава в своята буква, вместо да бъде отрязан отпред', () => {
  const rows = parseTable(REAL_SHAPED).rows;
  const hit = lookup(rows, 'ХРИСТОВИЧ');
  assert.equal(hit.prefix, 'ХРИСТОВИЧ', 'намерен е ' + hit.prefix);
  // Първият разчитач взимаше последните 8 букви — „ристович“ — и редът отиваше
  // в буква Р. Проверява се, че в Р няма нищо.
  assert.equal(lookup(rows, 'РИСТОВИЧ'), null, 'нищо от „Христович“ не бива да е попаднало в буква Р');
});

test('ред за конкретен автор се пази, не се налага сам и се показва като по-точен', () => {
  const r = parseTable(REAL_SHAPED);
  const named = r.rows.filter(x => isNamed(x.prefix));
  assert.deepEqual(named.map(x => prefixLabel(x.prefix) + '=' + x.mark), ['ДИМИТРОВ, Г=58', 'ЕЛИН, ПЕЛИН=53'],
    'редовете за конкретен автор не бива да отпадат като „нарушение на реда“');
  assert.equal(r.dropped, 0, 'нищо друго не бива да е отпаднало');

  // „Димитров, Г. 58“ е за Георги Димитров — всеки друг Димитров пада на „Дими“.
  assert.equal(lookup(r.rows, 'ДИМИТРОВ').prefix, 'ДИМИ');
  assert.equal(lookup(r.rows, 'ДИМИТРОВ').mark, '59');
  assert.equal(lookup(r.rows, 'ДИМИТРОВА').prefix, 'ДИМИ',
    'и по-дълга фамилия не бива да пада на реда за Георги Димитров');
  assert.deepEqual(refinements(r.rows, 'ДИМИТРОВ').map(x => prefixLabel(x.prefix)), ['ДИМИТРОВ, Г'],
    'но се показва до предложението, за да реши човекът');
  assert.deepEqual(refinements(r.rows, 'ДИМОВ'), [], 'за друга фамилия няма какво да се показва');
});

test('текстът на самата страница не влиза в таблицата като ред', () => {
  // „Авторски таблици“ със страницата до него изглежда точно като ред за
  // конкретен автор — две думи и число. Числото е това, което го издава.
  const rows = parseTable('Авторски таблици 1\n' + REAL_SHAPED).rows;
  assert.equal(rows.some(r => r.prefix.indexOf('АВТОРСКИ') === 0), false,
    'заглавието на изданието не бива да стане ред: ' + JSON.stringify(rows.filter(r => r.prefix.charAt(0) === 'А')));
  assert.equal(rows.filter(r => r.prefix.charAt(0) === 'А').length, 3, 'а истинските редове на буква А остават');
});

/* ---------- .docx, какъвто идва от библиотеката ---------- */
/* Най-простият валиден ZIP: части без свиване. Word реже един абзац на няколко
   <w:t>, затова тук нарочно е разцепен по средата на дума — ако парчетата се
   слепят с разделител, редът се губи. */
function zipStored(files) {
  const zlib = require('zlib');
  const locals = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const nb = Buffer.from(name, 'utf8'), db = Buffer.from(text, 'utf8');
    const crc = zlib.crc32(db);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, db);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(db.length, 20); ch.writeUInt32LE(db.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + db.length;
  }
  const body = Buffer.concat(locals), dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, eocd]);
}
function asDocx(rows) {
  const paras = rows.map(r => {
    const p = r.prefix, cut = Math.max(1, p.length - 1);   // разцепена дума
    return `<w:p><w:r><w:t>${p.slice(0, cut)}</w:t></w:r><w:r><w:t>${p.slice(cut)}</w:t></w:r>` +
      `<w:r><w:t xml:space="preserve"> ${r.mark}</w:t></w:r></w:p>`;
  }).join('');
  return zipStored({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${paras}</w:body></w:document>`
  });
}

test('внасяне от .docx: разцепените от Word парчета се слепват, а псевдонимът се предлага', async () => {
  const s = setup('am-docx');
  const p = path.join(s.dir, 'авторска таблица.docx');
  fs.writeFileSync(p, asDocx(TBL));
  s.chosen.path = p;
  const pv = await s.ok('authorMark:choose');
  assert.equal(pv.rows, TBL.length, 'разцепените <w:t> трябва да се слепят без разделител');
  await s.ok('authorMark:confirm');
  const sug = await s.ok('authorMark:suggest', { author: 'Габе, Дора' });
  assert.equal(sug.ok, true);
  assert.equal(sug.mark.charAt(0), 'Г');
});

test('име без запетая: фамилията е догадка, затова се показва и редът за псевдонима', async () => {
  const s = setup('am-pseudo');
  s.write('t.txt', asCsv(TBL) + '\nЕлин Пелин 53');   // цяла таблица + ред за псевдонима
  await s.ok('authorMark:choose'); await s.ok('authorMark:confirm');
  const sug = await s.ok('authorMark:suggest', { author: 'Елин Пелин' });
  assert.equal(sug.exact, false, '„Елин Пелин“ е без запетая — фамилията не се знае със сигурност');
  assert.equal(sug.basis, 'Пелин', 'по подразбиране се взима последната дума');
  assert.deepEqual(sug.refine.map(r => r.prefix + ' → ' + r.mark), ['ЕЛИН, ПЕЛИН → Е-53'],
    'редът за самия псевдоним трябва да се предложи');
});

/* ---------------- екраните ---------------- */
const SET_DEPS = {
  'settings.get': {}, 'limits.usage': null, 'av.options': {}, 'employees.list': [],
  'circRules.list': [], 'calendar.list': [], 'backup.status': null, 'gdpr.status': null,
  'pdp.status': {}, 'securityExclusions.status': null, 'autoUpdate.status': null
};
const FORM_DEPS = { 'categories.list': [], 'authorities.values': [], 'books.suggestions': {}, 'shelves.list': [] };

test('копчето „Предложи“ казва ЗАЩО е този знак и не сменя вече попълнен без питане', async () => {
  const dom = buildDom({ ...FORM_DEPS,
    'books.get': { id: 1, inv_number: 1, title: 'Под игото', author: 'Вазов, Иван', author_mark: '', status: 'наличен' },
    'authorMark.suggest': { ok: true, mark: 'В-14', basis: 'Вазов', from: 'author', exact: true,
      prefix: 'ВАЗ', num: '14', refine: [{ prefix: 'ВАЗОВ, И', mark: 'В-15' }] } });
  const { window } = dom, d = window.document;
  await settle();
  await window.bookForm(1);
  await settle();
  const inp = d.querySelector('#bookF [name=author_mark]');
  assert.ok(inp, 'полето „Авторски знак“ трябва да е във формата');
  assert.ok(d.querySelector('#amBtn'), 'до него трябва да има копче „Предложи“');

  await window.authorMarkSuggest();
  await settle();
  assert.equal(inp.value, 'В-14');
  const hint = d.getElementById('amHint').textContent.replace(/\s+/g, ' ');
  assert.match(hint, /фамилия „Вазов“/, 'не се вижда по коя фамилия: ' + hint);
  assert.match(hint, /ред „ВАЗ“/, 'не се вижда по кой ред от таблицата: ' + hint);
  assert.match(hint, /ВАЗОВ, И → В-15/, 'по-точният ред трябва да се предлага: ' + hint);

  // Заварен различен знак не се сменя без изричното „да“ (confirm-ът е подменен с „не“).
  inp.value = 'В-99';
  window.confirm = () => false;
  await window.authorMarkSuggest();
  await settle();
  assert.equal(inp.value, 'В-99', 'при отказ знакът трябва да остане какъвто е бил');
  window.confirm = () => true;
  await window.authorMarkSuggest();
  await settle();
  assert.equal(inp.value, 'В-14', 'при съгласие се сменя');
});

test('копчето „Предложи“ при Й обяснява, че редът е под буква И', async () => {
  const dom = buildDom({ ...FORM_DEPS,
    'books.get': { id: 1, inv_number: 1, title: 'Старопланински легенди', author: 'Йовков, Йордан',
      author_mark: '', status: 'наличен' },
    'authorMark.suggest': { ok: true, mark: 'Й-77', basis: 'Йовков', from: 'author', exact: true,
      prefix: 'ИОВК', num: '77', fromLetter: 'И', refine: [] } });
  const { window } = dom, d = window.document;
  await settle();
  await window.bookForm(1);
  await settle();
  await window.authorMarkSuggest();
  await settle();
  assert.equal(d.querySelector('#bookF [name=author_mark]').value, 'Й-77');
  const hint = d.getElementById('amHint').textContent.replace(/\s+/g, ' ');
  assert.match(hint, /ред „ИОВК“/, 'показва истинския ред: ' + hint);
  assert.match(hint, /Й се търси от буква И/, 'иначе редът „ИОВК“ изглежда сгрешен: ' + hint);
});

test('когато няма внесена таблица, копчето обяснява, вместо да мълчи или да пише нещо в полето', async () => {
  const dom = buildDom({ ...FORM_DEPS,
    'books.get': { id: 1, inv_number: 1, title: 'Т', author: 'Вазов, Иван', author_mark: '', status: 'наличен' },
    'authorMark.suggest': () => { throw new Error('Няма внесена таблица за авторски знак. Настройки → Фонд → „Авторски знак“.'); } });
  const { window } = dom, d = window.document;
  await settle();
  await window.bookForm(1);
  await settle();
  await window.authorMarkSuggest();
  await settle();
  assert.equal(d.querySelector('#bookF [name=author_mark]').value, '', 'полето трябва да остане празно');
  assert.match(d.getElementById('amHint').textContent, /Няма внесена таблица/);
});

test('Настройки → Фонд: внасянето минава през преглед и нищо не се записва при отказ', async () => {
  const dom = buildDom({ ...SET_DEPS,
    'authorMark.status': { rows: 0, letters: 0, separator: '-', example: null, sample: [] },
    'authorMark.choose': { file: 'таблица.docx', rows: 2398, letters: 28, dropped: 0,
      how: 'буквосъчетание, после число', sample: [{ prefix: 'ВАЗ', mark: '14' }] } });
  const { window } = dom, d = window.document;
  await settle();
  window.location.hash = '#settings';
  await window.route();
  await settle();
  const box = d.getElementById('amBox');
  assert.ok(box, 'в „Фонд“ трябва да има раздел за авторския знак');
  assert.match(box.textContent, /Няма внесена таблица/);

  window.confirm = () => false;                       // библиотекарката не разпознава мострата
  await window.authorMarkChoose();
  await settle();
  assert.equal(dom.calls['authorMark.confirm'], undefined, 'при отказ таблицата НЕ бива да се записва');

  window.confirm = () => true;
  await window.authorMarkChoose();
  await settle();
  assert.equal((dom.calls['authorMark.confirm'] || []).length, 1, 'чак след „да“ се записва');
});

test('груповото попълване показва какво ще стане и се отказва без нищо да пипне', async () => {
  const dom = buildDom({ ...SET_DEPS,
    'authorMark.status': { rows: 2398, letters: 28, separator: '-', example: null, sample: [] },
    'authorMark.fillPreview': { willTotal: 120, skipTotal: 3,
      will: [{ id: 1, inv_number: 7, author: 'Габе, Дора', title: 'Малката', mark: 'Г-13' }], skip: [] } });
  const { window } = dom, d = window.document;
  await settle();
  window.location.hash = '#settings';
  await window.route();
  await settle();
  assert.match(d.getElementById('amBox').textContent, /2398/, 'състоянието трябва да показва внесената таблица');

  window.confirm = () => false;
  await window.authorMarkFill();
  await settle();
  assert.equal(dom.calls['authorMark.fillApply'], undefined, 'при отказ не се пише нищо');
  window.confirm = () => true;
  await window.authorMarkFill();
  await settle();
  assert.equal((dom.calls['authorMark.fillApply'] || []).length, 1);
});

test('„Проверка на данните“ посочва знаците с чужда буква', async () => {
  const dom = buildDom({ ...SET_DEPS,
    'books.multiCopyRecords': [], 'books.findDuplicateBarcodes': [], 'books.deaccessionedWithoutAct': [],
    'authorMark.status': { rows: 0, letters: 0, separator: '-', example: null, sample: [] },
    'authorMark.audit': { total: 4, mismatchedTotal: 1, missingTotal: 2,
      mismatched: [{ id: 9, inv_number: 42, author: 'Вазова, Вера', title: 'Спомени',
        author_mark: '886.7/Г 13', expected: 'В', basis: 'Вазова' }] } });
  const { window } = dom, d = window.document;
  await settle();
  window.location.hash = '#settings';
  await window.route();
  await settle();
  await window.runDataChecks();
  await settle();
  const t = d.getElementById('dataChecks').textContent.replace(/\s+/g, ' ');
  assert.match(t, /чиято буква не отговаря на фамилията/);
  assert.match(t, /Вазова/);
  assert.match(t, /Вазова → „В“/, 'редът трябва да казва коя буква се очаква: ' + t.slice(-300));
});
