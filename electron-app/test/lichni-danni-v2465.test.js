'use strict';
/* ============================================================================
   ЛИЧНИ ДАННИ, РЕЗЕРВНИ КОПИЯ, КАТАЛОГ И СЛЕДА — v2.4.65 (кръг 42)
   ============================================================================
   По един тест на находка. Всеки твърди онова, което библиотекарката ВИЖДА —
   текста на екрана, реда в одитната следа, съдържанието на файла, който носи на
   флашка — а не вътрешната форма на данните. Всеки пада, ако поправката бъде
   върната назад (проверено чрез връщане).

   А7  — анонимизирането маха името и от редовете „Заемане“, а броячът го брои
   Б6  — заличаване по искане на конкретен читател (`gdpr:forgetReader`)
   А8  — пълният износ скрива `audit_log.diff` винаги и `detail` при заключена защита
   А10 — смяната на паролата прекриптира и междинните, и ръчните копия
   А13 — „Изтриване на всички данни“ развързва онлайн каталога (и по избор — самоличността)
   Б21 — тихите действия вече оставят ред в следата (каталог, износ на следата,
         възстановяване, папка на базата)
   Б11 — трите бутона в „Проверка на данните“ минават през потвърждението по чл. 17, ал. 2
   В10 — повредена страница в копие се съобщава на български
   В11 — междинните копия в чист текст се назовават като междинни
   Г3  — свиването на архива е на ниво 6 (измерено: 167 ms срещу 544 ms)
============================================================================ */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const APP_DIR = path.join(__dirname, '..');
const pii = require(path.join(APP_DIR, 'pii-crypto'));
const { isEncryptedBackup, decryptBackupBuffer, encryptBackupFile } =
  require(path.join(APP_DIR, 'backup-crypto'));
const { ANON_READER_NAME } = require(path.join(APP_DIR, 'security-utils'));

const tmpDirs = [];
function mkTmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  try { pii.clearSession(); } catch (e) { /* сесията и без това си отива */ }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* няма значение */ } }
});

function fakeIpcMain() {
  const h = new Map();
  return { handle: (c, fn) => h.set(c, fn), invoke: (c, ...a) => h.get(c)({}, ...a), has: (c) => h.has(c) };
}
const runDep = (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } };
function unwrap(res) {
  if (res && typeof res === 'object' && 'ok' in res) {
    assert.equal(res.ok, true, 'каналът отказа: ' + res.error);
    return res.data;
  }
  return res;
}
function freshDb(prefix) {
  const dir = mkTmpDir(prefix);
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  /* `pdp_salt`/`pdp_verifier` не са в schema.sql — идват от миграция 2 в main.js
     (main.js:633). Без тях обработчиците приемат, че състоянието на защитата е
     неизвестно, тоест се държат все едно е заключена, и тестът щеше да минава по
     грешна причина. */
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  return { db, dir };
}

/* --------------------------------------------------------------------------
   Опора за handlers/gdpr.js — истинският модул върху прясна база.
-------------------------------------------------------------------------- */
function gdprSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  const audit = [];
  const ipcMain = fakeIpcMain();
  const logAudit = (action, detail) => {
    audit.push({ action, detail });
    db.prepare('INSERT INTO audit_log (user, action, detail, diff) VALUES (?, ?, ?, NULL)')
      .run('Иванка Петрова', action, detail || '');
  };
  require(path.join(APP_DIR, 'handlers', 'gdpr'))(ipcMain, { getDb: () => db, run: runDep, logAudit });
  return { db, dir, ipcMain, audit };
}
/* Ред в следата, какъвто го пишат handlers/loans.js:400, :634 и :934. */
function seedLoanAudit(db, ts, action, detail) {
  db.prepare('INSERT INTO audit_log (ts, user, action, detail, diff) VALUES (?, ?, ?, ?, NULL)')
    .run(ts, 'Иванка Петрова', action, detail);
}

/* ==========================================================================
   А7 — редовете „Заемане“ пазеха името; и броячът обявяваше едно вместо четири
========================================================================== */
test('А7: след анонимизиране редовете „Заемане“ губят читателя, но пазят инв. № и заглавието — и броячът го брои', () => {
  const { db, ipcMain } = gdprSetup('inv-v2465-a7-');
  db.prepare('UPDATE settings SET anonymize_years = 1 WHERE id = 1').run();
  const OLD = '2019-03-04 10:00:00';
  seedLoanAudit(db, OLD, 'Нов читател', 'карта 777 — Иван Петров Стоянов');
  seedLoanAudit(db, OLD, 'Заемане',
    'инв. № 101 — Под игото; читател Иван Петров Стоянов (карта 777); срок 03.04.2019');
  seedLoanAudit(db, OLD, 'Продължение на заемане',
    'инв. № 102 — Стария бряг; читател Иван Петров Стоянов (карта 777); заемане № 2 до 2019-05-04 (1/3)');
  seedLoanAudit(db, OLD, 'Изгубен документ',
    'инв. № 103 — Тютюн; читател Иван Петров Стоянов (карта 777); обезщетение 9.00 € (начислено в читателската сметка)');
  // Ред, който НЕ бива да се пипа — няма читател в него.
  seedLoanAudit(db, OLD, 'Заемане', 'инв. № 104 — Под манастирската лоза; срок 03.04.2019');

  /* ТОВА, КОЕТО БИБЛИОТЕКАРКАТА ЧЕТЕ ПРЕДИ ДА НАТИСНЕ: колко записа ще бъдат
     обезличени. Дотук пишеше „1“, а редовете с име бяха 4. */
  const cand = unwrap(ipcMain.invoke('gdpr:candidates'));
  assert.equal(cand.auditCount, 4,
    'броячът трябва да обявява всичките 4 реда с име (1 „Нов читател“ + 3 на гишето), а обявява ' + cand.auditCount);

  const res = unwrap(ipcMain.invoke('gdpr:anonymize'));
  assert.equal(res.auditCleared, 4, 'обезличените трябва да са точно колкото обявените');

  const rows = db.prepare("SELECT action, detail FROM audit_log WHERE action != 'Анонимизиране' ORDER BY id").all();
  const withName = rows.filter(r => r.detail.includes('Иван Петров Стоянов') || r.detail.includes('карта 777'));
  assert.deepEqual(withName, [], 'името и номерът на картата остават в: '
    + withName.map(r => r.action + ' → ' + r.detail).join(' | '));

  const byAction = (a) => rows.filter(r => r.action === a).map(r => r.detail);
  assert.deepEqual(byAction('Заемане'), [
    'инв. № 101 — Под игото; срок 03.04.2019',
    'инв. № 104 — Под манастирската лоза; срок 03.04.2019'
  ], 'инв. № и заглавието трябва да останат — иначе следата не документира кой документ е бил зает');
  assert.equal(byAction('Продължение на заемане')[0],
    'инв. № 102 — Стария бряг; заемане № 2 до 2019-05-04 (1/3)');
  assert.equal(byAction('Изгубен документ')[0],
    'инв. № 103 — Тютюн; обезщетение 9.00 € (начислено в читателската сметка)',
    'обезщетението е отчетност и остава');

  // Повторно пускане не бива да брои същите редове втори път.
  assert.equal(unwrap(ipcMain.invoke('gdpr:candidates')).auditCount, 0);
});

