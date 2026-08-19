// Тестове за importers.js — избран приоритетно от QA анализа, защото е
// единственият модул с ръчно писан бинарен парсер (ZIP/XLSX), захранван с
// непроверени файлове от библиотекаря, и защото вече е чисто експортируем.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeBuffer,
  parseDelimited,
  guessMapping,
  parseXlsx,
  HEADER_MAP
} = require('../importers');

/* ---------------- CSV/TSV разделен текст ---------------- */

test('parseDelimited handles quoted fields containing the delimiter itself', () => {
  const text = 'a;"b;c";d\n1;2;3\n';
  const rows = parseDelimited(text, ';');
  assert.deepEqual(rows[0], ['a', 'b;c', 'd']);
  assert.deepEqual(rows[1], ['1', '2', '3']);
});

test('parseDelimited un-escapes doubled quotes inside a quoted field', () => {
  const text = 'title\n"Book ""quoted"" title"\n';
  const rows = parseDelimited(text, ';');
  assert.deepEqual(rows[1], ['Book "quoted" title']);
});

test('parseDelimited handles CRLF line endings and drops fully-blank rows', () => {
  const text = 'a;b\r\n1;2\r\n\r\n3;4\r\n';
  const rows = parseDelimited(text, ';');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
});

/* ---------------- Кодиране ---------------- */

test('decodeBuffer detects UTF-8 BOM and strips it', () => {
  const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('Заглавие', 'utf8')]);
  const { text, encoding } = decodeBuffer(buf);
  assert.equal(text, 'Заглавие');
  assert.equal(encoding, 'UTF-8 (BOM)');
});

test('decodeBuffer detects UTF-16LE BOM', () => {
  const bom = Buffer.from([0xFF, 0xFE]);
  const body = Buffer.from('Автор', 'utf16le');
  const { text, encoding } = decodeBuffer(Buffer.concat([bom, body]));
  assert.equal(text, 'Автор');
  assert.equal(encoding, 'UTF-16LE');
});

test('decodeBuffer falls back to Windows-1251 for old Bulgarian exports', () => {
  // Байтовете за "Автор" в Windows-1251 — не са валидна UTF-8 последователност,
  // затова decodeBuffer трябва да превключи към Windows-1251.
  const buf = Buffer.from([0xC0, 0xE2, 0xF2, 0xEE, 0xF0]);
  const { text, encoding } = decodeBuffer(buf);
  assert.equal(text, 'Автор');
  assert.equal(encoding, 'Windows-1251');
});

test('decodeBuffer treats clean ASCII/UTF-8 text as plain UTF-8', () => {
  const { text, encoding } = decodeBuffer(Buffer.from('Hello, world', 'utf8'));
  assert.equal(text, 'Hello, world');
  assert.equal(encoding, 'UTF-8');
});

/* ---------------- Разпознаване на колони ---------------- */

test('guessMapping matches exact known Bulgarian header names', () => {
  const map = guessMapping(['Инвентарен номер', 'Заглавие', 'Автор', 'Година']);
  assert.equal(map[0], 'inv_number');
  assert.equal(map[1], 'title');
  assert.equal(map[2], 'author');
  assert.equal(map[3], 'year');
});

test('guessMapping does not assign the same target field to two columns', () => {
  // И двете колони приличат на "заглавие", но полето title може да се ползва само веднъж.
  const map = guessMapping(['заглавие', 'заглавие']);
  const assigned = Object.values(map).filter(f => f === 'title');
  assert.equal(assigned.length, 1);
});

test('guessMapping falls back to partial match for unrecognised-but-similar headers', () => {
  const map = guessMapping(['инвентарен номер на книгата']);
  assert.equal(map[0], 'inv_number');
});

test('guessMapping leaves unrecognisable headers unmapped', () => {
  const map = guessMapping(['напълно непознато поле xyz']);
  assert.equal(map[0], undefined);
});

