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

  const AUTO_BACKUP_KEEP_DAYS = 30;

  function backupsDir() {
    const dir = path.join(resolveDbDir(), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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

  function autoBackupIfNeeded() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dest = path.join(backupsDir(), `auto-${today}.db`);
      if (!fs.existsSync(dest)) {
        doBackupTo(dest);
        pruneOldAutoBackups();
        console.log('Автоматично резервно копие:', dest);
      }
    } catch (err) {
      console.error('Автоматично резервно копие — грешка:', err.message);
    }
  }

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
      if (!fs.existsSync(sourcePath)) throw new Error('Файлът с резервното копие не е намерен.');
      if (isEncryptedBackup(sourcePath) && !password) return { needsPassword: true, path: sourcePath };
      performRestore(sourcePath, password);
      return { needsPassword: false };
    })
  );

  ipcMain.handle('backup:restoreBrowse', async (e, opts) => {
    try {
      let target = opts && opts.path;
      if (!target) {
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
