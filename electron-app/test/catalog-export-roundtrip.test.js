// Кръгова проверка на „Библиотечни формати за обмен“ (handlers/catalog.js):
// UNIMARC/MARCXML, Dublin Core, JSON каталог и CSV на фонда. За разлика от
// handlers-catalog.test.js (който проверява каналите с опростени заместители),
// тук се ползват ИСТИНСКИТЕ BOOK_SELECT (от handlers/books.js) и csvCell (от
// security-utils.js), а записаните файлове се четат обратно и се разбират
// наистина: XML-ът се разчита със строг парсер (jsdom, application/xml —
// невалиден XML хвърля грешка), CSV-то — с четец, зачитащ кавичките. Данните
// са нарочно неудобни: кирилица, & < > " ', управляващ знак \x01, редове с
// NULL полета и заглавие-формула „=SUM(…)“ (CSV injection).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { JSDOM } = require('jsdom');
const registerBooksHandlers = require('../handlers/books');
const registerCatalogHandlers = require('../handlers/catalog');
const { csvCell } = require('../security-utils');

const CTRL = String.fromCharCode(1); // \x01 — недопустим в XML 1.0

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-roundtrip-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.prepare('UPDATE settings SET lib_name = ? WHERE id = 1').run('НЧ „Тест — 1900“');
  const catId = db.prepare('INSERT INTO categories (name) VALUES (?)').run('Художествена литература').lastInsertRowid;

  const ins = db.prepare(`INSERT INTO books (inv_number, title, subtitle, author, category_id, year,
    volume, isbn, pages, language, udk, call_number, city, publisher, keywords, annotation,
    department, status, price) VALUES (@inv_number, @title, @subtitle, @author, @category_id, @year,
    @volume, @isbn, @pages, @language, @udk, @call_number, @city, @publisher, @keywords, @annotation,
    @department, @status, @price)`);
  const base = { subtitle: null, author: null, category_id: null, year: null, volume: null, isbn: null, pages: null,
    language: null, udk: null, call_number: null, city: null, publisher: null, keywords: null,
    annotation: null, department: null, status: null, price: null };
  ins.run({ ...base, inv_number: 1, title: 'Приказки & легенди <избрано>', subtitle: '"Малкият" том',
    // year е TEXT колона и в приложението идва като низ от формата — вж. BOOK_FIELDS
    author: 'Вазов, Иван', category_id: catId, year: '1978', volume: 'Т. 2', isbn: '954-01-1234-5',
    pages: '312 с.', language: 'български', udk: '886.7-1', call_number: 'Б/Ваз', city: 'София',
    publisher: 'Народна младеж', keywords: 'фолклор, приказки; легенди',
    annotation: 'Ред 1\nРед 2' + CTRL, department: 'Заемна', status: 'наличен', price: 19.56 });
  ins.run({ ...base, inv_number: 2, title: '=SUM(A1:A9)', author: 'Омир', language: 'старогръцки',
    publisher: 'Издателство "Свят"', status: 'наличен' });
  ins.run({ ...base, inv_number: 3, title: 'Без данни' });

  // Истинският BOOK_SELECT — точно този, който ползва и работещото приложение.
  const stub = () => {};
  const booksDeps = { getDb: () => db, run: (fn) => ({ ok: true, data: fn() }), logAudit: stub,
    today: () => '2026-08-04', ftsQuery: stub, cnSortKey: () => '', diffFields: () => [],
    scheduleCatalogWrite: stub };
  const { BOOK_SELECT } = registerBooksHandlers(fakeIpcMain(), booksDeps);

  const ipcMain = fakeIpcMain();
  const ctx = { savePath: null };
  registerCatalogHandlers(ipcMain, {
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: stub,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: ctx.savePath }) },
    getMainWindow: () => ({}),
    fs, path,
    execFile: (cmd, args, opts, cb) => cb(null, '', ''),
    BOOK_SELECT, csvCell,
    flushCatalogWrite: () => ({ written: true }),
    buildCatalogPayload: () => ({
      library: 'НЧ „Тест — 1900“', generated: '2026-08-04',
      items: db.prepare('SELECT inv_number AS inv, title, author FROM books ORDER BY inv_number').all()
    })
  });

  const exportTo = async (channel, name) => {
    ctx.savePath = path.join(dir, name);
    const res = await ipcMain.invoke(channel);
    assert.equal(res.ok, true, channel + ': ' + (res.error || ''));
    return fs.readFileSync(ctx.savePath, 'utf8');
  };
  return { db, exportTo };
}

