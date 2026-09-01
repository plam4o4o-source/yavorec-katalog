/* ---------------- МЗС ---------------- */
function mzsBadgeClass(s) { return { 'заявено': '', 'изпратено': 'warn', 'получено': '', 'върнато': 'ok', 'отказано': 'warn' }[s] || ''; }
async function renderMzs() {
  const rows = await call(window.api.mzs.list());
  if (!rows) return;
  window._MZS_ROWS = rows;
  $('#view').innerHTML = `
    <div class="note">Регистър на заявките за междубиблиотечно заемане — изходящи и входящи.</div>
    <div class="toolbar"><button class="btn pri" onclick="mzsForm()">+ Нова заявка</button></div>
    <!-- Номерът е (година, №): регистърът брои отначало всяка година и проверката за
         дубликат е по двойката (handlers/mzs.js). Голото „№ 1" в списъка сочи към
         толкова заявки, колкото години има регистърът. -->
    <div class="wrap"><table class="ledger"><thead><tr><th>№/год.</th><th>Дата</th><th>Посока</th><th>Партньор</th>
      <th>Документ</th><th>Заявител</th><th>Статус</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(m => `<tr><td class="num">${m.no} / ${esc(m.year || '')}</td><td class="num">${bg(m.date)}</td>
      <td>${esc(m.direction)}</td><td>${esc(m.partner)}</td><td>${esc([m.author, m.title].filter(Boolean).join('. '))}</td>
      <td>${esc(m.requester || '')}</td><td><span class="badge ${mzsBadgeClass(m.status)}">${esc(m.status)}</span></td>
      <td><button class="btn sm" onclick="openMzs(${m.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="8" class="empty">Няма заявки.</td></tr>`}
    </tbody></table></div>`;
}
async function mzsForm(m) {
  const y = yr();
  const no = m ? m.no : await call(window.api.mzs.nextNo(y));
  const v = m || { no, date: today(), direction: 'изходящо', status: 'заявено' };
  modal(m ? 'Заявка № ' + v.no : 'Нова заявка за МЗС', `
    <form id="mzsF" onsubmit="return false">
      <div class="grid g3">
        ${fld('№', 'no', { val: v.no, req: 1 })}
        ${fld('Дата', 'date', { val: v.date, type: 'date' })}
        ${fld('Посока', 'direction', { type: 'select', opts: ['изходящо', 'входящо'], val: v.direction })}
      </div>
      ${fld('Библиотека партньор', 'partner', { val: v.partner || '', req: 1 })}
      <div class="grid g2">
        ${fld('Автор', 'author', { val: v.author || '' })}
        ${fld('Заглавие', 'title', { val: v.title || '', req: 1 })}
      </div>
      <div class="grid g3">
        ${fld('ISBN/ISSN', 'isbn', { val: v.isbn || '' })}
        ${fld('Заявител (читател)', 'requester', { val: v.requester || '' })}
        ${fld('Статус', 'status', { type: 'select', opts: MZS_STATUS, val: v.status })}
      </div>
      ${fld('Срок за връщане', 'due_date', { val: v.due_date || '', type: 'date' })}
      ${fld('Забележка', 'note', { val: v.note || '', type: 'textarea', rows: 2 })}
    </form>`,
    `${m ? `<button class="btn l dgr" onclick="delMzs(${m.id})">Изтрий</button>
     <button class="btn l" onclick="printMzsDoc(${m.id})">Печат / PDF</button>` : ''}
     <button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveMzs(${m ? m.id : 'null'})">Запиши</button>`);
}
window.mzsForm = mzsForm;
function printMzsDoc(id) {
  const m = (window._MZS_ROWS || []).find(x => x.id === id);
  if (!m) return;
  const s = SETTINGS_CACHE || {};
  /* ВХОДЯЩАТА заявка е чужд документ. Дотук и двете посоки се печатаха на НАШАТА
     бланка, под заглавие „ЗАЯВКА ЗА МЕЖДУБИБЛИОТЕЧНО ЗАЕМАНЕ" и с реда за подпис
     „Библиотекар … / Ръководител …" — тоест библиотеката подписваше като СВОЯ
     заявката, която друга библиотека е отправила към нея. При партньор, който
     получи такъв лист, това е заявка от нас за документ, който сме дали ние.
     Входящата се печата като извлечение от регистъра и се подписва като предаване. */
  const inc = m.direction === 'входящо';
  /* Номерът е (година, №) — така се пази в регистъра и така се проверява за
     дубликат (handlers/mzs.js). Заглавието печаташе „№ 5 / 12.03.2026", тоест
     номер, който не съвпада нито с регистъра, нито с името на самия файл. */
  setPrintPage({ name: `${inc ? 'Входяща заявка за МЗС' : 'Заявка за МЗС'} № ${m.no}-${m.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>${inc ? 'ВХОДЯЩА ЗАЯВКА ЗА МЕЖДУБИБЛИОТЕЧНО ЗАЕМАНЕ' : 'ЗАЯВКА ЗА МЕЖДУБИБЛИОТЕЧНО ЗАЕМАНЕ'} № ${m.no} / ${m.year}</h2>
    <div class="pmeta">
    <b>Дата на вписване:</b> ${bg(m.date)} г.<br>
    ${inc
      ? `Настоящото е извлечение от регистъра за междубиблиотечно заемане на ${esc(s.org || 'библиотеката')} по заявка,
         <b>постъпила от</b> ${esc(m.partner)}. Не представлява заявка от страна на ${esc(s.org || 'библиотеката')}.<br>
         <b>Заявяваща библиотека:</b> ${esc(m.partner)}<br>`
      : `<b>До:</b> ${esc(m.partner)}<br>`}
    <b>${inc ? 'Заявен документ' : 'Търсен документ'}:</b> ${esc([m.author, m.title].filter(Boolean).join('. '))}${m.isbn ? ' · ISBN/ISSN ' + esc(m.isbn) : ''}<br>
    ${m.requester ? `<b>${inc ? 'Читател при заявяващата библиотека' : 'Заявител (читател)'}:</b> ` + esc(m.requester) + '<br>' : ''}
    <b>Статус:</b> ${esc(m.status)}${m.due_date ? ' · срок за връщане ' + bg(m.due_date) : ''}
    ${m.note ? '<br><b>Забележка:</b> ' + esc(m.note) : ''}</div>
    ${ssig(inc
      ? ['Предал документа: ' + esc(s.librarian || '…………………'), 'Получил: …………………']
      : ['Библиотекар: ' + esc(s.librarian || '…………………'), esc(s.director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printMzsDoc = printMzsDoc;
async function saveMzs(id) {
  const missing = firstMissingRequired('#mzsF');
  if (missing) return toast(missing + ' е задължително поле.', 'err');
  const d = formData('#mzsF'); d.id = id;
  // Затваря се само при успех (v2.2.0) — при отказан запис попълненото остава.
  const ok = id ? await call(window.api.mzs.update(d), 'Записано.')
    : await call(window.api.mzs.create(d), 'Записано.');
  if (ok === null) return;
  closeModal(); renderMzs();
}
window.saveMzs = saveMzs;
async function openMzs(id) {
  const rows = await call(window.api.mzs.list());
  window._MZS_ROWS = rows || [];
  const m = window._MZS_ROWS.find(x => x.id === id);
  if (m) mzsForm(m);
}
window.openMzs = openMzs;
async function delMzs(id) {
  if (!confirm('Изтриване на заявката?')) return;
  // Одит v2.4.16: резултатът не се проверяваше — при провал излизаха ДВЕ
  // съобщения („database is locked“ и „Изтрито.“), а редът си оставаше в
  // регистъра. Всички съседни изтривания го правят правилно.
  const ok = await call(window.api.mzs.delete(id), 'Изтрито.');
  if (ok === null) return;
  closeModal(); renderMzs(); markSaved();
}
window.delMzs = delMzs;
