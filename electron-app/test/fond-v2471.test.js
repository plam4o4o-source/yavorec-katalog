'use strict';
/* v2.4.71 — кръг 45, област ФОНД, ПРИДОБИВАНЕ, ОПИСАНИЕ (група „Ф“ на тестера)
   плюс Т2 (udk-tablica, в собствения си файл) и частите на М2 и М9 в
   handlers/books.js.
   =====================================================================
   По един (или повече) тест на всяка поправена находка. Всеки твърди онова,
   което библиотекарката вижда — полето „Автор“ след ISBN, текста на отчета на
   вноса, реда в базата, изречението в „Проверка на данните“, реда на
   разпечатката — и е проверен с връщане на поправката назад: без нея пада.

   Ф1  ISBN с двама автори → „Иван Вазов, Алеко Константинов“ и знак И-18.
   Ф2  Предложение с автор само по фамилия / двойна фамилия не се разпознава.
   Ф3  Ред от файла с бъдеща дата на вписване влиза без дума.
   Ф4  „Проверка на данните“ сравнява само броя, не стойността.
   Ф5  Номенклатурите (отдел, език) липсват в груповата редакция и при внос.
   Ф6  „Избери всички“ пречертава всички редове.
   Ф7  „Иванов, И.. Първа книга“ в инвентарната книга, акта и протокола.
   Ф9  Витрина: повторно сканиране казва „Добавена“.
   Ф10 Предложение, затворено от прозореца след вписването, губи партидата.
   Ф11 Прегледът при внос на Excel показва датата като число (37755).
   М2  Документ, изпратен по МЗС, се изтрива (handlers/books.js).
   М9  Съобщението за неуспешен запис на каталога сочи „Настройки“. */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
const Y = T.slice(0, 4);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fond-v2471-'));
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* временна папка */ } });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const W = () => h.window;
const catId = (name) => q('SELECT id FROM categories WHERE name = ?', name).id;
/* Номерът се взима от брояча на програмата, както го прави и формата — иначе
   книга, вписана през екрана в някой тест, заема номера на следващата. */
async function newBook(o) {
  const next = q('SELECT next_inv_number AS n FROM settings WHERE id = 1').n;
  const r = await h.api.books.create(Object.assign({ inv_number: next, register_date: T, price: 1,
    department: 'за възрастни', status: 'наличен', category_id: catId('книга') }, o));
  assert.equal(r.ok, true, r.error);
  return r;
}
async function newAcq(o) {
  const no = (await h.api.acquisitions.nextNo(Y)).data;
  const r = await h.api.acquisitions.create(Object.assign({
    no, date: T, how: 'закупуване', from_source: 'Доставчик', doc_type: 'фактура', doc_no: '1',
    doc_date: T, total_count: 3, sum: ''
  }, o));
  assert.equal(r.ok, true, r.error);
  return r.data;
}
async function closeAll() {
  try { W().closeModal2(); } catch (e) { /* няма отворен */ }
  try { W().closeModal(); } catch (e) { /* няма отворен */ }
  await h.settle();
}

/* ==================================================================
   Ф4. Същият брой, различна стойност (първи — докато фондът е празен)
   ================================================================== */
