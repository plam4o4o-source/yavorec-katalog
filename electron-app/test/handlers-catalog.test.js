// Тест на handlers/catalog.js — трийсет и втори домейн, извадено от main.js
// (Фаза 4, стъпка 32). Покрива catalog:status/remoteCheck/updateGh/
// chooseFolder/disconnectFolder/gitPublishNow/writeNow/exportMarc/exportDc/
// export/exportCsv, плюс startAutoPushTimer/stopAutoPushTimer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerCatalogHandlers = require('../handlers/catalog');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

// Заменя истинския git с предвидими отговори по подкоманда, за да не зависи
// тестът от инсталиран git/мрежа. Ключът е args.join(' '); overrides могат
// да презаписват отделни подкоманди (напр. за да симулират rejected push).
function makeExecFile(overrides = {}) {
  return (cmd, args, opts, cb) => {
    const key = args.join(' ');
    if (key in overrides) {
      const o = overrides[key];
      cb(o.error || null, o.stdout || '', o.stderr || '');
      return;
    }
    if (key === 'config --get remote.origin.url') return cb(null, 'https://github.com/testuser/testrepo.git\n', '');
    if (key === 'rev-parse --abbrev-ref HEAD') return cb(null, 'main\n', '');
    if (key.startsWith('add ')) return cb(null, '', '');
    if (key.startsWith('commit ')) return cb(null, 'main abc1234] ...', '');
    if (key.startsWith('push ')) return cb(null, '', '');
    cb(null, '', '');
  };
}

function setup({ execFileOverrides } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-catalog-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql); // schema.sql already does INSERT OR IGNORE INTO settings (id) VALUES (1)

  const auditLog = [];
  const savedDialogs = { openDialog: null, saveDialog: null };
  const flushCalls = [];
  let flushResult = { written: true };
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    dialog: {
      showOpenDialog: async () => savedDialogs.openDialog || { canceled: true, filePaths: [] },
      showSaveDialog: async () => savedDialogs.saveDialog || { canceled: false, filePath: path.join(dir, 'out.txt') }
    },
    getMainWindow: () => ({}),
    fs, path,
    execFile: makeExecFile(execFileOverrides),
    BOOK_SELECT: `
      SELECT b.*, 1 AS available FROM books b
    `,
    csvCell: (x) => '"' + String(x ?? '').replace(/"/g, '""') + '"',
    flushCatalogWrite: () => { flushCalls.push(1); return flushResult; },
    buildCatalogPayload: () => ({
      library: 'Читалище X', place: 'Село Y', generated: '2026-08-02',
      items: db.prepare('SELECT inv_number AS inv, title AS t FROM books').all()
    })
  };
  const returned = registerCatalogHandlers(ipcMain, deps);
  return {
    db, ipcMain, auditLog, dir, savedDialogs, returned,
    setFlushResult: (r) => { flushResult = r; }, flushCalls
  };
}

test('registerCatalogHandlers registers all 11 catalog: channels and returns the auto-push timer controls', () => {
  const { ipcMain, returned } = setup();
  ['catalog:status', 'catalog:remoteCheck', 'catalog:updateGh', 'catalog:chooseFolder', 'catalog:disconnectFolder',
   'catalog:gitPublishNow', 'catalog:writeNow', 'catalog:exportMarc', 'catalog:exportDc', 'catalog:export', 'catalog:exportCsv']
    .forEach(ch => assert.ok(ipcMain.has(ch), ch));
  assert.equal(typeof returned.startAutoPushTimer, 'function');
  assert.equal(typeof returned.stopAutoPushTimer, 'function');
});

test('catalog:status reports fund counts, git status and a suggested repo name', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (title, status, department) VALUES ('Кн1', 'наличен', 'заемна')").run();
  db.prepare("UPDATE settings SET lib_name = 'Народно читалище Пробуда', gh_user='u', gh_repo='r', gh_branch='main' WHERE id=1").run();
  const result = await ipcMain.invoke('catalog:status');
  assert.equal(result.ok, true);
  assert.equal(result.data.total, 1);
  // isGitRepo(folder) short-circuits on `folder && ...`, so an unset (null) folder
  // returns null itself rather than a coerced false — original code's behavior, preserved.
  assert.equal(result.data.isGitRepo, null);
  assert.equal(result.data.rawUrl, 'https://raw.githubusercontent.com/u/r/main/katalog.json');
  assert.match(result.data.suggestedRepo, /-katalog$/);
});

test('catalog:updateGh trims and defaults the branch to main', async () => {
  const { db, ipcMain } = setup();
  await ipcMain.invoke('catalog:updateGh', { gh_user: ' u ', gh_repo: ' r ', gh_branch: '  ' });
  const row = db.prepare('SELECT gh_user, gh_repo, gh_branch FROM settings WHERE id=1').get();
  assert.deepEqual(row, { gh_user: 'u', gh_repo: 'r', gh_branch: 'main' });
});

