#!/usr/bin/env node
'use strict';
/* ============================================================================
   npm run test:all — всичко, което CI проверява, с една команда.
   ============================================================================
   ЗАЩО СЪЩЕСТВУВА. `npm test` пуска само поредицата на electron-app, и то в
   часовата зона на машината. CI обаче пуска три неща:
     1) целата поредица в UTC;
     2) СЪЩАТА поредица в Europe/Sofia — няколко теста за лятното часово време
        имат разграничителна сила само извън UTC (виж бележката в ci.yml);
     3) поредицата на публичната каталожна страница (site/), която е ИЗВЪН
        electron-app/ и затова `node --test` изобщо не я вижда.
   Докато това не се пускаше с една команда, третото просто се пропускаше
   локално и се научаваше чак от CI.

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
    name: 'Публичната каталожна страница (site/)',
    cmd: process.execPath,
    args: ['test-page-katalog.js', 'page-katalog.html'],
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
console.log('\u001b[32mИ трите проверки минаха.\u001b[0m');
