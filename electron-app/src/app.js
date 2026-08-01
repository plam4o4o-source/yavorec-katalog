'use strict';

/* ---------------- Помощни функции ---------------- */
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => new Date().toISOString().slice(0, 10);
const yr = (d) => (d || today()).slice(0, 4);
const bg = (d) => d ? d.split('-').reverse().join('.') : '';
/* Фиксиран, необратим курс лев–евро по Регламент (ЕС) 2025/1409 на Съвета — БНБ,
   в сила от 01.01.2026 г. Не е борсов курс и не се обновява. */
const EUR_RATE = 1.95583;
const bgn = (n) => (Number(n) || 0).toFixed(2);
const eur = (n) => ((Number(n) || 0) / EUR_RATE).toFixed(2);
const mny = (n) => bgn(n) + ' лв. / ' + eur(n) + ' €';
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.remove(), 300); }, type === 'err' ? 5000 : 2800);
}

function modal(title, body, footer) {
  $('#modal').innerHTML =
    `<header><h2>${esc(title)}</h2><button class="x" onclick="closeModal()">&times;</button></header>
     <div class="body">${body}</div>
     ${footer ? `<footer>${footer}</footer>` : ''}`;
  $('#veil').classList.add('on');
  setTimeout(() => { const i = $('#modal input,#modal select,#modal textarea'); if (i) i.focus(); }, 40);
}
function closeModal() { $('#veil').classList.remove('on'); $('#modal').innerHTML = ''; }
window.closeModal = closeModal;

/* Втори слой — за помощни прозорци върху вече отворена форма (изборът на УДК).
   Първият слой остава непокътнат, за да не се губи попълненото. */
function modal2(title, body, footer) {
  $('#modal2').innerHTML =
    `<header><h2>${esc(title)}</h2><button class="x" onclick="closeModal2()">&times;</button></header>
     <div class="body">${body}</div>
     ${footer ? `<footer>${footer}</footer>` : ''}`;
  $('#veil2').classList.add('on');
}
function closeModal2() { $('#veil2').classList.remove('on'); $('#modal2').innerHTML = ''; }
window.closeModal2 = closeModal2;

// Esc затваря най-горния отворен прозорец.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('#veil2').classList.contains('on')) closeModal2();
  else if ($('#veil').classList.contains('on')) closeModal();
});

function formData(sel) {
  const out = {};
  $(sel).querySelectorAll('input,select,textarea').forEach(el => {
    if (!el.name) return;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return out;
}

async function call(promise, okMsg) {
  const res = await promise;
  if (!res.ok) { toast(res.error || 'Възникна грешка.', 'err'); return null; }
  if (okMsg) { toast(okMsg, 'ok'); markSaved(); }
  return res.data;
}

/* ---------------- Индикатор за последен автоматичен запис ----------------
   Всяко действие (нов документ, заемане, връщане, отчисляване и т.н.) се
   записва веднага в базата данни — няма отделно "незапазено" състояние и
   няма нужда от бутон „Запази“ за самите данни (той остава само там, където
   формата съдържа много полета и логично трябва изрично потвърждение). */
let LAST_SAVED = null;
function markSaved() {
  LAST_SAVED = new Date();
  const el = $('#savedIndicator');
  if (el) el.innerHTML = '<span class="dot"></span> Запазено в ' +
    LAST_SAVED.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}
function initSavedIndicator() {
  const el = $('#savedIndicator');
  if (el && !LAST_SAVED) el.innerHTML = '<span class="dot"></span> Автоматичен запис — включен';
}

/* Бърз конструктор на форма-поле, за да не се повтаря разметката за всяко поле. */
function fld(label, name, opts) {
  opts = opts || {};
  const val = opts.val ?? '';
  if (opts.type === 'select') {
    const options = (opts.opts || []).map(o => {
      const v = typeof o === 'object' ? o.v : o, t = typeof o === 'object' ? o.t : o;
      return `<option value="${esc(v)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(t)}</option>`;
    }).join('');
    return `<div class="field"><label>${esc(label)}</label><select name="${name}" ${opts.req ? 'required' : ''}>
      ${opts.allowEmpty !== false ? `<option value="">${esc(opts.emptyLabel || '—')}</option>` : ''}${options}</select></div>`;
  }
  if (opts.type === 'textarea') {
    return `<div class="field"><label>${esc(label)}</label><textarea name="${name}" rows="${opts.rows || 3}">${esc(val)}</textarea></div>`;
  }
  if (opts.type === 'checkbox') {
    return `<label class="chk"><input type="checkbox" name="${name}" ${val ? 'checked' : ''}><span>${label}</span></label>`;
  }
  const type = opts.type || 'text';
  // opts.list свързва полето със списък за автодовършване (<datalist>) от вече
  // въведените стойности — контрол на авторитетните данни при въвеждане.
  return `<div class="field"><label>${esc(label)}${opts.hint ? ' <span class="fh">' + opts.hint + '</span>' : ''}</label>
    <input name="${name}" type="${type}" ${opts.step ? 'step="' + opts.step + '"' : ''} ${opts.req ? 'required' : ''}
      ${opts.list ? `list="dl_${opts.list}"` : ''} value="${esc(val)}"></div>`;
}

/* ---------------- Контрол на авторитетните данни ----------------
   Стойностите, вече въведени във фонда, се предлагат при писане. Така „Вазов, Иван“
   се избира от списъка, вместо да се напише „Иван Вазов“ и записът да се раздвои. */
let AUTH_SUGGEST = null;
async function loadAuthSuggest(force) {
  if (AUTH_SUGGEST && !force) return AUTH_SUGGEST;
  AUTH_SUGGEST = await call(window.api.authorities.suggest()) || {};
  return AUTH_SUGGEST;
}
function datalistsHtml(sug) {
  const udkAll = [];
  for (const [, , subs] of (typeof UDK_TREE !== 'undefined' ? UDK_TREE : [])) {
    for (const [code, label] of subs) udkAll.push({ v: code, t: `${code} — ${label}` });
  }
  const seen = new Set(udkAll.map(x => x.v));
  for (const v of (sug.udk || [])) if (!seen.has(v)) udkAll.push({ v, t: v });
  const one = (name, values) =>
    `<datalist id="dl_${name}">` +
    values.map(x => typeof x === 'object'
      ? `<option value="${esc(x.v)}">${esc(x.t)}</option>`
      : `<option value="${esc(x)}"></option>`).join('') +
    `</datalist>`;
  return one('author', sug.author || []) + one('publisher', sug.publisher || []) +
         one('city', sug.city || []) + one('keywords', sug.keywords || []) +
         one('udk', udkAll);
}

/* ---------------- Справочници ---------------- */
const EZICI = ['български', 'руски', 'английски', 'немски', 'френски', 'друг'];
const OTDELI = ['за възрастни', 'за деца', 'краеведски', 'справочен', 'периодика', 'служебен'];
const KATEG = ['дете до 14 г.', 'ученик', 'студент', 'възрастен', 'пенсионер', 'специалист'];
const NACHINI = ['закупуване', 'депозит', 'обмен', 'дарение'];
const PARV_DOK = ['фактура', 'депозитен списък', 'акт (разписка)', 'приемо-предавателен протокол', 'без документ — протокол на комисия'];
const PRICHINI = [
  { k: 1, t: 'Остарели по съдържание' }, { k: 2, t: 'Налични много екземпляри от един документ' },
  { k: 3, t: 'Неподходящи за профила на библиотеката' }, { k: 4, t: 'Физически изхабени' },
  { k: 5, t: 'Повредени или невърнати от ползватели' }, { k: 6, t: 'Констатирани като липсващи при инвентаризация' },
  { k: 7, t: 'Неизползваеми носители на информация' }, { k: 8, t: 'Повредени/унищожени при бедствие или кражба (протокол на МВР)' }
];
const PER_FREQ = ['седмично', 'двуседмично', 'месечно', 'тримесечно', 'полугодишно', 'годишно', 'нередовно'];
const MZS_STATUS = ['заявено', 'изпратено', 'получено', 'върнато', 'отказано'];
const THEMES = [
  { id: '1', name: 'Бронз', spine: '#1A1208', brass: '#96731F', paper: '#F4F0E4' },
  { id: '2', name: 'Наситено синьо', spine: '#0F1B2E', brass: '#2C5C8F', paper: '#EEF2F6' },
  { id: '3', name: 'Горско зелено', spine: '#0E1F14', brass: '#2E6B45', paper: '#EFF3EC' },
  { id: '4', name: 'Бордо', spine: '#22090F', brass: '#7A2036', paper: '#F5EDEC' },
  { id: '5', name: 'Графит', spine: '#1C2126', brass: '#536573', paper: '#EEF0F1' },
  { id: '6', name: 'Кафяво-теракота', spine: '#22140A', brass: '#A65A2E', paper: '#F3ECE3' }
];
async function setTheme(id) {
  await call(window.api.settings.updateTheme(id));
  markSaved();
  await loadSettingsCache();
  if (VIEW === 'setup') renderSetup();
}
window.setTheme = setTheme;

/* ---------------- Code 39 баркод (SVG) ---------------- */
const C39 = {'0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn',
'6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn','A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn',
'D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww',
'R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn','U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw',
'Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','*':'nwnnwnwnn'};
function code39svg(text, w, h) {
  const s = '*' + String(text || '').toUpperCase().replace(/[^0-9A-Z\-. ]/g, '') + '*';
  const nw = 1, ww = 2.6, gap = 1;
  let units = 0;
  for (const ch of s) { const p = C39[ch]; if (!p) continue; for (const c of p) units += c === 'w' ? ww : nw; units += gap; }
  if (!units) return '';
  const sc = (w || 160) / units; let x = 0, bars = '';
  for (const ch of s) {
    const p = C39[ch]; if (!p) continue;
    for (let k = 0; k < 9; k++) {
      const wd = (p[k] === 'w' ? ww : nw) * sc;
      if (k % 2 === 0) bars += `<rect x="${x.toFixed(2)}" y="0" width="${wd.toFixed(2)}" height="${h || 40}" fill="#000"/>`;
      x += wd;
    }
    x += gap * sc;
  }
  return `<svg viewBox="0 0 ${w || 160} ${h || 40}" width="100%" height="${h || 40}" preserveAspectRatio="none" shape-rendering="crispEdges">${bars}</svg>`;
}

/* ---------------- Печат: обща инфраструктура ---------------- */
let SETTINGS_CACHE = null;
async function loadSettingsCache() {
  SETTINGS_CACHE = await call(window.api.settings.get());
  updateBrandSub();
  applyTheme();
  return SETTINGS_CACHE;
}
// Библиотеката, която ползва програмата, се описва само в „Настройки“. Всичко останало
// (лентата вляво, заглавията на документите за печат, етикетите, читателските карти)
// чете оттам, за да не се налага една и съща промяна да се прави на две места.
function needsSetup(s) { return !(s && (s.org || s.lib_name)); }
function updateBrandSub() {
  const el = $('#brandSub'); if (!el || !SETTINGS_CACHE) return;
  const txt = [SETTINGS_CACHE.org, SETTINGS_CACHE.place].filter(Boolean).join(' · ');
  el.textContent = txt || 'Попълнете данните в „Настройки“';
  el.classList.toggle('brandSubEmpty', !txt);
}
function applyTheme() {
  document.documentElement.dataset.theme = (SETTINGS_CACHE && SETTINGS_CACHE.theme) || '1';
}
// Заглавната част на всеки официален документ за печат. Празните полета отпадат,
// вместо да оставят празни редове — така документът изглежда правилно и при
// библиотека, която не попълва всичко (напр. няма отделен регистрационен номер).
/* Плочка с показател — ползва се от Таблото, Справките и краеведските раздели. */
function kpi(icon, num, lbl, extra, cls) {
  return `<div class="kpi ${cls || ''}">
    <div class="kpi-ico">${icon}</div>
    <div class="kpi-body">
      <div class="kpi-num">${num}</div>
      <div class="kpi-lbl">${lbl}</div>
      ${extra ? `<div class="kpi-extra">${extra}</div>` : ''}
    </div>
  </div>`;
}

function shead() {
  const s = SETTINGS_CACHE || {};
  const lines = [];
  if (s.org) lines.push(`<b>${esc(s.org)}</b>`);
  if (s.lib_name) lines.push(esc(s.lib_name));
  const place = [s.place ? esc(s.place) : '', s.bulstat ? 'ЕИК ' + esc(s.bulstat) : ''].filter(Boolean).join(' · ');
  if (place) lines.push(place);
  const text = `<div class="porg">${lines.join('<br>')}</div>`;
  // Логото застава вляво от данните на организацията във всеки официален документ.
  return s.logo ? `<div class="pheadRow"><img class="plogo" src="${esc(s.logo)}" alt="">${text}</div>` : text;
}
function ssig(names) { return `<div class="psig">${names.map(n => `<div>${n}</div>`).join('')}</div>`; }
// Името на документа се задава тук, защото всяка разпечатка минава през
// setPrintPage непосредствено преди doPrint. Така не се променят дванайсетте
// извиквания на doPrint, всяко от които е дълъг вложен шаблон.
let PRINT_DOC_NAME = '';
function setPrintPage(opts) {
  opts = opts || {};
  PRINT_DOC_NAME = opts.name || '';
  let st = document.getElementById('dynPrintStyle');
  if (!st) { st = document.createElement('style'); st.id = 'dynPrintStyle'; document.head.appendChild(st); }
  const size = opts.widthMm ? opts.widthMm + 'mm ' + opts.heightMm + 'mm' : 'A4' + (opts.landscape ? ' landscape' : '');
  st.textContent = `@media print{ @page{size:${size};margin:${opts.margin || '14mm 12mm'}} ${opts.extraCss || ''} }`;
}
/* Windows предлага заглавието на страницата като име на PDF файла в „Microsoft
   Print to PDF“. Затова преди печат заглавието се сменя с името на конкретния
   документ и се връща обратно веднага след това — иначе всяка разпечатка щеше да
   се казва „Инвентар · Библиотечна система“. */
const APP_TITLE = document.title;
// Знаците, забранени в имена на файлове под Windows, плюс кавичките и тиретата от
// оформлението, които правят името нечетимо в диалога за запис.
function safeFileName(name) {
  return String(name || '').trim()
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[„“”«»]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim();
}
function doPrint(html, docName) {
  $('#printArea').innerHTML = html;
  const name = safeFileName(docName || PRINT_DOC_NAME);
  if (name) document.title = name;
  toast(name
    ? `За PDF файл изберете „Save as PDF“ / „Microsoft Print to PDF“ — файлът ще се казва „${name}“.`
    : 'За PDF файл: в прозореца за печат изберете „Save as PDF“ / „Microsoft Print to PDF“ вместо принтер.');
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
    window.print();
    // Връща се след диалога; в Electron window.print() блокира до затварянето му.
    document.title = APP_TITLE;
  }, 150)));
}
/* Размерите на трите вида етикети се задават в „Баркод етикети“ → „Формат на печат“.
   kind избира кой размер важи: 'fund' — етикет за фонда, 'sig' — етикет за сигнатура
   (гръбче), 'card' — читателска карта. */
function labelSize(kind) {
  const s = SETTINGS_CACHE || {};
  if (kind === 'sig') return { w: +s.sig_w || 25, h: +s.sig_h || 35 };
  if (kind === 'card') return { w: +s.card_w || 90, h: +s.card_h || 60 };
  return { w: +s.lbl_w || 40, h: +s.lbl_h || 30 };
}
const LABEL_DOC_NAME = { fund: 'Баркод етикети за фонда', sig: 'Етикети за сигнатура',
  card: 'Читателски карти' };
function printLabelSheet(cardsHtml, kind) {
  const s = SETTINGS_CACHE || {};
  const { w, h } = labelSize(kind);
  const docName = (LABEL_DOC_NAME[kind] || 'Етикети') + ' — ' + bg(today());
  const gap = (s.lbl_gap != null ? +s.lbl_gap : 3);
  const marg = (s.lbl_margin != null ? +s.lbl_margin : 8);
  const border = s.lbl_border == null || +s.lbl_border ? '1px dashed #999' : 'none';
  if (s.lbl_mode === 'roll') {
    // Един етикет на страница с точния размер на ролката.
    setPrintPage({
      name: docName, widthMm: w, heightMm: h, margin: marg + 'mm',
      extraCss: `.lblsheet{display:block}` +
        `.lbl{width:${w - 2 * marg}mm;height:${h - 2 * marg}mm;box-sizing:border-box;border:none;` +
        `page-break-after:always;display:flex;flex-direction:column;align-items:center;justify-content:center}`
    });
  } else {
    // A4 лист: колоните и разстоянията се задават от настройките, а всеки етикет
    // получава точната си височина, за да съвпадне с готовите листове с етикети.
    const cols = Math.max(1, Math.min(8, +s.lbl_cols || 3));
    setPrintPage({
      name: docName, landscape: false, margin: marg + 'mm',
      extraCss: `.lblsheet{display:grid;grid-template-columns:repeat(${cols},${w}mm);gap:${gap}mm;justify-content:start}` +
        `.lbl{width:${w}mm;height:${h}mm;box-sizing:border-box;border:${border};` +
        `display:flex;flex-direction:column;align-items:center;justify-content:center}`
    });
  }
  doPrint(`<div class="pdoc"><div class="lblsheet">${cardsHtml}</div></div>`);
}
/* Етикет за фонда: наименование на библиотеката, населено място, баркод (Code 39)
   и инвентарният номер под баркода. */
function lblCard(b) {
  const s = SETTINGS_CACHE || {};
  const name = s.lib_name || s.org || '';
  return `<div class="lbl">
    ${name ? `<div class="l1">${esc(name)}</div>` : ''}
    ${s.place ? `<div class="l2">${esc(s.place)}</div>` : ''}
    ${code39svg(b.barcode || String(b.inv_number), 150, 40)}
    <div class="l3">${esc(b.inv_number ?? b.barcode ?? '')}</div></div>`;
}
/* Читателска карта, стандартен размер 90 x 60 мм. Оформена е като истинска карта:
   заглавна лента с логото и името на библиотеката, име на читателя и данни от
   регистрацията, баркод на номера на картата долу. */
function readerCardHtml(r) {
  const s = SETTINGS_CACHE || {};
  const name = s.lib_name || s.org || '';
  const valid = r.re_registered_at || r.registered_at || '';
  return `<div class="lbl rcard">
    <div class="rc-top">
      ${s.logo ? `<img class="rc-logo" src="${esc(s.logo)}" alt="">` : ''}
      <div class="rc-org">
        ${name ? `<div class="rc-name">${esc(name)}</div>` : ''}
        ${s.place ? `<div class="rc-place">${esc(s.place)}</div>` : ''}
      </div>
    </div>
    <div class="rc-title">ЧИТАТЕЛСКА КАРТА</div>
    <div class="rc-body">
      <div class="rc-reader">${esc(r.name || '')}</div>
      <div class="rc-meta">
        <span>Категория: <b>${esc(r.category || '—')}</b></span>
        <span>Рег. ${esc(bg(valid) || '—')}</span>
      </div>
    </div>
    <div class="rc-bar">
      ${code39svg(r.card_no || String(r.id), 200, 34)}
      <div class="rc-no">№ ${esc(r.card_no || r.id)}</div>
    </div>
  </div>`;
}
function sigLblCard(b) {
  return `<div class="lbl lbl-sig">
    <div class="ls-udk">${esc(b.udk || '')}</div>
    <div class="ls-avt">${esc(b.author_mark || b.call_number || '')}</div>
  </div>`;
}

/* ---------------- Навигация ---------------- */
const NAV = [
  { g: 'Общ преглед', items: [['dash', 'Табло']] },
  { g: 'Фонд', items: [['books', 'Книги'], ['invbook', 'Инвентарна книга'],
    ['kdbf', 'КДБФ'], ['acq', 'Постъпления'], ['acts', 'Отчисляване'], ['invent', 'Инвентаризация'],
    ['auth', 'Авторитетни данни']] },
  { g: 'Читатели', items: [['readers', 'Читатели'], ['circ', 'Заемане и връщане'], ['over', 'Просрочени']] },
  { g: 'Други регистри', items: [['periodika', 'Периодика'], ['mzs', 'МЗС'], ['dnevnik', 'Дневник']] },
  { g: 'Краезнание', items: [['analytics', 'Аналитично описание'], ['persons', 'Персоналии'], ['chronicle', 'Летопис']] },
  { g: 'Отчети', items: [['stats', 'Справки и статистика'], ['catalog', 'Онлайн каталог'], ['labels', 'Баркод етикети'], ['odit', 'Одитна следа']] },
  { g: 'Настройки', items: [['setup', 'Настройки']] }
];
const NAV_ICONS = {
  dash: '📊', books: '📚', invbook: '📖', kdbf: '📒', acq: '📥', acts: '📤',
  invent: '🗃️', auth: '🗂️', readers: '👥', circ: '🔄', over: '⏰',
  periodika: '📰', mzs: '🤝', dnevnik: '📅', analytics: '📑', persons: '👤',
  chronicle: '🕰️', stats: '📈', catalog: '🌐', labels: '🏷️', odit: '🧾', setup: '⚙️'
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
  periodika: ['Периодика', 'картотека на постъпилите броеве'],
  mzs: ['Междубиблиотечно заемане', 'заявки от и към други библиотеки'],
  dnevnik: ['Дневник на библиотеката', 'месечен статистически дневник — Раздел А и Раздел Б'],
  analytics: ['Аналитично описание', 'статии в периодични издания и части от книги'],
  persons: ['Персоналии', 'видни местни жители и дейци'],
  chronicle: ['Летопис', 'хронология на читалищната дейност'],
  stats: ['Справки и статистика', 'годишен отчет и показатели'],
  catalog: ['Онлайн каталог', 'публикуване в интернет'],
  labels: ['Баркод етикети', 'печат на етикети Code 39'],
  odit: ['Одитна следа', 'кой служител какво е извършил'],
  setup: ['Настройки', 'данни за библиотеката и обслужването']
};
let VIEW = 'dash';

function go(v) { location.hash = v; }
window.go = go;
window.addEventListener('hashchange', route);

function drawNav() {
  $('#nav').innerHTML = NAV.map(g =>
    `<div class="nav-grp">${esc(g.g)}</div>` +
    g.items.map(([k, t]) =>
      `<a href="#${k}" class="${VIEW === k ? 'on' : ''}"><span class="ic">${NAV_ICONS[k] || '•'}</span><span class="tx">${esc(t)}</span></a>`
    ).join('')
  ).join('');
}

const RENDERERS = {
  dash: renderDash, books: renderBooks, invbook: renderInvBook,
  kdbf: renderKdbf, acq: renderAcq, acts: renderActs, invent: renderInvent,
  auth: renderAuth, readers: renderReaders, circ: renderCirc, over: renderOver,
  periodika: renderPeriodika, mzs: renderMzs, dnevnik: renderDnevnik,
  analytics: renderAnalytics, persons: renderPersons, chronicle: renderChronicle,
  stats: renderStats, catalog: renderCatalog, labels: renderLabels, odit: renderOdit, setup: renderSetup
};

async function route() {
  const h = (location.hash || '#dash').slice(1);
  VIEW = TITLES[h] ? h : 'dash';
  const t = TITLES[VIEW];
  $('#vTitle').textContent = t[0];
  $('#vSub').textContent = t[1];
  drawNav();
  await RENDERERS[VIEW]();
}

/* ---------------- Служител (одитна следа) ----------------
   Изборът "кой работи в момента" е локален за този компютър (пази се в config.json на
   работната станция), а самият списък със служители е общ — идва от споделената база
   данни, затова важи еднакво на всички компютри, свързани към нея. */
