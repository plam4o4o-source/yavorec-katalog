'use strict';
/* Одитен кръг v2.4.61 — ОТЧИСЛЯВАНЕ: КАКВО ОСТАВА СЛЕД АКТА И КАКВО АКТЪТ НЕ БИВА
 * ДА ПРИЕМА.
 * =====================================================================
 * Кръгът тръгна от един въпрос: какво точно се случва с ДОКУМЕНТА, с ЧИТАТЕЛЯ и
 * с РЕГИСТРИТЕ, когато комисията състави акт. Отговорите, които се оказаха
 * счупени, са в този файл — по едно твърдение на находка, наречено с дефекта:
 *
 *   1) Заемането на НЕвърнат документ се затваряше като нормално връщане:
 *      забавата изчезваше, в сметката на читателя не влизаше нищо, събитието
 *      беше „връщане“, а картонът печаташе „Върнат на …“ за книга, която е в
 *      дома на читателя (чл. 30, т. 5 отчислява именно НЕВЪРНАТИТЕ документи).
 *   2) Номерът на акта се предлагаше за текущата година, а актът се записваше в
 *      годината на ДАТАТА си — акт за декември на миналата година получаваше
 *      № 4 в година с нула актове (чл. 35: номерацията започва от 1 всяка
 *      календарна година, а по чл. 39 актове не се трият, тоест дупката е вечна).
 *   3) Акт с дата ПРЕДИ вписването на документа минаваше: КДБФ за онази година
 *      отчиташе отчисляване без наличност и веригата между годините се късаше.
 *   4) Акт с дата В БЪДЕЩЕТО минаваше: документът излиза от фонда днес, а КДБФ
 *      го брои в наличността към 31.12.
 *   5) Сканиран вече отчислен документ получаваше „Няма документ с този номер“ —
 *      същото съобщение, както за номер, който никога не е съществувал.
 *   6) Бележката на проекта (препратката към протокола по чл. 40) не се
 *      показваше никъде и се изтриваше при първия запис от формата, а утвърденият
 *      акт нямаше къде да я носи.
 *   7) Анулиране на акт от ПРИКЛЮЧЕНА година пренаписваше вече отпечатаната и
 *      подписана КДБФ, без да пита и без да го каже (чл. 39).
 *   8) (от одита на периодиката) Актът приемаше документ, който в момента е у
 *      читател, по ЛЮБАЯ причина — books:delete отдавна отказва същия случай.
 *
 * Плюс двете допълнения: актът вече носи кой и кога го е съставил, и препратка
 * към документа, от който е роден.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { APP_DIR, freshDb, fakeIpcMain, runDep, cleanupTmpDirs } = require('./helpers/audit-fixtures');
const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values');

test.after(cleanupTmpDirs);

const TODAY = '2026-06-10';

/* Само модулът на отчисляването — начислението в читателската сметка минава през
   handlers/account.js, който се внася ПРЯКО от него (chargeLost/chargeCoverage) и
   не се нуждае от регистрация. logEvent и closedDaysBetween се подават точно
   както ги подава main.js: първото вписва събитието „изгубен“, второто изважда
   затворените дни от забавата (тук календарът е без затворени дни). */
function setup(prefix) {
  const { db } = freshDb(prefix || 'inv-otch-v2461-');
  db.prepare('UPDATE settings SET fine_per_day = 0.10, librarian = ? WHERE id = 1').run('Мария Иванова');
  const audit = [];
  const events = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'deaccession-acts'))(ipcMain, {
    getDb: () => db, run: runDep,
    logAudit: (action, detail) => audit.push({ action, detail }),
    today: () => TODAY, yearOf: (d) => String(d || TODAY).slice(0, 4),
    BOOK_SELECT, normalizeScanCode,
    scheduleCatalogWrite: () => {}, flushCatalogWrite: () => ({ written: true }),
    logEvent: (kind, o) => events.push(Object.assign({ kind }, o)),
    closedDaysBetween: () => 0
  });
  return { db, ipcMain, audit, events };
}
function addBook(db, o) {
  const b = Object.assign({
    inv_number: 1, title: 'Под игото', author: 'Вазов, Иван', price: 12.5,
    register_date: '2026-02-01', status: 'наличен', qty: 1
  }, o);
  const id = db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, status_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(b.inv_number, b.title, b.author, b.price, b.register_date, b.status, b.register_date).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, b.qty);
  return id;
}
function addReader(db, o) {
  const r = Object.assign({ name: 'Петрова, Мария', card_no: '1001' }, o);
  return db.prepare('INSERT INTO readers (name, card_no) VALUES (?, ?)').run(r.name, r.card_no).lastInsertRowid;
}
/* Отворено заемане: книгата е у читателя. `date_due` е в миналото, за да има
   какво да се начисли — точно случаят, който актът по чл. 30, т. 5 заварва. */
