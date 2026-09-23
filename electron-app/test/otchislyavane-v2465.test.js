'use strict';
/* ОТЧИСЛЯВАНЕ И ИНВЕНТАРИЗАЦИЯ — кръг 42 (v2.4.65).
   =====================================================================
   Шест поправки, по един тест на всяка. Всеки тест твърди ТОВА, КОЕТО
   БИБЛИОТЕКАРКАТА ВИЖДА — реда на разпечатката, текста на съобщението,
   отказа на формата, реда в базата, — а не вътрешната форма на данните.
   Ако поправката бъде върната назад, тестът пада: проверено чрез връщане
   на всяка от шестте поправки поотделно.

   А1 — пълната инвентаризация превръщаше „изгубен от читател“ в „липсващ“;
   А2 — „Проект за акт от липсите“ връщаше екземплярите на разделен липсващ
        запис във фонда като „наличен“ (поправката е в handlers/books.js —
        тук се пази пътят, по който библиотекарката я вижда);
   Б1 — анулирането мълчеше за начислението, което ОСТАВА в сметката;
   Б2 — препратката акт ↔ протокол сочеше вътрешния номер на реда;
   Б3 — акт с 0 библиотечни документа се съставяше и заемаше номер завинаги;
   В7 — анулирането оставяше събитие „изгубен“ в регистъра на събитията. */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/e2e-app');

let h;
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const T = E.today();
const Y = T.slice(0, 4);
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/* h.printed() слепва съседните клетки с по един интервал — виж
   test/scenario-dokumenti.test.js. */
const seq = (...parts) => new RegExp(parts.map(rx).join('\\s+'));

