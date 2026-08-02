// Интеграционен тест: пресъздава (не require-ва, main.js е Electron main
// процес и не може да се зареди самостоятелно тук) точната логика от main.js
// за защита на ЕГН/№ ЛК — maskReaderRow/preparePiiForWrite/reencryptAllReaders
// — върху истинска SQLite база данни (schema.sql + миграцията от db-init.test.js),
// за да провери реалния сценарий: настройка на паролата, четене заключено срещу
// отключено, редакция заключено (пази старата стойност) срещу отключено.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const pii = require('../pii-crypto');

const PDP_PLACEHOLDER = 'Защитени данни';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-pdp-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.exec("ALTER TABLE settings ADD COLUMN pdp_salt TEXT");
  db.exec("ALTER TABLE settings ADD COLUMN pdp_verifier TEXT");
  return db;
}

// --- Точно копие на логиката от main.js (за целите на теста) ---
function makeHelpers(db) {
  let PDP_KEY = null;
  const pdpSettingsRow = () => db.prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id = 1').get() || {};
  const pdpConfigured = () => { const s = pdpSettingsRow(); return !!(s.pdp_salt && s.pdp_verifier); };
  function maskReaderRow(r) {
    if (!r) return r;
    for (const f of ['egn', 'id_card_no']) {
      if (!pii.isEncryptedField(r[f])) continue;
      if (!PDP_KEY) { r[f] = PDP_PLACEHOLDER; continue; }
      try { r[f] = pii.decryptField(r[f], PDP_KEY); } catch (e) { r[f] = PDP_PLACEHOLDER; }
    }
    return r;
  }
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
  function reencryptAllReaders(readKey, writeKey) {
    const rows = db.prepare(`SELECT id, egn, id_card_no FROM readers
      WHERE (egn IS NOT NULL AND egn <> '') OR (id_card_no IS NOT NULL AND id_card_no <> '')`).all();
    const upd = db.prepare('UPDATE readers SET egn = ?, id_card_no = ? WHERE id = ?');
    for (const r of rows) {
      const plainEgn = readKey ? pii.decryptField(r.egn, readKey) : r.egn;
      const plainIdc = readKey ? pii.decryptField(r.id_card_no, readKey) : r.id_card_no;
      upd.run(plainEgn ? pii.encryptField(plainEgn, writeKey) : plainEgn,
              plainIdc ? pii.encryptField(plainIdc, writeKey) : plainIdc, r.id);
    }
    return rows.length;
  }
  function setup(password) {
    const salt = pii.generateSalt();
    const key = pii.deriveKey(password, salt);
    const verifier = pii.makeVerifier(key);
    db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
      .run(salt.toString('base64'), verifier);
    reencryptAllReaders(null, key);
    PDP_KEY = key;
  }
  function unlock(password) {
    const s = pdpSettingsRow();
    const key = pii.deriveKey(password, Buffer.from(s.pdp_salt, 'base64'));
    if (!pii.checkVerifier(s.pdp_verifier, key)) throw new Error('Грешна парола.');
    PDP_KEY = key;
  }
  function lock() { PDP_KEY = null; }
  return { maskReaderRow, preparePiiForWrite, setup, unlock, lock, isUnlocked: () => !!PDP_KEY };
}

function insertReader(db, fields) {
  const cols = Object.keys(fields);
  return db.prepare(`INSERT INTO readers (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`)
    .run(fields).lastInsertRowid;
}

test('before PDP is set up, egn/id_card_no behave exactly as plaintext (backward compatible)', () => {
  const db = freshDb();
  const H = makeHelpers(db);
  const id = insertReader(db, { name: 'Иван Иванов', egn: '7501011234', id_card_no: 'AB123456' });
  const row = H.maskReaderRow(db.prepare('SELECT * FROM readers WHERE id=?').get(id));
  assert.equal(row.egn, '7501011234');
  assert.equal(row.id_card_no, 'AB123456');
  db.close();
});

test('pdp:setup encrypts pre-existing plaintext EGN/ID for all readers', () => {
  const db = freshDb();
  const H = makeHelpers(db);
  const id = insertReader(db, { name: 'Мария Петрова', egn: '8002025678', id_card_no: 'CD987654' });
  H.setup('библиотечна-парола');

  const raw = db.prepare('SELECT egn, id_card_no FROM readers WHERE id=?').get(id);
  assert.ok(pii.isEncryptedField(raw.egn), 'egn should now be stored encrypted');
  assert.ok(pii.isEncryptedField(raw.id_card_no), 'id_card_no should now be stored encrypted');

  const shown = H.maskReaderRow(db.prepare('SELECT * FROM readers WHERE id=?').get(id));
  assert.equal(shown.egn, '8002025678');
  assert.equal(shown.id_card_no, 'CD987654');
  db.close();
});

test('after lock, reading returns the placeholder instead of the value or raw ciphertext', () => {
  const db = freshDb();
  const H = makeHelpers(db);
  const id = insertReader(db, { name: 'Георги Георгиев', egn: '6503038888', id_card_no: 'EF111222' });
  H.setup('парола1');
  H.lock();

  const shown = H.maskReaderRow(db.prepare('SELECT * FROM readers WHERE id=?').get(id));
  assert.equal(shown.egn, PDP_PLACEHOLDER);
  assert.equal(shown.id_card_no, PDP_PLACEHOLDER);
  // Other fields are completely unaffected by the lock.
  assert.equal(shown.name, 'Георги Георгиев');
  db.close();
});

