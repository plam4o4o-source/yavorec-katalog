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
  ipcMain.handle('dnevnik:saveDay', (e, d) =>
    run(() => {
      const db = getDb();
      const payload = { date: d.date };
      DNEVNIK_FIELDS.forEach(f => { payload[f] = parseInt(d[f], 10) || 0; });
      payload.note = d.note || null;
      db.prepare(`
        INSERT INTO dnevnik_days (date, ${DNEVNIK_FIELDS.join(',')}, note)
        VALUES (@date, ${DNEVNIK_FIELDS.map(f => '@' + f).join(',')}, @note)
        ON CONFLICT(date) DO UPDATE SET
          ${DNEVNIK_FIELDS.map(f => f + '=excluded.' + f).join(',')}, note=excluded.note
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
  const DNEVNIK_UDK_PREFIXES = [
    ['793', 'b_cat_793'], ['799', 'b_cat_793'], ['91', 'b_cat_91'], ['80', 'b_cat_80'],
    ['82', 'b_cat_82'], ['61', 'b_cat_61'], ['62', 'b_cat_62'], ['63', 'b_cat_63'],
    ['64', 'b_cat_62'], ['69', 'b_cat_62'], ['0', 'b_cat_0'], ['1', 'b_cat_1'], ['2', 'b_cat_2'],
    ['3', 'b_cat_3'], ['5', 'b_cat_5'], ['7', 'b_cat_7'], ['9', 'b_cat_9']
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
      for (const ev of events) {
        if (ev.kind === 'читалня') { add('a_visit_reading'); continue; }
        if (ev.kind === 'дома') { add('a_visit_home'); continue; }
        if (ev.kind !== 'заемане') continue;
        // Раздел Б — по вид, език и съдържание, само за реално заетите този ден.
        add(DNEVNIK_TYPE_MAP[ev.book_category] || 'b_type_books');
        add(DNEVNIK_LANG_MAP[ev.book_language] || 'b_lang_other');
        const udk = String(ev.book_udk || '').trim();
        if (udk) {
          const hit = DNEVNIK_UDK_PREFIXES.find(([p]) => udk.startsWith(p));
          if (hit) add(hit[1]);
        }
        // Раздел А — всеки читател се брои веднъж на ден, по категорията му към момента.
        const rk = ev.reader_id || ('cat:' + ev.reader_category + ':' + ev.id);
        if (!seenReaders.has(rk)) {
          seenReaders.add(rk);
          add(DNEVNIK_AGE_MAP[ev.reader_category] || 'a_age_o28');
          if (ev.reader_category === 'дете до 14 г.') add('a_visit_child');
        }
      }
      return { date, suggestions: out, eventsCount: events.length };
    })
  );
  ipcMain.handle('dnevnik:exportCsv', async (e, { year, month }) => {
    try {
      const db = getDb();
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Експорт на дневника (CSV)',
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
      const h = ['Дата', ...DNEVNIK_FIELDS];
      const csv = [h.join(';')].concat(
        Array.from({ length: dim }, (_, i) => {
          const date = `${y}-${pad(m)}-${pad(i + 1)}`;
          const row = byDate[date] || {};
          // csvCell вместо собствен esc(): собственият само ограждаше в кавички и
          // пропускаше защитата срещу formula-injection (клетка, започваща с
          // '=', '+', '-', '@' — напр. дата, въведена като „-2026…", или бъдещо
          // текстово поле в дневника — се изпълнява като формула при отваряне в
          // Excel/LibreOffice).
          return [date, ...DNEVNIK_FIELDS.map(f => row[f] || 0)].map(csvCell).join(';');
        })
      ).join('\r\n');
      fs.writeFileSync(filePath, '﻿' + csv, 'utf8');
      return { ok: true, data: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  return { dnevnikSumRow };
};
