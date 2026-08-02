// Тестове за криптирането на лични данни (ЕГН/№ ЛК) в базата данни — виж
// pii-crypto.js. Проверява: round-trip, разпознаване на вече криптирани срещу
// стари стойности в чист текст, проверка на паролата (verifier), и отхвърляне
// на подправени/повредени стойности.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  deriveKey,
  isEncryptedField,
  encryptField,
  decryptField,
  makeVerifier,
  checkVerifier
} = require('../pii-crypto');

function testSalt() { return crypto.randomBytes(16); }

test('encrypt -> decrypt round-trip returns the exact original EGN value', () => {
  const key = deriveKey('парола-123', testSalt());
  const enc = encryptField('7501011234', key);
  assert.equal(decryptField(enc, key), '7501011234');
});

test('encrypted values carry the PDPv1: prefix and are recognised by isEncryptedField', () => {
  const key = deriveKey('парола', testSalt());
  const enc = encryptField('123456789', key);
  assert.ok(enc.startsWith('PDPv1:'));
  assert.equal(isEncryptedField(enc), true);
});

test('legacy plaintext values (no prefix) are not mistaken for encrypted ones', () => {
  assert.equal(isEncryptedField('7501011234'), false);
  assert.equal(isEncryptedField(null), false);
  assert.equal(isEncryptedField(''), false);
  assert.equal(isEncryptedField(undefined), false);
});

test('decryptField passes legacy plaintext straight through unchanged', () => {
  const key = deriveKey('парола', testSalt());
  assert.equal(decryptField('7501011234', key), '7501011234');
});

test('decrypting with the wrong key throws instead of returning garbage', () => {
  const salt = testSalt();
  const rightKey = deriveKey('правилна-парола', salt);
  const wrongKey = deriveKey('грешна-парола', salt);
  const enc = encryptField('7501011234', rightKey);
  assert.throws(() => decryptField(enc, wrongKey));
});

test('tampered ciphertext is rejected (GCM auth tag)', () => {
  const key = deriveKey('парола', testSalt());
  const enc = encryptField('7501011234', key);
  const packed = Buffer.from(enc.slice('PDPv1:'.length), 'base64');
  packed[packed.length - 1] ^= 0xff;
  const tampered = 'PDPv1:' + packed.toString('base64');
  assert.throws(() => decryptField(tampered, key));
});

test('makeVerifier/checkVerifier confirm a correct password and reject a wrong one', () => {
  const salt = testSalt();
  const key = deriveKey('библиотечна-парола', salt);
  const verifier = makeVerifier(key);

  const sameKeyAgain = deriveKey('библиотечна-парола', salt);
  assert.equal(checkVerifier(verifier, sameKeyAgain), true);

  const wrongKey = deriveKey('друга-парола', salt);
  assert.equal(checkVerifier(verifier, wrongKey), false);
});

test('checkVerifier returns false (not throw) on a corrupted verifier value', () => {
  const key = deriveKey('парола', testSalt());
  assert.equal(checkVerifier('PDPv1:not-valid-base64-ciphertext', key), false);
});

test('same plaintext encrypted twice yields different ciphertext (random IV per value)', () => {
  const key = deriveKey('парола', testSalt());
  const a = encryptField('7501011234', key);
  const b = encryptField('7501011234', key);
  assert.notEqual(a, b);
  assert.equal(decryptField(a, key), '7501011234');
  assert.equal(decryptField(b, key), '7501011234');
});
