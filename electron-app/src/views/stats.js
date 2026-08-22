/* ---------------- Справки и статистика ---------------- */
let STATS_YEAR = null;
async function renderStats() {
  const y = STATS_YEAR || yr();
  const r = await call(window.api.stats.report(y));
  if (!r) return;
  // Скалата е спрямо най-голямата стойност в групата, а не спрямо целия фонд — иначе при
  // разпределение като „98% български“ всички останали ленти са невидими черти.
  const bars = (data, tot, cls) => {
    if (!data || !data.length) return '<span class="hint">няма данни</span>';
    const max = Math.max(...data.map(([, v]) => v)) || 1;
    return data.map(([k, v]) => `
      <div class="chartRow">
        <div class="cr-top"><span class="cr-k">${esc(k)}</span>
          <span class="cr-v"><b>${v}</b> · ${tot ? Math.round(v / tot * 100) : 0}%</span></div>
        <div class="chartTrack"><div class="chartFill ${cls || ''}" style="width:${Math.max(2, v / max * 100)}%"></div></div>
      </div>`).join('');
  };
  const totalReturned = r.returnedOnTime + r.returnedLate;
  const onTimePct = totalReturned ? Math.round(r.returnedOnTime / totalReturned * 100) : 0;
  $('#view').innerHTML = `
    <div class="toolbar">
      <select onchange="STATS_YEAR=this.value;renderStats()">
        ${/* текущата и няколко назад — годишният отчет се прави за минала година */
          yearOptions(y).map(x => `<option ${x === y ? 'selected' : ''}>${x}</option>`).join('')}
      </select>
      <span class="hint">отчетен период 01.01.${y} – 31.12.${y}</span>
      <span style="flex:1"></span>
      <button class="btn sm" onclick="addVisits()">Впиши посещения</button>
    </div>

    <div class="kpis" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi-ico">📚</div><div class="kpi-body">
        <div class="kpi-num">${r.fundCount.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Библиотечен фонд</div><div class="kpi-extra">${mny(r.fundValue)}</div></div></div>
      <div class="kpi"><div class="kpi-ico">👥</div><div class="kpi-body">
        <div class="kpi-num">${r.readersCount.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Регистрирани читатели</div><div class="kpi-extra">през ${y} г.</div></div></div>
      <div class="kpi"><div class="kpi-ico">🔄</div><div class="kpi-body">
        <div class="kpi-num">${r.loansCount.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Заемания</div><div class="kpi-extra">през ${y} г.</div></div></div>
      <div class="kpi"><div class="kpi-ico">🚪</div><div class="kpi-body">
        <div class="kpi-num">${r.visits.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Посещения</div><div class="kpi-extra">${r.visitsRecorded
          ? 'БДС ISO 2789'
          : '<b>не са вписвани</b> — вижте „Впиши посещения“ по-долу'}</div></div></div>
    </div>

    <div class="grid g3">
      <div class="card"><h3 style="margin-top:0">Фонд по езици</h3>${bars(r.fundByLanguage, r.fundCount)}</div>
      <div class="card"><h3 style="margin-top:0">Фонд по отдели</h3>${bars(r.fundByDepartment, r.fundCount)}</div>
      <div class="card"><h3 style="margin-top:0">Фонд по категории</h3>${bars(r.fundByCategory, r.fundCount)}</div>
    </div>

    <div class="grid g3" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Движение на фонда през ${y}</h3>
        <div class="chartRow">
          <div class="cr-top"><span class="cr-k">Постъпили</span>
            <span class="cr-v"><b style="color:var(--green)">+${r.acquiredCount}</b> · ${mny(r.acquiredValue)}</span></div>
          <div class="chartTrack"><div class="chartFill g" style="width:${r.fundCount ? Math.min(100, Math.max(2, r.acquiredCount / r.fundCount * 100)) : 0}%"></div></div>
        </div>
        <div class="chartRow">
          <div class="cr-top"><span class="cr-k">Отчислени</span>
            <span class="cr-v"><b style="color:var(--red)">−${r.deaccessionedCount}</b> · ${mny(r.deaccessionedValue)}</span></div>
          <div class="chartTrack"><div class="chartFill r" style="width:${r.fundCount ? Math.min(100, Math.max(2, r.deaccessionedCount / r.fundCount * 100)) : 0}%"></div></div>
        </div>
        <hr style="border:0;border-top:1px solid var(--rule);margin:12px 0 10px">
        <div class="statRows">
          <div><span>Чист прираст</span><b style="color:${r.acquiredCount - r.deaccessionedCount >= 0 ? 'var(--green)' : 'var(--red)'}">
            ${r.acquiredCount - r.deaccessionedCount >= 0 ? '+' : ''}${r.acquiredCount - r.deaccessionedCount}</b></div>
        </div>
      </div>

      <div class="card"><h3 style="margin-top:0">Спазване на сроковете</h3>
        ${totalReturned ? `
          ${ringSvg(onTimePct)}
          <div class="statRows" style="margin-top:12px">
            <div><span>Върнати в срок</span><b style="color:var(--green)">${r.returnedOnTime}</b></div>
            <div><span>Върнати със забава</span><b style="color:var(--red)">${r.returnedLate}</b></div>
            <div><span>Начислени обезщетения</span><b>${mny(r.finesCharged || 0)}</b></div>
            <div><span>Събрани обезщетения</span><b>${mny(r.finesCollected || 0)}</b></div>
          </div>
          <div class="hint" style="margin-top:8px">Броят се връщанията <b>през</b> отчетната
          година, независимо кога е заета книгата. „Начислени“ е сумата, начислена при
          връщането; „събрани“ — реално платеното от читателя на касата.</div>`
        : '<span class="hint">Няма върнати документи през периода.</span>'}
      </div>

      <div class="card"><h3 style="margin-top:0">Най-търсени документи</h3>
        ${r.topLoans.length ? r.topLoans.map((t, i) => `<div class="rankRow">
          <span class="rankNo">${i + 1}</span>
          <span class="rankTitle" title="${esc(t.title)}">${esc(t.title)}</span>
          <span class="rankVal">${t.n}</span></div>`).join('')
        : '<span class="hint">няма данни</span>'}
      </div>
    </div>`;
}
/* Пръстеновидна диаграма за процент — чист SVG, без външни библиотеки. */
function ringSvg(pct, label) {
  const R = 34, C = 2 * Math.PI * R;
  const on = Math.max(0, Math.min(100, pct));
  const col = on >= 90 ? 'var(--green)' : on >= 70 ? 'var(--brass)' : 'var(--red)';
  return `<div class="ring">
    <svg class="ringSvg" width="86" height="86" viewBox="0 0 86 86">
      <circle cx="43" cy="43" r="${R}" fill="none" stroke="var(--paper3)" stroke-width="10"/>
      <circle cx="43" cy="43" r="${R}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${(C * on / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 43 43)"/>
      <text x="43" y="48" text-anchor="middle" font-size="18" font-weight="700" fill="var(--brassD)"
        font-family="Georgia,serif">${on}%</text>
    </svg>
    <div class="ringTxt"><div class="rt-n">${on}%</div>
      <div class="rt-l">${esc(label || 'върнати в срок')}</div></div>
  </div>`;
}
function addVisits() {
  modal('Вписване на посещения', `
    <form id="vsF" onsubmit="return false">${fld('Дата', 'date', { val: today(), type: 'date' })}${fld('Брой посещения', 'count', { type: 'number' })}</form>
    <div class="hint">Дневникът на посещенията се води за годишния статистически отчет (БДС ISO 2789).</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button><button class="btn pri" onclick="saveVisits()">Впиши</button>`);
}
window.addVisits = addVisits;
async function saveVisits() {
  const d = formData('#vsF');
  if (!d.count) return;
  // Затваря се само при успех (v2.2.0) — при отказан запис въведените дата и
  // брой остават на екрана.
  if (await call(window.api.visits.add(d), 'Посещенията са вписани.') === null) return;
  closeModal(); renderStats();
}
window.saveVisits = saveVisits;
