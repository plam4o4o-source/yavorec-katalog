/* ---------------- Инвентаризация ---------------- */
/* БРОЙКАТА НА ЕДИН РЕД — навсякъде в този екран (v2.4.61).
   Инвентаризацията по чл. 40 – 41 брои библиотечни ДОКУМЕНТИ, не инвентарни
   номера (виж дългата бележка в handlers/inventory-sessions.js). Бройката идва
   от обработчика като COALESCE(inventory.quantity, 1); правилото за липсващата
   стойност се повтаря и тук по същата причина, поради която е COALESCE в SQL:
   ред без записана бройка е ПОНЕ един документ, не нула. Изричната нула се
   уважава — тя е разминаване в данните и трябва да си личи, а не да се
   „поправя“ мълчаливо на екрана. */
/* ДОКУМЕНТИ, НЕ „135.0 документа“ (v2.4.69, находка Е10 от пълния тест). Нормативът
   по чл. 41 е процент от фонда и може да е дробен (0,5 % от 2 501 = 12,5), затова
   дотук се печаташе с toFixed(1) — и на подписания протокол излизаше „135.0
   документа“: с английска точка и с нула, която никой не пише. Цяло число се
   показва цяло, дробното — с една цифра и българска десетична запетая. Закръгля
   се ПРЕДИ проверката за цяло: 3,95 става „4“, а не „4,0“. */
function lossFmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',');
}
function invQty(x) {
  const q = Number(x && x.quantity);
  return Number.isFinite(q) && q >= 0 ? q : 1;
}
function invQtySum(rows) { return (rows || []).reduce((n, x) => n + invQty(x), 0); }
let INVENT_SESSION = null;
async function renderInvent() {
  if (INVENT_SESSION) return renderInventRun();
  const [req, sessions] = await Promise.all([call(window.api.inventorySessions.requirement()), call(window.api.inventorySessions.list())]);
  if (!req) return;
  // Напредъкът за годината: колко от изисквания обхват вече е обхванат от приключените проверки.
  /* Провалено IPC (SQLITE_BUSY на мрежов дял) връщаше null и рендерът гърмеше на
     `sessions.length` по-долу — заглавието и менюто вече показваха
     „Инвентаризация“, а в тялото стоеше предишният екран. Ред 9 по-долу вече се
     пазеше със `(sessions || [])`; тук се изравнява. */
  const list = sessions || [];
  const thisYear = yr();
  /* Напредъкът за годината идва от handler-а: сумирането на s.scanned по сесии
     броеше два пъти документ, проверен в две проверки през една година. */
  const scannedYear = req.scannedYear || 0;
  const pct = req.target ? Math.min(100, Math.round(scannedYear / req.target * 100)) : 0;
  $('#view').innerHTML = `
    <div class="note"><b>Чл. 40, т. 2</b> — инвентаризация по репрезентативния метод се извършва ежегодно върху
    не по-малко от <b>${req.pct}%</b> от фонда
      (процентът зависи от размера на фонда: 10% до 50 000 документа, 5% до 200 000, 2% над това).</div>

    <div class="grid g3" style="margin-bottom:16px">
      <div class="card" style="grid-column:span 2"><h3 style="margin-top:0">Напредък за ${thisYear} г.</h3>
        <div style="display:flex;align-items:center;gap:22px;flex-wrap:wrap">
          ${ringSvg(pct, 'от изисквания обхват')}
          <div style="flex:1;min-width:190px">
            <div class="statRows">
              <div><span>Проверени тази година</span><b>${scannedYear.toLocaleString('bg-BG')}</b></div>
              <div><span>Изискван обхват (${req.pct}%)</span><b>${req.target.toLocaleString('bg-BG')}</b></div>
              <div><span>Остават</span><b style="color:${scannedYear >= req.target ? 'var(--green)' : 'var(--red)'}">
                ${Math.max(0, req.target - scannedYear).toLocaleString('bg-BG')}</b></div>
            </div>
          </div>
        </div>
        ${scannedYear >= req.target
          ? '<div class="note" style="margin-bottom:0">Изискването по чл. 40, т. 2 за тази година е изпълнено.</div>'
          : `<div class="note w" style="margin-bottom:0">Остават <b>${req.target - scannedYear}</b> документа до изпълнение на изискването за ${thisYear} г.</div>`}
      </div>
      <div class="card"><h3 style="margin-top:0">Показатели</h3>
        <div class="statRows">
          <!-- Одит v2.4.16: етикетът беше „Библиотечен фонд“ — същият, с който
               Таблото и Справките наричат броя ЕКЗЕМПЛЯРИ. Тук числото са
               инвентарните номера (редове), защото проверката става чрез
               сканиране на номер; двете мерки са различни нарочно (виж бележката
               в handlers/dashboard.js), но не бива да носят едно и също име —
               пред проверяващ това изглежда като разминаване в отчета. -->
          <div><span title="Брой инвентарни номера — по един на ред в инвентарната книга. Различава се от броя екземпляри във фонда, когато едно заглавие е в няколко екземпляра.">Инвентарни номера във фонда</span><b>${req.active.toLocaleString('bg-BG')}</b></div>
          ${/* ДВЕТЕ МЕРКИ СЕ ПОКАЗВАТ ЕДНА ДО ДРУГА (v2.4.61). Нормата по чл. 40,
               т. 2 се мери в инвентарни номера (проверката е сканиране на номер),
               а нормативът по чл. 41 и целият протокол — в библиотечни документи.
               Двете съвпадат във всяка база, в която програмата сама е давала
               номерата; разминават се при заварен неразделен запис. Редът излиза
               само тогава — иначе би повтарял същото число два пъти. */''}
          ${req.activeDocs != null && req.activeDocs !== req.active
            ? `<div><span title="Броят библиотечни документи (екземпляри) — мярката на чл. 13, чл. 16 и чл. 40 – 41. Различава се от инвентарните номера при заварен запис с няколко екземпляра под един номер.">Библиотечни документи във фонда</span><b>${Number(req.activeDocs).toLocaleString('bg-BG')}</b></div>`
            : ''}
          <div><span>Изискван процент</span><b>${req.pct}%</b></div>
          <div><span>Допустими загуби</span><b>${lossFmt(req.naturalLoss)}</b></div>
        </div>
        <div class="hint" style="margin-top:10px">Допустимите загуби по чл. 41 се изчисляват спрямо фонда
        (в библиотечни документи) и дела на свободния достъп.</div>
      </div>
    </div>

    <div class="toolbar">
      <button class="btn pri" onclick="startInventForm()">Започни нова проверка</button>
      <button class="btn" onclick="mobileHelp()">📱 Сканиране с телефон</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Протокол № / дата</th><th>Обхват</th><th>В обхвата</th>
      <th>Проверени</th><th>Липсващи</th><th>Комисия</th><th>Състояние</th></tr></thead><tbody>
    ${list.length ? list.map(s => {
      const poolShown = s.pool_final != null ? s.pool_final : (s.pool_size || 0);
      const sp = poolShown ? Math.min(100, Math.round((s.scanned || 0) / poolShown * 100)) : 0;
      return `<tr><td class="num">${s.no ? s.no + ' / ' + esc(s.year || yr(s.date)) : '—'}<br><span class="hint">${bg(s.date)}</span></td><td>${esc(s.scope || '')}${s.department ? `<br><span class="badge">отдел „${esc(s.department)}“</span>` : ''}</td>
      <td class="num">${poolShown}</td>
      <td><div style="display:flex;align-items:center;gap:8px">
        <b class="num">${s.scanned || 0}</b>
        <div class="chartTrack" style="flex:1;min-width:60px;height:7px"><div class="chartFill" style="width:${sp}%"></div></div>
        <span class="hint">${sp}%</span></div></td>
      ${/* Липсите се броят в ДОКУМЕНТИ (v2.4.61) — същата мярка като в
           протокола, до който води бутонът на този ред. Когато редовете в
           таблицата на протокола са по-малко (заварен запис с няколко
           екземпляра под един номер), се казва и това: иначе „5“ на екрана
           срещу „3 реда“ на хартия изглежда като грешка. */''}
      <td class="num">${s.closed ? `<b style="color:${s.missing ? 'var(--red)' : 'var(--green)'}">${s.missing || 0}</b>${
        s.missing_rows != null && s.missing_rows !== s.missing
          ? `<br><span class="hint">${s.missing_rows} инв. №</span>` : ''}` : '<span class="hint">—</span>'}</td>
      <td style="font-size:12px">${[s.committee1, s.committee2, s.committee3].filter(Boolean).map(esc).join(', ')}</td>
      <td>${s.closed
        ? `<button class="btn sm" onclick="printInventProtocol(${s.id})">Протокол</button>
           <span class="badge ok">приключена</span> ${
            /* Видът се показва тук (v2.3.0): приключена ПРЕДСТАВИТЕЛНА проверка с 0
               липсващи изглеждаше точно като ПЪЛНА с 0 липсващи, а разликата е
               нормативна (чл. 40, т. 2) и трябва да се вижда и след години. Сесиите
               отпреди v2.3.0 нямат записан вид — за тях не се твърди нищо. */
            s.mode === 'full' ? '<span class="badge">пълна</span>'
            : s.mode === 'representative' ? '<span class="badge">представителна</span>'
            : '<span class="hint" title="Сесия отпреди v2.3.0 — видът не е записван">вид: —</span>'}`
        : `<button class="btn sm pri" onclick="resumeInvent(${s.id})">Продължи</button>
           <span class="badge warn">отворена</span>`}</td></tr>`;
    }).join('')
      : `<tr><td colspan="7" class="empty">Няма извършени проверки.</td></tr>`}
    </tbody></table></div>`;
}
/* КОМИСИЯТА ОТ НАСТРОЙКИТЕ (v2.4.71, находка И4).
   (а) Актът за отчисляване и партидата предлагат комисията от „Настройки“, а
       „Нова инвентаризация“ — не: тестерът намери трите полета празни при
       попълнени Настройки, и протоколът по чл. 40 излезе с „1. ………… 2. …………“.
   (б) Протоколът се подписва от назначената комисия; празни линии значат, че
       имената се дописват на ръка, а списъкът на проверките и следата остават
       без комисия — тоест пред проверяващ не личи кой е проверявал.
   (в) Точно като actForm() в src/views/deaccession-acts.js: стойностите се
       четат от settings.get() при отваряне на формата и само се ПРЕДЛАГАТ —
       библиотекарката може да ги смени за тази проверка. Провален IPC дава
       празни полета, както досега, а не спира формата. */
