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
    if (VIEW === 'setup') renderSetup();
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