/* ==========================================================================
   Б6 — заличаване по искане на конкретен читател
========================================================================== */
function seedReaderForForget(db) {
  const rid = db.prepare(`INSERT INTO readers (name, card_no, category, status, registered_at, gdpr_consent,
      phone, address, egn) VALUES (?, '777', 'възрастен', 'активен', '2026-01-05', 1, ?, ?, ?)`)
    .run('Иван Петров Стоянов', '0888123456', 'с. Яворец, ул. Стара планина 3', '7501011234').lastInsertRowid;
  const bid = db.prepare(`INSERT INTO books (inv_number, register_date, title, author, department, status)
      VALUES (101, '2026-01-05', 'Под игото', 'Вазов, Иван', 'за възрастни', 'наличен')`).run().lastInsertRowid;
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in) VALUES (?, ?, '2026-02-01', '2026-03-01', '2026-02-20')")
    .run(rid, bid);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-05', 'начисление', 'годишна такса', 2)").run(rid);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-05', 'плащане', 'плащане', -2)").run(rid);
  db.prepare("INSERT INTO search_history (ts, user, kind, query) VALUES ('2026-02-01 10:00:00', 'Иванка', 'readers', 'Иван Петров Стоянов')").run();
  const TS = '2026-02-01 10:00:00';
  seedLoanAudit(db, TS, 'Нов читател', 'карта 777 — Иван Петров Стоянов');
  db.prepare('INSERT INTO audit_log (ts, user, action, detail, diff) VALUES (?, ?, ?, ?, ?)').run(
    TS, 'Иванка', 'Редакция на читател', 'карта 777 — Иван Петров Стоянов',
    JSON.stringify([{ field: 'address', before: 'с. Яворец, ул. Стара планина 3', after: 'с. Яворец, ул. Нова 7' }]));
  seedLoanAudit(db, TS, 'Заемане', 'инв. № 101 — Под игото; читател Иван Петров Стоянов (карта 777); срок 01.03.2026');
  seedLoanAudit(db, TS, 'Начисление', 'Иван Петров Стоянов — годишна такса 2.00 €');
  return { rid, bid };
}

test('Б6: „Изтриване по искане на читателя“ заличава данните му навсякъде — и казва, че копията не се пипат', () => {
  const { db, ipcMain } = gdprSetup('inv-v2465-b6-');
  const { rid } = seedReaderForForget(db);

  const res = unwrap(ipcMain.invoke('gdpr:forgetReader', { id: rid }));
  // Договорката с екрана: id на читател → { readerCleared, auditCleared, name }.
  assert.equal(res.name, 'Иван Петров Стоянов', 'името се връща САМО на екрана, за изречението до читателя');
  assert.ok(res.readerCleared >= 4, 'очакват се поне картонът, заемането и двете движения по сметката');
  assert.ok(res.auditCleared >= 4, 'четирите реда с име в следата трябва да са обезличени, а са ' + res.auditCleared);

  // Картонът го няма; заеманията и сметката са ПРЕХВЪРЛЕНИ, не изтрити.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM readers WHERE id = ?').get(rid).n, 0);
  const anon = db.prepare('SELECT id FROM readers WHERE name = ?').get(ANON_READER_NAME);
  assert.ok(anon, 'служебният запис за анонимизираните заемания трябва да е налице');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans WHERE reader_id = ?').get(anon.id).n, 1,
    'заемането е отчетност по чл. 30 и не бива да изчезне заедно с човека');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_lines WHERE reader_id = ?').get(anon.id).n, 2,
    'годишната такса и плащането ѝ остават в отчетността');

  // Името не е останало НИКЪДЕ — нито в следата, нито в историята на търсенията.
  const left = db.prepare("SELECT action, detail FROM audit_log WHERE detail LIKE '%Иван Петров Стоянов%'").all();
  assert.deepEqual(left, [], 'името остава в: ' + left.map(r => r.action).join(', '));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_history').get().n, 0);
  const diffs = db.prepare("SELECT diff FROM audit_log WHERE diff IS NOT NULL").all();
  assert.deepEqual(diffs, [], 'старият адрес в колоната „преди/след“ също отпада');
  // Инв. № и заглавието остават — следата продължава да документира документа.
  const zaemane = db.prepare("SELECT detail FROM audit_log WHERE action = 'Заемане'").get();
  assert.equal(zaemane.detail, 'инв. № 101 — Под игото; срок 01.03.2026');

  /* РЕДЪТ ЗА САМОТО ЗАЛИЧАВАНЕ: вписва какво е станало, НЕ връща името обратно
     и изрично казва, че резервните копия не са пипани. */
  const note = db.prepare("SELECT detail FROM audit_log WHERE action = 'Заличаване по искане на читател'").get();
  assert.ok(note, 'заличаването трябва да остави ред в следата');
  assert.ok(!note.detail.includes('Иван Петров Стоянов'),
    'редът за заличаването не бива да вписва името обратно: ' + note.detail);
  assert.ok(!note.detail.includes('777'), 'нито номера на картата: ' + note.detail);
  assert.match(note.detail, /чл\. 17/);
  assert.match(note.detail, /резервните копия НЕ са пипани/i);
  assert.match(res.backupsNote, /Резервните копия НЕ са пипани/);
});

