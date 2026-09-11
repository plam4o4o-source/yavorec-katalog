'use strict';
/* Преглед v2.4.55 — двата пропуска, намерени при собствената мутационна
   проверка на v2.4.54 (документите, които програмата издава).
   =====================================================================
   И двете са пропуски В ТЕСТОВЕТЕ, не в реалния код на v2.4.54 — проверих
   директно: кодът в патча е верен. Проблемът е, че мутация в него можеше да
   мине незабелязана от целия тестов пакет:

     1. dnevnikPrintPages() (src/views/dnevnik.js) няма защита срещу ЕДНА
        група, по-широка от тавана на листа (DNEVNIK_PRINT_MAX_COLS = 20).
        Днес нито една действителна група не стига 20 (най-широката е 18,
        „По съдържание (УДК)“ в Раздел Б) — затова не е достижимо В МОМЕНТА.
        Но нищо в кода не пречи на бъдеща по-широка група да пробие тавана
        тихо: разделянето не режe групи по средата (нарочно — „Всичко“ трябва
        да стои до разбивката си), затова единственото коректно поведение
        при свръхширока група си остава да ѝ се даде собствен, по-широк лист
        — не грешка, а съзнателна отстъпка. Тук се заковават И двете: че
        днешните групи имат резерв под тавана (тестова опъвка — регресия при
        добавяне на нова, по-широка група пада ВЕДНАГА, при писането ѝ, а не
        при следващото измерване на разпечатан лист), и че самото поведение
        при пробив е графично деградиращо, не чупещо (групата не изчезва и
        не се реже — просто листът ѝ излиза по-широк от нормалното).

     2. test/docs-v2454.test.js провери деликатно преброяването на отказаните
        резервации при анулиране на акт — но и в трите нови фикстури книгата и
        актът се озовават със ЕДИН И СЪЩ rowid (случайно съвпадение: и двете
        таблици са свежи, а книгата и актът там се вмъкват на едно и също
        поредно място). Мутация, която размества параметрите `act`/`book` в
        `cancelHolds.run({ act, book })` (handlers/deaccession-acts.js), минава
        НЕЗАСЕЧЕНА от всичките 16 теста — не защото кодът е верен по принцип,
        а защото размяната на две равни числа не променя нищо. Проверено
        директно (извън тестовете, преди тази поправка): при книга и акт с
        РАЗЛИЧНИ id-та размяната кара резервацията да НЕ се отказва изобщо —
        читателят остава на опашка за книга, която току-що е отчислена.
        Тук фикстурата вмъква достатъчно редове предварително, за да гарантира
        различни id-та, и заключва точно тази разлика. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, fakeIpcMain, runDep, cleanupTmpDirs, APP_DIR } = require('./helpers/audit-fixtures');

const DNEVNIK_JS = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'dnevnik.js'), 'utf8');

test.after(cleanupTmpDirs);

/* ------------------------------------------------------------------
   1. Свръхширока група в разделянето по листове
   ------------------------------------------------------------------ */

function loadDnevnikHelpers() {
  const sandbox = { esc: (s) => String(s) };
  const src = DNEVNIK_JS.slice(0, DNEVNIK_JS.indexOf('const DNEVNIK_ALL_FIELDS'));
  // eslint-disable-next-line no-new-func
  new Function('module', 'esc', src + `
    module.exports = { dnevnikPrintPages, DNEVNIK_A_GROUPS, DNEVNIK_B_GROUPS, DNEVNIK_PRINT_MAX_COLS };
  `)(sandbox, sandbox.esc);
  return sandbox.exports;
}

test('нито една действителна колонна група не доближава тавана на листа (регресионна опъвка)', () => {
  /* Ако утре някой добави по-широка група — например разбие „По занятие“ на
     повече подкатегории — този тест пада при ПИСАНЕТО на промяната, не при
     следващото измерване на разпечатан лист. Резервът не е случаен: тестът
     не изисква равенство, а СТРОГО под тавана, за да остане предупреждение,
     не гонка до самата граница. */
  const H = loadDnevnikHelpers();
  for (const [name, groups] of [['А', H.DNEVNIK_A_GROUPS], ['Б', H.DNEVNIK_B_GROUPS]]) {
    for (const [label, n] of groups) {
      assert.ok(n < H.DNEVNIK_PRINT_MAX_COLS,
        `Раздел ${name}, група „${label}“: ${n} колони — доближава тавана от ${H.DNEVNIK_PRINT_MAX_COLS}`);
    }
  }
});

