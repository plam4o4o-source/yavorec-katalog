'use strict';
/* v2.4.52 — тридесет и девети кръг: таблото.
   =====================================================================
   Трите неща тук са намерени с ИЗМЕРВАНЕ на таблото в истински прозорец срещу
   истинска база (13 349 документа, 400 заети, 240 просрочени, 160 предстоящи
   връщания), а не с четене на кода:

     1. таблото ставаше 9 830 px високо при екран от 768 — над девет екрана
        превъртане — защото списъкът с предстоящите връщания нямаше лимит,
        за разлика от просрочените точно до него;
     2. „240 просрочени“ не казва какво да се направи; „над 30 дни — 80“ казва;
     3. изискването по чл. 40 (единственото със срок 31 декември) стоеше на
        2 500 px надолу като „0 / 1465“ и празна лента.

   Тестовете държат ТОЧНО тези три неща, плюс подредбата, която ги побира.
   Всеки тест е проверен с мутация. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { APP_DIR, cleanupTmpDirs, buildDom, settle } = require('./helpers/audit-fixtures');
const { startMainApp } = require('./helpers/main-app');

test.after(cleanupTmpDirs);

const iso = (d) => d.toISOString().slice(0, 10);
const dayOff = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
const CSS = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');

/* ---------------- истинското приложение върху засята база ---------------- */
let app = null, db = null;
test.after(() => { if (db) db.close(); if (app) app.stop(); });

async function boot() {
  if (app) return app;
  app = startMainApp();
  await app.ready();
  db = new Database(path.join(app.userData, 'library.db'));
  const insB = db.prepare(`INSERT INTO books (inv_number, title, author, status, price, register_date)
    VALUES (?, ?, ?, 'наличен', 1, ?)`);
  const insI = db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)');
  const insR = db.prepare("INSERT INTO readers (name, card_no, status, gdpr_consent, registered_at) VALUES (?,?,'активен',1,?)");
  const insL = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in, fine) VALUES (?,?,?,?,?,0)');
  db.transaction(() => {
    for (let i = 1; i <= 400; i++) { insI.run(insB.run(i, 'Книга ' + i, 'Автор ' + (i % 20), dayOff(500)).lastInsertRowid); }
    for (let i = 1; i <= 60; i++) insR.run('Читател ' + i, String(9000 + i), dayOff(200));
    let b = 1;
    /* Предстоящи връщания: 9 днес, 5 утре, 2 вдругиден — нарочно НЕРАВНИ, за да
       личи дали броят по ден е верен, а не просто „поравно“. */
    for (const [ahead, n] of [[0, 9], [1, 5], [2, 2]]) {
      for (let i = 0; i < n; i++) insL.run(1 + (i % 60), b++, dayOff(10), dayOff(-ahead), null);
    }
    /* Просрочени: нарочно и ГРАНИЧНИ — 6 и 7 дни (последните в първата група),
       8 и 30 (първият и последният от втората), 31 и 55 (третата). Без тях
       преместването на границата от 7 на 14 дни не променя нито едно число и
       тестът минава, каквато и да е границата. */
    for (const [late, n] of [[3, 2], [6, 1], [7, 1], [8, 2], [20, 4], [30, 1], [31, 1], [55, 2]]) {
      for (let i = 0; i < n; i++) insL.run(1 + (i % 60), b++, dayOff(late + 30), dayOff(late), null);
    }
    // Върнати заемания за микрографиката: по дни в последните 84.
    for (const [daysAgo, n] of [[2, 6], [9, 4], [30, 5], [83, 3], [200, 11]]) {
      for (let i = 0; i < n; i++) insL.run(1 + (i % 60), b++, dayOff(daysAgo), dayOff(daysAgo - 30), dayOff(1));
    }
  })();
  return app;
}

/* ==================================================================
   1. Списъкът с предстоящи връщания е ПРОЗОРЕЦ, а броячите са точни
   ================================================================== */