test('Б6: незавърнат документ и неплатена сметка спират заличаването и казват изхода', () => {
  const { db, ipcMain } = gdprSetup('inv-v2465-b6b-');
  const { rid, bid } = seedReaderForForget(db);
  /* Втори документ: един екземпляр не може да е зает два пъти — тригерът в
     схемата го отказва, и то правилно. */
  const bid2 = db.prepare(`INSERT INTO books (inv_number, register_date, title, author, department, status)
    VALUES (102, '2026-01-05', 'Тютюн', 'Димов, Димитър', 'за възрастни', 'наличен')`).run().lastInsertRowid;
  // Без наличност тригерът trg_loans_capacity отказва заемането — и то с право.
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bid2);
  db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, '2026-03-01', '2026-04-01')").run(rid, bid2);
  const r1 = ipcMain.invoke('gdpr:forgetReader', { id: rid });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /незавърнат документ/);
  /* Каналът приема и голо id, не само { id } — бутонът в „Читатели“ се пише от
     другата страна и не бива да се чупи заради формата на довода. */
  assert.match(ipcMain.invoke('gdpr:forgetReader', rid).error, /незавърнат документ/);
  assert.match(r1.error, /„Заемания“/, 'съобщението трябва да назовава изхода, не само проблема');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM readers WHERE id = ?').get(rid).n, 1, 'нищо не бива да е пипнато');

  db.prepare("UPDATE loans SET date_in = '2026-03-10' WHERE date_in IS NULL").run();
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-03-10', 'начисление', 'обезщетение', 9)").run(rid);
  const r2 = ipcMain.invoke('gdpr:forgetReader', { id: rid });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /дължи 9\.00 €/);
  assert.match(r2.error, /„Сметка“/);

  // Служебният запис не е читател и не се заличава.
  const anonId = db.prepare(`INSERT INTO readers (name, category, status, registered_at, gdpr_consent)
    VALUES (?, '—', 'прекратен', '2026-01-01', 0)`).run(ANON_READER_NAME).lastInsertRowid;
  const r3 = ipcMain.invoke('gdpr:forgetReader', { id: anonId });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /служебният запис/);
});

/* ==========================================================================
   А8 + Г3 — пълният износ: одитната следа и нивото на свиване
========================================================================== */
function exportSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  const { csvCell } = require(path.join(APP_DIR, 'security-utils'));
  const ipcMain = fakeIpcMain();
  const ctx = { savePath: path.join(dir, 'iznos.zip') };
  const audit = [];
  require(path.join(APP_DIR, 'handlers', 'export-all'))(ipcMain, {
    getDb: () => db, logAudit: (a, d) => audit.push({ action: a, detail: d }),
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: ctx.savePath }) },
    getMainWindow: () => ({}), fs, csvCell, today: () => '2026-09-22'
  });
  return { db, dir, ipcMain, ctx, audit };
}
function unzip(file) {
  const buf = fs.readFileSync(file);
  const files = new Map();
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + compSize);
    files.set(name, {
      method, comp: Buffer.from(body),
      text: (method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body)).toString('utf8')
    });
    off = start + compSize;
  }
  return files;
}
function seedAuditWithPii(db) {
  db.prepare('INSERT INTO audit_log (ts, user, action, detail, diff) VALUES (?, ?, ?, ?, ?)').run(
    '2026-09-22 10:00:00', 'Иванка', 'Редакция на читател', 'карта 777 — Иван Петров Стоянов',
    JSON.stringify([
      { field: 'address', before: 'с. Яворец, ул. Стара планина 3', after: 'с. Яворец, ул. Нова 7' },
      { field: 'phone', before: '0888123456', after: '0899777888' }
    ]));
}

test('А8: при ЗАКЛЮЧЕНА защита „Пълен износ“ не изнася адреса и телефона и през одитната следа', async () => {
  const { db, ipcMain, ctx } = exportSetup('inv-v2465-a8-');
  seedAuditWithPii(db);
  const salt = pii.generateSalt(pii.CURRENT_KDF_VERSION);
  db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
    .run(salt.toString('base64'), pii.makeVerifier(pii.deriveKey('parolata-e-dulga', salt)));
  pii.clearSession(); // ЗАДАДЕНА, но ЗАКЛЮЧЕНА

  unwrap(await ipcMain.invoke('exportAll:run'));
  const files = unzip(ctx.savePath);
  const odit = files.get('odit-sleda.csv').text;
  for (const needle of ['Стара планина 3', 'Нова 7', '0888123456', '0899777888', 'Иван Петров Стоянов']) {
    assert.ok(!odit.includes(needle),
      'одитната следа изнася „' + needle + '“ в чист текст, въпреки че защитата е заключена');
  }
  assert.ok(odit.includes('"(скрито)"'), 'скритите колони трябва да личат като „(скрито)“, не като празни');

  /* ПРОЧЕТИ-МЕ.txt е това, по което библиотекарката решава дали файлът може да
     се праща по имейл — там и двете колони трябва да са изброени поименно. */
  const readme = files.get('PROCHETI-ME.txt').text;
  assert.ok(readme.includes('odit-sleda.csv → diff'), 'скритата колона „diff“ липсва в списъка на ПРОЧЕТИ-МЕ');
  assert.ok(readme.includes('odit-sleda.csv → detail'), 'скритата колона „detail“ липсва в списъка на ПРОЧЕТИ-МЕ');
  assert.match(readme, /odit-sleda\.csv[^\n]*скрита[^\n]*detail|скрита и колоната/);
});

test('А8: при ОТКЛЮЧЕНА защита следата излиза с имената, но „преди/след“ не излиза никога', async () => {
  const { db, ipcMain, ctx } = exportSetup('inv-v2465-a8b-');
  seedAuditWithPii(db);
  pii.clearSession(); // защитата изобщо не е задавана
  unwrap(await ipcMain.invoke('exportAll:run'));
  const files = unzip(ctx.savePath);
  const odit = files.get('odit-sleda.csv').text;
  assert.ok(odit.includes('Иван Петров Стоянов'), 'без защита следата излиза както досега');
  assert.ok(!odit.includes('Стара планина 3'),
    'колоната „преди/след“ носи стария адрес и ЕГН — тя не излиза при никакво състояние');
  const readme = files.get('PROCHETI-ME.txt').text;
  assert.ok(readme.includes('odit-sleda.csv → diff'));
  assert.match(readme, /odit-sleda\.csv съдържат лични данни|chitateli\.csv и odit-sleda\.csv/);
});

