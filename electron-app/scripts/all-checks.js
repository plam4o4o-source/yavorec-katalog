#!/usr/bin/env node
'use strict';
/* ============================================================================
   npm run test:all — всичко, което CI проверява, с една команда.
   ============================================================================
   ЗАЩО СЪЩЕСТВУВА. `npm test` пуска само поредицата на electron-app, и то в
   часовата зона на машината. CI обаче пуска пет неща:
     1) целата поредица в UTC;
     2) СЪЩАТА поредица в Europe/Sofia — няколко теста за лятното часово време
        имат разграничителна сила само извън UTC (виж бележката в ci.yml);
     3) поредицата за източниците на публичната каталожна страница (site/),
        която е ИЗВЪН electron-app/ и затова `node --test` изобщо не я вижда;
     4) поредицата за ИЗГЛЕДА на същата страница при 15 000 екземпляра;
     5) от v2.4.68 и проверката на типовете (tsc --checkJs) — виж CONTRIBUTING.md.
   Докато това не се пускаше с една команда, последните две просто се
   пропускаха локално и се научаваха чак от CI.

   ЗАЩО Е СКРИПТ, А НЕ РЕД В package.json. Обичайният запис `TZ=Europe/Sofia
   node --test` е синтаксис на Unix обвивка и не работи в cmd.exe и PowerShell
   — а програмата се разработва и под Windows, защото за Windows се и издава.
   Решението „сложи cross-env“ е нова зависимост за едно присвояване на
   променлива; проектът нарочно ги избягва (виж CONTRIBUTING.md). Тук env се
   подава направо на child_process, което е еднакво на всички платформи.

   ЗАЩО НЕ СЕ КАЗВА test-all.js. `node --test` открива тестовете по образец и
   `test-*.js` е един от тях — файл с такова име попада В САМАТА поредица, бива
   изпълнен като тест и пуска `node --test` отвътре. Node разпознава рекурсията
   („run() is being called recursively“) и тогава ПРЕСКАЧА файловете: `npm test`
   минава за три минути вместо за седем и не проверява нищо. Затова името е
   извън всички образци за откриване.

   NODE_PATH за site/: тестът на каталожната страница ползва jsdom, а jsdom е
   зависимост на electron-app. Затова се сочи натам изрично — същото, което
   прави и ci.yml. */
const { spawnSync } = require('child_process');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const SITE_DIR = path.join(APP_DIR, '..', 'site');

const steps = [
  /* Проверката на типовете (v2.4.68) — същата като в CI: главният процес,
     изгледите и актуалността на описанието на window.api. Минава за секунди
     и затова е първа: грешно име на метод се вижда, преди да тръгнат
     седемте минути тестове. */
  {
    name: 'Проверка на типовете (tsc --checkJs)',
    cmd: process.execPath,
    args: [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'],
    cwd: APP_DIR,
    env: {}
  },
  {
    name: 'Проверка на типовете — изгледите',
    cmd: process.execPath,
    args: [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.renderer.json'],
    cwd: APP_DIR,
    env: {}
  },
  {
    name: 'Описанието на window.api отговаря на preload.js',
    cmd: process.execPath,
    args: ['scripts/gen-api-types.js', '--check'],
    cwd: APP_DIR,
    env: {}
  },
  {
    name: 'Поредица в UTC',
    cmd: process.execPath,
    args: ['--test'],
    cwd: APP_DIR,
    env: { TZ: 'UTC' }
  },
  {
    name: 'Поредица в Europe/Sofia (за тестовете около лятното часово време)',
    cmd: process.execPath,
    args: ['--test'],
    cwd: APP_DIR,
    env: { TZ: 'Europe/Sofia' }
  },
  {
    name: 'Публичната каталожна страница — източници, срокове, кеш (site/)',
    cmd: process.execPath,
    args: ['test-page-katalog.js', 'page-katalog.html'],
    cwd: SITE_DIR,
    env: { NODE_PATH: path.join(APP_DIR, 'node_modules') }
  },
  /* Съседният файл проверява ИЗГЛЕДА при 15 000 екземпляра (групиране,
     търсене, филтри, „Покажи още“, времена). Съществуваше, но нищо не го
     пускаше автоматично — нито `node --test` (извън electron-app/), нито CI,
     нито този скрипт. Минаваше само когато някой се сети на ръка. */
  {
    name: 'Публичната каталожна страница — изгледът при реален мащаб (site/)',
    cmd: process.execPath,
    args: ['test-page-katalog-view.js'],
    cwd: SITE_DIR,
    env: { NODE_PATH: path.join(APP_DIR, 'node_modules') }
  }
];

let failed = 0;
for (const s of steps) {
  console.log('\n\u001b[1m=== ' + s.name + ' ===\u001b[0m');
  const r = spawnSync(s.cmd, s.args, {
    cwd: s.cwd,
    stdio: 'inherit',
    env: Object.assign({}, process.env, s.env)
  });
  /* Прекъснат от сигнал (Ctrl+C) не е „минал“ — иначе спирането по средата би
     изглеждало като успех за следващата стъпка и за човека пред екрана. */
  if (r.error) {
    console.error('\u001b[31m' + s.name + ': не можа да се пусне — ' + r.error.message + '\u001b[0m');
    failed++;
    break;
  }
  if (r.signal) {
    console.error('\u001b[31m' + s.name + ': прекъснат (' + r.signal + ')\u001b[0m');
    failed++;
    break;
  }
  if (r.status !== 0) {
    console.error('\u001b[31m' + s.name + ': ПАДНА (код ' + r.status + ')\u001b[0m');
    failed++;
    /* Не се спира на първия провал: другите две проверки са независими и е
       по-полезно да се види цялата картина наведнъж, отколкото да се пуска
       отново след всяка поправка. */
  }
}

console.log('');
if (failed) {
  console.error('\u001b[31m' + failed + ' от ' + steps.length + ' проверки не минаха.\u001b[0m');
  process.exit(1);
}
console.log('\u001b[32mИ ' + steps.length + ' проверки минаха.\u001b[0m');
