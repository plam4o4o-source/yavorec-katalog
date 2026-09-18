/* ---------------- Летопис ---------------- */
let CHR_Q = '', CHR_YEAR = '';
const CHR_CATS = ['читалище', 'библиотека', 'самодейност', 'дарение', 'строителство', 'юбилей', 'друго'];
async function renderChronicle() {
  chrCancelSearch(); // отложеното търсене от предишното влизане няма какво да прави
  const [rows, years] = await Promise.all([
    call(window.api.chronicle.list({ q: CHR_Q, year: CHR_YEAR })),
    call(window.api.chronicle.years())
  ]);
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note"><b>Летопис.</b> Хронология на читалищната дейност — по години и събития.
    Това, което по традиция се води в летописната книга, тук се търси, допълва и свързва със
    снимките и документите във фонда.</div>

    <div class="toolbar">
      <button class="btn pri" onclick="chronicleForm()">+ Нов запис</button>
      <input type="search" placeholder="Търсене по събитие, описание, участници…"
        value="${esc(CHR_Q)}" oninput="chrSearch(this.value)">
      <select onchange="chrYear(this.value)">
        <option value="">— всички години —</option>
        ${(years || []).map(y => `<option value="${esc(y.year)}" ${CHR_YEAR === y.year ? 'selected' : ''}>
          ${esc(y.year)} (${y.n})</option>`).join('')}
      </select>
      <button class="btn" onclick="printChronicle()">Печат / PDF</button>
    </div>

    <div id="chrList"></div>`;
  drawChronicleList(rows);
}
/* Прозоречен рендер (v2.3.1) по общия модел от core.js (paintRowWindow/
   RENDER_PAGE_SIZE). ЗАЩО тук: летописът по устройство САМО расте — записаното
   събитие остава завинаги, а всяка година прибавя нови. Измерено (jsdom върху
   истинския изглед, 3 000 записа): 3 000 изчертани записа и 3 141 КБ разметка в
   #chrList — най-тежкият от краеведските раздели, защото всеки запис носи и
   откъс от описанието до 240 знака, и (когато има) снимка.

   ЗАЩО СЕ СМЕНИ ГНЕЗДЕНЕТО. Дотук записите се групираха в <div class="chrYear">
   на година — тоест преките деца на списъка бяха ГОДИНИ, не записи. При такова
   гнездене добавянето на порция е невъзможно да се направи вярно: ако порцията
   свърши по средата на 1985 г., следващата или ще повтори заглавието „1985“,
   или ще залепи записите в чужда група. Затова сега всеки ЗАПИС е пряко дете, а
   заглавието на годината се носи от първия запис за нея (и той поема класа
   .chrYear, чието единствено правило е разстоянието отгоре — външният вид
   остава същият, без да се пипа style.css). Така „в тялото стоят точно толкова
   деца, колкото са изчертани“ важи и добавянето е точно.

   Редът НЕ се променя: chronicle:list връща ORDER BY year DESC, date DESC, id DESC,
   тоест записите за една година вече идват един до друг и в същата подредба, в
   която старото групиране ги показваше. */
const CHR_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let CHR_RENDER_LIMIT = CHR_PAGE_SIZE;
let CHR_PAINTED = 0;
/* Кои записи откриват своята година. Смята се ВЕДНЪЖ за целия списък, а не при
   всяка порция: иначе първият запис на всяка порция би изглеждал като начало на
   година (заглавието „1985“ щеше да се повтаря на всяко „Покажи още“). */
let CHR_YEAR_HEADS = new WeakSet();
function markChronicleYearHeads(rows) {
  CHR_YEAR_HEADS = new WeakSet();
  let prev = null;
  for (const c of rows) {
    if (String(c.year) !== prev) CHR_YEAR_HEADS.add(c);
    prev = String(c.year);
  }
}
function chronicleRowsHtml(rows) {
  return rows.map(c => {
    const head = CHR_YEAR_HEADS.has(c);
    return `<div${head ? ' class="chrYear"' : ''}>
        ${head ? `<div class="chrYearHead">${esc(c.year)}</div>` : ''}
        <div class="chrItem" tabindex="0" role="button" aria-label="${esc(c.title)}"
          onclick="chronicleView(${c.id})" onkeydown="cardActivate(event, () => chronicleView(${c.id}))">
          ${c.photo ? `<img class="chrThumb" src="${esc(c.photo)}" alt="">` : ''}
          <div class="chrBody">
            <div class="chrTop">
              <span class="chrTitle">${esc(c.title)}</span>
              ${c.date ? `<span class="chrDate">${esc(bg(c.date))}</span>` : ''}
              ${c.category ? `<span class="tag">${esc(c.category)}</span>` : ''}
            </div>
            ${c.body ? `<div class="chrText">${esc(String(c.body).slice(0, 240))}${String(c.body).length > 240 ? '…' : ''}</div>` : ''}
            ${c.links ? `<div class="hint">${c.links} свързани материала</div>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}
/* Броячът се пририсува заедно със записите и казва „показани са N от M“ — иначе
   скъсеният летопис изглежда пълен и по-старите години изглеждат незаписани. */
function chronicleMoreHtml(more, total) {
  const shown = total - more;
  return `<span class="hint">Показани са ${shown} от ${total} записа в летописа.</span>`
    + (more > 0 ? ` <button class="btn" onclick="CHR_RENDER_LIMIT+=${CHR_PAGE_SIZE};paintChronicleRows(true)">Покажи още (${more} от общо ${total})</button>` : '');
}
/* append=true идва САМО от „Покажи още“. Търсенето и филтърът по година остават
   пълен рендер — там резултатът е ДРУГ набор (и други заглавия на години). */
function paintChronicleRows(append) {
  CHR_PAINTED = paintRowWindow({
    body: '#chrItems', bar: '#chrMore', rows: window._CHR_LIST || [], limit: CHR_RENDER_LIMIT,
    painted: append ? CHR_PAINTED : 0,
    rowsHtml: chronicleRowsHtml, moreHtml: chronicleMoreHtml
  });
}
window.paintChronicleRows = paintChronicleRows;
function chronicleListHtml(rows) {
  return rows.length
    ? `<div id="chrItems"></div>
       <div class="toolbar" id="chrMore" style="justify-content:center"></div>`
    : `<div class="empty"><h3>Летописът е празен</h3>
        <p>Впишете първото събитие — основаването на читалището, откриването на библиотеката,
        юбилей, дарение, ремонт.</p></div>`;
}
/* Едно място за рисуване на списъка — и от пълния рендер, и от търсенето. */
function drawChronicleList(rows) {
  window._CHR_LIST = rows;
  CHR_RENDER_LIMIT = CHR_PAGE_SIZE; // нов резултат — пак от първата порция
  markChronicleYearHeads(rows);
  const box = $('#chrList');
  if (!box) return false;
  box.innerHTML = chronicleListHtml(rows);
  paintChronicleRows(false);
  return true;
}
/* Търсенето пипа само #chrList — полето за търсене НЕ се пресъздава, иначе при
   пауза над 300 ms курсорът изчезва по средата на думата (моделът от inv-book.js).

   ОТЛОЖЕНОТО ТЪРСЕНЕ НЕ РИСУВА В ЧУЖД РАЗДЕЛ (v2.4.61).
   =========================================================================
   Търсачката е с отлагане 300 ms. Ако библиотекарката напише нещо в „Летопис“
   и веднага мине в „Персоналии“ (а тя точно това прави — сеща се за нещо
   друго), таймерът се задейства ВЪВ ВЕЧЕ ДРУГИЯ раздел: drawChronicleList не
   намира #chrList (той е изчезнал заедно с летописа), връща false и резервният
   път викаше renderChronicle(), който пише направо в #view. Резултатът: под
   заглавието „Персоналии“ стои летописът. Нищо на екрана не обяснява какво е
   станало и единственият изход е ново натискане на раздела.

   Затова проверката е на ДВЕ места: веднага при влизане (таймерът е закъснял) и
   пак след отговора на базата (разделът е сменен, докато заявката е текла).
   Същата защита стои и в src/views/persons.js, и в src/views/analytics.js.
   Самият таймер се отменя при всяко ново изчертаване на раздела — виж
   chrCancelSearch() по-долу; окончателното му отменяне при СМЯНА на раздел е
   работа на route() (src/views/bootstrap.js), който не се пипа в този кръг. */
async function refreshChronicle() {
  if (VIEW !== 'chronicle') return;
  const rows = await call(window.api.chronicle.list({ q: CHR_Q, year: CHR_YEAR }));
  if (!rows || VIEW !== 'chronicle') return;
  if (!drawChronicleList(rows)) renderChronicle();
}
window.refreshChronicle = refreshChronicle;
function chrCancelSearch() { clearTimeout(window._chrT); window._chrT = null; }
window.chrCancelSearch = chrCancelSearch;
function chrSearch(v) { CHR_Q = v; clearTimeout(window._chrT); window._chrT = setTimeout(refreshChronicle, 300); }
window.chrSearch = chrSearch;
function chrYear(v) { CHR_YEAR = v; renderChronicle(); }
window.chrYear = chrYear;

async function chronicleForm(id) {
  const c = id ? await call(window.api.chronicle.get(id)) : null;
  const v = c || { year: String(new Date().getFullYear()), category: 'читалище' };
  modal(id ? 'Редакция на запис' : 'Нов запис в летописа', `
    <form id="chrF" onsubmit="return false">
    <div class="grid g4">
      ${fld('Година', 'year', { val: v.year || '', req: 1, hint: 'или „ок. 1930“' })}
      ${fld('Точна дата (ако е известна)', 'date', { val: v.date || '', type: 'date', onchange: 'chrYearFromDate(this)' })}
      ${fld('Раздел', 'category', { type: 'select', val: v.category, opts: CHR_CATS, allowEmpty: false })}
      ${fld('Участници', 'participants', { val: v.participants || '' })}
    </div>
    ${fld('Събитие', 'title', { val: v.title || '', req: 1, hint: 'кратко заглавие на записа' })}
    ${fld('Описание', 'body', { type: 'textarea', val: v.body || '', rows: 6 })}
    <div class="grid g2">
      ${fld('Източници', 'sources', { val: v.sources || '', hint: 'протокол, вестник, спомен' })}
      ${fld('Забележка', 'note', { val: v.note || '' })}
    </div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveChronicle(${id || 'null'})">Запиши</button>`);
}
window.chronicleForm = chronicleForm;
/* ГОДИНАТА СЛЕДВА ВЪВЕДЕНАТА ТОЧНА ДАТА (v2.4.61).
   =========================================================================
   Формата предлага текущата година — правилно, защото повечето нови записи са
   от тази година. Но когато краеведът впише точната дата на СТАРО събитие
   (24.05.1922 — основаването на читалището), предложената 2026 г. оставаше и
   записът попадаше в 2026 г.: под чуждо заглавие на екрана, в чужда група в
   разпечатания летопис и невидим при филтър по 1922 г. Разминаването се
   поправяше само на ръка и само ако някой го забележи.

   Затова точната дата води годината — тук, докато полето е още пред очите на
   човека, и повторно в самия канал (handlers/chronicle.js), където
   разминаването, което формата не е поправила, се ОТКАЗВА. Свободният текст
   („ок. 1930“, „1878 – 1880“) не се пипа, когато вече съдържа годината на
   датата — само празното или сгрешеното поле се презаписва. */
function chrYearMatches(year, date) {
  return (String(year || '').match(/\d{3,4}/g) || []).includes(String(date).slice(0, 4));
}
function chrYearFromDate(el) {
  const d = String((el && el.value) || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  const y = $('#chrF [name=year]');
  if (y && !chrYearMatches(y.value, d)) y.value = d.slice(0, 4);
}
window.chrYearFromDate = chrYearFromDate;
async function saveChronicle(id) {
  const d = formData('#chrF');
  if (!d.title.trim()) return toast('Заглавието на събитието е задължително.', 'err');
  if (!d.year.trim() && !d.date) return toast('Годината е задължителна.', 'err');
  // Същото и тук, а не само на onchange: полето за дата може да бъде попълнено
  // и без събитието „change“ (вмъкване, автодовършване, друг път към формата).
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.date || '') && !chrYearMatches(d.year, d.date)) d.year = d.date.slice(0, 4);
  d.id = id;
  // Затваря се само при успех (v2.2.0) — иначе отказаният запис изтриваше и
  // дългия текст на летописното събитие.
  if (id) {
    if (await call(window.api.chronicle.update(d), 'Записът е обновен.') === null) return;
    closeModal(); renderChronicle(); markSaved();
    return;
  }
  const newId = await call(window.api.chronicle.create(d), 'Записът е добавен.');
  if (newId === null) return;
  closeModal(); await renderChronicle(); markSaved();
  if (newId) chronicleView(newId);
}
window.saveChronicle = saveChronicle;

