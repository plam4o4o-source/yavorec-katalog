// v2.4.83 — лекото изпращане към моста (договорът, раздел InvLib):
//   • отпечатък на каноничното тяло (без generated/activation/requestResults);
//   • „без промени“ само при обявено "unchanged", същия отпечатък и пълна
//     снимка отпреди < 6 часа; needFull → пълна веднага;
//   • gzip само при обявено "gzip";
//   • мост БЕЗ features → точно както в v2.4.82 (пълна снимка, чист JSON, 30 мин);
//   • изпращане при стартиране, изчакване на насроченото при затваряне (с таван);
//   • loans:extend насрочва изпращане.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const registerOnlineHandlers = require('../handlers/online-access');
const { createDebouncer } = require('../debounce');
const { localDate } = require('../local-date');
const oa = require('../online-access');

/* Никакъв истински изход в мрежата — тестовете подменят fetch сами. */
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('мрежата е изключена в тестовете'); };
test.after(() => { globalThis.fetch = realFetch; });

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
function makeToken(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return p + '.' + crypto.sign(null, Buffer.from(p), privateKey).toString('base64url');
}
const GOOD = makeToken({ lib: 'yavorec', name: 'Библиотека Яворец', exp: '2099-12-31', iat: 1 });
const BRIDGE = 'https://chyavorec.org/api/invlib';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args)
  };
}
/** База със схемата, активиран онлайн достъп, адрес/ключ и един читател със съгласие + ПИН. */
function setup(opts) {
  const o = opts || {};
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.prepare("UPDATE settings SET lib_name = 'Библиотека при НЧ' WHERE id = 1").run();
  const logs = [];
  const ipcMain = fakeIpcMain();
  /* Насрочването по време на подготовката (активиране, адрес, ПИН) се
     пропуска — иначе всеки тест би започвал с чакащо изпращане. */
  let quiet = true;
  const quietDebouncer = (fn, ms) => {
    const d = createDebouncer(fn, ms);
    return { schedule: () => { if (!quiet) d.schedule(); }, flush: d.flush, pending: d.pending };
  };
  const api = registerOnlineHandlers(ipcMain, {
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: () => {},
    today: () => localDate(),
    createDebouncer: quietDebouncer,
    debounceMs: o.debounceMs || 60 * 1000,
    activationPublicKey: publicKey,
    getVersion: () => '2.4.83',
    log: (level, msg) => logs.push({ level, msg })
  });
  const readerId = db.prepare("INSERT INTO readers (name, card_no, registered_at, gdpr_consent) VALUES ('Иван Иванов', 'R-0042', ?, 1)")
    .run(localDate()).lastInsertRowid;
  if (!o.noActivation) {
    ipcMain.invoke('online:activate', { token: GOOD });
    api.stopOnlineTimer();
    ipcMain.invoke('online:updateSettings', { online_bridge_url: BRIDGE, online_upload_key: 'KEY' });
    ipcMain.invoke('online:setReaderConsent', { readerId, consent: true });
    ipcMain.invoke('online:issuePin', { readerId });
  }
  quiet = false;
  return { db, ipcMain, api, logs, readerId };
}
/* Мост-заглушка: разчита тялото (и компресираното), записва заглавките и
   отговаря с това, което тестът му каже (функция на поредния номер). */
function bridge(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    const gz = init.headers['Content-Encoding'] === 'gzip';
    const raw = gz ? zlib.gunzipSync(Buffer.from(init.body)).toString('utf8') : init.body;
    assert.equal(typeof raw, 'string', 'тялото е низ (чист JSON) или байтове с gzip');
    const body = JSON.parse(raw);
    calls.push({ url, gz, body, headers: init.headers, rawType: typeof init.body });
    const r = respond ? respond(calls.length, body) : {};
    if (r && r.status && r.status !== 200) {
      return { ok: false, status: r.status, json: async () => ({ error: 'invalid', message: r.message || 'отказ' }) };
    }
    return { ok: true, status: 200, json: async () => Object.assign({ ok: true }, r || {}) };
  };
  return { calls, fetch };
}
const withFetch = async (fetch, fn) => { const prev = globalThis.fetch; globalThis.fetch = fetch; try { return await fn(); } finally { globalThis.fetch = prev; } };
const settings = (db) => db.prepare(`SELECT online_last_sync, online_last_error, online_last_hash, online_last_full,
  online_bridge_features FROM settings WHERE id = 1`).get();
