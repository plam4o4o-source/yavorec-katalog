// Мобилно сканиране — извадено от main.js в отделен модул (Фаза 4,
// стъпка 36). Вместо RFID: страница (mobile-template.html), която се отваря
// на телефона и ползва камерата като баркод четец. Списъкът се пренася
// обратно като текст или файл и се внася в отворена сесия за инвентаризация.
const { resolveScannedBook } = require('../security-utils');
/* Изгубен документ, намерен при проверката — същото предупреждение като при
   сканиране на компютъра (v2.4.69, находка О3; виж lostCaseOf там). */
const { lostCaseOf } = require('./inventory-sessions');
const { BOOK_STATUS_LOST } = require('../db/enum-triggers');

module.exports = function registerMobileHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, dialog, getMainWindow, fs, path, normalizeScanCode } = deps;
  /* Вносът връща „липсващ“ в „наличен“ — онлайн каталогът трябва да го разбере
     (v2.4.69, находка К2; виж същата бележка в handlers/inventory-sessions.js).
     Незадължителна зависимост: модулът се зарежда и самостоятелно. */
  const scheduleCatalogWrite = deps.scheduleCatalogWrite || (() => {});

  /* Името на библиотеката НЕ се изписва в самата страница (по искане на
     библиотеката, v2.4.46) — нито в лентата, нито в заглавието на раздела.
     Остава единствено в ИМЕТО на файла: на телефона на библиотекаря стоят и
     други файлове, а в един разговор във Вайбър се събират списъци от повече
     от една проверка. Затова оттук в страницата влиза само „слъгът“, и то
     единствено за името на изнесения списък.

     Латиница за името на файла: Windows не приема < > : " / \ | ? *, а кирилица
     в име на файл минава през Вайбър/имейл различно според програмата. */
  const BG2LAT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sht',ъ:'a',ь:'y',ю:'yu',я:'ya' };
  const slug = (v) => String(v || '').toLowerCase()
    .replace(/[а-яё]/g, (ch) => BG2LAT[ch] || '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  ipcMain.handle('mobile:generate', async () => {
    try {
      const s = getDb().prepare('SELECT lib_name, org, place FROM settings WHERE id = 1').get() || {};
      const tpl = fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile-template.html'), 'utf8');
      /* Заместването е с ФУНКЦИЯ, а не с низ: при низ „$&“, „$'“ и „$1“ са
         специални за String.replace. Слъгът е само [a-z0-9-] и не може да ги
         съдържа, но формата остава — тя не зависи от това какво влиза. */
      const base = slug(s.lib_name || s.org || '');
      const html = tpl.replace(/__SLUG__/g, () => base);   // само [a-z0-9-] — влиза в JS низ
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Запишете страницата за сканиране с телефон',
        defaultPath: base ? `inventarizaciya-skener-${base}.html` : 'inventarizaciya-skener.html',
        filters: [{ name: 'HTML страница', extensions: ['html'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      fs.writeFileSync(filePath, html, 'utf8');
      return { ok: true, data: filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // Внасяне на сканираните с телефона номера в отворена сесия за инвентаризация.
  ipcMain.handle('inventorySessions:importScans', /** @param {unknown} e @param {IpcArg<'inventorySessions:importScans'>} arg */ (e, { sessionId, codes }) =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
      if (!s || s.closed) throw new Error('Няма отворена сесия за инвентаризация.');
      // normalizeScanCode() (v1.70.1) — предпазна мярка и тук, за случаите, в
      // които страницата за телефонно сканиране позволи и ръчно въвеждане на
      // номер (виж books:byBarcode в handlers/books.js за пълното обяснение).
      /* ЕДИН РЕД = ЕДИН КОД (v2.4.69, находка О2).
         =================================================================
         КАКВО СТАВАШЕ. Екранът делеше поставения текст по интервали и запетаи
         (split(/[\s,;]+/)). Телефонът пази всеки номер като ОТДЕЛЕН ред, а в
         ръчното му поле човек пише „6 102“ — с разделител за хилядите. Вносът
         правеше от него „6“ и „102“: два други документа влизаха като
         проверени, а истинският инв. № 6102 оставаше несканиран и след пълната
         проверка — „липсващ“ в протокола и оттам в проекта за акт по чл. 30,
         т. 6. Броевете случайно се събираха и никой не забелязваше.
         ЗАЩО Е ГРЕШНО. Протоколът по чл. 40 удостоверява, че КОНКРЕТЕН документ
         е държан в ръка. Един сгрешен ред тук отчислява книга, която е на рафта.
         ПРАВИЛОТО ОТСЕГА — ТУК, В ОБРАБОТЧИКА, А НЕ САМО В ЕКРАНА. Всеки елемент
         на `codes` е един код; екранът пък дели само по нов ред. Код с интервал,
         запетая или точка и запетая ВЪТРЕ не се гадае (дали „6 102“ е 6102 или
         два номера, не може да се знае) — връща се поименно в `malformed`, с
         причина, за да се въведе на ръка. Празните редове и редовете, започващи
         с „#“ (заглавният ред на списъка от телефона — датата на започване), не
         са кодове и се подминават. */
      const res = { added: 0, duplicates: 0, unknown: [], skipped: [], malformed: [], lost: [] };
      const cleaned = [];
      for (const raw of (codes || [])) {
        const t = String(raw == null ? '' : raw).trim();
        if (!t || t.startsWith('#')) continue;
        if (/[\s,;]/.test(t)) {
          res.malformed.push({ code: t, reason: 'има интервал или запетая вътре — един ред е един номер; '
            + 'програмата не гадае дали това е един номер, или няколко' });
          continue;
        }
        const c = normalizeScanCode(t);
        if (c) cleaned.push(c);
      }
      const list = [...new Set(cleaned)];
      if (!list.length && !res.malformed.length) throw new Error('Списъкът е празен.');
      /* Одит v2.4.24: `barcode = ? OR inv_number = CAST(? AS INTEGER)` с .get()
         връщаше при двусмислен код просто реда с по-малък rowid — в протокол за
         инвентаризация това значи „проверен" за чужд документ, а истинският остава
         в липсите. resolveScannedBook() хвърля при двусмислие; тук ГРЕШКАТА НЕ
         спира целия внос (списъкът е от стотици сканирания), а кодът влиза в
         пропуснатите с причината, за да я види библиотекарят поименно. */
      const already = db.prepare('SELECT 1 FROM inventory_session_scans WHERE session_id = ? AND book_id = ?');
      const addScan = db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)');
      const addCheck = db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)');
      /* Одит v2.4.14: този път приемаше В СЪЩАТА сесия документи, които
         inventorySessions:scan отказва изрично — от чужд отдел и отчислени.
         Един и същ протокол, две различни правила: каквото настолната програма
         спира на място, телефонът внасяше наум, а числото „проверени“ надхвърляше
         обявения обхват (pool_size се брои САМО за отдела при
         inventorySessions:start) без следа откъде. Пропуснатите се връщат
         поименно, а не се подминават тихо — библиотекарят трябва да види кои
         номера не са влезли в протокола и защо. */
      let restored = 0;
      db.transaction(() => {
        for (const code of list) {
          let b;
          try { b = resolveScannedBook(db, code); }
          catch (err) { res.skipped.push({ inv_number: code, reason: err.message }); continue; }
          if (!b) { res.unknown.push(code); continue; }
          if (b.status === 'отчислен') {
            res.skipped.push({ inv_number: b.inv_number, reason: 'отчислен' });
            continue;
          }
          if (s.department && (b.department || '') !== s.department) {
            res.skipped.push({ inv_number: b.inv_number, reason: 'отдел „' + (b.department || '—') + '“' });
            continue;
          }
          if (already.get(sessionId, b.id)) { res.duplicates++; continue; }
          addScan.run(sessionId, b.id);
          addCheck.run(b.id, s.date);
          db.prepare("UPDATE books SET datelastseen = datetime('now') WHERE id = ?").run(b.id);
          if (b.status === 'липсващ') {
            db.prepare("UPDATE books SET status='наличен', status_date=date('now', 'localtime') WHERE id=?").run(b.id);
            restored++;
          }
          /* Изгубен от читател, а е на рафта — брои се като проверен, но се
             връща поименно с читателя и с действието (находка О3). */
          if (b.status === BOOK_STATUS_LOST) {
            res.lost.push(Object.assign({ inv_number: b.inv_number, title: b.title }, lostCaseOf(db, b)));
          }
          res.added++;
        }
      }).immediate();
      if (restored) scheduleCatalogWrite();
      logAudit('Инвентаризация', `въведени ${res.added} сканирания от телефон` +
        (res.unknown.length ? `, ${res.unknown.length} непознати` : '') +
        (res.skipped.length ? `, ${res.skipped.length} извън обхвата на проверката` : '') +
        (res.malformed.length ? `, ${res.malformed.length} реда с интервал/запетая вътре не са внесени (`
          + res.malformed.map(m => '„' + m.code + '“').join(', ') + ')' : '') +
        (res.lost.length ? `; ${res.lost.length === 1 ? 'намерен е 1 документ, отбелязан като изгубен'
          : 'намерени са ' + res.lost.length + ' документа, отбелязани като изгубени'} от читател (`
          + res.lost.map(l => 'инв. № ' + l.inv_number).join(', ') + ') — състоянието им остава „изгубен“ до „Документът се намери“' : ''));
      return res;
    })
  );
};
