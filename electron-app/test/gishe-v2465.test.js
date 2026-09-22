'use strict';
/* v2.4.65 — четиридесет и втори кръг, област ГИШЕ И ЧИТАТЕЛИ.
   =====================================================================
   По един тест на всяка поправена находка. Всеки твърди онова, което
   БИБЛИОТЕКАРКАТА вижда — числото на печатното писмо по чл. 43, реда в панела
   на „Просрочени“, текста на отказа на гишето, етикета в списъка с читатели,
   реда в одитната следа — а не вътрешната форма на данните. Всеки е проверен с
   връщане на поправката назад: без нея пада.

   А3  Напомнителното писмо по чл. 43 искаше пари, които читателят е платил.
   А4  Намерената книга нямаше път обратно: оставаше в списъка за акт по
       чл. 30, т. 5, а обезщетението висеше по сметката.
   А9  Заварените читатели без съгласие по чл. 47, ал. 2 спираха гишето и нямаше
       как да бъдат намерени; отбелязването записваше днешната дата вместо
       датата на подписа.
   Б4  Дете до 14 г. се записваше и заемаше без съгласие на родител/настойник.
   Б5  Изтриването на читател БЕЗ история не оставяше нито ред в одитната следа.
   В6  Етикетите по диапазон мълчаха за липсващите и отчислените номера, а
       екранът искаше и двете граници, макар обработчикът да поддържа отворен
       диапазон. */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + res.error); return res.data; };

