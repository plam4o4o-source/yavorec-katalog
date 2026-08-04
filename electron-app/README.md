# Инвентар — десктоп приложение (Electron + SQLite)

Windows десктоп версия на библиотечния каталог, изградена с Electron и `better-sqlite3`.
Визуалният стил (хартиено-бронзова тема) е пренесен от оригиналното HTML приложение
`inventar-biblioteka.html`. Това е **отделен, самостоятелен проект** — не заменя
съществуващото HTML приложение и синхронизацията му с chyavorec.org.

Програмата е **универсална** — ползва се от всяко читалище или библиотека, без
промяна в кода. Виж „Данни на библиотеката (универсалност)“ по-долу.

Copyright © 2026 Пламен Христов - Пачо. Лицензирана е под
**GNU General Public License, версия 3 или по-нова, по избор на получателя**
(GPL-3.0-or-later) — вижте `LICENSE` (текстът на версия 3; неофициален
превод на български — `LICENSE.bg.md`).
Изтеглянето става от [GitHub Releases](https://github.com/plam4o4o-source/yavorec-katalog/releases);
Windows инсталаторът се подписва безплатно чрез
[SignPath Foundation](https://signpath.org/)-ната програма за проекти с
отворен код.

## Общ преглед / Overview

**Български:** „Инвентар“ е Windows десктоп приложение за управление на фонда
на малка библиотека — читалищна или общинска. Включва пълен инвентар и
каталог на книгите, контрол на авторитетните данни (автори/заглавия), УДК
класификация, читателски карти и заемане, напомняния за просрочени книги,
износ в библиотечни формати (UNIMARC/MARCXML, Dublin Core), внасяне на данни
от друга система, мобилно сканиране с баркод при инвентаризация, собствен
онлайн каталог през GitHub, работа в локална мрежа със споделена база данни,
автоматични резервни копия и автоматично обновяване. Работи офлайн, без
интернет връзка (освен при търсене по ISBN и онлайн каталога). Безплатна и с
отворен код — GNU GPL-3.0 или по-нова версия (по избор на получателя).

**English:** „Инвентар“ (*Inventory*) is a Windows desktop application for
managing the collection of a small public or community library
(*chitalishte*) in Bulgaria. It provides full book inventory and cataloging,
authority control for authors/titles, UDC classification, reader cards and
lending, overdue-book reminders, export to library formats
(UNIMARC/MARCXML, Dublin Code), data import from other systems, mobile
barcode scanning for stocktaking, a self-hosted online catalog via GitHub,
local-network operation with a shared database, automatic backups, and
automatic updates. It runs fully offline (except for optional ISBN lookups
and the online catalog). Free and open source — GNU GPL-3.0 or later, at
the recipient's option.

- **Download / Изтегляне:** [GitHub Releases](https://github.com/plam4o4o-source/yavorec-katalog/releases)
- **License / Лиценз:** GNU GPL-3.0-or-later — `LICENSE` (English, canonical
  text of version 3; "or later" applies per the notice below) /
  `LICENSE.bg.md` (Bulgarian, unofficial reference translation)
- **Requirements / Изисквания:** Windows 10/11, 64-bit
- **Code signing / Подпис на кода:** free, via [SignPath Foundation](https://signpath.org/)
  for open-source projects (application pending / заявката е подадена)

> This program is free software: you can redistribute it and/or modify it
> under the terms of the GNU General Public License as published by the
> Free Software Foundation, either version 3 of the License, or (at your
> option) any later version. / Тази програма е свободен софтуер: можете да я
> разпространявате и/или променяте според условията на Общия публичен лиценз
> на GNU (GPL), публикуван от Free Software Foundation — версия 3 на лиценза,
> или (по ваш избор) всяка по-късна версия.

The rest of this document (build instructions, feature details, database
schema) is written in Bulgarian, since it targets Bulgarian-speaking
librarians and developers maintaining this specific installation.

Останалата част от документа (инструкции за build, описание на функциите,
схема на базата данни) е на български, тъй като е насочена към български
библиотекари и разработчици, поддържащи точно тази инсталация.

## Съдържание

Този документ е насочен към **разработчици** — build, версии, автоматично
обновяване, схема на базата данни. Съдържанието за библиотекари (данни на
библиотеката, цифров подпис/антивирусни програми, описание на разделите на
програмата) е физически изнесено в отделен файл —
[`README-bibliotekar.md`](README-bibliotekar.md) — за да не се налага да
прелиствате технически подробности, докато търсите как работи даден раздел.
Ако търсите кратко ръководство по задачи, вижте и **наръчника за
библиотекаря** (`docs/narachnik-za-bibliotekarya.pdf` в корена на
хранилището).

**👤 За библиотекари:** вижте [`README-bibliotekar.md`](README-bibliotekar.md)
(данни на библиотеката, цифров подпис и антивирусни програми, раздели на
програмата).

**💻 За разработчици:**
- [Структура на проекта](#структура-на-проекта)
- [Инсталация (за разработка)](#инсталация-за-разработка)
- [Стартиране (режим за разработка)](#стартиране-режим-за-разработка)
- [Build на .exe за Windows](#build-на-exe-за-windows)
- [Версии](#версии)
- [Автоматично обновяване](#автоматично-обновяване) — включително GitHub Actions publish workflow
- [Език на инсталатора](#език-на-инсталатора)
- [Схема на базата данни](#схема-на-базата-данни)
- [Как да добавя нова таблица](#как-да-добавя-нова-таблица)
- [Как да добавя ново поле към книга (пример)](#как-да-добавя-ново-поле-към-книга-пример)
- [Забележка за обхвата на тази версия](#забележка-за-обхвата-на-тази-версия)
- вижте и [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) в корена на хранилището — IPC граници, карта на `handlers/*.js`, DI шаблонът от Фаза 4

## Структура на проекта

```
electron-app/
├── package.json          # зависимости, скриптове, electron-builder конфигурация
├── main.js               # главен процес — създава прозореца, инициализира SQLite, IPC handlers
├── preload.js             # безопасен мост (contextBridge) между интерфейса и main.js
├── icon.ico               # икона на приложението (Windows .exe и прозорец)
├── db/
│   └── schema.sql          # схема на базата данни + начални категории (изпълнява се при първо стартиране)
│   └── library.db          # SQLite базата данни (създава се автоматично, не се качва в git)
├── src/
│   ├── index.html           # разметка на интерфейса + подредения списък <script> тагове
│   ├── style.css            # стилове (хартиено-бронзова тема)
│   ├── udk.js                # УДК таблицата (данни), зарежда се преди всичко останало
│   └── views/                # рендиране на изгледите, форми, IPC заявки към main.js —
│       ├── core.js            #   по един файл на раздел от интерфейса (виж docs/ARCHITECTURE.md);
│       ├── navigation.js      #   core.js/navigation.js/bootstrap.js са инфраструктура,
│       ├── ...                #   всички останали файлове са по един на раздел на менюто
│       └── bootstrap.js       #   ЗАРЕЖДА СЕ ПОСЛЕДЕН — вижте обяснението в началото на файла
└── .gitignore
```

При пакетиран (инсталиран) `.exe`, базата данни се създава в потребителската папка
на Windows (`%APPDATA%/Инвентар/library.db`), а не вътре в инсталационната папка на
програмата — така потребителските данни оцеляват при преинсталиране/ъпдейт.

## Инсталация (за разработка)

Изисква се [Node.js](https://nodejs.org) (LTS версия, 18+).

```bash
cd electron-app
npm install
```

`npm install` автоматично прекомпилира `better-sqlite3` за версията на Electron
(чрез скрипта `postinstall`). Ако видите грешка от рода „NODE_MODULE_VERSION“
при стартиране, изпълнете ръчно:

```bash
npx electron-rebuild -f -w better-sqlite3
```

## Стартиране (режим за разработка)

```bash
npm start
```

Отваря се прозорец 1280×800 (resizable). При първо стартиране `db/library.db`
се създава автоматично от `db/schema.sql`, с предварително заредени категории
(„книга“, „периодично издание“ и т.н.).

## Build на .exe за Windows

```bash
npm run build
```

Резултатът (`Inventar-Setup-<версия>.exe`) се появява в папка `dist/`, заедно
с `Inventar-Setup-<версия>.exe.blockmap` и `latest.yml` (нужни за автоматичното
обновяване — виж по-долу). Името на файла нарочно е на латиница — при кирилица
в името `latest.yml` сочи към различно име от реалния файл и автообновяването
не открива файла (проверено и поправено). Самата програма и прозорецът ѝ пак
се казват „Инвентар“ — засяга само името на инсталационния файл.
Конфигурацията е в `package.json` → `"build"` (electron-builder, таргет `nsis`).

- Ако правите build от Windows машина — работи директно.
- Ако правите build от Linux/Mac за Windows таргет, electron-builder изтегля
  необходимите Windows инструменти автоматично (изисква интернет при първия build),
  а за самия NSIS инсталатор е нужен и `wine` (пакети `wine64` + `wine32:i386`
  на Ubuntu/Debian) — без Windows това е единственият начин да се генерира
  пълноценно работещ `.exe` деинсталатор.

## Версии

Версията е във формàт **major.minor.patch** (напр. `1.2.3`) и се задава в
`package.json` → `"version"` преди всеки build (тя се вижда и в името на
инсталатора: `Inventar-Setup-1.2.3.exe`):

| Число | Кога се качва |
|---|---|
| **1-во (major)** | основни промени — нова архитектура, несъвместими промени в базата данни |
| **2-ро (minor)** | средни промени — нова функционалност, нов раздел, нова таблица |
| **3-то (patch)** | малки промени — поправка на бъг, дребна корекция в текст/изглед |

Версията и авторството се виждат автоматично в самата програма:
- долу вляво в страничното меню (под индикатора за последния запис)
- в „Настройки“, най-долу на страницата

Текстът е: „Създадено от Пламен Христов - Пачо · GPL-3.0-or-later © &lt;година(и)&gt; · v&lt;версия&gt;“
— годината се изчислява автоматично (напр. „2026–2027“, ако програмата се ползва
и следващата година), версията идва директно от `package.json`, без да се пипа
ръчно другаде.

## Автоматично обновяване

Инсталираната програма проверява сама за нова версия в GitHub Releases на това
хранилище — при всяко стартиране, и по желание чрез бутона „Провери сега“ в
„Настройки“ → „Обновяване“. Ако намери по-нова версия, я изтегля тихо във фонов
режим; при затваряне на програмата (или чрез бутона „Инсталирай и рестартирай“)
новата версия се инсталира автоматично. Читателите/библиотекарят не правят нищо.

Това работи, защото хранилището `yavorec-katalog` е **публично** — изтеглянето
на release файловете не изисква никакъв токен или парола, вграден в програмата.
(Ако хранилището стане частно, автоматичното обновяване ще спре да работи, освен
ако не се добави GitHub токен в програмата — а това не е препоръчително, защото
всеки, инсталирал програмата, технически би могъл да го извлече от нея.)

### Автоматично publish чрез GitHub Actions (препоръчан начин)

`.github/workflows/release-electron.yml` build-ва инсталатора на истинска
Windows машина (GitHub-hosted runner — не е нужен `wine`) и публикува
GitHub Release с **и трите нужни файла** автоматично, веднага щом се качи таг
във формат `vX.Y.Z`:

1. Покачете версията в `electron-app/package.json` → `"version"` (вижте „Версии“ по-горе) и commit-нете
2. Създайте и push-нете таг със същата версия:
   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```
3. Готово — GitHub Actions сам ще build-не `.exe`-то, `.blockmap`-а и `latest.yml`
   и ще ги публикува като Release (проверка: раздел „Actions“ в GitHub хранилището).

Workflow-ът може да се пусне и ръчно (без таг), от раздел „Actions“ →
„Build & publish Windows installer“ → „Run workflow“ (`workflow_dispatch`) —
удобно за тестов build без да се качва официална версия.

От този момент всяка вече инсталирана програма ще открие версията при следващото
си стартиране и ще се обнови сама.

### Ръчен build/публикуване (резервен вариант, ако Actions не е наличен)

1. Покачете версията в `electron-app/package.json` → `"version"`
2. Build:
   ```bash
   cd electron-app
   npm run build
   ```
   В `dist/` ще се появят **три** файла — всичките са нужни за обновяването:
   - `Inventar-Setup-X.Y.Z.exe` (самият инсталатор)
   - `Inventar-Setup-X.Y.Z.exe.blockmap`
   - `latest.yml` (описва на програмата коя е последната версия и къде да я вземе)
3. Създайте GitHub Release на адрес
   `https://github.com/plam4o4o-source/yavorec-katalog/releases/new`:
   - **Tag**: точно `vX.Y.Z` (напр. `v1.2.0`) — версията с малко „v“ отпред, задължително същата като в `package.json`
   - Провлачете (drag & drop) **и трите файла** от `dist/` в зоната за прикачени файлове
   - Оставете release-а **публикуван** (не „draft“ и не „pre-release“) — иначе програмите няма да го видят
   - Publish release

## Език на инсталатора

Инсталаторът е **двуезичен — български и английски**. При стартиране показва
избор на език (`displayLanguageSelector`), а по подразбиране е българският
(`language: "1026"`).

| Какво | Откъде идва преводът |
|---|---|
| Стандартните екрани и бутони — „Напред“, „Инсталирай“, „Отказ“, изборът на папка, лентата за напредък, завършващият екран | самият NSIS, чрез `installerLanguages: ["bg_BG", "en_US"]` |
| Собствените съобщения на electron-builder — „Инсталиране, моля изчакайте…“, „Сигурни ли сте, че искате да премахнете…“, съобщенията при работеща програма | `build/installer.nsh` в този проект |

electron-builder носи преводи на своите съобщения за близо 50 езика, но **не и
за български** — без този файл те щяха да излизат на английски насред българския
инсталатор. Файлът се вмъква след генерираните езикови низове, затова
дефинициите в него имат предимство; NSIS отбелязва това с предупреждение
„LangString set multiple times“, което е очаквано.

Три низа липсват и в българския езиков файл на самия NSIS
(`MULTIUSER_TEXT_INSTALLMODE_*`, `MULTIUSER_INNERTEXT_INSTALLMODE_*`). Те също
са преведени в `build/installer.nsh`, а `warningsAsErrors: false` позволява
изграждането да продължи въпреки предупреждението за липсващия превод — иначе
NSIS спира с грешка.

**Проверка при промяна на текстовете:** изграждането с `DEBUG=electron-builder`
изброява всеки приет низ. Очакват се 28 реда „set multiple times for 1026“ —
по един за всеки преведен низ.

## Схема на базата данни

```sql
categories(id, name)
books(id, inv_number, barcode, register_date, title, subtitle, author, category_id -> categories,
      year, volume, isbn, pages, language, udk, call_number, author_mark, city, publisher,
      keywords, annotation, cover_url, department, status, price, description,
      acquisition_id -> acquisitions, deaccession_act_id -> deaccession_acts, deaccession_date, created_at)
inventory(id, book_id -> books, quantity)
inventory_checks(id, book_id -> books, date)
acquisitions(id, no, year, date, how, from_source, doc_type, doc_no, doc_date, total_count, sum, donor_address, note)
deaccession_acts(id, no, year, date, order_no, reason_code, reason_text, disposal, attach, committee1..3)
deaccession_items(id, act_id -> deaccession_acts, book_id, inv_number, author, title, volume, year, price, udk, category, language)
inventory_sessions(id, date, scope, department, committee1..3, pool_size, closed)
inventory_session_scans(id, session_id -> inventory_sessions, book_id, scanned_at)
inventory_session_missing(id, session_id -> inventory_sessions, book_id, inv_number, title, author, price)
readers(id, name, phone, address, address2, email, card_no, egn, id_card_no, id_card_date, id_card_issuer,
        birth_date, category, registered_at, re_registered_at, status, gdpr_consent, parent_consent, note, created_at)
loans(id, reader_id -> readers, book_id -> books, date_out, date_due, date_in, fine)
periodicals(id, title, freq, publisher, issn, department, note)
periodical_issues(id, periodical_id -> periodicals, issue_no, date, price, note)
mzs_requests(id, no, year, date, direction, partner, author, title, isbn, requester, status, due_date, note)
audit_log(id, ts, user, action, detail)
visits(id, date, count)
employees(id, name, active, created_at)
dnevnik_days(id, date, a_hours, a_age_u14..a_visit_internet — Раздел А, b_hours, b_type_books..b_cat_reading_used — Раздел Б, note)
analytics(id, title, subtitle, author, source_kind, periodical_id, book_id, source_text,
          year, issue, issue_date, pages, udk, keywords, annotation, is_local, note, created_at)
persons(id, name, alt_names, birth_date, birth_place, death_date, death_place, activity,
        bio, awards, sources, photo, note, created_at)
chronicle(id, year, date, title, body, category, participants, sources, photo, note, created_at)
links(id, from_kind, from_id, to_kind, to_id, note, created_at)
settings(id=1, org, lib_name, place, bulstat, reg_no, director, director_role, librarian, cat_url,
         loan_days, max_books, extensions_count, extension_days, fine_per_day, annual_fee,
         free_access_pct, next_inv_number, committee1..3, lbl_mode, lbl_w, lbl_h, theme, catalog_folder,
         gh_user, gh_repo, gh_branch, limit_books, limit_readers)
```

`date_in IS NULL` в `loans` означава, че заемането е активно (книгата все още е заета).
`status = 'отчислен'` в `books` означава, че документът е изваден от фонда с акт и не се брои в наличностите/статистиката.

## Как да добавя нова таблица

1. **Схема** — добавете `CREATE TABLE IF NOT EXISTS ...` в `db/schema.sql`.
   Схемата се изпълнява при всяко стартиране (`CREATE TABLE IF NOT EXISTS` не
   пипа съществуващи таблици), така че промяната важи веднага за нови инсталации.
   За съществуваща база с вече записани данни добавете отделен `ALTER TABLE`
   блок, обвит в проверка (напр. `PRAGMA table_info` или `try/catch`), защото
   SQLite не поддържа `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

2. **IPC handlers** (`main.js`) — добавете `ipcMain.handle('таблица:действие', ...)`
   по образец на съществуващите (`books:list`, `books:create` и т.н.). Използвайте
   помощната функция `run(fn)` — тя хваща грешки и връща `{ok:false, error}`
   вместо да чупи приложението.

3. **preload.js** — изложете новите канали през `contextBridge`:
   ```js
   mytable: {
     list: invoke('mytable:list'),
     create: invoke('mytable:create')
   }
   ```

4. **нов файл `src/views/mytable.js`** (по образец на `src/views/books.js`) —
   форма по образец на `bookForm`/`readerForm`, плюс `renderMyTable()`.
   Регистрирайте новия файл с `<script src="views/mytable.js"></script>` в
   `src/index.html` — редът спрямо другите view-файлове е без значение, само
   `views/bootstrap.js` трябва да остане ПОСЛЕДЕН (вижте обяснението в
   началото на самия `bootstrap.js`). Добавете нов запис в `NAV`/`TITLES` в
   `src/views/navigation.js` и `renderMyTable` в обекта `RENDERERS` в
   `src/views/bootstrap.js`.

## Как да добавя ново поле към книга (пример)

1. `db/schema.sql`: добавете колоната в `CREATE TABLE books (...)`.
2. `main.js`: добавете полето в `BOOK_SELECT`, `books:create` и `books:update`.
3. `src/views/books.js`: добавете `<input name="ново_поле">` в `bookForm()` и
   полето в `payload` в `saveBook()`.

## Забележка за обхвата на тази версия

Тази Electron версия пренася всички модули на `inventar-biblioteka.html`,
включително публикуването на онлайн каталога към chyavorec.org — но по
по-прост начин, тъй като Electron (за разлика от браузъра) може да изпълнява
`git` пряко: не е нужен отделен Windows Task Scheduler + `.bat` файл, каквито
изискваше браузърната версия (виж „Онлайн каталог през GitHub“ по-долу).

Не пренесени (защото са специфични за браузърната архитектура на другото
приложение, не за самата библиотечна дейност): криптиране на файла на диска,
File System Access API избор на папка, ротационни резервни копия в браузъра.
Печатът на официалните документи и етикети, шестте цветови теми, работата в
локална мрежа и автоматичното публикуване на онлайн каталога (виж съответните
раздели по-горе) вече са включени. Ако друго конкретно нещо ви трябва, кажете кое.
