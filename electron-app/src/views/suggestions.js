/* ---------------- Предложения за покупка от читатели ---------------- */
const SUGG_STATUSES = ['заявено', 'одобрено', 'поръчано', 'получено', 'отказано'];
let SUGG_STATUS = '';
async function renderSuggestions() {
  const rows = await call(window.api.suggestions.list(SUGG_STATUS || undefined));
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note" style="margin-top:0">Читател иска заглавие на гишето → заявено → одобрено → поръчано →
    получено (закача се към партида в „Постъпления") или отказано. Директен канал „какво наистина искат хората",
    вместо покупки на сляпо.</div>
    <div class="toolbar">
      <select onchange="SUGG_STATUS=this.value;renderSuggestions()">
        <option value="">Всички състояния</option>
        ${SUGG_STATUSES.map(st => `<option value="${st}" ${SUGG_STATUS === st ? 'selected' : ''}>${esc(st)}</option>`).join('')}
      </select>
      <span style="flex:1"></span>
      <button class="btn pri" onclick="suggestionForm()">+ Ново предложение</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr>
      <th>Дата</th><th>Автор, заглавие</th><th>Читател</th><th>Бележка</th><th>Състояние</th><th style="width:260px"></th>
    </tr></thead><tbody>
    ${rows.length ? rows.map(s => `<tr>
      <td class="num">${bg(s.date)}</td>
      <td>${esc([s.author, s.title].filter(Boolean).join(' — '))}</td>
      <td>${esc(s.reader_name || '—')}</td>
      <td style="font-size:12px">${esc(s.note || '')}</td>
      <td><span class="badge ${s.status === 'получено' ? 'ok' : (s.status === 'отказано' ? '' : 'warn')}">${esc(s.status)}</span>
        ${s.acquisition_id ? `<div class="hint">партида № ${s.acq_no}/${s.acq_year}</div>` : ''}</td>
      <td>${suggActionButtons(s)}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">Няма предложения.</td></tr>`}
    </tbody></table></div>`;
}
function suggActionButtons(s) {
  if (s.status === 'заявено') return `<button class="btn sm" onclick="setSuggStatus(${s.id},'одобрено')">Одобри</button>
    <button class="btn sm dgr" onclick="setSuggStatus(${s.id},'отказано')">Откажи</button>`;
  if (s.status === 'одобрено') return `<button class="btn sm" onclick="setSuggStatus(${s.id},'поръчано')">Поръчано</button>
    <button class="btn sm dgr" onclick="setSuggStatus(${s.id},'отказано')">Откажи</button>`;
  if (s.status === 'поръчано') return `<button class="btn sm pri" onclick="receiveSuggestion(${s.id})">Получено…</button>`;
  return `<button class="btn sm dgr" onclick="deleteSuggestion(${s.id})">Изтрий</button>`;
}
function suggestionForm() {
  modal('Ново предложение за покупка', `
    <form id="suggF" onsubmit="return false">
      ${fld('Заглавие', 'title', { val: '', req: 1 })}
      ${fld('Автор', 'author', { val: '' })}
      ${fld('Читател (име или № карта — по желание)', 'reader_q', { val: '' })}
      ${fld('Бележка', 'note', { val: '', type: 'textarea', rows: 2 })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveSuggestion()">Запиши</button>`);
}
window.suggestionForm = suggestionForm;
async function saveSuggestion() {
  const d = formData('#suggF');
  if (!d.title.trim()) return toast('Заглавието е задължително.', 'err');
  let reader_id = null, reader_name = null;
  const q = (d.reader_q || '').trim();
  if (q) {
    const byCard = await window.api.readers.byCard(q);
    if (byCard.ok && byCard.data) { reader_id = byCard.data.id; reader_name = byCard.data.name; }
    else {
      const list = await window.api.readers.list(q, 20);
      if (list.ok && list.data && list.data[0]) { reader_id = list.data[0].id; reader_name = list.data[0].name; }
      else reader_name = q;
    }
  }
  const id = await call(window.api.suggestions.create({
    title: d.title.trim(), author: d.author, note: d.note, reader_id, reader_name
  }), 'Предложението е записано.');
  if (id != null) { closeModal(); renderSuggestions(); }
}
window.saveSuggestion = saveSuggestion;
async function setSuggStatus(id, status) {
  const ok = await call(window.api.suggestions.setStatus({ id, status }), 'Обновено.');
  if (ok !== null) { markSaved(); renderSuggestions(); }
}
window.setSuggStatus = setSuggStatus;
async function receiveSuggestion(id) {
  const acqs = await call(window.api.acquisitions.list());
  if (!acqs) return;
  modal2('Получено предложение', `
    <div class="note" style="margin-top:0">По желание закачете предложението към партида в „Постъпления“, за да
    остане следа откъде реално е дошла книгата.</div>
    <form id="recvF" onsubmit="return false">
      ${fld('Партида', 'acquisition_id', { type: 'select', emptyLabel: '— без партида —',
        opts: acqs.map(a => ({ v: a.id, t: '№ ' + a.no + '/' + a.year + ' — ' + (a.from_source || '') })) })}
    </form>`,
    `<button class="btn" onclick="closeModal2()">Отказ</button>
     <button class="btn pri" onclick="confirmReceive(${id})">Отбележи получено</button>`);
}
window.receiveSuggestion = receiveSuggestion;
async function confirmReceive(id) {
  const d = formData('#recvF');
  const ok = await call(window.api.suggestions.setStatus({ id, status: 'получено', acquisition_id: d.acquisition_id || null }),
    'Отбелязано като получено.');
  if (ok !== null) { closeModal2(); markSaved(); renderSuggestions(); notifySuggestionReceived(id); }
}
window.confirmReceive = confirmReceive;
async function deleteSuggestion(id) {
  if (!await askConfirm('Изтриване на предложението?')) return;
  const ok = await call(window.api.suggestions.delete(id), 'Изтрито.');
  if (ok !== null) renderSuggestions();
}
window.deleteSuggestion = deleteSuggestion;
// Уведомяването е ръчно и по избор — не всеки читател има имейл, а автоматично
// изпратено писмо без потвърждение е изненада, не удобство.
async function notifySuggestionReceived(id) {
  const rows = await call(window.api.suggestions.list('получено'));
  const s = rows && rows.find(x => x.id === id);
  if (!s || !s.reader_id) return;
  const reader = await call(window.api.readers.get(s.reader_id));
  if (!reader || !reader.email) return;
  if (!await askConfirm('Да отворя ли писмо до ' + reader.name + ' за пристигналата книга „' + s.title + '“?', { okLabel: 'Отвори писмо' })) return;
  const subject = 'Пристигна предложената от Вас книга';
  const body = 'Здравейте, ' + reader.name + ',\n\nКнигата „' + (s.author ? s.author + '. ' : '') + s.title +
    '“, която предложихте, вече е налична в библиотеката.\n\nПоздрави!';
  const res = await window.api.loans.mailto({ email: reader.email, subject, body });
  if (!res.ok) toast(res.error, 'err');
}
window.notifySuggestionReceived = notifySuggestionReceived;
