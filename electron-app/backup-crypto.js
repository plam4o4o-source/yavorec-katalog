// Криптиране на резервни копия (AES-256-GCM + scrypt) — извадено от main.js в
// самостоятелен модул, за да може да се тества директно с node:test (без
// Electron), без да се променя форматът на файла или поведението.
//
// Формат: "INVBAK01" (8B) | сол (16B) | iv (12B) | authTag (16B) | шифрован SQLite файл
//
// Криптират се само РЪЧНИТЕ резервни копия (тези, които реално пътуват на
// USB/друг компютър). Автоматичните дневни копия остават некриптирани — виж
// коментара в main.js за причината.
const fs = require('fs');
const crypto = require('crypto');

const BACKUP_MAGIC = Buffer.from('INVBAK01', 'utf8');

function deriveBackupKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
}

function isEncryptedBackup(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(BACKUP_MAGIC.length);
    const read = fs.readSync(fd, head, 0, BACKUP_MAGIC.length, 0);
    fs.closeSync(fd);
    return read === BACKUP_MAGIC.length && head.equals(BACKUP_MAGIC);
  } catch (e) {
    return false;
  }
}

function encryptBackupFile(plainPath, destPath, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveBackupKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = fs.readFileSync(plainPath);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  fs.writeFileSync(destPath, Buffer.concat([BACKUP_MAGIC, salt, iv, cipher.getAuthTag(), enc]));
}

// Разшифрова файл с резервно копие и връща съдържанието му като Buffer (без да
// го записва никъде) — извикващият решава къде да го запише (main.js го пише
// във временна папка чрез app.getPath('temp'), за да остане тук без Electron).
function decryptBackupBuffer(srcPath, password) {
  const buf = fs.readFileSync(srcPath);
  const salt = buf.subarray(8, 24);
  const iv = buf.subarray(24, 36);
  const tag = buf.subarray(36, 52);
  const enc = buf.subarray(52);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveBackupKey(password, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch (e) {
    throw new Error('Грешна парола или повреден файл с резервно копие.');
  }
}

module.exports = {
  BACKUP_MAGIC,
  deriveBackupKey,
  isEncryptedBackup,
  encryptBackupFile,
  decryptBackupBuffer
};
