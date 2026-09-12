'use strict';
/* Анонимно отчитане на инсталациите (v2.4.56)
 * =====================================================================
 * ЗАЩО СЪЩЕСТВУВА: досега нямаше никакъв начин да се разбере на колко
 * компютъра реално работи програмата и коя версия ползват. Броячът на
 * изтеглянията в GitHub брои ИЗТЕГЛЯНИЯ, не инсталации — едно и също
 * читалище, което тегли инсталатора на три работни места и веднъж пак
 * след антивирусна тревога, се брои четири пъти, а библиотека, която е
 * получила файла на флашка, не се брои изобщо. Без това число не може
 * да се прецени нито кои версии още се ползват (тоест докога има смисъл
 * да се пази съвместимост), нито дали обновяването изобщо стига дотам.
 *
 * КАКВО СЕ ИЗПРАЩА — това е целият списък, няма друго:
 *     { installationId, version, os }
 *   • installationId — случаен UUID, изтеглен от криптографски генератор
 *     (crypto.randomUUID), създаден веднъж при първото пускане и записан
 *     в потребителската папка. НЕ е производен на нищо: не се смята от
 *     MAC адрес, сериен номер на диска, име на компютър или потребител.
 *     Обратен път от него към конкретна библиотека няма.
 *   • version — версията на програмата (app.getVersion()).
 *   • os — ГРУБ етикет на операционната система („Windows 11“). Не се
 *     изпраща точният номер на компилацията, защото той стеснява кръга.
 *
 * КАКВО НЕ СЕ ИЗПРАЩА, никога и при никакви обстоятелства: име на
 * потребител или на компютър, имейл, IP адрес (той не е в тялото на
 * заявката; сървърът вижда само адреса на връзката — виж бележката за
 * сървъра в docs/ARCHITECTURE.md), MAC адрес, сериен номер на диска,
 * какъвто и да е хардуерен отпечатък, име на библиотеката, пътища по
 * диска, и НИТО ЕДИН ред от базата данни — нито книга, нито читател,
 * нито заемане. Тестът `payload-то съдържа ТОЧНО три полета` заковава
 * това: всяко ново поле в тялото на заявката ще счупи теста, вместо да
 * се промъкне незабелязано.
 *
 * ЗАЩО ОТДЕЛЕН ФАЙЛ, а не config.json: config.json носи пътя до базата
 * данни на библиотеката (dbFolder). Историята му е описана в main.js —
 * един-единствен неуспешен прочит на този файл вече е изтривал пътя и е
 * отварял празна база на следващата сутрин. Отчитането на инсталации е
 * удобство за автора, а не условие за работа, и няма причина да пипа
 * точно този файл. Пази се в СОБСТВЕН файл (installation.json), който
 * може да бъде изтрит, повреден или заключен, без това да засегне
 * каквото и да е от работата на библиотеката.
 *
 * ЗАЩО НЕ В БАЗАТА ДАННИ: базата често е на МРЕЖОВ дял, споделен между
 * няколко работни места (виж db-folder.js). Записан там, идентификаторът
 * щеше да е един за цялото читалище независимо от броя компютри, щеше да
 * се пренася с резервните копия и щеше да „възкръсва“ при възстановяване
 * на копие върху друга машина.
 *
 * Точната мярка е „една инсталация = един потребителски профил на Windows“,
 * не „един компютър“: потребителската папка е на профила. Това съвпада с
 * начина, по който програмата се инсталира (nsis, perMachine: false — всеки
 * профил има собствено копие), затова е и правилната мярка тук. Компютър, на
 * който двама библиотекари влизат с различни профили, ще се брои като две
 * инсталации — и това е вярно, там наистина има две инсталации.
 *
 * КОГА СЕ ИЗПРАЩА: при първо пускане, при смяна на версията и после най-
 * много веднъж на 24 часа — не при действия на потребителя. Заявката се
 * пуска СЛЕД като прозорецът вече е създаден, не се чака за нищо и няма
 * никакъв видим ефект: при липса на интернет, при прокси, при 500 от
 * сървъра или при изключено отчитане програмата продължава, все едно
 * модулът не съществува. Единствената следа е ред в дневника.
 *
 * ЗАЩО net.fetch, а не https на Node: същото съображение, както при
 * търсенето по ISBN (handlers/isbn-lookup.js) — net.fetch минава през
 * мрежовия стек на Chromium и затова ползва СИСТЕМНИТЕ настройки за
 * прокси. Читалищните и общинските мрежи често излизат навън само през
 * прокси; с модула на Node заявката просто би увисвала до изтичане на
 * времето при всеки старт.
 */

