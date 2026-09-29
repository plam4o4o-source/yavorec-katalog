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
          <span class="remBadge">${r.n} ${r.n === 1 ? 'просрочен' : 'просрочени'}</span>
          <span class="badge ${r.level >= 3 ? 'warn' : ''}" title="Степента расте с давността на най-старото просрочие (праговете са в Настройки)">Напомняне № ${r.level}</span>
          ${r.lastNotice ? `<span class="hint" title="Последно регистрирано напомняне по това просрочие">последно: № ${r.lastNotice.level} · ${bg(tsDay(r.lastNotice.ts))}</span>` : '<span class="hint">няма пращано досега</span>'}
          ${Number(r.fine) > 0 ? `<span class="hint">${mny(r.fine)}</span>` : ''}
        </div>
        <div class="remBody">
          <div class="remMeta">
            Имейл: <b>${r.email ? esc(r.email) : '— няма записан —'}</b>${
              /* v2.4.69 (Г11): при дете писмото е до родителя, а имейлът в картона е
                 на детето — обработчикът не го ползва и казва защо в email_note. */
              r.email_note ? ` <span class="hint">(${esc(r.email_note)})</span>` : ''} ·
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
/* Минава през call(), а не „изстрелване и забрава“: това е официалният регистър,
   по който се вдига нивото на следващото напомняне. Дотук резултатът изобщо не се
   проверяваше и провалът беше напълно невидим — списъкът после показваше „няма
   пращано досега“ и ескалацията тръгваше пак от ниво 1. */
async function remLog(i, channel) {
  const r = (window._REMINDERS || [])[i];
  if (!r) return false;
  /* Директно, без call(): call() вече показва СВОЯ toast с техническата грешка,
     а тук трябва да се каже какво означава тя за библиотекаря. Две червени
     съобщения за един провал са шум. */
  let res;
  try { res = await window.api.notices.log({ reader_id: r.reader_id, level: r.level || 1, channel, loans_count: r.n }); }
  catch (e) { res = { ok: false, error: e && e.message }; }
  if (!res || !res.ok) {
    toast('Напомнянето е подготвено, но НЕ се вписа в регистъра — следващия път ще тръгне пак от същото ниво.'
      + (res && res.error ? ' (' + res.error + ')' : ''), 'err');
    return false;
  }
  return true;
}
async function remMail(i) {
  const r = (window._REMINDERS || [])[i];
  if (!r) return;
  const body = $('#remB' + i).value;
  /* „ОТВОРИ В ПОЩАТА“ ОТВАРЯ ПОЩАТА ВИНАГИ (v2.4.71, находка Ч9).
     (а) КАКВО СТАВАШЕ ДОТУК. Кирилицата се кодира по 6 знака на буква и писмото
         по подразбиране е 1 975 – 2 698 знака дори за един документ (таван 1 900).
         Първото повикване се отказваше всеки път; после текстът се копираше и
         пощата се отваряше с втори опит — а ако буферът откажеше, оставаше само
         червено „твърде дълго“ и пощата изобщо не се отваряше.
     (б) Бутонът трябва да прави това, което пише на него.
     (в) Дължината се преценява ТУК, преди първото повикване, и текстът се
         копира веднага — докато натискането на бутона е още „жест на
         потребителя“ (след обиколка по IPC достъпът до буфера може да бъде
         отказан). Каналът получава и кратък текст (`fallbackBody`) и, ако
         пълният не се побира, отваря пощата с адресата, темата и него. Ако и
         копирането не стане, текстът се маркира и кратката бележка казва откъде
         да се вземе. Регистърът се пипа само когато текстът наистина е тръгнал
         (цял в писмото или в буфера). */
  const url = 'mailto:' + encodeURIComponent(r.email || '') + '?subject=' + encodeURIComponent(r.subject || '')
    + '&body=' + encodeURIComponent(body || '');
  const tooLong = url.length > 1900;
  let copied = false;
  if (tooLong) {
    try { await navigator.clipboard.writeText(body); copied = true; }
    catch (e) {
      const ta = $('#remB' + i);
      try { if (ta) { ta.select(); copied = document.execCommand('copy') === true; } }
      catch (e2) { copied = false; }
    }
  }
  const fallbackBody = copied
    ? 'Текстът на напомнянето е копиран в системния буфер — поставете го тук с Ctrl+V.'
    : 'Поставете тук текста на напомнянето от програмата (прозорец „Напомняния“ → „Копирай писмото“).';
  const res = await window.api.loans.mailto({ email: r.email, subject: r.subject, body, fallbackBody });
  if (!res || !res.ok) return toast((res && res.error) || 'Пощата не се отвори.', 'err');
  const shortened = !!(res.data && res.data.shortened);
  if (!shortened) {
    await remLog(i, 'имейл');
    return toast('Писмото е отворено в пощенския клиент.', 'ok');
  }
  if (copied) {
    await remLog(i, 'имейл');
    return toast('Писмото е отворено с адреса и темата; текстът е твърде дълъг за пощенския клиент и е копиран — '
      + 'поставете го в писмото с Ctrl+V.', 'ok');
  }
  const ta = $('#remB' + i); if (ta) ta.select();
  toast('Писмото е отворено с адреса и темата, но без текста (твърде дълъг за пощенския клиент), а копирането не стана. '
    + 'Текстът е маркиран — натиснете Ctrl+C тук и го поставете в писмото. Напомнянето НЕ е вписано като изпратено; '
    + 'впишете го с „Копирай писмото“.', 'err');
}
window.remMail = remMail;
async function remCopy(id, i, channel) {
  const el = $('#' + id);
  if (!el) return;
  /* Регистърът се пипа САМО ако копирането наистина е станало. Дотук и двата пътя
     можеха да се провалят (достъпът до системния буфер се отказва при заключена
     политика или извън потребителски жест), а програмата въпреки това казваше
     „Копирано.“ и вписваше напомняне № 2 като изпратено — библиотекарят лепваше в
     съобщението каквото е било в буфера отпреди. */
  let copied = false;
  try {
    await navigator.clipboard.writeText(el.value);
    copied = true;
  } catch (e) {
    // Резервен път, ако достъпът до системния буфер е отказан.
    try { el.select(); copied = document.execCommand('copy') === true; }
    catch (e2) { copied = false; }
  }
  if (!copied) {
    el.select(); // текстът остава маркиран, за да може ръчно с Ctrl+C
    return toast('Копирането не стана — текстът е маркиран, натиснете Ctrl+C.', 'err');
  }
  if (i != null) await remLog(i, channel || 'копиране');
  toast('Копирано.', 'ok');
}
window.remCopy = remCopy;
