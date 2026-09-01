/* ---------------- Персоналии ---------------- */
let PRS_Q = '';
async function renderPersons() {
  const rows = await call(window.api.persons.list(PRS_Q));
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note"><b>Персоналии.</b> Картотека на видни местни жители и дейци — родени в селото,
    работили тук или свързани с читалището. Всяка персоналия събира на едно място сведенията за
    човека и връзките към материалите за него във фонда.</div>

    <div class="toolbar">
      <button class="btn pri" onclick="personForm()">+ Нова персоналия</button>
      <input type="search" placeholder="Търсене по име, дейност, биография…"
        value="${esc(PRS_Q)}" oninput="prsSearch(this.value)">
      <button class="btn" onclick="printPersons()">Печат / PDF</button>
    </div>

    <div id="prsList"></div>`;
  drawPersonsList(rows);
}
/* Прозоречен рендер (v2.3.1) по общия модел от core.js (paintRowWindow/
   RENDER_PAGE_SIZE). ЗАЩО тук: картотеката на местните дейци само се допълва —
   персоналия не се отчислява като книга и не се връща като заемане. При това
   всяка карта носи <img> снимка, тоест цената на реда не е само разметка:
   браузърът тръгва да чете от диска толкова файла, колкото карти са изчертани.
   Измерено (jsdom върху истинския изглед, 1 500 персоналии): 1 500 карти и
   917 КБ разметка в #prsList наведнъж.

   Тук „редът“ е <div class="prsCard"> — пряко дете на .cardGrid. Затова мрежата
   получава собствено id и точно ТЯ е тялото, което paintRowWindow пълни: иначе
   проверката „в тялото стоят точно толкова деца, колкото са изчертани“ не би
   могла да важи и добавянето би се изродило в пълно пририсуване. */
const PRS_PAGE_SIZE = RENDER_PAGE_SIZE; // общият размер на порцията (core.js)
let PRS_RENDER_LIMIT = PRS_PAGE_SIZE;
let PRS_PAINTED = 0;
function personsRowsHtml(rows) {
  return rows.map(p => `<div class="prsCard" tabindex="0" role="button" aria-label="${esc(p.name)}"
        onclick="personView(${p.id})" onkeydown="cardActivate(event, () => personView(${p.id}))">
        <div class="prsPhoto">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : '<span>без снимка</span>'}</div>
        <div class="prsBody">
          <div class="prsName">${esc(p.name)}</div>
          <div class="prsDates">${esc(personDates(p))}</div>
          ${p.activity ? `<div class="prsAct">${esc(p.activity)}</div>` : ''}
          <div class="prsLinks">${p.links ? p.links + ' свързани материала' : 'няма свързани материали'}</div>
        </div>
      </div>`).join('');
}
/* Броячът се пририсува заедно с картите и казва „показани са N от M“ — скъсена
   картотека, която изглежда пълна, кара краеведа да мисли, че записите му ги няма. */
function personsMoreHtml(more, total) {
  const shown = total - more;
  return `<span class="hint">Показани са ${shown} от ${total} персоналии.</span>`
    + (more > 0 ? ` <button class="btn" onclick="PRS_RENDER_LIMIT+=${PRS_PAGE_SIZE};paintPersonsRows(true)">Покажи още (${more} от общо ${total})</button>` : '');
}
/* append=true идва САМО от „Покажи още“. Търсенето остава пълен рендер — там
   резултатът е ДРУГ набор и добавяне би долепило новите карти към старите. */
function paintPersonsRows(append) {
  PRS_PAINTED = paintRowWindow({
    body: '#prsGrid', bar: '#prsMore', rows: window._PRS_LIST || [], limit: PRS_RENDER_LIMIT,
    painted: append ? PRS_PAINTED : 0,
    rowsHtml: personsRowsHtml, moreHtml: personsMoreHtml
  });
}
window.paintPersonsRows = paintPersonsRows;
function personsListHtml(rows) {
  return rows.length
    ? `<div class="cardGrid" id="prsGrid"></div>
       <div class="toolbar" id="prsMore" style="justify-content:center"></div>`
    : `<div class="empty"><h3>Няма вписани персоналии</h3>
        <p>Започнете от хората, за които читалището вече пази сведения на хартия.</p></div>`;
}
/* Едно място за рисуване на списъка — и от пълния рендер, и от търсенето, за да
   не се разминат в това колко карти стоят изчертани (PRS_PAINTED). */
function drawPersonsList(rows) {
  window._PRS_LIST = rows;
  PRS_RENDER_LIMIT = PRS_PAGE_SIZE; // нов резултат — пак от първата порция
  const box = $('#prsList');
  if (!box) return false;
  box.innerHTML = personsListHtml(rows);
  paintPersonsRows(false);
  return true;
}
/* Търсенето пипа само #prsList — полето за търсене НЕ се пресъздава, иначе при
   пауза над 300 ms курсорът изчезва по средата на името (моделът от inv-book.js). */
async function refreshPersons() {
  const rows = await call(window.api.persons.list(PRS_Q));
  if (!rows) return;
  if (!drawPersonsList(rows)) renderPersons();
}
window.refreshPersons = refreshPersons;
function personDates(p) {
  const b = p.birth_date ? bg(p.birth_date) : '';
  const d = p.death_date ? bg(p.death_date) : '';
  if (b && d) return b + ' – ' + d;
  if (b) return 'р. ' + b;
  if (d) return 'п. ' + d;
  return '';
}
function prsSearch(v) { PRS_Q = v; clearTimeout(window._prsT); window._prsT = setTimeout(refreshPersons, 300); }
window.prsSearch = prsSearch;

async function printPersons() {
  const rows = await call(window.api.persons.list(PRS_Q));
  if (!rows || !rows.length) return toast('Няма записи за печат.', 'err');
  setPrintPage({ name: 'Персоналии', landscape: false, margin: '16mm 14mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 class="ptitle">ПЕРСОНАЛИИ</h2>
    <!-- Разпечатката се прави от ТЕКУЩО ФИЛТРИРАНИЯ списък, но излиза на бланка,
         със заглавие „ПЕРСОНАЛИИ" и два реда за подпис — тоест изглежда като целия
         раздел. Обхватът се обявява винаги, за да няма съмнение какво е подписано. -->
    <div class="pmeta">${PRS_Q
      ? `<b>Обхват:</b> само записите, съдържащи „${esc(PRS_Q)}“ — <b>${rows.length}</b> от целия раздел. Това НЕ е пълният списък.`
      : `Пълен списък — всички <b>${rows.length}</b> вписани персоналии към ${bg(today())} г.`}</div>
    ${rows.map(p => `<div style="margin-bottom:10px">
      <b>${esc(p.name)}</b>${personDates(p) ? ' · ' + esc(personDates(p)) : ''}
      ${p.activity ? `<div style="font-size:11pt"><i>${esc(p.activity)}</i></div>` : ''}
      ${p.bio ? `<div style="font-size:10.5pt">${esc(p.bio).replace(/\n/g, '<br>')}</div>` : ''}
      ${/* Отличията и ИЗТОЧНИЦИТЕ ги имаше в картона на екрана, но не и на хартия —
            а краеведска справка без посочен източник на сведенията не струва нищо
            за онзи, който я чете и трябва да я провери. */''}
      ${p.awards ? `<div style="font-size:10pt"><b>Отличия:</b> ${esc(p.awards)}</div>` : ''}
      ${p.sources ? `<div style="font-size:10pt"><b>Източници:</b> ${esc(p.sources)}</div>`
        : `<div style="font-size:10pt;color:#666"><i>Източници: непосочени</i></div>`}
    </div>`).join('')}
    ${ssig(['Съставил: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Председател') + ': …………………'])}</div>`);
}
window.printPersons = printPersons;

