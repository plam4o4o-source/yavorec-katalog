/* ---------------- Периодика ---------------- */
async function renderPeriodika() {
  const list = await call(window.api.periodicals.list());
  if (!list) return;
  $('#view').innerHTML = `
    <div class="note">Картотека на периодичните издания и постъпилите броеве към всяко от тях (кардекс).</div>
    <div class="toolbar"><button class="btn pri" onclick="periodicalForm()">+ Ново периодично издание</button></div>
    <div class="wrap"><table class="ledger"><thead><tr><th>Заглавие</th><th>Периодичност</th><th>Издател</th>
      <th>ISSN</th><th>Отдел</th><th>Броеве</th><th>Инвентирани комплекти</th><th>Следващ очакван брой</th><th></th></tr></thead><tbody>
    ${list.length ? list.map(p => `<tr><td>${esc(p.title)}</td><td>${esc(p.freq || '')}</td><td>${esc(p.publisher || '')}</td>
      <td class="num">${esc(p.issn || '')}</td><td>${esc(p.department || '')}</td><td class="num">${p.issue_count}</td>
      <td class="num">${periodicalVolumesHtml(p)}</td>
      <td class="num">${periodicalNextHtml(p)}</td>
      <td><button class="btn sm" onclick="openPeriodical(${p.id})">Отвори</button></td></tr>`).join('')
      : `<tr><td colspan="9" class="empty">Няма заведени периодични издания.</td></tr>`}
    </tbody></table></div>`;
}
/* Колоната „Инвентирани комплекти“ (v2.4.56) е единственото място, където
   разликата между „водим го в кардекса“ и „то е във фонда“ се вижда с един
   поглед. Дотук такава разлика нямаше как да се забележи: периодиката НИКОГА не
   влизаше във фонда, а КДБФ Част № 1 се печаташе със заглавие, което изрично
   изброява периодичните издания — тоест разпечатката твърдеше едно, а числата ѝ
   бяха други, всяка година. Нулата тук е предупреждение, не украса: заглавие с
   вписани броеве и нула инвентирани комплекта е абонамент, който не е отчетен
   никъде. Затова се показва като жълт знак, а не като тихо „0“. */
function periodicalVolumesHtml(p) {
  const n = Number(p.volume_count) || 0;
  if (n) return String(n);
  if (!Number(p.issue_count)) return '<span class="hint">—</span>';
  return `<span class="badge warn" title="Има вписани броеве, но нито един годишен комплект не е инвентиран — това издание не влиза в КДБФ и в отчета за фонда">0</span>`;
}
/* Следваща очаквана дата, изчислена в handlers/periodicals.js от периодичността
   и датата на последния постъпил брой (Koha: серийни издания — облекчен вариант
   за мащаба на читалищна библиотека, само предвиждане на дата, без пълен
   календар/рекламации). „—“ означава, че изданието е с „нередовно“/непозната
   периодичност или все още няма нито един вписан брой — тогава предвиждане
   умишлено не се прави (виж коментара в handlers/periodicals.js). */
function periodicalNextHtml(p) {
  if (!p.next_expected) return '<span class="hint">—</span>';
  return p.issue_overdue_days > 0
    ? `<span class="badge warn" title="Няма нов брой ${p.issue_overdue_days} дни след очакваната дата">${bg(p.next_expected)}</span>`
    : bg(p.next_expected);
}
/* Приема САМО id (v2.2.0) и сам зарежда записа, както другите форми. Дотогава
   бутонът „Редактирай“ вграждаше целия обект в onclick атрибута с ръчно
   екраниране (JSON.stringify(p).replace(/"/g,'&quot;')), което заобикаляше
   jsq() — и заедно с това вкарваше в атрибута и p.issues, тоест цялата история
   на изданието (стотици килобайта при дълга поредица от броеве). */
