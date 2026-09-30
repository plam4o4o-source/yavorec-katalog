'use strict';
/* ============================================================================
   v2.4.71 — ПРЕГЛЕД НА КРЪГА: находките от прегледа на кода върху кръг 45.
   ============================================================================
   Всяка е потвърдена върху кода на кръга, преди да бъде поправена, и всеки
   тест тук пада, когато поправката се върне. През истинския main.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { startMainApp } = require('./helpers/main-app');
const { localDate } = require('../local-date');

const APP_DIR = path.join(__dirname, '..');
const T = localDate();
const daysAgo = (n) => { const d = new Date(T + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const tmp = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d; };

let app, db;
test.before(async () => {
  app = startMainApp();
  await app.ready();
  db = new Database(path.join(app.userData, 'library.db'));
});
test.after(() => {
  if (db) db.close();
  if (app) app.stop();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});
const ok = (r, what) => { assert.ok(r && r.ok, (what || '') + ': ' + (r && r.error)); return r.data; };
let card = 7000;
function addReader(name, extra) {
  return db.prepare("INSERT INTO readers (name, card_no, status, gdpr_consent, registered_at) VALUES (?, ?, 'активен', 1, ?)")
    .run(name, String(card++), (extra && extra.registered_at) || T).lastInsertRowid;
}
function addBook(inv) {
  const cat = db.prepare("SELECT id FROM categories WHERE name = 'книга'").get().id;
  const id = db.prepare("INSERT INTO books (inv_number, title, status, category_id, register_date, price) VALUES (?, 'Книга ' || ?, 'наличен', ?, ?, 1)")
    .run(inv, inv, cat, T).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
  return id;
}

test('ръчно копие върху стар файл, който не може да бъде заменен, е ПРОВАЛ — не „успех“ с данни отпреди седмица', async () => {
  const dir = mk('inv-p71-backup-');
  const dest = path.join(dir, 'library.db');
  const electron = require('electron');
  const origSave = electron.dialog.showSaveDialog;
  electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest });
  try {
    ok(await app.invoke('backup:now', {}), 'първото ръчно копие');
    const before = fs.statSync(dest).mtimeMs;
    const origRename = fs.renameSync;
    fs.renameSync = (a, b) => {
      if (b === dest) { const e = new Error('EPERM: файлът е отворен в друга програма'); e.code = 'EPERM'; throw e; }
      return origRename(a, b);
    };
    try {
      const r = await app.invoke('backup:now', {});
      assert.equal(r.ok, false, 'старият здрав файл не бива да минава за новото копие');
    } finally { fs.renameSync = origRename; }
    assert.equal(fs.statSync(dest).mtimeMs, before);
  } finally { electron.dialog.showSaveDialog = origSave; }
});

test('поправена дата на записване МЕСТИ реда в историята — не брои читателя в двете години', async () => {
  const r = ok(await app.invoke('readers:create', { name: 'Сгрешена Дата', card_no: '7900', registered_at: '2025-01-10',
    status: 'активен', gdpr_consent: 1, category: 'възрастен' }), 'нов читател');
  const id = typeof r === 'object' ? r.id : r;
  const cur = ok(await app.invoke('readers:get', id));
  ok(await app.invoke('readers:update', Object.assign({}, cur, { registered_at: '2026-01-10' })), 'поправка на датата');
  const rows = db.prepare("SELECT date, kind FROM reader_registrations WHERE reader_key = ? ORDER BY date").all('r' + id);
  assert.deepEqual(rows, [{ date: '2026-01-10', kind: 'записване' }]);
});

test('ОРЗД: картата, дадена после на ДРУГ читател, не заличава неговите редове', async () => {
  const a = addReader('Анна Иванова');
  db.prepare('UPDATE readers SET card_no = ? WHERE id = ?').run('C5', a);
  const ins = db.prepare('INSERT INTO audit_log (ts, user, action, detail, diff) VALUES (?, ?, ?, ?, ?)');
  ins.run(daysAgo(300) + ' 10:00:00', '', 'Нов читател', 'карта C2 — Анна Иванова', null);
  ins.run(daysAgo(200) + ' 10:00:00', '', 'Редакция на читател', 'карта C5 — Анна Иванова',
    JSON.stringify([{ field: 'card_no', before: 'C2', after: 'C5' }]));
  ins.run(daysAgo(250) + ' 10:00:00', '', 'Заемане', 'инв. № 1 — Книга; читател Анна Стара (карта C2); срок 01.01.2026', null);  // още на Анна, под старо име
  ins.run(daysAgo(100) + ' 10:00:00', '', 'Заемане', 'инв. № 2 — Книга; читател Борис Петров (карта C2); срок 01.01.2026', null); // вече на Борис
  db.prepare("UPDATE readers SET registered_at = ? WHERE id = ?").run(daysAgo(300), a);
  ok(await app.invoke('gdpr:forgetReader', { id: a }), 'заличаване');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE detail LIKE '%Борис Петров (карта C2)%'").get(),
    'редът на Борис, който държи картата след Анна, е обезличен');
  assert.ok(!db.prepare("SELECT 1 FROM audit_log WHERE detail LIKE '%Анна Стара%'").get(),
    'редът от времето, когато картата е на Анна, трябва да бъде обезличен');
});

test('годишен отчет: начислената при продължение забава не се брои втори път на реда „незавършени заемания“', async () => {
  const r = addReader('Продължено'), b = addBook(7101);
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due, fine) VALUES (?, ?, ?, ?, 0.2)").run(r, b, daysAgo(40), daysAgo(10));
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, 'начисление', 'забава', 0.2, 'Забава 2 дни по инв. № 7101')").run(r, T);
  const r2 = addReader('Заварена'), b2 = addBook(7102);
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due, fine) VALUES (?, ?, ?, ?, 2.7)").run(r2, b2, daysAgo(400), daysAgo(370));
  const rep = ok(await app.invoke('stats:report', T.slice(0, 4)));
  assert.equal(rep.finesOpen, 2.7, 'само заварената забава, която сметката не познава (0,20 € вече е в „Начислени“)');
});

test('аналитично описание: заварено разминаване година/дата не спира поправката на анотацията, ново — спира', async () => {
  const id = db.prepare("INSERT INTO analytics (title, source_kind, source_text, year, issue_date, is_local) VALUES ('Статия', 'друго', 'Труд', '2026', '2025-12-31', 0)").run().lastInsertRowid;
  const base = { id, title: 'Статия', source_kind: 'друго', source_text: 'Труд', year: '2026', issue_date: '2025-12-31', is_local: 0 };
  ok(await app.invoke('analytics:update', Object.assign({}, base, { annotation: 'поправена правописна грешка' })), 'поправка на анотацията');
  const moved = await app.invoke('analytics:update', Object.assign({}, base, { issue_date: '2025-11-30' }));
  assert.equal(moved.ok, false, 'промяна на датата с разминаване все пак се спира');
});

test('смяна на работните дни не мести падежа на отдавна просрочено заемане', async () => {
  const r = addReader('Отдавна просрочено'), b = addBook(7201);
  /* Падеж в събота преди 10+ седмици. */
  let due = daysAgo(70);
  while (new Date(due + 'T00:00:00Z').getUTCDay() !== 6) due = daysAgo(Math.round((Date.parse(T) - Date.parse(due)) / 864e5) + 1);
  const loan = db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)").run(r, b, daysAgo(120), due).lastInsertRowid;
  ok(await app.invoke('calendar:saveWorkDays', [1, 2, 3, 4, 5]), 'без събота');
  assert.equal(db.prepare('SELECT date_due FROM loans WHERE id = ?').get(loan).date_due, due,
    'срокът в следващото писмо по чл. 43 би се различил от вече изпратените');
  ok(await app.invoke('calendar:saveWorkDays', [0, 1, 2, 3, 4, 5, 6]), 'връщане на всички дни');
});

