// Читателска сметка (Koha: accountlines) — извадени от main.js в отделен
// модул (Фаза 4, стъпка 18). amount > 0 = начислено (дължи се), amount < 0 =
// платено. Балансът е SUM(amount). Не е касов модул — само дневник на
// движенията + квитанция за печат.
const { LOST_CHARGE_TYPE, LATE_FEE_CHARGE_TYPE } = require('../db/enum-triggers');

/* Балансът се закръгля до стотинки, преди да излезе оттук. Сумите се пазят
   като REAL и 1.10+1.10+1.10−3.30 дава 4.44e-16, а не 0 — платената докрай
   сметка светваше в червено с „0.00 лв. (дължи)". Закръглянето е тук, а не в
   изгледа, защото балансът тръгва оттук към всички екрани (сметка, „Заемане и
   връщане", квитанции) и трябва да е един и същ навсякъде.
   v2.4.56: изнесено извън registerAccountHandlers(), за да го ползват и двете
   помощни функции по-долу, които се викат ПО РЕФЕРЕНЦИЯ от handlers/loans.js
   (извън обхвата на регистрацията) — иначе там щеше да се появи второ, „почти
   същото“ закръгляне, а разликата от 1e-16 вече веднъж боядиса платена сметка в
   червено. */
/* Едно закръгляне за цялата програма — виж toCents в db/fund-sql.js (v2.4.67). */
const { toCents } = require('../db/fund-sql');
const { isValidIsoDate } = require('../security-utils');

/* ДАТАТА НА РЕДА В СМЕТКАТА СЕ ПРОВЕРЯВА (v2.4.72). Дотук каквото дойде в
   `date`, влизаше в account_lines — „2026-13-01“ или „утре“ оставаха в
   касовия дневник и падаха извън всяка година в „Приходи от такси“. Празна
   дата значи „днес“, както досега. */
function assertLineDate(date, what) {
  if (date != null && date !== '' && !isValidIsoDate(date)) {
    throw new Error('Датата (' + date + ') е невалидна — очаква се ГГГГ-ММ-ДД. ' + what);
  }
}

/* НАЧИСЛЕНИЕТО ЗА ИЗГУБЕН ДОКУМЕНТ СЕ ПИШЕ ОТ ТУК, А НЕ ОТ ЗАЕМАНИЯТА (v2.4.56).
   =====================================================================
   handlers/loans.js приключва заемането като „изгубен/невърнат“ и трябва да
   начисли обезщетението в читателската сметка. Съблазнително беше да напише
   INSERT-а на място — един ред SQL. Точно така обаче в програмата вече се бяха
   появили два различни начина да се впише движение по сметката, всеки със свое
   закръгляне и своя представа за знака, и точно това правило (плюс = дължи се,
   минус = платено) е единственото, което държи баланса верен. Сметката има ЕДНО
   място, което пише в нея — този файл, — затова заеманията викат функция оттук.
   Извиква се ВЪТРЕ в транзакцията на loans:markLost (подава се db, не getDb),
   за да няма състояние, при което документът е отбелязан за изгубен, а парите не
   са начислени на никого. Одитната следа се пише от викащия, който единствен
   знае за кой документ става дума. */
function chargeLost(db, { reader_id, amount, date, note }) {
  const amt = toCents(Math.abs(Number(amount) || 0));
  if (!amt) throw new Error('Размерът на обезщетението трябва да е положителен (поне 0.01 €).');
  const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(reader_id, date, 'начисление', LOST_CHARGE_TYPE, amt, note || null);
  return { id: info.lastInsertRowid, amount: amt };
}

