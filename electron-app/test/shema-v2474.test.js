'use strict';
/* ============================================================================
   v2.4.74 — ТИПОВЕТЕ НА РЕДОВЕТЕ ИДВАТ ОТ СХЕМАТА, А SQL-ЪТ СЕ ПРОВЕРЯВА СРЕЩУ НЕЯ.
   ============================================================================
   (1) types/db.generated.d.ts е точно истинската схема (schema.sql +
       ensureColumns() + миграциите + колоните, добавяни при първа употреба).
   (2) Редовете в договора, които описват цяла таблица, я НАСЛЕДЯВАТ
       (`extends Db…`) и не добавят колони, които таблицата няма — изтрита или
       преименувана колона, която екранът още чете, е грешка при проверката.
   (3) Всеки SQL текст в main.js, handlers/ и db/, който може да се прочете без
       изпълнение, се подготвя (db.prepare) срещу истинската схема: грешно име на
       колона или таблица пада тук, а не при библиотекаря, когато някой отвори
       точно този екран. Шаблоните със стойност от изпълнението се броят, но не
       се проверяват — числото им стои в съобщението, за да не расте тихо. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { startMainApp } = require('./helpers/main-app');
const { extract } = require('./helpers/sql-extract');
const gen = require('../scripts/gen-db-types');

const APP_DIR = path.join(__dirname, '..');
const TSC = require.resolve('typescript/bin/tsc');
const tmpDirs = [];
let app, schema;
/* Таблиците и колоните от генерирания файл — за всички тестове по-долу. */
function readGenerated() {
  const out = {};
  for (const m of fs.readFileSync(gen.OUT, 'utf8').matchAll(/interface (Db\w+) \{\n([\s\S]*?)\n\}/g)) {
    out[m[1]] = new Set([...m[2].matchAll(/^ {2}(\w+):/gm)].map(x => x[1]));
  }
  return out;
}
test.before(async () => {
  schema = readGenerated();
  app = startMainApp();
  await app.ready();
});
test.after(() => {
  if (app) app.stop();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('types/db.generated.d.ts е точно схемата на базата', () => {
  const r = spawnSync(process.execPath, [path.join(APP_DIR, 'scripts', 'gen-db-types.js'), '--check'], { encoding: 'utf8', cwd: APP_DIR });
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
  assert.ok(Object.keys(schema).length >= 40, 'таблиците: ' + Object.keys(schema).length);
  assert.ok(schema.DbLoans.has('deaccession_fine_line_id') && schema.DbHolds.has('status_before'),
    'колоните, които кодът добавя при първа употреба, са в типовете');
  /* Пазачът на генератора чете и цикъла по Object.entries (ensureLostSchema),
     ensureColumns() и таблиците, създавани при първа употреба. */
  const lazy = gen.lazyColumnsInCode();
  assert.ok(lazy.some(x => x.table === 'loans' && x.col === 'lost_note'), 'цикълът в ensureLostSchema');
  assert.ok(lazy.some(x => x.file === 'main.js' && x.table === 'settings'), 'ensureColumns в main.js');
  assert.ok(lazy.some(x => x.table === 'periodical_volumes' && x.col == null), 'CREATE TABLE при първа употреба');
  for (const x of lazy) {
    assert.ok(x.col == null ? schema['Db' + x.table.split('_').map(p => p[0].toUpperCase() + p.slice(1)).join('')] : true, x.table);
  }
});

test('редовете в договора, които описват таблица, я наследяват и не си измислят колони', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'types', 'ipc-contract.d.ts'), 'utf8');
  const found = [];
  // Тялото е `{}` на същия ред или редове до `}` в началото на ред.
  for (const m of src.matchAll(/^interface (\w+) extends (?:Omit<)?(Db\w+)(?:, [^>]+>)? \{(\}|\n[\s\S]*?\n\})/gm)) {
    const [, name, db, body] = m;
    assert.ok(schema[db], name + ' наследява ' + db + ', а такава таблица няма');
    // Всички полета — и няколко на един ред („a: …; b: …;“).
    const own = [...body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|;|\{)\s*(\w+)\??\s*:/gm)].map(x => x[1]);
    for (const f of own) assert.ok(schema[db].has(f), name + '.' + f + ' — колона, която ' + db + ' няма');
    found.push(name);
  }
  /* Всичките 24 от v2.4.74 — ред, върнат към ръчно преписване, се забелязва.
     (Стеснен тип, който противоречи на колоната, е грешка на самия tsc —
     tsconfig.renderer.json проверява и нашите .d.ts.) */
  for (const n of ['LoanColumns', 'BookColumns', 'AccountLine', 'ActRow', 'ActItemRow', 'DraftRow', 'SessionRow',
    'ReaderColumns', 'HoldColumns', 'HouseboundProfileRow', 'HouseboundVisitRow', 'CircRuleRow', 'EmployeeRow', 'MzsRow',
    'SuggestionRow', 'AcqColumns', 'PeriodicalColumns', 'PeriodicalIssueRow', 'AnalyticColumns', 'PersonColumns',
    'ChronicleColumns', 'LinkColumns', 'SettingsRow', 'AuditLogRow']) {
    assert.ok(found.includes(n), n + ' вече не наследява таблицата си — пак ли е преписана на ръка?');
  }
});

