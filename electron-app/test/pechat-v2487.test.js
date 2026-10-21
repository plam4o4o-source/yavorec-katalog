'use strict';
/* v2.4.87 — ВСИЧКО, КОЕТО СЕ ПРИНТИРА, ПРЕГЛЕДАНО В ИСТИНСКИ CHROMIUM.
   =====================================================================
   Всяка разпечатка (35 документа, 74 листа — КДБФ, инвентарна книга, дневник,
   актове, протоколи, разписки, квитанции, картони, карти, писма, МЗС,
   краезнание, периодика, етикети, справките) беше отпечатана в PDF по пътя на
   „Запази PDF…“ и прегледана лист по лист. Намерено и поправено:
     П1  „7.59 € / 14.84 лв.“ в тясна колона се разпадаше на 4 реда („€“ отделно
         от числото) — инвентарната книга: 125 вписвания на 13 листа; сега 9.
         И „№ 1 / 2026“ в заглавие — „2026“ сам на втори ред.
     П2  ред от таблица се разкъсваше между два листа (инвентарната книга).
     П3  запис от персоналиите / аналитичното описание — последният му ред сам на
         следващия лист, до подписите.
     П4  Част № 2 на КДБФ и справката за фонда — „към 31.12.<година>“ за година,
         която още тече, без дума, че числата са към днес. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('./helpers/e2e-app');

const APP = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(APP, 'src', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const view = (f) => fs.readFileSync(path.join(APP, 'src', 'views', f), 'utf8');

let h = null;
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

test('П1 — ppNoBreak: сумите и номерата стават неразкъсваеми, текстът остава същият', () => {
  const w = h.window;
  const cases = [
    ['<td>7.59 € / 14.84 лв.</td>', '<td><span class="pnw">7.59 €</span> / <span class="pnw">14.84 лв.</span></td>'],
    ['<h2>АКТ № 1 / 21.10.2026</h2>', '<h2>АКТ <span class="pnw">№ 1 / 21.10.2026</span></h2>'],
    ['<i>-3.50 €</i>', '<i><span class="pnw">-3.50 €</span></i>']
  ];
  for (const [inp, out] of cases) assert.equal(w.ppNoBreak(inp), out);
  // Атрибутите, <style>, <script> и <svg> не се пипат.
  const keep = '<td title="5.00 € / 9.78 лв."></td><style>.x:before{content:"№ 1"}</style><svg><text>12 €</text></svg>';
  assert.equal(w.ppNoBreak(keep), keep);
  // Текстът на документа — дума по дума същият.
  const d = w.document.createElement('div');
  const html = '<p>Общо 3 документа на стойност 1805.45 € / 3531.15 лв. (карта № 0104), акт № 2/2026.</p>';
  d.innerHTML = w.ppNoBreak(html);
  const e = w.document.createElement('div'); e.innerHTML = html;
  assert.equal(d.textContent, e.textContent);
  // Документ без суми и номера не се преписва.
  assert.equal(w.ppNoBreak('<p>Летопис</p>'), '<p>Летопис</p>');
});

test('П1 — doPrint минава през ppNoBreak: и прегледът, и листът за печат', async () => {
  const w = h.window;
  w.setPrintPage({ name: 'Проба', landscape: false });
  w.doPrint('<div class="pdoc"><table><tbody><tr><td>7.59 € / 14.84 лв.</td></tr></tbody></table></div>', 'Проба');
  assert.equal(h.document.querySelectorAll('#ppSheet span.pnw').length, 2);
  w.ppFillPrintArea();
  assert.equal(h.document.querySelectorAll('#printArea span.pnw').length, 2);
  w.ppClose();
  await h.settle();
});

test('П2, П3 — CSS: ред, запис и сума не се разкъсват; заглавието на година не остава само', () => {
  assert.match(CSS, /\.pdoc table tbody tr\{break-inside:avoid; page-break-inside:avoid\}/);
  assert.match(CSS, /\.pdoc \.pentry\{break-inside:avoid; page-break-inside:avoid\}/);
  assert.match(CSS, /\.pdoc h3\{break-after:avoid; page-break-after:avoid\}/);
  assert.match(CSS, /\.pnw\{white-space:nowrap\}/);
  for (const f of ['persons.js', 'analytics.js', 'chronicle.js']) {
    assert.match(view(f), /<div class="pentry" style="margin-bottom:\d+px">/, f + ': всеки запис е .pentry');
  }
});

test('П4 — „годината не е приключила“: за текущата година — да, за минала — не', () => {
  const w = h.window;
  const T = E.today(), Y = T.slice(0, 4);
  const note = w.yearOpenNote(Y);
  if (T < Y + '-12-31') {
    assert.match(note, new RegExp('Годината не е приключила: числата са към ' + E.bgDate(T).replace(/\./g, '\\.') + ' г\\.; окончателните — след 31\\.12\\.' + Y));
  } else assert.equal(note, '', 'на 31 декември годината е приключила');
  assert.equal(w.yearOpenNote(String(Number(Y) - 1)), '');
  assert.match(view('kdbf.js'), /към 31\.12\.\$\{y\} г\.\$\{\s*yearOpenNote\(y\)/, 'Част № 2 на КДБФ носи бележката');
  assert.match(view('reports.js'), /Фонд към 31\.12\.\$\{r\.year\} г\.[^\n]*\n\s*yearOpenNote\(r\.year\)/, 'справката за фонда — също');
});

/* ----------------------------------------------------------------------
   Chromium: в тясна колона всяка сума е на ЕДИН ред (пропуска се без Chromium)
   ---------------------------------------------------------------------- */
