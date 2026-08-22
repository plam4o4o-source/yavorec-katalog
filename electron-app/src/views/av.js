/* ============================================================================
   ПРИЕМАНЕ НА ДАННИ ОТ ДРУГИ СИСТЕМИ
   ============================================================================ */
/* ---------------- Антивирусна защита ---------------- */
async function avScript() {
  const info = await call(window.api.security.exclusionInfo());
  if (!info) return;
  modal('Скрипт за изключения в Windows Defender', `
    <div class="note" style="margin-top:0">Скриптът ще добави следните папки в изключенията на
    Defender и ще разреши програмата през „Защита от рансъмуер“. Прегледайте списъка, преди да
    го запишете:</div>
    <ul class="steps" style="list-style:disc">
      ${info.dirs.map(d => `<li style="font-family:var(--mono);font-size:12px">${esc(d)}</li>`).join('')}
      <li style="font-family:var(--mono);font-size:12px">${esc(info.exe)} <span class="hint">(разрешено приложение)</span></li>
    </ul>
    <div class="hint">След записване: намерете файла, десен бутон → <b>„Изпълни като
    администратор“</b>. Прави се веднъж на всеки компютър и важи и за бъдещите обновявания.
    При друга антивирусна (Avast, ESET…) добавете същите папки в нейните настройки.</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="avScriptWrite()">Запиши скрипта…</button>`);
}
window.avScript = avScript;
async function avScriptWrite() {
  const res = await window.api.security.writeExclusionScript();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  closeModal();
  toast('Скриптът е записан: ' + res.data + ' — изпълнете го като администратор.', 'ok');
}
window.avScriptWrite = avScriptWrite;
/* AVG, Avast, ESET и др. нямат команден ред за изключения — папките се добавят
   ръчно в техния прозорец. Копирането на списъка спестява преписването. */
async function avCopyDirs() {
  const info = await call(window.api.security.exclusionInfo());
  if (!info) return;
  const text = info.dirs.join('\n');
  // Текстът на прозореца казва истината за това дали копирането е станало — дотук
  // пишеше „копиран“ в удебелено и когато не е. Прозорецът с текста си остава
  // резервният път и в двата случая.
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; }
  catch (e) { /* резервният път е самият прозорец по-долу */ }
  modal('Папки за изключения — AVG и други антивирусни', `
    <div class="note" style="margin-top:0">${copied
      ? 'Списъкът е <b>копиран</b> — поставете'
      : 'Копирането не стана — <b>щракнете в текста по-долу и натиснете Ctrl+C</b>, после поставете'} всяка папка като
    изключение в антивирусната. Пътищата, ред по ред:</div>
    <textarea class="remText" rows="${info.dirs.length + 1}" readonly
      onclick="this.select()">${esc(text)}</textarea>
    <div class="hint" style="margin-top:10px"><b>Къде в AVG:</b> отворете AVG → „Меню“ (горе
    вдясно) → „Настройки“ → „Общи“ → „Изключения“ → „Добавяне на изключение“ → „Преглед“ и
    посочете всяка от папките по-горе. При англ. изглед: Menu → Settings → General → Exceptions
    → Add exception.</div>
    <div class="hint" style="margin-top:6px"><b>Ако AVG вече е изтрила файл:</b> „Меню“ →
    „Карантина“ → изберете файла → „Възстановяване и добавяне на изключение“
    (Restore and add exception).</div>
    <div class="hint" style="margin-top:6px"><b>Трайно:</b> подайте фалшивата тревога към AVG на
    <span style="font-family:var(--mono);font-size:12px">avg.com/false-positive-file-form</span> —
    качвате инсталатора, обработва се за няколко дни и блокирането спира при всички.</div>`,
    `<button class="btn pri" onclick="closeModal()">Готово</button>`);
}
window.avCopyDirs = avCopyDirs;
function avHelp() {
  modal('Антивирусната блокира програмата — какво да направя?', `
    <div class="note" style="margin-top:0"><b>Причината:</b> инсталаторът още няма закупен цифров
    подпис, а Windows преценява файловете по издателя им. Файл без подпис се третира като непознат
    и антивирусните го спират „за всеки случай“. Кодът на програмата е публичен и може да бъде
    проверен от всекиго в GitHub хранилището.</div>
    <ol class="steps">
      <li><b>При инсталиране</b> — ако SmartScreen покаже „Windows protected your PC“:
          натиснете „More info“ → „Run anyway“. Ако сваленият файл бъде изтрит: при Defender —
          Windows Security → „Protection history“ → „Restore“; при AVG — „Меню“ → „Карантина“ →
          „Възстановяване и добавяне на изключение“.</li>
      <li><b>Windows Defender</b> — бутонът „Скрипт за Defender…“ прави готов скрипт, който се
          изпълнява веднъж като администратор и добавя всички нужни изключения.</li>
      <li><b>AVG, Avast, ESET и други</b> — бутонът „Копирай папките“ дава списъка с папки и
          точните стъпки къде да се поставят в настройките на антивирусната.</li>
      <li><b>Трайно, безплатно</b> — подайте инсталатора като фалшива тревога:
          за Defender на <span style="font-family:var(--mono);font-size:12px">microsoft.com/wdsi/filesubmission</span>,
          за AVG на <span style="font-family:var(--mono);font-size:12px">avg.com/false-positive-file-form</span>.
          Обработва се за няколко дни и след това блокирането спира при всички, не само при вас.</li>
      <li><b>Окончателно</b> — сертификат за подпис на код (виж README, раздел „Цифров подпис“).
          След него предупрежденията изчезват навсякъде.</li>
    </ol>`,
    `<button class="btn pri" onclick="closeModal()">Разбрах</button>`);
}
window.avHelp = avHelp;
