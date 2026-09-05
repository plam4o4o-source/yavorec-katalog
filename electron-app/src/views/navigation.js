// Навигация: NAV/NAV_ICONS/TITLES/VIEW/go/drawNav. ЗАБЕЛЕЖКА: RENDERERS,
// route() и window.addEventListener('hashchange', route) НЕ са тук — вижте
// bootstrap.js (зарежда се последен) и коментара там за причината.

/* ---------------- Навигация ---------------- */
let ROUTE_SUB = ''; // подразделът след „/“ в адреса — виж route() в bootstrap.js
const NAV = [
  { g: 'Общ преглед', items: [['dash', 'Табло']] },
  { g: 'Фонд', items: [['books', 'Книги'], ['invbook', 'Инвентарна книга'],
    ['kdbf', 'КДБФ'], ['acq', 'Постъпления'], ['acts', 'Отчисляване'], ['invent', 'Инвентаризация'],
    ['auth', 'Авторитетни данни']] },
  { g: 'Читатели', items: [['readers', 'Читатели'], ['circ', 'Заемане и връщане'], ['over', 'Просрочени'], ['sugg', 'Предложения за покупка']] },
  { g: 'Други регистри', items: [['periodika', 'Периодика'], ['mzs', 'МЗС'], ['dnevnik', 'Дневник']] },
  { g: 'Краезнание', items: [['analytics', 'Аналитично описание'], ['persons', 'Персоналии'], ['chronicle', 'Летопис']] },
  { g: 'Отчети', items: [['stats', 'Справки и статистика'], ['reports', 'Готови справки'], ['catalog', 'Онлайн каталог'], ['labels', 'Баркод етикети'], ['odit', 'Одитна следа']] },
  { g: 'Настройки', items: [['setup', 'Настройки']] }
];
/* SVG икони (v1.69.0) вместо емоджи: боядисват се от цвета на реда
   (stroke:currentColor), затова следват темата и изглеждат еднакво на всяка
   версия на Windows — емоджитата се рисуват различно от системния шрифт и не
   се оцветяват. Опростени контурни рисунки в стила на Lucide/Feather. */
