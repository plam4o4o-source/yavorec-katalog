'use strict';
/* Одит v2.4.14 — поправките извън разпечатките.

   Всеки тест тук пада върху кода отпреди своята поправка; проверено с мутации.
   Разпечатките са в отделния файл fixes-audit-v2414-print.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const pii = require('../pii-crypto');

const tmpDirs = [];
function mkTmpDir(p) { const d = fs.mkdtempSync(p); tmpDirs.push(d); return d; }
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* без значение */ }
  }
});
function fakeIpcMain() {
  const h = new Map();
  return { handle: (c, fn) => h.set(c, fn), invoke: (c, ...a) => h.get(c)({}, ...a), has: (c) => h.has(c) };
}
function freshDb(prefix) {
  const dir = mkTmpDir(path.join(os.tmpdir(), prefix));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return { db, dir };
}
const runDep = (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } };

/* ==================================================================
   1. КРИТИЧНАТА: остарял ключ на втора работна станция
   ================================================================== */

function pdpSetup() {
  const { db, dir } = freshDb('inv-v2414-pdp-');
  db.exec("ALTER TABLE settings ADD COLUMN pdp_salt TEXT");
  db.exec("ALTER TABLE settings ADD COLUMN pdp_verifier TEXT");
  const ipcMain = fakeIpcMain();
  const returned = require('../handlers/pdp')(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  return { db, dir, ipcMain, returned };
}

test('остарял ключ: плейсхолдърът НИКОГА не се записва върху истинското ЕГН', () => {
  /* Сценарият: две работни места върху обща мрежова база. Станция Б отключва
     сутринта; станция А сменя паролата и базата се прекриптира с новия ключ;
     ключът на Б остава в паметта ѝ и вече е грешен. decryptField() хвърля,
     старият код слагаше низа „Защитени данни“ — низ БЕЗ префикса PDPv1:, тоест
     за preparePiiForWrite чист текст. pdp:status междувременно продължаваше да
     казва unlocked:true, затова полетата стояха отключени за редакция; първият
     запис на този читател криптираше думите „Защитени данни“ със СТАРИЯ ключ
     върху истинското ЕГН. Нито една от двете пароли не го връща. */
  const { db, ipcMain, returned } = pdpSetup();
  assert.equal(ipcMain.invoke('pdp:setup', 'парола-станция-1').ok, true);

  const id = db.prepare("INSERT INTO readers (name, egn) VALUES ('Иван', '7001011234')").run().lastInsertRowid;
  // Станция 1 прекриптира с нов ключ (както прави pdp:changePassword).
  assert.equal(ipcMain.invoke('pdp:changePassword', { oldPassword: 'парола-станция-1', newPassword: 'нова-парола-2222' }).ok, true);
  const stored = db.prepare('SELECT egn FROM readers WHERE id = ?').get(id).egn;
  assert.ok(pii.isEncryptedField(stored));

  // --- станция 2: ключ от СТАРАТА парола, все още в паметта ---
  const st2 = pdpSetup();
  st2.db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
    .run(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt,
         db.prepare('SELECT pdp_verifier FROM settings WHERE id=1').get().pdp_verifier);
  st2.db.prepare("INSERT INTO readers (name, egn) VALUES ('Иван', ?)").run(stored);

  // Отключваме с ВЕРНАТА парола, после подменяме данните с криптирани с друг ключ —
  // това пресъздава „ключът в паметта вече не отговаря на съдържанието“.
  assert.equal(st2.ipcMain.invoke('pdp:unlock', 'нова-парола-2222').ok, true);
  const otherKey = pii.deriveKey('трета-парола-3333', pii.generateSalt(pii.CURRENT_KDF_VERSION));
  const foreign = pii.encryptField('7001011234', otherKey);
  st2.db.prepare('UPDATE readers SET egn = ? WHERE name = ?').run(foreign, 'Иван');

  /* Изчертава се ПАРТИДА (както прави readers:list). Одит v2.4.16: ключалка №1 се
     задейства при партида, в която НИТО ЕДИН криптиран ред не се разчита — това е
     подписът на „ключът не отговаря на базата“. Единичен провален ред НЕ убива
     сесията; виж отделния тест по-долу. */
  const rows = st2.returned.maskReaderRows(st2.db.prepare("SELECT * FROM readers").all());
  assert.match(rows[0].egn, /ключът не съвпада/, 'неразчетената стойност трябва да е РАЗЛИЧНА от „заключено“');

  const st = st2.ipcMain.invoke('pdp:status');
  assert.equal(st.data.unlocked, false, 'при негодна сесия pdp:status трябва да казва „заключено“');
  assert.equal(st.data.stale, true);
  const row = rows[0];

  // Ключалка №2: дори полето да стигне дотук, плейсхолдърът не се записва.
  const out = { egn: row.egn, id_card_no: null };
  st2.returned.preparePiiForWrite(out, { egn: foreign, id_card_no: null });
  assert.equal(out.egn, foreign, 'предишната (криптирана) стойност трябва да остане непокътната');
  assert.ok(!/Защитени данни/.test(String(out.egn)), 'плейсхолдърът не бива да влиза в базата в никакъв вид');
});

test('ключалка №2 сама по себе си: плейсхолдър не се записва дори при ЗДРАВА, отключена сесия', () => {
  /* Отделен тест, защото в сценария по-горе ключалка №1 (PDP_STALE) поема удара
     първа и маскира дали втората изобщо работи. Тук сесията е напълно изправна:
     защитата е отключена, ключът е верен, PDP_STALE е false. Ако интерфейсът по
     каквато и да е причина върне обратно маскираната стойност (стар прозорец,
     повторно подаване на формата, бъдещ екран, който не знае за маскирането),
     без тази ключалка думите „Защитени данни“ се криптират ВЪРХУ истинското ЕГН
     — с ВАЛИДЕН ключ, тоест необратимо и без нито един признак за грешка. */
  const { db, ipcMain, returned } = pdpSetup();
  assert.equal(ipcMain.invoke('pdp:setup', 'редовна-парола-11').ok, true);
  const key = pii.deriveKey('редовна-парола-11',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
  const real = pii.encryptField('7001011234', key);

  assert.equal(ipcMain.invoke('pdp:status').data.stale, false, 'сесията е изправна — ключалка №1 не участва');
  for (const placeholder of ['Защитени данни', 'Защитени данни (ключът не съвпада)']) {
    const out = { egn: placeholder, id_card_no: null };
    returned.preparePiiForWrite(out, { egn: real, id_card_no: null });
    assert.equal(out.egn, real, 'при „' + placeholder + '“ трябва да остане предишната стойност');
    assert.equal(pii.decryptField(out.egn, key), '7001011234', 'истинското ЕГН трябва да се чете и след записа');
  }
});

test('успешната смяна на паролата връща сесията в изправност', () => {
  /* Одит СЛЕД поправките: pdp:unlock и pdp:lock изчистваха PDP_STALE, а
     changePassword — не, макар да инсталира току-що изведен, верен по построение
     ключ. Библиотекарят сменяше паролата успешно, не получаваше грешка — и оттам
     нататък всяко ЕГН показваше „ключът не съвпада“, а всяка редакция се
     отхвърляше мълчаливо. */
  const { db, ipcMain, returned } = pdpSetup();
  assert.equal(ipcMain.invoke('pdp:setup', 'първа-парола-11').ok, true);
  const salt = Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64');
  db.prepare("INSERT INTO readers (name, egn) VALUES ('Иван', ?)")
    .run(pii.encryptField('7001011234', pii.deriveKey('първа-парола-11', salt)));

  // Изкуствено разваляме сесията, както би станало при смяна от друга станция:
  // ЦЯЛАТА партида става нечетима, а това е признакът за негоден ключ.
  const foreign = pii.encryptField('7001011234', pii.deriveKey('чужда-9999', pii.generateSalt(2)));
  db.prepare("UPDATE readers SET egn = ? WHERE name='Иван'").run(foreign);
  returned.maskReaderRows(db.prepare("SELECT * FROM readers").all());
  assert.equal(ipcMain.invoke('pdp:status').data.stale, true, 'сесията трябва да е негодна преди смяната');

  // Връщаме читателя в изправно състояние и сменяме паролата.
  db.prepare("UPDATE readers SET egn = ? WHERE name='Иван'")
    .run(pii.encryptField('7001011234', pii.deriveKey('първа-парола-11', salt)));
  const res = ipcMain.invoke('pdp:changePassword', { oldPassword: 'първа-парола-11', newPassword: 'втора-парола-22' });
  assert.equal(res.ok, true, res.error);
  const st = ipcMain.invoke('pdp:status').data;
  assert.equal(st.stale, false, 'след успешна смяна сесията вече не е негодна');
  assert.equal(st.unlocked, true);
  const row = returned.maskReaderRow(db.prepare("SELECT * FROM readers WHERE name='Иван'").get());
  assert.equal(row.egn, '7001011234', 'ЕГН трябва да се чете с новата парола веднага след смяната');
});

test('канарчето не заключва библиотекаря заради ЕДИН повреден ред', () => {
  /* Одит СЛЕД поправките: първата версия гледаше един ред (LIMIT 1 без подредба)
     и отказваше отключване, ако точно той не се чете — например защото е бил
     презаписан от станция с остарял ключ ПРЕДИ тази версия. Останалите 499
     читатели са наред, но защитата не се отваря никога повече, а старата парола
     вече не минава през проверителя. Изход няма. */
  const { db, ipcMain } = pdpSetup();
  assert.equal(ipcMain.invoke('pdp:setup', 'редовна-парола-11').ok, true);
  const key = pii.deriveKey('редовна-парола-11',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
  const ins = db.prepare("INSERT INTO readers (name, egn) VALUES (?, ?)");
  // Ред №1 (най-малкият id) е повреден; следващите 30 са наред.
  ins.run('Повреден', pii.encryptField('0000000000', pii.deriveKey('друга-9999', pii.generateSalt(2))));
  for (let i = 0; i < 30; i++) ins.run('Читател ' + i, pii.encryptField('700101123' + (i % 10), key));

  ipcMain.invoke('pdp:lock');
  const res = ipcMain.invoke('pdp:unlock', 'редовна-парола-11');
  assert.equal(res.ok, true, 'един повреден ред не бива да заключва достъпа до останалите 30');
  assert.equal(ipcMain.invoke('pdp:status').data.unlocked, true);
});

test('pdp:unlock отказва, ако паролата отваря проверителя, но не разчита данните', () => {
  /* Проверителят доказва само, че паролата ражда ключа, с който е направен
     САМИЯТ проверител. Някой с достъп до споделената папка можеше да подмени
     pdp_salt/pdp_verifier с двойка от своя парола: програмата „отключваше“
     успешно, всяко разкриптиране се проваляше и екранът показваше същия
     плейсхолдър както при заключено — а всеки записан оттам нататък читател
     получаваше ЕГН, криптирано с чуждия ключ. */
  const { db, ipcMain } = pdpSetup();
  assert.equal(ipcMain.invoke('pdp:setup', 'първа-парола-11').ok, true);
  db.prepare("INSERT INTO readers (name, egn) VALUES ('Мария', ?)")
    .run(pii.encryptField('8002022345', pii.deriveKey('първа-парола-11',
      Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'))));

  // Подменяме сол+проверител с двойка от СЪВСЕМ ДРУГА парола.
  const evilSalt = pii.generateSalt(pii.CURRENT_KDF_VERSION);
  const evilKey = pii.deriveKey('чужда-парола-99', evilSalt);
  db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
    .run(evilSalt.toString('base64'), pii.makeVerifier(evilKey));

  ipcMain.invoke('pdp:lock'); // както при ново стартиране на програмата
  const res = ipcMain.invoke('pdp:unlock', 'чужда-парола-99');
  assert.equal(res.ok, false, 'отключването трябва да бъде отказано');
  assert.match(res.error, /криптирани с ДРУГ ключ/);
  assert.equal(ipcMain.invoke('pdp:status').data.unlocked, false);
});

test('pdp:unlock подсказва смяна при стара, по-слаба парола', () => {
  const { db, ipcMain } = pdpSetup();
  // Симулира база отпреди вдигането на параметрите: сол версия 1 (16 байта).
  const oldSalt = pii.generateSalt(1);
  assert.equal(oldSalt.length, 16);
  const key = pii.deriveKey('кратка', oldSalt);
  db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
    .run(oldSalt.toString('base64'), pii.makeVerifier(key));
  const res = ipcMain.invoke('pdp:unlock', 'кратка');
  assert.equal(res.ok, true, 'старата парола продължава да отключва — обратната съвместимост е задължителна');
  assert.match(res.data.advise, /по-слаб/, 'но библиотекарят трябва да бъде подсетен да я смени');
});

/* ==================================================================
   2. РЕЗЕРВНИТЕ КОПИЯ
   ================================================================== */

test('криптираното копие не оставя некриптиран файл в папката с копията', () => {
  /* encryptBackupFile() чете от ПЪТ, не от буфер, затова снимката първо каца във
     временен файл. Той се пишеше на destPath + '.plain-tmp' — тоест ВЪТРЕ в
     папката с резервните копия, която по документиран сценарий е мрежов дял, и
     съдържа ЕГН и № на лична карта на всички читатели в чист вид. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'backup.js'), 'utf8');
  const doBackup = src.slice(src.indexOf('function doBackupTo'), src.indexOf('function pruneOldAutoBackups'));
  assert.ok(!/destPath \+ '\.plain-tmp'/.test(doBackup),
    'некриптираната снимка не бива да се пише до крайната цел');
  assert.match(doBackup, /app\.getPath\('temp'\)/, 'временният файл отива в локалната временна папка');
});

test('новите копия носят версия на параметрите (INVBAK02), а старите (INVBAK01) още се четат', () => {
  /* Цената на извеждането на ключа беше зашита (N=16384) и заглавието нямаше
     поле за параметри — не можеше да се вдигне, без да се счупи всеки вече
     направен .invbak. А точно тези файлове „реално пътуват на USB/друг
     компютър“, тоест са най-вероятните за загубване или кражба. */
  const bc = require('../backup-crypto');
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-v2414-bak-'));
  const plain = path.join(dir, 'plain.db');
  const enc = path.join(dir, 'copy.invbak');
  fs.writeFileSync(plain, Buffer.from('SQLite format 3\0примерно съдържание'));

  bc.encryptBackupFile(plain, enc, 'парола-за-копие');
  assert.equal(fs.readFileSync(enc).subarray(0, 8).toString('utf8'), 'INVBAK02');
  assert.equal(fs.readFileSync(enc)[8], bc.CURRENT_BACKUP_KDF);
  assert.equal(bc.isEncryptedBackup(enc), true);
  assert.deepEqual(bc.decryptBackupBuffer(enc, 'парола-за-копие'), fs.readFileSync(plain));
  assert.throws(() => bc.decryptBackupBuffer(enc, 'грешна'), /Грешна парола/);

  // Ръчно сглобен файл в СТАРИЯ формат — трябва да се отваря както преди.
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = bc.deriveBackupKey('стара-парола', salt, 1);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(fs.readFileSync(plain)), c.final()]);
  const legacy = path.join(dir, 'legacy.invbak');
  fs.writeFileSync(legacy, Buffer.concat([bc.BACKUP_MAGIC, salt, iv, c.getAuthTag(), body]));
  assert.equal(bc.isEncryptedBackup(legacy), true, 'старият формат трябва да се разпознава');
  assert.deepEqual(bc.decryptBackupBuffer(legacy, 'стара-парола'), fs.readFileSync(plain),
    'копие отпреди обновяването трябва да се отваря със своята парола');

  /* Смисълът на втората версия е ЦЕНАТА, не обвивката: без това самата
     стойност може да бъде върната на старата, а форматът да си остане „нов“. */
  assert.equal(bc.BACKUP_KDF_PARAMS[1].N, 16384, 'версия 1 остава каквато е била — старите файлове зависят от нея');
  assert.ok(bc.BACKUP_KDF_PARAMS[2].N >= 131072,
    'версия 2 съществува заради по-скъпото извеждане на ключа: ' + bc.BACKUP_KDF_PARAMS[2].N);
  assert.equal(bc.CURRENT_BACKUP_KDF, 2);

  // И че некриптиран/повреден файл не се разпознава като копие.
  const plainDb = path.join(dir, 'plain-only.db');
  fs.writeFileSync(plainDb, Buffer.from('SQLite format 3\0'));
  assert.equal(bc.isEncryptedBackup(plainDb), false);
  fs.writeFileSync(path.join(dir, 'short.bin'), Buffer.from('INVBAK'));
  assert.equal(bc.isEncryptedBackup(path.join(dir, 'short.bin')), false);
});

/* ==================================================================
   3. ОФИЦИАЛНИТЕ ЧИСЛА
   ================================================================== */

test('нормата по чл. 40 брои РАЗЛИЧНИ документи, не сканирания', () => {
  /* Един и същ документ, сканиран в пролетна и в есенна проверка през една
     календарна година, се броеше два пъти — таблото рапортуваше 200% изпълнение
     при 100% неизпълнение. Другата страна на дробта (target) винаги е броила
     различни документи. */
  const { db } = freshDb('inv-v2414-dash-');
  const bookId = db.prepare("INSERT INTO books (title, status) VALUES ('Книга', 'наличен')").run().lastInsertRowid;
  const y = new Date().getFullYear();
  const s1 = db.prepare("INSERT INTO inventory_sessions (date) VALUES (?)").run(y + '-03-01').lastInsertRowid;
  const s2 = db.prepare("INSERT INTO inventory_sessions (date) VALUES (?)").run(y + '-10-01').lastInsertRowid;
  db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(s1, bookId);
  db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(s2, bookId);

  // През самия handler, не с преписана заявка: иначе тестът минава и когато
  // отговорът към екрана носи съвсем друго число.
  const ipcMain = fakeIpcMain();
  require('../handlers/dashboard')(ipcMain, {
    getDb: () => db, run: runDep, today: () => y + '-08-08', yearOf: () => String(y),
    pctRequired: () => 10, isWorkDay: () => true, LOAN_SELECT: 'SELECT l.* FROM loans l',
    countOverduePeriodicals: () => 0, naturalLoss: () => 0
  });
  const res = ipcMain.invoke('dashboard:full');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.inventoryScannedYear, 1,
    'един физически документ, сканиран в две проверки, е ЕДИН проверен документ');
  // И старата форма — за да се вижда, че разликата е реална, а не теоретична.
  const old = db.prepare(`SELECT COUNT(*) AS n FROM inventory_session_scans sc
    JOIN inventory_sessions s ON s.id = sc.session_id WHERE substr(s.date,1,4) = ?`).get(String(y)).n;
  assert.equal(old, 2, 'старото броене дава двойно');
});

test('служебният запис на GDPR не се брои за нов читател през годината', () => {
  /* Анонимизирането вкарва служебен ред „— анонимизирани заемания —“ с ДНЕШНА
     дата на регистрация. Годишните броячи го приемаха за нов читател: двете
     числа за читатели в един и същ годишен отчет се разминаваха с единица.
     Проверява се през истинския handler, а не с преписана заявка. */
  const { ANON_READER_NAME } = require('../security-utils');
  const { db } = freshDb('inv-v2414-anon-');
  const y = String(new Date().getFullYear());
  db.prepare("INSERT INTO readers (name, status, registered_at) VALUES ('Истински', 'активен', ?)").run(y + '-02-02');
  db.prepare("INSERT INTO readers (name, category, status, registered_at) VALUES (?, '—', 'прекратен', ?)")
    .run(ANON_READER_NAME, y + '-08-08');

  const ipcMain = fakeIpcMain();
  require('../handlers/stats')(ipcMain, {
    getDb: () => db, run: runDep, yearOf: () => y,
    value: (rows) => rows.reduce((s, r) => s + (Number(r.price) || 0), 0),
    dnevnikSumRow: (rows) => ({ hours: rows.reduce((s, r) => s + (r.a_hours || 0), 0) })
  });
  const rep = ipcMain.invoke('stats:report', y); // handler-ът приема годината пряко
  assert.equal(rep.ok, true, rep.error);
  assert.equal(rep.data.readersCount, 1,
    'анонимизирането не бива да добавя читател към годишния отчет');

  const ipc2 = fakeIpcMain();
  require('../handlers/dashboard')(ipc2, {
    getDb: () => db, run: runDep, today: () => y + '-08-08', yearOf: () => y,
    pctRequired: () => 10, isWorkDay: () => true, LOAN_SELECT: 'SELECT l.* FROM loans l',
    countOverduePeriodicals: () => 0, naturalLoss: () => 0
  });
  const dash = ipc2.invoke('dashboard:full');
  assert.equal(dash.ok, true, dash.error);
  assert.equal(dash.data.readersYear, 1, 'таблото трябва да брои същото число като отчета');
});

test('гола четирицифрена година при внос вече не става 1905 г.', () => {
  /* Прозорецът за сериен номер на Excel [367, 73050] съдържа и всяка
     четирицифрена година: клетка с „1998“ — най-обичайното нещо в стар опис —
     влизаше в инвентарната книга като 1905-06-21. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'data-import.js'), 'utf8');
  const iYear = src.indexOf('serial >= 1900');
  const iSerial = src.indexOf('serial >= 367');
  assert.ok(iYear > -1, 'годината трябва да се разпознава изрично');
  assert.ok(iSerial > -1, 'разпознаването на сериен номер на Excel остава');
  assert.ok(iYear < iSerial,
    'проверката за година трябва да стои ПРЕДИ проверката за сериен номер, иначе не се стига до нея');
  /* И самото поведение, изпълнено от ИСТИНСКИЯ код: двете функции се изрязват по
     реда си от файла (excelSerialToDateStr и parseDate) и се изпълняват в
     собствен обхват — така тестът се проваля и при промяна в самата логика, не
     само при разместване на редовете. */
  const lines = src.split('\n');
  const at = (needle) => lines.findIndex(l => l.includes(needle));
  const cut = (from, to) => lines.slice(at(from), at(to)).join('\n');
  const body = cut('function excelSerialToDateStr', "ipcMain.handle('import:run'");
  const parseDate = new Function(body + '\nreturn parseDate;')();
  assert.equal(parseDate('1998'), '1998-01-01', 'гола година се чете като 1 януари, а не като ден през 1905 г.');
  assert.equal(parseDate('1905'), '1905-01-01');
  assert.ok(String(parseDate('45000')).startsWith('20'), 'истинските серийни номера на Excel продължават да се четат');
  assert.equal(parseDate('15.03.2023'), '2023-03-15', 'обикновените дати не се пипат');
});

/* ==================================================================
   4. ЦЯЛОСТ И ЗАГУБА НА ДАННИ
   ================================================================== */

test('дневникът записва само изпратените колони — второ работно място не трие първото', () => {
  /* Дотук всяко записване пишеше целия ред (66 колони) от снимката, която
     браузърът е заредил при отваряне на екрана: вторият човек връщаше на нула
     колоните на първия, без конфликт и без предупреждение. */
  const { db } = freshDb('inv-v2414-dnv-');
  const ipcMain = fakeIpcMain();
  require('../handlers/dnevnik')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {},
    today: () => '2026-05-05', yearOf: () => 2026, csvCell: (x) => String(x ?? ''),
    dialog: {}, getMainWindow: () => null, fs, path
  });
  const D = '2026-05-05';
  // Станция А вписва посещенията в читалня.
  assert.equal(ipcMain.invoke('dnevnik:saveDay', { date: D, a_visit_reading: 12 }).ok, true);
  // Станция Б вписва своята колона — със СВОЯ снимка, в която първата е празна.
  assert.equal(ipcMain.invoke('dnevnik:saveDay', { date: D, a_age_u14: 5 }).ok, true);
  const row = db.prepare('SELECT * FROM dnevnik_days WHERE date = ?').get(D);
  assert.equal(row.a_visit_reading, 12, 'вписаното от първата станция трябва да остане');
  assert.equal(row.a_age_u14, 5, 'и вписаното от втората');
});

test('телефонното сканиране спазва отдела и не приема отчислени', () => {
  const { db } = freshDb('inv-v2414-mob-');
  const ipcMain = fakeIpcMain();
  require('../handlers/mobile')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, dialog: {}, getMainWindow: () => null,
    fs, path, app: { getPath: () => os.tmpdir() }, normalizeScanCode: (c) => String(c || '').trim() || null
  });
  const mk = (inv, dept, status) => db.prepare(
    "INSERT INTO books (inv_number, title, department, status) VALUES (?, 'К', ?, ?)").run(inv, dept, status).lastInsertRowid;
  mk(1, 'за възрастни', 'наличен');
  mk(2, 'за деца', 'наличен');       // чужд отдел
  mk(3, 'за възрастни', 'отчислен'); // извън фонда
  const sid = db.prepare("INSERT INTO inventory_sessions (date, department) VALUES ('2026-05-05', 'за възрастни')")
    .run().lastInsertRowid;

  const res = ipcMain.invoke('inventorySessions:importScans', { sessionId: sid, codes: ['1', '2', '3'] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.added, 1, 'само документът от обявения отдел влиза в протокола');
  assert.equal(res.data.skipped.length, 2);
  assert.deepEqual(res.data.skipped.map(x => x.inv_number).sort(), [2, 3]);
  assert.match(res.data.skipped.find(x => x.inv_number === 2).reason, /отдел/);
  assert.match(res.data.skipped.find(x => x.inv_number === 3).reason, /отчислен/);
});

