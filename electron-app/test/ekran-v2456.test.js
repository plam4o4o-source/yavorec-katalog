'use strict';
/* Одитен кръг v2.4.56 — ЕКРАНЪТ, ИЗНОСЪТ И ДВАМАТА, КОИТО ПИШАТ ЕДНОВРЕМЕННО.
 * =====================================================================
 * Три несвързани наглед неща, които се оказаха от един и същ род: работата на
 * библиотекаря изчезва, без нищо да го каже.
 *
 *  1) ЕДНОВРЕМЕННА РЕДАКЦИЯ. Програмата изрично поддържа няколко работни места
 *     към една база на мрежов диск. Транзакциите са коректни — но записът беше
 *     „последният печели“, и то МЪЛЧАЛИВО. Реалният случай: двете работни места
 *     отварят един и същ читател; първото добавя телефон и записва; второто, с
 *     отворена отпреди малко форма, записва адрес — и телефонът изчезва, без
 *     нищо да се случи на екрана. Открива се месеци по-късно, ако изобщо.
 *
 *  2) ИЗНОСЪТ. Програмата умееше да изведе четири неща: читателите, каталога,
 *     месечния дневник и одитната следа. Заеманията, актовете, постъпленията,
 *     периодиката, инвентаризациите, резервациите, сметките, МЗС и краезнанието
 *     нямаха НИКАКЪВ износ — единственият изход беше .db файл, който се отваря
 *     само с тази програма. Читалищната библиотека е задължена да може да
 *     предаде данните си; когато програмата е единственият път до собствените ѝ
 *     числа, данните са заложник на програмата.
 *
 *  3) КОПЧЕТАТА, КОИТО ОТПЛУВАТ ВДЯСНО. Измерено в Chromium при 1366×768:
 *     таблицата с читателите става 1082 px в поле от 1034 px, а копчето „⋯“
 *     свършва на 1375 px — 39 px отвъд видимата част и 9 px отвъд самия прозорец.
 *     При 1280×768 със 125 % увеличение извън екрана остава и „Редакция“.
 *     „Заемане“ на реда е действието, заради което изобщо се отваря списъкът с
 *     читатели. Същото и със страничната лента: 12 раздела под долния ръб.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  APP_DIR, freshDb, mkTmpDir, fakeIpcMain, runDep, cleanupTmpDirs
} = require('./helpers/audit-fixtures');
const { BOOK_SELECT, BOOK_FIELDS, csvCell, normalizeScanCode, diffFields } = require('./helpers/prod-values');

const CSS = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
const READERS_VIEW = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'readers.js'), 'utf8');
const BOOKS_VIEW = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'books.js'), 'utf8');
const pii = require(path.join(APP_DIR, 'pii-crypto'));

test.after(() => { pii.clearSession(); cleanupTmpDirs(); });

const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };

/* ==================================================================
   1. ЕДНОВРЕМЕННА РЕДАКЦИЯ
   ================================================================== */

function bookSetup() {
  const { db } = freshDb('inv-ekran-books-');
  const audit = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'books'))(ipcMain, {
    getDb: () => db, run: runDep,
    logAudit: (a, d, diff) => audit.push({ action: a, detail: d, diff }),
    today: () => '2026-08-04',
    ftsQuery: require(path.join(APP_DIR, 'search-fts')).ftsQuery,
    cnSortKey: (s) => String(s || '').toUpperCase(),
    diffFields, scheduleCatalogWrite: () => {}, normalizeScanCode
  });
  return { db, ipcMain, audit };
}
function readerSetup() {
  const { db } = freshDb('inv-ekran-readers-');
  const audit = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'readers'))(ipcMain, {
    getDb: () => db, run: runDep,
    logAudit: (a, d, diff) => audit.push({ action: a, detail: d, diff }),
    today: () => '2026-08-04',
    ftsQuery: require(path.join(APP_DIR, 'search-fts')).ftsQuery,
    maskReaderRow: (r) => r, maskReaderRows: (rows) => rows,
    preparePiiForWrite: () => {}, diffFields, checkRecordLimit: () => {},
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    getMainWindow: () => ({}), fs, csvCell, normalizeScanCode
  });
  return { db, ipcMain, audit };
}

