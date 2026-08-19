// Тест на handlers/readers.js — седемнайсети домейн, извадено от main.js
// (Фаза 4, стъпка 17). Проверява основния CRUD, PII маскирането/подготовката
// за запис, диференца в одитната следа, лимита на записите и FTS търсенето.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerReadersHandlers = require('../handlers/readers');
const { ftsQuery, READERS_FTS_SETUP_SQL } = require('../search-fts');
/* diffFields (main.js) и csvCell (security-utils.js) се ВЗИМАТ от продукцията.
   Копието на diffFields връщаше обект вместо масив, а копието на csvCell не
   неутрализираше водещите =/+/-/@ — двете заедно правеха теста сляп и за ЕГН
   в одита, и за CSV injection. Вж. test/helpers/prod-values.js. */
const { diffFields, csvCell, normalizeScanCode } = require('./helpers/prod-values.js');


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

function setup(overrides = {}) {
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-readers-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  db.exec(READERS_FTS_SETUP_SQL);

  const auditLog = [];
  const piiCalls = { prepareWrite: [] };
  const savedDialogs = { saveDialog: { canceled: false, filePath: path.join(dir, 'out.csv') } };
  const ipcMain = fakeIpcMain();
  const deps = Object.assign({
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail, diff) => auditLog.push({ action, detail, diff }),
    today: () => '2026-08-02',
    ftsQuery,
    maskReaderRow: (r) => r,
    maskReaderRows: (rows) => rows,
    preparePiiForWrite: (out, prev) => { piiCalls.prepareWrite.push({ out: Object.assign({}, out), prev }); },
    diffFields,
    checkRecordLimit: () => {},
    dialog: { showSaveDialog: async () => savedDialogs.saveDialog },
    getMainWindow: () => ({}),
    fs,
    csvCell,
    normalizeScanCode
  }, overrides);
  registerReadersHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, piiCalls, dir, savedDialogs };
}

test('registerReadersHandlers registers all seven readers: IPC channels (v1.70.0 adds exportCsv)', () => {
  const { ipcMain } = setup();
  for (const ch of ['readers:list', 'readers:get', 'readers:byCard', 'readers:create',
    'readers:update', 'readers:clearSuspension', 'readers:delete', 'readers:exportCsv']) {
    assert.ok(ipcMain.has(ch), `expected ${ch} to be registered`);
  }
});

test('readers:create inserts a row with sensible defaults and logs an audit entry', async () => {
  const { ipcMain, auditLog } = setup();
  const result = await ipcMain.invoke('readers:create', { name: 'Иван Иванов', card_no: 'C1' });
  assert.equal(result.ok, true);
  assert.ok(result.data > 0);
  assert.equal(auditLog.length, 1);
  assert.match(auditLog[0].detail, /C1/);

  const got = await ipcMain.invoke('readers:get', result.data);
  assert.equal(got.data.category, 'възрастен');
  assert.equal(got.data.status, 'активен');
  assert.equal(got.data.registered_at, '2026-08-02');
});

test('readers:create calls checkRecordLimit before inserting (throws stop the insert)', async () => {
  const { ipcMain } = setup({ checkRecordLimit: () => { throw new Error('Достигнат е лимитът.'); } });
  const result = await ipcMain.invoke('readers:create', { name: 'Спрян' });
  assert.equal(result.ok, false);
  assert.match(result.error, /лимит/);
  const list = await ipcMain.invoke('readers:list');
  assert.equal(list.data.length, 0);
});

/* Одитната следа НЕ бива да съдържа ЕГН/№ на лична карта: тя се чете от всеки
   с достъп до програмата и се изнася заедно с резервните копия, докато самите
   полета са под отделна защита (handlers/pdp.js). Дотук тази гаранция се
   „проверяваше" срещу измислен diffFields, който връщаше ОБЕКТ {поле:[преди,
   след]} — затова `diff.egn === undefined` беше вярно и когато ЕГН-то е вътре,
   защото истинската продукция връща МАСИВ [{field,before,after}] и обектното
   свойство .egn върху масив така или иначе е undefined. Сега се ползва
   истинският diffFields, а твърдението гледа полето field. */
