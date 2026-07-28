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
  return `<div class="field"><label>${esc(label)}${opts.hint ? ' <span class="fh">' + opts.hint + '</span>' : ''}</label>
    <input name="${name}" type="${type}" ${opts.step ? 'step="' + opts.step + '"' : ''} ${opts.req ? 'required' : ''} value="${esc(val)}"></div>`;
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
function updateBrandSub() {
  const el = $('#brandSub'); if (!el || !SETTINGS_CACHE) return;
  el.textContent = [SETTINGS_CACHE.org, SETTINGS_CACHE.place].filter(Boolean).join(' · ');
}
function applyTheme() {
  document.documentElement.dataset.theme = (SETTINGS_CACHE && SETTINGS_CACHE.theme) || '1';
}
function shead() {
  const s = SETTINGS_CACHE || {};
  return `<div class="porg"><b>${esc(s.org || '')}</b><br>${esc(s.lib_name || '')}<br>${esc(s.place || '')}${s.bulstat ? ' · ЕИК ' + esc(s.bulstat) : ''}</div>`;
}
function ssig(names) { return `<div class="psig">${names.map(n => `<div>${n}</div>`).join('')}</div>`; }
function setPrintPage(opts) {
  opts = opts || {};
  let st = document.getElementById('dynPrintStyle');
  if (!st) { st = document.createElement('style'); st.id = 'dynPrintStyle'; document.head.appendChild(st); }
  const size = opts.widthMm ? opts.widthMm + 'mm ' + opts.heightMm + 'mm' : 'A4' + (opts.landscape ? ' landscape' : '');
  st.textContent = `@media print{ @page{size:${size};margin:${opts.margin || '14mm 12mm'}} ${opts.extraCss || ''} }`;
}
function doPrint(html) {
  $('#printArea').innerHTML = html;
  toast('За PDF файл: в прозореца за печат изберете „Save as PDF“ / „Microsoft Print to PDF“ вместо принтер.');
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => window.print(), 150)));
}
function printLabelSheet(cardsHtml) {
  const s = SETTINGS_CACHE || {};
  if (s.lbl_mode === 'roll') {
    const w = +s.lbl_w || 40, h = +s.lbl_h || 30;
    setPrintPage({
      widthMm: w, heightMm: h, margin: '0',
      extraCss: `.lblsheet{display:block}.lbl{width:${w}mm;height:${h}mm;box-sizing:border-box;border:none;` +
        `page-break-after:always;display:flex;flex-direction:column;align-items:center;justify-content:center}`
    });
  } else {
    setPrintPage({ landscape: false, margin: '10mm 8mm' });
  }
  doPrint(`<div class="pdoc"><div class="lblsheet">${cardsHtml}</div></div>`);
}
function lblCard(b) {
  const s = SETTINGS_CACHE || {};
  return `<div class="lbl"><div class="l1">${esc(s.place || s.org || '')}</div>
    ${code39svg(b.barcode || String(b.inv_number), 150, 40)}
    <div class="l3">${esc(b.barcode || b.inv_number)}${b.call_number ? ' · ' + esc(b.call_number) : ''}</div></div>`;
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
  { g: 'Фонд', items: [['books', 'Книги'], ['categories', 'Категории'], ['invbook', 'Инвентарна книга'],
    ['kdbf', 'КДБФ'], ['acq', 'Постъпления'], ['acts', 'Отчисляване'], ['invent', 'Инвентаризация']] },
  { g: 'Читатели', items: [['readers', 'Читатели'], ['circ', 'Заемане и връщане'], ['over', 'Просрочени']] },
  { g: 'Други регистри', items: [['periodika', 'Периодика'], ['mzs', 'МЗС'], ['dnevnik', 'Дневник']] },
  { g: 'Отчети', items: [['stats', 'Справки и статистика'], ['catalog', 'Онлайн каталог'], ['labels', 'Баркод етикети'], ['odit', 'Одитна следа']] },
  { g: 'Настройки', items: [['setup', 'Настройки']] }
];
const TITLES = {
  dash: ['Табло', 'обобщение на състоянието'],
  books: ['Библиотечен фонд', 'каталогизация и издирване'],
  categories: ['Категории', 'видове документи'],
  invbook: ['Инвентарна книга', 'Приложение № 4 към чл. 16, ал. 1'],
  kdbf: ['Книга за движение на библиотечния фонд', 'Приложения № 1, 2 и 3 към чл. 13, ал. 3'],
  acq: ['Постъпления', 'раздел II и чл. 14 от Наредба № 3'],
  acts: ['Отчисляване', 'раздел IV, чл. 30 – 39'],
  invent: ['Инвентаризация', 'раздел V, чл. 40 – 41'],
  readers: ['Читатели', 'регистър на ползвателите'],
  circ: ['Заемане и връщане', 'чл. 42 – 49'],
  over: ['Просрочени заемания', 'контрол по чл. 43 и 49'],
  periodika: ['Периодика', 'картотека на постъпилите броеве'],
  mzs: ['Междубиблиотечно заемане', 'заявки от и към други библиотеки'],
  dnevnik: ['Дневник на библиотеката', 'месечен статистически дневник — Раздел А и Раздел Б'],
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
    g.items.map(([k, t]) => `<a href="#${k}" class="${VIEW === k ? 'on' : ''}">${esc(t)}</a>`).join('')
  ).join('');
}

