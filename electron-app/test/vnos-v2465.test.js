'use strict';
/* Кръг 42 (v2.4.65) — ВНОСЪТ НА ДАННИ: трите находки на поправящия „ВНОС“.
 * =====================================================================
 * Тестовете гледат онова, което библиотекарката вижда — текста на екрана след
 * вноса, реда в базата и числото в инвентарната книга — а не вътрешната форма
 * на отчета. Пуска се ИСТИНСКИЯТ екран (src/views/data-import.js в jsdom) срещу
 * ИСТИНСКИТЕ обработчици (handlers/*.js, регистрирани от самия main.js).
 *
 *  А5. ОТРИЦАТЕЛНА ЦЕНА. Ред с цена „-99“ влизаше безпрепятствено: КДБФ обявяваше
 *      наличност −89 €, инвентарната книга „Неотчислени −89.00 €“, а „Съгласуване
 *      на фонда“ не намираше нищо. Записът беше и неремонтируем през картона —
 *      всяко записване падаше със съобщение за цена, която библиотекарката не е
 *      въвеждала. Вносът вече минава през същата parseBookPrice, която пази
 *      формата за книга; отрицателна цена сваля реда в „Редове с грешка“, а
 *      нечислова цена („безплатно“) вече не става тихо 0, а дава предупреждение.
 *
 *  А6. ПОВРЕДЕН ФАЙЛ. Незатворена кавичка изяждаше остатъка на файла: 5 реда →
 *      2 документа, единият със заглавие от 80 знака боклук, три изчезваха
 *      безследно, а отчетът казваше „2 Въведени · 0 Пропуснати“ без нито една
 *      грешка. Главният процес ВЕЧЕ беше изчислил предупреждението
 *      (importers.js) — никой екран не го четеше. Сега се показва в диалога за
 *      съответствие НАД бутона „Въведи N реда“ и се повтаря в отчета.
 *
 *  Б8. МЪЛЧАЛИВО ПРОПУСНАТ РЕД. Ред, чийто инвентарен номер е зает от съвсем
 *      друга книга, се изхвърляше с голо `report.skipped++`; екранът казваше само
 *      „2 Пропуснати“. При слята библиотека това са стотици документа, за които
 *      няма как да се разбере кои са. Сега всеки пропуснат ред се изрежда с
 *      номер на ред, инвентарен номер, заглавие и причина.
 */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vnos-v2465-'));

test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* временна папка */ } });

/* Файл с данни за внос — с BOM, както го изнася всяка българска система. */
function csvFile(name, lines) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, '﻿' + lines.join('\n'), 'utf8');
  return p;
}
/* Вносът така, както го прави библиотекарката: „Избери файл за въвеждане…“ →
   диалогът за съответствие → бутонът „Въведи N реда“ → отчетът. */
async function importThroughScreen(filePath, opts) {
  await h.go('setup');
  h.dialogs.openPaths = [filePath];
  await h.clickButton('Избери файл за въвеждане…');
  const mapText = h.modal();
  if (opts && opts.skipDuplicates === false) h.type('#impOptF [name=skipDuplicates]', false);
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  return { mapText, reportText: h.modal() };
}

test('А5 отрицателна цена от файл не влиза във фонда и се вижда кой ред е отпаднал', async () => {
  const p = csvFile('a5-otricatelna.csv', [
    'Инвентарен №,Заглавие,Автор,Цена,Дата на вписване',
    '501,Добра книга,Ав,10,01.01.2020',
    '502,Кредитно известие,Ав,-99,01.01.2020'
  ]);
  const { reportText } = await importThroughScreen(p);

  // 1) Редът НЕ е в базата — стойността на фонда остава вярна.
  const rows = h.db.prepare('SELECT inv_number, title, price FROM books WHERE inv_number IN (501, 502) ORDER BY inv_number').all();
  assert.deepEqual(rows, [{ inv_number: 501, title: 'Добра книга', price: 10 }],
    'ред с отрицателна цена не бива да влиза във фонда: ' + JSON.stringify(rows));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM books WHERE price < 0').get().n, 0,
    'в базата няма как да съществува документ с отрицателна оценка (Наредба № 3, чл. 3, ал. 2)');

  // 2) Библиотекарката вижда КОЙ ред е отпаднал и защо — на екрана, не в дневника.
  assert.match(reportText, /Редове с грешка: 1/, 'отчетът не съобщава за ред с грешка:\n' + reportText);
  assert.match(reportText, /ред 3/, 'отчетът не назовава номера на реда:\n' + reportText);
  assert.match(reportText, /отрицателна/, 'отчетът не казва, че цената е отрицателна:\n' + reportText);

  // 3) Инвентарната книга показва положителна стойност на неотчисления фонд.
  await h.go('invbook');
  const kpi = h.text('.kpis');
  assert.match(kpi, /10\.00 €/, 'инвентарната книга не показва вярната стойност: ' + kpi);
  assert.ok(!/-\d+\.\d\d €/.test(kpi), 'инвентарната книга показва отрицателна стойност на фонда: ' + kpi);
});

