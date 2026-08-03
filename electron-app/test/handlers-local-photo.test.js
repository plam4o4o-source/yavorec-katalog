// Тест на handlers/local-photo.js — краеведски модул "Снимки към персоналии
// и летопис", извадено от main.js (Фаза 4, стъпка 31). Покрива
// localPhoto:choose/clear.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerLocalPhotoHandlers = require('../handlers/local-photo');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup(openDialogResult) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-local-photo-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const personId = db.prepare("INSERT INTO persons (name) VALUES ('Тест')").run().lastInsertRowid;

  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    dialog: {
      showOpenDialog: async () => openDialogResult || { canceled: true, filePaths: [] }
    },
    getMainWindow: () => ({}),
    fs,
    path,
    LOGO_MIME: { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' },
    LOCAL_PHOTO_MAX_BYTES: 1024 * 1024
  };
  registerLocalPhotoHandlers(ipcMain, deps);
  return { db, ipcMain, personId, dir };
}

test('registerLocalPhotoHandlers registers localPhoto:choose/clear', () => {
  const { ipcMain } = setup();
  assert.ok(ipcMain.has('localPhoto:choose'));
  assert.ok(ipcMain.has('localPhoto:clear'));
});

test('localPhoto:choose rejects an unknown table', async () => {
  const { ipcMain, personId } = setup();
  const result = await ipcMain.invoke('localPhoto:choose', { table: 'books', id: personId });
  assert.equal(result.ok, false);
  assert.match(result.error, /Непозната таблица/);
});

test('localPhoto:choose reports cancellation from the open dialog', async () => {
  const { ipcMain, personId } = setup({ canceled: true, filePaths: [] });
  const result = await ipcMain.invoke('localPhoto:choose', { table: 'persons', id: personId });
  assert.equal(result.ok, false);
  assert.match(result.error, /Отказано/);
});

test('localPhoto:choose stores a data URI and updates the row for a valid PNG', async () => {
  const { db, ipcMain, personId, dir } = setup();
  const imgPath = path.join(dir, 'photo.png');
  fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // minimal PNG-ish bytes
  const withDialog = setup({ canceled: false, filePaths: [imgPath] });
  const result = await withDialog.ipcMain.invoke('localPhoto:choose', { table: 'persons', id: withDialog.personId });
  assert.equal(result.ok, true);
  assert.match(result.data, /^data:image\/png;base64,/);
  const row = withDialog.db.prepare('SELECT photo FROM persons WHERE id = ?').get(withDialog.personId);
  assert.equal(row.photo, result.data);
});

test('localPhoto:choose rejects a file over the size limit', async () => {
  const { dir } = setup();
  const bigPath = path.join(dir, 'big.png');
  fs.writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024)); // 2 MB, over the 1 MB test limit
  const withDialog = setup({ canceled: false, filePaths: [bigPath] });
  const result = await withDialog.ipcMain.invoke('localPhoto:choose', { table: 'persons', id: withDialog.personId });
  assert.equal(result.ok, false);
  assert.match(result.error, /максимумът/);
});

test('localPhoto:choose rejects a non-image extension (svg is excluded even though it maps to a mime)', async () => {
  const { dir } = setup();
  const svgPath = path.join(dir, 'photo.svg');
  fs.writeFileSync(svgPath, '<svg></svg>');
  const withDialog = setup({ canceled: false, filePaths: [svgPath] });
  const result = await withDialog.ipcMain.invoke('localPhoto:choose', { table: 'persons', id: withDialog.personId });
  assert.equal(result.ok, false);
  assert.match(result.error, /PNG, JPG, GIF или WEBP/);
});

test('localPhoto:clear nulls the photo column, and rejects an unknown table', async () => {
  const { db, ipcMain, personId } = setup();
  db.prepare('UPDATE persons SET photo = ? WHERE id = ?').run('data:image/png;base64,AAAA', personId);
  const cleared = await ipcMain.invoke('localPhoto:clear', { table: 'persons', id: personId });
  assert.equal(cleared.ok, true);
  const row = db.prepare('SELECT photo FROM persons WHERE id = ?').get(personId);
  assert.equal(row.photo, null);

  const bad = await ipcMain.invoke('localPhoto:clear', { table: 'books', id: personId });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Непозната таблица/);
});
