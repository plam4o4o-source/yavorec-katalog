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
  /* #раздел/подраздел (v2.4.27, A10): „#setup/lichni“ отваря Настройки и превърта
     до секцията — таблото и картонът на читателя вече не оставят библиотекаря
     най-отгоре на дълга страница. Подразделът стои в ROUTE_SUB за изгледа. */
  const full = (location.hash || '#dash').slice(1);
  const slash = full.indexOf('/');
  const h = slash >= 0 ? full.slice(0, slash) : full;
  ROUTE_SUB = slash >= 0 ? full.slice(slash + 1) : '';
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
  /* v2.4.31 (производителност): рестартът на анимацията ставаше с принудително
     преизчисление на подредбата (`void v.offsetWidth`) върху СТАРОТО съдържание —
     при таблица от 300 реда (5 000 възела) това са ~90 ms на всяко превключване
     на раздел, преди новият изобщо да е поискан от базата. Класът остава (стилът
     и тестовете разчитат на него), а рестартът минава през Web Animations —
     cancel() на текущата анимация не изисква подредба. */
  if (v) {
    if (v.getAnimations) v.getAnimations().forEach(a => a.cancel());
    v.classList.add('viewIn');
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof v.animate === 'function' && !reduced) {
      v.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
    }
  }
  await RENDERERS[VIEW]();
  /* Височината на горната лента се мери и ТУК, а не само при пускане и при
     преоразмеряване: тя зависи от заглавието на раздела, а то се сменя точно
     тук. Измерено при 1200 px: „Настройки“ дава лента 89 px, а „Книга за
     движение на библиотечния фонд“ се пренася на два реда и дава 119 px. Без
     това залепеното меню и превъртането до раздел се водят по старото число. */
  setTopbarH();
}

window.addEventListener('hashchange', route);

/* Предпазна мрежа за отхвърлени обещания (одит v2.4.27): грешка ПРЕДИ try-а на
   async обработчик (напр. getDb().prepare преди try в catalog:gitPublishNow)
   отхвърляше invoke-а, call() не я хващаше и бутонът „не правеше нищо“. Тук тя
   поне стига до библиотекаря като известие. */
window.addEventListener('unhandledrejection', (e) => {
  const msg = e && e.reason && (e.reason.message || String(e.reason));
  if (msg && typeof toast === 'function') toast('Неочаквана грешка: ' + msg, 'err');
});

/* ---------------- Старт ---------------- */
/* ============================================================================
   ЕДНО ЩРАКВАНЕ = ЕДНО ВПИСВАНЕ (v2.4.44)
   ----------------------------------------------------------------------------
   Бутоните в прозорците не се заключваха, докато записът тече, а closeModal()
   маха прозореца чак след 140 ms (плавното затваряне). При обикновено двойно
   щракване второто попадение хваща жив бутон над още попълнена форма и
   действието тръгва ВТОРИ ПЪТ. Проверено в jsdom: „Плати“ с 4,50 лв. праща
   account.pay два пъти и читателят е кредитиран с 9,00 лв.; „Впиши посещения“
   праща visits.add два пъти, а handlers/visits.js събира (count = count + нов) —
   50 посещения стават 100 в официалната статистика. Нищо не се вижда на екрана:
   няма грешка, няма второ съобщение.

   Затова тук — а не на двайсет места — всяко действие, което ВПИСВА нов ред, се
   обвива веднъж: докато повикването не приключи, повторните извиквания се
   пренебрегват, а натиснатият бутон стои недостъпен. Файлът се зарежда последен
   (виж бележката най-горе), затова функциите вече съществуват.

   Списъкът е ИЗРИЧЕН, а не по име: тест проверява, че всяко име тук съществува —
   преименувана функция иначе би останала без пазач, без нищо да се счупи. */