/* ---------------------------------------------------------------------
   ЕДИНСТВЕНОТО място, където се задава адресът на сървъра.
   ---------------------------------------------------------------------
   Смяна на адреса = смяна САМО на този ред. Изисква се https:// —
   обикновен http се отказва (виж isUsableUrl), защото заявката пътува през
   чужди мрежи.

   Празен низ изключва отчитането НАПЪЛНО: не се прави нито заявка, нито
   дори файл с идентификатор. Така изглеждаше v2.4.56 до момента, в който
   адресът беше даден — и така остава изходът, ако някога трябва да се
   изключи от кода, вместо от config.json на всяка машина. */
const REPORT_URL = 'https://invlib.com/api/invlib/install';

/* Веднъж на 24 часа — „последна активност“, не брояч на стартирания. */
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/* Кратко изчакване: заявката е странична, а не част от стартирането.
   Осем секунди (както при ISBN) тук са много — там човек чака отговор на
   екрана, тук никой не чака нищо. */
const REQUEST_TIMEOUT_MS = 4000;
/* Пауза след НЕУСПЯЛ опит, за да не се опитва при всяко пускане. */
const RETRY_AFTER_FAIL_MS = 60 * 60 * 1000;
/* Файлът с идентификатора — в потребителската папка, до config.json. */
const STATE_FILE = 'installation.json';

/* Груб етикет на операционната система. Нарочно е ГРУБ: „Windows 11“, а не
   „10.0.22631.4317“ — точният номер на компилацията стеснява кръга до шепа
   машини, а за преценка „още ли се ползва Windows 10“ не носи нищо повече.
   Windows 11 се различава от 10 само по номера на компилацията (и двете са
   NT 10.0); границата е 22000. */
function osLabel(platform, release) {
  const rel = String(release || '');
  if (platform === 'win32') {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(rel);
    if (!m) return 'Windows';
    const major = Number(m[1]), minor = Number(m[2]), build = Number(m[3] || 0);
    if (major === 10) return build >= 22000 ? 'Windows 11' : 'Windows 10';
    if (major === 6 && minor === 3) return 'Windows 8.1';
    if (major === 6 && minor === 2) return 'Windows 8';
    if (major === 6 && minor === 1) return 'Windows 7';
    return 'Windows';
  }
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return 'Друга';
}

/* Адресът се пипа рядко и от човек — затова се проверява, вместо да се
   вярва. Само https: заявката пътува през чужди мрежи, а и по-важното:
   празният низ по подразбиране не бива да се превърне в заявка към нищото. */
function isUsableUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try { return new URL(url).protocol === 'https:'; } catch (e) { return false; }
}

/* ЛИПСВА и НЕ СЕ ЧЕТЕ са различни неща — и точно тази разлика е причината
   този модул изобщо да съществува отделно от config.json.

   Първата версия тук връщаше null и за двете. Резултатът: файл, заключен за
   миг от антивирусна програма (под Windows това е ежедневие — виж коментара
   при readConfig в main.js, където същото веднъж изтри пътя до базата), се
   четеше като „няма такъв файл“, идентификаторът се създаваше наново и се
   ЗАПИСВАШЕ върху здравия. Тоест едно читалище се брои за две инсталации, и
   то толкова пъти, колкото пъти антивирусната програма улучи момента.
   Възпроизведено с подменен readFileSync, който хвърля EBUSY.

   Затова: 'missing' значи „наистина първо пускане, създай“, 'unreadable'
   значи „не пипай нищо“. */