test('books:get връща отпечатък на реда, с който формата се връща при записа', () => {
  /* Вместо нова колона `updated_at` (която иска миграция във всяка съществуваща
     база и тригер при всеки запис) се ползва отпечатък на самия ред. Той се
     смята върху ТОЧНО полетата, които формата редактира: промяна, направена от
     самата програма по друг повод, не бива да отказва редакция, която не я
     засяга. */
  const t = bookSetup();
  const id = ok(t.ipcMain.invoke('books:create', { inv_number: 1, title: 'Под игото', status: 'наличен' }), 'нов документ');
  const a = ok(t.ipcMain.invoke('books:get', id), 'отваряне');
  assert.equal(typeof a._rev, 'string');
  assert.ok(a._rev.length > 0);
  // Второ отваряне без промяна дава СЪЩИЯ отпечатък — иначе всяка форма би
  // отказвала запис без никаква чужда промяна.
  assert.equal(ok(t.ipcMain.invoke('books:get', id), 'второ отваряне')._rev, a._rev);
});

test('чужда промяна между отварянето и записа спира записа, вместо да я заличи мълчаливо', () => {
  /* Това е целият дефект в едно изречение: библиотекарката от другото работно
     място е добавила цена преди минута; ако този запис мине, цената изчезва и
     никой не научава. По-добре спрян запис с обяснение, отколкото тиха загуба. */
  const t = bookSetup();
  const id = ok(t.ipcMain.invoke('books:create', { inv_number: 2, title: 'Тютюн', status: 'наличен' }), 'нов документ');
  const mine = ok(t.ipcMain.invoke('books:get', id), 'моята форма');

  // Другото работно място записва пръв — то е чело реда наскоро и минава.
  const theirs = ok(t.ipcMain.invoke('books:get', id), 'чуждата форма');
  ok(t.ipcMain.invoke('books:update', Object.assign({}, theirs, { price: 12.5 })), 'чуждият запис');

  const res = t.ipcMain.invoke('books:update', Object.assign({}, mine, { title: 'Тютюн (второ издание)' }));
  assert.equal(res.ok, false, 'моят запис се спира');
  assert.match(res.error, /от друго работно място/);
  assert.match(res.error, /Записът е спрян/);
  assert.match(res.error, /отворете я отново/, 'казва се и какво да направи човекът');

  const row = t.db.prepare('SELECT title, price FROM books WHERE id = ?').get(id);
  assert.equal(row.price, 12.5, 'чуждата промяна е непокътната');
  assert.equal(row.title, 'Тютюн', 'и моята не е влязла наполовина');

  // След повторно отваряне записът минава — това не е задънена улица.
  const fresh = ok(t.ipcMain.invoke('books:get', id), 'ново отваряне');
  ok(t.ipcMain.invoke('books:update', Object.assign({}, fresh, { title: 'Тютюн (второ издание)' })), 'повторен запис');
  assert.equal(t.db.prepare('SELECT title FROM books WHERE id = ?').get(id).title, 'Тютюн (второ издание)');
});

test('запис без отпечатък (стар изглед) минава както преди — поправката не чупи път, който не я подава', () => {
  /* `_rev` липсва при по-стар изглед или при повикване отвън. Тогава проверката
     се прескача НАРОЧНО: иначе поправката би превърнала в грешка всичко, което
     още не я знае. */
  const t = bookSetup();
  const id = ok(t.ipcMain.invoke('books:create', { inv_number: 3, title: 'Тютюн', status: 'наличен' }), 'нов документ');
  const b = ok(t.ipcMain.invoke('books:get', id), 'отваряне');
  ok(t.ipcMain.invoke('books:update', Object.assign({}, b, { price: 9 })), 'чужда промяна');
  // Без _rev — точно както прави изглед отпреди тази версия.
  const old = Object.assign({}, b, { title: 'Ново заглавие' });
  delete old._rev;
  ok(t.ipcMain.invoke('books:update', old), 'стар изглед');
  assert.equal(t.db.prepare('SELECT title FROM books WHERE id = ?').get(id).title, 'Ново заглавие');
});

