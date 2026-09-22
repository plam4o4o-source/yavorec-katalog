'use strict';
/* v2.4.64 — четиридесет и първи кръг: производителност на онлайн каталога.
   =====================================================================
   Две измерени горещи точки, и двете от едно и също място — файловете, които
   програмата изнася от фонда:

   1) katalog.json се пренаписваше след ВСЯКО сканиране на гишето. Измерено с
      `node /tmp/r41/bench.js cat` върху истинска база (15 000 документа,
      13 800 публикувани, файл 4,82 МБ): catalog:write 180 ms, „заемане +
      записът след него“ (cat.afterScan) 178 ms, от които самото сканиране е
      1 – 2 ms. Разбивката (`node /tmp/r41/catalog-split.js` и А/Б на самото
      сглобяване): товарът 105 ms, текстът 24 ms, ПРОВЕРКАТА с пълен JSON.parse
      и два JSON.stringify ~60 ms (цялата функция 89 → 25 ms при дословно същия
      текст), записът 6 ms.
      Поправката е на три места: отделен, по-дълъг срок за циркулацията (90 s
      вместо 4 s), един товар за двамата му консуматора вместо два, и проверка
      на сглобения текст с постоянна цена вместо с цена по размера на файла.

   2) Трите износа (UNIMARC 433 ms, Dublin Core 248 ms, CSV 226 ms) минаваха
      през BOOK_SELECT — `b.*` (38 колони) плюс корелирана подзаявка на ред:
      124 ms и 10,60 МБ в паметта срещу 89 ms и 7,05 МБ за изброената проекция
      с агрегат (`node /tmp/r41/catalog-split.js`). По цял износ, редуващо се в
      един процес върху една и съща база: UNIMARC 527 → 455 ms, Dublin Core
      301 → 287 ms, CSV 280 → 227 ms — при байт по байт същите файлове.

   КАКВО ДОКАЗВАТ ТЕСТОВЕТЕ ТУК (нарочно разделено):
     • че резултатът е СЪЩИЯТ — съдържанието на каталога, правилото за
       „налична“ и трите изнесени файла БАЙТ ПО БАЙТ;
     • че устройството е такова, каквото твърди коментарът — по изпълнение на
       истинския код от main.js с подставен часовник (двата срока, единственият
       запис, изпразването при затваряне) и по текста на заявките (изброена
       проекция, без подзаявка на ред) — същият вид проверка като в
       test/perf-v2431.test.js.

   ЗА ПРАГА ПО ВРЕМЕ най-долу важи същата честна бележка като в
   test/perf-v2448.test.js: той НЕ лови връщане назад (на тази машина старият
   код минава под прага при малък фонд), а е груб предпазител срещу нещо
   драстично. Истинските прегради са проверките по устройство.

   Всеки тест е проверен с мутация. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { startMainApp } = require('./helpers/main-app.js');
const { BOOK_SELECT, csvCell, MAIN_SRC, extractDeclaration } = require('./helpers/prod-values.js');

const APP_DIR = path.join(__dirname, '..');
const CAT_SRC = fs.readFileSync(path.join(APP_DIR, 'handlers', 'catalog.js'), 'utf8');
const LOANS_SRC = fs.readFileSync(path.join(APP_DIR, 'handlers', 'loans.js'), 'utf8');
const DEBOUNCE_SRC = fs.readFileSync(path.join(APP_DIR, 'debounce.js'), 'utf8');

/* Хигиена на временните папки — както в останалите тестове на каталога. */
const tmpDirs = [];
function mkTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-katalog-2464-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
  }
});

/* ==================================================================
   Пясъчник с ИСТИНСКИЯ код от main.js
   ==================================================================
   Декларациите се вадят от main.js по име (test/helpers/prod-values.js) и се
   изпълняват в отделен контекст с подставени часовник и база. Така тестът
   проверява буквално продукционния код, а преименуване/премахване гърми явно,
   вместо мълчаливо да провери остаряло копие. */
function extractCreateDebouncer() {
  const i = DEBOUNCE_SRC.indexOf('function createDebouncer');
  assert.ok(i >= 0, 'debounce.js вече не съдържа createDebouncer');
  const end = DEBOUNCE_SRC.indexOf('\n}', i);
  return DEBOUNCE_SRC.slice(i, end + 2);
}
function fakeClock() {
  let now = 0, seq = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { at: now + ms, fn }); return { id, unref() {} }; },
    clearTimeout: (h) => { if (h && timers.has(h.id)) timers.delete(h.id); },
    armed: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (let guard = 0; ; guard++) {
        assert.ok(guard < 1000, 'подставеният часовник се завъртя — безкраен таймер');
        let pick = null;
        for (const [id, t] of timers) if (t.at <= end && (!pick || t.at < pick[1].at)) pick = [id, t];
        if (!pick) break;
        timers.delete(pick[0]);
        now = pick[1].at;
        pick[1].fn();
      }
      now = end;
    }
  };
}
// Двата срока + единственият запис, с истинския createDebouncer и подставен часовник.
function debounceSandbox() {
  const clock = fakeClock();
  const writes = [];
  const ctx = vm.createContext({
    console: { error() {}, log() {} },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    writeCatalogIfConfigured: () => { writes.push(clock.now()); return { written: true }; }
  });
  const names = ['CATALOG_WRITE_CIRCULATION', 'CATALOG_WRITE_DEBOUNCE_FUND_MS', 'CATALOG_WRITE_DEBOUNCE_CIRC_MS',
    'CATALOG_WRITE_STATE', 'CATALOG_PAYLOAD_CACHE', 'dropCatalogPayloadCache', 'runPendingCatalogWrite',
    'catalogFundWriter', 'catalogCircWriter', 'scheduleCatalogWrite', 'flushCatalogWrite', 'catalogWriteDebouncer'];
  const src = extractCreateDebouncer() + '\n' + names.map(extractDeclaration).join('\n')
    + '\n;({ ' + names.join(', ') + ' })';
  const out = vm.runInContext(src, ctx, { filename: 'main.js (извлечен отложен запис)' });
  return { clock, writes, ...out };
}

