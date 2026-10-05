'use strict';
/* v2.4.78 — СТРАНИЦАТА ЗА СКАНИРАНЕ С ТЕЛЕФОН: ТРИ ЕТАПА.
   =====================================================================
   Анализът на страницата в истински Chromium (Pixel 5, изкуствена камера,
   подменен четец, axe-core, Lighthouse) намери девет неща; тук всяко е
   изпълнено и проверено така, както го вижда човекът с телефона:

   Етап 1 — поправки
     Т1  номер от ЕДИН кадър (отблясък → друг валиден номер) — сега два поредни;
     Т2  ISBN от гърба на книгата влизаше с „успешен“ бийп; ISBN + етикет в кадъра
         даваха 10 фалшиви „повторни“ за 6 секунди;
     Т3  бавен четец — до 3 едновременни четения; сега едно след друго;
     Т4  камера, спряла отвън / заключен екран — страницата не забелязваше;
     Т5  без памет на браузъра списъкът изчезваше мълчаливо;
     Т6  „Копирано!“ и когато копирането е отказано;
     Т7  „×“ и „Изчисти“ без отмяна; „Изчисти“ не казваше, че списъкът не е пратен;
     Т8  контраст на бутоните 4,4:1 (WCAG AA иска 4,5:1).
   Етап 2 — „Изпрати“ (Web Share), будният екран (Wake Lock), фенерче/приближение.
   Етап 3 — списъкът на проверката (заглавие, извън обхвата, X от N, несканирани,
     проверка # в списъка и при вноса), вграденият четец (zxing) за телефони без
     BarcodeDetector, приложението по https (scripts/build-skener-site.js). */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const E = require('./helpers/e2e-app');

const APP = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(APP, 'src', 'mobile-template.html'), 'utf8');
const tick = (ms) => new Promise(r => setTimeout(r, ms || 20));
/* Масив/обект от страницата е от друг „свят“ (jsdom) — сравнява се копието му. */
const plain = (x) => JSON.parse(JSON.stringify(x));
const tmpDirs = [];
const phones = [];
test.afterEach(() => { while (phones.length) { try { phones.pop().close(); } catch (e) { /* вече затворен */ } } });
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-tel78-')); tmpDirs.push(d); return d; }

const EXP = {
  fmt: 'invlib-inventory-list', v: 1, made: '2026-10-05T08:00:00.000Z',
  session: { id: 7, no: 3, year: '2026', date: '2026-10-05', department: null },
  items: [
    [1024, null, 'Под игото', '891.81 ВАЗ', 0],
    [1025, 'B-77', 'Тютюн', '891.81 ДИМ', 0],
    [1026, null, 'Железният светилник', '891.81 ТАЛ', 1],
    [9, null, 'Бай Ганьо', '891.81 КОН', 0],
    [30, '9789540912345', 'Стар етикет по ISBN', '82 АБВ', 0]
  ]
};

/* Телефонът в jsdom. `frames` — какво „вижда“ четецът кадър по кадър (последният
   се повтаря); `delay` — колко трае едно четене. */
