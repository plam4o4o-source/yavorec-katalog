/* ---------------- Инвентарна книга ----------------
   Прозоречен рендер и забавено търсене — по същия модел като „Книги“ и
   „Читатели“ (BOOKS_PAGE_SIZE/BOOKS_RENDER_LIMIT). Измерено в истински
   Chromium при фонд от 15 000 записа, ПРЕДИ тази промяна: първото
   изчертаване 1272 ms и 7 МБ HTML в таблицата, а полето за търсене
   пререндираше пълния списък при ВСЯКО натискане на клавиш — писането на
   осем знака отнемаше 2298 ms блокиран интерфейс (~287 ms на знак), тоест
   при голям фонд писането видимо накъсва.

   Затова: в таблицата се чертаят най-много INVBOOK_PAGE_SIZE реда наведнъж
   (бутон „Покажи още“ за следващите), а търсенето е с debounce 300 ms.
   Двете тежести са различни и се лекуват отделно — debounce намалява БРОЯ
   изчертавания, ограничението намалява ЦЕНАТА на едно изчертаване.

   Търсенето пипа само <tbody> и лентата под таблицата, а НЕ цялото #view:
   така полето за търсене не се пресъздава и курсорът остава в него, докато
   библиотекарят пише. Печатът (printInvBookDoc) продължава да ползва целия
   списък от window._INVBOOK_ROWS — разпечатката е меродавният документ по
   чл. 26 и не бива да зависи от това какво се вижда на екрана. */
const INVBOOK_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE;
/* v2.4.31 (производителност): порциите идват от БАЗАТА (invBook:list с
   { q, offset, limit } → { rows, total, summary }), не от пълния списък в
   паметта — при 15 000 документа пълният регистър е 5,5 МБ и ~100 ms в SQLite
   при всяко отваряне на раздела, а на екрана стоят 300 реда. Ако обработчикът
   върне масив (стар обработчик, тестов заместител), изгледът работи както
   досега — целият списък в паметта, търсене и „Покажи още“ без IPC. */
