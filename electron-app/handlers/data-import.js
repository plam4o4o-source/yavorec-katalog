// Приемане на данни от други системи — извадено от main.js в отделен модул
// (Фаза 4, стъпка 36). Цел: читалище с изоставена стара база (АБ, iLib, чужд
// Excel) да мине на тази програма без преписване на ръка.
// IMPORT_CACHE (прочетеният файл между прегледа и внасянето) е module-scope
// състояние тук — не е нужно да излиза навън, ползва се само вътре в тези
// три handler-а.
module.exports = function registerDataImportHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, dialog, getMainWindow, fs, path, BOOK_FIELDS, today, cnSortKey } = deps;
  const importers = require('../importers');
  const { ENUM_COLUMNS } = require('../db/enum-triggers');
  /* Позволените стойности се четат от същия списък, който създава тригерите — така
     двата не могат да се разминат при бъдеща промяна. */
  const BOOK_STATUSES = (ENUM_COLUMNS.find(c => c.table === 'books' && c.col === 'status') || {}).values || [];

  const IMPORT_FIELDS = {
    inv_number: 'Инвентарен №', title: 'Заглавие', subtitle: 'Подзаглавие', author: 'Автор',
    publisher: 'Издателство', city: 'Място на издаване', year: 'Година', isbn: 'ISBN / ISSN',
    pages: 'Страници', language: 'Език', udk: 'УДК', call_number: 'Сигнатура',
    author_mark: 'Авторски знак', keywords: 'Ключови думи', annotation: 'Анотация',
    price: 'Цена', department: 'Отдел', category_name: 'Вид документ', status: 'Състояние',
    volume: 'Том / част', barcode: 'Баркод', register_date: 'Дата на вписване',
    description: 'Забележка'
  };
  let IMPORT_CACHE = null; // прочетеният файл се пази между прегледа и внасянето

  // Разчита файла и подготвя прегледа. Ползва се и от диалога за избор, и когато
  // файлът е провлачен върху прозореца на програмата.
  function loadImportFile(filePath) {
    const t = importers.readTable(filePath);
    if (!t.rows.length) throw new Error('Файлът е празен или не се разчита като таблица.');
    const headers = t.rows[0].map(h => String(h || '').trim());
    const body = t.rows.slice(1);
    IMPORT_CACHE = { path: filePath, headers, body };
    return {
      path: filePath, encoding: t.encoding, delimiter: t.delimiter,
      headers, mapping: importers.guessMapping(headers),
      preview: body.slice(0, 8), total: body.length, fields: IMPORT_FIELDS
    };
  }
  ipcMain.handle('import:load', (e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Файлът не е намерен.' };
      return { ok: true, data: loadImportFile(filePath) };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('import:choose', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Изберете файл за внасяне (износ от друга библиотечна система)',
        properties: ['openFile'],
        filters: [
          { name: 'Таблици', extensions: ['csv', 'txt', 'tsv', 'xlsx'] },
          { name: 'Всички файлове', extensions: ['*'] }
        ]
      });
      if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
      return { ok: true, data: loadImportFile(filePaths[0]) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // Числата в стари износи идват с интервали за хилядни и със запетая за десетичен знак.
  function parseNum(v) {
    const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }
  function parseIntOrNull(v) {
    const s = String(v ?? '').replace(/[^\d]/g, '');
    return s ? parseInt(s, 10) : null;
  }
  // Дати в износите са в най-различен вид; приемат се трите обичайни, иначе полето
  // се оставя празно, вместо да се запише безсмислица.
  function parseDate(v) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
    if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    return null;
  }
  ipcMain.handle('import:run', (e, { mapping, options }) => {
    try {
      const db = getDb();
      if (!IMPORT_CACHE) return { ok: false, error: 'Първо изберете файл.' };
      const opt = options || {};
      const cols = {};
      for (const [idx, field] of Object.entries(mapping || {})) if (field) cols[field] = Number(idx);
      if (cols.title == null) return { ok: false, error: 'Задължително е да посочите коя колона е „Заглавие“.' };

      const cats = new Map(db.prepare('SELECT id, name FROM categories').all().map(c => [c.name.toLowerCase(), c.id]));
      const insertCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
      const existingInv = new Set(db.prepare('SELECT inv_number FROM books WHERE inv_number IS NOT NULL')
        .all().map(r => String(r.inv_number)));
      const existingIsbn = new Set(db.prepare("SELECT isbn FROM books WHERE isbn IS NOT NULL AND isbn <> ''")
        .all().map(r => String(r.isbn).replace(/[^0-9Xx]/g, '')));
      // Трета проверка за дубликат: ред без инвентарен номер и без ISBN не може да се
      // разпознае по нищо друго освен по заглавие и автор. Без нея повторното внасяне
      // на същия файл удвоява точно тези редове.
      const titleKey = (t, a) => (String(t || '') + '|' + String(a || '')).toLowerCase().replace(/\s+/g, ' ').trim();
      const existingTitles = new Set(db.prepare('SELECT title, author FROM books').all()
        .map(r => titleKey(r.title, r.author)));

      const report = { added: 0, skipped: 0, errors: [], usedInv: [] };
      const cell = (row, field) => cols[field] == null ? '' : String(row[cols[field]] ?? '').trim();

      const tx = db.transaction(() => {
        let nextInv = (db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get() || {}).next_inv_number || 1;
        IMPORT_CACHE.body.forEach((row, i) => {
          const lineNo = i + 2; // +1 за заглавния ред, +1 за човешко броене
          try {
            const title = cell(row, 'title');
            if (!title) { report.skipped++; return; }

            let inv = parseIntOrNull(cell(row, 'inv_number'));
            const isbnRaw = cell(row, 'isbn');
            const isbnKey = isbnRaw.replace(/[^0-9Xx]/g, '');

            const author = cell(row, 'author');
            if (opt.skipDuplicates) {
              if (inv != null && existingInv.has(String(inv))) { report.skipped++; return; }
              if (!inv && isbnKey && existingIsbn.has(isbnKey)) { report.skipped++; return; }
              if (!inv && !isbnKey && existingTitles.has(titleKey(title, author))) { report.skipped++; return; }
            }
            existingTitles.add(titleKey(title, author));
            // Зает или липсващ инвентарен номер: дава се следващият свободен, за да
            // не се губи записът и да не се чупи уникалността в инвентарната книга.
            if (inv == null || existingInv.has(String(inv))) {
              while (existingInv.has(String(nextInv))) nextInv++;
              inv = nextInv;
              report.usedInv.push({ line: lineNo, inv });
            }
            existingInv.add(String(inv));
            if (isbnKey) existingIsbn.add(isbnKey);

            let categoryId = null;
            const catName = cell(row, 'category_name') || opt.defaultCategory || '';
            if (catName) {
              const key = catName.toLowerCase();
              if (!cats.has(key)) cats.set(key, insertCat.run(catName).lastInsertRowid);
              categoryId = cats.get(key);
            }
            const callNumber = cell(row, 'call_number') || null;
            /* Колона „Състояние“ в наследени таблици почти винаги описва ФИЗИЧЕСКОТО
               състояние на екземпляра („добро“, „скъсана корица“, „пожълтяла“), а не
               статуса по смисъла на програмата. Тригерът за изброими стойности допуска
               само четирите статуса, затова такъв файл се проваляше на ВСЕКИ ред и
               вносът връщаше нула добавени — при иначе напълно годни данни. Сега нито
               редът, нито информацията се губят: статусът пада към „наличен“, а
               оригиналният текст се дописва към забележката. */
            const rawStatus = String(cell(row, 'status') || '').trim();
            const knownStatus = BOOK_STATUSES.includes(rawStatus);
            const noteParts = [
              cell(row, 'description') || null,
              (rawStatus && !knownStatus) ? 'Състояние: ' + rawStatus : null
            ].filter(Boolean);
            if (rawStatus && !knownStatus) report.statusToNote = (report.statusToNote || 0) + 1;
            const payload = {
              inv_number: inv,
              barcode: cell(row, 'barcode') || String(inv),
              register_date: parseDate(cell(row, 'register_date')) || new Date().toISOString().slice(0, 10),
              title,
              subtitle: cell(row, 'subtitle') || null,
              author: author || null,
              category_id: categoryId,
              year: cell(row, 'year') || null,
              volume: cell(row, 'volume') || null,
              isbn: isbnRaw || null,
              pages: cell(row, 'pages') || null,
              language: cell(row, 'language') || opt.defaultLanguage || null,
              udk: cell(row, 'udk') || null,
              call_number: callNumber,
              author_mark: cell(row, 'author_mark') || null,
              city: cell(row, 'city') || null,
              publisher: cell(row, 'publisher') || null,
              keywords: cell(row, 'keywords') || null,
              annotation: cell(row, 'annotation') || null,
              cover_url: null,
              department: cell(row, 'department') || opt.defaultDepartment || 'за възрастни',
              // BUG FIX (виж CHANGELOG v1.59.0): тези три полета липсваха тук, макар
              // да са част от BOOK_FIELDS — better-sqlite3 хвърляше "Missing named
              // parameter" за ВСЕКИ ред при всеки внос и вносът не работеше изобщо.
              // Стойностите огледват bookPayload() в handlers/books.js за нов запис
              // (prev == null там): permanent_location е незадължително поле, празно
              // при внос, ако не идва от файла; status_date е днешна дата (нов запис);
              // cn_sort се смята от сигнатурата, ако е налична.
              permanent_location: null,
              status: knownStatus ? rawStatus : 'наличен',
              status_date: today(),
              price: parseNum(cell(row, 'price')),
              description: noteParts.length ? noteParts.join(' · ') : null,
              acquisition_id: null,
              cn_sort: callNumber ? cnSortKey(callNumber) : null
            };
            const info = db.prepare(`INSERT INTO books (${BOOK_FIELDS.join(',')})
              VALUES (${BOOK_FIELDS.map(f => '@' + f).join(',')})`).run(payload);
            db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(info.lastInsertRowid);
            if (inv >= nextInv) nextInv = inv + 1;
            report.added++;
          } catch (err) {
            // Грешката на един ред не бива да проваля целия внос — събира се и се
            // показва накрая, а останалите редове продължават.
            if (report.errors.length < 100) report.errors.push({ line: lineNo, error: err.message });
            report.skipped++;
          }
        });
        db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(nextInv);
      });
      tx();
      logAudit('Внасяне на данни', `${report.added} документа от ${path.basename(IMPORT_CACHE.path)}` +
        (report.skipped ? `, пропуснати ${report.skipped}` : ''));
      return { ok: true, data: report };
    } catch (err) { return { ok: false, error: err.message }; }
  });
};
