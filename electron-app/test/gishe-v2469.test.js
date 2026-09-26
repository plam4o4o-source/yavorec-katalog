'use strict';
/* v2.4.69 — кръг 44 (пълен тест на v2.4.67), област ГИШЕ.
   =====================================================================
   По един (или повече) тест на всяка находка от Г1 до Г11, П12 и
   полето за кратност от П1. Всеки твърди онова, което БИБЛИОТЕКАРКАТА вижда —
   кой читател стои на гишето след сканирането, текста на отказа, числото в
   писмото по чл. 43, датата в картона, реда в одитната следа, надписа на
   таблото — а не вътрешната форма на данните. Всеки е проверен с връщане на
   поправката назад: без нея пада.

   П12 стои ПЪРВИ нарочно: той иска празна библиотека, а всички следващи
   тестове пълнят фонда. */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
const Y = T.slice(0, 4);
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + res.error); return res.data; };
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));

function mkBook(inv, o = {}) {
  const id = Number(h.db.prepare(`INSERT INTO books (inv_number, title, author, barcode, price, status, register_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(inv, o.title || ('Книга ' + inv), o.author || 'Автор, А.', o.barcode === undefined ? ('BC' + inv) : o.barcode,
      o.price == null ? 10 : o.price, o.status || 'наличен', '2026-01-05').lastInsertRowid);
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, o.qty || 1);
  return id;
}
function mkReader(name, card, o = {}) {
  return Number(h.db.prepare(`INSERT INTO readers (name, card_no, category, status, gdpr_consent, gdpr_consent_date,
      parent_consent, parent_consent_date, registered_at, re_registered_at, email, guarantor_name, phone)
    VALUES (?, ?, ?, 'активен', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, card, o.category || 'възрастен', o.gdpr_consent == null ? 1 : o.gdpr_consent,
      o.gdpr_consent_date === undefined ? '2026-01-02' : o.gdpr_consent_date,
      o.parent_consent == null ? 0 : o.parent_consent, o.parent_consent_date || null,
      o.registered_at || T, o.re_registered_at || null, o.email || null, o.guarantor_name || null,
      o.phone || null).lastInsertRowid);
}
function mkLoan(readerId, bookId, out, due) {
  return Number(h.db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, out, due).lastInsertRowid);
}
async function desk(readerId) {
  await h.go('circ');
  if (h.window.eval('CIRC.mode') !== 'out') { h.window.eval("CIRC.mode='out'"); }
  h.window.selectCircReader(readerId);
  await h.settle();
  await h.waitFor(() => h.$('#bScan'), 'полето за документи');
}
/* Поредица от отговори на въпросите (askConfirm минава през window.confirm в
   тестовата среда). Връща списъка със зададените въпроси. */
function answers(...seq) {
  const asked = [];
  h.window.confirm = (m) => { asked.push(String(m)); h.hooks.confirms.push(String(m)); return seq.length ? seq.shift() : false; };
  return asked;
}
function restoreConfirm() { h.window.confirm = (m) => { h.hooks.confirms.push(String(m)); return h.hooks.confirmAnswer; }; }

/* ==================================================================
   П12. Празната библиотека не „изостава“ с инвентаризацията
   ================================================================== */
test('П12 — празна библиотека: таблото казва „изпълнена“, не „изостава“ (0 от 0)', async () => {
  assert.equal(q('SELECT COUNT(*) AS n FROM books').n, 0, 'контролно: фондът е празен');
  await h.go('dash');
  const card = h.text('.normCard');
  assert.doesNotMatch(card, /изостава/, 'празната библиотека не изостава: ' + card);
  assert.match(card, /изпълнена/, 'изискване 0 е изпълнено изискване');
  assert.match(card, /няма документи/, 'и казва защо');
  assert.ok(!h.$('.normCard').classList.contains('behind'), 'без червената рамка');
});

/* ==================================================================
   Г1. Картата на следващия читател в полето за документи
   ================================================================== */
