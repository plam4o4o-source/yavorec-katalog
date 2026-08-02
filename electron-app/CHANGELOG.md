# Промени / Changelog

Всяко издание по-долу съответства на git таг `vX.Y.Z`. Текстът тук се
показва автоматично в описанието на съответното GitHub Release
(`.github/workflows/release-electron.yml`). По-старите версии (преди
v1.13.7) не са описани тук в детайли — вижте историята на commit-ите в
GitHub за пълни подробности.

Each entry below corresponds to a git tag `vX.Y.Z`. This text is copied
automatically into the matching GitHub Release description. Versions before
v1.13.7 are not documented here in detail — see the GitHub commit history
for full detail.

## v1.16.0

**Промени — надграден онлайн каталог (програма + страница на сайта):**
- **Витрини в каталога** — ръчно подбрани тематични списъци („Лято 2026",
  „Краезнание"…), управлявани в „Онлайн каталог" → „Витрини в каталога".
  Книги се добавят по инв. №/баркод или групово от „Книги" (отметките →
  нов бутон „Във витрина…"). На сайта витрините се показват като бутони над
  резултатите. Отчислена или служебна книга отпада от витрината автоматично.
- **„Нови постъпления" на сайта** — всеки запис в katalog.json вече носи
  датата си на постъпване; страницата сама показва зелен бутон
  „✦ Нови постъпления" (последните 60 дни) и значка „нова" на скорошните
  записи, подредени от най-новите надолу.
- **Умни филтри на сайта** — падащите менюта „вид" и „отдел" вече се строят
  от самите данни, а не от закован списък: публичните надписи от
  номенклатурите (v1.15.0) и всеки бъдещ нов отдел се появяват сами, без да
  се пипа страницата.
- Обновената страница е в `site/page-katalog.html` в хранилището; работи и
  със стар katalog.json (без витрини/дати) — новите елементи просто не се
  показват, така че редът на качване няма значение.

**Changes — upgraded online catalog (app + website page):**
- **Catalog showcases** — hand-picked thematic lists ("Summer 2026", "Local
  history"…), managed under "Online catalog" → "Showcases". Books are added
  by inv. no./barcode or in bulk from "Books" (checkboxes → new "To
  showcase…" button). The site shows showcases as buttons above the results.
  Withdrawn or staff-only books drop out of showcases automatically.
- **"New arrivals" on the site** — every katalog.json record now carries its
  accession date; the page itself shows a green "✦ New arrivals" button
  (last 60 days) and a "new" badge on recent records, sorted newest first.
- **Smart site filters** — the "type" and "department" dropdowns are now
  built from the data itself instead of a hardcoded list: public labels from
  the authorised values (v1.15.0) and any future department appear on their
  own, with no page edits.
- The upgraded page lives at `site/page-katalog.html` in the repository; it
  also works with an old katalog.json (no showcases/dates) — the new
  elements simply stay hidden, so upload order doesn't matter.

## v1.15.0

**Промени — голяма партида подобрения по модела на Koha ILS:**
- **Желязна защита срещу двойно заемане** — правилото „активните заемания не
  надвишават наличните бройки" вече се пази на ниво база данни (тригер), а не
  само в интерфейса. Отчита правилно заглавия с няколко екземпляра.
- **Поток от събития** — всяко заемане, връщане, подновяване, ползване в
  читалня и посещение по домовете се записва в регистър на събитията. Нов
  бутон „⚡ Предложи от регистрите" във формуляра за ден от Дневника попълва
  празните полета (Раздел Б по вид/език/съдържание, посещения) с изведени от
  регистрите числа — ръчно въведеното никога не се презаписва, официалният
  формуляр остава меродавен. Нов бутон „📖 Читалня +1" в „Заемане и връщане"
  отбелязва ползване на място.
- **Три степени на напомнянията + наказание в дни** — степента (1/2/3) расте
  с давността на просрочието (прагове в Настройки), текстът се покачва по тон,
  а всяко отпечатано/копирано/изпратено напомняне се регистрира, за да се
  вижда „последно: № 2 · 12.05". По желание: N дни без право на заемане за
  всеки ден забава (с таван) — по-приложимо за читалищна библиотека от глоба
  в стотинки; наказанието се вижда и се сваля от картона на читателя.
- **Номенклатури** — контролирани списъци за отдел, език и постоянно място
  (Настройки → „Номенклатури"), с незадължителен публичен надпис за онлайн
  каталога (вътрешно „краеведски", публично „Краезнание").
- **Правилно сортиране на сигнатури** — „Ч-9" вече се нарежда преди „Ч-84";
  нов избор на подредба (заглавие/сигнатура/инв. №) в „Книги".
- **Датирани статуси и „последно видяна"** — смяната на състояние помни
  датата си; сканирането при инвентаризация попълва „последно видяна" за
  всеки екземпляр (заварените данни се пренасят от минали инвентаризации).
  Ново поле „Постоянно място" пази рафта при временно преместване на витрина.
- **Лични данни (ЗЗЛД/GDPR)** — съгласията на читателите вече са с дата;
  върнати заемания, по-стари от зададен срок, се анонимизират с бутон
  (остава „категория · година", името изчезва). Изключено по подразбиране.
- **Обслужване по домовете** — график (ден/честота) и дневник на посещенията
  за читатели, които не могат да идват сами; посещенията влизат автоматично
  в предложенията за колоната „В заемна за дома" на Дневника.
- **„За днес" на таблото** — работният списък на библиотекаря: наближаващи
  падежи, дължими пререгистрации, просрочия над 60 дни (кандидати за
  „липсваща"), читатели с наказание, записи за анонимизиране.

**Changes — a large batch of Koha-ILS-inspired improvements:**
- **Hard double-checkout protection** — "active loans never exceed available
  copies" is now enforced at the database level (trigger), not just in the
  UI. Correctly handles multi-copy titles.
- **Event stream** — every checkout, return, renewal, reading-room use and
  home visit is recorded in an append-only event log. A new "⚡ Suggest from
  records" button in the daily journal form fills empty fields (Section B by
  type/language/content, visits) with derived numbers — manually entered
  values are never overwritten. A new "📖 Reading room +1" button logs
  on-site use.
- **Three-level notices + suspension days** — the notice level (1/2/3) grows
  with the age of the overdue (thresholds in Settings), the tone escalates,
  and every printed/copied/emailed notice is logged so you can see
  "last: #2 · 12.05". Optional: N days of suspended borrowing per day late
  (capped) — more practical for a village library than tiny fines; the
  suspension is visible and removable from the reader's record.
- **Authorised values** — controlled lists for department, language and
  permanent location (Settings → "Nomenclatures"), with an optional public
  label used by the online catalog.
- **Proper call-number sorting** — "Ч-9" now sorts before "Ч-84"; new sort
  selector (title/call number/inv. no.) in "Books".
- **Dated statuses and "last seen"** — status changes remember their date;
  inventory scanning stamps "last seen" per copy (backfilled from past
  inventory sessions). New "permanent location" field preserves the shelf
  during temporary display moves.
- **Personal data (GDPR)** — reader consents now carry dates; returned loans
  older than a configurable threshold can be anonymized with a button
  (leaving "category · year", the name disappears). Off by default.
- **Housebound service** — a schedule (day/frequency) and visit log for
  readers who cannot come in person; visits feed the journal's
  "home lending" column suggestions automatically.
- **"For today" on the dashboard** — the librarian's working list: upcoming
  due dates, re-registrations due, 60+ day overdues (candidates for "lost"),
  currently suspended readers, records awaiting anonymization.

## v1.14.3

**Промени:**
- **Групова редакция на книги** — в „Книги" вече може да маркирате няколко записа
  (отметки в първата колона, „избери всички" в заглавието) и да смените едно поле
  (отдел/местонахождение, състояние, категория или език) на всички едновременно —
  вместо да отваряте всеки запис поотделно. Изрично изключено от груповата редакция:
  смяна на състояние на „отчислен" — отчисляването минава само през формален акт
  (раздел „Отчисляване"), а вече отчислени документи не се засягат от груповата
  редакция дори да са маркирани.
- **Готови справки** — нов раздел „Готови справки" в „Отчети": списък с
  предварително подготвени, избираеми от падащо меню отчети, всеки готов за печат/PDF —
  годишен статистически отчет (Раздел А и Б, обобщение на дневника на библиотеката),
  фонд по отдели/категории/езици, читатели по възрастови категории, движение на фонда
  (постъпления и отчисления по вид/причина) и обобщение на междубиблиотечното заемане.
  Отчетите съответстват на данните, които читалищна библиотека реално подава към
  регионалната библиотека и Министерството на културата.

**Changes:**
- **Batch book editing** — "Books" now supports selecting multiple records (checkboxes
  in the first column, a "select all" box in the header) and changing one field
  (department/location, status, category, or language) on all of them at once, instead
  of opening each record individually. Deliberately excluded from batch editing: setting
  status to "written off" — write-offs go through a formal act only (the "Deaccession"
  section), and already written-off items are skipped by batch edits even if selected.
- **Ready-made reports** — a new "Ready-made reports" section under "Reports": a
  dropdown-selectable list of pre-built, print/PDF-ready reports — the annual statistical
  report (Sections A and B, aggregated from the library's daily journal), fund breakdown
  by department/category/language, readers by age category, fund movement (acquisitions
  and write-offs by type/reason), and an inter-library loan summary. These match what a
  library actually submits to the regional library and the Ministry of Culture.

## v1.14.2

**Промени:**
- **Гарант за читатели под 14 г.** — формулярът за читател показва поле за
  родител/настойник (име, отношение, телефон) при избрана категория
  „дете до 14 г.“; задължително при запис. Гарантът се вижда в „Заемане и
  връщане“ до името на детето и на разпечатания читателски картон.
- **Редактируеми шаблони за напомняния** — писмото, темата и SMS текстът за
  просрочени материали вече се редактират в Настройки → „Шаблони за
  напомняния“, с плейсхолдъри като `{reader}`, `{library}`, `{list}`,
  `{fine_line}`. Празен шаблон = текстът по подразбиране (без промяна за
  инсталации, които не са го пипали); бутон връща стойностите по подразбиране.
- **Внасяне на MARC записи през SRU** — нов бутон „SRU…“ до търсенето по
  ISBN в „Книги“ изтегля истински библиотечен MARC запис (заглавие, автор,
  издателство, година, страници, език, предметни рубрики) вместо търговски
  метаданни. По подразбиране ползва публичния каталог на Library of
  Congress (без регистрация); адресът на SRU сървъра се сменя в Настройки
  — готово да проработи веднага, ако библиотеката получи достъп до
  SRU/Z39.50 на НБКМ или COBISS (изискват подписано споразумение,
  недостъпно засега за автоматично внасяне).

**Changes:**
- **Guarantor for readers under 14** — the reader form shows a
  parent/guardian field (name, relation, phone) when category "child under
  14" is selected; required on save. The guarantor shows up in
  "Circulation" next to the child's name and on the printed reader card.
- **Editable notice templates** — the overdue-notice email subject, body,
  and SMS text are now editable under Settings → "Notice templates", with
  placeholders like `{reader}`, `{library}`, `{list}`, `{fine_line}`. An
  empty template falls back to the previous default text (no change for
  installs that never touch it); a button resets to defaults.
- **MARC record import via SRU** — a new "SRU…" button next to the ISBN
  search in "Books" imports a real library MARC record (title, author,
  publisher, year, pages, language, subject headings) instead of
  commercial metadata. Defaults to the public Library of Congress catalog
  (no signup); the SRU server address is configurable in Settings — ready
  to work immediately if the library gets SRU/Z39.50 access to the
  Bulgarian national library or COBISS (both require a signed agreement,
  not available for automatic import yet).

## v1.14.1

**Промени:**
- **Резервации на заети книги** — читател чака книга, която в момента е заета:
  „Заемане и връщане" → „Резервирай заета книга…". При връщането ѝ програмата
  предупреждава изрично „НЕ връщайте на рафта" и показва за кого е заделена;
  екземплярът не се предлага за ново заемане, докато чакащият не я вземе или
  резервацията не бъде отказана. Нов раздел „Резервации" в „Заемане и
  връщане" показва цялата опашка; ново поле на таблото при активни
  резервации.
- **Подновяване с брояч и лимит** — заемането пази колко пъти е продължавано;
  настройката „Брой удължавания" в Настройки (вече съществуваше) сега реално
  ограничава бутона „Продължи", вместо да е без значение. Продължение е
  невъзможно, ако книгата е резервирана от друг читател.

**Changes:**
- **Holds on checked-out books** — a reader can wait for a book that is
  currently on loan: "Circulation" → "Reserve a checked-out book…". On
  return, the app explicitly warns "DO NOT reshelve" and names who it's
  held for; the copy isn't offered for checkout again until the waiting
  reader picks it up or the hold is cancelled. A new "Holds" tab under
  "Circulation" lists the full queue; a new dashboard tile appears when
  holds are active.
- **Renewals with a counter and a cap** — a loan now tracks how many times
  it has been renewed; the existing "renewal count" setting now actually
  limits the "Renew" button instead of being ignored. Renewal is blocked if
  the book is held for another reader.

## v1.14.0

**Промени — цялостно графично освежаване:**
- Горната лента със заглавието остава залепена при превъртане, с бронзова
  чертица под заглавието на раздела.
- Единен бронзов фокус за всички полета за писане и клавиатурна навигация.
- Плавни преходи и леко „повдигане“ при посочване на бутони, бързи
  действия и картички; натиснатият бутон реагира осезаемо.
- Таблиците с леки редуващи се редове („зебра“) за по-лесно четене на
  дългите регистри, заоблена рамка и мека сянка.
- Прозорците се отварят с кратка анимация, имат бронзов кант отгоре и
  замъглен фон зад себе си; бутонът за затваряне е с ясно поле.
- Известията се появяват с плъзгане и имат цветен кант по вида си.
- Стилизирани скролбари и в светлата част (тъмните в менюто са от 1.13.9).
- Заглавията на картичките в таблото с малък бронзов маркер.
- Всичко стъпва на цветовите променливи — важи за шестте теми.

**Changes — app-wide visual refresh:**
- Sticky top bar with a brass underline beneath the section title.
- Unified brass focus ring for all text inputs and keyboard navigation.
- Smooth transitions and a subtle hover lift on buttons, quick actions and
  cards; pressed buttons respond tactilely.
- Tables get zebra striping for long registers, rounded borders and a soft
  shadow.
- Modals open with a short animation, carry a brass top accent and blur
  the background; the close button has a clear hit area.
- Toasts slide in and carry a colored accent per type.
- Styled scrollbars in the light area too (dark rail ones shipped in 1.13.9).
- Dashboard card headings get a small brass marker.
- Everything uses the theme variables — consistent across all six themes.

## v1.13.9

**Промени:**
- Обновено странично меню: икона пред всеки раздел, заоблени редове с
  плавен преход при посочване, по-отчетлив активен раздел с бронзов кант,
  разделителна линия след заглавието на всяка група и дискретен тъмен
  скролбар в лентата. Работи и в шестте цветови теми.

**Changes:**
- Refreshed sidebar menu: an icon for every section, rounded rows with a
  smooth hover transition, a clearer active item with a brass accent,
  a divider line after each group heading, and a subtle dark scrollbar in
  the rail. Works across all six color themes.

## v1.13.8

_(Тагът `v1.13.7` остана със заклещено празно издание в GitHub заради
надпревара между два едновременни build-а и не може да бъде презаписан от
тази сесия — вижте бележката по-долу. Съдържанието по-долу е идентично с
това, което трябваше да излезе като 1.13.7.)_

_(The `v1.13.7` tag ended up with a stuck empty GitHub Release due to a race
between two simultaneous builds, and this session cannot overwrite it — see
note below. The content below is identical to what was meant to ship as
1.13.7.)_

**Промени:**
- Общ преглед на README вече и на английски език, в допълнение към
  българския.
- Лицензът (GPL-3.0) вече има и неофициален превод на български —
  `LICENSE.bg.md`; оригиналният, юридически меродавен текст на английски
  остава недокоснат в `LICENSE`.
- Описанието на всяко бъдещо издание в GitHub Releases вече се попълва
  автоматично от този файл.

**Changes:**
- The README overview is now available in English in addition to
  Bulgarian.
- The license (GPL-3.0) now has an unofficial Bulgarian reference
  translation — `LICENSE.bg.md`; the original, legally authoritative
  English text remains unchanged in `LICENSE`.
- Every future release's GitHub Releases description is now filled in
  automatically from this file.

## v1.13.6

**Промени:**
- Лицензът е сменен от собственически на GNU GPL-3.0, за да отговаря на
  условията за безплатно подписване на код чрез SignPath Foundation.
- Премахнат Azure Trusted Signing (акаунт, кука, стъпки в build workflow-а)
  след неуспешна организационна проверка на самоличността.
- Оправени всички остатъчни текстове „Всички права запазени“ в
  `package.json`, README и footer текста в самата програма.

**Changes:**
- License changed from proprietary to GNU GPL-3.0, to meet the
  requirements for free code signing via SignPath Foundation.
- Removed Azure Trusted Signing (account, build hook, workflow steps)
  after the organization identity validation failed.
- Fixed all remaining "all rights reserved" text in `package.json`, the
  README, and the in-app footer credit.
