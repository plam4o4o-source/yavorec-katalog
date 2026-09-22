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
/* ---- Групиращ ред над заглавията на колоните ---------------------------------
   Раздел А има ЧЕТИРИ колони, озаглавени само „Всичко“ (по възраст, по пол, по
   образование, по занятие), а Раздел Б — три. На хартия те стоят една до друга
   без нищо, което да каже кое към коя разбивка се отнася: четири еднакви числа,
   които понякога съвпадат, а понякога не, и проверяващият няма как да разбере кое
   какво е. Отделно „В читални“ в Раздел Б стои до категориите по съдържание, но
   НЕ участва в тяхното „Всичко“ (това е бележка колко от заетите са ползвани в
   читалня) — дотук нищо не го казваше и числото изглеждаше като пропуснат сбор.
   Спановете се проверяват срещу дължината на реда с колони при всяко изчертаване:
   при разминаване групиращият ред просто не се строи, вместо да се разминат
   заглавията с данните. Заковано е и с тест. */
/* Етикетите казват и КАКВО влиза в съответното „Всичко“, защото две от четирите
   суми в Раздел А не са сборът на видимите до тях колони (виж dnevnikTotals в
   handlers/dnevnik.js): „по образование“ добавя и двете най-млади възрастови
   групи, а „по занятие“ включва и четирите колони на учащите се. Без това
   пояснение отпечатаният ред е аритметично необясним за проверяващия. */
const DNEVNIK_A_GROUPS = [
  ['Работно време', 1], ['По възраст', 5], ['По пол и възраст', 5],
  ['По образование (сборът включва и децата до 18 г.)', 4],
  ['По занятие (сборът включва и учащите се)', 15], ['Посещения', 4]
];
const DNEVNIK_B_GROUPS = [
  ['Работно време', 1], ['По вид документи', 11], ['По език', 8], ['По съдържание (УДК)', 18],
  ['от които ползвани в читалня (не влиза в горните сборове)', 1]
];
function dnevnikGroups(cols) {
  return cols === DNEVNIK_B_COLS ? DNEVNIK_B_GROUPS : DNEVNIK_A_GROUPS;
}
function dnevnikGroupHeadHtml(cols, firstLabel, groups, short) {
  const g = groups || dnevnikGroups(cols);
  if (g.reduce((s, [, n]) => s + n, 0) !== cols.length) return '';
  return `<tr><th>${esc(firstLabel || '')}</th>${
    g.map(([l, n]) => `<th colspan="${n}" style="text-align:center">${esc(short ? dnevnikShortLabel(l) : l)}</th>`).join('')}</tr>`;
}
/* На хартия колоните са заковани за листа (table-layout:fixed), затова пояснението
   в скоби не може да „разтегли“ клетката си: групата „от които ползвани в читалня“
   е ЕДНА колона, а пояснението ѝ — цял ред текст, и заглавието ставаше десет реда
   високо. В печата над таблицата остава само името на групата, а пояснението слиза
   под таблицата като бележка — на същия лист, до същата таблица. */
function dnevnikShortLabel(l) { return l.split(' (')[0]; }
function dnevnikShortLabel0([l]) { return dnevnikShortLabel(l); }
function dnevnikGroupNotes(groups) {
  return (groups || []).filter(([l]) => l.indexOf(' (') > 0)
    .map(([l]) => dnevnikShortLabel(l) + ' — ' + l.slice(l.indexOf(' (') + 2).replace(/\)$/, ''));
}
function dnevnikNotesHtml(groups, extra) {
  const n = dnevnikGroupNotes(groups).concat((extra || []).filter(Boolean));
  return n.length ? `<div class="pnote">${n.map(t => '* ' + esc(t)).join('<br>')}</div>` : '';
}
/* ОБЯСНЕНИЕТО ЗА ТРИТЕ РАЗЛИЧНИ „ВСИЧКО“ СЛИЗА НА ХАРТИЯТА (одит v2.4.65, В4).
   =====================================================================
   Отпечатаният Раздел Б показва три реда „Всичко“ — по вид, по език и по
   съдържание — и те законно се разминават: периодичното издание се брои по ВИД,
   но не по съдържание (съдържанието му е различно във всеки брой), а документ
   без попълнен УДК не влиза в разбивката по съдържание. ДОТУК обяснението
   съществуваше само в подсказката на прозореца „Подробно за деня“ (#dnvSugHint)
   и изчезваше заедно с прозореца: проверяващият виждаше три различни числа под
   един надпис „Всичко“ на ПОДПИСАН лист, без нито дума защо. Бележката се
   изписва само когато разминаването наистина е на листа, за да не се пълни
   формулярът с текст, който не се отнася за него. Същото вече се прави за
   колоната „В читални“ (dnevnikNotesHtml) — това е образецът. */
