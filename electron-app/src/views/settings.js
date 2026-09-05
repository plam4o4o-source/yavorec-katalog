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
  // Датата и часът от ЕДНА и съща зона (одит v2.4.25): дотук датата идваше от
  // toISOString() (UTC), а часът — местен, и копие от 01:15 на 03.09 се водеше
  // „02.09.2026 01:15“.
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' '
    + d.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}
/* ---------------- Настройки (преустроени във v2.4.27) ----------------
   Дотук: 20 карти една под друга (≈6 200 px), осем различни бутона „Запиши…“,
   шест от картите в една обща форма, а останалите — със свои бутони; полета не
   на мястото си („Следващ инвентарен номер“ под „Обслужване“, SRU под
   „Библиотека“); нищо не води до конкретна карта. Сега:
     • шест раздела с лява навигация (лепкава), търсене в настройките и
       адрес #setup/<раздел> (виж route() в bootstrap.js);
     • полетата на settings:update стоят в няколко блока [data-setup-form] —
       saveSetup() ги събира заедно (setupFormData), за да може всеки раздел да
       има собствен бутон „Запиши“, а обработчикът да получи всички именувани
       параметри, както изисква better-sqlite3;
     • рядко пипаните карти са свити (<details>) с едноредово обобщение;
     • дългите обяснения са зад „Как работи“, за да е страницата прегледна.
   Всички id-та, name-ове и onclick функции са същите — тестовете и мускулната
   памет на библиотекаря не се пипат. */
const SETUP_SECTIONS = [
  ['biblioteka', 'Библиотека', 'данни за документите и печата'],
  ['obsluzhvane', 'Обслужване', 'срокове, правила, календар, напомняния'],
  ['fond', 'Фонд', 'инвентарни номера, видове, номенклатури, проверки'],
  ['lichni', 'Лични данни', 'защита на ЕГН, анонимизиране'],
  ['danni', 'Копия и мрежа', 'резервни копия, споделена база, ограничения'],
  ['programa', 'Програма', 'външен вид, обновяване, помощ']
];
function setupSectionOpen(id, title, sub, chips) {
  return `<section class="setupSec" id="setup-${id}" data-title="${esc(title)}">
    <header class="setupHead"><div><h2>${esc(title)}</h2><p class="setupSub">${esc(sub)}</p></div>
      <div class="setupChips" id="chips-${id}">${chips || ''}</div></header>`;
}
const setupHow = (html) => `<details class="setupHow"><summary>Как работи</summary><div class="note" style="margin:8px 0 0">${html}</div></details>`;
const setupCard = (title, body, opts) => `<div class="card setupCard"${opts && opts.id ? ` id="${opts.id}"` : ''}><h3 style="margin-top:0">${title}</h3>${body}</div>`;
const setupMore = (title, summary, body, opts) => `<details class="setupMore"${opts && opts.open ? ' open' : ''}${opts && opts.id ? ` id="${opts.id}"` : ''}>
    <summary><span class="setupMoreTitle">${esc(title)}</span><span class="setupMoreSum">${summary || ''}</span></summary>
    <div class="setupMoreBody">${body}</div></details>`;
const setupSave = (label) => `<div class="toolbar setupSave"><button type="button" class="btn pri" onclick="saveSetup()">${label || 'Запиши настройките'}</button></div>`;

