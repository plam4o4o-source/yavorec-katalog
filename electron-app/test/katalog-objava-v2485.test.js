'use strict';
/* v2.4.85 — ПУБЛИКУВАНЕТО НА ОНЛАЙН КАТАЛОГА.
   =====================================================================
   Всяка точка тук има тест, който ПАДА, ако поправката се върне:

     30  автоматичното качване не пуска CI: commit-ите носят `[skip ci]`, а
         ci.yml не се пуска за клона `katalog` и за push само на katalog.json;
     31  каталогът отива в клон `katalog` — ЕДИН commit без родител, подменян
         с push --force; main получава katalog.json най-много веднъж на ден и
         само при промяна; отказан клон → стария път през main, казано веднъж;
         само наличност (гишето) — най-много веднъж на 30 минути, фондът —
         веднага; видът на промяната идва от main.js (CATALOG_PUBLISH_DIRT);
     32  без промяна — без push; одитната следа — само при преход (спря /
         тръгна), а опитите се разреждат 5, 10, 20, 40, 60 минути;
     34  остатъци от убит git (*.lock, започнат rebase/merge) се почистват;
         git никога не пита за парола (GIT_TERMINAL_PROMPT/GCM_INTERACTIVE),
         а отказаният достъп излиза с ясно съобщение на български;
     39  публикуване 45 s след старта; при затваряне — във фонов режим с
         таван, а диалогът излиза само ако то не успее.

   Част А върви с ИСТИНСКИ git срещу локално „отдалечено“ хранилище (както
   katalog-v2471.test.js), част Б — с подставен git, за да се видят точно
   командите, променливите на средата и редът в следата. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const registerCatalogHandlers = require('../handlers/catalog');
const { csvCell, MAIN_SRC, extractDeclaration } = require('./helpers/prod-values.js');

const APP_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(APP_DIR, '..');

const tmpDirs = [];
function mkTmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
  }
});

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args)
  };
}
function freshDb(dir) {
  const db = new Database(path.join(dir, 'library.db'));
  db.exec(fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8'));
  return db;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kat = (n) => JSON.stringify({ library: 'Проба', generated: '2026-10-14', items: [{ inv: 1, t: 'Книга ' + n, av: n % 2 }] }) + '\n';

/* Регистрира истинския handlers/catalog.js. Таймерите на автоматичното
   публикуване (setInterval 5 мин. и setTimeout 45 s) се улавят, за да може
   тестът да ги „удари“, без да чака. */
function register(folder, opts) {
  const o = opts || {};
  const db = o.db;
  db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(folder);
  const audit = [];
  const dialogs = [];
  const ipc = fakeIpcMain();
  const timers = { tick: null, startup: null, cleared: [] };
  const realSetInterval = global.setInterval, realSetTimeout = global.setTimeout;
  const realClearInterval = global.clearInterval, realClearTimeout = global.clearTimeout;
  const cat = registerCatalogHandlers(ipc, {
    getDb: () => db,
    run: (fn) => { try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message }; } },
    logAudit: (action, detail) => audit.push(detail),
    dialog: { showMessageBoxSync: (d) => { dialogs.push(d); return 0; } },
    getMainWindow: () => ({}), fs, path,
    execFile: o.execFile || execFile,
    csvCell, flushCatalogWrite: () => ({ written: true }),
    catalogJsonText: (p) => JSON.stringify(p), buildCatalogPayload: () => ({ items: [] }),
    catalogChanges: o.catalogChanges
  });
  global.setInterval = (fn, ms) => { if (ms === 5 * 60 * 1000) timers.tick = fn; return { kind: 'interval', unref() {} }; };
  global.setTimeout = (fn, ms) => { if (ms === 45 * 1000) timers.startup = fn; return { kind: 'startup', unref() {} }; };
  global.clearInterval = (hd) => { timers.cleared.push(hd && hd.kind); };
  global.clearTimeout = (hd) => { timers.cleared.push(hd && hd.kind); };
  try { cat.startAutoPushTimer(); }
  finally {
    global.setInterval = realSetInterval; global.setTimeout = realSetTimeout;
    global.clearInterval = realClearInterval; global.clearTimeout = realClearTimeout;
  }
  assert.equal(typeof timers.tick, 'function', 'таймерът на 5 минути не беше пуснат');
  return { ipc, cat, audit, dialogs, timers, db };
}
/* Видовете промени — като CATALOG_PUBLISH_DIRT в main.js. */
function changes() {
  const d = { fund: false, circ: false };
  return {
    d,
    peek: () => ({ fund: d.fund, circ: d.circ }),
    take: () => { const k = { fund: d.fund, circ: d.circ }; d.fund = false; d.circ = false; return k; },
    restore: (k) => { if (k.fund) d.fund = true; if (k.circ) d.circ = true; }
  };
}