test('catalog:remoteCheck returns null data when no folder is configured', async () => {
  const { ipcMain } = setup();
  const result = await ipcMain.invoke('catalog:remoteCheck');
  assert.equal(result.ok, true);
  assert.equal(result.data, null);
});

test('catalog:remoteCheck flags a mismatch between the connected folder and configured GitHub repo', async () => {
  const { db, ipcMain, dir } = setup();
  fs.mkdirSync(path.join(dir, '.git'));
  db.prepare("UPDATE settings SET catalog_folder=?, gh_user='otheruser', gh_repo='otherrepo' WHERE id=1").run(dir);
  const result = await ipcMain.invoke('catalog:remoteCheck');
  assert.equal(result.data.mismatch, true);
  assert.equal(result.data.remote.user, 'testuser');
});

test('catalog:chooseFolder reports cancellation, then on success updates the folder and adopts gh_user/repo', async () => {
  const { db, ipcMain, savedDialogs, dir, auditLog, flushCalls } = setup();
  const cancelled = await ipcMain.invoke('catalog:chooseFolder');
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /Отказано/);

  fs.mkdirSync(path.join(dir, '.git'));
  savedDialogs.openDialog = { canceled: false, filePaths: [dir] };
  const result = await ipcMain.invoke('catalog:chooseFolder');
  assert.equal(result.ok, true);
  assert.equal(result.data, dir);
  assert.deepEqual(result.adopted, { user: 'testuser', repo: 'testrepo', url: 'https://github.com/testuser/testrepo.git' });
  const row = db.prepare('SELECT catalog_folder, gh_user, gh_repo FROM settings WHERE id=1').get();
  assert.equal(row.catalog_folder, dir);
  assert.equal(row.gh_user, 'testuser');
  assert.ok(flushCalls.length >= 1);
  assert.ok(auditLog.some(a => a.action === 'Онлайн каталог' && a.detail.includes(dir)));
});

test('catalog:disconnectFolder nulls the catalog_folder', async () => {
  const { db, ipcMain } = setup();
  db.prepare("UPDATE settings SET catalog_folder = '/tmp/x' WHERE id=1").run();
  const result = await ipcMain.invoke('catalog:disconnectFolder');
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT catalog_folder FROM settings WHERE id=1').get().catalog_folder, null);
});

test('catalog:gitPublishNow requires a configured folder and reports the write-block condition', async () => {
  const { db, ipcMain, setFlushResult, dir } = setup();
  const noFolder = await ipcMain.invoke('catalog:gitPublishNow');
  assert.equal(noFolder.ok, false);
  assert.match(noFolder.error, /Първо изберете папка/);

  fs.mkdirSync(path.join(dir, '.git'));
  db.prepare('UPDATE settings SET catalog_folder=? WHERE id=1').run(dir);
  setFlushResult({ written: false, blocked: true });
  const blocked = await ipcMain.invoke('catalog:gitPublishNow');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Ръчен експорт/);
});

test('catalog:gitPublishNow publishes successfully (commit + push) and logs the audit entry', async () => {
  const { db, ipcMain, dir, auditLog } = setup();
  fs.mkdirSync(path.join(dir, '.git'));
  db.prepare("UPDATE settings SET catalog_folder=?, gh_user='testuser', gh_repo='testrepo' WHERE id=1").run(dir);
  const result = await ipcMain.invoke('catalog:gitPublishNow');
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.ok(auditLog.some(a => a.action === 'Онлайн каталог' && /публикувано в GitHub/.test(a.detail)));
});

test('catalog:gitPublishNow surfaces a friendly error when the folder is not a git repo', async () => {
  const { db, ipcMain, dir } = setup();
  db.prepare('UPDATE settings SET catalog_folder=? WHERE id=1').run(dir); // no .git created
  const result = await ipcMain.invoke('catalog:gitPublishNow');
  assert.equal(result.ok, false);
  assert.match(result.error, /не е git хранилище/);
});

test('catalog:gitPublishNow retries via fetch+rebase after a rejected (non-fast-forward) push', async () => {
  const { db, ipcMain, dir } = setup({
    execFileOverrides: {
      'push -u origin main': { error: { code: 1 }, stdout: '', stderr: 'rejected non-fast-forward' },
      'fetch origin main': { stdout: '', stderr: '' },
      'rebase -X theirs origin/main': { stdout: '', stderr: '' },
      'push origin main': { stdout: '', stderr: '' }
    }
  });
  fs.mkdirSync(path.join(dir, '.git'));
  db.prepare("UPDATE settings SET catalog_folder=?, gh_user='testuser', gh_repo='testrepo' WHERE id=1").run(dir);
  const result = await ipcMain.invoke('catalog:gitPublishNow');
  assert.equal(result.ok, true);
});

test('catalog:writeNow requires a configured folder and surfaces the write-block condition', async () => {
  const { db, ipcMain, setFlushResult, dir } = setup();
  const noFolder = await ipcMain.invoke('catalog:writeNow');
  assert.equal(noFolder.ok, false);
  assert.match(noFolder.error, /Първо изберете папка/);

  db.prepare('UPDATE settings SET catalog_folder=? WHERE id=1').run(dir);
  setFlushResult({ written: false, blocked: true });
  const blocked = await ipcMain.invoke('catalog:writeNow');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Ръчен експорт/);

  setFlushResult({ written: true });
  const ok = await ipcMain.invoke('catalog:writeNow');
  assert.equal(ok.ok, true);
});

