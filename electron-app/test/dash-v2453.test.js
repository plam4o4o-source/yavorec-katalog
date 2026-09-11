'use strict';
/* v2.4.53 — четиридесети кръг: преглед на v2.4.52 (таблото).
   =====================================================================
   Патчът на v2.4.52 сам премина пълната поредица (1454/1454, UTC и
   Europe/Sofia) и всичките си 14 нови теста, но собствена мутационна проверка
   при прегледа му намери една истинска грешка и два пропуска в тестовете —
   всичките в код, до който v2.4.52 не се беше добрал:

     1. loansWeeks губеше заемане, взето точно преди 84 дни — границата на
        заявката беше `>=`, а трябва да е `>` (12 седмици = точно 84 дни,
        днес до преди 83 дни включително). Не е рядък ръб: случва се всеки
        ден, в който има такова заемане. Възпроизведено директно с
        better-sqlite3, преди да се пипне кодът.
     2. Лентата по тежест (`.sevBar`) не проверяваше КОЯ стойност отговаря на
        КОЙ цвят/ширина — ръчна размяна на d7/d30 остана непроверена, макар
        сборът на трите дяла пак да излизаше 100%.
     3. Темпото „N документа на месец“ не се сверяваше с независимо смятане
        на самото число — само с регулярен израз за формата на изречението.

   И трите тук са проверени с мутация: върната поправка → тестът пада. */
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
const MAIN = fs.readFileSync(path.join(APP_DIR, 'handlers', 'dashboard.js'), 'utf8');

/* ==================================================================
   1. Границата на 84-те дни
   ================================================================== */

test('границата на заявката изключва заемане от ТОЧНО 84 дни, не само коментарът го твърди', () => {
  /* Проверка на самия SQL текст, преди да се пусне база: границата трябва да е
     стриктно „>“, а не „>=“ — символът решава дали граничният ден влиза. */
  assert.match(MAIN, /date_out > date\('now', '-84 days'\) AND date_out <= date\('now'\)/,
    'долната граница на 12-те седмици трябва да е стриктна');
  assert.doesNotMatch(MAIN, /date_out >= date\('now', '-84 days'\)/,
    'нестриктната граница е точно грешката: включва заемане от преди 84 дни, w=12, извън масива');
});

test('заемане от точно преди 84 дни изчезва от границата на заявката (СРЕЩУ истинска SQLite)', () => {
  /* Директна проверка на самото SQLite поведение, без да се минава през
     приложението — за да не зависи резултатът от нищо друго освен границата.
     Числото 84.0 никога не излиза точно заради часа на деня в julianday('now'),
     затова CAST(.../7) на заемане от точно преди 84 дни винаги дава 12. */
  const db = new Database(':memory:');
  db.exec('CREATE TABLE loans (date_out TEXT)');
  db.prepare('INSERT INTO loans VALUES (?)').run(dayOff(84));
  db.prepare('INSERT INTO loans VALUES (?)').run(dayOff(83));
  db.prepare('INSERT INTO loans VALUES (?)').run(dayOff(0));
  const rows = db.prepare(`SELECT CAST((julianday('now') - julianday(date_out)) / 7 AS INTEGER) AS w, COUNT(*) AS n
    FROM loans WHERE date_out > date('now', '-84 days') AND date_out <= date('now') GROUP BY w`).all();
  const total = rows.reduce((s, r) => s + r.n, 0);
  assert.equal(total, 2, 'само двете заемания в прозореца (83 и 0 дни), НЕ трите');
  assert.ok(rows.every(r => r.w >= 0 && r.w <= 11), 'нито един ред извън 0..11 — индексът на масива е безопасен');
});

/* ---------------- истинското приложение, прясна база ---------------- */
let app = null, db = null;
test.after(() => { if (db) db.close(); if (app) app.stop(); });

