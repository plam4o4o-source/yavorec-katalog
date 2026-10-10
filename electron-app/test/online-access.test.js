// Тестове на online-access.js (v2.4.76) — чистата част на онлайн достъпа за
// читатели: хеш/проверка на ПИН, кодът за активация, снимката за моста и
// изпращането. Кодът за активация се проверява с ключ, създаден в самия тест
// (verifyActivation приема ключ през opts.publicKey) — истинският частен ключ
// е само у разработчика.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const oa = require('../online-access');
const { localDate } = require('../local-date');

/* Подписан код в точния вид от договора: base64url(JSON) . base64url(подпис). */
function makeToken(privateKey, payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(p), privateKey).toString('base64url');
  return p + '.' + sig;
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const { privateKey: otherKey } = crypto.generateKeyPairSync('ed25519');

test('hashPin: формат scrypt$16384$8$1$<сол>$<хеш> и различна сол при всяко издаване', () => {
  const h = oa.hashPin('123456');
  const parts = h.split('$');
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ['scrypt', '16384', '8', '1']);
  assert.equal(Buffer.from(parts[4], 'base64').length, 16, 'солта е 16 байта');
  assert.equal(Buffer.from(parts[5], 'base64').length, 32, 'хешът е 32 байта');
  assert.notEqual(oa.hashPin('123456'), h, 'нова сол при всяко издаване');
  /* Същото, което ще смята мостът от полетата на низа. */
  const expected = crypto.scryptSync('123456', Buffer.from(parts[4], 'base64'), 32, { N: 16384, r: 8, p: 1 });
  assert.equal(expected.toString('base64'), parts[5]);
});

test('verifyPin: верният ПИН минава, грешният и повреденият хеш — не', () => {
  const h = oa.hashPin('000042');
  assert.equal(oa.verifyPin('000042', h), true);
  assert.equal(oa.verifyPin('000043', h), false);
  assert.equal(oa.verifyPin('000042', ''), false);
  assert.equal(oa.verifyPin('000042', 'bcrypt$x'), false);
  assert.equal(oa.verifyPin('000042', h.replace(/\$[^$]+$/, '$AAAA')), false);
});

test('hashPin отказва всичко, което не е 6 цифри', () => {
  for (const bad of ['12345', '1234567', 'abcdef', '', null]) assert.throws(() => oa.hashPin(bad));
});

test('generatePin: винаги 6 цифри, включително с водещи нули', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = oa.generatePin();
    assert.match(p, /^\d{6}$/);
    seen.add(p);
  }
  assert.ok(seen.size > 150, 'случайни, не повтарящи се');
});

test('verifyActivation: валиден код връща lib/name/exp', () => {
  const t = makeToken(privateKey, { lib: 'yavorec', name: 'Библиотека Яворец', exp: '2099-12-31', iat: 1 });
  const r = oa.verifyActivation(t, 'yavorec', { publicKey });
  assert.equal(r.ok, true);
  assert.equal(r.lib, 'yavorec');
  assert.equal(r.name, 'Библиотека Яворец');
  assert.equal(r.exp, '2099-12-31');
  assert.equal(r.error, null);
  /* Без очакван код — връща кода от товара. */
  assert.equal(oa.verifyActivation(t, null, { publicKey }).lib, 'yavorec');
});

test('verifyActivation: чужд ключ, друга библиотека, изтекъл срок, повреден низ', () => {
  const good = { lib: 'yavorec', name: 'x', exp: '2099-12-31', iat: 1 };
  assert.equal(oa.verifyActivation(makeToken(otherKey, good), 'yavorec', { publicKey }).ok, false, 'чужд подпис');
  const other = oa.verifyActivation(makeToken(privateKey, { ...good, lib: 'druga' }), 'yavorec', { publicKey });
  assert.equal(other.ok, false);
  assert.match(other.error, /друга библиотека/);
  const expired = oa.verifyActivation(makeToken(privateKey, { ...good, exp: '2020-01-01' }), 'yavorec', { publicKey });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /изтекъл/);
  /* Точно днес — още важи (exp >= днес). */
  assert.equal(oa.verifyActivation(makeToken(privateKey, { ...good, exp: localDate() }), 'yavorec', { publicKey }).ok, true);
  /* Пипнат товар след подписването — подписът вече не отговаря. */
  const t = makeToken(privateKey, good);
  const tampered = Buffer.from(JSON.stringify({ ...good, exp: '2199-01-01' })).toString('base64url') + '.' + t.split('.')[1];
  assert.equal(oa.verifyActivation(tampered, 'yavorec', { publicKey }).ok, false);
  for (const bad of ['', null, 'abc', 'a.b', 'a.b.c']) {
    const r = oa.verifyActivation(bad, 'yavorec', { publicKey });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  }
});

