/* ---------------- Постъпления ----------------
   Прозоречен рендер (v2.3.1) по общия модел от core.js (paintRowWindow/
   RENDER_PAGE_SIZE). ЗАЩО тук: КДБФ част 1 е РЕГИСТЪР — вписаната партида остава
   в него завинаги (отчисляването е отделен регистър), тоест списъкът само расте.
   Колко бързо се вижда от самия фонд: 15 000 документа, постъпили на партиди по
   няколко десетки, са към 750 вписвания — вече над порцията от 300. Измерено
   (jsdom върху истинския изглед, 800 партиди): 800 изчертани реда и 319 КБ.
   Разделът няма търсачка, затова броячът отдолу е и единственото място, от което
   се вижда колко партиди изобщо има. */
const ACQ_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let ACQ_RENDER_LIMIT = ACQ_PAGE_SIZE;
let ACQ_PAINTED = 0;
function acqRowsHtml(rows) {
  return rows.length ? rows.map(a => `<tr><td class="num">${a.no} / ${a.year}</td><td class="num">${bg(a.date)}</td>
      <td>${esc(a.from_source || '')}</td><td>${esc(a.how || '')}</td>
      <td style="font-size:12px">${esc(a.doc_type || '')} № ${esc(a.doc_no || '')}</td>
      <td class="num">${a.total_count}</td><td class="num">${a.registered_count}</td><td class="num">${mny(a.registered_value)}</td>
      <td><button class="btn sm" onclick="openAcq(${a.id})">Отвори</button></td></tr>`).join('')
    : `<tr><td colspan="9" class="empty">Няма заведени партиди.</td></tr>`;
}
function acqMoreHtml(more, total) {
  // При празен регистър таблицата вече казва „Няма заведени партиди." — „Показани са
  // 0 от 0 партиди." под нея е второ съобщение за същото и звучи като повреда.
  // (Останалите растящи екрани заменят цялата таблица и лентата им изобщо не се строи.)
  if (!total) return '';
  const shown = total - more;
  return `<span class="hint">Показани са ${shown} от ${total} партиди.</span>`
    + (more > 0 ? ` <button class="btn" onclick="ACQ_RENDER_LIMIT+=${ACQ_PAGE_SIZE};paintAcqRows(true)">Покажи още (${more} от общо ${total})</button>` : '');
}
/* append=true идва САМО от „Покажи още“; след завеждане или изтриване на партида
   renderAcq() минава наново с пълен рендер — там наборът е друг. */
