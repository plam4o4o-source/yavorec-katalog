'use strict';
/* Тестове на визуалния слой v1.69.0: съобщения (toast), преход при смяна на
   раздел, открояване на записан ред, анимирано затваряне на прозорците, SVG
   икони в навигацията и звуковия сигнал (beep).

   Харнесът е същият като views-regressions.test.js: истинският index.html +
   всички view-файлове в jsdom (runScripts: 'dangerously', истински <script>
   елементи), с „безопасен“ Proxy мок на window.api. Времената са РЕАЛНИ
   (никакви фалшиви таймери) — вижте бележката в views-pagination.test.js защо
   мок-таймерите на node:test не стигат до jsdom прозореца. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');
const VIEWS_DIR = path.join(SRC_DIR, 'views');

function scriptOrderFromIndexHtml() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script\s+src="views\/([^"]+)"/g)).map(m => m[1]);
}

function safeDefault() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return (hint) => (hint === 'string' ? '' : 0);
      if (prop === 'length') return 0;
      if (['toString', 'toLocaleString', 'valueOf', 'toFixed', 'toUpperCase',
        'toLowerCase', 'trim', 'charAt', 'padStart', 'padEnd', 'repeat',
        'replace', 'replaceAll'].includes(prop)) return () => '';
      if (['map', 'filter', 'slice', 'sort', 'concat', 'split', 'match', 'flat', 'flatMap'].includes(prop)) return () => [];
      if (prop === 'forEach') return () => {};
      if (prop === 'join') return () => '';
      if (prop === 'reduce') return (fn, init) => init;
      if (['some', 'includes'].includes(prop)) return () => false;
      if (prop === 'every') return () => true;
      if (['find', 'indexOf', 'search'].includes(prop)) return () => (prop === 'indexOf' || prop === 'search' ? -1 : undefined);
      if (typeof prop === 'symbol') return undefined;
      return safeDefault();
    }
  });
}

function apiMock(overrides) {
  function makeNode(parts) {
    const key = parts.join('.');
    return new Proxy(function () {}, {
      get(t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeNode(parts.concat(prop));
      },
      apply() {
        const data = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : safeDefault();
        return Promise.resolve({ ok: true, data });
      }
    });
  }
  return makeNode([]);
}

function buildDom(overrides) {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: 'file://' + SRC_DIR + '/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole
  });
  dom.jsErrors = errors;
  const { window } = dom;
  window.api = apiMock(overrides || {});
  window.confirm = () => true;
  window.prompt = () => { throw new Error('prompt() is not supported.'); };
  window.alert = () => {};
  window.print = () => {};
  window.document.querySelectorAll('script[src]').forEach(el => el.remove());
  const run = (src, label) => {
    const el = window.document.createElement('script');
    el.textContent = `//# sourceURL=${label}\n` + src;
    window.document.body.appendChild(el);
  };
  run(fs.readFileSync(path.join(SRC_DIR, 'udk.js'), 'utf8'), 'udk.js');
  for (const f of scriptOrderFromIndexHtml()) {
    run(fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8'), `views/${f}`);
  }
  if (errors.length) {
    assert.fail('грешки при зареждане:\n' + errors.map(e => e.stack || e.message).join('\n---\n'));
  }
  return dom;
}
const settle = () => new Promise(r => setTimeout(r, 30));

/* --- Съобщения (toast) --- */

test('грешките излизат горе в центъра (#toastsTop), успехите — долу вдясно (#toasts)', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom, d = window.document;
  window.toast('Записано.', 'ok');
  window.toast('Възникна грешка.', 'err');
  assert.equal(d.querySelectorAll('#toasts .toast.ok').length, 1, 'успехът не е долу вдясно');
  assert.equal(d.querySelectorAll('#toastsTop .toast.err').length, 1, 'грешката не е горе в центъра');
  // Грешката е откроена и за екранен четец: role="alert" (assertive), успехът — status.
  assert.equal(d.querySelector('#toastsTop .toast.err').getAttribute('role'), 'alert');
  assert.equal(d.querySelector('#toasts .toast.ok').getAttribute('role'), 'status');
});

