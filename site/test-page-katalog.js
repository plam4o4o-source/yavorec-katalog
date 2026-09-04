#!/usr/bin/env node
/*
 * jsdom-базиран тест за finding #13 (bug-audit-v2.3.1.md) в page-katalog.html.
 *
 * Проверява, че когато И ДВАТА живи източника (GitHub raw + jsDelivr) паднат,
 * но има валиден localStorage кеш (katalog_cache) от предишно живо зареждане,
 * страницата ясно показва потребителски видимо предупреждение "остарели/кеширани
 * данни" с датата на кеша — вместо мълчаливо да третира кеша като жив успех
 * (празен `note` аргумент на finish()).
 *
 * Разширен при противниковия реодит на v2.4.0 (порция "в") с два допълнителни
 * сценария:
 *   (д) повреден (частично записан) JSON в localStorage кеша — проверява, че
 *       JSON.parse грешката е уловена (try/catch в loadLive()) и страницата
 *       пада обратно на STATIC масива, БЕЗ необработено изключение;
 *   (е) диагностиката (LOG/diagHtml) различава HTTP статус от timeout от
 *       мрежова/CORS грешка, поотделно за всеки от двата източника.
 *
 * Употреба:
 *   node test-page-katalog.js /path/to/page-katalog.html
 *
 * Изход: process.exit(0) при успех, process.exit(1) при провал, с описание
 * на сценария, който е паднал.
 *
 * Изисква jsdom. В това repo jsdom не е инсталиран директно до този файл
 * (забранено ни е да пипаме electron-app/), затова се зарежда чрез NODE_PATH
 * сочещ към electron-app/node_modules, без да се редактира нищо там:
 *
 *   NODE_PATH=../electron-app/node_modules node test-page-katalog.js page-katalog.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  console.error('jsdom не е намерен. Стартирай с:');
  console.error('  NODE_PATH=' + path.resolve(__dirname, '../electron-app/node_modules') + ' node ' + __filename + ' <path-to-page-katalog.html>');
  process.exit(2);
}

const targetPath = process.argv[2] || path.join(__dirname, 'page-katalog.html');
const html = fs.readFileSync(targetPath, 'utf8');

const GITHUB_URL = 'https://raw.githubusercontent.com/plam4o4o-source/yavorec-katalog/main/katalog.json';
const JSDELIVR_URL = 'https://cdn.jsdelivr.net/gh/plam4o4o-source/yavorec-katalog@main/katalog.json';

function jsonResponse(obj, ok, status) {
  return Promise.resolve({
    ok: ok !== false,
    status: status || (ok !== false ? 200 : 500),
    json: () => Promise.resolve(obj),
    finally: undefined // not used; fetchTimeout wraps with .finally on the promise itself
  });
}

/*
 * Строг matcher по startsWith — НЕ includes() — за да избегнем capture trap-а
 * описан в skill-а (проксирани URL-и, съдържащи оригиналния hostname като substring).
 */
function makeFetchMock(scenario) {
  return function fetchMock(url, fetchOpts) {
    var opts = {
      ok: true,
      status: 200,
      json: function () { return Promise.resolve(scenario.body || { items: [] }); }
    };
    if (url.startsWith(GITHUB_URL)) {
      if (scenario.primary === 'fail') {
        return Promise.reject(new Error('mock network error (primary)'));
      }
      if (scenario.primary === 'http-error') {
        return Promise.resolve({ ok: false, status: scenario.primaryStatus || 500, json: function () { return Promise.resolve(null); } });
      }
      if (scenario.primary === 'timeout') {
        var e = new Error('The operation was aborted');
        e.name = 'AbortError';
        return Promise.reject(e);
      }
      /* Заглавките идват мигновено (HTTP 200), но ТЯЛОТО никога не тръгва — падаща
         мрежа, задавен CDN възел. Верен на браузъра: прекъсването отказва и
         четенето на тялото, затова json() слуша сигнала. Точно този случай беше
         пропуснат: таймерът се гасеше при заглавките и страницата висеше вечно. */
      if (scenario.primary === 'body-hangs') {
        return Promise.resolve({ ok: true, status: 200, json: function () {
          return new Promise(function (_, rej) {
            if (fetchOpts && fetchOpts.signal && fetchOpts.signal.addEventListener) {
              fetchOpts.signal.addEventListener('abort', function () {
                var er = new Error('The operation was aborted'); er.name = 'AbortError'; rej(er);
              });
            }
          });
        } });
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(scenario.primaryBody); } });
    }
    if (url.startsWith(JSDELIVR_URL)) {
      if (scenario.fallback === 'fail') {
        return Promise.reject(new Error('mock network error (fallback)'));
      }
      if (scenario.fallback === 'http-error') {
        return Promise.resolve({ ok: false, status: scenario.fallbackStatus || 500, json: function () { return Promise.resolve(null); } });
      }
      if (scenario.fallback === 'timeout') {
        var e2 = new Error('The operation was aborted');
        e2.name = 'AbortError';
        return Promise.reject(e2);
      }
      if (scenario.fallback === 'body-hangs') {
        return Promise.resolve({ ok: true, status: 200, json: function () {
          return new Promise(function (_, rej) {
            if (fetchOpts && fetchOpts.signal && fetchOpts.signal.addEventListener) {
              fetchOpts.signal.addEventListener('abort', function () {
                var er = new Error('The operation was aborted'); er.name = 'AbortError'; rej(er);
              });
            }
          });
        } });
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(scenario.fallbackBody); } });
    }
    return Promise.reject(new Error('unexpected URL in test: ' + url));
  };
}

