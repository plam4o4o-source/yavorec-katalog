/* Приемане на данни от други библиотечни системи.
 *
 * Целта е читалище с изоставена стара база (АБ, iLib, чужд Excel) да мине на
 * „Инвентар“ без преписване на ръка. Затова се четат най-разпространените
 * формати на износ: CSV/TSV (с точка и запетая, запетая или табулация) и XLSX.
 *
 * Нарочно БЕЗ външни зависимости — добавянето на пакет усложнява изграждането и
 * подписването. XLSX се чете с наличния zlib, а кирилицата в стари файлове —
 * с TextDecoder, който Electron поддържа с пълен ICU.
 */
const fs = require('fs');
const zlib = require('zlib');

/* ---------------- Кодиране ---------------- */
// Старите български износи обикновено са Windows-1251, новите — UTF-8. Изборът
// става по BOM, а при липса — по това дали текстът се разчита смислено като UTF-8.
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { text: buf.slice(3).toString('utf8'), encoding: 'UTF-8 (BOM)' };
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le').decode(buf.slice(2)), encoding: 'UTF-16LE' };
  }
  const utf8 = buf.toString('utf8');
  // U+FFFD се появява там, където байтовете не са валиден UTF-8.
  const bad = (utf8.match(/�/g) || []).length;
  if (bad === 0) return { text: utf8, encoding: 'UTF-8' };
  try {
    return { text: new TextDecoder('windows-1251').decode(buf), encoding: 'Windows-1251' };
  } catch (e) {
    return { text: utf8, encoding: 'UTF-8 (с нечетими знаци)' };
  }
}

/* ---------------- CSV / TSV ---------------- */
// Разделителят се определя по първия ред: брои се кой знак се среща най-често
// извън кавички. Точката и запетаята е обичайна за български Excel.
function detectDelimiter(firstLine) {
  const counts = { ';': 0, ',': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (let i = 0; i < firstLine.length; i++) {
    const c = firstLine[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (!inQ && c in counts) counts[c]++;
  }
  let best = ';', n = -1;
  for (const [d, c] of Object.entries(counts)) if (c > n) { n = c; best = d; }
  return n > 0 ? best : ';';
}
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/* ---------------- XLSX ----------------
   XLSX е ZIP архив с XML вътре. Тук се чете ръчно: обхожда се централната
   директория на архива, изваждат се двата нужни файла и се разчита първият лист. */
// Лимити срещу изчерпване на паметта/процесора при внасяне на повреден или
// злонамерено скалъпен .xlsx (Фаза 3, сигурност — "hand-rolled XLSX парсер
// без лимити" от анализа). Разопаковането (inflateRawSync) на малка компресирана
// част в огромна разопакована ("zip bomb") е класически риск за такъв ръчен
// парсер; maxOutputLength спира разопаковането веднага, вместо да позволи да
// изяде цялата налична памет на компютъра на библиотекаря.
const MAX_XLSX_FILE_SIZE = 60 * 1024 * 1024; // суров .xlsx файл — разумен таван за библиотечен внос
const MAX_XLSX_ENTRIES = 2000; // вътрешни части в архива (истински .xlsx има под 20–30)
const MAX_XLSX_ENTRY_UNCOMPRESSED = 150 * 1024 * 1024; // разопакован размер на ЕДНА вътрешна част
function unzipEntries(buf) {
  if (buf.length > MAX_XLSX_FILE_SIZE) {
    throw new Error('Файлът е твърде голям за внасяне (над ' + Math.round(MAX_XLSX_FILE_SIZE / 1024 / 1024) + ' MB).');
  }
  const out = {};
  // Краят на централната директория (EOCD) носи къде започва тя.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файлът не е валиден XLSX архив.');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_XLSX_ENTRIES) throw new Error('XLSX архивът съдържа необичайно много вътрешни части.');
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (p < 0 || p + 46 > buf.length) throw new Error('Повреден или недовършен XLSX архив.');
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // Локалният запис има собствени дължини на име и допълнителни данни.
    if (localOff < 0 || localOff + 30 > buf.length) throw new Error('Повреден или недовършен XLSX архив.');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      try {
        out[name] = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_XLSX_ENTRY_UNCOMPRESSED });
      } catch (err) {
        throw new Error('Част от XLSX архива не може да бъде разопакована (повреден файл или неочаквано голям размер).');
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
const xmlUnescape = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');
function colToIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseXlsx(buf) {
  const files = unzipEntries(buf);
  // Общият низов пул: клетките от тип "s" сочат към него по номер.
  const shared = [];
  const ssFile = files['xl/sharedStrings.xml'];
  if (ssFile) {
    const xml = ssFile.toString('utf8');
    for (const si of xml.split('<si>').slice(1)) {
      const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => xmlUnescape(m[1]));
      shared.push(parts.join(''));
    }
  }
  const sheetName = Object.keys(files).find(f => /^xl\/worksheets\/sheet1\.xml$/.test(f))
    || Object.keys(files).find(f => /^xl\/worksheets\/.*\.xml$/.test(f));
  if (!sheetName) throw new Error('В XLSX файла няма намерен лист с данни.');
  const sheet = files[sheetName].toString('utf8');
  const rows = [];
  for (const rowXml of sheet.split(/<row[\s>]/).slice(1)) {
    const cells = [];
    for (const m of rowXml.matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>|<c\s([^>]*)\/>/g)) {
      const attrs = m[1] || m[3] || '';
      const inner = m[2] || '';
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1] || '';
      const type = (attrs.match(/t="(\w+)"/) || [])[1] || 'n';
      let val = '';
      if (type === 'inlineStr') {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => xmlUnescape(x[1])).join('');
      } else {
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v != null) val = type === 's' ? (shared[+v] ?? '') : xmlUnescape(v);
      }
      const idx = ref ? colToIndex(ref) : cells.length;
      while (cells.length < idx) cells.push('');
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/* ---------------- Разчитане на файл ---------------- */
function readTable(filePath) {
  const buf = fs.readFileSync(filePath);
  if (filePath.toLowerCase().endsWith('.xlsx')) {
    return { rows: parseXlsx(buf), encoding: 'XLSX', delimiter: null };
  }
  const { text, encoding } = decodeBuffer(buf);
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delimiter = detectDelimiter(firstLine);
  return { rows: parseDelimited(text, delimiter), encoding, delimiter };
}

