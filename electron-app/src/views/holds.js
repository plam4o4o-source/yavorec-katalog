/* ---------------- Резервации ---------------- */
async function renderHolds(tabs) {
  const rows = await call(window.api.holds.list());
  if (!rows) return;
  $('#view').innerHTML = tabs + `
    <div class="toolbar"><button class="btn pri" onclick="holdPrompt()">+ Нова резервация</button></div>
    ${!rows.length ? '<div class="empty"><h3>Няма активни резервации</h3><p>Резервирайте заета книга, докато читателят чака за нея.</p></div>' : `
    <div class="wrap"><table class="ledger"><thead><tr>
      <th>Инв. №</th><th>Заглавие</th><th>Читател</th><th>Заявена</th><th>Състояние</th><th style="width:110px"></th>
    </tr></thead><tbody>
      ${rows.map(h => `<tr><td class="num">${h.inv_number ?? ''}</td><td>${esc(h.title)}</td>
        <td>${esc(h.reader_name)} <span class="hint">(${esc(h.card_no || '')})</span></td>
        <td class="num">${bg((h.placed_at || '').slice(0, 10))}</td>
        <td>${h.status === 'заделена' ? '<span class="badge ok">заделена — чака взимане</span>' : '<span class="badge">чака в опашка</span>'}</td>
        <td><button class="btn sm" onclick="cancelHold(${h.id})">Откажи</button></td></tr>`).join('')}
    </tbody></table></div>`}`;
}
/* Чия е резервацията се вижда ВИНАГИ — и във формата преди записа, и в
   потвърждението. CIRC.readerId (разделът „Заемане“) оцелява при смяна на
   подраздела, а формата питаше само за книгата: резервацията мълчаливо се
   записваше на читателя, останал избран отпреди, и нито едно съобщение не
   издаваше на кого. Затова името се изписва изрично, с бутон за смяна до него.
   readerId се подава при смяна на читателя (null = питай наново). */
async function holdPrompt(readerId) {
  let reader = null;
  const rid = readerId === undefined ? CIRC.readerId : readerId;
  if (rid) reader = await call(window.api.readers.get(rid));
  if (!reader) {
    const cardOrName = await askText('Нова резервация', {
      label: 'Читател', hint: 'номер на карта или име', okLabel: 'Напред'
    });
    if (!cardOrName || !cardOrName.trim()) return;
    reader = await call(window.api.readers.byCard(cardOrName.trim()));
    if (!reader) reader = (await call(window.api.readers.list(cardOrName.trim())) || [])[0];
    if (!reader) return toast('Няма такъв читател.', 'err');
  }
  window._HOLD_READER = reader;
  modal('Нова резервация', `
    <div class="note">Резервацията ще се запише на <b>${esc(reader.name)}</b>${reader.card_no ? ' · карта ' + esc(reader.card_no) : ''}.</div>
    <form id="holdF" onsubmit="return false">
      ${fld('Заета книга', 'code', { val: '', hint: 'баркод или инв. №', req: 1 })}
    </form>`,
    `<button class="btn l" onclick="holdChangeReader()">Друг читател…</button>
     <button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveHold(${reader.id})">Резервирай</button>`);
}
window.holdPrompt = holdPrompt;
async function holdChangeReader() { closeModal(); await holdPrompt(null); }
window.holdChangeReader = holdChangeReader;
async function saveHold(readerId) {
  const code = (formData('#holdF').code || '').trim();
  if (!code) return toast('Въведете баркод или инв. № на книгата.', 'err');
  const res = await window.api.holds.add({ reader_id: readerId, code });
  if (!res.ok) return toast(res.error, 'err');
  const who = (window._HOLD_READER || {}).name || '';
  closeModal();
  toast('Резервирана: инв. № ' + res.data.inv_number + ' за ' + who + ' — на опашката е ' + res.data.queue + '-ри.', 'ok');
  markSaved();
  renderCirc();
}
window.saveHold = saveHold;
async function cancelHold(id) {
  if (!confirm('Отказ от резервацията?')) return;
  const res = await window.api.holds.cancel(id);
  if (!res.ok) return toast(res.error, 'err');
  /* Отмяната на ЗАДЕЛЕНА резервация повиква следващия по опашката (holds:cancel).
     Дотук екранът казваше само „Резервацията е отказана.“ — библиотекарят връщаше
     бройката на рафта, никой не се обаждаше на следващия читател, а първото
     заемане на гишето се отказваше със „заделена“. Пътят при връщане показва
     същото известие отдавна (src/views/loans.js). */
  const next = res.data && res.data.next;
  toast('Резервацията е отказана.', 'ok');
  if (next) {
    toast('📌 Бройката се заделя за ' + next.reader_name + ' (карта ' + (next.card_no || '—') + ')'
      + (next.phone ? ', тел. ' + next.phone : '') + ' — не се връща на рафта!', 'err');
  }
  markSaved();
  renderCirc();
}
window.cancelHold = cancelHold;