/* ==========================================================================
   А) ИСТИНСКИ git
   ========================================================================== */
function gitRepoPair(prefix) {
  const work = mkTmpDir(prefix);
  const remote = path.join(work, 'remote.git');
  const repo = path.join(work, 'kat');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  const R = (...a) => execFileSync('git', ['--git-dir', remote, ...a], { encoding: 'utf8' }).trim();
  return { work, remote, repo, R, file: path.join(repo, 'katalog.json') };
}

test('31/30: клонът `katalog` е ЕДИН commit без родител само с katalog.json; main — веднъж на ден; `[skip ci]` навсякъде', async () => {
  const g = gitRepoPair('inv-v2485-git-');
  const db = freshDb(g.work);
  db.prepare("UPDATE settings SET gh_user = 'u', gh_repo = 'r', gh_branch = 'main' WHERE id = 1").run();
  const calls = [];
  const spy = (cmd, args, opts, cb) => { calls.push(args.join(' ')); return execFile(cmd, args, opts, cb); };
  const h = register(g.repo, { db, execFile: spy });

  fs.writeFileSync(g.file, kat(1));
  let r = await h.ipc.invoke('catalog:gitPublishNow');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.committed, true);
  assert.equal(JSON.parse(g.R('show', 'katalog:katalog.json')).items[0].t, 'Книга 1', 'клонът `katalog` не носи каталога');
  assert.equal(g.R('ls-tree', '--name-only', 'katalog'), 'katalog.json', 'клонът `katalog` трябва да държи САМО katalog.json');
  assert.equal(g.R('rev-list', '--count', 'katalog'), '1');
  assert.equal(g.R('rev-list', '--parents', '-n', '1', 'katalog').split(' ').length, 1, 'commit-ът трябва да е без родител');
  assert.match(g.R('log', '-1', '--format=%s', 'katalog'), /\[skip ci\]/);
  // Първото публикуване за деня обновява и main — с `[skip ci]`.
  assert.equal(JSON.parse(g.R('show', 'main:katalog.json')).items[0].t, 'Книга 1');
  assert.match(g.R('log', '-1', '--format=%s', 'main'), /\[skip ci\]/, 'commit-ът в main пуска CI');
  const mainCommits = g.R('rev-list', '--count', 'main');
  // Работното копие не е пипнато от водопроводните команди: изтегленият клон си е main.
  assert.equal(execFileSync('git', ['-C', g.repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'main');

  // Втора промяна същия ден: `katalog` се подменя (пак един commit), main НЕ се пипа.
  fs.writeFileSync(g.file, kat(2));
  r = await h.ipc.invoke('catalog:gitPublishNow');
  assert.equal(r.ok, true, r.error);
  assert.equal(JSON.parse(g.R('show', 'katalog:katalog.json')).items[0].t, 'Книга 2');
  assert.equal(g.R('rev-list', '--count', 'katalog'), '1', 'клонът `katalog` расте — трябва да се подменя (push --force)');
  assert.equal(g.R('rev-list', '--count', 'main'), mainCommits, 'main получи втори commit в същия ден');
  assert.equal(JSON.parse(g.R('show', 'main:katalog.json')).items[0].t, 'Книга 1');

  const st = (await h.ipc.invoke('catalog:status')).data;
  assert.equal(st.rawUrl, 'https://raw.githubusercontent.com/u/r/katalog/katalog.json');
  assert.equal(st.rawUrlMain, 'https://raw.githubusercontent.com/u/r/main/katalog.json');
  assert.equal(st.cdnUrl, 'https://cdn.jsdelivr.net/gh/u/r@katalog/katalog.json');

  // 32: без промяна автоматичният цикъл не прави push.
  const head = g.R('rev-parse', 'katalog');
  calls.length = 0;
  await h.timers.tick();
  assert.equal((await h.ipc.invoke('catalog:autoPushStatus')).data.error, null);
  assert.deepEqual(calls.filter(c => c.startsWith('push')), [], 'без промяна не бива да има push');
  assert.equal(g.R('rev-parse', 'katalog'), head);

  // Нов ден (паметта казва „main е обновен вчера“): main получава новото съдържание.
  const stateFile = path.join(g.repo, '.git', 'invlib-katalog.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.mode, 'katalog');
  fs.writeFileSync(stateFile, JSON.stringify(Object.assign(state, { mainDate: '2000-01-01' })));
  await h.timers.tick();
  assert.equal(JSON.parse(g.R('show', 'main:katalog.json')).items[0].t, 'Книга 2', 'първото публикуване за деня не обнови main');
  assert.equal(Number(g.R('rev-list', '--count', 'main')), Number(mainCommits) + 1);

  // Пак „нов ден“, но main вече е със същото съдържание — нито commit, нито push.
  fs.writeFileSync(stateFile, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { mainDate: '2000-01-02' })));
  calls.length = 0;
  await h.timers.tick();
  assert.equal(Number(g.R('rev-list', '--count', 'main')), Number(mainCommits) + 1, 'main получи commit без промяна');
  assert.deepEqual(calls.filter(c => c.startsWith('push')), [], 'push към main без промяна');
  h.cat.stopAutoPushTimer();
  db.close();
});

