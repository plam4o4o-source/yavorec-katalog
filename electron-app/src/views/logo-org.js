/* ---------------- Лого на организацията ---------------- */
async function chooseLogo() {
  const res = await window.api.settings.chooseLogo();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast('Логото е записано — влиза автоматично в документите и читателските карти.', 'ok');
  markSaved();
  await loadSettingsCache();
  if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.chooseLogo = chooseLogo;
async function clearLogo() {
  if (!confirm('Премахване на логото от документите и картите?')) return;
  await call(window.api.settings.clearLogo(), 'Логото е премахнато.');
  await loadSettingsCache();
  if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.clearLogo = clearLogo;
async function activeBooks() {
  const books = await call(window.api.books.list(''));
  return (books || []).filter(b => b.status !== 'отчислен');
}
async function printLabelsRange() {
  const from = parseInt($('[name=lblFrom]').value, 10), to = parseInt($('[name=lblTo]').value, 10);
  if (!from || !to || to < from) return toast('Въведете валиден диапазон от инвентарни номера.', 'err');
  const rows = (await activeBooks()).filter(b => b.inv_number >= from && b.inv_number <= to).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Няма документи в този диапазон.', 'err');
  printLabelSheet(rows.map(lblCard).join(''), 'fund');
}
window.printLabelsRange = printLabelsRange;
async function printLabelsAll() {
  const rows = (await activeBooks()).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Фондът е празен.', 'err');
  printLabelSheet(rows.map(lblCard).join(''), 'fund');
}
window.printLabelsAll = printLabelsAll;
async function printSignatureLabelsRange() {
  const from = parseInt($('[name=sigFrom]').value, 10), to = parseInt($('[name=sigTo]').value, 10);
  if (!from || !to || to < from) return toast('Въведете валиден диапазон от инвентарни номера.', 'err');
  const rows = (await activeBooks()).filter(b => b.inv_number >= from && b.inv_number <= to).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Няма документи в този диапазон.', 'err');
  printLabelSheet(rows.map(sigLblCard).join(''), 'sig');
}
window.printSignatureLabelsRange = printSignatureLabelsRange;
async function printSignatureLabelsAll() {
  const rows = (await activeBooks()).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Фондът е празен.', 'err');
  printLabelSheet(rows.map(sigLblCard).join(''), 'sig');
}
window.printSignatureLabelsAll = printSignatureLabelsAll;
async function printCardsAll() {
  const readers = await call(window.api.readers.list(''));
  const rows = (readers || []).filter(r => r.status !== 'прекратен');
  if (!rows.length) return toast('Няма активни читатели.', 'err');
  printLabelSheet(rows.map(readerCardHtml).join(''), 'card');
}
window.printCardsAll = printCardsAll;
/* Карта само за ЕДИН читател (v1.71.0) — бутон „Карта“ на реда в списъка
   Читатели. Дотогава картите се печатаха единствено всичките наведнъж, а
   на практика нова карта трябва най-често на един новозаписан читател. */
async function printCardOne(id) {
  const r = await call(window.api.readers.get(id));
  if (!r) return;
  printLabelSheet(readerCardHtml(r), 'card');
}
window.printCardOne = printCardOne;
async function printReaderCard(id) {
  const r = await call(window.api.readers.get(id));
  if (!r) return;
  const loans = await call(window.api.loans.byReader(id)) || [];
  setPrintPage({ name: `Читателски картон — ${r.name}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ЧИТАТЕЛСКИ КАРТОН № ${esc(r.card_no || '')}</h2>
    <div class="pmeta">
    <b>Име:</b> ${esc(r.name)}<br>
    <b>ЕГН:</b> ${esc(r.egn || '…')} &nbsp; <b>Лична карта:</b> № ${esc(r.id_card_no || '…')}, издадена на ${r.id_card_date ? bg(r.id_card_date) : '…'} от ${esc(r.id_card_issuer || '…')}<br>
    <b>Постоянен адрес:</b> ${esc(r.address || '…')}<br>
    <b>Телефон:</b> ${esc(r.phone || '…')} &nbsp; <b>Имейл:</b> ${esc(r.email || '…')}<br>
    <b>Категория:</b> ${esc(r.category || '')} &nbsp; <b>Записан на:</b> ${bg(r.registered_at)}${r.re_registered_at ? ' · пререгистриран на ' + bg(r.re_registered_at) : ''}
    ${r.guarantor_name ? `<br><b>Родител/настойник:</b> ${esc(r.guarantor_name)} (${esc(r.guarantor_relation || 'родител')}) — тел. ${esc(r.guarantor_phone || '…')}` : ''}</div>
    <div style="width:60mm;border:1px solid #000;padding:2mm;text-align:center;margin-bottom:5mm">
      ${code39svg(r.card_no || String(r.id), 200, 50)}<div style="font-family:monospace;font-size:9pt">${esc(r.card_no || '')}</div></div>
    <table><thead><tr><th>Дата на заемане</th><th>Инв. №</th><th>Заглавие</th><th>Срок</th><th>Върнат на</th></tr></thead><tbody>
    ${loans.slice(0, 14).map(l => `<tr><td>${bg(l.date_out)}</td><td>${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
      <td>${bg(l.date_due) || ''}</td><td>${l.date_in ? bg(l.date_in) : ''}</td></tr>`).join('')}
    </tbody></table>
    ${ssig(['Подпис на читателя: …………………', 'Библиотекар: ' + esc((SETTINGS_CACHE || {}).librarian || '…………………')])}</div>`);
}
window.printReaderCard = printReaderCard;
async function printOverdueNotices() {
  const rows = await call(window.api.loans.overdueByReader());
  if (!rows || !rows.length) return toast('Няма просрочени заемания.', 'err');
  const s = SETTINGS_CACHE || {};
  // Отпечатаното писмо е реално напомняне — регистрира се за всеки читател,
  // със степента от подготвените текстове (ако прозорецът с тях е отворен).
  const levels = {};
  for (const r of (window._REMINDERS || [])) levels[r.reader_id] = r.level || 1;
  rows.forEach(r => window.api.notices.log({
    reader_id: r.reader_id, level: levels[r.reader_id] || 1, channel: 'печат', loans_count: r.n
  }));
  setPrintPage({ name: 'Напомнителни писма — ' + bg(today()), landscape: false, margin: '14mm 12mm' });
  doPrint(rows.map(r => `<div class="pdoc">${shead()}
    <h2>НАПОМНИТЕЛНО ПИСМО</h2>
    <div class="pmeta">До: <b>${esc(r.name)}</b><br>
    Адрес: ${esc(r.address2 || r.address || '…………………')}<br><br>
    Уважаеми/а читателю,<br><br>
    Съгласно чл. 43, ал. 1 от Наредба № 3 от 18.11.2014 г. всеки ползвател е длъжен да върне заетите библиотечни документи
    в определения срок. Според нашата документация срокът на изброените по-долу документи е изтекъл.</div>
    <table><thead><tr><th>Инв. №</th><th>Заглавие</th><th>Зает на</th><th>Срок</th></tr></thead><tbody>
    ${r.loans.map(l => `<tr><td>${l.inv_number ?? ''}</td><td>${esc(l.title)}</td><td>${bg(l.date_out)}</td><td>${bg(l.date_due)}</td></tr>`).join('')}
    </tbody></table>
    <div class="pmeta">Общо дължимо обезщетение: <b>${mny(r.fine)}</b> (${s.fine_per_day} лв./ден забава по чл. 43, ал. 2).</div>
    ${ssig(['Библиотекар: ' + esc(s.librarian || '…………………')])}</div>`).join(''));
}
window.printOverdueNotices = printOverdueNotices;