function openPhone(o = {}) {
  const state = { frames: o.frames || [], fi: 0, conc: 0, maxConc: 0, gum: 0, shared: null, wake: 0, wakeRel: 0,
    constraints: [], zx: [], zxPrep: null, clip: null, track: null, downloads: [] };
  let html = PAGE.replace(/__SLUG__/g, 'biblioteka');
  if (o.embedded) html = html.replace('/*__EXPECTED__*/null', () => JSON.stringify(o.embedded));
  if (o.zx) html = html.replace('<!--__ZXING__-->', '<script>var ZXING_WASM_B64 = "AGFzbQE=";</script>');
  const next = () => { const f = state.frames.length ? state.frames[Math.min(state.fi++, state.frames.length - 1)] : []; return f; };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: o.url || 'https://example.org/skener/', virtualConsole: new VirtualConsole(), pretendToBeVisual: true,
    beforeParse(w) {
      if (o.native !== false) {
        w.BarcodeDetector = function (opts) {
          state.formats = opts && opts.formats;
          return { detect: async () => {
            state.conc++; state.maxConc = Math.max(state.maxConc, state.conc);
            await tick(o.delay || 0); state.conc--;
            return next().map(v => ({ rawValue: v }));
          } };
        };
      }
      if (o.zx) {
        w.ZXingWASM = {
          prepareZXingModule: (p) => { state.zxPrep = p; },
          readBarcodes: async (data, opts) => { state.zx.push(opts); return next().map(v => ({ text: v, format: 'Code39', isValid: true })); }
        };
        w.HTMLCanvasElement.prototype.getContext = () => ({
          drawImage() {}, getImageData: (x, y, ww, hh) => ({ width: ww, height: hh, data: new Uint8ClampedArray(4) })
        });
        Object.defineProperty(w.HTMLVideoElement.prototype, 'videoWidth', { get: () => 640 });
        Object.defineProperty(w.HTMLVideoElement.prototype, 'videoHeight', { get: () => 480 });
      }
      w.createImageBitmap = async () => ({ width: 100, height: 50, close() {} });
      w.navigator.mediaDevices = { getUserMedia: async () => {
        state.gum++;
        const track = { listeners: {}, stopped: false, stop() { this.stopped = true; },
          addEventListener(t, fn) { this.listeners[t] = fn; },
          getCapabilities: () => o.caps || {}, getSettings: () => ({ zoom: 1 }),
          applyConstraints: async (c) => { state.constraints.push(c); } };
        state.track = track;
        return { getVideoTracks: () => [track], getTracks: () => [track] };
      } };
      w.HTMLMediaElement.prototype.play = async function () {};
      if (o.clip === 'deny') {
        Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } } });
        w.document.execCommand = () => false;
      } else {
        Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { state.clip = t; } } });
      }
      if (o.share) {
        w.navigator.canShare = () => true;
        w.navigator.share = (d) => new Promise((res) => {
          const rd = new w.FileReader();
          rd.onload = () => { state.shared = { name: d.files[0].name, text: String(rd.result) }; res(); };
          rd.readAsText(d.files[0]);
        });
      }
      if (o.wake) {
        Object.defineProperty(w.navigator, 'wakeLock', { value: { request: async () => {
          state.wake++; return { release: async () => { state.wakeRel++; }, addEventListener() {} };
        } } });
      }
      w.URL.createObjectURL = () => 'blob:x';
      w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { state.downloads.push(this.download); };
      w.confirm = (m) => { state.confirmMsg = m; return o.confirm !== false; };
      try {
        w.localStorage.clear();
        if (o.saved) w.localStorage.setItem('inventar-scan-v1', JSON.stringify(o.saved));
        if (o.storedList) w.localStorage.setItem('inventar-expected-v1', JSON.stringify(o.storedList));
      } catch (e) { /* file:// в jsdom няма памет — точно това проверява Т5 */ }
    }
  });
  phones.push(dom.window);
  return { w: dom.window, d: dom.window.document, state };
}
const saved = (w) => JSON.parse(w.localStorage.getItem('inventar-scan-v1') || '{}');
const add = (d, v) => { d.getElementById('manual').value = v; d.getElementById('addBtn').click(); };
async function liveFor(d, ms) { d.getElementById('startBtn').click(); await tick(ms); }

/* ============================== ЕТАП 1 ============================== */

test('Т1 — номер се приема при ДВА поредни прочита; единичен (отблясък) не влиза', async () => {
  const { w, d } = openPhone({ frames: [['10245'], ['1024'], ['10245'], ['10245'], []] });
  await liveFor(d, 900);
  assert.deepEqual(saved(w).codes, ['10245'], 'единичното „1024“ между два „10245“ е отблясък, не етикет');
  assert.equal(d.getElementById('dupCnt').textContent, '0');
  d.getElementById('stopBtn').click();
});

