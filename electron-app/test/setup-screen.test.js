'use strict';
/* v2.4.47 — екранът „Настройки“: залепено меню и прибиращи се раздели.
   =====================================================================
   Двете промени са по заявка на библиотеката:

   • Менюто вляво (заедно с полето за търсене в него) да остава на екрана при
     превъртане. То ВЕЧЕ беше position:sticky, но с top:0 — същото място, на
     което стои и горната лента (#topbar, също sticky, z-index:10). Измерено в
     истински Chromium при 1366×768: лентата е 89 px, менюто се залепваше на
     0 px, а elementFromPoint върху първия му ред връщаше самата лента — тоест
     търсенето и първият раздел стояха СКРИТИ зад нея. Оттук нататък менюто
     паркира под лентата, по измерена (не преписана) височина.

   • „Календар на библиотеката“, „Резервно копие“ и „Категории“ да се прибират
     като останалите настройки — те са неща, които се пипат рядко, а стояха
     разгънати и бутаха надолу всичко останало.

   Самото залепване (оформление) не се проверява тук: jsdom не смята оформление.
   Затова се проверяват правилото и функцията, която му дава числото, а
   поведението е измерено в браузър при подготовката на промяната. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, cleanupTmpDirs, buildDom, settle } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

const SETTINGS_MOCK = {
  'settings.get': { org: 'НЧ Тест', lib_name: 'Библиотека', place: 'с. Т', loan_days: 30, max_books: 5,
    next_inv_number: 12, committee1: 'А', theme: '1' },
  'dbLocation.get': { folder: 'C:\\x', isDefault: true },
  'backup.list': [], 'employees.list': [{ id: 1, name: 'Мария', active: 1 }],
  'categories.list': [], 'limits.usage': { books: 0, readers: 0, loans: 0, limitBooks: 0, limitReaders: 0 },
  'pdp.status': { configured: true, unlocked: false }, 'calendar.get': { workDays: [1, 2, 3, 4, 5], closed: [] },
  'circRules.list': [], 'gdpr.candidates': { years: 0, count: 0 }, 'backup.autoStatus': null,
  'av.categories': {}, 'av.options': {}, 'settings.noticeDefaults': { placeholders: [] }, 'app.getUser': 'Мария'
};

async function openSetup(over) {
  const dom = buildDom(Object.assign({}, SETTINGS_MOCK, over || {}));
  const { window } = dom;
  await settle();
  window.location.hash = '#setup';
  await window.route();
  await settle();
  return dom;
}
const more = (d, title) => [...d.querySelectorAll('.setupMore')]
  .find(x => x.querySelector('.setupMoreTitle').textContent === title);

/* ---------------- прибиращите се раздели ---------------- */

test('календарът, резервното копие и категориите се прибират като останалите', async () => {
  const dom = await openSetup();
  const d = dom.window.document;
  for (const title of ['Календар на библиотеката', 'Резервно копие', 'Категории (видове документи)']) {
    const det = more(d, title);
    assert.ok(det, 'разделът „' + title + '“ трябва да е прибиращ се (details.setupMore)');
    assert.equal(det.tagName, 'DETAILS');
    assert.equal(det.open, false, '„' + title + '“ стои прибран, докато не потрябва');
    assert.ok(det.querySelector('.setupMoreSum').textContent.trim(),
      'свитият ред трябва да казва нещо за съдържанието си, а не само заглавие');
  }
  /* И не са изчезнали: съдържанието им е вътре, само прибрано. */
  assert.ok(d.getElementById('calWorkDays'), 'работните дни се пълнят в календара');
  assert.ok(d.getElementById('calClosedBox'), 'затворените дни също');
  assert.ok(d.getElementById('autoBkBox'), 'кутията за автоматичното копие остава');
  assert.match(more(d, 'Категории (видове документи)').textContent, /Нова категория/);
  dom.window.close();
});

test('свитият ред казва колко са категориите и кога е последното копие', async () => {
  const dom = await openSetup({
    'categories.list': [{ id: 1, name: 'книга' }, { id: 2, name: 'CD' }, { id: 3, name: 'DVD' }],
    'backup.list': [{ name: 'library-2026-09-08.db', mtime: Date.parse('2026-09-08T10:00:00Z'), size: 4200000, auto: 1 },
      { name: 'library-2026-09-07.db', mtime: Date.parse('2026-09-07T10:00:00Z'), size: 4100000, auto: 1 }]
  });
  const d = dom.window.document;
  assert.equal(more(d, 'Категории (видове документи)').querySelector('.setupMoreSum').textContent, '3 вида документи');
  const bk = more(d, 'Резервно копие').querySelector('.setupMoreSum').textContent;
  assert.match(bk, /08\.09\.2026/, 'датата на последното копие: ' + bk);
  assert.match(bk, /2 копия/, bk);
  dom.window.close();
});

test('празните списъци не показват число, а казват че няма', async () => {
  const dom = await openSetup();
  const d = dom.window.document;
  assert.equal(more(d, 'Категории (видове документи)').querySelector('.setupMoreSum').textContent, 'няма въведени');
  assert.equal(more(d, 'Резервно копие').querySelector('.setupMoreSum').textContent, 'няма направени копия');
  dom.window.close();
});

