// Настройки — целият "супер-домейн": основната форма на Настройки,
// номенклатури, лични данни/анонимизация, защита на ЕГН/ЛК с обща парола,
// правила за обслужване по категория, календар, служители, резервни
// копия. Оставен като един файл нарочно — в app.js подсекциите му нямат
// собствени последователни граници (напр. saveSetup/saveLimits/saveNotices
// стоят физически в самия край, под "Календар", далеч от заглавието
// "Настройки"), затова допълнително разбиване носи риск без полза.

/* ---------------- Настройки ---------------- */
function fmtBytes(n) {
  if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' МБ';
  return Math.round(n / 1024) + ' КБ';
}
function fmtDateTime(ms) {
  const d = new Date(ms);
  return bg(d.toISOString().slice(0, 10)) + ' ' + d.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}
async function renderSetup() {
  const [s, dbLoc, backups, employees, cats, limits] = await Promise.all([
    call(window.api.settings.get()), call(window.api.dbLocation.get()),
    call(window.api.backup.list()), call(window.api.employees.list()),
    call(window.api.categories.list()), call(window.api.limits.usage())
  ]);
  if (!s) return;
  window._EMPLOYEES_ALL = employees || [];
  $('#view').innerHTML = `
    ${needsSetup(s) ? `<div class="note" style="border-left-color:var(--brass)">
      <b>Първоначална настройка.</b> Попълнете данните на библиотеката по-долу и натиснете
      „Запиши настройките“. Те се използват автоматично навсякъде — в заглавията на актовете,
      протоколите и регистрите за печат, в баркод етикетите и читателските карти, и в лентата
      вляво. Променят се само тук и важат веднага за всички разпечатки.</div>` : ''}
    <form id="stF" onsubmit="return false">
    <div class="grid g2">
      <div class="card"><h3 style="margin-top:0">Библиотека</h3>
        ${fld('Организация', 'org', { val: s.org })}
        ${fld('Наименование на библиотеката', 'lib_name', { val: s.lib_name })}
        ${fld('Населено място', 'place', { val: s.place })}
        <div class="grid g2">${fld('ЕИК / БУЛСТАТ', 'bulstat', { val: s.bulstat || '' })}${fld('Рег. № в Мин. на културата', 'reg_no', { val: s.reg_no || '' })}</div>
        <div class="grid g2">${fld('Ръководител', 'director', { val: s.director || '' })}${fld('Длъжност', 'director_role', { val: s.director_role || '' })}</div>
        ${fld('Библиотекар', 'librarian', { val: s.librarian || '' })}
        ${fld('Адрес на сайта', 'cat_url', { val: s.cat_url || '' })}
        ${fld('SRU сървър за внасяне на записи', 'sru_endpoint', { val: s.sru_endpoint || '',
          hint: 'по подразбиране: каталогът на Library of Congress (безплатен, без договор). ' +
                'Ако библиотеката получи достъп до SRU на НБКМ/COBISS, адресът се сменя тук.' })}
        <div class="field"><label>Лого на организацията</label>
          <div class="logoBox">
            ${s.logo ? `<img src="${esc(s.logo)}" alt="лого">`
                     : '<div class="logoEmpty">няма<br>лого</div>'}
            <div>
              <div class="toolbar" style="margin:0">
                <button type="button" class="btn" onclick="chooseLogo()">${s.logo ? 'Смени…' : 'Избери файл…'}</button>
                ${s.logo ? '<button type="button" class="btn dgr" onclick="clearLogo()">Премахни</button>' : ''}
              </div>
              <div class="hint" style="margin-top:6px">PNG, JPG, GIF, WEBP или SVG, до 512 KB.
              Влиза автоматично в заглавната част на всички документи за печат — актове, протоколи,
              инвентарна книга, КДБФ, картони, напомнителни писма — и в читателските карти.</div>
            </div>
          </div>
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">Обслужване</h3>
        <div class="note" style="margin-top:0">Стойностите тук са <b>общите по подразбиране</b>. Отделна категория
        читатели (напр. деца или специалисти) може да има собствени срокове — вижте картата
        „Правила по категория читатели“ по-долу.</div>
        <div class="grid g2">
          ${fld('Срок за заемане (дни)', 'loan_days', { val: s.loan_days, type: 'number' })}
          ${fld('Максимум документи на читател', 'max_books', { val: s.max_books, type: 'number' })}
          ${fld('Брой продължения', 'extensions_count', { val: s.extensions_count, type: 'number' })}
          ${fld('Дни на продължение', 'extension_days', { val: s.extension_days, type: 'number' })}
          ${fld('Обезщетение за забава (лв./ден)', 'fine_per_day', { val: s.fine_per_day, type: 'number', step: '0.01' })}
          ${fld('Годишна такса (лв.)', 'annual_fee', { val: s.annual_fee, type: 'number', step: '0.01' })}
        </div>
        <div class="grid g2">
          ${fld('Фонд на свободен достъп (%)', 'free_access_pct', { val: s.free_access_pct, type: 'number' })}
          ${fld('Следващ инвентарен номер', 'next_inv_number', { val: s.next_inv_number, type: 'number' })}
        </div>
        <div class="grid g2">
          ${fld('Наказание при забава (дни без заемане за всеки ден)', 'suspend_per_day',
            { val: s.suspend_per_day ?? 0, type: 'number', step: '0.5', hint: '0 = изключено. По-приложимо от глоба в стотинки.' })}
          ${fld('Таван на наказанието (дни)', 'suspend_max', { val: s.suspend_max ?? 90, type: 'number',
            hint: 'общо за читателя, не за всяко връщане. Празно или 0 = 90 дни по подразбиране; ' +
                  'за изключване ползвайте полето вляво.' })}
        </div>
        <div class="grid g2">
          ${fld('2-ро напомняне след (дни просрочие)', 'remind2_days', { val: s.remind2_days ?? 14, type: 'number' })}
          ${fld('3-то напомняне след (дни просрочие)', 'remind3_days', { val: s.remind3_days ?? 30, type: 'number' })}
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><h3 style="margin-top:0">Постоянна комисия</h3>
      <div class="grid g3">
        ${fld('Член 1 (библиотекар)', 'committee1', { val: s.committee1 || '' })}
        ${fld('Член 2', 'committee2', { val: s.committee2 || '' })}
        ${fld('Член 3 (счетоводител)', 'committee3', { val: s.committee3 || '' })}
      </div>
      <div class="hint">Комисията се назначава със заповед на ръководителя; участието на библиотекар и счетоводител е задължително (чл. 35, ал. 1).</div>
    </div>
    <div class="card" style="margin-top:14px"><h3 style="margin-top:0">Правила по категория читатели</h3>
      <div class="note" style="margin-top:0">Празно поле = ползва се общата стойност от картата „Обслужване“.
      Не е нужно да попълвате всички полета за всяка категория — само тези, които реално се различават
      (напр. децата с по-кратък срок, специалистите — без наказание).</div>
      <div id="circRulesBox">зареждане…</div>
      <div class="toolbar" style="margin-top:8px"><button class="btn" onclick="addCircRule()">+ Правило за категория…</button></div>
    </div>
    <div class="card" style="margin-top:14px"><h3 style="margin-top:0">Календар на библиотеката</h3>
      <div class="note" style="margin-top:0">Падеж, паднал се в затворен ден, се измества автоматично към
      следващия работен ден. Затворените дни не се броят в наказанието за забава.</div>
      <div id="calWorkDays">зареждане…</div>
      <div class="toolbar" style="margin-top:10px"><button class="btn" onclick="saveWorkDays()">Запиши работните дни</button></div>
      <h3 style="font-size:14px;margin:16px 0 8px">Затворени дни (официални празници, отпуск)</h3>
      <div class="toolbar">
        ${fld('Дата', 'calDate', { type: 'date', val: today() })}
        ${fld('Причина', 'calReason', { val: '', hint: 'по желание' })}
        <div class="field"><label>&nbsp;</label><button class="btn" onclick="addClosedDay()" style="width:100%">+ Добави</button></div>
      </div>
      <div id="calClosedBox">зареждане…</div>
    </div>
    <div class="card" style="margin-top:14px"><h3 style="margin-top:0">Лични данни (ЗЗЛД / GDPR)</h3>
      <div class="note" style="margin-top:0">Върнати заемания, по-стари от зададения срок, могат да се
      <b>анонимизират</b>: името на читателя изчезва от историята, а за статистиката остава само
      „категория · година“ (напр. „дете до 14 г. · 2024“). Действието е <b>необратимо</b> и се
      изпълнява само с бутона по-долу — никога автоматично. Съгласията на читателите вече се
      записват с дата (вижда се във формата на всеки читател).</div>
      <div class="grid g2">
        ${fld('Анонимизиране на заемания, по-стари от (години)', 'anonymize_years',
          { val: s.anonymize_years ?? 0, type: 'number', hint: '0 = изключено' })}
        <div class="field"><label>&nbsp;</label>
          <button type="button" class="btn" onclick="runAnonymize()" style="width:100%">Анонимизирай сега…</button></div>
      </div>
      <div class="hint" id="anonHint">зареждане…</div>
    </div>
    <div class="toolbar" style="margin-top:14px"><button type="button" class="btn pri" onclick="saveSetup()">Запиши настройките</button></div>
    </form>

    <!-- Тази карта стои ИЗВЪН <form id="stF"> по две причини, и двете съществени:
         1) loadPdpBox() вкарва в #pdpBox поле за парола; вложена <form> в друга <form>
            се изхвърля мълчаливо от HTML парсера (по спецификация), заради което
            бутонът „Отключи" по-рано не правеше нищо — formData() получаваше null.
         2) Дори като <div>, поле вътре в #stF щеше да попадне в formData('#stF') на
            saveSetup() и паролата щеше да пътува към settings:update без нужда.
         Картата е самостоятелна — има си собствени бутони и не се пази с „Запиши
         настройките". -->
    <div class="card" style="margin-top:14px"><h3 style="margin-top:0">Защита на ЕГН / № лична карта</h3>
      <div class="note" style="margin-top:0">ЕГН и номер на лична карта на читателите могат да се пазят
      <b>криптирани</b> в самата база данни, с обща парола за всички компютри, които ползват тази база —
      важи и за споделена мрежова база. Останалите данни на читателя (име, адрес, телефон, история на
      заемания) не са засегнати и работят нормално без паролата. Паролата се въвежда веднъж на всеки
      компютър, докато програмата работи. <b>Ако паролата бъде забравена, ЕГН/№ ЛК стават
      невъзстановими</b> — както при криптирано резервно копие.</div>
      <div id="pdpBox">зареждане…</div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Номенклатури</h3>
      <div class="note" style="margin-top:0">Контролирани списъци за полетата с избор — така „худ. л-ра“ и
      „художествена литература“ не се разпиляват като различни стойности. Вторият (незадължителен) надпис на
      реда е <b>публичният</b> — той се показва в онлайн каталога вместо вътрешния (напр. вътрешно
      „краеведски“, публично „Краезнание“). Записва се по един ред за стойност:
      <code>стойност | публичен надпис</code>.</div>
      <div id="avEditors">зареждане…</div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Шаблони за напомняния</h3>
      <div class="note" style="margin-top:0">Текстовете за писмо, SMS и заглавие на напомнянията за
      просрочени материали (раздел „Просрочени“) се редактират тук. Плейсхолдър във фигурни скоби,
      напр. <code>{reader}</code>, се заменя автоматично при подготовката на всяко напомняне.
      Оставете поле празно, за да ползвате текста по подразбиране.</div>
      <div class="hint" id="noticePh" style="margin:6px 0 10px;line-height:1.7">зареждане на плейсхолдъри…</div>
      <form id="noticesF" onsubmit="return false">
        ${fld('Тема на писмото', 'notice_subject', { val: s.notice_subject || '', hint: 'използва се само за имейл' })}
        ${fld('Текст на писмото', 'notice_body', { type: 'textarea', rows: 9, val: s.notice_body || '' })}
        ${fld('Кратък текст за SMS', 'notice_sms', { type: 'textarea', rows: 2, val: s.notice_sms || '' })}
      </form>
      <div class="toolbar">
        <button class="btn pri" onclick="saveNotices()">Запиши шаблоните</button>
        <button class="btn" onclick="resetNoticeTemplates()">Възстанови по подразбиране</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Антивирусна защита</h3>
      <div class="note" style="margin-top:0">Докато инсталаторът е без закупен цифров подпис, Windows
      Defender и други антивирусни може да спират инсталирането или да заключват файловете на
      програмата — базата данни, резервните копия, папката на каталога. Това е <b>фалшива
      тревога</b> заради липсващия подпис, не признак за зловреден код.</div>
      <div class="toolbar">
        <button class="btn pri" onclick="avScript()">Скрипт за Defender…</button>
        <button class="btn" onclick="avCopyDirs()">Копирай папките (за AVG и др.)</button>
        <button class="btn" onclick="avHelp()">Какво да направя?</button>
      </div>
      <div class="hint" style="margin-top:8px">Скриптът добавя папките на програмата в изключенията
      на Windows Defender и я разрешава през „Защита от рансъмуер“. Записва се като файл, който се
      изпълнява <b>веднъж, като администратор</b> (десен бутон → „Изпълни като администратор“).</div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Внасяне на данни от друга система</h3>
      <div class="note" style="margin-top:0">Ако библиотеката е водила фонда в друга програма
      (<b>АБ</b>, <b>iLib</b>) или в таблица на Excel, записите се внасят оттам, вместо да се
      преписват на ръка. Четат се <b>CSV</b>, <b>TXT</b>, <b>TSV</b> и <b>XLSX</b>; кирилицата в
      стари файлове (Windows-1251) се разпознава сама.</div>
      <div class="toolbar"><button class="btn pri" onclick="importChoose()">Избери файл за внасяне…</button></div>
      <div class="hint" style="margin-top:8px">След избора се показва как са разпознати колоните и
      първите редове от файла — съответствието се проверява и поправя, преди нещо да се запише.
      <b>Направете резервно копие преди голямо внасяне.</b></div>
    </div>

    ${categoriesCardHtml(cats)}

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Ограничения на записите</h3>
      <div class="note" style="margin-top:0">Горна граница за броя записи в програмата. <b>0 означава без
      ограничение.</b> Проверява се само при добавяне на нов запис — вече въведените данни остават
      достъпни и редактируеми дори ако лимитът бъде намален по-късно.</div>
      <form id="limF" onsubmit="return false"><div class="grid g2">
        ${fld('Лимит на документите във фонда', 'limit_books', { val: limits ? limits.limitBooks : 0, type: 'number',
          hint: limits ? 'в момента: ' + limits.books.toLocaleString('bg-BG') : '' })}
        ${fld('Лимит на читателите', 'limit_readers', { val: limits ? limits.limitReaders : 0, type: 'number',
          hint: limits ? 'в момента: ' + limits.readers.toLocaleString('bg-BG') : '' })}
      </div></form>
      ${limits && (limits.limitBooks > 0 || limits.limitReaders > 0) ? `
        <div style="margin-top:6px">
          ${limits.limitBooks > 0 ? limitBarHtml('Документи', limits.books, limits.limitBooks) : ''}
          ${limits.limitReaders > 0 ? limitBarHtml('Читатели', limits.readers, limits.limitReaders) : ''}
        </div>` : ''}
      <div class="toolbar"><button class="btn pri" onclick="saveLimits()">Запиши ограниченията</button></div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Външен вид — цветова тема</h3>
      <div class="hint" style="margin-top:0;margin-bottom:10px">Избраната тема се прилага веднага на всички компютри, които ползват тази база данни.</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        ${THEMES.map(t => `<button type="button" onclick="setTheme('${t.id}')"
          style="width:112px;border:2px solid ${s.theme === t.id ? 'var(--ink)' : 'var(--rule2)'};border-radius:4px;padding:0;overflow:hidden;cursor:pointer;background:none;text-align:left">
          <span style="display:block;height:36px;background:${t.spine}"></span>
          <span style="display:block;height:15px;background:${t.brass}"></span>
          <span style="display:block;padding:6px 8px;font-size:11px;background:${t.paper};color:#1B1813">${esc(t.name)}${s.theme === t.id ? ' ✓' : ''}</span>
        </button>`).join('')}
      </div>
      <label class="chk" style="margin-top:12px"><input type="checkbox" ${s.scan_sound == null || +s.scan_sound ? 'checked' : ''}
        onchange="setScanSound(this.checked)"><span>Звуков сигнал при сканиране в „Заемане и връщане“ —
        кратък висок тон при успех, двоен нисък при отказ/забава/заделена книга. Очите са върху книгата,
        не върху екрана — звукът се забелязва.</span></label>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Работа в мрежа (няколко компютъра)</h3>
      <div class="note" style="margin-top:0">За да работят няколко работни компютъра с една и съща база данни, посочете
      папка на <b>споделен мрежов диск</b> (напр. картографиран диск <code>Z:\\</code> или път от вида
      <code>\\\\СЪРВЪР\\споделена-папка</code>) — всички програми, сочещи към тази папка, ще виждат едни и същи данни.</div>
      <div class="note w"><b>Важно за надеждността:</b> SQLite (форматът на базата данни) официално <b>не е препоръчан</b>
      за едновременен запис от няколко компютъра върху мрежов диск (SMB) — заключването на файлове по мрежата не винаги
      работи коректно и в редки случаи може да доведе до повредена база. Препоръки: работете един по един, когато е
      възможно; правете редовно резервно копие на файла <code>library.db</code>; ако забележите грешки „database is
      locked“ или повредени данни — върнете последното добро резервно копие. За библиотека с интензивна едновременна
      работа от много станции е по-безопасно решение истинска клиент-сървър база данни, което е извън обхвата на тази версия.</div>
      <div class="hint">Текуща папка: <b style="font-family:var(--mono)">${esc(dbLoc ? dbLoc.folder : '')}</b>
      ${dbLoc && dbLoc.isDefault ? ' (по подразбиране, локална)' : ' (персонализирана)'}</div>
      <div class="toolbar">
        <button class="btn pri" onclick="chooseDbLocation()">Избери мрежова/друга папка…</button>
        ${dbLoc && !dbLoc.isDefault ? '<button class="btn" onclick="resetDbLocation()">Върни към локалната по подразбиране</button>' : ''}
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Служители</h3>
      <div class="note" style="margin-top:0">Списъкът е общ за всички компютри, свързани към тази база данни. Изборът
      „кой служител работи в момента“ (долу вляво в лентата) е локален за всеки компютър и записва избраното име в
      одитната следа при всяко действие.</div>
      <div class="toolbar"><button class="btn pri" onclick="employeeForm()">+ Нов служител</button></div>
      ${employees && employees.length ? `<div class="wrap" style="margin-top:10px"><table class="ledger"><thead><tr>
        <th>Име</th><th>Състояние</th><th></th></tr></thead><tbody>
        ${employees.map(e => `<tr><td>${esc(e.name)}</td>
          <td>${e.active ? '<span class="badge ok">активен</span>' : '<span class="badge warn">неактивен</span>'}</td>
          <td>
            <button class="btn sm" onclick="employeeForm(${e.id})">Редакция</button>
            <button class="btn sm" onclick="toggleEmployeeActive(${e.id},${e.active})">${e.active ? 'Деактивирай' : 'Активирай'}</button>
            <button class="btn sm dgr" onclick="deleteEmployee(${e.id})">Изтрий</button>
          </td></tr>`).join('')}
        </tbody></table></div>` : '<div class="hint">Все още няма добавени служители.</div>'}
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Резервно копие</h3>
      <div class="note" style="margin-top:0">Всяко действие (нов документ, заемане, връщане, отчисляване и т.н.) се
      записва автоматично в базата данни — няма нужда от бутон „Запази“ за самите данни. Освен това програмата прави
      <b>автоматично резервно копие веднъж на ден</b> (при първото стартиране за деня) в подпапка <code>backups</code>
      до базата данни, като пази последните 30 дни. Копията служат за възстановяване при срив на компютъра/програмата,
      или за пренасяне на данните на друг компютър със същата програма.</div>
      <!-- Състоянието на автоматичното копие: криптирано ли е и ако не — защо.
           До v2.2.0 предупреждението се вписваше само в одитната следа, където
           библиотекарят на практика никога не поглежда. -->
      <div id="autoBkBox"></div>
      <div class="toolbar">
        <button class="btn pri" onclick="backupNowForm()">Направи резервно копие сега…</button>
        <button class="btn" onclick="restoreBackupBrowse()">Възстанови от файл…</button>
      </div>
      ${backups && backups.length ? `<div class="wrap" style="margin-top:10px"><table class="ledger"><thead><tr>
        <th>Файл</th><th>Дата и час</th><th>Размер</th><th>Вид</th><th></th></tr></thead><tbody>
        ${backups.map(b => `<tr><td style="font-family:var(--mono);font-size:12px">${esc(b.name)}</td>
          <td class="num">${fmtDateTime(b.mtime)}</td><td class="num">${fmtBytes(b.size)}</td>
          <td>${b.auto ? '<span class="badge">автоматично</span>' : '<span class="badge ok">ръчно</span>'}
              ${b.encrypted ? '<span class="badge" title="Защитено с парола">🔒 криптирано</span>' : ''}</td>
          <td><button class="btn sm" onclick="restoreBackupFromList('${jsq(b.path)}')">Възстанови</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="hint">Все още няма направени резервни копия.</div>'}
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Обновяване</h3>
      ${updateStatusHtml()}
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Помощ и обратна връзка</h3>
      <div class="note" style="margin-top:0">Програмата се ползва от читалищни, общински и училищни библиотеки в
      цялата страна — съобщение за забелязана грешка помага на всички.
      <b>Не прилагайте файла на базата данни или лични данни на читатели</b> към съобщението — опишете само
      какво сте направили и какво се случи.</div>
      <div class="hint" style="margin-bottom:4px">Имейл за връзка с разработчика:
        <b style="font-family:var(--mono)">${esc(DEV_CONTACT_EMAIL)}</b></div>
      <div class="hint" style="margin-bottom:10px">Уебсайт на програмата:
        <a href="${esc(DEV_SITE_URL)}" target="_blank" rel="noopener">${esc(DEV_SITE_URL.replace(/^https?:\/\//, ''))}</a></div>
      <div class="toolbar">
        <button type="button" class="btn pri" onclick="reportBug()">Съобщи за грешка…</button>
        <button type="button" class="btn" onclick="copyDevEmail()">Копирай имейла</button>
      </div>
    </div>
    <div class="hint" style="margin-top:20px;font-family:var(--mono);font-size:10.5px">${esc(APP_CREDIT_TEXT)}</div>`;
  loadNoticePlaceholders();
  loadAvEditors();
  loadAnonHint();
  loadPdpBox();
  loadCircRulesBox();
  loadCalendarBox();
  loadAutoBackupBox();
}
/* ---------------- Състояние на автоматичното резервно копие ----------------
   Дневното копие се криптира само когато защитата на личните данни е
   конфигурирана И отключена (тогава ползва нейната парола). Иначе на диска —
   по документирания сценарий често в СПОДЕЛЕНА мрежова папка — стоят 30 дневни
   копия с имената, адресите и телефоните на всички читатели в чист текст.
   Затова състоянието се показва тук, до самите копия, а не само в одита. */
async function loadAutoBackupBox() {
  const el = $('#autoBkBox'); if (!el) return;
  subscribeAutoBackupEvents();
  const st = await call(window.api.backup.autoStatus());
  if (!st) { el.innerHTML = ''; return; }
  /* Четирите случая идват готови от main процеса (backup:autoStatus), който ги
     смята по ДЕЙСТВИТЕЛНИЯ файл за деня, а не по настройките. Резервното
     извеждане тук е заради по-стар main (и заради тестове, които подават само
     encrypted/pdpConfigured): тогава „провалено криптиране“ просто не се знае. */
  const state = st.state || (st.encrypted ? 'encrypted' : (st.pdpConfigured ? 'locked' : 'off'));
  /* Колко некриптирани дневни копия лежат на диска ТОЧНО СЕГА. Общото „копията не
     се криптират“ се чете като бъдещо време; числото показва вече натрупаната
     експозиция — всяко от тези копия е пълен списък с имена, адреси, телефони и
     ЕГН на читателите. */
  const plainNote = st.plainDailyCount > 0
    ? ` В папката с резервните копия в момента има <b>${Number(st.plainDailyCount)}</b> некриптирани дневни копия
        (всяко е пълен списък с личните данни на читателите).`
    : '';
  if (state === 'encrypted') {
    el.innerHTML = `<div class="note" style="margin-top:0">🔒 Автоматичните дневни копия се
      <b>криптират</b> с паролата за защита на личните данни.
      ${st.last ? 'Последно копие: ' + esc(st.last.date) + '.' : ''}</div>`;
    return;
  }
  if (state === 'failed') {
    /* Най-опасният случай: библиотекарят е направил всичко както трябва, а
       копието въпреки това е в чист текст. Затова се казва изрично КАКВО се е
       провалило и се дава пряк изход — ръчно криптирано копие сега. */
    el.innerHTML = `<div class="note d" style="margin-top:0">
      <b>⚠ Днешното копие НЕ е криптирано, въпреки че защитата е включена.</b>
      ${esc(st.warning || '')}${plainNote}
      <div class="toolbar" style="margin:8px 0 0">
        <button type="button" class="btn pri" onclick="backupNowForm()">Направи копие с парола сега…</button>
        <button type="button" class="btn" onclick="pdpFocus()">Към защитата на личните данни</button>
      </div>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="note ${state === 'locked' ? 'w' : 'd'}" style="margin-top:0">
    <b>${state === 'locked' ? '⚠ Копията не се криптират в момента.' : '⚠ Копията НЕ са криптирани.'}</b>
    ${esc(st.warning || '')}${plainNote}
    ${state === 'locked'
      ? '<div class="toolbar" style="margin:8px 0 0"><button type="button" class="btn" onclick="pdpFocus()">Към защитата на личните данни</button></div>'
      : '<div class="toolbar" style="margin:8px 0 0"><button type="button" class="btn pri" onclick="pdpSetupForm()">Включи защита на личните данни…</button></div>'}
  </div>`;
}
window.loadAutoBackupBox = loadAutoBackupBox;
/* Известия от main процеса: дневното копие беше прекриптирано (напр. след смяна
   на паролата) или опитът се провали. Дотук провалът не стигаше до библиотекаря
   по никакъв път освен конзолата. Абонаментът е еднократен за целия живот на
   прозореца — картата се прерисува само ако е на екрана. */
let autoBkSubscribed = false;
function subscribeAutoBackupEvents() {
  if (autoBkSubscribed) return;
  const api = window.api && window.api.backup;
  if (!api || typeof api.onAutoStatus !== 'function') return; // по-стар preload — картата пак се чете при отваряне
  autoBkSubscribed = true;
  api.onAutoStatus((info) => {
    if (info && info.message) toast(info.message, info.level === 'err' ? 'err' : 'ok');
    loadAutoBackupBox();
  });
}
// Само превърта до картата за защитата — тя е по-нагоре в същия екран.
function pdpFocus() {
  const box = $('#pdpBox');
  if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
window.pdpFocus = pdpFocus;
/* ---------------- Номенклатури (редактор) ---------------- */
async function loadAvEditors() {
  const box = $('#avEditors'); if (!box) return;
  const [cats, opts] = await Promise.all([call(window.api.av.categories()), call(window.api.av.options())]);
  if (!cats || !opts) { box.textContent = 'Номенклатурите не се заредиха.'; return; }
  box.innerHTML = Object.entries(cats).map(([key, label]) => `
    <div class="field" style="margin-top:10px"><label>${esc(label)}</label>
      <textarea id="av_${key}" rows="${Math.max(3, (opts[key] || []).length + 1)}" spellcheck="false"
        style="font-family:var(--mono);font-size:12.5px">${esc((opts[key] || [])
          .map(o => o.value + (o.opac_label ? ' | ' + o.opac_label : '')).join('\n'))}</textarea>
      <div class="toolbar" style="margin-top:6px">
        <button class="btn sm" onclick="saveAv('${key}')">Запиши списъка</button>
      </div>
    </div>`).join('');
}
async function saveAv(category) {
  const el = $('#av_' + category); if (!el) return;
  const values = el.value.split('\n').map(line => {
    const [value, opac_label] = line.split('|').map(x => (x || '').trim());
    return { value, opac_label };
  }).filter(v => v.value);
  const n = await call(window.api.av.save({ category, values }), null);
  if (n == null) return;
  toast('Списъкът е записан (' + n + ' стойности). Менютата го ползват веднага.', 'ok');
  markSaved();
}
window.saveAv = saveAv;
/* ---------------- Лични данни ---------------- */
async function loadAnonHint() {
  const el = $('#anonHint'); if (!el) return;
  const r = await call(window.api.gdpr.candidates());
  if (!r) { el.textContent = ''; return; }
  el.textContent = !r.years
    ? 'Анонимизирането е изключено (0 години).'
    : (r.count
        ? `Готови за анонимизиране: ${r.count} върнати заемания отпреди ${bg(r.cutoff)}.`
        : `Няма върнати заемания отпреди ${bg(r.cutoff)} — нищо за анонимизиране.`);
}
async function runAnonymize() {
  const r = await call(window.api.gdpr.candidates());
  if (!r) return;
  if (!r.years) return toast('Първо задайте срок в години (и запишете настройките).', 'err');
  if (!r.count) return toast('Няма заемания за анонимизиране.', 'ok');
  if (!confirm(`НЕОБРАТИМО: ${r.count} върнати заемания отпреди ${bg(r.cutoff)} ще загубят връзката с имената ` +
    'на читателите (остава само „категория · година“). Да продължа?')) return;
  const res = await call(window.api.gdpr.anonymize());
  if (!res) return;
  toast('Анонимизирани ' + res.anonymized + ' заемания.', 'ok');
  markSaved();
  loadAnonHint();
}
window.runAnonymize = runAnonymize;
/* ---------------- Защита на ЕГН/№ ЛК (обща парола) ---------------- */
async function loadPdpBox() {
  const el = $('#pdpBox'); if (!el) return;
  const s = await call(window.api.pdp.status());
  if (!s) { el.textContent = ''; return; }
  if (!s.configured) {
    el.innerHTML = `<div class="toolbar" style="margin:0">
      <button type="button" class="btn pri" onclick="pdpSetupForm()">Задай парола за защита…</button></div>`;
    return;
  }
  if (!s.unlocked) {
    el.innerHTML = `<div class="note w" style="margin:0 0 10px">🔒 Заключено за тази сесия — ЕГН/№ ЛК се
      показват като „Защитени данни“, докато не въведете паролата.</div>
      <div id="pdpUnlockF" style="max-width:320px">
        ${fld('Парола', 'password', { type: 'password' })}
      </div>
      <div class="toolbar" style="margin:0"><button type="button" class="btn pri" onclick="pdpDoUnlock()">Отключи</button></div>`;
    return;
  }
  el.innerHTML = `<div class="note" style="margin:0 0 10px">🔓 Отключено за тази сесия.</div>
    <div class="toolbar" style="margin:0">
      <button type="button" class="btn" onclick="pdpDoLock()">Заключи</button>
      <button type="button" class="btn" onclick="pdpChangePasswordForm()">Смени паролата…</button>
    </div>`;
}
function pdpSetupForm() {
  modal('Задаване на парола за защита на ЕГН/№ ЛК', `
    <div class="note w" style="margin-top:0"><b>Пазете тази парола.</b> Ползвайте я на всеки компютър,
    който работи със същата база данни. Ако бъде забравена, ЕГН/№ ЛК на читателите стават
    невъзстановими.</div>
    <form id="pdpSetupF" onsubmit="return false">
      ${fld('Нова парола', 'password', { type: 'password' })}
      ${fld('Повтори паролата', 'password2', { type: 'password' })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="pdpDoSetup()">Задай паролата</button>`);
}
window.pdpSetupForm = pdpSetupForm;
async function pdpDoSetup() {
  const d = formData('#pdpSetupF');
  if (!d.password || d.password.length < 4) return toast('Паролата трябва да е поне 4 знака.', 'err');
  if (d.password !== d.password2) return toast('Двете пароли не съвпадат.', 'err');
  const res = await window.api.pdp.setup(d.password);
  if (!res.ok) return toast(res.error, 'err');
  closeModal();
  toast('Защитата е зададена — ЕГН/№ ЛК вече са криптирани.', 'ok');
  loadPdpBox();
  loadAutoBackupBox(); // отключването/заключването сменя дали копието се криптира
}
window.pdpDoSetup = pdpDoSetup;
async function pdpDoUnlock() {
  const d = formData('#pdpUnlockF');
  if (!d.password) return toast('Въведете парола.', 'err');
  const res = await window.api.pdp.unlock(d.password);
  if (!res.ok) return toast(res.error, 'err');
  toast('Отключено.', 'ok');
  loadPdpBox();
  loadAutoBackupBox(); // отключването/заключването сменя дали копието се криптира
}
window.pdpDoUnlock = pdpDoUnlock;
async function pdpDoLock() {
  await window.api.pdp.lock();
  loadPdpBox();
  loadAutoBackupBox(); // отключването/заключването сменя дали копието се криптира
}
window.pdpDoLock = pdpDoLock;
function pdpChangePasswordForm() {
  modal('Смяна на паролата за защита на ЕГН/№ ЛК', `
    <form id="pdpChangeF" onsubmit="return false">
      ${fld('Текуща парола', 'oldPassword', { type: 'password' })}
      ${fld('Нова парола', 'newPassword', { type: 'password' })}
      ${fld('Повтори новата парола', 'newPassword2', { type: 'password' })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="pdpDoChangePassword()">Смени паролата</button>`);
}
window.pdpChangePasswordForm = pdpChangePasswordForm;
async function pdpDoChangePassword() {
  const d = formData('#pdpChangeF');
  if (!d.oldPassword) return toast('Въведете текущата парола.', 'err');
  if (!d.newPassword || d.newPassword.length < 4) return toast('Новата парола трябва да е поне 4 знака.', 'err');
  if (d.newPassword !== d.newPassword2) return toast('Двете нови пароли не съвпадат.', 'err');
  const res = await window.api.pdp.changePassword({ oldPassword: d.oldPassword, newPassword: d.newPassword });
  if (!res.ok) return toast(res.error, 'err');
  closeModal();
  toast('Паролата е сменена.', 'ok');
  loadPdpBox();
  loadAutoBackupBox(); // отключването/заключването сменя дали копието се криптира
}
window.pdpDoChangePassword = pdpDoChangePassword;
/* ---------------- Правила за обслужване по категория ---------------- */
/* Третият елемент е подсказката под полето. „Празно" и „0" НЕ значат едно и също,
   а разликата беше необяснена никъде в интерфейса: празно наследява общата стойност,
   а 0 при лимитите значи „без ограничение" — библиотекар, който впише 0 в „Максимум
   документи" с намерение да ЗАБРАНИ заемането за тази категория, получаваше точно
   обратното. Затова подсказката вече е за всяко поле поотделно. */
const CIRC_RULE_FIELDS = [
  ['loan_days', 'Срок (дни)', 'празно = общото'],
  ['max_books', 'Максимум документи', 'празно = общото · 0 = без ограничение'],
  ['extensions_count', 'Продължения', 'празно = общото · 0 = без ограничение'],
  ['extension_days', 'Дни на продължение', 'празно = общото'],
  ['suspend_per_day', 'Наказание (дни/ден забава)', 'празно = общото · 0 = изключено'],
  ['suspend_max', 'Таван на наказанието', 'празно = общото · 0 = 90 дни']
];
async function loadCircRulesBox() {
  const box = $('#circRulesBox'); if (!box) return;
  const rules = await call(window.api.circRules.list());
  if (!rules) { box.textContent = 'Правилата не се заредиха.'; return; }
  box.innerHTML = rules.length ? `
    <div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead><tr>
      <th>Категория</th>${CIRC_RULE_FIELDS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}<th style="width:80px"></th>
    </tr></thead><tbody>
    ${rules.map(r => `<tr><td><b>${esc(r.category)}</b></td>
      ${CIRC_RULE_FIELDS.map(([k]) => `<td class="num">${r[k] == null ? '<span class="hint">общото</span>' : r[k]}</td>`).join('')}
      <td><button class="btn sm" onclick="addCircRule('${jsq(r.category)}')">Редакция</button></td></tr>`).join('')}
    </tbody></table></div>`
    : '<div class="hint">Още няма отделни правила — всички категории ползват общите стойности от „Обслужване“.</div>';
}
function addCircRule(category) {
  const editing = !!category;
  (editing ? call(window.api.circRules.list()) : Promise.resolve(null)).then(rules => {
    const r = editing && rules ? rules.find(x => x.category === category) : null;
    modal2(editing ? 'Правило — ' + category : 'Ново правило за категория', `
      <form id="crF" onsubmit="return false">
        ${editing
          ? `<input type="hidden" name="category" value="${esc(category)}"><div class="hint" style="margin-bottom:8px">Категория: <b>${esc(category)}</b></div>`
          : fld('Категория', 'category', { type: 'select', opts: KATEG, allowEmpty: false })}
        <div class="grid g2">
          ${CIRC_RULE_FIELDS.map(([k, l, h]) => fld(l, k, { type: 'number', val: r && r[k] != null ? r[k] : '', hint: h || 'празно = общото' })).join('')}
        </div>
      </form>`,
      `<button class="btn" onclick="closeModal2()">Отказ</button>
       ${editing ? `<button class="btn dgr" onclick="deleteCircRule('${jsq(category)}')">Изтрий правилото</button>` : ''}
       <button class="btn pri" onclick="saveCircRule()">Запиши</button>`);
  });
}
window.addCircRule = addCircRule;
async function saveCircRule() {
  const d = formData('#crF');
  if (!d.category || !d.category.trim()) return toast('Изберете категория.', 'err');
  const ok = await call(window.api.circRules.save(d), 'Правилото е записано.');
  if (ok !== null) { closeModal2(); markSaved(); loadCircRulesBox(); }
}
window.saveCircRule = saveCircRule;
async function deleteCircRule(category) {
  if (!confirm('Изтриване на правилото за „' + category + '“? Категорията ще започне да ползва общите стойности.')) return;
  const ok = await call(window.api.circRules.delete(category), 'Изтрито.');
  if (ok !== null) { closeModal2(); loadCircRulesBox(); }
}
window.deleteCircRule = deleteCircRule;

/* ---------------- Календар на библиотеката ---------------- */
const WEEKDAY_NAMES = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
async function loadCalendarBox() {
  const wd = $('#calWorkDays'), cb = $('#calClosedBox');
  if (!wd || !cb) return;
  const cal = await call(window.api.calendar.get());
  if (!cal) { wd.textContent = 'Календарът не се зареди.'; return; }
  wd.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:14px">
    ${WEEKDAY_NAMES.map((name, i) => `<label class="chk"><input type="checkbox" name="wd${i}" ${cal.workDays.includes(i) ? 'checked' : ''}>
      <span>${esc(name)}</span></label>`).join('')}
  </div>`;
  cb.innerHTML = cal.closed.length ? `
    <div class="wrap" style="border:0;box-shadow:none;margin-top:8px"><table class="ledger"><tbody>
    ${cal.closed.map(c => `<tr><td class="num">${bg(c.date)}</td><td>${esc(c.reason || '')}</td>
      <td style="width:60px"><button class="btn sm dgr" onclick="removeClosedDay('${c.date}')">✕</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="hint" style="margin-top:8px">Няма добавени затворени дни.</div>';
}
async function saveWorkDays() {
  const days = [];
  WEEKDAY_NAMES.forEach((_, i) => { const el = document.querySelector(`[name=wd${i}]`); if (el && el.checked) days.push(i); });
  if (!days.length && !confirm('Няма отбелязан нито един работен ден — библиотеката ще излиза „затворена“ всеки ден. Наистина ли?')) return;
  const ok = await call(window.api.calendar.saveWorkDays(days), 'Работните дни са записани.');
  if (ok !== null) { markSaved(); loadCalendarBox(); }
}
window.saveWorkDays = saveWorkDays;
async function addClosedDay() {
  const date = document.querySelector('[name=calDate]').value;
  const reason = document.querySelector('[name=calReason]').value;
  if (!date) return toast('Изберете дата.', 'err');
  const ok = await call(window.api.calendar.addClosed({ date, reason }), 'Добавен затворен ден.');
  if (ok !== null) { markSaved(); loadCalendarBox(); }
}
window.addClosedDay = addClosedDay;
async function removeClosedDay(date) {
  const ok = await call(window.api.calendar.removeClosed(date), 'Премахнато.');
  if (ok !== null) loadCalendarBox();
}
window.removeClosedDay = removeClosedDay;
function employeeForm(id) {
  const emp = id ? (window._EMPLOYEES_ALL || []).find(x => x.id === id) : null;
  modal(emp ? 'Редакция на служител' : 'Нов служител', `
    <form id="empF" onsubmit="return false">
      ${fld('Име', 'name', { val: emp ? emp.name : '', req: 1 })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveEmployee(${id || 'null'})">Запиши</button>`);
}
window.employeeForm = employeeForm;
async function saveEmployee(id) {
  const d = formData('#empF');
  if (!d.name.trim()) return toast('Въведете име.', 'err');
  if (id) await call(window.api.employees.update({ id, name: d.name }), 'Служителят е обновен.');
  else await call(window.api.employees.create(d.name), 'Служителят е добавен.');
  closeModal(); renderSetup();
}
window.saveEmployee = saveEmployee;
async function toggleEmployeeActive(id, active) {
  await call(window.api.employees.update({ id, active: active ? 0 : 1 }), active ? 'Служителят е деактивиран.' : 'Служителят е активиран.');
  renderSetup();
}
window.toggleEmployeeActive = toggleEmployeeActive;
async function deleteEmployee(id) {
  if (!confirm('Изтриване на служителя? Записите в одитната следа с неговото име остават непроменени.')) return;
  await call(window.api.employees.delete(id), 'Служителят е изтрит.');
  renderSetup();
}
window.deleteEmployee = deleteEmployee;
function backupNowForm() {
  modal('Ръчно резервно копие', `
    <div class="note" style="margin-top:0">Копието може да се защити с парола — препоръчително, ако файлът
    ще пътува на USB или ще се изпраща по интернет, тъй като съдържа лични данни на читателите (ЕГН, адреси).</div>
    <form id="bkF" onsubmit="return false">
      <label class="chk"><input type="checkbox" id="bkEnc" onchange="document.getElementById('bkPassWrap').style.display=this.checked?'block':'none'">
        <span>Защити копието с парола (криптиране AES-256)</span></label>
      <div id="bkPassWrap" style="display:none">
        ${fld('Парола', 'password', { type: 'password' })}
        ${fld('Повтори паролата', 'password2', { type: 'password' })}
        <div class="note w" style="margin-top:0"><b>Пазете паролата.</b> Без нея това копие е
        невъзстановимо — няма начин за отключване, ако бъде забравена.</div>
      </div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="backupNow()">Направи копие</button>`);
}
window.backupNowForm = backupNowForm;
async function backupNow() {
  const enc = $('#bkEnc') && $('#bkEnc').checked;
  let password = '';
  if (enc) {
    const d = formData('#bkF');
    if (!d.password) return toast('Въведете парола или махнете отметката за криптиране.', 'err');
    if (d.password !== d.password2) return toast('Двете пароли не съвпадат.', 'err');
    password = d.password;
  }
  const res = await window.api.backup.now({ password });
  if (!res.ok) return toast(res.error, 'err');
  closeModal();
  toast((res.encrypted ? 'Криптирано резервно копие записано: ' : 'Резервно копие записано: ') + res.data, 'ok');
  renderSetup();
}
window.backupNow = backupNow;
function askBackupPassword(path, fromList) {
  modal('Криптирано резервно копие', `
    <div class="note" style="margin-top:0">Файлът е защитен с парола. Въведете паролата, с която е направен.</div>
    <form id="rsF" onsubmit="return false">${fld('Парола', 'password', { type: 'password' })}</form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="restoreWithPassword('${jsq(path)}', ${fromList ? 'true' : 'false'})">Възстанови</button>`);
}
async function restoreWithPassword(path, fromList) {
  const d = formData('#rsF');
  if (!d.password) return toast('Въведете парола.', 'err');
  const res = fromList
    ? await window.api.backup.restoreFromList({ path, password: d.password })
    : await window.api.backup.restoreBrowse({ path, password: d.password });
  if (!res.ok) return toast(res.error, 'err');
}
window.restoreWithPassword = restoreWithPassword;
const RESTORE_WARN = 'Възстановяването ще замени текущите данни в програмата и ще я рестартира. ' +
  'Текущата база се пази автоматично като допълнително копие преди възстановяването. Продължавате ли?';
async function restoreBackupFromList(path) {
  if (!confirm(RESTORE_WARN)) return;
  const res = await window.api.backup.restoreFromList({ path });
  if (!res.ok) return toast(res.error, 'err');
  if (res.data && res.data.needsPassword) askBackupPassword(res.data.path, true);
}
window.restoreBackupFromList = restoreBackupFromList;
async function restoreBackupBrowse() {
  if (!confirm('Ще изберете файл с резервно копие (.db или .invbak) от компютъра/USB/мрежов диск. ' + RESTORE_WARN)) return;
  const res = await window.api.backup.restoreBrowse();
  if (!res.ok) return toast(res.error, 'err');
  if (res.data && res.data.needsPassword) askBackupPassword(res.data.path, false);
}
window.restoreBackupBrowse = restoreBackupBrowse;
async function chooseDbLocation() {
  if (!confirm('Програмата ще копира текущата база данни в новата папка и ще се рестартира. Продължавате ли?')) return;
  const res = await window.api.dbLocation.choose();
  if (!res.ok) return toast(res.error, 'err');
}
window.chooseDbLocation = chooseDbLocation;
async function resetDbLocation() {
  if (!confirm('Връщане към локалната база данни по подразбиране (тази на мрежовия диск остава непроменена)? Програмата ще се рестартира.')) return;
  await window.api.dbLocation.resetDefault();
}
window.resetDbLocation = resetDbLocation;
function updateStatusHtml() {
  const st = UPDATE_STATUS || { state: 'idle' };
  const line = {
    idle: '', checking: 'Проверка за обновления…',
    available: 'Намерена е нова версия ' + (st.version || '') + ' — изтегля се…',
    'not-available': 'Инсталирана е последната версия.',
    downloading: 'Изтегля се обновление' + (st.percent ? ' — ' + st.percent + '%' : '') + '…',
    downloaded: 'Версия ' + (st.version || '') + ' е готова за инсталиране.',
    error: 'Грешка при проверка: ' + (st.message || '')
  }[st.state] || '';
  return `
    <div class="hint" style="margin-bottom:10px">Програмата проверява автоматично за нова версия в GitHub при всяко
    стартиране (изисква интернет връзка). Изтеглената версия се инсталира при следващото затваряне на програмата.</div>
    ${line ? `<div class="note" style="margin-top:0">${esc(line)}</div>` : ''}
    <div class="toolbar">
      <button class="btn" onclick="checkForUpdatesNow()">Провери сега</button>
      ${st.state === 'downloaded' ? '<button class="btn pri" onclick="installUpdateNow()">Инсталирай и рестартирай</button>' : ''}
    </div>`;
}
function limitBarHtml(label, used, limit) {
  const pct = Math.min(100, Math.round(used / limit * 100));
  const cls = pct >= 100 ? 'full' : pct >= 85 ? 'near' : '';
  return `<div style="margin-top:8px">
    <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
      <span>${esc(label)}</span><b>${used.toLocaleString('bg-BG')} / ${limit.toLocaleString('bg-BG')}</b></div>
    <div class="bar"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
    ${pct >= 85 ? `<div class="hint" style="margin-top:4px;color:var(--red)">${pct >= 100
      ? 'Лимитът е достигнат — нови записи не могат да се добавят.'
      : 'Наближавате лимита.'}</div>` : ''}
  </div>`;
}
async function saveLimits() {
  const d = formData('#limF');
  await call(window.api.limits.update(d), 'Ограниченията са записани.');
  renderSetup();
}
window.saveLimits = saveLimits;
async function saveSetup() {
  const d = formData('#stF'); d.id = 1;
  await call(window.api.settings.update(d), 'Настройките са записани.');
  await loadSettingsCache();
  // Пречертава текущия изглед, за да влязат новите данни веднага навсякъде, където
  // се показват — без да се излиза и влиза наново в раздела.
  if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.saveSetup = saveSetup;
async function loadNoticePlaceholders() {
  const d = await call(window.api.settings.noticeDefaults());
  const el = $('#noticePh');
  if (!el) return;
  if (!d) { el.textContent = ''; return; }
  el.innerHTML = 'Налични: ' + d.placeholders.map(([k, t]) => `<code>{${k}}</code> — ${esc(t)}`).join(' &nbsp;·&nbsp; ');
}
async function saveNotices() {
  const d = formData('#noticesF');
  await call(window.api.settings.updateNotices(d), 'Шаблоните са записани.');
  await loadSettingsCache();
}
window.saveNotices = saveNotices;
async function resetNoticeTemplates() {
  if (!confirm('Връщане на трите шаблона към текста по подразбиране?')) return;
  const d = await call(window.api.settings.noticeDefaults());
  if (!d) return;
  $('[name=notice_subject]').value = '';
  $('[name=notice_body]').value = '';
  $('[name=notice_sms]').value = '';
  await call(window.api.settings.updateNotices({ notice_subject: '', notice_body: '', notice_sms: '' }), 'Върнати към стойностите по подразбиране.');
  await loadSettingsCache();
}
window.resetNoticeTemplates = resetNoticeTemplates;
/* ---------------- Помощ и обратна връзка (имейл и уебсайт на разработчика) ----------------
   Статичен, некриптиран контакт на РАЗРАБОТЧИКА на самата програма — не е данни на
   конкретната библиотека, затова нарочно не е поле в базата данни/Настройки, а
   фиксиран текст тук (както в LICENSE/README). Имейлът се изпраща през същия
   loans:mailto IPC канал, който вече отваря mailto: през shell.openExternal — общ,
   не специфичен за читатели, само с валидиран формат на адреса. Линкът към сайта
   е обикновен <a target="_blank"> — main.js вече прихваща такива линкове
   (setWindowOpenHandler) и ги праща към системния браузър вместо в прозореца на
   приложението, затова тук не е нужен отделен IPC канал. */
const DEV_CONTACT_EMAIL = 'plam4o.4o@outlook.com';
const DEV_SITE_URL = 'https://invlib.com/';
async function reportBug() {
  const [version, s] = await Promise.all([
    call(window.api.app.getVersion()), call(window.api.settings.get())
  ]);
  const subject = 'InvLib' + (version ? ' v' + version : '') + ' — съобщение за грешка';
  const body = 'Опишете какво направихте и какво се случи (може и на кратко):\n\n\n\n' +
    '---\n' +
    'Версия на програмата: ' + (version || '?') + '\n' +
    'Библиотека: ' + ((s && (s.lib_name || s.org)) || '') + '\n' +
    'Операционна система: ' + navigator.userAgent + '\n\n' +
    'ВАЖНО: моля, не прилагайте файла на базата данни или лични данни на читатели към това писмо.';
  const res = await window.api.loans.mailto({ email: DEV_CONTACT_EMAIL, subject, body });
  if (!res.ok) return toast(res.error, 'err');
  toast('Пощенският клиент е отворен с попълнено писмо.', 'ok');
}
window.reportBug = reportBug;
async function copyDevEmail() {
  /* Съобщението „копиран“ трябва да е вярно. Дотук стоеше ИЗВЪН try и се
     показваше и когато копирането се е провалило — коментарът твърдеше, че
     отпада мълчаливо, но кодът не правеше това. */
  try {
    await navigator.clipboard.writeText(DEV_CONTACT_EMAIL);
    toast('Имейлът е копиран: ' + DEV_CONTACT_EMAIL, 'ok');
  } catch (e) {
    toast('Копирането не стана — имейлът е ' + DEV_CONTACT_EMAIL, 'err');
  }
}
window.copyDevEmail = copyDevEmail;
