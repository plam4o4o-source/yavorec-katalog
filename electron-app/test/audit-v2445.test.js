'use strict';
/* v2.4.45 — преглед на поправките от v2.4.44.
   =====================================================================
   Пазачът срещу двойно вписване (v2.4.44) спираше само двете повиквания в ЕДИН
   И СЪЩ синхронен тик — а истинското двойно щракване не е такова: между двете
   щраквания минават 60–150 ms и през тях записът вече е приключил. Прозорецът
   обаче се маха чак 140 ms след затварянето и дотогава стои на екрана — жив,
   макар и прозрачен. Затова вторият натиск заварваше бутона отново включен.

   Собственият тест на кръга щракваше два пъти в един тик („btn.click();
   btn.click();“) и затова минаваше и с дупката. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, cleanupTmpDirs, buildDom, settle } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

function payForm() {
  const dom = buildDom({
    'readers.get': { id: 7, name: 'Иван Петров', card_no: '0007' },
    'account.get': { balance: 0, lines: [] },
    'settings.get': {}, 'account.pay': 5
  });
  return dom;
}
const payButton = (d) => [...d.querySelectorAll('#modal2 footer .btn')].find(b => b.textContent === 'Плати');

/* Кога истинският браузър БИ задействал второто щракване: изключен бутон не
   приема щракване, махнат от документа — също. Нарочно НЕ се пита за
   .veil.closing: това е ДРУГАТА преграда (стилът) и тя се проверява отделно —
   иначе тестът щеше да минава заради собственото си условие и да не различава
   поправения пазач от счупения. */
const clickable = (btn) => !btn.disabled && btn.isConnected;

for (const gap of [30, 60, 140]) {
  test(`двойно щракване с пауза ${gap} ms плаща ВЕДНЪЖ`, async () => {
    const dom = payForm();
    const { window } = dom, d = window.document;
    await settle();
    window.payAccount(7);
    await settle();
    d.querySelector('#payF [name=amount]').value = '4.50';
    const btn = payButton(d);
    btn.focus();
    btn.click();
    await new Promise(r => setTimeout(r, gap));
    if (clickable(btn)) btn.click();
    await settle();
    assert.equal((dom.calls['account.pay'] || []).length, 1,
      'плащането трябва да тръгне веднъж, а не веднъж на щракване');
    window.close();
  });
}

test('бутонът в затварящ се прозорец остава изключен, докато прозорецът си отиде', async () => {
  /* Отделно от предната проверка: там второто щракване го спира и пазачът по
     фокус. Тук се мери самото СЪСТОЯНИЕ на бутона през тези 140 ms — дотук той
     се включваше отново веднага щом записът приключи, тоест светеше активен
     върху прозорец, който още се вижда. */
  const dom = payForm();
  const { window } = dom, d = window.document;
  await settle();
  window.payAccount(7);
  await settle();
  d.querySelector('#payF [name=amount]').value = '4.50';
  const btn = payButton(d);
  btn.focus();
  btn.click();
  await new Promise(r => setTimeout(r, 40));      // записът мина, прозорецът избледнява
  assert.ok(d.querySelector('#veil2.closing'), 'прозорецът трябва да се затваря в този миг');
  assert.equal(btn.isConnected, true, 'бутонът още стои на екрана');
  assert.equal(btn.disabled, true, 'и трябва да е изключен, а не да оживее под пръста');
  window.close();
});