// Строг XML прочит: jsdom с application/xml ХВЪРЛЯ при невалиден документ,
// така че самото извикване е проверка за коректност (well-formedness).
const parseXml = (xml) => new JSDOM(xml, { contentType: 'application/xml' }).window.document;

// Мини CSV четец за един ред: зачита кавичките и удвоените кавички.
function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ';') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

test('UNIMARC/MARCXML: валиден XML, пълен кръг на стойностите, 606/700/995', async () => {
  const { exportTo } = setup();
  const xml = await exportTo('catalog:exportMarc', 'fond-unimarc.xml');

  assert.ok(!xml.includes(CTRL), 'управляващият знак \\x01 трябва да е премахнат');
  const doc = parseXml(xml); // хвърля при невалиден XML
  assert.equal(doc.documentElement.namespaceURI, 'http://www.loc.gov/MARC21/slim');

  const records = [...doc.getElementsByTagName('record')];
  assert.equal(records.length, 3);
  const sub = (rec, tag, code) => {
    const df = [...rec.getElementsByTagName('datafield')].find(d => d.getAttribute('tag') === tag);
    if (!df) return undefined;
    const sf = [...df.getElementsByTagName('subfield')].find(s => s.getAttribute('code') === code);
    return sf && sf.textContent;
  };

  const [r1, r2, r3] = records; // ORDER BY inv_number
  assert.equal(r1.getElementsByTagName('controlfield')[0].textContent, '1');
  // Специалните знаци се връщат ТОЧНО каквито са въведени (екраниране + декодиране).
  assert.equal(sub(r1, '200', 'a'), 'Приказки & легенди <избрано>');
  assert.equal(sub(r1, '200', 'e'), '"Малкият" том');
  assert.equal(sub(r1, '200', 'f'), 'Вазов, Иван');
  assert.equal(sub(r1, '210', 'c'), 'Народна младеж');
  assert.equal(sub(r1, '210', 'd'), '1978');
  assert.equal(sub(r1, '010', 'a'), '954-01-1234-5');
  assert.equal(sub(r1, '101', 'a'), 'bul'); // 'български' → ISO код
  assert.equal(sub(r1, '675', 'a'), '886.7-1');
  assert.equal(sub(r1, '225', 'v'), 'Т. 2');
  assert.equal(sub(r1, '995', 'f'), '1');
  assert.equal(sub(r1, '995', 'o'), 'Художествена литература');

  // Ключовите думи: по едно поле 606 на дума, разделители и „,“ и „;“.
  const kw = [...r1.getElementsByTagName('datafield')]
    .filter(d => d.getAttribute('tag') === '606').map(d => d.textContent.trim());
  assert.deepEqual(kw, ['фолклор', 'приказки', 'легенди']);

  // „Вазов, Иван“ → 700 $a фамилия, $b име.
  assert.equal(sub(r1, '700', 'a'), 'Вазов');
  assert.equal(sub(r1, '700', 'b'), 'Иван');

  // Едносъставно име: само $a, празното $b не се изнася.
  assert.equal(sub(r2, '700', 'a'), 'Омир');
  assert.equal(sub(r2, '700', 'b'), undefined);
  assert.equal(sub(r2, '101', 'a'), 'старогръцки'); // непознат език минава дословно

  // Запис само със заглавие: без 010/101/210, но с 200 и 995.
  assert.equal(sub(r3, '010', 'a'), undefined);
  assert.equal(sub(r3, '200', 'a'), 'Без данни');
  assert.equal(sub(r3, '995', 'f'), '3');
});