function readersApi(db) {
  const ipcMain = fakeIpcMain();
  require('../handlers/readers')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, today: () => '2026-01-01',
    dialog: {}, getMainWindow: () => null, fs, path, csvCell: (x) => String(x ?? ''),
    normalizeScanCode: (c) => String(c || '').trim() || null,
    maskReaderRow: (r) => r, maskReaderRows: (r) => r, preparePiiForWrite: () => {},
    ftsSync: () => {}, cnSortKey: (x) => String(x || '')
  });
  return ipcMain;
}

test('читател с неплатено задължение не може да бъде изтрит', () => {
  /* account_lines.reader_id е ON DELETE CASCADE: изтриването отнася целия касов
     дневник, включително плащания от ПРИКЛЮЧЕНИ години, и справката „Приходи от
     такси“ за вече подадена година започва да показва друго число. Проверява се
     през самия handler — предишната версия на този тест беше грепване плюс
     демонстрация, че SQLite спазва CASCADE, тоест не пазеше нищо. */
  const { db } = freshDb('inv-v2414-rdr-');
  const ipcMain = readersApi(db);
  const rid = db.prepare("INSERT INTO readers (name) VALUES ('Петър')").run().lastInsertRowid;
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2024-01-01', 'начисление', 'обезщетение', 4)").run(rid);

  const res = ipcMain.invoke('readers:delete', rid);
  assert.equal(res.ok, false, 'дължимото трябва да спре изтриването');
  assert.match(res.error, /дължи 4\.00 лв/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM readers WHERE id = ?').get(rid).n, 1, 'читателят е още там');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_lines').get().n, 1, 'касовият дневник също');
});

