'use strict';
/* v2.4.71 — кръг 45, СГЛОБЯВАНЕТО МЕЖДУ ОБЛАСТИТЕ.
   =====================================================================
   Седемте области на кръга бяха поправени поотделно, всеки в своите файлове.
   Където поправката изискваше ред в ЧУЖД файл (зависимост в main.js, колона в
   схемата, същото правило в съседен модул), той беше описан в доклада и вързан
   тук, при сглобяването. Именно там нещо може тихо да не стигне до целта:
   модулът е поправен и тестът му минава (защото тестът сам подава
   зависимостта), а истинската програма никога не я подава. Затова всичко тук
   минава през ИСТИНСКИЯ main.js, истинските обработчици и екрана.

     М4  изтриване на читател освобождава заделена книга → katalog.json
     М6  групово попълване на авторски знак → katalog.json
     Д3  изтрит и заличен по ОРЗД читател не изчезва от отчетената година
     И6  името на ръководителя до „УТВЪРДИЛ“ — от снимката в документа (акт за
         отчисляване, акт за дарение, протокол от инвентаризация)
     И1/М1  колоните на проверката идват от схемата
     Ч4  актът по т. 5 брои забавата като гишето — от първия работен ден
     Ф7  „Иванов, И. Книга“ без двойна точка и в писмото по чл. 43
     Ч4/Ч15  „Настройки“ казват кои падежи са преместени и откъде е списъкът

   Всеки тест е проверен с връщане на връзката назад: без нея пада. */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
const Y = T.slice(0, 4);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-sg45-'));
const FILE = path.join(WORK, 'katalog.json');
const kat = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const item = (inv) => kat().items.find(i => String(i.inv) === String(inv));
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const ok = (res, what) => { assert.ok(res && res.ok, (what || '') + ': ' + (res && res.error)); return res.data; };

/* Сроковете на записа на каталога са 4 s (фонд) и 90 s (гише). Тестът не
   чака минута и половина: докато трае, таймерите с точно тези срокове се
   скъсяват до 30 ms. Всичко друго минава непроменено. */
const realSetTimeout = global.setTimeout;
function fastCatalogTimers() {
  global.setTimeout = function (fn, ms, ...rest) {
    return realSetTimeout(fn, (ms === 90000 || ms === 4000) ? 30 : ms, ...rest);
  };
}
test.before(async () => {
  h = await E.bootApp();
  await h.waitFor(() => h.view() === 'setup');
  await h.settle();
  const st = ok(await h.api.settings.get());
  ok(await h.api.settings.update(Object.assign({}, st, { org: 'НЧ „Сглобяване“', place: 'с. Проба', loan_days: 30,
    director: 'Иван Директоров', director_role: 'Председател' })), 'настройки');
  await h.go('catalog');
  h.dialogs.openPaths = [WORK];
  await h.clickButton('Избери папката на хранилището…', '#view');
  await h.settle(100);
  fastCatalogTimers();
});
test.after(() => { global.setTimeout = realSetTimeout; if (h) h.stop(); });

const cat = () => q("SELECT id FROM categories WHERE name='книга'").id;
async function book(inv, o = {}) {
  return ok(await h.api.books.create(Object.assign({ inv_number: inv, title: 'Книга ' + inv, author: 'Автор, А.',
    category_id: cat(), register_date: T, price: 2 }, o)), 'книга ' + inv);
}
async function reader(name, card, o = {}) {
  return ok(await h.api.readers.create(Object.assign({ name, card_no: card, gdpr_consent: 1 }, o)), 'читател ' + name);
}

/* ------------------------------------------------------------------ М4 */
test('М4 — изтриване на читател със заделена книга: katalog.json я показва налична (зависимостта от main.js)', async () => {
  const b = await book(4501, { title: 'Заделена за изтрития' });
  const r1 = await reader('Първи М4', 'M4-1');
  const r2 = await reader('Втори М4', 'M4-2');
  const lid = ok(await h.api.loans.checkout({ reader_id: r1, book_id: b, date_out: T }), 'заемане');
  ok(await h.api.holds.add({ reader_id: r2, code: '4501' }), 'резервация');
  ok(await h.api.loans.return({ id: lid, date_in: T }), 'връщане');
  assert.equal(q('SELECT status FROM holds WHERE reader_id = ? AND book_id = ?', r2, b).status, 'заделена', 'книгата е заделена за втория');
  ok(await h.api.catalog.writeNow(), 'запис');
  const before = JSON.stringify(item(4501));
  /* Читател с резервация се изтрива с второ натискане (първото предупреждава, че
     статистиката се мени) — така, както го прави библиотекарката. */
  const first = await h.api.readers.delete(r2);
  assert.equal(first.ok, false, 'първото натискане предупреждава');
  ok(await h.api.readers.delete(r2), 'изтриване на читателя (второ натискане)');
  assert.equal(q("SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND status IN ('чака','заделена')", b).n, 0, 'резервацията е освободена');
  await h.waitFor(() => JSON.stringify(item(4501)) !== before, 3000);
  assert.notEqual(JSON.stringify(item(4501)), before, 'katalog.json не беше пренаписан след освобождаването');
});

