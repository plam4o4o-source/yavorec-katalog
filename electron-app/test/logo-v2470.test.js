'use strict';
/* v2.4.70 — знакът на разработчика стои до авторството навсякъде, където
   програмата и документите казват кой я е направил, и влиза в инсталатора. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const ROOT = path.join(APP_DIR, '..');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/* PNG: подпис и вид на цвета от заглавката IHDR; при палитра (3) прозрачността е
   в отделен блок tRNS, при RGBA (6) — в самия пиксел. */
function pngInfo(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.slice(0, 8).toString('hex'), '89504e470d0a1a0a', file + ' не е PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25], hasTrns: b.includes(Buffer.from('tRNS')) };
}

test('знакът е PNG с прозрачен фон — в програмата и в документите', () => {
  for (const f of [path.join(APP_DIR, 'src', 'assets', 'dev-logo.png'), path.join(ROOT, 'docs', 'assets', 'dev-logo.png')]) {
    const i = pngInfo(f);
    assert.ok(i.colorType === 6 || (i.colorType === 3 && i.hasTrns), f + ': без прозрачност фонът би стоял бял на тъмната лента');
    assert.ok(i.width > i.height, 'монограмът е по-широк, отколкото висок');
    assert.ok(fs.statSync(f).size < 60000, f + ': прекалено голям файл');
  }
});

test('знакът стои до авторството: „Настройки“, наръчникът, README', () => {
  /* По искане на автора: v2.4.79 махна от страничната лента реда „Създадено от …“
     (остава само в „Настройки“ като „Създадено от Пламен Христов“), а v2.4.80 върна
     в лентата знака — без реда с името. Променено нарочно. */
  const index = read(APP_DIR, 'src', 'index.html');
  assert.match(index, /<div class="railFoot">[\s\S]*?<img class="devLogo" src="assets\/dev-logo\.png" alt="Пламен Христов"[^>]*>\s*<\/div>/, 'знакът е в дъното на лентата');
  assert.doesNotMatch(index, /id="appCredit"|Създадено от|Пачо/, 'лентата е без реда с авторството');
  assert.match(read(APP_DIR, 'src', 'views', 'settings.js'), /<div class="devCredit"><img src="assets\/dev-logo\.png" alt="Пламен Христов">[\s\S]{0,200}APP_CREDIT_TEXT/);
  const badge = read(APP_DIR, 'src', 'views', 'employee-badge.js');
  assert.match(badge, /APP_CREDIT_TEXT = 'Създадено от Пламен Христов · GPL-3\.0-or-later © '/);
  assert.doesNotMatch(badge + read(APP_DIR, 'src', 'views', 'settings.js'), /Пачо/, 'в програмата — без прякора');
  const n = read(ROOT, 'docs', 'narachnik.html');
  /* v2.4.79 (по искане на автора): наръчникът и README — без прякора. Променено нарочно. */
  assert.match(n, /Автор на програмата: Пламен Христов ·[^<]*<\/div>\s*<img class="devlogo" src="assets\/dev-logo\.png" alt="Пламен Христов">/);
  assert.doesNotMatch(n + read(ROOT, 'README.md') + read(APP_DIR, 'README.md'), /Пачо/, 'наръчникът и README — без прякора');
  assert.match(read(ROOT, 'README.md'), /## Автор\s+<img src="docs\/assets\/dev-logo\.png"/);
  assert.match(read(APP_DIR, 'src', 'style.css'), /\.devCredit img\{/);
  assert.match(read(APP_DIR, 'src', 'style.css'), /\.devLogo\{/);
});

test('знакът влиза в инсталатора', () => {
  const files = require('../package.json').build.files;
  assert.ok(files.includes('src/**/*'), 'src/assets/dev-logo.png трябва да се пакетира през src/**/*');
});
