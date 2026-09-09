'use strict';
/* v2.4.45 — страницата за сканиране с телефон (src/mobile-template.html).
   =====================================================================
   Проверява се самата страница, изпълнена в jsdom, а не само видът на кода:
   решенията ѝ зависят от неща, които на компютъра ги няма (BarcodeDetector) и
   от АДРЕСА, на който е отворена (file:// срещу https://) — точно там беше
   дефектът, заради който камерата мълчеше на телефона.

   Защо изобщо: страницата се прехвърля на телефона като файл и се отваря
   оттам, тоест на file:// (а от Вайбър — content://). Chrome пази
   разрешенията за камера ПО АДРЕС на страницата; такъв адрес няма собствен
   адрес, на който да се запише разрешение, затова на Android заявката се
   отказва, БЕЗ да се покаже въпросът „Разрешавате ли достъп до камерата?“.
   Библиотекарят натиска „Пусни камерата“ и не се случва нищо.

   Измерено в истински Chromium (Playwright) при подготовката на поправката:
   на file:// страницата Е сигурен контекст (isSecureContext:true) и
   navigator.mediaDevices СЪЩЕСТВУВА — тоест проверка „има ли getUserMedia“ не
   лови случая; решаващ е адресът. BarcodeDetector го няма в Chromium за Linux,
   затова тук се подава наготово. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile-template.html'), 'utf8');

/* Страницата се пуска както я получава телефонът — с вече заместени образци. */
function openPage({ url, barcodeDetector = true, mediaDevices = true, detected = [],
                    lib = 'Библиотека · с. Яворец' } = {}) {
  const html = PAGE
    .replace(/__LIB__/g, lib)
    .replace(/__TITLE__/g, lib ? lib + ' · Инвентаризация' : 'Инвентаризация — сканиране')
    .replace(/__SLUG__/g, 'biblioteka');
  const virtualConsole = new VirtualConsole();          // тихо: beep() търси AudioContext
  const state = { detected: detected.slice(), bitmaps: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url, virtualConsole, pretendToBeVisual: true,
    beforeParse(w) {
      if (barcodeDetector) {
        w.BarcodeDetector = function () { return { detect: async () => state.detected }; };
      }
      /* jsdom няма нито едното, нито другото; страницата ги ползва само по
         пътя със снимката. */
      w.createImageBitmap = async () => { state.bitmaps++; return { close() {} }; };
      /* Телефонът има getUserMedia и на file:// (измерено в Chromium:
         navigator.mediaDevices съществува и там) — отказът идва по-късно, от
         разрешението. jsdom няма mediaDevices изобщо, затова се подава. */
      if (mediaDevices) {
        w.navigator.mediaDevices = { getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } };
      }
      /* jsdom отказва localStorage на opaque origin (file://). Самата страница
         работи с try/catch около него — тук се пази само тестът. */
      try { w.localStorage.clear(); } catch (e) { /* file:// в jsdom */ }
    }
  });
  return { dom, w: dom.window, d: dom.window.document, state };
}
const box = (d) => ({
  shown: d.getElementById('nocam').style.display,
  text: (d.getElementById('nocam').textContent || '').replace(/\s+/g, ' ').trim(),
  startDisabled: d.getElementById('startBtn').disabled,
  shot: d.getElementById('shotBtn').style.display
});

test('отворена като файл: страницата казва предварително, че камерата няма да попита', () => {
  /* Дотук нямаше НИКАКВО предупреждение: бутонът стоеше активен, натискаше се,
     телефонът мълчеше и съобщението идваше чак след отказа — с текста на самия
     браузър („Permission denied“). */
  const { d } = openPage({ url: 'file:///storage/emulated/0/Download/skener.html' });
  const b = box(d);
  assert.equal(b.shown, 'block', 'предупреждението трябва да се вижда още при отваряне');
  assert.match(b.text, /отворена като файл/, b.text);
  assert.match(b.text, /не пита за достъп до камерата/, b.text);
  assert.match(b.text, /Снимай баркод/, 'трябва да посочи пътя, който работи: ' + b.text);
  assert.equal(b.shot, 'inline-block', 'копчето за снимка трябва да е налично');
  assert.equal(b.startDisabled, false,
    'живата камера не се забранява — на компютър и по https:// тя работи');
});

test('отворена по https: няма предупреждение, живата камера е първият път', () => {
  const { d } = openPage({ url: 'https://primer.bg/skener.html' });
  const b = box(d);
  assert.equal(b.shown, 'none', 'нищо не бива да плаши, когато всичко е наред: ' + b.text);
  assert.equal(b.startDisabled, false);
  assert.equal(b.shot, 'inline-block');
});

test('без BarcodeDetector (iPhone, стари браузъри) остава ръчното въвеждане', () => {
  const { d } = openPage({ url: 'file:///x/skener.html', barcodeDetector: false });
  const b = box(d);
  assert.equal(b.startDisabled, true);
  assert.equal(b.shot, 'none', 'снимка без четец е безсмислена — няма кой да я разчете');
  assert.match(b.text, /не може да чете баркодове/, b.text);
  assert.ok(d.getElementById('manual'), 'полето за ръчно въвеждане остава');
});