async function startInventForm() {
  const st = await call(window.api.settings.get());
  const cm = (k) => ({ val: (st && st[k]) || '' });
  modal('Нова инвентаризация', `
    <form id="ivF" onsubmit="return false">
      <div class="grid g3">
        ${fld('Протокол №', 'no', { type: 'number', hint: 'празно = следващият свободен за годината' })}
        ${fld('Дата', 'date', { val: today(), type: 'date', req: 1 })}
        ${fld('Заповед №', 'order_no', { hint: 'с която е назначена комисията' })}
      </div>
      <!-- Одит на документите v2.4.17: „Обхват“ беше свободен текст, предварително
           попълнен „репрезентативен метод“, докато ВИДЪТ на проверката се избира чак
           при приключване. По подразбиране протоколът гласеше „извърши пълна
           инвентаризация … Обхват: репрезентативен метод“ — противоречие точно по
           разграничението, което е нормативно (чл. 40, т. 1 срещу т. 2). Полето вече
           описва КАКВО се проверява, а не по какъв метод. -->
      ${fld('Какво се проверява', 'scope', { val: 'целият фонд',
        hint: 'напр. „целият фонд“, „свободен достъп“, „сектор Краезнание“. Видът на проверката (пълна или представителна) се избира при приключването.' })}
      <div class="grid g3">${fld('Комисия 1', 'committee1', cm('committee1'))}${fld('Комисия 2', 'committee2', cm('committee2'))}${fld('Комисия 3', 'committee3', cm('committee3'))}</div>
      ${fld('Ограничи до отдел', 'department', { type: 'select', opts: OTDELI, emptyLabel: '— целият фонд —' })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="beginInvent()">Започни сканиране</button>`);
  /* „КАКВО СЕ ПРОВЕРЯВА“ СЛЕДВА ОТДЕЛА, АКО НЕ Е ПИПАНО (v2.4.71, находка И3).
     Предварителното „целият фонд“ оставаше и при избран отдел и протоколът
     гласеше „Какво е проверявано: целият фонд · отдел „за деца““. Сега изборът
     на отдел сменя полето на „отдел „…““ — но САМО ако в него стои текстът,
     който програмата сама е сложила (или е празно). Написаното от човек не се
     пипа. Обработчикът прави същото и от своя страна (inventorySessions:start). */
  const dep = /** @type {HTMLSelectElement|null} */ ($('#ivF [name=department]'));
  const sc = /** @type {HTMLInputElement|null} */ ($('#ivF [name=scope]'));
  if (dep && sc) {
    let auto = sc.value;
    dep.addEventListener('change', () => {
      const cur = sc.value.trim();
      if (cur && cur !== auto) return;
      auto = dep.value ? 'отдел „' + dep.value + '“' : 'целият фонд';
      sc.value = auto;
    });
  }
}
window.startInventForm = startInventForm;
async function beginInvent() {
  const d = formData('#ivF');
  const id = await call(window.api.inventorySessions.start(d));
  if (!id) return;
  markSaved();
  INVENT_SESSION = { id, log: [] };
  closeModal(); renderInventRun();
}
window.beginInvent = beginInvent;
/* Одит v2.4.16: „Прекрати“ питаше „Прекратяване без запис?“ и само занулявaше
   INVENT_SESSION. Но всяко сканиране вече е записано в базата (сканирането,
   проверката, datelastseen, и статусът на всяка намерена „липсваща“ книга) —
   тоест въпросът беше неверен. По-лошото: INVENT_SESSION беше ЕДИНСТВЕНИЯТ път
   към отворена сесия, а редовете в списъка нямаха нито един бутон. Изоставената
   проверка оставаше отворена завинаги, невидимо продължаваше да брои към
   годишната норма, а библиотекарят трябваше да започне нова и да сканира рафта
   отначало. Същият капан се задействаше и при рестарт по средата.
   Сега излизането е честно, а сесията се отваря отново от списъка. */
