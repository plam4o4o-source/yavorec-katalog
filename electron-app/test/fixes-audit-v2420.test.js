'use strict';
/* Одит v2.4.20 — преглед на поправките от деветия кръг (v2.4.19).
   =====================================================================
   Тежката находка е огледалният образ на предишната: v2.4.19 премести пазача
   срещу по-нова база В НАЧАЛОТО на стартирането (за да не пипа базата), но САМО
   го премести — и отвори обратния процеп: другото, вече обновено работно място
   може да мигрира общата база в секундите, в които стартирането тече, СЛЕД
   проверката при отварянето. v2.4.18 хващаше точно този случай (проверката беше
   в runMigrations), v2.4.19 — не. Пазачът трябва да е на ДВЕТЕ места.

   Всеки тест е проверен с мутация. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fx = require('./helpers/audit-fixtures');

const APP_DIR = fx.APP_DIR;
test.after(fx.cleanupTmpDirs);

function startAgainstDb(userVersion, mode) {
  const out = execFileSync(process.execPath,
    [path.join(__dirname, 'helpers', 'newer-schema-worker.js'), String(userVersion)].concat(mode ? [mode] : []),
    { encoding: 'utf8', timeout: 60000 });
  return JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).pop());
}

/* ==================================================================
   1. ПАЗАЧЪТ НАПРЕД — и при надпревара по време на самото стартиране
   ================================================================== */
test('база, обновена ПО ВРЕМЕ на стартирането, пак се отказва', () => {
  /* Режим 'race' на worker-а: базата тръгва с познатата версия (проверката при
     отварянето минава), а докато initDb() тече, втора връзка я вдига до 99 —
     точно каквото прави другото, вече обновено работно място в деня на
     обновяването. Преди тази поправка: exitCode 0, нула диалози, ПЪЛНА работна
     сесия срещу по-новата база — записваща стари формати (напр. sum = 0 като
     „непопълнено“) в схема, която ги чете другояче. */
  const r = startAgainstDb(99, 'race');
  assert.equal(r.exitCode, 1, 'стартирането спира и при късно установено разминаване');
  assert.equal(r.dialogs.length, 1);
  assert.match(r.dialogs[0].title, /по-стар от базата данни/);
  /* За този път твърдението „не е записала нищо“ НЕ ни се полага — сервизната
     част на стартирането вече е минала. Диалогът казва само каквото е вярно. */
  assert.match(r.dialogs[0].content, /точно докато тази програма стартираше/);
  assert.ok(!/не е записала нищо в нея/.test(r.dialogs[0].content),
    'късният отказ не обещава недокосната база');
  assert.equal(r.sumAfter, 0, 'миграция 11 не е пипнала данните');
});

/* ==================================================================
   2. ДИАЛОГЪТ — казва dbFolder само когато dbFolder съществува
   ================================================================== */
test('при споделена (мрежова) папка диалогът сочи изхода през dbFolder', () => {
  const r = startAgainstDb(99, 'network');
  assert.equal(r.exitCode, 1);
  assert.equal(r.untouched, true, 'и на мрежовата папка базата остава непокътната');
  const c = r.dialogs[0].content;
  assert.match(c, /обща[\s\S]*мрежова папка/);
  assert.match(c, /dbFolder/);
  assert.match(c, /config\.json/);
  assert.match(c, /СОБСТВЕНА база/);
});

test('при чисто локална база диалогът не съчинява мрежова папка', () => {
  /* Дефект в поправката от v2.4.19: абзацът с изхода се печаташе БЕЗУСЛОВНО —
     включително „базата е обща (мрежова папка)“ и „изтрийте реда dbFolder“ за
     инсталация, при която ред dbFolder в config.json изобщо няма (пуснат
     по-стар инсталатор върху локално мигрирани данни). Невярна инструкция върху
     екрана, чийто смисъл е точното упътване. */
  const r = startAgainstDb(99);
  assert.equal(r.exitCode, 1);
  const c = r.dialogs[0].content;
  assert.ok(!/dbFolder/.test(c), 'няма съвет за ред, който не съществува');
  assert.ok(!/мрежова папка/.test(c), 'няма твърдение, че базата е обща');
  assert.match(c, /не е записала нищо в нея/, 'верните твърдения остават');
  assert.match(c, /Обновете InvLib/);
});

/* ==================================================================
   3. „STALE“ — без обещание, което отключването не винаги изпълнява
   ================================================================== */
test('състоянието „stale“ настъпва и при повредена партида, където отключването отказва', () => {
  /* Основанието за смекчения текст: PDP_STALE се вдига, щом НИТО ЕДИН опитан ред
     не се разчете — а това е подписът и на „паролата е сменена другаде“ (данните
     са здрави), и на „единствените криптирани редове са повредени“ (не са).
     Тук — вторият случай: паролата НИКОГА не е сменяна, но единственият
     криптиран ред е с чужд ключ. Отключването с ВЯРНАТА парола отказва — тоест
     обещание „Данните са запазени — отключете наново“ би било невярно върху
     подписан документ. */
  const { db, ipcMain, ret, pii } = fx.pdpSetup('inv-v2420-stale-');
  const foreign = pii.deriveKey('чужд-ключ-999', pii.generateSalt(2));
  db.prepare('INSERT INTO readers (name, egn) VALUES (?, ?)')
    .run('Повреден', pii.encryptField('7501010001', foreign));
  ret.maskReaderRows(db.prepare('SELECT * FROM readers').all()); // → PDP_STALE
  const rows = ret.maskReaderRows(db.prepare('SELECT * FROM readers').all());
  assert.equal(rows[0].pii_masked_reason, 'stale');
  ipcMain.invoke('pdp:lock');
  const unlock = ipcMain.invoke('pdp:unlock', 'редовна-парола-11');
  assert.equal(unlock.ok, false, 'отключването с вярната парола отказва при изцяло нечетима партида');
  assert.match(unlock.error, /криптирани с ДРУГ ключ/);
});

test('картонът при „stale“ съветва първо отключване и не обещава запазени данни', async () => {
  const dom = fx.buildDom({
    'readers.get': {
      id: 7, name: 'Читател', card_no: 'K-11', egn: 'Защитени данни (ключът не съвпада)',
      pii_masked: true, pii_masked_fields: ['egn'], pii_masked_reason: 'stale',
      registered_at: '2026-01-01'
    },
    'loans.byReader': []
  });
  const { window } = dom;
  await fx.settle();
  await window.printReaderCard(7);
  await fx.settle();
  const t = fx.printed(window);
  assert.match(t, /отключете защитата наново/, 'първата стъпка е отключване — тя връща здравите данни');
  assert.match(t, /само ако и отключването откаже/, 'въвеждането наново е чак втора стъпка');
  assert.ok(!/Данните са запазени/.test(t),
    'без обещание, което повредената партида прави невярно');
  assert.ok(!/Защитени данни/.test(t), 'вътрешният надпис не отива на подписван документ');
});
