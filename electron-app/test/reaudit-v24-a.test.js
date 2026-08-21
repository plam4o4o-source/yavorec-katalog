/* Повторен (противников) одит на v2.4.0 — намерена празнина в поправка №2
   ("всички писещи транзакции вече ползват .immediate()"): loans:extend
   изобщо НЕ е бил обвит в db.transaction(...).immediate() — same клас
   проблем като checkout/checkoutByCode, но необхванат от
   test/two-process-locking.test.js. Проверено с ДВА реални os процеса,
   споделящи един файл с база данни (같ото two-process-locking.test.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { boot, invokeHandler, closeApp } = require('./helpers/two-process-worker.js');

const WORKER = path.join(__dirname, 'helpers', 'two-process-worker.js');

function makeSharedFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inv-shared-db-extend-'));
}

function spawnWorker(dbFolder) {
  const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const pending = [];
  child.on('message', (msg) => {
    const p = pending.shift();
    if (p) p(msg);
  });
  const send = (msg) => new Promise((resolve) => { pending.push(resolve); child.send(msg); });
  return {
    ready: () => send({ cmd: 'init', dbFolder }),
    invoke: (channel, args) => send({ cmd: 'invoke', channel, args }),
    exit: () => new Promise((resolve) => { child.once('exit', resolve); child.send({ cmd: 'exit' }); })
  };
}

test('два реални процеса, продължение (loans:extend) НА ЕДНО И СЪЩО заемане едновременно, докато лимитът от продължения е точно на 1 крачка: точно едно от двете трябва да успее, НЕ и двете (10 кръга)', async () => {
  const ROUNDS = 10;
  let bothSucceeded = 0;
  let rawLockErrors = 0;
  let neitherSucceeded = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const dbFolder = makeSharedFolder();
    await boot(dbFolder);
    const bookId = invokeHandler('books:create', { title: 'Под игото', quantity: 5 }).data;
    const readerId = invokeHandler('readers:create', { name: 'Читател 1' }).data;
    const co = invokeHandler('loans:checkout', { reader_id: readerId, book_id: bookId, date_out: '2026-08-01' });
    assert.equal(co.ok, true, 'заемането трябва да успее при засяването: ' + JSON.stringify(co));
    const loanId = co.data;
    // Едно продължение вече направено -> renewals=1; лимитът по подразбиране
    // (settings.extensions_count) е 2, значи остава ТОЧНО едно позволено
    // продължение преди лимита.
    const first = invokeHandler('loans:extend', { id: loanId });
    assert.equal(first.ok, true, 'първото продължение (последователно, без надпревара) трябва да успее: ' + JSON.stringify(first));
    assert.equal(first.data.renewals, 1);
    closeApp();

    const w1 = spawnWorker(dbFolder);
    const w2 = spawnWorker(dbFolder);
    await Promise.all([w1.ready(), w2.ready()]);

    const [r1, r2] = await Promise.all([
      w1.invoke('loans:extend', { id: loanId }),
      w2.invoke('loans:extend', { id: loanId })
    ]);
    await Promise.all([w1.exit(), w2.exit()]);

    const results = [r1, r2];
    const oks = results.filter(r => r.ok && r.data && r.data.ok !== false && r.data.data);
    // helper's run() wraps result as {ok, data} inside ipcMain.invoke, but the
    // 2-process worker's invokeHandler returns the RAW handler return, which
    // itself is the { ok, data|error } shape produced by deps.run() in main.js.
    const realOks = results.filter(r => r.ok && r.data && r.data.ok);
    const realFails = results.filter(r => !(r.ok && r.data && r.data.ok));

    if (realOks.length === 2) bothSucceeded++;
    if (realOks.length === 0) neitherSucceeded++;
    for (const f of realFails) {
      const msg = f.ok ? String(f.data.error || '') : ('ФАТАЛНО: ' + f.error);
      if (/database is locked/i.test(msg) || /SQLITE_BUSY/.test(msg)) rawLockErrors++;
    }

    // Директна проверка на крайното състояние в базата — колкото пъти да е
    // "успяло" IPC извикването, renewals не бива да прескочи лимита от 2, а
    // трябва точно да отразява броя РЕАЛНО извършени продължения.
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dbFolder, 'library.db'), { readonly: true });
    const row = db.prepare('SELECT renewals FROM loans WHERE id = ?').get(loanId);
    db.close();
    assert.equal(row.renewals, 1 + realOks.length,
      'renewals в базата (' + row.renewals + ') трябва да е точно 1 + броя успешни IPC отговора (' + realOks.length + ') — ' +
      'разминаване значи изгубена промяна (lost update) от надпревара между двата процеса');
    assert.ok(row.renewals <= 2, 'renewals не трябва да надхвърли лимита от 2 продължения дори при надпревара');

    fs.rmSync(dbFolder, { recursive: true, force: true });
  }

  assert.equal(rawLockErrors, 0, 'loans:extend не трябва да произвежда сурова "database is locked"/SQLITE_BUSY грешка');
  assert.equal(neitherSucceeded, 0, 'точно едно от двете паралелни продължения трябва да успее във всеки кръг (вторият процес трябва да получи ясен отказ "Достигнат е лимитът...")');
  assert.equal(bothSucceeded, 0,
    'И ДВЕТЕ паралелни продължения не трябва да успяват едновременно — loans:extend трябва да е обвит в db.transaction(...).immediate(), точно както loans:checkout, за да серializира проверката на лимита срещу конкурентен запис от втора станция');
});