function leaveInvent() {
  INVENT_SESSION = null;
  renderInvent();
  toast('Проверката остава отворена — продължете я от списъка с бутона „Продължи“.', 'ok');
}
window.leaveInvent = leaveInvent;
async function resumeInvent(id) {
  const s = await call(window.api.inventorySessions.get(id));
  if (!s) return;
  if (s.closed) return toast('Тази проверка вече е приключена.', 'err');
  INVENT_SESSION = { id, log: [] };
  renderInventRun();
}
window.resumeInvent = resumeInvent;

/* Един ред в дневника на сканиранията — и в екрана, и в INVENT_SESSION.log, от
   който екранът се пречертава (виж бележката при #ivLog). Пазят се последните
   500 реда: дневникът е за окото на комисията, протоколът е в базата. */
function ivLogAdd(html) {
  if (INVENT_SESSION) {
    if (!Array.isArray(INVENT_SESSION.log)) INVENT_SESSION.log = [];
    INVENT_SESSION.log.unshift(html);
    if (INVENT_SESSION.log.length > 500) INVENT_SESSION.log.length = 500;
  }
  const log = $('#ivLog');
  if (log) log.insertAdjacentHTML('afterbegin', html);
}
window.ivLogAdd = ivLogAdd;
async function renderInventRun() {
  const s = await call(window.api.inventorySessions.get(INVENT_SESSION.id));
  /* `s` може да е null по два отделни пътя: call() връща null при {ok:false} —
     например базата е заета от другата станция и заявката е надхвърлила
     busy_timeout — а самият handler връща null, ако редът вече не съществува.
     Без тази проверка следващият ред хвърляше TypeError вътре в route(): #view
     оставаше с предишния екран, полето за сканиране изчезваше, а INVENT_SESSION
     си стоеше — тоест всяко следващо влизане в раздела удряше същия ред и
     библиотекарят не можеше да се върне в проверката си без рестарт.
     closeInvent() по-долу пази точно това от самото начало. */
  if (!s) {
    INVENT_SESSION = null;
    toast('Проверката не се зареди — вероятно базата е заета от друг компютър. Опитайте отново.', 'err');
    return renderInvent();
  }
  /* „Намерени“ се брои в БИБЛИОТЕЧНИ ДОКУМЕНТИ (v2.4.61), както обхватът
     (pool_size) и както целият протокол по чл. 40. Дотук тук стоеше
     s.scans.length — брой сканирани редове — а обхватът вече беше в документи:
     заварен запис с 3 екземпляра под един номер даваше „В обхвата 10 ·
     Намерени 1“ след като комисията физически е проверила три документа. */
  const found = invQtySum(s.scans), pool = s.pool_size || 0;
  const left = Math.max(0, pool - found);
  const pct = pool ? Math.min(100, Math.round(found / pool * 100)) : 0;
  $('#view').innerHTML = `
    <div class="note w"><b>Проверка в ход</b> — ${bg(s.date)} · ${esc(s.scope || '')}. Сканирайте или въвеждайте
    инвентарните номера един по един; всеки намерен документ се отбелязва веднага.</div>

    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:22px;flex-wrap:wrap">
        <div id="ivRing">${ringSvg(pct, 'проверени от обхвата')}</div>
        <div style="flex:1;min-width:200px">
          <div class="statRows">
            <div><span>В обхвата</span><b>${pool.toLocaleString('bg-BG')}</b></div>
            <div><span>Намерени</span><b id="ivFound" style="color:var(--green)">${found.toLocaleString('bg-BG')}</b></div>
            <div><span>Остават</span><b id="ivLeft">${left.toLocaleString('bg-BG')}</b></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0">Сканиране</h3>
      <input id="ivScan" class="scan" placeholder="Инвентарен №/баркод…" autocomplete="off">
      ${/* ДНЕВНИКЪТ ОЦЕЛЯВА ПРИ ПРЕЧЕРТАВАНЕ (v2.4.69, находка О6). Дотук редовете
            живееха само в DOM-а: вносът от телефона пречертава екрана (за да вдигне
            броячите) и изтриваше всичко сканирано на компютъра до момента, заедно с
            червените редове „непознат“/„вече сканиран“, които комисията още не е
            прегледала. Сега дневникът стои в INVENT_SESSION.log и се рисува оттам. */''}
      <div id="ivLog" style="margin-top:10px;max-height:230px;overflow:auto">${
        ((INVENT_SESSION && INVENT_SESSION.log) || []).join('')}</div>
    </div>
    <div class="toolbar">
      <button class="btn" onclick="importScansModal(${s.id})">📱 Въведи сканирания от телефон</button>
      <button class="btn pri" onclick="closeInvent()">Приключи и състави протокол</button>
      <button class="btn" onclick="leaveInvent()">Излез (сесията остава отворена)</button>
    </div>`;
  const el = $('#ivScan'); el.focus();
  let scanned = found;
  el.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = el.value.trim(); el.value = ''; if (!code) return;
    const res = await window.api.inventorySessions.scan({ sessionId: INVENT_SESSION.id, code });
    if (!res.ok) {
      ivLogAdd(`<div class="scanlog err">${esc(res.error)}</div>`);
      return;
    }
    const qty = invQty(res.data);
    /* ИЗГУБЕН ОТ ЧИТАТЕЛ, А Е НА РАФТА (v2.4.69, находка О3). Дотук редът светваше
       зелено като всеки друг и състоянието „изгубен“ оставаше без дума —
       обезщетението висеше по сметката на читателя, а документът можеше да влезе в
       акт по чл. 30, т. 5, докато е на рафта. Сканирането пак се брои (документът е
       проверен), но редът е предупреждение с името на читателя и с действието,
       което урежда случая. Текстът идва от обработчика (lostCaseOf), за да казва
       същото и вносът от телефона. */
    const lost = res.data.lost;
    ivLogAdd(
      `<div class="scanlog ${lost ? 'warn' : 'ok'}"><b>${res.data.inv_number}</b> — ${esc(res.data.title)}${
        /* Неразделен стар запис се казва на глас още при сканирането: комисията
           трябва да провери ТРИ документа под този номер, не един. */
        qty !== 1 ? ` <span class="badge warn">${qty} екз. под един инв. №</span>` : ''}${
        lost ? `<br><span class="badge warn">ИЗГУБЕН</span> ${esc(lost.message)}` : ''}</div>`);
    if (lost) toast(lost.message, 'warn');
    markSaved();
    // Броячите се обновяват на място. Пълно пречертаване тук би изтрило дневника
    // на сканиранията, който току-що беше допълнен.
    scanned += qty;
    const nLeft = Math.max(0, pool - scanned);
    const nPct = pool ? Math.min(100, Math.round(scanned / pool * 100)) : 0;
    const f = $('#ivFound'), l = $('#ivLeft'), rg = $('#ivRing');
    if (f) f.textContent = scanned.toLocaleString('bg-BG');
    if (l) l.textContent = nLeft.toLocaleString('bg-BG');
    if (rg) rg.innerHTML = ringSvg(nPct, 'проверени от обхвата');
  });
}
/* Приключването пита за ВИДА на проверката, защото последицата е много различна и
   необратима на практика: при пълна проверка всеки несканиран документ получава
   статус „липсващ" (връщането е ръчно, книга по книга). До v2.1.0 въпрос нямаше и
   се изпълняваше винаги пълният вариант — библиотекар, сканирал нормативните 10%
   по чл. 40, т. 2, получаваше протокол с 90% липси. */
