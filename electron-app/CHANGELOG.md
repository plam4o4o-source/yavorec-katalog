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

## v1.61.0

**BG:** Изравнява лицензионната формулировка навсякъде към
**GPL-3.0-or-later** — решение, взето от автора, след разминаване, отбелязано
при писането на документацията (Фаза 5): `package.json` → `"license"` вече
отдавна декларираше `"GPL-3.0-or-later"`, докато README текстовете, кредитния
надпис в самата програма и `package.json` → `"copyright"` говореха само за
„GPL-3.0“ (без „or later“) — реално разминаване в избора на лиценз, не само в
текста. Поправено: `electron-app/README.md` (пет места, плюс нова изрична
бележка „This program is free software...“ по образеца на GPL), кредитният
надпис в програмата (`src/app.js` → `APP_CREDIT_TEXT`, вижда се долу вляво в
менюто и в „Настройки“), и `package.json` → `"copyright"`.
`LICENSE.bg.md` НЕ е пипнат — той е превод на самия текст на GPL версия 3 и
остава коректен независимо от избора „или по-нова версия“, който е решение
на носителя на авторските права, не свойство на самия текст на лиценза.
Няма промяна в поведението на програмата — само текст.

**EN:** Aligns the license wording everywhere to **GPL-3.0-or-later** — a
decision made by the author, after a mismatch flagged while writing the
documentation (Phase 5): `package.json` → `"license"` had long declared
`"GPL-3.0-or-later"`, while the README prose, the in-app credit line, and
`package.json` → `"copyright"` all said only "GPL-3.0" (without "or later")
— a real mismatch in the license election itself, not just wording. Fixed:
`electron-app/README.md` (five spots, plus a new explicit "This program is
free software..." notice following the standard GPL template), the in-app
credit text (`src/app.js` → `APP_CREDIT_TEXT`, shown bottom-left in the nav
and in "Settings"), and `package.json` → `"copyright"`. `LICENSE.bg.md` was
NOT touched — it is a translation of the GPL version 3 text itself and
remains accurate regardless of the "or later" election, which is the
copyright holder's choice, not a property of the license text. No behavior
change — text only.

## v1.60.0

**BG:** Отделен bug-fix commit (както беше препоръчано в бележките към
v1.58.0/`patches-batch6`): поправя стария бъг във вноса на данни от други
системи (`import:run`, `handlers/data-import.js`). При по-задълбочена
проверка на всичките 28 полета от `BOOK_FIELDS` срещу payload литерала се
оказа, че липсват НЕ едно, а **три** полета — `permanent_location`,
`status_date` и `cn_sort` — само първото (по реда в `BOOK_FIELDS`) стигаше
до съобщението `Missing named parameter`, докато не се поправеше;
поправянето само на `permanent_location` би довело до същата грешка на
следващото липсващо поле. Резултатът досега: better-sqlite3 хвърляше тази
грешка за ВСЕКИ ред при всеки внос — функцията "Приемане на данни от
други системи" не е работила изобщо, откакто `permanent_location` е
добавено към `BOOK_FIELDS`. Поправка: `permanent_location` е `null`
(незадължително поле, огледало `bookPayload()` в `handlers/books.js` за
нов запис), `status_date` е днешна дата (`today()`, вече подаван като
зависимост от `main.js`), `cn_sort` се смята от сигнатурата чрез
`cnSortKey()` (също подадена зависимост), ако е налична. Тестът, който
преди документираше счупеното поведение
(`test/handlers-data-import.test.js`), сега е регресионен тест, който
проверява, че редът реално се записва с очакваните стойности. Общо 418
теста (без промяна в броя — старите два теста са заменени, не добавени).

**EN:** A dedicated bug-fix commit (as recommended in the v1.58.0/
`patches-batch6` notes): fixes the long-standing data-import bug
(`import:run`, `handlers/data-import.js`). A closer check of all 28
fields in `BOOK_FIELDS` against the payload literal found that NOT one
but **three** fields were missing — `permanent_location`, `status_date`,
and `cn_sort` — only the first (by `BOOK_FIELDS` order) ever surfaced in
the `Missing named parameter` message, so fixing only
`permanent_location` would have hit the same error on the next missing
field. The result until now: better-sqlite3 threw this error for EVERY
row on every import — the "data import from other systems" feature had
not worked at all since `permanent_location` was added to `BOOK_FIELDS`.
Fix: `permanent_location` is `null` (an optional field, mirroring
`bookPayload()` in `handlers/books.js` for a new record), `status_date` is
today's date (`today()`, now passed in as a dependency from `main.js`),
and `cn_sort` is computed from the call number via `cnSortKey()` (also a
passed-in dependency) when available. The test that used to document the
broken behavior (`test/handlers-data-import.test.js`) is now a regression
test verifying the row is actually inserted with the expected values. 418
tests total (unchanged count — the two old tests were replaced, not
added to).

## v1.59.0

**BG:** Последната точка от "евтините поправки" на Фаза 4 анализа:
"CHECK/authority на enum-подобните TEXT колони". Истински SQLite `CHECK`
constraint не може да се добави с `ALTER TABLE` към съществуваща таблица —
изисква пълно пресъздаване (нова таблица + копиране на данните + `DROP` +
`RENAME`), рисковано върху вече работеща база с непозната „мръсна“
история (същата причина, поради която v4 нарочно НЕ сложи `UNIQUE` на
`books.barcode`). Затова тук — по образец на вече съществуващия
`trg_loans_capacity` в `db/schema.sql` — нов модул `db/enum-triggers.js`
(споделен и от миграцията, и от тестовете, по образец на
`BOOKS_FTS_SETUP_SQL`) добавя само `BEFORE INSERT`/`UPDATE` тригери, които
ограничават единствено БЪДЕЩИ записи; нищо съществуващо не се пипа.
Приложено (миграция v5) за 16 колони в 11 таблици: `books.status`,
`readers.status`, `holds.status`, `suggestions.status`,
`account_lines.kind`, `mzs_requests.direction/status`,
`links.from_kind/to_kind`, `analytics.source_kind`, `chronicle.category`,
`acquisitions.how`, `events.kind`, `notice_log.channel`,
`housebound_profiles.frequency`, `periodicals.freq`. Всеки списък
стойности е извлечен от истинския избор в `src/app.js`, НЕ от
коментарите в `db/schema.sql` — двете вече се бяха разминали на две
места: `books.status` в коментара нямаше „отчислен“ (задава се от
`handlers/deaccession-acts.js`), а `chronicle.category` в коментара нямаше
„юбилей“ (`CHR_CATS` в `src/app.js`). Нарочно ИЗКЛЮЧЕНИ (не са рутинен
fixed enum): `readers.category` (обвързана с редактируемата от
библиотекаря `circulation_rules.category`; `handlers/gdpr.js` пише
буквално „—“ за анонимизирания служебен читател), `books.department`/
`language` и `periodicals.department` (управляват се от
`authorised_values`, разширяема номенклатура), `inventory_sessions.scope`
(обикновено текстово поле). Нов тест: `test/db-enum-triggers.test.js` (6
теста, покриват всички 16 колони) — общо 418 теста (бяха 412).

**EN:** The last item from Phase 4's "cheap fixes" analysis:
"CHECK/authority on enum-like TEXT columns". A real SQLite `CHECK`
constraint can't be added to an existing table via `ALTER TABLE` — it
requires a full table rebuild (new table + copy data + `DROP` +
`RENAME`), risky on a live database with unknown "dirty" legacy history
(the same reason v4 deliberately did NOT add a `UNIQUE` constraint on
`books.barcode`). So, following the existing `trg_loans_capacity` pattern
in `db/schema.sql`, a new module `db/enum-triggers.js` (shared by both the
migration and the tests, the same reuse pattern as
`BOOKS_FTS_SETUP_SQL`) adds only `BEFORE INSERT`/`UPDATE` triggers that
constrain only FUTURE writes; nothing existing is touched. Applied
(migration v5) to 16 columns across 11 tables: `books.status`,
`readers.status`, `holds.status`, `suggestions.status`,
`account_lines.kind`, `mzs_requests.direction/status`,
`links.from_kind/to_kind`, `analytics.source_kind`, `chronicle.category`,
`acquisitions.how`, `events.kind`, `notice_log.channel`,
`housebound_profiles.frequency`, `periodicals.freq`. Every value list was
extracted from the real choices in `src/app.js`, NOT from the comments in
`db/schema.sql` — the two had already drifted apart in two places:
`books.status`'s comment was missing `"отчислен"` (set by
`handlers/deaccession-acts.js`), and `chronicle.category`'s comment was
missing `"юбилей"` (`CHR_CATS` in `src/app.js`). Deliberately EXCLUDED
(not a routine fixed enum): `readers.category` (tied to the
librarian-editable `circulation_rules.category`; `handlers/gdpr.js`
writes the literal `"—"` for the anonymised placeholder reader),
`books.department`/`language` and `periodicals.department` (driven by
`authorised_values`, an extensible nomenclature), `inventory_sessions.scope`
(a plain text field). New test file: `test/db-enum-triggers.test.js` (6
tests, covering all 16 columns) — 418 tests total (up from 412).

## v1.58.0

**BG:** Завършва разбиването на `main.js` по домейни (Фаза 4, стъпка 36 —
последната планирана партида): "Приемане на данни от други системи" (стар
АБ/iLib/Excel внос) е изнесено в `handlers/data-import.js`
(`import:load/choose/run`, вътрешно ползва `require('../importers')` пряко,
както при `backup-crypto` в `handlers/backup.js`); "Мобилно сканиране"
(страница за телефон вместо RFID четец) — в `handlers/mobile.js`
(`mobile:generate`, `inventorySessions:importScans`); "Помощ срещу
антивирусни блокировки" (генериране на `.bat` с изключения за Windows
Defender) — в `handlers/security-exclusions.js`
(`security:exclusionInfo/writeExclusionScript`). И трите модула четат
`BOOK_FIELDS` по референция от по-рано извадения `handlers/books.js`. IPC
поведението е напълно непроменено. Нови тестове:
`test/handlers-data-import.test.js` (8), `test/handlers-mobile.test.js` (6),
`test/handlers-security-exclusions.test.js` (6) — общо 412 теста (бяха
392).

С това `main.js` вече съдържа само трайна инфраструктура, а не отделни
домейни: жизненият цикъл на приложението (`app.whenReady`,
`window-all-closed`, `app:setUser/getUser/getVersion/
checkForUpdates/installUpdate/openLogsFolder`), автообновяването,
инициализацията/миграциите на базата данни (`initDb`, `ensureColumns`,
`MIGRATIONS`), `createWindow()`, помощните функции `run`/`logAudit`/
`diffFields`/`friendlyDbError`, както и вече установените изключения от
общото правило за преместване, поддържани заради TDZ капана:
`logEvent`, `scheduleCatalogWrite`/`flushCatalogWrite`/`buildCatalogPayload`
и `settings:noticeDefaults`. С това Фаза 4 (разбиването на монолита
`main.js` на модули по домейн под `handlers/`) е завършена.

