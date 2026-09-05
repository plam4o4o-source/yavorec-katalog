'use strict';
/* v2.4.29 — осемнадесети кръг: пълен тест на работата, грешки, подобрения и
   графични подобрения по останалите екрани (таблото, гишето, читателите,
   инвентарната книга, справките, одитната следа).
   =====================================================================
   Обработчиците се проверяват през ИСТИНСКИЯ main.js (test/helpers/main-app.js)
   върху прясна база — схема, тригери за номенклатурите и миграции са същите като
   при библиотекаря. Екранният слой — в jsdom с api-заместител (audit-fixtures).

   Всеки тест е проверен с мутация (виж описанието на кръга в CHANGELOG). */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { APP_DIR, cleanupTmpDirs, buildDom, settle } = require('./helpers/audit-fixtures');
const { startMainApp } = require('./helpers/main-app');

test.after(cleanupTmpDirs);

/* ---------- истинското приложение (един процес = едно зареждане) ---------- */
let app = null, db = null;
async function boot() {
  if (app) return app;
  app = startMainApp();
  await app.ready();
  db = new Database(path.join(app.userData, 'library.db'));
  const s = (await app.invoke('settings:get')).data;
  await app.invoke('settings:update', Object.assign(s, { id: 1, org: 'НЧ Тест', lib_name: 'Библиотека', loan_days: 30, fine_per_day: 0.05 }));
  return app;
}
test.after(() => { if (db) db.close(); if (app) app.stop(); });
const ok = async (ch, ...a) => { const r = await app.invoke(ch, ...a); assert.equal(r.ok, true, ch + ': ' + r.error); return r.data; };
const fail = async (ch, ...a) => { const r = await app.invoke(ch, ...a); assert.equal(r.ok, false, ch + ' трябваше да откаже'); return r.error; };
const q = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const lastAudit = () => q('SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1');
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
let invSeq = 500;
async function book(o) {
  const cat = q("SELECT id FROM categories WHERE name = 'книга'").id;
  return ok('books:create', Object.assign({ inv_number: String(invSeq++), title: 'Книга ' + invSeq, category_id: cat, register_date: '2026-01-10' }, o || {}));
}
let cardSeq = 700;
async function reader(o) {
  return ok('readers:create', Object.assign({ name: 'Читател ' + cardSeq, card_no: String(cardSeq++), category: 'възрастен', gdpr_consent: 1 }, o || {}));
}

/* ==================================================================
   1. Дневник → „Предложи от регистрите“: художествената литература
   ================================================================== */
test('dnevnik:suggest — романът е „Художествена литература“, детската — „Детска художествена“, критиката остава в 82', async () => {
  await boot();
  const kid = await reader({ category: 'дете до 14 г.' });
  const day = '2026-03-03';
  // Лимитът е 5 документа на читател — възрастните са различни читатели.
  const mk = async (udk, rd) => {
    const b = await book({ udk });
    const who = rd === 'kid' ? kid : await reader({ category: 'възрастен' });
    await ok('loans:checkout', { reader_id: who, book_id: b, date_out: day, date_due: '2026-04-03' });
  };
  const r = 'adult';
  await mk('821.163.2-31', r);   // български роман
  await mk('82-1', r);           // поезия
  await mk('821.111', r);        // английска литература (без определител)
  await mk('82-93', 'kid');        // литература за деца
  await mk('Д', 'kid');            // сигнатура на детския отдел
  await mk('Д.09', 'kid');         // детска отраслова
  await mk('82.0', r);           // теория на литературата
  await mk('821.163.2.09', r);   // критика
  await mk('796.332', r);        // футбол → спорт
  await mk('7.01', r);           // изкуство остава в 7
  await mk('886.7-31', r);       // български роман по СТАРАТА таблица (много стари бази)
  await mk('820', r);            // английска литература по старата таблица
  await mk('821.163.2-93(0.053.2)', 'kid'); // определител „за деца“ в скоби не пречи
  await mk('82(091)', r);        // история на литературата — литературознание
  await mk('81', r);             // езикознание — извън тази проверка (b_cat_80)
  const s = (await ok('dnevnik:suggest', { date: day })).suggestions;
  assert.equal(s.b_cat_fiction, 5, 'роман, поезия, национална литература (нова и стара таблица) са художествена');
  assert.equal(s.b_cat_child_f, 3, '82-93, „Д“ и -93(0.053.2) са детска художествена');
  assert.equal(s.b_cat_child_nf, 1, '„Д.09“ е детска отраслова');
  assert.equal(s.b_cat_82, 3, '82.0, .09 (критика) и (091) остават в 82/89 Литературознание');
  assert.equal(s.b_cat_80, 1, '81 е езикознание');
  assert.equal(s.b_cat_793, 1, '796 (спорт) е в колоната 793/799');
  assert.equal(s.b_cat_7, 1, '7.01 остава в „7 Изкуство“');
  assert.equal(s.a_age_u14, 1, 'детето се брои веднъж по възраст');
});

/* ==================================================================
   2. GDPR: анонимизирането стига и до резервации, предложения, МЗС,
      напомняния и посещения по домовете
   ================================================================== */
