/* Тестове v2.3.0 за двата дефекта в криптирането на АВТОМАТИЧНОТО дневно копие,
   намерени при одита на механиката от v2.2.0/v2.2.1:

   1) Смяна на паролата (pdp:changePassword) не преправяше днешното копие — то
      оставаше със СТАРАТА парола. upgradeTodayAutoBackup() започваше с
      „ако вече има .invbak за днес — не прави нищо“, а при смяна точно този
      файл е остарелият. Сценарият е делничен: временна парола при включване,
      истинската — същия ден; или смяна, ЗАЩОТО старата е компрометирана.
   2) backup:autoStatus смяташе „криптира ли се“ само по настройките
      (конфигурирана и отключена защита) и картата в „Настройки“ показваше
      „🔒 копията се криптират“, докато на диска стои днешното копие в чист
      текст с имената, адресите, телефоните и ЕГН на всички читатели.

   Моделът е като в останалите handlers-*.test.js: фалшив ipcMain, истинска
   временна база от db/schema.sql, подадени зависимости (без Electron). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { JSDOM, VirtualConsole } = require('jsdom');

const pii = require('../pii-crypto');
const { isEncryptedBackup, encryptBackupFile, decryptBackupBuffer } = require('../backup-crypto');
const registerBackupHandlers = require('../handlers/backup');
const registerPdpHandlers = require('../handlers/pdp');


/* Хигиена на временните папки. node --test не чисти нищо след себе си, а всяка
   фикстура тук създава каталог в /tmp. Одитът завари 80 431 каталога / 23 GB;
   при пълен диск поредицата започва да пада лавинообразно на съвсем несвързани
   места (# pass 302 / # fail 345) и прати диагностиката по грешна следа.
   mkTmpDir() запомня папката, test.after() я трие. */
const tmpDirs = [];
function mkTmpDir(prefixPath) {
  const d = fs.mkdtempSync(prefixPath);
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
  }
});

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');
const TODAY = new Date().toISOString().slice(0, 10);
const OLD_PASS = 'временна-парола-1';
const NEW_PASS = 'истинската-парола-2';

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (c, fn) => handlers.set(c, fn),
    invoke: (c, ...a) => handlers.get(c)({}, ...a),
    has: (c) => handlers.has(c)
  };
}
const RUN = (fn) => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err.message }; }
};

/* И двата handler-а върху ЕДНА база и една папка — точно както в програмата:
   pdp:changePassword минава през абонамента pii.onSession, който handlers/backup.js
   ползва, за да преправи дневното копие. */
function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fix23-backup-'));
  const dbPath = path.join(dir, 'library.db');
  let db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  db.prepare("INSERT INTO readers (name, address, phone) VALUES ('Иван Петров', 'ул. Първа 1', '0888')").run();

  const auditLog = [];
  const sent = []; // известията към интерфейса (webContents.send)
  const ipcMain = fakeIpcMain();
  const deps = {
    app: { getPath: (n) => (n === 'temp' ? os.tmpdir() : dir), relaunch: () => {}, exit: () => {} },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    fs, path,
    getDb: () => db, setDb: (v) => { db = v; },
    getMainWindow: () => ({ webContents: { send: (ch, data) => sent.push({ ch, data }) }, isDestroyed: () => false }),
    run: RUN,
    logAudit: (a, d) => auditLog.push({ action: a, detail: d }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath
  };
  const handlers = registerBackupHandlers(ipcMain, deps);
  registerPdpHandlers(ipcMain, { getDb: () => db, run: RUN, logAudit: (a, d) => auditLog.push({ action: a, detail: d }) });
  const backupsDir = path.join(dir, 'backups');
  return {
    dir, dbPath, ipcMain, handlers, auditLog, sent, backupsDir,
    enc: path.join(backupsDir, `auto-${TODAY}.invbak`),
    plain: path.join(backupsDir, `auto-${TODAY}.db`),
    /* Задава защитата направо в базата, БЕЗ да отключва сесията — така изглежда
       всяко стартиране на програмата при вече включена защита. */
    configurePdpInDb: (password) => {
      const salt = pii.generateSalt(pii.CURRENT_KDF_VERSION);
      const key = pii.deriveKey(password, salt);
      db.prepare('UPDATE settings SET pdp_salt=?, pdp_verifier=? WHERE id=1')
        .run(salt.toString('base64'), pii.makeVerifier(key));
    },
    // „Рестарт на програмата“: нови backup handler-и, които не помнят с коя
    // парола е било записано днешното копие.
    restart: () => { const ipc2 = fakeIpcMain(); registerBackupHandlers(ipc2, deps); return ipc2; },
    close: () => { try { db.close(); } catch (e) { /* вече е затворена */ } pii.clearSession(); }
  };
}
/* Прави .invbak.tmp невъзможен за записване, като на негово място слага ПАПКА —
   точно както е възпроизведен провалът от одита (EISDIR). Външна причина, без
   подменен fs: криптирането гърми там, където и в живота — при писането. */