/* ОБЕЗЩЕТЕНИЕТО ЗА ПРОСРОЧИЕ СЪЩО МИНАВА ПРЕЗ СМЕТКАТА (v2.4.61).
   =====================================================================
   КАКВО СТАВАШЕ ДОТУК. Чл. 43 от Наредба № 3 урежда ЕДНО задължение на
   ползвателя към библиотеката — да обезщети библиотеката, когато не върне
   документа в срок или изобщо. Програмата обаче го водеше на две несвързани
   места: обезщетението за ИЗГУБЕН документ влизаше в читателската сметка (виж
   chargeLost по-горе, v2.4.56), а обезщетението за ЗАБАВА се записваше
   единствено в loans.fine — колона на заемането, която никоя сметка не чете.
   Последиците бяха три, и трите се виждат от гишето:
     • „Дължи по сметка“ в „Заемане и връщане“ (и балансът в картона) не
       включваше начислената забава — библиотекарката връщаше книга с 2,40 €
       забава и веднага след това екранът твърдеше, че читателят не дължи нищо;
     • „Събрани обезщетения“ в годишния отчет се смята по ПЛАЩАНИЯТА, разнесени
       по начисленията (handlers/stats.js) — а щом начисление няма, платените
       за забава пари нямаше как да се отчетат като събрано обезщетение НИКОГА;
     • изтриването на читател се спираше от неплатен баланс (handlers/readers.js),
       но забавата не влизаше в баланса, тоест читател с дължима глоба се триеше
       без дума.
   ЗАЩО ФУНКЦИЯТА Е ТУК. По същата причина, по която тук е и chargeLost:
   сметката има ЕДНО място, което пише в нея, с едно закръгляне и едно правило
   за знака (плюс = дължи се, минус = платено). Извиква се ВЪТРЕ в транзакцията
   на връщането/продължението (подава се db, не getDb), за да няма състояние, в
   което заемането е затворено с начислена забава, а в сметката ѝ няма следа.
   ВИДЪТ е „обезщетение“ — съществуващият вид, който handlers/stats.js вече брои
   в „Събрани обезщетения“; не се въвежда нов, защото по чл. 43 това е същото
   задължение, само с друго основание (забава вместо невръщане).
   ДВОЙНО НАЧИСЛЯВАНЕ НЯМА: викащият подава САМО току-що начисленото (fineNow /
   addedFine), а не цялото натрупано по заемането. Виж бележките при loans:return
   и loans:extend за това защо loans.fine се натрупва, а не се презаписва. */
function chargeOverdueFine(db, { reader_id, amount, date, note }) {
  const amt = toCents(Math.abs(Number(amount) || 0));
  // Нула не е начисление: заемане, върнато в срок, не бива да оставя ред от 0.00 €
  // в сметката — той изглежда като задължение и мърси картона.
  if (!amt) return null;
  const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
    /* Видът е ЗАБАВА, не „обезщетение“ (v2.4.69) — виж LATE_FEE_CHARGE_TYPE в
       db/enum-triggers.js: по вида се решава кое е платено, а „обезщетение“ се
       ползва и за ръчни начисления (повредена корица), които нямат нищо общо със
       забавата и не бива да „изяждат“ плащането ѝ. */
    .run(reader_id, date, 'начисление', LATE_FEE_CHARGE_TYPE, amt, note || null);
  return { id: info.lastInsertRowid, amount: amt };
}

/* ПОКРИТО ЛИ Е ЕДНО КОНКРЕТНО НАЧИСЛЕНИЕ (v2.4.56).
   =====================================================================
   Въпросът идва от акта по чл. 30, т. 5: отчислява се документ, невърнат от
   читател, и в акта (или поне в следата към него) трябва да личи дали
   обезщетението по него е СЪБРАНО, или само начислено. Дотук на този въпрос
   нямаше как да се отговори: плащанията в account_lines не носят вид и не сочат
   към начисление — „платих 5 лв.“ и нищо повече.
   Затова се прилага същото правило, по което се води всяка сметка и по което
   handlers/stats.js вече разнася плащанията: НАЙ-СТАРОТО ЗАДЪЛЖЕНИЕ СЕ ПОКРИВА
   ПЪРВО. Начислението е покрито дотолкова, доколкото платеното от читателя
   стига, след като са покрити всички по-стари негови задължения. Подредбата е
   буквално същата като в stats.js (дата, после начисленията преди плащанията в
   рамките на един ден, после id) — ако двете се разминат, справката „Събрани
   обезщетения“ и актът ще твърдят различни неща за едни и същи пари.
   Връща { charged, covered, outstanding }; за несъществуващ ред — null, за да
   може викащият да каже „начислението е изтрито“, вместо да покаже нула. */
