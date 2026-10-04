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
const {
  generatePin, hashPin, verifyActivation, buildSnapshot, sendSnapshot
} = require('../online-access');

const PERIODIC_MS = 30 * 60 * 1000;   // редовно изпращане на половин час, само при активирано

/** @param {any} ipcMain @param {HandlerDeps} deps */
module.exports = function registerOnlineAccessHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;
  const appVersion = typeof deps.getVersion === 'function' ? deps.getVersion : () => '0';
  const log = typeof deps.log === 'function' ? deps.log : (level, msg) => console[level === 'error' ? 'error' : 'log'](msg);
  /* Само за тестовете: ключ, с който да се проверява кодът за активация, вместо
     вградения на разработчика. main.js не подава нищо тук. */
  const verifyOpts = deps.activationPublicKey ? { publicKey: deps.activationPublicKey } : undefined;

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
  let inFlight = null;
  let rerun = false;
  async function syncOnce(reason) {
    const s = settingsRow();
    const act = activated(s);
    if (!act) return { ok: false, skipped: true, error: 'не е активирано' };
    if (!s.online_bridge_url || !s.online_upload_key) {
      return { ok: false, skipped: true, error: 'няма адрес на моста или ключ за качване' };
    }
    let body;
    try { body = buildSnapshot(getDb(), s, new Date().toISOString(), verifyOpts); }
    catch (err) {
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

  ipcMain.handle('online:syncNow', /** @returns {Promise<IpcResult<IpcData<'online:syncNow'>>>} */ async () => {
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