function blockStagedFile(s) {
  fs.mkdirSync(s.backupsDir, { recursive: true });
  fs.mkdirSync(s.enc + '.tmp');
}
function opens(file, password) {
  try { return decryptBackupBuffer(file, password).subarray(0, 15).toString('utf8') === 'SQLite format 3'; }
  catch (e) { return false; }
}

/* ===========================================================================
   1) Смяната на паролата преправя днешното копие с НОВАТА парола.
   =========================================================================== */

test('след смяна на паролата днешното авто-копие се отваря с НОВАТА, а не със старата', async () => {
  const s = setup();
  try {
    assert.equal((await s.ipcMain.invoke('pdp:setup', OLD_PASS)).ok, true);
    s.handlers.autoBackupIfNeeded();
    assert.ok(fs.existsSync(s.enc), 'при отключена защита копието за деня е криптирано');
    assert.equal(opens(s.enc, OLD_PASS), true);

    const ch = await s.ipcMain.invoke('pdp:changePassword', { oldPassword: OLD_PASS, newPassword: NEW_PASS });
    assert.equal(ch.ok, true);

    assert.equal(opens(s.enc, NEW_PASS), true,
      'копието от деня на смяната трябва да се отваря с паролата, която библиотекарят знае');
    assert.equal(opens(s.enc, OLD_PASS), false,
      'старата (евентуално компрометирана) парола вече не бива да отваря копието');
    assert.equal(fs.existsSync(s.enc + '.tmp'), false, 'междинният файл се почиства');
    assert.ok(s.auditLog.some(a => /презаписано криптирано/.test(a.detail) && /смяна на паролата/.test(a.detail)),
      'преправянето се вписва в одитната следа');
    assert.ok(s.sent.some(m => m.ch === 'backup:autoStatusChanged' && /прекриптирано/.test(m.data.message)),
      'библиотекарят получава и тост, а не само ред в одита');
  } finally { s.close(); }
});

test('прекриптирането е безопасно: провалът оставя старото копие на място и си личи', async () => {
  const s = setup();
  try {
    blockStagedFile(s); // писането на криптирания файл ще гърми (EISDIR)
    await s.ipcMain.invoke('pdp:setup', OLD_PASS);
    s.handlers.autoBackupIfNeeded();
    // Криптирането се проваля, но денят НЕ остава без копие — пада се към
    // некриптирано, което поне е копие (и се вписва в одита).
    assert.equal(fs.existsSync(s.plain), true, 'денят не остава без резервно копие');
    assert.equal(fs.existsSync(s.enc), false, 'наполовина записан .invbak не бива да остава');

    const before = fs.readFileSync(s.plain);
    const ch = await s.ipcMain.invoke('pdp:changePassword', { oldPassword: OLD_PASS, newPassword: NEW_PASS });
    assert.equal(ch.ok, true, 'провалът на копието не бива да проваля самата смяна на паролата');
    assert.equal(fs.existsSync(s.plain), true, 'старото копие не се трие, докато няма ново и проверено');
    assert.deepEqual(fs.readFileSync(s.plain), before, 'старото копие е непокътнато');
    assert.ok(s.auditLog.some(a => /ВНИМАНИЕ/.test(a.detail) && /не можа да бъде прекриптирано/.test(a.detail)),
      'провалът се вписва в одитната следа, а не само в конзолата');
    assert.ok(s.sent.some(m => m.ch === 'backup:autoStatusChanged' && m.data.level === 'err'),
      'провалът стига и до интерфейса');
  } finally { s.close(); }
});

