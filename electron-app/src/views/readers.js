/* ---------------- Читатели ---------------- */
let READERS_QUERY = '';
// Прозоречен рендер (Фаза 2) — виж коментара при BOOKS_PAGE_SIZE по-горе; същото
// съображение важи и за списъка с читатели при голяма библиотека.
const READERS_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let READERS_RENDER_LIMIT = READERS_PAGE_SIZE;
/* Филтри по категория/статус (v1.70.0) — прилагат се НАД вече заредения/
   претърсен списък (window._READERS_LIST), без ново IPC — виж същия принцип
   при BOOKS_FILTER_* в books.js. */
let READERS_FILTER_CAT = '';
let READERS_FILTER_STATUS = '';
function readersFilterMatch(r) {
  if (READERS_FILTER_CAT && (r.category || '') !== READERS_FILTER_CAT) return false;
  if (READERS_FILTER_STATUS && (r.status || '') !== READERS_FILTER_STATUS) return false;
  return true;
}
function readersRowsHtml(shown) {
  return shown.length ? shown.map(r => `
    <tr data-id="${r.id}"><td>${esc(r.name)}${r.alert_note ? ' <span class="badge w" title="${esc(r.alert_note)}">бележка</span>' : ''}</td>
      <td class="num">${esc(r.phone || '')}</td><td class="num">${esc(r.card_no || '')}</td>
      <td>${esc(r.category || '')}</td><td><span class="badge ${r.status === 'активен' ? 'ok' : 'warn'}">${esc(r.status || '')}</span></td>
      <td class="num">${r.open_loans == null ? '' : `<span class="loansCnt ${r.overdue_loans ? 'warn' : ''}" title="${r.overdue_loans
        ? pl(r.overdue_loans, 'просрочен документ', 'просрочени документа') + ' от ' + r.open_loans + ' заети'
        : (r.open_loans ? pl(r.open_loans, 'зает документ', 'заети документа') : 'няма заети документи')}">${r.open_loans}${r.overdue_loans ? ' !' : ''}</span>`}</td>
      <td class="actsCell"><div class="rowActs"><button class="btn sm pri" onclick="CIRC.readerId=${r.id};CIRC.mode='out';location.hash='#circ'" title="Отваря гишето с този читател">Заемане</button>
          <button class="btn sm" onclick="readerForm(${r.id})">Редакция</button>
          <button class="btn sm" onclick="printReaderCard(${r.id})">Картон</button>
          <button class="btn sm" onclick="printCardOne(${r.id})" title="Печат на читателската карта само на този читател">Карта</button>
          <button class="btn sm" onclick="accountModal(${r.id})">Сметка</button>
          <button class="btn sm dgr" onclick="deleteReader(${r.id})">Изтрий</button></div></td></tr>`).join('')
    : `<tr><td colspan="7" class="empty">Няма намерени читатели.</td></tr>`;
}
function readersMoreHtml(more, total) {
  return more > 0 ? `<button class="btn" onclick="readersMore()">Покажи още (${more} от общо ${total})</button>` : '';
}
/* „Покажи още“ разширява прозореца на вече изтегления window._READERS_LIST,
   без нова обиколка по IPC — виж същия коментар при renderBooksBody() в books.js.
   v2.3.0: append=true добавя САМО новата порция през paintRowWindow() в core.js,
   вместо да презаписва целия <tbody> — същият квадратичен модел като в „Книги“,
   тук при 3 000 читатели. Търсене/филтър остават пълен рендер. */
let READERS_PAINTED = 0;
/* v2.4.31 (производителност): порциите идват от базата — readers:list(query, null,
   { offset, limit, cat, status }) → { rows, total }; филтрите по категория и
   състояние също. При масив от обработчика (стар обработчик, тестов заместител)
   изгледът работи както досега — целият списък в паметта. */
let READERS_WINDOWED = false;
let READERS_TOTAL = 0;
let READERS_REQ = 0; // пореден номер на пълното зареждане (търсене)
let READERS_GEN = 0; // поколение на списъка — „Покажи още“ долепя само към същия списък
async function readersFetch(offset, limit) {
  const res = await call(window.api.readers.list(READERS_QUERY, null,
    { offset, limit: Math.min(limit || READERS_PAGE_SIZE, 2000), cat: READERS_FILTER_CAT || '', status: READERS_FILTER_STATUS || '' }));
  if (!res) return null;
  if (Array.isArray(res)) { READERS_WINDOWED = false; return { all: res }; }
  READERS_WINDOWED = true; READERS_TOTAL = res.total || 0;
  return res;
}
async function readersMore() {
  if (!READERS_WINDOWED) { READERS_RENDER_LIMIT += READERS_PAGE_SIZE; renderReadersBody(true); return; }
  const gen = READERS_GEN;
  const loaded = (window._READERS_LIST || []).length;
  const res = await readersFetch(loaded, READERS_PAGE_SIZE);
  if (!res || gen !== READERS_GEN) return; // междувременно търсене/филтър е подменил списъка
  window._READERS_LIST = (window._READERS_LIST || []).concat(res.all ? res.all.slice(loaded) : res.rows);
  READERS_RENDER_LIMIT = Math.max(READERS_RENDER_LIMIT, window._READERS_LIST.length);
  renderReadersBody(true);
}
window.readersMore = readersMore;
function readersFilterChanged() {
  READERS_RENDER_LIMIT = READERS_PAGE_SIZE;
  if (READERS_WINDOWED) return refreshReadersList();
  renderReadersBody();
}
window.readersFilterChanged = readersFilterChanged;
function renderReadersBody(append) {
  const readers = READERS_WINDOWED ? (window._READERS_LIST || []) : (window._READERS_LIST || []).filter(readersFilterMatch);
  READERS_PAINTED = paintRowWindow({
    body: '#rBody', bar: '#rMore', rows: readers, limit: READERS_WINDOWED ? readers.length : READERS_RENDER_LIMIT,
    painted: append ? READERS_PAINTED : 0,
    rowsHtml: readersRowsHtml,
    moreHtml: READERS_WINDOWED ? () => readersMoreHtml(READERS_TOTAL - readers.length, READERS_TOTAL) : readersMoreHtml
  });
}
window.renderReadersBody = renderReadersBody;
/* Ново търсене: списъкът се тегли наново (търсенето е сървърно), но се пипат
   САМО тялото на таблицата и лентата под нея — полето #rSearch НЕ се пресъздава.
   Дотогава debounce-ът викаше цялата renderReaders() и подменяше #view заедно с
   полето: при пауза над 300 ms по време на писане фокусът изчезваше и следващите
   знаци отиваха в нищото (виж същия модел в inv-book.js). */
async function refreshReadersList() {
  const req = ++READERS_REQ;
  const res = await readersFetch(0, READERS_RENDER_LIMIT);
  if (!res || req !== READERS_REQ) return;
  window._READERS_LIST = res.all || res.rows;
  READERS_GEN++;
  renderReadersBody();
}
window.refreshReadersList = refreshReadersList;
async function renderReaders() {
  ++READERS_REQ; // пълният рендер не се отказва при по-нова заявка (виж renderBooks)
  const [res, searchSuggest] = await Promise.all([
    readersFetch(0, READERS_RENDER_LIMIT), call(window.api.searchHistory.suggest('readers'))
  ]);
  if (!res) return;
  const readers = res.all || res.rows;
  window._READERS_LIST = readers;
  READERS_GEN++;
  const filtered = READERS_WINDOWED ? readers : readers.filter(readersFilterMatch);
  const shown = READERS_WINDOWED ? readers : filtered.slice(0, READERS_RENDER_LIMIT);
  const total = READERS_WINDOWED ? READERS_TOTAL : filtered.length;
  const more = total - shown.length;
  $('#view').innerHTML = `
    <div class="toolbar">
      <input type="search" id="rSearch" list="dl_searchReaders" placeholder="Търсене по име, телефон или № карта…" value="${esc(READERS_QUERY)}">
      <select id="rCatFilter" onchange="READERS_FILTER_CAT=this.value;readersFilterChanged()" title="Филтър по категория">
        <option value="">— всички категории —</option>
        ${KATEG.map(k => `<option value="${esc(k)}" ${READERS_FILTER_CAT === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}
      </select>
      <select id="rStatusFilter" onchange="READERS_FILTER_STATUS=this.value;readersFilterChanged()" title="Филтър по състояние">
        <option value="">— всички —</option>
        <option value="активен" ${READERS_FILTER_STATUS === 'активен' ? 'selected' : ''}>активен</option>
        <option value="прекратен" ${READERS_FILTER_STATUS === 'прекратен' ? 'selected' : ''}>прекратен</option>
      </select>
      <button class="btn pri" onclick="readerForm()">+ Нов читател</button>
      <button class="btn" onclick="exportReadersCsv()">Извеждане в CSV</button>
    </div>
    <div class="wrap"><table class="ledger readersTable">
      <thead><tr><th>Име</th><th>Телефон</th><th>Карта №</th><th>Категория</th><th>Състояние</th><th title="Заети документи в момента; „!“ — има просрочени">Заети</th><th></th></tr></thead>
      <tbody id="rBody">${readersRowsHtml(shown)}</tbody>
    </table></div>
    <div class="toolbar" id="rMore" style="justify-content:center">${readersMoreHtml(more, total)}</div>
    ${searchListDatalist('dl_searchReaders', searchSuggest)}`;
  // Таблицата е изчертана направо в #view — броячът трябва да съответства, за да
  // може следващото „Покажи още“ само да ДОБАВИ порция (виж renderReadersBody).
  READERS_PAINTED = shown.length;
  $('#rSearch').addEventListener('input', debounce(e => { READERS_QUERY = e.target.value; READERS_RENDER_LIMIT = READERS_PAGE_SIZE; refreshReadersList(); }, 300));
  $('#rSearch').addEventListener('change', e => logSearchHistory('readers', e.target.value));
}
async function exportReadersCsv() {
  const path = await call(window.api.readers.exportCsv());
  if (path) toast('Списъкът с читателите е записан в ' + path, 'ok');
}
window.exportReadersCsv = exportReadersCsv;
const GUARANTOR_CATS = ['дете до 14 г.']; // категории, за които се иска гарант (родител/настойник)
async function readerForm(id) {
  const [r, pdp] = await Promise.all([
    id ? call(window.api.readers.get(id)) : Promise.resolve(null),
    call(window.api.pdp.status())
  ]);
  const v = r || { registered_at: today(), category: 'възрастен', status: 'активен' };
  const needsGuarantor = GUARANTOR_CATS.includes(v.category);
  // ЕГН/№ ЛК се показват само за четене, докато защитата е зададена, но
  // заключена в тази сесия — самата стойност идва вече като „Защитени данни“
  // от readers:get. Важи само при РЕДАКЦИЯ на съществуващ читател: при нов
  // читател без предишна стойност полетата остават активни (main.js отказва
  // запис с ЕГН, докато не отключите защитата).
  const pdpLocked = !!(id && pdp && pdp.configured && !pdp.unlocked);
  modal(id ? 'Читател ' + (v.card_no || '') : 'Записване на читател', `
    <form id="readerF" onsubmit="return false">
    <fieldset><legend>Лични данни — чл. 42, ал. 3</legend>
      ${fld('Име и фамилия', 'name', { val: v.name || '', req: 1 })}
      ${pdpLocked ? `<div class="note w" style="margin:0 0 8px">🔒 ЕГН и № ЛК са защитени с парола —
        отключете защитата от „Настройки“, за да ги видите или редактирате.</div>` : ''}
      <div class="grid g3">
        ${fld('ЕГН', 'egn', { val: v.egn || '', disabled: pdpLocked })}
        ${fld('Л.К. номер', 'id_card_no', { val: v.id_card_no || '', disabled: pdpLocked })}
        ${fld('Л.К. издадена на', 'id_card_date', { val: v.id_card_date || '', type: 'date' })}
      </div>
      <!-- Одит v2.4.16: чл. 42, ал. 3 изброява „номер, дата и МЕСТОИЗДАВАНЕ на
           личната карта“. Колоната id_card_issuer съществува в базата, одитната
           следа я показва с етикет, читателската карта я ПЕЧАТА — а формата
           нямаше поле за нея, тоест на всеки отпечатан картон стоеше многоточие
           на място, което наредбата изисква попълнено. -->
      ${fld('Л.К. издадена от', 'id_card_issuer', { val: v.id_card_issuer || '', hint: 'МВР — гр. …' })}
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
        ${fld('Категория', 'category', { type: 'select', opts: KATEG, val: v.category, onchange: 'toggleGuarantorFields(this.value)' })}
        ${fld('Дата на записване', 'registered_at', { val: v.registered_at, type: 'date' })}
        ${fld('Пререгистрация', 're_registered_at', { val: v.re_registered_at || '', type: 'date' })}
      </div>
      <div class="grid g2">
        ${fld('Състояние', 'status', { type: 'select', opts: ['активен', 'прекратен'], val: v.status, allowEmpty: false })}
        ${fld('Забележка', 'note', { val: v.note || '' })}
      </div>
      ${fld('Бележка при заемане', 'alert_note', { val: v.alert_note || '', type: 'textarea', rows: 2,
        hint: 'изскача открояващо се, щом читателят бъде избран в „Заемане и връщане" — напр. „носи още старата книга на брат си"' })}
      ${fld('Ползвателят е запознат с правилата за обслужване (чл. 47, ал. 2) и е дал съгласие за обработване на лични данни.'
        + (v.gdpr_consent_date ? ' <span class="fh">(дадено на ' + bg(v.gdpr_consent_date) + ')</span>' : ''),
        'gdpr_consent', { type: 'checkbox', val: v.gdpr_consent })}
      ${fld('За читатели под 14 г. — налице е съгласие на родител/настойник.'
        + (v.parent_consent_date ? ' <span class="fh">(дадено на ' + bg(v.parent_consent_date) + ')</span>' : ''),
        'parent_consent', { type: 'checkbox', val: v.parent_consent })}
      ${v.suspended_until && v.suspended_until > today() ? `
        <div class="note w" style="margin-top:10px">⛔ Заемането е преустановено до <b>${bg(v.suspended_until)}</b>
        (наказание за просрочени връщания).
        <button type="button" class="btn sm" style="margin-left:8px" onclick="clearSuspension(${id})">Снеми наказанието</button></div>` : ''}
    </fieldset>
    <fieldset id="guarantorFs" style="${needsGuarantor ? '' : 'display:none'}">
      <legend>Родител / настойник (гарант)</legend>
      <div class="note" style="margin-top:0">За читатели под 14 г. отговорността за връщане на заетите документи и
      контактът при просрочие са на родителя/настойника, не на детето.</div>
      <div class="grid g3">
        ${fld('Име на родител/настойник', 'guarantor_name', { val: v.guarantor_name || '' })}
        ${fld('Отношение', 'guarantor_relation', { type: 'select', opts: ['родител', 'настойник', 'друго'], val: v.guarantor_relation || 'родител' })}
        ${fld('Телефон на родител/настойник', 'guarantor_phone', { val: v.guarantor_phone || '' })}
      </div>
    </fieldset>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     ${id ? `<button class="btn" onclick="readerFormToAccount(${id})">Сметка</button>` : ''}
     <button class="btn pri" onclick="saveReader(${id || 'null'})">Запиши</button>`);
  if (id) {
    const f = $('#readerF');
    f.dataset.id = id;
    f.dataset.snapshot = JSON.stringify(formData('#readerF'));
  }
}
/* „Сметка“ от формата за редакция (v2.4.29): прозорецът се ЗАМЕСТВА и незаписаните
   промени изчезваха без въпрос. Пита само ако наистина има промени. */
function readerFormToAccount(id) {
  const f = $('#readerF');
  const dirty = f && f.dataset.snapshot && f.dataset.snapshot !== JSON.stringify(formData('#readerF'));
  if (dirty && !confirm('Има незаписани промени в картата на читателя. Да ги изоставя ли и да отворя сметката?')) return;
  accountModal(id);
}
window.readerFormToAccount = readerFormToAccount;
window.readerForm = readerForm;
function toggleGuarantorFields(category) {
  const fs = $('#guarantorFs');
  if (fs) fs.style.display = GUARANTOR_CATS.includes(category) ? '' : 'none';
}
window.toggleGuarantorFields = toggleGuarantorFields;
async function clearSuspension(id) {
  if (!id) return;
  if (!confirm('Снемане на наказанието „преустановено заемане“ за този читател?')) return;
  const ok = await call(window.api.readers.clearSuspension(id), 'Наказанието е снето.');
  if (ok !== null) { closeModal(); if (VIEW === 'circ') renderCirc(); else renderReaders(); }
}
window.clearSuspension = clearSuspension;
async function saveReader(id) {
  const d = formData('#readerF');
  if (!d.name.trim()) return toast('Името е задължително.', 'err');
  if (!d.gdpr_consent) return toast('Отбележете съгласието по чл. 47 и ОРЗД.', 'err');
  if (GUARANTOR_CATS.includes(d.category) && !(d.guarantor_name || '').trim()) {
    return toast('За читател под 14 г. посочете родител/настойник (гарант).', 'err');
  }
  d.id = id;
  // readers:create връща id на новия запис — редът му светва след пререндирането
  // (flashRow, v1.69.0). При неуспех call() връща null → без открояване.
  // v2.2.0: прозорецът се затваря САМО при успех — иначе отхвърлен запис
  // (напр. дублирана карта №) изтриваше цялата попълнена регистрационна карта.
  let savedId = id;
  if (id) { if (await call(window.api.readers.update(d), 'Читателят е обновен.') === null) return; }
  else { savedId = await call(window.api.readers.create(d), 'Читателят е добавен.'); if (savedId === null) return; }
  closeModal();
  /* „+ Нов читател“ от гишето (одит v2.4.25): дотук се пречертаваше винаги
     списъкът с читатели — библиотекарят оставаше в таблицата с читатели, менюто
     светеше на „Заемане и връщане“, а новият читател не беше избран за заемане.
     От гишето — избира се направо; отвсякъде другаде — както досега. */
  if (VIEW === 'circ' && typeof selectCircReader === 'function' && savedId) { selectCircReader(savedId); return; }
  /* v2.4.29: от Таблото („Нов читател“) или от друг раздел се пречертава ТОЗИ
     раздел — дотук под заглавие „Табло“ оставаше списъкът с читатели. */
  if (VIEW !== 'readers') { if (RENDERERS[VIEW]) await RENDERERS[VIEW](); return; }
  await renderReaders();
  if (savedId) flashRow(`#rBody tr[data-id="${savedId}"]`);
}
window.saveReader = saveReader;
async function deleteReader(id) {
  // Виж confirmDangerousDelete в views/books.js — второто щракване показва дословно
  // предупреждението от отказа, вместо пак безобидното „Да изтрия ли…".
  await confirmDangerousDelete('reader:' + id, 'Да изтрия ли този читател?',
    () => window.api.readers.delete(id), 'Читателят е изтрит.', () => renderReaders());
}
window.deleteReader = deleteReader;
