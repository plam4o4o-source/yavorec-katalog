/* ---------------- Отчисляване ---------------- */
async function renderActs() {
  const rows = await call(window.api.deaccessionActs.list());
  if (!rows) return;
  $('#view').innerHTML = `
    <div class="note d"><b>Чл. 35</b> — отчисляването се извършва от комисия. В един акт се вписват документи,
    отчислени само по една причина (чл. 30).</div>
    <div class="toolbar"><button class="btn pri" onclick="actForm()">+ Нов акт за отчисляване</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Акт №</th><th>Дата</th><th>Причина</th>
      <th>Брой</th><th>Стойност</th><th>Начин</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(a => `<tr><td class="num">${a.no} / ${a.year}</td><td class="num">${bg(a.date)}</td>
      <td>т. ${a.reason_code}. ${esc(a.reason_text)}</td><td class="num">${a.item_count}</td>
      <td class="num">${mny(a.item_value)}</td><td style="font-size:12px">${esc(a.disposal || '')}</td>
      <td><button class="btn sm" onclick="openAct(${a.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="7" class="empty">Няма съставени актове.</td></tr>`}
    </tbody></table></div>`;
}
let ACT_LIST = [];
async function actForm() {
  ACT_LIST = [];
  const y = yr();
  const no = await call(window.api.deaccessionActs.nextNo(y));
  const s = await call(window.api.settings.get());
  modal('Акт за отчисляване на библиотечни документи', `
    <form id="actF" onsubmit="return false">
      <div class="grid g3">
        ${fld('Акт №', 'no', { val: no, req: 1 })}
        ${fld('Дата', 'date', { val: today(), type: 'date', req: 1 })}
        ${fld('Заповед №', 'order_no', {})}
      </div>
      ${fld('Причина за отчисляване', 'reason_code', { type: 'select', opts: PRICHINI.map(p => ({ v: p.k, t: 'т. ' + p.k + '. ' + p.t })) })}
      <div class="grid g2">
        ${fld('Начин на разпореждане', 'disposal', { type: 'select', opts: ['предадени за вторични суровини', 'продадени', 'предоставени безвъзмездно на друга библиотека', 'предоставени на организация в обществена полза', 'обменени с друга библиотека', 'унищожени'] })}
        ${fld('Приложен документ', 'attach', {})}
      </div>
      <fieldset><legend>Списък на отчислените документи — чл. 35, ал. 2</legend>
        <div class="toolbar">
          <input id="actScan" placeholder="Въведете инвентарен № или баркод и натиснете Enter" autocomplete="off">
          <button type="button" class="btn" onclick="actAdd()">Добави</button>
        </div>
        <div id="actList"></div>
      </fieldset>
      <div class="grid g3">
        ${fld('Член на комисия 1', 'committee1', { val: s ? s.committee1 || '' : '' })}
        ${fld('Член на комисия 2', 'committee2', { val: s ? s.committee2 || '' : '' })}
        ${fld('Член на комисия 3 (счетоводител)', 'committee3', { val: s ? s.committee3 || '' : '' })}
      </div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveAct()">Утвърди акта и отчисли</button>`);
  setTimeout(() => {
    const el = $('#actScan'); if (!el) return; el.focus();
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); actAdd(); } });
    drawActList();
  }, 60);
}
window.actForm = actForm;
async function actAdd() {
  const el = $('#actScan'), code = el.value.trim(); if (!code) return;
  const b = await call(window.api.deaccessionActs.findBook(code));
  el.value = '';
  if (!b) return toast('Няма документ с баркод/инв. № ' + code, 'err');
  if (ACT_LIST.some(x => x.id === b.id)) return toast('Инв. № ' + b.inv_number + ' вече е в списъка.', 'err');
  if (b.available < b.quantity) toast('Внимание: инв. № ' + b.inv_number + ' в момента е зает от читател.', 'err');
  ACT_LIST.push(b);
  drawActList();
}
window.actAdd = actAdd;
function actDel(n) { ACT_LIST.splice(n, 1); drawActList(); }
window.actDel = actDel;
/* Отчетната бройка на един ред от акта. Снимката (deaccession_items.quantity) е
   меродавна; NULL значи акт отпреди v2.4.9 и се чете като един документ, точно
   както се е броял тогава. Едно и също правило за екрана, за прозореца и за
   разпечатката — актът излиза от сградата подписан и отива в счетоводството,
   затова числото в него ТРЯБВА да е същото като в списъка „Отчисляване" и в
   реда на КДБФ Приложение № 3. */
function actQty(l) { return (l && l.quantity != null) ? (Number(l.quantity) || 0) : 1; }
function actCount(items) { return (items || []).reduce((s, l) => s + actQty(l), 0); }
function actValue(items) { return (items || []).reduce((s, l) => s + (Number(l.price) || 0) * actQty(l), 0); }