async function personForm(id) {
  const p = id ? await call(window.api.persons.get(id)) : null;
  const v = p || {};
  modal(id ? 'Редакция — ' + (v.name || '') : 'Нова персоналия', `
    <form id="prsF" onsubmit="return false">
    <fieldset><legend>Самоличност</legend>
      <div class="grid g2">
        ${fld('Име (фамилия, име, бащино)', 'name', { val: v.name || '', req: 1, ph: 'Иванов, Петър Георгиев' })}
        ${fld('Други изписвания и псевдоними', 'alt_names', { val: v.alt_names || '' })}
      </div>
      <div class="grid g4">
        ${fld('Дата на раждане', 'birth_date', { val: v.birth_date || '', type: 'date' })}
        ${fld('Място на раждане', 'birth_place', { val: v.birth_place || '' })}
        ${fld('Дата на смъртта', 'death_date', { val: v.death_date || '', type: 'date' })}
        ${fld('Място на смъртта', 'death_place', { val: v.death_place || '' })}
      </div>
      ${fld('Дейност (накратко)', 'activity', { val: v.activity || '', hint: 'напр. „учител, читалищен деец, краевед“' })}
    </fieldset>
    <fieldset><legend>Сведения</legend>
      ${fld('Биографична справка', 'bio', { type: 'textarea', val: v.bio || '', rows: 5 })}
      <div class="grid g2">
        ${fld('Отличия и награди', 'awards', { val: v.awards || '' })}
        ${fld('Източници на сведенията', 'sources', { val: v.sources || '' })}
      </div>
      ${fld('Забележка', 'note', { val: v.note || '' })}
    </fieldset>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="savePerson(${id || 'null'})">Запиши</button>`);
}
window.personForm = personForm;
async function savePerson(id) {
  const d = formData('#prsF');
  if (!d.name.trim()) return toast('Името е задължително.', 'err');
  d.id = id;
  // Затваря се само при успех (v2.2.0) — иначе отказаният запис отнасяше със
  // себе си и биографията, която библиотекарят току-що е преписал от хартия.
  if (id) {
    if (await call(window.api.persons.update(d), 'Персоналията е обновена.') === null) return;
    closeModal(); renderPersons(); markSaved();
    return;
  }
  const newId = await call(window.api.persons.create(d), 'Персоналията е добавена.');
  if (newId === null) return;
  closeModal(); await renderPersons(); markSaved();
  if (newId) personView(newId);
}
window.savePerson = savePerson;

