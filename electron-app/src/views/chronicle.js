/* ---------------- Летопис ---------------- */
let CHR_Q = '', CHR_YEAR = '';
const CHR_CATS = ['читалище', 'библиотека', 'самодейност', 'дарение', 'строителство', 'юбилей', 'друго'];
async function renderChronicle() {
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

    <div id="chrList">${chronicleListHtml(rows)}</div>`;
}
function chronicleListHtml(rows) {
  // Записите се групират по година, за да се чете като истински летопис.
  const byYear = {};
  for (const r of rows) { (byYear[r.year] = byYear[r.year] || []).push(r); }
  const yearsSorted = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  return rows.length ? yearsSorted.map(y => `
      <div class="chrYear">
        <div class="chrYearHead">${esc(y)}</div>
        ${byYear[y].map(c => `<div class="chrItem" tabindex="0" role="button" aria-label="${esc(c.title)}"
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
        </div>`).join('')}
      </div>`).join('')
    : `<div class="empty"><h3>Летописът е празен</h3>
        <p>Впишете първото събитие — основаването на читалището, откриването на библиотеката,
        юбилей, дарение, ремонт.</p></div>`;
}
/* Търсенето пипа само #chrList — полето за търсене НЕ се пресъздава, иначе при
   пауза над 300 ms курсорът изчезва по средата на думата (моделът от inv-book.js). */
async function refreshChronicle() {
  const rows = await call(window.api.chronicle.list({ q: CHR_Q, year: CHR_YEAR }));
  if (!rows) return;
  const box = $('#chrList');
  if (box) box.innerHTML = chronicleListHtml(rows); else renderChronicle();
}
window.refreshChronicle = refreshChronicle;
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
      ${fld('Година', 'year', { val: v.year || '', req: 1 })}
      ${fld('Точна дата (ако е известна)', 'date', { val: v.date || '', type: 'date' })}
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
async function saveChronicle(id) {
  const d = formData('#chrF');
  if (!d.title.trim()) return toast('Заглавието на събитието е задължително.', 'err');
  if (!d.year.trim() && !d.date) return toast('Годината е задължителна.', 'err');
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
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn" onclick="closeModal();chronicleForm(${id})">Редакция</button>
     <button class="btn dgr" onclick="chronicleDelete(${id})">Изтрий</button>`);
}
window.chronicleView = chronicleView;
async function chronicleDelete(id) {
  if (!confirm('Изтриване на записа от летописа?')) return;
  await call(window.api.chronicle.delete(id), 'Записът е изтрит.');
  closeModal(); renderChronicle();
}
window.chronicleDelete = chronicleDelete;

async function printChronicle() {
  const rows = await call(window.api.chronicle.list({ year: CHR_YEAR }));
  if (!rows || !rows.length) return toast('Няма записи за печат.', 'err');
  const byYear = {};
  for (const r of rows) { (byYear[r.year] = byYear[r.year] || []).push(r); }
  const years = Object.keys(byYear).sort();
  setPrintPage({ name: (CHR_YEAR ? `Летопис ${CHR_YEAR} г.` : 'Летопис'), landscape: false, margin: '16mm 14mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 class="ptitle">ЛЕТОПИС${CHR_YEAR ? ' — ' + esc(CHR_YEAR) + ' г.' : ''}</h2>
    ${years.map(y => `<h3 style="margin:10px 0 4px">${esc(y)} г.</h3>
      ${byYear[y].map(c => `<div style="margin-bottom:7px">
        <b>${esc(c.title)}</b>${c.date ? ' · ' + esc(bg(c.date)) : ''}${c.category ? ' · ' + esc(c.category) : ''}
        ${c.body ? `<div style="font-size:11pt">${esc(c.body).replace(/\n/g, '<br>')}</div>` : ''}
        ${c.participants ? `<div style="font-size:10pt"><i>Участници: ${esc(c.participants)}</i></div>` : ''}
      </div>`).join('')}`).join('')}
    ${ssig(['Летописец: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Председател') + ': …………………'])}</div>`);
}
window.printChronicle = printChronicle;
