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
        <td>${/* КВИТАНЦИЯ САМО ЗА ПОЛУЧЕНИ ПАРИ (v2.4.71, находка Ч8).
              (а) Бутонът „Квитанция“ стоеше и на ред-начисление и печаташе
                  „КВИТАНЦИЯ № … Начислена сума … Получил: ………“ — касов документ
                  за пари, които никой не е давал.
              (б) Квитанцията удостоверява получено плащане; подписана за
                  начисление, тя е невярен касов документ.
              (в) На плащането — „Квитанция“; на начислението — „Известие“:
                  документ „ИЗВЕСТИЕ ЗА НАЧИСЛЕНИЕ“, с „Дължима сума“ и подпис
                  „Запознат(а)“ вместо „Получил“. */''}${l.kind === 'плащане'
          ? `<button class="btn sm" onclick="printReceiptLine(${l.id})">Квитанция</button>`
          : `<button class="btn sm" onclick="printReceiptLine(${l.id})" title="Известие до читателя за начислената сума — не е квитанция">Известие</button>`}
            <button class="btn sm dgr" onclick="deleteAccountLine(${readerId},${l.id})">✕</button></td></tr>`).join('')
        : '<tr><td colspan="5" class="empty">Няма движения.</td></tr>'}
    </tbody></table></div>`,
    `<button class="btn" onclick="closeModal()">Затвори</button>`);
}
window.accountModal = accountModal;
async function chargeAnnualFee(readerId, fee) {
  if (!fee) return;
  if (!await askConfirm('Начисли годишна такса ' + mny(fee) + '?', { okLabel: 'Начисли' })) return;
  const id = await call(window.api.account.charge({ reader_id: readerId, type: 'годишна такса', amount: fee, date: today() }), 'Начислено.');
  if (id != null) { markSaved(); accountModal(readerId); }
}
window.chargeAnnualFee = chargeAnnualFee;
/* ВИДОВЕТЕ В „ДРУГО НАЧИСЛЕНИЕ“ И ЗАБАВАТА (v2.4.69, находка Г2).
   (а) Дотук „обезщетение“ в това меню беше СЪЩИЯТ низ, с който програмата
       пишеше забавата. Възпроизведено: забава 1,70 € платена; същия ден 5 € за
       повредена корица оттук → „Просрочени“, писмото по чл. 43 и SMS-ът пак
       искат платената забава („начислено 2,30, платено 0“).
   (б) Писмото по чл. 43 е подписан документ с искане за пари — не бива да иска
       платено.
   (в) Забавата вече има собствен вид („забава“), който пише само програмата
       (handlers/account.js отказва ръчното му начисление); тук „обезщетение“ е
       назовано с думи за какво е, а подсказката казва, че забавата не се
       начислява оттук. Стойността (`v`) остава „обезщетение“ — по нея
       справките я броят сред събраните обезщетения. */
