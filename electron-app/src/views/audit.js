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
  /* Повреден запис не бива да изглежда като „това действие не е променило нищо“.
     Одитната следа е документът, който проверяващият от регионалната библиотека
     чете — там разликата между двете има значение. Празен/липсващ diff (обичайното
     за действия без редакция) си остава без ред, както досега. */
  if (diffJson == null || diffJson === '') return '';
  let diff;
  try { diff = JSON.parse(diffJson); }
  catch (e) { return '<div class="diffList"><span class="hint">(записът за промените е повреден и не може да бъде прочетен)</span></div>'; }
  if (!Array.isArray(diff) || !diff.length) return '';
  return `<div class="diffList">${diff.map(d =>
    `<div><b>${esc(FIELD_LABELS[d.field] || d.field)}:</b> ${esc(d.before ?? '—')} → ${esc(d.after ?? '—')}</div>`
  ).join('')}</div>`;
}
/* Часът се пази в UTC (audit_log.ts по подразбиране е datetime('now') на SQLite),
   а `new Date('2026-09-03 06:30:00')` се тълкува от V8 като МЕСТНО време — тоест
   дотук екранът и CSV-то показваха суровия UTC час като местен. Одит v2.4.24:
   действие в 09:30 се четеше „06:30“, а действие в 00:40 на 4 януари — „22:40“ на
   3 януари, тоест В ДРУГ ДЕН, в документа, който съществува, за да възстанови
   какво се е случило и кога. */
function auditTs(ts) {
  const raw = String(ts || '');
  if (!raw) return '—';
  // Стойността е „YYYY-MM-DD HH:MM:SS“ без часова зона. Ако някой ред вече носи
  // зона (T…Z или отместване), не се пипа.
  const iso = /[TZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d) ? raw : d.toLocaleString('bg-BG');
}
function auditRowsHtml(rows) {
  return rows.length ? rows.map(a => `<tr><td class="num">${auditTs(a.ts)}</td><td>${esc(a.user || '—')}</td>
    <td><span class="badge">${esc(a.action)}</span></td><td style="font-size:12.5px">${esc(a.detail)}${auditDiffHtml(a.diff)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">Няма записи.</td></tr>`;
}
/* audit:list връща най-много толкова реда (ORDER BY id DESC LIMIT 500 в
   handlers/audit.js) — тоест този изглед Е ограничен и не може да замрази
   интерфейса при 12 000 записа в одитната следа. Дефектът беше друг: броячът
   пишеше „500 записа“ и това се четеше като ЦЕЛИЯ брой записи, тоест мълчаливо
   скъсеният списък изглеждаше пълен — библиотекарят би заключил, че по-стари
   действия просто не са записвани. Затова, когато редовете са точно колкото е
   таванът, се казва изрично, че списъкът е скъсен. */
const AUDIT_LIMIT = 500;
function auditCountText(n) {
  return n >= AUDIT_LIMIT
    ? 'показани са последните ' + AUDIT_LIMIT + ' записа (има и по-стари — стеснете с търсенето)'
    : n + (n === 1 ? ' запис' : ' записа');
}
/* Търсенето пипа само тялото на таблицата и брояча — полето #oditSearch НЕ се
   пресъздава. Дотогава debounce-ът викаше цялата renderOdit() и подменяше #view
   заедно с полето: при пауза над 300 ms фокусът изчезваше по средата на думата
   (същият модел като в inv-book.js). */
async function refreshAudit() {
  const rows = await call(window.api.audit.list(ODIT_Q));
  if (!rows) return;
  const body = $('#oditBody'); if (body) body.innerHTML = auditRowsHtml(rows);
  const cnt = $('#oditCount'); if (cnt) cnt.textContent = auditCountText(rows.length);
}
window.refreshAudit = refreshAudit;
async function renderOdit() {
  const rows = await call(window.api.audit.list(ODIT_Q));
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note">Одитната следа записва автоматично кой служител какво е извършил. Задайте името си долу
    вляво в страничния панел, за да се отбелязва коректно.</div>
    <div class="toolbar">
      <input id="oditSearch" placeholder="Търсене по служител, действие, подробност…" value="${esc(ODIT_Q)}">
      <span style="flex:1"></span>
      <span class="hint" id="oditCount">${esc(auditCountText(rows.length))}</span>
      <button class="btn sm" onclick="exportAuditCSV()">CSV</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Дата/час</th><th>Служител</th><th>Действие</th><th>Подробност</th></tr></thead>
    <tbody id="oditBody">${auditRowsHtml(rows)}</tbody></table></div>`;
  $('#oditSearch').addEventListener('input', debounce(e => { ODIT_Q = e.target.value; refreshAudit(); }, 300));
}
async function exportAuditCSV() {
  // audit:export — без лимита на екрана (одит v2.4.25): файлът е за проверяващия.
  const rows = await call(window.api.audit.export(ODIT_Q));
  if (!rows) return;
  const h = ['Дата/час', 'Служител', 'Действие', 'Подробност'];
  /* Одит v2.4.14: това беше ЕДИНСТВЕНОТО изнасяне в CSV, което преизмисляше
     цитирането на място и не прилагаше неутрализацията на водещите = + - @
     (security-utils.js: csvCell). Другите три — каталогът, читателите и
     дневникът — минават през нея. А точно този файл инспекторът от регионалната
     библиотека най-вероятно ще отвори в Excel, и точно тук има клетки, които
     започват направо с данни: името на служителя, заглавие на предложение за
     покупка, име на нов служител. csvSafe е същите три реда, изнесени в
     src/views/core.js, защото екранният слой няма достъп до модула. */
  const csv = [h.join(';')].concat(rows.map(a => [auditTs(a.ts), a.user, a.action, a.detail]
    .map(csvSafe).join(';'))).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'odit.csv'; a.click();
  URL.revokeObjectURL(url);
}
window.exportAuditCSV = exportAuditCSV;
