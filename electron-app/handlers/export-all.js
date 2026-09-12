/* Пълен износ на базата в отворен формат (CSV в ZIP) — канал `exportAll:run`.
   ==========================================================================
   ЗАЩО СЪЩЕСТВУВА. Дотук програмата умееше да изведе четири неща: читателите
   (readers:exportCsv), каталога (catalog:exportCsv / MARC / Dublin Core),
   месечния дневник (dnevnik:exportCsv) и одитната следа. Всичко останало —
   заеманията, актовете за отчисляване, постъпленията, периодиката,
   инвентаризациите, резервациите, читателските сметки, МЗС, краезнанието —
   нямаше НИКАКЪВ износ. Единственият начин данните да напуснат програмата беше
   резервното копие, тоест .db файл: формат, който се отваря само с тази
   програма (или с better-sqlite3), не се чете от човек и не става за подаване
   към регионалната библиотека, към общината или към следващата програма.

   Защо това е проблем за библиотекаря, а не само за програмиста: читалищната
   библиотека е задължена да пази данните си и да може да ги предаде. Когато
   програмата е единственият път до собствените ѝ числа, данните са заложник на
   програмата. Един ZIP с CSV-та се отваря с Excel, с LibreOffice и с Notepad на
   всяка машина, включително след 10 години и без InvLib.

   ЛИЧНИ ДАННИ. Базата пази ЕГН, номер на лична карта и постоянен адрес. Затова
   износът НЕ е сляпо копие:
     • ЕГН и № на лична карта НЕ излизат в чист вид НИКОГА — нито когато
       защитата е отключена, нито когато изобщо не е задавана. Същото решение е
       взето и в readers:exportCsv („това е справочен документ, не заместител на
       защитата на личните данни“). Причината е, че този файл се носи на флашка
       и се праща по имейл — а ЕГН-тата на всички читатели на едно място са
       най-опасното нещо в цялата база. Пълното копие ВКЛЮЧИТЕЛНО с ЕГН си
       остава криптираното резервно копие (handlers/backup.js), което се отваря
       само с паролата.
     • Когато защитата на личните данни е ЗАДАДЕНА, но ЗАКЛЮЧЕНА в тази сесия,
       се скриват и останалите лични колони — адрес, телефон, имейл, дата на
       раждане, данни на гаранта. Заключената защита означава, че библиотекарят
       не е доказал правото си да вижда тези данни СЕГА; износът не бива да е
       вратичка покрай ключалката. Отключена (или незадавана) защита оставя тези
       колони, както ги показва и самата програма на всеки екран и разпечатка.
     • Солта и проверителят на паролата (settings.pdp_salt / pdp_verifier) не
       излизат никога: с тях паролата се напада офлайн, извън програмата.
   Всяко скриване се отбелязва изрично в PROCHETI-ME.txt — библиотекарят трябва
   да знае какво ДЪРЖИ в ръцете си, за да не праща непълен файл, мислейки го за
   пълен, и да не праща ЕГН, мислейки, че е скрито.

   БЕЗ НОВА ЗАВИСИМОСТ. В node_modules няма библиотека за ЗАПИСВАНЕ на ZIP
   (`unzipper`, `tar`, `tar-fs` идват с electron-builder, тоест са devDependency
   и не влизат в инсталатора, а unzipper и без това само разпакетира). Затова
   ZIP-ът се сглобява тук — форматът е прост и стабилен от 1989 г., компресията
   е zlib.deflateRawSync от самия Node, а CRC32 идва от zlib.crc32 (Node 22; за
   по-стар Node остава собствена таблица). Нищо не се сваля и нищо не се
   добавя към package.json. */
const zlib = require('zlib');

