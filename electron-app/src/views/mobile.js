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
      <li>На телефона отворете файла с <b>Chrome</b>. Добавете го към началния екран, за да е
          подръка следващия път.</li>
      <li>При рафтовете натискайте <b>„Снимай баркод“</b> и снимайте етикета — номерът се
          разчита от снимката. Всеки разчетен номер се добавя със звук; повторните се отбелязват
          отделно.</li>
      <li>Накрая натиснете <b>„Копирай списъка“</b> и си го изпратете (Вайбър, имейл), или
          „Запиши файл“ и го прехвърлете.</li>
      <li>Тук отворете сесията за инвентаризация и натиснете
          <b>„Въведи сканирания от телефон“</b> — поставяте списъка или избирате файла .txt.
          Списъкът носи деня, в който е започнат: ако е от друг ден, програмата пита, преди да го внесе.</li>
    </ol>

    <div class="hint"><b>Работи офлайн.</b> Страницата не изисква интернет и не изпраща никъде
    данни — списъкът стои в самия телефон, докато не го прехвърлите. Ако телефонът се заключи
    или Chrome се затвори, сканираното не се губи.</div>
    <div class="hint" style="margin-top:8px"><b>Защо „Снимай баркод“, а не живата камера.</b>
    Chrome пази разрешението за камера по адрес на страницата. Страница, отворена като файл от
    паметта на телефона, няма такъв адрес: заявката се отказва, без телефонът изобщо да попита
    „Разрешавате ли достъп до камерата?“. Снимката минава през самото приложение „Камера“, което
    си има собствено разрешение, и затова работи. Живата камера („Пусни камерата“) тръгва, когато
    същата страница се отвори по интернет адрес, започващ с <b>https://</b>.</div>
    <div class="hint" style="margin-top:8px"><b>Ако камерата не чете:</b> на iPhone и на по-стари
    браузъри четенето на баркод не се поддържа — тогава номерата се въвеждат на ръка в
    същата страница (бутон „Добави“ — цифровата клавиатура на iPhone няма Enter), по един
    номер наведнъж, и списъкът се пренася по същия начин.</div>`,
    `<button class="btn" onclick="closeModal()">Затвори</button>
     <button class="btn pri" onclick="closeModal();mobileGenerate()">Запиши страницата…</button>`);
}
window.mobileHelp = mobileHelp;

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

async function importScansRun(sessionId) {
  const raw = $('#scanPaste').value || '';
  const codes = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  if (!codes.length) return toast('Не е поставен нито един номер.', 'err');
  const listDay = phoneListDate(raw);
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
