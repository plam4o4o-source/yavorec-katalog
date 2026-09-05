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
    const D = Math.round((endD - start) / 864e5) + 1; // брой дни в интервала
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

  ipcMain.handle('calendar:get', () =>
    run(() => {
      const closed = getDb().prepare('SELECT date, reason FROM calendar_closed WHERE date >= date(\'now\',\'-30 days\') ORDER BY date').all();
      return { workDays: [...workDaysSet()], closed };
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
      getDb().prepare('UPDATE settings SET work_days = ? WHERE id = 1').run(list.join(','));
      invalidateCalendarCache();
      logAudit('Календар', 'работни дни: ' + list.join(','));
    })
  );
  ipcMain.handle('calendar:addClosed', (e, { date, reason }) =>
    run(() => {
      invalidateCalendarCache();
      if (!date) throw new Error('Изберете дата.');
      // v2.4.29: „2026-5-1“ или „2026-02-30“ влизаха в списъка, но никога не съвпадаха с работен ден.
      if (!isValidIsoDate(date)) throw new Error('Датата (' + date + ') е невалидна — очаква се ГГГГ-ММ-ДД.');
      getDb().prepare('INSERT OR REPLACE INTO calendar_closed (date, reason) VALUES (?, ?)').run(date, reason || null);
      invalidateCalendarCache();
      logAudit('Календар', 'затворен ден: ' + date + (reason ? ' — ' + reason : ''));
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
