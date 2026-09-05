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
            <button class="btn sm" onclick="extendLoan(${l.id})">Продължи</button></td></tr>`;
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
  if (!rows.length) { $('#view').innerHTML = '<div class="empty"><h3>Няма просрочени заемания</h3><p>Всички заети документи са в срок.</p></div>'; return; }
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
      <th>Срок</th><th>Дни</th><th>Обезщетение</th><th style="width:180px"></th></tr></thead>
      <tbody id="ovBody"></tbody></table></div>
    <div class="toolbar" id="ovMore" style="justify-content:center"></div>`;
  // Тялото се пълни оттук, а не направо в шаблона, за да има ЕДНО място, което
  // знае колко реда стоят вътре (OVER_PAINTED); иначе следващото „Покажи още“
  // би добавяло към брой, който никой не е сверявал със самия DOM.
  paintOverRows(false);
}
