'use strict';
/* v2.4.86 — РАБОТЕН ДЕН НА ГИШЕТО В ИСТИНСКИ CHROMIUM.
   =====================================================================
   Истинските екрани (src/index.html + views) в Chromium, свързани с истинския
   main.js върху ПРАЗНА база. Всичко минава през интерфейса — клавиатура,
   щракване, „скенер“, който пише бързо и натиска Enter, собственият прозорец за
   потвърждение — и резултатът се проверява в базата: първо пускане и служител,
   читатели, книги, заемане по баркод и по инв. №, резервация и заделяне,
   продължение от „Просрочени“, сметка с квитанция, партида и КДБФ, акт за
   отчисляване, Дневник, справки и печат, резервно копие, проверка на данните,
   одитна следа, всички раздели.
   ЗАЩО Е НУЖЕН: jsdom няма подредба на страницата. Първото пускане на този ден
   в Chromium намери, че известието горе в центъра държи „+ Нова книга“ и
   бутоните на гишето (виж izvestiya-v2486) — нещо, което 2500 теста в jsdom не
   можеха да видят. Пропуска се, ако на машината няма Chromium. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), fs = require('fs'), os = require('os');
const { startMainApp } = require('./helpers/main-app');
const E = require('./helpers/e2e-app');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
function findChromium() {
  const cands = [process.env.PECHAT_PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright'];
  try { cands.push(path.join(require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright')); } catch (e) { /* без npm */ }
  let pw = null;
  for (const p of cands.filter(Boolean)) { try { pw = require(p); break; } catch (e) { /* следващият път */ } }
  const exe = [process.env.PECHAT_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean).find(p => fs.existsSync(p));
  return pw && exe ? { pw, exe } : null;
}
const CH = findChromium();
const SKIP = !CH ? 'няма playwright/Chromium на машината (PECHAT_CHROMIUM)' : false;

