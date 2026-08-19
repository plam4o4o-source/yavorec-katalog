// Тест на handlers/links.js — краеведски модул "Връзки между краеведските
// записи и фонда", извадено от main.js (Фаза 4, стъпка 31). Покрива
// links:list/backlinks/add/delete/search.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerLinksHandlers = require('../handlers/links');


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
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-links-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    }
  };
  registerLinksHandlers(ipcMain, deps);
  return { db, ipcMain };
}

test('registerLinksHandlers registers all links: channels', () => {
  const { ipcMain } = setup();
  ['links:list', 'links:backlinks', 'links:add', 'links:delete', 'links:search']
    .forEach(ch => assert.ok(ipcMain.has(ch), ch));
});

test('links:add rejects an unknown from/to kind and self-referencing links', async () => {
  const { db, ipcMain } = setup();
  const personId = db.prepare("INSERT INTO persons (name) VALUES ('П')").run().lastInsertRowid;
  const badKind = await ipcMain.invoke('links:add', { fromKind: 'книга', fromId: 1, toKind: 'книга', toId: 2 });
  assert.equal(badKind.ok, false);
  assert.match(badKind.error, /Непозната връзка/);

  const selfRef = await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'персона', toId: personId });
  assert.equal(selfRef.ok, false);
  assert.match(selfRef.error, /себе си/);
});

test('links:add rejects a duplicate link', async () => {
  const { db, ipcMain } = setup();
  const personId = db.prepare("INSERT INTO persons (name) VALUES ('П')").run().lastInsertRowid;
  const bookId = db.prepare("INSERT INTO books (title) VALUES ('Кн')").run().lastInsertRowid;
  const first = await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId, note: 'x' });
  assert.equal(first.ok, true);
  const dup = await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /вече съществува/);
});

test('links:list resolves human-readable labels via linkLabel, links:backlinks the reverse direction', async () => {
  const { db, ipcMain } = setup();
  const personId = db.prepare("INSERT INTO persons (name) VALUES ('Иван Вазов')").run().lastInsertRowid;
  const bookId = db.prepare("INSERT INTO books (title, author, inv_number) VALUES ('Под игото', 'Вазов', 42)").run().lastInsertRowid;
  await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId });

  const list = await ipcMain.invoke('links:list', { fromKind: 'персона', fromId: personId });
  assert.equal(list.data.length, 1);
  assert.match(list.data[0].label, /инв\. № 42/);
  assert.match(list.data[0].label, /Под игото/);

  const back = await ipcMain.invoke('links:backlinks', { toKind: 'книга', toId: bookId });
  assert.equal(back.data.length, 1);
  assert.equal(back.data[0].label, 'Иван Вазов');
});

test('linkLabel falls back to "(изтрит запис)" for a dangling reference', async () => {
  const { db, ipcMain } = setup();
  const personId = db.prepare("INSERT INTO persons (name) VALUES ('П')").run().lastInsertRowid;
  db.prepare("INSERT INTO links (from_kind, from_id, to_kind, to_id) VALUES ('персона', ?, 'книга', 9999)").run(personId);
  const list = await ipcMain.invoke('links:list', { fromKind: 'персона', fromId: personId });
  assert.equal(list.data[0].label, '(изтрит запис)');
});

test('links:delete removes a link by id', async () => {
  const { db, ipcMain } = setup();
  const personId = db.prepare("INSERT INTO persons (name) VALUES ('П')").run().lastInsertRowid;
  const bookId = db.prepare("INSERT INTO books (title) VALUES ('Кн')").run().lastInsertRowid;
  const add = await ipcMain.invoke('links:add', { fromKind: 'персона', fromId: personId, toKind: 'книга', toId: bookId });
  assert.equal(add.ok, true);
  const row = db.prepare('SELECT id FROM links WHERE from_id = ?').get(personId);
  const del = await ipcMain.invoke('links:delete', row.id);
  assert.equal(del.ok, true);
  assert.equal(db.prepare('SELECT * FROM links WHERE id = ?').get(row.id), undefined);
});

test('links:search finds candidates for each supported kind and rejects an unknown kind', async () => {
  const { db, ipcMain } = setup();
  db.prepare("INSERT INTO books (title, author, inv_number) VALUES ('Тихият Дон', 'Шолохов', 7)").run();
  db.prepare("INSERT INTO persons (name) VALUES ('Петко Р. Славейков')").run();
  db.prepare("INSERT INTO periodicals (title) VALUES ('Читалищен вестник')").run();

  const books = await ipcMain.invoke('links:search', { kind: 'книга', q: 'Дон' });
  assert.equal(books.data.length, 1);
  assert.match(books.data[0].label, /инв\. № 7/);

  const persons = await ipcMain.invoke('links:search', { kind: 'персона', q: 'Славейков' });
  assert.equal(persons.data.length, 1);

  const periodicals = await ipcMain.invoke('links:search', { kind: 'периодика', q: 'вестник' });
  assert.equal(periodicals.data.length, 1);

  const bad = await ipcMain.invoke('links:search', { kind: 'непознато', q: 'x' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Непознат вид запис/);
});