test('изтриването на изчистен читател предупреждава изрично за касовия дневник', () => {
  const { db } = freshDb('inv-v2414-rdr2-');
  const ipcMain = readersApi(db);
  const rid = db.prepare("INSERT INTO readers (name) VALUES ('Мария')").run().lastInsertRowid;
  // Начисление и плащане — балансът е нула, но движенията са история.
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2024-01-01', 'начисление', 'обезщетение', 4)").run(rid);
  db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2024-02-01', 'плащане', 'плащане', -4)").run(rid);

  const first = ipcMain.invoke('readers:delete', rid);
  assert.equal(first.ok, false, 'първото натискане само предупреждава');
  assert.match(first.error, /движения по сметката/, 'предупреждението трябва да СПОМЕНЕ сметката, не само заеманията');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_lines').get().n, 2);

  // Второто натискане в рамките на две минути изтрива съзнателно.
  const second = ipcMain.invoke('readers:delete', rid);
  assert.equal(second.ok, true, second.error);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_lines').get().n, 0);
});

test('дребен остатък от плаваща запетая не прави читателя вечно неизтриваем', () => {
  /* SUM() върху REAL колони оставя остатък: три начисления по 0.10 и плащане
     0.30 дават 2.8e-17 > 0. Без допуск читателят се заключваше със съобщение
     „дължи 0.00 лв.“ — указание, което не може да бъде изпълнено. */
  const { db } = freshDb('inv-v2414-rdr3-');
  const ipcMain = readersApi(db);
  const rid = db.prepare("INSERT INTO readers (name) VALUES ('Дребен')").run().lastInsertRowid;
  const ins = db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2024-01-01', ?, ?, ?)");
  for (let i = 0; i < 3; i++) ins.run(rid, 'начисление', 'обезщетение', 0.1);
  ins.run(rid, 'плащане', 'плащане', -0.3);
  const bal = db.prepare('SELECT SUM(amount) AS b FROM account_lines WHERE reader_id = ?').get(rid).b;
  assert.ok(bal > 0 && bal < 1e-9, 'остатъкът наистина е положителен: ' + bal);
  const r1 = ipcMain.invoke('readers:delete', rid);
  assert.ok(!/дължи/.test(r1.error || ''), 'остатъкът не бива да се брои за задължение: ' + r1.error);
});

