/* ---------------- Табло ---------------- */
/* Иконки на Таблото (v1.70.0) — SVG вместо емоджита, по образец на NAV_ICONS
   в navigation.js. navIco()/NAV_ICONS са достъпни тук без window.-префикс,
   защото всички изгледи се зареждат като класически <script> тагове в общия
   лексикален обхват на страницата (виж бележката в bootstrap.js) — точно
   както esc()/fld()/$() от core.js се ползват навсякъде без внос. Част от
   иконките преизползват вече изрисуваните за навигацията (визуална
   последователност); календар и кабарче са нови, за неща без собствен раздел. */
const DASH_ICONS = {
  fund: NAV_ICONS.books,
  loans: NAV_ICONS.circ,
  overdue: NAV_ICONS.over,
  upcoming: navIco('<rect x="3" y="4.5" width="18" height="17" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/><circle cx="12" cy="15.5" r="1.5" fill="currentColor" stroke="none"/>'),
  holds: navIco('<path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.3"/>'),
  plus: navIco('<path d="M12 5v14M5 12h14"/>')
};
/* Микрографика на заеманията по седмици (v2.4.52). Дванайсет стълбчета в 108×24 px
   — колкото се събира под надписа на показателя, без да го разтяга. Числата остават
   и като ТЕКСТ отдолу: графиката е допълнение към тях, не заместител, а екранният
   четец не чете стълбчета. Последната седмица е по-тъмна, защото е незавършена. */