test('Ф4. КДБФ 2 документа / 5 €, табло 2 документа / 12 € — „Проверка на данните“ казва разликата в евро', async () => {
  assert.equal(q('SELECT COUNT(*) AS n FROM books').n, 0, 'тестът иска празна библиотека');
  const ins = h.db.prepare(`INSERT INTO books (inv_number, title, price, register_date, status, category_id)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const k = catId('книга');
  const ids = [
    ins.run(40001, 'Обикновена', 5, T, 'наличен', k).lastInsertRowid,
    ins.run(40002, 'Отчислен без акт', 0, '2020-01-01', 'отчислен', k).lastInsertRowid,
    ins.run(40003, 'С дата в бъдещето', 7, '2030-01-10', 'наличен', k).lastInsertRowid
  ];
  try {
    const r = await h.api.fund.check(Y);
    assert.equal(r.ok, true, r.error);
    const f = r.data.findings.find(x => x.key === 'keys');
    assert.ok(f, 'равен брой, различна стойност — находката трябва да я има: ' + JSON.stringify(r.data.findings));
    assert.equal(r.data.ok, false, 'това не е „бележка“ — числата НЕ се връзват');
    assert.match(f.title, /еднакъв брой документи, но различна стойност на фонда \(\+7,00 €\)/, f.title);
    assert.equal(f.a.n, 2); assert.equal(f.a.v, 5);
    assert.equal(f.b.n, 2); assert.equal(f.b.v, 12);
    assert.match(f.why, /Разлика \(табло − отчет\): 0 документа, \+7,00 €/, f.why);
    assert.match(f.why, new RegExp('1 с дата на вписване след 31\\.12\\.' + Y + ' \\(7,00 €\\)'));
    assert.match(f.why, /1 отчислени без акт \(0,00 €\)/);
    // Екранът „Проверка на данните“ — не „Числата се връзват“.
    await h.go('setup');
    await W().runDataChecks(); await h.settle();
    const box = h.text('#dataChecks');
    assert.match(box, /различна стойност на фонда \(\+7,00 €\)/, box.slice(0, 800));
    assert.doesNotMatch(box, /Числата се връзват/);
  } finally {
    for (const id of ids) h.db.prepare('DELETE FROM books WHERE id = ?').run(id);
  }
  const ok = await h.api.fund.check(Y);
  assert.ok(!ok.data.findings.some(x => x.key === 'keys'), 'след почистването — пак мълчи');
});

/* ==================================================================
   Ф1. ISBN с няколко автори → „Фамилия, Име; Фамилия, Име“
   ================================================================== */
function isbnHandlers(fetchImpl) {
  const handlers = new Map();
  const ipc = { handle: (c, fn) => handlers.set(c, fn) };
  const db = { prepare: () => ({ get: () => ({ sru_endpoint: '' }) }) };
  require('../handlers/isbn-lookup')(ipc, { net: { fetch: fetchImpl }, getDb: () => db });
  return (c, ...a) => handlers.get(c)({}, ...a);
}
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
test('Ф1. Google Books с двама автори: полето „Автор“ е „Вазов, Иван; Константинов, Алеко“, знакът — В-14', async () => {
  const inv = isbnHandlers(async (url) => /googleapis/.test(url)
    ? jsonRes({ items: [{ volumeInfo: { title: 'Сборник разкази', authors: ['Иван Вазов', 'Алеко Константинов'] } }] })
    : jsonRes({}));
  const r = await inv('isbn:lookup', '9789540000017');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.author, 'Вазов, Иван; Константинов, Алеко');
  const m = await h.api.authorMark.suggest({ author: r.data.author, title: r.data.title });
  assert.equal(m.ok, true, m.error);
  assert.equal(m.data.mark, 'В-14', 'знакът е по фамилията на ПЪРВИЯ автор, не по „Иван Вазов“');
});
test('Ф1. Open Library: същото правило; име, което вече е „Фамилия, Име“, и едно-словно име остават както са', async () => {
  const inv = isbnHandlers(async (url) => /openlibrary/.test(url)
    ? jsonRes({ 'ISBN:9789540000017': { title: 'Сборник', authors: [
      { name: 'Антоан дьо Сент-Екзюпери' }, { name: 'Вазов, Иван' }, { name: 'Омир' }] } })
    : jsonRes({}));
  const r = await inv('isbn:lookup', '9789540000017');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.author, 'Сент-Екзюпери, Антоан дьо; Вазов, Иван; Омир');
});
test('Ф1. SRU (MARC 100$a) вече е „Фамилия, Име“ — и точката на инициала не се реже', async () => {
  const xml = '<searchRetrieveResponse><numberOfRecords>1</numberOfRecords><record><leader>00000nam</leader>'
    + '<datafield tag="100" ind1="1" ind2=" "><subfield code="a">Вазов, И.</subfield></datafield>'
    + '<datafield tag="245" ind1="1" ind2="0"><subfield code="a">Под игото /</subfield></datafield></record>'
    + '</searchRetrieveResponse>';
  const inv = isbnHandlers(async () => ({ ok: true, status: 200, text: async () => xml }));
  const r = await inv('sru:lookup', '9789540000017');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.author, 'Вазов, И.');
  assert.equal(r.data.title, 'Под игото');
});

/* ==================================================================
   Ф2. Предложение с автор само по фамилия / двойна фамилия
   ================================================================== */
test('Ф2. предложение от „Вазов“ и от „Сент-Екзюпери“ се разпознава при вписване; друга фамилия — не', async () => {
  const mk = async (title, author) => {
    const r = await h.api.suggestions.create({ title, author, reader_name: 'Колева, Мария' });
    assert.equal(r.ok, true, r.error);
    return r.data;
  };
  const s1 = await mk('Под игото', 'Вазов');
  const s2 = await mk('Малкият принц', 'Сент-Екзюпери');
  const s3 = await mk('Бай Ганьо', 'Вазов');   // друга фамилия от книгата по-долу
  const r1 = await newBook({ title: 'Под игото', author: 'Вазов, Иван' });
  assert.deepEqual(r1.suggestions.map(s => s.id), [s1], 'въпросът „това ли е предложената книга?“ трябва да излезе');
  assert.equal(r1.suggestions[0].author_match, true);
  const r2 = await newBook({ title: 'Малкият принц', author: 'Антоан дьо Сент-Екзюпери' });
  assert.deepEqual(r2.suggestions.map(s => s.id), [s2]);
  const r2b = await h.api.suggestions.matchBook({ title: 'Малкият принц', author: 'Сент-Екзюпери, Антоан дьо' });
  assert.deepEqual(r2b.data.map(s => s.id), [s2]);
  const r3 = await newBook({ title: 'Бай Ганьо', author: 'Константинов, Алеко' });
  assert.deepEqual(r3.suggestions.map(s => s.id), [], 'различна фамилия при същото заглавие е друга книга: ' + s3);
});

/* ==================================================================
   Ф10. Предложение, затворено след вписването, пази партидата
   ================================================================== */
test('Ф10. „Да, отбележи“ след вписване по партида записва партидата и в предложението', async () => {
  const acq = await newAcq({ doc_no: 'Ф10' });
  const sid = (await h.api.suggestions.create({ title: 'Железният светилник', author: 'Талев', reader_name: 'Петров, П.' })).data;
  await W().bookForm(null, acq); await h.settle();
  h.type('#bookF [name=title]', 'Железният светилник');
  h.type('#bookF [name=author]', 'Талев, Димитър');
  h.hooks.confirmAnswer = true;
  const c0 = h.hooks.confirms.length;
  await W().saveBook(null); await h.settle();
  assert.ok(h.hooks.confirms.slice(c0).some(c => /Петров, П\. е поискал\(а\) „Железният светилник“/.test(c)),
    JSON.stringify(h.hooks.confirms.slice(c0)));
  const s = q('SELECT status, acquisition_id FROM suggestions WHERE id = ?', sid);
  assert.equal(s.status, 'получено');
  assert.equal(s.acquisition_id, acq, 'партидата на книгата стига и до предложението');
  await closeAll();
  await h.go('sugg');
  const no = q('SELECT no, year FROM acquisitions WHERE id = ?', acq);
  const row = Array.from(h.document.querySelectorAll('#view tbody tr')).find(tr => /Железният светилник/.test(tr.textContent));
  assert.match(h.text(row), new RegExp('партида № ' + no.no + '/' + no.year), 'разделът „Предложения“ я показва');
});

/* ==================================================================
   Ф7. Двойната точка след инициал
   ================================================================== */
test('Ф7. „Иванов, И. Първа книга“ — без двойна точка в инвентарната книга, акта за дарение и протокола', async () => {
  h.db.prepare("UPDATE settings SET committee1 = 'Мария Иванова', committee2 = 'Петър Георгиев', committee3 = 'Анна Стоянова' WHERE id = 1").run();
  const don = await newAcq({ how: 'дарение', from_source: 'Стефан Николов', doc_type: 'акт (разписка)', doc_no: 'Ф7',
    donor_address: 'гр. Тетевен', total_count: 1 });
  await newBook({ title: 'Първа книга', author: 'Иванов, И.', acquisition_id: don });
  const prot = await newAcq({ how: 'дарение', from_source: 'намерени при подреждане',
    doc_type: 'без документ — протокол на комисия', doc_no: '', doc_date: '', total_count: 1 });
  await newBook({ title: 'Втора книга', author: 'Петров, П.', acquisition_id: prot });
  await newBook({ title: 'Без автор' });

  await h.go('invbook');
  const scr = h.viewText();
  assert.match(scr, /Иванов, И\. Първа книга/, 'инвентарната книга — екран');
  assert.doesNotMatch(scr, /И\.\. Първа/);
  await W().printInvBookDoc(); await h.settle();
  let p = h.printed();
  assert.match(p, /Иванов, И\. Първа книга/, 'инвентарната книга — печат');
  assert.doesNotMatch(p, /\.\. /, 'никъде двойна точка');

  await W().printDonationDoc(don); await h.settle();
  p = h.printed();
  assert.match(p, /Иванов, И\. Първа книга/, 'акт за дарение');
  assert.doesNotMatch(p, /И\.\. /);
  await W().printAcqNoDocDoc(prot); await h.settle();
  p = h.printed();
  assert.match(p, /Петров, П\. Втора книга/, 'протокол');
  assert.doesNotMatch(p, /П\.\. /);
  await W().openAcq(don); await h.settle();
  assert.match(h.modal(), /Иванов, И\. Първа книга/, 'картонът на партидата');
  await closeAll();
  // Автор без точка накрая — разделителят „. “ остава.
  assert.equal(W().authorTitleText('Вазов, Иван', 'Под игото'), 'Вазов, Иван. Под игото');
  assert.equal(W().authorTitleText('', 'Без автор'), 'Без автор');
});

/* ==================================================================
   Ф9. Витрина: повторно сканиране
   ================================================================== */
test('Ф9. повторно сканиране на книга, която вече е във витрината — „вече е във витрината“, не „Добавена“', async () => {
  await newBook({ title: 'Витринна книга', inv_number: 48001 });
  const sid = (await h.api.shelves.create('Нови книги')).data;
  const first = await h.api.shelves.addBook({ shelfId: sid, code: '48001' });
  assert.equal(first.ok, true, first.error);
  const again = await h.api.shelves.addBook({ shelfId: sid, code: '48001' });
  assert.equal(again.ok, false, 'второто сканиране не е „добавяне“');
  assert.match(again.error, /Инв\. № 48001 — „Витринна книга“ вече е във витрината „Нови книги“/);
  assert.match(again.error, /не е променена/);
  // Същото през екрана — скенерът в прозореца на витрината.
  await h.go('catalog');
  await W().openShelf(sid); await h.settle();
  const n0 = h.toasts.length;
  const inp = h.document.getElementById('shelfScan');
  inp.value = '48001';
  inp.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await h.settle();
  const ts = h.toastsSince(n0);
  assert.ok(ts.some(t => /вече е във витрината/.test(t.msg)), JSON.stringify(ts));
  assert.ok(!ts.some(t => /Добавена/.test(t.msg)), 'не „Добавена“: ' + JSON.stringify(ts));
  assert.equal(q('SELECT COUNT(*) AS n FROM catalog_shelf_items WHERE shelf_id = ?', sid).n, 1);
  await closeAll();
});

/* ==================================================================
   М2. Документ, изпратен по МЗС, не се изтрива
   ================================================================== */
test('М2. изтриване на документ, изпратен по МЗС — отказ и на второто натискане; след „върнато“ — обичайният път', async () => {
  const r = await newBook({ title: 'Изпратена книга', inv_number: 48101 });
  const bookId = r.data;
  const mz = h.db.prepare(`INSERT INTO mzs_requests (no, year, date, direction, partner, title, status, book_id, date_sent)
    VALUES (1, ?, ?, 'входящо', 'РБ „Н. Фурнаджиев“', 'Изпратена книга', 'изпратено', ?, ?)`).run(Y, T, bookId, T).lastInsertRowid;
  const d1 = await h.api.books.delete(bookId);
  assert.equal(d1.ok, false);
  assert.match(d1.error, /Инв\. № 48101 \(„Изпратена книга“\) е изпратен по междубиблиотечно заемане на РБ „Н\. Фурнаджиев“/, d1.error);
  assert.match(d1.error, new RegExp('заявка № 1/' + Y + ', „изпратено“'));
  assert.match(d1.error, /отбележете заявката „върнато“ в раздел „МЗС“/);
  const d2 = await h.api.books.delete(bookId);
  assert.equal(d2.ok, false, 'второто натискане НЕ изтрива документ при партньора');
  assert.match(d2.error, /междубиблиотечно заемане/);
  assert.ok(q('SELECT id FROM books WHERE id = ?', bookId), 'документът е на място');
  assert.equal(q('SELECT book_id FROM mzs_requests WHERE id = ?', mz).book_id, bookId, 'заявката сочи към него');
  // „получено“ при партньора — същото.
  h.db.prepare("UPDATE mzs_requests SET status = 'получено' WHERE id = ?").run(mz);
  assert.match((await h.api.books.delete(bookId)).error, /междубиблиотечно заемане/);
  // Върнат — отказът по МЗС изчезва; остава обичайното второ натискане за вписан документ.
  h.db.prepare("UPDATE mzs_requests SET status = 'върнато' WHERE id = ?").run(mz);
  const d3 = await h.api.books.delete(bookId);
  assert.equal(d3.ok, false);
  assert.doesNotMatch(d3.error, /междубиблиотечно/);
  assert.match(d3.error, /ВПИСАН в инвентарната книга/);
  assert.equal((await h.api.books.delete(bookId)).ok, true);
});

/* ==================================================================
   М9. Съобщението при неуспешен запис на каталога
   ================================================================== */
test('М9. неуспешен запис на каталога сочи „Отчети“ → „Онлайн каталог“, не „Настройки“', async () => {
  h.db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(path.join(TMP, 'няма', 'такава'));
  try {
    const res = await newBook({ title: 'Книга при изключен диск' });
    assert.match(String(res.catalogWarning), /не успя/);
    assert.match(String(res.catalogWarning), /папката за онлайн каталога в „Отчети“ → „Онлайн каталог“/);
    assert.doesNotMatch(String(res.catalogWarning), /„Настройки“/);
  } finally {
    h.db.prepare('UPDATE settings SET catalog_folder = NULL WHERE id = 1').run();
  }
});

/* ==================================================================
   Ф5. Номенклатурите в груповата редакция и при внос
   ================================================================== */
async function addNomenclature() {
  const opts = (await h.api.av.options()).data;
  const keep = (c, extra) => [...opts[c].map(o => ({ value: o.value, opac_label: o.opac_label })), { value: extra }];
  assert.equal((await h.api.av.save({ category: 'department', values: keep('department', 'музикален') })).ok, true);
  assert.equal((await h.api.av.save({ category: 'language', values: keep('language', 'испански') })).ok, true);
}
const selectOptions = (sel) => Array.from(h.document.querySelectorAll(sel + ' option')).map(o => o.value);
test('Ф5. груповата редакция предлага отдел „музикален“ и език „испански“ от „Номенклатури“ — и ги записва', async () => {
  await addNomenclature();
  const b = await newBook({ title: 'За музикалния отдел', inv_number: 48201 });
  await h.go('books');
  W().eval('BOOKS_SELECTED.clear(); BOOKS_SELECTED.add(' + b.data + ')');
  await W().openBulkEdit(); await h.settle();
  assert.ok(selectOptions('#bulkF [name=bulkValue]').includes('музикален'), selectOptions('#bulkF [name=bulkValue]').join(' | '));
  h.type('#bulkF [name=bulkField]', 'language');
  W().refreshBulkValueField();
  assert.ok(selectOptions('#bulkF [name=bulkValue]').includes('испански'), selectOptions('#bulkF [name=bulkValue]').join(' | '));
  h.type('#bulkF [name=bulkField]', 'department');
  W().refreshBulkValueField();
  h.type('#bulkF [name=bulkValue]', 'музикален');
  await W().applyBulkEdit(); await h.settle();
  assert.equal(q('SELECT department FROM books WHERE id = ?', b.data).department, 'музикален');
});

/* ==================================================================
   Ф11 и Ф5. Вносът на Excel: прегледът с дати и подразбиранията от номенклатурите
   ================================================================== */
/* Най-малкият истински .xlsx: ZIP без компресия с един лист, числата — като
   числа (t="n"), каквито ги пише Excel за дата. */
function xlsxFile(name, rows) {
  const col = (i) => String.fromCharCode(65 + i);
  const cell = (v, r, c) => typeof v === 'number'
    ? `<c r="${col(c)}${r}"><v>${v}</v></c>`
    : `<c r="${col(c)}${r}" t="inlineStr"><is><t>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`;
  const sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>'
    + rows.map((r, i) => `<row r="${i + 1}">` + r.map((v, c) => cell(v, i + 1, c)).join('') + '</row>').join('')
    + '</sheetData></worksheet>';
  const files = [['xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8')]];
  const locals = [], centrals = [];
  let off = 0;
  for (const [n, data] of files) {
    const nb = Buffer.from(n, 'utf8');
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  const p = path.join(TMP, name);
  fs.writeFileSync(p, Buffer.concat([...locals, cd, eocd]));
  return p;
}
test('Ф11. прегледът на Excel показва 14.05.2003, не 37755; Ф5 — „Отдел/Език по подразбиране“ от номенклатурите', async () => {
  const p = xlsxFile('opis-evro.xlsx', [
    ['Инвентарен №', 'Заглавие', 'Дата на вписване'],
    [48301, 'Старопланински легенди', 37755],
    [48302, 'Ръжено зрънце', '14.05.2003']
  ]);
  await h.go('setup');
  h.dialogs.openPaths = [p];
  await h.clickButton('Избери файл за въвеждане…');
  await h.settle();
  const preview = h.text('#modal .wrap');
  assert.match(preview, /Старопланински легенди\s*14\.05\.2003/, preview);
  assert.doesNotMatch(preview, /37755/, 'Excel-ското число не стига до прегледа');
  // Ф5: номенклатурите от предишния тест са в менютата на вноса.
  assert.ok(selectOptions('#impOptF [name=defaultDepartment]').includes('музикален'),
    selectOptions('#impOptF [name=defaultDepartment]').join(' | '));
  assert.ok(selectOptions('#impOptF [name=defaultLanguage]').includes('испански'));
  assert.equal(h.$('#impOptF [name=defaultDepartment]').value, 'за възрастни', 'подразбирането остава същото');
  h.type('#impOptF [name=defaultDepartment]', 'музикален');
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  const b = q('SELECT register_date, department FROM books WHERE inv_number = 48301');
  assert.equal(b.register_date, '2003-05-14', 'базата — както и досега');
  assert.equal(b.department, 'музикален', 'изборът от номенклатурата стига до базата');
  await closeAll();
});

/* ==================================================================
   Ф3. Ред от файла с дата на вписване в бъдещето
   ================================================================== */
test('Ф3. ред с дата 10.01.2030 се приема (като във формата), но отчетът на вноса го казва поименно', async () => {
  const p = path.join(TMP, 'badeshte.csv');
  fs.writeFileSync(p, '﻿' + [
    'Инвентарен №,Заглавие,Цена,Дата на вписване',
    '48401,Днешна книга,2,' + E.bgDate(T),
    '48402,Книга от бъдещето,7,10.01.2030'
  ].join('\n'), 'utf8');
  await h.go('setup');
  h.dialogs.openPaths = [p];
  await h.clickButton('Избери файл за въвеждане…');
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  const rep = h.modal();
  assert.match(rep, /Дата на вписване в бъдещето: 1\s*ред/, rep.slice(0, 1500));
  assert.match(rep, /ред 3 \(№ 48402\) — „Книга от бъдещето“: 10\.01\.2030/);
  assert.match(rep, /НЕ влиза в Книгата за движение на фонда и в годишния отчет/);
  assert.doesNotMatch(rep, /Днешна книга“: /, 'днешната дата не е в списъка');
  assert.equal(q('SELECT register_date FROM books WHERE inv_number = 48402').register_date, '2030-01-10',
    'редът е приет — както го приема и формата за книга (с предупреждение)');
  const audit = q("SELECT detail FROM audit_log WHERE action = 'Въвеждане на данни' ORDER BY id DESC LIMIT 1").detail;
  assert.match(audit, /1 с дата на вписване в бъдещето \(ред 3 → 2030-01-10\)/, audit);
  await closeAll();
});

/* ==================================================================
   Ф6. „Избери всички“ не пречертава таблицата
   ================================================================== */
test('Ф6. „Избери всички“ отмята изчертаните редове на място — без ново сглобяване на таблицата', async () => {
  await h.go('books');
  const rows0 = Array.from(h.document.querySelectorAll('#bBody tr'));
  assert.ok(rows0.length > 5, 'има изчертани редове');
  const total = q("SELECT COUNT(*) AS n FROM books").n;
  await W().toggleBookSelAll(true); await h.settle();
  const rows1 = Array.from(h.document.querySelectorAll('#bBody tr'));
  assert.equal(rows1.length, rows0.length);
  assert.ok(rows1.every((tr, i) => tr === rows0[i]), 'редовете са СЪЩИТЕ елементи — таблицата не е пречертана');
  assert.ok(rows1.every(tr => tr.querySelector('input.bkChk').checked), 'всички изчертани са отметнати');
  assert.match(h.text('#bulkCount'), new RegExp('^' + total + ' избрани$'));
  assert.equal(h.$('#chkAll').checked, true);
  await W().toggleBookSelAll(false); await h.settle();
  const rows2 = Array.from(h.document.querySelectorAll('#bBody tr'));
  assert.ok(rows2.every((tr, i) => tr === rows0[i]), 'и при махане на избора');
  assert.ok(rows2.every(tr => !tr.querySelector('input.bkChk').checked));
  assert.equal(h.$('#bulkBtn').disabled, true);
});