const RENDERERS = {
  dash: renderDash, books: renderBooks, categories: renderCategories, invbook: renderInvBook,
  kdbf: renderKdbf, acq: renderAcq, acts: renderActs, invent: renderInvent,
  readers: renderReaders, circ: renderCirc, over: renderOver,
  periodika: renderPeriodika, mzs: renderMzs, dnevnik: renderDnevnik,
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
  APP_CREDIT_TEXT = 'Създадено от Пачо · Всички права запазени © ' + appYears() + (version ? ' · v' + version : '');
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
  $('#view').innerHTML = `
    <div class="cards" style="margin-bottom:18px">
      <div class="card"><div class="num">${r.fundCount.toLocaleString('bg-BG')}</div><div class="lbl">Библиотечен фонд</div></div>
      <div class="card"><div class="num" style="font-size:22px">${mny(r.fundValue)}</div><div class="lbl">Стойност на фонда</div></div>
      <div class="card"><div class="num">${r.loansOpen}</div><div class="lbl">Заети в момента</div><div class="hint">при ${r.activeReaders} активни читатели</div></div>
      <div class="card"><div class="num ${r.overdueCount ? 'warn' : ''}">${r.overdueCount}</div><div class="lbl">Просрочени</div></div>
    </div>

    <div class="grid g3">
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
        <div style="font-size:13px;line-height:2.1">
          <div style="display:flex;justify-content:space-between"><span>Постъпили документи</span><b>${r.acquiredYear}</b></div>
          <div style="display:flex;justify-content:space-between"><span>Отчислени документи</span><b>${r.deaccessionedYear}</b></div>
          <div style="display:flex;justify-content:space-between"><span>Заемания</span><b>${r.loansYear}</b></div>
          <div style="display:flex;justify-content:space-between"><span>Записани читатели</span><b>${r.readersYear}</b></div>
          <hr style="border:0;border-top:1px solid var(--rule);margin:9px 0">
          <div style="display:flex;justify-content:space-between"><span>Инвентаризация — цел</span><b>${r.inventoryScannedYear} / ${r.inventoryTarget}</b></div>
          <div class="hint">Чл. 40, т. 2: ежегодно не по-малко от <b>${r.inventoryPct}%</b> от фонда по репрезентативния метод.</div>
        </div>
      </div>
    </div>

    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Бързи действия</h3>
        <div class="toolbar" style="margin:0">
          <button class="btn pri" onclick="bookForm()">+ Нов документ</button>
          <button class="btn" onclick="go('circ')">Заемане / връщане</button>
          <button class="btn" onclick="readerForm()">+ Нов читател</button>
          <button class="btn" onclick="go('acq')">Нова партида</button>
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">Предстоящи връщания (до 3 дни)</h3>
        <div style="font-size:13px">
          ${r.upcoming.length ? r.upcoming.map(l => `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--rule)">
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
}