test('gdpr:candidates брои и gdpr:anonymize обезличава резервации, предложения, МЗС, напомняния и посещения отпреди срока', async () => {
  await boot();
  const old = '2019-05-05', recent = daysAgo(3);
  const r = await reader({ name: 'Стар Старов' });
  const b1 = await book({}), b2 = await book({});
  db.prepare("INSERT INTO holds (book_id, reader_id, placed_at, status, resolved_at) VALUES (?, ?, ?, 'изпълнена', ?)").run(b1, r, old + ' 10:00:00', old + ' 11:00:00');
  db.prepare("INSERT INTO holds (book_id, reader_id, placed_at, status) VALUES (?, ?, ?, 'чака')").run(b2, r, recent + ' 10:00:00');
  db.prepare("INSERT INTO suggestions (date, reader_id, reader_name, title) VALUES (?, ?, 'Стар Старов', 'Старо предложение')").run(old, r);
  db.prepare("INSERT INTO suggestions (date, reader_id, reader_name, title) VALUES (?, ?, 'Стар Старов', 'Ново предложение')").run(recent, r);
  db.prepare("INSERT INTO mzs_requests (no, year, date, direction, partner, title, requester) VALUES (901, '2019', ?, 'изходящо', 'НБКМ', 'Стара заявка', 'Стар Старов')").run(old);
  db.prepare("INSERT INTO mzs_requests (no, year, date, direction, partner, title, requester) VALUES (902, '2026', ?, 'изходящо', 'НБКМ', 'Нова заявка', 'Стар Старов')").run(recent);
  db.prepare('INSERT INTO notice_log (ts, reader_id, level) VALUES (?, ?, 1)').run(old + ' 09:00:00', r);
  db.prepare('INSERT INTO notice_log (ts, reader_id, level) VALUES (?, ?, 1)').run(recent + ' 09:00:00', r);
  db.prepare('INSERT INTO housebound_visits (reader_id, date) VALUES (?, ?)').run(r, old);
  db.prepare('INSERT INTO housebound_visits (reader_id, date) VALUES (?, ?)').run(r, recent);
  // Читател с НЕЗАВЪРШЕНО просрочено заемане и старо напомняне за него — то е живо състояние.
  const r2 = await reader({ name: 'Длъжник Стар' });
  const b3 = await book({});
  await ok('loans:checkout', { reader_id: r2, book_id: b3, date_out: '2019-01-10', date_due: '2019-02-10' });
  db.prepare('INSERT INTO notice_log (ts, reader_id, level) VALUES (?, ?, 3)').run('2019-03-01 09:00:00', r2);
  db.prepare('UPDATE settings SET anonymize_years = 2 WHERE id = 1').run();

  const c = await ok('gdpr:candidates');
  assert.equal(c.otherCount, 5, 'по един стар ред във всяка от петте таблици');

  const res = await ok('gdpr:anonymize');
  assert.equal(res.otherCleared, 5);
  const anon = q("SELECT id FROM readers WHERE name = '— анонимизирани заемания —'");
  assert.ok(anon, 'служебният запис съществува');
  assert.equal(q('SELECT reader_id FROM holds WHERE book_id = ?', b1).reader_id, anon.id, 'старата изпълнена резервация е прехвърлена');
  assert.equal(q('SELECT reader_id FROM holds WHERE book_id = ?', b2).reader_id, r, 'новата чакаща — не');
  assert.deepEqual(q("SELECT reader_id, reader_name FROM suggestions WHERE title = 'Старо предложение'"), { reader_id: null, reader_name: '[анонимизиран читател]' });
  assert.equal(q("SELECT reader_name FROM suggestions WHERE title = 'Ново предложение'").reader_name, 'Стар Старов');
  assert.equal(q('SELECT requester FROM mzs_requests WHERE no = 901').requester, '[анонимизиран читател]');
  assert.equal(q('SELECT requester FROM mzs_requests WHERE no = 902').requester, 'Стар Старов');
  assert.equal(q('SELECT COUNT(*) AS n FROM notice_log WHERE reader_id = ?', r).n, 1, 'старото напомняне е изтрито, новото остава');
  assert.equal(q('SELECT COUNT(*) AS n FROM notice_log WHERE reader_id = ?', r2).n, 1, 'напомнянето за още незавършено просрочие се ПАЗИ (таблото и степента зависят от него)');
  assert.equal(q('SELECT reader_id FROM housebound_visits WHERE date = ?', old).reader_id, anon.id, 'старото посещение е прехвърлено на служебния запис');
  assert.equal(q('SELECT reader_id FROM housebound_visits WHERE date = ?', recent).reader_id, r, 'новото остава');
  assert.equal((await ok('gdpr:candidates')).otherCount, 0, 'след анонимизирането няма какво повече');
  assert.match(lastAudit().detail, /5 записа в резервации, предложения, МЗС, напомняния и посещения са обезличени/);
});

/* ==================================================================
   3. Периодика: редакция без периодичност, броеве с проверки, връзки
   ================================================================== */
test('periodicals:update приема периодичност „—“ (празна) и нормализира празните полета като create', async () => {
  await boot();
  const id = await ok('periodicals:create', { title: 'Вестник', freq: '', publisher: '', issn: '' });
  assert.equal(q('SELECT freq FROM periodicals WHERE id = ?', id).freq, null);
  await ok('periodicals:update', { id, title: 'Вестникът', freq: '', publisher: '', issn: '', department: '', note: '' });
  assert.deepEqual(q('SELECT title, freq, publisher FROM periodicals WHERE id = ?', id), { title: 'Вестникът', freq: null, publisher: null });
  assert.match(await fail('periodicals:update', { id, title: '   ' }), /Заглавието/);
  assert.match(await fail('periodicals:update', { id: 999999, title: 'Х' }), /не е намерено/);
});

test('periodicalIssues:add отказва невалидна дата, празен номер и цена, която не е число; delete вписва в следата', async () => {
  await boot();
  const id = await ok('periodicals:create', { title: 'Родна реч', freq: 'месечно' });
  assert.match(await fail('periodicalIssues:add', { periodical_id: id, issue_no: '1', date: '2026-02-30' }), /невалидна/);
  assert.match(await fail('periodicalIssues:add', { periodical_id: id, issue_no: '  ', date: '2026-02-10' }), /Номерът на броя/);
  assert.match(await fail('periodicalIssues:add', { periodical_id: id, issue_no: '1', date: '2026-02-10', price: 'abc' }), /Цената/);
  assert.match(await fail('periodicalIssues:add', { periodical_id: 999999, issue_no: '1', date: '2026-02-10' }), /не е намерено/);
  const iid = await ok('periodicalIssues:add', { periodical_id: id, issue_no: '2', date: '2026-02-10', price: '1,50' });
  assert.equal(q('SELECT price FROM periodical_issues WHERE id = ?', iid).price, 1.5, 'десетична запетая се приема');
  assert.match(await fail('periodicalIssues:delete', 999999), /вече не съществува/);
  await ok('periodicalIssues:delete', iid);
  assert.deepEqual(lastAudit(), { action: 'Изтрит брой', detail: 'Родна реч — бр. 2 от 2026-02-10' });
});

