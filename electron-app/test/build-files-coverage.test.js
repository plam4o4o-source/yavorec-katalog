// Проверява, че всеки файл, от който зависи програмата по време на РАБОТА,
// реално влиза в опакования инсталатор (`build.files` в package.json).
//
// Защо съществува този тест: в v1.59.0 беше добавен `db/enum-triggers.js`,
// `main.js` го изискваше с require(), всичките 418 теста минаваха — но
// `build.files` изброяваше само `db/schema.sql` от папката `db/`, затова
// файлът не влизаше в `app.asar`. Резултатът: инсталираната програма изобщо
// не стартираше („Cannot find module './db/enum-triggers'“), а нито един
// тест не хващаше това, защото тестовете се пускат от изходния код, където
// файлът очевидно съществува. Версии v1.59.0 – v1.62.0 излязоха счупени.
//
// Затова тук НЕ се тества логика, а самата опаковка: обхождат се реалните
// require() и четенията на файлове в кода, който се изпълнява в главния
// процес, и се проверява, че всеки от тях е покрит от някой шаблон в
// `build.files`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const PATTERNS = pkg.build.files;

// Малък matcher за шаблоните, които electron-builder ползва тук ("main.js",
// "handlers/**/*", "db/**/*"). Нарочно не се вкарва зависимост (minimatch) —
// проектът държи на нулеви нови зависимости заради подписването на инсталатора.
function matches(pattern, relPath) {
  const rx = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // екранира regex знаците, но НЕ * и /
    .replace(/\*\*\/\*/g, '.*')             // "dir/**/*" → всичко под dir
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*')         // единично * не минава през /
    + '$';
  return new RegExp(rx).test(relPath);
}
const isPackaged = (relPath) => PATTERNS.some(p => matches(p, relPath));

// Файловете, които се изпълняват в главния процес — оттам тръгва обхождането.
function mainProcessFiles() {
  const out = ['main.js', 'preload.js'];
  for (const f of fs.readdirSync(path.join(APP_DIR, 'handlers'))) {
    if (f.endsWith('.js')) out.push('handlers/' + f);
  }
  return out;
}

// Коментарите се махат преди търсенето на require() — иначе примерите в
// обясненията (напр. „...require('./handlers/books') в main.js...“ в
// handlers/books.js) се брояха за истински зависимости. `//` се реже само
// когато не е част от адрес (`https://`), за да не отсече останалата част
// от ред, съдържащ URL в низ.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('всеки локален require() в главния процес сочи файл, който влиза в инсталатора', () => {
  const missing = [];
  for (const file of mainProcessFiles()) {
    const src = stripComments(fs.readFileSync(path.join(APP_DIR, file), 'utf8'));
    const dir = path.dirname(file);
    for (const m of src.matchAll(/require\('(\.[^']+)'\)/g)) {
      // Разрешава пътя спрямо файла, който го изисква, и добавя .js, ако липсва.
      let rel = path.posix.normalize(path.posix.join(dir, m[1]));
      if (!fs.existsSync(path.join(APP_DIR, rel))) rel += '.js';
      assert.ok(fs.existsSync(path.join(APP_DIR, rel)),
        `${file}: require('${m[1]}') сочи несъществуващ файл ${rel}`);
      if (!isPackaged(rel)) missing.push(`${rel}  (изискан от ${file})`);
    }
  }
  assert.deepEqual(missing, [],
    'Тези файлове се изискват по време на работа, но НЕ влизат в build.files — ' +
    'инсталираната програма няма да стартира:\n  ' + missing.join('\n  '));
});

test('файловете, четени по време на работа (schema.sql, mobile-template.html, icon.ico), влизат в инсталатора', () => {
  // Тези не минават през require(), а през fs.readFileSync/BrowserWindow и
  // затова не биха се хванали от теста по-горе.
  for (const rel of ['db/schema.sql', 'src/mobile-template.html', 'src/index.html', 'icon.ico']) {
    assert.ok(fs.existsSync(path.join(APP_DIR, rel)), `${rel} липсва в проекта`);
    assert.ok(isPackaged(rel), `${rel} се чете по време на работа, но не влиза в build.files`);
  }
});

// Интерфейсът (renderer) не минава през require() — index.html го зарежда с
// <script src="...">. Затова горните проверки не го покриват изобщо, а след
// разбиването на бившия src/app.js на 39 файла в src/views/ това е точно
// толкова чувствително към същия бъг: файл, който не влиза в инсталатора или
// не е добавен в index.html, чупи цял раздел от програмата само в опакованата
// версия.
const indexHtml = fs.readFileSync(path.join(APP_DIR, 'src', 'index.html'), 'utf8');
const scriptSrcs = [...indexHtml.matchAll(/<script src="([^"]+)"/g)].map(m => 'src/' + m[1]);

test('всеки <script> от index.html съществува и влиза в инсталатора', () => {
  assert.ok(scriptSrcs.length > 1, 'не са намерени <script src> тагове в index.html');
  for (const rel of scriptSrcs) {
    assert.ok(fs.existsSync(path.join(APP_DIR, rel)), `index.html зарежда ${rel}, но такъв файл няма`);
    assert.ok(isPackaged(rel), `${rel} се зарежда от index.html, но не влиза в build.files`);
  }
});

test('всеки файл в src/views/ реално се зарежда от index.html (няма мъртъв раздел)', () => {
  const onDisk = fs.readdirSync(path.join(APP_DIR, 'src', 'views'))
    .filter(f => f.endsWith('.js')).map(f => 'src/views/' + f).sort();
  const loaded = scriptSrcs.filter(s => s.startsWith('src/views/')).sort();
  assert.deepEqual(loaded, onDisk,
    'Разминаване между файловете в src/views/ и заредените в index.html — ' +
    'файл, който не е добавен в index.html, е мъртъв код, а липсващ файл чупи страницата.');
});

// Единственото истинско ограничение на реда след разбиването: bootstrap.js
// чете имената на render-функциите веднага (RENDERERS) и вика route(), затова
// всичко останало трябва вече да е заредено. Нищо в кода не пази това — ако
// нов изглед се добави след него в index.html, програмата се чупи.
test('views/bootstrap.js се зарежда последен', () => {
  assert.equal(scriptSrcs[scriptSrcs.length - 1], 'src/views/bootstrap.js',
    'bootstrap.js трябва да е последният <script> в index.html — вижте коментара в самия файл');
});

test('matcher-ът наистина отхвърля непокрит файл (иначе тестът по-горе би минавал винаги)', () => {
  // Пази самия тест от това да стане безсмислен: ако matches() почне да
  // връща true за всичко, горните проверки биха минавали, без да пазят нищо.
  assert.equal(isPackaged('db/enum-triggers.js'), true);
  assert.equal(isPackaged('README.md'), false);
  assert.equal(isPackaged('test/db-init.test.js'), false);
  // "src/**/*" не бива да покрива файл извън src/
  assert.equal(matches('src/**/*', 'other/app.js'), false);
  // единично * не бива да минава през наклонена черта
  assert.equal(matches('*.js', 'handlers/books.js'), false);
});
