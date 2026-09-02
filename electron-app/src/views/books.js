// Книги — включва и "Избор на УДК от таблицата"/ISBN търсене/saveBook/
// deleteBook, които в app.js исторически стояха физически след раздела
// "Читатели"-съседни секции, но функционално са част от Книги.

/* ---------------- Книги ---------------- */
let BOOKS_QUERY = '';
/* Групова редакция — избраните инв. номера се пазят между презарежданията на списъка
   (напр. след прилагане на промяна), но се изчистват при нова търсачка, защото видимият
   набор от записи вече е друг и старият избор губи смисъл. */
let BOOKS_SELECTED = new Set();
let BOOKS_SORT = 'title';
/* Филтри по отдел/категория (v1.70.0) — прилагат се НАД вече изтегления/
   претърсен резултат (window._BOOKS_LIST), без нова обиколка по IPC, по
   същия принцип като „Покажи още“ по-долу: searchText е малцинствен случай,
   филтрирането по вече заредени, ясно изброими стойности няма нужда от
   отделна заявка към базата. '' означава „без филтър“ за съответното поле. */
let BOOKS_FILTER_DEPT = '';
let BOOKS_FILTER_CAT = '';
function booksFilterMatch(b) {
  if (BOOKS_FILTER_DEPT && (b.department || '') !== BOOKS_FILTER_DEPT) return false;
  if (BOOKS_FILTER_CAT && String(b.category_id || '') !== String(BOOKS_FILTER_CAT)) return false;
  return true;
}
/* Прозоречен рендер (Фаза 2): при голям фонд (5 000–15 000+ документа) чертаенето
   на ВСИЧКИ редове наведнъж замразява интерфейса за забележимо време. Вместо да
   местим пагинацията в бекенда (books:list се ползва и другаде за пълен списък —
   експорти, справки, GDPR анонимизация — където трябва целият резултат), тук само
   ограничаваме КОЛКО реда се изчертават в таблицата наведнъж, с бутон „Покажи още“,
   по същия установен модел като публичния каталог (site/page-katalog.html: R/P/page()). */
