/* ---------------- Просрочени ---------------- */
async function renderOver() {
  const rows = await call(window.api.loans.overdue());
  if (!rows) return;
  const s = await call(window.api.settings.get());
  const fine = s ? s.fine_per_day : 0.05;
  const total = rows.reduce((sum, l) => {
    const days = Math.round((new Date(today()) - new Date(l.date_due)) / 864e5);
    return sum + days * fine;
  }, 0);
  if (!rows.length) { $('#view').innerHTML = '<div class="empty"><h3>Няма просрочени заемания</h3><p>Всички заети документи са в срок.</p></div>'; return; }
  $('#view').innerHTML = `
    <div class="note w"><b>Чл. 43, ал. 2 и чл. 49, ал. 1, т. 3</b> — библиотекарят следи сроковете при забава.
    Общо дължимо обезщетение: <b>${mny(total)}</b></div>
    <div class="toolbar">
      <button class="btn pri" onclick="openReminders()">Напомняния (имейл и SMS)</button>
      <button class="btn" onclick="printOverdueNotices()">Печат на напомняния / PDF</button>
    </div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Читател</th><th>Инв. №</th><th>Заглавие</th>
      <th>Срок</th><th>Дни</th><th>Обезщетение</th><th style="width:180px"></th></tr></thead><tbody>
    ${rows.map(l => {
      const days = Math.round((new Date(today()) - new Date(l.date_due)) / 864e5);
      return `<tr><td>${esc(l.reader_name)}</td><td class="num">${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
        <td class="num">${bg(l.date_due)}</td><td class="num warn">${days}</td><td class="num">${mny(days * fine)}</td>
        <td><button class="btn sm" onclick="returnBook(${l.id})">Приеми</button>
            <button class="btn sm" onclick="extendLoan(${l.id})">Продължи</button></td></tr>`;
    }).join('')}
    </tbody></table></div>`;
}
