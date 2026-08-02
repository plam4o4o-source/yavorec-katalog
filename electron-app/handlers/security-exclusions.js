// Помощ срещу антивирусни блокировки — извадено от main.js в отделен модул
// (Фаза 4, стъпка 36). Докато инсталаторът е без закупен цифров подпис,
// Defender и други антивирусни спират както инсталирането, така и работата
// на вече инсталираната програма — най-често като заключват записа в базата
// данни, резервните копия или папката на каталога. Скриптът по-долу добавя
// изключенията наведнъж; пуска се веднъж, като администратор. Съдържанието
// се показва на екрана преди записване, за да се вижда какво точно ще бъде
// изключено.
module.exports = function registerSecurityExclusionsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, dialog, getMainWindow, fs, path, app, resolveDbDir } = deps;

  function psQuote(v) { return String(v).replace(/'/g, "''"); }
  function buildAvExclusionScript() {
    const db = getDb();
    const exePath = process.execPath;
    const dirs = new Set([
      path.dirname(exePath),          // папката на програмата
      app.getPath('userData'),        // база данни, настройки, резервни копия
      resolveDbDir()                  // мрежова папка, ако базата е преместена
    ]);
    try {
      const s = db.prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
      if (s && s.catalog_folder) dirs.add(s.catalog_folder); // работното копие на каталога
    } catch (e) {}
    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      'net session >nul 2>&1',
      'if %errorlevel% neq 0 (',
      '  echo Този файл трябва да се изпълни като администратор:',
      '  echo десен бутон върху файла - "Изпълни като администратор".',
      '  pause',
      '  exit /b 1',
      ')',
      'echo Добавяне на изключения в Windows Defender...'
    ];
    for (const d of dirs) {
      lines.push(`powershell -NoProfile -Command "Add-MpPreference -ExclusionPath '${psQuote(d)}'"`);
    }
    lines.push(
      `powershell -NoProfile -Command "Add-MpPreference -ExclusionProcess '${psQuote(path.basename(exePath))}'"`,
      // Controlled Folder Access ("Защита от рансъмуер") блокира записа в Documents
      // дори при добавена папка-изключение — програмата трябва да е разрешено приложение.
      `powershell -NoProfile -Command "Add-MpPreference -ControlledFolderAccessAllowedApplications '${psQuote(exePath)}'"`,
      'echo.',
      'echo Готово. Изключенията са добавени.',
      'echo Ако ползвате друга антивирусна (Avast, ESET и др.), добавете същите папки',
      'echo в нейните настройки за изключения.',
      'pause'
    );
    return { content: lines.join('\r\n') + '\r\n', dirs: [...dirs], exe: exePath };
  }
  ipcMain.handle('security:exclusionInfo', () =>
    run(() => {
      const b = buildAvExclusionScript();
      return { dirs: b.dirs, exe: b.exe };
    })
  );
  ipcMain.handle('security:writeExclusionScript', async () => {
    try {
      const b = buildAvExclusionScript();
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Запишете скрипта за изключения в Defender',
        defaultPath: 'Inventar-Defender-izklyuchenia.bat',
        filters: [{ name: 'Команден файл', extensions: ['bat'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      fs.writeFileSync(filePath, b.content, 'utf8');
      logAudit('Антивирусна защита', 'генериран скрипт за изключения: ' + filePath);
      return { ok: true, data: filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });
};
