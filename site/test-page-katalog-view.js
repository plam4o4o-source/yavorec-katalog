#!/usr/bin/env node
/*
 * Проверка на ИЗГЛЕДА на page-katalog.html при реален мащаб.
 *
 * test-page-katalog.js до него проверява как каталогът СТИГА до страницата
 * (източници, срокове, кеш, диагностика). Този проверява какво прави
 * страницата, СЛЕД като данните са дошли: групиране на екземплярите по
 * заглавие, начален изглед (числа, рафтове, раздели, витрини, азбучник),
 * търсене и филтри, „Покажи още“, картата на записа, празен резултат — и
 * времената при 15 000 екземпляра, колкото е реален фонд.
 *
 * Употреба (jsdom идва от electron-app/node_modules, както при съседния тест):
 *   NODE_PATH=../electron-app/node_modules node test-page-katalog-view.js
 *   NODE_PATH=../electron-app/node_modules node test-page-katalog-view.js page-katalog.html 15000
 */
'use strict';
const fs = require('fs'), path = require('path');
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; } catch (e) {
  console.error('jsdom не е намерен. Стартирай с:');
  console.error('  NODE_PATH=' + path.resolve(__dirname, '../electron-app/node_modules') + ' node ' + __filename);
  process.exit(2);
}
const file = process.argv[2] || path.join(__dirname, 'page-katalog.html');
const N = parseInt(process.argv[3] || '15000', 10);
const html = fs.readFileSync(file, 'utf8');
const GITHUB = 'https://raw.githubusercontent.com/plam4o4o-source/yavorec-katalog/main/katalog.json';

/* Синтетичен фонд с формата на истинския: множество екземпляри на заглавие,
   празни полета, повредени редове, кирилица. */
function makeCatalog(n) {
  const A = ['Вазов, Иван', 'Йовков, Йордан', 'Елин Пелин', 'Кристи, Агата', 'Талев, Димитър', '', 'Радичков, Йордан'];
  const T = ['Под игото', 'Гераците', 'Старопланински легенди', 'Приказки', 'Железният светилник', 'Диви разкази', 'Речник на българския език'];
  const U = ['886.7-31', '82-93', '9(497.2)', '5', '61', '7.03', '3', '1', '0', '2'];
  const O = ['за възрастни', 'за деца', 'краеведски', 'справочен'];
  const V = ['книга', 'книга', 'книга', 'книга', 'видеодокумент', 'аудиодокумент', 'електронен документ'];
  const items = [];
  let inv = 1;
  const titles = Math.ceil(n / 3);
  for (let t = 0; t < titles && items.length < n; t++) {
    const copies = 1 + (t % 5);
    for (let c = 0; c < copies && items.length < n; c++) {
      items.push({
        inv: inv++, a: A[t % A.length], t: T[t % T.length] + ' № ' + t, s: t % 7 ? '' : 'Подзаглавие',
        c: 'София', p: 'Хермес', y: String(1950 + (t % 76)), v: V[t % V.length], l: t % 5 ? 'български' : 'английски',
        u: U[t % U.length], g: U[t % U.length].slice(0, 3) + '/В ' + (t % 90), o: O[t % O.length],
        k: t % 3 ? 'роман; литература' : '', n: t % 4 ? '' : 'Анотация с доста текст за проверка на търсенето. '.repeat(3),
        cv: '', av: (t + c) % 4 ? 1 : 0,
        d: t % 11 === 0 ? new Date(Date.now() - (t % 50) * 864e5).toISOString().slice(0, 10) : '2019-05-05'
      });
    }
  }
  items.push(null);                                   // повреден ред — не бива да сваля страницата
  items.push({ inv: inv++, t: 'Запис без автор', a: '', v: 'книга', u: '', g: '', o: 'за възрастни', av: 1 });
  return { generated: '2026-09-06', items,
    shelves: [{ name: 'най търсени', items: [1, 2, 3, 4, 5, 900, 901] }] };
}