test('Т1 — задържаният етикет не дава „повторно“; излязъл от кадъра и върнат — дава', async () => {
  const f = []; for (let i = 0; i < 6; i++) f.push(['55']);
  for (let i = 0; i < 10; i++) f.push([]);           // > GONE_MS без етикета
  f.push(['55'], ['55'], []);
  const { w, d } = openPhone({ frames: f });
  await liveFor(d, 3000);
  assert.deepEqual(saved(w).codes, ['55']);
  assert.equal(d.getElementById('dupCnt').textContent, '1', 'върнат пред камерата след пауза — повторен');
  d.getElementById('stopBtn').click();
});

test('Т2 — ISBN и етикет в кадъра, редуващи се: само етикетът, без фалшиви „повторни“; ISBN се казва', async () => {
  const a = ['9789540912345', '1024'], f = [];
  for (let k = 0; k < 10; k++) f.push(k % 2 ? a : a.slice().reverse());
  f.push([]);
  const { w, d } = openPhone({ frames: f });
  await liveFor(d, 1600);
  assert.deepEqual(saved(w).codes, ['1024']);
  assert.equal(d.getElementById('dupCnt').textContent, '0', 'дотук: 10 фалшиви „повторни“ за 6 секунди');
  d.getElementById('stopBtn').click();
  const { w: w2, d: d2, state } = openPhone({});
  state.frames = [['9789540912345']];
  const inp = d2.getElementById('shotInp');
  Object.defineProperty(inp, 'files', { value: [{ name: 'shot.jpg' }], configurable: true });
  inp.dispatchEvent(new w2.Event('change'));
  await tick(30);
  assert.equal(d2.getElementById('cnt').textContent, '0', 'снимка само на ISBN не е сканиран етикет');
  assert.match(d2.getElementById('hit').textContent, /ISBN от корицата, а не етикетът с инвентарния номер/);
  assert.equal(d2.getElementById('hit').className, 'warn');
});

test('Т2 — ISBN, който списъкът на проверката познава като баркод (стар етикет), се приема', async () => {
  const { w, d, state } = openPhone({ embedded: EXP });
  state.frames = [['9789540912345']];
  const inp = d.getElementById('shotInp');
  Object.defineProperty(inp, 'files', { value: [{ name: 'shot.jpg' }], configurable: true });
  inp.dispatchEvent(new w.Event('change'));
  await tick(30);
  assert.deepEqual(saved(w).codes, ['9789540912345']);
  assert.match(d.getElementById('hit').textContent, /Стар етикет по ISBN/);
});

test('Т2 — четат се форматите на етикетите; ITF („къси“ прочитания) и QR са махнати', async () => {
  const { d, state } = openPhone({ frames: [[]] });
  await liveFor(d, 50);
  assert.deepEqual(plain(state.formats), ['code_39', 'code_128', 'codabar', 'ean_13', 'ean_8']);
  d.getElementById('stopBtn').click();
});

test('Т3 — бавният четец не се трупа: следващото четене тръгва след края на предишното', async () => {
  const { d, state } = openPhone({ frames: [[]], delay: 300 });
  await liveFor(d, 1500);
  assert.equal(state.maxConc, 1, 'дотук: до 3 едновременни четения');
  d.getElementById('stopBtn').click();
  await tick(400);
  assert.equal(state.conc, 0);
});

test('Т4 — камера, спряла отвън: страницата спира и казва; заключен екран — спира и тръгва сама', async () => {
  const { w, d, state } = openPhone({ frames: [[]] });
  await liveFor(d, 50);
  assert.ok(d.body.classList.contains('live'));
  state.track.listeners.ended();
  assert.ok(!d.body.classList.contains('live'), 'не изглежда, че чете, когато не чете');
  assert.equal(d.getElementById('startBtn').style.display, 'inline-block');
  assert.match(d.getElementById('nocam').textContent, /Камерата спря/);

  await liveFor(d, 50);
  assert.equal(state.gum, 2);
  let hidden = true;
  Object.defineProperty(d, 'hidden', { configurable: true, get: () => hidden });
  d.dispatchEvent(new w.Event('visibilitychange'));
  assert.ok(!d.body.classList.contains('live'), 'екранът е заключен — камерата е освободена');
  assert.ok(state.track.stopped);
  hidden = false;
  d.dispatchEvent(new w.Event('visibilitychange'));
  await tick(50);
  assert.equal(state.gum, 3, 'при връщане камерата тръгва сама');
  assert.ok(d.body.classList.contains('live'));
  d.getElementById('stopBtn').click();
  d.dispatchEvent(new w.Event('visibilitychange'));
  await tick(30);
  assert.equal(state.gum, 3, 'спряна с бутона — не тръгва сама');
});

