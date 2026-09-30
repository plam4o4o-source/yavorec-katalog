/* ---------------- Връзки към фонда (общи за персоналии и летопис) ---------------- */
function linksPanelHtml(fromKind, fromId, links) {
  return `<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Свързани материали</h3>
    <div class="note" style="margin-top:0">Документи от фонда, статии, други персоналии и записи в
    летописа, които се отнасят до този запис.</div>
    <div id="linkList">${linkListHtml(links)}</div>
    <div class="grid g3" style="margin-top:10px">
      <div class="field"><label>Вид</label>
        <select id="lnkKind" onchange="lnkSearch()">
          <option value="книга">Документ от фонда</option>
          <option value="статия">Статия (аналитично описание)</option>
          <option value="персона">Персоналия</option>
          <option value="летопис">Запис в летописа</option>
          <option value="периодика">Периодично издание</option>
        </select></div>
      <div class="field"><label>Търсене</label>
        <input id="lnkQ" placeholder="заглавие, автор, инв. №…" oninput="lnkSearch()"></div>
      <div class="field"><label>Намерени</label>
        <select id="lnkPick"><option value="">— въведете търсене —</option></select></div>
    </div>
    <button class="btn pri" onclick="lnkAdd('${fromKind}', ${fromId})">Свържи</button>
  </div>`;
}
function linkListHtml(links) {
  if (!links.length) return '<div class="hint">Няма свързани материали.</div>';
  return `<table class="ledger"><tbody>${links.map(l => `<tr>
    <td style="width:110px"><span class="tag">${esc(l.to_kind)}</span></td>
    <td>${esc(l.label)}</td>
    <td style="width:80px"><button class="btn sm dgr" onclick="lnkDel(${l.id}, '${jsq(l.to_kind + ': ' + l.label)}')">Махни</button></td>
  </tr>`).join('')}</tbody></table>`;
}
/* ОБРАТНИТЕ ВРЪЗКИ — „КОЙ СОЧИ КЪМ ТОЗИ ЗАПИС“ (v2.4.69, Л6).
   =========================================================================
   ДОТУК връзките се виждаха само в едната посока. Летописът за 1972 г. сочи
   „Вълчев, Стефан“, а картонът на Вълчев казваше „Няма свързани материали“;
   картонът на книга не показваше кои персоналии, записи в летописа и статии се
   позовават на нея. Каналът links:backlinks съществуваше от самото начало, но
   не го викаше нито един екран (тестер № 6, s2-letopis-personalii.js).
   Панелът е само за четене: обратната връзка се маха от картона, ОТ КОЙТО
   тръгва (там е и бележката към нея), а статията, чийто източник е книгата —
   като се смени източникът в описанието. Всеки ред отваря картона на
   източника си, за да се стигне до него с едно щракване.
   backlinksHtmlFor(toKind, toId) е за картоните на други раздели — картонът на
   книгата (src/views/books.js) го вика с 'книга'. */
