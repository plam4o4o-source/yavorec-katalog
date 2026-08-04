/* ---------------- Напомняния за просрочени ----------------
   Текстовете се готвят автоматично, но изпращането остава решение на библиотекаря:
   отваря се пощенският клиент с попълнено писмо, или текстът се копира за SMS. */
async function openReminders() {
  const rows = await call(window.api.loans.reminders());
  if (!rows) return;
  if (!rows.length) return toast('Няма просрочени заемания.', 'ok');
  window._REMINDERS = rows;
  modal('Напомняния за просрочени материали', `
    <div class="note" style="margin-top:0">Текстовете са готови. Изпращането е ръчно —
    прегледайте и променете, ако е нужно. „Отвори в пощата“ стартира пощенския клиент
    с попълнени получател, тема и съобщение.</div>
    ${rows.map((r, i) => `
      <div class="remCard">
        <div class="remHead">
          <span class="remName">${esc(r.name)}</span>
          <span class="remBadge">${r.n} просрочени</span>
          <span class="badge ${r.level >= 3 ? 'warn' : ''}" title="Степента расте с давността на най-старото просрочие (праговете са в Настройки)">Напомняне № ${r.level}</span>
          ${r.lastNotice ? `<span class="hint" title="Последно регистрирано напомняне по това просрочие">последно: № ${r.lastNotice.level} · ${bg(String(r.lastNotice.ts).slice(0, 10))}</span>` : '<span class="hint">няма пращано досега</span>'}
          ${Number(r.fine) > 0 ? `<span class="hint">${mny(r.fine)}</span>` : ''}
        </div>
        <div class="remBody">
          <div class="remMeta">
            Имейл: <b>${r.email ? esc(r.email) : '— няма записан —'}</b> ·
            Телефон: <b>${r.phone ? esc(r.phone) : '— няма записан —'}</b>
          </div>
          <label class="fh">Писмо по електронна поща</label>
          <textarea class="remText" id="remB${i}" rows="9">${esc(r.body)}</textarea>
          <div class="toolbar" style="margin-top:6px">
            <button class="btn pri" onclick="remMail(${i})" ${r.email ? '' : 'disabled'}>Отвори в пощата</button>
            <button class="btn" onclick="remCopy('remB${i}', ${i}, 'копиране')">Копирай писмото</button>
          </div>
          <label class="fh" style="margin-top:10px;display:block">Кратък текст за SMS</label>
          <textarea class="remText" id="remS${i}" rows="2">${esc(r.sms)}</textarea>
          <div class="toolbar" style="margin-top:6px">
            <button class="btn" onclick="remCopy('remS${i}', ${i}, 'SMS')">Копирай SMS-а</button>
            <span class="hint" id="remLen${i}">${r.sms.length} знака</span>
          </div>
        </div>
      </div>`).join('')}`,
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn" onclick="printOverdueNotices()">Печат на всички / PDF</button>`);
  rows.forEach((r, i) => {
    const t = $('#remS' + i);
    if (t) t.addEventListener('input', () => {
      const n = t.value.length;
      $('#remLen' + i).textContent = n + ' знака' + (n > 160 ? ' — над един SMS' : '');
    });
  });
}
window.openReminders = openReminders;
/* Отбелязва в регистъра (notice_log), че напомнянето реално е минало към читателя.
   Така списъкът показва „последно: № 2 · 12.05" и повторните не се пращат на сляпо. */
function remLog(i, channel) {
  const r = (window._REMINDERS || [])[i];
  if (!r) return;
  window.api.notices.log({ reader_id: r.reader_id, level: r.level || 1, channel, loans_count: r.n });
}
async function remMail(i) {
  const r = (window._REMINDERS || [])[i];
  if (!r) return;
  const res = await window.api.loans.mailto({ email: r.email, subject: r.subject, body: $('#remB' + i).value });
  if (!res.ok) return toast(res.error, 'err');
  remLog(i, 'имейл');
  toast('Писмото е отворено в пощенския клиент.', 'ok');
}
window.remMail = remMail;
async function remCopy(id, i, channel) {
  const el = $('#' + id);
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.value);
  } catch (e) {
    // Резервен път, ако достъпът до системния буфер е отказан.
    el.select(); document.execCommand('copy');
  }
  if (i != null) remLog(i, channel || 'копиране');
  toast('Копирано.', 'ok');
}
window.remCopy = remCopy;
