// Криптиране на лични данни в самата база данни (ЕГН, номер на лична карта) —
// AES-256-GCM със споделена парола (една и съща на всички компютри, които
// ползват една и съща — евентуално мрежова — база данни). За разлика от
// backup-crypto.js (случайна сол за всеки файл, паролата се пита рядко), тук
// солта е ЕДНА, постоянна за цялата инсталация (пази се в settings.pdp_salt),
// защото стойностите се четат/пишат непрекъснато и трябва един и същ ключ да
// върши работа на всеки компютър, свързан към същата база.
//
// Формат на съхранение (TEXT колона): "PDPv1:" + base64(iv(12B) + tag(16B) + ciphertext)
// "PDPv1:" префиксът различава вече криптирани стойности от старите данни в
// чист текст (за инсталации, обновени от версия отпреди тази защита).
const crypto = require('crypto');

const FIELD_PREFIX = 'PDPv1:';
const VERIFIER_PLAINTEXT = 'INVENTAR-PDP-OK';

/* Цена на извеждането на ключа (scrypt). pdp_salt/pdp_verifier живеят в самата
   база данни, а базата по документиран сценарий стои на СПОДЕЛЕН МРЕЖОВ ДЯЛ —
   всеки, който може да прочете файла, може да атакува паролата офлайн. v1
   (N=16384) е около 40 ms на ключ, тоест милиони опити на ден с обикновен
   компютър. v2 вдига N осем пъти (≈0,35 s тук, под 2 s и на стар библиотечен
   компютър — ключът се извежда веднъж на сесия, при отключване) и оскъпява
   офлайн атаката осем пъти при същата парола.

   ОБРАТНА СЪВМЕСТИМОСТ: версията се носи от САМАТА сол, не от нова колона —
   старите соли са точно 16 байта (v1), новите са 17 байта с водещ байт = номер
   на версията. Така всяка вече съществуваща база продължава да се отключва със
   старите параметри, без промяна по схемата и без нищо да се прекриптира, а
   deriveKey() разпознава версията сама — включително извикана по стария начин с
   два аргумента (напр. от тестове, пресъздаващи логиката на main.js). */
const SCRYPT_PARAMS = {
  1: { N: 16384, r: 8, p: 1 },
  2: { N: 131072, r: 8, p: 1 }
};
const CURRENT_KDF_VERSION = 2;
const SALT_BYTES = 16;

function saltVersion(saltBuffer) {
  if (!saltBuffer || saltBuffer.length === SALT_BYTES) return 1;
  const v = saltBuffer[0];
  return SCRYPT_PARAMS[v] ? v : 1;
}

function deriveKey(password, saltBuffer) {
  const prm = SCRYPT_PARAMS[saltVersion(saltBuffer)];
  // maxmem: по подразбиране Node дава 32 МБ, а v2 иска 128·N·r ≈ 134 МБ.
  return crypto.scryptSync(String(password), saltBuffer, 32, Object.assign({ maxmem: 320 * 1024 * 1024 }, prm));
}

// Без аргумент — сол по стария образец (v1), за да не се променя поведението на
// вече съществуващи извиквания; handlers/pdp.js изрично иска CURRENT_KDF_VERSION
// за всяка НОВА парола.
function generateSalt(version) {
  const v = SCRYPT_PARAMS[version] ? version : 1;
  const raw = crypto.randomBytes(SALT_BYTES);
  return v === 1 ? raw : Buffer.concat([Buffer.from([v]), raw]);
}

function isEncryptedField(value) {
  return typeof value === 'string' && value.startsWith(FIELD_PREFIX);
}

function encryptField(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), enc]);
  return FIELD_PREFIX + packed.toString('base64');
}

// Хвърля при грешен ключ / повредена стойност — извикващият решава какво да
// показва в такъв случай (напр. "Защитени данни"), вместо да гърми в интерфейса.
function decryptField(stored, key) {
  if (!isEncryptedField(stored)) return stored; // стари данни в чист текст — без промяна
  const packed = Buffer.from(stored.slice(FIELD_PREFIX.length), 'base64');
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const enc = packed.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/* ---------------- Състояние на сесията (само в паметта) ----------------
   Ключът на защитата на личните данни и паролата, от която е изведен, докато
   защитата е ОТКЛЮЧЕНА в текущия процес. Живеят тук, а не само в затварянето на
   handlers/pdp.js, защото и handlers/backup.js трябва да ги вижда: ако защитата
   е отключена, автоматичното дневно копие се криптира със същата парола (виж
   autoBackupIfNeeded). Модулите нямат друг общ път един към друг — deps идват от
   main.js, а той не се пипа в тази поправка.

   Пази се и самата парола, не само изведеният ключ: копието трябва да може да се
   ОТКЛЮЧИ по-късно от човек, а човекът знае паролата, не 32-байтовия ключ (и не
   може да го изведе, защото солта е вътре в криптираното копие). Рискът е малък
   спрямо ползата — ключът в паметта и без това отключва същите данни; нищо от
   това не се записва на диск и се изчиства при заключване. */
let pdpSession = { key: null, password: null };
/* Абонати за „защитата току-що беше отключена“. Нужно е на handlers/backup.js:
   дневното копие се прави при стартиране на програмата, когато защитата още е
   заключена, така че без това известие копието практически никога не би било
   криптирано (виж upgradeTodayAutoBackup там). */
const sessionListeners = new Set();
function onSession(cb) { sessionListeners.add(cb); return () => sessionListeners.delete(cb); }
function setSession(password, key) {
  pdpSession = { key: key || null, password: password == null ? null : String(password) };
  // Провален абонат никога не бива да проваля самото отключване.
  sessionListeners.forEach(cb => { try { cb(); } catch (e) { console.error('Известие за отключена защита:', e.message); } });
}
function clearSession() { pdpSession = { key: null, password: null }; }
function getSessionKey() { return pdpSession.key; }
function getSessionPassword() { return pdpSession.password; }

// "Проверител" — известен низ, криптиран с ключа, изведен от паролата. Позволява
// да се провери дали въведената парола е правилната, без никъде да се пази
// самата парола или ключът извън паметта на текущата сесия.
function makeVerifier(key) {
  return encryptField(VERIFIER_PLAINTEXT, key);
}
function checkVerifier(storedVerifier, key) {
  try {
    return decryptField(storedVerifier, key) === VERIFIER_PLAINTEXT;
  } catch (e) {
    return false;
  }
}

module.exports = {
  FIELD_PREFIX,
  CURRENT_KDF_VERSION,
  saltVersion,
  deriveKey,
  generateSalt,
  isEncryptedField,
  encryptField,
  decryptField,
  makeVerifier,
  checkVerifier,
  setSession,
  onSession,
  clearSession,
  getSessionKey,
  getSessionPassword
};
