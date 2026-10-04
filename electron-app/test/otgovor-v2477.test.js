'use strict';
/* ============================================================================
   v2.4.77 — ОТГОВОРЪТ НА ОБРАБОТЧИКА СЕ ПРОВЕРЯВА СРЕЩУ ДОГОВОРА (т. 1).
   ============================================================================
   Дотук договорът (types/ipc-contract.d.ts) пазеше двете посоки на ВХОДА:
   какво праща екранът и какво чете обработчикът. Отговорът беше описан, но
   никой не го сравняваше с обработчика — така при v2.4.72 договорът обещаваше
   „дни забава“ в писмото по чл. 43, които обработчикът не смята. Сега:
     1) run() е run<T>(fn: () => T): IpcResult<T> и носи типа на данните;
     2) всеки обработчик в main.js и handlers/ носи
        `@returns {IpcReply<'канал'>}` (асинхронният — IpcAsyncReply<…>) за СВОЯ канал;
     3) отговор с друг тип или с липсващо поле е грешка, а верният не е;
        измислено поле е грешка, когато отговорът е написан буквално
        (`async () => ({ ok: true, data: {…} })`, полетата до data).
   Граница: в `run(() => ({…}))` TypeScript не проверява ИЗЛИШНИ полета в
   обекта, който връща стрелката, а ред от базата (getDb() е any) минава като
   какъвто и да е тип — затова тук се проверяват типът и липсващите полета. */
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

const HANDLER_FILES = ['main.js'].concat(fs.readdirSync(path.join(APP_DIR, 'handlers'))
  .filter(f => f.endsWith('.js')).map(f => path.join('handlers', f)));

test('всеки обработчик носи типа на отговора за СВОЯ канал', () => {
  let n = 0, all = 0;
  for (const f of HANDLER_FILES) {
    const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
    // всяко истинско ipcMain.handle( трябва да попадне в проверката отдолу —
    // написан другояче (именувана функция, нов ред) обработчик не се изплъзва
    all += (src.match(/^\s*ipcMain\.handle\(/gm) || []).length;
    for (const m of src.matchAll(/^\s*ipcMain\.handle\('([A-Za-z]+:[A-Za-z]+)',\s*(\/\*\*[\s\S]*?\*\/)?\s*(async\s+)?\(/gm)) {
      const [, ch, doc, asy] = m;
      const want = asy ? "@returns {IpcAsyncReply<'" + ch + "'>}" : "@returns {IpcReply<'" + ch + "'>}";
      assert.ok(doc && doc.includes(want), f + ': ' + ch + ' — липсва ' + want + '\n' + (doc || '(без JSDoc)'));
      n++;
    }
  }
  assert.ok(n >= 250, 'обработчици: ' + n);
  assert.equal(n, all, 'обработчик, който проверката не разпознава (вижте регулярния израз)');
});

test('run() носи типа на данните до отговора', () => {
  const main = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  assert.match(main, /@template T @param \{\(\) => T\} fn @returns \{IpcResult<T>\} \*\/\nfunction run\(fn\)/);
  const contract = fs.readFileSync(path.join(APP_DIR, 'types', 'ipc-contract.d.ts'), 'utf8');
  assert.match(contract, /interface HandlerDeps \{\s*run<T>\(fn: \(\) => T\): IpcResult<T>;/);
});

test('отговор с друг тип, липсващо или (в буквален отговор) измислено поле е грешка; верният не е', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-otgovor77-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'probe.js'), [
    /* 1 */ "/** @type {HandlerDeps} */ const deps = /** @type {any} */ ({}); /** @returns {IpcReply<'loans:checkout'>} */ const ok1 = () => deps.run(() => 5);",
    /* 2 */ "/** @returns {IpcReply<'loans:checkout'>} */ const bad2 = () => deps.run(() => '5');",
    /* 3 */ "/** @returns {IpcReply<'account:get'>} */ const bad3 = () => deps.run(() => ({ lines: [], balanse: 0 }));",
    /* 4 */ "/** @returns {IpcAsyncReply<'loans:checkout'>} */ const ok4 = async () => ({ ok: true, data: 1 });",
    /* 5 */ "/** @returns {IpcAsyncReply<'loans:checkout'>} */ const bad5 = async () => ({ ok: true });",
    /* 6 */ "/** @returns {IpcReply<'books:delete'>} */ const ok6 = () => deps.run(() => { /* нищо */ });",
    /* 7 */ "/** @returns {IpcAsyncReply<'account:get'>} */ const bad7 = async () => ({ ok: true, data: { lines: [], balance: 0, balanse: 0 } });",
    /* 8 */ "/** @returns {IpcAsyncReply<'backup:now'>} */ const bad8 = async () => ({ ok: true, data: '', encryptd: true });",
    /* 9 */ "/** @returns {IpcAsyncReply<'backup:now'>} */ const ok9 = async () => ({ ok: true, data: '', encrypted: true });",
    'module.exports = { ok1, bad2, bad3, ok4, bad5, ok6, bad7, bad8, ok9 };'
  ].join('\n'));
  const base = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: Object.assign({}, base.compilerOptions, { typeRoots: [path.join(APP_DIR, 'node_modules', '@types')] }),
    include: base.include.map(p => path.join(APP_DIR, p)).concat(path.join(dir, 'probe.js'))
  }));
  const r = spawnSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  const all = ((r.stdout || '') + (r.stderr || '')).split('\n');
  const on = (n) => all.filter(l => l.includes('probe.js(' + n + ','));
  assert.deepEqual(all.filter(l => /error TS/.test(l) && !l.includes('probe.js')), [], 'главният процес минава чисто');
  for (const n of [1, 4, 6, 9]) assert.deepEqual(on(n), [], 'ред ' + n + ' е верен');
  for (const n of [2, 3, 5]) assert.ok(on(n).length > 0, 'ред ' + n + ' трябва да е грешка:\n' + all.join('\n'));
  assert.ok(on(7).some(l => /balanse/.test(l)), 'измислено поле в буквалния отговор:\n' + all.join('\n'));
  assert.ok(on(8).some(l => /encryptd/.test(l)), 'неописано поле до data в обработчика:\n' + all.join('\n'));
});

