'use strict';
/* Анонимно отчитане на инсталациите (v2.4.56) — заковаване на ОБЕЩАНИЯТА.
   =====================================================================
   Този механизъм изпраща нещо навън от компютъра на библиотеката. Точно
   затова тестовете тук пазят не „работи ли“, а ГРАНИЦИТЕ му:

     1. какво излиза — ТОЧНО три полета и нито едно повече (ако някой ден
        някой добави „име на библиотеката“ или „път до базата“, тестът пада);
     2. че идентификаторът е един и същ завинаги — при повторно стартиране
        И при обновяване на версията;
     3. че при липса на интернет НИЩО не се чупи и стартирането не спира;
     4. че вграденият адрес е точно уговореният, по https, и че празен
        адрес изключва всичко.

   Модулът е нарочно написан без Electron вътре — всички зависимости се
   подават отвън, затова целият ход се проверява тук, без да се вдига
   приложение. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../install-report');

const URL_OK = 'https://example.org/api/invlib/install';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inv-install-report-'));
}
const dirs = [];
function freshDir() { const d = tmpDir(); dirs.push(d); return d; }
test.after(() => dirs.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }));

/* Уловител на заявки: записва всяко извикване и отговаря по сценарий. */
function recorder(behaviour = { ok: true, status: 200 }) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    if (typeof behaviour === 'function') return behaviour(url, opts);
    if (behaviour instanceof Error) throw behaviour;
    return behaviour;
  };
  return { calls, fetchFn };
}

let uuidSeq = 0;
function deps(over = {}) {
  return Object.assign({
    fs, path,
    userDataDir: freshDir(),
    version: '2.4.56',
    platform: 'win32',
    release: '10.0.22631',
    randomUUID: () => 'uuid-' + (++uuidSeq),
    now: () => Date.parse('2026-09-12T08:00:00Z'),
    url: URL_OK,
    log: () => {}
  }, over);
}

/* ==================================================================
   1. Какво излиза от компютъра на библиотеката
   ================================================================== */

test('payload-то съдържа ТОЧНО три полета — нито едно лично данно не може да се промъкне', async () => {
  const { calls, fetchFn } = recorder();
  const d = deps({ fetch: fetchFn });
  assert.equal(await R.reportInstall(d), 'registered');
  assert.equal(calls.length, 1);
  /* Точно този списък, в точно този вид. Всяко ново поле — включително
     наглед безобидно като „име на компютъра“ — ще счупи теста. */
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['installationId', 'os', 'version']);
  assert.equal(calls[0].body.version, '2.4.56');
  assert.equal(calls[0].body.os, 'Windows 11');
  assert.match(calls[0].body.installationId, /^uuid-\d+$/);
});

test('заявката е POST по https, с кратък таван на времето и без бисквитки', async () => {
  const { calls, fetchFn } = recorder();
  await R.reportInstall(deps({ fetch: fetchFn }));
  assert.equal(calls[0].url, URL_OK);
  assert.equal(calls[0].opts.method, 'POST');
  assert.ok(calls[0].opts.signal, 'без AbortSignal заявката може да виси безкрайно при мъртво прокси');
  assert.ok(R.REQUEST_TIMEOUT_MS <= 5000, 'таванът трябва да е кратък: никой не чака този отговор');
  /* Бисквитките са вторият начин да се получи постоянен белег: Set-Cookie от
     сървъра би преживял дори подмяна на installationId. */
  assert.equal(calls[0].opts.credentials, 'omit', 'без бисквитки и удостоверяване');
  /* И ЗАГЛАВКИТЕ са част от това, което излиза. Само Content-Type — иначе
     „X-Library: НЧ Яворец“ би минало покрай теста за тялото. */
  assert.deepEqual(Object.keys(calls[0].opts.headers), ['Content-Type']);
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
});

test('таванът на времето наистина прекъсва вяла заявка', async () => {
  /* Не само че AbortSignal се подава, а че реално стреля: мъртво прокси,
     което приема връзката и мълчи, е по-честият случай от „няма мрежа“. */
  const hang = (url, opts) => new Promise((_res, rej) => {
    opts.signal.addEventListener('abort', () => rej(new Error('AbortError')));
  });
  /* Таймерът на AbortSignal.timeout е unref-нат: ако нищо друго не държи
     event loop-а, Node приключва, преди сигналът да гръмне, и тестът виси.
     Затова тук се държи буден изрично. */
  const keepalive = setTimeout(() => {}, 3000);
  const t = Date.now();
  const code = await R.reportInstall(deps({ fetch: hang, timeoutMs: 150 }));
  clearTimeout(keepalive);
  assert.equal(code, 'failed');
  assert.ok(Date.now() - t < 1500, 'прекъсването трябва да стане по таймера, не да виси');
});

