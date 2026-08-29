// Отчисляване (актове) — извадени от main.js в отделен модул (Фаза 4,
// стъпка 15 от разбиването на монолита на модули по домейн). Зависи от
// BOOK_SELECT (по стойност, const низ) и scheduleCatalogWrite (по
// референция, функция дефинирана в main.js — отчисляването/анулирането
// сменят видимостта на документи в онлайн каталога, затова насрочват
// запис на katalog.json, точно както shelves.js).
const { isValidIsoDate } = require('../security-utils');

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
    loanActColumnChecked = db;
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
      const act = db.prepare('SELECT * FROM deaccession_acts WHERE id = ?').get(id);
      if (!act) return null;
      act.items = db.prepare('SELECT * FROM deaccession_items WHERE act_id = ? ORDER BY inv_number').all(id);
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
  ipcMain.handle('deaccessionActs:findBook', (e, code) => run(() => {
    const c = normalizeScanCode(code);
    return getDb().prepare(`${BOOK_SELECT} WHERE (b.barcode = ? OR b.inv_number = CAST(? AS INTEGER)) AND (b.status != 'отчислен' OR b.status IS NULL)`).get(c, c);
  }));
  ipcMain.handle('deaccessionActs:create', (e, { act, bookIds }) =>
    run(() => {
      const db = getDb();
      ensureLoanActColumn(db);
      /* Реадит след v2.4.0 (доп. находка): act.date влизаше НЕВАЛИДИРАНА право в
         loans.date_in, books.status_date и books.deaccession_date — точно
         същата дупка, която isValidIsoDate() (security-utils.js, одит v2.3.1)
         вече затваря при loans:checkout/return. Доказано изпълнимо на практика:
         буквален боклук низ ('НЕВАЛИДНА-ДАТА-99-99') се записваше безпроблемно
         в тези колони. Проверката е тук, ПРЕДИ транзакцията да пипне базата —
         както при loans.js — за да не се налага частично отменяне. */
      if (!isValidIsoDate(act.date)) throw new Error('Датата на акта липсва или е невалидна.');
      const no = parseInt(act.no, 10);
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
          reason_code: parseInt(act.reason_code, 10), reason_text: act.reason_text,
          disposal: act.disposal || null, attach: act.attach || null,
          committee1: act.committee1 || null, committee2: act.committee2 || null, committee3: act.committee3 || null
        });
        const actId = info.lastInsertRowid;
        const insItem = db.prepare(`
          INSERT INTO deaccession_items (act_id, book_id, inv_number, author, title, volume, year, price, udk, category, language, quantity)
          VALUES (@act_id, @book_id, @inv_number, @author, @title, @volume, @year, @price, @udk, @category, @language, @quantity)
        `);
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
        const cancelHolds = db.prepare(`
          UPDATE holds SET status = 'отказана', resolved_at = datetime('now')
          WHERE book_id = ? AND status IN ('чака','заделена')
        `);
        let cancelledHolds = 0;
        /* Отчетната бройка на всеки документ, с разграничение между „липсващ ред“
           и „изрично нула“ — виж бележката при quantity по-долу. */
        const qStmt = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?');
        const invQty = { get: (id) => { const r = qStmt.get(id); return r ? r.quantity : 1; } };
        bookIds.forEach(bookId => {
          const b = db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(bookId);
          if (!b) return;
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
            quantity: invQty.get(b.id)
          });
          db.prepare('UPDATE books SET status = ?, status_date = ?, deaccession_act_id = ?, deaccession_date = ? WHERE id = ?')
            .run('отчислен', act.date, actId, act.date, b.id);
          closeLoans.run(act.date, actId, b.id);
          cancelledHolds += cancelHolds.run(b.id).changes;
        });
        db.prepare('UPDATE settings SET committee1=?, committee2=?, committee3=? WHERE id=1')
          .run(act.committee1 || null, act.committee2 || null, act.committee3 || null);
        logAudit('Отчисляване', 'акт № ' + act.no + ' — ' + bookIds.length + ' документа, причина: ' + act.reason_text
          + (cancelledHolds ? (' (отказани ' + cancelledHolds + ' резервации на отчислените документи)') : ''));
        return actId;
      });
      // .immediate() — виж проверката на номера в транзакцията по-горе.
      const actId = tx.immediate();
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
      return actId;
    })
  );
  ipcMain.handle('deaccessionActs:revoke', (e, id) =>
    run(() => {
      const db = getDb();
      ensureLoanActColumn(db);
      const tx = db.transaction(() => {
        const items = db.prepare('SELECT book_id FROM deaccession_items WHERE act_id = ?').all(id);
        items.forEach(it => {
          if (it.book_id) {
            db.prepare(`UPDATE books SET status='наличен', status_date=date('now'), deaccession_act_id=NULL, deaccession_date=NULL WHERE id=?`)
              .run(it.book_id);
          }
        });
        /* Заеманията, закрити принудително от този акт (най-често при причина
           „невърнати от ползватели“), се отварят обратно. Иначе книгата се връща
           във фонда като „наличен“ и свободна за заемане, макар реално да е у
           първия читател — а следата, че той я държи, е изчезнала. */
        const reopened = db.prepare('UPDATE loans SET date_in = NULL, deaccession_act_id = NULL WHERE deaccession_act_id = ?')
          .run(id).changes;
        db.prepare('DELETE FROM deaccession_acts WHERE id = ?').run(id);
        logAudit('Анулиране на акт', 'акт № ' + id + ' е анулиран, документите са върнати във фонда'
          + (reopened ? ' (' + reopened + ' заемания са отворени обратно)' : ''));
      });
      tx.immediate();
      scheduleCatalogWrite();
    })
  );
};
