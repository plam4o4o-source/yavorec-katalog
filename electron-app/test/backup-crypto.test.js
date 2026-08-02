// Регресионни тестове за криптирането на резервни копия (AES-256-GCM + scrypt).
// Извадено от main.js в backup-crypto.js точно за да могат тези тестове да
// съществуват без Electron. Проверява: round-trip на съдържанието, отхвърляне
// на грешна парола, отхвърляне на подправен/повреден файл, и разпознаване на
// формàта през isEncryptedBackup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isEncryptedBackup,
  encryptBackupFile,
  decryptBackupBuffer
} = require('../backup-crypto');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-crypto-test-'));
  return path.join(dir, name);
}

test('encrypt -> decrypt round-trip returns the exact original bytes', () => {
  const plainPath = tmpFile('plain.db');
  const encPath = tmpFile('backup.invbak');
  const original = Buffer.from('SQLite format 3\0' + 'X'.repeat(5000)); // проста заместваща "база данни"
  fs.writeFileSync(plainPath, original);

  encryptBackupFile(plainPath, encPath, 'парола-123');
  const decrypted = decryptBackupBuffer(encPath, 'парола-123');

  assert.ok(original.equals(decrypted), 'decrypted content must exactly match the original');
});

test('wrong password is rejected, not silently returning garbage', () => {
  const plainPath = tmpFile('plain.db');
  const encPath = tmpFile('backup.invbak');
  fs.writeFileSync(plainPath, Buffer.from('some database bytes'));
  encryptBackupFile(plainPath, encPath, 'правилна-парола');

  assert.throws(
    () => decryptBackupBuffer(encPath, 'грешна-парола'),
    /Грешна парола или повреден файл/
  );
});

test('tampered ciphertext is rejected (GCM auth tag catches corruption)', () => {
  const plainPath = tmpFile('plain.db');
  const encPath = tmpFile('backup.invbak');
  fs.writeFileSync(plainPath, Buffer.from('some database bytes that are long enough to flip a byte in'));
  encryptBackupFile(plainPath, encPath, 'парола');

  const buf = fs.readFileSync(encPath);
  buf[buf.length - 1] ^= 0xff; // счупваме един байт от шифрования текст
  fs.writeFileSync(encPath, buf);

  assert.throws(
    () => decryptBackupBuffer(encPath, 'парола'),
    /Грешна парола или повреден файл/
  );
});

test('isEncryptedBackup correctly distinguishes encrypted vs plain files', () => {
  const encPath = tmpFile('backup.invbak');
  const plainPath = tmpFile('plain.db');
  fs.writeFileSync(plainPath, Buffer.from('SQLite format 3\0plain unencrypted content'));
  encryptBackupFile(plainPath, encPath, 'парола');

  assert.equal(isEncryptedBackup(encPath), true);
  assert.equal(isEncryptedBackup(plainPath), false);
  assert.equal(isEncryptedBackup(path.join(os.tmpdir(), 'does-not-exist-xyz.db')), false);
});

test('salt and IV are random per file (two encryptions of the same content differ)', () => {
  const plainPath = tmpFile('plain.db');
  const encPath1 = tmpFile('backup1.invbak');
  const encPath2 = tmpFile('backup2.invbak');
  fs.writeFileSync(plainPath, Buffer.from('identical content'));

  encryptBackupFile(plainPath, encPath1, 'парола');
  encryptBackupFile(plainPath, encPath2, 'парола');

  const b1 = fs.readFileSync(encPath1);
  const b2 = fs.readFileSync(encPath2);
  assert.notEqual(b1.toString('hex'), b2.toString('hex'), 'two encryptions of identical plaintext must not be byte-identical (random salt/iv)');

  // но и двата трябва да се разшифроват правилно към същото съдържание
  assert.ok(decryptBackupBuffer(encPath1, 'парола').equals(Buffer.from('identical content')));
  assert.ok(decryptBackupBuffer(encPath2, 'парола').equals(Buffer.from('identical content')));
});
