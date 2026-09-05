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
/* Одит на документите v2.4.17: новият ред НЕ се екранираше. Заглавие с прекъсване
   (вносът от CSV ги запазва вътре в цитирани полета) даваше незатворен низ вътре в
   onclick="…" — бутонът „Разписка“ просто не правеше нищо, без грешка и без
   съобщение. U+2028/U+2029 са същият капан за JavaScript парсера. */
const jsq = (s) => esc(String(s ?? '')
  .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  .replace(/\n/g, '\\n').replace(/\r/g, '\\r')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
const today = () => new Date().toISOString().slice(0, 10);
const yr = (d) => (d || today()).slice(0, 4);
const bg = (d) => d ? d.split('-').reverse().join('.') : '';
/* Годините за падащите менюта на Дневника, КДБФ, статистиката и справките (v2.2.0).
   Дотогава списъкът се строеше като [избраната, текущата] — тоест менюто имаше
   ЕДНА опция и избраната година можеше да се смени само през самото меню. На
   05.01.2027 г. библиотекарят нямаше как да отвори дневника за декември 2026 или
   КДБФ за 2026. Затова: текущата и YEAR_SPAN_BACK назад, плюс избраната, ако е
   извън обхвата (стара година, отворена по друг път), подредени низходящо.
   numeric=true връща числа — дневникът работи с числови години. */
const YEAR_SPAN_BACK = 5;
function yearOptions(selected, numeric) {
  const cur = parseInt(yr(), 10);
  const list = [];
  for (let i = 0; i <= YEAR_SPAN_BACK; i++) list.push(cur - i);
  const s = parseInt(selected, 10);
  if (Number.isFinite(s) && !list.includes(s)) list.push(s);
  list.sort((a, b) => b - a);
  return numeric ? list : list.map(String);
}
window.yearOptions = yearOptions;
/* Фиксиран, необратим курс лев–евро по Регламент (ЕС) 2025/1409 на Съвета — БНБ,
   в сила от 01.01.2026 г. Не е борсов курс и не се обновява. */
const EUR_RATE = 1.95583;
const bgn = (n) => (Number(n) || 0).toFixed(2);
/* Съгласуване по число (одит v2.4.25): „1 документ“, „2 документа“. Връща числото
   и формата; за наречията/глаголите (остана/останаха) се подава цял израз. */
const pl = (n, one, many) => n + ' ' + (Number(n) === 1 ? one : many);
const dni = (n) => pl(n, 'ден', 'дни');
const eur = (n) => ((Number(n) || 0) / EUR_RATE).toFixed(2);
const mny = (n) => bgn(n) + ' лв. / ' + eur(n) + ' €';
/* Същата сума за КЛЕТКА в таблица (v2.4.29): левовете над евровете, без пренасяне —
   „3.00 лв. / 1.53 €“ се чупеше на четири реда в инвентарната книга и в „Просрочени“. */
const mnyCell = (n) => `<span class="money" title="${bgn(n)} лв. / ${eur(n)} €">${bgn(n)} лв.<small>${eur(n)} €</small></span>`;
/* Огледало на csvCell() от security-utils.js за изнасянията, които се сглобяват
   в екранния слой. Excel и LibreOffice изпълняват като ФОРМУЛА всяка клетка,
   започваща с =, +, - или @; водещият апостроф ги неутрализира. Двете
   реализации трябва да останат еднакви — тестът fixes-audit-v2414 ги сравнява
   знак по знак. */
function csvSafe(x) {
  let s = String(x ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
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
   времето. Всяко съобщение има бутон × за незабавно затваряне.

   v2.4.33 (графично): вместо плътни цветни плочи (тъмна/зелена/червена) —
   светла картичка в цвета на хартията с цветен кант отляво, икона в кръгче и
   лентичка-брояч в същия цвят. Видът се носи от една CSS променлива (--tc),
   така че четирите вида (ok / err / warn / информация) са една и съща кутийка
   с различен цвят. Иконите са SVG с currentColor, а не текстови знаци — „✓“ и
   „ℹ“ се рисуваха с различни шрифтове и тежест на различни машини. Нов вид
   'warn' (предупреждение, кехлибарено, 6 сек, горе в центъра като грешките):
   за неща, които не са грешка, но библиотекарят трябва да забележи. */
const TOAST_MS = { ok: 3500, err: 10000, warn: 6000, def: 4500 };
const TOAST_ICON = {
  ok: '<path d="M4.5 12.5l4.8 4.8L19.5 7"/>',
  err: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  warn: '<path d="M12 4L2.8 20h18.4L12 4z"/><path d="M12 10v4.5M12 17.4v.01"/>',
  def: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/>'
};
const svgIcon = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
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
  const box = ((type === 'err' || type === 'warn') && $('#toastsTop')) || $('#toasts');
  if (!box) return;
  const total = TOAST_MS[type] || TOAST_MS.def;
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  el.style.setProperty('--tdur', total + 'ms');
  const ico = svgIcon(TOAST_ICON[type] || TOAST_ICON.def);
  el.innerHTML = `<span class="tico" data-kind="${type || 'info'}">${ico}</span><div class="tmsg"></div>` +
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

/* ---------------- Прозоречен рендер на таблици (обща помощна функция, v2.3.0) ----------------
   ЗАЩО обща: ограничение на изчертаваните редове имаха само три екрана —
   „Книги“, „Читатели“ и „Инвентарна книга“ — всеки със собствено копие на един
   и същ код, а останалите 33 екрана чертаят целия резултат наведнъж. Тук е
   общият вариант, за да може всеки следващ екран да го ползва наготово, вместо
   да преоткрива модела (и неговите капани) за четвърти път.

   ЗАЩО insertAdjacentHTML вместо innerHTML: и трите екрана правеха
   rows.slice(0, LIMIT) и презаписваха ЦЕЛИЯ <tbody> при всяко „Покажи още“ —
   тоест изчертаваха наново и вече показаните редове. Работата расте
   квадратично: измерено в „Книги“ при 15 000 записа, 49 натискания от 300 до
   15 000 реда отнеха 112 462 ms, като първите натискания бяха ~250 ms, а
   последните — 5 691 ms всяко. Добавянето само на новата порция прави всяко
   натискане еднакво евтино.

   RENDER_PAGE_SIZE е общият размер на порцията (300 реда — толкова, колкото
   вече ползват трите екрана).

   o = { body, bar, rows, limit, painted, rowsHtml, emptyHtml, moreHtml }
     body/bar  — CSS селектор или елемент; bar е лентата с „Покажи още“
     rows      — ПЪЛНИЯТ (филтриран) списък; limit — колко от него да се видят
     painted   — колко реда вече стоят в тялото; 0 (по подразбиране) = пълен рендер
     rowsHtml(part) — HTML за подадените редове; emptyHtml — при нула редове
     moreHtml(more, total) — HTML на лентата отдолу
   Връща новия брой изчертани редове — извикващият го пази за следващия път. */
const RENDER_PAGE_SIZE = 300;
function paintRowWindow(o) {
  const body = typeof o.body === 'string' ? $(o.body) : o.body;
  const bar = typeof o.bar === 'string' ? $(o.bar) : o.bar;
  const rows = o.rows || [];
  const limit = o.limit == null ? rows.length : Math.max(0, o.limit);
  const shown = Math.min(limit, rows.length);
  const painted = Math.max(0, o.painted || 0);
  /* Добавя се само когато в тялото наистина стоят точно тези `painted` реда
     (body.children.length === painted). Всяко друго положение — ново търсене,
     сменен филтър, друга подредба, прясно пресъздадена таблица — е пълен
     рендер: иначе към резултата от стария филтър биха се долепили редове от
     новия и таблицата би показала смес, която не отговаря на нищо. */
  const append = painted > 0 && shown > painted && body && body.children.length === painted;
  if (body) {
    if (append) body.insertAdjacentHTML('beforeend', o.rowsHtml(rows.slice(painted, shown)));
    else body.innerHTML = shown ? o.rowsHtml(rows.slice(0, shown)) : (o.emptyHtml != null ? o.emptyHtml : o.rowsHtml([]));
  }
  if (bar) bar.innerHTML = o.moreHtml ? o.moreHtml(rows.length - shown, rows.length) : '';
  return shown;
}
window.paintRowWindow = paintRowWindow;

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
  const pp = $('#printPreview');
  if (pp && pp.classList.contains('on')) ppClose(); // прегледът преди печат е най-отгоре (v1.71.0)
  else if (veilOpen('#veil2')) closeModal2();
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
  if (!pa) return;
  /* От v2.3.0 doPrint() държи документа като низ и пълни #printArea чак при
     „Печат…“ (виж PRINT_HTML по-долу). Ctrl+P при ОТВОРЕН преглед заобикаля
     бутона — затова документът се вкарва тук, иначе тъкмо подготвеният
     документ би излязъл като празна страница. */
  if (!pa.innerHTML.trim() && PRINT_HTML) ppFillPrintArea();
  if (!pa.innerHTML.trim()) {
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
    /* stopPropagation (одит v2.4.27): общият слушател на Esc е в bubble фазата
       и виждаше #veil2 вече като „.closing“ → падаше на #veil и затваряше и
       формата отдолу (напр. картата „Обслужване по домовете“ с невписаните
       редакции) от едно-единствено натискане. */
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } }
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

/* ---------------- askConfirm: заместител на window.confirm() (v2.4.33) ----------------
   Дотук всеки въпрос „Да изтрия ли…?“ минаваше през родния confirm() на
   Electron: системен прозорец с чужд външен вид, бутони „OK“ / „Cancel“ на
   английски, без икона, без отличаване на необратимото от обикновения въпрос
   и с текст, който се чете като едно сиво каре. Тук въпросът е прозорец на
   самата програма (същите #veil/#modal като всички други): икона и цвят по
   вида на действието, заглавие, текстът с неговите редове, бутон „Отказ“ и
   бутон с ИМЕТО на действието („Изтрий“, „Продължи“, „Да“) — червен при
   необратимо действие, основен при обикновен въпрос.

   Видът се извежда от текста, ако не е подаден изрично (opts.kind):
     'delete' — изтриване (червен бутон „Изтрий“; фокусът е на „Отказ“);
     'danger' — друго необратимо действие (червен „Продължи“; фокус на „Отказ“);
     'warn'   — обратимо, но тежко/изненадващо (кехлибарено; фокус на „Отказ“);
     'ask'    — обикновен въпрос (основен бутон „Да“; фокусът е на него).
   Първият ред на текста, отделен с празен ред, става заглавие (както вече
   се пишеха „НЕОБРАТИМО“, „РЕДАКЦИЯ НА ЗАПИС В ИНВЕНТАРНАТА КНИГА“ — главните
   букви се свалят до нормално изписване). opts: { title, okLabel,
   cancelLabel, kind }.

   Връща Promise<boolean> — както confirm(), но асинхронно; разрешава се при
   всеки изход (бутон, Esc), за да не увисне извикващият код. Има СОБСТВЕН
   слой (#veilC/#modalC, над двата слоя прозорци и над прегледа преди печат):
   въпросът се задава и от бутон във форма на първия слой (картата на читател,
   сметката), и от форма на втория (правило за категория в Настройки) — ако
   ползваше modal/modal2, щеше да изтрие точно формата, от която е зададен,
   и при „Отказ“ библиотекарят би загубил попълненото. Фокусът се връща на
   елемента, който е бил активен преди въпроса (бутона, който го е задал).

   Автоматизация и тестове: ако confirm() е подменен с обикновена функция
   (не е [native code] — така правят всички тестове на екранния слой и
   e2e-app.js, които отговарят програмно и записват зададения въпрос),
   въпросът се предава на нея и прозорецът не се отваря. */
const CFM_ICON = {
  delete: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  danger: '<path d="M12 4L2.8 20h18.4L12 4z"/><path d="M12 10v4.5M12 17.4v.01"/>',
  warn: '<path d="M12 4L2.8 20h18.4L12 4z"/><path d="M12 10v4.5M12 17.4v.01"/>',
  ask: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.6a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1 .9-1 1.7M12 16.6v.01"/>'
};
const CFM_LABEL = { delete: 'Изтрий', danger: 'Продължи', warn: 'Продължи', ask: 'Да' };
const CFM_TITLE = { delete: 'Изтриване', danger: 'Необратимо действие', warn: 'Внимание', ask: 'Потвърждение' };
function cfmParse(text, opts) {
  let title = opts.title, body = text;
  const m = /^([^\n]{3,90})\n\n([\s\S]+)$/.exec(text);
  if (m) {
    const line = m[1].trim();
    const letters = line.replace(/[^\p{L}]/gu, '');
    // Заглавие с главни букви → нормално изписване („НЕОБРАТИМО“ → „Необратимо“).
    if (!title) title = letters && letters === letters.toUpperCase() ? line.charAt(0) + line.slice(1).toLowerCase() : line;
    body = m[2]; // редът-заглавие не се повтаря в текста, дори заглавието да е подадено изрично
  }
  const del = /изтри/i.test(text);
  const danger = del || /необратим|анулира|премахван|изключван|спиране|рестартира|изоставя|снемане|замени текущите/i.test(text);
  const kind = CFM_ICON[opts.kind] ? opts.kind : (del ? 'delete' : danger ? 'danger' : 'ask');
  return { kind, title: title || CFM_TITLE[kind], body: body.trim(),
    okLabel: opts.okLabel || CFM_LABEL[kind], cancelLabel: opts.cancelLabel || 'Отказ' };
}
let CFM_CLOSE_T = null;
function askConfirm(text, opts) {
  opts = opts || {};
  text = String(text ?? '');
  const c = window.confirm;
  if (typeof c === 'function' && !/\[native code\]/.test(Function.prototype.toString.call(c))) {
    return Promise.resolve(!!c(text));
  }
  const p = cfmParse(text, opts);
  const veil = $('#veilC'), box = $('#modalC');
  if (!veil || !box) return Promise.resolve(!!(c && c(text)));
  clearTimeout(CFM_CLOSE_T);
  veil.classList.remove('closing');
  box.className = 'modal cfm ' + p.kind;
  box.innerHTML =
    `<div class="body" role="alertdialog" aria-modal="true" aria-labelledby="cfmTitle" aria-describedby="cfmMsg">
       <span class="cfmIco" aria-hidden="true">${svgIcon(CFM_ICON[p.kind])}</span>
       <div class="cfmText"><h2 class="cfmTitle" id="cfmTitle"></h2><div class="cfmMsg" id="cfmMsg"></div></div>
     </div>
     <footer>
       <button class="btn" data-ask="cancel">${esc(p.cancelLabel)}</button>
       <button class="btn ${p.kind === 'delete' || p.kind === 'danger' ? 'dgr' : 'pri'}" data-ask="ok">${esc(p.okLabel)}</button>
     </footer>`;
  box.querySelector('.cfmTitle').textContent = p.title;
  box.querySelector('.cfmMsg').textContent = p.body;
  veil.classList.add('on');
  const prev = document.activeElement;
  return new Promise(resolve => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      veil.classList.add('closing');
      CFM_CLOSE_T = setTimeout(() => { veil.classList.remove('on', 'closing'); box.innerHTML = ''; }, 140);
      if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
      resolve(val);
    };
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } }
    document.addEventListener('keydown', onKey, true);
    box.querySelector('[data-ask="ok"]').addEventListener('click', () => finish(true));
    box.querySelector('[data-ask="cancel"]').addEventListener('click', () => finish(false));
    // При необратимо действие Enter не бива да го извърши по инерция — фокусът е на „Отказ“.
    box.querySelector(p.kind === 'ask' ? '[data-ask="ok"]' : '[data-ask="cancel"]').focus();
  });
}
window.askConfirm = askConfirm;

