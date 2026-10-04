'use strict';
/* ============================================================================
   v2.4.72 — ДОГОВОРЪТ ЕКРАН ↔ ОБРАБОТЧИК НАИСТИНА СЕ ПРОВЕРЯВА.
   ============================================================================
   types/ipc-contract.d.ts описва аргументите и отговора на каналите от
   заеманията, сметката, отчисляването и инвентаризацията. Описание, което
   никой не гледа, не пази нищо — тук се показва, че има сила:
     1) всеки описан канал съществува в preload.js и е изложен с точния си
        подпис (IpcMethod<'…'>), не с общия InvLibInvoke;
     2) обработчикът на всеки описан канал носи IpcArg за СЪЩИЯ канал;
     3) на екрана: грешно име на поле, липсващо задължително поле, излишно
        поле и грешно поле в отговора са грешки; вярното извикване не е;
     4) в обработчика: поле, което договорът не познава, е грешка;
     5) датите, които описването показа като непроверени (сметка, читалня,
        предложение за изгубен документ), вече се проверяват. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startMainApp } = require('./helpers/main-app');

const APP_DIR = path.join(__dirname, '..');
const TSC = require.resolve('typescript/bin/tsc');
/* От v2.4.73 договорът описва ВСИЧКИ канали — обработчиците са във всички
   handlers/*.js и в main.js. */
const HANDLER_FILES = ['main.js'].concat(fs.readdirSync(path.join(APP_DIR, 'handlers'))
  .filter(f => f.endsWith('.js')).map(f => path.join('handlers', f)));

