'use strict';
/* v2.4.27 — шестнадесети кръг: пълен тест на работата (e2e харнес върху
   истинските обработчици — test/e2e-workflows.test.js), грешките и подобренията,
   плюс преустроените Настройки.
   =====================================================================
   Тук са регресионните тестове за поправките и подобренията, които не са в
   e2e файла: преустроените Настройки (раздели, търсене, адрес #setup/<раздел>,
   всички полета на settings:update стигат до обработчика), значката „Служител“
   след преименуване/деактивиране, Esc в askText, предложеният инвентарен номер и
   „Запиши и нов“, дневникът на таблото, „Заемане“ от списъка с читатели,
   предпазната мрежа за отхвърлени обещания, въпросът „кой работи“ при старт,
   ускорителите на менюто, изтичането на резервации при старт, регистърът .num.

   Всеки тест е проверен с мутация. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  APP_DIR, cleanupTmpDirs, fakeIpcMain, freshDb, runDep, buildDom, settle
} = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

const SETTINGS_MOCK = {
  'settings.get': { org: 'НЧ Тест', lib_name: 'Библиотека', place: 'с. Т', loan_days: 30, max_books: 5, next_inv_number: 12,
    committee1: 'А', theme: '1' },
  'dbLocation.get': { folder: 'C:\\x', isDefault: true }, 'backup.list': [], 'employees.list': [{ id: 1, name: 'Мария', active: 1 }],
  'categories.list': [], 'limits.usage': { books: 0, readers: 0, loans: 0, limitBooks: 0, limitReaders: 0 },
  'pdp.status': { configured: true, unlocked: false }, 'calendar.get': { workDays: [1, 2, 3, 4, 5], closed: [] },
  'circRules.list': [], 'gdpr.candidates': { years: 0, count: 0 }, 'backup.autoStatus': null,
  'av.categories': {}, 'av.options': {}, 'settings.noticeDefaults': { placeholders: [] }, 'app.getUser': 'Мария'
};

/* ==================================================================
   1. Настройки — преустроени
   ================================================================== */

async function openSetup(over, sub) {
  const calls = {};
  const dom = buildDom(Object.assign({}, SETTINGS_MOCK, over || {}));
  const { window } = dom;
  await settle();
  window.location.hash = '#setup' + (sub ? '/' + sub : '');
  await window.route();
  await settle();
  return { dom, window, calls };
}

test('Настройки: шест раздела, лява навигация, всички полета на settings:update стигат до обработчика', async () => {
  const { dom, window } = await openSetup();
  const doc = window.document;
  const secs = [...doc.querySelectorAll('.setupSec')].map(s => s.id);
  assert.deepEqual(secs, ['setup-biblioteka', 'setup-obsluzhvane', 'setup-fond', 'setup-lichni', 'setup-danni', 'setup-programa']);
  assert.equal(doc.querySelectorAll('.setupNav a[data-sec]').length, 6);
  assert.ok(doc.getElementById('stF'), '#stF остава (първият блок)');

  // Именуваните параметри на UPDATE-а в handlers/settings.js — ВСИЧКИ трябва да са
  // в блоковете [data-setup-form], иначе better-sqlite3 отказва целия запис.
  const sql = fs.readFileSync(path.join(APP_DIR, 'handlers', 'settings.js'), 'utf8');
  const params = [...new Set([...sql.matchAll(/@([a-z_0-9]+)/g)].map(m => m[1]))].filter(p => p !== 'id');
  const sent = window.setupFormData();
  for (const p of params) assert.ok(p in sent, 'полето „' + p + '“ липсва в блоковете [data-setup-form]');
  await window.loadPdpBox();
  assert.equal(doc.querySelector('[data-setup-form] input[name="password"]'), null, 'паролата не пътува към settings:update');

  // Записът от бутона в раздел „Обслужване“ праща и полетата от „Библиотека“.
  doc.querySelector('[data-setup-form] [name=loan_days]').value = '21';
  await window.saveSetup();
  await settle();
  const upd = (dom.calls['settings.update'] || [])[0];
  assert.ok(upd, 'settings:update е извикан');
  assert.equal(upd.loan_days, '21');
  assert.equal(upd.org, 'НЧ Тест', 'полетата от другия раздел пътуват заедно');
  assert.equal(upd.calDate, undefined, 'календарът не е настройка');
  for (const p of params) assert.ok(p in upd, 'параметърът „' + p + '“ липсва в заявката');
});