/* ------------------------------------------------------------------ М6 */
test('М6 — групово попълване на авторски знак: сигнатурата в katalog.json се сменя', async () => {
  ok(await h.api.authorMark.loadBuiltin(), 'вградената таблица');
  await book(4502, { title: 'Под игото', author: 'Вазов, Иван', udk: '821.163.2-31' });
  ok(await h.api.catalog.writeNow(), 'запис');
  const before = JSON.stringify(item(4502));
  const n = ok(await h.api.authorMark.fillApply(), 'попълване');
  assert.ok(n >= 1, 'поне един знак е попълнен');
  await h.waitFor(() => JSON.stringify(item(4502)) !== before, 3000);
  assert.match(JSON.stringify(item(4502)), /В\s*-?\s*\d+/, 'знакът „В …“ е в сигнатурата онлайн');
});

/* ------------------------------------------------------------------ Д3 */
test('Д3 — изтрит и заличен по ОРЗД читател остават в броя за годината на регистрацията', async () => {
  const count = async () => ok(await h.api.stats.report(Y), 'статистика').readersCount;
  const base = await count();
  const a = await reader('Изтрит Д3', 'D3-1', { registered_at: T });
  const b = await reader('Заличен Д3', 'D3-2', { registered_at: T });
  assert.equal(await count(), base + 2);
  assert.equal(q("SELECT COUNT(*) AS n FROM reader_registrations WHERE reader_key IN (?, ?)", 'r' + a, 'r' + b).n, 2,
    'записването пише в историята с ключа на картона');
  ok(await h.api.readers.delete(a), 'изтриване');
  ok(await h.api.gdpr.forgetReader(b), 'заличаване');
  assert.equal(q('SELECT COUNT(*) AS n FROM readers WHERE id IN (?, ?)', a, b).n, 0, 'и двата картона ги няма');
  assert.equal(await count(), base + 2, 'броят за годината не пада със задна дата');
  /* В историята не остава нищо лично — само ключ, дата и вид. */
  const rows = h.db.prepare('SELECT * FROM reader_registrations WHERE reader_key IN (?, ?)').all('r' + a, 'r' + b);
  for (const r of rows) assert.equal(r.reader_id, null, 'връзката към картона е прекъсната');
});