function lend(db, bookId, readerId, o) {
  const l = Object.assign({ date_out: '2026-04-01', date_due: '2026-05-01' }, o);
  return db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(readerId, bookId, l.date_out, l.date_due).lastInsertRowid;
}
const ACT = (o) => Object.assign({
  no: 1, date: TODAY, reason_code: 4, reason_text: 'Физически изхабени',
  disposal: 'унищожени', committee1: 'А', committee2: 'Б', committee3: 'В (счетоводител)'
}, o);
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };
const lastAudit = (audit, action) => [...audit].reverse().find(a => a.action === action);

/* ==================================================================
   1. Заемането на НЕВЪРНАТ документ (чл. 30, т. 5)
   ================================================================== */

test('актът по чл. 30, т. 5 закрива заемането като НЕВЪРНАТО, а не като върнато', () => {
  const { db, ipcMain, events } = setup();
  const b = addBook(db, { inv_number: 6, title: 'Немили-недраги', price: 12.5 });
  const r = addReader(db, {});
  const loanId = lend(db, b, r);

  ok(ipcMain.invoke('deaccessionActs:create', {
    act: ACT({ no: 5, reason_code: 5, reason_text: 'Повредени или невърнати от ползватели' }), bookIds: [b]
  }), 'акт по т. 5');

  const l = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  assert.equal(l.date_in, TODAY, 'заемането е затворено — екземплярът не виси зает завинаги');
  assert.equal(l.lost, 1, 'но е затворено като НЕВЪРНАТО: иначе статистиката го брои като върната книга');
  assert.equal(l.lost_date, TODAY);
  assert.equal(l.lost_resolution, 'отчислен с акт № 5/2026',
    'уреждането с читателя още не е станало — записва се това, което е вярно днес');
  // 40 дни забава (01.05 → 10.06) по 0.10 €: числото е същото, което показва
  // екранът „Просрочени“, защото се смята със същата функция и същия календар.
  assert.equal(Math.round(l.fine * 100), 400, 'натрупаната забава остава по заемането');
  assert.equal(Math.round(l.deaccession_fine * 100), 400, 'и се помни колко от нея е начислил актът');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'изгубен', 'събитието НЕ е „връщане“ — книгата не се е върнала');
  assert.equal(events[0].date, TODAY);
});

test('стойността на невърнатия документ се начислява в читателската сметка (а не изчезва)', () => {
  const { db, ipcMain, audit } = setup();
  const b = addBook(db, { inv_number: 6, price: 12.5 });
  const r = addReader(db, {});
  lend(db, b, r);

  ok(ipcMain.invoke('deaccessionActs:create', {
    act: ACT({ no: 5, reason_code: 5, reason_text: 'Повредени или невърнати от ползватели' }), bookIds: [b]
  }), 'акт');

  /* v2.4.61 (втора поправка): актът начислява ДВЕ неща на читателя — забавата до
     деня на акта и стойността на самия невърнат документ. И двете влизат в
     account_lines, защото това е единственото място, което гишето показва като
     „Дължи по сметка“ и което годишният отчет разнася като „Събрани обезщетения“;
     видът ги различава, за да може справката за приходите да ги раздели. Затова
     редът се търси ПО ВИД, а не „първия ред на читателя“. */
  const line = db.prepare("SELECT * FROM account_lines WHERE reader_id = ? AND type = 'обезщетение за изгубен документ'").get(r);
  const fineLine = db.prepare("SELECT * FROM account_lines WHERE reader_id = ? AND type = 'обезщетение'").get(r);
  assert.ok(line, 'няма ред в сметката — библиотеката отписва документ, без някой да ѝ го дължи');
  assert.ok(fineLine, 'забавата също е обезщетение по чл. 43 и също се дължи — иначе не влиза в „Дължи по сметка“');
  assert.equal(fineLine.amount, 4, '40 дни × 0.10 € — същата сума, която е записана и в loans.fine');
  assert.match(fineLine.note, /Забава по невърнат документ инв\. № 6/);
  assert.equal(line.kind, 'начисление');
  assert.equal(line.type, 'обезщетение за изгубен документ',
    'отделен вид от обезщетението за забава — иначе „Приходи от такси“ не може да ги раздели');
  assert.equal(line.amount, 37.5, 'по правилото на библиотеката: 3 × 12.50 €');
  assert.equal(line.date, TODAY);
  assert.match(line.note, /Невърнат документ инв\. № 6/);
  assert.match(line.note, /отчислен с акт № 5\/2026/);
  // И самото начисление се вижда в дневника — там го чете библиотекарката на другия ден.
  const a = lastAudit(audit, 'Отчисляване');
  assert.match(a.detail, /закрито 1 заемане на невърнат документ \(чл\. 30, т\. 5\)/);
  assert.match(a.detail, /Петрова, Мария \(карта 1001\) — инв\. № 6, забава 40 дни = 4\.00 €, начислено обезщетение 37\.50 €/);
  assert.match(a.detail, /заеманията са закрити като НЕвърнати, не като върнати/);
});

