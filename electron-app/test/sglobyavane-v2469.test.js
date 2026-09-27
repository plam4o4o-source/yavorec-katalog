'use strict';
/* v2.4.69 — кръг 44, СГЛОБЯВАНЕТО МЕЖДУ ОБЛАСТИТЕ.
   =====================================================================
   Шестте области на кръга (фонд, гише, отчисляване/телефон, печат, каталог/МЗС,
   краезнание/дневник) бяха поправени от отделни хора, всеки в своите файлове.
   Където една поправка изискваше ред в ЧУЖД файл, той беше описан в доклада и
   вързан накрая, при сглобяването. Тези връзки са точно мястото, където нещо
   може тихо да не стигне до целта: модулът е поправен и тестът му минава (защото
   тестът сам подава зависимостта), а истинската програма никога не я подава.
   Затова тук всяка връзка се проверява през ИСТИНСКИЯ main.js и истинския екран.

   Всеки тест е проверен с връщане на връзката назад: без нея пада. */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('./helpers/e2e-app');

let h = null;
const T = E.today();
const Y = T.slice(0, 4);
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + res.error); return res.data; };
const APP = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

function mkBook(inv, o = {}) {
  const id = Number(h.db.prepare(`INSERT INTO books (inv_number, title, author, barcode, price, status, register_date, udk, author_mark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(inv, o.title || ('Книга ' + inv), o.author || 'Автор, А.', 'SG' + inv, 10, o.status || 'наличен', '2026-01-05',
      o.udk || null, o.author_mark || null).lastInsertRowid);
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, o.qty || 1);
  return id;
}
function mkReader(name, card) {
  return Number(h.db.prepare(`INSERT INTO readers (name, card_no, category, status, gdpr_consent, gdpr_consent_date, registered_at)
    VALUES (?, ?, 'възрастен', 'активен', 1, '2026-01-02', ?)`).run(name, card, T).lastInsertRowid);
}

/* К8 — НАШ ДОКУМЕНТ, ИЗПРАТЕН ПО МЗС, НЕ СЕ ЗАЕМА НА ГИШЕТО.
   Правилото живее в handlers/mzs.js (mzsBlockForBook), а заемането — в
   handlers/loans.js (checkoutStatusGate). Връзката между двете е сглобяването. */
test('К8 — документ при друга библиотека по МЗС: и двете врати за заемане отказват с думи', async () => {
  const b = mkBook(8801, { title: 'Изпратена по МЗС' });
  const r = mkReader('Гише МЗС', 'SG-8801');
  h.db.prepare(`INSERT INTO mzs_requests (no, year, date, direction, partner, title, status, book_id, date_sent, due_date)
    VALUES (1, ?, ?, 'входящо', 'РБ „Съседно село“', 'Изпратена по МЗС', 'изпратено', ?, ?, ?)`)
    .run(Y, T, b, T, E.addDays(T, 20));
  const byCode = await h.api.loans.checkoutByCode({ reader_id: r, code: 'SG8801', date_out: T });
  assert.equal(byCode.ok, false, 'заемането по код трябва да е отказано');
  assert.match(byCode.error, /МЗС|междубиблиотечн|Съседно село/i, 'отказът казва защо: ' + byCode.error);
  const byId = await h.api.loans.checkout({ reader_id: r, book_id: b, date_out: T });
  assert.equal(byId.ok, false, 'и заемането по id');
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE book_id = ?', b).n, 0, 'нито едно заемане не е записано');
  // Щом се върне от другата библиотека, книгата пак се заема.
  h.db.prepare("UPDATE mzs_requests SET status = 'върнато', date_returned = ? WHERE book_id = ?").run(T, b);
  ok(await h.api.loans.checkoutByCode({ reader_id: r, code: 'SG8801', date_out: T }), 'след връщането');
});

/* К6 — ПРОСРОЧЕНОТО ПО МЗС СТОИ НА ТАБЛОТО. */
test('К6 — получена чужда книга с изтекъл срок се вижда на таблото', async () => {
  h.db.prepare(`INSERT INTO mzs_requests (no, year, date, direction, partner, title, status, date_received, due_date)
    VALUES (2, ?, ?, 'изходящо', 'РБ „Далечно“', 'Чужда просрочена', 'получено', ?, ?)`)
    .run(Y, E.addDays(T, -40), E.addDays(T, -35), E.addDays(T, -10));
  await h.go('dash');
  await h.waitFor(() => /МЗС — изтекъл срок за връщане: \d+/.test(h.$('#dashMzs').textContent), 'бележката за МЗС');
  assert.match(h.$('#dashMzs').textContent, /Чужда просрочена/, 'назовава книгата');
});

/* Л3 / Г11 — ВРЪЩАНЕТО НА НАМЕРЕН ДОКУМЕНТ НЕ Е ПОСЕЩЕНИЕ. */
test('Л3 — „Документът се намери“ пише връщане с бележка „намерен документ“ и ⚡ не го брои за посещение', async () => {
  const b = mkBook(8802);
  const r = mkReader('Намерен Документ', 'SG-8802');
  const lid = ok(await h.api.loans.checkout({ reader_id: r, book_id: b, date_out: E.addDays(T, -60) }), 'заемане');
  h.db.prepare('UPDATE loans SET date_due = ? WHERE id = ?').run(E.addDays(T, -30), lid);
  const quote = ok(await h.api.loans.lostQuote({ id: lid }), 'предложение');
  ok(await h.api.loans.markLost({ id: lid, resolution: 'обезщетение', amount: quote.suggested, date: E.addDays(T, -5) }), 'изгубен');
  const deskOf = (sug) => Number(sug && sug.sectionA ? sug.sectionA.visitHomeDesk : NaN);
  /* dnevnik:suggest приема { date } (както го вика екранът). Подаден като голия низ
     T, каналът не вижда дата и брои събитията „за никой ден“ — 0 преди и 0 след,
     тоест равенството по-долу минаваше и без поправката. Затова и: преди
     намирането днес вече има посещение (заемането от К8 по-горе) — числото не е
     празно. */
  const before = deskOf(ok(await h.api.dnevnik.suggest({ date: T }), 'предложението преди'));
  assert.ok(Number.isFinite(before), 'предложението връща броя на гишето');
  assert.ok(before >= 1, 'предложението е за днес и вече брои заемането на гишето (' + before + ')');
  ok(await h.api.loans.found({ id: lid, reverseCharge: true, date: T }), 'намери се');
  const ev = q("SELECT note FROM events WHERE kind = 'връщане' AND book_id = ? AND reader_id = ?", b, r);
  assert.ok(ev, 'има събитие „връщане“');
  assert.match(String(ev.note || ''), /намерен документ/, 'бележката: ' + ev.note);
  const after = deskOf(ok(await h.api.dnevnik.suggest({ date: T }), 'предложението след'));
  assert.equal(after, before, 'намереният документ не добавя посещение на гишето');
});

/* Е5 — ПОДПИСИТЕ НА КОМИСИЯТА: ВСЕКИ НА СВОЯ ЛИНИЯ, С ИМЕТО СИ. */
test('Е5 — актът за дарение: тримата от комисията подписват на три линии, с имената от партидата', async () => {
  const id = Number(h.db.prepare(`INSERT INTO acquisitions (no, year, date, how, from_source, doc_type, doc_no, doc_date,
      total_count, sum, donor_address, committee1, committee2, committee3)
    VALUES (77, ?, ?, 'дарение', 'Дарител Добров', 'акт', '77', ?, 1, 10, 'с. Пример, ул. Първа 1', 'Мария Иванова', 'Петър Петров', 'Иван Стоянов')`)
    .run(Y, T, T).lastInsertRowid);
  await h.window.printDonationDoc(id);
  await h.settle();
  const doc = h.window.document.querySelector('#ppSheet') || h.window.document.body;
  const lines = [...doc.querySelectorAll('.psig > div')].map(d => d.textContent.trim());
  assert.ok(lines.some(t => /^Комисия: 1\. Мария Иванова$/.test(t)), 'първата линия: ' + JSON.stringify(lines));
  assert.ok(lines.includes('2. Петър Петров'), 'втората линия: ' + JSON.stringify(lines));
  assert.ok(lines.includes('3. Иван Стоянов'), 'третата линия: ' + JSON.stringify(lines));
  assert.ok(!lines.some(t => /Мария Иванова.*Петър Петров/.test(t)), 'двама на една линия — не');
  h.window.ppClose();
  // Протоколът от инвентаризация и актът за отчисляване ползват същото.
  assert.match(src('src/views/inventory-sessions.js'), /commissionSig\(\[s\.committee1, s\.committee2, s\.committee3\]\)/);
  assert.match(src('src/views/deaccession-acts.js'), /commissionSig\(\[a\.committee1, a\.committee2, a\.committee3\]\)/);
});

/* Е10 — „135.0 документа“ И ИМЕТО НА PDF-а НА ИНВЕНТАРНАТА КНИГА. */
test('Е10 — нормативът се пише „135“ и „12,5“, не „135.0“ и „12.5“', async () => {
  assert.equal(h.window.lossFmt(135), '135');
  assert.equal(h.window.lossFmt(12.5), '12,5');
  assert.equal(h.window.lossFmt(0), '0');
});
test('Е10 — PDF-ът на инвентарната книга се казва по отпечатаната година, не по днешната дата', async () => {
  mkBook(8803);
  await h.go('invbook');
  await h.window.printInvBookDoc({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });
  await h.settle();
  const name = h.window.eval('PRINT_DOC_NAME');
  assert.match(name, /01\.01\.2026.*31\.12\.2026/, 'името носи обхвата: ' + name);
  assert.ok(!name.includes(E.bgDate(T)) || /31\.12\.2026/.test(name), 'не е „— днешна дата“');
  h.window.ppClose();
});

/* Л6 — КАРТОНЪТ НА КНИГА ПОКАЗВА КОЙ СОЧИ КЪМ НЕЯ. */
test('Л6 — картонът на книга показва персоналията, която сочи към нея', async () => {
  const b = mkBook(8804, { title: 'Цитирана книга' });
  const p = ok(await h.api.persons.create({ name: 'Краеведов, Стоян', years: '1900–1980' }), 'персоналия');
  const pid = typeof p === 'object' && p ? (p.id || p.lastInsertRowid) : p;
  ok(await h.api.links.add({ fromKind: 'персона', fromId: pid, toKind: 'книга', toId: b }), 'връзка');
  await h.window.bookForm(b);
  await h.waitFor(() => /Краеведов/.test(h.modal()), 'панелът с обратните връзки');
  h.window.closeModal();
});

/* К7 — БЕЛЕЖКАТА ЗА МЗС СЛЕД ЗАЛИЧАВАНЕ СЕ ПОКАЗВА. */
test('К7 — след заличаване по чл. 17 екранът показва бележката за подобни имена в МЗС', async () => {
  const r = mkReader('Заличен Мезесов', 'SG-8807');
  await h.go('readers');
  const real = h.window.api.gdpr.forgetReader;
  h.window.api.gdpr.forgetReader = async () => ({ ok: true, data: { name: 'Заличен Мезесов', auditCleared: 0,
    holdsActivated: [], mzsNote: 'В регистъра на МЗС остават 2 заявки с подобно име — прегледайте ги.' } });
  h.hooks.confirmAnswer = true;
  const n = h.toastsSince ? h.toastsSince(0).length : 0;
  try {
    await h.window.forgetReader(r);
    await h.settle();
  } finally { h.window.api.gdpr.forgetReader = real; }
  assert.ok(h.toastsSince(n).some(t => /остават 2 заявки с подобно име/.test(t.msg)), 'бележката е показана');
});

/* К2 / К8 / Г5 — ЗАВИСИМОСТИТЕ СЕ ПОДАВАТ ОТ main.js. Тестовете на всеки модул
   подават функцията сами; тук се проверява, че истинската програма я подава.
   (Форма на кода, по образеца на perf-v2431: без това поправката стои в модула,
   тестът ѝ минава, а в работещата програма katalog.json не се обновява.) */
test('К2/К8/Г5 — main.js подава scheduleCatalogWrite и activateHoldOnReturn на модулите, които ги ползват', () => {
  const m = src('main.js');
  const reg = (mod) => {
    const i = m.indexOf(`require('./handlers/${mod}')(ipcMain,`);
    assert.ok(i > 0, 'регистрацията на ' + mod);
    return m.slice(i, m.indexOf('});', i) + 3);
  };
  for (const mod of ['categories', 'authorities', 'av', 'mzs', 'data-import', 'inventory-sessions', 'mobile', 'holds', 'gdpr']) {
    assert.match(reg(mod), /scheduleCatalogWrite/, mod + ' получава scheduleCatalogWrite');
  }
  assert.match(reg('readers'), /activateHoldOnReturn/, 'readers получава activateHoldOnReturn');
});

/* П4 — cn_sort ЗА КНИГИ, ОПИСАНИ САМО С УДК И АВТОРСКИ ЗНАК. */
test('П4 — подредбата по сигнатура знае и за книга без попълнено поле „Сигнатура“', () => {
  const m = src('main.js');
  assert.match(m, /cnSortKey\(effectiveCallNumber\(b\)\)/, 'ключът е по общото правило');
  assert.match(m, /TRIM\(COALESCE\(udk, ''\)\) <> ''/, 'и книгите само с УДК влизат в попълването');
});

/* К11 — НИТО ЕДНО СЪОБЩЕНИЕ НЕ СОЧИ НЕСЪЩЕСТВУВАЩИЯ БУТОН „РЪЧЕН ЗАПИС“. */
test('К11 — съобщенията на предпазителя не сочат бутон „Ръчен запис“', () => {
  for (const f of ['handlers/books.js', 'handlers/deaccession-acts.js', 'main.js', 'handlers/catalog.js']) {
    const code = src(f).split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l) && !/^\s*[А-Яа-я].*\*\/\s*$/.test(l));
    const hits = code.filter(l => /Използвайте „Ръчен запис“|натиснете „Ръчен запис“/.test(l));
    assert.deepEqual(hits, [], f + ': ' + hits.join(' | '));
  }
});

/* К4 — ОТКАЗАНА РЕЗЕРВАЦИЯ НАСРОЧВА ЗАПИС НА КАТАЛОГА. */
test('К4 — отказът на заделена резервация насрочва запис на онлайн каталога (като циркулация)', () => {
  const Database = require('better-sqlite3');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-holds-'));
  try {
    const db = new Database(path.join(dir, 'l.db'));
    db.exec(src('db/schema.sql'));
    const handlers = new Map();
    const calls = [];
    require('../handlers/holds')({ handle: (c, fn) => handlers.set(c, fn) }, {
      getDb: () => db,
      run: (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } },
      logAudit: () => {}, normalizeScanCode: (s) => s,
      scheduleCatalogWrite: (k) => calls.push(k)
    });
    const b = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1, 'X', 'наличен')").run().lastInsertRowid;
    const r = db.prepare("INSERT INTO readers (name, card_no) VALUES ('Ч', 'C1')").run().lastInsertRowid;
    const hid = db.prepare("INSERT INTO holds (book_id, reader_id, status, ready_at) VALUES (?, ?, 'заделена', datetime('now'))").run(b, r).lastInsertRowid;
    const res = handlers.get('holds:cancel')({}, hid);
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(calls, ['circulation']);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