test('търсенето отваря и трите нови прибрани раздела', async () => {
  /* Прибраното съдържание не бива да стане ненамираемо — заради това търсенето
     отваря съвпадналите. Проверява се точно за новите три. */
  const dom = await openSetup();
  const { window } = dom, d = window.document;
  for (const [q, title] of [['затворени дни', 'Календар на библиотеката'],
    ['възстанови', 'Резервно копие'], ['видове документи', 'Категории (видове документи)']]) {
    window.setupFilter(q);
    const det = more(d, title);
    assert.equal(det.hidden, false, 'по „' + q + '“ трябва да се намери „' + title + '“');
    assert.equal(det.open, true, 'и да се отвори, иначе намереното не се вижда');
    window.setupFilter('');
  }
  dom.window.close();
});

test('отворените раздели остават отворени и след пречертаване', async () => {
  /* renderSetup() се вика наново след всеки запис. Ако прибирането връща
     всичко в изходно положение, работата в отворен раздел става невъзможна. */
  const dom = await openSetup();
  const { window } = dom, d = window.document;
  more(d, 'Календар на библиотеката').open = true;
  await window.renderSetup();
  await settle();
  assert.equal(more(window.document, 'Календар на библиотеката').open, true);
  assert.equal(more(window.document, 'Резервно копие').open, false, 'останалите не се отварят сами');
  dom.window.close();
});

/* ---------------- залепеното меню ---------------- */

test('менюто на настройките паркира ПОД горната лента, а не на нейното място', () => {
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  const rule = css.match(/\.setupNav\{[\s\S]*?\}/)[0];
  assert.match(rule, /position:sticky/, 'менюто се движи със страницата и остава на екрана');
  assert.equal(/top:0/.test(rule), false,
    'top:0 е мястото на самата горна лента — менюто минаваше под нея');
  assert.match(rule, /top:calc\(var\(--topbar-h/, 'отстоянието се води по височината на лентата');
  assert.match(rule, /max-height:calc\(100vh - var\(--topbar-h/,
    'дългото меню трябва да може да се превърта, иначе долните раздели са недостижими');
  assert.match(rule, /overflow-y:auto/);
});

test('височината на горната лента се МЕРИ, а не се преписва', async () => {
  /* 89 px в CSS е само резервна стойност: лентата се преоразмерява с темата, с
     мащаба на Windows и когато заглавието се пренесе на два реда. */
  const dom = buildDom(SETTINGS_MOCK);
  const { window } = dom, d = window.document;
  await settle();                 // изчаква пускането, иначе то дописва след теста
  const bar = d.getElementById('topbar');
  bar.getBoundingClientRect = () => ({ height: 123, top: 0, bottom: 123, left: 0, right: 0, width: 0 });
  window.setTopbarH();
  assert.equal(d.documentElement.style.getPropertyValue('--topbar-h'), '123px');

  // Нулева височина (скрита лента при печат) не бива да зачертава стойността.
  bar.getBoundingClientRect = () => ({ height: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0 });
  window.setTopbarH();
  assert.equal(d.documentElement.style.getPropertyValue('--topbar-h'), '123px');
  dom.window.close();
});

test('преоразмеряването на прозореца наистина преизчислява височината', async () => {
  /* Не се проверява текстът на кода: регистриран, но мъртъв слушател би минал
     през грепа. Тук се вдига истинско събитие и се гледа стойността. */
  const dom = buildDom(SETTINGS_MOCK);
  const { window } = dom, d = window.document;
  await settle();
  const bar = d.getElementById('topbar');
  bar.getBoundingClientRect = () => ({ height: 150, top: 0, bottom: 150, left: 0, right: 0, width: 0 });
  window.dispatchEvent(new window.Event('resize'));
  await new Promise(r => setTimeout(r, 200));       // слушателят е с изчакване (debounce 120 ms)
  assert.equal(d.documentElement.style.getPropertyValue('--topbar-h'), '150px',
    'след промяна на прозореца менюто трябва да се води по новата височина');
  dom.window.close();
});

test('смяната на раздел също преизчислява височината — заглавието мени лентата', async () => {
  /* „Книга за движение на библиотечния фонд“ се пренася на два реда и прави
     лентата 119 px вместо 89 px (измерено при 1200 px). Ако числото се мери
     само при пускане, менюто на настройките паркира на чуждо място. */
  const dom = buildDom(SETTINGS_MOCK);
  const { window } = dom, d = window.document;
  await settle();
  const bar = d.getElementById('topbar');
  bar.getBoundingClientRect = () => ({ height: 119, top: 0, bottom: 119, left: 0, right: 0, width: 0 });
  window.location.hash = '#setup';
  await window.route();
  await settle();
  assert.equal(d.documentElement.style.getPropertyValue('--topbar-h'), '119px');
  dom.window.close();
});

test('превъртането до раздел от менюто не го скрива зад лентата', () => {
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  const rule = css.match(/\.setupSec\{[^}]*\}/)[0];
  assert.match(rule, /scroll-margin-top:calc\(var\(--topbar-h/,
    'иначе scrollIntoView оставя началото на раздела под залепената лента');
  assert.equal(/scroll-margin-top:8px/.test(rule), false);
});

test('менюто има място за пръстена на фокуса, който изрязва', () => {
  /* overflow-y:auto прави кутията изрязваща и по хоризонтала; пръстенът е
     2 px + 1 px отстояние. */
  const css = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
  const rule = css.match(/\.setupNav\{[\s\S]*?\}/)[0];
  const pad = rule.match(/padding:(\d+)px/);
  assert.ok(pad && Number(pad[1]) >= 3, 'нужни са поне 3 px отстояние: ' + rule);
});