test('копие от друга сесия, което не се отваря с текущата парола, се преправя при отключване', async () => {
  const s = setup();
  try {
    // Базата вече знае НОВАТА парола (сменена е от другия компютър в мрежата),
    // а файлът за деня е криптиран със старата — за програмата това е просто
    // „има .invbak за днес“, тоест точно случаят, който се пропускаше.
    s.configurePdpInDb(NEW_PASS);
    fs.mkdirSync(s.backupsDir, { recursive: true });
    encryptBackupFile(s.dbPath, s.enc, OLD_PASS);
    const stale = fs.readFileSync(s.enc);

    const ipc2 = s.restart(); // програмата се стартира наново — няма спомен за паролата
    assert.equal((await ipc2.has('backup:autoStatus')), true);
    assert.equal((await s.ipcMain.invoke('pdp:unlock', NEW_PASS)).ok, true);

    assert.notDeepEqual(fs.readFileSync(s.enc), stale,
      'копие, което не се отваря с текущата парола, се преправя, а не се приема за наред');
    assert.equal(opens(s.enc, NEW_PASS), true);
    assert.ok(s.auditLog.some(a => /не се отваряше с текущата парола/.test(a.detail)),
      'причината се вписва в одитната следа');
  } finally { s.close(); }
});

/* ===========================================================================
   2) backup:autoStatus отразява ИСТИНСКОТО състояние на днешния файл.
   =========================================================================== */

test('autoStatus не твърди „криптирано“, когато днешното копие реално е в чист текст', async () => {
  const s = setup();
  try {
    blockStagedFile(s); // криптирането се проваля (EISDIR — както при одита)
    await s.ipcMain.invoke('pdp:setup', OLD_PASS); // конфигурирана И отключена
    s.handlers.autoBackupIfNeeded();
    assert.equal(fs.existsSync(s.plain), true, 'некриптираното копие оцелява — това е добре');

    const st = (await s.ipcMain.invoke('backup:autoStatus')).data;
    assert.equal(st.encrypted, false, 'състоянието се смята по ФАЙЛА, не по настройките');
    assert.equal(st.state, 'failed');
    assert.equal(st.today.encrypted, false);
    assert.equal(st.today.path, s.plain);
    assert.ok(st.failure && /EISDIR/.test(st.failure.message), 'причината стига до интерфейса');
    assert.match(st.warning, /ЧИСТ ТЕКСТ/);
    assert.ok(s.auditLog.some(a => /ВНИМАНИЕ/.test(a.detail) && /криптирането/.test(a.detail)),
      'провалът се вижда и в одитната следа');
  } finally { s.close(); }
});