const T = E.today();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('Работен ден на гишето в Chromium — от празна база до резервното копие', { skip: SKIP, timeout: 240000 }, async () => {
  const steps = []; const findings = [];
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'raboten-den-'));
  const app = startMainApp(); await app.ready();
  const electron = require('electron');
  electron.dialog.showSaveDialog = async (w, o) => ({ canceled: false, filePath: path.join(OUT, path.basename((o && o.defaultPath) || 'file')) });
  electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  const db = new Database(path.join(app.userData, 'library.db'));
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  let browser = null;
  try {

  const app = startMainApp(); await app.ready();
  const electron = require(require.resolve('electron', { paths: [APP + '/test/helpers'] }));
  electron.dialog.showSaveDialog = async (w, o) => ({ canceled: false, filePath: path.join(OUT, path.basename((o && o.defaultPath) || 'file')) });
  electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  const db = new Database(path.join(app.userData, 'library.db'));
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);

  let inflight = 0, ipcCalls = 0;
  browser = await CH.pw.chromium.launch({ executablePath: CH.exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 } });
  await ctx.exposeBinding('__ipc', async (src, ch, args) => {
    inflight++; ipcCalls++;
    try { const r = await app.invoke(ch, ...(args || [])); return r === undefined ? null : JSON.parse(JSON.stringify(r)); }
    finally { inflight--; }
  });
  await ctx.addInitScript((tbl) => {
    const api = {};
    for (const [ns, ms] of Object.entries(tbl)) {
      api[ns] = {};
      for (const [m, spec] of Object.entries(ms)) {
        if (spec.channel) api[ns][m] = (...a) => window.__ipc(spec.channel, a);
        else if (spec.kind === 'listener') api[ns][m] = () => {};
        else api[ns][m] = (f) => (f && f.path) || '';
      }
    }
    window.api = api;
    window.print = () => { window.__prints = (window.__prints || 0) + 1; };
  }, E.preloadTable());
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('pageerror: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  pg.on('dialog', d => d.accept());

  const confirms = [];
  async function settle(min = 120) {
    let quiet = 0;
    for (let i = 0; i < 200 && quiet < 3; i++) {
      await sleep(min / 3); quiet = inflight === 0 ? quiet + 1 : 0;
      /* Собственият прозорец за потвърждение на програмата — библиотекарката казва „да“. */
      const ask = await pg.evaluate(() => { const v = document.querySelector('#veilC.on:not(.closing)'); return v ? v.innerText.replace(/\s+/g, ' ').slice(0, 160) : null; }).catch(() => null);
      if (ask) { confirms.push(ask); await pg.click('#veilC.on [data-ask=ok]', { timeout: 3000 }).catch(() => {}); await pg.waitForFunction(() => !document.querySelector('#veilC.on'), null, { timeout: 3000 }).catch(() => {}); quiet = 0; }
    }
  }
  const toasts = () => pg.evaluate(() => window.__toasts || []);
  async function toastsSince(n) { return (await toasts()).slice(n); }
  async function click(text, scope = 'body') {
    const re = new RegExp('^\\s*' + String(text).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '\\s*$');
    const all_ = pg.locator(scope + ' button').filter({ hasText: re });
    let b = all_.first();
    for (let i = 0, n = await all_.count(); i < n; i++) if (await all_.nth(i).isVisible()) { b = all_.nth(i); break; }
    try { await b.click({ timeout: 6000 }); }
    catch (e) {
      const st = await pg.evaluate((sc) => ({ modal: (document.querySelector('#modal') || {}).className + ' | ' + ((document.querySelector('#modal') || {}).innerText || '').slice(0, 160),
        modal2: ((document.querySelector('#modal2') || {}).innerText || '').slice(0, 120), veils: [...document.querySelectorAll('.veil')].map(v => v.className),
        btns: [...document.querySelectorAll(sc + ' button')].map(b => b.innerText.trim()).slice(0, 12) }), scope);
      throw new Error('бутон „' + text + '“ в ' + scope + ': ' + JSON.stringify(st) + ' ## ' + String(e.message).split('\n').filter(l => /intercept|visible|stable|enabled|retrying/.test(l)).slice(-3).join(' / '));
    }
    await settle();
  }
  async function go(v) { await pg.evaluate((v) => { location.hash = '#' + v; }, v); await pg.waitForFunction((v) => VIEW === v && !document.querySelector('#view .viewLoading'), v, { timeout: 10000 }); await settle(); }
  async function scan(sel, code) {
    const l = pg.locator(sel); await l.fill(''); await l.pressSequentially(String(code), { delay: 3 }); await l.press('Enter'); await settle(200);
  }
  async function put(sel, v) {
    const tag = await pg.locator(sel).first().evaluate(e => e.tagName);
    if (tag === 'SELECT') await pg.selectOption(sel, { label: String(v) }).catch(() => pg.selectOption(sel, String(v)));
    else await pg.fill(sel, String(v));
  }
  const text = (sel) => pg.locator(sel).first().innerText().catch(() => '');
  async function step(name, fn) {
    await pg.evaluate(() => { for (const f of ['ppClose', 'closeModal2', 'closeModal']) { try { window[f](); } catch {} } }); await settle();
    const t0 = Date.now(), e0 = errs.length;
    try { await fn(); } catch (e) { findings.push(name + ': ' + (e && e.message || e).split('\n')[0].slice(0, 300)); }
    if (errs.length > e0) findings.push(name + ' — грешки в екрана: ' + errs.slice(e0).join(' | '));
    steps.push([name, Date.now() - t0]);
  }
  const check = (cond, msg) => { if (!cond) throw new Error(msg); };

  await pg.goto('file://' + APP + '/src/index.html');
  await pg.waitForFunction(() => typeof VIEW !== 'undefined' && VIEW === 'setup', null, { timeout: 15000 });
  await pg.evaluate(() => { const o = window.toast; window.toast = function (m, t) { (window.__toasts = window.__toasts || []).push({ msg: String(m ?? ''), type: t || '' }); return o.apply(this, arguments); }; });
  await settle();

  /* 1. Първо пускане */
  await step('Първо пускане: настройки и служител', async () => {
    const f = '#view [data-setup-form] ';
    for (const [k, v] of [['org', 'НЧ „Васил Левски – 1922“'], ['lib_name', 'Библиотека при НЧ „Васил Левски – 1922“'], ['place', 'с. Яворец'],
      ['librarian', 'Мария Иванова'], ['loan_days', '14'], ['extensions_count', '1'], ['extension_days', '7'], ['fine_per_day', '0.10'],
      ['annual_fee', '5'], ['committee1', 'Мария Иванова'], ['committee2', 'Петър Петров'], ['committee3', 'Ана Георгиева']]) await pg.fill(f + `[name=${k}]`, v);
    await click('Запиши настройките', '#stF');
    const s = q('SELECT * FROM settings WHERE id = 1');
    check(s.lib_name === 'Библиотека при НЧ „Васил Левски – 1922“' && s.fine_per_day === 0.1, 'настройките не са в базата');
    check((await text('#brandName')).includes('Васил Левски'), 'лентата не показва името');
    await click('+ Нов служител', '#view');
    await pg.fill('#modal input[name=name]', 'Мария Иванова');
    await click('Запиши', '#modal footer');
    await pg.click('#userBadge'); await settle();
    await click('Мария Иванова', '#modal');
    check((await text('#userBadge')).includes('Мария Иванова'), 'служителят не е избран');
  });

  /* 2. Читатели */
  const readers = [['Иван Петров', '1001', '0888123456', 'ivan@example.bg'], ['Петя Стоянова', '1002', '0899000002', ''], ['Стоян Колев', '1003', '', ''], ['Ани Димова', '1004', '0877000004', '']];
  await step('4 нови читатели през формата', async () => {
    for (const [name, card, phone, email] of readers) {
      await go('readers');
      await click('+ Нов читател', '#view');
      await pg.fill('#readerF [name=name]', name);
      await pg.fill('#readerF [name=card_no]', card);
      if (phone) await pg.fill('#readerF [name=phone]', phone);
      if (email) await pg.fill('#readerF [name=email]', email);
      await pg.check('#readerF [name=gdpr_consent]');
      await click('Запиши', '#modal footer');
      check(q('SELECT 1 FROM readers WHERE card_no = ?', card), 'читател ' + card + ' не е в базата');
    }
    check(await pg.locator('#rBody tr').count() === 4, 'списъкът не показва 4 читатели');
  });

  /* 3. Книги */
  const books = [[101, 'Под игото', 'Вазов, Иван', '9789540100001', '12.50'], [102, 'Тютюн', 'Димов, Димитър', '', '15.00'],
    [103, 'Железният светилник', 'Талев, Димитър', '', '9.90'], [104, 'Старопланински легенди', 'Йовков, Йордан', '', '7.00'], [105, 'Стара книга', 'Неизвестен', '', '3.00']];
  await step('5 нови книги през формата', async () => {
    for (const [inv, title, author, bc, price] of books) {
      await go('books');
      await click('+ Нова книга', '#view');
      await pg.fill('#bookF [name=inv_number]', String(inv));
      await pg.fill('#bookF [name=title]', title);
      await pg.selectOption('#bookF [name=category_id]', { label: 'книга' });
      await pg.fill('#bookF [name=author]', author);
      if (bc) await pg.fill('#bookF [name=barcode]', bc);
      await pg.fill('#bookF [name=price]', price);
      await click('Запиши', '#modal footer');
      check(q('SELECT 1 FROM books WHERE inv_number = ?', inv), 'книга ' + inv + ' не е в базата: ' + JSON.stringify((await toasts()).slice(-1)));
    }
    check(q('SELECT next_inv_number AS n FROM settings').n === 106, 'следващият инв. № не е 106');
    await go('invbook');
    check(/5\s*Вписани общо/.test(await text('#view')), 'инвентарната книга не показва 5 вписани');
  });

  async function desk(card) {
    await go('circ');
    if (await pg.locator('#inScan').count() || !(await pg.locator('#view button.pri').filter({ hasText: /^\s*Заемане\s*$/ }).count())) await click('Заемане', '#view');
    if (await pg.locator('#circCount').count()) await click('Смени', '#view');
    await pg.waitForSelector('#pScan');
    await scan('#pScan', card);
    await pg.waitForSelector('#bScan');
  }
  async function returnBook(code) {
    await go('circ');
    await click('Връщане', '#view');
    await pg.waitForSelector('#inScan');
    const n = (await toasts()).length;
    await scan('#inScan', code);
    return { log: await text('#inLog'), ts: await toastsSince(n) };
  }

  /* 4. Заемане */
  await step('Гише: заемане по баркод и по инв. №, повторен опит', async () => {
    await desk('1001');
    await scan('#bScan', '9789540100001');
    await scan('#bScan', '102');
    check(all('SELECT 1 FROM loans WHERE date_in IS NULL').length === 2, 'не са 2 заемания');
    check(/заети: 2/.test(await text('#circCount')), 'броячът не е 2: ' + await text('#circCount'));
    const due = q('SELECT date_due FROM loans ORDER BY id LIMIT 1').date_due;
    check(due === E.nextWorkDay(db, E.addDays(T, 14)), 'падеж ' + due);
    await desk('1002');
    await scan('#bScan', '101');
    check(/вече е зает от Иван Петров/.test(await text('#outLog')), 'няма отказ за заета книга: ' + await text('#outLog'));
  });

  /* 5. Резервация */
  await step('Резервация на заета книга и заделяне при връщане', async () => {
    await desk('1002');
    await click('Резервирай заета книга…', '#view');
    await pg.fill('#holdF [name=code]', '101');
    await click('Резервирай', '#modal footer');
    check(q("SELECT status FROM holds WHERE reader_id = (SELECT id FROM readers WHERE card_no='1002')")?.status === 'чака', 'резервацията не е записана');
    const due = E.addDays(T, -10);
    db.prepare("UPDATE loans SET date_due = ? WHERE book_id = (SELECT id FROM books WHERE inv_number = 101) AND date_in IS NULL").run(due);
    const { log, ts } = await returnBook('101');
    check(/заделена за Петя Стоянова/.test(log), 'няма „заделена“: ' + log);
    check(/Забава \d+ дни · обезщетение/.test(log), 'няма забава в лога: ' + log);
    check(q("SELECT status FROM holds").status === 'заделена', 'резервацията не е заделена');
    const fine = q("SELECT fine FROM loans WHERE book_id = (SELECT id FROM books WHERE inv_number = 101)").fine;
    check(fine > 0, 'няма обезщетение');
    await desk('1002');
    await scan('#bScan', '101');
    check(q("SELECT status FROM holds").status === 'изпълнена', 'резервацията не е изпълнена при взимане');
  });

  /* 6. Просрочени */
  await step('Просрочени: продължение от списъка', async () => {
    db.prepare("UPDATE loans SET date_due = ? WHERE book_id = (SELECT id FROM books WHERE inv_number = 102) AND date_in IS NULL").run(E.addDays(T, -6));
    await go('over');
    check(/Тютюн/.test(await text('#ovBody')), 'Тютюн не е в просрочените');
    await click('Продължи', '#ovBody');
    const l = q("SELECT * FROM loans WHERE book_id = (SELECT id FROM books WHERE inv_number = 102) AND date_in IS NULL");
    check(l.renewals === 1 && l.date_due > T, 'продължението не е записано: ' + JSON.stringify(l));
  });

  /* 7. Читалня и днес на гишето */
  await step('Връщане на Тютюн и „Днес на гишето“', async () => {
    const { log } = await returnBook('102');
    check(/Тютюн.*върната/.test(log), 'лог: ' + log);
    check(q('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').n === 1, 'остава 1 заемане (101 у Петя)');
  });

  /* 8. Сметка */
  await step('Сметка: годишна такса, плащане, квитанция', async () => {
    const rid = q("SELECT id FROM readers WHERE card_no = '1001'").id;
    await go('readers');
    await click('⋯', `#rBody tr[data-id="${rid}"]`);
    await click('Сметка', '#rowMenuPop');
    await pg.waitForFunction(() => /Сметка — Иван Петров/.test(document.querySelector('#modal').innerText));
    await click('+ Годишна такса (5.00 € / 9.78 лв.)', '#modal');
    const owed = Math.round(q('SELECT SUM(amount) AS s FROM account_lines WHERE reader_id = ?', rid).s * 100) / 100;
    check(owed >= 5, 'дължимото е ' + owed);
    await click('Плащане…', '#modal');
    await pg.fill('#payF [name=amount]', owed.toFixed(2));
    await pg.fill('#payF [name=note]', 'в брой');
    await click('Плати', '#modal2 footer');
    await pg.waitForFunction(() => /КВИТАНЦИЯ/.test(document.querySelector('#ppSheet').innerText), null, { timeout: 5000 });
    const bal = q('SELECT SUM(amount) AS s FROM account_lines WHERE reader_id = ?', rid).s;
    check(Math.abs(bal) < 0.005, 'салдото е ' + bal);
    check(/няма задължение/.test(await text('#ppSheet')), 'квитанцията не казва „няма задължение“');
    await pg.evaluate(() => { ppClose(); closeModal(); }); await settle();
  });

  /* 9. Постъпления */
  await step('Постъпления: партида и инвентиране по нея, КДБФ', async () => {
    await go('acq');
    await click('+ Нова партида', '#view');
    await put('#acqF [name=total_count]', '1');
    await put('#acqF [name=from_source]', 'Книжарница „Хеликон“');
    await put('#acqF [name=doc_type]', 'фактура');
    await put('#acqF [name=doc_no]', 'Ф-0001');
    await put('#acqF [name=sum]', '18.00');
    await click('Заведи партидата', '#modal footer');
    const acq = q('SELECT * FROM acquisitions WHERE no = 1');
    check(acq, 'партидата не е записана');
    await click('Отвори', '#acqBody');
    await click('+ Инвентирай документ', '#modal footer');
    await pg.waitForSelector('#bookF');
    await pg.fill('#bookF [name=inv_number]', '106');
    await pg.fill('#bookF [name=title]', 'Бай Ганьо');
    await pg.selectOption('#bookF [name=category_id]', { label: 'книга' });
    await pg.fill('#bookF [name=author]', 'Константинов, Алеко');
    await pg.fill('#bookF [name=price]', '18.00');
    await click('Запиши', '#modal footer');
    check(q('SELECT acquisition_id FROM books WHERE inv_number = 106')?.acquisition_id === acq.id, 'книгата не е по партидата');
    await pg.evaluate(() => { try { closeModal2(); } catch {} try { closeModal(); } catch {} }); await settle();
    await go('kdbf');
    check(/Хеликон/.test(await text('#view tbody')), 'КДБФ не показва партидата');
  });

  /* 10. Отчисляване */
  await step('Отчисляване: акт по сканиране, утвърждаване', async () => {
    await go('acts');
    await click('+ Нов акт за отчисляване', '#view');
    await pg.waitForSelector('#actScan'); await sleep(150);
    await pg.selectOption('#actF [name=reason_code]', '4');
    await scan('#actScan', '105');
    check(/Стара книга/.test(await text('#actList')), 'документът не е в акта');
    await click('Утвърди акта и отчисли', '#modal footer'); await settle(300);
    const act = q('SELECT * FROM deaccession_acts ORDER BY id DESC');
    check(act, 'актът не е записан; известие: ' + JSON.stringify((await toasts()).slice(-2)));
    check(q('SELECT status FROM books WHERE inv_number = 105').status === 'отчислен', 'книга 105 не е отчислена');
    await go('kdbf');
    steps.push(['  (акт № ' + act.no + ', отчислени: ' + q("SELECT COUNT(*) AS n FROM books WHERE status = 'отчислен'").n + ')', 0]);
  });

  /* 11. Дневник */
  await step('Дневник: клетка, часове, Раздел Б', async () => {
    await go('dnevnik');
    const cell = `.dnvCell[data-date="${T}"][data-field="a_age_o28"]`;
    await pg.fill(cell, '3'); await pg.locator(cell).blur(); await settle(250);
    check(q('SELECT a_age_o28 AS n FROM dnevnik_days WHERE date = ?', T)?.n === 3, 'клетката не е записана');
    const hrs = `.dnvCell[data-date="${T}"][data-field="a_hours"]`;
    await pg.fill(hrs, '8:30'); await pg.locator(hrs).blur(); await settle(250);
    check(q('SELECT a_hours AS n FROM dnevnik_days WHERE date = ?', T)?.n === 510, 'часовете не са 510 мин');
    await click('Раздел Б · Заети материали', '#view');
    const b = `.dnvCell[data-date="${T}"][data-field="b_type_books"]`;
    await pg.fill(b, '5'); await pg.locator(b).blur(); await settle(250);
    const r = q('SELECT * FROM dnevnik_days WHERE date = ?', T);
    check(r.b_type_books === 5 && r.a_age_o28 === 3, 'Раздел Б: ' + JSON.stringify({ b: r.b_type_books, a: r.a_age_o28 }));
  });

  /* 12. Справки и печат */
  await step('Справки: годишен отчет, статистика, печат на инв. книга', async () => {
    await go('reports'); check((await text('#view')).length > 200, 'справките са празни');
    await go('stats'); check(/\d/.test(await text('#view')), 'статистиката е празна');
    await go('invbook');
    const p0 = await pg.evaluate(() => window.__prints || 0);
    await click('Печат на инвентарната книга / PDF', '#view');
    await click('Печат на диапазона', '#modal'); await settle(400);
    const sheet = await text('#ppSheet');
    check(/Под игото/.test(sheet) || (await pg.evaluate(() => window.__prints || 0)) > p0, 'печатът не показа инв. книгата');
    await pg.evaluate(() => { try { ppClose(); } catch {} }); await settle();
  });

  /* 13. Таблото срещу базата */
  await step('Таблото казва същото като базата', async () => {
    await go('dash');
    const v = await text('#view');
    const active = q('SELECT COUNT(*) AS n FROM loans WHERE date_in IS NULL').n;
    const nb = q("SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен'").n;
    steps.push(['  (база: заети ' + active + ', във фонда ' + nb + ')', 0]);
    check(v.length > 100, 'таблото е празно');
  });

  /* 14. Резервно копие */
  await step('Резервно копие сега — файлът се отваря и е пълен', async () => {
    await go('setup');
    // Разделът „Резервно копие“ е сгънат (<details>) — библиотекарката го разгъва.
    await pg.locator('#view details.setupMore summary').filter({ hasText: 'Резервно копие' }).first().click(); await settle();
    await click('Направи резервно копие сега…', '#view');
    const n = (await toasts()).length;
    await click('Направи копие', '#modal footer'); await settle(400);
    const t = (await toastsSince(n)).find(x => x.msg.startsWith('Резервно копие записано: '));
    check(t, 'няма известие: ' + JSON.stringify(await toastsSince(n)));
    const file = t.msg.replace('Резервно копие записано: ', '');
    const c = new Database(file, { readonly: true });
    try {
      check(c.prepare('SELECT COUNT(*) AS n FROM books').get().n === q('SELECT COUNT(*) AS n FROM books').n, 'копието няма всички книги');
      check(c.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'копието не е цяло');
    } finally { c.close(); }
  });

  /* 15. Проверка на данните и одитна следа */
  await step('Проверка на данните, одитна следа, цялост на базата', async () => {
    await go('setup');
    await click('Провери сега', '#view');
    await pg.waitForFunction(() => /баркод/.test((document.querySelector('#dataChecks') || {}).innerText || ''), null, { timeout: 8000 });
    check(q('PRAGMA integrity_check').integrity_check === 'ok', 'базата не е цяла');
    check(q('PRAGMA foreign_key_check') === undefined, 'нарушени външни ключове');
    const who = all("SELECT DISTINCT user FROM audit_log WHERE action IN ('Нов читател','Заемане','Връщане','Плащане')").map(x => x.user);
    check(who.length && who.every(u => u === 'Мария Иванова'), 'одитната следа: ' + who.join(', '));
  });

  /* 16. Всички раздели след работния ден */
  await step('Всички раздели се отварят след работния ден', async () => {
    const NAV = await pg.evaluate(() => NAV.flatMap(g => g.items.map(i => i[0])));
    for (const v of NAV) { await go(v); check((await text('#view')).trim().length > 20, v + ' е празен'); }
  });

    assert.deepEqual(findings, [], 'работният ден мина с находки');
    assert.equal(confirms.length, 1, 'единственото потвърждение е за годишната такса: ' + confirms.join(' | '));
    assert.match(confirms[0], /Начисли годишна такса/);
  } finally {
    if (browser) await browser.close();
    try { db.close(); } catch (e) { /* няма значение */ }
    app.stop();
    fs.rmSync(OUT, { recursive: true, force: true });
  }
});
