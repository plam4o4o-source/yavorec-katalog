// Тестове на handlers/online-access.js (v2.4.76) — каналите online:* и
// насрочването. Най-важното: БЕЗ код за активация нищо не се насрочва, нищо
// не се праща и status връща само { activated: false } — това е гаранцията,
// че за всяка друга библиотека програмата е същата като преди.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const registerOnlineHandlers = require('../handlers/online-access');
const { createDebouncer } = require('../debounce');
const { localDate } = require('../local-date');
const { verifyPin } = require('../online-access');

/* Тестовете не излизат в мрежата: отложеното изпращане (debounce 30 ms) иначе
   стига до истинския chyavorec.org с фалшив ключ. Тестовете, на които им трябва
   fetch, го подменят сами и после връщат тази заглушка. */
const blockedFetches = [];
globalThis.fetch = async (url) => {
  blockedFetches.push(String(url));
  throw new Error('мрежата е изключена в тестовете');
};

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
function makeToken(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return p + '.' + crypto.sign(null, Buffer.from(p), privateKey).toString('base64url');
}
const GOOD = makeToken({ lib: 'yavorec', name: 'Библиотека Яворец', exp: '2099-12-31', iat: 1 });

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}
function setup(opts) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.prepare("UPDATE settings SET lib_name = 'Библиотека при НЧ' WHERE id = 1").run();   // schema.sql вече е засял ред 1
  const auditLog = [];
  const logs = [];
  const ipcMain = fakeIpcMain();
  const api = registerOnlineHandlers(ipcMain, {
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    today: () => localDate(),
    createDebouncer,
    debounceMs: (opts && opts.debounceMs) || 30,
    activationPublicKey: publicKey,
    getVersion: () => '2.4.76',
    log: (level, msg) => logs.push({ level, msg })
  });
  const readerId = db.prepare("INSERT INTO readers (name, card_no, registered_at, gdpr_consent) VALUES ('Иван Иванов', 'R-0042', ?, 1)")
    .run(localDate()).lastInsertRowid;
  const noGdpr = db.prepare("INSERT INTO readers (name, card_no, registered_at, gdpr_consent) VALUES ('Без Общо', 'R-0001', ?, 0)")
    .run(localDate()).lastInsertRowid;
  return { db, ipcMain, api, auditLog, logs, readerId, noGdpr };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('регистрира всички канали online:*', () => {
  const { ipcMain } = setup();
  for (const ch of ['online:status', 'online:activate', 'online:deactivate', 'online:updateSettings',
    'online:setReaderConsent', 'online:issuePin', 'online:revokePin', 'online:syncNow']) {
    assert.ok(ipcMain.has(ch), ch);
  }
});

test('БЕЗ активация: status е { activated:false }, каналите отказват, насрочването е празно', async () => {
  const { ipcMain, api, auditLog, readerId } = setup();
  assert.deepEqual(ipcMain.invoke('online:status'), { ok: true, data: { activated: false } });
  assert.equal(api.onlineActivated(), false);
  assert.equal(api.scheduleOnlineSync(), false, 'нищо не се насрочва');
  for (const [ch, arg] of [
    ['online:updateSettings', { online_bridge_url: 'https://x.org', online_upload_key: 'k' }],
    ['online:setReaderConsent', { readerId, consent: true }],
    ['online:issuePin', { readerId }],
    ['online:revokePin', { readerId }]
  ]) {
    const r = ipcMain.invoke(ch, arg);
    assert.equal(r.ok, false, ch);
    assert.match(r.error, /не е активиран/);
  }
  const sync = await ipcMain.invoke('online:syncNow');
  assert.equal(sync.ok, false);
  const bg = await api.syncOnline('тест');
  assert.equal(bg.skipped, true, 'фоновото изпращане също е празно');
  assert.equal(auditLog.length, 0, 'нито ред в одитната следа');
});

test('online:activate: грешен/чужд/изтекъл код се отказва и не записва нищо', () => {
  const { ipcMain, db } = setup();
  const otherKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const p = Buffer.from(JSON.stringify({ lib: 'yavorec', name: 'x', exp: '2099-12-31' })).toString('base64url');
  const foreign = p + '.' + crypto.sign(null, Buffer.from(p), otherKey).toString('base64url');
  for (const bad of ['', 'abc', foreign, makeToken({ lib: 'yavorec', name: 'x', exp: '2020-01-01' })]) {
    const r = ipcMain.invoke('online:activate', { token: bad });
    assert.equal(r.ok, false);
  }
  assert.equal(db.prepare('SELECT online_activation FROM settings WHERE id = 1').get().online_activation, null);
  assert.equal(ipcMain.invoke('online:status').data.activated, false);
});

