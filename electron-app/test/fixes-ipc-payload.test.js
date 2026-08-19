/* v2.3.1 — леката проекция за списъците (BOOK_LIST_SELECT / invBook:list).

   `SELECT b.*` мъкнеше по IPC и анотацията, ключовите думи, забележката и адреса
   на корицата — полета, които нито един списък не показва. Измерено при 15 000
   документа: books:list 20,63 МБ и 38 колони на ред (за 300 изчертани реда),
   invBook:list 21,27 МБ и 41 колони. След орязването: 4,81 МБ / 17 колони и
   6,74 МБ / 17 колони, а времето падна съответно 479→146 ms и 431→158 ms.

   Опасността от такова орязване е една: екран, който ползва поле, изпуснато от
   проекцията, започва да показва „undefined" мълчаливо. Затова тестовете тук НЕ
   изброяват полета на ръка (такъв списък гние — вж. историята на BOOK_FIELDS), а
   пускат ИСТИНСКИТЕ изгледи върху ИСТИНСКИЯ отговор на канала и проверяват, че
   нищо не се е изпарило. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { JSDOM, VirtualConsole } = require('jsdom');
const registerBooksHandlers = require('../handlers/books');
const registerInvBookHandlers = require('../handlers/inv-book');

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');
const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* без значение */ } } });

