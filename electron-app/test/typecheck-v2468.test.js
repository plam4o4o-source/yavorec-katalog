'use strict';
/* ============================================================================
   v2.4.68 — ПРОВЕРКАТА НА ТИПОВЕТЕ НАИСТИНА ПРОВЕРЯВА.
   ============================================================================
   `npm run typecheck` (tsc --checkJs) минава чисто в CI. Това само по себе си
   не доказва нищо: проверка, която не вижда window.api (както беше преди
   описанието — 349 съобщения „Property 'api' does not exist“), също може да
   бъде „чиста“ след едно `any`. Тук се показва, че описанието има сила:
     1) types/api.generated.d.ts е точно това, което излага preload.js;
     2) грешно име на метод или група в изглед е грешка при проверката,
        а вярното — не;
     3) нова стойност на window, която не е описана, също е грешка. */
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

test('описанието на window.api отговаря на preload.js', () => {
  const r = spawnSync(process.execPath, [path.join(APP_DIR, 'scripts', 'gen-api-types.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const { render } = require('../scripts/gen-api-types');
  const text = render();
  const preload = fs.readFileSync(path.join(APP_DIR, 'preload.js'), 'utf8');
  const invokes = (preload.match(/:\s*invoke\('/g) || []).length;
  assert.equal((text.match(/: InvLibInvoke;/g) || []).length, invokes, 'всеки метод през invoke() е описан');
});

/* Изгледите + един допълнителен файл — като истинската проверка, но с проба. */
function checkRendererWith(probe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-typecheck-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'probe.js'), probe);
  const base = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'tsconfig.renderer.json'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, ''));
  const cfg = {
    compilerOptions: base.compilerOptions,
    include: base.include.map(p => path.join(APP_DIR, p)).concat(path.join(dir, 'probe.js'))
  };
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  return (r.stdout || '') + (r.stderr || '');
}

test('грешно име на метод или група в window.api е грешка; вярното не е', () => {
  const out = checkRendererWith([
    'async function probeOk() { await window.api.loans.checkout({ reader_id: 1, book_id: 2 }); }',
    'async function probeTypo() { await window.api.loans.chekout({}); }',
    'async function probeGroup() { await window.api.laons.list(); }',
    'window._UNDECLARED_LIST = [];'
  ].join('\n'));
  const probeLines = out.split('\n').filter(l => l.includes('probe.js'));
  assert.ok(probeLines.some(l => /\(2,\d+\): error TS2551|\(2,\d+\): error TS2339/.test(l) && /chekout/.test(l)),
    'api.loans.chekout трябва да е грешка:\n' + out);
  assert.ok(probeLines.some(l => /laons/.test(l)), 'api.laons трябва да е грешка:\n' + out);
  assert.ok(probeLines.some(l => /_UNDECLARED_LIST/.test(l)), 'неописана стойност на window трябва да е грешка:\n' + out);
  assert.ok(!probeLines.some(l => /\(1,/.test(l)), 'вярното извикване не бива да е грешка:\n' + probeLines.join('\n'));
  assert.equal(out.split('\n').filter(l => /error TS/.test(l) && !l.includes('probe.js')).length, 0,
    'самите изгледи минават чисто:\n' + out);
});