/* ---------------- Разпознаване на колоните ----------------
   Заглавията на колоните се сравняват с познатите наименования от българските
   библиотечни системи и от обикновените таблици. Съответствието се предлага, но
   библиотекарят го проверява и поправя преди внасяне. */
const HEADER_MAP = {
  inv_number: ['инвентарен номер', 'инвентарен №', 'инв. №', 'инв.№', 'инв №', 'инвн', 'инвентарен',
    'inv', 'inv_number', 'inventory number', 'номер', 'no', '№'],
  title: ['заглавие', 'заглавие на документа', 'наименование', 'title', 'zaglavie'],
  subtitle: ['подзаглавие', 'subtitle'],
  author: ['автор', 'автори', 'author', 'authors', 'avtor'],
  /* v2.3.0 — series/series_no бяха в IMPORT_FIELDS (тоест можеха да се съотнесат
     РЪЧНО), но липсваха тук, затова колона „Поредица" никога не се разпознаваше сама
     и мълчаливо оставаше празна, ако библиотекарят не я посочи. Двата списъка вече
     се сравняват от тест — всяко ново поле в единия чупи теста, вместо да си замине
     мълчаливо, както стана със series при самия внос. */
  series: ['поредица', 'серия', 'библиотека (поредица)', 'series'],
  series_no: ['№ в поредицата', 'номер в поредицата', 'книга от поредицата', 'series_no', 'series no'],
  publisher: ['издателство', 'издател', 'изд', 'изд-во', 'publisher', 'izdatelstvo'],
  city: ['място на издаване', 'място', 'град', 'place', 'city'],
  year: ['година', 'год', 'г', 'година на издаване', 'year', 'godina'],
  isbn: ['isbn', 'issn', 'isbn/issn', 'исбн'],
  pages: ['страници', 'стр', 'обем', 'бр страници', 'pages'],
  language: ['език', 'language', 'ezik'],
  udk: ['удк', 'udk', 'udc'],
  call_number: ['сигнатура', 'шифър', 'call number', 'signatura'],
  author_mark: ['авторски знак', 'авторски-знак', 'author mark'],
  keywords: ['ключови думи', 'предметни рубрики', 'рубрики', 'keywords', 'subjects'],
  annotation: ['анотация', 'резюме', 'бележки', 'annotation', 'abstract'],
  price: ['цена', 'стойност', 'price', 'cena'],
  department: ['отдел', 'местонахождение', 'фонд', 'department'],
  category_name: ['вид', 'вид документ', 'категория', 'type', 'category'],
  status: ['състояние', 'статус', 'status'],
  volume: ['том', 'част', 'volume'],
  barcode: ['баркод', 'barcode'],
  register_date: ['дата на постъпване', 'дата на вписване', 'дата', 'date'],
  description: ['забележка', 'бележка', 'note']
};
const norm = (s) => String(s || '').toLowerCase().trim()
  .replace(/[. ]/g, ' ').replace(/\s+/g, ' ').replace(/[«»„“"']/g, '');
function guessMapping(headers) {
  const map = {};
  const used = new Set();
  headers.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    for (const [field, names] of Object.entries(HEADER_MAP)) {
      if (used.has(field)) continue;
      if (names.some(x => n === x)) { map[i] = field; used.add(field); return; }
    }
  });
  // Втори опит — частично съвпадение, само за неразпознатите колони.
  headers.forEach((h, i) => {
    if (map[i]) return;
    const n = norm(h);
    if (!n) return;
    for (const [field, names] of Object.entries(HEADER_MAP)) {
      if (used.has(field)) continue;
      if (names.some(x => n.includes(x) && x.length >= 3)) { map[i] = field; used.add(field); return; }
    }
  });
  return map;
}

module.exports = { readTable, guessMapping, HEADER_MAP, decodeBuffer, parseDelimited, parseXlsx };
