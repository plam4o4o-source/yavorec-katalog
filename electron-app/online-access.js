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
function buildSnapshot(db, settings, nowIso, opts) {
  const { isEncryptedField } = require('./pii-crypto');
  const s = settings || {};
  const now = nowIso || new Date().toISOString();
  const today = require('./local-date').localDate();
  const readers = db.prepare(`
    SELECT id, card_no, name, category, registered_at, re_registered_at, status, suspended_until,
           online_pin_hash
      FROM readers
     WHERE online_consent = 1 AND online_pin_hash IS NOT NULL AND TRIM(online_pin_hash) <> ''
     ORDER BY id`).all();
  const loansByReader = db.prepare(`
    SELECT l.id, l.reader_id, l.date_out, l.date_due, l.renewals, b.inv_number, b.title, b.author
      FROM loans l JOIN books b ON b.id = l.book_id
     WHERE l.reader_id = ? AND l.date_in IS NULL AND (l.lost IS NULL OR l.lost = 0)
     ORDER BY l.date_due, l.id`);
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
          renewals: l.renewals || 0
        }))
      };
    })
  };
}

/* ---------------- Изпращане ----------------
   Никога не хвърля — резултатът отива в online_last_error и в дневника, а не
   в диалог пред библиотекаря (изпращането е фоново). 20 секунди таван: по
   бавна връзка в читалище заявката не бива да виси до безкрай. */
const SEND_TIMEOUT_MS = 20000;
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
    const res = await fetchFn(base + '/' + encodeURIComponent(library) + '/sync', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + uploadKey,
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'InvLib/' + ((opts && opts.version) || '0')
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const status = res.status;
    if (res.ok) return { ok: true, status, error: null };
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
  ACTIVATION_PUBLIC_KEY_B64, PIN_LENGTH, SEND_TIMEOUT_MS,
  generatePin, hashPin, verifyPin, verifyActivation, buildSnapshot, sendSnapshot, addOneYear
};