const NEW_BRIDGE = { features: ['gzip', 'unchanged'] };

/* ======================================================================
   Отпечатъкът
   ====================================================================== */
test('canonicalJson: ключовете се подреждат на всяко ниво; масивите пазят реда; undefined отпада като в JSON', () => {
  assert.equal(oa.canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } }), '{"a":{"c":"x","d":[3,1]},"b":1}');
  assert.equal(oa.canonicalJson({ a: { c: 'x', d: [3, 1] }, b: 1 }), oa.canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } }));
  assert.equal(oa.canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.equal(oa.canonicalJson([undefined, 'а']), '[null,"а"]');
  assert.deepEqual(JSON.parse(oa.canonicalJson({ z: 'ж', n: 1.5, t: true })), { z: 'ж', n: 1.5, t: true });
});

test('snapshotHash: без generated/activation/requestResults; не зависи от реда на ключовете; сменя се при промяна', () => {
  const body = { library: 'yavorec', generated: '2026-10-10T10:00:00.000Z', activation: 'A', libraryName: 'Б',
    readers: [{ readerId: '1', loans: [{ loanId: '5', dateDue: '2026-11-01' }] }] };
  const h = oa.snapshotHash(body);
  assert.match(h, /^[0-9a-f]{64}$/, 'sha256, hex');
  assert.equal(oa.snapshotHash(Object.assign({}, body, { generated: '2027-01-01T00:00:00.000Z', activation: 'B',
    requestResults: [{ id: 'q', status: 'done' }] })), h, 'изключените полета не влияят');
  const reordered = { readers: body.readers, libraryName: 'Б', activation: 'A', library: 'yavorec', generated: 'x' };
  assert.equal(oa.snapshotHash(reordered), h, 'редът на ключовете не влияе');
  const changed = JSON.parse(JSON.stringify(body));
  changed.readers[0].loans[0].dateDue = '2026-11-15';
  assert.notEqual(oa.snapshotHash(changed), h, 'нов срок → нов отпечатък');
  assert.notEqual(oa.snapshotHash(Object.assign({}, body, { libraryName: 'В' })), h);
  assert.equal(oa.snapshotHash(Object.assign({}, body, { hash: 'нещо' })), h, 'самото поле hash също е извън');
  assert.deepEqual(oa.HASH_EXCLUDED_KEYS, ['generated', 'activation', 'requestResults', 'hash']);
});