test('провален запис връща бутона — прозорецът остава отворен и се опитва пак', async () => {
  /* Обратната страна на пазача: ако записът не мине, формата стои и човекът
     трябва да може да натисне пак. Изчакването не бива да заключи бутона
     завинаги. */
  const dom = buildDom({
    'readers.get': { id: 7, name: 'Иван Петров', card_no: '0007' },
    'account.get': { balance: 0, lines: [] }, 'settings.get': {}, 'account.pay': 5
  });
  const { window } = dom, d = window.document;
  await settle();
  window.payAccount(7);
  await settle();
  d.querySelector('#payF [name=amount]').value = '';      // празна сума → savePayment се отказва
  const btn = payButton(d);
  btn.focus();
  btn.click();
  await new Promise(r => setTimeout(r, (window.MODAL_FADE_MS || 140) + 80));
  assert.equal((dom.calls['account.pay'] || []).length, 0, 'нищо не бива да се е записало');
  assert.equal(btn.isConnected, true, 'формата остава отворена при отказ');
  assert.equal(btn.disabled, false, 'бутонът трябва да е използваем пак — иначе формата е задънена');
  d.querySelector('#payF [name=amount]').value = '4.50';
  btn.click();
  await settle();
  assert.equal((dom.calls['account.pay'] || []).length, 1, 'вторият, поправен опит минава');
  window.close();
});

test('затварящ се прозорец не приема натискания', () => {
  /* Първата преграда е в самия стил: докато прозорецът избледнява, той е
     прозрачен, но иначе напълно жив за мишката. jsdom не смята попадения по
     стил, затова тук се проверява правилото, а поведението — с горните тестове. */
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  assert.match(css, /\.veil\.closing \.modal\{pointer-events:none\}/,
    'съдържанието на затварящия се прозорец трябва да спре да приема натискания');
  /* И ЗАВЕСАТА да НЕ е такава: с pointer-events:none върху нея щракването минава
     през прозореца и попада в страницата отдолу — проверено в Chromium, улучва
     „Върни книгата“, който не пита за потвърждение. */
  assert.equal(/\.veil\.closing\{[^}]*pointer-events:none/.test(css), false,
    'самата завеса трябва да поглъща натискането, а не да го пропуска надолу');
});

test('задържан Enter в затварящ се прозорец не праща записа втори път', async () => {
  /* Мишката я спира стилът, клавиатурата — не: pointer-events не важи за
     клавишите. Задържан Enter се повтаря на ~30 ms, а полетата на прозореца
     живеят още 140 ms след затварянето — точно толкова, колкото трябва за втори
     запис. Тук се повтаря самото действие с фокус, останал в умиращия прозорец
     (това прави и обработчикът на Enter). */
  const dom = payForm();
  const { window } = dom, d = window.document;
  await settle();
  window.payAccount(7);
  await settle();
  d.querySelector('#payF [name=amount]').value = '4.50';
  const field = d.querySelector('#payF [name=amount]');
  field.focus();
  window.savePayment(7);                       // първият Enter
  await new Promise(r => setTimeout(r, 40));   // записът мина, прозорецът избледнява
  assert.ok(d.querySelector('#veil2.closing'), 'прозорецът трябва да се затваря в този миг');
  assert.equal(d.activeElement === field || field.isConnected, true, 'полето още е там');
  window.savePayment(7);                       // повторението на задържания клавиш
  await settle();
  assert.equal((dom.calls['account.pay'] || []).length, 1,
    'повторението на клавиша не бива да плаща втори път');
  window.close();
});

test('прегледът преди печат държи фокуса при себе си, а не в прозореца отдолу', async () => {
  /* Прегледът се отваря ВЪРХУ отворен прозорец („Квитанция“ в сметката на
     читателя). Капанът от v2.4.44 познаваше само трите завеси и дърпаше фокуса
     в прозореца ОТДОЛУ: „Печат…“, „Запази PDF…“ и „Отказ“ ставаха недостижими
     с клавиатура — в кръга, който беше за достъпност. */
  const dom = buildDom({
    'readers.get': { id: 7, name: 'Иван Петров', card_no: '0007' },
    'account.get': { balance: -2, lines: [{ id: 3, date: '2026-09-01', type: 'глоба', amount: 2, note: '' }] },
    'settings.get': { lib_name: 'Библиотека' }
  });
  const { window } = dom, d = window.document;
  await settle();
  window.accountModal(7);
  await settle();
  [...d.querySelectorAll('#modal button')].find(b => b.textContent.trim() === 'Квитанция').click();
  await settle();
  const pp = d.getElementById('printPreview');
  assert.ok(pp.classList.contains('on'), 'прегледът трябва да е отворен');
  assert.ok(d.getElementById('veil').classList.contains('on'), 'а прозорецът отдолу — още отворен');

  const tab = (shift) => {
    const ev = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true });
    d.activeElement.dispatchEvent(ev);
    return ev;
  };
  const btns = [...pp.querySelectorAll('button')];
  btns[0].focus();
  tab(false);
  assert.equal(pp.contains(d.activeElement), true,
    'фокусът трябва да остане в прегледа, а не да слезе в прозореца отдолу');

  // На края на списъка капанът връща в началото, а не навън.
  btns[btns.length - 1].focus();
  const ev = tab(false);
  assert.equal(ev.defaultPrevented, true, 'на последния бутон Tab се пренасочва');
  assert.equal(d.activeElement, btns[0], 'обратно към първия бутон на прегледа');
  btns[0].focus();
  tab(true);
  assert.equal(d.activeElement, btns[btns.length - 1], 'Shift+Tab от първия отива на последния');
  window.close();
});

