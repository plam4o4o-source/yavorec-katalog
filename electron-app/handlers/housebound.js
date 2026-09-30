// Обслужване по домовете (Koha: housebound) — извадени от main.js в отделен
// модул (Фаза 4, стъпка 8 от разбиването на монолита на модули по домейн).
// График и дневник на посещенията при читатели, които не могат да идват
// сами. Всяко посещение влиза в потока от събития (kind='дома') и оттам
// дневникът предлага стойността за колоната a_visit_home („В заемна за
// дома").
//
// `logEvent` се подава по референция (дефинирана е в main.js като function
// declaration, следователно е hoisted — достъпна е още от началото на
// изпълнението на модула, независимо че текстово е разположена по-долу във
// файла, в домейна "Заемания"). `today` също по референция (const, вече
// дефинирана по-рано, не се преприсвоява).
const { isValidIsoDate } = require('../security-utils');

module.exports = function registerHouseboundHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, logEvent, today } = deps;

  ipcMain.handle('housebound:get', /** @param {unknown} e @param {IpcArg<'housebound:get'>} readerId */ (e, readerId) =>
    run(() => {
      const db = getDb();
      const p = db.prepare('SELECT * FROM housebound_profiles WHERE reader_id = ?').get(readerId) || null;
      const visits = db.prepare('SELECT * FROM housebound_visits WHERE reader_id = ? ORDER BY date DESC LIMIT 30').all(readerId);
      return { profile: p, visits };
    })
  );
  ipcMain.handle('housebound:save', /** @param {unknown} e @param {IpcArg<'housebound:save'>} arg */ (e, { reader_id, day, frequency, note }) =>
    run(() => {
      const db = getDb();
      db.prepare(`INSERT INTO housebound_profiles (reader_id, day, frequency, note) VALUES (?, ?, ?, ?)
        ON CONFLICT(reader_id) DO UPDATE SET day=excluded.day, frequency=excluded.frequency, note=excluded.note`)
        .run(reader_id, day || null, frequency || null, note || null);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Обслужване по домовете', 'график за ' + (r ? r.name : reader_id));
    })
  );
  ipcMain.handle('housebound:remove', /** @param {unknown} e @param {IpcArg<'housebound:remove'>} readerId */ (e, readerId) =>
    run(() => {
      const db = getDb();
      const del = db.prepare('DELETE FROM housebound_profiles WHERE reader_id = ?').run(readerId);
      if (!del.changes) throw new Error('Читателят няма график за обслужване по домовете.');
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(readerId);
      logAudit('Обслужване по домовете', 'спрян график за ' + (r ? r.name : readerId));
    })
  );
  ipcMain.handle('housebound:addVisit', /** @param {unknown} e @param {IpcArg<'housebound:addVisit'>} arg */ (e, { reader_id, date, note }) =>
    run(() => {
      const db = getDb();
      const d = date || today();
      /* ДАТАТА НА ПОСЕЩЕНИЕТО СЕ ПРОВЕРЯВА (v2.4.71, находка Д5 от кръг 45).
         (а) ДОТУК тук минаваше всяка стойност — и бъдеща дата (05.01.2031), и
         текст, който не е дата. Посещението пише събитие „дома“, от което
         „⚡ Предложи от регистрите“ смята „В заемна за дома“ в Дневника — тоест
         бъдещото посещение влизаше в Раздел А на ден, който още не е дошъл.
         (б) Дневникът и годишният отчет описват станалото; посещение „напред“
         е измислено число. (в) Отказ — като в Дневника и при „Впиши посещения“:
         вписват се днешният и минали дни. Графикът за бъдещи посещения е в
         профила (ден и честота), не в дневника на посещенията. */
      if (!isValidIsoDate(d)) throw new Error('Датата на посещението („' + d + '“) е невалидна. Нищо не е записано.');
      if (d > today()) {
        throw new Error('Посещението е с дата ' + d.slice(8) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4)
          + ', която още не е настъпила — вписва се след като е станало (днес е '
          + today().slice(8) + '.' + today().slice(5, 7) + '.' + today().slice(0, 4) + '). '
          + 'Графикът за следващите посещения е в профила на читателя. Нищо не е записано.');
      }
      /* В транзакция, защото logEvent вече препредава грешката си (виж main.js).
         Без нея редът в housebound_visits оставаше записан, а съобщението към
         библиотекаря твърдеше „операцията е отменена… Опитайте отново“ — тоест
         всеки повторен опит добавяше ново, дублирано посещение. Посещението и
         събитието, което захранва Дневника, минават заедно или никак — точно
         както при заемане и връщане. */
      const tx = db.transaction(() => {
        const info = db.prepare('INSERT INTO housebound_visits (reader_id, date, note) VALUES (?, ?, ?)')
          .run(reader_id, d, note || null);
        logEvent('дома', { readerId: reader_id, date: d, note });
        const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
        logAudit('Посещение по домовете', (r ? r.name : reader_id) + ' — ' + d);
        return info.lastInsertRowid;
      });
      return tx.immediate();
    })
  );
  ipcMain.handle('housebound:list', () =>
    run(() => getDb().prepare(`
      SELECT p.*, r.name, r.phone, r.address, r.address2,
             (SELECT MAX(v.date) FROM housebound_visits v WHERE v.reader_id = p.reader_id) AS last_visit
      FROM housebound_profiles p JOIN readers r ON r.id = p.reader_id ORDER BY r.name
    `).all())
  );
};
