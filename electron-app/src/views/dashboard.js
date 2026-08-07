/* ---------------- Табло ---------------- */
async function renderDash() {
  const r = await call(window.api.dashboard.full());
  if (!r) return;
  const pct = r.inventoryTarget ? Math.min(100, Math.round(r.inventoryScannedYear / r.inventoryTarget * 100)) : 0;
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
      ${kpi('📚', r.fundCount.toLocaleString('bg-BG'), 'Библиотечен фонд', mny(r.fundValue))}
      ${kpi('📖', r.loansOpen, 'Заети в момента', 'при ' + r.activeReaders + ' активни читатели')}
      ${kpi('⏰', r.overdueCount, 'Просрочени', r.overdueCount ? 'изискват внимание' : 'няма закъснения', r.overdueCount ? 'warn' : 'ok')}
      ${kpi('📅', r.upcoming.length, 'Връщания до 3 дни', r.upcoming.length ? 'предстоящи' : 'няма предстоящи')}
      ${r.holdsReady || r.holdsWaiting
        ? kpi('📌', r.holdsReady, 'Заделени за читатели', r.holdsReady
            ? 'чакат да бъдат взети' + (r.holdsWaiting ? ' · ' + r.holdsWaiting + ' в опашка' : '')
            : r.holdsWaiting + ' в опашка за заета книга', r.holdsReady ? 'warn' : '')
        : ''}
    </div>

    <div class="grid g3" style="margin-top:16px">
      <div class="card" style="grid-column:span 2"><h3 style="margin-top:0">Просрочени заемания
        ${r.overdueRows.length ? '<button class="btn sm" style="float:right" onclick="go(\'over\')">Всички</button>' : ''}</h3>
        ${r.overdueRows.length ? `<div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
        <th>Читател</th><th>Документ</th><th>Инв. №</th><th>Срок</th><th>Дни</th></tr></thead><tbody>
        ${r.overdueRows.map(l => `<tr><td>${esc(l.reader_name)}</td><td>${esc(l.title)}</td>
        <td class="num">${l.inv_number ?? ''}</td><td class="num">${bg(l.date_due)}</td>
        <td class="num warn">${Math.round((new Date(today()) - new Date(l.date_due)) / 864e5)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty"><p>Няма просрочени заемания.</p></div>'}
      </div>
      <div class="card"><h3 style="margin-top:0">Годината ${r.year}</h3>
        <div class="statRows">
          <div><span>Постъпили документи</span><b>${r.acquiredYear}</b></div>
          <div><span>Отчислени документи</span><b>${r.deaccessionedYear}</b></div>
          <div><span>Заемания</span><b>${r.loansYear}</b></div>
          <div><span>Записани читатели</span><b>${r.readersYear}</b></div>
        </div>
        <hr style="border:0;border-top:1px solid var(--rule);margin:12px 0 10px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
          <span>Инвентаризация</span><b>${r.inventoryScannedYear} / ${r.inventoryTarget}</b></div>
        <div class="bar"><div class="bar-fill ${pct >= 100 ? 'done' : ''}" style="width:${pct}%"></div></div>
        <div class="hint" style="margin-top:7px">Чл. 40, т. 2: ежегодно не по-малко от <b>${r.inventoryPct}%</b> от фонда по репрезентативния метод.</div>
      </div>
    </div>

    <div class="grid g3" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Бързи действия</h3>
        <div class="quickGrid">
          <button class="quickBtn" onclick="bookForm()"><span>➕</span>Нов документ</button>
          <button class="quickBtn" onclick="go('circ')"><span>🔄</span>Заемане / връщане</button>
          <button class="quickBtn" onclick="readerForm()"><span>👤</span>Нов читател</button>
          <button class="quickBtn" onclick="go('acq')"><span>📦</span>Нова партида</button>
          <button class="quickBtn" onclick="go('dnevnik')"><span>📝</span>Дневник</button>
          <button class="quickBtn" onclick="go('labels')"><span>🏷️</span>Етикети</button>
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">Предстоящи връщания (до 3 дни)</h3>
        <div style="font-size:13px">
          ${r.upcoming.length ? r.upcoming.map(l => `<div class="upcomingRow">
          <span style="flex:1">${esc(l.title)}</span><span class="hint">${esc(l.reader_name)}</span>
          <b class="num">${bg(l.date_due)}</b></div>`).join('') : '<span class="hint">Няма.</span>'}
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">📋 За днес${r.today.isTodayOpen === false ? ' <span class="badge warn">затворен ден</span>' : ''}</h3>
        <div class="statRows">
          <div><span>Връщания до 3 дни — напомнете <b>преди</b> срока</span>
            <b>${r.upcoming.length ? `<a href="#circ">${r.upcoming.length}</a>` : '0'}</b></div>
          <div><span>Читатели без изпратено напомняне за просрочие</span>
            <b>${r.today.dueReminders ? `<a href="#over">${r.today.dueReminders}</a>` : '0'}</b></div>
          <div><span>Дължими пререгистрации (до 14 дни)</span>
            <b>${r.today.reregDue ? `<a href="#readers">${r.today.reregDue}</a>` : '0'}</b></div>
          <div><span>Просрочие над 60 дни — преценете „липсваща“</span>
            <b>${r.today.longOverdue ? `<a href="#over">${r.today.longOverdue}</a>` : '0'}</b></div>
          ${r.today.suspendedNow ? `<div><span>Читатели с наказание в момента</span><b>${r.today.suspendedNow}</b></div>` : ''}
          ${r.today.anonCandidates ? `<div><span>Стари заемания за анонимизиране</span>
            <b><a href="#setup">${r.today.anonCandidates}</a></b></div>` : ''}
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
  if (b) {
    const loans = await call(window.api.loans.byBook(b.id));
    const open = (loans || []).filter(l => !l.date_in);
    box.innerHTML = `<div class="card scanHit">
      <div class="scanHit-head"><b>Документ</b> · инв. № ${b.inv_number ?? '—'}
        <button class="btn sm" style="float:right" onclick="bookForm(${b.id})">Отвори карта</button></div>
      <div class="scanHit-title">${esc(b.title)}</div>
      <div class="hint">${esc([b.author, b.publisher, b.year].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:8px">
        ${b.status === 'отчислен' ? '<span class="badge warn">отчислен</span>'
          : open.length ? `<span class="badge warn">заета от ${esc(open[0].reader_name || '')} до ${bg(open[0].date_due)}</span>`
          : '<span class="badge ok">налична</span>'}
        <span class="hint" style="margin-left:8px">${esc(b.department || '')}${b.call_number ? ' · ' + esc(b.call_number) : ''}</span>
      </div></div>`;
  } else if (rd) {
    const loans = await call(window.api.loans.byReader(rd.id));
    const open = (loans || []).filter(l => !l.date_in);
    box.innerHTML = `<div class="card scanHit">
      <div class="scanHit-head"><b>Читател</b> · карта ${esc(rd.card_no || '—')}
        <button class="btn sm" style="float:right" onclick="go('circ')">Заемане / връщане</button></div>
      <div class="scanHit-title">${esc(rd.name)}</div>
      <div class="hint">${esc(rd.category || '')}${rd.phone ? ' · ' + esc(rd.phone) : ''}</div>
      <div style="margin-top:8px">
        ${rd.status === 'прекратен' ? '<span class="badge warn">прекратена регистрация</span>'
          : `<span class="badge ok">активен</span>`}
        <span class="hint" style="margin-left:8px">заети в момента: <b>${open.length}</b></span>
      </div></div>`;
  } else {
    box.innerHTML = `<div class="note w">Няма намерен документ или читател с код <b>${esc(code)}</b>.</div>`;
  }
}
window.dashLookup = dashLookup;
