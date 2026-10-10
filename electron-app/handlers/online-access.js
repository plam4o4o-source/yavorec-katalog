// Онлайн достъп за читатели (мобилно приложение) — IPC каналите и фоновото
// изпращане. Чистата логика (хеш на ПИН, проверка на кода за активация,
// сглобяване и изпращане на снимката) е в online-access.js.
//
// ГАРАНЦИЯТА ЗА ВСИЧКИ ДРУГИ БИБЛИОТЕКИ. Всяко действие тук минава през
// activated(): без валиден код за активация в settings.online_activation
// (подпис на разработчика + срок) online:status връща activated:false, а
// останалите канали отказват; насрочването (scheduleSync) и таймерът не
// правят нищо. Екраните показват раздела само при activated:true. Тоест за
// библиотека, която не е въвела код, не съществува нито поле, нито заявка
// навън, нито ред в одитната следа.
//
// Ключът за качване (online_upload_key) нарочно НЕ минава през settings:update
// — така не влиза в общата форма на Настройки, в диференца на одитната следа
// и в „Пълен износ“ по случайност; записва се само през online:updateSettings
// и никога не се връща към екрана (status връща само дали е зададен).
//
// ЗАЯВКИ ОТ ЧИТАТЕЛИТЕ (v2.4.81). Отговорът на моста при всяко изпращане носи
// requests: [{id, type:"renew", readerId, cardNumber, loanId, inv, at}] —
// натиснатото „Удължи“ в приложението. Те се обработват веднага след успешното
// изпращане с renewFromApp от handlers/loans.js (същата врата като гишето) и
// резултатът {id, status:"done"|"rejected", reason} тръгва към моста с ново,
// незабавно изпращане (requestResults + обновените заемания). Всеки резултат се
// пази в online_request_results, за да е обработката идемпотентна: мостът може
// да повтори заявка (мрежата е прекъснала преди отговора ни), а тя не бива да
// удължи втори път — връща се същият резултат. Нищо от това не се вика без
// код за активация: стои вътре в syncOnce, след activated().
//
// ЛИЧНИ СЪОБЩЕНИЯ ДО ЧИТАТЕЛ (v2.4.82). Библиотекарят пише от картона на
// читателя (online:sendMessage); съобщението се пази в reader_messages, пътува
// в снимката (buildSnapshot → readers[].messages) и се вижда само от този
// читател след вход. Отварянето му в приложението идва обратно като заявка
// {type:"messageRead", readerId, cardNumber, messageId, at} в същия масив
// requests и се обработва в processRequests със същите проверки като „удължи“
// (съгласие + ПИН + картата) — read_at се записва веднъж (COALESCE) и отговорът
// се пази в online_request_results. Съобщение до читател без онлайн достъп се
// отказва още при писането: той никога не би го видял.
const {
  generatePin, hashPin, verifyActivation, buildSnapshot, sendSnapshot
} = require('../online-access');

const PERIODIC_MS = 30 * 60 * 1000;   // редовно изпращане на половин час, само при активирано
/* Таваните на личното съобщение (v2.4.82) — същите като на моста (договорът,
   раздел 1): заглавие до 120 знака, текст до 2000. */
const MESSAGE_TITLE_MAX = 120;
const MESSAGE_TEXT_MAX = 2000;
/* Колко съобщения показва картонът (най-новите първи). Читател с повече —
   по-старите остават в базата, просто не се изчертават. */
const MESSAGE_LIST_LIMIT = 200;