test('snapshotHash върху истинската снимка: две сглобявания на непроменена база дават един отпечатък; заемане го сменя', async () => {
  const { db, readerId } = setup();
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const v = { publicKey };
  const a = oa.buildSnapshot(db, s, '2026-10-10T08:00:00.000Z', v);
  const b = oa.buildSnapshot(db, s, '2026-10-10T09:30:00.000Z', v);
  assert.notEqual(a.generated, b.generated);
  assert.equal(oa.snapshotHash(a), oa.snapshotHash(b));
  const bookId = db.prepare("INSERT INTO books (inv_number, title, author) VALUES (7, 'Тютюн', 'Д. Димов')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(readerId, bookId, localDate(), '2099-01-01');
  assert.notEqual(oa.snapshotHash(oa.buildSnapshot(db, s, '2026-10-10T10:00:00.000Z', v)), oa.snapshotHash(a));
});

test('unchangedBody: само library, activation, unchanged, hash и requestResults (празен масив по подразбиране)', () => {
  const body = { library: 'yavorec', activation: 'A', generated: 'g', libraryName: 'Б', readers: [{}] };
  assert.deepEqual(oa.unchangedBody(body, 'h1'), { library: 'yavorec', activation: 'A', unchanged: true, hash: 'h1', requestResults: [] });
  const rr = [{ id: 'q', status: 'done' }];
  assert.deepEqual(oa.unchangedBody(body, 'h1', rr).requestResults, rr);
});

/* ======================================================================
   sendSnapshot: gzip, features, needFull
   ====================================================================== */
test('sendSnapshot с opts.gzip: Content-Encoding: gzip и тялото се разархивира до същия JSON', async () => {
  let seen = null;
  const fetch = async (url, init) => { seen = init; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const body = { library: 'yavorec', readers: Array.from({ length: 200 }, (_, i) => ({ readerId: String(i), fullName: 'Читател ' + i })) };
  const r = await oa.sendSnapshot(BRIDGE, 'yavorec', 'K', body, { fetch, gzip: true });
  assert.equal(r.ok, true);
  assert.equal(seen.headers['Content-Encoding'], 'gzip');
  assert.equal(seen.headers['Content-Type'], 'application/octet-stream', 'не application/json — мостът отказва gzip + json с 415');
  assert.ok(seen.body instanceof Uint8Array, 'байтове, не низ');
  assert.equal(zlib.gunzipSync(Buffer.from(seen.body)).toString('utf8'), JSON.stringify(body));
  assert.equal(r.bytes, seen.body.length);
  assert.ok(r.bytes < Buffer.byteLength(JSON.stringify(body)) / 3, 'компресията наистина смалява тялото');
});

test('sendSnapshot: features (само низове) и needFull от отговора; без тях — null/false', async () => {
  const mk = (j) => async () => ({ ok: true, status: 200, json: async () => j });
  let r = await oa.sendSnapshot(BRIDGE, 'l', 'k', {}, { fetch: mk({ ok: true, features: ['gzip', 'unchanged', 5, ''], needFull: true }) });
  assert.deepEqual(r.features, ['gzip', 'unchanged']);
  assert.equal(r.needFull, true);
  r = await oa.sendSnapshot(BRIDGE, 'l', 'k', {}, { fetch: mk({ ok: true, needFull: 'yes' }) });
  assert.equal(r.features, null);
  assert.equal(r.needFull, false, 'само needFull === true');
  r = await oa.sendSnapshot(BRIDGE, 'l', 'k', {}, { fetch: mk({ ok: true, features: [] }) });
  assert.deepEqual(r.features, []);
});

/* ======================================================================
   Мост БЕЗ features — поведението от v2.4.82
   ====================================================================== */
test('мост без features: всяко изпращане е пълна снимка, чист JSON низ, без компресия; таймерът — 30 минути', async () => {
  const { db, api } = setup();
  const { calls, fetch } = bridge(() => ({ requests: [] }));
  await withFetch(fetch, async () => {
    assert.equal((await api.syncOnline('по таймер')).ok, true);
    assert.equal((await api.syncOnline('по таймер')).ok, true);
    assert.equal((await api.syncOnline('по таймер')).ok, true);
  });
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.gz, false);
    assert.equal(c.rawType, 'string', 'тялото е JSON низ — точно както в v2.4.82');
    assert.equal(c.headers['Content-Encoding'], undefined);
    assert.ok(Array.isArray(c.body.readers) && c.body.readers.length === 1, 'пълна снимка');
    assert.ok(!('unchanged' in c.body), 'никога „без промени“');
    assert.equal(c.body.hash, oa.snapshotHash(c.body), 'единственото ново поле — отпечатъкът (по-старият мост го пренебрегва)');
    assert.equal(c.headers['Content-Type'], 'application/json; charset=utf-8');
  }
  const s = settings(db);
  assert.equal(s.online_bridge_features, null);
  assert.equal(s.online_last_sync, calls[2].body.generated);
  api.startOnlineTimer();
  assert.equal(api.onlineTimerMs(), 30 * 60 * 1000);
  api.stopOnlineTimer();
  assert.equal(api.onlineTimerMs(), 0);
});

/* ======================================================================
   Мост с ["gzip", "unchanged"]
   ====================================================================== */
