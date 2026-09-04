// Посещения — извадени от main.js в отделен модул (Фаза 4, стъпка 28).
// Единствен handler. Зависи от getDb, run, logAudit.
const { isValidIsoDate } = require('../security-utils');

module.exports = function registerVisitsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  /* Одит v2.4.25. Дотук: (1) празна дата минаваше — visits.date е NOT NULL UNIQUE,
     но '' го удовлетворява — и всяко вписване с изчистена дата се НАТРУПВАШЕ в един
     фантомен ред, който никоя справка не чете (substr('',1,4) не е година), с
     „Посещенията са вписани.“; (2) редът се събира (count + excluded.count), а
     екранът не казваше нито че добавя, нито колко е станало — сгрешено 50 вместо 5
     се поправяше само с −45; (3) отрицателни числа минаваха. Сега: датата е
     задължителна и валидна, броят е положително цяло число, `replace` задава
     стойността вместо да добавя (за поправка), а отговорът носи новото общо за деня,
     за да го види библиотекарят веднага. */
  ipcMain.handle('visits:add', (e, { date, count, replace }) =>
    run(() => {
      if (!isValidIsoDate(date)) throw new Error('Датата на посещенията липсва или е невалидна.');
      const n = parseInt(count, 10);
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
      const pos = (n === 1 ? '1 посещение' : n + ' посещения');
      logAudit('Посещения', date + ': ' + (replace ? (n === 1 ? 'вписано ' : 'вписани ') : (n === 1 ? 'добавено ' : 'добавени ')) + pos
        + (before ? ' (преди: ' + before.count + ')' : '') + ' — общо за деня ' + total);
      return { added: replace ? null : n, total, before: before ? before.count : 0 };
    })
  );
  ipcMain.handle('visits:get', (e, date) =>
    run(() => {
      const r = getDb().prepare('SELECT count FROM visits WHERE date = ?').get(date);
      return r ? r.count : 0;
    })
  );
};
