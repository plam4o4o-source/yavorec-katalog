// Резервации — извадени от main.js в отделен модул (Фаза 4, стъпка 21).
// firstActiveHold/consumeHoldOnCheckout/activateHoldOnReturn се връщат
// обратно към main.js, защото ги ползва и все още неизвадения домейн
// "Заемания" (loans:checkout/return/extend/checkoutByCode/returnByCode) —
// същият модел, както calendar.js/circ-rules.js по-рано.
module.exports = function registerHoldsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, normalizeScanCode } = deps;

  const HOLD_ACTIVE = "('чака','заделена')";
  const HOLD_SELECT = `
    SELECT h.*, b.title, b.author, b.inv_number, b.barcode,
           r.name AS reader_name, r.card_no, r.phone
    FROM holds h
    JOIN books b ON b.id = h.book_id
    JOIN readers r ON r.id = h.reader_id
  `;

  // Цялата опашка от активни резервации, в реда, в който са заявени.
  function activeHolds(bookId) {
    return getDb().prepare(`${HOLD_SELECT} WHERE h.book_id = ? AND h.status IN ${HOLD_ACTIVE} ORDER BY h.placed_at, h.id`).all(bookId);
  }
  // Най-старата активна резервация за книгата — тя определя кой е „наред“.
  function firstActiveHold(bookId) {
    return activeHolds(bookId)[0];
  }
  /* Свободни бройки в момента. Моделът на данните изрично поддържа няколко
     екземпляра на едно заглавие (inventory.quantity), затова „книгата е заета“
     НЕ значи „няма свободна бройка“ — точно както смятат loans:checkout и
     loans:checkoutByCode. Липсващ ред в inventory се брои за 0 бройки, както го
     брои и тригерът trg_loans_capacity в schema.sql. */
  function freeCopies(bookId) {
    const db = getDb();
    const inv = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(bookId);
    const out = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(bookId).n;
    return (inv ? inv.quantity : 0) - out;
  }
  /* При заемане резервацията важи срещу СВОБОДНИТЕ бройки, а не срещу цялото
     заглавие. Отказва се само когато свободните бройки не стигат за резервациите
     ПРЕД този читател: при 3 екземпляра, 1 зает и 1 чакащ преди него остават 2
     свободни — една за чакащия, една за него. Дотогава една-единствена резервация
     заключваше всички бройки и второто копие на учебника стоеше незаемаемо.
     Читателят, пред когото няма никого (включително собствената му резервация,
     когато е първа), минава винаги — броят на бройките се пази от самия
     loans:checkout и от тригера, тук се пази само редът на опашката. */
  function consumeHoldOnCheckout(bookId, readerId) {
    const queue = activeHolds(bookId);
    if (!queue.length) return;
    const mine = queue.findIndex(h => h.reader_id === readerId);
    const ahead = mine === -1 ? queue.length : mine; // колко резервации са пред него
    if (ahead) {
      const free = freeCopies(bookId);
      if (free <= ahead) {
        const h = queue[0];
        throw new Error('Книгата е резервирана за ' + h.reader_name +
          (h.status === 'заделена' ? ' (заделена, чака взимане)' : '') +
          (ahead > 1 ? ' и още ' + (ahead - 1) + (ahead === 2 ? ' читател' : ' читатели') + ' на опашката' : '') +
          '. Откажете резервацията, ако все пак трябва да я заемете другиму.');
      }
    }
    if (mine !== -1) {
      getDb().prepare("UPDATE holds SET status = 'изпълнена', resolved_at = datetime('now') WHERE id = ?").run(queue[mine].id);
    }
  }
  // При връщане: най-старата чакаща резервация става „заделена“, за да не се
  // върне книгата на рафта. Връща резервацията, за да я покаже екранът.
  function activateHoldOnReturn(bookId) {
    const db = getDb();
    const h = firstActiveHold(bookId);
    if (!h) return null;
    if (h.status === 'чака') {
      db.prepare("UPDATE holds SET status = 'заделена', ready_at = datetime('now') WHERE id = ?").run(h.id);
      h.status = 'заделена';
      logAudit('Заделена книга', 'инв. № ' + h.inv_number + ' — ' + h.title + ' за ' + h.reader_name);
    }
    return h;
  }

  ipcMain.handle('holds:list', () =>
    run(() => getDb().prepare(`${HOLD_SELECT} WHERE h.status IN ${HOLD_ACTIVE}
      ORDER BY CASE h.status WHEN 'заделена' THEN 0 ELSE 1 END, h.placed_at, h.id`).all())
  );
  // normalizeScanCode() (v1.70.1) — виж books:byBarcode в handlers/books.js за
  // обяснението на кирилско/латинско разминаване при баркод четец.
  /* Реадит след v2.4.0 (доп. находка, извън първоначалните 26): holds:add
     правеше проверка-после-запис (провери свободни бройки/дубликат, после
     INSERT) БЕЗ транзакция — точно образецът, който одитите на тази поръчка
     многократно вече хващаха другаде (loans:checkout, loans:extend, номерата
     на актове за отчисляване). Емпирично доказано с два реални os процеса
     (виж test/reaudit-v24-followup.test.js): същият читател, натискащ
     „резервирай" два пъти почти едновременно (двоен клик, или двама
     библиотекари на различни гишета помагащи на един и същ читател) — в 10 от
     15 кръга се получаваха ДВА реда в holds за един и същ читател/книга,
     вместо втория коректно отказан с „Този читател вече има резервация".
     Поправка по установения образец: цялото тяло — проверки И запис — в
     db.transaction(...).immediate(), както checkout/extend/deaccessionActs.
     .immediate() взима правото на запис ПРЕДИ проверките, така че между
     проверката за дубликат/свободни бройки и INSERT-а никой друг паралелен
     процес не може да вмъкне същия ред. */
  ipcMain.handle('holds:add', (e, { reader_id, code }) =>
    run(() => {
      const db = getDb();
      const c = normalizeScanCode(code);
      const tx = db.transaction(() => {
        const b = db.prepare('SELECT * FROM books WHERE barcode = ? OR inv_number = CAST(? AS INTEGER)').get(c, c);
        if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
        if (b.status === 'отчислен') throw new Error('Инв. № ' + b.inv_number + ' е отчислен от фонда.');
        /* Резервира се само това, което наистина не може да се вземе сега. Две неща
           се четат погрешно, ако тук се пита само „има ли отворен заем":
           • при няколко екземпляра втората свободна бройка се резервира вместо да
             се заеме направо (виж freeCopies по-горе);
           • ЗАДЕЛЕНАТА бройка не е свободна — тя чака конкретен читател. Дотогава
             третият читател получаваше „свободен е — заемете го направо", а
             loans:checkoutByCode веднага след това отказваше със „заделена, чака
             взимане" и той не можеше нито да я вземе, нито да се нареди на опашката. */
        const out = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(b.id).n;
        const shelved = db.prepare("SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND status = 'заделена'").get(b.id).n;
        const free = freeCopies(b.id) - shelved;
        if (free > 0 || (!out && !shelved)) {
          throw new Error('Инв. № ' + b.inv_number + ' е свободен' + (free > 1 ? ' (' + free + ' свободни бройки)' : '') +
            ' — заемете го направо, без резервация.');
        }
        const held = db.prepare('SELECT 1 FROM loans WHERE book_id = ? AND reader_id = ? AND date_in IS NULL').get(b.id, reader_id);
        if (held) throw new Error('Читателят в момента държи тази книга.');
        const dup = db.prepare(`SELECT 1 FROM holds WHERE book_id = ? AND reader_id = ? AND status IN ${HOLD_ACTIVE}`).get(b.id, reader_id);
        if (dup) throw new Error('Този читател вече има резервация за книгата.');
        const info = db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(b.id, reader_id);
        const queue = db.prepare(`SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND status IN ${HOLD_ACTIVE}`).get(b.id).n;
        const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
        logAudit('Резервация', 'инв. № ' + b.inv_number + ' — ' + b.title + ' за ' + (r ? r.name : reader_id));
        return { id: info.lastInsertRowid, title: b.title, inv_number: b.inv_number, queue };
      });
      return tx.immediate();
    })
  );
  ipcMain.handle('holds:cancel', (e, id) =>
    run(() => {
      const db = getDb();
      const h = db.prepare(`${HOLD_SELECT} WHERE h.id = ?`).get(id);
      db.prepare("UPDATE holds SET status = 'отказана', resolved_at = datetime('now') WHERE id = ?").run(id);
      if (h) logAudit('Отказана резервация', 'инв. № ' + h.inv_number + ' — ' + h.title + ' (' + h.reader_name + ')');
    })
  );

  /* Одит #25: „заделена" резервация (читателят вече е известèн, книгата е
     свалена от рафта специално за него — виж activateHoldOnReturn по-горе)
     нямаше НИКАКЪВ механизъм за изтичане. Непотърсен екземпляр стоеше
     заделен безкрайно и блокираше всички следващи читатели на опашката,
     докато библиотекарят ръчно не отменеше резервацията — а нямаше и
     причина да се сети да го направи, тъй като интерфейсът с нищо не
     показваше, че резервацията отдавна чака.

     Няма собствена настройка в settings за срока (виж db/schema.sql) —
     затова е обикновена константа тук, не нова колона в базата. 3 дни е
     разумен грайс период, същия ред на величина като извиненията за
     закъснели поръчки по други домейни на програмата (напр. срокове в
     handlers/mzs.js).

     Броени са КАЛЕНДАРНИ дни, не РАБОТНИ дни (work_days/calendar_closed,
     handlers/calendar.js): точното броене на работни дни изисква
     workDaysSet()/isWorkDay() от calendar.js, а те се връщат обратно към
     main.js само за домейна „Заемания" (виж коментара горе за
     firstActiveHold и сл.) — не са инжектирани като зависимост в ТОЗИ
     модул. Добавянето им би означавало промяна в main.js извън обхвата на
     тази поправка (виж бележката накрая на файла), затова тук нарочно е
     избран по-простият, но самодостатъчен вариант — календарни дни. */
  const HOLD_EXPIRE_DAYS = 3;

  /* Часовникът на изтичането тръгва от ready_at (моментът, в който
     резервацията стана „заделена"), НЕ от placed_at (моментът на заявяване)
     — читателят, който все още чака ред в опашката, няма как да „закъснее"
     за нещо, което още не е получил. Изтеклата резервация се маркира със
     статус 'отказана', защото db/enum-triggers.js (ENUM_COLUMNS за
     holds.status) НЕ допуска друга стойност освен
     'чака'/'заделена'/'изпълнена'/'отказана' — самостоятелен статус
     „изтекла" би изисквал промяна в db/enum-triggers.js, извън файловете,
     които тази поправка смее да пипа. За да си личи, че НЕ е отказана нито
     от читателя, нито от библиотекаря, причината се вписва изрично в note и
     в одитната следа с отделно действие „Изтекла резервация". */
  function expireStaleHolds() {
    const db = getDb();
    const stale = db.prepare(`${HOLD_SELECT}
      WHERE h.status = 'заделена' AND h.ready_at IS NOT NULL
        AND julianday('now') - julianday(h.ready_at) >= ?`).all(HOLD_EXPIRE_DAYS);
    if (!stale.length) return 0;
    const upd = db.prepare(`UPDATE holds SET status = 'отказана', resolved_at = datetime('now'),
      note = trim(coalesce(note || ' ', '') || 'изтекла — непотърсена над ' || ? || ' дни') WHERE id = ?`);
    for (const h of stale) {
      upd.run(HOLD_EXPIRE_DAYS, h.id);
      logAudit('Изтекла резервация', 'инв. № ' + h.inv_number + ' — ' + h.title + ' за ' + h.reader_name +
        ' (непотърсена над ' + HOLD_EXPIRE_DAYS + ' дни — автоматично отказана, книгата се освобождава)');
    }
    return stale.length;
  }
  /* НЯМА ipcMain.handle('holds:expireStale', ...) тук — нарочно. Нов канал би
     означавал и нов мост в preload.js (test/preload-ipc-channels.test.js
     проверява ДВУПОСОЧНО съответствието между регистрираните ipcMain.handle
     канали в main.js и изложеното през contextBridge в preload.js — проверено
     директно: добавен тук IPC handler и веднага се появява „регистриран, но
     неизложен" във въпросния тест), а preload.js не е сред файловете, които
     тази поправка на одит #25 смее да пипа. Затова expireStaleHolds се връща
     обратно като обикновена функция — по същия образец, по който
     handlers/backup.js връща autoBackupIfNeeded (виж бележката в export-а
     по-долу за какво точно остава да се добави в main.js/preload.js, ако
     занапред потрябва и бутон в интерфейса, не само автоматично викане при
     стартиране). */

  /* freeCopies и activeHolds се връщат обратно към main.js, защото и „Заемания"
     трябва да преценява резервациите срещу СВОБОДНИТЕ бройки, а не срещу цялото
     заглавие — иначе loans:extend продължава да блокира продължението заради
     резервация, докато същата книга спокойно се заема от гишето (v2.3.0).

     expireStaleHolds се връща по същия образец, по който handlers/backup.js
     връща autoBackupIfNeeded. Самата поправка на одит #25 в ТОЗИ файл нарочно
     не пипаше main.js (виж бележката по-горе за preload.js) — но координацията
     на цялата партида v2.4.0 впоследствие Е добавила извикването в main.js
     (app.whenReady(), редом с autoBackupIfNeeded()) и деструктурирането на
     expireStaleHolds от require('./handlers/holds')(...) — вижте main.js.
     Бележката по-долу описва самия избор (веднъж на стартиране, без периодичен
     таймер) за справка, не отворена задача:
       1) деструктурирането на реда с require('./handlers/holds')(...) вече
          включва expireStaleHolds редом с останалите връщани имена;
       2) извикването на expireStaleHolds() в app.whenReady(), редом с
          autoBackupIfNeeded() (веднъж на стартиране е достатъчно — срокът се
          мери в цели дни, не в минути; периодичен таймер по образеца на
          startAutoPushTimer в handlers/catalog.js е излишен за тази
          гранулярност, но е лесна добавка, ако все пак се поиска). */
  return { firstActiveHold, consumeHoldOnCheckout, activateHoldOnReturn, freeCopies, activeHolds, expireStaleHolds };
};
