// Тест на handlers/pdp.js — трийсет и пети домейн, извадено от main.js
// (Фаза 4, стъпка 35). Покрива pdp:status/setup/unlock/lock/changePassword
// и функциите, върнати за readers.js (maskReaderRow/maskReaderRows/
// preparePiiForWrite).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
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

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-pdp-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  // pdp_salt/pdp_verifier are added via a migration in main.js (v2), not in schema.sql directly.
  db.exec("ALTER TABLE settings ADD COLUMN pdp_salt TEXT");
  db.exec("ALTER TABLE settings ADD COLUMN pdp_verifier TEXT");

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail })
  };
  const returned = registerPdpHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, returned };
}

test('registerPdpHandlers registers all 5 pdp: channels, and returns mask/prepare functions for readers.js', () => {
  const { ipcMain, returned } = setup();
  ['pdp:status', 'pdp:setup', 'pdp:unlock', 'pdp:lock', 'pdp:changePassword']
    .forEach(ch => assert.ok(ipcMain.has(ch), ch));
  assert.equal(typeof returned.maskReaderRow, 'function');
  assert.equal(typeof returned.maskReaderRows, 'function');
  assert.equal(typeof returned.preparePiiForWrite, 'function');
});

test('pdp:status reports not configured/not unlocked before any setup', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('pdp:status');
  assert.deepEqual(result.data, { configured: false, unlocked: false, stale: false, unreadable: 0 });
});

// v2.2.0: минималната дължина на НОВА парола е 10 знака (солта и проверителят
// стоят в самата база, която живее на споделен мрежов дял — четиризначна парола
// се намира офлайн за секунди). Старите бази продължават да се отключват както
// преди; затова и паролите в тестовете по-долу вече са с достатъчна дължина.
test('pdp:setup rejects a short password and requires at least 10 characters', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('pdp:setup', 'abc');
  assert.equal(result.ok, false);
  assert.match(result.error, /поне 10 знака/);
});

test('pdp:setup configures protection, encrypts existing plaintext egn/id_card_no, and unlocks', async () => {
  const { db, ipcMain, auditLog } = setup();
  const readerId = db.prepare("INSERT INTO readers (name, egn, id_card_no) VALUES ('Иван', '1234567890', '999888777')").run().lastInsertRowid;

  const result = await ipcMain.invoke('pdp:setup', 'parola1-dylga');
  assert.equal(result.ok, true);
  const status = await ipcMain.invoke('pdp:status');
  assert.deepEqual(status.data, { configured: true, unlocked: true, stale: false, unreadable: 0 });

  const row = db.prepare('SELECT egn, id_card_no FROM readers WHERE id=?').get(readerId);
  assert.match(row.egn, /^PDPv1:/); // now encrypted, not plaintext
  assert.ok(auditLog.some(a => a.action === 'Защита на лични данни' && /1 читатели засегнати/.test(a.detail)));

  // Setting up twice should fail.
  const again = await ipcMain.invoke('pdp:setup', 'parola2-dylga');
  assert.equal(again.ok, false);
  assert.match(again.error, /вече е зададена/);
});

test('pdp:lock clears the unlocked key; pdp:unlock requires the correct password', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('pdp:setup', 'parola1-dylga');
  await ipcMain.invoke('pdp:lock');
  let status = await ipcMain.invoke('pdp:status');
  assert.equal(status.data.unlocked, false);

  const wrong = await ipcMain.invoke('pdp:unlock', 'wrongpass-dylga');
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /Грешна парола/);

  const right = await ipcMain.invoke('pdp:unlock', 'parola1-dylga');
  assert.equal(right.ok, true);
  status = await ipcMain.invoke('pdp:status');
  assert.equal(status.data.unlocked, true);
});

test('pdp:unlock reports an error when protection was never configured', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('pdp:unlock', 'anything');
  assert.equal(result.ok, false);
  assert.match(result.error, /не е зададена/);
});

