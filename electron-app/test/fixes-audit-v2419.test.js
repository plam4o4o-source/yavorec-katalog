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
const path = require('path');
const { execFileSync } = require('child_process');
/* Общите опори (freshDb, pdpSetup, catalogSetup …) са в helpers/audit-fixtures.js
   от одит v2.4.20 — дотук всеки кръг ги копираше дословно. */
const fx = require('./helpers/audit-fixtures');

const APP_DIR = fx.APP_DIR;
const VIEWS_DIR = path.join(APP_DIR, 'src', 'views');
test.after(fx.cleanupTmpDirs);

/* ==================================================================
   1. ПАЗАЧЪТ НАПРЕД — преди ЛЮБОЕ писане, не някъде по средата
   ================================================================== */
function startAgainstDb(userVersion, mode) {
  const out = execFileSync(process.execPath,
    [path.join(__dirname, 'helpers', 'newer-schema-worker.js'), String(userVersion)].concat(mode ? [mode] : []),
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
     към локална база през самата програма. Пътят трябва да е назован — но САМО
     когато наистина има ред dbFolder (одит v2.4.20: тук се проверяваше локална
     база, а диалогът въпреки това печаташе мрежовия съвет — невярна инструкция;
     сега мрежовият случай се проверява в собствения си режим на worker-а). */
  const net = startAgainstDb(99, 'network');
  assert.match(net.dialogs[0].content, /dbFolder/, 'назовава как се излиза, ако обновяването не е възможно веднага');
  assert.match(net.dialogs[0].content, /config\.json/);
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
test('сменена от друго работно място парола не се обявява за загубени данни', () => {
  /* Дефект в поправката от v2.4.18: причината за скриване се раздели на 'locked' и
     'unreadable', но състоянието PDP_STALE (паролата е сменена на друга станция,
     докато тази е била отворена) попадна в 'unreadable'. А то е напълно
     възстановимо: pdp:unlock нулира флага и същите ЕГН-та се четат. Картонът
     обаче инструктираше библиотекаря да ги ВЪВЕДЕ НАНОВО — тоест да пренапише
     непокътнати данни. Обратната грешка на поправяната.
     v2.4.21: фикстурата вече прави каквото прави ИСТИНСКАТА смяна на паролата от
     друго работно място — сменя pdp_salt/pdp_verifier в settings и прекриптира
     редовете с новия ключ. Първата редакция на теста само вкарваше редове с чужд
     ключ при непроменен проверител, тоест описваше повредени редове, не сменена
     парола — и точно затова партидната евристика, която той закова, беше грешна. */
  const { db, ret, pii } = fx.pdpSetup('inv-v2419-stale-');
  const newSalt = pii.generateSalt(2);
  const newKey = pii.deriveKey('нова-парола-на-другата-станция', newSalt);
  db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
    .run(newSalt.toString('base64'), pii.makeVerifier(newKey));
  const ins = db.prepare('INSERT INTO readers (name, egn, id_card_no) VALUES (?, ?, ?)');
  ins.run('Първи', pii.encryptField('7501010001', newKey), pii.encryptField('АА1234567', newKey));
  ins.run('Втори', pii.encryptField('7502020002', newKey), pii.encryptField('ББ7654321', newKey));

  const rows = ret.maskReaderRows(db.prepare('SELECT * FROM readers ORDER BY id').all());
  assert.equal(rows[0].pii_masked_reason, 'stale',
    'сменена отвън парола е СОБСТВЕНО състояние, не „стойността е загубена“');
  assert.notEqual(rows[0].pii_masked_reason, 'unreadable');
});

test('нечетимо поле при изправна сесия си остава „unreadable“', () => {
  // Контрол: истинският невъзстановим случай не бива да се слее с 'stale'.
  const { db, ret, pii, key } = fx.pdpSetup('inv-v2419-unread-');
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
test('бележката за езика не заема мястото на анотацията', async () => {
  /* Дефект в поправката от v2.4.18: бележката се извеждаше ПРЕДИ анотацията, а
     „друг“ е стойност по подразбиране в номенклатурата на езиците и я няма в
     LANG_ISO — тоест бележката излизаше на съвсем обикновени записи и приемаща
     система, която взима първия dc:description, показваше „Език по описание:
     друг“ на мястото на анотацията. */
  const { db, exportTo } = fx.catalogSetup('inv-v2419-dc-');
  /* v2.4.21: „друг“ не носи сведение и НЕ ражда бележка (тя е шум в сводния
     каталог на всеки такъв запис); истинско непознато наименование („японски“)
     продължава да се пази — след анотацията. */
  db.prepare("INSERT INTO books (inv_number, title, language, annotation) VALUES (1, 'Книга', 'японски', 'Истинската анотация.')").run();
  db.prepare("INSERT INTO books (inv_number, title, language, annotation) VALUES (2, 'Друга', 'друг', 'Анотация две.')").run();
  const xml = await exportTo('catalog:exportDc', 'dc.xml');
  const recs = xml.split('<record>').slice(1);
  const descs = (r) => [...r.matchAll(/<dc:description>([^<]*)<\/dc:description>/g)].map(m => m[1]);
  assert.deepEqual(descs(recs[0]), ['Истинската анотация.', 'Език по описание: японски'],
    'първата бележка е анотацията; сведението за езика не се губи, само отстъпва');
  assert.deepEqual(descs(recs[1]), ['Анотация две.'], '„друг“ не носи сведение — без бележка');
  assert.equal((xml.match(/<dc:language>und<\/dc:language>/g) || []).length, 2);
});
