#!/usr/bin/env node
'use strict';
/* ============================================================================
   ТИПОВЕТЕ НА РЕДОВЕТЕ ОТ БАЗАТА — types/db.generated.d.ts (v2.4.74).
   ============================================================================
   Източникът е ИСТИНСКАТА схема, не schema.sql: програмата се стартира в
   процеса (като в тестовете — test/helpers/main-app.js), минава през
   schema.sql, ensureColumns() и миграциите, после се викат каналите, които
   добавят колони при първа употреба (ALTER TABLE … ADD COLUMN в handlers/),
   и се четат PRAGMA table_info за всяка таблица. Така типът е точно това,
   което базата на библиотекаря има след обновяване.

     node scripts/gen-db-types.js           — записва файла;
     node scripts/gen-db-types.js --check   — проверява, че е актуален (CI).

   Всяка таблица става `interface Db<Име>` (books → DbBooks, loans → DbLoans…).
   Договорът (types/ipc-contract.d.ts) изгражда редовете си върху тях — нова
   колона в схемата стига до екрана без ръчно преписване, а изтрита или
   преименувана колона, която екранът още чете, е грешка при проверката. */
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const OUT = path.join(APP_DIR, 'types', 'db.generated.d.ts');

/* Каналите, които при първа употреба добавят колони или таблици (виж
   ensure…() в handlers/). Само за четене — нищо не се записва. */
const LAZY_SCHEMA_CHANNELS = [
  'deaccessionActs:list', 'deaccessionActs:drafts', 'loans:lost', 'loans:lostPolicy',
  'periodicals:list', 'inventorySessions:list'
];

/* FTS5 пази индекса си в скрити таблици — те не са редове на програмата. */
const SKIP = /^(sqlite_|.*_fts_(config|data|docsize|idx|content)$)/;

function pascal(name) {
  return name.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}
/* Декларираният тип на колоната → TypeScript. SQLite не пази строг тип, но
   програмата декларира всяка колона; колона без тип (FTS) е текст. */
function tsType(decl) {
  const t = String(decl || '').toUpperCase();
  if (/INT/.test(t)) return 'number';
  if (/REAL|FLOA|DOUB|NUM|DEC/.test(t)) return 'number';
  if (/BLOB/.test(t)) return 'Uint8Array';
  return 'string';
}

