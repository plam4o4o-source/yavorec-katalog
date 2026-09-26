// Внасяне на данни от други системи (CSV/TXT/XLSX) — включва и
// document.addEventListener('dragover'/'drop', ...) за влачене на файл
// върху прозореца; регистрира се безопасно веднага (обработва се едва
// при реално събитие, много след пълното зареждане на всички файлове).

let IMPORT_INFO = null;
async function importChoose() {
  const res = await window.api.importData.choose();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  IMPORT_INFO = res.data;
  importMapModal();
}
window.importChoose = importChoose;

/* Провлачване на файл върху прозореца — същият път, като през диалога. */
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  /* Electron 32 премахна File.path, а програмата е на Electron 43 — пътят на
     провлачения файл вече НЕ се вижда от самия прозорец. Взима се през моста
     (importData.pathOf → webUtils.getPathForFile в preload.js, v2.2.1).
     До v2.2.0 тук стоеше тих `return`: библиотекарят влачеше файла, не се
     случваше нищо и нямаше как да разбере защо. */
  const p = (window.api.importData.pathOf && window.api.importData.pathOf(f)) || f.path || '';
  if (!p) {
    return toast('Пътят до провлачения файл не можа да бъде разчетен. '
      + 'Ползвайте бутона „Избери файл за въвеждане…“.', 'err');
  }
  if (!/\.(csv|txt|tsv|xlsx)$/i.test(p)) {
    return toast('Приемат се файлове CSV, TXT, TSV и XLSX.', 'err');
  }
  const res = await window.api.importData.load(p);
  if (!res.ok) return toast(res.error, 'err');
  IMPORT_INFO = res.data;
  importMapModal();
});