test('съобщението има икона, бутон × за затваряне и лентичка-брояч', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom, d = window.document;
  window.toast('Проба.', 'err');
  const t = d.querySelector('#toastsTop .toast.err');
  assert.ok(t.querySelector('.tico'), 'липсва икона');
  assert.equal(t.querySelector('.tico').textContent, '✕');
  assert.ok(t.querySelector('.tx'), 'липсва бутон за затваряне');
  assert.ok(t.querySelector('.tprog'), 'липсва лентичка-брояч');
  // Бутонът × затваря веднага (с кратка изходна анимация .out).
  t.querySelector('.tx').click();
  assert.ok(t.classList.contains('out'), 'изходната анимация не е започнала');
  await new Promise(r => setTimeout(r, 320));
  assert.equal(d.querySelector('#toastsTop .toast.err'), null, 'съобщението не изчезна след ×');
});

test('повторно еднакво съобщение не трупа втора кутийка, а вдига брояч ×N', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom, d = window.document;
  window.toast('Записано.', 'ok');
  window.toast('Записано.', 'ok');
  window.toast('Записано.', 'ok');
  const all = d.querySelectorAll('#toasts .toast.ok');
  assert.equal(all.length, 1, 'еднаквите съобщения са се натрупали');
  assert.equal(all[0].querySelector('.tcount').textContent, '×3');
  // Различно съобщение обаче е отделна кутийка.
  window.toast('Друго.', 'ok');
  assert.equal(d.querySelectorAll('#toasts .toast.ok').length, 2);
});

test('успехът изчезва сам (~3.5 сек), а грешката стои още — 10-секунден живот', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom, d = window.document;
  window.toast('Готово.', 'ok');
  window.toast('Проблем!', 'err');
  await new Promise(r => setTimeout(r, 4200));
  assert.equal(d.querySelector('#toasts .toast.ok'), null, 'успехът не изчезна сам');
  assert.ok(d.querySelector('#toastsTop .toast.err'), 'грешката изчезна твърде рано — трябва да стои 10 сек');
});

/* --- Преход при смяна на раздел --- */

test('route() слага клас viewIn на #view (анимиран преход), а вътрешният rerender — не', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom, d = window.document;
  window.location.hash = '#readers';
  await settle();
  assert.ok(d.querySelector('#view').classList.contains('viewIn'), 'route() не сложи viewIn');
  // Вътрешно пререндиране (без route) не пипа класа: маха се ръчно и се вика renderReaders().
  d.querySelector('#view').classList.remove('viewIn');
  await window.renderReaders();
  assert.equal(d.querySelector('#view').classList.contains('viewIn'), false,
    'вътрешният rerender не бива да пуска прехода');
});

/* --- Открояване на записания ред --- */

test('редовете в „Книги“ и „Читатели“ носят data-id, а flashRow() слага и маха .rowFlash', async () => {
  const readers = [{ id: 7, name: 'Проба Пробова', phone: '', card_no: '11', category: 'възрастен', status: 'активен' }];
  const dom = buildDom({ 'readers.list': readers, 'searchHistory.suggest': [] });
  await settle();
  const { window } = dom, d = window.document;
  window.location.hash = '#readers';
  await settle();
  const row = d.querySelector('#rBody tr[data-id="7"]');
  assert.ok(row, 'редът на читателя няма data-id');
  window.flashRow('#rBody tr[data-id="7"]');
  await new Promise(r => setTimeout(r, 50)); // изчаква се requestAnimationFrame
  assert.ok(row.classList.contains('rowFlash'), 'flashRow не сложи класа');
  await new Promise(r => setTimeout(r, 1450));
  assert.equal(row.classList.contains('rowFlash'), false, 'класът не се маха след анимацията');
  // Несъществуващ ред не хвърля.
  window.flashRow('#rBody tr[data-id="99999"]');
});

/* --- Анимирано затваряне на прозорците --- */

