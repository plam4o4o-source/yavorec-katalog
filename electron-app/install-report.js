'use strict';
/* Регистрация на инсталацията в invlib.com.
 *
 * Какво прави: веднъж на денонощие изпраща към сайта четири неща — анонимен
 * идентификатор на инсталацията, версията на програмата, операционната система
 * и (по подразбиране, от самия сървър) момента на обаждането. Целта е да се
 * знае колко библиотеки ползват коя версия. Нищо повече не се изпраща.
 *
 * Какво НЕ прави: не изпраща име, имейл, IP адрес, MAC адрес, отпечатък на
 * хардуера или местоположение, и нищо от библиотечния фонд или за читателите.
 * Идентификаторът е случайно число, генерирано веднъж на този компютър — не е
 * производен от машината и не може да се върже към нея.
 *
 * Защо е отделен файл и защо не пипа config.json: config.json пази пътя до
 * базата данни и е носещ — повреден config.json значи библиотека, която не
 * намира фонда си (виж коментарите в main.js и db-folder.js). Затова
 * идентификаторът живее в собствен, напълно незначителен файл: ако се загуби
 * или повреди, най-лошото е една инсталация да се преброи два пъти.
 *
 * Правило номер едно: това никога не бива да попречи на програмата. Всяка
 * грешка се преглъща, заявката има кратък таймаут, не се повтаря при неуспех и
 * нищо не се чака — ако няма интернет, ако сайтът е спрял или отговори с
 * грешка, библиотекарят не вижда нищо и програмата работи както обикновено.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* Крайната точка, която приема регистрациите. */
const REPORT_URL = 'https://invlib.com/api/invlib/install';

/* Достатъчно, за да се засече работещ сайт; достатъчно кратко, за да не виси
   нищо, ако мрежата на читалището е бавна или зад портал, който не отговаря. */
const TIMEOUT_MS = 5000;

/* Едно обаждане на денонощие. При стартиране по няколко пъти на ден се праща
   само първото — сървърът така или иначе не създава втори запис, но няма защо
   да го занимаваме, а и ограничителят му е на 30 заявки на час от адрес. */
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

const STATE_FILE = 'install-report.json';

/* os.release() на Windows дава низ като "10.0.22631". Windows 11 се различава
   от Windows 10 само по номера на компилацията (22000 нагоре).
   Ограничение, което е честно да се каже: сървърните издания на Windows имат
   припокриващи се номера на компилация с настолните, така че сървър ще се
   отчете като Windows 10 или 11. Сайтът приема и стойност "Other". */
function detectOs() {
  if (process.platform !== 'win32') return 'Other';
  const parts = String(os.release()).split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const build = Number(parts[2]);
  if (major === 10) return build >= 22000 ? 'Windows 11' : 'Windows 10';
  if (major === 6 && minor === 3) return 'Windows 8.1';
  if (major === 6 && minor === 2) return 'Windows 8';
  if (major === 6 && minor === 1) return 'Windows 7';
  return 'Other';
}

function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {}; // липсващ или повреден файл — започваме начисто
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* Ако не може да се запише, следващото пускане ще генерира нов
       идентификатор. Това изкривява статистиката, но не е повод за грешка
       пред библиотекаря. */
  }
}

/* UUID v4 — случаен, не съдържа нищо за машината. */
const newInstallationId = () => crypto.randomUUID();

/**
 * Изпраща регистрацията, ако е време за нея.
 *
 * @param {object}  opts
 * @param {string}  opts.userDataPath  постоянната потребителска папка (app.getPath('userData'))
 * @param {string}  opts.version       версията на програмата (app.getVersion())
 * @param {string}  [opts.url]         друга крайна точка — само за тестване
 * @param {boolean} [opts.force]       пропуска проверката „веднъж на денонощие“ — само за тестване
 * @returns {Promise<{sent: boolean, reason?: string, status?: number, installationId: string}>}
 *          Обещанието никога не се отхвърля.
 */
async function reportInstallation(opts) {
  const options = opts || {};
  const userDataPath = options.userDataPath;
  const version = options.version;
  const url = options.url || REPORT_URL;
  const stateFile = path.join(userDataPath || os.tmpdir(), STATE_FILE);

  const state = readState(stateFile);
  let installationId = typeof state.installationId === 'string' ? state.installationId : '';

  try {
    if (!installationId) {
      installationId = newInstallationId();
      state.installationId = installationId;
      state.createdAt = new Date().toISOString();
      writeState(stateFile, state);
    }

    /* Изключване без промяна по настройките на програмата: празен файл с флаг,
       или променлива на средата. Документирано в README-bibliotekar.md. */
    if (state.disabled === true || process.env.INVLIB_NO_TELEMETRY === '1') {
      return { sent: false, reason: 'disabled', installationId };
    }

    if (!options.force) {
      const last = Date.parse(state.lastReportAt || '');
      if (Number.isFinite(last) && Date.now() - last < MIN_INTERVAL_MS) {
        return { sent: false, reason: 'too-soon', installationId };
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId, version: String(version || ''), os: detectOs() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    /* Отбелязваме само при успех. При грешка на сървъра следващото пускане
       опитва пак, вместо да мълчи цяло денонощие. */
    if (response.ok) {
      state.lastReportAt = new Date().toISOString();
      writeState(stateFile, state);
    }

    return { sent: response.ok, status: response.status, installationId };
  } catch (err) {
    /* Няма мрежа, изтекъл таймаут, DNS, прокси, спрян сайт — всичко свършва
       тук и програмата продължава, все едно нищо не е било. */
    return { sent: false, reason: (err && err.name) || 'error', installationId };
  }
}

module.exports = { reportInstallation, detectOs, REPORT_URL };
