// Читатели — извадени от main.js в отделен модул (Фаза 4, стъпка 17 от
// разбиването на монолита на модули по домейн). maskReaderRow/maskReaderRows/
// preparePiiForWrite/diffFields/checkRecordLimit/ftsQuery/today/logAudit се
// подават по референция — всички са function declarations (hoisted) или
// стабилен модулен export в main.js, затворени над реалните мутируеми
// състояния там (PDP_KEY, db) — работят коректно и извикани оттук.
module.exports = function registerReadersHandlers(ipcMain, deps) {
  const {
    getDb, run, logAudit, today, ftsQuery,
    maskReaderRow, maskReaderRows, preparePiiForWrite, diffFields, checkRecordLimit,
    dialog, getMainWindow, fs, csvCell, normalizeScanCode
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
  // normalizeScanCode() (v1.70.1, security-utils.js): баркод четецът въвежда
  // текста буква по буква като клавиатура, а активна кирилска (фонетична)
  // разредба на Windows превръща букви от Code 39 картата (напр. B) в
  // кирилски еквивалент (Б) — картата не се намираше, макар да е сканирана
  // правилно. Виж и books:byBarcode за същия дефект/поправка.
  ipcMain.handle('readers:byCard', (e, card) => run(() => maskReaderRow(getDb().prepare('SELECT * FROM readers WHERE card_no = ?').get(normalizeScanCode(card)))));
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
  /* loans.reader_id е с ON DELETE CASCADE (db/schema.sql): досега изтриването на
     читател мълчаливо триеше и заеманията му. Реалният случай: библиотекарят
     „чисти“ стар читател, който в момента държи 3 книги — следата изчезва, а
     книгите се водят налични, макар да са у него. Отказваме по същия модел като
     acquisitions:delete/periodicals:delete, като разделяме двата случая:
       • отворени заемания — казваме колко са и че първо се приемат обратно;
       • само затворена история — изтриването би заличило и минали заемания
         (годишната статистика за минали години ще се промени), затова сочим
         правилния път: състояние „прекратен“ и/или „Анонимизиране“ (Настройки →
         Лични данни), което къса връзката с името, но пази статистиката. Така
         правото „да ме забравите“ остава изпълнимо, без да се губят числата.

     И тук отказът при само затворена история не бива да е окончателен: в цялата
     програма няма път за изтриване на заемане, затова погрешно създаден читател
     (сгрешена карта, дубликат), на когото е било записано и веднага прието едно
     заемане, оставаше неизтриваем завинаги. Затова първото натискане отказва и
     обяснява (правилният път за истински читател си остава „прекратен“ +
     анонимизиране), а повторно натискане до 2 минути изтрива записа заедно с
     историята му — със запис в одитната следа. Виж същия похват в books:delete
     (handlers/books.js). Отказът при НЕВЪРНАТИ документи остава безусловен. */
  const FORCE_DELETE_MS = 2 * 60 * 1000;
  const pendingReaderDelete = new Map(); // id → кога е отказано първия път
  function askedTwice(pending, id) {
    const now = Date.now();
    for (const [k, t] of pending) if (now - t > FORCE_DELETE_MS) pending.delete(k);
    if (pending.has(id)) { pending.delete(id); return true; }
    pending.set(id, now);
    return false;
  }
  ipcMain.handle('readers:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const open = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ? AND date_in IS NULL').get(id).n;
      if (open > 0) {
        throw new Error('Читателят държи в момента ' +
          (open === 1 ? '1 незавърнат документ' : open + ' незавърнати документа') +
          ' и не може да бъде изтрит. Първо приемете върнатите документи от „Заемане и връщане“.');
      }
      const past = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ?').get(id).n;
      if (past > 0 && !askedTwice(pendingReaderDelete, id)) {
        throw new Error('Читателят има ' + past + ' записа в историята на заеманията и изтриването би заличило и тях '
          + '(статистиката за минали години ще се промени). Задайте състояние „прекратен“, а за заличаване на личните данни '
          + 'ползвайте „Анонимизиране“ в „Настройки“ → „Лични данни“. Ако записът е сгрешен и изобщо не е трябвало да '
          + 'съществува, натиснете „Изтрий“ още веднъж до 2 минути — читателят ще бъде изтрит заедно с '
          + (past === 1 ? 'единствения запис' : 'всичките ' + past + ' записа') + ' в историята.');
      }
      const r = db.prepare('SELECT name, card_no FROM readers WHERE id = ?').get(id);
      db.prepare('DELETE FROM readers WHERE id = ?').run(id);
      if (past > 0) {
        logAudit('Изтрит читател с история', ((r && r.name) || ('читател № ' + id)) +
          ((r && r.card_no) ? ' (карта ' + r.card_no + ')' : '') +
          ' — заедно с ' + past + ' записа в историята на заеманията');
      }
    })
  );

  // Износ на списъка читатели в CSV (v1.70.0). Нарочно БЕЗ ЕГН/№ на лична карта —
  // това е справочен документ, не заместител на защитата на личните данни; ЕГН/№ ЛК
  // и без друго излизат маскирани от readers:list, ако защитата е заключена.
  ipcMain.handle('readers:exportCsv', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Износ на читателите (CSV)',
        defaultPath: 'chitateli.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      const rows = getDb().prepare('SELECT * FROM readers ORDER BY name').all();
      const h = ['Читателска карта', 'Име', 'Телефон', 'Адрес', 'Имейл', 'Категория',
        'Състояние', 'Дата на регистрация', 'Дата на пререгистрация', 'Забележка'];
      const csv = [h.join(';')].concat(rows.map(r => [
        r.card_no, r.name, r.phone, [r.address, r.address2].filter(Boolean).join(', '), r.email,
        r.category, r.status, r.registered_at, r.re_registered_at, r.note
      ].map(csvCell).join(';'))).join('\r\n');
      fs.writeFileSync(filePath, '﻿' + csv, 'utf8');
      logAudit('Износ на читатели (CSV)', filePath + ' — ' + rows.length + ' записа');
      return { ok: true, data: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
};