const BACKLINK_OPEN = { 'персона': 'personView', 'летопис': 'chronicleView', 'статия': 'analyticForm' };
function backlinksPanelHtml(list) {
  const rows = list || [];
  return `<div class="card" style="margin-top:14px" id="backlinks"><h3 style="margin-top:0">Сочат към този запис</h3>
    ${rows.length ? `<table class="ledger"><tbody>${rows.map(l => {
      const fn = BACKLINK_OPEN[l.from_kind];
      const open = fn ? ` <button class="btn sm" onclick="closeModal();${fn}(${Number(l.from_id)})">Отвори</button>` : '';
      return `<tr><td style="width:110px"><span class="tag">${esc(l.from_kind)}</span></td>
        <td>${esc(l.label)}${l.source ? ' <span class="hint">— източник на статията</span>' : ''}</td>
        <td style="width:80px">${open}</td></tr>`;
    }).join('')}</tbody></table>`
      : '<div class="hint">Нито една персоналия, запис в летописа или статия не сочи към този запис.</div>'}
  </div>`;
}
/* БЕЗ ОБРАТНИ ВРЪЗКИ — БЕЗ ПАНЕЛ (v2.4.71, находка Д15).
   ДОТУК тази функция връщаше панела и при празен списък — с текста „Нито една
   персоналия, запис в летописа или статия не сочи към този запис.“ Картонът на
   книгата я вика за ВСЯКА книга и коментарът там обещава „ако няма връзки, не
   се показва нищо“; в библиотека с 15 000 книги и десетина краеведски връзки
   това е едно и също празно каре под всяка форма, което избутва бутоните
   надолу и казва нещо, което никой не е питал. Празният низ е договорът, по
   който извикващите вече проверяват (`if (h)`). Картоните на персоналия и на
   летопис рисуват панела сами (backlinksPanelHtml) и там празният текст остава —
   това е краеведският картон, където въпросът „кой сочи към мен“ е смислен и
   отговорът „никой“ е сведение. */
async function backlinksHtmlFor(toKind, toId) {
  const rows = await call(window.api.links.backlinks({ toKind, toId }));
  return rows && rows.length ? backlinksPanelHtml(rows) : '';
}
window.backlinksHtmlFor = backlinksHtmlFor;
/* ЕДИН ЗНАК ПАК Е ИНВЕНТАРЕН НОМЕР (v2.4.61).
   =========================================================================
   Полето подсказва „заглавие, автор, инв. №…“, но правилото „поне 2 знака“
   изключваше точно най-краткото истинско питане: документ с инвентарен номер 1
   (а в новооткрита библиотека първите номера са едноцифрени) изобщо не се
   търсеше. Обратното също беше счупено: „инв. № 2“, изписано точно както го
   подсказва полето, не намираше нищо, защото представката се изрязваше само в
   прозореца „Аналитично описание“, не и тук.
   Сега представката се разпознава в самия канал links:search (виж бележката
   там), тоест двата прозореца питат по един и същ начин, а прагът от два знака
   важи само за ТЕКСТ — при чисто число той няма смисъл. Прагът остава за
   текста, защото „а“ би върнало целия фонд. */
async function lnkSearch() {
  const kind = $('#lnkKind').value, raw = $('#lnkQ').value.trim();
  const sel = $('#lnkPick');
  // ANL_INV_RE е същият израз, който ползва и прозорецът „Аналитично описание“
  // (src/views/analytics.js) — два прозореца, едно правило.
  const m = kind === 'книга' ? ANL_INV_RE.exec(raw) : null;
  const q = m ? m[1] : raw;
  if (!q || (q.length < 2 && !/^\d+$/.test(q))) { sel.innerHTML = '<option value="">— въведете поне 2 знака —</option>'; return; }
  const rows = await call(window.api.links.search({ kind, q }));
  sel.innerHTML = (rows || []).length
    ? (rows || []).map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join('')
    : '<option value="">— няма намерени —</option>';
}
window.lnkSearch = lnkSearch;
async function lnkAdd(fromKind, fromId) {
  const toKind = $('#lnkKind').value, toId = $('#lnkPick').value;
  if (!toId) return toast('Изберете запис от списъка „Намерени“.', 'err');
  const r = await call(window.api.links.add({ fromKind, fromId, toKind, toId: Number(toId) }), 'Връзката е добавена.');
  if (r === null) return;
  await refreshLinks(fromKind, fromId);
  markSaved();
}
window.lnkAdd = lnkAdd;
/* „МАХНИ“ ПИТА (v2.4.61). Копчето стои на всеки ред в списъка със свързани
   материали и дотук се изпълняваше от първия клик, без въпрос — а редовете са
   един под друг и близо един до друг. Връзката не се възстановява с едно
   натискане: трябва да се намери отново записът в търсачката и да се свърже
   наново, а бележката към връзката се губи. Всички останали изтривания в
   програмата питат; това беше единственото, което не питаше. */
