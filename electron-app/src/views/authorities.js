/* ---------------- Авторитетни данни: преглед и сливане на дубликати ---------------- */
let AUTH_FIELD = 'author';
let AUTH_LOOSE = false;
async function renderAuth() {
  const [fields, groups, values] = await Promise.all([
    call(window.api.authorities.fields()),
    call(window.api.authorities.duplicates({ field: AUTH_FIELD, loose: AUTH_LOOSE })),
    call(window.api.authorities.list(AUTH_FIELD))
  ]);
  const f = fields || {};
  const total = (values || []).length;
  const dupes = groups || [];
  const affected = dupes.reduce((n, g) => n + g.total, 0);
  $('#view').innerHTML = `
    <div class="note"><b>Едно и също име, въведено по няколко начина, разпилява записите.</b>
    „Вазов, Иван“, „Иван Вазов“ и „И. Вазов“ са един автор, но за програмата са три различни
    стойности — търсенето по единия вариант не намира документите, описани с другите.
    Тук те се откриват и сливат в един вид.</div>

    <div class="card">
      <div class="grid g3">
        ${fld('Поле', 'authField', { type: 'select', allowEmpty: false, val: AUTH_FIELD,
          opts: Object.entries(f).map(([v, t]) => ({ v, t: t[0].toUpperCase() + t.slice(1) })) })}
        <div class="field"><label>Как се търсят дубликати</label>
          <select name="authLoose">
            <option value="0" ${!AUTH_LOOSE ? 'selected' : ''}>Разместени думи („Вазов, Иван“ = „Иван Вазов“)</option>
            <option value="1" ${AUTH_LOOSE ? 'selected' : ''}>И съкратени имена („И. Вазов“ = „Иван Вазов“)</option>
          </select>
        </div>
        <div class="field"><label>&nbsp;</label>
          <button class="btn pri" onclick="authApply()" style="width:100%">Покажи</button></div>
      </div>
      <div class="hint">Различни стойности в полето: <b>${total}</b> ·
      възможни дублети: <b>${dupes.length}</b> ${dupes.length ? `групи, засягащи <b>${affected}</b> документа` : ''}</div>
    </div>

    ${dupes.length ? `
      <div class="hint" style="margin:14px 0 8px">Отбележете кой вид да остане и натиснете „Слей“.
      Останалите стойности в групата се заменят с него във всички документи.</div>
      ${dupes.map((g, i) => authGroupHtml(g, i)).join('')}
    ` : `<div class="card" style="margin-top:16px"><div class="empty">
        Няма открити дублети по този критерий.
        ${!AUTH_LOOSE ? 'Опитайте и с „И съкратени имена“ — той хваща и „И. Вазов“.' : ''}
      </div></div>`}

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Всички стойности в полето</h3>
      <div class="hint" style="margin-top:0">Подредени по брой документи. Този списък се предлага
      за автодовършване при въвеждане на нова книга.</div>
      <table class="ledger" style="margin-top:8px"><thead><tr><th>Стойност</th><th style="width:120px">Документи</th></tr></thead>
        <tbody>${(values || []).slice(0, 300).map(v => `<tr>
          <td>${esc(v.value)}</td><td class="num">${v.n}</td></tr>`).join('')}</tbody></table>
      ${total > 300 ? `<div class="hint">Показани са първите 300 от ${total}.</div>` : ''}
    </div>`;
}
function authGroupHtml(g, i) {
  return `<div class="authGroup" id="ag${i}">
    ${g.items.map((it, j) => `<label class="authRow">
      <input type="radio" name="ag${i}sel" value="${esc(it.value)}" ${j === 0 ? 'checked' : ''}>
      <span class="authVal">${esc(it.value)}</span>
      <span class="authN">${it.n} док.</span>
      <span class="authTarget">${j === 0 ? 'предложено' : ''}</span>
    </label>`).join('')}
    <div class="toolbar" style="margin-top:8px">
      <button class="btn pri" onclick="authMerge(${i})">Слей в отбелязаното</button>
      <span class="hint">общо ${g.total} документа в тази група</span>
    </div>
  </div>`;
}
function authApply() {
  AUTH_FIELD = $('[name=authField]').value;
  AUTH_LOOSE = $('[name=authLoose]').value === '1';
  renderAuth();
}
window.authApply = authApply;
async function authMerge(i) {
  const box = $('#ag' + i);
  const target = box.querySelector(`input[name=ag${i}sel]:checked`);
  if (!target) return toast('Отбележете коя стойност да остане.', 'err');
  const all = [...box.querySelectorAll(`input[name=ag${i}sel]`)].map(x => x.value);
  const from = all.filter(v => v !== target.value);
  if (!from.length) return toast('Няма какво да се слее.', 'err');
  if (!confirm(`Сливане на ${from.length} стойности в „${target.value}“?\n\n` +
    from.map(v => '• ' + v).join('\n') + '\n\nПромяната засяга всички документи с тези стойности.')) return;
  const r = await call(window.api.authorities.merge({ field: AUTH_FIELD, from, to: target.value }),
    null);
  if (!r) return;
  toast(`Слети ${r.merged} стойности в „${target.value}“ — променени ${r.changed} документа.`, 'ok');
  markSaved();
  AUTH_SUGGEST = null; // списъкът за автодовършване вече е различен
  renderAuth();
}
window.authMerge = authMerge;
