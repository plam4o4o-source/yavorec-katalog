/* ---------------- Готови справки ----------------
   Аналог на споделената библиотека готови отчети в Koha — тук нарочно малка и
   фиксирана (виж REPORTS_CATALOG в main.js), защото целта не е конструктор на
   произволни справки, а точно таблиците, които читалищна библиотека реално подава
   към регионалната библиотека/Министерството на културата, готови за печат. */
let REPORT_ID = null, REPORT_YEAR = null;
async function renderReports() {
  const catalog = await call(window.api.reports.list());
  if (!catalog) return;
  const id = REPORT_ID || (catalog[0] && catalog[0].id);
  const y = REPORT_YEAR || yr();
  const def = catalog.find(c => c.id === id);
  $('#view').innerHTML = `
    <div class="toolbar">
      <select id="repSel" onchange="REPORT_ID=this.value;renderReports()">
        ${catalog.map(c => `<option value="${c.id}" ${c.id === id ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}
      </select>
      ${def && def.needsYear ? `<select onchange="REPORT_YEAR=this.value;renderReports()">
        ${[y, yr()].filter((v, i, a) => a.indexOf(v) === i).map(x => `<option ${x === y ? 'selected' : ''}>${x}</option>`).join('')}
      </select>` : ''}
      <span style="flex:1"></span>
      <button class="btn" onclick="printReportDoc()">Печат / PDF</button>
    </div>
    ${def && def.hint ? `<div class="note" style="margin-top:0">${esc(def.hint)}</div>` : ''}
    <div id="repBody">Зареждане…</div>
  `;
  if (!id) return;
  const r = await call(window.api.reports.run({ id, year: y }));
  if (!r) return;
  r.title = def ? def.title : '';
  window._REPORT = r;
  $('#repBody').innerHTML = reportBodyHtml(r);
}
/* Прост построител на редове за таблица от чифтове [етикет, число] или [етикет, брой, стойност]. */
function reportPairTable(rows, valCol) {
  if (!rows.length) return '<span class="hint">няма данни</span>';
  return `<table class="ledger"><tbody>${rows.map(row => {
    const [k, n, v] = row;
    return `<tr><td>${esc(k)}</td><td class="num">${n}</td>${valCol ? `<td class="num">${mny(v || 0)}</td>` : ''}</tr>`;
  }).join('')}</tbody></table>`;
}
function reportBodyHtml(r) {
  if (r.id === 'annual_ab') {
    const rowHtml = (cols) => `<tr><td>За ${r.year} г.</td>${cols.map(([k]) => `<td>${dnevnikCell(r.totals, k)}</td>`).join('')}</tr>`;
    return `
      ${r.daysRecorded ? '' : `<div class="hint" style="margin-bottom:10px">Няма вписани дни в „Дневник“ за ${r.year} г. — справката излиза с нулеви стойности.</div>`}
      <div class="card"><h3 style="margin-top:0">А. Читатели и посещения</h3>
        <div class="wrap"><table class="ledger" style="font-size:11px"><thead><tr><th></th>${DNEVNIK_A_COLS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
        <tbody>${rowHtml(DNEVNIK_A_COLS)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Б. Заети материали</h3>
        <div class="wrap"><table class="ledger" style="font-size:11px"><thead><tr><th></th>${DNEVNIK_B_COLS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
        <tbody>${rowHtml(DNEVNIK_B_COLS)}</tbody></table></div>
      </div>`;
  }
  if (r.id === 'fund_breakdown') {
    return `
      <div class="kpis" style="margin-bottom:16px">${kpi('📚', r.fundCount.toLocaleString('bg-BG'), 'Фонд към 31.12.' + r.year + ' г.', mny(r.fundValue))}</div>
      <div class="grid g3">
        <div class="card"><h3 style="margin-top:0">По отдели</h3>${reportPairTable(r.byDepartment)}</div>
        <div class="card"><h3 style="margin-top:0">По категории</h3>${reportPairTable(r.byCategory)}</div>
        <div class="card"><h3 style="margin-top:0">По езици</h3>${reportPairTable(r.byLanguage)}</div>
      </div>`;
  }
  if (r.id === 'readers_by_category') {
    return `
      <div class="kpis" style="margin-bottom:16px">
        ${kpi('👥', r.total.toLocaleString('bg-BG'), 'Активни читатели')}
        ${kpi('🆕', r.newThisYear.toLocaleString('bg-BG'), 'Новорегистрирани през ' + r.year + ' г.')}
      </div>
      <div class="card"><h3 style="margin-top:0">По категория</h3>${reportPairTable(r.byCategory)}</div>`;
  }
  if (r.id === 'fund_movement') {
    return `
      <div class="grid g2">
        <div class="card"><h3 style="margin-top:0">Постъпили през ${r.year} г. — ${r.acquiredTotal} бр., ${mny(r.acquiredValue)}</h3>
          ${reportPairTable(r.acquired, true)}</div>
        <div class="card"><h3 style="margin-top:0">Отчислени през ${r.year} г. — ${r.deaccessionedTotal} бр., ${mny(r.deaccessionedValue)}</h3>
          ${reportPairTable(r.deaccessioned, true)}</div>
      </div>`;
  }
  if (r.id === 'mzs_annual') {
    return `
      <div class="kpis" style="margin-bottom:16px">${kpi('🤝', r.total.toLocaleString('bg-BG'), 'Заявки за ' + r.year + ' г.')}</div>
      <div class="grid g2">
        <div class="card"><h3 style="margin-top:0">По посока</h3>${reportPairTable(r.byDirection)}</div>
        <div class="card"><h3 style="margin-top:0">По състояние</h3>${reportPairTable(r.byStatus)}</div>
      </div>`;
  }
  if (r.id === 'fees_income') {
    return `
      <div class="kpis" style="margin-bottom:16px">
        ${kpi('💰', mny(r.chargedValue), 'Начислено през ' + r.year + ' г.', r.chargedTotal + ' начисления')}
        ${kpi('✅', mny(r.paidValue), 'Събрано през ' + r.year + ' г.', r.paidCount + ' плащания')}
      </div>
      <div class="card"><h3 style="margin-top:0">Начислено по вид</h3>${reportPairTable(r.charged, true)}</div>`;
  }
  return '<span class="hint">Няма данни.</span>';
}
/* Отделен, по-опростен вариант за печат (плътни таблици вместо картички) — по същия
   принцип като другите официални разпечатки (printKdbfDoc, printDnevnikDoc и т.н.). */
function prTable(headers, rows, valCol) {
  return `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map(row => {
      const [k, n, v] = row;
      return `<tr><td>${esc(k)}</td><td>${n}</td>${valCol ? `<td>${mny(v || 0)}</td>` : ''}</tr>`;
    }).join('') : `<tr><td colspan="${headers.length}">няма данни</td></tr>`}</tbody></table>`;
}
function reportPrintHtml(r) {
  if (r.id === 'annual_ab') {
    const rowHtml = (cols) => `<tr><td>За ${r.year} г.</td>${cols.map(([k]) => `<td>${dnevnikCell(r.totals, k)}</td>`).join('')}</tr>`;
    return `
      <div class="pmeta"><b>А. РЕГИСТРИРАНЕ НА ЧИТАТЕЛИТЕ И ПОСЕЩЕНИЯТА</b></div>
      <table style="font-size:7.5pt"><thead><tr><th></th>${DNEVNIK_A_COLS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
      <tbody>${rowHtml(DNEVNIK_A_COLS)}</tbody></table>
      <div class="pmeta" style="margin-top:6mm"><b>Б. РЕГИСТРИРАНЕ НА ЗАЕТИТЕ КНИГИ, ПЕРИОДИЧНИ ИЗДАНИЯ И ДРУГИ МАТЕРИАЛИ</b></div>
      <table style="font-size:7.5pt"><thead><tr><th></th>${DNEVNIK_B_COLS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
      <tbody>${rowHtml(DNEVNIK_B_COLS)}</tbody></table>`;
  }
  if (r.id === 'fund_breakdown') {
    return `
      <div class="pmeta">Фонд към 31.12.${r.year} г. — общо ${r.fundCount} бр., ${mny(r.fundValue)}</div>
      ${prTable(['Отдел', 'Бр.'], r.byDepartment)}
      ${prTable(['Категория', 'Бр.'], r.byCategory)}
      ${prTable(['Език', 'Бр.'], r.byLanguage)}`;
  }
  if (r.id === 'readers_by_category') {
    return `
      <div class="pmeta">Активни читатели: ${r.total} · новорегистрирани през ${r.year} г.: ${r.newThisYear}</div>
      ${prTable(['Категория', 'Бр.'], r.byCategory)}`;
  }
  if (r.id === 'fund_movement') {
    return `
      <div class="pmeta">Постъпили през ${r.year} г. — ${r.acquiredTotal} бр., ${mny(r.acquiredValue)}</div>
      ${prTable(['Начин', 'Бр.', 'Стойност'], r.acquired, true)}
      <div class="pmeta">Отчислени през ${r.year} г. — ${r.deaccessionedTotal} бр., ${mny(r.deaccessionedValue)}</div>
      ${prTable(['Причина', 'Бр.', 'Стойност'], r.deaccessioned, true)}`;
  }
  if (r.id === 'mzs_annual') {
    return `
      <div class="pmeta">Заявки за ${r.year} г.: ${r.total}</div>
      ${prTable(['Посока', 'Бр.'], r.byDirection)}
      ${prTable(['Състояние', 'Бр.'], r.byStatus)}`;
  }
  if (r.id === 'fees_income') {
    return `
      <div class="pmeta">Начислено през ${r.year} г. — ${r.chargedTotal} бр., ${mny(r.chargedValue)} ·
      събрано — ${r.paidCount} бр., ${mny(r.paidValue)}</div>
      ${prTable(['Вид', 'Бр.', 'Сума'], r.charged, true)}`;
  }
  return '';
}
function printReportDoc() {
  const r = window._REPORT; if (!r) return;
  setPrintPage({ name: (r.title || 'Справка') + ' — ' + r.year, landscape: r.id === 'annual_ab', margin: '10mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 style="font-size:14pt">${esc(r.title || 'Справка')}</h2>
    ${reportPrintHtml(r)}
    ${ssig(['Библиотекар: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printReportDoc = printReportDoc;
