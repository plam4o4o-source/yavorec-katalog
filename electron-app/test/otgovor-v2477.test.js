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
        `@returns {IpcReply<'канал'>}` (асинхронният — Promise<…>) за СВОЯ канал;
     3) отговор с друг тип, с липсващо или измислено поле е грешка, а верният
        не е. */
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
  let n = 0;
  for (const f of HANDLER_FILES) {
    const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
    for (const m of src.matchAll(/^\s*ipcMain\.handle\('([A-Za-z]+:[A-Za-z]+)',\s*(\/\*\*[\s\S]*?\*\/)?\s*(async\s+)?\(/gm)) {
      const [, ch, doc, asy] = m;
      const want = asy ? "@returns {Promise<IpcResult<IpcData<'" + ch + "'>>>}" : "@returns {IpcReply<'" + ch + "'>}";
      assert.ok(doc && doc.includes(want), f + ': ' + ch + ' — липсва ' + want + '\n' + (doc || '(без JSDoc)'));
      n++;
    }
  }
  assert.ok(n >= 250, 'обработчици: ' + n);
});

test('run() носи типа на данните до отговора', () => {
  const main = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  assert.match(main, /@template T @param \{\(\) => T\} fn @returns \{IpcResult<T>\} \*\/\nfunction run\(fn\)/);
  const contract = fs.readFileSync(path.join(APP_DIR, 'types', 'ipc-contract.d.ts'), 'utf8');
  assert.match(contract, /interface HandlerDeps \{\s*run<T>\(fn: \(\) => T\): IpcResult<T>;/);
});

test('отговор с друг тип, липсващо или измислено поле е грешка; верният не е', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-otgovor77-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'probe.js'), [
    /* 1 */ "/** @type {HandlerDeps} */ const deps = /** @type {any} */ ({}); /** @returns {IpcReply<'loans:checkout'>} */ const ok1 = () => deps.run(() => 5);",
    /* 2 */ "/** @returns {IpcReply<'loans:checkout'>} */ const bad2 = () => deps.run(() => '5');",
    /* 3 */ "/** @returns {IpcReply<'account:get'>} */ const bad3 = () => deps.run(() => ({ lines: [], balanse: 0 }));",
    /* 4 */ "/** @returns {Promise<IpcResult<IpcData<'loans:checkout'>>>} */ const ok4 = async () => ({ ok: true, data: 1 });",
    /* 5 */ "/** @returns {Promise<IpcResult<IpcData<'loans:checkout'>>>} */ const bad5 = async () => ({ ok: true });",
    /* 6 */ "/** @returns {IpcReply<'books:delete'>} */ const ok6 = () => deps.run(() => { /* нищо */ });",
    'module.exports = { ok1, bad2, bad3, ok4, bad5, ok6 };'
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
  for (const n of [1, 4, 6]) assert.deepEqual(on(n), [], 'ред ' + n + ' е верен');
  for (const n of [2, 3, 5]) assert.ok(on(n).length > 0, 'ред ' + n + ' трябва да е грешка:\n' + all.join('\n'));
});
