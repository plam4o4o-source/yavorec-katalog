'use strict';
/* v2.4.71 (находка Р6 от кръг 45) — ВЕРСИЯТА НА НАРЪЧНИКА Е ОТ ЕДНО МЯСТО.
 * =====================================================================
 * Изданието v2.4.70 смени версията на корицата на наръчника, а колонтитулът на
 * всяка страница (`@bottom-left` в `@page`) остана „InvLib v2.4.69“ — на всичките
 * 100 страници на PDF-а. Колонтитулът не се вижда в HTML-а на екрана, а тестът
 * (fixes-audit-v2423) гледаше само корицата, затова никой не го забеляза.
 *
 * Оттук нататък двете места се пишат от scripts/build-narachnik.js по
 * package.json. Тук се заковава, че:
 *   1) корицата И колонтитулът в docs/narachnik.html носят версията от
 *      package.json (самият скрипт с --check — същата проверка, която хората
 *      пускат на ръка);
 *   2) проверката наистина хваща стар колонтитул (иначе 1) би минавал винаги);
 *   3) CHANGELOG.md започва със записа за същата версия;
 *   4) ако на машината има pdftotext — ВСЯКА страница на PDF-а без корицата носи
 *      същата версия и вярно „стр. N от M“; ако няма — тестът го казва и се
 *      пропуска (pdftotext не е зависимост на проекта).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const SCRIPT = path.join(APP_DIR, 'scripts', 'build-narachnik.js');
const build = require(SCRIPT);
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('наръчникът: корицата и колонтитулът са за версията от package.json (build-narachnik.js --check)', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, 'build-narachnik.js --check пада:\n' + r.stdout + r.stderr);
  const html = fs.readFileSync(build.HTML, 'utf8');
  const places = build.versionsInHtml(html);
  assert.equal(places.length, 2, 'двете места — корица и колонтитул');
  for (const p of places) assert.deepEqual(p.found, [VERSION], p.name);
  assert.match(html, new RegExp('Версия на наръчника за програма v' + esc(VERSION) + ' · '));
  assert.match(html, new RegExp('@bottom-left\\s*\\{\\s*content:\\s*"Наръчник за библиотекаря — InvLib v' + esc(VERSION) + '"'));
});

test('проверката хваща стар колонтитул и стара корица — не минава винаги', () => {
  // От истинския файл, но с вписана текуща версия — за да не зависи тестът от
  // това дали файлът в момента е изряден (това казва първият тест).
  const html = build.stamp(fs.readFileSync(build.HTML, 'utf8'), VERSION);
  const oldFooter = html.replace('InvLib v' + VERSION + '"', 'InvLib v2.4.70"');
  assert.notEqual(oldFooter, html);
  const p1 = build.problems(oldFooter, VERSION);
  assert.equal(p1.length, 1);
  assert.match(p1[0], /колонтитула.*v2\.4\.70/);
  const oldCover = html.replace('за програма v' + VERSION + ' · ', 'за програма v2.4.69 · ');
  assert.match(build.problems(oldCover, VERSION)[0], /корицата.*v2\.4\.69/);
  // Изчезнал шаблон (преправен текст) — грешка, не тихо „нищо за смяна“.
  const gone = html.replace('@bottom-left', '@bottom-center');
  assert.match(build.problems(gone, VERSION)[0], /намерено 0 пъти/);
  assert.throws(() => build.stamp(gone, VERSION), /шаблонът се намира 0 пъти/);
  // stamp вписва версията и на двете места.
  const stamped = build.stamp(oldFooter.replace('за програма v' + VERSION, 'за програма v1.0.0'), VERSION);
  assert.deepEqual(build.problems(stamped, VERSION), []);
});

test('CHANGELOG.md започва със записа за версията от package.json', () => {
  const md = fs.readFileSync(path.join(APP_DIR, 'CHANGELOG.md'), 'utf8');
  const first = md.split('\n').find(l => /^## /.test(l));
  assert.equal(first, '## v' + VERSION);
});

test('PDF-ът на наръчника: колонтитулът на всяка страница носи версията и „стр. N от M“', (t) => {
  const probe = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  if (probe.error) {
    t.skip('pdftotext не е инсталиран на тази машина — PDF-ът не е проверен (проверката на HTML-а по-горе важи).');
    return;
  }
  assert.ok(fs.existsSync(build.PDF), 'липсва ' + build.PDF + ' — пуснете node scripts/build-narachnik.js');
  const r = spawnSync('pdftotext', ['-layout', build.PDF, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const pages = r.stdout.split('\f');
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  const total = pages.length;
  assert.ok(total > 50, 'наръчникът има ' + total + ' страници — твърде малко');
  const lastLine = (p) => p.split('\n').filter(l => l.trim()).pop() || '';
  assert.match(pages[0], new RegExp('Версия на наръчника за програма v' + esc(VERSION)), 'корицата на PDF-а');
  assert.doesNotMatch(lastLine(pages[0]), /стр\. \d+ от|InvLib v\d/, 'корицата е без колонтитул');
  const bad = [];
  for (let i = 1; i < total; i++) {
    const m = lastLine(pages[i]).match(/Наръчник за библиотекаря — InvLib v(\d+\.\d+\.\d+)\s+стр\. (\d+) от (\d+)/);
    if (!m || m[1] !== VERSION || Number(m[2]) !== i + 1 || Number(m[3]) !== total) {
      bad.push('стр. ' + (i + 1) + ': „' + lastLine(pages[i]).trim() + '“');
    }
  }
  assert.deepEqual(bad, [], 'колонтитулът не е за v' + VERSION + ' или номерацията е сбъркана — '
    + 'пуснете node scripts/build-narachnik.js');
});