function findChromium() {
  const cands = [process.env.PECHAT_PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright'];
  let pw = null;
  for (const p of cands.filter(Boolean)) { try { pw = require(p); break; } catch (e) { /* следващият път */ } }
  const exe = [process.env.PECHAT_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean).find(p => fs.existsSync(p));
  return pw && exe ? { pw, exe } : null;
}
const CH = findChromium();
const SKIP = !CH ? 'няма playwright/Chromium на машината (PECHAT_CHROMIUM)' : false;

test('Chromium П1: в тясна колона „Цена“ всяка сума е на един ред, клетката — най-много два', { skip: SKIP }, async () => {
  const browser = await CH.pw.chromium.launch({ executablePath: CH.exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.addInitScript(() => {
      const node = (parts) => new Proxy(function () {}, {
        get(t, p) { return p === 'then' || typeof p === 'symbol' ? undefined : node(parts.concat(p)); },
        apply() { return Promise.resolve({ ok: true, data: [] }); }
      });
      window.api = node([]);
    });
    await page.goto('file://' + path.join(APP, 'src', 'index.html'));
    await page.waitForFunction(() => typeof doPrint === 'function');
    const r = await page.evaluate(() => {
      const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>14.03.2026</td><td>${1000 + i}</td><td></td>
        <td>Автор, А. Дълго заглавие, което заема място в колоната ${i}</td><td>1999</td><td>1</td><td>${(7.5 + i).toFixed(2)} € / ${(14.67 + i * 2).toFixed(2)} лв.</td>
        <td>№ 1 / 14.03.2026</td><td>886.7-31 А 27</td><td></td><td>наличен</td><td></td></tr>`).join('');
      setPrintPage({ name: 'Проба', landscape: true, margin: '10mm' });
      doPrint(`<div class="pdoc"><table><thead><tr><th>Дата</th><th>Инв. №</th><th>Проверки</th><th>Автор и заглавие</th><th>Год.</th>
        <th>Бр.</th><th>Цена</th><th>№/дата в КДБФ</th><th>Сигнатура</th><th>№/дата на акт</th><th>Състояние</th><th>Забележка</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`, 'Проба');
      const spans = [...document.querySelectorAll('#ppSheet span.pnw')];
      const cells = [...document.querySelectorAll('#ppSheet tbody td:nth-child(7)')];
      // Редовете на ТЕКСТА в клетката (височината на клетката е тази на целия ред).
      const linesOf = (c) => { const rg = document.createRange(); rg.selectNodeContents(c);
        return new Set([...rg.getClientRects()].filter(q => q.width > 0).map(q => Math.round(q.top))).size; };
      return {
        spans: spans.length,
        broken: spans.filter(s => s.getClientRects().length > 1).map(s => s.textContent),
        maxLines: Math.max(...cells.map(linesOf))
      };
    });
    assert.ok(r.spans >= 36, 'сумите и номерата са обвити: ' + r.spans);
    assert.deepEqual(r.broken, [], 'нито една сума или номер не е разкъсан на два реда');
    assert.ok(r.maxLines <= 2, 'клетката с цената е най-много два реда, а не четири: ' + r.maxLines);
  } finally { await browser.close(); }
});
