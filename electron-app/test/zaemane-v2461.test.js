'use strict';
/* Одитен кръг v2.4.61 — ЗАЕМАНЕ И ВРЪЩАНЕ: КОМУ СЕ ЗАЕМА, С КОИ ДАТИ И КЪДЕ
 * ОТИВАТ ПАРИТЕ.
 * =====================================================================
 * По едно твърдение на находка, наречено с дефекта, не с кода:
 *
 *   1) Читател със състояние „прекратен“ заемаше през двете врати (loans:checkout
 *      и loans:checkoutByCode) — гледаше се само наказанието, не и readers.status.
 *   2) readers:create приемаше читател БЕЗ съгласие по чл. 47, ал. 2 и ОРЗД (само
 *      екранната форма отказваше, тоест вносът, мобилният път и API-то минаваха),
 *      и такъв читател после спокойно заемаше.
 *   3) Заемане с дата в БЪДЕЩЕТО и с падеж ПРЕДИ датата на заемане се приемаха —
 *      второто ражда заемането просрочено и то трупа обезщетение по чл. 43 за
 *      период, който не е течал.
 *   4) Връщане с дата в БЪДЕЩЕТО (влиза в следващата отчетна година, защото
 *      отчетът брои връщанията по date_in) и с дата ПРЕДИ заемането се приемаха.
 *   5) Одитната следа на заемането не назоваваше читателя, а на продължението —
 *      нито документа, нито читателя („заемане № 12 до 2026-10-15 (1/2)“).
 *   6) loans.fine лягаше в базата незакръглен (0.7000000000000001).
 *   7) Обезщетението за ЗАБАВА по чл. 43 не стигаше до читателската сметка, а
 *      обезщетението за изгубен документ — стигаше; двете са едно и също
 *      задължение, водено на две места.
 *   8) readers:clearSuspension на несъществуващ читател връщаше ok и вписваше
 *      „Снето наказание: читател № 99999“ в одитната следа.
 *   9) Напомнянето за читател под 14 г. отиваше при детето — с текста, с
 *      телефона и с предупреждението за преустановяване на достъпа, — докато
 *      самата форма за читател казва, че отговорността и контактът са на
 *      родителя/настойника.
 *  10) Читателският картон печаташе „Върнат на <дата>“ за заемане, приключено
 *      като изгубено или закрито от акт за отчисляване.
 *  11) Заемане на несъществуващ читател излизаше с общото съобщение за външен
 *      ключ („записът е свързан с други данни“).
 *  12) „Инв. № 1 вече е зает от … до 2026-10-01.“ — ISO дата насред екран, който
 *      навсякъде другаде пише 01.10.2026.
 *  13) (одит на печатните документи) Напомнителното писмо по чл. 43 нямаше дата,
 *      макар да иска сума „към днешна дата“ и да заплашва с наказание.
 *  14) (подобрение) „Днес на гишето“ броеше ВПИСАНОТО днес, а заглавието обещаваше
 *      свършеното днес.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, freshDb, fakeIpcMain, runDep, cleanupTmpDirs } = require('./helpers/audit-fixtures');
const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values');

test.after(cleanupTmpDirs);

const TODAY = '2026-09-18';
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* Истинските handlers/loans + handlers/readers + handlers/notices върху прясна
   база. Календарът е „всеки ден работен, няма затворени дни“ — този файл проверява
   правила, не календарна аритметика (за нея са loans-real-calendar и сценарият).
   handlers/account.js НЕ се регистрира: заеманията го внасят пряко (chargeLost /
   chargeOverdueFine / chargeCoverage) и той не се нуждае от IPC. */
