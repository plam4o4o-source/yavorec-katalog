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
  const s = await call(window.api.settings.get());
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
        ${fld('Обща стойност по документа (лв.)', 'sum', { type: 'number', step: '0.01', hint: 'оставете празно, ако документът не обявява стойност' })}
        ${fld('Адрес на дарителя', 'donor_address', { hint: 'задължително при дарение — чл. 6, ал. 5' })}
      </div>
      ${fld('Забележка', 'note', { type: 'textarea', rows: 2 })}
      <fieldset><legend>Комисия — подписва акта за дарение / протокола по чл. 3, ал. 2</legend>
        <div class="hint" style="margin-bottom:6px">Имената се запомнят В ПАРТИДАТА, за да остане препечатаният акт верен и след като
        Настройките бъдат сменени от следващ акт за отчисляване.</div>
        <div class="grid g3">
          ${fld('Член 1', 'committee1', { val: s ? s.committee1 || '' : '' })}
          ${fld('Член 2', 'committee2', { val: s ? s.committee2 || '' : '' })}
          ${fld('Член 3 (счетоводител)', 'committee3', { val: s ? s.committee3 || '' : '' })}
        </div>
      </fieldset>
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
/* Обявената в първичния документ стойност, или null, ако документът не обявява
   такава. Одит v2.4.17: разпечатките четяха `a.sum || acqValue(a.items)` и
   печатаха ИЗЧИСЛЕНИЯ сбор под надписа „Обща стойност по документа“, без да го
   казват — а понеже старата схема пазеше празното поле като 0, това се случваше
   при ВСЯКА партида без въведена стойност. Отделно изричната нула беше
   неразличима от непопълнено поле. Схемата вече пази NULL (миграция 11). */
function acqDeclared(a) {
  if (!a || a.sum === null || a.sum === undefined || a.sum === '') return null;
  const n = Number(a.sum);
  return Number.isFinite(n) ? n : null;
}
/* Комисията, подписала партидата. СНИМКА от завеждането, не живите Настройки:
   handlers/deaccession-acts.js презаписва settings.committee1..3 при всеки утвърден
   акт за отчисляване, тоест препечатан акт за дарение от януари назоваваше
   комисията от последното отчисляване. Стара партида (NULL) се печата с празни
   редове за подпис — по-добре празно, отколкото чуждо име под чужд документ. */
function acqCommittee(a) {
  const names = [a.committee1, a.committee2, a.committee3].filter(Boolean).map(esc);
  return names.length ? names.join(', ') : '…………………';
}
// Същите имена, но подредени за реда за подпис: „1. Иванов 2. Петров 3. …".
function acqSigNames(a) {
  const names = [a.committee1, a.committee2, a.committee3];
  return names.some(Boolean)
    ? names.map((n, i) => (i + 1) + '. ' + (n ? esc(n) : '…………')).join(' ')
    : '1. ………… 2. ………… 3. …………';
}
/* Обявеният общ брой срещу изброените отдолу. Актът излиза подписан и отива в
   счетоводството; заглавието му казва „Общ брой документи: 50“, а таблицата под
   него изброява 3 — дотук без нито дума. */
