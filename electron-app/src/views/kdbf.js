/* ---------------- КДБФ ---------------- */
let KDBF_TAB = 'p1', KDBF_YEAR = null;
/* Разбивка по видове документи в едно постъпление — „книга: 12, периодично
   издание: 3“. Връща ЧИСТ текст; екранирането е на мястото на вграждането. */
function kdbfByKind(rows) {
  const m = {};
  /* По ЕКЗЕМПЛЯРИ, не по редове: колоната „По вид" е задължителен реквизит на
     Приложение № 1 и стои на същия ред, чиято обща бройка вече брои документи.
     Ако тук се броят заглавия, отпечатаният регистър казва „Инвентирани: 120",
     а до него „книга: 40" — числа, които проверяващият не може да съгласува. */
  const qtyOf = (x) => (x && x.fund_qty != null ? (Number(x.fund_qty) || 0) : 1);
  (rows || []).forEach(x => { const k = (x && x.category_name) || 'без вид'; m[k] = (m[k] || 0) + qtyOf(x); });
  return Object.entries(m).map(([k, v]) => k + ': ' + v).join(', ');
}
/* ЗАЩО отделна заявка: колоната „По вид“ е задължителен реквизит на Приложение
   № 1 (чл. 13, ал. 3, т. 1), но kdbf:report връща само общите бройки и стойност
   на партидата — вид документ там няма. Дотогава в кода стоеше дефинирана и
   НИКОГА неизвиквана функция razbivka(), колоната на екрана се чертаеше празна
   (<td></td>), а в разпечатката липсваше изцяло — тоест изискваният по наредбата
   реквизит отсъстваше мълчаливо и това се виждаше едва при проверка.
   Данните ги има: acquisitions:get връща записите на партидата заедно с
   category_name (видът документ от „Категории“). Тегли се по една заявка на
   ПАРТИДА за избраната година — партидите са няколко десетки годишно, а не по
   целия фонд от 15 000 книги. Резултатът се закача на самия ред (a.by_kind),
   за да го ползва и разпечатката, която винаги съдържа Част № 1. */
