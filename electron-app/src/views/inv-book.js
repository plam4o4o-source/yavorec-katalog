/* ---------------- Инвентарна книга ----------------
   Прозоречен рендер и забавено търсене — по същия модел като „Книги“ и
   „Читатели“ (BOOKS_PAGE_SIZE/BOOKS_RENDER_LIMIT). Измерено в истински
   Chromium при фонд от 15 000 записа, ПРЕДИ тази промяна: първото
   изчертаване 1272 ms и 7 МБ HTML в таблицата, а полето за търсене
   пререндираше пълния списък при ВСЯКО натискане на клавиш — писането на
   осем знака отнемаше 2298 ms блокиран интерфейс (~287 ms на знак), тоест
   при голям фонд писането видимо накъсва.

   Затова: в таблицата се чертаят най-много INVBOOK_PAGE_SIZE реда наведнъж
   (бутон „Покажи още“ за следващите), а търсенето е с debounce 300 ms.
   Двете тежести са различни и се лекуват отделно — debounce намалява БРОЯ
   изчертавания, ограничението намалява ЦЕНАТА на едно изчертаване.

   Търсенето пипа само <tbody> и лентата под таблицата, а НЕ цялото #view:
   така полето за търсене не се пресъздава и курсорът остава в него, докато
   библиотекарят пише. Печатът (printInvBookDoc) продължава да ползва целия
   списък от window._INVBOOK_ROWS — разпечатката е меродавният документ по
   чл. 26 и не бива да зависи от това какво се вижда на екрана. */
const INVBOOK_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE;
/* v2.4.31 (производителност): порциите идват от БАЗАТА (invBook:list с
   { q, offset, limit } → { rows, total, summary }), не от пълния списък в
   паметта — при 15 000 документа пълният регистър е 5,5 МБ и ~100 ms в SQLite
   при всяко отваряне на раздела, а на екрана стоят 300 реда. Ако обработчикът
   върне масив (стар обработчик, тестов заместител), изгледът работи както
   досега — целият списък в паметта, търсене и „Покажи още“ без IPC. */
let INVBOOK_WINDOWED = false;
let INVBOOK_TOTAL = 0;
let INVBOOK_SUMMARY = null;
let INVBOOK_REQ = 0; // пореден номер на ПЪЛНОТО зареждане — закъснял отговор на старо търсене не се рисува
let INVBOOK_GEN = 0; // поколение на списъка в паметта — „Покажи още“ долепя само към същия списък
/* КОЛОНАТА „ПРОВЕРКИ“ НЕ РАСТЕ БЕЗ КРАЙ (v2.4.61).
   ===========================================================================
   ДОТУК клетката изреждаше ВСЯКА отметка от inventory_checks — по една на
   всяка инвентаризация, при която документът е бил сканиран. Инвентаризация се
   прави поне веднъж годишно (чл. 40), а библиотеката, за която е писана
   програмата, работи от 1922 г.; при две проверки годишно за двайсет години
   това са четирийсет дати в една клетка на Приложение № 4. На екрана редът
   става висок колкото половин таблица; на хартия — колоната изяжда листа, а
   останалите единайсет колони на Приложение № 4 се смачкват до нечетливост.

   ЗАЩО ИМЕННО ПОСЛЕДНИТЕ. Въпросът, който тази колона съществува да отговори,
   е „кога документът е видян за последно“ — точно него задава и проверяващият.
   По-старите отметки не изчезват от базата и се виждат в картона на документа;
   тук се показват последните INVBOOK_CHECKS_SHOWN и се КАЗВА колко са всичко,
   вместо мълчаливо да се отрежат (същото правило като при читателския картон и
   при „Показани са N от M“ в Просрочени — срязване без надпис е по-лошо от
   срязване). Подредбата идва подредена по дата от handlers/inv-book.js. */
const INVBOOK_CHECKS_SHOWN = 3;
/* Последните отметки + общият им брой, като списък от вече форматирани дати. */
function invBookChecksShown(checks) {
  const all = checks || [];
  return { dates: all.slice(-INVBOOK_CHECKS_SHOWN).map(c => bg(c)), total: all.length };
}
/* За разпечатката — обикновен текст. */
function invBookChecksText(checks) {
  const c = invBookChecksShown(checks);
  if (!c.total) return '';
  return c.dates.join(' ') + (c.total > c.dates.length ? ' (общо ' + c.total + ')' : '');
}
/* Показателите над таблицата от пълен списък в паметта (старият път). */
function invBookSummaryOf(rows) {
  const active = rows.filter(r => r.status !== 'отчислен');
  /* Броят и стойността са по ЕКЗЕМПЛЯРИ, както в КДБФ и в Таблото — иначе
     „Налични: N · стойност" под инвентарната книга противоречи на същите две
     числа на другите два екрана. Самата таблица си остава по редове: един ред =
     един инвентарен номер, точно както е в Приложение № 4. */
  const qtyOf = (r) => (r.quantity == null ? 1 : Number(r.quantity) || 0);
  /* Същото броене като в handlers/inv-book.js (UNDATED_ACTIVE) — двата пътя
     (пълен списък в паметта и порции от базата) трябва да дават едно и също
     число, иначе бележката под главата казва различно нещо според това дали
     изгледът е в прозоречен режим. */
  const undated = active.filter(r => !r.register_date);
  return {
    rows: rows.length, activeRows: active.length,
    activeCopies: active.reduce((s, r) => s + qtyOf(r), 0),
    value: active.reduce((s, r) => s + (r.price || 0) * qtyOf(r), 0),
    deacc: rows.length - active.length,
    checked: rows.filter(r => (r.checks || []).length).length,
    undatedRows: undated.length,
    undatedCopies: undated.reduce((s, r) => s + qtyOf(r), 0)
  };
}
/* ---- Бележка: инвентарната книга брои различно от КДБФ (одит v2.4.56) --------
   Инвентарната книга смята фонда по СЪСТОЯНИЕТО (всичко, което не е отчислено),
   а КДБФ — по ДАТИТЕ (дата на вписване до 31.12 и дата на отчисляване). Документ
   без попълнена дата на вписване влиза в първото число и изпада от второто.
   Дотук КДБФ го обявяваше (kdbfUndatedNote в src/views/kdbf.js), а инвентарната
   книга — не: и на екрана, и в разпечатката стоеше само „Фонд по инвентарната
   книга: N документа“. Библиотекар, който сравнява двата екрана преди годишния
   отчет, виждаше две различни числа за един и същ фонд без нито дума защо; при
   проверка същото разминаване изглежда като сгрешена справка. Числото не се
   променя — казва се. Текстът е един и същ на екрана и на разпечатката, за да не
   се окаже, че отпечатаният документ обяснява по-малко от екрана. */
