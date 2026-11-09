'use strict';
/* v2.4.88 — по-бързи големи таблици, естествена подредба, по-малък инсталатор,
   по-стабилни тестове.
   ==========================================================================
     Т1  порцията на големите таблици е 100 реда (беше 300), а следващата се
         зарежда САМА, щом лентата „Покажи още“ влезе в полезрението.
     Т2  тестовете в истински Chromium вървят в CI (отделна задача).
     Т3  инсталаторът носи само българските и английските файлове на Chromium и
         не носи изходния код на SQLite и неизползваните части на zxing-wasm.
     Т5  действията на GitHub — на версии с Node 24.
     Т6  щракването в тестовете изчаква елемента; main.js се зарежда тихо.
     Т7  аналитичното описание подрежда „част 2“ преди „част 10“. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('./helpers/e2e-app');
const { quietBoot } = require('./helpers/main-app');

const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, '..');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let h = null;
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

/* ---------------- Т1 ---------------- */
test('Т1 — порцията е 100 реда, таванът остава 3 000', () => {
  assert.equal(h.window.RENDER_PAGE_SIZE, 100);
  assert.equal(h.window.RENDER_MAX_ROWS, 3000);
  assert.match(read(APP, 'src', 'views', 'core.js'), /отварянето на „Книги“ спадна от 508 на 198 ms/,
    'бележката казва защо — с измерените числа');
});

test('Т1 — „Покажи още“ се натиска сам, щом лентата се види; веднъж на порция', () => {
  const w = h.window;
  /* jsdom няма IntersectionObserver — двойник, който запомня наблюдаваното и
     позволява „превъртане“ на ръка. */
  const watched = new Set();
  let cb = null;
  w.IntersectionObserver = class {
    constructor(f) { cb = f; }
    observe(el) { watched.add(el); }
    unobserve(el) { watched.delete(el); }
  };
  const scrollTo = (el) => cb([{ target: el, isIntersecting: true }]);
  const d = w.document;
  const host = d.createElement('div');
  host.innerHTML = '<table><tbody id="t1Body"></tbody></table><div id="t1Bar"></div>';
  d.body.appendChild(host);
  const rows = Array.from({ length: 250 }, (_, i) => i + 1);
  let painted = 0, clicks = 0;
  const paint = (append) => {
    painted = w.paintRowWindow({
      body: '#t1Body', bar: '#t1Bar', rows, limit: w.T1_LIMIT, painted: append ? painted : 0,
      rowsHtml: (part) => part.map(n => `<tr><td>${n}</td></tr>`).join(''),
      moreHtml: (more, total) => more > 0 ? `<button class="btn" onclick="T1_MORE()">Покажи още (${more} от общо ${total})</button>` : ''
    });
  };
  w.T1_LIMIT = 100;
  w.T1_MORE = () => { clicks++; w.T1_LIMIT += 100; paint(true); };
  paint(false);
  const bar = d.getElementById('t1Bar');
  assert.equal(d.querySelectorAll('#t1Body tr').length, 100);
  assert.ok(watched.has(bar), 'лентата с бутон се следи');

  scrollTo(bar);
  assert.equal(clicks, 1, 'едно превъртане — една порция');
  assert.equal(d.querySelectorAll('#t1Body tr').length, 200);
  assert.ok(watched.has(bar), 'новата лента пак се следи — за следващата порция');

  scrollTo(bar);
  assert.equal(d.querySelectorAll('#t1Body tr').length, 250);
  assert.equal(bar.textContent.trim(), '', 'всичко е показано — няма бутон');
  assert.ok(!watched.has(bar), 'лента без бутон не се следи');
  scrollTo(bar);
  assert.equal(clicks, 2, 'няма какво да се натиска');

  // Лента с друг бутон (не „Покажи още“) не се натиска.
  bar.innerHTML = '<button onclick="T1_MORE()">Печат</button>';
  w.autoMoreWatch(bar);
  assert.ok(!watched.has(bar));
  host.remove();
  delete w.IntersectionObserver;
});

/* ---------------- Т7 ---------------- */
test('Т7 — аналитично описание: „част 2“ преди „част 10“, по български азбучен ред, годината остава първа', async () => {
  {
    const mk = async (title, year) => {
      const r = await h.api.analytics.create({ title, source_kind: 'друго', source_text: 'сборник', year });
      assert.ok(r.ok, JSON.stringify(r));
    };
    for (const n of [10, 2, 1, 12, 3]) await mk('Яворец през вековете, част ' + n, '2020');
    await mk('Читалището', '2020');
    await mk('Яворец през вековете, част 9', '2021');
    await mk('Без година', '');
    const r = await h.api.analytics.list({});
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.data.map(a => a.title), [
      'Яворец през вековете, част 9',
      'Читалището',
      'Яворец през вековете, част 1', 'Яворец през вековете, част 2', 'Яворец през вековете, част 3',
      'Яворец през вековете, част 10', 'Яворец през вековете, част 12',
      'Без година'
    ]);
  }
});

