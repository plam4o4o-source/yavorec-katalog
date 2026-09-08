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
/* v2.4.31 (производителност): порциите идват от БАЗАТА — books:list(query, sort,
   { offset, limit, dept, cat }) връща { rows, total, depts }. При 15 000 документа
   пълният списък беше 5,5 МБ и ~150 ms в SQLite при всяко отваряне на „Книги“ и
   всяко търсене (измерено), а на екрана стоят 300 реда. Филтрите по отдел и
   категория също се прилагат в базата. Ако обработчикът върне масив (стар
   обработчик, тестов заместител), изгледът работи както досега — целият списък
   в паметта, филтри и „Покажи още“ без IPC. */
let BOOKS_WINDOWED = false;
let BOOKS_TOTAL = 0;
let BOOKS_DEPTS = [];
let BOOKS_REQ = 0; // пореден номер на ПЪЛНОТО зареждане — закъснял отговор на старо търсене не се рисува
let BOOKS_GEN = 0; // поколение на списъка в паметта — „Покажи още“ долепя само към същия списък
/* limit: при пълен рендер — досегашният прозорец (BOOKS_RENDER_LIMIT), за да не се
   свива разгърнат списък след запис/изтриване; при „Покажи още“ — една порция. */
async function booksFetch(offset, limit) {
  const res = await call(window.api.books.list(BOOKS_QUERY, BOOKS_SORT,
    { offset, limit: Math.min(limit || BOOKS_PAGE_SIZE, 2000), dept: BOOKS_FILTER_DEPT || '', cat: BOOKS_FILTER_CAT || '' }));
  if (!res) return null;
  if (Array.isArray(res)) { BOOKS_WINDOWED = false; return { all: res }; }
  BOOKS_WINDOWED = true;
  BOOKS_TOTAL = res.total || 0;
  BOOKS_DEPTS = res.depts || [];
  return res;
}
function booksSetList(rows) { window._BOOKS_LIST = rows; BOOKS_GEN++; }
let BOOKS_MORE_PENDING = false;
async function booksMore() {
  if (!BOOKS_WINDOWED) { BOOKS_RENDER_LIMIT += BOOKS_PAGE_SIZE; renderBooksBody(true); return; }
  /* Проверка при прегледа (v2.4.31): `loaded` се четеше преди await-а, без предпазител
     срещу повторно влизане — двоен клик върху „Покажи още“, преди първата порция да
     се върне, изпращаше ДВЕ заявки с ЕДИН И СЪЩ offset. И двете минаваха проверката
     за поколение (gen не се сменя от самия booksMore) и се долепяха последователно:
     резултатът беше 300 дублирани реда и ЦЯЛА следваща порция, изтеглена никога —
     библиотекар, стигнал до края на списъка, вярваше, че е видял всичко. */
  if (BOOKS_MORE_PENDING) return;
  BOOKS_MORE_PENDING = true;
  try {
    const gen = BOOKS_GEN;
    const loaded = (window._BOOKS_LIST || []).length;
    const res = await booksFetch(loaded, BOOKS_PAGE_SIZE);
    // Междувременно търсене/филтър е подменил списъка — тази порция е от стария резултат.
    if (!res || gen !== BOOKS_GEN) return;
    window._BOOKS_LIST = (window._BOOKS_LIST || []).concat(res.all ? res.all.slice(loaded) : res.rows);
    BOOKS_RENDER_LIMIT = Math.max(BOOKS_RENDER_LIMIT, window._BOOKS_LIST.length);
    renderBooksBody(true);
  } finally {
    BOOKS_MORE_PENDING = false;
  }
}
window.booksMore = booksMore;
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
  return more > 0 ? `<button class="btn" onclick="booksMore()">Покажи още (${more} от общо ${total})</button>` : '';
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
  if (BOOKS_WINDOWED) return refreshBooksList(); // филтрите са в базата
  renderBooksBody();
  updateBulkBar();
  syncChkAll();
}
window.booksFilterChanged = booksFilterChanged;
function renderBooksBody(append) {
  // Прозоречен режим: заредените порции са вече филтрирани от базата, общият брой е отделен.
  const books = BOOKS_WINDOWED ? (window._BOOKS_LIST || []) : (window._BOOKS_LIST || []).filter(booksFilterMatch);
  BOOKS_PAINTED = paintRowWindow({
    body: '#bBody', bar: '#bMore', rows: books, limit: BOOKS_WINDOWED ? books.length : BOOKS_RENDER_LIMIT,
    painted: append ? BOOKS_PAINTED : 0,
    rowsHtml: booksRowsHtml,
    moreHtml: BOOKS_WINDOWED ? () => booksMoreHtml(BOOKS_TOTAL - books.length, BOOKS_TOTAL) : booksMoreHtml
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
  if (BOOKS_WINDOWED) {
    // Изборът се изчиства при всяко ново търсене/филтър, тоест винаги е подмножество на резултата.
    const sel = BOOKS_SELECTED.size;
    chkAll.checked = BOOKS_TOTAL > 0 && sel >= BOOKS_TOTAL;
    chkAll.indeterminate = sel > 0 && sel < BOOKS_TOTAL;
    return;
  }
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
  const req = ++BOOKS_REQ;
  const res = await booksFetch(0, BOOKS_RENDER_LIMIT);
  if (!res || req !== BOOKS_REQ) return;
  const books = res.all || res.rows;
  booksSetList(books);
  if (!BOOKS_WINDOWED) {
    const visibleIds = new Set(books.map(b => b.id));
    for (const id of [...BOOKS_SELECTED]) if (!visibleIds.has(id)) BOOKS_SELECTED.delete(id);
  }
  renderBooksBody();
  updateBulkBar();
}
window.refreshBooksList = refreshBooksList;
async function renderBooks() {
  /* Пълният рендер не се отказва при по-нова заявка (тестовете и hashchange
     викат route() два пъти подред и чакат първия) — само търсенето (refreshBooksList)
     и „Покажи още“ пазят реда на отговорите. */
  ++BOOKS_REQ;
  const [res, cats, searchSuggest] = await Promise.all([
    booksFetch(0, BOOKS_RENDER_LIMIT), call(window.api.categories.list()),
    call(window.api.searchHistory.suggest('books'))
  ]);
  if (!res) return;
  const books = res.all || res.rows;
  window._CATS = cats || [];
  booksSetList(books);
  if (!BOOKS_WINDOWED) {
    const visibleIds = new Set(books.map(b => b.id));
    for (const id of [...BOOKS_SELECTED]) if (!visibleIds.has(id)) BOOKS_SELECTED.delete(id);
  }
  const n = BOOKS_SELECTED.size;
  const filtered = BOOKS_WINDOWED ? books : books.filter(booksFilterMatch);
  const shown = BOOKS_WINDOWED ? books : filtered.slice(0, BOOKS_RENDER_LIMIT);
  const total = BOOKS_WINDOWED ? BOOKS_TOTAL : filtered.length;
  const more = total - shown.length;
  // Отделите за филтъра идват от резултата (реално ползвани стойности), обединени
  // с фиксираните OTDELI — така филтърът винаги показва само отдели, които реално
  // имат поне един документ в текущия резултат от търсенето.
  const deptSeen = BOOKS_WINDOWED ? BOOKS_DEPTS : [...new Set(books.map(b => b.department).filter(Boolean))];
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
        ${!BOOKS_WINDOWED && filtered.length && filtered.every(b => BOOKS_SELECTED.has(b.id)) ? 'checked' : ''}></th>
        <th>Инв. №</th><th>Заглавие</th><th>Автор</th><th>Категория</th><th>Отдел</th><th>Год.</th><th>Състояние</th><th>Наличност</th><th style="width:90px"></th></tr></thead>
      <tbody id="bBody">${booksRowsHtml(shown)}</tbody>
    </table></div>
    <div class="toolbar" id="bMore" style="justify-content:center">${booksMoreHtml(more, total)}</div>
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
async function toggleBookSelAll(checked) {
  // "Избери всички" означава всички книги от текущия резултат от търсенето И филтъра —
  // не само редовете, заредени в момента в таблицата (при windowed рендер може да е само
  // част от тях). В прозоречен режим идентификаторите на целия резултат се взимат от
  // базата (books:list с idsOnly — само числа, не редове); в стария — от списъка в паметта.
  let ids;
  if (BOOKS_WINDOWED) {
    if (!checked) { BOOKS_SELECTED.clear(); renderBooksBody(); updateBulkBar(); return; }
    const r = await call(window.api.books.list(BOOKS_QUERY, BOOKS_SORT,
      { idsOnly: true, dept: BOOKS_FILTER_DEPT || '', cat: BOOKS_FILTER_CAT || '' }));
    ids = (r && r.ids) || [];
  } else {
    ids = (window._BOOKS_LIST || []).filter(booksFilterMatch).map(b => b.id);
  }
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
  /* Следващият инвентарен номер се предлага наготово (v2.4.27, A1): дотук
     полето беше празно и задължително, а програмата го знае („Следващ
     инвентарен номер“ в Настройки) — ръчно преписване при всяка книга и печатна
     грешка късаше поредността (чл. 16, ал. 2). Остава редактируемо. */
  // Чете се НАЖИВО, не от SETTINGS_CACHE (преглед на кръга): books:create увеличава
  // номера в базата, а снимката в паметта оставаше със стария и втората поред книга
  // получаваше „Този инвентарен номер вече е зает“.
  let nextInv = '';
  if (!id && !prefill) { const fresh = await call(window.api.settings.get()); nextInv = (fresh && fresh.next_inv_number) || ''; }
  const v = prefill || b || { inv_number: nextInv, register_date: today(), status: 'наличен', language: 'български',
    department: 'за възрастни', acquisition_id: presetAcqId || '' };
  const AV = av || {};
  const catOpts = (cats || []).map(c => ({ v: c.id, t: c.name }));
  const acqOpts = (acqs || []).map(a => ({ v: a.id, t: '№ ' + a.no + '/' + a.year + ' — ' + (a.from_source || '') }));
  const isCopy = !!(prefill && !prefill._carry);
  modal(id ? 'Инв. № ' + v.inv_number + ' — редакция'
    : isCopy ? 'Още един екземпляр от „' + (v.title || '') + '“'
    : 'Нов документ във фонда', `
    <div class="note"><b>Чл. 16, ал. 1</b> — индивидуалната регистрация съдържа: дата на вписване, инвентарен номер, автор,
    заглавие, том, година, цена, номер и дата на вписване в КДБФ, сигнатура.</div>
    ${isCopy ? `<div class="note d">Това е <b>нов запис</b> със <b>свой инвентарен номер</b> — един инвентарен номер
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
        <div class="field"><label>Авторски знак</label>
          <div class="isbnRow">
            <input name="author_mark" value="${esc(v.author_mark || '')}">
            <button type="button" class="btn" id="amBtn" onclick="authorMarkSuggest()"
              title="Предлага знака по фамилията — по таблицата, внесена в Настройки → Фонд">Предложи</button>
          </div>
          <div class="hint" id="amHint">напр. „В-15“</div>
        </div>
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
     ${!id ? `<button class="btn" onclick="saveBook(null, true)"
        title="Записва и отваря нова форма със същата партида, дата на вписване, отдел, вид документ, издателство, място и език и следващия инвентарен номер">Запиши и нов</button>` : ''}
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
   Прозорецът се отваря върху формата за книга и работи на две части:

   • ДЪРВО на класификацията — 1920 кода, разгърнати по самата схема
     („8 → 82 → 821 → 821.163.2“). Показват се свити: цялата таблица наведнъж е
     непрегледна, а свитото дърво се чете като съдържание на книга.
   • ОБЩИ ОПРЕДЕЛИТЕЛИ по спомагателните таблици, които се ДОБАВЯТ към вече
     избран код: „94“ + „(497.2)“ = „94(497.2)“ — история на България. Точно
     така изданието изразява това, което дотук стоеше като готов ред.

   Търсенето минава през ЦЕЛИЯ текст на реда, включително списъка „Включва:“.
   Това не е дребна подробност: думата, която библиотекарката ще напише, най-често
   е точно там — „Пчеларство“ го няма в заглавието на 638 („Отглеждане и
   развъждане на насекоми“), а стои в „Включва“. Само по заглавията половината
   търсения биха връщали „няма намерено“.

   Полето „УДК“ остава свободен текст: пълната схема (над 70 000 индекса) не е
   тук и винаги ще има какво да се допише на ръка. */
let UDK_BUILT = [];                       // стъпките на сглобения код

function udkNodeHtml(n, lvl) {
  const [code, head, also, kids] = n;
  const find = (code + ' ' + head + ' ' + also).toLowerCase();
  return `<div class="udkNode${lvl === 0 ? ' udkTop' : ''}" data-code="${esc(code)}" data-find="${esc(find)}">
    <button type="button" class="udkRow" onclick="udkTap(this,event)">
      <span class="udkTw">${kids.length ? '▸' : ''}</span>
      <span class="udkCode">${esc(code)}</span>
      <span class="udkLbl">${esc(head)}${also ? `<span class="udkAlso"> Включва: ${esc(also)}</span>` : ''}</span>
      ${kids.length ? `<span class="udkCount">${udkCount(n)}</span>` : ''}
      <span class="udkPlus">избери</span>
    </button>
    ${kids.length ? `<div class="udkKids">${kids.map(k => udkNodeHtml(k, lvl + 1)).join('')}</div>` : ''}
  </div>`;
}
function udkCount(n) { return n[3].reduce((s, k) => s + 1 + udkCount(k), 0); }

function udkPicker() {
  UDK_BUILT = [];
  const tree = UDK_TREE.map(n => udkNodeHtml(n, 0)).join('');
  const quick = UDK_QUICK.map(([c, t]) =>
    `<button type="button" class="udkItem udkQ1" onclick="udkPick('${jsq(c)}')" title="${esc(t)}">
      <span class="udkCode">${esc(c)}</span><span class="udkLbl">${esc(t)}</span></button>`).join('');
  const tabs = UDK_AUX.map(([name, rows], i) =>
    `<button type="button" class="udkTab${i === 0 ? ' on' : ''}" data-aux="${i}"
      onclick="udkAuxTab(${i})">${esc(name)} <span class="udkTabN">${rows.length}</span></button>`).join('');
  modal2('Универсална десетична класификация (УДК)', `
    <div class="udkBuild">
      <span class="udkBuildCode udkBlank" id="udkB">още нищо не е избрано</span>
      <span class="udkBuildLbl" id="udkBL">Изберете раздел от дървото; после може да добавите определител.</span>
      <button type="button" class="btn sm" id="udkUndo" onclick="udkUndo()" disabled>Назад</button>
      <button type="button" class="btn pri sm" id="udkTake" onclick="udkTake()" disabled>Вземи кода</button>
    </div>
    <input class="udkSearch" id="udkQ" oninput="udkFilter()"
      placeholder="Търсене по код или по дума — търси се и в „Включва:“ (напр. „пчеларство“, „821.163.2“)">
    <div class="udkQuick"><span class="udkQuickLbl">Често ползвани:</span>${quick}</div>
    <div class="hint" id="udkHits"></div>
    <div class="udkTree" id="udkList">${tree}</div>
    <div class="note d" id="udkNone" style="display:none">Няма намерен раздел.
      Опитайте с друга дума или с част от кода — търси се и в списъците „Включва:“.</div>
    <h4 class="udkSecH">Общи определители — добавят се към избрания код</h4>
    <div class="hint" id="udkAuxHint">Първо изберете основен код от дървото по-горе.</div>
    <div class="udkTabs">${tabs}</div>
    <div class="udkTree udkAuxTree" id="udkAuxList"></div>`,
    `<button class="btn" onclick="closeModal2()">Затвори</button>`);
  udkAuxTab(0);
  udkBuildRender();
  setTimeout(() => { const q = $('#udkQ'); if (q) q.focus(); }, 50);
}
window.udkPicker = udkPicker;

/* Натискане по реда: по „избери“ (или по ред без подраздели) взима кода, иначе
   разгръща. Така един и същ ред и се отваря, и се избира — без две копчета. */
function udkTap(btn, ev) {
  const node = btn.parentElement;
  const kids = node.querySelector(':scope > .udkKids');
  if (!kids || (ev.target && ev.target.classList.contains('udkPlus'))) {
    udkSet(node.dataset.code, btn.querySelector('.udkLbl').firstChild.textContent);
    return;
  }
  node.classList.toggle('on');
  btn.querySelector('.udkTw').textContent = node.classList.contains('on') ? '▾' : '▸';
}
window.udkTap = udkTap;

function udkAuxTab(i) {
  const rows = (UDK_AUX[i] || ['', []])[1];
  document.querySelectorAll('.udkTab').forEach(t => t.classList.toggle('on', Number(t.dataset.aux) === i));
  const box = $('#udkAuxList');
  if (box) box.innerHTML = rows.map(([c, head, also]) =>
    `<div class="udkNode" data-code="${esc(c)}"><button type="button" class="udkRow"
      onclick="udkAddAux('${jsq(c)}')">
      <span class="udkTw"></span><span class="udkCode">${esc(c)}</span>
      <span class="udkLbl">${esc(head)}${also ? `<span class="udkAlso"> Включва: ${esc(also)}</span>` : ''}</span>
      <span class="udkPlus">добави</span></button></div>`).join('');
}
window.udkAuxTab = udkAuxTab;

function udkSet(code, label) { UDK_BUILT = [{ code, label }]; udkBuildRender(); }
function udkAddAux(code) {
  if (!UDK_BUILT.length) { toast('Първо изберете основен код от дървото.', 'warn'); return; }
  const row = (UDK_AUX.find(a => a[1].some(r => r[0] === code)) || ['', []])[1].find(r => r[0] === code);
  UDK_BUILT.push({ code, label: row ? row[1] : code });
  udkBuildRender();
}
window.udkAddAux = udkAddAux;
function udkUndo() { UDK_BUILT.pop(); udkBuildRender(); }
window.udkUndo = udkUndo;

function udkCodeNow() { return UDK_BUILT.map(x => x.code).join(''); }
function udkBuildRender() {
  const code = udkCodeNow();
  const b = $('#udkB'); if (!b) return;
  b.textContent = code || 'още нищо не е избрано';
  b.classList.toggle('udkBlank', !code);
  $('#udkBL').textContent = UDK_BUILT.length
    ? UDK_BUILT.map(x => x.label).join(' + ')
    : 'Изберете раздел от дървото; после може да добавите определител.';
  $('#udkUndo').disabled = !UDK_BUILT.length;
  $('#udkTake').disabled = !UDK_BUILT.length;
  $('#udkAuxHint').textContent = UDK_BUILT.length
    ? 'Добавя се към „' + code + '“ — напр. 94 + (497.2) = 94(497.2) „история на България“.'
    : 'Първо изберете основен код от дървото по-горе.';
}
function udkTake() {
  const code = udkCodeNow();
  if (!code) return;
  udkPick(code);
}
window.udkTake = udkTake;

function udkFilter() {
  const q = ($('#udkQ').value || '').trim().toLowerCase();
  const all = document.querySelectorAll('#udkList .udkNode');
  const twist = (n, open) => {
    n.classList.toggle('on', open);
    const t = n.querySelector(':scope > .udkRow > .udkTw');
    if (t && t.textContent) t.textContent = open ? '▾' : '▸';
  };
  all.forEach(n => n.classList.remove('udkHit'));
  if (!q) {
    all.forEach(n => { n.style.display = ''; twist(n, false); });
    $('#udkHits').textContent = '';
    $('#udkNone').style.display = 'none';
    return;
  }
  all.forEach(n => { n.style.display = 'none'; });
  let hits = 0;
  all.forEach(n => {
    if (!n.dataset.find.includes(q)) return;
    hits++;
    n.style.display = '';
    n.classList.add('udkHit');
    /* Пътят до намереното се отваря, иначе редът стои в затворен клон и не се
       вижда — а точно пътят („6 → 63 → 638“) казва къде попада намереното. */
    for (let p = n.parentElement; p && p.id !== 'udkList'; p = p.parentElement) {
      if (p.classList && p.classList.contains('udkNode')) { p.style.display = ''; twist(p, true); }
    }
  });
  $('#udkHits').textContent = hits ? hits + (hits === 1 ? ' намерен ред' : ' намерени реда') : '';
  $('#udkNone').style.display = hits ? 'none' : '';
}
window.udkFilter = udkFilter;

function udkTargetInput() { return $('#bookF [name=udk]'); }
function udkPick(code) {
  const el = udkTargetInput();
  if (el) { el.value = code; toast('УДК ' + code, 'ok'); }
  closeModal2();
}
window.udkPick = udkPick;

/* ---------------- Авторски знак по фамилията ----------------
   Копчето ПРЕДЛАГА, не решава. Знакът се смята по таблицата, внесена от самата
   библиотека (Настройки → Фонд), и до полето се изписва ЗАЩО е този: по коя
   фамилия и по кой ред от таблицата. Ако таблицата има отделен ред за конкретен
   автор („Вазов, И.“), той се показва като избор — правилото е по фамилията, но
   човекът вижда и по-точния ред и решава сам.
   Вече попълнен и различен знак не се сменя без изричното „да“. */
function amHint(html) { const h = $('#amHint'); if (h) h.innerHTML = html; }
async function authorMarkSuggest() {
  const f = $('#bookF');
  if (!f) return;
  const el = f.querySelector('[name=author_mark]');
  const book = { author: (f.querySelector('[name=author]') || {}).value || '',
                 title: (f.querySelector('[name=title]') || {}).value || '' };
  const btn = $('#amBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await window.api.authorMark.suggest(book);
    if (!r.ok) {
      amHint('<b>Няма как да предложа.</b> ' + esc(r.error));
      toast(r.error, 'err');
      return;
    }
    const s = r.data;
    if (!s.ok) {
      amHint('<b>Няма как да предложа:</b> ' + esc(s.reason) + '.');
      toast('Няма предложение: ' + s.reason, 'warn');
      return;
    }
    const why = (s.from === 'title' ? 'без автор — по заглавието „' : 'фамилия „') + esc(s.basis) + '“' +
      (s.exact === false ? ' <i>(името е без запетая — фамилията е предположение)</i>' : '') +
      ' → ред „' + esc(s.prefix) + '“' +
      /* Й няма собствен раздел в авторските таблици — търси се от И („Йовков“ е
         записан като „Иовк“). Казва се наяве, иначе редът изглежда сгрешен. */
      (s.fromLetter ? ' <i>(' + esc(s.basis.charAt(0).toUpperCase()) + ' се търси от буква '
        + esc(s.fromLetter) + ')</i>' : '') +
      ' → <b>' + esc(s.mark) + '</b>';
    const alt = (s.refine || []).map(x =>
      `<button type="button" class="btn sm" onclick="authorMarkTake('${esc(x.mark)}')">${esc(x.prefix)} → ${esc(x.mark)}</button>`).join(' ');
    amHint(why + (alt ? '<br>В таблицата има ред за конкретен автор: ' + alt : ''));
    const cur = (el.value || '').trim();
    if (cur && cur !== s.mark) {
      if (!await askConfirm('В полето вече пише „' + cur + '“.\n\nДа го сменя ли с „' + s.mark + '“?',
        { okLabel: 'Смени' })) { toast('Знакът остава „' + cur + '“', 'ok'); return; }
    }
    el.value = s.mark;
    toast('Авторски знак ' + s.mark, 'ok');
  } catch (e) {
    amHint('<b>Няма как да предложа.</b> ' + esc(e && e.message ? e.message : String(e)));
    toast('Грешка при предлагането на авторски знак', 'err');
  } finally { if (btn) btn.disabled = false; }
}
window.authorMarkSuggest = authorMarkSuggest;
function authorMarkTake(mark) {
  const el = $('#bookF [name=author_mark]');
  if (el) { el.value = mark; toast('Авторски знак ' + mark, 'ok'); }
}
window.authorMarkTake = authorMarkTake;

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

async function saveBook(id, andNew) {
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
  /* „Запиши и нов“ (v2.4.27, A2): каталогизирането на партида от 40 книги беше
     „Отвори → + Инвентирай → попълни → Запиши → Отвори → …“. Общите за партидата
     полета се пренасят; следващият инвентарен номер идва от опресненото
     SETTINGS_CACHE (books:create го увеличава). */
  if (andNew && !id) {
    await loadSettingsCache();
    const carry = {};
    ['acquisition_id', 'register_date', 'department', 'publisher', 'city', 'language', 'category_id']
      .forEach(k => { if (d[k] !== undefined && d[k] !== '') carry[k] = d[k]; });
    await bookForm(null, carry.acquisition_id || null, Object.assign({
      inv_number: (SETTINGS_CACHE && SETTINGS_CACHE.next_inv_number) || '', status: 'наличен', language: 'български',
      department: 'за възрастни', register_date: today()
    }, carry, { title: '', author: '', isbn: '', barcode: '', pages: '', subtitle: '', volume: '', year: '', _carry: true }));
  }
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
    if (!await askConfirm('НЕОБРАТИМО\n\n' + pending + '\n\nНаистина ли да продължа?', { kind: 'delete', title: 'Необратимо изтриване', okLabel: 'Изтрий окончателно' })) return;
  } else if (!await askConfirm(plainQuestion)) {
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
    () => window.api.books.delete(id), 'Книгата е изтрита.', () => { BOOKS_SELECTED.delete(id); return RENDERERS[VIEW](); });
}
window.deleteBook = deleteBook;