const BOOKS_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let BOOKS_RENDER_LIMIT = BOOKS_PAGE_SIZE;
function searchListDatalist(id, values) {
  return `<datalist id="${id}">${(values || []).map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
}
function logSearchHistory(kind, q) {
  if (!q || !q.trim()) return;
  window.api.searchHistory.log({ kind, query: q });
}
function booksRowsHtml(shown) {
  return shown.length ? shown.map(b => `
    <tr data-id="${b.id}">
      <td><input type="checkbox" class="bkChk" data-id="${b.id}" onchange="toggleBookSel(${b.id},this.checked)" ${BOOKS_SELECTED.has(b.id) ? 'checked' : ''}></td>
      <td class="num">${b.inv_number ?? ''}</td>
      <td>${esc(b.title)}${b.series ? ` <span class="hint">— ${esc(b.series)}${b.series_no ? ', ' + esc(b.series_no) : ''}</span>` : ''}</td>
      <td>${esc(b.author || '')}</td>
      <td>${esc(b.category_name || '')}</td>
      <td>${esc(b.department || '')}</td>
      <td class="num">${esc(b.year || '')}</td>
      <td><span class="badge ${b.status === 'наличен' ? 'ok' : 'warn'}">${esc(b.status || '')}</span></td>
      <td><span class="badge ${b.available > 0 ? 'ok' : 'warn'}">${b.available}/${b.quantity}</span></td>
      <td><button class="btn sm dgr" onclick="deleteBook(${b.id})">Изтрий</button></td>
    </tr>`).join('') : `<tr><td colspan="10" class="empty">Няма намерени книги.</td></tr>`;
}
function booksMoreHtml(more, total) {
  // append=true → renderBooksBody ДОБАВЯ следващата порция, вместо да презаписва
  // и вече изчертаните редове (виж paintRowWindow в core.js).
  return more > 0 ? `<button class="btn" onclick="BOOKS_RENDER_LIMIT+=${BOOKS_PAGE_SIZE};renderBooksBody(true)">Покажи още (${more} от общо ${total})</button>` : '';
}
/* „Покажи още“ само разширява прозореца на вече изтеглените от сървъра книги
   (window._BOOKS_LIST) — БЕЗ нова обиколка по IPC. По-рано всяко натискане на
   бутона викаше цялата renderBooks(), която пращаше books:list/categories:list/
   searchHistory:suggest наново, макар данните вече да са в паметта: разгръщане
   на голям фонд страница по страница пращаше едни и същи 15 000 реда по IPC
   толкова пъти, колкото пъти е натиснат бутонът. Смяна на подредбата и
   „Избери всички“ остават през пълния renderBooks() — данните там наистина
   може да са различни (нова подредба) или засягат целия резултат отвъд
   текущо изтегления прозорец.

   v2.3.0: append=true (само от бутона „Покажи още“) добавя САМО новата порция.
   Дотогава всяко натискане презаписваше целия <tbody> с rows.slice(0, LIMIT) и
   изчертаваше наново и вече показаните редове — квадратична работа: измерено
   при 15 000 книги, 49 натискания от 300 до 15 000 реда = 112 462 ms, като
   първите натискания бяха ~250 ms, а последните 5 691 ms всяко.
   Всички останали извиквания (търсене, филтър, „Избери всички“, презареждане)
   остават пълен рендер — там наборът от редове е ДРУГ и добавяне би долепило
   нови редове към стар резултат. BOOKS_PAINTED пази колко реда стоят в тялото;
   paintRowWindow() допълнително проверява това срещу самия DOM. */
let BOOKS_PAINTED = 0;
/* Смяната на филтър изчиства избора — точно както го прави търсенето
   (виж слушателя на #bSearch по-долу).

   Одит v2.4.16: двата падащи филтъра само пречертаваха тялото на таблицата.
   BOOKS_SELECTED оставаше пълен с редове, които вече не се виждат никъде, а
   заглавната отметка се показваше празна и без междинно състояние. Оттам
   „Групова редакция…“ и „Във витрина…“ пращаха към главния процес идентата на
   документи, които библиотекарят не вижда — а груповата редакция сама предупреждава,
   че действието не може да бъде отменено. Единственият знак беше малка подсказка
   „N избрани“ встрани. */
function booksFilterChanged() {
  BOOKS_SELECTED.clear();
  BOOKS_RENDER_LIMIT = BOOKS_PAGE_SIZE;
  renderBooksBody();
  updateBulkBar();
  syncChkAll();
}
window.booksFilterChanged = booksFilterChanged;
function renderBooksBody(append) {
  const books = (window._BOOKS_LIST || []).filter(booksFilterMatch);
  BOOKS_PAINTED = paintRowWindow({
    body: '#bBody', bar: '#bMore', rows: books, limit: BOOKS_RENDER_LIMIT,
    painted: append ? BOOKS_PAINTED : 0,
    rowsHtml: booksRowsHtml, moreHtml: booksMoreHtml
  });
  syncChkAll();
}
window.renderBooksBody = renderBooksBody;
/* Заглавната отметка следва реалния избор (v2.2.0): ✓ само когато са избрани
   ВСИЧКИ редове от текущия резултат, „частично“ (indeterminate) при част от тях.
   Дотогава toggleBookSel() не я пипаше — след „Избери всички“ и махане на един
   ред отметката оставаше ✓ и показваше нещо, което не е вярно. */
function syncChkAll() {
  const chkAll = $('#chkAll');
  if (!chkAll) return;
  const books = (window._BOOKS_LIST || []).filter(booksFilterMatch);
  const sel = books.filter(b => BOOKS_SELECTED.has(b.id)).length;
  chkAll.checked = books.length > 0 && sel === books.length;
  chkAll.indeterminate = sel > 0 && sel < books.length;
}
window.syncChkAll = syncChkAll;
/* Ново търсене: данните се вземат наново от базата (търсенето е сървърно), но се
   пипат САМО тялото на таблицата и лентата под нея — полето #bSearch НЕ се
   пресъздава. Дотогава debounce-ът викаше цялата renderBooks() и подменяше
   #view заедно със самото поле: при писане „Иван Вазов“ с пауза над 300 ms
   фокусът изчезваше и следващите знаци отиваха в нищото. */
async function refreshBooksList() {
  const books = await call(window.api.books.list(BOOKS_QUERY, BOOKS_SORT));
  if (!books) return;
  window._BOOKS_LIST = books;
  const visibleIds = new Set(books.map(b => b.id));
  for (const id of [...BOOKS_SELECTED]) if (!visibleIds.has(id)) BOOKS_SELECTED.delete(id);
  renderBooksBody();
  updateBulkBar();
}
window.refreshBooksList = refreshBooksList;
async function renderBooks() {
  const [books, cats, searchSuggest] = await Promise.all([
    call(window.api.books.list(BOOKS_QUERY, BOOKS_SORT)), call(window.api.categories.list()),
    call(window.api.searchHistory.suggest('books'))
  ]);
  if (!books) return;
  window._CATS = cats || [];
  window._BOOKS_LIST = books;
  const visibleIds = new Set(books.map(b => b.id));
  for (const id of [...BOOKS_SELECTED]) if (!visibleIds.has(id)) BOOKS_SELECTED.delete(id);
  const n = BOOKS_SELECTED.size;
  const filtered = books.filter(booksFilterMatch);
  const shown = filtered.slice(0, BOOKS_RENDER_LIMIT);
  const more = filtered.length - shown.length;
  // Отделите за филтъра идват от вече заредения резултат (реално ползвани стойности),
  // обединени с фиксираните OTDELI — така филтърът винаги показва само отдели, които
  // реално имат поне един документ в текущия резултат от търсенето.
  const deptSeen = [...new Set(books.map(b => b.department).filter(Boolean))];
  const deptOpts = [...new Set([...OTDELI, ...deptSeen])];
  $('#view').innerHTML = `
    <div class="note">Редакцията на вече вписан документ става от раздел <b>„Инвентарна книга“</b> —
    с изрично потвърждение, защото тя е официалният регистър на фонда (v1.71.0). Тук остават
    търсенето, филтрите, груповата редакция и добавянето на нови документи.</div>
    <div class="toolbar">
      <input type="search" id="bSearch" list="dl_searchBooks" placeholder="Търсене по заглавие, автор, ISBN, баркод или инв. №…" value="${esc(BOOKS_QUERY)}">
      <select onchange="BOOKS_SORT=this.value;BOOKS_RENDER_LIMIT=BOOKS_PAGE_SIZE;renderBooks()" title="Подредба — сигнатурата се нарежда правилно („Ч-9“ преди „Ч-84“)">
        <option value="title" ${BOOKS_SORT === 'title' ? 'selected' : ''}>По заглавие</option>
        <option value="cn" ${BOOKS_SORT === 'cn' ? 'selected' : ''}>По сигнатура</option>
        <option value="inv" ${BOOKS_SORT === 'inv' ? 'selected' : ''}>По инв. №</option>
      </select>
      <select id="bDeptFilter" onchange="BOOKS_FILTER_DEPT=this.value;booksFilterChanged()" title="Филтър по отдел / местонахождение">
        <option value="">— всички отдели —</option>
        ${deptOpts.map(d => `<option value="${esc(d)}" ${BOOKS_FILTER_DEPT === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
      </select>
      <select id="bCatFilter" onchange="BOOKS_FILTER_CAT=this.value;booksFilterChanged()" title="Филтър по вид документ (категория)">
        <option value="">— всички категории —</option>
        ${(window._CATS || []).map(c => `<option value="${c.id}" ${String(BOOKS_FILTER_CAT) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <span class="hint" id="bulkCount" ${n ? '' : 'style="display:none"'}>${n} избрани</span>
      <button class="btn" id="bulkBtn" onclick="openBulkEdit()" ${n ? '' : 'disabled'}>Групова редакция…</button>
      <button class="btn" id="bulkShelfBtn" onclick="bulkAddToShelf()" ${n ? '' : 'disabled'}
        title="Добавя маркираните документи в тематична витрина на онлайн каталога">Във витрина…</button>
      <button class="btn pri" onclick="bookForm()">+ Нова книга</button>
    </div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th style="width:26px"><input type="checkbox" id="chkAll" onchange="toggleBookSelAll(this.checked)"
        ${filtered.length && filtered.every(b => BOOKS_SELECTED.has(b.id)) ? 'checked' : ''}></th>
        <th>Инв. №</th><th>Заглавие</th><th>Автор</th><th>Категория</th><th>Отдел</th><th>Год.</th><th>Състояние</th><th>Наличност</th><th style="width:90px"></th></tr></thead>
      <tbody id="bBody">${booksRowsHtml(shown)}</tbody>
    </table></div>
    <div class="toolbar" id="bMore" style="justify-content:center">${booksMoreHtml(more, filtered.length)}</div>
    ${searchListDatalist('dl_searchBooks', searchSuggest)}
  `;
  // Таблицата е изчертана направо в #view — броячът трябва да знае колко реда
  // има вътре, за да може следващото „Покажи още“ само да ДОБАВИ порция.
  BOOKS_PAINTED = shown.length;
  $('#bSearch').addEventListener('input', debounce(e => { BOOKS_QUERY = e.target.value; BOOKS_SELECTED.clear(); BOOKS_RENDER_LIMIT = BOOKS_PAGE_SIZE; refreshBooksList(); }, 300));
  $('#bSearch').addEventListener('change', e => logSearchHistory('books', e.target.value));
  syncChkAll(); // и при пълен рендер отметката отразява частичен избор
}
function toggleBookSel(id, checked) {
  if (checked) BOOKS_SELECTED.add(id); else BOOKS_SELECTED.delete(id);
  syncChkAll(); // иначе заглавната отметка остава ✓ след махане на един ред
  updateBulkBar();
}
window.toggleBookSel = toggleBookSel;
function toggleBookSelAll(checked) {
  // "Избери всички" означава всички книги от текущия резултат от търсенето И филтъра —
  // не само редовете, заредени в момента в таблицата (при windowed рендер може да е само
  // част от тях), затова минаваме по window._BOOKS_LIST (филтрирано с booksFilterMatch),
  // а не по DOM чек-боксовете. Селекцията не сменя кои книги съществуват, затова е
  // достатъчен renderBooksBody() (без ново IPC).
  const ids = (window._BOOKS_LIST || []).filter(booksFilterMatch).map(b => b.id);
  if (checked) ids.forEach(id => BOOKS_SELECTED.add(id));
  else ids.forEach(id => BOOKS_SELECTED.delete(id));
  renderBooksBody();
  updateBulkBar();
}
window.toggleBookSelAll = toggleBookSelAll;
function updateBulkBar() {
  const n = BOOKS_SELECTED.size;
  const c = $('#bulkCount'), b = $('#bulkBtn'), sb = $('#bulkShelfBtn');
  if (c) { c.textContent = n + ' избрани'; c.style.display = n ? '' : 'none'; }
  if (b) b.disabled = !n;
  if (sb) sb.disabled = !n;
}
/* Полето и допустимите му стойности за груповата редакция — списъкът и опциите
   огледално следват падащите менюта от формата за книга (bookForm), с два изключения:
   „Състояние“ никога не предлага „отчислен“ (отчисляването минава само през формален
   акт, вж. main.js) и всяко поле показва само собствените си опции. */
const BULK_EDIT_FIELDS = [
  ['department', 'Отдел / местонахождение', OTDELI.map(v => ({ v, t: v }))],
  ['status', 'Състояние', ['наличен', 'липсващ', 'за реставрация'].map(v => ({ v, t: v }))],
  ['language', 'Език', EZICI.map(v => ({ v, t: v }))],
  ['category_id', 'Вид документ (категория)', null] // опциите се вземат от window._CATS при отваряне
];
function bulkEditValueField(field) {
  const def = BULK_EDIT_FIELDS.find(([f]) => f === field);
  if (!def) return '';
  const opts = field === 'category_id' ? (window._CATS || []).map(c => ({ v: c.id, t: c.name })) : def[2];
  return fld('Нова стойност', 'bulkValue', { type: 'select', opts, allowEmpty: false });
}
function openBulkEdit() {
  const n = BOOKS_SELECTED.size;
  if (!n) return;
  modal('Групова редакция — ' + n + ' избрани документа', `
    <div class="note" style="margin-top:0">Избраното поле се записва с една и съща стойност във всички
    ${n} маркирани документа. Действието не може да се отмени с бутон „Назад“ — прегледайте избора
    в таблицата, преди да продължите.</div>
    <form id="bulkF" onsubmit="return false">
      ${fld('Поле за промяна', 'bulkField', { type: 'select', allowEmpty: false,
        opts: BULK_EDIT_FIELDS.map(([v, t]) => ({ v, t })), onchange: 'refreshBulkValueField()' })}
      <div id="bulkValueWrap">${bulkEditValueField(BULK_EDIT_FIELDS[0][0])}</div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="applyBulkEdit()">Приложи върху ${n} документа</button>`);
}
window.openBulkEdit = openBulkEdit;
function refreshBulkValueField() {
  const field = $('#bulkF [name=bulkField]').value;
  $('#bulkValueWrap').innerHTML = bulkEditValueField(field);
}
window.refreshBulkValueField = refreshBulkValueField;
async function applyBulkEdit() {
  const d = formData('#bulkF');
  if (!d.bulkValue) return toast('Изберете стойност.', 'err');
  const ids = [...BOOKS_SELECTED];
  const changed = await call(window.api.books.bulkUpdate({ ids, field: d.bulkField, value: d.bulkValue }));
  if (changed == null) return;
  closeModal();
  toast(changed + ' документ(а) обновени.', 'ok'); markSaved();
  BOOKS_SELECTED.clear();
  renderBooks();
}
window.applyBulkEdit = applyBulkEdit;

/* Опции за падащо меню от номенклатура: списъкът от Настройки → „Номенклатури";
   стойност, която вече стои в записа, но е извадена от списъка, се добавя накрая,
   за да не се загуби мълчаливо при следващото записване на формата. */
function avSelectOpts(avList, fallback, current) {
  const vals = (avList && avList.length) ? avList.map(o => o.value) : fallback.slice();
  if (current && !vals.includes(current)) vals.push(current);
  return vals;
}
/* `prefill` (v2.4.21) идва само от bookCopyForm: НОВ запис, чието описание е
   копирано от съществуващ екземпляр. Формата е същата — различава се само откъде
   идват началните стойности и заглавието на прозореца. */
async function bookForm(id, presetAcqId, prefill) {
  const b = id ? await call(window.api.books.get(id)) : null;
  const [cats, acqs, sug, av] = await Promise.all([
    call(window.api.categories.list()), call(window.api.acquisitions.list()), loadAuthSuggest(),
    call(window.api.av.options())
  ]);
  const v = prefill || b || { register_date: today(), status: 'наличен', language: 'български', department: 'за възрастни', acquisition_id: presetAcqId || '' };
  const AV = av || {};
  const catOpts = (cats || []).map(c => ({ v: c.id, t: c.name }));
  const acqOpts = (acqs || []).map(a => ({ v: a.id, t: '№ ' + a.no + '/' + a.year + ' — ' + (a.from_source || '') }));
  modal(id ? 'Инв. № ' + v.inv_number + ' — редакция'
    : prefill ? 'Още един екземпляр от „' + (v.title || '') + '“'
    : 'Нов документ във фонда', `
    <div class="note"><b>Чл. 16, ал. 1</b> — индивидуалната регистрация съдържа: дата на вписване, инвентарен номер, автор,
    заглавие, том, година, цена, номер и дата на вписване в КДБФ, сигнатура.</div>
    ${prefill ? `<div class="note d">Това е <b>нов запис</b> със <b>свой инвентарен номер</b> — един инвентарен номер
      отговаря на един екземпляр. Описанието е копирано от инв. № ${esc(String(prefill.copied_from ?? ''))};
      баркодът остава празен (етикетът се лепи на конкретния екземпляр) и се попълва от „Баркод етикети“.</div>` : ''}
    <form id="bookF" onsubmit="return false">
    <fieldset><legend>Инвентиране</legend>
      <div class="grid g3">
        ${fld('Инвентарен номер', 'inv_number', { val: v.inv_number ?? '', type: 'number', req: 1 })}
        ${fld('Дата на вписване', 'register_date', { val: v.register_date, type: 'date', req: 1 })}
        ${fld('Баркод', 'barcode', { val: v.barcode || '', hint: 'празно = инв. номер' })}
      </div>
      <div class="grid g3">
        ${fld('Вид документ (категория)', 'category_id', { type: 'select', opts: catOpts, val: v.category_id || '' })}
        ${fld('Партида в КДБФ', 'acquisition_id', { type: 'select', opts: acqOpts, val: v.acquisition_id || '', emptyLabel: '— без партида —' })}
        ${fld('Сигнатура', 'call_number', { val: v.call_number || '' })}
      </div>
      <div class="grid g4">
        ${fld('Цена (лв.)', 'price', { val: v.price ?? 0, type: 'number', step: '0.01', req: 1 })}
        ${fld('Цена (€)', 'price_eur', { val: eur(v.price || 0), type: 'number', step: '0.01', hint: 'автоматично при промяна' })}
        ${fld('Отдел / местонахождение', 'department', { type: 'select', opts: avSelectOpts(AV.department, OTDELI, v.department), val: v.department })}
        ${/* ЕДИН ИНВЕНТАРЕН НОМЕР = ЕДИН ЕКЗЕМПЛЯР. Дотук тук стоеше свободно
              числово поле „Налични бройки“, а наръчникът изрично учеше библиотекаря
              да впише в него броя екземпляри — тоест програмата предлагаше запис,
              който инвентарната книга не допуска. Полето отпада: картонът не
              праща бройка, книгата е един екземпляр, а вторият се завежда с бутона
              „+ Още екземпляр“ по-долу. Стар неразделен запис (бройка ≠ 1, внесена
              стара база) се показва като предупреждение — и НЕ се пипа при
              записване (books:update пази непратена бройка), защото сплескването
              му до 1 би отнело документи от фонда тихо. */
          (id && v.quantity != null && Number(v.quantity) !== 1)
          ? `<div class="field"><label>Екземпляри под този номер</label>
              <input type="text" value="${esc(String(v.quantity))} — стар запис" disabled>
              <span class="fh" style="color:#b00">Един инвентарен номер отговаря на един екземпляр. Поправя се от „Настройки“ → „Проверка на данните“; записването тук не променя бройката.</span></div>`
          : `<div class="field"><label>Екземпляр</label>
              <input type="text" value="1 — един инвентарен номер, един екземпляр" disabled>
              <span class="fh">втори екземпляр: бутонът „+ Още екземпляр“</span></div>`}
      </div>
      <div class="grid g4">
        ${fld('Постоянно място', 'permanent_location', { type: 'select',
          opts: avSelectOpts(AV.location, [], v.permanent_location), val: v.permanent_location || '',
          emptyLabel: '— без отбелязване —' })}
        <div class="field"><label>Последно видяна</label>
          <input value="${v.datelastseen ? esc(bg(String(v.datelastseen).slice(0, 10))) : '—'}" disabled
            title="Попълва се само от сканиране при инвентаризация"></div>
      </div>
      <div class="hint" style="margin-top:-4px">„Постоянно място“ пази рафта/шкафа, докато документът е временно
      на витрина или изложба (сменя се само „Отдел / местонахождение“). Списъкът с местата се води в
      Настройки → „Номенклатури“.</div>
    </fieldset>
    <fieldset><legend>Библиографско описание</legend>
      <div class="grid g2">
        ${fld('Заглавие', 'title', { val: v.title || '', req: 1 })}
        ${fld('Автор (фамилия, име)', 'author', { val: v.author || '', list: 'author', hint: 'предлага се от вече въведените' })}
      </div>
      <div class="grid g4">
        ${fld('Подзаглавие', 'subtitle', { val: v.subtitle || '' })}
        ${fld('Място на издаване', 'city', { val: v.city || '', list: 'city' })}
        ${fld('Издателство', 'publisher', { val: v.publisher || '', list: 'publisher' })}
        ${fld('Година', 'year', { val: v.year || '' })}
      </div>
      <div class="grid g2">
        ${fld('Поредица', 'series', { val: v.series || '', list: 'series', hint: 'за многотомни/номерирани издания' })}
        ${fld('№ в поредицата', 'series_no', { val: v.series_no || '', hint: 'напр. „кн. 3“' })}
      </div>
      <div class="grid gIsbn">
        ${fld('Том / част', 'volume', { val: v.volume || '' })}
        <div class="field"><label>ISBN / ISSN</label>
          <div class="isbnRow">
            <input name="isbn" value="${esc(v.isbn || '')}">
            <button type="button" class="btn" id="isbnBtn" onclick="isbnLookup()"
              title="Изтегля данните за книгата от Google Books и Open Library">Търси</button>
            <button type="button" class="btn" id="sruBtn" onclick="sruLookup()"
              title="Въвежда истински библиотечен MARC запис през SRU (по подразбиране — каталогът на Library of Congress)">SRU…</button>
          </div>
          <div class="hint" id="isbnHint">Въведете ISBN и натиснете „Търси“ (търговски данни) или „SRU…“ (библиотечен MARC запис) — полетата се попълват сами.</div>
        </div>
        ${fld('Страници', 'pages', { val: v.pages || '' })}
        ${fld('Език', 'language', { type: 'select', opts: avSelectOpts(AV.language, EZICI, v.language), val: v.language })}
      </div>
      <div class="grid g4">
        <div class="field"><label>УДК</label>
          <div class="isbnRow">
            <input name="udk" value="${esc(v.udk || '')}" list="dl_udk">
            <button type="button" class="btn" onclick="udkPicker()"
              title="Избор от таблицата на УДК">Избери…</button>
          </div>
        </div>
        ${fld('Авторски знак', 'author_mark', { val: v.author_mark || '', hint: 'напр. „В-15“' })}
        ${fld('Ключови думи', 'keywords', { val: v.keywords || '', list: 'keywords', hint: 'през запетая' })}
        ${fld('Адрес на корица (URL)', 'cover_url', { val: v.cover_url || '' })}
      </div>
      <div class="grid g3">
        ${/* „Отчислен" НЕ е избираемо състояние. Отчисляването е формален акт по
              чл. 30 – 39 (комисия, причина, начин на разпореждане, ред в КДБФ
              Приложение № 3) и минава единствено през „Отчисляване → Нов акт".
              Дотук падащото меню го предлагаше — един избор от списък отчисляваше
              документ без акт, без комисия и без ред в КДБФ, а коментарът при
              BULK_EDIT_FIELDS по-горе вече твърдеше, че това никога не се предлага.
              Обратно: вече отчислен документ показва състоянието си като текст и го
              носи в СКРИТО поле. Ако опцията просто отпаднеше, <select> без
              съвпадаща стойност избира първата — и всяко записване на картона на
              отчислен документ мълчаливо би го върнало като „наличен". */
          v.status === 'отчислен'
          ? `<div class="field"><label>Състояние <span class="fh">променя се само с акт</span></label>
              <input type="hidden" name="status" value="отчислен">
              <input type="text" value="отчислен${v.status_date ? ' — от ' + bg(v.status_date) : ''}" disabled>
              <span class="fh">Връщане във фонда става само с анулиране на акта: „Отчисляване“ → отваряте акта → „Анулирай акта“.</span></div>`
          : fld('Състояние', 'status', { type: 'select', opts: ['наличен', 'липсващ', 'за реставрация'], val: v.status, allowEmpty: false,
              hint: v.status_date ? 'от ' + bg(v.status_date) : '' })}
        ${fld('Забележка', 'description', { val: v.description || '', hint: 'поправки не се допускат — чл. 17, ал. 2' })}
        ${fld('Анотация', 'annotation', { type: 'textarea', val: v.annotation || '', rows: 2 })}
      </div>
    </fieldset>
    </form>
    ${datalistsHtml(sug || {})}`,
    `${id ? `<button class="btn l" onclick="bookCopyForm(${id})"
        title="Създава НОВ запис със следващия инвентарен номер и същото описание — един инвентарен номер отговаря на един екземпляр">+ Още екземпляр</button>` : ''}
     <button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveBook(${id || 'null'})">Запиши</button>`);
  if (id) $('#bookF').dataset.id = id;
  const priceEl = $('#bookF [name=price]'), priceEurEl = $('#bookF [name=price_eur]');
  if (priceEl && priceEurEl) {
    priceEl.addEventListener('input', () => { priceEurEl.value = eur(priceEl.value); });
    priceEurEl.addEventListener('input', () => { priceEl.value = (parseFloat(priceEurEl.value || 0) * EUR_RATE).toFixed(2); });
  }
}
window.bookForm = bookForm;
/* „+ Още екземпляр“ — вторият екземпляр от едно заглавие е ВТОРИ ЗАПИС със свой
   инвентарен номер, а не число в полето на първия. Копира се библиографското
   описание, цената, партидата в КДБФ и отделът; НЕ се копират инвентарният номер
   (взима се следващият свободен), баркодът (лепи се на конкретния екземпляр и
   дубликат в него разваля сканирането), забележката за конкретния екземпляр,
   датата на последното сканиране и датата на статуса. */
async function bookCopyForm(id) {
  const src = await call(window.api.books.get(id));
  if (!src) return;
  const s = await call(window.api.settings.get());
  const v = Object.assign({}, src);
  delete v.id;
  v.copied_from = src.inv_number;
  v.inv_number = (s && s.next_inv_number) || '';
  v.barcode = '';
  v.description = '';
  v.status = 'наличен';
  v.status_date = '';
  v.datelastseen = '';
  v.quantity = 1;
  v.register_date = today();
  closeModal();
  bookForm(null, null, v);
}
window.bookCopyForm = bookCopyForm;
/* ---------------- Избор на УДК от таблицата ----------------
   Прозорецът се отваря върху формата за книга. Изборът замества стойността в
   полето, а определителите се добавят накрая — полето остава свободен текст, за
   да не пречи на съставни кодове, каквито таблицата не покрива. */
function udkPicker() {
  const rows = UDK_TREE.map(([code, name, subs]) => `
    <div class="udkGroup">
      <div class="udkMain">${esc(code)} — ${esc(name)}</div>
      <div class="udkSubs">
        ${subs.map(([c, t]) => `<button type="button" class="udkItem" onclick="udkPick('${esc(c)}')">
          <span class="udkCode">${esc(c)}</span><span class="udkLbl">${esc(t)}</span></button>`).join('')}
      </div>
    </div>`).join('');
  modal2('Универсална десетична класификация (УДК)', `
    <div class="note" style="margin-top:0">Изберете раздел — кодът влиза в полето „УДК“.
    Определителите по-долу се добавят към вече избрания код.</div>
    <input class="udkSearch" id="udkQ" placeholder="Търсене по код или наименование…" oninput="udkFilter()">
    <div id="udkList">${rows}</div>
    <div class="udkGroup" style="margin-top:12px">
      <div class="udkMain">Общи определители (добавят се накрая)</div>
      <div class="udkSubs">
        ${UDK_MODIFIERS.map(([c, t]) => `<button type="button" class="udkItem" onclick="udkAppend('${esc(c)}')">
          <span class="udkCode">${esc(c)}</span><span class="udkLbl">${esc(t)}</span></button>`).join('')}
      </div>
    </div>`,
    `<button class="btn" onclick="closeModal2()">Затвори</button>`);
  setTimeout(() => { const q = $('#udkQ'); if (q) q.focus(); }, 50);
}
window.udkPicker = udkPicker;
function udkFilter() {
  const q = ($('#udkQ').value || '').trim().toLowerCase();
  document.querySelectorAll('#udkList .udkGroup').forEach(g => {
    let shown = 0;
    g.querySelectorAll('.udkItem').forEach(it => {
      const hit = !q || it.textContent.toLowerCase().includes(q);
      it.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    g.style.display = shown ? '' : 'none';
  });
}
window.udkFilter = udkFilter;
function udkTargetInput() { return $('#bookF [name=udk]'); }
function udkPick(code) {
  const el = udkTargetInput();
  if (el) { el.value = code; toast('УДК ' + code, 'ok'); }
  closeModal2();
}
window.udkPick = udkPick;
function udkAppend(mod) {
  const el = udkTargetInput();
  if (!el) return;
  el.value = (el.value || '').trim() + mod;
  toast('УДК ' + el.value, 'ok');
  closeModal2();
}
window.udkAppend = udkAppend;

/* Търсене по ISBN в Google Books и Open Library. Попълват се само празните полета —
   вече въведеното от библиотекаря никога не се презаписва, защото данните от двете
   услуги не винаги са точни и описанието по Наредба № 3 е негова отговорност. */
async function isbnLookup() {
  const f = $('#bookF'); if (!f) return;
  const btn = $('#isbnBtn'), hint = $('#isbnHint');
  const isbn = (f.querySelector('[name=isbn]') || {}).value || '';
  if (!isbn.trim()) return toast('Първо въведете ISBN.', 'err');
  btn.disabled = true; btn.textContent = 'Търси…';
  hint.textContent = 'Търси в Google Books и Open Library…';
  try {
    const r = await window.api.isbn.lookup(isbn);
    if (!r || !r.ok) {
      hint.textContent = (r && r.error) || 'Търсенето не успя.';
      return toast((r && r.error) || 'Търсенето не успя.', 'err');
    }
    const filled = [], skipped = [];
    const LABELS = { title: 'Заглавие', subtitle: 'Подзаглавие', author: 'Автор', publisher: 'Издателство',
      city: 'Място на издаване', year: 'Година', pages: 'Страници', language: 'Език',
      keywords: 'Ключови думи', annotation: 'Анотация', cover_url: 'Корица', isbn: 'ISBN' };
    for (const [k, val] of Object.entries(r.data)) {
      if (k === 'sources' || !val) continue;
      const el = f.querySelector(`[name="${k}"]`);
      if (!el) continue;
      if (el.value && el.value.trim()) { if (k !== 'isbn') skipped.push(LABELS[k] || k); continue; }
      el.value = val;
      if (k !== 'isbn') filled.push(LABELS[k] || k);
    }
    hint.textContent = filled.length
      ? `Попълнено от ${r.data.sources}: ${filled.join(', ')}.` +
        (skipped.length ? ` Запазени непроменени: ${skipped.join(', ')}.` : '')
      : `Намерено в ${r.data.sources}, но всички полета вече са попълнени.`;
    toast(filled.length ? `Попълнени ${filled.length} полета от ${r.data.sources}.`
                        : 'Полетата вече са попълнени.', 'ok');
  } catch (e) {
    hint.textContent = 'Няма връзка с интернет или услугата не отговаря.';
    toast('Няма връзка с интернет или услугата не отговаря.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Търси';
  }
}
window.isbnLookup = isbnLookup;

/* SRU (Search/Retrieve via URL) — внася истински библиотечен MARC запис вместо търговски
   метаданни. Същото правило както при isbnLookup: попълват се само празните полета. */
async function sruLookup() {
  const f = $('#bookF'); if (!f) return;
  const btn = $('#sruBtn'), hint = $('#isbnHint');
  const isbn = (f.querySelector('[name=isbn]') || {}).value || '';
  if (!isbn.trim()) return toast('Първо въведете ISBN.', 'err');
  btn.disabled = true; btn.textContent = 'Търси…';
  hint.textContent = 'Търси в SRU каталога…';
  try {
    const r = await window.api.sru.lookup(isbn);
    if (!r || !r.ok) {
      hint.textContent = (r && r.error) || 'Търсенето не успя.';
      return toast((r && r.error) || 'Търсенето не успя.', 'err');
    }
    const filled = [], skipped = [];
    const LABELS = { title: 'Заглавие', subtitle: 'Подзаглавие', author: 'Автор', publisher: 'Издателство',
      city: 'Място на издаване', year: 'Година', pages: 'Страници', language: 'Език',
      keywords: 'Ключови думи', isbn: 'ISBN' };
    for (const [k, val] of Object.entries(r.data)) {
      if (k === 'source' || k === 'annotation' || k === 'cover_url' || !val) continue;
      const el = f.querySelector(`[name="${k}"]`);
      if (!el) continue;
      if (el.value && el.value.trim()) { if (k !== 'isbn') skipped.push(LABELS[k] || k); continue; }
      el.value = val;
      if (k !== 'isbn') filled.push(LABELS[k] || k);
    }
    hint.textContent = filled.length
      ? `Попълнено от ${r.data.source}: ${filled.join(', ')}.` +
        (skipped.length ? ` Запазени непроменени: ${skipped.join(', ')}.` : '')
      : `Намерено в ${r.data.source}, но всички полета вече са попълнени.`;
    toast(filled.length ? `Попълнени ${filled.length} полета от ${r.data.source}.`
                        : 'Полетата вече са попълнени.', 'ok');
  } catch (e) {
    hint.textContent = 'Няма връзка с интернет или SRU сървърът не отговаря.';
    toast('Няма връзка с интернет или SRU сървърът не отговаря.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'SRU…';
  }
}
window.sruLookup = sruLookup;

async function saveBook(id) {
  // v1.70.0: обща проверка на ВСИЧКИ полета с req:1 (преди се проверяваха ръчно
  // само заглавие/инв. номер — датата на вписване и цената носеха req:1, но
  // никога не се проверяваха, ако останеха празни).
  const missing = firstMissingRequired('#bookF');
  if (missing) return toast(missing + ' е задължително поле.', 'err');
  const d = formData('#bookF');
  d.id = id;
  // books:create връща id на новия запис — пази се, за да светне редът му след
  // пререндирането (flashRow, v1.69.0). При неуспех call() връща null → без открояване.
  // v2.2.0: формата се затваря САМО при успех (модел от saveAcq/saveAct/savePayment).
  // Дотогава closeModal() беше безусловен: при дублиран инв. номер тостът светваше,
  // но формата вече беше затворена и всички попълнени полета — изгубени.
  let savedId = id;
  if (id) { if (await call(window.api.books.update(d), 'Книгата е обновена.') === null) return; }
  else { savedId = await call(window.api.books.create(d), 'Книгата е добавена.'); if (savedId === null) return; }
  closeModal(); await RENDERERS[VIEW]();
  if (savedId) flashRow(`#view tr[data-id="${savedId}"]`);
}
window.saveBook = saveBook;
/* Второто щракване НЕ бива да минава през същия безобиден въпрос. Главният процес
   позволява изтриване на запис със затворена история при повторно натискане до 2
   минути; ако тук стоеше пак „Да изтрия ли тази книга?", най-естественият рефлекс
   („не стана — да натисна пак") щеше да заличава историята на заеманията, а път за
   връщане назад няма. Затова предупреждението от отказа се показва като истински
   въпрос, дословно, преди второто изпращане. */
const PENDING_DELETE = new Map(); // ключ „вид:id" → текстът на отказа
async function confirmDangerousDelete(key, plainQuestion, send, okMsg, after) {
  const pending = PENDING_DELETE.get(key);
  if (pending) {
    PENDING_DELETE.delete(key);
    if (!confirm('НЕОБРАТИМО\n\n' + pending + '\n\nНаистина ли да продължа?')) return;
  } else if (!confirm(plainQuestion)) {
    return;
  }
  const res = await send();
  if (!res.ok) {
    // Отказът заради история носи изричното „натиснете още веднъж" — само него помним.
    if (/още веднъж/.test(res.error || '')) PENDING_DELETE.set(key, res.error);
    return toast(res.error, 'err');
  }
  toast(okMsg, 'ok'); markSaved();
  after();
}
window.confirmDangerousDelete = confirmDangerousDelete;
async function deleteBook(id) {
  await confirmDangerousDelete('book:' + id, 'Да изтрия ли тази книга?',
    () => window.api.books.delete(id), 'Книгата е изтрита.', () => RENDERERS[VIEW]());
}
window.deleteBook = deleteBook;
