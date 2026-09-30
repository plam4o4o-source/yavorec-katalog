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
  /* Числовите настройки минават през нормализиране (одит v2.4.24). Формата праща
     `el.value`, тоест ИЗЧИСТЕНОТО поле пристига като празен низ, а колоната е
     INTEGER/REAL без NOT NULL — SQLite пази '' като ТЕКСТ (празният низ няма
     числова стойност, така че афинитетът не го преобразува). Оттам нататък всяка
     проверка от вида `x == null ? подразбиращо : x` подминава подразбиращото се и
     сравнява с празен низ, който в числов контекст е 0:
       • remind2_days/remind3_days: всяко напомняне ставаше НИВО 3 („при ново
         неизпълнение достъпът ще бъде преустановен“) още от първия ден забава;
       • extensions_count: `max && used >= max` с '' → лимитът от продължения
         отпадаше изцяло, вместо да падне към подразбиращите се 2.
     Празно поле значи „по подразбиране“ и се записва като NULL — точно това, което
     всички консуматори вече очакват. Изрична нула се пази като нула. */
  const NUM_SETTINGS = {
    loan_days: 'int', max_books: 'int', extensions_count: 'int', extension_days: 'int',
    fine_per_day: 'real', annual_fee: 'real', free_access_pct: 'real',
    next_inv_number: 'int', suspend_per_day: 'real', suspend_max: 'int',
    remind2_days: 'int', remind3_days: 'int', anonymize_years: 'int',
    /* Обезщетението за ИЗГУБЕН документ (v2.4.56). Чл. 43, ал. 2 урежда, че
       ползвателят обезщетява библиотеката, но не определя размера — той е
       решение на настоятелството. Затова тук стоят двете числа, а не зашита
       стойност в кода: кратност спрямо цената по инвентарната книга и сума за
       документ без вписана цена (старите инвентарни книги често нямат стойност,
       а нула изглежда като пресметнат отговор). */
    lost_price_multiplier: 'real', lost_fallback_amount: 'real'
  };
  function normalizeNumericSettings(s) {
    const out = Object.assign({}, s);
    for (const [k, kind] of Object.entries(NUM_SETTINGS)) {
      if (!(k in out)) continue;
      const raw = out[k];
      if (raw === '' || raw === null || raw === undefined) { out[k] = null; continue; }
      /* Дробна запетая (С8, v2.4.71): „40,5“ пристигнало като текст (стар екран,
         друг вход) дотук минаваше през parseFloat и ставаше 40 — тихо. Запетаята
         е българският десетичен знак и се чете като точка. */
      /* ТЕКСТЪТ ТРЯБВА ДА Е ЧИСЛО ЦЯЛ (v2.4.73). parseFloat взимаше първото число
         от текста и мълчеше за останалото: „5 лв.“ в поле в евро ставаше 5 €, а
         „1.234,50“ — 1,234. Интервалите (и неразделящият) се махат — „1 000“ е
         1000, не 1; иначе текст, който не е число, се отказва с името на полето. */
      let txt = raw;
      if (typeof raw === 'string') {
        txt = raw.replace(/[\s\u00a0]/g, '');
        if (kind === 'real') txt = txt.replace(',', '.');
        if (txt === '') { out[k] = null; continue; }
        if (!(kind === 'int' ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/).test(txt)) {
          throw new Error('„' + (SETTING_LABELS[k] || k) + '“: „' + raw.trim() + '“ не е число. Настройките НЕ са записани — '
            + 'напишете числото само с цифри' + (kind === 'real' ? ', дробната част със запетая (напр. 2,50).' : '.'));
        }
      }
      const n = kind === 'int' ? parseInt(txt, 10) : parseFloat(txt);
      out[k] = Number.isFinite(n) ? n : null;
    }
    return out;
  }
  /* ЧЕТИМИ ИМЕНА НА НАСТРОЙКИТЕ — за реда в одитната следа (С10). Същите думи
     като етикетите в „Настройки“, за да се разпознае полето от следата. */
  const SETTING_LABELS = {
    org: 'Организация', lib_name: 'Наименование на библиотеката', place: 'Населено място',
    bulstat: 'ЕИК / БУЛСТАТ', reg_no: 'Рег. № в Мин. на културата', director: 'Ръководител',
    director_role: 'Длъжност', librarian: 'Библиотекар', cat_url: 'Адрес на сайта',
    loan_days: 'Срок за заемане (дни)', max_books: 'Максимум документи на читател',
    extensions_count: 'Брой продължения', extension_days: 'Дни на продължение',
    fine_per_day: 'Обезщетение за забава (на ден)', annual_fee: 'Годишна такса',
    free_access_pct: 'Фонд на свободен достъп (%)', next_inv_number: 'Следващ инвентарен номер',
    committee1: 'Член 1 на комисията', committee2: 'Член 2 на комисията', committee3: 'Член 3 на комисията',
    sru_endpoint: 'SRU сървър', suspend_per_day: 'Наказание при забава (дни за ден)',
    suspend_max: 'Таван на наказанието (дни)', remind2_days: '2-ро напомняне след (дни)',
    remind3_days: '3-то напомняне след (дни)', anonymize_years: 'Анонимизиране след (години)',
    lost_price_multiplier: 'Обезщетение за изгубен документ — кратност',
    lost_fallback_amount: 'Обезщетение за документ без цена'
  };
  const UPDATE_FIELDS = Object.keys(SETTING_LABELS);

  ipcMain.handle('settings:update', /** @param {unknown} e @param {IpcArg<'settings:update'>} s0 */ (e, s0) =>
    run(() => {
      const s = normalizeNumericSettings(s0);
      /* ФОНД НА СВОБОДЕН ДОСТЪП — ПРОЦЕНТ МЕЖДУ 0 И 100 (v2.4.71, кръг 45, С8).
         (а) Полето беше пропуснато при поправката на дробните полета (П1):
         type="number" в Chromium с български език изпуска запетаята, и „40,5“ се
         записваше като 405 (тестер: „62,5“ → 625).
         (б) По чл. 41 процентът решава нормата на допустимите естествени загуби
         (над 50 % на свободен достъп — 1 %, иначе 0,5 %). 405 „процента“ дават
         грешна норма, по която комисията подписва протокола за липсите.
         (в) Екранът вече е decField (запетаята се чете), а ПРАВИЛОТО е тук:
         стойност извън 0–100 не се записва и никоя от настройките не се пипа —
         изречението казва кое поле и какво да се напише. */
      if (s.free_access_pct != null && (s.free_access_pct < 0 || s.free_access_pct > 100)) {
        throw new Error('„Фонд на свободен достъп (%)“ трябва да е процент между 0 и 100 — въведено е '
          + String(s0 && s0.free_access_pct) + '. Настройките НЕ са записани. Напишете процента с цифри, '
          + 'дробната част със запетая — напр. 62,5.');
      }
      const db = getDb();
      const before = db.prepare('SELECT * FROM settings WHERE id = 1').get() || {};
      db.prepare(`
        UPDATE settings SET org=@org, lib_name=@lib_name, place=@place, bulstat=@bulstat, reg_no=@reg_no,
          director=@director, director_role=@director_role, librarian=@librarian, cat_url=@cat_url,
          loan_days=@loan_days, max_books=@max_books, extensions_count=@extensions_count, extension_days=@extension_days,
          fine_per_day=@fine_per_day, annual_fee=@annual_fee, free_access_pct=@free_access_pct,
          next_inv_number=@next_inv_number, committee1=@committee1, committee2=@committee2, committee3=@committee3,
          sru_endpoint=@sru_endpoint, suspend_per_day=@suspend_per_day, suspend_max=@suspend_max,
          remind2_days=@remind2_days, remind3_days=@remind3_days, anonymize_years=@anonymize_years,
          lost_price_multiplier=@lost_price_multiplier, lost_fallback_amount=@lost_fallback_amount
        WHERE id = 1
      `).run(s);
      /* „ПРЕДИ/СЛЕД“ В СЛЕДАТА (v2.4.71, кръг 45, С10).
         (а) Редът беше винаги едно и също изречение — „настройките на
         библиотеката са обновени“ — без diff. Смяна на срока за заемане, на
         обезщетението за забава или на следващия инвентарен номер не личеше от
         следата: проверяващият вижда, че нещо е пипано, но не и какво.
         (б) Следващият инв. № решава номерацията в инвентарната книга (чл. 17,
         ал. 2 от Наредба № 3 — поправките се документират), а таксата и
         забавата — парите, които се искат от читателите. Точно тези промени
         трябва да се виждат с „кой, кога, от колко на колко“.
         (в) Сравнява се прочетеното ПРЕДИ записа с прочетеното СЛЕД него (не с
         подаденото — нормализирането може да е сменило вида), само по полетата
         на този формуляр; diff-ът е във формата на всички други редакции
         ({field, before, after}), така че „Одитна следа“ го показва както
         останалите, а подробността назовава променените полета с думи. */
      const after = db.prepare('SELECT * FROM settings WHERE id = 1').get() || {};
      const diff = [];
      for (const f of UPDATE_FIELDS) {
        const b = before[f] == null ? '' : String(before[f]);
        const a = after[f] == null ? '' : String(after[f]);
        if (b !== a) diff.push({ field: f, before: before[f] ?? null, after: after[f] ?? null });
      }
      const shown = (v) => (v == null || v === '' ? '—' : String(v));
      logAudit('Редакция на настройки', diff.length
        ? 'настройките на библиотеката са обновени: ' + diff.map(d => SETTING_LABELS[d.field]
          + ' ' + shown(d.before) + ' → ' + shown(d.after)).join('; ')
        : 'настройките на библиотеката са записани без промяна', diff);
    })
  );
  // Шаблоните за напомняния — отделен формуляр, за да не се засяга основният
  // (better-sqlite3 изисква всички именувани параметри на UPDATE-а да присъстват
  // в подадения обект). Празен низ = "по подразбиране", виж reminderTexts().
  ipcMain.handle('settings:updateNotices', /** @param {unknown} e @param {IpcArg<'settings:updateNotices'>} o */ (e, o) =>
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
  /* ФОРМАТЪТ НА ЛИСТА — ЧЕТИРИ ЧИСЛА ВМЕСТО ДВЕ (v2.4.69, кръг 44, Е2).
     (а) Дотук се пазеха само lbl_margin (едно поле за четирите страни) и lbl_gap
         (едно разстояние за двете посоки). Готовите листове не са симетрични —
         Avery L7160 е горе 15,1, ляво 7,2, хоризонтално 2,5, вертикално 0 — и с
         две числа етикетите не падаха в клетките (кръг 44, mreja.py: 4×10 — 0 от
         37 етикета в клетката си).
     (б) Сега се пазят lbl_mt/lbl_ml/lbl_gx/lbl_gy (колоните са от миграция 18).
         Стар извикващ, който праща само lbl_margin/lbl_gap, получава същото като
         преди — четирите се попълват от тях. Старите две колони остават равни на
         лявото поле и хоризонталното разстояние, за да вижда същото всеки, който
         още ги чете.
     (в) НИЩО МЪЛЧАЛИВО: стойност извън разумните граници се записва с най-близката
         граница, но обработчикът връща коя е била подрязана ({ clamped: [...] }), а
         екранът го казва. Дотук „63,5“ в числово поле ставаше 635 и тихо — 210. */
  const LABEL_LIMITS = {
    lbl_w: ['Ширина на етикета за фонда', 10, 210, 40], lbl_h: ['Височина на етикета за фонда', 8, 297, 30],
    lbl_cols: ['Колони на листа', 1, 8, 3],
    lbl_mt: ['Поле отгоре', 0, 60, 8], lbl_ml: ['Поле отляво', 0, 60, 8],
    lbl_gx: ['Разстояние хоризонтално', 0, 30, 3], lbl_gy: ['Разстояние вертикално', 0, 30, 3],
    sig_w: ['Ширина на сигнатурния етикет', 10, 100, 25], sig_h: ['Височина на сигнатурния етикет', 10, 120, 35],
    card_w: ['Ширина на картата', 40, 210, 90], card_h: ['Височина на картата', 30, 297, 60]
  };
  ipcMain.handle('settings:updateLabelFormat', /** @param {unknown} e @param {IpcArg<'settings:updateLabelFormat'>} o */ (e, o) =>
    run(() => {
      o = Object.assign({}, o || {});
      const has = (k) => o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== '';
      // Стар извикващ (две числа) → четирите нови от тях.
      if (!has('lbl_mt') && has('lbl_margin')) o.lbl_mt = o.lbl_margin;
      if (!has('lbl_ml') && has('lbl_margin')) o.lbl_ml = o.lbl_margin;
      if (!has('lbl_gx') && has('lbl_gap')) o.lbl_gx = o.lbl_gap;
      if (!has('lbl_gy') && has('lbl_gap')) o.lbl_gy = o.lbl_gap;
      const clamped = [];
      const v = {};
      for (const [k, [label, lo, hi, def]] of Object.entries(LABEL_LIMITS)) {
        v[k] = clampNum(o[k], lo, hi, def);
        const given = parseFloat(o[k]);
        if (Number.isFinite(given) && given !== v[k]) clamped.push({ field: k, label, given, saved: v[k] });
      }
      const db = getDb();
      db.prepare(`UPDATE settings SET lbl_mode=?, lbl_w=?, lbl_h=?, lbl_cols=?, lbl_gap=?, lbl_margin=?,
                  lbl_border=?, sig_w=?, sig_h=?, card_w=?, card_h=? WHERE id=1`)
        .run(
          o.lbl_mode === 'roll' ? 'roll' : 'sheet',
          v.lbl_w, v.lbl_h, v.lbl_cols, v.lbl_gx, v.lbl_ml,
          o.lbl_border ? 1 : 0,
          v.sig_w, v.sig_h, v.card_w, v.card_h
        );
      /* Четирите нови колони идват от ensureColumns/миграция 18 в main.js; база,
         създадена само от db/schema.sql (тестовите обвръзки), още ги няма — тогава
         остават двете стари, от които екранът ги чете (lbl_mt ?? lbl_margin). */
      const cols = new Set(db.prepare('PRAGMA table_info(settings)').all().map(c => c.name));
      if (['lbl_mt', 'lbl_ml', 'lbl_gx', 'lbl_gy'].every(c => cols.has(c))) {
        db.prepare('UPDATE settings SET lbl_mt=?, lbl_ml=?, lbl_gx=?, lbl_gy=? WHERE id=1')
          .run(v.lbl_mt, v.lbl_ml, v.lbl_gx, v.lbl_gy);
      }
      return { clamped };
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
  ipcMain.handle('settings:updateTheme', /** @param {unknown} e @param {IpcArg<'settings:updateTheme'>} theme */ (e, theme) =>
    run(() => { getDb().prepare('UPDATE settings SET theme=? WHERE id=1').run(String(theme)); })
  );
  // Звуков сигнал при сканиране (v1.69.0) — вижте beep() в src/views/core.js.
  ipcMain.handle('settings:updateScanSound', /** @param {unknown} e @param {IpcArg<'settings:updateScanSound'>} on */ (e, on) =>
    run(() => { getDb().prepare('UPDATE settings SET scan_sound=? WHERE id=1').run(on ? 1 : 0); })
  );

  return { LOGO_MIME, LOCAL_PHOTO_MAX_BYTES };
};
