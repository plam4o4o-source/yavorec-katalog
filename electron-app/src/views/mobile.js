/* ============================================================================
   МОБИЛНО СКАНИРАНЕ ПРИ ИНВЕНТАРИЗАЦИЯ
   ============================================================================ */
async function mobileGenerate() {
  const res = await window.api.mobile.generate();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast('Страницата е записана: ' + res.data, 'ok');
}
window.mobileGenerate = mobileGenerate;

/* ДВА ПЪТЯ ДО ТЕЛЕФОНА (v2.4.78).
   (А) Приложението по https — QR код на екрана, телефонът го отваря и може да го
       добави към началния екран. По https Chrome пита за камерата и помни
       отговора: живата камера чете етикет след етикет, без снимка за всяка книга.
       Работи и без интернет след първото отваряне.
   (Б) Файлът, както досега — за телефон без интернет изобщо. Там Chrome не дава
       жива камера и се снима всеки етикет поотделно („Снимай баркод“).
   И двата носят вграден четец за телефони без четеца на Chrome (iPhone, Huawei). */
async function mobileHelp() {
  const info = await call(window.api.mobile.siteInfo());
  modal('Сканиране с телефон вместо баркод четец', `
    <div class="note" style="margin-top:0">Телефонът замества скъпия ръчен четец: камерата чете
    баркода на документа, а списъкът се пренася в програмата. Обхождането на рафтовете става
    за часове вместо за дни, без да се влачи компютър до стелажите.</div>

    <h3 style="margin:14px 0 6px">А. Приложението (препоръчително)</h3>
    ${info ? `<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      <div style="width:170px;height:170px;background:#fff;padding:4px;border-radius:6px">${info.qrSvg}</div>
      <div style="flex:1;min-width:220px">
        <ol class="steps" style="margin-top:0">
          <li>Насочете камерата на телефона към кода и отворете адреса в <b>Chrome</b> (на iPhone — в Safari).</li>
          <li>От менюто на браузъра — <b>„Добавяне към началния екран“</b> / „Инсталиране“. Следващия път е подръка
              и работи и без интернет.</li>
          <li><b>„Пусни камерата“</b> — телефонът пита веднъж за камерата; после етикетите се четат един след друг.</li>
        </ol>
        <div class="hint" style="word-break:break-all">${esc(info.url)}
          <button class="btn" style="margin-left:6px" onclick="mobileCopyUrl()">Копирай адреса</button></div>
      </div></div>` : ''}

    <h3 style="margin:16px 0 6px">Б. Страница като файл (без интернет)</h3>
    <ol class="steps">
      <li>Натиснете „Запиши страницата…“ и прехвърлете файла на телефона — с USB кабел, по Вайбър, по имейл.</li>
      <li>Отворете го с <b>Chrome</b> от папката „Изтеглени“ (Downloads). При рафтовете натискайте
          <b>„Снимай баркод“</b> — номерът се разчита от снимката.</li>
    </ol>

    <h3 style="margin:16px 0 6px">След обхождането</h3>
    <ol class="steps">
      <li>На телефона: <b>„Изпрати“</b> (направо във Вайбър или пощата), „Копирай“ или „Файл“.</li>
      <li>Тук отворете сесията за инвентаризация и натиснете
          <b>„Въведи сканирания от телефон“</b> — поставяте списъка или избирате файла .txt.
          Списъкът носи деня, в който е започнат, и проверката, за която е; ако не съвпадат, програмата пита.</li>
    </ol>

    <div class="hint"><b>Списък на проверката.</b> В отворената сесия бутонът <b>„📋 Списък за телефона“</b>
    записва документите в обхвата ѝ. Със зареден списък телефонът показва заглавието на прочетения документ,
    предупреждава веднага за номер извън обхвата, брои „проверени X от N“ и показва несканираните по
    сигнатура. В списъка няма лични данни — само инв. №, баркод, заглавие и сигнатура.</div>
    <div class="hint" style="margin-top:8px"><b>Данните остават у Вас.</b> Страницата не изпраща никъде
    сканираното — списъкът стои в самия телефон, докато не го прехвърлите. Ако телефонът се заключи
    или браузърът се затвори, сканираното не се губи; ако браузърът не дава памет на страницата, тя го казва.</div>
    <div class="hint" style="margin-top:8px"><b>Ако камерата не чете:</b> въвеждайте номерата на ръка в
    същата страница (бутон „Добави“), по един номер наведнъж — списъкът се пренася по същия начин.</div>`,
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn pri" onclick="closeModal();mobileGenerate()">Запиши страницата…</button>`);
}
window.mobileHelp = mobileHelp;

async function mobileCopyUrl() {
  const info = await call(window.api.mobile.siteInfo());
  if (!info) return;
  try { await navigator.clipboard.writeText(info.url); toast('Адресът е копиран.', 'ok'); }
  catch (e) { toast('Адресът не можа да се копира — маркирайте го и го копирайте ръчно.', 'err'); }
}
window.mobileCopyUrl = mobileCopyUrl;

/* „📋 Списък за телефона“ в отворената сесия (v2.4.78) — виж mobile:sessionExport. */
function phoneListModal(sessionId) {
  modal('Списък на проверката за телефона', `
    <div class="note" style="margin-top:0">Записва документите в обхвата на тази проверка — инв. №,
    баркод, заглавие и сигнатура, и кои вече са сканирани тук. Със списъка телефонът показва заглавието на
    прочетения документ, предупреждава веднага за номер извън обхвата, брои „проверени X от N“ и показва
    несканираните по сигнатура. <b>Лични данни няма</b> — нито читатели, нито заемания.</div>
    <ul class="steps">
      <li><b>Страница със списъка (.html)</b> — за отваряне като файл на телефона; списъкът е вграден.</li>
      <li><b>Само списъка (.json)</b> — за приложението по https: там „📋 Зареди списъка на проверката“.</li>
    </ul>
    <div class="hint">Списъкът е снимка към този момент. Ако междувременно сканирате и тук, телефонът не го знае —
    при вноса програмата пропуска вече сканираните.</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn" onclick="phoneListSave(${sessionId}, 'json')">Само списъка (.json)</button>
     <button class="btn pri" onclick="phoneListSave(${sessionId}, 'html')">Страница със списъка (.html)</button>`);
}
window.phoneListModal = phoneListModal;

/** @param {Id} sessionId @param {'html' | 'json'} kind */
async function phoneListSave(sessionId, kind) {
  const res = await window.api.mobile.sessionExport({ sessionId, kind });
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  closeModal();
  toast('Записано: ' + res.data, 'ok');
}
window.phoneListSave = phoneListSave;

/* ВНОС ОТ ТЕЛЕФОНА (v2.4.69, находки О2, О5, О6).
   • Един ред = един код (О2). Дотук текстът се делеше и по интервали и запетаи:
     „6 102“ от ръчното поле на телефона ставаше инв. № 6 и инв. № 102, а
     истинският 6102 излизаше „липсващ“ в протокола. Сега се дели САМО по нов
     ред; ред с интервал или запетая вътре не се гадае — обработчикът го връща
     поименно (правилото е там, виж handlers/mobile.js).
   • Файлът .txt (О5). Бутонът „Запиши файл“ на телефона записва .txt, а тук се
     приемаше само поставен текст — файлът, пратен по Вайбър, трябваше да се
     отваря в Бележник и да се копира. Сега полето за файл го чете направо
     (FileReader — нищо не минава през нов канал) и го слага в същото текстово
     поле, за да се види какво ще влезе, преди „Въведи“.
   • Датата на списъка (О5). Телефонът пише в първия ред кога е започнат
     списъкът („# … започнат на 20.09.2026 г.“). Ако денят не е денят на
     проверката, се пита: стар списък, останал в телефона, иначе влиза като
     „проверени“ в чужд протокол.
   • Дневникът на сканиранията не се трие (О6) — виж ivLogAdd в
     src/views/inventory-sessions.js. */
function importScansModal(sessionId) {
  modal('Въвеждане на сканирания от телефон', `
    <div class="note" style="margin-top:0">Поставете списъка, копиран от телефона, или изберете
    файла <b>.txt</b>, записан с „Запиши файл“. <b>По един номер на ред</b> — ред с интервал или
    запетая вътре (например „6 102“) не се внася, а се изброява отделно, за да се въведе на ръка:
    програмата не гадае дали това е един номер, или два.</div>
    <label class="hint" style="display:block;margin-bottom:6px">Файл от телефона:
      <input type="file" id="scanFile" accept=".txt,text/plain" onchange="importScansFile(this)"></label>
    <textarea id="scanPaste" class="remText" rows="12" placeholder="1024&#10;1025&#10;1026&#10;…"></textarea>
    <div class="hint" style="margin-top:6px">Вече сканираните в тази сесия се пропускат, а
    непознатите номера се изброяват отделно, за да се проверят.</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="importScansRun(${sessionId})">Въведи</button>`);
  setTimeout(() => { const t = $('#scanPaste'); if (t) t.focus(); }, 60);
}
window.importScansModal = importScansModal;

/* Чете избрания .txt и го слага в текстовото поле. Файлът е от телефона —
   UTF-8, по един номер на ред; BOM-ът (ако Windows го е добавил) се маха. */
function importScansFile(inp) {
  const f = inp && inp.files && inp.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    const t = $('#scanPaste');
    if (!t) return;
    t.value = String(rd.result || '').replace(/^﻿/, '');
    const n = t.value.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).length;
    toast('Файлът „' + f.name + '“ е зареден — ' + n + (n === 1 ? ' ред' : ' реда') + '. Прегледайте и натиснете „Въведи“.', 'ok');
  };
  rd.onerror = () => toast('Файлът „' + f.name + '“ не можа да се прочете (' + ((rd.error && rd.error.message) || 'неизвестна грешка')
    + '). Отворете го на компютъра и поставете текста в полето.', 'err');
  rd.readAsText(f, 'utf-8');
}
window.importScansFile = importScansFile;