function acqCountNote(a) {
  const listed = acqCount(a.items), declared = Number(a.total_count) || 0;
  if (listed === declared) return '';
  if (!(a.items || []).length) {
    return `<b>Относно описа:</b> към момента на отпечатване по партидата няма нито един инвентиран документ.
      Настоящият документ удостоверява само общата регистрация по чл. 14 и НЕ съдържа опис на конкретни документи.<br>`;
  }
  return `<b>Относно броя:</b> обявеният общ брой (${declared}) не съвпада със сбора на изброените по-долу инвентирани документи (${listed}). `
    + (listed < declared
      ? `Останалите ${declared - listed} все още не са вписани в инвентарната книга и не се удостоверяват с настоящия опис.`
      : `Изброените надхвърлят обявения брой с ${listed - declared} — проверете партидата преди подписване.`) + '<br>';
}
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
      ${esc(a.doc_type || '')} № ${esc(a.doc_no || '')} от ${bg(a.doc_date)}${a.note ? ' · ' + esc(a.note) : ''}<br>
      ${acqDeclared(a) != null ? 'Обявена стойност по документа: <b>' + mny(acqDeclared(a)) + '</b>'
        : 'Документът не обявява стойност — разпечатките сумират оценките на инвентираните документи.'}
      · Комисия: ${[a.committee1, a.committee2, a.committee3].filter(Boolean).map(esc).join(' · ') || 'не е записана (стара партида) — актът се печата с празни редове за подпис'}</div>
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
  const declared = acqDeclared(a);
  setPrintPage({ name: `Акт за дарение № ${a.no}-${a.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>АКТ № ${a.no} / ${a.year}<br><span style="font-size:12pt">за приемане на дарение на библиотечни документи</span></h2>
    <div class="pmeta">Днес, ${bg(a.date)} г., на основание чл. 6 от Наредба № 3 от 18.11.2014 г. комисия в състав
    ${acqCommittee(a)} прие дарение от:<br>
    <b>Дарител:</b> ${esc(a.from_source || '')}<br><b>Адрес:</b> ${esc(a.donor_address || '…………………')}<br>
    <b>Общ брой документи по документа:</b> ${a.total_count}
    ${/* Ред за стойност се печата само когато има ОТКЪДЕ да дойде число: обявена
          стойност, или поне един инвентиран документ. Иначе актът твърдеше
          „Обща стойност (изчислена по инвентираните документи): 0.00 лв.“ точно
          над бележката, че инвентирани документи няма — сам си противоречи. */''}
    ${declared != null
      ? `&nbsp; <b>Обща стойност по документа:</b> ${mny(declared)}<br>`
      : (a.items.length
        ? `&nbsp; <b>Обща стойност (изчислена по инвентираните документи — документът не обявява стойност):</b> ${mny(acqValue(a.items))}<br>`
        : `<br><b>Обща стойност:</b> не е обявена в документа и не може да бъде изчислена — по партидата още няма инвентирани документи.<br>`)}
    ${(declared != null && acqDiffers(declared, a.items)) ? `<b>Относно стойността:</b> обявената стойност (${mny(declared)}) се различава от сбора
    на инвентираните до момента документи (${mny(acqValue(a.items))}).<br>` : ''}
    ${acqCountNote(a)}
    <b>Основание за придобиване:</b> дарение</div>
    ${a.items.length ? `<table><thead><tr><th>№</th><th>Инв. №</th><th>Автор и заглавие</th><th>Година</th>${
      acqHasMultiples(a.items) ? '<th>Бр.</th>' : ''}<th>Стойност, лв.</th></tr></thead><tbody>
    ${a.items.map((i, n) => `<tr><td>${n + 1}</td><td>${i.inv_number}</td><td>${esc([i.author, i.title].filter(Boolean).join('. '))}</td><td>${esc(i.year || '')}</td>${
      acqHasMultiples(a.items) ? `<td>${acqQty(i)}</td>` : ''}<td>${acqMark(i)}${mny(i.price)}</td></tr>`).join('')}
    <tr><td colspan="4"><b>ОБЩО ${pl(acqCount(a.items), 'документ', 'документа')}</b></td>${
      acqHasMultiples(a.items) ? '<td></td>' : ''}<td><b>${mny(acqValue(a.items))}</b></td></tr></tbody></table>` : ''}
    <div class="pmeta">Актът е съставен в три екземпляра — за счетоводството, за библиотеката и за дарителя.</div>
    ${ssig(['Дарител: …………………', 'Комисия: ' + acqSigNames(a), 'УТВЪРДИЛ: …………………'])}</div>`);
}
window.printDonationDoc = printDonationDoc;
async function printAcqNoDocDoc(id) {
  const a = await call(window.api.acquisitions.get(id));
  if (!a) return;
  const s = SETTINGS_CACHE || {};
  const declared = acqDeclared(a);
  setPrintPage({ name: `Протокол за придобиване № ${a.no}-${a.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ПРОТОКОЛ № ${a.no} / ${a.year}<br><span style="font-size:12pt">за придобиване на библиотечни документи без съпроводителен документ</span></h2>
    <div class="pmeta">Днес, ${bg(a.date)} г., комисия в състав ${acqCommittee(a)},
    установи наличието в библиотеката на посочените по-долу документи, за които <b>липсва</b> първичен счетоводен документ по чл. 3, ал. 2
    от Наредба № 3 от 18.11.2014 г. Комисията извърши експертна оценка на стойността им, за да послужи настоящият протокол като основание
    за редовно вписване в Книгата за движение на библиотечния фонд и в инвентарната книга.<br>
    <b>Начин на постъпване:</b> ${esc(a.how || '')} &nbsp; <b>Откъде/от кого:</b> ${esc(a.from_source || '')}<br>
    <b>Общ брой документи:</b> ${a.total_count}
    ${declared != null
      ? `&nbsp; <b>Обща оценена стойност:</b> ${mny(declared)}<br>`
      : (a.items.length
        ? `&nbsp; <b>Обща стойност по описа (сбор на оценките на изброените документи):</b> ${mny(acqValue(a.items))}<br>`
        : `<br><b>Обща оценена стойност:</b> не е определена — по партидата още няма инвентирани документи.<br>`)}
    ${(declared != null && acqDiffers(declared, a.items)) ? `<b>Относно стойността:</b> обявената при завеждането стойност (${mny(declared)}) се различава от
    сбора на инвентираните до момента документи (${mny(acqValue(a.items))}).<br>` : ''}
    ${acqCountNote(a)}
    ${/* Трите пояснения по-горе носят РАЗЛИЧНИ етикети („Относно стойността“,
          „Относно броя“, „Относно описа“) именно защото могат да излязат
          едновременно: три последователни абзаца, всеки започващ с „Забележка:“,
          са нечетими на документ, който отива подписан в счетоводството. Долният
          ред е свободната бележка на самата партида. */''}
    ${a.note ? '<b>Забележка по партидата:</b> ' + esc(a.note) : ''}</div>
    ${a.items.length ? `<table><thead><tr><th>№</th><th>Инв. №</th><th>Автор и заглавие</th><th>Година</th>${
      acqHasMultiples(a.items) ? '<th>Бр.</th>' : ''}<th>Оценена стойност</th></tr></thead><tbody>
    ${a.items.map((i, n) => `<tr><td>${n + 1}</td><td>${i.inv_number}</td><td>${esc([i.author, i.title].filter(Boolean).join('. '))}</td><td>${esc(i.year || '')}</td>${
      acqHasMultiples(a.items) ? `<td>${acqQty(i)}</td>` : ''}<td>${acqMark(i)}${mny(i.price)}</td></tr>`).join('')}
    <tr><td colspan="4"><b>ОБЩО ${pl(acqCount(a.items), 'документ', 'документа')}</b></td>${
      acqHasMultiples(a.items) ? '<td></td>' : ''}<td><b>${mny(acqValue(a.items))}</b></td></tr></tbody></table>`
    : '<div class="pmeta">Все още няма инвентирани документи по тази партида.</div>'}
    <div class="pmeta">Протоколът се съставя в два екземпляра и се прилага към Книгата за движение на библиотечния фонд,
    част № 1, като заместващ първичен документ.</div>
    ${ssig(['Комисия: ' + acqSigNames(a), 'УТВЪРДИЛ, ' + esc(s.director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printAcqNoDocDoc = printAcqNoDocDoc;
async function delAcq(id) {
  if (!await askConfirm('Изтриване на партидата?')) return;
  const res = await window.api.acquisitions.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderAcq(); toast('Партидата е изтрита.', 'ok'); markSaved();
}
window.delAcq = delAcq;
