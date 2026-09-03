// Просрочени: напомняния — извадени от main.js в отделен модул (Фаза 4,
// стъпка 25). Текстовете се сглобяват тук, за да са еднакви на всички
// работни места, а изпращането остава ръчно: библиотекарят преглежда и
// решава. Зависи от LOAN_SELECT (връщано от handlers/loans.js), EUR_RATE
// (по стойност), isValidEmail (стабилен модулен export от
// security-utils.js), shell (Electron, стабилен) и today.
module.exports = function registerNoticesHandlers(ipcMain, deps) {
  const { getDb, run, today, LOAN_SELECT, EUR_RATE, isValidEmail, shell, effectiveDaysLate } = deps;

  const DEFAULT_NOTICE_SUBJECT = 'Просрочени материали от {library}';
  const DEFAULT_NOTICE_BODY =
`Уважаем(а) {reader},

Според регистъра на {library} при Вас има {count_phrase}:

{list}
{fine_line}
{level_line}Молим да {it_them} върнете при първа възможност или да заявите удължаване на срока.

С уважение,
{librarian_line}{library}{place_line}`;
  const DEFAULT_NOTICE_SMS = '{library_short}: имате {count_phrase}{fine_sms}. Моля, върнете {it_them}.';
  const NOTICE_PLACEHOLDERS = [
    ['reader', 'име на читателя'], ['library', 'име на библиотеката'],
    ['library_short', 'скъсено име (за SMS, до 40 знака)'],
    ['count', 'брой просрочени (само числото)'],
    ['count_phrase', 'напр. „3 просрочени документа“'],
    ['it_them', '„го“ или „ги“, според броя'],
    ['list', 'списък на просрочените документи'],
    ['fine', 'сума на обезщетението, напр. „1.23 лв. (0.63 €)“'],
    ['fine_line', 'ред с обезщетението (или празно, ако е 0)'],
    ['fine_sms', ', обезщетение ... лв (или празно, ако е 0)'],
    ['librarian', 'име на библиотекаря'], ['librarian_line', 'библиотекар + нов ред (или празно)'],
    ['place', 'населено място'], ['place_line', 'нов ред + място (или празно)'],
    ['date', 'днешна дата'],
    ['level', 'степен на напомнянето: 1, 2 или 3'],
    ['level_line', 'ред „Това е ВТОРО/ТРЕТО напомняне…“ (празно при първо)']
  ];

  /* Тонът се покачва със степента: първото напомняне е любезна подкана, третото
     предупреждава за преустановяване на заемането. Степента идва от давността на
     най-старото просрочие (праговете remind2_days/remind3_days в Настройки). */
  const LEVEL_LINES = {
    1: '',
    2: 'Това е ВТОРО напомняне.\n\n',
    3: 'Това е ТРЕТО напомняне. При ново неизпълнение достъпът до заемане ще бъде временно преустановен.\n\n'
  };
  function fillTemplate(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  }
  const bgDate = (d) => d ? String(d).split('-').reverse().join('.') : '';
  function reminderTexts(r, s) {
    const lib = s.lib_name || s.org || 'библиотеката';
    const list = (r.loans || []).map(l =>
      `• ${[l.author, l.title].filter(Boolean).join('. ')} (инв. № ${l.inv_number ?? '—'}), срок ${bgDate(l.date_due)}`
    ).join('\n');
    const fine = Number(r.fine || 0);
    const one = r.n === 1;
    const shortLib = lib.length > 40 ? lib.slice(0, 37).trim() + '…' : lib;
    const vars = {
      reader: r.name, library: lib, library_short: shortLib,
      count: r.n, count_phrase: `${r.n} просрочен${one ? ' документ' : 'и документа'}`,
      it_them: one ? 'го' : 'ги', list,
      fine: fine > 0 ? `${fine.toFixed(2)} лв. (${(fine / EUR_RATE).toFixed(2)} €)` : '',
      fine_line: fine > 0 ? `\nНачислено обезщетение към днешна дата: ${fine.toFixed(2)} лв. (${(fine / EUR_RATE).toFixed(2)} €).` : '',
      fine_sms: fine > 0 ? `, обезщетение ${fine.toFixed(2)} лв` : '',
      librarian: s.librarian || '', librarian_line: s.librarian ? s.librarian + '\n' : '',
      place: s.place || '', place_line: s.place ? '\n' + s.place : '',
      date: bgDate(today()),
      level: r.level || 1, level_line: LEVEL_LINES[r.level] || ''
    };
    return {
      subject: fillTemplate(s.notice_subject || DEFAULT_NOTICE_SUBJECT, vars),
      body: fillTemplate(s.notice_body || DEFAULT_NOTICE_BODY, vars),
      sms: fillTemplate(s.notice_sms || DEFAULT_NOTICE_SMS, vars)
    };
  }

  ipcMain.handle('loans:reminders', () =>
    run(() => {
      const db = getDb();
      const s = db.prepare(`SELECT lib_name, org, place, librarian, notice_subject, notice_body, notice_sms,
        remind2_days, remind3_days FROM settings WHERE id = 1`).get() || {};
      /* Сумата в писмото се смята със същата функция, с която после реално се
         начислява на гишето (effectiveDaysLate от handlers/loans.js). Тук по-рано
         стоеше `SUM((julianday('now') - julianday(date_due)) * fine_per_day)`:
         дробни дни (julianday('now') включва часа!) и без изваждане на затворените
         дни. Едно и също официално напомнително писмо по чл. 43, ал. 2, отпечатано
         в 09:00 и в 17:00, искаше различни суми — и двете различни от касовата. */
      const fpd = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get() || {};
      const perDay = Number(fpd.fine_per_day) || 0;
      const rows = db.prepare(`
        SELECT l.reader_id, r.name, r.phone, r.email, COUNT(*) AS n,
               MIN(l.date_due) AS oldest_due
        FROM loans l JOIN readers r ON r.id = l.reader_id
        WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now')
        GROUP BY l.reader_id ORDER BY r.name
      `).all();
      const detail = db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.date_due`).all();
      /* Одит v2.4.24: `== null` не хваща ПРАЗЕН НИЗ, а формата на настройките праща
         точно него, когато полето е изчистено (formData() чете el.value). '' не е
         null → подразбиращото се 14/30 не влизаше, а `overdueDays >= ''` се привежда
         към `>= 0`, тоест винаги вярно. Читател с ДВА дни забава получаваше трето
         напомняне със заплаха за спиране на достъпа, и notice_log го вписваше като
         ниво 3. Числото се чете като число, а не се сравнява с null. */
      const days = (v, def) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : def; };
      const d2 = days(s.remind2_days, 14), d3 = days(s.remind3_days, 30);
      const lastNoticeQ = db.prepare(`SELECT level, ts FROM notice_log WHERE reader_id = ? ORDER BY ts DESC LIMIT 1`);
      for (const r of rows) {
        r.loans = detail.filter(d => d.reader_id === r.reader_id);
        /* Начисленото по заемането се ДОБАВЯ (одит v2.4.25). v2.4.24 поправи
           loans:overdue и loans:overdueByReader (печатното писмо), но напомнянията
           имат ТРИ пътя, и този — екранът „Напомняния“, имейлът, SMS-ът, „Копирай
           текста“ — още смяташе само днешните дни: писмото искаше 2,05 лв., имейлът
           0,25 лв., гишето 2,05 лв. Точно трите различни суми, обявени за затворени. */
        r.loans.forEach(d => { d.fine = (Number(d.fine) || 0) + effectiveDaysLate(d.date_due, today()) * perDay; });
        r.fine = r.loans.reduce((sum, d) => sum + d.fine, 0);
        const overdueDays = Math.round((new Date(today()) - new Date(r.oldest_due)) / 864e5);
        r.level = overdueDays >= d3 ? 3 : overdueDays >= d2 ? 2 : 1;
        const last = lastNoticeQ.get(r.reader_id);
        // Показва се само напомняне, изпратено ПО ТЕКУЩОТО просрочие — старите не броят.
        r.lastNotice = (last && last.ts >= r.oldest_due) ? { level: last.level, ts: last.ts } : null;
        Object.assign(r, reminderTexts(r, s));
      }
      return rows;
    })
  );
  /* Отбелязва, че напомняне е реално минало към читателя (печат/копиране/поща) —
     така се вижда кой на коя степен е и повторните не се дублират на сляпо. */
  ipcMain.handle('notices:log', (e, { reader_id, level, channel, loans_count }) =>
    run(() => {
      getDb().prepare('INSERT INTO notice_log (reader_id, level, channel, loans_count) VALUES (?, ?, ?, ?)')
        .run(reader_id, level || 1, channel || null, loans_count || 0);
      return true;
    })
  );
  // Отваря пощенския клиент на потребителя. Адресът се сглобява тук, за да не се
  // налага интерфейсът да навигира към mailto:, което Electron би отворил в прозореца.
  // Груба, но достатъчна проверка на формата на имейла (Фаза 3, сигурност) — схемата
  // на URL-а е фиксирана буквално на 'mailto:' (не идва от полето), но валидирането
  // пази от подаване на съвсем несвързан низ от читателската картотека към
  // shell.openExternal, а не само от техническа коректност на адреса (виж
  // security-utils.js за isValidEmail).
  ipcMain.handle('loans:mailto', async (e, { email, subject, body }) => {
    try {
      if (!email) return { ok: false, error: 'Читателят няма записан имейл.' };
      if (!isValidEmail(email)) return { ok: false, error: 'Записаният имейл не изглежда валиден.' };
      const url = 'mailto:' + encodeURIComponent(email) +
        '?subject=' + encodeURIComponent(subject || '') +
        '&body=' + encodeURIComponent(body || '');
      /* Дължината се проверява ПРЕДИ отварянето. Кирилицата се кодира по 6 знака
         на буква, тоест третото напомняне с десетина заглавия стига до ~6000 знака,
         а обработчиците на mailto: под Windows режат около 2000 — списъкът с
         документи излизаше отрязан по средата, а напомнянето се вписваше като
         изпратено. По-добре е библиотекарят да разбере и да го копира. */
      if (url.length > 1900) {
        return { ok: false, error: 'Писмото е твърде дълго за пощенския клиент (' + url.length
          + ' знака при около 2000 допустими) и би стигнало отрязано. Ползвайте „Копирай текста“ '
          + 'и го поставете в пощата си.' };
      }
      /* Изчаква се. Одит на документите v2.4.17: обещанието не се чакаше и не се
         връщаше, а openExternal ОТКАЗВА, когато няма регистриран пощенски клиент —
         обичайно на библиотечен компютър. Отказът излизаше извън try/catch, екранът
         виждаше ok:true, вписваше напомняне като „изпратено“ и следващото тръгваше
         една степен по-високо, без нищо да е изпратено. */
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // Връщат се обратно към main.js — все още неизвадената "Настройки" (домейн
  // "Големите пет") ги ползва в settings:noticeDefaults.
  return { DEFAULT_NOTICE_SUBJECT, DEFAULT_NOTICE_BODY, DEFAULT_NOTICE_SMS, NOTICE_PLACEHOLDERS };
};
