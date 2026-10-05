'use strict';
/* СТРАНИЦАТА ЗА СКАНИРАНЕ С ТЕЛЕФОН — СГЛОБЯВАНЕ (v2.4.78).
   =====================================================================
   Една и съща страница (src/mobile-template.html) стига до телефона по два пътя:

   • като ФАЙЛ, записан от програмата („Запиши страницата…“ и „Списък за
     телефона“) — отваря се без интернет. Тук вграденият четец на баркодове
     (zxing, WebAssembly) влиза ВЪТРЕ в страницата: файлът трябва да работи сам,
     на телефон без услугите на Google (Huawei) и без мрежа;
   • като ПРИЛОЖЕНИЕ по https (scripts/build-skener-site.js → GitHub Pages) —
     четецът стои до страницата като отделни файлове и се пази от service
     worker-а; живата камера тръгва, защото адресът е истински.

   Образците в шаблона и с какво се заместват:
     __SLUG__              името на библиотеката на латиница — САМО за името на
                           изнесения файл (виж handlers/mobile.js);
     <!--__PWA__-->        манифестът и иконата на приложението (само по https);
     <!--__ZXING__-->      вграденият четец;
     __EXPECTED__          (в коментар пред null) списъкът на проверката (виж
                           mobile:sessionExport).
   Списъкът се замества ПОСЛЕДЕН: в него има заглавия на книги, а заглавие,
   което случайно съдържа някой от другите образци, не бива да се „разгъне“. */
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'src', 'mobile-template.html');

/* Пътищата до четеца в пакета zxing-wasm. Пакетът изнася само ES/CJS входове
   ('zxing-wasm/reader'); самостоятелната (IIFE) сглобка и .wasm файлът стоят до
   тях в dist/ и се намират оттам. */
function zxingFiles() {
  const cjs = path.dirname(require.resolve('zxing-wasm/reader'));   // dist/cjs/reader
  const dist = path.join(cjs, '..', '..');
  return {
    js: path.join(dist, 'iife', 'reader', 'index.js'),
    wasm: path.join(dist, 'reader', 'zxing_reader.wasm')
  };
}

/* JSON вътре в <script>: „</script>“ в заглавие на книга би затворило скрипта, а
   U+2028/U+2029 са нов ред за по-старите JavaScript машини. */
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * @param {{ slug?: string, expected?: object | null, target?: 'file' | 'site', pwaHead?: string }} [opts]
 * @returns {string}
 */
function buildScannerPage(opts) {
  const o = opts || {};
  const slug = String(o.slug || '');
  if (!/^[a-z0-9-]*$/.test(slug)) throw new Error('Невалидно име за файла: ' + slug);
  const z = zxingFiles();
  const zx = o.target === 'site'
    ? '<script src="zxing-reader.js"></script>'
    : '<script>' + fs.readFileSync(z.js, 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>\n'
      + '<script>var ZXING_WASM_B64 = "' + fs.readFileSync(z.wasm).toString('base64') + '";</script>';
  /* Заместването е с ФУНКЦИЯ, а не с низ: при низ „$&“, „$'“ и „$1“ са специални
     за String.replace — а в четеца и в заглавията на книгите може да ги има. */
  return fs.readFileSync(TEMPLATE, 'utf8')
    .replace(/__SLUG__/g, () => slug)
    .replace('<!--__PWA__-->', () => o.pwaHead || '')
    .replace('<!--__ZXING__-->', () => zx)
    .replace('/*__EXPECTED__*/null', () => (o.expected ? jsonForScript(o.expected) : 'null'));
}

module.exports = { buildScannerPage, zxingFiles, jsonForScript, TEMPLATE };