test('periodicals:delete и books:delete чистят краеведските връзки; books:delete отказва при аналитични описания', async () => {
  await boot();
  const per = await ok('periodicals:create', { title: 'Стар вестник', freq: 'седмично' });
  const b = await book({ title: 'Краеведска книга' });
  const p = await ok('persons:create', { name: 'Иван Местен' });
  await ok('links:add', { fromKind: 'персона', fromId: p, toKind: 'периодика', toId: per });
  await ok('links:add', { fromKind: 'персона', fromId: p, toKind: 'книга', toId: b });
  await ok('periodicals:delete', per);
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE to_kind = 'периодика' AND to_id = ?", per).n, 0, 'връзката към изданието е изчистена');

  const anl = await ok('analytics:create', { title: 'Статия от книга', source_kind: 'книга', book_id: b, year: '2026' });
  // Книга с история на заеманията: отказът заради статията е ПРЕДИ „натиснете още веднъж“
  // (иначе второто натискане се изяжда от проверката и четвъртото изтрива).
  const rd = await reader({});
  await ok('loans:checkout', { reader_id: rd, book_id: b, date_out: '2026-01-11', date_due: '2026-02-11' });
  await ok('loans:return', { id: q('SELECT id FROM loans WHERE book_id = ?', b).id, date_in: '2026-01-20' });
  assert.match(await fail('books:delete', b), /аналитично описание/);
  assert.match(await fail('books:delete', b), /аналитично описание/, 'и второто натискане отказва заради статията');
  assert.ok(q('SELECT id FROM books WHERE id = ?', b), 'документът остава');
  await ok('analytics:delete', anl);
  assert.match(await fail('books:delete', b), /още веднъж/);
  await ok('books:delete', b);
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE to_kind = 'книга' AND to_id = ?", b).n, 0, 'връзката към книгата е изчистена');
});

/* ==================================================================
   4. Книги: един баркод = един екземпляр; числа в текстови колони
   ================================================================== */
test('books:create/update отказват баркод, който вече стои на друг екземпляр; собственият баркод при редакция минава', async () => {
  await boot();
  const a = await book({ barcode: 'BC-2429-A' });
  const err = await fail('books:create', { inv_number: String(invSeq++), title: 'Дубликат', category_id: 1, barcode: 'BC-2429-A' });
  assert.match(err, /вече е на инв. №/);
  const b = await book({ barcode: 'BC-2429-B' });
  const cur = q('SELECT * FROM books WHERE id = ?', b);
  assert.match(await fail('books:update', Object.assign({}, cur, { barcode: 'BC-2429-A' })), /вече е на инв. №/);
  await ok('books:update', Object.assign({}, cur, { barcode: 'BC-2429-B', title: 'Преименувана' }));
  assert.equal(q('SELECT title FROM books WHERE id = ?', b).title, 'Преименувана', 'собственият баркод не е дубликат');
  await ok('books:update', Object.assign({}, q('SELECT * FROM books WHERE id = ?', a), { barcode: '' }));
  assert.match(await fail('books:update', Object.assign({}, cur, { id: 999999 })), /не е намерен/);
  // Числов баркод = чужд инв. № и инв. № = чужд баркод — двусмислени за четеца (resolveScannedBook)
  const invA = q('SELECT inv_number FROM books WHERE id = ?', a).inv_number;
  assert.match(await fail('books:create', { inv_number: String(invSeq++), title: 'Х', category_id: 1, barcode: String(invA) }), /съвпада с инвентарния номер/);
  const c = await book({ barcode: '777777' });
  assert.match(await fail('books:create', { inv_number: '777777', title: 'Х', category_id: 1 }), /съвпада с баркода/);
  await ok('books:update', Object.assign({}, q('SELECT * FROM books WHERE id = ?', c), { barcode: ' BC-2429-T ' }));
  assert.equal(q('SELECT barcode FROM books WHERE id = ?', c).barcode, 'BC-2429-T', 'баркодът се записва без интервали');
});

test('books:create записва година и страници, подадени като числа, като „2002“, а не „2002.0“', async () => {
  await boot();
  const id = await book({ year: 2002, pages: 250 });
  assert.deepEqual(q('SELECT year, pages FROM books WHERE id = ?', id), { year: '2002', pages: '250' });
});

/* ==================================================================
   5. Справки: просрочените в момента и „най-търсени“ по заглавие
   ================================================================== */
test('stats:report връща просрочените в момента (openOverdue) и подрежда „Най-търсени“ по заглавие, не по екземпляр', async () => {
  await boot();
  const y = String(new Date().getFullYear());
  const r1 = await reader({}), r2 = await reader({}), r3 = await reader({});
  const c1 = await book({ title: 'Под игото (2429)', author: 'Вазов' }), c2 = await book({ title: 'Под игото (2429)', author: 'Вазов' });
  const t = await book({ title: 'Тютюн (2429)' });
  const out = y + '-01-05';
  await ok('loans:checkout', { reader_id: r1, book_id: c1, date_out: out, date_due: y + '-02-05' });
  await ok('loans:checkout', { reader_id: r2, book_id: c2, date_out: out, date_due: y + '-02-05' });
  await ok('loans:checkout', { reader_id: r3, book_id: t, date_out: out, date_due: y + '-02-05' });
  const rep = await ok('stats:report', y);
  assert.ok(rep.openOverdue >= 3, 'трите незавършени заемания с минал падеж се броят: ' + rep.openOverdue);
  const top = rep.topLoans.find(x => x.title === 'Под игото (2429)');
  assert.ok(top && top.n === 2 && top.author === 'Вазов', 'двата екземпляра се събират в едно заглавие: ' + JSON.stringify(rep.topLoans));
  assert.equal(rep.topLoans.filter(x => x.title === 'Под игото (2429)').length, 1, 'заглавието не се повтаря');
  const past = await ok('stats:report', String(Number(y) - 3));
  assert.equal(past.openOverdue, 0, 'за минала година показателят „към днес“ не се връща');
});

/* ==================================================================
   6. МЗС: дати; изтриване със следа
   ================================================================== */
