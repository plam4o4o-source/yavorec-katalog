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
module.exports = function registerPrintHandlers(ipcMain, deps) {
  const { getMainWindow, dialog, fs, path, app, shell, logAudit } = deps;

  ipcMain.handle('print:savePdf', async (e, opts) => {
    try {
      const win = getMainWindow();
      if (!win) return { ok: false, error: 'Няма активен прозорец.' };
      const name = String((opts && opts.fileName) || 'Документ').trim() || 'Документ';
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
      const buf = await win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true
      });
      fs.writeFileSync(filePath, buf);
      if (logAudit) logAudit('Запазен PDF', filePath);
      // Отваря готовия PDF веднага — там се вижда точно какво ще се печата.
      shell.openPath(filePath);
      return { ok: true, data: { path: filePath } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
};