function mkBook(inv, o = {}) {
  const id = Number(h.db.prepare(`INSERT INTO books (inv_number, title, author, barcode, price, status, register_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(inv, o.title || ('Книга ' + inv), o.author || 'Автор, А.', o.barcode || ('BC' + inv),
      o.price == null ? 10 : o.price, o.status || 'наличен', '2026-01-05').lastInsertRowid);
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
  return id;
}
function mkReader(name, card, o = {}) {
  return Number(h.db.prepare(`INSERT INTO readers (name, card_no, category, status, gdpr_consent, parent_consent, registered_at)
    VALUES (?, ?, ?, 'активен', ?, ?, '2026-01-02')`)
    .run(name, card, o.category || 'възрастен', o.gdpr_consent == null ? 1 : o.gdpr_consent,
      o.parent_consent == null ? 0 : o.parent_consent).lastInsertRowid);
}
function mkLoan(readerId, bookId, out, due) {
  h.db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)').run(readerId, bookId, out, due);
  return Number(q('SELECT id FROM loans WHERE reader_id = ? AND book_id = ? ORDER BY id DESC', readerId, bookId).id);
}

/* ==================================================================
   А3. Писмото по чл. 43 не иска пари, които читателят е платил на гишето
   ================================================================== */
test('А3 — платеното на гишето се приспада на екрана, в печатното писмо и в SMS-а', async () => {
  h.db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const r = mkReader('Платила Просрочева', 'A3');
  const b = mkBook(4301);
  const lid = mkLoan(r, b, E.addDays(T, -60), E.addDays(T, -30));

  /* Библиотекарката продължава срока от „Просрочени“ — начислява се забавата и
     влиза в читателската сметка (v2.4.61). */
  ok(await h.api.loans.extend({ id: lid }), 'продължение');
  const dueOnCounter = ok(await h.api.account.get(r), 'сметка').balance;
  assert.ok(dueOnCounter > 0, 'начислената забава влиза в сметката');
  // Читателят плаща всичко на същото гише.
  ok(await h.api.account.pay({ reader_id: r, amount: dueOnCounter, date: T }), 'плащане');
  assert.equal(ok(await h.api.account.get(r), 'сметка').balance, 0, 'по сметката не се дължи нищо');

  // След време заемането пак е просрочено — новите дни се смятат по СЪЩИЯ
  // календар, по който ще ги начисли и гишето (затворените дни отпадат).
  const newDue = E.addDays(T, -4);
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(newDue, lid);
  const остава = Math.round(E.effectiveDaysLate(h.db, newDue, T) * 0.10 * 100) / 100;
  const начислено = Math.round((dueOnCounter + остава) * 100) / 100;
  assert.ok(остава > 0 && остава < dueOnCounter, 'контролно: остатъкът е по-малък от вече платеното');

  const row = ok(await h.api.loans.overdue(), 'просрочени').find(x => x.id === lid);
  const letter = ok(await h.api.loans.overdueByReader(), 'писмо').find(x => x.reader_id === r);
  const rem = ok(await h.api.loans.reminders(), 'напомняния').find(x => x.reader_id === r);

  assert.equal(row.fine, остава, 'екранът „Просрочени“ иска само новите дни');
  assert.equal(letter.fine, остава, 'печатното писмо по чл. 43 иска само новите дни');
  assert.equal(Number(rem.fine.toFixed(2)), остава, 'SMS-ът/имейлът искат същото');
  assert.equal(letter.finePaid, dueOnCounter, 'писмото знае колко е платено');
  assert.equal(letter.fineAccrued, начислено, 'и колко е начислено общо');

  // Текстът, който тръгва по пощата/SMS-а — и трите числа, назовани с думи.
  assert.match(rem.body, new RegExp('остава да се плати ' + остава.toFixed(2) + ' €'), 'писмото казва какво остава');
  assert.match(rem.body, /от тях платени/, 'и че част е платена');
  assert.ok(!rem.sms.includes('обезщетение ' + начислено.toFixed(2) + ' €'), 'SMS-ът не иска платеното');
  assert.match(rem.sms, new RegExp('обезщетение ' + остава.toFixed(2) + ' €'), 'SMS-ът иска остатъка');

  // Екранът „Просрочени“ — това, което библиотекарката чете.
  await h.go('over');
  const screen = h.text('#view');
  assert.match(screen, new RegExp('Общо дължимо обезщетение: ' + остава.toFixed(2) + ' €'), 'жълтата кутия иска остатъка');
  assert.match(screen, /вече платени/, 'и назовава платеното, за да не изглежда разликата като изгубени пари');

  // Печатният лист по чл. 43 — числото, което се подава на читателя за подпис.
  await h.clickButton('Печат на напомняния / PDF', '#view');
  await h.settle();
  const printed = h.printed();
  assert.match(printed, new RegExp('Общо дължимо обезщетение: ' + остава.toFixed(2) + ' €'), 'писмото иска остатъка');
  assert.ok(!printed.includes('Общо дължимо обезщетение: ' + начислено.toFixed(2) + ' €'),
    'писмото НЕ иска вече платеното');
  assert.match(printed, /платено по читателската сметка/, 'листът обяснява разликата');
  if (h.window.ppClose) h.window.ppClose();
  await h.settle();
});

/* ------------------------------------------------------------------
   А3 (втори случай). ЧАСТИЧНО платената забава.
   ------------------------------------------------------------------
   Горният тест работи с ИЗЦЯЛО платена забава — а тогава приспаднатото е
   равно на цялото начислено и всяко разминаване в самото приспадане се губи:
   „нула вместо всичко“ и „нула вместо нула“ изглеждат еднакво на екрана.
   Тук читателят е платил ЧАСТ (1,00 € от начислените ~6 €), тоест остатъкът
   е трето число, различно и от начисленото, и от новите дни — и трябва да е
   едно и също на трите места, откъдето тръгва искането към читателя:
   екранът „Просрочени“, печатното писмо по чл. 43 и напомнянето по
   пощата/SMS. */
test('А3 — платеното на гишето се приспада и когато е ЧАСТИЧНО: и трите места искат точно остатъка', async () => {
  h.db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const r = mkReader('Частично Платилов', 'A3b');
  const b = mkBook(4302);
  const lid = mkLoan(r, b, E.addDays(T, -120), E.addDays(T, -90));

  // Продължението начислява забавата и я вписва в читателската сметка (v2.4.61).
  ok(await h.api.loans.extend({ id: lid }), 'продължение');
  const начислено0 = ok(await h.api.account.get(r), 'сметка').balance;
  assert.equal(начислено0, Number(q('SELECT fine FROM loans WHERE id = ?', lid).fine),
    'контролно: начисленото по заемането и редът в сметката са едно и също число');
  assert.ok(начислено0 > 2, 'контролно: има какво да се плати само отчасти (' + начислено0 + ' €)');

  // Читателят плаща 1,00 € на гишето — останалото остава да се дължи.
  const платено = 1;
  ok(await h.api.account.pay({ reader_id: r, amount: платено, date: T }), 'частична вноска');
  const неплатено = Math.round((начислено0 - платено) * 100) / 100;
  assert.equal(ok(await h.api.account.get(r), 'сметка').balance, неплатено,
    'по сметката остава разликата, а не цялото начислено');

  // След време заемането пак е просрочено — новите дни се смятат по същия календар.
  const newDue = E.addDays(T, -4);
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(newDue, lid);
  const нови = Math.round(E.effectiveDaysLate(h.db, newDue, T) * 0.10 * 100) / 100;
  const остава = Math.round((неплатено + нови) * 100) / 100;
  const начислено = Math.round((начислено0 + нови) * 100) / 100;
  assert.ok(нови > 0 && остава > нови && остава < начислено,
    'контролно: остатъкът е ТРЕТО число — по-голям от новите дни и по-малък от начисленото');

  const row = ok(await h.api.loans.overdue(), 'просрочени').find(x => x.id === lid);
  const letter = ok(await h.api.loans.overdueByReader(), 'писмо').find(x => x.reader_id === r);
  const rem = ok(await h.api.loans.reminders(), 'напомняния').find(x => x.reader_id === r);

  /* 1. Екранът „Просрочени“. */
  assert.equal(row.fine, остава, 'екранът иска неплатеното + новите дни, а не цялото начислено');
  assert.equal(row.finePaid, платено, 'и знае колко е платено');
  assert.equal(row.fineAccrued, начислено, 'и колко е начислено общо');
  /* 2. Печатното писмо по чл. 43. */
  assert.equal(letter.fine, остава, 'печатното писмо иска същия остатък');
  assert.equal(letter.finePaid, платено, 'писмото знае колко е платено');
  assert.equal(letter.fineAccrued, начислено, 'и колко е начислено общо');
  /* 3. Напомнянето по пощата/SMS. */
  assert.equal(Number(rem.fine.toFixed(2)), остава, 'SMS-ът/имейлът искат същото');
  assert.equal(Number(rem.finePaid.toFixed(2)), платено, 'и знаят за вноската');
  assert.equal(Number(rem.fineAccrued.toFixed(2)), начислено, 'и за начисленото');

  // Текстът, който тръгва към читателя — и трите числа, назовани с думи.
  assert.match(rem.body, new RegExp('Начислено обезщетение към днешна дата: ' + начислено.toFixed(2) + ' €'),
    'писмото казва колко е начислено');
  assert.match(rem.body, new RegExp('от тях платени ' + платено.toFixed(2) + ' €'), 'и колко е платено');
  assert.match(rem.body, new RegExp('остава да се плати ' + остава.toFixed(2) + ' €'), 'и какво остава');
  assert.match(rem.sms, new RegExp('обезщетение ' + остава.toFixed(2) + ' €'), 'SMS-ът иска остатъка');
  assert.ok(!rem.sms.includes('обезщетение ' + начислено.toFixed(2) + ' €'), 'SMS-ът не иска платеното');

  // Екранът, който библиотекарката чете: редът показва остатъка, а под него — разбивката.
  await h.go('over');
  const screen = h.text('#view');
  assert.ok(screen.includes('начислено ' + E.mny(начислено) + ', платено ' + E.mny(платено)),
    'редът на заемането казва начислено/платено: ' + screen.slice(0, 400));

  // Печатният лист по чл. 43 — числото, което се подава на читателя за подпис.
  await h.clickButton('Печат на напомняния / PDF', '#view');
  await h.settle();
  const printed = h.printed();
  assert.ok(printed.includes('Начислено обезщетение към днешна дата: ' + E.mny(начислено)),
    'листът казва начисленото');
  assert.ok(printed.includes('платено по читателската сметка: ' + E.mny(платено)),
    'и платеното по читателската сметка');
  assert.ok(printed.includes('Общо дължимо обезщетение: ' + E.mny(остава)),
    'а в реда „Общо дължимо“ стои ОСТАТЪКЪТ: ' + printed.slice(0, 600));
  assert.ok(!printed.includes('Общо дължимо обезщетение: ' + E.mny(начислено)),
    'писмото НЕ иска вече платеното');
  if (h.window.ppClose) h.window.ppClose();
  await h.settle();
});

/* ==================================================================
   А4. Намерената книга има път обратно
   ================================================================== */
test('А4 — „Документът се намери“ сваля реда от списъка за акт, сторнира обезщетението, забавата остава', async () => {
  h.db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const r = mkReader('Намерена Книгова', 'A4');
  const b = mkBook(4401, { price: 10 });
  const lid = mkLoan(r, b, E.addDays(T, -90), E.addDays(T, -60));
  const quote = ok(await h.api.loans.lostQuote({ id: lid }), 'оферта');
  ok(await h.api.loans.markLost({ id: lid, resolution: 'обезщетение', amount: quote.suggested, date: T }), 'изгубен');

  const balLost = ok(await h.api.account.get(r), 'сметка').balance;
  assert.ok(balLost >= quote.suggested, 'обезщетението виси по сметката');
  assert.equal(q('SELECT status FROM books WHERE id = ?', b).status, 'изгубен');
  assert.equal(ok(await h.api.loans.lost({}), 'списък').filter(x => x.id === lid).length, 1);

  // Панелът на „Просрочени“ носи бутона до реда.
  await h.go('over');
  assert.match(h.text('#ovLost'), /Документът се намери/, 'бутонът стои до реда в панела');
  /* И НАТИСКАНЕТО МУ ВОДИ НЯКЪДЕ. Надписът сам по себе си не е път обратно:
     бутон без onclick изглежда точно така, а библиотекарката го натиска и не
     става нищо. Затова се натиска наистина и се проверява, че прозорецът се е
     отворил — с името на документа и с двата изхода, които предлага. */
  await h.clickButton('Документът се намери', '#ovLost');
  await h.waitFor(() => h.$('#foundF'), 'прозорецът „Документът се намери“');
  assert.equal(h.modalOpen(), true, 'натискането на бутона отваря прозорец, а не мълчи');
  const dlg = h.modal();
  assert.match(dlg, /Документът се намери — инв\. № 4401/, 'прозорецът назовава документа: ' + dlg);
  assert.match(dlg, /Намерена Книгова/, 'и читателя, у когото е бил');
  assert.match(dlg, /Сторнирай начисленото обезщетение/, 'и предлага сторнирането като отметка');
  h.window.closeModal();
  await h.settle();

  const res = ok(await h.api.loans.found({ id: lid, reverseCharge: true, date: T, note: 'намерен при подреждане' }), 'намери се');

  assert.equal(ok(await h.api.loans.lost({}), 'списък').filter(x => x.id === lid).length, 0,
    'редът излиза от списъка за акт по чл. 30, т. 5');
  assert.equal(q('SELECT status FROM books WHERE id = ?', b).status, 'наличен', 'документът се връща във фонда');
  assert.equal(q('SELECT lost, lost_account_line_id FROM loans WHERE id = ?', lid).lost, null, 'белегът „изгубен“ е свален');
  assert.equal(res.reversed, quote.suggested, 'обезщетението за документа е сторнирано');
  assert.equal(all("SELECT id FROM account_lines WHERE reader_id = ? AND type = 'обезщетение за изгубен документ'", r).length, 0,
    'редът за обезщетението го няма в сметката');
  // Забавата остава дължима — дните са били факт.
  const fineLeft = Number(q('SELECT fine FROM loans WHERE id = ?', lid).fine) || 0;
  assert.ok(fineLeft > 0, 'начислената забава остава по заемането');
  assert.equal(ok(await h.api.account.get(r), 'сметка').balance, fineLeft, 'и по сметката остава само тя');
  // Събитието „изгубен“ не описва факт, който се е случил.
  assert.equal(all("SELECT id FROM events WHERE kind = 'изгубен' AND book_id = ?", b).length, 0,
    'събитието „изгубен“ е премахнато — иначе отчетът брои изгубено заглавие');
  const a = q("SELECT detail FROM audit_log WHERE action = 'Документът се намери' ORDER BY id DESC LIMIT 1");
  assert.ok(a, 'има ред в одитната следа');
  assert.match(a.detail, /инв\. № 4401/);
  assert.match(a.detail, /Намерена Книгова/);
  assert.match(a.detail, /сторнирано/);
  assert.match(a.detail, /ОСТАВА дължима/, 'следата казва, че забавата остава');

  // Документът пак се заема — доказателство, че наистина е върнат във фонда.
  ok(await h.api.loans.checkoutByCode({ reader_id: r, code: 'BC4401', date_out: T }), 'ново заемане');
});

test('А4 — вече отчисленият с акт документ НЕ минава оттук, а през анулиране на акта', async () => {
  const r = mkReader('Актов Отчислен', 'A4b');
  const b = mkBook(4402, { price: 12 });
  const lid = mkLoan(r, b, E.addDays(T, -120), E.addDays(T, -90));
  const quote = ok(await h.api.loans.lostQuote({ id: lid }), 'оферта');
  ok(await h.api.loans.markLost({ id: lid, resolution: 'обезщетение', amount: quote.suggested, date: T }), 'изгубен');
  const no = ok(await h.api.deaccessionActs.nextNo(2026), 'номер');
  ok(await h.api.deaccessionActs.create({
    act: { no, date: T, reason_code: 5, reason_text: 'повредени или невърнати от ползватели', commission: 'Комисия', note: '' },
    bookIds: [b]
  }), 'акт');

  const res = await h.api.loans.found({ id: lid, reverseCharge: true, date: T });
  assert.equal(res.ok, false, 'отказва се');
  assert.match(res.error, /ОТЧИСЛЕН/, 'казва защо');
  assert.match(res.error, /АНУЛИРАНЕ НА АКТА/, 'и назовава верния път');
  assert.match(res.error, /Отчисляване/, 'и откъде се минава');
});

/* ==================================================================
   А9. Заварените читатели без съгласие се намират наведнъж, с датата на подписа
   ================================================================== */
test('А9 — „Читатели“ има филтър, етикет и брояч „без съгласие“', async () => {
  // Заварени редове: колоната съществува, но никой не я е пипал (база отпреди v2.2.0).
  mkReader('Заварен Единов', 'Z1', { gdpr_consent: 0 });
  mkReader('Заварен Двоев', 'Z2', { gdpr_consent: 0 });

  const page = ok(await h.api.readers.list('', null, { offset: 0, limit: 300 }), 'списък');
  assert.ok(page.noConsent >= 2, 'броячът казва колко читатели не могат да заемат');
  const only = ok(await h.api.readers.list('', null, { offset: 0, limit: 300, consent: 'no' }), 'филтър');
  assert.equal(only.total, page.noConsent, 'филтърът и броячът питат едно и също');
  assert.ok(only.rows.every(x => !x.gdpr_consent || (x.category === 'дете до 14 г.' && !x.parent_consent)),
    'във филтъра влизат само читатели без отбелязано съгласие');

  await h.go('readers');
  const screen = h.text('#view');
  assert.match(screen, /нямат\s+отбелязано съгласие/, 'предупреждението над списъка ги брои');
  assert.match(screen, /впишете датата, на която ползвателят се е\s+подписал/i, 'и казва изхода, включително датата');
  assert.match(screen, /без съгласие: чл\. 47, ал\. 2/, 'редът носи етикет');
  assert.ok(h.$('#rConsentFilter'), 'падащият филтър го има в лентата');

  // „Покажи ги“ свива списъка до тях.
  await h.clickButton('Покажи ги', '#view');
  assert.match(h.text('#view'), /Показани са само читателите без отбелязано съгласие/);
  const rows = h.$('#rBody').querySelectorAll('tr');
  assert.ok(rows.length >= 2, 'в списъка стоят точно заварените');
  assert.ok(!h.text('#rBody').includes('Платила Просрочева'), 'читателите със съгласие отпадат');
  await h.clickButton('Покажи всички', '#view');
});

test('А9 — картон, подписан през 2019 г., получава датата на подписа, не днешната', async () => {
  const id = mkReader('Заварен Подписов', 'Z3', { gdpr_consent: 0 });
  const r = ok(await h.api.readers.get(id), 'картон');
  ok(await h.api.readers.update(Object.assign({}, r, {
    gdpr_consent: 1, gdpr_consent_date: '2019-04-15'
  })), 'отбелязване');
  assert.equal(q('SELECT gdpr_consent_date FROM readers WHERE id = ?', id).gdpr_consent_date, '2019-04-15',
    'записва се датата на подписа, а не днешната');
  // Полето го има и във формата, с подсказка за заварените картони.
  await h.go('readers');
  await h.window.eval('readerForm(' + id + ')');
  await h.settle();
  const form = h.text('#modal');
  assert.match(form, /Дата на подписа \(съгласие по чл\. 47, ал\. 2\)/, 'формата има поле за датата');
  assert.match(form, /за заварен читател впишете старата дата/, 'и казва за какво е');
  h.window.closeModal();
  await h.settle();

  // Бъдеща дата на подпис не съществува и се отказва с обяснение.
  const r2 = ok(await h.api.readers.get(id), 'картон');
  const bad = await h.api.readers.update(Object.assign({}, r2, { gdpr_consent_date: E.addDays(T, 5) }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /в бъдещето/);
});

/* ==================================================================
   Б4. Дете до 14 г. без съгласие на родител/настойник
   ================================================================== */
test('Б4 — дете до 14 г. не се записва и не заема без съгласие на родител/настойник', async () => {
  const created = await h.api.readers.create({
    name: 'Ани Детска', card_no: 'B4', category: 'дете до 14 г.', status: 'активен',
    gdpr_consent: 1, parent_consent: 0,
    guarantor_name: 'Петя Детска', guarantor_relation: 'родител', guarantor_phone: '0888000111'
  });
  assert.equal(created.ok, false, 'записът се отказва');
  assert.match(created.error, /родител\/настойник/);
  assert.match(created.error, /не от детето/, 'съобщението казва защо');

  // Заварено дете (вписано преди правилото) не заема, но пътят напред е назован.
  const kid = mkReader('Заварено Детенце', 'B4b', { category: 'дете до 14 г.', gdpr_consent: 1, parent_consent: 0 });
  mkBook(4404);
  const co = await h.api.loans.checkoutByCode({ reader_id: kid, code: 'BC4404', date_out: T });
  assert.equal(co.ok, false, 'гишето отказва');
  assert.match(co.error, /съгласие на родител\/настойник/);
  assert.match(co.error, /филтър „без съгласие“/, 'отказът назовава къде се намират всички такива картони');

  // Кутията на гишето се обажда ПРЕДИ сканирането на книгата.
  await h.go('circ');
  h.window.eval('CIRC.readerId = ' + kid + '; renderCirc()');
  await h.settle();
  const screen = h.text('#view');
  assert.match(screen, /Няма отбелязано съгласие на родител\/настойник/, 'червената кутия стои на гишето');
  assert.match(screen, /Отвори картона/, 'и води към мястото, където се оправя');

  // С отбелязано съгласие — заема.
  const got = ok(await h.api.readers.get(kid), 'картон');
  ok(await h.api.readers.update(Object.assign({}, got, { parent_consent: 1, parent_consent_date: '2025-09-01' })), 'отбелязване');
  assert.equal(q('SELECT parent_consent_date FROM readers WHERE id = ?', kid).parent_consent_date, '2025-09-01',
    'и тук се записва датата на подписа на родителя');
  ok(await h.api.loans.checkoutByCode({ reader_id: kid, code: 'BC4404', date_out: T }), 'заемане след отбелязването');
});

/* ==================================================================
   Б5. Изтриването на читател БЕЗ история оставя ред в одитната следа
   ================================================================== */
test('Б5 — изтрит читател без история оставя ред в одитната следа, с името и картата', async () => {
  const id = ok(await h.api.readers.create({
    name: 'Тихо Изчезнал', card_no: 'B5', gdpr_consent: 1,
    phone: '0888777666', address: 'ул. Тиха 3', egn: '7001011234'
  }), 'нов читател');
  const before = q('SELECT COUNT(*) AS n FROM audit_log').n;
  ok(await h.api.readers.delete(id), 'изтриване');
  assert.equal(q('SELECT COUNT(*) AS n FROM readers WHERE id = ?', id).n, 0, 'читателят е изтрит');
  assert.equal(q('SELECT COUNT(*) AS n FROM audit_log').n, before + 1, 'изтриването оставя точно един ред');
  const a = q("SELECT action, detail, diff FROM audit_log ORDER BY id DESC LIMIT 1");
  assert.equal(a.action, 'Изтрит читател');
  assert.match(a.detail, /Тихо Изчезнал/, 'следата назовава кой запис е изчезнал');
  assert.match(a.detail, /карта B5/, 'и по коя карта');
  assert.match(a.detail, /без история/, 'и различава двата случая');
  // ЕГН, телефон и адрес НЕ влизат в следата — тя се изнася в CSV.
  assert.ok(!/7001011234|0888777666|Тиха/.test(a.detail + (a.diff || '')), 'най-чувствителните данни не се удвояват в следата');
});

/* ==================================================================
   В6. Етикетите по диапазон казват колко излизат от колко искани и защо
   ================================================================== */
test('В6 — липсващите и отчислените номера се казват, а диапазонът може да е отворен', async () => {
  // Диапазон 6001–6006: № 6003 е отчислен, № 6004 изобщо не съществува.
  for (const n of [6001, 6002, 6003, 6005, 6006]) mkBook(n, { title: 'Етикет ' + n });
  h.db.prepare("UPDATE books SET status = 'отчислен', deaccession_date = ? WHERE inv_number = 6003").run(T);

  await h.go('labels');
  h.type('[name=lblFrom]', '6001');
  h.type('[name=lblTo]', '6006');
  h.hooks.confirmAnswer = false;               // библиотекарката се отказва след обяснението
  const c0 = h.hooks.confirms.length;
  await h.window.printLabelsRange();
  await h.settle();

  const said = h.hooks.confirms.slice(c0).join('\n');
  assert.match(said, /От 6 поискани инвентарни номера/, 'казва от колко искани');
  assert.match(said, /ще излязат 4 етикета/, 'и колко излизат');
  assert.match(said, /Липсват 2 номера: 6003, 6004/, 'и кои точно липсват');
  assert.match(said, /отчислен от фонда/, 'и защо — отчислените нарочно не получават етикет');
  assert.match(said, /не е заведен\s+в инвентарната книга/, 'и другата възможна причина');

  /* Отвореният диапазон („от 6005 нататък“) минава — обработчикът го поддържа,
     а екранът дотук отказваше всичко без ДВЕТЕ граници и без нулата. */
  h.type('[name=lblFrom]', '6005');
  h.type('[name=lblTo]', '');
  const n0 = h.toasts.length;
  h.hooks.confirmAnswer = true;
  await h.window.printLabelsRange();
  await h.settle();
  const errs = h.toastsSince(n0).filter(t => t.type === 'err').map(t => t.msg).join('\n');
  assert.ok(!/Въведете валиден диапазон/.test(errs), 'отвореният диапазон не се отказва');
  assert.ok(h.$('#ppSheet'), 'печатът се отваря');
  if (h.window.ppClose) h.window.ppClose();
  await h.settle();

  // И нулата е начало като всяко друго число.
  h.type('[name=lblFrom]', '0');
  h.type('[name=lblTo]', '6002');
  const n1 = h.toasts.length;
  await h.window.printLabelsRange();
  await h.settle();
  const errs2 = h.toastsSince(n1).filter(t => t.type === 'err').map(t => t.msg).join('\n');
  assert.ok(!/Въведете валиден диапазон/.test(errs2), '0 е валидно начало на диапазон');
  if (h.window.ppClose) h.window.ppClose();
  await h.settle();
});

/* ------------------------------------------------------------------
   В6 (втори случай). ГРАНИЦИТЕ — закована всяка поотделно.
   ------------------------------------------------------------------
   Горният тест търси СТАРОТО съобщение за отказ („Въведете валиден
   диапазон“) — а то вече го няма в кода, тоест проверката минава и когато
   формата се откаже с НОВОТО съобщение („… не е инвентарен номер“). Тук и
   трите гранични случая се проверяват по това, което трябва да СТАНЕ:
   листът за печат наистина се сглобява и носи точните номера.
   ВНИМАНИЕ ЗА #ppSheet: този възел стои постоянно в src/index.html и
   съществува винаги — `h.$('#ppSheet')` е истина и когато печат изобщо не е
   имало. Затова тук се чисти преди всеки случай и се гледа СЪДЪРЖАНИЕТО
   (h.printed()), а не наличието на възела. */
test('В6 — липсващите граници не са грешка: празно „от“, празно „до“ и нулата стигат до печат', async () => {
  for (const n of [6101, 6102, 6103]) mkBook(n, { title: 'Граничен ' + n });

  await h.go('labels');
  const clearSheet = async () => {
    if (h.window.ppClose) h.window.ppClose();
    await h.settle();
    assert.equal(h.printed(), '', 'контролно: листът за преглед е изчистен преди случая');
  };
  /* Един случай: попълва двете полета, натиска и връща (грешките, листът). */
  async function printRange(from, to) {
    await clearSheet();
    h.type('[name=lblFrom]', from);
    h.type('[name=lblTo]', to);
    h.hooks.confirmAnswer = true;
    const n0 = h.toasts.length;
    await h.window.printLabelsRange();
    await h.settle();
    return {
      errs: h.toastsSince(n0).filter(t => t.type === 'err').map(t => t.msg).join('\n'),
      sheet: h.printed()
    };
  }

  // 1. Празна ГОРНА граница: „от 6101 нататък“.
  const open2 = await printRange('6101', '');
  assert.equal(open2.errs, '', 'празното „до“ не е грешка: ' + open2.errs);
  assert.ok(open2.sheet.includes('6101') && open2.sheet.includes('6103'),
    'листът носи етикетите от 6101 нататък: „' + open2.sheet.slice(0, 200) + '“');

  // 2. Празна ДОЛНА граница: „до 6102“.
  const open1 = await printRange('', '6102');
  assert.equal(open1.errs, '', 'празното „от“ не е грешка: ' + open1.errs);
  assert.ok(open1.sheet.includes('6101') && open1.sheet.includes('6102'),
    'листът носи етикетите до 6102: „' + open1.sheet.slice(0, 200) + '“');
  assert.ok(!open1.sheet.includes('6103'), 'и спира на горната граница');

  // 3. Нулата е начало като всяко друго число: „от 0 до 6102“.
  const zero = await printRange('0', '6102');
  assert.equal(zero.errs, '', '0 е валидно начало на диапазон, а не „не е инвентарен номер“: ' + zero.errs);
  assert.ok(zero.sheet.includes('6101') && zero.sheet.includes('6102'),
    'и листът от 0 до 6102 излиза: „' + zero.sheet.slice(0, 200) + '“');

  // 4. Контрола отзад: истински невалидна граница ПАК се отказва и не печата.
  const bad = await printRange('6101', 'шест хиляди');
  assert.match(bad.errs, /не е инвентарен номер/, 'буквите си остават грешка: ' + bad.errs);
  assert.equal(bad.sheet, '', 'и печат не се отваря');

  if (h.window.ppClose) h.window.ppClose();
  await h.settle();
});