test('Г1 — карта № 5 в полето за документи сменя читателя, а не заема инв. № 5 на предишния', async () => {
  const prev = mkReader('Предишен Читател', '6');
  const next = mkReader('Следващ Читател', '5');
  const b5 = mkBook(5, { barcode: null });
  await desk(prev);

  // Кодът е и карта, и инв. №: първият въпрос е „да сменя ли читателя“ — да.
  let asked = answers(true);
  await h.scan('#bScan', '5');
  await h.waitFor(() => h.window.eval('CIRC.readerId') === next && h.$('#bScan'), 'гишето премина към следващия');
  restoreConfirm();
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE book_id = ?', b5).n, 0, 'инв. № 5 НЕ е зает на никого');
  assert.match(asked[0], /едновременно читателската карта на Следващ Читател/, 'въпросът назовава двусмислието');
  assert.match(h.viewText(), /Следващ Читател/, 'на гишето стои новият читател');

  // Отказ и на двата въпроса — нищо не се записва.
  await desk(prev);
  asked = answers(false, false);
  await h.scan('#bScan', '5');
  restoreConfirm();
  assert.equal(asked.length, 2, 'питат се и двата въпроса');
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE book_id = ?', b5).n, 0, 'след два отказа нищо не е заето');
  assert.match(h.text('#outLog'), /нищо не е заето/);

  // „Не — това е документ“, после „Заеми“ — заема се на избрания читател.
  asked = answers(false, true);
  await h.scan('#bScan', '5');
  restoreConfirm();
  assert.equal(q('SELECT reader_id FROM loans WHERE book_id = ? AND date_in IS NULL', b5).reader_id, prev,
    'библиотекарката каза, че е документ — заема се на текущия читател');
  h.db.prepare('DELETE FROM loans WHERE book_id = ?').run(b5);

  // Само карта (няма такъв документ) — смяна без въпрос, с известие.
  const only = mkReader('Само Карта', 'K-77');
  await desk(prev);
  asked = answers();
  const n = h.toasts.length;
  await h.scan('#bScan', 'K-77');
  await h.waitFor(() => h.window.eval('CIRC.readerId') === only, 'смяна на читателя');
  restoreConfirm();
  assert.equal(asked.length, 0, 'само карта — без въпрос');
  assert.ok(h.toastsSince(n).some(t => /читателската карта на Само Карта — гишето премина към него/.test(t.msg)),
    JSON.stringify(h.toastsSince(n)));
});

/* ==================================================================
   Г2. Ръчно „обезщетение“ не връща платената забава в писмото по чл. 43
   ================================================================== */