function dnevnikTotalsNoteB(row) {
  if (!row) return '';
  const g = (k) => Number(row[k]) || 0;
  const byType = g('b_total_type'), byLang = g('b_total_lang'), byContent = g('b_total_content');
  if (byType === byContent && byType === byLang) return '';
  const parts = [];
  if (byContent < byType) {
    parts.push('периодичните издания се броят по вид, не по съдържание (така е и във формуляра), '
      + 'а документ без попълнен УДК не влиза в разбивката по съдържание');
  }
  if (byLang !== byType) parts.push('разбивката по език брои всеки документ веднъж, независимо от вида му');
  return 'Трите реда „Всичко“ на Раздел Б — по вид ' + byType + ', по език ' + byLang
    + ', по съдържание ' + byContent + ' — се разминават по формуляр: ' + parts.join('; ') + '.';
}
/* Честният надпис за покритието на месеца (одит v2.4.65, находка В2) — един и
   същ текст на екрана и на хартията, по образеца на reportCoverageNote() в
   src/views/reports.js, добавен там, защото „разпечатката излизаше с нули, с
   бланка и с два реда за подпис, без нито дума защо“. Дневникът за месец без
   нито един вписан ден излизаше по същия начин. */
function dnevnikCoverageNote(r) {
  if (!r) return '';
  const d = r.daysFilled == null ? null : r.daysFilled;
  if (d === null) return '';
  const mesec = (MESETSI[r.month - 1] || '') + ' ' + r.year + ' г.';
  if (!d) {
    return 'Внимание: за ' + mesec + ' няма нито един вписан ден в Дневника. Всички числа по-долу са нули, '
      + 'защото няма от какво да бъдат сметнати — листът не отразява действителната работа на библиотеката.';
  }
  return 'Вписани са ' + d + (d === 1 ? ' ден' : ' дни') + ' от ' + r.daysInMonth + ' за ' + mesec
    + '; дните без вписване остават нули и не участват в сборовете.'
    + (r.daysFilledClosed ? ' От тях ' + r.daysFilledClosed
      + (r.daysFilledClosed === 1 ? ' е в ден' : ' са в дни') + ', отбелязан(и) като затворен(и) в календара.' : '')
    /* Редът „Всичко от нач. на годината“ също е толкова пълен, колкото е воден
       дневникът — казва се със същото изречение, вместо сборът да изглежда
       като число за цялата изминала година. */
    + (r.ytdDaysFilled != null ? ' Редът „Всичко от нач. на годината“ събира '
      + r.ytdDaysFilled + (r.ytdDaysFilled === 1 ? ' вписан ден' : ' вписани дни') + '.' : '');
}
/* РАЗДЕЛЯНЕ НА ШИРОКАТА ТАБЛИЦА ПО ЛИСТОВЕ (v2.4.54).
   =====================================================================
   Раздел А има 34 колони, Раздел Б — 39. Измерено на истински данни: на А4
   пейзаж с поле 8 mm полезната ширина е 1063 px, а таблицата излиза 2099 px —
   тоест 868 px (45%) от ДНЕВНИКА НА БИБЛИОТЕКАТА се отрязват от принтера и
   НИКЪДЕ не се появяват. Същото и в годишния статистически отчет (Раздел А и Б):
   2073 px при 1047 px полезни, 987 px отрязани. Двата документа излизат от
   сградата непълни — а именно те се показват на проверяващия.

   Свиване до листа не става: 1063/2099 значи мащаб 0,50, тоест шрифт 3,75 pt.
   Затова таблицата се разделя на ЛИСТОВЕ по границите на собствените си групи
   („По възраст“, „По пол“, „По образование“ …) — както се разгъва хартиена
   тетрадка. Колоната с деня се повтаря на всеки лист, за да е четим всеки ред
   сам за себе си. Групите НЕ се режат по средата: така отпечатаното „Всичко“
   винаги стои до разбивката, чийто сбор е.

   MAX е брой колони на лист. 20 + колоната с деня заемат ~13 mm на колона при
   А4 пейзаж — колкото е и сега на екрана. */
