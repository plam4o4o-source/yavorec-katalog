/* ---------------- Одитна следа ---------------- */
let ODIT_Q = '';
// Четими наименования на полетата в диференца на одитната следа (action_logs.diff) —
// само за показване; ключовете идват директно от BOOK_FIELDS/READER_FIELDS в main.js.
const FIELD_LABELS = {
  inv_number: 'Инв. №', barcode: 'Баркод', register_date: 'Дата на вписване', title: 'Заглавие',
  subtitle: 'Подзаглавие', author: 'Автор', category_id: 'Категория', year: 'Година', volume: 'Том',
  isbn: 'ISBN/ISSN', pages: 'Страници', language: 'Език', udk: 'УДК', call_number: 'Сигнатура',
  author_mark: 'Авторски знак', city: 'Място на издаване', publisher: 'Издателство', keywords: 'Ключови думи',
  annotation: 'Анотация', cover_url: 'Корица', department: 'Отдел', permanent_location: 'Постоянно място',
  status: 'Състояние', status_date: 'Дата на състоянието', price: 'Цена', description: 'Забележка',
  acquisition_id: 'Партида', cn_sort: 'Ключ за сортиране',
  name: 'Име', phone: 'Телефон', address: 'Адрес', address2: 'Адрес (доп.)', email: 'Имейл', card_no: 'Карта №',
  id_card_date: 'Дата на личната карта', id_card_issuer: 'Издател на личната карта', birth_date: 'Дата на раждане',
  category: 'Категория', registered_at: 'Дата на регистрация', re_registered_at: 'Дата на пререгистрация',
  gdpr_consent: 'Съгласие ЗЗЛД', gdpr_consent_date: 'Дата на съгласието', parent_consent: 'Съгласие на родител',
  parent_consent_date: 'Дата на съгласието на родителя', guarantor_name: 'Гарант', guarantor_relation: 'Отношение на гаранта',
  guarantor_phone: 'Телефон на гаранта', note: 'Бележка'
};
function auditDiffHtml(diffJson) {
  let diff; try { diff = JSON.parse(diffJson); } catch (e) { return ''; }
  if (!Array.isArray(diff) || !diff.length) return '';
  return `<div class="diffList">${diff.map(d =>
    `<div><b>${esc(FIELD_LABELS[d.field] || d.field)}:</b> ${esc(d.before ?? '—')} → ${esc(d.after ?? '—')}</div>`
  ).join('')}</div>`;
}
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
      <td><span class="badge">${esc(a.action)}</span></td><td style="font-size:12.5px">${esc(a.detail)}${auditDiffHtml(a.diff)}</td></tr>`).join('')
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