test('витрината съобщава кои документи е пропуснала и защо', () => {
  const { db } = freshDb('inv-v2414-shelf-');
  const ipcMain = fakeIpcMain();
  require('../handlers/shelves')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {}, scheduleCatalogWrite: () => {},
    normalizeScanCode: (c) => String(c || '').trim() || null
  });
  const shelfId = ipcMain.invoke('shelves:create', 'Витрина').data;
  const ok = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (1, 'Добра', 'наличен')").run().lastInsertRowid;
  // Запис от по-стар внос: статусът е NULL, тоест SQL филтърът го изпуска мълчаливо.
  const noStatus = db.prepare("INSERT INTO books (inv_number, title, status) VALUES (2, 'Без статус', NULL)").run().lastInsertRowid;
  const res = ipcMain.invoke('shelves:addBooks', { shelfId, ids: [ok, noStatus] });
  assert.equal(res.data.added, 1);
  assert.equal(res.data.skipped.length, 1);
  assert.equal(res.data.skipped[0].inv_number, 2);
  assert.match(res.data.skipped[0].reason, /без попълнен статус/);
});

/* ==================================================================
   5. СХЕМА, СИГУРНОСТ, ПАКЕТИРАНЕ
   ================================================================== */

test('миграция 8 изчиства дубликатите и слага уникалния индекс на сканиранията', () => {
  const { db } = freshDb('inv-v2414-mig-');
  const b = db.prepare("INSERT INTO books (title) VALUES ('К')").run().lastInsertRowid;
  const s = db.prepare("INSERT INTO inventory_sessions (date) VALUES ('2026-01-01')").run().lastInsertRowid;
  // Индексът вече е в schema.sql за нови бази — премахваме го, за да пресъздадем
  // състоянието на СТАРА база и да проверим самата миграция.
  db.exec('DROP INDEX IF EXISTS idx_iss_session_book');
  db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(s, b);
  db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(s, b);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_session_scans').get().n, 2);

  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const mig = main.slice(main.indexOf('{ version: 8'), main.indexOf('{ version: 9'));
  /* РЕДЪТ е същината: индексът върху база с дубликати гърми и поваля цялото
     стартиране. Затова се проверява, че изчистването стои преди създаването —
     дотук тестът сам създаваше индекса и това го правеше сляп за разместване. */
  const iDedupe = mig.indexOf('DELETE FROM inventory_session_scans');
  const iIndex = mig.indexOf('CREATE UNIQUE INDEX');
  assert.ok(iDedupe > -1 && iIndex > -1, 'миграцията трябва да съдържа и двете стъпки');
  assert.ok(iDedupe < iIndex, 'изчистването на дубликатите ТРЯБВА да стои преди уникалния индекс');
  // Изпълняват се точно двете изявления от миграцията, в техния ред.
  const dedupe = mig.match(/DELETE FROM inventory_session_scans[\s\S]*?GROUP BY session_id, book_id\s*\)/);
  db.prepare(dedupe[0]).run();
  db.exec(mig.match(/CREATE UNIQUE INDEX[^;]*;/)[0]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_session_scans').get().n, 1);
  assert.throws(() => db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(s, b),
    /UNIQUE/, 'оттук нататък базата сама спира дубликата — двете станции вече не могат да го промушат');

  /* Одит v2.4.17: дотук тук стоеше буквалното число 9 и всяка НОВА миграция
     чупеше този тест, вместо да провери каквото твърди. Проверява се самото
     твърдение: константата е равна на НАЙ-ВИСОКАТА миграция. Ако не е, базата
     остава на по-нисък user_version завинаги и следващата миграция се пропуска. */
  const maxMig = Math.max(...[...main.matchAll(/\{ version: (\d+),/g)].map(m => Number(m[1])));
  assert.ok(Number.isFinite(maxMig) && maxMig > 0, 'миграциите трябва да се разчитат от main.js');
  assert.match(main, new RegExp('const CURRENT_SCHEMA_VERSION = ' + maxMig + ';'),
    'константата трябва да е равна на последната миграция, иначе изравняването е недостижимо');
});

test('скриптът за антивирусни изключения отхвърля път, който би сменил смисъла на команда', () => {
  /* psQuote() екранираше само единичната кавичка на PowerShell, а стойността
     минава първо през cmd.exe: `"` затваря цитирането и `&` става разделител, а
     `%` се разширява ДОРИ вътре в кавичките. Скриптът се пуска като
     администратор, а catalog_folder идва направо от базата. */
  const capture = {};
  const ipcMain = { handle: (n, fn) => { capture[n] = fn; } };
  const folder = 'C:\\%TEMP%\\zul" & calc & "x';
  require('../handlers/security-exclusions')(ipcMain, {
    getDb: () => ({ prepare: () => ({ get: () => ({ catalog_folder: folder }) }) }),
    run: runDep, logAudit: () => {}, dialog: {}, getMainWindow: () => null, fs, path,
    app: { getPath: () => 'C:\\Users\\bib\\AppData\\Roaming\\inventar-desktop' },
    resolveDbDir: () => '\\\\SERVER\\biblioteka'
  });
  const info = capture['security:exclusionInfo']().data;
  assert.equal(info.rejected.length, 0,
    'при -EncodedCommand пътят вече не минава през синтаксиса на cmd и не е опасен');
  assert.ok(info.safe.includes(folder), 'стойността влиза като обикновен низ в PowerShell');
});

test('генерираният .bat е чист ASCII, не се къса на кирилица и не пропуска метазнаци в cmd', () => {
  /* Одит СЛЕД поправките — най-тежкото, което самата поправка внесе. Първата
     версия записваше файла с кодировка 'ascii', което маскира всеки знак до 7
     бита: „К“ (както в „Каталог“, „Книги“, „Копия“ — неизбежни в българска
     библиотека) става байт 0x1A, тоест МАРКЕРЪТ ЗА КРАЙ НА BATCH ФАЙЛ и скриптът
     се отрязва; „Ц“ става `&`, „Х“ става `%`. Тоест самото маскиране внасяше
     обратно точно метазнаците, които проверката отхвърля — под проверката.
     Сега целият полезен товар е PowerShell скрипт в base64 (-EncodedCommand):
     batch файлът е ASCII по построение, а пътищата стигат непокътнати. */
  const os2 = require('os');
  const dir = mkTmpDir(path.join(os2.tmpdir(), 'inv-v2414-bat-'));
  const outPath = path.join(dir, 'excl.bat');
  const cyr = 'C:\\Users\\Библиотекар\\Каталог и Копия';
  const cap2 = {};
  require('../handlers/security-exclusions')({ handle: (n, fn) => { cap2[n] = fn; } }, {
    getDb: () => ({ prepare: () => ({ get: () => ({ catalog_folder: cyr }) }) }),
    run: runDep, logAudit: () => {},
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: outPath }) },
    getMainWindow: () => null, fs, path,
    app: { getPath: () => 'C:\\Users\\Библиотекар\\AppData\\Roaming\\inventar-desktop' },
    resolveDbDir: () => '\\\\SERVER\\Читалище & библиотека'
  });
  return cap2['security:writeExclusionScript']().then(() => {
    const bytes = fs.readFileSync(outPath);
    assert.equal([...bytes].filter(b => b > 127).length, 0, 'файлът трябва да е чист ASCII');
    assert.ok(![...bytes].includes(0x1A), 'байт 0x1A би отрязал batch файла по средата');
    const txt = bytes.toString('latin1');
    assert.ok(!/chcp/.test(txt), 'при чист ASCII смяната на кодовата страница е излишна');
    const m = txt.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
    assert.ok(m, 'полезният товар трябва да е кодиран, а не вграден в cmd');
    const ps = Buffer.from(m[1], 'base64').toString('utf16le');
    assert.ok(ps.includes(cyr), 'кирилският път трябва да стигне непокътнат до PowerShell');
    assert.ok(ps.includes('Читалище & библиотека'), 'знакът & е законен в име на папка и не бива да отпада');
    assert.match(ps, /ВНИМАНИЕ: добавени/, 'резултатът се отчита честно, а не с безусловно „Готово“');
    // Нищо от съдържанието на базата не бива да се появи в самия cmd текст.
    assert.ok(!txt.includes('Add-MpPreference'), 'командите вече не са вградени в cmd');
  });
});