test('verifyActivation с вградения ключ: код, подписан с друг ключ, не минава', () => {
  const t = makeToken(privateKey, { lib: 'yavorec', name: 'x', exp: '2099-12-31', iat: 1 });
  assert.equal(oa.verifyActivation(t, 'yavorec').ok, false);
  /* Вграденият ключ е точно този от договора. */
  assert.equal(oa.ACTIVATION_PUBLIC_KEY_B64, 'MCowBQYDK2VwAyEAt+SQX8FBNWio/sP+A+eJocdPkgXA0hBUVOc7KpgLkn8=');
});

/* ---------------- Снимката ---------------- */
function freshDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}
function seed(db) {
  const ins = db.prepare(`INSERT INTO readers (name, card_no, phone, egn, address, category, registered_at, re_registered_at, status,
    gdpr_consent, online_consent, online_pin_hash, suspended_until)
    VALUES (@name, @card_no, @phone, @egn, @address, @category, @registered_at, @re_registered_at, @status,
    1, @online_consent, @online_pin_hash, @suspended_until)`);
  const base = { phone: '0888', egn: '1234567890', address: 'ул. Х', category: 'възрастен', re_registered_at: null, status: 'активен', suspended_until: null };
  const h = oa.hashPin('111111');
  const ids = {};
  ids.active = ins.run({ ...base, name: 'Иван Иванов', card_no: 'R-0042', registered_at: '2020-03-15', re_registered_at: localDate(), online_consent: 1, online_pin_hash: h }).lastInsertRowid;
  ids.noConsent = ins.run({ ...base, name: 'Без Съгласие', card_no: 'R-0001', registered_at: '2020-01-01', online_consent: 0, online_pin_hash: h }).lastInsertRowid;
  ids.noPin = ins.run({ ...base, name: 'Без ПИН', card_no: 'R-0002', registered_at: '2020-01-01', online_consent: 1, online_pin_hash: null }).lastInsertRowid;
  ids.expired = ins.run({ ...base, name: 'Изтекла Карта', card_no: 'R-0003', registered_at: '2020-01-01', online_consent: 1, online_pin_hash: h }).lastInsertRowid;
  ids.suspended = ins.run({ ...base, name: 'Наказан', card_no: 'R-0004', registered_at: localDate(), online_consent: 1, online_pin_hash: h, suspended_until: '2099-01-01' }).lastInsertRowid;
  const bookIns = db.prepare("INSERT INTO books (inv_number, title, author) VALUES (?, ?, ?)");
  const invIns = db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)');
  const book = (inv, title, author) => { const id = bookIns.run(inv, title, author).lastInsertRowid; invIns.run(id); return id; };
  const b1 = book(156, 'Под игото', 'Иван Вазов');
  const b2 = book(157, 'Немили-недраги', 'Иван Вазов');
  const b3 = book(158, 'Чичовци', 'Иван Вазов');
  const loan = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in, renewals, lost) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ids.openLoan = loan.run(ids.active, b1, '2026-09-12', '2026-10-03', null, 0, null).lastInsertRowid;
  ids.returnedLoan = loan.run(ids.active, b2, '2026-08-01', '2026-08-31', '2026-08-20', 1, null).lastInsertRowid;   // върната — не влиза в loans, влиза в history
  ids.lostLoan = loan.run(ids.active, b3, '2026-07-01', '2026-07-31', '2026-09-01', 0, 1).lastInsertRowid;          // изгубена (затворена) — не влиза в loans
  return ids;
}

