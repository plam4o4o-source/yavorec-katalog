/* ---------------- Читателска сметка ---------------- */
async function accountModal(readerId) {
  const [r, acc, s] = await Promise.all([
    call(window.api.readers.get(readerId)), call(window.api.account.get(readerId)), call(window.api.settings.get())
  ]);
  if (!r || !acc) return;
  window._ACC_READER = r;
  window._ACC_LINES = acc.lines;
  /* Квитанцията се печата от този списък и трябва да каже какво ОСТАВА да се
     дължи след дадено движение — иначе читателят плаща глоба и си тръгва с лист
     хартия, който не отговаря на единствения въпрос, който има. Балансът се пази
     тук, а не се смята в разпечатката, за да е ЕДНО И СЪЩО число с това в горния
     десен ъгъл на сметката (същото закръгляне до стотинки). */
  window._ACC_BALANCE = Math.round((Number(acc.balance) || 0) * 100) / 100;
  /* Сравнява се закръглената до стотинки сума, а не суровата. account:get вече
     закръгля, но балансът минава и през стари/чужди пътища (кеширани данни от
     предишна версия), а разликата от порядъка на 1e-16 е достатъчна, за да се
     изпише „0.00 лв. (дължи)" в червено на платена докрай сметка. Показва се
     същата закръглена стойност, която се и сравнява. */
  const bal = Math.round((Number(acc.balance) || 0) * 100) / 100;
  const balColor = bal > 0 ? 'var(--red)' : (bal < 0 ? 'var(--green)' : 'inherit');
  const fee = (s && s.annual_fee) ? Number(s.annual_fee) : 0;
  modal('Сметка — ' + r.name, `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div class="hint">Карта ${esc(r.card_no || '—')}</div>
      <div style="font-size:1.1rem"><b style="color:${balColor}">${mny(bal)}</b>
        <span class="hint">${bal > 0 ? ' (дължи)' : bal < 0 ? ' (надплатено)' : ''}</span></div>
    </div>
    <div class="toolbar">
      <button class="btn sm" onclick="chargeAnnualFee(${readerId}, ${fee})" ${fee ? '' : 'disabled title="Годишната такса в Настройки е 0"'}>
        + Годишна такса (${mny(fee)})</button>
      <button class="btn sm" onclick="chargeOther(${readerId})">+ Друго начисление…</button>
      <button class="btn sm pri" onclick="payAccount(${readerId})">Плащане…</button>
    </div>
    <div class="wrap" style="margin-top:10px"><table class="ledger"><thead><tr>
      <th>Дата</th><th>Вид</th><th>Сума</th><th>Бележка</th><th style="width:130px"></th></tr></thead><tbody>
      ${acc.lines.length ? acc.lines.map(l => `<tr><td class="num">${bg(l.date)}</td>
        <td>${esc(l.type || l.kind)}</td>
        <td class="num" style="color:${l.amount > 0 ? 'var(--red)' : 'var(--green)'}">${l.amount > 0 ? '+' : ''}${mny(l.amount)}</td>
        <td style="font-size:12px">${esc(l.note || '')}</td>
        <td><button class="btn sm" onclick="printReceiptLine(${l.id})">Квитанция</button>
            <button class="btn sm dgr" onclick="deleteAccountLine(${readerId},${l.id})">✕</button></td></tr>`).join('')
        : '<tr><td colspan="5" class="empty">Няма движения.</td></tr>'}
    </tbody></table></div>`,
    `<button class="btn" onclick="closeModal()">Затвори</button>`);
}
window.accountModal = accountModal;
async function chargeAnnualFee(readerId, fee) {
  if (!fee) return;
  if (!confirm('Начисли годишна такса ' + mny(fee) + '?')) return;
  const id = await call(window.api.account.charge({ reader_id: readerId, type: 'годишна такса', amount: fee, date: today() }), 'Начислено.');
  if (id != null) { markSaved(); accountModal(readerId); }
}
window.chargeAnnualFee = chargeAnnualFee;
function chargeOther(readerId) {
  modal2('Ново начисление', `
    <form id="chgF" onsubmit="return false">
      ${fld('Вид', 'type', { type: 'select', opts: ['годишна такса', 'обезщетение', 'друго'], val: 'друго', allowEmpty: false })}
      ${fld('Сума (лв.)', 'amount', { type: 'number', step: '0.01', val: '', req: 1 })}
      ${fld('Бележка', 'note', { val: '' })}
    </form>`,
    `<button class="btn" onclick="closeModal2()">Отказ</button>
     <button class="btn pri" onclick="saveCharge(${readerId})">Начисли</button>`);
}
window.chargeOther = chargeOther;
async function saveCharge(readerId) {
  const d = formData('#chgF');
  if (!d.amount || Number(d.amount) <= 0) return toast('Въведете сума.', 'err');
  const id = await call(window.api.account.charge({ reader_id: readerId, type: d.type, amount: d.amount, note: d.note, date: today() }), 'Начислено.');
  if (id != null) { closeModal2(); markSaved(); accountModal(readerId); }
}
window.saveCharge = saveCharge;
function payAccount(readerId) {
  modal2('Плащане', `
    <form id="payF" onsubmit="return false">
      ${fld('Сума (лв.)', 'amount', { type: 'number', step: '0.01', val: '', req: 1 })}
      ${fld('Бележка', 'note', { val: '' })}
    </form>`,
    `<button class="btn" onclick="closeModal2()">Отказ</button>
     <button class="btn pri" onclick="savePayment(${readerId})">Плати</button>`);
}
window.payAccount = payAccount;
async function savePayment(readerId) {
  const d = formData('#payF');
  if (!d.amount || Number(d.amount) <= 0) return toast('Въведете сума.', 'err');
  const id = await call(window.api.account.pay({ reader_id: readerId, amount: d.amount, note: d.note, date: today() }), 'Записано плащане.');
  // accountModal е async и презарежда window._ACC_LINES — трябва да се ИЗЧАКА, преди
  // printReceiptLine да потърси там току-що записания ред. Без await квитанцията се
  // търсеше в стария списък (отпреди плащането), не се намираше и функцията излизаше
  // мълчаливо — плащането се записваше, но квитанция не се отпечатваше никога.
  if (id != null) { closeModal2(); markSaved(); await accountModal(readerId); printReceiptLine(id); }
}
window.savePayment = savePayment;
async function deleteAccountLine(readerId, id) {
  if (!confirm('Изтриване на записа от сметката?')) return;
  const ok = await call(window.api.account.deleteLine(id), 'Изтрито.');
  if (ok !== null) { markSaved(); accountModal(readerId); }
}
window.deleteAccountLine = deleteAccountLine;
function printReceiptLine(lineId) {
  const line = (window._ACC_LINES || []).find(l => l.id === lineId);
  const r = window._ACC_READER;
  if (!line || !r) return;
  const bal = Number(window._ACC_BALANCE);
  const hasBal = Number.isFinite(bal);
  setPrintPage({ name: 'Квитанция № ' + line.id + ' — ' + r.name + ' — ' + bg(line.date), landscape: false, margin: '20mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 style="font-size:16pt">КВИТАНЦИЯ № ${line.id} / ${bg(line.date)}</h2>
    <div class="pmeta">Дата: <b>${bg(line.date)}</b><br>
    Читател: <b>${esc(r.name)}</b>${r.card_no ? ' (карта ' + esc(r.card_no) + ')' : ''}<br>
    ${line.kind === 'плащане' ? 'Платена сума' : 'Начислена сума'}: <b>${mny(Math.abs(line.amount))}</b><br>
    Основание: <b>${esc(line.type || line.kind)}</b>${line.note ? '<br>Бележка: ' + esc(line.note) : ''}
    ${/* Дотук квитанцията носеше само сумата на едно движение и нищо повече:
          читател, платил част от глобата си, си тръгваше с документ, от който не
          личи дали дължи още. Състоянието на сметката КЪМ МОМЕНТА НА ПЕЧАТА се
          изписва изрично, със същото число, което стои и в самата сметка. */''}
    ${hasBal ? `<br><br>Състояние на сметката към ${bg(today())} г.: <b>${
      bal > 0 ? 'дължими ' + mny(bal) : bal < 0 ? 'надплатени ' + mny(-bal) : 'няма задължение (0.00 лв.)'
    }</b>` : ''}</div>
    <div class="pmeta" style="font-size:9pt">Квитанцията отразява едно движение по сметката на читателя.
    Номерът ѝ е поредният номер на движението в регистъра на сметките.</div>
    ${ssig(['Получил: …………………', 'Библиотекар: …………………'])}</div>`);
}
window.printReceiptLine = printReceiptLine;