async function closeInvent() {
  /* ПРЕГЛЕДЪТ ИДВА ОТ ОБРАБОТЧИКА, А НЕ ОТ СНИМКАТА ПРИ ЗАПОЧВАНЕТО (v2.4.71, И1).
     Дотук числата тук се смятаха от pool_size (обхватът при започването), а
     приключването брои обхвата наново: тестерът видя „Проверени са 5 от 5 …
     Останалите 0 не са сканирани“, а след „Пълна проверка“ — „Липсващи 1“ за
     книга, вписана междувременно. Сега прозорецът показва точно онова, което
     приключването ще направи в този миг (inventorySessions:get с preview —
     същата функция classifySession в handlers/inventory-sessions.js). */
  const s = await call(window.api.inventorySessions.get(INVENT_SESSION.id, { preview: true }));
  if (!s) return;
  const pv = s.preview || null;
  /* Диалогът брои в библиотечни документи — същото, което ще влезе в протокола
     (v2.4.61). Дотук тук се показваше броят СКАНИРАНИЯ срещу обхват в документи
     и при заварен неразделен запис числата не се връзваха още преди печата. */
  const scannedDocs = pv ? pv.scanned : invQtySum(s.scans);
  const poolNow = pv ? pv.pool : (s.pool_size || 0);
  const unscanned = Math.max(0, poolNow - scannedDocs);
  /* Колко от несканираните наистина ще станат „липсващ“ при пълна проверка —
     без заетите, при партньора по МЗС, за реставрация, изгубените и
     постъпилите след началото. Точно това число решава дали да се избере
     „пълна“, затова се казва то, а не суровата разлика. */
  const unchecked = pv ? pv.missingIfFull : unscanned;
  const fmt = (n) => Number(n || 0).toLocaleString('bg-BG');
  const pl = (n, one, many) => (n ? fmt(n) + ' ' + (n === 1 ? one : many) : '');
  const excuses = pv ? [
    pl(pv.onLoan, 'зает от читател', 'заети от читатели'),
    pl(pv.mzsAway, 'при друга библиотека по МЗС', 'при други библиотеки по МЗС'),
    pl(pv.atBinder, 'за реставрация', 'за реставрация'),
    pl(pv.lostBefore, 'изгубен от ползвател', 'изгубени от ползватели'),
    pl(pv.addedLate, 'постъпил след началото на проверката', 'постъпили след началото на проверката')
  ].filter(Boolean) : [];
  modal('Какъв е видът на тази инвентаризация?', `
    <div class="note" style="margin-top:0">Проверени са <b>${fmt(scannedDocs)}</b>
    от <b>${fmt(poolNow)}</b> документа в обхвата.
    Останалите <b>${fmt(unscanned)}</b> не са сканирани.${excuses.length
      ? ' От тях не стават липсващи: ' + excuses.join(', ') + '.' : ''}${
      pv && poolNow !== (s.pool_size || 0)
        ? `<div class="hint">При започването обхватът беше ${fmt(s.pool_size)} — ${
            poolNow > (s.pool_size || 0) ? 'междувременно са вписани нови документи' : 'междувременно документи са излезли от обхвата'}.
            Протоколът брои обхвата към приключването.</div>` : ''}${
      pv && pv.addedLate
        ? `<div class="hint">Документите, вписани в инвентарната книга, докато проверката тече, не са били на рафта,
            когато комисията е започнала — затова не са липси. Протоколът ги изброява на отделен ред.</div>` : ''}</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <label class="chk" style="align-items:flex-start">
        <input type="radio" name="ivMode" value="representative" checked>
        <span><b>Представителна проверка</b> (чл. 40, т. 2) — минимум 10% от фонда годишно.
        Протоколът важи <b>само за проверените</b> ${scannedDocs.toLocaleString('bg-BG')} документа.
        Несканираните <b>не се пипат</b> — те просто не са влизали в тазгодишната извадка.</span>
      </label>
      <label class="chk" style="align-items:flex-start">
        <input type="radio" name="ivMode" value="full">
        ${/* „Без заетите“ вече не е пълният списък на извиненията (v2.4.65):
             извиняват се и документите при подвързвача („за реставрация“), и
             тези, изгубени от ползватели преди проверката („изгубен“ — чл. 30,
             т. 5). Диалогът ги изброява, защото точно тук библиотекарката решава
             дали да позволи масово презаписване на статуси. */''}
        <span><b>Пълна проверка</b> на целия обхват — ${fmt(unchecked)}
        ${unchecked === 1 ? 'несканиран документ се вписва' : 'несканирани документа се вписват'} в протокола като
        ${unchecked === 1 ? 'липсващ и получава' : 'липсващи и получават'}
        статус <b>„липсващ"</b>. Заетите в момента, изпратените по МЗС, тези „за реставрация“ (при подвързвача),
        изгубените от ползватели и постъпилите след началото на проверката се извиняват поотделно
        и състоянието им не се пипа.</span>
      </label>
    </div>
    ${unchecked > 0 ? `<div class="note w">Изберете „пълна" само ако наистина сте минали през целия
    обхват. При ${fmt(unchecked)} несканирани документа статусът им ще бъде
    презаписан наведнъж, а връщането е ръчно.</div>` : ''}`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="doCloseInvent()">Приключи и състави протокол</button>`);
}
window.closeInvent = closeInvent;
async function doCloseInvent() {
  const sel = /** @type {HTMLInputElement} */ (document.querySelector('[name=ivMode]:checked'));
  const mode = sel ? sel.value : 'representative';
  const res = await window.api.inventorySessions.close({ sessionId: INVENT_SESSION.id, mode });
  if (!res.ok) return toast(res.error, 'err');
  markSaved();
  const r = res.data;
  const doneId = INVENT_SESSION.id; // за печат на протокола веднага след приключване
  INVENT_SESSION = null;
  closeModal();
  const over = Math.max(0, r.missing - r.allowedLoss);
  modal('Инвентаризацията е приключена', `
    <div class="hint" style="margin-bottom:10px">Вид: <b>${r.mode === 'full' ? 'пълна проверка' : 'представителна проверка (чл. 40, т. 2)'}</b></div>
    <div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="num">${r.scanned}</div><div class="lbl">Проверени</div></div>
      <div class="card"><div class="num">${r.missing}</div><div class="lbl">Липсващи</div></div>
      <div class="card"><div class="num">${lossFmt(r.allowedLoss)}</div><div class="lbl">Допустими</div></div>
    </div>
    ${/* Числата са в БИБЛИОТЕЧНИ ДОКУМЕНТИ (v2.4.61) — мярката на чл. 40 – 41 и
         на акта, който ще се състави от тези липси. Когато инвентарните номера
         са по-малко (заварен неразделен запис), се казва изрично: иначе
         таблицата в протокола ще изброи по-малко реда, отколкото пише тук. */''}
    ${r.missingRows != null && r.missingRows !== r.missing
      ? `<div class="note">Липсващите ${r.missing} библиотечни документа стоят под
         ${r.missingRows} инвентарни номера — един стар запис носи няколко екземпляра.
         Протоколът изброява номерата и показва бройката до цената.</div>`
      : ''}
    ${r.outOfScope
      ? `<div class="note">${r.outOfScope === 1
          ? 'Един сканиран документ е излязъл от обхвата, докато проверката е течала'
          : r.outOfScope + ' сканирани документа са излезли от обхвата, докато проверката е течала'}
         (отчислени или преместени в друг отдел) — затова „Проверени“ е по-малко от броя сканирания.
         Тези документи не влизат в протокола: обхватът се снима към ПРИКЛЮЧВАНЕТО.</div>`
      : ''}
    ${/* ИЗГУБЕНИТЕ ОТ ПОЛЗВАТЕЛИ СЕ БРОЯТ ОТДЕЛНО ОТ ЛИПСИТЕ (v2.4.65) — виж
         дългата бележка в handlers/inventory-sessions.js. Документ, приключен
         на гишето с „Документът е изгубен“, не може да бъде сканиран, но не е
         липса по чл. 40: отчислява се по чл. 30, т. 5, а не по т. 6, и не се
         сравнява с норматива по чл. 41. Казва се и накъде се урежда. */''}
    ${r.lostBefore
      ? `<div class="note">${r.lostBefore === 1
          ? 'Един документ от обхвата е <b>изгубен от ползвател</b> преди проверката'
          : r.lostBefore + ' документа от обхвата са <b>изгубени от ползватели</b> преди проверката'}
         (приключени с „Документът е изгубен“, обезщетението е начислено в сметката на читателя).
         ${r.lostBefore === 1 ? 'Той не влиза' : 'Те не влизат'} в липсите по чл. 40,
         ${r.lostBefore === 1 ? 'не се брои' : 'не се броят'} срещу норматива по чл. 41 и
         ${r.lostBefore === 1 ? 'остава' : 'остават'} със състояние „изгубен“.
         ${r.lostBefore === 1 ? 'Отчислява се' : 'Отчисляват се'} с отделен акт по <b>чл. 30, т. 5</b>
         (повредени или невърнати от ползватели) от „Отчисляване“.</div>`
      : ''}
    ${/* ПРИ ПАРТНЬОРА ПО МЗС И ПОСТЪПИЛИТЕ СЛЕД НАЧАЛОТО (v2.4.71, М1 и И1) —
         казват се тук със същите думи, с които ги пише протоколът: иначе
         библиотекарката вижда по-малко липси от несканираните и не знае защо. */''}
    ${r.mzsAway
      ? `<div class="note">${r.mzsAway === 1
          ? 'Един документ е <b>при друга библиотека по МЗС</b> — изпратен по входяща заявка'
          : r.mzsAway + ' документа са <b>при други библиотеки по МЗС</b> — изпратени по входящи заявки'}.
         ${r.mzsAway === 1 ? 'Той не е липса и състоянието му' : 'Те не са липси и състоянието им'} не се пипа;
         протоколът ${r.mzsAway === 1 ? 'го изброява' : 'ги изброява'} на отделен ред.
         ${r.mzsAway === 1 ? 'Когато се върне, отбележете заявката' : 'Когато се върнат, отбележете заявките'} „върнато“ в „МЗС“.</div>`
      : ''}
    ${r.addedLate
      ? `<div class="note">${r.addedLate === 1
          ? 'Един документ е <b>вписан след началото на проверката</b> и не е сканиран'
          : r.addedLate + ' документа са <b>вписани след началото на проверката</b> и не са сканирани'}.
         Когато комисията е тръгнала, ${r.addedLate === 1 ? 'той не е бил' : 'те не са били'} на рафта —
         затова ${r.addedLate === 1 ? 'не е липса' : 'не са липси'}, състоянието не се пипа, а протоколът
         ${r.addedLate === 1 ? 'го изброява' : 'ги изброява'} на отделен ред („постъпили след началото на проверката“).</div>`
      : ''}
    ${r.mode === 'full'
      ? (over > 0
        ? `<div class="note d">Липсите надвишават нормативите за естествени загуби с ${lossFmt(over)} документа (чл. 51 – 53).</div>`
        : `<div class="note">Липсите са в рамките на допустимите естествени загуби (чл. 41, ал. 1).</div>`)
      : `<div class="note">Протоколът важи за проверените ${r.scanned} документа.
         Непроверените ${r.unchecked.toLocaleString('bg-BG')} остават с непроменен статус —
         те влизат в следваща проверка.</div>`}
    ${r.mode === 'full'
      ? `<p style="font-size:13px">Липсващите документи са отбелязани със статус „липсващ“. Отчислете ги с акт по
         <b>чл. 30, т. 6</b>, ако е приложимо.</p>`
      : ''}`,
    /* Бутонът „Проект за акт от липсите“ (v2.4.56). Дотук тук пишеше само
       „Отчислете ги с акт по чл. 30, т. 6“ и с това връзката свършваше:
       инвентарните номера се въвеждаха или сканираха НАНОВО, един по един, при
       това често стотици. Това е най-честият път по чл. 30 и точно на него
       протоколът и актът се разделяха — а актът не носеше и препратка към
       протокола, тоест проверяващият няма как да ги свърже. Прави се ПРОЕКТ,
       не акт: комисията първо преглежда списъка. */
    `${(r.mode === 'full' && r.missing) ? `<button class="btn l" onclick="draftFromMissing(${doneId})">Проект за акт от липсите</button>` : ''}
     <button class="btn" onclick="closeModal();printInventProtocol(${doneId})">Печат на протокола / PDF</button>
     <button class="btn pri" onclick="closeModal()">Затвори</button>`);
  renderInvent();
}
window.doCloseInvent = doCloseInvent;

/* Пренос на установените липси в проект за акт по чл. 30, т. 6 (v2.4.56).
   Проектът носи и номера на протокола в „Заповед №“-полето като препратка —
   иначе актът и протоколът стоят като два несвързани документа. */
async function draftFromMissing(sessionId) {
  const s = await call(window.api.inventorySessions.get(sessionId));
  if (!s) return;
  const miss = (s.missing || []).filter(m => m.book_id);
  if (!miss.length) return toast('В този протокол няма установени липси.', 'err');
  /* СТАРИТЕ ЗАПИСИ С НЯКОЛКО ЕКЗЕМПЛЯРА ПОД ЕДИН НОМЕР (v2.4.62).
     Актът отчислява само екземпляра с номера, записан в него (виж
     actSplitLegacy в src/views/deaccession-acts.js и проверката в ядрото на
     акта), тоест неразделен запис вече не влиза в акт. Тук обаче случаят е
     различен от скъсаната книга в ръката на комисията: записът е ЛИПСВАЩ като
     цяло — нито един от екземплярите под номера не е намерен при проверката —
     значи липсват ВСИЧКИ. Затова записът се разделя (всеки екземпляр получава
     свой номер, сборовете не се променят) и в проекта влизат всичките номера:
     протоколът казва „3 документа“ и актът също казва „3 документа“, само че
     вече поименно, по номер, както го иска инвентарната книга. Пита се веднъж,
     за всички такива записи наведнъж. */
  /* ЧАСТИЧНО ЛИПСВАЩ СТАР ЗАПИС (v2.4.67). Приключването записва в липсите
     само НЕНАМЕРЕНИТЕ бройки на запис, чиято друга бройка е у читател (например
     3 бройки, 1 заета → 2 липсващи). Колко да влязат в акта се решава от
     СНИМКАТА в протокола (m.quantity), ограничена от бройките, които СЕГА не са
     у читател: заета след проверката бройка е намерена. От такъв запис се
     отделят точно толкова нови номера със състояние „липсващ“
     (books:splitCopiesBatch → detachMissingCopies); заеманията и останалите
     бройки остават на оригинала, който не влиза в акта. */
  const liveQty = (m) => (m.live_qty == null ? invQty(m) : Number(m.live_qty) || 0);
  const snapQty = (m) => { const v = Number(m.quantity); return Number.isFinite(v) && v >= 0 ? v : 1; };
  const plan = miss.map(m => {
    const L = liveQty(m);
    return { m, L, q: snapQty(m), k: Math.min(snapQty(m), L - (Number(m.on_loan_now) || 0)) };
  });
  const found = plan.filter(p => p.k <= 0);
  const whole = plan.filter(p => p.k > 0 && p.k >= p.L);   // липсва целият запис
  const part = plan.filter(p => p.k > 0 && p.k < p.L);     // липсват k от L бройки
  const legacy = whole.filter(p => p.L > 1);
  const ids = whole.map(p => p.m.book_id);
  for (const { m } of found) {
    toast('Инв. № ' + m.inv_number + ' е в протокола като липсващ, но сега е у читател — значи е намерен. '
      + 'Не влиза в проекта за акт.', 'warn');
  }
  for (const p of part.filter(p => p.k < p.q)) {
    toast('Инв. № ' + p.m.inv_number + ': по протокола липсват ' + p.q + ', но ' + (p.q - p.k)
      + ' от тях вече са у читател — в проекта влизат ' + p.k + '.', 'warn');
  }
  if (legacy.length || part.length) {
    const ok = await askConfirm('Сред липсващите има стари записи с няколко екземпляра под един инвентарен номер ('
      + legacy.map(p => 'инв. № ' + p.m.inv_number + ' × ' + p.L).concat(
        part.map(p => 'инв. № ' + p.m.inv_number + ' — липсват ' + p.k + ' от ' + p.L)).join(', ') + '). '
      + 'Актът описва всеки отчислен екземпляр поотделно, с неговия номер. Програмата ще даде на всеки '
      + 'липсващ екземпляр свой инвентарен номер и ще включи в проекта само тях'
      + (part.length ? ' — намерените и заетите бройки остават под стария номер' : '') + '. '
      + 'Бройката и стойността не се променят. Да продължа?', { okLabel: 'Раздели и състави проекта' });
    if (!ok) return;
    /* ЕДНА транзакция за ВСИЧКИ записи (books:splitCopiesBatch, поправка след
       прегледа на кръга). Дотук всеки запис се разделяше с отделна IPC заявка:
       ако вторият откажеше (например се появят нови заемания по него между
       приключването на проверката и съставянето на проекта — нищо в програмата
       не пречи на заемане на „липсващ“ документ), първият вече беше разделен и
       ЗАПИСАН ТРАЙНО, а проектът така и не се съставяше. При повторен опит
       снимката на липсата още сочи старата бройка, разделеният вече запис минава
       по пътя „вече е разделен“ по-долу — и новите му номера отпадат от проекта
       БЕЗ следа: точно документите, за които актът по чл. 30, т. 6 съществува,
       изчезваха от него, а екранът твърдеше „проект от N липсващи документа“ с
       по-малко N от истинското. Сега или се разделят всички поискани записи,
       или (при истинска грешка по кой да е от тях) нито един — вече разделен
       запис не е грешка, той просто се прескача. */
    const r = await window.api.books.splitCopiesBatch(legacy.map(p => p.m.book_id)
      .concat(part.map(p => ({ id: p.m.book_id, missing: p.k, date: s.date }))));
    if (!r || !r.ok) return toast((r && r.error) || 'Записите не можаха да бъдат разделени.', 'err');
    for (const res of r.data.results) ids.push(...(res.createdIds || []));
    /* Вече разделен запис (например от „Проверка на данните“ след
       приключването) не е грешка: екземплярите му вече имат свои номера, но
       програмата не може да знае кои от тях липсват — затова в проекта остава
       само номерът от протокола и това се казва на глас. */
    for (const sk of r.data.skipped) {
      toast('Инв. № ' + sk.inv_number + ' вече е разделен на отделни записи — в проекта влиза само той. '
        + 'Добавете в проекта и останалите липсващи екземпляри по новите им номера.', 'warn');
    }
  }
  if (!ids.length) return toast('Всички липси от протокола вече са намерени — няма какво да влезе в проект за акт.', 'warn');
  const id = await call(window.api.deaccessionActs.saveDraft({
    draft: {
      date: today(), reason_code: 6,
      reason_text: (PRICHINI.find(p => p.k == 6) || {}).t || 'липсващи при инвентаризация',
      order_no: s.order_no || null,
      /* ПРЕПРАТКАТА СОЧИ ДОКУМЕНТА, А НЕ РЕДА В ТАБЛИЦАТА (v2.4.65).
         =================================================================
         ЗАВАРЕНОТО. Тук се вписваше „Съставен от протокол за инвентаризация
         № ' + sessionId“ — вътрешният `inventory_sessions.id`, — а датата се
         вземаше от `s.date_end`, колона, която НЕ СЪЩЕСТВУВА в db/schema.sql.
         Тоест датата не се печаташе никога, а номерът беше на реда в базата.

         ЗАЩО БЕШЕ ГРЕШНО. Самият протокол излиза от принтера със заглавие
         „ПРОТОКОЛ № 7 / 2026 / 22.09.2026“ (виж printInventProtocol по-долу:
         номерът е `s.no`, годината `s.year`, датата `s.date`). Актът по чл. 30,
         т. 6 препращаше към „протокол № 1“ и двата листа нямаха нито едно общо
         число. Това е ЕДИНСТВЕНАТА връзка между акта по чл. 30, т. 6 и
         протокола по чл. 40: проверяващият тръгва от подписания акт и трябва
         да намери протокола, който го поражда. Номерът на реда в базата не се
         вижда никъде на хартия и не значи нищо извън програмата. Бележката в
         handlers/deaccession-acts.js обещава точно обратното („Съставен от
         протокол за инвентаризация № 3 от 12.05.2026 г.“).

         ЗАЩО ПОПРАВКАТА Е ТОЧНО ТАЗИ. Пише се същото, което пише на самия
         протокол: № / година и датата на проверката (`s.date` — деня на
         заседанието на комисията, същият, който стои в заглавието на листа).
         Протокол без номер (стара сесия, започната преди номерирането) не се
         преструва на номериран: тогава остава само датата, а ако няма и нея —
         вътрешният номер, изрично назован като такъв, за да не бъде объркан
         с номер на документ. */
      note: (() => {
        const kogato = s.date ? ' от ' + bg(s.date) + ' г.' : '';
        return s.no
          ? 'Съставен от протокол за инвентаризация № ' + s.no + (s.year ? ' / ' + s.year : '') + kogato
          : (s.date
              ? 'Съставен от протокол за инвентаризация' + kogato + ' (протоколът е без номер)'
              : 'Съставен от протокол за инвентаризация (вътрешен № ' + sessionId + ' — протоколът е без номер и дата)');
      })(),
      committee1: s.committee1 || null, committee2: s.committee2 || null, committee3: s.committee3 || null
    },
    bookIds: ids
  }));
  if (id) {
    closeModal(); markSaved();
    toast('Проект № ' + id + ' е съставен от ' + ids.length
      + (ids.length === 1 ? ' липсващ документ' : ' липсващи документа')
      + '. Прегледайте го в „Отчисляване“ и го утвърдете там.', 'ok');
    go('acts');
  }
}
window.draftFromMissing = draftFromMissing;


/* ПРОТОКОЛ ОТ ИНВЕНТАРИЗАЦИЯ (чл. 40).

   Одит v2.4.16, домейн проверка: и двата бутона в този екран се казваха
   „Приключи и състави протокол“, а такъв документ никъде не се съставяше — от 22
   разпечатки в програмата нито една не беше този протокол. Всички данни се
   събираха (комисия, обхват, вид на проверката, сканирани, липсващи), но не
   стигаха до подписваема страница: инвентаризацията по чл. 40 е основна точка
   при проверка, а протоколът с подписите на комисията е това, което се предава.
   Библиотекарят трябваше да го преписва на ръка от екрана. */
/* „КАКВО Е ПРОВЕРЯВАНО“ БЕЗ ПРОТИВОРЕЧИЕ (v2.4.71, находка И3).
   Заварени проверки за един отдел носят в scope непипнатото „целият фонд“ и
   протоколът печаташе „целият фонд · отдел „за деца““ — два обхвата на един
   ред. Сега: отдел при „целият фонд“/празно поле → само „отдел „…““; текст,
   написан от човек, остава и отделът се дописва, освен ако вече е назован. */
function inventScopeText(s) {
  const scope = String((s && s.scope) || '').trim();
  const dep = s && s.department;
  if (!dep) return esc(scope || 'целият фонд');
  const depText = 'отдел „' + dep + '“';
  if (!scope || scope === 'целият фонд' || scope === depText) return esc(depText);
  return esc(scope) + ' · ' + esc(depText);
}
async function printInventProtocol(id) {
  const s = await call(window.api.inventorySessions.get(id));
  if (!s) return;
  const st = SETTINGS_CACHE || {};
  /* ПРОВЕРЕНИТЕ КЪМ ПРИКЛЮЧВАНЕТО, не броят сканирания — по същата причина като
     pool_final точно отдолу: обхватът се смята наново при приключване, а документ,
     отчислен или преместен в друг отдел, докато проверката тече, излиза от него.
     Печатаният брой сканирания правеше протокола несъбираем: „в обхвата 9 ·
     проверени 6 · липсващи 4“. Стари сесии нямат снимка и падат обратно. */
  const scanned = s.scanned_final != null ? s.scanned_final : invQtySum(s.scans);
  /* ПРОТОКОЛЪТ БРОИ БИБЛИОТЕЧНИ ДОКУМЕНТИ (v2.4.61).
     =====================================================================
     Дотук този лист броеше РЕДОВЕ и събираше ЕДИНИЧНИ цени. Актът по чл. 30,
     т. 6, съставен от същите тези липси (бутонът „Проект за акт от липсите“),
     брои документи и сумира цена × бройка. Върху заварен запис с 3 екземпляра
     по 4.00 € и още един документ за 3.50 € двата листа излизаха така:

       протокол : „Липсващи: 3 … ОБЩО 3 документа — 16.50 €“
       акт      : „4 библиотечни документа … 15.50 €“

     Числата не си приличат по нищо, а описват едно и също събитие. И чл. 40 –
     41, и чл. 13/чл. 16 броят библиотечни ДОКУМЕНТИ — виж db/fund-sql.js.
     Затова: бройката идва от handler-а (COALESCE(inventory.quantity, 1)),
     стойността е Σ(единична цена × бройка), закръглена до цент при СЪБИРАНЕТО
     (иначе редът ОБЩО не съвпада със сбора на собствените си редове), а
     клетката с цената носи означението „бройка × цена“ — точно както
     actQtyMark() в акта, за да се четат двата документа еднакво. */
  const mQtyMark = (m) => invQty(m) !== 1 ? invQty(m) + ' × ' : '';
  const missing = invQtySum(s.missing);
  const missingRows = s.missing.length;
  const missingValue = Math.round(
    s.missing.reduce((n, m) => n + (Number(m.price) || 0) * invQty(m), 0) * 100) / 100;
  /* ПУЛЪТ КЪМ ПРИКЛЮЧВАНЕТО, не снимката от започването. Одит на документите
     v2.4.17: печаташе се pool_size — числото, снето при започването — докато
     липсващите се смятат от пула НАЖИВО при приключване. Книга, вписана докато
     проверката тече (напълно нормално), влиза в липсващите и не влиза в обхвата,
     тоест протоколът можеше да гласи „в обхвата 10 · проверени 10 · липсващи 30“.
     Старите сесии нямат записано pool_final и падат обратно към pool_size. */
  const pool = s.pool_final != null ? s.pool_final : (s.pool_size || 0);
  const onLoan = s.on_loan;
  // Одит v2.4.24 — виж at_binder в db/schema.sql. Старите сесии нямат снимка (NULL)
  // и редът просто не се отпечатва, вместо да се твърди „0 за реставрация“.
  const atBinder = s.at_binder;
  /* Изгубените от ползватели преди проверката (v2.4.65) — изведени от снимките
     в inventorySessions:get, не прочетени наживо: виж бележката там за това
     защо вече отпечатан протокол не бива да се променя със задна дата. */
  const lostBefore = s.lostBefore;
  /* Видът има ТРИ състояния, не две. Сесия отпреди v2.3.0 няма записан вид и
     старият тернар я пращаше в клона „пълна“ — тоест протоколът удостоверяваше
     пълна инвентаризация, каквато никой не е обявявал. Списъкът на екрана нарочно
     отказва да твърди вид за такива сесии („вид: —“); документът трябва да прави
     същото. */
  const vid = s.mode === 'full' ? 'пълна инвентаризация (чл. 40, т. 1)'
    : s.mode === 'representative' ? 'инвентаризация по представителния метод (чл. 40, т. 2)'
    : 'инвентаризация';
  const zakl = s.mode === 'representative'
    ? 'Проверката е представителна по смисъла на чл. 40, т. 2 — протоколът важи за проверените документи; '
      + 'непроверените остават с непроменен статус и влизат в следваща проверка.'
    : s.mode === 'full'
      ? 'Проверката е пълна — непроверените и незаети документи са отбелязани като липсващи.'
      : 'Видът на проверката не е записан (проверка отпреди версия 2.3.0 на програмата) — '
        + 'протоколът не удостоверява нито пълна, нито представителна инвентаризация.';
  const nomer = s.no ? '№ ' + s.no + (s.year ? ' / ' + esc(s.year) : '') : '№ …………';
  const allowed = Number(s.allowedLoss);
  const over = Number.isFinite(allowed) ? Math.max(0, missing - allowed) : null;
  setPrintPage({ name: `Протокол ${s.no || ''}-${s.year || yr(s.date)} от инвентаризация`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ПРОТОКОЛ ${nomer} / ${bg(s.date)}<br><span style="font-size:12pt">от извършена инвентаризация на библиотечния фонд</span></h2>
    <div class="pmeta">Днес, ${bg(s.date)} г., комисия, назначена със заповед ${s.order_no ? '№ ' + esc(s.order_no) : '№ …………'} на
    ${esc(st.director_role || 'ръководителя')} на ${esc(st.org || '')}, в състав:<br>
    1. ${esc(s.committee1 || '…………………')} &nbsp; 2. ${esc(s.committee2 || '…………………')} &nbsp; 3. ${esc(s.committee3 || '…………………')}<br><br>
    извърши <b>${vid}</b> на библиотечния фонд на ${esc(st.org || '')}${st.lib_name ? ', ' + esc(st.lib_name) : ''}
    на основание <b>чл. 40</b> от Наредба № 3 от 18.11.2014 г.<br>
    <b>Какво е проверявано:</b> ${inventScopeText(s)}<br>
    <b>Документи в обхвата:</b> ${pool} &nbsp; <b>Проверени документи:</b> ${scanned}
    &nbsp; <b>Липсващи:</b> ${missing}${onLoan != null && onLoan > 0
      ? `<br><b>Заети от читатели към деня на проверката:</b> ${onLoan} — не се проверяват на място и не се смятат за липсващи.` : ''}${
      atBinder != null && atBinder > 0
      ? `<br><b>За реставрация към деня на проверката:</b> ${atBinder} — при подвързвача, не се проверяват на място и не се смятат за липсващи.` : ''}${
      /* СОБСТВЕН РЕД ЗА ИЗГУБЕНИТЕ ОТ ПОЛЗВАТЕЛИ (v2.4.65).
         Дотук такъв документ влизаше в реда „Липсващи“ и в таблицата под него —
         тоест подписаният протокол по чл. 40 обявяваше като установена при
         проверката липса документ, чиято съдба е уредена с читателя месеци
         по-рано (обезщетението е начислено). Оттам следваха и двете по-тежки
         последици: числото се сравняваше с норматива по чл. 41, а „Проект за
         акт от липсите“ предлагаше чл. 30, т. 6 вместо вярната т. 5. Сега те
         се извиняват отделно (виж handlers/inventory-sessions.js) и листът го
         КАЗВА — иначе петте числа не биха се събрали до обхвата и разликата би
         изглеждала като необяснима дупка. Старите протоколи нямат такова число
         (lostBefore е null или 0) и редът просто не се печата. */''
      }${lostBefore ? `<br><b>Изгубени от ползватели, установени преди проверката:</b> ${lostBefore} —
      приключени с обезщетение по чл. 43, не се проверяват на място, не са липси по чл. 40 и се отчисляват
      с акт по чл. 30, т. 5.` : ''}${
      /* ДВА НОВИ РЕДА (v2.4.71, находки М1 и И1). Документ, изпратен на друга
         библиотека по МЗС, и документ, вписан, докато проверката тече, дотук
         влизаха в „Липсващи“ и в таблицата под тях — подписаният протокол ги
         обявяваше за установени липси и ги сравняваше с норматива по чл. 41.
         Сега приключването ги отделя (handlers/inventory-sessions.js,
         classifySession) и листът ги НАЗОВАВА, за да се събере равенството:
         в обхвата = проверени + заети + при партньора по МЗС + за реставрация
         + изгубени + постъпили след началото + липсващи. Старите протоколи нямат
         тези снимки (NULL) и редовете просто не се печатат. */''
      }${s.mzsAway ? `<br><b>При други библиотеки по междубиблиотечно заемане (МЗС) към деня на проверката:</b> ${s.mzsAway} —
      изпратени по входящи заявки, не се проверяват на място и не се смятат за липсващи.` : ''}${
      s.addedLate ? `<br><b>Постъпили след началото на проверката:</b> ${s.addedLate} — вписани в инвентарната книга,
      докато проверката е текла, и несканирани; не са били във фонда при започването и не се смятат за липсващи.` : ''}</div>
    ${missing ? `<table><thead><tr><th>№</th><th>Инв. №</th><th>Автор и заглавие</th>${
      /* Колоната „Бр.“ излиза САМО когато някой ред носи бройка, различна от
         един документ — по същото правило като в акта (showQty там). При
         редовни данни един инвентарен номер е един екземпляр и колоната би
         била константа 1; при заварен неразделен запис без нея документът се
         сумира на едно число, а твърди друго. */''
      }${missing !== missingRows ? '<th>Бр.</th>' : ''}<th>Стойност, € / лв.</th></tr></thead><tbody>
    ${s.missing.map((m, n) => `<tr><td>${n + 1}</td><td>${m.inv_number ?? ''}</td>
      <td>${esc(authorTitleText(m.author, m.title))}</td>${
      missing !== missingRows ? `<td>${invQty(m)}</td>` : ''}<td>${
      m.price == null ? '—' : mQtyMark(m) + mny(m.price)}</td></tr>`).join('')}
    <tr><td colspan="${missing !== missingRows ? 4 : 3}"><b>ОБЩО ${missing} ${missing === 1 ? 'документ' : 'документа'}${
      missing !== missingRows ? ` (${missingRows} ${missingRows === 1 ? 'инвентарен номер' : 'инвентарни номера'})` : ''
      }</b></td><td><b>${mny(missingValue)}</b></td></tr>
    </tbody></table>`
    : '<div class="pmeta">При проверката не са установени липсващи документи.</div>'}
    ${Number.isFinite(allowed) ? `<div class="pmeta">
      ${/* „за проверен фонд от 13 798“ при проверени 502 (v2.4.69, находка О4): числото
            е обхватът (pool_final — от него handler-ът смята норматива по чл. 41), а
            думата „проверен“ го приписваше на проверените. На подписан лист двете
            числа стояха едно до друго и си противоречаха. Думите вече казват какво е. */''}
      <b>Допустими естествени загуби (чл. 41):</b> ${lossFmt(allowed)} документа за фонда в обхвата на проверката
      (${pool} ${pool === 1 ? 'документ' : 'документа'}).<br>
      ${missing === 0 ? 'Липси не са установени.'
        : over > 0
          ? `Установените липси надвишават норматива с <b>${lossFmt(over)}</b> документа — прилага се редът по чл. 51 – 53.`
          : 'Установените липси са в рамките на допустимите естествени загуби.'}</div>` : ''}
    <div class="pmeta">${zakl}<br>
    Протоколът се съставя в два екземпляра — по един за счетоводството и за библиотеката.</div>
    ${/* Комисията — всеки член на своя линия, с имената от проверката (v2.4.69, Е5). */''}
    ${commissionSig([s.committee1, s.committee2, s.committee3])}
    ${ssig([approverLine(st.director_role || 'Ръководител', s.director)])}</div>`);
}
window.printInventProtocol = printInventProtocol;