const tmpDirs = [];
let app;
test.after(() => {
  if (app) app.stop();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const { contractChannels, render } = require('../scripts/gen-api-types');
const CHANNELS = [...contractChannels()];
const CONTRACT_SRC = fs.readFileSync(path.join(APP_DIR, 'types', 'ipc-contract.d.ts'), 'utf8');

test('всеки канал от договора е в preload.js и е изложен с точния си подпис', () => {
  const text = render();
  /* Всички (v2.4.73): нито един метод на window.api не остава с общия InvLibInvoke. */
  const preload = fs.readFileSync(path.join(APP_DIR, 'preload.js'), 'utf8');
  const exposed = new Set([...preload.matchAll(/invoke\('([A-Za-z]+:[A-Za-z]+)'/g)].map(m => m[1]));
  assert.deepEqual([...exposed].filter(c => !CHANNELS.includes(c)), [], 'канали от preload.js без описание в договора');
  assert.doesNotMatch(text, /: InvLibInvoke;/, 'метод, изложен без подписа от договора');
  for (const ch of CHANNELS) {
    assert.ok(text.includes(": IpcMethod<'" + ch + "'>;"), ch + ' не е изложен с подписа от договора');
  }
});

test('обработчикът на всеки описан канал носи IpcArg за същия канал', () => {
  const src = HANDLER_FILES.map(f => fs.readFileSync(path.join(APP_DIR, f), 'utf8')).join('\n');
  for (const ch of CHANNELS) {
    // Началото на ред — не коментар, който споменава канала (напр. holds.js).
    const m = new RegExp("^\\s*ipcMain\\.handle\\('" + ch + "',", 'm').exec(src);
    const at = m ? m.index : -1;
    assert.ok(at >= 0, ch + ': обработчикът не е намерен в handlers/ и main.js');
    const head = src.slice(at, src.indexOf('=>', at));
    /* Канал без аргументи няма какво да описва — `() =>`; но тогава и
       договорът трябва да казва `args: []`, иначе аргументът се губи. */
    // Между запетаята и () може да стои JSDoc (от v2.4.77 — @returns {IpcReply<…>}).
    if (/,\s*(\/\*\*[\s\S]*?\*\/\s*)?(async\s+)?\(\)\s*$/.test(head)) {
      assert.match(CONTRACT_SRC, new RegExp("'" + ch + "': \\{\\s*args: \\[\\];"), ch + ': обработчикът е `() =>`, а договорът чака аргументи');
      continue;
    }
    assert.ok(head.includes("IpcArg<'" + ch + "'"), ch + ': параметърът не е описан с договора:\n' + head);
    /* И всеки следващ позиционен аргумент (revoke → опциите, get → preview). */
    const params = head.match(/\(([^()]*)\)\s*$/)[1].split(/,(?![^{]*\})/);
    for (let i = 2; i < params.length; i++) {
      assert.ok(head.includes("IpcArg<'" + ch + "', " + (i - 1) + '>'), ch + ': аргумент № ' + i + ' не е описан:\n' + head);
    }
  }
});

/* Проверката на единия процес + един допълнителен файл-проба. */
function checkWith(tsconfig, probe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-contract-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'probe.js'), probe);
  const base = JSON.parse(fs.readFileSync(path.join(APP_DIR, tsconfig), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const cfg = {
    compilerOptions: Object.assign({}, base.compilerOptions, { typeRoots: [path.join(APP_DIR, 'node_modules', '@types')] }),
    include: base.include.map(p => path.join(APP_DIR, p)).concat(path.join(dir, 'probe.js'))
  };
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  return {
    out,
    probe: out.split('\n').filter(l => l.includes('probe.js')),
    others: out.split('\n').filter(l => /error TS/.test(l) && !l.includes('probe.js'))
  };
}
const onLine = (lines, n) => lines.filter(l => new RegExp('probe\\.js\\(' + n + ',').test(l));

test('на екрана: грешно, липсващо или излишно поле е грешка; вярното извикване не е', () => {
  const r = checkWith('tsconfig.renderer.json', [
    /* 1 */ "async function pOk() { const d = await call(window.api.loans.checkout({ reader_id: 1, book_id: '2', date_out: '2026-01-05' })); if (d) d.toFixed(0); const a = await call(window.api.account.get(1)); if (a) a.balance.toFixed(2); }",
    /* 2 */ "async function pName() { await window.api.loans.checkout({ readerId: 1, book_id: 2, date_out: '2026-01-05' }); }",
    /* 3 */ "async function pMissing() { await window.api.loans.checkout({ reader_id: 1, book_id: 2 }); }",
    /* 4 */ "async function pExtra() { await window.api.account.pay({ reader_id: 1, amount: 2, sum: 2 }); }",
    /* 5 */ "async function pResult() { const a = await call(window.api.account.get(1)); if (a) a.balanse.toFixed(2); }",
    /* 6 */ "async function pMode() { await window.api.inventorySessions.close({ sessionId: 1, mode: 'пълна' }); }",
    /* 7 */ "async function pLetter() { const d = await call(window.api.loans.overdueByReader()); if (d) d[0].loans[0].daysLate.toFixed(0); }"
  ].join('\n'));
  assert.equal(r.others.length, 0, 'самите изгледи минават чисто:\n' + r.out);
  assert.deepEqual(onLine(r.probe, 1), [], 'вярното извикване не бива да е грешка');
  assert.ok(onLine(r.probe, 2).some(l => /readerId/.test(l)), 'readerId вместо reader_id:\n' + r.out);
  assert.ok(onLine(r.probe, 3).some(l => /date_out/.test(l)), 'липсващата дата на заемане:\n' + r.out);
  assert.ok(onLine(r.probe, 4).some(l => /sum/.test(l)), 'излишното поле:\n' + r.out);
  assert.ok(onLine(r.probe, 5).some(l => /balanse/.test(l)), 'грешното поле в отговора:\n' + r.out);
  assert.ok(onLine(r.probe, 6).some(l => /пълна/.test(l)), 'непознатият вид инвентаризация:\n' + r.out);
  /* Писмото по чл. 43 не получава daysLate от обработчика — договорът не го обещава. */
  assert.ok(onLine(r.probe, 7).some(l => /daysLate/.test(l)), 'daysLate в писмото:\n' + r.out);
});

test('в обработчика: поле, което договорът не познава, е грешка; вярното не е', () => {
  const r = checkWith('tsconfig.json', [
    /* 1 */ "/** @param {IpcArg<'loans:return'>} arg */ function hOk({ id, date_in }) { return [id, date_in]; }",
    /* 2 */ "/** @param {IpcArg<'loans:return'>} arg */ function hBad({ id, dateIn }) { return [id, dateIn]; }",
    /* 3 */ "/** @param {IpcArg<'deaccessionActs:revoke', 1>} [o] */ function hOpt(o) { return o && o.reasn; }",
    "module.exports = { hOk, hBad, hOpt };"
  ].join('\n'));
  assert.equal(r.others.length, 0, 'главният процес минава чисто:\n' + r.out);
  assert.deepEqual(onLine(r.probe, 1), []);
  assert.ok(onLine(r.probe, 2).some(l => /dateIn/.test(l)), 'dateIn вместо date_in:\n' + r.out);
  assert.ok(onLine(r.probe, 3).some(l => /reasn/.test(l)), 'второто описано място (опциите):\n' + r.out);
});

/* 5) Датите, които описването показа като непроверени. През истинския main.js. */
test('сметка, читалня и предложение за изгубен документ отказват невалидна дата', async () => {
  app = startMainApp();
  await app.ready();
  const Database = require('better-sqlite3');
  const db = new Database(path.join(app.userData, 'library.db'));
  try {
    const r = db.prepare("INSERT INTO readers (name, card_no, status, gdpr_consent) VALUES ('Дата', '7472', 'активен', 1)").run().lastInsertRowid;
    const lines = () => db.prepare('SELECT COUNT(*) AS n FROM account_lines WHERE reader_id = ?').get(r).n;
    for (const bad of ['2026-13-01', 'утре']) {
      const c = await app.invoke('account:charge', { reader_id: r, type: 'обезщетение', amount: 2, date: bad });
      assert.equal(c.ok, false, 'начисление с дата ' + bad);
      assert.match(c.error, /невалидна/);
      const p = await app.invoke('account:pay', { reader_id: r, amount: 2, date: bad });
      assert.equal(p.ok, false, 'плащане с дата ' + bad);
    }
    assert.equal(lines(), 0, 'в касовия дневник не влиза ред с невалидна дата');
    assert.equal((await app.invoke('account:pay', { reader_id: r, amount: 2 })).ok, true, 'без дата = днес, както досега');
    assert.equal((await app.invoke('account:pay', { reader_id: r, amount: 1, date: '' })).ok, true, 'празна дата = днес');
    assert.equal((await app.invoke('account:charge', { reader_id: r, type: 'обезщетение', amount: 3, date: '' })).ok, true);
    assert.equal((await app.invoke('account:charge', { reader_id: r, type: 'обезщетение', amount: 3, date: '2026-02-27' })).ok, true);
    assert.deepEqual(db.prepare('SELECT date FROM account_lines WHERE reader_id = ? ORDER BY id').all(r).map(x => x.date),
      [require('../local-date').localDate(), require('../local-date').localDate(), require('../local-date').localDate(), '2026-02-27']);

    const events = () => db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'читалня'").get().n;
    const e0 = events();
    assert.equal((await app.invoke('events:localuse', { date: '2026-02-30' })).ok, false);
    assert.equal(events(), e0);
    assert.equal((await app.invoke('events:localuse', {})).ok, true);
    assert.equal((await app.invoke('events:localuse', { date: '' })).ok, true);
    assert.equal(events(), e0 + 2);

    const cat = db.prepare("SELECT id FROM categories WHERE name = 'книга'").get().id;
    const b = db.prepare("INSERT INTO books (inv_number, title, status, category_id, register_date, price) VALUES (74720, 'Изгубена', 'наличен', ?, '2026-01-01', 5)").run(cat).lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(b);
    const loan = db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-01-02', '2026-01-30')").run(r, b).lastInsertRowid;
    const q = await app.invoke('loans:lostQuote', { id: loan, date: '2026-99-01' });
    assert.equal(q.ok, false, 'предложението не бива тихо да стане за днешния ден');
    assert.equal((await app.invoke('loans:lostQuote', { id: loan })).ok, true);
  } finally { db.close(); }
});