function chargeCoverage(db, lineId) {
  const line = db.prepare('SELECT id, reader_id, amount FROM account_lines WHERE id = ?').get(lineId);
  if (!line) return null;
  const lines = db.prepare(`
    SELECT id, kind, amount FROM account_lines WHERE reader_id = ?
    ORDER BY date, (CASE kind WHEN 'начисление' THEN 0 ELSE 1 END), id
  `).all(line.reader_id);
  const queue = [];
  /* АВАНСЪТ ПОКРИВА СЛЕДВАЩОТО НАЧИСЛЕНИЕ (v2.4.67). Дотук надплатеното „не се
     приписваше на нищо“. Възпроизведено: читател плаща 5,00 € на 10.03,
     начислението за изгубен документ се вписва на 11.03 — account:get показва
     салдо 0,00, а това покритие казваше „неплатени 5,00 €“, и актът по
     чл. 30, т. 5 обявяваше обезщетението за несъбрано. Сега надплатеното е
     кредит и покрива следващото начисление. Същото правило в
     handlers/loans.js (unpaidOverdueFines) и handlers/stats.js. */
  let credit = 0;
  for (const l of lines) {
    if (l.kind === 'начисление') {
      const item = { id: l.id, left: Number(l.amount) || 0 };
      const used = Math.min(credit, item.left);
      item.left -= used; credit -= used;
      queue.push(item);   // и напълно покритото остава — по него се търси `rest` по-долу
      continue;
    }
    let money = Math.abs(Number(l.amount) || 0);
    while (money > 0.0001 && queue.length) {
      const head = queue[0];
      if (head.left <= 0.0001) { queue.shift(); continue; }
      const used = Math.min(money, head.left);
      head.left -= used;
      money -= used;
      if (head.left <= 0.0001) queue.shift();
    }
    if (money > 0.0001) credit += money;
  }
  const charged = toCents(Math.abs(Number(line.amount) || 0));
  const rest = queue.find(q => q.id === line.id);
  const outstanding = toCents(rest ? rest.left : 0);
  return { charged, covered: toCents(charged - outstanding), outstanding };
}

