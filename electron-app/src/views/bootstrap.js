/* ---------------- Bootstrap (зарежда се ПОСЛЕДЕН) ----------------
   Съдържа RENDERERS, route() и window.addEventListener('hashchange', route),
   извадени от предишната обща секция "Навигация" в app.js, плюс истинския
   стартов код (предишната секция "Старт").

   Защо трябва да е последен файл, зареден в index.html — а не просто там,
   където исторически стоеше в app.js:

   1) RENDERERS е const обект, чийто литерал прави ЕДНОКРАТЕН, НЕЗАБАВЕН
      прочит на ~23 идентификатора на функции (renderDash, renderBooks, …,
      renderChronicle, renderSetup) в момента на изпълнение на самия израз
      "const RENDERERS = {...}". В една монолитна script-а това е безопасно,
      защото hoisting-ът на function-декларации важи за целия файл наведнъж.
      Щом файлът е разделен на отделни <script> тагове обаче, hoisting-ът е
      само в рамките на всеки таг поотделно — ако RENDERERS се изпълни преди
      файлът с напр. renderChronicle да се е заредил, следва незабавна
      ReferenceError. Затова литералът на RENDERERS стои тук, зареден
      последен, след като всички view-файлове вече са дефинирали своите
      render-функции.
   2) window.addEventListener('hashchange', route) трябва route вече да е
      дефинирана В МОМЕНТА НА РЕГИСТРАЦИЯТА (не само при извикване), затова
      стои до route(), не в navigation.js.
   3) Самият стартов код (по-долу) вика route() вътре в .then() на промис —
      технически изпълнява се като microtask, който браузърът обработва
      веднага след текущата <script>, преди да продължи към СЛЕДВАЩИЯ таг.
      Ако този код не е в ПОСЛЕДНИЯ таг, route() може да бъде извикан преди
      по-късно зареждащи се view-файлове да са дефинирали съответната
      render-функция за текущия location.hash.
   ---------------------------------------------------------------- */

const RENDERERS = {
  dash: renderDash, books: renderBooks, invbook: renderInvBook,
  kdbf: renderKdbf, acq: renderAcq, acts: renderActs, invent: renderInvent,
  auth: renderAuth, readers: renderReaders, circ: renderCirc, over: renderOver, sugg: renderSuggestions,
  periodika: renderPeriodika, mzs: renderMzs, dnevnik: renderDnevnik,
  analytics: renderAnalytics, persons: renderPersons, chronicle: renderChronicle,
  stats: renderStats, reports: renderReports, catalog: renderCatalog, labels: renderLabels, odit: renderOdit, setup: renderSetup
};
async function route() {
  const h = (location.hash || '#dash').slice(1);
  VIEW = TITLES[h] ? h : 'dash';
  const t = TITLES[VIEW];
  $('#vTitle').textContent = t[0];
  $('#vSub').textContent = t[1];
  drawNav();
  // Лек преход (избледняване + плъзгане, v1.69.0) — САМО при истинска смяна
  // на раздел. Вътрешните пререндирания след запис викат render*() направо,
  // без route(), затова не мигат. Класът се сваля и слага наново, за да се
  // рестартира анимацията и при повторно влизане в същия раздел.
  const v = $('#view');
  if (v) { v.classList.remove('viewIn'); void v.offsetWidth; v.classList.add('viewIn'); }
  await RENDERERS[VIEW]();
}

window.addEventListener('hashchange', route);

/* ---------------- Старт ---------------- */
initUserBadge();
initAppCredit();
initSavedIndicator();
initAutoUpdateUI();
// При съвсем нова инсталация програмата отваря направо „Настройки“ — данните на
// библиотеката трябва да се въведат веднъж, преди да има смисъл от останалите раздели.
loadSettingsCache().then(s => {
  if (needsSetup(s) && !location.hash) location.hash = '#setup';
  route();
});