let INVBOOK_WINDOWED = false;
let INVBOOK_TOTAL = 0;
let INVBOOK_SUMMARY = null;
let INVBOOK_REQ = 0; // пореден номер на ПЪЛНОТО зареждане — закъснял отговор на старо търсене не се рисува
let INVBOOK_GEN = 0; // поколение на списъка в паметта — „Покажи още“ долепя само към същия списък
/* Показателите над таблицата от пълен списък в паметта (старият път). */
function invBookSummaryOf(rows) {
  const active = rows.filter(r => r.status !== 'отчислен');
  /* Броят и стойността са по ЕКЗЕМПЛЯРИ, както в КДБФ и в Таблото — иначе
     „Налични: N · стойност" под инвентарната книга противоречи на същите две
     числа на другите два екрана. Самата таблица си остава по редове: един ред =
     един инвентарен номер, точно както е в Приложение № 4. */
  const qtyOf = (r) => (r.quantity == null ? 1 : Number(r.quantity) || 0);
  return {
    rows: rows.length, activeRows: active.length,
    activeCopies: active.reduce((s, r) => s + qtyOf(r), 0),
    value: active.reduce((s, r) => s + (r.price || 0) * qtyOf(r), 0),
    deacc: rows.length - active.length,
    checked: rows.filter(r => (r.checks || []).length).length
  };
}
async function invBookFetch(offset, limit, withSummary) {
  const res = await call(window.api.invBook.list({ q: INVBOOK_QUERY, offset,
    limit: Math.min(limit || INVBOOK_PAGE_SIZE, 2000), summary: !!withSummary }));
  if (!res) return null;
  if (Array.isArray(res)) { INVBOOK_WINDOWED = false; return { all: res }; }
  INVBOOK_WINDOWED = true;
  return res;
}
async function renderInvBook() {
  ++INVBOOK_REQ; // пълният рендер не се отказва при по-нова заявка (виж renderBooks)
  const res = await invBookFetch(0, INVBOOK_RENDER_LIMIT, true);
  if (!res) return;
  INVBOOK_GEN++;
  const rows = res.all || res.rows;
  const sum = res.all ? invBookSummaryOf(res.all) : res.summary;
  INVBOOK_TOTAL = res.all ? res.all.length : res.total;
  INVBOOK_SUMMARY = sum;
  const activeCopies = sum.activeCopies, value = sum.value, deacc = sum.deacc, checked = sum.checked;
  const active = { length: sum.activeRows == null ? sum.rows - sum.deacc : sum.activeRows };
  $('#view').innerHTML = `
    <div class="note"><b>Приложение № 4 към чл. 16, ал. 1</b> — колоните следват образеца от Наредба № 3.
    Книгата се съхранява безсрочно (чл. 26, ал. 1). Отчислените документи се отбелязват, но не се заличават (чл. 39).</div>

    <div class="kpis" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi-ico">${KPI_ICONS.fund}</div><div class="kpi-body">
        <div class="kpi-num">${sum.rows.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Вписани общо</div>
        <div class="kpi-extra">от началото на книгата</div></div></div>
      <div class="kpi ok"><div class="kpi-ico">${KPI_ICONS.check}</div><div class="kpi-body">
        <div class="kpi-num">${activeCopies.toLocaleString('bg-BG')}</div>
        ${/* „Неотчислени“, не „Налични“ — в сбора влизат и документите със
              състояние „липсващ“ и „за реставрация“ (същото броене като stockAt()
              в КДБФ). Виж същата поправка в разпечатката по-долу. */''}
        <div class="kpi-lbl">Неотчислени</div><div class="kpi-extra">${mny(value)}${
          activeCopies > active.length ? ' · ' + active.length.toLocaleString('bg-BG') + ' инв. номера' : ''
        }</div></div></div>
      <div class="kpi ${deacc ? 'warn' : ''}"><div class="kpi-ico">${KPI_ICONS.deacc}</div><div class="kpi-body">
        <div class="kpi-num">${deacc.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Отчислени</div>
        <div class="kpi-extra">${sum.rows ? Math.round(deacc / sum.rows * 100) : 0}% от вписаните</div></div></div>
      <div class="kpi"><div class="kpi-ico">${KPI_ICONS.search}</div><div class="kpi-body">
        <div class="kpi-num">${checked.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">С отбелязана проверка</div>
        <div class="kpi-extra">чл. 40 – 41</div></div></div>
    </div>

    <div class="toolbar">
      <input type="search" id="ibSearch" placeholder="Търсене по инв. №, автор, заглавие или сигнатура…"
        value="${esc(INVBOOK_QUERY)}">
      <button class="btn pri" onclick="bookForm()">+ Нов документ</button>
      <button class="btn" onclick="printInvBookDoc()">Печат на инвентарната книга / PDF</button>
    </div>
    <div class="wrap"><table class="ledger ibTable">
      <thead><tr><th class="nowrap">Дата</th><th class="nowrap">Инв. №</th><th>Проверки</th><th>Автор и заглавие</th><th>Год.</th><th>Цена</th>
        <th>№ / дата<br>в КДБФ</th><th>Сигнатура</th><th>№ / дата<br>на акт</th><th>Състояние</th><th style="width:90px"></th></tr></thead>
      <tbody id="ibBody"></tbody>
    </table></div>
    <div class="toolbar" id="ibMore" style="justify-content:center"></div>`;
  window._INVBOOK_ROWS = rows;
  INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE;
  paintInvBookRows();
  $('#ibSearch').addEventListener('input', debounce(e => {
    INVBOOK_QUERY = e.target.value;
    INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE; // ново търсене — пак от първата страница
    if (INVBOOK_WINDOWED) invBookReload(); else paintInvBookRows();
  }, 300));
}
/* Прозоречен режим: ново търсене — първата порция наново от базата; „Покажи още“ —
   следващата порция, долепена към вече заредените.
   Показателите над таблицата НЕ се искат тук (проверка при прегледа): те са по
   ЦЕЛИЯ регистър, без търсенето (виж бележката в handlers/inv-book.js) — не се
   менят с всяко търсене, но при offset 0 сървърът иначе пак плащаше двете сборни
   заявки при всяка пауза при писане (debounce 300 ms), само за да ги изхвърли тук. */