test('autoStatus различава „защитата не е включена“, „заключена е“ и „криптирано“', async () => {
  const s = setup();
  try {
    let st = (await s.ipcMain.invoke('backup:autoStatus')).data;
    assert.equal(st.state, 'off');
    assert.match(st.warning, /НЕ са криптирани/);

    // Защитата е включена от друг ден/компютър — при стартиране е ЗАКЛЮЧЕНА.
    s.configurePdpInDb(OLD_PASS);
    st = (await s.ipcMain.invoke('backup:autoStatus')).data;
    assert.equal(st.state, 'locked');
    assert.equal(st.encrypted, false);
    assert.match(st.warning, /заключена/);

    s.handlers.autoBackupIfNeeded(); // копието при стартиране — в чист текст
    st = (await s.ipcMain.invoke('backup:autoStatus')).data;
    assert.equal(st.state, 'locked', 'заключената защита е причината, а не провал');
    assert.equal(st.today.encrypted, false);

    assert.equal((await s.ipcMain.invoke('pdp:unlock', OLD_PASS)).ok, true);
    st = (await s.ipcMain.invoke('backup:autoStatus')).data;
    assert.equal(st.state, 'encrypted');
    assert.equal(st.encrypted, true);
    assert.equal(st.today.encrypted, true);
    assert.equal(st.warning, null);
    assert.equal(isEncryptedBackup(st.today.path), true);
    assert.equal(fs.existsSync(s.plain), false, 'некриптираният близнак не остава');
  } finally { s.close(); }
});

test('autoStatus брои некриптираните дневни копия, които вече лежат на диска', async () => {
  const s = setup();
  try {
    fs.mkdirSync(s.backupsDir, { recursive: true });
    ['auto-2026-07-01.db', 'auto-2026-07-02.db'].forEach(f => fs.copyFileSync(s.dbPath, path.join(s.backupsDir, f)));
    s.handlers.autoBackupIfNeeded(); // и днешното — също в чист текст
    const st = (await s.ipcMain.invoke('backup:autoStatus')).data;
    assert.equal(st.plainDailyCount, 3,
      'натрупаната експозиция е число, а не общо предупреждение — всяко копие е пълен списък с лични данни');
  } finally { s.close(); }
});

test('копие в чист текст от предишна сесия не се отчита като криптирано само защото защитата е отключена', async () => {
  const s = setup();
  try {
    s.handlers.autoBackupIfNeeded();               // при заключена защита — .db в чист текст
    assert.equal(fs.existsSync(s.plain), true);
    // Защитата се включва по такъв начин, че upgrade-ът да не е минавал по файла
    // (напр. копието е направено от втора програма/сесия върху същата папка).
    await s.ipcMain.invoke('pdp:setup', OLD_PASS);
    fs.copyFileSync(path.join(s.dir, 'library.db'), s.plain); // пак чист текст на мястото за деня
    if (fs.existsSync(s.enc)) fs.unlinkSync(s.enc);

    const st = (await s.ipcMain.invoke('backup:autoStatus')).data;
    assert.equal(st.pdpConfigured, true);
    assert.equal(st.pdpUnlocked, true);
    assert.equal(st.encrypted, false, 'решава файлът на диска, а не настройките');
    assert.equal(st.state, 'failed');
    assert.match(st.warning, /ЧИСТ ТЕКСТ/);
  } finally { s.close(); }
});

/* ===========================================================================
   Изгледът: картата в „Настройки“ → „Резервно копие“.
   =========================================================================== */

function scriptOrderFromIndexHtml() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}
/* Търпелив заместител на window.api при зареждането на изгледите — същият похват
   като в fixes-v221.test.js: всяко api.нещо.нещо() връща { ok: true, data: … },
   а data мълчи на всичко, което изгледът поиска от него. */
