/* ============================================================================
   МОБИЛНО СКАНИРАНЕ ПРИ ИНВЕНТАРИЗАЦИЯ
   ============================================================================ */
async function mobileGenerate() {
  const res = await window.api.mobile.generate();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast('Страницата е записана: ' + res.data, 'ok');
}
window.mobileGenerate = mobileGenerate;

function mobileHelp() {
  modal('Сканиране с телефон вместо баркод четец', `
    <div class="note" style="margin-top:0">Телефонът замества скъпия ръчен четец: камерата чете
    баркода на документа, а списъкът се пренася в програмата. Обхождането на рафтовете става
    за часове вместо за дни, без да се влачи компютър до стелажите.</div>

    <ol class="steps">
      <li><b>Веднъж:</b> натиснете „Запиши страницата…“ и запазете файла. Прехвърлете го на
          телефона — с USB кабел, по Вайбър, по имейл, както Ви е удобно.</li>
      <li>На телефона отворете файла с <b>Chrome</b> и разрешете достъп до камерата.
          Добавете го към началния екран, за да е подръка следващия път.</li>
      <li>При рафтовете: „Пусни камерата“ и насочвайте към баркодовете.
          Всеки разчетен номер се добавя със звук; повторните се отбелязват отделно.</li>
      <li>Накрая натиснете <b>„Копирай списъка“</b> и си го изпратете (Вайбър, имейл), или
          „Запиши файл“ и го прехвърлете.</li>
      <li>Тук отворете сесията за инвентаризация и натиснете
          <b>„Въведи сканирания от телефон“</b> — поставяте списъка и готово.</li>
    </ol>

    <div class="hint"><b>Работи офлайн.</b> Страницата не изисква интернет и не изпраща никъде
    данни — списъкът стои в самия телефон, докато не го прехвърлите. Ако телефонът се заключи
    или Chrome се затвори, сканираното не се губи.</div>
    <div class="hint" style="margin-top:8px"><b>Ако камерата не чете:</b> на iPhone и на по-стари
    браузъри четенето на баркод от камера не се поддържа — тогава номерата се въвеждат на ръка в
    същата страница и списъкът се пренася по същия начин.</div>`,
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn pri" onclick="closeModal();mobileGenerate()">Запиши страницата…</button>`);
}
window.mobileHelp = mobileHelp;

function importScansModal(sessionId) {
  modal('Въвеждане на сканирания от телефон', `
    <div class="note" style="margin-top:0">Поставете списъка, копиран от телефона — по един номер
    на ред. Приемат се и номера, разделени със запетая или интервал.</div>
    <textarea id="scanPaste" class="remText" rows="12" placeholder="1024&#10;1025&#10;1026&#10;…"></textarea>
    <div class="hint" style="margin-top:6px">Вече сканираните в тази сесия се пропускат, а
    непознатите номера се изброяват отделно, за да се проверят.</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="importScansRun(${sessionId})">Въведи</button>`);
  setTimeout(() => { const t = $('#scanPaste'); if (t) t.focus(); }, 60);
}
window.importScansModal = importScansModal;

async function importScansRun(sessionId) {
  const raw = $('#scanPaste').value || '';
  const codes = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if (!codes.length) return toast('Не е поставен нито един номер.', 'err');
  const r = await call(window.api.inventorySessions.importScans({ sessionId, codes }));
  if (!r) return;
  markSaved();
  closeModal();
  /* `skipped` са документи, НАМЕРЕНИ във фонда, но извън обхвата на тази
     проверка (чужд отдел или отчислени). Показват се поименно, заедно с
     причината: дотук телефонният път ги приемаше мълчаливо, а настолният ги
     отказва с обяснение — протоколът пред регионалната библиотека трябва да
     отговаря точно на обявения обхват. */
  const skipped = r.skipped || [];
  toast(`Въведени ${r.added} · повторни ${r.duplicates} · непознати ${r.unknown.length}`
    + (skipped.length ? ` · извън обхвата ${skipped.length}` : ''),
    (r.unknown.length || skipped.length) ? 'err' : 'ok');
  if (r.unknown.length || skipped.length) {
    modal('Номера, които не влязоха в протокола', `
      ${r.unknown.length ? `<div class="note" style="border-left-color:var(--red);margin-top:0">
        <b>${r.unknown.length} номера не са намерени във фонда.</b> Обикновено това са документи,
        описани в друга библиотека, сгрешено сканиране или книги, които още не са заведени.</div>
      <div class="hint" style="font-family:var(--mono);line-height:1.8">${r.unknown.map(esc).join(' · ')}</div>` : ''}
      ${skipped.length ? `<div class="note" style="border-left-color:var(--red)">
        <b>${skipped.length} документа са извън обхвата на тази проверка</b> и затова не са записани в протокола.</div>
      <div class="hint" style="font-family:var(--mono);line-height:1.8">${
        skipped.map(x => esc('инв. № ' + x.inv_number + ' — ' + x.reason)).join('<br>')}</div>` : ''}`,
      `<button class="btn pri" onclick="closeModal();renderInventRun(${sessionId})">Разбрах</button>`);
  } else {
    renderInventRun(sessionId);
  }
}
window.importScansRun = importScansRun;