/* Проста in-memory localStorage реализация, за да контролираме прецизно
   съдържанието й (jsdom's localStorage изисква file: или специален setup). */
function makeLocalStorageMock(initial) {
  var store = Object.assign({}, initial || {});
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    _dump: function () { return store; }
  };
}

async function runScenario(name, opts) {
  /*
   * КРИТИЧНО: page-katalog.html вика boot() СИНХРОННО в края на скрипта
   * (не при DOMContentLoaded), и boot() стига до първия await/fetch() ОЩЕ
   * по време на самото парсиране/изпълнение на скрипта. Ако мокнем
   * window.fetch/localStorage СЛЕД new JSDOM(...), скриптът вече е извикал
   * истинския (несъществуващ в jsdom) fetch и е гръмнал. Затова инжектираме
   * мока чрез beforeParse — изпълнява се върху window ПРЕДИ HTML/скриптовете
   * изобщо да се парснат.
   */
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://localhost/' + (opts.hash || ''),
    pretendToBeVisual: true,
    beforeParse(w) {
      if (!w.AbortController) {
        w.AbortController = function () { this.signal = {}; };
        w.AbortController.prototype.abort = function () {};
      }
      Object.defineProperty(w, 'localStorage', {
        value: makeLocalStorageMock(opts.localStorage),
        configurable: true
      });
      w.fetch = makeFetchMock(opts);
      // Улавя необработени грешки в самата страница (напр. ако JSON.parse на
      // повреден localStorage кеш НЕ беше уловен от try/catch — страницата
      // би гръмнала с необработено изключение точно тук).
      w.__uncaughtErrors = [];
      w.addEventListener('error', function (e) {
        w.__uncaughtErrors.push((e.error && (e.error.stack || e.error.message)) || e.message || String(e));
      });
    }
  });
  const w = dom.window;

  // Изчакваме boot()/finish() да завърши — изчакваме с polling.
  await new Promise(function (resolve, reject) {
    var waited = 0;
    var iv = setInterval(function () {
      waited += 20;
      var ft = w.document.getElementById('katFt');
      if (ft && ft.innerHTML && ft.innerHTML.indexOf('Каталогът е актуален') !== -1) {
        clearInterval(iv);
        resolve();
      } else if (waited > (opts.waitMs || 8000)) {
        clearInterval(iv);
        reject(new Error('[' + name + '] timeout waiting for boot()/finish() to complete'));
      }
    }, 20);
  });

  var ftHtml = w.document.getElementById('katFt').innerHTML;
  // katR е контейнерът, в който showLoading() рисува анимацията „Разгръщаме
  // каталога…“ — по него се вижда дали страницата е останала забита на нея.
  var listEl = w.document.getElementById('katR');
  var listHtml = listEl ? listEl.innerHTML : '';
  var uncaughtErrors = w.__uncaughtErrors.slice();
  dom.window.close();
  return { ftHtml: ftHtml, listHtml: listHtml, uncaughtErrors: uncaughtErrors };
}

const CACHED_GENERATED = '2026-03-15'; // -> очаквано форматирано като 15.03.2026
const CACHED_ITEMS = { generated: CACHED_GENERATED, items: [ { inv: 1, a: 'Тестов', t: 'Тестова книга', v: 'книга' } ] };