test('buildSnapshot: само читатели със съгласие И ПИН; без ЕГН/адрес/телефон; отворени заемания с инв. №', () => {
  const db = freshDb();
  const ids = seed(db);
  const token = makeToken(privateKey, { lib: 'yavorec', name: 'x', exp: '2099-12-31', iat: 1 });
  const settings = { lib_name: 'Библиотека при НЧ', online_activation: token };
  const snap = oa.buildSnapshot(db, settings, '2026-09-30T10:00:00Z');
  assert.equal(snap.generated, '2026-09-30T10:00:00Z');
  assert.equal(snap.activation, token);
  assert.equal(snap.libraryName, 'Библиотека при НЧ');
  /* library идва от ПОДПИСАНИЯ код — с вградения ключ този тестов код не минава,
     затова тук е празно; истинският код на библиотеката го попълва. */
  assert.equal(snap.library, '');
  const cards = snap.readers.map(r => r.cardNumber).sort();
  assert.deepEqual(cards, ['R-0003', 'R-0004', 'R-0042']);
  const a = snap.readers.find(r => r.cardNumber === 'R-0042');
  assert.equal(a.readerId, String(ids.active));
  assert.equal(a.fullName, 'Иван Иванов');
  assert.equal(a.category, 'възрастен');
  assert.equal(a.registeredOn, '2020-03-15');
  assert.equal(a.validUntil, oa.addOneYear(localDate()), 'пререгистрация + 1 година');
  assert.equal(a.status, 'active');
  assert.match(a.pinHash, /^scrypt\$16384\$8\$1\$/);
  assert.deepEqual(a.loans, [{
    loanId: String(ids.openLoan), inv: 156, title: 'Под игото', author: 'Иван Вазов',
    dateOut: '2026-09-12', dateDue: '2026-10-03', renewals: 0,
    canRenew: false   // без подадена врата (opts.canRenew) — „на гишето“
  }]);
  /* v2.4.81: историята — само ПРИКЛЮЧЕНИТЕ заемания, най-новите първи (и
     изгубеното е приключено с date_in); само документът и датите. */
  assert.deepEqual(a.history, [
    { loanId: String(ids.lostLoan), inv: 158, title: 'Чичовци', author: 'Иван Вазов', dateOut: '2026-07-01', dateIn: '2026-09-01' },
    { loanId: String(ids.returnedLoan), inv: 157, title: 'Немили-недраги', author: 'Иван Вазов', dateOut: '2026-08-01', dateIn: '2026-08-20' }
  ]);
  assert.deepEqual(snap.readers.find(r => r.cardNumber === 'R-0003').history, []);
  assert.equal(snap.readers.find(r => r.cardNumber === 'R-0003').status, 'expired');
  assert.equal(snap.readers.find(r => r.cardNumber === 'R-0004').status, 'suspended');
  /* Нищо от чл. 42, ал. 3 не напуска компютъра. */
  const text = JSON.stringify(snap);
  for (const secret of ['1234567890', 'ул. Х', '0888', 'egn', 'phone', 'address', 'email', 'id_card']) {
    assert.ok(!text.includes(secret), 'снимката не бива да съдържа: ' + secret);
  }
});

test('buildSnapshot: canRenew идва от подадената врата (opts.canRenew) с реда на заемането; грешка в нея = false', () => {
  const db = freshDb();
  const ids = seed(db);
  const seen = [];
  let snap = oa.buildSnapshot(db, {}, '2026-09-30T10:00:00Z', { canRenew: (l) => { seen.push(l); return true; } });
  const a = snap.readers.find(r => r.cardNumber === 'R-0042');
  assert.equal(a.loans[0].canRenew, true);
  assert.equal(seen.length, 1);
  /* Вратата получава онова, което ѝ трябва: читател, документ, срок, брой продължения. */
  assert.equal(seen[0].reader_id, ids.active);
  assert.ok(seen[0].book_id > 0);
  assert.equal(seen[0].date_due, '2026-10-03');
  assert.equal(seen[0].renewals, 0);
  assert.equal(seen[0].date_in, null);
  snap = oa.buildSnapshot(db, {}, '2026-09-30T10:00:00Z', { canRenew: () => { throw new Error('x'); } });
  assert.equal(snap.readers.find(r => r.cardNumber === 'R-0042').loans[0].canRenew, false, 'грешка във вратата не спира снимката');
});