test('online:activate с валиден код → status с данните на библиотеката; deactivate връща всичко назад', () => {
  const { ipcMain, api, auditLog } = setup();
  const r = ipcMain.invoke('online:activate', { token: GOOD });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { lib: 'yavorec', name: 'Библиотека Яворец', exp: '2099-12-31' });
  const st = ipcMain.invoke('online:status').data;
  assert.equal(st.activated, true);
  assert.equal(st.lib, 'yavorec');
  assert.equal(st.name, 'Библиотека Яворец');
  assert.equal(st.exp, '2099-12-31');
  assert.equal(st.bridgeUrl, '');
  assert.equal(st.hasUploadKey, false);
  assert.equal(st.consentingReaders, 0);
  assert.ok(!('uploadKey' in st) && !('online_upload_key' in st), 'ключът никога не се връща');
  assert.ok(auditLog.some(a => a.action === 'Онлайн достъп за читатели' && /активиран/.test(a.detail)));
  api.stopOnlineTimer();
  assert.equal(ipcMain.invoke('online:deactivate').ok, true);
  assert.deepEqual(ipcMain.invoke('online:status').data, { activated: false });
  assert.equal(api.scheduleOnlineSync(), false);
});

test('online:updateSettings: https задължително; празен ключ не трие записания; ключът не се връща', () => {
  const { ipcMain, db, auditLog } = setup();
  ipcMain.invoke('online:activate', { token: GOOD });
  assert.equal(ipcMain.invoke('online:updateSettings', { online_bridge_url: 'http://x.org', online_upload_key: 'k' }).ok, false);
  assert.equal(ipcMain.invoke('online:updateSettings', { online_bridge_url: 'https://chyavorec.org/api/invlib/', online_upload_key: 'SECRET-1' }).ok, true);
  let row = db.prepare('SELECT online_bridge_url, online_upload_key FROM settings WHERE id = 1').get();
  assert.equal(row.online_bridge_url, 'https://chyavorec.org/api/invlib');
  assert.equal(row.online_upload_key, 'SECRET-1');
  assert.equal(ipcMain.invoke('online:updateSettings', { online_bridge_url: 'https://chyavorec.org/api/invlib', online_upload_key: '' }).ok, true);
  row = db.prepare('SELECT online_upload_key FROM settings WHERE id = 1').get();
  assert.equal(row.online_upload_key, 'SECRET-1', 'празно поле = „не го сменяй“');
  const st = ipcMain.invoke('online:status').data;
  assert.equal(st.hasUploadKey, true);
  assert.ok(!JSON.stringify(st).includes('SECRET-1'));
  assert.ok(!auditLog.some(a => a.detail.includes('SECRET-1')), 'ключът не влиза в одитната следа');
});

