'use strict';
/* ============================================================================
   ОНЛАЙН ДОСТЪП ЗА ЧИТАТЕЛИ — чистата част (без Electron), за да е тестваема.
   ============================================================================
   Мобилното приложение на читалището показва на читателя какво държи в
   момента и докога му е валидна картата. Данните НЕ се четат на живо от
   базата: InvLib периодично изпраща СНИМКА на съгласилите се читатели към
   мост (HTTPS), а приложението чете от моста. Тоест компютърът на
   библиотеката не е сървър, не отваря портове и не е достъпен отвън.

   Кое стои тук: хеш/проверка на ПИН, генериране на ПИН, проверка на кода за
   активация (Ed25519 подпис от разработчика), сглобяване на снимката от
   базата и изпращането ѝ. Кое НЕ стои тук: IPC каналите, насрочването и
   състоянието на сесията — те са в handlers/online-access.js и main.js.

   ГАРАНЦИЯТА ЗА ВСИЧКИ ДРУГИ БИБЛИОТЕКИ: без валиден код за активация нито
   една функция оттук не праща нищо и не се вика от нищо (виж activated() в
   handlers/online-access.js). Кодът е подписан с ключ, който само
   разработчикът има, и носи кода на конкретната библиотека и срок — тоест не
   може да се включи случайно, нито с чужд код.

   Договорът с моста (полета, хеш, код за активация) е описан в бележката към
   разработката на моста; тук се спазва буквално, без свои имена на полета. */
const crypto = require('crypto');
const zlib = require('zlib');

/* Публичният ключ на разработчика (SPKI DER, base64). Същият стои и в моста —
   той проверява кода още веднъж при всяко изпращане. Тестовете подават свой
   ключ през verifyActivation(token, lib, { publicKey }). */