test('Г2 — платена забава 1,70 + ръчно обезщетение 5 € за корица → писмото иска само новите дни', async () => {
  h.db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const r = mkReader('Закъснял Платил', 'G2', { email: 'z@example.bg', phone: '0888 509' });
  const b = mkBook(2001);
  const lid = ok(await h.api.loans.checkout({ reader_id: r, book_id: b, date_out: E.addDays(T, -40) }), 'заемане');
  const ext = ok(await h.api.loans.extend({ id: lid }), 'продължение');
  const F1 = cents(ext.fine);
  assert.ok(F1 > 0, 'продължението начислява забава');
  assert.equal(q("SELECT type FROM account_lines WHERE reader_id = ? AND kind = 'начисление'", r).type, 'забава',
    'забавата е със собствен вид');
  ok(await h.api.account.pay({ reader_id: r, amount: F1, date: T }), 'плаща забавата');
  const newDue = E.addDays(T, -10);
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(newDue, lid);
  const newFine = cents(E.effectiveDaysLate(h.db, newDue, T) * 0.10);

  // Ръчното начисление — през екрана „Сметка → Друго начисление“.
  await h.window.accountModal(r);
  await h.waitFor(() => /Сметка — Закъснял Платил/.test(h.modal()), 'сметката');
  await h.clickButton('+ Друго начисление…', '#modal');
  await h.waitFor(() => h.$('#chgF'), 'формата');
  const opts = Array.from(h.$('#chgF [name=type]').options).map(o => o.value + '=' + o.textContent);
  assert.ok(!opts.some(o => o.startsWith('забава=')), 'забавата не се предлага за ръчно начисление: ' + opts);
  assert.ok(opts.some(o => /^обезщетение=.*не забава/.test(o)), 'обезщетението е назовано с думи: ' + opts);
  h.type('#chgF [name=type]', 'обезщетение');
  h.type('#chgF [name=amount]', '5,00');
  h.type('#chgF [name=note]', 'повредена корица');
  await h.clickButton('Начисли', '#modal2');
  await h.settle();
  await h.clickButton('Затвори', '#modal footer');
  assert.equal(ok(await h.api.account.get(r), 'сметка').balance, 5, 'сметката: дължи само корицата');

  const letter = ok(await h.api.loans.overdueByReader(), 'писма').find(x => x.reader_id === r);
  const rem = ok(await h.api.loans.reminders(), 'напомняния').find(x => x.reader_id === r);
  assert.equal(letter.fine, newFine, 'писмото по чл. 43 иска само новите дни, не и платената забава');
  assert.equal(letter.finePaid, F1, 'и знае, че забавата е платена');
  assert.ok(rem.sms.includes('обезщетение ' + newFine.toFixed(2) + ' €'), 'SMS: ' + rem.sms);

  await h.go('over');
  await h.clickButton('Печат на напомняния / PDF', '#view');
  await h.settle();
  const p = h.printed();
  const part = p.slice(p.indexOf('До: Закъснял Платил'), p.indexOf('До: Закъснял Платил') + 1500);
  assert.match(part, rx('Общо дължимо обезщетение: ' + E.mny(newFine)), 'печатното писмо: ' + part.slice(0, 300));
  if (h.window.ppClose) h.window.ppClose();
  await h.settle();

  // Обработчикът не приема ръчна „забава“ — казва откъде се начислява.
  const bad = await h.api.account.charge({ reader_id: r, type: 'забава', amount: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Забавата се начислява от програмата/);
  assert.equal(ok(await h.api.account.get(r), 'сметка').balance, 5, 'нищо не е начислено');
});

/* ==================================================================
   Г2 / основи. Годишният отчет брои платената забава, а миграция 18
   преименува само забавата, писана от програмата
   ================================================================== */
test('Г2 — годишен отчет: платената забава (вид „забава“) влиза в „Събрани обезщетения“', async () => {
  /* Разликата преди/след — сметките на другите тестове в същата база не пречат:
     събраното се смята по читател, а този читател е нов. */
  const r = mkReader('Отчетен Платец', 'G2r');
  const before = ok(await h.api.stats.report(Y), 'отчет преди').finesCollected;
  const add = h.db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)');
  add.run(r, Y + '-03-01', 'начисление', 'забава', 1.7, 'Забава 17 дни (инв. № 2002)');
  add.run(r, Y + '-03-02', 'плащане', 'плащане', -1.7, null);
  const after = ok(await h.api.stats.report(Y), 'отчет след').finesCollected;
  assert.equal(cents(after - before), 1.7, 'платената забава е събрано обезщетение по чл. 43 — както преди, когато беше „обезщетение“');
});