test('Г3: архивът се свива на ниво 6 — 167 ms вместо 544 ms срещу 4 % по-голям файл', async () => {
  const { db, ipcMain, ctx } = exportSetup('inv-v2465-g3-');
  /* Данни, които се свиват ОСЕЗАЕМО различно на 6 и на 9 — иначе тестът би
     минавал и при върната поправка. */
  const ins = db.prepare("INSERT INTO chronicle (year, date, title, body) VALUES ('2026', ?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < 400; i++) {
      ins.run('2026-01-01', 'Събитие ' + i,
        'Читалищна дейност ' + i + ' ' + 'абвгдежзийклмнопрстуфхцчшщъюя'.repeat(3) + ' ' + (i * 7919));
    }
  })();
  unwrap(await ipcMain.invoke('exportAll:run'));
  const files = unzip(ctx.savePath);
  const letopis = files.get('letopis.csv');
  assert.equal(letopis.method, 8, 'файлът трябва да е свит (DEFLATE)');
  const raw = Buffer.from(letopis.text, 'utf8');
  const at6 = zlib.deflateRawSync(raw, { level: 6 });
  const at9 = zlib.deflateRawSync(raw, { level: 9 });
  assert.notEqual(at6.length, at9.length, 'фикстурата трябва да различава двете нива, иначе тестът не доказва нищо');
  assert.equal(letopis.comp.length, at6.length,
    'свиването трябва да е на ниво 6 (измерено: 167 ms срещу 544 ms на ниво 9 при 4 % по-голям архив)');
});

