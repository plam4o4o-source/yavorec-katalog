#!/usr/bin/env node
'use strict';
/* ============================================================================
   node scripts/build-narachnik.js [--check]
   Версията на наръчника — от едно място (package.json), и PDF-ът от него.
   ============================================================================
   ЗАЩО СЪЩЕСТВУВА (v2.4.71, находка Р6 от кръг 45). Версията на програмата
   стоеше на ДВЕ места в docs/narachnik.html и двете се пишеха на ръка:
     1) корицата — „Версия на наръчника за програма vX.Y.Z · <дата>“;
     2) колонтитулът на всяка страница — `@bottom-left` в правилото `@page`
        („Наръчник за библиотекаря — InvLib vX.Y.Z“).
   Изданието v2.4.70 смени корицата, а колонтитулът остана v2.4.69 — на всичките
   100 страници на PDF-а, който отива при библиотекарите. Никой не го забеляза,
   защото колонтитулът не се вижда в HTML-а (той съществува само при печат), а
   тестът гледаше само корицата. Библиотекарка, която отвори PDF-а на стр. 40,
   чете „v2.4.69“ и с право се пита дали държи правилния наръчник.

   КАКВО ПРАВИ.
     • Чете "version" от electron-app/package.json — единственото място, което
       и без това се сменя при всяко издание (от него идват инсталаторът и
       „Настройки“ → „Програма“).
     • Вписва я на двете места в docs/narachnik.html. Всяко място трябва да се
       намери ТОЧНО веднъж: ако някой е преправил текста и шаблонът вече не пасва,
       скриптът спира с грешка, вместо тихо да не смени нищо (точно така се
       получи v2.4.69 в колонтитула).
     • Прави docs/narachnik-za-bibliotekarya.pdf с Chromium през Playwright —
       както е правен и досега (pdfinfo: HeadlessChrome / Skia): page.pdf с
       preferCSSPageSize (размерът и полетата са в `@page` на самия HTML) и
       printBackground (цветните кутии „note“/„warn“ са фон).

   С --check НЕ пише нищо: само проверява, че двете места в HTML-а носят версията
   от package.json, и излиза с код 1, ако не е така. Това вика
   test/docs-v2471.test.js — затова --check не иска Playwright и Chromium.

   ДАТАТА НА КОРИЦАТА скриптът нарочно не пипа: тя е датата, към която е
   написано съдържанието на наръчника, а не денят, в който е пуснат скриптът.
   Сменя се на ръка, когато се сменя текстът.

   ЗАЩО Playwright СЕ ЗАРЕЖДА ПО ИМЕ В ПРОМЕНЛИВА. Той не е зависимост на
   програмата (проектът нарочно ги пести — виж CONTRIBUTING.md) и стои глобално
   на машината, която прави PDF-а. Изразът require('playwright') с буквален низ
   би накарал проверката на типовете (tsconfig.json включва scripts/*.js) да го
   търси в node_modules. Пътят до Chromium се подава с INVLIB_CHROMIUM или
   остава /opt/pw-browsers/chromium.
   ============================================================================ */
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const DOCS_DIR = path.join(APP_DIR, '..', 'docs');
const HTML = path.join(DOCS_DIR, 'narachnik.html');
const PDF = path.join(DOCS_DIR, 'narachnik-za-bibliotekarya.pdf');
const CHROMIUM = process.env.INVLIB_CHROMIUM || '/opt/pw-browsers/chromium';

/* Двете места. Групата `v` е самата версия; останалото е текстът около нея,
   който трябва да остане непроменен. */
const PLACES = [
  { name: 'корицата', re: /(Версия на наръчника за програма v)(\d+\.\d+\.\d+)( · )/g },
  { name: 'колонтитула (@bottom-left в @page)', re: /(@bottom-left\s*\{\s*content:\s*"Наръчник за библиотекаря — InvLib v)(\d+\.\d+\.\d+)(")/g }
];

function packageVersion() {
  const v = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(String(v))) throw new Error('package.json: неочаквана версия „' + v + '“');
  return String(v);
}

/** Връща [{ name, found: [версии] }] — какво стои на всяко от двете места. */
function versionsInHtml(html) {
  return PLACES.map(p => ({ name: p.name, found: [...html.matchAll(p.re)].map(m => m[2]) }));
}

/** Проверка: всяко място — точно веднъж и с версията `want`. Връща списък с проблеми. */
function problems(html, want) {
  const out = [];
  for (const p of versionsInHtml(html)) {
    if (p.found.length !== 1) out.push(p.name + ': намерено ' + p.found.length + ' пъти (очаква се точно 1)');
    else if (p.found[0] !== want) out.push(p.name + ': v' + p.found[0] + ', а package.json казва v' + want);
  }
  return out;
}

function stamp(html, want) {
  let out = html;
  for (const p of PLACES) {
    const n = [...out.matchAll(p.re)].length;
    if (n !== 1) throw new Error(p.name + ': шаблонът се намира ' + n + ' пъти в narachnik.html (очаква се точно 1) — '
      + 'текстът е преправен; поправете шаблона в scripts/build-narachnik.js. Нищо не е записано.');
    out = out.replace(p.re, (_m, a, _v, b) => a + want + b);
  }
  return out;
}

async function makePdf() {
  const pwName = 'playwright';
  let pw;
  try { pw = require(pwName); }
  catch (e) {
    throw new Error('Playwright не е намерен (' + e.message.split('\n')[0] + '). Инсталирайте го '
      + '(npm i -g playwright) или пуснете скрипта с --check. HTML-ът вече е записан.');
  }
  const browser = await pw.chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + HTML, { waitUntil: 'load' });
    // Като низ: изразът се изпълнява в браузъра, а проверката на типовете тук е без DOM.
    await page.evaluate('document.fonts.ready');
    await page.pdf({ path: PDF, preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  const want = packageVersion();
  const html = fs.readFileSync(HTML, 'utf8');

  if (process.argv.includes('--check')) {
    const bad = problems(html, want);
    if (bad.length) {
      console.error('Наръчникът не отговаря на package.json (v' + want + '):\n  • ' + bad.join('\n  • ')
        + '\nПуснете: node scripts/build-narachnik.js');
      process.exit(1);
    }
    console.log('Наръчникът е за v' + want + ' — корицата и колонтитулът съвпадат с package.json.');
    return;
  }

  const next = stamp(html, want);
  if (next !== html) {
    fs.writeFileSync(HTML, next, 'utf8');
    console.log('docs/narachnik.html: версията е вписана — v' + want);
  } else {
    console.log('docs/narachnik.html: вече е за v' + want);
  }
  await makePdf();
  console.log('docs/narachnik-za-bibliotekarya.pdf: записан (' + Math.round(fs.statSync(PDF).size / 1024) + ' КБ)');
}

if (require.main === module) {
  main().catch(err => { console.error(err && err.message ? err.message : err); process.exit(1); });
}

module.exports = { packageVersion, versionsInHtml, problems, stamp, HTML, PDF };