function readState(fsMod, file) {
  let raw;
  try {
    if (!fsMod.existsSync(file)) return { status: 'missing', state: null };
    raw = fsMod.readFileSync(file, 'utf8');
  } catch (e) {
    return { status: 'unreadable', state: null, error: e };
  }
  try {
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { status: 'missing', state: null };
    if (typeof cfg.installationId !== 'string' || !cfg.installationId) return { status: 'missing', state: null };
    return { status: 'ok', state: cfg };
  } catch (e) {
    /* Прочетен, но повреден (пресечен при спиране на тока). Тук наистина няма
       какво да се пази — започва се начисто. */
    return { status: 'missing', state: null };
  }
}

/* Пише настрани и преименува — същият подход, както при config.json: при
   спиране на тока насред записа не бива да остане пресечен файл, защото
   пресеченият файл значи нов идентификатор на следващото пускане. */
function writeState(fsMod, file, state) {
  const tmp = file + '.tmp';
  try {
    fsMod.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fsMod.renameSync(tmp, file);
    return true;
  } catch (e) {
    /* Без това почистване неуспешното преименуване оставя installation.json.tmp
       да лежи в папката завинаги. */
    try { if (fsMod.existsSync(tmp)) fsMod.unlinkSync(tmp); } catch (e2) { /* и толкова */ }
    return false;
  }
}

/* Връща състоянието, създавайки го при първо пускане. Идентификаторът се
   създава ТОЧНО веднъж: при всяко следващо пускане се чете отвътре и не се
   пипа — нито при смяна на версията, нито при отчитане.

   Два изхода, при които НЕ се отчита нищо (и двата връщат state: null):
     • 'unreadable' — файлът съществува, но не се чете сега. Мълчи се и се
       чака следващото пускане; в никакъв случай не се създава нов номер.
     • 'unwritable' — новият номер не можа да се запише (папка без права,
       пълен диск). Без запис всяко пускане би пращало РАЗЛИЧЕН номер и
       броячът щеше да отчита един компютър като десетки. По-добре нула. */
function ensureInstallation({ fs: fsMod, file, randomUUID, now }) {
  const read = readState(fsMod, file);
  if (read.status === 'ok') return { state: read.state, created: false, reason: null };
  if (read.status === 'unreadable') return { state: null, created: false, reason: 'unreadable' };
  const state = {
    installationId: randomUUID(),
    firstSeenAt: new Date(now()).toISOString(),
    lastReportAt: null,
    lastAttemptAt: null,
    lastVersion: null
  };
  if (!writeState(fsMod, file, state)) return { state: null, created: false, reason: 'unwritable' };
  return { state, created: true, reason: null };
}

/* Три причини за изпращане, и нито една друга:
     1) никога не е отчитана (първа регистрация);
     2) версията се е сменила (обновяване — за да е ясно коя се ползва);
     3) минали са 24 часа (последна активност).
   Math.abs пази от преместен назад часовник: при дата, върната назад с
   месец, разликата е отрицателна и без abs отчитането щеше да замлъкне,
   докато часовникът настигне записаното. */
function shouldReport(state, version, now, intervalMs = REPORT_INTERVAL_MS) {
  if (!state || !state.lastReportAt) return true;
  if (state.lastVersion !== version) return true;
  const last = Date.parse(state.lastReportAt);
  if (!Number.isFinite(last)) return true;
  return Math.abs(now - last) >= intervalMs;
}

/* Колко бързо се опитва пак СЛЕД НЕУСПЯЛ опит. Без това библиотека без
   интернет прави по един четирисекунден опит и по един ред в дневника при
   всяко пускане на програмата, завинаги. Час е достатъчно рядко, а за брояч
   с денонощна стъпка е и напълно достатъчно често.

   „Неуспял последен опит“ значи: има отбелязан опит, който е ПО-КЪСЕН от
   последното успешно отчитане (или изобщо няма успешно отчитане). */
function shouldRetry(state, now, retryMs = RETRY_AFTER_FAIL_MS) {
  if (!state || !state.lastAttemptAt) return true;
  const attempt = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(attempt)) return true;
  const reported = state.lastReportAt ? Date.parse(state.lastReportAt) : -Infinity;
  if (Number.isFinite(reported) && reported >= attempt) return true;   // последният опит е успял
  return Math.abs(now - attempt) >= retryMs;
}

/* Тялото на заявката. Отделна функция, за да може тестът да я провери сама
   за себе си — и да падне, ако някой ден в нея се появи четвърто поле. */
function buildPayload(installationId, version, os) {
  return { installationId, version, os };
}

