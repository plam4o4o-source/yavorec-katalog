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
async function holdPrompt() {
  let readerId = CIRC.readerId;
  if (!readerId) {
    const cardOrName = await askText('Нова резервация', {
      label: 'Читател', hint: 'номер на карта или име', okLabel: 'Напред'
    });
    if (!cardOrName || !cardOrName.trim()) return;
    const byCard = await call(window.api.readers.byCard(cardOrName.trim()));
    if (byCard) { readerId = byCard.id; }
    else {
      const found = (await call(window.api.readers.list(cardOrName.trim())) || [])[0];
      if (!found) return toast('Няма такъв читател.', 'err');
      readerId = found.id;
    }
  }
  const code = await askText('Нова резервация', {
    label: 'Заета книга', hint: 'баркод или инв. №', okLabel: 'Резервирай'
  });
  if (!code || !code.trim()) return;
  const res = await window.api.holds.add({ reader_id: readerId, code: code.trim() });
  if (!res.ok) return toast(res.error, 'err');
  toast('Резервирана: инв. № ' + res.data.inv_number + ' — на опашката е ' + res.data.queue + '-ри.', 'ok');
  markSaved();
  renderCirc();
}
window.holdPrompt = holdPrompt;
async function cancelHold(id) {
  if (!confirm('Отказ от резервацията?')) return;
  const res = await window.api.holds.cancel(id);
  if (!res.ok) return toast(res.error, 'err');
  toast('Резервацията е отказана.', 'ok'); markSaved();
  renderCirc();
}
window.cancelHold = cancelHold;