test('на екрана: колона, която таблицата няма, е грешка; истинската не е', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-shema74-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'probe.js'), [
    /* 1 */ "async function ok1() { const l = await call(window.api.loans.byReader(1)); if (l) l[0].deaccession_fine_line_id; const s = await call(window.api.settings.get()); if (s) s.lbl_gx; }",
    /* 2 */ "async function bad2() { const l = await call(window.api.loans.byReader(1)); if (l) l[0].date_end; }",
    /* 3 */ "async function bad3() { const s = await call(window.api.settings.get()); if (s) s.library_name; }"
  ].join('\n'));
  const base = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'tsconfig.renderer.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: Object.assign({}, base.compilerOptions, { typeRoots: [path.join(APP_DIR, 'node_modules', '@types')] }),
    include: base.include.map(p => path.join(APP_DIR, p)).concat(path.join(dir, 'probe.js'))
  }));
  const r = spawnSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  const all = ((r.stdout || '') + (r.stderr || '')).split('\n');
  const lines = all.filter(l => l.includes('probe.js'));
  // Самите изгледи и .d.ts минават чисто — и стеснен тип, който противоречи на колоната си (TS2430).
  assert.deepEqual(all.filter(l => /error TS/.test(l) && !l.includes('probe.js')), []);
  const on = (n) => lines.filter(l => l.includes('probe.js(' + n + ','));
  assert.deepEqual(on(1), [], 'истинските колони');
  assert.ok(on(2).some(l => /date_end/.test(l)), 'loans.date_end:\n' + lines.join('\n'));
  assert.ok(on(3).some(l => /library_name/.test(l)), 'settings.library_name:\n' + lines.join('\n'));
});

test('всеки SQL текст, който може да се прочете, се подготвя срещу истинската схема', async () => {
  for (const ch of ['deaccessionActs:list', 'deaccessionActs:drafts', 'loans:lost', 'loans:lostPolicy', 'periodicals:list', 'inventorySessions:list']) {
    assert.equal((await app.invoke(ch)).ok, true, ch);
  }
  const db = new Database(path.join(app.userData, 'library.db'), { readonly: true });
  try {
    /* Функциите, които обработчиците регистрират в своята връзка (db.function) —
       тук само за да се компилира заявката; подготовката не ги изпълнява. */
    const all = ['main.js'].concat(
      fs.readdirSync(path.join(APP_DIR, 'handlers')).filter(f => f.endsWith('.js')).map(f => path.join('handlers', f)),
      fs.readdirSync(path.join(APP_DIR, 'db')).filter(f => f.endsWith('.js')).map(f => path.join('db', f)));
    const fns = new Set();
    for (const f of all) for (const m of fs.readFileSync(path.join(APP_DIR, f), 'utf8').matchAll(/\.function\('([a-z_0-9]+)'/g)) fns.add(m[1]);
    for (const fn of fns) db.function(fn, { varargs: true, deterministic: true }, () => null);

    let checked = 0, skipped = 0;
    const bad = [];
    for (const f of all) {
      for (const x of extract(path.join(APP_DIR, f))) {
        if (x.sql == null) { skipped++; continue; }
        checked++;
        try { db.prepare(x.sql); } catch (e) { bad.push(f + ':' + x.line + ' — ' + e.message + '\n    ' + x.sql.replace(/\s+/g, ' ').slice(0, 200)); }
      }
    }
    assert.deepEqual(bad, [], 'SQL, който схемата не приема:\n' + bad.join('\n'));
    assert.ok(checked >= 730, 'проверени заявки: ' + checked + ' — извличането спря да вижда част от тях?');
    /* Таванът на непроверимите (54 при v2.4.74): нов шаблон със стойност от
       изпълнението е позволен, но нека е решение, а не навик — вдигнете
       числото съзнателно. */
    assert.ok(skipped <= 60, 'непроверими заявки: ' + skipped + ' (таван 60)');
  } finally { db.close(); }
});