test('mzs:create/update проверяват датата и срока; mzs:delete вписва в следата и отказва несъществуващ ред', async () => {
  await boot();
  assert.match(await fail('mzs:create', { no: '1', date: '', partner: 'НБКМ', title: 'Х' }), /Датата на заявката/);
  assert.match(await fail('mzs:create', { no: '1', date: '2026-13-45', partner: 'НБКМ', title: 'Х' }), /Датата на заявката/);
  assert.match(await fail('mzs:create', { no: '1', date: '2026-03-01', due_date: 'abc', partner: 'НБКМ', title: 'Х' }), /Срокът за връщане/);
  assert.match(await fail('mzs:create', { no: '1', date: '2026-03-01', due_date: '2026-02-01', partner: 'НБКМ', title: 'Х' }), /преди датата/);
  const id = await ok('mzs:create', { no: '1', date: '2026-03-01', due_date: '2026-04-01', partner: 'НБКМ', title: 'Тютюн' });
  assert.match(await fail('mzs:update', { id, due_date: '2026-01-01' }), /преди датата/);
  assert.match(await fail('mzs:update', { id, date: '2026-99-01' }), /Датата на заявката/);
  await ok('mzs:update', { id, status: 'получено' });
  // Стар ред с празна дата (отпреди проверката): смяна само на статуса минава, поправка с невалидна дата — не.
  db.prepare("UPDATE mzs_requests SET date = '' WHERE id = ?").run(id);
  await ok('mzs:update', { id, status: 'върнато' });
  assert.match(await fail('mzs:update', { id, date: 'abc' }), /Датата на заявката/);
  await ok('mzs:update', { id, date: '2026-03-02' });
  assert.match(await fail('mzs:delete', 999999), /вече не съществува/);
  await ok('mzs:delete', id);
  assert.deepEqual(lastAudit(), { action: 'Изтрита МЗС заявка', detail: '№ 1/2026 — Тютюн (изходящо)' });
});

/* ==================================================================
   7. Внос: лимитът на записите важи и тук
   ================================================================== */
test('import:run спира на лимита от „Ограничения“ и предупреждава, вместо да го прескочи', async () => {
  await boot();
  const before = q('SELECT COUNT(*) AS n FROM books').n;
  db.prepare('UPDATE settings SET limit_books = ? WHERE id = 1').run(before + 2);
  const file = path.join(app.userData, 'vnos-2429.csv');
  fs.writeFileSync(file, '﻿Заглавие;Автор\nВнос едно;А\nВнос две;Б\nВнос три;В\nВнос четири;Г\nВнос едно;А\n', 'utf8');
  const loaded = await app.invoke('import:load', file);
  assert.equal(loaded.ok, true, loaded.error);
  const rep = await ok('import:run', { mapping: { 0: 'title', 1: 'author' }, options: { skipDuplicates: true } });
  assert.equal(rep.added, 2, 'само свободните две места се запълват');
  assert.equal(rep.skipped, 3);
  assert.match(rep.warnings.join('\n'), /2 реда не бяха въведени: достигнат е зададеният лимит/, 'дубликатът не се брои като „над лимита“');
  assert.equal(q('SELECT COUNT(*) AS n FROM books').n, before + 2);
  db.prepare('UPDATE settings SET limit_books = 0 WHERE id = 1').run();
  invSeq = (q('SELECT next_inv_number AS n FROM settings WHERE id = 1').n || invSeq) + 1; // вносът даде автоматични номера
});

/* ==================================================================
   8. Дребни проверки по регистрите
   ================================================================== */
test('visits:add, calendar:addClosed, shelves:rename, housebound:remove, suggestions:setStatus — проверки и следа', async () => {
  await boot();
  assert.match(await fail('visits:add', { date: '2026-03-03', count: '2.5' }), /цяло число/);
  assert.match(await fail('visits:add', { date: '2026-03-03', count: '3abc' }), /цяло число/);
  await ok('visits:add', { date: '2026-03-03', count: '3' });
  assert.match(await fail('calendar:addClosed', { date: '2026-5-1', reason: 'х' }), /невалидна/);
  assert.match(await fail('calendar:addClosed', { date: '2026-02-30', reason: 'х' }), /невалидна/);
  await ok('calendar:addClosed', { date: '2026-05-01', reason: 'Ден на труда' });

  const shelf = await ok('shelves:create', 'Лято');
  assert.match(await fail('shelves:rename', { id: 999999, name: 'Х' }), /не е намерена/);
  await ok('shelves:rename', { id: shelf, name: 'Лято 2026' });
  assert.deepEqual(lastAudit(), { action: 'Витрина в каталога', detail: 'преименувана „Лято“ → „Лято 2026“' });

  assert.match(await fail('housebound:remove', 999999), /няма график/);
  const r = await reader({ name: 'Надомен Читател' });
  await ok('housebound:save', { reader_id: r, day: 'вторник', frequency: 'седмично' });
  await ok('housebound:remove', r);
  assert.deepEqual(lastAudit(), { action: 'Обслужване по домовете', detail: 'спрян график за Надомен Читател' });

  assert.match(await fail('suggestions:setStatus', { id: 999999, status: 'одобрено' }), /вече не съществува/);
});

test('dnevnik:saveDay отказва отрицателни числа и невалидна дата', async () => {
  await boot();
  assert.match(await fail('dnevnik:saveDay', { date: '2026-03-03', a_age_u14: '-5' }), /не може да бъде отрицателно/);
  assert.match(await fail('dnevnik:saveDay', { date: '2026-02-30', a_age_u14: '5' }), /Датата на деня/);
  await ok('dnevnik:saveDay', { date: '2026-03-03', a_age_u14: '5' });
  assert.equal(q("SELECT a_age_u14 FROM dnevnik_days WHERE date = '2026-03-03'").a_age_u14, 5);
});

/* ==================================================================
   9. Читатели: броят заети/просрочени в списъка
   ================================================================== */
test('readers:list връща open_loans и overdue_loans за всеки читател (и при търсене)', async () => {
  await boot();
  const r = await reader({ name: 'Брояч Заетов', card_no: '2429-cnt' });
  const b1 = await book({}), b2 = await book({});
  await ok('loans:checkout', { reader_id: r, book_id: b1, date_out: daysAgo(40), date_due: daysAgo(10) });
  await ok('loans:checkout', { reader_id: r, book_id: b2, date_out: daysAgo(1), date_due: daysAgo(-29) });
  const row = (await ok('readers:list')).find(x => x.id === r);
  assert.deepEqual({ o: row.open_loans, d: row.overdue_loans }, { o: 2, d: 1 });
  const found = (await ok('readers:list', 'Заетов')).find(x => x.id === r);
  assert.deepEqual({ o: found.open_loans, d: found.overdue_loans }, { o: 2, d: 1 }, 'и при търсене по име');
});

/* ==================================================================
   10. Екранен слой (jsdom)
   ================================================================== */
