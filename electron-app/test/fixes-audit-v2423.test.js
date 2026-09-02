'use strict';
/* v2.4.23 — тринадесети кръг: поправките по 13-те останали находки от одита на
   v2.4.20 (единадесети кръг). Всеки тест е проверен с мутация.

   Двете тежки са в защитата на личните данни и имат една обща причина:
   решението „ключът на сесията вече не е ключът на базата“ се извеждаше
   СТАТИСТИЧЕСКИ („цялата партида не се чете“) и три поредни кръга го намираха
   грешен в различна посока. Сега решението е по ПРОВЕРИТЕЛЯ в базата — един
   еднозначен отговор, независим от партидата. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fx = require('./helpers/audit-fixtures');
const { APP_DIR } = fx;

test.after(fx.cleanupTmpDirs);

/* ==================================================================
   1. ЗАЩИТА НА ЛИЧНИТЕ ДАННИ — проверителят вместо партидата
   ================================================================== */

test('едно търсене, което връща само повреден ред, НЕ заключва защитата за всички', () => {
  /* Находка №1 (моя поправка от v2.4.16): readers:list се вика и с търсене и с
     LIMIT 20 от гишето, и партидата може да е един ред. Един повреден запис +
     търсене по името му → „цялата партида не се чете“ → PDP_STALE за целия процес
     и всички читатели ставаха „ключът не съвпада“. */
  const { db, ipcMain, ret, pii, key } = fx.pdpSetup('inv-v2422-narrow-');
  const foreign = pii.deriveKey('чужд-ключ-999', pii.generateSalt(2));
  const ins = db.prepare('INSERT INTO readers (name, egn) VALUES (?, ?)');
  ins.run('Повреден', pii.encryptField('7501010001', foreign));
  for (let i = 1; i <= 5; i++) ins.run('Здрав ' + i, pii.encryptField('750101000' + i, key));

  // Търсенето на гишето: партида от ЕДИН ред — повредения.
  const narrow = ret.maskReaderRows(db.prepare("SELECT * FROM readers WHERE name = 'Повреден'").all());
  assert.equal(narrow[0].pii_masked_reason, 'unreadable');
  assert.equal(ipcMain.invoke('pdp:status').data.unlocked, true, 'сесията остава изправна');
  assert.equal(ipcMain.invoke('pdp:status').data.stale, false);

  // И следващият пълен списък чете здравите — дотук всичките шест бяха „stale“.
  const all = ret.maskReaderRows(db.prepare('SELECT * FROM readers ORDER BY id').all());
  assert.equal(all.filter(r => r.pii_masked).length, 1, 'само повреденият ред е скрит');
  assert.equal(all[3].egn, '7501010003');
});

test('единичният път (картон, сканиране на карта) научава за сменената парола', () => {
  /* Находка №2: readers:get → maskReaderRow не смяташе статистика и никога не
     излъчваше 'stale' — картонът след смяна на паролата от друго работно място
     печаташе „въведете наново“ за здрави ЕГН-та. */
  const { db, ret, pii } = fx.pdpSetup('inv-v2422-single-');
  const ins = db.prepare('INSERT INTO readers (name, egn) VALUES (?, ?)');
  // Другата станция сменя паролата: нов проверител в базата, редовете — с новия ключ.
  const newSalt = pii.generateSalt(2);
  const newKey = pii.deriveKey('нова-парола-на-другата-станция', newSalt);
  db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
    .run(newSalt.toString('base64'), pii.makeVerifier(newKey));
  ins.run('Читател', pii.encryptField('7501010001', newKey));

  const one = ret.maskReaderRow(db.prepare('SELECT * FROM readers').get());
  assert.equal(one.pii_masked_reason, 'stale', 'без нито един списък преди това');
  assert.equal(one.egn, 'Защитени данни (ключът не съвпада)');
});

test('записът с остарял ключ се спира от проверителя, преди да е имало провалено четене', () => {
  /* Преглед на поправките (v2.4.23): PDP_STALE се вдигаше само от провалено ЧЕТЕНЕ.
     Станция Б с отворена форма записва читател СЛЕД като станция А е сменила
     паролата — без нито едно четене помежду. ЕГН-то се криптираше с мъртвия ключ
     и презаписваше току-що прекриптирания от А ред: нечетим на всяка станция. */
  const { db, ipcMain, ret, pii } = fx.pdpSetup('inv-v2422-write-');
  const newSalt = pii.generateSalt(2);
  const newKey = pii.deriveKey('нова-парола-на-другата-станция', newSalt);
  db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
    .run(newSalt.toString('base64'), pii.makeVerifier(newKey));
  const prevRow = pii.encryptField('7001011234', newKey); // редът, прекриптиран от А
  assert.equal(ipcMain.invoke('pdp:status').data.stale, false, 'нищо още не е чело — сесията изглежда изправна');

  const out = { egn: '7001011234', id_card_no: null };
  ret.preparePiiForWrite(out, { egn: prevRow, id_card_no: null });
  assert.equal(out.egn, prevRow, 'редът на А остава непокътнат');
  assert.equal(ipcMain.invoke('pdp:status').data.stale, true, 'и сесията вече знае, че ключът ѝ е мъртъв');
  // Нов читател без предишен ред: отказ с указание, не запис с мъртвия ключ.
  assert.throws(() => ret.preparePiiForWrite({ egn: '7501010001', id_card_no: null }, null), /сменена/);
});