test('unlock with the correct password restores decrypted values; wrong password is rejected', () => {
  const db = freshDb();
  const H = makeHelpers(db);
  insertReader(db, { name: 'Райна Ангелова', egn: '9004047777', id_card_no: 'GH333444' });
  H.setup('правилна-парола-2024');
  H.lock();

  assert.throws(() => H.unlock('грешна-парола'));
  assert.equal(H.isUnlocked(), false);

  H.unlock('правилна-парола-2024');
  assert.equal(H.isUnlocked(), true);
  const shown = H.maskReaderRow(db.prepare('SELECT * FROM readers WHERE name=?').get('Райна Ангелова'));
  assert.equal(shown.egn, '9004047777');
  db.close();
});

test('editing a reader while LOCKED preserves the encrypted EGN/ID untouched, no matter what is submitted', () => {
  const db = freshDb();
  const H = makeHelpers(db);
  const id = insertReader(db, { name: 'Тодор Тодоров', egn: '5501011111', phone: '111', id_card_no: 'XY000111' });
  H.setup('парола-3');
  H.lock();

  const prev = db.prepare('SELECT * FROM readers WHERE id=?').get(id);
  // Renderer would submit the placeholder text back (disabled field) plus a real phone-number change.
  const payload = { egn: PDP_PLACEHOLDER, id_card_no: PDP_PLACEHOLDER, phone: '999' };
  H.preparePiiForWrite(payload, prev);
  db.prepare('UPDATE readers SET egn=@egn, id_card_no=@id_card_no, phone=@phone WHERE id=@id')
    .run(Object.assign({ id }, payload));

  const raw = db.prepare('SELECT egn, id_card_no, phone FROM readers WHERE id=?').get(id);
  assert.equal(raw.egn, prev.egn, 'egn ciphertext must be untouched while locked');
  assert.equal(raw.id_card_no, prev.id_card_no, 'id_card_no ciphertext must be untouched while locked');
  assert.equal(raw.phone, '999', 'unrelated fields must still save normally while locked');

  // And it must still decrypt correctly once unlocked again — proves the "preserve" path
  // didn't corrupt the stored ciphertext.
  H.unlock('парола-3');
  const shown = H.maskReaderRow(db.prepare('SELECT * FROM readers WHERE id=?').get(id));
  assert.equal(shown.egn, '5501011111');
  db.close();
});

test('creating a NEW reader with an EGN while PDP is configured but locked is rejected', () => {
  const db = freshDb();
  const H = makeHelpers(db);
  insertReader(db, { name: 'existing', egn: '1111111111' });
  H.setup('парола-4');
  H.lock();

  const payload = { name: 'Нов читател', egn: '2222222222' };
  assert.throws(() => H.preparePiiForWrite(payload, null), /Отключете защитата/);
  db.close();
});

test('creating a new reader without an EGN while locked succeeds (fields just stay empty)', () => {
  const db = freshDb();
  const H = makeHelpers(db);
  insertReader(db, { name: 'existing', egn: '3333333333' });
  H.setup('парола-5');
  H.lock();

  const payload = { name: 'Нов читател без ЕГН', egn: null, id_card_no: null };
  assert.doesNotThrow(() => H.preparePiiForWrite(payload, null));
  db.close();
});

test('changing the password re-encrypts every reader and the OLD password no longer works', () => {
  const db = freshDb();
  const H = makeHelpers(db);
  const id1 = insertReader(db, { name: 'Читател 1', egn: '4444444444' });
  const id2 = insertReader(db, { name: 'Читател 2', egn: '5555555555', id_card_no: 'ZZ999888' });
  H.setup('стара-парола');

  // Симулира pdp:changePassword изцяло (не е изложено през H, тестваме директно тук).
  const s = db.prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id=1').get();
  const oldKey = pii.deriveKey('стара-парола', Buffer.from(s.pdp_salt, 'base64'));
  assert.ok(pii.checkVerifier(s.pdp_verifier, oldKey));

  const newSalt = pii.generateSalt();
  const newKey = pii.deriveKey('нова-парола', newSalt);
  const newVerifier = pii.makeVerifier(newKey);
  const rows = db.prepare(`SELECT id, egn, id_card_no FROM readers WHERE egn IS NOT NULL AND egn <> ''`).all();
  const upd = db.prepare('UPDATE readers SET egn=?, id_card_no=? WHERE id=?');
  for (const r of rows) {
    const plainEgn = pii.decryptField(r.egn, oldKey);
    const plainIdc = r.id_card_no ? pii.decryptField(r.id_card_no, oldKey) : r.id_card_no;
    upd.run(pii.encryptField(plainEgn, newKey), plainIdc ? pii.encryptField(plainIdc, newKey) : plainIdc, r.id);
  }
  db.prepare('UPDATE settings SET pdp_salt=?, pdp_verifier=? WHERE id=1').run(newSalt.toString('base64'), newVerifier);

  // Old password must now fail verification against the new verifier.
  const s2 = db.prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id=1').get();
  const oldKeyRetry = pii.deriveKey('стара-парола', Buffer.from(s2.pdp_salt, 'base64'));
  assert.equal(pii.checkVerifier(s2.pdp_verifier, oldKeyRetry), false);

  // New password decrypts both readers correctly.
  H.unlock('нова-парола');
  assert.equal(H.maskReaderRow(db.prepare('SELECT * FROM readers WHERE id=?').get(id1)).egn, '4444444444');
  const r2 = H.maskReaderRow(db.prepare('SELECT * FROM readers WHERE id=?').get(id2));
  assert.equal(r2.egn, '5555555555');
  assert.equal(r2.id_card_no, 'ZZ999888');
  db.close();
});