test('анулирането връща заемането ТОЧНО както е било: без белег „невърнат“, без двойна забава, без начисление', () => {
  /* Половинчатото връщане е по-лошо от никакво: заемане, което е едновременно
     отворено и „изгубено“, влиза и в „Просрочени“, и в справката за изгубените,
     а начислената от акта забава се събира втори път (екранът добавя дните от
     падежа до днес към вече записаното в loans.fine). */
  const { db, ipcMain } = setup();
  const b = addBook(db, { inv_number: 6, price: 12.5 });
  const r = addReader(db, {});
  const loanId = lend(db, b, r);
  const actId = ok(ipcMain.invoke('deaccessionActs:create', {
    act: ACT({ no: 5, reason_code: 5, reason_text: 'Повредени или невърнати от ползватели' }), bookIds: [b]
  }), 'акт');

  ok(ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'читателят върна книгата' }), 'анулиране');

  const l = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  assert.equal(l.date_in, null, 'книгата е у читателя — заемането е пак отворено');
  assert.equal(l.deaccession_act_id, null);
  assert.equal(l.lost, null); assert.equal(l.lost_resolution, null); assert.equal(l.lost_amount, null);
  assert.equal(l.lost_account_line_id, null);
  assert.equal(l.deaccession_fine, null);
  assert.equal(Math.round((l.fine || 0) * 100), 0, 'начислената от акта забава е върната — иначе се брои два пъти');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_lines WHERE reader_id = ?').get(r).n, 0,
    'начислението пада заедно с акта, защото по него не е плащано');
});

test('ПЛАТЕНОТО обезщетение не се трие при анулиране — редът остава и следата го казва', () => {
  /* Парите са в касата: изтриването на платено начисление би обезсмислило и
     квитанцията, и справката за приходите. Затова редът остава, а анулирането
     казва на човека какво да уреди на гишето. */
  const { db, ipcMain, audit } = setup();
  const b = addBook(db, { inv_number: 6, price: 12.5 });
  const r = addReader(db, {});
  lend(db, b, r);
  const actId = ok(ipcMain.invoke('deaccessionActs:create', {
    act: ACT({ no: 5, reason_code: 5, reason_text: 'Повредени или невърнати от ползватели' }), bookIds: [b]
  }), 'акт');
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, 'плащане', 'плащане', ?, ?)")
    .run(r, TODAY, -20, 'частично плащане');

  const info = ok(ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'сгрешен акт' }), 'анулиране');

  /* Актът е начислил ДВЕ неща — 37.50 € за самия документ и 4.00 € забава.
     Плащането покрива най-старото задължение първо (същото правило, по което се
     води всяка сметка), а редът на двете начисления в един и същи ден е нарочен:
     ПЪРВО обезщетението за документа, ВТОРО забавата — точно както ги начислява и
     „Документът е изгубен“ на гишето (виж дългата бележка при chargeOverdueFine в
     handlers/loans.js). Затова 20.00 € отиват по стойността на невърнатия
     документ, а не по забавата: въпросът, който стои пред комисията по чл. 30,
     т. 5, е обезщетен ли е отчисленият документ.
     Следствието тук: по обезщетението вече е плащано и то ОСТАВА (парите са в
     касата), а по забавата не е платено нищо и тя пада заедно с акта — същото
     правило, приложено към всеки от двата реда поотделно.
     (Първият вариант на поправката начисляваше забавата първа и този тест
     очакваше 20.00 € да покрият нея; прегледът на кръга откри разминаването с
     реда на гишето и го изправи.) */
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account_lines WHERE reader_id = ? AND kind = 'начисление'").get(r).n, 1,
    'начислението, по което е плащано, остава; неплатената забава пада с акта');
  assert.equal(info.keptCharges.length, 1);
  assert.equal(info.keptCharges[0].kind, undefined, 'останалото начисление е за самия документ, не забавата');
  assert.equal(info.keptCharges[0].charged, 37.5);
  assert.equal(info.keptCharges[0].covered, 20, 'платените 20.00 € отиват по стойността на невърнатия документ');
  assert.match(lastAudit(audit, 'Анулиране на акт').detail,
    /начислението ОСТАВА в сметката на Петрова, Мария \(инв\. № 6, за невърнат документ, начислено 37\.50 €, събрано 20\.00 €\)/);
});