test('съгласие → ПИН → отмяна: изисква общо съгласие; ПИН се връща веднъж, пази се само хеш; следата е без ПИН', () => {
  const { ipcMain, db, auditLog, readerId, noGdpr } = setup();
  ipcMain.invoke('online:activate', { token: GOOD });
  /* Без общо съгласие по чл. 47 — отказ. */
  const r0 = ipcMain.invoke('online:setReaderConsent', { readerId: noGdpr, consent: true });
  assert.equal(r0.ok, false);
  assert.match(r0.error, /чл\. 47/);
  /* ПИН преди съгласие — отказ. */
  assert.equal(ipcMain.invoke('online:issuePin', { readerId }).ok, false);
  const r1 = ipcMain.invoke('online:setReaderConsent', { readerId, consent: true, date: '2026-09-01' });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.data, { online_consent: 1, online_consent_date: '2026-09-01' });
  assert.equal(ipcMain.invoke('online:setReaderConsent', { readerId, consent: true, date: '2999-01-01' }).ok, false, 'бъдеща дата');
  const r2 = ipcMain.invoke('online:issuePin', { readerId });
  assert.equal(r2.ok, true);
  assert.match(r2.data.pin, /^\d{6}$/);
  assert.equal(r2.data.cardNumber, 'R-0042');
  const row = db.prepare('SELECT online_pin_hash, online_pin_set_at FROM readers WHERE id = ?').get(readerId);
  assert.match(row.online_pin_hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(row.online_pin_set_at, localDate());
  assert.equal(verifyPin(r2.data.pin, row.online_pin_hash), true);
  const issued = auditLog.find(a => a.action === 'Издаден ПИН за онлайн достъп');
  assert.ok(issued);
  assert.ok(!issued.detail.includes(r2.data.pin), 'ПИН-ът не е в одитната следа');
  assert.equal(ipcMain.invoke('online:status').data.consentingReaders, 1);
  /* Нов ПИН обезсилва стария. */
  const r3 = ipcMain.invoke('online:issuePin', { readerId });
  assert.equal(verifyPin(r2.data.pin, db.prepare('SELECT online_pin_hash FROM readers WHERE id = ?').get(readerId).online_pin_hash), false);
  assert.equal(verifyPin(r3.data.pin, db.prepare('SELECT online_pin_hash FROM readers WHERE id = ?').get(readerId).online_pin_hash), true);
  assert.equal(ipcMain.invoke('online:revokePin', { readerId }).ok, true);
  const after = db.prepare('SELECT online_pin_hash, online_pin_set_at FROM readers WHERE id = ?').get(readerId);
  assert.equal(after.online_pin_hash, null);
  assert.equal(after.online_pin_set_at, null);
  assert.equal(ipcMain.invoke('online:status').data.consentingReaders, 0);
  /* Оттеглено съгласие — датата се чисти. */
  assert.equal(ipcMain.invoke('online:setReaderConsent', { readerId, consent: false }).ok, true);
  const c = db.prepare('SELECT online_consent, online_consent_date FROM readers WHERE id = ?').get(readerId);
  assert.deepEqual(c, { online_consent: 0, online_consent_date: null });
});

test('насрочване: при активация промяната се слива в едно изпращане; без мост/ключ — прескача без грешка', async () => {
  const { ipcMain, api, db } = setup({ debounceMs: 30 });
  ipcMain.invoke('online:activate', { token: GOOD });
  api.stopOnlineTimer();
  /* Няма адрес и ключ: насрочва се (активирано е), но изпращането прескача. */
  assert.equal(api.scheduleOnlineSync(), true);
  assert.equal(api.scheduleOnlineSync(), true);
  assert.equal(ipcMain.invoke('online:status').data.pending, true);
  await wait(80);
  assert.equal(ipcMain.invoke('online:status').data.pending, false);
  assert.equal(db.prepare('SELECT online_last_error FROM settings WHERE id = 1').get().online_last_error, null);
  /* syncNow без адрес/ключ — ясна грешка, не заявка. */
  const r = await ipcMain.invoke('online:syncNow');
  assert.equal(r.ok, false);
  assert.match(r.error, /адреса на моста/);
});