function dashSpark(weeks) {
  const w = Array.isArray(weeks) ? weeks : [];
  if (!w.length) return '';
  const max = Math.max(1, ...w);
  const bars = w.map((v, i) => {
    const h = Math.max(1, Math.round(v / max * 20));
    const last = i === w.length - 1;
    return `<rect x="${i * 9}" y="${22 - h}" width="6" height="${h}" rx="1"
      fill="var(${last ? '--brassD' : '--brass'})" opacity="${last ? 1 : 0.45}"/>`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 108 24" width="108" height="24" role="img"
    aria-label="Заемания по седмици за последните ${w.length} седмици: ${w.join(', ')}">${bars}</svg>`;
}
/* Просрочията ПО ТЕЖЕСТ (v2.4.52). „240 просрочени“ не казва какво да се направи;
   разликата между три дни и три месеца е разликата между напомняне и акт по чл. 30.
   Лентата е за окото, легендата под нея носи същите числа като текст. */
function dashOverdueBars(b) {
  const d7 = (b && b.d7) || 0, d30 = (b && b.d30) || 0, more = (b && b.more) || 0;
  const tot = d7 + d30 + more;
  if (!tot) return '';
  const p = (n) => (n / tot * 100).toFixed(2) + '%';
  return `<div class="sevBar" role="img"
      aria-label="По дни забава: до 7 дни — ${d7}; от 8 до 30 дни — ${d30}; над 30 дни — ${more}">
      <span style="width:${p(d7)};background:var(--brass)"></span>
      <span style="width:${p(d30)};background:var(--amber)"></span>
      <span style="width:${p(more)};background:var(--red)"></span>
    </div>
    <div class="sevLeg" aria-hidden="true">
      <span><i style="background:var(--brass)"></i>до 7 дни ${d7}</span>
      <span><i style="background:var(--amber)"></i>8–30 ${d30}</span>
      <span><i style="background:var(--red)"></i>над 30 ${more}</span>
    </div>`;
}
/* Предстоящите връщания, ГРУПИРАНИ ПО ДЕН (v2.4.52). Дотук всеки ред носеше и
   собствената си дата с най-едрия шрифт на таблото, при положение че всички дати са
   в рамките на три дни — тоест най-силният акцент отиваше за най-малко важното.
   Денят става заглавие на групата, а заглавието на документа — главното на реда. */
const DASH_DAY_NAMES = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
function dashUpcomingHtml(rows, byDay, total, max) {
  if (!total) return '<div class="hint">Няма предстоящи връщания.</div>';
  const t = today();
  const tm = new Date(t + 'T12:00:00Z');
  tm.setUTCDate(tm.getUTCDate() + 1);
  const tomorrowIso = tm.toISOString().slice(0, 10);
  const dayLabel = (d) => d === t ? 'Днес' : d === tomorrowIso ? 'Утре'
    : DASH_DAY_NAMES[new Date(d + 'T12:00:00Z').getUTCDay()];
  const shownRows = new Map();
  for (const l of rows) {
    if (!shownRows.has(l.date_due)) shownRows.set(l.date_due, []);
    shownRows.get(l.date_due).push(l);
  }
  /* Дните се вземат от БРОЯЧА на базата, а редовете — от прозореца. Така „Днес · 154“
     е вярно дори когато отдолу стоят шест реда, а ден, който изобщо не е влязъл в
     прозореца, все пак се обявява с точния си брой, вместо да изчезне. */
  const days = (byDay && byDay.length) ? byDay
    : [...shownRows.keys()].map(d => ({ date: d, n: shownRows.get(d).length }));
  /* ВСИЧКИ дни получават заглавие (те са най-много четири — днес и три напред), а
     редовете се пълнят, докато стигне мястото. Така се вижда формата на следващите
     три дни („утре 40, в събота 6“), а не само първият ден и едно общо „още“. */
  let shown = 0;
  const out = [];
  for (const day of days) {
    out.push(`<div class="upDay"><span class="upDayName">${esc(dayLabel(day.date))}</span>
      <span class="upDayDate">${bg(day.date)}</span><span class="upDayN">${day.n}</span></div>`);
    for (const l of (shownRows.get(day.date) || [])) {
      if (shown >= max) break;
      out.push(`<div class="upRow2"><span class="upTitle" title="${esc(l.title)}">${esc(l.title)}</span>
        <span class="upWho">${esc(l.reader_name || '')}</span></div>`);
      shown++;
    }
  }
  const rest = total - shown;
  if (rest > 0) {
    out.push(`<button class="upMore" onclick="go('circ')">още ${pl(rest, 'документ', 'документа')} до 3 дни →</button>`);
  }
  return out.join('');
}
async function renderDash() {
  const r = await call(window.api.dashboard.full());
  if (!r) return;
  const pct = r.inventoryTarget ? Math.min(100, Math.round(r.inventoryScannedYear / r.inventoryTarget * 100)) : 0;
  /* Общият брой идва ОТДЕЛНО от показаните редове — списъкът вече е прозорец (виж
     handlers/dashboard.js). Отговор без брояч пада обратно към дължината, за да не
     се счупи екранът, ако някога се разминат версиите на двете страни. */
  const upTotal = r.upcomingCount != null ? r.upcomingCount : r.upcoming.length;
  /* Напредъкът по чл. 40 се мери спрямо КАЛЕНДАРА, не спрямо кръгло число: 8% през
     януари е в график, 60% през декември — не. Прагът е десет пункта под изминалата
     част от годината, за да не се мени при разлика от няколко дни. */
  const nowD = new Date();
  const yStart = new Date(nowD.getFullYear(), 0, 1), yEnd = new Date(nowD.getFullYear(), 11, 31);
  const daysLeft = Math.max(0, Math.ceil((yEnd - nowD) / 86400000));
  const elapsedPct = (nowD - yStart) / (yEnd - yStart) * 100;
  const invDone = pct >= 100;
  const invBehind = !invDone && pct < elapsedPct - 10;
  const invLeft = Math.max(0, r.inventoryTarget - r.inventoryScannedYear);
  const perMonth = Math.ceil(invLeft / Math.max(1, Math.round(daysLeft / 30)));
  $('#view').innerHTML = `
    <div class="card dashScan">
      <div class="dashScan-l">
        <h3 style="margin:0 0 2px">Бързо търсене / сканиране</h3>
        <div class="hint" style="margin:0">Сканирайте баркод на документ или читателска карта — програмата разпознава сама какво е.</div>
      </div>
      <input id="dashScan" class="scan" placeholder="Сканирай баркод, инв. № или № читателска карта…" autocomplete="off">
    </div>
    <div id="dashScanResult"></div>

    <div class="kpis">
      ${kpi(DASH_ICONS.fund, r.fundCount.toLocaleString('bg-BG'), 'Библиотечен фонд', mny(r.fundValue))}
      ${kpi(DASH_ICONS.loans, r.loansOpen, 'Заети в момента',
        'при ' + pl(r.activeReaders, 'активен читател', 'активни читатели')
        + dashSpark(r.loansWeeks)
        + (r.loansWeeks && r.loansWeeks.length
          ? `<span class="kpiFoot">${pl(r.loansWeeks[r.loansWeeks.length - 1], 'заемане', 'заемания')} тази седмица · 12 седмици назад</span>`
          : ''))}
      ${kpi(DASH_ICONS.overdue, r.overdueCount, 'Просрочени',
        (r.overdueCount ? 'изискват внимание' : 'няма закъснения') + dashOverdueBars(r.overdueBuckets),
        r.overdueCount ? 'warn' : 'ok')}
      ${kpi(DASH_ICONS.upcoming, upTotal, 'Връщания до 3 дни', upTotal ? 'предстоящи' : 'няма предстоящи')}
      ${r.holdsReady || r.holdsWaiting
        ? kpi(DASH_ICONS.holds, r.holdsReady, 'Заделени за читатели', r.holdsReady
            ? 'чакат да бъдат взети' + (r.holdsWaiting ? ' · ' + r.holdsWaiting + ' в опашка' : '')
            : r.holdsWaiting + ' в опашка за заета книга', r.holdsReady ? 'warn' : '')
        : ''}
    </div>

    <!-- Изискването по чл. 40, т. 2 е ЕДИНСТВЕНОТО на таблото с краен срок
         (31 декември). Дотук стоеше в дъното на „Годината“ като „0 / 1465“ и лента —
         на 2 500 px надолу при истински фонд, тоест се виждаше чак когато вече е
         късно. Стои веднага под показателите и казва не само докъде е стигнало, а и
         дали изостава спрямо календара и с какво темпо се навакса. -->
    <div class="card normCard${invBehind ? ' behind' : ''}">
      ${ringSvg(pct, 'от изисквания обхват', {
        compact: true,
        color: invDone ? 'var(--green)' : (invBehind ? 'var(--red)' : 'var(--brass)')
      })}
      <div class="normBody">
        <h3>Инвентаризация ${r.year}
          <span class="badge ${invDone ? 'ok' : (invBehind ? 'warn' : 'w')}">${invDone ? 'изпълнена' : (invBehind ? 'изостава' : 'в график')}</span></h3>
        <div class="normNum"><b>${r.inventoryScannedYear.toLocaleString('bg-BG')}</b> от
          <b>${r.inventoryTarget.toLocaleString('bg-BG')}</b> ${r.inventoryTarget === 1 ? 'документ' : 'документа'}
          <div class="hint">чл. 40, т. 2 — не по-малко от ${r.inventoryPct}% от фонда годишно</div></div>
        <div class="normPace">${invDone
          ? 'Изискването за тази година е изпълнено.'
          : `Остават <b>${daysLeft}</b> ${daysLeft === 1 ? 'ден' : 'дни'} до 31 декември — по
             <b>${perMonth.toLocaleString('bg-BG')}</b> ${perMonth === 1 ? 'документ' : 'документа'} на месец, за да бъде изпълнено.`}</div>
      </div>
      <button class="btn ${invBehind ? 'pri' : ''} normBtn" onclick="go('invent')">${
        r.inventoryScannedYear ? 'Продължи проверката' : 'Започни проверка'}</button>
    </div>

    <div class="grid g3 dashGrid" style="margin-top:16px">
      <div class="card" style="grid-column:span 2"><h3 style="margin-top:0">Просрочени заемания
        ${r.overdueRows.length ? '<button class="btn sm" style="float:right" onclick="go(\'over\')">Всички</button>' : ''}</h3>
        ${r.overdueRows.length ? `<div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
        <th>Читател</th><th>Документ</th><th class="nowrap">Инв. №</th><th>Срок</th><th>Дни</th></tr></thead><tbody>
        ${r.overdueRows.map(l => `<tr><td>${esc(l.reader_name)}</td><td>${esc(l.title)}</td>
        <td class="num">${l.inv_number ?? ''}</td><td class="num">${bg(l.date_due)}</td>
        <td class="num warn">${l.daysLate ?? ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty"><p>Няма просрочени заемания.</p></div>'}
      </div>
      <div class="card"><h3 style="margin-top:0">Годината ${r.year}</h3>
        <div class="statRows">
          <div><span>Постъпили документи</span><b>${r.acquiredYear}</b></div>
          <div><span>Отчислени документи</span><b>${r.deaccessionedYear}</b></div>
          <div><span>Заемания</span><b>${r.loansYear}</b></div>
          <div><span>Записани читатели</span><b>${r.readersYear}</b></div>
        </div>
        <!-- Инвентаризацията се премести горе, в собствен ред (v2.4.52): тук стоеше
             последна в най-дългата карта и се виждаше едва след превъртане. Не се
             показва на две места — едно число, едно място. -->
      </div>
    </div>

    <!-- Подредба на таблото (v2.4.51): двата реда от преди v2.4.29. „Бързи
         действия“ се върнаха като КАРТА в долния ред вместо лента на цяла
         ширина — лентата отваряше собствен ред и вдигаше таблото с 145 px,
         без да показва нищо повече. Измерено при 1366×768: 1115 → 970 px. -->
    <div class="grid g3 dashGrid" style="margin-top:16px">
      <div class="card dashActions"><h3 style="margin-top:0">Бързи действия</h3>
        <div class="quickGrid">
          <button class="quickBtn" onclick="bookForm()"><span>${DASH_ICONS.plus}</span>Нов документ</button>
          <button class="quickBtn" onclick="go('circ')"><span>${NAV_ICONS.circ}</span>Заемане / връщане</button>
          <button class="quickBtn" onclick="readerForm()"><span>${NAV_ICONS.readers}</span>Нов читател</button>
          <button class="quickBtn" onclick="go('acq')"><span>${NAV_ICONS.acq}</span>Нова партида</button>
          <button class="quickBtn" onclick="go('dnevnik')"><span>${NAV_ICONS.dnevnik}</span>Дневник</button>
          <button class="quickBtn" onclick="go('labels')"><span>${NAV_ICONS.labels}</span>Етикети</button>
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">Предстоящи връщания
        ${upTotal ? `<button class="btn sm" style="float:right" onclick="go('circ')">Всички ${upTotal}</button>` : ''}</h3>
        <div class="upList">${dashUpcomingHtml(r.upcoming, r.upcomingByDay, upTotal, 6)}</div>
      </div>
      <div class="card"><h3 style="margin-top:0">За днес${r.today.isTodayOpen === false ? ' <span class="badge warn">затворен ден</span>' : ''}</h3>
        <div class="statRows">
          <!-- „Връщания до 3 дни“ стоеше и тук, и като показател горе, и като цяла
               карта до него — едно и също число на три места в един екран (v2.4.52).
               Остава горе, където му е мястото: показател с брой. -->
          <div><span>Читатели без изпратено напомняне за просрочие</span>
            <b>${r.today.dueReminders ? `<a href="#over">${r.today.dueReminders}</a>` : '0'}</b></div>
          <div><span>Дължими пререгистрации (до 14 дни)</span>
            <b>${r.today.reregDue ? `<a href="#readers">${r.today.reregDue}</a>` : '0'}</b></div>
          <div><span>Просрочие над 60 дни — преценете „липсваща“</span>
            <b>${r.today.longOverdue ? `<a href="#over">${r.today.longOverdue}</a>` : '0'}</b></div>
          ${r.today.suspendedNow ? `<div><span>Читатели с наказание в момента</span><b>${r.today.suspendedNow}</b></div>` : ''}
          ${r.today.isTodayOpen !== false ? `<div><span>Дневник на библиотеката за днес</span>
            <b>${r.today.dnevnikFilled ? '<span class="badge ok">попълнен</span>'
              : `<a href="#dnevnik" onclick="event.preventDefault();dnevnikDayForm(today())" title="Отваря формуляра за днешния ден">не е попълнен</a>`}</b></div>` : ''}
          ${r.today.anonCandidates ? `<div><span>Стари заемания за анонимизиране</span>
            <b><a href="#setup/lichni">${r.today.anonCandidates}</a></b></div>` : ''}
          ${r.today.overduePeriodicals ? `<div><span>Периодични издания — закъснял/липсващ брой</span>
            <b><a href="#periodika">${r.today.overduePeriodicals}</a></b></div>` : ''}
        </div>
        <div class="hint" style="margin-top:8px">Пререгистрацията е дължима една година след последното записване.</div>
      </div>
    </div>

    ${r.fundCount === 0 ? `<div class="note w" style="margin-top:18px"><b>Първи стъпки.</b>
    1) Попълнете <a href="#setup">Настройки</a> — име на библиотеката, ръководител, комисия и начален инвентарен номер.
    2) Заведете партида в <a href="#acq">Постъпления</a> (чл. 14).
    3) Каталогизирайте документите в <a href="#books">Книги</a>. Инвентарните номера се дават последователно (чл. 16, ал. 2).</div>` : ''}
  `;
  const sc = $('#dashScan');
  if (sc) {
    sc.focus();
    sc.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = sc.value.trim(); sc.value = '';
      if (code) await dashLookup(code);
    });
  }
}
/* Разпознава сканираното само по това дали съвпада с документ или с читателска карта —
   не се налага потребителят предварително да избира какво сканира. */
async function dashLookup(code) {
  const box = $('#dashScanResult');
  const [book, reader] = await Promise.all([
    window.api.books.byBarcode(code), window.api.readers.byCard(code)
  ]);
  const b = book.ok ? book.data : null;
  const rd = reader.ok ? reader.data : null;
  /* Код, който е и инв. № на документ, и № на читателска карта (v2.4.29): дотук
     мълчаливо се показваше само документът. Двете се показват, за да избере
     библиотекарят; полето остава на фокус за следващото сканиране. */
  const both = b && rd ? `<div class="note w" style="margin-bottom:8px">Кодът <b>${esc(code)}</b> съвпада и с документ, и с читателска карта — по-долу са и двете.</div>` : '';
  box.innerHTML = both;
  if (b) {
    const loans = await call(window.api.loans.byBook(b.id));
    const open = (loans || []).filter(l => !l.date_in);
    box.innerHTML += `<div class="card scanHit">
      <div class="scanHit-head"><b>Документ</b> · инв. № ${b.inv_number ?? '—'}
        <button class="btn sm" style="float:right" onclick="bookForm(${b.id})">Отвори карта</button></div>
      <div class="scanHit-title">${esc(b.title)}</div>
      <div class="hint">${esc([b.author, b.publisher, b.year].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:8px">
        ${b.status === 'отчислен' ? '<span class="badge warn">отчислен</span>'
          : open.length ? `<span class="badge warn">заета от ${esc(open[0].reader_name || '')} до ${bg(open[0].date_due)}</span>
              <button class="btn sm" onclick="returnBook(${open[0].id})" title="Приема връщането на този документ">Приеми връщането</button>`
          : '<span class="badge ok">налична</span>'}
        <span class="hint" style="margin-left:8px">${esc(b.department || '')}${b.call_number ? ' · ' + esc(b.call_number) : ''}</span>
      </div></div>`;
  }
  if (rd) {
    const loans = await call(window.api.loans.byReader(rd.id));
    const open = (loans || []).filter(l => !l.date_in);
    box.innerHTML += `<div class="card scanHit"${b ? ' style="margin-top:8px"' : ''}>
      <div class="scanHit-head"><b>Читател</b> · карта ${esc(rd.card_no || '—')}
        <button class="btn sm" style="float:right" onclick="CIRC.readerId=${rd.id};CIRC.mode='out';go('circ')"
          title="Отваря гишето с този читател вече избран">Заемане / връщане</button></div>
      <div class="scanHit-title">${esc(rd.name)}</div>
      <div class="hint">${esc(rd.category || '')}${rd.phone ? ' · ' + esc(rd.phone) : ''}</div>
      <div style="margin-top:8px">
        ${rd.status === 'прекратен' ? '<span class="badge warn">прекратена регистрация</span>'
          : `<span class="badge ok">активен</span>`}
        <span class="hint" style="margin-left:8px">заети в момента: <b>${open.length}</b></span>
      </div></div>`;
  }
  if (b || rd) return;
  if (!book.ok || !reader.ok) {
    /* Одит v2.4.24: сканирането вече ОТКАЗВА при двусмислен код (баркод на един
       документ, инвентарен номер на друг — виж resolveScannedBook). Дотук отказът
       се сливаше с „няма такъв“ и библиотекарят четеше, че етикетът, който държи в
       ръцете си, не съществува, вместо да разбере кое точно е двусмислено. */
    box.innerHTML = `<div class="note d">${esc((!book.ok ? book.error : reader.error) || 'Търсенето не успя.')}</div>`;
  } else {
    box.innerHTML = `<div class="note w">Няма намерен документ или читател с код <b>${esc(code)}</b>.</div>`;
  }
}
window.dashLookup = dashLookup;