const navIco = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const NAV_ICONS = {
  dash: navIco('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  books: navIco('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  invbook: navIco('<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>'),
  kdbf: navIco('<rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/><path d="M4 2.5v19"/>'),
  acq: navIco('<path d="M12 3v9"/><path d="m8 8.5 4 4 4-4"/><path d="M3 15h4l1.5 3h7L17 15h4"/><path d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>'),
  acts: navIco('<path d="M12 12V3"/><path d="m8 6.5 4-4 4 4"/><path d="M3 15h4l1.5 3h7L17 15h4"/><path d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>'),
  invent: navIco('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12.5 3 3 5.5-6.5"/>'),
  auth: navIco('<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>'),
  readers: navIco('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 14.5a6.5 6.5 0 0 1 4 5.5"/>'),
  circ: navIco('<path d="M21 12a9 9 0 0 1-15.6 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.6-6.2L21 8"/><path d="M3 21v-5h5"/><path d="M21 3v5h-5"/>'),
  over: navIco('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 3"/>'),
  sugg: navIco('<path d="M9 18h6"/><path d="M10 21.5h4"/><path d="M12 2.5a6 6 0 0 1 3.7 10.7c-.7.6-.7 1.3-.7 2.3h-6c0-1 0-1.7-.7-2.3A6 6 0 0 1 12 2.5z"/>'),
  periodika: navIco('<path d="M4 4h13v16H6a2 2 0 0 1-2-2z"/><path d="M17 8h3v10a2 2 0 0 1-2 2"/><path d="M7 8h7M7 12h7M7 16h4"/>'),
  mzs: navIco('<path d="m16 3 5 5-5 5"/><path d="M21 8H9"/><path d="m8 11-5 5 5 5"/><path d="M3 16h12"/>'),
  dnevnik: navIco('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10.5h18"/>'),
  analytics: navIco('<path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v5h5"/><path d="M9 13h6M9 17h6"/>'),
  persons: navIco('<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>'),
  chronicle: navIco('<path d="M6 2.5h12M6 21.5h12"/><path d="M8 2.5v4.5l4 5 4-5V2.5"/><path d="M8 21.5V17l4-5 4 5v4.5"/>'),
  stats: navIco('<path d="M3 21h18"/><path d="M6.5 21v-7"/><path d="M11.5 21V8"/><path d="M16.5 21v-4"/><path d="M21 21V4"/>'),
  reports: navIco('<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 2h6v4H9z"/><path d="M9 12h6M9 16h4"/>'),
  catalog: navIco('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3.6 3 14.4 0 18c-3-3.6-3-14.4 0-18z"/>'),
  labels: navIco('<path d="M12.6 2.9 21 11.3a2 2 0 0 1 0 2.8l-6.9 6.9a2 2 0 0 1-2.8 0L2.9 12.6a2 2 0 0 1-.6-1.4V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.1.9z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  odit: navIco('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8.5 11h5"/>'),
  setup: navIco('<path d="M4 21v-6M4 11V3M12 21v-9M12 8V3M20 21v-4M20 13V3"/><path d="M2 15h4M10 8h4M18 17h4"/>')
};
/* Икони за показателите (.kpi) в останалите раздели — същият щрихов стил като
   менюто и таблото (v2.4.29: дотук там стояха емоджита 📗✅📕🔍📚👥🔄🚪, които
   Windows рисува цветно и различно от всичко останало на екрана). */
const KPI_ICONS = {
  fund: NAV_ICONS.books, readers: NAV_ICONS.readers, loans: NAV_ICONS.circ, mzs: NAV_ICONS.mzs,
  article: NAV_ICONS.analytics, search: NAV_ICONS.odit, deacc: NAV_ICONS.acts,
  check: navIco('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5.5-6.5"/>'),
  skip: navIco('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  visits: navIco('<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M2 21h20"/><path d="M12 12h.01"/><path d="M16 8h4v13"/>'),
  local: navIco('<path d="m3 11 9-8 9 8"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'),
  newReader: navIco('<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/>'),
  money: navIco('<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5a2.5 2.5 0 0 0-2.5-1.5c-1.5 0-2.5.8-2.5 2 0 2.7 5 1.3 5 4 0 1.2-1 2-2.5 2a2.6 2.6 0 0 1-2.6-1.6"/><path d="M12 6.5V8M12 16v1.5"/>')
};
const TITLES = {
  dash: ['Табло', 'обобщение на състоянието'],
  books: ['Библиотечен фонд', 'каталогизация и издирване'],
  invbook: ['Инвентарна книга', 'Приложение № 4 към чл. 16, ал. 1'],
  kdbf: ['Книга за движение на библиотечния фонд', 'Приложения № 1, 2 и 3 към чл. 13, ал. 3'],
  acq: ['Постъпления', 'раздел II и чл. 14 от Наредба № 3'],
  acts: ['Отчисляване', 'раздел IV, чл. 30 – 39'],
  invent: ['Инвентаризация', 'раздел V, чл. 40 – 41'],
  auth: ['Авторитетни данни', 'единен вид на авторите, издателствата и останалите повтарящи се стойности'],
  readers: ['Читатели', 'регистър на ползвателите'],
  circ: ['Заемане и връщане', 'чл. 42 – 49'],
  over: ['Просрочени заемания', 'контрол по чл. 43 и 49'],
  sugg: ['Предложения за покупка', 'читателите предлагат заглавия — от заявка до партида'],
  periodika: ['Периодика', 'картотека на постъпилите броеве'],
  mzs: ['Междубиблиотечно заемане', 'заявки от и към други библиотеки'],
  dnevnik: ['Дневник на библиотеката', 'месечен статистически дневник — Раздел А и Раздел Б'],
  analytics: ['Аналитично описание', 'статии в периодични издания и части от книги'],
  persons: ['Персоналии', 'видни местни жители и дейци'],
  chronicle: ['Летопис', 'хронология на читалищната дейност'],
  stats: ['Справки и статистика', 'годишен отчет и показатели'],
  reports: ['Готови справки', 'предварително подготвени отчети за регионалната библиотека и Министерството на културата'],
  catalog: ['Онлайн каталог', 'публикуване в интернет'],
  labels: ['Баркод етикети', 'печат на етикети Code 39'],
  odit: ['Одитна следа', 'кой служител какво е извършил'],
  setup: ['Настройки', 'данни за библиотеката и обслужването']
};
let VIEW = 'dash';

function go(v) { location.hash = v; }
window.go = go;

function drawNav() {
  $('#nav').innerHTML = NAV.map(g =>
    `<div class="nav-grp">${esc(g.g)}</div>` +
    g.items.map(([k, t]) =>
      `<a href="#${k}" class="${VIEW === k ? 'on' : ''}"><span class="ic">${NAV_ICONS[k] || '•'}</span><span class="tx">${esc(t)}</span></a>`
    ).join('')
  ).join('');
}