test('изпращане: успехът записва online_last_sync, отказът — online_last_error (без диалог, без хвърляне)', async () => {
  const { ipcMain, api, db, logs, readerId } = setup();
  ipcMain.invoke('online:activate', { token: GOOD });
  api.stopOnlineTimer();
  ipcMain.invoke('online:updateSettings', { online_bridge_url: 'https://chyavorec.org/api/invlib', online_upload_key: 'KEY' });
  ipcMain.invoke('online:setReaderConsent', { readerId, consent: true });
  ipcMain.invoke('online:issuePin', { readerId });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    if (calls.length === 1) return { ok: true, status: 200, json: async () => ({ ok: true, readers: body.readers.length }) };
    return { ok: false, status: 401, json: async () => ({ error: 'unauthorized', message: 'лош ключ' }) };
  };
  try {
    const r1 = await ipcMain.invoke('online:syncNow');
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chyavorec.org/api/invlib/yavorec/sync');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer KEY');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.library, 'yavorec');
    assert.equal(sent.activation, GOOD);
    assert.equal(sent.libraryName, 'Библиотека при НЧ');
    assert.equal(sent.readers.length, 1);
    assert.equal(sent.readers[0].cardNumber, 'R-0042');
    let s = db.prepare('SELECT online_last_sync, online_last_error FROM settings WHERE id = 1').get();
    assert.equal(s.online_last_sync, sent.generated);
    assert.equal(s.online_last_error, null);
    const r2 = await ipcMain.invoke('online:syncNow');
    assert.equal(r2.ok, false);
    assert.match(r2.error, /ключа за качване/);
    s = db.prepare('SELECT online_last_sync, online_last_error FROM settings WHERE id = 1').get();
    assert.equal(s.online_last_sync, sent.generated, 'последният успешен момент остава');
    assert.match(s.online_last_error, /лош ключ/);
    assert.ok(logs.some(l => l.level === 'error'), 'грешката е в дневника');
    const st = ipcMain.invoke('online:status').data;
    assert.match(st.lastError, /лош ключ/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ======================================================================
   v2.4.81 — canRenew в снимката, историята и заявките „удължи“ от
   приложението. Гишето е ИСТИНСКОТО: handlers/circ-rules.js, holds.js,
   calendar.js и loans.js се регистрират със същия фалшив ipcMain, а онлайн
   модулът получава canRenew/renewFromApp през обвивка loanTools — точно както
   main.js. Така тестът пази, че приложението и „Продължи“ на гишето минават
   през една и съща врата (renewGate). */
function setupWithLoans(opts) {
  const base = setup(opts);
  const { db, ipcMain, auditLog, logs } = base;
  const run = (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } };
  const logAudit = (action, detail) => auditLog.push({ action, detail });
  const common = { getDb: () => db, run, logAudit, today: () => localDate() };
  const { circRule, readerCategory } = require('../handlers/circ-rules')(ipcMain, common);
  const { nextWorkDay, closedDaysBetween } = require('../handlers/calendar')(ipcMain, common);
  const holds = require('../handlers/holds')(ipcMain, Object.assign({ normalizeScanCode: (s) => s, scheduleCatalogWrite: () => {} }, common));
  const events = [];
  const loans = require('../handlers/loans')(ipcMain, Object.assign({
    logEvent: (kind, o) => events.push({ kind, ...o }), BOOK_SELECT: '', scheduleCatalogWrite: () => {},
    circRule, readerCategory, nextWorkDay, closedDaysBetween, normalizeScanCode: (s) => s,
    firstActiveHold: holds.firstActiveHold, consumeHoldOnCheckout: holds.consumeHoldOnCheckout,
    activateHoldOnReturn: holds.activateHoldOnReturn, freeCopies: holds.freeCopies, activeHolds: holds.activeHolds
  }, common));
  /* Онлайн модулът се регистрира наново с обвивката към гишето (setup() го е
     регистрирал без нея) — същият ipcMain, каналите се презаписват. */
  const api = registerOnlineHandlers(ipcMain, {
    getDb: () => db, run, logAudit, today: () => localDate(), createDebouncer,
    debounceMs: (opts && opts.debounceMs) || 30, activationPublicKey: publicKey,
    getVersion: () => '2.4.81', log: (level, msg) => logs.push({ level, msg }),
    loanTools: () => ({ canRenew: loans.canRenew, renewFromApp: loans.renewFromApp })
  });
  base.api.stopOnlineTimer();
  ipcMain.invoke('online:activate', { token: GOOD });
  api.stopOnlineTimer();
  ipcMain.invoke('online:updateSettings', { online_bridge_url: 'https://chyavorec.org/api/invlib', online_upload_key: 'KEY' });
  ipcMain.invoke('online:setReaderConsent', { readerId: base.readerId, consent: true });
  ipcMain.invoke('online:issuePin', { readerId: base.readerId });
  const book = (inv, title, qty) => {
    const id = db.prepare('INSERT INTO books (inv_number, title, author) VALUES (?, ?, ?)').run(inv, title, 'Автор').lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)').run(id, qty == null ? 1 : qty);
    return id;
  };
  const loan = (readerId, bookId, dateOut, dateDue, renewals) =>
    db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, renewals) VALUES (?, ?, ?, ?, ?)')
      .run(readerId, bookId, dateOut, dateDue, renewals || 0).lastInsertRowid;
  return Object.assign(base, { api, events, book, loan, holds });
}
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/* Мост-заглушка: записва всяко тяло и връща заявките, които тестът му е дал за
   ПЪРВИЯ отговор; следващите отговори са без заявки (мостът ги е приел). */
function bridge(firstRequests) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const requests = calls.length === 1 ? firstRequests : [];
    return { ok: true, status: 200, json: async () => ({ ok: true, requests }) };
  };
  return { calls, fetch };
}
const withFetch = async (fetch, fn) => { const real = globalThis.fetch; globalThis.fetch = fetch; try { return await fn(); } finally { globalThis.fetch = real; } };

