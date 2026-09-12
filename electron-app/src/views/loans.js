/* ---------------- Заемане и връщане (изцяло чрез сканиране на баркод) ----------------
   Баркод четецът работи като клавиатура: въвежда текста и накрая изпраща Enter.
   Затова навсякъде тук слушаме за Enter в обикновени текстови полета — четецът
   не изисква никаква настройка. */
let CIRC = { readerId: null, mode: 'out' };
async function renderCirc() {
  const s = SETTINGS_CACHE || await loadSettingsCache();
  const tabs = `<div class="toolbar">
    <button class="btn ${CIRC.mode === 'out' ? 'pri' : ''}" onclick="CIRC.mode='out';renderCirc()">Заемане</button>
    <button class="btn ${CIRC.mode === 'in' ? 'pri' : ''}" onclick="CIRC.mode='in';renderCirc()">Връщане</button>
    <button class="btn ${CIRC.mode === 'holds' ? 'pri' : ''}" onclick="CIRC.mode='holds';renderCirc()">Резервации</button>
    <span style="flex:1"></span>
    <button class="btn sm" onclick="logLocaluse()"
      title="Отбелязва едно ползване на място в читалнята — влиза в предложенията за дневника (колона „В читалня“)">📖 Читалня +1</button>
  </div>`;

  if (CIRC.mode === 'holds') { await renderHolds(tabs); return; }

  if (CIRC.mode === 'in') {
    $('#view').innerHTML = tabs + `
      <div class="card"><h3 style="margin-top:0">Приемане на върнати документи</h3>
        <div class="note" style="margin-top:0">Сканирайте баркода на всеки върнат документ. Системата приключва заемането,
        отбелязва датата на връщане и изчислява обезщетение при забава.</div>
        <input id="inScan" class="scan" placeholder="Сканирай баркод на документа…" autocomplete="off">
        <div id="inLog" style="margin-top:14px"></div>
      </div>`;
    const el = $('#inScan'); el.focus();
    el.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const code = el.value.trim(); el.value = ''; if (!code) return;
      const res = await window.api.loans.returnByCode({ code, date_in: today() });
      const log = $('#inLog');
      if (!res.ok) { beep('err'); log.insertAdjacentHTML('afterbegin', `<div class="scanlog err">${esc(res.error)}</div>`); return; }
      const r = res.data;
      // Двоен нисък тон и при „заделена“/забава — очите са върху книгата, не върху
      // екрана, а точно тези два случая изискват действие (не се връща на рафта /
      // има обезщетение). Обикновеното успешно връщане дава кратък висок тон.
      beep(r.hold || r.daysLate ? 'err' : 'ok');
      log.insertAdjacentHTML('afterbegin', `<div class="scanlog ${r.daysLate ? 'warn' : 'ok'}">
        <b>${esc(r.title)}</b> (инв. ${r.inv_number}) — върната от ${esc(r.reader_name)}
        ${r.daysLate ? `<br>Забава <b>${r.daysLate}</b> ${r.daysLate === 1 ? 'ден' : 'дни'} · обезщетение <b>${mny(r.fine)}</b>`
          : r.fine ? `<br>Дължимо обезщетение по това заемане: <b>${mny(r.fine)}</b>` : ''}</div>`);
      if (r.suspendedUntil) {
        log.insertAdjacentHTML('afterbegin', `<div class="scanlog warn">⛔ Наложено наказание: заемането за
          <b>${esc(r.reader_name)}</b> е преустановено до <b>${bg(r.suspendedUntil)}</b>.</div>`);
      }
      if (r.hold) {
        log.insertAdjacentHTML('afterbegin', `<div class="scanlog warn">📌 <b>НЕ връщайте на рафта</b> — заделена за
          <b>${esc(r.hold.reader_name)}</b> (карта ${esc(r.hold.card_no || '—')}${r.hold.phone ? ', тел. ' + esc(r.hold.phone) : ''})</div>`);
        toast('📌 Заделена за ' + r.hold.reader_name + ' — не се връща на рафта!', 'err');
      } else {
        /* Сумата се показва по ПАРИТЕ, не по дните (втори преглед на кръга v2.4.24):
           след продължение на просрочено заемане забавата спрямо новия падеж е 0, а
           начисленото от продължението си стои — екранът казваше „Приета обратно“ и
           не споменаваше дължимите 1.80 лв. */
        toast(r.daysLate ? 'Върната със забава ' + dni(r.daysLate) + ' (' + mny(r.fine) + ')'
          : r.fine ? 'Приета обратно: инв. № ' + r.inv_number + ' — дължимо обезщетение ' + mny(r.fine)
          : 'Приета обратно: инв. № ' + r.inv_number, (r.daysLate || r.fine) ? 'err' : 'ok');
      }
      markSaved();
    });
    return;
  }

  let col1, col2, table = '';
  // Данни за текущия читател, изнесени извън блока по-долу: слушателят на #bScan
  // се закача в края на функцията и му трябват името/картата (за разписката) и
  // броят заети (за точковото обновяване след заемане, без пълен пререндер).
  let circReader = null, circOpen = 0, circMax = 0;
  if (CIRC.readerId) {
    const [r, acc] = await Promise.all([
      call(window.api.readers.get(CIRC.readerId)), call(window.api.account.get(CIRC.readerId))
    ]);
    if (!r) { CIRC.readerId = null; return renderCirc(); }
    // v2.4.31: трите четения са независими — успоредно, не едно след друго (три обиколки по IPC → една).
    const [rule0, myLoans0, holdsAll] = await Promise.all([
      call(window.api.circRules.effective(r.category)), call(window.api.loans.byReader(CIRC.readerId)), call(window.api.holds.list())
    ]);
    const rule = rule0 || s;
    const myLoans = myLoans0 || [];
    const openMine = myLoans.filter(l => !l.date_in);
    circReader = r; circOpen = openMine.length; circMax = rule.max_books || 0;
    col1 = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:8px"><div style="flex:1">
      <b style="font-size:17px">${esc(r.name)}</b>
      <div class="hint">Карта ${esc(r.card_no || '—')} · ${esc(r.category || '')} ·
        <span id="circCount">заети: ${circOpen}${circMax ? ' / ' + circMax : ''}</span></div></div>
      <button class="btn sm" onclick="accountModal(${r.id})" title="Читателска сметка">Сметка</button>
      <button class="btn sm" onclick="houseboundModal(${r.id})" title="Обслужване по домовете — график и посещения">По домовете</button>
      <button class="btn sm" onclick="CIRC.readerId=null;renderCirc()">Смени</button></div>
      ${r.alert_note ? `<div class="note w" style="border-left-color:#c9a84c;background:rgba(201,168,76,.12)">📌 <b>${esc(r.alert_note)}</b></div>` : ''}
      ${r.guarantor_name ? `<div class="hint">👪 Родител/настойник: <b>${esc(r.guarantor_name)}</b>${r.guarantor_phone ? ' · тел. ' + esc(r.guarantor_phone) : ''}</div>` : ''}
      ${r.suspended_until && r.suspended_until > today() ? `<div class="note w">⛔ Заемането е преустановено до <b>${bg(r.suspended_until)}</b>.
        <button class="btn sm" style="margin-left:8px" onclick="clearSuspension(${r.id})">Снеми</button></div>` : ''}
      ${acc && acc.balance > 0 ? `<div class="hint">💰 Дължи по сметка: <b style="color:var(--red)">${mny(acc.balance)}</b></div>` : ''}
      ${openMine.some(l => l.date_due && l.date_due < today()) ? '<div class="note w">Читателят има просрочени документи.</div>' : ''}`;
    const myHolds = (holdsAll || []).filter(h => h.reader_id === CIRC.readerId);
    const maxRenew = rule.extensions_count == null ? 2 : rule.extensions_count;
    col2 = `<input id="bScan" class="scan" placeholder="Сканирай баркод на документа…" autocomplete="off">
      <div class="hint" style="margin-top:6px">Срок за заемане: ${dni(rule.loan_days)}${maxRenew ? ' · до ' + pl(maxRenew, 'продължение', 'продължения') : ''}</div>
      <div class="toolbar" style="margin:10px 0 0">
        <button class="btn sm" onclick="holdPrompt()">Резервирай заета книга…</button>
      </div>
      <div id="outLog" style="margin-top:12px"></div>`;
    if (myHolds.length) {
      table += `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Резервации на този читател</h3>
        <div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
        <th>Инв. №</th><th>Заглавие</th><th>Заявена</th><th>Състояние</th><th style="width:110px"></th></tr></thead><tbody>
        ${myHolds.map(h => `<tr><td class="num">${h.inv_number ?? ''}</td><td>${esc(h.title)}</td>
          <td class="num">${bg((h.placed_at || '').slice(0, 10))}</td>
          <td>${h.status === 'заделена' ? '<span class="badge ok">заделена — чака взимане</span>' : '<span class="badge">чака</span>'}</td>
          <td><button class="btn sm" onclick="cancelHold(${h.id})">Откажи</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
    if (openMine.length) {
      table += `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Заети от този читател</h3>
        <div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
        <th>Инв. №</th><th>Заглавие</th><th>Зает</th><th>Срок</th><th>Продължения</th><th style="width:250px"></th></tr></thead><tbody>
        ${openMine.map(l => `<tr><td class="num">${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
          <td class="num">${bg(l.date_out)}</td>
          <td class="num ${l.date_due && l.date_due < today() ? 'warn' : ''}">${bg(l.date_due) || '—'}</td>
          <td class="num">${l.renewals || 0}${maxRenew ? ' / ' + maxRenew : ''}</td>
          <td><button class="btn sm" onclick="returnBook(${l.id})">Приеми</button>
              <button class="btn sm" onclick="extendLoan(${l.id})"${maxRenew && (l.renewals || 0) >= maxRenew ? ' disabled title="Достигнат лимит на продълженията"' : ''}>Продължи</button>
              ${/* v2.4.56: третият изход на едно заемане. Дотук ги имаше само два —
                    „Приеми“ и „Продължи“ — и когато читателят кажеше „загубих я“,
                    библиотекарката натискаше „Приеми“, защото друго копче нямаше.
                    Оттам нататък книгата се водеше върната и на рафта. */''}
              <button class="btn sm" onclick="lostLoanDialog(${l.id})"
                title="Документът не е върнат от читателя — приключване с обезщетение или замяна">Изгубена</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
  } else {
    col1 = `<input id="pScan" class="scan" placeholder="Сканирай читателска карта или въведи име…" autocomplete="off">
      <div id="pSug" style="margin-top:10px"></div>`;
    col2 = `<div class="hint">Първо изберете читател — сканирайте картата или напишете част от името.</div>
      <div class="hint" style="margin-top:6px">След това сканирайте документите един след друг; всяко заемане се записва веднага.</div>`;
    /* v2.4.29: най-често отваряният екран стоеше празен под двете карти. „Днес на
       гишето“ показва какво е свършено през деня (от одитната следа — без нов канал). */
    table = `<div class="card circToday" id="circToday" style="margin-top:16px"><h3 style="margin-top:0">Днес на гишето</h3><div class="hint">Зарежда се…</div></div>`;
  }

  $('#view').innerHTML = tabs + `<div class="grid g2">
    <div class="card"><h3 style="margin-top:0">1 · Читател</h3>${col1}</div>
    <div class="card"><h3 style="margin-top:0">2 · Документи</h3>${col2}</div>
  </div>${table}`;
  if (!CIRC.readerId) circTodayPanel();

  const ps = $('#pScan');
  if (ps) {
    ps.focus();
    ps.addEventListener('input', debounce(async () => {
      const q = ps.value.trim();
      if (!q) { $('#pSug').innerHTML = ''; return; }
      // limit: полето показва само първите шест — няма смисъл да пренасяме останалите
      const rows = await call(window.api.readers.list(q, 20)) || [];
      /* Баркод четецът праща знаците и Enter за милисекунди: Enter-ът по-долу вече
         е пречертал екрана, а закъснелият debounce пише в откачен #pSug → TypeError
         при всяко сканиране на карта (одит v2.4.27, e2e). */
      const box = $('#pSug'); if (!box) return;
      box.innerHTML = rows.length
        ? rows.slice(0, 6).map(r => `<button class="btn" style="display:block;width:100%;text-align:left;margin-bottom:4px"
            onclick="selectCircReader(${r.id})"><b>${esc(r.name)}</b> · ${esc(r.card_no || '')} · ${esc(r.category || '')}</button>`).join('')
        : `<div class="hint">Няма съвпадение. <button class="btn sm" onclick="readerForm()">+ Нов читател</button></div>`;
    }, 200));
    ps.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const r = await call(window.api.readers.byCard(ps.value.trim()));
      if (r) selectCircReader(r.id); else toast('Няма читател с тази карта.', 'err');
    });
  }
  const bs = $('#bScan');
  if (bs) {
    bs.focus();
    bs.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const code = bs.value.trim(); bs.value = ''; if (!code) return;
      const res = await window.api.loans.checkoutByCode({ reader_id: CIRC.readerId, code, date_out: today() });
      const log = $('#outLog');
      if (!res.ok) { beep('err'); log.insertAdjacentHTML('afterbegin', `<div class="scanlog err">${esc(res.error)}</div>`); return; }
      beep('ok');
      const l = res.data;
      // v1.70.0: бутон за печат на разписка за заемане — по образец на
      // printReceiptLine() в account.js (квитанция за платена такса), но за
      // самото заемане, което дотогава нямаше никакъв печатен документ.
      // v2.2.0: читателят и инв. номерът се вграждат СЕГА, с jsq() навсякъде.
      // Дотогава printLoanSlip четеше CIRC.readerId чак при клика (междувременно
      // читателят може да е сменен → разписка на грешно име), а инв. номерът
      // минаваше през JSON.stringify — текстов баркод с кавичка чупеше onclick.
      const slip = `{title:'${jsq(l.title)}',inv_number:'${jsq(l.inv_number ?? '')}',`
        + `date_due:'${jsq(l.date_due)}',reader_name:'${jsq(circReader ? circReader.name : '')}',`
        + `reader_card:'${jsq(circReader ? (circReader.card_no || '') : '')}'}`;
      log.insertAdjacentHTML('afterbegin', `<div class="scanlog ok"><b>${esc(l.title)}</b> (инв. ${l.inv_number}) — заета до <b>${bg(l.date_due)}</b>
        <button class="btn sm" style="margin-left:8px" onclick="printLoanSlip(${slip})">Разписка</button></div>`);
      toast('Заемане: инв. № ' + l.inv_number + ' до ' + bg(l.date_due), 'ok');
      markSaved();
      // БЕЗ renderCirc(): пълният пререндер триеше журнала заедно с току-що
      // добавения бутон „Разписка“ (той мигваше и изчезваше) и подменяше #bScan
      // по средата на следващото сканиране — баркод четецът губеше знаци.
      // Променил се е само броят заети книги, затова се обновява само той.
      circOpen++;
      const cnt = $('#circCount');
      if (cnt) cnt.textContent = 'заети: ' + circOpen + (circMax ? ' / ' + circMax : '');
      bs.focus(); // курсорът остава в полето за сканиране
    });
  }
}
function selectCircReader(id) { CIRC.readerId = id; CIRC.mode = 'out'; renderCirc(); }
window.selectCircReader = selectCircReader;

/* Разписка за заемане (v1.70.0) — по образец на printReceiptLine() в
   account.js. loan идва директно от резултата на checkoutByCode (title/
   inv_number/date_due вече ги има).
   v2.2.0: името и картата на читателя се вграждат в бутона още при заемането
   (reader_name/reader_card). Дотогава читателят се дозареждаше по CIRC.readerId
   чак при клика — а журналът остава на екрана и след смяна на читателя, тоест
   разписката излизаше на името на СЛЕДВАЩИЯ читател. Дозареждането остава само
   като резерва за извиквания без вградени данни. */
async function printLoanSlip(loan) {
  const r = loan && loan.reader_name
    ? { name: loan.reader_name, card_no: loan.reader_card }
    : await call(window.api.readers.get(CIRC.readerId));
  if (!r) return;
  setPrintPage({ name: 'Разписка — ' + r.name + ' — инв. № ' + loan.inv_number, landscape: false, margin: '20mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 style="font-size:16pt">РАЗПИСКА ЗА ЗАЕМАНЕ</h2>
    <div class="pmeta">Дата: <b>${bg(today())}</b><br>
    Читател: <b>${esc(r.name)}</b>${r.card_no ? ' (карта ' + esc(r.card_no) + ')' : ''}<br>
    Документ: <b>${esc(loan.title)}</b>${loan.inv_number != null && loan.inv_number !== '' ? ' (инв. № ' + esc(loan.inv_number) + ')' : ''}<br>
    Срок за връщане: <b>${bg(loan.date_due)}</b></div>
    ${ssig(['Получил: …………………', 'Библиотекар: …………………'])}</div>`);
}
window.printLoanSlip = printLoanSlip;
async function returnBook(id) {
  const res = await window.api.loans.return({ id, date_in: today() });
  if (!res.ok) return toast(res.error, 'err');
  if (res.data && res.data.hold) {
    const h = res.data.hold;
    toast('📌 Заделена за ' + h.reader_name + (h.phone ? ' (тел. ' + h.phone + ')' : '') + ' — не се връща на рафта!', 'err');
  } else if (res.data && res.data.daysLate) {
    // v1.70.0: преди тук нямаше никакво съобщение за забава/глоба — само
    // сканираното връщане ("returnByCode") показваше тази информация.
    toast('Върната със забава ' + dni(res.data.daysLate) + ' (' + mny(res.data.fine) + ').', 'err');
  } else if (res.data && res.data.fine) {
    // Виж бележката при сканирането по-горе: начисленото при продължение остава
    // дължимо, макар спрямо новия падеж да няма забава.
    toast('Книгата е върната. Дължимо обезщетение по това заемане: ' + mny(res.data.fine) + '.', 'err');
  } else {
    toast('Книгата е върната.', 'ok');
  }
  if (res.data && res.data.suspendedUntil) {
    toast('⛔ Наложено наказание: заемането е преустановено до ' + bg(res.data.suspendedUntil) + '.', 'err');
  }
  markSaved();
  // Пречертава се ТЕКУЩИЯТ екран (v2.4.27): бутонът вече стои и на таблото.
  if (VIEW === 'over') renderOver(true); else if (VIEW === 'circ') renderCirc(); else if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.returnBook = returnBook;

/* ================================================================
   ДОКУМЕНТЪТ Е ИЗГУБЕН ИЛИ НЕВЪРНАТ ОТ ЧИТАТЕЛЯ (v2.4.56)
   ================================================================
   КАКВО СТАВАШЕ ДОТУК. Екранът предлагаше само „Приеми“ и „Продължи“. Читател,
   който съобщи, че е загубил книгата (или който просто не се появява повече), не
   се вписваше никъде: библиотекарката натискаше „Приеми“, за да слезе редът от
   списъка — тоест програмата записваше, че книгата е върната и стои на рафта, —
   после отваряше „Книги“ и сменяше състоянието на ръка, после отваряше картона и
   вписваше начисление „друго“. Трите действия не бяха свързани с нищо: месеци
   по-късно, когато се съставяше акт по чл. 30, т. 5, в него не личеше нито че за
   този документ има начислено обезщетение, нито дали е събрано.

   КАКВО ПРАВИ ТОЗИ ПРОЗОРЕЦ. Едно действие вместо три: приключва заемането с
   изрична отметка, че документът НЕ е върнат, слага му състояние „изгубен“ и
   записва кой от трите изхода е избран — обезщетение в пари, замяна с идентичен
   документ или замяна с равностоен документ.

   ЗА РАЗМЕРА — и защо е написано точно така в прозореца. Чл. 43, ал. 2 от
   Наредба № 3 урежда обезщетяването, но НЕ определя размера му; размерът е
   решение на библиотеката. Затова прозорецът казва с думи, че предложената сума
   идва от правило на библиотеката, показва самото правило (кратност × цена по
   инвентарната книга), позволява сумата да се смени на ръка и дава как да се
   промени правилото. Ако числото стоеше голо, след време щеше да се чете като
   изискване на наредбата — а то не е. */
async function lostLoanDialog(id) {
  const q = await call(window.api.loans.lostQuote({ id }));
  if (!q) return;
  window._LOST_Q = q;
  const p = q.policy || {};
  const basisText = q.basis === 'цена'
    ? `${p.multiplier} × цена по инвентарната книга (${mny(q.price)}) = <b>${mny(q.suggested)}</b>`
    : `документът е без вписана цена — предлага се сумата от правилото за такива случаи: <b>${mny(q.suggested)}</b>`;
  modal('Документът е изгубен — инв. № ' + (q.inv_number ?? '—'), `
    <div class="note d" style="margin-top:0">
      <b>${esc(q.title)}</b>${q.author ? ' · ' + esc(q.author) : ''} (инв. № ${q.inv_number ?? '—'})<br>
      Читател: <b>${esc(q.reader_name)}</b>${q.card_no ? ' (карта ' + esc(q.card_no) + ')' : ''} ·
      зает на ${bg(q.date_out)} · срок ${bg(q.date_due) || '—'}
      ${q.daysLate ? `<br>Забава <b>${dni(q.daysLate)}</b> — начислява се отделно
        ${q.fineToAdd ? '<b>' + mny(q.fineToAdd) + '</b>' : ''} за просрочие
        ${q.fineAccrued ? ' (вече начислено по това заемане: ' + mny(q.fineAccrued) + ')' : ''}` : ''}
    </div>
    <div class="note w">
      <b>Чл. 43, ал. 2 от Наредба № 3</b> урежда обезщетяването при невърнат документ, но
      <b>размерът се определя от библиотеката</b>, а не от наредбата. Сумата по-долу е
      предложение по правилото на вашата библиотека и се променя на ръка.
      <div class="hint" style="margin-top:4px">Правило: ${basisText}
        <button class="btn sm" style="margin-left:8px" onclick="lostPolicyDialog()">Промени правилото…</button></div>
    </div>
    <form id="lostF" onsubmit="return false">
      ${fld('Как се урежда случаят', 'resolution', {
        type: 'select', req: 1, allowEmpty: false, val: 'обезщетение',
        opts: (p.resolutions || ['обезщетение']).map(v => ({ v, t: v === 'обезщетение' ? 'Обезщетение в пари' : v.charAt(0).toUpperCase() + v.slice(1) })),
        onchange: 'lostFormToggle()'
      })}
      <div id="lostMoney">
        ${mnyField('Размер на обезщетението', 'amount', { req: 1, min: 0, val: q.suggested })}
        <div class="hint">Влиза в читателската сметка като отделно начисление
          „обезщетение за изгубен документ“ — различно от обезщетението за просрочие.</div>
      </div>
      <div id="lostRepl" hidden>
        ${fld('Инв. № / баркод на приетия вместо него документ', 'replacement_code', { hint: 'ако вече е вписан в „Книги“' })}
        ${fld('Описание на приетия документ', 'replacement_note', { hint: 'ако още няма инвентарен номер' })}
        <div class="hint">Приетият вместо изгубения документ е ново постъпление и се инвентира
          по общия ред (партида в „Постъпления“ и собствен инвентарен номер). Тук се записва само
          връзката, за да остане в следата кое е заместило кое.</div>
      </div>
      ${fld('Бележка', 'note', { type: 'textarea', rows: 2, val: '' })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn dgr" onclick="saveLostLoan(${id})">Приключи като изгубен</button>`);
  lostFormToggle();
}
window.lostLoanDialog = lostLoanDialog;
/* Полетата се СКРИВАТ, а не се изтриват и пресъздават: скритото поле пази
   написаното, ако библиотекарят превключи между „обезщетение“ и „замяна“ и се
   върне обратно. `el.hidden`, не style.display — така и четците на екран го
   пропускат. */
function lostFormToggle() {
  const f = $('#lostF'); if (!f) return;
  const sel = f.querySelector('[name="resolution"]');
  const money = $('#lostMoney'), repl = $('#lostRepl');
  const isMoney = !sel || sel.value === 'обезщетение';
  if (money) money.hidden = !isMoney;
  if (repl) repl.hidden = isMoney;
  /* Задължителността се мести заедно с видимостта: скрито поле с required не
     може да бъде попълнено, а спираше запазването — същият капан, заради който
     firstMissingRequired() в core.js изобщо съществува. */
  const amt = f.querySelector('[name="amount"]');
  if (amt) { if (isMoney) amt.setAttribute('required', 'required'); else amt.removeAttribute('required'); }
}
window.lostFormToggle = lostFormToggle;
async function saveLostLoan(id) {
  const d = formData('#lostF');
  if (d.resolution === 'обезщетение' && (!d.amount || Number(d.amount) <= 0)) {
    return toast('Въведете размер на обезщетението или изберете замяна с документ.', 'err');
  }
  if (d.resolution !== 'обезщетение' && !String(d.replacement_code || '').trim() && !String(d.replacement_note || '').trim()) {
    return toast('Запишете кой документ е приет вместо изгубения — инв. № или описание.', 'err');
  }
  const q = window._LOST_Q || {};
  const what = d.resolution === 'обезщетение'
    ? 'ще бъдат начислени ' + mny(d.amount) + ' в сметката на ' + (q.reader_name || 'читателя')
    : 'ще се запише ' + d.resolution;
  if (!await askConfirm('Инв. № ' + (q.inv_number ?? '—') + ' се приключва като НЕВЪРНАТ от читателя — '
    + what + '. Документът получава състояние „изгубен“ и подлежи на отчисляване с акт по чл. 30, т. 5.',
    { kind: 'danger', okLabel: 'Приключи' })) return;
  const res = await call(window.api.loans.markLost({
    id, resolution: d.resolution, amount: d.amount,
    replacement_code: d.replacement_code, replacement_note: d.replacement_note,
    note: d.note, date: today()
  }));
  if (!res) return;
  closeModal();
  markSaved();
  toast('Инв. № ' + (res.inv_number ?? '—') + ' е приключен като изгубен'
    + (res.amount ? ' — начислени ' + mny(res.amount) + ' на ' + res.reader_name : '')
    + (res.replacement ? ' — прието вместо него: инв. № ' + (res.replacement.inv_number ?? '—') : '')
    + '.', 'err');
  if (res.suspendedUntil) toast('⛔ Наложено наказание: заемането е преустановено до ' + bg(res.suspendedUntil) + '.', 'err');
  toast('Отчислете документа с акт по чл. 30, т. 5 от раздел „Отчисляване“.', 'ok');
  if (VIEW === 'over') renderOver(true); else if (VIEW === 'circ') renderCirc(); else if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.saveLostLoan = saveLostLoan;
/* Правилото се редактира от мястото, на което се прилага. Истинското му място е
   „Настройки“ (виж доклада — там трябва да се добави поле), но дотогава
   библиотекарят не бива да е заключен с число, което не може да промени: точно
   това би превърнало предложението в „изискване на програмата“. */
function lostPolicyDialog() {
  const p = (window._LOST_Q && window._LOST_Q.policy) || {};
  const def = p.defaults || {};
  modal2('Правило за обезщетение при изгубен документ', `
    <div class="note w" style="margin-top:0">Размерът на обезщетението се определя от библиотеката
      (вътрешни правила по чл. 43, ал. 2 от Наредба № 3). Наредбата не задава число — тук се записва
      решението на вашата библиотека и то се използва само като предложение.</div>
    <form id="lostPolF" onsubmit="return false">
      ${fld('Кратност спрямо цената по инвентарната книга', 'multiplier', {
        type: 'number', step: '0.1', min: 0, req: 1, val: p.multiplier ?? def.multiplier,
        hint: 'например 3 = троен размер на цената' })}
      ${mnyField('За документ без вписана цена', 'fallback', { req: 1, min: 0, val: p.fallback ?? def.fallback })}
    </form>`,
    `<button class="btn" onclick="closeModal2()">Отказ</button>
     <button class="btn pri" onclick="saveLostPolicy()">Запази правилото</button>`);
}
window.lostPolicyDialog = lostPolicyDialog;
async function saveLostPolicy() {
  const d = formData('#lostPolF');
  const p = await call(window.api.loans.lostPolicySave({ multiplier: d.multiplier, fallback: d.fallback }), 'Правилото е записано.');
  if (!p) return;
  closeModal2();
  /* Отвореният отдолу прозорец носи ПРЕДЛОЖЕНА сума по старото правило — ако
     остане, библиотекарят ще начисли по правило, което току-що е сменил.
     Затова се пресъздава от нулата със същото заемане. */
  const q = window._LOST_Q;
  if (q && q.loan_id) lostLoanDialog(q.loan_id);
}
window.saveLostPolicy = saveLostPolicy;

/* Брояч „читалня" — едно натискане = едно ползване на място. Влиза в потока от
   събития и оттам в предложенията за дневника (a_visit_reading). */
async function logLocaluse() {
  const ok = await call(window.api.events.localuse({}));
  if (ok !== null) toast('📖 Отбелязано ползване в читалнята за днес.', 'ok');
}
window.logLocaluse = logLocaluse;

/* „Днес на гишето“ (v2.4.29): броят заемания и връщания за деня и последните
   операции — от одитната следа (последните 500 реда), в местно време. */
async function circTodayPanel() {
  const box = $('#circToday'); if (!box) return;
  const rows = await call(window.api.audit.list('')) || [];
  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  // Следата пази UTC („YYYY-MM-DD HH:MM:SS“); „днес“ е местният ден, не today() (UTC).
  const t = localDate(new Date());
  const local = (ts) => {
    const raw = String(ts || '');
    const d = new Date(/[TZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return null;
    return { date: localDate(d), time: pad(d.getHours()) + ':' + pad(d.getMinutes()) };
  };
  const ops = rows.map(r => ({ ...r, at: local(r.ts) }))
    .filter(r => r.at && r.at.date === t && (r.action === 'Заемане' || r.action === 'Връщане'));
  if (!$('#circToday')) return; // междувременно е избран читател
  const out = ops.filter(r => r.action === 'Заемане').length, back = ops.length - out;
  box.innerHTML = `<h3 style="margin-top:0">Днес на гишето</h3>
    <div class="setupChips" style="margin-bottom:${ops.length ? 10 : 0}px">
      <span class="chip ${out ? 'ok' : ''}">${pl(out, 'заемане', 'заемания')}</span>
      <span class="chip ${back ? 'ok' : ''}">${pl(back, 'връщане', 'връщания')}</span>
      ${rows.length >= 500 ? '<span class="chip" title="Одитната следа се чете до 500 реда назад">последните 500 записа</span>' : ''}
    </div>
    ${ops.length ? `<div class="circOps">${ops.slice(0, 8).map(r => `<div class="circOp">
        <span class="num">${r.at.time}</span>
        <span class="badge ${r.action === 'Заемане' ? 'ok' : ''}">${r.action === 'Заемане' ? 'заемане' : 'връщане'}</span>
        <span class="circOpText">${esc(r.detail || '')}</span>
        <span class="hint">${esc(r.user || '')}</span></div>`).join('')}</div>`
      : '<div class="hint">Още няма заемания или връщания днес.</div>'}`;
}
window.circTodayPanel = circTodayPanel;
