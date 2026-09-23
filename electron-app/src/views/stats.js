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
      <div class="kpi"><div class="kpi-ico">${KPI_ICONS.fund}</div><div class="kpi-body">
        <div class="kpi-num">${r.fundCount.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Библиотечен фонд</div><div class="kpi-extra">${mny(r.fundValue)}</div></div></div>
      <div class="kpi"><div class="kpi-ico">${KPI_ICONS.readers}</div><div class="kpi-body">
        <div class="kpi-num">${r.readersCount.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Регистрирани читатели</div><div class="kpi-extra">през ${y} г.</div></div></div>
      <div class="kpi"><div class="kpi-ico">${KPI_ICONS.loans}</div><div class="kpi-body">
        <div class="kpi-num">${r.loansCount.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Заемания</div><div class="kpi-extra">през ${y} г.</div></div></div>
      ${/* ЧЕСТЕН НАДПИС КОЕ ЧИСЛО ОТКЪДЕ ИДВА (одит v2.4.65, находка Б18).
           =====================================================================
           Посещенията се водят на ДВЕ несвързани места и двете влизат в
           отчетността: таблицата `visits` („Впиши посещения“, показателят тук) и
           Раздел А на Дневника (`dnevnik_days.a_visit_*`, официалният формуляр,
           който отива към регионалната библиотека). Измерено: този показател
           показваше 40, а годишният отчет А/Б — 52 за същата година, и нищо на
           екрана не казваше, че са две различни неща. Надписът „не са вписвани“
           излизаше и когато Дневникът е воден изрядно цяла година.
           Показателят продължава да брои СВОЯ източник — подменянето му с
           Дневника би било третото различно число под същия надпис, — но вече
           го назовава, а съгласуването стои непосредствено под него. */''}
      <div class="kpi"><div class="kpi-ico">${KPI_ICONS.visits}</div><div class="kpi-body">
        <div class="kpi-num">${r.visits.toLocaleString('bg-BG')}</div>
        <div class="kpi-lbl">Посещения — „Впиши посещения“</div><div class="kpi-extra">${r.visitsRecorded
          ? 'дневник на посещенията (БДС ISO 2789) · Дневникът на библиотеката се брои отделно'
          : ((r.dnevnikVisits && r.dnevnikVisits.total)
            ? '<b>не са вписвани тук</b> — но Дневникът на библиотеката има ' + r.dnevnikVisits.total
            : '<b>не са вписвани</b> — вижте „Впиши посещения“ по-долу')}</div></div></div>
    </div>

    ${/* Съгласуването се прави както handlers/fund-check.js го прави за фонда:
         двете числа, разликата, причината и какво да се направи. Двата дневника
         НЕ се сливат — автоматичното попълване на Дневника от посещенията и
         заеманията е отложено решение и остава отложено. */''}
    ${statsVisitsCheckHtml(r)}

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
            ${r.openOverdue ? `<div><span>Просрочени в момента (към днес, незавършени)</span><b style="color:var(--red)"><a href="#over">${r.openOverdue}</a></b></div>` : ''}
            ${r.finesOpen ? `<div><span>Начислени по незавършени заемания (към днес)</span><b>${mny(r.finesOpen)}</b></div>` : ''}
          </div>
          <div class="hint" style="margin-top:8px">Броят се връщанията <b>през</b> отчетната
          година, независимо кога е заета книгата. „Начислени“ е сумата, начислена при
          връщането; „събрани“ — реално платеното от читателя на касата.</div>`
        : `<span class="hint">Няма върнати документи през периода.</span>${r.openOverdue
          ? `<div class="statRows" style="margin-top:10px"><div><span>Просрочени в момента (към днес)</span><b style="color:var(--red)"><a href="#over">${r.openOverdue}</a></b></div></div>` : ''}`}
      </div>

      <div class="card"><h3 style="margin-top:0">Най-търсени документи</h3>
        ${r.topLoans.length ? r.topLoans.map((t, i) => `<div class="rankRow">
          <span class="rankNo">${i + 1}</span>
          <span class="rankTitle" title="${esc(t.title)}${t.author ? ' — ' + esc(t.author) : ''}">${esc(t.title)}${t.author ? ` <span class="hint">· ${esc(t.author)}</span>` : ''}</span>
          <span class="rankVal">${t.n}</span></div>`).join('')
        : '<span class="hint">няма данни</span>'}
      </div>
    </div>`;
}
/* СЪГЛАСУВАНЕ НА ДВАТА ДНЕВНИКА ЗА ПОСЕЩЕНИЯ (одит v2.4.65, находка Б18).
   =====================================================================
   Вписаното в „Впиши посещения“ не стига до Раздел А на Дневника и обратно, а и
   двете влизат в отчетността: измерено — 40 тук срещу 52 „в заемна за дома“ в
   годишния отчет А/Б за същата година. Дотук нищо не ги сравняваше и нищо не
   казваше кое число откъде идва. Двете НЕ се сливат (автоматичното попълване на
   Дневника от посещенията и заеманията е отложено решение); тук се прави същото,
   което „Проверка на данните“ прави за фонда — сравнява и обяснява.
   „Деца до 14 г.“ е подмножество на „в заемна за дома“ по формуляра и затова НЕ
   се събира отделно: иначе сборът би броил едно и също дете два пъти. */
function statsVisitsCheckHtml(r) {
  const c = r.visitsCheck, d = r.dnevnikVisits;
  if (!c || !d) return '';
  // Празна година (нито едно посещение никъде) — картата само би шумяла; показателят
  // горе вече казва „не са вписвани“ и сочи бутона.
  if (!c.a.n && !c.b.n) return '';
  const same = c.diff === 0;
  const red = !same && (c.a.n > 0 || c.b.n > 0);
  return `<div class="card" style="margin-bottom:16px${red ? ';border-left:3px solid var(--red)' : ''}">
    <h3 style="margin-top:0">Посещенията се водят на две места</h3>
    <div class="statRows">
      <div><span>${esc(c.a.label)}</span><b>${c.a.n}</b></div>
      <div><span>${esc(c.b.label)}</span><b>${c.b.n}</b></div>
      ${same ? '' : `<div><span>Разлика</span><b style="color:var(--red)">${c.diff > 0 ? '+' : ''}${c.diff}</b></div>`}
    </div>
    <div class="hint" style="margin-top:8px">Дневникът за ${r.year} г. дава: в заемна за дома ${d.home}
      (от тях деца до 14 г. ${d.child} — подмножество, не се събира отделно), в читалня ${d.reading},
      интернет ${d.internet}. ${esc(c.why)}${c.todo ? ' <b>' + esc(c.todo) + '</b>' : ''}</div>
  </div>`;
}
/* Пръстеновидна диаграма за процент — чист SVG, без външни библиотеки.
   opts.color: цветът се задава отвън, когато „добре“ не значи „високо“. Прагът по
   подразбиране (90/70) е верен за „върнати в срок“, но е безсмислен за напредък по
   годишна цел: 8% през януари е в график, а 60% през декември — не. Таблото (v2.4.52)
   подава свой цвят по календара; всичко останало ползва подразбирането, както досега.
   opts.compact: само пръстенът, без надписа отстрани — когато текстът е наоколо. */
function ringSvg(pct, label, opts) {
  const o = opts || {};
  const R = 34, C = 2 * Math.PI * R;
  const on = Math.max(0, Math.min(100, Math.round(pct)));
  const col = o.color || (on >= 90 ? 'var(--green)' : on >= 70 ? 'var(--brass)' : 'var(--red)');
  const svg = `<svg class="ringSvg" width="86" height="86" viewBox="0 0 86 86" role="img"
      aria-label="${esc(String(on))}% ${esc(label || 'върнати в срок')}">
      <circle cx="43" cy="43" r="${R}" fill="none" stroke="var(--paper3)" stroke-width="10"/>
      ${/* При 0% дъгата НЕ се рисува: заоблената шапка на нулева дължина оставя
            точка на дванайсет часа, която прилича на повреда, а не на „още нищо“. */
        on > 0 ? `<circle cx="43" cy="43" r="${R}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${(C * on / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 43 43)"/>` : ''}
      <text x="43" y="48" text-anchor="middle" font-size="18" font-weight="700" fill="var(--brassD)"
        font-family="Georgia,serif">${on}%</text>
    </svg>`;
  if (o.compact) return `<div class="ring ringOnly">${svg}</div>`;
  return `<div class="ring">${svg}
    <div class="ringTxt"><div class="rt-n">${on}%</div>
      <div class="rt-l">${esc(label || 'върнати в срок')}</div></div>
  </div>`;
}
/* Одит v2.4.25: формата казва, че броят се ДОБАВЯ към вече вписаното за деня, и
   показва колко е то; отметката „замени“ е изходът за сгрешено число (дотук 50
   вместо 5 се поправяше само с −45). Датата е задължителна — виж handlers/visits.js. */
function addVisits() {
  modal('Вписване на посещения', `
    <form id="vsF" onsubmit="return false">
      ${fld('Дата', 'date', { val: today(), type: 'date', req: 1, onchange: 'visitsDayHint()' })}
      ${fld('Брой посещения', 'count', { type: 'number', min: 0, req: 1,
        hint: 'добавя се към вече вписаното за деня' })}
      <label class="chk"><input type="checkbox" name="replace"> Замени вписаното за деня с това число (поправка)</label>
    </form>
    <div class="hint" id="vsDayHint"></div>
    <div class="hint">Дневникът на посещенията се води за годишния статистически отчет (БДС ISO 2789).</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button><button class="btn pri" onclick="saveVisits()">Впиши</button>`);
  visitsDayHint();
}
window.addVisits = addVisits;
async function visitsDayHint() {
  const el = $('#vsDayHint'); if (!el) return;
  const date = (document.querySelector('#vsF [name=date]') || {}).value;
  if (!date) { el.textContent = ''; return; }
  const n = await call(window.api.visits.get(date));
  if (n === null) return;
  el.textContent = n ? 'Вече вписани за ' + bg(date) + ': ' + n + '.' : 'За ' + bg(date) + ' още няма вписани посещения.';
  el.textContent += ' Раздел А на Дневника за същия ден се води отделно и не се попълва оттук.';
}
window.visitsDayHint = visitsDayHint;
async function saveVisits() {
  const d = formData('#vsF');
  if (!d.date) return toast('Изберете дата.', 'err');
  if (d.count === '' || d.count == null) return toast('Въведете брой посещения.', 'err');
  // Затваря се само при успех (v2.2.0) — при отказан запис въведените дата и
  // брой остават на екрана.
  const r = await call(window.api.visits.add(d));
  if (r === null) return;
  toast('Посещенията са вписани — общо за ' + bg(d.date) + ': ' + r.total + '.', 'ok');
  /* Разминаването с Дневника се казва ВЕДНАГА, на същия ден (находка Б18), а не
     чак в края на годината: двата дневника се водят отделно и вписаното тук не
     стига до Раздел А на официалния формуляр. */
  const dn = r.dnevnik;
  if (dn && dn.recorded && dn.total !== r.total) {
    toast('Дневникът на библиотеката за ' + bg(d.date) + ' има ' + dn.total
      + ' посещения (в заемна за дома ' + dn.home + ', в читалня ' + dn.reading + ', интернет ' + dn.internet
      + '), а тук са ' + r.total + '. Двата дневника се водят отделно — годишният отчет брои Дневника.', 'err');
  }
  closeModal(); renderStats();
}
window.saveVisits = saveVisits;
