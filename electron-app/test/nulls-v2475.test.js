'use strict';
/* ============================================================================
   v2.4.75 — strictNullChecks: null и undefined са отделни типове (т. 4).
   ============================================================================
   Дотук `null` минаваше навсякъде: ред от базата с празна колона, `call()`,
   който връща null при грешка, отговор на канал без `data`. Сега проверката
   на типовете иска да се провери, преди да се чете. Тук се показва, че:
     1) и двете проверки (главен процес и изгледи) са със strictNullChecks;
     2) отговорът на канал е { ok: true, data } | { ok: false, error } —
        след `if (!r.ok) return` данните са налице, без проверка — не;
     3) `call()` връща T | null, а nullable колона — `| null`: четене без
        проверка е грешка, а вярното четене не е;
     4) в обработчика незадължително поле от договора не се чете без проверка. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const TSC = require.resolve('typescript/bin/tsc');
const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const readCfg = (f) => JSON.parse(fs.readFileSync(path.join(APP_DIR, f), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

function checkWith(tsconfig, probe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-nulls75-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'probe.js'), probe);
  const base = readCfg(tsconfig);
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: Object.assign({}, base.compilerOptions, { typeRoots: [path.join(APP_DIR, 'node_modules', '@types')] }),
    include: base.include.map(p => path.join(APP_DIR, p)).concat(path.join(dir, 'probe.js'))
  }));
  const r = spawnSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  const all = ((r.stdout || '') + (r.stderr || '')).split('\n');
  return {
    others: all.filter(l => /error TS/.test(l) && !l.includes('probe.js')),
    on: (n) => all.filter(l => l.includes('probe.js(' + n + ','))
  };
}

test('и двете проверки на типовете са със strictNullChecks', () => {
  for (const f of ['tsconfig.json', 'tsconfig.renderer.json']) {
    assert.equal(readCfg(f).compilerOptions.strictNullChecks, true, f);
  }
});

test('изгледи: четене без проверка за null/ok е грешка, а вярното четене не е', () => {
  const r = checkWith('tsconfig.renderer.json', [
    /* 1 */ "async function ok1() { const r = await window.api.books.get(1); if (!r.ok) return r.error.length; const b = await call(window.api.books.get(1)); if (b) b.title.length; const s = await call(window.api.settings.get()); return s ? (s.org || '').length : 0; }",
    /* 2 */ "async function bad2() { const r = await window.api.readers.list('', 20); return r.data.length; }",
    /* 3 */ "async function bad3() { return (await call(window.api.settings.get())).org; }",
    /* 4 */ "async function bad4() { const l = await call(window.api.loans.byReader(1)); if (l) l[0].date_due.slice(0, 4); }"
  ].join('\n'));
  assert.deepEqual(r.others, [], 'самите изгледи минават чисто');
  assert.deepEqual(r.on(1), [], 'след проверка на ok, на null и на празната колона — без грешка');
  assert.ok(r.on(2).some(l => /undefined/.test(l)), 'r.data без проверка на r.ok:\n' + r.on(2).join('\n'));
  assert.ok(r.on(3).some(l => /null/.test(l)), 'call() връща null при грешка:\n' + r.on(3).join('\n'));
  assert.ok(r.on(4).some(l => /null/.test(l)), 'loans.date_due е NULL за безсрочно заемане:\n' + r.on(4).join('\n'));
});

test('обработчик: незадължително поле от договора не се чете без проверка', () => {
  const r = checkWith('tsconfig.json', [
    /* 1 */ "/** @param {IpcArg<'loans:return'>} a */ function ok1(a) { return a.date_in ? a.date_in.length : 0; }",
    /* 2 */ "/** @param {IpcArg<'loans:return'>} a */ function bad2(a) { return a.date_in.length; }",
    /* 3 */ "/** @param {DbLoans} l */ function bad3(l) { return l.date_due.length; }",
    'module.exports = { ok1, bad2, bad3 };'
  ].join('\n'));
  assert.deepEqual(r.others, [], 'главният процес минава чисто');
  assert.deepEqual(r.on(1), []);
  assert.ok(r.on(2).length > 0, 'date_in е незадължително');
  assert.ok(r.on(3).some(l => /null/.test(l)), 'празна колона от генерираните типове (loans.date_due) без проверка');
});