async function chronicleView(id) {
  const [c, links] = await Promise.all([
    call(window.api.chronicle.get(id)),
    call(window.api.links.list({ fromKind: 'летопис', fromId: id }))
  ]);
  if (!c) return;
  window._LINK_CTX = { kind: 'летопис', id };
  modal(c.year + ' — ' + c.title, `
    <div class="prsView">
      <div class="prsViewPhoto">
        ${c.photo ? `<img src="${esc(c.photo)}" alt="">` : '<div class="logoEmpty">няма<br>снимка</div>'}
        <div class="toolbar" style="margin-top:8px">
          <button class="btn sm" onclick="localPhotoChoose('chronicle', ${id})">${c.photo ? 'Смени…' : 'Снимка…'}</button>
          ${c.photo ? `<button class="btn sm dgr" onclick="localPhotoClear('chronicle', ${id})">Махни</button>` : ''}
        </div>
      </div>
      <div class="prsViewBody">
        <div class="chrTop">
          ${c.date ? `<span class="chrDate">${esc(bg(c.date))}</span>` : ''}
          ${c.category ? `<span class="tag">${esc(c.category)}</span>` : ''}
        </div>
        ${c.body ? `<p style="font-size:13.5px;line-height:1.6">${esc(c.body).replace(/\n/g, '<br>')}</p>` : ''}
        ${c.participants ? `<div class="hint"><b>Участници:</b> ${esc(c.participants)}</div>` : ''}
        ${c.sources ? `<div class="hint"><b>Източници:</b> ${esc(c.sources)}</div>` : ''}
      </div>
    </div>
    ${linksPanelHtml('летопис', id, links || [])}`,
    `<button class="btn" onclick="closeModal();linksRefreshListIfChanged()">Затвори</button>
     <button class="btn" onclick="closeModal();chronicleForm(${id})">Редакция</button>
     <button class="btn dgr" onclick="chronicleDelete(${id})">Изтрий</button>`);
}
window.chronicleView = chronicleView;
async function chronicleDelete(id) {
  if (!await askConfirm('Изтриване на записа от летописа?')) return;
  await call(window.api.chronicle.delete(id), 'Записът е изтрит.');
  closeModal(); renderChronicle();
}
window.chronicleDelete = chronicleDelete;