test('31: GitHub отказва клона `katalog` → стария път през main, казано ВЕДНЪЖ; опит наново на следващия ден', async () => {
  const g = gitRepoPair('inv-v2485-rej-');
  const hook = path.join(g.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nwhile read o n r; do\n  if [ "$r" = "refs/heads/katalog" ]; then echo "katalog: protected branch hook declined" >&2; exit 1; fi\ndone\nexit 0\n');
  fs.chmodSync(hook, 0o755);
  const db = freshDb(g.work);
  db.prepare("UPDATE settings SET gh_user = 'u', gh_repo = 'r', gh_branch = 'main' WHERE id = 1").run();
  const h = register(g.repo, { db });

  fs.writeFileSync(g.file, kat(1));
  let r = await h.ipc.invoke('catalog:gitPublishNow');
  assert.equal(r.ok, true, 'отказаният клон не бива да спира публикуването: ' + r.error);
  assert.equal(JSON.parse(g.R('show', 'main:katalog.json')).items[0].t, 'Книга 1', 'резервният път не публикува в main');
  assert.throws(() => g.R('rev-parse', '--verify', 'katalog'));
  const noted = () => h.audit.filter(a => /не прие отделния клон/.test(a)).length;
  assert.equal(noted(), 1, 'резервният режим трябва да остави ред в следата');
  assert.equal((await h.ipc.invoke('catalog:status')).data.rawUrl, 'https://raw.githubusercontent.com/u/r/main/katalog.json',
    'в резервен режим сайтът трябва да чете main');

  fs.writeFileSync(g.file, kat(2));
  r = await h.ipc.invoke('catalog:gitPublishNow');
  assert.equal(r.ok, true, r.error);
  assert.equal(JSON.parse(g.R('show', 'main:katalog.json')).items[0].t, 'Книга 2', 'в резервен режим всяка промяна отива в main');
  assert.equal(noted(), 1, 'резервният режим се казва само веднъж');

  // Клонът вече се приема (правилото е махнато), а е „следващ ден“ — пак `katalog`.
  fs.unlinkSync(hook);
  const stateFile = path.join(g.repo, '.git', 'invlib-katalog.json');
  fs.writeFileSync(stateFile, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { fallbackDate: '2000-01-01' })));
  fs.writeFileSync(g.file, kat(3));
  r = await h.ipc.invoke('catalog:gitPublishNow');
  assert.equal(r.ok, true, r.error);
  assert.equal(JSON.parse(g.R('show', 'katalog:katalog.json')).items[0].t, 'Книга 3');
  assert.ok(h.audit.some(a => /вече се приема/.test(a)), 'връщането към клона трябва да остави ред');
  assert.equal((await h.ipc.invoke('catalog:status')).data.publishBranch, 'katalog');
  h.cat.stopAutoPushTimer();
  db.close();
});

/* ==========================================================================
   Б) ПОДСТАВЕН git
   ========================================================================== */
/* Отговаря като git; hash-object дава sha1 на съдържанието, за да личи промяна.
   `fail` — функция (ключ) → { stderr } за подкоманда, която да се провали. */
