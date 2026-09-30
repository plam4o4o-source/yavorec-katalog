'use strict';
/* ============================================================================
   v2.4.73 — ДОГОВОРЪТ ЗА ВСИЧКИ КАНАЛИ И НАМЕРЕНОТО ПРИ ОПИСВАНЕТО МУ.
   ============================================================================
   types/ipc-contract.d.ts вече описва всичките 247 канала (test/typecheck-v2472
   пази, че нито един не е останал без описание и че всеки обработчик носи типа
   си). Тук:
     1) каналите, чийто отговор зависи от аргументите (books:list, readers:list,
        invBook:list), дават на екрана точния отговор за режима му — и грешният
        режим е грешка при проверката;
     2) находките от описването, поправени в това издание — всяка минава през
        истинския main.js и истинския екран (jsdom), и пада без поправката. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./helpers/e2e-app');

const APP_DIR = path.join(__dirname, '..');
const TSC = require.resolve('typescript/bin/tsc');
const tmpDirs = [];
let h = null;
test.before(async () => { h = await E.bootApp(); });
test.after(() => {
  if (h) h.stop();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const W = () => h.window;

function checkRendererWith(probe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-contract73-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'probe.js'), probe);
  const base = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'tsconfig.renderer.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const cfg = {
    compilerOptions: Object.assign({}, base.compilerOptions, { typeRoots: [path.join(APP_DIR, 'node_modules', '@types')] }),
    include: base.include.map(p => path.join(APP_DIR, p)).concat(path.join(dir, 'probe.js'))
  };
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  return { out, lines: out.split('\n').filter(l => l.includes('probe.js')),
    others: out.split('\n').filter(l => /error TS/.test(l) && !l.includes('probe.js')) };
}
const onLine = (lines, n) => lines.filter(l => new RegExp('probe\\.js\\(' + n + ',').test(l));

test('режимите на списъците: екранът получава точния отговор, а грешният режим е грешка', () => {
  const r = checkRendererWith([
    /* 1 */ "async function ok1() { const a = await call(window.api.books.list('', 'inv', { labels: true, from: 1, to: 9 })); if (a) a[0].inv_number.toFixed(0); const w = await call(window.api.readers.list('', null, { offset: 0 })); if (w) w.noConsent.toFixed(0); const l = await call(window.api.readers.list('Ив', 20)); if (l) l.slice(0, 1); const ib = await call(window.api.invBook.list()); if (ib) ib.length.toFixed(0); }",
    /* 2 */ "async function bad2() { const a = await call(window.api.books.list('', 'inv', { labels: true })); if (a) a.rows; }",
    /* 3 */ "async function bad3() { const l = await call(window.api.readers.list('Ив', 20)); if (l) l.rows; }",
    /* 4 */ "async function bad4() { const w = await call(window.api.invBook.list({ offset: 0 })); if (w) w.length.toFixed(0); }",
    /* 5 */ "async function bad5() { const x = await call(window.api.books.list('', 'inv', { idsOnly: true })); if (x) x.total; }"
  ].join('\n'));
  assert.equal(r.others.length, 0, 'самите изгледи минават чисто:\n' + r.out);
  assert.deepEqual(onLine(r.lines, 1), [], 'вярното ползване на всеки режим не е грешка');
  for (const n of [2, 3, 4, 5]) assert.ok(onLine(r.lines, n).length > 0, 'ред ' + n + ' трябва да е грешка:\n' + r.out);
});

test('настройки: „5 лв.“ в паричното поле се отказва на екрана — не се записва като 5 €', async () => {
  const before = q('SELECT annual_fee AS f FROM settings WHERE id = 1').f;
  await h.go('setup');
  h.type('#stF [name=org]', 'НЧ „Тест“');
  h.type('#view [name=annual_fee]', '5 лв.');
  const n0 = h.toasts.length, c0 = h.stats.calls.length;
  await h.clickButton('Запиши настройките', '#view');
  const t = h.toastsSince(n0);
  assert.ok(t.some(x => x.type === 'err' && /Годишна такса/.test(x.msg) && /не е число/.test(x.msg)), JSON.stringify(t));
  assert.ok(!h.stats.calls.slice(c0).some(c => c.channel === 'settings:update'), 'отказва ЕКРАНЪТ — заявка не тръгва');
  assert.equal(q('SELECT annual_fee AS f FROM settings WHERE id = 1').f, before, 'старата стойност остава');
});

test('настройки: обработчикът отказва текст в числово поле с името му; „2,50“ и „1 000“ се четат вярно', async () => {
  const s = (await h.api.settings.get()).data;
  const base = Object.assign({}, s);
  try {
    for (const [field, raw, label] of [['annual_fee', '5 лв.', 'Годишна такса'], ['fine_per_day', '1.234,50', 'Обезщетение за забава'],
      ['loan_days', '14 дни', 'Срок за заемане'], ['loan_days', '14,5', 'цяло число']]) {
      const r = await h.api.settings.update(Object.assign({}, base, { [field]: raw }));
      assert.equal(r.ok, false, field + ' = „' + raw + '“ е записано');
      assert.match(r.error, new RegExp(label));
      assert.equal(q('SELECT ' + field + ' AS v FROM settings WHERE id = 1').v, s[field], field + ' е променено');
    }
    const r = await h.api.settings.update(Object.assign({}, base, { annual_fee: '+2,50', remind2_days: '1 000', loan_days: '14.0' }));
    assert.equal(r.ok, true, r.error);
    const row = q('SELECT annual_fee AS f, remind2_days AS d, loan_days AS l FROM settings WHERE id = 1');
    assert.equal(row.f, 2.5, '„+2,50“ минава и на екрана');
    assert.equal(row.d, 1000, '„1 000“ е хиляда, не 1');
    assert.equal(row.l, 14, '„14.0“ от числовото поле е 14');
  } finally {
    assert.equal((await h.api.settings.update(base)).ok, true);
  }
});

test('SRU: невалиден адрес в настройките е отговор с причината, не „няма връзка с интернет“', async () => {
  h.db.prepare("UPDATE settings SET sru_endpoint = 'file:///C:/Windows/win.ini' WHERE id = 1").run();
  try {
    const r = await h.api.sru.lookup('9789540000017');
    assert.equal(r.ok, false);
    assert.match(r.error, /не е валиден http\(s\) адрес/);
  } finally {
    h.db.prepare("UPDATE settings SET sru_endpoint = NULL WHERE id = 1").run();
  }
});

test('Defender: папката, която скриптът не може да добави сам, е показана отделно — не като добавена', async () => {
  const bad = path.join(os.tmpdir(), 'kat\talog');
  h.db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(bad);
  try {
    await W().avScript(); await h.settle();
    const html = h.$('#modal').innerHTML;
    const steps = h.$('#modal ul.steps').textContent;
    assert.ok(!steps.includes('kat\talog'), 'папката стои в списъка „ще бъдат добавени“');
    assert.match(h.modal(), /скриптът не може да добави сам/);
    assert.ok(h.$('#modal .note.w').textContent.includes('kat\talog'), 'името на папката е казано: ' + html.slice(0, 400));
    W().closeModal(); await h.settle();
  } finally {
    h.db.prepare('UPDATE settings SET catalog_folder = NULL WHERE id = 1').run();
  }
});

test('връзка към отчислен документ: съветът не сочи поле, което панелът няма', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'handlers', 'links.js'), 'utf8');
  assert.doesNotMatch(src, /в бележката към връзката/);
  const panel = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'links.js'), 'utf8');
  assert.doesNotMatch(panel, /name="?note/, 'ако панелът получи поле за бележка, съветът може да се върне');
});