/* Пълният ход, без изключения навън. Връща КОД за дневника, не хвърля:
     'disabled'  — няма адрес (по подразбиране) или е изключено от config
     'no-net'    — средата няма net.fetch (тестове, стар Electron)
     'skipped'   — още не е дошло време (по-малко от 24 ч, същата версия)
     'registered'— първо успешно отчитане на тази инсталация
     'sent'      — последваща активност, сървърът отговори успешно
     'failed'    — няма връзка, прокси, таймаут, 4xx/5xx: НЕ се записва
                   нов lastReportAt, за да се опита пак (след час)
     'unreadable'— файлът с номера съществува, но не се чете сега (заключен
                   от антивирусна програма): не се пипа НИЩО
     'unwritable'— номерът не можа да се запише: не се отчита, за да не се
                   праща различен номер при всяко пускане
   Нито един от тези изходи не спира и не забавя стартирането. */
async function reportInstall(deps) {
  const {
    fs: fsMod, path: pathMod, userDataDir, version, platform, release,
    randomUUID, fetch: fetchFn, now = () => Date.now(),
    url = REPORT_URL, enabled = true,
    intervalMs = REPORT_INTERVAL_MS, timeoutMs = REQUEST_TIMEOUT_MS,
    retryMs = RETRY_AFTER_FAIL_MS,
    log = () => {}
  } = deps;

  if (!enabled || !isUsableUrl(url)) return 'disabled';
  if (typeof fetchFn !== 'function') return 'no-net';

  const file = pathMod.join(userDataDir, STATE_FILE);
  const { state, reason } = ensureInstallation({ fs: fsMod, file, randomUUID, now });
  if (!state) {
    /* Виж ensureInstallation: и в двата случая мълчанието е по-доброто.
       Нечетим файл → нов номер върху здравия; незаписан номер → различен
       номер при всяко пускане. И двете развалят самото число, заради което
       механизмът съществува. */
    log('warn', 'Отчитане на инсталацията: пропуснато (' + reason + ')');
    return reason;
  }
  if (!shouldReport(state, version, now(), intervalMs)) return 'skipped';
  if (!shouldRetry(state, now(), retryMs)) return 'skipped';
  /* „Първа регистрация“ значи първо УСПЕШНО отчитане, а не първо създаване
     на файла: ако първият опит е бил без интернет, файлът вече съществува,
     но регистрацията още не е стигнала до сървъра. */
  const firstRegistration = !state.lastReportAt;

  const payload = buildPayload(state.installationId, version, osLabel(platform, release));
  /* Опитът се отбелязва ПРЕДИ заявката. Ако програмата бъде затворена, докато
     заявката виси, следващото пускане пак ще види отбелязан неуспешен опит и
     ще изчака час — вместо да опитва отново веднага. */
  state.lastAttemptAt = new Date(now()).toISOString();
  writeState(fsMod, file, state);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      /* Без бисквитки и без каквото и да е удостоверяване. Иначе отговор със
         Set-Cookie от сървъра би се превърнал в ВТОРИ, постоянен белег — при
         това такъв, който преживява подмяната на installationId, тоест точно
         обратното на обещаното в SECURITY.md. */
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res || !res.ok) {
      log('warn', 'Отчитане на инсталацията: сървърът отговори ' + (res ? res.status : '—'));
      return 'failed';
    }
  } catch (e) {
    /* Най-честият случай в читалище: няма интернет. Това НЕ е грешка на
       програмата и не бива да изглежда като такава — затова 'warn', не
       'error', и нищо на екрана. */
    log('warn', 'Отчитане на инсталацията: няма връзка (' + (e && e.message) + ')');
    return 'failed';
  }

  state.lastReportAt = new Date(now()).toISOString();
  state.lastVersion = version;
  writeState(fsMod, file, state);
  return firstRegistration ? 'registered' : 'sent';
}

module.exports = {
  REPORT_URL, REPORT_INTERVAL_MS, REQUEST_TIMEOUT_MS, RETRY_AFTER_FAIL_MS, STATE_FILE,
  osLabel, isUsableUrl, readState, writeState,
  ensureInstallation, shouldReport, shouldRetry, buildPayload, reportInstall
};
