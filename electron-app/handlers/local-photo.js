// Краеведски модул: Снимки към персоналии и летопис — извадено от main.js
// в отделен модул (Фаза 4, стъпка 31). Пазят се в базата като data URI, по
// същата причина както логото: пътуват заедно с базата при резервно копие
// и при работа в мрежа. mainWindow се подава като getMainWindow() getter
// по същия модел като handlers/backup.js, защото се пресъздава при
// app.on('activate', ...).
module.exports = function registerLocalPhotoHandlers(ipcMain, deps) {
  const { getDb, run, dialog, getMainWindow, fs, path, LOGO_MIME, LOCAL_PHOTO_MAX_BYTES } = deps;

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
      const buf = fs.readFileSync(file);
      if (buf.length > LOCAL_PHOTO_MAX_BYTES) {
        return { ok: false, error: 'Файлът е ' + Math.round(buf.length / 1024) + ' KB, а максимумът е ' +
          Math.round(LOCAL_PHOTO_MAX_BYTES / 1024) + ' KB. Смалете изображението преди да го добавите.' };
      }
      const uri = `data:${mime};base64,${buf.toString('base64')}`;
      getDb().prepare(`UPDATE ${table} SET photo = ? WHERE id = ?`).run(uri, id);
      return { ok: true, data: uri };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('localPhoto:clear', (e, { table, id }) =>
    run(() => {
      if (!['persons', 'chronicle'].includes(table)) throw new Error('Непозната таблица.');
      getDb().prepare(`UPDATE ${table} SET photo = NULL WHERE id = ?`).run(id);
    })
  );
};
