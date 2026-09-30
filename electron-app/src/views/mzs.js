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
/* ПРОСРОЧЕНИТЕ И ВРЪЗКИТЕ СЕ ВИЖДАТ В РЕГИСТЪРА (v2.4.69, кръг 44, К6 и К8).
   (а) Дотук редът казваше само състоянието: получена чужда книга със срок,
       изтекъл преди 10 дни, стоеше „получено“ като всяка друга (тестер № 5), а
       свързаните читател и наш документ не се виждаха никъде.
   (б) Срокът към другата библиотека е задължение на читалището; ако не се вижда
       тук, не се вижда никъде.
   (в) Кои заявки са просрочени решава обработчикът (mzs:overdue — същото
       правило ползва и таблото); тук само се слага червен знак със срока и
       дните. Колоната „Заявител“ показва свързания читател с картата му, а
       „Документ“ — нашия инв. №. */
function mzsRowsHtml(rows) {
  const late = window._MZS_OVERDUE || {};
  return rows.length ? rows.map(m => {
    const od = late[m.id];
    const who = m.reader_name ? m.reader_name + (m.reader_card ? ' (карта ' + m.reader_card + ')' : '') : (m.requester || '');
    return `<tr${od ? ' class="overdue"' : ''}><td class="num">${m.no} / ${esc(m.year || '')}</td><td class="num">${bg(m.date)}</td>
      <td>${esc(m.direction)}</td><td>${esc(m.partner)}</td><td>${esc(authorTitleText(m.author, m.title))}${m.book_inv != null ? ' <span class="muted">· наш инв. № ' + esc(m.book_inv) + '</span>' : ''}</td>
      <td>${esc(who)}</td><td><span class="badge ${mzsBadgeClass(m.status)}">${esc(m.status)}</span>${od
        ? ` <span class="badge warn" title="${esc(od.text)}">просрочена ${od.days_over === 1 ? '1 ден' : od.days_over + ' дни'} (срок ${bg(od.due_date)})</span>` : ''}</td>
      <td><button class="btn sm" onclick="openMzs(${m.id})">Отвори</button></td></tr>`;
  }).join('')
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
/* Просрочените по МЗС — от обработчика (К6). Ако каналът липсва (по-стара
   обвръзка), регистърът се показва без знаците, а не се чупи. */
async function loadMzsOverdue() {
  window._MZS_OVERDUE = {};
  if (!window.api.mzs.overdue) return [];
  const list = await call(window.api.mzs.overdue());
  for (const o of (list || [])) window._MZS_OVERDUE[o.id] = o;
  return list || [];
}
async function renderMzs() {
  const [rows, overdue] = await Promise.all([call(window.api.mzs.list()), loadMzsOverdue()]);
  if (!rows) return;
  window._MZS_ROWS = rows;
  MZS_RENDER_LIMIT = MZS_PAGE_SIZE; // ново отваряне на раздела — пак от първата порция
  $('#view').innerHTML = `
    <div class="note">Регистър на заявките за междубиблиотечно заемане — изходящи и входящи.</div>
    ${overdue.length ? `<div class="note" id="mzsOverdueNote" style="border-left-color:var(--red)"><b style="color:var(--red)">Изтекъл срок за връщане:
      ${overdue.length === 1 ? '1 заявка' : overdue.length + ' заявки'}.</b><br>${overdue.map(o => esc(o.text)).join('<br>')}</div>` : ''}
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
/* ФОРМАТА ПРЕДУПРЕЖДАВА ПО-РАНО; ПРАВИЛОТО Е В ОБРАБОТЧИКА (v2.4.69, К8).
   • Състояние: всички се виждат, но позволени са само текущото, следващите по
     реда и една стъпка назад (поправка) — останалите са сиви. Същото правило
     отказва прескачането и в handlers/mzs.js, с обяснение.
   • Изходяща заявка — „Читател (карта №)“: получената чужда книга се дава на
     него по самата заявка, без вписване във фонда. Входяща — „Наш документ
     (инв. № / баркод)“: докато е при партньора, не се заема и е „зает“ онлайн.
   • Номерът на новата заявка следва годината на ДАТАТА: смяна на датата към
     друга година предлага следващия свободен № за нея (и saveMzs() го
     проверява още веднъж, ако промяната не е стигнала навреме). */
const MZS_NEXT = { 'заявено': ['изпратено', 'отказано'], 'изпратено': ['получено', 'отказано'], 'получено': ['върнато'], 'върнато': [], 'отказано': [] };
function mzsBackOf(m) {
  return { 'изпратено': 'заявено', 'получено': 'изпратено', 'върнато': 'получено' }[m.status]
    || (m.status === 'отказано' ? (m.date_sent ? 'изпратено' : 'заявено') : null);
}
function mzsStatusOpts(m) {
  const cur = m && m.id ? (m.status || 'заявено') : null;
  const ok = cur ? [cur, ...(MZS_NEXT[cur] || []), mzsBackOf(m)].filter(Boolean) : ['заявено', 'отказано'];
  return MZS_STATUS.map(s => ok.includes(s) ? s : { v: s, t: s + ' (не следва от „' + (cur || 'нова') + '“)' });
}
function mzsDirToggle() {
  const d = ($('#mzsF [name=direction]') || {}).value;
  const r = $('#mzsReaderBox'), b = $('#mzsBookBox');
  if (r) r.style.display = d === 'входящо' ? 'none' : '';
  if (b) b.style.display = d === 'входящо' ? '' : 'none';
}
window.mzsDirToggle = mzsDirToggle;
async function mzsDateChanged() {
  const f = $('#mzsF [name=no]');
  if (!f || f.dataset.auto !== '1') return;
  const y = yr(($('#mzsF [name=date]') || {}).value || today());
  if (y === f.dataset.year) return;
  const n = await call(window.api.mzs.nextNo(y));
  // Междувременно saveMzs() може вече да го е пресметнал — второ съобщение не трябва.
  if (n == null || f.dataset.year === y) return;
  f.value = n; f.dataset.year = y; f.dataset.proposed = String(n);
  toast('Номерът е сменен на ' + n + '/' + y + ' — следващият свободен за годината на датата.', 'ok');
}
window.mzsDateChanged = mzsDateChanged;
async function mzsForm(m) {
  const y = yr();
  const no = m ? m.no : await call(window.api.mzs.nextNo(y));
  const v = m || { no, date: today(), direction: 'изходящо', status: 'заявено' };
  const dates = [['изпратено', v.date_sent], ['получено', v.date_received], ['върнато', v.date_returned]]
    .filter(x => x[1]).map(x => x[0] + ' на ' + bg(x[1]));
  modal(m ? 'Заявка № ' + v.no : 'Нова заявка за МЗС', `
    <form id="mzsF" onsubmit="return false">
      <div class="grid g3">
        ${fld('№', 'no', { val: v.no, req: 1 })}
        ${fld('Дата', 'date', { val: v.date, type: 'date', req: 1, onchange: m ? '' : 'mzsDateChanged()' })}
        ${fld('Посока', 'direction', { type: 'select', opts: ['изходящо', 'входящо'], val: v.direction, allowEmpty: false, onchange: 'mzsDirToggle()' })}
      </div>
      ${fld('Библиотека партньор', 'partner', { val: v.partner || '', req: 1 })}
      <div class="grid g2">
        ${fld('Автор', 'author', { val: v.author || '' })}
        ${fld('Заглавие', 'title', { val: v.title || '', req: 1 })}
      </div>
      <div class="grid g3">
        ${fld('ISBN/ISSN', 'isbn', { val: v.isbn || '' })}
        ${fld('Заявител (читател)', 'requester', { val: v.requester || '' })}
        ${fld('Статус', 'status', { type: 'select', opts: mzsStatusOpts(v), val: v.status, allowEmpty: false })}
      </div>
      <div class="grid g2">
        <div id="mzsReaderBox">${fld('Наш читател (карта №)', 'reader_card', { val: v.reader_card || '',
          hint: 'по желание — получената книга се дава на него по заявката, без вписване във фонда' })}</div>
        <div id="mzsBookBox">${fld('Наш документ (инв. № / баркод)', 'book_code', { val: v.book_inv != null ? v.book_inv : '',
          hint: 'задължително при „изпратено“ — докато е при партньора, не се заема и е „зает“ онлайн' })}</div>
        ${fld('Срок за връщане', 'due_date', { val: v.due_date || '', type: 'date',
          hint: 'задължителен при „получено“ на изходяща заявка — по него се следи просрочието' })}
      </div>
      ${dates.length ? `<div class="hint">Отбелязано: ${esc(dates.join(' · '))}. Датите се попълват сами при смяна на състоянието.</div>` : ''}
      ${fld('Забележка', 'note', { val: v.note || '', type: 'textarea', rows: 2 })}
    </form>`,
    `${m ? `<button class="btn l dgr" onclick="delMzs(${m.id})">Изтрий</button>
     <button class="btn l" onclick="printMzsDoc(${m.id})">Печат / PDF</button>` : ''}
     <button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveMzs(${m ? m.id : 'null'})">Запиши</button>`);
  // Сивите състояния не се избират с мишката — правилото остава в обработчика.
  for (const o of document.querySelectorAll('#mzsF [name=status] option')) {
    if (/не следва от/.test(o.textContent)) /** @type {HTMLOptionElement} */ (o).disabled = true;
  }
  const nf = $('#mzsF [name=no]');
  if (nf && !m) { nf.dataset.auto = '1'; nf.dataset.year = y; nf.dataset.proposed = String(no); }
  mzsDirToggle();
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
    <b>${inc ? 'Заявен документ' : 'Търсен документ'}:</b> ${esc(authorTitleText(m.author, m.title))}${m.isbn ? ' · ISBN/ISSN ' + esc(m.isbn) : ''}<br>
    ${m.requester || m.reader_name ? `<b>${inc ? 'Читател при заявяващата библиотека' : 'Заявител (читател)'}:</b> `
      + esc(m.requester || (m.reader_name + (m.reader_card ? ' (карта ' + m.reader_card + ')' : ''))) + '<br>' : ''}
    ${m.book_inv != null ? `<b>Наш документ:</b> инв. № ${esc(m.book_inv)}<br>` : ''}
    <b>Статус:</b> ${esc(m.status)}${m.due_date ? ' · срок за връщане ' + bg(m.due_date) : ''}
    ${[['изпратено', m.date_sent], ['получено', m.date_received], ['върнато', m.date_returned]].filter(x => x[1])
      .map(x => ' · ' + x[0] + ' на ' + bg(x[1])).join('')}
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
  /* К8: предложеният № е за годината, с която формата е отворена. Ако датата е
     сменена към друга година, а onchange не е стигнал (бързо „Запиши“), номерът
     се пресмята тук — стига библиотекарката да не го е писала на ръка. */
  const nf = $('#mzsF [name=no]');
  if (!id && nf && nf.dataset.auto === '1' && d.date && yr(d.date) !== nf.dataset.year
    && String(d.no) === nf.dataset.proposed) {
    const n = await call(window.api.mzs.nextNo(yr(d.date)));
    if (n == null) return;
    d.no = n; nf.value = n; nf.dataset.year = yr(d.date); nf.dataset.proposed = String(n);
    toast('Номерът е сменен на ' + n + '/' + yr(d.date) + ' — следващият свободен за годината на датата.', 'ok');
  }
  // Полетата за връзка се пращат само за своята посока — другото остава празно.
  if (d.direction === 'входящо') d.reader_card = ''; else if (d.direction) d.book_code = '';
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
/* ВЪПРОСЪТ ПРИ ИЗТРИВАНЕ НАЗОВАВА ДОКУМЕНТА И ПОСЛЕДИЦАТА (v2.4.71, кръг 45, М10).
   (а) Дотук и за заявка „изпратено“ въпросът беше само „Изтриване на
       заявката?“. А изтриването на входяща заявка, по която НАШ документ е при
       партньора, сваля единственото, което го държи „зает“: тестерът изтри
       заявка за „Железният светилник“ (инв. № 5) и книгата веднага стана
       „налична“ — и в katalog.json, и на гишето, — макар да е в чуждата
       библиотека. При изходяща „получено“ изчезва срокът на чуждата книга,
       която стои у наш читател, и просрочието ѝ вече не се следи никъде.
   (б) Читател идва за книга, която сайтът обещава, а тя е в друг град; гишето
       я „заема“ по инв. №, без да я има. Регистърът по МЗС е и единственото
       доказателство, че документът от фонда е тръгнал навън — без него при
       инвентаризацията той е просто „липсващ“.
   (в) Правилото („при партньора → не се заема, зает онлайн“) живее в
       обработчика (mzsBlockForBook, touchesCatalog в handlers/mzs.js); екранът
       само казва ПРЕДИ изтриването какво ще се случи — с номера, заглавието,
       инв. № и партньора, — и предлага правилния път: „върнато“, когато
       книгата се върне. Текстът се сглобява от реда, който формата вече
       показва (window._MZS_ROWS), без нова обиколка по IPC. */
function mzsDeleteQuestion(m) {
  if (!m) return 'Изтриване на заявката?';
  const ref = 'заявка № ' + m.no + '/' + m.year;
  const doc = '„' + authorTitleText(m.author, m.title) + '“';
  const away = m.status === 'изпратено' || m.status === 'получено';
  if (m.direction === 'входящо' && away && m.book_id != null) {
    return 'Изтриване на ' + ref + ' — документът е при партньора\n\n'
      + 'Нашият документ' + (m.book_inv != null ? ' инв. № ' + m.book_inv : '') + ' ' + doc + ' е „' + m.status
      + '“ по тази заявка и физически е при ' + m.partner + '. Ако изтриете заявката, книгата ще стане налична '
      + 'в каталога и на гишето, макар да е при партньора — читател може да я запази онлайн, а гишето ще я заеме, '
      + 'без да я има.\n\nКогато книгата се върне, отбележете заявката „върнато“ вместо да я изтривате. '
      + 'Изтриване въпреки това?';
  }
  if (m.direction === 'изходящо' && m.status === 'получено') {
    const who = m.reader_name ? ' у читателя ' + m.reader_name + (m.reader_card ? ' (карта ' + m.reader_card + ')' : '') : '';
    return 'Изтриване на ' + ref + ' — чуждата книга още не е върната\n\n'
      + 'Книгата ' + doc + ' от ' + m.partner + ' е получена по тази заявка' + (who ? ' и е' + who : '')
      + (m.due_date ? ', срок за връщане ' + bg(m.due_date) : '') + '. Ако изтриете заявката, срокът ѝ вече няма да '
      + 'се следи — нито в регистъра, нито на таблото, — а задължението към партньора остава.\n\n'
      + 'Когато книгата бъде върната на партньора, отбележете заявката „върнато“ вместо да я изтривате. '
      + 'Изтриване въпреки това?';
  }
  return 'Изтриване на ' + ref + ' за ' + doc + ' (' + m.direction + ', ' + m.partner + ')?';
}
window.mzsDeleteQuestion = mzsDeleteQuestion;
async function delMzs(id) {
  const m = (window._MZS_ROWS || []).find(x => x.id === id);
  if (!await askConfirm(mzsDeleteQuestion(m))) return;
  // Одит v2.4.16: резултатът не се проверяваше — при провал излизаха ДВЕ
  // съобщения („database is locked“ и „Изтрито.“), а редът си оставаше в
  // регистъра. Всички съседни изтривания го правят правилно.
  const ok = await call(window.api.mzs.delete(id), 'Изтрито.');
  if (ok === null) return;
  closeModal(); renderMzs(); markSaved();
}
window.delMzs = delMzs;
