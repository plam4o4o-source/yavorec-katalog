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

  /* КАК СЕ СГЛОБЯВА ФАЙЛЪТ — и защо не се вграждат пътища в cmd.

     Пътищата тук идват от компютъра и от базата (catalog_folder), а базата по
     документиран сценарий стои на споделен мрежов дял. Първата версия на този
     модул ги слепваше в реда на batch файла, вътре в двойно цитиран аргумент на
     cmd.exe — но там оцеляват `"` (затваря цитирането и прави `&` разделител на
     команди) и `%` (разширява се ДОРИ вътре в кавичките). Файлът се пуска като
     администратор, тоест това е инжекция с пълни права.

     Опитът да се затвори с „чист ASCII“ беше по-лош от проблема: при запис с
     кодировка ascii Node маскира всеки знак до 7 бита, а българските папки са
     неизбежни (Библиотека, Каталог, Копия). „К“ става байт 0x1A — маркерът за
     КРАЙ НА BATCH ФАЙЛ, тоест скриптът се отрязва по средата; „Ц“ става `&`;
     „Х“ става `%`. Тоест самото маскиране внасяше метазнаците обратно, при това
     под проверката, която ги отхвърля.

     Затова пътищата ИЗОБЩО НЕ МИНАВАТ през cmd. Целият полезен товар е скрипт
     на PowerShell, кодиран в UTF-16LE и base64, подаден с -EncodedCommand.
     Base64 е чист ASCII, тоест batch файлът наистина е ASCII (и няма нужда от
     chcp, което на този компютър вече веднъж даде нацепен изход), а PowerShell
     получава пътищата непокътнати, каквато и азбука да ползват. Единственото
     екраниране, което остава, е удвояването на единичната кавичка вътре в
     PowerShell низ — и то вече няма нищо общо с cmd. */
  function psQuote(v) { return String(v).replace(/'/g, "''"); }
  /* Остават забранени само знаци, които не могат да се появят в истински път и
     биха счупили самия PowerShell низ. `&`, `%`, `^` и подобните вече са
     безобидни, защото не минават през cmd — а те са напълно законни в имена на
     папки под Windows (в „Читалище & библиотека“ например). */
  const UNSAFE_IN_PATH = /[\r\n\x00-\x1F\x7F]/;
  function pathIsSafe(v) { return typeof v === 'string' && !!v.trim() && !UNSAFE_IN_PATH.test(v); }

  function buildPowerShell(dirs, exePath) {
    const list = dirs.map(d => "'" + psQuote(d) + "'").join(",\n    ");
    return [
      "$ErrorActionPreference = 'Continue'",
      // Конзолата да покаже кирилицата вярно; при стара конзола това просто не успява.
      "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}",
      "$ok = 0; $fail = 0",
      "Write-Host 'Добавяне на изключения в Windows Defender...'",
      "$paths = @(",
      "    " + list,
      ")",
      "foreach ($p in $paths) {",
      "  try { Add-MpPreference -ExclusionPath $p -ErrorAction Stop; $ok++; Write-Host ('  добавена папка: ' + $p) }",
      "  catch { $fail++; Write-Host ('  НЕУСПЕШНО: ' + $p + ' -- ' + $_.Exception.Message) }",
      "}",
      "try { Add-MpPreference -ExclusionProcess '" + psQuote(path.basename(exePath)) + "' -ErrorAction Stop; $ok++ }",
      "catch { $fail++; Write-Host '  НЕУСПЕШНО: изключение за самата програма' }",
      // Controlled Folder Access („Защита от рансъмуер“) блокира записа в Documents
      // дори при добавена папка-изключение — програмата трябва да е разрешено приложение.
      "try { Add-MpPreference -ControlledFolderAccessAllowedApplications '" + psQuote(exePath) + "' -ErrorAction Stop; $ok++ }",
      "catch { $fail++; Write-Host '  НЕУСПЕШНО: разрешение при защита от рансъмуер' }",
      "Write-Host ''",
      /* Резултатът се отчита честно. Дотук се печаташе „Готово. Изключенията са
         добавени.“ безусловно — всяка от командите можеше да е отказала. */
      "if ($fail -eq 0) { Write-Host ('Готово. Добавени са ' + $ok + ' изключения.') }",
      "else { Write-Host ('ВНИМАНИЕ: добавени ' + $ok + ', НЕУСПЕШНИ ' + $fail + '.');",
      "       Write-Host 'Добавете неуспешните на ръка: Защита от Windows -> Защита срещу вируси и заплахи -> Изключения.' }",
      "Write-Host 'Ако ползвате друга антивирусна (Avast, ESET и др.), добавете същите папки и в нея.'"
    ].join('\n');
  }

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
    const safe = [...dirs].filter(pathIsSafe);
    const rejected = [...dirs].filter(d => !pathIsSafe(d));

    const encoded = Buffer.from(buildPowerShell(safe, exePath), 'utf16le').toString('base64');
    const lines = [
      '@echo off',
      'net session >nul 2>&1',
      'if %errorlevel% neq 0 (',
      '  echo This file must be run as Administrator:',
      '  echo right-click the file, then "Run as administrator".',
      '  pause',
      '  exit /b 1',
      ')',
      // Единствената команда: целият полезен товар е вътре в base64, тоест нищо
      // от съдържанието на базата не минава през синтаксиса на cmd.
      /* БЕЗ -ExecutionPolicy Bypass. При -EncodedCommand политиката така или
         иначе не важи (тя се отнася за скриптови ФАЙЛОВЕ), тоест ключът не прави
         нищо — но заедно с -NoProfile и -EncodedCommand допълва точно подписа,
         по който Defender („Block execution of potentially obfuscated scripts“),
         SmartScreen и чужди антивирусни разпознават замаскиран PowerShell. Това е
         единственият файл в програмата, чиято цел е да ОЦЕЛЕЕ пред недоволна
         антивирусна. */
      'echo Adding Windows Defender exclusions. Please wait...',
      'powershell -NoProfile -EncodedCommand ' + encoded
    ];
    if (rejected.length) {
      lines.push('echo.');
      lines.push('echo NOTE: ' + rejected.length + ' folder(s) could not be added automatically.');
      lines.push('echo Add them by hand: Windows Security, Virus and threat protection, Exclusions.');
      lines.push('echo Their names are listed in the program, under Settings.');
    }
    lines.push('pause');
    return { content: lines.join('\r\n') + '\r\n', dirs: [...dirs], safe, rejected, exe: exePath };
  }
  ipcMain.handle('security:exclusionInfo', () =>
    run(() => {
      const b = buildAvExclusionScript();
      // `dirs` е пълният списък (какъвто беше и досега), `safe`/`rejected` казват
      // кои от тях ще влязат автоматично — екранът показва и двете.
      return { dirs: b.dirs, safe: b.safe, rejected: b.rejected, exe: b.exe };
    })
  );
  ipcMain.handle('security:writeExclusionScript', async () => {
    try {
      const b = buildAvExclusionScript();
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Запишете скрипта за изключения в Defender',
        defaultPath: 'InvLib-Defender-izklyuchenia.bat',
        filters: [{ name: 'Команден файл', extensions: ['bat'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      // 'latin1' записва байт по байт това, което вече е чист ASCII — без BOM и
      // без превръщане, което cmd да разчете погрешно.
      fs.writeFileSync(filePath, Buffer.from(b.content, 'latin1'));
      logAudit('Антивирусна защита', 'генериран скрипт за изключения: ' + filePath
        + (b.rejected.length ? ' (' + b.rejected.length + ' папки не можаха да влязат автоматично)' : ''));
      return { ok: true, data: filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });
};
