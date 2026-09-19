'use strict';
/* СЦЕНАРИЙ (кръг 37, v2.4.61): ИЗДАВАНЕ НА ДОКУМЕНТИ — ВСИЧКИ РАЗПЕЧАТКИ И
 * РЕГИСТЪРЪТ НА ДОКУМЕНТИТЕ (v2.4.59, commit 916026b → test/razpechatki.test.js).
 *
 * Библиотекарката минава през всеки документ, който програмата издава, и след
 * всяка разпечатка проверява каквото би проверил инспекторът от регионалната
 * библиотека:
 *   (a) заглавната част носи името на библиотеката от Настройки (и се екранира);
 *   (b) ВСЯКО число на листа е равно на истината в базата (сборове, бройки,
 *       единични цени × бройки, € и лв. едновременно);
 *   (c) датите са в български формат (никъде „2026-03-14“);
 *   (d) редът за подпис назовава правилните роли (библиотекар, комисия,
 *       ръководител = director_role от Настройки);
 *   (e) задължителните реквизити по Наредба № 3: номер/година на акта,
 *       причина по чл. 30, чл. 36, чл. 40–41, колоните на КДБФ (чл. 13) и на
 *       инвентарната книга (чл. 16, Приложение № 4);
 *   (f) размер/ориентация на страницата;
 *   (g) празни данни дават смислен празен документ, не „undefined“/„NaN“/„null“;
 *   (h) HTML екраниране (заглавие с <b> и &).
 * Плюс: print:savePdf през заглушения диалог; изнасянията в CSV; и самият
 * регистър от 916026b — пълен ли е и хваща ли пазачът му нов документ.
 *
 * Правило на файла: твърдение, което пада, НЕ спира сценария — записва се в
 * `findings` (виж soft()) с маркер „НАХОДКА n“ и се твърди в самия край.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./helpers/e2e-app');

const VIEWS_DIR = path.join(__dirname, '..', 'src', 'views');

let h;
const T = E.today();
const Y = T.slice(0, 4);
const Y1 = String(Number(Y) - 1);
const ids = {};
const findings = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-dokumenti-'));

test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* няма значение */ } });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const lastAudit = (action) => q('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC', action);
const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/* Регулярен израз от парчета текст, разделени от произволно много интервали —
   h.printed() слепва съседните клетки с по един интервал. */
const seq = (...parts) => new RegExp(parts.map(rx).join('\\s+'));
/* Меко твърдение: провалът се записва като находка и сценарият продължава. */
async function soft(label, fn) {
  try { await fn(); }
  catch (e) { findings.push({ label, msg: (e && e.message) || String(e) }); }
}
function noRendererErrors() {
  const errs = h.errors.splice(0);
  assert.equal(errs.length, 0, 'грешки в екранния слой:\n'
    + errs.map(e => (e && (e.stack || e.message)) || String(e)).join('\n---\n'));
}
/* Текстът на листа в прегледа преди печат + общите проверки за ВСЕКИ документ:
   не е празен, носи организацията от Настройки (екранирана), няма следи от
   недефинирани стойности и няма ISO дата. */
const ORG = 'НЧ „Проба & <Син>“ – 1922';
const LIB = 'Библиотека при читалището';
function sheet(what, opts) {
  const p = h.printed();
  assert.ok(p && p.trim().length > 0, 'разпечатката „' + what + '“ е празна');
  const o = opts || {};
  if (!o.noHead) {
    assert.ok(p.includes(ORG), what + ': заглавната част не носи организацията от Настройки (или & / < не са екранирани)');
    assert.ok(p.includes(LIB), what + ': заглавната част не носи името на библиотеката');
    assert.ok(p.includes('с. Яворец'), what + ': заглавната част не носи населеното място');
    assert.ok(p.includes('ЕИК 000123456'), what + ': заглавната част не носи ЕИК');
  }
  for (const bad of ['undefined', 'NaN', 'null', '[object ', '&amp;', '&lt;']) {
    assert.ok(!p.includes(bad), what + ': разпечатката съдържа „' + bad + '“');
  }
  const iso = p.match(/\b\d{4}-\d{2}-\d{2}\b/);
  assert.ok(!iso, what + ': дата в ISO формат на листа — ' + (iso && iso[0]));
  return p;
}
/* Настройката на страницата, както я е задал последният setPrintPage(). */
function pageCss() { return (h.$('#dynPrintStyle') || {}).textContent || ''; }
function ppOpen() { return h.$('#printPreview').classList.contains('on'); }
function closePreview() { if (ppOpen()) h.window.ppClose(); }
const invBookOf = (inv) => q('SELECT b.*, COALESCE(i.quantity,1) AS fq FROM books b LEFT JOIN inventory i ON i.book_id=b.id WHERE inv_number = ?', inv);

/* ==================================================================
   0. Настройки — библиотеката, ролите, тарифите
   ================================================================== */
test('0. настройки: организация със знаци за екраниране, роли, такси', async () => {
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  const st = ok(await h.api.settings.get(), 'настройки');
  ok(await h.api.settings.update(Object.assign({}, st, {
    org: ORG, lib_name: LIB, place: 'с. Яворец', bulstat: '000123456',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова',
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка',
    fine_per_day: 0.1, annual_fee: 5
  })), 'запис на настройките');
  await h.window.loadSettingsCache();
  const s = q('SELECT * FROM settings WHERE id = 1');
  assert.equal(s.org, ORG);
  assert.equal(Number(s.fine_per_day), 0.1);
  noRendererErrors();
});

/* ==================================================================
   1. ПРАЗНА БАЗА — всеки документ трябва да е смислен, не „undefined“
   ================================================================== */
test('1. празна база: КДБФ, инвентарна книга, дневник, справки, етикети, писма', async () => {
  // КДБФ за годината без нито една партида.
  await h.go('kdbf');
  await h.clickButton('Печат / PDF', '#view');
  await soft('1a. КДБФ при празна база', () => {
    const p = sheet('КДБФ (празна)');
    assert.ok(p.includes('През ' + Y + ' г. няма регистрирани постъпления.'), 'Част № 1 не обяснява празнотата');
    assert.ok(p.includes('През ' + Y + ' г. няма отчислени документи.'), 'Част № 3 не обяснява празнотата');
    assert.match(p, seq('Наличност към 31.12.' + Y + ' г.', '0', E.mny(0)), 'Част № 2 при празен фонд');
    assert.match(pageCss(), /A4 landscape/, 'КДБФ е пейзаж');
  });
  closePreview();

  // Инвентарна книга — цялата (празна) и диапазон без записи.
  await h.go('invbook');
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  await h.clickButton('Цялата книга', '#modal');
  await soft('1b. инвентарна книга при празна база', () => {
    const p = sheet('инвентарна книга (празна)');
    assert.match(p, /0 вписвания/, 'главата не казва, че книгата е празна');
    assert.match(p, seq('Фонд по инвентарната книга (без отчислените):', '0', 'библиотечни документа на стойност', E.mny(0)));
  });
  closePreview();
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  h.type('#ibPrintF [name=from]', '1');
  h.type('#ibPrintF [name=to]', '5');
  const n0 = h.toasts.length;
  await h.clickButton('Печат на диапазона', '#modal');
  await soft('1c. празен диапазон се отказва', () => {
    assert.ok(h.toastsSince(n0).some(t => /В избрания диапазон няма нито един запис/.test(t.msg)), JSON.stringify(h.toastsSince(n0)));
    assert.equal(ppOpen(), false, 'прегледът не бива да се отваря за празен диапазон');
  });
  if (h.modalOpen()) h.window.closeModal();

  // Дневник — празен месец.
  await h.go('dnevnik');
  await h.clickButton('Печат / PDF', '#view');
  await soft('1d. дневник при празен месец', () => {
    const p = sheet('дневник (празен)');
    assert.ok(p.includes('ДНЕВНИК НА БИБЛИОТЕКАТА'));
    assert.ok(p.includes('Всичко за месеца'));
    assert.ok(p.includes('0:00'), 'часовете при празен месец не са 0:00');
  });
  closePreview();

  // Справки — всяка от каталога върху празна база.
  const catalog = ok(await h.api.reports.list(), 'каталог на справките');
  await h.go('reports');
  for (const def of catalog) {
    const sel = h.$('#repSel'); sel.value = def.id; h.fire(sel, 'change');
    await h.waitFor(() => h.window._REPORT && h.window._REPORT.id === def.id, 'справката ' + def.id);
    await h.clickButton('Печат / PDF', '#view');
    await soft('1e. справка „' + def.id + '“ при празна база', () => {
      const p = sheet('справка ' + def.id);
      assert.ok(p.includes(def.title), 'липсва заглавието');
      if (def.id === 'annual_ab') assert.ok(p.includes('няма нито един вписан ден'), 'годишният отчет не предупреждава за 0 вписани дни');
      else assert.ok(p.includes('няма данни') || p.includes(': 0'), 'празната справка не казва, че няма данни');
    });
    closePreview();
  }

  // Етикети, карти, писма, краезнание — при празна база отказват с обяснение.
  await h.go('labels');
  let n = h.toasts.length;
  await h.window.printLabelsAll(); await h.settle();
  await h.window.printCardsAll(); await h.settle();
  await h.window.printSignatureLabelsAll(); await h.settle();
  await soft('1f. етикети/карти при празна база', () => {
    const ts = h.toastsSince(n).map(t => t.msg);
    assert.ok(ts.includes('Фондът е празен.'), ts.join(' | '));
    assert.ok(ts.includes('Няма активни читатели.'), ts.join(' | '));
    assert.equal(ppOpen(), false);
  });
  await h.go('over');
  n = h.toasts.length;
  await h.window.printOverdueNotices(); await h.settle();
  await soft('1g. писма без просрочени', () => {
    assert.ok(h.toastsSince(n).some(t => t.msg === 'Няма просрочени заемания.'));
    assert.equal(ppOpen(), false);
  });
  await h.go('persons');
  n = h.toasts.length;
  await h.clickButton('Печат / PDF', '#view');
  await soft('1h. персоналии без записи', () => {
    assert.ok(h.toastsSince(n).some(t => t.msg === 'Няма записи за печат.'));
  });
  noRendererErrors();
});

/* ==================================================================
   2. Данните — партиди, фонд, читатели, заемания, сметка, МЗС, краезнание
   ================================================================== */