test('същото и за читателя — и отпечатъкът се смята ПРЕДИ маскирането на личните данни', () => {
  /* Маскираният ред не носи истинските стойности: ако отпечатъкът се смяташе
     върху него, той щеше да се сменя според това дали защитата на личните данни
     е отключена — тоест записът щеше да се отказва без никаква чужда промяна. */
  const t = readerSetup();
  const id = ok(t.ipcMain.invoke('readers:create', { name: 'Иванова, Мария', card_no: '001', gdpr_consent: 1 }), 'нов читател');
  const mine = ok(t.ipcMain.invoke('readers:get', id), 'моята форма');
  assert.equal(typeof mine._rev, 'string');

  const theirs = ok(t.ipcMain.invoke('readers:get', id), 'чуждата форма');
  ok(t.ipcMain.invoke('readers:update', Object.assign({}, theirs, { phone: '0888123456' })), 'чуждият запис');

  const res = t.ipcMain.invoke('readers:update', Object.assign({}, mine, { address: 'ул. Първа 1' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /Читателят е променен/);
  const row = t.db.prepare('SELECT phone, address FROM readers WHERE id = ?').get(id);
  assert.equal(row.phone, '0888123456', 'телефонът, добавен от другото работно място, остава');
  assert.equal(row.address, null, 'и адресът не е влязъл заедно с изтриването му');

  // Стар изглед без _rev пак минава.
  const old = Object.assign({}, mine, { address: 'ул. Първа 1' });
  delete old._rev;
  ok(t.ipcMain.invoke('readers:update', old), 'стар изглед');
});

test('формите наистина носят отпечатъка от отварянето до записа', () => {
  /* Проверката в главния процес е безполезна, ако изгледът не подаде `_rev`:
     тогава всяка форма изглежда като „стар изглед“ и защитата не се включва
     никога. */
  assert.match(READERS_VIEW, /f\.dataset\.rev = r\._rev/, 'формата на читателя запомня отпечатъка');
  assert.match(READERS_VIEW, /d\._rev = rf\.dataset\.rev/, 'и го връща при записа');
  assert.match(BOOKS_VIEW, /dataset\.rev/, 'същото и формата на документа');
});

/* ==================================================================
   2. ПЪЛЕН ИЗНОС НА ДАННИТЕ
   ================================================================== */

/* Разчита ZIP-а, без да се добавя зависимост — точно както и самият износ го
   СГЛОБЯВА без зависимост. Форматът е прост: поредица от локални заглавни
   блокове, всеки със своето име и размер, следвани от централния каталог. */
function readZip(buf) {
  const out = new Map();
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + compSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    off = start + compSize;
  }
  return out;
}
/* CSV-то е с „;“ и с кавички по RFC 4180 — тук стига разцепване на редове и на
   колони без кавички във вътрешността, каквито тестовите данни нямат. */
function csvRows(text) {
  return text.replace(/^﻿/, '').trim().split('\r\n').map(line => line.split(';').map(c => c.replace(/^"|"$/g, '')));
}

function exportSetup(opts) {
  const o = opts || {};
  const { db } = freshDb('inv-ekran-iznos-');
  /* Двете колони идват от миграция 2 в main.js, не от db/schema.sql — всяка
     работеща база отдавна ги има. Фикстурата ги добавя по същия начин, по който
     го прави и общата опора pdpSetup(). */
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  const dir = mkTmpDir('inv-ekran-zip-');
  const target = path.join(dir, 'iznos.zip');
  const audit = [];
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'export-all'))(ipcMain, {
    getDb: () => db, logAudit: (a, d) => audit.push({ action: a, detail: d }),
    dialog: { showSaveDialog: async () => (o.cancel ? { canceled: true } : { canceled: false, filePath: target }) },
    getMainWindow: () => ({}), fs, csvCell, today: () => '2026-08-04'
  });
  return { db, ipcMain, audit, target };
}