test('нечетими настройки не се тълкуват като сменена парола', () => {
  /* Преглед на поправките (v2.4.23): SQLITE_BUSY върху settings при един повреден
     ред заключваше сесията с невярна одитна следа „паролата е сменена отвън“. */
  const { db, ipcMain, ret, pii } = fx.pdpSetup('inv-v2422-busy-');
  const foreign = pii.deriveKey('чужд-ключ-999', pii.generateSalt(2));
  db.prepare('INSERT INTO readers (name, egn) VALUES (?, ?)').run('Повреден', pii.encryptField('7501010001', foreign));
  const row = db.prepare('SELECT * FROM readers').get();
  // Настройките „не се четат“: временно махаме проверителя — keyStillMatchesDb → null.
  const saved = db.prepare('SELECT pdp_verifier FROM settings WHERE id = 1').get().pdp_verifier;
  db.prepare('UPDATE settings SET pdp_verifier = NULL WHERE id = 1').run();
  const masked = ret.maskReaderRow(Object.assign({}, row));
  db.prepare('UPDATE settings SET pdp_verifier = ? WHERE id = 1').run(saved);
  assert.equal(masked.pii_masked_reason, 'unreadable', 'без отговор от проверителя → нечетим ред, не сменена парола');
  assert.equal(ipcMain.invoke('pdp:status').data.stale, false, 'сесията не се заключва по неведение');
});

test('плейсхолдър с интервал отзад не се криптира като ЕГН', () => {
  /* Находка №13: пазачът сравняваше точния низ. */
  const { ret, pii, key } = fx.pdpSetup('inv-v2422-ph-');
  const real = pii.encryptField('7001011234', key);
  for (const v of ['Защитени данни (ключът не съвпада) ', '  Защитени данни', 'Защитени данни (ключът не съвпада) — стар']) {
    const out = { egn: v, id_card_no: null };
    ret.preparePiiForWrite(out, { egn: real, id_card_no: null });
    assert.equal(out.egn, real, 'при „' + v + '“ остава предишната стойност');
  }
});

/* ==================================================================
   2. ПАЗАЧЪТ ЗА ПО-НОВА БАЗА
   ================================================================== */
const WORKER = path.join(__dirname, 'helpers', 'newer-schema-worker.js');
function startAgainstDb(version, mode) {
  const r = spawnSync(process.execPath, [WORKER, String(version), mode || 'local'], { encoding: 'utf8', timeout: 30000 });
  const line = String(r.stdout || '').trim().split('\n').filter(Boolean).pop();
  assert.ok(line, 'работникът трябва да отпечата ред JSON: ' + (r.stderr || '').slice(-400));
  return JSON.parse(line);
}

test('грешка между двата пазача върху по-нова база стига до вярната диалогова кутия, не до „преименувайте library.db“', () => {
  /* Находка №3. Другата станция вдига версията И преименува колона; старият
     backfill гърми с „no such column“ — грешка без code DB_NEWER_SCHEMA, която
     дотук падаше в общия диалог с унищожителния съвет. */
  const r = startAgainstDb(99, 'race-break');
  assert.equal(r.exitCode, 1);
  assert.equal(r.dialogs.length, 1);
  assert.match(r.dialogs[0].title, /по-стар от базата данни/, 'прекласифицирано като по-нова база');
  assert.match(r.dialogs[0].content, /Спряно при: no such column/, 'и конкретната грешка не се губи');
  assert.ok(!/преименувайте library\.db на library-повреден/.test(r.dialogs[0].content), 'без унищожителния съвет');
  assert.match(r.dialogs[0].content, /НЕ преименувайте library\.db/);
});

test('локална база след „Работи с локална база“ не получава съвет да се трие dbFolder', () => {
  /* Находка №7: isNetwork беше `!!config.dbFolder`, а resolveDbDir() пада към
     локалната папка, когато мрежовата липсва. */
  const r = startAgainstDb(99, 'local-fallback');
  assert.equal(r.exitCode, 1);
  assert.match(r.dialogs[0].title, /по-стар от базата данни/);
  assert.ok(!/dbFolder/.test(r.dialogs[0].content), 'базата е локална — редът dbFolder не е изходът');
  assert.match(r.dialogs[0].content, /Файл: .*library\.db/, 'диалогът назовава кой файл е по-новият');
  assert.equal(r.untouched, true, 'ранният отказ оставя файла байт за байт същия');
});

test('мрежовата база продължава да получава изхода през dbFolder', () => {
  const r = startAgainstDb(99, 'network');
  assert.match(r.dialogs[0].content, /dbFolder/);
});

