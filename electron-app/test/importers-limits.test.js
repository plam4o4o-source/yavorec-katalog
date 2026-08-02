// Тестове за лимитите срещу изчерпване на паметта/процесора в ръчно писания
// ZIP/XLSX парсер (importers.js, unzipEntries) — Фаза 3, сигурност. Досега
// парсерът нямаше никакви граници: малък компресиран файл можеше да се
// разопакова в гигабайти памет ("zip bomb"), а повреден централен указател
// можеше да хвърли сурова RangeError грешка вместо разбираемо съобщение.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { parseXlsx } = require('../importers');

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

// Общ билдър, метод по избор (0 = STORE, 8 = DEFLATE) — за разлика от
// buildStoreZip в importers.test.js, тук трябва да можем да лъжем декларирания
// (некомпресиран) размер спрямо реалния след разопаковане, за да симулираме bomb.
function buildZip(entries) {
  // entries: [{ name, raw (компресирани байтове), method, uncompSize }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const en of entries) {
    const nameBuf = Buffer.from(en.name, 'utf8');
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(en.method), u16(0), u16(0),
      u32(0), u32(en.raw.length), u32(en.uncompSize),
      u16(nameBuf.length), u16(0)
    ]);
    const localEntry = Buffer.concat([localHeader, nameBuf, en.raw]);
    localParts.push(localEntry);
    const centralHeader = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(en.method), u16(0), u16(0),
      u32(0), u32(en.raw.length), u32(en.uncompSize),
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
    u16(entries.length), u16(entries.length),
    u32(centralData.length), u32(localData.length), u16(0)
  ]);
  return Buffer.concat([localData, centralData, eocd]);
}

test('rejects a raw file above the overall XLSX size cap instead of trying to parse it', () => {
  const huge = Buffer.alloc(61 * 1024 * 1024); // 1MB over the 60MB cap
  assert.throws(() => parseXlsx(huge), /твърде голям/);
});

test('rejects a "zip bomb" entry that would inflate far past the per-entry cap', () => {
  // 160MB от повтарящ се символ компресира до нищожен размер, но декомпресира
  // над MAX_XLSX_ENTRY_UNCOMPRESSED (150MB) — точно моделът на класически "zip bomb".
  const bomb = Buffer.alloc(160 * 1024 * 1024, 'A');
  const compressed = zlib.deflateRawSync(bomb);
  const zip = buildZip([
    { name: 'xl/worksheets/sheet1.xml', raw: compressed, method: 8, uncompSize: bomb.length }
  ]);
  assert.throws(() => parseXlsx(zip), /не може да бъде разопакована/);
});

test('rejects a ZIP that declares an unreasonable number of internal entries', () => {
  // Само EOCD записът (без реален централен указател зад него) — броят записи
  // се проверява веднага след EOCD, преди изобщо да се чете директорията.
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(5000), u16(5000), // 5000 > MAX_XLSX_ENTRIES (2000)
    u32(0), u32(0), u16(0)
  ]);
  assert.throws(() => parseXlsx(eocd), /необичайно много вътрешни части/);
});

test('rejects a corrupted central-directory pointer with a friendly message, not a raw RangeError', () => {
  // 20 байта "данни" (твърде малко за какъвто и да е реален централен запис,
  // на който трябват поне 46 байта) + EOCD, сочещ cdOffset=0, count=1.
  const data = Buffer.alloc(20);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(1), u16(1),
    u32(20), u32(0), u16(0)
  ]);
  const buf = Buffer.concat([data, eocd]);
  assert.throws(() => parseXlsx(buf), /Повреден или недовършен XLSX архив/);
});

test('a well-formed, modestly sized XLSX still parses normally (limits do not affect legitimate files)', () => {
  const sheetXml = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ОК</t></is></c></row></sheetData></worksheet>';
  const raw = Buffer.from(sheetXml, 'utf8');
  const zip = buildZip([{ name: 'xl/worksheets/sheet1.xml', raw, method: 0, uncompSize: raw.length }]);
  const rows = parseXlsx(zip);
  assert.deepEqual(rows, [['ОК']]);
});