async function invBookReload() {
  const req = ++INVBOOK_REQ;
  const res = await invBookFetch(0, INVBOOK_RENDER_LIMIT);
  if (!res || req !== INVBOOK_REQ) return;
  window._INVBOOK_ROWS = res.all || res.rows;
  INVBOOK_GEN++;
  INVBOOK_TOTAL = res.all ? res.all.length : res.total;
  paintInvBookRows();
}
window.invBookReload = invBookReload;
let INVBOOK_MORE_PENDING = false;
async function invBookMore() {
  if (!INVBOOK_WINDOWED) { INVBOOK_RENDER_LIMIT += INVBOOK_PAGE_SIZE; paintInvBookRows(true); return; }
  // Предпазител срещу двоен клик — виж идентичната бележка при booksMore() в books.js.
  if (INVBOOK_MORE_PENDING) return;
  INVBOOK_MORE_PENDING = true;
  try {
    const gen = INVBOOK_GEN;
    const loaded = (window._INVBOOK_ROWS || []).length;
    const res = await invBookFetch(loaded, INVBOOK_PAGE_SIZE);
    if (!res || gen !== INVBOOK_GEN) return; // междувременно търсене е подменило списъка
    window._INVBOOK_ROWS = (window._INVBOOK_ROWS || []).concat(res.all ? res.all.slice(loaded) : res.rows);
    INVBOOK_TOTAL = res.all ? res.all.length : res.total;
    INVBOOK_RENDER_LIMIT = window._INVBOOK_ROWS.length;
    paintInvBookRows(true);
  } finally {
    INVBOOK_MORE_PENDING = false;
  }
}
window.invBookMore = invBookMore;
let INVBOOK_QUERY = '';
function invBookRowsHtml(rows) {
  if (!rows.length) return `<tr><td colspan="11" class="empty">Инвентарната книга е празна.</td></tr>`;
  return rows.map(r => {
    const off = r.status === 'отчислен';
    return `<tr class="${off ? 'ibOff' : ''}" data-id="${r.id}">
      <td class="num">${bg(r.register_date)}</td>
      <td class="num"><b>${r.inv_number ?? ''}</b></td>
      <td style="font-size:11px">${(r.checks || []).map(c => `<span class="badge ok" style="font-size:10px">${bg(c)}</span>`).join(' ')}</td>
      <td>${esc([r.author, r.title].filter(Boolean).join('. '))}${r.volume ? ', т. ' + esc(r.volume) : ''}</td>
      <td class="num">${esc(r.year || '')}</td><td class="num">${mnyCell(r.price)}</td>
      <td class="num" style="font-size:11px">${r.acq_no ? '№ ' + r.acq_no + '<br>' + bg(r.acq_date) : ''}</td>
      <td class="num">${esc(r.call_number || '')}</td>
      <td class="num" style="font-size:11px">${r.act_no ? '№ ' + r.act_no + '<br>' + bg(r.act_date) : ''}</td>
      ${/* Одит v2.4.25: значката различаваше само „отчислен“ и всичко останало —
            липсващ от инвентаризация стоеше в регистъра със зелено „наличен“.
            Разпечатката печата r.status от v2.4.17 („Неотчислен ≠ наличен“). */''}
      <td>${off ? '<span class="badge warn">отчислен</span>'
        : (!r.status || r.status === 'наличен') ? '<span class="badge ok">наличен</span>'
        : `<span class="badge warn">${esc(r.status)}</span>`}</td>
      <td><button class="btn sm" onclick="invBookEdit(${r.id})">Редакция</button></td>
    </tr>`;
  }).join('');
}
/* Редакция на запис — САМО оттук (v1.71.0, по изрично искане): инвентарната
   книга е официалният регистър на фонда по Наредба № 3, затова преди
   отваряне на формата се иска изрично потвърждение. Списъкът „Книги“ вече
   няма бутон „Редакция“ на ред — там остават търсене/филтри/групова
   редакция/нов документ. */