function paintAcqRows(append) {
  ACQ_PAINTED = paintRowWindow({
    body: '#acqBody', bar: '#acqMore', rows: window._ACQ_LIST || [], limit: ACQ_RENDER_LIMIT,
    painted: append ? ACQ_PAINTED : 0,
    rowsHtml: acqRowsHtml, moreHtml: acqMoreHtml
  });
}
window.paintAcqRows = paintAcqRows;
async function renderAcq() {
  const rows = await call(window.api.acquisitions.list());
  if (!rows) return;
  window._ACQ_LIST = rows;
  ACQ_RENDER_LIMIT = ACQ_PAGE_SIZE; // ново влизане — пак от първата порция
  $('#view').innerHTML = `
    <div class="note"><b>Чл. 3 – 14</b> — документите постъпват чрез закупуване, депозит, обмен или дарение,
    винаги с първичен счетоводен документ.</div>
    <div class="toolbar"><button class="btn pri" onclick="acqForm()">+ Нова партида</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>№/год.</th><th>Дата</th><th>Откъде</th><th>Как</th>
      <th>Документ</th><th>Брой</th><th>Инвентирани</th><th>Стойност</th><th></th></tr></thead>
      <tbody id="acqBody"></tbody></table></div>
    <div class="toolbar" id="acqMore" style="justify-content:center"></div>`;
  paintAcqRows(false);
}
async function acqForm() {
  const y = yr();
  const no = await call(window.api.acquisitions.nextNo(y));
  modal('Нова партида — обща регистрация', `
    <div class="note"><b>Чл. 14, ал. 2</b> — вписват се: дата и номер, откъде и как са постъпили, вид/номер/дата на
    първичния документ, общ брой документи.</div>
    <form id="acqF" onsubmit="return false">
      <div class="grid g4">
        ${fld('№ на вписване', 'no', { val: no, req: 1 })}
        ${fld('Дата на вписване', 'date', { val: today(), type: 'date', req: 1 })}
        ${fld('Начин на постъпване', 'how', { type: 'select', opts: NACHINI, val: NACHINI[0] })}
        ${fld('Общ брой документи', 'total_count', { val: '', type: 'number', req: 1 })}
      </div>
      ${fld('Откъде (доставчик / дарител)', 'from_source', { req: 1 })}
      <div class="grid g3">
        ${fld('Вид първичен документ', 'doc_type', { type: 'select', opts: PARV_DOK })}
        ${fld('Номер на документа', 'doc_no', {})}
        ${fld('Дата на документа', 'doc_date', { val: today(), type: 'date' })}
      </div>
      <div class="grid g2">
        ${fld('Обща стойност по документа (лв.)', 'sum', { type: 'number', step: '0.01' })}
        ${fld('Адрес на дарителя', 'donor_address', { hint: 'задължително при дарение — чл. 6, ал. 5' })}
      </div>
      ${fld('Забележка', 'note', { type: 'textarea', rows: 2 })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveAcq()">Заведи партидата</button>`);
}
window.acqForm = acqForm;
async function saveAcq() {
  const missing = firstMissingRequired('#acqF');
  if (missing) return toast(missing + ' е задължително поле.', 'err');
  const d = formData('#acqF');
  const id = await call(window.api.acquisitions.create(d), 'Партидата е заведена в КДБФ част 1.');
  if (id) { closeModal(); renderAcq(); }
}
window.saveAcq = saveAcq;
/* Отчетната бройка на един инвентиран ред от партидата. `fund_qty` идва от
   acquisitions:get и е COALESCE(inventory.quantity, 1) — броят ДОКУМЕНТИ, за
   разлика от `quantity`, което е наличността за заемане и е 0 при липсващ ред.
   Едно и също правило за картата, за списъка и за разпечатките: „Инвентирани"
   в списъка вече брои документи (handlers/acquisitions.js), а картата на същата
   партида показваше заглавия — и „Остават" тласкаше библиотекаря да въведе
   записи, които не съществуват. */
function acqQty(i) { return (i && i.fund_qty != null) ? (Number(i.fund_qty) || 0) : 1; }
function acqCount(items) { return (items || []).reduce((s, i) => s + acqQty(i), 0); }
function acqValue(items) { return (items || []).reduce((s, i) => s + (Number(i.price) || 0) * acqQty(i), 0); }
/* Има ли ред, чиято бройка не е един документ — виж същата бележка в
   src/views/deaccession-acts.js. Дотук пояснението „N заглавия“ се показваше
   при `acqCount !== items.length`, което съвпада случайно и изчезва точно при
   смесени бройки. */
function acqMark(i) { return acqQty(i) !== 1 ? acqQty(i) + ' × ' : ''; }
/* Двете суми се сравняват в СТОТИНКИ, не като числа с плаваща запетая. Одит
   v2.4.16: `total !== acqValue(a.items)` върху 10.10 + 20.20 дава 30.299999…
   срещу обявените 30.30 и „Забележката“ излизаше на около една от всеки три
   партиди — с два ОТПЕЧАТАНИ ЕДНАКВИ израза от двете страни на думата „различава
   се“. Тоест поправката, която трябваше да махне вътрешното противоречие от
   заместващ първичен счетоводен документ, го създаваше сама.
   Закръглянето е същото, което ползва и handlers/account.js (toCents). */