const ACTIVATION_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAt+SQX8FBNWio/sP+A+eJocdPkgXA0hBUVOc7KpgLkn8=';
let cachedPublicKey = null;
function builtinPublicKey() {
  if (!cachedPublicKey) {
    cachedPublicKey = crypto.createPublicKey({
      key: Buffer.from(ACTIVATION_PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki'
    });
  }
  return cachedPublicKey;
}

/* ---------------- ПИН ----------------
   Шест цифри, случайни (crypto.randomInt, не Math.random). Пази се само хешът;
   самият ПИН се показва на библиотекаря веднъж и се дава на читателя. */
const PIN_LENGTH = 6;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

function generatePin() {
  return String(crypto.randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
}
/* "scrypt$N$r$p$<сол base64>$<хеш base64>" — форматът, който мостът разчита.
   N/r/p се записват в самия хеш, за да може някой ден да се вдигнат, без
   старите хешове да спрат да работят. */
function hashPin(pin) {
  const s = String(pin == null ? '' : pin);
  if (!/^\d{6}$/.test(s)) throw new Error('ПИН кодът трябва да е точно 6 цифри.');
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(s, salt, SCRYPT_KEYLEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}
function verifyPin(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (!(N > 0 && r > 0 && p > 0)) return false;
  let salt, expected;
  try { salt = Buffer.from(parts[4], 'base64'); expected = Buffer.from(parts[5], 'base64'); }
  catch (e) { return false; }
  if (!expected.length) return false;
  let actual;
  try { actual = crypto.scryptSync(String(pin == null ? '' : pin), salt, expected.length, { N, r, p }); }
  catch (e) { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ---------------- Код за активация ----------------
   base64url(JSON{lib,name,exp:"ГГГГ-ММ-ДД",iat}) + "." + base64url(подпис Ed25519
   върху base64url низа на товара). Връща винаги обект — никога не хвърля,
   защото се вика и при всяко стартиране (activated()), където грешен низ в
   настройките просто значи „не е активирано“. */
function verifyActivation(token, libraryCodeExpected, opts) {
  const fail = (error) => ({ ok: false, lib: null, name: null, exp: null, error });
  const s = String(token == null ? '' : token).trim();
  if (!s) return fail('Липсва код за активация.');
  const parts = s.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return fail('Кодът за активация не е в очаквания вид.');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch (e) { return fail('Кодът за активация не се разчита.'); }
  if (!payload || typeof payload !== 'object') return fail('Кодът за активация не се разчита.');
  let sigOk = false;
  try {
    const key = (opts && opts.publicKey) || builtinPublicKey();
    sigOk = crypto.verify(null, Buffer.from(parts[0]), key, Buffer.from(parts[1], 'base64url'));
  } catch (e) { sigOk = false; }
  if (!sigOk) return fail('Подписът на кода за активация не е валиден.');
  const lib = typeof payload.lib === 'string' ? payload.lib.trim() : '';
  const exp = typeof payload.exp === 'string' ? payload.exp : '';
  if (!lib) return fail('Кодът за активация не носи код на библиотека.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return fail('Кодът за активация няма валиден срок.');
  if (libraryCodeExpected && lib !== String(libraryCodeExpected).trim()) {
    return fail('Кодът за активация е за друга библиотека („' + lib + '“).');
  }
  const today = (opts && opts.today) || require('./local-date').localDate();
  if (exp < today) return fail('Срокът на кода за активация е изтекъл на ' + exp.split('-').reverse().join('.') + ' г.');
  return { ok: true, lib, name: typeof payload.name === 'string' ? payload.name : '', exp, error: null };
}

/* ---------------- Снимката ----------------
   Само читатели с online_consent = 1 И зададен ПИН. От картона излизат само
   номерът на картата, името, категорията, датите на записване и състоянието
   — нищо от чл. 42, ал. 3 (ЕГН, ЛК, адрес, телефон, имейл) не напуска
   компютъра. Името тук е чист текст (защитата с обща парола покрива само
   ЕГН/№ ЛК — виж handlers/pdp.js); ако някога и то бъде криптирано, мостът
   получава null, който приема. */
function addOneYear(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!(y > 0 && m > 0 && d > 0)) return null;
  const t = new Date(Date.UTC(y + 1, m - 1, d));
  /* 29.02 + 1 година → 01.03 по правилата на Date; за валидност на карта е
     приемливо и еднозначно. */
  return t.toISOString().slice(0, 10);
}
function readerStatus(r, validUntil, today) {
  if (r.suspended_until && r.suspended_until > today) return 'suspended';
  if (r.status && r.status !== 'активен') return 'expired';
  if (!validUntil || validUntil < today) return 'expired';
  return 'active';
}
/* v2.4.81: към всяко отворено заемане — `canRenew` (може ли читателят да го
   удължи от приложението; смята се с opts.canRenew — вратата renewGate от
   handlers/loans.js, същата като на гишето; без подадена функция е false, тоест
   приложението праща читателя на гишето), а към читателя — `history`: до 200
   ПРИКЛЮЧЕНИ заемания (date_in NOT NULL, най-новите първи). Историята е само
   за читатели, които и без това са в снимката, и носи само документа и
   датите — нищо ново от картона. */
const HISTORY_LIMIT = 200;
/* v2.4.82: личните съобщения от библиотеката (таблица reader_messages) — към
   всеки читател от снимката `messages`: най-новите първи, най-много 50, само
   неоттеглените и само изпратените през последните 180 дни (договорът с моста,
   раздел 1). Старото съобщение не изчезва от картона в InvLib — просто вече не
   пътува. `title` може да е празен низ; `readAt` е ISO момент или null. */
const MESSAGES_LIMIT = 50;
const MESSAGES_MAX_AGE_DAYS = 180;
function buildSnapshot(db, settings, nowIso, opts) {
  const { isEncryptedField } = require('./pii-crypto');
  const s = settings || {};
  const now = nowIso || new Date().toISOString();
  const today = require('./local-date').localDate();
  const canRenew = opts && typeof opts.canRenew === 'function' ? opts.canRenew : () => false;
  const readers = db.prepare(`
    SELECT id, card_no, name, category, registered_at, re_registered_at, status, suspended_until,
           online_pin_hash
      FROM readers
     WHERE online_consent = 1 AND online_pin_hash IS NOT NULL AND TRIM(online_pin_hash) <> ''
     ORDER BY id`).all();
  const loansByReader = db.prepare(`
    SELECT l.id, l.reader_id, l.book_id, l.date_out, l.date_due, l.date_in, l.renewals, b.inv_number, b.title, b.author
      FROM loans l JOIN books b ON b.id = l.book_id
     WHERE l.reader_id = ? AND l.date_in IS NULL AND (l.lost IS NULL OR l.lost = 0)
     ORDER BY l.date_due, l.id`);
  const historyByReader = db.prepare(`
    SELECT l.id, l.date_out, l.date_in, b.inv_number, b.title, b.author
      FROM loans l JOIN books b ON b.id = l.book_id
     WHERE l.reader_id = ? AND l.date_in IS NOT NULL
     ORDER BY l.date_in DESC, l.id DESC
     LIMIT ${HISTORY_LIMIT}`);
  /* Таблицата я има във всяка база, отворена от v2.4.82 (schema.sql); проверката
     е само за да не падне снимката, ако някой я извика върху по-стара база. */
  const hasMessages = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reader_messages'").get();
  const nowMs = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now();
  const messagesSince = new Date(nowMs - MESSAGES_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const messagesByReader = hasMessages ? db.prepare(`
    SELECT id, title, body, created_at, read_at
      FROM reader_messages
     WHERE reader_id = ? AND withdrawn_at IS NULL AND created_at >= ?
     ORDER BY created_at DESC, id DESC
     LIMIT ${MESSAGES_LIMIT}`) : null;
  const act = verifyActivation(s.online_activation, null, opts);
  return {
    library: act.ok ? act.lib : '',   // кодът на библиотеката идва само от подписания код за активация
    generated: now,
    activation: s.online_activation || '',
    libraryName: s.lib_name || s.org || '',
    readers: readers.map(r => {
      const since = r.re_registered_at || r.registered_at || null;
      const validUntil = since ? addOneYear(since) : null;
      const nameOk = r.name && !isEncryptedField(r.name);
      return {
        readerId: String(r.id),
        cardNumber: r.card_no || '',
        pinHash: r.online_pin_hash,
        fullName: nameOk ? r.name : null,
        category: r.category || null,
        registeredOn: r.registered_at || null,
        validUntil,
        status: readerStatus(r, validUntil, today),
        loans: loansByReader.all(r.id).map(l => ({
          loanId: String(l.id),
          inv: l.inv_number,
          title: l.title || '',
          author: l.author || '',
          dateOut: l.date_out,
          dateDue: l.date_due,
          renewals: l.renewals || 0,
          canRenew: (() => { try { return !!canRenew(l); } catch (e) { return false; } })()
        })),
        history: historyByReader.all(r.id).map(l => ({
          loanId: String(l.id),
          inv: l.inv_number,
          title: l.title || '',
          author: l.author || '',
          dateOut: l.date_out,
          dateIn: l.date_in
        })),
        messages: messagesByReader ? messagesByReader.all(r.id, messagesSince).map(m => ({
          messageId: String(m.id),
          title: m.title || '',
          text: m.body || '',
          at: m.created_at,
          readAt: m.read_at || null
        })) : []
      };
    })
  };
}

/* ---------------- Отпечатък на снимката (v2.4.83) ----------------
   sha256 върху КАНОНИЧНИЯ JSON на тялото (ключовете на всеки обект подредени,
   без празни места) БЕЗ `generated`, `activation` и `requestResults`: първото
   се сменя при всяко сглобяване, второто е подписът, а не данните, а третото
   е отговор на заявки, не съдържание на снимката (самото поле `hash`, което
   пълната снимка носи, също е извън — то е резултатът). Тоест две сглобявания върху
   непроменена база дават един и същ отпечатък, а всяка промяна, която стига
   до приложението (заемане, срок, съобщение, „прочетено“, име на библиотеката),
   го сменя. По него handlers/online-access.js решава дали да прати пълната
   снимка или само лекото „без промени“ (договорът с моста, раздел InvLib/1).
   Подредбата на ключовете е нарочна: отпечатъкът не бива да зависи от реда, в
   който кодът е сглобил полетата — иначе безобидно пренареждане в
   buildSnapshot би пратило пълна снимка на всяка инсталация „за нищо“. */
const HASH_EXCLUDED_KEYS = ['generated', 'activation', 'requestResults', 'hash'];
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') {
    /* undefined (поле без стойност) и функции JSON.stringify пропуска в обект и
       прави на null в масив — тук същото, за да е отпечатъкът на изпратеното. */
    const j = JSON.stringify(v);
    return j === undefined ? 'null' : j;
  }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
function snapshotHash(body) {
  const b = body && typeof body === 'object' ? body : {};
  /** @type {Record<string, unknown>} */
  const rest = {};
  for (const k of Object.keys(b)) if (!HASH_EXCLUDED_KEYS.includes(k)) rest[k] = b[k];
  return crypto.createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex');
}
/* Лекото тяло „без промени“ (мостът с features "unchanged"): снимката на моста
   не се презаписва, но заявките се обменят — затова requestResults пътуват и
   тук (празен масив, ако няма). Няма `readers` и `generated`. */
function unchangedBody(body, hash, requestResults) {
  return {
    library: body.library,
    activation: body.activation,
    unchanged: true,
    hash,
    requestResults: Array.isArray(requestResults) ? requestResults : []
  };
}

/* ---------------- Изпращане ----------------
   Никога не хвърля — резултатът отива в online_last_error и в дневника, а не
   в диалог пред библиотекаря (изпращането е фоново). 20 секунди таван: по
   бавна връзка в читалище заявката не бива да виси до безкрай.
   При успех връща и `requests` — заявките на читателите от отговора на моста
   (виж бележката долу).
   v2.4.83: opts.gzip — тялото тръгва компресирано (`Content-Encoding: gzip`);
   handlers/online-access.js го подава само ако мостът е обявил "gzip" в
   `features`. Отговорът връща и `features` (масив от низове или null, ако
   мостът не ги обявява — тогава всичко е както до v2.4.82) и `needFull`. */
const SEND_TIMEOUT_MS = 20000;
/** @param {any} j @returns {string[] | null} */
function featuresFrom(j) {
  if (!j || !Array.isArray(j.features)) return null;
  return j.features.filter(/** @param {unknown} f */ (f) => typeof f === 'string' && f.length > 0 && f.length <= 40).slice(0, 20);
}
async function sendSnapshot(bridgeUrl, library, uploadKey, body, opts) {
  const base = String(bridgeUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) return { ok: false, status: 0, error: 'Адресът на моста трябва да започва с https://.' };
  if (!library) return { ok: false, status: 0, error: 'Липсва код на библиотеката.' };
  if (!uploadKey) return { ok: false, status: 0, error: 'Липсва ключ за качване.' };
  const fetchFn = (opts && opts.fetch) || globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, status: 0, error: 'Изпращането не е поддържано в тази среда.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || SEND_TIMEOUT_MS);
  try {
    /** @type {Record<string, string>} */
    const headers = {
      'Authorization': 'Bearer ' + uploadKey,
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'InvLib/' + ((opts && opts.version) || '0')
    };
    const json = JSON.stringify(body);
    /** @type {string | Uint8Array} */
    let payload = json;
    if (opts && opts.gzip) {
      payload = new Uint8Array(zlib.gzipSync(Buffer.from(json, 'utf8')));
      headers['Content-Encoding'] = 'gzip';
      /* НЕ application/json: хостингът на моста (Vercel) разчита такова тяло сам,
         преди мостът да го разархивира, и мостът отказва gzip + json с 415. */
      headers['Content-Type'] = 'application/octet-stream';
    }
    const res = await fetchFn(base + '/' + encodeURIComponent(library) + '/sync', {
      method: 'POST',
      headers,
      body: payload,
      signal: ctrl.signal
    });
    const status = res.status;
    if (res.ok) {
      /* v2.4.81: отговорът на моста носи заявките на читателите („удължи“; от
         v2.4.82 и „прочетено“ за лично съобщение) — handlers/online-access.js
         ги обработва след всяко успешно изпращане. Тяло, което не е JSON или няма масив requests, значи „няма
         заявки“, не грешка. */
      let requests = [];
      /** @type {string[] | null} */
      let features = null;
      let needFull = false;
      try {
        const j = await res.json();
        if (j && Array.isArray(j.requests)) requests = j.requests;
        features = featuresFrom(j);
        needFull = !!(j && j.needFull === true);
      }
      catch (e) { /* мост без заявки или с празно тяло */ }
      return { ok: true, status, error: null, requests, features, needFull,
        bytes: typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : payload.length };
    }
    let detail = '';
    try { const j = await res.json(); detail = j && (j.message || j.error) ? String(j.message || j.error) : ''; }
    catch (e) { /* тялото не е JSON — стига кодът */ }
    const known = {
      401: 'Мостът отхвърли ключа за качване или кода на библиотеката.',
      403: 'Мостът отхвърли кода за активация (библиотеката не е активна).',
      413: 'Снимката е твърде голяма за моста (над 2 МБ).',
      422: 'Мостът не прие тялото на заявката.'
    };
    return { ok: false, status, error: (known[status] || 'Мостът върна грешка ' + status + '.') + (detail ? ' (' + detail + ')' : '') };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'Мостът не отговори до ' + Math.round(SEND_TIMEOUT_MS / 1000) + ' секунди.' : (err && err.message) || String(err);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ACTIVATION_PUBLIC_KEY_B64, PIN_LENGTH, SEND_TIMEOUT_MS, HISTORY_LIMIT, MESSAGES_LIMIT, MESSAGES_MAX_AGE_DAYS,
  generatePin, hashPin, verifyPin, verifyActivation, buildSnapshot, sendSnapshot, addOneYear,
  canonicalJson, snapshotHash, unchangedBody, HASH_EXCLUDED_KEYS
};