test('Т5 — без памет на браузъра страницата го казва (дотук списъкът изчезваше мълчаливо)', () => {
  const { d } = openPhone({ url: 'file:///x/skener.html' });     // jsdom: file:// няма localStorage
  assert.equal(d.getElementById('storageWarn').style.display, 'block');
  assert.match(d.getElementById('storageWarn').textContent, /не се пази в паметта на телефона.*ще се изгуби/);
  assert.match(d.getElementById('storageWarn').textContent, /браузърът не ѝ дава памет/,
    'казано още при отваряне — от пробата, а не едва след първия неуспешен запис');
  const { d: d2 } = openPhone({});
  assert.equal(d2.getElementById('storageWarn').style.display, 'none', 'с памет — нищо не плаши');
});

test('Т6 — отказано копиране не се обявява за „Копирано!“; текстът остава отворен за ръчно копиране', async () => {
  const { d } = openPhone({ clip: 'deny' });
  add(d, '777');
  d.getElementById('copyBtn').click();
  await tick(30);
  assert.notEqual(d.getElementById('copyBtn').textContent, 'Копирано!');
  assert.match(d.getElementById('snackTxt').textContent, /не позволи копиране/);
  assert.equal(d.getElementById('outBox').open, true);
  assert.match(d.getElementById('out').value, /\n777$/);
});

test('Т7 — „×“ и „Изчисти“ имат „Отмени“; неизпратен списък се казва при „Изчисти“', async () => {
  const { w, d, state } = openPhone({});
  add(d, '1'); add(d, '2'); add(d, '3');
  d.querySelector('#list li:nth-child(2) .x').click();          // „2“
  assert.deepEqual(saved(w).codes, ['1', '3']);
  d.getElementById('snackBtn').click();
  assert.deepEqual(saved(w).codes, ['1', '2', '3'], 'върнат на мястото си');
  d.getElementById('clearBtn').click();
  assert.match(state.confirmMsg, /3 номера\) още НЕ е изпратен/);
  assert.deepEqual(saved(w).codes, []);
  d.getElementById('snackBtn').click();
  assert.deepEqual(saved(w).codes, ['1', '2', '3']);
  d.getElementById('copyBtn').click();
  await tick(30);
  assert.equal(saved(w).unsent, false, 'копираният списък е изпратен');
  d.getElementById('clearBtn').click();
  assert.equal(state.confirmMsg, 'Изчистване на целия списък?');
});