test('buildSnapshot: историята е до 200 приключени заемания, най-новите първи', () => {
  const db = freshDb();
  const ids = seed(db);
  const b = db.prepare("INSERT INTO books (inv_number, title, author) VALUES (?, ?, ?)").run(900, 'Стара', 'Х').lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(b);
  const ins = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 250; i++) {
    const d = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
    ins.run(ids.active, b, d, d, d);
  }
  const a = oa.buildSnapshot(db, {}, '2026-09-30T10:00:00Z').readers.find(r => r.cardNumber === 'R-0042');
  assert.equal(a.history.length, oa.HISTORY_LIMIT);
  assert.equal(oa.HISTORY_LIMIT, 200);
  assert.equal(a.history[0].dateIn, '2026-09-01', 'най-новото приключване е първо');
  for (let i = 1; i < a.history.length; i++) assert.ok(a.history[i - 1].dateIn >= a.history[i].dateIn);
  assert.equal(a.loans.length, 1, 'отворените заемания не са в историята');
  const text = JSON.stringify(a.history);
  for (const k of ['egn', 'phone', 'address', 'reader_id', 'fine']) assert.ok(!text.includes(k), 'историята не носи ' + k);
});

test('buildSnapshot: без нито един съгласил се читател — readers: [] (валидно; мостът трие данните)', () => {
  const db = freshDb();
  const snap = oa.buildSnapshot(db, {}, '2026-09-30T10:00:00Z');
  assert.deepEqual(snap.readers, []);
});

test('buildSnapshot: криптирано име (ако някога се пази така) излиза като null, не като шифротекст', () => {
  const db = freshDb();
  const { FIELD_PREFIX } = require('../pii-crypto');
  db.prepare("INSERT INTO readers (name, card_no, registered_at, gdpr_consent, online_consent, online_pin_hash) VALUES (?, ?, ?, 1, 1, ?)")
    .run(FIELD_PREFIX + 'AAAA', 'R-9', localDate(), oa.hashPin('222222'));
  const snap = oa.buildSnapshot(db, {}, '2026-09-30T10:00:00Z');
  assert.equal(snap.readers.length, 1);
  assert.equal(snap.readers[0].fullName, null);
});

/* ---------------- Лични съобщения (v2.4.82) ---------------- */
test('buildSnapshot: messages — най-новите първи, до 50, без оттеглените и по-старите от 180 дни; само за читателите от снимката', () => {
  const db = freshDb();
  const ids = seed(db);
  const now = '2026-10-10T12:00:00.000Z';
  const ins = db.prepare('INSERT INTO reader_messages (reader_id, title, body, created_at, read_at, withdrawn_at) VALUES (?, ?, ?, ?, ?, ?)');
  const at = (daysAgo, h) => new Date(Date.parse(now) - daysAgo * 86400000 - (h || 0) * 3600000).toISOString();
  const fresh = ins.run(ids.active, 'Запазена книга', 'Книгата пристигна, вземете я до петък.', at(1), null, null).lastInsertRowid;
  const read = ins.run(ids.active, null, 'Прочетено вече.', at(2), '2026-10-09T08:00:00.000Z', null).lastInsertRowid;
  ins.run(ids.active, 'Оттеглено', 'Не трябва да пътува.', at(0, 1), null, '2026-10-10T11:00:00.000Z');
  const edge = ins.run(ids.active, null, 'Точно 179 дни.', at(179), null, null).lastInsertRowid;
  ins.run(ids.active, null, 'Твърде старо.', at(181), null, null);
  ins.run(ids.noPin, 'Без ПИН', 'Не е в снимката.', at(1), null, null);
  const snap = oa.buildSnapshot(db, {}, now);
  const a = snap.readers.find(r => r.cardNumber === 'R-0042');
  assert.deepEqual(a.messages, [
    { messageId: String(fresh), title: 'Запазена книга', text: 'Книгата пристигна, вземете я до петък.', at: at(1), readAt: null },
    { messageId: String(read), title: '', text: 'Прочетено вече.', at: at(2), readAt: '2026-10-09T08:00:00.000Z' },
    { messageId: String(edge), title: '', text: 'Точно 179 дни.', at: at(179), readAt: null }
  ]);
  assert.deepEqual(snap.readers.find(r => r.cardNumber === 'R-0003').messages, [], 'читател без съобщения — празен масив');
  assert.ok(!JSON.stringify(snap).includes('Не е в снимката'), 'читател без ПИН не е в снимката, нито съобщенията му');
  assert.equal(oa.MESSAGES_MAX_AGE_DAYS, 180);
});