function importMapModal() {
  const d = IMPORT_INFO;
  const fieldOpts = Object.entries(d.fields).map(([v, t]) => ({ v, t }));
  modal('Въвеждане на данни — съответствие на колоните', `
    <div class="note" style="margin-top:0">
      Файл: <b style="font-family:var(--mono)">${esc(d.path.split(/[\\/]/).pop())}</b> ·
      кодиране <b>${esc(d.encoding)}</b>${d.delimiter ? ` · разделител <b>${esc(d.delimiter === '\t' ? 'табулация' : d.delimiter)}</b>` : ''} ·
      редове с данни: <b>${d.total}</b><br>
      Съответствието е разпознато по заглавията на колоните. <b>Проверете го</b> и поправете
      каквото е нужно — колоните, оставени на „— не се въвежда —“, се пренебрегват.
    </div>

    <div class="wrap" style="max-height:230px">
      <table class="ledger"><thead><tr>
        ${d.headers.map((h, i) => `<th>${esc(h || 'колона ' + (i + 1))}</th>`).join('')}
      </tr></thead><tbody>
        ${d.preview.map(r => `<tr>${d.headers.map((_, i) =>
          `<td>${esc(String(r[i] ?? '').slice(0, 40))}</td>`).join('')}</tr>`).join('')}
      </tbody></table>
    </div>
    <div class="hint" style="margin:4px 0 12px">Първите ${d.preview.length} реда от файла.</div>

    <form id="mapF" onsubmit="return false">
      <div class="grid g3">
        ${d.headers.map((h, i) => fld(h || 'колона ' + (i + 1), 'col' + i, {
          type: 'select', val: d.mapping[i] || '', opts: fieldOpts, emptyLabel: '— не се въвежда —'
        })).join('')}
      </div>
    </form>

    <fieldset><legend>Настройки на въвеждането</legend>
      <form id="impOptF" onsubmit="return false">
        <label class="chk"><input type="checkbox" name="skipDuplicates" checked>
          <span>Пропускай вече съществуващите (по инвентарен номер, а при липса — по ISBN)</span></label>
        <div class="grid g3" style="margin-top:8px">
          ${fld('Отдел по подразбиране', 'defaultDepartment', { type: 'select', opts: OTDELI,
            val: 'за възрастни', allowEmpty: false })}
          ${fld('Език по подразбиране', 'defaultLanguage', { type: 'select', opts: EZICI, val: 'български' })}
          ${fld('Вид документ по подразбиране', 'defaultCategory', { val: 'книга' })}
        </div>
        <div class="hint">Ползват се само за редовете, в които съответната колона липсва или е празна.</div>
        ${/* Одит v2.4.56: дотук ред без разчетена дата на вписване получаваше
              мълчаливо ДНЕШНАТА дата. При пренасяне на стар фонд (обичайно хиляди
              реда, често изобщо без такава колона) това прави КДБФ да обяви целия
              фонд за постъпил през текущата година, а наличността към 01.01 —
              по-малка със същото число. Затова полето стои тук, ПРЕДИ вноса, с
              обяснение: ретро-фондът се вписва с датата, на която библиотеката
              реално го е заварила/описала, а не с днешната. Празно поле е
              позволено — тогава отчетът след вноса казва какво точно ще се види
              в КДБФ. */''}
        <div class="grid g3" style="margin-top:8px">
          ${fld('Дата на вписване по подразбиране', 'defaultRegisterDate', { type: 'date',
            hint: 'за стар фонд' })}
        </div>
        <div class="hint">Ползва се само за редовете, в които датата на вписване липсва или не се разчита.
          <b>Ако остане празно, тези редове получават днешната дата</b> и в „Книга за движение на
          библиотечния фонд“ ще се появят като постъпления за текущата година. За фонд, заварен от
          по-стара система, посочете деня на описа (например 01.01. на съответната година).</div>
      </form>
    </fieldset>
    ${/* ПОВРЕДЕН ФАЙЛ — КАЗВА СЕ ПРЕДИ ВНОСА, НЕ СЛЕД НЕГО (v2.4.65).
          importers.readTable() отдавна разпознава незатворена кавичка и
          подозрителен брой колони и връща готов текст на български; той стигаше
          чак дотук (d.warning), но нито един екран не го четеше. Измерено с
          файл от 5 реда с незатворена кавичка на ред 3: влизат 2 документа,
          единият със заглавие от 80 знака слепен боклук, три изчезват безследно,
          а отчетът казва „2 Въведени · 0 Пропуснати“ без нито една грешка.
          Затова предупреждението стои ТУК, непосредствено над бутона „Въведи N
          реда“ — на мястото, където още може да се откаже — и се повтаря в
          отчета след вноса. Вносът не се спира: евристиката може и да сгреши
          (кавичка в заглавие), решението е на библиотекарката. */''}
    ${d.warning ? `<div class="note w" style="margin-top:12px">
      <b>Файлът изглежда повреден</b>
      <div style="margin-top:6px">${esc(d.warning)}</div>
      <div style="margin-top:6px">Програмата разчете <b>${d.total}</b>
        ${d.total === 1 ? 'ред с данни' : 'реда с данни'}. Ако в таблицата има повече, останалите
        <b>няма да бъдат въведени и това няма да личи никъде</b> — нито в отчета, нито в
        инвентарната книга. Преди да продължите, отворете файла в Excel или LibreOffice,
        затворете кавичката и запишете наново. Ако знаете, че кавичката е част от заглавие,
        продължете спокойно.</div>
    </div>` : ''}`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="importRun()">Въведи ${d.total} реда</button>`);
}

async function importRun() {
  const d = IMPORT_INFO;
  const mapping = {};
  const seen = {};
  for (let i = 0; i < d.headers.length; i++) {
    const v = $(`#mapF [name=col${i}]`).value;
    if (!v) continue;
    // Едно поле не може да идва от две колони — иначе втората тихо презаписва първата.
    if (seen[v]) return toast(`Полето „${d.fields[v]}“ е посочено два пъти — изберете само една колона за него.`, 'err');
    seen[v] = true;
    mapping[i] = v;
  }
  if (!seen.title) return toast('Посочете коя колона съдържа заглавието — без него записът е безсмислен.', 'err');
  const options = formData('#impOptF');
  const btn = /** @type {HTMLButtonElement} */ (event && event.target);
  if (btn) { btn.disabled = true; btn.textContent = 'Въвеждане…'; }
  const res = await window.api.importData.run({ mapping, options });
  if (btn) { btn.disabled = false; btn.textContent = 'Въведи'; }
  if (!res.ok) return toast(res.error, 'err');
  const r = res.data;
  markSaved();
  forgetAuthSuggest();   // цял фонд наведнъж — списъкът за автодовършване е съвсем друг
  modal('Въвеждането приключи', `
    <div class="kpis">
      ${kpi(KPI_ICONS.check, r.added, 'Въведени документа', 'добавени във фонда', 'ok')}
      ${kpi(KPI_ICONS.skip, r.skipped, 'Пропуснати', 'дубликати или редове с грешка')}
    </div>
    ${/* Повтаря се и тук (v2.4.65): библиотекарката може да е подминала
          предупреждението в диалога за съответствие, а след вноса числото
          „Въведени“ изглежда съвсем нормално — точно то я убеждава, че всичко е
          минало. Текстът е същият, който главният процес е изчислил
          (report.fileWarning ← importers.readTable). */''}
    ${r.fileWarning ? `<div class="note w" style="margin-top:14px">
      <b>Файлът беше разпознат като повреден</b>
      <div style="margin-top:6px">${esc(r.fileWarning)}</div>
      <div style="margin-top:6px">Числото „Въведени“ по-горе брои само редовете, които програмата
        е успяла да прочете. Сравнете го с броя на редовете в самия файл: ако във файла има повече,
        разликата <b>не е въведена и не фигурира никъде</b>. Тогава поправете файла и повторете вноса
        с отметка „Пропускай вече съществуващите“ — вече въведените редове ще бъдат прескочени.</div>
    </div>` : ''}
    ${r.usedInv.length ? `<div class="note" style="margin-top:14px">
      <b>${r.usedInv.length === 1 ? '1 запис получи' : r.usedInv.length + ' записа получиха'} нов инвентарен номер</b>, защото в
      файла нямаше номер или той вече беше зает. Инвентарният номер трябва да е
      уникален — това е изискване на инвентарната книга.
      <div class="hint" style="margin-top:6px">${r.usedInv.slice(0, 12).map(u =>
        `ред ${u.line} → № ${u.inv}`).join(' · ')}${r.usedInv.length > 12 ? ' …' : ''}</div>
    </div>` : ''}
    ${/* Одит v2.4.56: числото на редовете с дата на вписване, сложена от програмата,
          се ПОКАЗВА винаги, когато е различно от нула — иначе библиотекарят няма
          откъде да разбере, че нещо е било решено вместо него. Двата случая се
          четат различно: с посочена дата за стар фонд това е потвърждение какво е
          станало; без нея — предупреждение, защото точно тези документи ще излязат
          в КДБФ като постъпления за текущата година (същото е казано и с думи в
          r.warnings от главния процес). */''}
    ${r.registerDateDefaulted ? `<div class="note${r.registerDateDefault ? '' : ' w'}" style="margin-top:12px">
      <b>Дата на вписване, сложена от програмата: ${r.registerDateDefaulted}
        ${r.registerDateDefaulted === 1 ? 'ред' : 'реда'}</b>
      ${r.registerDateDefault
        ? `<div style="margin-top:6px">Във файла ${r.registerDateDefaulted === 1 ? 'този ред нямаше' : 'тези редове нямаха'}
            дата на вписване и ${r.registerDateDefaulted === 1 ? 'е вписан' : 'са вписани'} с посочената от Вас дата за
            стар фонд — <b>${bg(r.registerDateDefault)}</b>. В „Книга за движение на библиотечния фонд“
            ${r.registerDateDefaulted === 1 ? 'документът ще се появи' : 'документите ще се появят'} като постъпление
            за ${esc(String(r.registerDateDefault).slice(0, 4))} г.</div>`
        : `<div style="margin-top:6px">Във файла ${r.registerDateDefaulted === 1 ? 'този ред нямаше' : 'тези редове нямаха'}
            дата на вписване и ${r.registerDateDefaulted === 1 ? 'получи' : 'получиха'} <b>днешната дата</b>.
            В „Книга за движение на библиотечния фонд“ ${r.registerDateDefaulted === 1
              ? 'този документ ще бъде отчетен като постъпил' : 'тези ' + r.registerDateDefaulted + ' документа ще бъдат отчетени като постъпили'}
            <b>през текущата година</b>, а изведената наличност към 01.01. ще излезе с
            ${r.registerDateDefaulted} по-малка от действителната. Ако това е стар фонд, върнете резервното копие
            отпреди вноса и повторете вноса с попълнено поле „Дата на вписване по подразбиране“, или поправете
            датите от „Инвентарна книга“ → „Редакция“.</div>`}
    </div>` : ''}
    ${(r.deaccessionedToNote || r.statusToNote) ? `<div class="note" style="margin-top:12px">
      <b>Състояния, които не са пренесени като състояние</b>
      ${r.deaccessionedToNote ? `<div style="margin-top:6px">${r.deaccessionedToNote}
        ${r.deaccessionedToNote === 1 ? 'ред беше отбелязан' : 'реда бяха отбелязани'} „отчислен“ във файла.
        Документ напуска фонда само с <b>акт за отчисляване</b> (чл. 35, ал. 2) — той е и единственото нещо,
        по което КДБФ и годишният отчет броят отписаното. Затова
        ${r.deaccessionedToNote === 1 ? 'този ред е въведен' : 'тези редове са въведени'} като „наличен“,
        а текстът е записан в забележката. Ако документите наистина са отчислени, съставете акт от
        „Отчисляване“; ако не са — няма какво да се прави.</div>` : ''}
      ${r.statusToNote ? `<div style="margin-top:6px">${r.statusToNote}
        ${r.statusToNote === 1 ? 'ред носеше непознато състояние' : 'реда носеха непознато състояние'} —
        въведени са като „наличен“, а оригиналният текст е добавен към забележката.</div>` : ''}
    </div>` : ''}
    ${/* КОИ РЕДОВЕ СА ПРОПУСНАТИ (v2.4.65).
          Дотук отчетът казваше само „N Пропуснати · дубликати или редове с
          грешка“ — при нула грешки и нула предупреждения. Най-честият случай
          обаче не е дубликат, а сблъсък: ред, чийто инвентарен номер е зает от
          съвсем ДРУГА книга (слята библиотека, втора поредица). Такъв документ
          не влиза никъде и по нищо не личи, че липсва. Списъкът се чете точно
          като съседния „получиха нов инвентарен номер“: ред, номер, заглавие —
          и причината, която казва какво да се направи. */''}
    ${(r.skippedRows || []).length ? `<div class="note" style="margin-top:12px">
      <b>Кои редове не бяха въведени: ${r.skipped}</b>
      <div class="hint" style="margin-top:6px">${r.skippedRows.slice(0, 15).map(s =>
        `ред ${s.line}${s.inv ? ' (№ ' + esc(String(s.inv)) + ')' : ''}${s.title ? ' — „' + esc(String(s.title).slice(0, 60)) + '“' : ''}: ${esc(s.reason)}`
      ).join('<br>')}${r.skippedRows.length > 15 ? '<br>… и още ' + (r.skippedRows.length - 15) : ''}</div>
      ${r.skipped > r.skippedRows.length ? `<div class="hint" style="margin-top:6px">Описани са първите
        ${r.skippedRows.length} от ${r.skipped} пропуснати реда; останалите са от същия вид или са
        изброени по-долу като редове с грешка.</div>` : ''}
    </div>` : ''}
    ${(r.warnings || []).length ? `<div class="note w" style="margin-top:12px">
      <b>Предупреждения: ${r.warnings.length}</b>
      <div class="hint" style="margin-top:6px">${r.warnings.slice(0, 15).map(w => esc(w)).join('<br>')}${r.warnings.length > 15 ? '<br>…' : ''}</div>
    </div>` : ''}
    ${r.errors.length ? `<div class="note" style="border-left-color:var(--red);margin-top:12px">
      <b style="color:var(--red)">Редове с грешка: ${r.errors.length}</b>
      <div class="hint" style="margin-top:6px">${r.errors.slice(0, 15).map(x =>
        `ред ${x.line}: ${esc(x.error)}`).join('<br>')}${r.errors.length > 15 ? '<br>…' : ''}</div>
    </div>` : ''}
    <div class="hint" style="margin-top:12px">Прегледайте въведеното в „Книги“. Ако нещо не е наред,
    възстановете резервното копие отпреди въвеждането — то се прави автоматично при първото
    стартиране за деня.</div>`,
    `<button class="btn pri" onclick="closeModal();go('books')">Към книгите</button>`);
}
window.importRun = importRun;
