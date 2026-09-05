/* ---------------- Лого на организацията ---------------- */
async function chooseLogo() {
  const res = await window.api.settings.chooseLogo();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  toast('Логото е записано — влиза автоматично в документите и читателските карти.', 'ok');
  markSaved();
  await loadSettingsCache();
  if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.chooseLogo = chooseLogo;
async function clearLogo() {
  if (!await askConfirm('Премахване на логото от документите и картите?', { okLabel: 'Премахни' })) return;
  await call(window.api.settings.clearLogo(), 'Логото е премахнато.');
  await loadSettingsCache();
  if (RENDERERS[VIEW]) RENDERERS[VIEW]();
}
window.clearLogo = clearLogo;
async function activeBooks() {
  const books = await call(window.api.books.list(''));
  return (books || []).filter(b => b.status !== 'отчислен');
}
/* Етикетите и картите се подават на printLabelSheet() като ДАННИ ({rows, card}),
   а не като готов HTML низ (v2.3.1). ЗАЩО: въпросът „наистина ли 14 750 етикета?“
   (confirmManyLabels, v2.3.0) се задава вътре в printLabelSheet — а дотук всяка
   от тези функции вече беше построила целия низ с rows.map(...).join(''), тоест
   при 14 750 етикета ~1–2 s и десетки мегабайта, изхабени ПРЕДИ библиотекарят да
   е казал „да“, и напълно напразно, ако каже „не“. Сега низът се сглобява чак
   след потвърждението. „Диапазон“ минава по същия път — таванът важи и там,
   защото диапазон „от 1 до 99999“ е точно същият печат с друго име. */
async function printLabelsRange() {
  const from = parseInt($('[name=lblFrom]').value, 10), to = parseInt($('[name=lblTo]').value, 10);
  if (!from || !to || to < from) return toast('Въведете валиден диапазон от инвентарни номера.', 'err');
  const rows = (await activeBooks()).filter(b => b.inv_number >= from && b.inv_number <= to).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Няма документи в този диапазон.', 'err');
  return printLabelSheet({ rows, card: lblCard }, 'fund');
}
window.printLabelsRange = printLabelsRange;
async function printLabelsAll() {
  const rows = (await activeBooks()).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Фондът е празен.', 'err');
  return printLabelSheet({ rows, card: lblCard }, 'fund');
}
window.printLabelsAll = printLabelsAll;
async function printSignatureLabelsRange() {
  const from = parseInt($('[name=sigFrom]').value, 10), to = parseInt($('[name=sigTo]').value, 10);
  if (!from || !to || to < from) return toast('Въведете валиден диапазон от инвентарни номера.', 'err');
  const rows = (await activeBooks()).filter(b => b.inv_number >= from && b.inv_number <= to).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Няма документи в този диапазон.', 'err');
  return printLabelSheet({ rows, card: sigLblCard }, 'sig');
}
window.printSignatureLabelsRange = printSignatureLabelsRange;
async function printSignatureLabelsAll() {
  const rows = (await activeBooks()).sort((a, b) => a.inv_number - b.inv_number);
  if (!rows.length) return toast('Фондът е празен.', 'err');
  return printLabelSheet({ rows, card: sigLblCard }, 'sig');
}
window.printSignatureLabelsAll = printSignatureLabelsAll;
async function printCardsAll() {
  const readers = await call(window.api.readers.list(''));
  const rows = (readers || []).filter(r => r.status !== 'прекратен');
  if (!rows.length) return toast('Няма активни читатели.', 'err');
  return printLabelSheet({ rows, card: readerCardHtml }, 'card');
}
window.printCardsAll = printCardsAll;
/* Карта само за ЕДИН читател (v1.71.0) — бутон „Карта“ на реда в списъка
   Читатели. Дотогава картите се печатаха единствено всичките наведнъж, а
   на практика нова карта трябва най-често на един новозаписан читател. */
async function printCardOne(id) {
  const r = await call(window.api.readers.get(id));
  if (!r) return;
  return printLabelSheet(readerCardHtml(r), 'card');
}
window.printCardOne = printCardOne;
/* Колко реда се побират на картона. Одит v2.4.16: срязването беше зашитото 14 и
   НЕ се споменаваше никъде на листа — а loans:byReader връща най-новите първи,
   тоест по-старата история просто изчезваше без следа. Всяко друго място в
   програмата, което реже списък, го казва („Показани са N от M“ в Просрочени,
   броячът в Одитна следа, „Печатът винаги съдържа цялата книга“ в Инвентарна). */
const CARD_LOAN_ROWS = 14;
/* Одит на документите v2.4.17: readers:get връща ЕГН и № ЛК вече МАСКИРАНИ,
   когато защитата на личните данни е заключена — тоест буквално низа „Защитени
   данни“. Картонът ги вмъкваше право в реда „ЕГН:“ и този надпис отиваше върху
   документ, който гражданинът подписва и който се подрежда в картотеката. А
   заключеното състояние е нормалното в началото на всеки работен ден.
   Сега маскираните полета се печатат като „…“ — точно както всяко друго празно
   поле на същия ред — и на листа се отбелязва защо, за да не изглежда като
   пропуск на библиотекаря. */
async function printReaderCard(id) {
  const r = await call(window.api.readers.get(id));
  if (!r) return;
  const loans = await call(window.api.loans.byReader(id)) || [];
  /* ПО ПОЛЕ, не по ред (виж maskOne в handlers/pdp.js). Читател със записан на
     ОТКРИТ ТЕКСТ ЕГН и криптиран № на лична карта не бива да губи ЕГН-то от
     картона си, а ред с нечетим ЕГН и редовен № на карта трябва да скрие точно
     ЕГН-то. Старата форма на флага се приема като „и двете“, за да работи и ако
     редът дойде от по-стар канал. */
  const piiMasked = new Set(Array.isArray(r.pii_masked_fields) ? r.pii_masked_fields
    : (r.pii_masked ? ['egn', 'id_card_no'] : []));
  const piiEgn = piiMasked.has('egn'), piiCard = piiMasked.has('id_card_no');
  const piiNames = [piiEgn ? 'ЕГН' : '', piiCard ? '№ на лична карта' : ''].filter(Boolean).join(' и ');
  /* Причината идва от maskOne (handlers/pdp.js), а не от сравняване на низове.
     Одит v2.4.18: тук се печаташе едно и също обяснение за двата съвсем различни
     случая — „защитата е заключена, отключете и отпечатайте наново“ важи само за
     'locked'. При 'unreadable' (ключът не отговаря на данните) отключването вече е
     станало и указанието праща библиотекаря да повтори нещо, което не помага. */
  const both = piiEgn && piiCard;
  /* Одит v2.4.21 (единадесети кръг): причината вече идва от ПРОВЕРИТЕЛЯ, не от
     партидна статистика (виж maskOne в handlers/pdp.js), и всяко състояние има
     точно едно значение:
       locked     — защитата е заключена в тази сесия; отключването я вдига;
       stale      — паролата е сменена от друго работно място; данните са
                    непокътнати и се връщат с едно отключване с новата парола.
                    Дотук същата дума покриваше и „единствените криптирани редове
                    са повредени“ и указанието „въвеждайте наново само ако и
                    отключването откаже“ беше неизпълнимо: в това състояние
                    формата заключва полетата и няма път за въвеждане;
       unreadable — ключът е верният, конкретният ред е повреден; защитата е
                    ОТКЛЮЧЕНА, тоест въвеждането наново е възможно веднага.
     Числото се съгласува и в трите: „стойността“ за едно поле, „стойностите“
     за две — библиотекар, въвел наново само ЕГН по указание в единствено число,
     е изпълнил документа буквално. */
  const piiWhy = {
    locked: 'защитата на личните данни е заключена в момента. Отключете я от „Настройки“ и отпечатайте наново, '
      + `ако картонът трябва да ${both ? 'ги' : 'го'} съдържа.`,
    stale: `паролата за защита на личните данни е сменена от друго работно място. ${both ? 'Записаните стойности са непокътнати' : 'Записаната стойност е непокътната'}: `
      + 'отключете защитата от „Настройки“ с актуалната парола и отпечатайте наново.',
    unreadable: `${both ? 'записаните стойности не се разчитат' : 'записаната стойност не се разчита'} с текущата парола за защита на личните данни — `
      + 'самият запис е повреден, не паролата. '
      + `${both ? 'Стойностите трябва да бъдат въведени' : 'Стойността трябва да бъде въведена'} наново в картотеката (защитата е отключена и полетата се редактират).`
  }[r.pii_masked_reason] || 'защитата на личните данни не позволява отпечатването им в момента.';
  setPrintPage({ name: `Читателски картон — ${r.name}`, landscape: false, margin: '14mm 12mm' });
  doPrint(`<div class="pdoc">${shead()}
    <h2>ЧИТАТЕЛСКИ КАРТОН № ${esc(r.card_no || '')}</h2>
    <div class="pmeta">
    <b>Име:</b> ${esc(r.name)}<br>
    <b>ЕГН:</b> ${piiEgn ? '…' : esc(r.egn || '…')} &nbsp; <b>Лична карта:</b> № ${piiCard ? '…' : esc(r.id_card_no || '…')}, издадена на ${r.id_card_date ? bg(r.id_card_date) : '…'} от ${esc(r.id_card_issuer || '…')}<br>
    <b>Постоянен адрес:</b> ${esc(r.address || '…')}<br>
    <b>Телефон:</b> ${esc(r.phone || '…')} &nbsp; <b>Имейл:</b> ${esc(r.email || '…')}<br>
    <b>Категория:</b> ${esc(r.category || '')} &nbsp; <b>Записан на:</b> ${bg(r.registered_at)}${r.re_registered_at ? ' · пререгистриран на ' + bg(r.re_registered_at) : ''}
    ${piiNames ? `<br><span style="font-size:9pt">${esc(piiNames)} ${piiEgn && piiCard ? 'не са отпечатани' : 'не е отпечатан'}:
      ${esc(piiWhy)}</span>` : ''}
    ${r.guarantor_name ? `<br><b>Родител/настойник:</b> ${esc(r.guarantor_name)} (${esc(r.guarantor_relation || 'родител')}) — тел. ${esc(r.guarantor_phone || '…')}` : ''}</div>
    <div style="width:60mm;border:1px solid #000;padding:2mm;text-align:center;margin-bottom:5mm">
      ${/* Същият дефект като в readerCardHtml (core.js), пропуснат тук при
            първата поправка: при липсващ номер на карта баркодът кодираше
            ВЪТРЕШНИЯ номер на реда, а под него не пишеше нищо. Сканирането
            търси по номер на карта, тоест лентите сочат към читателя, чиято
            карта е с този номер — най-често друг гражданин. По-добре без
            баркод и с указание какво липсва. */
        r.card_no
        ? `${code39svg(r.card_no, 200, 50)}<div style="font-family:monospace;font-size:9pt">${esc(r.card_no)}</div>`
        : `<div style="font-size:9pt;color:#b00">Няма номер на карта — въведете го в картона на читателя,
            за да се отпечата баркод.</div>`}</div>
    <table><thead><tr><th>Дата на заемане</th><th>Инв. №</th><th>Заглавие</th><th>Срок</th><th>Върнат на</th></tr></thead><tbody>
    ${loans.slice(0, CARD_LOAN_ROWS).map(l => `<tr><td>${bg(l.date_out)}</td><td>${l.inv_number ?? ''}</td><td>${esc(l.title)}</td>
      <td>${bg(l.date_due) || ''}</td><td>${l.date_in ? bg(l.date_in) : ''}</td></tr>`).join('')}
    </tbody></table>
    ${loans.length > CARD_LOAN_ROWS ? `<div class="pmeta">Показани са последните ${CARD_LOAN_ROWS} заемания
      от общо ${loans.length}. Пълната история е в картона на читателя в програмата.</div>` : ''}
    ${ssig(['Подпис на читателя: …………………', 'Библиотекар: ' + esc((SETTINGS_CACHE || {}).librarian || '…………………')])}</div>`);
}
window.printReaderCard = printReaderCard;
async function printOverdueNotices() {
  const rows = await call(window.api.loans.overdueByReader());
  if (!rows || !rows.length) return toast('Няма просрочени заемания.', 'err');
  const s = SETTINGS_CACHE || {};
  /* Отпечатаното писмо е реално напомняне — регистрира се за всеки читател, със
     степента, която МУ СЕ ПОЛАГА В МОМЕНТА НА ПЕЧАТА.

     Одит v2.4.16: степените се четяха от window._REMINDERS, което се пълни само
     когато прозорецът „Напомняния“ е бил отварян, и оттам живее до края на
     сесията. Тоест: отвориш го сутринта, изпратиш няколко по имейл (всяко от тях
     вдига степента на следващото), после натиснеш „Печат на напомняния“ —
     вписваше се СУТРЕШНАТА степен и ескалацията спираше на място. А ако
     прозорецът изобщо не е отварян, всички се вписваха като степен 1. Степените
     се изтеглят наново тук. */
  /* Одит на документите v2.4.17: при провал call() връща null и се падаше към
     window._REMINDERS, което често е празно — тогава ВСИЧКИ писма се вписваха като
     степен 1, а самите писма пак се печатаха. Тоест провалът тихо нулираше
     стълбицата на ескалацията. По-добре е да не се печата, отколкото да се
     отпечатат писма с невярна степен. */
  const fresh = await call(window.api.loans.reminders());
  if (!fresh) {
    return toast('Степените на напомнянията не можаха да бъдат прочетени — писмата не са отпечатани, '
      + 'за да не бъдат вписани с грешна степен. Опитайте отново.', 'err');
  }
  const levels = {};
  for (const r of fresh) levels[r.reader_id] = r.level || 1;
  // v2.2.0: вписва се ЧАК след потвърден печат (или запис в PDF). От v1.71.0
  // doPrint() само отваря преглед с бутон „Отказ“ — дотогава при отказ в
  // регистъра вече стоеше „изпратено напомняне“ на всички просрочили читатели
  // и следващото напомняне тръгваше от грешна степен.
  /* Всяко вписване се изчаква и проверява. Дотук беше forEach без await и без
     поглед към резултата: заета от друга станция база или изтрит междувременно
     читател проваляха записа напълно безмълвно — писмата излизат от принтера и
     отиват при читателите, а в регистъра няма и следа, тоест следващото напомняне
     тръгва пак от ниво 1. try/catch в извикващия също не помагаше: forEach връща
     undefined синхронно и отказаният promise няма как да стигне дотам.
     Съобщението е едно, обобщено — не по едно на читател. */
  const logNotices = async () => {
    let failed = 0;
    for (const r of rows) {
      try {
        const res = await window.api.notices.log({
          reader_id: r.reader_id, level: levels[r.reader_id] || 1, channel: 'печат', loans_count: r.n
        });
        if (!res || !res.ok) failed++;
      } catch (e) { failed++; }
    }
    if (failed) {
      toast(failed + ' от ' + pl(rows.length, 'напомняне', 'напомняния') + (failed === 1 ? ' не се вписа' : ' не се вписаха') + ' в регистъра — писмата са '
        + 'отпечатани, но следващият път ще тръгнат от същата степен.', 'err');
    }
  };
  /* Ставката се вмъкваше сурова: при празни настройки писмото печаташе буквално
     „undefined лв./ден“, а при изчистено поле — празно място точно преди цитата на
     наредбата. Празното поле е обичайният случай: полето е числово, а въведена
     българска десетична ЗАПЕТАЯ го оставя празно (и тогава обезщетение изобщо не
     се начислява, докато библиотеката смята, че е настроила ставка). Ако ставка
     няма, скобата отпада изцяло — сумата остава, обяснението не се измисля. */
  const perDayNum = Number(s.fine_per_day);
  const perDay = Number.isFinite(perDayNum) && perDayNum > 0 ? perDayNum.toFixed(2) : '';
  /* Степента се ПЕЧАТА, а не само се вписва. Одит на документите v2.4.17: писмото
     беше едно и също на степени 1, 2 и 3, докато в регистъра се вписваше ескалация,
     за която читателят никога не е бил уведомен — а хартиеният канал обслужва точно
     читателите без имейл, тоест тези, които виждат само текста от степен 1. Текстът
     е същият като в имейла (LEVEL_LINES в handlers/notices.js). */
  const levelLine = (lv) => lv === 2
    ? '<div class="pmeta"><b>Това е ВТОРО напомняне.</b></div>'
    : lv === 3
      ? '<div class="pmeta"><b>Това е ТРЕТО напомняне.</b> При ново неизпълнение достъпът до заемане ще бъде временно преустановен.</div>'
      : '';
  setPrintPage({ name: 'Напомнителни писма — ' + bg(today()), landscape: false, margin: '14mm 12mm' });
  doPrint(rows.map(r => `<div class="pdoc">${shead()}
    <h2>НАПОМНИТЕЛНО ПИСМО</h2>
    <div class="pmeta">До: <b>${esc(r.name)}</b><br>
    Адрес: ${esc(r.address2 || r.address || '…………………')}<br><br>
    Уважаеми/а читателю,<br><br>
    Съгласно чл. 43, ал. 1 от Наредба № 3 от 18.11.2014 г. всеки ползвател е длъжен да върне заетите библиотечни документи
    в определения срок. Според нашата документация срокът на изброените по-долу документи е изтекъл.</div>
    <table><thead><tr><th>Инв. №</th><th>Заглавие</th><th>Зает на</th><th>Срок</th></tr></thead><tbody>
    ${r.loans.map(l => `<tr><td>${l.inv_number ?? ''}</td><td>${esc(l.title)}</td><td>${bg(l.date_out)}</td><td>${bg(l.date_due)}</td></tr>`).join('')}
    </tbody></table>
    ${levelLine(levels[r.reader_id] || 1)}
    <div class="pmeta">Общо дължимо обезщетение: <b>${mny(r.fine)}</b>${perDay
      ? ` (${esc(perDay)} лв./ден забава съгласно Правилата за обслужване на читателите на библиотеката,
        приети на основание чл. 43, ал. 2 от Наредба № 3 от 18.11.2014 г.)` : ''}.</div>
    ${ssig(['Библиотекар: ' + esc(s.librarian || '…………………')])}</div>`).join(''), null, logNotices);
}
window.printOverdueNotices = printOverdueNotices;