test('инсталаторът не може да поеме живата база на разработчика', () => {
  /* При неопакована програма базата по подразбиране е electron-app/db —
     всеки, който е пускал програмата от изходния код, има там library.db с
     истински читатели. .gitignore го крие от git, но electron-builder пакетира
     от РАБОТНОТО ДЪРВО: общото правило за папката db го поглъщаше в app.asar. */
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const files = pkg.build.files;
  assert.ok(!files.includes('db/**/*'), 'общото правило за папката db не бива да остава');
  assert.ok(files.includes('db/schema.sql') && files.includes('db/enum-triggers.js'),
    'двата файла, които наистина трябват при работа, се изброяват поименно');
  /* Всяко правило, което сочи папката db, трябва да е ИЗРИЧЕН файл. Гола дума
     „db“ електрон-билдер разгъва до db/**, тоест живата база на разработчика пак
     влиза в инсталатора — а трите проверки по-горе не забелязват нищо. */
  for (const f of files) {
    if (f === 'db' ) assert.fail('гола дума „db“ се разгъва до цялата папка');
    if (!/^db\//.test(f)) continue; // db-folder.js е файл в корена, не в папката db/
    assert.ok(/^db\/[A-Za-z0-9._-]+$/.test(f), 'правилото „' + f + '“ не е изричен файл в db/');
  }
});

test('прозорецът не пропуска външни адреси към браузъра', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const h = main.slice(main.indexOf('setWindowOpenHandler'), main.indexOf('will-navigate'));
  assert.ok(!/shell\.openExternal/.test(h),
    'в програмата няма нито една връзка с target="_blank" — този клон оставяше само изходен канал');
  assert.match(h, /action: 'deny'/);
});