test('buildSnapshot: messages — най-много 50; без таблицата (по-стара база) снимката не пада', () => {
  const db = freshDb();
  const ids = seed(db);
  const ins = db.prepare('INSERT INTO reader_messages (reader_id, body, created_at) VALUES (?, ?, ?)');
  for (let i = 0; i < 60; i++) ins.run(ids.active, 'Съобщение ' + i, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
  const a = oa.buildSnapshot(db, {}, '2026-10-10T12:00:00.000Z').readers.find(r => r.cardNumber === 'R-0042');
  assert.equal(oa.MESSAGES_LIMIT, 50);
  assert.equal(a.messages.length, 50);
  assert.equal(a.messages[0].text, 'Съобщение 59', 'най-новото първо');
  assert.equal(a.messages[49].text, 'Съобщение 10');
  db.exec('DROP TABLE reader_messages');
  const b = oa.buildSnapshot(db, {}, '2026-10-10T12:00:00.000Z').readers.find(r => r.cardNumber === 'R-0042');
  assert.deepEqual(b.messages, []);
});

/* ---------------- Изпращане ---------------- */
test('sendSnapshot: заглавки и адрес по договора; 200 → ok', async () => {
  let seen = null;
  const fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const body = { library: 'yavorec', readers: [] };
  const r = await oa.sendSnapshot('https://chyavorec.org/api/invlib/', 'yavorec', 'KEY123', body, { fetch, version: '2.4.76' });
  /* v2.4.83: и features/needFull от отговора (мост без тях → null/false — по
     стария начин) и размерът на изпратеното тяло. */
  assert.deepEqual(r, { ok: true, status: 200, error: null, requests: [], features: null, needFull: false,
    bytes: Buffer.byteLength(JSON.stringify(body)) });
  assert.equal(seen.init.headers['Content-Encoding'], undefined, 'без opts.gzip — чист JSON, без компресия');
  assert.equal(seen.url, 'https://chyavorec.org/api/invlib/yavorec/sync');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer KEY123');
  assert.equal(seen.init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(seen.init.headers['User-Agent'], 'InvLib/2.4.76');
  assert.equal(seen.init.body, JSON.stringify(body));
  assert.ok(seen.init.signal, 'има сигнал за прекъсване (таймаут)');
});

test('sendSnapshot: заявките на читателите от отговора на моста; тяло без JSON или без масив = няма заявки', async () => {
  const reqs = [{ id: 'q1', type: 'renew', readerId: '1', cardNumber: 'R-1', loanId: '5', inv: 156, at: '2026-09-30T10:00:00Z' }];
  let r = await oa.sendSnapshot('https://x.org/api', 'lib', 'k', {}, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, requests: reqs }) }) });
  assert.deepEqual(r.requests, reqs);
  r = await oa.sendSnapshot('https://x.org/api', 'lib', 'k', {}, { fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) });
  assert.deepEqual(r, { ok: true, status: 200, error: null, requests: [], features: null, needFull: false, bytes: 2 });
  r = await oa.sendSnapshot('https://x.org/api', 'lib', 'k', {}, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ requests: 'x' }) }) });
  assert.deepEqual(r.requests, []);
});

test('sendSnapshot: 401/403/413/422 и мрежова грешка — { ok:false }, никога не хвърля', async () => {
  const mk = (status) => async () => ({ ok: false, status, json: async () => ({ error: 'x', message: 'подробност' }) });
  for (const st of [401, 403, 413, 422, 500]) {
    const r = await oa.sendSnapshot('https://x.org/api', 'lib', 'k', {}, { fetch: mk(st) });
    assert.equal(r.ok, false);
    assert.equal(r.status, st);
    assert.ok(r.error && r.error.includes('подробност'), r.error);
  }
  const net = await oa.sendSnapshot('https://x.org/api', 'lib', 'k', {}, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(net.ok, false);
  assert.equal(net.status, 0);
  assert.match(net.error, /ECONNREFUSED/);
  /* Без https, без ключ, без код — отказ преди каквато и да е заявка. */
  let called = 0;
  const spy = async () => { called++; return { ok: true, status: 200 }; };
  assert.equal((await oa.sendSnapshot('http://x.org', 'lib', 'k', {}, { fetch: spy })).ok, false);
  assert.equal((await oa.sendSnapshot('https://x.org', 'lib', '', {}, { fetch: spy })).ok, false);
  assert.equal((await oa.sendSnapshot('https://x.org', '', 'k', {}, { fetch: spy })).ok, false);
  assert.equal(called, 0);
});

test('sendSnapshot: таймаутът прекъсва заявката', async () => {
  const fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const r = await oa.sendSnapshot('https://x.org/api', 'lib', 'k', {}, { fetch, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.match(r.error, /не отговори/);
});