/* Датата от заглавния ред на списъка от телефона: „# … започнат на 20.09.2026 г.“ */
function phoneListDate(raw) {
  const m = String(raw || '').match(/^\s*#[^\n]*?(\d{2})\.(\d{2})\.(\d{4})/m);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : null;
}
/* За коя проверка е списъкът (v2.4.78): „…, проверка #12 (протокол № 3/2026)“ —
   телефонът го пише, когато списъкът е започнат при зареден списък на проверката. */
function phoneListSession(raw) {
  const m = String(raw || '').match(/^\s*#[^\n]*?проверка #(\d+)/m);
  return m ? +m[1] : null;
}

async function importScansRun(sessionId) {
  const raw = $('#scanPaste').value || '';
  const codes = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  if (!codes.length) return toast('Не е поставен нито един номер.', 'err');
  /* Номерът на проверката е по-сигурен от датата (v2.4.78): списък, започнат за
     друга сесия, се пита изрично, а датата не се пита втори път. */
  const listSess = phoneListSession(raw);
  if (listSess != null && listSess !== +sessionId) {
    if (!await askConfirm('Списъкът от телефона е започнат за друга проверка (#' + listSess + '), а сега е отворена #'
      + sessionId + '. Номерата му ще влязат в ТОЗИ протокол като проверени. Да го внеса ли все пак?',
      { okLabel: 'Внеси го' })) return;
  }
  const listDay = listSess == null ? phoneListDate(raw) : null;
  if (listDay) {
    const sess = await call(window.api.inventorySessions.get(sessionId));
    const sessDay = sess && sess.date;
    if (sessDay && listDay < sessDay) {
      if (!await askConfirm('Списъкът от телефона е започнат на ' + bg(listDay) + ' г., а тази проверка е от '
        + bg(sessDay) + ' г. Възможно е да е стар списък, останал в телефона от предишна проверка — '
        + 'номерата му ще влязат в протокола като проверени сега. Да го внеса ли все пак?',
        { okLabel: 'Внеси го' })) return;
    }
  }
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
  const malformed = r.malformed || [];
  const lost = r.lost || [];
  const summary = `Въведени ${r.added} · повторни ${r.duplicates} · непознати ${r.unknown.length}`
    + (skipped.length ? ` · извън обхвата ${skipped.length}` : '')
    + (malformed.length ? ` · невнесени редове ${malformed.length}` : '')
    + (lost.length ? ` · изгубени, намерени на рафта ${lost.length}` : '');
  const bad = r.unknown.length || skipped.length || malformed.length || lost.length;
  toast(summary, (r.unknown.length || skipped.length || malformed.length) ? 'err' : (lost.length ? 'warn' : 'ok'));
  /* Вносът влиза и в дневника на сканиранията — като един ред, плюс по ред за
     всеки изгубен документ (същото предупреждение като при сканиране тук). */
  if (typeof ivLogAdd === 'function') {
    ivLogAdd(`<div class="scanlog ${bad ? 'warn' : 'ok'}">📱 Внос от телефон: ${esc(summary)}</div>`);
    lost.forEach(l => ivLogAdd(`<div class="scanlog warn"><b>${esc(String(l.inv_number))}</b> — ${esc(l.title || '')}
      <br><span class="badge warn">ИЗГУБЕН</span> ${esc(l.message)}</div>`));
  }
  if (bad) {
    modal('Номера, които искат внимание', `
      ${lost.length ? `<div class="note w" style="margin-top:0">
        <b>${lost.length === 1 ? '1 документ, отбелязан като изгубен от читател, е на рафта'
          : lost.length + ' документа, отбелязани като изгубени от читатели, са на рафта'}.</b>
        Записани са като проверени, но състоянието им остава „изгубен“, докато не натиснете
        „Документът се намери“ в „Просрочени“ → „Изгубени и невърнати документи“.</div>
      <div class="hint" style="line-height:1.6">${lost.map(l => esc(l.message)).join('<br>')}</div>` : ''}
      ${malformed.length ? `<div class="note" style="border-left-color:var(--red)">
        <b>${malformed.length === 1 ? '1 ред не е внесен' : malformed.length + ' реда не са внесени'}</b> — има интервал
        или запетая вътре. Един ред е един номер: сканирайте или въведете ${malformed.length === 1 ? 'го' : 'ги'}
        на ръка в полето за сканиране.</div>
      <div class="hint" style="font-family:var(--mono);line-height:1.8">${malformed.map(m => '„' + esc(m.code) + '“').join(' · ')}</div>` : ''}
      ${r.unknown.length ? `<div class="note" style="border-left-color:var(--red)">
        <b>${r.unknown.length} номера не са намерени във фонда.</b> Обикновено това са документи,
        описани в друга библиотека, сгрешено сканиране или книги, които още не са заведени.</div>
      <div class="hint" style="font-family:var(--mono);line-height:1.8">${r.unknown.map(esc).join(' · ')}</div>` : ''}
      ${skipped.length ? `<div class="note" style="border-left-color:var(--red)">
        <b>${skipped.length} документа са извън обхвата на тази проверка</b> и затова не са записани в протокола.</div>
      <div class="hint" style="font-family:var(--mono);line-height:1.8">${
        skipped.map(x => esc('инв. № ' + x.inv_number + ' — ' + x.reason)).join('<br>')}</div>` : ''}`,
      `<button class="btn pri" onclick="closeModal();renderInventRun()">Разбрах</button>`);
  } else {
    renderInventRun();
  }
}
window.importScansRun = importScansRun;