const ACC_OTHER_TYPES = [
  { v: 'годишна такса', t: 'годишна такса' },
  { v: 'обезщетение', t: 'обезщетение — повреда, изгубен картон и др. (не забава)' },
  { v: 'друго', t: 'друго' }
];
function chargeOther(readerId) {
  modal2('Ново начисление', `
    <form id="chgF" onsubmit="return false">
      ${fld('Вид', 'type', { type: 'select', opts: ACC_OTHER_TYPES, val: 'друго', allowEmpty: false,
        hint: 'забавата за просрочие програмата начислява сама — при връщане, продължение и „Изгубена“' })}
      ${mnyField('Сума', 'amount', { req: 1, min: 0 })}
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
      ${mnyField('Сума', 'amount', { req: 1, min: 0 })}
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
/* ✕ НА РЕД ОТ СМЕТКАТА (v2.4.71, находки Ч12 и Ч2).
   Плащане: квитанцията вече е у читателя (печата се при записа), затова се пита
   ПРИЧИНА — без нея обработчикът отказва (account:deleteLine) — и после се казва
   да се поиска квитанцията обратно. Забава: обработчикът намалява и сумата по
   заемането, за да не я поиска пак писмото по чл. 43; екранът казва какво е
   станало (или че заемането не е намерено). */
async function deleteAccountLine(readerId, id) {
  const line = (window._ACC_LINES || []).find(l => l.id === id);
  const isPayment = !!(line && line.kind === 'плащане');
  let reason = '';
  if (isPayment) {
    const t = await askText('Анулиране на плащане — квитанция № ' + id, {
      label: 'Причина за анулирането', okLabel: 'Анулирай',
      hint: 'напр. „сгрешена сума, вписана наново“ — влиза в одитната следа',
      note: 'Квитанция № ' + id + ' за ' + mny(Math.abs(Number(line.amount) || 0)) + ' вече е издадена на читателя. '
        + 'Анулирането маха плащането от сметката; поискайте квитанцията обратно.'
    });
    if (t == null) return;
    reason = String(t).trim();
    if (!reason) return toast('Впишете причина за анулирането — плащането има издадена квитанция. Нищо не е изтрито.', 'err');
  } else if (!await askConfirm(line && line.type === 'забава'
    ? 'Изтриване (опрощаване) на забавата ' + mny(Math.abs(Number(line.amount) || 0)) + '? Сумата се маха и от заемането — писмото по чл. 43 вече няма да я иска.'
    : 'Изтриване на записа от сметката?')) return;
  const res = await call(window.api.account.deleteLine(isPayment ? { id, reason } : id));
  if (res === null) return;
  toast(isPayment ? 'Плащането е анулирано (квитанция № ' + id + ') — поискайте квитанцията обратно от читателя.' : 'Изтрито.', 'ok');
  if (res && res.loan) {
    toast('Забавата по заемането на инв. № ' + (res.loan.inv_number ?? '—') + ' е намалена от ' + mny(res.loan.before)
      + ' на ' + mny(res.loan.after) + '.', 'ok');
  }
  if (res && res.warning) toast(res.warning, 'err');
  markSaved(); accountModal(readerId);
}
window.deleteAccountLine = deleteAccountLine;
function printReceiptLine(lineId) {
  const line = (window._ACC_LINES || []).find(l => l.id === lineId);
  const r = window._ACC_READER;
  if (!line || !r) return;
  const bal = Number(window._ACC_BALANCE);
  const hasBal = Number.isFinite(bal);
  // Квитанция — само за плащане; за начисление — известие (v2.4.71, Ч8, виж бележката в таблицата).
  const isPay = line.kind === 'плащане';
  const docName = isPay ? 'КВИТАНЦИЯ' : 'ИЗВЕСТИЕ ЗА НАЧИСЛЕНИЕ';
  setPrintPage({ name: (isPay ? 'Квитанция' : 'Известие за начисление') + ' № ' + line.id + ' — ' + r.name + ' — ' + bg(line.date), landscape: false, margin: '20mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2 style="font-size:16pt">${docName} № ${line.id} / ${bg(line.date)}</h2>
    <div class="pmeta">Дата: <b>${bg(line.date)}</b><br>
    Читател: <b>${esc(r.name)}</b>${r.card_no ? ' (карта ' + esc(r.card_no) + ')' : ''}<br>
    ${isPay ? 'Платена сума' : 'Дължима сума'}: <b>${mny(Math.abs(line.amount))}</b><br>
    Основание: <b>${esc(line.type || line.kind)}</b>${line.note ? '<br>Бележка: ' + esc(line.note) : ''}
    ${/* Дотук квитанцията носеше само сумата на едно движение и нищо повече:
          читател, платил част от глобата си, си тръгваше с документ, от който не
          личи дали дължи още. Състоянието на сметката КЪМ МОМЕНТА НА ПЕЧАТА се
          изписва изрично, със същото число, което стои и в самата сметка. */''}
    ${hasBal ? `<br><br>Състояние на сметката към ${bg(today())} г.: <b>${
      bal > 0 ? 'дължими ' + mny(bal) : bal < 0 ? 'надплатени ' + mny(-bal) : 'няма задължение (0.00 €)'
    }</b>` : ''}</div>
    <div class="pmeta" style="font-size:9pt">${isPay
      ? 'Квитанцията отразява едно движение по сметката на читателя. Номерът ѝ е поредният номер на движението в регистъра на сметките.'
      : 'Известието уведомява читателя за начислена сума по сметката му. То НЕ е квитанция и не удостоверява плащане. '
        + 'Номерът му е поредният номер на движението в регистъра на сметките.'}</div>
    ${ssig(isPay ? ['Получил: …………………', 'Библиотекар: …………………'] : ['Запознат(а): …………………', 'Библиотекар: …………………'])}</div>`);
}
window.printReceiptLine = printReceiptLine;