async function readSchema() {
  const { startMainApp } = require('../test/helpers/main-app');
  const Database = require('better-sqlite3');
  /* Стартирането пише в конзолата (миграции, резервно копие…) — при проверката
     в CI това е шум; пази се и се показва само ако генераторът се провали. */
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const heard = [];
  for (const k of Object.keys(saved)) console[k] = (...a) => heard.push(a.join(' '));
  const app = startMainApp();
  try {
    await app.ready();
    for (const ch of LAZY_SCHEMA_CHANNELS) {
      const r = await app.invoke(ch);
      if (!r || !r.ok) throw new Error('gen-db-types: ' + ch + ' не мина: ' + (r && r.error));
    }
    const db = new Database(path.join(app.userData, 'library.db'), { readonly: true });
    try {
      const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all()
        .filter(t => !SKIP.test(t.name));
      return tables.map(t => ({
        name: t.name, view: t.type === 'view',
        cols: db.prepare('PRAGMA table_info("' + t.name.replace(/"/g, '""') + '")').all()
      }));
    } finally { db.close(); }
  } catch (err) {
    Object.assign(console, saved);
    if (heard.length) console.error(heard.join('\n'));
    throw err;
  } finally { app.stop(); Object.assign(console, saved); }
}

/* Всичко, което кодът добавя към схемата извън schema.sql, трябва да е в
   схемата, която генераторът вижда — иначе е добавено от канал извън
   LAZY_SCHEMA_CHANNELS и типът би го пропуснал тихо. Чете се:
     • ALTER TABLE t ADD COLUMN c — с буквално име;
     • ALTER TABLE t ADD COLUMN ${name} в цикъл по Object.entries(ОБЕКТ) —
       ключовете на обекта (handlers/loans.js, ensureLostSchema);
     • ensureColumns('t', { c: …, … }) — ключовете (main.js);
     • CREATE TABLE IF NOT EXISTS t — таблицата.
   ADD COLUMN с име, което не може да се прочете така, е грешка на генератора,
   не тихо разминаване. */
function objectKeysAt(src, at) {
  let d = 0, i = at, body = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { d++; if (d === 1) continue; }
    if (c === '}') { d--; if (d === 0) break; }
    if (d >= 1) body += d === 1 ? c : ' ';
  }
  return [...body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*:/gim)].map(m => m[1]);
}
function lazyColumnsInCode() {
  const files = ['main.js'].concat(fs.readdirSync(path.join(APP_DIR, 'handlers')).filter(f => f.endsWith('.js')).map(f => path.join('handlers', f)));
  const out = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
    for (const m of src.matchAll(/ALTER TABLE\s+([a-z_0-9]+)\s+ADD COLUMN\s+([a-z_0-9]+)/gi)) out.push({ file: f, table: m[1], col: m[2] });
    for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_0-9]+)/gi)) out.push({ file: f, table: m[1], col: null });
    for (const m of src.matchAll(/ensureColumns\('([a-z_0-9]+)',\s*\{/g)) {
      for (const col of objectKeysAt(src, m.index + m[0].length - 1)) out.push({ file: f, table: m[1], col });
    }
    for (const m of src.matchAll(/ALTER TABLE\s+(\$\{\w+\}|[a-z_0-9]+)\s+ADD COLUMN\s+\$\{/g)) {
      if (m[1].startsWith('${')) continue;   // самата ensureColumns() — ключовете ѝ са прочетени по-горе
      const before = src.slice(0, m.index);
      const ent = [...before.matchAll(/Object\.entries\((\w+)\)/g)].pop();
      const decl = ent && [...before.matchAll(new RegExp('const ' + ent[1] + '\\s*=\\s*\\{', 'g'))].pop();
      if (!decl) throw new Error('gen-db-types: ' + f + ': ALTER TABLE ' + m[1] + ' ADD COLUMN ${…} — не мога да прочета имената на колоните');
      for (const col of objectKeysAt(src, decl.index + decl[0].length - 1)) out.push({ file: f, table: m[1], col });
    }
  }
  return out;
}

function render(schema) {
  const lines = [
    '// ГЕНЕРИРАН ФАЙЛ — не се пише на ръка. Източник: истинската схема на базата',
    '// (schema.sql + ensureColumns() + миграциите). Обновяване: npm run gen:db-types',
    '// (виж scripts/gen-db-types.js). Без strictNullChecks `| null` е само описание.',
    ''
  ];
  for (const t of schema) {
    lines.push('/** ' + (t.view ? 'Изглед' : 'Ред от таблица') + ' `' + t.name + '`. */');
    lines.push('interface Db' + pascal(t.name) + ' {');
    for (const c of t.cols) {
      const nullable = !c.notnull && !c.pk;
      lines.push('  ' + c.name + ': ' + tsType(c.type) + (nullable ? ' | null' : '') + ';');
    }
    lines.push('}');
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const schema = await readSchema();
  const have = new Set();
  for (const t of schema) for (const c of t.cols) have.add(t.name + '.' + c.name);
  const tables = new Set(schema.map(t => t.name));
  const missing = lazyColumnsInCode().filter(x => x.col == null ? !tables.has(x.table) : !have.has(x.table + '.' + x.col));
  if (missing.length) {
    throw new Error('gen-db-types: колони, добавяни от кода, които генераторът не вижда — добавете канала, '
      + 'който ги създава, в LAZY_SCHEMA_CHANNELS:\n' + missing.map(x => '  ' + x.table + (x.col ? '.' + x.col : ' (таблица)') + ' (' + x.file + ')').join('\n'));
  }
  const text = render(schema);
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== text) {
      console.error('types/db.generated.d.ts е остарял спрямо схемата — пуснете npm run gen:db-types.');
      process.exit(1);
    }
    console.log('types/db.generated.d.ts отговаря на схемата.');
  } else {
    fs.writeFileSync(OUT, text);
    console.log('записан types/db.generated.d.ts (' + schema.length + ' таблици)');
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), (err) => { console.error(err.message || err); process.exit(1); });
}
module.exports = { readSchema, render, lazyColumnsInCode, OUT };