test('идентификаторът НЕ се смята от нищо на машината — два съседни са различни', () => {
  /* Криптографски случаен значи и непредвидим: същите вход-данни (една и
     съща машина, една и съща версия) при нова инсталация дават друг номер.
     Ако някой замени randomUUID с хардуерен отпечатък, това пада. */
  const a = R.ensureInstallation({ fs, file: path.join(freshDir(), 'i.json'), randomUUID: require('crypto').randomUUID, now: Date.now });
  const b = R.ensureInstallation({ fs, file: path.join(freshDir(), 'i.json'), randomUUID: require('crypto').randomUUID, now: Date.now });
  assert.notEqual(a.state.installationId, b.state.installationId);
  assert.match(a.state.installationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

/* ==================================================================
   2. Един и същ идентификатор завинаги
   ================================================================== */

test('повторното стартиране НЕ създава нов Installation ID', async () => {
  const userDataDir = freshDir();
  const { calls, fetchFn } = recorder();
  const t0 = Date.parse('2026-09-12T08:00:00Z');

  assert.equal(await R.reportInstall(deps({ userDataDir, fetch: fetchFn, now: () => t0 })), 'registered');
  // Второ стартиране след три дни — същата машина, същият файл.
  const t1 = t0 + 3 * 24 * 3600 * 1000;
  assert.equal(await R.reportInstall(deps({ userDataDir, fetch: fetchFn, now: () => t1 })), 'sent');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.installationId, calls[1].body.installationId,
    'вторият старт трябва да ползва ЗАПИСАНИЯ идентификатор, не нов');
});

test('обновяването на версията НЕ създава нов Installation ID (но се отчита)', async () => {
  const userDataDir = freshDir();
  const { calls, fetchFn } = recorder();
  const t0 = Date.parse('2026-09-12T08:00:00Z');

  await R.reportInstall(deps({ userDataDir, fetch: fetchFn, now: () => t0, version: '2.4.56' }));
  /* Веднага след обновяването, в рамките на същия час: 24-те часа НЕ са
     минали, но версията е друга — това е самостоятелна причина за отчитане,
     иначе новата версия би се появила в статистиката чак на другия ден. */
  const t1 = t0 + 60 * 1000;
  assert.equal(await R.reportInstall(deps({ userDataDir, fetch: fetchFn, now: () => t1, version: '2.4.57' })), 'sent');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.installationId, calls[1].body.installationId,
    'обновяването сменя версията, не инсталацията');
  assert.equal(calls[1].body.version, '2.4.57');
});

test('идентификаторът оцелява и когато файлът е пипан отвън (запис настрани → преименуване)', () => {
  const dir = freshDir();
  const file = path.join(dir, R.STATE_FILE);
  const first = R.ensureInstallation({ fs, file, randomUUID: () => 'ID-1', now: () => 0 });
  assert.equal(first.created, true);
  const again = R.ensureInstallation({ fs, file, randomUUID: () => 'ID-2', now: () => 0 });
  assert.equal(again.created, false);
  assert.equal(again.state.installationId, 'ID-1', 'съществуващият файл не се пренаписва');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).installationId, 'ID-1');
  assert.ok(!fs.existsSync(file + '.tmp'), 'временният файл не бива да остава');
});

test('повреден файл със състоянието не спира програмата — просто започва отначало', () => {
  const dir = freshDir();
  const file = path.join(dir, R.STATE_FILE);
  fs.writeFileSync(file, '{ това не е JSON', 'utf8');
  const r = R.ensureInstallation({ fs, file, randomUUID: () => 'ID-нов', now: () => 0 });
  assert.equal(r.state.installationId, 'ID-нов');
  assert.equal(R.readState(fs, path.join(dir, 'няма-такъв.json')).status, 'missing');
});