/* ---------------- Категории ---------------- */
async function renderCategories() {
  const cats = await call(window.api.categories.list());
  if (!cats) return;
  $('#view').innerHTML = `
    <div class="toolbar"><button class="btn pri" onclick="categoryForm()">+ Нова категория</button></div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Име</th><th style="width:140px"></th></tr></thead>
      <tbody>
        ${cats.length ? cats.map(c => `
          <tr><td>${esc(c.name)}</td>
            <td><button class="btn sm" onclick="categoryForm(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}')">Редакция</button>
                <button class="btn sm dgr" onclick="deleteCategory(${c.id})">Изтрий</button></td></tr>`).join('')
          : `<tr><td colspan="2" class="empty">Няма категории.</td></tr>`}
      </tbody>
    </table></div>`;
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
  closeModal(); renderCategories();
}
window.saveCategory = saveCategory;
async function deleteCategory(id) {
  if (!confirm('Да изтрия ли тази категория?')) return;
  await call(window.api.categories.delete(id), 'Категорията е изтрита.');
  renderCategories();
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
  const [cats, acqs] = await Promise.all([call(window.api.categories.list()), call(window.api.acquisitions.list())]);
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
      ${fld('Заглавие', 'title', { val: v.title || '', req: 1 })}
      <div class="grid g2">
        ${fld('Автор (фамилия, име)', 'author', { val: v.author || '', ph: 'Вазов, Иван' })}
        ${fld('Подзаглавие', 'subtitle', { val: v.subtitle || '' })}
      </div>
      <div class="grid g4">
        ${fld('Място на издаване', 'city', { val: v.city || '' })}
        ${fld('Издателство', 'publisher', { val: v.publisher || '' })}
        ${fld('Година', 'year', { val: v.year || '' })}
        ${fld('Том / част', 'volume', { val: v.volume || '' })}
      </div>
      <div class="grid g4">
        ${fld('ISBN / ISSN', 'isbn', { val: v.isbn || '' })}
        ${fld('Страници', 'pages', { val: v.pages || '' })}
        ${fld('Език', 'language', { type: 'select', opts: EZICI, val: v.language })}
        ${fld('УДК', 'udk', { val: v.udk || '' })}
      </div>
      ${fld('Авторски знак', 'author_mark', { val: v.author_mark || '', hint: 'за етикета за сигнатура, напр. „В-15“' })}
      ${fld('Ключови думи (през запетая)', 'keywords', { val: v.keywords || '' })}
      ${fld('Анотация', 'annotation', { type: 'textarea', val: v.annotation || '', rows: 3 })}
      ${fld('Адрес на корица (URL)', 'cover_url', { val: v.cover_url || '' })}
    </fieldset>
    <fieldset><legend>Състояние и бележки</legend>
      <div class="grid g2">
        ${fld('Състояние', 'status', { type: 'select', opts: ['наличен', 'липсващ', 'за реставрация', 'отчислен'], val: v.status, allowEmpty: false })}
        ${fld('Забележка', 'description', { val: v.description || '' })}
      </div>
      <div class="hint">Поправки в инвентарната книга не се допускат — новият текст се нанася в „Забележка“ (чл. 17, ал. 2).</div>
    </fieldset>
    </form>`,
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
  $('#view').innerHTML = `
    <div class="note"><b>Приложение № 4 към чл. 16, ал. 1</b> — колоните следват образеца от Наредба № 3.
    Книгата се съхранява безсрочно (чл. 26, ал. 1). Отчислените документи са отбелязани в червено (чл. 39).</div>
    <div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="num">${rows.length}</div><div class="lbl">Вписани общо</div></div>
      <div class="card"><div class="num">${active.length}</div><div class="lbl">Налични</div></div>
      <div class="card"><div class="num">${rows.length - active.length}</div><div class="lbl">Отчислени</div></div>
    </div>
    <div class="toolbar"><button class="btn pri" onclick="bookForm()">+ Нов документ</button>
      <button class="btn" onclick="printInvBookDoc()">Печат на инвентарната книга / PDF</button></div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Дата</th><th>Инв. №</th><th>Проверки</th><th>Автор и заглавие</th><th>Год.</th><th>Цена</th>
        <th>№/дата в КДБФ</th><th>Сигнатура</th><th>№/дата на акт</th><th>Забележка</th></tr></thead>
      <tbody>
        ${rows.length ? rows.map(r => `
          <tr style="${r.status === 'отчислен' ? 'color:var(--red);text-decoration:line-through' : ''}">
            <td class="num">${bg(r.register_date)}</td><td class="num">${r.inv_number ?? ''}</td>
            <td style="font-size:11px">${(r.checks || []).map(c => bg(c)).join('<br>')}</td>
            <td>${esc([r.author, r.title].filter(Boolean).join('. '))}${r.volume ? ', т. ' + esc(r.volume) : ''}</td>
            <td class="num">${esc(r.year || '')}</td><td class="num">${mny(r.price)}</td>
            <td class="num" style="font-size:11px">${r.acq_no ? '№ ' + r.acq_no + '<br>' + bg(r.acq_date) : ''}</td>
            <td class="num">${esc(r.call_number || '')}</td>
            <td class="num" style="font-size:11px;color:var(--red)">${r.act_no ? '№ ' + r.act_no + '<br>' + bg(r.act_date) : ''}</td>
            <td style="font-size:11.5px">${esc(r.description || '')}</td>
          </tr>`).join('') : `<tr><td colspan="10" class="empty">Инвентарната книга е празна.</td></tr>`}
      </tbody>
    </table></div>`;
  window._INVBOOK_ROWS = rows;
}
function printInvBookDoc() {
  const rows = window._INVBOOK_ROWS || [];
  setPrintPage({ landscape: true, margin: '10mm' });
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
      <div class="cards">
        <div class="card"><div class="num">${r.stockEnd.n}</div><div class="lbl">Наличност 31.12.${y}</div><div class="lbl">${mny(r.stockEnd.v)}</div></div>
        <div class="card"><div class="num">+${r.acquiredYear.n}</div><div class="lbl">Постъпили</div><div class="lbl">${mny(r.acquiredYear.v)}</div></div>
        <div class="card"><div class="num">−${r.deaccYear.n}</div><div class="lbl">Отчислени</div><div class="lbl">${mny(r.deaccYear.v)}</div></div>
      </div>`}
  `;
}

function printKdbfDoc() {
  const r = window._KDBF_REPORT; if (!r) return;
  const y = r.year;
  setPrintPage({ landscape: true, margin: '10mm' });
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
  setPrintPage({ landscape: false, margin: '14mm 12mm' });
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
  setPrintPage({ landscape: false, margin: '14mm 12mm' });
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
  setPrintPage({ landscape: false, margin: '14mm 12mm' });
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
  </div>`;

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
      toast(r.daysLate ? 'Върната със забава ' + r.daysLate + ' дни (' + mny(r.fine) + ')' : 'Приета обратно: инв. № ' + r.inv_number, r.daysLate ? 'err' : 'ok');
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
    col2 = `<input id="bScan" class="scan" placeholder="Сканирай баркод на документа…" autocomplete="off">
      <div class="hint" style="margin-top:6px">Срок за заемане: ${s.loan_days} дни</div>
      <div id="outLog" style="margin-top:12px"></div>`;
    if (openMine.length) {
      table = `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Заети от този читател</h3>
        <div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
        <th>Инв. №</th><th>Заглавие</th><th>Зает</th><th>Срок</th><th style="width:160px"></th></tr></thead><tbody>
        ${openMine.map(l => `<tr><td class="num">${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
          <td class="num">${bg(l.date_out)}</td>
          <td class="num ${l.date_due && l.date_due < today() ? 'warn' : ''}">${bg(l.date_due) || '—'}</td>
          <td><button class="btn sm" onclick="returnBook(${l.id})">Приеми</button>
              <button class="btn sm" onclick="extendLoan(${l.id})">Продължи</button></td></tr>`).join('')}
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
  toast('Книгата е върната.', 'ok'); markSaved();
  if (VIEW === 'over') renderOver(); else renderCirc();
}
window.returnBook = returnBook;
async function extendLoan(id) {
  const s = SETTINGS_CACHE || { extension_days: 30 };
  const res = await window.api.loans.extend({ id, days: s.extension_days || 30 });
  if (!res.ok) return toast(res.error, 'err');
  toast('Срокът е продължен до ' + bg(res.data) + '.', 'ok'); markSaved();
  if (VIEW === 'over') renderOver(); else renderCirc();
}
window.extendLoan = extendLoan;

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
    <div class="toolbar"><button class="btn" onclick="printOverdueNotices()">Печат на напомняния / PDF</button></div>
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
  $('#view').innerHTML = `
    <div class="note"><b>Чл. 40, т. 2</b> — инвентаризация по репрезентативния метод се извършва ежегодно върху
    не по-малко от <b>${req.pct}%</b> от фонда.</div>
    <div class="cards" style="margin-bottom:16px">
      <div class="card"><div class="num">${req.active}</div><div class="lbl">Фонд</div></div>
      <div class="card"><div class="num">${req.target}</div><div class="lbl">Изискван обхват (${req.pct}%)</div></div>
      <div class="card"><div class="num">${req.naturalLoss.toFixed(1)}</div><div class="lbl">Допустими загуби (чл. 41)</div></div>
    </div>
    <div class="toolbar"><button class="btn pri" onclick="startInventForm()">Започни нова проверка</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Дата</th><th>Обхват</th><th>Проверени</th>
      <th>Липсващи</th><th>Комисия</th><th>Състояние</th></tr></thead><tbody>
    ${sessions.length ? sessions.map(s => `<tr><td class="num">${bg(s.date)}</td><td>${esc(s.scope || '')}</td>
      <td class="num">${s.pool_size}</td><td class="num"></td>
      <td style="font-size:12px">${[s.committee1, s.committee2, s.committee3].filter(Boolean).map(esc).join(', ')}</td>
      <td>${s.closed ? '<span class="badge ok">приключена</span>' : '<span class="badge warn">отворена</span>'}</td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">Няма извършени проверки.</td></tr>`}
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
  $('#view').innerHTML = `
    <div class="note w"><b>Проверка в ход</b> — ${bg(s.date)} · ${esc(s.scope || '')}. Въвеждайте инвентарните номера един по един.</div>
    <div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="num">${s.pool_size}</div><div class="lbl">В обхвата</div></div>
      <div class="card"><div class="num">${s.scans.length}</div><div class="lbl">Намерени</div></div>
    </div>
    <div class="card" style="margin-bottom:14px"><div class="bd" style="padding:14px">
      <input id="ivScan" placeholder="Инвентарен №/баркод…" autocomplete="off" style="width:100%;padding:12px;border:2px solid var(--brass);border-radius:2px;font-family:var(--mono);font-size:16px">
      <div id="ivLog" style="margin-top:10px;max-height:200px;overflow:auto"></div>
    </div></div>
    <div class="toolbar">
      <button class="btn pri" onclick="closeInvent()">Приключи и състави протокол</button>
      <button class="btn" onclick="if(confirm('Прекратяване без запис?')){INVENT_SESSION=null;renderInvent()}">Прекрати</button>
    </div>`;
  const el = $('#ivScan'); el.focus();
  el.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = el.value.trim(); el.value = ''; if (!code) return;
    const res = await window.api.inventorySessions.scan({ sessionId: INVENT_SESSION.id, code });
    const log = $('#ivLog');
    if (!res.ok) { log.insertAdjacentHTML('afterbegin', `<div style="padding:5px 9px;background:var(--redL);font-size:12.5px">${esc(res.error)}</div>`); return; }
    log.insertAdjacentHTML('afterbegin', `<div style="padding:5px 9px;background:var(--greenL);font-size:12.5px"><b>${res.data.inv_number}</b> — ${esc(res.data.title)}</div>`);
    markSaved();
    const k = $('#view .card .num'); if (k) renderInventRun();
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
  setPrintPage({ landscape: false, margin: '14mm 12mm' });
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
  const dayRowHtml = (row) => `<tr><td class="num">${row.day}</td>
    ${cols.map(([k]) => `<td class="num">${dnevnikCell(row, k)}</td>`).join('')}
    <td><button class="btn sm" onclick="dnevnikDayForm('${row.date}')">Редакция</button></td></tr>`;
  const totalRowHtml = (label, row) => `<tr style="font-weight:600;background:var(--paper3)"><td>${esc(label)}</td>
    ${cols.map(([k]) => `<td class="num">${dnevnikCell(row, k)}</td>`).join('')}<td></td></tr>`;
  $('#view').innerHTML = `
    <div class="note">Електронен вариант на месечния статистически дневник на читалищните библиотеки —
    Раздел А (читатели и посещения) и Раздел Б (заети материали). Тоталите за месеца и от началото на
    годината се смятат автоматично, при всяка промяна в дневните данни.</div>
    <div class="toolbar">
      <select onchange="DNEVNIK_YEAR=parseInt(this.value,10);renderDnevnik()">${years.map(x => `<option value="${x}" ${x === y ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <select onchange="DNEVNIK_MONTH=parseInt(this.value,10);renderDnevnik()">${MESETSI.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <div style="display:flex;gap:6px">
        <button class="btn sm ${DNEVNIK_TAB === 'a' ? 'pri' : ''}" onclick="DNEVNIK_TAB='a';renderDnevnik()">Раздел А · Читатели и посещения</button>
        <button class="btn sm ${DNEVNIK_TAB === 'b' ? 'pri' : ''}" onclick="DNEVNIK_TAB='b';renderDnevnik()">Раздел Б · Заети материали</button>
      </div>
      <button class="btn" onclick="printDnevnikDoc()">Печат / PDF</button>
      <button class="btn" onclick="exportDnevnikCsv()">Експорт CSV</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr>
      <th>Число</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}<th></th>
    </tr></thead><tbody>
      ${r.days.map(dayRowHtml).join('')}
      ${totalRowHtml('Всичко за месеца', r.monthTotal)}
      ${totalRowHtml('Всичко от нач. на годината', r.ytdTotal)}
    </tbody></table></div>`;
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
  setPrintPage({ landscape: true, margin: '8mm' });
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
  const bars = (data, tot) => data.map(([k, v]) => `
    <div style="margin-bottom:7px"><div style="display:flex;justify-content:space-between;font-size:12.5px">
    <span>${esc(k)}</span><b>${v} · ${tot ? Math.round(v / tot * 100) : 0}%</b></div>
    <div style="height:7px;background:var(--paper3);border-radius:1px;overflow:hidden">
    <div style="height:100%;width:${tot ? v / tot * 100 : 0}%;background:var(--brass)"></div></div></div>`).join('');
  $('#view').innerHTML = `
    <div class="toolbar">
      <select onchange="STATS_YEAR=this.value;renderStats()">
        ${[y, yr()].filter((v, i, a) => a.indexOf(v) === i).map(x => `<option ${x === y ? 'selected' : ''}>${x}</option>`).join('')}
      </select>
      <span class="hint">отчетен период 01.01.${y} – 31.12.${y}</span>
      <span style="flex:1"></span>
      <button class="btn sm" onclick="addVisits()">Впиши посещения</button>
    </div>
    <div class="cards" style="margin-bottom:16px">
      <div class="card"><div class="num">${r.fundCount}</div><div class="lbl">Библиотечен фонд</div><div class="lbl">${mny(r.fundValue)}</div></div>
      <div class="card"><div class="num">${r.readersCount}</div><div class="lbl">Регистрирани читатели</div></div>
      <div class="card"><div class="num">${r.loansCount}</div><div class="lbl">Заемания</div></div>
      <div class="card"><div class="num">${r.visits}</div><div class="lbl">Посещения</div></div>
    </div>
    <div class="grid g3">
      <div class="card"><h3 style="margin-top:0">Фонд по езици</h3>${bars(r.fundByLanguage, r.fundCount) || '<span class="hint">няма данни</span>'}</div>
      <div class="card"><h3 style="margin-top:0">Фонд по отдели</h3>${bars(r.fundByDepartment, r.fundCount) || '<span class="hint">няма данни</span>'}</div>
      <div class="card"><h3 style="margin-top:0">Фонд по категории</h3>${bars(r.fundByCategory, r.fundCount) || '<span class="hint">няма данни</span>'}</div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Движение през ${y}</h3><div style="font-size:13px;line-height:2.1">
        <div style="display:flex;justify-content:space-between"><span>Постъпили</span><b style="color:var(--green)">+${r.acquiredCount} · ${mny(r.acquiredValue)}</b></div>
        <div style="display:flex;justify-content:space-between"><span>Отчислени</span><b style="color:var(--red)">−${r.deaccessionedCount} · ${mny(r.deaccessionedValue)}</b></div>
        <div style="display:flex;justify-content:space-between"><span>Върнати в срок</span><b>${r.returnedOnTime}</b></div>
        <div style="display:flex;justify-content:space-between"><span>Върнати със забава</span><b>${r.returnedLate}</b></div>
      </div></div>
      <div class="card"><h3 style="margin-top:0">Най-търсени документи</h3>
        ${r.topLoans.length ? r.topLoans.map((t, i) => `<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px solid var(--rule)">
        <span style="color:var(--brass);width:20px">${i + 1}</span><span style="flex:1">${esc(t.title)}</span><b>${t.n}</b></div>`).join('')
        : '<span class="hint">няма данни</span>'}
      </div>
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
  const [status, s] = await Promise.all([call(window.api.catalog.status()), call(window.api.settings.get())]);
  if (!status) return;
  $('#view').innerHTML = `
    <div class="note"><b>Публичен каталог.</b> Изнасят се само библиографски данни и наличност.
    Лични данни на читатели, цени и служебни бележки <b>не</b> се включват никъде в изнесения файл. Каталогът се
    публикува през <b>GitHub</b> — сайтът chyavorec.org чете файла на живо от там, без нужда от друг сървър.</div>

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
        (напр. <code>git clone https://github.com/${esc(status.ghUser || 'plam4o4o-source')}/${esc(status.ghRepo || 'yavorec-katalog')}.git</code>),
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
        ${fld('Потребител в GitHub', 'gh_user', { val: status.ghUser || '', hint: 'напр. plam4o4o-source' })}
        ${fld('Хранилище', 'gh_repo', { val: status.ghRepo || '', hint: 'напр. yavorec-katalog' })}
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
    </div>`;
}
async function catalogChooseFolder() {
  const res = await window.api.catalog.chooseFolder();
  if (!res.ok) return toast(res.error, 'err');
  toast('Папката е свързана — katalog.json се обновява автоматично.', 'ok');
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
    Съвместимо е с обикновен принтер (A4 лист, 3 колони) и с ролкови лейбъл принтери (Zebra, Brother QL, Dymo и др.).</div>

    <div class="card"><h3 style="margin-top:0">Формат на печат за етикети</h3>
      <form id="lblFmtF" onsubmit="return false">
        <div class="grid g3">
          ${fld('Формат', 'lbl_mode', { type: 'select', allowEmpty: false, val: s.lbl_mode, opts: [{ v: 'sheet', t: 'A4 лист (3 колони)' }, { v: 'roll', t: 'Ролков лейбъл принтер (1 етикет на страница)' }] })}
          ${fld('Ширина на етикета (мм)', 'lbl_w', { val: s.lbl_w, type: 'number', hint: 'само за ролков принтер' })}
          ${fld('Височина на етикета (мм)', 'lbl_h', { val: s.lbl_h, type: 'number', hint: 'само за ролков принтер' })}
        </div>
      </form>
      <button class="btn pri" onclick="saveLabelFormat()">Запиши формата</button>
    </div>

    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Баркод етикети за фонда</h3>
        <p class="hint" style="margin-top:0">Всеки етикет съдържа името на библиотеката, баркод и инвентарен номер.</p>
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
        <p class="hint" style="margin-top:0">Печат на баркод карти за всички активни читатели.</p>
        <button class="btn pri" onclick="printCardsAll()">Печат на карти</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Етикети за сигнатура (за гръбчето на книгата)</h3>
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
}
window.saveLabelFormat = saveLabelFormat;
async function activeBooks() {
  const books = await call(window.api.books.list(''));
  return (books || []).filter(b => b.status !== 'отчислен');
}
async function printLabelsRange() {
  const from = parseInt($('[name=lblFrom]').value, 10), to = parseInt($('[name=lblTo]').value, 10);
  if (!from || !to || to < from) return toast('Въведете валиден диапазон от инвентарни номера.', 'err');
  const rows = (await activeBooks()).filter(b => b.inv_number >= from && b.inv_number <= to).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Няма документи в този диапазон.', 'err');
  printLabelSheet(rows.map(lblCard).join(''));
}
window.printLabelsRange = printLabelsRange;
async function printLabelsAll() {
  const rows = (await activeBooks()).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Фондът е празен.', 'err');
  printLabelSheet(rows.map(lblCard).join(''));
}
window.printLabelsAll = printLabelsAll;
async function printSignatureLabelsRange() {
  const from = parseInt($('[name=sigFrom]').value, 10), to = parseInt($('[name=sigTo]').value, 10);
  if (!from || !to || to < from) return toast('Въведете валиден диапазон от инвентарни номера.', 'err');
  const rows = (await activeBooks()).filter(b => b.inv_number >= from && b.inv_number <= to).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Няма документи в този диапазон.', 'err');
  printLabelSheet(rows.map(sigLblCard).join(''));
}
window.printSignatureLabelsRange = printSignatureLabelsRange;
async function printSignatureLabelsAll() {
  const rows = (await activeBooks()).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Фондът е празен.', 'err');
  printLabelSheet(rows.map(sigLblCard).join(''));
}
window.printSignatureLabelsAll = printSignatureLabelsAll;
async function printCardsAll() {
  const readers = await call(window.api.readers.list(''));
  const rows = (readers || []).filter(r => r.status !== 'прекратен');
  if (!rows.length) return toast('Няма активни читатели.', 'err');
  const s = SETTINGS_CACHE || {};
  printLabelSheet(rows.map(r => `<div class="lbl">
    <div class="l1">${esc(s.lib_name || '')}</div>${code39svg(r.card_no || String(r.id), 150, 40)}
    <div class="l3">${esc(r.card_no || '')}</div>
    <div style="font-size:8pt;margin-top:1mm">${esc(r.name || '')}</div></div>`).join(''));
}
window.printCardsAll = printCardsAll;
async function printReaderCard(id) {
  const r = await call(window.api.readers.get(id));
  if (!r) return;
  const loans = await call(window.api.loans.byReader(id)) || [];
  setPrintPage({ landscape: false, margin: '14mm 12mm' });
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
  setPrintPage({ landscape: false, margin: '14mm 12mm' });
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
  const [s, dbLoc, backups, employees] = await Promise.all([
    call(window.api.settings.get()), call(window.api.dbLocation.get()),
    call(window.api.backup.list()), call(window.api.employees.list())
  ]);
  if (!s) return;
  window._EMPLOYEES_ALL = employees || [];
  $('#view').innerHTML = `
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
        <button class="btn pri" onclick="backupNow()">Направи резервно копие сега…</button>
        <button class="btn" onclick="restoreBackupBrowse()">Възстанови от файл…</button>
      </div>
      ${backups && backups.length ? `<div class="wrap" style="margin-top:10px"><table class="ledger"><thead><tr>
        <th>Файл</th><th>Дата и час</th><th>Размер</th><th>Вид</th><th></th></tr></thead><tbody>
        ${backups.map(b => `<tr><td style="font-family:var(--mono);font-size:12px">${esc(b.name)}</td>
          <td class="num">${fmtDateTime(b.mtime)}</td><td class="num">${fmtBytes(b.size)}</td>
          <td>${b.auto ? '<span class="badge">автоматично</span>' : '<span class="badge ok">ръчно</span>'}</td>
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
async function backupNow() {
  const res = await window.api.backup.now();
  if (!res.ok) return toast(res.error, 'err');
  toast('Резервно копие записано: ' + res.data, 'ok');
  renderSetup();
}
window.backupNow = backupNow;
async function restoreBackupFromList(path) {
  if (!confirm('Възстановяване от това резервно копие ще замени текущите данни в програмата и ще я рестартира. Текущата база се пази автоматично като допълнително копие преди възстановяването. Продължавате ли?')) return;
  const res = await window.api.backup.restoreFromList(path);
  if (!res.ok) toast(res.error, 'err');
}
window.restoreBackupFromList = restoreBackupFromList;
async function restoreBackupBrowse() {
  if (!confirm('Ще изберете файл с резервно копие (.db) от компютъра/USB/мрежов диск. Той ще замени текущите данни в програмата и тя ще се рестартира. Текущата база се пази автоматично като допълнително копие преди възстановяването. Продължавате ли?')) return;
  const res = await window.api.backup.restoreBrowse();
  if (!res.ok) toast(res.error, 'err');
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
async function saveSetup() {
  const d = formData('#stF'); d.id = 1;
  await call(window.api.settings.update(d), 'Настройките са записани.');
  await loadSettingsCache();
}
window.saveSetup = saveSetup;

/* ---------------- Старт ---------------- */
initUserBadge();
initAppCredit();
initSavedIndicator();
initAutoUpdateUI();
loadSettingsCache().then(route);