function invBookUndatedNote(sum) {
  const s = sum || {};
  const rowsN = s.undatedRows || 0;
  if (!rowsN) return '';
  const copies = s.undatedCopies || rowsN;
  const doc = (n) => n + (n === 1 ? ' документ' : ' документа');
  return `<b>Внимание — ${rowsN === 1 ? 'един запис няма' : rowsN + ' записа нямат'} попълнена дата на вписване.</b>
    Фондът тук се брои по състоянието на записа, а „Книга за движение на библиотечния фонд“ (КДБФ) и годишният
    отчет — по датата на вписване и датата на отчисляване. Затова ${doc(copies)} от числото по-горе
    ${copies === 1 ? 'не участва' : 'не участват'} в КДБФ нито като постъпление за някоя година, нито в наличността
    към 31.12 — двете справки ще покажат различен фонд точно с това число, докато датите не бъдат попълнени.
    Поправя се в „Редакция“ на записа → полето „Дата на вписване“.`;
}
window.invBookUndatedNote = invBookUndatedNote;
async function invBookFetch(offset, limit, withSummary) {
  const res = await call(window.api.invBook.list({ q: INVBOOK_QUERY, offset,
    limit: Math.min(limit || INVBOOK_PAGE_SIZE, 2000), summary: !!withSummary }));
  if (!res) return null;
  if (Array.isArray(res)) { INVBOOK_WINDOWED = false; return { all: res }; }
  INVBOOK_WINDOWED = true;
  return res;
}
async function renderInvBook() {
  ++INVBOOK_REQ; // пълният рендер не се отказва при по-нова заявка (виж renderBooks)
  const res = await invBookFetch(0, INVBOOK_RENDER_LIMIT, true);
  if (!res) return;
  INVBOOK_GEN++;
  const rows = res.all || res.rows;
  const sum = res.all ? invBookSummaryOf(res.all) : res.summary;
  INVBOOK_TOTAL = res.all ? res.all.length : res.total;
  INVBOOK_SUMMARY = sum;
  const activeCopies = sum.activeCopies, value = sum.value, deacc = sum.deacc, checked = sum.checked;
  const active = { length: sum.activeRows == null ? sum.rows - sum.deacc : sum.activeRows };
  $('#view').innerHTML = `
    <div class="note"><b>Приложение № 4 към чл. 16, ал. 1</b> — колоните следват образеца от Наредба № 3.
    Книгата се съхранява безсрочно (чл. 26, ал. 1). Отчислените документи се отбелязват, но не се заличават (чл. 39).</div>
    ${invBookUndatedNote(sum) ? `<div class="note w">${invBookUndatedNote(sum)}</div>` : ''}

    <div class="kpis" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi-ico">${KPI_ICONS.fund}</div><div class="kpi-body">
        <div class="kpi-num">${sum.rows.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Вписани общо</div>
        <div class="kpi-extra">от началото на книгата</div></div></div>
      <div class="kpi ok"><div class="kpi-ico">${KPI_ICONS.check}</div><div class="kpi-body">
        <div class="kpi-num">${activeCopies.toLocaleString('bg-BG')}</div>
        ${/* „Неотчислени“, не „Налични“ — в сбора влизат и документите със
              състояние „липсващ“ и „за реставрация“ (същото броене като stockAt()
              в КДБФ). Виж същата поправка в разпечатката по-долу. */''}
        <div class="kpi-lbl">Неотчислени</div><div class="kpi-extra">${mny(value)}${
          activeCopies > active.length ? ' · ' + active.length.toLocaleString('bg-BG') + ' инв. номера' : ''
        }</div></div></div>
      <div class="kpi ${deacc ? 'warn' : ''}"><div class="kpi-ico">${KPI_ICONS.deacc}</div><div class="kpi-body">
        <div class="kpi-num">${deacc.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Отчислени</div>
        <div class="kpi-extra">${sum.rows ? Math.round(deacc / sum.rows * 100) : 0}% от вписаните</div></div></div>
      <div class="kpi"><div class="kpi-ico">${KPI_ICONS.search}</div><div class="kpi-body">
        <div class="kpi-num">${checked.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">С отбелязана проверка</div>
        <div class="kpi-extra">чл. 40 – 41</div></div></div>
    </div>

    <div class="toolbar">
      <input type="search" id="ibSearch" placeholder="Търсене по инв. №, автор, заглавие или сигнатура…"
        value="${esc(INVBOOK_QUERY)}">
      <button class="btn pri" onclick="bookForm()">+ Нов документ</button>
      ${/* Одит v2.4.56: копчето вече не праща направо на принтера цялата книга
            (виж invBookPrintDialog по-долу) — пита какъв диапазон да отпечата. */''}
      <button class="btn" onclick="invBookPrintDialog()">Печат на инвентарната книга / PDF</button>
    </div>
    <div class="wrap"><table class="ledger ibTable">
      <thead><tr><th class="nowrap">Дата</th><th class="nowrap">Инв. №</th><th>Проверки</th><th>Автор и заглавие</th><th>Год.</th><th>Цена</th>
        <th>№ / дата<br>в КДБФ</th><th>Сигнатура</th><th>№ / дата<br>на акт</th><th>Състояние</th><th style="width:90px"></th></tr></thead>
      <tbody id="ibBody"></tbody>
    </table></div>
    <div class="toolbar" id="ibMore" style="justify-content:center"></div>`;
  window._INVBOOK_ROWS = rows;
  INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE;
  paintInvBookRows();
  $('#ibSearch').addEventListener('input', debounce(e => {
    INVBOOK_QUERY = e.target.value;
    INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE; // ново търсене — пак от първата страница
    if (INVBOOK_WINDOWED) invBookReload(); else paintInvBookRows();
  }, 300));
}
/* Прозоречен режим: ново търсене — първата порция наново от базата; „Покажи още“ —
   следващата порция, долепена към вече заредените.
   Показателите над таблицата НЕ се искат тук (проверка при прегледа): те са по
   ЦЕЛИЯ регистър, без търсенето (виж бележката в handlers/inv-book.js) — не се
   менят с всяко търсене, но при offset 0 сървърът иначе пак плащаше двете сборни
   заявки при всяка пауза при писане (debounce 300 ms), само за да ги изхвърли тук. */