test('циркулацията чака дългия срок, а промяната по фонда — краткия', () => {
  const s = debounceSandbox();
  assert.equal(s.CATALOG_WRITE_DEBOUNCE_FUND_MS, 4000, 'фондът остава на досегашните 4 секунди');
  assert.ok(s.CATALOG_WRITE_DEBOUNCE_CIRC_MS >= 60000 && s.CATALOG_WRITE_DEBOUNCE_CIRC_MS <= 120000,
    'циркулацията е в измереното 60 – 120 s, а не по-малко: ' + s.CATALOG_WRITE_DEBOUNCE_CIRC_MS);

  s.scheduleCatalogWrite(s.CATALOG_WRITE_CIRCULATION);
  s.clock.advance(s.CATALOG_WRITE_DEBOUNCE_FUND_MS + 1);
  assert.deepEqual(s.writes, [], 'заемане/връщане НЕ пренаписва каталога след 4 секунди');
  s.clock.advance(s.CATALOG_WRITE_DEBOUNCE_CIRC_MS);
  assert.equal(s.writes.length, 1, 'но се записва, след като дългият срок изтече');
  assert.equal(s.writes[0], s.CATALOG_WRITE_DEBOUNCE_CIRC_MS, 'точно на дългия срок от първата промяна');

  const f = debounceSandbox();
  f.scheduleCatalogWrite();                 // промяна по фонда (повикване без вид — както в останалите модули)
  f.clock.advance(f.CATALOG_WRITE_DEBOUNCE_FUND_MS);
  assert.deepEqual(f.writes, [f.CATALOG_WRITE_DEBOUNCE_FUND_MS],
    'нова книга/редакция/отчисляване се публикува по бързия срок както досега');
});

test('много сканирания в един запис: срокът е ТАВАН от първата незаписана промяна, не пълзящ', () => {
  const s = debounceSandbox();
  // гише през 15 секунди — точно ритъмът от измерването (сканиране на 10 – 20 s)
  for (let i = 0; i < 6; i++) {
    s.scheduleCatalogWrite(s.CATALOG_WRITE_CIRCULATION);
    s.clock.advance(15000);
  }
  assert.equal(s.writes.length, 1, 'шест заемания = един запис на файла, а не шест');
  assert.equal(s.writes[0], s.CATALOG_WRITE_DEBOUNCE_CIRC_MS,
    'записът идва 90 s след ПЪРВОТО сканиране — иначе натоварено гише би отлагало каталога безкрайно');
  s.clock.advance(600000);
  assert.equal(s.writes.length, 1, 'и нито един излишен запис след това');
});

test('двата таймера правят ЕДИН запис: промяна по фонда изтегля напред и натрупаното от гишето', () => {
  const s = debounceSandbox();
  s.scheduleCatalogWrite(s.CATALOG_WRITE_CIRCULATION);
  s.clock.advance(1000);
  s.scheduleCatalogWrite();                             // библиотекарката вписва книга по време на гишето
  s.clock.advance(s.CATALOG_WRITE_DEBOUNCE_FUND_MS);
  assert.equal(s.writes.length, 1, 'бързият таймер записва всичко натрупано');
  s.clock.advance(600000);
  assert.equal(s.writes.length, 1, 'дългият таймер вижда, че няма какво да пише, и не прави втори запис на 4,82 МБ');
});

test('при затваряне насроченото се изпразва — и за дългия срок на гишето', () => {
  const s = debounceSandbox();
  assert.equal(s.catalogWriteDebouncer.pending(), false, 'без промяна няма какво да се пише при затваряне');
  s.scheduleCatalogWrite(s.CATALOG_WRITE_CIRCULATION);
  assert.equal(s.catalogWriteDebouncer.pending(), true,
    'връщане в 16:59 ч. се брои за незаписана промяна — иначе изходът в 17:00 ч. го губи до следващия работен ден');
  const r = s.flushCatalogWrite();
  assert.deepEqual(r, { written: true }, 'flush() пише СИНХРОННО и връща резултата (ползва се от writeNow/gitPublishNow)');
  assert.equal(s.writes.length, 1);
  assert.equal(s.catalogWriteDebouncer.pending(), false);
  s.clock.advance(600000);
  assert.equal(s.writes.length, 1, 'изпразването гаси и двата таймера — без втори запис след изхода');
  assert.equal(s.clock.armed(), 0);

  /* Самият ред в main.js: записът СТАВА при затваряне и стои ПРЕДИ проверката за
     непубликувани промени (v2.4.57) и преди спирането на таймера за публикуване. */
  const quit = MAIN_SRC.slice(MAIN_SRC.indexOf("app.on('window-all-closed'"));
  const iFlush = quit.indexOf('if (catalogWriteDebouncer.pending()) flushCatalogWrite();');
  const iWarn = quit.indexOf('warnUnpublishedCatalogOnQuit();');
  const iStop = quit.indexOf('stopAutoPushTimer();');
  assert.ok(iFlush > 0, 'window-all-closed вече не изпразва отложения запис');
  assert.ok(iFlush < iWarn && iWarn < iStop, 'редът е: запис → предупреждение за непубликувано → спиране на таймера');
});