async function personView(id) {
  const [p, links] = await Promise.all([
    call(window.api.persons.get(id)),
    call(window.api.links.list({ fromKind: 'персона', fromId: id }))
  ]);
  if (!p) return;
  window._LINK_CTX = { kind: 'персона', id };
  modal(p.name, `
    <div class="prsView">
      <div class="prsViewPhoto">
        ${p.photo ? `<img src="${esc(p.photo)}" alt="">` : '<div class="logoEmpty">няма<br>снимка</div>'}
        <div class="toolbar" style="margin-top:8px">
          <button class="btn sm" onclick="localPhotoChoose('persons', ${id})">${p.photo ? 'Смени…' : 'Снимка…'}</button>
          ${p.photo ? `<button class="btn sm dgr" onclick="localPhotoClear('persons', ${id})">Махни</button>` : ''}
        </div>
      </div>
      <div class="prsViewBody">
        <div class="prsDates">${esc(personDates(p))}${p.birth_place ? ' · ' + esc(p.birth_place) : ''}</div>
        ${p.activity ? `<div class="prsAct" style="margin:6px 0">${esc(p.activity)}</div>` : ''}
        ${p.alt_names ? `<div class="hint">Известен още като: ${esc(p.alt_names)}</div>` : ''}
        ${p.bio ? `<p style="font-size:13.5px;line-height:1.6">${esc(p.bio).replace(/\n/g, '<br>')}</p>` : ''}
        ${p.awards ? `<div class="hint"><b>Отличия:</b> ${esc(p.awards)}</div>` : ''}
        ${p.sources ? `<div class="hint"><b>Източници:</b> ${esc(p.sources)}</div>` : ''}
      </div>
    </div>
    ${linksPanelHtml('персона', id, links || [])}`,
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn" onclick="closeModal();personForm(${id})">Редакция</button>
     <button class="btn dgr" onclick="personDelete(${id})">Изтрий</button>`);
}
window.personView = personView;
async function personDelete(id) {
  if (!confirm('Изтриване на персоналията и всичките ѝ връзки?')) return;
  await call(window.api.persons.delete(id), 'Персоналията е изтрита.');
  closeModal(); renderPersons();
}
window.personDelete = personDelete;