async function lnkDel(id, label) {
  /* Копчето се запомня ПРЕДИ въпроса: глобалното `event` важи само докато тече
     самият обработчик, а след await-а (диалогът, после каналът) то вече е
     празно и резервният път по-долу би останал без панел. */
  const btn = /** @type {HTMLElement} */ ((typeof event !== 'undefined' && event) ? event.target : null);
  const panel = btn && btn.closest('.card');
  if (!await askConfirm('Да се махне ли връзката' + (label ? ' „' + label + '“' : '') + '?',
    { kind: 'delete', okLabel: 'Махни' })) return;
  await call(window.api.links.delete(id), 'Връзката е премахната.');
  // Опреснява списъка от текущия отворен запис.
  if (window._LINK_CTX) await refreshLinks(window._LINK_CTX.kind, window._LINK_CTX.id);
  else if (panel) panel.querySelector('#linkList').innerHTML = '<div class="hint">Няма свързани материали.</div>';
}
window.lnkDel = lnkDel;
async function refreshLinks(fromKind, fromId) {
  window._LINK_CTX = { kind: fromKind, id: fromId };
  LINKS_CHANGED = true;
  const links = await call(window.api.links.list({ fromKind, fromId }));
  const box = $('#linkList');
  if (box) box.innerHTML = linkListHtml(links || []);
}
/* Одит v2.4.29: „Свържи“/„Махни“ в картона + „Затвори“ оставяха стария брой
   „свързани материала“ в списъка на Персоналии/Летопис до повторно влизане. */
let LINKS_CHANGED = false;
function linksRefreshListIfChanged() {
  if (!LINKS_CHANGED) return;
  LINKS_CHANGED = false;
  if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.linksRefreshListIfChanged = linksRefreshListIfChanged;

/* „СМЕНИ…“ И „МАХНИ“ СНИМКА ПИТАТ (v2.4.69, Л8).
   =========================================================================
   ДОТУК „Махни“ триеше снимката с едно щракване, а „Смени…“ я заместваше без
   въпрос — старата не се пази никъде. За краеведа снимката често е
   ЕДИНСТВЕНОТО копие: сканирана е от хартия, която после се връща на
   семейството. Връзките („Махни“ в „Свързани материали“) питат от v2.4.61;
   снимката, която е по-ценна от връзката, беше останала без въпрос.
   `hasPhoto` идва от картона: първа снимка („Снимка…“) не заменя нищо и не пита. */
async function localPhotoChoose(table, id, hasPhoto) {
  if (hasPhoto && !await askConfirm('Новата снимка ще ЗАМЕСТИ сегашната. Старата не се пази никъде в програмата — '
    + 'ако е единственото ѝ копие, първо я запазете отделно.\n\nДа изберете ли нова снимка?',
    { okLabel: 'Избери нова' })) return null;
  const res = await window.api.localPhoto.choose({ table, id });
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast('Снимката е добавена.', 'ok'); markSaved();
  closeModal();
  if (table === 'persons') { await renderPersons(); personView(id); }
  else { await renderChronicle(); chronicleView(id); }
}
window.localPhotoChoose = localPhotoChoose;
async function localPhotoClear(table, id) {
  if (!await askConfirm('Да се махне ли снимката? Тя не се пази никъде другаде в програмата и не може да бъде върната — '
    + 'ако е единственото ѝ копие, първо я запазете отделно.', { kind: 'delete', okLabel: 'Махни снимката' })) return;
  if (await call(window.api.localPhoto.clear({ table, id }), 'Снимката е премахната.') === null) return;
  closeModal();
  if (table === 'persons') { await renderPersons(); personView(id); }
  else { await renderChronicle(); chronicleView(id); }
}
window.localPhotoClear = localPhotoClear;
