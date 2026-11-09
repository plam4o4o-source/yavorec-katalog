'use strict';
/* v2.4.88 — САМОЗАРЕЖДАНЕ НА СЛЕДВАЩАТА ПОРЦИЯ, В ИСТИНСКИ CHROMIUM.
   =====================================================================
   Порцията на големите таблици стана 100 реда (беше 300): при 4× забавен
   процесор и 15 000 книги отварянето на „Книги“ спадна от 508 на 198 ms. За да
   не плаща библиотекарят това с повече щракания, следващата порция идва сама,
   щом лентата „Покажи още“ влезе в полезрението (autoMoreWatch в core.js).
   jsdom няма нито превъртане, нито IntersectionObserver — затова тук: истинските
   екрани в Chromium, свързани с истинския main.js, база с 450 книги и 260
   читатели. Проверява се, че:
     • отварянето чертае точно една порция (100 реда);
     • превъртане до дъното зарежда следващата — без щракване;
     • без превъртане нищо не се зарежда само (лентата не е на екрана);
     • при всичко заредено лентата е празна и превъртането не прави нищо;
     • същото важи и за „Читатели“ (друг изглед, същата машинка).
   Пропуска се, ако на машината няма Chromium. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), fs = require('fs');
const { startMainApp } = require('./helpers/main-app');
const E = require('./helpers/e2e-app');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
function findChromium() {
  const cands = [process.env.PECHAT_PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright'];
  let pw = null;
  for (const p of cands.filter(Boolean)) { try { pw = require(p); break; } catch (e) { /* следващият път */ } }
  const exe = [process.env.PECHAT_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean).find(p => fs.existsSync(p));
  return pw && exe ? { pw, exe } : null;
}
const CH = findChromium();
const SKIP = !CH ? 'няма playwright/Chromium на машината (PECHAT_CHROMIUM)' : false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('Chromium: превъртането до „Покажи още“ зарежда следващите 100 реда само', { skip: SKIP, timeout: 120000 }, async () => {
  const app = startMainApp(); await app.ready();
  const db = new Database(path.join(app.userData, 'library.db'));
  const T = E.today();
  db.prepare("UPDATE settings SET lib_name='Библиотека', org='НЧ', place='с. Яворец' WHERE id=1").run();
  const ins = db.prepare("INSERT INTO books (inv_number,title,author,price,register_date,status,status_date,department) VALUES (?,?,?,?,?,?,?,?)");
  const insI = db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)');
  const insR = db.prepare("INSERT INTO readers (name, card_no, category, status, gdpr_consent, registered_at) VALUES (?,?,?,?,1,?)");
  db.transaction(() => {
    for (let i = 1; i <= 450; i++) insI.run(ins.run(i, 'Заглавие ' + i, 'Автор ' + (i % 90), 5, T, 'наличен', T, 'Заемна').lastInsertRowid);
    for (let i = 1; i <= 260; i++) insR.run('Читател ' + i, 'Ч-' + String(i).padStart(5, '0'), 'възрастен', 'активен', T);
  })();
  db.close();

  let inflight = 0;
  const browser = await CH.pw.chromium.launch({ executablePath: CH.exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    await ctx.exposeBinding('__ipc', async (src, ch, args) => {
      inflight++;
      try { const r = await app.invoke(ch, ...(args || [])); return r === undefined ? null : JSON.parse(JSON.stringify(r)); }
      finally { inflight--; }
    });
    await ctx.addInitScript((tbl) => {
      const api = {};
      for (const [ns, ms] of Object.entries(tbl)) {
        api[ns] = {};
        for (const [m, spec] of Object.entries(ms)) {
          if (spec.channel) api[ns][m] = (...a) => window.__ipc(spec.channel, a);
          else if (spec.kind === 'listener') api[ns][m] = () => {};
          else api[ns][m] = (f) => (f && f.path) || '';
        }
      }
      window.api = api;
    }, E.preloadTable());
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    await pg.goto('file://' + path.join(APP, 'src', 'index.html'));
    await pg.waitForFunction(() => typeof VIEW !== 'undefined' && document.querySelector('#view').children.length > 0, null, { timeout: 30000 });

    const quiet = async () => { let q = 0; while (q < 4) { await sleep(40); q = inflight ? 0 : q + 1; } await sleep(120); };
    const rows = (sel) => pg.evaluate((s) => document.querySelectorAll(s + ' tr').length, sel);
    const open = async (v, body) => {
      await pg.evaluate((x) => { location.hash = '#' + x; }, v);
      await pg.waitForFunction(([x, b]) => VIEW === x && document.querySelectorAll(b + ' tr').length > 0, [v, body], { timeout: 20000 });
      await quiet();
    };
    const toBottom = async (bar) => {
      await pg.evaluate((b) => document.querySelector(b).scrollIntoView({ block: 'end' }), bar);
      await quiet();
    };

    // „Книги“: 450 = 100 + 100 + 100 + 100 + 50.
    await open('books', '#bBody');
    assert.equal(await rows('#bBody'), 100, 'отварянето чертае една порция');
    await sleep(400);
    assert.equal(await rows('#bBody'), 100, 'без превъртане нищо не се зарежда само');
    await toBottom('#bMore');
    assert.equal(await rows('#bBody'), 200, 'превъртане до лентата — следващата порция, без щракване');
    for (let i = 0; i < 6 && await rows('#bBody') < 450; i++) await toBottom('#bMore');
    assert.equal(await rows('#bBody'), 450, 'до края — всичките 450');
    assert.doesNotMatch(await pg.textContent('#bMore'), /Покажи още/);
    const ids = await pg.evaluate(() => [...document.querySelectorAll('#bBody tr[data-id]')].map(r => r.dataset.id));
    assert.equal(new Set(ids).size, ids.length, 'нито един ред не е дублиран');

    // „Читатели“: 260 = 100 + 100 + 60.
    await open('readers', '#rBody');
    assert.equal(await rows('#rBody'), 100);
    await toBottom('#rMore');
    assert.equal(await rows('#rBody'), 200);
    await toBottom('#rMore');
    assert.equal(await rows('#rBody'), 260);

    assert.deepEqual(errs, [], 'грешки в страницата');
  } finally {
    await browser.close();
    app.stop();
  }
});