function safeDefault() {
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return (h) => (h === 'string' ? '' : 0);
      if (prop === 'length') return 0;
      if (['toString', 'toLocaleString', 'valueOf', 'toFixed', 'trim', 'replace'].includes(prop)) return () => '';
      if (['map', 'filter', 'slice', 'sort', 'concat', 'split', 'flat'].includes(prop)) return () => [];
      if (prop === 'forEach') return () => {};
      if (prop === 'join') return () => '';
      if (prop === 'reduce') return (fn, init) => init;
      if (['some', 'includes'].includes(prop)) return () => false;
      if (prop === 'every') return () => true;
      if (['find', 'indexOf'].includes(prop)) return () => (prop === 'indexOf' ? -1 : undefined);
      if (typeof prop === 'symbol') return undefined;
      return safeDefault();
    }
  });
}
function apiMock() {
  function makeNode(parts) {
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeNode(parts.concat(prop));
      },
      apply() { return Promise.resolve({ ok: true, data: safeDefault() }); }
    });
  }
  return makeNode([]);
}
function buildDom() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  window.api = apiMock();
  window.confirm = () => true;
  window.alert = () => {};
  window.print = () => {};
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const runScript = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  runScript(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  for (const f of scriptOrderFromIndexHtml()) {
    runScript(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'), `views/${f}`);
  }
  if (errors.length) assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n---\n'));
  return dom;
}
async function settled(dom) {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return dom;
}

test('картата показва провала на криптирането, а не „копията се криптират“', async () => {
  const { window } = await settled(buildDom());
  await window.renderSetup(); // #autoBkBox се създава от екрана „Настройки"
  window.api = {
    backup: {
      autoStatus: async () => ({ ok: true, data: {
        encrypted: false, state: 'failed', pdpConfigured: true, pdpUnlocked: true,
        today: { date: TODAY, path: '/db/backups/auto-' + TODAY + '.db', encrypted: false },
        last: { path: '/db/backups/auto-' + TODAY + '.db', encrypted: false, date: TODAY },
        failure: { date: TODAY, message: 'EISDIR: illegal operation on a directory' },
        warning: 'Опитът днешното копие да се криптира не се получи: EISDIR. На диска стои копие в ЧИСТ ТЕКСТ.'
      } })
    }
  };
  await window.loadAutoBackupBox();
  const html = window.document.getElementById('autoBkBox').innerHTML;
  assert.doesNotMatch(html, /се\s+<b>криптират<\/b>/, 'точно тази лъжа се поправя');
  assert.match(html, /ЧИСТ ТЕКСТ/);
  assert.match(html, /EISDIR/, 'казва се и ЗАЩО не се е получило');
  assert.match(html, /Направи копие с парола сега/, 'дава се изход тук и сега');
});

test('картата остава вярна и за старите три състояния (заключено/изключено/криптирано)', async () => {
  const { window } = await settled(buildDom());
  await window.renderSetup();
  const render = async (data) => {
    window.api = { backup: { autoStatus: async () => ({ ok: true, data }) } };
    await window.loadAutoBackupBox();
    return window.document.getElementById('autoBkBox').innerHTML;
  };
  let html = await render({ encrypted: false, state: 'locked', pdpConfigured: true, pdpUnlocked: false,
    today: null, last: null, failure: null, warning: 'докато защитата на личните данни е заключена' });
  assert.match(html, /заключена/);
  assert.match(html, /Към защитата на личните данни/);
  assert.doesNotMatch(html, /Включи защита/);

  html = await render({ encrypted: false, state: 'off', pdpConfigured: false, pdpUnlocked: false,
    today: null, plainDailyCount: 30, last: null, failure: null, warning: 'Автоматичните дневни копия НЕ са криптирани' });
  assert.match(html, /НЕ са криптирани/);
  assert.match(html, /Включи защита на личните данни/);
  // v2.4.24: числото важи и за предпазните копия отпреди възстановяване, затова
  // текстът е „некриптирани копия“, а не само „дневни“.
  assert.match(html, /30<\/b>\s*некриптирани дневни копия/, 'експозицията се показва с число');

  html = await render({ encrypted: true, state: 'encrypted', pdpConfigured: true, pdpUnlocked: true,
    today: { date: TODAY, path: 'auto.invbak', encrypted: true }, last: { date: TODAY, encrypted: true },
    failure: null, warning: null });
  assert.match(html, /криптират/);
  assert.doesNotMatch(html, /НЕ са криптирани/);
});

test('preload.js излага backup.onAutoStatus — иначе провалът няма как да стигне до екрана', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(src, /onAutoStatus:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('backup:autoStatusChanged'/);
});