test('"unchanged": първо пълна снимка, после само лекото тяло (с hash и requestResults), докато нищо не се сменя', async () => {
  const { db, api, ipcMain, readerId } = setup();
  const { calls, fetch } = bridge(() => NEW_BRIDGE);
  api.startOnlineTimer();
  assert.equal(api.onlineTimerMs(), 30 * 60 * 1000, 'преди първия отговор — по стария начин');
  await withFetch(fetch, async () => {
    assert.equal((await api.syncOnline('по таймер')).ok, true);
    let s = settings(db);
    assert.equal(s.online_bridge_features, JSON.stringify(['gzip', 'unchanged']));
    assert.equal(s.online_last_full, calls[0].body.generated);
    assert.equal(s.online_last_hash, oa.snapshotHash(calls[0].body));
    assert.equal(calls[0].body.hash, s.online_last_hash, 'пълната снимка носи отпечатъка си');
    assert.equal(api.onlineTimerMs(), 10 * 60 * 1000, 'мостът поддържа „без промени“ → таймерът е на 10 минути');
    assert.equal(calls[0].gz, false, 'първото изпращане е преди мостът да е обявил gzip');

    assert.equal((await api.syncOnline('по таймер')).ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].gz, true, 'вече с gzip');
    assert.deepEqual(calls[1].body, { library: 'yavorec', activation: GOOD, unchanged: true, hash: s.online_last_hash, requestResults: [] });
    const s2 = settings(db);
    assert.equal(s2.online_last_full, s.online_last_full, 'моментът на пълната снимка остава');
    assert.ok(s2.online_last_sync > s.online_last_sync || s2.online_last_sync !== s.online_last_sync, '„Последно изпратено“ се мести');
    assert.equal(s2.online_last_error, null);
    const st = ipcMain.invoke('online:status').data;
    assert.equal(st.lastFull, s.online_last_full);
    assert.notEqual(st.lastSync, st.lastFull, 'екранът познава, че последното е било „без промени“');
    assert.deepEqual(st.bridgeFeatures, ['gzip', 'unchanged']);

    /* Промяна в базата → пълна снимка (компресирана). */
    db.prepare("UPDATE readers SET name = 'Иван П. Иванов' WHERE id = ?").run(readerId);
    assert.equal((await api.syncOnline('след промяна')).ok, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].gz, true);
    assert.equal(calls[2].body.readers[0].fullName, 'Иван П. Иванов');
    assert.equal(calls[2].headers['Content-Type'], 'application/octet-stream');
    assert.equal(calls[2].body.hash, settings(db).online_last_hash);
    assert.notEqual(settings(db).online_last_hash, s.online_last_hash);
    assert.equal(settings(db).online_last_full, calls[2].body.generated);
  });
  api.stopOnlineTimer();
});

test('"unchanged": пълна снимка поне на 6 часа, при „Изпрати сега“ и при час на пълната в бъдещето', async () => {
  const { db, api, ipcMain } = setup();
  const { calls, fetch } = bridge(() => NEW_BRIDGE);
  await withFetch(fetch, async () => {
    await api.syncOnline('по таймер');                                    // пълна
    await api.syncOnline('по таймер');                                    // без промени
    assert.equal(calls[1].body.unchanged, true);
    const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
    db.prepare('UPDATE settings SET online_last_full = ? WHERE id = 1').run(at(6 * 3600 * 1000 + 1000));
    await api.syncOnline('по таймер');
    assert.ok(Array.isArray(calls[2].body.readers), 'над 6 часа → пълна');
    db.prepare('UPDATE settings SET online_last_full = ? WHERE id = 1').run(at(5 * 3600 * 1000));
    await api.syncOnline('по таймер');
    assert.equal(calls[3].body.unchanged, true, 'под 6 часа и същият отпечатък → без промени');
    assert.equal((await ipcMain.invoke('online:syncNow')).ok, true);
    assert.ok(Array.isArray(calls[4].body.readers), '„Изпрати сега“ е винаги пълна снимка');
    db.prepare('UPDATE settings SET online_last_full = ? WHERE id = 1').run(at(-3600 * 1000));
    await api.syncOnline('по таймер');
    assert.ok(Array.isArray(calls[5].body.readers), 'час в бъдещето (сменен часовник) → пълна');
  });
});

test('needFull в отговор на „без промени“ → веднага пълна снимка; отпечатъкът се забравя до успеха ѝ', async () => {
  const { db, api } = setup();
  let fullFails = false;
  const { calls, fetch } = bridge((n, body) => {
    if (body.unchanged) return Object.assign({ needFull: true }, NEW_BRIDGE);
    if (fullFails && n > 2) return { status: 503 };
    return NEW_BRIDGE;
  });
  await withFetch(fetch, async () => {
    await api.syncOnline('по таймер');
    const r = await api.syncOnline('по таймер');
    assert.equal(r.ok, true);
    assert.equal(calls.length, 3, 'без промени → needFull → пълна');
    assert.equal(calls[1].body.unchanged, true);
    assert.ok(Array.isArray(calls[2].body.readers));
    assert.equal(r.followUp && r.followUp.ok, true);
    assert.equal(settings(db).online_last_full, calls[2].body.generated);
    assert.ok(settings(db).online_last_hash);

    /* Ако пълната след needFull не успее, следващото изпращане пак е пълно. */
    fullFails = true;
    await api.syncOnline('по таймер');
    assert.equal(calls[3].body.unchanged, true);
    assert.ok(Array.isArray(calls[4].body.readers), 'опит за пълна');
    assert.equal(settings(db).online_last_hash, null, 'мостът няма снимка — отпечатъкът е забравен');
    fullFails = false;
    await api.syncOnline('по таймер');
    assert.ok(Array.isArray(calls[5].body.readers), 'следващото е пълно, не „без промени“');
  });
});