test('А5 нечислова цена („безплатно“) вече не става тихо 0, а се съобщава', async () => {
  const p = csvFile('a5-bezplatno.csv', [
    'Инвентарен №,Заглавие,Автор,Цена,Дата на вписване',
    '511,Дарена книга,Ав,безплатно,01.01.2020'
  ]);
  const { reportText } = await importThroughScreen(p);

  const row = h.db.prepare('SELECT title, price FROM books WHERE inv_number = 511').get();
  assert.deepEqual(row, { title: 'Дарена книга', price: 0 }, 'документът трябва да влезе със стойност 0,00 €');
  assert.match(reportText, /Предупреждения/, 'отчетът не показва предупреждения:\n' + reportText);
  assert.match(reportText, /ред 2: цената „безплатно“ не е число/,
    'отчетът не казва на кой ред цената не е била число:\n' + reportText);
});

test('А6 повреден файл: предупреждението стои НАД бутона „Въведи N реда“', async () => {
  const p = csvFile('a6-kavichka.csv', [
    'Инвентарен №,Заглавие,Автор,Цена',
    '601,Преди повредата,Ав,1',
    '602,"Незатворена кавичка,Ав,2',
    '603,След повредата,Ав,3',
    '604,Още една,Ав,4',
    '605,Последна,Ав,5'
  ]);
  await h.go('setup');
  h.dialogs.openPaths = [p];
  await h.clickButton('Избери файл за въвеждане…');

  const mapText = h.modal();
  assert.match(mapText, /Файлът изглежда повреден/, 'диалогът за съответствие мълчи за повредения файл:\n' + mapText);
  assert.match(mapText, /възможно е част от данните да са се слели/,
    'диалогът не показва текста, изчислен от importers.readTable:\n' + mapText);

  /* „Над бутона“ се проверява буквално: възелът с предупреждението трябва да
     стои ПРЕДИ бутона „Въведи N реда“ в документа — иначе библиотекарката го
     прочита едва след като вече е натиснала. */
  const warnNode = Array.from(h.document.querySelectorAll('#modal .note.w'))
    .find(n => /Файлът изглежда повреден/.test(n.textContent));
  assert.ok(warnNode, 'няма възел с предупреждението в диалога за съответствие');
  const btn = h.button('Въведи', '#modal');
  const FOLLOWING = h.window.Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(warnNode.compareDocumentPosition(btn) & FOLLOWING,
    'предупреждението за повреден файл трябва да е НАД бутона „Въведи N реда“');
  assert.match(btn.textContent, /Въведи 2 реда/, 'бутонът трябва да казва колко реда е разчела програмата');

  // И в отчета след вноса — числото „Въведени“ само по себе си изглежда нормално.
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  const reportText = h.modal();
  assert.match(reportText, /Файлът беше разпознат като повреден/,
    'отчетът след вноса не повтаря предупреждението:\n' + reportText);
  assert.match(reportText, /следващи редове да липсват/, 'отчетът не казва какво точно е станало:\n' + reportText);

  // Следата в дневника е единственото, което остава след затварянето на отчета.
  const last = h.db.prepare("SELECT detail FROM audit_log WHERE action = 'Въвеждане на данни' ORDER BY id DESC LIMIT 1").get();
  assert.match(String(last && last.detail), /възможно повреден/,
    'дневникът не пази, че файлът е бил повреден: ' + JSON.stringify(last));
});

test('Б8 пропуснатият ред се назовава: номер на ред, номер, заглавие и кой заема номера', async () => {
  h.db.prepare("INSERT INTO books (inv_number, title, register_date, status, price) VALUES (700, 'Заварена 700', ?, 'наличен', 5)").run(T);
  const p = csvFile('b8-zaet-nomer.csv', [
    'Инвентарен №,Заглавие,Автор,Цена,Дата на вписване',
    '700,СЪВСЕМ ДРУГА КНИГА под зает номер,Ав,9,01.01.2020',
    '701,,Ав,9,01.01.2020',
    '702,Добра,Ав,9,01.01.2020'
  ]);
  const { reportText } = await importThroughScreen(p);

  assert.match(reportText, /Кои редове не бяха въведени: 2/,
    'отчетът показва само число „Пропуснати“, без нито един ред:\n' + reportText);
  // Редът със зетия номер — с номера на реда, номера и заглавието си.
  assert.match(reportText, /ред 2 \(№ 700\) — „СЪВСЕМ ДРУГА КНИГА под зает номер“/,
    'пропуснатият ред не е назован:\n' + reportText);
  assert.match(reportText, /зает от „Заварена 700“/,
    'отчетът не казва КОЙ документ държи номера — точно по това се различава дубликатът от сблъсъка:\n' + reportText);
  // И редът без заглавие — той също изчезваше мълчаливо.
  assert.match(reportText, /ред 3.*няма заглавие/,
    'редът без заглавие също трябва да е назован:\n' + reportText);

  const inBase = h.db.prepare('SELECT inv_number, title FROM books WHERE inv_number >= 700 ORDER BY inv_number').all();
  assert.deepEqual(inBase, [{ inv_number: 700, title: 'Заварена 700' }, { inv_number: 702, title: 'Добра' }],
    'в базата влиза само годният ред: ' + JSON.stringify(inBase));
});
