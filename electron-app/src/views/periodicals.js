/* ---------------- Периодика ---------------- */
async function renderPeriodika() {
  const list = await call(window.api.periodicals.list());
  if (!list) return;
  /* Годината на разпечатката (v2.4.61, находка 17) стои ДО бутона за печат, а не
     в отделен диалог: абонаментният списък се вади за конкретна година и
     годината е единственото, което се избира. По подразбиране — текущата. */
  const curYear = yr();
  const years = yearOptions(curYear);
  $('#view').innerHTML = `
    <div class="note">Картотека на периодичните издания и постъпилите броеве към всяко от тях (кардекс).</div>
    <div class="toolbar"><button class="btn pri" onclick="periodicalForm()">+ Ново периодично издание</button>
      <select id="perPrintYear" title="Година на абонаментния списък за печат">${
        years.map(y => `<option ${y === curYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <button class="btn" onclick="printPeriodikaYear()">Печат / PDF</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Заглавие</th><th>Периодичност</th><th>Издател</th>
      <th>ISSN</th><th>Отдел</th><th>Броеве</th><th>Инвентирани комплекти</th><th>Следващ очакван брой</th><th></th></tr></thead><tbody>
    ${list.length ? list.map(p => `<tr><td>${esc(p.title)}</td><td>${esc(p.freq || '')}</td><td>${esc(p.publisher || '')}</td>
      <td class="num">${esc(p.issn || '')}</td><td>${esc(p.department || '')}</td><td class="num">${p.issue_count}</td>
      <td class="num">${periodicalVolumesHtml(p)}</td>
      <td class="num">${periodicalNextHtml(p)}</td>
      <td><button class="btn sm" onclick="openPeriodical(${p.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="9" class="empty">Няма заведени периодични издания.</td></tr>`}
    </tbody></table></div>`;
}
/* Колоната „Инвентирани комплекти“ (v2.4.56) е единственото място, където
   разликата между „водим го в кардекса“ и „то е във фонда“ се вижда с един
   поглед. Дотук такава разлика нямаше как да се забележи: периодиката НИКОГА не
   влизаше във фонда, а КДБФ Част № 1 се печаташе със заглавие, което изрично
   изброява периодичните издания — тоест разпечатката твърдеше едно, а числата ѝ
   бяха други, всяка година. Нулата тук е предупреждение, не украса: заглавие с
   вписани броеве и нула инвентирани комплекта е абонамент, който не е отчетен
   никъде. Затова се показва като жълт знак, а не като тихо „0“. */
function periodicalVolumesHtml(p) {
  const n = Number(p.volume_count) || 0;
  if (n) return String(n);
  if (!Number(p.issue_count)) return '<span class="hint">—</span>';
  return `<span class="badge warn" title="Има вписани броеве, но нито един годишен комплект не е инвентиран — това издание не влиза в КДБФ и в отчета за фонда">0</span>`;
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
/* КАРДЕКСЪТ СЕ ОТВАРЯ ПО ГОДИНА (v2.4.61, находка 6).
   ===========================================================================
   ДОТУК прозорецът чертаеше ВСИЧКИ броеве на изданието — до един, в кутия с
   превъртане 240 px, и наново след всяко „Добави брой“ и всяко „×“. За
   ежедневник това са 300 реда след първата година и 3000 след десетата: всяко
   вписване на днешния вестник пречертава цялата история. И по-лошото — за да се
   намери „бр. 117“, нямаше нито страници, нито филтър, нито търсене.
   Хартиеният кардекс също е по година (един картон на година), комплектът се
   подвързва по година и проверката пита по година — затова разрезът е точно
   този. Годината идва от обработчика (periodicals:get), а не се реже тук:
   отрязването в изгледа би оставило IPC-то да носи същите хиляди реда.
   Търсачката отдолу филтрира вече показаната година по номер и по дата — тя е
   за „намери ми бр. 117“, докато годината е за „покажи ми 2024“. */
/* …С ЕДНО ИЗКЛЮЧЕНИЕ, КОЕТО ГО ЗАОБИКАЛЯШЕ (v2.4.64, измерване).
   ===========================================================================
   Изборът на година има и опция „всички години (N)“ — и точно тя минаваше ПОД
   ограничението, заради което е писан целият коментар по-горе: обработчикът
   връща всички броеве на изданието, а прозорецът ги чертаеше до един.
   ИЗМЕРЕНО: 1 200 броя → 7 295 DOM възела в едно тяло, в кутия с превъртане
   240 px — тоест библиотекарят вижда от тях около петнайсет. За сравнение,
   5 400 възела („Книги“, 300 реда) струват +73 МБ RSS на рендера в истински
   Chromium (node /tmp/r41/mem-chromium.js).
   Затова „всички години“ вече минава през СЪЩАТА обща машинка, както „Книги“,
   „Читатели“ и МЗС: paintRowWindow/RENDER_PAGE_SIZE от core.js — 300 реда и
   бутон „Покажи още“, а при тавана RENDER_MAX_ROWS — честният надпис вместо
   бутона. Разрезът по ГОДИНА си остава предпочитаният път (той е и хартиеният),
   но когато библиотекарят поиска всичко, „всичко“ вече не значи „всичко
   наведнъж“. Прозорецът важи и за отделната година — там той просто рядко се
   стига до него. */
const PER_ISSUES_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let PER_ISSUES_LIMIT = PER_ISSUES_PAGE_SIZE;
let PER_ISSUES_PAINTED = 0;
/* Редовете на кардекса. Изданието (нужно на invNoForIssue) идва от
   window._PER_KARDEX, защото rowsHtml() получава само порцията редове. */
function perIssueRowsHtml(list) {
  const p = window._PER_KARDEX || {};
  return list.map(i => `<tr><td class="num">${esc(i.issue_no)}</td><td class="num">${bg(i.date)}</td>
      <td class="num">${mny(i.price)}</td><td><button type="button" class="btn sm dgr"
        onclick="delIssue(${i.id},${jsNum(p.id)},${jsNum(invNoForIssue(p, i))})">×</button></td></tr>`).join('');
}
function perIssuesMoreHtml(more, total) {
  return more > 0
    ? `<button type="button" class="btn" onclick="perIssuesMore()">Покажи още (${more} от общо ${total})</button>` : '';
}
function perIssuesMore() {
  PER_ISSUES_LIMIT += PER_ISSUES_PAGE_SIZE;
  paintPerIssues(true);
}
window.perIssuesMore = perIssuesMore;
/* ТЪРСЕНЕТО ФИЛТРИРА ДАННИТЕ, А НЕ НАРИСУВАНИТЕ РЕДОВЕ (v2.4.65, находка А11).
   ===========================================================================
   ДОТУК (v2.4.64) търсачката работеше върху <tr>-овете в тялото на таблицата и
   при непразно търсене първо ДОРИСУВАШЕ целия списък, за да има какво да скрие.
   Това работи, докато списъкът се побира под общия таван RENDER_MAX_ROWS = 3 000
   (src/views/core.js) — а именно там се чупи: paintRowWindow чертае най-много
   3 000 реда, тоест броевете отвъд третохилядния НЯМА как да се появят в тялото
   и търсенето по тях отговаря „Показани 0 от 4000 броя“ с нула видими реда.
   Броят си е вписан в базата, кардексът просто твърди, че го няма.
   ПРАГЪТ Е ИСТИНСКИ: ежедневник, пазен от около 2015 г. насам, има над 3 000
   броя и при „всички години“ попада точно в този случай.
   ЗАЩО ПОПРАВКАТА Е ТАКАВА: филтърът слиза едно ниво по-надолу — върху масива
   `issues`, който прозорецът вече държи, — и на рисуване се подават САМО
   съвпаденията. Тогава таванът от 3 000 реда се прилага върху РЕЗУЛТАТА от
   търсенето (а той при „намери ми бр. 117“ е един ред), а не върху търсенето.
   Таванът остава непроменен и общ за цялата програма: той е въведен в v2.4.64
   срещу измерени 1 115 ms подредба и +1 025 МБ памет при 15 000 реда, и не бива
   да се вдига за една таблица.
   Страничната печалба: ред, който не съвпада, вече не се чертае изобщо, вместо
   да се чертае и после да се скрива с display:none. */
let PER_ISSUE_Q = '';
function perIssueMatches() {
  const p = window._PER_KARDEX;
  const all = (p && p.issues) || [];
  if (!PER_ISSUE_Q) return all;
  /* Търси се по същото, което библиотекарката ЧЕТЕ на реда: номер на брой и
     дата в български вид (14.03.2025). Суровата ISO дата се проверява също —
     който пише „2025-03-14“, пита за същия ред. */
  return all.filter(i => {
    const t = String(i.issue_no == null ? '' : i.issue_no) + ' ' + bg(i.date) + ' ' + String(i.date || '');
    return t.toLowerCase().includes(PER_ISSUE_Q);
  });
}
function paintPerIssues(append) {
  const p = window._PER_KARDEX;
  if (!p || !$('#perIssuesBody')) return;
  const rows = perIssueMatches();
  PER_ISSUES_PAINTED = paintRowWindow({
    body: '#perIssuesBody', bar: '#perIssuesMore', rows, limit: PER_ISSUES_LIMIT,
    painted: append ? PER_ISSUES_PAINTED : 0,
    rowsHtml: perIssueRowsHtml,
    moreHtml: perIssuesMoreHtml
  });
  const label = $('#perIssueCount');
  if (label) {
    const scopeTotal = (p.issues || []).length;
    const grand = p.issue_total == null ? scopeTotal : p.issue_total;
    label.textContent = issueCountLabel(PER_ISSUES_PAINTED, rows.length, scopeTotal, p.issue_year, grand);
  }
}
window.paintPerIssues = paintPerIssues;
async function openPeriodical(id, year) {
  const p = await call(window.api.periodicals.get(id, { year }));
  if (!p) return;
  window._PER_KARDEX = p;
  PER_ISSUES_LIMIT = PER_ISSUES_PAGE_SIZE; // ново отваряне/нова година — пак от първата порция
  PER_ISSUE_Q = '';                        // полето за търсене се пресъздава празно
  const yearsList = p.issue_years || [];
  const shown = p.issues.length;
  const total = p.issue_total == null ? shown : p.issue_total;
  const yearSel = `<select id="perIssueYear" onchange="openPeriodical(${id}, this.value)">
      ${yearsList.map(y => `<option value="${esc(y.year)}" ${String(y.year) === String(p.issue_year) ? 'selected' : ''}
        >${esc(y.year)} г. (${y.n})</option>`).join('')}
      ${yearsList.some(y => String(y.year) === String(p.issue_year)) ? ''
        : `<option value="${esc(String(p.issue_year))}" selected>${esc(String(p.issue_year))} г. (0)</option>`}
      <option value="всички" ${String(p.issue_year) === 'всички' ? 'selected' : ''}>всички години (${total})</option>
    </select>`;
  modal(p.title, `
    <div class="hint" style="margin-bottom:10px">${esc(p.freq || '')} · ${esc(p.publisher || '')}${p.issn ? ' · ISSN ' + esc(p.issn) : ''}</div>
    <fieldset><legend>Нов постъпил брой</legend>
      <form id="issueF" onsubmit="return false">
        <div class="grid g3">
        ${fld('Номер на брой', 'issue_no', { req: 1, onkey: `if(event.key==='Enter'){event.preventDefault();addIssue(${id})}` })}
        ${fld('Дата на постъпване', 'date', { val: today(), type: 'date' })}
        ${mnyField('Цена', 'price', { min: 0 })}
        </div>
        ${/* ПОЛЕТО „ЗАБЕЛЕЖКА“ (v2.4.65, находка В5).
              =============================================================
              ДОТУК отказът при дублиран брой (handlers/periodicals.js) съветваше
              дословно: „отбележете го в забележката на вписания брой“ — а поле
              „Забележка“ във формата НЯМАШЕ. Печатът на картона има колона
              „Забележка“ (виж printPeriodicalCard по-долу) и тя винаги излизаше
              празна; таблицата periodical_issues има колоната от самото начало и
              periodicalIssues:add ВЕЧЕ приема issue.note — просто никой не му го
              подаваше. Тоест програмата пращаше библиотекарката към място, което
              не съществува, а на хартия печаташе празна графа.
              ЗАЩО Е ВАЖНО ЗА БИБЛИОТЕКАТА: точно тук се пише „два екземпляра“,
              „получен с 3 дни закъснение“, „притурка“, „скъсан при доставката“ —
              сведенията, които обясняват при проверка защо кардексът изглежда
              както изглежда, и които иначе се пишат с молив по картона. */''}
        ${fld('Забележка', 'note', { val: '', hint: 'напр. „получени два екземпляра“, „с притурка“, „повреден при доставката“' })}
      </form>
      <button type="button" class="btn pri" onclick="addIssue(${id})">Добави брой</button>
    </fieldset>
    ${periodicalVolumesSection(p)}
    <div class="toolbar" style="margin:8px 0 4px">
      <label>Година: ${yearSel}</label>
      <input id="perIssueSearch" type="search" placeholder="търсене по № на брой или дата" oninput="filterIssueRows()">
      <span class="hint" id="perIssueCount" data-total="${total}" data-year="${esc(String(p.issue_year))}"
        >${issueCountLabel(shown, shown, shown, p.issue_year, total)}</span>
    </div>
    ${/* Тялото се пълни от paintPerIssues() след отварянето на прозореца — през
          общата машинка с прозоречния рендер (виж коментара при
          PER_ISSUES_PAGE_SIZE по-горе), а не с p.issues.map(...) наведнъж. */''}
    ${p.issues.length ? `<div class="wrap" style="max-height:240px"><table class="ledger"><thead><tr>
      <th>Брой</th><th>Дата</th><th>Цена</th><th></th></tr></thead><tbody id="perIssuesBody"></tbody>
      </table></div>
      <div class="toolbar" id="perIssuesMore" style="justify-content:center;margin-top:6px"></div>`
      : `<div class="hint">${total ? 'За избраната година няма вписани броеве — изберете друга година.' : 'Все още няма вписани броеве.'}</div>`}`,
    `<button class="btn dgr" onclick="delPeriodical(${id})">Изтрий изданието</button>
     <button class="btn" onclick="printPeriodicalCard(${id},'${esc(String(p.issue_year))}')">Печат / PDF на картона</button>
     <button class="btn" onclick="closeModal();periodicalForm(${id})">Редактирай</button>
     <button class="btn pri" onclick="closeModal()">Затвори</button>`);
  /* Опресняването виси на ЗАТВАРЯНЕТО, а не на един бутон: ✕ и Esc затварят
     същия прозорец и дотук оставяха списъка отзад със старите „Броеве“ и
     „Следващ очакван брой“ — току-що вписан брой продължаваше да се води
     закъснял. */
  onModalClose(periodikaRefreshIfShown);
  paintPerIssues(); // първата порция броеве — тялото се вписва чак сега (виж горе)
  setTimeout(() => { const f = $('#issueF [name=issue_no]'); if (f) f.focus(); }, 0);
}
window.openPeriodical = openPeriodical;
/* Одит v2.4.29: след „Добави брой“/„×“ списъкът зад кардекса показваше старите
   „Броеве“ и „Следващ очакван брой“ до повторно влизане в раздела. */
function periodikaRefreshIfShown() { if (VIEW === 'periodika') renderPeriodika(); }
window.periodikaRefreshIfShown = periodikaRefreshIfShown;
/* „Показани N от M“ (v2.4.61) — стои до избора на година, за да е ясно, че
   списъкът отдолу е разрез, а не целият кардекс: иначе филтърът върши точно
   обратното на предназначението си и библиотекарката решава, че броевете са
   изчезнали.
   ДВЕ РАЗЛИЧНИ БРОЙКИ В ЕДИН НАДПИС (v2.4.65, находка Б14).
   ===========================================================================
   ДОТУК числото М беше `p.issue_total` — кардексът на ВСИЧКИ години, — докато
   бутонът под таблицата броеше по дължината на показаната година. Резултатът се
   четеше така: „Показани 300 от 405 броя — 2025 г.“ до бутон „Покажи още (65 от
   общо 365)“, а след натискането му „Показани 365 от 405 броя“ БЕЗ бутон и без
   нито една дума защо липсват 40. Тоест надписът, писан да казва честно колко се
   виждат от колко (виж renderCapHtml в core.js), твърдеше, че 40 броя за 2025 г.
   не са изчертани — а те просто са от друга година.
   Оттук нататък надписът брои В ИЗБРАНИЯ ОБХВАТ (годината или „всички години“),
   точно както бутонът, а целият кардекс се НАЗОВАВА отделно, накрая — той е
   полезно сведение („в картотеката има още“), но не е знаменателят на разреза. */
function issueCountLabel(shown, matches, scopeTotal, year, grandTotal) {
  const scope = year === 'всички' ? 'всички години' : year + ' г.';
  let s = 'Показани ' + shown + ' от ' + matches + (matches === 1 ? ' брой' : ' броя') + ' — ' + scope;
  if (matches !== scopeTotal) s += ' (филтър: ' + matches + ' от ' + scopeTotal + ')';
  if (grandTotal != null && grandTotal !== scopeTotal) {
    s += ' · целият кардекс: ' + grandTotal + (grandTotal === 1 ? ' брой' : ' броя');
  }
  return s;
}
window.issueCountLabel = issueCountLabel;
/* Търсенето в рамките на показаната година: по номер на брой и по дата, така
   както библиотекарката ги чете на реда — без да се ходи до базата, защото
   годината вече е в прозореца.
   Тук се записва САМО какво е поискано; самото пресяване е в perIssueMatches()
   и рисуването минава през общата машинка (виж дългата бележка там защо филтърът
   слезе от нарисуваните редове върху масива с данни). Всяка смяна на търсенето е
   ПЪЛЕН рендер (painted = 0): при друг набор редове добавянето към тялото би
   долепило новите редове към старите — точно капанът, срещу който paintRowWindow
   в core.js пази с проверката body.children.length === painted. */
function filterIssueRows() {
  const box = $('#perIssueSearch');
  if (!$('#perIssuesBody')) return;
  const q = String(box ? box.value : '').trim().toLowerCase();
  if (q !== PER_ISSUE_Q) {
    PER_ISSUE_Q = q;
    PER_ISSUES_LIMIT = PER_ISSUES_PAGE_SIZE; // нов резултат — пак от първата порция
  }
  paintPerIssues(false);
}
window.filterIssueRows = filterIssueRows;

/* ============================================================================
   ГОДИШНИ КОМПЛЕКТИ — периодиката влиза във фонда (v2.4.56)
   ============================================================================
   ДОТУК този прозорец беше край на пътя: броевете се вписваха в кардекса и
   оставаха там завинаги. Никъде в програмата нямаше действие, което да вкара
   периодично издание в инвентарната книга — нито инвентарен номер, нито партида,
   нито ред в наличността.
   ЗАЩО Е ГРЕШНО: отпечатаното заглавие на КДБФ Част № 1 гласи „Регистриране на
   постъпили книги, ПЕРИОДИЧНИ ИЗДАНИЯ и други материали“, Дневникът има готов ред
   „Периодични издания“ в Раздел Б, а Наредба № 3 (чл. 13, ал. 3, т. 1; чл. 14;
   чл. 16) брои периодичните издания за библиотечни документи. Тоест програмата
   печаташе документи, които сами твърдят, че съдържат периодика, и не съдържаха
   нито ред от нея — постъпленията и стойността на фонда излизаха системно
   занижени при всяка проверка.
   ЗАЩО ИМЕННО ГОДИШЕН КОМПЛЕКТ: броевете за една година се подвързват и се водят
   като ЕДИН библиотечен документ с ЕДИН инвентарен номер — така е в практиката и
   така го брои статистиката. Затова действието стои ТУК, до кардекса (той знае
   кои броеве са постъпили и колко струват), а не в „Фонд“, където библиотекарят
   би трябвало да преписва наум сбора от дванайсет реда. */
function jsNum(v) { return v == null ? 'null' : String(Number(v)); }
/* Инв. номерът на комплекта, в който попада ЕДИН брой (или null). Ползва се, за
   да предупреди „×“, че се трие брой от вече подвързан и вписан във фонда
   комплект — виж delIssue по-долу. */
function invNoForIssue(p, issue) {
  const year = issue && issue.date ? String(issue.date).slice(0, 4) : null;
  if (!year) return null;
  const v = (p.volumes || []).find(x => String(x.year) === year && x.book_id != null);
  return v ? v.inv_number : null;
}
function periodicalVolumesSection(p) {
  const vols = p.volumes || [];
  const rows = vols.map(v => {
    /* „ИНВЕНТИРАН“ ЗНАЧИ „ЖИВ КОМПЛЕКТ ВЪВ ФОНДА“ (v2.4.65, находка Б13).
       =====================================================================
       ДОТУК `done` беше само `v.book_id != null` — тоест вярно и за ОТЧИСЛЕН
       документ, а при `done` бутонът „Инвентирай годишния комплект“ не се
       рисуваше изобщо. Обработчикът от v2.4.61 (находка 16) нарочно допуска
       повторно вписване след отчисляване — точно за заместващия комплект
       (дарен или откупен том за същата година) — но екранът не оставяше път
       дотам: годината е показана като готова, бутон няма, а UNIQUE(periodical_id,
       year) не допуска втори ред. Заместващият комплект просто нямаше как да
       влезе във фонда от интерфейса.
       Затова тук се пита СЪСТОЯНИЕТО, а не само наличието на връзка — със същия
       ключ „налично днес“, с който periodicals:list брои колоната „Инвентирани
       комплекти“ (db/fund-sql.js: status <> 'отчислен' ИЛИ status IS NULL, плюс
       липсваща дата на отчисляване). Отчислената година пак показва инв. № и
       белега „отчислен“ — историята не се крие, — но получава бутон „Впиши
       заместващ комплект“, чието име казва какво ще стане. */
    const live = v.book_id != null && v.deaccession_date == null && v.status !== 'отчислен';
    const done = v.book_id != null;
    /* РАЗМИНАВАНЕТО МЕЖДУ КАРДЕКСА И ПОДВЪРЗАНИЯ КОМПЛЕКТ СЕ КАЗВА (v2.4.61, находка 12).
       ДОТУК редът показваше ЖИВИЯ брой броеве до цената на документа и нищо
       повече: „3 броя · 7.00 € · инв. № 1“ изглежда като едно съгласувано цяло, а
       всъщност комплектът е подвързан с 2 броя за 7,00 € и третият е вписан
       по-късно. periodicals:get отдавна връща registered_issue_count (снимката към
       инвентирането) — просто никой не я показваше. Разминаването значи, че
       кардексът и документът на рафта вече не си отговарят: или броят е добавен
       след подвързването (тогава той е извън комплекта и трябва да влезе в
       следващия), или е изтрит (тогава документът съдържа брой, който картотеката
       не помни). И в двата случая при проверка отговаря документът, не програмата,
       затова разликата трябва да се вижда на самия ред. */
    /* `liveCount` (дотук се казваше просто `live`) е ЖИВИЯТ брой броеве в
       кардекса. Преименуван е в v2.4.65, за да не се бърка с „жив комплект във
       фонда“ по-горе: двете думи значат различни неща на един и същ ред. */
    const liveCount = Number(v.issue_count) || 0;
    const snap = v.registered_issue_count == null ? null : Number(v.registered_issue_count);
    const diverged = done && snap != null && snap !== liveCount;
    const invCell = done
      ? `<b>инв. № ${esc(String(v.inv_number ?? '—'))}</b>${v.register_date ? ' · вписан ' + bg(v.register_date) : ''}`
        + `${v.acq_no ? ' · партида № ' + esc(String(v.acq_no)) + '/' + esc(String(v.acq_year)) : ' · <span class="hint">без партида</span>'}`
        + `${v.deaccession_date ? ' · <span class="badge warn">отчислен</span>' : ''}`
        + (diverged ? ` · <span class="badge warn" title="Кардексът показва ${liveCount} бр., а комплектът е подвързан и вписан в инвентарната книга с ${snap} бр. на стойност ${mny(v.volume_price)}. Документът във фонда не се променя със задна дата — новите броеве влизат в следващия комплект.">разминаване: подвързан с ${snap} бр. при инвентирането, в кардекса ${liveCount}</span>` : '')
      : '<span class="hint">не е инвентиран</span>';
    /* Бутонът НОСИ ЕДНО И СЪЩО ИМЕ и за празната, и за отчислената година —
       действието е едно (вписване на годишен комплект в инвентарната книга) и
       се назовава еднакво навсякъде в програмата. Че става дума за ЗАМЕСТВАЩ
       том, се казва до бутона и в подсказката му, вместо да се сменя името на
       самото действие: библиотекарката търси бутона, който вече познава. */
    const btn = live ? ''
      : `<button type="button" class="btn sm pri" onclick="volumeForm(${p.id},'${esc(String(v.year))}')"
          ${done ? 'title="Предишният комплект за тази година е отчислен с акт по чл. 35. Заместващият том (дарен или откупен) влиза във фонда със свой инвентарен номер; отчисленият остава в акта и в КДБФ Част № 3."' : ''}
          >Инвентирай годишния комплект</button>`
        + (done ? ' <span class="hint">заместващ том — предишният е отчислен</span>' : '');
    return `<tr><td class="num">${esc(String(v.year))}</td><td class="num">${Number(v.issue_count) || 0}</td>
      <td class="num">${mny(done ? v.volume_price : v.issue_sum)}</td><td>${invCell}</td>
      <td>${btn}</td></tr>`;
  }).join('');
  return `<fieldset><legend>Годишни комплекти (фонд)</legend>
    <div class="note">Броевете за една година се подвързват и се водят като <b>един библиотечен документ с един
      инвентарен номер</b> (чл. 16). Докато комплектът не е инвентиран, изданието не влиза нито в КДБФ Част № 1,
      нито в отчета за фонда.</div>
    ${vols.length ? `<div class="wrap" style="max-height:200px"><table class="ledger"><thead><tr>
      <th>Година</th><th>Броеве</th><th>Стойност</th><th>Във фонда</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
      : '<div class="hint">Годините се появяват тук, щом бъде вписан първият брой.</div>'}
  </fieldset>`;
}
/* Формата за инвентиране стои на ВТОРИЯ слой прозорци (modal2) върху кардекса:
   попълненото в кардекса (започнат нов брой) не бива да се губи, а и след запис
   библиотекарят се връща точно там, откъдето е тръгнал. */
async function volumeForm(periodicalId, year) {
  const [p, acqs, s] = await Promise.all([
    call(window.api.periodicals.get(periodicalId)),
    call(window.api.acquisitions.list()),
    call(window.api.settings.get())
  ]);
  if (!p) return;
  const v = (p.volumes || []).find(x => String(x.year) === String(year));
  if (!v) return toast('Годината вече не е налична в кардекса.', 'err');
  /* Отказва се само ЖИВ комплект (v2.4.65, находка Б13) — вторият ред от същата
     поправка. Дотук проверката беше `v.book_id != null` и затваряше вратата и за
     ОТЧИСЛЕНАТА година: дори да се стигнеше до volumeForm() по друг път (стар
     бутон, клавиатура, извикване от конзолата), формата отказваше да се отвори
     с думите „вече е инвентиран“ — за документ, който вече не е във фонда.
     Правилото, което ОТКАЗВА, си остава в обработчика
     (handlers/periodicals.js, periodicalVolumes:register); тук екранът само
     предупреждава по-рано и с наличните му данни. */
  const liveVolume = v.book_id != null && v.deaccession_date == null && v.status !== 'отчислен';
  if (liveVolume) return toast('Комплектът за ' + year + ' г. вече е инвентиран като инв. № ' + (v.inv_number ?? '—') + '.', 'err');
  /* Партидата се избира от съществуващите или се създава нова — точно както при
     книгите. Новата минава през СЪЩИЯ канал acquisitions.create, който ползва и
     екранът „Постъпления“: две различни бройни логики за номерата в КДБФ не бива
     да съществуват (чл. 14 — партидите са една поредица за цялата библиотека). */
  const acqOpts = (acqs || []).map(a => ({ v: a.id, t: '№ ' + a.no + '/' + a.year + ' — ' + (a.from_source || '') }));
  acqOpts.push({ v: '__new__', t: '➕ нова партида (абонамент) …' });
  modal2('Инвентиране на годишен комплект — ' + p.title + ', ' + year + ' г.', `
    <div class="note"><b>Чл. 16, ал. 1</b> — индивидуалната регистрация съдържа: дата на вписване, инвентарен номер,
      автор, заглавие, том, година, цена, номер и дата на вписване в КДБФ, сигнатура.</div>
    ${v.book_id != null ? `<div class="note warn">Комплектът за ${esc(String(year))} г. беше инвентиран като
      <b>инв. № ${esc(String(v.inv_number ?? '—'))}</b> и е <b>отчислен</b>${v.deaccession_date ? ' на ' + bg(v.deaccession_date) : ''}.
      Вписвате <b>заместващ том</b> — той получава нов инвентарен номер, а отчисленият остава в акта по чл. 35
      и в КДБФ Част № 3. Ако актът бъде анулиран, за тази година ще има два налични комплекта.</div>` : ''}
    <div class="hint" style="margin-bottom:8px">В инвентарната книга ще влезе един ред:
      <b>„${esc(p.title + ', ' + year)}“</b>, вид „продължаващо издание“, том „годишен комплект“.
      В кардекса за ${esc(String(year))} г. има ${Number(v.issue_count) || 0} вписани броя на обща стойност ${mny(v.issue_sum)}.</div>
    <form id="volF" onsubmit="return false">
      <div class="grid g3">
        ${fld('Инвентарен номер', 'inv_number', { val: (s && s.next_inv_number) || '', type: 'number', req: 1 })}
        ${fld('Дата на вписване', 'register_date', { val: today(), type: 'date', req: 1 })}
        ${mnyField('Цена', 'price', { val: Number(v.issue_sum) || 0, min: 0, req: 1, hint: 'по подразбиране — сборът от цените на броевете' })}
      </div>
      ${fld('Партида в КДБФ (част № 1)', 'acquisition_id', { type: 'select', opts: acqOpts, val: '', emptyLabel: '— без партида —', onchange: 'volumeAcqToggle()' })}
      <fieldset id="volAcqNew" hidden style="display:none"><legend>Нова партида — абонаментът като постъпление</legend>
        <div class="grid g4">
          ${fld('Дата на вписване', 'acq_date', { val: today(), type: 'date' })}
          ${fld('Начин на постъпване', 'acq_how', { type: 'select', opts: NACHINI, val: NACHINI[0] })}
          ${fld('Откъде (доставчик / дарител)', 'acq_from_source', {})}
          ${fld('Общ брой документи', 'acq_total_count', { val: 1, type: 'number' })}
        </div>
        <div class="grid g4">
          ${fld('Вид първичен документ', 'acq_doc_type', { type: 'select', opts: PARV_DOK })}
          ${fld('Номер на документа', 'acq_doc_no', {})}
          ${fld('Дата на документа', 'acq_doc_date', { val: today(), type: 'date' })}
          ${fld('Адрес на дарителя', 'acq_donor_address', { hint: 'задължително при дарение — чл. 6, ал. 5' })}
        </div>
      </fieldset>
      ${fld('Забележка към документа', 'note', { val: '', hint: 'напр. „подвързан в 2 тома“' })}
    </form>`,
    `<button class="btn" onclick="closeModal2()">Отказ</button>
     <button class="btn pri" onclick="saveVolume(${p.id},'${esc(String(year))}')">Впиши в инвентарната книга</button>`);
}
window.volumeForm = volumeForm;
/* Скриването е с ДВЕ средства наведнъж — атрибутът `hidden` и `style.display` —
   и това не е излишно. Атрибутът е този, по който focusables()/trapTab() в
   core.js решават кое поле участва в обхода с Tab; самото изчезване обаче виси
   на браузърското „[hidden]{display:none}“, което е правило с тегло 0-1-0 и се
   надвива от всяко авторско правило за `display` върху същия елемент (точно това
   вече се беше случило със сгънатите групи в навигацията — виж бележката в
   src/style.css). Полетата на партидата не бива да са нито видими, нито
   достижими с Tab, докато библиотекарят не е избрал „нова партида“. */
function volumeAcqToggle() {
  const sel = $('#volF [name=acquisition_id]');
  const box = $('#volAcqNew');
  if (!sel || !box) return;
  const show = sel.value === '__new__';
  box.hidden = !show;
  box.style.display = show ? '' : 'none';
}
window.volumeAcqToggle = volumeAcqToggle;
async function saveVolume(periodicalId, year) {
  const missing = firstMissingRequired('#volF');
  if (missing) return toast(missing + ' е задължително поле.', 'err');
  const d = formData('#volF');
  let acquisitionId = d.acquisition_id;
  /* Новата партида се завежда ПЪРВА и само ако е успяла, се инвентира комплектът.
     Обратният ред би оставил документ без партида при отказана партида — тоест
     ред във фонда, който не се вижда в КДБФ Част № 1: точно грешката, която този
     екран съществува да поправи. Ако пък инвентирането се провали след успешно
     заведена партида, партидата остава — това е вярно: тя е самостоятелно
     вписване в регистъра, а не черновa, и се поправя/трие от „Постъпления“. */
  if (acquisitionId === '__new__') {
    if (!String(d.acq_from_source || '').trim()) return toast('Попълнете откъде е постъпил абонаментът.', 'err');
    if (String(d.acq_how) === 'дарение' && !String(d.acq_donor_address || '').trim()) {
      return toast('При дарение адресът на дарителя е задължителен (чл. 6, ал. 5).', 'err');
    }
    const no = await call(window.api.acquisitions.nextNo(yr(d.acq_date)));
    if (no === null) return;
    const newId = await call(window.api.acquisitions.create({
      no, date: d.acq_date, how: d.acq_how, from_source: d.acq_from_source,
      doc_type: d.acq_doc_type, doc_no: d.acq_doc_no, doc_date: d.acq_doc_date,
      total_count: d.acq_total_count, sum: '', donor_address: d.acq_donor_address,
      note: 'Абонамент за периодика'
    }), 'Партидата е заведена в КДБФ част 1.');
    if (newId === null) return;
    acquisitionId = newId;
    /* НОВАТА ПАРТИДА ВЛИЗА В СЕЛЕКТА ВЕДНАГА (v2.4.61, находка 22).
       ДОТУК изборът оставаше на „__new__“ и след ОТКАЗАНО инвентиране (зает инв.
       №, изчерпан лимит, грешна година) второто натискане на същия бутон минаваше
       пак през този клон и завеждаше ВТОРА партида за същия абонамент. В КДБФ
       Част № 1 се появяваха две партиди „Български пощи — абонамент“, едната с
       обявен 1 документ и нула инвентирани — регистър, който сам си противоречи,
       и то за година, която после се подписва. Партидата вече е заведена и е
       самостоятелно вписване (затова не се трие при отказ) — тя просто трябва да
       стане ИЗБРАНАТА, точно както ако библиотекарят я беше избрал от списъка.
       Опцията се добавя ръчно, защото списъкът е построен при отварянето на
       формата и новото id го няма в него: select без такава опция би приел
       стойността като празна и документът щеше да остане без партида. */
    const sel = $('#volF [name=acquisition_id]');
    if (sel) {
      const opt = document.createElement('option');
      opt.value = String(newId);
      opt.textContent = '№ ' + no + '/' + yr(d.acq_date) + ' — ' + (d.acq_from_source || '');
      const newOpt = sel.querySelector('option[value="__new__"]');
      if (newOpt) sel.insertBefore(opt, newOpt); else sel.appendChild(opt);
      sel.value = String(newId);
      volumeAcqToggle();
    }
  }
  const res = await call(window.api.periodicalVolumes.register({
    periodical_id: periodicalId, year, price: d.price,
    register_date: d.register_date, inv_number: d.inv_number,
    acquisition_id: acquisitionId, note: d.note
  }));
  if (res === null) return;
  markSaved();
  toast('Годишният комплект за ' + year + ' г. е вписан в инвентарната книга под инв. № ' + res.inv_number + '.', 'ok');
  /* Прескочените инвентарни номера (v2.4.61, находка 10) идват от обработчика
     точно както при books:create и се показват като отделно предупреждение —
     следата вече е вписана, но човекът пред формата е единственият, който може
     да поправи номера, докато документът е сам в поредицата. */
  if (res.invGap) toast(res.invGap.message, 'err');
  closeModal2();
  openPeriodical(periodicalId, keptIssueYear());
}
/* Годината, на която стои кардексът в момента — за да не отскача към текущата
   след всяко действие (вписан брой, изтрит брой, инвентиран комплект). */
function keptIssueYear() {
  const sel = $('#perIssueYear');
  return sel ? sel.value : undefined;
}
window.saveVolume = saveVolume;
async function addIssue(periodicalId) {
  const d = formData('#issueF');
  if (!d.issue_no) return toast('Въведете номер на брой.', 'err');
  d.periodical_id = periodicalId;
  // Затваря се/пречертава се само при успех; отказът (невалидна дата, цена) остава във формата.
  const ok = await call(window.api.periodicalIssues.add(d), 'Брой ' + d.issue_no + ' е вписан в кардекса.');
  if (ok === null) return;
  markSaved();
  /* Кардексът се отваря на годината на ТОКУ-ЩО вписания брой (v2.4.61): иначе
     при отворена стара година новият брой изчезва от екрана и изглежда, че
     вписването не е станало. */
  openPeriodical(periodicalId, String(d.date || today()).slice(0, 4));
}
window.addIssue = addIssue;
async function delIssue(id, periodicalId, invNo) {
  /* Одит v2.4.16: изтриваше се без питане и без проверка на резултата. Един
     неточен натиск в 240-пикселов превъртащ се списък махаше регистриран брой, а
     път за връщане в интерфейса няма. Съседното delPeriodical пита както трябва. */
  /* v2.4.56: питането вече казва и КОЛКО струва изтриването, когато годината е
     инвентирана. Броят тогава не е ред в картотека, а физическа част от
     подвързан библиотечен документ с инвентарен номер, вписан в инвентарната
     книга и в КДБФ. Изтриването не се забранява (сгрешено вписване трябва да може
     да се поправи), но библиотекарят трябва да знае, че след него кардексът вече
     няма да отговаря на документа на рафта — а при проверка отговаря той, не
     програмата. Самото изтриване се вписва в одитната следа заедно с този факт
     (handlers/periodicals.js). */
  const текст = invNo == null
    ? 'Да изтрия ли този брой от кардекса? Действието не може да бъде отменено.'
    : 'Този брой е част от годишния комплект, инвентиран като инв. № ' + invNo + '.\n\n'
      + 'Комплектът е подвързан и вписан в инвентарната книга — след изтриването кардексът вече няма да отговаря '
      + 'на документа във фонда. Да изтрия ли броя въпреки това?';
  const year = keptIssueYear();
  if (!await askConfirm(текст)) return;
  const ok = await call(window.api.periodicalIssues.delete(id), 'Броят е изтрит.');
  if (ok === null) return;
  markSaved();
  openPeriodical(periodicalId, year);
}
window.delIssue = delIssue;
async function delPeriodical(id) {
  if (!await askConfirm('Изтриване на периодичното издание?')) return;
  const res = await window.api.periodicals.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderPeriodika(); toast('Изтрито.', 'ok');
}
window.delPeriodical = delPeriodical;

/* ============================================================================
   РАЗПЕЧАТКИ ЗА ПЕРИОДИКАТА (v2.4.61, находки 17 и 18)
   ============================================================================
   ДОТУК екранът „Периодика“ беше ЕДИНСТВЕНИЯТ регистър в програмата без нито
   един печатен документ: КДБФ, инвентарната книга, партидите, актовете, справките
   и картонът на читателя се печатат, а картотеката на абонаментите — не.
   ЗАЩО ЛИПСВАТА Е СКЪПА: абонаментният списък за годината е документът, който се
   подава на счетоводството при подновяване на абонамента (какво е получено срещу
   платеното) и на проверката, когато тя пита за периодиката. Дотук той се
   преписваше на ръка от екрана — а на екрана числата за минала година вече не се
   виждат наведнъж.
   ДВЕ РАЗПЕЧАТКИ, защото това са два различни документа:
     • абонаментен списък за ГОДИНАТА — всички заглавия на един лист, със сборове;
     • картонът на ЕДНО издание (кардексът) — броевете за избраната година плюс
       състоянието на годишните комплекти във фонда.
   И двете минават през общите setPrintPage/doPrint/shead/ssig, тоест носят
   главата на читалището и редовете за подпис като всеки друг официален документ
   (образец: printKdbfDoc в src/views/kdbf.js). */
async function periodikaYearRows(year) {
  const list = await call(window.api.periodicals.list());
  if (!list) return null;
  const rows = [];
  for (const p of list) {
    /* По едно четене на заглавие. Заглавията в едно читалище са десетки (не
       хиляди), а всяко четене връща само избраната година — цената е по-ниска
       от една справка по фонда и не изисква нов IPC канал. */
    const d = await call(window.api.periodicals.get(p.id, { year }));
    if (!d) continue;
    const issues = d.issues || [];
    const vol = (d.volumes || []).find(v => String(v.year) === String(year));
    /* ОТЧИСЛЕНИЯТ КОМПЛЕКТ НЕ Е „ИНВЕНТИРАН“ И НА ХАРТИЯ (v2.4.65, находка Б12).
       =====================================================================
       ДОТУК тук стоеше само `vol.book_id != null`, тоест печатът броеше за
       инвентиран и комплект, отчислен с акт по чл. 35. Резултатът: обобщаващият
       ред на абонаментния списък гласеше „1 от 7 инвентиран комплект“, докато
       съседният екран за същото издание показваше 0 с жълт знак — двете числа
       идваха от два различни ключа за един и същ въпрос. Поправката от v2.4.61
       (находка 15) беше приложена САМО в periodicals:list (сега през
       F.fundByStatus в handlers/periodicals.js), а разпечатката остана със
       старото условие.
       ЗАЩО Е ВАЖНО ИМЕННО ТУК: това е листът, който отива при счетоводството при
       подновяване на абонамента и при проверка — подписва се число, което твърди,
       че във фонда има документ, а той е изваден от него с акт. Заради същото
       падаше и предупредителната бележка отдолу („заглавията с получени броеве и
       без инвентиран годишен комплект не влизат нито в КДБФ Част № 1, нито в
       отчета за фонда“) — тя се показва при `count && !vol` и мълчеше точно за
       изданието, за което трябва да проговори.
       `vol` СЕ ЗАПАЗВА (с белега „ОТЧИСЛЕН“) — редът на изданието продължава да
       казва кой инвентарен номер е бил и какво е станало с него; само броенето
       минава през `live`, тоест през ключа „налично днес“ на db/fund-sql.js. */
    const live = !!(vol && vol.book_id != null && vol.deaccession_date == null && vol.status !== 'отчислен');
    rows.push({
      title: d.title, issn: d.issn, freq: d.freq, department: d.department,
      count: issues.length,
      sum: issues.reduce((s, i) => s + (Number(i.price) || 0), 0),
      vol: vol && vol.book_id != null ? vol : null,
      live,
      deacc: !!(vol && vol.book_id != null && !live)
    });
  }
  return rows;
}
async function printPeriodikaYear() {
  const sel = $('#perPrintYear');
  const year = sel ? sel.value : yr();
  const rows = await periodikaYearRows(year);
  if (!rows) return;
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  // Сборът се закръгля до цент при СЪБИРАНЕТО, а не при показването — иначе
  // отпечатаният общ ред не съвпада със сбора на собствените си редове.
  const totalSum = Math.round(rows.reduce((s, r) => s + r.sum, 0) * 100) / 100;
  // Брои се само ЖИВИЯТ комплект — същият ключ, по който го брои и екранът
  // (виж дългата бележка в periodikaYearRows по-горе, находка Б12).
  const inventoried = rows.filter(r => r.live).length;
  setPrintPage({ name: 'Периодични издания ' + year + ' г.', landscape: true, margin: '10mm' });
  doPrint(`
    <div class="pdoc">${shead()}<h2>ПЕРИОДИЧНИ ИЗДАНИЯ — АБОНАМЕНТЕН СПИСЪК</h2>
     <div class="pmeta">за ${esc(String(year))} г. · получени броеве, платена стойност и състояние на годишните комплекти<br>
       Периодичните издания са библиотечни документи и подлежат на регистрация (чл. 13, ал. 3, т. 1; чл. 14; чл. 16).</div>
     <table><thead><tr><th>№</th><th>Заглавие</th><th>ISSN</th><th>Периодичност</th><th>Отдел</th>
       <th>Получени броеве</th><th>Стойност</th><th>Годишен комплект във фонда</th></tr></thead><tbody>
     ${rows.length ? rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.title)}</td><td>${esc(r.issn || '')}</td>
       <td>${esc(r.freq || '')}</td><td>${esc(r.department || '')}</td><td>${r.count}</td><td>${mny(r.sum)}</td>
       <td>${r.vol
         ? 'инв. № ' + esc(String(r.vol.inv_number ?? '—')) + (r.vol.register_date ? ' / ' + bg(r.vol.register_date) : '')
           + (r.deacc ? ' — ОТЧИСЛЕН' : '')
         : (r.count ? 'не е инвентиран' : '—')}</td></tr>`).join('')
       : `<tr><td colspan="8" style="text-align:center">През ${esc(String(year))} г. няма заведени периодични издания.</td></tr>`}
     ${rows.length ? `<tr style="font-weight:700"><td colspan="5">ОБЩО за ${esc(String(year))} г.</td>
       <td>${totalCount}</td><td>${mny(totalSum)}</td>
       <td>${inventoried} от ${rows.length} ${inventoried === 1 ? 'инвентиран комплект' : 'инвентирани комплекта'}</td></tr>` : ''}
     </tbody></table>
     ${rows.some(r => r.count && !r.live) ? `<div class="pmeta">Заглавията с получени броеве и без инвентиран годишен
       комплект <b>във фонда</b> не влизат нито в КДБФ Част № 1, нито в отчета за фонда за ${esc(String(year))} г.
       Отчисленият комплект е бил вписан, но вече е изваден от фонда с акт по чл. 35 и се отчита в КДБФ Част № 3.</div>` : ''}
     ${ssig(['Библиотекар: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printPeriodikaYear = printPeriodikaYear;
async function printPeriodicalCard(id, year) {
  const p = await call(window.api.periodicals.get(id, { year }));
  if (!p) return;
  const issues = p.issues || [];
  const sum = Math.round(issues.reduce((s, i) => s + (Number(i.price) || 0), 0) * 100) / 100;
  const scope = String(p.issue_year) === 'всички' ? 'всички години' : p.issue_year + ' г.';
  setPrintPage({ name: 'Кардекс — ' + p.title + ' ' + scope, margin: '12mm' });
  doPrint(`
    <div class="pdoc">${shead()}<h2>КАРТОН НА ПЕРИОДИЧНО ИЗДАНИЕ (КАРДЕКС)</h2>
     <div class="pmeta"><b>${esc(p.title)}</b>${p.issn ? ' · ISSN ' + esc(p.issn) : ''}
       ${p.freq ? ' · ' + esc(p.freq) : ''}${p.publisher ? ' · ' + esc(p.publisher) : ''}
       ${p.department ? ' · отдел ' + esc(p.department) : ''}<br>Постъпили броеве — ${esc(scope)}</div>
     <table><thead><tr><th>№ на брой</th><th>Дата на постъпване</th><th>Цена</th><th>Забележка</th></tr></thead><tbody>
     ${issues.length ? issues.map(i => `<tr><td>${esc(i.issue_no)}</td><td>${bg(i.date)}</td>
       <td>${mny(i.price)}</td><td>${esc(i.note || '')}</td></tr>`).join('')
       : `<tr><td colspan="4" style="text-align:center">Няма вписани броеве за ${esc(scope)}.</td></tr>`}
     ${issues.length ? `<tr style="font-weight:700"><td>ОБЩО</td><td>${issues.length} ${issues.length === 1 ? 'брой' : 'броя'}</td>
       <td>${mny(sum)}</td><td></td></tr>` : ''}
     </tbody></table>
     <h3>Годишни комплекти във фонда</h3>
     <table><thead><tr><th>Година</th><th>Броеве в кардекса</th><th>Стойност</th><th>Инв. №</th>
       <th>Вписан на</th><th>Състояние</th></tr></thead><tbody>
     ${(p.volumes || []).length ? p.volumes.map(v => `<tr><td>${esc(String(v.year))}</td>
       <td>${Number(v.issue_count) || 0}${v.book_id != null && v.registered_issue_count != null
         && Number(v.registered_issue_count) !== (Number(v.issue_count) || 0)
         ? ' (подвързан с ' + Number(v.registered_issue_count) + ')' : ''}</td>
       <td>${mny(v.book_id != null ? v.volume_price : v.issue_sum)}</td>
       <td>${v.book_id != null ? esc(String(v.inv_number ?? '—')) : '—'}</td>
       <td>${v.register_date ? bg(v.register_date) : '—'}</td>
       <td>${v.book_id == null ? 'не е инвентиран' : (v.deaccession_date ? 'отчислен на ' + bg(v.deaccession_date) : 'във фонда')}</td></tr>`).join('')
       : '<tr><td colspan="6" style="text-align:center">Няма години с вписани броеве.</td></tr>'}
     </tbody></table>
     ${ssig(['Библиотекар: …………………'])}</div>`);
}
window.printPeriodicalCard = printPeriodicalCard;
