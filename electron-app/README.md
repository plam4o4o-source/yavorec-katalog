# Инвентар — десктоп приложение (Electron + SQLite)

Windows десктоп версия на библиотечния каталог, изградена с Electron и `better-sqlite3`.
Визуалният стил (хартиено-бронзова тема) е пренесен от оригиналното HTML приложение
`inventar-biblioteka.html`. Това е **отделен, самостоятелен проект** — не заменя
съществуващото HTML приложение и синхронизацията му с chyavorec.org.

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
│   ├── index.html           # разметка на интерфейса
│   ├── style.css            # стилове (хартиено-бронзова тема)
│   └── app.js                # рендиране на изгледите, форми, IPC заявки към main.js
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

Резултатът (`Инвентар Setup <версия>.exe`) се появява в папка `dist/`.
Конфигурацията е в `package.json` → `"build"` (electron-builder, таргет `nsis`).

- Ако правите build от Windows машина — работи директно.
- Ако правите build от Linux/Mac за Windows таргет, electron-builder изтегля
  необходимите Windows инструменти автоматично (изисква интернет при първия build).

## Раздели

| Раздел | Какво прави |
|---|---|
| Табло | обобщени показатели: книги, читатели, заети, просрочени |
| Книги | пълна библиографска карта (автор, заглавие, ISBN, УДК, сигнатура, авторски знак и др.), търсене, наличности |
| Категории | добавяне/редакция/изтриване на видовете документи |
| Инвентарна книга | ledger по чл. 16, ал. 1 (Приложение № 4) — вписване, отметки за проверки, връзка с партида и акт |
| КДБФ | Книга за движение на фонда — части № 1 (постъпили), № 2 (резултати), № 3 (отчислени), по години |
| Постъпления | партиди по чл. 14 — общ брой, документ на придобиване, инвентиране на екземпляри към партидата |
| Отчисляване | актове по чл. 30 – 39 — сканиране/въвеждане на инв. номера, причина, комисия, анулиране на акт |
| Инвентаризация | сесии по репрезентативния метод (чл. 40 – 41) — сканиране, автоматично маркиране на липсващи, допустими загуби |
| Читатели | пълна анкета по чл. 42, ал. 3 (ЕГН, лична карта, адреси, категория, ОРЗД съгласие) |
| Заемане и връщане | заемане (проверява свободни бройки), връщане, продължаване на срок |
| Просрочени | списък на просрочените заемания с изчислено обезщетение по чл. 43 |
| Периодика | картотека на изданията + кардекс на постъпилите броеве |
| МЗС | регистър на заявки за междубиблиотечно заемане (входящи/изходящи) |
| Справки и статистика | годишни показатели, разбивки по фонд/език/отдел/категория, най-търсени заглавия |
| Онлайн каталог | локален експорт на `katalog.json`; **не** включва git-sync конвейера към chyavorec.org (той е в `inventar-biblioteka.html`) |
| Баркод етикети | автоматичен печат на етикети Code 39: за фонда (име на библиотеката + баркод + инв. номер на един етикет), отделни етикети за сигнатура (УДК + авторски знак + баркод), читателски карти; формат A4 лист или ролков лейбъл принтер; проверка на баркод четец |
| Одитна следа | автоматичен запис кой служител какво е извършил, CSV експорт |
| Настройки | данни за библиотеката, параметри на обслужването, постоянна комисия |

### Автоматизиран печат (документи и етикети)

Всички официални формуляри и етикети се печатат автоматично като готови документи
(през диалога за печат на Windows → „Microsoft Print to PDF“ за PDF файл), не само
като таблици на екрана:

- **Инвентарна книга** — пълна разпечатка по Приложение № 4 (пейзаж, чл. 26)
- **КДБФ** — трите части (Приложения № 1, 2 и 3) за избраната година
- **Акт за отчисляване**, **Акт за дарение**, **Протокол за придобиване без документ** —
  от съответния екран (Отчисляване / Постъпления), с текст по чл. 6, 30 – 39 и подписи
- **Заявка за МЗС** — от формата на съществуваща заявка
- **Читателски картон** — бутон „Картон“ в списъка с читатели, включва история на заемания
- **Напомнителни писма** — от „Просрочени“, групирани по читател, с изчислено обезщетение
- **Баркод етикети за фонда** — един етикет съдържа **името на библиотеката, баркод
  (Code 39) и инвентарния номер**; печат по диапазон или за целия фонд
- **Етикети за сигнатура** — отделен етикет за гръбчето на книгата: УДК, авторски
  знак, име на библиотеката, баркод и инвентарен номер
- **Читателски карти** — баркод карти за всички активни читатели

Форматът на етикетите (A4 лист с 3 колони или ролков лейбъл принтер с точен размер
в мм) се задава веднъж в „Баркод етикети“ → „Формат на печат“ и важи за всички
следващи разпечатки.

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
settings(id=1, org, lib_name, place, bulstat, reg_no, director, director_role, librarian, cat_url,
         loan_days, max_books, extensions_count, extension_days, fine_per_day, annual_fee,
         free_access_pct, next_inv_number, committee1..3)
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

4. **app.js** — добавете нов запис в `NAV`/`TITLES`, функция `renderMyTable()`
   в обекта `renderers` в `route()`, и форма по образец на `bookForm`/`readerForm`.

## Как да добавя ново поле към книга (пример)

1. `db/schema.sql`: добавете колоната в `CREATE TABLE books (...)`.
2. `main.js`: добавете полето в `BOOK_SELECT`, `books:create` и `books:update`.
3. `src/app.js`: добавете `<input name="ново_поле">` в `bookForm()` и полето
   в `payload` в `saveBook()`.

## Забележка за обхвата на тази версия

Тази Electron версия пренася всички модули на `inventar-biblioteka.html`, с
едно съзнателно изключение: **автоматичното публикуване към chyavorec.org**
(git-sync конвейерът с `katalog.json`, GitHub и Task Scheduler) остава
изцяло в `inventar-biblioteka.html` — тази десктоп версия предлага само
локален еднократен JSON експорт вместо него (виж раздел „Онлайн каталог“ по-горе).

Не пренесени (защото са специфични за браузърната архитектура на другото
приложение, не за самата библиотечна дейност): криптиране на файла на диска,
File System Access API избор на папка, ротационни резервни копия в браузъра,
цветови теми. Печатът на официалните документи и етикети (виж по-горе) вече
е включен. Ако друго конкретно нещо ви трябва, кажете кое.