test('снимката: canRenew по правилата на гишето (лимит, резервация без свободна бройка, просрочено) и историята', async () => {
  const t = setupWithLoans();
  const { db, ipcMain, readerId } = t;
  const today = localDate();
  const other = db.prepare("INSERT INTO readers (name, card_no, registered_at, gdpr_consent) VALUES ('Друг Читател', 'R-0077', ?, 1)").run(today).lastInsertRowid;
  const bFresh = t.book(1, 'Свежа');
  const bMax = t.book(2, 'Изчерпана');
  const bHeld = t.book(3, 'Запазена');
  const bHeldFree = t.book(4, 'Запазена, но с бройка', 2);
  const bOverdue = t.book(5, 'Просрочена');
  const bReturned = t.book(6, 'Върната');
  const lFresh = t.loan(readerId, bFresh, addDays(today, -5), addDays(today, 10));
  const lMax = t.loan(readerId, bMax, addDays(today, -5), addDays(today, 10), 2);          // extensions_count по подразбиране = 2
  const lHeld = t.loan(readerId, bHeld, addDays(today, -5), addDays(today, 10));
  const lHeldFree = t.loan(readerId, bHeldFree, addDays(today, -5), addDays(today, 10));
  const lOverdue = t.loan(readerId, bOverdue, addDays(today, -40), addDays(today, -1));
  db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(bHeld, other);
  db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(bHeldFree, other);
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in) VALUES (?, ?, ?, ?, ?)').run(readerId, bReturned, '2026-01-10', '2026-02-10', '2026-02-01');
  const { calls, fetch } = bridge([]);
  await withFetch(fetch, async () => { assert.equal((await ipcMain.invoke('online:syncNow')).ok, true); });
  assert.equal(calls.length, 1);
  const me = calls[0].readers.find(r => r.cardNumber === 'R-0042');
  const by = Object.fromEntries(me.loans.map(l => [l.loanId, l.canRenew]));
  assert.deepEqual(by, {
    [lFresh]: true, [lMax]: false, [lHeld]: false, [lHeldFree]: true, [lOverdue]: false
  });
  assert.deepEqual(me.history, [{ loanId: String(db.prepare('SELECT id FROM loans WHERE book_id = ?').get(bReturned).id), inv: 6, title: 'Върната', author: 'Автор', dateOut: '2026-01-10', dateIn: '2026-02-01' }]);
  assert.ok(!('requestResults' in calls[0]), 'без заявки няма requestResults');
  /* Гишето казва същото: „Продължи“ минава за свежото и отказва изчерпаното и запазеното. */
  assert.equal(ipcMain.invoke('loans:extend', { id: lFresh }).ok, true);
  assert.match(ipcMain.invoke('loans:extend', { id: lMax }).error, /лимитът от 2 продължения/);
  assert.match(ipcMain.invoke('loans:extend', { id: lHeld }).error, /резервирана от Друг Читател/);
  assert.equal(ipcMain.invoke('loans:extend', { id: lOverdue }).ok, true, 'гишето продължава просрочено (с начислена забава) — приложението не');
});

test('заявка „удължи“: изпълнена като на гишето, със следа „Удължено от приложението“, и отговорът тръгва веднага с ново изпращане', async () => {
  const t = setupWithLoans();
  const { db, ipcMain, readerId, auditLog, events } = t;
  const today = localDate();
  const b = t.book(156, 'Под игото');
  const due = addDays(today, 10);
  const id = t.loan(readerId, b, addDays(today, -5), due);
  const { calls, fetch } = bridge([{ id: 'q-1', type: 'renew', readerId: String(readerId), cardNumber: 'R-0042', loanId: String(id), inv: 156, at: '2026-09-30T10:00:00Z' }]);
  await withFetch(fetch, async () => { assert.equal((await ipcMain.invoke('online:syncNow')).ok, true); });
  assert.equal(calls.length, 2, 'снимка + незабавен отговор');
  assert.deepEqual(calls[1].requestResults, [{ id: 'q-1', status: 'done' }]);
  const row = db.prepare('SELECT date_due, renewals FROM loans WHERE id = ?').get(id);
  assert.equal(row.date_due, addDays(due, 30), 'срок + дните за продължение (30 по подразбиране), от стария срок');
  assert.equal(row.renewals, 1);
  const sent = calls[1].readers[0].loans[0];
  assert.equal(sent.dateDue, row.date_due, 'второто изпращане носи обновеното заемане');
  assert.equal(sent.renewals, 1);
  assert.equal(sent.canRenew, true, 'остава едно продължение от две');
  const a = auditLog.find(x => x.action === 'Удължено от приложението');
  assert.ok(a, 'ред в одитната следа');
  assert.match(a.detail, /инв\. № 156 — Под игото/);
  assert.match(a.detail, /читател Иван Иванов \(карта R-0042\)/);
  assert.match(a.detail, /\(1\/2\)/);
  assert.deepEqual(events, [{ kind: 'подновяване', bookId: b, readerId }]);
  assert.deepEqual(db.prepare('SELECT id, status, reason FROM online_request_results').all(), [{ id: 'q-1', status: 'done', reason: null }]);
});