test('ЗАКЛЮЧЕН файл (антивирусна програма) НЕ поражда нов идентификатор', async () => {
  /* Точно този провал е причината модулът да не пипа config.json — и първата
     версия тук го повтаряше: EBUSY се четеше като „няма такъв файл“, номерът
     се създаваше наново и се ЗАПИСВАШЕ върху здравия, тоест едно читалище се
     броеше за две инсталации при всяко улучване на момента от антивирусната
     програма. Възпроизведено с подменен readFileSync. */
  const dir = freshDir();
  const file = path.join(dir, R.STATE_FILE);
  R.ensureInstallation({ fs, file, randomUUID: () => 'ОРИГИНАЛЕН', now: () => 0 });

  const busy = Object.assign({}, fs, {
    readFileSync: (p, e) => {
      if (String(p).endsWith(R.STATE_FILE)) { const err = new Error('EBUSY'); err.code = 'EBUSY'; throw err; }
      return fs.readFileSync(p, e);
    }
  });
  assert.equal(R.readState(busy, file).status, 'unreadable', 'заключен ≠ липсващ');
  const r = R.ensureInstallation({ fs: busy, file, randomUUID: () => 'НОВ', now: () => 0 });
  assert.equal(r.state, null, 'при нечетим файл не се създава нищо');
  assert.equal(r.reason, 'unreadable');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).installationId, 'ОРИГИНАЛЕН',
    'здравият файл на диска трябва да остане непокътнат');

  const { calls, fetchFn } = recorder();
  const code = await R.reportInstall(deps({ userDataDir: dir, fs: busy, fetch: fetchFn }));
  assert.equal(code, 'unreadable');
  assert.equal(calls.length, 0, 'по-добре нула, отколкото погрешно втора инсталация');
});

test('папка без право на запис — НЕ се праща различен номер при всяко пускане', async () => {
  /* Без този отказ програмата щеше да тегли нов номер при всяко пускане и да
     го праща: един компютър щеше да се брои като десетки. */
  const dir = freshDir();
  const roFs = Object.assign({}, fs, {
    writeFileSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
  });
  const { calls, fetchFn } = recorder();
  const code = await R.reportInstall(deps({ userDataDir: dir, fs: roFs, fetch: fetchFn }));
  assert.equal(code, 'unwritable');
  assert.equal(calls.length, 0);
});

test('неуспешно преименуване не оставя .tmp файл да лежи завинаги', () => {
  const dir = freshDir();
  const file = path.join(dir, R.STATE_FILE);
  const badRename = Object.assign({}, fs, {
    renameSync: () => { throw new Error('EPERM'); }
  });
  assert.equal(R.writeState(badRename, file, { installationId: 'x' }), false);
  assert.ok(!fs.existsSync(file + '.tmp'), 'временният файл трябва да се почисти');
});

test('след неуспял опит не се опитва пак при всяко пускане', async () => {
  const userDataDir = freshDir();
  const t0 = Date.parse('2026-09-12T08:00:00Z');
  const offline = async () => { throw new Error('ENOTFOUND'); };
  assert.equal(await R.reportInstall(deps({ userDataDir, fetch: offline, now: () => t0 })), 'failed');

  /* Библиотека без интернет иначе прави по един четирисекунден опит и по ред
     в дневника при ВСЯКО пускане, а програмата се пуска по няколко пъти на ден. */
  const { calls, fetchFn } = recorder();
  assert.equal(await R.reportInstall(deps({ userDataDir, fetch: fetchFn, now: () => t0 + 5 * 60 * 1000 })), 'skipped');
  assert.equal(calls.length, 0);
  // …но след час опитва пак.
  assert.equal(await R.reportInstall(deps({ userDataDir, fetch: fetchFn, now: () => t0 + 61 * 60 * 1000 })), 'registered');
  assert.equal(calls.length, 1);
});

/* ==================================================================
   3. Без интернет — програмата не забелязва
   ================================================================== */

test('липсата на интернет НЕ хвърля навън и НЕ записва отчитане', async () => {
  const userDataDir = freshDir();
  const offline = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); };
  const logged = [];
  const code = await R.reportInstall(deps({
    userDataDir, fetch: offline, log: (lvl, msg) => logged.push([lvl, msg])
  }));
  assert.equal(code, 'failed', 'провалът е КОД, не изключение — иначе би стигнал до стартирането');
  assert.equal(logged[0][0], 'warn', 'липсата на интернет не е грешка на програмата: warn, не error');

  /* Същественото: опитът се ПОВТАРЯ (след почивката от час, виж теста за
     изчакването), защото нищо не е записано като „отчетено“. Инсталация без
     интернет в първия ден не бива да остане непреброена завинаги. */
  const state = R.readState(fs, path.join(userDataDir, R.STATE_FILE)).state;
  assert.equal(state.lastReportAt, null, 'неуспелият опит НЕ се брои за отчитане');
  assert.ok(state.lastAttemptAt, 'но самият опит се отбелязва, за да не се повтаря веднага');
  const { calls, fetchFn } = recorder();
  const later = Date.parse('2026-09-12T08:00:00Z') + 2 * 3600 * 1000;
  assert.equal(await R.reportInstall(deps({ userDataDir, fetch: fetchFn, now: () => later })), 'registered');
  assert.equal(calls[0].body.installationId, state.installationId, 'и то със същия идентификатор');
});