async function boot() {
  if (app) return app;
  app = startMainApp();
  await app.ready();
  db = new Database(path.join(app.userData, 'library.db'));
  const insB = db.prepare(`INSERT INTO books (inv_number, title, status, price, register_date) VALUES (?, ?, 'наличен', 1, ?)`);
  const insI = db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)');
  const insR = db.prepare("INSERT INTO readers (name, card_no, status, gdpr_consent, registered_at) VALUES (?,?,'активен',1,?)");
  const insL = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in, fine) VALUES (?,?,?,?,?,0)');
  db.transaction(() => {
    insR.run('Читател 1', '9001', dayOff(200));
    let b = 1;
    /* Точно граничният случай: едно заемане от точно преди 84 дни (би трябвало
       да ИЗЧЕЗВА от прозореца), едно от точно преди 83 дни (последният, който
       ТРЯБВА да влезе), плюс едно съвсем прясно, за да не е сборът тривиално 0. */
    for (const daysAgo of [84, 83, 0]) {
      const id = insB.run(1000 + b, 'Книга ' + b, dayOff(400)).lastInsertRowid;
      insI.run(id);
      /* dayOff(null) НЕ дава null — JS смята null като 0 в изваждането вътре в
         dayOff() и връща днешна дата вместо отворено (незавършено) заемане.
         За най-пресния запис (daysAgo=0) искаме точно отворено заемане, затова
         null се подава директно, без да минава през dayOff(). */
      insL.run(1, id, dayOff(daysAgo), dayOff(daysAgo - 30), daysAgo - 1 >= 0 ? dayOff(daysAgo - 1) : null);
      b++;
    }
  })();
  return app;
}

test('таблото не брои заемане от точно преди 84 дни, но брои това от преди 83', async () => {
  await boot();
  const d = (await app.invoke('dashboard:full')).data;
  /* Независимо преброяване тук, СЪС СЪЩАТА (поправената) граница — идентична на
     предишния тест по дух, но фикстурата е нарочно ГРАНИЧНА, за разлика от
     dash-v2452.test.js, чиято фикстура изобщо не съдържа заемане от точно
     84 дни и затова не различава двете граници. */
  const indep = db.prepare(`SELECT COUNT(*) AS n FROM loans
    WHERE date_out > date('now', '-84 days') AND date_out <= date('now')`).get().n;
  assert.equal(indep, 2, 'фикстурата: 83 и 0 дни, НЕ 84');
  assert.equal(d.loansWeeks.reduce((s, n) => s + n, 0), indep,
    'таблото трябва да съвпада с независимо преброените 84 дни, включително на самата граница');
  assert.equal(d.loansWeeks.reduce((s, n) => s + n, 0), 2,
    'заемането от точно преди 84 дни НЕ бива да е в сбора — точно това беше грешката');
  /* Пропуск в самия тест, хванат чрез мутационна проверка тук: при върнатата
     (буболечна) `>=` граница SQL пак връща реда за точно 84-те дни, но w=12 и
     `loansWeeks[11-12]` е `loansWeeks[-1]` — странично, неномерирано свойство
     на масива. `.reduce()`/`for…of` никога не го посещават, затова сборът
     излиза 2 И в двата случая (буговия, и поправения) — самият сбор НЕ
     различава версиите. Разликата е видима само през директна проверка за
     точно това странично свойство. */
  assert.equal(Object.prototype.hasOwnProperty.call(d.loansWeeks, '-1'), false,
    'не бива да остава странично свойство "-1" на масива — точно там изчезваше загубеното заемане');
  assert.equal(Object.keys(d.loansWeeks).length, 12,
    'масивът трябва да има точно 12 собствени свойства — индексите 0..11, нищо извън тях');
});

