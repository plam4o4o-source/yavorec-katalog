// Тестове за security-utils.js (Фаза 3): CSV formula-injection защита и груба
// валидация на имейл адрес. normalizeScanCode() е от v1.70.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const { csvCell, isValidEmail, normalizeScanCode, isValidIsoDate } = require('../security-utils');

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

test('normalizeScanCode: null/undefined/празен/само-whitespace низ дават null (не празен низ), не хвърлят изключение (v2.4.0 — одит №23)', () => {
  // Преди тук се връщаше '' — а всеки повикващ пита базата с
  // "... inv_number = CAST(? AS INTEGER)", където CAST('' AS INTEGER) = 0 в
  // SQLite: празно сканиране можеше мълчаливо да намери ред с inv_number=0.
  // null прави сравнението винаги невярно (SQL NULL семантика), точно както
  // "не е намерен код".
  assert.equal(normalizeScanCode(null), null);
  assert.equal(normalizeScanCode(undefined), null);
  assert.equal(normalizeScanCode(''), null);
  assert.equal(normalizeScanCode('   '), null);
  assert.equal(normalizeScanCode('\t\n  '), null);
});

test('normalizeScanCode: премахва вътрешни контролни знаци, не само подрязва краищата (v2.4.0 — одит №23)', () => {
  assert.equal(normalizeScanCode('12\n34'), '1234');
  assert.equal(normalizeScanCode('12\t34'), '1234');
  assert.equal(normalizeScanCode('B\x0000108'), 'B00108');
});

test('normalizeScanCode: смесен код (кирилица + цифри + тире) се възстановява напълно', () => {
  // Инв. номер, изписан примерно като "Т-15" (сигнатура), сканиран при кирилска разредба.
  assert.equal(normalizeScanCode('Т-15'), 'T-15');
});

test('isValidIsoDate: приема истински валидни дати', () => {
  assert.equal(isValidIsoDate('2026-08-21'), true);
  assert.equal(isValidIsoDate('2024-02-29'), true); // високосна година
  assert.equal(isValidIsoDate('2026-01-01'), true);
  assert.equal(isValidIsoDate('2026-12-31'), true);
});

test('isValidIsoDate: отхвърля формати и стойности от одит v2.3.1 №6', () => {
  assert.equal(isValidIsoDate('0000-00-00'), false);
  assert.equal(isValidIsoDate('2026-13-45'), false);
  assert.equal(isValidIsoDate('not-a-date'), false);
  // 2026-02-30 минава regex-а на формата, но JS би я търкулнала напред до
  // 2 март без грешка — точно затова проверката е с обратно сравнение, не
  // само регулярен израз.
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2023-02-29'), false); // не високосна
  assert.equal(isValidIsoDate('2026-04-31'), false); // април има 30 дни
  assert.equal(isValidIsoDate(''), false);
  assert.equal(isValidIsoDate(null), false);
  assert.equal(isValidIsoDate(undefined), false);
  assert.equal(isValidIsoDate('21.08.2026'), false); // грешен формат (не ISO)
});