test('онлайн каталог: същият текст не се записва пак', async () => {
  const folder = mk('inv-p71-kat-');
  db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(folder);
  ok(await app.invoke('catalog:writeNow', {}), 'първи запис');
  const file = path.join(folder, 'katalog.json');
  const m1 = fs.statSync(file).mtimeMs;
  await new Promise(r => setTimeout(r, 30));
  ok(await app.invoke('catalog:writeNow', {}), 'втори запис без промяна');
  assert.equal(fs.statSync(file).mtimeMs, m1, 'файлът е записан наново, без нищо да се е променило');
  db.prepare('UPDATE settings SET catalog_folder = NULL WHERE id = 1').run();
});

test('дните забава — едно правило за гишето и за акта по т. 5', () => {
  const cal = require('../handlers/calendar');
  assert.equal(typeof cal.lateDays, 'function');
  for (const f of ['loans.js', 'deaccession-acts.js']) {
    const src = fs.readFileSync(path.join(APP_DIR, 'handlers', f), 'utf8');
    assert.match(src, /require\('\.\/calendar'\)\.lateDays\(/, f + ' ползва общото правило');
    assert.doesNotMatch(src, /getTime\(\) - new Date\(start\)\.getTime\(\)/, f + ' пази собствено копие на формулата');
  }
  assert.equal(cal.lateDays('2026-10-13', '2026-10-14', { nextWorkDay: () => '2026-10-14', closedDaysBetween: () => 0 }), 0,
    'падеж в затворен ден — забавата започва от първия работен ден (Ч4)');
  assert.equal(cal.lateDays('2026-10-10', '2026-10-15', null), 5);
});