async function invBookReload() {
  const req = ++INVBOOK_REQ;
  const res = await invBookFetch(0, INVBOOK_RENDER_LIMIT);
  if (!res || req !== INVBOOK_REQ) return;
  window._INVBOOK_ROWS = res.all || res.rows;
  INVBOOK_GEN++;
  INVBOOK_TOTAL = res.all ? res.all.length : res.total;
  paintInvBookRows();
}
window.invBookReload = invBookReload;
let INVBOOK_MORE_PENDING = false;
async function invBookMore() {
  if (!INVBOOK_WINDOWED) { INVBOOK_RENDER_LIMIT += INVBOOK_PAGE_SIZE; paintInvBookRows(true); return; }
  // Предпазител срещу двоен клик — виж идентичната бележка при booksMore() в books.js.
  if (INVBOOK_MORE_PENDING) return;
  INVBOOK_MORE_PENDING = true;
  try {
    const gen = INVBOOK_GEN;
    const loaded = (window._INVBOOK_ROWS || []).length;
    const res = await invBookFetch(loaded, INVBOOK_PAGE_SIZE);
    if (!res || gen !== INVBOOK_GEN) return; // междувременно търсене е подменило списъка
    window._INVBOOK_ROWS = (window._INVBOOK_ROWS || []).concat(res.all ? res.all.slice(loaded) : res.rows);
    INVBOOK_TOTAL = res.all ? res.all.length : res.total;
    INVBOOK_RENDER_LIMIT = window._INVBOOK_ROWS.length;
    paintInvBookRows(true);
  } finally {
    INVBOOK_MORE_PENDING = false;
  }
}
window.invBookMore = invBookMore;
let INVBOOK_QUERY = '';
function invBookRowsHtml(rows) {
  if (!rows.length) return `<tr><td colspan="11" class="empty">Инвентарната книга е празна.</td></tr>`;
  return rows.map(r => {
    const off = r.status === 'отчислен';
    return `<tr class="${off ? 'ibOff' : ''}" data-id="${r.id}">
      <td class="num">${bg(r.register_date)}</td>
      <td class="num"><b>${r.inv_number ?? ''}</b></td>
      <td style="font-size:11px">${(() => {
        const c = invBookChecksShown(r.checks);
        return c.dates.map(d => `<span class="badge ok" style="font-size:10px">${d}</span>`).join(' ')
          + (c.total > c.dates.length
            ? ` <span class="hint" title="Показани са последните ${INVBOOK_CHECKS_SHOWN} отметки от ${c.total}">(общо ${c.total})</span>` : '');
      })()}</td>
      <td>${esc([r.author, r.title].filter(Boolean).join('. '))}${r.volume ? ', т. ' + esc(r.volume) : ''}</td>
      <td class="num">${esc(r.year || '')}</td><td class="num">${mnyCell(r.price)}</td>
      <td class="num" style="font-size:11px">${r.acq_no ? '№ ' + r.acq_no + '<br>' + bg(r.acq_date) : ''}</td>
      <td class="num">${esc(r.call_number || '')}</td>
      <td class="num" style="font-size:11px">${r.act_no ? '№ ' + r.act_no + '<br>' + bg(r.act_date) : ''}</td>
      ${/* Одит v2.4.25: значката различаваше само „отчислен“ и всичко останало —
            липсващ от инвентаризация стоеше в регистъра със зелено „наличен“.
            Разпечатката печата r.status от v2.4.17 („Неотчислен ≠ наличен“). */''}
      <td>${off ? '<span class="badge warn">отчислен</span>'
        : (!r.status || r.status === 'наличен') ? '<span class="badge ok">наличен</span>'
        : `<span class="badge warn">${esc(r.status)}</span>`}</td>
      <td><button class="btn sm" onclick="invBookEdit(${r.id})">Редакция</button></td>
    </tr>`;
  }).join('');
}
/* Редакция на запис — САМО оттук (v1.71.0, по изрично искане): инвентарната
   книга е официалният регистър на фонда по Наредба № 3, затова преди
   отваряне на формата се иска изрично потвърждение. Списъкът „Книги“ вече
   няма бутон „Редакция“ на ред — там остават търсене/филтри/групова
   редакция/нов документ. */
/* ПОТВЪРЖДЕНИЕТО ТРЯБВА ДА НАЗОВАВА ДОКУМЕНТА И КОГАТО СЕ ВИКА ОТВЪН
   (v2.4.65, кръг 42, находка Б11).
   Дотук редът се търсеше единствено в `window._INVBOOK_ROWS` — списъка, който
   съществува само след като екранът „Инвентарна книга“ е бил отворен. От
   v2.4.65 същото потвърждение се иска и от Таблото (сканирането с баркод четец),
   където този списък по правило е празен: въпросът щеше да гласи „този запис
   (инв. № —)“, тоест библиотекарката трябваше да потвърди редакция на документ,
   който програмата не назовава. Затова, ако редът го няма в паметта, картонът
   се изтегля от базата — едно четене на един ред, срещу въпрос, на който човекът
   може да отговори. Ако и това не успее, въпросът се задава както досега, със
   „този запис“: потвърждението не бива да ОТПАДА заради неуспяло четене. */