test('Dublin Core: валиден XML, събрано заглавие, subject от ключови думи и УДК', async () => {
  const { exportTo } = setup();
  const xml = await exportTo('catalog:exportDc', 'fond-dublincore.xml');
  const doc = parseXml(xml);

  const records = [...doc.getElementsByTagName('record')];
  assert.equal(records.length, 3);
  const vals = (rec, tag) => [...rec.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', tag)]
    .map(e => e.textContent);

  const r1 = records[0];
  assert.deepEqual(vals(r1, 'title'), ['Приказки & легенди <избрано>: "Малкият" том']);
  assert.deepEqual(vals(r1, 'creator'), ['Вазов, Иван']);
  assert.deepEqual(vals(r1, 'language'), ['bul']);
  assert.deepEqual(vals(r1, 'identifier'), ['ISBN 954-01-1234-5', 'inv:1']);
  assert.deepEqual(vals(r1, 'subject'), ['фолклор', 'приказки', 'легенди', 'УДК 886.7-1']);
  assert.deepEqual(vals(r1, 'rights'), ['НЧ „Тест — 1900“']); // от настройките

  const r3 = records[2];
  assert.deepEqual(vals(r3, 'title'), ['Без данни']);
  assert.deepEqual(vals(r3, 'identifier'), ['inv:3']); // без ISBN — само инвентарният
  assert.deepEqual(vals(r3, 'type'), ['text']); // без категория — подразбиране
});

test('JSON каталог: записаният файл се разчита обратно едно към едно', async () => {
  const { exportTo } = setup();
  const parsed = JSON.parse(await exportTo('catalog:export', 'katalog.json'));
  assert.equal(parsed.library, 'НЧ „Тест — 1900“');
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(parsed.items[0], { inv: 1, title: 'Приказки & легенди <избрано>', author: 'Вазов, Иван' });
  assert.deepEqual(parsed.items[1], { inv: 2, title: '=SUM(A1:A9)', author: 'Омир' });
});

test('CSV: BOM, 18 колони на всеки ред, кавички и формули оцеляват кръга', async () => {
  // v1.70.0: 17 → 18 колони — добавена „Поредица“ (books.series/series_no).
  const { exportTo } = setup();
  const raw = await exportTo('catalog:exportCsv', 'fond.csv');

  assert.equal(raw.charCodeAt(0), 0xFEFF, 'файлът трябва да започва с UTF-8 BOM за Excel');
  const lines = raw.slice(1).split('\r\n');
  assert.equal(lines.length, 4); // заглавен ред + 3 книги

  const header = lines[0].split(';');
  assert.equal(header.length, 18);
  assert.ok(header.includes('Поредица'));
  assert.equal(header[0], 'Инв. №');
  for (const line of lines.slice(1)) {
    assert.equal(parseCsvLine(line).length, 18, 'ред с различен брой колони: ' + line);
  }

  const r1 = parseCsvLine(lines[1]);
  const col = (name) => header.indexOf(name);
  assert.equal(r1[col('Заглавие')], 'Приказки & легенди <избрано>'); // без XML екраниране в CSV
  assert.equal(r1[col('Автор')], 'Вазов, Иван');
  assert.equal(r1[col('Цена (лв.)')], '19.56');
  assert.equal(r1[col('Цена (€)')], (19.56 / 1.95583).toFixed(2)); // официалният курс лв./евро

  const r2 = parseCsvLine(lines[2]);
  // Защита от formula injection: водещ апостроф пред „=SUM…“, стойността иначе е цяла.
  assert.equal(r2[col('Заглавие')], "'=SUM(A1:A9)");
  // Кавичките в „Издателство "Свят"“ се удвояват при запис и се връщат точно при прочит.
  assert.equal(r2[col('Издателство')], 'Издателство "Свят"');

  const r3 = parseCsvLine(lines[3]);
  assert.equal(r3[col('Инв. №')], '3');
  assert.equal(r3[col('Автор')], ''); // NULL → празна клетка, не 'null'
});
