/* Съответствие между моста preload.js и регистрираните IPC канали.
   =====================================================================
   ЗАЩО СЪЩЕСТВУВА: preload.js излага ~200 канала към изгледите и до v2.3.0
   нямаше НИТО един тест върху него. Мутационен одит подмени
   `invoke('loans:return')` с `invoke('loans:retrun')` и цялата поредица
   остана зелена — връщането на книга просто спираше да работи в
   инсталираната програма. Утежняващо: мокът на `window.api` в тестовете на
   изгледите е Proxy, който връща {ok:true} за ПРОИЗВОЛЕН път, тоест и от
   страна на изгледа несъществуващ канал изглежда работещ. Тоест грешка в
   името на канал нямаше как да бъде хваната отникъде.

   КАК: имената НЕ се преписват тук. Едната страна се събира, като preload.js
   се зарежда със заглушен `electron` и всяка изложена функция се извиква —
   каналът се хваща там, където реално отива (ipcRenderer.invoke). Другата
   страна е списъкът канали, които истинският main.js регистрира при
   зареждане (test/helpers/main-app.js). Сравнението е в ДВЕТЕ посоки:
   печатна грешка в preload дава „изложен, но нерегистриран", а забравен
   мост след нов handler дава „регистриран, но неизложен". */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { startMainApp } = require('./helpers/main-app.js');

/* --- Страна 1: какво реално вика preload.js --- */
function loadPreload() {
  const invoked = [];   // ipcRenderer.invoke(channel, ...)
  const listened = [];  // ipcRenderer.on(channel, ...)
  let api = null;

  const id = require.resolve('electron');
  const stub = new Module(id, null);
  stub.filename = id;
  stub.loaded = true;
  stub.exports = {
    contextBridge: { exposeInMainWorld: (key, value) => { if (key === 'api') api = value; } },
    ipcRenderer: {
      invoke: (channel) => { invoked.push(channel); return Promise.resolve({ ok: true }); },
      on: (channel) => { listened.push(channel); }
    },
    webUtils: { getPathForFile: () => '/примерен/път' }
  };
  require.cache[id] = stub;

  const preloadId = require.resolve('../preload.js');
  delete require.cache[preloadId];
  require(preloadId);
  assert.ok(api, 'preload.js трябва да изложи обекта „api" през contextBridge');

  /* Всяка листна функция се извиква веднъж — така каналът идва от самото
     извикване, а не от преписан списък. Аргументът е функция, защото
     абонаментите (onUpdateStatus/onAutoStatus) очакват callback. */
  const leaves = [];
  (function walk(obj, path) {
    for (const [key, val] of Object.entries(obj)) {
      const p = path + '.' + key;
      if (typeof val === 'function') {
        leaves.push(p);
        try { val(() => {}); } catch (err) { /* напр. filePath(undefined) */ }
      } else if (val && typeof val === 'object') {
        walk(val, p);
      }
    }
  })(api, 'api');

  return { api, invoked, listened, leaves };
}

const preload = loadPreload();

const app = startMainApp();
test.after(() => app.stop());

test('всяко име на канал в preload.js съществува като регистриран ipcMain.handle', () => {
  const registered = new Set(app.channels());
  const missing = [...new Set(preload.invoked)].filter(c => !registered.has(c)).sort();
  assert.deepEqual(missing, [],
    'preload.js вика канали, които никой не регистрира — точно така изглежда печатна '
    + 'грешка от рода на „loans:retrun": изгледът мълчи, а действието не се случва');
});

test('всеки регистриран ipcMain.handle е изложен през preload.js', () => {
  const exposed = new Set(preload.invoked);
  const unexposed = app.channels().filter(c => !exposed.has(c)).sort();
  assert.deepEqual(unexposed, [],
    'има регистрирани канали без мост в preload.js — новият handler е недостижим от интерфейса');
});

test('няма два моста към един и същ канал и няма листна функция без канал', () => {
  const seen = new Map();
  for (const c of preload.invoked) seen.set(c, (seen.get(c) || 0) + 1);
  assert.deepEqual([...seen].filter(([, n]) => n > 1), [],
    'един канал е изложен два пъти — обикновено следа от копиране на ред');

  /* Листните функции = invoke-мостове + абонаменти + filePath (единственият
     мост, който не минава през IPC). Разминаване означава мост, който при
     извикване не докосва нито invoke, нито on — тоест мълчаливо нищо. */
  const accounted = preload.invoked.length + preload.listened.length + 1;
  assert.equal(preload.leaves.length, accounted,
    'има изложена функция, която при извикване не стига до ipcRenderer — '
    + 'изгледът я вика, а нищо не се случва');
});

test('абонаментите в preload.js слушат точно каналите, които main процесът изпраща', () => {
  /* Обратната посока на горното: onUpdateStatus/onAutoStatus не минават през
     invoke и няма кой да ги провери. Имената тук са тези, които main.js и
     handlers/backup.js подават на webContents.send. */
  assert.deepEqual([...preload.listened].sort(), ['app:userChanged', 'backup:autoStatusChanged', 'update:status']);

  const fs = require('fs');
  const path = require('path');
  const sources = ['main.js', path.join('handlers', 'backup.js')]
    .map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  for (const channel of preload.listened) {
    assert.ok(sources.includes(`'${channel}'`),
      `preload.js слуша „${channel}", но main процесът никъде не изпраща такъв канал`);
  }
});

test('регистрацията на канали в main.js е пълна и без дубликати', () => {
  /* Долна граница, за да не мине незабелязано цял модул, изпаднал от
     require() веригата на main.js (напр. TDZ грешка, скрита в try/catch). */
  const channels = app.channels();
  assert.equal(new Set(channels).size, channels.length, 'дублирана регистрация на канал');
  assert.ok(channels.length >= 195, 'очакваха се поне 195 канала, а са ' + channels.length);
  // Няколко котвени канала от различни модули — ако липсват, цял домейн е отпаднал.
  for (const c of ['books:list', 'loans:return', 'readers:list', 'catalog:writeNow',
    'gdpr:anonymize', 'inventorySessions:close', 'calendar:addClosed', 'import:run']) {
    assert.ok(app.has(c), 'липсва регистриран канал ' + c);
  }
});
