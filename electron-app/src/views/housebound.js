/* ---------------- Обслужване по домовете ---------------- */
async function houseboundModal(readerId) {
  const [r, hb] = await Promise.all([
    call(window.api.readers.get(readerId)), call(window.api.housebound.get(readerId))
  ]);
  if (!r || !hb) return;
  const p = hb.profile || {};
  modal('🏠 Обслужване по домовете — ' + r.name, `
    <div class="note" style="margin-top:0">За читатели, които не могат да идват до библиотеката.
    Всяко вписано посещение влиза автоматично в предложенията за дневника
    (колона „В заемна за дома“). Самите заемания се оформят по обичайния ред.</div>
    <form id="hbF" onsubmit="return false">
      <div class="grid g3">
        ${fld('Предпочитан ден', 'day', { type: 'select', opts: ['понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'], val: p.day || '' })}
        ${fld('Честота', 'frequency', { type: 'select', opts: ['седмично', 'двуседмично', 'месечно'], val: p.frequency || '' })}
        ${fld('Бележка', 'note', { val: p.note || '', hint: 'адрес за посещение, особености' })}
      </div>
    </form>
    <div class="toolbar">
      <button class="btn pri" onclick="saveHousebound(${readerId})">${hb.profile ? 'Запиши графика' : 'Включи в обслужване по домовете'}</button>
      ${hb.profile ? `<button class="btn" onclick="addHouseboundVisit(${readerId})">+ Посещение днес</button>
      <button class="btn dgr" onclick="removeHousebound(${readerId})">Изключи от списъка</button>` : ''}
    </div>
    ${hb.visits.length ? `<h3 style="font-size:14px;margin-bottom:6px">Последни посещения</h3>
      <div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><tbody>
      ${hb.visits.map(v2 => `<tr><td class="num">${bg(v2.date)}</td><td>${esc(v2.note || '')}</td></tr>`).join('')}
      </tbody></table></div>` : ''}`,
    `<button class="btn" onclick="closeModal()">Затвори</button>`);
}
window.houseboundModal = houseboundModal;
async function saveHousebound(readerId) {
  const d = formData('#hbF');
  const ok = await call(window.api.housebound.save({ reader_id: readerId, day: d.day, frequency: d.frequency, note: d.note }),
    'Графикът е записан.');
  if (ok !== null) houseboundModal(readerId);
}
window.saveHousebound = saveHousebound;
async function addHouseboundVisit(readerId) {
  const note = await askText('Ново посещение', {
    label: 'Бележка към посещението', hint: 'по желание', okLabel: 'Впиши'
  });
  if (note === null) return; // отказ — посещението не се вписва
  const ok = await call(window.api.housebound.addVisit({ reader_id: readerId, note }), 'Посещението е вписано.');
  if (ok !== null) houseboundModal(readerId);
}
window.addHouseboundVisit = addHouseboundVisit;
async function removeHousebound(readerId) {
  if (!await askConfirm('Изключване на читателя от обслужване по домовете? Историята на посещенията се пази.', { okLabel: 'Изключи' })) return;
  const ok = await call(window.api.housebound.remove(readerId), 'Изключен от списъка.');
  if (ok !== null) closeModal();
}
window.removeHousebound = removeHousebound;
async function extendLoan(id) {
  const res = await window.api.loans.extend({ id });
  if (!res.ok) return toast(res.error, 'err');
  const { date_due, renewals, max, daysLate, fine, suspendedUntil } = res.data;
  /* Продължението на ПРОСРОЧЕНО заемане урежда натрупаното (обезщетение и наказание
     в дни) — виж loans:extend. Дотук екранът показваше само зеленото „Срокът е
     продължен“, а наказанието изникваше чак при следващото заемане, без обяснение
     откъде идва. Пътят при връщане (returnBook по-долу) отдавна ги показва. */
  // Успехът си остава зелен — червените известия отдолу носят лошата новина.
  toast('Срокът е продължен до ' + bg(date_due) + ' (продължение ' + renewals + (max ? '/' + max : '') + ').', 'ok');
  if (daysLate) {
    toast('Начислена забава ' + daysLate + (daysLate === 1 ? ' ден' : ' дни')
      + (fine ? ' — обезщетение ' + mny(fine) : '') + '.', 'err');
  }
  if (suspendedUntil) {
    toast('⛔ Наложено наказание: заемането е преустановено до ' + bg(suspendedUntil) + '.', 'err');
  }
  markSaved();
  if (VIEW === 'over') renderOver(true); else renderCirc();
}
window.extendLoan = extendLoan;