/* Читател с ПЪЛЕН набор лични данни — точно това, което не бива да напусне
   програмата на флашка. */
function addRichReader(db) {
  return db.prepare(`INSERT INTO readers
    (name, card_no, egn, id_card_no, address, phone, email, birth_date, guarantor_name, guarantor_phone, note, status, category)
    VALUES ('Иванова, Мария', '000123', '7501011234', 'АА1234567', 'с. Яворец, ул. Първа 1', '0888123456',
            'maria@example.bg', '1975-01-01', 'Иванов, Иван', '0899000000', 'живее при дъщеря си', 'активен', 'възрастен')`)
    .run().lastInsertRowid;
}

test('пълният износ прави ZIP с по един CSV за всяка таблица и обяснителен файл отгоре', async () => {
  /* Един ZIP с CSV-та се отваря с Excel, с LibreOffice и с Notepad на всяка
     машина, включително след 10 години и без InvLib. Обяснителният файл е
     половината от смисъла: човек, който никога не е виждал тази програма,
     трябва да разбере кой файл какво съдържа. */
  const t = exportSetup();
  addRichReader(t.db);
  t.db.prepare("INSERT INTO books (inv_number, title, register_date) VALUES (1, 'Под игото', '2026-01-05')").run();

  const res = await t.ipcMain.invoke('exportAll:run');
  assert.equal(res.ok, true, res.error || '');
  const zip = readZip(fs.readFileSync(t.target));

  assert.ok(zip.has('PROCHETI-ME.txt'), 'обяснителният файл е в архива');
  assert.ok(zip.has('chitateli.csv'), 'читателите');
  assert.ok(zip.has('katalog-knigi.csv'), 'фондът');
  assert.ok(zip.has('zaemania.csv'), 'заеманията — дотук нямаха никакъв износ');
  assert.ok(zip.has('aktove-otchislyavane.csv'), 'актовете за отчисляване');
  assert.ok(zip.has('odit-sleda.csv'), 'одитната следа');
  assert.ok(res.data.tables > 20, 'изнасят се всички таблици, не избрани четири: ' + res.data.tables);

  // Имената на файловете са на латиница с български думи: Windows Explorer
  // показва кирилица в имената на записите като квадратчета.
  for (const name of zip.keys()) assert.match(name, /^[\x20-\x7E]+$/, 'име без кирилица: ' + name);

  // BOM — иначе Excel на Windows чете кирилицата като „Ð§Ð¸ÑÐ°ÑÐµÐ»Ð¸“.
  const chit = zip.get('chitateli.csv').toString('utf8');
  assert.ok(chit.startsWith('﻿'), 'CSV-то започва с BOM');
  const rows = csvRows(chit);
  assert.ok(rows[0].includes('name'), 'заглавният ред са истинските имена на колоните — по тях се правят връзките');
  assert.ok(rows[0].includes('card_no'));
  assert.equal(rows[1][rows[0].indexOf('name')], 'Иванова, Мария');

  const readme = zip.get('PROCHETI-ME.txt').toString('utf8');
  assert.match(readme, /ПЪЛЕН ИЗНОС НА ДАННИТЕ/);
  assert.match(readme, /chitateli\.csv/, 'изрежда кой файл какво съдържа');
  assert.match(readme, /разделител/, 'и как се отваря');
});