(async () => {
  const CAT = makeCatalog(N);
  const t0 = Date.now();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://localhost/', pretendToBeVisual: true,
    beforeParse(w) {
      w.__err = [];
      w.addEventListener('error', e => w.__err.push((e.error && e.error.stack) || e.message));
      w.__unhandled = [];
      Object.defineProperty(w, 'localStorage', { value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, configurable: true });
      w.fetch = (url) => url.startsWith(GITHUB)
        ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(CAT) })
        : Promise.reject(new Error('no fallback in this test'));
      w.scrollTo = () => {};
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
    }
  });
  const w = dom.window, d = w.document;
  await new Promise((res, rej) => {
    let n = 0;
    const iv = setInterval(() => {
      n += 20;
      const ft = d.getElementById('katFt');
      if (ft && ft.innerHTML.indexOf('Каталогът е актуален') !== -1) { clearInterval(iv); res(); }
      else if (n > 60000) { clearInterval(iv); rej(new Error('boot не завърши')); }
    }, 20);
  });
  const bootMs = Date.now() - t0;

  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const T = (label, fn) => { const s = Date.now(); fn(); return Date.now() - s; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  console.log(`Зареждане (jsdom, ${CAT.items.length} записа): ${bootMs} ms`);
  ok(bootMs < 25000, 'зареждането отне ' + bootMs + ' ms — прекалено бавно');
  ok(w.__err.length === 0, 'необработени грешки: ' + w.__err.join(' | '));
  ok(!/Разгръщаме каталога/.test(d.getElementById('katR').innerHTML), 'останало е на анимацията за зареждане');
  ok(!d.getElementById('katHome').classList.contains('kat-hidden'), 'началният изглед не се показа');

  // --- начален изглед ---
  const stats = d.getElementById('katStats').textContent;
  ok(/заглавия/.test(stats) && /екземпляра/.test(stats), 'липсват числата за фонда: ' + stats);
  const tiles = d.querySelectorAll('#katTiles .kat-tile');
  ok(tiles.length >= 6, 'очаквах поне 6 плочки, намерени ' + tiles.length);
  ok(d.querySelectorAll('#katNewRack .kat-bk').length > 0, 'няма нови постъпления на рафта');
  ok(d.querySelectorAll('#katAbc button:not([disabled])').length > 0, 'азбучникът е изцяло изключен');
  ok(d.getElementById('katSh').style.display === 'flex', 'витрината от katalog.json не се показа');

  // --- търсене ---
  const q = d.getElementById('katQ');
  let ms = T('търсене', () => { q.value = 'вазов'; q.dispatchEvent(new w.Event('input', { bubbles: true })); });
  await sleep(400);
  const rows = d.querySelectorAll('#katR .kat-row');
  console.log('Търсене „вазов“: ' + d.getElementById('katC').textContent.trim() + ' · първа страница ' + rows.length + ' реда');
  ok(rows.length > 0 && rows.length <= 50, 'първата страница трябва да е до 50 реда, а е ' + rows.length);
  ok(d.getElementById('katHome').classList.contains('kat-hidden'), 'началният изглед остана видим при търсене');
  ok(/kat-hl/.test(d.getElementById('katR').innerHTML), 'търсената дума не е откроена');

  // време за пълно прерисуване при промяна на филтър
  const tRun = Date.now();
  d.querySelector('.kat-fchip[data-f="samo"]').click();
  const runMs = Date.now() - tRun;
  console.log('Филтър „само налични“: ' + runMs + ' ms · ' + d.getElementById('katC').textContent.trim());
  ok(runMs < 3000, 'филтърът отне ' + runMs + ' ms');
  const allAv = Array.prototype.every.call(d.querySelectorAll('#katR .kat-row .kat-av'), e => e.classList.contains('kat-y'));
  ok(allAv, '„само налични“ пропусна заети заглавия');
  d.querySelector('.kat-fchip[data-f="samo"]').click(); // изключваме

  // --- „Покажи още“ ---
  const before = d.querySelectorAll('#katR .kat-row').length;
  const tMore = Date.now();
  d.getElementById('katM').click();
  const moreMs = Date.now() - tMore;
  const after = d.querySelectorAll('#katR .kat-row').length;
  console.log('„Покажи още“: ' + moreMs + ' ms (' + before + ' → ' + after + ' реда)');
  ok(after > before, '„Покажи още“ не добави редове');
  ok(moreMs < 1500, '„Покажи още“ отне ' + moreMs + ' ms');

  // --- групиране: едно заглавие, няколко екземпляра ---
  const firstRow = d.querySelector('#katR .kat-row');
  ok(/екземпляр/.test(firstRow.textContent), 'редът не казва броя екземпляри: ' + firstRow.textContent.slice(0, 120));

  // --- карта на записа ---
  const tOpen = Date.now();
  firstRow.click();
  const openMs = Date.now() - tOpen;
  console.log('Отваряне на записа: ' + openMs + ' ms');
  const dr = d.getElementById('katDr');
  ok(dr.classList.contains('kat-on'), 'картата на записа не се отвори');
  ok(/Сигнатура/.test(dr.textContent), 'в картата липсва сигнатурата');
  ok(dr.querySelectorAll('.kat-copies tr').length > 1, 'в картата липсва таблицата с екземплярите');
  ok(/#zapis=/.test(w.location.hash), 'адресът не сочи записа: ' + w.location.hash);
  ok(openMs < 2000, 'отварянето отне ' + openMs + ' ms');
  // Esc затваря
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(!dr.classList.contains('kat-on'), 'Esc не затвори картата');

  // --- плочка (раздел) ---
  tiles[0].click();
  await sleep(50);
  ok(d.getElementById('katResT').textContent.length > 3, 'плочката не смени заглавието на изгледа');
  ok(d.querySelectorAll('#katR .kat-row').length > 0, 'плочката не даде резултати');

  // --- азбучник ---
  const letter = d.querySelector('#katAbc button:not([disabled])');
  d.getElementById('katBack').click();  // назад към началото
  ok(!d.getElementById('katHome').classList.contains('kat-hidden'), '„към началото“ не се върна');
  letter.click();
  await sleep(50);
  ok(d.querySelectorAll('#katR .kat-row').length > 0, 'буквата от азбучника не даде резултати');

  // --- празен резултат ---
  d.getElementById('katBack').click();
  q.value = 'няматакаванищоникъде'; q.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(400);
  ok(/Няма намерени/.test(d.getElementById('katR').textContent), 'няма съобщение за празен резултат');
  d.getElementById('katXe').click();
  ok(!d.getElementById('katHome').classList.contains('kat-hidden'), '„изчисти“ не върна началния изглед');

  ok(w.__err.length === 0, 'необработени грешки след взаимодействията: ' + w.__err.join(' | '));

  // размер на DOM
  const nodes = d.querySelectorAll('*').length;
  console.log('DOM възли след всичко: ' + nodes);
  ok(nodes < 20000, 'DOM-ът е ' + nodes + ' възела — прекалено много');

  dom.window.close();
  if (fails.length) { console.error('\nПРОВАЛ:'); fails.forEach(f => console.error('  - ' + f)); process.exit(1); }
  console.log('\nВСИЧКИ ПРОВЕРКИ ПРИ МАЩАБ ' + CAT.items.length + ' МИНАХА');
})().catch(e => { console.error('гръмна:', e); process.exit(2); });