test('заявка „удължи“: отказите с кратка причина — лимит, резервация, просрочено, чуждо/несъществуващо заемане, чужда карта, читател без онлайн достъп', async () => {
  const t = setupWithLoans();
  const { db, ipcMain, readerId } = t;
  const today = localDate();
  const other = db.prepare("INSERT INTO readers (name, card_no, registered_at, gdpr_consent) VALUES ('Друг', 'R-0077', ?, 1)").run(today).lastInsertRowid;
  const lMax = t.loan(readerId, t.book(2, 'Изчерпана'), addDays(today, -5), addDays(today, 10), 2);
  const bHeld = t.book(3, 'Запазена');
  const lHeld = t.loan(readerId, bHeld, addDays(today, -5), addDays(today, 10));
  db.prepare('INSERT INTO holds (book_id, reader_id) VALUES (?, ?)').run(bHeld, other);
  const lOverdue = t.loan(readerId, t.book(5, 'Просрочена'), addDays(today, -40), addDays(today, -1));
  const lOther = t.loan(other, t.book(7, 'Чужда'), addDays(today, -5), addDays(today, 10));
  const lOk = t.loan(readerId, t.book(8, 'Моя'), addDays(today, -5), addDays(today, 10));
  const req = (id, o) => Object.assign({ id, type: 'renew', readerId: String(readerId), cardNumber: 'R-0042', at: 'x' }, o);
  const { calls, fetch } = bridge([
    req('max', { loanId: String(lMax) }),
    req('hold', { loanId: String(lHeld) }),
    req('over', { loanId: String(lOverdue) }),
    req('other', { loanId: String(lOther) }),
    req('none', { loanId: '999999' }),
    req('card', { loanId: String(lOk), cardNumber: 'R-9999' }),
    req('noaccess', { loanId: String(lOther), readerId: String(other), cardNumber: 'R-0077' }),
    req('kind', { loanId: String(lOk), type: 'cancel' }),
    { type: 'renew' }   // без id — подминава се
  ]);
  await withFetch(fetch, async () => { assert.equal((await ipcMain.invoke('online:syncNow')).ok, true); });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].requestResults, [
    { id: 'max', status: 'rejected', reason: 'достигнат максимален брой удължавания' },
    { id: 'hold', status: 'rejected', reason: 'книгата е запазена от друг читател' },
    { id: 'over', status: 'rejected', reason: 'просрочена' },
    { id: 'other', status: 'rejected', reason: 'не е намерена' },
    { id: 'none', status: 'rejected', reason: 'не е намерена' },
    { id: 'card', status: 'rejected', reason: 'не е намерена' },
    { id: 'noaccess', status: 'rejected', reason: 'не е намерена' },
    { id: 'kind', status: 'rejected', reason: 'непознат вид заявка' }
  ]);
  for (const id of [lMax, lHeld, lOverdue, lOther, lOk]) {
    const r = db.prepare('SELECT renewals FROM loans WHERE id = ?').get(id);
    assert.equal(r.renewals, id === lMax ? 2 : 0, 'нищо не е удължено');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM online_request_results').get().n, 8);
});