test('списъкът с проверките показва същото число като протокола', async () => {
  /* Приключването пази СНИМКА (scanned_final) — проверените СРЕЩУ обхвата.
     Списъкът обаче четеше суровия брой сканирания и до бутона „Протокол“
     стоеше друго число: „в обхвата 9 · проверени 7“ на екрана срещу
     „проверени 6“ на хартия. Тук се проверява самата заявка. */
  const Database = require('better-sqlite3');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-list-'));
  const db = new Database(path.join(dir, 'l.db'));
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  const handlers = new Map();
  require(path.join(APP_DIR, 'handlers', 'inventory-sessions.js'))(
    { handle: (c, f) => handlers.set(c, f) },
    { getDb: () => db, run: (fn) => ({ ok: true, data: fn() }), logAudit() {},
      pctRequired: () => 0, naturalLoss: () => 0, normalizeScanCode: (c) => String(c) });

  db.prepare(`INSERT INTO inventory_sessions (id, date, scope, closed, pool_final, scanned_final)
              VALUES (1, '2026-09-01', 'пълна', 1, 9, 6)`).run();
  db.prepare(`INSERT INTO inventory_sessions (id, date, scope, closed) VALUES (2, '2026-09-02', 'пълна', 0)`).run();
  db.prepare(`INSERT INTO inventory_sessions (id, date, scope, closed, pool_final) VALUES (3, '2026-08-01', 'пълна', 1, 4)`).run();
  for (let i = 1; i <= 7; i++) db.prepare('INSERT INTO books (id, inv_number, title) VALUES (?, ?, ?)').run(i, i, 'К' + i);
  for (let i = 1; i <= 7; i++) db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (1, ?)').run(i);
  for (let i = 1; i <= 3; i++) db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (2, ?)').run(i);
  for (let i = 1; i <= 4; i++) db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (3, ?)').run(i);

  const rows = handlers.get('inventorySessions:list')().data;
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by[1].scanned, 6, 'приключена сесия показва снимката (6), не суровите 7 сканирания');
  assert.equal(by[2].scanned, 3, 'текущата проверка се брои както досега — снимка още няма');
  assert.equal(by[3].scanned, 4, 'сесия отпреди снимката (NULL) също се брои както досега');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('времето на изчезване е на едно място, а не преписано', () => {
  /* Стилът и двата прозореца се водят по едно число; разминат ли се, дупката се
     отваря пак. */
  const core = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'core.js'), 'utf8');
  assert.match(core, /const MODAL_FADE_MS = 140;/);
  /* И трите слоя (modal, modal2 и въпросът) — иначе едно от числата тръгва само
     при следваща промяна и пазачът се разминава с изчезването. */
  assert.equal((core.match(/MODAL_FADE_MS\)/g) || []).length, 3,
    'и трите прозореца се махат по константата, а не по преписано число');
  assert.equal(/, 140\);/.test(core), false, 'никъде не бива да остане преписано 140');
});