test('readers:update изчислява diff през истинския diffFields и НИКОГА не вкарва ЕГН в одитната следа', async () => {
  const { ipcMain, auditLog } = setup();
  const id = (await ipcMain.invoke('readers:create', { name: 'Мария', phone: '111', egn: '1234567890' })).data;
  auditLog.length = 0;
  await ipcMain.invoke('readers:update', { id, name: 'Мария', phone: '222', egn: '0000000000' });
  assert.equal(auditLog.length, 1);
  const diff = auditLog[0].diff;
  assert.ok(Array.isArray(diff), 'diffFields в продукцията връща масив — ако тук дойде обект, тестът пази фалшификат');
  const changed = diff.map(d => d.field);
  assert.ok(changed.includes('phone'), 'смяната на телефон трябва да е в diff-а');
  assert.equal(diff.find(d => d.field === 'phone').before, '111');
  assert.equal(diff.find(d => d.field === 'phone').after, '222');
  assert.ok(!changed.includes('egn'), 'ЕГН никога не влиза в одитната следа');
  assert.ok(!changed.includes('id_card_no'), '№ на лична карта също не влиза');
  // И най-грубата проверка: самата стойност не бива да се среща никъде в diff-а.
  assert.ok(!JSON.stringify(diff).includes('0000000000'), 'ЕГН не бива да се появява дори като стойност');
});

test('readers:update calls preparePiiForWrite with the previous row for PII handling', async () => {
  const { ipcMain, piiCalls } = setup();
  const id = (await ipcMain.invoke('readers:create', { name: 'Петър' })).data;
  piiCalls.prepareWrite.length = 0;
  await ipcMain.invoke('readers:update', { id, name: 'Петър Петров' });
  assert.equal(piiCalls.prepareWrite.length, 1);
  assert.ok(piiCalls.prepareWrite[0].prev, 'prev row should be passed on update');
});

test('readers:clearSuspension nulls suspended_until and logs the reader name', async () => {
  const { db, ipcMain, auditLog } = setup();
  const id = (await ipcMain.invoke('readers:create', { name: 'Георги' })).data;
  db.prepare('UPDATE readers SET suspended_until = ? WHERE id = ?').run('2030-01-01', id);
  await ipcMain.invoke('readers:clearSuspension', id);
  const row = db.prepare('SELECT suspended_until FROM readers WHERE id = ?').get(id);
  assert.equal(row.suspended_until, null);
  assert.match(auditLog[auditLog.length - 1].detail, /Георги/);
});

test('readers:byCard finds a reader by card_no', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('readers:create', { name: 'Търсен', card_no: 'ABC123' });
  const result = await ipcMain.invoke('readers:byCard', 'ABC123');
  assert.equal(result.data.name, 'Търсен');
});

// v1.70.1: баркод четецът въвежда текста буква по буква като физическа
// клавиатура — при активна кирилска (фонетична) разредба на Windows картата
// "B00108" пристига в програмата като "Б00108" и не се намираше при
// сканиране, макар да е сканирана правилно (докладвано от библиотекаря на
// живо). normalizeScanCode() връща буквите обратно към латиница.
test('readers:byCard намира читателя дори кодът да пристигне с кирилски букви от четеца (v1.70.1)', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('readers:create', { name: 'Мария', card_no: 'B00108' });
  const result = await ipcMain.invoke('readers:byCard', 'Б00108');
  assert.ok(result.data, 'читателят трябва да се намери въпреки кирилския вход');
  assert.equal(result.data.name, 'Мария');
});

test('readers:delete removes the row', async () => {
  const { db, ipcMain } = setup();
  const id = (await ipcMain.invoke('readers:create', { name: 'За изтриване' })).data;
  await ipcMain.invoke('readers:delete', id);
  const row = db.prepare('SELECT * FROM readers WHERE id = ?').get(id);
  assert.equal(row, undefined);
});

test('readers:list without a query returns all readers ordered by name, masked via maskReaderRows', async () => {
  let maskedCount = 0;
  const { ipcMain } = setup({ maskReaderRows: (rows) => { maskedCount = rows.length; return rows; } });
  await ipcMain.invoke('readers:create', { name: 'Борис' });
  await ipcMain.invoke('readers:create', { name: 'Ана' });
  const list = await ipcMain.invoke('readers:list');
  assert.equal(list.data.length, 2);
  assert.equal(list.data[0].name, 'Ана', 'should be ordered by name');
  assert.equal(maskedCount, 2);
});

