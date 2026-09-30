'use strict';
/* Извлича SQL текстовете от .prepare(…) в даден изходен файл (test/shema-v2474).
   =====================================================================
   Как се чете кодът, без да се изпълнява:
     • коментарите и низовете се разпознават (прост лексер) — `.prepare(` в
       коментар не е заявка, а `//` в низ не е коментар;
     • аргументът е низ ('…', "…", `…`), долепени низове ('a' + 'b') или ИМЕ
       на константа;
     • константа е `const ИМЕ = израз;` ПРЕДИ заявката (взима се най-близката
       по-горе — приблизително обхватът ѝ). Изразът се пресмята в празен
       vm-контекст, в който има само вече пресметнатите константи и require
       на модулите от db/ (чисти SQL късове) — затова `${FIELDS.join(', ')}`,
       `${F.QTY_JOIN}` и `${LOAN_SELECT}` се сглобяват. Израз, който зависи от
       нещо от изпълнението (db, аргумент, резултат), просто не се пресмята;
     • шаблон, чийто израз не се пресмята, е „непроверим“ и се брои. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* Лексер: маркира всеки знак като код, коментар или низ. Разпознава и
   регулярни изрази по предходния знак — достатъчно за този код. */
function scan(src) {
  const kind = new Uint8Array(src.length);   // 0 код, 1 коментар, 2 низ
  let i = 0;
  const stack = [];                           // вложени ${ … } в шаблони
  let lastSig = '';
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') kind[i++] = 1; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; while (i < end) kind[i++] = 1; continue; }
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(lastSig)) {
      kind[i++] = 2;
      let cls = false;
      while (i < src.length && (src[i] !== '/' || cls)) {
        if (src[i] === '\\') { kind[i++] = 2; }
        else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
        kind[i++] = 2;
      }
      kind[i++] = 2; lastSig = 'x'; continue;
    }
    if (c === "'" || c === '"') {
      kind[i++] = 2;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') kind[i++] = 2; kind[i++] = 2; }
      kind[i++] = 2; lastSig = 'x'; continue;
    }
    if (c === '`' || (c === '}' && stack.length && stack[stack.length - 1] === 0)) {
      if (c === '}') stack.pop();
      kind[i++] = 2;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { kind[i++] = 2; kind[i++] = 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { kind[i++] = 2; kind[i++] = 2; stack.push(0); break; }
        kind[i++] = 2;
      }
      if (src[i] === '`') { kind[i++] = 2; lastSig = 'x'; }
      continue;
    }
    if (c === '{' && stack.length) stack[stack.length - 1]++;
    if (c === '}' && stack.length) stack[stack.length - 1]--;
    if (!/\s/.test(c)) lastSig = /[A-Za-z0-9_$)\]]/.test(c) ? 'x' : c;
    i++;
  }
  return kind;
}

/* Изразът от позиция `at` до `;`, `,` или `)` на същото ниво (извън низове). */
function exprEnd(src, kind, at, stops) {
  let d = 0;
  for (let i = at; i < src.length; i++) {
    if (kind[i]) continue;
    const c = src[i];
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (d === 0) return i; d--; }
    else if (d === 0 && stops.includes(c)) return i;
  }
  return src.length;
}

function makeContext(file) {
  const dir = path.dirname(file);
  const dbDir = path.resolve(dir, '..', 'db');
  const ctx = vm.createContext(Object.create(null));
  /* Само чисти модули от db/ — никакъв достъп до базата, мрежата или файловете. */
  ctx.require = (id) => {
    const full = require.resolve(path.resolve(dir, id));
    if (path.dirname(full) !== dbDir && path.dirname(full) !== path.resolve(dir, 'db')) throw new Error('не');
    return require(full);
  };
  return ctx;
}

function extract(file) {
  const src = fs.readFileSync(file, 'utf8');
  const kind = scan(src);
  const lineOf = (i) => src.slice(0, i).split('\n').length;

  /* Всички const-декларации в кода: име → [{ at, rhsFrom, rhsTo }]. */
  const decls = {};
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    if (kind[m.index]) continue;
    const from = m.index + m[0].length;
    const to = exprEnd(src, kind, from, ';');
    (decls[m[1]] = decls[m[1]] || []).push({ at: m.index, from, to });
  }
  /* Също `const { A, B } = require('../db/…')` и `const F = require(…)` — второто е горе. */
  const destr = [];
  for (const m of src.matchAll(/\bconst\s*\{([^}]*)\}\s*=\s*(require\([^)]*\))/g)) {
    if (!kind[m.index]) destr.push({ at: m.index, names: m[1].split(',').map(x => x.split(':').pop().trim()).filter(Boolean), rhs: m[2] });
  }

  const ctx = makeContext(file);
  const memo = new Map();
  function valueOf(name, before, depth) {
    if (depth > 8) return undefined;
    const d = (decls[name] || []).filter(x => x.at < before).pop();
    if (d) {
      if (memo.has(d)) return memo.get(d);
      memo.set(d, undefined);
      const val = evalExpr(src.slice(d.from, d.to), d.at, depth + 1);
      memo.set(d, val);
      return val;
    }
    const ds = destr.filter(x => x.at < before && x.names.includes(name)).pop();
    if (ds) { try { return vm.runInContext(ds.rhs, ctx, { timeout: 50 })[name]; } catch (e) { return undefined; } }
    return undefined;
  }
  /* Пресмята израз: всяко свободно име се търси като константа по-горе. */
  function evalExpr(expr, before, depth) {
    const names = new Set([...expr.matchAll(/(?<![\w$.'"`])([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
    const local = Object.create(null);
    for (const n of names) {
      if (n === 'require') continue;
      const v = valueOf(n, before, depth);
      if (v !== undefined) local[n] = v;
    }
    try {
      const fnSrc = '(function(' + Object.keys(local).join(',') + '){ return (' + expr + '); })';
      const fn = vm.runInContext(fnSrc, ctx, { timeout: 50 });
      const v = fn(...Object.values(local));
      return (typeof v === 'string' || Array.isArray(v) || (v && typeof v === 'object')) ? v : undefined;
    } catch (e) { return undefined; }
  }

  const found = [];
  for (const m of src.matchAll(/\.prepare\(\s*/g)) {
    if (kind[m.index]) continue;                 // в коментар или низ
    const at = m.index + m[0].length;
    const end = exprEnd(src, kind, at, ',');
    const expr = src.slice(at, end).trim();
    const line = lineOf(at);
    if (!expr) { found.push({ line, sql: null, why: 'без аргумент' }); continue; }
    const v = evalExpr(expr, m.index, 0);
    if (typeof v === 'string') found.push({ line, sql: v });
    else found.push({ line, sql: null, why: /^[A-Za-z_$][\w$]*$/.test(expr) ? 'променлива от изпълнението' : 'стойност от изпълнението' });
  }
  return found;
}
module.exports = { extract, scan };