test('внасянето приема само таблици, а не произволен файл от компютъра', () => {
  const { db, dir } = freshDb('inv-v2414-imp-');
  const ipcMain = fakeIpcMain();
  require('../handlers/data-import')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {},
    dialog: {}, getMainWindow: () => null, fs, path,
    BOOK_FIELDS: ['title'], today: () => '2026-01-01', cnSortKey: (x) => String(x || '')
  });
  // Файл, който НЕ е таблица — точно това, което не бива да излиза в екранния слой.
  const secret = path.join(dir, 'library.db');
  assert.ok(fs.existsSync(secret), 'базата от фикстурата е налице');
  const bad = ipcMain.invoke('import:load', secret);
  assert.equal(bad.ok, false, 'база данни не е таблица за внасяне');
  assert.match(bad.error, /само таблици/);
  assert.equal(ipcMain.invoke('import:load', path.join(dir, 'config.json')).ok, false,
    'несъществуващ/непозволен файл също се отказва');

  // Истинска таблица минава както преди.
  const csv = path.join(dir, 'opis.csv');
  fs.writeFileSync(csv, 'Инв. №;Заглавие\n1;Под игото\n', 'utf8');
  const good = ipcMain.invoke('import:load', csv);
  assert.equal(good.ok, true, good.error);
  assert.deepEqual(good.data.headers, ['Инв. №', 'Заглавие']);
});