test('catalog:exportMarc writes a MARCXML file with one <record> per book', async () => {
  const { db, ipcMain, savedDialogs, dir, auditLog } = setup();
  db.prepare("INSERT INTO books (title, author, inv_number, language, isbn) VALUES ('Под игото', 'Вазов, Иван', 1, 'български', '123')").run();
  const outPath = path.join(dir, 'out.xml');
  savedDialogs.saveDialog = { canceled: false, filePath: outPath };
  const result = await ipcMain.invoke('catalog:exportMarc');
  assert.equal(result.ok, true);
  assert.equal(result.data.count, 1);
  const xml = fs.readFileSync(outPath, 'utf8');
  assert.match(xml, /<record>/);
  assert.match(xml, /Под игото/);
  assert.ok(auditLog.some(a => a.action === 'Експорт UNIMARC'));
});

test('catalog:exportDc writes a Dublin Core XML file', async () => {
  const { db, ipcMain, savedDialogs, dir } = setup();
  db.prepare("INSERT INTO books (title, author, inv_number) VALUES ('Тих Дон', 'Шолохов', 2)").run();
  const outPath = path.join(dir, 'out-dc.xml');
  savedDialogs.saveDialog = { canceled: false, filePath: outPath };
  const result = await ipcMain.invoke('catalog:exportDc');
  assert.equal(result.ok, true);
  const xml = fs.readFileSync(outPath, 'utf8');
  assert.match(xml, /dc:title/);
});

test('catalog:export writes the public katalog.json payload', async () => {
  const { db, ipcMain, savedDialogs, dir } = setup();
  db.prepare("INSERT INTO books (title, inv_number) VALUES ('А', 10)").run();
  const outPath = path.join(dir, 'katalog.json');
  savedDialogs.saveDialog = { canceled: false, filePath: outPath };
  const result = await ipcMain.invoke('catalog:export');
  assert.equal(result.ok, true);
  const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(payload.items.length, 1);
});

test('catalog:exportCsv writes a semicolon-separated CSV of the fund with a BOM', async () => {
  const { db, ipcMain, savedDialogs, dir } = setup();
  db.prepare("INSERT INTO books (title, inv_number, price) VALUES ('А', 5, 10)").run();
  const outPath = path.join(dir, 'fond.csv');
  savedDialogs.saveDialog = { canceled: false, filePath: outPath };
  const result = await ipcMain.invoke('catalog:exportCsv');
  assert.equal(result.ok, true);
  const content = fs.readFileSync(outPath, 'utf8');
  // Header row is joined raw (unescaped); only per-book data rows go through csvCell.
  assert.ok(content.startsWith('﻿Инв. №;Баркод;'));
});

test('export handlers report cancellation from the save dialog', async () => {
  const { ipcMain, savedDialogs } = setup();
  savedDialogs.saveDialog = { canceled: true, filePath: null };
  for (const ch of ['catalog:exportMarc', 'catalog:exportDc', 'catalog:export', 'catalog:exportCsv']) {
    const result = await ipcMain.invoke(ch);
    assert.equal(result.ok, false, ch);
    assert.match(result.error, /Отказано/, ch);
  }
});

/* ---------------------------------------------------------------------------
   Регресия v1.65.0 — книга без попълнен „Отдел“ изчезваше от публичния каталог.

   Условието беше `department != 'служебен'`, а в SQL сравнение с NULL дава NULL,
   не истина — редът просто отпада. Полето „Отдел“ не е задължително при въвеждане
   (в базата е TEXT без NOT NULL и без стойност по подразбиране), затова това се
   случваше тихо: книгата стои в инвентарната книга, но липсва в katalog.json, в
   брояча „публикувани“ и при добавяне към витрина.
   --------------------------------------------------------------------------- */
test('книга без попълнен отдел (NULL) се брои за публикувана, а служебната — не', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (title, status, department) VALUES ('С отдел', 'наличен', 'за възрастни')").run();
  db.prepare("INSERT INTO books (title, status) VALUES ('Без отдел', 'наличен')").run(); // department остава NULL
  db.prepare("INSERT INTO books (title, status, department) VALUES ('Празен низ', 'наличен', '')").run();
  db.prepare("INSERT INTO books (title, status, department) VALUES ('Служебна', 'наличен', 'служебен')").run();
  db.prepare("INSERT INTO books (title, status, department) VALUES ('Отчислена', 'отчислен', 'за възрастни')").run();

  const result = await ipcMain.invoke('catalog:status');
  assert.equal(result.ok, true);
  assert.equal(result.data.total, 3,
    'публикуват се „С отдел“, „Без отдел“ (NULL) и „Празен низ“ — но не служебната и не отчислената');
});