test('гишето (и само то) минава по дългия срок — по всички повиквания в handlers/loans.js', () => {
  const calls = LOANS_SRC.match(/scheduleCatalogWrite\([^)]*\)/g) || [];
  /* v2.4.65: шестото повикване е новото „Документът се намери“ (loans:found) —
     обратният път на „Документът е изгубен“, който връща документа във фонда и в
     наличността на публичния каталог. То минава по СЪЩИЯ дълъг срок като своето
     огледало (markLost), а не по бързия на фонда: и двете сменят наличността на
     един документ от гишето, и едното без другото би значело, че връщането се
     публикува по-бързо от отбелязването. */
  assert.equal(calls.length, 6,
    'заемане, връщане, изгубен документ, намерен документ, заемане по код, връщане по код');
  for (const c of calls) {
    assert.equal(c, 'scheduleCatalogWrite(CIRCULATION)', 'всяко повикване от гишето подава вида на промяната: ' + c);
  }
  assert.match(LOANS_SRC, /const CIRCULATION = 'circulation';/, 'стойността е същата като CATALOG_WRITE_CIRCULATION в main.js');
  assert.match(MAIN_SRC, /const CATALOG_WRITE_CIRCULATION = 'circulation';/);

  /* Никой друг домейн НЕ бива да е на дългия срок: нова книга, редакция, акт за
     отчисляване, периодика и витрини се публикуват веднага. */
  for (const f of fs.readdirSync(path.join(APP_DIR, 'handlers'))) {
    if (!f.endsWith('.js') || f === 'loans.js') continue;
    const src = fs.readFileSync(path.join(APP_DIR, 'handlers', f), 'utf8');
    for (const c of src.match(/scheduleCatalogWrite\([^)]*\)/g) || []) {
      assert.equal(c, 'scheduleCatalogWrite()', f + ': промяна по фонда се публикува по бързия срок — ' + c);
    }
  }
});

/* ==================================================================
   2. Един товар за двамата му консуматора (кешът)
   ================================================================== */
function payloadSandbox(db) {
  const builds = [];
  const ctx = vm.createContext({
    console: { error() {}, log() {} },
    db,
    Date,
    buildCatalogPayload: () => { builds.push(1); return { library: 'Б', items: [{ inv: 1 }] }; }
  });
  const names = ['CATALOG_PAYLOAD_CACHE', 'catalogDataStamp', 'dropCatalogPayloadCache', 'catalogPayloadNow'];
  const src = names.map(extractDeclaration).join('\n') + '\n;({ ' + names.join(', ') + ' })';
  const out = vm.runInContext(src, ctx, { filename: 'main.js (извлечен кеш на товара)' });
  return { builds, ctx, ...out };
}

test('товарът се сглобява веднъж за една промяна в базата — и се пресглобява при всяка промяна', () => {
  const dir = mkTmpDir();
  const db = new Database(path.join(dir, 'library.db'));
  db.exec('CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT)');
  const s = payloadSandbox(db);

  const a = s.catalogPayloadNow();
  const b = s.catalogPayloadNow();
  assert.equal(s.builds.length, 1, 'втори консуматор на същите данни НЕ сглобява товара наново (95 ms при 13 800 документа)');
  assert.equal(a, b, 'и получава същия обект');

  db.prepare("INSERT INTO books (title) VALUES ('Нова')").run();
  s.catalogPayloadNow();
  assert.equal(s.builds.length, 2, 'промяна през тази връзка (total_changes) прави товара невалиден');

  /* Промяна от ДРУГА връзка към същия файл — второ работно място на мрежовата
     папка или възстановено копие. total_changes() за нея мълчи; хваща я
     PRAGMA data_version. Без тази половина каталогът би се публикувал със
     стари данни, без нищо да го покаже. */
  const other = new Database(path.join(dir, 'library.db'));
  other.prepare("INSERT INTO books (title) VALUES ('От друга връзка')").run();
  other.close();
  s.catalogPayloadNow();
  assert.equal(s.builds.length, 3, 'промяна от друга връзка също прави товара невалиден');

  s.catalogPayloadNow();
  assert.equal(s.builds.length, 3, 'без промяна — без ново сглобяване');
  s.dropCatalogPayloadCache();
  s.catalogPayloadNow();
  assert.equal(s.builds.length, 4, 'scheduleCatalogWrite() изхвърля товара веднага — той вече не отговаря на базата и само държи памет');
  db.close();
});

test('товарът се сглобява на ЕДНО място и двете пътеки минават през него', () => {
  /* Коментарите се махат преди броенето — иначе обяснението „buildCatalogPayload()
     е 95 ms“ се брои за повикване (същата предпазливост като в
     test/build-files-coverage.test.js). */
  const code = MAIN_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const calls = (code.match(/(?<!function )buildCatalogPayload\(\)/g) || []).length;   // без самата декларация
  assert.equal(calls, 1, 'buildCatalogPayload() се вика точно веднъж в main.js — от catalogPayloadNow()');
  assert.match(code, /const payload = catalogPayloadNow\(\);/, 'автоматичният запис взима товара оттам');
  assert.match(code, /buildCatalogPayload: catalogPayloadNow/, 'и ръчното извеждане получава същия товар');
  // handlers/catalog.js няма СВОЯ заявка за каталога — ползва подадения товар.
  assert.doesNotMatch(CAT_SRC, /function buildCatalogPayload/);
  assert.match(CAT_SRC, /const payload = buildCatalogPayload\(\);/);
});

