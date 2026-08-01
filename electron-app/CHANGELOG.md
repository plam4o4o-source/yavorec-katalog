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