test('needFull: пълната снимка носи отговорите на заявките от „без промени“ и от отговора с needFull', async () => {
  const { db, api, readerId } = setup();
  const req = { id: 'q-x', type: 'messageRead', readerId: String(readerId), cardNumber: 'R-0042', messageId: '999', at: '2026-10-01T10:00:00Z' };
  const { calls, fetch } = bridge((n, body) => {
    if (n === 2) return Object.assign({ requests: [req] }, NEW_BRIDGE);               // без промени + заявка
    if (body.unchanged) return Object.assign({ needFull: true }, NEW_BRIDGE);          // отговорът на заявката — needFull
    return NEW_BRIDGE;
  });
  await withFetch(fetch, async () => {
    await api.syncOnline('по таймер');           // 1: пълна
    await api.syncOnline('по таймер');           // 2: без промени → заявка (отказ — няма такова съобщение) → 3: без промени с отговора → needFull → 4: пълна
  });
  assert.equal(calls.length, 4);
  assert.equal(calls[1].body.unchanged, true);
  assert.equal(calls[2].body.unchanged, true, 'отказаната заявка не сменя снимката — отговорът тръгва леко');
  assert.deepEqual(calls[2].body.requestResults, [{ id: 'q-x', status: 'rejected', reason: 'съобщението не е намерено' }]);
  assert.ok(Array.isArray(calls[3].body.readers));
  assert.deepEqual(calls[3].body.requestResults, [{ id: 'q-x', status: 'rejected', reason: 'съобщението не е намерено' }],
    'пълната снимка повтаря отговора — мостът може да не го е приел');
  assert.equal(settings(db).online_last_hash, oa.snapshotHash(calls[3].body));
});

test('"gzip" без "unchanged": компресия, но всяко изпращане е пълно; таймерът остава 30 минути', async () => {
  const { api } = setup();
  const { calls, fetch } = bridge(() => ({ features: ['gzip'] }));
  api.startOnlineTimer();
  await withFetch(fetch, async () => { await api.syncOnline('а'); await api.syncOnline('б'); });
  assert.equal(calls[1].gz, true);
  assert.ok(Array.isArray(calls[1].body.readers));
  assert.equal(api.onlineTimerMs(), 30 * 60 * 1000);
  api.stopOnlineTimer();
});

test('мостът е върнат към стара версия: features се забравят от първия отговор без тях', async () => {
  const { db, api } = setup();
  let old = false;
  const { calls, fetch } = bridge(() => (old ? {} : NEW_BRIDGE));
  api.startOnlineTimer();
  await withFetch(fetch, async () => {
    await api.syncOnline('а');
    assert.equal(api.onlineTimerMs(), 10 * 60 * 1000);
    old = true;
    db.prepare("UPDATE settings SET lib_name = 'Друго име' WHERE id = 1").run();    // промяна → пълна (gzip)
    await api.syncOnline('б');
    assert.equal(calls[1].gz, true);
    assert.equal(settings(db).online_bridge_features, null);
    assert.equal(api.onlineTimerMs(), 30 * 60 * 1000, 'обратно на 30 минути');
    await api.syncOnline('в');
    assert.equal(calls[2].gz, false);
    assert.ok(Array.isArray(calls[2].body.readers), 'без промени в базата, но мостът не поддържа „без промени“ → пълна');
  });
  api.stopOnlineTimer();
});