**ВАЖНО — открит стар бъг, НЕ въведен от това разбиване:** докато пишех
тестовете за `import:run`, установих (и потвърдих чрез `git log -p --
follow -S"permanent_location"`), че полето `permanent_location` е добавено
към `BOOK_FIELDS` в по-стар commit, но обектът с данните за внос никога не
е бил обновен да го включва. Резултатът: SQL заявката за вмъкване очаква
именуван параметър `permanent_location`, който липсва — better-sqlite3
хвърля грешка `Missing named parameter "permanent_location"` за ВСЕКИ ред
при всеки внос, тихо прихваната от try/catch на реда и записана като
грешка за него. С други думи функцията "Приемане на данни от други
системи" не работи изобщо от момента на добавянето на това поле. По
правилото "без промяна на поведението по време на механично изнасяне" не
го поправих тук — запазих го точно както си е, с подробен коментар в
`test/handlers-data-import.test.js`, документиращ бъга. Нужен е отделен,
самостоятелен commit само за тази поправка.

**EN:** Completes splitting `main.js` by domain (Phase 4, step 36 — the
last planned batch): "data import from other systems" (legacy АБ/iLib/
Excel import) moves to `handlers/data-import.js`
(`import:load/choose/run`, internally `require('../importers')` directly,
same pattern as `backup-crypto` in `handlers/backup.js`); "mobile
scanning" (a phone page instead of an RFID reader) moves to
`handlers/mobile.js` (`mobile:generate`, `inventorySessions:importScans`);
"antivirus exclusion help" (generates a `.bat` with Windows Defender
exclusions) moves to `handlers/security-exclusions.js`
(`security:exclusionInfo/writeExclusionScript`). All three modules read
`BOOK_FIELDS` by reference from the earlier-extracted `handlers/books.js`.
IPC behavior is fully unchanged. New test files:
`test/handlers-data-import.test.js` (8), `test/handlers-mobile.test.js`
(6), `test/handlers-security-exclusions.test.js` (6) — 412 tests total (up
from 392).

With this, `main.js` now holds only permanent infrastructure, not
individual domains: app lifecycle (`app.whenReady`, `window-all-closed`,
`app:setUser/getUser/getVersion/checkForUpdates/installUpdate/
openLogsFolder`), auto-update, database init/migrations (`initDb`,
`ensureColumns`, `MIGRATIONS`), `createWindow()`, the shared helpers
`run`/`logAudit`/`diffFields`/`friendlyDbError`, and the already-
established exceptions to the move-everything rule kept in place because
of the TDZ hazard: `logEvent`, `scheduleCatalogWrite`/
`flushCatalogWrite`/`buildCatalogPayload`, and `settings:noticeDefaults`.
With this, Phase 4 (splitting the `main.js` monolith into per-domain
modules under `handlers/`) is complete.

**IMPORTANT — pre-existing bug found, NOT introduced by this split:**
while writing tests for `import:run`, I found (and confirmed via `git log
-p --follow -S"permanent_location"`) that `permanent_location` was added
to `BOOK_FIELDS` in an older commit, but the import payload object was
never updated to include it. Result: the INSERT statement expects a named
parameter `permanent_location` that's missing — better-sqlite3 throws
`Missing named parameter "permanent_location"` for EVERY row on every
import, silently caught by that row's try/catch and recorded as a
per-line error. In other words, the "data import from other systems"
feature has not worked at all since that field was added. Per the "no
behavior change during mechanical extraction" rule, I did not fix it here
— preserved exactly as-is, with a detailed comment in
`test/handlers-data-import.test.js` documenting the bug. A separate,
dedicated commit is needed just for that fix.

## v1.57.0

**BG:** Продължава разбиването на `main.js` след "големите пет" (Фаза 4,
стъпка 35): "Защита на лични данни: ЕГН/№ ЛК" (обща парола, AES-256-GCM) е
изнесено в `handlers/pdp.js` — 5 handler-а: `pdp:status/setup/unlock/lock/
changePassword`. `maskReaderRow`/`maskReaderRows`/`preparePiiForWrite` се
връщат обратно към `main.js`, защото `handlers/readers.js` (извадено
по-рано) вече ги ползва по референция. `PDP_KEY` (ключът, отключен само за
текущата сесия на процеса, никога на диск) остава изцяло вътрешно състояние
на новия модул. Премахнат е и неизползваният вече `const pii = require(...)`
в горната част на `main.js`. IPC поведението е напълно непроменено. Нов
тест: `test/handlers-pdp.test.js` (11 теста) — общо 392 теста (бяха 381).

**EN:** Continues splitting `main.js` past the "big five" (Phase 4, step
35): the "personal data protection: EGN/ID card number" domain (shared
password, AES-256-GCM) moves to `handlers/pdp.js` — 5 handlers:
`pdp:status/setup/unlock/lock/changePassword`. `maskReaderRow`/
`maskReaderRows`/`preparePiiForWrite` are returned back to `main.js`, since
`handlers/readers.js` (extracted earlier) already depends on them by
reference. `PDP_KEY` (the key, unlocked only for the current process
session, never written to disk) stays entirely internal to the new module.
Also removed the now-unused `const pii = require(...)` near the top of
`main.js`. IPC behavior is fully unchanged. New test file
`test/handlers-pdp.test.js` (11 tests) — 392 tests total (up from 381).

## v1.56.0

**BG:** Продължава разбиването на `main.js` (Фаза 4, стъпка 34 — последният
от "големите пет"): "Книги" (фондът) и вложеният в същата секция "Лимит на
броя записи" са изнесени в `handlers/books.js` — 9 handler-а
(`books:list/get/byBarcode/create/update/delete/bulkUpdate/addCheck/checks`)
плюс `limits:usage/update`. `BOOK_SELECT`/`BOOK_FIELDS`/`checkRecordLimit` се
връщат обратно към `main.js`, защото по-рано извадени модули
(`acquisitions.js`, `deaccession-acts.js`, `loans.js`, `catalog.js`,
`readers.js`) вече ги ползват по пряка референция в обект, подаден на техния
`require()`, изпълнен СЛЕД мястото на `handlers/books.js` — същият модел на
връщане напред, установен за `LOAN_SELECT`/`firstActiveHold`. IPC
поведението е напълно непроменено. Нов тест: `test/handlers-books.test.js`
(11 теста) — общо 381 теста (бяха 370).

С това всичките "големи пет" (заемания, каталог, справки, настройки, книги)
и всички по-малки домейни от първоначалния план са извадени от `main.js` —
остават само дневникът/краеведските модули (вече извадени в предишни
версии), внасянето от други системи и мобилният импорт на сканирано (виж
статуса на Фаза 4 в предишните записи).

**EN:** Continues splitting `main.js` (Phase 4, step 34 — the last of the
"big five"): the "books" (fund) domain, along with the "record count limit"
sub-section nested in the same block, moves to `handlers/books.js` — 9
handlers (`books:list/get/byBarcode/create/update/delete/bulkUpdate/
addCheck/checks`) plus `limits:usage/update`. `BOOK_SELECT`/`BOOK_FIELDS`/
`checkRecordLimit` are returned back to `main.js`, since previously
extracted modules (`acquisitions.js`, `deaccession-acts.js`, `loans.js`,
`catalog.js`, `readers.js`) already depend on them by direct reference in
an object passed to their `require()`, which runs AFTER
`handlers/books.js`'s position — the same forward-return pattern already
established for `LOAN_SELECT`/`firstActiveHold`. IPC behavior is fully
unchanged. New test file `test/handlers-books.test.js` (11 tests) — 381
tests total (up from 370).

With this, all of the "big five" (loans, catalog, reports, settings, books)
and every smaller domain from the original plan have been extracted from
`main.js` — what remains is the journal/local-history cluster (already
extracted in earlier versions), data import from other systems, and the
mobile phone-scan import (see the Phase 4 status in earlier entries).

## v1.55.0

**BG:** Продължава разбиването на `main.js` (Фаза 4, стъпка 33, един от
"големите пет"): "Настройки" (без шаблоните за напомняне по подразбиране)
е изнесено в `handlers/settings.js` — 7 handler-а: `settings:get/update/
updateNotices/updateLabelFormat/chooseLogo/clearLogo/updateTheme`.
`settings:noticeDefaults` умишлено ОСТАВА в `main.js`: чете
`DEFAULT_NOTICE_*`/`NOTICE_PLACEHOLDERS`, върнати от `handlers/notices.js`,
чийто `require()` стои по-нататък в `main.js` от мястото на
`handlers/settings.js` — преместването му би било същият TDZ капан като при
`logEvent`. `LOGO_MIME`/`LOCAL_PHOTO_MAX_BYTES` се връщат обратно към
`main.js`, защото `handlers/local-photo.js` (require()-нат по-нататък) вече
ги ползва по референция. IPC поведението е напълно непроменено. Нов тест:
`test/handlers-settings.test.js` (10 теста) — общо 370 теста (бяха 360).