function mkBook({ inv, title, price, qty, status }) {
  const id = h.db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, status_date)
    VALUES (?, ?, 'Автор', ?, ?, ?, ?)`)
    .run(inv, title, price == null ? 5 : price, T, status || 'наличен', T).lastInsertRowid;
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, qty == null ? 1 : qty);
  h.db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(inv + 1);
  return Number(id);
}
function mkReader(name, card) {
  return Number(h.db.prepare(`INSERT INTO readers (name, card_no, category, status, registered_at)
    VALUES (?, ?, 'възрастен', 'активен', ?)`).run(name, card, T).lastInsertRowid);
}
function openLoan(bookId, readerId, daysAgo) {
  return Number(h.db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(bookId, readerId, E.addDays(T, -(daysAgo || 30)), E.addDays(T, -10)).lastInsertRowid);
}
async function startSess(o) {
  return ok(await h.api.inventorySessions.start(Object.assign({
    date: T, scope: 'целият фонд', department: null,
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка',
    order_no: '7', no: null
  }, o || {})), 'започване на инвентаризация');
}
/* Сканира ВСИЧКО във фонда освен подадените id-та — така проверката е „пълна“
   и несканираното е точно това, което тестът иска да провери. */
async function scanAllExcept(sid, ids) {
  const skip = new Set(ids);
  for (const r of all(`SELECT id, inv_number FROM books WHERE (status != 'отчислен' OR status IS NULL)`)) {
    if (!skip.has(r.id)) await h.api.inventorySessions.scan({ sessionId: sid, code: String(r.inv_number) });
  }
}
const nextNo = async (y) => ok(await h.api.deaccessionActs.nextNo(y || Y), 'следващ № на акт');

/* ================================================================== А1 */
test('А1 — пълната проверка не превръща изгубения от читател в „липсващ“, а протоколът по чл. 40 го обявява на собствен ред', async () => {
  /* Книга, приключена на гишето с „Документът е изгубен“ (обезщетението е
     начислено, състоянието е „изгубен“), физически я няма в библиотеката и не
     може да бъде сканирана. Дотук пълната проверка я вписваше в протокола като
     установена липса и презаписваше състоянието ѝ на „липсващ“ — тоест актът
     излизаше по чл. 30, т. 6 вместо по вярната т. 5, а числото се сравняваше с
     норматива по чл. 41. */
  const lost = mkBook({ inv: 4101, title: 'Изгубена от читател', price: 6 });
  const gone = mkBook({ inv: 4102, title: 'Наистина липсваща', price: 4 });
  const here = mkBook({ inv: 4103, title: 'На рафта', price: 3 });
  const rid = mkReader('Загубчо Загубов', 'A-4101');
  const lid = openLoan(lost, rid);
  ok(await h.api.loans.markLost({ id: lid, resolution: 'обезщетение', amount: 18, date: T }), 'приключване като изгубен');
  assert.equal(q('SELECT status FROM books WHERE id = ?', lost).status, 'изгубен', 'подготовка');

  const sid = await startSess({ no: 41 });
  await scanAllExcept(sid, [lost, gone]);
  const r = ok(await h.api.inventorySessions.close({ sessionId: sid, mode: 'full' }), 'приключване');

  /* 1. Състоянието НЕ е презаписано — то е основанието за акта по чл. 30, т. 5. */
  assert.equal(q('SELECT status FROM books WHERE id = ?', lost).status, 'изгубен',
    'изгубеният от читател остава „изгубен“; „липсващ“ значи „не е намерен при инвентаризация“ (чл. 30, т. 6)');
  assert.equal(q('SELECT status FROM books WHERE id = ?', gone).status, 'липсващ', 'истинската липса си остава липса');
  assert.equal(q('SELECT status FROM books WHERE id = ?', here).status, 'наличен');

  /* 2. Протоколът по чл. 40 брои ЕДНА липса, не две — числото, което се сравнява
        с норматива по чл. 41 и което може да задейства реда по чл. 51 – 53. */
  assert.equal(r.missing, 1, 'липсите по чл. 40 са само наистина ненамереното');
  assert.equal(r.lostBefore, 1, 'изгубеният се връща със собствено число');
  const s = ok(await h.api.inventorySessions.get(sid), 'протокол');
  assert.deepEqual(s.missing.map(m => m.inv_number), [4102],
    'изгубеният от читател не бива да е в таблицата на липсите');

  /* 3. Листът, който се подписва: собствен ред с името на положението, липсите
        без него, и заглавието му го няма в таблицата. */
  await h.go('invent');
  await h.window.printInventProtocol(sid);
  await h.settle();
  const p = h.printed();
  assert.match(p, seq('Липсващи:', '1'));
  assert.match(p, seq('Изгубени от ползватели, установени преди проверката:', '1'));
  assert.ok(p.includes('чл. 30, т. 5'), 'протоколът казва по коя точка се отчисляват те');
  assert.ok(!p.includes('Изгубена от читател'),
    'заглавието на изгубения не бива да стои в списъка на установените липси');
  assert.ok(p.includes('Наистина липсваща'), 'истинската липса се изброява');

  /* 4. И проектът за акт от липсите — по чл. 30, т. 6 — не го взема. */
  h.hooks.confirmAnswer = true;
  await h.window.draftFromMissing(sid);
  await h.settle();
  const d = q('SELECT id, reason_code FROM deaccession_drafts ORDER BY id DESC LIMIT 1');
  assert.equal(d.reason_code, 6);
  const draftInv = all(`SELECT b.inv_number FROM deaccession_draft_items i JOIN books b ON b.id = i.book_id
    WHERE i.draft_id = ? ORDER BY b.inv_number`, d.id).map(x => x.inv_number);
  assert.deepEqual(draftInv, [4102],
    'проектът по чл. 30, т. 6 не бива да предлага изгубения от читател — за него основанието е т. 5');
  ok(await h.api.deaccessionActs.deleteDraft(d.id), 'изчистване');
});

/* ================================================================== А2 */
test('А2 — комисията не утвърждава проекта: разделените екземпляри на липсващия запис остават „липсващ“, а не се връщат във фонда', async () => {
  /* Поправката е в handlers/books.js (чужд файл), но пътят, по който
     библиотекарката я вижда, е ТОЗИ екран: „Проект за акт от липсите“ разделя
     стария многоекземплярен запис. Ако новите редове получат „наличен“,
     подписаният протокол казва „Липсващи: 3“, а програмата веднага брои 1 —
     и ако комисията не утвърди проекта, двата документа остават „наличен“
     завинаги: броят се във фонда, могат да се заемат, влизат в онлайн каталога. */
  const id = mkBook({ inv: 4201, title: 'Стар запис с три екземпляра', price: 4, qty: 3 });
  const sid = await startSess({ no: 42 });
  await scanAllExcept(sid, [id]);
  const r = ok(await h.api.inventorySessions.close({ sessionId: sid, mode: 'full' }), 'приключване');
  assert.equal(r.missing, 3, 'подготовка: протоколът казва „Липсващи: 3“');

  h.hooks.confirmAnswer = true;
  await h.go('invent');
  await h.window.draftFromMissing(sid);
  await h.settle();
  const draft = q('SELECT MAX(id) AS id FROM deaccession_drafts').id;
  ok(await h.api.deaccessionActs.deleteDraft(draft), 'комисията не утвърждава проекта');

  const rows = all(`SELECT inv_number, status FROM books WHERE title = 'Стар запис с три екземпляра'
    ORDER BY inv_number`);
  assert.equal(rows.length, 3, 'записът е разделен на три');
  assert.deepEqual(rows.map(x => x.status), ['липсващ', 'липсващ', 'липсващ'],
    'разделянето на липсващ запис не връща екземплярите във фонда: ' + JSON.stringify(rows));
  const stillMissing = q(`SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n FROM books b
    LEFT JOIN inventory i ON i.book_id = b.id WHERE b.status = 'липсващ' AND b.title = 'Стар запис с три екземпляра'`).n;
  assert.equal(stillMissing, 3, 'подписаният протокол казва „Липсващи: 3“ — програмата трябва да брои същото');
});

/* ================================================================== Б2 */
test('Б2 — актът препраща към „протокол за инвентаризация № 43 / година“ и към датата, а не към вътрешния номер на реда', async () => {
  /* Протоколът излиза от принтера като „ПРОТОКОЛ № 43 / 2026 / 22.09.2026“, а
     актът по чл. 30, т. 6 препращаше към inventory_sessions.id — номер, който
     не се вижда никъде на хартия. Датата не се печаташе НИКОГА, защото се
     четеше от несъществуваща колона `date_end`. Това е единствената връзка
     между акта по чл. 30, т. 6 и протокола по чл. 40. */
  const b = mkBook({ inv: 4301, title: 'За препратката', price: 5 });
  const sid = await startSess({ no: 43 });
  await scanAllExcept(sid, [b]);
  ok(await h.api.inventorySessions.close({ sessionId: sid, mode: 'full' }), 'приключване');
  const sess = q('SELECT id, no, year, date FROM inventory_sessions WHERE id = ?', sid);
  assert.notEqual(sess.id, sess.no, 'подготовка: вътрешният номер и номерът на документа да се различават');

  h.hooks.confirmAnswer = true;
  await h.go('invent');
  await h.window.draftFromMissing(sid);
  await h.settle();
  const d = q('SELECT id, note FROM deaccession_drafts ORDER BY id DESC LIMIT 1');
  assert.match(d.note, new RegExp('протокол за инвентаризация № ' + sess.no + ' ?/ ?' + sess.year),
    'препратката сочи документа, а не реда в базата: „' + d.note + '“');
  assert.ok(d.note.includes(E.bgDate(sess.date)),
    'датата на протокола трябва да се печата — дотук не се печаташе никога: „' + d.note + '“');

  // И актът, който излиза от проекта, носи същата препратка в разпечатката си.
  const actId = ok(await h.api.deaccessionActs.approveDraft({ id: d.id, no: await nextNo() }), 'утвърждаване');
  await h.go('acts');
  await h.window.printActDoc(actId);
  await h.settle();
  const p = h.printed();
  assert.match(p, new RegExp('протокол за инвентаризация № ' + sess.no + ' ?/ ?' + sess.year),
    'подписаният акт трябва да води до протокола — иначе двата документа стоят несвързани');
});

/* ================================================================== Б3 */
test('Б3 — акт върху запис с 0 налични бройки се отказва: номерът по чл. 39 не се заема за документ без предмет', async () => {
  /* Дотук се проверяваше само дали списъкът е празен (bookIds.length), а не
     полученото число документи. Заварена база с изрично вписани 0 бройки
     даваше разпечатка „отчислява от библиотечния фонд 0 библиотечни документа“
     и ред `0 / 0.00 €` в КДБФ Приложение № 3, а номерът остава зает завинаги. */
  const b = mkBook({ inv: 4401, title: 'Нулева бройка', price: 9, qty: 0 });
  const no = await nextNo();
  const actsBefore = q('SELECT COUNT(*) AS n FROM deaccession_acts').n;
  const r = await h.api.deaccessionActs.create({ act: {
    date: T, no, reason_code: 3, reason_text: 'Физически изхабени', disposal: 'унищожени',
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
  }, bookIds: [b] });
  assert.equal(r.ok, false, 'акт с 0 библиотечни документа трябва да бъде отказан');
  assert.ok(r.error.includes('0 библиотечни документа'), 'съобщението назовава проблема: ' + r.error);
  assert.ok(r.error.includes('4401'), 'съобщението назовава виновния инвентарен номер: ' + r.error);
  assert.ok(r.error.includes('Проверка на данните'), 'съобщението назовава изхода: ' + r.error);
  assert.equal(q('SELECT COUNT(*) AS n FROM deaccession_acts').n, actsBefore, 'нищо не е записано');
  assert.equal(await nextNo(), no, 'номерът по чл. 35/чл. 39 остава свободен');
  assert.equal(q('SELECT status FROM books WHERE id = ?', b).status, 'наличен', 'документът не е отчислен');

  // Същият запис, поправен на 1 бройка, минава — отказът е за нулата, не за записа.
  h.db.prepare('UPDATE inventory SET quantity = 1 WHERE book_id = ?').run(b);
  const r2 = await h.api.deaccessionActs.create({ act: {
    date: T, no, reason_code: 3, reason_text: 'Физически изхабени', disposal: 'унищожени',
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
  }, bookIds: [b] });
  assert.equal(r2.ok, true, 'поправената бройка минава: ' + r2.error);
});

/* ================================================================== Б1 */
test('Б1 — анулирането казва на глас какво ОСТАВА в сметката на читателя, с име, сума и накъде да се уреди', async () => {
  /* 21 € обезщетение + 1,70 € забава, платени 3 € → читателят остава задължен
     18 € по ред с бележка „отчислен с акт № N/2026“ — акт, който вече не
     действа. Обработчикът връща keptCharges и reopenedLoans отдавна; екранът
     четеше само droppedHolds и shelvesToRestore и казваше „Актът е анулиран.“ */
  h.db.prepare('UPDATE settings SET fine_per_day = 0.10, lost_price_multiplier = 3 WHERE id = 1').run();
  const b = mkBook({ inv: 4501, title: 'Спорна', price: 7 });
  const rid = mkReader('Спорен Читателев', 'A-4501');
  openLoan(b, rid);
  const actId = ok(await h.api.deaccessionActs.create({ act: {
    date: T, no: await nextNo(), reason_code: 5, reason_text: 'Повредени или невърнати от ползватели',
    disposal: 'унищожени', committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
  }, bookIds: [b] }), 'акт по чл. 30, т. 5');
  ok(await h.api.account.pay({ reader_id: rid, amount: 3, note: 'вноска' }), 'вноска на гишето');

  await h.go('acts');
  await h.window.eval(`openAct(${actId})`);
  await h.settle();
  await h.clickButton('Анулирай акта', '#modal footer');
  await h.waitFor(() => h.$('#revF'), 'формата за анулиране');
  h.type('#revF [name=reason]', 'сгрешен акт');
  const n0 = h.toasts.length;
  await h.clickButton('Анулирай акта', '#modal footer');
  await h.settle();
  const said = h.toastsSince(n0).map(t => t.msg).join(' | ');
  const bal = ok(await h.api.account.get(rid), 'сметка').balance;
  assert.ok(bal > 0, 'подготовка: платеното не се пипа, значи остава дълг');

  assert.match(said, /(начислението ОСТАВА|начисленията ОСТАВАТ)/,
    'съобщението трябва да каже, че начислението остава: „' + said + '“');
  assert.ok(said.includes('Спорен Читателев'), 'с името на читателя: „' + said + '“');
  assert.ok(said.includes('4501'), 'с инвентарния номер: „' + said + '“');
  assert.ok(said.includes(E.mny(bal)) || said.includes(bal.toFixed(2)),
    'със сумата, която остава (' + bal + '): „' + said + '“');
  assert.ok(said.includes('картона на читателя'), 'и накъде да се уреди: „' + said + '“');
  assert.ok(/заемане|заемания/.test(said), 'отвореното обратно заемане също се казва: „' + said + '“');
  assert.equal(h.toastsSince(n0).some(t => t.type === 'warn'), true,
    'това е недовършена работа, не съобщение за успех');
});

/* ------------------------------------------------------------------ Б1 (втори случай) */
test('Б1 — анулирането казва и КОЛКО ОБЩО остава, когато останалите начисления са повече от едно', async () => {
  /* Горният случай има ЕДНО останало начисление — и тогава сборът „Общо
     остават“ е равен на остатъка по единствения ред, тоест числото е вече на
     листа и грешка в самия сбор не личи. Тук актът закрива ДВЕ заемания на
     ДВАМА читатели и оставя ТРИ начисления (обезщетение + забава при единия,
     обезщетение при другия). Само тогава „Общо остават“ е самостоятелно
     число — и трябва да е сборът на ОСТАТЪЦИТЕ, а не на начисленото. */
  h.db.prepare('UPDATE settings SET fine_per_day = 0.10, lost_price_multiplier = 3 WHERE id = 1').run();
  const due = E.addDays(T, -45);
  const fine = Math.round(E.effectiveDaysLate(h.db, due, T) * 0.10 * 100) / 100;
  assert.ok(fine > 1.5, 'контролно: забавата е достатъчна, за да бъде платена само отчасти (' + fine + ' €)');

  const bA = mkBook({ inv: 4801, title: 'Първа спорна', price: 7 });   // обезщетение 21,00 €
  const bB = mkBook({ inv: 4802, title: 'Втора спорна', price: 9 });   // обезщетение 27,00 €
  const rA = mkReader('Първи Читателев', 'A-4801');
  const rB = mkReader('Втори Читателев', 'A-4802');
  for (const [b, r] of [[bA, rA], [bB, rB]]) {
    h.db.prepare('INSERT INTO loans (book_id, reader_id, date_out, date_due) VALUES (?,?,?,?)')
      .run(b, r, E.addDays(T, -90), due);
  }
  const actId = ok(await h.api.deaccessionActs.create({ act: {
    date: T, no: await nextNo(), reason_code: 5, reason_text: 'Повредени или невърнати от ползватели',
    disposal: 'унищожени', committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
  }, bookIds: [bA, bB] }), 'акт по чл. 30, т. 5');

  /* Вноските са нарочно различни. Плащанията покриват най-старото задължение
     първо (chargeCoverage), а актът начислява обезщетението за документа ПРЕДИ
     забавата — затова:
       • Първи Читателев плаща 22,50 € → обезщетението (21,00 €) е покрито
         изцяло, а по забавата остава fine − 1,50 €;
       • Втори Читателев плаща 5,00 € → по обезщетението (27,00 €) остават
         22,00 €, а по забавата му НЕ е плащано нищо и тя пада при анулирането. */
  ok(await h.api.account.pay({ reader_id: rA, amount: 22.5, note: 'вноска' }), 'вноска на първия');
  ok(await h.api.account.pay({ reader_id: rB, amount: 5, note: 'вноска' }), 'вноска на втория');

  await h.go('acts');
  await h.window.eval(`openAct(${actId})`);
  await h.settle();
  await h.clickButton('Анулирай акта', '#modal footer');
  await h.waitFor(() => h.$('#revF'), 'формата за анулиране');
  h.type('#revF [name=reason]', 'сгрешен акт');
  const n0 = h.toasts.length;
  await h.clickButton('Анулирай акта', '#modal footer');
  await h.settle();
  const said = h.toastsSince(n0).map(t => t.msg).join(' | ');

  const balA = ok(await h.api.account.get(rA), 'сметка на първия').balance;
  const balB = ok(await h.api.account.get(rB), 'сметка на втория').balance;
  assert.equal(balA, Math.round((fine - 1.5) * 100) / 100, 'подготовка: по първия остава само неплатената забава');
  assert.equal(balB, 22, 'подготовка: по втория остава неплатеното от обезщетението');
  const остават = Math.round((balA + balB) * 100) / 100;
  const начислено = Math.round((21 + fine + 27) * 100) / 100;
  assert.ok(остават !== balA && остават !== balB && остават !== начислено,
    'контролно: сборът е самостоятелно число — не съвпада с нито един отделен ред');

  assert.match(said, /начисленията ОСТАВАТ/, 'съобщението говори за повече от едно начисление: „' + said + '“');
  assert.ok(said.includes('Първи Читателев') && said.includes('Втори Читателев'),
    'и назовава двамата читатели: „' + said + '“');
  assert.ok(said.includes('остава ' + E.mny(balA)), 'с остатъка по забавата на първия: „' + said + '“');
  assert.ok(said.includes('остава ' + E.mny(balB)), 'и с остатъка по обезщетението на втория: „' + said + '“');
  /* Редът, заради който е всичко: сборът е на ОСТАВАЩОТО, а не на начисленото. */
  assert.ok(said.includes('Общо остават ' + E.mny(остават)),
    'редът „Общо остават“ трябва да сочи ' + E.mny(остават) + ': „' + said + '“');
  assert.ok(!said.includes('Общо остават ' + E.mny(начислено)),
    'и в никакъв случай начисленото (' + E.mny(начислено) + '): „' + said + '“');
});

/* ================================================================== В7 */
test('В7 — анулирането не оставя събитие „изгубен“ в регистъра на събитията', async () => {
  /* След анулирането книгата е във фонда, заемането е отворено, а `events` —
     обявеният източник за отчетите — твърдеше, че документът е изгубен. Едно
     анулиране оставяше завинаги по едно „изгубено“ заглавие в годишната
     статистика на година, в която нищо не е изгубено. */
  const b = mkBook({ inv: 4601, title: 'Събитийна', price: 7 });
  const rid = mkReader('Събитиен Читателев', 'A-4601');
  openLoan(b, rid);
  const actId = ok(await h.api.deaccessionActs.create({ act: {
    date: T, no: await nextNo(), reason_code: 5, reason_text: 'Повредени или невърнати от ползватели',
    disposal: 'унищожени', committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
  }, bookIds: [b] }), 'акт по чл. 30, т. 5');
  assert.equal(all(`SELECT id FROM events WHERE kind = 'изгубен' AND book_id = ?`, b).length, 1,
    'подготовка: актът вписва събитието');

  ok(await h.api.deaccessionActs.revoke(actId, { reason: 'сгрешен акт' }), 'анулиране');
  assert.equal(all(`SELECT id FROM events WHERE kind = 'изгубен' AND book_id = ?`, b).length, 0,
    'книгата е във фонда и заемането е отворено — регистърът не бива да твърди, че е изгубена');
  assert.equal(q('SELECT date_in FROM loans WHERE book_id = ?', b).date_in, null, 'заемането наистина е отворено');
  const trail = q(`SELECT detail FROM audit_log WHERE action = 'Анулиране на акт' ORDER BY id DESC`).detail;
  assert.ok(trail.includes('регистъра на събитията'),
    'промяна в регистъра на събитията не бива да става безследно: „' + trail + '“');
});