/* ==================================================================
   3. Сглобяването на текста: същият файл, проверка с постоянна цена
   ================================================================== */
// Старото сглобяване (v2.4.49), преписано ТУК само за сравнение на изхода.
function oldCatalogJsonText(payload) {
  const enc = (v) => JSON.stringify(v);
  const parts = [];
  for (const [k, v] of Object.entries(payload)) {
    if (Array.isArray(v)) {
      parts.push('  ' + enc(k) + ': [' + (v.length ? '\n' + v.map(x => '    ' + enc(x)).join(',\n') + '\n  ' : '') + ']');
    } else {
      parts.push('  ' + enc(k) + ': ' + enc(v));
    }
  }
  const text = '{\n' + parts.join(',\n') + '\n}\n';
  try {
    if (JSON.stringify(JSON.parse(text)) === JSON.stringify(payload)) return text;
  } catch (err) { /* пада към стария начин долу — както в оригинала */ }
  return JSON.stringify(payload, null, 2);
}
const catalogJsonText = (() => {
  const body = MAIN_SRC.match(/function catalogJsonText\(payload\) \{[\s\S]*?\n\}/)[0];
  return new Function('console', body + '; return catalogJsonText;')({ error() {} });
})();

test('текстът на katalog.json е БАЙТ ПО БАЙТ същият като с пълната стара проверка', () => {
  const nasty = {
    library: 'НЧ „Тест — 1900“ "х" \\ у', place: 'с. Яворец', generated: '2026-09-21',
    items: [
      { inv: 1, t: 'Приказки & легенди <избрано>', a: 'Вазов, Иван', n: 'ред1\nред2\tтаб "цитат"' },
      { inv: 2, t: '</script><img src=x onerror=alert(1)>', a: '😀', av: 1 },
      { inv: null, t: 'Без номер', av: 0 }
    ],
    shelves: [{ name: 'Нови книги', items: [1, 2] }]
  };
  assert.equal(catalogJsonText(nasty), oldCatalogJsonText(nasty));
  assert.equal(JSON.stringify(JSON.parse(catalogJsonText(nasty))), JSON.stringify(nasty),
    'и разчетен обратно дава точно същия обект');
  // празен и едноелементен масив — граничните случаи на умаленото копие
  for (const p of [{ library: 'Б', items: [] }, { library: 'Б', items: [{ inv: 7 }] },
    { library: 'Б', items: [{ inv: 7 }, { inv: 8 }] }]) {
    assert.equal(catalogJsonText(p), oldCatalogJsonText(p), JSON.stringify(p));
    JSON.parse(catalogJsonText(p));
  }
});