test('Настройки: празни организация И наименование се отказват преди заявката', async () => {
  const { dom, window } = await openSetup();
  window.document.querySelector('[data-setup-form] [name=org]').value = '';
  window.document.querySelector('[data-setup-form] [name=lib_name]').value = '';
  await window.saveSetup();
  await settle();
  assert.equal((dom.calls['settings.update'] || []).length, 0, 'без организация нищо не се праща');
});

test('Настройки: адресът #setup/lichni отваря раздела „Лични данни“ и го отбелязва в навигацията', async () => {
  const { window } = await openSetup({}, 'lichni');
  await new Promise(r => setTimeout(r, 30));
  const on = window.document.querySelector('.setupNav a.on');
  assert.ok(on, 'има отбелязан раздел');
  assert.equal(on.dataset.sec, 'lichni');
  assert.equal(window.eval('VIEW'), 'setup', 'подразделът не разваля разпознаването на раздела');
  // Веднъж: пречертаване след запис не връща страницата на посочения раздел.
  assert.equal(window.eval('ROUTE_SUB'), '', 'подразделът е консумиран');
  window.setupGo('fond');
  await window.renderSetup();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(window.document.querySelector('.setupNav a.on').dataset.sec, 'fond', 'след пречертаване остава там, където е библиотекарят');
});

test('Настройки: търсенето скрива картите без съвпадение и отваря свитите със съвпадение', async () => {
  const { window } = await openSetup();
  const doc = window.document;
  window.setupFilter('Defender');
  const av = [...doc.querySelectorAll('.setupMore')].find(d => /Антивирусна/.test(d.textContent));
  assert.ok(av && !av.hidden && av.open, 'свитата карта със съвпадение е видима и отворена');
  const lib = [...doc.querySelectorAll('.setupCard')].find(c => /Постоянна комисия/.test(c.textContent));
  assert.ok(lib.hidden, 'карта без съвпадение е скрита');
  assert.match(doc.getElementById('setupSearchHint').textContent, /1 съвпадение/);
  window.setupFilter('');
  assert.ok(!lib.hidden, 'изчистеното търсене връща всичко');
});

test('Настройки: значката за защитата на личните данни следва състоянието', async () => {
  const { window } = await openSetup({ 'pdp.status': { configured: true, unlocked: true } });
  await window.loadPdpBox();
  assert.equal(window.document.getElementById('chipPdp').textContent, 'защита: отключена');
});

test('регистър в карта: колоните .num не наследяват 32-пикселовите KPI числа', () => {
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  assert.match(css, /table\.ledger \.num\{[^}]*font-size:inherit/);
});

/* ==================================================================
   2. Служители — значката следва промяната
   ================================================================== */

test('преименуване/деактивиране/изтриване на текущия служител обновява „кой работи“', async () => {
  const { db } = freshDb('v2427-emp-badge-');
  let current = 'Иван';
  const ipcMain = fakeIpcMain();
  require(path.join(APP_DIR, 'handlers', 'employees'))(ipcMain, {
    getDb: () => db, run: runDep, logAudit: () => {},
    syncCurrentUser: (n) => { if (n !== undefined) current = n; return current; }
  });
  const id = db.prepare("INSERT INTO employees (name, active) VALUES ('Иван', 1)").run().lastInsertRowid;
  const other = db.prepare("INSERT INTO employees (name, active) VALUES ('Петя', 1)").run().lastInsertRowid;
  await ipcMain.invoke('employees:update', { id, name: 'Иван Петров' });
  assert.equal(current, 'Иван Петров', 'следата продължава на новото име');
  await ipcMain.invoke('employees:update', { id: other, name: 'Петя Г.' });
  assert.equal(current, 'Иван Петров', 'чужд служител не пипа значката');
  await ipcMain.invoke('employees:update', { id, active: 0 });
  assert.equal(current, '', 'деактивираният вече не подписва действията');
  current = 'Петя Г.';
  await ipcMain.invoke('employees:delete', other);
  assert.equal(current, '');
  const empty = await ipcMain.invoke('employees:update', { id, name: '   ' });
  assert.equal(empty.ok, false, 'празно име се отказва');
});

/* ==================================================================
   3. Екран: Esc в askText, „Запиши и нов“, табло, читатели, предпазна мрежа
   ================================================================== */

test('Esc в askText затваря само въпроса, не и формата отдолу', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settle();
  window.modal('Форма', '<input name="x">', '');
  const p = window.askText('Въпрос');
  await settle();
  assert.ok(window.document.getElementById('veil2').classList.contains('on'), 'въпросът е на втория слой');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await p, null, 'въпросът е отказан');
  await new Promise(r => setTimeout(r, 200));
  assert.ok(window.document.getElementById('veil').classList.contains('on'), 'формата отдолу остава отворена');
});

