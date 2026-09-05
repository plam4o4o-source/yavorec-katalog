/* ---------------- Периодика ---------------- */
async function renderPeriodika() {
  const list = await call(window.api.periodicals.list());
  if (!list) return;
  $('#view').innerHTML = `
    <div class="note">Картотека на периодичните издания и постъпилите броеве към всяко от тях (кардекс).</div>
    <div class="toolbar"><button class="btn pri" onclick="periodicalForm()">+ Ново периодично издание</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Заглавие</th><th>Периодичност</th><th>Издател</th>
      <th>ISSN</th><th>Отдел</th><th>Броеве</th><th>Следващ очакван брой</th><th></th></tr></thead><tbody>
    ${list.length ? list.map(p => `<tr><td>${esc(p.title)}</td><td>${esc(p.freq || '')}</td><td>${esc(p.publisher || '')}</td>
      <td class="num">${esc(p.issn || '')}</td><td>${esc(p.department || '')}</td><td class="num">${p.issue_count}</td>
      <td class="num">${periodicalNextHtml(p)}</td>
      <td><button class="btn sm" onclick="openPeriodical(${p.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="8" class="empty">Няма заведени периодични издания.</td></tr>`}
    </tbody></table></div>`;
}
/* Следваща очаквана дата, изчислена в handlers/periodicals.js от периодичността
   и датата на последния постъпил брой (Koha: серийни издания — облекчен вариант
   за мащаба на читалищна библиотека, само предвиждане на дата, без пълен
   календар/рекламации). „—“ означава, че изданието е с „нередовно“/непозната
   периодичност или все още няма нито един вписан брой — тогава предвиждане
   умишлено не се прави (виж коментара в handlers/periodicals.js). */
function periodicalNextHtml(p) {
  if (!p.next_expected) return '<span class="hint">—</span>';
  return p.issue_overdue_days > 0
    ? `<span class="badge warn" title="Няма нов брой ${p.issue_overdue_days} дни след очакваната дата">${bg(p.next_expected)}</span>`
    : bg(p.next_expected);
}
/* Приема САМО id (v2.2.0) и сам зарежда записа, както другите форми. Дотогава
   бутонът „Редактирай“ вграждаше целия обект в onclick атрибута с ръчно
   екраниране (JSON.stringify(p).replace(/"/g,'&quot;')), което заобикаляше
   jsq() — и заедно с това вкарваше в атрибута и p.issues, тоест цялата история
   на изданието (стотици килобайта при дълга поредица от броеве). */
async function periodicalForm(id) {
  const p = id ? await call(window.api.periodicals.get(id)) : null;
  if (id && !p) return;
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
  // Затваря се само при успех (v2.2.0) — при отказан запис попълненото остава.
  const ok = id ? await call(window.api.periodicals.update(d), 'Записано.')
    : await call(window.api.periodicals.create(d), 'Записано.');
  if (ok === null) return;
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
        ${fld('Номер на брой', 'issue_no', { req: 1, onkey: `if(event.key==='Enter'){event.preventDefault();addIssue(${id})}` })}
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
     <button class="btn" onclick="closeModal();periodicalForm(${id})">Редактирай</button>
     <button class="btn pri" onclick="closeModal();periodikaRefreshIfShown()">Затвори</button>`);
  setTimeout(() => { const f = $('#issueF [name=issue_no]'); if (f) f.focus(); }, 0);
}
window.openPeriodical = openPeriodical;
/* Одит v2.4.29: след „Добави брой“/„×“ списъкът зад кардекса показваше старите
   „Броеве“ и „Следващ очакван брой“ до повторно влизане в раздела. */
function periodikaRefreshIfShown() { if (VIEW === 'periodika') renderPeriodika(); }
window.periodikaRefreshIfShown = periodikaRefreshIfShown;
async function addIssue(periodicalId) {
  const d = formData('#issueF');
  if (!d.issue_no) return toast('Въведете номер на брой.', 'err');
  d.periodical_id = periodicalId;
  // Затваря се/пречертава се само при успех; отказът (невалидна дата, цена) остава във формата.
  const ok = await call(window.api.periodicalIssues.add(d), 'Брой ' + d.issue_no + ' е вписан в кардекса.');
  if (ok === null) return;
  markSaved();
  openPeriodical(periodicalId);
}
window.addIssue = addIssue;
async function delIssue(id, periodicalId) {
  /* Одит v2.4.16: изтриваше се без питане и без проверка на резултата. Един
     неточен натиск в 240-пикселов превъртащ се списък махаше регистриран брой, а
     път за връщане в интерфейса няма. Съседното delPeriodical пита както трябва. */
  if (!confirm('Да изтрия ли този брой от кардекса? Действието не може да бъде отменено.')) return;
  const ok = await call(window.api.periodicalIssues.delete(id), 'Броят е изтрит.');
  if (ok === null) return;
  markSaved();
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
