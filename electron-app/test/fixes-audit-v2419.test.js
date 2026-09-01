'use strict';
/* Одит v2.4.19 — преглед на поправките от осмия кръг (v2.4.18).
   =====================================================================
   Кръгът, в който бяха поправени чужди дефекти, остави свои. Тежкият е един и е
   от най-неприятния вид: пазачът, добавен точно за да НЕ допусне по-стар код да
   пипне по-нова база, беше поставен така, че базата вече е пипната, докато той се
   задейства — а диалогът уверяваше библиотекаря в обратното.

   Всеки тест е проверен с мутация. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(APP_DIR, 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');
const tmpDirs = [];
function mkTmpDir(p) { const d = fs.mkdtempSync(p); tmpDirs.push(d); return d; }
test.after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* няма значение */ } }
});
function fakeIpcMain() {
  const h = new Map();
  return { handle: (c, fn) => h.set(c, fn), invoke: (c, ...a) => h.get(c)({}, ...a), has: (c) => h.has(c) };
}
function freshDb(prefix) {
  const dir = mkTmpDir(path.join(os.tmpdir(), prefix));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  return { db, dir };
}
const runDep = (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: e.message }; } };

/* ==================================================================
   1. ПАЗАЧЪТ НАПРЕД — преди ЛЮБОЕ писане, не някъде по средата
   ================================================================== */
function startAgainstDb(userVersion) {
  const out = execFileSync(process.execPath,
    [path.join(__dirname, 'helpers', 'newer-schema-worker.js'), String(userVersion)],
    { encoding: 'utf8', timeout: 60000 });
  return JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).pop());
}

test('отказът пред по-нова база оставя файла БУКВАЛНО непроменен', () => {
  /* Дефект в поправката от v2.4.18: проверката стоеше в runMigrations(), тоест
     СЛЕД `journal_mode`, след schema.sql, след всички ensureColumns() и след
     старите backfill-и в initDb(). Измерено тогава срещу здрава база с
     user_version = 99: контролната сума на файла се сменяше, readers
     .gdpr_consent_date се пренаписваше от NULL на дата, базата се преобразуваше в
     WAL и до нея оставаха -wal/-shm. Тоест пазачът допускаше точно това, срещу
     което съществува — по-стар код да пренапише данни, които по-новата версия
     чете другояче — а диалогът твърдеше „не ѝ е направено нищо“. */
  const r = startAgainstDb(99);
  assert.equal(r.exitCode, 1, 'стартирането спира');
  assert.equal(r.untouched, true, 'контролната сума на файла е същата и няма нови -wal/-shm');
  assert.deepEqual(r.sidecarsAfter, [], 'без странични файлове до базата');
  assert.equal(r.consentAfter, null, 'старият backfill НЕ е пренаписал съгласието');
  assert.equal(r.journalAfter, 'delete', 'журналният режим не е преобразуван');
  assert.equal(r.versionAfter, 99);
  assert.equal(r.sumAfter, 0, 'миграция 11 не е тръгвала');
});

test('съобщението не обещава повече, отколкото е вярно, и сочи изход', () => {
  const r = startAgainstDb(99);
  assert.equal(r.dialogs.length, 1);
  const c = r.dialogs[0].content;
  assert.match(c, /не е записала нищо в нея/, 'твърдението за непокътнатост вече е вярно');
  assert.match(c, /НЕ възстановявайте резервно копие/);
  /* Прозорецът изобщо не се отваря, тоест „Настройки“ → „Работа в мрежа“ е
     недостижимо: работно място, насочено към общата папка, няма как да се върне
     към локална база през самата програма. Пътят трябва да е назован. */
  assert.match(c, /dbFolder/, 'назовава как се излиза, ако обновяването не е възможно веднага');
  assert.match(c, /config\.json/);
});

test('позната версия на схемата се отваря, мигрира и пише както винаги', () => {
  // Контрол: пазачът е тесен и не пречи на нормалния старт.
  const r = startAgainstDb(10);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.dialogs, []);
  assert.equal(r.versionAfter, 11, 'миграциите минават');
  assert.equal(r.sumAfter, null, 'миграция 11 е приложена');
  assert.equal(r.consentAfter, '2020-01-01', 'старите backfill-и също минават');
  assert.equal(r.untouched, false, 'нормалният старт СЕ очаква да пише в базата');
});

/* ==================================================================
   2. ЗАЩИТА НА ЛИЧНИ ДАННИ — сменена парола ≠ загубена стойност
   ================================================================== */