function setup(prefix, opts = {}) {
  const { db } = freshDb(prefix || 'inv-zaem-v2461-');
  db.prepare('UPDATE settings SET fine_per_day = 0.10, loan_days = 14, max_books = 5 WHERE id = 1').run();
  const audit = [];
  const events = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db, run: runDep,
    logAudit: (action, detail) => audit.push({ action, detail }),
    today: () => opts.today || TODAY,
    logEvent: (kind, o) => events.push(Object.assign({ kind }, o)),
    BOOK_SELECT, normalizeScanCode,
    scheduleCatalogWrite: () => {},
    circRule: () => Object.assign({ loan_days: 14, max_books: 5, extensions_count: 2, extension_days: 14,
      suspend_per_day: 1, suspend_max: 90 }, opts.rule || {}),
    readerCategory: (id) => (db.prepare('SELECT category FROM readers WHERE id = ?').get(id) || {}).category || 'възрастен',
    nextWorkDay: (d) => d,
    closedDaysBetween: () => 0,
    firstActiveHold: () => null,
    activeHolds: () => [],
    freeCopies: () => 1,
    consumeHoldOnCheckout: () => {},
    activateHoldOnReturn: () => null
  };
  const { LOAN_SELECT, effectiveDaysLate } = require(path.join(APP_DIR, 'handlers', 'loans'))(ipcMain, deps);
  require(path.join(APP_DIR, 'handlers', 'readers'))(ipcMain, Object.assign({}, deps, {
    ftsQuery: (q) => q, maskReaderRow: (r) => r, maskReaderRows: (r) => r,
    preparePiiForWrite: () => {}, diffFields: () => [], checkRecordLimit: () => {},
    dialog: {}, getMainWindow: () => ({}), fs, csvCell: (v) => String(v == null ? '' : v)
  }));
  require(path.join(APP_DIR, 'handlers', 'notices'))(ipcMain, Object.assign({}, deps, {
    LOAN_SELECT, effectiveDaysLate, EUR_RATE: 1.95583,
    isValidEmail: (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e),
    shell: { openExternal: () => {} }
  }));
  return { db, ipcMain, audit, events };
}
/* Книга + една бройка в наличността (иначе заемането отказва с „няма свободни
   бройки“ — тук ни интересуват други правила). */