async function renderSetup() {
  const [s, dbLoc, backups, employees, cats, limits] = await Promise.all([
    call(window.api.settings.get()), call(window.api.dbLocation.get()),
    call(window.api.backup.list()), call(window.api.employees.list()),
    call(window.api.categories.list()), call(window.api.limits.usage())
  ]);
  if (!s) return;
  window._EMPLOYEES_ALL = employees || [];
  const activeEmp = (employees || []).filter(e => e.active).length;
  // Отворените свити карти остават отворени и след пречертаване (преглед на кръга):
  // „Запиши ограниченията“ и смяната на папката пречертават страницата.
  const openMore = new Set([...document.querySelectorAll('#view .setupMore[open] .setupMoreTitle')].map(e => e.textContent));
  const backupChip = backups && backups.length
    ? `<span class="chip" id="chipBackup">копие: ${esc(fmtDateTime(backups[0].mtime).slice(0, 10))}</span>`
    : '<span class="chip w" id="chipBackup">няма копия</span>';
  $('#view').innerHTML = `
    ${needsSetup(s) ? `<div class="note" style="border-left-color:var(--brass)">
      <b>Първоначална настройка.</b> Попълнете данните на библиотеката в раздел „Библиотека“ и натиснете
      „Запиши настройките“. Те се използват автоматично навсякъде — в заглавията на актовете,
      протоколите и регистрите за печат, в баркод етикетите и читателските карти, и в лентата
      вляво. Променят се само тук и важат веднага за всички разпечатки.</div>` : ''}
    <div class="setupWrap">
    <nav class="setupNav" aria-label="Раздели на настройките">
      <input id="setupSearch" type="search" placeholder="Търсене в настройките…" autocomplete="off"
        oninput="setupFilter(this.value)" aria-label="Търсене в настройките">
      ${SETUP_SECTIONS.map(([id, t, sub]) => `<a href="#setup/${id}" data-sec="${id}" onclick="event.preventDefault();setupGo('${id}')">
        <span class="setupNavT">${esc(t)}</span><span class="setupNavS">${esc(sub)}</span></a>`).join('')}
      <div class="hint setupNavHint" id="setupSearchHint"></div>
    </nav>
    <div class="setupBody">

    ${setupSectionOpen('biblioteka', 'Библиотека', 'Организацията, хората и логото — така, както излизат върху всеки документ за печат.',
      `<span class="chip">${activeEmp ? pl(activeEmp, 'активен служител', 'активни служители') : 'без служители'}</span>`)}
    <form id="stF" data-setup-form onsubmit="return false">
      <div class="grid g2">
        <div class="card setupCard"><h3 style="margin-top:0">Библиотека</h3>
          ${fld('Организация', 'org', { val: s.org, req: 1 })}
          ${fld('Наименование на библиотеката', 'lib_name', { val: s.lib_name })}
          ${fld('Населено място', 'place', { val: s.place })}
          <div class="grid g2">${fld('ЕИК / БУЛСТАТ', 'bulstat', { val: s.bulstat || '' })}${fld('Рег. № в Мин. на културата', 'reg_no', { val: s.reg_no || '' })}</div>
          <div class="grid g2">${fld('Ръководител', 'director', { val: s.director || '' })}${fld('Длъжност', 'director_role', { val: s.director_role || '' })}</div>
          ${fld('Библиотекар', 'librarian', { val: s.librarian || '' })}
          ${fld('Адрес на сайта', 'cat_url', { val: s.cat_url || '', hint: 'излиза върху читателските карти и в онлайн каталога' })}
          <!-- Бутонът тук записва ЦЯЛАТА форма с настройки (всички блокове
               [data-setup-form]), не само тази карта — едно и също действие,
               достъпно от всеки раздел. -->
          <div class="toolbar" style="margin-top:14px">
            <button type="button" class="btn pri" onclick="saveSetup()">Запиши настройките</button>
          </div>
        </div>
        <div>
          <div class="card setupCard"><h3 style="margin-top:0">Лого на организацията</h3>
            <div class="logoBox">
              ${s.logo ? `<img src="${esc(s.logo)}" alt="лого">` : '<div class="logoEmpty">няма<br>лого</div>'}
              <div>
                <div class="toolbar" style="margin:0">
                  <button type="button" class="btn" onclick="chooseLogo()">${s.logo ? 'Смени…' : 'Избери файл…'}</button>
                  ${s.logo ? '<button type="button" class="btn dgr" onclick="clearLogo()">Премахни</button>' : ''}
                </div>
                <div class="hint" style="margin-top:6px">PNG, JPG, GIF, WEBP или SVG, до 512 KB. Влиза в заглавната част
                на всички документи за печат и в читателските карти.</div>
              </div>
            </div>
          </div>
          <div class="card setupCard"><h3 style="margin-top:0">Постоянна комисия</h3>
            ${fld('Член 1 (библиотекар)', 'committee1', { val: s.committee1 || '' })}
            ${fld('Член 2', 'committee2', { val: s.committee2 || '' })}
            ${fld('Член 3 (счетоводител)', 'committee3', { val: s.committee3 || '' })}
            <div class="hint">Назначава се със заповед на ръководителя; библиотекар и счетоводител са задължителни (чл. 35, ал. 1).</div>
          </div>
        </div>
      </div>
    </form>
    ${setupCard('Служители', `
      ${setupHow('Списъкът е общ за всички компютри, свързани към тази база данни. Изборът „кой служител работи в момента“ (долу вляво в лентата) е локален за всеки компютър и записва избраното име в одитната следа при всяко действие.')}
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
        </tbody></table></div>` : '<div class="hint">Все още няма добавени служители — без тях одитната следа не знае кой е работил.</div>'}`)}
    </section>

    ${setupSectionOpen('obsluzhvane', 'Обслужване', 'Общите правила за заемане; отделна категория читатели може да има свои — по-долу.',
      `<span class="chip">срок ${dni(s.loan_days || 30)}</span><span class="chip">до ${s.max_books || '∞'} документа</span>`)}
    <div data-setup-form>
      <div class="card setupCard"><h3 style="margin-top:0">Обслужване</h3>
        <div class="grid g2">
          ${fld('Срок за заемане (дни)', 'loan_days', { val: s.loan_days, type: 'number', min: 1 })}
          ${fld('Максимум документи на читател', 'max_books', { val: s.max_books, type: 'number', min: 0, hint: '0 = без ограничение' })}
          ${fld('Брой продължения', 'extensions_count', { val: s.extensions_count, type: 'number', min: 0, hint: 'празно = 2 · 0 = без ограничение' })}
          ${fld('Дни на продължение', 'extension_days', { val: s.extension_days, type: 'number', min: 1 })}
          ${fld('Обезщетение за забава (лв./ден)', 'fine_per_day', { val: s.fine_per_day, type: 'number', step: '0.01', min: 0 })}
          ${fld('Годишна такса (лв.)', 'annual_fee', { val: s.annual_fee, type: 'number', step: '0.01', min: 0 })}
        </div>
        <div class="grid g2">
          ${fld('Наказание при забава (дни без заемане за всеки ден)', 'suspend_per_day',
            { val: s.suspend_per_day ?? 0, type: 'number', step: '0.5', min: 0, hint: '0 = изключено. По-приложимо от глоба в стотинки.' })}
          ${fld('Таван на наказанието (дни)', 'suspend_max', { val: s.suspend_max ?? 90, type: 'number', min: 0,
            hint: 'общо за читателя, не за всяко връщане. Празно или 0 = 90 дни по подразбиране.' })}
        </div>
        <div class="grid g2">
          ${fld('2-ро напомняне след (дни просрочие)', 'remind2_days', { val: s.remind2_days ?? 14, type: 'number', min: 0 })}
          ${fld('3-то напомняне след (дни просрочие)', 'remind3_days', { val: s.remind3_days ?? 30, type: 'number', min: 0 })}
        </div>
        ${setupSave()}
      </div>
    </div>
    ${setupCard('Правила по категория читатели', `
      ${setupHow('Празно поле = ползва се общата стойност отгоре. Не е нужно да попълвате всички полета за всяка категория — само тези, които реално се различават (напр. децата с по-кратък срок, специалистите — без наказание).')}
      <div id="circRulesBox">зареждане…</div>
      <div class="toolbar" style="margin-top:8px"><button class="btn" onclick="addCircRule()">+ Правило за категория…</button></div>`)}
    ${setupCard('Календар на библиотеката', `
      ${setupHow('Падеж, паднал се в затворен ден, се измества автоматично към следващия работен ден. Затворените дни не се броят в наказанието за забава.')}
      <div id="calWorkDays">зареждане…</div>
      <div class="toolbar" style="margin-top:10px"><button class="btn" onclick="saveWorkDays()">Запиши работните дни</button></div>
      <h4 class="setupH4">Затворени дни (официални празници, отпуск)</h4>
      <div class="toolbar">
        ${fld('Дата', 'calDate', { type: 'date', val: today() })}
        ${fld('Причина', 'calReason', { val: '', hint: 'по желание' })}
        <div class="field"><label>&nbsp;</label><button class="btn" onclick="addClosedDay()" style="width:100%">+ Добави</button></div>
      </div>
      <div id="calClosedBox">зареждане…</div>`)}
    ${setupMore('Шаблони за напомняния', 'писмо, SMS и тема — по подразбиране или свои', `
      ${setupHow('Текстовете за писмо, SMS и заглавие на напомнянията за просрочени материали (раздел „Просрочени“) се редактират тук. Плейсхолдър във фигурни скоби, напр. <code>{reader}</code>, се заменя автоматично при подготовката на всяко напомняне. Оставете поле празно, за да ползвате текста по подразбиране.')}
      <div class="hint" id="noticePh" style="margin:6px 0 10px;line-height:1.7">зареждане на плейсхолдъри…</div>
      <form id="noticesF" onsubmit="return false">
        ${fld('Тема на писмото', 'notice_subject', { val: s.notice_subject || '', hint: 'използва се само за имейл' })}
        ${fld('Текст на писмото', 'notice_body', { type: 'textarea', rows: 9, val: s.notice_body || '' })}
        ${fld('Кратък текст за SMS', 'notice_sms', { type: 'textarea', rows: 2, val: s.notice_sms || '' })}
      </form>
      <div class="toolbar">
        <button class="btn pri" onclick="saveNotices()">Запиши шаблоните</button>
        <button class="btn" onclick="resetNoticeTemplates()">Възстанови по подразбиране</button>
      </div>`)}
    </section>

    ${setupSectionOpen('fond', 'Фонд', 'Инвентарни номера, видове документи, контролирани списъци и проверка на данните.',
      `<span class="chip">следващ инв. № ${esc(String(s.next_inv_number ?? '—'))}</span>`)}
    <div data-setup-form>
      <div class="card setupCard"><h3 style="margin-top:0">Инвентарна книга</h3>
        <div class="grid g2">
          ${fld('Следващ инвентарен номер', 'next_inv_number', { val: s.next_inv_number, type: 'number', min: 1,
            hint: 'предлага се при всеки нов документ и се увеличава сам' })}
          ${fld('Фонд на свободен достъп (%)', 'free_access_pct', { val: s.free_access_pct, type: 'number', min: 0,
            hint: 'определя допустимите естествени загуби при инвентаризация (чл. 41)' })}
        </div>
        ${setupSave()}
      </div>
    </div>
    ${categoriesCardHtml(cats)}
    ${setupMore('Номенклатури', 'контролирани списъци за полетата с избор', `
      ${setupHow('Контролирани списъци за полетата с избор — така „худ. л-ра“ и „художествена литература“ не се разпиляват като различни стойности. Вторият (незадължителен) надпис на реда е <b>публичният</b> — той се показва в онлайн каталога вместо вътрешния (напр. вътрешно „краеведски“, публично „Краезнание“). Записва се по един ред за стойност: <code>стойност | публичен надпис</code>.')}
      <div id="avEditors">зареждане…</div>`)}
    ${setupCard('Проверка на данните', `
      ${setupHow('Търси несъответствия, които програмата не може да поправи сама: няколко екземпляра под един инвентарен номер, бройка 0, документ „отчислен“ без акт, един баркод на няколко документа. Нищо не се променя без ваше изрично действие, и нито едно от поправянията не променя броя документи или стойността на фонда.')}
      <div class="toolbar"><button class="btn" onclick="runDataChecks()">Провери сега</button></div>
      <div id="dataChecks"></div>`)}
    ${setupMore('Въвеждане на данни от друга система', 'CSV, TXT, TSV, XLSX — от АБ, iLib или Excel', `
      ${setupHow('Ако библиотеката е водила фонда в друга програма (<b>АБ</b>, <b>iLib</b>) или в таблица на Excel, записите се въвеждат оттам, вместо да се преписват на ръка. Четат се <b>CSV</b>, <b>TXT</b>, <b>TSV</b> и <b>XLSX</b>; кирилицата в стари файлове (Windows-1251) се разпознава сама. След избора се показва как са разпознати колоните и първите редове — съответствието се проверява и поправя, преди нещо да се запише. <b>Направете резервно копие преди голямо въвеждане.</b>')}
      <div class="toolbar"><button class="btn pri" onclick="importChoose()">Избери файл за въвеждане…</button></div>`)}
    <div data-setup-form>
      ${setupMore('SRU сървър за въвеждане на записи', esc(s.sru_endpoint || 'Library of Congress (по подразбиране)'), `
        ${fld('Адрес на SRU сървъра', 'sru_endpoint', { val: s.sru_endpoint || '',
          hint: 'по подразбиране: каталогът на Library of Congress (безплатен, без договор). Ако библиотеката получи достъп до SRU на НБКМ/COBISS, адресът се сменя тук.' })}
        ${setupSave()}`)}
    </div>
    </section>

    ${setupSectionOpen('lichni', 'Лични данни', 'ЗЗЛД / GDPR: защита на ЕГН и № ЛК, анонимизиране на стара история.',
      `<span class="chip" id="chipPdp">защита: …</span>`)}
    <!-- Картата стои ИЗВЪН [data-setup-form] по две причини: loadPdpBox() вкарва
         поле за парола, което не бива да пътува към settings:update; и вложена
         <form> в друга <form> се изхвърля от HTML парсера. -->
    ${setupCard('Защита на ЕГН / № лична карта', `
      ${setupHow('ЕГН и номер на лична карта на читателите могат да се пазят <b>криптирани</b> в самата база данни, с обща парола за всички компютри, които ползват тази база — важи и за споделена мрежова база. Останалите данни на читателя (име, адрес, телефон, история на заемания) не са засегнати и работят нормално без паролата. Паролата се въвежда веднъж на всеки компютър, докато програмата работи. <b>Ако паролата бъде забравена, ЕГН/№ ЛК стават невъзстановими</b> — както при криптирано резервно копие.')}
      <div id="pdpBox">зареждане…</div>`)}
    <div data-setup-form>
      <div class="card setupCard"><h3 style="margin-top:0">Анонимизиране (ЗЗЛД / GDPR)</h3>
        ${setupHow('Върнати заемания, по-стари от зададения срок, могат да се <b>анонимизират</b>: името на читателя изчезва от историята, а за статистиката остава само „категория · година“ (напр. „дете до 14 г. · 2024“). Обезличават се и записите в одитната следа и старите търсения. Действието е <b>необратимо</b> и се изпълнява само с бутона — никога автоматично. Съгласията на читателите се записват с дата (във формата на всеки читател).')}
        <div class="grid g2">
          ${fld('Анонимизиране на заемания, по-стари от (години)', 'anonymize_years',
            { val: s.anonymize_years ?? 0, type: 'number', min: 0, hint: '0 = изключено · запишете, преди да анонимизирате' })}
          <div class="field"><label>&nbsp;</label>
            <button type="button" class="btn" onclick="runAnonymize()" style="width:100%">Анонимизирай сега…</button></div>
        </div>
        <div class="hint" id="anonHint">зареждане…</div>
        ${setupSave()}
      </div>
    </div>
    </section>

    ${setupSectionOpen('danni', 'Копия и мрежа', 'Резервни копия, споделена база за няколко компютъра, ограничения.', backupChip)}
    ${setupCard('Резервно копие', `
      ${setupHow('Всяко действие (нов документ, заемане, връщане, отчисляване и т.н.) се записва автоматично в базата данни — няма нужда от бутон „Запази“ за самите данни. Освен това програмата прави <b>автоматично резервно копие веднъж на ден</b> (при първото стартиране за деня) в подпапка <code>backups</code> до базата данни, като пази последните 30 дни. Копията служат за възстановяване при срив на компютъра/програмата, или за пренасяне на данните на друг компютър със същата програма.')}
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
        </tbody></table></div>` : '<div class="hint">Все още няма направени резервни копия.</div>'}`)}
    ${setupMore('Работа в мрежа (няколко компютъра)', esc(dbLoc && !dbLoc.isDefault ? (dbLoc.folder || 'персонализирана папка') : 'локална папка по подразбиране'), `
      ${setupHow('За да работят няколко работни компютъра с една и съща база данни, посочете папка на <b>споделен мрежов диск</b> (напр. картографиран диск <code>Z:\\</code> или път от вида <code>\\\\СЪРВЪР\\споделена-папка</code>) — всички програми, сочещи към тази папка, ще виждат едни и същи данни.<br><br><b>Важно за надеждността:</b> SQLite (форматът на базата данни) официално <b>не е препоръчан</b> за едновременен запис от няколко компютъра върху мрежов диск (SMB) — заключването на файлове по мрежата не винаги работи коректно и в редки случаи може да доведе до повредена база. Препоръки: работете един по един, когато е възможно; правете редовно резервно копие на файла <code>library.db</code>; ако забележите грешки „database is locked“ или повредени данни — върнете последното добро резервно копие.')}
      <div class="hint">Текуща папка: <b style="font-family:var(--mono)">${esc(dbLoc ? dbLoc.folder : '')}</b>
      ${dbLoc && dbLoc.isDefault ? ' (по подразбиране, локална)' : ' (персонализирана)'}</div>
      <div class="toolbar">
        <button class="btn pri" onclick="chooseDbLocation()">Избери мрежова/друга папка…</button>
        ${dbLoc && !dbLoc.isDefault ? '<button class="btn" onclick="resetDbLocation()">Върни към локалната по подразбиране</button>' : ''}
      </div>`)}
    ${setupMore('Ограничения на записите', limits && (limits.limitBooks > 0 || limits.limitReaders > 0)
        ? `документи: ${limits.limitBooks || '∞'} · читатели: ${limits.limitReaders || '∞'}` : 'без ограничение', `
      ${setupHow('Горна граница за броя записи в програмата. <b>0 означава без ограничение.</b> Проверява се само при добавяне на нов запис — вече въведените данни остават достъпни и редактируеми дори ако лимитът бъде намален по-късно.')}
      <form id="limF" onsubmit="return false"><div class="grid g2">
        ${fld('Лимит на документите във фонда', 'limit_books', { val: limits ? limits.limitBooks : 0, type: 'number', min: 0,
          hint: limits ? 'в момента: ' + limits.books.toLocaleString('bg-BG') : '' })}
        ${fld('Лимит на читателите', 'limit_readers', { val: limits ? limits.limitReaders : 0, type: 'number', min: 0,
          hint: limits ? 'в момента: ' + limits.readers.toLocaleString('bg-BG') : '' })}
      </div></form>
      ${limits && (limits.limitBooks > 0 || limits.limitReaders > 0) ? `
        <div style="margin-top:6px">
          ${limits.limitBooks > 0 ? limitBarHtml('Документи', limits.books, limits.limitBooks) : ''}
          ${limits.limitReaders > 0 ? limitBarHtml('Читатели', limits.readers, limits.limitReaders) : ''}
        </div>` : ''}
      <div class="toolbar"><button class="btn pri" onclick="saveLimits()">Запиши ограниченията</button></div>`)}
    ${setupMore('Антивирусна защита', 'изключения за Windows Defender — веднъж, при инсталиране', `
      ${setupHow('Докато инсталаторът е без закупен цифров подпис, Windows Defender и други антивирусни може да спират инсталирането или да заключват файловете на програмата — базата данни, резервните копия, папката на каталога. Това е <b>фалшива тревога</b> заради липсващия подпис, не признак за зловреден код. Скриптът добавя папките на програмата в изключенията на Windows Defender и я разрешава през „Защита от рансъмуер“. Записва се като файл, който се изпълнява <b>веднъж, като администратор</b> (десен бутон → „Изпълни като администратор“).')}
      <div class="toolbar">
        <button class="btn pri" onclick="avScript()">Скрипт за Defender…</button>
        <button class="btn" onclick="avCopyDirs()">Копирай папките (за AVG и др.)</button>
        <button class="btn" onclick="avHelp()">Какво да направя?</button>
      </div>`)}
    </section>

    ${setupSectionOpen('programa', 'Програма', 'Външен вид, обновяване и връзка с разработчика.',
      `<span class="chip">v${esc(String((APP_CREDIT_TEXT.match(/v([\d.]+)/) || [])[1] || ''))}</span>`)}
    ${setupCard('Външен вид', `
      <div class="hint" style="margin-top:0;margin-bottom:10px">Избраната тема се прилага веднага на всички компютри, които ползват тази база данни.</div>
      <div class="themeRow">
        ${THEMES.map(t => `<button type="button" class="themeSw${s.theme === t.id ? ' on' : ''}" onclick="setTheme('${t.id}')" title="${esc(t.name)}">
          <span class="themeSwSpine" style="background:${t.spine}"></span>
          <span class="themeSwBrass" style="background:${t.brass}"></span>
          <span class="themeSwName" style="background:${t.paper}">${esc(t.name)}${s.theme === t.id ? ' ✓' : ''}</span>
        </button>`).join('')}
      </div>
      <label class="chk" style="margin-top:12px"><input type="checkbox" ${s.scan_sound == null || +s.scan_sound ? 'checked' : ''}
        onchange="setScanSound(this.checked)"><span>Звуков сигнал при сканиране в „Заемане и връщане“ —
        кратък висок тон при успех, двоен нисък при отказ/забава/заделена книга.</span></label>`)}
    ${setupCard('Обновяване', updateStatusHtml())}
    ${setupCard('Помощ и обратна връзка', `
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
      </div>`)}
    <div class="hint" style="margin-top:20px;font-family:var(--mono);font-size:10.5px">${esc(APP_CREDIT_TEXT)}</div>
    </section>

    </div></div>`;
  if (openMore.size) document.querySelectorAll('#view .setupMore').forEach(d => {
    const t = d.querySelector('.setupMoreTitle'); if (t && openMore.has(t.textContent)) d.open = true;
  });
  setupInitNav();
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
  const plainDaily = Number(st.plainDailyCount) || 0;
  const plainRestore = Number(st.plainRestoreCount) || 0;
  const plainNote = plainDaily > 0
    ? ` В папката с резервните копия в момента има <b>${plainDaily}</b>
        ${plainDaily === 1 ? 'некриптирано дневно копие' : 'некриптирани дневни копия'}
        (всяко е пълен списък с личните данни на читателите).`
    : '';
  /* Предпазните копия отпреди възстановяване се броят ОТДЕЛНО и НЕ се предлагат за
     изтриване: те не са дневни копия и са единственият изход от сгрешено
     възстановяване. Одит v2.4.24, преглед на поправките от същия кръг. */
  const restoreNote = plainRestore > 0
    ? `<div class="hint" style="margin-top:6px">В папката има и <b>${plainRestore}</b>
        ${plainRestore === 1 ? 'предпазно копие' : 'предпазни копия'} отпреди възстановяване
        (<code>before-restore-…</code>) в чист текст. <b>Не ги изтривайте</b> — те са изходът,
        ако възстановяване се окаже сгрешено. Ако личните данни в тях са проблем, преместете ги
        на място, което не е споделено в мрежата.</div>`
    : '';
  if (state === 'encrypted') {
    /* Одит v2.4.24: тук се показваше САМО зеленото „копията се криптират“. Но
       включването на защитата криптира само днешното копие — вчерашните остават в
       чист текст завинаги, тоест точно в мига, в който библиотекарят вижда
       успокоителния надпис, на дяла стоят до 30 пълни регистъра с лични данни. */
    el.innerHTML = `<div class="note${plainNote ? ' d' : ''}" style="margin-top:0">🔒 Автоматичните дневни копия се
      <b>криптират</b> с паролата за защита на личните данни.
      ${st.last ? 'Последно копие: ' + esc(st.last.date) + '.' : ''}${plainNote}
      ${plainNote ? `<div class="hint" style="margin-top:6px">Криптирането важи за копията отсега нататък.
        Старите некриптирани <b>дневни</b> копия могат да се изтрият от папката с копията — базата и днешното
        копие остават.</div>` : ''}${restoreNote}</div>`;
    return;
  }
  if (state === 'failed') {
    /* Най-опасният случай: библиотекарят е направил всичко както трябва, а
       копието въпреки това е в чист текст. Затова се казва изрично КАКВО се е
       провалило и се дава пряк изход — ръчно криптирано копие сега. */
    el.innerHTML = `<div class="note d" style="margin-top:0">
      <b>⚠ Днешното копие НЕ е криптирано, въпреки че защитата е включена.</b>
      ${esc(st.warning || '')}${plainNote}${restoreNote}
      <div class="toolbar" style="margin:8px 0 0">
        <button type="button" class="btn pri" onclick="backupNowForm()">Направи копие с парола сега…</button>
        <button type="button" class="btn" onclick="pdpFocus()">Към защитата на личните данни</button>
      </div>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="note ${state === 'locked' ? 'w' : 'd'}" style="margin-top:0">
    <b>${state === 'locked' ? '⚠ Копията не се криптират в момента.' : '⚠ Копията НЕ са криптирани.'}</b>
    ${esc(st.warning || '')}${plainNote}${restoreNote}
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
  toast('Списъкът е записан (' + pl(n, 'стойност', 'стойности') + '). Менютата го ползват веднага.', 'ok');
  markSaved();
}
window.saveAv = saveAv;
/* ---------------- Лични данни ---------------- */
async function loadAnonHint() {
  const el = $('#anonHint'); if (!el) return;
  const r = await call(window.api.gdpr.candidates());
  if (!r) { el.textContent = ''; return; }
  /* Анонимизирането прави ТРИ неща (handlers/gdpr.js): заемания, одитна следа,
     история на търсенията. Одит v2.4.24: и подсказката, и бутонът се водеха само
     по заеманията, тоест библиотека без стари заемания, но с хиляди имена в следата
     и в търсенията, четеше „нищо за анонимизиране“ и нямаше как да ги изчисти. */
  const parts = [
    r.count ? `${r.count} ${r.count === 1 ? 'върнато заемане' : 'върнати заемания'}` : '',
    r.auditCount ? `${r.auditCount} ${r.auditCount === 1 ? 'запис' : 'записа'} в одитната следа` : '',
    r.searchCount ? `${r.searchCount} ${r.searchCount === 1 ? 'старо търсене' : 'стари търсения'}` : '',
    r.otherCount ? `${r.otherCount} ${r.otherCount === 1 ? 'запис' : 'записа'} в резервации, предложения, МЗС, напомняния и посещения` : ''
  ].filter(Boolean);
  el.textContent = !r.years
    ? 'Анонимизирането е изключено (0 години).'
    : (parts.length
        ? `Готови за анонимизиране отпреди ${bg(r.cutoff)}: ${parts.join(', ')}.`
        : `Няма нищо отпреди ${bg(r.cutoff)} за анонимизиране.`);
}
async function runAnonymize() {
  const r = await call(window.api.gdpr.candidates());
  if (!r) return;
  if (!r.years) return toast('Първо задайте срок в години (и запишете настройките).', 'err');
  const total = (r.count || 0) + (r.auditCount || 0) + (r.searchCount || 0) + (r.otherCount || 0);
  if (!total) return toast('Няма нищо за анонимизиране.', 'ok');
  const c = r.count || 0, a = r.auditCount || 0, q = r.searchCount || 0, o = r.otherCount || 0;
  if (!await askConfirm(`НЕОБРАТИМО, отпреди ${bg(r.cutoff)}: ${c === 1 ? '1 върнато заемане губи' : c + ' върнати заемания губят'} връзката с имената ` +
    `(остава само „категория · година“), ${a === 1 ? '1 запис в одитната следа се обезличава' : a + ' записа в одитната следа се обезличават'} и ` +
    `${q === 1 ? '1 старо търсене се изтрива' : q + ' стари търсения се изтриват'}` +
    (o ? ` и ${o === 1 ? '1 запис' : o + ' записа'} в резервации, предложения, МЗС, напомняния и посещения по домовете ${o === 1 ? 'губи' : 'губят'} името` : '') +
    `. Да продължа?`, { kind: 'danger', title: 'Анонимизиране на лични данни', okLabel: 'Анонимизирай' })) return;
  const res = await call(window.api.gdpr.anonymize());
  if (!res) return;
  toast((res.anonymized === 1 ? 'Анонимизирано 1 заемане' : 'Анонимизирани ' + res.anonymized + ' заемания')
    + ', ' + (res.auditCleared === 1 ? 'обезличен 1 запис' : 'обезличени ' + res.auditCleared + ' записа') + ' в следата'
    + (res.otherCleared ? ', ' + (res.otherCleared === 1 ? '1 друг запис' : res.otherCleared + ' други записа') : '') + '.', 'ok');
  markSaved();
  loadAnonHint();
}
window.runAnonymize = runAnonymize;
/* ---------------- Защита на ЕГН/№ ЛК (обща парола) ---------------- */
async function loadPdpBox() {
  const el = $('#pdpBox'); if (!el) return;
  const s = await call(window.api.pdp.status());
  if (!s) { el.textContent = ''; return; }
  const chip = $('#chipPdp');
  if (chip) {
    chip.textContent = !s.configured ? 'защита: не е зададена' : s.unlocked ? 'защита: отключена' : 'защита: заключена';
    chip.className = 'chip' + (!s.configured ? ' w' : s.unlocked ? ' ok' : '');
  }
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
  if (!d.password || d.password.length < 10) return toast('Паролата трябва да е поне 10 знака.', 'err');
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
  /* Стара парола (кратка или изведена с предишните, по-евтини параметри) —
     подсказка да бъде сменена. Показва се СЛЕД „Отключено“ и с отделен toast,
     за да не изглежда като грешка: самото отключване е успешно. */
  if (res.data && res.data.advise) setTimeout(() => toast(res.data.advise), 1200);
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
  if (!d.newPassword || d.newPassword.length < 10) return toast('Новата парола трябва да е поне 10 знака.', 'err');
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
  ['loan_days', 'Срок (дни)', 'празно или 0 = общото'],
  ['max_books', 'Максимум документи', 'празно = общото · 0 = без ограничение'],
  ['extensions_count', 'Продължения', 'празно = общото · 0 = без ограничение'],
  ['extension_days', 'Дни на продължение', 'празно или 0 = общото'],
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
  if (!await askConfirm('Изтриване на правилото за „' + category + '“? Категорията ще започне да ползва общите стойности.')) return;
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
  // Празният списък се отказва от обработчика с обяснение — дотук тук стоеше
  // предупреждение, което обещаваше обратното на това, което програмата правеше.
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
  if (!await askConfirm('Изтриване на служителя? Записите в одитната следа с неговото име остават непроменени.')) return;
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
/* Втори преглед на кръга v2.4.24: предпазното копие вече се КРИПТИРА (иначе беше
   пълна база в чист текст, трайно, в папката с копията — а тя по документиран
   сценарий е споделена в мрежата). Паролата обаче е тази на базата, която се
   ЗАМЕНЯ: ако възстановявате база с друга парола или без такава, след рестарта
   програмата вече не знае с какво е заключено предпазното копие. Затова се казва
   изрично тук, ПРЕДИ потвърждението — същото предупреждение, което ръчното
   резервно копие носи отдавна. */
const RESTORE_WARN = 'Възстановяването ще замени текущите данни в програмата и ще я рестартира. ' +
  'Текущата база се пази автоматично като допълнително копие преди възстановяването (файл ' +
  '„before-restore-…“ в папката с копията). Ако защитата на личните данни е включена и отключена, ' +
  'това копие се криптира с ТЕКУЩАТА ѝ парола — запишете си я, ако базата, която възстановявате, ' +
  'е с друга парола или без парола. Продължавате ли?';
const RESTORE_OPTS = { kind: 'danger', title: 'Възстановяване от резервно копие', okLabel: 'Възстанови' };
async function restoreBackupFromList(path) {
  if (!await askConfirm(RESTORE_WARN, RESTORE_OPTS)) return;
  const res = await window.api.backup.restoreFromList({ path });
  if (!res.ok) return toast(res.error, 'err');
  if (res.data && res.data.needsPassword) askBackupPassword(res.data.path, true);
}
window.restoreBackupFromList = restoreBackupFromList;
async function restoreBackupBrowse() {
  if (!await askConfirm('Ще изберете файл с резервно копие (.db или .invbak) от компютъра/USB/мрежов диск. ' + RESTORE_WARN, RESTORE_OPTS)) return;
  const res = await window.api.backup.restoreBrowse();
  if (!res.ok) return toast(res.error, 'err');
  if (res.data && res.data.needsPassword) askBackupPassword(res.data.path, false);
}
window.restoreBackupBrowse = restoreBackupBrowse;
async function chooseDbLocation() {
  if (!await askConfirm('Програмата ще копира текущата база данни в новата папка и ще се рестартира. Продължавате ли?', { kind: 'warn', title: 'Място на базата данни', okLabel: 'Продължи' })) return;
  const res = await window.api.dbLocation.choose();
  if (!res.ok) return toast(res.error, 'err');
}
window.chooseDbLocation = chooseDbLocation;
async function resetDbLocation() {
  if (!await askConfirm('Връщане към локалната база данни по подразбиране (тази на мрежовия диск остава непроменена)? Програмата ще се рестартира.', { kind: 'warn', title: 'Място на базата данни', okLabel: 'Върни локалната база' })) return;
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
/* Всички полета на settings:update, събрани от всички блокове [data-setup-form]
   (v2.4.27): обработчикът изисква ВСИЧКИ именувани параметри наведнъж, а
   полетата вече стоят в различни раздели, всеки със свой бутон „Запиши“. */
function setupFormData() {
  const out = {};
  document.querySelectorAll('#view [data-setup-form]').forEach(block => {
    block.querySelectorAll('input,select,textarea').forEach(el => {
      if (!el.name) return;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
  });
  return out;
}
async function saveSetup() {
  const d = setupFormData(); d.id = 1;
  if (!String(d.org || '').trim() && !String(d.lib_name || '').trim()) {
    return toast('Въведете организацията или наименованието на библиотеката — те излизат върху всеки документ.', 'err');
  }
  /* Позицията на превъртане се пази (v2.4.27): страницата се пречертава след
     запис, а библиотекарят е в раздел по средата ѝ. */
  const main = $('#main'); const y = main ? main.scrollTop : 0;
  if (await call(window.api.settings.update(d), 'Настройките са записани.') === null) return;
  await loadSettingsCache();
  // Пречертава текущия изглед, за да влязат новите данни веднага навсякъде, където
  // се показват — без да се излиза и влиза наново в раздела.
  if (RENDERERS[VIEW]) await RENDERERS[VIEW]();
  if (main && VIEW === 'setup') main.scrollTop = y;
}
window.saveSetup = saveSetup;

/* ---------------- Навигация вътре в Настройки (v2.4.27) ---------------- */
function setupGo(id) {
  const el = document.getElementById('setup-' + id);
  if (!el) return;
  // replaceState не задейства hashchange (иначе route() би пречертал всичко).
  if (location.hash !== '#setup/' + id) { try { history.replaceState(null, '', '#setup/' + id); } catch (e) { /* jsdom */ } }
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  setupMarkActive(id);
}
window.setupGo = setupGo;
let SETUP_ACTIVE = '';
function setupMarkActive(id) {
  SETUP_ACTIVE = id;
  document.querySelectorAll('.setupNav a[data-sec]').forEach(a => a.classList.toggle('on', a.dataset.sec === id));
}
let SETUP_OBSERVER = null;
function setupInitNav() {
  if (SETUP_OBSERVER) { SETUP_OBSERVER.disconnect(); SETUP_OBSERVER = null; }
  const secs = [...document.querySelectorAll('.setupSec')];
  if (!secs.length) return;
  // Активният раздел следва превъртането (IntersectionObserver липсва в jsdom).
  if (typeof IntersectionObserver === 'function') {
    const main = $('#main');
    SETUP_OBSERVER = new IntersectionObserver((entries) => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible.length) setupMarkActive(visible[0].target.id.replace(/^setup-/, ''));
    }, { root: main || null, threshold: [0, 0.25, 0.5, 1], rootMargin: '0px 0px -65% 0px' });
    secs.forEach(sec => SETUP_OBSERVER.observe(sec));
  }
  // Без адрес: разделът, в който библиотекарят беше преди пречертаването (запис,
  // смяна на тема), иначе първият.
  const known = (id) => !!(id && document.getElementById('setup-' + id));
  const sub = known(ROUTE_SUB) ? ROUTE_SUB : known(SETUP_ACTIVE) ? SETUP_ACTIVE : secs[0].id.replace(/^setup-/, '');
  setupMarkActive(sub);
  if (ROUTE_SUB && sub === ROUTE_SUB) {
    // Веднъж — само при идване по адрес. Иначе всяко пречертаване (запис, смяна на
    // тема, събитие от обновяването) връщаше страницата на посочения раздел.
    ROUTE_SUB = '';
    setTimeout(() => setupGo(sub), 0);
  }
}
/* Търсене в настройките: скрива картите, чийто текст не съдържа търсеното,
   отваря свитите, в които има съвпадение, и крие празните раздели. */
function setupFilter(q) {
  q = String(q || '').trim().toLowerCase();
  let shown = 0, total = 0;
  document.querySelectorAll('.setupSec').forEach(sec => {
    let secShown = 0;
    sec.querySelectorAll('.setupCard, .setupMore').forEach(card => {
      total++;
      const hit = !q || card.textContent.toLowerCase().includes(q);
      card.hidden = !hit;
      if (hit) { secShown++; shown++; }
      if (q && hit && card.tagName === 'DETAILS') card.open = true;
    });
    const head = sec.querySelector('.setupHead');
    if (head) head.hidden = !!q && !secShown;
  });
  const hint = $('#setupSearchHint');
  if (hint) hint.textContent = q ? (shown ? pl(shown, 'съвпадение', 'съвпадения') + ' от ' + total : 'няма съвпадение — опитайте друга дума') : '';
}
window.setupFilter = setupFilter;
async function loadNoticePlaceholders() {
  const d = await call(window.api.settings.noticeDefaults());
  const el = $('#noticePh');
  if (!el) return;
  if (!d) { el.textContent = ''; return; }
  el.innerHTML = 'Налични: ' + (d.placeholders || []).map(([k, t]) => `<code>{${k}}</code> — ${esc(t)}`).join(' &nbsp;·&nbsp; ');
}
async function saveNotices() {
  const d = formData('#noticesF');
  await call(window.api.settings.updateNotices(d), 'Шаблоните са записани.');
  await loadSettingsCache();
}
window.saveNotices = saveNotices;
async function resetNoticeTemplates() {
  if (!await askConfirm('Връщане на трите шаблона към текста по подразбиране?', { okLabel: 'Върни по подразбиране' })) return;
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

/* ---------------- Проверка на данните (v2.4.21) ----------------
   Двете проверки са за несъответствия, които базата не може да улови сама, и
   поправките са ЗАПИСНИ по същество, не числови: разделянето на екземпляри
   превръща 1 ред × N бройки в N реда × 1 бройка (същият брой документи, същата
   стойност), нулевата бройка се връща на 1 (документът е в инвентарната книга и
   трябва да влиза в сборовете), а дубликатът на баркод се решава на ръка. */
async function runDataChecks() {
  const box = $('#dataChecks');
  if (!box) return;
  box.innerHTML = '<div class="hint">Проверявам…</div>';
  const [multi, dups, orphanDeacc] = await Promise.all([
    call(window.api.books.multiCopyRecords()),
    call(window.api.books.findDuplicateBarcodes()),
    call(window.api.books.deaccessionedWithoutAct())
  ]);
  if (multi === null || dups === null || orphanDeacc === null) { box.innerHTML = ''; return; }
  const many = multi.filter(r => Number(r.quantity) > 1);
  const zero = multi.filter(r => Number(r.quantity) === 0);
  const copies = many.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  const nameOf = (r) => esc([r.author, r.title].filter(Boolean).join('. '));
  box.innerHTML = `
    <h4 style="font-size:14px;margin:16px 0 6px">Записи с повече от един екземпляр под един инвентарен номер</h4>
    ${many.length ? `
      <div class="note d" style="margin-top:0">Един инвентарен номер отговаря на <b>един</b> екземпляр.
      ${many.length === 1 ? 'Един запис носи' : many.length + ' записа носят'} общо <b>${copies}</b> екземпляра —
      най-вероятно от внесена стара база. Разделянето създава по един запис на екземпляр със следващите свободни
      инвентарни номера; <b>броят документи и стойността на фонда остават същите</b>.</div>
      <div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор и заглавие</th>
        <th>Бройки</th><th>Заети</th><th></th></tr></thead><tbody>
      ${many.map(r => `<tr><td class="num">${r.inv_number ?? '—'}</td><td>${nameOf(r)}</td>
        <td class="num">${r.quantity}</td><td class="num">${r.open_loans || 0}</td>
        <td><button class="btn sm" onclick="splitBookCopies(${r.id})">Раздели на ${r.quantity} записа</button></td></tr>`).join('')}
      </tbody></table></div>`
      : '<div class="hint">Няма такива записи — навсякъде един инвентарен номер отговаря на един екземпляр.</div>'}

    ${zero.length ? `
      <h4 style="font-size:14px;margin:20px 0 6px">Записи с бройка 0</h4>
      <div class="note d" style="margin-top:0">Документът е вписан в инвентарната книга, но с бройка 0 не влиза в нито един
      сбор на фонда (КДБФ, инвентарна книга, табло) и не може да се заема. Ако документът е във фонда, бройката трябва да е 1;
      ако не е — той се отчислява с акт, не с нула.</div>
      <div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор и заглавие</th><th>Състояние</th><th></th></tr></thead><tbody>
      ${zero.map(r => `<tr><td class="num">${r.inv_number ?? '—'}</td><td>${nameOf(r)}</td><td>${esc(r.status || '')}</td>
        <td><button class="btn sm" onclick="setBookLendable(${r.id})">Върни бройката на 1</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}

    ${orphanDeacc.length ? `
      <h4 style="font-size:14px;margin:20px 0 6px">Документи „отчислен“ без акт за отчисляване</h4>
      <div class="note d" style="margin-top:0">Документ напуска фонда само с <b>акт за отчисляване</b> (чл. 35, ал. 2),
      и КДБФ, годишният отчет и „Движение на фонда“ броят отписаното по акта.
      ${orphanDeacc.length === 1 ? 'Този документ е' : 'Тези ' + orphanDeacc.length + ' документа са'} в състояние
      „отчислен“ без акт — най-вероятно от внос на стара таблица с колона „Състояние“. Затова таблото и инвентарната
      книга ${orphanDeacc.length === 1 ? 'не го броят' : 'не ги броят'} във фонда, а справките
      ${orphanDeacc.length === 1 ? 'го броят' : 'ги броят'}: едно и също число излиза различно на два екрана.
      Ако документите наистина са отчислени, съставете акт от „Отчисляване“ — сканирайте ги там както всеки друг
      документ; ако не са — върнете ги във фонда.</div>
      <div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор и заглавие</th><th>От дата</th><th></th></tr></thead><tbody>
      ${orphanDeacc.map(r => `<tr><td class="num">${r.inv_number ?? '—'}</td><td>${nameOf(r)}</td>
        <td>${r.status_date ? bg(r.status_date) : '—'}</td>
        <td><button class="btn sm" onclick="clearOrphanDeaccession(${r.id})">Върни във фонда</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}

    <h4 style="font-size:14px;margin:20px 0 6px">Един и същ баркод на повече от един документ</h4>
    ${dups.length ? `
      <div class="note d" style="margin-top:0">Сканирането намира <b>първия</b> от тях — може да завери или отчисли
      грешния физически екземпляр. Отворете документите и оставете баркода само на един (или дайте нови етикети).</div>
      ${dups.map(g => `<div style="margin-bottom:10px"><b>Баркод ${esc(g.barcode)}</b>
        <div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Автор и заглавие</th><th>Състояние</th><th></th></tr></thead><tbody>
        ${g.books.map(b => `<tr><td class="num">${b.inv_number ?? '—'}</td><td>${nameOf(b)}</td><td>${esc(b.status || '')}</td>
          <td><button class="btn sm" onclick="bookForm(${b.id})">Отвори</button></td></tr>`).join('')}
        </tbody></table></div></div>`).join('')}`
      : '<div class="hint">Няма повтарящи се баркодове.</div>'}`;
}
window.runDataChecks = runDataChecks;
async function clearOrphanDeaccession(id) {
  if (!await askConfirm('ВРЪЩАНЕ ВЪВ ФОНДА\n\n'
    + 'Документът е отбелязан „отчислен“, но за него няма акт за отчисляване. Състоянието му ще стане '
    + '„наличен“ и той ще влиза еднакво във всички сборове на фонда.\n\n'
    + 'Ако документът наистина е отчислен, откажете и съставете акт от „Отчисляване“ — така отписването '
    + 'ще личи и в КДБФ, и в годишния отчет.', { okLabel: 'Върни във фонда' })) return;
  const res = await call(window.api.books.clearOrphanDeaccession(id), 'Документът е върнат във фонда.');
  if (res === null) return;
  runDataChecks();
}
window.clearOrphanDeaccession = clearOrphanDeaccession;
async function splitBookCopies(id) {
  if (!await askConfirm('РАЗДЕЛЯНЕ НА ЕКЗЕМПЛЯРИ\n\n'
    + 'Записът ще бъде разделен на отделни записи — по един за всеки екземпляр, всеки със свой '
    + 'инвентарен номер, както изисква инвентарната книга.\n\n'
    + 'Броят документи и стойността на фонда НЕ се променят. Новите записи получават празен баркод '
    + '(етикетът се лепи на конкретния екземпляр).\n\nДа продължа ли?', { okLabel: 'Раздели' })) return;
  const res = await call(window.api.books.splitCopies(id));
  if (res === null) return;
  markSaved();
  toast('Инв. № ' + (res.inv_number ?? '—') + ': добавени са нови инвентарни номера '
    + res.created.join(', ') + '.', 'ok');
  runDataChecks();
}
window.splitBookCopies = splitBookCopies;
async function setBookLendable(id) {
  const ok = await call(window.api.books.setLendable(id), 'Бройката е върната на 1.');
  if (ok === null) return;
  markSaved();
  runDataChecks();
}
window.setBookLendable = setBookLendable;
