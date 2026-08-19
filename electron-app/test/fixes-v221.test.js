/* Тестове v2.2.1 за трите неща, съзнателно отложени от голямата поправка v2.2.0:
   състоянието на автоматичното резервно копие в интерфейса, пътят на влачен файл
   (Electron 32+ премахна File.path) и „спазване на сроковете“ по година на
   ВРЪЩАНЕ вместо на заемане. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { JSDOM, VirtualConsole } = require('jsdom');
const registerStatsHandlers = require('../handlers/stats');


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

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');

/* --- 1. Статистика: спазване на сроковете по година на връщане --- */

function statsSetup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-fixes-221-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const handlers = new Map();
  const ipcMain = {
    handle: (c, fn) => handlers.set(c, fn),
    invoke: (c, ...a) => handlers.get(c)({}, ...a),
    has: (c) => handlers.has(c)
  };
  registerStatsHandlers(ipcMain, {
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } },
    yearOf: () => '2026',
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: (rows) => ({ hours: rows.reduce((s, r) => s + (r.a_hours || 0), 0) })
  });
  return { db, ipcMain };
}

test('заемане от декември, върнато със забава през януари, влиза в статистиката на НОВАТА година', async () => {
  const { db, ipcMain } = statsSetup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title, register_date) VALUES (1, 'Книга', '2025-01-01')").run().lastInsertRowid;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  // Заета 20.12.2025, падеж 03.01.2026, върната със забава на 10.02.2026.
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in) VALUES (?,?,?,?,?)')
    .run(readerId, bookId, '2025-12-20', '2026-01-03', '2026-02-10');

  const y2026 = (await ipcMain.invoke('stats:report', '2026')).data;
  assert.equal(y2026.returnedLate, 1, 'връщането е събитие от 2026 — годината, в която реално се е случило');
  assert.equal(y2026.returnedOnTime, 0);

  const y2025 = (await ipcMain.invoke('stats:report', '2025')).data;
  assert.equal(y2025.returnedLate, 0, 'отчетът за 2025 не бива да се променя със задна дата от връщане през 2026');
  assert.equal(y2025.returnedOnTime, 0);
});

test('върнатите в срок също се броят по година на връщане и не изчезват от отчета', async () => {
  const { db, ipcMain } = statsSetup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title, register_date) VALUES (1, 'Книга', '2025-01-01')").run().lastInsertRowid;
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in) VALUES (?,?,?,?,?)')
    .run(readerId, bookId, '2025-12-20', '2026-01-30', '2026-01-05');
  const r = (await ipcMain.invoke('stats:report', '2026')).data;
  assert.equal(r.returnedOnTime, 1);
  assert.equal(r.returnedLate, 0);
});

test('незърнатите заемания не влизат нито в „в срок", нито в „със забава"', async () => {
  const { db, ipcMain } = statsSetup();
  const bookId = db.prepare("INSERT INTO books (inv_number, title, register_date) VALUES (1, 'Книга', '2026-01-01')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId); // иначе trg_loans_capacity отказва
  const readerId = db.prepare("INSERT INTO readers (name) VALUES ('Читател')").run().lastInsertRowid;
  db.prepare('INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?,?,?,?)')
    .run(readerId, bookId, '2026-01-10', '2026-02-10');
  const r = (await ipcMain.invoke('stats:report', '2026')).data;
  assert.equal(r.returnedOnTime + r.returnedLate, 0);
  assert.equal(r.loansCount, 1, 'самото заемане обаче се брои за годината, в която е направено');
});

/* --- 2 и 3. Изгледи: авто-копие и влачене на файл --- */

function scriptOrderFromIndexHtml() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}
function safeDefault() {
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return (h) => (h === 'string' ? '' : 0);
      if (prop === 'length') return 0;
      if (['toString', 'toLocaleString', 'valueOf', 'toFixed', 'trim', 'replace'].includes(prop)) return () => '';
      if (['map', 'filter', 'slice', 'sort', 'concat', 'split', 'flat'].includes(prop)) return () => [];
      if (prop === 'forEach') return () => {};
      if (prop === 'join') return () => '';
      if (prop === 'reduce') return (fn, init) => init;
      if (['some', 'includes'].includes(prop)) return () => false;
      if (prop === 'every') return () => true;
      if (['find', 'indexOf'].includes(prop)) return () => (prop === 'indexOf' ? -1 : undefined);
      if (typeof prop === 'symbol') return undefined;
      return safeDefault();
    }
  });
}
function apiMock(overrides) {
  function makeNode(parts) {
    const key = parts.join('.');
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeNode(parts.concat(prop));
      },
      apply() {
        const data = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : safeDefault();
        return Promise.resolve({ ok: true, data });
      }
    });
  }
  return makeNode([]);
}
function buildDom(overrides) {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  window.api = apiMock(overrides || {});
  window.confirm = () => true;
  window.prompt = () => { throw new Error('prompt() is not supported.'); };
  window.alert = () => {};
  window.print = () => {};
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const runScript = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  runScript(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  for (const f of scriptOrderFromIndexHtml()) {
    runScript(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'), `views/${f}`);
  }
  if (errors.length) assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n---\n'));
  return dom;
}
async function settled(dom) {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return dom;
}

test('картата „Резервно копие" предупреждава, когато дневното копие НЕ е криптирано', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  await window.renderSetup(); // #autoBkBox се създава от екрана „Настройки"
  window.api = {
    backup: {
      autoStatus: async () => ({ ok: true, data: {
        encrypted: false, pdpConfigured: false, pdpUnlocked: false, last: null,
        warning: 'Автоматичните дневни копия НЕ са криптирани и съдържат личните данни на читателите.'
      } })
    }
  };
  await window.loadAutoBackupBox();
  const html = window.document.getElementById('autoBkBox').innerHTML;
  /* Проверява се СМИСЪЛЪТ, не буквата: че предупреждението стига до екрана и че
     до него стои действието „включи защитата". Точните надписи на бутоните са
     кандидат № 1 за преформулиране и заковаването им дава фалшиви провали. */
  assert.match(html, /не са криптирани/i, 'предупреждението трябва да се вижда в екрана, не само в одита');
  assert.match(html, /pdpSetupForm/, 'предлага се именно действието „включване на защитата"');
  assert.match(html, /защита(та)? на личните данни/i, 'и то назовано разбираемо за библиотекаря');
});

test('когато защитата е включена, но заключена, предупреждението сочи към отключването', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  await window.renderSetup(); // #autoBkBox се създава от екрана „Настройки"
  window.api = {
    backup: {
      autoStatus: async () => ({ ok: true, data: {
        encrypted: false, pdpConfigured: true, pdpUnlocked: false, last: null,
        warning: 'Автоматичните дневни копия не се криптират, докато защитата на личните данни е заключена.'
      } })
    }
  };
  await window.loadAutoBackupBox();
  const html = window.document.getElementById('autoBkBox').innerHTML;
  assert.match(html, /заключена/);
  // Пак по смисъл: сочи се към ОТКЛЮЧВАНЕТО (pdpFocus), а не към включването.
  assert.match(html, /pdpFocus/, 'посочва се къде се отключва защитата');
  assert.doesNotMatch(html, /pdpSetupForm/, 'защитата вече е включена — не се предлага пак да се включва');
});