test('Т8 — контрастът на бутоните е поне 4,5:1 (WCAG AA)', () => {
  const m = PAGE.match(/\.btn\{[^}]*background:(#[0-9A-Fa-f]{6});[^}]*color:#fff/);
  assert.ok(m, 'правилото за .btn');
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const hex = m[1].slice(1);
  const L = 0.2126 * lin(parseInt(hex.slice(0, 2), 16)) + 0.7152 * lin(parseInt(hex.slice(2, 4), 16)) + 0.0722 * lin(parseInt(hex.slice(4, 6), 16));
  const ratio = 1.05 / (L + 0.05);
  assert.ok(ratio >= 4.5, 'контраст ' + ratio.toFixed(2));
});

/* ============================== ЕТАП 2 ============================== */

test('„Изпрати“: файлът с името и заглавния ред отива в менюто за споделяне; без поддръжка бутонът го няма', async () => {
  const { w, d, state } = openPhone({ share: true });
  assert.equal(d.getElementById('shareBtn').style.display, 'inline-block');
  add(d, '1024');
  d.getElementById('manual').value = '1025';                     // набран, без „Добави“
  d.getElementById('shareBtn').click();
  await tick(50);
  assert.match(state.shared.name, /^inventarizaciya-biblioteka-\d{4}-\d{2}-\d{2}\.txt$/);
  assert.deepEqual(state.shared.text.split('\n').slice(1), ['1024', '1025']);
  assert.equal(saved(w).unsent, false);
  const { d: d2 } = openPhone({});
  assert.equal(d2.getElementById('shareBtn').style.display, 'none');
});

test('Будният екран (Wake Lock) докато камерата чете; фенерче и приближение — по възможностите на камерата', async () => {
  const { d, state } = openPhone({ frames: [[]], wake: true, caps: { torch: true, zoom: { min: 1, max: 4, step: 0.5 }, focusMode: ['continuous', 'manual'] } });
  await liveFor(d, 50);
  assert.equal(state.wake, 1);
  assert.equal(d.getElementById('torchBtn').style.display, 'inline-block');
  assert.equal(d.getElementById('zoomRow').style.display, 'flex');
  assert.deepEqual(plain(state.constraints[0]), { advanced: [{ focusMode: 'continuous' }] });
  d.getElementById('torchBtn').click();
  await tick(10);
  assert.deepEqual(plain(state.constraints[1]), { advanced: [{ torch: true }] });
  assert.ok(d.getElementById('torchBtn').classList.contains('on'));
  const z = d.getElementById('zoom'); z.value = '2.5'; z.dispatchEvent(new d.defaultView.Event('input'));
  assert.deepEqual(plain(state.constraints[2]), { advanced: [{ zoom: 2.5 }] });
  d.getElementById('stopBtn').click();
  await tick(10);
  assert.equal(state.wakeRel, 1, 'спряна камера — екранът може да загасне');
  assert.equal(d.getElementById('torchBtn').style.display, 'none');
  const { d: d2 } = openPhone({ frames: [[]] });
  await liveFor(d2, 50);
  assert.equal(d2.getElementById('torchBtn').style.display, 'none', 'камера без фенерче — без бутон');
  d2.getElementById('stopBtn').click();
});

/* ============================== ЕТАП 3 ============================== */

test('Списъкът на проверката: заглавие на прочетеното, „извън обхвата“, X от N, несканирани по сигнатура', async () => {
  const { w, d } = openPhone({ embedded: EXP });
  assert.match(d.getElementById('listInfo').textContent, /протокол № 3\/2026, целият фонд · 5 документа/);
  assert.equal(d.getElementById('prog').textContent, '1/5', 'вече сканираният на компютъра се брои');
  add(d, '1024');
  assert.match(d.getElementById('hit').textContent, /✓ 1024Под игото · 891\.81 ВАЗ/);
  add(d, '5555');
  assert.equal(d.getElementById('hit').className, 'warn');
  assert.match(d.getElementById('hit').textContent, /няма го в списъка на тази проверка/);
  assert.equal(d.querySelector('#list li').className, 'out');
  add(d, '0009');                                               // водещите нули — както CAST в програмата
  add(d, 'b-77');                                               // баркодът се сравнява ТОЧНО, както в програмата
  assert.equal(d.querySelector('#list li').className, 'out');
  assert.equal(d.getElementById('prog').textContent, '3/5');
  d.getElementById('missBtn').click();
  const miss = [...d.querySelectorAll('#missList li')].map(li => li.textContent);
  assert.deepEqual(miss, ['1025Тютюн · 891.81 ДИМ', '30Стар етикет по ISBN · 82 АБВ'].sort((a, b) => {
    const s = (x) => x.split(' · ')[1]; return s(a).localeCompare(s(b), 'bg', { numeric: true });
  }), 'подредени по сигнатура — в реда на рафта');
  d.getElementById('out').dispatchEvent(new w.Event('focus'));
  assert.match(d.getElementById('out').value.split('\n')[0], /, 4 номера, проверка #7 \(протокол № 3\/2026\)$/);
});

test('Списъкът на проверката от файл (приложението): зарежда се, помни се, сканираното от друга проверка се казва', async () => {
  const { w, d } = openPhone({ saved: { codes: ['1'], dups: 0, started: E.today(), sid: 99 } });
  const inp = d.getElementById('listInp');
  const file = new w.File([JSON.stringify(EXP)], 'spisak.json', { type: 'application/json' });
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  inp.dispatchEvent(new w.Event('change'));
  await tick(50);
  assert.match(d.getElementById('listInfo').textContent, /протокол № 3\/2026/);
  assert.ok(w.localStorage.getItem('inventar-expected-v1'), 'запомнен за следващото отваряне');
  assert.match(d.getElementById('oldList').textContent, /Сканираните номера са от друга проверка \(#99\)/);
  const bad = new w.File(['{"a":1}'], 'drugo.json');
  Object.defineProperty(inp, 'files', { value: [bad], configurable: true });
  inp.dispatchEvent(new w.Event('change'));
  await tick(50);
  assert.match(d.getElementById('snackTxt').textContent, /не е списък на проверка/);
  assert.match(d.getElementById('listInfo').textContent, /протокол № 3\/2026/, 'грешният файл не маха добрия списък');
});

test('Вграденият четец (zxing) за телефони без BarcodeDetector: камера и снимка, без интернет', async () => {
  const { w, d, state } = openPhone({ native: false, zx: true, url: 'file:///x/skener.html', frames: [['1024'], ['1024'], []] });
  assert.equal(d.getElementById('startBtn').disabled, false);
  assert.equal(d.getElementById('shotBtn').style.display, 'inline-block');
  d.getElementById('startBtn').click();
  await tick(600);
  assert.equal(d.getElementById('cnt').textContent, '1');
  assert.deepEqual(plain(state.zx[0].formats), ['Code39', 'Code128', 'Codabar', 'EAN13', 'EAN8']);
  assert.ok(state.zxPrep.overrides.wasmBinary instanceof w.ArrayBuffer, 'четецът идва от самата страница');
  assert.equal(state.zxPrep.overrides.locateFile, undefined, 'никога от CDN');
  d.getElementById('stopBtn').click();
  // Без вграден четец и без BarcodeDetector — както досега: само ръчно.
  const { d: d2 } = openPhone({ native: false, url: 'file:///x/skener.html' });
  assert.equal(d2.getElementById('startBtn').disabled, true);
});

test('Страницата забранява външни заявки (CSP) и не пуска service worker извън приложението', () => {
  const csp = PAGE.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp);
  assert.match(csp[1], /default-src 'none'/);
  assert.match(csp[1], /connect-src 'self' blob: data:/);
  assert.doesNotMatch(csp[1], /https:|\*/, 'нито един външен адрес');
  assert.match(PAGE, /navigator\.serviceWorker\.register\('sw\.js'\)/);
  assert.match(PAGE, /document\.querySelector\('link\[rel="manifest"\]'\)/, 'само в приложението (има манифест)');
});

/* -------- Програмата: списъкът, страницата, адресът -------- */

const mobilePage = require('../mobile-page');

test('mobile-page: заглавие с „</script>“, „$&“ или образец не чупи страницата', () => {
  const html = mobilePage.buildScannerPage({ slug: 'x', expected: { fmt: 'invlib-inventory-list', session: { id: 1 },
    items: [[1, null, '</script><script>alert(1)</script> $& __SLUG__ <!--__PWA__-->', null, 0]] } });
  assert.equal((html.match(/<\/script>/g) || []).length, (html.match(/<script>/g) || []).length, 'нито един скрипт не е затворен от заглавие');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.org/', virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
  phones.push(dom.window);
  assert.equal(dom.window.EMBEDDED.items[0][2], '</script><script>alert(1)</script> $& __SLUG__ <!--__PWA__-->');
  assert.equal(dom.window.SLUG, 'x');
  assert.ok(dom.window.ZXING_WASM_B64.length > 900000, 'четецът е вграден');
  assert.throws(() => mobilePage.buildScannerPage({ slug: 'Я"' }), /Невалидно име/);
});

let h = null;
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });
const okd = (res, what) => { assert.equal(res.ok, true, what + ': ' + res.error); return res.data; };
function mkBook(inv, o = {}) {
  const id = Number(h.db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, status_date, department, barcode, call_number)
    VALUES (?, ?, 'Автор', 10, ?, ?, ?, ?, ?, ?)`)
    .run(inv, o.title || ('Книга ' + inv), E.addDays(E.today(), -400), o.status || 'наличен', E.today(), o.department || null,
      o.barcode || null, o.call || null).lastInsertRowid);
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id);
  return id;
}
async function startSess(department) {
  return okd(await h.api.inventorySessions.start({ date: E.today(), scope: 'отдел ' + department, department,
    committee1: 'А', committee2: 'Б', committee3: 'В', order_no: '1', no: null }), 'сесия');
}

test('mobile:sessionExport — обхватът на проверката, вече сканираните, без лични данни; .html с вграден списък', async () => {
  const dep = 'Т78-отдел';
  mkBook(78001, { department: dep, title: 'Много дълго заглавие '.repeat(8), call: '82 АБВ', barcode: 'T78-1' });
  const b2 = mkBook(78002, { department: dep });
  mkBook(78003, { department: dep, status: 'отчислен' });
  mkBook(78004, { department: 'друг' });
  const sid = await startSess(dep);
  okd(await h.api.inventorySessions.scan({ sessionId: sid, code: '78002' }), 'сканиране');
  const dir = tmp();
  h.dialogs.savePath = path.join(dir, 'spisak.json');
  okd(await h.api.mobile.sessionExport({ sessionId: sid, kind: 'json' }), 'json');
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'spisak.json'), 'utf8'));
  assert.equal(list.fmt, 'invlib-inventory-list');
  assert.equal(list.session.id, sid);
  assert.equal(list.session.department, dep);
  assert.deepEqual(list.items.map(i => i[0]), [78001, 78002], 'без отчисления и без чуждия отдел — същото като пула');
  assert.equal(list.items[0][1], 'T78-1');
  assert.equal(list.items[0][2].length, 70, 'заглавието е съкратено');
  assert.equal(list.items[0][3], '82 АБВ');
  assert.deepEqual(list.items.map(i => i[4]), [0, 1], 'вече сканираният в сесията');
  assert.equal(h.db.prepare('SELECT pool_size FROM inventory_sessions WHERE id = ?').get(sid).pool_size, list.items.length);
  assert.doesNotMatch(JSON.stringify(list), /reader|egn|phone|Автор/i, 'нито читатели, нито автори — само за проверка с очи');
  assert.ok(b2);

  h.dialogs.savePath = path.join(dir, 'skener.html');
  okd(await h.api.mobile.sessionExport({ sessionId: sid, kind: 'html' }), 'html');
  const html = fs.readFileSync(path.join(dir, 'skener.html'), 'utf8');
  assert.doesNotMatch(html, /__[A-Z]+__/);
  assert.match(html, /var EMBEDDED = \{"fmt":"invlib-inventory-list"/);
  assert.match(html, /var ZXING_WASM_B64 = "/);
  h.dialogs.savePath = null;
});

test('mobile:siteInfo — адресът на приложението с името за файла след „#“ и QR код', async () => {
  const info = okd(await h.api.mobile.siteInfo(), 'siteInfo');
  assert.match(info.url, /^https:\/\/plam4o4o-source\.github\.io\/yavorec-katalog\/skener\/(#lib=[a-z0-9-]+)?$/);
  assert.match(info.qrSvg, /^<svg[^>]*viewBox/);
});

test('Вносът пита, когато списъкът е за ДРУГА проверка (по „проверка #N“, не само по датата)', async () => {
  const dep = 'Т78-внос';
  mkBook(78101, { department: dep });
  const sid = await startSess(dep);
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  await h.clickButton('📱 Въведи сканирания от телефон', '#view');
  h.$('#scanPaste').value = '# Инвентаризация — списък започнат на ' + E.today().split('-').reverse().join('.') + ' г., 1 номер, проверка #'
    + (sid + 1000) + '\n78101\n';
  h.hooks.confirmAnswer = false;
  const c0 = h.hooks.confirms.length;
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  assert.match(h.hooks.confirms[c0] || '', new RegExp('започнат за друга проверка \\(#' + (sid + 1000) + '\\), а сега е отворена #' + sid));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM inventory_session_scans WHERE session_id = ?').get(sid).n, 0);
  h.$('#scanPaste').value = '# Инвентаризация — списък започнат на 01.01.2020 г., 1 номер, проверка #' + sid + '\n78101\n';
  const c1 = h.hooks.confirms.length;
  h.hooks.confirmAnswer = true;
  await h.clickButton('Въведи', '#modal');
  await h.settle();
  assert.equal(h.hooks.confirms.length, c1, 'същата проверка — датата не се пита втори път');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM inventory_session_scans WHERE session_id = ?').get(sid).n, 1);
});

test('Сесията има бутон „📋 Списък за телефона“', async () => {
  const sid = await startSess('Т78-бутон');
  await h.go('invent');
  await h.window.resumeInvent(sid); await h.settle();
  assert.ok([...h.document.querySelectorAll('#view button')].some(b => b.textContent.trim() === '📋 Списък за телефона'));
});

/* -------- Приложението по https -------- */

test('build-skener-site: страница с манифест, четец до нея, service worker с версията, без име на библиотека', () => {
  const out = tmp();
  require('../scripts/build-skener-site').build(out);
  const dir = path.join(out, 'skener');
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  for (const f of ['index.html', 'zxing-reader.js', 'zxing_reader.wasm', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /__[A-Z]+__/);
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
  assert.match(html, /<script src="zxing-reader.js"><\/script>/);
  assert.doesNotMatch(html, /ZXING_WASM_B64 = "/, 'по https четецът е отделен файл, пазен от service worker-а');
  assert.match(html, /var SLUG = '';/, 'името идва от адреса (#lib=…), не от страницата');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  assert.ok(m.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));
  const sw = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
  assert.match(sw, new RegExp("const CACHE = 'skener-v" + pkg.version.replace(/\./g, '\\.') + "'"));
  for (const f of ['index.html', 'zxing_reader.wasm', 'zxing-reader.js']) assert.ok(sw.includes(JSON.stringify(f)), 'кешира ' + f);
  const wf = fs.readFileSync(path.join(APP, '..', '.github', 'workflows', 'skener-pages.yml'), 'utf8');
  assert.match(wf, /node scripts\/build-skener-site\.js \.\.\/_site/);
  assert.match(wf, /actions\/deploy-pages@v4/);
});

test('Страницата от файла и приложението са ЕДИН шаблон — приложението по https носи името от адреса', async () => {
  const out = tmp();
  require('../scripts/build-skener-site').build(out);
  const html = fs.readFileSync(path.join(out, 'skener', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://plam4o4o-source.github.io/yavorec-katalog/skener/#lib=yavorec',
    virtualConsole: new VirtualConsole(), pretendToBeVisual: true,
    beforeParse(w) { w.BarcodeDetector = function () { return { detect: async () => [] }; }; } });
  phones.push(dom.window);
  assert.equal(dom.window.SLUG, 'yavorec');
  assert.equal(dom.window.localStorage.getItem('inventar-slug'), 'yavorec', 'запомнено за отваряне от началния екран (без #)');
  assert.match(dom.window.fileName(), /^inventarizaciya-yavorec-/);
});