/* ==================================================================
   2. Зает документ и причината по чл. 30 (находка от одита на периодиката)
   ================================================================== */

test('документ, който е у читател, не се отчислява по причина, различна от т. 5', () => {
  const { db, ipcMain } = setup();
  const b = addBook(db, { inv_number: 7, title: 'Ловни разкази' });
  const r = addReader(db, { name: 'Георгиев, Иван', card_no: '1002' });
  lend(db, b, r);

  const res = ipcMain.invoke('deaccessionActs:create', { act: ACT({ reason_code: 3, reason_text: 'Физически изхабени' }), bookIds: [b] });

  assert.equal(res.ok, false, 'комисията не може да опише документ, който не е виждала');
  assert.match(res.error, /Инв\. № 7 в момента е зает от Георгиев, Иван \(карта № 1002\)/);
  assert.match(res.error, /чл\. 30, т\. 5/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_acts').get().n, 0, 'номер не се заема');
  assert.equal(db.prepare('SELECT status FROM books WHERE id = ?').get(b).status, 'наличен');
  assert.equal(db.prepare('SELECT date_in FROM loans WHERE book_id = ?').get(b).date_in, null,
    'и заемането не е закрито мълчаливо');
});

/* ==================================================================
   3. Датата на акта
   ================================================================== */

test('акт с дата ПРЕДИ вписването на документа се отказва и назовава двете дати', () => {
  const { db, ipcMain } = setup();
  const b = addBook(db, { inv_number: 8, register_date: '2026-02-01' });

  const res = ipcMain.invoke('deaccessionActs:create', { act: ACT({ date: '2025-06-01' }), bookIds: [b] });

  assert.equal(res.ok, false, 'КДБФ за 2025 г. би отчела отчисляване без наличност');
  assert.match(res.error, /Инв\. № 8 е вписан в инвентарната книга на 01\.02\.2026 г\., а актът е с дата 01\.06\.2025 г\./);
  assert.match(res.error, /веригата между годините се къса/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deaccession_acts').get().n, 0);
});

test('акт с дата в БЪДЕЩЕТО се отказва', () => {
  const { db, ipcMain } = setup();
  const b = addBook(db, { inv_number: 9 });

  const res = ipcMain.invoke('deaccessionActs:create', { act: ACT({ date: '2027-01-10' }), bookIds: [b] });

  assert.equal(res.ok, false);
  assert.match(res.error, /Датата на акта \(10\.01\.2027 г\.\) е в бъдещето — днес е 10\.06\.2026 г\./);
  assert.equal(db.prepare('SELECT status FROM books WHERE id = ?').get(b).status, 'наличен',
    'документът не излиза от фонда „предварително“');
  // Днешната дата минава — проверката не бива да отказва самия работен ден.
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ date: TODAY }), bookIds: [b] }), 'акт с днешна дата');
});

/* ==================================================================
   4. Номерацията по чл. 35
   ================================================================== */

test('пропуснатите номера в годината се вписват в дневника, а не минават мълчаливо', () => {
  const { db, ipcMain, audit } = setup();
  const b = addBook(db, { inv_number: 10 });

  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 4 }), bookIds: [b] }), 'акт № 4 в празна година');

  const a = lastAudit(audit, 'Отчисляване');
  assert.match(a.detail, /ВНИМАНИЕ: за 2026 г\. остават незаети номера № 1 – 3/);
  assert.match(a.detail, /чл\. 35 изисква номерата да текат последователно от 1 всяка календарна година/);
  // Следващият номер по реда не оставя дупка и не се коментира.
  const b2 = addBook(db, { inv_number: 11 });
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 5 }), bookIds: [b2] }), 'акт № 5');
  assert.equal(/остават незаети номера/.test(lastAudit(audit, 'Отчисляване').detail), false,
    'нередност се вписва само когато я има — иначе предупреждението спира да значи нещо');
});