test('при криптирано копие се показва потвърждение, без предупреждение', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  await window.renderSetup(); // #autoBkBox се създава от екрана „Настройки"
  window.api = {
    backup: {
      autoStatus: async () => ({ ok: true, data: {
        encrypted: true, pdpConfigured: true, pdpUnlocked: true,
        last: { date: '2026-08-17', encrypted: true }, warning: null
      } })
    }
  };
  await window.loadAutoBackupBox();
  const html = window.document.getElementById('autoBkBox').innerHTML;
  assert.match(html, /криптират/);
  assert.doesNotMatch(html, /НЕ са криптирани/);
});

test('влаченият файл се чете през моста (webUtils), а не през премахнатия File.path', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  const loaded = [];
  window.api = {
    importData: {
      // Electron 32+ : File.path е undefined, пътят идва само оттук.
      pathOf: () => 'C:\\Users\\b\\Documents\\fond.csv',
      load: async (p) => { loaded.push(p); return { ok: true, data: { headers: [], rows: [] } }; }
    }
  };
  const toasts = [];
  window.toast = (m, t) => toasts.push([t, m]);
  window.importMapModal = () => {};

  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [{ name: 'fond.csv' }] }; // без .path, както в Electron 43
  window.document.dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 10));

  assert.deepEqual(loaded, ['C:\\Users\\b\\Documents\\fond.csv'],
    'пътят трябва да стигне до import:load през моста');
  assert.equal(toasts.filter(t => t[0] === 'err').length, 0, 'няма грешка при успешно влачене');
});

test('когато и мостът не върне път, излиза ясно съобщение вместо мълчание', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  const loaded = [];
  window.api = {
    importData: { pathOf: () => '', load: async (p) => { loaded.push(p); return { ok: true, data: {} }; } }
  };
  const toasts = [];
  window.toast = (m, t) => toasts.push([t, m]);

  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [{ name: 'fond.csv' }] };
  window.document.dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 10));

  assert.equal(loaded.length, 0);
  assert.equal(toasts.length, 1, 'мълчаливият return беше самият дефект');
  assert.equal(toasts[0][0], 'err');
  assert.match(toasts[0][1], /Избери файл за внасяне/);
});

test('влаченият файл с неподдържано разширение се отказва по РАЗЧЕТЕНИЯ път', async () => {
  const dom = await settled(buildDom({}));
  const { window } = dom;
  const loaded = [];
  window.api = {
    importData: { pathOf: () => 'C:\\tmp\\snimka.jpg', load: async (p) => { loaded.push(p); return { ok: true, data: {} }; } }
  };
  const toasts = [];
  window.toast = (m, t) => toasts.push([t, m]);

  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [{ name: 'snimka.jpg' }] };
  window.document.dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 10));

  assert.equal(loaded.length, 0);
  assert.match(toasts[0][1], /CSV, TXT, TSV и XLSX/);
});

/* --- 4. Мостът в preload.js --- */

test('preload.js излага importData.pathOf и backup.autoStatus', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(src, /webUtils/, 'пътят на влачен файл се чете само през webUtils в preload');
  assert.match(src, /getPathForFile/);
  assert.match(src, /pathOf:/);
  assert.match(src, /autoStatus: invoke\('backup:autoStatus'\)/);
});