const cents = (n) => Math.round((Number(n) || 0) * 100);
function acqDiffers(declared, items) { return cents(declared) !== cents(acqValue(items)); }
function acqHasMultiples(items) { return (items || []).some(i => acqQty(i) !== 1); }
// Означението пред цената на един ред в разпечатките. Одит v2.4.14: редът ОБЩО
// вече беше Σ(цена × бройка), но всеки ред печаташе гола единична цена и в
// таблицата нямаше нито колона за бройка, нито означение — счетоводителят вижда
// колона, която се сумира на едно, и ред ОБЩО, който казва друго. Протоколът по
// чл. 3, ал. 2 е ЗАМЕСТВАЩ първичен счетоводен документ; вътрешното му
// противоречие е по-скъпо от неудобството на още една колона.

async function openAcq(id) {
  const a = await call(window.api.acquisitions.get(id));
  if (!a) return;
  modal('Партида № ' + a.no + ' / ' + a.year, `
    <div class="cards">
      <div class="card"><div class="num">${a.total_count}</div><div class="lbl">Общо по документ</div></div>
      <div class="card"><div class="num">${acqCount(a.items)}</div><div class="lbl">Инвентирани</div>${
        acqHasMultiples(a.items) ? `<div class="lbl">${a.items.length} заглавия</div>` : ''}</div>
      <div class="card"><div class="num">${Math.max(0, a.total_count - acqCount(a.items))}</div><div class="lbl">Остават</div></div>
    </div>
    <div class="hint" style="margin-bottom:10px">${esc(a.how || '')} · ${esc(a.from_source || '')} ·
      ${esc(a.doc_type || '')} № ${esc(a.doc_no || '')} от ${bg(a.doc_date)}${a.note ? ' · ' + esc(a.note) : ''}</div>
    ${a.items.length ? `<div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор и заглавие</th><th>Год.</th><th>Цена</th></tr></thead><tbody>
      ${a.items.map(i => `<tr><td class="num">${i.inv_number}</td><td>${esc([i.author, i.title].filter(Boolean).join('. '))}</td>
      <td class="num">${esc(i.year || '')}</td><td class="num">${acqMark(i)}${mny(i.price)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="hint">Все още няма инвентирани документи по тази партида.</div>'}`,
    `<button class="btn l dgr" onclick="delAcq(${id})">Изтрий</button>
     ${a.how === 'дарение' ? `<button class="btn l" onclick="printDonationDoc(${id})">Акт за дарение / PDF</button>` : ''}
     ${a.doc_type && a.doc_type.indexOf('без документ') > -1 ? `<button class="btn l" onclick="printAcqNoDocDoc(${id})">Протокол за придобиване / PDF</button>` : ''}
     <button class="btn" onclick="closeModal();bookForm(null, ${id})">+ Инвентирай документ</button>
     <button class="btn pri" onclick="closeModal()">Затвори</button>`);
}
window.openAcq = openAcq;
async function printDonationDoc(id) {
  const a = await call(window.api.acquisitions.get(id));
  if (!a) return;
  const s = SETTINGS_CACHE || {};
  setPrintPage({ name: `Акт за дарение № ${a.no}-${a.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>АКТ № ${a.no} / ${bg(a.date)}<br><span style="font-size:12pt">за приемане на дарение на библиотечни документи</span></h2>
    <div class="pmeta">На основание чл. 6 от Наредба № 3 от 18.11.2014 г. комисия в състав
    ${[s.committee1, s.committee2, s.committee3].filter(Boolean).map(esc).join(', ') || '…………………'} прие дарение от:<br>
    <b>Дарител:</b> ${esc(a.from_source || '')}<br><b>Адрес:</b> ${esc(a.donor_address || '…………………')}<br>
    <b>Общ брой документи:</b> ${a.total_count} &nbsp; <b>Обща стойност:</b> ${mny(a.sum || acqValue(a.items))}<br>
    ${(a.sum && acqDiffers(a.sum, a.items)) ? `<b>Забележка:</b> обявената стойност (${mny(a.sum)}) се различава от сбора
    на инвентираните до момента документи (${mny(acqValue(a.items))}).<br>` : ''}
    <b>Основание за придобиване:</b> дарение</div>
    ${a.items.length ? `<table><thead><tr><th>№</th><th>Инв. №</th><th>Автор и заглавие</th><th>Година</th><th>Бр.</th><th>Стойност, лв.</th></tr></thead><tbody>
    ${a.items.map((i, n) => `<tr><td>${n + 1}</td><td>${i.inv_number}</td><td>${esc([i.author, i.title].filter(Boolean).join('. '))}</td><td>${esc(i.year || '')}</td><td>${acqQty(i)}</td><td>${acqMark(i)}${mny(i.price)}</td></tr>`).join('')}
    <tr><td colspan="5"><b>ОБЩО ${acqCount(a.items)} документа</b></td><td><b>${mny(acqValue(a.items))}</b></td></tr></tbody></table>` : ''}
    <div class="pmeta">Актът е съставен в три екземпляра — за счетоводството, за библиотеката и за дарителя.</div>
    ${ssig(['Дарител: …………………', 'Комисия: …………………', 'УТВЪРДИЛ: …………………'])}</div>`);
}
window.printDonationDoc = printDonationDoc;
async function printAcqNoDocDoc(id) {
  const a = await call(window.api.acquisitions.get(id));
  if (!a) return;
  const s = SETTINGS_CACHE || {};
  const total = a.sum || acqValue(a.items);
  setPrintPage({ name: `Протокол за придобиване № ${a.no}-${a.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ПРОТОКОЛ № ${a.no} / ${bg(a.date)}<br><span style="font-size:12pt">за придобиване на библиотечни документи без съпроводителен документ</span></h2>
    <div class="pmeta">Днес, ${bg(a.date)} г., комисия в състав ${[s.committee1, s.committee2, s.committee3].filter(Boolean).map(esc).join(', ') || '…………………'},
    установи наличието в библиотеката на посочените по-долу документи, за които <b>липсва</b> първичен счетоводен документ по чл. 3, ал. 2
    от Наредба № 3 от 18.11.2014 г. Комисията извърши експертна оценка на стойността им, за да послужи настоящият протокол като основание
    за редовно вписване в Книгата за движение на библиотечния фонд и в инвентарната книга.<br>
    <b>Начин на постъпване:</b> ${esc(a.how || '')} &nbsp; <b>Откъде/от кого:</b> ${esc(a.from_source || '')}<br>
    <b>Общ брой документи:</b> ${a.total_count} &nbsp; <b>Обща оценена стойност:</b> ${mny(total)}
    ${acqDiffers(total, a.items) ? `<br><b>Забележка:</b> обявената стойност по документа (${mny(total)}) се различава от
    сбора на инвентираните до момента документи (${mny(acqValue(a.items))}).` : ''}
    ${a.note ? '<br><b>Забележка:</b> ' + esc(a.note) : ''}</div>
    ${a.items.length ? `<table><thead><tr><th>№</th><th>Инв. №</th><th>Автор и заглавие</th><th>Година</th><th>Бр.</th><th>Оценена стойност</th></tr></thead><tbody>
    ${a.items.map((i, n) => `<tr><td>${n + 1}</td><td>${i.inv_number}</td><td>${esc([i.author, i.title].filter(Boolean).join('. '))}</td><td>${esc(i.year || '')}</td><td>${acqQty(i)}</td><td>${acqMark(i)}${mny(i.price)}</td></tr>`).join('')}
    <tr><td colspan="5"><b>ОБЩО ${acqCount(a.items)} документа</b></td><td><b>${mny(acqValue(a.items))}</b></td></tr></tbody></table>`
    : '<div class="pmeta">Все още няма инвентирани документи по тази партида.</div>'}
    <div class="pmeta">Протоколът се съставя в два екземпляра и се прилага към Книгата за движение на библиотечния фонд,
    част № 1, като заместващ първичен документ.</div>
    ${ssig(['Комисия: 1. ………… 2. ………… 3. …………', 'УТВЪРДИЛ, ' + esc(s.director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printAcqNoDocDoc = printAcqNoDocDoc;
async function delAcq(id) {
  if (!confirm('Изтриване на партидата?')) return;
  const res = await window.api.acquisitions.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderAcq(); toast('Партидата е изтрита.', 'ok'); markSaved();
}
window.delAcq = delAcq;
