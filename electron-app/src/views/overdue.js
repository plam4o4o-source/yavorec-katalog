/* ---------------- Просрочени ----------------
   Прозоречен рендер (v2.3.1) по общия модел от core.js (paintRowWindow/
   RENDER_PAGE_SIZE), както в „Книги“, „Читатели“ и „Инвентарна книга“.

   ЗАЩО точно тук: това е списъкът, който расте най-бързо и по нищо не се
   ограничава сам — просрочените заемания се трупат, докато книгите не се върнат,
   а част от тях не се връщат никога. Измерено на действащия обем (jsdom върху
   истинския изглед, 1 200 просрочени): 1 200 изчертани реда и 513 КБ разметка в
   #view. При това всеки ред носи два бутона („Приеми“/„Продължи“), тоест 2 400
   контрола наведнъж, а библиотекарят на гишето гледа първите десетина.

   Дните забава и обезщетението идват ГОТОВИ от loans:overdue (v2.3.0) — смятат се
   със същата функция, с която се начисляват на гишето (цели дни, минус затворените
   от календара). Дотогава екранът ги смяташе сам, по сурови календарни дни, затова
   жълтата бележка по чл. 43, ал. 2 искаше повече, отколкото касата после начисляваше
   и отколкото искаше напомнителното писмо. Затова тук НЕ се смята нищо — и
   прозоречният рендер не променя това: „Общо дължимо обезщетение“ се събира от
   ЦЕЛИЯ списък, не от видимата порция, защото това е сумата, която библиотеката
   има да събира, а не сумата на екрана. */
const OVER_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let OVER_RENDER_LIMIT = OVER_PAGE_SIZE;
let OVER_PAINTED = 0;
function overRowsHtml(rows) {
  return rows.length ? rows.map(l => {
    const days = Number(l.daysLate) || 0;
    return `<tr><td>${esc(l.reader_name)}</td><td class="num">${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
        <td class="num nowrap">${bg(l.date_due)}</td><td class="num warn">${days}</td><td class="num">${mnyCell(Number(l.fine) || 0)}</td>
        <td><button class="btn sm" onclick="returnBook(${l.id})">Приеми</button>
            <button class="btn sm" onclick="extendLoan(${l.id})">Продължи</button>
            ${/* v2.4.56: точно на този екран стоят заеманията, които никога няма да
                  се върнат — просрочие от година и половина не е „забава“, а изгубен
                  документ. Дотук библиотекарката нямаше какво да натисне освен
                  „Приеми“, тоест да излъже регистъра, че книгата е на рафта. */''}
            <button class="btn sm" onclick="lostLoanDialog(${l.id})"
              title="Документът не е върнат от читателя — приключване с обезщетение или замяна">Изгубена</button></td></tr>`;
  }).join('') : `<tr><td colspan="7" class="empty">Няма просрочени заемания.</td></tr>`;
}
/* Броячът стои В ЛЕНТАТА под таблицата, а не горе при бутоните — така се
   пририсува от самия paintRowWindow при всяко „Покажи още“ и не може да остане
   да твърди нещо, което вече не е вярно. И казва „показани са N от M“, а не
   само общия брой: скъсен списък, който изглежда пълен, подвежда най-много. */
function overMoreHtml(more, total) {
  const shown = total - more;
  return `<span class="hint">Показани са ${shown} от ${total} просрочени заемания.</span>`
    + (more > 0 ? ` <button class="btn" onclick="OVER_RENDER_LIMIT+=${OVER_PAGE_SIZE};paintOverRows(true)">Покажи още (${more} от общо ${total})</button>` : '');
}
/* append=true (само от бутона „Покажи още“) ДОБАВЯ единствено новата порция —
   без да пририсува вече показаните редове (виж paintRowWindow в core.js: там е
   измерено защо презаписването на целия <tbody> прави разгръщането квадратично).
   Всяко друго извикване е пълен рендер: след „Приеми“/„Продължи“ наборът редове
   е ДРУГ и добавяне би долепило нови редове към стар резултат. */