function book(db, inv, o = {}) {
  const id = db.prepare('INSERT INTO books (inv_number, title, author, barcode, price, status, register_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(inv, o.title || ('Книга ' + inv), o.author || null, o.barcode || null, o.price || 10, 'наличен', '2026-01-05').lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, o.qty == null ? 1 : o.qty);
  return id;
}
function reader(db, o = {}) {
  return db.prepare(`INSERT INTO readers (name, card_no, category, status, gdpr_consent, phone,
      guarantor_name, guarantor_relation, guarantor_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.name || 'Читател', o.card_no || null, o.category || 'възрастен', o.status || 'активен',
      o.gdpr_consent == null ? 1 : o.gdpr_consent, o.phone || null,
      o.guarantor_name || null, o.guarantor_relation || null, o.guarantor_phone || null).lastInsertRowid;
}
const lines = (db, readerId) => db.prepare('SELECT * FROM account_lines WHERE reader_id = ? ORDER BY id').all(readerId);

/* ============================================================
   1. Прекратена регистрация
   ============================================================ */
test('читател със състояние „прекратен“ не заема по нито една от двете врати', async () => {
  const { db, ipcMain } = setup('inv-zaem-status-');
  const b1 = book(db, 1, { barcode: 'BC1' });
  const b2 = book(db, 2);
  const r = reader(db, { name: 'Христо Прекратен', card_no: '1007', status: 'прекратен' });

  const byId = await ipcMain.invoke('loans:checkout', { reader_id: r, book_id: b1, date_out: TODAY });
  assert.equal(byId.ok, false);
  assert.match(byId.error, /Регистрацията на Христо Прекратен е прекратена/);
  const byCode = await ipcMain.invoke('loans:checkoutByCode', { reader_id: r, code: '2', date_out: TODAY });
  assert.equal(byCode.ok, false);
  assert.match(byCode.error, /прекратена/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 0, 'отказът не оставя заемане');

  // Върнат в „активен“ — заема веднага, без друга намеса.
  db.prepare("UPDATE readers SET status = 'активен' WHERE id = ?").run(r);
  assert.equal((await ipcMain.invoke('loans:checkout', { reader_id: r, book_id: b1, date_out: TODAY })).ok, true);
});

/* ============================================================
   2. Съгласие по чл. 47, ал. 2 и ОРЗД
   ============================================================ */
test('readers:create отказва читател без отбелязано съгласие, а readers:update допуска оттеглянето му', async () => {
  const { db, ipcMain } = setup('inv-zaem-gdpr-create-');
  const no = await ipcMain.invoke('readers:create', { name: 'Без Съгласие', card_no: '1010' });
  assert.equal(no.ok, false, 'очаква се отказ, получено: ' + JSON.stringify(no));
  assert.match(no.error, /съгласие по чл\. 47, ал\. 2/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM readers').get().n, 0, 'нищо не се е записало');

  const yes = await ipcMain.invoke('readers:create', { name: 'Със Съгласие', card_no: '1011', gdpr_consent: 1 });
  assert.equal(yes.ok, true, yes.error);
  assert.equal(db.prepare('SELECT gdpr_consent, gdpr_consent_date FROM readers WHERE id = ?').get(yes.data).gdpr_consent, 1);
  /* Оттеглянето е ПРАВО на гражданина (същият текст стои и на подписвания
     картон), затова редакцията не се отказва — само заемането спира. */
  const off = await ipcMain.invoke('readers:update', { id: yes.data, name: 'Със Съгласие', card_no: '1011', gdpr_consent: 0 });
  assert.equal(off.ok, true, off.error);
  assert.equal(db.prepare('SELECT gdpr_consent FROM readers WHERE id = ?').get(yes.data).gdpr_consent, 0);
});

test('заемане на читател без отбелязано съгласие се отказва и казва какво да се направи', async () => {
  const { db, ipcMain } = setup('inv-zaem-gdpr-loan-');
  const b = book(db, 1, { barcode: 'BC1' });
  const r = reader(db, { name: 'Без Съгласие', card_no: '1010', gdpr_consent: 0 });
  for (const call of [
    () => ipcMain.invoke('loans:checkout', { reader_id: r, book_id: b, date_out: TODAY }),
    () => ipcMain.invoke('loans:checkoutByCode', { reader_id: r, code: 'BC1', date_out: TODAY })
  ]) {
    const res = await call();
    assert.equal(res.ok, false);
    assert.match(res.error, /няма отбелязано съгласие по чл\. 47, ал\. 2/);
    assert.match(res.error, /картона на читателя/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 0);
});

/* ============================================================
   3. Невъзможни дати при заемане
   ============================================================ */
test('заемане с бъдеща дата и с падеж преди датата на заемане се отказват', async () => {
  const { db, ipcMain } = setup('inv-zaem-dates-out-');
  const b = book(db, 1, { barcode: 'BC1' });
  const r = reader(db, { card_no: '1001' });

  const fut = await ipcMain.invoke('loans:checkout', { reader_id: r, book_id: b, date_out: '2026-09-28' });
  assert.equal(fut.ok, false);
  assert.match(fut.error, /28\.09\.2026 г\.\) е в бъдещето — днес е 18\.09\.2026/);
  const futCode = await ipcMain.invoke('loans:checkoutByCode', { reader_id: r, code: 'BC1', date_out: '2026-09-28' });
  assert.equal(futCode.ok, false);
  assert.match(futCode.error, /в бъдещето/);

  const badDue = await ipcMain.invoke('loans:checkout', { reader_id: r, book_id: b, date_out: TODAY, date_due: '2026-09-13' });
  assert.equal(badDue.ok, false);
  assert.match(badDue.error, /13\.09\.2026 г\.\) е преди датата на заемане \(18\.09\.2026/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 0, 'нито едно от трите не е записано');

  // Днешната дата и падеж СЛЕД нея си минават, включително равен на заемането.
  assert.equal((await ipcMain.invoke('loans:checkout', { reader_id: r, book_id: b, date_out: TODAY, date_due: TODAY })).ok, true);
});

/* ============================================================
   4. Невъзможни дати при връщане
   ============================================================ */
test('връщане с бъдеща дата и с дата преди заемането се отказват и по двата пътя', async () => {
  const { db, ipcMain } = setup('inv-zaem-dates-in-');
  const b = book(db, 1, { barcode: 'BC1' });
  const r = reader(db, { card_no: '1001' });
  const id = (await ipcMain.invoke('loans:checkout', { reader_id: r, book_id: b, date_out: '2026-09-10' })).data;

  const fut = await ipcMain.invoke('loans:return', { id, date_in: '2026-09-25' });
  assert.equal(fut.ok, false);
  assert.match(fut.error, /25\.09\.2026 г\.\) е в бъдещето/);
  const futCode = await ipcMain.invoke('loans:returnByCode', { code: 'BC1', date_in: '2026-09-25' });
  assert.equal(futCode.ok, false);
  assert.match(futCode.error, /в бъдещето/);

  const early = await ipcMain.invoke('loans:return', { id, date_in: '2026-09-05' });
  assert.equal(early.ok, false);
  assert.match(early.error, /05\.09\.2026 г\.\) е преди датата на заемане \(10\.09\.2026/);
  const earlyCode = await ipcMain.invoke('loans:returnByCode', { code: 'BC1', date_in: '2026-09-05' });
  assert.equal(earlyCode.ok, false);
  assert.match(earlyCode.error, /преди датата на заемане/);

  assert.equal(db.prepare('SELECT date_in FROM loans WHERE id = ?').get(id).date_in, null, 'заемането остава отворено');
  assert.equal((await ipcMain.invoke('loans:return', { id, date_in: TODAY })).ok, true);
});

/* ============================================================
   5. Одитна следа
   ============================================================ */
test('следата на заемането назовава читателя, а на продължението — документа и читателя', async () => {
  const { db, ipcMain, audit } = setup('inv-zaem-audit-');
  const b = book(db, 7, { title: 'Тютюн', barcode: 'BC7' });
  const r = reader(db, { name: 'Иван Читателов', card_no: '1001' });

  await ipcMain.invoke('loans:checkout', { reader_id: r, book_id: b, date_out: '2026-09-01' });
  const out = audit.filter(a => a.action === 'Заемане').pop();
  assert.match(out.detail, /инв\. № 7 — Тютюн/);
  assert.match(out.detail, /читател Иван Читателов \(карта 1001\)/);
  const loanId = db.prepare('SELECT id FROM loans').get().id;

  await ipcMain.invoke('loans:extend', { id: loanId });
  const ext = audit.filter(a => a.action === 'Продължение на заемане').pop();
  assert.match(ext.detail, /инв\. № 7 — Тютюн/);
  assert.match(ext.detail, /читател Иван Читателов \(карта 1001\)/);
  assert.match(ext.detail, new RegExp('заемане № ' + loanId + ' до '), 'номерът на заемането остава в следата');

  // И вратата с баркода вписва читателя.
  await ipcMain.invoke('loans:return', { id: loanId, date_in: TODAY });
  await ipcMain.invoke('loans:checkoutByCode', { reader_id: r, code: 'BC7', date_out: TODAY });
  assert.match(audit.filter(a => a.action === 'Заемане').pop().detail, /читател Иван Читателов \(карта 1001\)/);
});

/* ============================================================
   6. Закръгляне до стотинка
   ============================================================ */
test('loans.fine се записва закръглено до стотинка при връщане, при връщане с баркод и при продължение', async () => {
  const { db, ipcMain } = setup('inv-zaem-cents-');
  const r = reader(db, { card_no: '1001' });
  const mk = (inv, due) => {
    const id = book(db, inv, { barcode: 'BC' + inv });
    const loan = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)')
      .run(r, id, '2026-08-01', due).lastInsertRowid;
    return { bookId: id, loan };
  };
  // 7 дни × 0.10 = 0.7000000000000001 в двоична плаваща запетая — точно случаят.
  const a = mk(1, '2026-09-11');
  assert.equal((await ipcMain.invoke('loans:return', { id: a.loan, date_in: TODAY })).data.fine, 0.70);
  const bb = mk(2, '2026-09-11');
  assert.equal((await ipcMain.invoke('loans:returnByCode', { code: 'BC2', date_in: TODAY })).data.fine, 0.70);
  const c = mk(3, '2026-09-11');
  await ipcMain.invoke('loans:extend', { id: c.loan });

  const bad = db.prepare('SELECT id, fine FROM loans').all().filter(x => x.fine !== cents(x.fine));
  assert.deepEqual(bad, [], 'незакръглени суми в loans.fine');
  const badLines = db.prepare('SELECT id, amount FROM account_lines').all().filter(x => x.amount !== cents(x.amount));
  assert.deepEqual(badLines, [], 'незакръглени суми в account_lines');
});

/* ============================================================
   7. Обезщетението за забава влиза в читателската сметка
   ============================================================ */
test('обезщетението за забава по чл. 43 влиза в читателската сметка — и при връщане, и при продължение', async () => {
  const { db, ipcMain } = setup('inv-zaem-account-');
  const r = reader(db, { name: 'Мария Закъсняла', card_no: '1002' });
  const b = book(db, 1, { barcode: 'BC1' });
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(r, b, '2026-08-01', '2026-09-08');
  const loan = db.prepare('SELECT id FROM loans').get().id;

  // 1) Продължение на просрочено заемане: 10 дни × 0.10 = 1.00 €.
  await ipcMain.invoke('loans:extend', { id: loan });
  let acc = lines(db, r);
  assert.equal(acc.length, 1);
  assert.equal(acc[0].kind, 'начисление');
  assert.equal(acc[0].type, 'обезщетение', 'вид „обезщетение“ — точно него брои „Събрани обезщетения“ в отчета');
  assert.equal(acc[0].amount, 1.00);
  assert.equal(acc[0].date, TODAY);
  assert.match(acc[0].note, /Забава 10 дни по инв\. № 1/);

  // 2) Връщането след продължението не начислява втори път (забава спрямо НОВИЯ падеж няма).
  await ipcMain.invoke('loans:return', { id: loan, date_in: TODAY });
  acc = lines(db, r);
  assert.equal(acc.length, 1, 'без двойно начисляване: ' + JSON.stringify(acc));
  assert.equal(cents(acc.reduce((s, l) => s + l.amount, 0)), cents(db.prepare('SELECT fine FROM loans WHERE id = ?').get(loan).fine),
    'сметката носи точно толкова, колкото е начислено по заемането');

  // 3) Обикновено връщане със забава — начислява се в сметката с датата на връщането.
  const b2 = book(db, 2, { barcode: 'BC2' });
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(r, b2, '2026-08-01', '2026-09-15');
  const res = await ipcMain.invoke('loans:returnByCode', { code: 'BC2', date_in: '2026-09-17' });
  assert.equal(res.ok, true, res.error);
  acc = lines(db, r);
  assert.equal(acc.length, 2);
  assert.equal(acc[1].amount, 0.20);
  assert.equal(acc[1].date, '2026-09-17', 'редът е с датата на връщането, не с днешната');

  // 4) Върнато В СРОК не оставя ред от 0.00 € в картона.
  const b3 = book(db, 3, { barcode: 'BC3' });
  const l3 = (await ipcMain.invoke('loans:checkout', { reader_id: r, book_id: b3, date_out: '2026-09-10' })).data;
  await ipcMain.invoke('loans:return', { id: l3, date_in: TODAY });
  assert.equal(lines(db, r).length, 2, 'връщане в срок не пише в сметката');
});

test('и ОБИКНОВЕНОТО връщане (loans:return, без баркод) начислява забавата в сметката', async () => {
  /* Гишето има две врати към връщането и се ползват еднакво често: бутонът
     „Върни“ до реда (loans:return) и сканирането (loans:returnByCode). Тестът
     по-горе минава само през втората, тоест правилото можеше да отпадне от
     първата, без нищо да падне — а тогава „Дължи по сметка“ мълчи точно за
     читателя, когото библиотекарката току-що е обслужила на гишето. */
  const { db, ipcMain } = setup('inv-zaem-return-account-');
  const r = reader(db, { name: 'Петър Закъснял', card_no: '1003' });
  const b = book(db, 1);
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(r, b, '2026-08-01', '2026-09-10');
  const loan = db.prepare('SELECT id FROM loans').get().id;

  const res = await ipcMain.invoke('loans:return', { id: loan, date_in: '2026-09-17' });
  assert.equal(res.ok, true, res.error);

  const acc = lines(db, r);
  assert.equal(acc.length, 1, 'забавата по чл. 43 липсва от сметката: ' + JSON.stringify(acc));
  assert.equal(acc[0].kind, 'начисление');
  assert.equal(acc[0].type, 'обезщетение');
  assert.equal(acc[0].amount, 0.70, '7 дни × 0.10 €');
  assert.equal(acc[0].date, '2026-09-17', 'с датата на връщането, не с днешната');
  assert.match(acc[0].note, /Забава 7 дни по инв\. № 1/);
  assert.equal(cents(acc[0].amount), cents(db.prepare('SELECT fine FROM loans WHERE id = ?').get(loan).fine),
    'сметката и заемането носят едно и също число');
});

test('приключването като изгубен начислява ДВЕ отделни задължения: документа и забавата', async () => {
  const { db, ipcMain } = setup('inv-zaem-lost-account-');
  const r = reader(db, { name: 'Пенка Губеща', card_no: '1005' });
  const b = book(db, 5, { title: 'История на България', price: 20 });
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)')
    .run(r, b, '2026-08-01', '2026-09-08');
  const loan = db.prepare('SELECT id FROM loans').get().id;
  const res = await ipcMain.invoke('loans:markLost', { id: loan, resolution: 'обезщетение', amount: 60, date: TODAY });
  assert.equal(res.ok, true, res.error);
  const acc = lines(db, r);
  assert.equal(acc.length, 2);
  assert.equal(acc[0].type, 'обезщетение за изгубен документ');
  assert.equal(acc[0].amount, 60);
  assert.equal(acc[1].type, 'обезщетение');
  assert.equal(acc[1].amount, 1.00, '10 дни × 0.10 € забава');
  /* Редът на забавата е ВТОРИ: плащанията покриват най-старото задължение първо,
     а по акта по чл. 30, т. 5 се пита дали е събрано обезщетението за ДОКУМЕНТА. */
  assert.equal(acc[0].id < acc[1].id, true);
  assert.equal(db.prepare('SELECT lost_account_line_id FROM loans WHERE id = ?').get(loan).lost_account_line_id, acc[0].id);
});

/* ============================================================
   8. Снемане на наказание
   ============================================================ */
test('readers:clearSuspension на несъществуващ читател отказва и не вписва следа', async () => {
  const { db, ipcMain, audit } = setup('inv-zaem-clearsusp-');
  const res = await ipcMain.invoke('readers:clearSuspension', 99999);
  assert.equal(res.ok, false, 'получено: ' + JSON.stringify(res));
  assert.match(res.error, /Читателят не е намерен/);
  assert.equal(audit.filter(a => a.action === 'Снето наказание').length, 0, 'няма следа за неслучило се действие');

  const r = reader(db, { name: 'Наказан Читател', card_no: '1008' });
  db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run('2026-12-01', r);
  assert.equal((await ipcMain.invoke('readers:clearSuspension', r)).ok, true);
  assert.equal(db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(r).suspended_until, null);
  assert.equal(audit.filter(a => a.action === 'Снето наказание').pop().detail, 'Наказан Читател');
  // Повторно снемане на вече снето наказание е безобидно и остава успешно.
  assert.equal((await ipcMain.invoke('readers:clearSuspension', r)).ok, true);
});

/* ============================================================
   9. Напомняне за читател под 14 години
   ============================================================ */
test('напомнянето за читател под 14 г. е до родителя/настойника и с неговия телефон', async () => {
  const { db, ipcMain } = setup('inv-zaem-child-notice-');
  const child = reader(db, { name: 'Ани Детска', card_no: '2006', category: 'дете до 14 г.',
    phone: '0700 000 000', guarantor_name: 'Петя Детска', guarantor_relation: 'майка', guarantor_phone: '0888 111 222' });
  const grown = reader(db, { name: 'Иван Читателов', card_no: '1001', phone: '0899 000 001' });
  const b1 = book(db, 6, { title: 'Пипи Дългото чорапче' });
  const b2 = book(db, 7, { title: 'Тютюн' });
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(child, b1, '2026-08-20', '2026-09-03');
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(grown, b2, '2026-08-20', '2026-09-03');

  const rem = (await ipcMain.invoke('loans:reminders')).data;
  const kid = rem.find(x => x.reader_id === child);
  assert.equal(kid.notice_to, 'Петя Детска');
  assert.equal(kid.notice_via_guarantor, 'майка');
  assert.equal(kid.phone, '0888 111 222', 'SMS-ът отива при гаранта');
  assert.equal(kid.reader_phone, '0700 000 000', 'телефонът от картона на детето се пази отделно');
  assert.match(kid.body, /Уважаем\(а\) Петя Детска \(майка на Ани Детска\)/);
  assert.match(kid.body, /Пипи Дългото чорапче/);
  assert.equal(kid.name, 'Ани Детска', 'името на читателя остава — по него се намира картонът');

  const adult = rem.find(x => x.reader_id === grown);
  assert.equal(adult.notice_to, 'Иван Читателов');
  assert.equal(adult.notice_via_guarantor, null);
  assert.equal(adult.phone, '0899 000 001');
  assert.match(adult.body, /Уважаем\(а\) Иван Читателов,/);

  // Печатното писмо се храни от loans:overdueByReader — и то трябва да знае адресата.
  const byReader = (await ipcMain.invoke('loans:overdueByReader')).data;
  const kidRow = byReader.find(x => x.reader_id === child);
  assert.equal(kidRow.notice_to, 'Петя Детска');
  assert.equal(kidRow.notice_via_guarantor, 'майка');
  assert.equal(kidRow.phone, '0888 111 222');
});

/* ============================================================
   10. Читателският картон за невърнат/изгубен документ
   ============================================================ */
test('картонът печата „изгубен“/„невърнат“ вместо дата за заемане, което не е върнато', () => {
  /* Функцията се изважда от истинския екранен файл и се изпълнява — иначе това
     щеше да е проверка на низ, а не на поведение. bg() е форматирането на дата
     от core.js. */
  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'logo-org.js'), 'utf8');
  const m = src.match(/function loanEndCell\(l\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'loanEndCell не е намерена в src/views/logo-org.js');
  const loanEndCell = new Function('bg', m[0] + '\nreturn loanEndCell;')(
    (d) => (d ? String(d).split('-').reverse().join('.') : ''));

  assert.equal(loanEndCell({ date_in: '2026-09-18' }), '18.09.2026', 'истинското връщане си остава дата');
  assert.equal(loanEndCell({ date_in: null }), '', 'още заетото е с празна клетка');
  assert.equal(loanEndCell({ date_in: '2026-09-18', lost: 1 }), 'изгубен');
  assert.equal(loanEndCell({ date_in: '2026-09-18', lost: 1, deaccession_act_id: 4 }), 'невърнат (акт за отчисляване)');
  assert.equal(loanEndCell({ date_in: '2026-09-18', deaccession_act_id: 4 }), 'невърнат (акт за отчисляване)');
  // Колоната наистина минава през функцията, а не печата date_in направо.
  assert.match(src, /<th>Върнат на<\/th>[\s\S]*?\$\{loanEndCell\(l\)\}/);
});

/* ============================================================
   11 и 12. Съобщенията на гишето
   ============================================================ */
test('заемане на несъществуващ читател казва, че читателят не е намерен, а не „записът е свързан с други данни“', async () => {
  const { db, ipcMain } = setup('inv-zaem-nonexistent-');
  const b = book(db, 1, { barcode: 'BC1' });
  for (const res of [
    await ipcMain.invoke('loans:checkout', { reader_id: 99999, book_id: b, date_out: TODAY }),
    await ipcMain.invoke('loans:checkoutByCode', { reader_id: 99999, code: 'BC1', date_out: TODAY })
  ]) {
    assert.equal(res.ok, false);
    assert.match(res.error, /Читателят не е намерен — вероятно е изтрит от друго работно място/);
    assert.doesNotMatch(res.error, /свързан с други данни/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 0);
});

test('„вече е зает от … до“ показва датата както целият останал екран — 01.10.2026', async () => {
  const { db, ipcMain } = setup('inv-zaem-bgdate-');
  const b = book(db, 1, { barcode: 'BC1' });
  const r1 = reader(db, { name: 'Иван Читателов', card_no: '1001' });
  const r2 = reader(db, { name: 'Друг Читател', card_no: '1002' });
  await ipcMain.invoke('loans:checkout', { reader_id: r1, book_id: b, date_out: TODAY, date_due: '2026-10-01' });
  const res = await ipcMain.invoke('loans:checkoutByCode', { reader_id: r2, code: '1', date_out: TODAY });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Инв. № 1 вече е зает от Иван Читателов до 01.10.2026.');
});

/* ============================================================
   13 и 14. Печатното писмо и панелът на гишето
   ============================================================ */
test('напомнителното писмо носи дата и се адресира до гаранта; „Днес на гишето“ казва какво брои', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'logo-org.js'), 'utf8');
  const letter = src.slice(src.indexOf('НАПОМНИТЕЛНО ПИСМО'));
  // D-F3: писмото иска сума „към днешна дата“ и заплашва с наказание — без дата
  // то е непроверимо и не доказва, че библиотеката е напомняла преди санкцията.
  assert.match(letter, /Дата: <b>\$\{bg\(today\(\)\)\}<\/b>/);
  // F9: адресатът идва готов от loans:overdueByReader.
  assert.match(letter, /До: <b>\$\{esc\(r\.notice_to \|\| r\.name\)\}<\/b>/);
  assert.match(letter, /notice_via_guarantor/);

  const circ = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'loans.js'), 'utf8');
  // P1: панелът брои ВПИСАНОТО днес (по одитната следа) — заглавието вече го казва.
  assert.match(circ, /const CIRC_TODAY_TITLE = 'Вписано днес на гишето'/);
  assert.equal((circ.match(/Днес на гишето<\/h3>/g) || []).length, 0, 'старото заглавие не е останало никъде');
  assert.match(circ, /Броят се операциите, ВПИСАНИ днес на това работно място/);
  // F1 на екрана: прекратената регистрация и липсващото съгласие се казват при
  // избора на читателя, както се казва и наказанието.
  assert.match(circ, /r\.status === 'прекратен'/);
  assert.match(circ, /!r\.gdpr_consent/);
});