test('предстоящите връщания се връщат на порция, но броят — общият и по дни — е точен', async () => {
  await boot();
  const d = (await app.invoke('dashboard:full')).data;

  /* Независимо изчисление върху суровите редове — същото условие, но преброено тук. */
  const raw = db.prepare(`SELECT date_due AS d, COUNT(*) AS n FROM loans
    WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due >= date('now')
      AND julianday(date_due) - julianday('now') <= 3
    GROUP BY date_due ORDER BY date_due`).all();
  const total = raw.reduce((s, r) => s + r.n, 0);
  assert.equal(total, 16, 'фикстурата дава 9 + 5 + 2 предстоящи');

  assert.equal(d.upcomingCount, total, 'общият брой трябва да е ВСИЧКИ, не показаните');
  assert.deepEqual(d.upcomingByDay.map(x => [x.date, x.n]), raw.map(x => [x.d, x.n]),
    'броят по ден идва от базата и съвпада с независимото преброяване');
  assert.ok(d.upcoming.length <= 40, 'списъкът е прозорец, а не целият фонд от предстоящи');
  assert.ok(d.upcoming.length > 0);
  assert.ok(d.upcoming.every(l => l.date_due >= d.upcoming[0].date_due), 'подредени по срок');
});

test('лимитът наистина реже — при повече предстоящи от прозореца списъкът спира, а броячът не', async () => {
  await boot();
  const before = (await app.invoke('dashboard:full')).data;
  const insB = db.prepare(`INSERT INTO books (inv_number, title, status, price, register_date)
    VALUES (?, ?, 'наличен', 1, ?)`);
  const insI = db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)');
  const insL = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in, fine) VALUES (?,?,?,?,NULL,0)');
  db.transaction(() => {
    for (let i = 0; i < 60; i++) {
      const id = insB.run(5000 + i, 'Допълнителна ' + i, dayOff(400)).lastInsertRowid;
      insI.run(id);
      insL.run(1 + (i % 60), id, dayOff(10), dayOff(0));
    }
  })();
  const after = (await app.invoke('dashboard:full')).data;
  assert.equal(after.upcomingCount, before.upcomingCount + 60, 'броячът вижда всички');
  assert.equal(after.upcoming.length, 40, 'списъкът спира на прозореца');
  assert.ok(after.upcoming.length < after.upcomingCount, 'точно това е случаят, който чупеше таблото');
  // връща фикстурата в изходно състояние за следващите тестове
  db.prepare('DELETE FROM loans WHERE book_id IN (SELECT id FROM books WHERE inv_number >= 5000)').run();
  db.prepare('DELETE FROM inventory WHERE book_id IN (SELECT id FROM books WHERE inv_number >= 5000)').run();
  db.prepare('DELETE FROM books WHERE inv_number >= 5000').run();
});

/* ==================================================================
   2. Просрочията по тежест и заеманията по седмици
   ================================================================== */

test('просрочията се разделят на три взаимно изключващи се групи, които се събират до общия брой', async () => {
  await boot();
  const d = (await app.invoke('dashboard:full')).data;
  const b = d.overdueBuckets;
  const indep = db.prepare(`SELECT
      SUM(CASE WHEN julianday(date('now')) - julianday(date_due) <= 7 THEN 1 ELSE 0 END) AS d7,
      SUM(CASE WHEN julianday(date('now')) - julianday(date_due) > 7
                AND julianday(date('now')) - julianday(date_due) <= 30 THEN 1 ELSE 0 END) AS d30,
      SUM(CASE WHEN julianday(date('now')) - julianday(date_due) > 30 THEN 1 ELSE 0 END) AS more
    FROM loans WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')`).get();
  assert.deepEqual([b.d7, b.d30, b.more], [indep.d7, indep.d30, indep.more]);
  /* ПОПРАВЕНО В v2.4.54 — тук стоеше [3, 7, 4] и обяснение, че така е вярно.
     Не е. julianday('now') носи и ЧАСА, затова срок отпреди точно 7 дни даваше
     7,6 дни разлика и попадаше в групата „8–30 дни“ — група, чийто етикет
     твърди, че закъснението е поне осем дни. Просрочие от точно 7 дни е 7 дни,
     не 8; същото и на границите 30 и 60. Освен това касата брои ЦЕЛИ дни
     (effectiveDaysLate в handlers/loans.js), тоест таблото и касата даваха два
     различни отговора за един и същи заем. date('now') маха часа и двете вече
     съвпадат. Сега [4, 7, 3]: заемът точно на 7 дни е в първата група. */
  assert.deepEqual([b.d7, b.d30, b.more], [4, 7, 3],
    'фикстурата дава точно тези три групи, при това с попадения на самите граници');
  // Границата се проверява и поотделно, не само през общата сума: заем с падеж
  // отпреди РОВНО 7 дни трябва да е в „до 7 дни“, независимо в колко часа
  // библиотекарката е отворила таблото.
  const exactly7 = db.prepare(`SELECT COUNT(*) AS n FROM loans
    WHERE date_in IS NULL AND date_due = date('now','-7 days')`).get().n;
  assert.ok(exactly7 > 0, 'фикстурата трябва да съдържа заем точно на границата');
  assert.equal(b.d7 + b.d30 + b.more, d.overdueCount,
    'трите групи трябва да се събират до общия брой — иначе показателят си противоречи');
});

