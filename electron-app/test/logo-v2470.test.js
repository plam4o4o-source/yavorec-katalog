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

test('знакът стои до авторството: лентата, „Настройки“, наръчникът, README', () => {
  const index = read(APP_DIR, 'src', 'index.html');
  assert.match(index, /<img class="devLogo" src="assets\/dev-logo\.png"[^>]*>\s*<div id="appCredit"/, 'лентата — точно над реда с авторството');
  assert.match(read(APP_DIR, 'src', 'views', 'settings.js'), /<div class="devCredit"><img src="assets\/dev-logo\.png"[\s\S]{0,200}APP_CREDIT_TEXT/);
  const n = read(ROOT, 'docs', 'narachnik.html');
  assert.match(n, /Автор на програмата: Пламен Христов - Пачо[^<]*<\/div>\s*<img class="devlogo" src="assets\/dev-logo\.png"/);
  assert.match(read(ROOT, 'README.md'), /## Автор\s+<img src="docs\/assets\/dev-logo\.png"/);
  assert.match(read(APP_DIR, 'src', 'style.css'), /\.devLogo\{/);
});

test('знакът влиза в инсталатора', () => {
  const files = require('../package.json').build.files;
  assert.ok(files.includes('src/**/*'), 'src/assets/dev-logo.png трябва да се пакетира през src/**/*');
});