async function printChronicle() {
  const rows = await call(window.api.chronicle.list({ year: CHR_YEAR, q: CHR_Q }));
  if (!rows || !rows.length) return toast('Няма записи за печат.', 'err');
  const byYear = {};
  for (const r of rows) { (byYear[r.year] = byYear[r.year] || []).push(r); }
  /* Годината е СВОБОДЕН текст („1878“, „ок. 1900“, „1878 – 1880“), затова
     Object.keys(...).sort() я подреждаше АЗБУЧНО: „878“ след „1878“, а всичко,
     което не започва с цифра, се разбъркваше между годините. В летопис, който се
     чете отпред назад, това е хронология в грешен ред. Сортира се по първото
     четирицифрено число в текста; записите без такова число отиват накрая, по
     азбучен ред помежду си. */
  const yearKey = (s) => { const m = String(s || '').match(/\d{3,4}/); return m ? Number(m[0]) : Infinity; };
  const years = Object.keys(byYear).sort((a, b) => {
    const ka = yearKey(a), kb = yearKey(b);
    return ka !== kb ? ka - kb : String(a).localeCompare(String(b), 'bg');
  });
  /* ВЪТРЕ В ГОДИНАТА — ВЪЗХОДЯЩО, С НОМЕР И С ИЗТОЧНИК (v2.4.61).
     =======================================================================
     Летописната книга по традиция е хронологичен, номериран и посочващ
     източниците си запис — по номера се цитира („по летописа, 1972 г., № 2“),
     по източника се проверява. Разпечатката дотук не беше нито едното:
       • редът вътре в годината идваше направо от chronicle:list, тоест НАЙ-
         НОВОТО отгоре (ORDER BY date DESC — вярно за екрана, където се търси
         последното вписано, и точно обратно на вярното за хартията): ремонтът
         от 15.01.1972 излизаше СЛЕД юбилея от 24.05.1972;
       • записите нямаха пореден номер — на два съседни реда за една и съща
         година няма как да се посочи кой от тях се има предвид;
       • „Източници“ (протокол, вестник, спомен) ги има на екрана, но не и на
         хартията — а краеведска справка без посочен източник не струва нищо за
         онзи, който я чете и трябва да я провери;
       • нямаше сбор за годината, тоест не личи дали листът е пълен.
     Записите БЕЗ точна дата отиват накрая на своята година: те са верни за
     годината, но не могат да се подредят в нея. */
  const dateKey = (c) => c.date || '9999-99-99';
  years.forEach(y => byYear[y].sort((a, b) => String(dateKey(a)).localeCompare(String(dateKey(b))) || a.id - b.id));
  const zapisa = (n) => n + (n === 1 ? ' запис' : ' записа');
  setPrintPage({ name: (CHR_YEAR ? `Летопис ${CHR_YEAR} г.` : 'Летопис'), landscape: false, margin: '16mm 14mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 class="ptitle">ЛЕТОПИС${CHR_YEAR ? ' — ' + esc(CHR_YEAR) + ' г.' : ''}</h2>
    ${/* Разпечатката излиза с бланка и два реда за подпис и изглежда като пълния
          летопис — а съдържа само това, което търсачката и филтърът за година са
          оставили на екрана. Обхватът се обявява ВИНАГИ, включително когато е пълен. */
      ''}
    <div class="pmeta">${(CHR_Q || CHR_YEAR)
      ? `<b>Обхват на разпечатката:</b> ${CHR_YEAR ? 'само ' + esc(CHR_YEAR) + ' г.' : 'всички години'}${
          CHR_Q ? ', само записите, съдържащи „' + esc(CHR_Q) + '“' : ''} — <b>${rows.length}</b> записа.
        Това НЕ е пълният летопис.`
      : `Пълен летопис — всички <b>${rows.length}</b> вписани записа, към ${bg(today())} г.`}</div>
    ${years.map(y => `<h3 style="margin:10px 0 4px">${esc(y)} г.</h3>
      ${byYear[y].map((c, i) => `<div style="margin-bottom:7px">
        <b>№ ${i + 1}. ${esc(c.title)}</b>${c.date ? ' · ' + esc(bg(c.date)) : ''}${c.category ? ' · ' + esc(c.category) : ''}
        ${c.body ? `<div style="font-size:11pt">${esc(c.body).replace(/\n/g, '<br>')}</div>` : ''}
        ${c.participants ? `<div style="font-size:10pt"><i>Участници: ${esc(c.participants)}</i></div>` : ''}
        ${c.sources ? `<div style="font-size:10pt"><i>Източници: ${esc(c.sources)}</i></div>` : ''}
      </div>`).join('')}
      <div style="font-size:10pt;margin:2px 0 8px"><b>Общо за ${esc(y)} г.: ${zapisa(byYear[y].length)}.</b></div>`).join('')}
    ${ssig(['Летописец: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Председател') + ': …………………'])}</div>`);
}
window.printChronicle = printChronicle;
