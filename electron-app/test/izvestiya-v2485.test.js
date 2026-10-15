'use strict';
/* v2.4.85 — ИЗВЕСТИЕТО НЕ ДЪРЖИ БУТОНИТЕ (и този път в истински браузър).
   =====================================================================
   Защитата от v2.4.69 (Х1) направи тялото на известието „прозрачно“ за мишката
   (.toast{pointer-events:none}). Само че щракване, което мине през известието,
   пада към РОДИТЕЛЯ му — а #toasts и #toastsTop са кутии с размера на
   известията и хващаха мишката те. При пълен работен ден в Chromium
   предупреждението горе в центъра стоеше точно върху „+ Нова книга“ и бутоните
   на гишето и те не отговаряха, докато известието не изчезне. jsdom няма
   подредба на страницата и не можеше да го види — затова проверката тук е и в
   истински Chromium (пропуска се, ако на машината няма такъв). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('CSS: и двата контейнера на известията пропускат мишката; хваща я само ×', () => {
  assert.match(CSS, /#toasts, #toastsTop\{pointer-events:none\}/);
  assert.match(CSS, /\.toast\{pointer-events:none\}/);
  assert.match(CSS, /\.toast \.tx\{pointer-events:auto\}/);
});

function findChromium() {
  let pw = null;
  for (const p of [process.env.PECHAT_PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright',
    '/home/claude/.npm-global/lib/node_modules/playwright'].filter(Boolean)) {
    try { pw = require(p); break; } catch (e) { /* следващият възможен път */ }
  }
  const exe = [process.env.PECHAT_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean).find(p => fs.existsSync(p));
  return pw && exe ? { pw, exe } : null;
}
const CH = findChromium();
const SKIP = !CH ? 'няма playwright/Chromium на машината (PECHAT_CHROMIUM)' : false;

test('Chromium: щракване върху текста на известието стига до бутона под него, × го затваря', { skip: SKIP }, async () => {
  const browser = await CH.pw.chromium.launch({ executablePath: CH.exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.addInitScript(() => {
      const node = (parts) => new Proxy(function () {}, {
        get(t, p) { return p === 'then' || typeof p === 'symbol' ? undefined : node(parts.concat(p)); },
        apply() { return Promise.resolve({ ok: true, data: [] }); }
      });
      window.api = node([]);
    });
    await page.goto('file://' + path.join(APP_DIR, 'src', 'index.html'));
    await page.waitForFunction(() => typeof toast === 'function');
    const r = await page.evaluate(async () => {
      // Бутон точно под мястото на горното известие и по едно известие от двата вида.
      const b = document.createElement('button');
      b.id = 'под'; b.textContent = 'бутон под известието';
      b.style.cssText = 'position:fixed; left:0; top:0; width:100vw; height:100vh; z-index:1';
      b.onclick = () => { window.__щракнат = (window.__щракнат || 0) + 1; };
      document.body.appendChild(b);
      toast('Предупреждение горе в центъра — дълъг текст, за да е широко.', 'warn');
      toast('Успех долу вдясно.', 'ok');
      await new Promise(res => setTimeout(res, 400));
      const at = (el) => { const q = el.getBoundingClientRect(); return document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); };
      const mine = (sel, re) => [...document.querySelectorAll(sel + ' .toast .tmsg')].find(e => re.test(e.textContent));
      const top = mine('#toastsTop', /Предупреждение горе/), bottom = mine('#toasts', /Успех долу/);
      const gap = (() => { const q = document.querySelector('#toastsTop').getBoundingClientRect(); return document.elementFromPoint(q.left + 2, q.bottom - 2); })();
      return {
        top: at(top).id, bottom: at(bottom).id, gap: gap && gap.id,
        x: at(top.closest('.toast').querySelector('.tx')).className
      };
    });
    assert.equal(r.top, 'под', 'горното известие пропуска щракването към бутона');
    assert.equal(r.bottom, 'под', 'долното известие също');
    assert.equal(r.gap, 'под', 'и празното място в контейнера');
    assert.equal(r.x, 'tx', '× остава за мишката');
    // Истинско щракване през известието.
    const box = await page.locator('#toastsTop .toast .tmsg').filter({ hasText: 'Предупреждение горе' }).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.evaluate(() => window.__щракнат), 1, 'бутонът под известието получи щракването');
  } finally { await browser.close(); }
});