test('гаранцията, че файлът е валиден JSON, остава — но цената ѝ вече не расте с фонда', () => {
  /* 1) Стойност, която JSON.stringify не може да представи → старият начин. */
  const bad = { a: 1, u: undefined, items: [{ inv: 5 }] };
  assert.equal(catalogJsonText(bad), JSON.stringify(bad, null, 2));
  JSON.parse(catalogJsonText(bad));
  const badItem = { library: 'Б', items: [{ inv: 1 }, () => 1] };
  assert.equal(catalogJsonText(badItem), JSON.stringify(badItem, null, 2), 'и когато недобрата стойност е ЗАПИС в масива');
  JSON.parse(catalogJsonText(badItem));
  /* 1б) И КОГАТО НЕДОБРАТА СТОЙНОСТ Е В СРЕДАТА НА ДЪЛЪГ МАСИВ. Това е случаят,
     който умаленото копие по определение НЕ може да види: то носи само първия и
     последния запис. Затова стойностите се проверяват стойност по стойност, при
     самото сглобяване — без тази проверка на мястото на записа в текста застава
     голата дума „undefined“ и katalog.json престава да е валиден JSON, а при
     13 800 записа сгрешеният е някъде по средата в 13 798 случая от 13 800.
     (Мутация: махане на `if (t === undefined) return null;` в клона за масив.) */
  const middle = { library: 'Б', generated: '2026-09-21', items: [{ inv: 1 }, { inv: 2 }, undefined, { inv: 4 }, { inv: 5 }] };
  assert.equal(catalogJsonText(middle), JSON.stringify(middle, null, 2),
    'непредставима стойност в СРЕДАТА на масива трябва да падне към стария начин');
  JSON.parse(catalogJsonText(middle));
  const middleFn = { library: 'Б', items: [{ inv: 1 }, () => 1, { inv: 3 }, { inv: 4 }] };
  assert.equal(catalogJsonText(middleFn), JSON.stringify(middleFn, null, 2), 'същото и за функция в средата');
  JSON.parse(catalogJsonText(middleFn));
  /* BigInt хвърля от JSON.stringify — хваща се и се пада към стария начин, който
     хвърля същото; важното е да не се запише счупен файл. */
  assert.throws(() => catalogJsonText({ n: 1n, items: [] }), /BigInt/);

  /* 2) Проверката вече е върху УМАЛЕНО копие: това е постоянна цена, а не цена
     по размера на файла. Доказва се по големината на разчетеното — при 5 000
     записа проверката не бива да разчита 5 000. */
  const many = { library: 'Б', generated: '2026-09-21', items: [] };
  for (let i = 0; i < 5000; i++) many.items.push({ inv: i, t: 'Заглавие ' + i, av: i % 2 });
  const expected = oldCatalogJsonText(many);          // старият начин — извън наблюдението
  let parsed = 0;
  const realParse = JSON.parse;
  JSON.parse = function (text) { parsed = Math.max(parsed, (text.match(/\n/g) || []).length); return realParse.call(JSON, text); };
  let got;
  try { got = catalogJsonText(many); } finally { JSON.parse = realParse; }
  assert.equal(got, expected, '5 000 записа дават същия текст');
  assert.ok(parsed < 20, 'разчита се само умаленото копие (' + parsed + ' реда), а не целите 5 000');

  /* 3) И проверката наистина работи: счупена пунктуация се хваща и от умаленото
     копие, защото то минава през СЪЩОТО сглобяване. Мутацията се внася в текста
     на функцията, извлечен от main.js. */
  const body = MAIN_SRC.match(/function catalogJsonText\(payload\) \{[\s\S]*?\n\}/)[0];
  const broken = body.replace("parts.join(',\\n')", "parts.join(';\\n')");
  assert.notEqual(broken, body, 'мутацията е приложена');
  const brokenFn = new Function('console', broken + '; return catalogJsonText;')({ error() {} });
  const p = { library: 'Б', items: [{ inv: 1 }, { inv: 2 }, { inv: 3 }] };
  assert.equal(brokenFn(p), JSON.stringify(p, null, 2), 'счупената пунктуация се хваща и се пише по стария начин');

  /* 4) И ЗАПЕТАЯТА МЕЖДУ ЗАПИСИТЕ В МАСИВА — не само тази между ключовете.
     Умаленото копие трябва да носи ИСТИНСКИ записи (първия и последния), иначе
     точно тази ръчна пунктуация остава непроверена: с празни масиви probe е
     валиден JSON при всяка грешка вътре в реда и счупеният файл се записва.
     (Мутация: `probe[k] = Array.isArray(v) ? [] : v;`.) */
  const rowsBroken = body.replace("rows.join(',\\n')", "rows.join(';\\n')");
  assert.notEqual(rowsBroken, body, 'мутацията е приложена');
  const rowsBrokenFn = new Function('console', rowsBroken + '; return catalogJsonText;')({ error() {} });
  const big = { library: 'Б', generated: '2026-09-21', items: [] };
  for (let i = 0; i < 100; i++) big.items.push({ inv: i, t: 'Заглавие ' + i });
  assert.equal(rowsBrokenFn(big), JSON.stringify(big, null, 2),
    'счупената пунктуация МЕЖДУ записите трябва да се хване от умаленото копие и да падне към стария начин');
});

/* ==================================================================
   4. Съдържанието на публикувания каталог не се променя
   ================================================================== */
let app = null, appDb = null;
async function boot() {
  if (app) return app;
  app = startMainApp();
  await app.ready();
  appDb = new Database(path.join(app.userData, 'library.db'));
  const dir = path.join(app.dir, 'katalog');
  fs.mkdirSync(dir, { recursive: true });
  appDb.prepare('UPDATE settings SET catalog_folder = ?, lib_name = ?, place = ? WHERE id = 1')
    .run(dir, 'НЧ „Тест — 1922“', 'с. Яворец');
  const cat = appDb.prepare("SELECT id FROM categories WHERE name = 'книга'").get().id;
  const ins = appDb.prepare(`INSERT INTO books (inv_number, barcode, register_date, title, subtitle, author, category_id,
      year, volume, isbn, pages, language, udk, call_number, city, publisher, series, series_no, keywords, annotation,
      department, status, price) VALUES (@inv, @bc, @reg, @title, @sub, @author, @cat, @year, @vol, @isbn, @pages,
      @lang, @udk, @cn, @city, @pub, @ser, @serno, @kw, @ann, @dep, @status, @price)`);
  const insI = appDb.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)');
  const statuses = ['наличен', 'наличен', 'наличен', 'липсващ', 'за реставрация', 'отчислен'];
  appDb.transaction(() => {
    for (let i = 1; i <= 60; i++) {
      const id = ins.run({
        inv: i % 20 === 0 ? null : i, bc: i % 7 === 0 ? null : 'BC' + i, reg: '2026-0' + (1 + (i % 9)) + '-15',
        title: 'Заглавие & <' + i + '> "' + (i % 5 ? '' : '=SUM(A1)') + '"', sub: i % 3 ? null : 'Подзаглавие ' + i,
        author: i % 4 === 0 ? null : (i % 2 ? 'Вазов, Иван' : 'Елин Пелин'), cat, year: String(1950 + i),
        vol: i % 6 ? null : 'Т. ' + i, isbn: i % 5 ? '954-01-' + (1000 + i) : null, pages: i % 3 ? '200 с.' : null,
        lang: ['български', 'английски', 'японски', 'друг', null][i % 5], udk: i % 2 ? '886.7-1' : null,
        cn: 'Б/' + i, city: i % 3 ? 'София' : null, pub: 'Издателство "Свят"', ser: i % 8 ? null : 'Поредица',
        serno: i % 8 ? null : String(i), kw: i % 3 ? 'фолклор, приказки; легенди' : null,
        ann: i % 4 ? 'Анотация\nна два реда' : null, dep: i % 11 === 0 ? 'служебен' : 'за възрастни',
        status: statuses[i % statuses.length], price: (i % 9) * 1.5
      }).lastInsertRowid;
      insI.run(id, i % 10 === 0 ? 0 : (i % 13 === 0 ? 2 : 1));
    }
    appDb.prepare("INSERT INTO readers (name, card_no, category, status) VALUES ('Читател, Иван', '1', 'възрастен', 'активен')").run();
    const open = appDb.prepare("SELECT id FROM books WHERE status = 'наличен' LIMIT 5").all();
    for (const b of open) {
      appDb.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (1, ?, ?, ?)')
        .run(b.id, '2026-09-01', '2026-10-01');
    }
  })();
  return app;
}
test.after(() => { if (appDb) appDb.close(); if (app) app.stop(); });
const katalogFile = () => path.join(app.dir, 'katalog', 'katalog.json');