function fakeGit(folder, opt) {
  const o = opt || {};
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    const key = args.join(' ');
    calls.push({ key, env: opts && opts.env });
    if (o.hang && o.hang(key)) return { kill() { calls.push({ key: 'KILL ' + key }); } };
    const f = o.fail && o.fail(key);
    if (f) { cb(Object.assign(new Error('git'), { code: 1 }), '', f.stderr || ''); return {}; }
    if (o.on) o.on(key);
    if (key === 'config --get remote.origin.url') cb(null, 'https://github.com/u/r.git\n', '');
    else if (key === 'rev-parse --abbrev-ref HEAD') cb(null, 'main\n', '');
    else if (key.startsWith('hash-object')) {
      cb(null, crypto.createHash('sha1').update(fs.readFileSync(path.join(folder, 'katalog.json'))).digest('hex') + '\n', '');
    } else if (key === 'mktree') cb(null, 'c'.repeat(40) + '\n', '');
    else if (key.startsWith('commit-tree')) cb(null, crypto.randomBytes(20).toString('hex') + '\n', '');
    else if (key.startsWith('commit ')) cb(Object.assign(new Error('git'), { code: 1 }), 'nothing to commit, working tree clean', '');
    else cb(null, '', '');
    return {};
  };
  return { fn, calls, keys: () => calls.map(c => c.key) };
}
function fakeFolder(prefix) {
  const dir = mkTmpDir(prefix);
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'katalog.json'), kat(1));
  return dir;
}

test('34: всеки git е без въпроси за парола; отказан достъп → „обновете достъпа до GitHub“, без резервен път', async () => {
  const dir = fakeFolder('inv-v2485-auth-');
  const git = fakeGit(dir, { fail: (k) => k.startsWith('push') ? { stderr: "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/u/r.git/'" } : null });
  const h = register(dir, { db: freshDb(dir), execFile: git.fn });
  const r = await h.ipc.invoke('catalog:gitPublishNow');
  assert.equal(r.ok, false);
  assert.match(r.error, /обновете достъпа до GitHub/, 'изтеклият достъп трябва да има свое съобщение: ' + r.error);
  assert.ok(git.calls.length > 3);
  for (const c of git.calls) {
    assert.equal(c.env && c.env.GIT_TERMINAL_PROMPT, '0', 'git без GIT_TERMINAL_PROMPT=0: ' + c.key);
    assert.equal(c.env && c.env.GCM_INTERACTIVE, 'never', 'git без GCM_INTERACTIVE=never: ' + c.key);
  }
  assert.ok(!git.keys().includes('push -u origin main'), 'отказан достъп не е отказан клон — резервният път не бива да тръгва');
  h.cat.stopAutoPushTimer();
});

test('34: остатъци от убит git — старите *.lock се махат, пресните остават, започнат rebase/merge се прекратява', async () => {
  const dir = fakeFolder('inv-v2485-lock-');
  const gd = path.join(dir, '.git');
  const old = (Date.now() - 5 * 60 * 1000) / 1000;
  fs.writeFileSync(path.join(gd, 'index.lock'), '');
  fs.utimesSync(path.join(gd, 'index.lock'), old, old);
  fs.writeFileSync(path.join(gd, 'refs', 'heads', 'main.lock'), '');
  fs.utimesSync(path.join(gd, 'refs', 'heads', 'main.lock'), old, old);
  fs.mkdirSync(path.join(gd, 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'refs', 'remotes', 'origin', 'katalog.lock'), '');   // пресен — на жив git
  fs.mkdirSync(path.join(gd, 'rebase-merge'));
  fs.writeFileSync(path.join(gd, 'MERGE_HEAD'), 'a'.repeat(40));
  const git = fakeGit(dir, { on: (k) => {
    if (k === 'rebase --abort') fs.rmSync(path.join(gd, 'rebase-merge'), { recursive: true, force: true });
    if (k === 'merge --abort') fs.rmSync(path.join(gd, 'MERGE_HEAD'), { force: true });
  } });
  const h = register(dir, { db: freshDb(dir), execFile: git.fn });
  const r = await h.ipc.invoke('catalog:gitPublishNow');
  assert.equal(r.ok, true, r.error);
  assert.ok(!fs.existsSync(path.join(gd, 'index.lock')), 'старият index.lock спира всяко следващо публикуване');
  assert.ok(!fs.existsSync(path.join(gd, 'refs', 'heads', 'main.lock')), 'старото заключване на клон остана');
  assert.ok(fs.existsSync(path.join(gd, 'refs', 'remotes', 'origin', 'katalog.lock')), 'пресно заключване може да е на жив git — не се пипа');
  const keys = git.keys();
  assert.ok(keys.includes('rebase --abort'), 'започнатият rebase не беше прекратен');
  assert.ok(keys.includes('merge --abort'), 'започнатото сливане не беше прекратено');
  assert.ok(keys.indexOf('rebase --abort') < keys.findIndex(k => k.startsWith('hash-object')), 'почистването е ПРЕДИ публикуването');
  assert.ok(h.audit.some(a => /прекъсната git операция/.test(a)), 'възстановяването трябва да остави ред');
  h.cat.stopAutoPushTimer();
});