async function initUserBadge() {
  const name = await call(window.api.app.getUser());
  renderUserBadge(name);
}
function renderUserBadge(name) {
  const el = $('#userBadge');
  if (!el) return;
  el.textContent = name ? 'Служител: ' + name : 'Служител: (изберете)';
  el.classList.toggle('unset', !name);
  el.title = name
    ? 'Действията се вписват в одитната следа на името на този служител. Натиснете, за да смените.'
    : 'Изберете кой служител работи в момента.';
}
async function chooseEmployeeModal() {
  const employees = await call(window.api.employees.list());
  if (!employees) return;
  window._EMPLOYEES_ACTIVE = employees.filter(e => e.active);
  modal('Кой служител работи в момента?',
    window._EMPLOYEES_ACTIVE.length
      ? `<div style="display:flex;flex-direction:column;gap:8px">
          ${window._EMPLOYEES_ACTIVE.map(e => `<button type="button" class="btn" style="text-align:left" onclick="pickEmployee(${e.id})">${esc(e.name)}</button>`).join('')}
        </div>`
      : '<div class="hint">Все още няма добавени служители — добавете ги в „Настройки“ → „Служители“.</div>',
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="closeModal();go('setup')">Управление на служителите</button>`);
}
window.chooseEmployeeModal = chooseEmployeeModal;
async function pickEmployee(id) {
  const emp = (window._EMPLOYEES_ACTIVE || []).find(x => x.id === id);
  if (!emp) return;
  const saved = await call(window.api.app.setUser(emp.name));
  renderUserBadge(saved);
  closeModal();
}
window.pickEmployee = pickEmployee;

/* ---------------- Версия и авторство ---------------- */
const APP_YEAR_START = 2026; // годината на създаване на Electron версията — фиксирана веднъж
function appYears() {
  const y = new Date().getFullYear();
  return y > APP_YEAR_START ? APP_YEAR_START + '–' + y : String(APP_YEAR_START);
}
let APP_CREDIT_TEXT = '';
async function initAppCredit() {
  const version = await call(window.api.app.getVersion());
  APP_CREDIT_TEXT = 'Създадено от Пламен Боянов Христов · GPL-3.0 © ' + appYears() + (version ? ' · v' + version : '');
  const el = $('#appCredit');
  if (el) el.textContent = APP_CREDIT_TEXT;
}

/* ---------------- Автоматично обновяване ---------------- */
let UPDATE_STATUS = { state: 'idle' };
function initAutoUpdateUI() {
  if (!window.api.app.onUpdateStatus) return;
  window.api.app.onUpdateStatus((data) => {
    UPDATE_STATUS = data;
    if (data.state === 'available') toast('Налична е нова версия ' + data.version + ' — изтегля се…', 'ok');
    else if (data.state === 'downloaded') {
      toast('Версия ' + data.version + ' е изтеглена. Ще се инсталира при затваряне на програмата.', 'ok');
    } else if (data.state === 'error') {
      console.error('Автообновяване:', data.message);
    }
    if (VIEW === 'setup') renderSetup();
  });
}
async function checkForUpdatesNow() {
  const res = await window.api.app.checkForUpdates();
  if (!res.ok) return toast(res.error, 'err');
  toast('Проверка за обновления…', 'ok');
}
window.checkForUpdatesNow = checkForUpdatesNow;
async function installUpdateNow() {
  await window.api.app.installUpdate();
}
window.installUpdateNow = installUpdateNow;

/* ---------------- Табло ---------------- */
async function renderDash() {
  const r = await call(window.api.dashboard.full());
  if (!r) return;
  const pct = r.inventoryTarget ? Math.min(100, Math.round(r.inventoryScannedYear / r.inventoryTarget * 100)) : 0;
  $('#view').innerHTML = `
    <div class="card dashScan">
      <div class="dashScan-l">
        <h3 style="margin:0 0 2px">Бързо търсене / сканиране</h3>
        <div class="hint" style="margin:0">Сканирайте баркод на документ или читателска карта — програмата разпознава сама какво е.</div>
      </div>
      <input id="dashScan" class="scan" placeholder="Сканирай баркод, инв. № или № читателска карта…" autocomplete="off">
    </div>
    <div id="dashScanResult"></div>

    <div class="kpis">
      ${kpi('📚', r.fundCount.toLocaleString('bg-BG'), 'Библиотечен фонд', mny(r.fundValue))}
      ${kpi('📖', r.loansOpen, 'Заети в момента', 'при ' + r.activeReaders + ' активни читатели')}
      ${kpi('⏰', r.overdueCount, 'Просрочени', r.overdueCount ? 'изискват внимание' : 'няма закъснения', r.overdueCount ? 'warn' : 'ok')}
      ${kpi('📅', r.upcoming.length, 'Връщания до 3 дни', r.upcoming.length ? 'предстоящи' : 'няма предстоящи')}
      ${r.holdsReady || r.holdsWaiting
        ? kpi('📌', r.holdsReady, 'Заделени за читатели', r.holdsReady
            ? 'чакат да бъдат взети' + (r.holdsWaiting ? ' · ' + r.holdsWaiting + ' в опашка' : '')
            : r.holdsWaiting + ' в опашка за заета книга', r.holdsReady ? 'warn' : '')
        : ''}
    </div>

    <div class="grid g3" style="margin-top:16px">
      <div class="card" style="grid-column:span 2"><h3 style="margin-top:0">Просрочени заемания
        ${r.overdueRows.length ? '<button class="btn sm" style="float:right" onclick="go(\'over\')">Всички</button>' : ''}</h3>
        ${r.overdueRows.length ? `<div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
        <th>Читател</th><th>Документ</th><th>Инв. №</th><th>Срок</th><th>Дни</th></tr></thead><tbody>
        ${r.overdueRows.map(l => `<tr><td>${esc(l.reader_name)}</td><td>${esc(l.title)}</td>
        <td class="num">${l.inv_number ?? ''}</td><td class="num">${bg(l.date_due)}</td>
        <td class="num warn">${Math.round((new Date(today()) - new Date(l.date_due)) / 864e5)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty"><p>Няма просрочени заемания.</p></div>'}
      </div>
      <div class="card"><h3 style="margin-top:0">Годината ${r.year}</h3>
        <div class="statRows">
          <div><span>Постъпили документи</span><b>${r.acquiredYear}</b></div>
          <div><span>Отчислени документи</span><b>${r.deaccessionedYear}</b></div>
          <div><span>Заемания</span><b>${r.loansYear}</b></div>
          <div><span>Записани читатели</span><b>${r.readersYear}</b></div>
        </div>
        <hr style="border:0;border-top:1px solid var(--rule);margin:12px 0 10px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
          <span>Инвентаризация</span><b>${r.inventoryScannedYear} / ${r.inventoryTarget}</b></div>
        <div class="bar"><div class="bar-fill ${pct >= 100 ? 'done' : ''}" style="width:${pct}%"></div></div>
        <div class="hint" style="margin-top:7px">Чл. 40, т. 2: ежегодно не по-малко от <b>${r.inventoryPct}%</b> от фонда по репрезентативния метод.</div>
      </div>
    </div>

    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Бързи действия</h3>
        <div class="quickGrid">
          <button class="quickBtn" onclick="bookForm()"><span>➕</span>Нов документ</button>
          <button class="quickBtn" onclick="go('circ')"><span>🔄</span>Заемане / връщане</button>
          <button class="quickBtn" onclick="readerForm()"><span>👤</span>Нов читател</button>
          <button class="quickBtn" onclick="go('acq')"><span>📦</span>Нова партида</button>
          <button class="quickBtn" onclick="go('dnevnik')"><span>📝</span>Дневник</button>
          <button class="quickBtn" onclick="go('labels')"><span>🏷️</span>Етикети</button>
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">Предстоящи връщания (до 3 дни)</h3>
        <div style="font-size:13px">
          ${r.upcoming.length ? r.upcoming.map(l => `<div class="upcomingRow">
          <span style="flex:1">${esc(l.title)}</span><span class="hint">${esc(l.reader_name)}</span>
          <b class="num">${bg(l.date_due)}</b></div>`).join('') : '<span class="hint">Няма.</span>'}
        </div>
      </div>
    </div>

    ${r.fundCount === 0 ? `<div class="note w" style="margin-top:18px"><b>Първи стъпки.</b>
    1) Попълнете <a href="#setup">Настройки</a> — име на библиотеката, ръководител, комисия и начален инвентарен номер.
    2) Заведете партида в <a href="#acq">Постъпления</a> (чл. 14).
    3) Каталогизирайте документите в <a href="#books">Книги</a>. Инвентарните номера се дават последователно (чл. 16, ал. 2).</div>` : ''}
  `;
  const sc = $('#dashScan');
  if (sc) {
    sc.focus();
    sc.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = sc.value.trim(); sc.value = '';
      if (code) await dashLookup(code);
    });
  }
}
/* Разпознава сканираното само по това дали съвпада с документ или с читателска карта —
   не се налага потребителят предварително да избира какво сканира. */
async function dashLookup(code) {
  const box = $('#dashScanResult');
  const [book, reader] = await Promise.all([
    window.api.books.byBarcode(code), window.api.readers.byCard(code)
  ]);
  const b = book.ok ? book.data : null;
  const rd = reader.ok ? reader.data : null;
  if (b) {
    const loans = await call(window.api.loans.list());
    const open = (loans || []).filter(l => l.book_id === b.id && !l.date_in);
    box.innerHTML = `<div class="card scanHit">
      <div class="scanHit-head"><b>Документ</b> · инв. № ${b.inv_number ?? '—'}
        <button class="btn sm" style="float:right" onclick="bookForm(${b.id})">Отвори карта</button></div>
      <div class="scanHit-title">${esc(b.title)}</div>
      <div class="hint">${esc([b.author, b.publisher, b.year].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:8px">
        ${b.status === 'отчислен' ? '<span class="badge warn">отчислен</span>'
          : open.length ? `<span class="badge warn">заета от ${esc(open[0].reader_name || '')} до ${bg(open[0].date_due)}</span>`
          : '<span class="badge ok">налична</span>'}
        <span class="hint" style="margin-left:8px">${esc(b.department || '')}${b.call_number ? ' · ' + esc(b.call_number) : ''}</span>
      </div></div>`;
  } else if (rd) {
    const loans = await call(window.api.loans.byReader(rd.id));
    const open = (loans || []).filter(l => !l.date_in);
    box.innerHTML = `<div class="card scanHit">
      <div class="scanHit-head"><b>Читател</b> · карта ${esc(rd.card_no || '—')}
        <button class="btn sm" style="float:right" onclick="go('circ')">Заемане / връщане</button></div>
      <div class="scanHit-title">${esc(rd.name)}</div>
      <div class="hint">${esc(rd.category || '')}${rd.phone ? ' · ' + esc(rd.phone) : ''}</div>
      <div style="margin-top:8px">
        ${rd.status === 'прекратен' ? '<span class="badge warn">прекратена регистрация</span>'
          : `<span class="badge ok">активен</span>`}
        <span class="hint" style="margin-left:8px">заети в момента: <b>${open.length}</b></span>
      </div></div>`;
  } else {
    box.innerHTML = `<div class="note w">Няма намерен документ или читател с код <b>${esc(code)}</b>.</div>`;
  }
}
window.dashLookup = dashLookup;

/* ---------------- Категории (управляват се в „Настройки“) ---------------- */
function categoriesCardHtml(cats) {
  return `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Категории (видове документи)</h3>
    <div class="note" style="margin-top:0">Категориите се избират при вписване на всеки документ във фонда
    и излизат в справките и в онлайн каталога.</div>
    <div class="toolbar"><button class="btn pri" onclick="categoryForm()">+ Нова категория</button></div>
    ${cats && cats.length ? `<div class="wrap"><table class="ledger">
      <thead><tr><th>Име</th><th style="width:150px"></th></tr></thead><tbody>
      ${cats.map(c => `<tr><td>${esc(c.name)}</td>
        <td><button class="btn sm" onclick="categoryForm(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}')">Редакция</button>
            <button class="btn sm dgr" onclick="deleteCategory(${c.id})">Изтрий</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="hint">Няма категории.</div>'}
  </div>`;
}
function categoryForm(id, name) {
  modal(id ? 'Редакция на категория' : 'Нова категория',
    `<form id="catF" onsubmit="return false">${fld('Име', 'name', { val: name || '', req: 1 })}</form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveCategory(${id || 'null'})">Запиши</button>`);
}
window.categoryForm = categoryForm;
async function saveCategory(id) {
  const d = formData('#catF');
  if (!d.name.trim()) return toast('Името е задължително.', 'err');
  if (id) await call(window.api.categories.update({ id, name: d.name }), 'Категорията е обновена.');
  else await call(window.api.categories.create(d.name), 'Категорията е добавена.');
  closeModal(); renderSetup();
}
window.saveCategory = saveCategory;
async function deleteCategory(id) {
  if (!confirm('Да изтрия ли тази категория?')) return;
  await call(window.api.categories.delete(id), 'Категорията е изтрита.');
  renderSetup();
}
window.deleteCategory = deleteCategory;

/* ---------------- Книги ---------------- */
let BOOKS_QUERY = '';
async function renderBooks() {
  const [books, cats] = await Promise.all([call(window.api.books.list(BOOKS_QUERY)), call(window.api.categories.list())]);
  if (!books) return;
  window._CATS = cats || [];
  $('#view').innerHTML = `
    <div class="toolbar">
      <input type="search" id="bSearch" placeholder="Търсене по заглавие, автор, ISBN, баркод или инв. №…" value="${esc(BOOKS_QUERY)}">
      <button class="btn pri" onclick="bookForm()">+ Нова книга</button>
    </div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Инв. №</th><th>Заглавие</th><th>Автор</th><th>Категория</th><th>Отдел</th><th>Год.</th><th>Състояние</th><th>Наличност</th><th style="width:160px"></th></tr></thead>
      <tbody>
        ${books.length ? books.map(b => `
          <tr>
            <td class="num">${b.inv_number ?? ''}</td>
            <td>${esc(b.title)}</td>
            <td>${esc(b.author || '')}</td>
            <td>${esc(b.category_name || '')}</td>
            <td>${esc(b.department || '')}</td>
            <td class="num">${esc(b.year || '')}</td>
            <td><span class="badge ${b.status === 'наличен' ? 'ok' : 'warn'}">${esc(b.status || '')}</span></td>
            <td><span class="badge ${b.available > 0 ? 'ok' : 'warn'}">${b.available}/${b.quantity}</span></td>
            <td><button class="btn sm" onclick="bookForm(${b.id})">Редакция</button>
                <button class="btn sm dgr" onclick="deleteBook(${b.id})">Изтрий</button></td>
          </tr>`).join('') : `<tr><td colspan="9" class="empty">Няма намерени книги.</td></tr>`}
      </tbody>
    </table></div>
  `;
  $('#bSearch').addEventListener('input', debounce(e => { BOOKS_QUERY = e.target.value; renderBooks(); }, 300));
}

async function bookForm(id, presetAcqId) {
  const b = id ? await call(window.api.books.get(id)) : null;
  const [cats, acqs, sug] = await Promise.all([
    call(window.api.categories.list()), call(window.api.acquisitions.list()), loadAuthSuggest()
  ]);
  const v = b || { register_date: today(), status: 'наличен', language: 'български', department: 'за възрастни', acquisition_id: presetAcqId || '' };
  const catOpts = (cats || []).map(c => ({ v: c.id, t: c.name }));
  const acqOpts = (acqs || []).map(a => ({ v: a.id, t: '№ ' + a.no + '/' + a.year + ' — ' + (a.from_source || '') }));
  modal(id ? 'Инв. № ' + v.inv_number + ' — редакция' : 'Нов документ във фонда', `
    <div class="note"><b>Чл. 16, ал. 1</b> — индивидуалната регистрация съдържа: дата на вписване, инвентарен номер, автор,
    заглавие, том, година, цена, номер и дата на вписване в КДБФ, сигнатура.</div>
    <form id="bookF" onsubmit="return false">
    <fieldset><legend>Инвентиране</legend>
      <div class="grid g3">
        ${fld('Инвентарен номер', 'inv_number', { val: v.inv_number ?? '', type: 'number', req: 1 })}
        ${fld('Дата на вписване', 'register_date', { val: v.register_date, type: 'date', req: 1 })}
        ${fld('Баркод', 'barcode', { val: v.barcode || '', hint: 'празно = инв. номер' })}
      </div>
      <div class="grid g3">
        ${fld('Вид документ (категория)', 'category_id', { type: 'select', opts: catOpts, val: v.category_id || '' })}
        ${fld('Партида в КДБФ', 'acquisition_id', { type: 'select', opts: acqOpts, val: v.acquisition_id || '', emptyLabel: '— без партида —' })}
        ${fld('Сигнатура', 'call_number', { val: v.call_number || '' })}
      </div>
      <div class="grid g4">
        ${fld('Цена (лв.)', 'price', { val: v.price ?? 0, type: 'number', step: '0.01', req: 1 })}
        ${fld('Цена (€)', 'price_eur', { val: eur(v.price || 0), type: 'number', step: '0.01', hint: 'автоматично при промяна' })}
        ${fld('Отдел / местонахождение', 'department', { type: 'select', opts: OTDELI, val: v.department })}
        ${fld('Налични бройки', 'quantity', { val: v.quantity ?? 1, type: 'number', min: 0 })}
      </div>
    </fieldset>
    <fieldset><legend>Библиографско описание</legend>
      <div class="grid g2">
        ${fld('Заглавие', 'title', { val: v.title || '', req: 1 })}
        ${fld('Автор (фамилия, име)', 'author', { val: v.author || '', list: 'author', hint: 'предлага се от вече въведените' })}
      </div>
      <div class="grid g4">
        ${fld('Подзаглавие', 'subtitle', { val: v.subtitle || '' })}
        ${fld('Място на издаване', 'city', { val: v.city || '', list: 'city' })}
        ${fld('Издателство', 'publisher', { val: v.publisher || '', list: 'publisher' })}
        ${fld('Година', 'year', { val: v.year || '' })}
      </div>
      <div class="grid g4">
        ${fld('Том / част', 'volume', { val: v.volume || '' })}
        <div class="field"><label>ISBN / ISSN</label>
          <div class="isbnRow">
            <input name="isbn" value="${esc(v.isbn || '')}">
            <button type="button" class="btn" id="isbnBtn" onclick="isbnLookup()"
              title="Изтегля данните за книгата от Google Books и Open Library">Търси</button>
          </div>
          <div class="hint" id="isbnHint">Въведете ISBN и натиснете „Търси“ — полетата се попълват сами.</div>
        </div>
        ${fld('Страници', 'pages', { val: v.pages || '' })}
        ${fld('Език', 'language', { type: 'select', opts: EZICI, val: v.language })}
      </div>
      <div class="grid g4">
        <div class="field"><label>УДК</label>
          <div class="isbnRow">
            <input name="udk" value="${esc(v.udk || '')}" list="dl_udk">
            <button type="button" class="btn" onclick="udkPicker()"
              title="Избор от таблицата на УДК">Избери…</button>
          </div>
        </div>
        ${fld('Авторски знак', 'author_mark', { val: v.author_mark || '', hint: 'напр. „В-15“' })}
        ${fld('Ключови думи', 'keywords', { val: v.keywords || '', list: 'keywords', hint: 'през запетая' })}
        ${fld('Адрес на корица (URL)', 'cover_url', { val: v.cover_url || '' })}
      </div>
      <div class="grid g3">
        ${fld('Състояние', 'status', { type: 'select', opts: ['наличен', 'липсващ', 'за реставрация', 'отчислен'], val: v.status, allowEmpty: false })}
        ${fld('Забележка', 'description', { val: v.description || '', hint: 'поправки не се допускат — чл. 17, ал. 2' })}
        ${fld('Анотация', 'annotation', { type: 'textarea', val: v.annotation || '', rows: 2 })}
      </div>
    </fieldset>
    </form>
    ${datalistsHtml(sug || {})}`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveBook(${id || 'null'})">Запиши</button>`);
  if (id) $('#bookF').dataset.id = id;
  const priceEl = $('#bookF [name=price]'), priceEurEl = $('#bookF [name=price_eur]');
  if (priceEl && priceEurEl) {
    priceEl.addEventListener('input', () => { priceEurEl.value = eur(priceEl.value); });
    priceEurEl.addEventListener('input', () => { priceEl.value = (parseFloat(priceEurEl.value || 0) * EUR_RATE).toFixed(2); });
  }
}
window.bookForm = bookForm;

/* ---------------- Напомняния за просрочени ----------------
   Текстовете се готвят автоматично, но изпращането остава решение на библиотекаря:
   отваря се пощенският клиент с попълнено писмо, или текстът се копира за SMS. */
async function openReminders() {
  const rows = await call(window.api.loans.reminders());
  if (!rows) return;
  if (!rows.length) return toast('Няма просрочени заемания.', 'ok');
  window._REMINDERS = rows;
  modal('Напомняния за просрочени материали', `
    <div class="note" style="margin-top:0">Текстовете са готови. Изпращането е ръчно —
    прегледайте и променете, ако е нужно. „Отвори в пощата“ стартира пощенския клиент
    с попълнени получател, тема и съобщение.</div>
    ${rows.map((r, i) => `
      <div class="remCard">
        <div class="remHead">
          <span class="remName">${esc(r.name)}</span>
          <span class="remBadge">${r.n} просрочени</span>
          ${Number(r.fine) > 0 ? `<span class="hint">${mny(r.fine)}</span>` : ''}
        </div>
        <div class="remBody">
          <div class="remMeta">
            Имейл: <b>${r.email ? esc(r.email) : '— няма записан —'}</b> ·
            Телефон: <b>${r.phone ? esc(r.phone) : '— няма записан —'}</b>
          </div>
          <label class="fh">Писмо по електронна поща</label>
          <textarea class="remText" id="remB${i}" rows="9">${esc(r.body)}</textarea>
          <div class="toolbar" style="margin-top:6px">
            <button class="btn pri" onclick="remMail(${i})" ${r.email ? '' : 'disabled'}>Отвори в пощата</button>
            <button class="btn" onclick="remCopy('remB${i}')">Копирай писмото</button>
          </div>
          <label class="fh" style="margin-top:10px;display:block">Кратък текст за SMS</label>
          <textarea class="remText" id="remS${i}" rows="2">${esc(r.sms)}</textarea>
          <div class="toolbar" style="margin-top:6px">
            <button class="btn" onclick="remCopy('remS${i}')">Копирай SMS-а</button>
            <span class="hint" id="remLen${i}">${r.sms.length} знака</span>
          </div>
        </div>
      </div>`).join('')}`,
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn" onclick="printOverdueNotices()">Печат на всички / PDF</button>`);
  rows.forEach((r, i) => {
    const t = $('#remS' + i);
    if (t) t.addEventListener('input', () => {
      const n = t.value.length;
      $('#remLen' + i).textContent = n + ' знака' + (n > 160 ? ' — над един SMS' : '');
    });
  });
}
window.openReminders = openReminders;
async function remMail(i) {
  const r = (window._REMINDERS || [])[i];
  if (!r) return;
  const res = await window.api.loans.mailto({ email: r.email, subject: r.subject, body: $('#remB' + i).value });
  if (!res.ok) return toast(res.error, 'err');
  toast('Писмото е отворено в пощенския клиент.', 'ok');
}
window.remMail = remMail;
async function remCopy(id) {
  const el = $('#' + id);
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.value);
    toast('Копирано.', 'ok');
  } catch (e) {
    // Резервен път, ако достъпът до системния буфер е отказан.
    el.select(); document.execCommand('copy');
    toast('Копирано.', 'ok');
  }
}
window.remCopy = remCopy;

/* ---------------- Авторитетни данни: преглед и сливане на дубликати ---------------- */
let AUTH_FIELD = 'author';
let AUTH_LOOSE = false;
async function renderAuth() {
  const [fields, groups, values] = await Promise.all([
    call(window.api.authorities.fields()),
    call(window.api.authorities.duplicates({ field: AUTH_FIELD, loose: AUTH_LOOSE })),
    call(window.api.authorities.list(AUTH_FIELD))
  ]);
  const f = fields || {};
  const total = (values || []).length;
  const dupes = groups || [];
  const affected = dupes.reduce((n, g) => n + g.total, 0);
  $('#view').innerHTML = `
    <div class="note"><b>Едно и също име, въведено по няколко начина, разпилява записите.</b>
    „Вазов, Иван“, „Иван Вазов“ и „И. Вазов“ са един автор, но за програмата са три различни
    стойности — търсенето по единия вариант не намира документите, описани с другите.
    Тук те се откриват и сливат в един вид.</div>

    <div class="card">
      <div class="grid g3">
        ${fld('Поле', 'authField', { type: 'select', allowEmpty: false, val: AUTH_FIELD,
          opts: Object.entries(f).map(([v, t]) => ({ v, t: t[0].toUpperCase() + t.slice(1) })) })}
        <div class="field"><label>Как се търсят дубликати</label>
          <select name="authLoose">
            <option value="0" ${!AUTH_LOOSE ? 'selected' : ''}>Разместени думи („Вазов, Иван“ = „Иван Вазов“)</option>
            <option value="1" ${AUTH_LOOSE ? 'selected' : ''}>И съкратени имена („И. Вазов“ = „Иван Вазов“)</option>
          </select>
        </div>
        <div class="field"><label>&nbsp;</label>
          <button class="btn pri" onclick="authApply()" style="width:100%">Покажи</button></div>
      </div>
      <div class="hint">Различни стойности в полето: <b>${total}</b> ·
      възможни дублети: <b>${dupes.length}</b> ${dupes.length ? `групи, засягащи <b>${affected}</b> документа` : ''}</div>
    </div>

    ${dupes.length ? `
      <div class="hint" style="margin:14px 0 8px">Отбележете кой вид да остане и натиснете „Слей“.
      Останалите стойности в групата се заменят с него във всички документи.</div>
      ${dupes.map((g, i) => authGroupHtml(g, i)).join('')}
    ` : `<div class="card" style="margin-top:16px"><div class="empty">
        Няма открити дублети по този критерий.
        ${!AUTH_LOOSE ? 'Опитайте и с „И съкратени имена“ — той хваща и „И. Вазов“.' : ''}
      </div></div>`}

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Всички стойности в полето</h3>
      <div class="hint" style="margin-top:0">Подредени по брой документи. Този списък се предлага
      за автодовършване при въвеждане на нова книга.</div>
      <table class="ledger" style="margin-top:8px"><thead><tr><th>Стойност</th><th style="width:120px">Документи</th></tr></thead>
        <tbody>${(values || []).slice(0, 300).map(v => `<tr>
          <td>${esc(v.value)}</td><td class="num">${v.n}</td></tr>`).join('')}</tbody></table>
      ${total > 300 ? `<div class="hint">Показани са първите 300 от ${total}.</div>` : ''}
    </div>`;
}
function authGroupHtml(g, i) {
  return `<div class="authGroup" id="ag${i}">
    ${g.items.map((it, j) => `<label class="authRow">
      <input type="radio" name="ag${i}sel" value="${esc(it.value)}" ${j === 0 ? 'checked' : ''}>
      <span class="authVal">${esc(it.value)}</span>
      <span class="authN">${it.n} док.</span>
      <span class="authTarget">${j === 0 ? 'предложено' : ''}</span>
    </label>`).join('')}
    <div class="toolbar" style="margin-top:8px">
      <button class="btn pri" onclick="authMerge(${i})">Слей в отбелязаното</button>
      <span class="hint">общо ${g.total} документа в тази група</span>
    </div>
  </div>`;
}
function authApply() {
  AUTH_FIELD = $('[name=authField]').value;
  AUTH_LOOSE = $('[name=authLoose]').value === '1';
  renderAuth();
}
window.authApply = authApply;
async function authMerge(i) {
  const box = $('#ag' + i);
  const target = box.querySelector(`input[name=ag${i}sel]:checked`);
  if (!target) return toast('Отбележете коя стойност да остане.', 'err');
  const all = [...box.querySelectorAll(`input[name=ag${i}sel]`)].map(x => x.value);
  const from = all.filter(v => v !== target.value);
  if (!from.length) return toast('Няма какво да се слее.', 'err');
  if (!confirm(`Сливане на ${from.length} стойности в „${target.value}“?\n\n` +
    from.map(v => '• ' + v).join('\n') + '\n\nПромяната засяга всички документи с тези стойности.')) return;
  const r = await call(window.api.authorities.merge({ field: AUTH_FIELD, from, to: target.value }),
    null);
  if (!r) return;
  toast(`Слети ${r.merged} стойности в „${target.value}“ — променени ${r.changed} документа.`, 'ok');
  markSaved();
  AUTH_SUGGEST = null; // списъкът за автодовършване вече е различен
  renderAuth();
}
window.authMerge = authMerge;

/* ---------------- Избор на УДК от таблицата ----------------
   Прозорецът се отваря върху формата за книга. Изборът замества стойността в
   полето, а определителите се добавят накрая — полето остава свободен текст, за
   да не пречи на съставни кодове, каквито таблицата не покрива. */
function udkPicker() {
  const rows = UDK_TREE.map(([code, name, subs]) => `
    <div class="udkGroup">
      <div class="udkMain">${esc(code)} — ${esc(name)}</div>
      <div class="udkSubs">
        ${subs.map(([c, t]) => `<button type="button" class="udkItem" onclick="udkPick('${esc(c)}')">
          <span class="udkCode">${esc(c)}</span><span class="udkLbl">${esc(t)}</span></button>`).join('')}
      </div>
    </div>`).join('');
  modal2('Универсална десетична класификация (УДК)', `
    <div class="note" style="margin-top:0">Изберете раздел — кодът влиза в полето „УДК“.
    Определителите по-долу се добавят към вече избрания код.</div>
    <input class="udkSearch" id="udkQ" placeholder="Търсене по код или наименование…" oninput="udkFilter()">
    <div id="udkList">${rows}</div>
    <div class="udkGroup" style="margin-top:12px">
      <div class="udkMain">Общи определители (добавят се накрая)</div>
      <div class="udkSubs">
        ${UDK_MODIFIERS.map(([c, t]) => `<button type="button" class="udkItem" onclick="udkAppend('${esc(c)}')">
          <span class="udkCode">${esc(c)}</span><span class="udkLbl">${esc(t)}</span></button>`).join('')}
      </div>
    </div>`,
    `<button class="btn" onclick="closeModal2()">Затвори</button>`);
  setTimeout(() => { const q = $('#udkQ'); if (q) q.focus(); }, 50);
}
window.udkPicker = udkPicker;
function udkFilter() {
  const q = ($('#udkQ').value || '').trim().toLowerCase();
  document.querySelectorAll('#udkList .udkGroup').forEach(g => {
    let shown = 0;
    g.querySelectorAll('.udkItem').forEach(it => {
      const hit = !q || it.textContent.toLowerCase().includes(q);
      it.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    g.style.display = shown ? '' : 'none';
  });
}
window.udkFilter = udkFilter;
function udkTargetInput() { return $('#bookF [name=udk]'); }
function udkPick(code) {
  const el = udkTargetInput();
  if (el) { el.value = code; toast('УДК ' + code, 'ok'); }
  closeModal2();
}
window.udkPick = udkPick;
function udkAppend(mod) {
  const el = udkTargetInput();
  if (!el) return;
  el.value = (el.value || '').trim() + mod;
  toast('УДК ' + el.value, 'ok');
  closeModal2();
}
window.udkAppend = udkAppend;

/* Търсене по ISBN в Google Books и Open Library. Попълват се само празните полета —
   вече въведеното от библиотекаря никога не се презаписва, защото данните от двете
   услуги не винаги са точни и описанието по Наредба № 3 е негова отговорност. */
async function isbnLookup() {
  const f = $('#bookF'); if (!f) return;
  const btn = $('#isbnBtn'), hint = $('#isbnHint');
  const isbn = (f.querySelector('[name=isbn]') || {}).value || '';
  if (!isbn.trim()) return toast('Първо въведете ISBN.', 'err');
  btn.disabled = true; btn.textContent = 'Търси…';
  hint.textContent = 'Търси в Google Books и Open Library…';
  try {
    const r = await window.api.isbn.lookup(isbn);
    if (!r || !r.ok) {
      hint.textContent = (r && r.error) || 'Търсенето не успя.';
      return toast((r && r.error) || 'Търсенето не успя.', 'err');
    }
    const filled = [], skipped = [];
    const LABELS = { title: 'Заглавие', subtitle: 'Подзаглавие', author: 'Автор', publisher: 'Издателство',
      city: 'Място на издаване', year: 'Година', pages: 'Страници', language: 'Език',
      keywords: 'Ключови думи', annotation: 'Анотация', cover_url: 'Корица', isbn: 'ISBN' };
    for (const [k, val] of Object.entries(r.data)) {
      if (k === 'sources' || !val) continue;
      const el = f.querySelector(`[name="${k}"]`);
      if (!el) continue;
      if (el.value && el.value.trim()) { if (k !== 'isbn') skipped.push(LABELS[k] || k); continue; }
      el.value = val;
      if (k !== 'isbn') filled.push(LABELS[k] || k);
    }
    hint.textContent = filled.length
      ? `Попълнено от ${r.data.sources}: ${filled.join(', ')}.` +
        (skipped.length ? ` Запазени непроменени: ${skipped.join(', ')}.` : '')
      : `Намерено в ${r.data.sources}, но всички полета вече са попълнени.`;
    toast(filled.length ? `Попълнени ${filled.length} полета от ${r.data.sources}.`
                        : 'Полетата вече са попълнени.', 'ok');
  } catch (e) {
    hint.textContent = 'Няма връзка с интернет или услугата не отговаря.';
    toast('Няма връзка с интернет или услугата не отговаря.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Търси';
  }
}
window.isbnLookup = isbnLookup;

async function saveBook(id) {
  const d = formData('#bookF');
  if (!d.title.trim()) return toast('Заглавието е задължително.', 'err');
  if (!d.inv_number) return toast('Инвентарният номер е задължителен.', 'err');
  d.id = id;
  if (id) await call(window.api.books.update(d), 'Книгата е обновена.');
  else await call(window.api.books.create(d), 'Книгата е добавена.');
  closeModal(); RENDERERS[VIEW]();
}
window.saveBook = saveBook;
async function deleteBook(id) {
  if (!confirm('Да изтрия ли тази книга?')) return;
  const res = await window.api.books.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  toast('Книгата е изтрита.', 'ok'); markSaved();
  RENDERERS[VIEW]();
}
window.deleteBook = deleteBook;

/* ---------------- Инвентарна книга ---------------- */
async function renderInvBook() {
  const rows = await call(window.api.invBook.list());
  if (!rows) return;
  const active = rows.filter(r => r.status !== 'отчислен');
  const deacc = rows.length - active.length;
  const value = active.reduce((s, r) => s + (r.price || 0), 0);
  const checked = rows.filter(r => (r.checks || []).length).length;
  $('#view').innerHTML = `
    <div class="note"><b>Приложение № 4 към чл. 16, ал. 1</b> — колоните следват образеца от Наредба № 3.
    Книгата се съхранява безсрочно (чл. 26, ал. 1). Отчислените документи се отбелязват, но не се заличават (чл. 39).</div>

    <div class="kpis" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi-ico">📗</div><div class="kpi-body">
        <div class="kpi-num">${rows.length.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Вписани общо</div>
        <div class="kpi-extra">от началото на книгата</div></div></div>
      <div class="kpi ok"><div class="kpi-ico">✅</div><div class="kpi-body">
        <div class="kpi-num">${active.length.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Налични</div><div class="kpi-extra">${mny(value)}</div></div></div>
      <div class="kpi ${deacc ? 'warn' : ''}"><div class="kpi-ico">📕</div><div class="kpi-body">
        <div class="kpi-num">${deacc.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Отчислени</div>
        <div class="kpi-extra">${rows.length ? Math.round(deacc / rows.length * 100) : 0}% от вписаните</div></div></div>
      <div class="kpi"><div class="kpi-ico">🔍</div><div class="kpi-body">
        <div class="kpi-num">${checked.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">С отбелязана проверка</div>
        <div class="kpi-extra">чл. 40 – 41</div></div></div>
    </div>

    <div class="toolbar">
      <input type="search" id="ibSearch" placeholder="Търсене по инв. №, автор, заглавие или сигнатура…"
        value="${esc(INVBOOK_QUERY)}" oninput="invBookFilter(this.value)">
      <button class="btn pri" onclick="bookForm()">+ Нов документ</button>
      <button class="btn" onclick="printInvBookDoc()">Печат на инвентарната книга / PDF</button>
    </div>
    <div class="wrap"><table class="ledger ibTable">
      <thead><tr><th>Дата</th><th>Инв. №</th><th>Проверки</th><th>Автор и заглавие</th><th>Год.</th><th>Цена</th>
        <th>№/дата в КДБФ</th><th>Сигнатура</th><th>№/дата на акт</th><th>Състояние</th></tr></thead>
      <tbody id="ibBody">${invBookRowsHtml(rows)}</tbody>
    </table></div>`;
  window._INVBOOK_ROWS = rows;
}
let INVBOOK_QUERY = '';
function invBookRowsHtml(rows) {
  if (!rows.length) return `<tr><td colspan="10" class="empty">Инвентарната книга е празна.</td></tr>`;
  return rows.map(r => {
    const off = r.status === 'отчислен';
    return `<tr class="${off ? 'ibOff' : ''}">
      <td class="num">${bg(r.register_date)}</td>
      <td class="num"><b>${r.inv_number ?? ''}</b></td>
      <td style="font-size:11px">${(r.checks || []).map(c => `<span class="badge ok" style="font-size:10px">${bg(c)}</span>`).join(' ')}</td>
      <td>${esc([r.author, r.title].filter(Boolean).join('. '))}${r.volume ? ', т. ' + esc(r.volume) : ''}</td>
      <td class="num">${esc(r.year || '')}</td><td class="num">${mny(r.price)}</td>
      <td class="num" style="font-size:11px">${r.acq_no ? '№ ' + r.acq_no + '<br>' + bg(r.acq_date) : ''}</td>
      <td class="num">${esc(r.call_number || '')}</td>
      <td class="num" style="font-size:11px">${r.act_no ? '№ ' + r.act_no + '<br>' + bg(r.act_date) : ''}</td>
      <td>${off ? '<span class="badge warn">отчислен</span>' : '<span class="badge ok">наличен</span>'}</td>
    </tr>`;
  }).join('');
}
function invBookFilter(q) {
  INVBOOK_QUERY = q;
  const t = q.trim().toLowerCase();
  const all = window._INVBOOK_ROWS || [];
  const rows = !t ? all : all.filter(r =>
    String(r.inv_number ?? '').includes(t) ||
    (r.author || '').toLowerCase().includes(t) ||
    (r.title || '').toLowerCase().includes(t) ||
    (r.call_number || '').toLowerCase().includes(t));
  const body = $('#ibBody');
  if (body) body.innerHTML = rows.length ? invBookRowsHtml(rows)
    : `<tr><td colspan="10" class="empty">Няма съвпадения за „${esc(q)}“.</td></tr>`;
}
window.invBookFilter = invBookFilter;
function printInvBookDoc() {
  const rows = window._INVBOOK_ROWS || [];
  setPrintPage({ name: `Инвентарна книга — ${bg(today())}`, landscape: true, margin: '10mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ИНВЕНТАРНА КНИГА</h2>
    <div class="pmeta">Приложение № 4 към чл. 16, ал. 1 от Наредба № 3 от 18.11.2014 г.<br>
    Разпечатано на ${bg(today())} · записи: ${rows.length}</div>
    <table><thead><tr><th>Дата</th><th>Инв. №</th><th>Проверки</th><th>Автор и заглавие</th><th>Год.</th><th>Цена</th>
    <th>№/дата в КДБФ</th><th>Сигнатура</th><th>№/дата на акт</th><th>Забележка</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${bg(r.register_date)}</td><td>${r.inv_number ?? ''}</td>
      <td>${(r.checks || []).map(c => bg(c)).join(' ')}</td>
      <td>${esc([r.author, r.title].filter(Boolean).join('. '))}${r.volume ? ', т. ' + esc(r.volume) : ''}</td>
      <td>${esc(r.year || '')}</td><td>${mny(r.price)}</td>
      <td>${r.acq_no ? '№ ' + r.acq_no + ' / ' + bg(r.acq_date) : ''}</td><td>${esc(r.call_number || '')}</td>
      <td>${r.act_no ? '№ ' + r.act_no + ' / ' + bg(r.act_date) : ''}</td><td>${esc(r.description || '')}</td></tr>`).join('')}
    </tbody></table>
    <div class="pmeta">Настоящата разпечатка съдържа ${rows.length} записа. Листовете се прошнуроват, номерират, подпечатват и
    заверяват с подписа на ръководителя (чл. 26, ал. 2).</div>
    ${ssig(['Библиотекар: ' + esc((SETTINGS_CACHE || {}).librarian || '…………………'), esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': ' + esc((SETTINGS_CACHE || {}).director || '…………………')])}</div>`);
}
window.printInvBookDoc = printInvBookDoc;

/* ---------------- КДБФ ---------------- */
let KDBF_TAB = 'p1', KDBF_YEAR = null;
async function renderKdbf() {
  const y = KDBF_YEAR || yr();
  const r = await call(window.api.kdbf.report(y));
  if (!r) return;
  const years = [...new Set([y, yr()])];
  const razbivka = (rows, key) => {
    const m = {}; rows.forEach(x => { const k = x[key] || '—'; m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).map(([k, v]) => `${esc(k)}: ${v}`).join(', ');
  };
  window._KDBF_REPORT = r;
  $('#view').innerHTML = `
    <div class="toolbar">
      <div class="tabs" style="display:flex;gap:6px">
        <button class="btn sm ${KDBF_TAB === 'p1' ? 'pri' : ''}" onclick="KDBF_TAB='p1';renderKdbf()">Част № 1 · Постъпили</button>
        <button class="btn sm ${KDBF_TAB === 'p2' ? 'pri' : ''}" onclick="KDBF_TAB='p2';renderKdbf()">Част № 2 · Резултати</button>
        <button class="btn sm ${KDBF_TAB === 'p3' ? 'pri' : ''}" onclick="KDBF_TAB='p3';renderKdbf()">Част № 3 · Отчислени</button>
      </div>
      <select onchange="KDBF_YEAR=this.value;renderKdbf()">${years.map(x => `<option ${x === y ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <button class="btn" onclick="printKdbfDoc()">Печат / PDF</button>
    </div>
    ${KDBF_TAB === 'p1' ? `
      <div class="note"><b>Приложение № 1 към чл. 13, ал. 3, т. 1</b> — постъпили книги и материали за ${y} г.</div>
      <div class="wrap"><table class="ledger"><thead><tr><th>Дата</th><th>№</th><th>Откъде</th><th>Документ</th>
        <th>Общо</th><th>Инвентирани</th><th>Стойност</th><th>Инв. № от–до</th><th>По вид</th></tr></thead><tbody>
      ${r.part1.length ? r.part1.map(a => `<tr><td class="num">${bg(a.date)}</td><td class="num">${a.no}</td>
        <td>${esc(a.from_source || '')}<div class="hint">${esc(a.how || '')}</div></td>
        <td style="font-size:12px">${esc(a.doc_type || '')} № ${esc(a.doc_no || '')}<br>${bg(a.doc_date)}</td>
        <td class="num">${a.total_count}</td><td class="num">${a.registered_count}</td><td class="num">${mny(a.registered_value)}</td>
        <td class="num">${a.inv_from ? a.inv_from + ' – ' + a.inv_to : '—'}</td><td></td></tr>`).join('')
        : `<tr><td colspan="9" class="empty">Няма постъпления за ${y} г.</td></tr>`}
      </tbody></table></div>`
    : KDBF_TAB === 'p3' ? `
      <div class="note"><b>Приложение № 3 към чл. 13, ал. 3, т. 3</b> — отчислени документи за ${y} г.</div>
      <div class="wrap"><table class="ledger"><thead><tr><th>Дата</th><th>Акт №</th><th>Причина</th>
        <th>Общо</th><th>Стойност</th></tr></thead><tbody>
      ${r.part3.length ? r.part3.map(a => `<tr><td class="num">${bg(a.date)}</td><td class="num">${a.no}</td>
        <td>${esc(a.reason_text || '')}</td><td class="num">${a.item_count}</td><td class="num">${mny(a.item_value)}</td></tr>`).join('')
        : `<tr><td colspan="5" class="empty">Няма отчисления за ${y} г.</td></tr>`}
      </tbody></table></div>`
    : `
      <div class="note"><b>Приложение № 2 към чл. 13, ал. 3, т. 2</b> — резултати от движението на фонда към 31.12.${y} г.</div>
      ${kdbfPart2Html(r, y)}`}
  `;
}

/* Част № 2 като поток на движението: начално салдо + постъпили − отчислени = крайно салдо.
   Началното салдо не идва от заявка — извежда се от крайното, за да съвпада винаги с него. */
function kdbfPart2Html(r, y) {
  const endN = r.stockEnd.n, endV = r.stockEnd.v;
  const accN = r.acquiredYear.n, accV = r.acquiredYear.v;
  const decN = r.deaccYear.n, decV = r.deaccYear.v;
  const startN = endN - accN + decN, startV = endV - accV + decV;
  const netN = accN - decN;
  const growth = startN ? Math.round(netN / startN * 1000) / 10 : 0;
  return `
    <div class="flow" style="margin-bottom:16px">
      <div class="flowBox">
        <div class="fv">${startN.toLocaleString('bg-BG')}</div>
        <div class="fl">Наличност 01.01.${y}</div><div class="fm">${mny(startV)}</div></div>
      <div class="flowOp">+</div>
      <div class="flowBox plus">
        <div class="fv">${accN.toLocaleString('bg-BG')}</div>
        <div class="fl">Постъпили през ${y}</div><div class="fm">${mny(accV)}</div></div>
      <div class="flowOp">−</div>
      <div class="flowBox minus">
        <div class="fv">${decN.toLocaleString('bg-BG')}</div>
        <div class="fl">Отчислени през ${y}</div><div class="fm">${mny(decV)}</div></div>
      <div class="flowOp">=</div>
      <div class="flowBox strong">
        <div class="fv">${endN.toLocaleString('bg-BG')}</div>
        <div class="fl">Наличност 31.12.${y}</div><div class="fm">${mny(endV)}</div></div>
    </div>

    <div class="grid g2">
      <div class="card"><h3 style="margin-top:0">Обобщение за ${y} г.</h3>
        <div class="statRows">
          <div><span>Чист прираст на фонда</span><b style="color:${netN >= 0 ? 'var(--green)' : 'var(--red)'}">
            ${netN >= 0 ? '+' : ''}${netN.toLocaleString('bg-BG')} документа</b></div>
          <div><span>Изменение на стойността</span><b style="color:${accV - decV >= 0 ? 'var(--green)' : 'var(--red)'}">
            ${accV - decV >= 0 ? '+' : '−'}${mny(Math.abs(accV - decV))}</b></div>
          <div><span>Ръст спрямо началото на годината</span><b>${netN >= 0 ? '+' : ''}${growth}%</b></div>
          <div><span>Средна цена на документ</span><b>${mny(endN ? endV / endN : 0)}</b></div>
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">Съотношение постъпили / отчислени</h3>
        ${(accN + decN) ? `
          <div class="chartRow">
            <div class="cr-top"><span class="cr-k">Постъпили</span><span class="cr-v"><b>${accN}</b></span></div>
            <div class="chartTrack"><div class="chartFill g" style="width:${Math.max(2, accN / Math.max(accN, decN) * 100)}%"></div></div>
          </div>
          <div class="chartRow">
            <div class="cr-top"><span class="cr-k">Отчислени</span><span class="cr-v"><b>${decN}</b></span></div>
            <div class="chartTrack"><div class="chartFill r" style="width:${Math.max(2, decN / Math.max(accN, decN) * 100)}%"></div></div>
          </div>
          <div class="hint" style="margin-top:10px">${netN >= 0
            ? 'Фондът нараства — постъпленията надвишават отчисленията.'
            : 'Фондът намалява — отчисленията надвишават постъпленията.'}</div>`
        : '<span class="hint">Няма движение през тази година.</span>'}
      </div>
    </div>`;
}
function printKdbfDoc() {
  const r = window._KDBF_REPORT; if (!r) return;
  const y = r.year;
  setPrintPage({ name: `КДБФ ${y} г.`, landscape: true, margin: '10mm' });
  doPrint(`
    <div class="pdoc">${shead()}<h2>КНИГА ЗА ДВИЖЕНИЕ НА БИБЛИОТЕЧНИЯ ФОНД</h2>
     <div class="pmeta"><b>Част № 1. Регистриране на постъпили книги, периодични издания и други материали</b><br>
     Приложение № 1 към чл. 13, ал. 3, т. 1 · ${y} г.</div>
     <table><thead><tr><th>Дата</th><th>№</th><th>Откъде и как</th><th>Вид, № и дата на документа</th><th>Общо</th>
     <th>Инвентирани</th><th>Стойност</th><th>Инв. № от – до</th></tr></thead><tbody>
     ${r.part1.map(a => `<tr><td>${bg(a.date)}</td><td>${a.no}</td><td>${esc(a.from_source || '')} / ${esc(a.how || '')}</td>
     <td>${esc(a.doc_type || '')} № ${esc(a.doc_no || '')} / ${bg(a.doc_date)}</td><td>${a.total_count}</td><td>${a.registered_count}</td>
     <td>${mny(a.registered_value)}</td><td>${a.inv_from ? a.inv_from + '–' + a.inv_to : ''}</td></tr>`).join('')}
     </tbody></table>${ssig(['Библиотекар: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>

    <div class="pdoc">${shead()}<h2>КНИГА ЗА ДВИЖЕНИЕ НА БИБЛИОТЕЧНИЯ ФОНД</h2>
     <div class="pmeta"><b>Част № 3. Регистриране на отчислените книги, периодични издания и други материали</b><br>
     Приложение № 3 към чл. 13, ал. 3, т. 3 · ${y} г.</div>
     <table><thead><tr><th>Дата</th><th>№</th><th>Акт № / дата</th><th>Общо</th><th>Стойност</th><th>Причина</th></tr></thead><tbody>
     ${r.part3.map(a => `<tr><td>${bg(a.date)}</td><td>${a.no}</td><td>№ ${a.no} / ${bg(a.date)}</td>
     <td>${a.item_count}</td><td>${mny(a.item_value)}</td><td>${esc(a.reason_text || '')}</td></tr>`).join('')}
     </tbody></table>${ssig(['Библиотекар: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>

    <div class="pdoc">${shead()}<h2>РЕЗУЛТАТИ ОТ ДВИЖЕНИЕТО НА БИБЛИОТЕЧНИЯ ФОНД</h2>
     <div class="pmeta"><b>Част № 2</b> · Приложение № 2 към чл. 13, ал. 3, т. 2 · към 31.12.${y} г.</div>
     <table><thead><tr><th>Показател</th><th>Брой</th><th>Стойност, лв.</th></tr></thead><tbody>
     <tr><td>Наличност към 31.12.${y} г.</td><td>${r.stockEnd.n}</td><td>${mny(r.stockEnd.v)}</td></tr>
     <tr><td>Постъпили през ${y} г.</td><td>${r.acquiredYear.n}</td><td>${mny(r.acquiredYear.v)}</td></tr>
     <tr><td>Отчислени през ${y} г.</td><td>${r.deaccYear.n}</td><td>${mny(r.deaccYear.v)}</td></tr>
     </tbody></table>${ssig(['Библиотекар: …………………', 'Счетоводител: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printKdbfDoc = printKdbfDoc;

/* ---------------- Постъпления ---------------- */
async function renderAcq() {
  const rows = await call(window.api.acquisitions.list());
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note"><b>Чл. 3 – 14</b> — документите постъпват чрез закупуване, депозит, обмен или дарение,
    винаги с първичен счетоводен документ.</div>
    <div class="toolbar"><button class="btn pri" onclick="acqForm()">+ Нова партида</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>№/год.</th><th>Дата</th><th>Откъде</th><th>Как</th>
      <th>Документ</th><th>Брой</th><th>Инвентирани</th><th>Стойност</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(a => `<tr><td class="num">${a.no} / ${a.year}</td><td class="num">${bg(a.date)}</td>
      <td>${esc(a.from_source || '')}</td><td>${esc(a.how || '')}</td>
      <td style="font-size:12px">${esc(a.doc_type || '')} № ${esc(a.doc_no || '')}</td>
      <td class="num">${a.total_count}</td><td class="num">${a.registered_count}</td><td class="num">${mny(a.registered_value)}</td>
      <td><button class="btn sm" onclick="openAcq(${a.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="9" class="empty">Няма заведени партиди.</td></tr>`}
    </tbody></table></div>`;
}
async function acqForm() {
  const y = yr();
  const no = await call(window.api.acquisitions.nextNo(y));
  modal('Нова партида — обща регистрация', `
    <div class="note"><b>Чл. 14, ал. 2</b> — вписват се: дата и номер, откъде и как са постъпили, вид/номер/дата на
    първичния документ, общ брой документи.</div>
    <form id="acqF" onsubmit="return false">
      <div class="grid g4">
        ${fld('№ на вписване', 'no', { val: no, req: 1 })}
        ${fld('Дата на вписване', 'date', { val: today(), type: 'date', req: 1 })}
        ${fld('Начин на постъпване', 'how', { type: 'select', opts: NACHINI, val: NACHINI[0] })}
        ${fld('Общ брой документи', 'total_count', { val: '', type: 'number', req: 1 })}
      </div>
      ${fld('Откъде (доставчик / дарител)', 'from_source', { req: 1 })}
      <div class="grid g3">
        ${fld('Вид първичен документ', 'doc_type', { type: 'select', opts: PARV_DOK })}
        ${fld('Номер на документа', 'doc_no', {})}
        ${fld('Дата на документа', 'doc_date', { val: today(), type: 'date' })}
      </div>
      <div class="grid g2">
        ${fld('Обща стойност по документа (лв.)', 'sum', { type: 'number', step: '0.01' })}
        ${fld('Адрес на дарителя', 'donor_address', { hint: 'задължително при дарение — чл. 6, ал. 5' })}
      </div>
      ${fld('Забележка', 'note', { type: 'textarea', rows: 2 })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveAcq()">Заведи партидата</button>`);
}
window.acqForm = acqForm;
async function saveAcq() {
  const d = formData('#acqF');
  if (!d.from_source.trim() || !d.total_count) return toast('Попълнете откъде постъпват документите и общия им брой.', 'err');
  const id = await call(window.api.acquisitions.create(d), 'Партидата е заведена в КДБФ част 1.');
  if (id) { closeModal(); renderAcq(); }
}
window.saveAcq = saveAcq;
async function openAcq(id) {
  const a = await call(window.api.acquisitions.get(id));
  if (!a) return;
  modal('Партида № ' + a.no + ' / ' + a.year, `
    <div class="cards">
      <div class="card"><div class="num">${a.total_count}</div><div class="lbl">Общо по документ</div></div>
      <div class="card"><div class="num">${a.items.length}</div><div class="lbl">Инвентирани</div></div>
      <div class="card"><div class="num">${Math.max(0, a.total_count - a.items.length)}</div><div class="lbl">Остават</div></div>
    </div>
    <div class="hint" style="margin-bottom:10px">${esc(a.how || '')} · ${esc(a.from_source || '')} ·
      ${esc(a.doc_type || '')} № ${esc(a.doc_no || '')} от ${bg(a.doc_date)}${a.note ? ' · ' + esc(a.note) : ''}</div>
    ${a.items.length ? `<div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор и заглавие</th><th>Год.</th><th>Цена</th></tr></thead><tbody>
      ${a.items.map(i => `<tr><td class="num">${i.inv_number}</td><td>${esc([i.author, i.title].filter(Boolean).join('. '))}</td>
      <td class="num">${esc(i.year || '')}</td><td class="num">${mny(i.price)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="hint">Все още няма инвентирани документи по тази партида.</div>'}`,
    `<button class="btn l dgr" onclick="delAcq(${id})">Изтрий</button>
     ${a.how === 'дарение' ? `<button class="btn l" onclick="printDonationDoc(${id})">Акт за дарение / PDF</button>` : ''}
     ${a.doc_type && a.doc_type.indexOf('без документ') > -1 ? `<button class="btn l" onclick="printAcqNoDocDoc(${id})">Протокол за придобиване / PDF</button>` : ''}
     <button class="btn" onclick="closeModal();bookForm(null, ${id})">+ Инвентирай документ</button>
     <button class="btn pri" onclick="closeModal()">Затвори</button>`);
}
window.openAcq = openAcq;
async function printDonationDoc(id) {
  const a = await call(window.api.acquisitions.get(id));
  if (!a) return;
  const s = SETTINGS_CACHE || {};
  setPrintPage({ name: `Акт за дарение № ${a.no}-${a.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>АКТ № ${a.no} / ${bg(a.date)}<br><span style="font-size:12pt">за приемане на дарение на библиотечни документи</span></h2>
    <div class="pmeta">На основание чл. 6 от Наредба № 3 от 18.11.2014 г. комисия в състав
    ${[s.committee1, s.committee2, s.committee3].filter(Boolean).map(esc).join(', ') || '…………………'} прие дарение от:<br>
    <b>Дарител:</b> ${esc(a.from_source || '')}<br><b>Адрес:</b> ${esc(a.donor_address || '…………………')}<br>
    <b>Общ брой документи:</b> ${a.total_count} &nbsp; <b>Обща стойност:</b> ${mny(a.sum || a.items.reduce((x, i) => x + (Number(i.price) || 0), 0))}<br>
    <b>Основание за придобиване:</b> дарение</div>
    ${a.items.length ? `<table><thead><tr><th>№</th><th>Инв. №</th><th>Автор и заглавие</th><th>Година</th><th>Стойност, лв.</th></tr></thead><tbody>
    ${a.items.map((i, n) => `<tr><td>${n + 1}</td><td>${i.inv_number}</td><td>${esc([i.author, i.title].filter(Boolean).join('. '))}</td><td>${esc(i.year || '')}</td><td>${mny(i.price)}</td></tr>`).join('')}
    </tbody></table>` : ''}
    <div class="pmeta">Актът е съставен в три екземпляра — за счетоводството, за библиотеката и за дарителя.</div>
    ${ssig(['Дарител: …………………', 'Комисия: …………………', 'УТВЪРДИЛ: …………………'])}</div>`);
}
window.printDonationDoc = printDonationDoc;
async function printAcqNoDocDoc(id) {
  const a = await call(window.api.acquisitions.get(id));
  if (!a) return;
  const s = SETTINGS_CACHE || {};
  const total = a.sum || a.items.reduce((x, i) => x + (Number(i.price) || 0), 0);
  setPrintPage({ name: `Протокол за придобиване № ${a.no}-${a.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ПРОТОКОЛ № ${a.no} / ${bg(a.date)}<br><span style="font-size:12pt">за придобиване на библиотечни документи без съпроводителен документ</span></h2>
    <div class="pmeta">Днес, ${bg(a.date)} г., комисия в състав ${[s.committee1, s.committee2, s.committee3].filter(Boolean).map(esc).join(', ') || '…………………'},
    установи наличието в библиотеката на посочените по-долу документи, за които <b>липсва</b> първичен счетоводен документ по чл. 3, ал. 2
    от Наредба № 3 от 18.11.2014 г. Комисията извърши експертна оценка на стойността им, за да послужи настоящият протокол като основание
    за редовно вписване в Книгата за движение на библиотечния фонд и в инвентарната книга.<br>
    <b>Начин на постъпване:</b> ${esc(a.how || '')} &nbsp; <b>Откъде/от кого:</b> ${esc(a.from_source || '')}<br>
    <b>Общ брой документи:</b> ${a.total_count} &nbsp; <b>Обща оценена стойност:</b> ${mny(total)}
    ${a.note ? '<br><b>Забележка:</b> ' + esc(a.note) : ''}</div>
    ${a.items.length ? `<table><thead><tr><th>№</th><th>Инв. №</th><th>Автор и заглавие</th><th>Година</th><th>Оценена стойност</th></tr></thead><tbody>
    ${a.items.map((i, n) => `<tr><td>${n + 1}</td><td>${i.inv_number}</td><td>${esc([i.author, i.title].filter(Boolean).join('. '))}</td><td>${esc(i.year || '')}</td><td>${mny(i.price)}</td></tr>`).join('')}
    <tr><td colspan="4"><b>ОБЩО</b></td><td><b>${mny(total)}</b></td></tr></tbody></table>`
    : '<div class="pmeta">Все още няма инвентирани документи по тази партида.</div>'}
    <div class="pmeta">Протоколът се съставя в два екземпляра и се прилага към Книгата за движение на библиотечния фонд,
    част № 1, като заместващ първичен документ.</div>
    ${ssig(['Комисия: 1. ………… 2. ………… 3. …………', 'УТВЪРДИЛ, ' + esc(s.director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printAcqNoDocDoc = printAcqNoDocDoc;
async function delAcq(id) {
  if (!confirm('Изтриване на партидата?')) return;
  const res = await window.api.acquisitions.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderAcq(); toast('Партидата е изтрита.', 'ok'); markSaved();
}
window.delAcq = delAcq;

/* ---------------- Отчисляване ---------------- */
async function renderActs() {
  const rows = await call(window.api.deaccessionActs.list());
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note d"><b>Чл. 35</b> — отчисляването се извършва от комисия. В един акт се вписват документи,
    отчислени само по една причина (чл. 30).</div>
    <div class="toolbar"><button class="btn pri" onclick="actForm()">+ Нов акт за отчисляване</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Акт №</th><th>Дата</th><th>Причина</th>
      <th>Брой</th><th>Стойност</th><th>Начин</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(a => `<tr><td class="num">${a.no} / ${a.year}</td><td class="num">${bg(a.date)}</td>
      <td>т. ${a.reason_code}. ${esc(a.reason_text)}</td><td class="num">${a.item_count}</td>
      <td class="num">${mny(a.item_value)}</td><td style="font-size:12px">${esc(a.disposal || '')}</td>
      <td><button class="btn sm" onclick="openAct(${a.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="7" class="empty">Няма съставени актове.</td></tr>`}
    </tbody></table></div>`;
}
let ACT_LIST = [];
async function actForm() {
  ACT_LIST = [];
  const y = yr();
  const no = await call(window.api.deaccessionActs.nextNo(y));
  const s = await call(window.api.settings.get());
  modal('Акт за отчисляване на библиотечни документи', `
    <form id="actF" onsubmit="return false">
      <div class="grid g3">
        ${fld('Акт №', 'no', { val: no, req: 1 })}
        ${fld('Дата', 'date', { val: today(), type: 'date', req: 1 })}
        ${fld('Заповед №', 'order_no', {})}
      </div>
      ${fld('Причина за отчисляване', 'reason_code', { type: 'select', opts: PRICHINI.map(p => ({ v: p.k, t: 'т. ' + p.k + '. ' + p.t })) })}
      <div class="grid g2">
        ${fld('Начин на разпореждане', 'disposal', { type: 'select', opts: ['предадени за вторични суровини', 'продадени', 'предоставени безвъзмездно на друга библиотека', 'предоставени на организация в обществена полза', 'обменени с друга библиотека', 'унищожени'] })}
        ${fld('Приложен документ', 'attach', {})}
      </div>
      <fieldset><legend>Списък на отчислените документи — чл. 35, ал. 2</legend>
        <div class="toolbar">
          <input id="actScan" placeholder="Въведете инвентарен № или баркод и натиснете Enter" autocomplete="off">
          <button type="button" class="btn" onclick="actAdd()">Добави</button>
        </div>
        <div id="actList"></div>
      </fieldset>
      <div class="grid g3">
        ${fld('Член на комисия 1', 'committee1', { val: s ? s.committee1 || '' : '' })}
        ${fld('Член на комисия 2', 'committee2', { val: s ? s.committee2 || '' : '' })}
        ${fld('Член на комисия 3 (счетоводител)', 'committee3', { val: s ? s.committee3 || '' : '' })}
      </div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveAct()">Утвърди акта и отчисли</button>`);
  setTimeout(() => {
    const el = $('#actScan'); if (!el) return; el.focus();
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); actAdd(); } });
    drawActList();
  }, 60);
}
window.actForm = actForm;
async function actAdd() {
  const el = $('#actScan'), code = el.value.trim(); if (!code) return;
  const b = await call(window.api.deaccessionActs.findBook(code));
  el.value = '';
  if (!b) return toast('Няма документ с баркод/инв. № ' + code, 'err');
  if (ACT_LIST.some(x => x.id === b.id)) return toast('Инв. № ' + b.inv_number + ' вече е в списъка.', 'err');
  if (b.available < b.quantity) toast('Внимание: инв. № ' + b.inv_number + ' в момента е зает от читател.', 'err');
  ACT_LIST.push(b);
  drawActList();
}
window.actAdd = actAdd;
function actDel(n) { ACT_LIST.splice(n, 1); drawActList(); }
window.actDel = actDel;
function drawActList() {
  const el = $('#actList'); if (!el) return;
  if (!ACT_LIST.length) { el.innerHTML = '<div class="hint">Списъкът е празен. Въведете инвентарните номера за отчисляване.</div>'; return; }
  el.innerHTML = `<div class="wrap" style="max-height:220px"><table class="ledger"><thead><tr>
    <th>Инв. №</th><th>Автор, заглавие</th><th>Год.</th><th>Цена</th><th></th></tr></thead><tbody>
    ${ACT_LIST.map((l, n) => `<tr><td class="num">${l.inv_number}</td>
    <td>${esc([l.author, l.title].filter(Boolean).join('. '))}</td><td class="num">${esc(l.year || '')}</td>
    <td class="num">${mny(l.price)}</td><td><button type="button" class="btn sm dgr" onclick="actDel(${n})">×</button></td></tr>`).join('')}
    <tr style="background:var(--paper3);font-weight:700"><td colspan="3">ОБЩО ${ACT_LIST.length} документа</td>
    <td class="num">${mny(ACT_LIST.reduce((s, l) => s + (Number(l.price) || 0), 0))}</td><td></td></tr>
    </tbody></table></div>`;
}
async function saveAct() {
  const d = formData('#actF');
  if (!ACT_LIST.length) return toast('Добавете поне един документ в списъка.', 'err');
  const p = PRICHINI.find(x => x.k == d.reason_code);
  const act = Object.assign({}, d, { reason_text: p ? p.t : '' });
  const id = await call(window.api.deaccessionActs.create({ act, bookIds: ACT_LIST.map(b => b.id) }));
  if (id) { closeModal(); renderActs(); toast('Акт № ' + d.no + ': отчислени са ' + ACT_LIST.length + ' документа.', 'ok'); markSaved(); }
}
window.saveAct = saveAct;
async function openAct(id) {
  const a = await call(window.api.deaccessionActs.get(id));
  if (!a) return;
  modal('Акт за отчисляване № ' + a.no + ' / ' + a.year, `
    <div class="note d"><b>Причина (чл. 30, т. ${a.reason_code}):</b> ${esc(a.reason_text)}<br>
    <b>Разпореждане (чл. 36):</b> ${esc(a.disposal || '—')}${a.attach ? ' · ' + esc(a.attach) : ''}</div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор, заглавие</th><th>Год.</th><th>Цена</th></tr></thead><tbody>
    ${a.items.map(l => `<tr><td class="num">${l.inv_number}</td><td>${esc([l.author, l.title].filter(Boolean).join('. '))}</td>
    <td class="num">${esc(l.year || '')}</td><td class="num">${mny(l.price)}</td></tr>`).join('')}
    <tr style="background:var(--paper3);font-weight:700"><td colspan="3">ОБЩО ${a.items.length}</td>
    <td class="num">${mny(a.items.reduce((s, l) => s + (Number(l.price) || 0), 0))}</td></tr>
    </tbody></table></div>
    <div class="hint" style="margin-top:10px">Комисия: ${[a.committee1, a.committee2, a.committee3].filter(Boolean).map(esc).join(' · ') || '—'}</div>`,
    `<button class="btn l dgr" onclick="revokeAct(${id})">Анулирай акта</button>
     <button class="btn" onclick="printActDoc(${id})">Печат на акта / PDF</button>
     <button class="btn pri" onclick="closeModal()">Затвори</button>`);
}
window.openAct = openAct;
async function printActDoc(id) {
  const a = await call(window.api.deaccessionActs.get(id));
  if (!a) return;
  const s = SETTINGS_CACHE || {};
  const total = a.items.reduce((sum, l) => sum + (Number(l.price) || 0), 0);
  setPrintPage({ name: `Акт за отчисляване № ${a.no}-${a.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>АКТ № ${a.no} / ${bg(a.date)}<br><span style="font-size:12pt">за отчисляване на библиотечни документи</span></h2>
    <div class="pmeta">Днес, ${bg(a.date)} г., комисия, назначена със заповед ${a.order_no ? '№ ' + esc(a.order_no) : '№ …………'} на
    ${esc(s.director_role || 'ръководителя')} на ${esc(s.org || '')}, в състав:<br>
    1. ${esc(a.committee1 || '…………………')} &nbsp; 2. ${esc(a.committee2 || '…………………')} &nbsp; 3. ${esc(a.committee3 || '…………………')} (счетоводител)<br><br>
    на основание <b>чл. 30, т. ${a.reason_code}</b> от Наредба № 3 от 18.11.2014 г. — <b>${esc(a.reason_text)}</b> — отчислява от библиотечния фонд
    <b>${a.items.length}</b> библиотечни документа на обща стойност <b>${mny(total)}</b></div>
    <table><thead><tr><th>№</th><th>Инв. №</th><th>Автор, заглавие, том</th><th>Година</th><th>УДК</th><th>Стойност, лв.</th></tr></thead><tbody>
    ${a.items.map((l, n) => `<tr><td>${n + 1}</td><td>${l.inv_number}</td>
    <td>${esc([l.author, l.title].filter(Boolean).join('. '))}${l.volume ? ', т. ' + esc(l.volume) : ''}</td>
    <td>${esc(l.year || '')}</td><td>${esc(l.udk || '')}</td><td>${mny(l.price)}</td></tr>`).join('')}
    <tr><td colspan="5"><b>ОБЩО</b></td><td><b>${mny(total)}</b></td></tr></tbody></table>
    <div class="pmeta">Начин на разпореждане по чл. 36: <b>${esc(a.disposal || '…………………')}</b>${a.attach ? '<br>Приложен документ: ' + esc(a.attach) : ''}<br>
    Актът е съставен в два екземпляра — по един за счетоводството и за библиотеката.</div>
    ${ssig(['Комисия: 1. ………… 2. ………… 3. …………', 'УТВЪРДИЛ, ' + esc(s.director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printActDoc = printActDoc;
async function revokeAct(id) {
  if (!confirm('Анулиране на акта и връщане на документите във фонда. Използвайте само при сгрешен акт. Да продължа?')) return;
  const res = await window.api.deaccessionActs.revoke(id);
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderActs(); toast('Актът е анулиран.', 'ok'); markSaved();
}
window.revokeAct = revokeAct;

/* ---------------- Читатели ---------------- */
let READERS_QUERY = '';
async function renderReaders() {
  const readers = await call(window.api.readers.list(READERS_QUERY));
  if (!readers) return;
  $('#view').innerHTML = `
    <div class="toolbar">
      <input type="search" id="rSearch" placeholder="Търсене по име, телефон или № карта…" value="${esc(READERS_QUERY)}">
      <button class="btn pri" onclick="readerForm()">+ Нов читател</button>
    </div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Име</th><th>Телефон</th><th>Карта №</th><th>Категория</th><th>Състояние</th><th style="width:230px"></th></tr></thead>
      <tbody>
        ${readers.length ? readers.map(r => `
          <tr><td>${esc(r.name)}</td><td class="num">${esc(r.phone || '')}</td><td class="num">${esc(r.card_no || '')}</td>
            <td>${esc(r.category || '')}</td><td><span class="badge ${r.status === 'активен' ? 'ok' : 'warn'}">${esc(r.status || '')}</span></td>
            <td><button class="btn sm" onclick="readerForm(${r.id})">Редакция</button>
                <button class="btn sm" onclick="printReaderCard(${r.id})">Картон</button>
                <button class="btn sm dgr" onclick="deleteReader(${r.id})">Изтрий</button></td></tr>`).join('')
          : `<tr><td colspan="6" class="empty">Няма намерени читатели.</td></tr>`}
      </tbody>
    </table></div>`;
  $('#rSearch').addEventListener('input', debounce(e => { READERS_QUERY = e.target.value; renderReaders(); }, 300));
}
async function readerForm(id) {
  const r = id ? await call(window.api.readers.get(id)) : null;
  const v = r || { registered_at: today(), category: 'възрастен', status: 'активен' };
  modal(id ? 'Читател ' + (v.card_no || '') : 'Записване на читател', `
    <form id="readerF" onsubmit="return false">
    <fieldset><legend>Лични данни — чл. 42, ал. 3</legend>
      ${fld('Име и фамилия', 'name', { val: v.name || '', req: 1 })}
      <div class="grid g3">
        ${fld('ЕГН', 'egn', { val: v.egn || '' })}
        ${fld('Л.К. номер', 'id_card_no', { val: v.id_card_no || '' })}
        ${fld('Л.К. издадена на', 'id_card_date', { val: v.id_card_date || '', type: 'date' })}
      </div>
      ${fld('Постоянен адрес', 'address', { val: v.address || '' })}
      ${fld('Адрес по местоживеене', 'address2', { val: v.address2 || '', hint: 'ако съвпада с постоянния — оставете празно' })}
      <div class="grid g3">
        ${fld('Телефон', 'phone', { val: v.phone || '' })}
        ${fld('Имейл', 'email', { val: v.email || '', type: 'email' })}
        ${fld('Дата на раждане', 'birth_date', { val: v.birth_date || '', type: 'date' })}
      </div>
    </fieldset>
    <fieldset><legend>Регистрация</legend>
      <div class="grid g4">
        ${fld('Читателска карта №', 'card_no', { val: v.card_no || '', hint: 'използва се като баркод' })}
        ${fld('Категория', 'category', { type: 'select', opts: KATEG, val: v.category })}
        ${fld('Дата на записване', 'registered_at', { val: v.registered_at, type: 'date' })}
        ${fld('Пререгистрация', 're_registered_at', { val: v.re_registered_at || '', type: 'date' })}
      </div>
      <div class="grid g2">
        ${fld('Състояние', 'status', { type: 'select', opts: ['активен', 'прекратен'], val: v.status, allowEmpty: false })}
        ${fld('Забележка', 'note', { val: v.note || '' })}
      </div>
      ${fld('Ползвателят е запознат с правилата за обслужване (чл. 47, ал. 2) и е дал съгласие за обработване на лични данни.', 'gdpr_consent', { type: 'checkbox', val: v.gdpr_consent })}
      ${fld('За читатели под 14 г. — налице е съгласие на родител/настойник.', 'parent_consent', { type: 'checkbox', val: v.parent_consent })}
    </fieldset>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveReader(${id || 'null'})">Запиши</button>`);
  if (id) $('#readerF').dataset.id = id;
}
window.readerForm = readerForm;
async function saveReader(id) {
  const d = formData('#readerF');
  if (!d.name.trim()) return toast('Името е задължително.', 'err');
  if (!d.gdpr_consent) return toast('Отбележете съгласието по чл. 47 и ОРЗД.', 'err');
  d.id = id;
  if (id) await call(window.api.readers.update(d), 'Читателят е обновен.');
  else await call(window.api.readers.create(d), 'Читателят е добавен.');
  closeModal(); renderReaders();
}
window.saveReader = saveReader;
async function deleteReader(id) {
  if (!confirm('Да изтрия ли този читател?')) return;
  const res = await window.api.readers.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  toast('Читателят е изтрит.', 'ok'); markSaved();
  renderReaders();
}
window.deleteReader = deleteReader;

/* ---------------- Заемане и връщане (изцяло чрез сканиране на баркод) ----------------
   Баркод четецът работи като клавиатура: въвежда текста и накрая изпраща Enter.
   Затова навсякъде тук слушаме за Enter в обикновени текстови полета — четецът
   не изисква никаква настройка. */
let CIRC = { readerId: null, mode: 'out' };
async function renderCirc() {
  const s = SETTINGS_CACHE || await loadSettingsCache();
  const tabs = `<div class="toolbar">
    <button class="btn ${CIRC.mode === 'out' ? 'pri' : ''}" onclick="CIRC.mode='out';renderCirc()">Заемане</button>
    <button class="btn ${CIRC.mode === 'in' ? 'pri' : ''}" onclick="CIRC.mode='in';renderCirc()">Връщане</button>
    <button class="btn ${CIRC.mode === 'holds' ? 'pri' : ''}" onclick="CIRC.mode='holds';renderCirc()">Резервации</button>
  </div>`;

  if (CIRC.mode === 'holds') { await renderHolds(tabs); return; }

  if (CIRC.mode === 'in') {
    $('#view').innerHTML = tabs + `
      <div class="card"><h3 style="margin-top:0">Приемане на върнати документи</h3>
        <div class="note" style="margin-top:0">Сканирайте баркода на всеки върнат документ. Системата приключва заемането,
        отбелязва датата на връщане и изчислява обезщетение при забава.</div>
        <input id="inScan" class="scan" placeholder="Сканирай баркод на документа…" autocomplete="off">
        <div id="inLog" style="margin-top:14px"></div>
      </div>`;
    const el = $('#inScan'); el.focus();
    el.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const code = el.value.trim(); el.value = ''; if (!code) return;
      const res = await window.api.loans.returnByCode({ code, date_in: today() });
      const log = $('#inLog');
      if (!res.ok) { log.insertAdjacentHTML('afterbegin', `<div class="scanlog err">${esc(res.error)}</div>`); return; }
      const r = res.data;
      log.insertAdjacentHTML('afterbegin', `<div class="scanlog ${r.daysLate ? 'warn' : 'ok'}">
        <b>${esc(r.title)}</b> (инв. ${r.inv_number}) — върната от ${esc(r.reader_name)}
        ${r.daysLate ? `<br>Забава <b>${r.daysLate}</b> дни · обезщетение <b>${mny(r.fine)}</b>` : ''}</div>`);
      if (r.hold) {
        log.insertAdjacentHTML('afterbegin', `<div class="scanlog warn">📌 <b>НЕ връщайте на рафта</b> — заделена за
          <b>${esc(r.hold.reader_name)}</b> (карта ${esc(r.hold.card_no || '—')}${r.hold.phone ? ', тел. ' + esc(r.hold.phone) : ''})</div>`);
        toast('📌 Заделена за ' + r.hold.reader_name + ' — не се връща на рафта!', 'err');
      } else {
        toast(r.daysLate ? 'Върната със забава ' + r.daysLate + ' дни (' + mny(r.fine) + ')' : 'Приета обратно: инв. № ' + r.inv_number, r.daysLate ? 'err' : 'ok');
      }
      markSaved();
    });
    return;
  }

  let col1, col2, table = '';
  if (CIRC.readerId) {
    const r = await call(window.api.readers.get(CIRC.readerId));
    if (!r) { CIRC.readerId = null; return renderCirc(); }
    const myLoans = await call(window.api.loans.byReader(CIRC.readerId)) || [];
    const openMine = myLoans.filter(l => !l.date_in);
    col1 = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:8px"><div style="flex:1">
      <b style="font-size:17px">${esc(r.name)}</b>
      <div class="hint">Карта ${esc(r.card_no || '—')} · ${esc(r.category || '')} · заети: ${openMine.length}${s.max_books ? ' / ' + s.max_books : ''}</div></div>
      <button class="btn sm" onclick="CIRC.readerId=null;renderCirc()">Смени</button></div>
      ${openMine.some(l => l.date_due && l.date_due < today()) ? '<div class="note w">Читателят има просрочени документи.</div>' : ''}`;
    const myHolds = (await call(window.api.holds.list()) || []).filter(h => h.reader_id === CIRC.readerId);
    const maxRenew = s.extensions_count == null ? 2 : s.extensions_count;
    col2 = `<input id="bScan" class="scan" placeholder="Сканирай баркод на документа…" autocomplete="off">
      <div class="hint" style="margin-top:6px">Срок за заемане: ${s.loan_days} дни${maxRenew ? ' · до ' + maxRenew + ' продължения' : ''}</div>
      <div class="toolbar" style="margin:10px 0 0">
        <button class="btn sm" onclick="holdPrompt()">📌 Резервирай заета книга…</button>
      </div>
      <div id="outLog" style="margin-top:12px"></div>`;
    if (myHolds.length) {
      table += `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Резервации на този читател</h3>
        <div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
        <th>Инв. №</th><th>Заглавие</th><th>Заявена</th><th>Състояние</th><th style="width:110px"></th></tr></thead><tbody>
        ${myHolds.map(h => `<tr><td class="num">${h.inv_number ?? ''}</td><td>${esc(h.title)}</td>
          <td class="num">${bg((h.placed_at || '').slice(0, 10))}</td>
          <td>${h.status === 'заделена' ? '<span class="badge ok">заделена — чака взимане</span>' : '<span class="badge">чака</span>'}</td>
          <td><button class="btn sm" onclick="cancelHold(${h.id})">Откажи</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
    if (openMine.length) {
      table += `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Заети от този читател</h3>
        <div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
        <th>Инв. №</th><th>Заглавие</th><th>Зает</th><th>Срок</th><th>Продължения</th><th style="width:160px"></th></tr></thead><tbody>
        ${openMine.map(l => `<tr><td class="num">${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
          <td class="num">${bg(l.date_out)}</td>
          <td class="num ${l.date_due && l.date_due < today() ? 'warn' : ''}">${bg(l.date_due) || '—'}</td>
          <td class="num">${l.renewals || 0}${maxRenew ? ' / ' + maxRenew : ''}</td>
          <td><button class="btn sm" onclick="returnBook(${l.id})">Приеми</button>
              <button class="btn sm" onclick="extendLoan(${l.id})"${maxRenew && (l.renewals || 0) >= maxRenew ? ' disabled title="Достигнат лимит на продълженията"' : ''}>Продължи</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
  } else {
    col1 = `<input id="pScan" class="scan" placeholder="Сканирай читателска карта или въведи име…" autocomplete="off">
      <div id="pSug" style="margin-top:10px"></div>`;
    col2 = `<div class="hint">Първо изберете читател.</div>`;
  }

  $('#view').innerHTML = tabs + `<div class="grid g2">
    <div class="card"><h3 style="margin-top:0">1 · Читател</h3>${col1}</div>
    <div class="card"><h3 style="margin-top:0">2 · Документи</h3>${col2}</div>
  </div>${table}`;

  const ps = $('#pScan');
  if (ps) {
    ps.focus();
    ps.addEventListener('input', debounce(async () => {
      const q = ps.value.trim();
      if (!q) { $('#pSug').innerHTML = ''; return; }
      const rows = await call(window.api.readers.list(q)) || [];
      $('#pSug').innerHTML = rows.length
        ? rows.slice(0, 6).map(r => `<button class="btn" style="display:block;width:100%;text-align:left;margin-bottom:4px"
            onclick="selectCircReader(${r.id})"><b>${esc(r.name)}</b> · ${esc(r.card_no || '')} · ${esc(r.category || '')}</button>`).join('')
        : `<div class="hint">Няма съвпадение. <button class="btn sm" onclick="readerForm()">+ Нов читател</button></div>`;
    }, 200));
    ps.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const r = await call(window.api.readers.byCard(ps.value.trim()));
      if (r) selectCircReader(r.id); else toast('Няма читател с тази карта.', 'err');
    });
  }
  const bs = $('#bScan');
  if (bs) {
    bs.focus();
    bs.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const code = bs.value.trim(); bs.value = ''; if (!code) return;
      const res = await window.api.loans.checkoutByCode({ reader_id: CIRC.readerId, code, date_out: today() });
      const log = $('#outLog');
      if (!res.ok) { log.insertAdjacentHTML('afterbegin', `<div class="scanlog err">${esc(res.error)}</div>`); return; }
      const l = res.data;
      log.insertAdjacentHTML('afterbegin', `<div class="scanlog ok"><b>${esc(l.title)}</b> (инв. ${l.inv_number}) — заета до <b>${bg(l.date_due)}</b></div>`);
      toast('Заемане: инв. № ' + l.inv_number + ' до ' + bg(l.date_due), 'ok');
      markSaved();
      renderCirc();
    });
  }
}
function selectCircReader(id) { CIRC.readerId = id; CIRC.mode = 'out'; renderCirc(); }
window.selectCircReader = selectCircReader;
async function returnBook(id) {
  const res = await window.api.loans.return({ id, date_in: today() });
  if (!res.ok) return toast(res.error, 'err');
  if (res.data && res.data.hold) {
    const h = res.data.hold;
    toast('📌 Заделена за ' + h.reader_name + (h.phone ? ' (тел. ' + h.phone + ')' : '') + ' — не се връща на рафта!', 'err');
  } else {
    toast('Книгата е върната.', 'ok');
  }
  markSaved();
  if (VIEW === 'over') renderOver(); else renderCirc();
}
window.returnBook = returnBook;
async function extendLoan(id) {
  const res = await window.api.loans.extend({ id });
  if (!res.ok) return toast(res.error, 'err');
  const { date_due, renewals, max } = res.data;
  toast('Срокът е продължен до ' + bg(date_due) + ' (продължение ' + renewals + (max ? '/' + max : '') + ').', 'ok');
  markSaved();
  if (VIEW === 'over') renderOver(); else renderCirc();
}
window.extendLoan = extendLoan;

/* ---------------- Резервации ---------------- */
async function renderHolds(tabs) {
  const rows = await call(window.api.holds.list());
  if (!rows) return;
  $('#view').innerHTML = tabs + `
    <div class="toolbar"><button class="btn pri" onclick="holdPrompt()">+ Нова резервация</button></div>
    ${!rows.length ? '<div class="empty"><h3>Няма активни резервации</h3><p>Резервирайте заета книга, докато читателят чака за нея.</p></div>' : `
    <div class="wrap"><table class="ledger"><thead><tr>
      <th>Инв. №</th><th>Заглавие</th><th>Читател</th><th>Заявена</th><th>Състояние</th><th style="width:110px"></th>
    </tr></thead><tbody>
      ${rows.map(h => `<tr><td class="num">${h.inv_number ?? ''}</td><td>${esc(h.title)}</td>
        <td>${esc(h.reader_name)} <span class="hint">(${esc(h.card_no || '')})</span></td>
        <td class="num">${bg((h.placed_at || '').slice(0, 10))}</td>
        <td>${h.status === 'заделена' ? '<span class="badge ok">заделена — чака взимане</span>' : '<span class="badge">чака в опашка</span>'}</td>
        <td><button class="btn sm" onclick="cancelHold(${h.id})">Откажи</button></td></tr>`).join('')}
    </tbody></table></div>`}`;
}
async function holdPrompt() {
  let readerId = CIRC.readerId;
  if (!readerId) {
    const cardOrName = prompt('Карта или име на читателя, за когото е резервацията:');
    if (!cardOrName) return;
    const byCard = await call(window.api.readers.byCard(cardOrName.trim()));
    if (byCard) { readerId = byCard.id; }
    else {
      const found = (await call(window.api.readers.list(cardOrName.trim())) || [])[0];
      if (!found) return toast('Няма такъв читател.', 'err');
      readerId = found.id;
    }
  }
  const code = prompt('Баркод или инв. № на заетата книга за резервиране:');
  if (!code) return;
  const res = await window.api.holds.add({ reader_id: readerId, code: code.trim() });
  if (!res.ok) return toast(res.error, 'err');
  toast('Резервирана: инв. № ' + res.data.inv_number + ' — на опашката е ' + res.data.queue + '-ри.', 'ok');
  markSaved();
  renderCirc();
}
window.holdPrompt = holdPrompt;
async function cancelHold(id) {
  if (!confirm('Отказ от резервацията?')) return;
  const res = await window.api.holds.cancel(id);
  if (!res.ok) return toast(res.error, 'err');
  toast('Резервацията е отказана.', 'ok'); markSaved();
  renderCirc();
}
window.cancelHold = cancelHold;

/* ---------------- Просрочени ---------------- */
async function renderOver() {
  const rows = await call(window.api.loans.overdue());
  if (!rows) return;
  const s = await call(window.api.settings.get());
  const fine = s ? s.fine_per_day : 0.05;
  const total = rows.reduce((sum, l) => {
    const days = Math.round((new Date(today()) - new Date(l.date_due)) / 864e5);
    return sum + days * fine;
  }, 0);
  if (!rows.length) { $('#view').innerHTML = '<div class="empty"><h3>Няма просрочени заемания</h3><p>Всички заети документи са в срок.</p></div>'; return; }
  $('#view').innerHTML = `
    <div class="note w"><b>Чл. 43, ал. 2 и чл. 49, ал. 1, т. 3</b> — библиотекарят следи сроковете при забава.
    Общо дължимо обезщетение: <b>${mny(total)}</b></div>
    <div class="toolbar">
      <button class="btn pri" onclick="openReminders()">Напомняния (имейл и SMS)</button>
      <button class="btn" onclick="printOverdueNotices()">Печат на напомняния / PDF</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Читател</th><th>Инв. №</th><th>Заглавие</th>
      <th>Срок</th><th>Дни</th><th>Обезщетение</th><th style="width:180px"></th></tr></thead><tbody>
    ${rows.map(l => {
      const days = Math.round((new Date(today()) - new Date(l.date_due)) / 864e5);
      return `<tr><td>${esc(l.reader_name)}</td><td class="num">${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
        <td class="num">${bg(l.date_due)}</td><td class="num warn">${days}</td><td class="num">${mny(days * fine)}</td>
        <td><button class="btn sm" onclick="returnBook(${l.id})">Приеми</button>
            <button class="btn sm" onclick="extendLoan(${l.id})">Продължи</button></td></tr>`;
    }).join('')}
    </tbody></table></div>`;
}

/* ---------------- Инвентаризация ---------------- */
let INVENT_SESSION = null;
async function renderInvent() {
  if (INVENT_SESSION) return renderInventRun();
  const [req, sessions] = await Promise.all([call(window.api.inventorySessions.requirement()), call(window.api.inventorySessions.list())]);
  if (!req) return;
  // Напредъкът за годината: колко от изисквания обхват вече е обхванат от приключените проверки.
  const thisYear = yr();
  const yearSessions = (sessions || []).filter(s => (s.date || '').slice(0, 4) === thisYear);
  const scannedYear = yearSessions.reduce((n, s) => n + (s.scanned || 0), 0);
  const pct = req.target ? Math.min(100, Math.round(scannedYear / req.target * 100)) : 0;
  $('#view').innerHTML = `
    <div class="note"><b>Чл. 40, т. 2</b> — инвентаризация по репрезентативния метод се извършва ежегодно върху
    не по-малко от <b>${req.pct}%</b> от фонда.</div>

    <div class="grid g3" style="margin-bottom:16px">
      <div class="card" style="grid-column:span 2"><h3 style="margin-top:0">Напредък за ${thisYear} г.</h3>
        <div style="display:flex;align-items:center;gap:22px;flex-wrap:wrap">
          ${ringSvg(pct, 'от изисквания обхват')}
          <div style="flex:1;min-width:190px">
            <div class="statRows">
              <div><span>Проверени тази година</span><b>${scannedYear.toLocaleString('bg-BG')}</b></div>
              <div><span>Изискван обхват (${req.pct}%)</span><b>${req.target.toLocaleString('bg-BG')}</b></div>
              <div><span>Остават</span><b style="color:${scannedYear >= req.target ? 'var(--green)' : 'var(--red)'}">
                ${Math.max(0, req.target - scannedYear).toLocaleString('bg-BG')}</b></div>
            </div>
          </div>
        </div>
        ${scannedYear >= req.target
          ? '<div class="note" style="margin-bottom:0">Изискването по чл. 40, т. 2 за тази година е изпълнено.</div>'
          : `<div class="note w" style="margin-bottom:0">Остават <b>${req.target - scannedYear}</b> документа до изпълнение на изискването за ${thisYear} г.</div>`}
      </div>
      <div class="card"><h3 style="margin-top:0">Показатели</h3>
        <div class="statRows">
          <div><span>Библиотечен фонд</span><b>${req.active.toLocaleString('bg-BG')}</b></div>
          <div><span>Изискван процент</span><b>${req.pct}%</b></div>
          <div><span>Допустими загуби</span><b>${req.naturalLoss.toFixed(1)}</b></div>
        </div>
        <div class="hint" style="margin-top:10px">Допустимите загуби по чл. 41 се изчисляват спрямо фонда
        и дела на свободния достъп.</div>
      </div>
    </div>

    <div class="toolbar">
      <button class="btn pri" onclick="startInventForm()">Започни нова проверка</button>
      <button class="btn" onclick="mobileHelp()">📱 Сканиране с телефон</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Дата</th><th>Обхват</th><th>В обхвата</th>
      <th>Проверени</th><th>Липсващи</th><th>Комисия</th><th>Състояние</th></tr></thead><tbody>
    ${sessions.length ? sessions.map(s => {
      const sp = s.pool_size ? Math.min(100, Math.round((s.scanned || 0) / s.pool_size * 100)) : 0;
      return `<tr><td class="num">${bg(s.date)}</td><td>${esc(s.scope || '')}</td>
      <td class="num">${s.pool_size}</td>
      <td><div style="display:flex;align-items:center;gap:8px">
        <b class="num">${s.scanned || 0}</b>
        <div class="chartTrack" style="flex:1;min-width:60px;height:7px"><div class="chartFill" style="width:${sp}%"></div></div>
        <span class="hint">${sp}%</span></div></td>
      <td class="num">${s.closed ? `<b style="color:${s.missing ? 'var(--red)' : 'var(--green)'}">${s.missing || 0}</b>` : '<span class="hint">—</span>'}</td>
      <td style="font-size:12px">${[s.committee1, s.committee2, s.committee3].filter(Boolean).map(esc).join(', ')}</td>
      <td>${s.closed ? '<span class="badge ok">приключена</span>' : '<span class="badge warn">отворена</span>'}</td></tr>`;
    }).join('')
      : `<tr><td colspan="7" class="empty">Няма извършени проверки.</td></tr>`}
    </tbody></table></div>`;
}
function startInventForm() {
  modal('Нова инвентаризация', `
    <form id="ivF" onsubmit="return false">
      ${fld('Дата', 'date', { val: today(), type: 'date' })}
      ${fld('Обхват на проверката', 'scope', { val: 'репрезентативен метод' })}
      <div class="grid g3">${fld('Комисия 1', 'committee1', {})}${fld('Комисия 2', 'committee2', {})}${fld('Комисия 3', 'committee3', {})}</div>
      ${fld('Ограничи до отдел', 'department', { type: 'select', opts: OTDELI, emptyLabel: '— целият фонд —' })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="beginInvent()">Започни сканиране</button>`);
}
window.startInventForm = startInventForm;
async function beginInvent() {
  const d = formData('#ivF');
  const id = await call(window.api.inventorySessions.start(d));
  if (!id) return;
  markSaved();
  INVENT_SESSION = { id, log: [] };
  closeModal(); renderInventRun();
}
window.beginInvent = beginInvent;
async function renderInventRun() {
  const s = await call(window.api.inventorySessions.get(INVENT_SESSION.id));
  const found = s.scans.length, pool = s.pool_size || 0;
  const left = Math.max(0, pool - found);
  const pct = pool ? Math.min(100, Math.round(found / pool * 100)) : 0;
  $('#view').innerHTML = `
    <div class="note w"><b>Проверка в ход</b> — ${bg(s.date)} · ${esc(s.scope || '')}. Сканирайте или въвеждайте
    инвентарните номера един по един; всеки намерен документ се отбелязва веднага.</div>

    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:22px;flex-wrap:wrap">
        <div id="ivRing">${ringSvg(pct, 'проверени от обхвата')}</div>
        <div style="flex:1;min-width:200px">
          <div class="statRows">
            <div><span>В обхвата</span><b>${pool.toLocaleString('bg-BG')}</b></div>
            <div><span>Намерени</span><b id="ivFound" style="color:var(--green)">${found.toLocaleString('bg-BG')}</b></div>
            <div><span>Остават</span><b id="ivLeft">${left.toLocaleString('bg-BG')}</b></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0">Сканиране</h3>
      <input id="ivScan" class="scan" placeholder="Инвентарен №/баркод…" autocomplete="off">
      <div id="ivLog" style="margin-top:10px;max-height:230px;overflow:auto"></div>
    </div>
    <div class="toolbar">
      <button class="btn" onclick="importScansModal(${s.id})">📱 Внеси сканирания от телефон</button>
      <button class="btn pri" onclick="closeInvent()">Приключи и състави протокол</button>
      <button class="btn" onclick="if(confirm('Прекратяване без запис?')){INVENT_SESSION=null;renderInvent()}">Прекрати</button>
    </div>`;
  const el = $('#ivScan'); el.focus();
  let scanned = found;
  el.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = el.value.trim(); el.value = ''; if (!code) return;
    const res = await window.api.inventorySessions.scan({ sessionId: INVENT_SESSION.id, code });
    const log = $('#ivLog');
    if (!res.ok) {
      log.insertAdjacentHTML('afterbegin', `<div class="scanlog err">${esc(res.error)}</div>`);
      return;
    }
    log.insertAdjacentHTML('afterbegin',
      `<div class="scanlog ok"><b>${res.data.inv_number}</b> — ${esc(res.data.title)}</div>`);
    markSaved();
    // Броячите се обновяват на място. Пълно пречертаване тук би изтрило дневника
    // на сканиранията, който току-що беше допълнен.
    scanned++;
    const nLeft = Math.max(0, pool - scanned);
    const nPct = pool ? Math.min(100, Math.round(scanned / pool * 100)) : 0;
    const f = $('#ivFound'), l = $('#ivLeft'), rg = $('#ivRing');
    if (f) f.textContent = scanned.toLocaleString('bg-BG');
    if (l) l.textContent = nLeft.toLocaleString('bg-BG');
    if (rg) rg.innerHTML = ringSvg(nPct, 'проверени от обхвата');
  });
}
async function closeInvent() {
  const res = await window.api.inventorySessions.close(INVENT_SESSION.id);
  if (!res.ok) return toast(res.error, 'err');
  markSaved();
  const r = res.data;
  INVENT_SESSION = null;
  const over = Math.max(0, r.missing - r.allowedLoss);
  modal('Инвентаризацията е приключена', `
    <div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="num">${r.scanned}</div><div class="lbl">Проверени</div></div>
      <div class="card"><div class="num">${r.missing}</div><div class="lbl">Липсващи</div></div>
      <div class="card"><div class="num">${r.allowedLoss.toFixed(1)}</div><div class="lbl">Допустими</div></div>
    </div>
    ${over > 0
      ? `<div class="note d">Липсите надвишават нормативите за естествени загуби с ${over.toFixed(1)} документа (чл. 51 – 53).</div>`
      : `<div class="note">Липсите са в рамките на допустимите естествени загуби (чл. 41, ал. 1).</div>`}
    <p style="font-size:13px">Липсващите документи са отбелязани със статус „липсващ“. Отчислете ги с акт по
    <b>чл. 30, т. 6</b>, ако е приложимо.</p>`,
    `<button class="btn pri" onclick="closeModal()">Затвори</button>`);
  renderInvent();
}
window.closeInvent = closeInvent;

/* ---------------- Периодика ---------------- */
async function renderPeriodika() {
  const list = await call(window.api.periodicals.list());
  if (!list) return;
  $('#view').innerHTML = `
    <div class="note">Картотека на периодичните издания и постъпилите броеве към всяко от тях (кардекс).</div>
    <div class="toolbar"><button class="btn pri" onclick="periodicalForm()">+ Ново периодично издание</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Заглавие</th><th>Периодичност</th><th>Издател</th>
      <th>ISSN</th><th>Отдел</th><th>Броеве</th><th></th></tr></thead><tbody>
    ${list.length ? list.map(p => `<tr><td>${esc(p.title)}</td><td>${esc(p.freq || '')}</td><td>${esc(p.publisher || '')}</td>
      <td class="num">${esc(p.issn || '')}</td><td>${esc(p.department || '')}</td><td class="num">${p.issue_count}</td>
      <td><button class="btn sm" onclick="openPeriodical(${p.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="7" class="empty">Няма заведени периодични издания.</td></tr>`}
    </tbody></table></div>`;
}
function periodicalForm(p) {
  const v = p || { freq: 'месечно', department: 'периодика' };
  modal(p ? 'Редакция на периодично издание' : 'Ново периодично издание', `
    <form id="perF" onsubmit="return false">
      ${fld('Заглавие', 'title', { val: v.title || '', req: 1 })}
      <div class="grid g3">
        ${fld('Периодичност', 'freq', { type: 'select', opts: PER_FREQ, val: v.freq })}
        ${fld('Издател', 'publisher', { val: v.publisher || '' })}
        ${fld('ISSN', 'issn', { val: v.issn || '' })}
      </div>
      ${fld('Отдел', 'department', { type: 'select', opts: OTDELI, val: v.department })}
      ${fld('Забележка', 'note', { val: v.note || '' })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="savePeriodical(${p ? p.id : 'null'})">Запиши</button>`);
}
window.periodicalForm = periodicalForm;
async function savePeriodical(id) {
  const d = formData('#perF'); d.id = id;
  if (!d.title.trim()) return toast('Заглавието е задължително.', 'err');
  if (id) await call(window.api.periodicals.update(d), 'Записано.');
  else await call(window.api.periodicals.create(d), 'Записано.');
  closeModal(); renderPeriodika();
}
window.savePeriodical = savePeriodical;
async function openPeriodical(id) {
  const p = await call(window.api.periodicals.get(id));
  if (!p) return;
  modal(p.title, `
    <div class="hint" style="margin-bottom:10px">${esc(p.freq || '')} · ${esc(p.publisher || '')}${p.issn ? ' · ISSN ' + esc(p.issn) : ''}</div>
    <fieldset><legend>Нов постъпил брой</legend>
      <form id="issueF" onsubmit="return false" class="grid g3">
        ${fld('Номер на брой', 'issue_no', { req: 1 })}
        ${fld('Дата на постъпване', 'date', { val: today(), type: 'date' })}
        ${fld('Цена (лв.)', 'price', { type: 'number', step: '0.01' })}
      </form>
      <button type="button" class="btn pri" onclick="addIssue(${id})">Добави брой</button>
    </fieldset>
    ${p.issues.length ? `<div class="wrap" style="max-height:240px"><table class="ledger"><thead><tr>
      <th>Брой</th><th>Дата</th><th>Цена</th><th></th></tr></thead><tbody>
      ${p.issues.map(i => `<tr><td class="num">${esc(i.issue_no)}</td><td class="num">${bg(i.date)}</td>
      <td class="num">${mny(i.price)}</td><td><button type="button" class="btn sm dgr" onclick="delIssue(${i.id},${id})">×</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="hint">Все още няма вписани броеве.</div>'}`,
    `<button class="btn dgr" onclick="delPeriodical(${id})">Изтрий изданието</button>
     <button class="btn" onclick="closeModal();periodicalForm(${JSON.stringify(p).replace(/"/g, '&quot;')})">Редактирай</button>
     <button class="btn pri" onclick="closeModal()">Затвори</button>`);
}
window.openPeriodical = openPeriodical;
async function addIssue(periodicalId) {
  const d = formData('#issueF');
  if (!d.issue_no) return toast('Въведете номер на брой.', 'err');
  d.periodical_id = periodicalId;
  await call(window.api.periodicalIssues.add(d));
  markSaved();
  openPeriodical(periodicalId);
}
window.addIssue = addIssue;
async function delIssue(id, periodicalId) {
  await call(window.api.periodicalIssues.delete(id));
  markSaved();
  openPeriodical(periodicalId);
}
window.delIssue = delIssue;
async function delPeriodical(id) {
  if (!confirm('Изтриване на периодичното издание?')) return;
  const res = await window.api.periodicals.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderPeriodika(); toast('Изтрито.', 'ok');
}
window.delPeriodical = delPeriodical;

/* ---------------- МЗС ---------------- */
function mzsBadgeClass(s) { return { 'заявено': '', 'изпратено': 'warn', 'получено': '', 'върнато': 'ok', 'отказано': 'warn' }[s] || ''; }
async function renderMzs() {
  const rows = await call(window.api.mzs.list());
  if (!rows) return;
  window._MZS_ROWS = rows;
  $('#view').innerHTML = `
    <div class="note">Регистър на заявките за междубиблиотечно заемане — изходящи и входящи.</div>
    <div class="toolbar"><button class="btn pri" onclick="mzsForm()">+ Нова заявка</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>№</th><th>Дата</th><th>Посока</th><th>Партньор</th>
      <th>Документ</th><th>Заявител</th><th>Статус</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(m => `<tr><td class="num">${m.no}</td><td class="num">${bg(m.date)}</td>
      <td>${esc(m.direction)}</td><td>${esc(m.partner)}</td><td>${esc([m.author, m.title].filter(Boolean).join('. '))}</td>
      <td>${esc(m.requester || '')}</td><td><span class="badge ${mzsBadgeClass(m.status)}">${esc(m.status)}</span></td>
      <td><button class="btn sm" onclick="openMzs(${m.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="8" class="empty">Няма заявки.</td></tr>`}
    </tbody></table></div>`;
}
async function mzsForm(m) {
  const y = yr();
  const no = m ? m.no : await call(window.api.mzs.nextNo(y));
  const v = m || { no, date: today(), direction: 'изходящо', status: 'заявено' };
  modal(m ? 'Заявка № ' + v.no : 'Нова заявка за МЗС', `
    <form id="mzsF" onsubmit="return false">
      <div class="grid g3">
        ${fld('№', 'no', { val: v.no, req: 1 })}
        ${fld('Дата', 'date', { val: v.date, type: 'date' })}
        ${fld('Посока', 'direction', { type: 'select', opts: ['изходящо', 'входящо'], val: v.direction })}
      </div>
      ${fld('Библиотека партньор', 'partner', { val: v.partner || '', req: 1 })}
      <div class="grid g2">
        ${fld('Автор', 'author', { val: v.author || '' })}
        ${fld('Заглавие', 'title', { val: v.title || '', req: 1 })}
      </div>
      <div class="grid g3">
        ${fld('ISBN/ISSN', 'isbn', { val: v.isbn || '' })}
        ${fld('Заявител (читател)', 'requester', { val: v.requester || '' })}
        ${fld('Статус', 'status', { type: 'select', opts: MZS_STATUS, val: v.status })}
      </div>
      ${fld('Срок за връщане', 'due_date', { val: v.due_date || '', type: 'date' })}
      ${fld('Забележка', 'note', { val: v.note || '', type: 'textarea', rows: 2 })}
    </form>`,
    `${m ? `<button class="btn l dgr" onclick="delMzs(${m.id})">Изтрий</button>
     <button class="btn l" onclick="printMzsDoc(${m.id})">Печат / PDF</button>` : ''}
     <button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveMzs(${m ? m.id : 'null'})">Запиши</button>`);
}
window.mzsForm = mzsForm;
function printMzsDoc(id) {
  const m = (window._MZS_ROWS || []).find(x => x.id === id);
  if (!m) return;
  const s = SETTINGS_CACHE || {};
  setPrintPage({ name: `Заявка за МЗС № ${m.no}-${m.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ЗАЯВКА ЗА МЕЖДУБИБЛИОТЕЧНО ЗАЕМАНЕ № ${m.no} / ${bg(m.date)}</h2>
    <div class="pmeta">
    <b>Посока:</b> ${esc(m.direction)} &nbsp; <b>Библиотека партньор:</b> ${esc(m.partner)}<br>
    <b>Търсен документ:</b> ${esc([m.author, m.title].filter(Boolean).join('. '))}${m.isbn ? ' · ISBN/ISSN ' + esc(m.isbn) : ''}<br>
    ${m.requester ? '<b>Заявител:</b> ' + esc(m.requester) + '<br>' : ''}
    <b>Статус:</b> ${esc(m.status)}${m.due_date ? ' · срок за връщане ' + bg(m.due_date) : ''}
    ${m.note ? '<br><b>Забележка:</b> ' + esc(m.note) : ''}</div>
    ${ssig(['Библиотекар: ' + esc(s.librarian || '…………………'), esc(s.director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printMzsDoc = printMzsDoc;
async function saveMzs(id) {
  const d = formData('#mzsF'); d.id = id;
  if (!d.partner.trim() || !d.title.trim()) return toast('Библиотеката партньор и заглавието са задължителни.', 'err');
  if (id) await call(window.api.mzs.update(d), 'Записано.');
  else await call(window.api.mzs.create(d), 'Записано.');
  closeModal(); renderMzs();
}
window.saveMzs = saveMzs;
async function openMzs(id) {
  const rows = await call(window.api.mzs.list());
  window._MZS_ROWS = rows || [];
  const m = window._MZS_ROWS.find(x => x.id === id);
  if (m) mzsForm(m);
}
window.openMzs = openMzs;
async function delMzs(id) {
  if (!confirm('Изтриване на заявката?')) return;
  await call(window.api.mzs.delete(id));
  closeModal(); renderMzs(); toast('Изтрито.', 'ok'); markSaved();
}
window.delMzs = delMzs;

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
  const years = [...new Set([y, parseInt(yr(), 10)])].sort((a, b) => b - a);
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

/* ---------------- Справки и статистика ---------------- */
let STATS_YEAR = null;
async function renderStats() {
  const y = STATS_YEAR || yr();
  const r = await call(window.api.stats.report(y));
  if (!r) return;
  // Скалата е спрямо най-голямата стойност в групата, а не спрямо целия фонд — иначе при
  // разпределение като „98% български“ всички останали ленти са невидими черти.
  const bars = (data, tot, cls) => {
    if (!data || !data.length) return '<span class="hint">няма данни</span>';
    const max = Math.max(...data.map(([, v]) => v)) || 1;
    return data.map(([k, v]) => `
      <div class="chartRow">
        <div class="cr-top"><span class="cr-k">${esc(k)}</span>
          <span class="cr-v"><b>${v}</b> · ${tot ? Math.round(v / tot * 100) : 0}%</span></div>
        <div class="chartTrack"><div class="chartFill ${cls || ''}" style="width:${Math.max(2, v / max * 100)}%"></div></div>
      </div>`).join('');
  };
  const totalReturned = r.returnedOnTime + r.returnedLate;
  const onTimePct = totalReturned ? Math.round(r.returnedOnTime / totalReturned * 100) : 0;
  $('#view').innerHTML = `
    <div class="toolbar">
      <select onchange="STATS_YEAR=this.value;renderStats()">
        ${[y, yr()].filter((v, i, a) => a.indexOf(v) === i).map(x => `<option ${x === y ? 'selected' : ''}>${x}</option>`).join('')}
      </select>
      <span class="hint">отчетен период 01.01.${y} – 31.12.${y}</span>
      <span style="flex:1"></span>
      <button class="btn sm" onclick="addVisits()">Впиши посещения</button>
    </div>

    <div class="kpis" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi-ico">📚</div><div class="kpi-body">
        <div class="kpi-num">${r.fundCount.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Библиотечен фонд</div><div class="kpi-extra">${mny(r.fundValue)}</div></div></div>
      <div class="kpi"><div class="kpi-ico">👥</div><div class="kpi-body">
        <div class="kpi-num">${r.readersCount.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Регистрирани читатели</div><div class="kpi-extra">през ${y} г.</div></div></div>
      <div class="kpi"><div class="kpi-ico">🔄</div><div class="kpi-body">
        <div class="kpi-num">${r.loansCount.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Заемания</div><div class="kpi-extra">през ${y} г.</div></div></div>
      <div class="kpi"><div class="kpi-ico">🚪</div><div class="kpi-body">
        <div class="kpi-num">${r.visits.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Посещения</div><div class="kpi-extra">БДС ISO 2789</div></div></div>
    </div>

    <div class="grid g3">
      <div class="card"><h3 style="margin-top:0">Фонд по езици</h3>${bars(r.fundByLanguage, r.fundCount)}</div>
      <div class="card"><h3 style="margin-top:0">Фонд по отдели</h3>${bars(r.fundByDepartment, r.fundCount)}</div>
      <div class="card"><h3 style="margin-top:0">Фонд по категории</h3>${bars(r.fundByCategory, r.fundCount)}</div>
    </div>

    <div class="grid g3" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Движение на фонда през ${y}</h3>
        <div class="chartRow">
          <div class="cr-top"><span class="cr-k">Постъпили</span>
            <span class="cr-v"><b style="color:var(--green)">+${r.acquiredCount}</b> · ${mny(r.acquiredValue)}</span></div>
          <div class="chartTrack"><div class="chartFill g" style="width:${r.fundCount ? Math.min(100, Math.max(2, r.acquiredCount / r.fundCount * 100)) : 0}%"></div></div>
        </div>
        <div class="chartRow">
          <div class="cr-top"><span class="cr-k">Отчислени</span>
            <span class="cr-v"><b style="color:var(--red)">−${r.deaccessionedCount}</b> · ${mny(r.deaccessionedValue)}</span></div>
          <div class="chartTrack"><div class="chartFill r" style="width:${r.fundCount ? Math.min(100, Math.max(2, r.deaccessionedCount / r.fundCount * 100)) : 0}%"></div></div>
        </div>
        <hr style="border:0;border-top:1px solid var(--rule);margin:12px 0 10px">
        <div class="statRows">
          <div><span>Чист прираст</span><b style="color:${r.acquiredCount - r.deaccessionedCount >= 0 ? 'var(--green)' : 'var(--red)'}">
            ${r.acquiredCount - r.deaccessionedCount >= 0 ? '+' : ''}${r.acquiredCount - r.deaccessionedCount}</b></div>
        </div>
      </div>

      <div class="card"><h3 style="margin-top:0">Спазване на сроковете</h3>
        ${totalReturned ? `
          ${ringSvg(onTimePct)}
          <div class="statRows" style="margin-top:12px">
            <div><span>Върнати в срок</span><b style="color:var(--green)">${r.returnedOnTime}</b></div>
            <div><span>Върнати със забава</span><b style="color:var(--red)">${r.returnedLate}</b></div>
            <div><span>Събрани обезщетения</span><b>${mny(r.finesCollected || 0)}</b></div>
          </div>`
        : '<span class="hint">Няма върнати документи през периода.</span>'}
      </div>

      <div class="card"><h3 style="margin-top:0">Най-търсени документи</h3>
        ${r.topLoans.length ? r.topLoans.map((t, i) => `<div class="rankRow">
          <span class="rankNo">${i + 1}</span>
          <span class="rankTitle" title="${esc(t.title)}">${esc(t.title)}</span>
          <span class="rankVal">${t.n}</span></div>`).join('')
        : '<span class="hint">няма данни</span>'}
      </div>
    </div>`;
}
/* Пръстеновидна диаграма за процент — чист SVG, без външни библиотеки. */
function ringSvg(pct, label) {
  const R = 34, C = 2 * Math.PI * R;
  const on = Math.max(0, Math.min(100, pct));
  const col = on >= 90 ? 'var(--green)' : on >= 70 ? 'var(--brass)' : 'var(--red)';
  return `<div class="ring">
    <svg class="ringSvg" width="86" height="86" viewBox="0 0 86 86">
      <circle cx="43" cy="43" r="${R}" fill="none" stroke="var(--paper3)" stroke-width="10"/>
      <circle cx="43" cy="43" r="${R}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${(C * on / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 43 43)"/>
      <text x="43" y="48" text-anchor="middle" font-size="18" font-weight="700" fill="var(--brassD)"
        font-family="Georgia,serif">${on}%</text>
    </svg>
    <div class="ringTxt"><div class="rt-n">${on}%</div>
      <div class="rt-l">${esc(label || 'върнати в срок')}</div></div>
  </div>`;
}
function addVisits() {
  modal('Вписване на посещения', `
    <form id="vsF" onsubmit="return false">${fld('Дата', 'date', { val: today(), type: 'date' })}${fld('Брой посещения', 'count', { type: 'number' })}</form>
    <div class="hint">Дневникът на посещенията се води за годишния статистически отчет (БДС ISO 2789).</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button><button class="btn pri" onclick="saveVisits()">Впиши</button>`);
}
window.addVisits = addVisits;
async function saveVisits() {
  const d = formData('#vsF');
  if (!d.count) return;
  await call(window.api.visits.add(d), 'Посещенията са вписани.');
  closeModal(); renderStats();
}
window.saveVisits = saveVisits;

/* ---------------- Онлайн каталог ---------------- */
async function renderCatalog() {
  const [status, s, rc] = await Promise.all([
    call(window.api.catalog.status()), call(window.api.settings.get()), call(window.api.catalog.remoteCheck())
  ]);
  if (!status) return;
  const notSetUp = !status.ghUser || !status.ghRepo;
  $('#view').innerHTML = `
    <div class="note"><b>Публичен каталог.</b> Изнасят се само библиографски данни и наличност.
    Лични данни на читатели, цени и служебни бележки <b>не</b> се включват никъде в изнесения файл. Каталогът се
    публикува през <b>GitHub</b> — ${s && s.cat_url ? `сайтът <b>${esc(s.cat_url)}</b> чете` : 'сайтът на библиотеката чете'}
    файла на живо от там, без нужда от друг сървър.</div>

    ${rc && rc.mismatch ? `<div class="note" style="border-left-color:var(--red)">
      <b style="color:var(--red)">Внимание — папката сочи към чуждо хранилище.</b><br>
      Свързаната папка е работно копие на <b>${esc(rc.remote.user)}/${esc(rc.remote.repo)}</b>, а в настройките
      по-долу е записано <b>${esc(status.ghUser || '—')}/${esc(status.ghRepo || '—')}</b>. Публикуването е спряно,
      за да не се презапише каталогът на друга библиотека. Клонирайте своето хранилище и изберете неговата папка.
    </div>` : ''}

    ${notSetUp ? `<div class="card" style="border-left:3px solid var(--brass)">
      <h3 style="margin-top:0">Собствен каталог на ${esc(status.libName || 'библиотеката')}</h3>
      <div class="note" style="margin-top:0">Всяка библиотека публикува своя каталог в <b>собствено</b> хранилище
      в GitHub. Направете го веднъж:</div>
      <ol class="steps">
        <li>Създайте безплатен профил в <b>github.com</b>, ако нямате.</li>
        <li>Създайте ново <b>публично</b> хранилище. Предложено име:
            <code>${esc(status.suggestedRepo)}</code> — може и друго, само с латински букви и тирета.</li>
        <li>На този компютър клонирайте хранилището:<br>
            <code>git clone https://github.com/ПОТРЕБИТЕЛ/${esc(status.suggestedRepo)}.git</code></li>
        <li>Попълнете потребителя и хранилището в полетата по-долу и запишете.</li>
        <li>Изберете клонираната папка в „Работна папка“ — оттам нататък всичко е автоматично.</li>
      </ol>
      <div class="hint">Каталогът на всяка библиотека е отделен. Програмата никога не публикува в чуждо
      хранилище — ако папката сочи другаде, публикуването се спира.</div>
    </div>` : ''}

    <div class="card"><h3 style="margin-top:0">Работна папка (git clone на хранилището)</h3>
      ${status.folder ? `
        <div class="note">Свързана папка: <b style="font-family:var(--mono)">${esc(status.folder)}</b> —
        <code>katalog.json</code> се записва там автоматично при всяка промяна във фонда (нова книга, редакция,
        заемане, връщане, отчисляване).
        ${status.isGitRepo
          ? '<br><b>Разпозната като git хранилище</b> — публикуването в GitHub става автоматично на всеки 5 минути (ако има промяна), или веднага с бутона по-долу.'
          : '<br><span style="color:var(--red)">Внимание: тази папка не е git хранилище (липсва .git) — направете <code>git clone</code> на хранилището веднъж и изберете тази папка отново.</span>'}
        </div>
        <div class="toolbar">
          <button class="btn pri" onclick="catalogGitPublishNow()">Публикувай в GitHub сега</button>
          <button class="btn" onclick="catalogWriteNow()">Генерирай katalog.json (без push)</button>
          <button class="btn dgr" onclick="catalogDisconnect()">Спри автоматичния запис</button>
        </div>`
      : `
        <div class="note">Едно и само веднъж — на този компютър направете <code>git clone</code> на хранилището
        (<code>git clone https://github.com/${esc(status.ghUser || 'ПОТРЕБИТЕЛ')}/${esc(status.ghRepo || 'ХРАНИЛИЩЕ')}.git</code>
        — попълнете полетата по-долу, за да се сглоби точната команда),
        после изберете тук получената папка. Програмата ще записва <code>katalog.json</code> там автоматично при
        всяка промяна във фонда, и ще го публикува в GitHub сама (git add/commit/push) — не е нужен друг скрипт или
        планирана задача.</div>
        <button class="btn pri" onclick="catalogChooseFolder()">Избери папката на хранилището…</button>`}
      <div class="hint" style="margin-top:10px">Записи, които ще излязат в каталога: <b>${status.total}</b> ·
      от тях налични: <b>${status.available}</b></div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Хранилище в GitHub</h3>
      <div class="note" style="margin-top:0">Адресът, който сайтът ползва, се сглобява сам от потребителя,
      хранилището и клона в GitHub. Сменяйте ги само ако направите ново хранилище.</div>
      <form id="ghF" onsubmit="return false"><div class="grid g3">
        ${fld('Потребител в GitHub', 'gh_user', { val: status.ghUser || '', hint: 'потребителското име в GitHub' })}
        ${fld('Хранилище', 'gh_repo', { val: status.ghRepo || '', hint: 'името на хранилището с каталога' })}
        ${fld('Клон', 'gh_branch', { val: status.ghBranch || 'main', hint: 'обикновено main' })}
      </div></form>
      <div class="toolbar"><button class="btn pri" onclick="saveGhSettings()">Запиши и сглоби адреса</button></div>
      <div class="hint" style="margin-top:10px">Адрес, който ползва сайтът:<br>
      <code style="word-break:break-all">${esc(status.rawUrl || '(попълнете потребител и хранилище)')}</code></div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Публичен адрес на сайта</h3>
      <p class="hint" style="margin-top:0">Редактира се в „Настройки“ → „Библиотека“ → „Адрес на сайта“.</p>
      <div class="hint">Текущ адрес: <b>${esc(s ? s.cat_url || '—' : '—')}</b></div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Ръчен експорт</h3>
      <p style="font-size:13.5px;margin-top:0">Извежда снимка на данните във файл по избор, независимо от папката за
      автоматично публикуване по-горе.</p>
      <div class="toolbar">
        <button class="btn" onclick="exportCatalog()">Каталог (JSON)…</button>
        <button class="btn" onclick="exportCatalogCsv()">Целия фонд (CSV)…</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Библиотечни формати за обмен</h3>
      <p style="font-size:13.5px;margin-top:0">Изнася целия фонд в стандартните формати, които други
      библиотечни системи разпознават. Смисълът е данните да не са заключени в тази програма: при
      преминаване към <b>COBISS</b> или включване в сводния каталог се подава един файл, вместо да
      се преписват записите на ръка.</p>
      <div class="toolbar">
        <button class="btn" onclick="exportMarc()">UNIMARC / MARCXML…</button>
        <button class="btn" onclick="exportDc()">Dublin Core…</button>
      </div>
      <div class="hint" style="margin-top:8px">
        <b>UNIMARC</b> носи пълното библиографско описание — полета 200 (заглавие и автор),
        210 (издателски данни), 215 (обем), 606 (предметни рубрики), 675 (УДК), 700 (автор с
        разделени фамилия и име) и 995 (данни за екземпляра: инвентарен номер, отдел, сигнатура).<br>
        <b>Dublin Core</b> е по-простият формат, който приемат хранилищата на цифрово съдържание
        и агрегаторите.
      </div>
    </div>`;
}
async function exportMarc() {
  const res = await window.api.catalog.exportMarc();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast(`Изнесени ${res.data.count} записа в UNIMARC: ${res.data.path}`, 'ok');
}
window.exportMarc = exportMarc;
async function exportDc() {
  const res = await window.api.catalog.exportDc();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast(`Изнесени ${res.data.count} записа в Dublin Core: ${res.data.path}`, 'ok');
}
window.exportDc = exportDc;
async function catalogChooseFolder() {
  const res = await window.api.catalog.chooseFolder();
  if (!res.ok) return toast(res.error, 'err');
  if (res.adopted) {
    toast(`Папката е свързана с хранилището ${res.adopted.user}/${res.adopted.repo} — настройките са попълнени сами.`, 'ok');
  } else if (res.mismatch) {
    toast('Папката е свързана, но сочи към друго хранилище — вижте предупреждението по-горе.', 'err');
  } else {
    toast('Папката е свързана — katalog.json се обновява автоматично.', 'ok');
  }
  renderCatalog();
}
window.catalogChooseFolder = catalogChooseFolder;
async function catalogDisconnect() {
  if (!confirm('Спиране на автоматичния запис на katalog.json?')) return;
  await call(window.api.catalog.disconnectFolder(), 'Изключено.');
  renderCatalog();
}
window.catalogDisconnect = catalogDisconnect;
async function catalogWriteNow() {
  const res = await window.api.catalog.writeNow();
  if (!res.ok) return toast(res.error, 'err');
  toast('Каталогът е обновен.', 'ok');
  renderCatalog();
}
window.catalogWriteNow = catalogWriteNow;
async function catalogGitPublishNow() {
  toast('Публикуване в GitHub…', 'ok');
  const res = await window.api.catalog.gitPublishNow();
  if (!res.ok) return toast(res.error, 'err');
  toast(res.committed ? 'Публикувано в GitHub.' : 'Няма промяна за публикуване.', 'ok');
  renderCatalog();
}
window.catalogGitPublishNow = catalogGitPublishNow;
async function saveGhSettings() {
  const d = formData('#ghF');
  await call(window.api.catalog.updateGh(d), 'Настройките за GitHub са записани.');
  renderCatalog();
}
window.saveGhSettings = saveGhSettings;
async function exportCatalog() {
  const res = await window.api.catalog.export();
  if (!res.ok) return toast(res.error, 'err');
  toast('Каталогът е записан в ' + res.data, 'ok');
}
window.exportCatalog = exportCatalog;
async function exportCatalogCsv() {
  const res = await window.api.catalog.exportCsv();
  if (!res.ok) return toast(res.error, 'err');
  toast('Таблицата е записана в ' + res.data, 'ok');
}
window.exportCatalogCsv = exportCatalogCsv;

/* ---------------- Баркод етикети ---------------- */
async function renderLabels() {
  const s = SETTINGS_CACHE || await loadSettingsCache();
  $('#view').innerHTML = `
    <div class="note">Етикетите се печатат във формат <b>Code 39</b> — разчита се от всеки USB баркод четец без настройка.
    Съвместимо е с обикновен принтер (A4 лист, брой колони по избор) и с ролкови лейбъл принтери
    (Zebra, Brother QL, Dymo и др.). Размерите на трите вида етикети се задават поотделно по-долу.</div>

    <div class="card"><h3 style="margin-top:0">Формат на печат за етикети</h3>
      <form id="lblFmtF" onsubmit="return false">
        <fieldset><legend>Хартия</legend>
          <div class="grid g4">
            ${fld('Формат', 'lbl_mode', { type: 'select', allowEmpty: false, val: s.lbl_mode, opts: [{ v: 'sheet', t: 'A4 лист (в колони)' }, { v: 'roll', t: 'Ролков лейбъл принтер' }] })}
            ${fld('Колони на листа', 'lbl_cols', { val: s.lbl_cols ?? 3, type: 'number', hint: 'само за A4 лист' })}
            ${fld('Разстояние между етикетите (мм)', 'lbl_gap', { val: s.lbl_gap ?? 3, type: 'number', hint: 'само за A4 лист' })}
            ${fld('Поле на листа (мм)', 'lbl_margin', { val: s.lbl_margin ?? 8, type: 'number' })}
          </div>
          <label class="chk"><input type="checkbox" name="lbl_border" ${(s.lbl_border == null || +s.lbl_border) ? 'checked' : ''}>
            Пунктирана рамка около всеки етикет (помага при рязане; изключете я при готови листове с етикети)</label>
        </fieldset>
        <fieldset><legend>Размери на трите вида етикети (мм)</legend>
          <div class="grid g3">
            <div>
              <div class="hint" style="margin-bottom:4px"><b>Етикет за фонда</b></div>
              <div class="grid g2">
                ${fld('Ширина', 'lbl_w', { val: s.lbl_w ?? 40, type: 'number' })}
                ${fld('Височина', 'lbl_h', { val: s.lbl_h ?? 30, type: 'number' })}
              </div>
            </div>
            <div>
              <div class="hint" style="margin-bottom:4px"><b>Етикет за сигнатура</b></div>
              <div class="grid g2">
                ${fld('Ширина', 'sig_w', { val: s.sig_w ?? 25, type: 'number' })}
                ${fld('Височина', 'sig_h', { val: s.sig_h ?? 35, type: 'number' })}
              </div>
            </div>
            <div>
              <div class="hint" style="margin-bottom:4px"><b>Читателска карта</b></div>
              <div class="grid g2">
                ${fld('Ширина', 'card_w', { val: s.card_w ?? 90, type: 'number' })}
                ${fld('Височина', 'card_h', { val: s.card_h ?? 60, type: 'number' })}
              </div>
            </div>
          </div>
          <div class="hint">Стандартният размер на читателска карта е 90 × 60 мм. Размерите важат и за двата
          формата: при A4 лист определят големината на всяко квадратче, при ролков принтер — размера на страницата.</div>
        </fieldset>
      </form>
      <button class="btn pri" onclick="saveLabelFormat()">Запиши формата</button>
    </div>

    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Баркод етикети за фонда</h3>
        <p class="hint" style="margin-top:0">Всеки етикет съдържа името на библиотеката, населеното място,
        баркод (Code&nbsp;39) и инвентарния номер под баркода.</p>
        <div class="grid g2">
          ${fld('От инвентарен №', 'lblFrom', {})}
          ${fld('До инвентарен №', 'lblTo', {})}
        </div>
        <div class="toolbar"><button class="btn pri" onclick="printLabelsRange()">Печат на диапазон</button>
        <button class="btn" onclick="printLabelsAll()">Всички</button></div>
        <div style="margin-top:10px;width:170px;border:1px solid var(--rule2);background:#fff;padding:8px 6px;text-align:center">
          ${lblCard({ barcode: '1', inv_number: 1, call_number: 'В-15/ВАЗ' })}
        </div>
        <div class="hint" style="margin-top:6px">Пример за оформлението.</div>
      </div>
      <div class="card"><h3 style="margin-top:0">Читателски карти</h3>
        <p class="hint" style="margin-top:0">Карта с логото и името на библиотеката, името на читателя,
        категорията, датата на регистрация и баркод на номера на картата.
        Размер ${esc(String(s.card_w ?? 90))} × ${esc(String(s.card_h ?? 60))} мм.</p>
        <div class="toolbar"><button class="btn pri" onclick="printCardsAll()">Печат на карти за всички</button></div>
        <div class="cardPreview" style="--cw:${esc(String(s.card_w ?? 90))}mm;--ch:${esc(String(s.card_h ?? 60))}mm">
          ${readerCardHtml({ name: 'Иванова, Мария Петрова', card_no: '000123', category: 'възрастен',
            registered_at: today(), id: 1 })}
        </div>
        <div class="hint" style="margin-top:6px">Пример за оформлението — показан е в истинския размер.
        ${s.logo ? '' : 'Логото се задава в „Настройки“ → „Лого на организацията“.'}</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Етикети за сигнатура за гръбчето на книгата</h3>
      <div class="note" style="margin-top:0">Само УДК на първия ред и авторски знак под него — без баркод, име на
      библиотеката или инвентарен номер.</div>
      <div class="grid g2">
        ${fld('От инвентарен №', 'sigFrom', {})}
        ${fld('До инвентарен №', 'sigTo', {})}
      </div>
      <div class="toolbar"><button class="btn pri" onclick="printSignatureLabelsRange()">Печат на диапазон</button>
      <button class="btn" onclick="printSignatureLabelsAll()">Всички</button></div>
      <div style="margin-top:10px;width:170px;border:1px solid var(--rule2);background:#fff;padding:8px 6px;text-align:center">
        ${sigLblCard({ udk: '821.163.2-31', author_mark: 'В-15', inv_number: 1, barcode: '1' })}
      </div>
      <div class="hint" style="margin-top:6px">Пример за оформлението.</div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Проверка на четеца</h3>
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        <div style="width:200px;border:1px solid var(--rule2);background:#fff;padding:9px;text-align:center">
          ${code39svg('TEST-123', 170, 48)}<div style="font-size:11px;margin-top:3px">TEST-123</div>
        </div>
        <div style="flex:1;min-width:240px">
          <input id="testScan" placeholder="Сканирайте пробния баркод тук…" autocomplete="off">
          <div id="testOut" class="hint" style="margin-top:7px">Ако се появи TEST-123, четецът е настроен правилно.</div>
        </div>
      </div>
    </div>`;
  const t = $('#testScan');
  t.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return; e.preventDefault();
    $('#testOut').innerHTML = t.value.trim().toUpperCase() === 'TEST-123'
      ? '<b style="color:var(--green)">Отлично — четецът работи и добавя Enter накрая.</b>'
      : 'Прочетено: <b>' + esc(t.value) + '</b> — различава се от очакваното TEST-123.';
  });
}
async function saveLabelFormat() {
  const d = formData('#lblFmtF');
  await call(window.api.settings.updateLabelFormat(d), 'Форматът за печат на етикети е записан.');
  await loadSettingsCache();
  renderLabels(); // прегледите се преначертават с новите размери
}
window.saveLabelFormat = saveLabelFormat;

/* ---------------- Лого на организацията ---------------- */
async function chooseLogo() {
  const res = await window.api.settings.chooseLogo();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast('Логото е записано — влиза автоматично в документите и читателските карти.', 'ok');
  markSaved();
  await loadSettingsCache();
  if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.chooseLogo = chooseLogo;
async function clearLogo() {
  if (!confirm('Премахване на логото от документите и картите?')) return;
  await call(window.api.settings.clearLogo(), 'Логото е премахнато.');
  await loadSettingsCache();
  if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.clearLogo = clearLogo;
async function activeBooks() {
  const books = await call(window.api.books.list(''));
  return (books || []).filter(b => b.status !== 'отчислен');
}
async function printLabelsRange() {
  const from = parseInt($('[name=lblFrom]').value, 10), to = parseInt($('[name=lblTo]').value, 10);
  if (!from || !to || to < from) return toast('Въведете валиден диапазон от инвентарни номера.', 'err');
  const rows = (await activeBooks()).filter(b => b.inv_number >= from && b.inv_number <= to).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Няма документи в този диапазон.', 'err');
  printLabelSheet(rows.map(lblCard).join(''), 'fund');
}
window.printLabelsRange = printLabelsRange;
async function printLabelsAll() {
  const rows = (await activeBooks()).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Фондът е празен.', 'err');
  printLabelSheet(rows.map(lblCard).join(''), 'fund');
}
window.printLabelsAll = printLabelsAll;
async function printSignatureLabelsRange() {
  const from = parseInt($('[name=sigFrom]').value, 10), to = parseInt($('[name=sigTo]').value, 10);
  if (!from || !to || to < from) return toast('Въведете валиден диапазон от инвентарни номера.', 'err');
  const rows = (await activeBooks()).filter(b => b.inv_number >= from && b.inv_number <= to).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Няма документи в този диапазон.', 'err');
  printLabelSheet(rows.map(sigLblCard).join(''), 'sig');
}
window.printSignatureLabelsRange = printSignatureLabelsRange;
async function printSignatureLabelsAll() {
  const rows = (await activeBooks()).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Фондът е празен.', 'err');
  printLabelSheet(rows.map(sigLblCard).join(''), 'sig');
}
window.printSignatureLabelsAll = printSignatureLabelsAll;
async function printCardsAll() {
  const readers = await call(window.api.readers.list(''));
  const rows = (readers || []).filter(r => r.status !== 'прекратен');
  if (!rows.length) return toast('Няма активни читатели.', 'err');
  printLabelSheet(rows.map(readerCardHtml).join(''), 'card');
}
window.printCardsAll = printCardsAll;
async function printReaderCard(id) {
  const r = await call(window.api.readers.get(id));
  if (!r) return;
  const loans = await call(window.api.loans.byReader(id)) || [];
  setPrintPage({ name: `Читателски картон — ${r.name}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ЧИТАТЕЛСКИ КАРТОН № ${esc(r.card_no || '')}</h2>
    <div class="pmeta">
    <b>Име:</b> ${esc(r.name)}<br>
    <b>ЕГН:</b> ${esc(r.egn || '…')} &nbsp; <b>Лична карта:</b> № ${esc(r.id_card_no || '…')}, издадена на ${r.id_card_date ? bg(r.id_card_date) : '…'} от ${esc(r.id_card_issuer || '…')}<br>
    <b>Постоянен адрес:</b> ${esc(r.address || '…')}<br>
    <b>Телефон:</b> ${esc(r.phone || '…')} &nbsp; <b>Имейл:</b> ${esc(r.email || '…')}<br>
    <b>Категория:</b> ${esc(r.category || '')} &nbsp; <b>Записан на:</b> ${bg(r.registered_at)}${r.re_registered_at ? ' · пререгистриран на ' + bg(r.re_registered_at) : ''}</div>
    <div style="width:60mm;border:1px solid #000;padding:2mm;text-align:center;margin-bottom:5mm">
      ${code39svg(r.card_no || String(r.id), 200, 50)}<div style="font-family:monospace;font-size:9pt">${esc(r.card_no || '')}</div></div>
    <table><thead><tr><th>Дата на заемане</th><th>Инв. №</th><th>Заглавие</th><th>Срок</th><th>Върнат на</th></tr></thead><tbody>
    ${loans.slice(0, 14).map(l => `<tr><td>${bg(l.date_out)}</td><td>${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
      <td>${bg(l.date_due) || ''}</td><td>${l.date_in ? bg(l.date_in) : ''}</td></tr>`).join('')}
    </tbody></table>
    ${ssig(['Подпис на читателя: …………………', 'Библиотекар: ' + esc((SETTINGS_CACHE || {}).librarian || '…………………')])}</div>`);
}
window.printReaderCard = printReaderCard;
async function printOverdueNotices() {
  const rows = await call(window.api.loans.overdueByReader());
  if (!rows || !rows.length) return toast('Няма просрочени заемания.', 'err');
  const s = SETTINGS_CACHE || {};
  setPrintPage({ name: 'Напомнителни писма — ' + bg(today()), landscape: false, margin: '14mm 12mm' });
  doPrint(rows.map(r => `<div class="pdoc">${shead()}
    <h2>НАПОМНИТЕЛНО ПИСМО</h2>
    <div class="pmeta">До: <b>${esc(r.name)}</b><br>
    Адрес: ${esc(r.address2 || r.address || '…………………')}<br><br>
    Уважаеми/а читателю,<br><br>
    Съгласно чл. 43, ал. 1 от Наредба № 3 от 18.11.2014 г. всеки ползвател е длъжен да върне заетите библиотечни документи
    в определения срок. Според нашата документация срокът на изброените по-долу документи е изтекъл.</div>
    <table><thead><tr><th>Инв. №</th><th>Заглавие</th><th>Зает на</th><th>Срок</th></tr></thead><tbody>
    ${r.loans.map(l => `<tr><td>${l.inv_number ?? ''}</td><td>${esc(l.title)}</td><td>${bg(l.date_out)}</td><td>${bg(l.date_due)}</td></tr>`).join('')}
    </tbody></table>
    <div class="pmeta">Общо дължимо обезщетение: <b>${mny(r.fine)}</b> (${s.fine_per_day} лв./ден забава по чл. 43, ал. 2).</div>
    ${ssig(['Библиотекар: ' + esc(s.librarian || '…………………')])}</div>`).join(''));
}
window.printOverdueNotices = printOverdueNotices;

/* ---------------- Одитна следа ---------------- */
let ODIT_Q = '';
async function renderOdit() {
  const rows = await call(window.api.audit.list(ODIT_Q));
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note">Одитната следа записва автоматично кой служител какво е извършил. Задайте името си долу
    вляво в страничния панел, за да се отбелязва коректно.</div>
    <div class="toolbar">
      <input id="oditSearch" placeholder="Търсене по служител, действие, подробност…" value="${esc(ODIT_Q)}">
      <span style="flex:1"></span>
      <span class="hint">${rows.length} записа</span>
      <button class="btn sm" onclick="exportAuditCSV()">CSV</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Дата/час</th><th>Служител</th><th>Действие</th><th>Подробност</th></tr></thead><tbody>
    ${rows.length ? rows.map(a => `<tr><td class="num">${new Date(a.ts).toLocaleString('bg-BG')}</td><td>${esc(a.user || '—')}</td>
      <td><span class="badge">${esc(a.action)}</span></td><td style="font-size:12.5px">${esc(a.detail)}</td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">Няма записи.</td></tr>`}
    </tbody></table></div>`;
  $('#oditSearch').addEventListener('input', debounce(e => { ODIT_Q = e.target.value; renderOdit(); }, 300));
}
async function exportAuditCSV() {
  const rows = await call(window.api.audit.list(ODIT_Q));
  if (!rows) return;
  const h = ['Дата/час', 'Служител', 'Действие', 'Подробност'];
  const csv = [h.join(';')].concat(rows.map(a => [new Date(a.ts).toLocaleString('bg-BG'), a.user, a.action, a.detail]
    .map(x => '"' + String(x ?? '').replace(/"/g, '""') + '"').join(';'))).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'odit.csv'; a.click();
  URL.revokeObjectURL(url);
}
window.exportAuditCSV = exportAuditCSV;

/* ---------------- Настройки ---------------- */
function fmtBytes(n) {
  if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' МБ';
  return Math.round(n / 1024) + ' КБ';
}
function fmtDateTime(ms) {
  const d = new Date(ms);
  return bg(d.toISOString().slice(0, 10)) + ' ' + d.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}
async function renderSetup() {
  const [s, dbLoc, backups, employees, cats, limits] = await Promise.all([
    call(window.api.settings.get()), call(window.api.dbLocation.get()),
    call(window.api.backup.list()), call(window.api.employees.list()),
    call(window.api.categories.list()), call(window.api.limits.usage())
  ]);
  if (!s) return;
  window._EMPLOYEES_ALL = employees || [];
  $('#view').innerHTML = `
    ${needsSetup(s) ? `<div class="note" style="border-left-color:var(--brass)">
      <b>Първоначална настройка.</b> Попълнете данните на библиотеката по-долу и натиснете
      „Запиши настройките“. Те се използват автоматично навсякъде — в заглавията на актовете,
      протоколите и регистрите за печат, в баркод етикетите и читателските карти, и в лентата
      вляво. Променят се само тук и важат веднага за всички разпечатки.</div>` : ''}
    <form id="stF" onsubmit="return false">
    <div class="grid g2">
      <div class="card"><h3 style="margin-top:0">Библиотека</h3>
        ${fld('Организация', 'org', { val: s.org })}
        ${fld('Наименование на библиотеката', 'lib_name', { val: s.lib_name })}
        ${fld('Населено място', 'place', { val: s.place })}
        <div class="grid g2">${fld('ЕИК / БУЛСТАТ', 'bulstat', { val: s.bulstat || '' })}${fld('Рег. № в Мин. на културата', 'reg_no', { val: s.reg_no || '' })}</div>
        <div class="grid g2">${fld('Ръководител', 'director', { val: s.director || '' })}${fld('Длъжност', 'director_role', { val: s.director_role || '' })}</div>
        ${fld('Библиотекар', 'librarian', { val: s.librarian || '' })}
        ${fld('Адрес на сайта', 'cat_url', { val: s.cat_url || '' })}
        <div class="field"><label>Лого на организацията</label>
          <div class="logoBox">
            ${s.logo ? `<img src="${esc(s.logo)}" alt="лого">`
                     : '<div class="logoEmpty">няма<br>лого</div>'}
            <div>
              <div class="toolbar" style="margin:0">
                <button type="button" class="btn" onclick="chooseLogo()">${s.logo ? 'Смени…' : 'Избери файл…'}</button>
                ${s.logo ? '<button type="button" class="btn dgr" onclick="clearLogo()">Премахни</button>' : ''}
              </div>
              <div class="hint" style="margin-top:6px">PNG, JPG, GIF, WEBP или SVG, до 512 KB.
              Влиза автоматично в заглавната част на всички документи за печат — актове, протоколи,
              инвентарна книга, КДБФ, картони, напомнителни писма — и в читателските карти.</div>
            </div>
          </div>
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">Обслужване</h3>
        <div class="grid g2">
          ${fld('Срок за заемане (дни)', 'loan_days', { val: s.loan_days, type: 'number' })}
          ${fld('Максимум документи на читател', 'max_books', { val: s.max_books, type: 'number' })}
          ${fld('Брой продължения', 'extensions_count', { val: s.extensions_count, type: 'number' })}
          ${fld('Дни на продължение', 'extension_days', { val: s.extension_days, type: 'number' })}
          ${fld('Обезщетение за забава (лв./ден)', 'fine_per_day', { val: s.fine_per_day, type: 'number', step: '0.01' })}
          ${fld('Годишна такса (лв.)', 'annual_fee', { val: s.annual_fee, type: 'number', step: '0.01' })}
        </div>
        <div class="grid g2">
          ${fld('Фонд на свободен достъп (%)', 'free_access_pct', { val: s.free_access_pct, type: 'number' })}
          ${fld('Следващ инвентарен номер', 'next_inv_number', { val: s.next_inv_number, type: 'number' })}
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><h3 style="margin-top:0">Постоянна комисия</h3>
      <div class="grid g3">
        ${fld('Член 1 (библиотекар)', 'committee1', { val: s.committee1 || '' })}
        ${fld('Член 2', 'committee2', { val: s.committee2 || '' })}
        ${fld('Член 3 (счетоводител)', 'committee3', { val: s.committee3 || '' })}
      </div>
      <div class="hint">Комисията се назначава със заповед на ръководителя; участието на библиотекар и счетоводител е задължително (чл. 35, ал. 1).</div>
    </div>
    <div class="toolbar" style="margin-top:14px"><button type="button" class="btn pri" onclick="saveSetup()">Запиши настройките</button></div>
    </form>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Антивирусна защита</h3>
      <div class="note" style="margin-top:0">Докато инсталаторът е без закупен цифров подпис, Windows
      Defender и други антивирусни може да спират инсталирането или да заключват файловете на
      програмата — базата данни, резервните копия, папката на каталога. Това е <b>фалшива
      тревога</b> заради липсващия подпис, не признак за зловреден код.</div>
      <div class="toolbar">
        <button class="btn pri" onclick="avScript()">Скрипт за Defender…</button>
        <button class="btn" onclick="avCopyDirs()">Копирай папките (за AVG и др.)</button>
        <button class="btn" onclick="avHelp()">Какво да направя?</button>
      </div>
      <div class="hint" style="margin-top:8px">Скриптът добавя папките на програмата в изключенията
      на Windows Defender и я разрешава през „Защита от рансъмуер“. Записва се като файл, който се
      изпълнява <b>веднъж, като администратор</b> (десен бутон → „Изпълни като администратор“).</div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Внасяне на данни от друга система</h3>
      <div class="note" style="margin-top:0">Ако библиотеката е водила фонда в друга програма
      (<b>АБ</b>, <b>iLib</b>) или в таблица на Excel, записите се внасят оттам, вместо да се
      преписват на ръка. Четат се <b>CSV</b>, <b>TXT</b>, <b>TSV</b> и <b>XLSX</b>; кирилицата в
      стари файлове (Windows-1251) се разпознава сама.</div>
      <div class="toolbar"><button class="btn pri" onclick="importChoose()">Избери файл за внасяне…</button></div>
      <div class="hint" style="margin-top:8px">След избора се показва как са разпознати колоните и
      първите редове от файла — съответствието се проверява и поправя, преди нещо да се запише.
      <b>Направете резервно копие преди голямо внасяне.</b></div>
    </div>

    ${categoriesCardHtml(cats)}

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Ограничения на записите</h3>
      <div class="note" style="margin-top:0">Горна граница за броя записи в програмата. <b>0 означава без
      ограничение.</b> Проверява се само при добавяне на нов запис — вече въведените данни остават
      достъпни и редактируеми дори ако лимитът бъде намален по-късно.</div>
      <form id="limF" onsubmit="return false"><div class="grid g2">
        ${fld('Лимит на документите във фонда', 'limit_books', { val: limits ? limits.limitBooks : 0, type: 'number',
          hint: limits ? 'в момента: ' + limits.books.toLocaleString('bg-BG') : '' })}
        ${fld('Лимит на читателите', 'limit_readers', { val: limits ? limits.limitReaders : 0, type: 'number',
          hint: limits ? 'в момента: ' + limits.readers.toLocaleString('bg-BG') : '' })}
      </div></form>
      ${limits && (limits.limitBooks > 0 || limits.limitReaders > 0) ? `
        <div style="margin-top:6px">
          ${limits.limitBooks > 0 ? limitBarHtml('Документи', limits.books, limits.limitBooks) : ''}
          ${limits.limitReaders > 0 ? limitBarHtml('Читатели', limits.readers, limits.limitReaders) : ''}
        </div>` : ''}
      <div class="toolbar"><button class="btn pri" onclick="saveLimits()">Запиши ограниченията</button></div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Външен вид — цветова тема</h3>
      <div class="hint" style="margin-top:0;margin-bottom:10px">Избраната тема се прилага веднага на всички компютри, които ползват тази база данни.</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        ${THEMES.map(t => `<button type="button" onclick="setTheme('${t.id}')"
          style="width:112px;border:2px solid ${s.theme === t.id ? 'var(--ink)' : 'var(--rule2)'};border-radius:4px;padding:0;overflow:hidden;cursor:pointer;background:none;text-align:left">
          <span style="display:block;height:36px;background:${t.spine}"></span>
          <span style="display:block;height:15px;background:${t.brass}"></span>
          <span style="display:block;padding:6px 8px;font-size:11px;background:${t.paper};color:#1B1813">${esc(t.name)}${s.theme === t.id ? ' ✓' : ''}</span>
        </button>`).join('')}
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Работа в мрежа (няколко компютъра)</h3>
      <div class="note" style="margin-top:0">За да работят няколко работни компютъра с една и съща база данни, посочете
      папка на <b>споделен мрежов диск</b> (напр. картографиран диск <code>Z:\\</code> или път от вида
      <code>\\\\СЪРВЪР\\споделена-папка</code>) — всички програми, сочещи към тази папка, ще виждат едни и същи данни.</div>
      <div class="note w"><b>Важно за надеждността:</b> SQLite (форматът на базата данни) официално <b>не е препоръчан</b>
      за едновременен запис от няколко компютъра върху мрежов диск (SMB) — заключването на файлове по мрежата не винаги
      работи коректно и в редки случаи може да доведе до повредена база. Препоръки: работете един по един, когато е
      възможно; правете редовно резервно копие на файла <code>library.db</code>; ако забележите грешки „database is
      locked“ или повредени данни — върнете последното добро резервно копие. За библиотека с интензивна едновременна
      работа от много станции е по-безопасно решение истинска клиент-сървър база данни, което е извън обхвата на тази версия.</div>
      <div class="hint">Текуща папка: <b style="font-family:var(--mono)">${esc(dbLoc ? dbLoc.folder : '')}</b>
      ${dbLoc && dbLoc.isDefault ? ' (по подразбиране, локална)' : ' (персонализирана)'}</div>
      <div class="toolbar">
        <button class="btn pri" onclick="chooseDbLocation()">Избери мрежова/друга папка…</button>
        ${dbLoc && !dbLoc.isDefault ? '<button class="btn" onclick="resetDbLocation()">Върни към локалната по подразбиране</button>' : ''}
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Служители</h3>
      <div class="note" style="margin-top:0">Списъкът е общ за всички компютри, свързани към тази база данни. Изборът
      „кой служител работи в момента“ (долу вляво в лентата) е локален за всеки компютър и записва избраното име в
      одитната следа при всяко действие.</div>
      <div class="toolbar"><button class="btn pri" onclick="employeeForm()">+ Нов служител</button></div>
      ${employees && employees.length ? `<div class="wrap" style="margin-top:10px"><table class="ledger"><thead><tr>
        <th>Име</th><th>Състояние</th><th></th></tr></thead><tbody>
        ${employees.map(e => `<tr><td>${esc(e.name)}</td>
          <td>${e.active ? '<span class="badge ok">активен</span>' : '<span class="badge warn">неактивен</span>'}</td>
          <td>
            <button class="btn sm" onclick="employeeForm(${e.id})">Редакция</button>
            <button class="btn sm" onclick="toggleEmployeeActive(${e.id},${e.active})">${e.active ? 'Деактивирай' : 'Активирай'}</button>
            <button class="btn sm dgr" onclick="deleteEmployee(${e.id})">Изтрий</button>
          </td></tr>`).join('')}
        </tbody></table></div>` : '<div class="hint">Все още няма добавени служители.</div>'}
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Резервно копие</h3>
      <div class="note" style="margin-top:0">Всяко действие (нов документ, заемане, връщане, отчисляване и т.н.) се
      записва автоматично в базата данни — няма нужда от бутон „Запази“ за самите данни. Освен това програмата прави
      <b>автоматично резервно копие веднъж на ден</b> (при първото стартиране за деня) в подпапка <code>backups</code>
      до базата данни, като пази последните 30 дни. Копията служат за възстановяване при срив на компютъра/програмата,
      или за пренасяне на данните на друг компютър със същата програма.</div>
      <div class="toolbar">
        <button class="btn pri" onclick="backupNowForm()">Направи резервно копие сега…</button>
        <button class="btn" onclick="restoreBackupBrowse()">Възстанови от файл…</button>
      </div>
      ${backups && backups.length ? `<div class="wrap" style="margin-top:10px"><table class="ledger"><thead><tr>
        <th>Файл</th><th>Дата и час</th><th>Размер</th><th>Вид</th><th></th></tr></thead><tbody>
        ${backups.map(b => `<tr><td style="font-family:var(--mono);font-size:12px">${esc(b.name)}</td>
          <td class="num">${fmtDateTime(b.mtime)}</td><td class="num">${fmtBytes(b.size)}</td>
          <td>${b.auto ? '<span class="badge">автоматично</span>' : '<span class="badge ok">ръчно</span>'}
              ${b.encrypted ? '<span class="badge" title="Защитено с парола">🔒 криптирано</span>' : ''}</td>
          <td><button class="btn sm" onclick="restoreBackupFromList('${esc(b.path).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">Възстанови</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="hint">Все още няма направени резервни копия.</div>'}
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Обновяване</h3>
      ${updateStatusHtml()}
    </div>
    <div class="hint" style="margin-top:20px;font-family:var(--mono);font-size:10.5px">${esc(APP_CREDIT_TEXT)}</div>`;
}
function employeeForm(id) {
  const emp = id ? (window._EMPLOYEES_ALL || []).find(x => x.id === id) : null;
  modal(emp ? 'Редакция на служител' : 'Нов служител', `
    <form id="empF" onsubmit="return false">
      ${fld('Име', 'name', { val: emp ? emp.name : '', req: 1 })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveEmployee(${id || 'null'})">Запиши</button>`);
}
window.employeeForm = employeeForm;
async function saveEmployee(id) {
  const d = formData('#empF');
  if (!d.name.trim()) return toast('Въведете име.', 'err');
  if (id) await call(window.api.employees.update({ id, name: d.name }), 'Служителят е обновен.');
  else await call(window.api.employees.create(d.name), 'Служителят е добавен.');
  closeModal(); renderSetup();
}
window.saveEmployee = saveEmployee;
async function toggleEmployeeActive(id, active) {
  await call(window.api.employees.update({ id, active: active ? 0 : 1 }), active ? 'Служителят е деактивиран.' : 'Служителят е активиран.');
  renderSetup();
}
window.toggleEmployeeActive = toggleEmployeeActive;
async function deleteEmployee(id) {
  if (!confirm('Изтриване на служителя? Записите в одитната следа с неговото име остават непроменени.')) return;
  await call(window.api.employees.delete(id), 'Служителят е изтрит.');
  renderSetup();
}
window.deleteEmployee = deleteEmployee;
function backupNowForm() {
  modal('Ръчно резервно копие', `
    <div class="note" style="margin-top:0">Копието може да се защити с парола — препоръчително, ако файлът
    ще пътува на USB или ще се изпраща по интернет, тъй като съдържа лични данни на читателите (ЕГН, адреси).</div>
    <form id="bkF" onsubmit="return false">
      <label class="chk"><input type="checkbox" id="bkEnc" onchange="document.getElementById('bkPassWrap').style.display=this.checked?'block':'none'">
        <span>Защити копието с парола (криптиране AES-256)</span></label>
      <div id="bkPassWrap" style="display:none">
        ${fld('Парола', 'password', { type: 'password' })}
        ${fld('Повтори паролата', 'password2', { type: 'password' })}
        <div class="note w" style="margin-top:0"><b>Пазете паролата.</b> Без нея това копие е
        невъзстановимо — няма начин за отключване, ако бъде забравена.</div>
      </div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="backupNow()">Направи копие</button>`);
}
window.backupNowForm = backupNowForm;
async function backupNow() {
  const enc = $('#bkEnc') && $('#bkEnc').checked;
  let password = '';
  if (enc) {
    const d = formData('#bkF');
    if (!d.password) return toast('Въведете парола или махнете отметката за криптиране.', 'err');
    if (d.password !== d.password2) return toast('Двете пароли не съвпадат.', 'err');
    password = d.password;
  }
  const res = await window.api.backup.now({ password });
  if (!res.ok) return toast(res.error, 'err');
  closeModal();
  toast((res.encrypted ? 'Криптирано резервно копие записано: ' : 'Резервно копие записано: ') + res.data, 'ok');
  renderSetup();
}
window.backupNow = backupNow;
function askBackupPassword(path, fromList) {
  modal('Криптирано резервно копие', `
    <div class="note" style="margin-top:0">Файлът е защитен с парола. Въведете паролата, с която е направен.</div>
    <form id="rsF" onsubmit="return false">${fld('Парола', 'password', { type: 'password' })}</form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="restoreWithPassword('${esc(path).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', ${fromList ? 'true' : 'false'})">Възстанови</button>`);
}
async function restoreWithPassword(path, fromList) {
  const d = formData('#rsF');
  if (!d.password) return toast('Въведете парола.', 'err');
  const res = fromList
    ? await window.api.backup.restoreFromList({ path, password: d.password })
    : await window.api.backup.restoreBrowse({ path, password: d.password });
  if (!res.ok) return toast(res.error, 'err');
}
window.restoreWithPassword = restoreWithPassword;
const RESTORE_WARN = 'Възстановяването ще замени текущите данни в програмата и ще я рестартира. ' +
  'Текущата база се пази автоматично като допълнително копие преди възстановяването. Продължавате ли?';
async function restoreBackupFromList(path) {
  if (!confirm(RESTORE_WARN)) return;
  const res = await window.api.backup.restoreFromList({ path });
  if (!res.ok) return toast(res.error, 'err');
  if (res.data && res.data.needsPassword) askBackupPassword(res.data.path, true);
}
window.restoreBackupFromList = restoreBackupFromList;
async function restoreBackupBrowse() {
  if (!confirm('Ще изберете файл с резервно копие (.db или .invbak) от компютъра/USB/мрежов диск. ' + RESTORE_WARN)) return;
  const res = await window.api.backup.restoreBrowse();
  if (!res.ok) return toast(res.error, 'err');
  if (res.data && res.data.needsPassword) askBackupPassword(res.data.path, false);
}
window.restoreBackupBrowse = restoreBackupBrowse;
async function chooseDbLocation() {
  if (!confirm('Програмата ще копира текущата база данни в новата папка и ще се рестартира. Продължавате ли?')) return;
  const res = await window.api.dbLocation.choose();
  if (!res.ok) return toast(res.error, 'err');
}
window.chooseDbLocation = chooseDbLocation;
async function resetDbLocation() {
  if (!confirm('Връщане към локалната база данни по подразбиране (тази на мрежовия диск остава непроменена)? Програмата ще се рестартира.')) return;
  await window.api.dbLocation.resetDefault();
}
window.resetDbLocation = resetDbLocation;
function updateStatusHtml() {
  const st = UPDATE_STATUS || { state: 'idle' };
  const line = {
    idle: '', checking: 'Проверка за обновления…',
    available: 'Намерена е нова версия ' + (st.version || '') + ' — изтегля се…',
    'not-available': 'Инсталирана е последната версия.',
    downloading: 'Изтегля се обновление' + (st.percent ? ' — ' + st.percent + '%' : '') + '…',
    downloaded: 'Версия ' + (st.version || '') + ' е готова за инсталиране.',
    error: 'Грешка при проверка: ' + (st.message || '')
  }[st.state] || '';
  return `
    <div class="hint" style="margin-bottom:10px">Програмата проверява автоматично за нова версия в GitHub при всяко
    стартиране (изисква интернет връзка). Изтеглената версия се инсталира при следващото затваряне на програмата.</div>
    ${line ? `<div class="note" style="margin-top:0">${esc(line)}</div>` : ''}
    <div class="toolbar">
      <button class="btn" onclick="checkForUpdatesNow()">Провери сега</button>
      ${st.state === 'downloaded' ? '<button class="btn pri" onclick="installUpdateNow()">Инсталирай и рестартирай</button>' : ''}
    </div>`;
}
function limitBarHtml(label, used, limit) {
  const pct = Math.min(100, Math.round(used / limit * 100));
  const cls = pct >= 100 ? 'full' : pct >= 85 ? 'near' : '';
  return `<div style="margin-top:8px">
    <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
      <span>${esc(label)}</span><b>${used.toLocaleString('bg-BG')} / ${limit.toLocaleString('bg-BG')}</b></div>
    <div class="bar"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
    ${pct >= 85 ? `<div class="hint" style="margin-top:4px;color:var(--red)">${pct >= 100
      ? 'Лимитът е достигнат — нови записи не могат да се добавят.'
      : 'Наближавате лимита.'}</div>` : ''}
  </div>`;
}
async function saveLimits() {
  const d = formData('#limF');
  await call(window.api.limits.update(d), 'Ограниченията са записани.');
  renderSetup();
}
window.saveLimits = saveLimits;
async function saveSetup() {
  const d = formData('#stF'); d.id = 1;
  await call(window.api.settings.update(d), 'Настройките са записани.');
  await loadSettingsCache();
  // Пречертава текущия изглед, за да влязат новите данни веднага навсякъде, където
  // се показват — без да се излиза и влиза наново в раздела.
  if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.saveSetup = saveSetup;

/* ---------------- Старт ---------------- */
initUserBadge();
initAppCredit();
initSavedIndicator();
initAutoUpdateUI();
// При съвсем нова инсталация програмата отваря направо „Настройки“ — данните на
// библиотеката трябва да се въведат веднъж, преди да има смисъл от останалите раздели.
loadSettingsCache().then(s => {
  if (needsSetup(s) && !location.hash) location.hash = '#setup';
  route();
});

/* ============================================================================
   КРАЕЗНАНИЕ: аналитично описание, персоналии, летопис
   Тези три раздела съдържат данните, които се създават в самата библиотека и не
   могат да бъдат получени отвън — статии за селото, сведения за местни дейци и
   хронология на читалищната дейност.
   ============================================================================ */

/* ---------------- Аналитично описание ---------------- */
let ANL_Q = '', ANL_YEAR = '', ANL_LOCAL = false;
async function renderAnalytics() {
  const [rows, years] = await Promise.all([
    call(window.api.analytics.list({ q: ANL_Q, year: ANL_YEAR, onlyLocal: ANL_LOCAL })),
    call(window.api.analytics.years())
  ]);
  if (!rows) return;
  const total = rows.length, local = rows.filter(r => r.is_local).length;
  $('#view').innerHTML = `
    <div class="note"><b>Аналитично описание.</b> Описват се отделни статии от вестници и списания и
    части от книги — това, което не се вижда в обикновения каталог. За малката библиотека тук се
    натрупва краеведският масив: материали за селото, за читалището и за местните хора, които не
    съществуват описани никъде другаде.</div>

    <div class="toolbar">
      <button class="btn pri" onclick="analyticForm()">+ Ново описание</button>
      <input type="search" id="anlQ" placeholder="Търсене по заглавие, автор, ключови думи, източник…"
        value="${esc(ANL_Q)}" oninput="anlSearch(this.value)">
      <select onchange="anlYear(this.value)">
        <option value="">— всички години —</option>
        ${(years || []).map(y => `<option value="${esc(y.year)}" ${ANL_YEAR === y.year ? 'selected' : ''}>
          ${esc(y.year)} (${y.n})</option>`).join('')}
      </select>
      <label class="chk" style="margin:0"><input type="checkbox" ${ANL_LOCAL ? 'checked' : ''}
        onchange="anlLocal(this.checked)"> само краеведски</label>
    </div>

    <div class="kpis">
      ${kpi('📰', total, 'Описани статии', ANL_YEAR ? 'за ' + ANL_YEAR + ' г.' : 'общо в базата')}
      ${kpi('🏡', local, 'Краеведски', 'за селото и района')}
    </div>

    ${rows.length ? `<div class="wrap"><table class="ledger"><thead><tr>
      <th>Автор и заглавие</th><th style="width:30%">Източник</th><th style="width:70px">Год.</th>
      <th style="width:90px">Стр.</th><th style="width:130px"></th></tr></thead><tbody>
      ${rows.map(a => `<tr>
        <td><b>${esc(a.title)}</b>${a.subtitle ? ' : ' + esc(a.subtitle) : ''}
          ${a.author ? `<br><span class="hint">${esc(a.author)}</span>` : ''}
          ${a.is_local ? '<span class="tag tagLocal">краеведски</span>' : ''}</td>
        <td class="hint">${esc(analyticSource(a))}</td>
        <td class="num">${esc(a.year || '')}</td>
        <td class="num">${esc(a.pages || '')}</td>
        <td><button class="btn sm" onclick="analyticForm(${a.id})">Редакция</button>
            <button class="btn sm dgr" onclick="analyticDelete(${a.id})">Изтрий</button></td></tr>`).join('')}
      </tbody></table></div>`
    : `<div class="empty"><h3>Няма описани статии</h3>
        <p>Започнете от най-близкото: статии за селото в областния вестник, материали в читалищни
        сборници, глави от краеведски книги.</p></div>`}`;
}
function analyticSource(a) {
  if (a.source_kind === 'периодика' && a.periodical_title) {
    return a.periodical_title + (a.issue ? ', бр. ' + a.issue : '') + (a.issue_date ? ' от ' + bg(a.issue_date) : '');
  }
  if (a.source_kind === 'книга' && a.book_title) {
    return [a.book_author, a.book_title].filter(Boolean).join('. ') +
      (a.book_inv ? ' (инв. № ' + a.book_inv + ')' : '');
  }
  return a.source_text || '—';
}
function anlSearch(v) { ANL_Q = v; clearTimeout(window._anlT); window._anlT = setTimeout(renderAnalytics, 300); }
window.anlSearch = anlSearch;
function anlYear(v) { ANL_YEAR = v; renderAnalytics(); }
window.anlYear = anlYear;
function anlLocal(v) { ANL_LOCAL = v; renderAnalytics(); }
window.anlLocal = anlLocal;

async function analyticForm(id) {
  const [a, pers, sug] = await Promise.all([
    id ? call(window.api.analytics.get(id)) : null,
    call(window.api.periodicals.list()),
    loadAuthSuggest()
  ]);
  const v = a || { source_kind: 'периодика', is_local: 1, year: String(new Date().getFullYear()) };
  const perOpts = (pers || []).map(p => ({ v: p.id, t: p.title }));
  modal(id ? 'Редакция на описание' : 'Ново аналитично описание', `
    <form id="anlF" onsubmit="return false">
    <fieldset><legend>Статията</legend>
      <div class="grid g2">
        ${fld('Заглавие на статията', 'title', { val: v.title || '', req: 1 })}
        ${fld('Автор', 'author', { val: v.author || '', list: 'author' })}
      </div>
      <div class="grid g4">
        ${fld('Подзаглавие', 'subtitle', { val: v.subtitle || '' })}
        ${fld('Година', 'year', { val: v.year || '' })}
        ${fld('Страници', 'pages', { val: v.pages || '', hint: 'напр. „12 – 14“' })}
        ${fld('УДК', 'udk', { val: v.udk || '', list: 'udk' })}
      </div>
    </fieldset>
    <fieldset><legend>Източник</legend>
      ${fld('Вид източник', 'source_kind', { type: 'select', allowEmpty: false, val: v.source_kind,
        opts: ['периодика', 'книга', 'друго'] })}
      <div class="grid g3">
        ${fld('Периодично издание', 'periodical_id', { type: 'select', val: v.periodical_id,
          opts: perOpts, emptyLabel: '— изберете —' })}
        ${fld('Брой', 'issue', { val: v.issue || '' })}
        ${fld('Дата на броя', 'issue_date', { val: v.issue_date || '', type: 'date' })}
      </div>
      ${fld('Книга от фонда (инв. № или заглавие)', 'book_pick', { val: v.book_id ? (v.book_author ? v.book_author + '. ' : '') + (v.book_title || '') : '',
        hint: 'попълва се само при вид „книга“ — изберете от списъка' , list: 'anlBooks' })}
      <input type="hidden" name="book_id" value="${esc(v.book_id || '')}">
      ${fld('Описание на източника със свободен текст', 'source_text', { val: v.source_text || '',
        hint: 'когато изданието не е във фонда — напр. „100 вести, бр. 145 от 12.07.2019“' })}
    </fieldset>
    <fieldset><legend>Съдържание</legend>
      <div class="grid g2">
        ${fld('Ключови думи', 'keywords', { val: v.keywords || '', list: 'keywords', hint: 'през запетая' })}
        ${fld('Забележка', 'note', { val: v.note || '' })}
      </div>
      ${fld('Анотация', 'annotation', { type: 'textarea', val: v.annotation || '', rows: 3 })}
      <label class="chk"><input type="checkbox" name="is_local" ${v.is_local ? 'checked' : ''}>
        <span>Краеведски материал — за селото, читалището или местни хора</span></label>
    </fieldset>
    </form>
    ${datalistsHtml(sug || {})}
    <datalist id="dl_anlBooks"></datalist>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveAnalytic(${id || 'null'})">Запиши</button>`);
  // Списъкът с книги се пълни при писане, за да не се зареждат хиляди записи наведнъж.
  const bp = $('#anlF [name=book_pick]');
  if (bp) bp.addEventListener('input', async () => {
    const q = bp.value.trim();
    const hidden = $('#anlF [name=book_id]');
    if (q.length < 2) { hidden.value = ''; return; }
    const found = await call(window.api.links.search({ kind: 'книга', q }));
    const dl = $('#dl_anlBooks');
    dl.innerHTML = (found || []).map(f => `<option value="${esc(f.label)}"></option>`).join('');
    const exact = (found || []).find(f => f.label === q);
    hidden.value = exact ? exact.id : '';
  });
}
window.analyticForm = analyticForm;
async function saveAnalytic(id) {
  const d = formData('#anlF');
  if (!d.title.trim()) return toast('Заглавието на статията е задължително.', 'err');
  delete d.book_pick;
  d.id = id;
  if (id) await call(window.api.analytics.update(d), 'Описанието е обновено.');
  else await call(window.api.analytics.create(d), 'Описанието е добавено.');
  closeModal(); renderAnalytics(); markSaved();
}
window.saveAnalytic = saveAnalytic;
async function analyticDelete(id) {
  if (!confirm('Изтриване на това аналитично описание?')) return;
  await call(window.api.analytics.delete(id), 'Описанието е изтрито.');
  renderAnalytics();
}
window.analyticDelete = analyticDelete;

/* ---------------- Персоналии ---------------- */
let PRS_Q = '';
async function renderPersons() {
  const rows = await call(window.api.persons.list(PRS_Q));
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note"><b>Персоналии.</b> Картотека на видни местни жители и дейци — родени в селото,
    работили тук или свързани с читалището. Всяка персоналия събира на едно място сведенията за
    човека и връзките към материалите за него във фонда.</div>

    <div class="toolbar">
      <button class="btn pri" onclick="personForm()">+ Нова персоналия</button>
      <input type="search" placeholder="Търсене по име, дейност, биография…"
        value="${esc(PRS_Q)}" oninput="prsSearch(this.value)">
    </div>

    ${rows.length ? `<div class="cardGrid">
      ${rows.map(p => `<div class="prsCard" onclick="personView(${p.id})">
        <div class="prsPhoto">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : '<span>без снимка</span>'}</div>
        <div class="prsBody">
          <div class="prsName">${esc(p.name)}</div>
          <div class="prsDates">${esc(personDates(p))}</div>
          ${p.activity ? `<div class="prsAct">${esc(p.activity)}</div>` : ''}
          <div class="prsLinks">${p.links ? p.links + ' свързани материала' : 'няма свързани материали'}</div>
        </div>
      </div>`).join('')}
    </div>`
    : `<div class="empty"><h3>Няма вписани персоналии</h3>
        <p>Започнете от хората, за които читалището вече пази сведения на хартия.</p></div>`}`;
}
function personDates(p) {
  const b = p.birth_date ? bg(p.birth_date) : '';
  const d = p.death_date ? bg(p.death_date) : '';
  if (b && d) return b + ' – ' + d;
  if (b) return 'р. ' + b;
  if (d) return 'п. ' + d;
  return '';
}
function prsSearch(v) { PRS_Q = v; clearTimeout(window._prsT); window._prsT = setTimeout(renderPersons, 300); }
window.prsSearch = prsSearch;

async function personForm(id) {
  const p = id ? await call(window.api.persons.get(id)) : null;
  const v = p || {};
  modal(id ? 'Редакция — ' + (v.name || '') : 'Нова персоналия', `
    <form id="prsF" onsubmit="return false">
    <fieldset><legend>Самоличност</legend>
      <div class="grid g2">
        ${fld('Име (фамилия, име, бащино)', 'name', { val: v.name || '', req: 1, ph: 'Иванов, Петър Георгиев' })}
        ${fld('Други изписвания и псевдоними', 'alt_names', { val: v.alt_names || '' })}
      </div>
      <div class="grid g4">
        ${fld('Дата на раждане', 'birth_date', { val: v.birth_date || '', type: 'date' })}
        ${fld('Място на раждане', 'birth_place', { val: v.birth_place || '' })}
        ${fld('Дата на смъртта', 'death_date', { val: v.death_date || '', type: 'date' })}
        ${fld('Място на смъртта', 'death_place', { val: v.death_place || '' })}
      </div>
      ${fld('Дейност (накратко)', 'activity', { val: v.activity || '', hint: 'напр. „учител, читалищен деец, краевед“' })}
    </fieldset>
    <fieldset><legend>Сведения</legend>
      ${fld('Биографична справка', 'bio', { type: 'textarea', val: v.bio || '', rows: 5 })}
      <div class="grid g2">
        ${fld('Отличия и награди', 'awards', { val: v.awards || '' })}
        ${fld('Източници на сведенията', 'sources', { val: v.sources || '' })}
      </div>
      ${fld('Забележка', 'note', { val: v.note || '' })}
    </fieldset>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="savePerson(${id || 'null'})">Запиши</button>`);
}
window.personForm = personForm;
async function savePerson(id) {
  const d = formData('#prsF');
  if (!d.name.trim()) return toast('Името е задължително.', 'err');
  d.id = id;
  if (id) await call(window.api.persons.update(d), 'Персоналията е обновена.');
  else {
    const newId = await call(window.api.persons.create(d), 'Персоналията е добавена.');
    closeModal(); await renderPersons(); markSaved();
    if (newId) personView(newId);
    return;
  }
  closeModal(); renderPersons(); markSaved();
}
window.savePerson = savePerson;

async function personView(id) {
  const [p, links] = await Promise.all([
    call(window.api.persons.get(id)),
    call(window.api.links.list({ fromKind: 'персона', fromId: id }))
  ]);
  if (!p) return;
  window._LINK_CTX = { kind: 'персона', id };
  modal(p.name, `
    <div class="prsView">
      <div class="prsViewPhoto">
        ${p.photo ? `<img src="${esc(p.photo)}" alt="">` : '<div class="logoEmpty">няма<br>снимка</div>'}
        <div class="toolbar" style="margin-top:8px">
          <button class="btn sm" onclick="localPhotoChoose('persons', ${id})">${p.photo ? 'Смени…' : 'Снимка…'}</button>
          ${p.photo ? `<button class="btn sm dgr" onclick="localPhotoClear('persons', ${id})">Махни</button>` : ''}
        </div>
      </div>
      <div class="prsViewBody">
        <div class="prsDates">${esc(personDates(p))}${p.birth_place ? ' · ' + esc(p.birth_place) : ''}</div>
        ${p.activity ? `<div class="prsAct" style="margin:6px 0">${esc(p.activity)}</div>` : ''}
        ${p.alt_names ? `<div class="hint">Известен още като: ${esc(p.alt_names)}</div>` : ''}
        ${p.bio ? `<p style="font-size:13.5px;line-height:1.6">${esc(p.bio).replace(/\n/g, '<br>')}</p>` : ''}
        ${p.awards ? `<div class="hint"><b>Отличия:</b> ${esc(p.awards)}</div>` : ''}
        ${p.sources ? `<div class="hint"><b>Източници:</b> ${esc(p.sources)}</div>` : ''}
      </div>
    </div>
    ${linksPanelHtml('персона', id, links || [])}`,
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn" onclick="closeModal();personForm(${id})">Редакция</button>
     <button class="btn dgr" onclick="personDelete(${id})">Изтрий</button>`);
}
window.personView = personView;
async function personDelete(id) {
  if (!confirm('Изтриване на персоналията и всичките ѝ връзки?')) return;
  await call(window.api.persons.delete(id), 'Персоналията е изтрита.');
  closeModal(); renderPersons();
}
window.personDelete = personDelete;

/* ---------------- Летопис ---------------- */
let CHR_Q = '', CHR_YEAR = '';
const CHR_CATS = ['читалище', 'библиотека', 'самодейност', 'дарение', 'строителство', 'юбилей', 'друго'];
async function renderChronicle() {
  const [rows, years] = await Promise.all([
    call(window.api.chronicle.list({ q: CHR_Q, year: CHR_YEAR })),
    call(window.api.chronicle.years())
  ]);
  if (!rows) return;
  // Записите се групират по година, за да се чете като истински летопис.
  const byYear = {};
  for (const r of rows) { (byYear[r.year] = byYear[r.year] || []).push(r); }
  const yearsSorted = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  $('#view').innerHTML = `
    <div class="note"><b>Летопис.</b> Хронология на читалищната дейност — по години и събития.
    Това, което по традиция се води в летописната книга, тук се търси, допълва и свързва със
    снимките и документите във фонда.</div>

    <div class="toolbar">
      <button class="btn pri" onclick="chronicleForm()">+ Нов запис</button>
      <input type="search" placeholder="Търсене по събитие, описание, участници…"
        value="${esc(CHR_Q)}" oninput="chrSearch(this.value)">
      <select onchange="chrYear(this.value)">
        <option value="">— всички години —</option>
        ${(years || []).map(y => `<option value="${esc(y.year)}" ${CHR_YEAR === y.year ? 'selected' : ''}>
          ${esc(y.year)} (${y.n})</option>`).join('')}
      </select>
      <button class="btn" onclick="printChronicle()">Печат / PDF</button>
    </div>

    ${rows.length ? yearsSorted.map(y => `
      <div class="chrYear">
        <div class="chrYearHead">${esc(y)}</div>
        ${byYear[y].map(c => `<div class="chrItem" onclick="chronicleView(${c.id})">
          ${c.photo ? `<img class="chrThumb" src="${esc(c.photo)}" alt="">` : ''}
          <div class="chrBody">
            <div class="chrTop">
              <span class="chrTitle">${esc(c.title)}</span>
              ${c.date ? `<span class="chrDate">${esc(bg(c.date))}</span>` : ''}
              ${c.category ? `<span class="tag">${esc(c.category)}</span>` : ''}
            </div>
            ${c.body ? `<div class="chrText">${esc(String(c.body).slice(0, 240))}${String(c.body).length > 240 ? '…' : ''}</div>` : ''}
            ${c.links ? `<div class="hint">${c.links} свързани материала</div>` : ''}
          </div>
        </div>`).join('')}
      </div>`).join('')
    : `<div class="empty"><h3>Летописът е празен</h3>
        <p>Впишете първото събитие — основаването на читалището, откриването на библиотеката,
        юбилей, дарение, ремонт.</p></div>`}`;
}
function chrSearch(v) { CHR_Q = v; clearTimeout(window._chrT); window._chrT = setTimeout(renderChronicle, 300); }
window.chrSearch = chrSearch;
function chrYear(v) { CHR_YEAR = v; renderChronicle(); }
window.chrYear = chrYear;

async function chronicleForm(id) {
  const c = id ? await call(window.api.chronicle.get(id)) : null;
  const v = c || { year: String(new Date().getFullYear()), category: 'читалище' };
  modal(id ? 'Редакция на запис' : 'Нов запис в летописа', `
    <form id="chrF" onsubmit="return false">
    <div class="grid g4">
      ${fld('Година', 'year', { val: v.year || '', req: 1 })}
      ${fld('Точна дата (ако е известна)', 'date', { val: v.date || '', type: 'date' })}
      ${fld('Раздел', 'category', { type: 'select', val: v.category, opts: CHR_CATS, allowEmpty: false })}
      ${fld('Участници', 'participants', { val: v.participants || '' })}
    </div>
    ${fld('Събитие', 'title', { val: v.title || '', req: 1, hint: 'кратко заглавие на записа' })}
    ${fld('Описание', 'body', { type: 'textarea', val: v.body || '', rows: 6 })}
    <div class="grid g2">
      ${fld('Източници', 'sources', { val: v.sources || '', hint: 'протокол, вестник, спомен' })}
      ${fld('Забележка', 'note', { val: v.note || '' })}
    </div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveChronicle(${id || 'null'})">Запиши</button>`);
}
window.chronicleForm = chronicleForm;
async function saveChronicle(id) {
  const d = formData('#chrF');
  if (!d.title.trim()) return toast('Заглавието на събитието е задължително.', 'err');
  if (!d.year.trim() && !d.date) return toast('Годината е задължителна.', 'err');
  d.id = id;
  if (id) { await call(window.api.chronicle.update(d), 'Записът е обновен.'); }
  else {
    const newId = await call(window.api.chronicle.create(d), 'Записът е добавен.');
    closeModal(); await renderChronicle(); markSaved();
    if (newId) chronicleView(newId);
    return;
  }
  closeModal(); renderChronicle(); markSaved();
}
window.saveChronicle = saveChronicle;

async function chronicleView(id) {
  const [c, links] = await Promise.all([
    call(window.api.chronicle.get(id)),
    call(window.api.links.list({ fromKind: 'летопис', fromId: id }))
  ]);
  if (!c) return;
  window._LINK_CTX = { kind: 'летопис', id };
  modal(c.year + ' — ' + c.title, `
    <div class="prsView">
      <div class="prsViewPhoto">
        ${c.photo ? `<img src="${esc(c.photo)}" alt="">` : '<div class="logoEmpty">няма<br>снимка</div>'}
        <div class="toolbar" style="margin-top:8px">
          <button class="btn sm" onclick="localPhotoChoose('chronicle', ${id})">${c.photo ? 'Смени…' : 'Снимка…'}</button>
          ${c.photo ? `<button class="btn sm dgr" onclick="localPhotoClear('chronicle', ${id})">Махни</button>` : ''}
        </div>
      </div>
      <div class="prsViewBody">
        <div class="chrTop">
          ${c.date ? `<span class="chrDate">${esc(bg(c.date))}</span>` : ''}
          ${c.category ? `<span class="tag">${esc(c.category)}</span>` : ''}
        </div>
        ${c.body ? `<p style="font-size:13.5px;line-height:1.6">${esc(c.body).replace(/\n/g, '<br>')}</p>` : ''}
        ${c.participants ? `<div class="hint"><b>Участници:</b> ${esc(c.participants)}</div>` : ''}
        ${c.sources ? `<div class="hint"><b>Източници:</b> ${esc(c.sources)}</div>` : ''}
      </div>
    </div>
    ${linksPanelHtml('летопис', id, links || [])}`,
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn" onclick="closeModal();chronicleForm(${id})">Редакция</button>
     <button class="btn dgr" onclick="chronicleDelete(${id})">Изтрий</button>`);
}
window.chronicleView = chronicleView;
async function chronicleDelete(id) {
  if (!confirm('Изтриване на записа от летописа?')) return;
  await call(window.api.chronicle.delete(id), 'Записът е изтрит.');
  closeModal(); renderChronicle();
}
window.chronicleDelete = chronicleDelete;

async function printChronicle() {
  const rows = await call(window.api.chronicle.list({ year: CHR_YEAR }));
  if (!rows || !rows.length) return toast('Няма записи за печат.', 'err');
  const byYear = {};
  for (const r of rows) { (byYear[r.year] = byYear[r.year] || []).push(r); }
  const years = Object.keys(byYear).sort();
  setPrintPage({ name: (CHR_YEAR ? `Летопис ${CHR_YEAR} г.` : 'Летопис'), landscape: false, margin: '16mm 14mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 class="ptitle">ЛЕТОПИС${CHR_YEAR ? ' — ' + esc(CHR_YEAR) + ' г.' : ''}</h2>
    ${years.map(y => `<h3 style="margin:10px 0 4px">${esc(y)} г.</h3>
      ${byYear[y].map(c => `<div style="margin-bottom:7px">
        <b>${esc(c.title)}</b>${c.date ? ' · ' + esc(bg(c.date)) : ''}${c.category ? ' · ' + esc(c.category) : ''}
        ${c.body ? `<div style="font-size:11pt">${esc(c.body).replace(/\n/g, '<br>')}</div>` : ''}
        ${c.participants ? `<div style="font-size:10pt"><i>Участници: ${esc(c.participants)}</i></div>` : ''}
      </div>`).join('')}`).join('')}
    ${ssig(['Летописец: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Председател') + ': …………………'])}</div>`);
}
window.printChronicle = printChronicle;

/* ---------------- Връзки към фонда (общи за персоналии и летопис) ---------------- */
function linksPanelHtml(fromKind, fromId, links) {
  return `<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Свързани материали</h3>
    <div class="note" style="margin-top:0">Документи от фонда, статии, други персоналии и записи в
    летописа, които се отнасят до този запис.</div>
    <div id="linkList">${linkListHtml(links)}</div>
    <div class="grid g3" style="margin-top:10px">
      <div class="field"><label>Вид</label>
        <select id="lnkKind" onchange="lnkSearch()">
          <option value="книга">Документ от фонда</option>
          <option value="статия">Статия (аналитично описание)</option>
          <option value="персона">Персоналия</option>
          <option value="летопис">Запис в летописа</option>
          <option value="периодика">Периодично издание</option>
        </select></div>
      <div class="field"><label>Търсене</label>
        <input id="lnkQ" placeholder="заглавие, автор, инв. №…" oninput="lnkSearch()"></div>
      <div class="field"><label>Намерени</label>
        <select id="lnkPick"><option value="">— въведете търсене —</option></select></div>
    </div>
    <button class="btn pri" onclick="lnkAdd('${fromKind}', ${fromId})">Свържи</button>
  </div>`;
}
function linkListHtml(links) {
  if (!links.length) return '<div class="hint">Няма свързани материали.</div>';
  return `<table class="ledger"><tbody>${links.map(l => `<tr>
    <td style="width:110px"><span class="tag">${esc(l.to_kind)}</span></td>
    <td>${esc(l.label)}</td>
    <td style="width:80px"><button class="btn sm dgr" onclick="lnkDel(${l.id})">Махни</button></td>
  </tr>`).join('')}</tbody></table>`;
}
async function lnkSearch() {
  const kind = $('#lnkKind').value, q = $('#lnkQ').value.trim();
  const sel = $('#lnkPick');
  if (q.length < 2) { sel.innerHTML = '<option value="">— въведете поне 2 знака —</option>'; return; }
  const rows = await call(window.api.links.search({ kind, q }));
  sel.innerHTML = (rows || []).length
    ? (rows || []).map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join('')
    : '<option value="">— няма намерени —</option>';
}
window.lnkSearch = lnkSearch;
async function lnkAdd(fromKind, fromId) {
  const toKind = $('#lnkKind').value, toId = $('#lnkPick').value;
  if (!toId) return toast('Изберете запис от списъка „Намерени“.', 'err');
  const r = await call(window.api.links.add({ fromKind, fromId, toKind, toId: Number(toId) }), 'Връзката е добавена.');
  if (r === null) return;
  await refreshLinks(fromKind, fromId);
  markSaved();
}
window.lnkAdd = lnkAdd;
async function lnkDel(id) {
  await call(window.api.links.delete(id), 'Връзката е премахната.');
  const btn = event && event.target;
  const panel = btn && btn.closest('.card');
  // Опреснява списъка от текущия отворен запис.
  if (window._LINK_CTX) await refreshLinks(window._LINK_CTX.kind, window._LINK_CTX.id);
  else if (panel) panel.querySelector('#linkList').innerHTML = '<div class="hint">Няма свързани материали.</div>';
}
window.lnkDel = lnkDel;
async function refreshLinks(fromKind, fromId) {
  window._LINK_CTX = { kind: fromKind, id: fromId };
  const links = await call(window.api.links.list({ fromKind, fromId }));
  const box = $('#linkList');
  if (box) box.innerHTML = linkListHtml(links || []);
}

async function localPhotoChoose(table, id) {
  const res = await window.api.localPhoto.choose({ table, id });
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast('Снимката е добавена.', 'ok'); markSaved();
  closeModal();
  if (table === 'persons') { await renderPersons(); personView(id); }
  else { await renderChronicle(); chronicleView(id); }
}
window.localPhotoChoose = localPhotoChoose;
async function localPhotoClear(table, id) {
  await call(window.api.localPhoto.clear({ table, id }), 'Снимката е премахната.');
  closeModal();
  if (table === 'persons') { await renderPersons(); personView(id); }
  else { await renderChronicle(); chronicleView(id); }
}
window.localPhotoClear = localPhotoClear;

/* ============================================================================
   ПРИЕМАНЕ НА ДАННИ ОТ ДРУГИ СИСТЕМИ
   ============================================================================ */
/* ---------------- Антивирусна защита ---------------- */
async function avScript() {
  const info = await call(window.api.security.exclusionInfo());
  if (!info) return;
  modal('Скрипт за изключения в Windows Defender', `
    <div class="note" style="margin-top:0">Скриптът ще добави следните папки в изключенията на
    Defender и ще разреши програмата през „Защита от рансъмуер“. Прегледайте списъка, преди да
    го запишете:</div>
    <ul class="steps" style="list-style:disc">
      ${info.dirs.map(d => `<li style="font-family:var(--mono);font-size:12px">${esc(d)}</li>`).join('')}
      <li style="font-family:var(--mono);font-size:12px">${esc(info.exe)} <span class="hint">(разрешено приложение)</span></li>
    </ul>
    <div class="hint">След записване: намерете файла, десен бутон → <b>„Изпълни като
    администратор“</b>. Прави се веднъж на всеки компютър и важи и за бъдещите обновявания.
    При друга антивирусна (Avast, ESET…) добавете същите папки в нейните настройки.</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="avScriptWrite()">Запиши скрипта…</button>`);
}
window.avScript = avScript;
async function avScriptWrite() {
  const res = await window.api.security.writeExclusionScript();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  closeModal();
  toast('Скриптът е записан: ' + res.data + ' — изпълнете го като администратор.', 'ok');
}
window.avScriptWrite = avScriptWrite;
/* AVG, Avast, ESET и др. нямат команден ред за изключения — папките се добавят
   ръчно в техния прозорец. Копирането на списъка спестява преписването. */
async function avCopyDirs() {
  const info = await call(window.api.security.exclusionInfo());
  if (!info) return;
  const text = info.dirs.join('\n');
  try { await navigator.clipboard.writeText(text); }
  catch (e) { /* резервен път по-долу, през прозореца */ }
  modal('Папки за изключения — AVG и други антивирусни', `
    <div class="note" style="margin-top:0">Списъкът е <b>копиран</b> — поставете всяка папка като
    изключение в антивирусната. Пътищата, ред по ред:</div>
    <textarea class="remText" rows="${info.dirs.length + 1}" readonly
      onclick="this.select()">${esc(text)}</textarea>
    <div class="hint" style="margin-top:10px"><b>Къде в AVG:</b> отворете AVG → „Меню“ (горе
    вдясно) → „Настройки“ → „Общи“ → „Изключения“ → „Добавяне на изключение“ → „Преглед“ и
    посочете всяка от папките по-горе. При англ. изглед: Menu → Settings → General → Exceptions
    → Add exception.</div>
    <div class="hint" style="margin-top:6px"><b>Ако AVG вече е изтрила файл:</b> „Меню“ →
    „Карантина“ → изберете файла → „Възстановяване и добавяне на изключение“
    (Restore and add exception).</div>
    <div class="hint" style="margin-top:6px"><b>Трайно:</b> подайте фалшивата тревога към AVG на
    <span style="font-family:var(--mono);font-size:12px">avg.com/false-positive-file-form</span> —
    качвате инсталатора, обработва се за няколко дни и блокирането спира при всички.</div>`,
    `<button class="btn pri" onclick="closeModal()">Готово</button>`);
}
window.avCopyDirs = avCopyDirs;
function avHelp() {
  modal('Антивирусната блокира програмата — какво да направя?', `
    <div class="note" style="margin-top:0"><b>Причината:</b> инсталаторът още няма закупен цифров
    подпис, а Windows преценява файловете по издателя им. Файл без подпис се третира като непознат
    и антивирусните го спират „за всеки случай“. Кодът на програмата е публичен и може да бъде
    проверен от всекиго в GitHub хранилището.</div>
    <ol class="steps">
      <li><b>При инсталиране</b> — ако SmartScreen покаже „Windows protected your PC“:
          натиснете „More info“ → „Run anyway“. Ако сваленият файл бъде изтрит: при Defender —
          Windows Security → „Protection history“ → „Restore“; при AVG — „Меню“ → „Карантина“ →
          „Възстановяване и добавяне на изключение“.</li>
      <li><b>Windows Defender</b> — бутонът „Скрипт за Defender…“ прави готов скрипт, който се
          изпълнява веднъж като администратор и добавя всички нужни изключения.</li>
      <li><b>AVG, Avast, ESET и други</b> — бутонът „Копирай папките“ дава списъка с папки и
          точните стъпки къде да се поставят в настройките на антивирусната.</li>
      <li><b>Трайно, безплатно</b> — подайте инсталатора като фалшива тревога:
          за Defender на <span style="font-family:var(--mono);font-size:12px">microsoft.com/wdsi/filesubmission</span>,
          за AVG на <span style="font-family:var(--mono);font-size:12px">avg.com/false-positive-file-form</span>.
          Обработва се за няколко дни и след това блокирането спира при всички, не само при вас.</li>
      <li><b>Окончателно</b> — сертификат за подпис на код (виж README, раздел „Цифров подпис“).
          След него предупрежденията изчезват навсякъде.</li>
    </ol>`,
    `<button class="btn pri" onclick="closeModal()">Разбрах</button>`);
}
window.avHelp = avHelp;

let IMPORT_INFO = null;
async function importChoose() {
  const res = await window.api.importData.choose();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  IMPORT_INFO = res.data;
  importMapModal();
}
window.importChoose = importChoose;

/* Провлачване на файл върху прозореца — същият път, като през диалога. */
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f || !f.path) return;
  if (!/\.(csv|txt|tsv|xlsx)$/i.test(f.path)) {
    return toast('Приемат се файлове CSV, TXT, TSV и XLSX.', 'err');
  }
  const res = await window.api.importData.load(f.path);
  if (!res.ok) return toast(res.error, 'err');
  IMPORT_INFO = res.data;
  importMapModal();
});

function importMapModal() {
  const d = IMPORT_INFO;
  const fieldOpts = Object.entries(d.fields).map(([v, t]) => ({ v, t }));
  modal('Внасяне на данни — съответствие на колоните', `
    <div class="note" style="margin-top:0">
      Файл: <b style="font-family:var(--mono)">${esc(d.path.split(/[\\/]/).pop())}</b> ·
      кодиране <b>${esc(d.encoding)}</b>${d.delimiter ? ` · разделител <b>${esc(d.delimiter === '\t' ? 'табулация' : d.delimiter)}</b>` : ''} ·
      редове с данни: <b>${d.total}</b><br>
      Съответствието е разпознато по заглавията на колоните. <b>Проверете го</b> и поправете
      каквото е нужно — колоните, оставени на „— не се внася —“, се пренебрегват.
    </div>

    <div class="wrap" style="max-height:230px">
      <table class="ledger"><thead><tr>
        ${d.headers.map((h, i) => `<th>${esc(h || 'колона ' + (i + 1))}</th>`).join('')}
      </tr></thead><tbody>
        ${d.preview.map(r => `<tr>${d.headers.map((_, i) =>
          `<td>${esc(String(r[i] ?? '').slice(0, 40))}</td>`).join('')}</tr>`).join('')}
      </tbody></table>
    </div>
    <div class="hint" style="margin:4px 0 12px">Първите ${d.preview.length} реда от файла.</div>

    <form id="mapF" onsubmit="return false">
      <div class="grid g3">
        ${d.headers.map((h, i) => fld(h || 'колона ' + (i + 1), 'col' + i, {
          type: 'select', val: d.mapping[i] || '', opts: fieldOpts, emptyLabel: '— не се внася —'
        })).join('')}
      </div>
    </form>

    <fieldset><legend>Настройки на внасянето</legend>
      <form id="impOptF" onsubmit="return false">
        <label class="chk"><input type="checkbox" name="skipDuplicates" checked>
          <span>Пропускай вече съществуващите (по инвентарен номер, а при липса — по ISBN)</span></label>
        <div class="grid g3" style="margin-top:8px">
          ${fld('Отдел по подразбиране', 'defaultDepartment', { type: 'select', opts: OTDELI,
            val: 'за възрастни', allowEmpty: false })}
          ${fld('Език по подразбиране', 'defaultLanguage', { type: 'select', opts: EZICI, val: 'български' })}
          ${fld('Вид документ по подразбиране', 'defaultCategory', { val: 'книга' })}
        </div>
        <div class="hint">Ползват се само за редовете, в които съответната колона липсва или е празна.</div>
      </form>
    </fieldset>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="importRun()">Внеси ${d.total} реда</button>`);
}

async function importRun() {
  const d = IMPORT_INFO;
  const mapping = {};
  const seen = {};
  for (let i = 0; i < d.headers.length; i++) {
    const v = $(`#mapF [name=col${i}]`).value;
    if (!v) continue;
    // Едно поле не може да идва от две колони — иначе втората тихо презаписва първата.
    if (seen[v]) return toast(`Полето „${d.fields[v]}“ е посочено два пъти — изберете само една колона за него.`, 'err');
    seen[v] = true;
    mapping[i] = v;
  }
  if (!seen.title) return toast('Посочете коя колона съдържа заглавието — без него записът е безсмислен.', 'err');
  const options = formData('#impOptF');
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Внасяне…'; }
  const res = await window.api.importData.run({ mapping, options });
  if (btn) { btn.disabled = false; btn.textContent = 'Внеси'; }
  if (!res.ok) return toast(res.error, 'err');
  const r = res.data;
  markSaved();
  modal('Внасянето приключи', `
    <div class="kpis">
      ${kpi('✅', r.added, 'Внесени документа', 'добавени във фонда', 'ok')}
      ${kpi('⏭️', r.skipped, 'Пропуснати', 'дубликати или редове с грешка')}
    </div>
    ${r.usedInv.length ? `<div class="note" style="margin-top:14px">
      <b>${r.usedInv.length} записа получиха нов инвентарен номер</b>, защото в
      файла нямаше номер или той вече беше зает. Инвентарният номер трябва да е
      уникален — това е изискване на инвентарната книга.
      <div class="hint" style="margin-top:6px">${r.usedInv.slice(0, 12).map(u =>
        `ред ${u.line} → № ${u.inv}`).join(' · ')}${r.usedInv.length > 12 ? ' …' : ''}</div>
    </div>` : ''}
    ${r.errors.length ? `<div class="note" style="border-left-color:var(--red);margin-top:12px">
      <b style="color:var(--red)">Редове с грешка: ${r.errors.length}</b>
      <div class="hint" style="margin-top:6px">${r.errors.slice(0, 15).map(x =>
        `ред ${x.line}: ${esc(x.error)}`).join('<br>')}${r.errors.length > 15 ? '<br>…' : ''}</div>
    </div>` : ''}
    <div class="hint" style="margin-top:12px">Прегледайте внесеното в „Книги“. Ако нещо не е наред,
    възстановете резервното копие отпреди внасянето — то се прави автоматично при първото
    стартиране за деня.</div>`,
    `<button class="btn pri" onclick="closeModal();go('books')">Към книгите</button>`);
}
window.importRun = importRun;

/* ============================================================================
   МОБИЛНО СКАНИРАНЕ ПРИ ИНВЕНТАРИЗАЦИЯ
   ============================================================================ */
async function mobileGenerate() {
  const res = await window.api.mobile.generate();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast('Страницата е записана: ' + res.data, 'ok');
}
window.mobileGenerate = mobileGenerate;

function mobileHelp() {
  modal('Сканиране с телефон вместо баркод четец', `
    <div class="note" style="margin-top:0">Телефонът замества скъпия ръчен четец: камерата чете
    баркода на документа, а списъкът се пренася в програмата. Обхождането на рафтовете става
    за часове вместо за дни, без да се влачи компютър до стелажите.</div>

    <ol class="steps">
      <li><b>Веднъж:</b> натиснете „Запиши страницата…“ и запазете файла. Прехвърлете го на
          телефона — с USB кабел, по Вайбър, по имейл, както Ви е удобно.</li>
      <li>На телефона отворете файла с <b>Chrome</b> и разрешете достъп до камерата.
          Добавете го към началния екран, за да е подръка следващия път.</li>
      <li>При рафтовете: „Пусни камерата“ и насочвайте към баркодовете.
          Всеки разчетен номер се добавя със звук; повторните се отбелязват отделно.</li>
      <li>Накрая натиснете <b>„Копирай списъка“</b> и си го изпратете (Вайбър, имейл), или
          „Запиши файл“ и го прехвърлете.</li>
      <li>Тук отворете сесията за инвентаризация и натиснете
          <b>„Внеси сканирания от телефон“</b> — поставяте списъка и готово.</li>
    </ol>

    <div class="hint"><b>Работи офлайн.</b> Страницата не изисква интернет и не изпраща никъде
    данни — списъкът стои в самия телефон, докато не го прехвърлите. Ако телефонът се заключи
    или Chrome се затвори, сканираното не се губи.</div>
    <div class="hint" style="margin-top:8px"><b>Ако камерата не чете:</b> на iPhone и на по-стари
    браузъри четенето на баркод от камера не се поддържа — тогава номерата се въвеждат на ръка в
    същата страница и списъкът се пренася по същия начин.</div>`,
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn pri" onclick="closeModal();mobileGenerate()">Запиши страницата…</button>`);
}
window.mobileHelp = mobileHelp;

function importScansModal(sessionId) {
  modal('Внасяне на сканирания от телефон', `
    <div class="note" style="margin-top:0">Поставете списъка, копиран от телефона — по един номер
    на ред. Приемат се и номера, разделени със запетая или интервал.</div>
    <textarea id="scanPaste" class="remText" rows="12" placeholder="1024&#10;1025&#10;1026&#10;…"></textarea>
    <div class="hint" style="margin-top:6px">Вече сканираните в тази сесия се пропускат, а
    непознатите номера се изброяват отделно, за да се проверят.</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="importScansRun(${sessionId})">Внеси</button>`);
  setTimeout(() => { const t = $('#scanPaste'); if (t) t.focus(); }, 60);
}
window.importScansModal = importScansModal;

async function importScansRun(sessionId) {
  const raw = $('#scanPaste').value || '';
  const codes = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if (!codes.length) return toast('Не е поставен нито един номер.', 'err');
  const r = await call(window.api.inventorySessions.importScans({ sessionId, codes }));
  if (!r) return;
  markSaved();
  closeModal();
  toast(`Внесени ${r.added} · повторни ${r.duplicates} · непознати ${r.unknown.length}`, r.unknown.length ? 'err' : 'ok');
  if (r.unknown.length) {
    modal('Непознати номера', `
      <div class="note" style="border-left-color:var(--red);margin-top:0">
        <b>${r.unknown.length} номера не са намерени във фонда.</b> Обикновено това са документи,
        описани в друга библиотека, сгрешено сканиране или книги, които още не са заведени.</div>
      <div class="hint" style="font-family:var(--mono);line-height:1.8">${r.unknown.map(esc).join(' · ')}</div>`,
      `<button class="btn pri" onclick="closeModal();renderInventRun(${sessionId})">Разбрах</button>`);
  } else {
    renderInventRun(sessionId);
  }
}
window.importScansRun = importScansRun;
