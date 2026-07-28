'use strict';

/* ---------------- Помощни функции ---------------- */
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => new Date().toISOString().slice(0, 10);
const yr = (d) => (d || today()).slice(0, 4);
const bg = (d) => d ? d.split('-').reverse().join('.') : '';
const mny = (n) => (Number(n) || 0).toFixed(2) + ' лв.';
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
  if (okMsg) toast(okMsg, 'ok');
  return res.data;
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
async function loadSettingsCache() { SETTINGS_CACHE = await call(window.api.settings.get()); return SETTINGS_CACHE; }
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
  const s = SETTINGS_CACHE || {};
  return `<div class="lbl lbl-sig">
    <div class="ls-udk">${esc(b.udk || '')}</div>
    <div class="ls-avt">${esc(b.author_mark || b.call_number || '')}</div>
    <div class="ls-org">${esc(s.lib_name || '')}, ${esc(s.place || '')}</div>
    ${code39svg(b.barcode || String(b.inv_number), 150, 36)}
    <div class="ls-inv">${b.inv_number}</div>
  </div>`;
}

/* ---------------- Навигация ---------------- */
const NAV = [
  { g: 'Общ преглед', items: [['dash', 'Табло']] },
  { g: 'Фонд', items: [['books', 'Книги'], ['categories', 'Категории'], ['invbook', 'Инвентарна книга'],
    ['kdbf', 'КДБФ'], ['acq', 'Постъпления'], ['acts', 'Отчисляване'], ['invent', 'Инвентаризация']] },
  { g: 'Читатели', items: [['readers', 'Читатели'], ['circ', 'Заемане и връщане'], ['over', 'Просрочени']] },
  { g: 'Други регистри', items: [['periodika', 'Периодика'], ['mzs', 'МЗС']] },
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
  periodika: renderPeriodika, mzs: renderMzs,
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

/* ---------------- Служител (одитна следа) ---------------- */
async function initUserBadge() {
  const name = await call(window.api.app.getUser());
  renderUserBadge(name);
}
function renderUserBadge(name) {
  const el = $('#userBadge');
  if (!el) return;
  el.textContent = name ? 'Служител: ' + name : 'Служител: (задайте име)';
}
async function setCurrentUser() {
  const name = prompt('Име на служителя, който работи в момента (записва се в одитната следа):', '');
  if (name === null) return;
  const saved = await call(window.api.app.setUser(name.trim()));
  renderUserBadge(saved);
}
window.setCurrentUser = setCurrentUser;

/* ---------------- Табло ---------------- */
async function renderDash() {
  const s = await call(window.api.dashboard.stats());
  if (!s) return;
  $('#view').innerHTML = `
    <div class="cards">
      <div class="card"><div class="num">${s.books}</div><div class="lbl">Книги във фонда</div></div>
      <div class="card"><div class="num">${s.readers}</div><div class="lbl">Читатели</div></div>
      <div class="card"><div class="num">${s.loansOpen}</div><div class="lbl">Заети в момента</div></div>
      <div class="card"><div class="num">${s.overdue}</div><div class="lbl">Просрочени</div></div>
    </div>
    <div class="hint">Използвайте менюто вляво, за да управлявате фонда, читателите и движението на библиотечния фонд.</div>
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
      <div class="grid g3">
        ${fld('Цена (лв.)', 'price', { val: v.price ?? 0, type: 'number', step: '0.01', req: 1 })}
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
  toast('Книгата е изтрита.', 'ok');
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
  closeModal(); renderAcq(); toast('Партидата е изтрита.', 'ok');
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
  if (id) { closeModal(); renderActs(); toast('Акт № ' + d.no + ': отчислени са ' + ACT_LIST.length + ' документа.', 'ok'); }
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
  closeModal(); renderActs(); toast('Актът е анулиран.', 'ok');
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
  toast('Читателят е изтрит.', 'ok');
  renderReaders();
}
window.deleteReader = deleteReader;

/* ---------------- Заемане и връщане ---------------- */
async function renderCirc() {
  const [open, books, readers, settings] = await Promise.all([
    call(window.api.loans.list({ onlyOpen: true })), call(window.api.books.list('')),
    call(window.api.readers.list('')), call(window.api.settings.get())
  ]);
  if (!open) return;
  window._SETTINGS = settings;
  const bookOpts = (books || []).filter(b => b.available > 0)
    .map(b => `<option value="${b.id}">${esc(b.title)} (${b.available} налични)</option>`).join('');
  const readerOpts = (readers || []).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  const defDue = new Date(); defDue.setDate(defDue.getDate() + (settings ? settings.loan_days : 30));
  $('#view').innerHTML = `
    <div class="wrap" style="margin-bottom:20px">
      <table class="ledger"><thead><tr><th colspan="6">Ново заемане</th></tr></thead>
      <tbody><tr><td colspan="6" style="padding:14px">
        <form id="circF" onsubmit="return false" class="grid g3">
          <div class="field"><label>Читател</label><select name="reader_id">${readerOpts || '<option value="">— няма читатели —</option>'}</select></div>
          <div class="field"><label>Книга</label><select name="book_id">${bookOpts || '<option value="">— няма налични книги —</option>'}</select></div>
          <div class="field"><label>Срок за връщане</label><input name="date_due" type="date" value="${defDue.toISOString().slice(0, 10)}"></div>
        </form>
      </td></tr>
      <tr><td colspan="6" style="text-align:right;padding:0 14px 14px"><button class="btn pri" onclick="checkoutBook()">Заеми книгата</button></td></tr>
      </tbody></table>
    </div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Читател</th><th>Книга</th><th>Дата на заемане</th><th>Срок</th><th style="width:180px"></th></tr></thead>
      <tbody>
        ${open.length ? open.map(l => `
          <tr><td>${esc(l.reader_name)}</td><td>${esc(l.title)}</td><td class="num">${bg(l.date_out)}</td>
            <td class="num ${l.date_due && l.date_due < today() ? 'warn' : ''}">${bg(l.date_due) || '—'}</td>
            <td><button class="btn sm" onclick="returnBook(${l.id})">Приеми</button>
                <button class="btn sm" onclick="extendLoan(${l.id})">Продължи</button></td></tr>`).join('')
          : `<tr><td colspan="5" class="empty">Няма заети в момента книги.</td></tr>`}
      </tbody>
    </table></div>`;
}
async function checkoutBook() {
  const d = formData('#circF');
  if (!d.reader_id || !d.book_id) return toast('Изберете читател и книга.', 'err');
  const res = await window.api.loans.checkout({
    reader_id: parseInt(d.reader_id, 10), book_id: parseInt(d.book_id, 10), date_out: today(), date_due: d.date_due || null
  });
  if (!res.ok) return toast(res.error, 'err');
  toast('Книгата е заета.', 'ok');
  renderCirc();
}
window.checkoutBook = checkoutBook;
async function returnBook(id) {
  const res = await window.api.loans.return({ id, date_in: today() });
  if (!res.ok) return toast(res.error, 'err');
  toast('Книгата е върната.', 'ok');
  if (VIEW === 'over') renderOver(); else renderCirc();
}
window.returnBook = returnBook;
async function extendLoan(id) {
  const s = window._SETTINGS || { extension_days: 30 };
  const res = await window.api.loans.extend({ id, days: s.extension_days || 30 });
  if (!res.ok) return toast(res.error, 'err');
  toast('Срокът е продължен до ' + bg(res.data) + '.', 'ok');
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
    const k = $('#view .card .num'); if (k) renderInventRun();
  });
}
async function closeInvent() {
  const res = await window.api.inventorySessions.close(INVENT_SESSION.id);
  if (!res.ok) return toast(res.error, 'err');
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
  openPeriodical(periodicalId);
}
window.addIssue = addIssue;
async function delIssue(id, periodicalId) {
  await call(window.api.periodicalIssues.delete(id));
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
  closeModal(); renderMzs(); toast('Изтрито.', 'ok');
}
window.delMzs = delMzs;

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
  $('#view').innerHTML = `
    <div class="note">Автоматичното публикуване към chyavorec.org (чрез katalog.json и git синхронизация) се управлява
    от отделното приложение <b>inventar-biblioteka.html</b> и не е част от тази десктоп версия.</div>
    <div class="card"><h3 style="margin-top:0">Локален експорт на каталога</h3>
      <p style="font-size:13.5px">Изнася наличния фонд в JSON файл със същия формат, използван за онлайн каталога.</p>
      <button class="btn pri" onclick="exportCatalog()">Експорт на katalog.json…</button>
    </div>`;
}
async function exportCatalog() {
  const res = await window.api.catalog.export();
  if (!res.ok) return toast(res.error, 'err');
  toast('Каталогът е записан в ' + res.data, 'ok');
}
window.exportCatalog = exportCatalog;

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
      </div>
      <div class="card"><h3 style="margin-top:0">Читателски карти</h3>
        <p class="hint" style="margin-top:0">Печат на баркод карти за всички активни читатели.</p>
        <button class="btn pri" onclick="printCardsAll()">Печат на карти</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Етикети за сигнатура (за гръбчето на книгата)</h3>
      <div class="note" style="margin-top:0">УДК на първия ред, авторски знак под него, името на библиотеката над баркода,
      инвентарният номер под баркода.</div>
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
async function renderSetup() {
  const s = await call(window.api.settings.get());
  if (!s) return;
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
    </form>`;
}
async function saveSetup() {
  const d = formData('#stF'); d.id = 1;
  await call(window.api.settings.update(d), 'Настройките са записани.');
  await loadSettingsCache();
}
window.saveSetup = saveSetup;

/* ---------------- Старт ---------------- */
initUserBadge();
loadSettingsCache().then(route);
