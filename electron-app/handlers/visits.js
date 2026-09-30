// Посещения — извадени от main.js в отделен модул (Фаза 4, стъпка 28).
// Единствен handler. Зависи от getDb, run, logAudit.
const { isValidIsoDate } = require('../security-utils');

const bgDate = (d) => String(d).slice(8, 10) + '.' + String(d).slice(5, 7) + '.' + String(d).slice(0, 4);

module.exports = function registerVisitsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;
  /* „Днес“ (v2.4.71, Д5): main.js не подава `today` на този модул; дотогава —
     местната дата от local-date.js, от която идва и неговият today(). */
  const today = typeof deps.today === 'function' ? deps.today : () => require('../local-date').localDate();

  /* Одит v2.4.25. Дотук: (1) празна дата минаваше — visits.date е NOT NULL UNIQUE,
     но '' го удовлетворява — и всяко вписване с изчистена дата се НАТРУПВАШЕ в един
     фантомен ред, който никоя справка не чете (substr('',1,4) не е година), с
     „Посещенията са вписани.“; (2) редът се събира (count + excluded.count), а
     екранът не казваше нито че добавя, нито колко е станало — сгрешено 50 вместо 5
     се поправяше само с −45; (3) отрицателни числа минаваха. Сега: датата е
     задължителна и валидна, броят е положително цяло число, `replace` задава
     стойността вместо да добавя (за поправка), а отговорът носи новото общо за деня,
     за да го види библиотекарят веднага. */
  ipcMain.handle('visits:add', /** @param {unknown} e @param {IpcArg<'visits:add'>} arg */ (e, { date, count, replace }) =>
    run(() => {
      if (!isValidIsoDate(date)) throw new Error('Датата на посещенията липсва или е невалидна.');
      /* БЪДЕЩ ДЕН — ОТКАЗ (v2.4.71, находка Д5 от кръг 45).
         (а) ДОТУК „Впиши посещения“ приемаше 30 посещения за 15.12.2026 (тестер,
         a3b-badeshte.js) и „Статистика 2026“ веднага ги броеше в показателя по
         БДС ISO 2789. (б) Посещение, което още не е станало, е измислено число в
         годишния отчет. (в) Същият отказ като в Дневника и при броевете
         периодика: вписват се днешният и минали дни. */
      if (String(date) > today()) {
        throw new Error('Денят ' + bgDate(date) + ' още не е настъпил — посещения се вписват за днес ('
          + bgDate(today()) + ') или за минал ден. Нищо не е записано; проверете датата.');
      }
      // v2.4.29: parseInt('2.5') = 2 и parseInt('3abc') = 3 минаваха проверката мълчаливо.
      const n = /^\s*\d+\s*$/.test(String(count ?? '')) ? parseInt(count, 10) : NaN;
      if (!Number.isInteger(n) || n < 0 || String(count).trim() === '') {
        throw new Error('Броят посещения трябва да е цяло число, 0 или повече.');
      }
      if (!replace && n === 0) throw new Error('Няма какво да се добави — броят е 0.');
      const db = getDb();
      const before = db.prepare('SELECT count FROM visits WHERE date = ?').get(date);
      if (replace) {
        db.prepare('INSERT INTO visits (date, count) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET count = excluded.count').run(date, n);
      } else {
        db.prepare('INSERT INTO visits (date, count) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET count = count + excluded.count').run(date, n);
      }
      const total = db.prepare('SELECT count FROM visits WHERE date = ?').get(date).count;
      /* ДВАТА ДНЕВНИКА ЗА ПОСЕЩЕНИЯ СЕ ВИЖДАТ ЕДИН ДРУГ (одит v2.4.65, находка Б18).
         =====================================================================
         Посещенията се водят на ДВЕ несвързани места и двете влизат в
         отчетността: тази таблица („Статистика → Впиши посещения“, показателят
         по БДС ISO 2789) и Раздел А на Дневника (`dnevnik_days.a_visit_*` —
         официалният формуляр, от който се смята годишният отчет). Вписаното в
         едното не стига до другото. Измерено за една година: 40 тук срещу 52 в
         Дневника, и нищо не ги сравняваше.
         ДВЕТЕ НЕ СЕ СЛИВАТ — автоматичното попълване на Дневника от посещенията
         и заеманията е отложено решение. Тук само се ВРЪЩА какво пише в Дневника
         за СЪЩИЯ ден, за да го види библиотекарката още на гишето, вместо да
         открие разминаването в края на годината. Сравняването за цялата година
         стои на екрана „Статистика“ (handlers/stats.js → visitsCheck), по образец
         на съгласуването на фонда в handlers/fund-check.js.
         „Деца до 14 г.“ е ПОДМНОЖЕСТВО на „в заемна за дома“ по формуляра и
         затова не се събира отделно — иначе едно дете би се броило два пъти. */
      const dn = db.prepare(`SELECT COALESCE(a_visit_home,0) AS home, COALESCE(a_visit_child,0) AS child,
        COALESCE(a_visit_reading,0) AS reading, COALESCE(a_visit_internet,0) AS internet
        FROM dnevnik_days WHERE date = ?`).get(date);
      const dnevnik = dn
        ? { home: dn.home, child: dn.child, reading: dn.reading, internet: dn.internet,
            total: dn.home + dn.reading + dn.internet, recorded: true }
        : { home: 0, child: 0, reading: 0, internet: 0, total: 0, recorded: false };
      const pos = (n === 1 ? '1 посещение' : n + ' посещения');
      logAudit('Посещения', date + ': ' + (replace ? (n === 1 ? 'вписано ' : 'вписани ') : (n === 1 ? 'добавено ' : 'добавени ')) + pos
        + (before ? ' (преди: ' + before.count + ')' : '') + ' — общо за деня ' + total);
      return { added: replace ? null : n, total, before: before ? before.count : 0, dnevnik };
    })
  );
  ipcMain.handle('visits:get', /** @param {unknown} e @param {IpcArg<'visits:get'>} date */ (e, date) =>
    run(() => {
      const r = getDb().prepare('SELECT count FROM visits WHERE date = ?').get(date);
      return r ? r.count : 0;
    })
  );
};
