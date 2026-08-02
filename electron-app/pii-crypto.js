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

function deriveKey(password, saltBuffer) {
  return crypto.scryptSync(String(password), saltBuffer, 32, { N: 16384, r: 8, p: 1 });
}

function generateSalt() {
  return crypto.randomBytes(16);
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
  deriveKey,
  generateSalt,
  isEncryptedField,
  encryptField,
  decryptField,
  makeVerifier,
  checkVerifier
};
