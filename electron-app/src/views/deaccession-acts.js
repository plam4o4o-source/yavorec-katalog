/* ---------------- Отчисляване ---------------- */
/* Коя година показва списъкът с актове (v2.4.61). „всички“ е нарочно
   подразбиращото се: за разлика от КДБФ, която ВИНАГИ е за една година, тук
   екранът е регистър на актовете и библиотекарката най-често търси „последния
   акт“, без да мисли за година. Филтърът е за другия случай — проверка, при
   която се иска точно една година (чл. 35: номерацията е годишна, тоест „акт
   № 4“ без година не значи нищо). */
let ACTS_YEAR = 'всички';
window.setActsYear = (y) => { ACTS_YEAR = y; renderActs(); };
async function renderActs() {
  const all = await call(window.api.deaccessionActs.list());
  if (!all) return;
  const years = [...new Set(all.map(a => String(a.year)))].sort().reverse();
  if (ACTS_YEAR !== 'всички' && !years.includes(ACTS_YEAR)) ACTS_YEAR = 'всички';
  const rows = ACTS_YEAR === 'всички' ? all : all.filter(a => String(a.year) === ACTS_YEAR);
  /* Сборът брои САМО живите актове — точно както КДБФ Приложение № 2 и по
     същата причина: анулираният акт остава в регистъра (чл. 39), но не е
     отчислил нищо и не бива да влиза в никакъв сбор. */
  const live = rows.filter(a => !a.revoked_at);
  const sumCount = live.reduce((s, a) => s + (Number(a.item_count) || 0), 0);
  const sumValue = live.reduce((s, a) => s + (Number(a.item_value) || 0), 0);
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
      ${years.length ? `<label style="margin-left:auto">Година:
        <select onchange="setActsYear(this.value)">
          <option value="всички"${ACTS_YEAR === 'всички' ? ' selected' : ''}>всички</option>
          ${years.map(y => `<option value="${y}"${ACTS_YEAR === y ? ' selected' : ''}>${y}</option>`).join('')}
        </select></label>` : ''}
    </div>
    ${drafts.length ? `<h3 style="margin:14px 0 6px">Проекти (още не са актове)</h3>
    <div class="wrap"><table class="ledger"><thead><tr><th>Проект №</th><th>Дата</th><th>Причина</th>
      <th>Заглавия</th><th>Поправен</th><th></th></tr></thead><tbody>
    ${drafts.map(d => `<tr><td class="num">${d.id}</td><td class="num">${bg(d.date) || '—'}</td>
      <td>${d.reason_code ? 'т. ' + d.reason_code + '. ' : ''}${esc(d.reason_text || '— без причина —')}</td>
      <td class="num">${d.title_count}</td><td class="num" style="font-size:12px">${esc(d.updated_at ? tsDay(d.updated_at) + ' ' + tsTime(d.updated_at) : '')}</td>
      <td><button class="btn sm" onclick="openDraft(${d.id})">Отвори</button>
          <button class="btn sm dgr" onclick="delDraft(${d.id})">Изтрий</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${drafts.length ? '<h3 style="margin:18px 0 6px">Съставени актове</h3>' : ''}
    <div class="wrap"><table class="ledger"><thead><tr><th>Акт №</th><th>Дата</th><th>Причина</th>
      <th>Брой</th><th>Стойност</th><th>Начин</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(a => `<tr${a.revoked_at ? ' class="revokedRow"' : ''}><td class="num">${a.no} / ${a.year}</td>
      <td class="num">${bg(a.date)}</td>
      <td>т. ${a.reason_code}. ${esc(a.reason_text)}${a.revoked_at
        ? `<br><span class="badge warn">АНУЛИРАН</span> ${esc(tsDay(a.revoked_at))}${
            a.revoke_reason ? ' — ' + esc(a.revoke_reason) : ''}` : ''}</td>
      <td class="num">${a.revoked_at ? '—' : a.item_count}</td>
      <td class="num">${a.revoked_at ? '—' : mny(a.item_value)}</td><td style="font-size:12px">${esc(a.disposal || '')}</td>
      <td><button class="btn sm" onclick="openAct(${a.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="7" class="empty">Няма съставени актове${ACTS_YEAR === 'всички' ? '' : ' за ' + ACTS_YEAR + ' г.'}.</td></tr>`}
    ${/* Сборът стои ПОД таблицата по същия образец като КДБФ Приложение № 3 и
          брои същото, което брои и тя: живите актове на показаната година.
          Дотук екранът изреждаше актовете, но не сумираше нищо — за въпроса
          „колко документа излязоха от фонда тази година“ трябваше да се отваря
          друг раздел, а двете числа задължително трябва да съвпадат. */''}
    ${rows.length ? `<tr style="background:var(--paper3);font-weight:700">
      <td colspan="3">ОБЩО${ACTS_YEAR === 'всички' ? ' (всички години)' : ' за ' + ACTS_YEAR + ' г.'}
        — ${live.length}${live.length === 1 ? ' действащ акт' : ' действащи акта'}${
          rows.length - live.length ? ' (и ' + (rows.length - live.length) + ' анулирани, които не се броят)' : ''}</td>
      <td class="num">${sumCount}</td><td class="num">${mny(sumValue)}</td><td colspan="2"></td></tr>` : ''}
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
      ${/* БЕЛЕЖКАТА НА ПРОЕКТА СЕ ВИЖДА (v2.4.61).
            Проектът, направен от протокол за инвентаризация, носи препратката
            „Съставен от протокол за инвентаризация № 3 от … г.“ — единствената
            връзка между акта по чл. 30, т. 6 и протокола по чл. 40. Дотук тя не
            се показваше НИКЪДЕ и се триеше при първия запис от тази форма (виж
            saveDraft в handlers/deaccession-acts.js). Полето е само за четене:
            то не е писано от библиотекаря тук, а е дошло с проекта, и се пренася
            в утвърдения акт, където се и печата. */''}
      ${v.note ? `<div class="note d"><b>Бележка към проекта:</b> ${esc(v.note)}
        <div class="hint">Пренася се в утвърдения акт и се печата в него — така актът и протоколът
        по чл. 40 се четат един през друг при проверка.</div></div>` : ''}
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
    /* НОМЕРЪТ СЛЕДВА ГОДИНАТА НА ДАТАТА, А НЕ ДНЕШНАТА (v2.4.61).
       =================================================================
       Дотук номерът се вземаше веднъж, при отваряне на формата, и то за
       ТЕКУЩАТА година (nextNo(yr())), докато обработчикът записва акта в
       годината на ДАТАТА му. Библиотекарка, която съставя акт за декември на
       миналата година (най-обикновен случай — комисията заседава през
       януари), получаваше № 4 и той влизаше като № 4/минала година в година,
       в която няма нито един акт: поредицата ѝ започва от 4, а № 1 – 3 ги
       няма и никога няма да ги има, защото по чл. 39 актове не се трият.
       Чл. 35 е изричен: номерацията започва от 1 всяка календарна година.
       Затова смяната на датата преизчислява номера. Ако библиотекарката е
       въвела номер НА РЪКА (например продължава номерация от хартиен
       регистър), той не се пипа — само се казва кой е следващият свободен. */
    const dt = $('#actF [name=date]'), noEl = $('#actF [name=no]');
    if (dt && noEl) {
      let offered = String(noEl.value || '');
      dt.addEventListener('change', async () => {
        const y = String(dt.value || '').slice(0, 4);
        if (!/^\d{4}$/.test(y)) return;
        const next = await call(window.api.deaccessionActs.nextNo(y));
        if (next == null) return;
        if (String(noEl.value || '') !== offered) {
          if (String(noEl.value || '') !== String(next)) {
            toast('Актът е с дата от ' + y + ' г., а там следващият свободен номер е № ' + next
              + '. Оставям въведения от вас № ' + noEl.value + ' — чл. 35 иска номерата да текат от 1 всяка година.', 'warn');
          }
          return;
        }
        if (String(next) === offered) return;
        noEl.value = String(next);
        offered = String(next);
        toast('Датата е от ' + y + ' г. — номерът на акта е преизчислен на № ' + next + ' за ' + y
          + ' г. (чл. 35: номерацията започва от 1 всяка календарна година).', 'warn');
      });
    }
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
  /* Заетият документ се казва още при сканирането, а от v2.4.61 се казва и
     КАКВО СЛЕДВА: обработчикът приема зает документ само по чл. 30, т. 5
     („повредени или невърнати от ползватели“) и отказва акта по всяка друга
     причина — документът е в дома на читателя и комисията не го е виждала.
     По-добре това да се научи сега, при сканирането, отколкото след като
     списъкът е готов и утвърждаването се откаже. */
  if (b.available < b.quantity) {
    // Първото известие е дословно същото, както досега — второто казва какво следва.
    toast('Внимание: инв. № ' + b.inv_number + ' в момента е зает от читател.', 'err');
    const rc = ($('#actF [name=reason_code]') || {}).value;
    if (String(rc) !== '5') {
      toast('Зает документ се отчислява само по чл. 30, т. 5 (повредени или невърнати от ползватели): '
        + 'приберете инв. № ' + b.inv_number + ' и тогава съставете акта, или изберете т. 5, ако читателят '
        + 'няма да го върне. С друга причина утвърждаването ще бъде отказано.', 'warn');
    }
  }
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
  /* Стар запис с няколко екземпляра под един номер се разделя, преди да влезе в
     акта — виж actSplitLegacy по-долу. Отказът оставя списъка непроменен. */
  if (!await actSplitLegacy(b)) return;
  ACT_LIST.push(b);
  drawActList();
}
window.actAdd = actAdd;
/* ЕДИН ИНВЕНТАРЕН НОМЕР — ЕДИН ОТЧИСЛЕН ЕКЗЕМПЛЯР (v2.4.62).
   =====================================================================
   Дотук стар запис от внесена база, в който три екземпляра стоят под един
   инвентарен номер, влизаше в акта с бройка 3: библиотеката вадеше една
   скъсана книга, а от фонда излизаха и трите. Двете здрави оставаха на рафта,
   но програмата, КДБФ и инвентарната книга вече не ги броят — и това изплува
   чак при следващата инвентаризация, като „излишни“ документи без запис.

   Инвентарната книга вписва всеки документ със СВОЙ номер (чл. 16), а актът
   по чл. 35 описва отчислените документи поотделно, по номер. Затова сега
   такъв запис първо се РАЗДЕЛЯ — същото действие като „Раздели на отделни
   записи“ в „Проверка на данните“ (books:splitCopies), което не променя нито
   бройката, нито стойността на фонда. Сканираният номер остава за екземпляра,
   който комисията държи в ръка и който се отчислява; останалите получават
   следващите свободни номера и остават във фонда. Пита се изрично, защото
   библиотекарката трябва да надпише тези екземпляри с новите им номера.
   Ядрото на акта (createActCore) така или иначе отказва неразделен запис —
   тук само се прави вярното действие на мястото, където е нужно. */
function actLegacyCopies(l) {
  if (!l) return 0;
  const raw = (l.fund_qty !== undefined && l.fund_qty !== null) ? l.fund_qty : l.quantity;
  return Number(raw) || 0;
}
async function actSplitLegacy(b) {
  const n = actLegacyCopies(b);
  if (n <= 1) return true;
  const ok = await askConfirm('Под инв. № ' + b.inv_number + ' („' + (b.title || '') + '“) са вписани ' + n
    + ' екземпляра под един номер — стар запис отпреди правилото „един инвентарен номер = един екземпляр“. '
    + 'Актът отчислява само екземпляра с този номер, не всички наведнъж. '
    + 'Програмата ще раздели записа: инв. № ' + b.inv_number + ' остава за екземпляра, който отчислявате, '
    + 'а другите ' + (n - 1) + ' получават нови инвентарни номера и остават във фонда. '
    + 'Бройката и стойността на фонда не се променят. Да разделя ли записа?',
    { okLabel: 'Раздели и отчисли само този' });
  if (!ok) { toast('Инв. № ' + b.inv_number + ' не е добавен в акта.', 'warn'); return false; }
  const r = await call(window.api.books.splitCopies(b.id));
  if (!r) return false;
  toast('Записът е разделен. В акта влиза само инв. № ' + b.inv_number + '. '
    + (r.created.length === 1 ? 'Другият екземпляр получи инв. № ' : 'Другите екземпляри получиха инв. № ')
    + r.created.join(', ') + ' и остава' + (r.created.length === 1 ? '' : 'т') + ' във фонда — надпишете '
    + (r.created.length === 1 ? 'го' : 'ги') + ' с новите номера. Ако и '
    + (r.created.length === 1 ? 'той се отчислява, сканирайте го' : 'те се отчисляват, сканирайте ги')
    + ' в акта.', 'ok');
  b.fund_qty = 1; b.quantity = 1;
  return true;
}
/* Същото за ред, дошъл от проект, записан преди v2.4.62 — там записът може още
   да е неразделен. Редът остава в списъка, но вече за един екземпляр. */
async function actSplitLine(n) {
  const l = ACT_LIST[n]; if (!l) return;
  if (await actSplitLegacy(l)) drawActList();
}
window.actSplitLine = actSplitLine;
/* Първият неразделен ред в списъка — за да каже екранът точно кой е, преди
   ядрото да откаже целия акт с общо съобщение. */
function actFirstLegacy() { return ACT_LIST.find(l => actLegacyCopies(l) > 1); }
function actLegacyBlock() {
  const l = actFirstLegacy();
  if (!l) return false;
  toast('Под инв. № ' + l.inv_number + ' са вписани ' + actLegacyCopies(l) + ' екземпляра под един номер. '
    + 'Натиснете „Раздели“ на реда — актът отчислява само екземпляра с този номер.', 'err');
  return true;
}
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
    <td>${esc([l.author, l.title].filter(Boolean).join('. '))}${actLegacyCopies(l) > 1
      ? `<br><span class="badge warn">${actLegacyCopies(l)} екземпляра под един номер</span>
         <button type="button" class="btn sm" onclick="actSplitLine(${n})">Раздели — отчисли само този</button>` : ''}${l.lost
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
/* КОЙ Е ЧАКАЛ ТАЗИ КНИГА — КАЗВА СЕ ВЕДНАГА СЛЕД АКТА (v2.4.57).
   =====================================================================
   Дотук съставянето на акт завършваше с едно изречение: „отчислени са N
   документа“. Отказаните резервации падаха мълчаливо — holds:list показва само
   активните, тоест отказаната изчезва от екрана „Резервации“ в същата секунда,
   а броят ѝ отиваше единствено в дневника. Нелепото беше, че при АНУЛИРАНЕ на
   акт програмата изрично предупреждава „N резервации остават отказани —
   подновете ги“, тоест грижата съществува по пътя, в който резервациите НЕ
   падат, и липсва по пътя, в който падат наистина.

   За читалището в село това е единственото място, на което може да се хване
   човекът, тръгнал след две седмици за книга, която вече не съществува.
   Затова: списък с име, номер на карта и телефон, наречен с това, което трябва
   да се направи — „обадете се на…“. Същото се отнася и за витрините: акт, който
   е извадил документ от тематичен списък на сайта, го казва, за да може
   библиотекарката да сложи друга книга на негово място.

   Чете се през deaccessionActs:get, а не от отговора на самото съставяне: така
   сведението е трайно и се вижда пак при всяко отваряне на акта, а не само в
   съобщение, което може да е било пропуснато. */
function actHoldLine(h) {
  return `<li><b>${esc(h.reader_name || 'читател')}</b>${h.card_no ? ' · карта № ' + esc(h.card_no) : ''}${
    h.phone ? ' · тел. ' + esc(h.phone) : ' · <span class="hint">без телефон в картона</span>'}
    <div class="hint">чакал${h.status_before === 'заделена' ? 'а (книгата е била ЗАДЕЛЕНА за него)' : 'а'} —
    инв. № ${esc(String(h.inv_number ?? '—'))} · ${esc([h.author, h.title].filter(Boolean).join('. '))}</div></li>`;
}
/* Заемането, закрито от акта по чл. 30, т. 5 — с числата (v2.4.61). На читателя
   се начислява обезщетение за документ, който няма да се върне; това не бива да
   се случва мълчаливо, защото после той идва на гишето и пита откъде е сумата. */
function actLoanLine(l) {
  return `<li><b>${esc(l.reader_name || 'читател')}</b>${l.card_no ? ' · карта № ' + esc(l.card_no) : ''}${
    l.phone ? ' · тел. ' + esc(l.phone) : ''}
    <div class="hint">инв. № ${esc(String(l.inv_number ?? '—'))} · ${esc([l.author, l.title].filter(Boolean).join('. '))}
    — заемането е закрито като НЕвърнато${l.deaccession_fine ? ', забава ' + mny(l.deaccession_fine) : ''}${
      l.lost_amount ? ', начислено обезщетение ' + mny(l.lost_amount) : ''}</div></li>`;
}
async function actAftermath(actId, okMessage) {
  const a = await call(window.api.deaccessionActs.get(actId));
  const holds = (a && a.holds) || [];
  const loans = (a && a.loans) || [];
  const shelved = ((a && a.items) || []).filter(i => i.shelves_before);
  /* Известието за успех се показва ВИНАГИ (v2.4.61), а прозорецът се отваря
     САМО когато има какво да се направи след акта. Дотук двете се изключваха
     взаимно и когато имаше отказана резервация, потвърждението „отчислени са N
     документа“ просто не се появяваше — тоест най-важното съобщение изчезваше
     точно в най-сложния случай, а прозорецът се затваря и не оставя нищо. */
  toast(okMessage, 'ok');
  if (!holds.length && !shelved.length && !loans.length) return;
  modal('Актът е съставен — остава да се уведомят читателите', `
    <div class="note">${esc(okMessage)}</div>
    ${loans.length ? `<div class="note w"><b>${loans.length === 1 ? 'Закрито е 1 заемане' : 'Закрити са ' + loans.length + ' заемания'}
      на невърнат документ (чл. 30, т. 5).</b> Документът е у читателя и заемането е приключено като
      НЕвърнато, не като върнато: натрупаната забава остава по него, а стойността на документа е
      начислена в читателската сметка. Ако комисията е решила друг размер (или замяна с друг документ),
      поправете начислението от картона на читателя.
      <ul style="margin:8px 0 0 18px">${loans.map(actLoanLine).join('')}</ul></div>` : ''}
    ${holds.length ? `<div class="note w"><b>Обадете се на ${holds.length === 1 ? 'този читател' : 'тези читатели'}</b> —
      ${holds.length === 1 ? 'той е чакал' : 'те са чакали'} отчислен документ. Резервацията е отказана автоматично
      и НЕ се подновява: книгата вече не е част от фонда.</div>
      <ul style="margin:8px 0 0 18px">${holds.map(actHoldLine).join('')}</ul>` : ''}
    ${shelved.length ? `<div class="note" style="margin-top:12px"><b>Извадени от витрини в онлайн каталога:</b>
      <ul style="margin:6px 0 0 18px">${shelved.map(i => `<li>инв. № ${esc(String(i.inv_number ?? '—'))} —
        ${esc(i.shelves_before)}</li>`).join('')}</ul>
      Витрината на сайта вече не ги показва. Ако тематичният списък трябва да остане пълен, сложете друг документ
      на тяхно място от „Онлайн каталог“ → „Витрини в каталога“.</div>` : ''}`,
    `<button class="btn pri" onclick="closeModal()">Разбрах</button>`);
}
async function saveAct() {
  const missing = firstMissingRequired('#actF');
  if (missing) return toast(missing + ' е задължително поле.', 'err');
  const d = formData('#actF');
  if (!ACT_LIST.length) return toast('Добавете поне един документ в списъка.', 'err');
  const p = PRICHINI.find(x => x.k == d.reason_code);
  /* Номер, който оставя дупка в годината — пита се изрично (v2.4.61). Номерът се
     заема ЗАВИНАГИ (чл. 39 — актове не се трият), тоест пропуснатият номер
     остава необясним завинаги. Това не е забрана: библиотека, продължила
     номерацията си от хартиен регистър, има право на своя начален номер —
     затова се пита, а не се отказва. Обработчикът от своя страна вписва
     пропуска в дневника, защото през него минават и другите пътища. */
  const y = String(d.date || '').slice(0, 4);
  if (/^\d{4}$/.test(y)) {
    const next = await call(window.api.deaccessionActs.nextNo(y));
    if (next != null && Number(d.no) > Number(next)) {
      const skipped = Number(d.no) - Number(next) === 1 ? '№ ' + next : '№ ' + next + ' – ' + (Number(d.no) - 1);
      if (!await askConfirm('Акт № ' + d.no + ' за ' + y + ' г. оставя незает ' + skipped
        + '. Чл. 35 иска номерата да текат последователно от 1 всяка календарна година, а зает номер '
        + 'не се освобождава (чл. 39). Да съставя ли акта с този номер?', { okLabel: 'Да, с този номер' })) return;
    }
  }
  const act = Object.assign({}, d, { reason_text: p ? p.t : '' });
  if (actLegacyBlock()) return;
  const id = await call(window.api.deaccessionActs.create({ act, bookIds: ACT_LIST.map(b => b.id) }));
  if (id) {
    closeModal(); renderActs(); markSaved();
    // Съобщението за успех се показва САМО ако няма какво да се съобщи освен него
    // (виж actAftermath по-горе) — иначе се отваря списъкът „обадете се на…“.
    await actAftermath(id, 'Акт № ' + d.no + ': ' + (actCount(ACT_LIST) === 1 ? 'отчислен е ' : 'отчислени са ')
      + actDocs(actCount(ACT_LIST))
      + (actHasMultiples(ACT_LIST) ? ' (' + actTitles(ACT_LIST.length) + ')' : '') + '.');
  }
}
window.saveAct = saveAct;
/* ---------- проект ---------- */
async function saveActDraft() {
  const d = formData('#actF');
  const p = PRICHINI.find(x => x.k == d.reason_code);
  /* Проектът се записва и непълен — това му е работата. Затова тук НЯМА
     firstMissingRequired: проверките по чл. 30 и чл. 35 се правят при
     утвърждаването, не докато комисията още събира номерата. */
  const draft = /** @type {any} */ (Object.assign({}, d, { reason_text: p ? p.t : null }));
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
  if (actLegacyBlock()) return;
  const p = PRICHINI.find(x => x.k == d.reason_code);
  // Първо се записва това, което е на екрана — иначе утвърденото е старата снимка.
  const draft = /** @type {any} */ (Object.assign({}, d, { reason_text: p ? p.t : null }));
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
    // Същият път като при прекия акт — утвърждаването на проект отчислява по
    // абсолютно същия начин и затова трябва да казва абсолютно същото.
    await actAftermath(actId, 'Актът е утвърден и ' + actDocs(actCount(ACT_LIST)) + ' са отчислени.');
  }
}
window.approveActDraft = approveActDraft;
async function openAct(id) {
  const a = await call(window.api.deaccessionActs.get(id));
  if (!a) return;
  modal('Акт за отчисляване № ' + a.no + ' / ' + a.year + (a.revoked_at ? ' — АНУЛИРАН' : ''), `
    ${a.revoked_at ? `<div class="note w"><b>Този акт е анулиран</b> на ${bg(tsDay(a.revoked_at))} г.${
      a.revoke_reason ? ' — ' + esc(a.revoke_reason) : ''}${a.revoked_by ? ' (' + esc(a.revoked_by) + ')' : ''}.<br>
      Документите по него са върнати във фонда и не се броят никъде. Самият акт остава в документацията
      по чл. 39, а номер ${a.no}/${a.year} остава зает и не се дава на друг акт.</div>` : ''}
    <div class="note d"><b>Причина (чл. 30, т. ${a.reason_code}):</b> ${esc(a.reason_text)}<br>
    <b>Разпореждане (чл. 36):</b> ${esc(a.disposal || '—')}${a.attach ? ' · ' + esc(a.attach) : ''}
    ${/* Препратката към протокола (чл. 40) и подписът на СЪСТАВЯНЕТО (v2.4.61) —
          дотук прегледът казваше кой е анулирал акта, но не и кой го е съставил,
          нито от кой документ е дошъл. */''}
    ${a.note ? '<br><b>Бележка:</b> ' + esc(a.note) : ''}
    ${/* Датата се изписва по български (bg()), а не както е записана в базата:
          ISO низ върху лист, който се подписва, се чете като компютърна следа. */''}
    ${(a.created_at || a.created_by)
      ? `<br><span class="hint">Съставен${a.created_at ? ' на ' + bg(tsDay(a.created_at)) + ' г.'
          + ' в ' + esc(tsTime(a.created_at)) + ' ч.' : ''}${
          a.created_by ? ' от ' + esc(a.created_by) : ''}</span>` : ''}</div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор, заглавие</th><th>Год.</th><th>Цена</th></tr></thead><tbody>
    ${a.items.map(l => `<tr><td class="num">${l.inv_number}</td><td>${esc([l.author, l.title].filter(Boolean).join('. '))}</td>
    <td class="num">${esc(l.year || '')}</td><td class="num">${actQtyMark(l)}${mny(l.price)}</td></tr>`).join('')}
    <tr style="background:var(--paper3);font-weight:700"><td colspan="3">ОБЩО ${actCount(a.items)}${
      actHasMultiples(a.items) ? ` (${actTitles(a.items.length)})` : ''}</td>
    <td class="num">${mny(actValue(a.items))}</td></tr>
    </tbody></table></div>
    ${/* Читателите и витрините стоят и в прегледа на акта, не само в съобщението
          веднага след съставянето (виж actAftermath): актът се отваря и след
          седмица — например когато читателят дойде да пита за книгата си — и
          тогава отговорът трябва да е тук, а не в дневника. */''}
    ${(a.loans && a.loans.length) ? `<div class="note w" style="margin-top:10px">
      <b>Закрити заемания на невърнати документи (${a.loans.length}):</b>
      <ul style="margin:6px 0 0 18px">${a.loans.map(l => actLoanLine(l)
        + (l.charge ? `<div class="hint" style="margin-left:18px">начислено ${mny(l.charge.charged || 0)},
            събрано ${mny(l.charge.covered || 0)}${(l.charge.outstanding || 0) > 0
              ? ' — остава да се събере ' + mny(l.charge.outstanding) : ''}</div>` : '')).join('')}</ul>
      ${/* При анулиране заемането се отваря обратно и губи връзката с акта, тоест
            този списък се изпразва сам — следата остава в дневника. */''}</div>` : ''}
    ${(a.holds && a.holds.length) ? `<div class="note w" style="margin-top:10px">
      <b>Отказани резервации при съставянето на акта (${a.holds.length}):</b>
      <ul style="margin:6px 0 0 18px">${a.holds.map(actHoldLine).join('')}</ul></div>` : ''}
    ${(a.items || []).some(i => i.shelves_before) ? `<div class="note" style="margin-top:10px">
      <b>Извадени от витрини в онлайн каталога:</b>
      <ul style="margin:6px 0 0 18px">${a.items.filter(i => i.shelves_before).map(i =>
        `<li>инв. № ${esc(String(i.inv_number ?? '—'))} — ${esc(i.shelves_before)}</li>`).join('')}</ul>
      ${a.revoked_at ? 'Анулирането на акта НЕ ги връща по витрините — това се прави ръчно.' : ''}</div>` : ''}
    <div class="hint" style="margin-top:10px">Комисия: ${[a.committee1, a.committee2, a.committee3].filter(Boolean).map(esc).join(' · ') || '—'}</div>`,
    `${a.revoked_at ? '' : `<button class="btn l dgr" onclick="revokeAct(${id}, '${esc(String(a.year))}')">Анулирай акта</button>`}
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
      <b>АНУЛИРАН</b> на ${bg(tsDay(a.revoked_at))} г.${a.revoke_reason ? ' — ' + esc(a.revoke_reason) : ''}${
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
      showQty ? '<th>Бр.</th>' : ''}<th>Стойност, € / лв.</th></tr></thead><tbody>
    ${a.items.map((l, n) => `<tr><td>${n + 1}</td><td>${l.inv_number}</td>
    <td>${esc([l.author, l.title].filter(Boolean).join('. '))}${l.volume ? ', т. ' + esc(l.volume) : ''}</td>
    <td>${esc(l.year || '')}</td><td>${esc(l.udk || '')}</td>${
      showQty ? `<td>${actQty(l)}</td>` : ''}<td>${actQtyMark(l)}${mny(l.price)}</td></tr>`).join('')}
    <tr><td colspan="5"><b>ОБЩО${showQty ? '' : ' ' + actDocs(count)}</b></td>${
      showQty ? `<td><b>${count}</b></td>` : ''}<td><b>${mny(total)}</b></td></tr></tbody></table>
    <div class="pmeta">Начин на разпореждане по чл. 36: <b>${esc(a.disposal || '…………………')}</b>${a.attach ? '<br>Приложен документ: ' + esc(a.attach) : ''}<br>
    ${/* ПРЕПРАТКАТА КЪМ ПРОТОКОЛА СЕ ПЕЧАТА В САМИЯ АКТ (v2.4.61).
          Актът по чл. 30, т. 6 се ражда от протокол за инвентаризация по чл. 40.
          Дотук двата документа излизаха от принтера напълно несвързани и
          проверяващият нямаше по какво да мине от единия към другия — а точно
          това е първият въпрос при липси: „по кой протокол са установени“.
          Печата се в акта, а не само на екрана: от библиотеката излиза хартията. */''}
    ${a.note ? 'Основание/препратка: ' + esc(a.note) + '<br>' : ''}
    Актът е съставен в два екземпляра — по един за счетоводството и за библиотеката.${
      (a.created_by || a.created_at)
        ? '<br>Съставил: ' + esc(a.created_by || '…………………')
          + (a.created_at ? ' · ' + bg(tsDay(a.created_at)) + ' г.' : '') : ''}</div>
    ${ssig(['Комисия: 1. ………… 2. ………… 3. …………', 'УТВЪРДИЛ, ' + esc(s.director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printActDoc = printActDoc;
/* Анулирането вече иска ОСНОВАНИЕ и го казва ясно (v2.4.56): актът не изчезва.
   Дотук диалогът беше едно „Да продължа?“, а зад него стоеше DELETE — оттам и
   впечатлението, че анулирането „маха“ акта. Сега се пита с формуляр, защото
   основанието влиза в КДБФ Приложение № 3 до самия ред и се чете от проверяващ. */
function revokeAct(id, actYear) {
  /* АКТ ОТ ПРИКЛЮЧЕНА ГОДИНА — ВТОРО, ИЗРИЧНО ПОТВЪРЖДЕНИЕ (v2.4.61).
     Анулирането на акт от минала година преизчислява КДБФ (Приложение № 2 и
     № 3) за нея — а тя вече е отпечатана, подписана и предадена, и по чл. 39 се
     съхранява. При следващ печат от програмата ще излезе друг документ. Затова
     за миналите години се иска отделна отметка: не за да се забрани поправката
     (сгрешен акт трябва да може да се поправи и след години), а за да не се
     случи между другото, докато се поправя нещо съвсем друго. */
  const closedYear = actYear && String(actYear) < yr();
  modal('Анулиране на акт за отчисляване', `
    <div class="note w"><b>Актът не се изтрива.</b> Той е документ по чл. 39: редът остава в регистъра,
    номерът му остава зает завинаги и повече не се дава на друг акт, а в КДБФ Приложение № 3 излиза
    зачертан, с основанието по-долу. Документите се връщат във фонда.</div>
    ${closedYear ? `<div class="note w"><b>Този акт е от приключената ${esc(String(actYear))} г.</b>
      Анулирането му променя КДБФ за ${esc(String(actYear))} г. със задна дата: отчислените през годината
      намаляват, а наличността към 31.12.${esc(String(actYear))} г. се увеличава. Отпечатаният и подписан
      екземпляр вече няма да отговаря на програмата — преиздайте го и опишете защо.</div>` : ''}
    <form id="revF" onsubmit="return false">
      ${fld('Основание за анулиране', 'reason', { req: 1,
        hint: 'например: сгрешен инвентарен номер; актът е съставен повторно; комисията не го утвърди' })}
      ${fld('Анулирал (име и длъжност)', 'by', {})}
      ${closedYear ? fld('Потвърждавам, че КДБФ за ' + actYear + ' г. ще бъде преизчислена и преиздадена',
        'confirmClosedYear', { type: 'checkbox' }) : ''}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn dgr" onclick="revokeActGo(${id})">Анулирай акта</button>`);
}
window.revokeAct = revokeAct;
async function revokeActGo(id) {
  const d = formData('#revF');
  if (!d.reason || !String(d.reason).trim()) return toast('Основанието за анулиране е задължително.', 'err');
  /* Отметката съществува само при акт от приключена година (виж revokeAct).
     Обработчикът пак проверява — екранът е само един от пътищата към канала. */
  const res = await window.api.deaccessionActs.revoke(id, {
    reason: d.reason, by: d.by, confirmClosedYear: !!d.confirmClosedYear
  });
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderActs(); markSaved();
  /* Резервациите, отказани при съставянето на акта, НЕ се възстановяват при
     анулиране (виж дългата бележка в handlers/deaccession-acts.js). Дотук това
     ставаше МЪЛЧАЛИВО: книгата се връщаше „наличен“, а читателят, който я е
     чакал, просто го нямаше никъде — библиотекарката научаваше чак ако той дойде
     да пита. Сега се казва на глас, при това като предупреждение, а не като
     съобщение за успех. */
  const n = (res.data && res.data.droppedHolds) || 0;
  /* Същото важи и за витрините (v2.4.57): съставянето на акта изважда документа
     от тематичните списъци на сайта, а анулирането не го връща — витрината е
     подбор, правен от човек. Щом не се връща само, трябва да се каже, иначе
     документът се прибира във фонда и мълчаливо изпада от сайта завинаги. */
  const sh = (res.data && res.data.shelvesToRestore) || [];
  /* ПАРИТЕ, КОИТО ОСТАВАТ В СМЕТКАТА НА ЧИТАТЕЛЯ (v2.4.65).
     =================================================================
     ЗАВАРЕНОТО. Актът по чл. 30, т. 5 начислява на читателя две неща —
     обезщетението за самия невърнат документ и забавата до деня на акта (виж
     closeLoansAsNotReturned в handlers/deaccession-acts.js). При анулиране
     обработчикът маха само НЕПЛАТЕНИТЕ начисления: платеното не се пипа
     никога, защото парите са в касата. Редът, по който вече е плащано, остава
     в сметката — с бележка „отчислен с акт № 1/2026“, тоест сочещ акт, който
     от този момент не действа. Обработчикът ВЕЧЕ сглобява и връща този списък
     (`keptCharges`), както и отворените обратно заемания (`reopenedLoans`), и
     вписва и двете в дневника — но екранът четеше само `droppedHolds` и
     `shelvesToRestore` и казваше „Актът е анулиран. Номерът остава зает, а
     актът остава в документацията.“

     ЗАЩО Е ГРЕШНО ЗА БИБЛИОТЕКАТА. Измерено в проверката на кръга: 21 €
     обезщетение + 1,70 € забава, платени 3 € — след анулирането читателят
     остава задължен 18 € по несъществуващ акт, а човекът, който единствен
     може да уреди това на гишето, научава само „Актът е анулиран“. Следата в
     дневника се чете на другия ден, ако изобщо; читателят идва още същия.

     ЗАЩО ПОПРАВКАТА Е ТОЧНО ТАЗИ. Казва се същото, което пише в дневника — с
     име, сума и накъде, — и със същия тон като предупреждението за
     резервациите: това не е съобщение за успех, а недовършена работа, която
     остава на гишето. Отворените обратно заемания се назовават също: книгата
     се връща във фонда, но е у читателя и пак е „Просрочена“ — иначе
     библиотекарката я търси на рафта. */
  const kept = (res.data && res.data.keptCharges) || [];
  const reo = (res.data && res.data.reopenedLoans) || [];
  const keptTotal = kept.reduce((sum, c) =>
    sum + Math.max(0, (Number(c.charged) || 0) - (Number(c.covered) || 0)), 0);
  toast((n
    ? 'Актът е анулиран. Внимание: ' + (n === 1
        ? '1 резервация, отказана с този акт, остава отказана — подновете я, ако читателят още чака.'
        : n + ' резервации, отказани с този акт, остават отказани — подновете ги, ако читателите още чакат.')
    : 'Актът е анулиран. Номерът остава зает, а актът остава в документацията.')
    + (sh.length ? ' ' + (sh.length === 1 ? '1 документ е бил махнат от витрина' : sh.length + ' документа са били махнати от витрини')
        + ' в онлайн каталога — върнете ги ръчно, ако витрината трябва да е както преди ('
        + sh.map(x => 'инв. № ' + (x.inv_number ?? '—') + ' → ' + x.shelves).join('; ') + ').' : '')
    + (reo.length ? ' ' + (reo.length === 1
        ? '1 заемане е отворено обратно — документът е пак у читателя и се води просрочен'
        : reo.length + ' заемания са отворени обратно — документите са пак у читателите и се водят просрочени') + '.' : '')
    + (kept.length ? ' Внимание: ' + (kept.length === 1 ? 'начислението ОСТАВА' : 'начисленията ОСТАВАТ')
        + ' в сметката на читателя, защото по ' + (kept.length === 1 ? 'него' : 'тях') + ' вече е плащано — '
        + kept.map(c => (c.reader_name || 'читател') + ' (инв. № ' + (c.inv_number ?? '—') + ', '
            + (c.kind === 'забава' ? 'забава' : 'за невърнат документ') + ': начислено '
            + mny(c.charged || 0) + ', събрано ' + mny(c.covered || 0) + ', остава '
            + mny(Math.max(0, (Number(c.charged) || 0) - (Number(c.covered) || 0))) + ')').join('; ')
        + '. Общо остават ' + mny(keptTotal) + ' по акт, който вече не действа — '
        + 'уредете ' + (kept.length === 1 ? 'го' : 'ги') + ' от картона на читателя в „Читатели“ '
        + '(сторниране или плащане), защото бележката до ' + (kept.length === 1 ? 'реда' : 'редовете')
        + ' сочи анулирания акт.' : ''),
    (n || sh.length || kept.length || reo.length) ? 'warn' : 'ok');
}
window.revokeActGo = revokeActGo;