function invBookEdit(id) {
  const r = (window._INVBOOK_ROWS || []).find(x => x.id === id) || {};
  const what = [r.author, r.title].filter(Boolean).join('. ') || 'този запис';
  if (!confirm('РЕДАКЦИЯ НА ЗАПИС В ИНВЕНТАРНАТА КНИГА\n\n'
    + '„' + what + '“ (инв. № ' + (r.inv_number ?? '—') + ')\n\n'
    + 'Инвентарната книга е официалният регистър на библиотечния фонд по '
    + 'Наредба № 3 — тя се съхранява безсрочно и промените в записа важат '
    + 'веднага навсякъде в програмата и в онлайн каталога.\n\n'
    + 'Да продължа ли към редакция?')) return;
  bookForm(id);
}
window.invBookEdit = invBookEdit;
/* Редовете, които отговарят на текущото търсене (без ограничението за рендер). */
function invBookMatches() {
  const t = INVBOOK_QUERY.trim().toLowerCase();
  const all = window._INVBOOK_ROWS || [];
  if (!t) return all;
  return all.filter(r =>
    String(r.inv_number ?? '').includes(t) ||
    (r.author || '').toLowerCase().includes(t) ||
    (r.title || '').toLowerCase().includes(t) ||
    (r.call_number || '').toLowerCase().includes(t));
}
/* Изчертава само таблицата и лентата под нея — полето за търсене не се пипа. */
/* v2.3.0: append=true (само от бутона „Покажи още“) добавя САМО новата порция
   през paintRowWindow() в core.js. Дотогава всяко натискане презаписваше целия
   <tbody> с rows.slice(0, LIMIT) — и вече показаните редове се изчертаваха
   наново, тоест работата растеше квадратично: измерено при 15 000 записа,
   49 натискания от 300 до 15 000 реда = 127 861 ms. Търсенето и програмното
   филтриране остават пълен рендер — там наборът от редове е друг. */
let INVBOOK_PAINTED = 0;
function paintInvBookRows(append) {
  /* В прозоречен режим window._INVBOOK_ROWS са само заредените порции (вече
     филтрирани от базата), а общият брой идва отделно; в стария — целият списък,
     филтриран тук. */
  const rows = INVBOOK_WINDOWED ? (window._INVBOOK_ROWS || []) : invBookMatches();
  const total = INVBOOK_WINDOWED ? INVBOOK_TOTAL : rows.length;
  INVBOOK_PAINTED = paintRowWindow({
    body: '#ibBody', bar: '#ibMore', rows, limit: INVBOOK_WINDOWED ? rows.length : INVBOOK_RENDER_LIMIT,
    painted: append ? INVBOOK_PAINTED : 0,
    rowsHtml: invBookRowsHtml,
    emptyHtml: INVBOOK_QUERY.trim()
      ? `<tr><td colspan="11" class="empty">Няма съвпадения за „${esc(INVBOOK_QUERY)}“.</td></tr>`
      : `<tr><td colspan="11" class="empty">Инвентарната книга е празна.</td></tr>`,
    moreHtml: (moreShown, shownTotal) => {
      const more = INVBOOK_WINDOWED ? total - rows.length : moreShown;
      return more > 0
        ? `<button class="btn" onclick="invBookMore()">Покажи още (${more} от общо ${total})</button>`
        : (total > INVBOOK_PAGE_SIZE
          ? `<span class="hint">Показани са всички ${total} реда. Печатът винаги съдържа цялата книга.</span>` : '');
    }
  });
}
window.paintInvBookRows = paintInvBookRows;
/* Оставено достъпно и програмно (търсене от друго място): задава търсенето,
   връща се на първата страница и преизчертава. */