test('заеманията по седмици са дванайсет числа и последното е текущата седмица', async () => {
  await boot();
  const d = (await app.invoke('dashboard:full')).data;
  assert.equal(d.loansWeeks.length, 12);
  assert.ok(d.loansWeeks.every(n => Number.isInteger(n) && n >= 0), 'само цели неотрицателни числа');
  const last7 = db.prepare(`SELECT COUNT(*) AS n FROM loans
    WHERE date_out >= date('now','-7 days') AND date_out <= date('now')`).get().n;
  assert.equal(d.loansWeeks[11], last7, 'последното число е последните седем дни');
  const total84 = db.prepare(`SELECT COUNT(*) AS n FROM loans
    WHERE date_out >= date('now','-84 days') AND date_out <= date('now')`).get().n;
  assert.equal(d.loansWeeks.reduce((s, n) => s + n, 0), total84,
    'сборът на дванайсетте седмици е броят заемания за 84 дни');
  // Заемане отпреди 200 дни НЕ бива да влиза никъде в редицата.
  assert.ok(total84 < db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 'фикстурата има и по-стари заемания');
});

/* ==================================================================
   3. Екранът
   ================================================================== */

const DASH = (over) => Object.assign({
  fundCount: 1000, fundValue: 500, loansOpen: 12, activeReaders: 40,
  overdueCount: 14, overdueBuckets: { d7: 4, d30: 7, more: 3 },
  overdueRows: [], loansWeeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 17],
  upcoming: [], upcomingCount: 0, upcomingByDay: [],
  holdsReady: 0, holdsWaiting: 0, year: 2026,
  acquiredYear: 0, deaccessionedYear: 0, loansYear: 0, readersYear: 0,
  inventoryScannedYear: 0, inventoryTarget: 1000, inventoryPct: 10,
  today: { dueReminders: 0, reregDue: 0, longOverdue: 0, dnevnikFilled: true, isTodayOpen: true }
}, over || {});

/* ПРОЗОРЕЦЪТ Е ПО-МАЛЪК ОТ ОБЩИЯ БРОЙ — точно случаят, заради който кръгът
   съществува. Действителните връщания са 9 + 5 + 2 = 16, а обработчикът е върнал
   само 8 реда (по 4 за първите два дни, нито един за третия). Ако фикстурата дава
   толкова редове, колкото е броячът, тестът не различава двете числа и минава дори
   когато изгледът брои показаните вместо всички. */
