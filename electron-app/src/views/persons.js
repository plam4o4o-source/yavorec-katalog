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
    </div>

    ${rows.length ? `<div class="cardGrid">
      ${rows.map(p => `<div class="prsCard" onclick="personView(${p.id})">
        <div class="prsPhoto">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : '<span>без снимка</span>'}</div>
        <div class="prsBody">
          <div class="prsName">${esc(p.name)}</div>
          <div class="prsDates">${esc(personDates(p))}</div>
          ${p.activity ? `<div class="prsAct">${esc(p.activity)}</div>` : ''}
          <div class="prsLinks">${p.links ? p.links + ' свързани материала' : 'няма свързани материали'}</div>
        </div>
      </div>`).join('')}
    </div>`
    : `<div class="empty"><h3>Няма вписани персоналии</h3>
        <p>Започнете от хората, за които читалището вече пази сведения на хартия.</p></div>`}`;
}
function personDates(p) {
  const b = p.birth_date ? bg(p.birth_date) : '';
  const d = p.death_date ? bg(p.death_date) : '';
  if (b && d) return b + ' – ' + d;
  if (b) return 'р. ' + b;
  if (d) return 'п. ' + d;
  return '';
}
function prsSearch(v) { PRS_Q = v; clearTimeout(window._prsT); window._prsT = setTimeout(renderPersons, 300); }
window.prsSearch = prsSearch;

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
  if (id) await call(window.api.persons.update(d), 'Персоналията е обновена.');
  else {
    const newId = await call(window.api.persons.create(d), 'Персоналията е добавена.');
    closeModal(); await renderPersons(); markSaved();
    if (newId) personView(newId);
    return;
  }
  closeModal(); renderPersons(); markSaved();
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