test('„Снимай баркод“ разчита номера от снимката, без да иска разрешение от страницата', async () => {
  /* Този път минава през приложението „Камера“ на телефона (input capture) и
     затова работи и от файл. Проверява се, че разчетеното наистина влиза в
     списъка — и че един кадър с два еднакви етикета не брои два пъти. */
  const { w, d, state } = openPage({ url: 'file:///x/skener.html', detected: [] });
  const inp = d.getElementById('shotInp');
  assert.equal(inp.getAttribute('capture'), 'environment', 'снимката трябва да е от камерата, не от галерията');
  assert.equal(inp.getAttribute('accept'), 'image/*');

  state.detected = [{ rawValue: '1024' }, { rawValue: '1024' }, { rawValue: '1025' }];
  Object.defineProperty(inp, 'files', { value: [{ name: 'shot.jpg' }], configurable: true });
  inp.dispatchEvent(new w.Event('change'));
  await new Promise(r => setTimeout(r, 30));

  assert.equal(d.getElementById('out').value, '1024\n1025', 'номерата от снимката влизат в списъка');
  assert.equal(d.getElementById('cnt').textContent, '2');
  assert.equal(state.bitmaps, 1, 'снимката се чете веднъж');
  assert.equal(d.getElementById('nocam').style.display, 'none', 'предупреждението се маха при успех');
});

test('снимка без баркод го казва, вместо да мълчи', async () => {
  const { w, d, state } = openPage({ url: 'file:///x/skener.html' });
  const inp = d.getElementById('shotInp');
  state.detected = [];
  Object.defineProperty(inp, 'files', { value: [{ name: 'shot.jpg' }], configurable: true });
  inp.dispatchEvent(new w.Event('change'));
  await new Promise(r => setTimeout(r, 30));
  assert.match(d.getElementById('nocam').textContent, /няма разчетен баркод/);
  assert.equal(d.getElementById('cnt').textContent, '0');
});

test('отказът на камерата се обяснява с думи, а не с текста на браузъра', () => {
  /* camErrText() се вади от самата страница и се изпълнява: грепът за името ѝ
     не пази нищо, ако тялото ѝ се изпразни. */
  const src = PAGE.match(/function camErrText\(e\) \{[\s\S]*?\n\}/)[0];
  const make = (localFile) => new Function('escHtml', 'navigator', 'LOCAL_FILE',
    src + '; return camErrText;')(String, { mediaDevices: {} }, localFile);

  const fromFile = make(true), fromWeb = make(false);
  assert.match(fromFile({ name: 'NotAllowedError' }), /отворена като файл/,
    'от файл причината е адресът, а не че някой е натиснал „Не“');
  assert.match(fromFile({ name: 'NotAllowedError' }), /Снимай баркод/);
  assert.match(fromWeb({ name: 'NotAllowedError' }), /катинарчето/,
    'по https:// разрешението наистина се дава от лентата на адреса');
  assert.match(fromFile({ name: 'NotFoundError' }), /задна камера/);
  assert.match(fromFile({ name: 'NotReadableError' }), /заета от друго приложение/);
  assert.match(fromFile({ name: 'TypeError' }), /отворена като файл/);
  // Непозната грешка не бива да изчезва — показва се каквото е дошло.
  assert.match(fromWeb({ name: 'КакваЛиЕ', message: 'нещо си' }), /нещо си/);
});

test('копираният списък съдържа САМО номера — програмата чете всяка дума като номер', async () => {
  /* importScansRun() дели по интервали и запетаи: заглавен ред с името на
     библиотеката би влязъл като няколко несъществуващи номера. Затова името е
     в ИМЕТО на файла, а не в съдържанието му. */
  const { w, d } = openPage({ url: 'file:///x/skener.html' });
  const man = d.getElementById('manual');
  man.value = '1024';
  man.dispatchEvent(Object.assign(new w.Event('keydown'), { key: 'Enter' }));
  man.value = '1025';
  man.dispatchEvent(Object.assign(new w.Event('keydown'), { key: 'Enter' }));
  assert.equal(d.getElementById('out').value, '1024\n1025');
  assert.equal(/[А-Яа-я]/.test(d.getElementById('out').value), false, 'нито дума кирилица в списъка');
});

test('празна лента с името не оставя ивица под заглавието', () => {
  const { d } = openPage({ url: 'file:///x/skener.html', lib: '' });
  assert.equal(d.getElementById('libName').style.display, 'none');
  const full = openPage({ url: 'file:///x/skener.html', lib: 'Библиотека · с. Яворец' });
  assert.notEqual(full.d.getElementById('libName').style.display, 'none');
  assert.match(full.d.getElementById('libName').textContent, /Библиотека/);
});
