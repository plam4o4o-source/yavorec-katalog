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
    run, logAudit, resolveDbDir, resolveDbPath
  } = deps;
  const { isEncryptedBackup, encryptBackupFile, decryptBackupBuffer } = require('../backup-crypto');
  const pii = require('../pii-crypto');
  const crypto = require('crypto'); // само за отпечатък на паролата в паметта, виж todayEncryptedWith

  const AUTO_BACKUP_KEEP_DAYS = 30;

  function backupsDir() {
    const dir = path.join(resolveDbDir(), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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
  function doBackupTo(destPath, password) {
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
    const plainTmp = destPath + '.plain-tmp';
    try {
      fs.writeFileSync(plainTmp, snapshot);
      encryptBackupFile(plainTmp, destPath, password);
    } finally {
      try { fs.unlinkSync(plainTmp); } catch (e) { /* временен файл — не е фатално, ако остане */ }
    }
  }

  function pruneOldAutoBackups() {
    const dir = backupsDir();
    const cutoff = Date.now() - AUTO_BACKUP_KEEP_DAYS * 86400000;
    fs.readdirSync(dir).forEach(f => {
      if (!f.startsWith('auto-')) return;
      const full = path.join(dir, f);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch (e) { /* игнорирай */ }
    });
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
    const staged = encDest + '.tmp';
    try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (e) { /* ще гръмне по-долу, ако наистина пречи */ }
    try {
      doBackupTo(staged, password); // от живата база — тя е поне толкова нова
      if (!opensWith(staged, password)) {
        throw new Error('новото копие не се отваря с паролата за защита на личните данни');
      }
      fs.renameSync(staged, encDest);
    } catch (err) {
      try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (e) { /* нищо за чистене */ }
      throw err;
    }
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

  function recordAutoBackupFailure(date, message, detail) {
    lastAutoBackupError = { date, message, at: new Date().toISOString() };
    try { logAudit('Резервно копие', detail); } catch (e) { /* одитът не бива да проваля копието */ }
    notifyAutoBackup('err', 'Днешното резервно копие НЕ можа да бъде криптирано: ' + message
      + ' Копието съдържа лични данни на читателите в чист текст — вижте „Настройки“ → „Резервно копие“.');
  }

  function autoBackupIfNeeded() {
    try {
      const { date: today, plainDest, encDest } = todayPaths();
      if (fs.existsSync(plainDest) || fs.existsSync(encDest)) return;
      const password = autoBackupPassword();
      if (password) {
        /* Провалено криптиране не бива да остави деня БЕЗ копие: вписва се,
           съобщава се и се пада към некриптирано копие (по-долу). */
        try {
          writeEncryptedDaily(encDest, null, password);
          pruneOldAutoBackups();
          lastAutoBackup = { path: encDest, encrypted: true, date: today };
          lastAutoBackupError = null;
          todayEncryptedWith = { date: today, fp: fingerprint(password) };
          logAudit('Резервно копие', 'автоматично криптирано копие: ' + encDest
            + ' (с паролата за защита на личните данни)');
          console.log('Автоматично резервно копие:', encDest, '(криптирано)');
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
      lastAutoBackup = { path: plainDest, encrypted: false, date: today };
      /* Авто-копието съдържа ЦЕЛИЯ фонд от лични данни на читателите — адреси и
         телефони винаги в чист текст, ЕГН в чист текст, ако защитата не е
         включена — и стои 30 дни в папката на базата, която по документиран
         сценарий е споделен мрежов дял. Затова провалът да се криптира не минава
         тихо: вписва се в одитната следа и се показва в интерфейса. */
      logAudit('Резервно копие', 'ВНИМАНИЕ: автоматичното копие ' + plainDest
        + ' НЕ е криптирано и съдържа лични данни на читателите. Включете „Защита на лични данни“ '
        + 'в „Настройки“ и я дръжте отключена, за да се криптират и дневните копия.');
      console.log('Автоматично резервно копие:', plainDest, '(некриптирано)');
    } catch (err) {
      console.error('Автоматично резервно копие — грешка:', err.message);
    }
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
    lastAutoBackup = { path: encDest, encrypted: true, date: today };
    lastAutoBackupError = null;
    todayEncryptedWith = { date: today, fp };
    logAudit('Резервно копие', 'автоматичното копие за деня е презаписано криптирано '
      + why + ': ' + encDest);
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
      files = fs.readdirSync(dir).filter(f => /^auto-\d{4}-\d{2}-\d{2}\.invbak$/.test(f));
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
        if (!opensWith(staged, password)) throw new Error('новото копие не се отваря с новата парола');
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
      // Вчерашен провал не описва днешното състояние.
      const failure = lastAutoBackupError && lastAutoBackupError.date === date ? lastAutoBackupError : null;
      // Ако за днес още няма файл (копието се прави при стартиране), се пада към
      // намерението — какво ЩЕ стане при следващото копие.
      const encrypted = today ? today.encrypted : (configured && unlocked);

      let state, warning;
      if (encrypted) {
        state = 'encrypted';
        warning = null;
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
      /* Колко НЕкриптирани дневни копия стоят на диска в момента. Одитът отбеляза,
         че 30-те копия при изключена защита са пълен регистър от лични данни в
         незащитен файл, често на споделен мрежов дял. Едно число е по-разбираемо
         от общото „копията не са криптирани“ и не е поредното натрапчиво
         съобщение, което библиотекарят се научава да пропуска. */
      let plainDailyCount = 0;
      try {
        plainDailyCount = fs.readdirSync(backupsDir())
          .filter(f => f.startsWith('auto-') && f.endsWith('.db')).length;
      } catch (e) { plainDailyCount = 0; }
      return {
        encrypted,
        state,
        pdpConfigured: configured,
        pdpUnlocked: unlocked,
        today,
        plainDailyCount,
        last: lastAutoBackup,
        failure,
        warning
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

  function performRestore(sourcePath, password) {
    let realSource = sourcePath;
    let tmpToClean = null;
    if (isEncryptedBackup(sourcePath)) {
      if (!password) throw new Error('Файлът е криптиран — необходима е парола.');
      realSource = decryptBackupToTemp(sourcePath, password);
      tmpToClean = realSource;
    }
    const safetyPath = path.join(backupsDir(), `before-restore-${backupTimestamp()}.db`);
    const db = getDb();
    if (db) { db.pragma('wal_checkpoint(TRUNCATE)'); }
    const activePath = resolveDbPath();
    if (fs.existsSync(activePath)) fs.copyFileSync(activePath, safetyPath);

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
      try { if (fs.existsSync(safetyPath)) fs.copyFileSync(safetyPath, activePath); } catch (e) { /* виж съобщението долу */ }
      try { fs.unlinkSync(stagedPath); } catch (e) { /* нищо за чистене */ }
      throw new Error('Възстановяването се провали и предишната база беше върната на място. '
        + 'Предпазното копие е запазено в „' + safetyPath + '“. Грешка: ' + err.message);
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
          filters: [
            { name: 'Резервни копия (.db, .invbak)', extensions: ['db', 'invbak'] },
            { name: 'Всички файлове', extensions: ['*'] }
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

  return { autoBackupIfNeeded };
};
