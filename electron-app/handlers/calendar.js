// Календар на библиотеката — извадени от main.js в отделен модул (Фаза 4,
// стъпка 4 от разбиването на монолита на модули по домейн).
//
// work_days (в settings) е CSV от номера на дни от седмицата, в които
// библиотеката работи (0=неделя…6=събота); calendar_closed добавя конкретни
// затворени дати (официални празници, отпуск).
//
// За разлика от backup.js/shelves.js, този модул трябва да ВЪРНЕ функции
// обратно към main.js — workDaysSet/isWorkDay/nextWorkDay/closedDaysBetween
// се ползват и от домейна "Заемания" (все още неизваден оттам): падеж, паднал
// се в затворен ден, се измества към следващия работен ден; наказанието в
// дни не брои затворените дни като забава. Затова, за разлика от
// autoBackupIfNeeded (връщано само за app.whenReady()), тук връщаните
// функции остават в активна употреба от друг, все още неизваден домейн.
const { isValidIsoDate } = require('../security-utils');

const { localDate } = require('../local-date');

module.exports = function registerCalendarHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  /* Кеш (v2.4.31, производителност): closedDaysBetween() се вика по веднъж за ВСЯКО
     просрочено заемане в „Просрочени“, „Напомняния“, таблото и при всяко връщане —
     и всеки път четеше настройките и затворените дни наново (2 заявки на ред;
     измерено 40–56 ms за 250 просрочени). Двете таблици са мънички и се променят
     само от този модул, затова се четат веднъж и се пазят до първата промяна
     (invalidateCalendarCache) или до изтичане на кратък срок — заради второ
     работно място към същата мрежова база. */
  const CAL_TTL_MS = 3000;
  let calCache = null; // { at, wd:Set<number>, closed:Set<string>, db }
  function invalidateCalendarCache() { calCache = null; }
  function calendarSnapshot() {
    const db = getDb();
    if (calCache && calCache.db === db && Date.now() - calCache.at < CAL_TTL_MS) return calCache;
    const s = db.prepare('SELECT work_days FROM settings WHERE id = 1').get() || {};
    const raw = s.work_days == null ? '0,1,2,3,4,5,6' : s.work_days;
    const set = new Set(String(raw).split(',').map(x => parseInt(x, 10)).filter(n => !isNaN(n)));
    const wd = set.size ? set : new Set([0, 1, 2, 3, 4, 5, 6]); // празна/повредена настройка — не блокирай всичко
    const closed = new Set(db.prepare('SELECT date FROM calendar_closed').all().map(r => r.date));
    calCache = { at: Date.now(), wd, closed, db };
    return calCache;
  }
  function workDaysSet() { return new Set(calendarSnapshot().wd); }
  /* Датите в базата са голи низове „ГГГГ-ММ-ДД" без часова зона. Смятат се изцяло в
     UTC — „T00:00:00Z" при четене, getUTCDay/setUTCDate при обхождане и toISOString()
     при записване. Смесването на двете скàли беше истински дефект: „…T00:00:00" без
     Z се тълкува като МЕСТНА полунощ, а toISOString() после връща UTC — при UTC+2/+3
     (България) това дава ден ПО-РАНО и проверява грешния ден от седмицата, тоест
     всеки падеж излизаше с ден по-рано, а падеж в събота се местеше назад в петък
     вместо напред в понеделник. Тестовете не го хващаха, защото се изпълняваха под
     TZ=UTC, където двете скàли съвпадат — затова test/handlers-calendar.test.js вече
     проверява изрично и под Europe/Sofia. */
  function isWorkDay(dateStr, wdSet) {
    const snap = calendarSnapshot();
    wdSet = wdSet || snap.wd;
    if (!wdSet.has(new Date(dateStr + 'T00:00:00Z').getUTCDay())) return false;
    return !snap.closed.has(dateStr);
  }
  // Измества дата напред до първия работен ден (включително самата нея, ако вече е работен ден).
  function nextWorkDay(dateStr) {
    const wdSet = workDaysSet();
    const d = new Date(dateStr + 'T00:00:00Z');
    for (let i = 0; i < 400; i++) {
      const ds = d.toISOString().slice(0, 10);
      if (isWorkDay(ds, wdSet)) return ds;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return dateStr; // предпазна мярка — практически недостижимо
  }
  // Брой затворени дни в интервала (a, b] — денят на падежа не се брои, денят на връщане
  // се брои, за да съответства на изчислението "дни забава" на повикващия код.
  function closedDaysBetween(a, b) {
    if (!a || !b || a >= b) return 0;
    const snap = calendarSnapshot();
    const wdSet = snap.wd, closed = snap.closed;
    /* v2.4.31 (производителност): дотук се обхождаше ден по ден с Date/toISOString
       — за 250 просрочени по 150 дни това бяха 33 ms при всяко отваряне на
       „Просрочени“. Неработните дни от седмицата се броят аритметично, а
       затворените дати (малък списък) се броят само ако падат на работен ден
       от седмицата — за да не се броят два пъти. Резултатът е същият. */
    const start = new Date(a + 'T00:00:00Z'); start.setUTCDate(start.getUTCDate() + 1); // (a, b]
    const endD = new Date(b + 'T00:00:00Z');
    const D = Math.round((endD.getTime() - start.getTime()) / 864e5) + 1; // брой дни в интервала
    if (!(D > 0)) return 0; // и при невалидна дата (NaN)
    let n = 0;
    const dow0 = start.getUTCDay();
    for (let w = 0; w < 7; w++) {
      if (wdSet.has(w)) continue;
      const first = (w - dow0 + 7) % 7;
      if (first < D) n += 1 + Math.floor((D - 1 - first) / 7);
    }
    for (const ds of closed) {
      if (ds > a && ds <= b && wdSet.has(new Date(ds + 'T00:00:00Z').getUTCDay())) n++;
    }
    return n;
  }

  /* ПАДЕЖИТЕ НА ОТВОРЕНИТЕ ЗАЕМАНИЯ СЛЕД ПРОМЯНА В КАЛЕНДАРА (v2.4.71, находка Ч4).
     =====================================================================
     (а) КАКВО СТАВАШЕ ДОТУК. Падежът се мести на работен ден само в момента на
         заемането (nextWorkDay). Затворен ден, обявен ПО-КЪСНО (или сменени
         работни дни), оставяше падежа в ден, в който библиотеката е затворена.
         Възпроизведено (тестер, den45): 13.10 обявен за затворен, падежът на осем
         заемания е 13.10; на 14.10 — първия отворен ден — всичките са в
         „Просрочени“, на таблото и в писмата по чл. 43, а връщането носи
         „Забава 1 ден · 0,10 €“.
     (б) ЗАЩО Е ГРЕШНО. Читателят няма как да върне документ в затворен ден;
         срокът му реално е първият отворен ден. Писмо по чл. 43 за документ,
         чийто срок още не е изтекъл, е искане без основание.
     (в) ЗАЩО ТОЧНО ТАКА. Падежът на всяко ОТВОРЕНО заемане, паднал в вече
         неработен ден, се мести на първия работен ден след него — същото правило
         като при самото заемане. Така и броячите, които питат направо базата
         (таблото, „Читатели“, отчетът), виждат верния срок, без всеки да го
         смята наново. Премества се само напред (в полза на читателя) и никога
         назад: премахнат затворен ден не скъсява обещан срок. Смяната НЕ е
         тиха — броят и новите дати влизат в одитната следа и в отговора към
         екрана. Самата забава и без това се смята от първия работен ден
         (effectiveDaysLate в handlers/loans.js) — това пази и заварените
         заемания отпреди тази версия. */
  function shiftOpenDues(onlyDate) {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(loans)').all().map(c => c.name);
    if (!cols.includes('date_due')) return [];
    /* Само заемания, чийто ИСТИНСКИ срок (първият работен ден) още не е минал
       (преглед на кръга, v2.4.71). Падеж 13.10, обявен за затворен на 14.10, се
       мести (срокът става 14.10 — днес). Но отдавна изтекъл падеж вече стои в
       писмата по чл. 43, които читателят е получил; смяна на работните дни днес
       не бива да пренаписва „срок“ в следващото писмо — а забавата по него и без
       това не брои затворените дни (closedDaysBetween). */
    const today = localDate();
    const rows = onlyDate
      ? db.prepare('SELECT id, date_due FROM loans WHERE date_in IS NULL AND date_due = ?').all(onlyDate)
      : db.prepare('SELECT id, date_due FROM loans WHERE date_in IS NULL AND date_due IS NOT NULL').all();
    const upd = db.prepare('UPDATE loans SET date_due = ? WHERE id = ? AND date_in IS NULL AND date_due = ?');
    const moved = [];
    for (const r of rows) {
      if (isWorkDay(r.date_due)) continue;
      const to = nextWorkDay(r.date_due);
      if (!to || to <= r.date_due || to < today) continue;
      if (upd.run(to, r.id, r.date_due).changes) moved.push({ id: r.id, from: r.date_due, to });
    }
    return moved;
  }
  const bgD = (d) => String(d || '').split('-').reverse().join('.');
  function movedText(moved) {
    if (!moved.length) return '';
    const byFrom = new Map();
    for (const m of moved) {
      const k = m.from + '→' + m.to;
      byFrom.set(k, (byFrom.get(k) || 0) + 1);
    }
    return 'падежът на ' + moved.length + (moved.length === 1 ? ' отворено заемане е преместен' : ' отворени заемания е преместен')
      + ' на първия работен ден (' + [...byFrom].map(([k, n]) => {
        const [a, b] = k.split('→');
        return bgD(a) + ' → ' + bgD(b) + (byFrom.size > 1 ? ' (' + n + ')' : '');
      }).join('; ') + ')';
  }

  /* ЗАТВОРЕНИТЕ ДНИ, КОИТО ОЩЕ ВЛИЗАТ В СМЕТКИТЕ (v2.4.71, находка Ч15).
     (а) Дотук списъкът показваше само затворените дни от последните 30 дни
         насам — а затворен ден отпреди два месеца продължава да се изважда от
         забавата на всяко още невърнато заемане (closedDaysBetween). Такъв ден
         не можеше нито да се види, нито да се махне от екрана.
     (б) Невидимо правило, което сменя сумата в писмо по чл. 43, не може да се
         провери от библиотекарката.
     (в) Връщат се всички затворени дни от началото на ТЕКУЩАТА година, а ако
         има невърнато заемане с по-стар падеж — от неговия падеж насам: точно
         онези, които още могат да влязат в някоя забава. `from` казва от коя
         дата е списъкът, за да го напише екранът. */
  ipcMain.handle('calendar:get', () =>
    run(() => {
      const db = getDb();
      const yearStart = new Date().getFullYear() + '-01-01';
      let from = yearStart;
      const cols = db.prepare('PRAGMA table_info(loans)').all().map(c => c.name);
      if (cols.includes('date_due')) {
        const o = db.prepare('SELECT MIN(date_due) AS d FROM loans WHERE date_in IS NULL AND date_due IS NOT NULL').get();
        if (o && o.d && o.d < from) from = o.d;
      }
      const closed = db.prepare('SELECT date, reason FROM calendar_closed WHERE date >= ? ORDER BY date').all(from);
      return { workDays: [...workDaysSet()], closed, from };
    })
  );
  ipcMain.handle('calendar:saveWorkDays', (e, days) =>
    run(() => {
      invalidateCalendarCache();
      const list = (Array.isArray(days) ? days : []).map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 6);
      /* Празен списък се ОТКАЗВА (одит v2.4.25). Дотук се записваше '' и workDaysSet()
         падаше към „всички дни са работни“ (нарочно — „не блокирай всичко“), тоест
         след като библиотекарят потвърди предупреждението „библиотеката ще излиза
         затворена всеки ден“, програмата правеше точно обратното: срокове и
         наказания брояха всеки ден, а екранът показваше седемте квадратчета пак
         отметнати. Проверката е по СЪЩИЯ списък, който ще се запише. */
      if (!list.length) throw new Error('Отбележете поне един работен ден — без работни дни срокове и наказания не могат да се смятат.');
      const db = getDb();
      const moved = db.transaction(() => {
        db.prepare('UPDATE settings SET work_days = ? WHERE id = 1').run(list.join(','));
        invalidateCalendarCache();
        return shiftOpenDues(null);   // падежи в новите почивни дни — виж shiftOpenDues (Ч4)
      }).immediate();
      logAudit('Календар', 'работни дни: ' + list.join(',') + (moved.length ? '; ' + movedText(moved) : ''));
      return { moved: moved.length, message: moved.length ? movedText(moved) : null };
    })
  );
  ipcMain.handle('calendar:addClosed', (e, { date, reason }) =>
    run(() => {
      invalidateCalendarCache();
      if (!date) throw new Error('Изберете дата.');
      // v2.4.29: „2026-5-1“ или „2026-02-30“ влизаха в списъка, но никога не съвпадаха с работен ден.
      if (!isValidIsoDate(date)) throw new Error('Датата (' + date + ') е невалидна — очаква се ГГГГ-ММ-ДД.');
      const db = getDb();
      const moved = db.transaction(() => {
        db.prepare('INSERT OR REPLACE INTO calendar_closed (date, reason) VALUES (?, ?)').run(date, reason || null);
        invalidateCalendarCache();
        return shiftOpenDues(date);   // падежите в този ден — виж shiftOpenDues (Ч4)
      }).immediate();
      logAudit('Календар', 'затворен ден: ' + date + (reason ? ' — ' + reason : '')
        + (moved.length ? '; ' + movedText(moved) : ''));
      return { moved: moved.length, message: moved.length ? movedText(moved) : null };
    })
  );
  ipcMain.handle('calendar:removeClosed', (e, date) =>
    run(() => {
      invalidateCalendarCache();
      const info = getDb().prepare('DELETE FROM calendar_closed WHERE date = ?').run(date);
      invalidateCalendarCache();
      if (!info.changes) throw new Error('Няма затворен ден на ' + date + '.');
      logAudit('Календар', 'премахнат затворен ден ' + date);
    })
  );

  return { workDaysSet, isWorkDay, nextWorkDay, closedDaysBetween, invalidateCalendarCache };
};