test('ЕГН и номерът на лична карта НЕ излизат в износа при никакви обстоятелства', () => {
  /* Архивът се носи на флашка и се праща по имейл, а списък с ЕГН-тата на всички
     читатели е най-опасното нещо в базата. Пълното копие ВКЛЮЧИТЕЛНО с ЕГН си
     остава криптираното резервно копие, което се отваря само с паролата. */
  pii.clearSession(); // защита изобщо не е задавана — най-„отпуснатото“ състояние
  const t = exportSetup();
  addRichReader(t.db);

  return t.ipcMain.invoke('exportAll:run').then((res) => {
    assert.equal(res.ok, true, res.error || '');
    const zip = readZip(fs.readFileSync(t.target));
    const chit = zip.get('chitateli.csv').toString('utf8');
    const head = csvRows(chit)[0], row = csvRows(chit)[1];
    assert.equal(row[head.indexOf('egn')], '(скрито)');
    assert.equal(row[head.indexOf('id_card_no')], '(скрито)');
    // И нито едно от двете не се е промъкнало никъде другаде в архива.
    for (const [name, buf] of zip) {
      const text = buf.toString('utf8');
      assert.ok(!text.includes('7501011234'), 'ЕГН в ' + name);
      assert.ok(!text.includes('АА1234567'), '№ ЛК в ' + name);
    }
    // Данните за връзка обаче излизат — те са на всеки екран и на всяка
    // разпечатка на самата програма и износът не бива да е по-беден от нея.
    assert.equal(row[head.indexOf('phone')], '0888123456');
    assert.equal(row[head.indexOf('address')], 'с. Яворец, ул. Първа 1');
    assert.match(zip.get('PROCHETI-ME.txt').toString('utf8'), /ЕГН и номерът на личната карта НЕ се изнасят/);
  });
});

test('при ЗАКЛЮЧЕНА защита се скриват и адресът, телефонът и имейлът — износът не е вратичка покрай ключалката', async () => {
  /* Заключената защита значи, че библиотекарят не е доказал правото си да вижда
     тези данни СЕГА. Свободните полета („бележка“) са в същия списък нарочно: в
     тях реално се пише „живее при дъщеря си на ул. …“ — адрес под друго име. */
  const t = exportSetup();
  addRichReader(t.db);
  // Защитата е ЗАДАДЕНА (има сол и проверител), но сесията е заключена.
  t.db.prepare("UPDATE settings SET pdp_salt = 'c29s', pdp_verifier = 'proveritel' WHERE id = 1").run();
  pii.clearSession();

  const res = await t.ipcMain.invoke('exportAll:run');
  assert.equal(res.ok, true, res.error || '');
  assert.equal(res.data.pdpLocked, true);
  const zip = readZip(fs.readFileSync(t.target));
  const rows = csvRows(zip.get('chitateli.csv').toString('utf8'));
  const head = rows[0], row = rows[1];
  for (const col of ['egn', 'id_card_no', 'address', 'phone', 'email', 'birth_date', 'guarantor_name', 'guarantor_phone', 'note']) {
    assert.equal(row[head.indexOf(col)], '(скрито)', 'колоната „' + col + '“ трябва да е скрита');
  }
  assert.equal(row[head.indexOf('name')], 'Иванова, Мария', 'името остава — иначе файлът не става за нищо');

  // Солта и проверителят на паролата не излизат НИКОГА: с тях паролата се напада
  // офлайн, извън програмата.
  const nastroyki = csvRows(zip.get('nastroyki.csv').toString('utf8'));
  assert.equal(nastroyki[1][nastroyki[0].indexOf('pdp_salt')], '(скрито)');
  assert.equal(nastroyki[1][nastroyki[0].indexOf('pdp_verifier')], '(скрито)');

  // И библиотекарят научава какво ДЪРЖИ в ръцете си — за да не прати непълен
  // файл, мислейки го за пълен.
  const readme = zip.get('PROCHETI-ME.txt').toString('utf8');
  assert.match(readme, /ЗАДАДЕНА и в момента ЗАКЛЮЧЕНА/);
  assert.match(readme, /chitateli\.csv → address/, 'изрежда се точно кое е скрито');
  assert.match(t.audit[0].detail, /скрити \(защитата е заключена\)/, 'и одитната следа го казва');
});