function pdpSetup(prefix) {
  const { db } = freshDb(prefix);
  db.exec('ALTER TABLE settings ADD COLUMN pdp_salt TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pdp_verifier TEXT');
  const pii = require('../pii-crypto');
  const ipcMain = fakeIpcMain();
  const ret = require('../handlers/pdp')(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  ipcMain.invoke('pdp:setup', 'редовна-парола-11');
  const key = pii.deriveKey('редовна-парола-11',
    Buffer.from(db.prepare('SELECT pdp_salt FROM settings WHERE id=1').get().pdp_salt, 'base64'));
  return { db, ipcMain, ret, pii, key };
}

test('сменена от друго работно място парола не се обявява за загубени данни', () => {
  /* Дефект в поправката от v2.4.18: причината за скриване се раздели на 'locked' и
     'unreadable', но състоянието PDP_STALE (паролата е сменена на друга станция,
     докато тази е била отворена) попадна в 'unreadable'. А то е напълно
     възстановимо: pdp:unlock нулира флага и същите ЕГН-та се четат. Картонът
     обаче инструктираше библиотекаря да ги ВЪВЕДЕ НАНОВО — тоест да пренапише
     непокътнати данни. Обратната грешка на поправяната. */
  const { db, ret, pii, key } = pdpSetup('inv-v2419-stale-');
  const foreign = pii.deriveKey('чужда-9999', pii.generateSalt(2));
  const ins = db.prepare('INSERT INTO readers (name, egn, id_card_no) VALUES (?, ?, ?)');
  // ЦЯЛАТА партида е нечетима с текущия ключ → сесията се обявява за негодна.
  ins.run('Първи', pii.encryptField('7501010001', foreign), pii.encryptField('АА1234567', foreign));
  ins.run('Втори', pii.encryptField('7502020002', foreign), pii.encryptField('ББ7654321', foreign));
  ret.maskReaderRows(db.prepare('SELECT * FROM readers ORDER BY id').all());

  // Сега сесията е негодна (PDP_STALE) — следващото четене минава по онзи клон.
  const rows = ret.maskReaderRows(db.prepare('SELECT * FROM readers ORDER BY id').all());
  assert.equal(rows[0].pii_masked_reason, 'stale',
    'сменена отвън парола е СОБСТВЕНО състояние, не „стойността е загубена“');
  assert.notEqual(rows[0].pii_masked_reason, 'unreadable');
});

test('нечетимо поле при изправна сесия си остава „unreadable“', () => {
  // Контрол: истинският невъзстановим случай не бива да се слее с 'stale'.
  const { db, ret, pii, key } = pdpSetup('inv-v2419-unread-');
  const foreign = pii.deriveKey('чужда-9999', pii.generateSalt(2));
  // Един ред е нечетим, но друг се чете — сесията остава изправна.
  db.prepare('INSERT INTO readers (name, egn, id_card_no) VALUES (?, ?, ?)')
    .run('Смесен', pii.encryptField('7501010001', foreign), pii.encryptField('АА1234567', key));
  const rows = ret.maskReaderRows(db.prepare('SELECT * FROM readers').all());
  assert.equal(rows[0].pii_masked_reason, 'unreadable');
  assert.deepEqual(rows[0].pii_masked_fields, ['egn']);
});

test('несъществуващото състояние „mixed“ не се изчислява', () => {
  /* Първият вариант на поправката имаше и стойност 'mixed' за ред, чиито две
     полета са скрити по различни причини. Такъв ред не може да съществува: клонът
     зависи от състоянието на СЕСИЯТА, не от полето. Картонът обаче носеше готов
     текст за него — обяснение за състояние, което няма как да настъпи. */
  const src = fs.readFileSync(path.join(APP_DIR, 'handlers', 'pdp.js'), 'utf8');
  /* Коментарите обясняват защо състоянието е премахнато и споменават името му —
     затова се гледа само кодът. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/'mixed'/.test(code), 'pdp.js не изчислява състояние „mixed“');
  assert.match(code, /\['unreadable', 'stale', 'locked'\]/,
    'причината идва от изричен списък с трите възможни състояния');
  const view = fs.readFileSync(path.join(VIEWS_DIR, 'logo-org.js'), 'utf8');
  assert.ok(!/mixed:/.test(view), 'картонът няма текст за него');
});

/* ==================================================================
   3. DUBLIN CORE — бележката за езика не измества анотацията
   ================================================================== */
function catalogSetup(prefix) {
  const { db, dir } = freshDb(prefix);
  db.prepare("UPDATE settings SET lib_name = 'НЧ Тест' WHERE id = 1").run();
  const stub = () => {};
  const { BOOK_SELECT } = require('../handlers/books')(fakeIpcMain(), {
    getDb: () => db, run: runDep, logAudit: stub, today: () => '2026-08-04',
    ftsQuery: stub, cnSortKey: () => '', diffFields: () => [], scheduleCatalogWrite: stub
  });
  const ipcMain = fakeIpcMain();
  const ctx = { savePath: null };
  require('../handlers/catalog')(ipcMain, {
    getDb: () => db, run: runDep, logAudit: stub,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: ctx.savePath }) },
    getMainWindow: () => ({}), fs, path,
    execFile: (cmd, args, opts, cb) => cb(null, '', ''),
    BOOK_SELECT, csvCell: require('../security-utils').csvCell,
    flushCatalogWrite: () => ({ written: true }), buildCatalogPayload: () => ({ items: [] })
  });
  const exportTo = async (channel, name) => {
    ctx.savePath = path.join(dir, name);
    const res = await ipcMain.invoke(channel);
    assert.equal(res.ok, true, channel + ': ' + (res.error || ''));
    return fs.readFileSync(ctx.savePath, 'utf8');
  };
  return { db, exportTo };
}

test('бележката за езика не заема мястото на анотацията', async () => {
  /* Дефект в поправката от v2.4.18: бележката се извеждаше ПРЕДИ анотацията, а
     „друг“ е стойност по подразбиране в номенклатурата на езиците и я няма в
     LANG_ISO — тоест бележката излизаше на съвсем обикновени записи и приемаща
     система, която взима първия dc:description, показваше „Език по описание:
     друг“ на мястото на анотацията. */
  const { db, exportTo } = catalogSetup('inv-v2419-dc-');
  db.prepare("INSERT INTO books (inv_number, title, language, annotation) VALUES (1, 'Книга', 'друг', 'Истинската анотация.')").run();
  const xml = await exportTo('catalog:exportDc', 'dc.xml');
  const descs = [...xml.matchAll(/<dc:description>([^<]*)<\/dc:description>/g)].map(m => m[1]);
  assert.equal(descs[0], 'Истинската анотация.', 'първата бележка е анотацията');
  assert.equal(descs[1], 'Език по описание: друг', 'сведението за езика не се губи, само отстъпва');
  assert.match(xml, /<dc:language>und<\/dc:language>/);
});