/* ДНИ ЗАБАВА — ЕДНО ПРАВИЛО (преглед на кръга, v2.4.71). Броят се от ПЪРВИЯ
   РАБОТЕН ДЕН след падежа (Ч4), минус затворените дни до връщането. Дотук
   правилото стоеше преписано в handlers/loans.js и в handlers/deaccession-acts.js
   и Ч4 трябваше да се поправи на две места — следващата промяна в едното щеше
   пак да разминe акта по т. 5 с „Просрочени“ и писмото. `cal` подава
   nextWorkDay/closedDaysBetween на календара; без тях (самостоятелен тест) се
   брои от падежа и по календарни дни. */
function lateDays(dueDate, inDate, cal) {
  if (!dueDate || !inDate || inDate <= dueDate) return 0;
  const start = cal && typeof cal.nextWorkDay === 'function' ? (cal.nextWorkDay(dueDate) || dueDate) : dueDate;
  if (inDate <= start) return 0;
  const raw = Math.max(0, Math.round((new Date(inDate).getTime() - new Date(start).getTime()) / 864e5));
  const closed = cal && typeof cal.closedDaysBetween === 'function' ? (Number(cal.closedDaysBetween(start, inDate)) || 0) : 0;
  return Math.max(0, raw - closed);
}
module.exports.lateDays = lateDays;
