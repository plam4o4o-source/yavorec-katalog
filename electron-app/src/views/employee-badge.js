/* ---------------- Служител (одитна следа) ----------------
   Изборът "кой работи в момента" е локален за този компютър (пази се в config.json на
   работната станция), а самият списък със служители е общ — идва от споделената база
   данни, затова важи еднакво на всички компютри, свързани към нея. */
async function initUserBadge() {
  const name = await call(window.api.app.getUser());
  renderUserBadge(name);
}
function renderUserBadge(name) {
  const el = $('#userBadge');
  if (!el) return;
  el.textContent = name ? 'Служител: ' + name : 'Служител: (изберете)';
  el.classList.toggle('unset', !name);
  el.title = name
    ? 'Действията се вписват в одитната следа на името на този служител. Натиснете, за да смените.'
    : 'Изберете кой служител работи в момента.';
}
async function chooseEmployeeModal() {
  const employees = await call(window.api.employees.list());
  if (!employees) return;
  window._EMPLOYEES_ACTIVE = employees.filter(e => e.active);
  modal('Кой служител работи в момента?',
    window._EMPLOYEES_ACTIVE.length
      ? `<div style="display:flex;flex-direction:column;gap:8px">
          ${window._EMPLOYEES_ACTIVE.map(e => `<button type="button" class="btn" style="text-align:left" onclick="pickEmployee(${e.id})">${esc(e.name)}</button>`).join('')}
        </div>`
      : '<div class="hint">Все още няма добавени служители — добавете ги в „Настройки“ → „Служители“.</div>',
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="closeModal();go('setup')">Управление на служителите</button>`);
}
window.chooseEmployeeModal = chooseEmployeeModal;
async function pickEmployee(id) {
  const emp = (window._EMPLOYEES_ACTIVE || []).find(x => x.id === id);
  if (!emp) return;
  const saved = await call(window.api.app.setUser(emp.name));
  renderUserBadge(saved);
  closeModal();
}
window.pickEmployee = pickEmployee;

/* ---------------- Версия и авторство ---------------- */
const APP_YEAR_START = 2026; // годината на създаване на Electron версията — фиксирана веднъж
function appYears() {
  const y = new Date().getFullYear();
  return y > APP_YEAR_START ? APP_YEAR_START + '–' + y : String(APP_YEAR_START);
}
let APP_CREDIT_TEXT = '';
async function initAppCredit() {
  const version = await call(window.api.app.getVersion());
  APP_CREDIT_TEXT = 'Създадено от Пламен Христов - Пачо · GPL-3.0-or-later © ' + appYears() + (version ? ' · v' + version : '');
  const el = $('#appCredit');
  if (el) el.textContent = APP_CREDIT_TEXT;
}
