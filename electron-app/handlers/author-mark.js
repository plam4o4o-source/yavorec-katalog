'use strict';
/* ============================================================================
   Авторски знак — предложение по фамилията на автора.

   ЗАЩО ТАБЛИЦАТА НЕ Е ВГРАДЕНА. Знакът е буква + двузначно число, а числото
   идва от „Авторски таблици. Двузначни“ (Български библиографски институт) —
   чуждо издание. Затова програмата не носи таблица със себе си: библиотекарката
   посочва ВЕДНЪЖ своя файл (записана страница, CSV или обикновен текст), той се
   разчита и се записва в базата. Оттам нататък всичко работи офлайн, без
   интернет и без нищо чуждо да се разпространява с програмата.

   ЗАЩО ПРЕДЛОЖЕНИЕ, А НЕ АВТОМАТИКА. По какво се подписва книгата решава
   каталогизацията, не сметката: сборник без автор и антология се подписват по
   заглавието, книга с повече от трима автори — също, а понякога биография се
   подписва по лицето, за което е книгата. Затова тук се ПРЕДЛАГА знак и се
   показва ОТКЪДЕ идва („фамилия «Вазов» → ред «ВАЗ» → В-15“), а вписването
   остава решение на човека. Същото е и с таблицата на УДК (src/udk.js):
   „таблицата само помага да се въведе правилният код, без да го налага“.
   ========================================================================== */

/* Кирилица по азбучен ред. Българската азбука е подредица на Unicode подредбата
   на кирилицата (А…Я без Ы, Э, Ё), затова обикновено сравняване на низове дава
   верния български ред и не е нужна локална подредба. */
const BG_LETTERS = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯ';
const IMPORT_EXTENSIONS = ['.docx', '.odt', '.xlsx', '.csv', '.tsv', '.txt', '.html', '.htm'];

/* Windows-1251 → Unicode за горната половина на кода. Файл, записан от Excel
   или от стар Windows редактор, е обикновено в тази кодировка; прочетен като
   UTF-8, той не съдържа НИТО ЕДНА кирилска буква и таблицата излиза празна без
   да е ясно защо. Затова, ако разчитането като UTF-8 не даде кирилица, файлът се
   пробва и така. */
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ' +
  ' ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ' +
  'абвгдежзийклмнопрстуфхцчшщъыьэюя';
function decodeCp1251(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    s += b < 0x80 ? String.fromCharCode(b) : CP1251_HIGH.charAt(b - 0x80);
  }
  return s;
}
function decodeFile(buf) {
  const utf8 = buf.toString('utf8');
  if (/[А-Яа-я]/.test(utf8)) return utf8;
  const win = decodeCp1251(buf);
  return /[А-Яа-я]/.test(win) ? win : utf8;
}

/* Само българските букви от даден текст, с главни букви. По тях се търси в
   таблицата: „Вазов, Иван“ → „ВАЗОВ“. */
function keyOf(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^А-Я]/g, '');
}
/* Ключ за РЕД ОТ ТАБЛИЦАТА. Разликата с keyOf(): препинателният знак вътре в
   реда („Димитров, Г.“) се пази като знак, който се нарежда ПРЕДИ всяка буква.
   Иначе редът се слива в „ДИМИТРОВГ“, застава след „Димитрова“ и — понеже
   числата вече не растат — пресяването го изхвърля като шум. Така подредбата на
   печатната таблица се запазва, а търсенето по гола фамилия („ДИМИТРОВ“) пак
   пада на своя ред, не на реда с инициала. */
const SEP_MARK = '\u0001';
function rowKeyOf(s) {
  return String(s == null ? '' : s).toUpperCase()
    .replace(/[^А-Я]+/g, SEP_MARK)
    .replace(new RegExp('^' + SEP_MARK + '+|' + SEP_MARK + '+$', 'g'), '');
}
/* Обратно за показване на човек: „ДИМИТРОВ, Г“ вместо вътрешния знак. */
function prefixLabel(p) {
  return String(p == null ? '' : p).split(SEP_MARK).join(', ');
}
/* По какво се подписва: фамилията на ПЪРВИЯ автор, а ако автор няма — първата
   дума от заглавието (както при сборник или антология).
   Формата на полето „Автор“ е „фамилия, име“, но в заварени бази се среща и
   „Име Фамилия“ — тогава за фамилия се взима последната дума, СЪЩО както прави
   splitName() в handlers/catalog.js за износа в UNIMARC. Псевдоним от две думи
   („Елин Пелин“) не се разпознава като такъв — затова предложението винаги
   казва коя дума е взело за фамилия, за да си личи. */