test('нов документ: инвентарният номер е предложен, „Запиши и нов“ пренася партидата', async () => {
  const created = [];
  const dom = buildDom({
    'settings.get': { org: 'X', next_inv_number: 77 }, 'categories.list': [], 'acquisitions.list': [{ id: 3, no: 1, year: '2026' }],
    'av.options': {}, 'books.create': ([d]) => { created.push(d); return 100 + created.length; }, 'books.list': { rows: [], total: 0 }
  });
  const { window } = dom;
  await settle();
  await window.loadSettingsCache();
  await window.bookForm(null, 3);
  await settle();
  const doc = window.document;
  assert.equal(doc.querySelector('#bookF [name=inv_number]').value, '77', 'следващият номер е предложен');
  const btn = [...doc.querySelectorAll('#modal button')].find(b => b.textContent.trim() === 'Запиши и нов');
  assert.ok(btn, 'има „Запиши и нов“');
  doc.querySelector('#bookF [name=title]').value = 'Първа';
  doc.querySelector('#bookF [name=price]').value = '5';
  await window.saveBook(null, true);
  await settle();
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'Първа');
  const again = doc.querySelector('#bookF');
  assert.ok(again, 'нова форма е отворена веднага');
  assert.equal(again.querySelector('[name=acquisition_id]').value, '3', 'партидата е пренесена');
  assert.equal(again.querySelector('[name=title]').value, '', 'заглавието — не');
  assert.ok(!/Още един екземпляр/.test(doc.querySelector('#modal').textContent), 'това не е копие на екземпляр');
  // Обикновеното „Запиши“ и после нова форма — номерът идва НАЖИВО от базата
  // (преглед на кръга: снимката SETTINGS_CACHE оставаше стара и втората книга
  // получаваше „вече е зает“).
  window.closeModal();
  // Снимката при старт казва 78; базата (books:create я е увеличила) — 79.
  let served = 0;
  const dom2 = buildDom({
    'settings.get': () => ({ org: 'X', next_inv_number: 78 + (served++ ? 1 : 0) }),
    'categories.list': [], 'acquisitions.list': [], 'av.options': {}, 'books.list': { rows: [], total: 0 }
  });
  await settle();
  assert.equal(dom2.window.eval('SETTINGS_CACHE.next_inv_number'), 78, 'снимката е стара');
  await dom2.window.bookForm(null);
  await settle();
  assert.equal(dom2.window.document.querySelector('#bookF [name=inv_number]').value, '79', 'формата чете наживо');
  const edit = buildDom({ 'settings.get': { org: 'X', next_inv_number: 78 }, 'categories.list': [], 'acquisitions.list': [], 'av.options': {},
    'books.get': { id: 9, inv_number: 5, title: 'Стара', price: 1 } });
  await settle();
  await edit.window.bookForm(9);
  await settle();
  assert.ok(![...edit.window.document.querySelectorAll('#modal button')].some(b => b.textContent.trim() === 'Запиши и нов'),
    'при редакция няма „Запиши и нов“');
});

test('таблото знае дали дневникът за днес е попълнен', async () => {
  const { db } = freshDb('v2427-dash-dnevnik-');
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db, run: runDep, today: () => '2026-09-04', LOAN_SELECT: require('./helpers/prod-values.js').LOAN_SELECT,
    isWorkDay: () => true, effectiveDaysLate: () => 0, countOverduePeriodicals: () => 0, pctRequired: () => 10,
    yearOf: () => '2026'
  };
  require(path.join(APP_DIR, 'handlers', 'dashboard'))(ipcMain, deps);
  const before = await ipcMain.invoke('dashboard:full');
  assert.equal(before.ok, true, before.error);
  assert.equal(before.data.today.dnevnikFilled, false);
  db.prepare("INSERT INTO dnevnik_days (date, a_visit_reading) VALUES ('2026-09-04', 3)").run();
  const after = await ipcMain.invoke('dashboard:full');
  assert.equal(after.data.today.dnevnikFilled, true);
});