async function main() {
  var failures = [];

  function assert(cond, msg) {
    if (!cond) failures.push(msg);
  }

  // --- Сценарий (а): primary успява ---
  {
    var r = await runScenario('a: primary succeeds', {
      primary: 'ok',
      primaryBody: { generated: '2026-08-20', items: [{ inv: 1, a: 'X', t: 'Y', v: 'книга' }] },
      localStorage: {}
    });
    assert(r.ftHtml.indexOf('20.08.2026') !== -1, '(а) очаквах датата от живия primary отговор във footer-а');
    assert(r.ftHtml.indexOf('Няма връзка') === -1, '(а) не очаквах static-fallback предупреждение при жив успех');
    assert(r.ftHtml.indexOf('кеширани данни') === -1, '(а) не очаквах stale-cache предупреждение при жив успех');
  }

  // --- Сценарий (б): primary пада, fallback (jsDelivr) успява ---
  {
    var r = await runScenario('b: primary fails, fallback succeeds', {
      primary: 'fail',
      fallback: 'ok',
      fallbackBody: { generated: '2026-08-19', items: [{ inv: 2, a: 'X', t: 'Y', v: 'книга' }] },
      localStorage: {}
    });
    assert(r.ftHtml.indexOf('19.08.2026') !== -1, '(б) очаквах датата от живия fallback отговор във footer-а');
    assert(r.ftHtml.indexOf('Няма връзка') === -1, '(б) не очаквах static-fallback предупреждение при жив fallback успех');
    assert(r.ftHtml.indexOf('кеширани данни') === -1, '(б) не очаквах stale-cache предупреждение при жив fallback успех');
  }

  // --- Сценарий (в) — ФОКУСЪТ на поправката: и двата падат, ИМА localStorage кеш ---
  {
    var r = await runScenario('c: both fail, localStorage cache present', {
      primary: 'fail',
      fallback: 'fail',
      localStorage: { katalog_cache: JSON.stringify(CACHED_ITEMS) }
    });
    assert(r.ftHtml.indexOf('15.03.2026') !== -1,
      '(в) очаквах датата на кеша (15.03.2026, от j.generated="2026-03-15") видима във footer/предупреждение — намерено: ' + r.ftHtml);
    assert(/кеширан/i.test(r.ftHtml),
      '(в) очаквах видимо предупреждение съдържащо "кеширани" данни — намерено: ' + r.ftHtml);
    assert(r.ftHtml.indexOf('Няма връзка към живите данни') === -1,
      '(в) НЕ очаквах точния static-fallback текст (той е за вградения STATIC масив, не за localStorage кеша) — намерено: ' + r.ftHtml);
    assert(/диагностика|Защо/i.test(r.ftHtml),
      '(в) очаквах диагностичния линк (diagHtml()/LOG) да е видим и в тоя случай — намерено: ' + r.ftHtml);
  }

  // --- Сценарий (г): и двата падат, НЯМА localStorage кеш -> STATIC fallback непроменен ---
  {
    var r = await runScenario('d: both fail, no localStorage cache', {
      primary: 'fail',
      fallback: 'fail',
      localStorage: {}
    });
    assert(r.ftHtml.indexOf('Няма връзка към живите данни') !== -1,
      '(г) очаквах непроменения static-fallback текст да остане — намерено: ' + r.ftHtml);
    assert(/диагностика|Защо/i.test(r.ftHtml), '(г) очаквах диагностичния линк да е видим и тук');
  }

  // --- Сценарий (д) — противников реодит: и двата падат, localStorage кешът
  // съдържа ПОВРЕДЕН (частично записан) JSON. loadLive() трябва да улови
  // JSON.parse грешката (тя е обвита в try{}catch(e){}) и да падне обратно
  // на вградения STATIC масив — БЕЗ необработено изключение, което би
  // счупило цялата страница вместо да покаже static fallback. ---
  {
    var r = await runScenario('e: both fail, CORRUPTED localStorage cache (truncated JSON)', {
      primary: 'fail',
      fallback: 'fail',
      localStorage: { katalog_cache: '{"generated":"2026-01-01","items":[{"inv":1' /* нарочно прекъснат насред запис */ }
    });
    assert(r.uncaughtErrors.length === 0,
      '(д) повреден localStorage JSON НЕ бива да води до необработено изключение — намерено: ' + JSON.stringify(r.uncaughtErrors));
    assert(r.ftHtml.indexOf('Няма връзка към живите данни') !== -1,
      '(д) при повреден кеш очаквах падане обратно на static-fallback текста (кешът се третира като невалиден) — намерено: ' + r.ftHtml);
    assert(r.ftHtml.indexOf('undefined') === -1 && r.ftHtml.indexOf('[object') === -1,
      '(д) footer-ът не бива да съдържа следи от неуспешен JSON.parse — намерено: ' + r.ftHtml);
  }

  // --- Сценарий (е) — диагностиката (LOG/diagHtml) трябва да различава ВИДА
  // грешка на всеки източник поотделно (HTTP статус срещу timeout срещу
  // мрежова/CORS грешка), не обобщено съобщение. ---
  {
    var r = await runScenario('f: primary HTTP 503, fallback timeout — diag detail differentiates', {
      primary: 'http-error',
      primaryStatus: 503,
      fallback: 'timeout',
      localStorage: {}
    });
    assert(/GitHub[^<]*HTTP 503/.test(r.ftHtml),
      '(е) очаквах диагностиката да покаже конкретния HTTP статус (503) за GitHub — намерено: ' + r.ftHtml);
    assert(/jsDelivr[^<]*изчезна|jsDelivr[^<]*изтече/.test(r.ftHtml) || /jsDelivr[^<]*6 сек/.test(r.ftHtml),
      '(е) очаквах диагностиката да покаже timeout за jsDelivr, различно от HTTP статус — намерено: ' + r.ftHtml);
  }

  /* --- Сценарий (ж) — одит: заглавките пристигат, ТЯЛОТО никога не тръгва. ---
     Дотук fetchTimeout() гасеше таймера в .finally() на самия fetch, а fetch се
     решава още при заглавките: сървър, който отговори „200 OK“ и после спре да
     подава байтове, оставяше страницата ЗАВИНАГИ на анимацията „Разгръщаме
     каталога…“ — резервният източник не се пробваше, кешът не се пробваше,
     съобщение нямаше. Сега таймерът тече и през четенето на тялото. */
  {
    var r = await runScenario('zh: headers arrive, body never does (both sources)', {
      primary: 'body-hangs',
      fallback: 'body-hangs',
      localStorage: {},
      // Двата източника се пробват последователно. Заглавките идват веднага, тоест
      // всеки източник изяжда пълния срок за ТЯЛОТО (25 сек.) — тестът трябва да
      // чака повече от 50 сек., преди да се откаже.
      waitMs: 70000
    });
    assert(!/Разгръщаме каталога/.test(r.listHtml || ''),
      '(ж) страницата не бива да остане на анимацията за зареждане — намерено: ' + (r.listHtml || '').slice(0, 200));
    assert(r.ftHtml.indexOf('Няма връзка към живите данни') !== -1,
      '(ж) очаквах падане обратно на static-fallback текста — намерено: ' + r.ftHtml);
    assert(/изтече времето за изчакване/.test(r.ftHtml),
      '(ж) диагностиката трябва да каже, че е изтекло времето за изчакване — намерено: ' + r.ftHtml);
  }

  /* --- Сценарий (з) — v2.4.27: кавичка в споделен адрес (#zapis=") ---
     revealShared() вграждаше стойността от адреса направо в CSS селектор;
     кавичка хвърляше от querySelector, изключението стигаше до общия catch на
     boot() и живият каталог се заменяше с трите демонстрационни записа плюс
     червена лента „Каталогът не можа да се зареди“. Сега стойността се екранира
     (CSS.escape) и страницата просто не намира записа. */
  {
    var r = await runScenario('z: quote in #zapis= share link', {
      primary: 'ok',
      primaryBody: { generated: '2026-08-21', items: [{ inv: 1, a: 'X', t: 'Y', v: 'книга' }] },
      localStorage: {},
      hash: '#zapis=%22'
    });
    assert(r.ftHtml.indexOf('21.08.2026') !== -1, '(з) живият каталог трябва да остане — намерено: ' + r.ftHtml);
    assert(r.ftHtml.indexOf('Няма връзка') === -1, '(з) не бива да пада на static-fallback заради кавичка в адреса');
    assert(r.uncaughtErrors.length === 0, '(з) необработено изключение: ' + r.uncaughtErrors.join(' | '));
  }

  if (failures.length) {
    console.error('ПРОВАЛ — ' + failures.length + ' проверка(и) не преминаха:');
    failures.forEach(function (f) { console.error('  - ' + f); });
    process.exit(1);
  } else {
    console.log('ВСИЧКИ 8 СЦЕНАРИЯ МИНАХА (' + targetPath + ')');
    process.exit(0);
  }
}

main().catch(function (e) {
  console.error('Тестът гръмна с изключение:', e);
  process.exit(2);
});
