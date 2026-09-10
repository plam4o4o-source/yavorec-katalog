'use strict';
/* v2.4.50 — всичките 24 раздела срещу ИСТИНСКИТЕ обработчици и истинска база.
   =====================================================================
   Новото поведение на route() (мястото се изчиства и се обявява провал, когато
   рендерът излезе тихо) стъпва на предположението, че при работеща база НИТО
   ЕДИН раздел не излиза по тихия път. Ако някой обработчик връща null при
   съвсем нормални данни, библиотекарката ще вижда червено „Разделът не се
   зареди“ там, където дотук просто е нямало нищо — по-лошо от изходното
   положение. Затова се проверява, а не се приема на доверие: с api-заместител
   такава грешка изобщо не се вижда. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./helpers/e2e-app');

const РАЗДЕЛИ = ['dash', 'books', 'invbook', 'kdbf', 'acq', 'acts', 'invent', 'auth',
  'readers', 'circ', 'over', 'sugg', 'periodika', 'mzs', 'dnevnik', 'analytics',
  'persons', 'chronicle', 'stats', 'reports', 'catalog', 'labels', 'odit', 'setup'];

/* Харнесът е ЕДИН за процеса и държи отворена база и прозорец: ако не се спре,
   node --test чака до безкрай. Затварянето стои в after на файла, а не в края на
   последния тест — паднал тест иначе оставя процеса да виси (случи се при
   мутационната проверка: две висящи стартирания по 30+ минути). */
test.after(async () => { try { (await bootApp()).stop(); } catch (e) { /* нямаше какво да се спира */ } });

test('всеки раздел се изчертава при истинска база — никъде „Разделът не се зареди“', async () => {
  const A = await bootApp();
  const провали = [];
  for (const v of РАЗДЕЛИ) {
    await A.go(v);
    await A.settle();
    const d = A.document;
    if (d.querySelector('.viewFailed')) провали.push(v + ': червена кутия „не се зареди“');
    else if (d.querySelector('.viewLoading')) провали.push(v + ': остана на „Зарежда се…“');
    else if (!d.querySelector('#view').children.length) провали.push(v + ': празно място');
  }
  assert.deepEqual(провали, [], 'раздели, които не се изчертаха:\n' + провали.join('\n'));
});

test('смяната на раздел не оставя чуждото съдържание под новото заглавие', async () => {
  const A = await bootApp();
  await A.go('books'); await A.settle();
  assert.ok(A.document.querySelector('#bBody'), 'фондът се зареди');
  await A.go('readers'); await A.settle();
  assert.equal(A.document.querySelector('#bBody'), null, 'таблицата на фонда си отиде');
  assert.ok(A.document.querySelector('#rBody'), 'на нейно място е таблицата на читателите');
  assert.equal(A.document.querySelector('#vTitle').textContent, 'Читатели');
});

test('менюто „⋯“ на реда работи и с истински данни', async () => {
  const A = await bootApp();
  const d = A.document;
  /* Един читател през истинския обработчик, за да има ред в таблицата. */
  const r = await A.api.readers.create({ name: 'Проверков, Проверко', category: 'възрастен', status: 'активен' });
  assert.ok(r.ok, JSON.stringify(r));
  await A.go('readers'); await A.settle();
  const btn = d.querySelector('#rBody .rowMore');
  assert.ok(btn, 'редът има копче „⋯“');
  A.window.rowMenu(btn);
  const pop = d.getElementById('rowMenuPop');
  assert.ok(pop.classList.contains('on'));
  assert.deepEqual([...pop.querySelectorAll('button')].map(b => b.textContent.trim()),
    ['Картон', 'Читателска карта', 'Сметка', 'Изтрий']);
  /* Действието от менюто наистина отваря прозореца на сметката — тоест onclick-ът
     е пренесен цял, а не само надписът. */
  [...pop.querySelectorAll('button')].find(b => b.textContent.trim() === 'Сметка')
    .dispatchEvent(new A.window.MouseEvent('click', { bubbles: true }));
  await A.settle();
  assert.match(A.modal(), /Сметка|Проверков/, 'отвори се сметката на читателя: ' + A.modal().slice(0, 80));
  A.window.closeModal(); await A.settle();
});