test('свръхширока група получава собствен, по-широк лист — не изчезва и не се реже (документирано поведение)', () => {
  /* Синтетичен пример, различен от действителните данни на InvLib, за да
     провери самия механизъм, не днешните групи. dnevnikPrintPages() НЕ бива
     да реже група по средата (нарочно, виж бележката горе) — единственото
     коректно поведение е групата да излезе на собствен лист, дори по-широк
     от тавана, вместо да се загуби или да чупи изпълнението. */
  const H = loadDnevnikHelpers();
  const cols = Array.from({ length: 25 }, (_, i) => ['c' + i, 'Колона ' + i]);
  const groups = [['Малка', 3], ['Свръхширока', 25 - 3]];
  const pages = H.dnevnikPrintPages(cols, groups, 20);
  const flat = pages.flatMap((p) => p.cols);
  assert.deepEqual(flat.map((c) => c[0]), cols.map((c) => c[0]),
    'нито една колона не изчезва и не се повтаря дори при пробив на тавана');
  const bigPage = pages.find((p) => p.groups.some(([l]) => l === 'Свръхширока'));
  assert.ok(bigPage, 'свръхшироката група трябва да излезе на някой лист');
  assert.equal(bigPage.cols.length, 22, 'групата излиза ЦЯЛА на своя лист, не срязана до тавана');
  assert.equal(bigPage.groups.length, 1,
    'свръхширока група получава лист само за себе си, без да тегли съседна група със себе си');
});

/* ------------------------------------------------------------------
   2. Анулиране на акт при РАЗЛИЧНИ id-та на книга и акт
   ------------------------------------------------------------------ */

function deaccSetup() {
  const { db } = freshDb('inv-docs-2455-');
  const ipc = fakeIpcMain();
  const audit = [];
  require(path.join(APP_DIR, 'handlers', 'deaccession-acts.js'))(ipc, {
    getDb: () => db,
    run: runDep,
    logAudit: (a, d) => audit.push({ a, d }),
    BOOK_SELECT: 'SELECT b.*, COALESCE(i.quantity,0) AS quantity FROM books b LEFT JOIN inventory i ON i.book_id = b.id',
    yearOf: (d) => Number(String(d).slice(0, 4)),
    scheduleCatalogWrite: () => {},
    flushCatalogWrite: () => {},
    normalizeScanCode: (s) => String(s || '').trim()
  });
  return { db, ipc, audit };
}

function insertDummyBook(db, n) {
  const bid = db.prepare(`INSERT INTO books (inv_number, title, price, register_date, status, language)
    VALUES (?, ?, 1, '2026-01-01', 'наличен', 'български')`).run(9000 + n, 'Запълваща ' + n).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bid);
  return bid;
}

test('резервацията се отказва правилно дори когато книгата и актът имат РАЗЛИЧНИ id-та', () => {
  /* Ядрото на находката: пет запълващи книги вмъкнати ПРЕДИ истинската —
     book_id на истинската книга ще е поне 6, докато първият истински акт в
     тази свежа база пак ще е id 1. Числата гарантирано се разминават, за
     разлика от фикстурите в docs-v2454.test.js, където книгата и актът се
     озовават случайно с еднакъв номер. Мутация, която размества параметрите
     `act`/`book` в cancelHolds.run(...), тук би оставила резервацията
     НЕотказана — точно това се заключва. */
  const { db, ipc, audit } = deaccSetup();
  for (let i = 1; i <= 5; i++) insertDummyBook(db, i);
  const bid = db.prepare(`INSERT INTO books (inv_number, title, price, register_date, status, language)
    VALUES (4500, 'Резервирана (различни id-та)', 5, '2026-01-01', 'наличен', 'български')`).run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bid);
  const rid = db.prepare(`INSERT INTO readers (name, card_no, category, registered_at)
    VALUES ('Читателка', 'K-9', 'възрастен', '2026-01-01')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?,?,'чака',datetime('now'))`).run(bid, rid);

  const created = ipc.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-06-01', reason_code: 6, reason_text: 'невърнати от ползватели' },
    bookIds: [bid]
  });
  assert.ok(created.ok, created.error);
  assert.notEqual(bid, created.data, 'фикстурата трябва да гарантира различни id-та на книга и акт');

  const h1 = db.prepare('SELECT status, deaccession_act_id, status_before FROM holds WHERE book_id=?').get(bid);
  assert.equal(h1.status, 'отказана',
    'резервацията трябва да е отказана дори когато book_id != act_id — размяна на параметрите би я оставила "чака"');
  assert.equal(h1.deaccession_act_id, created.data, 'записаният акт трябва да е ИСТИНСКИЯТ act_id, не book_id');
  assert.equal(h1.status_before, 'чака');

  const revoked = ipc.invoke('deaccessionActs:revoke', created.data);
  assert.ok(revoked.ok, revoked.error);
  assert.equal(revoked.data.droppedHolds, 1, 'анулирането трябва да преброи точно тази резервация');
  assert.equal(db.prepare('SELECT status FROM holds WHERE book_id=?').get(bid).status, 'отказана',
    'анулирането не я възкресява — нарочно, от по-ранен кръг');
  const line = audit.find((x) => x.a === 'Анулиране на акт');
  assert.match(line.d, /ОСТАВА отказана/);
});