const run = (fn) => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err.message }; }
};
function realHandlers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-payload-'));
  tmpDirs.push(dir);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const H = new Map();
  const ipcMain = { handle: (c, f) => H.set(c, f), invoke: (c, ...a) => H.get(c)({}, ...a), has: (c) => H.has(c) };
  const deps = {
    getDb: () => db, run, logAudit: () => {}, today: () => '2026-08-02',
    ftsQuery: (q) => q, cnSortKey: (x) => x, diffFields: () => [],
    scheduleCatalogWrite: () => {}, normalizeScanCode: (x) => x, checkRecordLimit: () => {}
  };
  registerBooksHandlers(ipcMain, deps);
  registerInvBookHandlers(ipcMain, deps);
  return { db, ipcMain };
}
function seedBook(db, i = 1) {
  const id = db.prepare(`INSERT INTO books
    (inv_number, barcode, register_date, title, subtitle, author, year, volume, isbn, pages,
     language, udk, call_number, author_mark, city, publisher, series, series_no, keywords,
     annotation, cover_url, department, status, status_date, price, description)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    i, 'B' + i, '2020-03-05', 'Под игото', 'роман', 'Вазов, Иван', '1894', 'т. 1', '954123',
    '512', 'български', '821.163.2', 'Ч-8/ВАЗ', 'ВАЗ', 'Пловдив', 'Хр. Г. Данов',
    'Библиотека Класика', 'кн. 3', 'възраждане, роман',
    'Дълга анотация '.repeat(50), 'https://example.org/cover.jpg',
    'за възрастни', 'наличен', '2020-03-05', 12.5, 'подарен от читател').lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 2)').run(id);
  return id;
}

/* --- Проекцията наистина е по-лека --- */

test('books:list не праща анотацията, ключовите думи, забележката и корицата', async () => {
  const { db, ipcMain } = realHandlers();
  seedBook(db, 1);
  const row = (await ipcMain.invoke('books:list', '', 'title')).data[0];
  for (const heavy of ['annotation', 'keywords', 'description', 'cover_url', 'subtitle', 'isbn']) {
    assert.ok(!(heavy in row), 'списъкът не показва „' + heavy + '" — не бива да пътува по IPC');
  }
});

test('books:get ПРОДЪЛЖАВА да връща целия запис — формата за редакция зависи от него', async () => {
  const { db, ipcMain } = realHandlers();
  const id = seedBook(db, 1);
  const full = (await ipcMain.invoke('books:get', id)).data;
  for (const f of ['annotation', 'keywords', 'description', 'cover_url', 'subtitle', 'isbn',
    'pages', 'language', 'city', 'publisher', 'permanent_location', 'price']) {
    assert.ok(f in full, 'bookForm(id) чете точно оттук — липсващо поле значи изчезнал текст при редакция: ' + f);
  }
});

test('invBook:list не праща полета, които инвентарната книга не показва', async () => {
  const { db, ipcMain } = realHandlers();
  seedBook(db, 1);
  const row = (await ipcMain.invoke('invBook:list')).data[0];
  for (const heavy of ['annotation', 'keywords', 'cover_url']) {
    assert.ok(!(heavy in row), 'Приложение № 4 не съдържа „' + heavy + '"');
  }
  // Колоните на самото приложение обаче трябва да са налице.
  for (const need of ['inv_number', 'register_date', 'author', 'title', 'volume', 'year',
    'price', 'call_number', 'category_name', 'acq_no', 'act_no', 'checks', 'description']) {
    assert.ok(need in row, 'колона от Приложение № 4 липсва в товара: ' + need);
  }
});

/* --- Истинските изгледи върху истинския отговор --- */

/* bootstrap.js се изпълнява още при зареждането и чете window.api.app — затова
   моделът от test/views-regressions.test.js: снизходителен Proxy ПРЕДИ зареждането,
   а истинските данни се подменят чак след това. */
function safeDefault() {
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return (h) => (h === 'string' ? '' : 0);
      if (prop === 'length') return 0;
      if (['toString', 'toLocaleString', 'valueOf', 'trim', 'replace'].includes(prop)) return () => '';
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
function apiMock() {
  function node(parts) {
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return node(parts.concat(prop));
      },
      apply() { return Promise.resolve({ ok: true, data: safeDefault() }); }
    });
  }
  return node([]);
}
function buildDom() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  window.api = apiMock();
  window.confirm = () => true;
  window.prompt = () => { throw new Error('prompt() is not supported.'); };
  window.alert = () => {};
  window.print = () => {};
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const load = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  load(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  for (const m of html.matchAll(/<script\s+src="views\/([^"]+)"/g)) {
    load(fs.readFileSync(path.join(VIEWS_DIR, m[1]), 'utf8'), 'views/' + m[1]);
  }
  if (errors.length) assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n'));
  return dom;
}
async function settled(dom) {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return dom;
}

test('списъкът „Книги" се рисува от реалния товар без нито едно „undefined"', async () => {
  const { db, ipcMain } = realHandlers();
  for (let i = 1; i <= 3; i++) seedBook(db, i);
  const rows = (await ipcMain.invoke('books:list', '', 'title')).data;

  const dom = await settled(buildDom());
  const { window } = dom;
  window.api = {
    books: { list: async () => ({ ok: true, data: rows }) },
    categories: { list: async () => ({ ok: true, data: [{ id: 1, name: 'книга' }] }) },
    searchHistory: { suggest: async () => ({ ok: true, data: [] }), add: async () => ({ ok: true }) },
    av: { options: async () => ({ ok: true, data: {} }) }
  };
  await window.renderBooks();
  const html = window.document.getElementById('view').innerHTML;
  assert.doesNotMatch(html, /undefined/,
    'поле, изпуснато от леката проекция, се показва като „undefined" — точно рискът от орязването');
  assert.match(html, /Под игото/);
  assert.match(html, /Вазов, Иван/);
});

test('баркод етикетът и етикетът със сигнатура се строят от реалния товар', async () => {
  const { db, ipcMain } = realHandlers();
  seedBook(db, 7);
  const rows = (await ipcMain.invoke('books:list', '', 'title')).data;

  const dom = await settled(buildDom());
  const { window } = dom;
  window.SETTINGS_CACHE = { org: 'НЧ Пример', place: 'с. Пример' };
  const lbl = window.lblCard(rows[0]);
  assert.doesNotMatch(lbl, /undefined/, 'lblCard ползва barcode и inv_number — и двете трябва да са в проекцията');
  assert.match(lbl, /7/);
  const sig = window.sigLblCard(rows[0]);
  assert.doesNotMatch(sig, /undefined/, 'sigLblCard ползва call_number, author_mark и udk');
  assert.match(sig, /ВАЗ/);
});

test('филтърът „действащ фонд" за етикетите работи с леката проекция', async () => {
  const { db, ipcMain } = realHandlers();
  seedBook(db, 1);
  const id2 = seedBook(db, 2);
  db.prepare("UPDATE books SET status = 'отчислен' WHERE id = ?").run(id2);
  const rows = (await ipcMain.invoke('books:list', '', 'title')).data;
  // activeBooks() в logo-org.js филтрира точно по това поле.
  assert.equal(rows.filter(b => b.status !== 'отчислен').length, 1);
});

test('„Инвентарна книга" се рисува от реалния товар без „undefined"', async () => {
  const { db, ipcMain } = realHandlers();
  for (let i = 1; i <= 3; i++) seedBook(db, i);
  const rows = (await ipcMain.invoke('invBook:list')).data;

  const dom = await settled(buildDom());
  const { window } = dom;
  window.api = {
    invBook: { list: async () => ({ ok: true, data: rows }) },
    settings: { get: async () => ({ ok: true, data: {} }) }
  };
  await window.renderInvBook();
  const html = window.document.getElementById('view').innerHTML;
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /Под игото/);
});