/* ==========================================================================
   А10 / В10 / В11 / Б21(възстановяване) — handlers/backup.js
========================================================================== */
function backupSetup(prefix, opts) {
  const dir = mkTmpDir(prefix);
  const dbPath = path.join(dir, 'library.db');
  let db = new Database(dbPath);
  db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY, pdp_salt TEXT, pdp_verifier TEXT);
           INSERT INTO settings (id) VALUES (1);
           CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')),
             user TEXT, action TEXT NOT NULL, detail TEXT, diff TEXT);
           CREATE TABLE readers (id INTEGER PRIMARY KEY, egn TEXT);`);
  db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('Иванка Петрова', 'Нов документ', 'инв. № 1')").run();
  db.prepare('INSERT INTO readers (egn) VALUES (?)').run('0000000000');
  const audit = [];
  const notices = [];
  const exits = [];
  const ipcMain = fakeIpcMain();
  const handlers = require(path.join(APP_DIR, 'handlers', 'backup'))(ipcMain, {
    app: { getPath: (n) => (n === 'temp' ? os.tmpdir() : dir), relaunch() {}, exit: (c) => exits.push(c) },
    fs, path,
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: (opts && opts.savePath) || null }),
      showOpenDialog: async () => ({ canceled: true })
    },
    getDb: () => db, setDb: (v) => { db = v; },
    getMainWindow: () => ({ webContents: { send: (ch, m) => notices.push(m) }, isDestroyed: () => false }),
    run: runDep, logAudit: (a, d) => audit.push({ action: a, detail: d }),
    resolveDbDir: () => dir, resolveDbPath: () => dbPath,
    currentSchemaVersion: () => 16
  });
  return { dir, dbPath, getDb: () => db, ipcMain, handlers, audit, notices, exits };
}
function setPdp(db, password) {
  const salt = pii.generateSalt(pii.CURRENT_KDF_VERSION);
  const key = pii.deriveKey(password, salt);
  db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
    .run(salt.toString('base64'), pii.makeVerifier(key));
  return key;
}

test('А10: смяната на паролата прекриптира и МЕЖДИННОТО, и РЪЧНОТО копие, не само дневното', () => {
  const s = backupSetup('inv-v2465-a10-');
  const db = s.getDb();
  const OLD = 'starata-parola-1';
  const NEW = 'novata-parola-22';
  pii.setSession(OLD, setPdp(db, OLD), { reason: 'unlock' });
  s.handlers.autoBackupIfNeeded();                       // дневното auto-ГГГГ-ММ-ДД.invbak
  db.prepare('INSERT INTO readers (egn) VALUES (?)').run('1111111111');
  fs.utimesSync(s.dbPath, new Date(), new Date(Date.now() + 5000));
  assert.equal(s.handlers.backupBeforeQuit(), true,     // междинното auto-…-ЧЧММ.invbak
    'фикстурата трябва да направи междинно копие, иначе тестът не доказва нищо');
  // Ръчното копие се прави със същия записвач и същото име като backup:now.
  const manual = path.join(s.dir, 'backups', 'Inventar-backup-2026-09-22-11-00-00.invbak');
  s.handlers.doBackupTo(manual, OLD);

  const names = fs.readdirSync(path.join(s.dir, 'backups')).filter(f => f.endsWith('.invbak'));
  assert.ok(names.some(f => /^auto-\d{4}-\d{2}-\d{2}-\d{4}\.invbak$/.test(f)), 'няма междинно копие: ' + names);
  assert.ok(names.some(f => f.startsWith('Inventar-backup-')), 'няма ръчно копие: ' + names);

  // СМЯНА на паролата — точно както го прави pdp:changePassword.
  pii.setSession(NEW, setPdp(db, NEW), { reason: 'change', prevPassword: OLD });

  const stuck = [];
  for (const f of fs.readdirSync(path.join(s.dir, 'backups'))) {
    const full = path.join(s.dir, 'backups', f);
    if (!isEncryptedBackup(full)) continue;
    let withNew = false;
    try { decryptBackupBuffer(full, NEW); withNew = true; } catch (e) { withNew = false; }
    let withOld = false;
    try { decryptBackupBuffer(full, OLD); withOld = true; } catch (e) { withOld = false; }
    if (!withNew) stuck.push(f + (withOld ? ' (отваря се САМО със старата)' : ' (не се отваря изобщо)'));
  }
  pii.clearSession();
  assert.deepEqual(stuck, [], 'копия, които не се отварят с новата парола: ' + stuck.join(', '));
});

test('А10: днешните междинни копия В ЧИСТ ТЕКСТ се криптират при отключване на защитата', () => {
  const s = backupSetup('inv-v2465-a10b-');
  const db = s.getDb();
  pii.clearSession();
  // Защитата е ЗАДАДЕНА, но заключена → копията излизат некриптирани.
  setPdp(db, 'parolata-e-dulga');
  s.handlers.autoBackupIfNeeded();
  db.prepare('INSERT INTO readers (egn) VALUES (?)').run('2222222222');
  fs.utimesSync(s.dbPath, new Date(), new Date(Date.now() + 5000));
  assert.equal(s.handlers.backupBeforeQuit(), true);
  const plainIntraday = fs.readdirSync(path.join(s.dir, 'backups'))
    .filter(f => /^auto-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(f));
  assert.equal(plainIntraday.length, 1, 'фикстурата трябва да е оставила междинно копие в чист текст');

  pii.setSession('parolata-e-dulga', pii.deriveKey('parolata-e-dulga',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id = 1').get().pdp_salt, 'base64')),
  { reason: 'unlock' });

  const after = fs.readdirSync(path.join(s.dir, 'backups'));
  pii.clearSession();
  assert.deepEqual(after.filter(f => /^auto-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(f)), [],
    'междинното копие в чист текст е пълен регистър с ЕГН и не бива да остава: ' + after.join(', '));
  assert.ok(after.some(f => /^auto-\d{4}-\d{2}-\d{2}-\d{4}\.invbak$/.test(f)),
    'на негово място трябва да има криптирано: ' + after.join(', '));
  const msg = s.notices.map(n => n.message).join(' | ');
  assert.match(msg, /междинн/i, 'екранът трябва да КАЗВА, че и междинните са криптирани: ' + msg);
});

test('В10: повредена страница в копие се съобщава на български, а не със суровия изход на SQLite', () => {
  const s = backupSetup('inv-v2465-v10-');
  const bdir = path.join(s.dir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  // Достатъчно голяма база, за да има какво да се презапише в средата ѝ.
  const big = new Database(path.join(s.dir, 'big.db'));
  big.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = big.prepare('INSERT INTO t (v) VALUES (?)');
  big.transaction(() => { for (let i = 0; i < 4000; i++) ins.run('ред ' + i + ' ' + 'х'.repeat(50)); })();
  big.exec('CREATE INDEX idx_t_v ON t(v)');
  big.pragma('wal_checkpoint(TRUNCATE)');
  big.close();
  const buf = fs.readFileSync(path.join(s.dir, 'big.db'));
  const rot = Buffer.from(buf);
  const mid = Math.floor(rot.length / 2);
  rot.fill(0x41, mid, mid + 600);
  const file = path.join(bdir, 'auto-2026-09-18.db');
  fs.writeFileSync(file, rot);

  /* Какво точно казва SQLite за ТОЗИ файл — прочетено тук, от същата проверка,
     за да не се гадае кой е „първият ред“ на различни версии на библиотеката. */
  const ro = new Database(file, { readonly: true, fileMustExist: true });
  const raw = String(ro.pragma('integrity_check', { simple: true })).trim();
  ro.close();
  const rawLines = raw.split('\n').map(x => x.trim()).filter(x => x && !/^\*\*\*/.test(x));
  assert.ok(rawLines.length > 1,
    'подготовка: суровият изход трябва да е многореден, иначе тестът не проверява нищо (' + rawLines.length + ' реда)');

  const res = s.ipcMain.invoke('backup:restoreFromList', { path: file });
  assert.equal(res.ok, false);
  const msg = res.error;
  assert.match(msg, /повредена страница/, 'съобщението трябва да казва на български какво е станало: ' + msg);
  assert.match(msg, /по-старо копие/, 'и какво да направи библиотекарката: ' + msg);
  assert.ok(!/Rowid \d+ out of order/.test(msg.split('техническа подробност')[0]),
    'суровият английски изход не бива да е вграден в българското изречение: ' + msg);
  assert.ok((msg.match(/Tree \d+ page/g) || []).length <= 1,
    'от суровия изход остава най-много първият ред, а не шест: ' + msg);
  /* ОТ СУРОВИЯ ИЗХОД ОСТАВА САМО ПЪРВИЯТ РЕД. Той назовава повредата; всички
     следващи са същото за съседните страници и клетки. Проверява се и от двете
     страни: първият ред присъства дословно, вторият (и последният) — не. */
  const detail = /техническа подробност за поддръжката: „([\s\S]*)“/.exec(msg);
  assert.ok(detail, 'техническата подробност стои в скоби, с етикет и в кавички: ' + msg);
  assert.equal(detail[1], rawLines[0],
    'в кавичките стои ТОЧНО първият ред на изхода, нищо повече: „' + detail[1] + '“');
  assert.ok(!detail[1].includes('\n'), 'и нито един нов ред: „' + detail[1] + '“');
  assert.ok(!msg.includes(rawLines[1]),
    'вторият ред на изхода („' + rawLines[1] + '“) няма работа в съобщението: ' + msg);
  assert.ok(!msg.includes(rawLines[rawLines.length - 1]),
    'нито последният („' + rawLines[rawLines.length - 1] + '“): ' + msg);
  /* И общата дължина: това е екранът, на който библиотекарката стои с повредена
     база — няколко изречения, а не преписан изход на integrity_check (тук
     суровият изход сам по себе си е над 2 000 знака). */
  assert.ok(msg.length < 700, 'съобщението е няколко изречения, а не цял абзац (' + msg.length + ' знака): ' + msg);
  assert.equal(s.exits.length, 0, 'базата НЕ е пипана');
});

test('В11: екранът нарича междинните копия междинни, а не „дневни копия отпреди включването на защитата“', () => {
  const s = backupSetup('inv-v2465-v11-');
  const db = s.getDb();
  const bdir = path.join(s.dir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'auto-2026-09-20.db'), 'x');         // вчерашно дневно
  fs.writeFileSync(path.join(bdir, 'auto-2026-09-20-1130.db'), 'x');    // вчерашни междинни
  fs.writeFileSync(path.join(bdir, 'auto-2026-09-20-1730.db'), 'x');
  setPdp(db, 'parolata-e-dulga');
  pii.setSession('parolata-e-dulga', pii.deriveKey('parolata-e-dulga',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id = 1').get().pdp_salt, 'base64')),
  { reason: 'unlock' });
  const st = unwrap(s.ipcMain.invoke('backup:autoStatus'));
  pii.clearSession();
  assert.equal(st.plainDailyCount, 3, 'общият брой некриптирани автоматични копия не се променя');
  assert.equal(st.plainIntradayCount, 2, 'двете междинни трябва да се броят и отделно');
  assert.match(st.warning, /междинн/i, 'предупреждението трябва да ги назове: ' + st.warning);
  assert.ok(!/дневни копия отпреди включването на защитата/.test(st.warning),
    'старият надпис описваше междинните като дневни: ' + st.warning);
});

test('Б21: успешното възстановяване оставя ред — и то в НОВАТА база, която тръгва след рестарта', () => {
  const s = backupSetup('inv-v2465-b21r-');
  const bdir = path.join(s.dir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  // Копие от „миналия вторник“: истинска база със собствена следа.
  const old = path.join(bdir, 'auto-2026-09-15.db');
  const src = new Database(old);
  src.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY, pdp_salt TEXT, pdp_verifier TEXT);
            INSERT INTO settings (id) VALUES (1);
            CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user TEXT,
              action TEXT NOT NULL, detail TEXT, diff TEXT);
            INSERT INTO audit_log (ts, user, action, detail) VALUES
              ('2026-09-15 09:00:00', 'Иванка Петрова', 'Нов документ', 'инв. № 1 — Под игото');`);
  src.close();

  const res = s.ipcMain.invoke('backup:restoreFromList', { path: old });
  assert.equal(res.ok, true, res.error);
  assert.equal(s.exits.length, 1, 'възстановяването приключва с рестарт');

  // Точно това, което библиотекарката ще види СЛЕД рестарта — в подменения файл.
  const after = new Database(s.dbPath, { readonly: true });
  const rows = after.prepare('SELECT user, action, detail FROM audit_log ORDER BY id').all();
  after.close();
  assert.equal(rows.length, 2, 'копието носеше 1 ред; след възстановяването трябва да има и ред за самото него');
  const last = rows[1];
  assert.equal(last.action, 'Възстановяване от резервно копие');
  assert.ok(last.detail.includes(old), 'редът трябва да назове ОТ КОЙ файл: ' + last.detail);
  assert.match(last.detail, /вече не е в базата/, 'и че вписаното след тази дата го няма');
  assert.match(last.detail, /before-restore-/, 'и къде е базата отпреди възстановяването');
  assert.equal(last.user, 'Иванка Петрова', 'колоната „кой“ не бива да остава празна');
});