function formData(sel) {
  const out = {};
  $(sel).querySelectorAll('input,select,textarea').forEach(el => {
    if (!el.name) return;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return out;
}

/* Затворен файлов диалог („Отказ“ в прозореца на Windows) не е грешка — handler-ите
   го връщат като FILE_DIALOG_CANCELLED, а тук се преглъща без червено известие
   (одит v2.4.29: четири места го показваха като „Отказано от потребителя.“). */
const FILE_DIALOG_CANCELLED = 'Отказано от потребителя.';
async function call(promise, okMsg) {
  const res = await promise;
  if (!res.ok) { if (res.error !== FILE_DIALOG_CANCELLED) toast(res.error || 'Възникна грешка.', 'err'); return null; }
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
      ${opts.min != null ? 'min="' + esc(String(opts.min)) + '"' : ''} ${opts.onchange ? `onchange="${opts.onchange}"` : ''} ${opts.onkey ? `onkeydown="${opts.onkey}"` : ''}
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
  { k: 7, t: 'Неизползваеми носители на информация, които нямат статута на културна ценност' }, { k: 8, t: 'Повредени/унищожени при бедствие или кражба (протокол на МВР)' }
];
const PER_FREQ = ['седмично', 'двуседмично', 'месечно', 'тримесечно', 'полугодишно', 'годишно', 'нередовно'];
const MZS_STATUS = ['заявено', 'изпратено', 'получено', 'върнато', 'отказано'];
const THEMES = [
  { id: '1', name: 'Бронз', spine: '#1A1208', brass: '#8F6D1D', paper: '#F4F0E4' },
  { id: '2', name: 'Наситено синьо', spine: '#0F1B2E', brass: '#2C5C8F', paper: '#EEF2F6' },
  { id: '3', name: 'Горско зелено', spine: '#0E1F14', brass: '#2E6B45', paper: '#EFF3EC' },
  { id: '4', name: 'Бордо', spine: '#22090F', brass: '#7A2036', paper: '#F5EDEC' },
  { id: '5', name: 'Графит', spine: '#1C2126', brass: '#536573', paper: '#EEF0F1' },
  { id: '6', name: 'Кафяво-теракота', spine: '#22140A', brass: '#A65A2E', paper: '#F3ECE3' },
  // Нова визуална идентичност InvLib — цветовете от бранд спецификацията
  // (Primary Navy/Teal), не преоцветена версия на съществуваща тема. brass е
  // по-тъмен тон от брандовия Teal #0EA5A8 нарочно: под бял текст точният Teal
  // дава 3.01:1, под прага на WCAG AA. Виж бележката при html[data-theme="7"]
  // в style.css — стойността тук трябва да съвпада с тази там.
  { id: '7', name: 'InvLib', spine: '#1E3A8A', brass: '#0A8285', paper: '#F8FAFC' }
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
/* Може ли този низ да бъде отпечатан като Code 39 без да се промени. Одит
   v2.4.14: code39svg() мълчаливо изхвърляше всичко извън азбуката на Code 39 —
   тоест кирилицата — и вдигаше регистъра. Читателска карта с номер „Ч-1042“ се
   отпечатваше като баркод, кодиращ „-1042“, докато под него човешки се четеше
   „Ч-1042“; четецът връщаше низ, който readers:byCard не намира. Сега
   несъвместимият номер се показва като изрично предупреждение вместо като
   баркод, който изглежда редовен. */
function code39Fits(text) {
  const s = String(text == null ? '' : text);
  return s === s.toUpperCase() && !/[^0-9A-Z\-. ]/.test(s);
}
function code39svg(text, w, h) {
  const raw = String(text == null ? '' : text);
  if (raw && !code39Fits(raw)) {
    return `<div style="font-size:9px;line-height:1.25;color:#b00;border:1px dashed #b00;padding:3px 4px;max-width:${(w || 160)}px">`
      + `Номерът „${esc(raw)}“ не може да се отпечата като баркод (позволени са само главни латински букви, `
      + `цифри и знаците - . интервал). Четецът би върнал друга стойност.</div>`;
  }
  const s = '*' + raw.toUpperCase().replace(/[^0-9A-Z\-. ]/g, '') + '*';
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
  if (!SETTINGS_CACHE) return;
  // Рамката в лентата (.brandMark/#brandName) вече не показва твърдо вписано
  // "ИНВЕНТАР" — показва действителното наименование на библиотеката от
  // Настройки, със същия пад към "Организация", какъвто вече ползват
  // читателската карта (readerCardHtml) и етикетите (lblCard).
  const nameEl = $('#brandName');
  if (nameEl) {
    const name = SETTINGS_CACHE.lib_name || SETTINGS_CACHE.org || '';
    nameEl.textContent = name || 'Попълнете названието в „Настройки“';
    nameEl.classList.toggle('brandNameEmpty', !name);
    nameEl.title = name; // пълният текст като tooltip, ако е дълъг и обвит на няколко реда
  }
  // #brandSub показваше "org · place" — след като организацията/името вече
  // стоят в рамката отгоре (#brandName), повтарянето им тук дублираше
  // същото наименование два пъти в лентата. Затова остава само населеното
  // място; когато то липсва, редът се скрива изцяло — не показва повторно
  // подкана за Настройки, тя вече е в самата рамка.
  const el = $('#brandSub'); if (!el) return;
  const place = SETTINGS_CACHE.place || '';
  el.textContent = place;
  el.style.display = place ? '' : 'none';
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
let PRINT_PAGE_OPTS = {}; // пази последните opts за прегледа преди печат (v1.71.0)
function setPrintPage(opts) {
  opts = opts || {};
  PRINT_DOC_NAME = opts.name || '';
  PRINT_PAGE_OPTS = opts;
  let st = document.getElementById('dynPrintStyle');
  if (!st) { st = document.createElement('style'); st.id = 'dynPrintStyle'; document.head.appendChild(st); }
  const size = opts.widthMm ? opts.widthMm + 'mm ' + opts.heightMm + 'mm' : 'A4' + (opts.landscape ? ' landscape' : '');
  st.textContent = `@media print{ @page{size:${size};margin:${opts.margin || '14mm 12mm'}} ${opts.extraCss || ''} }`;
}
/* Windows предлага заглавието на страницата като име на PDF файла в „Microsoft
   Print to PDF“. Затова преди печат заглавието се сменя с името на конкретния
   документ и се връща обратно веднага след това — иначе всяка разпечатка щеше да
   се казва „InvLib · Библиотечна система“. */
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
/* ---------- Преглед преди печат (v1.71.0) ----------
   Системният печатен диалог на Windows НЕ визуализира съдържанието на
   Electron прозорец — панелът за преглед показва „Това приложение не
   поддържа визуализация на печата“. Затова doPrint() вече първо показва
   документа на екрана в #printPreview (бял „лист“ с размера и полетата от
   setPrintPage), а window.print() се вика чак при натискане на „Печат…“.
   Всички печатни пътища минават през doPrint(), така прегледът важи
   навсякъде: протоколи, актове, картони, разписки, етикети, карти. */
let PRINT_JOB_NAME = '';
/* Ограничава extraCss от setPrintPage() до листа на прегледа — иначе
   .lbl/.lblsheet правилата биха застигнали и примерните етикети, показани
   на екрана в раздел „Баркод етикети“. Форматът на extraCss е наш собствен
   генериран низ (селектор{...}селектор{...}), без вложени скоби. */
function ppScopeCss(css) {
  return String(css || '').replace(/(^|\})\s*([.#\w])/g, '$1 #ppSheet $2');
}
/* Действие, което трябва да се случи САМО ако печатът наистина е потвърден
   (v2.2.0). От v1.71.0 doPrint() отваря преглед с бутон „Отказ“ — печат може и
   да не последва. Дотогава напр. напомнителните писма се вписваха в регистъра
   на напомнянията още преди прегледа и при отказ на всички просрочили читатели
   стоеше „изпратено напомняне“, което не е било изпратено. Обратното извикване
   се задава при doPrint(html, docName, onConfirmed) и се изпълнява веднъж — при
   „Печат…“ (ppPrint) или при успешно „Запази PDF…“ (ppSavePdf); „Отказ“/Esc го
   изхвърля. */
let PRINT_DONE_CB = null;
function ppConfirmed() {
  const cb = PRINT_DONE_CB;
  PRINT_DONE_CB = null;
  // Грешка във вписването не бива да спира самия печат — той вече е тръгнал.
  if (cb) { try { cb(); } catch (e) { console.error(e); } }
}
/* Печатният документ се ПАЗИ като низ и влиза в #printArea чак когато печатът
   наистина тръгне (v2.3.0). Дотогава doPrint() слагаше едно и също HTML на ДВЕ
   места наведнъж: в #printArea (скрит на екрана, виждан само от @media print —
   виж style.css) и в #ppSheet (листът на прегледа). При „Баркод етикети →
   Всички“ с 14 750 етикета това са 63,81 МБ HTML, разпарсени ДВА пъти — измерено
   в Chromium: 2 242 510 DOM възела, 282 МБ JS heap и 37 044 ms замръзнал
   прозорец. Втората половина от тази работа е чиста загуба: докато прегледът е
   отворен, никой не печата, а бутонът „Отказ“ е равноправен изход. */
let PRINT_HTML = '';
/* Пълни #printArea непосредствено преди window.print()/printToPDF — това е
   единственото място, което печатният изглед показва. */
function ppFillPrintArea() {
  const area = $('#printArea');
  if (area) area.innerHTML = PRINT_HTML;
}
/* Освобождава паметта на двете тежки места. Без това #printArea оставаше пълен
   до затварянето на програмата: измерено СЛЕД ppClose() и връщане на Табло —
   69,65 МБ / 2 243 016 възела, които вече никой не гледа и които браузърът няма
   как да събере, защото са живи DOM възли. */
function ppFreeDom() {
  const area = $('#printArea'); if (area) area.innerHTML = '';
  const sheet = $('#ppSheet'); if (sheet) sheet.innerHTML = '';
}
function doPrint(html, docName, onConfirmed) {
  PRINT_DONE_CB = typeof onConfirmed === 'function' ? onConfirmed : null;
  PRINT_HTML = html;
  PRINT_JOB_NAME = safeFileName(docName || PRINT_DOC_NAME);
  const o = PRINT_PAGE_OPTS || {};
  const sheet = $('#ppSheet');
  // Размер и полета на листа — същите, които @page ще наложи при печата.
  sheet.style.width = (o.widthMm || (o.landscape ? 297 : 210)) + 'mm';
  sheet.style.minHeight = (o.heightMm || (o.landscape ? 210 : 297)) + 'mm';
  sheet.style.padding = o.margin || '14mm 12mm';
  let st = document.getElementById('ppExtraStyle');
  if (!st) { st = document.createElement('style'); st.id = 'ppExtraStyle'; document.head.appendChild(st); }
  st.textContent = ppScopeCss(o.extraCss || '');
  sheet.innerHTML = html;
  $('#ppTitle').textContent = PRINT_JOB_NAME || 'Преглед преди печат';
  // Прозорецът за печат на Windows не показва визуализация на Electron
  // съдържание — затова подсказката сочи към „Запази PDF…“, а не към
  // „Microsoft Print to PDF“ (v1.72.0).
  $('#ppHint').textContent =
    '„Запази PDF…“ записва документа като PDF файл и го отваря — там се вижда точно какво ще се отпечата.';
  $('#printPreview').classList.add('on');
  // По подразбиране листът се побира по ширината на прозореца — чак след
  // като слоят е видим, защото дотогава clientWidth на .ppScroll е 0.
  requestAnimationFrame(() => ppZoom('fit'));
}
/* „Отказ“ (и Esc) отменя отложеното действие — печат не е бил направен — и
   освобождава паметта на прегледа. Затвореният преглед няма причина да държи
   десетки мегабайта DOM до края на работния ден. */
function ppClose() {
  PRINT_DONE_CB = null;
  PRINT_HTML = '';
  $('#printPreview').classList.remove('on');
  ppFreeDom();
}
window.ppClose = ppClose;
/* Мащаб на прегледа (v1.72.0). Ползва се CSS свойството zoom (Chromium-only,
   но програмата Е Chromium) вместо transform:scale — zoom участва в подредбата,
   затова скроловете и центрирането остават верни. „fit“ побира листа по
   ширината на видимата област; +/− стъпват по готовите нива. */
const PP_ZOOM_STEPS = [0.4, 0.55, 0.7, 0.85, 1, 1.25, 1.5, 2, 3];
let PP_ZOOM = 1;
function ppApplyZoom(z) {
  PP_ZOOM = Math.max(PP_ZOOM_STEPS[0], Math.min(PP_ZOOM_STEPS[PP_ZOOM_STEPS.length - 1], z));
  const sheet = $('#ppSheet');
  if (sheet) sheet.style.zoom = PP_ZOOM;
  const pct = $('#ppZoomPct');
  if (pct) pct.textContent = Math.round(PP_ZOOM * 100) + '%';
}
function ppZoom(dir) {
  if (dir === 'fit') {
    const scroll = $('.ppScroll'), sheet = $('#ppSheet');
    if (!scroll || !sheet) return;
    // offsetWidth е в „нескалирани“ пиксели — zoom не го променя.
    const avail = scroll.clientWidth - 36; // минус padding на .ppScroll
    const w = sheet.offsetWidth;
    ppApplyZoom(w > 0 && avail > 0 ? avail / w : 1);
    return;
  }
  const i = PP_ZOOM_STEPS.findIndex(s => s >= PP_ZOOM - 0.001);
  const at = i < 0 ? PP_ZOOM_STEPS.length - 1 : i;
  ppApplyZoom(PP_ZOOM_STEPS[Math.max(0, Math.min(PP_ZOOM_STEPS.length - 1, at + (dir > 0 ? 1 : -1)))]);
}
window.ppZoom = ppZoom;
function ppPrint() {
  ppConfirmed(); // преди ppClose(), който изхвърля отложеното действие
  const html = PRINT_HTML; // ppClose() изчиства и низа, и двата DOM контейнера
  ppClose();
  // Едва тук документът влиза в DOM — и то само веднъж, вече без листа на
  // прегледа, който ppClose() изпразни. Пикът в паметта е ЕДНО копие вместо две.
  PRINT_HTML = html;
  ppFillPrintArea();
  if (PRINT_JOB_NAME) document.title = PRINT_JOB_NAME;
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
    window.print();
    // Връща се след диалога; в Electron window.print() блокира до затварянето му.
    document.title = APP_TITLE;
    // Отпечатаното вече не е нужно на никого — освобождава се веднага.
    PRINT_HTML = '';
    ppFreeDom();
  }, 150)));
}
window.ppPrint = ppPrint;
/* Запази PDF… (v1.72.0) — печатният документ директно като PDF файл, без
   системния диалог (който на Windows не визуализира Electron съдържание).
   printToPDF в главния процес минава през същия печатен рендер (@media
   print + @page от setPrintPage), т.е. PDF-ът е точно каквото би отпечатал
   window.print(). Слоят на прегледа остава отворен, но в печатния изглед е
   скрит (visibility). От v2.3.0 #printArea НЕ се пълни от doPrint(), а тук —
   непосредствено преди самото записване — и се изпразва веднага след него,
   независимо от изхода (отказ от диалога, грешка при запис). */
async function ppSavePdf() {
  const btn = $('#ppPdfBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Запазване…'; }
  ppFillPrintArea();
  try {
    const res = await window.api.print.savePdf({ fileName: PRINT_JOB_NAME || 'Документ' });
    if (!res.ok) {
      if (res.error !== 'Отказано от потребителя.') toast(res.error, 'err');
      return;
    }
    toast('PDF файлът е записан и отворен: ' + (res.data && res.data.path || ''), 'ok');
    ppConfirmed(); // записаният PDF е равностоен на отпечатан документ
    ppClose();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Запази PDF…'; }
    // При успех ppClose() вече е изчистил; при отказ/грешка прегледът остава
    // отворен, но скритото копие в #printArea няма за какво да стои.
    const area = $('#printArea'); if (area) area.innerHTML = '';
  }
}
window.ppSavePdf = ppSavePdf;
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
/* ---------- Побиране на колоните в A4 листа (v2.3.0) ----------
   „Колони на листа“ (lbl_cols) е ЕДНА обща настройка за трите вида етикети, а
   те са с много различна ширина: етикет за фонда 40 мм, за сигнатура 25 мм,
   читателска карта 90 мм. С фабричните стойности (lbl_cols=3, lbl_gap=3,
   lbl_margin=8) три читателски карти искат 3×90 + 2×3 = 276 мм при налични
   210 − 2×8 = 194 мм. Chromium не се оплаква — просто реже всяка трета карта
   вертикално и библиотекарят го открива чак върху отпечатания лист.
   Затова колоните се СМАЛЯВАТ до колкото наистина се събират. */
const A4_W_MM = 210, A4_H_MM = 297;
function fitLabelCols(want, w, gap, marg) {
  const avail = A4_W_MM - 2 * marg;
  // cols×w + (cols−1)×gap ≤ avail  ⇔  cols ≤ (avail + gap) / (w + gap)
  const fit = Math.floor((avail + gap) / (w + gap));
  return Math.max(1, Math.min(want, fit));
}
/* Броят етикети в подадения HTML. И трите генератора (lblCard, sigLblCard,
   readerCardHtml) започват всеки етикет с <div class="lbl…>, затова броенето не
   изисква callers-ите да подават число — така таванът важи за ВСИЧКИ печатни
   пътища за етикети, включително „Печат на диапазон“ с огромен диапазон. */
function labelCount(html) {
  return (String(html || '').match(/<div class="lbl[ "]/g) || []).length;
}
/* Праг, над който се иска изрично потвърждение (v2.3.0).
   Избран е 500, защото: (1) с фабричните настройки на A4 се събират 3×8 = 24
   етикета за фонда на лист, т.е. 500 етикета са ~21 листа — толкова един
   библиотекар реално обработва (реже и лепи) в една сесия; (2) измерено, един
   етикет е ~4,3 КБ HTML, значи 500 етикета са ~2,2 МБ и се изчертават под
   секунда, докато „Всички“ при 14 750 етикета са 63,81 МБ и 37 044 ms
   замръзнал прозорец. Прагът не е забрана — цялата библиотека понякога
   наистина трябва да се преетикетира — а информирано решение с точни числа. */
const LABEL_CONFIRM_OVER = 500;
/* Колко етикета се събират на един A4 лист при текущите настройки — за да е
   съобщението с истински брой листове, а не с кръгло предположение. */
function labelsPerSheet(w, h, gap, marg, cols) {
  const rows = Math.max(1, Math.floor((A4_H_MM - 2 * marg + gap) / (h + gap)));
  return Math.max(1, cols * rows);
}
async function confirmManyLabels(n, kind, perSheet) {
  const what = (LABEL_DOC_NAME[kind] || 'Етикети').toLowerCase();
  // При ролка perSheet е 1 — тогава „листа A4" е безсмислица и числото подвежда.
  const roll = perSheet <= 1;
  const sheets = Math.ceil(n / perSheet);
  return askConfirm(
    'ПЕЧАТ НА ' + n + ' ЕТИКЕТА (' + what + ')\n\n'
    + (roll ? 'Печатът е на ролка — това са ' + n + ' етикета един след друг.\n\n'
            : 'Това са около ' + sheets + ' листа A4 при сегашния формат.\n\n')
    + 'Подготовката на толкова етикети наведнъж запълва паметта и прозорецът остава '
    + 'без отговор, докато свърши — при целия фонд това са десетки секунди.\n\n'
    + (kind === 'card'
      ? 'По-добре е картите да се печатат на партиди — напр. само новозаписаните читатели.\n\n'
      : 'По-добре е етикетите да се печатат на партиди през полетата „От инвентарен №“ и '
        + '„До инвентарен №“ — по няколкостотин наведнъж.\n\n')
    + 'Да продължа ли въпреки това?', { kind: 'warn', title: 'Печат на ' + n + ' етикета', okLabel: 'Печатай въпреки това' });
}
/* Първият параметър приема ДВА вида (v2.3.1):
     • готов HTML низ — както досега (диапазони, единична карта, всички
       извиквания извън logo-org.js);
     • { rows, card } — самите редове и функцията за ЕДИН етикет; тогава низът
       се сглобява ЧАК след като библиотекарят е потвърдил.

   ЗАЩО. Въпросът за много етикети (confirmManyLabels, v2.3.0) стоеше тук, но
   извикващият вече беше построил целия низ с rows.map(card).join('') — при
   14 750 етикета това е ~63 МБ низ и 1–2 s работа, извършени ПРЕДИ да е ясно
   дали изобщо ще се печата. При отказ времето и паметта отиват на вятъра, и то
   точно в мига, в който библиотекарят е казал „не“ — тоест програмата изглежда
   заспала като наказание за отказа.

   ЗАЩО ПРОМЯНАТА Е ТУК, а не в logo-org.js. Всичко, от което зависи въпросът —
   прагът LABEL_CONFIRM_OVER, размерът на етикета, режимът „ролка“, колоните,
   които реално се събират на A4 — живее в този файл. Ако въпросът се вдигне
   при извикващия, всеки от петте печатни бутона трябва да преповтори тази
   сметка и следващият праг ще се промени на пет места вместо на едно. Тук
   промяната е една: броят идва от rows.length, вместо да се брои в готовия низ. */
async function printLabelSheet(cards, kind) {
  const s = SETTINGS_CACHE || {};
  const { w, h } = labelSize(kind);
  const docName = (LABEL_DOC_NAME[kind] || 'Етикети') + ' — ' + bg(today());
  const gap = (s.lbl_gap != null ? +s.lbl_gap : 3);
  const marg = (s.lbl_margin != null ? +s.lbl_margin : 8);
  const border = s.lbl_border == null || +s.lbl_border ? '1px dashed #999' : 'none';
  const lazy = !!(cards && typeof cards === 'object' && Array.isArray(cards.rows) && typeof cards.card === 'function');
  const n = lazy ? cards.rows.length : labelCount(cards);
  if (n > LABEL_CONFIRM_OVER) {
    const perSheet = s.lbl_mode === 'roll'
      ? 1 // ролка: един етикет на страница
      : labelsPerSheet(w, h, gap, marg, fitLabelCols(Math.max(1, Math.min(8, +s.lbl_cols || 3)), w, gap, marg));
    if (!await confirmManyLabels(n, kind, perSheet)) return false;
  }
  if (s.lbl_mode === 'roll') {
    // Един етикет на страница с точния размер на ролката. „Поле на листа“ важи
    // само за A4 (виж else по-долу) — тук НЕ се изважда от размера на етикета:
    // ролковите принтери сами калибрират собствения си печатаем участък, а
    // изваждане на полето от малък етикет (напр. 20×10 мм при поле 8 мм) даваше
    // отрицателна височина — невалидна CSS стойност, която браузърът тихо
    // пренебрегва, вместо да покаже грешка, и етикетът излизаше празен/раздут
    // при печат (открито при преглед на „Раздел баркодове — визуален печат“).
    // @page margin:0 — етикетът запълва цялата зададена площ на ролката.
    setPrintPage({
      name: docName, widthMm: w, heightMm: h, margin: '0mm',
      extraCss: `.lblsheet{display:block}` +
        `.lbl{width:${w}mm;height:${h}mm;box-sizing:border-box;border:none;` +
        `page-break-after:always;display:flex;flex-direction:column;align-items:center;justify-content:center}`
    });
  } else {
    // A4 лист: колоните и разстоянията се задават от настройките, а всеки етикет
    // получава точната си височина, за да съвпадне с готовите листове с етикети.
    const want = Math.max(1, Math.min(8, +s.lbl_cols || 3));
    const cols = fitLabelCols(want, w, gap, marg);
    /* Редът на двете съобщения има значение. Самият етикет, по-широк от
       печатаемата площ, е ИСТИНСКИЯТ проблем и се проверява ПРЪВ: при него
       fitLabelCols връща 1, тоест `cols < want` също е вярно, и ако намаляването
       се обяви първо, библиотекарят получава успокоителното „колоните са намалени,
       готово", а етикетът пак ще излезе отрязан. */
    if (w > A4_W_MM - 2 * marg) {
      toast('Етикетът е широк ' + w + ' мм, а на A4 при поле ' + marg + ' мм остават '
        + (A4_W_MM - 2 * marg) + ' мм — ще се отреже при печат. Намалете ширината или полето.', 'err');
    } else if (cols < want) {
      // Мълчаливото рязане е по-лошо от намаляването на колоните: отпечатаният
      // лист изглежда наред до момента, в който се види, че всяка N-та карта е
      // без десен край. Затова библиотекарят научава защо е станало и как да го
      // промени (по-малко поле, по-тесен етикет или изрично по-малко колони).
      toast('Колоните са намалени от ' + want + ' на ' + cols + ' — при ширина ' + w
        + ' мм, разстояние ' + gap + ' мм и поле ' + marg + ' мм на A4 се събират '
        + cols + '. Иначе последната колона щеше да се отреже при печат.');
    }
    setPrintPage({
      name: docName, landscape: false, margin: marg + 'mm',
      extraCss: `.lblsheet{display:grid;grid-template-columns:repeat(${cols},${w}mm);gap:${gap}mm;justify-content:start}` +
        `.lbl{width:${w}mm;height:${h}mm;box-sizing:border-box;border:${border};` +
        `display:flex;flex-direction:column;align-items:center;justify-content:center}`
    });
  }
  // Сглобяването е последното нещо преди печата — след потвърждението и след
  // всички предупреждения за размера. При отказ дотук изобщо не се стига.
  const cardsHtml = lazy ? cards.rows.map(r => cards.card(r)).join('') : cards;
  doPrint(`<div class="pdoc"><div class="lblsheet">${cardsHtml}</div></div>`);
  return true;
}
window.printLabelSheet = printLabelSheet;
/* Етикет за фонда: наименование на библиотеката, населено място, баркод (Code 39)
   и инвентарният номер под баркода.
   Заглавната част (v1.71.1, по изрична заявка): когато „Организация“ е
   попълнена в Настройки, етикетът показва три реда — фиксиран свързващ
   текст „Библиотека при“, после самата организация (напр. читалището),
   после населеното място. Само свързващият текст е твърдо вписан в кода —
   организацията и мястото идват изцяло от Настройки, така че етикетът
   остава верен за всяка библиотека, не само за тази, за която е поръчан.
   Ако „Организация“ не е попълнена (самостоятелна библиотека извън
   читалищна структура), пада се към старото едноредово наименование от
   „Наименование на библиотеката“. */
/* Кодът върху етикета — ЕДИН източник за лентите и за цифрите под тях.

   Одит на документите v2.4.17: баркодът се чертаеше от `barcode || inv_number`, а
   човешкият текст под него беше `inv_number ?? barcode` — два различни източника.
   Книга с попълнен ISBN в полето „баркод“ получаваше гръбен етикет, чиито ленти
   кодират ISBN на ЗАГЛАВИЕТО, а цифрите под тях сочат ЕКЗЕМПЛЯРА. Тоест
   идентичността на физическия екземпляр, заради която етикетът съществува, се
   губеше. Точно този клас дефект беше поправен за читателските карти във v2.4.14
   и остана тук.

   Предпочита се ИНВЕНТАРНИЯТ НОМЕР: той е това, с което екземплярът е вписан в
   инвентарната книга, в акта и в КДБФ, а books:byBarcode така или иначе търси и по
   двете полета. Баркодът остава резервен само когато инвентарен номер няма. */
function lblCode(b) {
  if (b && b.inv_number != null && String(b.inv_number) !== '') return String(b.inv_number);
  return (b && b.barcode) ? String(b.barcode) : '';
}
function lblCard(b) {
  const s = SETTINGS_CACHE || {};
  const head = s.org
    ? `<div class="lh1">Библиотека при</div><div class="lh2">${esc(s.org)}</div>`
    : (s.lib_name ? `<div class="lh2">${esc(s.lib_name)}</div>` : '');
  return `<div class="lbl">
    ${head}
    ${s.place ? `<div class="lh3">${esc(s.place)}</div>` : ''}
    ${code39svg(lblCode(b), 150, 40)}
    <div class="l3">${esc(lblCode(b))}</div></div>`;
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
      ${/* Одит на документите v2.4.17: при празен номер на карта тук се падаше към
            вътрешния номер на реда (readers.id) — и в лентите, и в текста. Но
            readers:byCard сравнява САМО с card_no, тоест такава карта не се
            намира при сканиране; а когато друг читател има номер на карта, равен
            на този вътрешен номер (последователните числови номера са нормата),
            картата сочи ЧУЖД гражданин и заемането, сметката и наказанието отиват
            при него. Празният номер вече се казва вместо да се измисля. */ ''}
      ${r.card_no
        ? `${code39svg(r.card_no, 200, 34)}<div class="rc-no">№ ${esc(r.card_no)}</div>`
        : `<div class="rc-no" style="color:#b00;font-size:8px;line-height:1.2">Няма номер на карта — въведете го в картона на читателя, преди да отпечатате картата.</div>`}
    </div>
  </div>`;
}
function sigLblCard(b) {
  /* Книга без УДК и без авторски знак даваше празен ограден правоъгълник, разпръснат
     из листа без нито дума — за разлика от всяко друго отрязване в програмата, което
     се съобщава. Сега етикетът казва защо е празен, за да не бъде залепен така. */
  const udk = b.udk || '';
  const avt = b.author_mark || b.call_number || '';
  if (!udk && !avt) {
    return `<div class="lbl lbl-sig" style="color:#b00;font-size:8px;line-height:1.15;
      display:flex;align-items:center;justify-content:center;text-align:center;padding:2px">
      инв. № ${esc(String(b.inv_number ?? '—'))}: няма УДК и авторски знак</div>`;
  }
  return `<div class="lbl lbl-sig">
    <div class="ls-udk">${esc(udk)}</div>
    <div class="ls-avt">${esc(avt)}</div>
  </div>`;
}