test('closeModal() затваря с кратка анимация, а незабавно отворен нов прозорец не се губи', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom, d = window.document;
  window.modal('Проба', '<p id="mbody1">съдържание</p>');
  assert.ok(d.querySelector('#veil').classList.contains('on'));
  window.closeModal();
  assert.ok(d.querySelector('#veil').classList.contains('closing'), 'няма изходна анимация');
  // Нов прозорец ВЕДНАГА след затварянето: отложеното изчистване не бива да го изтрие.
  window.modal('Втори', '<p id="mbody2">ново съдържание</p>');
  await new Promise(r => setTimeout(r, 250));
  assert.ok(d.querySelector('#mbody2'), 'отложеното изчистване изтри новия прозорец');
  assert.ok(d.querySelector('#veil').classList.contains('on'));
  // Нормално затваряне: след анимацията съдържанието е изчистено.
  window.closeModal();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(d.querySelector('#veil').classList.contains('on'), false);
  assert.equal(d.querySelector('#modal').innerHTML, '');
});

/* --- SVG икони в навигацията --- */

test('всеки раздел в навигацията има SVG икона (stroke:currentColor), не емоджи', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom, d = window.document;
  window.drawNav();
  const links = d.querySelectorAll('#nav a');
  assert.ok(links.length >= 24, 'очакват се поне 24 раздела');
  for (const a of links) {
    const svg = a.querySelector('.ic svg');
    assert.ok(svg, 'раздел без SVG икона: ' + a.textContent.trim());
    assert.equal(svg.getAttribute('stroke'), 'currentColor', 'иконата не се боядисва от темата');
  }
});

/* --- Звуков сигнал --- */

test('beep() мълчи без AudioContext (тестова среда) и не хвърля', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom;
  assert.equal(window.AudioContext, undefined, 'предпоставката на теста — jsdom няма AudioContext');
  window.beep('ok');
  window.beep('err');
  // Изключен от настройките (scan_sound = 0) също мълчи, дори при наличен AudioContext.
  let constructed = 0;
  window.AudioContext = function () { constructed++; this.currentTime = 0; };
  // SETTINGS_CACHE е top-level let в класически <script> — не е property на window,
  // затова се задава през script елемент в същата глобална област (както харнесът
  // зарежда и самите view-файлове).
  const el = window.document.createElement('script');
  el.textContent = 'SETTINGS_CACHE = { scan_sound: 0 };';
  window.document.body.appendChild(el);
  window.beep('ok');
  assert.equal(constructed, 0, 'звукът не бива да се пуска при изключена настройка');
});

/* --- Задължителни полета (v1.70.0) --- */

test('fld() добавя видима звездичка при req:1, а не само атрибута required', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom;
  const html = window.fld('Заглавие', 'title', { val: '', req: 1 });
  assert.match(html, /required/, 'HTML атрибутът трябва да остане (полезен за autofill/семантика)');
  assert.match(html, /<b class="req"[^>]*>\*<\/b>/, 'липсва видимата звездичка в етикета');
  const htmlNoReq = window.fld('Бележка', 'note', { val: '' });
  assert.doesNotMatch(htmlNoReq, /class="req"/, 'звездичка не бива да се появява без req:1');
});

test('firstMissingRequired() намира първото празно задължително поле по видимия етикет (без звездичката/подсказката)', async () => {
  const dom = buildDom({}); await settle();
  const { window } = dom;
  const document = window.document;
  const box = document.createElement('div');
  box.id = 'testForm';
  box.innerHTML = window.fld('Инвентарен номер', 'inv_number', { val: '', req: 1 }) +
    window.fld('Заглавие', 'title', { val: 'Под игото', req: 1, hint: 'подсказка' });
  document.body.appendChild(box);

  assert.equal(window.firstMissingRequired('#testForm'), 'Инвентарен номер',
    'трябва да върне ЧИСТИЯ текст на етикета, без звездичката/hint span-а');

  document.querySelector('#testForm [name=inv_number]').value = '5';
  assert.equal(window.firstMissingRequired('#testForm'), null, 'всички задължителни полета вече са попълнени');
});
