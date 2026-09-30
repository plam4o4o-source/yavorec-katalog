'use strict';
/* Извлича SQL текстовете от .prepare(…) в даден изходен файл (test/shema-v2474).
   Статичен низ ('…', "…", `…` без ${}) се взима както е. Шаблон с ${ИМЕ}, където
   ИМЕ е константа на файла със статична стойност, се сглобява; останалите
   (стойност, изчислена при изпълнение) се броят като непроверими. */
const fs = require('fs');

function readLiteral(s, i) {
  const q = s[i];
  let j = i + 1, body = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { body += s[j + 1]; j += 2; continue; }
    if (c === q) return { body, end: j + 1 };
    if (q === '`' && c === '$' && s[j + 1] === '{') {
      let depth = 1, k = j + 2, expr = '';
      while (depth) { if (s[k] === '{') depth++; else if (s[k] === '}') depth--; if (depth) expr += s[k]; k++; }
      body += '\u0000' + expr.trim() + '\u0000';
      j = k; continue;
    }
    body += c; j++;
  }
  return null;
}

/* const ИМЕ = '…' | `…` на най-горно ниво или в тялото на register-функцията. */
function constants(src) {
  const out = {};
  for (const m of src.matchAll(/\bconst\s+([A-Z_][A-Z0-9_]*)\s*=\s*(['"`])/g)) {
    const lit = readLiteral(src, m.index + m[0].length - 1);
    if (!lit) continue;
    // Долепени низове: 'a' + 'b' + …
    let body = lit.body, k = lit.end;
    for (;;) {
      const rest = /^\s*\+\s*(['"`])/.exec(src.slice(k, k + 200));
      if (!rest) break;
      const next = readLiteral(src, k + rest[0].length - 1);
      if (!next) break;
      body += next.body; k = next.end;
    }
    // Само изцяло статична стойност: 'a' + 'b'; — не '(' + списък.map(…).
    if (!/^\s*;/.test(src.slice(k, k + 20))) continue;
    out[m[1]] = body;
  }
  return out;
}

function resolve(body, consts, depth) {
  if (depth > 5) return null;
  let ok = true;
  const text = body.replace(/\u0000([^\u0000]*)\u0000/g, (_, expr) => {
    if (Object.prototype.hasOwnProperty.call(consts, expr)) {
      const r = resolve(consts[expr], consts, depth + 1);
      if (r != null) return r;
    }
    ok = false; return '';
  });
  return ok ? text : null;
}

function extract(file) {
  const src = fs.readFileSync(file, 'utf8');
  const consts = constants(src);
  const found = [];
  for (const m of src.matchAll(/\.prepare\(\s*/g)) {
    const at = m.index + m[0].length;
    const line = src.slice(0, at).split('\n').length;
    if (!/['"`]/.test(src[at])) { found.push({ line, sql: null, why: 'не е низ' }); continue; }
    let lit = readLiteral(src, at);
    if (!lit) { found.push({ line, sql: null, why: 'нечетим низ' }); continue; }
    let body = lit.body, k = lit.end;
    for (;;) {
      const rest = /^\s*\+\s*(['"`])/.exec(src.slice(k, k + 200));
      if (!rest) break;
      const next = readLiteral(src, k + rest[0].length - 1);
      if (!next) break;
      body += next.body; k = next.end;
    }
    if (!/^\s*[,)]/.test(src.slice(k, k + 50))) { found.push({ line, sql: null, why: 'сглобява се при изпълнение' }); continue; }
    const sql = resolve(body, consts, 0);
    found.push(sql == null ? { line, sql: null, why: 'шаблон със стойност от изпълнението' } : { line, sql });
  }
  return found;
}
module.exports = { extract };
