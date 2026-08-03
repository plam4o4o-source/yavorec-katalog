// Настройки — извадени от main.js в отделен модул (Фаза 4, стъпка 33, един
// от "големите пет"). settings:noticeDefaults ОСТАВА в main.js (не тук) —
// чете DEFAULT_NOTICE_SUBJECT/DEFAULT_NOTICE_BODY/DEFAULT_NOTICE_SMS/
// NOTICE_PLACEHOLDERS, върнати от handlers/notices.js, чийто require() стои
// ПО-НАТАТЪК в main.js от мястото на този модул; ако handlers/settings.js
// ги искаше като deps, обектът, подаден на require('./handlers/settings')(),
// би ги ползвал ПРЕДИ да са присвоени — същият TDZ капан както при logEvent/
// scheduleCatalogWrite. Handler-ът е малка чиста функция без друго
// състояние, затова остава директно в main.js, а не се мести тук.
//
// LOGO_MIME/LOCAL_PHOTO_MAX_BYTES се връщат обратно към main.js, защото
// handlers/local-photo.js (изваден по-рано, но require()-нат ПО-НАТАТЪК в
// main.js от този модул) вече ги ползва по пряка референция.
module.exports = function registerSettingsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, dialog, getMainWindow, fs, path } = deps;

  ipcMain.handle('settings:get', () => run(() => getDb().prepare('SELECT * FROM settings WHERE id = 1').get()));
  ipcMain.handle('settings:update', (e, s) =>
    run(() => {
      getDb().prepare(`
        UPDATE settings SET org=@org, lib_name=@lib_name, place=@place, bulstat=@bulstat, reg_no=@reg_no,
          director=@director, director_role=@director_role, librarian=@librarian, cat_url=@cat_url,
          loan_days=@loan_days, max_books=@max_books, extensions_count=@extensions_count, extension_days=@extension_days,
          fine_per_day=@fine_per_day, annual_fee=@annual_fee, free_access_pct=@free_access_pct,
          next_inv_number=@next_inv_number, committee1=@committee1, committee2=@committee2, committee3=@committee3,
          sru_endpoint=@sru_endpoint, suspend_per_day=@suspend_per_day, suspend_max=@suspend_max,
          remind2_days=@remind2_days, remind3_days=@remind3_days, anonymize_years=@anonymize_years
        WHERE id = 1
      `).run(s);
      logAudit('Редакция на настройки', 'настройките на библиотеката са обновени');
    })
  );
  // Шаблоните за напомняния — отделен формуляр, за да не се засяга основният
  // (better-sqlite3 изисква всички именувани параметри на UPDATE-а да присъстват
  // в подадения обект). Празен низ = "по подразбиране", виж reminderTexts().
  ipcMain.handle('settings:updateNotices', (e, o) =>
    run(() => {
      o = o || {};
      getDb().prepare('UPDATE settings SET notice_subject=?, notice_body=?, notice_sms=? WHERE id=1')
        .run(o.notice_subject || null, o.notice_body || null, o.notice_sms || null);
      logAudit('Редакция на шаблони', 'шаблоните за напомняния са обновени');
    })
  );
  // Размерите се ограничават в разумни граници: под няколко милиметра етикетът е
  // безсмислен, а над размера на A4 принтерът така или иначе не го поема.
  const clampNum = (v, lo, hi, def) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  ipcMain.handle('settings:updateLabelFormat', (e, o) =>
    run(() => {
      o = o || {};
      getDb().prepare(`UPDATE settings SET lbl_mode=?, lbl_w=?, lbl_h=?, lbl_cols=?, lbl_gap=?, lbl_margin=?,
                  lbl_border=?, sig_w=?, sig_h=?, card_w=?, card_h=? WHERE id=1`)
        .run(
          o.lbl_mode === 'roll' ? 'roll' : 'sheet',
          clampNum(o.lbl_w, 10, 210, 40), clampNum(o.lbl_h, 8, 297, 30),
          clampNum(o.lbl_cols, 1, 8, 3), clampNum(o.lbl_gap, 0, 30, 3), clampNum(o.lbl_margin, 0, 40, 8),
          o.lbl_border ? 1 : 0,
          clampNum(o.sig_w, 10, 100, 25), clampNum(o.sig_h, 10, 120, 35),
          clampNum(o.card_w, 40, 210, 90), clampNum(o.card_h, 30, 297, 60)
        );
    })
  );
  /* ---------------- Лого на организацията ----------------
     Логото се пази в самата база данни като data URI, а не като път до файл: така
     пътува заедно с базата при резервно копие, при пренасяне на друг компютър и при
     работа в мрежа, където другите компютри нямат достъп до локалния файл. */
  const LOGO_MAX_BYTES = 512 * 1024;
  // Снимките към персоналии и летопис са по-големи от логото, но пак пътуват в базата.
  const LOCAL_PHOTO_MAX_BYTES = 1024 * 1024;
  const LOGO_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  ipcMain.handle('settings:chooseLogo', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Изберете файл с логото на организацията',
        properties: ['openFile'],
        filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
      });
      if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
      const file = filePaths[0];
      const ext = path.extname(file).toLowerCase();
      const mime = LOGO_MIME[ext];
      if (!mime) return { ok: false, error: 'Неподдържан формат. Изберете PNG, JPG, GIF, WEBP или SVG.' };
      const buf = fs.readFileSync(file);
      if (buf.length > LOGO_MAX_BYTES) {
        return { ok: false, error: 'Файлът е ' + Math.round(buf.length / 1024) + ' KB, а максимумът е 512 KB. ' +
          'Смалете изображението — за печат е достатъчно около 600 пиксела ширина.' };
      }
      const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
      getDb().prepare('UPDATE settings SET logo = ? WHERE id = 1').run(dataUri);
      logAudit('Редакция на настройки', 'зададено лого на организацията');
      return { ok: true, data: dataUri };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('settings:clearLogo', () =>
    run(() => {
      getDb().prepare('UPDATE settings SET logo = NULL WHERE id = 1').run();
      logAudit('Редакция на настройки', 'премахнато лого на организацията');
    })
  );
  ipcMain.handle('settings:updateTheme', (e, theme) =>
    run(() => { getDb().prepare('UPDATE settings SET theme=? WHERE id=1').run(String(theme)); })
  );

  return { LOGO_MIME, LOCAL_PHOTO_MAX_BYTES };
};