async function periodicalForm(id) {
  const p = id ? await call(window.api.periodicals.get(id)) : null;
  if (id && !p) return;
  const v = p || { freq: 'месечно', department: 'периодика' };
  modal(p ? 'Редакция на периодично издание' : 'Ново периодично издание', `
    <form id="perF" onsubmit="return false">
      ${fld('Заглавие', 'title', { val: v.title || '', req: 1 })}
      <div class="grid g3">
        ${fld('Периодичност', 'freq', { type: 'select', opts: PER_FREQ, val: v.freq })}
        ${fld('Издател', 'publisher', { val: v.publisher || '' })}
        ${fld('ISSN', 'issn', { val: v.issn || '' })}
      </div>
      ${fld('Отдел', 'department', { type: 'select', opts: OTDELI, val: v.department })}
      ${fld('Забележка', 'note', { val: v.note || '' })}
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="savePeriodical(${p ? p.id : 'null'})">Запиши</button>`);
}
window.periodicalForm = periodicalForm;
async function savePeriodical(id) {
  const d = formData('#perF'); d.id = id;
  if (!d.title.trim()) return toast('Заглавието е задължително.', 'err');
  // Затваря се само при успех (v2.2.0) — при отказан запис попълненото остава.
  const ok = id ? await call(window.api.periodicals.update(d), 'Записано.')
    : await call(window.api.periodicals.create(d), 'Записано.');
  if (ok === null) return;
  closeModal(); renderPeriodika();
}
window.savePeriodical = savePeriodical;
async function openPeriodical(id) {
  const p = await call(window.api.periodicals.get(id));
  if (!p) return;
  modal(p.title, `
    <div class="hint" style="margin-bottom:10px">${esc(p.freq || '')} · ${esc(p.publisher || '')}${p.issn ? ' · ISSN ' + esc(p.issn) : ''}</div>
    <fieldset><legend>Нов постъпил брой</legend>
      <form id="issueF" onsubmit="return false" class="grid g3">
        ${fld('Номер на брой', 'issue_no', { req: 1, onkey: `if(event.key==='Enter'){event.preventDefault();addIssue(${id})}` })}
        ${fld('Дата на постъпване', 'date', { val: today(), type: 'date' })}
        ${mnyField('Цена', 'price', { min: 0 })}
      </form>
      <button type="button" class="btn pri" onclick="addIssue(${id})">Добави брой</button>
    </fieldset>
    ${periodicalVolumesSection(p)}
    ${p.issues.length ? `<div class="wrap" style="max-height:240px"><table class="ledger"><thead><tr>
      <th>Брой</th><th>Дата</th><th>Цена</th><th></th></tr></thead><tbody>
      ${p.issues.map(i => `<tr><td class="num">${esc(i.issue_no)}</td><td class="num">${bg(i.date)}</td>
      <td class="num">${mny(i.price)}</td><td><button type="button" class="btn sm dgr" onclick="delIssue(${i.id},${id},${jsNum(invNoForIssue(p, i))})">×</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="hint">Все още няма вписани броеве.</div>'}`,
    `<button class="btn dgr" onclick="delPeriodical(${id})">Изтрий изданието</button>
     <button class="btn" onclick="closeModal();periodicalForm(${id})">Редактирай</button>
     <button class="btn pri" onclick="closeModal()">Затвори</button>`);
  /* Опресняването виси на ЗАТВАРЯНЕТО, а не на един бутон: ✕ и Esc затварят
     същия прозорец и дотук оставяха списъка отзад със старите „Броеве“ и
     „Следващ очакван брой“ — току-що вписан брой продължаваше да се води
     закъснял. */
  onModalClose(periodikaRefreshIfShown);
  setTimeout(() => { const f = $('#issueF [name=issue_no]'); if (f) f.focus(); }, 0);
}
window.openPeriodical = openPeriodical;
/* Одит v2.4.29: след „Добави брой“/„×“ списъкът зад кардекса показваше старите
   „Броеве“ и „Следващ очакван брой“ до повторно влизане в раздела. */
function periodikaRefreshIfShown() { if (VIEW === 'periodika') renderPeriodika(); }
window.periodikaRefreshIfShown = periodikaRefreshIfShown;

/* ============================================================================
   ГОДИШНИ КОМПЛЕКТИ — периодиката влиза във фонда (v2.4.56)
   ============================================================================
   ДОТУК този прозорец беше край на пътя: броевете се вписваха в кардекса и
   оставаха там завинаги. Никъде в програмата нямаше действие, което да вкара
   периодично издание в инвентарната книга — нито инвентарен номер, нито партида,
   нито ред в наличността.
   ЗАЩО Е ГРЕШНО: отпечатаното заглавие на КДБФ Част № 1 гласи „Регистриране на
   постъпили книги, ПЕРИОДИЧНИ ИЗДАНИЯ и други материали“, Дневникът има готов ред
   „Периодични издания“ в Раздел Б, а Наредба № 3 (чл. 13, ал. 3, т. 1; чл. 14;
   чл. 16) брои периодичните издания за библиотечни документи. Тоест програмата
   печаташе документи, които сами твърдят, че съдържат периодика, и не съдържаха
   нито ред от нея — постъпленията и стойността на фонда излизаха системно
   занижени при всяка проверка.
   ЗАЩО ИМЕННО ГОДИШЕН КОМПЛЕКТ: броевете за една година се подвързват и се водят
   като ЕДИН библиотечен документ с ЕДИН инвентарен номер — така е в практиката и
   така го брои статистиката. Затова действието стои ТУК, до кардекса (той знае
   кои броеве са постъпили и колко струват), а не в „Фонд“, където библиотекарят
   би трябвало да преписва наум сбора от дванайсет реда. */
function jsNum(v) { return v == null ? 'null' : String(Number(v)); }
/* Инв. номерът на комплекта, в който попада ЕДИН брой (или null). Ползва се, за
   да предупреди „×“, че се трие брой от вече подвързан и вписан във фонда
   комплект — виж delIssue по-долу. */
function invNoForIssue(p, issue) {
  const year = issue && issue.date ? String(issue.date).slice(0, 4) : null;
  if (!year) return null;
  const v = (p.volumes || []).find(x => String(x.year) === year && x.book_id != null);
  return v ? v.inv_number : null;
}
function periodicalVolumesSection(p) {
  const vols = p.volumes || [];
  const rows = vols.map(v => {
    const done = v.book_id != null;
    const invCell = done
      ? `<b>инв. № ${esc(String(v.inv_number ?? '—'))}</b>${v.register_date ? ' · вписан ' + bg(v.register_date) : ''}`
        + `${v.acq_no ? ' · партида № ' + esc(String(v.acq_no)) + '/' + esc(String(v.acq_year)) : ' · <span class="hint">без партида</span>'}`
        + `${v.deaccession_date ? ' · <span class="badge warn">отчислен</span>' : ''}`
      : '<span class="hint">не е инвентиран</span>';
    return `<tr><td class="num">${esc(String(v.year))}</td><td class="num">${Number(v.issue_count) || 0}</td>
      <td class="num">${mny(done ? v.volume_price : v.issue_sum)}</td><td>${invCell}</td>
      <td>${done ? '' : `<button type="button" class="btn sm pri" onclick="volumeForm(${p.id},'${esc(String(v.year))}')">Инвентирай годишния комплект</button>`}</td></tr>`;
  }).join('');
  return `<fieldset><legend>Годишни комплекти (фонд)</legend>
    <div class="note">Броевете за една година се подвързват и се водят като <b>един библиотечен документ с един
      инвентарен номер</b> (чл. 16). Докато комплектът не е инвентиран, изданието не влиза нито в КДБФ Част № 1,
      нито в отчета за фонда.</div>
    ${vols.length ? `<div class="wrap" style="max-height:200px"><table class="ledger"><thead><tr>
      <th>Година</th><th>Броеве</th><th>Стойност</th><th>Във фонда</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
      : '<div class="hint">Годините се появяват тук, щом бъде вписан първият брой.</div>'}
  </fieldset>`;
}
/* Формата за инвентиране стои на ВТОРИЯ слой прозорци (modal2) върху кардекса:
   попълненото в кардекса (започнат нов брой) не бива да се губи, а и след запис
   библиотекарят се връща точно там, откъдето е тръгнал. */
async function volumeForm(periodicalId, year) {
  const [p, acqs, s] = await Promise.all([
    call(window.api.periodicals.get(periodicalId)),
    call(window.api.acquisitions.list()),
    call(window.api.settings.get())
  ]);
  if (!p) return;
  const v = (p.volumes || []).find(x => String(x.year) === String(year));
  if (!v) return toast('Годината вече не е налична в кардекса.', 'err');
  if (v.book_id != null) return toast('Комплектът за ' + year + ' г. вече е инвентиран като инв. № ' + (v.inv_number ?? '—') + '.', 'err');
  /* Партидата се избира от съществуващите или се създава нова — точно както при
     книгите. Новата минава през СЪЩИЯ канал acquisitions.create, който ползва и
     екранът „Постъпления“: две различни бройни логики за номерата в КДБФ не бива
     да съществуват (чл. 14 — партидите са една поредица за цялата библиотека). */
  const acqOpts = (acqs || []).map(a => ({ v: a.id, t: '№ ' + a.no + '/' + a.year + ' — ' + (a.from_source || '') }));
  acqOpts.push({ v: '__new__', t: '➕ нова партида (абонамент) …' });
  modal2('Инвентиране на годишен комплект — ' + p.title + ', ' + year + ' г.', `
    <div class="note"><b>Чл. 16, ал. 1</b> — индивидуалната регистрация съдържа: дата на вписване, инвентарен номер,
      автор, заглавие, том, година, цена, номер и дата на вписване в КДБФ, сигнатура.</div>
    <div class="hint" style="margin-bottom:8px">В инвентарната книга ще влезе един ред:
      <b>„${esc(p.title + ', ' + year)}“</b>, вид „продължаващо издание“, том „годишен комплект“.
      В кардекса за ${esc(String(year))} г. има ${Number(v.issue_count) || 0} вписани броя на обща стойност ${mny(v.issue_sum)}.</div>
    <form id="volF" onsubmit="return false">
      <div class="grid g3">
        ${fld('Инвентарен номер', 'inv_number', { val: (s && s.next_inv_number) || '', type: 'number', req: 1 })}
        ${fld('Дата на вписване', 'register_date', { val: today(), type: 'date', req: 1 })}
        ${mnyField('Цена', 'price', { val: Number(v.issue_sum) || 0, min: 0, req: 1, hint: 'по подразбиране — сборът от цените на броевете' })}
      </div>
      ${fld('Партида в КДБФ (част № 1)', 'acquisition_id', { type: 'select', opts: acqOpts, val: '', emptyLabel: '— без партида —', onchange: 'volumeAcqToggle()' })}
      <fieldset id="volAcqNew" hidden style="display:none"><legend>Нова партида — абонаментът като постъпление</legend>
        <div class="grid g4">
          ${fld('Дата на вписване', 'acq_date', { val: today(), type: 'date' })}
          ${fld('Начин на постъпване', 'acq_how', { type: 'select', opts: NACHINI, val: NACHINI[0] })}
          ${fld('Откъде (доставчик / дарител)', 'acq_from_source', {})}
          ${fld('Общ брой документи', 'acq_total_count', { val: 1, type: 'number' })}
        </div>
        <div class="grid g4">
          ${fld('Вид първичен документ', 'acq_doc_type', { type: 'select', opts: PARV_DOK })}
          ${fld('Номер на документа', 'acq_doc_no', {})}
          ${fld('Дата на документа', 'acq_doc_date', { val: today(), type: 'date' })}
          ${fld('Адрес на дарителя', 'acq_donor_address', { hint: 'задължително при дарение — чл. 6, ал. 5' })}
        </div>
      </fieldset>
      ${fld('Забележка към документа', 'note', { val: '', hint: 'напр. „подвързан в 2 тома“' })}
    </form>`,
    `<button class="btn" onclick="closeModal2()">Отказ</button>
     <button class="btn pri" onclick="saveVolume(${p.id},'${esc(String(year))}')">Впиши в инвентарната книга</button>`);
}
window.volumeForm = volumeForm;
/* Скриването е с ДВЕ средства наведнъж — атрибутът `hidden` и `style.display` —
   и това не е излишно. Атрибутът е този, по който focusables()/trapTab() в
   core.js решават кое поле участва в обхода с Tab; самото изчезване обаче виси
   на браузърското „[hidden]{display:none}“, което е правило с тегло 0-1-0 и се
   надвива от всяко авторско правило за `display` върху същия елемент (точно това
   вече се беше случило със сгънатите групи в навигацията — виж бележката в
   src/style.css). Полетата на партидата не бива да са нито видими, нито
   достижими с Tab, докато библиотекарят не е избрал „нова партида“. */
function volumeAcqToggle() {
  const sel = $('#volF [name=acquisition_id]');
  const box = $('#volAcqNew');
  if (!sel || !box) return;
  const show = sel.value === '__new__';
  box.hidden = !show;
  box.style.display = show ? '' : 'none';
}
window.volumeAcqToggle = volumeAcqToggle;
async function saveVolume(periodicalId, year) {
  const missing = firstMissingRequired('#volF');
  if (missing) return toast(missing + ' е задължително поле.', 'err');
  const d = formData('#volF');
  let acquisitionId = d.acquisition_id;
  /* Новата партида се завежда ПЪРВА и само ако е успяла, се инвентира комплектът.
     Обратният ред би оставил документ без партида при отказана партида — тоест
     ред във фонда, който не се вижда в КДБФ Част № 1: точно грешката, която този
     екран съществува да поправи. Ако пък инвентирането се провали след успешно
     заведена партида, партидата остава — това е вярно: тя е самостоятелно
     вписване в регистъра, а не черновa, и се поправя/трие от „Постъпления“. */
  if (acquisitionId === '__new__') {
    if (!String(d.acq_from_source || '').trim()) return toast('Попълнете откъде е постъпил абонаментът.', 'err');
    if (String(d.acq_how) === 'дарение' && !String(d.acq_donor_address || '').trim()) {
      return toast('При дарение адресът на дарителя е задължителен (чл. 6, ал. 5).', 'err');
    }
    const no = await call(window.api.acquisitions.nextNo(yr(d.acq_date)));
    if (no === null) return;
    const newId = await call(window.api.acquisitions.create({
      no, date: d.acq_date, how: d.acq_how, from_source: d.acq_from_source,
      doc_type: d.acq_doc_type, doc_no: d.acq_doc_no, doc_date: d.acq_doc_date,
      total_count: d.acq_total_count, sum: '', donor_address: d.acq_donor_address,
      note: 'Абонамент за периодика'
    }), 'Партидата е заведена в КДБФ част 1.');
    if (newId === null) return;
    acquisitionId = newId;
  }
  const res = await call(window.api.periodicalVolumes.register({
    periodical_id: periodicalId, year, price: d.price,
    register_date: d.register_date, inv_number: d.inv_number,
    acquisition_id: acquisitionId, note: d.note
  }));
  if (res === null) return;
  markSaved();
  toast('Годишният комплект за ' + year + ' г. е вписан в инвентарната книга под инв. № ' + res.inv_number + '.', 'ok');
  closeModal2();
  openPeriodical(periodicalId);
}
window.saveVolume = saveVolume;
async function addIssue(periodicalId) {
  const d = formData('#issueF');
  if (!d.issue_no) return toast('Въведете номер на брой.', 'err');
  d.periodical_id = periodicalId;
  // Затваря се/пречертава се само при успех; отказът (невалидна дата, цена) остава във формата.
  const ok = await call(window.api.periodicalIssues.add(d), 'Брой ' + d.issue_no + ' е вписан в кардекса.');
  if (ok === null) return;
  markSaved();
  openPeriodical(periodicalId);
}
window.addIssue = addIssue;
async function delIssue(id, periodicalId, invNo) {
  /* Одит v2.4.16: изтриваше се без питане и без проверка на резултата. Един
     неточен натиск в 240-пикселов превъртащ се списък махаше регистриран брой, а
     път за връщане в интерфейса няма. Съседното delPeriodical пита както трябва. */
  /* v2.4.56: питането вече казва и КОЛКО струва изтриването, когато годината е
     инвентирана. Броят тогава не е ред в картотека, а физическа част от
     подвързан библиотечен документ с инвентарен номер, вписан в инвентарната
     книга и в КДБФ. Изтриването не се забранява (сгрешено вписване трябва да може
     да се поправи), но библиотекарят трябва да знае, че след него кардексът вече
     няма да отговаря на документа на рафта — а при проверка отговаря той, не
     програмата. Самото изтриване се вписва в одитната следа заедно с този факт
     (handlers/periodicals.js). */
  const текст = invNo == null
    ? 'Да изтрия ли този брой от кардекса? Действието не може да бъде отменено.'
    : 'Този брой е част от годишния комплект, инвентиран като инв. № ' + invNo + '.\n\n'
      + 'Комплектът е подвързан и вписан в инвентарната книга — след изтриването кардексът вече няма да отговаря '
      + 'на документа във фонда. Да изтрия ли броя въпреки това?';
  if (!await askConfirm(текст)) return;
  const ok = await call(window.api.periodicalIssues.delete(id), 'Броят е изтрит.');
  if (ok === null) return;
  markSaved();
  openPeriodical(periodicalId);
}
window.delIssue = delIssue;
async function delPeriodical(id) {
  if (!await askConfirm('Изтриване на периодичното издание?')) return;
  const res = await window.api.periodicals.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  closeModal(); renderPeriodika(); toast('Изтрито.', 'ok');
}
window.delPeriodical = delPeriodical;
