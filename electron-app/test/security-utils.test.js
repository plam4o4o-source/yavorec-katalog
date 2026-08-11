// Тестове за security-utils.js (Фаза 3): CSV formula-injection защита и груба
// валидация на имейл адрес. normalizeScanCode() е от v1.70.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const { csvCell, isValidEmail, normalizeScanCode } = require('../security-utils');

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

/* --- normalizeScanCode() (v1.70.1) — баркод четецът въвежда текст буква по
   буква като физическа клавиатура; при активна кирилска (фонетична) разредба
   на Windows Code 39 баркод "B00108" пристига в програмата като "Б00108" —
   читателската карта/баркодът не се намираше при сканиране, макар да е
   сканиран правилно. Открито на живо от библиотекаря. */

test('normalizeScanCode: превръща кирилските букви от фонетичната разредба в латинските букви на същия клавиш', () => {
  assert.equal(normalizeScanCode('Б00108'), 'B00108', 'точно случаят, докладван от библиотекаря');
  assert.equal(normalizeScanCode('ЯВЕРТУИОП'), 'QWERTUIOP');
  assert.equal(normalizeScanCode('АСДФГХЙКЛ'), 'ASDFGHJKL');
  assert.equal(normalizeScanCode('ЗЬЦЖБНМ'), 'ZXCVBNM');
});

test('normalizeScanCode: работи и с малки кирилски букви (Caps Lock изключен на четеца)', () => {
  assert.equal(normalizeScanCode('б00108'), 'b00108');
});

test('normalizeScanCode: латински код, вече без кирилица, минава без промяна', () => {
  assert.equal(normalizeScanCode('B00108'), 'B00108');
  assert.equal(normalizeScanCode('12345'), '12345');
  assert.equal(normalizeScanCode('INV-2026-014'), 'INV-2026-014');
});

test('normalizeScanCode: подрязва (trim) празни знаци в началото/края, както преди при .trim() по местата на извикване', () => {
  assert.equal(normalizeScanCode('  Б00108  '), 'B00108');
});

test('normalizeScanCode: null/undefined/празен низ дават празен низ, не хвърлят изключение', () => {
  assert.equal(normalizeScanCode(null), '');
  assert.equal(normalizeScanCode(undefined), '');
  assert.equal(normalizeScanCode(''), '');
});

test('normalizeScanCode: смесен код (кирилица + цифри + тире) се възстановява напълно', () => {
  // Инв. номер, изписан примерно като "Т-15" (сигнатура), сканиран при кирилска разредба.
  assert.equal(normalizeScanCode('Т-15'), 'T-15');
});