/* ЗАЩО тестът е такъв, какъвто е: заглавието му обещаваше „HEADER_MAP покрива
   полетата, които importers.js твърди, че поддържа", а тялото проверяваше
   съществуването на три ключа (title/author/isbn) — тоест не проверяваше нищо.
   Мутационен одит махна price/udk/barcode/register_date от HEADER_MAP и това
   мина незабелязано: разпознаването на тези колони при внос от чужда система
   мълчаливо спира, а библиотекарят вижда празни цени и УДК след внос на
   няколко хиляди записа.

   Двата списъка се СРАВНЯВАТ, а не се преписват:
     • HEADER_MAP (importers.js) — по кои заглавия на колони се РАЗПОЗНАВА поле;
     • IMPORT_FIELDS (handlers/data-import.js) — кои полета изобщо се предлагат
       за ръчно съотнасяне в екрана „Приемане на данни".
   IMPORT_FIELDS не се изнася от модула, затова се взима оттам, откъдето го
   получава и самият интерфейс — от отговора на канала import:load. */
function importFieldsFromChannel() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-import-fields-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* няма значение */ } });
  const file = path.join(dir, 'primer.csv');
  fs.writeFileSync(file, 'Заглавие;Автор\nПод игото;Вазов\n', 'utf8');

  const handlers = new Map();
  require('../handlers/data-import')({ handle: (c, fn) => handlers.set(c, fn) }, {
    getDb: () => { throw new Error('import:load не докосва базата'); },
    run: (fn) => ({ ok: true, data: fn() }), logAudit: () => {},
    dialog: {}, getMainWindow: () => ({}), fs, path,
    BOOK_FIELDS: [], today: () => '2026-08-02', cnSortKey: () => ''
  });
  const res = handlers.get('import:load')({}, file);
  assert.equal(res.ok, true, res.error);
  return res.data.fields;
}

test('HEADER_MAP и IMPORT_FIELDS не се разминават — всяко разпознавано поле може и да се съотнесе', () => {
  const IMPORT_FIELDS = importFieldsFromChannel();
  const mapFields = Object.keys(HEADER_MAP).sort();
  const offered = Object.keys(IMPORT_FIELDS).sort();

  // Посока 1: няма поле, което авто-разпознаването намира, а екранът не предлага.
  const recognisedButNotOffered = mapFields.filter(f => !offered.includes(f));
  assert.deepEqual(recognisedButNotOffered, [],
    'HEADER_MAP разпознава поле, което „Приемане на данни" не предлага — колоната се '
    + 'разпознава, но потребителят не може нито да я види, нито да я поправи');

  /* Посока 2: няма поле, което екранът предлага, а авто-разпознаването да не намира.
     До v2.3.0 такива бяха „Поредица"/„№ в поредицата" — можеха да се съотнесат само
     РЪЧНО, затова колоната мълчаливо оставаше празна, ако библиотекарят не я посочи.
     Списъкът е нарочно ПРАЗЕН: всяко ново поле за внос трябва да получи и заглавия в
     HEADER_MAP, иначе този тест пада, вместо пропускът да си замине мълчаливо —
     точно както стана със series при самия внос. */
  const offeredWithoutAutodetect = offered.filter(f => !mapFields.includes(f));
  assert.deepEqual(offeredWithoutAutodetect, [],
    'поле се предлага за внос, но никое заглавие не го разпознава автоматично — '
    + 'добавете му заглавия в HEADER_MAP (importers.js)');
});

test('всяко поле в HEADER_MAP наистина се разпознава по всяко от изброените си заглавия', () => {
  /* Не просто „ключът съществува", а поведението: подава се заглавието на
     колона и се проверява, че guessMapping връща точно това поле. Така орязан
     списък заглавия също се хваща, не само липсващ ключ. */
  for (const [field, names] of Object.entries(HEADER_MAP)) {
    assert.ok(Array.isArray(names) && names.length, field + ': празен списък заглавия');
    for (const name of names) {
      const map = guessMapping([name]);
      assert.equal(map[0], field, `колона „${name}" трябва да се разпознае като ${field}, а се разпозна като ${map[0]}`);
    }
  }
});

