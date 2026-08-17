/* ============================================================================
   КРАЕЗНАНИЕ: аналитично описание, персоналии, летопис
   Тези три раздела съдържат данните, които се създават в самата библиотека и не
   могат да бъдат получени отвън — статии за селото, сведения за местни дейци и
   хронология на читалищната дейност.
   ============================================================================ */

/* ---------------- Аналитично описание ---------------- */
let ANL_Q = '', ANL_YEAR = '', ANL_LOCAL = false;
async function renderAnalytics() {
  const [rows, years] = await Promise.all([
    call(window.api.analytics.list({ q: ANL_Q, year: ANL_YEAR, onlyLocal: ANL_LOCAL })),
    call(window.api.analytics.years())
  ]);
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note"><b>Аналитично описание.</b> Описват се отделни статии от вестници и списания и
    части от книги — това, което не се вижда в обикновения каталог. За малката библиотека тук се
    натрупва краеведският масив: материали за селото, за читалището и за местните хора, които не
    съществуват описани никъде другаде.</div>

    <div class="toolbar">
      <button class="btn pri" onclick="analyticForm()">+ Ново описание</button>
      <input type="search" id="anlQ" placeholder="Търсене по заглавие, автор, ключови думи, източник…"
        value="${esc(ANL_Q)}" oninput="anlSearch(this.value)">
      <select onchange="anlYear(this.value)">
        <option value="">— всички години —</option>
        ${(years || []).map(y => `<option value="${esc(y.year)}" ${ANL_YEAR === y.year ? 'selected' : ''}>
          ${esc(y.year)} (${y.n})</option>`).join('')}
      </select>
      <label class="chk" style="margin:0"><input type="checkbox" ${ANL_LOCAL ? 'checked' : ''}
        onchange="anlLocal(this.checked)"> само краеведски</label>
      <button class="btn" onclick="printAnalytics()">Печат / PDF</button>
    </div>

    <div id="anlList">${analyticsListHtml(rows)}</div>`;
}
/* Броячите и таблицата — единственото, което зависи от търсенето. */
function analyticsListHtml(rows) {
  const total = rows.length, local = rows.filter(r => r.is_local).length;
  return `<div class="kpis">
      ${kpi('📰', total, 'Описани статии', ANL_YEAR ? 'за ' + ANL_YEAR + ' г.' : 'общо в базата')}
      ${kpi('🏡', local, 'Краеведски', 'за селото и района')}
    </div>

    ${rows.length ? `<div class="wrap"><table class="ledger"><thead><tr>
      <th>Автор и заглавие</th><th style="width:30%">Източник</th><th style="width:70px">Год.</th>
      <th style="width:90px">Стр.</th><th style="width:130px"></th></tr></thead><tbody>
      ${rows.map(a => `<tr>
        <td><b>${esc(a.title)}</b>${a.subtitle ? ' : ' + esc(a.subtitle) : ''}
          ${a.author ? `<br><span class="hint">${esc(a.author)}</span>` : ''}
          ${a.is_local ? '<span class="tag tagLocal">краеведски</span>' : ''}</td>
        <td class="hint">${esc(analyticSource(a))}</td>
        <td class="num">${esc(a.year || '')}</td>
        <td class="num">${esc(a.pages || '')}</td>
        <td><button class="btn sm" onclick="analyticForm(${a.id})">Редакция</button>
            <button class="btn sm dgr" onclick="analyticDelete(${a.id})">Изтрий</button></td></tr>`).join('')}
      </tbody></table></div>`
    : `<div class="empty"><h3>Няма описани статии</h3>
        <p>Започнете от най-близкото: статии за селото в областния вестник, материали в читалищни
        сборници, глави от краеведски книги.</p></div>`}`;
}
/* Търсенето пипа само #anlList — полето за търсене НЕ се пресъздава, иначе
   курсорът изчезва при всяка пауза над 300 ms (моделът от inv-book.js). */
async function refreshAnalytics() {
  const rows = await call(window.api.analytics.list({ q: ANL_Q, year: ANL_YEAR, onlyLocal: ANL_LOCAL }));
  if (!rows) return;
  const box = $('#anlList');
  if (box) box.innerHTML = analyticsListHtml(rows); else renderAnalytics();
}
window.refreshAnalytics = refreshAnalytics;
function analyticSource(a) {
  if (a.source_kind === 'периодика' && a.periodical_title) {
    return a.periodical_title + (a.issue ? ', бр. ' + a.issue : '') + (a.issue_date ? ' от ' + bg(a.issue_date) : '');
  }
  if (a.source_kind === 'книга' && a.book_title) {
    return [a.book_author, a.book_title].filter(Boolean).join('. ') +
      (a.book_inv ? ' (инв. № ' + a.book_inv + ')' : '');
  }
  return a.source_text || '—';
}
function anlSearch(v) { ANL_Q = v; clearTimeout(window._anlT); window._anlT = setTimeout(refreshAnalytics, 300); }
window.anlSearch = anlSearch;
function anlYear(v) { ANL_YEAR = v; renderAnalytics(); }
window.anlYear = anlYear;
function anlLocal(v) { ANL_LOCAL = v; renderAnalytics(); }
window.anlLocal = anlLocal;

async function printAnalytics() {
  const rows = await call(window.api.analytics.list({ q: ANL_Q, year: ANL_YEAR, onlyLocal: ANL_LOCAL }));
  if (!rows || !rows.length) return toast('Няма записи за печат.', 'err');
  setPrintPage({ name: (ANL_YEAR ? `Аналитично описание ${ANL_YEAR} г.` : 'Аналитично описание'), landscape: false, margin: '16mm 14mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 class="ptitle">АНАЛИТИЧНО ОПИСАНИЕ${ANL_YEAR ? ' — ' + esc(ANL_YEAR) + ' г.' : ''}${ANL_LOCAL ? ' (краеведски)' : ''}</h2>
    ${rows.map(a => `<div style="margin-bottom:8px">
      <b>${esc(a.title)}</b>${a.subtitle ? ' : ' + esc(a.subtitle) : ''}${a.year ? ' (' + esc(a.year) + ')' : ''}
      ${a.is_local ? ' <i>— краеведски</i>' : ''}
      ${a.author ? `<div style="font-size:10.5pt">${esc(a.author)}</div>` : ''}
      <div style="font-size:10.5pt">${esc(analyticSource(a))}${a.pages ? ', стр. ' + esc(a.pages) : ''}</div>
    </div>`).join('')}
    ${ssig(['Съставил: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Председател') + ': …………………'])}</div>`);
}
window.printAnalytics = printAnalytics;

