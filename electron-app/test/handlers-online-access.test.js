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
