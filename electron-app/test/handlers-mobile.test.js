// Тест на handlers/mobile.js — трийсет и седми домейн, извадено от main.js
// (Фаза 4, стъпка 36). Покрива mobile:generate и
// inventorySessions:importScans.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerMobileHandlers = require('../handlers/mobile');
const { normalizeScanCode } = require('../security-utils');


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

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-mobile-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const savedDialogs = { saveDialog: null };
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    dialog: {
      showSaveDialog: async (win, opts) => {
        savedDialogs.lastOptions = opts;   // предложеното име на файла е част от проверката
        return savedDialogs.saveDialog || { canceled: false, filePath: path.join(dir, 'out.html') };
      }
    },
    getMainWindow: () => ({}),
    fs, path, normalizeScanCode
  };
  registerMobileHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, dir, savedDialogs };
}

test('registerMobileHandlers registers mobile:generate and inventorySessions:importScans', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('mobile:generate'));
  assert.ok(ipcMain.has('inventorySessions:importScans'));
});

test('mobile:generate reports cancellation from the save dialog', async () => {
  const { ipcMain, savedDialogs } = setup();
  savedDialogs.saveDialog = { canceled: true, filePath: null };
  const result = await ipcMain.invoke('mobile:generate');
  assert.equal(result.ok, false);
  assert.match(result.error, /Отказано/);
});

test('mobile:generate writes the mobile scanner page with the library name substituted in', async () => {
  const { db, ipcMain, dir } = setup();
  db.prepare("UPDATE settings SET lib_name='НЧ Васил Левски', place='с. Яворец' WHERE id=1").run();
  const outPath = path.join(dir, 'scanner.html');
  const result = await ipcMain.invoke('mobile:generate');
  assert.equal(result.ok, true);
  const html = fs.readFileSync(result.data, 'utf8');
  assert.ok(html.includes('НЧ Васил Левски · с. Яворец'));
  assert.ok(!html.includes('__LIB__'));
});

/* ------------------------------------------------------------------
   Името на библиотеката в самата страница (v2.4.45)
   ------------------------------------------------------------------ */

test('името от настройките влиза и в <title>, и в предложеното име на файла', async () => {
  /* Заглавието не е украса: то е името на раздела в Chrome и точно него получава
     иконата, ако страницата се добави на началния екран. Дотук навсякъде пишеше
     „Инвентаризация — сканиране“, а библиотеката се четеше само от лентата вътре. */
  const { db, ipcMain, savedDialogs } = setup();
  db.prepare("UPDATE settings SET lib_name='Библиотека при НЧ „Васил Левски“', place='с. Яворец' WHERE id=1").run();
  const result = await ipcMain.invoke('mobile:generate');
  assert.equal(result.ok, true, result.error);
  const html = fs.readFileSync(result.data, 'utf8');
  const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
  assert.match(title, /Библиотека при НЧ/, 'заглавието трябва да носи името на библиотеката: ' + title);
  assert.match(title, /Инвентаризация/, 'но и за какво е страницата: ' + title);
  assert.equal(/__[A-Z]+__/.test(html), false, 'нито един незаместен образец не бива да стигне до телефона');
  const slug = html.match(/var SLUG = '(.*)'/)[1];
  assert.match(slug, /^[a-z0-9-]+$/, 'името за файла е на латиница и без знаци, които Windows не приема');
  assert.match(savedDialogs.lastOptions.defaultPath, new RegExp('^inventarizaciya-skener-' + slug + '\\.html$'),
    'предложеното име на файла също носи библиотеката: ' + savedDialogs.lastOptions.defaultPath);
});

test('при непопълнени настройки страницата пази смислено заглавие и общо име на файла', async () => {
  const { ipcMain, savedDialogs } = setup();        // празен ред settings
  const result = await ipcMain.invoke('mobile:generate');
  assert.equal(result.ok, true, result.error);
  const html = fs.readFileSync(result.data, 'utf8');
  assert.equal(html.match(/<title>([\s\S]*?)<\/title>/)[1], 'Инвентаризация — сканиране');
  assert.equal(html.match(/var SLUG = '(.*)'/)[1], '');
  assert.equal(savedDialogs.lastOptions.defaultPath, 'inventarizaciya-skener.html');
  assert.equal(/__[A-Z]+__/.test(html), false);
});

