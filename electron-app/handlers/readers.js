// Читатели — извадени от main.js в отделен модул (Фаза 4, стъпка 17 от
// разбиването на монолита на модули по домейн). maskReaderRow/maskReaderRows/
// preparePiiForWrite/diffFields/checkRecordLimit/ftsQuery/today/logAudit се
// подават по референция — всички са function declarations (hoisted) или
// стабилен модулен export в main.js, затворени над реалните мутируеми
// състояния там (PDP_KEY, db) — работят коректно и извикани оттук.
module.exports = function registerReadersHandlers(ipcMain, deps) {
  const {
    getDb, run, logAudit, today, ftsQuery,
    maskReaderRow, maskReaderRows, preparePiiForWrite, diffFields, checkRecordLimit
  } = deps;

  const READER_FIELDS = ['name', 'phone', 'address', 'address2', 'email', 'card_no', 'egn',
    'id_card_no', 'id_card_date', 'id_card_issuer', 'birth_date', 'category', 'registered_at',
    're_registered_at', 'status', 'gdpr_consent', 'gdpr_consent_date', 'parent_consent',
    'parent_consent_date', 'guarantor_name', 'guarantor_relation', 'guarantor_phone', 'note'];

  /* prev — досегашният ред (при редакция). Датата на съгласието се записва в момента
     на отбелязване и се пази при следващи записи; голият флаг 0/1 без дата е слаба
     защита при проверка по ЗЗЛД/GDPR. Сваленото съгласие сваля и датата. */
  function readerPayload(r, prev) {
    const out = {};
    READER_FIELDS.forEach(f => { out[f] = r[f] === undefined || r[f] === '' ? null : r[f]; });
    out.gdpr_consent = r.gdpr_consent ? 1 : 0;
    out.parent_consent = r.parent_consent ? 1 : 0;
    out.gdpr_consent_date = out.gdpr_consent ? ((prev && prev.gdpr_consent_date) || today()) : null;
    out.parent_consent_date = out.parent_consent ? ((prev && prev.parent_consent_date) || today()) : null;
    out.category = r.category || 'възрастен';
    out.status = r.status || 'активен';
    out.registered_at = r.registered_at || today();
    return out;
  }

  ipcMain.handle('readers:list', (e, query) =>
    run(() => {
      const db = getDb();
      if (query && query.trim()) {
        const q = `%${query.trim()}%`;
        // Името минава през FTS5 (виж books:list за обяснението); телефон и
        // карта остават LIKE — цифри, без проблем с регистъра, а "съдържа навсякъде"
        // помага при търсене по част от номера.
        return maskReaderRows(db.prepare(`
          SELECT * FROM readers
          WHERE id IN (SELECT rowid FROM readers_fts WHERE readers_fts MATCH ?)
             OR phone LIKE ? OR card_no LIKE ?
          ORDER BY name
        `).all(ftsQuery(query), q, q));
      }
      return maskReaderRows(db.prepare('SELECT * FROM readers ORDER BY name').all());
    })
  );
  ipcMain.handle('readers:get', (e, id) => run(() => maskReaderRow(getDb().prepare('SELECT * FROM readers WHERE id = ?').get(id))));
  ipcMain.handle('readers:byCard', (e, card) => run(() => maskReaderRow(getDb().prepare('SELECT * FROM readers WHERE card_no = ?').get(card))));
  ipcMain.handle('readers:create', (e, r) =>
    run(() => {
      const db = getDb();
      checkRecordLimit('readers');
      const payload = readerPayload(r);
      preparePiiForWrite(payload, null);
      const info = db.prepare(`
        INSERT INTO readers (${READER_FIELDS.join(',')}) VALUES (${READER_FIELDS.map(f => '@' + f).join(',')})
      `).run(payload);
      logAudit('Нов читател', 'карта ' + (r.card_no || '') + ' — ' + r.name);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('readers:update', (e, r) =>
    run(() => {
      const db = getDb();
      const prev = db.prepare('SELECT * FROM readers WHERE id = ?').get(r.id);
      const payload = readerPayload(r, prev);
      preparePiiForWrite(payload, prev);
      db.prepare(`UPDATE readers SET ${READER_FIELDS.map(f => f + '=@' + f).join(',')} WHERE id=@id`)
        .run(Object.assign({ id: r.id }, payload));
      // ЕГН и номер на документ за самоличност не влизат в диференца на одитната следа —
      // тя се пази с експорт в CSV и не бива да удвоява най-чувствителните лични данни.
      const diff = diffFields(prev, payload, READER_FIELDS.filter(f => f !== 'egn' && f !== 'id_card_no'));
      logAudit('Редакция на читател', 'карта ' + (r.card_no || '') + ' — ' + r.name, diff);
    })
  );
  // Сваля наказанието „преустановено заемане" предсрочно — решение на библиотекаря.
  ipcMain.handle('readers:clearSuspension', (e, id) =>
    run(() => {
      const db = getDb();
      db.prepare('UPDATE readers SET suspended_until = NULL WHERE id = ?').run(id);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(id);
      logAudit('Снето наказание', r ? r.name : ('читател № ' + id));
    })
  );
  ipcMain.handle('readers:delete', (e, id) => run(() => getDb().prepare('DELETE FROM readers WHERE id = ?').run(id)));
};