test('дневникът за днес, попълнен от таблото, връща таблото — не месечната таблица', async () => {
  const dom = buildDom({
    'settings.get': { org: 'X' }, 'dashboard.full': null,
    'dnevnik.getMonth': ([a]) => ({ year: a.year, month: a.month, daysInMonth: 30, days: [], monthTotal: {}, ytdTotal: {} }),
    'dnevnik.saveDay': true, 'dnevnik.suggest': null
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#dash';
  await window.route();
  await settle();
  await window.dnevnikDayForm('2026-09-04');
  await settle();
  assert.ok(window.document.querySelector('#dnvF'), 'формата е отворена от таблото');
  await window.saveDnevnikDay();
  await settle();
  assert.equal(window.eval('VIEW'), 'dash');
  assert.doesNotMatch(window.document.getElementById('view').textContent, /Всичко за месеца/, 'таблото не е заместено от дневника');
});

test('списъкът с читатели има „Заемане“, което отваря гишето с избрания читател', async () => {
  const dom = buildDom({
    'readers.list': [{ id: 5, name: 'Ана', card_no: 'K5', category: 'възрастен', status: 'активен' }], 'settings.get': { org: 'X' },
    'readers.get': { id: 5, name: 'Ана', category: 'възрастен' }, 'loans.byReader': [], 'holds.byReader': [],
    'circRules.effective': { loan_days: 14 }, 'account.get': { lines: [], balance: 0 }
  });
  const { window } = dom;
  await settle();
  window.location.hash = '#readers';
  await window.route();
  await settle();
  const btn = [...window.document.querySelectorAll('#rBody button')].find(b => b.textContent.trim() === 'Заемане');
  assert.ok(btn, 'бутонът е в реда');
  btn.click();
  await settle();
  assert.equal(window.eval('CIRC.readerId'), 5);
});

test('отхвърлено обещание без обработка стига до библиотекаря като известие', async () => {
  const dom = buildDom({});
  const { window } = dom;
  await settle();
  const seen = [];
  window.toast = (m, t) => seen.push({ m, t });
  const ev = new window.Event('unhandledrejection');
  ev.reason = new Error('no such table: x');
  window.dispatchEvent(ev);
  assert.ok(seen.some(x => /Неочаквана грешка: no such table/.test(x.m)), JSON.stringify(seen));
});

test('при старт без избран служител, но с активни служители, програмата пита кой работи', async () => {
  const dom = buildDom({ 'settings.get': { org: 'X', lib_name: 'Б' }, 'app.getUser': '',
    'employees.list': [{ id: 1, name: 'Мария', active: 1 }], 'dashboard.get': null });
  const { window } = dom;
  await settle();
  await new Promise(r => setTimeout(r, 120));
  assert.match(window.document.getElementById('modal').textContent, /Кой служител работи в момента/);
  // А с избран служител — не пита.
  const dom2 = buildDom({ 'settings.get': { org: 'X', lib_name: 'Б' }, 'app.getUser': 'Мария',
    'employees.list': [{ id: 1, name: 'Мария', active: 1 }], 'dashboard.get': null });
  await settle();
  await new Promise(r => setTimeout(r, 120));
  assert.doesNotMatch(dom2.window.document.getElementById('modal').textContent, /Кой служител работи/);
});

/* ==================================================================
   4. main.js и страничните файлове — по източник, където поведението не е
      достъпно от тест (Electron меню, старт, мобилната страница)
   ================================================================== */

const MAIN = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');

test('main.js: скритото меню губи ускорителите Ctrl+R / Ctrl+Shift+I / F11, но пази мащаба', () => {
  assert.match(MAIN, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(/);
  const tpl = MAIN.slice(MAIN.indexOf('Menu.buildFromTemplate('), MAIN.indexOf('Menu.buildFromTemplate(') + 400);
  assert.doesNotMatch(tpl, /reload|toggleDevTools|togglefullscreen/);
  assert.match(tpl, /zoomIn/);
  assert.match(MAIN, /const \{ app, BrowserWindow, ipcMain, dialog, net, shell, Menu \} = require\('electron'\)/);
});

test('main.js: изтичането на резервации при старт не може да спре стартирането', () => {
  assert.match(MAIN, /try \{ expireStaleHolds\(\); \} catch \(e\)/);
});

test('main.js: при затваряне каталогът се пише само ако има насрочен запис', () => {
  assert.match(MAIN, /if \(catalogWriteDebouncer\.pending\(\)\) flushCatalogWrite\(\);/);
});

test('мобилното сканиране приема същия баркод повторно едва когато е излязъл от кадъра', () => {
  const html = fs.readFileSync(path.join(APP_DIR, 'src', 'mobile-template.html'), 'utf8');
  assert.doesNotMatch(html, /lastAt > 2000/);
  assert.match(html, /if \(v !== last\) \{ last = v; addCode\(v\); \}/);
  assert.match(html, /\+\+misses >= 3/);
  assert.match(html, /last = ''; misses = 0;/);
});

test('лентата вляво се побира на 768 px височина', () => {
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  assert.match(css, /@media \(max-height:780px\)\{[\s\S]*?\.brandIcon\{display:none\}/);
});