test('име с „$&“ влиза буквално, а не като част от самата страница', async () => {
  /* String.replace с НИЗ за заместител тълкува $&, $` и $1. Името идва от
     настройките, тоест го пише човек: „Библиотека $& Читалище“ би вкарало
     самия образец обратно, а „$`“ — цялото начало на файла в заглавието му. */
  const { db, ipcMain } = setup();
  db.prepare("UPDATE settings SET lib_name=?, place='' WHERE id=1").run("Библиотека $& $` $' $1");
  const result = await ipcMain.invoke('mobile:generate');
  assert.equal(result.ok, true, result.error);
  const html = fs.readFileSync(result.data, 'utf8');
  assert.ok(html.includes("Библиотека $&amp; $` $&#39; $1"),
    'името трябва да се появи както е въведено (с екранирани HTML знаци)');
  assert.equal(html.includes('<!DOCTYPE html>\n<html lang="bg">\n<head>\n<meta charset="utf-8">\n<meta name="viewport"'
    + ' content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title><!DOCTYPE'), false,
    '$` не бива да вкара началото на файла в заглавието');
});

test('ъгловите скоби в името се екранират, вместо да се изтриват', async () => {
  /* Дотук се махаха с replace(/[<>&]/g, ''): „Иван & Мария“ ставаше „Иван  Мария“. */
  const { db, ipcMain } = setup();
  db.prepare("UPDATE settings SET lib_name='Читалище „Х&Y“', place='' WHERE id=1").run();
  const result = await ipcMain.invoke('mobile:generate');
  const html = fs.readFileSync(result.data, 'utf8');
  assert.ok(html.includes('Читалище „Х&amp;Y“'), 'амперсандът се показва, а не изчезва');
  assert.equal(html.includes('<script>alert'), false);
});

function startSession(db, overrides = {}) {
  const info = db.prepare(`INSERT INTO inventory_sessions (date, scope, department, committee1, committee2, committee3)
    VALUES (@date, @scope, @department, @committee1, @committee2, @committee3)`).run(Object.assign({
    date: '2026-08-02', scope: 'пълна', department: null, committee1: null, committee2: null, committee3: null
  }, overrides));
  return info.lastInsertRowid;
}

test('inventorySessions:importScans requires an open (non-closed) session', async () => {
  const { db, ipcMain } = setup();
  const sessionId = startSession(db);
  db.prepare('UPDATE inventory_sessions SET closed = 1 WHERE id = ?').run(sessionId);
  const result = await ipcMain.invoke('inventorySessions:importScans', { sessionId, codes: ['1'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /Няма отворена сесия/);
});

test('inventorySessions:importScans rejects an empty code list', async () => {
  const { db, ipcMain } = setup();
  const sessionId = startSession(db);
  const result = await ipcMain.invoke('inventorySessions:importScans', { sessionId, codes: ['', '  '] });
  assert.equal(result.ok, false);
  assert.match(result.error, /празен/);
});

test('inventorySessions:importScans matches by barcode or inv_number, dedupes, flags unknown codes, and un-marks "липсващ"', async () => {
  const { db, ipcMain, auditLog } = setup();
  const sessionId = startSession(db);
  const b1 = db.prepare("INSERT INTO books (title, barcode, status) VALUES ('A', 'BC1', 'наличен')").run().lastInsertRowid;
  const b2 = db.prepare("INSERT INTO books (title, inv_number, status) VALUES ('B', 42, 'липсващ')").run().lastInsertRowid;

  const result = await ipcMain.invoke('inventorySessions:importScans', { sessionId, codes: ['BC1', 'BC1', '42', 'UNKNOWN1'] });
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 2); // BC1 counted once (deduped by Set), 42 once
  assert.equal(result.data.duplicates, 0);
  assert.deepEqual(result.data.unknown, ['UNKNOWN1']);

  const b2row = db.prepare('SELECT status FROM books WHERE id=?').get(b2);
  assert.equal(b2row.status, 'наличен'); // un-marked from липсващ
  const scans = db.prepare('SELECT book_id FROM inventory_session_scans WHERE session_id=?').all(sessionId);
  assert.equal(scans.length, 2);
  assert.ok(auditLog.some(a => a.action === 'Инвентаризация' && /2 сканирания/.test(a.detail) && /1 непознати/.test(a.detail)));

  // Re-scanning the same barcode in a second call should count as a duplicate, not re-added.
  const again = await ipcMain.invoke('inventorySessions:importScans', { sessionId, codes: ['BC1'] });
  assert.equal(again.data.added, 0);
  assert.equal(again.data.duplicates, 1);
});