async function analyticForm(id) {
  const [a, pers, sug] = await Promise.all([
    id ? call(window.api.analytics.get(id)) : null,
    call(window.api.periodicals.list()),
    loadAuthSuggest()
  ]);
  const v = a || { source_kind: 'периодика', is_local: 1, year: String(new Date().getFullYear()) };
  const perOpts = (pers || []).map(p => ({ v: p.id, t: p.title }));
  modal(id ? 'Редакция на описание' : 'Ново аналитично описание', `
    <form id="anlF" onsubmit="return false">
    <fieldset><legend>Статията</legend>
      <div class="grid g2">
        ${fld('Заглавие на статията', 'title', { val: v.title || '', req: 1 })}
        ${fld('Автор', 'author', { val: v.author || '', list: 'author' })}
      </div>
      <div class="grid g4">
        ${fld('Подзаглавие', 'subtitle', { val: v.subtitle || '' })}
        ${fld('Година', 'year', { val: v.year || '' })}
        ${fld('Страници', 'pages', { val: v.pages || '', hint: 'напр. „12 – 14“' })}
        ${fld('УДК', 'udk', { val: v.udk || '', list: 'udk' })}
      </div>
    </fieldset>
    <fieldset><legend>Източник</legend>
      ${fld('Вид източник', 'source_kind', { type: 'select', allowEmpty: false, val: v.source_kind,
        opts: ['периодика', 'книга', 'друго'] })}
      <div class="grid g3">
        ${fld('Периодично издание', 'periodical_id', { type: 'select', val: v.periodical_id,
          opts: perOpts, emptyLabel: '— изберете —' })}
        ${fld('Брой', 'issue', { val: v.issue || '' })}
        ${fld('Дата на броя', 'issue_date', { val: v.issue_date || '', type: 'date' })}
      </div>
      ${fld('Книга от фонда (инв. № или заглавие)', 'book_pick', { val: v.book_id ? (v.book_author ? v.book_author + '. ' : '') + (v.book_title || '') : '',
        hint: 'попълва се само при вид „книга“ — изберете от списъка' , list: 'anlBooks' })}
      <input type="hidden" name="book_id" value="${esc(v.book_id || '')}">
      ${fld('Описание на източника със свободен текст', 'source_text', { val: v.source_text || '',
        hint: 'когато изданието не е във фонда — напр. „100 вести, бр. 145 от 12.07.2019“' })}
    </fieldset>
    <fieldset><legend>Съдържание</legend>
      <div class="grid g2">
        ${fld('Ключови думи', 'keywords', { val: v.keywords || '', list: 'keywords', hint: 'през запетая' })}
        ${fld('Забележка', 'note', { val: v.note || '' })}
      </div>
      ${fld('Анотация', 'annotation', { type: 'textarea', val: v.annotation || '', rows: 3 })}
      <label class="chk"><input type="checkbox" name="is_local" ${v.is_local ? 'checked' : ''}>
        <span>Краеведски материал — за селото, читалището или местни хора</span></label>
    </fieldset>
    </form>
    ${datalistsHtml(sug || {})}
    <datalist id="dl_anlBooks"></datalist>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveAnalytic(${id || 'null'})">Запиши</button>`);
  // Списъкът с книги се пълни при писане, за да не се зареждат хиляди записи наведнъж.
  const bp = $('#anlF [name=book_pick]');
  if (bp) bp.addEventListener('input', async () => {
    const q = bp.value.trim();
    const hidden = $('#anlF [name=book_id]');
    if (q.length < 2) { hidden.value = ''; return; }
    const found = await call(window.api.links.search({ kind: 'книга', q }));
    const dl = $('#dl_anlBooks');
    dl.innerHTML = (found || []).map(f => `<option value="${esc(f.label)}"></option>`).join('');
    const exact = (found || []).find(f => f.label === q);
    hidden.value = exact ? exact.id : '';
  });
}
window.analyticForm = analyticForm;
async function saveAnalytic(id) {
  const missing = firstMissingRequired('#anlF');
  if (missing) return toast(missing + ' е задължително поле.', 'err');
  const d = formData('#anlF');
  delete d.book_pick;
  d.id = id;
  // Затваря се само при успех (v2.2.0) — иначе отказаният запис губеше цялото
  // аналитично описание, набирано на ръка от статията.
  const ok = id ? await call(window.api.analytics.update(d), 'Описанието е обновено.')
    : await call(window.api.analytics.create(d), 'Описанието е добавено.');
  if (ok === null) return;
  closeModal(); renderAnalytics(); markSaved();
}
window.saveAnalytic = saveAnalytic;
async function analyticDelete(id) {
  if (!confirm('Изтриване на това аналитично описание?')) return;
  await call(window.api.analytics.delete(id), 'Описанието е изтрито.');
  renderAnalytics();
}
window.analyticDelete = analyticDelete;