test('миграция 18 — заварената забава („Забава …“) става вид „забава“; ръчното обезщетение за корица остава', () => {
  /* Заварена база от v2.4.67 (user_version 17): програмата е писала забавата
     като „обезщетение“ с бележка „Забава …“, а библиотекарката — ръчно
     „обезщетение“ за повредена корица. Миграцията трябва да преименува САМО
     първото. main.js се зарежда веднъж на процес (а тук вече е зареден от
     bootApp() с празна база), затова заварената база се отваря от истинския
     main.js в ОТДЕЛЕН процес. */
  const path = require('path');
  const { spawnSync } = require('child_process');
  const APP_DIR = path.join(__dirname, '..');
  const script = `
    const fs = require('fs'), path = require('path'), Database = require('better-sqlite3');
    const { startMainApp } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'main-app'))});
    const app = startMainApp({ seedDb(p) {
      const db = new Database(p);
      db.exec(fs.readFileSync(path.join(${JSON.stringify(APP_DIR)}, 'db', 'schema.sql'), 'utf8'));
      const r = db.prepare("INSERT INTO readers (name, status, gdpr_consent) VALUES ('Заварен Длъжник', 'активен', 1)").run().lastInsertRowid;
      const ins = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)');
      ins.run(r, '2026-03-01', 'начисление', 'обезщетение', 1.7, 'Забава 17 дни (инв. № 5)');
      ins.run(r, '2026-03-01', 'начисление', 'обезщетение', 5, 'повредена корица');
      ins.run(r, '2026-03-02', 'плащане', 'плащане', -1.7, null);
      db.pragma('user_version = 17');
      db.close();
    } });
    app.ready().then(() => {
      const db = new Database(path.join(app.userData, 'library.db'), { readonly: true });
      const out = { v: db.pragma('user_version', { simple: true }),
        rows: db.prepare("SELECT type, note FROM account_lines WHERE kind = 'начисление' ORDER BY id").all() };
      db.close(); app.stop();
      process.stdout.write('\\n' + JSON.stringify(out) + '\\n');
      process.exit(0);
    }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: APP_DIR, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, 'заварената база не се отвори: ' + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(out.v >= 18, 'миграция 18 е минала (user_version ' + out.v + ')');
  assert.deepEqual(out.rows.map(x => x.type + ' · ' + x.note), [
    'забава · Забава 17 дни (инв. № 5)',
    'обезщетение · повредена корица'
  ], 'само писаното от програмата „Забава …“ става вид „забава“');
});

/* ==================================================================
   Г3. Редакция на картона не измисля дата на съгласието
   ================================================================== */
test('Г3 — смяна само на телефона не слага днешна дата на заварено съгласие (и на родител)', async () => {
  const legacy = mkReader('Заварен Безданов', 'G3', { gdpr_consent_date: null });
  const child = mkReader('Дете Безданово', 'G3d', { category: 'дете до 14 г.', gdpr_consent_date: null,
    parent_consent: 1, parent_consent_date: null, guarantor_name: 'Майка Безданова' });
  for (const [id, phone] of [[legacy, '0877 111'], [child, '0877 222']]) {
    await h.go('readers');
    await h.window.readerForm(id);
    await h.waitFor(() => h.$('#readerF'), 'картонът');
    assert.equal(h.$('#readerF [name=gdpr_consent_date]').value, '', 'формата показва празна дата');
    h.type('#readerF [name=phone]', phone);
    await h.clickButton('Запиши', '#modal footer');
    await h.settle();
    const r = q('SELECT phone, gdpr_consent_date, parent_consent_date FROM readers WHERE id = ?', id);
    assert.equal(r.phone, phone, 'телефонът е записан');
    assert.equal(r.gdpr_consent_date, null, 'датата на съгласието остава неизвестна, не днешна');
    if (id === child) assert.equal(r.parent_consent_date, null, 'и датата на съгласието на родителя');
  }
  // Съгласие, отметнато СЕГА без дата — това е днес (както казва подсказката).
  const fresh = mkReader('Нов Съгласен', 'G3n', { gdpr_consent: 0, gdpr_consent_date: null });
  const cur = ok(await h.api.readers.get(fresh), 'читател');
  ok(await h.api.readers.update(Object.assign({}, cur, { gdpr_consent: 1, gdpr_consent_date: '' })), 'отметка днес');
  assert.equal(q('SELECT gdpr_consent_date FROM readers WHERE id = ?', fresh).gdpr_consent_date, T);
});

/* ==================================================================
   Г4. „Липсващ“ и „за реставрация“ на гишето
   ================================================================== */
test('Г4 — „липсващ“: „Документът е намерен?“ → „наличен“ със следа; без потвърждение — отказ', async () => {
  const r = mkReader('Читател Г4', 'G4');
  const miss = mkBook(4401, { status: 'липсващ' });
  const rest = mkBook(4402, { status: 'за реставрация' });

  // Обработчикът: без потвърждение — отказ, нищо не се пипа.
  const refused = await h.api.loans.checkoutByCode({ reader_id: r, code: '4401', date_out: T });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /„липсващ“.*Документът е намерен.*НЕ е записано/s);
  assert.equal(q('SELECT status FROM books WHERE id = ?', miss).status, 'липсващ');

  // Екранът: отказ на въпроса — нищо.
  await desk(r);
  let asked = answers(false);
  await h.scan('#bScan', '4401');
  restoreConfirm();
  assert.match(asked[0], /Документът е намерен\?/);
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE book_id = ?', miss).n, 0);
  assert.match(h.text('#outLog'), /остава „липсващ“/);

  // Потвърждение — заема се и състоянието става „наличен“, със следа.
  asked = answers(true);
  await h.scan('#bScan', '4401');
  restoreConfirm();
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL', miss).n, 1, 'заето');
  assert.equal(q('SELECT status FROM books WHERE id = ?', miss).status, 'наличен', 'намереният документ е „наличен“');
  assert.match(h.text('#outLog'), /беше „липсващ“ и е намерен/);
  const tr = q("SELECT detail FROM audit_log WHERE action = 'Намерен документ' ORDER BY id DESC");
  assert.ok(tr && /инв\. № 4401.*беше „липсващ“.*наличен/.test(tr.detail), 'следа: ' + (tr && tr.detail));

  // „За реставрация“ — предупреждение, състоянието остава.
  asked = answers(true);
  await h.scan('#bScan', '4402');
  restoreConfirm();
  assert.match(asked[0], /„за реставрация“/, 'екранът пита преди това');
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL', rest).n, 1);
  assert.equal(q('SELECT status FROM books WHERE id = ?', rest).status, 'за реставрация', 'състоянието не се пипа');
  assert.match(h.text('#outLog'), /„за реставрация“ — заемането е записано, състоянието остава/);
});

/* ==================================================================
   Г5. Изтриване на читател със заделена книга повиква следващия
   ================================================================== */
test('Г5 — изтриването на читател със ЗАДЕЛЕНА книга повиква следващия и казва кого', async () => {
  const x = mkReader('Хикс Заделен', 'G5x');
  const y = mkReader('Игрек Чакащ', 'G5y', { phone: '0888 555' });
  const b = mkBook(5501);
  h.db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'заделена', '2026-01-01 10:00:00')").run(b, x);
  h.db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'чака', '2026-01-02 10:00:00')").run(b, y);
  h.hooks.confirmAnswer = true;
  restoreConfirm();
  await h.go('readers');
  // Първото натискане — отказ с „още веднъж“ (читателят има резервация); второто изтрива.
  await h.window.deleteReader(x); await h.settle();
  const n = h.toasts.length;
  await h.window.deleteReader(x); await h.settle();
  assert.equal(q('SELECT COUNT(*) AS n FROM readers WHERE id = ?', x).n, 0, 'читателят е изтрит');
  assert.equal(q('SELECT status FROM holds WHERE reader_id = ?', y).status, 'заделена', 'Игрек е повикан');
  assert.ok(h.toastsSince(n).some(t => /Инв\. № 5501.*заделен за Игрек Чакащ \(тел\. 0888 555\)/.test(t.msg)),
    'екранът казва кого да извика: ' + JSON.stringify(h.toastsSince(n)));
  const tr = q("SELECT detail FROM audit_log WHERE action LIKE 'Изтрит читател%' ORDER BY id DESC");
  assert.match(tr.detail, /повикана за: Игрек Чакащ/);
  // Друг читател вече не чува „резервирана за …“ заради изтрития.
  const z = mkReader('Зет Друг', 'G5z');
  const res = await h.api.loans.checkoutByCode({ reader_id: z, code: '5501', date_out: T });
  assert.equal(res.ok, false);
  assert.match(res.error, /Игрек Чакащ/, 'книгата е заделена за живия чакащ, не за изтрития');
});

/* ==================================================================
   Г6. Авансът намалява „Общо дължимо“ в писмото
   ================================================================== */
test('Г6 — аванс 1 € и неначислена забава 1,20 € → писмото, SMS-ът и екранът искат 0,20 €', async () => {
  h.db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const r = mkReader('Платил Предварително', 'G6');
  const b = mkBook(6601);
  const due = E.addDays(T, -20);
  mkLoan(r, b, E.addDays(T, -35), due);
  ok(await h.api.account.pay({ reader_id: r, amount: 1, date: E.addDays(T, -1) }), 'аванс вчера');
  const fA = cents(E.effectiveDaysLate(h.db, due, T) * 0.10);
  assert.ok(fA > 1, 'контролно: забавата е над аванса (' + fA + ')');
  const expect = cents(fA - 1);
  const letter = ok(await h.api.loans.overdueByReader(), 'писма').find(x => x.reader_id === r);
  const rem = ok(await h.api.loans.reminders(), 'напомняния').find(x => x.reader_id === r);
  const row = ok(await h.api.loans.overdue(), 'просрочени').find(x => x.reader_id === r);
  assert.equal(letter.fine, expect, 'писмото по чл. 43 приспада аванса');
  assert.equal(letter.finePaid, 1, 'и го назовава като платено');
  assert.equal(rem.fine, expect, 'имейлът/SMS-ът — същото');
  assert.ok(rem.sms.includes('обезщетение ' + expect.toFixed(2) + ' €'), rem.sms);
  assert.match(rem.body, /от тях платени 1\.00 €/);
  assert.equal(row.fine, expect, 'екранът „Просрочени“ — същото');
  await h.go('over');
  const tr = Array.from(h.document.querySelectorAll('#ovBody tr')).find(t => /Платил Предварително/.test(t.textContent));
  assert.match(h.text(tr), /аванс по сметката/, 'редът казва, че е приспаднат аванс');
});

/* ==================================================================
   Г7. Заличаването по чл. 17 казва кой е повикан (екранната половина)
   ================================================================== */
test('Г7 — известието при заличаване назовава повикания; без полето — казва къде да се види', async () => {
  const r = mkReader('Зета Заличена', 'G7');
  const real = h.window.api.gdpr.forgetReader;
  try {
    h.window.api.gdpr.forgetReader = async () => ({ ok: true, data: { name: 'Зета Заличена', auditCleared: 2, holdsCancelled: 1,
      holdsActivated: [{ name: 'Игрек Повикан', phone: '0888 777', title: 'Под игото', inv_number: 77 }] } });
    await h.go('readers');
    let n = h.toasts.length;
    h.hooks.confirmAnswer = true; restoreConfirm();
    await h.window.forgetReader(r); await h.settle();
    assert.ok(h.toastsSince(n).some(t => /Инв\. № 77 — „Под игото“ е заделен за Игрек Повикан \(тел\. 0888 777\)/.test(t.msg)),
      JSON.stringify(h.toastsSince(n)));
    // По-стар обработчик без holdsActivated, но с отказани резервации.
    h.window.api.gdpr.forgetReader = async () => ({ ok: true, data: { name: 'Зета Заличена', auditCleared: 2, holdsCancelled: 1 } });
    n = h.toasts.length;
    await h.window.forgetReader(r); await h.settle();
    assert.ok(h.toastsSince(n).some(t => /следващият в опашката е повикан — вижте „Заемане и връщане“ → „Резервации“/.test(t.msg)),
      JSON.stringify(h.toastsSince(n)));
  } finally {
    h.window.api.gdpr.forgetReader = real;
  }
});

/* ==================================================================
   Г8. „Изгубена“ на заварен запис с няколко бройки
   ================================================================== */
test('Г8 — „Изгубена“ на запис с 3 бройки се отказва с „разделете първо“; бройките на рафта остават заемаеми', async () => {
  const b = mkBook(900, { title: 'Заварен учебник', qty: 3 });
  const r1 = mkReader('Мно Един', 'G8a'), r2 = mkReader('Мно Две', 'G8b'), r3 = mkReader('Мно Три', 'G8c');
  const l1 = ok(await h.api.loans.checkoutByCode({ reader_id: r1, code: '900', date_out: T }), 'заемане 1').id;
  ok(await h.api.loans.checkoutByCode({ reader_id: r2, code: '900', date_out: T }), 'заемане 2');
  const quote = await h.api.loans.lostQuote({ id: l1 });
  assert.equal(quote.ok, false, 'прозорецът не се отваря напразно');
  const res = await h.api.loans.markLost({ id: l1, resolution: 'обезщетение', amount: 24, date: T });
  assert.equal(res.ok, false);
  assert.match(res.error, /3 екземпляра.*Разделете първо записа.*Нищо не е записано/s);
  assert.equal(q('SELECT status FROM books WHERE id = ?', b).status, 'наличен', 'записът не е „изгубен“');
  assert.equal(q('SELECT COUNT(*) AS n FROM account_lines WHERE reader_id = ?', r1).n, 0, 'нищо не е начислено');
  ok(await h.api.loans.checkoutByCode({ reader_id: r3, code: '900', date_out: T }), 'третата бройка от рафта се заема');
});

/* ==================================================================
   Г9. Таблото: „налична“ само за наличен документ
   ================================================================== */
test('Г9 — таблото не показва „налична“ за документ „за реставрация“, „липсващ“ или „изгубен“', async () => {
  const ids = { 'за реставрация': mkBook(9901, { status: 'за реставрация' }), 'липсващ': mkBook(9902, { status: 'липсващ' }),
    'изгубен': mkBook(9903, { status: 'изгубен' }) };
  mkBook(9904);
  await h.go('dash');
  for (const [st, inv] of [['за реставрация', 9901], ['липсващ', 9902], ['изгубен', 9903]]) {
    assert.ok(ids[st]);
    await h.window.dashLookup(String(inv)); await h.settle();
    const t = h.text('#dashScanResult');
    assert.doesNotMatch(t, /налична/, st + ': ' + t);
    assert.match(t, rx(st), 'показва състоянието: ' + t);
  }
  await h.window.dashLookup('9904'); await h.settle();
  assert.match(h.text('#dashScanResult'), /налична/, 'наличният си остава „налична“');
});

/* ==================================================================
   Г10. Пререгистрациите: филтър, число на таблото, гишето
   ================================================================== */
test('Г10 — „Дължими пререгистрации“ води в „Читатели“ с филтър; гишето казва за изтекла регистрация', async () => {
  const old = mkReader('Стар Нерегистриран', 'G10a', { registered_at: E.addDays(T, -400) });
  mkReader('Скорошен Регистриран', 'G10b', { registered_at: E.addDays(T, -30) });
  const dash = ok(await h.api.dashboard.full(), 'табло');
  const page = ok(await h.api.readers.list('', null, { offset: 0, limit: 500, rereg: 'due' }), 'филтър');
  assert.equal(page.total, dash.today.reregDue, 'филтърът показва точно числото от таблото');
  assert.equal(page.reregDue, dash.today.reregDue);
  assert.ok(page.rows.some(r => r.id === old) && !page.rows.some(r => r.name === 'Скорошен Регистриран'));

  await h.go('dash');
  const link = Array.from(h.document.querySelectorAll('#view a')).find(a => /dashOpenRereg/.test(a.getAttribute('onclick') || ''));
  assert.ok(link, 'числото е връзка');
  link.click();
  await h.waitFor(() => h.window.eval('VIEW') === 'readers' && h.$('#rReregFilter'), 'Читатели');
  await h.settle();
  assert.equal(h.$('#rReregFilter').value, 'due', 'филтърът е включен');
  assert.match(h.viewText(), /Показани са само активните читатели с дължима пререгистрация/);
  assert.match(h.text('#rBody'), /Стар Нерегистриран/);
  assert.doesNotMatch(h.text('#rBody'), /Скорошен Регистриран/);
  await h.window.readersReregFilter(''); await h.settle();

  await desk(old);
  assert.match(h.viewText(), rx('Регистрацията е изтекла на ' + E.bgDate(E.addDays(E.addDays(T, -400), 365)).slice(0, 6)),
    'гишето казва за изтеклата регистрация: ' + h.viewText().slice(0, 300));
});

/* ==================================================================
   Г11. Дребните
   ================================================================== */
test('Г11а — намерената книга е „върната“ в деня на намирането, а не в годината на изгубването', async () => {
  h.db.prepare('UPDATE settings SET fine_per_day = 0.10 WHERE id = 1').run();
  const py = String(Number(Y) - 1);
  const r = mkReader('Губещ Намиращ', 'G11a');
  const b = mkBook(1101, { price: 5 });
  const lid = mkLoan(r, b, py + '-11-01', py + '-11-15');
  ok(await h.api.loans.markLost({ id: lid, resolution: 'обезщетение', amount: 15, date: py + '-12-20' }), 'изгубена миналата година');
  const before = ok(await h.api.stats.report(py), 'отчет').returnedLate;
  const f = ok(await h.api.loans.found({ id: lid, reverseCharge: true, date: T }), 'се намери');
  const l = q('SELECT date_in, lost FROM loans WHERE id = ?', lid);
  assert.equal(l.date_in, T, 'заемането е затворено в деня на намирането');
  assert.equal(ok(await h.api.stats.report(py), 'отчет').returnedLate, before,
    'годината на изгубването НЕ получава „върната със забава“');
  assert.equal(q("SELECT COUNT(*) AS n FROM events WHERE kind = 'връщане' AND book_id = ? AND date = ?", b, T).n, 1,
    'и регистърът на събитията казва същото — едно връщане, днес');
  assert.ok(f, 'контролно');
});

test('Г11б — следата „Продължение на заемане“ пише срока като дд.мм.гггг', async () => {
  const r = mkReader('Продължаващ', 'G11b');
  const b = mkBook(1102);
  const lid = mkLoan(r, b, T, E.addDays(T, 14));
  const x = ok(await h.api.loans.extend({ id: lid }), 'продължение');
  const tr = q("SELECT detail FROM audit_log WHERE action = 'Продължение на заемане' ORDER BY id DESC").detail;
  assert.match(tr, rx(' до ' + E.bgDate(x.date_due) + ' ('), tr);
  assert.doesNotMatch(tr, /\d{4}-\d{2}-\d{2}/, 'няма ISO дата в следата');
});

test('Г11в — напомнянето за дете не отива на имейла на детето', async () => {
  const c = mkReader('Ани Детска', 'G11c', { category: 'дете до 14 г.', parent_consent: 1, guarantor_name: 'Петя Детска',
    email: 'ani.kid@example.bg' });
  const a = mkReader('Възрастен Имейлов', 'G11d', { email: 'adult@example.bg' });
  mkLoan(c, mkBook(1103), E.addDays(T, -30), E.addDays(T, -10));
  mkLoan(a, mkBook(1104), E.addDays(T, -30), E.addDays(T, -10));
  const rems = ok(await h.api.loans.reminders(), 'напомняния');
  const rc = rems.find(x => x.reader_id === c), ra = rems.find(x => x.reader_id === a);
  assert.match(rc.body, /Петя Детска \(.*на Ани Детска\)/, 'контролно: писмото е до родителя');
  assert.notEqual(rc.email, 'ani.kid@example.bg', 'писмото до родителя не отива на пощата на детето');
  assert.match(rc.email_note, /на детето/);
  assert.equal(ra.email, 'adult@example.bg', 'възрастният си получава имейла');
});

test('Г11г — „Вписано днес на гишето“ казва, че следата е обща за всички работни места', async () => {
  h.window.eval('CIRC.readerId = null; CIRC.mode = "out"');
  await h.go('circ');
  await h.waitFor(() => /Броят се/.test(h.text('#circToday')), 'панелът');
  const t = h.text('#circToday');
  assert.doesNotMatch(t, /на това работно място/, t);
  assert.match(t, /от всички работни места/);
});

/* ==================================================================
   П1 (половината на гишето). Кратността в прозореца „Изгубен“ приема „1,5“
   ================================================================== */
test('П1 — „Промени правилото…“ от прозореца „Изгубен“: „1,5“ се записва като 1,5, не като 15', async () => {
  const r = mkReader('Кратен Читател', 'P1');
  const b = mkBook(1501, { price: 5 });
  const lid = mkLoan(r, b, T, E.addDays(T, 14));
  await h.go('circ');
  await h.window.lostLoanDialog(lid);
  await h.waitFor(() => h.$('#lostF'), 'прозорецът');
  await h.clickButton('Промени правилото…', '#modal');
  await h.waitFor(() => h.$('#lostPolF'), 'правилото');
  const inp = h.$('#lostPolF [name=multiplier]');
  assert.equal(inp.type, 'text', 'десетично поле, не type=number');
  h.type('#lostPolF [name=multiplier]', '1,5');
  await h.clickButton('Запази правилото', '#modal2');
  await h.settle();
  assert.equal(q('SELECT lost_price_multiplier AS m FROM settings WHERE id = 1').m, 1.5);
  await h.waitFor(() => h.$('#lostF [name=amount]'), 'прозорецът отново');
  assert.equal(h.$('#lostF [name=amount]').value, '7.50', 'предложението е 1,5 × 5 € = 7,50 €, не 75 €');
  h.window.closeModal(); await h.settle();
  /* И самият канал (loans:lostPolicySave) чете запетаята — вика се и отвън, не
     само от формата (която вече праща „1.5“). Number('2,5') е NaN: без
     поправката това е отказ „Кратността трябва да е положително число“. */
  const pol = await h.api.loans.lostPolicySave({ multiplier: '2,5', fallback: '10' });
  assert.equal(pol.ok, true, 'каналът отказа „2,5“: ' + pol.error);
  assert.equal(q('SELECT lost_price_multiplier AS m FROM settings WHERE id = 1').m, 2.5);
});
