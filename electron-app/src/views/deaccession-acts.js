/* ---------------- Отчисляване ---------------- */
async function renderActs() {
  const rows = await call(window.api.deaccessionActs.list());
  if (!rows) return;
  /* Проектите се четат отделно и стоят НАД актовете (v2.4.56). Проектът не е
     документ: няма номер, нищо не е отчислено, документите са във фонда. Виждат
     се първи, защото са недовършена работа и чакат комисията. */
  const drafts = (await call(window.api.deaccessionActs.drafts())) || [];
  $('#view').innerHTML = `
    <div class="note d"><b>Чл. 35</b> — отчисляването се извършва от комисия. В един акт се вписват документи,
    отчислени само по една причина (чл. 30). Утвърденият акт е документ и <b>не се изтрива</b> (чл. 39):
    ако е сгрешен, се <b>анулира</b> с основание, номерът му остава зает, а документите се връщат във фонда.
    Затова подгответе го първо като <b>проект</b> — проектът се поправя и трие свободно.</div>
    <div class="toolbar">
      <button class="btn pri" onclick="actForm()">+ Нов акт за отчисляване</button>
      <button class="btn" onclick="actForm(null, 1)">+ Нов проект</button>
    </div>
    ${drafts.length ? `<h3 style="margin:14px 0 6px">Проекти (още не са актове)</h3>
    <div class="wrap"><table class="ledger"><thead><tr><th>Проект №</th><th>Дата</th><th>Причина</th>
      <th>Заглавия</th><th>Поправен</th><th></th></tr></thead><tbody>
    ${drafts.map(d => `<tr><td class="num">${d.id}</td><td class="num">${bg(d.date) || '—'}</td>
      <td>${d.reason_code ? 'т. ' + d.reason_code + '. ' : ''}${esc(d.reason_text || '— без причина —')}</td>
      <td class="num">${d.title_count}</td><td class="num" style="font-size:12px">${esc(String(d.updated_at || '').slice(0, 16))}</td>
      <td><button class="btn sm" onclick="openDraft(${d.id})">Отвори</button>
          <button class="btn sm dgr" onclick="delDraft(${d.id})">Изтрий</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${drafts.length ? '<h3 style="margin:18px 0 6px">Съставени актове</h3>' : ''}
    <div class="wrap"><table class="ledger"><thead><tr><th>Акт №</th><th>Дата</th><th>Причина</th>
      <th>Брой</th><th>Стойност</th><th>Начин</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(a => `<tr${a.revoked_at ? ' class="revokedRow"' : ''}><td class="num">${a.no} / ${a.year}</td>
      <td class="num">${bg(a.date)}</td>
      <td>т. ${a.reason_code}. ${esc(a.reason_text)}${a.revoked_at
        ? `<br><span class="badge warn">АНУЛИРАН</span> ${esc(String(a.revoked_at).slice(0, 10))}${
            a.revoke_reason ? ' — ' + esc(a.revoke_reason) : ''}` : ''}</td>
      <td class="num">${a.revoked_at ? '—' : a.item_count}</td>
      <td class="num">${a.revoked_at ? '—' : mny(a.item_value)}</td><td style="font-size:12px">${esc(a.disposal || '')}</td>
      <td><button class="btn sm" onclick="openAct(${a.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="7" class="empty">Няма съставени актове.</td></tr>`}
    </tbody></table></div>`;
}
let ACT_LIST = [];
let ACT_DRAFT_ID = null;
/* Една форма за двете състояния (v2.4.56). `asDraft` сменя само заглавието,
   бутоните и това дали номерът се пита — самите полета са същите, защото
   проектът става акт без нищо да се преписва. */
async function actForm(draft, asDraft) {
  ACT_LIST = (draft && draft.items) ? draft.items.slice() : [];
  ACT_DRAFT_ID = draft ? draft.id : null;
  const isDraft = !!(asDraft || draft);
  const y = yr();
  const no = isDraft ? null : await call(window.api.deaccessionActs.nextNo(y));
  const s = await call(window.api.settings.get());
  const v = draft || {};
  modal(isDraft ? 'Проект за акт за отчисляване' : 'Акт за отчисляване на библиотечни документи', `
    ${isDraft ? `<div class="note"><b>Това е проект, не акт.</b> Нищо не се отчислява, документите остават във фонда
      и могат да се заемат. Номер се взима чак при утвърждаването — затова проектът може да се поправя и трие
      свободно, за разлика от утвърдения акт (чл. 39).</div>` : ''}
    <form id="actF" onsubmit="return false">
      <div class="grid g3">
        ${isDraft ? '' : fld('Акт №', 'no', { val: no, req: 1 })}
        ${fld('Дата', 'date', { val: v.date || today(), type: 'date', req: isDraft ? 0 : 1 })}
        ${fld('Заповед №', 'order_no', { val: v.order_no || '' })}
      </div>
      ${/* req: чл. 30 изисква точно една причина за акт. Одит v2.4.25: без req
            празният ред „—“ минаваше и подписаният акт печаташе „чл. 30, т. null“. */''}
      ${fld('Причина за отчисляване', 'reason_code', { type: 'select', req: isDraft ? 0 : 1, emptyLabel: '— изберете —',
        val: v.reason_code || '', opts: PRICHINI.map(p => ({ v: p.k, t: 'т. ' + p.k + '. ' + p.t })) })}
      <div class="grid g2">
        ${fld('Начин на разпореждане', 'disposal', { type: 'select', val: v.disposal || '', opts: ['предадени за вторични суровини', 'продадени', 'предоставени безвъзмездно на друга библиотека', 'предоставени на организация в обществена полза', 'обменени с друга библиотека', 'унищожени'] })}
        ${fld('Приложен документ', 'attach', { val: v.attach || '' })}
      </div>
      <fieldset><legend>Списък на отчислените документи — чл. 35, ал. 2</legend>
        <div class="toolbar">
          <input id="actScan" placeholder="Въведете инвентарен № или баркод и натиснете Enter" autocomplete="off">
          <button type="button" class="btn" onclick="actAdd()">Добави</button>
        </div>
        <div id="actList"></div>
      </fieldset>
      <div class="grid g3">
        ${fld('Член на комисия 1', 'committee1', { val: v.committee1 || (s ? s.committee1 || '' : '') })}
        ${fld('Член на комисия 2', 'committee2', { val: v.committee2 || (s ? s.committee2 || '' : '') })}
        ${fld('Член на комисия 3 (счетоводител)', 'committee3', { val: v.committee3 || (s ? s.committee3 || '' : '') })}
      </div>
    </form>`,
    isDraft
      ? `<button class="btn" onclick="closeModal()">Отказ</button>
         <button class="btn" onclick="saveActDraft()">Запиши проекта</button>
         <button class="btn pri" onclick="approveActDraft()">Утвърди като акт и отчисли</button>`
      : `<button class="btn" onclick="closeModal()">Отказ</button>
         <button class="btn" onclick="saveActDraft()">Запиши като проект</button>
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
  /* call() вече показва обяснението при отказ (напр. двусмислен код — виж
     resolveScannedBook) и връща null. Затова тук се различава ОТКАЗ от „няма такъв“:
     иначе върху точното обяснение се наслагваше второ, противоречащо му известие
     „Няма документ с баркод…“. */
  const res = await window.api.deaccessionActs.findBook(code);
  el.value = '';
  if (!res.ok) return toast(res.error, 'err');
  const b = res.data;
  if (!b) return toast('Няма документ с баркод/инв. № ' + code, 'err');
  if (ACT_LIST.some(x => x.id === b.id)) return toast('Инв. № ' + b.inv_number + ' вече е в списъка.', 'err');
  if (b.available < b.quantity) toast('Внимание: инв. № ' + b.inv_number + ' в момента е зает от читател.', 'err');
  /* Изгубеният документ носи със себе си и обезщетението (v2.4.56). Казва се на
     глас още при добавянето в акта, защото точно това пита счетоводството, щом
     актът е по чл. 30, т. 5, а дотук трите действия не се срещаха никъде. */
  if (b.lost) {
    const c = b.lost.charge;
    toast('Инв. № ' + b.inv_number + ' е изгубен от '
      + (b.lost.reader_name || 'читател') + ' — ' + (b.lost.lost_resolution || 'уреждането не е отбелязано')
      + (c ? '; начислено ' + mny(c.charged || 0) + ', събрано ' + mny(c.covered || 0) : '')
      + '. Ползвайте причина по чл. 30, т. 5.', 'warn');
  }
  /* Проверката за заетост по-горе ползва b.quantity (наличност). СЛЕД нея полето
     се заменя с ОТЧЕТНАТА бройка, защото от този момент нататък редът живее в
     ACT_LIST и се брои от actQty() по същото правило, по което ще бъде снимано в
     акта: NULL → 1 документ, изрична 0 → 0. Виж бележката при findBook. */
  b.quantity = b.fund_qty;
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
/* Има ли изобщо ред, чиято бройка не е един документ. Дотук пояснението
   „(N заглавия)“ се появяваше при `actCount !== items.length` — условие, което
   се изпълнява СЛУЧАЙНО и в случаи, когато не бива: акт с един ред от 0
   екземпляра и един от 2 дава 2 документа при 2 заглавия, тоест пояснението
   изчезва точно когато е най-нужно, а в таблицата стои ред с цена, който не
   участва нито в бройката, нито в сбора. */
function actHasMultiples(items) { return (items || []).some(l => actQty(l) !== 1); }
// Съгласуване в единствено число (одит v2.4.24) — текстът стои върху акт, който се
// подписва и отива в счетоводството, и в потвърждението на екрана.
function actDocs(n) { return n + (n === 1 ? ' документ' : ' документа'); }
function actTitles(n) { return n + (n === 1 ? ' заглавие' : ' заглавия'); }
// Означението пред цената на един ред. Показва се при ВСЯКА бройка, различна от
// един документ — включително изричната нула, иначе редът изглежда като пропуск.
function actQtyMark(l) { return actQty(l) !== 1 ? actQty(l) + ' × ' : ''; }

function drawActList() {
  const el = $('#actList'); if (!el) return;
  if (!ACT_LIST.length) { el.innerHTML = '<div class="hint">Списъкът е празен. Въведете инвентарните номера за отчисляване.</div>'; return; }
  el.innerHTML = `<div class="wrap" style="max-height:220px"><table class="ledger"><thead><tr>
    <th>Инв. №</th><th>Автор, заглавие</th><th>Год.</th><th>Цена</th><th></th></tr></thead><tbody>
    ${ACT_LIST.map((l, n) => `<tr><td class="num">${l.inv_number}</td>
    <td>${esc([l.author, l.title].filter(Boolean).join('. '))}${l.lost
      ? `<br><span class="badge warn">изгубен</span> <span class="hint">${esc(l.lost.reader_name || 'читател')} · ${
          esc(l.lost.lost_resolution || 'уреждането не е отбелязано')}${l.lost.charge
            ? ' · начислено ' + mny(l.lost.charge.charged || 0) + ', събрано ' + mny(l.lost.charge.covered || 0) : ''}</span>` : ''}</td>
    <td class="num">${esc(l.year || '')}</td>
    <td class="num">${actQtyMark(l)}${mny(l.price)}</td><td><button type="button" class="btn sm dgr" onclick="actDel(${n})">×</button></td></tr>`).join('')}
    <tr style="background:var(--paper3);font-weight:700"><td colspan="3">ОБЩО ${actDocs(actCount(ACT_LIST))}${
      actHasMultiples(ACT_LIST) ? ` (${actTitles(ACT_LIST.length)})` : ''}</td>
    <td class="num">${mny(actValue(ACT_LIST))}</td><td></td></tr>
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
  if (id) { closeModal(); renderActs(); toast('Акт № ' + d.no + ': ' + (actCount(ACT_LIST) === 1 ? 'отчислен е ' : 'отчислени са ')
    + actDocs(actCount(ACT_LIST))
    + (actHasMultiples(ACT_LIST) ? ' (' + actTitles(ACT_LIST.length) + ')' : '') + '.', 'ok'); markSaved(); }
}
window.saveAct = saveAct;
/* ---------- проект ---------- */
async function saveActDraft() {
  const d = formData('#actF');
  const p = PRICHINI.find(x => x.k == d.reason_code);
  /* Проектът се записва и непълен — това му е работата. Затова тук НЯМА
     firstMissingRequired: проверките по чл. 30 и чл. 35 се правят при
     утвърждаването, не докато комисията още събира номерата. */
  const draft = Object.assign({}, d, { reason_text: p ? p.t : null });
  delete draft.no;
  const id = await call(window.api.deaccessionActs.saveDraft({
    id: ACT_DRAFT_ID, draft, bookIds: ACT_LIST.map(b => b.id)
  }));
  if (id) {
    ACT_DRAFT_ID = id;
    closeModal(); renderActs(); markSaved();
    toast('Проектът е записан. Нищо не е отчислено — документите остават във фонда.', 'ok');
  }
}
window.saveActDraft = saveActDraft;
async function openDraft(id) {
  const d = await call(window.api.deaccessionActs.getDraft(id));
  if (!d) return toast('Проектът не е намерен.', 'err');
  actForm(d);
}
window.openDraft = openDraft;
async function delDraft(id) {
  if (!await askConfirm('Изтриване на проекта. Нищо не е било отчислено, така че нищо не се връща обратно. Да продължа?',
    { okLabel: 'Изтрий проекта' })) return;
  const ok = await call(window.api.deaccessionActs.deleteDraft(id), 'Проектът е изтрит.');
  if (ok !== null) { renderActs(); markSaved(); }
}
window.delDraft = delDraft;
async function approveActDraft() {
  /* Утвърждаването прави документа — оттук нататък номерът е зает завинаги и
     поправка има само чрез анулиране. Затова се пита изрично, с числата. */
  const d = formData('#actF');
  if (!d.date) return toast('Датата на акта е задължителна при утвърждаване.', 'err');
  if (!d.reason_code) return toast('Причината по чл. 30 е задължителна при утвърждаване.', 'err');
  if (!ACT_LIST.length) return toast('Добавете поне един документ в списъка.', 'err');
  const p = PRICHINI.find(x => x.k == d.reason_code);
  // Първо се записва това, което е на екрана — иначе утвърденото е старата снимка.
  const draft = Object.assign({}, d, { reason_text: p ? p.t : null });
  delete draft.no;
  const draftId = await call(window.api.deaccessionActs.saveDraft({
    id: ACT_DRAFT_ID, draft, bookIds: ACT_LIST.map(b => b.id)
  }));
  if (!draftId) return;
  ACT_DRAFT_ID = draftId;
  if (!await askConfirm('Утвърждаване: ' + actDocs(actCount(ACT_LIST))
    + ' излизат от фонда, актът получава номер и остава в документацията ЗАВИНАГИ (чл. 39). '
    + 'След това поправка има само чрез анулиране, с основание. Да продължа?',
    { okLabel: 'Утвърди акта' })) return;
  const actId = await call(window.api.deaccessionActs.approveDraft({ id: draftId }));
  if (actId) {
    closeModal(); renderActs(); markSaved();
    toast('Актът е утвърден и ' + actDocs(actCount(ACT_LIST)) + ' са отчислени.', 'ok');
  }
}
window.approveActDraft = approveActDraft;
async function openAct(id) {
  const a = await call(window.api.deaccessionActs.get(id));
  if (!a) return;
  modal('Акт за отчисляване № ' + a.no + ' / ' + a.year + (a.revoked_at ? ' — АНУЛИРАН' : ''), `
    ${a.revoked_at ? `<div class="note w"><b>Този акт е анулиран</b> на ${bg(String(a.revoked_at).slice(0, 10))} г.${
      a.revoke_reason ? ' — ' + esc(a.revoke_reason) : ''}${a.revoked_by ? ' (' + esc(a.revoked_by) + ')' : ''}.<br>
      Документите по него са върнати във фонда и не се броят никъде. Самият акт остава в документацията
      по чл. 39, а номер ${a.no}/${a.year} остава зает и не се дава на друг акт.</div>` : ''}
    <div class="note d"><b>Причина (чл. 30, т. ${a.reason_code}):</b> ${esc(a.reason_text)}<br>
    <b>Разпореждане (чл. 36):</b> ${esc(a.disposal || '—')}${a.attach ? ' · ' + esc(a.attach) : ''}</div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор, заглавие</th><th>Год.</th><th>Цена</th></tr></thead><tbody>
    ${a.items.map(l => `<tr><td class="num">${l.inv_number}</td><td>${esc([l.author, l.title].filter(Boolean).join('. '))}</td>
    <td class="num">${esc(l.year || '')}</td><td class="num">${actQtyMark(l)}${mny(l.price)}</td></tr>`).join('')}
    <tr style="background:var(--paper3);font-weight:700"><td colspan="3">ОБЩО ${actCount(a.items)}${
      actHasMultiples(a.items) ? ` (${actTitles(a.items.length)})` : ''}</td>
    <td class="num">${mny(actValue(a.items))}</td></tr>
    </tbody></table></div>
    <div class="hint" style="margin-top:10px">Комисия: ${[a.committee1, a.committee2, a.committee3].filter(Boolean).map(esc).join(' · ') || '—'}</div>`,
    `${a.revoked_at ? '' : `<button class="btn l dgr" onclick="revokeAct(${id})">Анулирай акта</button>`}
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
  const showQty = actHasMultiples(a.items);
  setPrintPage({ name: `Акт за отчисляване № ${a.no}-${a.year}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>АКТ № ${a.no} / ${bg(a.date)}<br><span style="font-size:12pt">за отчисляване на библиотечни документи</span></h2>
    ${/* Разпечатката на анулиран акт НОСИ белега (v2.4.56). Иначе от принтера
         излиза документ, неразличим от действащ — а екземплярът в счетоводството
         вече е зачертан. */''}
    ${a.revoked_at ? `<div class="pmeta" style="text-align:center;border:2px solid #000;padding:3mm;margin-bottom:5mm">
      <b>АНУЛИРАН</b> на ${bg(String(a.revoked_at).slice(0, 10))} г.${a.revoke_reason ? ' — ' + esc(a.revoke_reason) : ''}${
      a.revoked_by ? '<br>Анулирал: ' + esc(a.revoked_by) : ''}<br>
      Документите по този акт са върнати във фонда. Номерът остава зает.</div>` : ''}
    <div class="pmeta">Днес, ${bg(a.date)} г., комисия, назначена със заповед ${a.order_no ? '№ ' + esc(a.order_no) : '№ …………'} на
    ${esc(s.director_role || 'ръководителя')} на ${esc(s.org || '')}, в състав:<br>
    1. ${esc(a.committee1 || '…………………')} &nbsp; 2. ${esc(a.committee2 || '…………………')} &nbsp; 3. ${esc(a.committee3 || '…………………')} (счетоводител)<br><br>
    на основание <b>чл. 30, т. ${a.reason_code}</b> от Наредба № 3 от 18.11.2014 г. — <b>${esc(a.reason_text)}</b> — отчислява от библиотечния фонд
    <b>${count}</b> ${count === 1 ? 'библиотечен документ' : 'библиотечни документа'}${
      actHasMultiples(a.items) ? ` (${actTitles(a.items.length)})` : ''} на обща стойност <b>${mny(total)}</b></div>
    ${/* Колоната „Бр." излиза САМО когато актът наистина носи ред с бройка,
          различна от един документ. Един инвентарен номер отговаря на един
          екземпляр, тоест при редовни данни колоната е константа 1 и е излишна —
          но акт, съставен върху неразделен стар запис (виж „Настройки“ →
          „Проверка на данните“), трябва да я има: редът ОБЩО е Σ(цена × бройка),
          а редовете печатат единична цена, и без колоната документът се сумира
          на едно число, а твърди друго. */''}
    <table><thead><tr><th>№</th><th>Инв. №</th><th>Автор, заглавие, том</th><th>Година</th><th>УДК</th>${
      showQty ? '<th>Бр.</th>' : ''}<th>Стойност, €</th></tr></thead><tbody>
    ${a.items.map((l, n) => `<tr><td>${n + 1}</td><td>${l.inv_number}</td>
    <td>${esc([l.author, l.title].filter(Boolean).join('. '))}${l.volume ? ', т. ' + esc(l.volume) : ''}</td>
    <td>${esc(l.year || '')}</td><td>${esc(l.udk || '')}</td>${
      showQty ? `<td>${actQty(l)}</td>` : ''}<td>${actQtyMark(l)}${mny(l.price)}</td></tr>`).join('')}
    <tr><td colspan="5"><b>ОБЩО${showQty ? '' : ' ' + actDocs(count)}</b></td>${
      showQty ? `<td><b>${count}</b></td>` : ''}<td><b>${mny(total)}</b></td></tr></tbody></table>
    <div class="pmeta">Начин на разпореждане по чл. 36: <b>${esc(a.disposal || '…………………')}</b>${a.attach ? '<br>Приложен документ: ' + esc(a.attach) : ''}<br>
    Актът е съставен в два екземпляра — по един за счетоводството и за библиотеката.</div>
    ${ssig(['Комисия: 1. ………… 2. ………… 3. …………', 'УТВЪРДИЛ, ' + esc(s.director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printActDoc = printActDoc;
/* Анулирането вече иска ОСНОВАНИЕ и го казва ясно (v2.4.56): актът не изчезва.
   Дотук диалогът беше едно „Да продължа?“, а зад него стоеше DELETE — оттам и
   впечатлението, че анулирането „маха“ акта. Сега се пита с формуляр, защото
   основанието влиза в КДБФ Приложение № 3 до самия ред и се чете от проверяващ. */
function revokeAct(id) {
  modal('Анулиране на акт за отчисляване', `
    <div class="note w"><b>Актът не се изтрива.</b> Той е документ по чл. 39: редът остава в регистъра,
    номерът му остава зает завинаги и повече не се дава на друг акт, а в КДБФ Приложение № 3 излиза
    зачертан, с основанието по-долу. Документите се връщат във фонда.</div>
    <form id="revF" onsubmit="return false">
      ${fld('Основание за анулиране', 'reason', { req: 1,
        hint: 'например: сгрешен инвентарен номер; актът е съставен повторно; комисията не го утвърди' })}
      ${fld('Анулирал (име и длъжност)', 'by', {})}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn dgr" onclick="revokeActGo(${id})">Анулирай акта</button>`);
}
window.revokeAct = revokeAct;
async function revokeActGo(id) {
  const d = formData('#revF');
  if (!d.reason || !String(d.reason).trim()) return toast('Основанието за анулиране е задължително.', 'err');
  const res = await window.api.deaccessionActs.revoke(id, { reason: d.reason, by: d.by });
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderActs(); markSaved();
  /* Резервациите, отказани при съставянето на акта, НЕ се възстановяват при
     анулиране (виж дългата бележка в handlers/deaccession-acts.js). Дотук това
     ставаше МЪЛЧАЛИВО: книгата се връщаше „наличен“, а читателят, който я е
     чакал, просто го нямаше никъде — библиотекарката научаваше чак ако той дойде
     да пита. Сега се казва на глас, при това като предупреждение, а не като
     съобщение за успех. */
  const n = (res.data && res.data.droppedHolds) || 0;
  toast(n
    ? 'Актът е анулиран. Внимание: ' + (n === 1
        ? '1 резервация, отказана с този акт, остава отказана — подновете я, ако читателят още чака.'
        : n + ' резервации, отказани с този акт, остават отказани — подновете ги, ако читателите още чакат.')
    : 'Актът е анулиран. Номерът остава зает, а актът остава в документацията.', n ? 'warn' : 'ok');
}
window.revokeActGo = revokeActGo;