test('32: провалите — ред в следата само при преход, опитите през 5, 10, 20, 40, 60, 60 минути; бутонът нулира', async (t) => {
  const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const dir = fakeFolder('inv-v2485-back-');
  let offline = true;
  const git = fakeGit(dir, { fail: (k) => offline && k.startsWith('push') ? { stderr: 'fatal: unable to access: Could not resolve host: github.com' } : null });
  const h = register(dir, { db: freshDb(dir), execFile: git.fn });
  const failLines = () => h.audit.filter(a => /се провали/.test(a)).length;
  const pushes = () => git.keys().filter(k => k.startsWith('push')).length;
  const status = async () => (await h.ipc.invoke('catalog:autoPushStatus')).data;

  await h.timers.tick();
  let st = await status();
  assert.ok(st.error, 'провалът трябва да стои в лентата');
  assert.equal(failLines(), 1);
  const deltas = [];
  let prev = Date.now();
  for (let i = 0; i < 5; i++) {
    const next = Date.parse((await status()).nextTryAt);
    deltas.push((next - prev) / 60000);
    // цикъл на таймера 5 минути ПРЕДИ уречения час — не бива да опитва
    if (next - prev > 5 * 60000) {
      const before = pushes();
      t.mock.timers.tick(next - prev - 5 * 60000);
      await h.timers.tick();
      assert.equal(pushes(), before, 'опит преди изтичането на изчакването');
      t.mock.timers.tick(5 * 60000);
    } else {
      t.mock.timers.tick(next - prev);
    }
    prev = Date.now();
    await h.timers.tick();
  }
  deltas.push((Date.parse((await status()).nextTryAt) - prev) / 60000);
  assert.deepEqual(deltas, [5, 10, 20, 40, 60, 60], 'изчакването след провал трябва да расте до час');
  assert.equal(failLines(), 1, 'всеки провал пише ред — 12 на час без интернет');
  assert.equal((await status()).failures, 6);

  // „Публикувай сега“ нулира изчакването (и още не върви: един нов ред — за бутона).
  await h.ipc.invoke('catalog:gitPublishNow');
  st = await status();
  assert.equal(st.failures, 1);
  assert.equal(Date.parse(st.nextTryAt) - Date.now(), 5 * 60000, 'след бутона нормалният ритъм се връща');

  // Връзката се връща → ред „отново минава“, лентата изчезва, броячът е нула.
  offline = false;
  t.mock.timers.tick(5 * 60000);
  await h.timers.tick();
  st = await status();
  assert.equal(st.error, null);
  assert.equal(st.failures, 0);
  assert.ok(h.audit.some(a => /отново минава/.test(a)), 'възстановяването трябва да остави ред');
  h.cat.stopAutoPushTimer();
});