const STATS_MOCK = { fundCount: 0, fundValue: 0, readersCount: 0, loansCount: 0, visits: 0, returnedOnTime: 0, returnedLate: 0,
  acquiredCount: 0, acquiredValue: 0, deaccessionedCount: 0, deaccessionedValue: 0, fundByLanguage: [], fundByDepartment: [],
  fundByCategory: [], topLoans: [], topReaders: [], openOverdue: 0 };
const DASH_MOCK = { fundCount: 10, fundValue: 100, loansOpen: 1, activeReaders: 1, overdueCount: 0, upcoming: [], holdsReady: 0, holdsWaiting: 0,
  overdueRows: [], year: 2026, acquiredYear: 0, deaccessionedYear: 0, loansYear: 0, readersYear: 0, inventoryScannedYear: 0, inventoryTarget: 1,
  inventoryPct: 10, today: { dueReminders: 0, reregDue: 0, longOverdue: 0, dnevnikFilled: true } };
const emojiRe = /[\u{1F300}-\u{1FAFF}\u2705\u23ED\u{1F4D7}\u{1F4D5}\u{1F50D}]/u;

test('показателите в Инвентарна книга, Справки, Аналитично описание и Готови справки са с щрихови SVG икони, не емоджита', async () => {
  const dom = buildDom({
    'invBook.list': [{ id: 1, inv_number: 1, title: 'К', status: 'наличен', price: 3, quantity: 1, register_date: '2026-01-01' }],
    'stats.report': STATS_MOCK, 'analytics.list': [], 'analytics.years': [], 'periodicals.list': [],
    'reports.list': [{ id: 'fund_movement', title: 'Движение', desc: '' }],
    'reports.run': { fundCount: 5, fundValue: 10, year: '2026', rows: [], total: 0, newThisYear: 0 }
  });
  const { window } = dom; await settle();
  await window.renderInvBook(); await settle();
  const ib = window.document.querySelectorAll('#view .kpi-ico');
  assert.equal(ib.length, 4);
  ib.forEach(el => { assert.ok(el.querySelector('svg'), 'SVG икона'); assert.doesNotMatch(el.textContent, emojiRe); });
  await window.renderStats(); await settle();
  const st = window.document.querySelectorAll('#view .kpi-ico');
  assert.equal(st.length, 4);
  st.forEach(el => assert.ok(el.querySelector('svg') && !emojiRe.test(el.textContent), 'справки: SVG'));
  await window.renderAnalytics(); await settle();
  window.document.querySelectorAll('#view .kpi-ico').forEach(el => assert.ok(el.querySelector('svg') && !emojiRe.test(el.textContent), 'аналитично: SVG'));
  assert.ok(window.eval('KPI_ICONS.money').includes('<svg'), 'KPI_ICONS е общ набор от navigation.js');
  // Печатът на инвентарната книга и справката с пари минават през mnyCell / kpi без емоджи
  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'reports.js'), 'utf8');
  assert.doesNotMatch(src, /kpi\('[^']*[\u{1F300}-\u{1FAFF}\u2705]/u, 'reports.js не подава емоджи на kpi()');
});

test('Табло: бързите действия са лента под показателите, „За днес“ е до „Просрочени“, а заглавието му е без емоджи', async () => {
  const dom = buildDom({ 'dashboard.full': DASH_MOCK });
  const { window } = dom; await settle();
  await window.renderDash(); await settle();
  const doc = window.document;
  const act = doc.querySelector('#view .card.dashActions');
  assert.ok(act, 'лентата с бързи действия има клас dashActions');
  assert.equal(act.querySelectorAll('.quickBtn').length, 6);
  const heads = [...doc.querySelectorAll('#view .card > h3')].map(h => h.textContent.trim());
  assert.ok(heads.indexOf('Бързи действия') < heads.indexOf('Просрочени заемания'), 'действията са преди просрочените');
  const grids = [...doc.querySelectorAll('#view .grid.g3')];
  const firstGridHeads = [...grids[0].querySelectorAll(':scope > .card > h3')].map(h => h.textContent.trim());
  assert.deepEqual(firstGridHeads, ['Просрочени заемания', 'За днес']);
  assert.doesNotMatch(heads.join('|'), emojiRe, 'няма емоджи в заглавията');
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  assert.match(css, /\.dashActions \.quickGrid\{grid-template-columns:repeat\(6,minmax\(0,1fr\)\)\}/);
});

