// Криптиране на резервни копия (AES-256-GCM + scrypt) — извадено от main.js в
// самостоятелен модул, за да може да се тества директно с node:test (без
// Electron), без да се променя форматът на файла или поведението.
//
// Формати на файла:
//   "INVBAK02" (8B) | версия на KDF (1B) | сол (16B) | iv (12B) | authTag (16B) | шифрован SQLite
//   "INVBAK01" (8B) |                      сол (16B) | iv (12B) | authTag (16B) | шифрован SQLite
//
// ЗАЩО ВТОРА ВЕРСИЯ (одит v2.4.14): цената на извеждането на ключа беше зашита
// в кода (N=16384) и заглавието нямаше поле за параметри — тоест не можеше да
// се вдигне, без да се счупи всеки вече направен .invbak. А точно тези файлове
// по описанието по-долу „реално пътуват на USB/друг компютър“, тоест са най-
// вероятните за загубване или кражба; при N=16384 (≈40 ms на опит) открадната
// парола от речник се намира офлайн за ден. pii-crypto.js вече беше вдигнат на
// N=131072 с версия, носена от солта — тук същото се носи от отделен байт в
// заглавието, защото форматът е файлов и има къде.
//
// ОБРАТНА СЪВМЕСТИМОСТ: INVBAK01 се чете както преди, със старите параметри.
// Всяко НОВО копие се пише като INVBAK02.
//
// Криптират се само РЪЧНИТЕ резервни копия (тези, които реално пътуват на
// USB/друг компютър). Автоматичните дневни копия остават некриптирани — виж
// коментара в main.js за причината.
const fs = require('fs');
const crypto = require('crypto');

const BACKUP_MAGIC = Buffer.from('INVBAK01', 'utf8');   // стар формат — само за четене
const BACKUP_MAGIC_V2 = Buffer.from('INVBAK02', 'utf8'); // текущ формат
const MAGIC_BYTES = 8;
/* Параметрите на scrypt по версия. Версия 1 не съществува във файла — тя се
   подразбира от старата магия. maxmem: по подразбиране Node дава 32 МБ, а
   N=131072 при r=8 иска ≈134 МБ. */
const BACKUP_KDF_PARAMS = {
  1: { N: 16384, r: 8, p: 1 },
  2: { N: 131072, r: 8, p: 1 }
};
const CURRENT_BACKUP_KDF = 2;

function deriveBackupKey(password, salt, version) {
  const prm = BACKUP_KDF_PARAMS[version] || BACKUP_KDF_PARAMS[1];
  return crypto.scryptSync(String(password), salt, 32,
    Object.assign({ maxmem: 320 * 1024 * 1024 }, prm));
}

function isEncryptedBackup(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(MAGIC_BYTES);
    const read = fs.readSync(fd, head, 0, MAGIC_BYTES, 0);
    fs.closeSync(fd);
    return read === MAGIC_BYTES && (head.equals(BACKUP_MAGIC) || head.equals(BACKUP_MAGIC_V2));
  } catch (e) {
    return false;
  }
}

function encryptBackupFile(plainPath, destPath, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveBackupKey(password, salt, CURRENT_BACKUP_KDF);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = fs.readFileSync(plainPath);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  fs.writeFileSync(destPath, Buffer.concat([
    BACKUP_MAGIC_V2, Buffer.from([CURRENT_BACKUP_KDF]), salt, iv, cipher.getAuthTag(), enc
  ]));
}

// Разшифрова файл с резервно копие и връща съдържанието му като Buffer (без да
// го записва никъде) — извикващият решава къде да го запише (main.js го пише
// във временна папка чрез app.getPath('temp'), за да остане тук без Electron).
function decryptBackupBuffer(srcPath, password) {
  const buf = fs.readFileSync(srcPath);
  const v2 = buf.subarray(0, MAGIC_BYTES).equals(BACKUP_MAGIC_V2);
  // При v2 всичко след магията е изместено с един байт — версията на KDF.
  const off = v2 ? MAGIC_BYTES + 1 : MAGIC_BYTES;
  const version = v2 ? buf[MAGIC_BYTES] : 1;
  if (!BACKUP_KDF_PARAMS[version]) {
    throw new Error('Копието е направено с по-нова версия на програмата и не може да бъде отворено с тази.');
  }
  const salt = buf.subarray(off, off + 16);
  const iv = buf.subarray(off + 16, off + 28);
  const tag = buf.subarray(off + 28, off + 44);
  const enc = buf.subarray(off + 44);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveBackupKey(password, salt, version), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch (e) {
    throw new Error('Грешна парола или повреден файл с резервно копие.');
  }
}

module.exports = {
  BACKUP_MAGIC,
  BACKUP_MAGIC_V2,
  CURRENT_BACKUP_KDF,
  BACKUP_KDF_PARAMS,
  deriveBackupKey,
  isEncryptedBackup,
  encryptBackupFile,
  decryptBackupBuffer
};
