// Контрол на авторитетните данни — извадени от main.js в отделен модул
// (Фаза 4, стъпка 11 от разбиването на монолита на модули по домейн).
// Едно и също име се въвежда по различен начин („Вазов, Иван“, „Иван
// Вазов“, „И. Вазов“) и записите се разпиляват. Тук се събират наличните
// стойности за автодовършване и се откриват вероятните дублети, за да
// бъдат слети. Изцяло самостоятелен: само getDb()/run/logAudit.
module.exports = function registerAuthoritiesHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  const AUTHORITY_FIELDS = {
    author: 'автор', publisher: 'издателство', city: 'място на издаване',
    language: 'език', udk: 'УДК', keywords: 'ключови думи', department: 'отдел',
    series: 'поредица' // v1.70.0 — ново поле; влиза в контрола на авторитетните данни
                        // по същата причина като автор/издателство — „Библиотека Галактика“
                        // и „Библ. Галактика“ иначе се разпиляват в отделни записи.
  };
  // Ключ за сравнение: без пунктуация и главни букви, думите подредени по азбучен
  // ред. Така „Вазов, Иван“ и „Иван Вазов“ дават един и същ ключ.
  function authKey(v) {
    return String(v || '').toLowerCase()
      .replace(/[.,;:„“"'`()\[\]]/g, ' ')
      .split(/\s+/).filter(Boolean).sort().join(' ');
  }
  function nameTokens(v) {
    return String(v || '').toLowerCase()
      .replace(/[.,;:„“"'`()\[\]]/g, ' ')
      .split(/\s+/).filter(Boolean);
  }
  /* Хлабаво сравнение, което хваща и съкратените имена: „И. Вазов“ = „Иван Вазов“.
     Правилото е по-строго, отколкото изглежда — по-късото име трябва да се съдържа
     изцяло в по-дългото, а всяка инициала да съвпада с началото на останала дума.
     Затова „Димитър Колев“ и „Димитър Костов“ НЕ съвпадат: втората пълна дума е
     различна. */
  function looseMatch(a, b) {
    const A = nameTokens(a), B = nameTokens(b);
    if (!A.length || !B.length) return false;
    const fullA = A.filter(t => t.length > 1), fullB = B.filter(t => t.length > 1);
    const initA = A.filter(t => t.length === 1), initB = B.filter(t => t.length === 1);
    const aShorter = fullA.length <= fullB.length;
    const short = aShorter ? fullA : fullB;
    const long = (aShorter ? fullB : fullA).slice();
    const shortInit = aShorter ? initA : initB;
    for (const w of short) {
      const i = long.indexOf(w);
      if (i < 0) return false;
      long.splice(i, 1);
    }
    for (const ini of shortInit) {
      const i = long.findIndex(w => w[0] === ini);
      if (i < 0) return false;
      long.splice(i, 1);
    }
    return true;
  }
  function authorityValues(field) {
    if (!(field in AUTHORITY_FIELDS)) throw new Error('Непознато поле: ' + field);
    return getDb().prepare(
      `SELECT ${field} AS value, COUNT(*) AS n FROM books
       WHERE ${field} IS NOT NULL AND TRIM(${field}) <> '' GROUP BY ${field} ORDER BY n DESC, ${field}`
    ).all();
  }
  ipcMain.handle('authorities:fields', () => run(() => AUTHORITY_FIELDS));
  ipcMain.handle('authorities:list', (e, field) => run(() => authorityValues(field)));
  // Стойностите за автодовършване във формата за книга — всички полета наведнъж.
  ipcMain.handle('authorities:suggest', () =>
    run(() => {
      const out = {};
      for (const f of Object.keys(AUTHORITY_FIELDS)) out[f] = authorityValues(f).map(r => r.value);
      return out;
    })
  );
  // Групи вероятни дублети. strict=true сравнява само разместени думи, иначе се
  // включват и съкратените имена, което е по-широко и изисква повече внимание.
  ipcMain.handle('authorities:duplicates', (e, { field, loose }) =>
    run(() => {
      const rows = authorityValues(field).filter(r => authKey(r.value));
      let buckets;
      if (!loose) {
        const m = new Map();
        for (const r of rows) {
          const k = authKey(r.value);
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(r);
        }
        buckets = [...m.values()];
      } else {
        // Сравнение всеки-с-всеки през union-find. Стойностите са няколкостотин,
        // затова цената е нищожна, а резултатът е далеч по-точен от ключ.
        const parent = rows.map((_, i) => i);
        const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        for (let i = 0; i < rows.length; i++) {
          for (let j = i + 1; j < rows.length; j++) {
            if (looseMatch(rows[i].value, rows[j].value)) {
              const a = find(i), b = find(j);
              if (a !== b) parent[a] = b;
            }
          }
        }
        const m = new Map();
        rows.forEach((r, i) => {
          const k = find(i);
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(r);
        });
        buckets = [...m.values()];
      }
      return buckets
        .filter(g => g.length > 1)
        .map(g => ({ items: g.sort((a, b) => b.n - a.n), total: g.reduce((s, r) => s + r.n, 0) }))
        .sort((a, b) => b.total - a.total);
    })
  );
  ipcMain.handle('authorities:merge', (e, { field, from, to }) =>
    run(() => {
      if (!(field in AUTHORITY_FIELDS)) throw new Error('Непознато поле: ' + field);
      const target = String(to || '').trim();
      if (!target) throw new Error('Липсва стойност, към която да се слее.');
      const list = (from || []).map(v => String(v)).filter(v => v && v !== target);
      if (!list.length) throw new Error('Няма избрани стойности за сливане.');
      const db = getDb();
      const stmt = db.prepare(`UPDATE books SET ${field} = ? WHERE ${field} = ?`);
      let changed = 0;
      db.transaction(() => { for (const v of list) changed += stmt.run(target, v).changes; }).immediate();
      logAudit('Авторитетни данни', `${AUTHORITY_FIELDS[field]}: ${list.length} стойности слети в „${target}“ (${changed} документа)`);
      return { changed, merged: list.length };
    })
  );
};
