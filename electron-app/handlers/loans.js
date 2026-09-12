// Заемания (+ поток от събития, наказания за просрочие) — извадени от
// main.js в отделен модул (Фаза 4, стъпка 22 от разбиването на монолита на
// модули по домейн). Това е един от "големите пет" — консуматор на почти
// всичко вече извадено: circRule/readerCategory (circ-rules.js),
// nextWorkDay/closedDaysBetween (calendar.js), firstActiveHold/
// consumeHoldOnCheckout/activateHoldOnReturn (holds.js). logEvent се подава
// по референция (function declaration в main.js, ползвана и от
// handlers/housebound.js — остава в main.js, а не се мести тук, за да няма
// проблем с реда на зареждане: housebound.js се изисква по-рано във файла и
// вече разчита logEvent да е hoisted в main.js). BOOK_SELECT (по стойност)
// и scheduleCatalogWrite (по референция, hoisted по-долу в main.js) идват
// от все още неизвадения домейн "Книги"/"Онлайн каталог".
const { isValidIsoDate, resolveScannedBook } = require('../security-utils');
/* Стойностите, които тригерите в db/enum-triggers.js пускат — взети оттам, а не
   преписани тук (виж дългия коментар при BOOK_STATUS_LOST в онзи файл).
   applyEnumTriggers се изисква по същата причина, поради която го прави и
   миграция 9 в main.js: списъкът с позволени стойности живее в кода, а тригерите
   в базата са снимка от деня, в който са създадени. */
const { applyEnumTriggers, BOOK_STATUS_LOST, EVENT_KIND_LOST } = require('../db/enum-triggers');
/* Начислението в читателската сметка минава през handlers/account.js — сметката
   има едно място, което пише в нея. Виж chargeLost/chargeCoverage там. */
const { chargeLost, chargeCoverage, LOST_CHARGE_TYPE } = require('./account');