test('телефонната страница екранира сканирания текст', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile-template.html'), 'utf8');
  assert.match(html, /escHtml\(c\)/, 'сканираният низ идва от четеца и не бива да влиза суров в innerHTML');
  /* Самата функция се изпълнява — грепът за името ѝ не пази нищо, ако тялото ѝ
     стане тъждествено. QR код със скрипт вътре е напълно възможен: rawValue на
     BarcodeDetector е произволен низ. */
  const m = html.match(/function escHtml\(v\)[\s\S]*?\n\}/);
  assert.ok(m, 'функцията трябва да съществува в страницата');
  const escHtml = new Function(m[0] + '; return escHtml;')();
  assert.equal(escHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;', 'ъгловите скоби трябва да се неутрализират');
  assert.equal(escHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  assert.equal(escHtml(null), '');
  // Терминологията от v2.4.12 стигна и до страницата, която библиотекарят чете с телефона в ръка.
  assert.ok(!/там се <b>внася<\/b>/.test(html));
});

/* ==================================================================
   6. ДЕФЕКТИ, НАМЕРЕНИ В САМИТЕ ПОПРАВКИ (повторен одит)
   ================================================================== */

test('schema.sql НЕ създава уникалния индекс — иначе всяко надграждане пада в резервната пътека', () => {
  /* Ред на изпълнение: schema.sql минава в началото на initDb(), ПРЕДИ
     миграциите. На всяка съществуваща база с дубликати — единствената, заради
     която миграция 8 изобщо съществува — създаването на индекса там се проваля и
     поваля целия файл. Проверява се с истинска база с дубликати. */
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(!/CREATE UNIQUE INDEX[^;]*idx_iss_session_book/.test(schema),
    'уникалният индекс принадлежи на миграция 8, не на schema.sql');

  const { db } = freshDb('inv-v2414-order-');
  const b = db.prepare("INSERT INTO books (title) VALUES ('К')").run().lastInsertRowid;
  const s = db.prepare("INSERT INTO inventory_sessions (date) VALUES ('2026-01-01')").run().lastInsertRowid;
  db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(s, b);
  db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?, ?)').run(s, b);
  assert.doesNotThrow(() => db.exec(schema),
    'schema.sql трябва да минава наведнъж дори върху база с дубликати');
});

test('разделителят на изявления не разкъсва тригера срещу двойно заемане', () => {
  /* Резервната пътека (изявление по изявление) съществува, за да не може една
     грешка да отнесе останалата част от схемата. Първата ѝ версия обаче режеше
     CREATE TRIGGER … BEGIN … ; … END; на две негодни половини — тоест точно
     пазачът, който спира заемането на повече екземпляри, отколкото има,
     изчезваше безшумно. */
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function splitSqlStatements'), main.indexOf('function resolveDbDir'));
  const split = new Function(fn + '; return splitSqlStatements;')();
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const parts = split(schema);
  const trig = parts.filter(x => /CREATE TRIGGER/i.test(x));
  assert.equal(trig.length, 1, 'тригерът трябва да е ЕДНО изявление, не две');
  assert.match(trig[0].trim(), /END;$/, 'тялото трябва да е цяло');

  const { db } = freshDb('inv-v2414-split-');
  db.exec('DROP TRIGGER IF EXISTS trg_loans_capacity');
  const failed = [];
  for (const st of parts) { try { db.exec(st); } catch (e) { failed.push(e.message); } }
  assert.deepEqual(failed, [], 'всяко изявление поотделно трябва да се изпълнява');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_loans_capacity'").get(),
    'тригерът трябва да е налице и след разделянето');
});