const ONCE_ACTIONS = [
  'savePayment', 'saveCharge', 'chargeAnnualFee',      // пари по сметката на читателя
  'saveVisits',                                        // официална статистика за посещенията
  'saveBook', 'saveReader', 'saveAcq', 'saveAct',      // фонд, КДБФ, отчисляване
  'saveAnalytic', 'saveChronicle', 'savePerson',       // краезнание
  'saveMzs', 'savePeriodical', 'addIssue', 'saveHold',
  'saveSuggestion', 'saveCategory', 'saveEmployee',
  'addClosedDay', 'createShelf', 'lnkAdd'
];
const ONCE_RUNNING = new Set();
for (const name of ONCE_ACTIONS) {
  const fn = window[name];
  if (typeof fn !== 'function') continue;
  window[name] = function (...args) {
    if (ONCE_RUNNING.has(name)) return undefined;
    /* Прозорец, който ВЕЧЕ се затваря, не праща нищо повече (проверка при
       прегледа на v2.4.45). Съдържанието му живее още MODAL_FADE_MS след
       затварянето и през това време полетата му са налице и с фокус — задържан
       Enter се повтаря на ~30 ms и пращаше записа втори път, след като пазачът
       се е вдигнал. Мишката я спира .veil.closing{pointer-events:none} в
       style.css; клавиатурата минава оттук. */
    const from = document.activeElement;
    if (from && from.closest && from.closest('.veil.closing')) return undefined;
    ONCE_RUNNING.add(name);
    /* Натиснатият бутон е и фокусираният — Chromium фокусира бутона при
       щракване. Ако по някаква причина не е, пазачът пак държи: наборът
       ONCE_RUNNING сам по себе си спира второто повикване. */
    const btn = document.activeElement;
    const lock = btn && btn.tagName === 'BUTTON' && !btn.disabled ? btn : null;
    if (lock) lock.disabled = true;
    let out;
    try {
      out = fn.apply(this, args);
    } finally {
      Promise.resolve(out).catch(() => {}).then(() => {
        /* Пазачът се вдига СЛЕД като прозорецът наистина се махне, а не щом
           записът мине (проверка при прегледа на v2.4.45). Затварянето е с
           преход: closeModal() маха съдържанието чак след MODAL_FADE_MS и през
           това време прозорецът още стои на екрана. Самият запис приключва за
           няколко милисекунди — тоест бутонът оживяваше, докато прозорецът се
           вижда, и второто щракване на едно обикновено двойно щракване (60–150
           ms) влизаше пак. Измерено с истинска форма: „Плати“ с 4,50 лв. пращаше
           account.pay ДВА пъти при всяка пауза до 140 ms.
           Първата преграда е .veil.closing{pointer-events:none} в style.css;
           тази тук пази и пътищата без бутон (Enter в поле, повикване от код). */
        ONCE_RUNNING.delete(name);
        /* Бутонът се отключва само ако още стои на екрана И прозорецът му НЕ се
           затваря. Второто условие е поправката: дотук се гледаше само дали
           елементът е в документа, а през тези 140 ms той е и в документа, и на
           екрана — бутонът оживяваше под пръста на човека и второто щракване на
           едно обикновено двойно щракване (60–150 ms) пращаше плащането пак.
           Отключването НЕ се отлага: при отказ (празна сума) прозорецът остава
           отворен и трябва да може да се опита веднага пак. */
        const closing = lock && lock.closest && lock.closest('.veil.closing');
        if (lock && lock.isConnected && !closing) lock.disabled = false;
      });
    }
    return out;
  };
}

setTopbarH();
/* Лентата се преоразмерява при промяна на прозореца (заглавието се пренася на
   два реда, логото се скрива под 1400 px) — залепените менюта трябва да знаят
   новата ѝ височина, иначе паркират на старото място. */
window.addEventListener('resize', debounce(setTopbarH, 120));
initUserBadge();
initAppCredit();
initSavedIndicator();
initAutoUpdateUI();
// При съвсем нова инсталация програмата отваря направо „Настройки“ — данните на
// библиотеката трябва да се въведат веднъж, преди да има смисъл от останалите раздели.
loadSettingsCache().then(async s => {
  if (needsSetup(s) && !location.hash) location.hash = '#setup';
  await route();
  /* Кой работи в момента? (v2.4.27, A8) Значката оставаше „(изберете)“ и всяко
     действие влизаше в одитната следа без име, докато някой не се сети да
     щракне върху нея. Пита се веднъж при старт — само ако има активни служители
     и никой не е избран; при първоначална настройка не пречи. */
  try {
    if (!needsSetup(s)) {
      const [user, employees] = await Promise.all([call(window.api.app.getUser()), call(window.api.employees.list())]);
      if (!user && Array.isArray(employees) && employees.some(e => e.active)) chooseEmployeeModal();
    }
  } catch (e) { /* без служители — без въпрос */ }
});