test('readers:list with a query uses ftsQuery for the FTS5 match and LIKE for phone/card_no', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('readers:create', { name: 'Специално Име', phone: '0888123456' });
  await ipcMain.invoke('readers:create', { name: 'Друг', phone: '111' });
  const byPhone = await ipcMain.invoke('readers:list', '0888123456');
  assert.equal(byPhone.data.length, 1);
  assert.equal(byPhone.data[0].name, 'Специално Име');
});

/* --- readers:exportCsv (v1.70.0) — дотогава списъкът с читатели нямаше никакъв износ --- */

test('readers:exportCsv writes a semicolon-separated CSV with a BOM, one row per reader, ordered by name', async () => {
  const { ipcMain, auditLog } = setup();
  await ipcMain.invoke('readers:create', { name: 'Борислав Петров', card_no: 'C2', phone: '0888', category: 'възрастен' });
  await ipcMain.invoke('readers:create', { name: 'Ана Иванова', card_no: 'C1', phone: '0899', category: 'дете до 14 г.' });

  const result = await ipcMain.invoke('readers:exportCsv');
  assert.equal(result.ok, true);

  const raw = fs.readFileSync(result.data, 'utf8');
  assert.equal(raw.charCodeAt(0), 0xFEFF, 'файлът трябва да започва с BOM, за да се отвори коректно в Excel');
  const lines = raw.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 3, 'заглавен ред + 2 читатели');
  assert.match(lines[0], /Читателска карта/);
  assert.match(lines[0], /Име/);
  // ordered by name: Ана преди Борислав
  assert.ok(lines[1].includes('Ана Иванова'));
  assert.ok(lines[2].includes('Борислав Петров'));
  assert.equal(auditLog.length, 3, '2 записа за readers:create + 1 за износа');
  assert.match(auditLog[2].detail, /2 записа/);
});

test('readers:exportCsv omits egn/id_card_no columns entirely (справочен документ, не заместител на защитата на личните данни)', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('readers:create', { name: 'С лични данни', egn: '1234567890', id_card_no: '999888777' });
  const result = await ipcMain.invoke('readers:exportCsv');
  const raw = fs.readFileSync(result.data, 'utf8');
  assert.doesNotMatch(raw, /1234567890/);
  assert.doesNotMatch(raw, /999888777/);
  assert.doesNotMatch(raw, /ЕГН/i);
});

/* CSV injection: Excel/LibreOffice изпълняват клетка, започваща с =, +, - или @,
   като ФОРМУЛА. Име на читател „=SUM(1+1)" или бележка „=HYPERLINK(...)" е
   достатъчно, за да се получи изпълним документ от обикновена справка на
   библиотеката. Затова csvCell слага водещ апостроф. Дотук тестовете подаваха
   СОБСТВЕН csvCell, който само вадеше кавичките — заради което мутацията
   „readers:exportCsv спира да вика csvCell" оцеляваше незабелязано. */
test('readers:exportCsv неутрализира формули в CSV (водещи =, +, -, @) и правилно вади кавичките', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('readers:create', { name: '=SUM(1+1)', note: '+79', phone: '-1', address: '@cmd' });
  await ipcMain.invoke('readers:create', { name: 'Кавички "вътре"', note: 'ред;с;точка и запетая' });
  const result = await ipcMain.invoke('readers:exportCsv');
  assert.equal(result.ok, true, result.error);
  const raw = fs.readFileSync(result.data, 'utf8');

  assert.ok(raw.includes('"\'=SUM(1+1)"'), 'формулата трябва да е обезвредена с водещ апостроф');
  assert.ok(raw.includes('"\'+79"'), 'водещият + също е формула за Excel');
  assert.ok(raw.includes('"\'-1"'), 'водещият - също');
  assert.ok(raw.includes('"\'@cmd"'), 'водещият @ също');
  assert.ok(!/(^|;)"[=+@]/m.test(raw), 'нито една клетка не бива да започва направо с =, + или @');
  assert.ok(raw.includes('"Кавички ""вътре"""'), 'кавичките се удвояват по RFC 4180');
  assert.ok(raw.includes('"ред;с;точка и запетая"'), 'разделителят вътре в клетка остава в кавички');
});

test('readers:exportCsv respects a cancelled save dialog', async () => {
  const { ipcMain, savedDialogs } = setup();
  savedDialogs.saveDialog = { canceled: true, filePath: null };
  const result = await ipcMain.invoke('readers:exportCsv');
  assert.equal(result.ok, false);
  assert.match(result.error, /Отказано/);
});
