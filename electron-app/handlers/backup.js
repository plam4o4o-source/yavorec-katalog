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

  function doBackupTo(destPath, password) {
    const db = getDb();
    if (db) db.pragma('wal_checkpoint(TRUNCATE)');
    if (password) encryptBackupFile(resolveDbPath(), destPath, password);
    else fs.copyFileSync(resolveDbPath(), destPath);
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

  function autoBackupIfNeeded() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dir = backupsDir();
      const plainDest = path.join(dir, `auto-${today}.db`);
      const encDest = path.join(dir, `auto-${today}.invbak`);
      if (fs.existsSync(plainDest) || fs.existsSync(encDest)) return;
      const password = autoBackupPassword();
      const dest = password ? encDest : plainDest;
      doBackupTo(dest, password);
      pruneOldAutoBackups();
      lastAutoBackup = { path: dest, encrypted: !!password, date: today };
      if (password) {
        logAudit('Резервно копие', 'автоматично криптирано копие: ' + dest
          + ' (с паролата за защита на личните данни)');
      } else {
        /* Авто-копието съдържа ЦЕЛИЯ фонд от лични данни на читателите — адреси и
           телефони винаги в чист текст, ЕГН в чист текст, ако защитата не е
           включена — и стои 30 дни в папката на базата, която по документиран
           сценарий е споделен мрежов дял. Затова провалът да се криптира не минава
           тихо: вписва се в одитната следа и се показва в интерфейса. */
        logAudit('Резервно копие', 'ВНИМАНИЕ: автоматичното копие ' + dest
          + ' НЕ е криптирано и съдържа лични данни на читателите. Включете „Защита на лични данни“ '
          + 'в „Настройки“ и я дръжте отключена, за да се криптират и дневните копия.');
      }
      console.log('Автоматично резервно копие:', dest, password ? '(криптирано)' : '(некриптирано)');
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
  function upgradeTodayAutoBackup() {
    const password = autoBackupPassword();
    if (!password) return;
    const today = new Date().toISOString().slice(0, 10);
    const dir = backupsDir();
    const encDest = path.join(dir, `auto-${today}.invbak`);
    if (fs.existsSync(encDest)) return; // вече е криптирано
    const plainDest = path.join(dir, `auto-${today}.db`);
    if (!fs.existsSync(plainDest)) { autoBackupIfNeeded(); return; }
    // Пише се настрани и се преименува: прекъснато криптиране (пълен диск,
    // паднал мрежов дял) не бива да остави наполовина записан .invbak, който
    // изглежда като готово копие и спира следващите опити.
    const staged = encDest + '.tmp';
    try {
      doBackupTo(staged, password); // от живата база — тя е поне толкова нова
      fs.renameSync(staged, encDest);
    } catch (err) {
      try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (e) { /* нищо за чистене */ }
      throw err; // некриптираното копие остава на място — по-добре от никакво
    }
    try { fs.unlinkSync(plainDest); } catch (e) { /* остава; одитът по-долу казва какво е станало */ }
    lastAutoBackup = { path: encDest, encrypted: true, date: today };
    logAudit('Резервно копие', 'автоматичното копие за деня е презаписано криптирано след отключване '
      + 'на защитата на личните данни: ' + encDest);
  }
  pii.onSession(() => {
    try { upgradeTodayAutoBackup(); }
    catch (err) { console.error('Криптиране на дневното копие след отключване — грешка:', err.message); }
  });

  /* Състояние на автоматичното копие, готово за показване в интерфейса: дали
     дневните копия се криптират и, ако не — защо, на човешки език.
     Днес предупреждението стига до библиотекаря по вече работещия път — вписва се
     в одитната следа при всяко направено некриптирано копие и се вижда в раздел
     „Одитна следа“. Този канал е другата половина: „Резервни копия“ да го покаже
     на видно място. Остава да се добави ред в preload.js (backup.autoStatus) и
     показването в src/views — и двете са извън обхвата на тази поправка. */
  ipcMain.handle('backup:autoStatus', () =>
    run(() => {
      let configured = false;
      try {
        const db = getDb();
        const s = db ? (db.prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id = 1').get() || {}) : {};
        configured = !!(s.pdp_salt && s.pdp_verifier);
      } catch (e) { configured = false; }
      const unlocked = !!pii.getSessionPassword();
      const encrypted = configured && unlocked;
      return {
        encrypted,
        pdpConfigured: configured,
        pdpUnlocked: unlocked,
        last: lastAutoBackup,
        warning: encrypted ? null
          : (configured
            ? 'Автоматичните дневни копия не се криптират, докато защитата на личните данни е заключена. '
              + 'Отключете я от „Настройки“, за да се криптират с нейната парола.'
            : 'Автоматичните дневни копия НЕ са криптирани и съдържат личните данни на читателите '
              + '(имена, адреси, телефони, ЕГН). Включете „Защита на лични данни“ в „Настройки“, '
              + 'за да се криптират и те, особено ако папката с базата е в мрежа.')
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
