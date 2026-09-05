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
    description: 'Забележка', series: 'Поредица', series_no: '№ в поредицата'
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
      // BUG FIX (одит #11): предупреждение за незатворена кавичка или подозрителен
      // брой колони спрямо заглавния ред (виж importers.js) — подадено чак дотук,
      // за да може бъдещ екран на прегледа да го покаже; засега не спира внасянето.
      warning: t.warning || null,
      headers, mapping: importers.guessMapping(headers),
      preview: body.slice(0, 8), total: body.length, fields: IMPORT_FIELDS
    };
  }
  /* Пътят идва от екранния слой (влачене и пускане на файл върху прозореца, виж
     importData.pathOf в preload.js). Одит v2.4.14: приемаше се КОЙТО И ДА Е
     абсолютен път и се връщаха заглавният ред и първите 8 реда — тоест канал, по
     който съдържанието на произволен файл от компютъра излиза в екранния слой.
     handlers/backup.js вече беше разпознал същия проблем и го затвори със списък
     от пътища, раздадени от самия диалог; тук диалогът е само единият източник,
     затова се допълва с проверка на разширението: файловете за внасяне са
     таблици, а библиотечната база и config.json не са.
     Днес това не е достижимо отвън (екранният слой е самата програма) — има
     значение като стъпка за ескалация, ако някога бъде намерена дупка в него. */
  const dialogApprovedImports = new Set();
  const IMPORT_EXTENSIONS = ['.csv', '.txt', '.tsv', '.xlsx'];
  function importSourceAllowed(filePath) {
    if (dialogApprovedImports.has(path.resolve(filePath))) return true;
    return IMPORT_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
  }
  ipcMain.handle('import:load', (e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Файлът не е намерен.' };
      if (!importSourceAllowed(filePath)) {
        return { ok: false, error: 'За внасяне се приемат само таблици: ' + IMPORT_EXTENSIONS.join(', ')
          + '. Изберете файла през бутона „Избери файл“, ако е с друго разширение.' };
      }
      return { ok: true, data: loadImportFile(filePath) };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('import:choose', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Изберете файл за въвеждане (извеждане от друга библиотечна система)',
        properties: ['openFile'],
        filters: [
          { name: 'Таблици', extensions: ['csv', 'txt', 'tsv', 'xlsx'] },
          { name: 'Всички файлове', extensions: ['*'] }
        ]
      });
      if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
      // Изрично избран от човека през диалога — минава независимо от разширението
      // (филтърът „Всички файлове“ по-горе е нарочен: стари износи идват и с .dat).
      dialogApprovedImports.add(path.resolve(filePaths[0]));
      return { ok: true, data: loadImportFile(filePaths[0]) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // Числата в стари износи идват с интервали за хилядни и със запетая за десетичен знак.
  function parseNum(v) {
    const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }
  // BUG FIX (одит #4): по-рано тук се махаха ВСИЧКИ недигитни знаци с
  // .replace(/[^\d]/g,''), което тихо поврежда стойността, вместо да я отхвърли:
  // "5.0" (обичаен Excel числов формат) → 50, "12,50" → 1250, "-5" → 5 (знакът за
  // минус изчезва мълчаливо и може да се сблъска със съществуващ положителен
  // инвентарен номер). Сега стойността се парсва като истинско число и се приема
  // САМО ако е цяло положително — иначе връща null, за да не влезе грешна стойност
  // в базата без предупреждение (извикващият код по-долу пише ясно предупреждение
  // на български за такъв ред вместо да го приема тихо).
  function parseIntOrNull(v) {
    const raw = v == null ? '' : String(v).trim();
    if (!raw) return null;
    const normalized = raw.replace(/\s/g, '').replace(',', '.');
    const n = Number(normalized);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
    return n;
  }
  // Горна граница на инвентарния номер (одит #1): Приложение № 4 предвижда
  // разумен, ограничен диапазон за инвентарната книга на едно читалище — число
  // над това по-скоро е повреден внос (или зловреден файл) отколкото истински
  // номер. Границата е ключова защита срещу безкрайния цикъл по-долу: JS числата
  // губят точност над 2^53 (9007199254740992+1 === 9007199254740992), затова
  // такова число, оставено непроверено, може да залепи nextInv завинаги на едно
  // и също място и while цикълът, търсещ свободен номер, никога да не свърши —
  // handler-ът е синхронен, значи цялата програма замръзва.
  const MAX_INV_NUMBER = 99999999;
  // Твърд таван на итерациите на търсенето за свободен номер — предпазна мрежа в
  // случай, че диапазонната проверка някак се заобиколи (напр. бъдеща промяна).
  // 10 милиона итерации на Set.has() отнемат части от секундата, но никога не се
  // случва при нормална употреба — инвентарната книга просто не достига такъв обем.
  const MAX_INV_SEARCH_ITERATIONS = 10000000;
  // Excel-ов сериен номер на дата: дни от 1899-12-30 (епохата на Excel, с нарочния
  // "1900 е високосна" бъг вграден в самата формула — затова епохата е 30-и, не
  // 31-ви декември 1899). Диапазонът 367..73050 покрива приблизително 1901-01-01
  // до 2099-12-31 - извън него по-вероятно е случайно число, отколкото истинска
  // дата, затова не се прави опит да се гадае.
  function excelSerialToDateStr(serial) {
    const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
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
    // BUG FIX (одит #7): истинска дата в Excel клетка, изнесена/съхранена като
    // чисто число (напр. суров "45000" вместо "15.03.2023"), не се разпознаваше
    // от нито един от горните образци и register_date тихо падаше на днешна дата
    // — макар датата на постъпване да е задължително поле по Приложение № 4.
    if (/^\d+(\.\d+)?$/.test(s)) {
      const serial = Math.trunc(Number(s));
      /* Одит v2.4.14: прозорецът [367, 73050] съдържа и всяка четирицифрена
         ГОДИНА. Клетка, в която библиотекарят е написал само „1998“ — най-
         обичайното нещо в стар опис — се тълкуваше като сериен номер на Excel и
         влизаше в инвентарната книга като 1905-06-21. Годината се разпознава
         ПЪРВА и се чете като 1 януари: по-полезно е приблизително вярната
         година, отколкото точно грешен ден през 1905 г. Горната граница е
         текущата година + 1 (издания „с година напред“ съществуват). */
      const nowY = new Date().getFullYear();
      if (serial >= 1900 && serial <= nowY + 1) return `${serial}-01-01`;
      if (serial >= 367 && serial <= 73050) {
        const ds = excelSerialToDateStr(serial);
        if (ds) return ds;
      }
    }
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

      const report = { added: 0, skipped: 0, errors: [], usedInv: [], warnings: [] };
      const cell = (row, field) => cols[field] == null ? '' : String(row[cols[field]] ?? '').trim();

      /* Одит v2.4.29: лимитът от „Настройки“ → „Ограничения“ (checkRecordLimit в
         handlers/books.js) важеше за „+ Нова книга“, но не и за вноса — 4 000 реда
         влизаха при лимит 2 000 и после НИКОЙ нов документ не можеше да се добави.
         Свободните места се смятат веднъж, преди транзакцията; редовете над тях
         се пропускат с изрично предупреждение, а не мълчаливо. */
      const limitRow = db.prepare('SELECT limit_books FROM settings WHERE id = 1').get() || {};
      const limitBooks = parseInt(limitRow.limit_books, 10) || 0;
      let free = limitBooks > 0 ? Math.max(0, limitBooks - db.prepare('SELECT COUNT(*) AS n FROM books').get().n) : Infinity;
      let overLimit = 0;
      const tx = db.transaction(() => {
        let nextInv = (db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get() || {}).next_inv_number || 1;
        IMPORT_CACHE.body.forEach((row, i) => {
          const lineNo = i + 2; // +1 за заглавния ред, +1 за човешко броене
          try {
            const title = cell(row, 'title');
            if (!title) { report.skipped++; return; }

            const invRaw = cell(row, 'inv_number');
            let inv = parseIntOrNull(invRaw);
            // BUG FIX (одит #4): клетката не е празна, но не съдържа валиден цял
            // положителен инвентарен номер ("5.0" не се бърка с "50", "12,50" не се
            // бърка с "1250", знакът на "-5" не изчезва тихо — виж parseIntOrNull
            // по-горе). Редът не се губи — получава автоматично следващия свободен
            // номер по-долу — но библиотекарят вижда изрично предупреждение защо.
            if (inv == null && invRaw) {
              report.warnings.push(`ред ${lineNo}: инвентарен номер „${invRaw}“ не е разпознат като цяло `
                + 'положително число и беше заменен с автоматично генериран номер.');
            }
            // BUG FIX (одит #1): номер извън разумния диапазон на инвентарната книга
            // не се приема директно — иначе точно такова число (близо до или над
            // границата на JS число-точност, 2^53) може да закове nextInv и да
            // предизвика безкраен цикъл в търсенето на свободен номер по-долу.
            if (inv != null && (inv > MAX_INV_NUMBER)) {
              report.warnings.push(`ред ${lineNo}: инвентарен номер „${invRaw}“ е извън допустимия диапазон `
                + `(1–${MAX_INV_NUMBER}) и беше заменен с автоматично генериран номер.`);
              inv = null;
            }
            const isbnRaw = cell(row, 'isbn');
            const isbnKey = isbnRaw.replace(/[^0-9Xx]/g, '');

            const author = cell(row, 'author');
            if (opt.skipDuplicates) {
              if (inv != null && existingInv.has(String(inv))) { report.skipped++; return; }
              if (!inv && isbnKey && existingIsbn.has(isbnKey)) { report.skipped++; return; }
              if (!inv && !isbnKey && existingTitles.has(titleKey(title, author))) { report.skipped++; return; }
            }
            if (free <= 0) { overLimit++; report.skipped++; return; } // след дубликатите: те не заемат място
            existingTitles.add(titleKey(title, author));
            // Зает или липсващ инвентарен номер: дава се следващият свободен, за да
            // не се губи записът и да не се чупи уникалността в инвентарната книга.
            if (inv == null || existingInv.has(String(inv))) {
              // BUG FIX (одит #1, ВИСОКА): твърд таван на итерациите като предпазна
              // мрежа — самата причина за реалния безкраен цикъл (число до/над 2^53)
              // вече е отрязана от диапазонната проверка по-горе, но тук се пази
              // допълнителна защита в случай на бъдеща промяна, а не се разчита само
              // на нея. При достигане на тавана редът пада в catch-а по-долу (както
              // всяка друга грешка на ред) с ясно съобщение, вместо да замрази
              // цялата програма.
              let guardIterations = 0;
              while (existingInv.has(String(nextInv))) {
                nextInv++;
                guardIterations++;
                if (nextInv > MAX_INV_NUMBER || guardIterations > MAX_INV_SEARCH_ITERATIONS) {
                  throw new Error('Не е намерен свободен инвентарен номер в допустимия диапазон '
                    + `(1–${MAX_INV_NUMBER}). Инвентарната книга изглежда препълнена или файлът `
                    + 'съдържа повредени/твърде големи номера.');
                }
              }
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
            /* „Отчислен“ НЕ се внася като състояние (одит v2.4.24). Документ напуска
               фонда само с акт по чл. 35, ал. 2 — актът е този, който попълва
               deaccession_act_id и deaccession_date, а всички сборове на фонда
               (КДБФ, годишният отчет, „Движение на фонда“) се водят по ТЯХ.
               Внесен ред със status='отчислен' и без акт е противоречие: таблото и
               инвентарната книга (те гледат status) го изваждаха от фонда, а КДБФ и
               справките (гледат deaccession_date) го броят — 60 отчислени реда от
               стара таблица правеха два различни „библиотечен фонд“ в едно и също
               меню. Текстът не се губи: отива в забележката, точно както при
               непознат статус, и редът се брои отделно в отчета за вноса. */
            const deaccStatus = rawStatus === 'отчислен';
            const knownStatus = !deaccStatus && BOOK_STATUSES.includes(rawStatus);
            const noteParts = [
              cell(row, 'description') || null,
              (rawStatus && !knownStatus) ? 'Състояние: ' + rawStatus : null
            ].filter(Boolean);
            if (deaccStatus) report.deaccessionedToNote = (report.deaccessionedToNote || 0) + 1;
            else if (rawStatus && !knownStatus) report.statusToNote = (report.statusToNote || 0) + 1;
            const payload = {
              inv_number: inv,
              barcode: cell(row, 'barcode') || String(inv),
              // today() от deps, а не собствено new Date(): същият часовник, който
              // ползва status_date по-долу и всеки друг handler. Преди тук стоеше
              // пряко извикване, което заобикаляше инжектирания часовник — заради
              // това тестът за тази стойност беше закован за истинската дата на
              // деня, в който е писан, и целият пакет почервеня на следващия ден.
              register_date: parseDate(cell(row, 'register_date')) || today(),
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
              /* v2.2.0: и series/series_no повториха съвсем същата история — добавени
                 са в BOOK_FIELDS през v1.70.0, но не и тук, затова better-sqlite3
                 хвърляше „Missing named parameter «series»" за ВСЕКИ ред и вносът
                 връщаше „0 добавени, N пропуснати" при всеки файл. Тестът не го хвана,
                 защото преписваше собствено (остаряло) копие на BOOK_FIELDS — вече
                 взима истинското от handlers/books.js, за да не се повтори трети път. */
              series: cell(row, 'series') || null,
              series_no: cell(row, 'series_no') || null,
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
            free--;
          } catch (err) {
            // Грешката на един ред не бива да проваля целия внос — събира се и се
            // показва накрая, а останалите редове продължават.
            if (report.errors.length < 100) report.errors.push({ line: lineNo, error: err.message });
            report.skipped++;
          }
        });
        db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(nextInv);
      });
      tx.immediate();
      if (overLimit) {
        report.warnings.push(`${overLimit} ${overLimit === 1 ? 'ред не беше въведен' : 'реда не бяха въведени'}: достигнат е зададеният лимит от `
          + `${limitBooks} документи във фонда („Настройки“ → „Ограничения“). Увеличете или премахнете лимита и повторете вноса `
          + 'с отметка „Пропускай вече съществуващите“ — въведените редове ще бъдат пропуснати.');
      }
      logAudit('Въвеждане на данни', `${report.added} документа от ${path.basename(IMPORT_CACHE.path)}` +
        (report.skipped ? `, пропуснати ${report.skipped}` : ''));
      return { ok: true, data: report };
    } catch (err) { return { ok: false, error: err.message }; }
  });
};
