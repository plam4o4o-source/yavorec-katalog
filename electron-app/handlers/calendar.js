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
module.exports = function registerCalendarHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  function workDaysSet() {
    const s = getDb().prepare('SELECT work_days FROM settings WHERE id = 1').get() || {};
    const raw = s.work_days == null ? '0,1,2,3,4,5,6' : s.work_days;
    const set = new Set(String(raw).split(',').map(x => parseInt(x, 10)).filter(n => !isNaN(n)));
    return set.size ? set : new Set([0, 1, 2, 3, 4, 5, 6]); // празна/повредена настройка — не блокирай всичко
  }
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
    wdSet = wdSet || workDaysSet();
    if (!wdSet.has(new Date(dateStr + 'T00:00:00Z').getUTCDay())) return false;
    return !getDb().prepare('SELECT 1 FROM calendar_closed WHERE date = ?').get(dateStr);
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
    const wdSet = workDaysSet();
    const closed = new Set(getDb().prepare('SELECT date FROM calendar_closed WHERE date > ? AND date <= ?').all(a, b).map(r => r.date));
    let n = 0;
    const d = new Date(a + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    const end = new Date(b + 'T00:00:00Z');
    for (let i = 0; d <= end && i < 5000; i++) {
      const ds = d.toISOString().slice(0, 10);
      if (!wdSet.has(d.getUTCDay()) || closed.has(ds)) n++;
      d.setUTCDate(d.getUTCDate() + 1);
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
      const list = (Array.isArray(days) ? days : []).map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 6);
      getDb().prepare('UPDATE settings SET work_days = ? WHERE id = 1').run(list.join(','));
      logAudit('Календар', 'работни дни: ' + (list.length ? list.join(',') : '—'));
    })
  );
  ipcMain.handle('calendar:addClosed', (e, { date, reason }) =>
    run(() => {
      if (!date) throw new Error('Изберете дата.');
      getDb().prepare('INSERT OR REPLACE INTO calendar_closed (date, reason) VALUES (?, ?)').run(date, reason || null);
      logAudit('Календар', 'затворен ден: ' + date + (reason ? ' — ' + reason : ''));
    })
  );
  ipcMain.handle('calendar:removeClosed', (e, date) =>
    run(() => { getDb().prepare('DELETE FROM calendar_closed WHERE date = ?').run(date); })
  );

  return { workDaysSet, isWorkDay, nextWorkDay, closedDaysBetween };
};