**EN:** Continues splitting `main.js` (Phase 4, step 33, one of the "big
five"): the "settings" domain (excluding the default reminder templates)
moves to `handlers/settings.js` — 7 handlers: `settings:get/update/
updateNotices/updateLabelFormat/chooseLogo/clearLogo/updateTheme`.
`settings:noticeDefaults` deliberately STAYS in `main.js`: it reads
`DEFAULT_NOTICE_*`/`NOTICE_PLACEHOLDERS` returned from `handlers/notices.js`,
whose `require()` sits further down in `main.js` than
`handlers/settings.js` — moving it would hit the same TDZ trap as
`logEvent`. `LOGO_MIME`/`LOCAL_PHOTO_MAX_BYTES` are returned back to
`main.js` since `handlers/local-photo.js` (required further down) already
depends on them by reference. IPC behavior is fully unchanged. New test
file `test/handlers-settings.test.js` (10 tests) — 370 tests total (up
from 360).

## v1.54.0

**BG:** Продължава разбиването на `main.js` (Фаза 4, стъпка 32, един от
"големите пет"): "Онлайн каталог" (публикуване през GitHub) и "Експорт в
библиотечни формати" (UNIMARC/MARCXML, Dublin Core) са изнесени в
`handlers/catalog.js` — 11 handler-а: `catalog:status/remoteCheck/updateGh/
chooseFolder/disconnectFolder/gitPublishNow/writeNow/exportMarc/exportDc/
export/exportCsv`. `scheduleCatalogWrite`/`flushCatalogWrite`/
`buildCatalogPayload` умишлено ОСТАВАТ hoisted в `main.js` (по същата
причина като `logEvent`): по-рано извадени модули (`deaccession-acts.js`,
`loans.js`) вече ги ползват по пряка референция в обект, подаден на техния
`require()`, изпълнен преди мястото на `handlers/catalog.js` — преместването
им би било същият TDZ капан. `startAutoPushTimer`/`stopAutoPushTimer` (нова
функция, заменя пряката работа с `AUTO_PUSH_TIMER` в `window-all-closed`) се
връщат обратно към `main.js`, защото се викат само вътре в отложени
callback-и (`app.whenReady()`/`window-all-closed`) — редът там няма
значение. IPC поведението е напълно непроменено. Нов тестов файл
`test/handlers-catalog.test.js` (17 теста, с фалшив `execFile`, за да не
зависи от инсталиран git/мрежа) — общо 360 теста (бяха 343).

**EN:** Continues splitting `main.js` (Phase 4, step 32, one of the "big
five"): the "online catalog" (GitHub publishing) and "library format
exports" (UNIMARC/MARCXML, Dublin Core) domains move to
`handlers/catalog.js` — 11 handlers: `catalog:status/remoteCheck/updateGh/
chooseFolder/disconnectFolder/gitPublishNow/writeNow/exportMarc/exportDc/
export/exportCsv`. `scheduleCatalogWrite`/`flushCatalogWrite`/
`buildCatalogPayload` deliberately STAY hoisted in `main.js` (same reason as
`logEvent`): previously extracted modules (`deaccession-acts.js`,
`loans.js`) already depend on them by direct reference in an object passed
to their `require()`, which runs before `handlers/catalog.js`'s position —
moving them would hit the same TDZ trap. `startAutoPushTimer`/
`stopAutoPushTimer` (a new function replacing direct `AUTO_PUSH_TIMER`
manipulation in `window-all-closed`) are returned back to `main.js`, since
they're only invoked inside deferred callbacks (`app.whenReady()`/
`window-all-closed`) — load order there doesn't matter. IPC behavior is
fully unchanged. New test file `test/handlers-catalog.test.js` (17 tests,
using a fake `execFile` so tests don't depend on installed git/network) —
360 tests total (up from 343).

## v1.53.0

**BG:** Продължава разбиването на `main.js` (Фаза 4, стъпка 31): краеведският
клъстер "аналитично описание, персоналии, летопис, снимки, връзки" е изваден
в пет отделни модула — `handlers/analytics.js`, `handlers/persons.js`,
`handlers/chronicle.js`, `handlers/local-photo.js`, `handlers/links.js`.
Всеки подмодул е самостоятелен: `linkLabel()` в `links.js` чете направо от
съответните таблици по `getDb()`, без препратки към другите извадени
модули. `local-photo.js` получава `mainWindow` през `getMainWindow()` getter
(както `handlers/backup.js`) и `LOGO_MIME`/`LOCAL_PHOTO_MAX_BYTES` — стойности,
дефинирани по-рано в `main.js` (при логото на читалището), подадени по
референция. IPC поведението е напълно непроменено. Нови тестови файлове:
`test/handlers-analytics.test.js` (6), `test/handlers-persons.test.js` (5),
`test/handlers-chronicle.test.js` (6), `test/handlers-local-photo.test.js` (7),
`test/handlers-links.test.js` (7) — общо 343 теста (бяха 312).

**EN:** Continues splitting `main.js` (Phase 4, step 31): the local-history
("краеведски") cluster — analytical description, persons, chronicle,
photos, and cross-links — moves into five separate modules —
`handlers/analytics.js`, `handlers/persons.js`, `handlers/chronicle.js`,
`handlers/local-photo.js`, `handlers/links.js`. Each submodule is
self-contained: `linkLabel()` in `links.js` reads directly from the
relevant tables via `getDb()`, with no cross-references to the other
extracted modules. `local-photo.js` receives `mainWindow` through a
`getMainWindow()` getter (same pattern as `handlers/backup.js`) and
`LOGO_MIME`/`LOCAL_PHOTO_MAX_BYTES` — values defined earlier in `main.js`
(for the institution's logo) — passed by reference. IPC behavior is fully
unchanged. New test files: `test/handlers-analytics.test.js` (6),
`test/handlers-persons.test.js` (5), `test/handlers-chronicle.test.js` (6),
`test/handlers-local-photo.test.js` (7), `test/handlers-links.test.js` (7) —
343 tests total (up from 312).

## v1.52.0

**BG:** Продължава разбиването на `main.js` на модули по домейн (Фаза 4,
стъпка 30): "Дневник на библиотеката" (Раздел А/Б) е изваден в
`handlers/dnevnik.js` — `dnevnik:getMonth`, `dnevnik:saveDay`,
`dnevnik:suggest` (с таблиците за съпоставяне вид/език/УДК/възраст) и
`dnevnik:exportCsv`. `dnevnikSumRow` (годишните/месечните тотали) се връща
обратно към `main.js`, защото `handlers/stats.js` (изваден в предишна
версия) вече го ползва по референция за готовата справка "Годишен
статистически отчет" — редът на зареждане в `main.js` е запазен така, че
константата вече да е присвоена, преди `stats.js` да я поиска. IPC
поведението е напълно непроменено. Нов тестов файл
`test/handlers-dnevnik.test.js` (8 теста) — общо 312 теста (бяха 304).

**EN:** Continues splitting `main.js` into per-domain modules (Phase 4, step
30): the "library journal" (Section A/B) domain moves to
`handlers/dnevnik.js` — `dnevnik:getMonth`, `dnevnik:saveDay`,
`dnevnik:suggest` (with its type/language/UDK/age lookup tables), and
`dnevnik:exportCsv`. `dnevnikSumRow` (the month/year-to-date totals
function) is returned back to `main.js`, since `handlers/stats.js`
(extracted in a previous version) already depends on it by reference for
the "annual statistical report" built-in report — load order in `main.js`
is preserved so the constant is assigned before `stats.js` needs it. IPC
behavior is fully unchanged. New test file `test/handlers-dnevnik.test.js`
(8 tests) — 312 tests total (up from 304).

## v1.51.0

**Промени — двайсет и девети извлечен домейн от main.js (Фаза 4, стъпка 29), без промяна в поведението:**
- "Справки и статистика" + "Готови справки" (8 IPC канала: stats:report,
  reports:list/run) изведени в `handlers/stats.js`. Зависи от `value`
  (стабилна функция в main.js) и `dnevnikSumRow` (hoisted function
  declaration от все още неизвадения домейн "Дневник на библиотеката") —
  и двете по референция.
- IPC поведението непроменено. Нов тестови файл (10 нови теста, общо 304).

**Changes — twenty-ninth domain extracted from main.js (Phase 4, step 29), no behavior change:**
- "Statistics and reports" (8 IPC channels: stats:report, reports:list/run)
  extracted into `handlers/stats.js`. Depends on `value` (a stable
  function in main.js) and `dnevnikSumRow` (a hoisted function declaration
  from the still-unextracted "Library journal" domain) — both by
  reference.
- IPC behavior unchanged. New test file (10 new tests, 304 total).

## v1.50.0

**Промени — три извлечени домейна от main.js (Фаза 4, стъпка 28), без промяна в поведението:**
- "Одитна следа" (audit:list) изведени в `handlers/audit.js`.
- "История на търсенията" (searchHistory:log/suggest) изведени в
  `handlers/search-history.js`. `getCurrentUser` е getter (по същия модел
  като getDb/setDb), тъй като `CURRENT_USER` е мутируемо `let` в main.js,
  сменяно от `app:setUser`.
- "Посещения" (visits:add) изведени в `handlers/visits.js`.
- Три самостоятелни, малки домейна — без връзка помежду си, обединени в
  едно издание.
- IPC поведението непроменено. Три нови тестови файла (12 нови теста, общо 294).

**Changes — three domains extracted from main.js (Phase 4, step 28), no behavior change:**
- "Audit trail" (audit:list) extracted into `handlers/audit.js`.
- "Search history" (searchHistory:log/suggest) extracted into
  `handlers/search-history.js`. `getCurrentUser` is a getter (same pattern
  as getDb/setDb), since `CURRENT_USER` is a mutable `let` in main.js,
  changed by `app:setUser`.
- "Visits" (visits:add) extracted into `handlers/visits.js`.
- Three independent, small domains — unrelated to each other, bundled into
  one release.
- IPC behavior unchanged. Three new test files (12 new tests, 294 total).

## v1.49.0

**Промени — двайсет и шести извлечен домейн от main.js (Фаза 4, стъпка 27), без промяна в поведението:**
- "МЗС" (междубиблиотечно заемане — 5 IPC канала: mzs:list/nextNo/create/
  update/delete) изведени в `handlers/mzs.js`. Зависи само от `getDb`,
  `run`, `logAudit`, `yearOf`.
- IPC поведението непроменено. Нов тестови файл (6 нови теста, общо 282).

**Changes — twenty-sixth domain extracted from main.js (Phase 4, step 27), no behavior change:**
- "MZS" (inter-library loan — 5 IPC channels: mzs:list/nextNo/create/
  update/delete) extracted into `handlers/mzs.js`. Depends only on
  `getDb`, `run`, `logAudit`, `yearOf`.
- IPC behavior unchanged. New test file (6 new tests, 282 total).

## v1.48.0

**Промени — двайсет и пети извлечен домейн от main.js (Фаза 4, стъпка 26), без промяна в поведението:**
- "Периодика" (7 IPC канала: periodicals:list/get/create/update/delete,
  periodicalIssues:add/delete) изведени в `handlers/periodicals.js`.
  Зависи само от `getDb`, `run`, `logAudit`, `today`.
- IPC поведението непроменено. Нов тестови файл (10 нови теста, общо 276).

**Changes — twenty-fifth domain extracted from main.js (Phase 4, step 26), no behavior change:**
- "Periodicals" (7 IPC channels: periodicals:list/get/create/update/
  delete, periodicalIssues:add/delete) extracted into
  `handlers/periodicals.js`. Depends only on `getDb`, `run`, `logAudit`,
  `today`.
- IPC behavior unchanged. New test file (10 new tests, 276 total).

## v1.47.0

**Промени — двайсет и четвърти извлечен домейн от main.js (Фаза 4, стъпка 25), без промяна в поведението:**
- "Просрочени: напомняния" (3 IPC канала: loans:reminders/mailto,
  notices:log) изведени в `handlers/notices.js`. Зависи от `LOAN_SELECT`
  (loans.js), `EUR_RATE` (по стойност), `isValidEmail` (стабилен модулен
  export от `security-utils.js`), `shell` (Electron) и `today`.
- `DEFAULT_NOTICE_SUBJECT`/`DEFAULT_NOTICE_BODY`/`DEFAULT_NOTICE_SMS`/
  `NOTICE_PLACEHOLDERS` се връщат обратно към main.js (по същия модел като
  LOAN_SELECT/circRule), защото ги ползва все още неизвадената "Настройки"
  (`settings:noticeDefaults`).
- IPC поведението непроменено. Нов тестови файл (7 нови теста, общо 266).

**Changes — twenty-fourth domain extracted from main.js (Phase 4, step 25), no behavior change:**
- "Overdue reminders" (3 IPC channels: loans:reminders/mailto,
  notices:log) extracted into `handlers/notices.js`. Depends on
  `LOAN_SELECT` (loans.js), `EUR_RATE` (by value), `isValidEmail` (a stable
  module export from `security-utils.js`), `shell` (Electron), and `today`.
- `DEFAULT_NOTICE_SUBJECT`/`DEFAULT_NOTICE_BODY`/`DEFAULT_NOTICE_SMS`/
  `NOTICE_PLACEHOLDERS` are returned back to main.js (same pattern as
  LOAN_SELECT/circRule), since the still-unextracted "Settings" domain
  depends on them (`settings:noticeDefaults`).
- IPC behavior unchanged. New test file (7 new tests, 266 total).

## v1.46.0

**Промени — двайсет и трети извлечен домейн от main.js (Фаза 4, стъпка 24), без промяна в поведението:**
- "Инвентаризация" (6 IPC канала: inventorySessions:list/requirement/
  start/get/scan/close) изведени в `handlers/inventory-sessions.js`.
  Зависи от `pctRequired`/`naturalLoss` (стабилни function declarations в
  main.js) и getDb/run/logAudit.
- `inventorySessions:importScans` (внасяне на сканирано с телефон) остава
  засега в main.js — физически принадлежи към отделна секция за мобилно
  сканиране, не към основния маркер "Инвентаризация"; ще се изведе с
  бъдещия домейн "mobile".
- IPC поведението непроменено. Нов тестови файл (8 нови теста, общо 259).

**Changes — twenty-third domain extracted from main.js (Phase 4, step 24), no behavior change:**
- "Inventory sessions" (6 IPC channels: inventorySessions:list/
  requirement/start/get/scan/close) extracted into
  `handlers/inventory-sessions.js`. Depends on `pctRequired`/`naturalLoss`
  (stable function declarations in main.js) and getDb/run/logAudit.
- `inventorySessions:importScans` (importing phone-scanned codes) stays in
  main.js for now — it physically belongs to a separate mobile-scanning
  section, not the main "Инвентаризация" marker; it will move out with a
  future "mobile" domain.
- IPC behavior unchanged. New test file (8 new tests, 259 total).

## v1.45.0

**Промени — двайсет и втори извлечен домейн от main.js (Фаза 4, стъпка 23), без промяна в поведението:**
- "Табло" (2 read-only IPC канала: dashboard:stats/full) изведени в
  `handlers/dashboard.js`. Зависи от `LOAN_SELECT` (holds/loans.js),
  `isWorkDay` (calendar.js), `pctRequired`/`yearOf` (стабилни функции/
  конст в main.js) и `today`.
- IPC поведението непроменено. Нов тестови файл (5 нови теста, общо 251).

**Changes — twenty-second domain extracted from main.js (Phase 4, step 23), no behavior change:**
- "Dashboard" (2 read-only IPC channels: dashboard:stats/full) extracted
  into `handlers/dashboard.js`. Depends on `LOAN_SELECT` (from
  loans.js), `isWorkDay` (calendar.js), `pctRequired`/`yearOf` (stable
  functions/consts in main.js), and `today`.
- IPC behavior unchanged. New test file (5 new tests, 251 total).

## v1.44.0

**Промени — двайсет и първи извлечен домейн от main.js (Фаза 4, стъпка 22), без промяна в поведението — един от "големите пет":**
- "Заемания" (10 IPC канала: list/overdue/byReader/byBook/overdueByReader/
  checkout/return/extend/checkoutByCode/returnByCode, плюс events:localuse)
  изведени в `handlers/loans.js`. Ползва почти всичко вече извадено:
  `circRule`/`readerCategory` (circ-rules.js), `nextWorkDay`/
  `closedDaysBetween` (calendar.js), `firstActiveHold`/
  `consumeHoldOnCheckout`/`activateHoldOnReturn` (holds.js), `BOOK_SELECT`
  (по стойност, от все още неизвадения домейн "Книги") и
  `scheduleCatalogWrite` (по референция, hoisted по-долу в main.js).
- `logEvent` **остава** hoisted function declaration в main.js (не се мести
  в модула) — `handlers/housebound.js` вече го изисква по референция
  по-рано във файла (стъпка 8); местенето му в `handlers/loans.js` би
  минало през `const` присвояване по-късно във файла и би счупило по-ранния
  достъп (TDZ). `applySuspension`/`checkSuspended` (вътрешни, без пряк IPC)
  се преместиха изцяло в модула, тъй като никой друг домейн не ги ползва.
- `LOAN_SELECT` се връща обратно към main.js (по същия модел като
  calendar.js/circ-rules.js/holds.js), защото го ползват все още
  неизвадените домейни "Табло" и "Просрочени: напомняния".
- IPC поведението непроменено. Нов тестови файл (15 нови теста, общо 246).

**Changes — twenty-first domain extracted from main.js (Phase 4, step 22), no behavior change — one of the "big five":**
- "Loans" (10 IPC channels: list/overdue/byReader/byBook/overdueByReader/
  checkout/return/extend/checkoutByCode/returnByCode, plus events:localuse)
  extracted into `handlers/loans.js`. Consumes nearly everything extracted
  so far: `circRule`/`readerCategory` (circ-rules.js), `nextWorkDay`/
  `closedDaysBetween` (calendar.js), `firstActiveHold`/
  `consumeHoldOnCheckout`/`activateHoldOnReturn` (holds.js), `BOOK_SELECT`
  (by value, from the still-unextracted "Books" domain), and
  `scheduleCatalogWrite` (by reference, hoisted further down in main.js).
- `logEvent` **stays** a hoisted function declaration in main.js (not moved
  into the module) — `handlers/housebound.js` already requires it by
  reference earlier in the file (step 8); moving it into
  `handlers/loans.js` would turn it into a `const` assigned later in the
  file and break that earlier access (TDZ). `applySuspension`/
  `checkSuspended` (internal, no direct IPC surface) moved into the module
  entirely, since no other domain uses them.
- `LOAN_SELECT` is returned back to main.js (same pattern as
  calendar.js/circ-rules.js/holds.js), since the still-unextracted
  "Dashboard" and "Overdue reminders" domains depend on it.
- IPC behavior unchanged. New test file (15 new tests, 246 total).

## v1.43.0

**Промени — двайсети извлечен домейн от main.js (Фаза 4, стъпка 21), без промяна в поведението:**
- "Резервации" (3 IPC канала: holds:list/add/cancel) изведени в
  `handlers/holds.js`. `firstActiveHold`/`consumeHoldOnCheckout`/
  `activateHoldOnReturn` се връщат обратно към main.js (по същия модел като
  `handlers/calendar.js`/`handlers/circ-rules.js`), защото ги ползва
  домейнът "Заемания", който все още е в main.js и е следващият за
  извличане — той е плътно свързан с резервациите (при заемане/връщане
  трябва да провери/задели активна резервация).
- IPC поведението непроменено. Нов тестови файл (9 нови теста, общо 231).

**Changes — twentieth domain extracted from main.js (Phase 4, step 21), no behavior change:**
- "Holds" (3 IPC channels: holds:list/add/cancel) extracted into
  `handlers/holds.js`. `firstActiveHold`/`consumeHoldOnCheckout`/
  `activateHoldOnReturn` are returned back to main.js (same pattern as
  `handlers/calendar.js`/`handlers/circ-rules.js`), since the still-
  unextracted "Loans" domain — next in line, and tightly coupled to holds
  (checkout/return must check/promote an active hold) — depends on them.
- IPC behavior unchanged. New test file (9 new tests, 231 total).

## v1.42.0

**Промени — три извлечени домейна от main.js (Фаза 4, стъпки 18-20), без промяна в поведението:**
- "Читателска сметка" (Koha: accountlines — 4 IPC канала: get/charge/pay/
  deleteLine) изведени в `handlers/account.js`.
- "Предложения за покупка от читатели" (Koha: suggestions — 4 IPC канала:
  list/create/setStatus/delete) изведени в `handlers/suggestions.js`.
- "Лични данни: анонимизиране" (Koha: pseudonymization — 2 IPC канала:
  gdpr:candidates/gdpr:anonymize) изведени в `handlers/gdpr.js`.
- И трите зависят само от `getDb`, `run`, `logAudit` (и `today` за account/
  suggestions) — самостоятелни домейни без връзка помежду си, обединени в
  едно издание.
- IPC поведението непроменено. Три нови тестови файла (21 нови теста, общо 222).

**Changes — three domains extracted from main.js (Phase 4, steps 18-20), no behavior change:**
- "Reader account" (Koha: accountlines — 4 IPC channels: get/charge/pay/
  deleteLine) extracted into `handlers/account.js`.
- "Reader purchase suggestions" (Koha: suggestions — 4 IPC channels:
  list/create/setStatus/delete) extracted into `handlers/suggestions.js`.
- "Personal data anonymization" (Koha: pseudonymization — 2 IPC channels:
  gdpr:candidates/gdpr:anonymize) extracted into `handlers/gdpr.js`.
- All three depend only on `getDb`, `run`, `logAudit` (and `today` for
  account/suggestions) — independent domains bundled into one release.
- IPC behavior unchanged. Three new test files (21 new tests, 222 total).

## v1.41.0

**Промени — шестнайсети извлечен домейн от main.js (Фаза 4, стъпка 17), без промяна в поведението:**
- "Читатели" (7 IPC канала: list/get/byCard/create/update/clearSuspension/
  delete) изведени в `handlers/readers.js`. Зависи по референция от
  `maskReaderRow`/`maskReaderRows`/`preparePiiForWrite` (затворени над
  мутируемото PDP_KEY състояние за защита на ЕГН/№ ЛК), `diffFields`,
  `checkRecordLimit`, `ftsQuery` (стабилен модулен export от
  `search-fts.js`) и `today`/`logAudit`.
- `readers:delete` беше физически разположен в main.js след секцията за
  GDPR анонимизиране — преместен в `handlers/readers.js` заедно с
  останалите читателски handlers, без промяна в поведението.
- IPC поведението непроменено. Нов тестови файл (10 нови теста, общо 201).

**Changes — sixteenth domain extracted from main.js (Phase 4, step 17), no behavior change:**
- "Readers" (7 IPC channels: list/get/byCard/create/update/
  clearSuspension/delete) extracted into `handlers/readers.js`. Depends by
  reference on `maskReaderRow`/`maskReaderRows`/`preparePiiForWrite`
  (closed over the mutable PDP_KEY state protecting national ID fields),
  `diffFields`, `checkRecordLimit`, `ftsQuery` (a stable module export from
  `search-fts.js`), and `today`/`logAudit`.
- `readers:delete` was physically located in main.js after the GDPR
  anonymization section — moved into `handlers/readers.js` alongside the
  other reader handlers, with no behavior change.
- IPC behavior unchanged. New test file (10 new tests, 201 total).

## v1.40.0

**Промени — петнайсети извлечен домейн от main.js (Фаза 4, стъпка 16), без промяна в поведението:**
- "КДБФ — книга за движение на фонда" (единственият справочен, read-only
  `kdbf:report`) изведен в `handlers/kdbf.js`. Зависи само от `getDb`, `run`
  и `yearOf` (по стойност) — не пише нищо, само агрегира постъпления,
  отчисления и наличност към края на годината.
- IPC поведението непроменено. Нов тестови файл (6 нови теста, общо 191).

**Changes — fifteenth domain extracted from main.js (Phase 4, step 16), no behavior change:**
- "KDBF — fund movement ledger" (a single read-only report handler,
  `kdbf:report`) extracted into `handlers/kdbf.js`. Depends only on
  `getDb`, `run` and `yearOf` (by value) — writes nothing, only aggregates
  acquisitions, deaccessions, and year-end stock levels.
- IPC behavior unchanged. New test file (6 new tests, 191 total).

## v1.39.0

**Промени — четиринайсети извлечен домейн от main.js (Фаза 4, стъпка 15), без промяна в поведението:**
- "Отчисляване" (актове — 6 IPC канала) изведени в
  `handlers/deaccession-acts.js`. Зависи от `BOOK_SELECT` (по стойност) и
  `scheduleCatalogWrite` (по референция — отчислените документи изчезват
  от онлайн каталога).
- IPC поведението непроменено. Нов тестови файл (5 нови теста, общо 185).

**Changes — fourteenth domain extracted from main.js (Phase 4, step 15), no behavior change:**
- "Deaccessioning" (acts — 6 IPC channels) extracted into
  `handlers/deaccession-acts.js`. Depends on `BOOK_SELECT` (by value) and
  `scheduleCatalogWrite` (by reference — deaccessioned books disappear
  from the online catalog).
- IPC behavior unchanged. New test file (5 new tests, 185 total).

## v1.38.0

**Промени — тринайсети извлечен домейн от main.js (Фаза 4, стъпка 14), без промяна в поведението:**
- "Постъпления" (партиди — 5 IPC канала) изведени в
  `handlers/acquisitions.js`. Първи домейн, зависим от `BOOK_SELECT`
  (споделената SQL заготовка на все още неизвадения домейн "Книги") —
  подаден по стойност (низ, `const`, никога не се преприсвоява), не като
  getter.
- IPC поведението непроменено. Нов тестови файл (8 нови теста, общо 180).

**Changes — thirteenth domain extracted from main.js (Phase 4, step 14), no behavior change:**
- "Acquisitions" (batches — 5 IPC channels) extracted into
  `handlers/acquisitions.js`. First domain depending on `BOOK_SELECT` (the
  shared SQL fragment from the still-unextracted "Books" domain) — passed
  by value (a `const` string, never reassigned), not as a getter.
- IPC behavior unchanged. New test file (8 new tests, 180 total).

## v1.37.0

**Промени — дванайсети извлечен домейн от main.js (Фаза 4, стъпка 13), без промяна в поведението:**
- "Инвентарна книга" (Приложение № 4 — 1 read-only IPC канал) изведена в
  `handlers/inv-book.js`. Само `getDb()`/`run`.
- IPC поведението непроменено. Нов тестови файл (3 нови теста, общо 172).

**Changes — twelfth domain extracted from main.js (Phase 4, step 13), no behavior change:**
- "Inventory ledger" (Appendix No. 4 — 1 read-only IPC channel) extracted
  into `handlers/inv-book.js`. Only `getDb()`/`run`.
- IPC behavior unchanged. New test file (3 new tests, 172 total).

## v1.36.0

**Промени — единайсети извлечен домейн от main.js (Фаза 4, стъпка 12), без промяна в поведението:**
- "Контролирани номенклатури" (отдел, език, постоянно място — 3 IPC
  канала) изведени в `handlers/av.js`. Само `getDb()`/`run`/`logAudit`.
- IPC поведението непроменено. Нов тестови файл (7 нови теста, общо 169) —
  включително проверка, че повторен `av:save` изцяло ЗАМЕСТВА предишния
  списък, не добавя към него.

**Changes — eleventh domain extracted from main.js (Phase 4, step 12), no behavior change:**
- "Controlled nomenclatures" (department, language, permanent location —
  3 IPC channels) extracted into `handlers/av.js`. Only
  `getDb()`/`run`/`logAudit`.
- IPC behavior unchanged. New test file (7 new tests, 169 total) —
  including a check that a repeat `av:save` fully REPLACES the previous
  list rather than appending to it.

## v1.35.0

**Промени — десети извлечен домейн от main.js (Фаза 4, стъпка 11), без промяна в поведението:**
- "Контрол на авторитетните данни" (автодовършване + откриване/сливане на
  дублирани стойности като автор/издателство — 5 IPC канала) изведен в
  `handlers/authorities.js`. Само `getDb()`/`run`/`logAudit`.
- IPC поведението непроменено. Нов тестови файл (11 нови теста, общо 162):
  покрива и стриктния, и "хлабавия" режим на откриване на дубликати
  (съкратени имена като „И. Вазов“ = „Иван Вазов“, но „Димитър Колев“ ≠
  „Димитър Костов“).

**Changes — tenth domain extracted from main.js (Phase 4, step 11), no behavior change:**
- "Authority data control" (autocomplete + finding/merging duplicate
  values like author/publisher — 5 IPC channels) extracted into
  `handlers/authorities.js`. Only `getDb()`/`run`/`logAudit`.
- IPC behavior unchanged. New test file (11 new tests, 162 total): covers
  both the strict and "loose" duplicate-detection modes (abbreviated names
  like "И. Вазов" = "Иван Вазов", but "Димитър Колев" ≠ "Димитър Костов").

## v1.34.0

**Промени — девети извлечен домейн от main.js (Фаза 4, стъпка 10), без промяна в поведението:**
- "Търсене по ISBN" (Google Books + Open Library) и "SRU" (внасяне на MARC
  записи) — 2 IPC канала, изцяло самостоятелна мрежова/парсинг логика —
  изведени в `handlers/isbn-lookup.js`. Само `net` (Electron) и `getDb()`
  инжектирани.
- IPC поведението непроменено. Нов тестови файл (12 нови теста, общо 151):
  `net.fetch` е подменен с фалшива реализация, покрива Google
  Books/Open Library merge логиката и реален MARCXML parsing (заглавие,
  автор, издател, година, ISBN).

**Changes — ninth domain extracted from main.js (Phase 4, step 10), no behavior change:**
- "ISBN lookup" (Google Books + Open Library) and "SRU" (MARC record
  import) — 2 IPC channels, entirely self-contained network/parsing logic
  — extracted into `handlers/isbn-lookup.js`. Only `net` (Electron) and
  `getDb()` injected.
- IPC behavior unchanged. New test file (12 new tests, 151 total):
  `net.fetch` is replaced with a fake implementation, covering the Google
  Books/Open Library merge logic and real MARCXML parsing (title, author,
  publisher, year, ISBN).

## v1.33.0

**Промени — осми извлечен домейн от main.js (Фаза 4, стъпка 9), без промяна в поведението:**
- "Местоположение на базата данни" (3 IPC канала: четене, избор на нова
  папка/мрежов диск, връщане към стандартната) е изваден в
  `handlers/db-location.js`. Същия DI модел като `backup.js` (db/mainWindow
  като getter/setter). `readConfig`/`writeConfig`/`resolveDbDir`/
  `resolveDbPath` остават в main.js по референция — ползва ги и `initDb()`.
- IPC поведението непроменено. Нов тестови файл (9 теста, общо 139),
  включително сценария "папката вече има library.db — питай потребителя".

**Changes — eighth domain extracted from main.js (Phase 4, step 9), no behavior change:**
- "Database location" (3 IPC channels: read, choose a new/network folder,
  reset to default) extracted into `handlers/db-location.js`. Same DI model
  as `backup.js` (db/mainWindow as getter/setter). `readConfig`/
  `writeConfig`/`resolveDbDir`/`resolveDbPath` stay in main.js by
  reference — `initDb()` also uses them.
- IPC behavior unchanged. New test file (9 tests, 139 total), including the
  "folder already has a library.db — ask the user" scenario.

## v1.32.0

**Промени — седми извлечен домейн от main.js (Фаза 4, стъпка 8), без промяна в поведението:**
- Кодът за "Обслужване по домовете" (график и дневник на посещения при
  читатели, които не могат да идват сами — 5 IPC канала) е изваден от
  `main.js` в нов файл `handlers/housebound.js`.
- Първи случай, в който се инжектира функция, дефинирана ПО-ДОЛУ във
  файла: `logEvent` (в домейна "Заемания", все още неизваден) се подава по
  референция и работи коректно, защото е `function` декларация — тя се
  "hoist"-ва в началото на модула от JavaScript, независимо от текстовата
  ѝ позиция във файла, така че вече е напълно дефинирана в момента, в който
  main.js регистрира housebound handler-ите.
- IPC каналите (`housebound:get/save/remove/addVisit/list`) и поведението
  им са напълно непроменени.
- Добавен нов тестови файл `test/handlers-housebound.test.js` (7 нови
  теста, общо вече 130) — включително проверка, че `logEvent` реално се
  извиква с правилните аргументи при добавяне на посещение (не само че
  редът се появява в базата).
- Продължение на "внимателно, малка стъпка по стъпка" — остават: книги,
  заемания, читатели, каталог/git публикуване, настройки, и няколко
  по-малки домейна (МЗС, предложения за покупка, читателска сметка и др.).

**Changes — seventh domain extracted from main.js (Phase 4, step 8), no behavior change:**
- The "Housebound service" code (schedule and visit log for readers who
  can't come to the library themselves — 5 IPC channels) has been
  extracted from `main.js` into a new file `handlers/housebound.js`.
- The first case where an injected function is defined FURTHER DOWN in the
  file: `logEvent` (in the "Loans" domain, not yet extracted) is passed by
  reference and works correctly because it's a `function` declaration —
  JavaScript hoists it to the top of the module regardless of its textual
  position, so it's already fully defined by the time main.js registers
  the housebound handlers.
- The IPC channels (`housebound:get/save/remove/addVisit/list`) and their
  behavior are completely unchanged.
- Added a new test file `test/handlers-housebound.test.js` (7 new tests,
  130 total now) — including a check that `logEvent` is actually called
  with the right arguments when a visit is added, not just that the row
  appears in the database.
- Continuing "carefully, small step by step" — remaining: books, loans,
  readers, catalog/git publishing, settings, and a few smaller domains
  (interlibrary loans, purchase suggestions, reader accounts, etc.).

## v1.31.0

**Промени — шести извлечен домейн от main.js (Фаза 4, стъпка 7), без промяна в поведението:**
- Кодът за "Категории" (на книгите — 4 IPC канала: списък, добавяне,
  редакция, изтриване) е изваден от `main.js` в нов файл
  `handlers/categories.js`.
- Най-простият случай досега: само `getDb()`/`run`, без `logAudit`, без
  нито една върната функция назад. Други места в `main.js` (внос на данни,
  справки), които четат таблицата `categories` директно през своя `db`,
  продължават да го правят непроменено — модулът не пази състояние, само
  регистрира IPC handler-и.
- IPC каналите (`categories:list/create/update/delete`) и поведението им
  са напълно непроменени.
- Добавен нов тестови файл `test/handlers-categories.test.js` (5 нови
  теста, общо вече 123) — покрива и 10-те начални категории, засети от
  `schema.sql` (наред с новосъздадените, не вместо тях).
- Продължение на "внимателно, малка стъпка по стъпка" — остават: книги,
  заемания, читатели, каталог/git публикуване, настройки.

**Changes — sixth domain extracted from main.js (Phase 4, step 7), no behavior change:**
- The "Categories" code (for books — 4 IPC channels: list, create, update,
  delete) has been extracted from `main.js` into a new file
  `handlers/categories.js`.
- The simplest case so far: only `getDb()`/`run`, no `logAudit`, nothing
  returned back. Other places in `main.js` (data import, reports) that read
  the `categories` table directly through their own `db` continue to do so
  unchanged — the module holds no state, it only registers IPC handlers.
- The IPC channels (`categories:list/create/update/delete`) and their
  behavior are completely unchanged.
- Added a new test file `test/handlers-categories.test.js` (5 new tests,
  123 total now) — covers the 10 default categories seeded by `schema.sql`
  (alongside newly created ones, not instead of them).
- Continuing "carefully, small step by step" — remaining: books, loans,
  readers, catalog/git publishing, settings.

## v1.30.0

**Промени — пети извлечен домейн от main.js (Фаза 4, стъпка 6), без промяна в поведението:**
- Кодът за "Служители" (4 IPC канала: списък, добавяне, редакция,
  изтриване) е изваден от `main.js` в нов файл `handlers/employees.js`.
- Най-простият случай досега: обикновено CRUD над една таблица, само
  `getDb()`/`run`/`logAudit` — никакви функции не се връщат обратно към
  main.js, защото никой друг домейн не вика код от този.
- IPC каналите (`employees:list/create/update/delete`) и поведението им са
  напълно непроменени.
- Добавен нов тестови файл `test/handlers-employees.test.js` (8 нови теста,
  общо вече 118) — покрива и частичното обновяване (само някои полета
  подадени), реда на сортиране (активни преди неактивни), и дубликат по
  уникалното име.
- Продължение на "внимателно, малка стъпка по стъпка" — остават: книги,
  заемания, читатели, каталог/git публикуване, настройки, и няколко
  по-малки самостоятелни домейна (категории, правила за календара вече
  готови).

**Changes — fifth domain extracted from main.js (Phase 4, step 6), no behavior change:**
- The "Employees" code (4 IPC channels: list, create, update, delete) has
  been extracted from `main.js` into a new file `handlers/employees.js`.
- The simplest case so far: plain CRUD over a single table, only
  `getDb()`/`run`/`logAudit` needed — nothing is returned back to main.js
  since no other domain calls into this one.
- The IPC channels (`employees:list/create/update/delete`) and their
  behavior are completely unchanged.
- Added a new test file `test/handlers-employees.test.js` (8 new tests, 118
  total now) — covers partial updates (only some fields provided), sort
  order (active before inactive), and a duplicate-name conflict.
- Continuing "carefully, small step by step" — remaining: books, loans,
  readers, catalog/git publishing, settings, and a few smaller standalone
  domains.

## v1.29.0

**Промени — четвърти извлечен домейн от main.js (Фаза 4, стъпка 5), без промяна в поведението:**
- Кодът за "Правила за обслужване по категория читатели" (circulation_rules
  — 4 IPC канала) е изваден от `main.js` в нов файл
  `handlers/circ-rules.js`, по същия модел като `handlers/calendar.js`.
- Функциите `circRule(category)` и `readerCategory(readerId)` се връщат
  обратно към `main.js`, защото ги ползва и домейнът "Заемания" (все още
  неизваден) — за да изчислява реалния срок/лимит на конкретния читател,
  вместо винаги глобалните настройки. Всяко поле в `circulation_rules`,
  оставено `NULL`, пада обратно към глобалната стойност от `settings` —
  логиката е напълно непроменена.
- IPC каналите (`circRules:list/save/delete/effective`) и поведението им
  са напълно непроменени.
- Добавен нов тестови файл `test/handlers-circ-rules.test.js` (10 нови
  теста, общо вече 110) — покрива и връщаните помощни функции директно,
  включително частично `NULL` презаписване (само някои полета зададени за
  дадена категория, останалите падат към глобалните).
- Продължение на "внимателно, малка стъпка по стъпка" — остават: книги,
  заемания, читатели, каталог/git публикуване, настройки.

**Забележка за синхронизацията**: тази версия е построена върху коригираната
основа след пач `d31a64c` (реален CAST-фикс за индекса на баркода — виж
v1.25.0 в changelog-а), приложен от другата сесия между предишната и тази
доставка. `handlers/shelves.js` от v1.27.0 е поправен да отразява същия
CAST-на-параметъра фикс в `shelves:addBook` (беше пропуснат при първото
извличане, защото домейнът е бил изваден преди фикса да пристигне upstream).

**Changes — fourth domain extracted from main.js (Phase 4, step 5), no behavior change:**
- The "Circulation rules by reader category" code (circulation_rules — 4
  IPC channels) has been extracted from `main.js` into a new file
  `handlers/circ-rules.js`, following the same pattern as
  `handlers/calendar.js`.
- The functions `circRule(category)` and `readerCategory(readerId)` are
  returned back to `main.js`, because the "Loans" domain (not yet
  extracted) also uses them — to compute the actual loan period/limit for
  a specific reader instead of always the global settings. Any field in
  `circulation_rules` left `NULL` falls back to the global value in
  `settings` — logic completely unchanged.
- The IPC channels (`circRules:list/save/delete/effective`) and their
  behavior are completely unchanged.
- Added a new test file `test/handlers-circ-rules.test.js` (10 new tests,
  110 total now) — covers the returned helper functions directly, including
  partial `NULL` overrides (only some fields set for a category, the rest
  falling back to global).
- Continuing "carefully, small step by step" — remaining: books, loans,
  readers, catalog/git publishing, settings.

**Sync note**: this version is built on the corrected base after patch
`d31a64c` (a real CAST fix for the barcode index — see v1.25.0 in this
changelog), applied by the other session between the previous delivery and
this one. `handlers/shelves.js` from v1.27.0 has been fixed to carry the
same cast-the-parameter fix in `shelves:addBook` (it was missed on first
extraction because that domain was pulled out before the fix landed
upstream).

## v1.28.0

**Промени — трети извлечен домейн от main.js (Фаза 4, стъпка 4), без промяна в поведението:**
- Кодът за "Календар на библиотеката" (работни дни, официални/затворени
  дати — 4 IPC канала) е изваден от `main.js` в нов файл
  `handlers/calendar.js`.
- По-особен случай от предишните две стъпки: функциите `workDaysSet`,
  `isWorkDay`, `nextWorkDay`, `closedDaysBetween` се ползват и от домейна
  "Заемания" (все още неизваден от main.js) — за изместване на падеж към
  следващия работен ден и за изчисляване на дните закъснение без затворените
  дни. Затова модулът ги ВРЪЩА обратно към main.js, вместо да ги пази само за
  себе си (за разлика от `autoBackupIfNeeded`, който се ползва еднократно при
  стартиране, тези остават в текуща активна употреба от друг код).
- IPC каналите (`calendar:get/saveWorkDays/addClosed/removeClosed`) и
  поведението им са напълно непроменени.
- Добавен нов тестови файл `test/handlers-calendar.test.js` (8 нови теста,
  общо вече 100) — покрива и четирите връщани помощни функции директно
  (конкретни дати/уикенди/затворени дни), не само IPC каналите.
- Продължение на "внимателно, малка стъпка по стъпка" — остават: правила за
  обслужване (circRules — следваща стъпка, същия модел на "връщане назад"
  като календара), книги, заемания, читатели, каталог/git публикуване,
  настройки.

**Changes — third domain extracted from main.js (Phase 4, step 4), no behavior change:**
- The "Library calendar" code (work days, holidays/closed dates — 4 IPC
  channels) has been extracted from `main.js` into a new file
  `handlers/calendar.js`.
- A more involved case than the previous two steps: the functions
  `workDaysSet`, `isWorkDay`, `nextWorkDay`, `closedDaysBetween` are also
  used by the "Loans" domain (not yet extracted from main.js) — for shifting
  a due date to the next work day and for computing days-late excluding
  closed days. So the module RETURNS them back to main.js, rather than
  keeping them private (unlike `autoBackupIfNeeded`, which is used once at
  startup, these stay in active ongoing use by other code).
- The IPC channels (`calendar:get/saveWorkDays/addClosed/removeClosed`) and
  their behavior are completely unchanged.
- Added a new test file `test/handlers-calendar.test.js` (8 new tests, 100
  total now) — covers the four returned helper functions directly (specific
  dates/weekends/closed days), not just the IPC channels.
- Continuing "carefully, small step by step" — remaining: service rules
  (circRules — next step, same "return functions back" pattern as calendar),
  books, loans, readers, catalog/git publishing, settings.

## v1.27.0

**Промени — втори извлечен домейн от main.js (Фаза 4, стъпка 3), без промяна в поведението:**
- Кодът за "Витрини в онлайн каталога" (тематични списъци като „Лято 2026",
  показвани на сайта като бутони — 8 IPC канала) е изваден от `main.js` в нов
  файл `handlers/shelves.js`, по същия модел като `handlers/backup.js`.
- По-лек случай от резервните копия: тук се инжектират само `getDb()` и три
  вече дефинирани функции от main.js по референция — `run`, `logAudit`,
  `scheduleCatalogWrite` — без нужда от `mainWindow`/`dialog`/`app`.
- IPC каналите (`shelves:list/items/create/rename/delete/addBook/addBooks/
  removeBook`) и поведението им са напълно непроменени.
- Добавен нов тестови файл `test/handlers-shelves.test.js` (8 нови теста,
  общо вече 92) — тества директно извадения модул с реалната схема на базата
  данни (foreign keys, отчислени/служебни документи се подминават коректно).
- `handlers/**/*` вече беше в `package.json` → `build.files` от v1.26.0, така
  че новият файл се пакетира автоматично.
- Продължение на "внимателно, малка стъпка по стъпка" — остават: книги,
  заемания, читатели, каталог/git публикуване, настройки.

**Changes — second domain extracted from main.js (Phase 4, step 3), no behavior change:**
- The "Online catalog shelves" code (curated thematic lists like "Summer
  2026", shown on the site as buttons — 8 IPC channels) has been extracted
  from `main.js` into a new file `handlers/shelves.js`, following the same
  pattern as `handlers/backup.js`.
- A lighter case than the backups domain: only `getDb()` and three already-
  defined functions from main.js are injected by reference — `run`,
  `logAudit`, `scheduleCatalogWrite` — no `mainWindow`/`dialog`/`app` needed.
- The IPC channels (`shelves:list/items/create/rename/delete/addBook/
  addBooks/removeBook`) and their behavior are completely unchanged.
- Added a new test file `test/handlers-shelves.test.js` (8 new tests, 92
  total now) — tests the extracted module directly against the real
  database schema (foreign keys, deaccessioned/staff-only books correctly
  skipped).
- `handlers/**/*` was already in `package.json` → `build.files` since
  v1.26.0, so the new file is packaged automatically.
- Continuing "carefully, small step by step" — remaining: books, loans,
  readers, catalog/git publishing, settings.

## v1.26.0

**Промени — начало на разбиването на main.js на модули (Фаза 4, стъпка 2), без промяна в поведението:**
- Кодът за "Резервни копия" (списък, ръчно копие, възстановяване, автоматично
  дневно копие) е изваден от `main.js` в самостоятелен файл
  `handlers/backup.js`. Избран е като първи кандидат, защото е напълно
  самостоятелен — никой друг домейн (книги/заемания/читатели) не вика
  функциите му и обратно.
- Използва се инжектиране на зависимости (dependency injection) вместо голи
  споделени променливи: `db` и `mainWindow` се подават като getter/setter
  функции (`getDb()`/`setDb()`/`getMainWindow()`), защото и двете се
  преприсвояват по време на изпълнение (`mainWindow` при пресъздаване на
  прозореца, `db` — само веднъж при иницилизация, и после `null` точно преди
  рестартиране след възстановяване от копие).
- IPC каналите (`backup:list`, `backup:now`, `backup:restoreFromList`,
  `backup:restoreBrowse`) и поведението им са напълно непроменени — това е
  чисто структурно преместване на код, не нова функционалност.
- Добавен нов тестови файл `test/handlers-backup.test.js` (9 нови теста) —
  възможност, която този рефакторинг отключва за пръв път, защото `main.js`
  самият той никога не може да се зареди директно в тестова среда (той е
  Electron main процес). Общо тестовете вече са 84 (бяха 75).
- `handlers/**/*` добавен в списъка с пакетирани файлове
  (`package.json` → `build.files`) — без това инсталаторът за Windows би
  паднал при стартиране с грешка "Cannot find module".
- Това е стъпка 1 от няколко за разбиването на монолита — оставащите домейни
  (книги, заемания, читатели, каталог/git публикуване, настройки) предстоят в
  следващи версии, по изричното желание на библиотекаря да се прави
  "внимателно, малка стъпка по стъпка".

**Changes — start of splitting main.js into modules (Phase 4, step 2), no behavior change:**
- The "Backups" domain code (list, manual backup, restore, daily auto-backup)
  has been extracted from `main.js` into a standalone file
  `handlers/backup.js`. Chosen as the first candidate because it's fully
  self-contained — no other domain (books/loans/readers) calls into it, and
  it doesn't call into them.
- Uses dependency injection rather than bare shared variables: `db` and
  `mainWindow` are passed as getter/setter functions
  (`getDb()`/`setDb()`/`getMainWindow()`), because both are reassigned during
  the process lifetime (`mainWindow` when the window is recreated, `db` only
  once at init time and then `null` right before relaunching after a
  restore).
- The IPC channels (`backup:list`, `backup:now`, `backup:restoreFromList`,
  `backup:restoreBrowse`) and their behavior are completely unchanged — this
  is a pure structural code move, not new functionality.
- Added a new test file `test/handlers-backup.test.js` (9 new tests) — a
  testing capability this refactor unlocks for the first time, since
  `main.js` itself can never be loaded directly in a test environment (it's
  the Electron main process). Total tests are now 84 (were 75).
- `handlers/**/*` added to the packaged-files list (`package.json` →
  `build.files`) — without this the Windows installer would fail at startup
  with "Cannot find module".
- This is step 1 of several for splitting up the monolith — the remaining
  domains (books, loans, readers, catalog/git publishing, settings) are
  planned for future versions, per the librarian's explicit preference to do
  this "carefully, small step by step".

## v1.25.0

**Промени — два нови индекса в базата данни (Фаза 4, първа част):**
- **Индекс на баркода на документите** — сканирането на баркод (в таблото,
  при заемане/връщане) вече използва индекс вместо пълно сканиране на фонда.
  Нарочно БЕЗ ограничение за уникалност — съществуващи инсталации може вече
  да имат дублирани баркодове от по-стари данни или ръчна грешка; налагането
  на уникалност би счупило стартирането на програмата при първо обновяване,
  без предварителна проверка от библиотекаря. Само индекс за скорост, засега.
- **Композитен индекс за "тази книга заета ли е в момента"** — тази проверка
  се прави за ВСЕКИ ред от списъка с книги (при всяко отваряне на „Книги“);
  новият индекс я прави директна, вместо да сканира заеманията на книгата.
- **Поправка при прилагането**: самите заявки за търсене по баркод/инв. №
  (8 места в кода) сравняваха `CAST(inv_number AS TEXT) = ?` — CAST върху
  колоната пречи на SQLite да ползва какъвто и да е индекс по нея, което на
  практика правеше новия индекс на баркода безполезен. Пренаписани да CAST-ват
  параметъра вместо колоната (`inv_number = CAST(? AS INTEGER)`); проверено с
  `EXPLAIN QUERY PLAN`, че сега планът е `MULTI-INDEX OR` по двата индекса.
  Страничен ефект (подобрение): вече съвпада и инв. номер, сканиран/въведен с
  водещи нули (напр. „000123“), което старата текстова форма пропускаше.

**Changes — two new database indexes (Phase 4, part one):**
- **Barcode index** — scanning a barcode (dashboard, loans/returns) now uses
  an index instead of a full table scan. Deliberately WITHOUT a uniqueness
  constraint — existing installations may already have duplicate barcodes
  from older data or manual entry mistakes; enforcing uniqueness would break
  the app's startup on first upgrade, without the librarian first checking
  for and resolving duplicates. Index only, for speed, for now.
- **Composite index for "is this book currently on loan"** — this check runs
  for EVERY row of the books list (every time "Books" is opened); the new
  index makes it direct instead of scanning that book's loan history.
- **Applied-on-merge fix**: the actual barcode/inv.-no. lookup queries (8
  places) compared `CAST(inv_number AS TEXT) = ?` — casting the column
  prevents SQLite from using any index on it, which made the new barcode
  index effectively dead weight in practice. Rewritten to cast the parameter
  instead (`inv_number = CAST(? AS INTEGER)`); verified with `EXPLAIN QUERY
  PLAN` that the plan is now `MULTI-INDEX OR` across both indexes. Side
  effect (improvement): an inventory number scanned/typed with leading zeros
  (e.g. "000123") now matches too, which the old text-based comparison
  missed.

## v1.24.0

**Промени — ъпгрейд на Electron (Фаза 3, втора част):**
- **Electron 31 → 43** (и придружаващите `electron-builder` 24 → 26,
  `@electron/rebuild` 3 → 4) — версия 31 отдавна е извън поддръжка;
  разработчикът поддържа само последните три версии (в момента 41–43).
  Скокът е голям (12 версии), затова тази промяна е в собствена версия,
  отделно от останалите поправки — по-лесно за връщане назад, ако нещо
  изненада при истинското Windows пакетиране (GitHub Actions при таг).
  `electron-updater` остава 6.8.9 (вече беше най-новата версия).
  Прегледът на кода не намери употреба на премахнати/остарели Electron API
  (`remote`, `<webview>`, `protocol.registerFileProtocol` и т.н. — не се
  ползват); `npm install` с новите версии премина чисто, а `better-sqlite3`
  се прекомпилира без проблем — но истинската проверка е следващото реално
  издание (v1.24.0), затова инсталационния файл си заслужава по-внимателно
  ръчно изпробване преди да се разчита изцяло на автоматичното обновяване.
- **`better-sqlite3` 11 → 12** — първият опит за Windows build с Electron 43
  показа, че версия 11 не се компилира срещу новия V8 двигател (променени
  `v8::External::Value` / `PropertyCallbackInfo` API-та). Версия 12.11.1
  поддържа новите API-та; интерфейсът към базата данни е непроменен и
  всичките 74 теста минават.
- Задължителна проверка на подписа при автоматично обновяване
  (`verifyUpdateCodeSignature`) остава изключена, както досега — съзнателно
  решение, докато не е сигурно, че всяко бъдещо издание ще бъде подписано.

**Changes — Electron upgrade (Phase 3, part two):**
- **Electron 31 → 43** (with matching `electron-builder` 24 → 26,
  `@electron/rebuild` 3 → 4) — version 31 has long been out of support; only
  the latest three majors (currently 41–43) are maintained. This is a big
  jump (12 majors), so it ships as its own version, separate from the other
  fixes — easier to roll back if the real Windows packaging (GitHub Actions
  on tag) turns up a surprise. `electron-updater` stays at 6.8.9 (already
  current). A code review found no use of removed/deprecated Electron APIs
  (`remote`, `<webview>`, `protocol.registerFileProtocol`, etc. — none are
  used); `npm install` with the new versions resolved cleanly and
  `better-sqlite3` recompiled without issue — but the real test is the next
  actual release (v1.24.0), so the installer is worth a more careful manual
  try before fully trusting the auto-updater with it.
- **`better-sqlite3` 11 → 12** — the first Windows build attempt against
  Electron 43 showed that version 11 does not compile against the new V8
  engine (changed `v8::External::Value` / `PropertyCallbackInfo` APIs).
  Version 12.11.1 supports the new APIs; the database interface is unchanged
  and all 74 tests pass.
- Mandatory signature verification on auto-update
  (`verifyUpdateCodeSignature`) stays off, as before — a deliberate choice
  until every future release is guaranteed to be signed.

## v1.23.0

**Промени — заздравяване на сигурността (Фаза 3, първа част):**
- **Прозорецът вече отказва непредвидена навигация/нови прозорци** —
  приложението никога легитимно не отваря нов прозорец или не напуска
  заредения екран; сега това е и наложено технически (`setWindowOpenHandler`,
  guard за навигация), а не просто "не се случва в момента".
- **По-стегната политика за съдържание (CSP)** — добавени `object-src`,
  `base-uri` и `form-action`, без да се пипа нищо във визуалния интерфейс.
- **Защита срещу CSV formula injection при експорт на фонда** — заглавие,
  автор или друго текстово поле, започващо с `=`, `+`, `-` или `@` (напр.
  случайно или нарочно въведено „=cmd|…“), вече не може да се изпълни като
  формула/команда при отваряне на експортирания CSV в Excel/LibreOffice.
- **Валидация на имейл адреса** при изпращане на напомняне по имейл от
  „Заемане и връщане“.
- **Граници на XLSX импортера** — файл над 60 MB, архив с необичайно много
  вътрешни части или компресирана част, която би заела над 150 MB разопакована
  (класически „zip bomb“), вече се отказват веднага с ясно съобщение, вместо
  да рискуват да запълнят паметта на компютъра при внасяне на повреден файл.
- **Автоматични тестове при всеки push/PR** — нов GitHub Actions workflow
  пуска пълния тестов пакет (74 теста) автоматично, независимо от клона —
  досега тестовете тръгваха само ако разработчикът се сети да ги пусне
  локално.

**Changes — security hardening (Phase 3, part one):**
- **The window now refuses unexpected navigation/new windows** — the app
  never legitimately opens a new window or navigates away from the loaded
  screen; this is now technically enforced (`setWindowOpenHandler`, a
  navigation guard), not just "doesn't happen today by coincidence".
- **Tighter Content-Security-Policy** — added `object-src`, `base-uri`, and
  `form-action`, with no visible change to the interface.
- **CSV formula-injection protection on catalog export** — a title, author,
  or other text field starting with `=`, `+`, `-`, or `@` (e.g. an
  accidentally or deliberately entered "=cmd|…") can no longer execute as a
  formula/command when the exported CSV is opened in Excel/LibreOffice.
- **Email validation** when sending a reminder email from "Loans".
- **XLSX importer limits** — a file over 60 MB, an archive declaring an
  unreasonable number of internal parts, or a compressed part that would
  inflate past 150 MB (a classic "zip bomb"), are now rejected immediately
  with a clear message instead of risking exhausting the computer's memory
  when importing a corrupted file.
- **Automated tests on every push/PR** — a new GitHub Actions workflow runs
  the full test suite (74 tests) automatically on every branch — until now
  tests only ran if a developer remembered to run them locally.

## v1.22.0

**Промени — по-плавни списъци при голям фонд/списък с читатели (Фаза 2, продължение):**
- **Прозоречен рендер на „Книги“ и „Читатели“** — при библиотека с хиляди
  документи/читатели екраните вече изчертават списъка на части (по 300 реда),
  с бутон „Покажи още“ за следващите, вместо да чертаят всичко наведнъж —
  избягва забележимото замръзване на интерфейса при 5 000–15 000+ записа.
  Търсенето, подредбата и груповите действия върху книги ("Групова
  редакция…", "Във витрина…") работят както досега, върху пълния резултат от
  търсенето — не само върху заредената в момента част.
- **По-леко търсене в публичния онлайн каталог** — полето за търсене на
  сайта вече изчаква кратка пауза в писането (150мс), преди да филтрира
  списъка, вместо да го прави при всяка буквичка.

**Changes — smoother lists with a large catalog/reader list (Phase 2, continued):**
- **Windowed rendering for "Books" and "Readers"** — with thousands of
  documents/readers, these screens now draw the list in chunks (300 rows at
  a time) with a "Show more" button for the rest, instead of drawing
  everything at once — avoids the noticeable interface freeze at
  5,000–15,000+ records. Search, sorting, and bulk actions on books ("Bulk
  edit…", "Add to shelf…") still work as before, across the full search
  result — not just the currently-loaded chunk.
- **Lighter search on the public online catalog** — the site's search box
  now waits for a brief pause in typing (150ms) before filtering the list,
  instead of doing it on every keystroke.

## v1.21.0

**Промени — по-бързо търсене и по-плавна работа при голям фонд (началото на Фаза 2):**
- **Поправка на дефект в търсенето по кирилица** — търсенето по заглавие/автор
  (книги) и по име (читатели) вече намира резултат независимо от регистъра —
  напр. „белият“ вече намира „Белият вятър“. Досега търсенето пропускаше
  такива съвпадения заради ограничение на SQLite при сравнение по регистър на
  кирилски букви. Търсенето по баркод/ISBN/инв. № остава непроменено.
  Причината е нов индекс за пълнотекстово търсене (FTS5), който едновременно
  премахва пълното сканиране на фонда при всяко търсене — по-бързо е и при
  голям брой документи/читатели.
- **По-плавна работа при масови операции** — записът на публичния каталог
  (`katalog.json`) вече не се пресъздава синхронно при всяка отделна промяна
  (нова книга, заемане, връщане и т.н.), а се насрочва веднъж, кратко време
  след последната промяна в поредица от бързи действия. Ръчните действия
  („Публикувай сега“, свързване на папка) продължават да записват веднага.
  Полезно най-вече при по-голям фонд, където файлът е няколко MB.
- **По-лека проверка при сканиране от таблото** — разпознаването на сканиран
  баркод в началния екран вече не тегли цялата история на заеманията само за
  да провери дали конкретна книга в момента е заета.

**Changes — faster search and smoother operation at scale (start of Phase 2):**
- **Fixed a Cyrillic search bug** — searching by title/author (books) or by
  name (readers) now finds matches regardless of letter case — e.g. "белият"
  (lowercase) now finds "Белият вятър" (capitalized). This used to be missed
  because of a SQLite limitation in case-comparing Cyrillic letters. Barcode/
  ISBN/inventory-number search is unchanged. This comes from a new full-text
  search index (FTS5), which also removes the full table scan on every
  search — faster with a large catalog/reader list.
- **Smoother bulk operations** — the public catalog file (`katalog.json`) is
  no longer rewritten synchronously on every single change (new book, loan,
  return, etc.); it's now scheduled once, shortly after the last change in a
  burst of quick actions. Manual actions ("Publish now", connecting a folder)
  still write immediately. Most noticeable with a larger catalog, where the
  file is several MB.
- **Lighter dashboard scan lookup** — recognizing a scanned barcode on the
  home screen no longer pulls the entire loan history just to check whether
  one particular book is currently on loan.

## v1.20.0

**Промени — защита на ЕГН и № на лична карта на читателите:**
- **Криптиране на лични данни в базата данни** — ЕГН и № на лична карта на
  читателите вече се съхраняват криптирани (AES-256-GCM) в базата данни,
  вместо в чист текст, съгласно чл. 32 от GDPR и изискванията на ЗЗЛД.
- **Обща парола за защита** — защитата се задава от „Настройки → Защита на
  ЕГН / № лична карта" с една обща парола, която работи еднакво на всички
  компютри, споделящи една и съща мрежова база данни (без обвързване с
  конкретен компютър).
- **„Защитени данни" при заключена защита** — докато защитата е заключена
  (или паролата не е въведена на този компютър), екраните на читателите
  показват „Защитени данни" вместо действителното ЕГН/№ ЛК; данните остават
  непроменени в базата, докато не отключите защитата отново с правилната
  парола.
- **Съществуващи записи** — при първото задаване на парола всички вече
  въведени ЕГН/№ ЛК на читатели се криптират автоматично; при смяна на
  паролата всички записи се прекриптират наново, а старата парола спира
  да важи.
- **Важно** — паролата не се съхранява никъде в четим вид и не може да бъде
  възстановена от екипа на програмата; ако бъде забравена, криптираните
  ЕГН/№ ЛК на читателите не могат да бъдат прочетени отново (останалите
  данни за читателя не се засягат).

**Changes — encryption of readers' national ID (ЕГН) and ID card number:**
- **PII encryption at rest** — readers' national ID number (ЕГН) and ID
  card number are now stored encrypted (AES-256-GCM) in the database
  instead of in plain text, per GDPR Article 32 and Bulgarian data
  protection law (ЗЗЛД).
- **Shared password** — protection is enabled from „Settings → Защита на
  ЕГН / № лична карта" with one shared password that works identically on
  every computer sharing the same network database (not tied to a single
  machine).
- **"Protected data" placeholder while locked** — while protection is
  locked (or the password hasn't been entered on this computer), reader
  screens show "Защитени данни" instead of the actual ЕГН/ID card number;
  the underlying data is left untouched until protection is unlocked again
  with the correct password.
- **Existing records** — the first time a password is set, all readers'
  existing ЕГН/ID card numbers are encrypted automatically; changing the
  password re-encrypts every record and invalidates the old password.
- **Important** — the password is not stored anywhere in readable form and
  cannot be recovered by the program's authors; if it is forgotten, readers'
  encrypted ЕГН/ID card numbers cannot be read again (the rest of the
  reader's data is unaffected).

## v1.19.0

**Промени — основи за надеждност (без видими промени в екрана):**
- **Поправка на риск от загуба на данни** — при смяна на папката на базата
  данни (`Настройки → Местоположение на базата данни`), ако избраната папка
  вече съдържа `library.db` (обичайно споделена мрежова база от друг
  компютър в библиотеката), програмата вече пита изрично дали да я ползва
  непроменена, или да я презапише — вместо да я презапише мълчаливо.
- **Постоянен дневник на грешки** — грешки, които досега се губеха безследно
  в инсталираната програма, вече се записват във файл (папка `logs`, до 30
  дни назад), достъпна и чрез нов бутон в настройките за прикачване при
  заявка за поддръжка.
- **Версия на схемата на базата данни** — въведена е рамка с номерирани
  миграции (`PRAGMA user_version`) за по-безопасно бъдещо развитие на
  структурата на базата данни; съществуващите инсталации не са засегнати.
- **Тестова рамка** — добавени са автоматични тестове (криптиране на
  резервни копия, внасяне на CSV/XLSX файлове, инициализация на базата
  данни), които ще пазят от бъдещи регресии.

**Changes — reliability foundations (no visible changes on screen):**
- **Data-loss fix** — when changing the database location (`Settings →
  Database location`), if the chosen folder already contains a `library.db`
  (typically a shared network database used by another library computer),
  the program now asks explicitly whether to use it as-is or overwrite it,
  instead of silently overwriting it.
- **Persistent error log** — errors that used to vanish without a trace in
  the installed program are now written to a file (a `logs` folder, kept for
  30 days), also reachable via a new button in Settings for attaching to a
  support request.
- **Database schema versioning** — a numbered migration framework
  (`PRAGMA user_version`) was introduced for safer future schema changes;
  existing installations are unaffected.
- **Test suite** — automated tests were added (backup encryption, CSV/XLSX
  import, database initialization) to guard against future regressions.

## v1.18.0

**Промени — диференца в одитната следа и история на търсенията:**
- **Диференца в одитната следа** — при редакция на документ във фонда или на
  читател одитната следа вече показва **точно кои полета** са се променили
  (старата и новата стойност), не само че е имало редакция. ЕГН и номер на
  лична карта нарочно не се показват в диференца.
- **История на търсенията** — полетата за търсене в „Книги“ и „Читатели“ вече
  предлагат последните завършени търсения (не всяко натискане на клавиш) за
  бързо повторно търсене.

**Changes — audit trail diffs and search history:**
- **Audit trail diffs** — editing a book or a reader now shows **exactly which
  fields** changed (old and new value), not just that an edit happened.
  National ID number and ID card number are intentionally excluded from the
  diff.
- **Search history** — the search fields in "Books" and "Readers" now suggest
  recent completed searches (not every keystroke) for quick re-searching.

## v1.17.1

**Промени:**
- **Смяна на авторското име** — навсякъде в програмата (страничното меню,
  „Настройки“) и в придружаващите файлове вече пише „Създадено от Пламен
  Христов - Пачо“ вместо предишното изписване. Само технически без промяна:
  полето, което трябва да съвпада буква по буква със сертификата за подпис
  на кода, остава непроменено.

**Changes:**
- **Author name update** — the credit shown throughout the program (side
  menu, "Settings") and in the accompanying files now reads "Created by
  Plamen Hristov - Pacho" instead of the previous wording. One technical
  field is left unchanged on purpose: the one that must match the code
  signing certificate letter-for-letter.

## v1.17.0

**Промени — правила по категория, календар, бележки, сметка, предложения:**
- **Правила за обслужване по категория читатели** — Настройки → „Правила по
  категория читатели": срок за заемане, максимум документи, продължения и
  наказание в дни вече могат да са различни за дете, специалист и т.н. Празно
  поле = общата стойност от „Обслужване"; действащото правило се вижда в
  „Заемане и връщане" при избран читател.
- **Календар на библиотеката** — работни дни от седмицата + конкретни
  затворени дати (официални празници, отпуск) в Настройки. Падеж, паднал се в
  затворен ден, се измества автоматично към следващия работен ден; затворените
  дни вече не се броят в наказанието за забава.
- **Бележка при заемане** — нов ред в картона на читателя, който изскача
  открояващо се в „Заемане и връщане", щом бъде избран — напр. „носи още
  старата книга на брат си".
- **Читателска сметка** — начисления (годишна такса, обезщетение) и плащания
  за всеки читател, с печат на квитанция. Нова готова справка „Приходи от
  такси и обезщетения" за годишния отчет.
- **Предложения за покупка от читатели** — нов раздел „Предложения за
  покупка": заявено → одобрено → поръчано → получено (по избор — закачено към
  партида в „Постъпления") / отказано, с незадължително уведомяване на
  читателя по имейл при получаване.

**Changes — per-category rules, calendar, patron notes, accounts, suggestions:**
- **Circulation rules by reader category** — Settings → "Rules by reader
  category": loan period, max items, renewals, and suspension-days penalty
  can now differ for children, specialists, etc. An empty field falls back
  to the "Circulation" global default; the effective rule is shown in
  "Checkout/return" once a reader is selected.
- **Library calendar** — weekly working days plus specific closed dates
  (public holidays, time off) under Settings. A due date that falls on a
  closed day is automatically shifted to the next working day; closed days
  no longer count toward the suspension-days penalty.
- **Checkout alert note** — a new field on the patron record that pops up
  prominently in "Checkout/return" once that reader is selected — e.g.
  "still holding their brother's book too".
- **Patron account** — charges (annual fee, damages) and payments per
  reader, with receipt printing. New ready-made report "Fee and damages
  income" for the annual report.
- **Reader purchase suggestions** — new "Purchase suggestions" section:
  requested → approved → ordered → received (optionally linked to an
  acquisitions batch) / declined, with an optional email notification to the
  reader once received.

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