/* ==========================================================================
   Б21 — каталог, износ на следата, папка на базата
========================================================================== */
function catalogSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  const ipcMain = fakeIpcMain();
  const stub = () => {};
  require(path.join(APP_DIR, 'handlers', 'catalog'))(ipcMain, {
    getDb: () => db, run: runDep,
    logAudit: (a, d) => db.prepare('INSERT INTO audit_log (user, action, detail) VALUES (?, ?, ?)')
      .run('Иванка Петрова', a, d || ''),
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    getMainWindow: () => ({}), fs, path, execFile: stub,
    csvCell: require(path.join(APP_DIR, 'security-utils')).csvCell,
    buildCatalogPayload: () => ({ items: [], library: '' }),
    catalogJsonText: () => '{}', flushCatalogWrite: () => ({ written: true }),
    scheduleCatalogWrite: stub, catalogRemoteCheck: async () => ({ mismatch: false, slug: null }),
    isGitRepo: () => false, ghRawUrl: () => '', suggestRepoName: () => '',
    today: () => '2026-09-22', bgDate: (d) => d
  });
  return { db, ipcMain };
}
const auditRows = (db) => db.prepare('SELECT action, detail FROM audit_log ORDER BY id').all();

test('Б21: смяната на хранилището в GitHub и спирането на онлайн каталога оставят ред', () => {
  const { db, ipcMain } = catalogSetup('inv-v2465-b21c-');
  db.prepare("UPDATE settings SET gh_user = 'staro-chitalishte', gh_repo = 'staro-katalog', "
    + "gh_branch = 'main', catalog_folder = '/home/biblioteka/katalog' WHERE id = 1").run();

  unwrap(ipcMain.invoke('catalog:updateGh', { gh_user: 'novo-chitalishte', gh_repo: 'nov-katalog', gh_branch: 'main' }));
  let rows = auditRows(db);
  assert.equal(rows.length, 1, 'смяната на адреса, от който сайтът чете каталога, трябва да остави ред');
  assert.match(rows[0].detail, /staro-chitalishte\/staro-katalog/, 'редът трябва да казва какво е било: ' + rows[0].detail);
  assert.match(rows[0].detail, /novo-chitalishte\/nov-katalog/, 'и какво става: ' + rows[0].detail);

  // Запис без промяна не трупа редове — иначе истинските се губят в шума.
  unwrap(ipcMain.invoke('catalog:updateGh', { gh_user: 'novo-chitalishte', gh_repo: 'nov-katalog', gh_branch: 'main' }));
  assert.equal(auditRows(db).length, 1, 'записът без промяна не бива да оставя ред');

  unwrap(ipcMain.invoke('catalog:disconnectFolder'));
  rows = auditRows(db);
  assert.equal(rows.length, 2, 'спирането на онлайн каталога трябва да остави ред');
  assert.match(rows[1].detail, /СПРЯН/);
  assert.match(rows[1].detail, /\/home\/biblioteka\/katalog/, 'коя папка е развързана: ' + rows[1].detail);
  assert.match(rows[1].detail, /НЕ е изтрит/, 'и че публикуваният файл остава онлайн: ' + rows[1].detail);
  assert.equal(db.prepare('SELECT catalog_folder FROM settings WHERE id = 1').get().catalog_folder, null);
});

test('Б21: износът на ЦЯЛАТА одитна следа се вписва в самата следа', () => {
  const { db } = freshDb('inv-v2465-b21a-');
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'audit'))(ipcMain, { getDb: () => db, run: runDep });
  db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('Иванка Петрова', 'Нов читател', 'карта 777 — Иван Петров')").run();
  db.prepare("INSERT INTO audit_log (user, action, detail) VALUES ('Иванка Петрова', 'Нов документ', 'инв. № 1')").run();

  const rows = unwrap(ipcMain.invoke('audit:export', ''));
  assert.equal(rows.length, 2, 'изнасят се редовете отпреди вписването — износът не документира сам себе си');
  const all = auditRows(db);
  assert.equal(all.length, 3);
  assert.equal(all[2].action, 'Извеждане на одитната следа');
  assert.match(all[2].detail, /2 записа/, 'колко реда са излезли: ' + all[2].detail);
  assert.match(all[2].detail, /цялата следа, без филтър/);
  assert.match(all[2].detail, /лични данни/, 'и какво носи файлът: ' + all[2].detail);
  assert.equal(db.prepare('SELECT user FROM audit_log ORDER BY id DESC LIMIT 1').get().user, 'Иванка Петрова');

  // Със търсене — редът го казва, защото „500 от 12 000“ е друг файл.
  unwrap(ipcMain.invoke('audit:export', 'Под игото'));
  assert.match(db.prepare('SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1').get().detail, /търсене „Под игото“/);
});

