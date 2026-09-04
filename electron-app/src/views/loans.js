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
    const rule = await call(window.api.circRules.effective(r.category)) || s;
    const myLoans = await call(window.api.loans.byReader(CIRC.readerId)) || [];
    const openMine = myLoans.filter(l => !l.date_in);
    circReader = r; circOpen = openMine.length; circMax = rule.max_books || 0;
    col1 = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:8px"><div style="flex:1">
      <b style="font-size:17px">${esc(r.name)}</b>
      <div class="hint">Карта ${esc(r.card_no || '—')} · ${esc(r.category || '')} ·
        <span id="circCount">заети: ${circOpen}${circMax ? ' / ' + circMax : ''}</span></div></div>
      <button class="btn sm" onclick="accountModal(${r.id})" title="Читателска сметка">💰</button>
      <button class="btn sm" onclick="houseboundModal(${r.id})" title="Обслужване по домовете — график и посещения">🏠</button>
      <button class="btn sm" onclick="CIRC.readerId=null;renderCirc()">Смени</button></div>
      ${r.alert_note ? `<div class="note w" style="border-left-color:#c9a84c;background:rgba(201,168,76,.12)">📌 <b>${esc(r.alert_note)}</b></div>` : ''}
      ${r.guarantor_name ? `<div class="hint">👪 Родител/настойник: <b>${esc(r.guarantor_name)}</b>${r.guarantor_phone ? ' · тел. ' + esc(r.guarantor_phone) : ''}</div>` : ''}
      ${r.suspended_until && r.suspended_until > today() ? `<div class="note w">⛔ Заемането е преустановено до <b>${bg(r.suspended_until)}</b>.
        <button class="btn sm" style="margin-left:8px" onclick="clearSuspension(${r.id})">Снеми</button></div>` : ''}
      ${acc && acc.balance > 0 ? `<div class="hint">💰 Дължи по сметка: <b style="color:var(--red)">${mny(acc.balance)}</b></div>` : ''}
      ${openMine.some(l => l.date_due && l.date_due < today()) ? '<div class="note w">Читателят има просрочени документи.</div>' : ''}`;
    const myHolds = (await call(window.api.holds.list()) || []).filter(h => h.reader_id === CIRC.readerId);
    const maxRenew = rule.extensions_count == null ? 2 : rule.extensions_count;
    col2 = `<input id="bScan" class="scan" placeholder="Сканирай баркод на документа…" autocomplete="off">
      <div class="hint" style="margin-top:6px">Срок за заемане: ${dni(rule.loan_days)}${maxRenew ? ' · до ' + pl(maxRenew, 'продължение', 'продължения') : ''}</div>
      <div class="toolbar" style="margin:10px 0 0">
        <button class="btn sm" onclick="holdPrompt()">📌 Резервирай заета книга…</button>
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
        <th>Инв. №</th><th>Заглавие</th><th>Зает</th><th>Срок</th><th>Продължения</th><th style="width:160px"></th></tr></thead><tbody>
        ${openMine.map(l => `<tr><td class="num">${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
          <td class="num">${bg(l.date_out)}</td>
          <td class="num ${l.date_due && l.date_due < today() ? 'warn' : ''}">${bg(l.date_due) || '—'}</td>
          <td class="num">${l.renewals || 0}${maxRenew ? ' / ' + maxRenew : ''}</td>
          <td><button class="btn sm" onclick="returnBook(${l.id})">Приеми</button>
              <button class="btn sm" onclick="extendLoan(${l.id})"${maxRenew && (l.renewals || 0) >= maxRenew ? ' disabled title="Достигнат лимит на продълженията"' : ''}>Продължи</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
  } else {
    col1 = `<input id="pScan" class="scan" placeholder="Сканирай читателска карта или въведи име…" autocomplete="off">
      <div id="pSug" style="margin-top:10px"></div>`;
    col2 = `<div class="hint">Първо изберете читател.</div>`;
  }

  $('#view').innerHTML = tabs + `<div class="grid g2">
    <div class="card"><h3 style="margin-top:0">1 · Читател</h3>${col1}</div>
    <div class="card"><h3 style="margin-top:0">2 · Документи</h3>${col2}</div>
  </div>${table}`;

  const ps = $('#pScan');
  if (ps) {
    ps.focus();
    ps.addEventListener('input', debounce(async () => {
      const q = ps.value.trim();
      if (!q) { $('#pSug').innerHTML = ''; return; }
      // limit: полето показва само първите шест — няма смисъл да пренасяме останалите
      const rows = await call(window.api.readers.list(q, 20)) || [];
      $('#pSug').innerHTML = rows.length
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
  if (VIEW === 'over') renderOver(true); else renderCirc();
}
window.returnBook = returnBook;
/* Брояч „читалня" — едно натискане = едно ползване на място. Влиза в потока от
   събития и оттам в предложенията за дневника (a_visit_reading). */
async function logLocaluse() {
  const ok = await call(window.api.events.localuse({}));
  if (ok !== null) toast('📖 Отбелязано ползване в читалнята за днес.', 'ok');
}
window.logLocaluse = logLocaluse;
