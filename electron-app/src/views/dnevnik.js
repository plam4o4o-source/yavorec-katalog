/* ---------------- Дневник на библиотеката (Раздел А / Раздел Б) ----------------
   Електронен вариант на официалния месечен статистически дневник на читалищните
   библиотеки, по образец на e_Dnevnik_AB_CH2. Един ред на календарен ден;
   месечните и годишните (от началото на годината) тотали се смятат живо от
   main.js при всяко зареждане — не се пазят и не се въвеждат ръчно. */
let DNEVNIK_YEAR = null, DNEVNIK_MONTH = null, DNEVNIK_TAB = 'a';
const MESETSI = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];
function hhmm(mins) { mins = mins || 0; return Math.floor(mins / 60) + ':' + String(mins % 60).padStart(2, '0'); }
function parseHhmm(s) {
  const m = String(s || '').trim().match(/^(\d+):(\d{1,2})$/);
  return m ? parseInt(m[1], 10) * 60 + Math.min(59, parseInt(m[2], 10)) : 0;
}
const DNEVNIK_A_COLS = [
  ['a_hours', 'Часове'], ['$a_total_age', 'Всичко'], ['a_age_u14', 'До 14'], ['a_age_15_18', '15–18'],
  ['a_age_19_28', '19–28'], ['a_age_o28', 'Над 28'], ['$a_total_sex', 'Всичко'], ['a_sex_boys', 'М-деца'],
  ['a_sex_men', 'М-възр.'], ['a_sex_girls', 'Ж-деца'], ['a_sex_women', 'Ж-възр.'], ['$a_total_edu', 'Всичко'],
  ['a_edu_basic', 'Основно'], ['a_edu_sec', 'Средно'], ['a_edu_high', 'Висше'], ['$a_total_prof', 'Всичко'],
  ['a_prof_industry', 'Пром./стр.'], ['a_prof_agri', 'Сел.стоп.'], ['a_prof_eng', 'Инж.-техн.'],
  ['a_prof_agrospec', 'Сел.спец.'], ['a_prof_med', 'Медицин.'], ['a_prof_sci', 'Матем./физ.'],
  ['a_prof_hum', 'Хуманит.'], ['a_prof_creative', 'Творч.'], ['a_prof_teach', 'Учители'], ['a_prof_other', 'Други'],
  ['a_stud_uni', 'Студенти'], ['a_stud_high', 'Горна ст.'], ['a_stud_sec', 'Средна ст.'], ['a_stud_elem', 'Начал. ст.'],
  ['a_visit_home', 'Дома'], ['a_visit_child', 'Деца<14'], ['a_visit_reading', 'Читалня'], ['a_visit_internet', 'Интернет']
];
const DNEVNIK_B_COLS = [
  ['b_hours', 'Часове'], ['$b_total_type', 'Всичко'], ['b_type_books', 'Книги'], ['b_type_period', 'Период.'],
  ['b_type_graphic', 'Графич.'], ['b_type_carto', 'Картогр.'], ['b_type_music', 'Нотни'], ['b_type_audio', 'Аудио'],
  ['b_type_video', 'Видео'], ['b_type_electronic', 'Електр.'], ['b_type_dvd', 'DVD'], ['b_type_talking', 'Говор.'],
  ['$b_total_lang', 'Всичко'], ['b_lang_bg', 'Българ.'], ['b_lang_ru', 'Руски'], ['b_lang_slavic', 'Славян.'],
  ['b_lang_en', 'Англ.'], ['b_lang_de', 'Нем.'], ['b_lang_fr', 'Френ.'], ['b_lang_other', 'Други'],
  ['$b_total_content', 'Всичко'], ['b_cat_0', '0 Общ'], ['b_cat_1', '1 Фил.'], ['b_cat_2', '2 Рел.'],
  ['b_cat_3', '3 Общ.н.'], ['b_cat_5', '5 Мат./ест.'], ['b_cat_61', '61 Мед.'], ['b_cat_62', '62 Техн.'],
  ['b_cat_63', '63 С.стоп.'], ['b_cat_7', '7 Изк.'], ['b_cat_793', '793 Спорт'], ['b_cat_80', '80 Ез.'],
  ['b_cat_82', '82 Лит.'], ['b_cat_9', '9 Ист.'], ['b_cat_91', '91 Геогр.'], ['b_cat_fiction', 'Худ. л-ра'],
  ['b_cat_child_nf', 'Дет.отр.'], ['b_cat_child_f', 'Дет.худ.'], ['b_cat_reading_used', 'В читални']
];
/* Всички реални (въвеждани) полета от ДВАТА раздела. Записът в базата презаписва целия ред,
   затова при запис на клетка от Раздел А трябва да се изпратят и стойностите на Раздел Б —
   иначе те биха се нулирали. */