test('публикуваният каталог съдържа същото: същите документи, същите полета, същото правило за „налична“', async () => {
  await boot();
  const r = await app.invoke('catalog:writeNow');
  assert.equal(r.ok, true, r.error);
  const payload = JSON.parse(fs.readFileSync(katalogFile(), 'utf8'));

  /* Независима сметка по СУРОВИТЕ редове през BOOK_SELECT — старият път. */
  const full = appDb.prepare(`${BOOK_SELECT} WHERE b.status != 'отчислен'
    AND COALESCE(b.department,'') != 'служебен' ORDER BY b.title`).all();
  assert.ok(full.length > 30, 'предпоставка: има какво да се публикува');
  assert.equal(payload.items.length, full.length, 'същият брой публикувани документи');
  assert.ok(full.some(b => b.available <= 0) && full.some(b => b.available > 0), 'предпоставка: има и заети, и свободни');
  assert.ok(full.some(b => b.status === 'липсващ'), 'предпоставка: има и документ със статус, който не е „наличен“');
  assert.deepEqual(payload.items.map(i => i.t), full.map(b => b.title || ''), 'същата подредба и същите заглавия');
  for (let i = 0; i < full.length; i++) {
    const b = full[i], it = payload.items[i];
    assert.equal(it.av, (b.available > 0 && b.status === 'наличен') ? 1 : 0, 'налична: ' + b.title);
    assert.equal(it.inv, b.inv_number); assert.equal(it.a, b.author || ''); assert.equal(it.s, b.subtitle || '');
    assert.equal(it.c, b.city || ''); assert.equal(it.p, b.publisher || ''); assert.equal(it.y, b.year || '');
    assert.equal(it.u, b.udk || ''); assert.equal(it.g, b.call_number || ''); assert.equal(it.k, b.keywords || '');
    assert.equal(it.n, b.annotation || ''); assert.equal(it.d, b.register_date || '');
  }
  assert.equal(payload.library, 'НЧ „Тест — 1922“');
  assert.equal(payload.place, 'с. Яворец');
});