function paintOverRows(append) {
  OVER_PAINTED = paintRowWindow({
    body: '#ovBody', bar: '#ovMore', rows: window._OVERDUE_LIST || [], limit: OVER_RENDER_LIMIT,
    painted: append ? OVER_PAINTED : 0,
    rowsHtml: overRowsHtml, moreHtml: overMoreHtml
  });
}
window.paintOverRows = paintOverRows;
/* keepWindow=true идва от „Приеми"/„Продължи" (views/loans.js и housebound.js):
   там наборът е почти същият — един ред по-малко — и разгърнатият списък трябва да
   остане разгърнат. Библиотека с над 300 просрочени иначе трябваше да разгръща наново
   след ВСЯКО прието връщане, тоест след основното действие на този екран.
   Без аргумент (влизане в раздела от менюто) прозорецът се връща на първата порция —
   иначе разделът би се отварял с хиляди реда завинаги. Същото разделение като при
   „Книги", където renderBooks() пази прозореца, а търсенето/филтърът го нулират. */
async function renderOver(keepWindow) {
  const rows = await call(window.api.loans.overdue());
  if (!rows) return;
  window._OVERDUE_LIST = rows;
  const total = rows.reduce((sum, l) => sum + (Number(l.fine) || 0), 0);
  /* Празното място за изгубените се добавя И В ДВЕТЕ разклонения (v2.4.56).
     Библиотека без нито едно просрочено заемане пак може да има невърнати
     документи, чакащи акт по чл. 30, т. 5 — те са приключени заемания и по
     построение вече НЕ са просрочени. Ако панелът висеше само на непразния
     списък, щеше да изчезне точно в деня, в който всичко останало е наред. */
  if (!rows.length) {
    $('#view').innerHTML = '<div class="empty"><h3>Няма просрочени заемания</h3><p>Всички заети документи са в срок.</p></div>'
      + '<div id="ovLost"></div>';
    paintLostPanel();
    return;
  }
  if (!keepWindow) OVER_RENDER_LIMIT = OVER_PAGE_SIZE;
  // Ако списъкът се е скъсил (приети връщания), прозорецът не бива да остава по-широк
  // от самия набор — иначе броячът би обещавал редове, които вече ги няма.
  if (OVER_RENDER_LIMIT > rows.length) OVER_RENDER_LIMIT = Math.max(OVER_PAGE_SIZE, rows.length);
  $('#view').innerHTML = `
    <div class="note w"><b>Чл. 43, ал. 2 и чл. 49, ал. 1, т. 3</b> — библиотекарят следи сроковете при забава.
    Общо дължимо обезщетение: <b>${mny(total)}</b></div>
    <div class="toolbar">
      <button class="btn pri" onclick="openReminders()">Напомняния (имейл и SMS)</button>
      <button class="btn" onclick="printOverdueNotices()">Печат на напомняния / PDF</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Читател</th><th>Инв. №</th><th>Заглавие</th>
      <th>Срок</th><th>Дни</th><th>Обезщетение</th><th style="width:260px"></th></tr></thead>
      <tbody id="ovBody"></tbody></table></div>
    <div class="toolbar" id="ovMore" style="justify-content:center"></div>
    <div id="ovLost"></div>`;
  // Тялото се пълни оттук, а не направо в шаблона, за да има ЕДНО място, което
  // знае колко реда стоят вътре (OVER_PAINTED); иначе следващото „Покажи още“
  // би добавяло към брой, който никой не е сверявал със самия DOM.
  paintOverRows(false);
  paintLostPanel();
}