/* ------------------------------------------------------------------ И6 */
test('И6 — актът печата ръководителя от снимката си; нов ръководител не пренаписва стария акт', async () => {
  const b = await book(4503, { title: 'Остаряла' });
  const act = ok(await h.api.deaccessionActs.create({ act: { no: (await h.api.deaccessionActs.nextNo(Y)).data, disposal: 'за унищожаване', date: T, reason_code: 4, reason_text: 'остарели по съдържание',
    committee1: 'Библиотекар Първи', committee3: 'Счетоводител Трети' }, bookIds: [b] }), 'акт');
  const actId = typeof act === 'object' ? (act.id || act.actId) : act;
  assert.equal(q('SELECT director FROM deaccession_acts WHERE id = ?', actId).director, 'Иван Директоров');
  const st = ok(await h.api.settings.get());
  ok(await h.api.settings.update(Object.assign({}, st, { director: 'Нова Председателка' })), 'смяна');
  await h.window.loadSettingsCache(); // екранът държи Настройките в паметта — както след „Запиши“
  await h.go('acts');
  await h.window.printActDoc(actId);
  await h.settle(100);
  const printed = h.printed();
  assert.match(printed, /УТВЪРДИЛ, Председател: …+ \/Иван Директоров\//, 'името от снимката стои до „УТВЪРДИЛ“');
  assert.doesNotMatch(printed, /Нова Председателка/, 'днешният председател не отива под стар акт');
  /* КДБФ е регистър към днес — там е живото име. */
  await h.go('kdbf');
  await h.window.printKdbfDoc();
  await h.settle(100);
  assert.match(h.printed(), /Председател: …+ \/Нова Председателка\//);
});

/* И6 и в другите два документа със снимка: партидата (актът за дарение) и
   протоколът от инвентаризация. Връзката е същата — колона director в
   INSERT-а на обработчика (handlers/acquisitions.js, handlers/inventory-sessions.js)
   и a.director / s.director в разпечатката, — но всеки документ си има своя
   INSERT и своя печат, затова всеки се проверява: ако един от тях взима живото
   име от Настройки, препечатаният стар документ получава днешния ръководител. */
test('И6 — актът за дарение и протоколът от инвентаризация пазят името от снимката си', async () => {
  let st = ok(await h.api.settings.get());
  ok(await h.api.settings.update(Object.assign({}, st, { director: 'Първа Ръководителка' })), 'ръководител при съставянето');
  const acq = ok(await h.api.acquisitions.create({ no: (await h.api.acquisitions.nextNo(Y)).data, date: T, how: 'дарение',
    from_source: 'Дарител И6', donor_address: 'гр. Тетевен', doc_type: 'акт (разписка)', doc_no: 'И6', doc_date: T, total_count: 1, sum: '' }), 'партида');
  await book(4507, { title: 'Дарена И6', acquisition_id: acq });
  const sid = ok(await h.api.inventorySessions.start({ date: T, scope: 'целият фонд', order_no: '6', no: null,
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка' }), 'инвентаризация');
  ok(await h.api.inventorySessions.close({ sessionId: sid, mode: 'representative' }), 'приключване');
  assert.equal(q('SELECT director FROM acquisitions WHERE id = ?', acq).director, 'Първа Ръководителка', 'снимката в партидата');
  assert.equal(q('SELECT director FROM inventory_sessions WHERE id = ?', sid).director, 'Първа Ръководителка', 'снимката в проверката');
  st = ok(await h.api.settings.get());
  ok(await h.api.settings.update(Object.assign({}, st, { director: 'Втора Ръководителка' })), 'нов ръководител');
  await h.window.loadSettingsCache();
  await h.go('acq');
  await h.window.printDonationDoc(acq);
  await h.settle(100);
  let printed = h.printed();
  assert.match(printed, /УТВЪРДИЛ, Председател: …+ \/Първа Ръководителка\//, 'актът за дарение — името от снимката');
  assert.doesNotMatch(printed, /Втора Ръководителка/, 'днешният ръководител не отива под стар акт за дарение');
  await h.go('invent');
  await h.window.printInventProtocol(sid);
  await h.settle(100);
  printed = h.printed();
  assert.match(printed, /УТВЪРДИЛ, Председател: …+ \/Първа Ръководителка\//, 'протоколът — името от снимката');
  assert.doesNotMatch(printed, /Втора Ръководителка/, 'днешният ръководител не отива под стар протокол');
});

/* ------------------------------------------------------------------ И1/М1 */
test('И1/М1 — колоните на проверката (last_book_id, added_late, mzs_away) идват от схемата на програмата', () => {
  const cols = new Set(h.db.prepare('PRAGMA table_info(inventory_sessions)').all().map(c => c.name));
  for (const c of ['last_book_id', 'added_late', 'mzs_away', 'director']) assert.ok(cols.has(c), c);
});

/* ------------------------------------------------------------------ Ч4 */
test('Ч4 — актът по т. 5 брои забавата от първия работен ден след падежа, както „Просрочени“', async () => {
  const b = await book(4504, { title: 'Невърната Ч4', price: 5 });
  const r = await reader('Длъжник Ч4', 'C4-1');
  /* Падеж в НЕРАБОТЕН ден (заварено заемане, записано преди смяна на работните
     дни): първият ден от преди 8 дни насам, който не е работен. Календарът на
     програмата не се пипа отстрани — обработчиците държат снимка от него. */
  let due = E.addDays(T, -12);
  while (E.nextWorkDay(h.db, due) === due && due < E.addDays(T, -3)) due = E.addDays(due, 1);
  /* ДАТА-БОМБА (v2.4.78): неработен ден се търсеше само сред празниците — на
     5.10.2026 г. 22 септември излезе от прозореца и тестът падна, а между 24 май и
     6 септември празник няма изобщо. Когато в прозореца няма неработен ден, тестът
     си прави затворен ден през самата програма (calendar:addClosed — така и
     обработчиците го виждат) и го маха накрая. */
  let ownClosed = null;
  if (due >= E.addDays(T, -3)) {
    due = E.addDays(T, -8);
    ok(await h.api.calendar.addClosed({ date: due, reason: 'постановка Ч4' }), 'затворен ден');
    ownClosed = due;
  }
  assert.ok(due < E.addDays(T, -3) && E.nextWorkDay(h.db, due) !== due, 'падежът е в неработен ден');
  try {
    const lid = ok(await h.api.loans.checkout({ reader_id: r, book_id: b, date_out: E.addDays(T, -40) }), 'заемане');
    /* Вече начислена сума по заемането (продължение) и ставка 0,10 € на ден.
       Сумата се избира така, че събирането в двоична аритметика да остави
       остатък (като 0,10 + 0,70 = 0.7999999999999999) — тогава записът трябва да
       я закръгли до стотинка, както гишето. */
    h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(due, lid);
    h.db.prepare('UPDATE settings SET fine_per_day = 0.1 WHERE id = 1').run();
    const nDays = E.effectiveDaysLate(h.db, due, T);
    const add = Math.round(nDays * 0.1 * 100) / 100;
    let prior = 0.01;
    while (String(prior + add).length <= 5 && prior < 0.99) prior = Math.round((prior + 0.01) * 100) / 100;
    assert.ok(String(prior + add).length > 5, 'намерена сума с двоичен остатък (' + nDays + ' дни)');
    h.db.prepare('UPDATE loans SET fine = ? WHERE id = ?').run(prior, lid);
    const ov = ok(await h.api.loans.overdue(), 'просрочени').find(x => x.id === lid);
    const expected = E.effectiveDaysLate(h.db, due, T);
    assert.equal(ov.daysLate, expected, '„Просрочени“ брои от първия работен ден');
    ok(await h.api.deaccessionActs.create({ act: { no: (await h.api.deaccessionActs.nextNo(Y)).data, disposal: 'за унищожаване', date: T, reason_code: 5, reason_text: 'невърнат от читател',
      committee1: 'Библиотекар Първи', committee3: 'Счетоводител Трети' }, bookIds: [b] }), 'акт по т. 5');
    const l = q('SELECT deaccession_fine, fine FROM loans WHERE id = ?', lid);
    const perDay = Number(q('SELECT fine_per_day FROM settings WHERE id = 1').fine_per_day) || 0;
    assert.equal(l.deaccession_fine, Math.round(expected * perDay * 100) / 100, 'актът начислява същите дни като „Просрочени“');
    assert.equal(l.fine, Math.round((prior + l.deaccession_fine) * 100) / 100, 'сумата по заемането е до стотинка');
    assert.equal(String(l.fine).length <= 4, true, 'без двоичен остатък: ' + l.fine);
  } finally {
    if (ownClosed) ok(await h.api.calendar.removeClosed(ownClosed), 'махане на затворения ден');
  }
});

/* ------------------------------------------------------------------ Ф7 */
test('Ф7 — писмото по чл. 43 пише „Иванов, И. Книга“, без двойна точка', async () => {
  const b = await book(4505, { title: 'Инициал', author: 'Иванов, И.' });
  const r = await reader('Писмо Ф7', 'F7-1');
  const lid = ok(await h.api.loans.checkout({ reader_id: r, book_id: b, date_out: E.addDays(T, -60) }), 'заемане');
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(E.addDays(T, -30), lid);
  const rem = ok(await h.api.loans.reminders(), 'напомняния').find(x => x.reader_id === r);
  assert.match(rem.body, /Иванов, И\. Инициал/);
  assert.doesNotMatch(rem.body, /И\.\. /);
});

/* ------------------------------------------------------------------ Ч4/Ч15 */
test('Ч4/Ч15 — „Настройки“ казват кои падежи е преместил новият затворен ден и откъде е списъкът', async () => {
  const b = await book(4506, { title: 'Падеж в затворен ден' });
  const r = await reader('Падеж Ч15', 'C15-1');
  const lid = ok(await h.api.loans.checkout({ reader_id: r, book_id: b, date_out: T }), 'заемане');
  const due = q('SELECT date_due FROM loans WHERE id = ?', lid).date_due;
  await h.go('setup');
  await h.settle(100);
  const n = h.toastsSince ? h.toastsSince(0).length : 0;
  const d = h.$('[name=calDate]'); d.value = due;
  const rs = h.$('[name=calReason]'); rs.value = 'ремонт';
  await h.window.addClosedDay();
  await h.settle(150);
  assert.notEqual(q('SELECT date_due FROM loans WHERE id = ?', lid).date_due, due, 'падежът е преместен');
  const toasts = h.toastsSince(n).map(t => t.msg).join(' | ');
  assert.match(toasts, /падеж|срок/i, 'екранът казва за преместените падежи: ' + toasts);
  assert.match(h.$('#calClosedBox').textContent, /Показани са затворените дни от \d\d\.\d\d\.\d{4} насам/);
});