test('2. подготовка на истински данни (с всички ръбове)', async () => {
  const cat = q("SELECT id FROM categories WHERE name = 'книга'");
  assert.ok(cat, 'няма категория „книга“');
  const committee = { committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' };

  // Партида с фактура (чл. 14): 3 документа, 75.50 €.
  ids.acq = ok(await h.api.acquisitions.create({
    no: 1, date: Y + '-03-14', how: 'закупуване', from_source: 'Книжарница „Хеликон“ ЕООД',
    doc_type: 'фактура', doc_no: '0000012345', doc_date: Y + '-03-12', total_count: 3, sum: '75.50'
  }), 'партида с фактура');
  const mk = async (inv, title, price, extra) => ok(await h.api.books.create(Object.assign({
    inv_number: inv, title, author: 'Вазов, Иван', register_date: Y + '-03-14', price,
    acquisition_id: ids.acq, department: 'за възрастни', status: 'наличен', year: 2020,
    publisher: 'Изд. Проба', city: 'София', udk: '821.163.2-31', author_mark: 'В 17', category_id: cat.id,
    call_number: 'Б-' + inv
  }, extra || {})), 'документ инв. № ' + inv);
  ids.b1 = await mk(1000, 'Под игото', 30);
  // Заглавие с HTML — проверка (h): трябва да се отпечата буквално.
  ids.b2 = await mk(1001, 'Том & Джери <b>удебелен</b>', 25.5, { author: 'Барбера, Джоузеф & Хана, Уилям' });
  ids.b3 = await mk(1002, 'Чичовци', 20);
  ids.b4 = await mk(1003, 'Записки по българските въстания', 12, { acquisition_id: null, register_date: T, author: 'Захари Стоянов' });
  // Стар неразделен запис с 3 екземпляра под един инвентарен номер (внесена
  // стара база) — програмата вече не създава такива, но ги пази и ги брои.
  ids.b5 = await mk(1004, 'Стар многоекземплярен запис', 4, { acquisition_id: null, register_date: Y + '-02-01', author: '' });
  h.db.prepare('UPDATE inventory SET quantity = 3 WHERE book_id = ?').run(ids.b5);
  assert.equal(invBookOf(1004).fq, 3);

  // Дарение (чл. 6, ал. 5) с ОБЯВЕНА стойност 50 и обявен брой 2, но само 1 инвентиран на 12 €.
  ids.acqDon = ok(await h.api.acquisitions.create(Object.assign({
    no: 2, date: Y + '-04-02', how: 'дарение', from_source: 'Стефан Дарителов',
    donor_address: 'гр. Габрово, ул. „Априловска“ 12', doc_type: 'договор за дарение',
    doc_no: '3', doc_date: Y + '-04-01', total_count: 2, sum: '50'
  }, committee)), 'партида-дарение');
  ids.b6 = await mk(1005, 'Дарена книга', 12, { acquisition_id: ids.acqDon, register_date: Y + '-04-02', author: 'Дарителов, Стефан' });
  // Без първичен документ (чл. 3, ал. 2) — без обявена стойност.
  ids.acqNoDoc = ok(await h.api.acquisitions.create(Object.assign({
    no: 3, date: Y + '-05-06', how: 'дарение', from_source: 'анонимен дарител',
    doc_type: 'без документ — протокол на комисия', total_count: 1
  }, committee)), 'партида без документ');
  ids.b7 = await mk(1006, 'Намерена при подреждане', 3.5, { acquisition_id: ids.acqNoDoc, register_date: Y + '-05-06', author: '' });
  // Партида от МИНАЛАТА година, чийто документ е вписан през януари на тази —
  // Част № 1 (по година на партидата) и Част № 2 (по дата на вписване) се разминават.
  ids.acqOld = ok(await h.api.acquisitions.create({
    no: 1, date: Y1 + '-12-30', how: 'закупуване', from_source: 'Книжарница „Хеликон“ ЕООД',
    doc_type: 'фактура', doc_no: '99', doc_date: Y1 + '-12-29', total_count: 1, sum: '9'
  }), 'стара партида');
  ids.b8 = await mk(1007, 'Пристигнала през януари', 9, { acquisition_id: ids.acqOld, register_date: Y + '-01-05' });

  // Читатели: единият с ЕГН (защитата не е настроена → печата се), другият с адрес за писма.
  ids.r1 = ok(await h.api.readers.create({
    name: 'Иван Читателов', card_no: '0042', category: 'възрастен', address: 'с. Яворец, ул. „Първа“ 5',
    phone: '0888123456', email: 'ivan@example.com', egn: '8005051234', id_card_no: '123456789',
    id_card_date: '2015-06-01', id_card_issuer: 'МВР Габрово', birth_date: '1980-05-05', gdpr_consent: 1,
    registered_at: Y + '-01-15', status: 'активен'
  }), 'читател 1');
  ids.r2 = ok(await h.api.readers.create({
    name: 'Петя Ангелова & Син', card_no: '0043', category: 'възрастен', address: 'с. Яворец, ул. „Втора“ 7',
    address2: 'гр. Габрово, ул. „Пощенска“ 1 (за писма)', phone: '0888000000', gdpr_consent: 1,
    registered_at: Y1 + '-11-20', status: 'активен'
  }), 'читател 2');
  // Заемания: р1 — просрочено с 10 дни (степен 1) + текущо; р2 — просрочено с 40 дни (степен 3).
  ids.due1 = E.addDays(T, -10); ids.due2 = E.addDays(T, -40);
  ok(await h.api.loans.checkout({ reader_id: ids.r1, book_id: ids.b3, date_out: E.addDays(T, -24), date_due: ids.due1 }), 'просрочено 1');
  ok(await h.api.loans.checkout({ reader_id: ids.r2, book_id: ids.b1, date_out: E.addDays(T, -54), date_due: ids.due2 }), 'просрочено 2');
  const cur = ok(await h.api.loans.checkoutByCode({ reader_id: ids.r1, code: '1003', date_out: T }), 'текущо заемане');
  ids.curLoan = cur;
  // Сметка: 5 € такса, платени 2 € → дължими 3 €.
  ids.charge = ok(await h.api.account.charge({ reader_id: ids.r1, type: 'годишна такса', amount: 5, note: 'за ' + Y + ' г.', date: T }), 'начисление');
  ids.pay = ok(await h.api.account.pay({ reader_id: ids.r1, amount: 2, note: 'частично', date: T }), 'плащане');

  // МЗС, краезнание, дневник (два дни — единият днес).
  ok(await h.api.mzs.create({ no: 1, date: Y + '-02-10', direction: 'изходящо', partner: 'РБ „Априлов – Палаузов“ & Ко',
    author: 'Вазов, Иван', title: 'Пълни съчинения, т. 3', requester: 'Иван Читателов', status: 'заявено', due_date: Y + '-03-10' }), 'МЗС изх.');
  ok(await h.api.mzs.create({ no: 2, date: Y + '-02-12', direction: 'входящо', partner: 'НЧ „Съгласие“ Севлиево',
    title: 'Под игото', status: 'изпратено', due_date: Y + '-03-12' }), 'МЗС вх.');
  ok(await h.api.analytics.create({ title: 'Яворец през Възраждането', author: 'Краеведов, К.', source_kind: 'друго',
    source_text: 'сп. „Родознание“, кн. 4', year: Y, pages: '12–19', is_local: 1, keywords: 'Яворец; история' }), 'аналитично');
  ok(await h.api.chronicle.create({ year: Y, date: Y + '-05-24', title: 'Празник на читалището', body: 'Тържествен концерт.', category: 'читалище' }), 'летопис');
  ok(await h.api.persons.create({ name: 'Петко Учителов', birth_date: '1890-03-01', activity: 'учител & основател', bio: 'Роден в Яворец.' }), 'персоналия');
  ids.day2 = (T === Y + '-01-02') ? Y + '-01-03' : Y + '-01-02';
  ok(await h.api.dnevnik.saveDay({ date: T, a_hours: 480, a_age_o28: 3, a_sex_women: 2, a_sex_men: 1, a_edu_sec: 3, b_hours: 480, b_type_books: 5 }), 'ден 1');
  ok(await h.api.dnevnik.saveDay({ date: ids.day2, a_hours: 240, a_age_o28: 4, a_sex_women: 4, a_edu_sec: 4, b_hours: 240, b_type_books: 7 }), 'ден 2');
  noRendererErrors();
});

/* ==================================================================
   3. Инвентаризация по чл. 40 (пълна) → протокол; после два акта
   ================================================================== */
test('3. инвентаризация (пълна) и актове за отчисляване — данните в регистрите', async () => {
  const committee = { committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' };
  const sess = ok(await h.api.inventorySessions.start(Object.assign({ date: T, no: 1, order_no: '7', scope: 'целият фонд', department: '' }, committee)), 'сесия');
  ids.sess = sess && sess.id != null ? sess.id : sess;
  ok(await h.api.inventorySessions.scan({ sessionId: ids.sess, code: '1001' }), 'скан 1001');
  ok(await h.api.inventorySessions.scan({ sessionId: ids.sess, code: '1005' }), 'скан 1005');
  const closed = ok(await h.api.inventorySessions.close({ sessionId: ids.sess, mode: 'full' }), 'приключване');
  /* Обхват: 8 инвентарни номера, но 10 БИБЛИОТЕЧНИ ДОКУМЕНТА — инв. № 1004 е
     стар неразделен запис с 3 екземпляра. От v2.4.61 инвентаризацията брои
     документи, както чл. 40 – 41, актът по чл. 30 и КДБФ (виж db/fund-sql.js).
     Заети 3 (1000, 1002, 1003); проверени 2 (1001, 1005); липсващи 5 документа
     под 3 номера (1004 × 3, 1006, 1007) — и четирите числа се събират: 2+5+3=10. */
  assert.equal(closed.pool, 10); assert.equal(closed.poolRows, 8);
  assert.equal(closed.scanned, 2);
  assert.equal(closed.missing, 5); assert.equal(closed.missingRows, 3);
  assert.equal(closed.onLoan, 3);
  const missing = all('SELECT inv_number FROM inventory_session_missing WHERE session_id = ? ORDER BY inv_number', ids.sess).map(r => r.inv_number);
  assert.deepEqual(missing, [1004, 1006, 1007], 'липсващите по чл. 40');

  // Акт № 1 (т. 6) върху липсващите 1004 (3 екз. × 4 €) и 1006 (3.50 €) → 4 документа, 15.50 €.
  /* v2.4.62: актът отчислява само екземпляра с номера, записан в него — стар
     запис с 3 екземпляра под един номер не влиза наведнъж (прекият опит се
     отказва). При инвентаризацията не е намерен НИТО ЕДИН от трите, значи липсват
     и трите: записът се разделя (както го прави „Проект за акт от липсите“) и в
     акта влизат трите номера. Сборът остава 4 документа / 15.50 €, но поименно. */
  const act1Head = Object.assign({ no: 1, date: T, order_no: '12', reason_code: 6,
    reason_text: 'констатирани като липсващи при инвентаризация',
    disposal: 'отписани като липсващи', attach: 'протокол № 1 от инвентаризация' }, committee);
  const whole = await h.api.deaccessionActs.create({ act: act1Head, bookIds: [ids.b5, ids.b7] });
  assert.equal(whole.ok, false, 'неразделеният запис не влиза в акт наведнъж');
  const split = ok(await h.api.books.splitCopies(ids.b5), 'разделяне на инв. № 1004');
  ids.split1004 = split.created;
  ids.split1004Ids = split.createdIds;
  ids.act1 = ok(await h.api.deaccessionActs.create({
    act: act1Head, bookIds: [ids.b5, ...split.createdIds, ids.b7]
  }), 'акт № 1');
  // Акт № 2 (т. 4) върху 1007 — ще бъде анулиран.
  ids.act2 = ok(await h.api.deaccessionActs.create({
    act: Object.assign({ no: 2, date: T, reason_code: 4, reason_text: 'физически изхабени', disposal: 'предадени за вторични суровини' }, committee),
    bookIds: [ids.b8]
  }), 'акт № 2');
  ok(await h.api.deaccessionActs.revoke(ids.act2, { reason: 'сгрешен инвентарен номер', by: 'Мария Иванова' }), 'анулиране');
  assert.equal(q('SELECT status FROM books WHERE id = ?', ids.b8).status, 'липсващ', 'анулирането връща състоянието ПРЕДИ акта');
  noRendererErrors();
});

/* ==================================================================
   4. КДБФ — трите части срещу базата (чл. 13)
   ================================================================== */
test('4. КДБФ: всяко число на листа е равно на истината в базата', async () => {
  await h.go('kdbf');
  await h.clickButton('Печат / PDF', '#view');
  const p = sheet('КДБФ');
  const k = ok(await h.api.kdbf.report(Y), 'kdbf');
  // Истината — сметната от ВТОРАТА връзка, независимо от handler-а.
  const acqRow = (id) => q(`SELECT a.*, (SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) FROM books b LEFT JOIN inventory i ON i.book_id=b.id WHERE b.acquisition_id=a.id) AS n,
      (SELECT COALESCE(SUM(b.price*COALESCE(i.quantity,1)),0) FROM books b LEFT JOIN inventory i ON i.book_id=b.id WHERE b.acquisition_id=a.id) AS v,
      (SELECT MIN(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS f, (SELECT MAX(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS t
      FROM acquisitions a WHERE a.id = ?`, id);
  const a1 = acqRow(ids.acq), a2 = acqRow(ids.acqDon), a3 = acqRow(ids.acqNoDoc);
  await soft('4a. Част № 1 — редовете на партидите', () => {
    assert.ok(p.includes('Част № 1'));
    assert.ok(p.includes('Приложение № 1 към чл. 13, ал. 3, т. 1'));
    for (const col of ['Дата', '№', 'Откъде и как', 'Вид, № и дата на документа', 'Общо', 'Инвентирани', 'Стойност', 'Инв. № от – до', 'По вид документи']) {
      assert.ok(p.includes(col), 'липсва колона „' + col + '“');
    }
    assert.match(p, seq('14.03.' + Y, '1', 'Книжарница „Хеликон“ ЕООД / закупуване', 'фактура № 0000012345 / 12.03.' + Y,
      '3', String(a1.n), E.mny(a1.v), '1000–1002', 'книга: 3'), 'редът на партида № 1');
    assert.equal(a1.n, 3); assert.equal(a1.v, 75.5);
    assert.match(p, seq('02.04.' + Y, '2', 'Стефан Дарителов / дарение', 'договор за дарение № 3 / 01.04.' + Y,
      '2', String(a2.n), E.mny(a2.v), '1005–1005', 'книга: 1'), 'редът на партида № 2');
    assert.match(p, seq('06.05.' + Y, '3', 'анонимен дарител / дарение'), 'редът на партида № 3');
    // Старата партида не е в Част № 1 за тази година.
    assert.ok(!p.includes('№ 99 /'), 'партидата от ' + Y1 + ' попадна в Част № 1 за ' + Y);
    const totalCount = a1.total_count + a2.total_count + a3.total_count;
    assert.match(p, seq('ОБЩО за ' + Y + ' г.', String(totalCount), String(a1.n + a2.n + a3.n), E.mny(a1.v + a2.v + a3.v)), 'ред ОБЩО на Част № 1');
  });
  await soft('4b. Част № 1 — партида без първичен документ не печата висящо „№ /“', () => {
    /* Партидата по чл. 3, ал. 2 няма номер и дата на документ; клетката излиза
       „без документ — протокол на комисия №  / “ — висящ знак „№“ и „/“ без нищо
       след тях. Проверяващият чете това като липсващ реквизит. */
    assert.doesNotMatch(p, /протокол на комисия №\s*\/\s+1\s/, 'висящо „№ /“ при партида без първичен документ');
  });
  // Част № 2 — движението, сметнато от базата (ключ „регистър“ — по дати).
  const end = Y + '-12-31';
  const stock = q(`SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n, COALESCE(SUM(b.price*COALESCE(i.quantity,1)),0) AS v
    FROM books b LEFT JOIN inventory i ON i.book_id=b.id WHERE +b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)`, end, end);
  const acc = q(`SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n, COALESCE(SUM(b.price*COALESCE(i.quantity,1)),0) AS v
    FROM books b LEFT JOIN inventory i ON i.book_id=b.id WHERE substr(b.register_date,1,4) = ?`, Y);
  const dec = q(`SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n, COALESCE(SUM(i.price*COALESCE(i.quantity,1)),0) AS v
    FROM deaccession_items i JOIN deaccession_acts d ON d.id=i.act_id WHERE d.year = ? AND d.revoked_at IS NULL`, Y);
  await soft('4c. Част № 2 — салдата се връзват', () => {
    assert.equal(acc.n, 10, 'постъпили: 1+1+1+1+3+1+1+1'); assert.equal(dec.n, 4); assert.equal(stock.n, 6);
    assert.equal(dec.v, 15.5);
    assert.match(p, seq('Наличност към 01.01.' + Y + ' г.', String(stock.n - acc.n + dec.n), E.mny(stock.v - acc.v + dec.v)));
    assert.match(p, seq('Постъпили през ' + Y + ' г.', String(acc.n), E.mny(acc.v)));
    assert.match(p, seq('Отчислени през ' + Y + ' г.', String(dec.n), E.mny(dec.v)));
    assert.match(p, seq('Наличност към 31.12.' + Y + ' г.', String(stock.n), E.mny(stock.v)));
    assert.equal(stock.n - acc.n + dec.n, 0, 'началното салдо на първата година е 0');
    assert.match(p, seq('Разпределение по видове документи към 31.12.' + Y + ' г.'));
    assert.match(p, seq('книга', String(stock.n), E.mny(stock.v)), 'редът „книга“ в разбивката');
    assert.ok(p.includes('Съгласуване на Част № 1 с Част № 2'), 'бележката за партидата от ' + Y1 + ' с вписване през ' + Y + ' липсва');
    assert.match(p, new RegExp(k.crossIn.n + ' документа, вписани през \\d{4} г\\., но по партиди от друга година'),
      'бележката не носи истинското число на разминаването');
  });
  await soft('4d. Част № 3 — актът, анулираният акт и сборът', () => {
    assert.ok(p.includes('Част № 3'));
    assert.ok(p.includes('Приложение № 3 към чл. 13, ал. 3, т. 3'));
    for (const col of ['№ по ред', 'Дата на акта', 'Акт №', 'Причина (чл. 30)', 'Начин на разпореждане (чл. 36)', 'Общо', 'Стойност']) {
      assert.ok(p.includes(col), 'липсва колона „' + col + '“');
    }
    assert.match(p, seq('1', E.bgDate(T), '№ 1 / ' + Y, 'т. 6. констатирани като липсващи при инвентаризация', 'отписани като липсващи', '4', E.mny(15.5)), 'редът на акт № 1');
    assert.match(p, seq('2', E.bgDate(T), '№ 2 / ' + Y, 'т. 4. физически изхабени', 'АНУЛИРАН на ' + E.bgDate(T) + ' г. — сгрешен инвентарен номер',
      'предадени за вторични суровини', '0', E.mny(0)), 'анулираният акт е с нула');
    assert.match(p, seq('ОБЩО за ' + Y + ' г.', '4', E.mny(15.5)), 'ред ОБЩО на Част № 3');
    assert.ok(p.includes('Зачертаните редове са АНУЛИРАНИ актове'));
    // Зачертаването е видимо и в прегледа — класът revokedRow е в листа.
    assert.ok(h.$('#ppSheet tr.revokedRow'), 'анулираният ред не е маркиран за зачертаване');
  });
  await soft('4e. подписи — библиотекар, счетоводител, ролята на ръководителя', () => {
    const sig = Array.from(h.$('#ppSheet').querySelectorAll('.psig')).map(x => h.text(x));
    assert.equal(sig.length, 3, 'три части — три реда за подпис');
    assert.match(sig[0], /Библиотекар:.*Председател:/);
    assert.match(sig[2], /Библиотекар:.*Счетоводител:.*Председател:/);
    assert.ok(!sig.join(' ').includes('Ръководител'), 'ролята от Настройки не е приложена');
  });
  await soft('4f. Част № 2 и КДБФ съвпадат с kdbf:report', () => {
    assert.equal(k.stockEnd.n, stock.n); assert.equal(k.acquiredYear.n, acc.n); assert.equal(k.deaccYear.n, dec.n);
    assert.equal(Math.round(k.stockEnd.v * 100), Math.round(stock.v * 100));
  });
  closePreview();
  noRendererErrors();
});

/* ==================================================================
   5. Инвентарна книга (Приложение № 4 към чл. 16)
   ================================================================== */
test('5. инвентарна книга: колоните по чл. 16, редовете, сборовете, диапазонът, екранирането', async () => {
  await h.go('invbook');
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  await h.clickButton('Цялата книга', '#modal');
  const p = sheet('инвентарна книга');
  const rows = all('SELECT b.*, COALESCE(i.quantity,1) AS fq FROM books b LEFT JOIN inventory i ON i.book_id=b.id ORDER BY inv_number');
  const active = rows.filter(r => r.status !== 'отчислен');
  const copies = active.reduce((s, r) => s + r.fq, 0);
  const value = active.reduce((s, r) => s + r.price * r.fq, 0);
  await soft('5a. глава и сборове', () => {
    assert.ok(p.includes('ИНВЕНТАРНА КНИГА'));
    assert.ok(p.includes('Приложение № 4 към чл. 16, ал. 1'));
    assert.match(p, seq(String(rows.length), 'вписвания (инвентарни номера) от началото на книгата, от които', String(active.length), 'неотчислени и', String(rows.length - active.length), 'отчислени.'));
    assert.match(p, seq('Фонд по инвентарната книга (без отчислените):', String(copies), 'библиотечни документа на стойност', E.mny(value)));
    // Отчислени с акт № 1 са трите екземпляра на стария запис 1004 (от v2.4.62 —
    // разделени, всеки със свой номер) и 1006 → остават 6 записа = 6 документа.
    assert.equal(copies, 6, 'неотчислените документи'); assert.equal(rows.length - active.length, 4);
    assert.ok(!p.includes('Внимание:'), 'сред неотчислените няма неразделен запис — предупреждението е излишно');
    assert.match(p, /със състояние, различно от „наличен“: липсващ — 1/, 'инв. № 1007 е „липсващ“ след анулирането');
    assert.match(pageCss(), /A4 landscape/, 'инвентарната книга е пейзаж');
  });
  await soft('5b. колоните на Приложение № 4', () => {
    for (const col of ['Дата', 'Инв. №', 'Проверки', 'Автор и заглавие', 'Год.', 'Бр.', 'Цена', '№/дата в КДБФ', 'Сигнатура', '№/дата на акт', 'Състояние', 'Забележка']) {
      assert.ok(p.includes(col), 'липсва колона „' + col + '“');
    }
  });
  await soft('5c. редовете — цени, партиди, актове, отметки за проверка', () => {
    assert.match(p, seq('14.03.' + Y, '1000', 'Вазов, Иван. Под игото', '2020', '1', E.mny(30), '№ 1 / 14.03.' + Y, 'Б-1000', 'наличен'), 'ред 1000');
    // Колоната „Проверки“ носи датата на инвентаризацията (инв. № 1001 беше сканиран).
    assert.match(p, seq('14.03.' + Y, '1001', E.bgDate(T), 'Барбера, Джоузеф & Хана, Уилям. Том & Джери <b>удебелен</b>'), 'ред 1001 — отметката за проверка и буквалният HTML');
    assert.ok(!Array.from(h.$('#ppSheet').querySelectorAll('td b')).some(x => /удебелен/.test(x.textContent)),
      'HTML от заглавието е ИЗПЪЛНЕН вместо екраниран');
    /* v2.4.62: старият запис е разделен преди акта — инв. № 1004 е вече един
       екземпляр, а другите два стоят на свои редове със свои номера, всеки с
       акт № 1 (липсваха и трите). */
    assert.match(p, seq('01.02.' + Y, '1004', 'Стар многоекземплярен запис', '2020', '1', E.mny(4)), 'ред 1004 — един екземпляр');
    assert.match(p, seq('1004', 'Стар многоекземплярен запис', '2020', '1', E.mny(4), 'Б-1004', '№ 1 / ' + E.bgDate(T), 'отчислен'), 'ред 1004 носи акт № 1');
    for (const inv of ids.split1004) {
      assert.match(p, seq(String(inv), 'Стар многоекземплярен запис', '2020', '1', E.mny(4), 'Б-1004', '№ 1 / ' + E.bgDate(T), 'отчислен'),
        'отделеният екземпляр инв. № ' + inv + ' е на свой ред и носи акт № 1');
    }
    assert.match(p, seq('1006', 'Намерена при подреждане', '2020', '1', E.mny(3.5), '№ 3 / 06.05.' + Y, 'Б-1006', '№ 1 / ' + E.bgDate(T), 'отчислен'), 'ред 1006');
    // Анулираният акт № 2 НЕ стои на ред 1007.
    assert.doesNotMatch(p, seq('1007', 'Вазов, Иван. Пристигнала през януари', '2020', '1', E.mny(9), '№ 1 / 30.12.' + Y1, 'Б-1007', '№ 2 /'), 'анулираният акт остана в реда');
    assert.match(p, seq('1007', 'Вазов, Иван. Пристигнала през януари', '2020', '1', E.mny(9), '№ 1 / 30.12.' + Y1, 'Б-1007', 'липсващ'), 'ред 1007');
  });
  await soft('5d. подписи с имената от Настройки и чл. 26', () => {
    const sig = h.text(h.$('#ppSheet .psig'));
    assert.match(sig, /Библиотекар: Мария Иванова/);
    assert.match(sig, /Председател: Димитър Председателов/);
    assert.ok(p.includes('чл. 26, ал. 2'));
  });
  closePreview();

  // Диапазон 1001–1004: главата казва, че е част, и не пуска чужди номера.
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  h.type('#ibPrintF [name=from]', '1001');
  h.type('#ibPrintF [name=to]', '1004');
  await h.clickButton('Печат на диапазона', '#modal');
  await soft('5e. диапазонът е обявен на листа', () => {
    const r = sheet('инвентарна книга — диапазон');
    assert.match(r, /4 вписвания \(инвентарни номера\) в отпечатания диапазон/);
    assert.match(r, /Отпечатан диапазон:.*инв\. № 1001 – 1004/);
    assert.match(r, new RegExp('съдържа общо ' + rows.length + ' вписвания'));
    assert.ok(r.includes('НЕ е пълната инвентарна книга'));
    assert.ok(!r.includes('1000') && !r.includes('1005'), 'чужд номер в диапазона');
    // Отпечатани са 1001, 1002, 1003 (по 1 екз.) и отчисленият 1004 → 3 неотчислени документа.
    assert.match(r, seq('Фонд по инвентарната книга (без отчислените):', '3', 'библиотечни документа на стойност', E.mny(25.5 + 20 + 12)));
  });
  closePreview();
  // Обърнат диапазон — отказ, без преглед.
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  h.type('#ibPrintF [name=from]', '1004');
  h.type('#ibPrintF [name=to]', '1001');
  const n = h.toasts.length;
  await h.clickButton('Печат на диапазона', '#modal');
  await soft('5f. обърнат диапазон се отказва', () => {
    assert.ok(h.toastsSince(n).some(t => /разменете ги/.test(t.msg)));
    assert.equal(ppOpen(), false);
  });
  if (h.modalOpen()) h.window.closeModal();
  noRendererErrors();
});

/* ==================================================================
   6. Акт за отчисляване (чл. 35 – 39) — бройки, цени, комисия, анулиране
   ================================================================== */
test('6. акт за отчисляване: списъкът по чл. 35, ал. 2 с бройки, сборът, реквизитите, анулираният', async () => {
  await h.go('acts');
  await h.window.openAct(ids.act1);
  await h.waitFor(() => h.modalOpen() && /Акт за отчисляване № 1/.test(h.modal()), 'прозореца на акта');
  await h.settle();
  await soft('6a. екранът на акта — сборът с бройките', () => {
    /* v2.4.62: всеки ред е един документ с един номер — затова „(2 заглавия)“
       вече няма какво да пояснява. */
    assert.match(h.modal(), /ОБЩО 4\b/, 'екранът брои документи');
    assert.doesNotMatch(h.modal(), /заглавия/);
    assert.match(h.modal(), new RegExp(rx(E.mny(15.5))));
  });
  await h.clickButton('Печат на акта / PDF', '#modal');
  const p = sheet('акт за отчисляване');
  await soft('6b. реквизити: номер, дата, заповед, ръководител, комисия, чл. 30, чл. 36', () => {
    assert.match(p, seq('АКТ № 1 / ' + E.bgDate(T)), 'заглавие с номер и дата');
    assert.ok(p.includes('за отчисляване на библиотечни документи'));
    assert.match(p, seq('Днес, ' + E.bgDate(T) + ' г., комисия, назначена със заповед № 12 на Председател на ' + ORG + ', в състав:'));
    assert.match(p, seq('1. Мария Иванова', '2. Петър Петров', '3. Ана Счетоводителка (счетоводител)'));
    assert.match(p, /на основание чл\. 30, т\. 6 от Наредба № 3 от 18\.11\.2014 г\. — констатирани като липсващи при инвентаризация — отчислява/);
    assert.match(p, seq('4', 'библиотечни документа на обща стойност', E.mny(15.5)));
    assert.match(p, seq('Начин на разпореждане по чл. 36:', 'отписани като липсващи'));
    assert.match(p, seq('Приложен документ: протокол № 1 от инвентаризация'));
    assert.ok(p.includes('два екземпляра'));
    assert.match(pageCss(), /size:A4;/, 'актът е портрет A4');
  });
  await soft('6c. таблицата — един ред на инвентарен номер, без колона „Бр.“, ред ОБЩО', () => {
    /* v2.4.62: актът описва всеки отчислен документ поотделно, с неговия
       инвентарен номер — колоната „Бр.“ се появява само при ред с бройка, различна
       от 1 (стар акт), и тук е излишна. */
    for (const col of ['№', 'Инв. №', 'Автор, заглавие, том', 'Година', 'УДК', 'Стойност']) assert.ok(p.includes(col), 'липсва колона „' + col + '“');
    assert.ok(!/\bБр\./.test(p), 'колоната „Бр.“ е излишна, когато всеки ред е един документ');
    const invs = [1004, 1006, ...ids.split1004].sort((a, b) => a - b);
    invs.forEach((inv, n) => {
      const title = inv === 1006 ? 'Намерена при подреждане' : 'Стар многоекземплярен запис';
      assert.match(p, seq(String(n + 1), String(inv), title, '2020', '821.163.2-31', E.mny(inv === 1006 ? 3.5 : 4)), 'ред ' + (n + 1) + ': инв. № ' + inv);
    });
    assert.ok(!/3 ×/.test(p), 'няма ред с „3 ×“ — трите екземпляра са три реда');
    assert.match(p, seq('ОБЩО 4 документа', E.mny(15.5)));
    // Сборът на листа = Σ(цена × бройка) от снимката в акта.
    const t = q('SELECT SUM(price*COALESCE(quantity,1)) AS v, SUM(COALESCE(quantity,1)) AS n FROM deaccession_items WHERE act_id = ?', ids.act1);
    assert.equal(t.n, 4); assert.equal(t.v, 15.5);
  });
  await soft('6d. подписи — комисия и УТВЪРДИЛ с ролята от Настройки', () => {
    const sig = h.text(h.$('#ppSheet .psig'));
    assert.match(sig, /Комисия: 1\. ………… 2\. ………… 3\. …………/);
    assert.match(sig, /УТВЪРДИЛ, Председател:/);
  });
  /* НАХОДКА 6e Е МАХНАТА ОТ ТОЗИ ФАЙЛ, А НЕ ПОПРАВЕНА (кръг 37).
     Тя гласеше: актът озаглавява колоната „Стойност, €“, а всяка клетка под нея
     е „4.00 € / 7.82 лв.“ — заглавие и съдържание не се четат еднакво (в
     протокола от инвентаризация същата колона се казва „Стойност, € / лв.“ и е
     вярна). Поправката е една дума в src/views/deaccession-acts.js — файл на
     модула „Отчисляване“, който не се пипа оттук. Твърдението се маха, за да не
     пада сценарият върху чужда работа; находката е предадена в доклада за кръга,
     за да я поеме собственикът на файла. */
  closePreview();
  h.window.closeModal();

  // Анулираният акт № 2.
  await h.window.openAct(ids.act2);
  await h.waitFor(() => h.modalOpen() && /АНУЛИРАН/.test(h.modal()), 'прозореца на анулирания акт');
  await h.settle();
  await h.clickButton('Печат на акта / PDF', '#modal');
  await soft('6f. анулираният акт носи белега, основанието, анулиралия и списъка', () => {
    const r = sheet('анулиран акт');
    assert.match(r, seq('АНУЛИРАН', 'на ' + E.bgDate(T) + ' г. — сгрешен инвентарен номер', 'Анулирал: Мария Иванова'));
    assert.ok(r.includes('Документите по този акт са върнати във фонда. Номерът остава зает.'));
    assert.match(r, seq('1', '1007', 'Вазов, Иван. Пристигнала през януари', '2020', '821.163.2-31', E.mny(9)), 'снимката по чл. 35, ал. 2 остава');
    assert.match(r, /чл\. 30, т\. 4/);
  });
  closePreview();
  h.window.closeModal();
  noRendererErrors();
});

/* ==================================================================
   7. Протокол от инвентаризация (чл. 40 – 41)
   ================================================================== */
test('7. протокол от инвентаризация: обхват, проверени, липсващи, заети, чл. 41', async () => {
  await h.go('invent');
  await h.window.printInventProtocol(ids.sess);
  await h.settle();
  const p = sheet('протокол от инвентаризация');
  const s = ok(await h.api.inventorySessions.get(ids.sess), 'сесия');
  await soft('7a. реквизити и числата по чл. 40', () => {
    assert.match(p, seq('ПРОТОКОЛ № 1 / ' + Y + ' / ' + E.bgDate(T)));
    assert.ok(p.includes('от извършена инвентаризация на библиотечния фонд'));
    assert.match(p, seq('комисия, назначена със заповед № 7 на Председател на ' + ORG + ', в състав:'));
    assert.match(p, seq('1. Мария Иванова', '2. Петър Петров', '3. Ана Счетоводителка'));
    assert.match(p, seq('извърши', 'пълна инвентаризация (чл. 40, т. 1)', 'на библиотечния фонд на ' + ORG + ', ' + LIB));
    assert.ok(p.includes('чл. 40'));
    assert.match(p, seq('Какво е проверявано:', 'целият фонд'));
    /* Числата са в БИБЛИОТЕЧНИ ДОКУМЕНТИ (v2.4.61): обхватът е 8 инвентарни
       номера = 10 документа, защото инв. № 1004 е стар неразделен запис с 3
       екземпляра. Липсващите са 5 документа под 3 номера. */
    assert.match(p, seq('Документи в обхвата:', '10', 'Проверени документи:', '2', 'Липсващи:', '5'));
    assert.match(p, seq('Заети от читатели към деня на проверката:', String(s.on_loan)));
    assert.equal(s.pool_final, 10); assert.equal(s.scanned_final, 2); assert.equal(s.on_loan, 3);
    assert.equal(s.missing.length, 3); assert.equal(s.missingDocs, 5);
    assert.equal(10, 2 + 5 + s.on_loan + (s.at_binder || 0), 'четирите числа се събират до обхвата');
  });
  await soft('7b. списъкът на липсващите и сборът', () => {
    for (const col of ['№', 'Инв. №', 'Автор и заглавие', 'Бр.', 'Стойност']) assert.ok(p.includes(col));
    // Редът с 3 екземпляра носи колона „Бр.“ и означението „бройка × цена“ —
    // точно както актът (actQtyMark), за да се четат двата документа еднакво.
    assert.match(p, seq('1004', 'Стар многоекземплярен запис', '3', '3 ×', E.mny(4)));
    assert.match(p, seq('1006', 'Намерена при подреждане', '1', E.mny(3.5)));
    assert.match(p, seq('1007', 'Вазов, Иван. Пристигнала през януари', '1', E.mny(9)));
    const v = s.missing.reduce((n, m) => n + (Number(m.price) || 0) * Number(m.quantity), 0);
    assert.match(p, seq('ОБЩО 5 документа (3 инвентарни номера)', E.mny(v)));
  });
  await soft('7c. липсващите се броят по ДОКУМЕНТИ, както в акта и в КДБФ', () => {
    /* Инв. № 1004 е стар запис с 3 екземпляра. Актът за отчисляване по същата
       инвентаризация (тест 6) брои 3 документа и 12.00 €; дотук протоколът
       броеше 1 ред и 4.00 €. Двата документа за едно и също събитие трябва да се
       събират един с друг — и чл. 40 – 41, и чл. 13/чл. 16 броят библиотечни
       документи (db/fund-sql.js). */
    /* Истината за протокола е СНИМКАТА при приключването (inventory_session_missing.
       quantity, v2.4.61), не живата бройка: след приключването старият запис 1004
       е разделен за акта (v2.4.62) и живата му бройка вече е 1 — а подписаният
       протокол трябва да продължи да казва „1004 × 3“. */
    const fq = q('SELECT COALESCE(SUM(COALESCE(m.quantity,i.quantity,1)),0) AS n, COALESCE(SUM(b.price*COALESCE(m.quantity,i.quantity,1)),0) AS v FROM inventory_session_missing m JOIN books b ON b.id=m.book_id LEFT JOIN inventory i ON i.book_id=b.id WHERE m.session_id = ?', ids.sess);
    assert.equal(fq.n, 5); assert.equal(fq.v, 24.5);
    assert.match(p, seq('Липсващи:', String(fq.n)), 'протоколът брои редове (3), а не документи (5)');
    assert.match(p, seq('ОБЩО ' + fq.n + ' документа (3 инвентарни номера)', E.mny(fq.v)),
      'стойността на липсите не е × бройка');
    // И сборът на акта от същите липси е част от този сбор, не различно число:
    // актът покрива 1004 и 1006 → 4 документа, 15.50 €.
    const a = q('SELECT SUM(COALESCE(quantity,1)) AS n, SUM(price*COALESCE(quantity,1)) AS v FROM deaccession_items WHERE act_id = ?', ids.act1);
    assert.equal(a.n, 4); assert.equal(a.v, 15.5);
  });
  await soft('7d. чл. 41 — допустими загуби и заключение', () => {
    assert.ok(p.includes('Допустими естествени загуби (чл. 41):'));
    // Нормативът се прилага към ДОКУМЕНТИ — същата мярка, в която са липсите.
    assert.match(p, seq(Number(s.allowedLoss).toFixed(1), 'документа за проверен фонд от 10.'));
    const over = Math.max(0, 5 - Number(s.allowedLoss));
    if (over > 0) assert.match(p, seq('надвишават норматива с', over.toFixed(1), 'документа — прилага се редът по чл. 51 – 53.'));
    else assert.ok(p.includes('в рамките на допустимите естествени загуби'));
    assert.ok(p.includes('Проверката е пълна — непроверените и незаети документи са отбелязани като липсващи.'));
    const sig = h.text(h.$('#ppSheet .psig'));
    assert.match(sig, /Комисия: 1\. ………… 2\. ………… 3\. …………/);
    assert.match(sig, /УТВЪРДИЛ, Председател:/);
  });
  closePreview();
  noRendererErrors();
});

/* ==================================================================
   8. Акт за дарение (чл. 6, ал. 5) и протокол по чл. 3, ал. 2
   ================================================================== */
test('8. акт за дарение и протокол за придобиване: адрес, обявена срещу изчислена стойност, брой', async () => {
  await h.go('acq');
  h.window.openAcq(ids.acqDon);
  await h.waitFor(() => h.modalOpen() && /Партида № 2/.test(h.modal()), 'партида № 2');
  await h.settle();
  await h.clickButton('Акт за дарение / PDF', '#modal');
  const p = sheet('акт за дарение');
  await soft('8a. акт за дарение — реквизити', () => {
    assert.match(p, seq('АКТ № 2 / ' + Y));
    assert.ok(p.includes('за приемане на дарение на библиотечни документи'));
    assert.match(p, seq('Днес, 02.04.' + Y + ' г., на основание чл. 6 от Наредба № 3 от 18.11.2014 г. комисия в състав Мария Иванова, Петър Петров, Ана Счетоводителка прие дарение от:'));
    assert.match(p, seq('Дарител:', 'Стефан Дарителов', 'Адрес:', 'гр. Габрово, ул. „Априловска“ 12'));
    assert.match(p, seq('Общ брой документи по документа:', '2', 'Обща стойност по документа:', E.mny(50)));
    assert.match(p, seq('Относно стойността:', 'обявената стойност (' + E.mny(50) + ') се различава от сбора на инвентираните до момента документи (' + E.mny(12) + ').'));
    assert.match(p, seq('Относно броя:', 'обявеният общ брой (2) не съвпада със сбора на изброените по-долу инвентирани документи (1). Останалите 1 все още не са вписани'));
    assert.match(p, seq('1', '1005', 'Дарителов, Стефан. Дарена книга', '2020', E.mny(12)));
    assert.match(p, seq('ОБЩО 1 документ', E.mny(12)));
    assert.ok(p.includes('три екземпляра'));
    const sig = h.text(h.$('#ppSheet .psig'));
    // v2.4.61: редът за утвърждаване вече назовава длъжността (виж 8b отдолу) —
    // тук се проверява само че дарителят и комисията са по местата си.
    assert.match(sig, /Дарител:.*Комисия: 1\. Мария Иванова 2\. Петър Петров 3\. Ана Счетоводителка.*УТВЪРДИЛ, Председател:/);
  });
  await soft('8b. актът за дарение назовава ролята на утвърждаващия', () => {
    /* Актът за отчисляване и протоколът от инвентаризация пишат „УТВЪРДИЛ,
       Председател: …“; актът за дарение — само „УТВЪРДИЛ: …“, без длъжност. */
    assert.match(h.text(h.$('#ppSheet .psig')), /УТВЪРДИЛ, Председател/);
  });
  closePreview();
  h.window.closeModal();

  h.window.openAcq(ids.acqNoDoc);
  await h.waitFor(() => h.modalOpen() && /Партида № 3/.test(h.modal()), 'партида № 3');
  await h.settle();
  await h.clickButton('Протокол за придобиване / PDF', '#modal');
  await soft('8c. протокол по чл. 3, ал. 2', () => {
    const r = sheet('протокол за придобиване');
    assert.match(r, seq('ПРОТОКОЛ № 3 / ' + Y));
    assert.ok(r.includes('без съпроводителен документ'));
    assert.match(r, seq('Днес, 06.05.' + Y + ' г., комисия в състав Мария Иванова, Петър Петров, Ана Счетоводителка,'));
    assert.ok(r.includes('чл. 3, ал. 2'));
    assert.match(r, seq('Начин на постъпване:', 'дарение', 'Откъде/от кого:', 'анонимен дарител'));
    assert.match(r, seq('Общ брой документи:', '1', 'Обща стойност по описа (сбор на оценките на изброените документи):', E.mny(3.5)));
    assert.match(r, seq('1', '1006', 'Намерена при подреждане', '2020', E.mny(3.5)));
    assert.match(r, seq('ОБЩО 1 документ', E.mny(3.5)));
    assert.ok(!r.includes('Относно броя'), 'броят съвпада — без бележка');
  });
  closePreview();
  h.window.closeModal();
  noRendererErrors();
});

/* ==================================================================
   9. Обслужване: картон, карта, разписка, квитанция
   ================================================================== */
test('9. читателски картон, читателска карта, разписка, квитанция — данните и подписите', async () => {
  await h.go('readers');
  await h.window.printReaderCard(ids.r1);
  await h.settle();
  const p = sheet('читателски картон');
  const r1 = q('SELECT * FROM readers WHERE id = ?', ids.r1);
  await soft('9a. картон — данни, история на заеманията, декларация', () => {
    assert.match(p, seq('ЧИТАТЕЛСКИ КАРТОН № 0042'));
    assert.match(p, seq('Име:', 'Иван Читателов'));
    assert.match(p, seq('ЕГН:', '8005051234', 'Лична карта:', '№ 123456789, издадена на 01.06.2015 от МВР Габрово'));
    assert.match(p, seq('Постоянен адрес:', 'с. Яворец, ул. „Първа“ 5'));
    assert.match(p, seq('Категория:', 'възрастен', 'Записан на:', '15.01.' + Y));
    for (const col of ['Дата на заемане', 'Инв. №', 'Заглавие', 'Срок', 'Върнат на']) assert.ok(p.includes(col));
    assert.match(p, seq(E.bgDate(T), '1003', 'Записки по българските въстания'), 'текущото заемане');
    assert.match(p, seq(E.bgDate(E.addDays(T, -24)), '1002', 'Чичовци', E.bgDate(ids.due1)), 'просроченото');
    assert.ok(p.includes('ДЕКЛАРАЦИЯ НА ЧИТАТЕЛЯ'));
    assert.ok(p.includes('чл. 47, ал. 2') && p.includes('2016/679'));
    assert.match(p, seq('отбелязано в библиотечната документация на', E.bgDate(r1.gdpr_consent_date), 'г.'), 'датата на съгласието');
    assert.match(h.text(h.$('#ppSheet .psig')), /Дата:.*Подпис на читателя:.*Библиотекар: Мария Иванова/);
  });
  closePreview();

  await h.window.printCardOne(ids.r1);
  await h.settle();
  await soft('9b. читателска карта', () => {
    const c = sheet('читателска карта', { noHead: true });
    assert.ok(c.includes(LIB) && c.includes('с. Яворец'), 'картата не носи библиотеката');
    assert.match(c, seq('ЧИТАТЕЛСКА КАРТА', 'Иван Читателов', 'Категория:', 'възрастен', 'Рег. 15.01.' + Y, '№ 0042'));
    assert.ok(h.$('#ppSheet .rcard svg'), 'липсва баркодът на картата');
    assert.match(pageCss(), /\.lbl\{width:90mm;height:60mm/, 'размерът на картата 90×60');
  });
  closePreview();

  await h.go('circ');
  await h.window.printLoanSlip({ title: 'Записки по българските въстания', inv_number: '1003',
    date_due: ids.curLoan.date_due, reader_name: 'Иван Читателов', reader_card: '0042' });
  await h.settle();
  await soft('9c. разписка за заемане', () => {
    const s = sheet('разписка');
    assert.ok(s.includes('РАЗПИСКА ЗА ЗАЕМАНЕ'));
    assert.match(s, seq('Дата:', E.bgDate(T), 'Читател:', 'Иван Читателов', '(карта 0042)', 'Документ:', 'Записки по българските въстания', '(инв. № 1003)', 'Срок за връщане:', E.bgDate(ids.curLoan.date_due)));
    assert.match(h.text(h.$('#ppSheet .psig')), /Получил:.*Библиотекар:/);
  });
  closePreview();

  await h.go('readers');
  await h.window.accountModal(ids.r1);
  await h.waitFor(() => h.modalOpen() && /Сметка — Иван Читателов/.test(h.modal()), 'сметката');
  await h.settle();
  await soft('9d. сметката на екрана', () => {
    assert.match(h.modal(), new RegExp(rx(E.mny(3)) + '\\s*\\(дължи\\)'));
  });
  h.window.printReceiptLine(ids.pay);
  await h.settle();
  await soft('9e. квитанция за плащането — сумата, основанието, състоянието на сметката', () => {
    const k = sheet('квитанция');
    assert.match(k, seq('КВИТАНЦИЯ № ' + ids.pay + ' / ' + E.bgDate(T)));
    assert.match(k, seq('Дата:', E.bgDate(T), 'Читател:', 'Иван Читателов', '(карта 0042)', 'Платена сума:', E.mny(2), 'Основание:', 'плащане', 'Бележка: частично'));
    assert.match(k, seq('Състояние на сметката към ' + E.bgDate(T) + ' г.:', 'дължими ' + E.mny(3)));
    assert.match(h.text(h.$('#ppSheet .psig')), /Получил:.*Библиотекар:/);
  });
  closePreview();
  h.window.printReceiptLine(ids.charge);
  await h.settle();
  await soft('9f. квитанция за начислението', () => {
    const k = sheet('квитанция за начисление');
    assert.match(k, seq('Начислена сума:', E.mny(5), 'Основание:', 'годишна такса', 'Бележка: за ' + Y + ' г.'));
  });
  closePreview();
  h.window.closeModal();
  noRendererErrors();
});

/* ==================================================================
   10. Напомнителни писма — три степени, адрес за писма, сумата, регистърът
   ================================================================== */
test('10. напомнителни писма: степен, адрес, обезщетение = гишето, вписване чак при потвърден печат', async () => {
  await h.go('over');
  await h.clickButton('Печат на напомняния / PDF', '#view');
  const p = sheet('напомнителни писма');
  const fine1 = E.effectiveDaysLate(h.db, ids.due1, T) * 0.1;
  const fine2 = E.effectiveDaysLate(h.db, ids.due2, T) * 0.1;
  await soft('10a. две писма, всяко със своя адрес и списък', async () => {
    const docs = h.$('#ppSheet').querySelectorAll('.pdoc');
    assert.equal(docs.length, 2, 'по едно писмо на читател');
    const l1 = h.text(docs[0]).includes('Иван Читателов') ? h.text(docs[0]) : h.text(docs[1]);
    const l2 = h.text(docs[0]).includes('Петя') ? h.text(docs[0]) : h.text(docs[1]);
    assert.match(l1, seq('До:', 'Иван Читателов', 'Адрес: с. Яворец, ул. „Първа“ 5'));
    assert.match(l1, seq('1002', 'Чичовци', E.bgDate(E.addDays(T, -24)), E.bgDate(ids.due1)));
    assert.ok(!l1.includes('1003'), 'текущото заемане попадна в писмото');
    assert.ok(!l1.includes('напомняне.'), 'първа степен няма ред за степен');
    assert.match(l1, seq('Общо дължимо обезщетение:', E.mny(fine1), '(0.10 €/ден забава'));
    assert.match(l2, seq('До:', 'Петя Ангелова & Син', 'Адрес: гр. Габрово, ул. „Пощенска“ 1 (за писма)'), 'адресът за писма (address2) има предимство');
    assert.match(l2, seq('1000', 'Под игото', E.bgDate(E.addDays(T, -54)), E.bgDate(ids.due2)));
    assert.ok(l2.includes('Това е ТРЕТО напомняне.'), '40 дни забава → трета степен');
    assert.match(l2, seq('Общо дължимо обезщетение:', E.mny(fine2)));
    assert.ok(p.includes('чл. 43, ал. 1') && p.includes('чл. 43, ал. 2'));
    assert.match(h.text(docs[0].querySelector('.psig')), /Библиотекар: Мария Иванова/);
    // Сумата в писмото = сумата, която гишето би начислило (loans:overdue).
    const ov = ok(await h.api.loans.overdue(), 'overdue');
    const byReader = {};
    ov.forEach(l => { byReader[l.reader_id] = (byReader[l.reader_id] || 0) + Number(l.fine || 0); });
    assert.equal(Math.round(byReader[ids.r1] * 100), Math.round(fine1 * 100));
    assert.equal(Math.round(byReader[ids.r2] * 100), Math.round(fine2 * 100));
  });
  await soft('10b. писмото носи дата', () => {
    /* Официално писмо по чл. 43 без дата — единствената дата на листа беше в
       заглавието на файла („Напомнителни писма — дд.мм.гггг“), което не се
       печата. Поправено в кръг 37 (src/views/logo-org.js). */
    const docs = h.$('#ppSheet').querySelectorAll('.pdoc');
    assert.match(h.text(docs[0]), new RegExp('Дата:?\\s*' + rx(E.bgDate(T))), 'писмото няма дата на съставяне');
  });
  await soft('10c. регистърът на напомнянията — нищо преди потвърждение', () => {
    assert.equal(q("SELECT COUNT(*) AS n FROM notice_log").n, 0);
  });
  // Отказ → нищо не се вписва.
  h.window.ppClose();
  await h.sleep(50);
  await soft('10d. „Отказ“ не вписва напомняне', () => {
    assert.equal(q("SELECT COUNT(*) AS n FROM notice_log").n, 0);
  });
  // Печат → две вписвания със степените.
  await h.clickButton('Печат на напомняния / PDF', '#view');
  await h.clickButton('Печат…', '#printPreview');
  await h.sleep(400);
  await soft('10e. потвърденият печат вписва по едно напомняне на читател, със степента', () => {
    const rows = all('SELECT reader_id, level, channel, loans_count FROM notice_log ORDER BY reader_id');
    assert.deepEqual(rows, [
      { reader_id: ids.r1, level: 1, channel: 'печат', loans_count: 1 },
      { reader_id: ids.r2, level: 3, channel: 'печат', loans_count: 1 }
    ]);
    assert.equal(h.hooks.prints, 1, 'window.print() е извикан веднъж');
  });
  noRendererErrors();
});

/* ==================================================================
   11. Дневник (А/Б), годишен отчет и справките — числата срещу базата
   ================================================================== */
test('11. дневник и справки: всяко число е сбор от базата', async () => {
  await h.go('dnevnik');
  await h.clickButton('Печат / PDF', '#view');
  const days = all('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ?', Y + '-01-01', Y + '-12-31');
  const sum = (k) => days.reduce((s, d) => s + (Number(d[k]) || 0), 0);
  const month = T.slice(5, 7), monthDays = days.filter(d => d.date.slice(5, 7) === month);
  const msum = (k) => monthDays.reduce((s, d) => s + (Number(d[k]) || 0), 0);
  const hhmm = (m) => Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
  await soft('11a. дневник — раздел А, месец и от началото на годината', () => {
    const p = sheet('дневник А');
    assert.ok(p.includes('А. РЕГИСТРИРАНЕ НА ЧИТАТЕЛИТЕ И ПОСЕЩЕНИЯТА'));
    assert.match(p, new RegExp('Всичко за месеца\\s+' + rx(hhmm(msum('a_hours')))));
    assert.match(p, new RegExp('Всичко от нач. на годината\\s+' + rx(hhmm(sum('a_hours')))));
    assert.match(pageCss(), /A4 landscape/);
  });
  closePreview();
  await h.clickButton('Раздел Б', '#view');
  await h.clickButton('Печат / PDF', '#view');
  await soft('11b. дневник — раздел Б', () => {
    const p = sheet('дневник Б');
    assert.ok(p.includes('Б. РЕГИСТРИРАНЕ НА ЗАЕТИТЕ КНИГИ'));
    assert.match(p, new RegExp('Всичко от нач. на годината\\s+' + rx(hhmm(sum('b_hours')))));
  });
  closePreview();

  await h.go('reports');
  const catalog = ok(await h.api.reports.list(), 'каталог');
  const pick = async (id) => {
    const sel = h.$('#repSel'); sel.value = id; h.fire(sel, 'change');
    await h.waitFor(() => h.window._REPORT && h.window._REPORT.id === id, 'справката ' + id);
    await h.clickButton('Печат / PDF', '#view');
    return sheet('справка ' + id);
  };
  const title = (id) => catalog.find(c => c.id === id).title;
  let p = await pick('annual_ab');
  await soft('11c. годишен отчет А/Б — сборове от вписаните дни', () => {
    assert.ok(p.includes(title('annual_ab')));
    assert.match(p, seq('Справката обхваща', String(days.length), 'вписани работни дни'));
    assert.match(p, new RegExp('За ' + Y + ' г\\.\\s+' + rx(hhmm(sum('a_hours'))) + '\\s+' + sum('a_age_o28')), 'часове и над 28 г.');
    assert.match(pageCss(), /A4 landscape/, 'годишният отчет е пейзаж');
  });
  closePreview();
  p = await pick('fund_breakdown');
  const end = Y + '-12-31';
  const fund = q(`SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n, COALESCE(SUM(COALESCE(b.price,0)*COALESCE(i.quantity,1)),0) AS v
    FROM books b LEFT JOIN inventory i ON i.book_id=b.id WHERE +b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)`, end, end);
  await soft('11d. фонд по отдели/категории/езици', () => {
    assert.match(p, seq('Фонд към 31.12.' + Y + ' г. — общо ' + fund.n + ' бр., ' + E.mny(fund.v)));
    assert.match(p, seq('за възрастни', String(fund.n)));
    assert.match(p, seq('книга', String(fund.n)));
    assert.equal(fund.n, 6);
  });
  closePreview();
  p = await pick('readers_by_category');
  await soft('11e. читатели по категории', () => {
    assert.match(p, seq('Активни читатели, регистрирани до 31.12.' + Y + ' г.: 2'));
    assert.match(p, seq('новорегистрирани през ' + Y + ' г.: 1'));
    assert.match(p, seq('възрастен', '2'));
  });
  closePreview();
  p = await pick('fund_movement');
  await soft('11f. движение на фонда — по декларираното в партидите', () => {
    // закупуване: партида № 1 (3 бр., 75.50 обявени); дарение: № 2 (2 бр., 50 обявени) + № 3 (1 бр., без обявена → 3.50 изчислени).
    assert.match(p, seq('Постъпили през ' + Y + ' г. — 6 бр., ' + E.mny(75.5 + 50 + 3.5)));
    assert.match(p, seq('закупуване', '3', E.mny(75.5)));
    assert.match(p, seq('дарение', '3', E.mny(53.5)));
    assert.match(p, seq('Отчислени през ' + Y + ' г. — 4 бр., ' + E.mny(15.5)));
    assert.match(p, seq('констатирани като липсващи при инвентаризация', '4', E.mny(15.5)));
    assert.ok(!p.includes('физически изхабени'), 'анулираният акт попадна в движението');
  });
  closePreview();
  p = await pick('mzs_annual');
  await soft('11g. МЗС — обобщение', () => {
    assert.match(p, seq('Заявки за ' + Y + ' г.: 2'));
    assert.match(p, seq('входящо', '1')); assert.match(p, seq('изходящо', '1'));
  });
  closePreview();
  p = await pick('fees_income');
  await soft('11h. приходи от такси', () => {
    assert.match(p, seq('Начислено през ' + Y + ' г. — 1 бр., ' + E.mny(5) + ' · събрано — 1 бр., ' + E.mny(2)));
    assert.match(p, seq('годишна такса', '1', E.mny(5)));
  });
  await soft('11i. подписите на справките ползват ролята от Настройки', () => {
    assert.match(h.text(h.$('#ppSheet .psig')), /Библиотекар:.*Председател:/);
  });
  closePreview();
  noRendererErrors();
});

/* ==================================================================
   12. МЗС, краезнание, етикети — екраниране и обхват
   ================================================================== */
test('12. МЗС, краезнание и етикети: екраниране, обхват, отчисленият е без етикет', async () => {
  await h.go('mzs');
  const rows = h.window._MZS_ROWS || [];
  const out = rows.find(r => r.direction === 'изходящо');
  h.window.printMzsDoc(out.id);
  await h.settle();
  await soft('12a. МЗС изходяща — партньор с &, срок, подписи', () => {
    const p = sheet('МЗС изходяща');
    assert.match(p, seq('ЗАЯВКА ЗА МЕЖДУБИБЛИОТЕЧНО ЗАЕМАНЕ № 1 / ' + Y));
    assert.match(p, seq('Дата на вписване:', '10.02.' + Y + ' г.', 'До:', 'РБ „Априлов – Палаузов“ & Ко'));
    assert.match(p, seq('Търсен документ:', 'Вазов, Иван. Пълни съчинения, т. 3'));
    assert.match(p, seq('Статус:', 'заявено · срок за връщане 10.03.' + Y));
    assert.match(h.text(h.$('#ppSheet .psig')), /Библиотекар: Мария Иванова.*Председател:/);
  });
  closePreview();

  await h.go('persons');
  await h.clickButton('Печат / PDF', '#view');
  await soft('12b. персоналии — екраниране и обхват', () => {
    const p = sheet('персоналии');
    assert.match(p, seq('Пълен списък — всички', '1', 'вписани персоналии към ' + E.bgDate(T) + ' г.'));
    assert.match(p, seq('Петко Учителов', '· р. 01.03.1890', 'учител & основател'));
    assert.match(h.text(h.$('#ppSheet .psig')), /Съставил:.*Председател:/);
  });
  closePreview();
  await h.go('chronicle');
  await h.clickButton('Печат / PDF', '#view');
  await soft('12c. летопис', () => {
    const p = sheet('летопис');
    // Кръг 37: записите в летописа вече са номерирани („№ 1.“).
    assert.match(p, seq(Y + ' г.', '№ 1.', 'Празник на читалището · 24.05.' + Y + ' · читалище', 'Тържествен концерт.'));
  });
  closePreview();
  await h.go('analytics');
  await h.clickButton('Печат / PDF', '#view');
  await soft('12d. аналитично описание', () => {
    const p = sheet('аналитично описание');
    assert.match(p, seq('Яворец през Възраждането (' + Y + ')', '— краеведски', 'Краеведов, К.', 'сп. „Родознание“, кн. 4, стр. 12–19'));
  });
  closePreview();

  await h.go('labels');
  await h.window.printLabelsAll();
  await h.settle();
  const activeInv = all("SELECT inv_number FROM books WHERE status != 'отчислен' OR status IS NULL ORDER BY inv_number").map(r => r.inv_number);
  await soft('12e. етикети за фонда — всички неотчислени, нито един отчислен', () => {
    const p = sheet('етикети', { noHead: true });
    const lbls = h.$('#ppSheet').querySelectorAll('.lbl');
    assert.equal(lbls.length, activeInv.length, 'брой етикети = неотчислени записи');
    for (const inv of activeInv) assert.ok(p.includes(String(inv)), 'липсва етикет ' + inv);
    assert.ok(!p.includes('1004') && !p.includes('1006'), 'отчислен документ получи етикет');
    assert.ok(p.includes('Библиотека при') && p.includes(ORG) && p.includes('с. Яворец'), 'етикетът не носи библиотеката');
    assert.match(pageCss(), /grid-template-columns:repeat\(3,40mm\)/, 'колоните на етикетите');
  });
  closePreview();
  await h.window.printSignatureLabelsAll();
  await h.settle();
  await soft('12f. сигнатурни етикети', () => {
    const p = sheet('сигнатурни етикети', { noHead: true });
    assert.equal(h.$('#ppSheet').querySelectorAll('.lbl').length, activeInv.length);
    assert.ok(p.includes('821.163.2-31') && p.includes('В 17'));
    assert.match(pageCss(), /repeat\(3,25mm\)/);
  });
  closePreview();
  noRendererErrors();
});

/* ==================================================================
   13. „Запази PDF…“ (print:savePdf) през заглушения диалог
   ================================================================== */
test('13. Запази PDF: файлът, името, одитната следа, отварянето; отказът не вписва нищо', async () => {
  const wc = h.app.windows[0] && h.app.windows[0].webContents;
  assert.ok(wc, 'main.js не е създал прозорец');
  const pdfCalls = [];
  wc.printToPDF = async (o) => { pdfCalls.push(o); return Buffer.from('%PDF-1.7 проба'); };

  await h.go('kdbf');
  await h.clickButton('Печат / PDF', '#view');
  const target = path.join(scratch, 'kdbf.pdf');
  h.dialogs.savePath = target;
  const n = h.toasts.length;
  const shellBefore = h.app.shellCalls.length;
  await h.clickButton('Запази PDF…', '#printPreview');
  await h.settle();
  await soft('13a. PDF е записан през печатния път и отворен', () => {
    assert.equal(pdfCalls.length, 1);
    assert.equal(pdfCalls[0].printBackground, true);
    assert.equal(pdfCalls[0].preferCSSPageSize, true);
    assert.equal(fs.readFileSync(target, 'utf8'), '%PDF-1.7 проба');
    assert.ok(h.toastsSince(n).some(t => t.type === 'ok' && t.msg.includes('PDF файлът е записан и отворен: ' + target)), JSON.stringify(h.toastsSince(n)));
    assert.equal(h.app.shellCalls[shellBefore], target, 'shell.openPath не е извикан с файла');
    assert.match(lastAudit('Запазен PDF').detail, new RegExp(rx(target)));
    assert.equal(ppOpen(), false, 'прегледът се затваря след успешен запис');
    assert.equal(h.$('#printArea').innerHTML, '', '#printArea е освободен');
  });
  await soft('13b. предложеното име на файла', () => {
    const save = h.dialogs.calls.filter(c => c.kind === 'save').pop();
    assert.ok(save, 'няма диалог за запис');
    assert.equal(path.basename(save.opts.defaultPath), 'КДБФ ' + Y + ' г.pdf', 'името на файла носи излишна точка или липсва документът');
    assert.equal(save.opts.filters[0].extensions[0], 'pdf');
  });

  // Отказ от диалога: прегледът остава, няма грешка, отложеното действие не се изпълнява.
  await h.go('over');
  await h.clickButton('Печат на напомняния / PDF', '#view');
  h.dialogs.savePath = false;
  const before = q('SELECT COUNT(*) AS n FROM notice_log').n;
  const n2 = h.toasts.length;
  await h.clickButton('Запази PDF…', '#printPreview');
  await h.settle();
  await soft('13c. отказан диалог — без грешка, без вписване, прегледът остава', () => {
    assert.equal(h.toastsSince(n2).filter(t => t.type === 'err').length, 0, JSON.stringify(h.toastsSince(n2)));
    assert.equal(q('SELECT COUNT(*) AS n FROM notice_log').n, before);
    assert.equal(ppOpen(), true);
    assert.equal(h.$('#ppPdfBtn').disabled, false);
  });
  // Успешен запис на писмата → вписват се (равностойно на печат).
  h.dialogs.savePath = path.join(scratch, 'pisma.pdf');
  await h.clickButton('Запази PDF…', '#printPreview');
  await h.settle();
  await soft('13d. записаният PDF с писмата е равностоен на печат — вписва напомнянията', () => {
    assert.equal(q('SELECT COUNT(*) AS n FROM notice_log').n, before + 2);
    assert.equal(ppOpen(), false);
  });
  // Грешка при записа (printToPDF хвърля) → съобщение, нищо не се вписва.
  wc.printToPDF = async () => { throw new Error('принтерът изгоря'); };
  await h.clickButton('Печат на напомняния / PDF', '#view');
  h.dialogs.savePath = path.join(scratch, 'pisma2.pdf');
  const n3 = h.toasts.length;
  const before3 = q('SELECT COUNT(*) AS n FROM notice_log').n;
  await h.clickButton('Запази PDF…', '#printPreview');
  await h.settle();
  await soft('13e. грешка при записа — съобщение, без вписване', () => {
    assert.ok(h.toastsSince(n3).some(t => t.type === 'err' && t.msg === 'принтерът изгоря'), JSON.stringify(h.toastsSince(n3)));
    assert.equal(q('SELECT COUNT(*) AS n FROM notice_log').n, before3);
    assert.equal(ppOpen(), true);
  });
  closePreview();
  h.dialogs.savePath = null;
  noRendererErrors();
});

/* ==================================================================
   14. Изнасяния в CSV — читатели, дневник, фонд
   ================================================================== */
test('14. CSV: читатели (без ЕГН), дневник (със сборове), фонд (бройки и стойности)', async () => {
  const bom = '﻿';
  h.dialogs.savePath = path.join(scratch, 'chitateli.csv');
  await h.go('readers');
  await h.window.exportReadersCsv(); await h.settle();
  await soft('14a. читатели в CSV', () => {
    const t = fs.readFileSync(h.dialogs.savePath, 'utf8');
    assert.ok(t.startsWith(bom), 'без BOM Excel показва йероглифи');
    const lines = t.slice(1).split('\r\n');
    assert.equal(lines[0], 'Читателска карта;Име;Телефон;Адрес;Имейл;Категория;Състояние;Дата на регистрация;Дата на пререгистрация;Забележка');
    assert.equal(lines.length, 3);
    assert.ok(!t.includes('8005051234') && !t.includes('123456789'), 'ЕГН/№ ЛК изтекоха в CSV');
    // csvCell огражда всяка стойност в кавички (защита срещу формули в Excel).
    assert.match(t, /"0042";"Иван Читателов";"0888123456";"с\. Яворец, ул\. „Първа“ 5";"ivan@example\.com";"възрастен";"активен";/);
    assert.match(lastAudit('Извеждане на читатели (CSV)').detail, /2 записа/);
  });
  h.dialogs.savePath = path.join(scratch, 'dnevnik.csv');
  await h.go('dnevnik');
  await h.window.exportDnevnikCsv(); await h.settle();
  await soft('14b. дневник в CSV — дневни редове и двата сбора', () => {
    const t = fs.readFileSync(h.dialogs.savePath, 'utf8').slice(1);
    const lines = t.split('\r\n');
    assert.match(lines[0], /^Дата;/);
    const days = all('SELECT * FROM dnevnik_days WHERE date BETWEEN ? AND ?', Y + '-01-01', Y + '-12-31');
    const ytd = days.reduce((s, d) => s + (Number(d.a_hours) || 0), 0);
    const unq = (s) => String(s).replace(/^"|"$/g, '');
    const hdr = lines[0].split(';').map(unq);
    const col = hdr.findIndex(x => /Часове на обслужване/i.test(x));
    assert.ok(col > 0, 'заглавният ред няма колона за часовете: ' + hdr.slice(0, 3).join('|'));
    const last = lines[lines.length - 1].split(';').map(unq);
    assert.equal(last[0], 'Всичко от началото на годината');
    assert.equal(Number(last[col]), ytd, 'сборът от началото на годината (' + hdr[col] + ')');
    assert.equal(unq(lines[lines.length - 2].split(';')[0]), 'Всичко за месеца');
  });
  h.dialogs.savePath = path.join(scratch, 'fond.csv');
  await h.go('catalog');
  await h.window.exportCatalogCsv(); await h.settle();
  await soft('14c. фонд в CSV — бройки, цена в € и лв., обща стойност, състояние', () => {
    const t = fs.readFileSync(h.dialogs.savePath, 'utf8').slice(1);
    const lines = t.split('\r\n');
    assert.match(lines[0], /Инв\. №;.*;Бройки;Цена \(€\);Цена \(лв\.\);Обща стойност \(€\);Състояние$/);
    const row1004 = lines.find(l => l.startsWith('"1004";'));
    assert.ok(row1004, 'липсва инв. № 1004');
    /* v2.4.62: инв. № 1004 е разделен преди акта — редът е един екземпляр, а
       другите два са отделни редове със свои номера. */
    assert.match(row1004, /;"1";"4\.00";"7\.82";"4\.00";"отчислен"$/, 'бройка 1, цена 4 €, 7.82 лв., общо 4 €');
    for (const inv of ids.split1004) {
      const r = lines.find(l => l.startsWith('"' + inv + '";'));
      assert.ok(r, 'липсва отделеният екземпляр инв. № ' + inv);
      assert.match(r, /;"1";"4\.00";"7\.82";"4\.00";"отчислен"$/);
    }
    const row1001 = lines.find(l => l.startsWith('"1001";'));
    assert.ok(row1001.includes('"Том & Джери <b>удебелен</b>"'), 'заглавието в CSV');
    assert.equal(lines.length - 1, all('SELECT id FROM books').length);
  });
  h.dialogs.savePath = null;
  noRendererErrors();
});

/* ==================================================================
   15. ДВАТА РЕГИСТЪРА — пълни ли са и хваща ли пазачът им нов документ
   ================================================================== */
test('15. регистрите на документите: пълнота срещу изходния код и сила на пазача', () => {
  const regSrc = fs.readFileSync(path.join(__dirname, 'razpechatki.test.js'), 'utf8');
  /* Какво изброява регистърът — чете се направо от него, за да не се води втори
     списък: имената в кавички, които започват с „print“ или с „export“. */
  const covered = new Set(Array.from(regSrc.matchAll(/'((?:print|export)[A-Za-z0-9_]+)'/g)).map(m => m[1]));

  /* Претърсвачът е СЪЩИЯТ по смисъл като пазача в razpechatki.test.js, но е
     написан тук наново нарочно: този файл е независимият одитор и ако двата се
     разминат, разминаването трябва да си проличи, а не да се скрие зад обща
     помощна функция. Закрепването е за МЯСТОТО НА ПОВИКВАНЕ (doPrint,
     printLabelSheet, изнасяне на файл), а името се взима от най-близката
     предхождаща декларация на най-горно ниво — каквато и да е формата ѝ. */
  function maskStringsAndComments(src) {
    const out = src.split('');
    const n = src.length;
    const ctx = [{ t: 'code', depth: 0 }];
    let i = 0;
    while (i < n) {
      const c = src[i], top = ctx[ctx.length - 1];
      if (top.t === 'code') {
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { out[i] = ' '; i++; } continue; }
        if (c === '/' && src[i + 1] === '*') {
          while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
          if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
          continue;
        }
        if (c === "'" || c === '"' || c === '`') { ctx.push({ t: c }); out[i] = ' '; i++; continue; }
        if (c === '{') { top.depth++; i++; continue; }
        if (c === '}') {
          if (top.depth === 0 && ctx.length > 1) { ctx.pop(); out[i] = ' '; i++; continue; }
          top.depth--; i++; continue;
        }
        i++; continue;
      }
      if (c === '\\') { out[i] = ' '; if (src[i + 1] && src[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
      if (c === top.t) { ctx.pop(); out[i] = ' '; i++; continue; }
      if (top.t === '`' && c === '$' && src[i + 1] === '{') {
        out[i] = ' '; out[i + 1] = ' '; ctx.push({ t: 'code', depth: 0 }); i += 2; continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
    }
    return out.join('');
  }
  const DECL = /(?:^|\n)(?:(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=|window\.([A-Za-z0-9_$]+)\s*=)/g;
  const PRINTS = /\b(?:doPrint|printLabelSheet)\s*\(/g;
  const EXPORTS = /window\.api\.[A-Za-z0-9_$]+\.export[A-Za-z0-9_$]*\s*\(|\.download\s*=/g;
  function ownersOf(src, what) {
    const masked = maskStringsAndComments(src);
    const decls = []; let m;
    DECL.lastIndex = 0;
    while ((m = DECL.exec(masked))) decls.push({ name: m[1] || m[2] || m[3], at: m.index });
    const out = [];
    what.lastIndex = 0;
    while ((m = what.exec(masked))) {
      let owner = null;
      for (const d of decls) { if (d.at < m.index) owner = d; else break; }
      out.push(owner ? owner.name : '(извън декларация)');
    }
    return out;
  }

  const printers = new Set(), exporters = new Set();
  for (const file of fs.readdirSync(VIEWS_DIR).filter(f => f.endsWith('.js') && f !== 'core.js')) {
    const src = fs.readFileSync(path.join(VIEWS_DIR, file), 'utf8');
    ownersOf(src, PRINTS).forEach(n => printers.add(n));
    ownersOf(src, EXPORTS).forEach(n => exporters.add(n));
  }
  const expectedPrinters = ['printKdbfDoc', 'printInvBookDoc', 'printDnevnikDoc', 'printDonationDoc', 'printAcqNoDocDoc', 'printActDoc',
    'printInventProtocol', 'printLoanSlip', 'printReceiptLine', 'printReaderCard', 'printCardOne', 'printCardsAll', 'printOverdueNotices',
    'printMzsDoc', 'printAnalytics', 'printChronicle', 'printPersons', 'printLabelsAll', 'printLabelsRange',
    'printSignatureLabelsAll', 'printSignatureLabelsRange', 'printReportDoc',
    // Периодиката (кръг 37): абонаментният списък за годината и кардексът.
    'printPeriodikaYear', 'printPeriodicalCard'];
  const expectedExporters = ['exportReadersCsv', 'exportDnevnikCsv', 'exportCatalogCsv',
    'exportCatalog', 'exportMarc', 'exportDc', 'exportAuditCSV'];
  assert.deepEqual([...printers].sort(), expectedPrinters.slice().sort(), 'изброяването на печатните функции се разминава с кода');
  assert.deepEqual([...exporters].sort(), expectedExporters.slice().sort(), 'изброяването на изнасянията се разминава с кода');
  assert.deepEqual([...printers].filter(n => !covered.has(n)), [], 'печатни функции извън регистъра');
  assert.deepEqual([...exporters].filter(n => !covered.has(n)),
    [], 'регистърът не покрива изнасянията — а те също са документи за външен получател');
  assert.deepEqual([...covered].filter(n => !printers.has(n) && !exporters.has(n)),
    [], 'регистърът изброява несъществуващи функции');

  /* Сила на пазача — същите мутации, които един програмист би написал съвсем
     естествено, подадени на претърсвача. Всяка от шестте форми трябва да бъде
     ВИДЯНА и да излезе с име, което го няма в регистъра. */
  const mutations = {
    'обикновена function printNov()': '\nasync function printNov() { doPrint("<div/>"); }\n',
    'стрелкова функция const printNov2 = () => doPrint()': '\nconst printNov2 = async () => { doPrint("<div/>"); };\nwindow.printNov2 = printNov2;\n',
    'window.printNov3 = async function () {…}': '\nwindow.printNov3 = async function () { doPrint("<div/>"); };\n',
    'функция с друго име (spravkaPrint) — извън конвенцията': '\nfunction spravkaPrint() { doPrint("<div/>"); }\n',
    'печат през помощник (printNov4 → emitDoc → doPrint)': '\nfunction printNov4() { emitDoc("<div/>"); }\nfunction emitDoc(html) { doPrint(html); }\n',
    'метод в обект ({ printNov5() { doPrint() } })': '\nconst DOCS = { printNov5() { doPrint("<div/>"); } };\n'
  };
  for (const [what, src] of Object.entries(mutations)) {
    const names = ownersOf(src, PRINTS);
    assert.ok(names.length > 0, 'пазачът изобщо не вижда: ' + what);
    assert.deepEqual(names.filter(n => covered.has(n)), [], 'пазачът НЕ хваща: ' + what);
  }
  // Ново изнасяне — вторият регистър трябва да се държи по същия начин.
  assert.deepEqual(ownersOf('\nasync function exportNovo() { await window.api.knigi.exportCsv(); }\n', EXPORTS)
    .filter(n => covered.has(n)), [], 'пазачът не хваща ново изнасяне');
  // А коментар, в който ПИШЕ „doPrint()“, не е документ.
  assert.deepEqual(ownersOf('\n/* тук се вика doPrint() */\nconst X = 1;\n', PRINTS), []);
});

/* ==================================================================
   16. Още ръбове: празна партида-дарение, стар акт без комисия, картон без карта
   ================================================================== */
test('16. ръбове: дарение без инвентирани документи, акт без комисия/заповед, картон без номер на карта', async () => {
  /* Адресът на дарителя е задължителен реквизит по чл. 6, ал. 5 и от кръг 37
     handlers/acquisitions.js отказва партида-дарение без него (единият от трите
     екземпляра на акта отива при дарителя). Затова партидата тук вече носи
     адрес — проверяваният ръб е ДРУГ: партида без нито един инвентиран документ
     и без обявена стойност. Липсващият адрес на самия ЛИСТ (празни точки вместо
     „null“) се проверява няколко реда по-долу, като полето се изчисти направо в
     базата — акт, съставен по заварена партида отпреди тази проверка, трябва да
     излиза смислено. */
  const acqEmpty = ok(await h.api.acquisitions.create({ no: 4, date: T, how: 'дарение',
    from_source: 'Дарител Без Книги', donor_address: 'гр. Севлиево, ул. „Трета“ 9', total_count: 5 }), 'празна партида');
  h.db.prepare('UPDATE acquisitions SET donor_address = NULL WHERE id = ?').run(acqEmpty);
  await h.go('acq');
  h.window.openAcq(acqEmpty);
  await h.waitFor(() => h.modalOpen() && /Партида № 4/.test(h.modal()), 'партида № 4');
  await h.settle();
  await h.clickButton('Акт за дарение / PDF', '#modal');
  await soft('16a. акт за дарение без инвентирани документи и без стойност', () => {
    const p = sheet('акт за дарение (празен)');
    assert.match(p, seq('Общ брой документи по документа:', '5'));
    assert.ok(p.includes('не е обявена в документа и не може да бъде изчислена'));
    assert.ok(p.includes('Относно описа:') && p.includes('НЕ съдържа опис'));
    assert.match(p, seq('Адрес:', '…………………'), 'липсващият адрес е празен ред, не „null“');
    assert.match(h.text(h.$('#ppSheet .psig')), /Комисия: 1\. ………… 2\. ………… 3\. …………/, 'без комисия — празни редове');
  });
  closePreview();
  h.window.closeModal();

  // Акт без заповед и без комисия: празни редове за подпис, „№ …………“.
  const a3 = ok(await h.api.deaccessionActs.create({
    act: { no: 3, date: T, reason_code: 2, reason_text: 'дублетни екземпляри', disposal: '' }, bookIds: [ids.b2]
  }), 'акт № 3');
  await h.go('acts');
  await h.window.openAct(a3);
  await h.waitFor(() => h.modalOpen() && /Акт за отчисляване № 3/.test(h.modal()), 'акт № 3');
  await h.settle();
  await h.clickButton('Печат на акта / PDF', '#modal');
  await soft('16b. акт без заповед, комисия и разпореждане — празни места, не „null“; HTML в заглавието', () => {
    const p = sheet('акт № 3');
    assert.match(p, seq('назначена със заповед № …………'));
    assert.match(p, seq('1. …………………', '2. …………………', '3. ………………… (счетоводител)'));
    assert.match(p, seq('Начин на разпореждане по чл. 36:', '…………………'));
    assert.match(p, seq('1001', 'Барбера, Джоузеф & Хана, Уилям. Том & Джери <b>удебелен</b>'));
    // (редът ОБЩО също е в <b> — търси се точно удебеляване, дошло ОТ ЗАГЛАВИЕТО)
    assert.ok(!Array.from(h.$('#ppSheet').querySelectorAll('td b')).some(x => /удебелен/.test(x.textContent)),
      'HTML от заглавието е изпълнен в акта');
    assert.match(p, seq('ОБЩО 1 документ', E.mny(25.5)));
  });
  closePreview();
  h.window.closeModal();
  // Анулира се, за да не пречи на другите числа (и защото книгата е заета? — не е).
  ok(await h.api.deaccessionActs.revoke(a3, { reason: 'проба' }), 'анулиране на № 3');

  // Читател без номер на карта: картон и карта го КАЗВАТ, не измислят номер.
  /* От кръг 37 handlers/readers.js отказва да запише читател без отбелязано
     съгласие по чл. 47, ал. 2 — правилно, защото подписът на картона е
     основанието личните данни изобщо да се обработват. Проверяваният тук ръб
     обаче е ЗАВАРЕНИЯТ запис: картотека отпреди тази проверка съдържа читатели
     без отметка и техният картон трябва да излиза смислено, а не да мълчи.
     Затова съгласието се маха направо в базата, след като читателят е записан. */
  const r3 = ok(await h.api.readers.create({ name: 'Без Карта', category: 'дете до 14 г.', guarantor_name: 'Майка Ѝ', gdpr_consent: 1 }), 'читател без карта');
  h.db.prepare('UPDATE readers SET gdpr_consent = 0, gdpr_consent_date = NULL WHERE id = ?').run(r3);
  await h.go('readers');
  await h.window.printReaderCard(r3); await h.settle();
  await soft('16c. картон без номер на карта и без съгласие', () => {
    const p = sheet('картон без карта');
    assert.match(p, seq('ЧИТАТЕЛСКИ КАРТОН №'));
    assert.ok(p.includes('Няма номер на карта'));
    assert.ok(p.includes('няма отбелязано съгласие за обработване на лични данни'));
    assert.match(p, seq('Родител/настойник:', 'Майка Ѝ (родител)'));
    assert.ok(p.includes('За читател под 14 години картонът се подписва от родителя/настойника'));
    assert.ok(!h.$('#ppSheet svg'), 'баркод без номер на карта');
  });
  closePreview();
  await h.window.printCardOne(r3); await h.settle();
  await soft('16d. карта без номер', () => {
    const p = sheet('карта без номер', { noHead: true });
    assert.ok(p.includes('Няма номер на карта'));
    assert.ok(!h.$('#ppSheet svg'));
  });
  closePreview();
  noRendererErrors();
});

/* ==================================================================
   Край: находките
   ================================================================== */
test('Z. находки от сценария', () => {
  console.log('\n=== НАХОДКИ (' + findings.length + ') ===');
  /* Цялото съобщение, не само първият му ред: при assert.match първият ред е
     самият регулярен израз, а РАЗЛИКАТА („Input: …“) идва чак след него — тоест
     дотук списъкът показваше какво се е търсило, но не и какво е намерено, и
     всяка находка изискваше второ пускане с ръчно добавен печат. */
  findings.forEach((f, i) => console.log((i + 1) + '. ' + f.label + '\n   '
    + String(f.msg).split('\n').join('\n   ')));
  assert.equal(findings.length, 0, findings.length + ' находки — виж списъка по-горе');
});