async function invBookEdit(id) {
  let r = (window._INVBOOK_ROWS || []).find(x => x.id === id);
  if (!r) r = (await call(window.api.books.get(id))) || {};
  const what = [r.author, r.title].filter(Boolean).join('. ') || 'този запис';
  if (!await askConfirm('РЕДАКЦИЯ НА ЗАПИС В ИНВЕНТАРНАТА КНИГА\n\n'
    + '„' + what + '“ (инв. № ' + (r.inv_number ?? '—') + ')\n\n'
    + 'Инвентарната книга е официалният регистър на библиотечния фонд по '
    + 'Наредба № 3 — тя се съхранява безсрочно и промените в записа важат '
    + 'веднага навсякъде в програмата и в онлайн каталога.\n\n'
    + 'Да продължа ли към редакция?', { kind: 'ask', okLabel: 'Към редакцията' })) return;
  bookForm(id);
}
window.invBookEdit = invBookEdit;
/* Редовете, които отговарят на текущото търсене (без ограничението за рендер). */
function invBookMatches() {
  const t = INVBOOK_QUERY.trim().toLowerCase();
  const all = window._INVBOOK_ROWS || [];
  if (!t) return all;
  return all.filter(r =>
    String(r.inv_number ?? '').includes(t) ||
    (r.author || '').toLowerCase().includes(t) ||
    (r.title || '').toLowerCase().includes(t) ||
    (r.call_number || '').toLowerCase().includes(t));
}
/* Изчертава само таблицата и лентата под нея — полето за търсене не се пипа. */
/* v2.3.0: append=true (само от бутона „Покажи още“) добавя САМО новата порция
   през paintRowWindow() в core.js. Дотогава всяко натискане презаписваше целия
   <tbody> с rows.slice(0, LIMIT) — и вече показаните редове се изчертаваха
   наново, тоест работата растеше квадратично. (Числото, което стоеше тук —
   „49 натискания = 127 861 ms“ — беше от jsdom и не описваше истинския прозорец;
   измереното в Chromium и произлизащият от него ТАВАН на общия брой изчертани
   редове са при paintRowWindow/RENDER_MAX_ROWS в core.js.) Търсенето и
   програмното филтриране остават пълен рендер — там наборът от редове е друг. */
let INVBOOK_PAINTED = 0;
function paintInvBookRows(append) {
  /* В прозоречен режим window._INVBOOK_ROWS са само заредените порции (вече
     филтрирани от базата), а общият брой идва отделно; в стария — целият списък,
     филтриран тук. */
  const rows = INVBOOK_WINDOWED ? (window._INVBOOK_ROWS || []) : invBookMatches();
  const total = INVBOOK_WINDOWED ? INVBOOK_TOTAL : rows.length;
  INVBOOK_PAINTED = paintRowWindow({
    body: '#ibBody', bar: '#ibMore', rows, limit: INVBOOK_WINDOWED ? rows.length : INVBOOK_RENDER_LIMIT,
    /* total — за тавана на общия брой изчертани редове (RENDER_MAX_ROWS в
       core.js, v2.4.64): в прозоречен режим `rows` са само изтеглените порции. */
    total,
    painted: append ? INVBOOK_PAINTED : 0,
    rowsHtml: invBookRowsHtml,
    emptyHtml: INVBOOK_QUERY.trim()
      ? `<tr><td colspan="11" class="empty">Няма съвпадения за „${esc(INVBOOK_QUERY)}“.</td></tr>`
      : `<tr><td colspan="11" class="empty">Инвентарната книга е празна.</td></tr>`,
    moreHtml: (moreShown, shownTotal) => {
      const more = INVBOOK_WINDOWED ? total - rows.length : moreShown;
      return more > 0
        ? `<button class="btn" onclick="invBookMore()">Покажи още (${more} от общо ${total})</button>`
        : (total > INVBOOK_PAGE_SIZE
          ? `<span class="hint">Показани са всички ${total} реда. Печатът пита за диапазон — по подразбиране предлага показаното тук.</span>` : '');
    }
  });
}
window.paintInvBookRows = paintInvBookRows;
/* Оставено достъпно и програмно (търсене от друго място): задава търсенето,
   връща се на първата страница и преизчертава. */
function invBookFilter(q) {
  INVBOOK_QUERY = q == null ? '' : String(q);
  INVBOOK_RENDER_LIMIT = INVBOOK_PAGE_SIZE;
  if (INVBOOK_WINDOWED) return invBookReload();
  paintInvBookRows();
}
window.invBookFilter = invBookFilter;
/* ---- Избор на диапазон преди печат (одит v2.4.56) ----------------------------
   Дотук копчето „Печат“ печаташе БЕЗУСЛОВНО цялата книга. При фонд от 15 000
   документа това са към 15 000 реда и стотици листа — а най-честият повод за
   печат е съвсем друг: 200-те нови записа от последната партида, или редовете за
   една година, които трябва да се прошнуроват и заверят. Библиотекарят или
   изчакваше огромна разпечатка, за да извади няколко листа от нея, или (по-често)
   не печаташе изобщо. Затова печатът вече пита какъв диапазон: от – до инвентарен
   номер и/или период на вписване, а по подразбиране предлага това, което е
   филтрирано на екрана. Самата разпечатка НОСИ означението какъв диапазон е
   отпечатан — иначе прошнурован лист с 200 реда е неотличим от фалшива „цяла“
   инвентарна книга, а точно този лист се заверява с подпис по чл. 26, ал. 2.
   „Цялата книга“ остава на едно натискане — поведението не се отнема, само спира
   да е единственото. */