test('ръчното извеждане дава СЪЩИЯ файл като автоматичния запис — един товар за двете', async () => {
  await boot();
  assert.equal((await app.invoke('catalog:writeNow')).ok, true);
  const written = fs.readFileSync(katalogFile(), 'utf8');

  const out = path.join(app.dir, 'katalog-rachno.json');
  require('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
  assert.equal((await app.invoke('catalog:export')).ok, true);
  assert.equal(fs.readFileSync(out, 'utf8'), written, 'същият байт по байт файл — иначе изведеният в папката прави 4,8 МБ разлика в git');

  /* А промяна веднага след това се вижда: кешираният товар не бива да надживее
     нито една промяна в базата. */
  const b = appDb.prepare("SELECT id, title FROM books WHERE status = 'наличен' AND COALESCE(department,'') != 'служебен' ORDER BY title LIMIT 1").get();
  appDb.prepare('UPDATE books SET title = ? WHERE id = ?').run('Променено заглавие след запис', b.id);
  assert.equal((await app.invoke('catalog:export')).ok, true);
  const after = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(after.items.some(i => i.t === 'Променено заглавие след запис'), 'промяната влиза в изведения каталог');
  assert.ok(!after.items.some(i => i.t === b.title), 'а старото заглавие изчезва');
});

/* ==================================================================
   5. Износите: същите файлове с новата заявка
   ================================================================== */
const registerCatalogHandlers = require('../handlers/catalog');
const EXPORT_SELECT_SRC = (() => {
  const m = CAT_SRC.match(/const EXPORT_SELECT = `([\s\S]*?)`;/);
  assert.ok(m, 'handlers/catalog.js вече не съдържа EXPORT_SELECT');
  return m[1];
})();

function fakeIpcMain() {
  const handlers = new Map();
  return { handle: (c, fn) => handlers.set(c, fn), invoke: (c, ...a) => handlers.get(c)({}, ...a) };
}
/* Фикстура за износите: нарочно неудобни данни — кирилица, & < > " ', NULL
   полета, два документа БЕЗ инвентарен номер (проверява и подредбата при равни
   ключове), отчислени и служебни, заглавие-формула за CSV. */
function exportFixture() {
  const dir = mkTmpDir();
  const db = new Database(path.join(dir, 'library.db'));
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  db.prepare('UPDATE settings SET lib_name = ? WHERE id = 1').run('НЧ „Тест — 1900“');
  const cat = db.prepare('INSERT INTO categories (name) VALUES (?)').run('Художествена литература').lastInsertRowid;
  const ins = db.prepare(`INSERT INTO books (inv_number, barcode, register_date, title, subtitle, author, category_id,
      year, volume, isbn, pages, language, udk, call_number, city, publisher, series, series_no, keywords, annotation,
      department, status, price) VALUES (@inv, @bc, @reg, @title, @sub, @author, @cat, @year, @vol, @isbn, @pages,
      @lang, @udk, @cn, @city, @pub, @ser, @serno, @kw, @ann, @dep, @status, @price)`);
  const insI = db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)');
  db.prepare("INSERT INTO readers (name, card_no, category, status) VALUES ('Читател, Иван', '1', 'възрастен', 'активен')").run();
  const statuses = ['наличен', 'липсващ', 'за реставрация', 'отчислен', null];
  db.transaction(() => {
    for (let i = 1; i <= 40; i++) {
      const id = ins.run({
        inv: i > 38 ? null : i, bc: i % 7 === 0 ? null : 'BC' + i, reg: '2026-0' + (1 + (i % 9)) + '-15',
        title: i % 5 ? 'Приказки & легенди <' + i + '> "избрано"' : '=SUM(A1:A9)',
        sub: i % 3 ? null : '„Малкият“ том', author: i % 4 === 0 ? null : (i % 2 ? 'Вазов, Иван' : 'Омир'),
        cat: i % 6 ? cat : null, year: i % 3 ? String(1900 + i) : null, vol: i % 6 ? null : 'Т. ' + i,
        isbn: i % 5 ? '954-01-' + (1000 + i) : null, pages: i % 3 ? '312 с.' : null,
        lang: ['български', 'английски', 'японски', 'друг', null][i % 5],
        udk: i % 2 ? '886.7-1' : null, cn: i % 3 ? 'Б/Ваз' + i : null, city: i % 3 ? 'София' : null,
        pub: i % 4 ? 'Издателство "Свят"' : null, ser: i % 8 ? null : 'Поредица', serno: i % 8 ? null : String(i),
        kw: i % 3 ? 'фолклор, приказки; легенди' : null,
        ann: i % 4 ? 'Ред 1\nРед 2' + String.fromCharCode(1) : null,
        dep: i % 9 === 0 ? 'служебен' : 'Заемна', status: statuses[i % statuses.length], price: (i % 9) * 2.45
      }).lastInsertRowid;
      const qty = i % 10 === 0 ? 0 : (i % 13 === 0 ? 2 : 1);
      insI.run(id, qty);
      if (i % 6 === 0 && qty > 0) {
        db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (1, ?, ?, ?)')
          .run(id, '2026-09-01', '2026-10-01');
      }
    }
  })();
  return { dir, db };
}
/* Двата варианта на ЕДНАТА продукционна регистрация: „както е“ и „с BOOK_SELECT
   на мястото на изброената проекция“ (както беше до v2.4.63). Подменя се само
   текстът на заявката — обработчиците, шаблоните и записвачите са едни и същи. */
function exportHandlers(db, dir, { old = false } = {}) {
  const rewrites = { n: 0 };
  const proxy = {
    prepare: (sql) => {
      if (old && sql.includes(EXPORT_SELECT_SRC)) { rewrites.n++; sql = sql.replace(EXPORT_SELECT_SRC, BOOK_SELECT); }
      return db.prepare(sql);
    }
  };
  const ipcMain = fakeIpcMain();
  const ctx = { savePath: null };
  registerCatalogHandlers(ipcMain, {
    getDb: () => proxy,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: () => {},
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: ctx.savePath }) },
    getMainWindow: () => ({}), fs, path, execFile: (c, a, o, cb) => cb(null, '', ''),
    csvCell, flushCatalogWrite: () => ({ written: true }),
    catalogJsonText, buildCatalogPayload: () => ({ library: 'Б', items: [] })
  });
  return {
    rewrites,
    run: async (channel, name) => {
      ctx.savePath = path.join(dir, name);
      const res = await ipcMain.invoke(channel);
      assert.equal(res.ok, true, channel + ': ' + (res.error || ''));
      return { bytes: fs.readFileSync(ctx.savePath), data: res.data };
    }
  };
}

test('UNIMARC, Dublin Core и CSV излизат БАЙТ ПО БАЙТ същите с леката заявка', async () => {
  const { dir, db } = exportFixture();
  const now = exportHandlers(db, dir);
  const before = exportHandlers(db, dir, { old: true });
  for (const [channel, name] of [['catalog:exportMarc', 'marc'], ['catalog:exportDc', 'dc'], ['catalog:exportCsv', 'csv']]) {
    const a = await now.run(channel, name + '-nov.out');
    const b = await before.run(channel, name + '-star.out');
    assert.ok(a.bytes.length > 500, channel + ': файлът не е празен');
    assert.deepEqual(a.bytes, b.bytes, channel + ': изнесеният файл трябва да е дословно същият както с BOOK_SELECT');
  }
  assert.equal(before.rewrites.n, 3, 'и трите износа наистина минаха през подменената заявка (иначе тестът сравнява сам със себе си)');
  // Броят записи в потвърждението пред библиотекаря също не се променя.
  const m = await now.run('catalog:exportMarc', 'marc-2.out');
  const mOld = await before.run('catalog:exportMarc', 'marc-2-star.out');
  assert.deepEqual({ count: m.data.count, excluded: m.data.excluded },
    { count: mOld.data.count, excluded: mOld.data.excluded }, 'същият брой записи и същият брой пропуснати');
  assert.ok(m.data.count > 20 && m.data.excluded > 0, 'предпоставка: има и изнесени, и пропуснати документи');
  db.close();
});

