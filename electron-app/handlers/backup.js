// Резервни копия — извадени от main.js в отделен модул (Фаза 4, стъпка 1 от
// разбиването на монолита на модули по домейн). Първи кандидат за извличане,
// защото е напълно самостоятелен: никой друг домейн (книги/заемания/читатели)
// не вика функциите тук, и обратно.
//
// Инжектиране на зависимости (dependency injection), не голи module-scope
// променливи — защото main.js държи няколко споделени, ПРОМЕНЛИВИ стойности
// (db, mainWindow), които се преприсвояват по време на изпълнение:
//   - mainWindow се пресъздава при app.on('activate', ...) — затова се подава
//     getMainWindow() (функция), не самата стойност, за да вижда модула
//     винаги ТЕКУЩИЯ прозорец, а не онзи от момента на регистрация (по това
//     време mainWindow дори още не съществува — ipcMain.handle(...) се
//     изпълнява веднага при зареждане на main.js, преди app.whenReady()).
//   - db се присвоява истински само веднъж (в initDb()); единственото друго
//     преприсвояване е "db = null" точно преди app.exit(0) при възстановяване
//     от резервно копие (процесът приключва веднага след това, така че на
//     практика не се стига до втори прочит) — но за да няма нужда да се
//     разчита на това стечение на обстоятелствата, преприсвояването минава
//     през setDb(), а не през локална променлива в този файл.
module.exports = function registerBackupHandlers(ipcMain, deps) {
  const {
    app, dialog, fs, path,
    getDb, setDb, getMainWindow,
    run, logAudit, resolveDbDir, resolveDbPath,
    /* Незадължителни (подават се от main.js, но не и от тестовете на модула):
       readConfig/updateConfig — за втората папка за копие (настройка на ТОЗИ
       компютър, не на общата база: USB диск или мрежов дял е различен за всяко
       работно място); currentSchemaVersion — за проверката „не е ли копието от
       по-нова версия на програмата“ преди възстановяване. */
    readConfig, updateConfig, currentSchemaVersion
  } = deps;
  const { isEncryptedBackup, encryptBackupFile, decryptBackupBuffer } = require('../backup-crypto');
  const pii = require('../pii-crypto');
  const crypto = require('crypto'); // само за отпечатък на паролата в паметта, виж todayEncryptedWith
  /* Истинска връзка към SQLite — нужна е само за PRAGMA integrity_check върху
     ПРЯСНО ЗАПИСАНО копие и върху файл, предложен за възстановяване. Отваря се
     САМО за четене и се затваря веднага. */
  const Database = require('better-sqlite3');

  /* СТЕПЕНУВАНО ПАЗЕНЕ на автоматичните копия. Дотук правилото беше едно:
     „последните 30 дни“ — и на 31-ия ден няма нищо. Точно това не отговаря на
     начина, по който грешките в библиотечен фонд излизат наяве: сгрешено
     групово отчисляване, изтрит читател или объркан внос се забелязват при
     годишната инвентаризация или при сверката по Наредба № 3, тоест месеци
     по-късно. Затова: всекидневни копия за месец назад, по едно на седмица за
     три месеца и по едно на месец за две години. Цената е няколко десетки
     файла, а не стотици. */
  const AUTO_BACKUP_KEEP_DAYS = 30;      // всекидневни
  const AUTO_BACKUP_WEEKLY_DAYS = 90;    // след тях — по едно на седмица (3 месеца)
  const AUTO_BACKUP_MONTHLY_DAYS = 730;  // след тях — по едно на месец (2 години)
  /* Колко МЕЖДИННИ копия (auto-ГГГГ-ММ-ДД-ЧЧММ) се пазят в рамките на един ден.
     Таймерът по-долу работи на 3 часа, тоест при работен ден от 8 часа стават
     най-много 3 нови файла; четири е „днешното плюс вчерашният край на деня“ и
     държи папката в разумен размер, вместо по едно копие на час до безкрай. */
  const AUTO_BACKUP_INTRADAY_KEEP = 4;
  /* Копие и по ТАЙМЕР. Дотук копие се правеше САМО при стартиране (единственото
     извикване на autoBackupIfNeeded() в main.js): компютър в читалище, който
     стои включен седмица без рестарт, нямаше НИТО едно ново копие цяла седмица —
     а точно там се въвеждат новите постъпления. Три часа е компромисът между
     „скорошно копие“ и „не пиши по цял ден в мрежовата папка“; при това копие се
     прави само ако базата наистина е променяна (виж dbChangedSince). */
  const AUTO_BACKUP_INTERVAL_MS = 3 * 60 * 60 * 1000;

  function backupsDir() {
    const dir = path.join(resolveDbDir(), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /* ВТОРА ПАПКА ЗА КОПИЕ (незадължителна). Всички копия дотук живееха в
     backups/ ДО САМАТА база — тоест един изгорял диск, една изтрита папка или
     една криптовирусна зараза отнася базата и всичките 30 копия заедно с нея.
     Затова дневното копие може да се дублира във втора папка (USB, друг диск,
     мрежов дял). Пътят се пази в config.json на ТОЗИ компютър, защото „D:\“ или
     „\\СЪРВЪР\архив“ значи различно нещо на всяко работно място. Ако папката не
     е зададена или не е достъпна, програмата работи точно както досега — но го
     КАЗВА в „Настройки“, вместо мълчаливо да не прави второто копие. */
  function secondBackupFolder() {
    try {
      if (typeof readConfig !== 'function') return '';
      const cfg = readConfig() || {};
      return cfg.backupFolder2 ? String(cfg.backupFolder2) : '';
    } catch (e) {
      return ''; // непрочетен config.json не бива да проваля самото копие
    }
  }
  // Последният опит за дублиране — интерфейсът го показва (backup:autoStatus).
  let lastSecondCopy = null;
  function mirrorToSecondFolder(srcPath) {
    const folder = secondBackupFolder();
    if (!folder || !srcPath) return null;
    const at = new Date().toISOString();
    try {
      if (!fs.existsSync(folder)) {
        throw new Error('папката не е достъпна (изключен диск, изваден USB или изтрита папка)');
      }
      /* Същият модел като навсякъде другаде тук: пиши настрани и преименувай.
         Прекъснат запис върху USB (изваден по време на копирането) иначе оставя
         отрязан файл с правилното име — в списъка изглежда като здраво копие. */
      const dest = path.join(folder, path.basename(srcPath));
      const staged = dest + '.tmp';
      try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (e) { /* ще гръмне по-долу, ако пречи */ }
      fs.copyFileSync(srcPath, staged);
      fs.renameSync(staged, dest);
      /* Ако това е криптираното копие за деня, некриптираният му близнак във
         втората папка пада — иначе точно там (обикновено USB, който се разнася
         между дома и читалището) остава пълен регистър с ЕГН в чист текст. */
      if (dest.endsWith('.invbak')) {
        const twin = dest.slice(0, -'.invbak'.length) + '.db';
        try { if (fs.existsSync(twin)) fs.unlinkSync(twin); } catch (e) { /* остава; одитът го отбелязва долу */ }
      }
      lastSecondCopy = { ok: true, at, folder, file: dest, error: null };
      return dest;
    } catch (err) {
      lastSecondCopy = { ok: false, at, folder, file: null, error: err.message };
      try {
        logAudit('Резервно копие', 'ВНИМАНИЕ: копието НЕ можа да бъде дублирано във втората папка ('
          + folder + '): ' + err.message + '. Копието в папката до базата е налице.');
      } catch (e) { /* одитът не бива да проваля копието */ }
      notifyAutoBackup('err', 'Резервното копие не можа да бъде записано във втората папка ('
        + folder + '). Копието до базата е направено. Проверете дали дискът е включен.');
      return null;
    }
  }

  /* Кои пътища изобщо може да бъдат инсталирани като активна база. Досега
     backup:restoreFromList/restoreBrowse приемаха ПРОИЗВОЛЕН низ от renderer-а и
     го слагаха на мястото на базата. Сега:
       • от „списъка с резервни копия“ — само файл, който наистина е в папката с
         резервните копия (нормализиран път, сравнение на самата папка, така че
         „…/backups/../…“ не минава);
       • от „избери файл“ — само път, който САМИЯТ main процес е получил от
         системния диалог в тази сесия (нужно е, защото при криптиран файл
         интерфейсът пита за парола и вика handler-а втори път със същия път). */
  const normPath = (p) => {
    const r = path.resolve(String(p || ''));
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const dialogApprovedPaths = new Set();
  function isInBackupsDir(p) {
    if (!p) return false;
    return normPath(path.dirname(String(p))) === normPath(backupsDir());
  }
  function isApprovedSource(p) {
    return isInBackupsDir(p) || dialogApprovedPaths.has(normPath(p));
  }

  function decryptBackupToTemp(srcPath, password) {
    const dec = decryptBackupBuffer(srcPath, password); // хвърля с потребителско съобщение при грешна парола/повреда
    const tmp = path.join(app.getPath('temp'), 'inventar-restore-' + Date.now() + '.db');
    fs.writeFileSync(tmp, dec);
    return tmp;
  }

  /* Одит #19: доскоро тук се четеше директно ЖИВИЯТ файл на базата
     (fs.copyFileSync за некриптирано копие; encryptBackupFile(resolveDbPath(),
     ...) четеше същия файл със суров fs.readFileSync за криптирано) — байт по
     байт, покрай better-sqlite3, без никаква координация с текущо изпълняваща
     се транзакция. wal_checkpoint(TRUNCATE) по-долу смалява прозореца на
     практика, но не го затваря теоретично — правилният инструмент е истинско
     SQLite API за снимка на базата, а не копиране на суровите байтове на
     диска.

     db.serialize() (better-sqlite3, обвивка около sqlite3_serialize) взема
     консистентна снимка ПРЕЗ отворената връзка, вместо да чете файла отстрани
     — точно каквото иска одитът. НЕ е използвано db.backup() (другата
     „истинска" SQLite backup функция, която одитът предлага изрично): тя на
     better-sqlite3 връща Promise и пише файла НА ЧАСТИ през setImmediate —
     проверено директно, веднага след извикването ѝ файлът на диска дори още
     не съществува. autoBackupIfNeeded() по-долу обаче се вика fire-and-forget
     при стартиране (main.js, без await) и множество тестове (handlers-
     backup.test.js, fixes-backup-v23.test.js — извън обхвата на тази
     поправка) проверяват диска веднага СЛЕД синхронно извикване, без await.
     db.serialize() дава същата защита (истинско SQLite API вместо суров прочит
     на живия файл), но остава напълно синхронна операция, затова не се налага
     целият верижен извикващ код да стане асинхронен. */
  /* Здрав ли е даден файл с база данни. Одитът установи НУЛА попадения на
     integrity_check/quick_check в целия код: програмата записваше копие и
     обявяваше успех, без изобщо да е поглеждала какво е записала. Повреда по
     мрежов дял или прекъснат запис дава файл с правилен размер и правилно име,
     който се чупи чак в деня, в който потрябва — обикновено точно когато
     базата вече е загубена. Затова: заглавие „SQLite format 3“, пробно отваряне
     САМО за четене и PRAGMA integrity_check. Връща null при здрав файл или
     изречение на български, което може да се покаже на човек. */
  function sqliteHeaderOk(filePath) {
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      return head.subarray(0, 15).toString('utf8') === 'SQLite format 3';
    } catch (e) {
      return false;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* дръжката и без това си отива */ } }
    }
  }
  function sqliteProblem(filePath, opts) {
    const deep = !(opts && opts.quick);
    if (!fs.existsSync(filePath)) return 'файлът не съществува';
    if (!sqliteHeaderOk(filePath)) {
      return 'файлът не е база данни на SQLite (липсва заглавието „SQLite format 3“) — '
        + 'най-често това е криптирано копие, архив или съвсем друг файл';
    }
    let ro = null;
    try {
      ro = new Database(filePath, { readonly: true, fileMustExist: true });
      const res = ro.pragma(deep ? 'integrity_check' : 'quick_check', { simple: true });
      if (String(res).toLowerCase() !== 'ok') return 'проверката на базата съобщава: ' + res;
      return null;
    } catch (err) {
      /* Суровите английски съобщения на SQLite („database disk image is
         malformed“) не казват нищо на библиотекаря — превеждат се тук. */
      const m = String(err.message || '');
      if (/not a database|file is encrypted/i.test(m)) return 'файлът не е разпознат като база данни';
      if (/malformed|corrupt/i.test(m)) return 'файлът е повреден (непълен или презаписан)';
      return 'файлът не можа да бъде отворен за проверка: ' + m;
    } finally {
      if (ro) { try { ro.close(); } catch (e) { /* проверката приключи */ } }
    }
  }
  /* Проверка на ПРЯСНО ЗАПИСАНО копие — включително криптирано. Криптираният
     файл се разшифрова в ЛОКАЛНАТА временна папка (не до копието: папката с
     копията по документиран сценарий е споделена в мрежата, а разшифрованият
     файл е пълен регистър с ЕГН) и се проверява като обикновена база. */
  function verifyFreshBackup(filePath, password) {
    if (!password) return sqliteProblem(filePath);
    let buf;
    try {
      buf = decryptBackupBuffer(filePath, password);
    } catch (err) {
      return 'копието не се отваря с паролата за защита на личните данни (' + err.message + ')';
    }
    if (buf.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
      return 'разшифрованото копие не е база данни на SQLite';
    }
    const tmp = path.join(app.getPath('temp'), 'inventar-verify-' + Date.now() + '-' + process.pid + '.db');
    try {
      fs.writeFileSync(tmp, buf);
      return sqliteProblem(tmp);
    } catch (err) {
      return 'копието не можа да бъде проверено: ' + err.message;
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* временен файл */ }
    }
  }

  /* Самият запис (без стажиране и проверка) — виж doBackupTo по-долу, което е
     единственият вход към него. */
  function writeRawBackupTo(destPath, password) {
    const db = getDb();
    if (db) db.pragma('wal_checkpoint(TRUNCATE)');
    if (!db) {
      // Няма отворена връзка към базата (напр. извикано точно около
      // presetDb(null) при възстановяване) — просто копирай файла, както
      // досега; db.serialize() няма върху какво да работи.
      if (password) encryptBackupFile(resolveDbPath(), destPath, password);
      else fs.copyFileSync(resolveDbPath(), destPath);
      return;
    }
    const snapshot = db.serialize();
    if (!password) {
      fs.writeFileSync(destPath, snapshot);
      return;
    }
    /* encryptBackupFile() чете от ПЪТ, не от Buffer — затова снимката първо
       каца в некриптиран временен файл до крайната цел, а криптирането се
       прилага върху НЕГО. Редът е същият, какъвто беше и преди тази
       поправка (резервно копие на некриптирания файл, после криптиране върху
       копието) — само източникът на некриптираната снимка вече е
       db.serialize(), не суров прочит на живия .db. */
    /* Временният файл отива в ЛОКАЛНАТА временна папка, НЕ до крайната цел.
       Одит v2.4.14: папката с копията по документиран сценарий е споделена в
       мрежата, а този файл е пълна база в чист текст — ЕГН и № на лична карта
       на всички читатели. Изтриваше се в `finally`, тоест при нормален ход
       живееше секунди; при спиране на тока, убит процес или файл, заключен от
       антивирусна, оставаше на дяла завинаги. Прекриптирането на историческите
       копия по-долу вече пишеше на правилното място — горещият път, който се
       изпълнява при ВСЯКО криптирано копие, беше пропуснат. */
    const plainTmp = path.join(app.getPath('temp'), 'inventar-bak-' + Date.now() + '-' + process.pid + '.db');
    try {
      fs.writeFileSync(plainTmp, snapshot);
      encryptBackupFile(plainTmp, destPath, password);
    } finally {
      try { fs.unlinkSync(plainTmp); } catch (e) { /* временен файл — не е фатално, ако остане */ }
    }
  }

  /* ЕДИНСТВЕНИЯТ вход към записа на копие. Дотук НЕкриптираното копие се
     пишеше направо върху крайното име (fs.writeFileSync(destPath, snapshot)),
     докато криптираното минаваше през .tmp → проверка → преименуване. Разликата
     е важна за библиотекаря: спиране на тока, изваден USB или прекъснат мрежов
     дял насред записа оставяха отрязан .db файл с правилното име и правдоподобен
     размер — в списъка „Резервни копия“ той изглежда напълно нормален и си личи
     чак в деня, в който се възстановява. Сега и двата вида минават по един и същ
     път: пиши настрани → провери, че наистина е база и че integrity_check казва
     „ok“ → чак тогава преименувай (атомарно, в същата папка). Провал на който и
     да е етап оставя предишното копие непокътнато. */
  function doBackupTo(destPath, password) {
    const staged = destPath + '.tmp';
    try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (e) { /* ще гръмне по-долу, ако наистина пречи */ }
    try {
      writeRawBackupTo(staged, password);
      const problem = verifyFreshBackup(staged, password);
      if (problem) throw new Error('новото копие не мина проверката — ' + problem);
      fs.renameSync(staged, destPath);
    } catch (err) {
      try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (e) { /* нищо за чистене */ }
      throw err;
    }
  }

  /* Разчита име от вида auto-ГГГГ-ММ-ДД[-ЧЧММ].db|invbak. Междинните копия
     (с час) се различават от дневното, защото се пазят по друго правило. */
  function parseAutoName(name) {
    const m = /^auto-(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2}))?\.(db|invbak)$/.exec(name);
    if (!m) return null;
    return { date: m[1], intraday: !!m[2] };
  }
  /* Ключ на календарната седмица (четвъртъкът ѝ) — за да се пази ЕДНО копие на
     седмица, без да се разчита на подредбата на файловете. */
  function isoWeekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;        // понеделник = 0
    d.setUTCDate(d.getUTCDate() - dow + 3);     // четвъртъкът на същата седмица
    return d.toISOString().slice(0, 10);
  }
  /* Степенувано изтриване (виж константите най-горе). Възрастта на файла се
     смята по ПО-МЛАДОТО от двете доказателства — датата в името и mtime. Така
     папка, донесена от друг компютър или разархивирана (при което всички mtime
     стават „сега“), не се изчиства още при първото стартиране; правилото винаги
     клони към ПАЗЕНЕ, защото сгрешено изтриване на копие е необратимо, а едно
     излишно копие не вреди на никого. */
  function pruneOldAutoBackups() {
    const dir = backupsDir();
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    const now = Date.now();
    const items = [];
    const doomed = new Set();
    for (const f of names) {
      if (!f.startsWith('auto-')) continue;
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      const meta = parseAutoName(f);
      if (!meta) {
        /* Непознато име auto-… (не е писано от тази програма). Не се пипа,
           докато не стане по-старо от целия прозорец на пазене — иначе
           степенуваното правило би изтрило чужд файл по чужда логика. */
        if (now - st.mtimeMs > AUTO_BACKUP_MONTHLY_DAYS * 86400000) doomed.add(full);
        continue;
      }
      const byName = Date.parse(meta.date + 'T23:59:59Z');
      const stamp = Math.max(Number.isFinite(byName) ? byName : 0, st.mtimeMs);
      items.push({ full, date: meta.date, intraday: meta.intraday, mtime: st.mtimeMs, ageDays: (now - stamp) / 86400000 });
    }
    // 1) В рамките на един ден: дневното копие остава, от междинните — последните няколко.
    const byDate = new Map();
    for (const it of items) {
      if (!byDate.has(it.date)) byDate.set(it.date, []);
      byDate.get(it.date).push(it);
    }
    for (const list of byDate.values()) {
      /* Подрежда се по mtime, а при равни времена — по ИМЕ (в него е часът).
         Файлове с еднакъв mtime (донесена/разархивирана папка) иначе се
         подреждат по реда на четене на папката, тоест кое копие оцелява би
         зависело от случайността. */
      const intras = list.filter(x => x.intraday)
        .sort((a, b) => (b.mtime - a.mtime) || (a.full < b.full ? 1 : a.full > b.full ? -1 : 0));
      intras.slice(AUTO_BACKUP_INTRADAY_KEEP).forEach(x => doomed.add(x.full));
    }
    // 2) Между дните: всекидневни → седмични → месечни.
    const dateAge = new Map();
    for (const it of items) {
      const cur = dateAge.get(it.date);
      if (cur === undefined || it.ageDays < cur) dateAge.set(it.date, it.ageDays);
    }
    const newestOfWeek = new Map(), newestOfMonth = new Map();
    for (const date of dateAge.keys()) {
      const wk = isoWeekKey(date), mo = date.slice(0, 7);
      if (!newestOfWeek.has(wk) || newestOfWeek.get(wk) < date) newestOfWeek.set(wk, date);
      if (!newestOfMonth.has(mo) || newestOfMonth.get(mo) < date) newestOfMonth.set(mo, date);
    }
    for (const [date, age] of dateAge) {
      let keep;
      if (age <= AUTO_BACKUP_KEEP_DAYS) keep = true;
      else if (age <= AUTO_BACKUP_WEEKLY_DAYS) keep = newestOfWeek.get(isoWeekKey(date)) === date;
      else if (age <= AUTO_BACKUP_MONTHLY_DAYS) keep = newestOfMonth.get(date.slice(0, 7)) === date;
      else keep = false;
      if (!keep) (byDate.get(date) || []).forEach(x => doomed.add(x.full));
    }
    for (const full of doomed) {
      try { fs.unlinkSync(full); } catch (e) { /* заключен от антивирусна — ще си иде следващия път */ }
    }
  }

  /* Паролата, с която да се криптира автоматичното копие — паролата на защитата
     на личните данни (pdp), АКО тя е зададена в тази база и отключена в текущата
     сесия. Програмата не може да измисли своя парола: копие, чиято парола никой
     не знае, е загубено копие. Затова:
       • зададена и отключена защита → същата парола криптира и авто-копието
         (библиотекарят вече я знае и ще може да възстанови копието);
       • иначе → копието остава НЕкриптирано, но това се вписва в одитната следа
         и се съобщава на интерфейса (backup:autoStatus).
     Умишлено НЕ се изисква парола за авто-копието: библиотека без включена защита
     трябва да продължи да има ежедневни резервни копия — липсата им е по-тежък
     риск от некриптираното копие. */
  function autoBackupPassword() {
    try {
      const db = getDb();
      if (!db) return '';
      const s = db.prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id = 1').get() || {};
      if (!s.pdp_salt || !s.pdp_verifier) return ''; // защитата не е конфигурирана
      return pii.getSessionPassword() || '';         // конфигурирана, но заключена → празно
    } catch (e) {
      return ''; // стара база без колоните pdp_* — авто-копието пак трябва да стане
    }
  }
  // Последно състояние на автоматичното копие — интерфейсът го чете с
  // backup:autoStatus, за да покаже предупреждението (виж по-долу).
  let lastAutoBackup = null;
  /* Провален ОПИТ за криптиране на днешното копие. Дотук такъв провал отиваше
     само в console.error — тоест никъде: библиотекарят виждаше „🔒 копията се
     криптират“, докато на диска стои копие в чист текст. Пази се и денят, за да
     не се влачи вчерашният провал в днешното състояние. */
  let lastAutoBackupError = null;
  /* Отпечатък на паролата, с която ТОЗИ процес е записал днешното криптирано
     копие. Служи само за бърза пътека: съвпада ли — файлът със сигурност се
     отваря с текущата парола и няма нужда от проверка. Пази се отпечатък, а не
     самата парола, за да няма второ копие на паролата в паметта. */
  let todayEncryptedWith = null;
  const fingerprint = (password) => crypto.createHash('sha256').update(String(password)).digest('hex');

  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function todayPaths() {
    const today = todayStr();
    const dir = backupsDir();
    return {
      date: today,
      plainDest: path.join(dir, `auto-${today}.db`),
      encDest: path.join(dir, `auto-${today}.invbak`)
    };
  }

  /* Отваря ли се даден .invbak с ТАЗИ парола. Форматът нарочно не носи нищо, по
     което паролата да се познае отвън, затова единствената честна проверка е
     опит за разкриптиране — прави се най-много веднъж на сесия (после отговорът
     се помни по отпечатъка по-горе). Пълното разкриптиране проверява и
     целостта (GCM етикета), тоест хваща и повредено копие, не само чужда
     парола. */
  function opensWith(filePath, password) {
    try {
      return decryptBackupBuffer(filePath, password).subarray(0, 15).toString('utf8') === 'SQLite format 3';
    } catch (e) {
      return false;
    }
  }

  /* Записва криптирано копие на мястото на encDest ПО БЕЗОПАСЕН НАЧИН — тук се
     пипат файлове с данни, затова редът е: пиши настрани → провери, че новият
     файл наистина се отваря с паролата → чак тогава преименувай (атомарно, в
     същата папка) → и чак накрая махни некриптирания близнак. При провал на
     който и да е етап старото копие си остава непокътнато: по-добре копие със
     стара парола (или в чист текст), отколкото никакво копие за деня. */
  function writeEncryptedDaily(encDest, plainDest, password) {
    /* Самото стажиране (encDest + '.tmp' → проверка → преименуване) вече живее в
       doBackupTo, защото ОТ ТАЗИ ВЕРСИЯ НАТАТЪК по същия път минава и
       некриптираното копие. Тук остава само това, което е специфично за
       дневното копие: некриптираният близнак пада чак след като криптираният е
       на място и е проверен. */
    doBackupTo(encDest, password); // от живата база — тя е поне толкова нова
    // Некриптираният близнак пада чак сега — той съдържа личните данни на всички
    // читатели, но докато криптираният не е налице и проверен, е единственото копие.
    if (plainDest && fs.existsSync(plainDest)) {
      try { fs.unlinkSync(plainDest); } catch (e) { /* остава; одитът казва какво е станало */ }
    }
  }

  /* Известие към интерфейса, че състоянието на дневното копие се е променило —
     прекриптирано е (смяна на паролата) или опитът се е провалил. Без това
     провалът стигаше само до console.error. Прозорецът може още да не
     съществува (копието се прави при стартиране) — тогава просто няма кого да
     известим, картата в „Настройки“ ще прочете състоянието при отваряне. */
  function notifyAutoBackup(level, message) {
    try {
      const win = getMainWindow();
      if (!win || !win.webContents || (win.isDestroyed && win.isDestroyed())) return;
      win.webContents.send('backup:autoStatusChanged', { level, message });
    } catch (e) { /* интерфейсът не е готов — не е причина да се проваля копието */ }
  }

  /* Изходът от ПОСЛЕДНИЯ опит за копие — успешен или не. Дотук в програмата се
     пазеше само провалът на КРИПТИРАНЕТО; провалът на самото писане (пълен диск,
     изключен мрежов дял, заключен от антивирусна файл) отиваше в console.error,
     тоест в нищото: библиотекарят не научаваше по никакъв път, че от вторник
     насам няма копие. Сега всеки опит се помни и се показва в „Настройки“. */
  let lastAutoAttempt = null;

  function recordAutoBackupFailure(date, message, detail, kind) {
    const at = new Date().toISOString();
    lastAutoBackupError = { date, message, at, kind: kind || 'encrypt' };
    lastAutoAttempt = { ok: false, at, date, kind: kind || 'encrypt', message };
    try { logAudit('Резервно копие', detail); } catch (e) { /* одитът не бива да проваля копието */ }
    notifyAutoBackup('err', kind === 'write'
      ? 'Резервното копие НЕ можа да бъде направено: ' + message
        + ' Вижте „Настройки“ → „Резервно копие“ — библиотеката остава без ново копие, докато това не се оправи.'
      : 'Днешното резервно копие НЕ можа да бъде криптирано: ' + message
        + ' Копието съдържа лични данни на читателите в чист текст — вижте „Настройки“ → „Резервно копие“.');
  }
  function recordAutoBackupSuccess(dest, encrypted, date) {
    lastAutoBackup = { path: dest, encrypted, date };
    lastAutoAttempt = { ok: true, at: new Date().toISOString(), date, path: dest, encrypted };
  }

  function autoBackupIfNeeded() {
    const { date: today, plainDest, encDest } = todayPaths();
    try {
      if (fs.existsSync(plainDest) || fs.existsSync(encDest)) return;
      const password = autoBackupPassword();
      if (password) {
        /* Провалено криптиране не бива да остави деня БЕЗ копие: вписва се,
           съобщава се и се пада към некриптирано копие (по-долу). */
        try {
          writeEncryptedDaily(encDest, null, password);
          pruneOldAutoBackups();
          recordAutoBackupSuccess(encDest, true, today);
          lastAutoBackupError = null;
          todayEncryptedWith = { date: today, fp: fingerprint(password) };
          logAudit('Резервно копие', 'автоматично криптирано копие: ' + encDest
            + ' (с паролата за защита на личните данни)');
          console.log('Автоматично резервно копие:', encDest, '(криптирано)');
          mirrorToSecondFolder(encDest);
          return;
        } catch (err) {
          recordAutoBackupFailure(today, err.message,
            'ВНИМАНИЕ: криптирането на автоматичното копие за деня се провали (' + err.message
            + '). Прави се НЕкриптирано копие, за да не остане денят без резервно копие — то съдържа '
            + 'лични данни на читателите в чист текст.');
        }
      }
      doBackupTo(plainDest, '');
      pruneOldAutoBackups();
      recordAutoBackupSuccess(plainDest, false, today);
      /* Авто-копието съдържа ЦЕЛИЯ фонд от лични данни на читателите — адреси и
         телефони винаги в чист текст, ЕГН в чист текст, ако защитата не е
         включена — и стои 30 дни в папката на базата, която по документиран
         сценарий е споделен мрежов дял. Затова провалът да се криптира не минава
         тихо: вписва се в одитната следа и се показва в интерфейса. */
      logAudit('Резервно копие', 'ВНИМАНИЕ: автоматичното копие ' + plainDest
        + ' НЕ е криптирано и съдържа лични данни на читателите. Включете „Защита на лични данни“ '
        + 'в „Настройки“ и я дръжте отключена, за да се криптират и дневните копия.');
      console.log('Автоматично резервно копие:', plainDest, '(некриптирано)');
      mirrorToSecondFolder(plainDest);
    } catch (err) {
      /* ДОТУК ТОЗИ КЛОН БЕШЕ САМО console.error — а през него минава провалът на
         САМОТО ПИСАНЕ на копието (пълен диск, изваден мрежов диск, файл, заключен
         от антивирусна). Тоест: най-тежкият случай — библиотеката изобщо остава
         без резервно копие — беше единственият, за който никой не научаваше.
         Картата в „Настройки“ говореше само за криптиране, а тя показваше
         спокойно „🔒“, докато нов файл не се е появявал с дни. */
      console.error('Автоматично резервно копие — грешка:', err.message);
      recordAutoBackupFailure(today, err.message,
        'ВНИМАНИЕ: автоматичното резервно копие за деня НЕ беше направено (' + err.message
        + '). Библиотеката остава без ново копие, докато причината не бъде отстранена — '
        + 'проверете свободното място на диска и дали мрежовата папка е достъпна.', 'write');
    }
  }

  /* Променяна ли е базата след последното копие. Сравнява се mtime, но НЕ само
     на library.db: при journal_mode = WAL (локална база) записите дълго стоят в
     library.db-wal и самият .db файл не се пипа с часове — по него програмата би
     решила „няма промяна“ точно в деня с най-много работа. Затова се взима
     по-късното от двете времена. */
  function dbTouchedAt() {
    const p = resolveDbPath();
    let best = 0;
    for (const f of [p, p + '-wal']) {
      try { best = Math.max(best, fs.statSync(f).mtimeMs); } catch (e) { /* -wal може и да няма */ }
    }
    return best;
  }
  function newestAutoBackupAt() {
    let best = 0;
    try {
      const dir = backupsDir();
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('auto-') || !/\.(db|invbak)$/.test(f)) continue;
        try { best = Math.max(best, fs.statSync(path.join(dir, f)).mtimeMs); } catch (e) { /* изтрит междувременно */ }
      }
    } catch (e) { /* няма папка — значи няма и копие */ }
    return best;
  }
  /* Име на МЕЖДИННО копие: auto-ГГГГ-ММ-ДД-ЧЧММ. Нарочно се различава от
     дневното (auto-ГГГГ-ММ-ДД), за да не се блъскат: дневното е онова, което
     autoBackupIfNeeded() търси при стартиране, и ако междинните носеха същото
     име, копието от 17:00 щеше да мине за „днешното“ и да бъде прекриптирано,
     изтрито или прескочено по чужди правила. Часът е по UTC — точно както
     backupTimestamp() за ръчните копия, за да се подреждат еднакво. */
  function intradayPath(password) {
    const iso = new Date().toISOString();
    const stamp = iso.slice(0, 10) + '-' + iso.slice(11, 13) + iso.slice(14, 16);
    return path.join(backupsDir(), 'auto-' + stamp + (password ? '.invbak' : '.db'));
  }

  /* Копие МЕЖДУ стартиранията — вика се от таймера (на 3 часа) и при затваряне
     на програмата. Прави се само ако базата наистина е променяна след последното
     копие: иначе компютър, оставен включен през уикенда, би трупал еднакви файлове. */
  function autoBackupTick(reason) {
    const today = todayStr();
    try {
      // Смяна на деня по време на работа — тогава дневното копие е по-важно.
      const { plainDest, encDest } = todayPaths();
      if (!fs.existsSync(plainDest) && !fs.existsSync(encDest)) { autoBackupIfNeeded(); return true; }
      const touched = dbTouchedAt();
      if (!touched) return false;
      if (touched <= newestAutoBackupAt()) return false; // нищо ново не е записвано
      const password = autoBackupPassword();
      const dest = intradayPath(password);
      if (fs.existsSync(dest)) return false; // същата минута — няма смисъл от второ копие
      doBackupTo(dest, password);
      pruneOldAutoBackups();
      recordAutoBackupSuccess(dest, !!password, today);
      if (password) todayEncryptedWith = { date: today, fp: fingerprint(password) };
      logAudit('Резервно копие', 'автоматично междинно копие (' + reason + '): ' + dest
        + (password ? ' (криптирано)' : ' (НЕкриптирано — защитата на личните данни не е отключена)'));
      console.log('Автоматично междинно резервно копие:', dest, '(' + reason + ')');
      return true;
    } catch (err) {
      recordAutoBackupFailure(today, err.message,
        'ВНИМАНИЕ: междинното автоматично копие (' + reason + ') НЕ беше направено (' + err.message
        + '). Последното налично копие остава предишното — проверете свободното място и достъпа до папката.',
        'write');
      return false;
    }
  }

  /* Таймерът се пуска от main.js след стартирането и се спира при затваряне.
     unref() е важен: така таймерът не държи процеса жив сам по себе си (и не
     задържа тестовата поредица), но работи, докато програмата работи. */
  let autoBackupTimer = null;
  function startAutoBackupTimer() {
    if (autoBackupTimer) return;
    autoBackupTimer = setInterval(() => {
      try { autoBackupTick('на всеки 3 часа'); }
      catch (err) { console.error('Автоматично междинно копие — грешка:', err.message); }
    }, AUTO_BACKUP_INTERVAL_MS);
    if (typeof autoBackupTimer.unref === 'function') autoBackupTimer.unref();
  }
  function stopAutoBackupTimer() {
    if (!autoBackupTimer) return;
    clearInterval(autoBackupTimer);
    autoBackupTimer = null;
  }
  /* Копие ПРИ ЗАТВАРЯНЕ: работният ден на библиотекаря приключва с натискане на
     хиксчето, а следващото копие дотук се правеше чак при следващото пускане —
     тоест ако компютърът се повреди през нощта, изгубена е цялата днешна работа.
     Вика се, докато базата още е отворена (виж реда в main.js). */
  function backupBeforeQuit() {
    try { return autoBackupTick('при затваряне на програмата'); }
    catch (err) { console.error('Резервно копие при затваряне — грешка:', err.message); return false; }
  }

  /* Авто-копието се прави при СТАРТИРАНЕ на програмата (main.js), а защитата на
     личните данни се отключва по-късно — с парола, въведена от библиотекаря.
     Без това дневното копие би оставало некриптирано винаги, а на следващия ден
     функцията вече го намира направено и не прави нищо. Затова, щом защитата бъде
     отключена, днешното копие се преправя криптирано и некриптираното се изтрива
     (то съдържа личните данни на всички читатели). */
  /* Второто, което тази функция трябва да улови, е СМЯНАТА на паролата: дотук
     проверката беше само „има ли вече .invbak за днес“ и при смяна функцията
     излизаше веднага. Копието от деня на смяната оставаше със СТАРАТА парола —
     тоест библиотекар, който е сменил временната парола с истинската (или е
     сменил компрометирана парола), държи копие, което не се отваря с паролата,
     която знае, но продължава да се отваря с онази, която е изоставил. Затова
     сега се проверява самият ФАЙЛ: отваря ли се с текущата парола. */
  function upgradeTodayAutoBackup(meta) {
    const password = autoBackupPassword();
    if (!password) return;
    const { date: today, plainDest, encDest } = todayPaths();
    const fp = fingerprint(password);
    const changed = !!(meta && meta.reason === 'change');
    let why = 'след отключване на защитата на личните данни';
    if (fs.existsSync(encDest)) {
      // Ние ли го записахме, и то със същата парола → няма какво да се прави.
      if (!changed && todayEncryptedWith && todayEncryptedWith.date === today && todayEncryptedWith.fp === fp) return;
      if (changed) {
        why = 'след смяна на паролата за защита на личните данни';
      } else if (opensWith(encDest, password)) {
        todayEncryptedWith = { date: today, fp }; // наред е — запомня се, за да не се проверява пак
        return;
      } else {
        // Копие от друг компютър/от преди смяна на паролата, или повредено.
        why = 'защото не се отваряше с текущата парола за защита на личните данни';
      }
    } else if (!fs.existsSync(plainDest)) {
      autoBackupIfNeeded(); // няма никакво копие за днес — направи го наготово криптирано
      return;
    }
    try {
      writeEncryptedDaily(encDest, plainDest, password);
    } catch (err) {
      /* Старото копие (криптирано със старата парола или некриптирано) е още на
         място — денят не остава без копие. Но библиотекарят трябва да научи, че
         то НЕ е това, което мисли: и в одита, и в картата в „Настройки“. */
      recordAutoBackupFailure(today, err.message,
        'ВНИМАНИЕ: днешното автоматично копие не можа да бъде прекриптирано ' + why
        + ' (' + err.message + '). На диска остава предишното копие — то НЕ се отваря с текущата парола '
        + 'или изобщо не е криптирано.');
      return;
    }
    recordAutoBackupSuccess(encDest, true, today);
    lastAutoBackupError = null;
    todayEncryptedWith = { date: today, fp };
    logAudit('Резервно копие', 'автоматичното копие за деня е презаписано криптирано '
      + why + ': ' + encDest);
    // Втората папка държи вече дублираното НЕкриптирано копие за днес — заменя се
    // с криптираното, иначе точно там (често USB, който се разнася) остава
    // единственият пълен регистър с лични данни в чист текст.
    mirrorToSecondFolder(encDest);
    notifyAutoBackup('ok', changed
      ? 'Днешното резервно копие беше прекриптирано с новата парола.'
      : 'Днешното резервно копие вече е криптирано с паролата за защита на личните данни.');
  }
  /* СМЯНА НА ПАРОЛАТА важи и за ВЕЧЕ НАПРАВЕНИТЕ копия, не само за днешното.
     Дотук се прекриптираше само файлът за текущия ден; останалите (до 30 назад,
     виж AUTO_BACKUP_KEEP_DAYS) оставаха заключени с изоставената парола, а
     списъкът в „Настройки“ ги показваше като изправни. Две последици: копие
     отпреди седмица не се отваря с паролата, която библиотекарят знае — тоест на
     практика е загубено; а ако паролата е сменена ЗАЩОТО е компрометирана, то
     продължава да се отваря с компрометираната.

     Всеки файл се проверява поотделно и се прекриптира само ако наистина не се
     отваря с текущата парола. Един провал не спира останалите — по-добре 29
     прекриптирани и един докладван, отколкото нито един. */
  function reencryptOldBackups(password, prevPassword) {
    const dir = backupsDir();
    const { date: today } = todayPaths();
    let files = [];
    try {
      /* И предпазните копия отпреди възстановяване (одит v2.4.24, преглед на
         поправките от същия кръг). Откакто те също се криптират, филтърът само за
         `auto-…` ги оставяше заключени със СТАРАТА парола завинаги: смяна на
         паролата след напускане на служител правеше единствената снимка отпреди
         едно възстановяване нечетима, а backup:list продължаваше да я показва. */
      files = fs.readdirSync(dir)
        .filter(f => /^auto-\d{4}-\d{2}-\d{2}\.invbak$/.test(f) || /^before-restore-.+\.invbak$/.test(f));
    } catch (e) { return { done: 0, failed: [] }; }
    let done = 0;
    const failed = [];
    for (const f of files) {
      if (f === `auto-${today}.invbak`) continue; // за днешния се грижи upgradeTodayAutoBackup
      const full = path.join(dir, f);
      if (opensWith(full, password)) continue;   // вече е с текущата парола
      /* НЕ през writeEncryptedDaily: то снима ЖИВАТА база (doBackupTo) и изобщо
         не чете подадения му plainDest — писано е за днешното копие, където
         живата база наистина е поне толкова нова. За исторически файл това би
         означавало всичките 29 стари копия да бъдат презаписани със снимка на
         ДНЕШНАТА база: тридесетдневният прозорец за връщане назад изчезва
         безшумно, а одитът отгоре на всичкото рапортува успех.
         Затова тук: разкриптирай със старата парола в паметта → запиши
         криптирано настрани с новата → провери, че се отваря → чак тогава
         преименувай върху оригинала. Съдържанието на файла остава своето. */
      const staged = full + '.tmp';
      /* Разшифрованото копие отива в ЛОКАЛНАТА временна папка, не до самото копие:
         папката с резервните копия обикновено е споделена в мрежата, а този файл
         съдържа ЕГН и № на лична карта на всички читатели. Същият избор като при
         decryptBackupToTemp по-горе. Криптираният междинен файл (staged) може да
         остане до целта — той не е четим без паролата. */
      const plainTmp = path.join(app.getPath('temp'), 'inventar-reenc-' + Date.now() + '-' + f + '.db');
      try {
        const buf = prevPassword ? decryptBackupBuffer(full, prevPassword) : null;
        if (!buf || buf.subarray(0, 15).toString('utf8') !== 'SQLite format 3') { failed.push(f); continue; }
        fs.writeFileSync(plainTmp, buf);
        encryptBackupFile(plainTmp, staged, password);
        /* Прясно записан файл — значи и тук пълна проверка, не само „отваря ли
           се“: integrity_check хваща и повредата, дошла от самото прекриптиране
           (прекъснат запис по мрежов дял), която иначе би се видяла чак в деня,
           в който точно това копие потрябва. */
        const problem = verifyFreshBackup(staged, password);
        if (problem) throw new Error('новото копие не мина проверката — ' + problem);
        fs.renameSync(staged, full);
        done++;
      } catch (err) {
        failed.push(f);
      } finally {
        /* Разшифрованият близнак съдържа личните данни на всички читатели, а
           папката с копията обикновено е споделена в мрежата — не бива да остава
           на диска по НИКОЙ път, включително при провал. */
        try { if (fs.existsSync(plainTmp)) fs.unlinkSync(plainTmp); } catch (e2) { /* нищо не зависи от това */ }
        try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (e2) { /* нищо не зависи от това */ }
      }
    }
    return { done, failed };
  }

  pii.onSession((meta) => {
    try { upgradeTodayAutoBackup(meta); }
    catch (err) { console.error('Криптиране на дневното копие след отключване — грешка:', err.message); }
    if (meta && meta.reason === 'change') {
      try {
        const password = autoBackupPassword();
        if (!password) return;
        const { done, failed } = reencryptOldBackups(password, meta.prevPassword);
        if (done) logAudit('Резервно копие', done + ' по-стари автоматични копия бяха прекриптирани с новата парола');
        if (failed.length) {
          logAudit('Резервно копие', 'ВНИМАНИЕ: ' + failed.length + ' по-стари копия НЕ можаха да бъдат '
            + 'прекриптирани и остават със старата парола: ' + failed.join(', '));
          notifyAutoBackup('err', failed.length + ' по-стари резервни копия останаха със старата парола — '
            + 'вижте одитната следа. Пазете старата парола, докато не бъдат прекриптирани.');
        }
      } catch (err) {
        console.error('Прекриптиране на по-старите копия — грешка:', err.message);
      }
    }
  });

  /* Състояние на автоматичното копие, готово за показване в интерфейса: дали
     дневните копия се криптират и, ако не — защо, на човешки език.

     Дотук отговорът се смяташе САМО от настройките („защитата е конфигурирана и
     отключена → значи копията се криптират“) и картата в „Настройки“ показваше
     „🔒 копията се криптират“ дори когато точно днешното копие е в чист текст —
     провалено криптиране, копие, направено преди отключването, или копие от
     друга сесия. Затова сега водещо е СЪСТОЯНИЕТО НА ФАЙЛА за днес: кой файл
     реално стои на диска. Настройките остават в отговора, защото от тях зависи
     какво да предложим на библиотекаря (да включи защитата или да я отключи).

     state дава на изгледа четирите различими случая:
       'encrypted' — днешното копие е криптирано (или ще бъде, ако още не е правено);
       'failed'    — опитахме и не се получи (или файлът е в чист текст въпреки
                     отключената защита) — причината е в warning;
       'locked'    — защитата е включена, но заключена;
       'off'       — защитата изобщо не е включена. */
  ipcMain.handle('backup:autoStatus', () =>
    run(() => {
      let configured = false;
      try {
        const db = getDb();
        const s = db ? (db.prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id = 1').get() || {}) : {};
        configured = !!(s.pdp_salt && s.pdp_verifier);
      } catch (e) { configured = false; }
      const unlocked = !!pii.getSessionPassword();

      const { date, plainDest, encDest } = todayPaths();
      let today = null;
      if (fs.existsSync(encDest) && isEncryptedBackup(encDest)) {
        today = { date, path: encDest, encrypted: true };
      } else if (fs.existsSync(plainDest)) {
        today = { date, path: plainDest, encrypted: false };
      }
      /* Вчерашен провал не описва днешното състояние. Провалът на САМОТО ПИСАНЕ
         (kind: 'write') нарочно НЕ влиза тук: полето `failure` и състоянието
         'failed' описват криптирането — „копието е в чист текст“. Непроведеното
         копие е друга беда и се показва отделно (lastAttempt/ageDays по-долу),
         за да не изглежда „липсва копие“ като „копието не е криптирано“. */
      const failure = lastAutoBackupError && lastAutoBackupError.date === date
        && lastAutoBackupError.kind !== 'write' ? lastAutoBackupError : null;
      // Ако за днес още няма файл (копието се прави при стартиране), се пада към
      // намерението — какво ЩЕ стане при следващото копие.
      const encrypted = today ? today.encrypted : (configured && unlocked);

      /* Броят НЕкриптирани дневни копия се смята ПРЕДИ решението за състоянието
         (одит v2.4.24): включването на защитата криптира само ДНЕШНОТО копие
         (upgradeTodayAutoBackup) — вчерашните 29 остават в чист текст завинаги
         (reencryptOldBackups се вика само при СМЯНА на парола и хваща само
         auto-*.invbak). Дотук в този случай състоянието беше „encrypted“ с
         warning: null, екранът показваше само „🔒 копията се криптират“, а 29
         пълни регистъра с лични данни си стояха на споделения дял, без нищо на
         екрана да го каже. */
      let plainDailyCount = 0, plainRestoreCount = 0;
      try {
        const names = fs.readdirSync(backupsDir()).filter(f => f.endsWith('.db'));
        plainDailyCount = names.filter(f => f.startsWith('auto-')).length;
        // Предпазните копия отпреди възстановяване са различен вид файл и НЕ бива
        // да се съветва изтриването им: те са единственият изход от сгрешено
        // възстановяване. Броят се отделно точно за да не се слеят в един съвет.
        plainRestoreCount = names.filter(f => f.startsWith('before-restore-')).length;
      } catch (e) { plainDailyCount = 0; plainRestoreCount = 0; }

      let state, warning;
      if (encrypted) {
        state = 'encrypted';
        warning = plainDailyCount
          ? 'В папката с резервните копия все още стоят некриптирани дневни копия отпреди включването на защитата.'
          : null;
      } else if (failure) {
        state = 'failed';
        warning = 'Опитът днешното копие да се криптира не се получи: ' + failure.message + '. '
          + (today && !today.encrypted
            ? 'На диска стои копие в ЧИСТ ТЕКСТ (' + today.path + ') с имената, адресите, телефоните и ЕГН '
              + 'на читателите. '
            : '')
          + 'Направете ръчно криптирано копие („Направи резервно копие“ с парола) и вижте одитната следа.';
      } else if (!configured) {
        state = 'off';
        warning = 'Автоматичните дневни копия НЕ са криптирани и съдържат личните данни на читателите '
          + '(имена, адреси, телефони, ЕГН). Включете „Защита на лични данни“ в „Настройки“, '
          + 'за да се криптират и те, особено ако папката с базата е в мрежа.';
      } else if (!unlocked) {
        state = 'locked';
        warning = 'Автоматичните дневни копия не се криптират, докато защитата на личните данни е заключена. '
          + 'Отключете я от „Настройки“, за да се криптират с нейната парола.';
      } else {
        // Защитата е отключена, но днешният файл е в чист текст и няма записан
        // провал — например копие, направено от друга програма/сесия.
        state = 'failed';
        warning = 'Днешното автоматично копие е в ЧИСТ ТЕКСТ (' + (today ? today.path : '') + '), '
          + 'въпреки че защитата на личните данни е отключена. Заключете и отключете защитата, '
          + 'за да бъде презаписано криптирано.';
      }
      /* ВЪЗРАСТТА на най-новото копие — независимо дали е дневно, междинно или
         ръчно. Дотук картата в „Настройки“ отговаряше само на въпроса „криптират
         ли се копията“ и мълчеше по далеч по-важния: „ИМА ЛИ изобщо скорошно
         копие“. Компютър, който не е рестартиран от вторник, или папка, в която
         нищо не се е записало заради пълен диск, изглеждаха съвършено наред.
         Числото се смята тук, а изгледът само го показва в червено. */
      let newest = null;
      try {
        const dir = backupsDir();
        for (const f of fs.readdirSync(dir)) {
          if (!/\.(db|invbak)$/.test(f)) continue;
          let st;
          try { st = fs.statSync(path.join(dir, f)); } catch (e) { continue; }
          if (!newest || st.mtimeMs > newest.mtime) {
            newest = { name: f, path: path.join(dir, f), mtime: st.mtimeMs, size: st.size };
          }
        }
      } catch (e) { newest = null; }
      const ageDays = newest ? (Date.now() - newest.mtime) / 86400000 : null;
      // „По-старо от 2 дни“ е прагът от заданието: библиотека работи и събота,
      // тоест копие отпреди повече от два дни вече значи пропуснат работен ден.
      const stale = !newest || ageDays > 2;

      /* Втората папка: има ли зададена, стигна ли дотам последното копие и ако
         не — защо. Ако не е зададена, това НЕ е грешка (програмата работи както
         досега), но се казва, за да не остане човек с впечатлението, че копията
         са на две места, когато са на едно. */
      const secondFolder = secondBackupFolder();
      let secondAvailable = null;
      if (secondFolder) {
        try { secondAvailable = fs.existsSync(secondFolder); } catch (e) { secondAvailable = false; }
      }
      const second = {
        folder: secondFolder,
        configured: !!secondFolder,
        available: secondAvailable,
        last: lastSecondCopy,
        canConfigure: typeof updateConfig === 'function'
      };

      /* plainDailyCount и plainRestoreCount се смятат по-горе: едно число е
         по-разбираемо от общото „копията не са криптирани“ и не е поредното
         натрапчиво съобщение, което библиотекарят се научава да пропуска. Двата
         вида се броят ОТДЕЛНО — предпазното копие отпреди възстановяване не бива
         да се предлага за изтриване (виж performRestore). */
      return {
        encrypted,
        state,
        pdpConfigured: configured,
        pdpUnlocked: unlocked,
        today,
        plainDailyCount,
        plainRestoreCount,
        last: lastAutoBackup,
        failure,
        warning,
        newest,
        ageDays,
        stale,
        lastAttempt: lastAutoAttempt,
        keepPolicy: { dailyDays: AUTO_BACKUP_KEEP_DAYS, weeklyDays: AUTO_BACKUP_WEEKLY_DAYS, monthlyDays: AUTO_BACKUP_MONTHLY_DAYS },
        second
      };
    })
  );

  function backupTimestamp() {
    return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  }

  ipcMain.handle('backup:list', () =>
    run(() => {
      const dir = backupsDir();
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.db') || f.endsWith('.invbak'))
        .map(f => {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          return {
            name: f, path: full, size: st.size, mtime: st.mtimeMs,
            auto: f.startsWith('auto-'), encrypted: isEncryptedBackup(full)
          };
        })
        .sort((a, b) => b.mtime - a.mtime);
    })
  );

  ipcMain.handle('backup:now', async (e, opts) => {
    try {
      const password = opts && opts.password ? String(opts.password) : '';
      const ext = password ? 'invbak' : 'db';
      const defaultPath = path.join(backupsDir(), `Inventar-backup-${backupTimestamp()}.${ext}`);
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Направи резервно копие (може да е и на USB/мрежов диск за пренасяне на друг компютър)',
        defaultPath,
        filters: password
          ? [{ name: 'Криптирано резервно копие', extensions: ['invbak'] }]
          : [{ name: 'SQLite база данни', extensions: ['db'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      doBackupTo(filePath, password);
      logAudit('Резервно копие', (password ? 'ръчно криптирано копие: ' : 'ръчно копие: ') + filePath);
      return { ok: true, data: filePath, encrypted: !!password };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ПРОВЕРКИ ПРЕДИ ПОДМЯНАТА. Дотук тук лягаше какъвто и да е файл: нямаше нито
     проверка на заглавието „SQLite format 3“, нито пробно отваряне, нито поглед
     към версията на схемата — а диалогът „Избери файл“ отгоре на всичко
     предлагаше филтър „Всички файлове“ (махнат по-долу). Едно щракване върху
     съседния PDF, върху половин файл от прекъснато копиране по мрежата или върху
     копие от ПО-НОВА версия на програмата подменяше library.db и програмата
     спираше да тръгва — а екранът „Настройки“ → „Резервни копия“, откъдето се
     възстановява, живее ВЪТРЕ в програмата, тоест изходът се затваря заедно с
     нея. Затова тук: трите проверки стават ПРЕДИ да се пипне какъвто и да е
     файл, и при проблем не се променя нищо. */
  function assertRestorable(realSource) {
    const problem = sqliteProblem(realSource);
    if (problem) {
      throw new Error('Избраният файл не може да бъде възстановен: ' + problem
        + '. Базата данни на библиотеката НЕ е променяна. Изберете файл от списъка с резервните копия '
        + '(auto-… или Inventar-backup-…).');
    }
    /* Версията на схемата. Копие, направено от ПО-НОВА версия на InvLib (другото
       работно място вече е обновено), се отваря без грешка, но веднага след
       рестарта пазачът assertSchemaNotNewer() спира програмата — и то вече ВЪРХУ
       подменената база, тоест библиотекарят остава и без старите данни, и без
       работеща програма. По-добре откажи сега, докато всичко е на място. */
    const known = Number(typeof currentSchemaVersion === 'function' ? currentSchemaVersion() : currentSchemaVersion);
    if (!Number.isFinite(known)) return; // модулът е зареден без тази зависимост (тестове) — останалите проверки важат
    let ro = null, v = null;
    try {
      ro = new Database(realSource, { readonly: true, fileMustExist: true });
      v = ro.pragma('user_version', { simple: true });
    } catch (e) {
      return; // sqliteProblem() вече мина — ако версията не се чете, не спираме заради това
    } finally {
      if (ro) { try { ro.close(); } catch (e) { /* проверката приключи */ } }
    }
    if (Number.isFinite(v) && v > known) {
      throw new Error('Това резервно копие е направено с ПО-НОВА версия на програмата (версия на схемата '
        + v + ', а тази инсталация познава до ' + known + '). Възстановяването е спряно и базата данни '
        + 'НЕ е променяна — иначе програмата нямаше да тръгне след това. Обновете InvLib на този компютър '
        + 'и опитайте пак.');
    }
  }

  function performRestore(sourcePath, password) {
    let realSource = sourcePath;
    let tmpToClean = null;
    if (isEncryptedBackup(sourcePath)) {
      if (!password) throw new Error('Файлът е криптиран — необходима е парола.');
      realSource = decryptBackupToTemp(sourcePath, password);
      tmpToClean = realSource;
    }
    /* Проверките са ПЪРВОТО нещо — преди предпазното копие, преди затварянето на
       базата, преди какъвто и да е запис. Разшифрованият временен файл се чисти и
       при отказ, защото съдържа ЕГН-тата на всички читатели. */
    try {
      assertRestorable(realSource);
    } catch (err) {
      if (tmpToClean) { try { fs.unlinkSync(tmpToClean); } catch (e) { /* ще го изчисти системата */ } }
      throw err;
    }
    /* Предпазното копие се КРИПТИРА, когато паролата е налична (одит v2.4.24).
       Дотук тук се записваше пълна база в чист текст — трайно, в папката с копията,
       която по документиран сценарий е споделена в мрежата. Точно този файл
       противоречеше на цялото останало поведение на модула (виж местенето на
       временния plaintext извън папката по-горе и триенето на „голото“ копие след
       криптиране); при това не се чистеше от pruneOldAutoBackups, не се хващаше от
       reencryptOldBackups и не влизаше в plainDailyCount, тоест всяко възстановяване
       оставяше по още един невидим регистър с ЕГН-та. */
    const safetyPw = autoBackupPassword();
    // Криптирано ли се ОКАЗА предпазното копие — при резервната пътека по-долу не е.
    let safetyEncrypted = !!safetyPw;
    let safetyPath = path.join(backupsDir(),
      `before-restore-${backupTimestamp()}.` + (safetyPw ? 'invbak' : 'db'));
    const db = getDb();
    if (db) { db.pragma('wal_checkpoint(TRUNCATE)'); }
    const activePath = resolveDbPath();
    if (fs.existsSync(activePath)) {
      try {
        if (safetyPw) doBackupTo(safetyPath, safetyPw);
        else fs.copyFileSync(activePath, safetyPath);
      } catch (err) {
        safetyEncrypted = false;
        /* ВНИМАНИЕ КЪМ РЕДА: doBackupTo вече проверява записаното с
           integrity_check — а предпазното копие се прави точно когато базата
           най-вероятно е ПОВРЕДЕНА (заради това се и възстановява). Проверката
           не бива да блокира спасяването: при отказ се пази суров байт по байт
           препис на текущия файл, колкото и да е повреден. По-добре половин база
           настрани, отколкото никаква — от повреден файл понякога се вадят данни,
           а от изтрит — никога. */
        try { if (fs.existsSync(safetyPath)) fs.unlinkSync(safetyPath); } catch (e) { /* нищо за чистене */ }
        safetyPath = path.join(backupsDir(), `before-restore-${backupTimestamp()}-povredena.db`);
        fs.copyFileSync(activePath, safetyPath);
        try {
          logAudit('Резервно копие', 'предпазното копие преди възстановяване не можа да бъде направено по обичайния '
            + 'начин (' + err.message + ') — текущият файл е запазен суров в „' + safetyPath + '“. '
            + 'Ако защитата на личните данни е включена, този файл НЕ е криптиран.');
        } catch (e) { /* одитът е в същата база — може и да не се запише */ }
      }
    }

    /* Редът тук е важен. Досега базата се затваряше ПРЕДИ копирането върху нея: ако
       копирането се провалеше (пълен диск, изчезнал файл, прекъснат мрежов дял),
       програмата оставаше с db === null и напълно неработеща, а активният файл — вероятно
       отрязан наполовина. Сега новото копие първо се записва настрани, докато базата още
       работи (провал на този етап не променя нищо), и чак след това се затваря и се прави
       преименуване — операция на едно и също устройство, която е атомарна. При провал се
       връща предпазното копие. */
    const stagedPath = activePath + '.restore-tmp';
    try {
      fs.copyFileSync(realSource, stagedPath);
    } catch (err) {
      try { fs.unlinkSync(stagedPath); } catch (e) { /* нищо за чистене */ }
      throw new Error('Копието не можа да бъде подготвено — базата не е променяна: ' + err.message);
    }
    if (db) { db.close(); setDb(null); }
    try {
      fs.renameSync(stagedPath, activePath);
    } catch (err) {
      /* Връщането минава през разшифроване, ако предпазното копие е криптирано —
         иначе на мястото на базата би легнал криптиран блок и програмата не би
         тръгнала изобщо. */
      try {
        if (fs.existsSync(safetyPath)) {
          if (safetyEncrypted) {
            const back = decryptBackupToTemp(safetyPath, safetyPw);
            fs.copyFileSync(back, activePath);
            try { fs.unlinkSync(back); } catch (e2) { /* временният файл ще се изчисти от системата */ }
          } else {
            fs.copyFileSync(safetyPath, activePath);
          }
        }
      } catch (e) { /* виж съобщението долу */ }
      try { fs.unlinkSync(stagedPath); } catch (e) { /* нищо за чистене */ }
      throw new Error('Възстановяването се провали и предишната база беше върната на място. '
        + 'Предпазното копие е запазено в „' + safetyPath + '“'
        + (safetyEncrypted ? ' и е КРИПТИРАНО с паролата за защита на личните данни' : '')
        + '. Грешка: ' + err.message);
    }
    if (tmpToClean) { try { fs.unlinkSync(tmpToClean); } catch (e) { /* временният файл ще се изчисти от системата */ } }
    app.relaunch();
    app.exit(0);
  }

  ipcMain.handle('backup:restoreFromList', (e, { path: sourcePath, password }) =>
    run(() => {
      // Пътят идва от renderer-а. Приема се само ако наистина е файл от папката с
      // резервните копия — тоест нещо, което backup:list е показал; всичко друго е
      // произволен файл, инсталиран като активна база.
      if (!isInBackupsDir(sourcePath)) {
        throw new Error('Може да се възстановява само резервно копие от папката с резервните копия на програмата. '
          + 'За файл от друго място (USB, мрежов диск) ползвайте „Избери файл“.');
      }
      if (!fs.existsSync(sourcePath)) throw new Error('Файлът с резервното копие не е намерен.');
      if (isEncryptedBackup(sourcePath) && !password) return { needsPassword: true, path: sourcePath };
      performRestore(sourcePath, password);
      return { needsPassword: false };
    })
  );

  ipcMain.handle('backup:restoreBrowse', async (e, opts) => {
    try {
      let target = opts && opts.path;
      if (target) {
        /* Второ извикване на същия handler — интерфейсът връща пътя заедно с
           паролата за криптиран файл. Приема се само път, който main процесът вече
           е одобрил: избран със системния диалог в тази сесия или от папката с
           резервните копия. Иначе „избери файл“ би бил заобиколим с обикновен низ. */
        if (!isApprovedSource(target)) {
          throw new Error('Файлът трябва да бъде избран през диалога „Избери файл“ на програмата.');
        }
      } else {
        const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
          title: 'Изберете файл с резервно копие за възстановяване',
          properties: ['openFile'],
          /* „Всички файлове“ е МАХНАТО. Този диалог не отваря файл за четене — той
             избира какво да легне НА МЯСТОТО на базата на библиотеката. Свободният
             филтър превръщаше едно невнимателно щракване (съседният PDF, .zip,
             .xlsx) в неработеща програма. Проверките в performRestore ловят и
             преименуван файл, но по-добре изобщо да не се предлага. */
          filters: [
            { name: 'Резервни копия (.db, .invbak)', extensions: ['db', 'invbak'] }
          ]
        });
        if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
        target = filePaths[0];
        dialogApprovedPaths.add(normPath(target)); // одобрено от самия потребител през диалога
      }
      const password = opts && opts.password ? String(opts.password) : '';
      if (isEncryptedBackup(target) && !password) {
        return { ok: true, data: { needsPassword: true, path: target } };
      }
      performRestore(target, password);
      return { ok: true, data: { needsPassword: false } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ---------------- Втора папка за копие (незадължителна) ----------------
     Три канала, а не едно поле в „Настройки“: пътят се избира със системния
     диалог, за да няма сгрешено написан път, който мълчаливо не работи. */
  ipcMain.handle('backup:secondFolder', () =>
    run(() => {
      const folder = secondBackupFolder();
      let available = null;
      if (folder) { try { available = fs.existsSync(folder); } catch (e) { available = false; } }
      return { folder, configured: !!folder, available, last: lastSecondCopy, canConfigure: typeof updateConfig === 'function' };
    })
  );
  ipcMain.handle('backup:chooseSecondFolder', async () => {
    try {
      if (typeof updateConfig !== 'function') {
        throw new Error('Тази версия на програмата не може да запише настройката за втора папка.');
      }
      const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Изберете втора папка за резервните копия (USB, външен диск или мрежов дял)',
        properties: ['openDirectory', 'createDirectory']
      });
      if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
      const folder = filePaths[0];
      /* Втората папка ВЪТРЕ в първата не пази от нищо — целият смисъл е копието
         да оцелее, когато дискът с базата си отиде. */
      if (normPath(folder) === normPath(backupsDir()) || normPath(folder) === normPath(resolveDbDir())) {
        return { ok: false, error: 'Изберете папка на ДРУГ диск (USB, външен диск, мрежов дял). '
          + 'Втора папка до самата база не пази от нищо — един повреден диск отнася и базата, и копията.' };
      }
      if (!updateConfig((cfg) => { cfg.backupFolder2 = folder; })) {
        return { ok: false, error: 'Настройките (config.json) не можаха да бъдат записани, затова втората папка '
          + 'НЕ беше запомнена. Копията продължават да се правят в папката до базата.' };
      }
      logAudit('Резервно копие', 'зададена е втора папка за резервните копия: ' + folder);
      // Веднага дублира последното копие, за да не се чака до утре сутринта.
      const last = lastAutoBackup && lastAutoBackup.path && fs.existsSync(lastAutoBackup.path)
        ? lastAutoBackup.path : null;
      if (last) mirrorToSecondFolder(last);
      return { ok: true, data: { folder, copied: last ? !!(lastSecondCopy && lastSecondCopy.ok) : false } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('backup:clearSecondFolder', () =>
    run(() => {
      if (typeof updateConfig !== 'function') {
        throw new Error('Тази версия на програмата не може да промени настройката за втора папка.');
      }
      if (!updateConfig((cfg) => { delete cfg.backupFolder2; })) {
        throw new Error('Настройките (config.json) не можаха да бъдат записани — втората папка остава зададена.');
      }
      lastSecondCopy = null;
      logAudit('Резервно копие', 'втората папка за резервните копия е премахната');
      return true;
    })
  );

  return { autoBackupIfNeeded, startAutoBackupTimer, stopAutoBackupTimer, backupBeforeQuit, checkDbFile: sqliteProblem };
};
