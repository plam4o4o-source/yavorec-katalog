// Онлайн каталог + Витрини в каталога — обединени в един файл, защото
// функциите на витрините (bulkAddToShelf/applyBulkShelf и др.) викат
// renderCatalog() и обратно; физически бяха съседни секции и в app.js.

/* ---------------- Онлайн каталог ---------------- */
async function renderCatalog() {
  const [status, s, rc, ap] = await Promise.all([
    call(window.api.catalog.status()), call(window.api.settings.get()), call(window.api.catalog.remoteCheck()),
    call(window.api.catalog.autoPushStatus())
  ]);
  if (!status) return;
  const notSetUp = !status.ghUser || !status.ghRepo;
  /* Автоматичното публикуване се проваля тихо (изтекъл токен, разместено
     хранилище, липсваща мрежа) — дотук грешката отиваше само в конзолата, която
     никой не отваря, а екранът продължаваше да обещава обновяване на всеки
     5 минути. Ако последният опит е бил неуспешен, това се казва тук. */
  const autoPushWarn = ap && ap.error ? `<div class="note" style="border-left-color:var(--red)">
      <b>Автоматичното публикуване не е успяло.</b> Последен опит:
      ${esc(String(ap.at || '').slice(0, 16).replace('T', ' '))} ч. — ${esc(ap.error)}<br>
      Каталогът на сайта <b>остава със старото съдържание</b>, докато това не се оправи.
      Натиснете „Публикувай сега“ по-долу, за да видите пълното съобщение.</div>` : '';
  $('#view').innerHTML = `
    ${autoPushWarn}
    <div class="note"><b>Публичен каталог.</b> Извеждат се само библиографски данни и наличност.
    Лични данни на читатели, цени и служебни бележки <b>не</b> се включват никъде в изведения файл. Каталогът се
    публикува през <b>GitHub</b> — ${s && s.cat_url ? `сайтът <b>${esc(s.cat_url)}</b> чете` : 'сайтът на библиотеката чете'}
    файла на живо от там, без нужда от друг сървър.</div>

    ${rc && rc.mismatch ? `<div class="note" style="border-left-color:var(--red)">
      <b style="color:var(--red)">Внимание — папката сочи към чуждо хранилище.</b><br>
      Свързаната папка е работно копие на <b>${esc(rc.remote.user)}/${esc(rc.remote.repo)}</b>, а в настройките
      по-долу е записано <b>${esc(status.ghUser || '—')}/${esc(status.ghRepo || '—')}</b>. Публикуването е спряно,
      за да не се презапише каталогът на друга библиотека. Клонирайте своето хранилище и изберете неговата папка.
    </div>` : ''}

    ${notSetUp ? `<div class="card" style="border-left:3px solid var(--brass)">
      <h3 style="margin-top:0">Собствен каталог на ${esc(status.libName || 'библиотеката')}</h3>
      <div class="note" style="margin-top:0">Всяка библиотека публикува своя каталог в <b>собствено</b> хранилище
      в GitHub. Направете го веднъж:</div>
      <ol class="steps">
        <li>Създайте безплатен профил в <b>github.com</b>, ако нямате.</li>
        <li>Създайте ново <b>публично</b> хранилище. Предложено име:
            <code>${esc(status.suggestedRepo)}</code> — може и друго, само с латински букви и тирета.</li>
        <li>На този компютър клонирайте хранилището:<br>
            <code>git clone https://github.com/ПОТРЕБИТЕЛ/${esc(status.suggestedRepo)}.git</code></li>
        <li>Попълнете потребителя и хранилището в полетата по-долу и запишете.</li>
        <li>Изберете клонираната папка в „Работна папка“ — оттам нататък всичко е автоматично.</li>
      </ol>
      <div class="hint">Каталогът на всяка библиотека е отделен. Програмата никога не публикува в чуждо
      хранилище — ако папката сочи другаде, публикуването се спира.</div>
    </div>` : ''}

    <div class="card"><h3 style="margin-top:0">Работна папка (git clone на хранилището)</h3>
      ${status.folder ? `
        <div class="note">Свързана папка: <b style="font-family:var(--mono)">${esc(status.folder)}</b> —
        <code>katalog.json</code> се записва там автоматично при всяка промяна във фонда (нова книга, редакция,
        заемане, връщане, отчисляване).
        ${status.isGitRepo
          ? '<br><b>Разпозната като git хранилище</b> — публикуването в GitHub става автоматично на всеки 5 минути (ако има промяна), или веднага с бутона по-долу.'
          : '<br><span style="color:var(--red)">Внимание: тази папка не е git хранилище (липсва .git) — направете <code>git clone</code> на хранилището веднъж и изберете тази папка отново.</span>'}
        </div>
        <div class="toolbar">
          <button class="btn pri" onclick="catalogGitPublishNow()">Публикувай в GitHub сега</button>
          <button class="btn" onclick="catalogWriteNow()">Генерирай katalog.json (без push)</button>
          <button class="btn dgr" onclick="catalogDisconnect()">Спри автоматичния запис</button>
        </div>`
      : `
        <div class="note">Едно и само веднъж — на този компютър направете <code>git clone</code> на хранилището
        (<code>git clone https://github.com/${esc(status.ghUser || 'ПОТРЕБИТЕЛ')}/${esc(status.ghRepo || 'ХРАНИЛИЩЕ')}.git</code>
        — попълнете полетата по-долу, за да се сглоби точната команда),
        после изберете тук получената папка. Програмата ще записва <code>katalog.json</code> там автоматично при
        всяка промяна във фонда, и ще го публикува в GitHub сама (git add/commit/push) — не е нужен друг скрипт или
        планирана задача.</div>
        <button class="btn pri" onclick="catalogChooseFolder()">Избери папката на хранилището…</button>`}
      <div class="hint" style="margin-top:10px">Записи, които ще излязат в каталога: <b>${status.total}</b> ·
      от тях налични: <b>${status.available}</b></div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Хранилище в GitHub</h3>
      <div class="note" style="margin-top:0">Адресът, който сайтът ползва, се сглобява сам от потребителя,
      хранилището и клона в GitHub. Сменяйте ги само ако направите ново хранилище.</div>
      <form id="ghF" onsubmit="return false"><div class="grid g3">
        ${fld('Потребител в GitHub', 'gh_user', { val: status.ghUser || '', hint: 'потребителското име в GitHub' })}
        ${fld('Хранилище', 'gh_repo', { val: status.ghRepo || '', hint: 'името на хранилището с каталога' })}
        ${fld('Клон', 'gh_branch', { val: status.ghBranch || 'main', hint: 'обикновено main' })}
      </div></form>
      <div class="toolbar"><button class="btn pri" onclick="saveGhSettings()">Запиши и сглоби адреса</button></div>
      <div class="hint" style="margin-top:10px">Адрес, който ползва сайтът:<br>
      <code style="word-break:break-all">${esc(status.rawUrl || '(попълнете потребител и хранилище)')}</code></div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Витрини в каталога</h3>
      <div class="note" style="margin-top:0">Ръчно подбрани тематични списъци („Лято 2026“, „Краезнание“…),
      които страницата на сайта показва като бутони над резултатите. „Нови постъпления“ се показва
      автоматично от датата на постъпване — не е нужна витрина за нея. Книги се добавят тук по инв. №/баркод
      или от „Книги“ — маркирате с отметките и натискате „Във витрина…“.</div>
      <div id="shelvesBox">зареждане…</div>
      <div class="toolbar" style="margin-top:8px">
        <button class="btn pri" onclick="createShelf()">+ Нова витрина</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Публичен адрес на сайта</h3>
      <p class="hint" style="margin-top:0">Редактира се в „Настройки“ → „Библиотека“ → „Адрес на сайта“.</p>
      <div class="hint">Текущ адрес: <b>${esc(s ? s.cat_url || '—' : '—')}</b></div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Ръчно извеждане</h3>
      <p style="font-size:13.5px;margin-top:0">Извежда снимка на данните във файл по избор, независимо от папката за
      автоматично публикуване по-горе.</p>
      <div class="toolbar">
        <button class="btn" onclick="exportCatalog()">Каталог (JSON)…</button>
        <button class="btn" onclick="exportCatalogCsv()">Целия фонд (CSV)…</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Библиотечни формати за обмен</h3>
      <p style="font-size:13.5px;margin-top:0">Извежда фонда в стандартните формати, които други
      библиотечни системи разпознават. Смисълът е данните да не са заключени в тази програма: при
      преминаване към <b>COBISS</b> или включване в сводния каталог се подава един файл, вместо да
      се преписват записите на ръка.<br>
      Изнасят се същите документи, които влизат и в онлайн каталога: <b>без отчислените</b>
      (библиотеката вече не ги притежава) и <b>без отдел „служебен“</b>.</p>
      <div class="toolbar">
        <button class="btn" onclick="exportMarc()">UNIMARC / MARCXML…</button>
        <button class="btn" onclick="exportDc()">Dublin Core…</button>
      </div>
      <div class="hint" style="margin-top:8px">
        <b>UNIMARC</b> носи пълното библиографско описание — полета 200 (заглавие и автор),
        210 (издателски данни), 215 (обем), 606 (предметни рубрики), 675 (УДК), 700 (автор с
        разделени фамилия и име) и 995 (данни за екземпляра: инвентарен номер, отдел, сигнатура).<br>
        <b>Dublin Core</b> е по-простият формат, който приемат хранилищата на цифрово съдържание
        и агрегаторите.
      </div>
    </div>`;
  loadShelvesBox();
}
/* ---------------- Витрини в каталога ---------------- */
async function loadShelvesBox() {
  const box = $('#shelvesBox'); if (!box) return;
  const shelves = await call(window.api.shelves.list());
  if (!shelves) { box.textContent = 'Витрините не се заредиха.'; return; }
  box.innerHTML = shelves.length ? `
    <div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead>
      <tr><th>Витрина</th><th>Записи</th><th style="width:230px"></th></tr></thead><tbody>
      ${shelves.map(sh => `<tr><td><b>${esc(sh.name)}</b></td><td class="num">${sh.n}</td>
        <td><button class="btn sm" onclick="openShelf(${sh.id})">Отвори</button>
            <button class="btn sm" onclick="renameShelf(${sh.id}, '${jsq(sh.name)}')">Преименувай</button>
            <button class="btn sm dgr" onclick="deleteShelf(${sh.id})">Изтрий</button></td></tr>`).join('')}
    </tbody></table></div>`
    : '<div class="hint">Още няма витрини. Създайте първата — напр. „Нови български романи“ или „Краезнание“.</div>';
}
async function createShelf() {
  const name = await askText('Нова витрина', {
    label: 'Име на витрината', hint: 'вижда се на сайта', okLabel: 'Създай',
    note: 'Например „Лято 2026“, „Краезнание“, „Нови български романи“.'
  });
  if (!name || !name.trim()) return;
  const id = await call(window.api.shelves.create(name.trim()), 'Витрината е създадена.');
  if (id != null) { loadShelvesBox(); openShelf(id); }
}
window.createShelf = createShelf;
async function renameShelf(id, current) {
  const name = await askText('Преименуване на витрината', {
    label: 'Ново име на витрината', value: current || '', okLabel: 'Преименувай'
  });
  if (!name || !name.trim()) return;
  const ok = await call(window.api.shelves.rename({ id, name: name.trim() }), 'Преименувана.');
  if (ok !== null) loadShelvesBox();
}
window.renameShelf = renameShelf;
async function deleteShelf(id) {
  if (!confirm('Изтриване на витрината? Книгите в нея остават непокътнати във фонда — маха се само списъкът от сайта.')) return;
  const ok = await call(window.api.shelves.delete(id), 'Витрината е изтрита.');
  if (ok !== null) loadShelvesBox();
}
window.deleteShelf = deleteShelf;
async function openShelf(id) {
  const [shelves, items] = await Promise.all([call(window.api.shelves.list()), call(window.api.shelves.items(id))]);
  if (!shelves || !items) return;
  const sh = shelves.find(x => x.id === id);
  if (!sh) return;
  modal('Витрина „' + sh.name + '“', `
    <div class="note" style="margin-top:0">Добавете книга по инвентарен номер или баркод — или маркирайте
    няколко в „Книги“ и използвайте „Във витрина…“. Промените се публикуват при следващото автоматично
    качване на каталога.</div>
    <input id="shelfScan" class="scan" placeholder="Инв. № или баркод — Enter за добавяне…" autocomplete="off">
    <div style="margin-top:12px">
      ${items.length ? `<div class="wrap" style="border:0;box-shadow:none"><table class="ledger"><thead>
        <tr><th>Инв. №</th><th>Заглавие</th><th>Автор</th><th style="width:100px"></th></tr></thead><tbody>
        ${items.map(b => `<tr><td class="num">${b.inv_number ?? ''}</td><td>${esc(b.title)}</td>
          <td>${esc(b.author || '')}</td>
          <td><button class="btn sm dgr" onclick="removeFromShelf(${id}, ${b.id})">Махни</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="hint">Витрината е празна.</div>'}
    </div>`,
    `<button class="btn" onclick="closeModal()">Затвори</button>`);
  const el = $('#shelfScan');
  if (el) {
    el.focus();
    el.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const code = el.value.trim(); el.value = ''; if (!code) return;
      const res = await window.api.shelves.addBook({ shelfId: id, code });
      if (!res.ok) return toast(res.error, 'err');
      toast('Добавена: инв. № ' + res.data.inv_number + ' — ' + res.data.title, 'ok');
      markSaved();
      openShelf(id);
    });
  }
}
window.openShelf = openShelf;
async function removeFromShelf(shelfId, bookId) {
  const ok = await call(window.api.shelves.removeBook({ shelfId, bookId }), 'Махната от витрината.');
  if (ok !== null) openShelf(shelfId);
}
window.removeFromShelf = removeFromShelf;
/* Групово добавяне от отметките в „Книги" */
async function bulkAddToShelf() {
  const n = BOOKS_SELECTED.size;
  if (!n) return;
  const shelves = await call(window.api.shelves.list());
  if (!shelves) return;
  if (!shelves.length) {
    toast('Още няма витрини — създайте първата в „Онлайн каталог“ → „Витрини в каталога“.', 'err');
    return;
  }
  modal('Във витрина — ' + n + ' избрани документа', `
    <form id="shelfPickF" onsubmit="return false">
      ${fld('Витрина', 'shelfId', { type: 'select', allowEmpty: false,
        opts: shelves.map(sh => ({ v: sh.id, t: sh.name + ' (' + sh.n + ')' })) })}
    </form>
    <div class="hint">Отчислени и служебни документи се подминават автоматично.</div>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="applyBulkShelf()">Добави</button>`);
}
window.bulkAddToShelf = bulkAddToShelf;
async function applyBulkShelf() {
  const d = formData('#shelfPickF');
  const r = await call(window.api.shelves.addBooks({ shelfId: parseInt(d.shelfId, 10), ids: [...BOOKS_SELECTED] }));
  if (r == null) return;
  closeModal();
  /* Пропуснатите се показват поименно. Дотук тук идваше само число и отметнат
     документ без статус (обичайно при записи от по-стар внос) изчезваше от
     витрината без нито дума защо — точно тихият отказ, срещу който единичното
     добавяне вече дава подробно обяснение. */
  const skipped = (r && r.skipped) || [];
  toast(r.added + ' документа добавени във витрината'
    + (skipped.length ? ', ' + skipped.length + ' пропуснати' : '') + '.', skipped.length ? 'err' : 'ok');
  if (skipped.length) {
    modal('Документи, които не влязоха във витрината', `
      <div class="note" style="border-left-color:var(--red);margin-top:0">
        Тези документи не се публикуват в онлайн каталога и затова не бяха добавени.
        Документ „без попълнен статус“ обикновено идва от по-стар внос — отворете го,
        задайте статус „наличен“ и го добавете отново.</div>
      <div class="wrap"><table class="ledger"><thead><tr><th>Инв. №</th><th>Заглавие</th><th>Причина</th></tr></thead><tbody>
      ${skipped.map(x => `<tr><td class="num">${esc(String(x.inv_number ?? '—'))}</td>
        <td>${esc(x.title || '')}</td><td>${esc(x.reason)}</td></tr>`).join('')}
      </tbody></table></div>`,
      `<button class="btn pri" onclick="closeModal()">Разбрах</button>`);
  }
  markSaved();
}
window.applyBulkShelf = applyBulkShelf;
// Броят на пропуснатите се казва: иначе разликата между „15 000 във фонда“ и
// „14 620 изведени“ изглежда като загубени записи.
function exportSkipped(d) {
  return d && d.excluded ? ` (${d.excluded} отчислени/служебни не се изнасят)` : '';
}
async function exportMarc() {
  const res = await window.api.catalog.exportMarc();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast(`Изведени ${res.data.count} записа в UNIMARC${exportSkipped(res.data)}: ${res.data.path}`, 'ok');
}
window.exportMarc = exportMarc;
async function exportDc() {
  const res = await window.api.catalog.exportDc();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast(`Изведени ${res.data.count} записа в Dublin Core${exportSkipped(res.data)}: ${res.data.path}`, 'ok');
}
window.exportDc = exportDc;
async function catalogChooseFolder() {
  const res = await window.api.catalog.chooseFolder();
  if (!res.ok) return toast(res.error, 'err');
  if (res.adopted) {
    toast(`Папката е свързана с хранилището ${res.adopted.user}/${res.adopted.repo} — настройките са попълнени сами.`, 'ok');
  } else if (res.mismatch) {
    toast('Папката е свързана, но сочи към друго хранилище — вижте предупреждението по-горе.', 'err');
  } else {
    toast('Папката е свързана — katalog.json се обновява автоматично.', 'ok');
  }
  renderCatalog();
}
window.catalogChooseFolder = catalogChooseFolder;
async function catalogDisconnect() {
  if (!confirm('Спиране на автоматичния запис на katalog.json?')) return;
  await call(window.api.catalog.disconnectFolder(), 'Изключено.');
  renderCatalog();
}
window.catalogDisconnect = catalogDisconnect;
async function catalogWriteNow() {
  const res = await window.api.catalog.writeNow();
  if (!res.ok) return toast(res.error, 'err');
  toast('Каталогът е обновен.', 'ok');
  renderCatalog();
}
window.catalogWriteNow = catalogWriteNow;
async function catalogGitPublishNow() {
  toast('Публикуване в GitHub…', 'ok');
  const res = await window.api.catalog.gitPublishNow();
  if (!res.ok) return toast(res.error, 'err');
  toast(res.committed ? 'Публикувано в GitHub.' : 'Няма промяна за публикуване.', 'ok');
  renderCatalog();
}
window.catalogGitPublishNow = catalogGitPublishNow;
async function saveGhSettings() {
  const d = formData('#ghF');
  await call(window.api.catalog.updateGh(d), 'Настройките за GitHub са записани.');
  renderCatalog();
}
window.saveGhSettings = saveGhSettings;
async function exportCatalog() {
  const res = await window.api.catalog.export();
  if (!res.ok) return toast(res.error, 'err');
  toast('Каталогът е записан в ' + res.data, 'ok');
}
window.exportCatalog = exportCatalog;
async function exportCatalogCsv() {
  const res = await window.api.catalog.exportCsv();
  if (!res.ok) return toast(res.error, 'err');
  toast('Таблицата е записана в ' + res.data, 'ok');
}
window.exportCatalogCsv = exportCatalogCsv;