module.exports = function registerAccountHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  ipcMain.handle('account:get', /** @param {unknown} e @param {IpcArg<'account:get'>} readerId */ (e, readerId) =>
    run(() => {
      const lines = getDb().prepare('SELECT * FROM account_lines WHERE reader_id = ? ORDER BY date DESC, id DESC').all(readerId);
      const balance = toCents(lines.reduce((s, l) => s + Number(l.amount || 0), 0));
      return { lines, balance };
    })
  );
  ipcMain.handle('account:charge', /** @param {unknown} e @param {IpcArg<'account:charge'>} arg */ (e, { reader_id, type, amount, note, date }) =>
    run(() => {
      const db = getDb();
      assertLineDate(date, 'Нищо не е начислено.');
      /* Math.abs НЕ е излишно: знакът е носителят на смисъла в този дневник
         (плюс = дължи се, минус = платено). Начисление с подадена отрицателна
         сума би влязло като плащане и би намалило дълга — затова сумата се
         привежда към положителна, а нула/нечислово/безкрайност се отказват. */
      const raw = Math.abs(Number(amount) || 0);
      if (!Number.isFinite(raw)) throw new Error('Сумата трябва да е положителна.');
      /* Проверява се ЗАКРЪГЛЕНАТА сума — същото число, което ще влезе в базата.
         Дотогава проверката гледаше суровата, а записът — закръглената, затова
         0.004 лв. минаваше и се записваше ред от 0.00 лв. */
      const amt = toCents(raw);
      if (!amt) throw new Error('Сумата трябва да е положителна (поне 0.01 €).');
      /* ЗАБАВАТА И ОБЕЗЩЕТЕНИЕТО ЗА ИЗГУБЕН ДОКУМЕНТ НЕ СЕ НАЧИСЛЯВАТ НА РЪКА
         (v2.4.69, находка Г2).
         (а) От v2.4.69 забавата има собствен вид („забава“), и точно по него
             „Просрочени“, писмото по чл. 43 и SMS-ът решават колко от нея е
             платено. Ръчен ред „забава“ от „Друго начисление“ не е свързан с
             нито едно заемане: той би се сметнал за забава по просрочените
             документи и би „изял“ заварената забава в loans.fine (виж
             unpaidForRows в handlers/loans.js) — обратният вариант на
             дефекта, който видът поправя.
         (б) Двата вида се пишат от програмата — забавата при връщане,
             продължение и „изгубен“ (chargeOverdueFine), обезщетението за
             изгубен документ — от „Изгубена“ (chargeLost), където редът се
             свързва с документа и после с акта по чл. 30, т. 5.
         (в) Отказът казва откъде се прави всяко от двете. Ръчното
             „обезщетение“ (повредена корица, изгубен картон) си остава. */
      if (type === LATE_FEE_CHARGE_TYPE || type === LOST_CHARGE_TYPE) {
        throw new Error(type === LATE_FEE_CHARGE_TYPE
          ? 'Забавата се начислява от програмата — при връщане, продължение или „Изгубена“ на просрочения документ, '
            + 'за да е свързана със заемането и да се приспада вярно в писмото по чл. 43. За повреда или друго '
            + 'обезщетение изберете вид „обезщетение“. Нищо не е начислено.'
          : 'Обезщетението за изгубен документ се начислява от бутона „Изгубена“ до заемането — така редът '
            + 'се свързва с документа и с акта по чл. 30, т. 5. Нищо не е начислено.');
      }
      const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reader_id, date || today(), 'начисление', type || 'друго', amt, note || null);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Начисление', (r ? r.name : reader_id) + ' — ' + (type || 'друго') + ' ' + amt.toFixed(2) + ' €');
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('account:pay', /** @param {unknown} e @param {IpcArg<'account:pay'>} arg */ (e, { reader_id, amount, note, date }) =>
    run(() => {
      const db = getDb();
      assertLineDate(date, 'Плащането не е записано.');
      const raw = Math.abs(Number(amount) || 0); // виж account:charge за знака
      if (!Number.isFinite(raw)) throw new Error('Сумата трябва да е положителна.');
      /* Одит v2.4.24: проверката гледаше СУРОВАТА сума, а записът — закръглената
         (същата разлика, поправена при account:charge по-горе, но само там). 0.004
         лв. минаваше, влизаше ред от 0.00 лв. и веднага се отпечатваше квитанция
         „Платена сума: 0.00 лв.“ за подпис от читателя. */
      const amt = toCents(raw);
      if (!amt) throw new Error('Сумата трябва да е положителна (поне 0.01 €).');
      const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reader_id, date || today(), 'плащане', 'плащане', -amt, note || null);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Плащане', (r ? r.name : reader_id) + ' — ' + amt.toFixed(2) + ' €');
      return info.lastInsertRowid;
    })
  );
  /* Изтриването на ред от сметката е ЕДИНСТВЕНИЯТ път, по който касов запис
     изчезва — и дотук единственият в този модул, който не оставяше следа, докато
     начислението и плащането оставят. Одит v2.4.24: сгрешен клик по „✕“ в картона
     махаше плащане от МИНАЛА, вече подадена година и справката „Приходи от такси и
     обезщетения“ започваше да показва друго число, без нищо, по което разликата да
     се възстанови (точно рискът, заради който handlers/readers.js спира изтриването
     на читател с движения по сметката). Липсващият ред пък се връщаше с ok:true и
     прозорецът обявяваше „Изтрито.“ за нищо. */
  /* Каналът приема и `{ id, reason }` (v2.4.71, Ч12); голото число остава
     за заварените извиквания. */
  ipcMain.handle('account:deleteLine', /** @param {unknown} e @param {IpcArg<'account:deleteLine'>} arg */ (e, arg) =>
    run(() => {
      const db = getDb();
      const id = arg && typeof arg === 'object' ? arg.id : arg;
      const reason = arg && typeof arg === 'object' ? String(arg.reason || '').trim() : '';
      const l = db.prepare('SELECT id, reader_id, date, kind, type, amount, note FROM account_lines WHERE id = ?').get(id);
      if (!l) throw new Error('Записът вече не съществува — вероятно е изтрит от друго работно място.');
      /* ПЛАЩАНЕ С ИЗДАДЕНА КВИТАНЦИЯ СЕ АНУЛИРА С ПРИЧИНА (v2.4.71, находка Ч12).
         (а) КАКВО СТАВАШЕ ДОТУК. „✕“ на ред „плащане“ питаше само „Изтриване на
             записа от сметката?“ и го махаше; в следата оставаше „Иван Петров —
             2026-10-29, плащане 1.25 €“ — без дума защо. А всяко плащане на
             гишето веднага отпечатва квитанция (savePayment в
             src/views/account.js) и тя е у читателя, с номера на този ред.
         (б) ЗАЩО Е ГРЕШНО. Квитанцията е касов документ: читателят държи
             подписан лист, че е платил 1,25 €, а сметката вече казва, че не е.
             При проверка на касата единственото, което обяснява разликата, е
             причината за анулирането — а тя не се пазеше никъде.
         (в) ЗАЩО ТОЧНО ТАКА. Причината е ЗАДЪЛЖИТЕЛНА за ред „плащане“ и влиза
             в следата заедно с номера на анулираната квитанция. Сторниращ ред
             („плащане“ с обратен знак) нарочно НЕ се пише: справките в
             handlers/stats.js и handlers/loans.js четат плащанията по абсолютна
             стойност и такъв ред би се преброил за второ плащане — тоест
             годишният отчет би показал пари, които никой не е дал. Анулирането
             е изтриване на реда + следа с причината и номера на квитанцията;
             екранът казва на библиотекарката да поиска квитанцията обратно. */
      const isPayment = l.kind === 'плащане';
      if (isPayment && !reason) {
        throw new Error('Плащането има издадена квитанция № ' + l.id + ' — анулирането ѝ изисква причина '
          + '(напр. „сгрешена сума, вписана наново“). Впишете причината и повторете. Нищо не е изтрито.');
      }
      /* ОПРОСТЕНАТА ЗАБАВА НЕ СЕ ВРЪЩА В ПИСМОТО (v2.4.71, находка Ч2).
         (а) КАКВО СТАВАШЕ ДОТУК. „✕“ на ред „забава“ махаше само реда от сметката,
             а сумата по заемането (loans.fine) оставаше. „Просрочени“, писмото по
             чл. 43 и SMS-ът смятат заварената забава като разлика между loans.fine
             и начисленото в сметката (overdueForRows в handlers/loans.js) — и
             изтритите 0,20 € изскачаха като „заварени“. Възпроизведено (тестер,
             den45): опростена забава 0,20 € при продължение, сметката е 0, нова
             забава 0,40 € — писмото иска 0,60 €. Същата сума влизаше и в
             журнала при връщане, и в „Начислени обезщетения“ на годишния отчет
             (handlers/stats.js сумира loans.fine на върнатите заемания).
         (б) ЗАЩО Е ГРЕШНО. Писмото по чл. 43 е подписан документ с искане за
             пари — не може да иска сума, която библиотеката сама е опростила.
         (в) ЗАЩО ТОЧНО ТАКА. Опрощаването е едно решение и се отразява на ДВЕТЕ
             места, които пазят забавата: редът изчезва от сметката И сумата по
             заемането намалява със същото, в една транзакция. Така всички
             потребители на loans.fine (Просрочени, писмото, SMS-ът, журналът,
             годишният отчет) виждат вярното число, без никой от тях да се
             променя. Редът не носи номер на заемане, затова заемането се търси:
             първо по точната връзка от акта по чл. 30, т. 5
             (deaccession_fine_line_id), после по инвентарния номер от бележката
             („… по инв. № N — …“), читателя, датите и достатъчната сума. Ако не се
             намери — редът пак се изтрива, но това се КАЗВА (на екрана и в
             следата), за да не остане тихо разминаване. */
      // Типът е на стойността, не на декларацията: присвояването е в транзакцията
      // (стрелка) и tsc иначе смята loanFix за вечно null след нея.
      let loanFix = /** @type {{ loan_id: number, inv_number: any, title: string, before: number, after: number } | null} */ (null);
      let loanMiss = false;
      const tx = db.transaction(() => {
        if (l.kind === 'начисление' && l.type === LATE_FEE_CHARGE_TYPE) {
          const amt = toCents(Math.abs(Number(l.amount) || 0));
          const loanCols = db.prepare('PRAGMA table_info(loans)').all().map(c => c.name);
          let loan = null;
          if (loanCols.includes('deaccession_fine_line_id')) {
            loan = db.prepare(`SELECT l.id, l.fine, l.deaccession_fine, b.inv_number, b.title FROM loans l
              JOIN books b ON b.id = l.book_id WHERE l.deaccession_fine_line_id = ?`).get(l.id) || null;
            if (loan) {
              db.prepare('UPDATE loans SET deaccession_fine_line_id = NULL, deaccession_fine = ? WHERE id = ?')
                .run(toCents(Math.max(0, (Number(loan.deaccession_fine) || 0) - amt)), loan.id);
            }
          }
          const m = !loan && /инв\. № ([^\s;—]+)/.exec(String(l.note || ''));
          if (m && m[1] !== '—') {
            loan = db.prepare(`SELECT l.id, l.fine, b.inv_number, b.title FROM loans l JOIN books b ON b.id = l.book_id
              WHERE l.reader_id = ? AND CAST(b.inv_number AS TEXT) = ?
                AND COALESCE(l.fine, 0) >= ? - 0.005
                AND l.date_out <= ? AND (l.date_in IS NULL OR l.date_in >= ?)
              ORDER BY (CASE WHEN l.date_in = ? THEN 0 WHEN l.date_in IS NULL THEN 1 ELSE 2 END), l.id DESC
              LIMIT 1`).get(l.reader_id, m[1], amt, l.date, l.date, l.date) || null;
          }
          if (loan) {
            const before = toCents(Number(loan.fine) || 0);
            const after = toCents(Math.max(0, before - amt));
            db.prepare('UPDATE loans SET fine = ? WHERE id = ?').run(after, loan.id);
            loanFix = { loan_id: loan.id, inv_number: loan.inv_number, title: loan.title, before, after };
          } else {
            loanMiss = true;
          }
        }
        db.prepare('DELETE FROM account_lines WHERE id = ?').run(id);
      });
      tx.immediate();
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(l.reader_id);
      /* Действието остава „Изтрит ред от сметката“ и за плащането: по това име
         заличаването по чл. 17 (handlers/gdpr.js, MONEY_ACTIONS) обезличава
         името в следата — ново име на действието би оставило името на читателя
         там завинаги. Анулирането се познава по „анулирана квитанция № …“. */
      logAudit('Изтрит ред от сметката', (r ? r.name : 'читател № ' + l.reader_id)
        + ' — ' + l.date + ', ' + (l.type || l.kind) + ' ' + Math.abs(Number(l.amount) || 0).toFixed(2) + ' €'
        + (l.note ? ' (' + l.note + ')' : '')
        + (isPayment ? '; анулирана квитанция № ' + l.id : '')
        + (reason ? '; причина: ' + reason : '')
        + (loanFix ? '; забавата по заемането на инв. № ' + (loanFix.inv_number ?? '—') + ' е намалена от '
          + loanFix.before.toFixed(2) + ' € на ' + loanFix.after.toFixed(2) + ' €' : '')
        + (loanMiss ? '; ВНИМАНИЕ: заемането, по което е начислена тази забава, не е намерено — сумата по него не е пипната' : ''));
      return {
        receipt: isPayment ? l.id : null,
        loan: loanFix,
        warning: loanMiss
          ? 'Редът е изтрит, но заемането, по което е начислена забавата, не беше намерено (бележката не сочи инвентарен номер '
            + 'или заемането е изтрито) — сумата по заемането не е намалена. Ако писмото по чл. 43 продължава да иска тази сума, '
            + 'съобщете на поддръжката.'
          : null
      };
    })
  );
};

/* Закачени за самата експортирана функция, а не подадени през deps: main.js
   регистрира handlers/account.js по-рано от handlers/loans.js и НЕ пази
   върнатото, тоест няма къде да ги прекара. `require('./account')` от заеманията
   не регистрира нищо повторно — модулът вече е в кеша на Node и се взима
   готов. */
module.exports.LOST_CHARGE_TYPE = LOST_CHARGE_TYPE;
module.exports.LATE_FEE_CHARGE_TYPE = LATE_FEE_CHARGE_TYPE;
module.exports.chargeLost = chargeLost;
module.exports.chargeOverdueFine = chargeOverdueFine;
module.exports.chargeCoverage = chargeCoverage;