test('версията на схемата се чете веднъж между пазача и миграциите; busy_timeout е преди пазача', () => {
  /* Находки №10 и №14, заковани по изходния код: двете са ред на изявления. */
  const src = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(code, /const from = assertSchemaNotNewer\(true\);/, 'from идва от самия пазач — едно четене');
  const migBody = code.slice(code.indexOf('function runMigrations()'), code.indexOf('function runMigrations()') + 600);
  assert.ok(!/const from = db\.pragma\('user_version'/.test(migBody), 'без второ четене');
  const init = code.slice(code.indexOf('function initDb()'), code.indexOf('function initDb()') + 1500);
  const bt = init.indexOf("busy_timeout"), guard = init.indexOf('assertSchemaNotNewer()');
  assert.ok(bt >= 0 && guard >= 0, 'и двете изявления съществуват в initDb()');
  assert.ok(bt < guard, 'busy_timeout се задава ПРЕДИ първото четене на user_version');
});

/* ==================================================================
   3. НОМЕРАТА В РЕГИСТРИТЕ И ЕЗИКЪТ В ИЗНОСА
   ================================================================== */

test('въведен номер 0 на протокол не става мълчаливо MAX+1; отрицателни и дробни се отказват', () => {
  /* Находка №12. */
  const { db } = fx.freshDb('inv-v2422-no-');
  const ipcMain = fx.fakeIpcMain();
  require('../handlers/inventory-sessions')(ipcMain, {
    getDb: () => db, run: fx.runDep, logAudit: () => {}, pctRequired: () => 10, naturalLoss: () => 0,
    normalizeScanCode: (c) => c
  });
  const start = (no) => ipcMain.invoke('inventorySessions:start', { date: '2026-03-01', scope: 'целият фонд', no,
    committee1: 'А', committee2: 'Б', committee3: 'В' });
  assert.equal(start('').ok, true, 'празно → следващият свободен');
  for (const bad of ['0', '-3', '1.5', '1e3', 'abc']) {
    const r = start(bad);
    assert.equal(r.ok, false, 'въведено „' + bad + '“ трябва да се откаже');
    assert.match(r.error, /цяло положително число/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_sessions').get().n, 1, 'нито един от лошите не е записан');
});

test('parseRegisterNo е общ за партиди, актове, протоколи и МЗС', () => {
  const { parseRegisterNo } = require('../security-utils');
  assert.equal(parseRegisterNo(' 12 '), 12);
  assert.throws(() => parseRegisterNo('0', 'Акт №'), /Акт № трябва да е цяло положително число/);
  assert.throws(() => parseRegisterNo('', 'Акт №'), /задължителен/);
  assert.equal(parseRegisterNo('', 'Протокол №', true), null);
  for (const f of ['acquisitions', 'deaccession-acts', 'inventory-sessions', 'mzs']) {
    const src = fs.readFileSync(path.join(APP_DIR, 'handlers', f + '.js'), 'utf8');
    assert.ok(!/parseInt\((a|act|s|m)\.no, 10\)/.test(src), f + ' вече не ползва голия parseInt за номера');
    assert.match(src, /parseRegisterNo\(/);
  }
});

test('език „друг“ не ражда бележка в износа, а „Английски“ с главна буква е eng', async () => {
  /* Находка №9. */
  const { db, exportTo } = fx.catalogSetup('inv-v2422-lang-');
  const ins = db.prepare("INSERT INTO books (inv_number, title, language, status) VALUES (?, ?, ?, 'наличен')");
  ins.run(1, 'Друг', 'друг');
  ins.run(2, 'Главна', 'Английски');
  ins.run(3, 'Непознат', 'японски');
  const text = await exportTo('catalog:exportMarc', 'm.xml');
  const recs = text.split('<record>').slice(1);
  assert.match(recs[0], /tag="101"[\s\S]*?code="a">und</);
  assert.ok(!/tag="300"/.test(recs[0]), '„друг“ не носи сведение — без обща бележка');
  assert.match(recs[1], /tag="101"[\s\S]*?code="a">eng</, 'търсенето е без значение на главни букви');
  assert.ok(!/tag="300"/.test(recs[1]));
  assert.match(recs[2], /tag="300"[\s\S]*?Език: японски/, 'истинско непознато наименование се пази');
});

/* ==================================================================
   4. НАРЪЧНИКЪТ
   ================================================================== */

test('HTML наръчникът е за текущата версия и не обещава недокосната база безусловно', () => {
  /* Находка №8. */
  const html = fs.readFileSync(path.join(APP_DIR, '..', 'docs', 'narachnik.html'), 'utf8');
  const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  assert.match(html, new RegExp('за програма v' + ver.replace(/\./g, '\\.')), 'заглавието на наръчника следва package.json');
  assert.ok(!/програмата не е записала\s*\nнищо в нея — спира веднага/.test(html), 'безусловното обещание е махнато');
  assert.match(html, /сервизната част на стартирането вече е минала/);
  assert.match(html, /само когато базата наистина е мрежова/);
});