test('миграция 9 донася тригерите за enum и до вече надградените бази', () => {
  /* applyEnumTriggers() се извикваше само от миграция 5, а всяка издадена
     инсталация е на user_version >= 7 — тоест трите нови пазача стигаха САМО до
     чисто нови инсталации. Точно за account_lines.type съществува поправката:
     handlers/stats.js сравнява буквално с 'обезщетение'. */
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /\{ version: 9, run: \(\) => \{ applyEnumTriggers\(db\); \} \}/,
    'трябва да има миграция, която прилага тригерите отново');
  const maxMig9 = Math.max(...[...main.matchAll(/\{ version: (\d+),/g)].map(m => Number(m[1])));
  assert.match(main, new RegExp('const CURRENT_SCHEMA_VERSION = ' + maxMig9 + ';'),
    'константата следва последната миграция');

  const { applyEnumTriggers } = require('../db/enum-triggers');
  const { db } = freshDb('inv-v2414-enum9-');
  // Стара база: тригерите са от по-ранна версия, новите три ги няма.
  for (const t of ['account_lines_type', 'inventory_sessions_mode', 'authorised_values_category']) {
    db.exec('DROP TRIGGER IF EXISTS trg_' + t + '_ins');
    db.exec('DROP TRIGGER IF EXISTS trg_' + t + '_upd');
  }
  const rid = db.prepare("INSERT INTO readers (name) VALUES ('Ч')").run().lastInsertRowid;
  assert.doesNotThrow(() => db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-01', 'начисление', 'глоба', 1)").run(rid),
    'преди миграцията чуждият вид минава — това е дефектът');
  applyEnumTriggers(db); // това прави миграция 9
  assert.throws(() => db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (?, '2026-01-01', 'начисление', 'глоба', 1)").run(rid),
    /Непозната стойност за account_lines.type/);
});

test('дневникът за грешки приема и обикновен низ, не само масив', () => {
  /* logToFile(level, args) правеше args.map(...). Пет от седемте места подаваха
     НИЗ; TypeError-ът се поглъщаше от собствения catch на функцията и в дневника
     не влизаше нищо — включително при „Стартирането пропадна“, тоест точно
     когато библиотекарят е помолен да изпрати дневника. */
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function logToFile(level'), main.indexOf('function logToFileArr'));
  assert.match(fn, /Array\.isArray/, 'функцията трябва да разпознава и двата вида аргумент');
  const norm = new Function(fn.replace('return logToFileArr(level, args);', 'return args;') + '; return logToFile;')();
  assert.deepEqual(norm('error', 'Стартирането пропадна: причина'), ['Стартирането пропадна: причина']);
  assert.deepEqual(norm('info', ['а', 'б']), ['а', 'б']);
});

test('одитната следа за отчисляване брои документи, както ги брои самият акт', () => {
  /* Всеки екран и всяка разпечатка минаха на документи; постоянният запис —
     не. Списъкът, прегледът, разпечатката и КДБФ казваха 9, а следата, която
     инспекторът чете, за да възстанови какво се е случило — 3. */
  const { db } = freshDb('inv-v2414-audit-');
  const audit = [];
  const ipcMain = fakeIpcMain();
  require('../handlers/deaccession-acts')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: (a, d) => audit.push({ a, d }),
    BOOK_SELECT: 'SELECT b.*, COALESCE(i.quantity,0) AS quantity FROM books b LEFT JOIN inventory i ON i.book_id = b.id',
    yearOf: (d) => String(d || '2026').slice(0, 4),
    scheduleCatalogWrite: () => {}, flushCatalogWrite: () => {},
    normalizeScanCode: (c) => String(c || '').trim() || null
  });
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    const id = db.prepare("INSERT INTO books (inv_number, title, price, status) VALUES (?, 'К', 10, 'наличен')").run(i).lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 3)').run(id);
    ids.push(id);
  }
  const res = ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: '2026-03-01', reason_code: 1, reason_text: 'изхабени' }, bookIds: ids
  });
  assert.equal(res.ok, true, res.error);
  const line = audit.find(x => x.a === 'Отчисляване');
  assert.match(line.d, /9 документа/, 'следата трябва да казва 9, както казва актът');
  assert.match(line.d, /\(3 заглавия\)/);
  const listed = ipcMain.invoke('deaccessionActs:list').data[0];
  assert.equal(listed.item_count, 9, 'и списъкът брои същото');
});

test('един повреден ред НЕ убива сесията — останалите читатели остават четими', () => {
  /* Одит v2.4.16, дефект във ВЛАСТНАТА ми поправка от v2.4.14. Проверката при
     отключване беше направена да толерира частична повреда (за да не заключи
     библиотекаря извън останалите записи), но maskReaderRow слагаше PDP_STALE при
     ПЪРВИЯ неуспех. Двете се оказаха в противоречие и резултатът беше по-лош от
     изходния дефект: отключването успяваше, първото изчертаване на списъка
     срещаше единствения повреден ред, сесията умираше — и при следващото
     изчертаване ВСИЧКИ останали, напълно четими записи също излизаха с надпис
     „ключът не съвпада“. Заключване и отключване наново повтаряше цикъла. */
  const { db, ipcMain, returned } = pdpSetup();
  assert.equal(ipcMain.invoke('pdp:setup', 'редовна-парола-11').ok, true);
  const key = pii.deriveKey('редовна-парола-11',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
  const ins = db.prepare("INSERT INTO readers (name, egn) VALUES (?, ?)");
  ins.run('Повреден', pii.encryptField('0000000000', pii.deriveKey('чужда-9999', pii.generateSalt(2))));
  for (let i = 1; i <= 3; i++) ins.run('Читател ' + i, pii.encryptField('750101000' + i, key));

  const first = returned.maskReaderRows(db.prepare('SELECT * FROM readers ORDER BY id').all());
  assert.match(first[0].egn, /ключът не съвпада/, 'повреденият ред се отбелязва');
  assert.equal(first[1].egn, '7501010001', 'здравите редове се четат както преди');
  assert.equal(ipcMain.invoke('pdp:status').data.stale, false, 'един ред не бива да обявява сесията за негодна');

  // И най-важното: второто изчертаване дава същото, а не поголовен плейсхолдър.
  const second = returned.maskReaderRows(db.prepare('SELECT * FROM readers ORDER BY id').all());
  assert.equal(second[1].egn, '7501010001', 'сесията остава използваема и при следващото изчертаване');
  assert.equal(second[3].egn, '7501010003');
  assert.equal(ipcMain.invoke('pdp:status').data.unreadable, 2, 'броят засегнати полета се съобщава');
});