function basisOf(book) {
  const author = String((book && book.author) || '').trim();
  if (author) {
    const first = author.split(';')[0].trim();          // „Габе, Дора; Шишкова, М.“ → първият
    const c = first.indexOf(',');
    if (c > 0) return { basis: first.slice(0, c).trim(), from: 'author', exact: true };
    const w = first.split(/\s+/).filter(Boolean);
    // Без запетая не се знае кое е фамилията: взима се последната дума, но целият
    // надпис се носи нататък (basisFull), за да може да се провери и псевдонимът.
    if (w.length > 1) return { basis: w[w.length - 1], from: 'author', exact: false, basisFull: first };
    return { basis: first, from: 'author', exact: true };
  }
  const title = String((book && book.title) || '').trim();
  if (!title) return null;
  const w = title.replace(/^[„"'«(\[]+/, '').split(/\s+/).filter(Boolean);
  return { basis: w[0] || '', from: 'title', exact: true };
}

/* Текстът на файла, какъвто и да е той.

   .docx и .odt са ZIP контейнери (същият като .xlsx) — текстът се вади от
   word/document.xml, съответно content.xml. Word реже един абзац на няколко
   парчета <w:t>, затова те се слепват БЕЗ разделител: иначе „Аба“ може да се
   разпадне на „Аб“ и „а“ и редът да се загуби. Таблиците (.xlsx, .csv) минават
   през importers.readTable — там вече са разпознаването на кодировката и
   таваните срещу злонамерен архив. */
function xmlText(xml, tagRe) {
  const out = [];
  let m;
  while ((m = tagRe.exec(xml)) !== null) out.push(m[1]);
  return out.join('')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}
function docxText(parts) {
  const doc = parts['word/document.xml'];
  if (doc) {
    /* Всеки абзац на свой ред — редът е това, което държи буквосъчетанието и
       числото му заедно (виж предпазителя в extractPairs). */
    return String(doc).split(/<\/w:p>/).map(p => xmlText(p, /<w:t[^>]*>([\s\S]*?)<\/w:t>/g)).join('\n');
  }
  const odt = parts['content.xml'];
  if (odt) return String(odt).split(/<\/text:p>/).map(p => xmlText(p, />([^<]*)</g)).join('\n');
  return null;
}
function readTableText(filePath, io) {
  const { fs, path, importers } = io;
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  if (isZip && ext !== '.xlsx') {
    const text = docxText(importers.unzipEntries(buf));
    if (text == null) throw new Error('Файлът е архив, но вътре няма текстов документ (очаква се .docx или .odt).');
    return text;
  }
  if (['.xlsx', '.csv', '.tsv', '.txt'].includes(ext)) {
    const rows = importers.readTable(filePath).rows || [];
    return rows.map(r => r.map(c => (c == null ? '' : String(c))).join(' ')).join('\n');
  }
  return decodeFile(buf);
}

/* Разчитане на файл с таблица.

   Форматът НЕ е известен предварително — приемат се записана уеб страница, CSV,
   TSV и обикновен текст, а в записаната страница данните може да са и вътре в
   скрипт. Затова не се разчита на подредба на колони, а се събират всички двойки
   „буквосъчетание + число“ и се пресяват по свойството, което ПРАВИ таблицата
   таблица: вътре в една буква числата растат заедно с буквосъчетанието (точно
   това нарежда книгите по азбучен ред на рафта). Всичко, което нарушава този
   ред, е шум (стилове, идентификатори, години в текста) и отпада.

   Числото се пази като ТЕКСТ: „05“ не е 5 и водещата нула е част от знака. */
function extractPairs(text, digitsFirst) {
  /* Записите се РАЗДЕЛЯТ от самите числа: „А 11Аба 12Абд 13“ е един ред, в
     който между числата стои следващото буквосъчетание. Затова не се търси
     буквосъчетание с предварително известна дължина (първият опит го правеше и
     режеше „Христович“ до последните осем букви — „ристович“ — тоест истински
     ред отиваше в ЧУЖДА буква), а се взима текстът между две числа.
     Скобите и запетаите в записи като „Вазов, И.“ отпадат при keyOf().

     Отрязва се до 30 знака и само до най-близкия НОВ РЕД, защото редът е това,
     което държи буквосъчетанието и числото му заедно: при „буквосъчетание,
     после число“ важи краят на парчето, а при обратната подредба — началото му.
     Това е и предпазителят срещу тихо разместване — същият файл, прочетен
     наопаки, иначе събира всяко число с буквосъчетанието от СЛЕДВАЩИЯ ред и
     цялата таблица излиза сгрешена, без нищо да изглежда счупено. */
  const CHUNK = 30;
  const out = [];
  const re = digitsFirst ? /(\d{1,3})(?!\d)([^\d]{1,30})/g : /([^\d]{1,30})(\d{1,3})(?!\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const chunk = digitsFirst ? m[2] : m[1];
    const mark = digitsFirst ? m[1] : m[2];
    const oneLine = digitsFirst ? chunk.split('\n')[0] : chunk.split('\n').pop();
    const prefix = rowKeyOf(oneLine.slice(-CHUNK));
    if (!prefix || !mark) continue;
    out.push([prefix, mark]);
    if (digitsFirst) re.lastIndex = m.index + m[1].length;   // текстът може да е и на следващата двойка
  }
  return out;
}
/* Пресяване по буква: подрежда, маха повторенията и оставя най-дългата редица,
   в която числата не намаляват. Връща приетите редове и броя отпаднали. */
/* Ред за КОНКРЕТЕН автор: две части — фамилия и инициал или второ име („Вазов,
   И.“, „Елин Пелин“). По форма толкова, колкото може да се каже; дали числото
   наистина е от тази буква, се проверява после (виж siftPairs), защото такъв ред
   минава ПОКРАЙ пресяването и иначе всяко заглавие от страницата („Авторски
   таблици“ с номера на страницата до него) би влязло в таблицата като ред. */
function isNamed(prefix) {
  const parts = String(prefix).split(SEP_MARK);
  return parts.length === 2 &&
    parts[0].length >= 3 && parts[0].length <= 14 &&
    parts[1].length >= 1 && parts[1].length <= 14;
}
function siftPairs(pairs) {
  const byLetter = new Map();
  const named = [];
  const seenNamed = new Set();
  for (const [prefix, mark] of pairs) {
    const letter = prefix.charAt(0);
    if (BG_LETTERS.indexOf(letter) < 0) continue;
    /* Редовете за КОНКРЕТЕН автор („Димитров, Г. 58“) стоят в печатната таблица
       там, където е човекът, а не по азбучен ред на целия низ — между „Диме 57“
       и „Дими 59“. Затова те не минават през проверката за растящи числа: иначе
       всеки такъв ред изглежда като нарушение и се изхвърля като шум. */
    if (prefix.indexOf(SEP_MARK) >= 0) {
      if (!isNamed(prefix)) continue;              // изречение от страницата, не ред
      if (!seenNamed.has(prefix)) { seenNamed.add(prefix); named.push({ prefix, mark }); }
      continue;
    }
    if (!byLetter.has(letter)) byLetter.set(letter, new Map());
    const m = byLetter.get(letter);
    if (!m.has(prefix)) m.set(prefix, mark);       // първото срещане печели
  }
  const rows = [];
  let dropped = 0;
  for (const letter of [...byLetter.keys()].sort()) {
    const list = [...byLetter.get(letter).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // Най-дълга подредица с ненамаляващи числа (класическо решение с O(n²) —
    // при няколкостотин реда на буква е мигновено и се чете).
    const n = list.length, len = new Array(n).fill(1), prev = new Array(n).fill(-1);
    let best = -1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        if (parseInt(list[j][1], 10) <= parseInt(list[i][1], 10) && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
      }
      if (best < 0 || len[i] > len[best]) best = i;
    }
    const keep = [];
    for (let i = best; i >= 0; i = prev[i]) keep.push(list[i]);
    keep.reverse();
    dropped += n - keep.length;
    for (const [prefix, mark] of keep) rows.push({ prefix, mark });
  }
  /* Редът за конкретен автор се приема само ако числото му е в обхвата на
     буквата: „Елин Пелин 53“ е ред от буква Е, а „Авторски таблици 1“ (заглавие
     със страницата до него) не е — единицата стои далеч под числата на буква А.
     Това е и последната преграда пред текста на самата страница, защото по
     форма („две думи“) той не се различава от псевдоним. */
  const span = new Map();
  for (const r of rows) {
    const L = r.prefix.charAt(0), n = parseInt(r.mark, 10);
    const s = span.get(L);
    if (!s) span.set(L, { lo: n, hi: n });
    else { if (n < s.lo) s.lo = n; if (n > s.hi) s.hi = n; }
  }
  for (const r of named) {
    const s = span.get(r.prefix.charAt(0));
    const n = parseInt(r.mark, 10);
    if (s && n >= s.lo && n <= s.hi) rows.push(r);
  }
  rows.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  return { rows, dropped };
}
function parseTable(text) {
  const plain = String(text || '').replace(/<[^>]*>/g, ' ');   // без етикетите на HTML
  const candidates = [
    { rows: siftPairs(extractPairs(plain, false)), how: 'буквосъчетание, после число' },
    { rows: siftPairs(extractPairs(plain, true)), how: 'число, после буквосъчетание', digitsFirst: true },
    // Записана страница може да държи данните вътре в скрипт — тогава махането
    // на етикетите не помага и се пробва целият файл, както си е.
    { rows: siftPairs(extractPairs(String(text || ''), false)), how: 'буквосъчетание, после число (целият файл)' }
  ];
  /* При равен резултат печели „буквосъчетание, после число“ — обичайната
     подредба. Обърнатото четене се избира само ако наистина дава повече редове
     (таблици, напечатани с числото отпред). */
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    const more = c.rows.rows.length - best.rows.rows.length;
    // Обърнатото четене трябва да ДОКАЖЕ, че е по-добро; при равен брой редове
    // остава обичайната подредба. Иначе същият файл, прочетен наопаки, минава за
    // еднакво добър и цялата таблица излиза разместена с един ред.
    if (more > 0 || (more === 0 && best.digitsFirst && !c.digitsFirst)) best = c;
  }
  return { rows: best.rows.rows, dropped: best.rows.dropped, how: best.how };
}

/* Търсене по правилото на таблиците: взима се редът с НАЙ-ГОЛЯМОТО
   буквосъчетание, което не надминава фамилията („ВАЗОВ“ → редът „ВАЗ“, а ако
   „ВАЗ“ го няма — най-близкият преди него). Търси се само вътре в буквата на
   фамилията: знакът винаги започва с нея. */
function lookup(rows, key) {
  if (!key) return null;
  const letter = key.charAt(0);
  /* Редовете за конкретен автор нарочно НЕ участват в търсенето: „Димитров, Г.“
     е за Георги Димитров, а не за всеки Димитров. Показват се отделно (виж
     refinements) и човекът решава. */
  const same = rows.filter(r => r.prefix.charAt(0) === letter && !isNamed(r.prefix));
  if (!same.length) return null;
  let hit = null;
  for (const r of same) { if (r.prefix <= key) { if (!hit || r.prefix > hit.prefix) hit = r; } }
  return hit || same.reduce((a, b) => (a.prefix < b.prefix ? a : b));
}
/* По-точните редове, които ПРОДЪЛЖАВАТ фамилията („ВАЗОВ“ → „Вазов, И.“). Не се
   ползват сами: знакът по правило е по фамилията, а прибавянето на инициала към
   ключа обръща подредбата (мъж „Иванов, П.“ би паднал на реда за „Иванова“).
   Затова само се ПОКАЗВАТ до предложението, за да реши човекът. */
function refinements(rows, key, limit) {
  if (!key) return [];
  return rows.filter(r => isNamed(r.prefix) && r.prefix.replace(new RegExp(SEP_MARK, 'g'), '').startsWith(key))
    .slice(0, limit == null ? 3 : limit);
}
/* „В“ + „15“ → „В-15“. Разделителят се ИЗВЕЖДА от вече въведените знаци на тази
   библиотека, вместо да се налага: една пише „В 15“, друга „В-15“, трета „В15“,
   и програмата няма право да размесва фонда. */
function formatMark(letter, mark, sep) {
  return letter + (sep == null ? '-' : sep) + mark;
}
function detectSeparator(values) {
  const count = { '-': 0, ' ': 0, '': 0 };
  for (const v of values) {
    const m = /^\s*[А-Я]\s*([-–—]?)\s*\d/.exec(String(v || ''));
    if (!m) continue;
    if (m[1]) count['-']++;
    else if (/^\s*[А-Я]\s+\d/.test(String(v))) count[' ']++;
    else count['']++;
  }
  const top = Object.keys(count).reduce((a, b) => (count[b] > count[a] ? b : a), '-');
  return count[top] ? top : null;
}

module.exports = function registerAuthorMarkHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, dialog, getMainWindow, fs, path, importers } = deps;

  const rowsOf = (db) => db.prepare('SELECT prefix, mark FROM author_table ORDER BY prefix').all();
  /* Разделителят се извежда от авторския знак, а където той е празен — от
     сигнатурата след последната наклонена черта („886.7/Г 13“). Заварените бази
     често имат само сигнатура. */
  function separatorOf(db) {
    const marks = db.prepare("SELECT author_mark AS v FROM books WHERE author_mark IS NOT NULL AND TRIM(author_mark) <> '' LIMIT 500").all().map(r => r.v);
    const s1 = detectSeparator(marks);
    if (s1 !== null) return s1;
    const cns = db.prepare("SELECT call_number AS v FROM books WHERE call_number IS NOT NULL AND TRIM(call_number) <> '' LIMIT 500").all()
      .map(r => String(r.v).split('/').pop());
    const s2 = detectSeparator(cns);
    return s2 === null ? '-' : s2;
  }
  function suggestFor(db, book, rows, sep) {
    const b = basisOf(book);
    if (!b || !b.basis) return { ok: false, reason: 'няма нито автор, нито заглавие' };
    const key = keyOf(b.basis);
    if (!key) return { ok: false, reason: 'фамилията не е на кирилица' };
    const hit = lookup(rows, key);
    if (!hit) return { ok: false, reason: 'в таблицата няма нито един ред за буквата „' + key.charAt(0) + '“' };
    /* Когато името е без запетая, фамилията е ДОГАДКА (взима се последната дума)
       и може изобщо да не е фамилия: „Елин Пелин“ е псевдоним и се подписва цял.
       Затова се гледа и първата дума — ако таблицата има ред точно за такъв
       автор („Елин Пелин 53“), той се показва до предложението. */
    const keys = [key];
    if (!b.exact) {
      const first = keyOf(String(b.basisFull || '').split(/\s+/)[0] || '');
      if (first && first !== key) keys.push(first);
    }
    const refine = [];
    for (const k of keys) for (const r of refinements(rows, k)) {
      refine.push({ prefix: prefixLabel(r.prefix), mark: formatMark(r.prefix.charAt(0), r.mark, sep) });
    }
    return {
      ok: true, mark: formatMark(key.charAt(0), hit.mark, sep),
      basis: b.basis, from: b.from, exact: b.exact,
      prefix: prefixLabel(hit.prefix), num: hit.mark,
      refine: refine.slice(0, 3)
    };
  }

  /* Състояние на таблицата — за екрана в „Настройки“. */
  ipcMain.handle('authorMark:status', () => run(() => {
    const db = getDb();
    const rows = rowsOf(db);
    const letters = [...new Set(rows.map(r => r.prefix.charAt(0)))];
    const sep = separatorOf(db);
    return {
      rows: rows.length, letters: letters.length, separator: sep,
      example: rows.length ? (suggestFor(db, { author: 'Вазов, Иван' }, rows, sep) || null) : null,
      sample: rows.slice(0, 8).map(r => ({ prefix: prefixLabel(r.prefix), mark: r.mark }))
    };
  }));

  /* Внасяне: изборът на файл, разчитането и ПРЕГЛЕДЪТ са отделени от записа.
     Прегледът се пази тук, а не се разнася до екрана и обратно — иначе хиляда
     реда пътуват два пъти без нужда. */
  let pending = null;
  ipcMain.handle('authorMark:choose', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Изберете файла с таблицата за авторски знак',
        properties: ['openFile'],
        filters: [
          { name: 'Таблица', extensions: ['docx', 'odt', 'xlsx', 'csv', 'tsv', 'txt', 'html', 'htm'] },
          { name: 'Всички файлове', extensions: ['*'] }
        ]
      });
      if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
      const file = filePaths[0];
      const ext = path.extname(file).toLowerCase();
      const text = readTableText(file, { fs, path, importers });
      const parsed = parseTable(text);
      if (parsed.rows.length < 50) {
        return { ok: false, error: 'В „' + path.basename(file) + '“ се разчетоха само '
          + parsed.rows.length + ' реда — това не прилича на таблица за авторски знак.'
          + (IMPORT_EXTENSIONS.includes(ext) ? '' : ' Файлът е с разширение ' + (ext || 'без разширение') + '.')
          + ' Най-сигурно се разчита обикновен текст или CSV с по един ред „буквосъчетание, число“.' };
      }
      const letters = [...new Set(parsed.rows.map(r => r.prefix.charAt(0)))];
      pending = parsed.rows;
      return { ok: true, data: {
        file: path.basename(file), rows: parsed.rows.length, letters: letters.length,
        dropped: parsed.dropped, how: parsed.how,
        /* За окото: по няколко реда от три различни букви — библиотекарката
           сверява с печатното издание, преди да запише. */
        sample: sampleRows(parsed.rows)
      } };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  function sampleRows(rows) {
    const out = [];
    const letters = [...new Set(rows.map(r => r.prefix.charAt(0)))];
    for (const L of [letters[0], letters[Math.floor(letters.length / 2)], letters[letters.length - 1]]) {
      if (!L) continue;
      const some = rows.filter(r => r.prefix.charAt(0) === L);
      // Наяве се показва четимият надпис („ВАЗОВ, И“), не вътрешният ключ.
      out.push(...some.slice(0, 4).map(r => ({ prefix: prefixLabel(r.prefix), mark: r.mark })));
    }
    return out;
  }
  ipcMain.handle('authorMark:confirm', () => run(() => {
    if (!pending || !pending.length) throw new Error('Няма разчетена таблица за записване — изберете файла наново.');
    const db = getDb();
    const ins = db.prepare('INSERT OR REPLACE INTO author_table (prefix, mark) VALUES (?, ?)');
    const rows = pending;
    db.transaction(() => { db.prepare('DELETE FROM author_table').run(); rows.forEach(r => ins.run(r.prefix, r.mark)); }).immediate();
    pending = null;
    logAudit('Таблица за авторски знак', 'внесена — ' + rows.length + ' реда');
    return { rows: rows.length };
  }));
  ipcMain.handle('authorMark:clear', () => run(() => {
    const db = getDb();
    const n = db.prepare('SELECT COUNT(*) AS n FROM author_table').get().n;
    db.prepare('DELETE FROM author_table').run();
    pending = null;
    logAudit('Таблица за авторски знак', 'изтрита (' + n + ' реда)');
    return n;
  }));

  /* Предложение за ЕДИН документ — това стои зад копчето „Предложи“ във формата.
     Връща и откъде идва знакът, за да може екранът да го покаже. */
  ipcMain.handle('authorMark:suggest', (e, book) => run(() => {
    const db = getDb();
    const rows = rowsOf(db);
    if (!rows.length) throw new Error('Няма внесена таблица за авторски знак. Настройки → Фонд → „Авторски знак“.');
    return suggestFor(db, book || {}, rows, separatorOf(db));
  }));

  /* Проверка на заварените знаци: буквата на знака трябва да е буквата на
     фамилията. Несъответствието е или грешка при въвеждане, или книга,
     подписана по друго (по лицето, за което е) — програмата не гадае кое от
     двете, само посочва. */
  ipcMain.handle('authorMark:audit', () => run(() => {
    const db = getDb();
    const books = db.prepare(`SELECT id, inv_number, author, title, author_mark
      FROM books WHERE status IS NULL OR status <> 'отчислен'`).all();
    const mismatched = [], missing = [];
    for (const b of books) {
      const mark = String(b.author_mark || '').trim();
      const basis = basisOf(b);
      const key = basis ? keyOf(basis.basis) : '';
      if (!mark) { if (key) missing.push(b); continue; }
      /* Главна и малка буква (проверка при прегледа): полето е свободен текст,
         без насилствено главни букви при запис — „в-15“ е също толкова валиден
         ръчен запис, колкото „В-15“. С /[А-Я]/ (само главни) такъв ред минаваше
         покрай проверката мълчаливо — нито в mismatched (markLetter излизаше
         null), нито в missing (mark не е празен). */
      const markLetter = ((mark.match(/[А-Яа-я]/) || [''])[0] || '').toUpperCase();
      if (!markLetter || !key) continue;
      if (markLetter !== key.charAt(0)) mismatched.push({ ...b, expected: key.charAt(0), basis: basis.basis });
    }
    return { total: books.length, mismatched: mismatched.slice(0, 200), mismatchedTotal: mismatched.length,
      missingTotal: missing.length };
  }));

  /* Групово попълване — само на ПРАЗНИ знаци и само с изричен преглед преди
     записа. Вече попълнен знак не се пипа: заварените знаци са решение на
     библиотекар и програмата няма право да ги презаписва наум. */
  ipcMain.handle('authorMark:fillPreview', () => run(() => {
    const db = getDb();
    const rows = rowsOf(db);
    if (!rows.length) throw new Error('Няма внесена таблица за авторски знак.');
    const sep = separatorOf(db);
    const books = db.prepare(`SELECT id, inv_number, author, title FROM books
      WHERE (author_mark IS NULL OR TRIM(author_mark) = '') AND (status IS NULL OR status <> 'отчислен')
      ORDER BY inv_number`).all();
    const will = [], skip = [];
    for (const b of books) {
      const s = suggestFor(db, b, rows, sep);
      if (s.ok) will.push({ id: b.id, inv_number: b.inv_number, author: b.author, title: b.title, mark: s.mark, basis: s.basis, from: s.from, exact: s.exact });
      else skip.push({ id: b.id, inv_number: b.inv_number, author: b.author, title: b.title, reason: s.reason });
    }
    return { willTotal: will.length, skipTotal: skip.length, will: will.slice(0, 200), skip: skip.slice(0, 50) };
  }));
  ipcMain.handle('authorMark:fillApply', () => run(() => {
    const db = getDb();
    const rows = rowsOf(db);
    if (!rows.length) throw new Error('Няма внесена таблица за авторски знак.');
    const sep = separatorOf(db);
    const books = db.prepare(`SELECT id, author, title FROM books
      WHERE (author_mark IS NULL OR TRIM(author_mark) = '') AND (status IS NULL OR status <> 'отчислен')`).all();
    const upd = db.prepare('UPDATE books SET author_mark = ? WHERE id = ? AND (author_mark IS NULL OR TRIM(author_mark) = \'\')');
    let n = 0;
    db.transaction(() => {
      for (const b of books) {
        const s = suggestFor(db, b, rows, sep);
        if (s.ok) { upd.run(s.mark, b.id); n++; }
      }
    }).immediate();
    logAudit('Авторски знак', 'групово попълнени ' + n + (n === 1 ? ' празен знак' : ' празни знака') + ' по таблицата');
    return n;
  }));

  return { basisOf, keyOf, parseTable, lookup, formatMark, detectSeparator, decodeCp1251, decodeFile, BG_LETTERS };
};
/* Чистите функции се излагат и без регистрация на канали — тестовете ги ползват
   направо, без база и без Electron. */
module.exports.pure = { basisOf, keyOf, rowKeyOf, prefixLabel, refinements, isNamed, parseTable, lookup, formatMark,
  detectSeparator, decodeCp1251, decodeFile, siftPairs, extractPairs, readTableText, docxText };