function upcomingFixture() {
  const t = new Date();
  const day = (n) => { const d = new Date(t); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push({ id: i + 1, title: 'Днешна ' + i, reader_name: 'Читател ' + i, date_due: day(0) });
  for (let i = 0; i < 4; i++) rows.push({ id: 100 + i, title: 'Утрешна ' + i, reader_name: 'Читател ' + i, date_due: day(1) });
  return { rows, byDay: [{ date: day(0), n: 9 }, { date: day(1), n: 5 }, { date: day(2), n: 2 }] };
}

async function renderDashDom(data) {
  const dom = buildDom({ 'dashboard.full': data, 'settings.get': {} });
  await settle();
  await dom.window.renderDash();
  await settle();
  return dom.window.document;
}

test('картата с предстоящите връщания показва шест реда, но обявява ВСИЧКИ дни с точния им брой', async () => {
  const f = upcomingFixture();
  const d = await renderDashDom(DASH({ upcoming: f.rows, upcomingCount: 16, upcomingByDay: f.byDay }));
  const card = [...d.querySelectorAll('#view .card')].find(c => /Предстоящи връщания/.test(c.textContent));
  assert.ok(card, 'липсва картата');
  assert.equal(card.querySelectorAll('.upRow2').length, 6,
    'най-много шест реда — това е поправката (подадени са осем)');
  const days = [...card.querySelectorAll('.upDay')];
  assert.equal(days.length, 3,
    'и трите дни се обявяват — включително третият, за който изобщо няма подадени редове');
  assert.deepEqual(days.map(x => x.querySelector('.upDayN').textContent), ['9', '5', '2'],
    'броят до всеки ден е ДЕЙСТВИТЕЛНИЯТ, не броят показани редове');
  assert.equal(days[0].querySelector('.upDayName').textContent, 'Днес');
  assert.equal(days[1].querySelector('.upDayName').textContent, 'Утре');
  const more = card.querySelector('.upMore');
  assert.ok(more, 'липсва бутонът за останалите');
  assert.match(more.textContent, /още 10 документа/, '16 ДЕЙСТВИТЕЛНИ минус 6 показани');
  // Датата вече не е най-едрото на реда — тя изобщо не стои на реда.
  assert.equal(card.querySelectorAll('.upRow2 .num').length, 0);
});

test('показателят „Връщания до 3 дни“ носи ОБЩИЯ брой, а „За днес“ вече не го повтаря', async () => {
  const f = upcomingFixture();
  const d = await renderDashDom(DASH({ upcoming: f.rows, upcomingCount: 16, upcomingByDay: f.byDay }));
  const k = [...d.querySelectorAll('#view .kpi')].find(x => /Връщания до 3 дни/.test(x.textContent));
  assert.ok(k, 'липсва показателят');
  assert.equal(k.querySelector('.kpi-num').textContent, '16',
    'показателят трябва да брои всички, а не колкото са влезли в прозореца');
  const today = [...d.querySelectorAll('#view .card')].find(c => /^За днес/.test((c.querySelector('h3') || {}).textContent || ''));
  assert.ok(today, 'липсва картата „За днес“');
  assert.doesNotMatch(today.textContent, /Връщания до 3 дни/,
    'едно и също число стоеше на три места в един екран');
});

test('просроченият показател носи разбивката по дни забава — и като числа, и за екранния четец', async () => {
  const d = await renderDashDom(DASH());
  const k = [...d.querySelectorAll('#view .kpi')].find(x => /Просрочени/.test(x.textContent));
  const bar = k.querySelector('.sevBar');
  assert.ok(bar, 'липсва лентата по тежест');
  assert.equal(bar.getAttribute('role'), 'img');
  assert.match(bar.getAttribute('aria-label'), /до 7 дни — 4.*8 до 30 дни — 7.*над 30 дни — 3/,
    'числата трябва да ги има и за екранния четец, не само като цветове');
  const widths = [...bar.querySelectorAll('span')].map(s => s.style.width);
  assert.equal(widths.length, 3);
  const sum = widths.reduce((s, w) => s + parseFloat(w), 0);
  assert.ok(Math.abs(sum - 100) < 0.05, 'трите дяла запълват лентата: ' + widths.join(' + '));
  assert.match(k.querySelector('.sevLeg').textContent, /до 7 дни 4/);
  assert.match(k.querySelector('.sevLeg').textContent, /над 30 3/);
});

test('показателят за заетите носи микрографика с текстово съответствие', async () => {
  const d = await renderDashDom(DASH());
  const k = [...d.querySelectorAll('#view .kpi')].find(x => /Заети в момента/.test(x.textContent));
  const svg = k.querySelector('svg.spark');
  assert.ok(svg, 'липсва микрографиката');
  assert.equal(svg.querySelectorAll('rect').length, 12, 'дванайсет седмици');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.match(svg.getAttribute('aria-label'), /1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 17/,
    'самите числа стоят в описанието');
  assert.match(k.querySelector('.kpiFoot').textContent, /17 заемания тази седмица/,
    'последната седмица се казва и с думи');
  /* Мащабът е спрямо НАЙ-ГОЛЯМАТА стойност в редицата, а не спрямо кръгло число:
     иначе при тиха седмица всички стълбчета са една черта и графиката не казва нищо.
     17 е най-голямото → неговото стълбче е пълната височина; 8 (към средата) е
     около половината от нея. */
  const hs = [...svg.querySelectorAll('rect')].map(r => Number(r.getAttribute('height')));
  assert.equal(hs[11], 20, 'най-голямата стойност заема цялата височина');
  assert.equal(Math.max(...hs), hs[11]);
  assert.equal(hs[7], Math.round(8 / 17 * 20), 'останалите са пропорционални на нея');
});

test('изискването по чл. 40 стои горе, казва темпото и изчезва от „Годината“', async () => {
  const d = await renderDashDom(DASH({ inventoryScannedYear: 0, inventoryTarget: 1000 }));
  const card = d.querySelector('#view .normCard');
  assert.ok(card, 'липсва картата за инвентаризацията');
  // Веднага след показателите, ПРЕДИ двата реда с карти.
  assert.equal(card.previousElementSibling.className, 'kpis', 'стои непосредствено под показателите');
  assert.ok(card.querySelector('svg.ringSvg'), 'пръстенът е същият, който ползва и „Справки“');
  /* Празните места се нормализират: разделителят за хиляди зависи от средата
     (в jsdom е „1000“, в браузъра „1 000“), а разделянето на редове — от
     оформлението на самия шаблон. Проверява се текстът, не подредбата му. */
  const txt = card.textContent.replace(/\s+/g, ' ');
  assert.match(txt, /0 от 1\s?000 документа/);
  assert.match(txt, /чл\. 40, т\. 2/);
  assert.match(txt, /Остават \d+ дни до 31 декември/);
  assert.match(txt, /на месец, за да бъде изпълнено/);
  assert.ok(card.querySelector('.normBtn'), 'има бутон към самия раздел');

  const yearCard = [...d.querySelectorAll('#view .card')].find(c => /^Годината/.test((c.querySelector('h3') || {}).textContent || ''));
  assert.ok(yearCard);
  assert.doesNotMatch(yearCard.textContent, /Инвентаризация/, 'едно число — едно място');
  assert.equal(yearCard.querySelector('.bar'), null, 'старата лента вече не се чертае тук');
});

test('„изостава“ и „в график“ се решават по календара, а не по кръгло число', async () => {
  /* 8% през януари е в график; същите 8% през декември — не. Затова прагът е
     изминалата част от годината, а не фиксиран процент. Тук се проверява, че
     решението изобщо зависи от напредъка при една и съща дата. */
  const low = await renderDashDom(DASH({ inventoryScannedYear: 0, inventoryTarget: 1000 }));
  const high = await renderDashDom(DASH({ inventoryScannedYear: 1000, inventoryTarget: 1000 }));
  assert.match(high.querySelector('#view .normCard').textContent, /изпълнена/);
  assert.equal(high.querySelector('#view .normCard.behind'), null, 'изпълненото не е „изостава“');

  const now = new Date();
  const yStart = new Date(now.getFullYear(), 0, 1), yEnd = new Date(now.getFullYear(), 11, 31);
  const elapsed = (now - yStart) / (yEnd - yStart) * 100;
  const lowCard = low.querySelector('#view .normCard');
  if (elapsed > 10) {
    assert.ok(lowCard.classList.contains('behind'), 'при 0% след първите пет седмици на годината — изостава');
    assert.match(lowCard.textContent, /изостава/);
  } else {
    assert.equal(lowCard.classList.contains('behind'), false, 'в началото на годината 0% още не е изоставане');
  }
});

/* ==================================================================
   4. Подредбата, която побира всичко това
   ================================================================== */

test('таблото е с балансиран HTML — картите са преки деца на своите редове', async () => {
  /* Точно този дефект се появи при писането на кръга: премахнатият блок за
     инвентаризацията отнесе и затварящия таг на картата, вторият ред с карти влезе
     ВЪТРЕ в първия и колоните му се смачкаха до 106 px. На екрана изглеждаше почти
     нормално. Затова структурата се проверява, а не само текстът. */
  const f = upcomingFixture();
  const d = await renderDashDom(DASH({ upcoming: f.rows, upcomingCount: 16, upcomingByDay: f.byDay }));
  const rows = [...d.querySelectorAll('#view .grid.dashGrid')];
  assert.equal(rows.length, 2, 'два реда с карти');
  assert.equal(rows[0].children.length, 2, 'горе: „Просрочени“ (две колони) и „Годината“');
  assert.equal(rows[1].children.length, 3, 'долу: „Бързи действия“, „Предстоящи връщания“, „За днес“');
  for (const row of rows) {
    for (const child of row.children) {
      assert.ok(child.classList.contains('card'), 'пряко дете на реда, което не е карта: ' + child.className);
      assert.equal(child.querySelector('.grid.dashGrid'), null, 'ред с карти, вложен в карта — счупена структура');
    }
  }
  /* И общо: точно седемте карти на таблото, нито една изгубена при пренареждането —
     сканирането, чл. 40, просрочените, годината, бързите действия, предстоящите
     връщания и „За днес“. */
  assert.equal(d.querySelectorAll('#view .card').length, 7);
});

test('колоните на таблото делят ширината поравно, вместо най-дългата карта да ги изяжда', () => {
  assert.match(CSS, /\.grid\.g3\.dashGrid\{grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)\}/,
    'без minmax(0,1fr) колоната расте над своя дял — измерено 116 / 254 / 253 вместо три по 338');
  /* ТЕЖЕСТТА има значение: „.dashGrid“ е с един клас, а „.grid.g3“ — с два, тоест
     краткото правило би било безсилно и „1fr 1fr 1fr“ би печелило винаги. */
  assert.doesNotMatch(CSS, /^\.dashGrid\{/m, 'правило с по-ниска тежест от .grid.g3 не влиза в сила');
  assert.match(CSS, /\.grid\.dashGrid\{display:grid; gap:10px\}/,
    'всеки клас за решетка носи собствено display:grid — иначе редът се разпада вертикално');
  assert.match(CSS, /\.grid\.dashGrid > \.card\{min-width:0\}/,
    'елементът на решетка е с min-width:auto по подразбиране — иначе minmax(0,1fr) не помага');
  /* v2.4.54: общият .grid.g3 ВЕЧЕ Е ПИПАН — и това е нарочно. В v2.4.52 тук стоеше
     обратното („не е пипан, защото се ползва и във формулярите“), но точно същият
     дефект изскочи пак на следващия екран: в „Справки и статистика“ едно дълго
     заглавие от базата избутваше третата карта 393 px извън екрана при 1366 px.
     Проверено с истински полета във формуляра за документ при 1366 px — нито едно
     поле не пада под 60 px, защото полетата и без това са width:100%. */
  assert.match(CSS, /\.grid\.g3\{display:grid; grid-template-columns:repeat\(3, minmax\(0, 1fr\)\); gap:10px\}/,
    'общата решетка също не бива да се разтяга от съдържанието си');
  assert.match(CSS, /\.grid\.g2\{display:grid; grid-template-columns:repeat\(2, minmax\(0, 1fr\)\); gap:10px\}/);
  assert.match(CSS, /\.grid\.g4\{display:grid; grid-template-columns:repeat\(4, minmax\(0, 1fr\)\); gap:10px\}/);
  assert.match(CSS, /\.grid\.g2 > \.card, \.grid\.g3 > \.card, \.grid\.g4 > \.card\{min-width:0\}/,
    'без min-width:0 на картата minmax(0,1fr) пак не помага');
});

test('заглавието на реда се съкращава с многоточие, а пълното остава в подсказката', async () => {
  const f = upcomingFixture();
  const d = await renderDashDom(DASH({ upcoming: f.rows, upcomingCount: 16, upcomingByDay: f.byDay }));
  const row = d.querySelector('#view .upRow2 .upTitle');
  assert.equal(row.getAttribute('title'), 'Днешна 0', 'пълното заглавие стои в подсказката');
  assert.match(CSS, /\.upTitle\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/,
    'редовете трябва да са с еднаква височина, за да се брои списъкът с поглед');
});

/* ==================================================================
   5. Пръстенът се дели със „Справки“, вместо да се рисува втори
   ================================================================== */

test('ringSvg приема свой цвят и не рисува дъга при нула, без да променя досегашните си повиквания', async () => {
  const d = await renderDashDom(DASH({ inventoryScannedYear: 0, inventoryTarget: 1000 }));
  const ring = d.querySelector('#view .normCard svg.ringSvg');
  assert.equal(ring.querySelectorAll('circle').length, 1,
    'при 0% остава само пистата — заоблена шапка с нулева дължина оставя точка, която прилича на повреда');
  assert.match(ring.getAttribute('aria-label'), /^0% /);

  const half = await renderDashDom(DASH({ inventoryScannedYear: 500, inventoryTarget: 1000 }));
  const r2 = half.querySelector('#view .normCard svg.ringSvg');
  assert.equal(r2.querySelectorAll('circle').length, 2, 'при 50% дъгата се рисува');
  const stroke = r2.querySelectorAll('circle')[1].getAttribute('stroke');
  assert.ok(/var\(--(brass|red|green)\)/.test(stroke), 'цветът идва отвън: ' + stroke);

  // Старият подпис (без opts) продължава да работи както досега — „Справки“ го ползва.
  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'stats.js'), 'utf8');
  assert.match(src, /function ringSvg\(pct, label, opts\)/);
  assert.match(src, /\$\{ringSvg\(onTimePct\)\}/, '„Спазване на сроковете“ вика ringSvg без опции');
  assert.match(src, /o\.color \|\| \(on >= 90 \? 'var\(--green\)'/,
    'без подаден цвят прагът си остава 90/70, както беше');
});