/* ==================================================================
   2. Лентата по тежест: КОЯ стойност отговаря на КОЙ дял
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

async function renderDashDom(data) {
  const dom = buildDom({ 'dashboard.full': data, 'settings.get': {} });
  await settle();
  await dom.window.renderDash();
  await settle();
  return dom.window.document;
}

test('лентата по тежест подрежда трите дяла ВЯРНО — не само по сбор, а и по стойност', async () => {
  /* d7, d30 и more са нарочно РАЗЛИЧНИ (4, 21, 3) — при равни стойности размяна
     на два дяла минава незабелязано, защото ширините съвпадат. Числото 21 е
     специално голямо, за да не се обърка с процент от друг дял по грешка. */
  const d = await renderDashDom(DASH({ overdueBuckets: { d7: 4, d30: 21, more: 3 } }));
  const k = [...d.querySelectorAll('#view .kpi')].find(x => /Просрочени/.test(x.textContent));
  const spans = [...k.querySelectorAll('.sevBar span')];
  assert.equal(spans.length, 3);
  const tot = 4 + 21 + 3;
  const pct = (n) => (n / tot * 100).toFixed(2) + '%';
  /* Първият дял е ДО 7 дни (кехлибарено „--brass“), вторият — 8 до 30
     („--amber“), третият — над 30 („--red“). Проверяваме и ширината, И цвета
     на всеки поотделно — размяна на кой да е чифт трябва да падне тук. */
  /* Взето е от суровия style="" атрибут, не от style.width — jsdom (както и
     истински браузър) нормализира "75.00%" до "75%" при четене през CSSOM,
     щом числото излезе цяло, което би дало лъжливо несъответствие тук, без
     ширината всъщност да е грешна. */
  assert.ok(spans[0].getAttribute('style').includes(`width:${pct(4)}`), 'първият дял е точно d7');
  assert.ok(spans[0].getAttribute('style').includes('var(--brass)'), 'до 7 дни е с кехлибарения цвят');
  assert.ok(spans[1].getAttribute('style').includes(`width:${pct(21)}`), 'вторият дял е точно d30');
  assert.ok(spans[1].getAttribute('style').includes('var(--amber)'), '8–30 дни е с --amber');
  assert.ok(spans[2].getAttribute('style').includes(`width:${pct(3)}`), 'третият дял е точно more');
  assert.ok(spans[2].getAttribute('style').includes('var(--red)'), 'над 30 дни е червено');
  /* И легендата под лентата сочи същите числа към същите надписи. */
  const legend = [...k.querySelectorAll('.sevLeg span')].map(s => s.textContent.trim());
  assert.equal(legend[0], 'до 7 дни 4');
  assert.equal(legend[1], '8–30 21');
  assert.equal(legend[2], 'над 30 3');
});

/* ==================================================================
   3. Темпото по чл. 40 — независимо изчислено число, не само формат
   ================================================================== */

test('темпото „N документа на месец“ е ТОЧНОТО число, не произволно, което пасва на изречението', async () => {
  /* Стойности, при които независимото пресмятане не съвпада случайно с нещо
     друго на екрана (не са нито inventoryTarget, нито inventoryScannedYear).
     887 остатъчни документа е нарочно избрано да НЕ се дели точно на броя
     пълни месеца (напр. 887/4 = 221.75) — при точно деление Math.ceil и
     Math.floor биха дали едно и също число и мутация в закръглянето (ceil
     вместо floor) би минала невидяна. */
  const d = await renderDashDom(DASH({ inventoryScannedYear: 313, inventoryTarget: 1200 }));
  const card = d.querySelector('#view .normCard');
  const txt = card.textContent.replace(/\s+/g, ' ');
  const m = /Остават (\d+) дни до 31 декември — по (\d+) документа на месец/.exec(txt);
  assert.ok(m, 'изречението за темпото трябва да го има: ' + txt);
  const daysLeft = Number(m[1]), perMonth = Number(m[2]);
  /* Независимо преизчисление, копие на формулата в renderDash() — целта на
     този тест е да провери, че renderDash() я приложи ВЯРНО за тези числа, не
     да сравни формулата със себе си, затова датите се вземат от истинския
     днешен ден, както прави и самият изглед. */
  const now = new Date();
  const yEnd = new Date(now.getFullYear(), 11, 31);
  const expectedDaysLeft = Math.max(0, Math.ceil((yEnd - now) / 86400000));
  const invLeft = 1200 - 313;
  const expectedPerMonth = Math.ceil(invLeft / Math.max(1, Math.round(expectedDaysLeft / 30)));
  assert.equal(daysLeft, expectedDaysLeft, 'дните до 31 декември трябва да съвпадат с изчислените тук');
  assert.equal(perMonth, expectedPerMonth,
    'документите на месец трябва да идват от 887 оставащи / броя пълни месеца, не произволно число');
});