test('номерацията на актовете тече ОТ 1 ЗА ВСЯКА ГОДИНА — миналогодишните номера не я запълват', () => {
  /* Чл. 35: номерата на актовете текат последователно от 1 всяка календарна
     година. Тоест въпросът „остават ли незаети номера“ се задава ВЪТРЕ в
     годината на акта. Ако сравнението се прави с най-големия номер изобщо,
     миналогодишен акт № 9 „покрива“ тазгодишния № 4 и дупката 1 – 3 в текущата
     година минава мълчаливо — а тъкмо тя се вижда при проверка. */
  const { db, ipcMain, audit } = setup();
  const old1 = addBook(db, { inv_number: 20, register_date: '2025-02-01' });
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 9, date: '2025-09-30' }), bookIds: [old1] }),
    'акт № 9 от миналата година');
  assert.match(lastAudit(audit, 'Отчисляване').detail, /за 2025 г\. остават незаети номера № 1 – 8/,
    'и миналата година си има своя поредица');

  const b = addBook(db, { inv_number: 21 });
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 4 }), bookIds: [b] }), 'акт № 4 за тази година');
  assert.match(lastAudit(audit, 'Отчисляване').detail, /ВНИМАНИЕ: за 2026 г\. остават незаети номера № 1 – 3/,
    'дупката се мери спрямо 2026 г., а не спрямо акт № 9 от 2025 г.');

  // И обратното: № 1 за нова година не е дупка, колкото и да са били номерата преди нея.
  const { db: db2, ipcMain: ipc2, audit: audit2 } = setup('inv-otch-v2461-no-');
  const p = addBook(db2, { inv_number: 22, register_date: '2025-02-01' });
  ok(ipc2.invoke('deaccessionActs:create', { act: ACT({ no: 12, date: '2025-11-11' }), bookIds: [p] }), 'акт № 12/2025');
  const q = addBook(db2, { inv_number: 23 });
  ok(ipc2.invoke('deaccessionActs:create', { act: ACT({ no: 1 }), bookIds: [q] }), 'акт № 1/2026');
  assert.equal(/остават незаети номера/.test(lastAudit(audit2, 'Отчисляване').detail), false,
    '№ 1 в нова година е началото на поредицата, не дупка');
});

/* ==================================================================
   5. Сканиране на вече отчислен документ
   ================================================================== */

test('сканираният вече отчислен документ се назовава с акта си, а не като непознат номер', () => {
  const { db, ipcMain } = setup();
  const b = addBook(db, { inv_number: 3, title: 'Бай Ганьо' });
  ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 1 }), bookIds: [b] }), 'акт');

  const res = ipcMain.invoke('deaccessionActs:findBook', '3');
  assert.equal(res.ok, false, 'отказът носи обяснение — „няма такъв номер“ праща библиотекарката да рови напразно');
  assert.match(res.error, /Инв\. № 3 е отчислен с акт № 1\/2026 на 10\.06\.2026 г\./);
  assert.match(res.error, /анулирайте го от „Отчисляване“/);
  // А несъществуващият номер си остава „няма такъв“ (undefined, не отказ).
  const none = ipcMain.invoke('deaccessionActs:findBook', '999');
  assert.equal(none.ok, true);
  assert.equal(none.data, undefined);
});

/* ==================================================================
   6. Бележката на проекта → препратката в акта (чл. 40 → чл. 30, т. 6)
   ================================================================== */