const DNEVNIK_ALL_FIELDS = [...DNEVNIK_A_COLS, ...DNEVNIK_B_COLS]
  .map(([k]) => k).filter(k => !k.startsWith('$'));
function dnevnikCell(row, key) {
  if (key === 'a_hours' || key === 'b_hours') return hhmm(row[key]);
  const k = key.startsWith('$') ? key.slice(1) : key;
  return row[k] || 0;
}
async function renderDnevnik() {
  const y = DNEVNIK_YEAR || parseInt(yr(), 10);
  const m = DNEVNIK_MONTH || (new Date().getMonth() + 1);
  DNEVNIK_YEAR = y; DNEVNIK_MONTH = m;
  const r = await call(window.api.dnevnik.getMonth({ year: y, month: m }));
  if (!r) return;
  window._DNEVNIK = r;
  const cols = DNEVNIK_TAB === 'b' ? DNEVNIK_B_COLS : DNEVNIK_A_COLS;
  // Текущата година и няколко назад (yearOptions в core.js), като числа. Дотогава
  // менюто имаше една опция и на 5 януари дневникът за декември предната година
  // не можеше да се отвори — а точно тогава се приключва и разпечатва.
  const years = yearOptions(y, true);
  const todayStr = today();
  // Всяка клетка е поле за въвеждане — попълва се направо в таблицата, като в хартиения
  // дневник. Изчислените колони („Всичко“) и двата обобщителни реда остават само за четене,
  // защото се смятат от въведените стойности.
  const cellHtml = (row, k) => {
    if (k.startsWith('$')) return `<td class="num calc">${dnevnikCell(row, k)}</td>`;
    if (k === 'a_hours' || k === 'b_hours') {
      return `<td><input class="dnvCell hrs" type="text" value="${hhmm(row[k])}" placeholder="0:00"
        data-date="${row.date}" data-field="${k}" onchange="dnevnikSaveCell(this)"></td>`;
    }
    return `<td><input class="dnvCell" type="number" min="0" value="${row[k] || 0}"
      data-date="${row.date}" data-field="${k}" onchange="dnevnikSaveCell(this)"></td>`;
  };
  const dayRowHtml = (row) => `<tr class="${row.date === todayStr ? 'dnvToday' : ''}">
    <td class="num dnvDay">${row.day}</td>${cols.map(([k]) => cellHtml(row, k)).join('')}</tr>`;
  const totalRowHtml = (label, row, cls) => `<tr class="dnvTotal ${cls || ''}"><td>${esc(label)}</td>
    ${cols.map(([k]) => `<td class="num">${dnevnikCell(row, k)}</td>`).join('')}</tr>`;
  $('#view').innerHTML = `
    <div class="note">Електронен вариант на месечния статистически дневник на читалищните библиотеки —
    Раздел А (читатели и посещения) и Раздел Б (заети материали). <b>Попълва се направо в таблицата</b> —
    всяка стойност се записва веднага при излизане от полето. Колоните „Всичко“ и двата обобщителни
    реда се изчисляват автоматично и не се въвеждат ръчно.</div>
    <div class="toolbar">
      <select onchange="DNEVNIK_YEAR=parseInt(this.value,10);renderDnevnik()">${years.map(x => `<option value="${x}" ${x === y ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <select onchange="DNEVNIK_MONTH=parseInt(this.value,10);renderDnevnik()">${MESETSI.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <div style="display:flex;gap:6px">
        <button class="btn sm ${DNEVNIK_TAB === 'a' ? 'pri' : ''}" onclick="DNEVNIK_TAB='a';renderDnevnik()">Раздел А · Читатели и посещения</button>
        <button class="btn sm ${DNEVNIK_TAB === 'b' ? 'pri' : ''}" onclick="DNEVNIK_TAB='b';renderDnevnik()">Раздел Б · Заети материали</button>
      </div>
      <button class="btn" onclick="dnevnikDayForm('${todayStr}')">Подробно за днес…</button>
      <button class="btn" onclick="printDnevnikDoc()">Печат / PDF</button>
      <button class="btn" onclick="exportDnevnikCsv()">Експорт CSV</button>
    </div>
    <div class="wrap"><table class="ledger dnvTable"><thead><tr>
      <th>Число</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}
    </tr></thead><tbody>
      ${r.days.map(dayRowHtml).join('')}
      ${totalRowHtml('Всичко за месеца', r.monthTotal)}
      ${totalRowHtml('Всичко от нач. на годината', r.ytdTotal, 'ytd')}
    </tbody></table></div>`;
}
/* Записва една клетка и опреснява само изчислените колони и двата обобщителни реда,
   без да пречертава цялата таблица — така фокусът и позицията на превъртане се запазват
   и въвеждането ден след ден остава непрекъснато. */
async function dnevnikSaveCell(el) {
  const date = el.dataset.date, field = el.dataset.field;
  const r = window._DNEVNIK;
  const row = r && r.days.find(d => d.date === date);
  if (!row) return;
  const val = (field === 'a_hours' || field === 'b_hours') ? parseHhmm(el.value) : (parseInt(el.value, 10) || 0);
  if ((row[field] || 0) === val) return; // без промяна — не пипай базата
  row[field] = val;
  const payload = { date };
  DNEVNIK_ALL_FIELDS.forEach(f => { payload[f] = row[f] || 0; });
  payload.note = row.note || '';
  const res = await window.api.dnevnik.saveDay(payload);
  if (!res.ok) return toast(res.error, 'err');
  markSaved();
  el.classList.add('saved');
  setTimeout(() => el.classList.remove('saved'), 700);
  if (field === 'a_hours' || field === 'b_hours') el.value = hhmm(val);
  await dnevnikRefreshTotals();
}
window.dnevnikSaveCell = dnevnikSaveCell;
async function dnevnikRefreshTotals() {
  const r = await call(window.api.dnevnik.getMonth({ year: DNEVNIK_YEAR, month: DNEVNIK_MONTH }));
  if (!r) return;
  window._DNEVNIK = r;
  const cols = DNEVNIK_TAB === 'b' ? DNEVNIK_B_COLS : DNEVNIK_A_COLS;
  // изчислените колони по редовете
  r.days.forEach(row => {
    cols.forEach(([k]) => {
      if (!k.startsWith('$')) return;
      const cell = document.querySelector(`.dnvTable tbody tr:nth-child(${row.day}) td:nth-child(${cols.findIndex(c => c[0] === k) + 2})`);
      if (cell) cell.textContent = dnevnikCell(row, k);
    });
  });
  // двата обобщителни реда
  const rows = document.querySelectorAll('.dnvTable tbody tr.dnvTotal');
  const fill = (tr, data) => {
    if (!tr) return;
    cols.forEach(([k], i) => {
      const td = tr.children[i + 1];
      if (td) td.textContent = dnevnikCell(data, k);
    });
  };
  fill(rows[0], r.monthTotal);
  fill(rows[1], r.ytdTotal);
}
function dnevnikGroup(title, fields, row) {
  return `<fieldset><legend>${esc(title)}</legend><div class="grid g4">
    ${fields.map(([k, l]) => `<div class="field"><label>${esc(l)}</label>
      <input type="number" min="0" name="${k}" value="${row[k] || 0}" oninput="dnevnikPreview()"></div>`).join('')}
    </div></fieldset>`;
}
async function dnevnikDayForm(date) {
  const days = (window._DNEVNIK && window._DNEVNIK.days) || [];
  const row = days.find(d => d.date === date) || { date };
  modal('Дневник — ' + bg(date), `
    <form id="dnvF" onsubmit="return false">
    <div class="toolbar" style="margin:0 0 10px">
      <button type="button" class="btn sm" onclick="dnevnikSuggest('${date}')"
        title="Попълва празните полета от регистрите на програмата (заемания, читалня, посещения по домовете). Ръчно въведените числа не се пипат — официалният формуляр остава меродавен.">⚡ Предложи от регистрите</button>
      <span class="hint" id="dnvSugHint"></span>
    </div>
    <div class="cards" id="dnvPreview" style="margin-bottom:12px"></div>
    <h3 style="font-size:14px">Раздел А — читатели и посещения</h3>
    <fieldset><legend>Часове на обслужване</legend>
      <div class="field"><label>Часове (чч:мм)</label>
      <input type="text" name="a_hours_hhmm" value="${hhmm(row.a_hours)}" placeholder="8:00" oninput="dnevnikPreview()"></div>
    </fieldset>
    ${dnevnikGroup('По възраст', [['a_age_u14', 'До 14 г.'], ['a_age_15_18', '15–18 г.'], ['a_age_19_28', '19–28 г.'], ['a_age_o28', 'Над 28 г.']], row)}
    ${dnevnikGroup('По пол', [['a_sex_boys', 'Мъже — деца'], ['a_sex_men', 'Мъже — възрастни'], ['a_sex_girls', 'Жени — деца'], ['a_sex_women', 'Жени — възрастни']], row)}
    ${dnevnikGroup('По образование', [['a_edu_basic', 'Основно'], ['a_edu_sec', 'Средно'], ['a_edu_high', 'Висше']], row)}
    ${dnevnikGroup('По професия', [['a_prof_industry', 'Пром./строит./трансп.'], ['a_prof_agri', 'Селско стопанство'],
      ['a_prof_eng', 'Инж.-технически'], ['a_prof_agrospec', 'Селскостоп. специалисти'], ['a_prof_med', 'Медицински'],
      ['a_prof_sci', 'Матем./физ./хим./геол./геогр./биол.'], ['a_prof_hum', 'Филос./социол./истор./педаг./филол./икон./юрист'],
      ['a_prof_creative', 'Писатели/журналисти/артисти/художн./музиканти'], ['a_prof_teach', 'Учители'], ['a_prof_other', 'Други']], row)}
    ${dnevnikGroup('Учащи се', [['a_stud_uni', 'Студенти'], ['a_stud_high', 'Горна степен'], ['a_stud_sec', 'Средна степен'], ['a_stud_elem', 'Начална степен']], row)}
    ${dnevnikGroup('Посещения', [['a_visit_home', 'В заемна за дома'], ['a_visit_child', 'Деца до 14 г.'], ['a_visit_reading', 'В читалня'], ['a_visit_internet', 'Интернет']], row)}
    <h3 style="font-size:14px">Раздел Б — заети материали</h3>
    <fieldset><legend>Часове на обслужване</legend>
      <div class="field"><label>Часове (чч:мм)</label>
      <input type="text" name="b_hours_hhmm" value="${hhmm(row.b_hours)}" placeholder="8:00" oninput="dnevnikPreview()"></div>
    </fieldset>
    ${dnevnikGroup('По вид', [['b_type_books', 'Книги'], ['b_type_period', 'Периодични издания'], ['b_type_graphic', 'Графични издания'],
      ['b_type_carto', 'Картографски издания'], ['b_type_music', 'Нотни издания'], ['b_type_audio', 'Аудио-касети'],
      ['b_type_video', 'Видео-касети'], ['b_type_electronic', 'Електронни издания'], ['b_type_dvd', 'DVD'], ['b_type_talking', 'Говорещи книги']], row)}
    ${dnevnikGroup('По език', [['b_lang_bg', 'Български'], ['b_lang_ru', 'Руски'], ['b_lang_slavic', 'Славянски'],
      ['b_lang_en', 'Английски'], ['b_lang_de', 'Немски'], ['b_lang_fr', 'Френски'], ['b_lang_other', 'Други']], row)}
    ${dnevnikGroup('По съдържание', [['b_cat_0', '0 Общ отдел'], ['b_cat_1', '1 Философия'], ['b_cat_2', '2 Религия и теология'],
      ['b_cat_3', '3 Обществени науки'], ['b_cat_5', '5 Математика и естествени науки'], ['b_cat_61', '61 Медицина'],
      ['b_cat_62', '62/64/69 Техника и промишленост'], ['b_cat_63', '63 Селско стопанство'], ['b_cat_7', '7 Изкуство'],
      ['b_cat_793', '793/799 Спортни игри'], ['b_cat_80', '80 Езикознание и филология'], ['b_cat_82', '82/89 Литературознание'],
      ['b_cat_9', '9 История'], ['b_cat_91', '91 География'], ['b_cat_fiction', 'Художествена литература'],
      ['b_cat_child_nf', 'Д.09 Детска отраслова л-ра'], ['b_cat_child_f', 'Д. Детска художествена л-ра']], row)}
    ${dnevnikGroup('Ползвани в читални', [['b_cat_reading_used', 'Ползвани в читални (не участва в общия сбор)']], row)}
    ${fld('Забележка', 'note', { val: row.note || '', type: 'textarea', rows: 2 })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveDnevnikDay('${date}')">Запиши деня</button>`);
  dnevnikPreview();
}
window.dnevnikDayForm = dnevnikDayForm;
/* Предложенията от потока събития попълват САМО празни/нулеви полета — ръчно
   въведеното от библиотекаря никога не се презаписва, защото официалният
   формуляр е меродавен, а програмата вижда само каквото е минало през нея. */
async function dnevnikSuggest(date) {
  const res = await call(window.api.dnevnik.suggest({ date }));
  if (!res) return;
  const f = $('#dnvF'); if (!f) return;
  const sug = res.suggestions || {};
  const keys = Object.keys(sug);
  if (!keys.length) {
    $('#dnvSugHint').textContent = 'Няма записани събития за този ден — нищо за предлагане.';
    return;
  }
  let filled = 0, kept = 0;
  for (const k of keys) {
    const el = f.querySelector(`[name=${k}]`);
    if (!el) continue;
    if (parseInt(el.value, 10) > 0) { kept++; continue; }
    el.value = sug[k]; filled++;
  }
  dnevnikPreview();
  /* Заемане на книга без попълнен УДК не може да бъде подредено по съдържание.
     Казва се изрично, защото иначе редът „Всичко“ по съдържание излиза по-малък
     от този по вид и по език, без нищо на екрана да обяснява защо. */
  $('#dnvSugHint').textContent = `Предложени ${filled} стойности от ${res.eventsCount} събития` +
    (kept ? ` (${kept} ръчно въведени са запазени)` : '') +
    (res.unclassified ? ` · ${res.unclassified} заемания са на книги без УДК и не влизат в „по съдържание“ — допълнете ги ръчно` : '') +
    ' — прегледайте и поправете преди запис.';
  toast('⚡ Попълнени ' + filled + ' полета — прегледайте преди „Запиши деня“.', 'ok');
}
window.dnevnikSuggest = dnevnikSuggest;
function dnevnikPreview() {
  const f = $('#dnvF'); if (!f) return;
  const num = (n) => { const el = f.querySelector(`[name=${n}]`); return el ? (parseInt(el.value, 10) || 0) : 0; };
  const totalAge = num('a_age_u14') + num('a_age_15_18') + num('a_age_19_28') + num('a_age_o28');
  const totalSex = num('a_sex_boys') + num('a_sex_men') + num('a_sex_girls') + num('a_sex_women');
  const totalEdu = num('a_age_u14') + num('a_age_15_18') + num('a_edu_basic') + num('a_edu_sec') + num('a_edu_high');
  const totalType = ['b_type_books', 'b_type_period', 'b_type_graphic', 'b_type_carto', 'b_type_music',
    'b_type_audio', 'b_type_video', 'b_type_electronic', 'b_type_dvd', 'b_type_talking'].reduce((s, k) => s + num(k), 0);
  $('#dnvPreview').innerHTML = `
    <div class="card"><div class="num">${totalAge}</div><div class="lbl">Читатели общо</div></div>
    <div class="card"><div class="num">${totalSex}</div><div class="lbl">По пол — общо</div></div>
    <div class="card"><div class="num">${totalEdu}</div><div class="lbl">По образование — общо</div></div>
    <div class="card"><div class="num">${totalType}</div><div class="lbl">Заети материали — общо</div></div>`;
}
window.dnevnikPreview = dnevnikPreview;
async function saveDnevnikDay(date) {
  const d = formData('#dnvF');
  d.date = date;
  d.a_hours = parseHhmm(d.a_hours_hhmm); delete d.a_hours_hhmm;
  d.b_hours = parseHhmm(d.b_hours_hhmm); delete d.b_hours_hhmm;
  const ok = await call(window.api.dnevnik.saveDay(d), 'Денят е записан.');
  if (ok !== null) { closeModal(); renderDnevnik(); }
}
window.saveDnevnikDay = saveDnevnikDay;
function printDnevnikDoc() {
  const r = window._DNEVNIK; if (!r) return;
  const cols = DNEVNIK_TAB === 'b' ? DNEVNIK_B_COLS : DNEVNIK_A_COLS;
  const sectionTitle = DNEVNIK_TAB === 'b'
    ? 'Б. РЕГИСТРИРАНЕ НА ЗАЕТИТЕ КНИГИ, ПЕРИОДИЧНИ ИЗДАНИЯ И ДРУГИ МАТЕРИАЛИ'
    : 'А. РЕГИСТРИРАНЕ НА ЧИТАТЕЛИТЕ И ПОСЕЩЕНИЯТА';
  const rowHtml = (label, row) => `<tr><td>${esc(label)}</td>${cols.map(([k]) => `<td>${dnevnikCell(row, k)}</td>`).join('')}</tr>`;
  setPrintPage({ name: `Дневник ${String(DNEVNIK_MONTH).padStart(2, '0')}.${DNEVNIK_YEAR}`, landscape: true, margin: '8mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 style="font-size:14pt">ДНЕВНИК НА БИБЛИОТЕКАТА</h2>
    <div class="pmeta"><b>${esc(sectionTitle)}</b><br>${esc(MESETSI[r.month - 1])} ${r.year} г.</div>
    <table style="font-size:7.5pt"><thead><tr><th>Число</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>
    ${r.days.map(row => rowHtml(row.day, row)).join('')}
    ${rowHtml('Всичко за месеца', r.monthTotal)}
    ${rowHtml('Всичко от нач. на годината', r.ytdTotal)}
    </tbody></table>
    ${ssig(['Библиотекар: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printDnevnikDoc = printDnevnikDoc;
async function exportDnevnikCsv() {
  const res = await window.api.dnevnik.exportCsv({ year: DNEVNIK_YEAR, month: DNEVNIK_MONTH });
  if (!res.ok) return toast(res.error, 'err');
  toast('Експортирано в ' + res.data, 'ok');
}
window.exportDnevnikCsv = exportDnevnikCsv;