test('мост, обявил features, отказва тялото (422) → веднага пълна снимка по стария начин и features се забравят', async () => {
  const { db, api, logs } = setup();
  let rollback = false;
  const { calls, fetch } = bridge((n, body) => {
    if (!rollback) return NEW_BRIDGE;
    /* По-стар мост: компресирано тяло или тяло без readers[] → 422 (виж api/_lib/invlib/service.js). */
    return !Array.isArray(body.readers) || calls[n - 1].gz ? { status: 422, message: 'Липсва readers[].' } : {};
  });
  await withFetch(fetch, async () => {
    await api.syncOnline('а');
    rollback = true;
    const r = await api.syncOnline('б');
    assert.equal(r.ok, true, JSON.stringify(r));
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].body.unchanged, true);
  assert.equal(calls[2].gz, false);
  assert.equal(calls[2].rawType, 'string');
  assert.ok(Array.isArray(calls[2].body.readers));
  const s = settings(db);
  assert.equal(s.online_bridge_features, null);
  assert.equal(s.online_last_error, null);
  assert.ok(logs.some(l => l.level === 'error' && /отказа тялото „без промени“/.test(l.msg)));
});

test('смяна на адреса на моста или ключа нулира отпечатъка и features — следващото е пълно, по стария начин', async () => {
  const { db, api, ipcMain } = setup();
  const { calls, fetch } = bridge(() => NEW_BRIDGE);
  await withFetch(fetch, async () => { await api.syncOnline('а'); });
  assert.ok(settings(db).online_bridge_features);
  ipcMain.invoke('online:updateSettings', { online_bridge_url: BRIDGE + '/', online_upload_key: '' });   // същият адрес
  assert.ok(settings(db).online_bridge_features, 'същият адрес (и без нов ключ) не нулира');
  ipcMain.invoke('online:updateSettings', { online_bridge_url: 'https://other.example/api/invlib', online_upload_key: '' });
  let s = settings(db);
  assert.equal(s.online_bridge_features, null);
  assert.equal(s.online_last_hash, null);
  assert.equal(s.online_last_full, null);
  await withFetch(fetch, async () => { await api.syncOnline('б'); });
  assert.ok(settings(db).online_bridge_features);
  ipcMain.invoke('online:updateSettings', { online_bridge_url: 'https://other.example/api/invlib', online_upload_key: 'NEW' });
  s = settings(db);
  assert.equal(s.online_bridge_features, null, 'нов ключ — също');
  assert.equal(calls[1].gz, false);
  assert.ok(Array.isArray(calls[1].body.readers));
  ipcMain.invoke('online:deactivate');
  assert.equal(settings(db).online_last_hash, null);
});

/* ======================================================================
   Стартиране и затваряне
   ====================================================================== */
test('изпращане при стартиране: пълна снимка след закъснението; без активация — нищо', async () => {
  const { db, api } = setup();
  const { calls, fetch } = bridge(() => NEW_BRIDGE);
  await withFetch(fetch, async () => {
    await api.syncOnline('а');
    await api.syncOnline('б');
    assert.equal(calls[1].body.unchanged, true);
    assert.equal(api.scheduleStartupOnlineSync(20), true);
    assert.equal(api.scheduleStartupOnlineSync(20), false, 'само едно насрочено');
    await wait(5);
    assert.equal(calls.length, 2, 'не веднага — след закъснението');
    await wait(80);
    assert.equal(calls.length, 3);
    assert.ok(Array.isArray(calls[2].body.readers), 'при стартиране — пълна снимка, дори без промени');
  });
  assert.equal(settings(db).online_last_full, calls[2].body.generated);

  const off = setup({ noActivation: true });
  let sent = 0;
  await withFetch(async () => { sent++; return { ok: true, status: 200, json: async () => ({}) }; }, async () => {
    assert.equal(off.api.scheduleStartupOnlineSync(5), false);
    await wait(40);
  });
  assert.equal(sent, 0);

  /* stopOnlineTimer (деактивиране, затваряне) отменя още ненастъпилото. */
  const t = setup();
  let sent2 = 0;
  await withFetch(async () => { sent2++; return { ok: true, status: 200, json: async () => ({}) }; }, async () => {
    assert.equal(t.api.scheduleStartupOnlineSync(30), true);
    t.api.stopOnlineTimer();
    await wait(70);
  });
  assert.equal(sent2, 0);
});