test('31: само наличност — най-много веднъж на 30 минути; фондът и неизвестната промяна — веднага; провал връща вида', async (t) => {
  const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const dir = fakeFolder('inv-v2485-circ-');
  let failPush = false;
  const git = fakeGit(dir, { fail: (k) => failPush && k.startsWith('push') ? { stderr: 'Could not resolve host' } : null });
  const ch = changes();
  const h = register(dir, { db: freshDb(dir), execFile: git.fn, catalogChanges: ch });
  const katPushes = () => git.keys().filter(k => /:refs\/heads\/katalog$/.test(k)).length;
  const hashes = () => git.keys().filter(k => k.startsWith('hash-object')).length;

  ch.d.circ = true;
  await h.timers.tick();                      // няма предишно качване → веднага
  assert.equal(katPushes(), 1);
  assert.deepEqual(ch.peek(), { fund: false, circ: false }, 'публикуваният вид не беше изчистен');

  const step = async (n) => { t.mock.timers.tick(5 * 60000); await h.timers.tick(); return n; };
  fs.writeFileSync(path.join(dir, 'katalog.json'), kat(2));
  ch.d.circ = true;
  const h0 = hashes();
  for (let i = 0; i < 5; i++) await step(i);  // 5, 10 … 25 минути
  assert.equal(katPushes(), 1, 'заемане/връщане се качи по-рано от 30 минути');
  assert.equal(hashes(), h0, 'отложеният цикъл не бива да пуска git изобщо');
  await step(5);                              // 30 минути
  assert.equal(katPushes(), 2, 'след 30 минути наличността трябва да излезе');

  fs.writeFileSync(path.join(dir, 'katalog.json'), kat(3));
  ch.d.circ = true; ch.d.fund = true;
  await step(6);
  assert.equal(katPushes(), 3, 'промяна по фонда трябва да излезе при следващия цикъл');

  fs.writeFileSync(path.join(dir, 'katalog.json'), kat(4));
  await step(7);                              // без вид (ръчен запис, друг ден) — веднага
  assert.equal(katPushes(), 4);

  fs.writeFileSync(path.join(dir, 'katalog.json'), kat(5));
  ch.d.fund = true;
  failPush = true;
  await step(8);
  assert.deepEqual(ch.peek(), { fund: true, circ: false }, 'при провал видът на промяната се губи');
  h.cat.stopAutoPushTimer();
});

test('39: публикуване ~45 s след старта — без ритъма за наличността; спирането на таймерите спира и него', async (t) => {
  const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const dir = fakeFolder('inv-v2485-start-');
  const git = fakeGit(dir);
  const ch = changes();
  const h = register(dir, { db: freshDb(dir), execFile: git.fn, catalogChanges: ch });
  assert.equal(typeof h.timers.startup, 'function', 'няма публикуване малко след старта (45 s)');
  await h.timers.tick();                      // първо качване
  fs.writeFileSync(path.join(dir, 'katalog.json'), kat(2));
  ch.d.circ = true;
  t.mock.timers.tick(60000);
  await h.timers.startup();
  assert.equal(git.keys().filter(k => /:refs\/heads\/katalog$/.test(k)).length, 2,
    'публикуването при старт трябва да качи и наличността, без да чака 30 минути');
  h.cat.stopAutoPushTimer();
  const h2 = register(dir, { db: freshDb(mkTmpDir('inv-v2485-start2-')), execFile: git.fn });
  const realCI = global.clearInterval, realCT = global.clearTimeout;
  global.clearInterval = (hd) => { h2.timers.cleared.push(hd && hd.kind); };
  global.clearTimeout = (hd) => { h2.timers.cleared.push(hd && hd.kind); };
  try { h2.cat.stopAutoPushTimer(); }
  finally { global.clearInterval = realCI; global.clearTimeout = realCT; }
  assert.ok(h2.timers.cleared.includes('startup') && h2.timers.cleared.includes('interval'),
    'stopAutoPushTimer() трябва да спре и двата таймера: ' + JSON.stringify(h2.timers.cleared));
});