test('бележката на проекта не се губи при запис, който не я подава, и стига до утвърдения акт', () => {
  const { db, ipcMain } = setup();
  const b1 = addBook(db, { inv_number: 20, status: 'липсващ' });
  const b2 = addBook(db, { inv_number: 21, status: 'липсващ' });
  const NOTE = 'Съставен от протокол за инвентаризация № 3 от 12.05.2026 г.';
  const draftId = ok(ipcMain.invoke('deaccessionActs:saveDraft', {
    draft: { date: TODAY, reason_code: 6, reason_text: 'Констатирани като липсващи при инвентаризация', note: NOTE },
    bookIds: [b1, b2]
  }), 'проект от протокола');

  // Втори запис от формата, която няма поле за бележката (formData не я връща).
  ok(ipcMain.invoke('deaccessionActs:saveDraft', {
    id: draftId,
    draft: { date: TODAY, reason_code: 6, reason_text: 'Констатирани като липсващи при инвентаризация', disposal: 'унищожени' },
    bookIds: [b1]
  }), 'поправка на проекта');
  assert.equal(db.prepare('SELECT note FROM deaccession_drafts WHERE id = ?').get(draftId).note, NOTE,
    'препратката към протокола по чл. 40 оцелява — тя е единствената връзка между двата документа');

  const actId = ok(ipcMain.invoke('deaccessionActs:approveDraft', { id: draftId }), 'утвърждаване');
  const act = db.prepare('SELECT * FROM deaccession_acts WHERE id = ?').get(actId);
  assert.equal(act.note, NOTE, 'утвърденият акт носи препратката и я печата — инак проверяващият няма как да свърже двата документа');
  // Изрично подадена празна бележка СЕ изтрива — иначе полето би станало вечно.
  const d2 = ok(ipcMain.invoke('deaccessionActs:saveDraft', { draft: { date: TODAY, note: 'временна' }, bookIds: [b2] }), 'втори проект');
  ok(ipcMain.invoke('deaccessionActs:saveDraft', { id: d2, draft: { date: TODAY, note: '' }, bookIds: [b2] }), 'изрично изтриване');
  assert.equal(db.prepare('SELECT note FROM deaccession_drafts WHERE id = ?').get(d2).note, null);
});

/* ==================================================================
   7. Анулиране на акт от приключена година (чл. 39)
   ================================================================== */

test('анулиране на акт от приключена година иска изрично потвърждение и вписва какво се променя', () => {
  const { db, ipcMain, audit } = setup();
  const b = addBook(db, { inv_number: 30, price: 8, register_date: '2025-03-01' });
  const actId = ok(ipcMain.invoke('deaccessionActs:create', {
    act: ACT({ no: 1, date: '2025-11-30' }), bookIds: [b]
  }), 'акт за 2025 г.');

  const res = ipcMain.invoke('deaccessionActs:revoke', actId, { reason: 'сгрешен инвентарен номер' });
  assert.equal(res.ok, false, 'подписаната КДБФ за 2025 г. не се пренаписва между другото');
  assert.match(res.error, /от ПРИКЛЮЧЕНА година \(2025 г\.\)/);
  assert.match(res.error, /падат с 1 документ \/ 8\.00 €/);
  assert.equal(db.prepare('SELECT revoked_at FROM deaccession_acts WHERE id = ?').get(actId).revoked_at, null);

  ok(ipcMain.invoke('deaccessionActs:revoke', actId,
    { reason: 'сгрешен инвентарен номер', by: 'Мария Иванова', confirmClosedYear: true }), 'анулиране с потвърждение');
  const a = lastAudit(audit, 'Анулиране на акт');
  assert.match(a.detail, /ВНИМАНИЕ: актът е от ПРИКЛЮЧЕНАТА 2025 г\./);
  assert.match(a.detail, /КДБФ \(Приложение № 2 и № 3\) за 2025 г\. се преизчислява/);
  assert.match(a.detail, /наличността към 31\.12\.2025 г\. се увеличава/);
  assert.match(a.detail, /потвърдено изрично от Мария Иванова/);

  // Акт от ТЕКУЩАТА година се анулира както досега — без второ потвърждение.
  const b2 = addBook(db, { inv_number: 31 });
  const cur = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT({ no: 1 }), bookIds: [b2] }), 'акт за 2026 г.');
  ok(ipcMain.invoke('deaccessionActs:revoke', cur, { reason: 'сгрешен номер' }), 'анулиране без потвърждение');
});

/* ==================================================================
   8. „Съставил“ — подписът на съставянето
   ================================================================== */

test('актът носи кой и кога го е съставил, не само кой го е анулирал', () => {
  const { db, ipcMain } = setup();
  const b = addBook(db, { inv_number: 40 });
  const actId = ok(ipcMain.invoke('deaccessionActs:create', { act: ACT(), bookIds: [b] }), 'акт');

  const act = db.prepare('SELECT created_at, created_by FROM deaccession_acts WHERE id = ?').get(actId);
  assert.equal(act.created_by, 'Мария Иванова', 'името идва от настройките — програмата няма вход с парола');
  assert.match(String(act.created_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'и моментът на съставянето');
  // Прегледът на акта го връща на екрана (разпечатката го печата).
  const got = ok(ipcMain.invoke('deaccessionActs:get', actId), 'преглед');
  assert.equal(got.created_by, 'Мария Иванова');
});
