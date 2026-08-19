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
        value="${esc(INVBOOK_QUERY)}">
      <button class="btn pri" onclick="bookForm()">+ Нов документ</button>
      <button class="btn" onclick="printInvBookDoc()">Печат на инвентарната книга / PDF</button>
    </div>
    <div class="wrap"><table class="ledger ibTable">
      <thead><tr><th>Дата</th><th>Инв. №</th><th>Проверки</th><th>Автор и заглавие</th><th>Год.</th><th>Цена</th>
        <th>№/дата в КДБФ</th><th>Сигнатура</th><th>№/дата на акт</th><th>Състояние</th><th style="width:90px"></th></tr></thead>
      <tbody id="ibBody"></tbody>
    </table></div>
    <div class="toolbar" id="ibMore" style="justify-content:center"></div>`;
  window._INVBOOK_ROWS = rows;
  INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE;
  paintInvBookRows();
  $('#ibSearch').addEventListener('input', debounce(e => {
    INVBOOK_QUERY = e.target.value;
    INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE; // ново търсене — пак от първата страница
    paintInvBookRows();
  }, 300));
}
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
      <td class="num">${esc(r.year || '')}</td><td class="num">${mny(r.price)}</td>
      <td class="num" style="font-size:11px">${r.acq_no ? '№ ' + r.acq_no + '<br>' + bg(r.acq_date) : ''}</td>
      <td class="num">${esc(r.call_number || '')}</td>
      <td class="num" style="font-size:11px">${r.act_no ? '№ ' + r.act_no + '<br>' + bg(r.act_date) : ''}</td>
      <td>${off ? '<span class="badge warn">отчислен</span>' : '<span class="badge ok">наличен</span>'}</td>
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
  const rows = invBookMatches();
  INVBOOK_PAINTED = paintRowWindow({
    body: '#ibBody', bar: '#ibMore', rows, limit: INVBOOK_RENDER_LIMIT,
    painted: append ? INVBOOK_PAINTED : 0,
    rowsHtml: invBookRowsHtml,
    emptyHtml: INVBOOK_QUERY.trim()
      ? `<tr><td colspan="11" class="empty">Няма съвпадения за „${esc(INVBOOK_QUERY)}“.</td></tr>`
      : `<tr><td colspan="11" class="empty">Инвентарната книга е празна.</td></tr>`,
    moreHtml: (more, total) => more > 0
      ? `<button class="btn" onclick="INVBOOK_RENDER_LIMIT+=${INVBOOK_PAGE_SIZE};paintInvBookRows(true)">Покажи още (${more} от общо ${total})</button>`
      : (total > INVBOOK_PAGE_SIZE
        ? `<span class="hint">Показани са всички ${total} реда. Печатът винаги съдържа цялата книга.</span>` : '')
  });
}
window.paintInvBookRows = paintInvBookRows;
/* Оставено достъпно и програмно (търсене от друго място): задава търсенето,
   връща се на първата страница и преизчертава. */
function invBookFilter(q) {
  INVBOOK_QUERY = q == null ? '' : String(q);
  INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE;
  paintInvBookRows();
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
