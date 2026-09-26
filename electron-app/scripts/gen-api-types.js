#!/usr/bin/env node
'use strict';
/* ============================================================================
   ОПИСАНИЕТО НА window.api ЗА ПРОВЕРКАТА НА ТИПОВЕ — ИЗВЕЖДА СЕ ОТ preload.js.
   ============================================================================
   Изгледите викат ~250 метода на window.api. Без описание `tsc --checkJs` не
   знае нищо за тях и всяко извикване е „Property 'api' does not exist“ — тоест
   проверката е сляпа точно там, където екранът и обработчиците се срещат.

   ЗАЩО СЕ ГЕНЕРИРА, А НЕ СЕ ПИШЕ НА РЪКА. Ръчно описание на 250 метода остарява
   още при първото добавяне на канал. Тук preload.js се изпълнява с подменен
   `electron` и се чете точно обектът, който отива в exposeInMainWorld('api', …)
   — описанието е вярно по построение. test/typecheck-v2468.test.js пуска този
   скрипт с --check и пада, ако types/api.generated.d.ts не отговаря на
   preload.js; поправката е `npm run gen:api-types`.

   КАКВО ОПИСВА. Имената на групите и методите (грешно име — `api.loans.chekout`
   — вече е грешка при проверката) и това, че методите през invoke() връщат
   Promise. Формата на аргументите и на отговора остава `any`: тя се определя от
   обработчика, не от preload.js, и описанието ѝ е следваща стъпка.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_DIR = path.join(__dirname, '..');
const PRELOAD = path.join(APP_DIR, 'preload.js');
const OUT = path.join(APP_DIR, 'types', 'api.generated.d.ts');

function exposedApi() {
  const exposed = {};
  const channels = new WeakMap();
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, obj) => { exposed[name] = obj; } },
    ipcRenderer: { invoke: () => Promise.resolve(), on: () => {} },
    webUtils: { getPathForFile: () => '' }
  };
  const src = fs.readFileSync(PRELOAD, 'utf8');
  /* invoke(channel) в preload.js връща стрелкова функция; тук се подменя с
     такава, която помни канала — за да се види в описанието кой метод към кой
     канал води. Замества се САМО дефиницията, нищо друго в файла. */
  const marker = 'const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);';
  if (!src.includes(marker)) throw new Error('preload.js: не е намерена дефиницията на invoke() — обновете ' + __filename);
  const patched = src.replace(marker,
    'const invoke = (channel) => __markInvoke((...args) => ipcRenderer.invoke(channel, ...args), channel);');
  vm.runInNewContext(patched, {
    require: (m) => { if (m === 'electron') return fakeElectron; throw new Error('preload.js зарежда неочакван модул: ' + m); },
    __markInvoke: (fn, channel) => { channels.set(fn, channel); return fn; },
    console
  }, { filename: PRELOAD });
  if (!exposed.api) throw new Error('preload.js не извика exposeInMainWorld(\'api\', …)');
  return { api: exposed.api, channels };
}

function render() {
  const { api, channels } = exposedApi();
  const lines = [
    '// ГЕНЕРИРАН ФАЙЛ — не се пише на ръка. Източник: preload.js.',
    '// Обновяване: npm run gen:api-types (виж scripts/gen-api-types.js).',
    '',
    '/** Методът през ipcRenderer.invoke — връща каквото върне обработчикът в главния процес. */',
    'type InvLibInvoke = (...args: any[]) => Promise<any>;',
    '',
    'interface InvLibApi {'
  ];
  for (const group of Object.keys(api)) {
    const g = api[group];
    if (typeof g !== 'object' || !g) throw new Error('api.' + group + ' не е група от методи');
    lines.push('  ' + group + ': {');
    for (const name of Object.keys(g)) {
      const fn = g[name];
      if (typeof fn !== 'function') throw new Error('api.' + group + '.' + name + ' не е функция');
      const ch = channels.get(fn);
      lines.push(ch
        ? '    /** канал „' + ch + '“ */\n    ' + name + ': InvLibInvoke;'
        : '    ' + name + ': (...args: any[]) => any;');
    }
    lines.push('  };');
  }
  lines.push('}', '');
  return lines.join('\n');
}

if (require.main === module) {
  const text = render();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== text) {
      console.error('types/api.generated.d.ts не отговаря на preload.js — пуснете `npm run gen:api-types`.');
      process.exit(1);
    }
    console.log('types/api.generated.d.ts отговаря на preload.js.');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
    console.log('записан ' + path.relative(APP_DIR, OUT));
  }
}

module.exports = { render, OUT };