async function kdbfLoadByKind(part1) {
  await Promise.all((part1 || []).map(async (a) => {
    if (a.by_kind != null) return;
    const acq = await call(window.api.acquisitions.get(a.id));
    a.by_kind = kdbfByKind(acq && acq.items);
  }));
}
async function renderKdbf() {
  const y = KDBF_YEAR || yr();
  const r = await call(window.api.kdbf.report(y));
  if (!r) return;
  // Текущата година и няколко назад (yearOptions в core.js). Дотогава списъкът
  // беше [избраната, текущата] — една опция, и КДБФ за миналата година оставаше
  // недостижима след 1 януари.
  const years = yearOptions(y);
  await kdbfLoadByKind(r.part1);
  window._KDBF_REPORT = r;
  $('#view').innerHTML = `
    <div class="toolbar">
      <div class="tabs" style="display:flex;gap:6px">
        <button class="btn sm ${KDBF_TAB === 'p1' ? 'pri' : ''}" onclick="KDBF_TAB='p1';renderKdbf()">Част № 1 · Постъпили</button>
        <button class="btn sm ${KDBF_TAB === 'p2' ? 'pri' : ''}" onclick="KDBF_TAB='p2';renderKdbf()">Част № 2 · Резултати</button>
        <button class="btn sm ${KDBF_TAB === 'p3' ? 'pri' : ''}" onclick="KDBF_TAB='p3';renderKdbf()">Част № 3 · Отчислени</button>
      </div>
      <select onchange="KDBF_YEAR=this.value;renderKdbf()">${years.map(x => `<option ${x === y ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <button class="btn" onclick="printKdbfDoc()">Печат / PDF</button>
    </div>
    ${KDBF_TAB === 'p1' ? `
      <div class="note"><b>Приложение № 1 към чл. 13, ал. 3, т. 1</b> — постъпили книги и материали за ${y} г.</div>
      <div class="wrap"><table class="ledger"><thead><tr><th>Дата</th><th>№</th><th>Откъде</th><th>Документ</th>
        <th>Общо</th><th>Инвентирани</th><th>Стойност</th><th>Инв. № от–до</th><th>По вид</th></tr></thead><tbody>
      ${r.part1.length ? r.part1.map(a => `<tr><td class="num">${bg(a.date)}</td><td class="num">${a.no}</td>
        <td>${esc(a.from_source || '')}<div class="hint">${esc(a.how || '')}</div></td>
        <td style="font-size:12px">${esc(a.doc_type || '')} № ${esc(a.doc_no || '')}<br>${bg(a.doc_date)}</td>
        <td class="num">${a.total_count}</td><td class="num">${a.registered_count}</td><td class="num">${mny(a.registered_value)}</td>
        <td class="num">${a.inv_from ? a.inv_from + ' – ' + a.inv_to : '—'}</td>
        <td style="font-size:12px">${esc(a.by_kind || '') || '—'}</td></tr>`).join('')
        : `<tr><td colspan="9" class="empty">Няма постъпления за ${y} г.</td></tr>`}
      </tbody></table></div>`
    : KDBF_TAB === 'p3' ? `
      <div class="note"><b>Приложение № 3 към чл. 13, ал. 3, т. 3</b> — отчислени документи за ${y} г.</div>
      <div class="wrap"><table class="ledger"><thead><tr><th>Дата</th><th>Акт №</th><th>Причина</th>
        <th>Общо</th><th>Стойност</th></tr></thead><tbody>
      ${r.part3.length ? r.part3.map(a => `<tr><td class="num">${bg(a.date)}</td><td class="num">${a.no}</td>
        <td>${esc(a.reason_text || '')}</td><td class="num">${a.item_count}</td><td class="num">${mny(a.item_value)}</td></tr>`).join('')
        : `<tr><td colspan="5" class="empty">Няма отчисления за ${y} г.</td></tr>`}
      </tbody></table></div>`
    : `
      <div class="note"><b>Приложение № 2 към чл. 13, ал. 3, т. 2</b> — резултати от движението на фонда към 31.12.${y} г.</div>
      ${kdbfPart2Html(r, y)}`}
  `;
}

/* Част № 2 като поток на движението: начално салдо + постъпили − отчислени = крайно салдо.
   Началното салдо не идва от заявка — извежда се от крайното, за да съвпада винаги с него. */
function kdbfPart2Html(r, y) {
  const endN = r.stockEnd.n, endV = r.stockEnd.v;
  const accN = r.acquiredYear.n, accV = r.acquiredYear.v;
  const decN = r.deaccYear.n, decV = r.deaccYear.v;
  const startN = endN - accN + decN, startV = endV - accV + decV;
  const netN = accN - decN;
  const growth = startN ? Math.round(netN / startN * 1000) / 10 : 0;
  return `
    <div class="flow" style="margin-bottom:16px">
      <div class="flowBox">
        <div class="fv">${startN.toLocaleString('bg-BG')}</div>
        <div class="fl">Наличност 01.01.${y}</div><div class="fm">${mny(startV)}</div></div>
      <div class="flowOp">+</div>
      <div class="flowBox plus">
        <div class="fv">${accN.toLocaleString('bg-BG')}</div>
        <div class="fl">Постъпили през ${y}</div><div class="fm">${mny(accV)}</div></div>
      <div class="flowOp">−</div>
      <div class="flowBox minus">
        <div class="fv">${decN.toLocaleString('bg-BG')}</div>
        <div class="fl">Отчислени през ${y}</div><div class="fm">${mny(decV)}</div></div>
      <div class="flowOp">=</div>
      <div class="flowBox strong">
        <div class="fv">${endN.toLocaleString('bg-BG')}</div>
        <div class="fl">Наличност 31.12.${y}</div><div class="fm">${mny(endV)}</div></div>
    </div>

    <div class="grid g2">
      <div class="card"><h3 style="margin-top:0">Обобщение за ${y} г.</h3>
        <div class="statRows">
          <div><span>Чист прираст на фонда</span><b style="color:${netN >= 0 ? 'var(--green)' : 'var(--red)'}">
            ${netN >= 0 ? '+' : ''}${netN.toLocaleString('bg-BG')} документа</b></div>
          <div><span>Изменение на стойността</span><b style="color:${accV - decV >= 0 ? 'var(--green)' : 'var(--red)'}">
            ${accV - decV >= 0 ? '+' : '−'}${mny(Math.abs(accV - decV))}</b></div>
          <div><span>Ръст спрямо началото на годината</span><b>${netN >= 0 ? '+' : ''}${growth}%</b></div>
          <div><span>Средна цена на документ</span><b>${mny(endN ? endV / endN : 0)}</b></div>
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">Съотношение постъпили / отчислени</h3>
        ${(accN + decN) ? `
          <div class="chartRow">
            <div class="cr-top"><span class="cr-k">Постъпили</span><span class="cr-v"><b>${accN}</b></span></div>
            <div class="chartTrack"><div class="chartFill g" style="width:${Math.max(2, accN / Math.max(accN, decN) * 100)}%"></div></div>
          </div>
          <div class="chartRow">
            <div class="cr-top"><span class="cr-k">Отчислени</span><span class="cr-v"><b>${decN}</b></span></div>
            <div class="chartTrack"><div class="chartFill r" style="width:${Math.max(2, decN / Math.max(accN, decN) * 100)}%"></div></div>
          </div>
          <div class="hint" style="margin-top:10px">${netN >= 0
            ? 'Фондът нараства — постъпленията надвишават отчисленията.'
            : 'Фондът намалява — отчисленията надвишават постъпленията.'}</div>`
        : '<span class="hint">Няма движение през тази година.</span>'}
      </div>
    </div>`;
}
function printKdbfDoc() {
  const r = window._KDBF_REPORT; if (!r) return;
  const y = r.year;
  setPrintPage({ name: `КДБФ ${y} г.`, landscape: true, margin: '10mm' });
  doPrint(`
    <div class="pdoc">${shead()}<h2>КНИГА ЗА ДВИЖЕНИЕ НА БИБЛИОТЕЧНИЯ ФОНД</h2>
     <div class="pmeta"><b>Част № 1. Регистриране на постъпили книги, периодични издания и други материали</b><br>
     Приложение № 1 към чл. 13, ал. 3, т. 1 · ${y} г.</div>
     <table><thead><tr><th>Дата</th><th>№</th><th>Откъде и как</th><th>Вид, № и дата на документа</th><th>Общо</th>
     <th>Инвентирани</th><th>Стойност</th><th>Инв. № от – до</th><th>По вид документи</th></tr></thead><tbody>
     ${r.part1.map(a => `<tr><td>${bg(a.date)}</td><td>${a.no}</td><td>${esc(a.from_source || '')} / ${esc(a.how || '')}</td>
     <td>${esc(a.doc_type || '')} № ${esc(a.doc_no || '')} / ${bg(a.doc_date)}</td><td>${a.total_count}</td><td>${a.registered_count}</td>
     <td>${mny(a.registered_value)}</td><td>${a.inv_from ? a.inv_from + '–' + a.inv_to : ''}</td>
     <td>${esc(a.by_kind || '')}</td></tr>`).join('')}
     ${r.part1.length ? '' : `<tr><td colspan="9" style="text-align:center">През ${y} г. няма регистрирани постъпления.</td></tr>`}
     </tbody></table>${ssig(['Библиотекар: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>

    <div class="pdoc">${shead()}<h2>КНИГА ЗА ДВИЖЕНИЕ НА БИБЛИОТЕЧНИЯ ФОНД</h2>
     <div class="pmeta"><b>Част № 3. Регистриране на отчислените книги, периодични издания и други материали</b><br>
     Приложение № 3 към чл. 13, ал. 3, т. 3 · ${y} г.</div>
     <table><thead><tr><th>Дата</th><th>№</th><th>Акт № / дата</th><th>Общо</th><th>Стойност</th><th>Причина</th></tr></thead><tbody>
     ${r.part3.map(a => `<tr><td>${bg(a.date)}</td><td>${a.no}</td><td>№ ${a.no} / ${bg(a.date)}</td>
     <td>${a.item_count}</td><td>${mny(a.item_value)}</td><td>${esc(a.reason_text || '')}</td></tr>`).join('')}
     ${r.part3.length ? '' : `<tr><td colspan="6" style="text-align:center">През ${y} г. няма отчислени документи.</td></tr>`}
     </tbody></table>${ssig(['Библиотекар: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>

    <div class="pdoc">${shead()}<h2>РЕЗУЛТАТИ ОТ ДВИЖЕНИЕТО НА БИБЛИОТЕЧНИЯ ФОНД</h2>
     <div class="pmeta"><b>Част № 2</b> · Приложение № 2 към чл. 13, ал. 3, т. 2 · към 31.12.${y} г.</div>
     <table><thead><tr><th>Показател</th><th>Брой</th><th>Стойност, лв.</th></tr></thead><tbody>
     <tr><td>Наличност към 01.01.${y} г.</td><td>${r.stockEnd.n - r.acquiredYear.n + r.deaccYear.n}</td>
       <td>${mny(r.stockEnd.v - r.acquiredYear.v + r.deaccYear.v)}</td></tr>
     <tr><td>Постъпили през ${y} г.</td><td>${r.acquiredYear.n}</td><td>${mny(r.acquiredYear.v)}</td></tr>
     <tr><td>Отчислени през ${y} г.</td><td>${r.deaccYear.n}</td><td>${mny(r.deaccYear.v)}</td></tr>
     <tr style="font-weight:700"><td>Наличност към 31.12.${y} г.</td><td>${r.stockEnd.n}</td><td>${mny(r.stockEnd.v)}</td></tr>
     </tbody></table>${ssig(['Библиотекар: …………………', 'Счетоводител: …………………', esc((SETTINGS_CACHE || {}).director_role || 'Ръководител') + ': …………………'])}</div>`);
}
window.printKdbfDoc = printKdbfDoc;