module.exports = function registerExportAllHandlers(ipcMain, deps) {
  const { getDb, logAudit, dialog, getMainWindow, fs, csvCell, today } = deps;
  const pii = require('../pii-crypto');

  /* ---------- Имената на файловете в архива ----------
     Ключът е името на таблицата в базата, стойността — името на файла и какво
     пише вътре. Имената на файловете са на ЛАТИНИЦА, но на български думи
     („zaemania.csv“, а не „loans.csv“ и не „заемания.csv“). Причината за
     латиницата е практическа, не естетическа: имената на записите в ZIP нямат
     задължителна кодировка, а Windows Explorer отваря архиви с кирилица в името
     на записа като въпросителни знаци или квадратчета в зависимост от езиковата
     настройка на машината. Български думи с латински букви се четат от всеки
     библиотекар и се разархивират навсякъде.
     Описанието е второто поле — влиза в PROCHETI-ME.txt, за да може човек, който
     никога не е виждал тази програма, да разбере кой файл какво съдържа. */
  const TABLES = {
    readers: ['chitateli', 'Читатели (ползватели) — регистър по чл. 42'],
    loans: ['zaemania', 'Заемания: кой читател кой документ е взел, кога и кога го е върнал'],
    books: ['katalog-knigi', 'Библиотечен фонд — каталожните описания на документите'],
    inventory: ['nalichnost', 'Наличност по инвентарен номер (брой екземпляри)'],
    inventory_checks: ['sverki-nalichnost', 'Сверки на наличността'],
    acquisitions: ['postaplenia', 'Постъпления — партиди по раздел II и чл. 14 от Наредба № 3'],
    deaccession_acts: ['aktove-otchislyavane', 'Актове за отчисляване — раздел IV, чл. 30 – 39'],
    deaccession_items: ['aktove-otchislyavane-redove', 'Редовете (документите) във всеки акт за отчисляване'],
    deaccession_drafts: ['aktove-chernovi', 'Незавършени (чернови) актове за отчисляване'],
    deaccession_draft_items: ['aktove-chernovi-redove', 'Редовете в черновите актове'],
    inventory_sessions: ['inventarizatsii', 'Инвентаризации — раздел V, чл. 40 – 41'],
    inventory_session_scans: ['inventarizatsii-skanirani', 'Сканираните при инвентаризация документи'],
    inventory_session_missing: ['inventarizatsii-lipsvashti', 'Липсващите при инвентаризация документи'],
    periodicals: ['periodika', 'Периодични издания — заглавия'],
    periodical_issues: ['periodika-broeve', 'Постъпили броеве от периодични издания'],
    periodical_volumes: ['periodika-godishnini', 'Подвързани годишнини на периодичните издания'],
    holds: ['rezervatsii', 'Резервации на документи от читатели'],
    account_lines: ['smetki-dvizhenia', 'Читателски сметки: начисления и плащания (такси, обезщетения)'],
    suggestions: ['predlozhenia-za-pokupka', 'Предложения за покупка, подадени от читателите'],
    mzs_requests: ['mzs-zayavki', 'Междубиблиотечно заемане — заявки от и към други библиотеки'],
    dnevnik_days: ['dnevnik', 'Дневник на библиотеката — Раздел А и Раздел Б, по календарни дни'],
    visits: ['poseshtenia', 'Посещения в библиотеката'],
    housebound_profiles: ['obsluzhvane-po-domovete', 'Читатели, обслужвани по домовете — предпочитания'],
    housebound_visits: ['poseshtenia-po-domovete', 'Извършени посещения по домовете'],
    events: ['sabitia', 'Служебни събития на програмата (заемане, връщане, напомняне)'],
    notice_log: ['napomnyania', 'Изпратени напомняния за просрочени документи'],
    audit_log: ['odit-sleda', 'Одитна следа — кой служител какво е извършил и кога'],
    search_history: ['istoria-tarsenia', 'История на търсенията (за подсказките в полетата за търсене)'],
    employees: ['sluzhiteli', 'Служители, които работят с програмата'],
    categories: ['kategorii', 'Категории (отдели) на фонда'],
    authorised_values: ['spravochni-stoynosti', 'Справочни (авторитетни) стойности — единен вид на повтарящите се данни'],
    author_table: ['tablitsa-avtorski-znak', 'Таблица на авторския знак (Хайкова таблица)'],
    circulation_rules: ['pravila-zaemane', 'Правила за заемане по категория читател и вид документ'],
    calendar_closed: ['nerabotni-dni', 'Неработни дни на библиотеката'],
    catalog_shelves: ['vitrini', 'Тематични витрини в онлайн каталога'],
    catalog_shelf_items: ['vitrini-zapisi', 'Кои документи стоят в коя витрина'],
    analytics: ['analitichno-opisanie', 'Аналитично описание — статии в периодика и части от книги'],
    persons: ['personalii', 'Персоналии — видни местни жители и дейци'],
    chronicle: ['letopis', 'Летопис на читалищната дейност'],
    links: ['vrazki', 'Полезни връзки'],
    settings: ['nastroyki', 'Настройки на библиотеката (данни за организацията, срокове, образци)']
  };

  /* Таблици, които НЕ са данни на библиотеката, а вътрешна счетоводия на SQLite
     и на пълнотекстовото търсене. `books_fts`/`readers_fts` са огледало на
     `books`/`readers`, а `*_fts_data`/`_idx`/`_docsize`/`_config` са двоичните
     им сенчести таблици — съдържат нечетими BLOB-ове и биха дали 40 МБ боклук
     в архива, който НЕ носи нито един факт извън самите books/readers. */
  function isInternalTable(name) {
    return /^sqlite_/.test(name) || /_fts$/.test(name) || /_fts_(data|idx|docsize|config|content)$/.test(name);
  }

  /* ---------- Лични данни ----------
     PII_ALWAYS — колони, които не излизат в чист вид при никакво състояние.
     PII_WHEN_LOCKED — колони, които се скриват само докато защитата е ЗАДАДЕНА,
     но ЗАКЛЮЧЕНА. `note` и `alert_note` са тук нарочно: това са свободни полета,
     в които реално се пише „живее при дъщеря си на ул. …“ и „майката се обажда
     на 0888…“ — тоест адрес и телефон под друго име. */
  const PII_ALWAYS = {
    readers: ['egn', 'id_card_no'],
    settings: ['pdp_salt', 'pdp_verifier']
  };
  const PII_WHEN_LOCKED = {
    readers: ['address', 'address2', 'phone', 'email', 'birth_date',
      'id_card_date', 'id_card_issuer', 'guarantor_name', 'guarantor_phone',
      'guarantor_relation', 'note', 'alert_note'],
    housebound_profiles: ['note'],
    housebound_visits: ['note'],
    acquisitions: ['donor_address']
  };
  const HIDDEN = '(скрито)';

  /* Името на таблица се вгражда в SQL, а не се подава като параметър: SQLite не
     приема параметър на мястото на идентификатор. Затова се цитира по правилата
     на SQL — двойни кавички, а вътрешната кавичка се удвоява. Имената идват от
     sqlite_master, тоест от самата база, но правилото е правило: следващият,
     който добави тук списък от имена „отвън“, няма да отвори дупка. */
  function q(ident) { return '"' + String(ident).replace(/"/g, '""') + '"'; }

  /* Големите data URI (лого на организацията, снимки в „Персоналии“ и
     „Летопис“) не влизат в CSV. Причината не е място, а че Excel реже клетка
     над 32 767 знака: една снимка от 300 kB превръща файла в нечетим — и то
     тихо, без съобщение. Затова на мястото на изображението се вписва колко е
     голямо; самото изображение си остава в резервното копие. */
  function isDataUri(v) { return typeof v === 'string' && /^data:[^;,]*;base64,/.test(v); }

  /* ---------- ZIP ----------
     Минимален, но истински ZIP: локален заглавен блок + централен каталог +
     край на каталога. Компресията е DEFLATE (метод 8) през zlib.deflateRawSync;
     ако свитото излезе по-голямо от оригинала (кратки файлове), записът остава
     несвит (метод 0) — така е по стандарт и така го правят и другите архиватори.
     ZIP64 НЯМА: над 4 GB форматът иска друг набор от полета. Реалният архив на
     читалищна библиотека е няколко мегабайта, но ако някога се стигне дотам,
     по-долу се отказва с ясно съобщение, вместо да се запише повреден файл. */
  const ZIP_LIMIT = 3 * 1024 * 1024 * 1024;
  const crcTable = (() => {
    // Резервна таблица за Node под 22.2, където zlib.crc32 още го няма.
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  function crc32(buf) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  /* Часът в ZIP е в стария формат на MS-DOS: секундите са с точност 2 секунди,
     а годината се брои от 1980. Пише се реалното местно време, за да покаже
     Windows вярна дата на файловете вътре в архива. */
  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xFFFF;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }
  function buildZip(entries) {
    const now = new Date();
    const time = dosTime(now), date = dosDate(now);
    const parts = [], central = [];
    let offset = 0;
    for (const { name, data } of entries) {
      const nameBuf = Buffer.from(name, 'utf8');
      const crc = crc32(data);
      let method = 8;
      let body = zlib.deflateRawSync(data, { level: 9 });
      if (body.length >= data.length) { method = 0; body = data; }
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);            // нужна версия 2.0 (deflate)
      local.writeUInt16LE(0x0800, 6);        // бит 11: името е в UTF-8
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      parts.push(local, nameBuf, body);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);               // версия на създателя
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(body.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);               // extra
      cd.writeUInt16LE(0, 32);               // коментар
      cd.writeUInt16LE(0, 34);               // диск
      cd.writeUInt16LE(0, 36);               // вътрешни признаци
      cd.writeUInt32LE(0, 38);               // външни признаци
      cd.writeUInt32LE(offset, 42);
      central.push(cd, nameBuf);
      offset += local.length + nameBuf.length + body.length;
    }
    const cdBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...parts, cdBuf, end]);
  }

  /* ---------- CSV ----------
     Точно както го правят readers:exportCsv, dnevnik:exportCsv и
     catalog:exportCsv: BOM отпред (иначе Excel на Windows чете кирилицата като
     „Ð§Ð¸ÑÐ°ÑÐµÐ»Ð¸“), разделител „;“ (десетичната запетая в българската
     локализация прави „,“ негоден за разделител) и csvCell() за екранирането —
     същата функция от security-utils.js, която освен кавичките пази и от
     клетка, започваща с „=“ (Excel я изпълнява като формула). Краят на реда е
     CRLF — CSV по RFC 4180 и единственото, което стар Excel чете сигурно.

     ЕДНА разлика с dnevnik:exportCsv, и тя е съзнателна: там заглавният ред е на
     човешки език („Часове на обслужване“), защото това е ГОТОВА СПРАВКА, която
     се подава нагоре и се чете от човек. Тук заглавният ред са истинските имена
     на колоните от базата, защото това е ПЪЛНО КОПИЕ: по тези имена се правят
     връзките между файловете (zaemania.csv → reader_id сочи към id в
     chitateli.csv) и по тях данните могат да бъдат внесени обратно или в друга
     програма. Превод на човешки език тук би скъсал точно това. Затова
     PROCHETI-ME.txt изброява колоните на всяка таблица и обяснява коя таблица
     какво е — човекът получава обяснението, машината получава имената. */
  const BOM = '﻿';
  function toCsv(headers, rows) {
    return BOM + [headers.map(csvCell).join(';')]
      .concat(rows.map(r => r.map(csvCell).join(';')))
      .join('\r\n') + '\r\n';
  }

  ipcMain.handle('exportAll:run', async () => {
    try {
      const db = getDb();
      const day = today();
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Пълен износ на данните (CSV в ZIP)',
        defaultPath: 'iznos-vsichki-danni-' + day + '.zip',
        filters: [{ name: 'ZIP архив', extensions: ['zip'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };

      /* Състоянието на защитата на личните данни се чете по СЪЩИЯ начин, по
         който го чете и резервното копие (handlers/backup.js): „зададена“ —
         солта и проверителят стоят в настройките; „отключена“ — ключът на
         сесията е в паметта (pii-crypto.js). Нарочно не се пипа handlers/pdp.js:
         състоянието му и без това се излага през общата сесия на pii-crypto. */
      /* try/catch като в handlers/backup.js: стара база може да няма колоните
         pdp_* (идват от миграция 2). Без него ИЗНОСЪТ ИЗОБЩО не тръгва с
         „no such column“ — тоест липсваща защита на лични данни би отнела и
         единствения открит изход на данните. При съмнение се държим така, все
         едно защитата Е заключена: по-добре по-малко колони, отколкото ЕГН. */
      let s = {};
      let pdpUnknown = false;
      try {
        s = db.prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id = 1').get() || {};
      } catch (err) {
        pdpUnknown = true;
        logAudit('Пълен износ на данните', 'ВНИМАНИЕ: състоянието на защитата на личните данни '
          + 'не можа да се прочете (' + err.message + '). Износът продължава, но личните колони '
          + 'са скрити, все едно защитата е заключена.');
      }
      const pdpConfigured = pdpUnknown || !!(s.pdp_salt && s.pdp_verifier);
      const pdpUnlocked = !pdpUnknown && !!pii.getSessionKey();
      const pdpLocked = pdpConfigured && !pdpUnlocked;

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      ).all().map(r => r.name).filter(n => !isInternalTable(n));

      const entries = [];
      const opis = [];          // редовете за PROCHETI-ME.txt
      const skritiKoloni = [];  // кои колони реално са скрити — за същия файл
      let obshtoRedove = 0;
      const zaeti = new Set();  // пази от сблъсък на имена на файлове

      for (const t of tables) {
        const [baseName, opisanie] = TABLES[t] || [t, 'таблица от базата данни (без описание в този износ)'];
        let file = baseName + '.csv';
        // Нова таблица, добавена след този износ, може да се казва като вече
        // заето име — тогава получава притурка с истинското име от базата,
        // вместо мълчаливо да замени чужд файл в архива.
        if (zaeti.has(file)) file = baseName + '--' + t + '.csv';
        zaeti.add(file);

        const cols = db.prepare('PRAGMA table_info(' + q(t) + ')').all().map(c => c.name);
        if (!cols.length) continue;
        const skriti = new Set([
          ...(PII_ALWAYS[t] || []),
          ...(pdpLocked ? (PII_WHEN_LOCKED[t] || []) : [])
        ].filter(c => cols.includes(c)));
        skriti.forEach(c => skritiKoloni.push(file + ' → ' + c));

        const rows = db.prepare('SELECT * FROM ' + q(t)).all();
        const data = rows.map(r => cols.map(c => {
          if (skriti.has(c)) return r[c] == null || r[c] === '' ? '' : HIDDEN;
          const v = r[c];
          if (isDataUri(v)) return '(изображение, ' + Math.round(v.length / 1024) + ' kB — в резервното копие)';
          if (Buffer.isBuffer(v)) return '(двоични данни, ' + v.length + ' байта)';
          return v;
        }));
        entries.push({ name: file, data: Buffer.from(toCsv(cols, data), 'utf8') });
        obshtoRedove += rows.length;
        opis.push('  ' + file.padEnd(34) + rows.length + ' реда — ' + opisanie
          + '\n' + ' '.repeat(4) + '(таблица „' + t + '“, колони: ' + cols.join(', ') + ')');
      }

      const readme = [
        'ПЪЛЕН ИЗНОС НА ДАННИТЕ ОТ „ИНВЕНТАР / InvLib“',
        '='.repeat(62),
        '',
        'Дата на износа: ' + day,
        'Файлове в архива: ' + entries.length + ' таблици, общо ' + obshtoRedove + ' записа.',
        '',
        'Това е ПЪЛНО КОПИЕ на данните към посочената по-горе дата — всяка',
        'таблица от базата е изнесена в отделен файл. Файловете са CSV:',
        'обикновен текст, разделител „точка и запетая“ (;), кодировка UTF-8 с',
        'BOM. Отварят се направо с двойно щракване в Excel и в LibreOffice.',
        'Първият ред на всеки файл е с имената на колоните, както са в базата.',
        '',
        'ЛИЧНИ ДАННИ — ПРОЧЕТЕТЕ',
        '-'.repeat(62),
        'ЕГН и номерът на личната карта НЕ се изнасят в този архив при никакви',
        'обстоятелства. На тяхно място стои надписът „' + HIDDEN + '“, когато',
        'стойност е имало. Това е съзнателно: архивът се носи на флашка и се',
        'праща по имейл, а списък с ЕГН-тата на всички читатели е най-опасното',
        'нещо в базата. Пълно копие ВКЛЮЧИТЕЛНО с ЕГН е криптираното резервно',
        'копие (Настройки → Резервно копие), което се отваря само с паролата.',
        '',
        pdpLocked
          ? 'Защитата на личните данни е ЗАДАДЕНА и в момента ЗАКЛЮЧЕНА, затова\n'
            + 'скрити са и адресът, телефонът, имейлът, датата на раждане и данните\n'
            + 'на гаранта. Ако този износ Ви трябва с тях, отключете защитата от\n'
            + '„Настройки“ → „Лични данни“ и повторете износа.'
          : (pdpConfigured
            ? 'Защитата на личните данни е зададена и отключена в тази сесия,\n'
              + 'затова адресът, телефонът и останалите данни за връзка са изнесени.\n'
              + 'Файлът chitateli.csv съдържа лични данни — пазете го съответно.'
            : 'Защита на личните данни не е задавана в тази програма, затова\n'
              + 'адресът, телефонът и останалите данни за връзка са изнесени.\n'
              + 'Файлът chitateli.csv съдържа лични данни — пазете го съответно.'),
        '',
        'Скрити колони в този износ:',
        skritiKoloni.length ? skritiKoloni.map(x => '  • ' + x).join('\n') : '  (няма)',
        '',
        'Изображенията (лого, снимки в „Персоналии“ и „Летопис“) не се изнасят в',
        'CSV — на тяхно място стои бележка с размера. Excel реже клетка над',
        '32 767 знака и една снимка би направила целия файл нечетим.',
        '',
        'КОЙ ФАЙЛ КАКВО СЪДЪРЖА',
        '-'.repeat(62),
        opis.join('\n'),
        '',
        'Връзките между файловете се правят по числовите колони: например',
        'zaemania.csv има reader_id и book_id, които сочат към колоната id в',
        'chitateli.csv и katalog-knigi.csv.',
        ''
      ].join('\n');
      entries.unshift({ name: 'PROCHETI-ME.txt', data: Buffer.from('﻿' + readme, 'utf8') });

      const golemina = entries.reduce((n, e) => n + e.data.length, 0);
      if (golemina > ZIP_LIMIT) {
        throw new Error('Данните са ' + Math.round(golemina / 1024 / 1024) + ' МБ и надхвърлят това, '
          + 'което този формат архив побира. Ползвайте резервно копие (Настройки → Резервно копие).');
      }
      fs.writeFileSync(filePath, buildZip(entries));

      /* Одитна следа. Вписва се КОЛКО и КАКВО е излязло и дали личните данни са
         били скрити — при проверка по ОРЗД въпросът е точно този: „кой и кога е
         изнесъл данните на читателите от системата и в какъв вид“. Досегашните
         износи също оставят следа (виж readers:exportCsv), този я оставя
         по-подробна, защото изнася всичко наведнъж. */
      logAudit('Пълен износ на данните (CSV в ZIP)',
        filePath + ' — ' + entries.length + ' файла, ' + obshtoRedove + ' записа; лични данни: '
        + (pdpLocked ? 'скрити (защитата е заключена)' : 'ЕГН и № ЛК скрити, останалите изнесени'));
      return { ok: true, data: { path: filePath, tables: entries.length - 1, rows: obshtoRedove, pdpLocked } };
    } catch (err) {
      /* Без празен catch: съобщението стига до библиотекаря дословно, а в
         дневника за грешки остава и следата, защото при отказ да се запише файл
         причината почти винаги е външна (диск, права, отворен файл в Excel) и
         текстът на системата е единственото, което я назовава. */
      console.error('Пълният износ се провали:', err);
      return { ok: false, error: err.message };
    }
  });
};