test('39: при затваряне — публикуване с таван; диалог САМО ако не успее или не стигне до края', async () => {
  // а) нищо променено след старта → null, затварянето е синхронно, без диалог
  const dirA = fakeFolder('inv-v2485-quitA-');
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(path.join(dirA, 'katalog.json'), old, old);
  const a = register(dirA, { db: freshDb(dirA), execFile: fakeGit(dirA).fn });
  const realCI = global.clearInterval, realCT = global.clearTimeout;
  global.clearInterval = (hd) => { a.timers.cleared.push(hd && hd.kind); };
  global.clearTimeout = (hd) => { a.timers.cleared.push(hd && hd.kind); };
  let pa;
  try { pa = a.cat.publishOnQuit(1000); }
  finally { global.clearInterval = realCI; global.clearTimeout = realCT; }
  assert.equal(pa, null);
  assert.ok(a.timers.cleared.includes('interval') && a.timers.cleared.includes('startup'),
    'при затваряне таймерите трябва да спрат веднага — по време на изчакването не тръгва нов цикъл');
  assert.equal(a.cat.warnUnpublishedCatalogOnQuit(), null);
  assert.equal(a.dialogs.length, 0);

  // б) промяна след старта, публикуването минава → без диалог
  const dirB = fakeFolder('inv-v2485-quitB-');
  const gitB = fakeGit(dirB);
  const b = register(dirB, { db: freshDb(dirB), execFile: gitB.fn });
  await sleep(15);
  fs.writeFileSync(path.join(dirB, 'katalog.json'), kat(2));
  const pb = b.cat.publishOnQuit(5000);
  assert.ok(pb && typeof pb.then === 'function', 'непубликувана промяна при затваряне трябва да тръгне към GitHub');
  assert.equal(await pb, true);
  assert.ok(gitB.keys().some(k => /:refs\/heads\/katalog$/.test(k)));
  assert.equal(b.cat.warnUnpublishedCatalogOnQuit(), null, 'публикувано при затваряне — предупреждението е излишно');
  assert.equal(b.dialogs.length, 0);

  // в) GitHub не отговаря → таванът изтича, git се спира, диалогът казва защо
  const dirC = fakeFolder('inv-v2485-quitC-');
  const gitC = fakeGit(dirC, { hang: (k) => k.startsWith('push') });
  const c = register(dirC, { db: freshDb(dirC), execFile: gitC.fn });
  await sleep(15);
  fs.writeFileSync(path.join(dirC, 'katalog.json'), kat(2));
  const t0 = Date.now();
  const res = await c.cat.publishOnQuit(150);
  assert.equal(res, false);
  assert.ok(Date.now() - t0 < 2000, 'затварянето не бива да чака повече от тавана');
  assert.ok(gitC.keys().some(k => k.startsWith('KILL push')), 'недовършеният git трябва да се спре');
  const text = c.cat.warnUnpublishedCatalogOnQuit();
  assert.match(text || '', /не приключи до/);
  assert.equal(c.dialogs.length, 1, 'неуспешното публикуване при затваряне трябва да се каже');

  // г) push се проваля → диалог с причината
  const dirD = fakeFolder('inv-v2485-quitD-');
  const d = register(dirD, { db: freshDb(dirD), execFile: fakeGit(dirD, { fail: (k) => k.startsWith('push') ? { stderr: 'Could not resolve host: github.com' } : null }).fn });
  await sleep(15);
  fs.writeFileSync(path.join(dirD, 'katalog.json'), kat(2));
  assert.equal(await d.cat.publishOnQuit(5000), false);
  assert.match(d.cat.warnUnpublishedCatalogOnQuit() || '', /Could not resolve host/);
  assert.equal(d.dialogs.length, 1);
});

/* ==========================================================================
   В) main.js и ci.yml
   ========================================================================== */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('39: main.js — публикуването при затваряне върви УСПОРЕДНО с моста, преди копието и затварянето на базата', () => {
  const MAIN = stripComments(MAIN_SRC);
  assert.match(MAIN, /const CATALOG_QUIT_PUBLISH_MS = 12000;/);
  const quit = MAIN.slice(MAIN.indexOf("app.on('window-all-closed'"), MAIN.indexOf('function finishQuit()'));
  const iOnline = quit.indexOf('flushOnlineSyncOnQuit(ONLINE_QUIT_FLUSH_MS)');
  const iWrite = quit.indexOf('if (catalogWriteDebouncer.pending()) flushCatalogWrite();');
  const iPub = quit.indexOf('publishOnQuit(CATALOG_QUIT_PUBLISH_MS)');
  const iWait = quit.indexOf('Promise.all(pendingQuit).then(finishQuit, finishQuit)');
  assert.ok(iOnline > 0 && iWrite > iOnline && iPub > iWrite && iWait > iPub,
    'редът е: мост → запис на каталога → публикуване → общо изчакване → finishQuit');
  const fin = MAIN.slice(MAIN.indexOf('function finishQuit()'));
  const order = ['warnUnpublishedCatalogOnQuit();', 'stopAutoPushTimer();', 'backupBeforeQuit()', 'db.close()'].map(x => fin.indexOf(x));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'finishQuit: предупреждение → таймер → копие → база');
});