/** @param {any} ipcMain @param {HandlerDeps} deps */
module.exports = function registerOnlineAccessHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;
  const appVersion = typeof deps.getVersion === 'function' ? deps.getVersion : () => '0';
  const log = typeof deps.log === 'function' ? deps.log : (level, msg) => console[level === 'error' ? 'error' : 'log'](msg);
  /* Само за тестовете: ключ, с който да се проверява кодът за активация, вместо
     вградения на разработчика. main.js не подава нищо тук. */
  const verifyOpts = deps.activationPublicKey ? { publicKey: deps.activationPublicKey } : undefined;
  /* Вратата и действието за „Удължи“ (v2.4.81) идват от handlers/loans.js, който
     main.js регистрира ПО-КЪСНО — затова се подават като обвивка и се четат чак
     при изпращане. Без тях (по-стар main.js, отделни тестове) canRenew е false
     и заявките не се обработват. */
  const loanTools = () => {
    try { const t = typeof deps.loanTools === 'function' ? deps.loanTools() : null; return t || null; }
    catch (e) { return null; }
  };

  function settingsRow() {
    return getDb().prepare(`SELECT lib_name, org, online_bridge_url, online_upload_key, online_activation,
      online_last_sync, online_last_error FROM settings WHERE id = 1`).get() || {};
  }
  /* Единствената врата. Връща проверения товар на кода или null. Не хвърля —
     вика се при всяко насрочване и от таймера. */
  function activated(s) {
    try {
      const row = s || settingsRow();
      if (!row.online_activation) return null;
      const v = verifyActivation(row.online_activation, null, verifyOpts);
      return v.ok ? v : null;
    } catch (e) { return null; }
  }
  function consentingCount() {
    return getDb().prepare(`SELECT COUNT(*) AS n FROM readers
      WHERE online_consent = 1 AND online_pin_hash IS NOT NULL AND TRIM(online_pin_hash) <> ''`).get().n;
  }
  function requireActivated() {
    const act = activated();
    if (!act) throw new Error('Онлайн достъпът за читатели не е активиран за тази библиотека.');
    return act;
  }
  function setSyncResult(when, error) {
    getDb().prepare('UPDATE settings SET online_last_sync = ?, online_last_error = ? WHERE id = 1').run(when, error);
  }

  /* ---------------- Изпращане ----------------
     Едно по едно: ако вече тече изпращане, второто изчаква края му и тръгва
     веднага след това (промяната, която го е насрочила, може да е станала
     след сглобяването на снимката). Никога не хвърля. */
  /* ---------------- Заявки от читателите ----------------
     Таблицата се създава и от schema.sql; тук — идемпотентно, за база, отворена
     от по-стара станция в обща мрежова папка (същото правило като колоните
     online_* в main.js: без вдигане на user_version). */
  let requestTableChecked = null;
  function ensureRequestTable(db) {
    if (requestTableChecked === db) return;
    db.exec(`CREATE TABLE IF NOT EXISTS online_request_results (
      id     TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reason TEXT,
      at     TEXT NOT NULL
    )`);
    requestTableChecked = db;
  }
  /* Личните съобщения (v2.4.82) — същото правило: schema.sql я създава при
     всяко отваряне, а тук тя се осигурява и преди всяко ползване, за база в
     обща мрежова папка, отворена от станция с по-стара версия. Без вдигане на
     user_version. */
  let messagesTableChecked = null;
  function ensureMessagesTable(db) {
    if (messagesTableChecked === db) return;
    db.exec(`CREATE TABLE IF NOT EXISTS reader_messages (
      id           INTEGER PRIMARY KEY,
      reader_id    INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
      title        TEXT,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      read_at      TEXT,
      withdrawn_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reader_messages_reader ON reader_messages(reader_id);`);
    messagesTableChecked = db;
  }
  /* Моментът „прочетено“ от заявката — ISO, ако се чете като дата и не е в
     бъдещето (часовник на телефон, избързал с часове); иначе — сега. */
  function readMoment(at) {
    const now = Date.now();
    const t = typeof at === 'string' && at ? Date.parse(at) : NaN;
    return new Date(Number.isFinite(t) && t <= now ? t : now).toISOString();
  }
  /** @param {any[]} requests @returns {{ results: OnlineRequestResult[], fresh: number }} */
  function processRequests(requests) {
    const db = getDb();
    ensureRequestTable(db);
    ensureMessagesTable(db);
    const tools = loanTools();
    const seen = db.prepare('SELECT id, status, reason FROM online_request_results WHERE id = ?');
    const save = db.prepare('INSERT OR IGNORE INTO online_request_results (id, status, reason, at) VALUES (?, ?, ?, ?)');
    const consentingReader = db.prepare(`SELECT id, card_no FROM readers WHERE id = ? AND online_consent = 1
      AND online_pin_hash IS NOT NULL AND TRIM(online_pin_hash) <> ''`);
    /* „Прочетено“ (v2.4.82): само съобщение на СЪЩИЯ читател; COALESCE пази
       първия момент — повторно отваряне не го мести. */
    const markRead = db.prepare(`UPDATE reader_messages SET read_at = COALESCE(read_at, ?)
      WHERE id = ? AND reader_id = ?`);
    /** @type {OnlineRequestResult[]} */
    const results = [];
    let fresh = 0;
    for (const r of requests) {
      const id = r && r.id != null ? String(r.id) : '';
      if (!id) continue;
      const prev = seen.get(id);
      if (prev) {
        results.push(prev.status === 'done' ? { id, status: 'done' } : { id, status: 'rejected', reason: prev.reason || '' });
        continue;
      }
      let out;
      /* Читателят трябва да е от снимката (съгласие + ПИН) и картата — неговата:
         заявка за чужд читател или с чужда карта не стига до заемането. */
      const rd = r.readerId != null ? consentingReader.get(String(r.readerId)) : null;
      const cardOk = rd && (!r.cardNumber || !rd.card_no || String(r.cardNumber) === String(rd.card_no));
      if (r.type === 'renew') {
        if (!rd || !cardOk) out = { status: 'rejected', reason: 'не е намерена' };
        else if (!tools || typeof tools.renewFromApp !== 'function') out = { status: 'rejected', reason: 'удължаването от приложението не е налично' };
        else {
          try { out = tools.renewFromApp(r.loanId, r.readerId); }
          catch (err) {
            log('error', '[онлайн достъп] заявка ' + id + ' не се обработи: ' + (err && err.message));
            out = { status: 'rejected', reason: 'грешка при обработката' };
          }
        }
      } else if (r.type === 'messageRead') {
        /* Чужд читател, чужда карта, чуждо или липсващо съобщение — един и същ
           отказ: приложението не бива да научава чии са другите номера. */
        const msgId = r.messageId != null && /^\d+$/.test(String(r.messageId)) ? Number(r.messageId) : null;
        if (!rd || !cardOk || msgId == null) out = { status: 'rejected', reason: 'съобщението не е намерено' };
        else {
          try {
            const n = markRead.run(readMoment(r.at), msgId, rd.id).changes;
            out = n ? { status: 'done' } : { status: 'rejected', reason: 'съобщението не е намерено' };
          } catch (err) {
            log('error', '[онлайн достъп] заявка ' + id + ' не се обработи: ' + (err && err.message));
            out = { status: 'rejected', reason: 'грешка при обработката' };
          }
        }
      } else {
        out = { status: 'rejected', reason: 'непознат вид заявка' };
      }
      const done = out && out.status === 'done';
      save.run(id, done ? 'done' : 'rejected', done ? null : String((out && out.reason) || ''), new Date().toISOString());
      fresh++;
      results.push(done ? { id, status: 'done' } : { id, status: 'rejected', reason: String((out && out.reason) || '') });
    }
    return { results, fresh };
  }
  const MAX_FOLLOWUPS = 3;   // отговор → нови заявки → отговор …: таван на веригата в едно изпращане

  let inFlight = null;
  let rerun = false;
  /** @param {string} reason @param {{ requestResults?: OnlineRequestResult[], depth?: number }} [extra] */
  async function syncOnce(reason, extra) {
    const s = settingsRow();
    const act = activated(s);
    if (!act) return { ok: false, skipped: true, error: 'не е активирано' };
    if (!s.online_bridge_url || !s.online_upload_key) {
      return { ok: false, skipped: true, error: 'няма адрес на моста или ключ за качване' };
    }
    let body;
    try {
      const tools = loanTools();
      body = buildSnapshot(getDb(), s, new Date().toISOString(),
        Object.assign({}, verifyOpts || {}, tools && typeof tools.canRenew === 'function' ? { canRenew: tools.canRenew } : {}));
      if (extra && extra.requestResults) body.requestResults = extra.requestResults;
    } catch (err) {
      const msg = 'Снимката не можа да се сглоби: ' + (err && err.message ? err.message : String(err));
      try { setSyncResult(s.online_last_sync || null, msg); } catch (e) { /* базата е заета — ще се повтори */ }
      log('error', '[онлайн достъп] ' + msg);
      return { ok: false, status: 0, error: msg };
    }
    const res = await sendSnapshot(s.online_bridge_url, act.lib, s.online_upload_key, body, { version: appVersion() });
    try {
      if (res.ok) setSyncResult(body.generated, null);
      else setSyncResult(s.online_last_sync || null, res.error);
    } catch (e) { log('error', '[онлайн достъп] резултатът не се записа: ' + e.message); }
    if (res.ok) log('info', '[онлайн достъп] изпратена снимка (' + reason + '): ' + body.readers.length + ' читатели');
    else log('error', '[онлайн достъп] изпращането (' + reason + ') не успя: ' + res.error);
    /* Заявките от читателите (v2.4.81): обработват се и резултатът тръгва
       веднага с ново изпращане. Повторно получени (вече обработени) заявки се
       отговарят, но не пораждат ново изпращане — иначе мост, който ги задържа
       до потвърждение, би въртял веригата до безкрай. */
    if (res.ok && Array.isArray(res.requests) && res.requests.length) {
      const depth = (extra && extra.depth) || 0;
      let processed = null;
      try { processed = processRequests(res.requests); }
      catch (err) { log('error', '[онлайн достъп] заявките не се обработиха: ' + (err && err.message)); }
      if (processed && processed.results.length) {
        log('info', '[онлайн достъп] заявки от приложението: ' + processed.results.length + ' (нови: ' + processed.fresh + ')');
        if (processed.fresh > 0 && depth < MAX_FOLLOWUPS) {
          const again = await syncOnce('отговор на заявки', { requestResults: processed.results, depth: depth + 1 });
          return Object.assign({}, res, { requests: [], followUp: again });
        }
      }
    }
    return res;
  }
  function sync(reason) {
    if (inFlight) { rerun = true; return inFlight; }
    inFlight = (async () => {
      try { return await syncOnce(reason); }
      catch (err) {
        /* syncOnce не хвърля по замисъл; това е последната мрежа. */
        log('error', '[онлайн достъп] неочаквана грешка: ' + (err && err.message));
        return { ok: false, status: 0, error: err && err.message };
      } finally {
        inFlight = null;
        if (rerun) { rerun = false; sync('повторно след промяна'); }
      }
    })();
    return inFlight;
  }

  /* ---------------- Насрочване ----------------
     main.js подава createDebouncer (виж debounce.js) — тук само се решава
     дали изобщо има какво да се насрочва. Без активация всяко повикване е
     празно и евтино (един SELECT на ред 1 от settings). */
  const DEBOUNCE_MS = typeof deps.debounceMs === 'number' ? deps.debounceMs : 60 * 1000;
  const debouncer = typeof deps.createDebouncer === 'function'
    ? deps.createDebouncer(() => { sync('след промяна'); }, DEBOUNCE_MS)
    : null;
  function scheduleSync() {
    if (!debouncer) return false;
    if (!activated()) return false;
    debouncer.schedule();
    return true;
  }
  let periodic = null;
  function startPeriodicTimer() {
    if (periodic) return;
    periodic = setInterval(() => { if (activated()) sync('по таймер'); }, PERIODIC_MS);
    if (periodic.unref) periodic.unref();
  }
  function stopPeriodicTimer() {
    if (periodic) { clearInterval(periodic); periodic = null; }
  }

  /* ---------------- Канали ---------------- */
  ipcMain.handle('online:status', /** @returns {IpcReply<'online:status'>} */ () => run(() => {
    const s = settingsRow();
    const act = activated(s);
    if (!act) return { activated: false };
    return {
      activated: true, lib: act.lib, name: act.name, exp: act.exp,
      bridgeUrl: s.online_bridge_url || '',
      hasUploadKey: !!s.online_upload_key,
      lastSync: s.online_last_sync || null,
      lastError: s.online_last_error || null,
      consentingReaders: consentingCount(),
      pending: !!(debouncer && debouncer.pending())
    };
  }));

  ipcMain.handle('online:activate', /** @param {unknown} e @param {IpcArg<'online:activate'>} arg @returns {IpcReply<'online:activate'>} */ (e, arg) => run(() => {
    const token = String((arg && arg.token) || '').trim();
    const v = verifyActivation(token, null, verifyOpts);
    if (!v.ok) throw new Error(v.error);
    getDb().prepare('UPDATE settings SET online_activation = ?, online_last_error = NULL WHERE id = 1').run(token);
    logAudit('Онлайн достъп за читатели', 'активиран с код за библиотека „' + v.lib + '“ (' + (v.name || '') + '), валиден до ' + v.exp);
    startPeriodicTimer();
    return { lib: v.lib, name: v.name, exp: v.exp };
  }));

  ipcMain.handle('online:deactivate', /** @returns {IpcReply<'online:deactivate'>} */ () => run(() => {
    const s = settingsRow();
    /* Без проверка на срока: изтекъл код също трябва да може да се махне. */
    getDb().prepare('UPDATE settings SET online_activation = NULL, online_last_error = NULL WHERE id = 1').run();
    stopPeriodicTimer();
    if (s.online_activation) logAudit('Онлайн достъп за читатели', 'деактивиран; програмата спира да изпраща снимки към моста');
  }));

  ipcMain.handle('online:updateSettings', /** @param {unknown} e @param {IpcArg<'online:updateSettings'>} o @returns {IpcReply<'online:updateSettings'>} */ (e, o) => run(() => {
    requireActivated();
    const url = String((o && o.online_bridge_url) || '').trim().replace(/\/+$/, '');
    if (url && !/^https:\/\//i.test(url)) throw new Error('Адресът на моста трябва да започва с https://.');
    const db = getDb();
    /* Празен ключ във формата = „не го сменяй“ — полето никога не показва
       записания ключ, така че празно значи само, че не е въведен нов. */
    const key = o && typeof o.online_upload_key === 'string' ? o.online_upload_key.trim() : '';
    if (key) db.prepare('UPDATE settings SET online_bridge_url = ?, online_upload_key = ? WHERE id = 1').run(url || null, key);
    else db.prepare('UPDATE settings SET online_bridge_url = ? WHERE id = 1').run(url || null);
    logAudit('Онлайн достъп за читатели', 'настройки: адрес на моста ' + (url || '—') + (key ? '; ключът за качване е сменен' : ''));
    scheduleSync();
  }));

  ipcMain.handle('online:setReaderConsent', /** @param {unknown} e @param {IpcArg<'online:setReaderConsent'>} arg @returns {IpcReply<'online:setReaderConsent'>} */ (e, arg) => run(() => {
    requireActivated();
    const db = getDb();
    const r = db.prepare('SELECT id, name, card_no, gdpr_consent, online_consent FROM readers WHERE id = ?').get(arg.readerId);
    if (!r) throw new Error('Читателят не е намерен.');
    const consent = arg.consent ? 1 : 0;
    if (consent && !r.gdpr_consent) {
      throw new Error('Първо запишете общото съгласие за обработване на лични данни (чл. 47, ал. 2) — онлайн достъпът е допълнително съгласие към него.');
    }
    const date = consent ? (String(arg.date || '').trim() || today()) : null;
    if (date && date > today()) throw new Error('Датата на съгласието не може да е в бъдещето.');
    db.prepare('UPDATE readers SET online_consent = ?, online_consent_date = ? WHERE id = ?').run(consent, date, r.id);
    logAudit('Онлайн достъп за читатели', 'карта ' + (r.card_no || '') + ' — ' + r.name
      + (consent ? ': дадено съгласие за онлайн достъп (' + date + ')' : ': оттеглено съгласие за онлайн достъп'));
    scheduleSync();
    return { online_consent: consent, online_consent_date: date };
  }));

  /* Връща ПИН-а ВЕДНЪЖ — в базата остава само хешът, в следата — само фактът. */
  ipcMain.handle('online:issuePin', /** @param {unknown} e @param {IpcArg<'online:issuePin'>} arg @returns {IpcReply<'online:issuePin'>} */ (e, arg) => run(() => {
    requireActivated();
    const db = getDb();
    const r = db.prepare('SELECT id, name, card_no, online_consent FROM readers WHERE id = ?').get(arg.readerId);
    if (!r) throw new Error('Читателят не е намерен.');
    if (!r.online_consent) throw new Error('Първо отбележете съгласието на читателя за онлайн достъп.');
    if (!r.card_no) throw new Error('Читателят няма номер на читателска карта — с него влиза в приложението.');
    const pin = generatePin();
    const at = today();
    db.prepare('UPDATE readers SET online_pin_hash = ?, online_pin_set_at = ? WHERE id = ?').run(hashPin(pin), at, r.id);
    logAudit('Издаден ПИН за онлайн достъп', 'карта ' + (r.card_no || '') + ' — ' + r.name);
    scheduleSync();
    return { pin, cardNumber: r.card_no, setAt: at };
  }));

  ipcMain.handle('online:revokePin', /** @param {unknown} e @param {IpcArg<'online:revokePin'>} arg @returns {IpcReply<'online:revokePin'>} */ (e, arg) => run(() => {
    requireActivated();
    const db = getDb();
    const r = db.prepare('SELECT id, name, card_no FROM readers WHERE id = ?').get(arg.readerId);
    if (!r) throw new Error('Читателят не е намерен.');
    db.prepare('UPDATE readers SET online_pin_hash = NULL, online_pin_set_at = NULL WHERE id = ?').run(r.id);
    logAudit('Отменен ПИН за онлайн достъп', 'карта ' + (r.card_no || '') + ' — ' + r.name);
    scheduleSync();
  }));

  /* ---------------- Лични съобщения до читател (v2.4.82) ----------------
     Списъкът е за картона: всички съобщения на читателя (и оттеглените, и
     по-старите от 180 дни, които вече не пътуват), най-новите първи. */
  const MESSAGE_COLS = 'id, reader_id, title, body, created_at, read_at, withdrawn_at';
  ipcMain.handle('online:messages', /** @param {unknown} e @param {IpcArg<'online:messages'>} arg @returns {IpcReply<'online:messages'>} */ (e, arg) => run(() => {
    requireActivated();
    const db = getDb();
    ensureMessagesTable(db);
    return db.prepare(`SELECT ${MESSAGE_COLS} FROM reader_messages WHERE reader_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ${MESSAGE_LIST_LIMIT}`).all(arg.readerId);
  }));

  /* Изпращане: читателят трябва да има онлайн достъп (съгласие + ПИН) — иначе
     съобщението не влиза в снимката и той никога не би го видял, а
     библиотекарят би мислил, че е съобщил. В следата — кой читател, номерът и
     заглавието на съобщението; самият текст НЕ (той е в reader_messages и
     отпада с читателя, а следата се пази години). */
  ipcMain.handle('online:sendMessage', /** @param {unknown} e @param {IpcArg<'online:sendMessage'>} arg @returns {IpcReply<'online:sendMessage'>} */ (e, arg) => run(() => {
    requireActivated();
    const db = getDb();
    ensureMessagesTable(db);
    const r = db.prepare('SELECT id, name, card_no, online_consent, online_pin_hash FROM readers WHERE id = ?').get(arg && arg.readerId);
    if (!r) throw new Error('Читателят не е намерен.');
    if (!r.online_consent || !r.online_pin_hash || !String(r.online_pin_hash).trim()) {
      throw new Error('Читателят няма онлайн достъп (съгласие и ПИН) и няма да види съобщението. '
        + 'Първо отбележете съгласието му за онлайн достъп и издайте ПИН.');
    }
    const clean = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
    const title = clean(arg.title);
    const text = clean(arg.text);
    if (!text) throw new Error('Напишете текста на съобщението.');
    if (title.length > MESSAGE_TITLE_MAX) {
      throw new Error('Заглавието е твърде дълго: ' + title.length + ' знака (най-много ' + MESSAGE_TITLE_MAX + ').');
    }
    if (text.length > MESSAGE_TEXT_MAX) {
      throw new Error('Текстът е твърде дълъг: ' + text.length + ' знака (най-много ' + MESSAGE_TEXT_MAX + ').');
    }
    const at = new Date().toISOString();
    const id = db.prepare('INSERT INTO reader_messages (reader_id, title, body, created_at) VALUES (?, ?, ?, ?)')
      .run(r.id, title || null, text, at).lastInsertRowid;
    logAudit('Съобщение до читател', r.name + ' (карта ' + (r.card_no || '') + '): съобщение № ' + id
      + (title ? ' „' + title + '“' : ' (без заглавие)'));
    scheduleSync();
    return db.prepare(`SELECT ${MESSAGE_COLS} FROM reader_messages WHERE id = ?`).get(id);
  }));

  /* Оттегляне: редът остава (картонът показва „Оттеглено“), а от следващата
     снимка съобщението вече не пътува — мостът и приложението го губят. */
  ipcMain.handle('online:withdrawMessage', /** @param {unknown} e @param {IpcArg<'online:withdrawMessage'>} arg @returns {IpcReply<'online:withdrawMessage'>} */ (e, arg) => run(() => {
    requireActivated();
    const db = getDb();
    ensureMessagesTable(db);
    const m = db.prepare(`SELECT m.id, m.title, m.withdrawn_at, r.name, r.card_no
      FROM reader_messages m JOIN readers r ON r.id = m.reader_id WHERE m.id = ?`).get(arg && arg.id);
    if (!m) throw new Error('Съобщението не е намерено.');
    if (m.withdrawn_at) throw new Error('Съобщението вече е оттеглено.');
    const at = new Date().toISOString();
    db.prepare('UPDATE reader_messages SET withdrawn_at = ? WHERE id = ? AND withdrawn_at IS NULL').run(at, m.id);
    logAudit('Оттеглено съобщение до читател', m.name + ' (карта ' + (m.card_no || '') + '): съобщение № ' + m.id
      + (m.title ? ' „' + m.title + '“' : ''));
    scheduleSync();
    return { id: m.id, withdrawn_at: at };
  }));

  ipcMain.handle('online:syncNow', /** @returns {IpcAsyncReply<'online:syncNow'>} */ async () => {
    try {
      requireActivated();
      const s = settingsRow();
      if (!s.online_bridge_url || !s.online_upload_key) throw new Error('Попълнете адреса на моста и ключа за качване.');
      const res = await sync('ръчно');
      if (!res.ok) return { ok: false, error: res.error || 'Изпращането не успя.' };
      return { ok: true, data: { generated: settingsRow().online_last_sync } };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  return { scheduleOnlineSync: scheduleSync, startOnlineTimer: startPeriodicTimer, stopOnlineTimer: stopPeriodicTimer, syncOnline: sync, onlineActivated: () => !!activated() };
};
