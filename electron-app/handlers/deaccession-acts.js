// Отчисляване (актове) — извадени от main.js в отделен модул (Фаза 4,
// стъпка 15 от разбиването на монолита на модули по домейн). Зависи от
// BOOK_SELECT (по стойност, const низ) и scheduleCatalogWrite (по
// референция, функция дефинирана в main.js — отчисляването/анулирането
// сменят видимостта на документи в онлайн каталога, затова насрочват
// запис на katalog.json, точно както shelves.js).
const { isValidIsoDate, parseRegisterNo, resolveScannedBook } = require('../security-utils');
/* Покритието на начислението за изгубен документ се смята на ЕДНО място — в
   handlers/account.js, където живее и правилото „най-старото задължение първо“. */
const { chargeCoverage } = require('./account');

module.exports = function registerDeaccessionActsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, BOOK_SELECT, yearOf, scheduleCatalogWrite, flushCatalogWrite, normalizeScanCode } = deps;

  /* Кои заемания са били ПРИНУДИТЕЛНО закрити от акт за отчисляване. Без този
     белег анулирането на акта връщаше книгата „наличен“, но заемът оставаше
     закрит: книгата се водеше свободна и можеше да бъде заета на втори читател,
     докато реално е у първия. Датата на закриване не е достатъчна за разпознаване
     (книга, върната нормално в деня на акта, изглежда по същия начин), затова
     заемите се отбелязват изрично при закриването.
     Колоната се добавя тук, а не с миграция в main.js — модулът трябва да работи
     и когато е зареден самостоятелно (тестове), а ALTER TABLE ... ADD COLUMN е
     идемпотентно защитен с PRAGMA table_info, точно както ensureColumns() в
     main.js. Проверката е евтина и се прави само при запис/анулиране на акт. */
  let loanActColumnChecked = null;
  function ensureLoanActColumn(db) {
    if (loanActColumnChecked === db) return;
    const has = db.prepare('PRAGMA table_info(loans)').all().some(c => c.name === 'deaccession_act_id');
    if (!has) db.exec('ALTER TABLE loans ADD COLUMN deaccession_act_id INTEGER');
    /* Одит v2.4.24: анулирането връщаше ВСЕКИ документ на „наличен“, защото
       предишното състояние не се пазеше никъде. Най-честият ред по чл. 30, т. 6 е
       точно „липсващ“ (установен от инвентаризация) → отчислен: сгрешен акт,
       анулиран веднага, и книгата, която физически я няма, се обявява за налична —
       вижда се в публичния каталог (handlers/catalog.js) и може да се резервира
       (handlers/holds.js). Състоянието се снима в реда на акта, който и без това е
       снимка по чл. 35, ал. 2 (виж quantity в db/schema.sql). */
    const hasStatus = db.prepare('PRAGMA table_info(deaccession_items)').all().some(c => c.name === 'status_before');
    if (!hasStatus) db.exec('ALTER TABLE deaccession_items ADD COLUMN status_before TEXT');
    /* Същият белег и върху резервациите (v2.4.54), но с ДРУГА цел от тази при
       заеманията — и разликата е нарочна.

       Заемането, закрито от акт, се ОТВАРЯ ОБРАТНО при анулиране: книгата реално
       е у читателя и следата, че я държи, не бива да изчезва. Резервацията НЕ се
       възкресява: това е решено в по-ранен кръг („одит #10, обратна посока“,
       test/reaudit-v24-b.test.js) и остава в сила — анулирането поправя регистъра,
       а не връща времето в читалнята; читателят, на когото е казано, че книгата
       я няма, не бива да се озове пак на опашка, която не е поставял.

       Счупеното беше друго: резервацията изчезваше БЕЗСЛЕДНО. Никъде не пишеше
       кой акт я е отказал, екранът „Резервации“ не я показва (там са само
       активните), а одитната следа при анулиране твърдеше „документите са върнати
       във фонда“ — и нищо повече. Библиотекарката нямаше как да научи, че нечия
       резервация е паднала, камо ли да реши дали да я поднови. Затова резервацията
       носи номера на акта и снимка на предишното си състояние: при анулиране
       следата КАЗВА колко резервации е отказал актът и че те остават отказани. */
    const holdCols = db.prepare('PRAGMA table_info(holds)').all();
    if (!holdCols.some(c => c.name === 'deaccession_act_id')) db.exec('ALTER TABLE holds ADD COLUMN deaccession_act_id INTEGER');
    if (!holdCols.some(c => c.name === 'status_before')) db.exec('ALTER TABLE holds ADD COLUMN status_before TEXT');
    /* ВИТРИНИТЕ — ТОЧНО ОГЛЕДАЛНИЯТ СЛУЧАЙ НА РЕЗЕРВАЦИИТЕ (v2.4.57).
       =================================================================
       Дотук отчисляването НЕ пипаше catalog_shelf_items. Забелязва се така:
       документ във витрина „Класика“ се отчислява с утвърден акт, и след това

         • shelves:list продължава да казва „Класика (2)“;
         • shelves:items показва отчисления документ като редови член на витрината;
         • публичният katalog.json го изхвърля (buildCatalogPayload в main.js
           публикува само status != 'отчислен'), тоест витрината на сайта излиза
           с 1 книга.

       Библиотекарката вижда 2, посетителят на сайта вижда 1, и нищо никъде не
       казва защо. Дупката е СЪЩАТА като при резервациите и е пробита от същата
       страна: shelves:addBook отказва отчислен документ (с цели три различни
       съобщения — отчислен, без статус, служебен), тоест грижата съществува по
       пътя „първо отчислен, после във витрина“, а обратният път — „първо във
       витрина, после отчислен“ — стоеше отворен.

       Оттук нататък съставянето на акта МАХА документа от всички витрини. Кои
       са били те се запомня в реда на акта (както status_before), а не само в
       одитната следа: витрината е подбор, правен от човек, и при анулиране на
       акта някой трябва да може да прочете какво да върне обратно. Автоматично
       НЕ се връща — по същата причина, по която не се връщат и резервациите:
       анулирането поправя регистъра, а не пресъздава подбора на библиотекаря. */
    const itemCols = db.prepare('PRAGMA table_info(deaccession_items)').all();
    if (!itemCols.some(c => c.name === 'shelves_before')) db.exec('ALTER TABLE deaccession_items ADD COLUMN shelves_before TEXT');
    /* АКТЪТ Е ДОКУМЕНТ, НЕ ЗАПИС В ПРОГРАМАТА (v2.4.56).
       =================================================================
       Дотук „анулиране“ означаваше DELETE FROM deaccession_acts, а редовете на
       акта падаха след него по ON DELETE CASCADE. Това противоречи на Наредба
       № 3 в три отделни точки наведнъж:

         чл. 35 — актът се съставя от комисия (библиотекар и счетоводител), в ДВА
           екземпляра, и се УТВЪРЖДАВА от ръководителя. Подписаният екземпляр е в
           счетоводството и никакво действие в програмата не може да го отмени;
         чл. 35 — „актовете се номерират, като започват всяка календарна година
           от номер едно“. След триене nextNo (MAX(no)+1) връщаше освободения
           номер на СЪВСЕМ ДРУГ акт — два различни подписани акта № 9/2026;
         чл. 39 — документацията по отчисляването се съхранява. А тук тя се
           изтриваше, при това заедно със снимката по чл. 35, ал. 2.

       Практическата последица: КДБФ Приложение № 3 за минала година, вече
       отпечатано и подписано, при следващ печат излизаше различно.

       Оттук нататък актът НЕ се трие никога. Анулирането само го отбелязва:
       редът остава, номерът остава зает, редовете (снимката) остават, а КДБФ
       Част № 3 го показва зачертан, с бележка и с нула в сборовете.

       Другата половина на поправката е ПРОЕКТЪТ (виж deaccession_drafts
       по-долу): щом актът е вечен, трябва да има къде да се сгреши, преди да
       стане документ. Дотук нямаше — един клик върху „Утвърди акта и отчисли“
       и сгрешеният акт вече беше съставен, тоест триенето беше ЕДИНСТВЕНАТА
       поправка. Затова точно то се е ползвало. */
    const actCols = db.prepare('PRAGMA table_info(deaccession_acts)').all();
    if (!actCols.some(c => c.name === 'revoked_at')) db.exec('ALTER TABLE deaccession_acts ADD COLUMN revoked_at TEXT');
    if (!actCols.some(c => c.name === 'revoke_reason')) db.exec('ALTER TABLE deaccession_acts ADD COLUMN revoke_reason TEXT');
    if (!actCols.some(c => c.name === 'revoked_by')) db.exec('ALTER TABLE deaccession_acts ADD COLUMN revoked_by TEXT');
    /* Проектът живее в СВОЯ таблица, не като ред в deaccession_acts с празен
       номер. Причината е практична: „акт“ се чете от шест места (КДБФ, таблото,
       статистиката, инвентарната книга, справките), а deaccession_acts.no е
       NOT NULL в схемата и не може да стане NULL без пренаписване на таблицата
       в бази, които вече работят. Отделната таблица оставя всичките шест места
       непокътнати: проект просто не съществува за тях — както и в живота.
       Снимката по чл. 35, ал. 2 се прави в мига на УТВЪРЖДАВАНЕТО, не по-рано:
       дотогава документите са си във фонда и могат да се променят. */
    db.exec(`
      CREATE TABLE IF NOT EXISTS deaccession_drafts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT,
        order_no    TEXT,
        reason_code INTEGER,
        reason_text TEXT,
        disposal    TEXT,
        attach      TEXT,
        committee1  TEXT,
        committee2  TEXT,
        committee3  TEXT,
        note        TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS deaccession_draft_items (
        draft_id INTEGER NOT NULL REFERENCES deaccession_drafts(id) ON DELETE CASCADE,
        book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        PRIMARY KEY (draft_id, book_id)
      );
    `);
    loanActColumnChecked = db;
  }

  /* Утвърден и НЕанулиран — това и само това е „акт“ за всички сборове.
     Условието „revoked_at IS NULL“ е дублирано (нарочно, не по грешка) в
     handlers/kdbf.js, handlers/stats.js (два пъти) и handlers/dashboard.js —
     всяко от тях държи собствена SQL заявка и не internal-import-ва оттук.
     (По-рано тук стоеше неизползвана локална константа ACT_LIVE с коментар,
     който твърдеше обратното — премахната при прегледа за v2.4.57.) */

  /* „Отчислен с акт“ = има акт или дата на отчисляване. Самият статус не стига:
     редове със status='отчислен' без акт идват от внос на стара таблица и по
     чл. 35, ал. 2 НЕ са отчислени — тепърва им трябва акт. */
  const deaccessionedByAct = (b) => b.deaccession_act_id != null || b.deaccession_date != null;

  /* Последното приключено като „изгубен“ заемане на този документ, заедно с
     покритието на начислението. Чете се през handlers/account.js, защото там
     живее правилото „най-старото задължение се плаща първо“ — второ копие тук
     би се разминало с касата при първата промяна. Колоните може да липсват в
     база, която още не е минала през handlers/loans.js, затова проверката е
     защитена и при липса просто не се показва нищо. */
  function lostInfo(db, bookId) {
    try {
      const cols = db.prepare('PRAGMA table_info(loans)').all();
      if (!cols.some(c => c.name === 'lost')) return null;
      const row = db.prepare(`
        SELECT l.lost_date, l.lost_resolution, l.lost_amount, l.lost_account_line_id,
               l.lost_replacement_note, r.name AS reader_name
        FROM loans l LEFT JOIN readers r ON r.id = l.reader_id
        WHERE l.book_id = ? AND COALESCE(l.lost,0) = 1
        ORDER BY l.lost_date DESC, l.id DESC LIMIT 1`).get(bookId);
      if (!row) return null;
      if (row.lost_account_line_id && chargeCoverage) {
        row.charge = chargeCoverage(db, row.lost_account_line_id);
      }
      return row;
    } catch (err) {
      /* Не бива да блокира съставянето на акт: без тази допълнителна бележка
         актът е верен, просто по-беден. Следата казва защо липсва. */
      logAudit('Отчисляване', 'ВНИМАНИЕ: данните за изгубения документ не можаха да се прочетат: ' + err.message);
      return null;
    }
  }

  ipcMain.handle('deaccessionActs:list', () =>
    run(() => getDb().prepare(`
      SELECT a.*, (SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) FROM deaccession_items i WHERE i.act_id = a.id) AS item_count,
             (SELECT COALESCE(SUM(i.price * COALESCE(i.quantity,1)),0) FROM deaccession_items i WHERE i.act_id = a.id) AS item_value
      FROM deaccession_acts a ORDER BY a.date DESC, a.no DESC
    `).all())
  );
  ipcMain.handle('deaccessionActs:get', (e, id) =>
    run(() => {
      const db = getDb();
      /* Колоните deaccession_act_id/status_before върху holds и shelves_before
         върху deaccession_items се добавят от ensureLoanActColumn. Четящият път
         дотук не го викаше, защото не му трябваха; сега му трябват, а базата може
         да е отворена и прегледана, без изобщо да е съставян акт. Проверката е
         евтина и се помни за живота на връзката към базата. */
      ensureLoanActColumn(db);
      const act = db.prepare('SELECT * FROM deaccession_acts WHERE id = ?').get(id);
      if (!act) return null;
      act.items = db.prepare('SELECT * FROM deaccession_items WHERE act_id = ? ORDER BY inv_number').all(id);
      /* ЧИТАТЕЛИТЕ, ЧИИТО РЕЗЕРВАЦИИ Е ОТКАЗАЛ ТОЗИ АКТ (v2.4.57).
         Дотук актът се четеше само като списък от инвентарни номера, а хората
         зад тях нямаше къде да се видят: holds:list показва само активните
         резервации, тоест отказаната изчезва от екрана в мига на отчисляването.
         Затова прегледът на акта носи и тях — с име, карта и телефон, за да може
         библиотекарката да вдигне телефона, а не да чака читателят да дойде за
         книга, която вече не съществува. Чете се от самите редове в holds, а не
         от снимка: те носят номера на акта (deaccession_act_id) още от v2.4.54.
         Читател или документ, изтрит междувременно, отпада от списъка — затова
         JOIN, а не LEFT JOIN: ред без име и без книга не помага на никого. */
      act.holds = db.prepare(`
        SELECT h.id, h.status, h.status_before, h.placed_at, h.resolved_at,
               b.inv_number, b.title, b.author,
               r.id AS reader_id, r.name AS reader_name, r.card_no, r.phone
        FROM holds h
        JOIN books b ON b.id = h.book_id
        JOIN readers r ON r.id = h.reader_id
        WHERE h.deaccession_act_id = ?
        ORDER BY h.placed_at, h.id
      `).all(id);
      return act;
    })
  );
  ipcMain.handle('deaccessionActs:nextNo', (e, year) =>
    run(() => {
      const y = year || yearOf();
      const row = getDb().prepare('SELECT MAX(no) AS m FROM deaccession_acts WHERE year = ?').get(y);
      return (row.m || 0) + 1;
    })
  );
  // normalizeScanCode() (v1.70.1) — виж books:byBarcode в handlers/books.js за
  // обяснението на кирилско/латинско разминаване при баркод четец.
  /* fund_qty се връща ДОПЪЛНИТЕЛНО към b.quantity и е СУРОВАТА стойност от
     inventory (може да е NULL). Двете броят различни неща и не бива да се
     смесват: b.quantity е COALESCE(i.quantity, 0) и служи за наличността
     („заета ли е в момента“), докато ОТЧЕТНАТА бройка чете NULL като 1 документ
     (стара база без ред в inventory) и изричната 0 като 0 — точно както прави
     снимката в deaccessionActs:create по-долу (invQty.get). Затова се чете със
     същата заявка, а не през BOOK_SELECT.

     Одит v2.4.14: екранът, на който актът се СЪСТАВЯ, броеше заглавия и събираше
     единични цени, докато самият акт, разпечатката и КДБФ броят документи — три
     заглавия по три екземпляра се виждаха като „3 документа, 30 лв.“ и се
     утвърждаваха като 9 документа за 90 лв. Оттук нататък екранът разполага със
     същото число, което ще влезе в акта. */
  ipcMain.handle('deaccessionActs:findBook', (e, code) => run(() => {
    const c = normalizeScanCode(code);
    const db = getDb();
    /* Одит v2.4.24 — виж resolveScannedBook() в security-utils.js. Тук цената на
       мълчаливото гадаене е най-висока: числов баркод, съвпадащ с чужд инвентарен
       номер, вкарваше в АКТ ЗА ОТЧИСЛЯВАНЕ друг документ, а сканираният оставаше
       във фонда. Филтърът „не е отчислен" се прилага след намирането, за да не
       се превърне отчисленият документ в „непознат баркод". */
    const b = c ? resolveScannedBook(db, c, BOOK_SELECT) : null;
    /* Отчислен С АКТ не влиза във втори акт. Отчислен БЕЗ акт (внесен от стара
       таблица — виж books:deaccessionedWithoutAct) влиза: „Проверка на данните“
       съветва „съставете акт от Отчисляване“, а дотук това поле отказваше точно
       него с „Няма документ с баркод/инв. №“ — задънена улица (одит v2.4.25). */
    if (!b || deaccessionedByAct(b)) return undefined;
    const q = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(b.id);
    b.fund_qty = q ? q.quantity : null;
    /* Ако документът е приключен като ИЗГУБЕН (v2.4.56), актът по чл. 30, т. 5
       трябва да носи и това: кой читател го е изгубил, какво е уредено (пари или
       замяна) и дали обезщетението е СЪБРАНО. Дотук трите неща се правеха като
       три несвързани действия и никъде не оставаше, че този акт е покрит с
       обезщетение — а точно това пита счетоводството, когато приеме акта. */
    b.lost = lostInfo(db, b.id);
    return b;
  }));
  /* Съставянето е ИЗНЕСЕНО във функция (v2.4.56), за да може утвърждаването на
     проект да мине през ТОЧНО същия код — същите проверки, същата снимка по
     чл. 35, ал. 2, същият номер, същата следа. Втора, „почти същата“ пътека за
     утвърждаване е най-сигурният начин двата пътя да се разминат след година. */
  function createActCore(db, act, bookIds) {
      /* Реадит след v2.4.0 (доп. находка): act.date влизаше НЕВАЛИДИРАНА право в
         loans.date_in, books.status_date и books.deaccession_date — точно
         същата дупка, която isValidIsoDate() (security-utils.js, одит v2.3.1)
         вече затваря при loans:checkout/return. Доказано изпълнимо на практика:
         буквален боклук низ ('НЕВАЛИДНА-ДАТА-99-99') се записваше безпроблемно
         в тези колони. Проверката е тук, ПРЕДИ транзакцията да пипне базата —
         както при loans.js — за да не се налага частично отменяне. */
      if (!isValidIsoDate(act.date)) throw new Error('Датата на акта липсва или е невалидна.');
      /* Причината е ЗАДЪЛЖИТЕЛНА (одит v2.4.25): parseInt('') е NaN, better-sqlite3 го
         записва като NULL, и актът — документ, който се подписва от комисията и отива
         в счетоводството — печаташе „на основание чл. 30, т. null“. Точно една причина
         от т. 1 – 8 на чл. 30. Проверката е тук, преди транзакцията, като при датата. */
      const reasonCode = parseInt(act.reason_code, 10);
      if (!Number.isInteger(reasonCode) || reasonCode < 1 || reasonCode > 8 || String(act.reason_code).trim() === '') {
        throw new Error('Причината за отчисляване е задължителна — изберете точка от чл. 30.');
      }
      if (!act.reason_text || !String(act.reason_text).trim()) {
        throw new Error('Причината за отчисляване е без текст — изберете я отново от списъка.');
      }
      /* ПРАЗЕН АКТ НЕ Е АКТ (v2.4.58).
         Чл. 35, ал. 2 изисква актът да съдържа списъка на отчислените
         екземпляри — акт с нула документа е подписан документ без предмет.
         Проверката СЪЩЕСТВУВАШЕ, но само на два от трите пътя: екранът я прави
         и за прекия акт, и за проекта („Добавете поне един документ в списъка“,
         src/views/deaccession-acts.js), а handler-ът — само в approveDraft.
         Тоест deaccessionActs:create приемаше bookIds: [] и съставяше акт с
         0 реда. Цената не е козметична: номерът се взима при съставянето и
         остава зает ЗАВИНАГИ (чл. 35 — номерата текат последователно, а от
         v2.4.56 анулирането не освобождава номер), редът влиза в КДБФ
         Приложение № 3, а по чл. 39 актът не се трие никога. Един празен акт
         значи дупка в поредицата на официалния регистър, която не може да се
         обясни с нищо и не може да се премахне.
         Мястото е ТУК, а не в двата канала поотделно: createActCore е общата
         функция и на прекия акт, и на утвърждаването на проект — същата
         причина, поради която в този кръг фондовите условия се събраха в
         db/fund-sql.js. approveDraft си запазва своята, по-точна проверка
         (там списъкът може да е непразен, но целият вече отчислен). */
      if (!Array.isArray(bookIds) || bookIds.length === 0) {
        throw new Error('Актът няма нито един документ. Чл. 35, ал. 2 изисква списък на отчислените '
          + 'екземпляри, а номерът на акта се заема завинаги — добавете поне един документ в списъка.');
      }
      const no = parseRegisterNo(act.no, 'Акт №');
      const year = yearOf(act.date);
      const tx = db.transaction(() => {
        /* Номерът на акта се предлага с MAX(no)+1 при ОТВАРЯНЕ на формата, а
           schema.sql няма UNIQUE(year, no) (не може да се добави наготово —
           съществуващи бази вече може да имат дубликати и миграцията би счупила
           стартирането). При два компютъра към една мрежова база (изрично
           поддържан режим) и двамата получават № 5 и записват два акта № 5/2026.
           Затова номерът се проверява ОТНОВО тук, в самата транзакция на записа;
           транзакцията се пуска с .immediate() (виж долу) — правото на запис се
           взима ПРЕДИ проверката, така че между проверката и INSERT-а никой друг
           не може да вмъкне същия номер. */
        if (db.prepare('SELECT 1 FROM deaccession_acts WHERE year = ? AND no = ?').get(year, no)) {
          throw new Error('Акт № ' + no + '/' + year + ' вече съществува — най-вероятно е създаден от друго работно място '
            + 'към същата база. Затворете и отворете формата отново, за да получите следващия свободен номер.');
        }
        const info = db.prepare(`
          INSERT INTO deaccession_acts (no, year, date, order_no, reason_code, reason_text, disposal, attach, committee1, committee2, committee3)
          VALUES (@no, @year, @date, @order_no, @reason_code, @reason_text, @disposal, @attach, @committee1, @committee2, @committee3)
        `).run({
          no, year, date: act.date, order_no: act.order_no || null,
          reason_code: reasonCode, reason_text: String(act.reason_text).trim(),
          disposal: act.disposal || null, attach: act.attach || null,
          committee1: act.committee1 || null, committee2: act.committee2 || null, committee3: act.committee3 || null
        });
        const actId = info.lastInsertRowid;
        const insItem = db.prepare(`
          INSERT INTO deaccession_items (act_id, book_id, inv_number, author, title, volume, year, price, udk, category, language, quantity, status_before, shelves_before)
          VALUES (@act_id, @book_id, @inv_number, @author, @title, @volume, @year, @price, @udk, @category, @language, @quantity, @status_before, @shelves_before)
        `);
        /* Витрините на документа — прочитат се ПРЕДИ да бъдат изтрити (виж дългата
           бележка при ensureLoanActColumn). Имената, а не номерата: редът на акта е
           документ и трябва да се чете и след като витрината бъде преименувана или
           изтрита. */
        const shelvesOf = db.prepare(`
          SELECT sh.name FROM catalog_shelf_items si
          JOIN catalog_shelves sh ON sh.id = si.shelf_id
          WHERE si.book_id = ? ORDER BY sh.sort, sh.name
        `);
        const dropFromShelves = db.prepare('DELETE FROM catalog_shelf_items WHERE book_id = ?');
        let shelfRows = 0;
        const shelfNames = new Set();
        // Принудително закритите заемания се отбелязват с номера на акта — за да
        // може анулирането да ги отвори обратно (виж deaccessionActs:revoke).
        const closeLoans = db.prepare(`UPDATE loans SET date_in = ?, deaccession_act_id = ? WHERE book_id = ? AND date_in IS NULL`);
        /* Одит v2.3.1 №10: НОВА резервация върху вече отчислена книга правилно се
           отказва (holds:add проверява статуса в JS, виж handlers/holds.js), но обратният път —
           книгата Е БИЛА резервирана и СЛЕД това се отчислява — оставаше пробит:
           редът в holds си стоеше 'чака'/'заделена' завинаги, а чакащият читател
           никога не биваше уведомен, че резервираната книга вече не съществува във
           фонда. Активните резервации ('чака','заделена' — виж handlers/holds.js:
           HOLD_ACTIVE) на всеки отчислен документ се отказват тук изрично, със
           същия статус 'отказана', който ползва holds:cancel. */
        /* Запомня се И предишното състояние, и актът: „чака“ и „заделена“ не са
           едно и също — заделената книга стои на рафта с името на читателя. */
        const cancelHolds = db.prepare(`
          UPDATE holds SET status = 'отказана', resolved_at = datetime('now'),
            deaccession_act_id = @act, status_before = status
          WHERE book_id = @book AND status IN ('чака','заделена')
        `);
        /* ЧИТАТЕЛЯТ, КОЙТО Е ЧАКАЛ, СЕ НАЗОВАВА ПОИМЕННО (v2.4.57).
           ===============================================================
           Предишният кръг затвори дупката „резервацията остава жива върху
           отчислен документ“ и сложи брояч в одитната следа. Останалото
           счупено беше по-просто и по-скъпо: НИКОЙ ЧОВЕК НЕ НАУЧАВА.
           createActCore връщаше само actId, броят отказани резервации отиваше
           единствено в дневника, holds:list показва само активните (отказаната
           изчезва от екрана още същата секунда), а прозорецът след акта казваше
           „отчислени са N документа“ и нищо повече. Тоест при АНУЛИРАНЕ на акт
           програмата изрично предупреждава „N резервации остават отказани —
           подновете ги“, а по пътя, в който резервациите РЕАЛНО падат, мълчи.

           За читалището това е единственият път, по който човекът, дошъл след
           две седмици за резервираната книга, може да бъде предупреден по-рано.
           Затова редовете се СНИМАТ преди отказването — с име, номер на карта и
           телефон (същите полета, които holds:list вече връща през HOLD_SELECT) —
           и се връщат на прозореца като списък „обадете се на…“.

           Четат се ПРЕДИ UPDATE-а: след него status вече е 'отказана' и филтърът
           по активните не би ги намерил. Заглавието и инв. № идват от books още
           сега, защото след акта документът е отчислен и списъкът трябва да
           казва ЗА КОЯ книга е бил редът. */
        const holdsOf = db.prepare(`
          SELECT h.id, h.status AS status_before, h.placed_at,
                 b.inv_number, b.title, b.author,
                 r.id AS reader_id, r.name AS reader_name, r.card_no, r.phone
          FROM holds h
          JOIN books b ON b.id = h.book_id
          JOIN readers r ON r.id = h.reader_id
          WHERE h.book_id = ? AND h.status IN ('чака','заделена')
          ORDER BY h.placed_at, h.id
        `);
        let cancelledHolds = 0;
        const cancelledHoldRows = [];
        /* Отчетната бройка на всеки документ, с разграничение между „липсващ ред“
           и „изрично нула“ — виж бележката при quantity по-долу. */
        const qStmt = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?');
        const invQty = { get: (id) => { const r = qStmt.get(id); return r ? r.quantity : 1; } };
        /* Одитната следа брои СЪЩОТО, което брои актът. Дотук тук отиваше
           bookIds.length, тоест заглавия: списъкът „Отчисляване“, прегледът,
           разпечатката и КДБФ казваха 9, а следата, която инспекторът чете, за да
           възстанови какво се е случило — 3. */
        let docCount = 0;
        /* Сглобена ВЕДНЪЖ, извън обхождането — както qStmt точно отгоре. Дотук
           стоеше вътре в него: BOOK_SELECT е дълга заявка с присъединяване и
           подзаявка, а акт за отчисляване на цял остарял раздел носи хиляди
           номера. Измерено при 2 000 документа: 223 ms за съставянето на акта. */
        const bookStmt = db.prepare(`${BOOK_SELECT} WHERE b.id = ?`);
        /* И тази — последната, останала вътре в обхождането след кръга v2.4.48
           (проверка при прегледа): точно правилото, което кръгът въвежда, беше
           нарушено в самото обхождане, което поправя. */
        const offStmt = db.prepare(`UPDATE books SET status = ?, status_date = ?,
          deaccession_act_id = ?, deaccession_date = ? WHERE id = ?`);
        bookIds.forEach(bookId => {
          const b = bookStmt.get(bookId);
          /* Одит v2.4.24: дотук липсващият ред просто се ПРОПУСКАШЕ (`if (!b) return`).
             Другото работно място може да изтрие документа, докато формата стои
             отворена (handlers/books.js спира само вече отчислените) — актът се
             утвърждаваше с един документ по-малко, прозорецът обявяваше „отчислени
             са 2 документа“, а следата вписваше разликата като „(2 заглавия)“, тоест
             като стар многоекземплярен ред. Подписаният акт излизаше от библиотеката
             с друго съдържание. По-добре отказ, отколкото тих недоимък. */
          if (!b) throw new Error('Документ от списъка вече не съществува в базата — вероятно е изтрит от друго '
            + 'работно място. Актът НЕ е съставен. Отворете „Отчисляване“ наново и подберете документите отново.');
          /* Същата причина, огледално: филтърът „не е отчислен“ живее само в
             deaccessionActs:findBook, тоест в сканирането, и остарява, докато формата
             е отворена. Без тази проверка един и същи инв. № влизаше в ДВА акта —
             КДБФ (Приложение № 3) отчиташе два документа и двойна стойност излизаше
             от фонда, а Приложение № 2 показваше завишена наличност към 01.01. */
          if (deaccessionedByAct(b)) {
            throw new Error('Инв. № ' + b.inv_number + ' вече е отчислен с акт — вероятно от друго работно място, '
              + 'докато формата е била отворена. Актът НЕ е съставен. Отворете „Отчисляване“ наново.');
          }
          insItem.run({
            act_id: actId, book_id: b.id, inv_number: b.inv_number, author: b.author, title: b.title,
            volume: b.volume, year: b.year, price: b.price, udk: b.udk,
            category: b.category_name, language: b.language,
            /* Бройките се СНИМАТ тук, а не се четат живо от inventory при всяко
               отваряне на КДБФ: редът в deaccession_items е документ по чл. 35,
               ал. 2 и не бива да се променя със задна дата, ако някой редактира
               „Налични бройки" или изтрие документа години по-късно.
               Стойността се чете ПРЯКО от inventory, а не от b.quantity на
               BOOK_SELECT: там е COALESCE(i.quantity, 0) и не различава „няма ред
               в inventory“ (стара база → 1 документ) от „библиотекарят е въвел
               изрично 0 бройки“ (→ 0). Слети в едно, вторият случай изваждаше от
               КДБФ документ, който фондът никога не е броял. Същото разграничение
               като fund_qty в handlers/acquisitions.js. */
            quantity: invQty.get(b.id),
            // Състоянието ПРЕДИ отчисляването — за да може анулирането да го върне
            // (виж ensureLoanActColumn по-горе).
            status_before: b.status || null,
            // Витрините ПРЕДИ отчисляването — по същата причина, но за подбора в
            // онлайн каталога (виж ensureLoanActColumn). Четат се тук, редът по-долу
            // ги изтрива.
            shelves_before: (() => {
              const names = shelvesOf.all(b.id).map(r => r.name);
              names.forEach(n => shelfNames.add(n));
              shelfRows += names.length;
              return names.length ? names.join('; ') : null;
            })()
          });
          docCount += invQty.get(b.id) == null ? 1 : (Number(invQty.get(b.id)) || 0);
          offStmt.run('отчислен', act.date, actId, act.date, b.id);
          closeLoans.run(act.date, actId, b.id);
          /* Витрината се празни СЛЕД като снимката е записана в реда на акта. */
          dropFromShelves.run(b.id);
          cancelledHoldRows.push(...holdsOf.all(b.id));
          cancelledHolds += cancelHolds.run({ act: actId, book: b.id }).changes;
        });
        db.prepare('UPDATE settings SET committee1=?, committee2=?, committee3=? WHERE id=1')
          .run(act.committee1 || null, act.committee2 || null, act.committee3 || null);
        // `no`, а не `act.no`: parseRegisterNo() вече е нормализирал „007“ до 7 —
        // следата трябва да сочи номера, който Е ВПИСАН в регистъра.
        /* Изгубените документи в акта се назовават поименно в следата (v2.4.56):
           „акт по чл. 30, т. 5“ и „има начислено обезщетение, събрано/несъбрано“
           са двете страни на едно и също събитие и дотук не се срещаха никъде. */
        const lostLines = bookIds.map(id => lostInfo(db, id)).filter(Boolean);
        const lostNote = lostLines.length
          ? '; изгубени от читатели: ' + lostLines.length + ' — ' + lostLines.map(l =>
              (l.reader_name || 'читател') + ': ' + (l.lost_resolution || 'уреждане неотбелязано')
              + (l.charge
                  ? ' (начислено ' + (l.charge.charged || 0).toFixed(2) + ' €, събрано '
                    + (l.charge.covered || 0).toFixed(2) + ' €)'
                  : (l.lost_amount ? ' (начислението е изтрито от сметката)' : ''))).join('; ')
          : '';
        logAudit('Отчисляване', 'акт № ' + no + '/' + year + ' — ' + docCount + (docCount === 1 ? ' документ' : ' документа')
          + (docCount !== bookIds.length ? ' (' + bookIds.length + ' заглавия)' : '')
          + ', причина: ' + act.reason_text
          /* Следата назовава и ЧИТАТЕЛИТЕ, не само броя (v2.4.57): дневникът е
             мястото, което библиотекарката чете на другия ден, а прозорецът се
             затваря. Телефонът НЕ влиза тук — дневникът се изнася и се разпечатва,
             а за обаждането името и номерът на картата стигат, за да се намери
             читателят в „Читатели“. */
          + (cancelledHolds ? (' (' + (cancelledHolds === 1 ? 'отказана 1 резервация' : 'отказани ' + cancelledHolds + ' резервации') + ' на отчислените документи'
              + (cancelledHoldRows.length
                  ? ': ' + cancelledHoldRows.map(h => (h.reader_name || 'читател')
                      + (h.card_no ? ' (карта ' + h.card_no + ')' : '')
                      + ' — инв. № ' + (h.inv_number ?? '—')).join('; ')
                  : '') + ')') : '')
          + (shelfRows ? '; документите излизат от витрините в онлайн каталога ('
              + [...shelfNames].join('; ') + ') — при анулиране НЕ се връщат автоматично' : '')
          + lostNote);
        /* Връща се ОБЕКТ, а не само actId (v2.4.57). Самите IPC обработчици
           продължават да връщат голото число — така се пази договорът с
           прозореца и с тестовете — но вътрешно съставянето трябва да може да
           каже КОЙ е чакал, за да стигне това до екрана. */
        return { actId, holds: cancelledHoldRows, shelfRows, shelfNames: [...shelfNames] };
      });
      // .immediate() — виж проверката на номера в транзакцията по-горе. Когато
      // createActCore се вика ОТВЪТРЕ в чужда транзакция (утвърждаване на проект),
      // better-sqlite3 я превръща в savepoint и режимът се пренебрегва — точно
      // каквото е нужно: актът и изтриването на проекта падат или минават заедно.
      return tx.immediate();
  }
  /* Записът на каталога след съставяне на акт — общ за двата пътя. */
  function afterActWritten(act) {
      /* Одит v2.3.1 №26: библиотека с точно 1 (последна) книга — отчисляването ѝ
         прави фонда празен, а предпазната мярка в main.js (writeCatalogIfConfigured:
         "не презаписвай непразен публикуван каталог с празен") коректно отказва
         записа — но само с console.error, невидим за библиотекаря. scheduleCatalogWrite()
         е debounced (насрочва запис след 4 сек., резултатът се губи мълчаливо); тук
         записът се извиква СИНХРОННО (flushCatalogWrite, ако е подаден — старите
         тестове без него продължават с debounced поведение), за да можем да прочетем
         резултата веднага и да оставим следа в дневника, четим от библиотекаря
         (Дневник/audit_log), вместо само в конзолата, която той никога не вижда. */
      const w = flushCatalogWrite ? flushCatalogWrite() : (scheduleCatalogWrite(), null);
      if (w && w.blocked) {
        logAudit('Онлайн каталог', 'ВНИМАНИЕ: записът на каталога след отчисляване на акт № ' + act.no
          + ' е спрян — фондът излиза празен, а публикуваният каталог не е. '
          + 'Използвайте „Ръчен запис“ в „Онлайн каталог“, ако наистина искате празен каталог.');
      } else if (w && !w.written) {
        logAudit('Онлайн каталог', 'ВНИМАНИЕ: записът на каталога след отчисляване на акт № ' + act.no
          + ' не успя' + (w.error ? ': ' + w.error : '.') + ' Проверете папката за онлайн каталога в „Настройки“.');
      }
  }
  ipcMain.handle('deaccessionActs:create', (e, { act, bookIds }) =>
    run(() => {
      const db = getDb();
      ensureLoanActColumn(db);
      /* Каналът продължава да връща ГОЛОТО id на акта. Поименният списък на
         чакалите читатели пътува до прозореца през deaccessionActs:get (виж
         бележката там): така не се пипа договорът на канала, а сведението е
         ТРАЙНО — може да се прочете и след седмица, при отваряне на акта, а не
         само в едно съобщение, което библиотекарката може да не е видяла. */
      const res = createActCore(db, act, bookIds);
      afterActWritten(act);
      return res.actId;
    })
  );
  /* ---------- ПРОЕКТ НА АКТ (v2.4.56) ----------
     Проектът НЕ е документ: няма номер, нищо не е отчислено, документите стоят
     във фонда и се заемат нормално. Може да се поправя и да се изтрива свободно,
     защото нищо не е излизало от библиотеката. Става акт едва при „Утвърди“ —
     тогава и само тогава се взима номер и се прави снимката по чл. 35, ал. 2.
     Това е половината от поправката „актът не се трие“: щом актът е вечен,
     грешките трябва да имат къде да се случат преди него. */
  const DRAFT_FIELDS = ['date', 'order_no', 'reason_code', 'reason_text', 'disposal',
    'attach', 'committee1', 'committee2', 'committee3', 'note'];
  ipcMain.handle('deaccessionActs:drafts', () =>
    run(() => {
      const db = getDb();
      ensureLoanActColumn(db);
      return db.prepare(`
        SELECT d.*, (SELECT COUNT(*) FROM deaccession_draft_items i WHERE i.draft_id = d.id) AS title_count
        FROM deaccession_drafts d ORDER BY d.updated_at DESC
      `).all();
    })
  );
  ipcMain.handle('deaccessionActs:getDraft', (e, id) =>
    run(() => {
      const db = getDb();
      ensureLoanActColumn(db);
      const d = db.prepare('SELECT * FROM deaccession_drafts WHERE id = ?').get(id);
      if (!d) return null;
      /* Документите се четат ЖИВО от фонда, не от снимка — проектът още не е
         документ и трябва да показва днешното състояние. Ако междувременно
         някой е отчислил документ с друг акт, редът изчезва оттук сам. */
      d.items = db.prepare(`
        SELECT b.* FROM deaccession_draft_items i JOIN (${BOOK_SELECT}) b ON b.id = i.book_id
        WHERE i.draft_id = ? ORDER BY b.inv_number
      `).all(id).filter(b => !deaccessionedByAct(b));
      return d;
    })
  );
  ipcMain.handle('deaccessionActs:saveDraft', (e, { id, draft, bookIds }) =>
    run(() => {
      const db = getDb();
      ensureLoanActColumn(db);
      const ids = Array.isArray(bookIds) ? bookIds : [];
      /* Проектът се записва и НЕПЪЛЕН — това му е работата. Проверките по
         чл. 30 и чл. 35 (дата, причина, номер) се правят при утвърждаването. */
      const vals = {};
      DRAFT_FIELDS.forEach(k => { vals[k] = (draft && draft[k] !== undefined && draft[k] !== '') ? draft[k] : null; });
      const tx = db.transaction(() => {
        let draftId = id;
        if (draftId) {
          const ok = db.prepare(`UPDATE deaccession_drafts SET
            date=@date, order_no=@order_no, reason_code=@reason_code, reason_text=@reason_text,
            disposal=@disposal, attach=@attach, committee1=@committee1, committee2=@committee2,
            committee3=@committee3, note=@note, updated_at=datetime('now') WHERE id=@id`)
            .run(Object.assign({ id: draftId }, vals)).changes;
          if (!ok) throw new Error('Проектът вече не съществува — вероятно е утвърден или изтрит от друго работно място.');
          db.prepare('DELETE FROM deaccession_draft_items WHERE draft_id = ?').run(draftId);
        } else {
          draftId = db.prepare(`INSERT INTO deaccession_drafts
            (date, order_no, reason_code, reason_text, disposal, attach, committee1, committee2, committee3, note)
            VALUES (@date, @order_no, @reason_code, @reason_text, @disposal, @attach, @committee1, @committee2, @committee3, @note)`)
            .run(vals).lastInsertRowid;
        }
        const ins = db.prepare('INSERT OR IGNORE INTO deaccession_draft_items (draft_id, book_id) VALUES (?, ?)');
        ids.forEach(b => ins.run(draftId, b));
        return draftId;
      });
      const draftId = tx.immediate();
      logAudit('Проект за отчисляване', (id ? 'поправен' : 'записан') + ' проект № ' + draftId
        + ' — ' + ids.length + (ids.length === 1 ? ' заглавие' : ' заглавия')
        + (vals.reason_text ? ', причина: ' + vals.reason_text : ', без избрана причина')
        + ' (проектът НЕ отчислява нищо — документите остават във фонда)');
      return draftId;
    })
  );
  ipcMain.handle('deaccessionActs:deleteDraft', (e, id) =>
    run(() => {
      const db = getDb();
      ensureLoanActColumn(db);
      /* Проект СЕ трие — за разлика от акта. Не е излизал от библиотеката, не е
         подписван и не е вписан в КДБФ. Следа пак остава: иначе изчезването на
         подготвена комисийна работа е необяснимо. */
      const d = db.prepare('SELECT id FROM deaccession_drafts WHERE id = ?').get(id);
      if (!d) throw new Error('Проектът не е намерен — вероятно вече е изтрит или утвърден.');
      const n = db.prepare('SELECT COUNT(*) AS n FROM deaccession_draft_items WHERE draft_id = ?').get(id).n;
      db.prepare('DELETE FROM deaccession_drafts WHERE id = ?').run(id);
      logAudit('Проект за отчисляване', 'изтрит проект № ' + id + ' с ' + n
        + (n === 1 ? ' заглавие' : ' заглавия') + ' — нищо не е отчислявано');
      return true;
    })
  );
  ipcMain.handle('deaccessionActs:approveDraft', (e, { id, no }) =>
    run(() => {
      const db = getDb();
      ensureLoanActColumn(db);
      const d = db.prepare('SELECT * FROM deaccession_drafts WHERE id = ?').get(id);
      if (!d) throw new Error('Проектът не е намерен — вероятно вече е утвърден от друго работно място.');
      const rows = db.prepare(`
        SELECT b.* FROM deaccession_draft_items i JOIN (${BOOK_SELECT}) b ON b.id = i.book_id
        WHERE i.draft_id = ?`).all(id);
      const live = rows.filter(b => !deaccessionedByAct(b));
      if (!live.length) {
        throw new Error('Проектът няма нито един документ за отчисляване — или списъкът е празен, '
          + 'или всички документи вече са отчислени с друг акт.');
      }
      const act = Object.assign({}, d, { no: no != null ? no : undefined });
      if (act.no === undefined) {
        const y = yearOf(d.date);
        act.no = (db.prepare('SELECT MAX(no) AS m FROM deaccession_acts WHERE year = ?').get(y).m || 0) + 1;
      }
      /* Актът и изтриването на проекта падат или минават ЗАЕДНО. Иначе прекъсване
         между двете оставя утвърден акт и жив проект — и второ утвърждаване
         съставя втори акт за същите документи. */
      const tx = db.transaction(() => {
        const actId = createActCore(db, act, live.map(b => b.id)).actId;
        db.prepare('DELETE FROM deaccession_drafts WHERE id = ?').run(id);
        return actId;
      });
      const actId = tx.immediate();
      afterActWritten(act);
      logAudit('Проект за отчисляване', 'проект № ' + id + ' е утвърден като акт № '
        + act.no + '/' + yearOf(d.date)
        + (live.length !== rows.length
            ? ' (' + (rows.length - live.length) + ' от заглавията вече са били отчислени с друг акт и отпаднаха)' : ''));
      return actId;
    })
  );
  ipcMain.handle('deaccessionActs:revoke', (e, id, opts) =>
    run(() => {
      const db = getDb();
      ensureLoanActColumn(db);
      /* Каквото прозорецът трябва да КАЖЕ на библиотекарката след анулирането.
         Стои извън транзакцията, защото се чете след нея. */
      const revokeInfo = { droppedHolds: 0, shelvesToRestore: [] };
      /* Основанието за анулиране е ЗАДЪЛЖИТЕЛНО (v2.4.56). Актът остава в
         документацията завинаги; щом остава, до него трябва да пише ЗАЩО е
         отпаднал — иначе след година никой, включително проверяващият, не може
         да различи „сгрешен номер“ от „комисията размисли“. */
      const reason = String((opts && opts.reason) || '').trim();
      if (!reason) throw new Error('Анулирането изисква основание — напишете защо актът отпада (например „сгрешен инвентарен номер“).');
      const tx = db.transaction(() => {
        /* Одит v2.4.24: актът не се проверяваше за съществуване — анулиране на вече
           анулиран (или изобщо несъществуващ) акт се връщаше с ok:true, прозорецът
           обявяваше „Актът е анулиран“, а в дневника се вписваше събитие за акт,
           който никога не е бил съставен. */
        const act = db.prepare('SELECT no, year, revoked_at FROM deaccession_acts WHERE id = ?').get(id);
        if (!act) throw new Error('Актът не е намерен.');
        if (act.revoked_at) {
          throw new Error('Акт № ' + act.no + '/' + act.year + ' вече е анулиран на '
            + String(act.revoked_at).slice(0, 10) + ' г. — вторично анулиране няма смисъл.');
        }
        const items = db.prepare('SELECT book_id, inv_number, status_before, shelves_before FROM deaccession_items WHERE act_id = ?').all(id);
        /* Витрините НЕ се възстановяват автоматично — по същата причина, по която
           не се възстановяват и резервациите (виж ensureLoanActColumn): витрината
           е подбор, правен от човек за сайта, а анулирането поправя регистъра, не
           връща времето. Но щом не се връща само, трябва да се КАЖЕ какво да се
           върне ръчно — иначе документът се прибира във фонда и мълчаливо изпада
           от тематичния списък на сайта завинаги. */
        const shelvesToRestore = items
          .filter(it => it.shelves_before)
          .map(it => ({ inv_number: it.inv_number, shelves: it.shelves_before }));
        // Сглобена веднъж, извън обхождането — по същата причина като при съставянето.
        const backStmt = db.prepare(`UPDATE books SET status=?, status_date=date('now'),
          deaccession_act_id=NULL, deaccession_date=NULL WHERE id=?`);
        items.forEach(it => {
          if (it.book_id) {
            // Връща се ТОВА, което документът е бил преди акта (виж
            // ensureLoanActColumn). Старите актове нямат снимка — за тях остава
            // 'наличен', както досега.
            const back = it.status_before && it.status_before !== 'отчислен' ? it.status_before : 'наличен';
            backStmt.run(back, it.book_id);
          }
        });
        /* Заеманията, закрити принудително от този акт (най-често при причина
           „невърнати от ползватели“), се отварят обратно. Иначе книгата се връща
           във фонда като „наличен“ и свободна за заемане, макар реално да е у
           първия читател — а следата, че той я държи, е изчезнала. */
        const reopened = db.prepare('UPDATE loans SET date_in = NULL, deaccession_act_id = NULL WHERE deaccession_act_id = ?')
          .run(id).changes;
        /* Резервациите, отказани от този акт, НЕ се възкресяват — виж дългата
           бележка при ensureLoanActColumn. Но се БРОЯТ и се вписват в следата:
           дотук те изчезваха безследно и анулирането твърдеше само „документите
           са върнати във фонда“, от което библиотекарката нямаше как да разбере,
           че нечия резервация е паднала по пътя и че трябва да я поднови ръчно. */
        const droppedHolds = db.prepare(`SELECT COUNT(*) AS n FROM holds
          WHERE deaccession_act_id = ? AND status = 'отказана'`).get(id).n;
        /* НЕ се трие (v2.4.56 — виж дългата бележка при ensureLoanActColumn).
           Редът остава, номерът остава зает завинаги, редовете на акта остават
           като снимка по чл. 35, ал. 2, а КДБФ Част № 3 показва акта зачертан,
           с основанието, и с нула в сборовете. */
        db.prepare(`UPDATE deaccession_acts
          SET revoked_at = datetime('now'), revoke_reason = ?, revoked_by = ?
          WHERE id = ?`).run(reason, (opts && opts.by) ? String(opts.by).trim() : null, id);
        // `id` е вътрешният rowid, а не номерът на акта — те съвпадат само в първата
        // година. Одит v2.4.24: следата сочеше несъществуващ акт.
        logAudit('Анулиране на акт', 'акт № ' + act.no + '/' + act.year + ' е анулиран (' + reason
          + '); номерът остава зает и актът остава в документацията по чл. 39, а документите са върнати във фонда'
          + (reopened ? ' (' + (reopened === 1 ? '1 заемане е отворено обратно' : reopened + ' заемания са отворени обратно') + ')' : '')
          + (droppedHolds
              ? '; ' + (droppedHolds === 1
                  ? '1 резервация, отказана с този акт, ОСТАВА отказана — подновете я ръчно, ако читателят още чака'
                  : droppedHolds + ' резервации, отказани с този акт, ОСТАВАТ отказани — подновете ги ръчно, ако читателите още чакат')
              : '')
          + (shelvesToRestore.length
              ? '; ' + (shelvesToRestore.length === 1
                  ? '1 документ е бил махнат от витрина в онлайн каталога'
                  : shelvesToRestore.length + ' документа са били махнати от витрини в онлайн каталога')
                + ' при съставянето и НЕ се връщат автоматично — '
                + shelvesToRestore.map(s => 'инв. № ' + (s.inv_number ?? '—') + ' → ' + s.shelves).join('; ')
              : ''));
        revokeInfo.droppedHolds = droppedHolds;
        revokeInfo.shelvesToRestore = shelvesToRestore;
      });
      tx.immediate();
      scheduleCatalogWrite();
      return revokeInfo;
    })
  );
};