test('31: main.js — видът на промяната стига до публикуването чак когато е записан във файла', () => {
  const take = (name) => {
    const i = MAIN_SRC.indexOf('const ' + name + ' = {');
    assert.ok(i >= 0, name + ' липсва в main.js');
    let depth = 0;
    for (let j = MAIN_SRC.indexOf('{', i); j < MAIN_SRC.length; j++) {
      if (MAIN_SRC[j] === '{') depth++;
      else if (MAIN_SRC[j] === '}' && --depth === 0) return MAIN_SRC.slice(i, MAIN_SRC.indexOf(';', j) + 1);
    }
    throw new Error(name);
  };
  const ctx = vm.createContext({ setTimeout: () => ({ unref() {} }), clearTimeout() {} });
  const src = [
    fs.readFileSync(path.join(APP_DIR, 'debounce.js'), 'utf8').match(/function createDebouncer[\s\S]*?\n\}/)[0],
    // Подставеният запис „минава“ — и прави точно това, което прави истинският при успех.
    'function writeCatalogIfConfigured() { moveWrittenKindsToPublish(); return { written: true }; }',
    ...['CATALOG_WRITE_CIRCULATION', 'CATALOG_WRITE_DEBOUNCE_FUND_MS', 'CATALOG_WRITE_DEBOUNCE_CIRC_MS', 'CATALOG_WRITE_STATE',
      'CATALOG_PUBLISH_DIRT'].map(extractDeclaration),
    take('catalogChanges'),
    ...['moveWrittenKindsToPublish', 'runPendingCatalogWrite', 'catalogFundWriter', 'catalogCircWriter', 'dropCatalogPayloadCache',
      'CATALOG_PAYLOAD_CACHE', 'scheduleCatalogWrite', 'flushCatalogWrite'].map(extractDeclaration),
    '({ scheduleCatalogWrite, flushCatalogWrite, catalogChanges, CATALOG_WRITE_CIRCULATION })'
  ].join('\n');
  const m = vm.runInContext(src, ctx);
  m.scheduleCatalogWrite(m.CATALOG_WRITE_CIRCULATION);
  assert.deepEqual({ ...m.catalogChanges.peek() }, { fund: false, circ: false }, 'насрочено, но незаписано, не бива да се публикува');
  m.flushCatalogWrite();
  assert.deepEqual({ ...m.catalogChanges.peek() }, { fund: false, circ: true }, 'заемането не стигна до публикуването като „наличност“');
  m.scheduleCatalogWrite();
  m.flushCatalogWrite();
  const k = m.catalogChanges.take();
  assert.deepEqual({ ...k }, { fund: true, circ: true });
  assert.deepEqual({ ...m.catalogChanges.peek() }, { fund: false, circ: false });
  m.catalogChanges.restore(k);
  assert.deepEqual({ ...m.catalogChanges.peek() }, { fund: true, circ: true }, 'restore() не върна вида след провал');
  // Истинският запис вика прехвърлянето — само по пътя на успешния запис.
  const w = extractDeclaration('writeCatalogIfConfigured');
  assert.ok(w.indexOf('moveWrittenKindsToPublish();') > 0
    && w.indexOf('moveWrittenKindsToPublish();') < w.indexOf('return noteCatalogWrite({ written: true'),
    'writeCatalogIfConfigured трябва да прехвърля видовете точно преди успешния отговор');
  assert.match(MAIN_SRC, /catalogJsonText, catalogChanges\s*\}\);/, 'main.js не подава catalogChanges на handlers/catalog.js');
});

test('30: ci.yml не се пуска за клона `katalog`, нито за push само на katalog.json', () => {
  const ci = fs.readFileSync(path.join(REPO_DIR, '.github', 'workflows', 'ci.yml'), 'utf8');
  const on = ci.slice(ci.search(/^on:/m), ci.search(/^permissions:/m));
  assert.match(on, /push:\s*\n\s+branches-ignore: \[katalog\]\s*\n\s+paths-ignore: \['katalog\.json'\]/);
  assert.match(on, /pull_request:\s*\n\s+paths-ignore: \['katalog\.json'\]/);
  // Другите workflow-и не се пускат от качването на каталога.
  const trig = (f) => {
    const src = fs.readFileSync(path.join(REPO_DIR, '.github', 'workflows', f), 'utf8');
    return src.slice(src.search(/^on:/m), src.search(/^(permissions|jobs|concurrency|env):/m));
  };
  assert.match(trig('release-electron.yml'), /push:\s*\n\s+tags:/, 'изданието тръгва само от таг');
  const sk = trig('skener-pages.yml');
  assert.match(sk, /push:\s*\n\s+branches: \[main\]\s*\n\s+paths:/, 'страницата на скенера — само при свои файлове');
  assert.ok(!/katalog\.json/.test(sk));
  assert.ok(!/^\s+push:/m.test(trig('virustotal.yml')), 'VirusTotal не се пуска от push');
});
