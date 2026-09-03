// Дневник на библиотеката (Раздел А / Раздел Б) — извадено от main.js в
// отделен модул (Фаза 4, стъпка 30). Електронен вариант на официалния
// месечен статистически дневник. Един ред в dnevnik_days на календарен ден;
// месечните и годишните (от началото на годината) тотали НЕ се пазят —
// смятат се живо със SUM() при всяко зареждане, за да остават винаги верни,
// независимо кой ден е бил редактиран последно.
//
// dnevnikSumRow се връща обратно към main.js (return-shared-value-back
// pattern, вече установен за LOAN_SELECT/DEFAULT_NOTICE_*), защото
// handlers/stats.js (Фаза 4, стъпка 29, извадено ПРЕДИ този модул) вече го
// ползва по референция за reports:run('annual_ab'). require('./handlers/stats')
// стои по-надолу в main.js от този require, така че константата вече е
// присвоена, когато stats.js я ползва — няма TDZ проблем.
module.exports = function registerDnevnikHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, dialog, getMainWindow, fs } = deps;
  // Общата защита срещу CSV formula-injection (виж security-utils.js). Взима се с
  // require, а не от deps, защото main.js подава csvCell само на модулите, които
  // са го поискали при извеждането си; тук е нужна веднага — всички останали CSV
  // пътища в програмата минават именно през нея.
  const { csvCell } = require('../security-utils');

  const DNEVNIK_A_FIELDS = [
    'a_hours', 'a_age_u14', 'a_age_15_18', 'a_age_19_28', 'a_age_o28',
    'a_sex_boys', 'a_sex_men', 'a_sex_girls', 'a_sex_women',
    'a_edu_basic', 'a_edu_sec', 'a_edu_high',
    'a_prof_industry', 'a_prof_agri', 'a_prof_eng', 'a_prof_agrospec', 'a_prof_med', 'a_prof_sci',
    'a_prof_hum', 'a_prof_creative', 'a_prof_teach', 'a_prof_other',
    'a_stud_uni', 'a_stud_high', 'a_stud_sec', 'a_stud_elem',
    'a_visit_home', 'a_visit_child', 'a_visit_reading', 'a_visit_internet'
  ];
  const DNEVNIK_B_FIELDS = [
    'b_hours',
    'b_type_books', 'b_type_period', 'b_type_graphic', 'b_type_carto', 'b_type_music',
    'b_type_audio', 'b_type_video', 'b_type_electronic', 'b_type_dvd', 'b_type_talking',
    'b_lang_bg', 'b_lang_ru', 'b_lang_slavic', 'b_lang_en', 'b_lang_de', 'b_lang_fr', 'b_lang_other',
    'b_cat_0', 'b_cat_1', 'b_cat_2', 'b_cat_3', 'b_cat_5', 'b_cat_61', 'b_cat_62', 'b_cat_63',
    'b_cat_7', 'b_cat_793', 'b_cat_80', 'b_cat_82', 'b_cat_9', 'b_cat_91',
    'b_cat_fiction', 'b_cat_child_nf', 'b_cat_child_f', 'b_cat_reading_used'
  ];
  const DNEVNIK_FIELDS = [...DNEVNIK_A_FIELDS, ...DNEVNIK_B_FIELDS];
  /* Човешките имена на колоните за CSV износа. Нарочно са ПЪЛНИ (в таблицата на
     екрана същите колони са съкратени заради ширината: „Пром./стр.“), защото този
     файл се отваря в Excel и се подава нагоре, а там няма кой да разчете
     съкращението. Пълнотата на списъка спрямо DNEVNIK_FIELDS е закована с тест —
     нов ред в дневника без име тук би върнал имената от базата за него. */
  const DNEVNIK_LABELS = {
    a_hours: 'А: Часове на обслужване (мин.)',
    a_age_u14: 'А: Възраст — до 14 г.', a_age_15_18: 'А: Възраст — 15–18 г.',
    a_age_19_28: 'А: Възраст — 19–28 г.', a_age_o28: 'А: Възраст — над 28 г.',
    a_sex_boys: 'А: Пол — момчета', a_sex_men: 'А: Пол — мъже',
    a_sex_girls: 'А: Пол — момичета', a_sex_women: 'А: Пол — жени',
    a_edu_basic: 'А: Образование — основно', a_edu_sec: 'А: Образование — средно',
    a_edu_high: 'А: Образование — висше',
    a_prof_industry: 'А: Занятие — промишленост и строителство',
    a_prof_agri: 'А: Занятие — селско стопанство',
    a_prof_eng: 'А: Занятие — инженерно-технически',
    a_prof_agrospec: 'А: Занятие — селскостопански специалисти',
    a_prof_med: 'А: Занятие — медицински',
    a_prof_sci: 'А: Занятие — математици и физици',
    a_prof_hum: 'А: Занятие — хуманитарни',
    a_prof_creative: 'А: Занятие — творчески',
    a_prof_teach: 'А: Занятие — учители',
    a_prof_other: 'А: Занятие — други',
    a_stud_uni: 'А: Учащи — студенти', a_stud_high: 'А: Учащи — горна степен',
    a_stud_sec: 'А: Учащи — средна степен', a_stud_elem: 'А: Учащи — начална степен',
    /* Одит v2.4.24: колоната е „В заемна за дома“ навсякъде другаде във формата и в
       екрана за деня (src/views/dnevnik.js); „по домовете“ е СЪВСЕМ ДРУГО и много
       по-малко число — надомното обслужване, което само ЗАХРАНВА тази колона
       (handlers/housebound.js). Точно този файл се отваря в Excel и се подава нагоре,
       затова етикетът трябва да е името от формата. */
    a_visit_home: 'А: Посещения — в заемна за дома', a_visit_child: 'А: Посещения — деца до 14 г.',
    a_visit_reading: 'А: Посещения — в читалня', a_visit_internet: 'А: Посещения — интернет',
    b_hours: 'Б: Часове на обслужване (мин.)',
    b_type_books: 'Б: Вид — книги', b_type_period: 'Б: Вид — периодични издания',
    b_type_graphic: 'Б: Вид — графични', b_type_carto: 'Б: Вид — картографски',
    b_type_music: 'Б: Вид — нотни', b_type_audio: 'Б: Вид — аудио',
    b_type_video: 'Б: Вид — видео', b_type_electronic: 'Б: Вид — електронни',
    b_type_dvd: 'Б: Вид — DVD', b_type_talking: 'Б: Вид — говорещи книги',
    b_lang_bg: 'Б: Език — български', b_lang_ru: 'Б: Език — руски',
    b_lang_slavic: 'Б: Език — славянски', b_lang_en: 'Б: Език — английски',
    b_lang_de: 'Б: Език — немски', b_lang_fr: 'Б: Език — френски',
    b_lang_other: 'Б: Език — други',
    b_cat_0: 'Б: УДК 0 — общ отдел', b_cat_1: 'Б: УДК 1 — философия',
    b_cat_2: 'Б: УДК 2 — религия', b_cat_3: 'Б: УДК 3 — обществени науки',
    b_cat_5: 'Б: УДК 5 — математика и естествени науки', b_cat_61: 'Б: УДК 61 — медицина',
    b_cat_62: 'Б: УДК 62 — техника', b_cat_63: 'Б: УДК 63 — селско стопанство',
    b_cat_7: 'Б: УДК 7 — изкуство', b_cat_793: 'Б: УДК 793 — спорт',
    b_cat_80: 'Б: УДК 80 — езикознание', b_cat_82: 'Б: УДК 82 — литературознание',
    b_cat_9: 'Б: УДК 9 — история', b_cat_91: 'Б: УДК 91 — география',
    b_cat_fiction: 'Б: Художествена литература',
    b_cat_child_nf: 'Б: Детска отраслова литература',
    b_cat_child_f: 'Б: Детска художествена литература',
    b_cat_reading_used: 'Б: От които ползвани в читалня (не влиза в сборовете)'
  };

  function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
  function dnevnikTotals(row) {
    const g = (k) => (row ? (row[k] || 0) : 0);
    const a_total_age = g('a_age_u14') + g('a_age_15_18') + g('a_age_19_28') + g('a_age_o28');
    const a_total_sex = g('a_sex_boys') + g('a_sex_men') + g('a_sex_girls') + g('a_sex_women');
    const a_total_edu = g('a_age_u14') + g('a_age_15_18') + g('a_edu_basic') + g('a_edu_sec') + g('a_edu_high');
    const a_total_prof = g('a_prof_industry') + g('a_prof_agri') + g('a_prof_eng') + g('a_prof_agrospec') +
      g('a_prof_med') + g('a_prof_sci') + g('a_prof_hum') + g('a_prof_creative') + g('a_prof_teach') + g('a_prof_other') +
      g('a_stud_uni') + g('a_stud_high') + g('a_stud_sec') + g('a_stud_elem');
    const b_total_type = DNEVNIK_B_FIELDS.filter(f => f.startsWith('b_type_')).reduce((s, f) => s + g(f), 0);
    const b_total_lang = DNEVNIK_B_FIELDS.filter(f => f.startsWith('b_lang_')).reduce((s, f) => s + g(f), 0);
    const b_total_content = ['b_cat_0', 'b_cat_1', 'b_cat_2', 'b_cat_3', 'b_cat_5', 'b_cat_61', 'b_cat_62', 'b_cat_63',
      'b_cat_7', 'b_cat_793', 'b_cat_80', 'b_cat_82', 'b_cat_9', 'b_cat_91',
      'b_cat_fiction', 'b_cat_child_nf', 'b_cat_child_f'].reduce((s, f) => s + g(f), 0);
    return { a_total_age, a_total_sex, a_total_edu, a_total_prof, b_total_type, b_total_lang, b_total_content };
  }
  function dnevnikSumRow(rows) {
    const sum = {};
    DNEVNIK_FIELDS.forEach(f => { sum[f] = rows.reduce((s, r) => s + (r[f] || 0), 0); });
    return Object.assign(sum, dnevnikTotals(sum));
  }

  ipcMain.handle('dnevnik:getMonth', (e, { year, month }) =>
    run(() => {
      const db = getDb();
      const y = parseInt(year, 10), m = parseInt(month, 10);
      const dim = daysInMonth(y, m);
      const pad = (n) => String(n).padStart(2, '0');
      const from = `${y}-${pad(m)}-01`, to = `${y}-${pad(m)}-${pad(dim)}`;
      const rows = db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to);
      const byDate = {}; rows.forEach(r => { byDate[r.date] = r; });
      const days = [];
      for (let d = 1; d <= dim; d++) {
        const date = `${y}-${pad(m)}-${pad(d)}`;
        const row = byDate[date] || { date };
        days.push(Object.assign({ day: d, date }, row, dnevnikTotals(row)));
      }
      const monthTotal = dnevnikSumRow(rows);
      const ytdRows = db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ?').all(`${y}-01-01`, to);
      const ytdTotal = dnevnikSumRow(ytdRows);
      return { year: y, month: m, daysInMonth: dim, days, monthTotal, ytdTotal };
    })
  );
  /* Записват се САМО колоните, които наистина са дошли в заявката — не всичките
     66 наведнъж.

     Одит v2.4.14: дотук всяко записване пишеше целия ред, изчислен от снимката,
     която браузърът е заредил при отваряне на екрана. При двама души в един и
     същи ден — читалня и заемна например — вторият връщаше на нула колоните на
     първия, защото неговата снимка ги е заредила празни. Без конфликт, без
     предупреждение: официалният месечен формуляр просто губеше половината ден.
     Най-честият път (редакция на една клетка в таблицата) сега изпраща точно
     една колона, а прозорецът „Подробно за деня“ изпраща целия формуляр — там
     човекът е видял и потвърдил всички числа, и затова е меродавен. За да е
     видяното наистина текущо, прозорецът се отваря върху презаредени данни (виж
     dnevnikDayForm в src/views/dnevnik.js).

     Празен ред при първо докосване на деня: колоните, които не са изпратени,
     остават NULL и се четат като 0 навсякъде, където се сумират — същото
     поведение като досега. */
  ipcMain.handle('dnevnik:saveDay', (e, d) =>
    run(() => {
      const db = getDb();
      const cols = DNEVNIK_FIELDS.filter(f => d[f] !== undefined);
      const hasNote = d.note !== undefined;
      if (!cols.length && !hasNote) throw new Error('Няма какво да се запише за този ден.');
      const payload = { date: d.date };
      cols.forEach(f => { payload[f] = parseInt(d[f], 10) || 0; });
      if (hasNote) payload.note = d.note || null;
      const names = cols.concat(hasNote ? ['note'] : []);
      db.prepare(`
        INSERT INTO dnevnik_days (date, ${names.join(',')})
        VALUES (@date, ${names.map(f => '@' + f).join(',')})
        ON CONFLICT(date) DO UPDATE SET ${names.map(f => f + '=excluded.' + f).join(',')}
      `).run(payload);
      logAudit('Дневник', 'вписан ден ' + d.date);
    })
  );
  // Предложени стойности за един ден на дневника, изведени от потока събития (events).
  // Ръчното въвеждане ОСТАВА меродавно — официалният формуляр се потвърждава от
  // библиотекаря; тук програмата само предлага числата, които може да изведе сама:
  // Раздел Б по вид/език/съдържание от заеманията, посещенията в читалня и по домовете,
  // и разпределението на читателите по възрастови категории.
  const DNEVNIK_TYPE_MAP = {
    'книга': 'b_type_books', 'продължаващо издание': 'b_type_period', 'графично издание': 'b_type_graphic',
    'картографско издание': 'b_type_carto', 'нотно издание': 'b_type_music', 'аудиодокумент': 'b_type_audio',
    'видеодокумент': 'b_type_video', 'електронен документ': 'b_type_electronic'
  };
  const DNEVNIK_LANG_MAP = {
    'български': 'b_lang_bg', 'руски': 'b_lang_ru', 'английски': 'b_lang_en',
    'немски': 'b_lang_de', 'френски': 'b_lang_fr'
  };
  // Проверява се от най-дългия префикс към най-късия — иначе „793" би хванало „7".
  /* Таблицата ТРЯБВА да покрива всяка цифра 0-9 на последно място, иначе заемането
     не попада в никоя колона и трите реда „Всичко“ на Раздел Б (по вид, по език, по
     съдържание) не се събират: по вид и по език се брои винаги (има резервна
     стойност), по съдържание — само при съвпадение. Липсваха точно „8“ и „6“:
     езикознание 81 и приложните науки 65-68 не влизаха никъде. */
  const DNEVNIK_UDK_PREFIXES = [
    ['793', 'b_cat_793'], ['799', 'b_cat_793'], ['91', 'b_cat_91'], ['80', 'b_cat_80'],
    ['81', 'b_cat_80'], // езикознание — заедно с 80, както е в самия формуляр
    ['82', 'b_cat_82'], ['61', 'b_cat_61'], ['62', 'b_cat_62'], ['63', 'b_cat_63'],
    ['64', 'b_cat_62'], ['69', 'b_cat_62'], ['0', 'b_cat_0'], ['1', 'b_cat_1'], ['2', 'b_cat_2'],
    ['3', 'b_cat_3'], ['5', 'b_cat_5'],
    ['6', 'b_cat_62'], // 65-68 — управление, химични и други производства: приложни науки
    ['7', 'b_cat_7'],
    ['8', 'b_cat_82'], // остатъкът от клас 8 е художествена литература
    ['9', 'b_cat_9']
  ];
  const DNEVNIK_AGE_MAP = {
    'дете до 14 г.': 'a_age_u14', 'ученик': 'a_age_15_18', 'студент': 'a_age_19_28'
  };
  ipcMain.handle('dnevnik:suggest', (e, { date }) =>
    run(() => {
      const db = getDb();
      const events = db.prepare('SELECT * FROM events WHERE date = ?').all(date);
      const out = {};
      const add = (k, n) => { if (k) out[k] = (out[k] || 0) + (n == null ? 1 : n); };
      const seenReaders = new Set();
      let unclassified = 0; // заемания на книги без разпознат УДК — виж по-долу
      for (const ev of events) {
        if (ev.kind === 'читалня') { add('a_visit_reading'); continue; }
        if (ev.kind === 'дома') { add('a_visit_home'); continue; }
        if (ev.kind !== 'заемане') continue;
        // Раздел Б — по вид, език и съдържание, само за реално заетите този ден.
        add(DNEVNIK_TYPE_MAP[ev.book_category] || 'b_type_books');
        add(DNEVNIK_LANG_MAP[ev.book_language] || 'b_lang_other');
        /* Книга без попълнен УДК не може да бъде подредена по съдържание. Да бъде
           набутана в „Общ отдел“ би било по-лошо от това да не бъде броена — числото
           щеше да изглежда вярно и никой не би проверил. Затова тук се брои отделно
           и се връща на изгледа, за да каже на библиотекаря колко реда трябва да
           допълни ръчно, вместо трите „Всичко“ да се разминават необяснимо. */
        const udk = String(ev.book_udk || '').trim();
        const hit = udk ? DNEVNIK_UDK_PREFIXES.find(([p]) => udk.startsWith(p)) : null;
        if (hit) add(hit[1]); else unclassified++;
        // Раздел А — всеки читател се брои веднъж на ден, по категорията му към момента.
        const rk = ev.reader_id || ('cat:' + ev.reader_category + ':' + ev.id);
        if (!seenReaders.has(rk)) {
          seenReaders.add(rk);
          add(DNEVNIK_AGE_MAP[ev.reader_category] || 'a_age_o28');
          if (ev.reader_category === 'дете до 14 г.') add('a_visit_child');
        }
      }
      return { date, suggestions: out, eventsCount: events.length, unclassified };
    })
  );
  ipcMain.handle('dnevnik:exportCsv', async (e, { year, month }) => {
    try {
      const db = getDb();
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Извеждане на дневника (CSV)',
        defaultPath: `dnevnik-${year}-${String(month).padStart(2, '0')}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      const y = parseInt(year, 10), m = parseInt(month, 10);
      const dim = daysInMonth(y, m);
      const pad = (n) => String(n).padStart(2, '0');
      const rows = db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ? ORDER BY date')
        .all(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(dim)}`);
      const byDate = {}; rows.forEach(r => { byDate[r.date] = r; });
      /* Заглавният ред е на ЧОВЕШКИ език, а не имената на колоните в базата.
         Дотук първият ред на файла беше „a_prof_agrospec;b_cat_793;…“ — таблица,
         която библиотекарят отваря в Excel и не може да разчете, а всяко подаване
         нагоре изисква да се преписва на ръка. Имената идват от ЕДНО място
         (DNEVNIK_LABELS по-горе), за да не се разминат с екрана и разпечатката. */
      const h = ['Дата', ...DNEVNIK_FIELDS.map(f => DNEVNIK_LABELS[f] || f)];
      const dayRows = Array.from({ length: dim }, (_, i) => {
        const date = `${y}-${pad(m)}-${pad(i + 1)}`;
        return byDate[date] || {};
      });
      const line = (first, row) =>
        // csvCell вместо собствен esc(): собственият само ограждаше в кавички и
        // пропускаше защитата срещу formula-injection (клетка, започваща с
        // '=', '+', '-', '@' — напр. дата, въведена като „-2026…", или бъдещо
        // текстово поле в дневника — се изпълнява като формула при отваряне в
        // Excel/LibreOffice).
        [first, ...DNEVNIK_FIELDS.map(f => row[f] || 0)].map(csvCell).join(';');
      /* Двата обобщителни реда ги има на екрана и в разпечатката, но НЕ ги имаше в
         CSV — а точно този файл се отваря, за да се вземат сборовете. Всеки, който
         ги е събирал в Excel сам, е поемал риска от сгрешен диапазон в число,
         което после се подава нагоре. */
      const csv = [h.join(';')]
        .concat(dayRows.map((row, i) => line(`${y}-${pad(m)}-${pad(i + 1)}`, row)))
        .concat([
          line('Всичко за месеца', dnevnikSumRow(dayRows)),
          line('Всичко от началото на годината', dnevnikSumRow(
            db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ? ORDER BY date')
              .all(`${y}-01-01`, `${y}-${pad(m)}-${pad(dim)}`)
          ))
        ])
        .join('\r\n');
      fs.writeFileSync(filePath, '﻿' + csv, 'utf8');
      logAudit('Извеждане на дневника (CSV)', filePath + ' — ' + pad(m) + '.' + y);
      return { ok: true, data: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  return { dnevnikSumRow };
};