/* ---------------- Изгубени и невърнати документи (v2.4.56) ----------------
   КАКВО СТАВАШЕ ДОТУК. Приключеното като изгубено заемане изчезваше от погледа:
   то вече не е просрочено (редът е затворен), а актът по чл. 30, т. 5 се съставя
   седмици или месеци по-късно. Библиотекарката трябваше да помни кои документи
   чакат отчисляване — и, още по-лошо, дали по тях изобщо е начислено обезщетение
   и дали е събрано. Нито един екран не отговаряше на този въпрос.

   ЗАЩО Е ТУК, А НЕ В „ОТЧИСЛЯВАНЕ“. Списъкът се пълни от гишето — оттук
   започва случаят и тук библиотекарката гледа всеки ден. Панелът само сочи към
   „Отчисляване“, където актът наистина се съставя от комисия; самият акт не се
   прави оттук, защото чл. 35 иска комисия и утвърждаване, не едно натискане.

   ЧЕТЕНЕТО Е ОТДЕЛНО ОТ ОСНОВНИЯ СПИСЪК (свой IPC канал, свое пълнене след
   изчертаването на страницата) по същата причина, по която „Днес на гишето“ в
   „Заемане и връщане“ е така: основната таблица не бива да чака втора заявка,
   а при над 300 просрочени тя е и по-скъпата. */
async function paintLostPanel() {
  const box = $('#ovLost'); if (!box) return;
  const rows = await call(window.api.loans.lost()) || [];
  if (!$('#ovLost')) return; // междувременно е сменен разделът
  if (!rows.length) { box.innerHTML = ''; return; }
  const charged = rows.reduce((s, r) => s + (r.charge ? Number(r.charge.charged) || 0 : 0), 0);
  const due = rows.reduce((s, r) => s + (r.charge ? Number(r.charge.outstanding) || 0 : 0), 0);
  box.innerHTML = `<div class="card" style="margin-top:18px"><h3 style="margin-top:0">Изгубени и невърнати документи</h3>
    <div class="note w" style="margin-top:0">Тези документи са приключени като невърнати от читател и
      <b>подлежат на отчисляване с акт по чл. 30, т. 5</b> (повредени или невърнати от ползватели) —
      актът се съставя от раздел „Отчисляване“.
      ${charged ? `Начислено обезщетение общо <b>${mny(charged)}</b>, от които
        <b>${due ? 'несъбрани ' + mny(due) : 'събрани всички'}</b>.` : ''}</div>
    <div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
      <th>Инв. №</th><th>Заглавие</th><th>Читател</th><th>Отбелязан</th><th>Уреждане</th>
      <th>Обезщетение</th><th>Събрано</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td class="num">${r.inv_number ?? ''}</td>
        <td>${esc(r.title)}</td>
        <td>${esc(r.reader_name)}${r.card_no ? ' <span class="hint">(' + esc(r.card_no) + ')</span>' : ''}</td>
        <td class="num nowrap">${bg(r.lost_date)}</td>
        <td>${esc(r.lost_resolution || '—')}${r.replacement_inv_number != null
          ? '<div class="hint">прието: инв. № ' + esc(String(r.replacement_inv_number)) + ' — ' + esc(r.replacement_title || '') + '</div>'
          : (r.lost_replacement_note ? '<div class="hint">прието: ' + esc(r.lost_replacement_note) + '</div>' : '')}</td>
        <td class="num">${r.charge ? mnyCell(r.charge.charged) : '—'}</td>
        ${/* Трите състояния са РАЗЛИЧНИ и не бива да се сливат в едно число:
              „няма начисление“ (замяна с документ — пари не се дължат),
              „начислението е изтрито от картона“ (някой го е махнал — това не е
              нула, а липсваща следа) и същинското „събрано/остава“. Нула на
              мястото на първите две би значела „платено докрай“. */''}
        <td class="num">${r.chargeMissing
          ? '<span class="badge warn">начислението е изтрито</span>'
          : r.charge
            ? (r.charge.outstanding > 0
              ? '<span class="badge warn">остават ' + esc(mny(r.charge.outstanding)) + '</span>'
              : '<span class="badge ok">събрано</span>')
            : '<span class="hint">замяна с документ</span>'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
window.paintLostPanel = paintLostPanel;
