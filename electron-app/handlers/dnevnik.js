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
  const { csvCell, isValidIsoDate } = require('../security-utils');

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
  /* ВПИСАН ЛИ Е НАИСТИНА ДЕНЯТ (одит v2.4.65, находка В1).
     =====================================================================
     ДОТУК „вписан ден“ значеше „има ред в dnevnik_days“. Ред обаче се създава и
     от едно натискане на „Запиши деня“ върху празния формуляр — всичките 66
     колони излизат нули и денят пак се брои: таблото обявява „Дневникът за днес
     е попълнен“ (handlers/dashboard.js) и годишният отчет го брои за „вписан
     работен ден“ (handlers/stats.js → annual_ab). Библиотекарката губи
     единствената си подсещалка точно за деня, който НЕ е вписан, а отчетът към
     регионалната библиотека твърди покритие, каквото няма.
     „Вписан“ значи: поне една ненулева колона ИЛИ бележка за деня. Бележката се
     брои, защото „затворено — ремонт“ е валидно вписване на ден без работа. */
  function dnevnikDayFilled(row) {
    if (!row) return false;
    if (String(row.note || '').trim()) return true;
    return DNEVNIK_FIELDS.some(f => (Number(row[f]) || 0) !== 0);
  }
  /* КАЛЕНДАРЪТ НА БИБЛИОТЕКАТА, ПРОЧЕТЕН ОТТУК (одит v2.4.65, находка В3).
     =====================================================================
     Дневникът не питаше календара изобщо: ден, в който библиотеката е затворена
     (неработен ден от седмицата или изрично затворена дата — ремонт, празник),
     изглеждаше в таблицата точно като всеки друг, а вписаната в него работа
     минаваше без дума и влизаше в „вписани работни дни“ на годишния отчет.
     Таблото отдавна си има `isTodayOpen` (handlers/dashboard.js) — Дневникът,
     който е самият формуляр за проверка, нямаше нищо.
     Правилото е ДОСЛОВНО същото като isWorkDay() в handlers/calendar.js: ден от
     седмицата извън `settings.work_days` ИЛИ дата в `calendar_closed`. Тук то се
     чете направо от двете таблици, защото main.js (забранен за пипане този кръг)
     не подава isWorkDay в зависимостите на този модул — в доклада е записано, че
     правилното място е да се подаде оттам, както се подава на Таблото. Денят от
     седмицата се смята в UTC от голия низ „ГГГГ-ММ-ДД“, както в calendar.js:
     местната полунощ при UTC+2/+3 дава ден по-рано и проверява грешния ден. */
  function dnevnikClosedDays(db, from, to) {
    const s = db.prepare('SELECT work_days FROM settings WHERE id = 1').get() || {};
    const raw = s.work_days == null ? '0,1,2,3,4,5,6' : s.work_days;
    const set = new Set(String(raw).split(',').map(x => parseInt(x, 10)).filter(n => !isNaN(n)));
    const wd = set.size ? set : new Set([0, 1, 2, 3, 4, 5, 6]); // празна/повредена настройка — не блокирай всичко
    const closed = new Map();
    db.prepare('SELECT date, reason FROM calendar_closed WHERE date BETWEEN ? AND ?').all(from, to)
      .forEach(r => closed.set(r.date, r.reason || null));
    return (date) => {
      if (closed.has(date)) return { closed: true, reason: closed.get(date) };
      const dow = new Date(date + 'T00:00:00Z').getUTCDay();
      return wd.has(dow) ? { closed: false, reason: null } : { closed: true, reason: 'неработен ден от седмицата' };
    };
  }
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
      /* Календарът и истинското покритие на месеца се връщат ЗАЕДНО с дните
         (одит v2.4.65, находки В1–В3): екранът рисува затворените дни различно,
         а печатът казва колко дни изобщо са вписани, вместо да излиза готов за
         подпис формуляр от нули без нито дума. */
      const closedOf = dnevnikClosedDays(db, from, to);
      const days = [];
      let daysFilled = 0, daysFilledClosed = 0;
      for (let d = 1; d <= dim; d++) {
        const date = `${y}-${pad(m)}-${pad(d)}`;
        const row = byDate[date] || { date };
        const c = closedOf(date);
        const filled = dnevnikDayFilled(byDate[date]);
        if (filled) { daysFilled++; if (c.closed) daysFilledClosed++; }
        days.push(Object.assign({ day: d, date }, row, dnevnikTotals(row),
          { closed: c.closed, closedReason: c.reason, filled }));
      }
      const monthTotal = dnevnikSumRow(rows);
      const ytdRows = db.prepare('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ?').all(`${y}-01-01`, to);
      const ytdTotal = dnevnikSumRow(ytdRows);
      return { year: y, month: m, daysInMonth: dim, days, monthTotal, ytdTotal,
        daysFilled, daysFilledClosed,
        ytdDaysFilled: ytdRows.filter(dnevnikDayFilled).length };
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
      if (!isValidIsoDate(d.date)) throw new Error('Датата на деня липсва или е невалидна.');
      const payload = { date: d.date };
      /* Одит v2.4.29: „-5“ влизаше в клетката и оттам в месечните и годишните сборове
         без възражение. Формулярът брои хора и документи — само цели числа, 0 или повече. */
      /* ДРОБНОТО ЧИСЛО СЕ ОТКАЗВА, А НЕ СЕ ОТРЯЗВА (одит v2.4.65, находка Б17).
         =====================================================================
         ДОТУК проверката беше `parseInt(d[f], 10) || 0` и ловеше само
         отрицателното. „2,7“ в клетка се записваше като 2, „4,8“ като 4, „3abc“
         като 3 — а клетката на екрана продължаваше да показва въведеното: до
         съседната колона „Всичко“ с 4 стоеше клетка с 4,8, а месечният сбор
         броеше 12 при видими 12,5. Нито едно известие; измерено в жив прозорец.
         Същият случай е отказан в „Посещения“ още от v2.4.29
         (handlers/visits.js) — Дневникът, който е самият официален формуляр,
         беше останал непокрит.
         ОТКАЗ, а не закръгляне: числото, което човекът вижда в клетката, и
         числото в подписания формуляр трябва да са едно и също. Записването на
         3 вместо 2,7 измисля данни, а мълчаливото отрязване прави сбор, който
         никой няма как да провери. Празната клетка си остава 0 — празно поле в
         хартиения дневник значи „нищо за този ден“, а не грешка. */
      cols.forEach(f => {
        const raw = d[f];
        const str = String(raw == null ? '' : raw).trim();
        const label = DNEVNIK_LABELS[f] || f;
        if (str === '') { payload[f] = 0; return; }
        if (/^-\d+$/.test(str) || (typeof raw === 'number' && raw < 0)) {
          throw new Error('„' + label + '“ не може да бъде отрицателно число (' + d[f] + ').');
        }
        if (!/^\d+$/.test(str)) {
          throw new Error('„' + label + '“ приема цяло число, 0 или повече — въведено е „' + str + '“. '
            + 'Формулярът брои хора и документи, не части от тях: поправете клетката и запишете отново.');
        }
        payload[f] = parseInt(str, 10);
      });
      if (hasNote) payload.note = d.note || null;
      const names = cols.concat(hasNote ? ['note'] : []);
      db.prepare(`
        INSERT INTO dnevnik_days (date, ${names.join(',')})
        VALUES (@date, ${names.map(f => '@' + f).join(',')})
        ON CONFLICT(date) DO UPDATE SET ${names.map(f => f + '=excluded.' + f).join(',')}
      `).run(payload);
      logAudit('Дневник', 'вписан ден ' + d.date);
      /* ПРЕДУПРЕЖДЕНИЯ СЛЕД ЗАПИСА — не отказ (одит v2.4.65, находки В3 и А).
         =====================================================================
         Двете неща по-долу не са грешки: библиотеката наистина може да е
         работила в затворен ден (дежурство, мероприятие), а половин попълнен
         Раздел А е нормално състояние, докато денят още се води. Затова записът
         минава, но програмата ГО КАЗВА — дотук и двете минаваха без дума.
         (а) Затворен ден: работа, вписана в ден, който календарът обявява за
             затворен, се появява в годишния отчет като работен ден. Или денят е
             работен и календарът трябва да се поправи, или числото е попаднало
             на грешен ред.
         (б) Четирите „Всичко“ на Раздел А: официалният формуляр иска ЕДИН И СЪЩ
             брой читатели по възраст, по пол, по образование и по занятие.
             Програмата може да предложи само възрастта (картонът на читателя не
             пази пол, образование и занятие — виж dnevnik:suggest), затова при
             попълване само с „⚡ Предложи от регистрите“ редът излиза 2 / 0 / 1 / 0.
             Изписва се само при запис на ЦЕЛИЯ формуляр („Запиши деня“), не при
             всяка редактирана клетка в таблицата — иначе би се обаждало при
             всяко число, вписано по реда си.
         (в) „Деца до 14 г.“ е ПОДМНОЖЕСТВО на „В заемна за дома“ по формуляра;
             подмножество, по-голямо от множеството си, е аритметично невъзможно. */
      const warnings = [];
      const c = dnevnikClosedDays(db, d.date, d.date)(d.date);
      const stored = db.prepare('SELECT * FROM dnevnik_days WHERE date = ?').get(d.date);
      if (c.closed && dnevnikDayFilled(stored)) {
        warnings.push('По календара ' + d.date + ' е затворен ден'
          + (c.reason ? ' (' + c.reason + ')' : '') + ', а за него е вписана работа. '
          + 'Ако библиотеката наистина е работила, отворете деня от „Настройки → Календар“; '
          + 'иначе проверете дали числата не са попаднали на грешен ред — годишният отчет ще го брои за работен ден.');
      }
      const fullForm = DNEVNIK_A_FIELDS.every(f => d[f] !== undefined);
      if (fullForm && stored) {
        const t = dnevnikTotals(stored);
        const four = [t.a_total_age, t.a_total_sex, t.a_total_edu, t.a_total_prof];
        if (Math.max(...four) > 0 && new Set(four).size > 1) {
          warnings.push('Раздел А — по възраст ' + t.a_total_age + ', по пол ' + t.a_total_sex
            + ', по образование ' + t.a_total_edu + ', по занятие ' + t.a_total_prof
            + ': четирите „Всичко“ на официалния формуляр броят едни и същи читатели и трябва да съвпадат. '
            + 'Програмата може да изведе само възрастта — пол, образование и занятие не се пазят в картона на читателя. Допълнете ги.');
        }
        if ((stored.a_visit_child || 0) > (stored.a_visit_home || 0)) {
          warnings.push('Посещения — „деца до 14 г.“ (' + (stored.a_visit_child || 0) + ') надхвърля '
            + '„в заемна за дома“ (' + (stored.a_visit_home || 0) + '), а по формуляра децата са ЧАСТ от нея. '
            + 'Допълнете „В заемна за дома“.');
        }
      }
      return { date: d.date, closed: c.closed, warnings };
    })
  );
  // Предложени стойности за един ден на дневника, изведени от потока събития (events).
  // Ръчното въвеждане ОСТАВА меродавно — официалният формуляр се потвърждава от
  // библиотекаря; тук програмата само предлага числата, които може да изведе сама:
  // Раздел Б по вид/език/съдържание от заеманията, посещенията в читалня и по домовете,
  // и разпределението на читателите по възрастови категории.
  /* КОЛОНИТЕ „DVD“ И „ГОВОРЕЩИ КНИГИ“ НЕ ПОЛУЧАВАХА НИЩО НИКОГА (одит v2.4.65, Б15).
     =====================================================================
     ДОТУК картата по име знаеше осемте начални вида, а всичко останало падаше в
     резервната стойност `b_type_books`. Измерено: пет заемания на пет различни
     вида — DVD, говореща книга, патент/стандарт, „друго“ и книга — дадоха
     `{"b_type_books": 5}`. Двете последни колони на официалния формуляр („DVD“ и
     „Говорещи книги“) не можеха да получат число дори когато библиотекарката
     създаде вид с ТОЧНОТО име от формуляра. Надомното обслужване на незрящи
     (handlers/housebound.js) работи именно с говорещи книги — тоест колоната,
     която единствена отчита тази дейност, стоеше празна, а числото ѝ се броеше
     в „Книги“.
     Затова: (1) имената се сравняват НОРМАЛИЗИРАНО (малки букви, събрани
     интервали), за да съвпадат „DVD“, „dvd“ и „DVD-диск“; (2) добавени са
     собствените имена от формуляра и най-честите преименувания, които екранът
     „Категории“ допуска; (3) видовете БЕЗ собствен ред във формуляра
     (патент/стандарт, „друго“ и всеки вид, който библиотекарката е измислила)
     продължават да се предлагат в „Книги“ — иначе редът „Всичко по вид“ би
     станал по-малък от броя заемания, — но вече се ВРЪЩАТ ПОИМЕННО в
     `typeFallback`, за да ги изпише екранът: „2 заемания са на видове без
     собствен ред във формуляра (патент/стандарт, друго) и са предложени в
     «Книги»“. Тихото падане в „Книги“ е причината числото да изглежда вярно и
     никой да не го провери — същата логика като при `unclassified` по-долу. */
  const normType = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
  const DNEVNIK_TYPE_MAP = {
    'книга': 'b_type_books', 'книги': 'b_type_books',
    'продължаващо издание': 'b_type_period', 'периодично издание': 'b_type_period',
    'периодични издания': 'b_type_period', 'периодика': 'b_type_period',
    'графично издание': 'b_type_graphic', 'графични издания': 'b_type_graphic',
    'картографско издание': 'b_type_carto', 'картографски издания': 'b_type_carto',
    'нотно издание': 'b_type_music', 'нотни издания': 'b_type_music',
    'аудиодокумент': 'b_type_audio', 'аудио-касета': 'b_type_audio', 'аудиокасета': 'b_type_audio',
    'видеодокумент': 'b_type_video', 'видео-касета': 'b_type_video', 'видеокасета': 'b_type_video',
    'електронен документ': 'b_type_electronic', 'електронно издание': 'b_type_electronic',
    'електронни издания': 'b_type_electronic',
    // Двете колони на формуляра, които дотук не можеха да получат нищо:
    'dvd': 'b_type_dvd', 'двд': 'b_type_dvd', 'dvd-диск': 'b_type_dvd', 'dvd диск': 'b_type_dvd',
    'говореща книга': 'b_type_talking', 'говорещи книги': 'b_type_talking'
  };
  /* ВИДЪТ СЕ ПОЗНАВА ПО КОД, А ИМЕТО Е САМО РЕЗЕРВА (одит v2.4.61, находка 19).
     =====================================================================
     ДОТУК редът на Раздел Б се избираше от картата по-горе, тоест по БУКВАЛНОТО
     име на вида документ, каквото е било записано в събитието. Името обаче е на
     библиотекаря: екранът „Категории“ позволява преименуване и Наредба № 3 не
     предписва етикетите. Достатъчно е някой да напише „периодично издание“
     вместо „продължаващо издание“ — и заетият годишен комплект на вестник почва
     да се брои в „Книги“ (резервната стойност на add() по-долу). Числото, което
     влиза в официалния дневник и оттам в годишния отчет, става грешно, а на
     екрана нищо не се променя.
     От v2.4.61 началните видове носят непроменлив `code` в `categories` (виж
     db/schema.sql и миграция 16 в main.js). Тук се чете той — през книгата на
     заемането, тоест през ЖИВАТА категория на документа, — а името остава само
     резерва за събития, чиято книга вече е изтрита (тогава помним само снимката
     `events.book_category`) и за бази отпреди миграцията. */
  const DNEVNIK_TYPE_BY_CODE = {
    book: 'b_type_books', periodical: 'b_type_period', graphic: 'b_type_graphic',
    cartographic: 'b_type_carto', music: 'b_type_music', audio: 'b_type_audio',
    video: 'b_type_video', electronic: 'b_type_electronic',
    /* Двата начални вида без ред в официалния формуляр (db/schema.sql — „патент/
       стандарт“ и „друго“). Решението е ИЗРИЧНО: броят се в „Книги“, защото
       редът „Всичко по вид“ трябва да е равен на броя заемания за деня, но
       минават през `DNEVNIK_TYPE_NO_ROW` по-долу и излизат поименно на екрана,
       вместо да изчезнат мълчаливо. Самата схема не се пипа — там кодовете са
       верни, липсва редът във формуляра. */
    patent: 'b_type_books', other: 'b_type_books'
  };
  // Видове, които се броят в „Книги“ САМО защото формулярът няма техен ред —
  // и точно затова се казват на библиотекарката поименно (виж typeFallback).
  const DNEVNIK_TYPE_NO_ROW = new Set(['patent', 'other']);
  /* КОЛОНАТА „СЛАВЯНСКИ“ НЕ СЕ ПРЕДЛАГАШЕ НИКОГА (одит v2.4.65, находка Б16).
     =====================================================================
     ДОТУК картата знаеше пет езика; сръбски, полски, чешки и украински падаха в
     `b_lang_other` заедно с испанския. Раздел Б на формуляра обаче има отделна
     колона „Славянски“ точно за тях (българският и руският са с отделни редове,
     останалите славянски — заедно), тоест една от седемте колони по език не
     можеше да получи число при никакви данни, а „Други“ показваше число, което
     трябва да стои другаде. Имената се сравняват нормализирано и без опашката
     „език“ („руски език“ = „руски“). */
  const normLang = (s) => String(s == null ? '' : s).trim().toLowerCase()
    .replace(/\s+/g, ' ').replace(/\s*език$/, '');
  const DNEVNIK_LANG_MAP = {
    'български': 'b_lang_bg', 'руски': 'b_lang_ru', 'английски': 'b_lang_en',
    'немски': 'b_lang_de', 'френски': 'b_lang_fr',
    // Славянските езици без собствен ред във формуляра — колоната „Славянски“.
    'сръбски': 'b_lang_slavic', 'сърбохърватски': 'b_lang_slavic', 'хърватски': 'b_lang_slavic',
    'босненски': 'b_lang_slavic', 'черногорски': 'b_lang_slavic', 'македонски': 'b_lang_slavic',
    'словенски': 'b_lang_slavic', 'полски': 'b_lang_slavic', 'чешки': 'b_lang_slavic',
    'словашки': 'b_lang_slavic', 'украински': 'b_lang_slavic', 'беларуски': 'b_lang_slavic',
    'белоруски': 'b_lang_slavic', 'църковнославянски': 'b_lang_slavic',
    'старобългарски': 'b_lang_slavic'
  };
  // Проверява се от най-дългия префикс към най-късия — иначе „793" би хванало „7".
  /* Таблицата ТРЯБВА да покрива всяка цифра 0-9 на последно място, иначе заемането
     не попада в никоя колона и трите реда „Всичко“ на Раздел Б (по вид, по език, по
     съдържание) не се събират: по вид и по език се брои винаги (има резервна
     стойност), по съдържание — само при съвпадение. Липсваха точно „8“ и „6“:
     езикознание 81 и приложните науки 65-68 не влизаха никъде. */
  const DNEVNIK_UDK_PREFIXES = [
    ['793', 'b_cat_793'], ['794', 'b_cat_793'], ['795', 'b_cat_793'], ['796', 'b_cat_793'],
    ['797', 'b_cat_793'], ['798', 'b_cat_793'], ['799', 'b_cat_793'], // 793/799 — спортни игри и спорт
    ['91', 'b_cat_91'], ['80', 'b_cat_80'],
    ['81', 'b_cat_80'], // езикознание — заедно с 80, както е в самия формуляр
    ['82', 'b_cat_82'], ['61', 'b_cat_61'], ['62', 'b_cat_62'], ['63', 'b_cat_63'],
    ['64', 'b_cat_62'], ['69', 'b_cat_62'], ['0', 'b_cat_0'], ['1', 'b_cat_1'], ['2', 'b_cat_2'],
    ['3', 'b_cat_3'], ['5', 'b_cat_5'],
    ['6', 'b_cat_62'], // 65-68 — управление, химични и други производства: приложни науки
    ['7', 'b_cat_7'],
    ['8', 'b_cat_82'], // остатъкът от клас 8 — литературознание (художествената е по-долу)
    ['9', 'b_cat_9']
  ];
  /* Одит v2.4.29: ВСЯКА художествена литература попадаше в „82/89 Литературознание“ —
     префиксът „82“ хваща и романа (821.163.2-31), и поезията (82-1), и детската
     (82-93), а колоните „Художествена литература“ и „Детска художествена л-ра“ на
     формуляра никога не се предлагаха. В обществената библиотека това е по-голямата
     част от заеманията. Формулярът (Раздел Б) отделя художествената от науката за
     литературата, затова тук се гледа не само класът, а и определителят за форма:
       • 82…-N (‑1 поезия, ‑2 драма, ‑3 проза, ‑31 роман, ‑32 разкази, ‑4 есета,
         ‑6 писма) и 821.xxx без определител (литература на даден народ) —
         художествена; ‑93 (за деца и юноши) — детска художествена;
       • сигнатурата „Д“ (детски отдел) — детска художествена; „Д.09“ / „Д 09“ —
         детска отраслова, както са надписани колоните на формуляра;
       • 82.0…, 82(091), 821.xxx.09, 82-95 (критика) — литературознание, както досега. */
  function dnevnikFictionColumn(udk) {
    const u = udk.replace(/\s+/g, '');
    if (/^Д/i.test(u)) return /^Д[. ]?09/i.test(u) ? 'b_cat_child_nf' : 'b_cat_child_f';
    if (!/^8/.test(u)) return null;
    const hist = /\(091\)/.test(u);
    if (/^8[01]/.test(u)) return null;          // 80/81 езикознание — по таблицата с префиксите
    if (/-93/.test(u)) return 'b_cat_child_f';
    if (hist || /^8\d*(\.\d+)*\.0\d*/.test(u) || /-95/.test(u)) return 'b_cat_82';
    /* Определител за форма (‑1/‑2/‑3/‑31…) или литература на даден народ — и по
       новата таблица (821.163.2), и по старата (886.7 българска, 820 английска,
       882 руска…), която стои в много стари бази. */
    if (/^8\d[\d.]*-\d/.test(u) || /^8[2-9]\d/.test(u)) return 'b_cat_fiction';
    return 'b_cat_82';
  }
  const DNEVNIK_AGE_MAP = {
    'дете до 14 г.': 'a_age_u14', 'ученик': 'a_age_15_18', 'студент': 'a_age_19_28'
  };
  ipcMain.handle('dnevnik:suggest', (e, { date }) =>
    run(() => {
      const db = getDb();
      /* Категорията се чете ЖИВА през книгата (виж DNEVNIK_TYPE_BY_CODE по-горе):
         `events.book_category` е снимка на името към деня на заемането и не знае
         нищо за по-късно преименуване. Колоната `code` може да липсва в база
         отпреди миграция 16 — тогава подзаявката просто не се добавя и всичко
         работи както преди, по име. */
      const hasCode = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('categories') WHERE name = 'code'").get().n > 0;
      const events = db.prepare(hasCode
        ? `SELECT ev.*, (SELECT c.code FROM books b JOIN categories c ON c.id = b.category_id
             WHERE b.id = ev.book_id) AS book_category_code
           FROM events ev WHERE ev.date = ?`
        : 'SELECT * FROM events WHERE date = ?').all(date);
      const out = {};
      const add = (k, n) => { if (k) out[k] = (out[k] || 0) + (n == null ? 1 : n); };
      const seenReaders = new Set();
      let unclassified = 0;          // заемания на КНИГИ без разпознат УДК — виж по-долу
      let periodicalsByType = 0;     // заети периодични издания — броят се по ВИД, не по съдържание
      const fallbackByName = new Map(); // вид без ред във формуляра → бройка (виж Б15 по-горе)
      let noTypeAtAll = 0;              // документ, записан изобщо без вид
      for (const ev of events) {
        if (ev.kind === 'читалня') { add('a_visit_reading'); continue; }
        if (ev.kind === 'дома') { add('a_visit_home'); continue; }
        if (ev.kind !== 'заемане') continue;
        // Раздел Б — по вид, език и съдържание, само за реално заетите този ден.
        const code = ev.book_category_code;
        const nm = normType(ev.book_category);
        const byCode = code ? DNEVNIK_TYPE_BY_CODE[code] : null;
        const typeKey = byCode || DNEVNIK_TYPE_MAP[nm] || 'b_type_books';
        /* Видът няма СОБСТВЕН ред във формуляра в два случая: познат код без ред
           (патент/стандарт, „друго“) и изцяло непознат вид, измислен от
           библиотекарката. И в двата се брои в „Книги“, но се назовава. */
        if ((code && DNEVNIK_TYPE_NO_ROW.has(code)) || (!byCode && !DNEVNIK_TYPE_MAP[nm])) {
          const label = String(ev.book_category || '').trim();
          /* Документ БЕЗ посочен вид изобщо (картонът е записан без да се избере
             вид) се брои отделно от видовете, които просто нямат ред във
             формуляра: изходът е различен — там се попълва картонът, тук се
             мести колона. */
          if (label) fallbackByName.set(label, (fallbackByName.get(label) || 0) + 1);
          else noTypeAtAll++;
        }
        add(typeKey);
        add(DNEVNIK_LANG_MAP[normLang(ev.book_language)] || 'b_lang_other');
        /* Книга без попълнен УДК не може да бъде подредена по съдържание. Да бъде
           набутана в „Общ отдел“ би било по-лошо от това да не бъде броена — числото
           щеше да изглежда вярно и никой не би проверил. Затова тук се брои отделно
           и се връща на изгледа, за да каже на библиотекаря колко реда трябва да
           допълни ръчно, вместо трите „Всичко“ да се разминават необяснимо. */
        /* ПЕРИОДИКАТА НЕ Е „КНИГА БЕЗ УДК“ (одит v2.4.61, находка 13).
           =====================================================================
           ДОТУК всяко заемане без разпознат УДК влизаше в `unclassified`, а
           екранът го изписваше дословно: „1 заемане е на книга без УДК … допълнете
           го ръчно“. От v2.4.56 насам обаче през тази бройка минава и годишният
           комплект на вестник или списание — а той НЯМА и не бива да има УДК:
           периодичното издание не се класира по съдържание, защото съдържанието му
           е различно във всеки брой. Съобщението пращаше библиотекарката да търси
           УДК за вестник — работа, която не съществува, и която, ако бъде свършена
           „както трябва“, вкарва вестника в отраслов ред на Раздел Б, където му
           няма мястото.
           Затова заетата периодика се брои ОТДЕЛНО: тя си е напълно отчетена в
           „по вид“ (ред „Периодични издания“) и единственото вярно нещо, което
           може да се каже за нея, е че по съдържание не се брои. Числото се връща
           като `periodicalsByType`, за да може изгледът да го изпише със СОБСТВЕН
           текст (описано е в доклада — src/views/dnevnik.js се пипа от друг).
           Периодика с попълнен УДК (среща се при годишниците на институти) се
           класира нормално — тогава указанието на библиотекаря е меродавно. */
        const udk = String(ev.book_udk || '').trim();
        const fiction = udk ? dnevnikFictionColumn(udk) : null;
        const hit = !fiction && udk ? DNEVNIK_UDK_PREFIXES.find(([p]) => udk.startsWith(p)) : null;
        if (fiction) add(fiction);
        else if (hit) add(hit[1]);
        else if (typeKey === 'b_type_period') periodicalsByType++;
        else unclassified++;
        // Раздел А — всеки читател се брои веднъж на ден, по категорията му към момента.
        const rk = ev.reader_id || ('cat:' + ev.reader_category + ':' + ev.id);
        if (!seenReaders.has(rk)) {
          seenReaders.add(rk);
          add(DNEVNIK_AGE_MAP[ev.reader_category] || 'a_age_o28');
          if (ev.reader_category === 'дете до 14 г.') add('a_visit_child');
        }
      }
      /* ЧЕТИРИТЕ „ВСИЧКО“ НА РАЗДЕЛ А — ВРЪЩАТ СЕ, ЗА ДА СЕ ВИДЯТ (одит v2.4.65,
         находка А от доклада).
         =====================================================================
         Предложението попълва само `a_age_*` и `a_visit_child`, защото това е
         всичко, което програмата ЗНАЕ: картонът на читателя (`readers`) няма пол,
         образование и занятие, а официалният формуляр ги иска. Затова четирите
         реда „Всичко“ на Раздел А излизат например 2 / 0 / 1 / 0 — три от тях си
         противоречат с формуляра, а подмножеството „деца до 14 г.“ (1) може да
         надхвърли множеството „в заемна за дома“ (0). Раздел Б има закована
         инвариантност за същото (test/fixes-audit-numbers.test.js). АВТОМАТИЧНО
         попълване не се предлага — числа, които програмата не знае, не се
         измислят; вместо това разминаването се ВРЪЩА и екранът го изписва, за да
         знае библиотекарката какво остава за нея. */
      const aTotals = dnevnikTotals(out);
      return { date, suggestions: out, eventsCount: events.length, unclassified, periodicalsByType,
        typeFallback: [...fallbackByName.entries()].sort((a, b) => b[1] - a[1]), typeMissing: noTypeAtAll,
        sectionA: {
          age: aTotals.a_total_age, sex: aTotals.a_total_sex,
          edu: aTotals.a_total_edu, prof: aTotals.a_total_prof,
          visitHome: out.a_visit_home || 0, visitChild: out.a_visit_child || 0
        } };
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
