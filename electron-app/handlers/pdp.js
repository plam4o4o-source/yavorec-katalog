// Защита на лични данни: ЕГН / № лична карта (обща парола) — извадено от
// main.js в отделен модул (Фаза 4, стъпка 35). ЕГН и номер на лична карта
// на читателите могат да се защитят с обща парола (AES-256-GCM, виж
// pii-crypto.js) — една и съща парола на всички компютри, които ползват
// тази база данни, включително споделена мрежова база. Останалите данни за
// читателя (име, адрес, телефон, история на заемания) не са засегнати.
//
// Ключът (PDP_KEY) се пази само в паметта на текущия процес ("отключено" за
// тази сесия на програмата) — никога на диск, и е module-scope състояние тук
// (не се връща навън — само функциите, които го ползват, се връщат обратно).
//
// maskReaderRow/maskReaderRows/preparePiiForWrite се връщат обратно към
// main.js, защото handlers/readers.js (извадено по-рано, Фаза 4 стъпка 17)
// вече ги ползва по пряка референция в обект, подаден на неговия require(),
// който стои СЛЕД мястото на този модул в main.js — същият модел на връщане
// напред, установен за LOAN_SELECT/BOOK_SELECT.
module.exports = function registerPdpHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;
  const pii = require('../pii-crypto');

  let PDP_KEY = null;
  const PDP_PLACEHOLDER = 'Защитени данни';
  function pdpSettingsRow() {
    return getDb().prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id = 1').get() || {};
  }
  function pdpConfigured() {
    const s = pdpSettingsRow();
    return !!(s.pdp_salt && s.pdp_verifier);
  }
  // Прилага се към всеки читателски ред, преди да напусне main процеса: разкрипта
  // egn/id_card_no ако защитата е отключена в момента, показва плейсхолдър ако е
  // заключена, и оставя непроменени старите стойности в чист текст (инсталации,
  // които никога не са задавали тази защита — пълна обратна съвместимост).
  function maskReaderRow(r) {
    if (!r) return r;
    for (const f of ['egn', 'id_card_no']) {
      if (!pii.isEncryptedField(r[f])) continue;
      if (!PDP_KEY) { r[f] = PDP_PLACEHOLDER; continue; }
      try { r[f] = pii.decryptField(r[f], PDP_KEY); }
      catch (e) { r[f] = PDP_PLACEHOLDER; console.error('Разкриптиране на лични данни:', e.message); }
    }
    return r;
  }
  function maskReaderRows(rows) { rows.forEach(maskReaderRow); return rows; }
  // Подготвя egn/id_card_no за запис. Ако защитата не е зададена изобщо — без
  // промяна (старо поведение, чист текст). Ако е зададена и отключена — криптира
  // новите стойности. Ако е зададена, но ЗАКЛЮЧЕНА в момента: при редакция се
  // пази предишната (криптирана) стойност непроменена, каквото и да е дошло от
  // интерфейса — тези полета там се показват само за четене, докато не се въведе
  // паролата, точно за да не презапишат криптирана стойност с плейсхолдъра. При
  // нов читател без предишен ред няма какво да се пази, затова се изисква
  // отключване, ако е въведено ЕГН/№ ЛК.
  function preparePiiForWrite(out, prev) {
    if (!pdpConfigured()) return;
    for (const f of ['egn', 'id_card_no']) {
      if (PDP_KEY) {
        if (out[f] && !pii.isEncryptedField(out[f])) out[f] = pii.encryptField(out[f], PDP_KEY);
      } else if (prev) {
        out[f] = prev[f];
      } else if (out[f]) {
        throw new Error('Отключете защитата на лични данни от „Настройки“, за да запишете ЕГН/№ ЛК на нов читател.');
      }
    }
  }
  // Прекриптира всички съществуващи стойности egn/id_card_no с нов ключ — ползва
  // се и при първо задаване на паролата (стойностите тогава са в чист текст), и
  // при смяна на паролата (стойностите тогава вече са криптирани със стария
  // ключ). readKey е null, ако стойностите в момента са в чист текст.
  function reencryptAllReaders(readKey, writeKey) {
    const db = getDb();
    const rows = db.prepare(`SELECT id, egn, id_card_no FROM readers
      WHERE (egn IS NOT NULL AND egn <> '') OR (id_card_no IS NOT NULL AND id_card_no <> '')`).all();
    const upd = db.prepare('UPDATE readers SET egn = ?, id_card_no = ? WHERE id = ?');
    for (const r of rows) {
      const plainEgn = readKey ? pii.decryptField(r.egn, readKey) : r.egn;
      const plainIdc = readKey ? pii.decryptField(r.id_card_no, readKey) : r.id_card_no;
      upd.run(
        plainEgn ? pii.encryptField(plainEgn, writeKey) : plainEgn,
        plainIdc ? pii.encryptField(plainIdc, writeKey) : plainIdc,
        r.id
      );
    }
    return rows.length;
  }
  ipcMain.handle('pdp:status', () =>
    run(() => ({ configured: pdpConfigured(), unlocked: !!PDP_KEY }))
  );
  ipcMain.handle('pdp:setup', (e, password) =>
    run(() => {
      const db = getDb();
      if (!password || String(password).length < 4) throw new Error('Паролата трябва да е поне 4 знака.');
      if (pdpConfigured()) throw new Error('Защитата вече е зададена — за смяна на паролата ползвайте смяната на паролата.');
      const salt = pii.generateSalt();
      const key = pii.deriveKey(password, salt);
      const verifier = pii.makeVerifier(key);
      let n = 0;
      db.transaction(() => {
        db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
          .run(salt.toString('base64'), verifier);
        n = reencryptAllReaders(null, key);
      })();
      PDP_KEY = key;
      logAudit('Защита на лични данни', 'зададена е парола за защита на ЕГН/№ ЛК (' + n + ' читатели засегнати)');
      return true;
    })
  );
  ipcMain.handle('pdp:unlock', (e, password) =>
    run(() => {
      const s = pdpSettingsRow();
      if (!s.pdp_salt || !s.pdp_verifier) throw new Error('Защитата не е зададена.');
      const key = pii.deriveKey(password, Buffer.from(s.pdp_salt, 'base64'));
      if (!pii.checkVerifier(s.pdp_verifier, key)) throw new Error('Грешна парола.');
      PDP_KEY = key;
      return true;
    })
  );
  ipcMain.handle('pdp:lock', () => run(() => { PDP_KEY = null; }));
  ipcMain.handle('pdp:changePassword', (e, { oldPassword, newPassword } = {}) =>
    run(() => {
      const db = getDb();
      const s = pdpSettingsRow();
      if (!s.pdp_salt || !s.pdp_verifier) throw new Error('Защитата не е зададена.');
      if (!newPassword || String(newPassword).length < 4) throw new Error('Новата парола трябва да е поне 4 знака.');
      const oldKey = pii.deriveKey(oldPassword, Buffer.from(s.pdp_salt, 'base64'));
      if (!pii.checkVerifier(s.pdp_verifier, oldKey)) throw new Error('Текущата парола е грешна.');
      const newSalt = pii.generateSalt();
      const newKey = pii.deriveKey(newPassword, newSalt);
      const newVerifier = pii.makeVerifier(newKey);
      db.transaction(() => {
        db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
          .run(newSalt.toString('base64'), newVerifier);
        reencryptAllReaders(oldKey, newKey);
      })();
      PDP_KEY = newKey;
      logAudit('Защита на лични данни', 'паролата за защита на ЕГН/№ ЛК е сменена');
      return true;
    })
  );

  return { maskReaderRow, maskReaderRows, preparePiiForWrite };
};
