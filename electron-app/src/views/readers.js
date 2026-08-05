/* ---------------- Читатели ---------------- */
let READERS_QUERY = '';
// Прозоречен рендер (Фаза 2) — виж коментара при BOOKS_PAGE_SIZE по-горе; същото
// съображение важи и за списъка с читатели при голяма библиотека.
const READERS_PAGE_SIZE = 300;
let READERS_RENDER_LIMIT = READERS_PAGE_SIZE;
function readersRowsHtml(shown) {
  return shown.length ? shown.map(r => `
    <tr><td>${esc(r.name)}${r.alert_note ? ' <span title="Има бележка при заемане">📌</span>' : ''}</td>
      <td class="num">${esc(r.phone || '')}</td><td class="num">${esc(r.card_no || '')}</td>
      <td>${esc(r.category || '')}</td><td><span class="badge ${r.status === 'активен' ? 'ok' : 'warn'}">${esc(r.status || '')}</span></td>
      <td><button class="btn sm" onclick="readerForm(${r.id})">Редакция</button>
          <button class="btn sm" onclick="printReaderCard(${r.id})">Картон</button>
          <button class="btn sm" onclick="accountModal(${r.id})">Сметка</button>
          <button class="btn sm dgr" onclick="deleteReader(${r.id})">Изтрий</button></td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">Няма намерени читатели.</td></tr>`;
}
function readersMoreHtml(more, total) {
  return more > 0 ? `<button class="btn" onclick="READERS_RENDER_LIMIT+=${READERS_PAGE_SIZE};renderReadersBody()">Покажи още (${more} от общо ${total})</button>` : '';
}
/* „Покажи още“ разширява прозореца на вече изтегления window._READERS_LIST,
   без нова обиколка по IPC — виж същия коментар при renderBooksBody() в books.js. */
function renderReadersBody() {
  const readers = window._READERS_LIST || [];
  const shown = readers.slice(0, READERS_RENDER_LIMIT);
  const more = readers.length - shown.length;
  const body = $('#rBody'); if (body) body.innerHTML = readersRowsHtml(shown);
  const moreBox = $('#rMore'); if (moreBox) moreBox.innerHTML = readersMoreHtml(more, readers.length);
}
window.renderReadersBody = renderReadersBody;
async function renderReaders() {
  const [readers, searchSuggest] = await Promise.all([
    call(window.api.readers.list(READERS_QUERY)), call(window.api.searchHistory.suggest('readers'))
  ]);
  if (!readers) return;
  window._READERS_LIST = readers;
  const shown = readers.slice(0, READERS_RENDER_LIMIT);
  const more = readers.length - shown.length;
  $('#view').innerHTML = `
    <div class="toolbar">
      <input type="search" id="rSearch" list="dl_searchReaders" placeholder="Търсене по име, телефон или № карта…" value="${esc(READERS_QUERY)}">
      <button class="btn pri" onclick="readerForm()">+ Нов читател</button>
    </div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Име</th><th>Телефон</th><th>Карта №</th><th>Категория</th><th>Състояние</th><th style="width:290px"></th></tr></thead>
      <tbody id="rBody">${readersRowsHtml(shown)}</tbody>
    </table></div>
    <div class="toolbar" id="rMore" style="justify-content:center">${readersMoreHtml(more, readers.length)}</div>
    ${searchListDatalist('dl_searchReaders', searchSuggest)}`;
  $('#rSearch').addEventListener('input', debounce(e => { READERS_QUERY = e.target.value; READERS_RENDER_LIMIT = READERS_PAGE_SIZE; renderReaders(); }, 300));
  $('#rSearch').addEventListener('change', e => logSearchHistory('readers', e.target.value));
}
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
     ${id ? `<button class="btn" onclick="accountModal(${id})">Сметка</button>` : ''}
     <button class="btn pri" onclick="saveReader(${id || 'null'})">Запиши</button>`);
  if (id) $('#readerF').dataset.id = id;
}
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
