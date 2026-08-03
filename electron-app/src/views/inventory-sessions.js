/* ---------------- Инвентаризация ---------------- */
let INVENT_SESSION = null;
async function renderInvent() {
  if (INVENT_SESSION) return renderInventRun();
  const [req, sessions] = await Promise.all([call(window.api.inventorySessions.requirement()), call(window.api.inventorySessions.list())]);
  if (!req) return;
  // Напредъкът за годината: колко от изисквания обхват вече е обхванат от приключените проверки.
  const thisYear = yr();
  const yearSessions = (sessions || []).filter(s => (s.date || '').slice(0, 4) === thisYear);
  const scannedYear = yearSessions.reduce((n, s) => n + (s.scanned || 0), 0);
  const pct = req.target ? Math.min(100, Math.round(scannedYear / req.target * 100)) : 0;
  $('#view').innerHTML = `
    <div class="note"><b>Чл. 40, т. 2</b> — инвентаризация по репрезентативния метод се извършва ежегодно върху
    не по-малко от <b>${req.pct}%</b> от фонда.</div>

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
          <div><span>Библиотечен фонд</span><b>${req.active.toLocaleString('bg-BG')}</b></div>
          <div><span>Изискван процент</span><b>${req.pct}%</b></div>
          <div><span>Допустими загуби</span><b>${req.naturalLoss.toFixed(1)}</b></div>
        </div>
        <div class="hint" style="margin-top:10px">Допустимите загуби по чл. 41 се изчисляват спрямо фонда
        и дела на свободния достъп.</div>
      </div>
    </div>

    <div class="toolbar">
      <button class="btn pri" onclick="startInventForm()">Започни нова проверка</button>
      <button class="btn" onclick="mobileHelp()">📱 Сканиране с телефон</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Дата</th><th>Обхват</th><th>В обхвата</th>
      <th>Проверени</th><th>Липсващи</th><th>Комисия</th><th>Състояние</th></tr></thead><tbody>
    ${sessions.length ? sessions.map(s => {
      const sp = s.pool_size ? Math.min(100, Math.round((s.scanned || 0) / s.pool_size * 100)) : 0;
      return `<tr><td class="num">${bg(s.date)}</td><td>${esc(s.scope || '')}</td>
      <td class="num">${s.pool_size}</td>
      <td><div style="display:flex;align-items:center;gap:8px">
        <b class="num">${s.scanned || 0}</b>
        <div class="chartTrack" style="flex:1;min-width:60px;height:7px"><div class="chartFill" style="width:${sp}%"></div></div>
        <span class="hint">${sp}%</span></div></td>
      <td class="num">${s.closed ? `<b style="color:${s.missing ? 'var(--red)' : 'var(--green)'}">${s.missing || 0}</b>` : '<span class="hint">—</span>'}</td>
      <td style="font-size:12px">${[s.committee1, s.committee2, s.committee3].filter(Boolean).map(esc).join(', ')}</td>
      <td>${s.closed ? '<span class="badge ok">приключена</span>' : '<span class="badge warn">отворена</span>'}</td></tr>`;
    }).join('')
      : `<tr><td colspan="7" class="empty">Няма извършени проверки.</td></tr>`}
    </tbody></table></div>`;
}
function startInventForm() {
  modal('Нова инвентаризация', `
    <form id="ivF" onsubmit="return false">
      ${fld('Дата', 'date', { val: today(), type: 'date' })}
      ${fld('Обхват на проверката', 'scope', { val: 'репрезентативен метод' })}
      <div class="grid g3">${fld('Комисия 1', 'committee1', {})}${fld('Комисия 2', 'committee2', {})}${fld('Комисия 3', 'committee3', {})}</div>
      ${fld('Ограничи до отдел', 'department', { type: 'select', opts: OTDELI, emptyLabel: '— целият фонд —' })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="beginInvent()">Започни сканиране</button>`);
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
async function renderInventRun() {
  const s = await call(window.api.inventorySessions.get(INVENT_SESSION.id));
  const found = s.scans.length, pool = s.pool_size || 0;
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
      <div id="ivLog" style="margin-top:10px;max-height:230px;overflow:auto"></div>
    </div>
    <div class="toolbar">
      <button class="btn" onclick="importScansModal(${s.id})">📱 Внеси сканирания от телефон</button>
      <button class="btn pri" onclick="closeInvent()">Приключи и състави протокол</button>
      <button class="btn" onclick="if(confirm('Прекратяване без запис?')){INVENT_SESSION=null;renderInvent()}">Прекрати</button>
    </div>`;
  const el = $('#ivScan'); el.focus();
  let scanned = found;
  el.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = el.value.trim(); el.value = ''; if (!code) return;
    const res = await window.api.inventorySessions.scan({ sessionId: INVENT_SESSION.id, code });
    const log = $('#ivLog');
    if (!res.ok) {
      log.insertAdjacentHTML('afterbegin', `<div class="scanlog err">${esc(res.error)}</div>`);
      return;
    }
    log.insertAdjacentHTML('afterbegin',
      `<div class="scanlog ok"><b>${res.data.inv_number}</b> — ${esc(res.data.title)}</div>`);
    markSaved();
    // Броячите се обновяват на място. Пълно пречертаване тук би изтрило дневника
    // на сканиранията, който току-що беше допълнен.
    scanned++;
    const nLeft = Math.max(0, pool - scanned);
    const nPct = pool ? Math.min(100, Math.round(scanned / pool * 100)) : 0;
    const f = $('#ivFound'), l = $('#ivLeft'), rg = $('#ivRing');
    if (f) f.textContent = scanned.toLocaleString('bg-BG');
    if (l) l.textContent = nLeft.toLocaleString('bg-BG');
    if (rg) rg.innerHTML = ringSvg(nPct, 'проверени от обхвата');
  });
}
async function closeInvent() {
  const res = await window.api.inventorySessions.close(INVENT_SESSION.id);
  if (!res.ok) return toast(res.error, 'err');
  markSaved();
  const r = res.data;
  INVENT_SESSION = null;
  const over = Math.max(0, r.missing - r.allowedLoss);
  modal('Инвентаризацията е приключена', `
    <div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="num">${r.scanned}</div><div class="lbl">Проверени</div></div>
      <div class="card"><div class="num">${r.missing}</div><div class="lbl">Липсващи</div></div>
      <div class="card"><div class="num">${r.allowedLoss.toFixed(1)}</div><div class="lbl">Допустими</div></div>
    </div>
    ${over > 0
      ? `<div class="note d">Липсите надвишават нормативите за естествени загуби с ${over.toFixed(1)} документа (чл. 51 – 53).</div>`
      : `<div class="note">Липсите са в рамките на допустимите естествени загуби (чл. 41, ал. 1).</div>`}
    <p style="font-size:13px">Липсващите документи са отбелязани със статус „липсващ“. Отчислете ги с акт по
    <b>чл. 30, т. 6</b>, ако е приложимо.</p>`,
    `<button class="btn pri" onclick="closeModal()">Затвори</button>`);
  renderInvent();
}
window.closeInvent = closeInvent;
