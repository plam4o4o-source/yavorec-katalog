/* Тест на db-folder.js — решението какво да се прави, когато настроената папка с
   базата данни (обичайно мрежов диск) не е достъпна.

   Защо изобщо съществува този модул и този тест: resolveDbDir() в main.js се връщаше
   ТИХО към локалната папка по подразбиране, а resolveDbPath() веднага създаваше там
   нова, ПРАЗНА база. Библиотекарят вижда празен фонд („всичко изчезна“) и, което е
   по-опасно, може да започне да въвежда данни, които никога няма да се срещнат с
   общата база. Затова сега се пита изрично, а решението е отделено от Electron
   диалога, за да може да се провери тук без работещо приложение. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbFolderDecision, ensureDbFolderAvailable } = require('../db-folder');

test('dbFolderDecision: без настроена папка се работи локално, без въпроси', () => {
  const never = () => { throw new Error('existsSync не биваше да се вика'); };
  assert.equal(dbFolderDecision({}, never), 'ok');
  assert.equal(dbFolderDecision({ dbFolder: '' }, never), 'ok');
  assert.equal(dbFolderDecision(null, never), 'ok');
});

test('dbFolderDecision: настроена папка се проверява за наличие', () => {
  assert.equal(dbFolderDecision({ dbFolder: '/mnt/biblioteka' }, () => true), 'ok');
  assert.equal(dbFolderDecision({ dbFolder: '/mnt/biblioteka' }, () => false), 'missing');
});

test('налична папка — програмата продължава, без да пита нищо', () => {
  let asked = 0;
  const ok = ensureDbFolderAvailable({
    readConfig: () => ({ dbFolder: '/mnt/biblioteka' }),
    existsSync: () => true,
    ask: () => { asked++; return 'quit'; }
  });
  assert.equal(ok, true);
  assert.equal(asked, 0, 'при налична папка не се показва диалог');
});

test('липсваща папка — „Изход“ спира стартирането вместо да създаде празна база', () => {
  const ok = ensureDbFolderAvailable({
    readConfig: () => ({ dbFolder: '\\\\server\\biblioteka' }),
    existsSync: () => false,
    ask: () => 'quit'
  });
  assert.equal(ok, false);
});

test('липсваща папка — „Работи с локална база“ е съзнателен избор и продължава', () => {
  const ok = ensureDbFolderAvailable({
    readConfig: () => ({ dbFolder: '\\\\server\\biblioteka' }),
    existsSync: () => false,
    ask: () => 'local'
  });
  assert.equal(ok, true);
});

test('„Опитай отново“ чете диска наново — свързан диск продължава нормално', () => {
  let attempts = 0;
  const ok = ensureDbFolderAvailable({
    readConfig: () => ({ dbFolder: '\\\\server\\biblioteka' }),
    existsSync: () => ++attempts >= 3, // дискът се появява на третия опит
    ask: () => 'retry'
  });
  assert.equal(ok, true);
  assert.equal(attempts, 3);
});

test('безкраен „Опитай отново“ не върти вечно — след изчерпване се спира, не се създава база', () => {
  let asked = 0;
  const ok = ensureDbFolderAvailable({
    readConfig: () => ({ dbFolder: '\\\\server\\biblioteka' }),
    existsSync: () => false,
    ask: () => { asked++; return 'retry'; },
    maxAttempts: 5
  });
  assert.equal(ok, false, 'по-безопасно е да не се продължи, отколкото да се отвори празна база');
  assert.equal(asked, 5);
});
