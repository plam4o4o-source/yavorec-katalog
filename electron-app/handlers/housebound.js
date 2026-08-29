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
module.exports = function registerHouseboundHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, logEvent, today } = deps;

  ipcMain.handle('housebound:get', (e, readerId) =>
    run(() => {
      const db = getDb();
      const p = db.prepare('SELECT * FROM housebound_profiles WHERE reader_id = ?').get(readerId) || null;
      const visits = db.prepare('SELECT * FROM housebound_visits WHERE reader_id = ? ORDER BY date DESC LIMIT 30').all(readerId);
      return { profile: p, visits };
    })
  );
  ipcMain.handle('housebound:save', (e, { reader_id, day, frequency, note }) =>
    run(() => {
      const db = getDb();
      db.prepare(`INSERT INTO housebound_profiles (reader_id, day, frequency, note) VALUES (?, ?, ?, ?)
        ON CONFLICT(reader_id) DO UPDATE SET day=excluded.day, frequency=excluded.frequency, note=excluded.note`)
        .run(reader_id, day || null, frequency || null, note || null);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Обслужване по домовете', 'график за ' + (r ? r.name : reader_id));
    })
  );
  ipcMain.handle('housebound:remove', (e, readerId) =>
    run(() => { getDb().prepare('DELETE FROM housebound_profiles WHERE reader_id = ?').run(readerId); })
  );
  ipcMain.handle('housebound:addVisit', (e, { reader_id, date, note }) =>
    run(() => {
      const db = getDb();
      const d = date || today();
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