test('полетата ДО data са описани: известното минава, непознатото е грешка (и на екрана)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-extra77-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'probe.js'), [
    /* 1 */ "async function ok1() { const r = await window.api.backup.now({}); if (!r.ok) return; return (r.encrypted ? 'к' : '') + r.data; }",
    /* 2 */ "async function bad2() { const r = await window.api.backup.now({}); if (!r.ok) return; return r.encryptd; }",
    /* 3 */ "async function bad3() { const r = await window.api.loans.checkout({ reader_id: 1, book_id: 1, date_out: '2026-01-05' }); if (!r.ok) return; return r.catalogWarning; }"
  ].join('\n'));
  const base = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'tsconfig.renderer.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: Object.assign({}, base.compilerOptions, { typeRoots: [path.join(APP_DIR, 'node_modules', '@types')] }),
    include: base.include.map(p => path.join(APP_DIR, p)).concat(path.join(dir, 'probe.js'))
  }));
  const r = spawnSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  const all = ((r.stdout || '') + (r.stderr || '')).split('\n');
  const on = (n) => all.filter(l => l.includes('probe.js(' + n + ','));
  assert.deepEqual(all.filter(l => /error TS/.test(l) && !l.includes('probe.js')), [], 'изгледите минават чисто');
  assert.deepEqual(on(1), [], 'encrypted е описано за backup:now');
  assert.ok(on(2).some(l => /encryptd/.test(l)), 'печатна грешка в полето:\n' + all.join('\n'));
  assert.ok(on(3).some(l => /catalogWarning/.test(l)), 'чуждо поле (на books:create) при loans:checkout:\n' + all.join('\n'));
  const cfgs = ['tsconfig.json', 'tsconfig.renderer.json'].map(f => JSON.parse(fs.readFileSync(path.join(APP_DIR, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')));
  for (const c of cfgs) assert.equal(c.compilerOptions.exactOptionalPropertyTypes, true);
});