test('затваряне: насроченото изпращане тръгва веднага и се изчаква; после нищо ново не тръгва', async () => {
  const { api, ipcMain, readerId } = setup({ debounceMs: 60 * 1000 });
  const { calls, fetch } = bridge(() => ({}));
  await withFetch(fetch, async () => {
    assert.equal(api.flushOnlineSyncOnQuit(1000), null, 'нищо насрочено → null (затварянето остава синхронно)');
    ipcMain.invoke('online:sendMessage', { readerId, text: 'Книгата ви чака.' });
    assert.equal(ipcMain.invoke('online:status').data.pending, true);
    const p = api.flushOnlineSyncOnQuit(1000);
    assert.ok(p && typeof p.then === 'function');
    assert.equal(await p, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.readers[0].messages[0].text, 'Книгата ви чака.');
    assert.equal(ipcMain.invoke('online:status').data.pending, false);
    const after = await api.syncOnline('по таймер');
    assert.equal(after.skipped, true, 'след затварянето — нищо');
    assert.equal(calls.length, 1);
  });
});

test('затваряне: бавен мост не държи програмата — таванът изтича и обещанието връща false', async () => {
  const { api, ipcMain, readerId, logs } = setup({ debounceMs: 60 * 1000 });
  let release;
  const hang = new Promise(r => { release = r; });
  await withFetch(async () => { await hang; return { ok: true, status: 200, json: async () => ({}) }; }, async () => {
    ipcMain.invoke('online:sendMessage', { readerId, text: 'Здравейте' });
    const t0 = Date.now();
    const done = await api.flushOnlineSyncOnQuit(60);
    const ms = Date.now() - t0;
    assert.equal(done, false);
    assert.ok(ms < 1000, 'изчакването е ограничено: ' + ms + ' ms');
    assert.ok(logs.some(l => /не приключи до/.test(l.msg)));
    release();
    await wait(20);
  });
});

test('затваряне: вървящо изпращане (без насрочено) също се изчаква в тавана', async () => {
  const { api } = setup();
  let release;
  const hang = new Promise(r => { release = r; });
  let n = 0;
  await withFetch(async () => { n++; await hang; return { ok: true, status: 200, json: async () => ({}) }; }, async () => {
    const running = api.syncOnline('по таймер');
    const p = api.flushOnlineSyncOnQuit(1000);
    assert.ok(p, 'има вървящо изпращане');
    setTimeout(release, 20);
    assert.equal(await p, true);
    assert.equal((await running).ok, true);
  });
  assert.equal(n, 1);
});

/* ======================================================================
   loans:extend → scheduleOnlineSync
   ====================================================================== */
test('loans:extend насрочва изпращане към моста (новият срок стига до приложението)', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const ipcMain = fakeIpcMain();
  const run = (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } };
  const common = { getDb: () => db, run, logAudit: () => {}, today: () => localDate() };
  const { circRule, readerCategory } = require('../handlers/circ-rules')(ipcMain, common);
  const { nextWorkDay, closedDaysBetween } = require('../handlers/calendar')(ipcMain, common);
  const holds = require('../handlers/holds')(ipcMain, Object.assign({ normalizeScanCode: (s) => s, scheduleCatalogWrite: () => {} }, common));
  let scheduled = 0;
  require('../handlers/loans')(ipcMain, Object.assign({
    logEvent: () => {}, BOOK_SELECT: '', scheduleCatalogWrite: () => {},
    circRule, readerCategory, nextWorkDay, closedDaysBetween, normalizeScanCode: (s) => s,
    firstActiveHold: holds.firstActiveHold, consumeHoldOnCheckout: holds.consumeHoldOnCheckout,
    activateHoldOnReturn: holds.activateHoldOnReturn, freeCopies: holds.freeCopies, activeHolds: holds.activeHolds,
    scheduleOnlineSync: () => { scheduled++; }
  }, common));
  const readerId = db.prepare("INSERT INTO readers (name, card_no, registered_at) VALUES ('Мария', 'R-1', ?)").run(localDate()).lastInsertRowid;
  const bookId = db.prepare("INSERT INTO books (inv_number, title, author) VALUES (1, 'Бай Ганьо', 'Алеко')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
  const d = new Date(); d.setDate(d.getDate() + 10);
  const due = localDate(d);
  const loanId = db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)').run(readerId, bookId, localDate(), due).lastInsertRowid;
  const r = ipcMain.invoke('loans:extend', { id: loanId });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(scheduled, 1, 'продължението на гишето насрочва изпращане');
  /* Отказ (лимит) — нищо не се е сменило, нищо не се насрочва. */
  db.prepare('UPDATE loans SET renewals = 99 WHERE id = ?').run(loanId);
  assert.equal(ipcMain.invoke('loans:extend', { id: loanId }).ok, false);
  assert.equal(scheduled, 1);
});