test('ключовите полета от истински износ на чужда система се разпознават наведнъж', () => {
  /* Точно колоните, които мутационният одит махна (price/udk/barcode/
     register_date), плюс основните — в един ред, както идват от файл. */
  const headers = ['Инвентарен №', 'Заглавие', 'Автор', 'Издателство', 'Година',
    'ISBN', 'Цена', 'УДК', 'Баркод', 'Дата на постъпване', 'Отдел', 'Състояние'];
  const map = guessMapping(headers);
  assert.deepEqual(Object.values(map), ['inv_number', 'title', 'author', 'publisher', 'year',
    'isbn', 'price', 'udk', 'barcode', 'register_date', 'department', 'status'],
    'разпознаването на цялата шапка на типичен износ не бива да губи нито една колона');
});


/* ---------------- Ръчно писан ZIP/XLSX парсер ---------------- */

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

// Минимален валиден ZIP (метод STORE, без компресия) — покрива точно това,
// което unzipEntries()/parseXlsx() четат: локални записи + централна
// директория + EOCD. Достатъчно, за да тества истинския ръчен парсер, вместо
// да го заобикаля.
function buildStoreZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, dataBuf] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(dataBuf.length), u32(dataBuf.length),
      u16(nameBuf.length), u16(0)
    ]);
    const localEntry = Buffer.concat([localHeader, nameBuf, dataBuf]);
    localParts.push(localEntry);

    const centralHeader = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(dataBuf.length), u32(dataBuf.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset)
    ]);
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localEntry.length;
  }
  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(Object.keys(files).length), u16(Object.keys(files).length),
    u32(centralData.length), u32(localData.length), u16(0)
  ]);
  return Buffer.concat([localData, centralData, eocd]);
}

test('parseXlsx reads rows/cells out of a minimal hand-built XLSX archive', () => {
  const sheetXml =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Заглавие</t></is></c>' +
    '<c r="B1" t="inlineStr"><is><t>Автор</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>Тестова книга</t></is></c>' +
    '<c r="B2" t="inlineStr"><is><t>Иван Иванов</t></is></c></row>' +
    '</sheetData></worksheet>';
  const zip = buildStoreZip({ 'xl/worksheets/sheet1.xml': Buffer.from(sheetXml, 'utf8') });
  const rows = parseXlsx(zip);
  assert.deepEqual(rows, [
    ['Заглавие', 'Автор'],
    ['Тестова книга', 'Иван Иванов']
  ]);
});

test('parseXlsx resolves shared-string cells via xl/sharedStrings.xml', () => {
  const sharedXml = '<sst><si><t>Заглавие</t></si><si><t>Тестова книга</t></si></sst>';
  const sheetXml =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>1</v></c></row>' +
    '</sheetData></worksheet>';
  const zip = buildStoreZip({
    'xl/sharedStrings.xml': Buffer.from(sharedXml, 'utf8'),
    'xl/worksheets/sheet1.xml': Buffer.from(sheetXml, 'utf8')
  });
  const rows = parseXlsx(zip);
  assert.deepEqual(rows, [['Заглавие'], ['Тестова книга']]);
});

test('parseXlsx rejects a non-ZIP / malformed buffer with a clear error instead of crashing', () => {
  const garbage = Buffer.from('this is definitely not a zip file, just some random bytes');
  assert.throws(() => parseXlsx(garbage), /не е валиден XLSX архив/);
});

test('parseXlsx rejects a ZIP with no worksheet entry', () => {
  const zip = buildStoreZip({ 'xl/sharedStrings.xml': Buffer.from('<sst></sst>', 'utf8') });
  assert.throws(() => parseXlsx(zip), /няма намерен лист с данни/);
});