function drawActList() {
  const el = $('#actList'); if (!el) return;
  if (!ACT_LIST.length) { el.innerHTML = '<div class="hint">Списъкът е празен. Въведете инвентарните номера за отчисляване.</div>'; return; }
  el.innerHTML = `<div class="wrap" style="max-height:220px"><table class="ledger"><thead><tr>
    <th>Инв. №</th><th>Автор, заглавие</th><th>Год.</th><th>Цена</th><th></th></tr></thead><tbody>
    ${ACT_LIST.map((l, n) => `<tr><td class="num">${l.inv_number}</td>
    <td>${esc([l.author, l.title].filter(Boolean).join('. '))}</td><td class="num">${esc(l.year || '')}</td>
    <td class="num">${mny(l.price)}</td><td><button type="button" class="btn sm dgr" onclick="actDel(${n})">×</button></td></tr>`).join('')}
    <tr style="background:var(--paper3);font-weight:700"><td colspan="3">ОБЩО ${ACT_LIST.length} документа</td>
    <td class="num">${mny(ACT_LIST.reduce((s, l) => s + (Number(l.price) || 0), 0))}</td><td></td></tr>
    </tbody></table></div>`;
}
async function saveAct() {
  const missing = firstMissingRequired('#actF');
  if (missing) return toast(missing + ' е задължително поле.', 'err');
  const d = formData('#actF');
  if (!ACT_LIST.length) return toast('Добавете поне един документ в списъка.', 'err');
  const p = PRICHINI.find(x => x.k == d.reason_code);
  const act = Object.assign({}, d, { reason_text: p ? p.t : '' });
  const id = await call(window.api.deaccessionActs.create({ act, bookIds: ACT_LIST.map(b => b.id) }));
  if (id) { closeModal(); renderActs(); toast('Акт № ' + d.no + ': отчислени са ' + ACT_LIST.length + ' документа.', 'ok'); markSaved(); }
}
window.saveAct = saveAct;
async function openAct(id) {
  const a = await call(window.api.deaccessionActs.get(id));
  if (!a) return;
  modal('Акт за отчисляване № ' + a.no + ' / ' + a.year, `
    <div class="note d"><b>Причина (чл. 30, т. ${a.reason_code}):</b> ${esc(a.reason_text)}<br>
    <b>Разпореждане (чл. 36):</b> ${esc(a.disposal || '—')}${a.attach ? ' · ' + esc(a.attach) : ''}</div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор, заглавие</th><th>Год.</th><th>Цена</th></tr></thead><tbody>
    ${a.items.map(l => `<tr><td class="num">${l.inv_number}</td><td>${esc([l.author, l.title].filter(Boolean).join('. '))}</td>
    <td class="num">${esc(l.year || '')}</td><td class="num">${mny(l.price)}</td></tr>`).join('')}
    <tr style="background:var(--paper3);font-weight:700"><td colspan="3">ОБЩО ${actCount(a.items)}${
      actCount(a.items) !== a.items.length ? ` (${a.items.length} заглавия)` : ''}</td>
    <td class="num">${mny(actValue(a.items))}</td></tr>
    </tbody></table></div>
    <div class="hint" style="margin-top:10px">Комисия: ${[a.committee1, a.committee2, a.committee3].filter(Boolean).map(esc).join(' · ') || '—'}</div>`,
    `<button class="btn l dgr" onclick="revokeAct(${id})">Анулирай акта</button>
     <button class="btn" onclick="printActDoc(${id})">Печат на акта / PDF</button>
     <button class="btn pri" onclick="closeModal()">Затвори</button>`);
}
window.openAct = openAct;
async function printActDoc(id) {
  const a = await call(window.api.deaccessionActs.get(id));
  if (!a) return;
  const s = SETTINGS_CACHE || {};
  const total = actValue(a.items);
  const count = actCount(a.items);
  setPrintPage({ name: `Акт за отчисляване № ${a.no}-${a.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>АКТ № ${a.no} / ${bg(a.date)}<br><span style="font-size:12pt">за отчисляване на библиотечни документи</span></h2>
    <div class="pmeta">Днес, ${bg(a.date)} г., комисия, назначена със заповед ${a.order_no ? '№ ' + esc(a.order_no) : '№ …………'} на
    ${esc(s.director_role || 'ръководителя')} на ${esc(s.org || '')}, в състав:<br>
    1. ${esc(a.committee1 || '…………………')} &nbsp; 2. ${esc(a.committee2 || '…………………')} &nbsp; 3. ${esc(a.committee3 || '…………………')} (счетоводител)<br><br>
    на основание <b>чл. 30, т. ${a.reason_code}</b> от Наредба № 3 от 18.11.2014 г. — <b>${esc(a.reason_text)}</b> — отчислява от библиотечния фонд
    <b>${count}</b> библиотечни документа${count !== a.items.length ? ` (${a.items.length} заглавия)` : ''} на обща стойност <b>${mny(total)}</b></div>
    <table><thead><tr><th>№</th><th>Инв. №</th><th>Автор, заглавие, том</th><th>Година</th><th>УДК</th><th>Стойност, лв.</th></tr></thead><tbody>
    ${a.items.map((l, n) => `<tr><td>${n + 1}</td><td>${l.inv_number}</td>
    <td>${esc([l.author, l.title].filter(Boolean).join('. '))}${l.volume ? ', т. ' + esc(l.volume) : ''}</td>
    <td>${esc(l.year || '')}</td><td>${esc(l.udk || '')}</td><td>${actQty(l) > 1 ? actQty(l) + ' × ' : ''}${mny(l.price)}</td></tr>`).join('')}
    <tr><td colspan="5"><b>ОБЩО</b></td><td><b>${mny(total)}</b></td></tr></tbody></table>
    <div class="pmeta">Начин на разпореждане по чл. 36: <b>${esc(a.disposal || '…………………')}</b>${a.attach ? '<br>Приложен документ: ' + esc(a.attach) : ''}<br>
    Актът е съставен в два екземпляра — по един за счетоводството и за библиотеката.</div>
    ${ssig(['Комисия: 1. ………… 2. ………… 3. …………', 'УТВЪРДИЛ, ' + esc(s.director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printActDoc = printActDoc;
async function revokeAct(id) {
  if (!confirm('Анулиране на акта и връщане на документите във фонда. Използвайте само при сгрешен акт. Да продължа?')) return;
  const res = await window.api.deaccessionActs.revoke(id);
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderActs(); toast('Актът е анулиран.', 'ok'); markSaved();
}
window.revokeAct = revokeAct;