/* ======================================================================
   main.js — свързването (истинският main.js не може да се активира в тест:
   кодът за активация е подписан с ключа на разработчика)
   ====================================================================== */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const MAIN = stripComments(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'));

test('main.js: изпращане при стартиране и колоните на лекото изпращане', () => {
  const ready = MAIN.slice(MAIN.indexOf('app.whenReady()'), MAIN.indexOf("app.on('window-all-closed'"));
  assert.ok(ready.includes('scheduleStartupOnlineSync();'), 'app.whenReady() насрочва изпращането при стартиране');
  assert.ok(ready.indexOf('scheduleStartupOnlineSync();') < ready.indexOf('mainWindow = createWindow();'));
  assert.match(MAIN, /online_last_hash: 'TEXT',\s*online_last_full: 'TEXT',\s*online_bridge_features: 'TEXT'/,
    'идемпотентни колони (ensureColumns), без нова миграция');
});

test('main.js: при затваряне и при „Инсталирай и рестартирай“ насроченото изпращане се изчаква ПРЕДИ затварянето на базата', () => {
  const quit = MAIN.slice(MAIN.indexOf("app.on('window-all-closed'"));
  const iFlush = quit.indexOf('flushOnlineSyncOnQuit(ONLINE_QUIT_FLUSH_MS)');
  const iThen = quit.indexOf('pendingOnline.then(finishQuit, finishQuit)');
  const fin = MAIN.slice(MAIN.indexOf('function finishQuit()'));
  assert.ok(iFlush > 0 && iThen > iFlush);
  assert.ok(fin.indexOf('flushCatalogWrite()') > 0 && fin.indexOf('backupBeforeQuit()') > 0 && fin.indexOf('db.close()') > 0,
    'каталогът, копието и затварянето на базата са в продължението');
  assert.match(MAIN, /const ONLINE_QUIT_FLUSH_MS = 5000;/);
  const upd = MAIN.slice(MAIN.indexOf("ipcMain.handle('app:installUpdate'"));
  assert.ok(upd.indexOf('flushOnlineSyncOnQuit(ONLINE_QUIT_FLUSH_MS)') > 0
    && upd.indexOf('flushOnlineSyncOnQuit(ONLINE_QUIT_FLUSH_MS)') < upd.indexOf('autoUpdater.quitAndInstall()'));
});

/* ======================================================================
   Настройки → Онлайн достъп: „Последно изпратено“ и „без промени“
   ====================================================================== */
test('екранът: „Последно изпратено“ е последната връзка; при „без промени“ — бележка с момента на пълната снимка', async () => {
  const { buildDom, settle } = require('./helpers/audit-fixtures');
  const base = { activated: true, lib: 'yavorec', name: 'Библиотека', exp: '2099-12-31', bridgeUrl: BRIDGE,
    hasUploadKey: true, lastError: null, consentingReaders: 1, pending: false, bridgeFeatures: ['gzip', 'unchanged'] };
  const show = async (st) => {
    const dom = buildDom({ 'online.status': st });
    const { window } = dom; await settle();
    const box = window.document.createElement('div');
    box.id = 'onlineBox';
    window.document.body.appendChild(box);
    await window.loadOnlineBox(); await settle();
    return box.textContent.replace(/\s+/g, ' ');
  };
  let t = await show(Object.assign({}, base, { lastSync: '2026-10-10T08:20:00.000Z', lastFull: '2026-10-10T06:00:00.000Z' }));
  assert.match(t, /Последно изпратено: \d{2}\.\d{2}\.2026[^(]*\(без промени; последна пълна снимка: \d{2}\.\d{2}\.2026[^)]*\)\./);
  t = await show(Object.assign({}, base, { lastSync: '2026-10-10T06:00:00.000Z', lastFull: '2026-10-10T06:00:00.000Z' }));
  assert.match(t, /Последно изпратено: /);
  assert.doesNotMatch(t, /без промени/, 'последното е пълна снимка');
  t = await show(Object.assign({}, base, { lastSync: '2026-10-10T06:00:00.000Z', lastFull: null, bridgeFeatures: [] }));
  assert.doesNotMatch(t, /без промени/, 'стар мост / база отпреди v2.4.83 — както досега');
});