module.exports = function registerLoansHandlers(ipcMain, deps) {
  const {
    getDb, run, logAudit, today, logEvent, BOOK_SELECT, scheduleCatalogWrite,
    circRule, readerCategory, nextWorkDay, closedDaysBetween,
    firstActiveHold, consumeHoldOnCheckout, activateHoldOnReturn, normalizeScanCode,
    freeCopies, activeHolds
  } = deps;

  const LOAN_SELECT = `
    SELECT l.*, b.title, b.author, b.inv_number, r.name AS reader_name, r.card_no
    FROM loans l
    JOIN books b ON b.id = l.book_id
    JOIN readers r ON r.id = l.reader_id
  `;

  // Ползване в читалня — бърз брояч от „Заемане и връщане"; читателят е незадължителен.
  ipcMain.handle('events:localuse', (e, { date } = {}) =>
    run(() => { logEvent('читалня', { date }); return true; })
  );

  /* Наказание в дни (Koha: finedays) — за селска библиотека N дни без право на заемане
     е по-приложимо от глоба в стотинки, която никой не събира. Смята се при връщане
     със забава; натрупва се върху вече наложено наказание, но не надхвърля тавана. */
  // dueDate/inDate — реалните дати (не готово число дни), защото наказанието трябва да
  // извади затворените дни от периода (виж closedDaysBetween) — календарят е по-важен
  // точно тук: несправедливо е падеж в затворен ден да носи наказание за самия него.
  /* Просрочени дни, изчистени от затворените дни в периода (v1.70.0: извадено
     от applySuspension в самостоятелна функция, за да я ползва и глобата при
     връщане — виж бележката при loans:return по-долу за защо преди това
     двата пресмятания даваха различен резултат). */
  function effectiveDaysLate(dueDate, inDate) {
    if (!dueDate || !inDate || inDate <= dueDate) return 0;
    const rawDaysLate = Math.max(0, Math.round((new Date(inDate) - new Date(dueDate)) / 864e5));
    return Math.max(0, rawDaysLate - closedDaysBetween(dueDate, inDate));
  }
  /* Прибавяне на дни към дата — изцяло в UTC („T00:00:00Z" + setUTCDate), НЕ през
     new Date(низ) + setDate(). Датите в базата са голи низове „ГГГГ-ММ-ДД": new Date()
     ги чете като UTC полунощ, setDate() смята в МЕСТНО време, а toISOString() връща
     пак UTC — и при преминаване през смяната на лятното часово време (последната
     неделя на март/октомври) резултатът излизаше с ДЕН ПО-РАНО. Проверено: заемане
     на 05.03.2026 с 30-дневен срок даваше падеж 03.04 вместо 04.04, тоест читателят
     получаваше ден по-малко от обявения срок и просрочваше ден по-рано. Точно този
     дефект вече беше поправен в handlers/calendar.js (виж коментара при isWorkDay),
     но тук — при заемане, продължение и наказание — беше останал. Тестовете не го
     хващаха, защото ползваха август, който не пресича смяната на часа. */
  function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function applySuspension(readerId, dueDate, inDate) {
    const db = getDb();
    const rule = circRule(readerCategory(readerId));
    const per = Number(rule.suspend_per_day) || 0;
    if (per <= 0) return null;
    const effDaysLate = effectiveDaysLate(dueDate, inDate);
    if (effDaysLate <= 0) return null;
    const r = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(readerId);
    const base = (r && r.suspended_until && r.suspended_until > today()) ? r.suspended_until : today();
    let untilStr = addDays(base, Math.ceil(effDaysLate * per));
    /* Таванът важи за ОБЩОТО натрупано наказание, а не за всяко връщане поотделно.
       По-рано Math.min се прилагаше само върху добавката, затова три книги, върнати
       в един ден с по 90 дни забава при таван 90 дни, даваха 270 дни — три пъти
       тавана, точно обратното на обещаното два реда по-горе. А типичният случай е
       именно този: закъснелите книги се връщат накуп, не една по една.
       ВНИМАНИЕ за значението на нулата (поправено в v2.3.0). До v2.2.0 изразът беше
       `rule.suspend_max || 90`, тоест вписана 0 значеше „таван 90 дни". v2.2.0 я
       преобърна на „без таван" — и библиотека с нула в полето получаваше наказания
       от над две години (проверено: 779 дни забава → преустановено заемане до
       2028 г. вместо до +90 дни). Нулата в това поле не значи „без ограничение":
       никой библиотекар не вписва 0 с намерение „наказвай неограничено". Затова 0 и
       празно се третират еднакво — таванът по подразбиране. Изключването на
       наказанието става с suspend_per_day = 0 (полето точно над него), както пише и
       подсказката му. */
    const capRaw = Number(rule.suspend_max);
    const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 90;
    /* Таванът е „днес + cap", но НИКОГА под вече наложеното наказание: база, минала
       през v2.1.0, носи натрупани стойности отвъд тавана (3 книги × 90 дни = 270), и
       безусловното клампване ги дърпаше НАДОЛУ — тоест читател печелеше от това, че
       е закъснял пак. Затова горницата е по-голямото от двете. */
    const ceiling = addDays(today(), cap) > base ? addDays(today(), cap) : base;
    if (untilStr > ceiling) untilStr = ceiling;
    db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run(untilStr, readerId);
    logAudit('Наложено наказание', 'преустановено заемане до ' + untilStr + ' (' + effDaysLate + (effDaysLate === 1 ? ' работен ден' : ' работни дни') + ' забава)');
    return untilStr;
  }
  function checkSuspended(readerId) {
    const r = getDb().prepare('SELECT name, suspended_until FROM readers WHERE id = ?').get(readerId);
    if (r && r.suspended_until && r.suspended_until > today()) {
      throw new Error('Заемането за ' + r.name + ' е преустановено до ' + r.suspended_until.split('-').reverse().join('.') +
        ' заради просрочени връщания. Наказанието се сваля от картона на читателя.');
    }
  }

  ipcMain.handle('loans:list', (e, { onlyOpen } = {}) =>
    run(() => {
      const db = getDb();
      if (onlyOpen) return db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL ORDER BY l.date_due`).all();
      return db.prepare(`${LOAN_SELECT} ORDER BY +l.date_out DESC`).all(); // + : пълният списък се сортира по-бързо без idx_loans_date_out
    })
  );
  /* Дните забава и обезщетението се смятат ТУК, със същата функция, с която се
     начисляват при връщане (effectiveDaysLate — цели дни, минус затворените дни от
     календара). Дотогава екранът „Просрочени" ги смяташе сам, по сурови календарни
     дни, и показваше сума, различна от касовата и от исканата в напомнителното
     писмо. v2.2.0 уеднакви справката и напомнянията, но самият екран остана
     настрани — тоест сумите пак бяха две. Сега източникът е един за всички.
     Забележка: `date_due < date('now')` е нарочно строго — книга с падеж ДНЕС още
     не е просрочена и не бива да влиза нито в напомнянията, нито в обезщетенията. */
  ipcMain.handle('loans:overdue', () =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get() || {};
      const perDay = Number(s.fine_per_day) || 0;
      const now = today();
      const rows = db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.date_due`).all();
      rows.forEach(r => {
        r.daysLate = effectiveDaysLate(r.date_due, now);
        /* Начисленото по заемането се ДОБАВЯ, не се презаписва (преглед на
           поправките от този кръг). Дотук loans.fine се пишеше само при връщане и
           презаписването беше безвредно; от v2.4.24 loans:extend начислява по
           ОТВОРЕНО заемане, а този ред го изхвърляше — екранът „Просрочени“ и
           напомнителното писмо искаха 0.25 лв., а гишето после 2.05 лв. Точно
           трите различни суми, срещу които е бележката по-горе. */
        r.fine = (Number(r.fine) || 0) + r.daysLate * perDay;
      });
      return rows;
    })
  );
  ipcMain.handle('loans:byReader', (e, readerId) =>
    run(() => getDb().prepare(`${LOAN_SELECT} WHERE l.reader_id = ? ORDER BY l.date_out DESC`).all(readerId))
  );
  // Насочена заявка за конкретна книга (напр. при сканиране на инвентарен номер
  // в таблото) — вместо да се тегли ЦЯЛАТА история на заеманията (loans:list)
  // само за да се филтрира по book_id на клиента (Фаза 2, поправка на dashLookup).
  ipcMain.handle('loans:byBook', (e, bookId) =>
    run(() => getDb().prepare(`${LOAN_SELECT} WHERE l.book_id = ? ORDER BY l.date_out DESC`).all(bookId))
  );
  /* Обезщетението тук се смята С ЪЩАТА функция, с която реално се начислява при
     връщане (effectiveDaysLate), а не със SQL израза, който стоеше на това място:
     `(julianday('now') - julianday(date_due)) * fine_per_day` дава ДРОБНИ дни,
     защото julianday('now') включва и часа, и при това не изважда затворените дни.
     Резултатът беше три различни суми за едно и също просрочие — писмото искаше
     0.77 лв., екранът показваше 0.70 лв., а на гишето се начисляваха 0.50 лв. —
     и официалното напомнително писмо по чл. 43, ал. 2 показваше различна сума
     според ЧАСА, в който е отпечатано. v1.70.0 уеднакви двата пътя за връщане;
     справката и напомнянията бяха останали настрани. */
  ipcMain.handle('loans:overdueByReader', () =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get() || {};
      const perDay = Number(s.fine_per_day) || 0;
      const rows = db.prepare(`
        SELECT l.reader_id, r.name, r.address, r.address2, r.phone, r.email, COUNT(*) AS n
        FROM loans l JOIN readers r ON r.id = l.reader_id
        WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now')
        GROUP BY l.reader_id
      `).all();
      const detail = db.prepare(`${LOAN_SELECT} WHERE l.date_in IS NULL AND l.date_due IS NOT NULL AND l.date_due < date('now') ORDER BY l.reader_id, l.date_due`).all();
      const now = today();
      rows.forEach(r => {
        r.loans = detail.filter(d => d.reader_id === r.reader_id);
        // Виж бележката при loans:overdue: натрупаното по заемането се добавя.
        r.loans.forEach(d => { d.fine = (Number(d.fine) || 0) + effectiveDaysLate(d.date_due, now) * perDay; });
        r.fine = r.loans.reduce((sum, d) => sum + d.fine, 0);
      });
      return rows;
    })
  );
  ipcMain.handle('loans:checkout', (e, { reader_id, book_id, date_out, date_due }) =>
    run(() => {
      if (!isValidIsoDate(date_out)) throw new Error('Датата на заемане липсва или е невалидна.');
      if (date_due != null && date_due !== '' && !isValidIsoDate(date_due)) {
        throw new Error('Датата на връщане (' + date_due + ') е невалидна.');
      }
      const db = getDb();
      const tx = db.transaction(() => {
        const inv = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(book_id);
        const outCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(book_id).n;
        const qty = inv ? inv.quantity : 0;
        if (outCount >= qty) throw new Error('Няма свободни бройки от тази книга.');
        /* ДВЕ ВРАТИ, ЕДНИ ПРАВИЛА (одит v2.4.24). Заемането по баркод
           (loans:checkoutByCode по-долу) отказва отчислен документ, спазва лимита
           от документи за читател и винаги изчислява падеж; този — по-старият
           път, който остава изложен през preload — не правеше нито едно от трите.
           Най-тежкото е падежът: `date_due || null` записваше заемане БЕЗ СРОК, а
           всяка справка за просрочие пита `date_due IS NOT NULL` — такова заемане
           никога не става просрочено, никога не носи обезщетение и никога не
           попада в напомнянията. Книгата просто изчезва от погледа. */
        const b0 = db.prepare('SELECT inv_number, status FROM books WHERE id = ?').get(book_id);
        if (!b0) throw new Error('Документът не е намерен.');
        if (b0.status === 'отчислен') throw new Error('Инв. № ' + b0.inv_number + ' е отчислен от фонда.');
        /* v2.4.56: документ, приключен като изгубен, не се заема. Без тази
           проверка предишният читател „губи“ книгата, екземплярът се освобождава
           (заемането е затворено) и следващият читател я взема от рафт, на който
           тя физически я няма — а програмата му я записва като заета. Отказът е
           изричен и казва какво се прави оттук нататък, за да не изглежда като
           повреда. Същата проверка и в двете врати за заемане (виж бележката
           „ДВЕ ВРАТИ, ЕДНИ ПРАВИЛА“ по-долу). */
        if (b0.status === BOOK_STATUS_LOST) {
          throw new Error('Инв. № ' + b0.inv_number + ' е отбелязан като изгубен/невърнат. Ако документът се е намерил, '
            + 'върнете състоянието му на „наличен“ от „Книги“; ако не — отчислете го с акт по чл. 30, т. 5.');
        }
        const s = circRule(readerCategory(reader_id));
        const current = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ? AND date_in IS NULL').get(reader_id).n;
        if (s.max_books && current >= s.max_books) throw new Error('Достигнат е лимитът от ' + s.max_books + ' документа за читател.');
        checkSuspended(reader_id);
        consumeHoldOnCheckout(book_id, reader_id);
        const dueStr = date_due || nextWorkDay(addDays(date_out, s.loan_days || 30));
        const info = db.prepare(`
          INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)
        `).run(reader_id, book_id, date_out, dueStr);
        const b = db.prepare('SELECT title, inv_number FROM books WHERE id = ?').get(book_id);
        logAudit('Заемане', 'инв. № ' + (b ? b.inv_number : '') + ' — ' + (b ? b.title : ''));
        logEvent('заемане', { bookId: book_id, readerId: reader_id, date: date_out });
        return info.lastInsertRowid;
      });
      const id = tx.immediate();
      scheduleCatalogWrite();
      return id;
    })
  );
  ipcMain.handle('loans:return', (e, { id, date_in }) =>
    run(() => {
      if (date_in != null && date_in !== '' && !isValidIsoDate(date_in)) {
        throw new Error('Датата на връщане (' + date_in + ') е невалидна.');
      }
      const db = getDb();
      const inDate = date_in || today();
      /* Редът и глобата се четат ВЪТРЕ в транзакцията (одит v2.4.24). Дотук
         `SELECT date_due` беше извън нея: другото работно място можеше да продължи
         срока между четенето и записа, а `AND date_in IS NULL` не улавя това —
         записваше се глоба за падеж, който вече не съществува. */
      const tx = db.transaction(() => {
        const before = db.prepare('SELECT date_due, date_in FROM loans WHERE id = ?').get(id);
        /* Защита срещу повторно връщане на едно и също заемане. Пътят през баркод
           (loans:returnByCode) винаги е проверявал за ОТВОРЕН заем; бутонът „Приеми"
           в „Заемане и връщане"/„Просрочени" — не, и не се заключваше след клик.
           Второ извикване значеше: applySuspension стъпва върху ВЕЧЕ наложеното
           наказание (base = suspended_until) и го удвоява, а logEvent('връщане') се
           вписва повторно и изкривява дневника. Проверено: 16 дни забава при 1 ден
           наказание на ден давà 02.09; двоен клик — 18.09, и двата пъти с ok:true. */
        if (!before) throw new Error('Заемането не е намерено.');
        if (before.date_in) {
          throw new Error('Това заемане вече е върнато на ' +
            before.date_in.split('-').reverse().join('.') + ' — не се приема втори път.');
        }
        // v1.70.0: тук по-рано fine никога не се пресмяташе/записваше — loans:return
        // (бутон „Приеми“ в Заемане и връщане/Просрочени) и loans:returnByCode
        // (сканиране на баркод) са двата пътя за връщане на книга, но само вторият
        // смяташе глоба, при това по календарни дни (без да изважда затворените —
        // за разлика от наказанието в дни, което ги изважда още от самото начало).
        // Резултатът: „Събрани глоби“ в справките зависеше от това кой бутон е
        // натиснат, и дори когато глоба се пресмяташе, беше с по-малко дни, отколкото
        // наказанието за същото просрочие. Сега и двата пътя ползват еднакво
        // effectiveDaysLate() (виж applySuspension по-горе) и еднакво записват fine.
        const daysLate = effectiveDaysLate(before.date_due, inDate);
        const s = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get();
        const fine = daysLate * ((s && s.fine_per_day) || 0);
        /* Едно връщане пипа ЧЕТИРИ таблици: loans (затваря заемането), holds
           (активира следващата резервация), events (захранва дневника и годишния
           отчет) и readers (наказанието). Дотук те се записваха едно по едно, без
           транзакция: прекъсване по средата — спиране на тока, прекъсната мрежа към
           споделената база — оставяше заемането затворено, но без събитие, и
           годишният отчет тихо оставаше с едно заемане по-малко от инвентарната
           книга. Сега или минават всичките, или нито едно, точно както при
           loans:extend по-горе. `.immediate()` взима правото на запис още в началото,
           за да не се стигне до „database is locked“ насред поредицата. */
        // `AND date_in IS NULL` е втората (атомарна) половина на защитата по-горе:
        // ако два прозореца натиснат „Приеми" едновременно, само първият ще запише.
        /* `fine = COALESCE(fine, 0) + ?`, а не `fine = ?` (одит v2.4.24, преглед на
           поправките от същия кръг). loans:extend вече урежда натрупаното при
           продължение на просрочено заемане и го ДОБАВЯ — а тук записът беше
           присвояване. След продължение падежът е в бъдещето, тоест при връщането
           daysLate = 0 и глобата излиза 0: присвояването заличаваше точно това,
           което продължението току-що начисли (проверено: 2.40 лв. → 0.00).
           Двойно броене няма: продължението начислява до деня на продължението и
           мести падежа напред, а тук се смята забава спрямо НОВИЯ падеж. */
        const upd = db.prepare('UPDATE loans SET date_in = ?, fine = COALESCE(fine, 0) + ? WHERE id = ? AND date_in IS NULL')
          .run(inDate, fine, id);
        if (upd.changes === 0) throw new Error('Това заемане вече е върнато — не се приема втори път.');
        // Дължимото на гишето е ЦЯЛОТО натрупано по заемането, не само днешната част.
        const fineTotal = db.prepare('SELECT fine FROM loans WHERE id = ?').get(id).fine || 0;
        const l = db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id);
        if (l) logAudit('Връщане', 'инв. № ' + l.inv_number + ' — ' + l.title + (daysLate ? ' (забава ' + daysLate + (daysLate === 1 ? ' ден' : ' дни') + ')' : ''));
        const hold = l ? activateHoldOnReturn(l.book_id) : null;
        let suspendedUntil = null;
        if (l) {
          logEvent('връщане', { bookId: l.book_id, readerId: l.reader_id, date: inDate });
          suspendedUntil = applySuspension(l.reader_id, l.date_due, inDate);
        }
        return { hold, suspendedUntil, daysLate, fine: fineTotal, fineNow: fine };
      });
      const { hold, suspendedUntil, daysLate, fine, fineNow } = tx.immediate();
      // Извън транзакцията: пише файл, не база — не бива да я държи отворена.
      scheduleCatalogWrite();
      return {
        hold: hold ? { reader_name: hold.reader_name, card_no: hold.card_no, phone: hold.phone } : null,
        suspendedUntil, daysLate, fine, fineNow
      };
    })
  );
  /* Повторен одит v2.4.0 (реаудит): тук по-рано НЯМАШЕ db.transaction(...).immediate()
     изобщо — проверката на лимита от продължения (used >= max) и записа на новия
     renewals ставаха с две отделни, невзаимно заключени stmt-та. Двама читатели,
     кликнали "Продължи" на едно и също заемане от две станции в един и същ момент
     (или един и същ читател, кликнал двойно), четяха ЕДИН И СЪЩ стар renewals,
     двамата минаваха проверката за лимита, и вторият INSERT/UPDATE тихо
     ПРЕЗАПИСВАШЕ renewals на стойност, по-малка от реалния брой успешни
     продължения (lost update) — точно класът проблем, за който checkout/
     checkoutByCode вече бяха поправени (viz. .immediate() по-долу в двата
     handler-а). Доказано директно с два реални os процеса
     (test/reaudit-v24-a.test.js): и двете паралелни продължения се връщаха с
     ok:true, а renewals в базата оставаше 2 вместо истинските 3. Сега цялата
     проверка+запис е в ЕДНА db.transaction(...).immediate() транзакция, точно
     както при заемане — правото на запис се взима ПРЕДИ проверката на лимита,
     така че втората станция вижда вече обновения renewals и получава ясния
     отказ „Достигнат е лимитът…“, а не сурова "database is locked". */
  ipcMain.handle('loans:extend', (e, { id }) =>
    run(() => {
      const db = getDb();
      const tx = db.transaction(() => {
        const l = db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
        if (!l || l.date_in) throw new Error('Заемането не е активно.');
        const s = circRule(readerCategory(l.reader_id));
        const max = s.extensions_count == null ? 2 : s.extensions_count; // 0 = без лимит
        const used = l.renewals || 0;
        if (max && used >= max) throw new Error('Достигнат е лимитът от ' + max + ' продължения за това заемане.');
        /* Резервацията се преценява срещу СВОБОДНИТЕ бройки, точно както при заемане
           (consumeHoldOnCheckout в handlers/holds.js). Дотогава тук стоеше проверка на
           ниво заглавие: при 5 екземпляра, 1 зает и 1 резервация трети читател можеше
           да вземе бройка от рафта, но държащият не можеше да продължи своята — двете
           места се разминаваха, след като заемането мина на бройки. Продължението
           отнема една бройка от наличните, затова се отказва само когато свободните не
           стигат за чакащите пред този читател. */
        const holds = activeHolds ? activeHolds(l.book_id) : (firstActiveHold(l.book_id) ? [firstActiveHold(l.book_id)] : []);
        const others = holds.filter(x => x.reader_id !== l.reader_id);
        const free = freeCopies ? freeCopies(l.book_id) : 0;
        if (others.length && free < others.length) {
          const h = others[0];
          throw new Error('Книгата е резервирана от ' + h.reader_name + ' и няма свободна бройка за нея — ' +
            'срокът не може да се продължи.');
        }
        /* Продължението тръгва от по-късната от двете дати — стария срок и днес.
           Дотук стоеше само `l.date_due`, а бутонът „Продължи“ стои тъкмо на
           екрана „Просрочени“, където всяко заемане е с изтекъл срок: заемане със
           срок 15.01, продължено на 20.02, получаваше нов срок 14.02 — пак в
           миналото. Програмата казваше, че срокът е продължен, книгата се връщаше
           в списъка на просрочените още в същия миг, а едно от позволените
           продължавания беше изхабено. */
        const t = today();
        /* НАТРУПАНОТО СЕ УРЕЖДА, ПРЕДИ СРОКЪТ ДА СЕ ПРЕНАПИШЕ (одит v2.4.24).
           Дотук продължението само отместваше date_due — а бутонът „Продължи“ стои
           на ВСЕКИ ред от екрана „Просрочени“, точно под текста, който цитира
           чл. 43, ал. 2 и показва „Общо дължимо обезщетение“. Едно натискане
           заличаваше и обезщетението, и наказанието: проверено — заемане с 36 дни
           забава и 1.80 лв дължими излизаше от списъка на просрочените с fine = 0 и
           suspended_until = NULL, а върнато навреме след това даваше „забава 0 дни“.
           Парите не оставяха следа никъде, включително в „Начислено“ на справките
           (handlers/stats.js). „Събрани глоби“ се води по ПЛАЩАНИЯТА и не се
           влияе; „Начислено“ по заеманията брои затворените, затова начисленото по
           още отворено заемане се отчита отделно като „начислено по незавършени
           заемания“ — виж finesOpen в handlers/stats.js.
           Начислява се СЪЩОТО, което би начислило връщане на днешна дата — същият
           effectiveDaysLate и същият applySuspension — и се добавя към вече
           начисленото по това заемане, за да не се губи при второ продължение. */
        const lateNow = effectiveDaysLate(l.date_due, t);
        let addedFine = 0, suspendedUntil = null;
        if (lateNow > 0) {
          const cfg = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get();
          addedFine = lateNow * ((cfg && cfg.fine_per_day) || 0);
          if (addedFine) {
            db.prepare('UPDATE loans SET fine = COALESCE(fine, 0) + ? WHERE id = ?').run(addedFine, id);
          }
          suspendedUntil = applySuspension(l.reader_id, l.date_due, t);
        }
        const newDue = nextWorkDay(addDays((l.date_due && l.date_due > t) ? l.date_due : t, s.extension_days || 30));
        db.prepare('UPDATE loans SET date_due = ?, renewals = ? WHERE id = ?').run(newDue, used + 1, id);
        logAudit('Продължение на заемане', 'заемане № ' + id + ' до ' + newDue + ' (' + (used + 1) + (max ? '/' + max : '') + ')'
          + (lateNow ? ' — начислена забава ' + lateNow + ' дни' + (addedFine ? ', ' + addedFine.toFixed(2) + ' €' : '') : ''));
        logEvent('подновяване', { bookId: l.book_id, readerId: l.reader_id });
        return { date_due: newDue, renewals: used + 1, max, daysLate: lateNow, fine: addedFine, suspendedUntil };
      });
      return tx.immediate();
    })
  );

  /* ================================================================
     ИЗГУБЕН ИЛИ НЕВЪРНАТ ОТ ЧИТАТЕЛЯ ДОКУМЕНТ (v2.4.56)
     ================================================================
     КАКВО СТАВАШЕ ДОТУК. Програмата познаваше само два изхода на едно заемане:
     книгата се връща (loans:return / loans:returnByCode) или заемането виси
     отворено и трупа дни в „Просрочени“. Трети изход — читателят да каже „загубих
     я“ или просто да не я върне никога — нямаше. Библиотекарката правеше три
     несвързани действия на ръка: приемаше несъществуващата книга като върната (за
     да слезе от списъка), после ѝ сменяше състоянието в „Книги“, после отваряше
     картона на читателя и вписваше начисление „друго“. И трите бяха погрешни
     всяко по своему:
       • „приета обратно“ значи, че книгата е на рафта — годишният отчет я броеше
         сред върнатите, публичният каталог я обявяваше за налична, следващият
         читател я резервираше и идваше за нея;
       • обезщетението се смяташе ЕДИНСТВЕНО по дни просрочие (fine_per_day) —
         тоест за невърната книга за 80 лв. библиотеката „искаше“ 4 лв. забава и
         нищо за самата книга;
       • нищо не свързваше начислението с документа: когато след месеци се
         съставяше акт по чл. 30, т. 5 (повредени или невърнати от ползватели),
         в него не личеше нито че има начислено обезщетение, нито дали е събрано.

     КАКВО ПРАВИ ТОЗИ БЛОК. Приключва заемането ИЗРИЧНО като невърнато (loans.lost
     = 1 — отделен белег, а не досещане по дати), слага на документа състояние
     „изгубен“, вписва събитие от вид „изгубен“ (не „връщане“) и записва кой от
     трите изхода е избрал библиотекарят: обезщетение в пари, замяна с идентичен
     документ или замяна с равностоен документ. Следата носи името на читателя,
     инвентарния номер и заглавието на документа и сумата.

     ЗА РАЗМЕРА. Чл. 43, ал. 2 от Наредба № 3 урежда обезщетяването, но конкретният
     размер е решение на библиотеката (вътрешни правила/устройствен акт), не число,
     записано в наредбата. Затова програмата НЕ налага размер: предлага сума по
     правило, което библиотеката сама си задава в настройките (кратно на цената на
     документа), и библиотекарят я променя на ръка, когато случаят го изисква.
     Интерфейсът го казва с думи, за да не остане впечатление за нормативно
     изискване.

     ЗАЩО ЗАЕМАНЕТО СЕ ЗАТВАРЯ (date_in), А НЕ ОСТАВА ОТВОРЕНО. Отвореното заемане
     значи „екземплярът е у читател“ — то заема бройката (trg_loans_capacity),
     държи документа в „Просрочени“ и в напомнителните писма и го брои в лимита на
     читателя. Нито едно от тези неща не е вярно за изгубен документ: случаят е
     приключен, остава само отчисляването. Затова редът се затваря, но с белега
     lost = 1, по който всеки консуматор може да го отличи от истинско връщане —
     точно както deaccession_act_id вече отличава заеманията, закрити от акт. */
  const LOST_RESOLUTIONS = ['обезщетение', 'замяна с идентичен документ', 'замяна с равностоен документ'];
  /* Подразбиращи се стойности на ПРАВИЛОТО, не на нормата. Тройният размер е
     разпространената практика в обществените библиотеки и е само предложение —
     затова стои като число в настройка, която библиотекарят вижда и променя.
     LOST_FALLBACK_DEFAULT покрива стария фонд без вписана цена: инвентарните
     книги отпреди деноминацията често нямат стойност, а нула като предложено
     обезщетение е по-лоша от каквото и да е — изглежда като пресметнат отговор. */
  const LOST_MULTIPLIER_DEFAULT = 3;
  const LOST_FALLBACK_DEFAULT = 10;

  /* Миграцията стои ТУК, а не в main.js, по вече установения в проекта образец
     (виж ensureLoanActColumn в handlers/deaccession-acts.js): модулът трябва да
     работи и когато е зареден самостоятелно (тестовете го правят), а
     ALTER TABLE ... ADD COLUMN е идемпотентно защитен с PRAGMA table_info.
     Стара база не се пренаписва и не се проверява — колоните просто се добавят
     празни, а празно значи „това заемане не е приключено като изгубено“, което
     за всички досегашни редове е вярно.
     applyEnumTriggers() се вика от същото място и по същата причина: миграции 5
     и 9 в main.js отдавна са минали за всяка действаща инсталация, тоест новите
     стойности „изгубен“ и „обезщетение за изгубен документ“ иначе нямаше да
     стигнат до нито една реална база и първото натискане на бутона щеше да върне
     „Непозната стойност за books.status.“ (виж бележката при buildSql там).
     Проверката се прави веднъж на база и е евтина. */
  let lostSchemaChecked = null;
  function ensureLostSchema(db) {
    if (lostSchemaChecked === db) return;
    const loanCols = db.prepare('PRAGMA table_info(loans)').all().map(c => c.name);
    const addLoan = {
      lost: 'INTEGER',                       // 1 = приключено като изгубено/невърнато
      lost_date: 'TEXT',                     // денят, в който библиотекарят го е приключил
      lost_resolution: 'TEXT',               // обезщетение | замяна с идентичен документ | замяна с равностоен документ
      lost_amount: 'REAL',                   // договореното обезщетение в евро (0 при замяна)
      lost_account_line_id: 'INTEGER',       // редът в читателската сметка, ако има начисление
      lost_replacement_book_id: 'INTEGER',   // приетият вместо изгубения документ, ако е вписан във фонда
      lost_replacement_note: 'TEXT',         // описание на приетия документ (когато още няма инв. №)
      lost_note: 'TEXT'                      // бележка на библиотекаря по случая
    };
    for (const [name, ddl] of Object.entries(addLoan)) {
      if (!loanCols.includes(name)) db.exec(`ALTER TABLE loans ADD COLUMN ${name} ${ddl}`);
    }
    const setCols = db.prepare('PRAGMA table_info(settings)').all().map(c => c.name);
    /* Двете настройки нарочно са БЕЗ DEFAULT в схемата: NULL значи „библиотеката
       не е пипала правилото“ и кодът пада към LOST_*_DEFAULT. Ако тук стоеше
       DEFAULT 3, нямаше да се различава библиотека, която изрично е решила
       тройния размер, от такава, която просто не е отваряла настройката — а
       разликата има значение в деня, в който подразбиращото се число се промени. */
    if (!setCols.includes('lost_price_multiplier')) db.exec('ALTER TABLE settings ADD COLUMN lost_price_multiplier REAL');
    if (!setCols.includes('lost_fallback_amount')) db.exec('ALTER TABLE settings ADD COLUMN lost_fallback_amount REAL');
    applyEnumTriggers(db);
    lostSchemaChecked = db;
  }

  const toCents = (n) => Math.round((Number(n) || 0) * 100) / 100;
  function lostPolicy(db) {
    const s = db.prepare('SELECT lost_price_multiplier, lost_fallback_amount FROM settings WHERE id = 1').get() || {};
    const m = Number(s.lost_price_multiplier);
    const f = Number(s.lost_fallback_amount);
    return {
      multiplier: Number.isFinite(m) && m > 0 ? m : LOST_MULTIPLIER_DEFAULT,
      fallback: Number.isFinite(f) && f > 0 ? f : LOST_FALLBACK_DEFAULT,
      multiplierSet: Number.isFinite(m) && m > 0,
      fallbackSet: Number.isFinite(f) && f > 0,
      defaults: { multiplier: LOST_MULTIPLIER_DEFAULT, fallback: LOST_FALLBACK_DEFAULT },
      resolutions: LOST_RESOLUTIONS
    };
  }
  /* Предложението е кратно на ЦЕНАТА ПО ИНВЕНТАРНАТА КНИГА, защото тя е
     единствената стойност на документа, която библиотеката може да докаже пред
     ревизия. Документ без вписана цена не дава нула (виж LOST_FALLBACK_DEFAULT) —
     връща се резервната сума и изрично се казва, че цена няма, за да не изглежда
     резервното число като пресметнато. */
  function suggestLostAmount(book, policy) {
    const price = Number(book && book.price);
    if (Number.isFinite(price) && price > 0) {
      return { amount: toCents(price * policy.multiplier), basis: 'цена', price };
    }
    return { amount: toCents(policy.fallback), basis: 'без цена', price: 0 };
  }

  ipcMain.handle('loans:lostPolicy', () => run(() => { const db = getDb(); ensureLostSchema(db); return lostPolicy(db); }));
  /* Правилото живее на ДВЕ места и това е нарочно. „Настройки“ → „Заемане“ го
     задава веднъж, за библиотеката (settings:update от v2.4.56 знае и двете
     колони). Този канал го сменя от самия прозорец „Документът е изгубен“ —
     защото точно там библиотекарката вижда, че предложената сума не отговаря на
     решението на настоятелството, и няма смисъл да я пращаме през цял друг
     екран. Двата пътя пишат в едни и същи колони, а следата казва кой и кога. */
  ipcMain.handle('loans:lostPolicySave', (e, { multiplier, fallback } = {}) =>
    run(() => {
      const db = getDb();
      ensureLostSchema(db);
      const m = Number(multiplier), f = Number(fallback);
      if (!Number.isFinite(m) || m <= 0) throw new Error('Кратността трябва да е положително число (например 3 за троен размер).');
      if (!Number.isFinite(f) || f <= 0) throw new Error('Сумата за документ без вписана цена трябва да е положителна.');
      db.prepare('UPDATE settings SET lost_price_multiplier = ?, lost_fallback_amount = ? WHERE id = 1')
        .run(m, toCents(f));
      logAudit('Редакция на настройки', 'правило за обезщетение при изгубен документ: '
        + m + '-кратно на цената; ' + toCents(f).toFixed(2) + ' € за документ без вписана цена');
      return lostPolicy(db);
    })
  );

  /* Какво ще види библиотекарят в прозореца, ПРЕДИ да реши. Смята се в главния
     процес по същите функции, по които после ще се запише — иначе екранът пак би
     показал едно число, а гишето да начисли друго (същата болест, поправена вече
     три пъти при обезщетението за просрочие, виж loans:overdue по-горе). */
  ipcMain.handle('loans:lostQuote', (e, { id, date } = {}) =>
    run(() => {
      const db = getDb();
      ensureLostSchema(db);
      const l = db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id);
      if (!l) throw new Error('Заемането не е намерено.');
      if (l.date_in) throw new Error('Това заемане вече е приключено на ' + l.date_in.split('-').reverse().join('.') + '.');
      const when = date && isValidIsoDate(date) ? date : today();
      const policy = lostPolicy(db);
      const b = db.prepare('SELECT price FROM books WHERE id = ?').get(l.book_id) || {};
      const sug = suggestLostAmount(b, policy);
      const cfg = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get();
      const daysLate = effectiveDaysLate(l.date_due, when);
      return {
        loan_id: l.id, book_id: l.book_id, reader_id: l.reader_id,
        title: l.title, author: l.author, inv_number: l.inv_number,
        reader_name: l.reader_name, card_no: l.card_no,
        date_out: l.date_out, date_due: l.date_due,
        price: sug.price, basis: sug.basis, suggested: sug.amount, policy,
        // Начисленото за забава е ОТДЕЛНО задължение и не се слива с обезщетението
        // за самия документ — виж защо в db/enum-triggers.js при account_lines.type.
        daysLate, fineAccrued: toCents(Number(l.fine) || 0),
        fineToAdd: toCents(daysLate * ((cfg && cfg.fine_per_day) || 0))
      };
    })
  );

  ipcMain.handle('loans:markLost', (e, { id, resolution, amount, replacement_code, replacement_note, note, date } = {}) =>
    run(() => {
      if (date != null && date !== '' && !isValidIsoDate(date)) {
        throw new Error('Датата (' + date + ') е невалидна.');
      }
      if (!LOST_RESOLUTIONS.includes(resolution)) {
        throw new Error('Изберете как се урежда случаят: ' + LOST_RESOLUTIONS.join(', ') + '.');
      }
      const db = getDb();
      ensureLostSchema(db);
      const when = date || today();
      const tx = db.transaction(() => {
        const l = db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id);
        if (!l) throw new Error('Заемането не е намерено.');
        /* Същата защита срещу двойно приключване като при loans:return — и по
           същата причина: бутонът стои на два екрана („Заемане и връщане“ и
           „Просрочени“), а второто натискане би начислило обезщетението ВТОРИ
           път в сметката на читателя. Проверката е двойна: изрична тук (за да
           има разбираемо съобщение) и атомарна в `AND date_in IS NULL` по-долу
           (за да не мине при две станции едновременно). */
        if (l.date_in) {
          throw new Error('Това заемане вече е приключено на ' + l.date_in.split('-').reverse().join('.')
            + (l.lost ? ' като изгубен документ' : ' с връщане') + ' — не се приключва втори път.');
        }
        /* ЗАМЯНАТА ТРЯБВА ДА СОЧИ КЪМ НЕЩО. „Читателят донесе друга книга“ без
           никакво указание коя е тя не става следа — след година никой не може да
           каже дали фондът наистина е възстановен. Затова се иска или инвентарен
           номер/баркод на вече вписания заместител, или поне описанието му, ако
           още не е заведен в инвентарната книга (новопостъпил документ се
           инвентира отделно, по общия ред — програмата не го вписва сама, за да
           не се появи екземпляр без партида и без номер). */
        let replBook = null;
        const replNote = String(replacement_note || '').trim();
        if (resolution !== 'обезщетение') {
          const code = normalizeScanCode(replacement_code);
          if (code) {
            replBook = resolveScannedBook(db, code, BOOK_SELECT);
            if (!replBook) throw new Error('Няма документ с баркод/инв. № „' + replacement_code + '“. '
              + 'Впишете заместващия документ в „Книги“ (той получава свой инвентарен номер) или опишете го в полето „Описание“.');
            if (replBook.id === l.book_id) throw new Error('Заместващият документ не може да е самият изгубен документ.');
            if (replBook.status === 'отчислен') throw new Error('Инв. № ' + replBook.inv_number + ' е отчислен от фонда и не може да замести изгубения документ.');
          }
          if (!replBook && !replNote) {
            throw new Error('Запишете кой документ е приет вместо изгубения — инвентарен номер/баркод или описание.');
          }
        }
        /* Забавата до деня на приключването се начислява, преди заемането да се
           затвори — точно както прави и loans:extend (виж бележката там). Иначе
           натискането на „Документът е изгубен“ би заличило вече натрупаното по
           просрочието: книга с 60 дни забава излизаше от списъка с fine = 0.
           Двете суми си остават различни неща: тази влиза в loans.fine (забава),
           обезщетението за самия документ — в читателската сметка. */
        const daysLate = effectiveDaysLate(l.date_due, when);
        const cfg = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get();
        const addedFine = toCents(daysLate * ((cfg && cfg.fine_per_day) || 0));
        const amt = resolution === 'обезщетение' ? toCents(Math.abs(Number(amount) || 0)) : 0;
        if (resolution === 'обезщетение' && !amt) {
          throw new Error('Въведете размер на обезщетението (поне 0.01 €) или изберете замяна с документ.');
        }
        let lineId = null;
        if (resolution === 'обезщетение') {
          const charge = chargeLost(db, {
            reader_id: l.reader_id, amount: amt, date: when,
            note: 'Невърнат документ инв. № ' + (l.inv_number ?? '—') + ' — ' + l.title
          });
          lineId = charge.id;
        }
        const upd = db.prepare(`
          UPDATE loans SET date_in = ?, lost = 1, lost_date = ?, lost_resolution = ?, lost_amount = ?,
            lost_account_line_id = ?, lost_replacement_book_id = ?, lost_replacement_note = ?, lost_note = ?,
            fine = COALESCE(fine, 0) + ?
          WHERE id = ? AND date_in IS NULL
        `).run(when, when, resolution, amt, lineId, replBook ? replBook.id : null,
          replNote || null, String(note || '').trim() || null, addedFine, id);
        if (upd.changes === 0) throw new Error('Това заемане вече е приключено — не се приключва втори път.');
        /* Състоянието на документа се сменя ВЪТРЕ в същата транзакция. Ако това
           беше отделно действие (както го правеше библиотекарката на ръка),
           прекъсване по средата оставяше затворено заемане и книга, която фондът
           още води за налична — тоест заемаема и видима в публичния каталог.
           Документът НЕ се отчислява тук: отчисляването е акт на комисия по
           чл. 30 и чл. 35 и се прави от „Отчисляване“; дотогава документът стои
           във фонда със състояние „изгубен“ и се брои в наличността, както
           изисква и самата наредба. */
        db.prepare('UPDATE books SET status = ?, status_date = ? WHERE id = ?').run(BOOK_STATUS_LOST, when, l.book_id);
        /* Събитието е от вид „изгубен“, НЕ „връщане“ — книгата не се е върнала и
           не бива да влиза в броя върнати документи нито в дневника, нито в
           годишния отчет. */
        logEvent(EVENT_KIND_LOST, { bookId: l.book_id, readerId: l.reader_id, date: when });
        /* Наказанието в дни се налага по същото правило, както при връщане със
           забава: просрочието е факт независимо от това, че книгата няма да се
           върне. Смисълът му тук е практичен — читателят не бива да си тръгне с
           нова книга в ръка в деня, в който е признал, че предишната я няма. */
        const suspendedUntil = applySuspension(l.reader_id, l.date_due, when);
        /* Резервациите по този документ нарочно НЕ се пипат. Отказването им е
           решение, взето при отчисляването (виж handlers/deaccession-acts.js,
           където отказаната резервация носи номера на акта и снимка на
           предишното си състояние) — тук документът още е във фонда и все още е
           възможно читателят да го върне намерен или да донесе заместител. */
        logAudit('Изгубен документ',
          'инв. № ' + (l.inv_number ?? '—') + ' — ' + l.title + '; читател ' + l.reader_name
          + (l.card_no ? ' (карта ' + l.card_no + ')' : '')
          + '; ' + resolution
          + (amt ? ' ' + amt.toFixed(2) + ' € (начислено в читателската сметка)' : '')
          + (replBook ? '; приет вместо него инв. № ' + (replBook.inv_number ?? '—') + ' — ' + replBook.title : '')
          + (!replBook && replNote ? '; приет вместо него: ' + replNote : '')
          + (addedFine ? '; начислена забава ' + daysLate + ' дни, ' + addedFine.toFixed(2) + ' €' : ''));
        return {
          title: l.title, inv_number: l.inv_number, reader_name: l.reader_name,
          resolution, amount: amt, account_line_id: lineId,
          replacement: replBook ? { id: replBook.id, inv_number: replBook.inv_number, title: replBook.title } : null,
          replacement_note: replNote || null,
          daysLate, fineAdded: addedFine, suspendedUntil
        };
      });
      const r = tx.immediate();
      scheduleCatalogWrite(); // документът вече не е „наличен“ — пише файл, не база
      return r;
    })
  );

  /* СПИСЪКЪТ ЗА АКТА ПО ЧЛ. 30, Т. 5.
     =====================================================================
     Отчисляването на невърнат документ е отделно действие, което се прави
     по-късно и от друг човек (комисията). Дотогава изгубените документи нямаше
     къде да се видят заедно: библиотекарката трябваше да ги помни. Тук се връща
     всичко, което актът и придружаващата го следа изискват — документът, читателят
     който не го е върнал, как е уреден случаят, колко е начислено и КОЛКО ОТ
     НЕГО Е СЪБРАНО (chargeCoverage в handlers/account.js разнася плащанията по
     същото правило, по което ги разнася и справката „Приходи от такси и
     обезщетения“, за да не твърдят двете различни неща за едни и същи пари).
     `acted` казва дали документът вече е влязъл в акт — редовете не изчезват след
     отчисляването, защото връзката „акт → начислено/събрано обезщетение“ е
     точно това, което трябва да остане видимо и след него. */
  ipcMain.handle('loans:lost', (e, { includeActed } = {}) =>
    run(() => {
      const db = getDb();
      ensureLostSchema(db);
      const rows = db.prepare(`
        SELECT l.id, l.book_id, l.reader_id, l.date_out, l.date_due, l.lost_date, l.lost_resolution,
               l.lost_amount, l.lost_account_line_id, l.lost_replacement_book_id, l.lost_replacement_note,
               l.lost_note, l.fine,
               b.title, b.author, b.inv_number, b.price, b.status, b.deaccession_act_id, b.deaccession_date,
               r.name AS reader_name, r.card_no,
               rb.inv_number AS replacement_inv_number, rb.title AS replacement_title
        FROM loans l
        JOIN books b ON b.id = l.book_id
        JOIN readers r ON r.id = l.reader_id
        LEFT JOIN books rb ON rb.id = l.lost_replacement_book_id
        WHERE l.lost = 1
        ORDER BY l.lost_date DESC, l.id DESC
      `).all();
      const out = [];
      for (const row of rows) {
        row.acted = row.deaccession_act_id != null || row.deaccession_date != null;
        if (!includeActed && row.acted) continue;
        /* Начислението може и да е изтрито от картона на читателя (account:
           deleteLine го позволява и оставя следа). Тогава НЕ се показва нула —
           нулата значи „платено докрай“ и точно тя не бива да се появи под акт,
           по който парите никога не са били начислени. */
        row.charge = row.lost_account_line_id ? chargeCoverage(db, row.lost_account_line_id) : null;
        row.chargeMissing = !!row.lost_account_line_id && !row.charge;
        row.chargeType = LOST_CHARGE_TYPE;
        out.push(row);
      }
      return out;
    })
  );

  /* Заемане и връщане чрез баркод четец — четецът въвежда текст и Enter, точно
     както при физическа клавиатура, затова тук се приема inv. номер или баркод. */
  // normalizeScanCode() (v1.70.1) — виж books:byBarcode в handlers/books.js за
  // обяснението на кирилско/латинско разминаване при баркод четец.
  ipcMain.handle('loans:checkoutByCode', (e, { reader_id, code, date_out }) =>
    run(() => {
      if (date_out != null && date_out !== '' && !isValidIsoDate(date_out)) {
        throw new Error('Датата на заемане (' + date_out + ') е невалидна.');
      }
      const db = getDb();
      const tx = db.transaction(() => {
        const c = normalizeScanCode(code);
        /* Одит v2.4.24: дотук беше `barcode = ? OR inv_number = CAST(? AS INTEGER)`
           с .get() — при числов баркод, който съвпада с ЧУЖД инвентарен номер,
           SQLite връщаше просто реда с по-малък rowid, тихо и без предупреждение,
           и на гишето се заемаше друга книга. resolveScannedBook() (security-utils.js)
           дава предимство на баркода и ОТКАЗВА, вместо да гадае, когато кодът сочи
           два различни документа. */
        const b = resolveScannedBook(db, c, BOOK_SELECT);
        if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
        if (b.status === 'отчислен') throw new Error('Инв. № ' + b.inv_number + ' е отчислен от фонда.');
        // Виж бележката при loans:checkout — изгубеният документ не се заема по нито една от двете врати.
        if (b.status === BOOK_STATUS_LOST) {
          throw new Error('Инв. № ' + b.inv_number + ' е отбелязан като изгубен/невърнат. Ако документът се е намерил, '
            + 'върнете състоянието му на „наличен“ от „Книги“; ако не — отчислете го с акт по чл. 30, т. 5.');
        }
        /* Свободна бройка, а не „има ли изобщо отворен заем". Моделът на данните
           изрично поддържа няколко екземпляра на едно заглавие (inventory.quantity),
           а самата схема има тригер trg_loans_capacity, чийто коментар гласи, че
           правилото е „активните заемания не надвишават бройките", и уникален индекс
           нарочно НЕ се слага, „защото би забранил легитимните втори бройки". Тази
           проверка обаче отказваше при какъвто и да е отворен заем — второто копие
           на учебник си стоеше незаемаемо, докато таблото показва „налично 1/2".
           loans:checkout (заемане без баркод) винаги е броял правилно. */
        const inv = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(b.id);
        const qty = inv ? inv.quantity : 0;
        const outCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(b.id).n;
        if (outCount >= qty) {
          const openLoan = db.prepare(`${LOAN_SELECT} WHERE l.book_id = ? AND l.date_in IS NULL ORDER BY l.date_due`).get(b.id);
          throw new Error(qty <= 1 && openLoan
            ? 'Инв. № ' + b.inv_number + ' вече е зает от ' + openLoan.reader_name + ' до ' + openLoan.date_due + '.'
            : 'Няма свободна бройка от инв. № ' + b.inv_number + ' — заети са всички ' + qty + '.');
        }
        const s = circRule(readerCategory(reader_id));
        const current = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ? AND date_in IS NULL').get(reader_id).n;
        if (s.max_books && current >= s.max_books) throw new Error('Достигнат е лимитът от ' + s.max_books + ' документа за читател.');
        checkSuspended(reader_id);
        consumeHoldOnCheckout(b.id, reader_id);
        const out = date_out || today();
        const dueStr = nextWorkDay(addDays(out, s.loan_days || 30));
        const info = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(reader_id, b.id, out, dueStr);
        logAudit('Заемане', 'инв. № ' + b.inv_number + ' — ' + b.title);
        logEvent('заемане', { bookId: b.id, readerId: reader_id, date: out });
        return { id: info.lastInsertRowid, title: b.title, inv_number: b.inv_number, date_due: dueStr };
      });
      const result = tx.immediate();
      scheduleCatalogWrite();
      return result;
    })
  );
  ipcMain.handle('loans:returnByCode', (e, { code, date_in }) =>
    run(() => {
      if (date_in != null && date_in !== '' && !isValidIsoDate(date_in)) {
        throw new Error('Датата на връщане (' + date_in + ') е невалидна.');
      }
      const db = getDb();
      const c = normalizeScanCode(code);
      const inDate = date_in || today();
      /* Същата транзакция и същата атомарна защита като при loans:return — това
         е ДРУГИЯТ път за връщане (сканиране на баркод) и на гишето минава по-често
         от бутона. Дотук тук нямаше нито транзакция, нито `AND date_in IS NULL`:
         прекъсване между UPDATE-а и logEvent оставяше заемането затворено без
         събитие (годишният отчет тихо с едно по-малко), а двойно сканиране на
         един и същ баркод удвояваше наказанието.
         Одит v2.4.24: и намирането на документа, и намирането на заемането, и
         пресмятането на глобата вече са ВЪТРЕ в транзакцията — иначе другото
         работно място можеше да продължи срока между четенето на date_due и
         записа, и се начисляваше глоба за вече несъществуващ падеж. */
      const tx = db.transaction(() => {
        const b = resolveScannedBook(db, c);
        if (!b) throw new Error('Няма документ с баркод/инв. № „' + code + '“.');
        /* ORDER BY + отказ при повече от едно отворено заемане (одит v2.4.24):
           дотук .get() без подредба вземаше произволното (по rowid) от няколкото
           отворени заемания на стар неразделен ред с няколко бройки — връщаше се
           чуждо заемане, с чужда глоба и чуждо наказание. */
        const open = db.prepare(`${LOAN_SELECT} WHERE l.book_id = ? AND l.date_in IS NULL ORDER BY l.date_due, l.id`).all(b.id);
        if (!open.length) throw new Error('Инв. № ' + b.inv_number + ' не е заето в момента.');
        /* Няколко отворени заемания на един ред е НОРМАЛНО, когато редът наистина
           носи няколко бройки (loans:checkoutByCode по-долу изрично го допуска —
           втората бройка на учебник). Тогава връщането се отнася за най-просроченото
           заемане: подредбата по падеж е определена и повтаряема, а дотук .get() без
           ORDER BY вземаше произволното по rowid.
           ОТКАЗВА се само когато редът е ПРОТИВОРЕЧИВ — една бройка, две заемания:
           там не може да се знае чие е връщането, а грешката струва чужда глоба и
           чуждо наказание. (Първата редакция на тази поправка отказваше при всеки
           втори отворен заем и правеше гишето по баркод неизползваемо за всяко
           заглавие с повече от една бройка — намерено при прегледа на кръга.) */
        const invRow = db.prepare('SELECT quantity FROM inventory WHERE book_id = ?').get(b.id);
        const qty = invRow && invRow.quantity != null ? Number(invRow.quantity) : 1;
        /* Противоречив е редът, при който отворените заемания са ПОВЕЧЕ ОТ БРОЙКИТЕ
           — не само при една бройка (втори преглед на кръга: 3 заемания при
           коригирани на 2 бройки минаваха и затваряха чуждо заемане с чужда глоба). */
        /* `open.length > 1 &&` (одит v2.4.25): стар ред с бройка 0 („Проверка на
           данните“ го признава за поправим) и ЕДНО заемане, отворено преди
           нулирането, не е противоречие — а се отказваше с „зает от 1 читатели при
           0 налични бройки“. Противоречие има само при повече от едно заемане. */
        if (open.length > 1 && open.length > qty) {
          throw new Error('Инв. № ' + b.inv_number + ' е заведен като зает от ' + open.length + ' читатели ('
            + open.map(l => l.reader_name).join(', ') + ') при ' + qty + (qty === 1 ? ' налична бройка' : ' налични бройки')
            + '. Приемете връщането от екрана „Просрочени“ или от картона на читателя в „Заемане и връщане“, '
            + 'за да е ясно кой връща, и проверете реда от „Настройки“ → „Проверка на данните“.');
        }
        const loan = open[0];
        const cfg = db.prepare('SELECT fine_per_day FROM settings WHERE id = 1').get();
        // v1.70.0: effectiveDaysLate() вместо суров брой календарни дни — виж
        // бележката при loans:return по-горе; наказанието в дни за същото
        // просрочие вече ползваше изчистените от затворени дни.
        const daysLate = effectiveDaysLate(loan.date_due, inDate);
        const fine = daysLate * ((cfg && cfg.fine_per_day) || 0);
        // Натрупване, не присвояване — виж бележката при loans:return по-горе.
        const upd = db.prepare('UPDATE loans SET date_in = ?, fine = COALESCE(fine, 0) + ? WHERE id = ? AND date_in IS NULL')
          .run(inDate, fine, loan.id);
        if (upd.changes === 0) throw new Error('Това заемане вече е върнато — не се приема втори път.');
        const fineTotal = db.prepare('SELECT fine FROM loans WHERE id = ?').get(loan.id).fine || 0;
        logAudit('Връщане', 'инв. № ' + b.inv_number + ' — ' + b.title + (daysLate ? ' (забава ' + daysLate + (daysLate === 1 ? ' ден' : ' дни') + ')' : ''));
        logEvent('връщане', { bookId: b.id, readerId: loan.reader_id, date: inDate });
        return {
          title: b.title, inv_number: b.inv_number, reader_name: loan.reader_name, daysLate,
          fine: fineTotal, fineNow: fine,
          suspendedUntil: applySuspension(loan.reader_id, loan.date_due, inDate),
          hold: activateHoldOnReturn(b.id)
        };
      });
      const r = tx.immediate();
      scheduleCatalogWrite(); // пише файл, не база — извън транзакцията
      return {
        title: r.title, inv_number: r.inv_number, reader_name: r.reader_name,
        daysLate: r.daysLate, fine: r.fine, fineNow: r.fineNow, suspendedUntil: r.suspendedUntil,
        hold: r.hold ? { reader_name: r.hold.reader_name, card_no: r.hold.card_no, phone: r.hold.phone } : null
      };
    })
  );

  // LOAN_SELECT се връща обратно към main.js — ползва се и от все още
  // неизвадените домейни "Табло" и "Просрочени: напомняния".
  // effectiveDaysLate се връща по същата причина: напомнянията трябва да искат
  // ТОЧНО сумата, която после ще се начисли на гишето (виж loans:overdueByReader).
  return { LOAN_SELECT, effectiveDaysLate };
};