test('сървърна грешка (500) също не чупи нищо и не се брои за отчитане', async () => {
  const userDataDir = freshDir();
  const code = await R.reportInstall(deps({ userDataDir, fetch: async () => ({ ok: false, status: 500 }) }));
  assert.equal(code, 'failed');
  assert.equal(R.readState(fs, path.join(userDataDir, R.STATE_FILE)).state.lastReportAt, null);
});

test('среда без net.fetch (стар Electron, тестове) — тих отказ, без изключение', async () => {
  const userDataDir = freshDir();
  assert.equal(await R.reportInstall(deps({ userDataDir, fetch: undefined })), 'no-net');
  assert.ok(!fs.existsSync(path.join(userDataDir, R.STATE_FILE)),
    'без възможност за изпращане не се създава дори файл');
});

/* ==================================================================
   4. Изключено по подразбиране и по желание
   ================================================================== */

test('вграденият адрес е https и е точно този, който е уговорен', () => {
  /* Адресът е на едно място и се пипа от човек — затова се проверява, вместо
     да се вярва. Печатна грешка тук значи брояч, който мълчи завинаги, без
     нищо да се счупи видимо. */
  assert.equal(R.REPORT_URL, 'https://invlib.com/api/invlib/install');
  assert.equal(R.isUsableUrl(R.REPORT_URL), true);
});

test('празен адрес изключва всичко — нито заявка, нито файл', async () => {
  /* Изходът „изключи от кода“ трябва да остане работещ: това беше видът на
     v2.4.56 до момента, в който адресът беше даден. */
  const userDataDir = freshDir();
  const { calls, fetchFn } = recorder();
  assert.equal(await R.reportInstall(deps({ userDataDir, fetch: fetchFn, url: '' })), 'disabled');
  assert.equal(calls.length, 0);
  assert.equal(fs.readdirSync(userDataDir).length, 0, 'нищо не се пише на диска');
});

test('изключването от config.json спира всичко', async () => {
  const { calls, fetchFn } = recorder();
  assert.equal(await R.reportInstall(deps({ fetch: fetchFn, enabled: false })), 'disabled');
  assert.equal(calls.length, 0);
});

test('само https — обикновен http, празно и глупости се отказват', () => {
  assert.equal(R.isUsableUrl(URL_OK), true);
  assert.equal(R.isUsableUrl('http://example.org/api'), false, 'през чужди мрежи — само шифровано');
  assert.equal(R.isUsableUrl(''), false);
  assert.equal(R.isUsableUrl('не е адрес'), false);
  assert.equal(R.isUsableUrl(undefined), false);
});

/* ==================================================================
   5. Веднъж на 24 часа, не при всяко действие
   ================================================================== */

test('в рамките на 24 часа при същата версия втора заявка НЯМА', async () => {
  const userDataDir = freshDir();
  const { calls, fetchFn } = recorder();
  const t0 = Date.parse('2026-09-12T08:00:00Z');
  await R.reportInstall(deps({ userDataDir, fetch: fetchFn, now: () => t0 }));
  const code = await R.reportInstall(deps({ userDataDir, fetch: fetchFn, now: () => t0 + 23 * 3600 * 1000 }));
  assert.equal(code, 'skipped');
  assert.equal(calls.length, 1, 'програмата се стартира по няколко пъти на ден — това не е брояч на стартирания');
});

test('точно на 24-я час се отчита пак (границата е включително)', async () => {
  const state = { installationId: 'x', lastReportAt: '2026-09-12T08:00:00.000Z', lastVersion: '2.4.56' };
  const t = Date.parse('2026-09-13T08:00:00.000Z');
  assert.equal(R.shouldReport(state, '2.4.56', t - 1), false, 'секунда преди денонощието — още не');
  assert.equal(R.shouldReport(state, '2.4.56', t), true, 'точно на границата — да');
});