test('Б21: „ползвай съществуващата база от тази папка“ оставя ред и в двете бази', async () => {
  const dirA = mkTmpDir('inv-v2465-b21d-a-');
  const dirB = mkTmpDir('inv-v2465-b21d-b-');
  const schema = `CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user TEXT,
      action TEXT NOT NULL, detail TEXT, diff TEXT);`;
  const dbA = new Database(path.join(dirA, 'library.db'));
  dbA.exec(schema + "INSERT INTO audit_log (ts, user, action, detail) VALUES "
    + "('2026-09-01 09:00:00', 'Иванка Петрова', 'Нов документ', 'инв. № 1');");
  const dbB = new Database(path.join(dirB, 'library.db'));
  dbB.exec(schema);
  dbB.close();

  const cfg = { dbFolder: dirA };
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'db-location'))(ipcMain, {
    app: { isPackaged: false, relaunch() {}, exit() {} },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [dirB] }),
      // Отговор 1 = „Ползвай съществуващата база от тази папка“.
      showMessageBox: async () => ({ response: 1 })
    },
    fs, path, getDb: () => dbA, setDb: () => {}, getMainWindow: () => ({}),
    run: runDep,
    readConfig: () => cfg, writeConfig: () => true,
    updateConfig: (fn) => { fn(cfg); return true; },
    resolveDbDir: () => cfg.dbFolder, resolveDbPath: () => path.join(cfg.dbFolder, 'library.db')
  });

  const res = await ipcMain.invoke('dbLocation:choose');
  assert.equal(res.ok, true, res.error);

  /* `dbLocation:choose` затваря живата връзка преди рестарта (както в
     програмата), затова изоставената база се чете наново от файла. */
  try { dbA.close(); } catch (e) { /* вече е затворена от обработчика */ }
  const oldConn = new Database(path.join(dirA, 'library.db'), { readonly: true });
  const inOld = oldConn.prepare('SELECT action, detail FROM audit_log ORDER BY id').all();
  oldConn.close();
  assert.equal(inOld.length, 2, 'изоставяната база трябва да пази ред накъде е тръгнал компютърът');
  assert.equal(inOld[1].action, 'Папка на базата данни');
  assert.match(inOld[1].detail, /ПРЕВКЛЮЧЕНА/);
  assert.match(inOld[1].detail, new RegExp(dirB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const back = new Database(path.join(dirB, 'library.db'), { readonly: true });
  const inNew = back.prepare('SELECT action, detail, user FROM audit_log ORDER BY id').all();
  back.close();
  assert.equal(inNew.length, 1, 'базата, която застава на нейно място, трябва да отваря следата си с този ред');
  assert.equal(inNew[0].action, 'Папка на базата данни');
  assert.match(inNew[0].detail, /От тази дата тази база данни се ползва/);
  assert.match(inNew[0].detail, /не са променяни/, 'и че данните в нея не са пипани: ' + inNew[0].detail);
});

/* ==========================================================================
   А13 — „Изтриване на всички данни“ и онлайн каталогът
========================================================================== */
function resetSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  db.prepare(`UPDATE settings SET lib_name = 'НЧ „Старо читалище“', org = 'НЧ „Старо читалище“',
      place = 'с. Старо', catalog_folder = ?, gh_user = 'staro-chitalishte', gh_repo = 'staro-katalog',
      gh_branch = 'main', next_inv_number = 42 WHERE id = 1`).run('/home/biblioteka/staro-katalog');
  db.prepare("INSERT INTO employees (name, active) VALUES ('Иванка Петрова', 1)").run();
  db.prepare(`INSERT INTO books (inv_number, register_date, title, author, department, status)
    VALUES (1, '2026-01-05', 'Под игото', 'Вазов, Иван', 'за възрастни', 'наличен')`).run();
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'reset'))(ipcMain, {
    app: { getPath: () => os.tmpdir(), relaunch() {}, exit() {} },
    fs, path, getDb: () => db, run: runDep,
    logAudit: (a, d) => db.prepare('INSERT INTO audit_log (user, action, detail) VALUES (?, ?, ?)')
      .run('Иванка Петрова', a, d || ''),
    resolveDbDir: () => dir, resolveDbPath: () => path.join(dir, 'library.db'),
    checkDbFile: () => null, getCurrentUser: () => 'Иванка Петрова'
  });
  return { db, dir, ipcMain };
}

test('А13: след „Изтриване на всички данни“ новата библиотека НЕ публикува в хранилището на старата', () => {
  const { db, ipcMain } = resetSetup('inv-v2465-a13-');
  /* Списъкът ПРЕДИ потвърждението вече казва, че връзката се прекъсва. */
  const plan = unwrap(ipcMain.invoke('reset:plan'));
  assert.equal(plan.catalogReset.any, true);
  assert.equal(plan.catalogReset.folder, '/home/biblioteka/staro-katalog');
  assert.equal(plan.catalogReset.repo, 'staro-chitalishte/staro-katalog');
  assert.equal(plan.identityReset.libName, 'НЧ „Старо читалище“');

  const res = unwrap(ipcMain.invoke('reset:wipe', { word: plan.word }));
  assert.equal(res.catalogCleared, true);
  assert.equal(res.identityCleared, false, 'без отметка самоличността остава');

  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  assert.equal(s.catalog_folder, null, 'папката на СТАРАТА библиотека остава свързана');
  assert.equal(s.gh_user, null, 'профилът в GitHub на СТАРАТА библиотека остава свързан');
  assert.equal(s.gh_repo, null, 'хранилището на СТАРАТА библиотека остава свързано');
  assert.equal(s.gh_branch, 'main');
  // Самоличността остава — най-честият повод е СЪЩАТА библиотека, която трие пробни записи.
  assert.equal(s.lib_name, 'НЧ „Старо читалище“');
  assert.equal(s.place, 'с. Старо');
  assert.equal(s.next_inv_number, 1);

  const note = db.prepare("SELECT detail FROM audit_log WHERE action = 'Изтриване на всички данни'").get();
  assert.match(note.detail, /ВРЪЗКАТА С ОНЛАЙН КАТАЛОГА Е ПРЕКЪСНАТА/);
  assert.match(note.detail, /staro-chitalishte\/staro-katalog/, 'следата трябва да каже кое е развързано');
  assert.match(note.detail, /katalog\.json НЕ е пипан/, 'и че публикуваният файл остава онлайн');
  assert.match(note.detail, /Самоличността на библиотеката[^.]*ЗАПАЗЕНА/);
  assert.match(res.message, /Връзката с онлайн каталога е прекъсната/);
});