test('UNIMARC и Dublin Core изнасят фонда без отчислените, а CSV — целия фонд', async () => {
  /* ЗАЩО ТОЗИ ТЕСТ СЪЩЕСТВУВА ОТДЕЛНО. До v2.4.63 условието стоеше в самата
     заявка (`${BOOK_SELECT} ${EXPORT_WHERE}`), а CSV-то нарочно ползваше ДРУГА
     заявка без него. От v2.4.64 exportBooksFor(where) приема условието отвън —
     тоест обхватът на всеки от трите файла вече е решение на ПОВИКВАЩИЯ и може
     да се размени по невнимание. Байт-по-байт сравнението по-горе НЕ го пази:
     то подменя само текста на заявката, а повикващият е един и същ и в двата
     варианта.
     Разликата е смислова: UNIMARC и Dublin Core пътуват към чужда система и не
     бива да ѝ предлагат отчислени документи и служебния отдел; CSV-то е пълният
     опис за Excel и точно отчислените в него правят сбора на стойността верен. */
  const { dir, db } = exportFixture();
  const h = exportHandlers(db, dir);
  const all = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
  const publishable = db.prepare(`SELECT COUNT(*) AS n FROM books b
    WHERE COALESCE(b.status,'') != 'отчислен' AND COALESCE(b.department,'') != 'служебен'`).get().n;
  const gone = db.prepare("SELECT COUNT(*) AS n FROM books WHERE status = 'отчислен'").get().n;
  assert.ok(all > publishable && gone > 0, 'предпоставка: фикстурата има отчислени и служебни документи');

  const marc = await h.run('catalog:exportMarc', 'obhvat-marc.xml');
  assert.equal(marc.data.count, publishable, 'UNIMARC изнася само публикуемите документи');
  assert.equal(marc.data.excluded, all - publishable, 'и казва колко е пропуснал');
  const dc = await h.run('catalog:exportDc', 'obhvat-dc.xml');
  assert.equal(dc.data.count, publishable, 'Dublin Core — същият обхват');

  const csv = (await h.run('catalog:exportCsv', 'obhvat.csv')).bytes.toString('utf8');
  assert.equal((csv.match(/;"отчислен"(\r\n|$)/g) || []).length, gone,
    'CSV-то изнася ЦЕЛИЯ фонд, включително отчислените — иначе сборът на цените в Excel занижава стойността му');
  db.close();
});

test('заявката за износ е изброена проекция с агрегат — без b.* и без подзаявка на ред', () => {
  assert.doesNotMatch(EXPORT_SELECT_SRC, /\bb\.\*/, 'без `b.*`: 38 колони при 24 нужни са 10,60 МБ срещу 7,05 МБ в паметта');
  assert.match(EXPORT_SELECT_SRC, /SELECT b\.id, b\.inv_number, b\.barcode/, 'колоните са изброени');
  assert.match(EXPORT_SELECT_SRC,
    /LEFT JOIN \(SELECT book_id, COUNT\(\*\) AS n FROM loans WHERE date_in IS NULL GROUP BY book_id\)/,
    'отворените заемания се броят с ЕДИН агрегат, както в buildCatalogPayload (v2.4.31)');
  assert.doesNotMatch(EXPORT_SELECT_SRC, /SELECT COUNT\(\*\) FROM loans l WHERE l\.book_id = b\.id/,
    'никаква корелирана подзаявка на ред');
  /* И в целия модул на каталога не бива да е останала такава подзаявка в заявка,
     която се изпълнява върху ЦЕЛИЯ фонд. */
  assert.doesNotMatch(CAT_SRC, /\$\{BOOK_SELECT\}/, 'нито един износ вече не минава през BOOK_SELECT');

  /* Планът го потвърждава и в базата: при BOOK_SELECT SQLite изпълнява
     подзаявката за всеки ред („CORRELATED SCALAR SUBQUERY“), при новата — не. */
  const { db } = exportFixture();
  const plan = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(r => r.detail).join(' | ');
  const where = `WHERE COALESCE(b.status,'') != 'отчислен' AND COALESCE(b.department,'') != 'служебен'`;
  assert.match(plan(`${BOOK_SELECT} ${where} ORDER BY b.inv_number`), /CORRELATED SCALAR SUBQUERY/);
  assert.doesNotMatch(plan(`${EXPORT_SELECT_SRC} ${where} ORDER BY b.inv_number`), /CORRELATED SCALAR SUBQUERY/);
  db.close();
});

/* ==================================================================
   6. Груб предпазител по време
   ==================================================================
   ЧЕСТНО: прагът НЕ лови връщането назад — при 40 документа и старият код
   минава под него, а на натоварена машина и новият може да го докосне.
   Истинските прегради са проверките по устройство по-горе. Тук е само
   „нещо драстично се е случило“ (напр. заявка, която се изпълнява по веднъж
   на ред при всеки износ). */
test('износът на малък фонд не отнема секунди', async () => {
  const { dir, db } = exportFixture();
  const h = exportHandlers(db, dir);
  const t0 = Date.now();
  await h.run('catalog:exportMarc', 'marc-vreme.out');
  await h.run('catalog:exportDc', 'dc-vreme.out');
  await h.run('catalog:exportCsv', 'csv-vreme.out');
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, 'трите износа на 40 документа: ' + ms + ' ms');
  db.close();
});