function invBookFilter(q) {
  INVBOOK_QUERY = q == null ? '' : String(q);
  INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE;
  if (INVBOOK_WINDOWED) return invBookReload();
  paintInvBookRows();
}
window.invBookFilter = invBookFilter;
async function printInvBookDoc() {
  // Разпечатката е ЦЯЛАТА книга — в прозоречен режим се тегли пълният списък.
  const rows = INVBOOK_WINDOWED ? (await call(window.api.invBook.list()) || []) : (window._INVBOOK_ROWS || []);
  /* Разпечатката е меродавният документ по чл. 26 и се прошнурова и заверява с
     подпис — тя трябва да казва сама какво съдържа. Дотук в главата ѝ стоеше
     единствено „записи: N", където N са РЕДОВЕТЕ, отчислените включително: числото
     не е нито наличният фонд, нито броят документи (един ред може да е няколко
     екземпляра), а под него следваше таблица, в която отчислените се различават
     само по това дали в колоната „№/дата на акт" има нещо. */
  const qtyOf = (r) => (r.quantity == null ? 1 : Number(r.quantity) || 0);
  const active = rows.filter(r => r.status !== 'отчислен');
  const deacc = rows.length - active.length;
  const copies = active.reduce((s, r) => s + qtyOf(r), 0);
  const value = active.reduce((s, r) => s + (r.price || 0) * qtyOf(r), 0);
  /* „Неотчислен“ НЕ е „наличен“. Първата редакция на тази глава наричаше сбора
     „Наличен фонд“ — а в него влизат и документите със състояние „липсващ“ и
     „за реставрация“. Библиотека със 100 вписвания, 5 отчислени и 12 липсващи
     получаваше прошнурован и заверен по чл. 26, ал. 2 лист, който твърди, че 95
     документа са налични, включително 12, за които собствената ѝ проверка е
     установила обратното. Числото е вярно (същото, което брои и stockAt() в
     КДБФ) — сгрешена беше ДУМАТА, затова се сменя тя, а състоянията се изброяват. */
  const byStatus = {};
  active.forEach(r => { const k = r.status || 'без състояние'; byStatus[k] = (byStatus[k] || 0) + qtyOf(r); });
  const notOnShelf = Object.entries(byStatus).filter(([k]) => k !== 'наличен');
  setPrintPage({ name: `Инвентарна книга — ${bg(today())}`, landscape: true, margin: '10mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ИНВЕНТАРНА КНИГА</h2>
    <div class="pmeta">Приложение № 4 към чл. 16, ал. 1 от Наредба № 3 от 18.11.2014 г.<br>
    Разпечатано на ${bg(today())} г. · <b>${rows.length}</b> вписвания (инвентарни номера) от началото на книгата,
    от които <b>${active.length}</b> неотчислени и <b>${deacc}</b> отчислени.<br>
    ${/* Един инвентарен номер = един екземпляр, тоест вписванията и документите са
          едно и също число. Второто изречение излиза САМО ако базата все още носи
          стар запис с друга бройка — тогава мълчанието би било по-лошо от
          повторението (виж „Настройки“ → „Проверка на данните“). */''}
    Фонд по инвентарната книга (без отчислените): <b>${copies}</b> библиотечни документа на стойност <b>${mny(value)}</b>.${
      copies !== active.length ? `<br><b>Внимание:</b> ${active.length} инвентарни номера дават ${copies} документа —
      един инвентарен номер отговаря на един екземпляр. Проверете „Настройки“ → „Проверка на данните“.` : ''}${
      notOnShelf.length ? `<br>От тях със състояние, различно от „наличен“: ${
        notOnShelf.map(([k, n]) => esc(k) + ' — ' + n).join(', ')}.` : ''}
    Отчислените се отбелязват, но не се заличават (чл. 39).</div>
    <table><thead><tr><th>Дата</th><th>Инв. №</th><th>Проверки</th><th>Автор и заглавие</th><th>Год.</th><th>Бр.</th><th>Цена</th>
    <th>№/дата в КДБФ</th><th>Сигнатура</th><th>№/дата на акт</th><th>Състояние</th><th>Забележка</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${bg(r.register_date) || '—'}</td><td>${r.inv_number ?? ''}</td>
      <td>${(r.checks || []).map(c => bg(c)).join(' ')}</td>
      <td>${esc([r.author, r.title].filter(Boolean).join('. '))}${r.volume ? ', т. ' + esc(r.volume) : ''}</td>
      <td>${esc(r.year || '')}</td><td>${qtyOf(r)}</td><td>${mny(r.price)}</td>
      <td>${r.acq_no ? '№ ' + r.acq_no + ' / ' + bg(r.acq_date) : ''}</td><td>${esc(r.call_number || '')}</td>
      <td>${r.act_no ? '№ ' + r.act_no + ' / ' + bg(r.act_date) : ''}</td>
      <td>${esc(r.status || '')}</td><td>${esc(r.description || '')}</td></tr>`).join('')}
    </tbody></table>
    <div class="pmeta">Настоящата разпечатка съдържа ${rows.length} вписвания. Листовете се прошнуроват, номерират, подпечатват и
    заверяват с подписа на ръководителя (чл. 26, ал. 2).</div>
    ${ssig(['Библиотекар: ' + esc((SETTINGS_CACHE || {}).librarian || '…………………'), esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': ' + esc((SETTINGS_CACHE || {}).director || '…………………')])}</div>`);
}
window.printInvBookDoc = printInvBookDoc;