const DNEVNIK_PRINT_MAX_COLS = 20;
function dnevnikPrintPages(cols, groups, max) {
  const g = groups || dnevnikGroups(cols);
  const limit = max || DNEVNIK_PRINT_MAX_COLS;
  // Разминаване между групите и колоните: не се гадае — печата се на един лист,
  // както досега (групиращият ред и без това не се строи в този случай).
  if (g.reduce((s, [, n]) => s + n, 0) !== cols.length) return [{ cols, groups: null }];
  const pages = [];
  let cur = { cols: [], groups: [] }, at = 0;
  for (const [label, n] of g) {
    if (cur.cols.length && cur.cols.length + n > limit) { pages.push(cur); cur = { cols: [], groups: [] }; }
    cur.groups.push([label, n]);
    cur.cols.push(...cols.slice(at, at + n));
    at += n;
  }
  if (cur.cols.length) pages.push(cur);
  return pages;
}
/* Всички реални (въвеждани) полета от ДВАТА раздела.
   Коментарът тук дотук твърдеше, че „записът в базата презаписва целия ред,
   затова при запис на клетка от Раздел А трябва да се изпратят и стойностите на
   Раздел Б“ — вярно е било до v2.4.14/v2.4.25 и точно затова беше поправено:
   изпраща се САМО променената колона (виж dnevnikSaveCell по-долу и
   handlers/dnevnik.js), иначе едната машина връщаше на нула вписаното от
   другата. Същата отдавна премахната обяснение стоеше и в наръчника
   (README-bibliotekar.md, находка В12) — поправено в същия кръг. */
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
    /* КЛЕТКАТА Е ТЕКСТОВА, А НЕ <input type="number"> (одит v2.4.65, находка Б17).
       =====================================================================
       Причината е измерена в жив прозорец: при type="number" Chromium връща
       ПРАЗЕН НИЗ за всичко, което не е число по неговите правила — включително
       „2,7“ с десетична запетая, която е точно каквото дава българската
       клавиатура. Тоест най-вероятната грешка на библиотекарката се превръщаше в
       тиха НУЛА, без нито едно известие и без начин програмата да разбере какво е
       било написано. С текстово поле написаното остава, проверката по-долу го
       отказва поименно и клетката се връща на предишната си стойност — а
       обработчикът отказва втори път, вече като граница (handlers/dnevnik.js).
       inputmode="numeric" пази цифровата клавиатура там, където има такава;
       колоната „Часове“ е текстова по същата причина още отпреди. */
    return `<td><input class="dnvCell" type="text" inputmode="numeric" value="${row[k] || 0}"
      data-date="${row.date}" data-field="${k}" onchange="dnevnikSaveCell(this)"></td>`;
  };
  /* ЗАТВОРЕНИЯТ ДЕН СЕ ВИЖДА В ТАБЛИЦАТА (одит v2.4.65, находка В3).
     Дотук редът на ден, в който библиотеката е затворена по календара (неработен
     ден от седмицата или изрично затворена дата — празник, ремонт), изглеждаше
     точно като всеки друг: библиотекарката нямаше как да разбере, че вписва
     работа в затворен ден, а годишният отчет го броеше за работен. Денят се
     надписва и в заглавието на клетката (title), за да се види причината. */
  const dayRowHtml = (row) => `<tr class="${row.date === todayStr ? 'dnvToday' : ''}${row.closed ? ' dnvClosed' : ''}">
    <td class="num dnvDay"${row.closed ? ` title="${esc('Затворен ден' + (row.closedReason ? ' — ' + row.closedReason : ''))}"` : ''}>${row.day}${
      row.closed ? ' <span class="hint" aria-label="затворен ден">·затв.</span>' : ''}</td>${
    cols.map(([k]) => cellHtml(row, k)).join('')}</tr>`;
  const totalRowHtml = (label, row, cls) => `<tr class="dnvTotal ${cls || ''}"><td>${esc(label)}</td>
    ${cols.map(([k]) => `<td class="num">${dnevnikCell(row, k)}</td>`).join('')}</tr>`;
  $('#view').innerHTML = `
    <div class="note">Електронен вариант на месечния статистически дневник на читалищните библиотеки —
    Раздел А (читатели и посещения) и Раздел Б (заети материали). <b>Попълва се направо в таблицата</b> —
    всяка стойност се записва веднага при излизане от полето. Колоните „Всичко“ и двата обобщителни
    реда се изчисляват автоматично и не се въвеждат ръчно.</div>
    <div class="note ${r.daysFilled ? '' : 'd'}" style="margin-top:0">${esc(dnevnikCoverageNote(r))}${
      r.days.some(d => d.closed) ? ' Дните, отбелязани „·затв.“, са затворени по календара на библиотеката.' : ''}</div>
    <div class="toolbar">
      <select onchange="DNEVNIK_YEAR=parseInt(this.value,10);renderDnevnik()">${years.map(x => `<option value="${x}" ${x === y ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <select onchange="DNEVNIK_MONTH=parseInt(this.value,10);renderDnevnik()">${MESETSI.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <div style="display:flex;gap:6px">
        <button class="btn sm ${DNEVNIK_TAB === 'a' ? 'pri' : ''}" onclick="DNEVNIK_TAB='a';renderDnevnik()">Раздел А · Читатели и посещения</button>
        <button class="btn sm ${DNEVNIK_TAB === 'b' ? 'pri' : ''}" onclick="DNEVNIK_TAB='b';renderDnevnik()">Раздел Б · Заети материали</button>
      </div>
      <button class="btn" onclick="dnevnikDayForm('${todayStr}')">Подробно за днес…</button>
      <button class="btn" onclick="printDnevnikDoc()">Печат / PDF</button>
      <button class="btn" onclick="exportDnevnikCsv()">Извеждане в CSV</button>
    </div>
    <div class="wrap"><table class="ledger dnvTable"><thead>
      ${dnevnikGroupHeadHtml(cols)}
      <tr><th>Число</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr>
    </thead><tbody>
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
  const hours = (field === 'a_hours' || field === 'b_hours');
  /* ДРОБНОТО ЧИСЛО НЕ СЕ ОТРЯЗВА МЪЛЧАЛИВО (одит v2.4.65, находка Б17).
     =====================================================================
     ДОТУК тук стоеше `parseInt(el.value, 10) || 0`: „2,7“ отиваше в базата като
     2, а клетката продължаваше да показва 2,7 — съседната колона „Всичко“
     показваше 4 при 4,8 в клетката, а месечният сбор броеше 12 при видими 12,5.
     Нито едно известие. Обработчикът вече отказва (handlers/dnevnik.js), както
     „Посещения“ от v2.4.29; тук се отказва ПО-РАНО, за да не пътува заявка и
     клетката да се върне веднага на старото си число.
     `validity.badInput` е за истинския прозорец: Chromium връща празен низ от
     <input type="number">, когато написаното не е число (напр. „2,7“ с десетична
     запетая), тоест без тази проверка би се записала тиха нула. */
  if (!hours) {
    const raw = String(el.value == null ? '' : el.value).trim();
    const bad = (el.validity && el.validity.badInput) || (raw !== '' && !/^\d+$/.test(raw));
    if (bad) {
      el.value = row ? (row[field] || 0) : 0;
      return toast('Дневникът брои хора и документи — въведете цяло число, 0 или повече'
        + (raw ? ' (въведено е „' + raw + '“).' : '.'), 'err');
    }
  }
  const val = hours ? parseHhmm(el.value) : (parseInt(el.value, 10) || 0);
  /* v2.4.29: отрицателно число не се записва — клетката се връща на старата стойност. */
  if (val < 0) {
    el.value = row ? (row[field] || 0) : 0;
    return toast('Дневникът брои хора и документи — въведете цяло число, 0 или повече.', 'err');
  }
  /* Одит v2.4.25: дотук `if (!row) return;` — тих отказ без IPC, без известие и
     без мигване, а клетката продължаваше да показва числото. Снимката в паметта е
     само оптимизация за „без промяна — не пипай базата“; когато редът го няма в
     нея, се записва, вместо да се изхвърля. (Причината редът да липсва беше
     dnevnikDayForm, който презаписваше снимката с ДРУГ месец — поправено там — но
     записът на официален формуляр не бива да зависи от състоянието на кеш.) */
  if (row && (row[field] || 0) === val) return; // без промяна — не пипай базата
  const before = row ? (row[field] || 0) : 0;
  if (row) row[field] = val;
  /* Изпраща се САМО променената колона. Дотук тук се пращаше целият ред, сглобен
     от снимката в паметта на този компютър — тоест редакцията на една клетка
     презаписваше и всичките останали 65 колони със стойностите, каквито са били
     при зареждането на екрана, и триеше вписаното междувременно от другото
     работно място. */
  const res = await window.api.dnevnik.saveDay({ date, [field]: val });
  if (!res.ok) {
    // Записът не е минал — нито снимката в паметта, нито клетката бива да твърдят обратното.
    if (row) row[field] = before;
    el.value = (field === 'a_hours' || field === 'b_hours') ? hhmm(before) : before;
    return toast(res.error, 'err');
  }
  markSaved();
  el.classList.add('saved');
  setTimeout(() => el.classList.remove('saved'), 700);
  if (hours) el.value = hhmm(val);
  /* Предупрежденията идват от обработчика — той е границата и той знае какво е
     влязло в базата (одит v2.4.65, находка В3): вписана работа в ден, който
     календарът обявява за затворен, дотук минаваше без дума и влизаше в
     годишния отчет като работен ден. Записът не се отказва — библиотеката
     наистина може да е работила, — но вече се казва. */
  (res.data && res.data.warnings || []).forEach(w => toast(w, 'err'));
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
  /* Данните се презареждат от базата, преди прозорецът да се отвори. Снимката в
     window._DNEVNIK може да е отпреди часове, а този прозорец записва целия ден
     наведнъж — човекът трябва да види текущото състояние, включително вписаното
     от другото работно място, преди да го потвърди. */
  const fresh = await call(window.api.dnevnik.getMonth({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) }));
  /* Прочетеното остава МЕСТНО за прозореца (одит v2.4.25). Дотук се записваше в
     общата снимка window._DNEVNIK — а тя е снимката на месеца, който е на екрана.
     На 5 януари таблицата е на декември (затваря се миналият месец), „Подробно за
     днес…“ зареждаше януари върху нея, и всяка следваща декемврийска клетка се
     изхвърляше без дума (виж dnevnikSaveCell), а „Печат“ печаташе януари под
     заглавие „декември“. */
  const days = (fresh && fresh.days) || [];
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
     от този по вид и по език, без нищо на екрана да обяснява защо.

     ПЕРИОДИКАТА НЕ Е „КНИГА БЕЗ УДК“ (v2.4.61). Дотук заетият годишен комплект на
     вестник попадаше в същото изречение: „1 заемане е на книга без УДК — допълнете
     го ръчно“. Библиотекарката тръгваше да търси УДК за вестник, какъвто няма и не
     се пише: Раздел Б брои периодичните издания по ВИД („Периодични издания“), а
     разбивката по съдържание е за отрасловата и художествената литература. Затова
     обработчикът ги брои отделно (periodicalsByType) и тук им се казва истината —
     че липсата им в „по съдържание“ е по формуляр, а не пропуск за поправяне. */
  const периодика = res.periodicalsByType || 0;
  /* ВИДОВЕ БЕЗ СОБСТВЕН РЕД ВЪВ ФОРМУЛЯРА (одит v2.4.65, находка Б15) — казват
     се поименно. DVD и говорещите книги вече си имат колони и отиват в тях;
     патент/стандарт, „друго“ и всеки вид, измислен от библиотекарката, се
     предлагат в „Книги“, защото „Всичко по вид“ трябва да е равно на броя
     заемания — но тихото падане в „Книги“ беше точно причината числото да
     изглежда вярно и никой да не го провери. */
  const fb = res.typeFallback || [];
  const fbN = fb.reduce((s, [, n]) => s + n, 0);
  const missing = res.typeMissing || 0;
  /* ЧЕТИРИТЕ „ВСИЧКО“ НА РАЗДЕЛ А (одит v2.4.65, находка А от доклада).
     Предложението попълва само възрастта и посещенията на децата — програмата
     няма откъде да вземе пол, образование и занятие (картонът на читателя не ги
     пази). Дотук формулярът просто излизаше 2 / 0 / 1 / 0 и си противоречеше,
     без нищо на екрана да каже, че липсващото е работа за човека. */
  const A = res.sectionA || null;
  const aNote = (A && Math.max(A.age, A.sex, A.edu, A.prof) > 0
    && new Set([A.age, A.sex, A.edu, A.prof]).size > 1)
    ? ` · Раздел А — по възраст ${A.age}, по пол ${A.sex}, по образование ${A.edu}, по занятие ${A.prof}:`
      + ' четирите „Всичко“ трябва да съвпадат, а пол, образование и занятие не се пазят в картона на читателя — допълнете ги'
    : '';
  $('#dnvSugHint').textContent = `${filled === 1 ? 'Предложена 1 стойност' : 'Предложени ' + filled + ' стойности'} от ${pl(res.eventsCount, 'събитие', 'събития')}` +
    (kept ? ` (${kept === 1 ? '1 ръчно въведена е запазена' : kept + ' ръчно въведени са запазени'})` : '') +
    (res.unclassified ? ` · ${res.unclassified === 1 ? '1 заемане е на книга' : res.unclassified + ' заемания са на книги'} без УДК и не ${res.unclassified === 1 ? 'влиза' : 'влизат'} в „по съдържание“ — допълнете ${res.unclassified === 1 ? 'го' : 'ги'} ръчно` : '') +
    (периодика ? ` · ${периодика === 1 ? '1 заемане е на периодично издание и се брои' : периодика + ' заемания са на периодични издания и се броят'} по вид, не по съдържание (така е и във формуляра)` : '') +
    (fbN ? ` · ${fbN === 1 ? '1 заемане е на вид' : fbN + ' заемания са на видове'} без собствен ред във формуляра (`
      + fb.map(([n, c]) => n + (c > 1 ? ' × ' + c : '')).join(', ')
      + `) и ${fbN === 1 ? 'е предложено' : 'са предложени'} в „Книги“ — преместете ${fbN === 1 ? 'го' : 'ги'}, ако водите друга колона` : '') +
    /* Документ, записан изобщо без вид, е ДРУГ случай и изходът му е друг:
       попълва се картонът на документа, а не се мести колона (находка Б15). */
    (missing ? ` · ${missing === 1 ? '1 заемане е на документ' : missing + ' заемания са на документи'} без посочен вид`
      + ` и ${missing === 1 ? 'е предложено' : 'са предложени'} в „Книги“ — посочете вида в картона на документа („Книги → Вид документ“)` : '') +
    aNote +
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
  /* Предупрежденията на обработчика се изписват СЛЕД потвърждението за записа
     (одит v2.4.65, находки В3 и А): затворен ден по календара и четирите „Всичко“
     на Раздел А, които не съвпадат. Денят е записан — това не са откази, а
     неща, които библиотекарката трябва да види, преди да подпише формуляра. */
  if (ok && ok.warnings) ok.warnings.forEach(w => toast(w, 'err'));
  // Пречертава се ТЕКУЩИЯТ екран (преглед на кръга v2.4.27): формата се отваря
  // и от таблото — иначе месечната таблица заместваше таблото под заглавие „Табло“.
  if (ok !== null) { closeModal(); if (VIEW === 'dnevnik') renderDnevnik(); else if (RENDERERS[VIEW]) RENDERERS[VIEW](); }
}
window.saveDnevnikDay = saveDnevnikDay;
function printDnevnikDoc() {
  const r = window._DNEVNIK; if (!r) return;
  const cols = DNEVNIK_TAB === 'b' ? DNEVNIK_B_COLS : DNEVNIK_A_COLS;
  const sectionTitle = DNEVNIK_TAB === 'b'
    ? 'Б. РЕГИСТРИРАНЕ НА ЗАЕТИТЕ КНИГИ, ПЕРИОДИЧНИ ИЗДАНИЯ И ДРУГИ МАТЕРИАЛИ'
    : 'А. РЕГИСТРИРАНЕ НА ЧИТАТЕЛИТЕ И ПОСЕЩЕНИЯТА';
  /* Листовете носят ЕДИН И СЪЩ месец, само колоните са различни — затова
     заглавието се повтаря с „лист N от M“, за да не се разбъркат на бюрото. */
  const pages = dnevnikPrintPages(cols);
  const rowHtml = (pc, label, row) => `<tr><td>${esc(label)}</td>${
    pc.map(([k]) => `<td>${dnevnikCell(row, k)}</td>`).join('')}</tr>`;
  const tableHtml = (page, i) => `
    ${i ? '<div class="pbreak"></div>' : ''}
    <div class="pmeta"><b>${esc(sectionTitle)}</b><br>${esc(MESETSI[r.month - 1])} ${r.year} г.${
      pages.length > 1 ? ` · лист ${i + 1} от ${pages.length} — ${esc(page.groups.map(dnevnikShortLabel0).join(', '))}` : ''}</div>
    <table class="dnvPrint"><colgroup><col style="width:11%">${
      page.cols.map(() => `<col style="width:${(89 / page.cols.length).toFixed(3)}%">`).join('')}</colgroup><thead>
    ${dnevnikGroupHeadHtml(page.cols, '', page.groups, true)}
    <tr><th>Число</th>${page.cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>
    ${r.days.map(row => rowHtml(page.cols, row.day, row)).join('')}
    ${rowHtml(page.cols, 'Всичко за месеца', r.monthTotal)}
    ${rowHtml(page.cols, 'Всичко от нач. на годината', r.ytdTotal)}
    </tbody></table>${dnevnikNotesHtml(page.groups, [
      /* Обяснението за трите „Всичко“ слиза на листа, на който те стоят (В4). */
      DNEVNIK_TAB === 'b' && page.groups && page.groups.some(([l]) => l.indexOf('съдържание') >= 0)
        ? dnevnikTotalsNoteB(r.monthTotal) : '',
      /* Затворените дни по календара — изписват се на листа, а не само на екрана (В3). */
      !i && r.days.some(d => d.closed)
        ? 'Дни, отбелязани като затворени в календара на библиотеката: '
          + r.days.filter(d => d.closed).map(d => d.day).join(', ') + '.'
        : ''
    ])}`;
  setPrintPage({ name: `Дневник ${String(DNEVNIK_MONTH).padStart(2, '0')}.${DNEVNIK_YEAR}`, landscape: true, margin: '8mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 style="font-size:14pt">ДНЕВНИК НА БИБЛИОТЕКАТА</h2>
    ${/* ПРАЗНИЯТ МЕСЕЦ СИ ГО КАЗВА (одит v2.4.65, находка В2). Дотук печатът на
         месец без нито един вписан ден излизаше като готов за подпис официален
         формуляр от нули, с бланка и два реда за подпис, без нито дума защо —
         точно каквото годишният отчет вече не прави (reportCoverageNote в
         src/views/reports.js). Един и същ текст стои и на екрана. */''}
    <div class="pmeta">${esc(dnevnikCoverageNote(r))}</div>
    ${pages.map(tableHtml).join('')}
    ${ssig(['Библиотекар: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printDnevnikDoc = printDnevnikDoc;
async function exportDnevnikCsv() {
  const path = await call(window.api.dnevnik.exportCsv({ year: DNEVNIK_YEAR, month: DNEVNIK_MONTH }));
  if (path) toast('Изведено в ' + path, 'ok');
}
window.exportDnevnikCsv = exportDnevnikCsv;