test('А13: отметката „това е нова библиотека“ изчиства и наименованието, организацията и мястото', () => {
  const { db, ipcMain } = resetSetup('inv-v2465-a13b-');
  const plan = unwrap(ipcMain.invoke('reset:plan'));
  const res = unwrap(ipcMain.invoke('reset:wipe', { word: plan.word, newLibrary: true }));
  assert.equal(res.identityCleared, true);
  const s = db.prepare('SELECT lib_name, org, place, catalog_folder FROM settings WHERE id = 1').get();
  assert.equal(s.lib_name, null);
  assert.equal(s.org, null);
  assert.equal(s.place, null);
  assert.equal(s.catalog_folder, null);
  const note = db.prepare("SELECT detail FROM audit_log WHERE action = 'Изтриване на всички данни'").get();
  assert.match(note.detail, /ОТМЕТКАТА „това е нова библиотека“ беше сложена/);
  assert.match(note.detail, /НЧ „Старо читалище“/, 'следата трябва да помни какво е било името');
  assert.match(res.message, /Наименованието, организацията и населеното място са изчистени/);
});

/* ==========================================================================
   Б11 + А13 на ЕКРАНА — това, което библиотекарката вижда в прозореца
========================================================================== */
test('Б11: трите бутона в „Проверка на данните“ минават през потвърждението по чл. 17, ал. 2', async () => {
  const { buildDom, settle } = require('./helpers/audit-fixtures.js');
  const dom = buildDom({
    'books.multiCopyRecords': () => [],
    'books.findDuplicateBarcodes': () => [{ barcode: '9788', books: [
      { id: 7, inv_number: 101, title: 'Под игото', author: 'Вазов, Иван', status: 'наличен' },
      { id: 8, inv_number: 102, title: 'Под игото', author: 'Вазов, Иван', status: 'наличен' }] }],
    'books.deaccessionedWithoutAct': () => [],
    'fund.checkLogged': () => ({ year: 2026, findings: [{ level: 'тежко', title: 'Дати извън годината',
      why: 'Датата на вписване е от друга година.', todo: 'Поправете датата.',
      list: [{ id: 9, inv_number: 103, title: 'Тютюн', register_date: '2019-01-01' }] }] }),
    'authorMark.audit': () => ({ mismatchedTotal: 1, missingTotal: 0,
      mismatched: [{ id: 10, inv_number: 104, title: 'Стария бряг', author: 'Радичков, Йордан',
        author_mark: 'П-15', basis: 'Радичков', expected: 'Р' }] })
  });
  const { window } = dom;
  /* Контейнерът обикновено идва от картата „Проверка на данните“ в
     renderSettings(); тук се подава наготово, защото проверяваното е СЪДЪРЖАНИЕТО
     на таблиците, не подредбата на екрана около тях. */
  const host = window.document.createElement('div');
  host.id = 'dataChecks';
  window.document.body.appendChild(host);
  window.runDataChecks();
  await settle();
  const html = window.document.querySelector('#dataChecks').innerHTML;
  assert.ok(html.includes('Поправи датата'), 'екранът трябва да е нарисуван: ' + html.slice(0, 200));
  assert.ok(!/onclick="bookForm\(/.test(html),
    'бутон, който отваря редакция на запис в инвентарната книга, не бива да заобикаля потвърждението');
  for (const id of [9, 7, 8, 10]) {
    assert.ok(html.includes('invBookEdit(' + id + ')'),
      'бутонът за документ № ' + id + ' трябва да мине през invBookEdit');
  }
  window.close();
});

test('А13 на екрана: прозорецът казва ПРЕДИ потвърждението, че връзката с каталога се прекъсва', async () => {
  const { buildDom, settle } = require('./helpers/audit-fixtures.js');
  const dom = buildDom({
    'reset.plan': () => ({
      word: 'ИЗТРИЙ', counts: {}, groups: [{ group: 'Фонд', rows: 5 }], totalRows: 5,
      keep: [{ table: 'settings', label: 'Настройки на библиотеката', why: 'описва инсталацията' }],
      library: { name: 'НЧ „Старо читалище“', employees: 1, authorMarks: 0 },
      backupFolder: '/home/biblioteka/backups', backupEncrypted: false, pdpConfigured: false,
      dbFolder: '/home/biblioteka', catalogFolder: '/home/biblioteka/staro-katalog',
      catalogRepo: 'staro-chitalishte/staro-katalog',
      catalogReset: { any: true, folder: '/home/biblioteka/staro-katalog', repo: 'staro-chitalishte/staro-katalog' },
      identityReset: { any: true, libName: 'НЧ „Старо читалище“', org: 'НЧ „Старо читалище“', place: 'с. Старо' }
    })
  });
  const { window } = dom;
  await window.resetAllForm();
  await settle();
  const text = window.document.body.textContent.replace(/\s+/g, ' ');
  assert.match(text, /Изчезва — връзката на тази програма с папката/,
    'списъкът „Изчезва“ трябва да съдържа връзката с каталога');
  assert.match(text, /staro-chitalishte\/staro-katalog/);
  assert.match(text, /Остава — самият публикуван файл/,
    'и да различава прекъснатата връзка от оставащия онлайн файл');
  assert.match(text, /Това е НОВА библиотека — изчисти и самоличността/,
    'отметката трябва да се предлага, преди думата за потвърждение');
  const box = window.document.querySelector('#rsNewLib');
  assert.ok(box, 'отметката трябва да съществува');
  assert.equal(box.checked, false, 'по подразбиране НЕ е сложена — иначе същата библиотека губи името си');
  window.close();
});