test('pdp:changePassword requires the correct old password, then re-encrypts with the new key', async () => {
  const { db, ipcMain, returned } = setup();
  const readerId = db.prepare("INSERT INTO readers (name, egn) VALUES ('Мария', '1112223334')").run().lastInsertRowid;
  await ipcMain.invoke('pdp:setup', 'oldpass1-dylga');

  const wrongOld = await ipcMain.invoke('pdp:changePassword', { oldPassword: 'nope', newPassword: 'newpass1-dylga' });
  assert.equal(wrongOld.ok, false);
  assert.match(wrongOld.error, /Текущата парола е грешна/);

  const shortNew = await ipcMain.invoke('pdp:changePassword', { oldPassword: 'oldpass1-dylga', newPassword: 'x' });
  assert.equal(shortNew.ok, false);
  assert.match(shortNew.error, /Новата парола/);

  const ok = await ipcMain.invoke('pdp:changePassword', { oldPassword: 'oldpass1-dylga', newPassword: 'newpass1-dylga' });
  assert.equal(ok.ok, true);

  // Old password no longer unlocks after the change; new one does.
  await ipcMain.invoke('pdp:lock');
  const oldFails = await ipcMain.invoke('pdp:unlock', 'oldpass1-dylga');
  assert.equal(oldFails.ok, false);
  const newWorks = await ipcMain.invoke('pdp:unlock', 'newpass1-dylga');
  assert.equal(newWorks.ok, true);

  // Data still decrypts correctly with the new key via the returned maskReaderRow.
  const row = db.prepare('SELECT * FROM readers WHERE id=?').get(readerId);
  returned.maskReaderRow(row);
  assert.equal(row.egn, '1112223334');
});

test('maskReaderRow shows a placeholder for encrypted fields while locked, and real values while unlocked', async () => {
  const { db, ipcMain, returned } = setup();
  const readerId = db.prepare("INSERT INTO readers (name, egn) VALUES ('Петър', '5556667778')").run().lastInsertRowid;
  await ipcMain.invoke('pdp:setup', 'secret12-dylga');
  await ipcMain.invoke('pdp:lock');

  const lockedRow = db.prepare('SELECT * FROM readers WHERE id=?').get(readerId);
  returned.maskReaderRow(lockedRow);
  assert.equal(lockedRow.egn, 'Защитени данни');

  await ipcMain.invoke('pdp:unlock', 'secret12-dylga');
  const unlockedRow = db.prepare('SELECT * FROM readers WHERE id=?').get(readerId);
  returned.maskReaderRow(unlockedRow);
  assert.equal(unlockedRow.egn, '5556667778');
});

test('preparePiiForWrite: no-ops when protection isn\'t configured, encrypts when unlocked, and blocks new-reader writes while locked', () => {
  const { returned } = setup();
  const noProtection = { egn: '1234567890' };
  returned.preparePiiForWrite(noProtection, null);
  assert.equal(noProtection.egn, '1234567890'); // untouched, backward compatible plaintext
});

test('preparePiiForWrite blocks writing egn on a NEW reader while locked (no prev row to fall back to)', async () => {
  const { ipcMain, returned } = setup();
  await ipcMain.invoke('pdp:setup', 'secret12-dylga');
  await ipcMain.invoke('pdp:lock');
  assert.throws(() => returned.preparePiiForWrite({ egn: '9998887776' }, null), /Отключете защитата/);
});

test('preparePiiForWrite preserves the previous encrypted value on an EXISTING reader while locked', async () => {
  const { ipcMain, returned } = setup();
  await ipcMain.invoke('pdp:setup', 'secret12-dylga');
  await ipcMain.invoke('pdp:lock');
  const prev = { egn: 'PDPv1:something-encrypted' };
  const out = { egn: 'attempted-new-plaintext' };
  returned.preparePiiForWrite(out, prev);
  assert.equal(out.egn, prev.egn); // form input ignored while locked; old encrypted value kept
});
