'use strict';
/* ============================================================================
   v2.4.66 — ЦЕНА В ЛЕВОВЕ ОТ СТАР ФАЙЛ СЕ ПРЕВРЪЩА В ЕВРО ПРИ ВНОС.
   ============================================================================
   Решение на библиотеката след прегледа на v2.4.65: левовете се превръщат по
   фиксирания курс 1,95583. Дотук:
     • до v2.4.64 „12,50 лв.“ влизаше като 12,50 € — двойно надценено, тихо;
     • във v2.4.65 същото влизаше като 0,00 € с предупреждение на всеки ред.
   Тестът минава през ИСТИНСКИЯ екран за внос и истинския main.js — така
   проверява и че курсът наистина стига до обработчика (EUR_RATE), а не само
   функцията поотделно.
   ========================================================================== */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const E = require('./helpers/e2e-app');

let h = null;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'leva-v2466-'));

test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* временна папка */ } });

function csvFile(name, lines) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, '﻿' + lines.join('\n'), 'utf8');
  return p;
}
async function importThroughScreen(filePath) {
  await h.go('setup');
  h.dialogs.openPaths = [filePath];
  await h.clickButton('Избери файл за въвеждане…');
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  return h.modal();
}
const priceOf = (inv) => (h.db.prepare('SELECT price FROM books WHERE inv_number = ?').get(inv) || {}).price;
/* Същата формула като превръщането на заварените цени при миграцията към евро. */
const toEur = (leva) => Math.round(leva / 1.95583 * 100) / 100;

test('левове във всички обичайни записи се превръщат по курса 1,95583, закръглено до евроцент', async () => {
  const p = csvFile('leva.csv', [
    'Инвентарен №,Заглавие,Автор,Цена,Дата на вписване',
    '801,Отзад с точка,Ав,"12,50 лв.",01.01.2020',
    '802,Отзад без точка,Ав,"12,50лв",01.01.2020',
    '803,Отпред,Ав,"лв. 3,00",01.01.2020',
    '804,С думата,Ав,"20 лева",01.01.2020',
    '805,С кода,Ав,"19.56 BGN",01.01.2020',
    '806,Главни букви,Ав,"7,00 ЛВ.",01.01.2020'
  ]);
  const report = await importThroughScreen(p);

  assert.equal(priceOf(801), toEur(12.50), '„12,50 лв.“ → ' + priceOf(801));
  assert.equal(priceOf(801), 6.39, 'примерът от отчета трябва да е верен: 12,50 лв. → 6,39 €');
  assert.equal(priceOf(802), toEur(12.50));
  assert.equal(priceOf(803), toEur(3.00));
  assert.equal(priceOf(804), toEur(20));
  assert.equal(priceOf(805), toEur(19.56), 'кодът BGN');
  assert.equal(priceOf(805), 10.00, '19,56 лв. е точно 10,00 € по курса');
  assert.equal(priceOf(806), toEur(7.00), 'регистърът няма значение');

  /* Отчетът казва колко са превърнати — ВЕДНЪЖ, с числото, а не на всеки ред. */
  assert.match(report, /6 цени бяха в левове и са превърнати/,
    'отчетът трябва да каже колко цени са превърнати:\n' + report);
  assert.match(report, /1,95583/, 'отчетът трябва да назове курса:\n' + report);
  assert.ok(!/не е число/.test(report), 'нито една от тези цени не бива да е обявена за „не е число“:\n' + report);
});

test('евро и число без валута остават както са', async () => {
  const p = csvFile('evro.csv', [
    'Инвентарен №,Заглавие,Автор,Цена,Дата на вписване',
    '811,Евро знак,Ав,"10,00 €",01.01.2020',
    '812,EUR,Ав,"4,50 EUR",01.01.2020',
    '813,Без валута,Ав,"7,00",01.01.2020'
  ]);
  const report = await importThroughScreen(p);
  assert.equal(priceOf(811), 10);
  assert.equal(priceOf(812), 4.5);
  assert.equal(priceOf(813), 7, 'число без валута е в евро — програмата не може да познае друго');
  assert.ok(!/превърнат/.test(report), 'нищо не е превръщано, отчетът не бива да твърди обратното:\n' + report);
});

test('отрицателна цена в левове пак се отказва, а разделител за хилядите пак не става 1,23', async () => {
  const p = csvFile('leva-greshni.csv', [
    'Инвентарен №,Заглавие,Автор,Цена,Дата на вписване',
    '821,Отрицателна,Ав,"-5 лв.",01.01.2020',
    '822,Хиляди,Ав,"1.234,50 лв.",01.01.2020'
  ]);
  const report = await importThroughScreen(p);
  /* Отрицателната — не влиза изобщо (чл. 3, ал. 2: отрицателна оценка няма). */
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM books WHERE inv_number = 821').get().n, 0,
    'документ с отрицателна цена в левове не бива да влиза във фонда');
  assert.match(report, /отрицателна/, report);
  /* „1.234,50“ не е разпознато число — влиза с 0 и предупреждение, вместо тихо да
     стане 1,23 (1.234 → 0,63 €) или 1234,50. Решението остава на библиотекарката. */
  assert.equal(priceOf(822), 0, '„1.234,50 лв.“ не бива тихо да стане друго число: ' + priceOf(822));
  assert.match(report, /1\.234,50 лв\./, 'предупреждението трябва да цитира записа от файла:\n' + report);
});