test('върнат назад часовник не замълчава отчитането завинаги', () => {
  /* Без Math.abs една дата, върната назад с месец (обичайно при сменена
     батерия на дънната платка), правеше разликата отрицателна и отчитането
     спираше, докато часовникът настигне записаното. */
  const state = { installationId: 'x', lastReportAt: '2026-09-12T08:00:00.000Z', lastVersion: '2.4.56' };
  const monthEarlier = Date.parse('2026-08-12T08:00:00.000Z');
  assert.equal(R.shouldReport(state, '2.4.56', monthEarlier), true);
});

test('никога неотчитана инсталация се отчита независимо от часа', () => {
  assert.equal(R.shouldReport(null, '2.4.56', Date.now()), true);
  assert.equal(R.shouldReport({ installationId: 'x', lastReportAt: null }, '2.4.56', Date.now()), true);
  assert.equal(R.shouldReport({ installationId: 'x', lastReportAt: 'боклук', lastVersion: '2.4.56' }, '2.4.56', Date.now()), true);
});

/* ==================================================================
   6. Етикетът на операционната система е ГРУБ нарочно
   ================================================================== */

test('етикетът на ОС не носи номер на компилация — той стеснява кръга до шепа машини', () => {
  assert.equal(R.osLabel('win32', '10.0.22631'), 'Windows 11');
  assert.equal(R.osLabel('win32', '10.0.19045'), 'Windows 10');
  assert.equal(R.osLabel('win32', '10.0.22000'), 'Windows 11', 'границата между 10 и 11 е компилация 22000');
  assert.equal(R.osLabel('win32', '10.0.21999'), 'Windows 10');
  assert.equal(R.osLabel('win32', '6.1.7601'), 'Windows 7');
  assert.equal(R.osLabel('win32', ''), 'Windows');
  assert.equal(R.osLabel('linux', '6.1.0'), 'Linux');
  assert.equal(R.osLabel('darwin', '23.0.0'), 'macOS');
  for (const [p, r] of [['win32', '10.0.22631'], ['linux', '6.1.0'], ['darwin', '23.0.0']]) {
    assert.doesNotMatch(R.osLabel(p, r), /\d{4,}/, 'никъде не бива да излиза номер на компилация: ' + p);
  }
});

/* ==================================================================
   7. Свързването в main.js
   ================================================================== */

test('main.js вика отчитането само в инсталираната програма и без да го чака', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = MAIN.slice(MAIN.indexOf('function initInstallReport'), MAIN.indexOf('let mainWindow;'));
  assert.match(fn, /if \(!app\.isPackaged\) return;/,
    'без този пазач броячът щеше да отчита разработката и тестовете като библиотеки');
  assert.doesNotMatch(fn, /await /, 'стартирането не бива да чака мрежата');
  assert.match(fn, /\.catch\(/, 'дори кодът за грешка не бива да излиза навън');
  /* И СИНХРОННАТА част трябва да е обвита. Докато install-report.js липсваше
     в build.files, require() хвърляше само в ИНСТАЛИРАНАТА програма, грешката
     влизаше в общия .catch на whenReady и вместо отчитане показваше
     „Стартирането пропадна“ — тоест броячът на инсталации спираше програмата
     на всяка библиотека. Пазачът е тук, за да не може това да се повтори. */
  assert.match(fn, /try \{\s*initInstallReportUnsafe\(\);\s*\} catch/,
    'цялото тяло, включително require(), трябва да е в try/catch');
  assert.match(fn, /readConfig\(\)\.installReporting !== false/, 'изключване от config.json');
  /* Извиква се СЛЕД createWindow(): прозорецът не бива да чака мрежа.
     Краят на блока се търси СЛЕД началото му — в main.js има и по-ранни
     `}).catch(`, а търсене от нулата дава празно парче и тест, който само
     изглежда, че проверява нещо. */
  const readyAt = MAIN.indexOf('app.whenReady().then');
  const ready = MAIN.slice(readyAt, MAIN.indexOf('}).catch(', readyAt));
  assert.ok(ready.includes('initInstallReport();'), 'отчитането трябва да е вътре в whenReady');
  assert.ok(ready.indexOf('mainWindow = createWindow();') < ready.indexOf('initInstallReport();'),
    'прозорецът се създава преди отчитането');
});

test('нищо от базата данни не се доближава до отчитането', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'install-report.js'), 'utf8');
  for (const forbidden of ['getDb', 'better-sqlite3', 'readers', 'books', 'loans', 'egn', 'email']) {
    assert.doesNotMatch(SRC, new RegExp('\\b' + forbidden + '\\b', 'i'),
      'модулът не бива дори да споменава „' + forbidden + '“');
  }
});