test('Читатели: колона „Заети“ с „!“ при просрочие, бутоните на реда са в .rowActs, таблицата е readersTable', async () => {
  const dom = buildDom({
    'readers.list': [
      { id: 1, name: 'Иванов, Иван', card_no: '1', category: 'възрастен', status: 'активен', open_loans: 2, overdue_loans: 1 },
      { id: 2, name: 'Петров', card_no: '2', category: 'възрастен', status: 'активен', open_loans: 0, overdue_loans: 0 },
      { id: 3, name: 'Стар запис', card_no: '3', category: 'възрастен', status: 'активен' }
    ],
    'searchHistory.suggest': []
  });
  const { window } = dom; await settle();
  await window.renderReaders(); await settle();
  const doc = window.document;
  assert.ok(doc.querySelector('#view table.ledger.readersTable'), 'класът readersTable (специфичност table.ledger.readersTable)');
  const rows = doc.querySelectorAll('#rBody tr');
  const c1 = rows[0].querySelector('.loansCnt');
  assert.equal(c1.textContent.trim(), '2 !');
  assert.ok(c1.classList.contains('warn'));
  assert.match(c1.title, /1 просрочен документ от 2 заети/);
  const c2 = rows[1].querySelector('.loansCnt');
  assert.equal(c2.textContent.trim(), '0');
  assert.ok(!c2.classList.contains('warn'));
  assert.equal(rows[2].querySelector('.loansCnt'), null, 'ред без броячи (стар отговор) остава празен, не „undefined“');
  assert.equal(rows[0].querySelectorAll('.rowActs .btn').length, 6);
  assert.ok(doc.querySelector('#rBody button[onclick="printCardOne(1)"]'), 'бутонът „Карта“ остава на реда');
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  assert.match(css, /table\.ledger\.readersTable td:first-child\{white-space:nowrap\}/);
  assert.match(css, /table\.ledger\.ibTable th\{white-space:nowrap/);
  assert.match(css, /table\.ledger\.oditTable td:nth-child\(2\)/);
});

test('Гише без избран читател: „Днес на гишето“ брои заеманията и връщанията от следата за ДНЕС в местно време', async () => {
  /* Часовникът е закован на 00:30 местно време (21:30 UTC предния ден) — точно
     когато „днес“ по UTC (today() в core.js) и местният ден се разминават. */
  const FIXED = '2026-09-04T21:30:00Z';
  const dom = buildDom({
    'settings.get': { loan_days: 30 }, 'holds.list': [],
    'audit.list': [
      { id: 4, ts: '2026-09-04 21:40:00', user: 'Мария', action: 'Заемане', detail: 'инв. № 5 — Под игото' },   // 00:40 местно, днес
      { id: 3, ts: '2026-09-04 21:35:00', user: 'Мария', action: 'Връщане', detail: 'инв. № 7 — Тютюн' },      // 00:35 местно, днес
      { id: 2, ts: '2026-09-04 21:36:00', user: 'Мария', action: 'Нов читател', detail: 'карта 9' },          // друго действие
      { id: 1, ts: '2026-09-04 20:00:00', user: 'Мария', action: 'Заемане', detail: 'инв. № 1 — Вчерашна' }    // 23:00 местно ВЧЕРА
    ]
  });
  const { window } = dom; await settle();
  window.eval(`{ const RealDate = Date; const FIXED = new RealDate('${FIXED}').getTime();
    window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [FIXED])); } static now() { return FIXED; } }; }`);
  window.eval("CIRC.readerId = null; CIRC.mode = 'out';");
  await window.renderCirc(); await settle(); await settle();
  const box = window.document.querySelector('#circToday');
  assert.ok(box, 'картата „Днес на гишето“ е под двете карти');
  const chips = [...box.querySelectorAll('.chip')].map(c => c.textContent.trim());
  assert.deepEqual(chips.slice(0, 2), ['1 заемане', '1 връщане']);
  const ops = [...box.querySelectorAll('.circOp')].map(o => o.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(ops, ['00:40 заемане инв. № 5 — Под игото Мария', '00:35 връщане инв. № 7 — Тютюн Мария'],
    'само заемания и връщания от МЕСТНИЯ ден, в местен час');
  assert.equal(dom.calls['audit.list'].length, 1);
  assert.doesNotMatch(window.document.querySelector('#view').innerHTML, /💰|🏠|📌 Резервирай/, 'без емоджи-бутони на гишето');
});

test('Кардексът: „Затвори“ пречертава списъка на Периодика; „Добави брой“ известява и не пречертава при отказ; Enter добавя', async () => {
  const dom = buildDom({
    'periodicals.list': [{ id: 7, title: 'Труд', issues_count: 0 }],
    'periodicals.get': { id: 7, title: 'Труд', freq: 'месечно', issues: [] },
    'periodicalIssues.add': 5
  });
  const { window } = dom; await settle();
  window.location.hash = '#periodika'; await window.route(); await settle();
  await window.openPeriodical(7); await settle();
  const listCalls = dom.calls['periodicals.list'].length;
  window.document.querySelector('#issueF [name=issue_no]').value = '12';
  window.document.querySelector('#issueF [name=issue_no]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.equal(dom.calls['periodicalIssues.add'].length, 1, 'Enter в „Номер на брой“ добавя');
  assert.equal(dom.calls['periodicalIssues.add'][0].issue_no, '12');
  assert.equal(dom.calls['periodicals.get'].length, 2, 'кардексът се презарежда след успешен запис');
  // Отказ от обработчика ({ok:false}): формата остава, кардексът не се презарежда
  const realApi = window.api;
  window.api = new Proxy(realApi, { get: (t, p) => p === 'periodicalIssues'
    ? { add: async () => ({ ok: false, error: 'Датата на броя (2026-02-30) е невалидна.' }) } : t[p] });
  const toasts = []; const origToast = window.toast; window.toast = (m, ty) => toasts.push(ty + ':' + m);
  const gets = dom.calls['periodicals.get'].length;
  window.document.querySelector('#issueF [name=issue_no]').value = '13';
  await window.addIssue(7); await settle();
  assert.equal(dom.calls['periodicals.get'].length, gets, 'при отказ кардексът НЕ се пречертава (попълненото остава)');
  assert.ok(window.document.querySelector('#issueF'), 'формата остава');
  assert.match(toasts.join('|'), /err:Датата на броя/);
  window.api = realApi; window.toast = origToast;
  // Затвори → списъкът зад прозореца се пречертава (VIEW === 'periodika')
  window.document.querySelector('#modal footer .btn.pri').click(); await settle();
  assert.equal(dom.calls['periodicals.list'].length, listCalls + 1, '„Затвори“ пречертава списъка');
});

test('Резервация: Enter в полето „Заета книга“ записва (баркод четец)', async () => {
  const dom = buildDom({ 'readers.get': { id: 4, name: 'Иван', card_no: '4' }, 'holds.add': { inv_number: 5, queue: 1 },
    'settings.get': { loan_days: 30, max_books: 5 }, 'circRules.effective': { loan_days: 30, max_books: 5 }, 'loans.byReader': [], 'account.get': { balance: 0 }, 'holds.list': [] });
  const { window } = dom; await settle();
  window.eval("CIRC.readerId = 4; CIRC.mode = 'out';");
  await window.holdPrompt(4); await settle();
  const f = window.document.querySelector('#holdF [name=code]');
  assert.equal(window.document.activeElement, f, 'полето е на фокус');
  f.value = '123';
  f.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.ok(dom.calls['holds.add'] && dom.calls['holds.add'].length === 1, 'Enter записва резервацията');
  assert.equal(dom.calls['holds.add'][0].code, '123');
});

test('Аналитично описание: избор от списъка (целият етикет) свързва книгата; „инв. № N“ се търси по номера', async () => {
  const dom = buildDom({
    'periodicals.list': [],
    'links.search': ([a]) => a.q === '101' || a.q === 'Под' ? [{ id: 9, label: 'инв. № 101 · Вазов, Иван. Под игото' }] : []
  });
  const { window } = dom; await settle();
  await window.analyticForm(null); await settle();
  const bp = window.document.querySelector('#anlF [name=book_pick]');
  const hidden = window.document.querySelector('#anlF [name=book_id]');
  bp.value = 'Под'; bp.dispatchEvent(new window.Event('input')); await settle();
  assert.equal(hidden.value, '', 'частично търсене още не свързва');
  bp.value = 'инв. № 101 · Вазов, Иван. Под игото'; bp.dispatchEvent(new window.Event('input')); await settle();
  assert.equal(hidden.value, '9', 'избраният от списъка етикет свързва книгата');
  assert.equal(dom.calls['links.search'].length, 1, 'познат етикет не търси наново');
  // Нов формуляр, директно „инв. № 101“ — търси се по номера
  await window.analyticForm(null); await settle();
  const bp2 = window.document.querySelector('#anlF [name=book_pick]');
  bp2.value = 'инв. № 101'; bp2.dispatchEvent(new window.Event('input')); await settle();
  assert.equal(dom.calls['links.search'].at(-1).q, '101');
});

test('„Нов читател“ от Таблото: след записа остава Таблото, не списъкът с читатели', async () => {
  const dom = buildDom({ 'dashboard.full': DASH_MOCK, 'readers.create': 5, 'pdp.status': { configured: false }, 'readers.list': [], 'searchHistory.suggest': [] });
  const { window } = dom; await settle();
  window.location.hash = '#dash'; await window.route(); await settle();
  await window.readerForm(); await settle();
  window.document.querySelector('#readerF [name=name]').value = 'Нов Читател';
  window.document.querySelector('#readerF [name=card_no]').value = '77';
  window.document.querySelector('#readerF [name=gdpr_consent]').checked = true;
  const dashCalls = dom.calls['dashboard.full'].length;
  await window.saveReader(null); await settle();
  assert.equal(dom.calls['dashboard.full'].length, dashCalls + 1, 'Таблото се пречертава');
  assert.equal(dom.calls['readers.list'], undefined, 'списъкът с читатели не се чертае под заглавие „Табло“');
  assert.ok(window.document.querySelector('#view .dashActions'), 'екранът е Таблото');
});

test('Дневник: отрицателно число в клетка не се праща и клетката се връща; отказ от обработчика връща старата стойност', async () => {
  const dom = buildDom({});
  const { window } = dom; await settle();
  window._DNEVNIK = { days: [{ date: '2026-03-03', a_age_u14: 4 }] };
  const el = window.document.createElement('input');
  el.dataset.date = '2026-03-03'; el.dataset.field = 'a_age_u14'; el.value = '-5';
  window.document.body.appendChild(el);
  const toasts = []; window.toast = (m, t) => toasts.push(t + ':' + m);
  await window.dnevnikSaveCell(el); await settle();
  assert.equal(dom.calls['dnevnik.saveDay'], undefined, 'нищо не се праща');
  assert.equal(el.value, '4', 'клетката се връща на записаното');
  assert.match(toasts.join('|'), /err:.*цяло число, 0 или повече/);
});

test('call(): отказан файлов диалог не е червена грешка; изнасянията на читатели/дневник/каталог минават през call()', async () => {
  const dom = buildDom({});
  const { window } = dom; await settle();
  const toasts = []; window.toast = (m, t) => toasts.push(t + ':' + m);
  const r = await window.call(Promise.resolve({ ok: false, error: 'Отказано от потребителя.' }));
  assert.equal(r, null);
  assert.deepEqual(toasts, [], 'без известие при отказ');
  await window.call(Promise.resolve({ ok: false, error: 'Друга грешка' }));
  assert.deepEqual(toasts, ['err:Друга грешка']);
  for (const [f, fn] of [['readers.js', 'exportReadersCsv'], ['dnevnik.js', 'exportDnevnikCsv'], ['catalog.js', 'exportCatalog'], ['catalog.js', 'exportCatalogCsv']]) {
    const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', f), 'utf8');
    const body = src.slice(src.indexOf('async function ' + fn), src.indexOf('window.' + fn + ' ='));
    assert.match(body, /await call\(/, fn + ' минава през call()');
    assert.doesNotMatch(body, /toast\(res\.error/, fn + ' не показва отказа като грешка');
  }
});

test('Персоналии: „Свържи“ + „Затвори“ пречертават списъка; без промяна по връзките — не', async () => {
  const dom = buildDom({
    'persons.list': [{ id: 1, name: 'Иван Местен', links: 0 }], 'persons.get': { id: 1, name: 'Иван Местен' },
    'links.list': [], 'links.add': 1
  });
  const { window } = dom; await settle();
  window.location.hash = '#persons'; await window.route(); await settle();
  await window.personView(1); await settle();
  const n0 = dom.calls['persons.list'].length;
  window.document.querySelector('#modal footer .btn').click(); await settle();
  assert.equal(dom.calls['persons.list'].length, n0, 'без промяна — без пречертаване');
  await window.personView(1); await settle();
  await window.refreshLinks('персона', 1); await settle();
  window.document.querySelector('#modal footer .btn').click(); await settle();
  assert.equal(dom.calls['persons.list'].length, n0 + 1, 'след промяна по връзките списъкът се пречертава');
});

test('Табло → сканиране: код, който е и документ, и читателска карта, показва и двете карти', async () => {
  const dom = buildDom({
    'books.byBarcode': { id: 1, inv_number: 12, title: 'Книга', status: 'наличен' },
    'readers.byCard': { id: 2, name: 'Читател', card_no: '12', status: 'активен' },
    'loans.byBook': [], 'loans.byReader': []
  });
  const { window } = dom; await settle();
  window.document.querySelector('#view').innerHTML = '<div id="dashScanResult"></div>';
  await window.dashLookup('12'); await settle();
  const box = window.document.querySelector('#dashScanResult');
  assert.equal(box.querySelectorAll('.scanHit').length, 2);
  assert.match(box.textContent, /съвпада и с документ, и с читателска карта/);
});

test('Инвентаризация: колоната „Обхват“ показва ограничението по отдел', async () => {
  const dom = buildDom({
    'inventorySessions.requirement': { active: 100, pct: 10, target: 10, scannedYear: 0, naturalLoss: 0 },
    'inventorySessions.list': [{ id: 1, no: 1, year: '2026', date: '2026-02-02', scope: 'справочен фонд', department: 'справочен', pool_size: 3, scanned: 1, missing: 0, committee1: 'М', status: 'приключена' }]
  });
  const { window } = dom; await settle();
  window.eval('INVENT_SESSION = null');
  await window.renderInvent(); await settle();
  assert.match(window.document.querySelector('#view tbody').textContent, /справочен фонд\s*отдел „справочен“/);
});

test('Одитна следа: датата и часът са на два реда, а текстът остава „дата, час“ (копиране, четци)', async () => {
  const dom = buildDom({ 'audit.list': [{ id: 1, ts: '2026-01-03 22:40:00', user: 'М', action: 'Заемане', detail: 'инв. № 1' }] });
  const { window } = dom; await settle();
  window.location.hash = '#odit'; await window.route(); await settle();
  const td = window.document.querySelector('#view td.ts');
  assert.ok(td, 'клетката има клас ts');
  assert.equal(td.textContent, new Date('2026-01-03T22:40:00Z').toLocaleString('bg-BG'));
  assert.ok(td.querySelector('.sep') && td.querySelector('.hint'), 'разделител + час на отделен ред');
  assert.ok(window.document.querySelector('#view table.oditTable'));
});

test('mnyCell(): левове над евро в една клетка; Просрочени и Инвентарна книга го ползват', async () => {
  const dom = buildDom({});
  const { window } = dom; await settle();
  const html = window.eval('mnyCell(7.5)');
  assert.match(html, /^<span class="money" title="7\.50 лв\. \/ 3\.83 €">7\.50 лв\.<small>3\.83 €<\/small><\/span>$/);
  for (const f of ['overdue.js', 'inv-book.js']) {
    assert.match(fs.readFileSync(path.join(APP_DIR, 'src', 'views', f), 'utf8'), /mnyCell\(/, f);
  }
});

test('Справки: „Просрочени в момента“ се показва с връзка към Просрочени; „Най-търсени“ носи автора', async () => {
  const dom = buildDom({ 'stats.report': Object.assign({}, STATS_MOCK, { openOverdue: 8, returnedOnTime: 2, topLoans: [{ title: 'Под игото', author: 'Вазов', n: 2 }] }) });
  const { window } = dom; await settle();
  await window.renderStats(); await settle();
  const v = window.document.querySelector('#view');
  assert.match(v.textContent, /Просрочени в момента \(към днес, незавършени\)\s*8/);
  assert.ok(v.querySelector('.statRows a[href="#over"]'));
  assert.match(v.querySelector('.rankTitle').textContent, /Под игото · Вазов/);
});

test('Настройки → Лични данни: подсказката и въпросът включват записите в резервации, предложения, МЗС, напомняния и посещения', async () => {
  const dom = buildDom({ 'gdpr.candidates': { years: 5, count: 0, auditCount: 0, searchCount: 0, otherCount: 3, cutoff: '2021-01-01' },
    'gdpr.anonymize': { anonymized: 0, auditCleared: 0, searchCleared: 0, otherCleared: 3 } });
  const { window } = dom; await settle();
  window.document.body.insertAdjacentHTML('beforeend', '<div id="anonHint"></div>');
  await window.loadAnonHint(); await settle();
  assert.match(window.document.getElementById('anonHint').textContent, /3 записа в резервации, предложения, МЗС, напомняния и посещения/);
  let asked = '';
  window.confirm = (m) => { asked = m; return true; };
  const toasts = []; window.toast = (m) => toasts.push(m);
  await window.runAnonymize(); await settle();
  assert.match(asked, /3 записа в резервации, предложения, МЗС, напомняния и посещения по домовете губят името/);
  assert.equal(dom.calls['gdpr.anonymize'].length, 1, 'бутонът не е заключен само от заеманията');
  assert.match(toasts.join('|'), /3 други записа/);
});

test('Читател → Редакция → „Сметка“: пита само при незаписани промени', async () => {
  const dom = buildDom({ 'readers.get': { id: 3, name: 'Иван', card_no: '3', category: 'възрастен', status: 'активен' }, 'pdp.status': { configured: false },
    'account.get': { lines: [], balance: 0 }, 'settings.get': {} });
  const { window } = dom; await settle();
  let asked = 0; window.confirm = () => { asked++; return false; };
  await window.readerForm(3); await settle();
  window.readerFormToAccount(3); await settle();
  assert.equal(asked, 0, 'без промени — без въпрос');
  assert.equal(dom.calls['account.get'].length, 1, 'сметката се отваря');
  await window.readerForm(3); await settle();
  window.document.querySelector('#readerF [name=phone]').value = '0888';
  window.readerFormToAccount(3); await settle();
  assert.equal(asked, 1, 'при промяна пита');
  assert.equal(dom.calls['account.get'].length, 1, 'отказът не отваря сметката');
});

test('Онлайн каталог: добавяне/махане в прозореца на витрината опреснява броячите в списъка', async () => {
  const dom = buildDom({
    'shelves.list': [{ id: 1, name: 'Лято', count: 0 }], 'shelves.items': [], 'shelves.addBook': { inv_number: 5, title: 'К' }, 'shelves.removeBook': true
  });
  const { window } = dom; await settle();
  window.document.body.insertAdjacentHTML('beforeend', '<div id="shelvesBox"></div>');
  await window.loadShelvesBox(); await settle();
  await window.openShelf(1); await settle();
  // openShelf() сам чете shelves.list за заглавието; loadShelvesBox() прави ОЩЕ едно
  // четене — броим ги по двойки: прозорец + списък зад него.
  const n0 = dom.calls['shelves.list'].length;
  const el = window.document.querySelector('#shelfScan');
  el.value = '5'; el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
  assert.equal(dom.calls['shelves.list'].length, n0 + 2, 'след добавяне: прозорецът И списъкът с витрини се опресняват');
  await window.removeFromShelf(1, 7); await settle();
  assert.equal(dom.calls['shelves.list'].length, n0 + 4, 'след махане — също');
});

test('Внос: предупрежденията от обработчика (лимит, номера) се показват в прозореца с резултата', async () => {
  const dom = buildDom({ 'importData.run': { added: 1, skipped: 2, errors: [], usedInv: [], warnings: ['2 реда не бяха въведени: достигнат е зададеният лимит от 5 документи във фонда („Настройки“ → „Ограничения“).'] } });
  const { window } = dom; await settle();
  window.document.body.insertAdjacentHTML('beforeend', '<form id="impOptF"></form><form id="mapF"><select name="col0"><option value="title" selected>title</option></select></form>');
  window.eval("IMPORT_INFO = { headers: ['Заглавие'], fields: { title: 'Заглавие' } }");
  await window.importRun(); await settle();
  assert.match(window.document.querySelector('#modal').textContent, /Предупреждения: 1[\s\S]*достигнат е зададеният лимит от 5 документи/);
});
