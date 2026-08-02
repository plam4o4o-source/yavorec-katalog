// Тестове за security-utils.js (Фаза 3): CSV formula-injection защита и груба
// валидация на имейл адрес.
const test = require('node:test');
const assert = require('node:assert/strict');
const { csvCell, isValidEmail } = require('../security-utils');

test('csvCell: plain text passes through unchanged (just quoted)', () => {
  assert.equal(csvCell('Белият вятър'), '"Белият вятър"');
  assert.equal(csvCell(42), '"42"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
});

test('csvCell: escapes embedded double quotes (standard CSV quoting)', () => {
  assert.equal(csvCell('12" книга'), '"12"" книга"');
});

for (const dangerous of ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '=cmd|\'/c calc\'!A1']) {
  test(`csvCell: neutralizes a formula-injection payload starting with "${dangerous[0]}"`, () => {
    const out = csvCell(dangerous);
    // Съдържанието вътре в кавичките трябва да започва с воден апостроф, за да
    // не го изпълни Excel/LibreOffice като формула при отваряне на файла.
    assert.ok(out.startsWith('"\'' + dangerous[0]), `expected a leading apostrophe, got: ${out}`);
  });
}

test('csvCell: a legitimate negative price is still readable (apostrophe-prefixed as text, not corrupted)', () => {
  const out = csvCell('-5.00');
  assert.equal(out, '"\'-5.00"');
});

test('isValidEmail: accepts ordinary addresses', () => {
  assert.equal(isValidEmail('ivan.petrov@example.com'), true);
  assert.equal(isValidEmail('  ivan@example.bg  '), true);
});

test('isValidEmail: rejects empty, missing @, missing domain dot, or embedded quotes', () => {
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('ivan@example'), false);
  assert.equal(isValidEmail('"ivan"@example.com'), false);
  assert.equal(isValidEmail('ivan @example.com'), false);
});
