// Краеведски модул: Снимки към персоналии и летопис — извадено от main.js
// в отделен модул (Фаза 4, стъпка 31). Пазят се в базата като data URI, по
// същата причина както логото: пътуват заедно с базата при резервно копие
// и при работа в мрежа. mainWindow се подава като getMainWindow() getter
// по същия модел като handlers/backup.js, защото се пресъздава при
// app.on('activate', ...).
module.exports = function registerLocalPhotoHandlers(ipcMain, deps) {
  const { getDb, run, dialog, getMainWindow, fs, path, LOGO_MIME, LOCAL_PHOTO_MAX_BYTES } = deps;
  /* Одитна следа за снимките (v2.4.61). Добавянето и махането на снимка
     променят базата и не оставяха нито един ред в дневника — а снимката на
     местен деец често е ЕДИНСТВЕНОТО копие, което съществува (сканирана е от
     хартия, която после се връща на семейството). „Махни“ е един клик и няма
     връщане назад; проверката трябва да може да каже кога е изчезнала.
     Защо не deps.logAudit: main.js подава на този модул само getDb/run/dialog/
     fs/path — без logAudit (за разлика от съседните краеведски модули). Този
     кръг не пипа main.js, затова следата се вписва направо, а когато logAudit
     бъде подаден, редът ще носи и името на служителя. */
  const logAudit = deps.logAudit || ((action, detail) => {
    try {
      getDb().prepare('INSERT INTO audit_log (user, action, detail) VALUES (?, ?, ?)')
        .run('', action, detail || '');
    } catch (err) {
      console.error('Одитният ред за краеведска снимка не можа да се запише:', err);
    }
  });
  const TABLE_NAME = { persons: 'персоналия', chronicle: 'запис в летописа' };

  /* Големината се показва ЧЕСТНО (v2.4.61). Дотук и файлът, и границата
     минаваха през Math.round(байтове/1024): файл от 1 048 577 байта (един байт
     над границата) се отказваше със съобщението „Файлът е 1024 KB, а
     максимумът е 1024 KB“. За библиотекарката това е противоречие — числата са
     равни, а програмата отказва — и няма как да разбере колко да смали. Затова
     размерът на файла се закръгля НАГОРЕ, а границата — надолу: отказаният
     файл винаги излиза поне с 1 KB по-голям от разрешеното. */
  const kbUp = (n) => Math.ceil(n / 1024);
  /* Видът на изображението по първите му байтове (виж бележката в localPhoto:choose). */
  function sniffImageMime(buf) {
    if (!buf || buf.length < 4) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
    if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
  }
  const kbDown = (n) => Math.floor(n / 1024);

  ipcMain.handle('localPhoto:choose', async (e, { table, id }) => {
    try {
      if (!['persons', 'chronicle'].includes(table)) return { ok: false, error: 'Непозната таблица.' };
      const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Изберете снимка',
        properties: ['openFile'],
        filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
      });
      if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
      const file = filePaths[0];
      const mime = LOGO_MIME[path.extname(file).toLowerCase()];
      if (!mime || mime === 'image/svg+xml') return { ok: false, error: 'Изберете PNG, JPG, GIF или WEBP.' };
      /* ЧЕТЕНЕТО НА ФАЙЛА ИМА СОБСТВЕН catch (v2.4.61).
         Дотук цялата функция беше в един try, а съобщението на грешката се
         връщаше дословно: библиотекарката получаваше „ENOENT: no such file or
         directory, open 'C:\\Users\\...'“ — английски текст на системата, който
         не казва нито какво е станало, нито какво да направи. А случаят е
         всекидневен: снимката е на флашка, която е извадена, или в мрежова
         папка, която е паднала, или е преименувана след отварянето на диалога.
         Затова четенето е отделно и познатите причини се назовават на
         български; непознатата грешка пак се показва, но с обяснение какво се е
         опитала програмата, и остава в дневника за грешки. */
      let buf;
      try {
        buf = fs.readFileSync(file);
      } catch (err) {
        console.error('Снимката не можа да бъде прочетена:', file, err);
        if (err.code === 'ENOENT') {
          return { ok: false, error: 'Файлът „' + path.basename(file) + '“ вече не е на това място. '
            + 'Ако е на флашка или в мрежова папка, проверете дали носителят е свързан, и изберете файла наново.' };
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          return { ok: false, error: 'Файлът „' + path.basename(file) + '“ не може да бъде отворен за четене — '
            + 'нямате права върху него или е отворен от друга програма.' };
        }
        return { ok: false, error: 'Файлът „' + path.basename(file) + '“ не можа да бъде прочетен: ' + err.message };
      }
      if (buf.length > LOCAL_PHOTO_MAX_BYTES) {
        return { ok: false, error: 'Файлът е ' + kbUp(buf.length) + ' KB, а максимумът е ' +
          kbDown(LOCAL_PHOTO_MAX_BYTES) + ' KB. Смалете изображението преди да го добавите.' };
      }
      /* СНИМКА Е ТОВА, КОЕТО Е ВЪТРЕ, НЕ ТОВА, КОЕТО ПИШЕ В ИМЕТО (v2.4.71, находка Д6).
         =================================================================
         (а) ДОТУК видът се познаваше само по разширението. Тестерът
         (a2-kraeved.js) подаде „falshiva.jpg“ — 44 байта текст с разширение .jpg:
         програмата каза „Снимката е добавена.“, картонът показа изображение
         0 × 0, а ИСТИНСКАТА снимка, която стоеше там, беше заменена и изгубена.
         (б) За краеведа снимката често е единственото копие (сканирана от хартия,
         която се връща на семейството) — тиха подмяна с нищо е загуба, която
         никой не забелязва, докато някой не отвори картона след години.
         (в) Проверяват се първите байтове („магическото число“) на четирите
         приети вида: PNG (89 50 4E 47), JPEG (FF D8 FF), GIF („GIF8“), WEBP
         („RIFF“ … „WEBP“). Файл, който не е нито едно от тях, се отказва и
         сегашната снимка остава непокътната. Ако съдържанието е снимка от друг
         приет вид (PNG, кръстен .jpg), се записва с истинския вид — иначе
         браузърът може да откаже да го покаже. Проверката е СЛЕД размера:
         огромният файл се отказва с по-полезното съобщение за големината. */
      const sniffed = sniffImageMime(buf);
      if (!sniffed) {
        return { ok: false, error: 'Файлът „' + path.basename(file) + '“ не е снимка — съдържанието му не е PNG, JPG, '
          + 'GIF или WEBP, въпреки разширението. Нищо не е променено' + ' — сегашната снимка (ако има) остава. '
          + 'Отворете файла с програма за снимки и го запишете наново като JPG или PNG.' };
      }
      const uri = `data:${sniffed};base64,${buf.toString('base64')}`;
      /* СНИМКА „КЪМ НИЩОТО“ НЕ Е УСПЕХ (v2.4.61).
         UPDATE по несъществуващ id не пипаше нито един ред, а каналът връщаше
         { ok: true } и екранът казваше „Снимката е добавена.“ Библиотекарката
         вижда зелено известие, затваря сканираната хартия и чак по-късно —
         може би никога — забелязва, че в картона няма снимка. При обща мрежова
         база това е точно случаят „записът е изтрит от другото работно място,
         докато картонът стоеше отворен“. */
      const info = getDb().prepare(`UPDATE ${table} SET photo = ? WHERE id = ?`).run(uri, id);
      if (!info.changes) {
        return { ok: false, error: 'Записът, към който добавяте снимката, вече не съществува — вероятно е '
          + 'изтрит от друго работно място. Снимката НЕ е запазена.' };
      }
      logAudit('Краеведски снимки', 'добавена снимка към ' + (TABLE_NAME[table] || table) + ' № ' + id
        + ' (' + kbUp(buf.length) + ' KB)');
      return { ok: true, data: uri };
    } catch (err) {
      /* Без празен catch: тук стигат само неочакваните грешки (диалогът, базата).
         Съобщението отива при библиотекаря, следата — в дневника за грешки. */
      console.error('Добавянето на краеведска снимка се провали:', err);
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('localPhoto:clear', (e, { table, id }) =>
    run(() => {
      if (!['persons', 'chronicle'].includes(table)) throw new Error('Непозната таблица.');
      const info = getDb().prepare(`UPDATE ${table} SET photo = NULL WHERE id = ?`).run(id);
      if (!info.changes) {
        throw new Error('Записът не е намерен — вероятно е изтрит от друго работно място. Нищо не е променено.');
      }
      logAudit('Краеведски снимки', 'махната снимка от ' + (TABLE_NAME[table] || table) + ' № ' + id);
    })
  );
};
