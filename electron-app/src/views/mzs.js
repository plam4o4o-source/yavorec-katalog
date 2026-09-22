/* ---------------- МЗС ---------------- */
function mzsBadgeClass(s) { return { 'заявено': '', 'изпратено': 'warn', 'получено': '', 'върнато': 'ok', 'отказано': 'warn' }[s] || ''; }
/* ПРОЗОРЕЧЕН РЕНДЕР И ТУК (v2.4.64, измерване).
   ===========================================================================
   ДОТУК този списък се чертаеше ЦЕЛИЯТ, наведнъж, при всяко отваряне на
   раздела — и това беше обосновано с довода, че „междубиблиотечното заемане е
   рядка операция (единици годишно)“. Доводът не удържа: регистърът по чл. 26 НЕ
   СЕ ЧИСТИ — приключилите заявки остават в него завинаги, за разлика от
   резервациите (holds.js), които излизат от списъка, щом бъдат изпълнени. Тоест
   той не се върти, а само расте: по петдесет заявки годишно това са хиляда реда
   за двайсет години, а библиотека, която работи активно по МЗС, ги събира за
   две-три.
   ИЗМЕРЕНОТО: 500 заявки → 5 516 DOM възела в едно тяло, без нито един таван по
   пътя. За сравнение: 5 400 възела („Книги“, 300 реда) са +73 МБ RSS на рендера
   в истински Chromium (node /tmp/r41/mem-chromium.js) — тоест вече при 500
   заявки този екран струва колкото цял прозорец „Книги“, а нищо не го спира да
   продължи да расте.
   Затова тук е ОБЩАТА машинка (paintRowWindow/RENDER_PAGE_SIZE в core.js) — със
   същия бутон „Покажи още“ и същия таван (RENDER_MAX_ROWS), както в „Книги“ и
   „Читатели“. Списъкът се тегли наведнъж, както досега (mzs:list няма порции в
   обработчика), но на екрана застават 300 реда. */
const MZS_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let MZS_RENDER_LIMIT = MZS_PAGE_SIZE;
let MZS_PAINTED = 0;
function mzsRowsHtml(rows) {
  return rows.length ? rows.map(m => `<tr><td class="num">${m.no} / ${esc(m.year || '')}</td><td class="num">${bg(m.date)}</td>
      <td>${esc(m.direction)}</td><td>${esc(m.partner)}</td><td>${esc([m.author, m.title].filter(Boolean).join('. '))}</td>
      <td>${esc(m.requester || '')}</td><td><span class="badge ${mzsBadgeClass(m.status)}">${esc(m.status)}</span></td>
      <td><button class="btn sm" onclick="openMzs(${m.id})">Отвори</button></td></tr>`).join('')
    : `<tr><td colspan="8" class="empty">Няма заявки.</td></tr>`;
}
function mzsMoreHtml(more, total) {
  return more > 0 ? `<button class="btn" onclick="mzsMore()">Покажи още (${more} от общо ${total})</button>` : '';
}
/* „Покажи още“ само разширява прозореца върху вече изтегления списък — без нова
   обиколка по IPC, точно както в „Книги“ и „Читатели“. */
function mzsMore() {
  MZS_RENDER_LIMIT += MZS_PAGE_SIZE;
  renderMzsBody(true);
}
window.mzsMore = mzsMore;
function renderMzsBody(append) {
  MZS_PAINTED = paintRowWindow({
    body: '#mzsBody', bar: '#mzsMore', rows: window._MZS_ROWS || [], limit: MZS_RENDER_LIMIT,
    painted: append ? MZS_PAINTED : 0,
    rowsHtml: mzsRowsHtml,
    emptyHtml: `<tr><td colspan="8" class="empty">Няма заявки.</td></tr>`,
    moreHtml: mzsMoreHtml
  });
}
window.renderMzsBody = renderMzsBody;
async function renderMzs() {
  const rows = await call(window.api.mzs.list());
  if (!rows) return;
  window._MZS_ROWS = rows;
  MZS_RENDER_LIMIT = MZS_PAGE_SIZE; // ново отваряне на раздела — пак от първата порция
  $('#view').innerHTML = `
    <div class="note">Регистър на заявките за междубиблиотечно заемане — изходящи и входящи.</div>
    <div class="toolbar"><button class="btn pri" onclick="mzsForm()">+ Нова заявка</button></div>
    <!-- Номерът е (година, №): регистърът брои отначало всяка година и проверката за
         дубликат е по двойката (handlers/mzs.js). Голото „№ 1" в списъка сочи към
         толкова заявки, колкото години има регистърът. -->
    <div class="wrap"><table class="ledger"><thead><tr><th>№/год.</th><th>Дата</th><th>Посока</th><th>Партньор</th>
      <th>Документ</th><th>Заявител</th><th>Статус</th><th></th></tr></thead><tbody id="mzsBody"></tbody>
    </table></div>
    <div class="toolbar" id="mzsMore" style="justify-content:center"></div>`;
  renderMzsBody();
}
async function mzsForm(m) {
  const y = yr();
  const no = m ? m.no : await call(window.api.mzs.nextNo(y));
  const v = m || { no, date: today(), direction: 'изходящо', status: 'заявено' };
  modal(m ? 'Заявка № ' + v.no : 'Нова заявка за МЗС', `
    <form id="mzsF" onsubmit="return false">
      <div class="grid g3">
        ${fld('№', 'no', { val: v.no, req: 1 })}
        ${fld('Дата', 'date', { val: v.date, type: 'date', req: 1 })}
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
  if (!await askConfirm('Изтриване на заявката?')) return;
  // Одит v2.4.16: резултатът не се проверяваше — при провал излизаха ДВЕ
  // съобщения („database is locked“ и „Изтрито.“), а редът си оставаше в
  // регистъра. Всички съседни изтривания го правят правилно.
  const ok = await call(window.api.mzs.delete(id), 'Изтрито.');
  if (ok === null) return;
  closeModal(); renderMzs(); markSaved();
}
window.delMzs = delMzs;