test('заявките са идемпотентни: повторно получена заявка получава същия отговор, не удължава пак и не поражда ново изпращане', async () => {
  const t = setupWithLoans();
  const { db, ipcMain, readerId, auditLog } = t;
  const today = localDate();
  const id = t.loan(readerId, t.book(1, 'Книга'), addDays(today, -5), addDays(today, 10));
  const q = { id: 'q-7', type: 'renew', readerId: String(readerId), cardNumber: 'R-0042', loanId: String(id), inv: 1, at: 'x' };
  /* Мост, който ВИНАГИ връща същата заявка (не я е потвърдил). */
  const calls = [];
  const fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, requests: [q] }) }; };
  await withFetch(fetch, async () => { assert.equal((await ipcMain.invoke('online:syncNow')).ok, true); });
  assert.equal(calls.length, 2, 'снимка + един отговор; повторената заявка в отговора не върти веригата');
  assert.deepEqual(calls[1].requestResults, [{ id: 'q-7', status: 'done' }]);
  assert.equal(db.prepare('SELECT renewals FROM loans WHERE id = ?').get(id).renewals, 1);
  /* Следващо редовно изпращане: мостът пак праща q-7 → същият отговор, renewals остава 1. */
  await withFetch(fetch, async () => { assert.equal((await ipcMain.invoke('online:syncNow')).ok, true); });
  assert.equal(calls.length, 3);
  assert.ok(!('requestResults' in calls[2]), 'редовната снимка е без requestResults');
  assert.equal(db.prepare('SELECT renewals FROM loans WHERE id = ?').get(id).renewals, 1, 'не е удължено втори път');
  assert.equal(auditLog.filter(a => a.action === 'Удължено от приложението').length, 1);
  /* Отказ също се помни: същият отказ, без ново пресмятане. */
  db.prepare("INSERT INTO online_request_results (id, status, reason, at) VALUES ('q-8', 'rejected', 'просрочена', 'x')").run();
  const q8 = Object.assign({}, q, { id: 'q-8' });
  const fetch2 = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, requests: [q8, q] }) }; };
  await withFetch(fetch2, async () => { assert.equal((await ipcMain.invoke('online:syncNow')).ok, true); });
  assert.equal(calls.length, 4, 'нищо ново — без отговор');
  assert.equal(db.prepare('SELECT renewals FROM loans WHERE id = ?').get(id).renewals, 1);
});

test('БЕЗ активация и без обвивка към гишето нищо не се обработва', async () => {
  /* Без активация: syncOnline прескача преди каквото и да е — таблицата остава празна. */
  const t = setupWithLoans();
  const { db, ipcMain, readerId, api, auditLog } = t;
  const today = localDate();
  const id = t.loan(readerId, t.book(1, 'Книга'), addDays(today, -5), addDays(today, 10));
  const q = { id: 'q-9', type: 'renew', readerId: String(readerId), cardNumber: 'R-0042', loanId: String(id), inv: 1, at: 'x' };
  const n0 = auditLog.length;
  ipcMain.invoke('online:deactivate');
  let calls = 0;
  const fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ ok: true, requests: [q] }) }; };
  await withFetch(fetch, async () => {
    const r = await api.syncOnline('тест');
    assert.equal(r.skipped, true);
  });
  assert.equal(calls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM online_request_results').get().n, 0);
  assert.equal(db.prepare('SELECT renewals FROM loans WHERE id = ?').get(id).renewals, 0);
  assert.equal(auditLog.length - n0, 1, 'само редът за деактивирането');
  /* Активирано, но по-стар main.js без loanTools: canRenew е false и заявката се отказва ясно, без удължаване. */
  const s = setup();
  s.api.stopOnlineTimer();
  s.ipcMain.invoke('online:activate', { token: GOOD });
  s.api.stopOnlineTimer();
  s.ipcMain.invoke('online:updateSettings', { online_bridge_url: 'https://chyavorec.org/api/invlib', online_upload_key: 'KEY' });
  s.ipcMain.invoke('online:setReaderConsent', { readerId: s.readerId, consent: true });
  s.ipcMain.invoke('online:issuePin', { readerId: s.readerId });
  const b = s.db.prepare("INSERT INTO books (inv_number, title) VALUES (1, 'Книга')").run().lastInsertRowid;
  s.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(b);
  const id2 = s.db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(s.readerId, b, addDays(today, -5), addDays(today, 10)).lastInsertRowid;
  const { calls: c2, fetch: f2 } = bridge([Object.assign({}, q, { loanId: String(id2), readerId: String(s.readerId) })]);
  await withFetch(f2, async () => { assert.equal((await s.ipcMain.invoke('online:syncNow')).ok, true); });
  assert.equal(c2[0].readers[0].loans[0].canRenew, false);
  assert.deepEqual(c2[1].requestResults, [{ id: 'q-9', status: 'rejected', reason: 'удължаването от приложението не е налично' }]);
  assert.equal(s.db.prepare('SELECT renewals FROM loans WHERE id = ?').get(id2).renewals, 0);
});
