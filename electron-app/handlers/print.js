// Печат → PDF файл (v1.72.0). Системният диалог за печат на Windows по
// принцип НЕ визуализира съдържание от Electron прозорци („Това приложение
// не поддържа визуализация на печата“) — това е ограничение на Windows, не
// наше, и не се лекува от страната на CSS. Затова прегледът преди печат в
// програмата (v1.71.0) се допълва с директно записване в PDF:
// printToPDF() рендира страницата през СЪЩИЯ печатен път (@media print,
// @page от setPrintPage), през който минава и window.print() — т.е. PDF-ът
// е точно това, което би излязло от принтера. Записаният файл се отваря
// веднага в подразбиращия се PDF четец, където визуализацията е пълна и
// откъдето може да се печата с истински преглед.
/* ГРЕШКАТА ПРИ ЗАПИС НА PDF — НА БЪЛГАРСКИ И С ИЗХОД (v2.4.71, кръг 45, Р4).
   (а) Дотук тук се връщаше суровото err.message на Node: при опит за запис в
       несъществуваща папка библиотекарката четеше „ENOENT: no such file or
       directory, open '/…/x.pdf'“ (тестерът, kanal/savepdf.js). На Windows най-честата
       грешка е друга — EBUSY/EPERM: вчерашният PDF със същото име е още отворен в
       Adobe Reader (или в браузъра), а „Запази PDF…“ предлага точно същото име.
   (б) Съобщение на английски с код и път не казва на човека нито какво е станало,
       нито какво да направи — а документът (актът, КДБФ, инвентарната книга) не е
       записан и той трябва да го разбере, за да не го търси после в папката.
   (в) Кодът на грешката (err.code) казва причината точно, затова преводът е по
       код, а не по текста; всяко съобщение казва и ИЗХОДА (затворете файла,
       изберете друго име/друга папка). Неизвестната грешка пак се показва, но с
       изречение пред нея и със същия изход. Грешка в самото превръщане в PDF
       (printToPDF) се казва отделно — там папката не е виновна. */
function pdfWriteError(err, filePath, path) {
  const code = err && err.code;
  const file = path.basename(filePath || '');
  const dir = path.dirname(filePath || '');
  const head = 'PDF файлът „' + file + '“ не е записан: ';
  if (code === 'EBUSY') {
    return head + 'файл със същото име е отворен в друга програма (най-често Adobe Reader или браузърът). '
      + 'Затворете го там и натиснете „Запази PDF…“ отново — или изберете друго име.';
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return head + 'Windows не разрешава запис — файл със същото име е отворен в друга програма (Adobe Reader, '
      + 'браузърът) или е само за четене, или нямате права в папката „' + dir + '“. Затворете файла или изберете '
      + 'друго име или друга папка (например „Документи“) и натиснете „Запази PDF…“ отново.';
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return head + 'папката „' + dir + '“ не съществува — изтрита или преименувана, или флашката или мрежовото '
      + 'устройство не е включено. Изберете друга папка и натиснете „Запази PDF…“ отново.';
  }
  if (code === 'ENOSPC') {
    return head + 'на диска няма свободно място. Освободете място или изберете друга папка (друг диск или флашка) '
      + 'и натиснете „Запази PDF…“ отново.';
  }
  if (code === 'EROFS') {
    return head + 'устройството е само за четене (заключена флашка или компактдиск). Изберете друга папка и '
      + 'натиснете „Запази PDF…“ отново.';
  }
  return head + 'непозната грешка при запис' + (err && err.message ? ' (' + err.message + ')' : '')
    + '. Изберете друго име или друга папка и натиснете „Запази PDF…“ отново.';
}

/** @param {any} ipcMain @param {Record<string, any>} deps   (без run — каналите тук връщат { ok, … } сами) */
module.exports = function registerPrintHandlers(ipcMain, deps) {
  const { getMainWindow, dialog, fs, path, app, shell, logAudit } = deps;

  ipcMain.handle('print:savePdf', /** @param {unknown} e @param {IpcArg<'print:savePdf'>} opts @returns {Promise<IpcResult<IpcData<'print:savePdf'>>>} */ async (e, opts) => {
    try {
      const win = getMainWindow();
      if (!win) return { ok: false, error: 'Няма активен прозорец.' };
      /* Крайните точки и интервали падат и ТУК, не само в екранния слой
         (src/views/core.js: safeFileName) — v2.4.61. Името на документа завършва
         със съкращение („КДБФ 2026 г.“), а тук се долепя разширението: излизаше
         „КДБФ 2026 г..pdf“. Windows пък мълчаливо маха крайните точки и
         интервали от имената на файлове, тоест предложеното и записаното име се
         разминаваха. Повторението не е излишно — това е IPC границата, през
         която минава всичко (и бъдещ повикващ, който не е минал през
         safeFileName), а екранната поправка пази само днешния път до бутона.
         Водещите точки падат по същата причина, по която падат и там: файл с
         име, започващо с точка, е скрит в Linux и macOS. Ако след изчистването
         не остане нищо, името си остава „Документ“. */
      const name = String((opts && opts.fileName) || '').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '') || 'Документ';
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Запазване като PDF',
        defaultPath: path.join(app.getPath('documents'), name + '.pdf'),
        filters: [{ name: 'PDF документ', extensions: ['pdf'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      // preferCSSPageSize: размерът/полетата идват от @page (setPrintPage) —
      // същите за A4, пейзаж и ролкови етикети; printBackground — иначе
      // Windows реже фоновете и читателската карта излиза гол текст (същата
      // причина като print-color-adjust в style.css).
      let buf;
      try {
        buf = await win.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true
        });
      } catch (err) {
        return { ok: false, error: 'Документът не можа да се превърне в PDF (' + (err && err.message || err)
          + '). Нищо не е записано. Затворете прегледа, отворете документа отново и опитайте пак — или '
          + 'отпечатайте с „Печат…“.' };
      }
      try {
        fs.writeFileSync(filePath, buf);
      } catch (err) {
        return { ok: false, error: pdfWriteError(err, filePath, path) };
      }
      if (logAudit) logAudit('Запазен PDF', filePath);
      // Отваря готовия PDF веднага — там се вижда точно какво ще се печата.
      shell.openPath(filePath);
      return { ok: true, data: { path: filePath } };
    } catch (err) {
      // Диалогът за запис или прозорецът — не самият запис (той е хванат по-горе).
      return { ok: false, error: 'PDF файлът не е записан: ' + (err && err.message || err)
        + '. Затворете прегледа, отворете документа отново и опитайте пак.' };
    }
  });
};
module.exports.pdfWriteError = pdfWriteError;