function invBookRowMatchesText(r, t) {
  if (!t) return true;
  return String(r.inv_number ?? '').includes(t)
    || (r.author || '').toLowerCase().includes(t)
    || (r.title || '').toLowerCase().includes(t)
    || (r.call_number || '').toLowerCase().includes(t);
}
/* Връща { rows, label, limited } — редовете за печат, човешкото описание на
   диапазона и дали изобщо е ограничаван. Празно/непопълнено поле не ограничава
   нищо: диапазон „от 1 до празно“ значи „от 1 нататък“, не „нищо“. */
function invBookSelectRange(all, range) {
  const q = range && range.q != null ? String(range.q).trim() : '';
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const date = (v) => { const s = String(v == null ? '' : v).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
  const from = num(range && range.from), to = num(range && range.to);
  const dFrom = date(range && range.dateFrom), dTo = date(range && range.dateTo);
  const parts = [];
  let rows = all;
  if (from != null || to != null) {
    rows = rows.filter(r => {
      const n = r.inv_number == null ? null : Number(r.inv_number);
      if (n == null || !Number.isFinite(n)) return false; // без номер не е в никакъв числов диапазон
      return (from == null || n >= from) && (to == null || n <= to);
    });
    parts.push(from != null && to != null ? `инв. № ${from} – ${to}`
      : from != null ? `инв. № от ${from} нататък` : `инв. № до ${to}`);
  }
  if (dFrom || dTo) {
    rows = rows.filter(r => {
      const d = r.register_date || '';
      if (!d) return false; // без дата на вписване редът не попада в никакъв период
      return (!dFrom || d >= dFrom) && (!dTo || d <= dTo);
    });
    parts.push(dFrom && dTo ? `вписани от ${bg(dFrom)} до ${bg(dTo)} г.`
      : dFrom ? `вписани от ${bg(dFrom)} г. нататък` : `вписани до ${bg(dTo)} г.`);
  }
  if (q) {
    const t = q.toLowerCase();
    rows = rows.filter(r => invBookRowMatchesText(r, t));
    parts.push(`отговарящи на търсенето „${q}“`);
  }
  return { rows, label: parts.join('; '), limited: parts.length > 0 };
}
window.invBookSelectRange = invBookSelectRange;
/* ---- Колко струва „цялата книга“ и защо диалогът вече започва с ГОДИНА -------
   (v2.4.64, измерване в истински Chromium 141 — node /tmp/r41/bench-chromium.js
   и node /tmp/r41/mem-chromium.js, 5 повторения.)

   ИЗМЕРЕНОТО за печатния лист на цялата инвентарна книга при 15 000 вписвания:
     195 035 DOM възела · 3 752 КБ HTML
     140 ms вписване + 2 581 ms оформление = ~2,7 s ЗАМРЪЗНАЛ ПРОЗОРЕЦ
     +792 МБ RSS на рендера
   Тоест ~0,18 ms и ~54 КБ памет на ред. Докато трае, програмата не отговаря на
   нищо — нито на затваряне, нито на Esc; изглежда като увиснала.

   ЗАЩО НЕ СЕ РЕЖЕ НА ПОРЦИИ. Опитано и измерено: същият лист, вписван на порции
   по 500 реда, струва 3 575 ms общо — ПОВЕЧЕ от 2 581 ms наведнъж, защото всяка
   порция кара браузъра да преоформи цялата вече построена таблица. Единственото,
   което порциите печелят, е, че първата се вижда на 98 ms. За документ, който
   излиза на принтер, това не е печалба, а само по-дълго чакане. Затова печатът
   НЕ е нарязан — нарязан беше ПОВОДЪТ: в огромното мнозинство от случаите на
   библиотекаря не му трябва цялата книга, а една година или една партида.

   ЗАТОВА диалогът вече предлага ГОДИНА по подразбиране (текущата — поводът за
   печат почти винаги е заверката на новите вписвания), казва колко реда е цялата
   книга и какво струва тя, а „Цялата книга“ минава през изрично потвърждение с
   тези числа — по същия модел като confirmManyLabels() за етикетите в core.js. */
const INVBOOK_PRINT_MS_PER_ROW = 2700 / 15000;   // 0,18 ms/ред — измерено (виж горе)
const INVBOOK_PRINT_MB_PER_ROW = 792 / 15000;    // 0,053 МБ/ред — измерено (виж горе)
const INVBOOK_PRINT_ROWS_PER_SHEET = 30;         // А4 напряко, при сегашния шрифт на листа
/* Праг, над който „Цялата книга“ пита. 1 000 реда са ~33 листа и ~0,2 s —
   под това число въпросът би бил само пречка; над него започва и хартията, и
   замръзването. Числото е едно, на едно място, както LABEL_CONFIRM_OVER. */
const INVBOOK_PRINT_CONFIRM_OVER = 1000;
function invBookPrintCost(n) {
  return {
    rows: n,
    secs: Math.round(n * INVBOOK_PRINT_MS_PER_ROW / 100) / 10, // с една десета
    mb: Math.round(n * INVBOOK_PRINT_MB_PER_ROW),
    sheets: Math.ceil(n / INVBOOK_PRINT_ROWS_PER_SHEET)
  };
}
window.invBookPrintCost = invBookPrintCost;
/* Колко е ЦЯЛАТА книга — числото идва от показателите над таблицата (те са по
   целия регистър, без търсенето), а при стар обработчик/тестов заместител — от
   списъка в паметта. */
function invBookWholeBookRows() {
  if (INVBOOK_SUMMARY && Number.isFinite(INVBOOK_SUMMARY.rows)) return INVBOOK_SUMMARY.rows;
  if (INVBOOK_WINDOWED && INVBOOK_TOTAL) return INVBOOK_TOTAL;
  return (window._INVBOOK_ROWS || []).length;
}
function invBookPrintDialog() {
  const q = INVBOOK_QUERY.trim();
  const whole = invBookWholeBookRows();
  const c = invBookPrintCost(whole);
  const curYear = Number(yr());
  /* По подразбиране — ГОДИНА, а не цялата книга. Текущата, защото поводът за
     печат почти винаги е заверката на вписаното през нея. Падащото меню обхваща
     дванайсет години назад; „без ограничение по година“ изчиства двете дати и
     връща диалога в стария му вид (тогава остава изборът по инвентарен номер). */
  const years = [];
  for (let y = curYear; y > curYear - 12; y--) years.push(y);
  modal('Печат на инвентарната книга — кой диапазон', `
    <div class="note">Инвентарната книга се печата на листа, които се прошнуроват, номерират и заверяват с
      подпис (чл. 26, ал. 2). Затова изберете какво точно да съдържа тази разпечатка — диапазонът се изписва
      и върху самия лист. Празно поле не ограничава нищо.</div>
    ${whole ? `<div class="note w" id="ibPrintCost"><b>Цялата книга е ${whole.toLocaleString('bg-BG')}
      ${whole === 1 ? 'вписване' : 'вписвания'}</b> — около ${c.sheets.toLocaleString('bg-BG')} листа А4.
      Подготовката им наведнъж държи прозореца без отговор около ${c.secs < 1 ? 'секунда' : c.secs + ' секунди'}
      и заема около ${c.mb} МБ памет; докато трае, програмата не реагира на нищо и изглежда увиснала.
      Затова по подразбиране тук е предложена <b>една година</b> — най-честият повод за печат. Цялата книга
      си остава на едно натискане, само че с въпрос.</div>` : ''}
    <form id="ibPrintF" onsubmit="return false">
      <label>Година на вписване
        <select id="ibPrintYear" onchange="invBookPrintYearChanged(this.value)">
          ${years.map(y => `<option value="${y}" ${y === curYear ? 'selected' : ''}>${y} г.</option>`).join('')}
          <option value="">— без ограничение по година —</option>
        </select>
      </label>
      <div class="grid g2">
        ${fld('От инвентарен №', 'from', { type: 'number', min: 1 })}
        ${fld('До инвентарен №', 'to', { type: 'number', min: 1 })}
        ${fld('Вписани от дата', 'dateFrom', { type: 'date', val: curYear + '-01-01' })}
        ${fld('Вписани до дата', 'dateTo', { type: 'date', val: curYear + '-12-31' })}
      </div>
      ${/* По подразбиране — това, което е филтрирано на екрана: ако в полето за
            търсене стои нещо, отметката е сложена и разпечатката излиза точно
            с видяното. Ако търсене няма, отметка няма и няма какво да обърква. */''}
      ${q ? `<label class="chk"><input type="checkbox" name="useQuery" checked>
        <span>Само редовете, които отговарят на търсенето на екрана — „${esc(q)}“</span></label>` : ''}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn" onclick="invBookPrintAll()">Цялата книга…</button>
     <button class="btn pri" onclick="invBookPrintRange()">Печат на диапазона</button>`);
}
window.invBookPrintDialog = invBookPrintDialog;
/* Годината само попълва двете дати — самото ограничаване си остава едно и също
   (invBookSelectRange по датата на вписване), за да няма втори път, по който
   разпечатката да се реже, и втори надпис в главата ѝ. */
function invBookPrintYearChanged(y) {
  const from = $('#ibPrintF [name=dateFrom]'), to = $('#ibPrintF [name=dateTo]');
  if (!from || !to) return;
  from.value = y ? y + '-01-01' : '';
  to.value = y ? y + '-12-31' : '';
}
window.invBookPrintYearChanged = invBookPrintYearChanged;
/* „Цялата книга“ — с изрично потвърждение и с ИЗМЕРЕНИТЕ числа, в думите, с
   които библиотекарят мисли: листа, секунди замръзнал прозорец, памет. Точно в
   духа на confirmManyLabels() за етикетите (core.js): не забрана, а информирано
   решение. Въпросът се задава ПРЕДИ да се тегли каквото и да е от базата — при
   „не“ нищо не е похабено, а диалогът остава отворен, за да се избере диапазон. */
async function invBookPrintAll() {
  const n = invBookWholeBookRows();
  if (n > INVBOOK_PRINT_CONFIRM_OVER) {
    const c = invBookPrintCost(n);
    const ok = await askConfirm(
      'ПЕЧАТ НА ЦЯЛАТА ИНВЕНТАРНА КНИГА\n\n'
      + 'Това са ' + n.toLocaleString('bg-BG') + ' вписвания — около '
      + c.sheets.toLocaleString('bg-BG') + ' листа А4.\n\n'
      + 'Подготовката на толкова редове наведнъж държи прозореца без отговор около '
      + (c.secs < 1 ? 'секунда' : c.secs + ' секунди') + ' и заема около ' + c.mb
      + ' МБ памет. Докато трае, програмата не реагира на нищо — нито на затваряне, нито на Esc — '
      + 'и изглежда увиснала. Не е — просто рисува всички редове.\n\n'
      + 'По-добре е книгата да се печата по години или по диапазон от инвентарни номера: '
      + 'листовете и без това се прошнуроват и заверяват на части, а всяка разпечатка носи '
      + 'означението какъв диапазон съдържа.\n\n'
      + 'Да отпечатам ли цялата книга въпреки това?',
      { kind: 'warn', title: 'Цялата инвентарна книга — ' + n.toLocaleString('bg-BG') + ' реда',
        okLabel: 'Печатай цялата книга' });
    if (!ok) return;
  }
  closeModal();
  return printInvBookDoc();
}
window.invBookPrintAll = invBookPrintAll;
async function invBookPrintRange() {
  const d = formData('#ibPrintF');
  if (d.from && d.to && parseInt(d.to, 10) < parseInt(d.from, 10)) {
    return toast('Началният инвентарен номер е по-голям от крайния — разменете ги.', 'err');
  }
  if (d.dateFrom && d.dateTo && d.dateTo < d.dateFrom) {
    return toast('Началната дата е след крайната — разменете ги.', 'err');
  }
  closeModal();
  return printInvBookDoc({ from: d.from, to: d.to, dateFrom: d.dateFrom, dateTo: d.dateTo,
    q: d.useQuery ? INVBOOK_QUERY : '' });
}
window.invBookPrintRange = invBookPrintRange;
async function printInvBookDoc(range) {
  // Пълният списък се тегли винаги (в прозоречен режим — от базата); диапазонът
  // се прилага след това, за да е сигурно, че печатът никога не зависи от това
  // колко реда са изчертани на екрана в момента.
  const all = INVBOOK_WINDOWED ? (await call(window.api.invBook.list()) || []) : (window._INVBOOK_ROWS || []);
  const sel = invBookSelectRange(all, range);
  const rows = sel.rows;
  /* Само при ИЗБРАН диапазон: празният резултат тук е сгрешена граница, а не
     празна книга, и мълчаливо отпечатан лист с нула реда, но с пълната глава на
     инвентарната книга, е точно документът, който после никой не може да обясни.
     Печатът на цялата (все още празна) книга остава възможен както досега. */
  if (sel.limited && !rows.length) {
    /* СЪОБЩЕНИЕТО ИЗБРОЯВА ВСИЧКИ действащи ограничения, не само това, което
       библиотекарката току-що е написала. От v2.4.64 диалогът започва с ТЕКУЩАТА
       година и предварително попълва двете дати — тоест печат на инв. № 1–300 за
       партида, вписана лани, връща нула реда заради ограничение, което човекът
       не е задавал и не вижда в полето, което гледа. „Проверете границите на
       диапазона“ го пращаше да проверява точно числата, които са верни. */
    return toast('В избрания диапазон няма нито един запис — разпечатката би излязла празна. '
      + 'Действащи ограничения: ' + sel.label + '. Диалогът започва с текущата година, затова '
      + 'проверете и датите на вписване, не само инвентарните номера.', 'err');
  }
  /* Разпечатката е меродавният документ по чл. 26 и се прошнурова и заверява с
     подпис — тя трябва да казва сама какво съдържа. Дотук в главата ѝ стоеше
     единствено „записи: N", където N са РЕДОВЕТЕ, отчислените включително: числото
     не е нито наличният фонд, нито броят документи (един ред може да е няколко
     екземпляра), а под него следваше таблица, в която отчислените се различават
     само по това дали в колоната „№/дата на акт" има нещо. */
  const qtyOf = (r) => (r.quantity == null ? 1 : Number(r.quantity) || 0);
  const active = rows.filter(r => r.status !== 'отчислен');
  const deacc = rows.length - active.length;
  const copies = active.reduce((s, r) => s + qtyOf(r), 0);
  const value = active.reduce((s, r) => s + (r.price || 0) * qtyOf(r), 0);
  /* „Неотчислен“ НЕ е „наличен“. Първата редакция на тази глава наричаше сбора
     „Наличен фонд“ — а в него влизат и документите със състояние „липсващ“ и
     „за реставрация“. Библиотека със 100 вписвания, 5 отчислени и 12 липсващи
     получаваше прошнурован и заверен по чл. 26, ал. 2 лист, който твърди, че 95
     документа са налични, включително 12, за които собствената ѝ проверка е
     установила обратното. Числото е вярно (същото, което брои и stockAt() в
     КДБФ) — сгрешена беше ДУМАТА, затова се сменя тя, а състоянията се изброяват. */
  const byStatus = {};
  active.forEach(r => { const k = r.status || 'без състояние'; byStatus[k] = (byStatus[k] || 0) + qtyOf(r); });
  const notOnShelf = Object.entries(byStatus).filter(([k]) => k !== 'наличен');
  /* ЧИСЛОТО НА ДИАПАЗОНА ВЕЧЕ НЕ СЕ ОБЯВЯВА ЗА ФОНДА НА БИБЛИОТЕКАТА
     (v2.4.65, кръг 42, находка Б7).
     (а) КАКВО СТАВАШЕ ДОТУК. Изречението „Фонд по инвентарната книга (без
         отчислените): N библиотечни документа на стойност …“ се смяташе върху
         ОТПЕЧАТАНИТЕ редове, но се изписваше без нито една дума за диапазон.
         При фонд от 4 документа и отпечатан диапазон с 2 листът твърдеше „Фонд
         по инвентарната книга (без отчислените): 2 библиотечни документа“.
         Изречението точно над него вече е уточнено от v2.4.56 („в отпечатания
         диапазон“), това — не беше.
     (б) ЗАЩО Е ГРЕШНО ЗА БИБЛИОТЕКАТА И ЗА НАРЕДБА № 3. Точно този лист се
         прошнурова, номерира, подпечатва и заверява с подписа на ръководителя по
         чл. 26, ал. 2 — числото в него е ПОДПИСАНО. А от v2.4.64 диалогът за
         печат започва с ТЕКУЩАТА година и предварително попълва датите: „една
         година“ вече е подразбирането на печата, не изключението. Тоест
         обичайният лист обявяваше фонда на една година за фонд на библиотеката.
     (в) ЗАЩО ПОПРАВКАТА Е ТОЧНО ТАЗИ. Числото не се пипа — то е вярно за онова,
         което листът съдържа. Сменя се ДУМАТА, както вече веднъж се смени
         („Наличен фонд“ → „без отчислените“): при диапазон изречението казва чий
         е сборът, а веднага след него стои и сборът за ЦЯЛАТА книга, за да има
         подписаният лист отговор и на двата въпроса — какво има в него и какъв е
         фондът към деня на разпечатването. Пълната книга (`all`) вече е изтеглена
         по-горе за самия избор на диапазон, така че второто число не струва нито
         заявка повече. Печатът на цялата книга остава дума по дума какъвто беше. */
  const allActive = all.filter(r => r.status !== 'отчислен');
  const allCopies = allActive.reduce((s, r) => s + qtyOf(r), 0);
  const allValue = allActive.reduce((s, r) => s + (r.price || 0) * qtyOf(r), 0);
  /* Бележката за документите без дата на вписване е СЪЩАТА, която стои и на
     екрана (invBookUndatedNote) — и се смята върху точно отпечатаните редове,
     не върху целия регистър: иначе листът би обявявал число, което в него го
     няма. Виж обяснението при самата функция: инвентарната книга и КДБФ броят
     по различен ключ и разликата трябва да е написана на меродавния документ. */
  const undatedNote = invBookUndatedNote(invBookSummaryOf(rows));
  setPrintPage({ name: `Инвентарна книга — ${bg(today())}`, landscape: true, margin: '10mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ИНВЕНТАРНА КНИГА</h2>
    <div class="pmeta">Приложение № 4 към чл. 16, ал. 1 от Наредба № 3 от 18.11.2014 г.<br>
    ${/* Одит v2.4.56: когато е отпечатан ДИАПАЗОН, главата казва това с първото си
          изречение и назовава границите — а също и колко е цялата книга, за да е
          явно, че листът е част от нея, а не самата тя. Печатът на цялата книга
          пише същото, каквото пишеше и досега. */''}
    Разпечатано на ${bg(today())} г. · <b>${rows.length}</b> вписвания (инвентарни номера) ${
      sel.limited ? 'в отпечатания диапазон' : 'от началото на книгата'},
    от които <b>${active.length}</b> неотчислени и <b>${deacc}</b> отчислени.<br>${
      sel.limited ? `<b>Отпечатан диапазон:</b> ${esc(sel.label)} — част от инвентарната книга,
      която към ${bg(today())} г. съдържа общо ${all.length} вписвания.<br>` : ''}
    ${/* Един инвентарен номер = един екземпляр, тоест вписванията и документите са
          едно и също число. Второто изречение излиза САМО ако базата все още носи
          стар запис с друга бройка — тогава мълчанието би било по-лошо от
          повторението (виж „Настройки“ → „Проверка на данните“). */''}
    ${/* БЕЗ ВТОРА ТОЧКА СЛЕД СУМАТА (v2.4.61). mny() връща „177.98 € / 348.15 лв.“
          — низ, който ВЕЧЕ завършва със съкращението „лв.“, тоест и с точка.
          Шаблонът добавяше още една и на прошнурования, номериран и заверен по
          чл. 26, ал. 2 лист стоеше „… 348.15 лв..“. Дребно — но това е
          регистърът, който се подписва и подпечатва, и печатната грешка в него
          се чете като небрежност в целия документ. Изречението вече свършва с
          точката на съкращението, както се пише и на ръка. */''}
    ${sel.limited
      ? `Фонд <b>в отпечатания диапазон</b> (без отчислените): <b>${copies}</b> библиотечни документа
         на стойност <b>${mny(value)}</b> Това НЕ е фондът на библиотеката: по цялата инвентарна книга
         към ${bg(today())} г. неотчислените са <b>${allCopies}</b> библиотечни документа на стойност
         <b>${mny(allValue)}</b>`
      : `Фонд по инвентарната книга (без отчислените): <b>${copies}</b> библиотечни документа на стойност <b>${mny(value)}</b>`}${
      copies !== active.length ? `<br><b>Внимание:</b> ${active.length} инвентарни номера дават ${copies} документа —
      един инвентарен номер отговаря на един екземпляр. Проверете „Настройки“ → „Проверка на данните“.` : ''}${
      notOnShelf.length ? `<br>От тях със състояние, различно от „наличен“: ${
        notOnShelf.map(([k, n]) => esc(k) + ' — ' + n).join(', ')}.` : ''}
    Отчислените се отбелязват, но не се заличават (чл. 39).</div>
    ${undatedNote ? `<div class="pmeta">${undatedNote}</div>` : ''}
    <table><thead><tr><th>Дата</th><th>Инв. №</th><th>Проверки</th><th>Автор и заглавие</th><th>Год.</th><th>Бр.</th><th>Цена</th>
    <th>№/дата в КДБФ</th><th>Сигнатура</th><th>№/дата на акт</th><th>Състояние</th><th>Забележка</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${bg(r.register_date) || '—'}</td><td>${r.inv_number ?? ''}</td>
      <td>${invBookChecksText(r.checks)}</td>
      <td>${esc([r.author, r.title].filter(Boolean).join('. '))}${r.volume ? ', т. ' + esc(r.volume) : ''}</td>
      <td>${esc(r.year || '')}</td><td>${qtyOf(r)}</td><td>${mny(r.price)}</td>
      <td>${r.acq_no ? '№ ' + r.acq_no + ' / ' + bg(r.acq_date) : ''}</td><td>${esc(r.call_number || '')}</td>
      <td>${r.act_no ? '№ ' + r.act_no + ' / ' + bg(r.act_date) : ''}</td>
      <td>${esc(r.status || '')}</td><td>${esc(r.description || '')}</td></tr>`).join('')}
    </tbody></table>
    <div class="pmeta">Настоящата разпечатка съдържа ${rows.length} вписвания${
      sel.limited ? ` от избрания диапазон (${esc(sel.label)}) и НЕ е пълната инвентарна книга` : ''}.
    Листовете се прошнуроват, номерират, подпечатват и
    заверяват с подписа на ръководителя (чл. 26, ал. 2).</div>
    ${ssig(['Библиотекар: ' + esc((SETTINGS_CACHE || {}).librarian || '…………………'), esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': ' + esc((SETTINGS_CACHE || {}).director || '…………………')])}</div>`);
}
window.printInvBookDoc = printInvBookDoc;