test('износът оставя одитна следа с числата — при проверка по ОРЗД въпросът е точно този', () => {
  const t = exportSetup();
  addRichReader(t.db);
  return t.ipcMain.invoke('exportAll:run').then((res) => {
    assert.equal(res.ok, true, res.error || '');
    assert.equal(t.audit.length, 1);
    assert.equal(t.audit[0].action, 'Пълен износ на данните (CSV в ZIP)');
    assert.match(t.audit[0].detail, /файла/);
    assert.match(t.audit[0].detail, /записа/);
    assert.match(t.audit[0].detail, /ЕГН и № ЛК скрити/);
  });
});

test('отказан диалог не пише файл и не оставя следа', () => {
  const t = exportSetup({ cancel: true });
  return t.ipcMain.invoke('exportAll:run').then((res) => {
    assert.equal(res.ok, false);
    assert.match(res.error, /Отказано/);
    assert.equal(fs.existsSync(t.target), false);
    assert.equal(t.audit.length, 0);
  });
});

/* ==================================================================
   3. КОПЧЕТАТА И СТРАНИЧНАТА ЛЕНТА ОСТАВАТ НА ЕКРАНА
   ================================================================== */

/* Стилът се чете без празни знаци: правилото „залепена колона“ е съчетание от
   няколко свойства и всяко от тях поотделно не върши нищо. */
const flat = CSS.replace(/\s+/g, '');

