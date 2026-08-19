// Тест на handlers/account.js — седемнайсети домейн, извадено от main.js
// (Фаза 4, стъпка 18). amount > 0 = начисление, amount < 0 = плащане;
// балансът е сумата им.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerAccountHandlers = require('../handlers/account');


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
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-account-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    today: () => '2026-08-02'
  };
  registerAccountHandlers(ipcMain, deps);
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  return { db, ipcMain, auditLog, readerId };
}

test('registerAccountHandlers registers all four account: IPC channels', () => {
  const { ipcMain } = setup();
  for (const ch of ['account:get', 'account:charge', 'account:pay', 'account:deleteLine']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('account:charge rejects a non-positive amount', async () => {
  const { ipcMain, readerId } = setup();
  const result = await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /положителна/);
});

test('account:charge inserts a positive начисление line and logs an audit entry', async () => {
  const { ipcMain, auditLog, readerId } = setup();
  const result = await ipcMain.invoke('account:charge', { reader_id: readerId, type: 'глоба', amount: '5.50', note: 'просрочие' });
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /Читател/);
  assert.match(auditLog[0].detail, /5\.50/);

  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.balance, 5.5);
  assert.equal(got.data.lines[0].kind, 'начисление');
});

test('account:pay inserts a negative плащане line, reducing the balance', async () => {
  const { ipcMain, readerId } = setup();
  await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 10 });
  const result = await ipcMain.invoke('account:pay', { reader_id: readerId, amount: 4 });
  assert.equal(result.ok, true);

  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.balance, 6);
  const payLine = got.data.lines.find(l => l.kind === 'плащане');
  assert.equal(payLine.amount, -4);
});

test('account:pay rejects a zero amount (Math.abs of a negative amount would just pay that much)', async () => {
  const { ipcMain, readerId } = setup();
  const result = await ipcMain.invoke('account:pay', { reader_id: readerId, amount: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /положителна/);
});

test('account:deleteLine removes a line and updates the balance', async () => {
  const { ipcMain, readerId } = setup();
  const lineId = (await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 8 })).data;
  await ipcMain.invoke('account:deleteLine', lineId);
  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.balance, 0);
  assert.equal(got.data.lines.length, 0);
});

test('account:get defaults date to today() when not provided', async () => {
  const { ipcMain, readerId } = setup();
  await ipcMain.invoke('account:charge', { reader_id: readerId, amount: 1 });
  const got = await ipcMain.invoke('account:get', readerId);
  assert.equal(got.data.lines[0].date, '2026-08-02');
});

/* ЗАЩО: в този дневник ЗНАКЪТ носи смисъла — плюс се дължи, минус е платено.
   Начисление, подадено с отрицателна сума (изтървано „-" при въвеждане, или
   стойност, дошла наготово от друга справка), без Math.abs би влязло като
   ПЛАЩАНЕ и би НАМАЛИЛО дълга на читателя. Проверката съществува в кода, но
   не беше покрита от нито един тест. */
test('account:charge привежда отрицателна сума към начисление (дългът РАСТЕ, не намалява)', async () => {
  const { db, ipcMain, readerId } = setup();
  await ipcMain.invoke('account:charge', { reader_id: readerId, type: 'обезщетение', amount: -4.5 });
  const line = db.prepare('SELECT kind, amount FROM account_lines WHERE reader_id = ?').get(readerId);
  assert.equal(line.kind, 'начисление');
  assert.ok(line.amount > 0, 'начислението трябва да е положително, а е ' + line.amount);
  const res = await ipcMain.invoke('account:get', readerId);
  assert.equal(res.data.balance, 4.5, 'балансът трябва да покаже дълг 4,50 лв., а не кредит');
});

test('account:charge отказва нула, празно и нечислова сума', async () => {
  const { ipcMain, readerId } = setup();
  for (const amount of [0, '', null, undefined, 'абв', NaN]) {
    const res = await ipcMain.invoke('account:charge', { reader_id: readerId, type: 'друго', amount });
    assert.equal(res.ok, false, 'сума ' + JSON.stringify(amount) + ' не бива да минава');
    assert.match(res.error, /положителна/);
  }
});

test('account:pay също привежда знака — плащане с отрицателна сума пак намалява дълга', async () => {
  const { db, ipcMain, readerId } = setup();
  await ipcMain.invoke('account:charge', { reader_id: readerId, type: 'обезщетение', amount: 10 });
  await ipcMain.invoke('account:pay', { reader_id: readerId, amount: -3 });
  const res = await ipcMain.invoke('account:get', readerId);
  assert.equal(res.data.balance, 7);
  // amount се пази закръглено до стотинка (toCents), но в ЛЕВА, не в стотинки.
  assert.equal(db.prepare("SELECT amount FROM account_lines WHERE kind = 'плащане'").get().amount, -3);
});
