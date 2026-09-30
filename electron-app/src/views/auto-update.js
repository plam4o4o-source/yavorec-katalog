/* ---------------- Автоматично обновяване ---------------- */
let UPDATE_STATUS = { state: 'idle' };
function initAutoUpdateUI() {
  if (!window.api.app.onUpdateStatus) return;
  window.api.app.onUpdateStatus((data) => {
    UPDATE_STATUS = data;
    if (data.state === 'available') toast('Налична е нова версия ' + data.version + ' — изтегля се…', 'ok');
    else if (data.state === 'downloaded') {
      toast('Версия ' + data.version + ' е изтеглена. Ще се инсталира при затваряне на програмата.', 'ok');
    } else if (data.state === 'error') {
      console.error('Автообновяване:', data.message);
    }
    /* САМО КАРТАТА „ОБНОВЯВАНЕ“ (v2.4.71, кръг 45, находка С7).
       (а) Дотук всяко събитие за обновяване — „проверка“, „налична“, всеки
       процент от изтеглянето — викаше renderSetup(), тоест пречертаваше цялата
       страница „Настройки“. Тестер (s10-ekran.js): написано „Нов председател“
       в „Ръководител“, пет събития за изтегляне → полето отново е старото, без
       дума, а фокусът е изгубен.
       (б) Изтеглянето върви само, при всяко пускане, и минава през десетки
       проценти — точно докато библиотекарката попълва настройките. Изгубеното
       не личи: тя натиска „Запиши“ и записва СТАРИТЕ стойности.
       (в) Обновява се само кутията #updBox вътре в картата „Обновяване“ — с
       онова, което тя вече показва (updateStatusHtml). Останалата форма не се
       пипа. Ако кутията я няма (друг екран), няма какво да се обновява. */
    const box = VIEW === 'setup' ? document.getElementById('updBox') : null;
    if (box && typeof updateStatusHtml === 'function') box.innerHTML = updateStatusHtml();
  });
}
async function checkForUpdatesNow() {
  const res = await window.api.app.checkForUpdates();
  if (!res.ok) return toast(res.error, 'err');
  toast('Проверка за обновления…', 'ok');
}
window.checkForUpdatesNow = checkForUpdatesNow;
async function installUpdateNow() {
  await window.api.app.installUpdate();
}
window.installUpdateNow = installUpdateNow;