/* ---------------- Т3 ---------------- */
test('Т3 — инсталаторът: само bg и en-US; без изходния код на SQLite и без неизползваното от zxing-wasm', () => {
  const b = JSON.parse(read(APP, 'package.json')).build;
  assert.deepEqual(b.electronLanguages, ['bg', 'en-US']);
  for (const p of [
    '!node_modules/better-sqlite3/{deps,src}${/*}',
    '!node_modules/zxing-wasm/dist/{full,writer,es,miniprogram}${/*}',
    '!node_modules/zxing-wasm/dist/{iife,cjs}/{full,writer}${/*}'
  ]) assert.ok(b.files.includes(p), 'изключено: ' + p);
  /* Онова, което програмата ползва, НЕ е изключено: четецът за телефона
     (mobile-page.js → zxingFiles) и самият SQLite модул. */
  const { zxingFiles } = require('../mobile-page');
  const z = zxingFiles();
  const rel = (f) => path.relative(APP, f).split(path.sep).join('/');
  const excluded = b.files.filter(p => p.startsWith('!')).map(p => p.slice(1).replace('${/*}', ''));
  const hit = (file) => excluded.some(p => {
    const alts = p.replace(/\{([^}]+)\}/g, '($1)').replace(/,/g, '|').replace(/\./g, '\\.').replace(/\*\*\/\*/g, '.*').replace(/\*/g, '[^/]*');
    return new RegExp('^' + alts + '(/|$)').test(file);
  });
  for (const f of [rel(z.js), rel(z.wasm), rel(require.resolve('zxing-wasm/reader')),
    'node_modules/better-sqlite3/lib/index.js', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'node_modules/better-sqlite3/package.json']) {
    assert.ok(!hit(f), 'не бива да е изключено: ' + f);
  }
  assert.ok(hit('node_modules/better-sqlite3/deps/sqlite3/sqlite3.c'));
  assert.ok(hit('node_modules/zxing-wasm/dist/full/zxing_full.wasm'));
  assert.ok(hit('node_modules/zxing-wasm/dist/iife/writer/index.js'));
});

/* ---------------- Т2, Т5 ---------------- */
test('Т2 — CI пуска тестовете в Chromium и пада, ако някой е пропуснат заради липсващ инструмент', () => {
  const ci = read(ROOT, '.github', 'workflows', 'ci.yml');
  assert.match(ci, /\n  chromium:\n/);
  assert.match(ci, /playwright@[\d.]+ install --with-deps chromium/);
  assert.match(ci, /poppler-utils/);
  assert.match(ci, /PECHAT_CHROMIUM=/);
  assert.match(ci, /# SKIP\.\*\(Chromium\|playwright\|pdftotext/);
  for (const f of ['pechat-v2469', 'pechat-v2471', 'pechat-v2471-podpisi', 'pechat-v2487', 'kraeved-v2469',
    'izvestiya-v2486', 'raboten-den-chromium', 'samozarezhdane-chromium']) {
    assert.ok(ci.includes('test/' + f + '.test.js'), 'в задачата: ' + f);
    assert.ok(fs.existsSync(path.join(APP, 'test', f + '.test.js')), 'файлът съществува: ' + f);
  }
});

test('Т5 — действията на GitHub са на версии с Node 24', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const min = { checkout: 5, 'setup-node': 5, 'upload-artifact': 6, 'configure-pages': 6, 'upload-pages-artifact': 5, 'deploy-pages': 5 };
  let n = 0;
  for (const f of fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
    for (const m of read(dir, f).matchAll(/uses:\s*actions\/([\w-]+)@v(\d+)/g)) {
      n++;
      assert.ok(m[1] in min, f + ': непознато действие ' + m[1]);
      assert.ok(Number(m[2]) >= min[m[1]], `${f}: actions/${m[1]}@v${m[2]} още е на Node 20`);
    }
  }
  assert.ok(n >= 13, 'проверени ' + n);
});

/* ---------------- Т6 ---------------- */
test('Т6 — щракването изчаква закъснял бутон, вместо да гърми веднага', async () => {
  const d = h.document;
  const box = d.createElement('div'); box.id = 't6Box'; d.body.appendChild(box);
  let hit = 0;
  h.window.T6_HIT = () => { hit++; };
  setTimeout(() => { box.innerHTML = '<footer><button onclick="T6_HIT()">Разбрах</button></footer>'; }, 150);
  await h.clickButton('Разбрах', '#t6Box');
  assert.equal(hit, 1);
  await assert.rejects(h.clickButton('Няма го', '#t6Box'), /Няма бутон „Няма го“/, 'липсващият пак е грешка — след срока');
  box.remove();
});

test('Т6 — main.js се зарежда тихо: console.log мълчи, console.error — не', () => {
  const seen = [];
  const keep = { log: console.log, error: console.error };
  console.log = (...a) => seen.push(['log', a.join(' ')]);
  console.error = (...a) => seen.push(['error', a.join(' ')]);
  try {
    const loud = quietBoot();
    console.log('Схемата на базата данни е обновена до версия 19.');
    console.error('истинска грешка');
    loud();
    console.log('след зареждането');
  } finally { console.log = keep.log; console.error = keep.error; }
  assert.deepEqual(seen, [['error', 'истинска грешка'], ['log', 'след зареждането']]);
});
