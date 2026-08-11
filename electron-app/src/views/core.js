'use strict';

/* ---------------- Помощни функции ---------------- */
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* Стойност, която се вгражда като JS низ в единични кавички вътре в onclick="…".
   Редът е СЪЩЕСТВЕН: първо екраниране за JavaScript (\ и '), чак след това за HTML.
   Обратният ред — esc(x).replace(/'/g, …) — беше мъртъв код: esc() вече е превърнал
   ' в &#39;, така че replace-ът няма какво да намери, а HTML парсерът връща &#39;
   като истински апостроф точно преди тялото на handler-а да се компилира. Затова
   име като „Жана д'Арк“ (или път на резервно копие с апостроф) чупеше бутона със
   SyntaxError и той просто не правеше нищо. */
const jsq = (s) => esc(String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
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
/* Клавиатурна активация на кликаеми <div> карти (v1.70.0) — .prsCard/.chrItem
   (Персоналии/Летопис) бяха обикновени <div onclick>, без tabindex и без
   клавиатурен път за отваряне; вижте tabindex="0" role="button" на самите
   карти в persons.js/chronicle.js. Enter и Интервал са стандартните клавиши
   за активиране на елемент с role="button". */
function cardActivate(e, fn) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
}
window.cardActivate = cardActivate;

/* ---------------- Съобщения (toast) ----------------
   v1.69.0: по-големи и по-забележими. Грешките излизат ГОРЕ В ЦЕНТЪРА (там е
   погледът при работа с форма) и стоят 10 сек; успехите — долу вдясно, 3.5 сек.
   При посочване с мишката броячът спира (и лентичката, и изчезването). Повторно
   еднакво съобщение не трупа втора кутийка — само вдига брояч „×N“ и рестартира
   времето. Всяко съобщение има бутон × за незабавно затваряне. */
const TOAST_MS = { ok: 3500, err: 10000, def: 4500 };
const TOAST_LIVE = new Map(); // ключ тип|текст → запис на живо съобщение
function toast(msg, type) {
  msg = String(msg ?? '');
  const key = (type || '') + '|' + msg;
  const live = TOAST_LIVE.get(key);
  if (live && live.el.isConnected) {
    live.count++;
    const c = live.el.querySelector('.tcount');
    if (c) { c.textContent = '×' + live.count; c.style.display = ''; }
    clearTimeout(live.timer);
    live.remaining = live.total;
    toastStartTimer(key, live);
    // Рестарт на лентичката-брояч: спира се анимацията, налага се reflow, пуска се пак.
    const p = live.el.querySelector('.tprog');
    if (p) { p.style.animation = 'none'; void p.offsetWidth; p.style.animation = ''; }
    return;
  }
  const box = (type === 'err' && $('#toastsTop')) || $('#toasts');
  if (!box) return;
  const total = TOAST_MS[type] || TOAST_MS.def;
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  el.style.setProperty('--tdur', total + 'ms');
  const ico = type === 'err' ? '✕' : type === 'ok' ? '✓' : 'ℹ';
  el.innerHTML = `<span class="tico">${ico}</span><div class="tmsg"></div>` +
    `<span class="tcount" style="display:none"></span>` +
    `<button class="tx" title="Затвори" aria-label="Затвори">&times;</button><i class="tprog"></i>`;
  el.querySelector('.tmsg').textContent = msg;
  const rec = { el, total, remaining: total, started: 0, timer: null, count: 1 };
  el.querySelector('.tx').addEventListener('click', () => toastClose(key, rec));
  el.addEventListener('mouseenter', () => {
    if (!rec.timer) return;
    clearTimeout(rec.timer); rec.timer = null;
    rec.remaining -= Date.now() - rec.started;
  });
  el.addEventListener('mouseleave', () => { if (!rec.timer && el.isConnected) toastStartTimer(key, rec); });
  // Най-старото се маха без анимация, ако се натрупат повече от 4 в един контейнер.
  while (box.children.length >= 4) { box.firstChild.remove(); }
  box.appendChild(el);
  TOAST_LIVE.set(key, rec);
  toastStartTimer(key, rec);
}
function toastStartTimer(key, rec) {
  rec.started = Date.now();
  rec.timer = setTimeout(() => toastClose(key, rec), Math.max(300, rec.remaining));
}
function toastClose(key, rec) {
  clearTimeout(rec.timer); rec.timer = null;
  TOAST_LIVE.delete(key);
  rec.el.classList.add('out');
  setTimeout(() => rec.el.remove(), 260);
}

/* Открояване на записания ред в таблица: светва в зелено и избледнява (v1.69.0).
   Вика се СЛЕД пререндирането, с CSS селектор към <tr data-id="…">. Ако редът
   не е на екрана (следваща страница на „Покажи още“), просто не прави нищо. */
function flashRow(sel) {
  requestAnimationFrame(() => {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (!el) return;
    el.classList.remove('rowFlash'); void el.offsetWidth;
    el.classList.add('rowFlash');
    setTimeout(() => el.classList.remove('rowFlash'), 1400);
  });
}
window.flashRow = flashRow;

/* Звуков сигнал при сканиране (v1.69.0) — кратък висок тон при успех, двоен
   нисък при отказ. При баркод четец очите са върху книгата, не върху екрана —
   звукът е обратната връзка, която реално се забелязва (както в касовите
   системи и в Koha). Изключва се от „Настройки“ → „Външен вид“ (scan_sound).
   Web Audio API — без звукови файлове; в тестова среда (jsdom) AudioContext
   липсва и функцията просто мълчи. */
let AUDIO_CTX = null;
function beep(kind) {
  try {
    const s = SETTINGS_CACHE || {};
    if (s.scan_sound != null && !+s.scan_sound) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    AUDIO_CTX = AUDIO_CTX || new AC();
    const t0 = AUDIO_CTX.currentTime;
    const tone = (freq, start, dur) => {
      const o = AUDIO_CTX.createOscillator(), g = AUDIO_CTX.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(AUDIO_CTX.destination);
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(0.2, t0 + start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.start(t0 + start); o.stop(t0 + start + dur + 0.03);
    };
    if (kind === 'err') { tone(220, 0, 0.13); tone(220, 0.17, 0.13); }
    else tone(880, 0, 0.09);
  } catch (e) { console.error('Звуков сигнал:', e.message); }
}
window.beep = beep;

/* Прозорците се затварят с кратка огледална анимация (v1.69.0). Ако веднага
   след closeModal() се отвори нов прозорец, отложеното изчистване се отменя —
   иначе таймерът би изтрил току-що отвореното съдържание. */
let MODAL_CLOSE_T = null;
function modal(title, body, footer) {
  clearTimeout(MODAL_CLOSE_T);
  $('#veil').classList.remove('closing');
  $('#modal').innerHTML =
    `<header><h2>${esc(title)}</h2><button class="x" onclick="closeModal()">&times;</button></header>
     <div class="body">${body}</div>
     ${footer ? `<footer>${footer}</footer>` : ''}`;
  $('#veil').classList.add('on');
  setTimeout(() => { const i = $('#modal input,#modal select,#modal textarea'); if (i) i.focus(); }, 40);
}
function closeModal() {
  const veil = $('#veil');
  if (!veil.classList.contains('on') || veil.classList.contains('closing')) return;
  veil.classList.add('closing');
  clearTimeout(MODAL_CLOSE_T);
  MODAL_CLOSE_T = setTimeout(() => {
    veil.classList.remove('on', 'closing');
    $('#modal').innerHTML = '';
  }, 140);
}
window.closeModal = closeModal;

/* Втори слой — за помощни прозорци върху вече отворена форма (изборът на УДК).
   Първият слой остава непокътнат, за да не се губи попълненото. */
let MODAL2_CLOSE_T = null;
function modal2(title, body, footer) {
  clearTimeout(MODAL2_CLOSE_T);
  $('#veil2').classList.remove('closing');
  $('#modal2').innerHTML =
    `<header><h2>${esc(title)}</h2><button class="x" onclick="closeModal2()">&times;</button></header>
     <div class="body">${body}</div>
     ${footer ? `<footer>${footer}</footer>` : ''}`;
  $('#veil2').classList.add('on');
}
function closeModal2() {
  const veil = $('#veil2');
  if (!veil.classList.contains('on') || veil.classList.contains('closing')) return;
  veil.classList.add('closing');
  clearTimeout(MODAL2_CLOSE_T);
  MODAL2_CLOSE_T = setTimeout(() => {
    veil.classList.remove('on', 'closing');
    $('#modal2').innerHTML = '';
  }, 140);
}
window.closeModal2 = closeModal2;

// Esc затваря най-горния отворен прозорец. Прозорец в процес на затваряне
// (.closing, 140 ms) се брои за вече затворен — иначе две бързи натискания
// на Esc биха „изяли“ второто, вместо да затворят и долния слой.
const veilOpen = (sel) => { const v = $(sel); return v.classList.contains('on') && !v.classList.contains('closing'); };
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (veilOpen('#veil2')) closeModal2();
  else if (veilOpen('#veil')) closeModal();
});

/* Предпазител при Ctrl+P извън печатните екрани (v1.70.0) — #printArea е
   празен, докато не мине през doPrint() (виж по-долу); печатната таблица
   (@media print{body *{visibility:hidden}}) показва само нея. Без този
   предпазител Ctrl+P на произволен екран (Табло, Книги, Настройки…) даваше
   празна страница без никакво обяснение защо. window.print() тук НЕ се вика
   директно — само предупреждава и връща потребителя към собствения бутон
   „Печат“ на съответния раздел. */
window.addEventListener('beforeprint', () => {
  const pa = $('#printArea');
  if (pa && !pa.innerHTML.trim()) {
    toast('Тук няма подготвен документ за печат — ползвайте бутона „Печат“ в съответния раздел.', 'err');
  }
});

/* ---------------- askText: заместител на window.prompt() ----------------
   Electron НЕ поддържа window.prompt() — извикването хвърля „prompt() is not
   supported.“ право в handler-а на бутона. Проверено с истинския Electron 43
   от package.json. Резултатът е най-лошият възможен вид дефект: бутонът не
   прави НИЩО — без прозорец, без съобщение, без грешка на екрана. Точно
   затова „Витрини в каталога“ изглеждаха счупени: „+ Нова витрина“ умираше
   на първия ред и витрина не можеше да се създаде изобщо (а без витрина и
   всичко останало в раздела е безсмислено).

   Тук прозорецът е същият като всички други в програмата (modal/modal2),
   така че се държи еднакво: Enter потвърждава, Esc/× отказва. Връща Promise
   с въведения текст или null при отказ — и ЗАДЪЛЖИТЕЛНО се разрешава при
   всеки изход, за да не увисне извикващият код.

   Ползва втория слой (modal2), ако вече има отворен прозорец — иначе би
   изтрил формата, върху която е извикан (напр. бележка към посещение по
   домовете се пита върху вече отворената картонена справка). */
function askText(title, opts) {
  opts = opts || {};
  const second = veilOpen('#veil');
  const show = second ? modal2 : modal;
  const hide = second ? closeModal2 : closeModal;
  const rootSel = second ? '#modal2' : '#modal';
  return new Promise(resolve => {
    show(title,
      `<form id="askTextF" onsubmit="return false">
         ${fld(opts.label || 'Стойност', 'v', { val: opts.value || '', hint: opts.hint })}
       </form>${opts.note ? `<div class="hint">${esc(opts.note)}</div>` : ''}`,
      `<button class="btn" data-ask="cancel">Отказ</button>
       <button class="btn pri" data-ask="ok">${esc(opts.okLabel || 'Готово')}</button>`);
    const box = $(rootSel);
    const input = box.querySelector('input[name="v"]');
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      hide();
      resolve(val);
    };
    // Esc се обработва и от общия слушател по-горе (той само затваря прозореца);
    // тук е нужен собствен, за да се разреши и обещанието, вместо да увисне.
    function onKey(e) { if (e.key === 'Escape') finish(null); }
    document.addEventListener('keydown', onKey, true);
    box.querySelector('[data-ask="ok"]').addEventListener('click', () => finish(input.value));
    box.querySelector('[data-ask="cancel"]').addEventListener('click', () => finish(null));
    const x = box.querySelector('header .x');
    if (x) x.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value); }
    });
    input.focus();
    input.select();
  });
}
window.askText = askText;

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
    return `<div class="field"><label>${esc(label)}${opts.req ? ' <b class="req" aria-hidden="true">*</b>' : ''}${opts.hint ? ' <span class="fh">' + opts.hint + '</span>' : ''}</label><select name="${name}" ${opts.req ? 'required' : ''} ${opts.onchange ? `onchange="${opts.onchange}"` : ''}>
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
  // opts.req (v1.70.0): освен HTML атрибута required, добавя и видима звездичка
  // в етикета — преди това нямаше никакво визуално обозначение (виж
  // firstMissingRequired() по-долу за защо самият required не стига).
  return `<div class="field"><label>${esc(label)}${opts.req ? ' <b class="req" aria-hidden="true">*</b>' : ''}${opts.hint ? ' <span class="fh">' + opts.hint + '</span>' : ''}</label>
    <input name="${name}" type="${type}" ${opts.step ? 'step="' + opts.step + '"' : ''} ${opts.req ? 'required' : ''}
      ${opts.list ? `list="dl_${opts.list}"` : ''} ${opts.disabled ? 'disabled' : ''} value="${esc(val)}"></div>`;
}

/* ---------------- Проверка на задължителните полета преди запис ----------------
   v1.70.0: атрибутът required не се проверява от браузъра, защото формите тук
   не се предават по стандартния начин (onsubmit="return false", saveX() чете
   стойностите директно през formData() и вика IPC) — затова се проверява ръчно
   тук, вместо всяка saveX() да пази собствен списък кои полета са задължителни.
   formSel е CSS селектор към <form> (или друг контейнер с полета в .field).
   Връща етикета на първото празно задължително поле (за съобщение towards
   потребителя), или null ако всичко е попълнено. */
function firstMissingRequired(formSel) {
  const root = $(formSel);
  if (!root) return null;
  const els = root.querySelectorAll('[required]');
  for (const el of els) {
    const empty = el.type === 'checkbox' ? !el.checked : !String(el.value ?? '').trim();
    if (empty) return fieldLabelOf(el);
  }
  return null;
}
function fieldLabelOf(el) {
  const wrap = el.closest('.field');
  const lbl = wrap && wrap.querySelector('label');
  if (!lbl) return el.name || 'Полето';
  const clone = lbl.cloneNode(true);
  clone.querySelectorAll('.fh,.req').forEach(n => n.remove());
  return (clone.textContent || '').trim() || (el.name || 'Полето');
}
window.firstMissingRequired = firstMissingRequired;

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
         one('series', sug.series || []) + one('udk', udkAll);
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
async function setScanSound(on) {
  await call(window.api.settings.updateScanSound(on ? 1 : 0), on ? 'Звукът при сканиране е включен.' : 'Звукът при сканиране е изключен.');
  await loadSettingsCache();
  if (on) beep('ok'); // кратка проба, за да се чуе как звучи
}
window.setScanSound = setScanSound;

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