test('колоната с действията е ЗАЛЕПЕНА за десния ръб и има собствен непрозрачен фон', () => {
  /* „Заемане“ на реда е действието, заради което изобщо се отваря списъкът с
     читатели. Когато таблицата стане по-широка от полето, копчетата отплуват
     вдясно — а човек на гише обикновено дори не забелязва, че таблицата се
     превърта настрани, и остава с впечатление, че бутоните ги няма.
     Фонът е задължителен: без него текстът на реда минава ПОД залепената клетка
     и двете се четат едно върху друго. */
  assert.match(flat, /table\.ledgertd\.actsCell,table\.ledgerth\.actsCell\{[^}]*position:sticky/,
    'клетката с действията е sticky');
  assert.match(flat, /table\.ledgertd\.actsCell,table\.ledgerth\.actsCell\{[^}]*right:0/,
    'и е закачена за ДЕСНИЯ ръб');
  assert.match(flat, /table\.ledgertd\.actsCell,table\.ledgerth\.actsCell\{[^}]*background:var\(--paper2\)/,
    'със собствен непрозрачен фон');
  // Зебрата и посоченият ред имат свой плътен фон — иначе през тях прозира текст.
  assert.match(flat, /tr:nth-child\(even\)td\.actsCell\{background:/);
  assert.match(flat, /tr:hovertd\.actsCell\{background:/);
  // Заглавната клетка стои НАД тялото, иначе първият ред минава върху нея.
  assert.match(flat, /table\.ledgerth\.actsCell\{background:var\(--paper3\);z-index:3\}/);
});

test('заглавната клетка на колоната с действията носи същия клас — иначе горният ред се разминава с тялото', () => {
  /* Без класа <th> е обикновена клетка: при хоризонтално превъртане залепените
     клетки с копчетата стоят на място, а празната заглавна клетка над тях
     отплува вляво. */
  assert.match(READERS_VIEW, /<th class="actsCell"><\/th>/, 'списъкът с читатели');
  assert.match(BOOKS_VIEW, /<th class="actsCell"/, 'списъкът с документи');
  // И самите клетки на редовете носят класа — иначе правилото няма за какво да се хване.
  assert.match(READERS_VIEW, /<td class="actsCell">/);
  assert.match(BOOKS_VIEW, /<td class="actsCell">/);
});

test('името на читателя се ПРЕНАСЯ, вместо да разтяга таблицата', () => {
  /* Причината таблицата изобщо да излиза извън полето беше колоната с името:
     „Константинова-Александрова, Мария-Магдалена“ с white-space:nowrap не може
     да се пренесе и избутва всичко надясно. `break-word`, а не `anywhere`:
     второто влиза и в сметката за минималната ширина и при тесен прозорец свива
     колоната до 30 px, при което имената излизат нарязани по срички. */
  assert.ok(!/table\.ledger\.readersTabletd:first-child\{white-space:nowrap\}/.test(flat),
    'колоната с името вече не е nowrap');
  assert.match(flat, /readersTabletd:first-child\{[^}]*overflow-wrap:break-word/);
  assert.match(flat, /readersTabletd:first-child\{[^}]*max-width:/, 'и има горна граница на ширината');
});

test('страничната лента превърта САМО списъка с раздели — заглавието и подписът остават на екрана', () => {
  /* Измерено в Chromium при 1280×768 и 125 % увеличение (1024×614 CSS px):
     лентата иска 1146 px в поле от 614 px — 12 раздела, от „Периодика“ надолу до
     „Настройки“, стоят под долния ръб. Превъртането на ЦЯЛАТА лента влачеше
     надолу и рамката с наименованието на библиотеката, и подписа: след като се
     превърти до „Настройки“, „Читатели“ и „Заемане и връщане“ излизат нагоре
     извън екрана. Тоест цялото меню никога не се вижда наведнъж. */
  assert.match(flat, /#rail\{[^}]*overflow:hidden/, 'самата лента вече не превърта');
  assert.match(flat, /#nav\{[^}]*overflow-y:auto/, 'превъртането е в списъка с раздели');
  assert.match(flat, /#nav\{[^}]*flex:11auto/, 'списъкът заема мястото между заглавието и подписа');
  /* min-height:0 е задължително и точно то е лесното за изпускане: елемент във
     flex колона има подразбиращо се min-height:auto („поне колкото съдържанието“)
     и без него #nav просто пораства, изтиква подписа под екрана и не превърта
     НИЩО — поправката би изглеждала приложена и не би работила. */
  assert.match(flat, /#nav\{[^}]*min-height:0/,
    'без min-height:0 списъкът пораства до съдържанието си и не превърта нищо');
  // Скролбарът на новото поле е в цветовете на лентата, а не системният сив.
  assert.match(flat, /#rail::-webkit-scrollbar,#nav::-webkit-scrollbar\{width:9px\}/);
});

test('правилата за нисък екран стоят СЛЕД правилата, които уплътняват, и са с по-голяма тежест', () => {
  /* Блокът @media (max-height:780px) стоеше ПРЕДИ правилото `#nav a{…}`. И
     двата селектора са `#nav a`, тоест с еднаква тежест (1-0-1), а при равна
     тежест печели по-късният в документа. Измерено: `.brandIcon` наистина се
     скриваше (затова дефектът не личеше отстрани), но редовете на менюто си
     оставаха 13.5 px — тоест уплътняването, заради което блокът е писан, изобщо
     не се е случвало. */
  // Търси се самото ПРАВИЛО (с отварящата скоба), а не споменаването му в
  // коментар — иначе тестът би сравнявал позицията на обяснението, не на кода.
  const media = CSS.indexOf('@media (max-height:780px){');
  const navLink = CSS.indexOf('\n#nav a{');
  assert.ok(media > -1 && navLink > -1, 'и двете правила съществуват');
  assert.ok(media > navLink,
    'блокът за нисък екран трябва да е СЛЕД #nav a, иначе половината от него е мъртва');
  // Тялото на медийния блок — до затварящата го скоба.
  let depth = 0, end = media;
  for (let i = CSS.indexOf('{', media); i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = CSS.slice(media, end + 1);
  assert.match(block, /#rail #nav a\{/, 'селекторите са вдигнати с #rail — тежестта не зависи от реда във файла');
  assert.match(block, /#rail \.brandIcon\{display:none\}/);
  assert.match(block, /#rail \.railFoot\{/, 'уплътнява се и дъното на лентата, описано 600 реда по-надолу');
});
