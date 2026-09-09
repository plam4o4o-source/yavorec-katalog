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
  /* Сравнението е СИМЕТРИЧНО — проверява се и в двете посоки.

     Самата проверка не е: при равен брой пълни думи за „по-късо“ се взима
     първото име и се гледат само НЕГОВИТЕ инициали. Затова „Иванов“ ≈
     „Г. Иванов“ излизаше вярно, а „Г. Иванов“ ≈ „Иванов“ — невярно. Досега
     редовете се сравняваха в реда на заявката (ORDER BY n DESC), тоест дали
     двата записа изобщо ще бъдат предложени за сливане зависеше от това КОЙ
     ОТ ДВАТА има повече книги — една и съща база даваше различни групи според
     броевете. Обхождането в двете посоки маха тази зависимост и не разхлабва
     правилото: „Димитър Колев“ и „Димитър Костов“ пак не съвпадат, „Г. Иванов“
     и „П. Иванов“ също. */
  /* Думите се разделят на пълни и инициали ВЕДНЪЖ на стойност (splitName), а не
     наново при всяка двойка — при няколко хиляди стойности това е разликата
     между секунди и части от секундата. */
  const splitName = (tokens) => ({
    full: tokens.filter(t => t.length > 1),
    init: tokens.filter(t => t.length === 1)
  });
  /* Едната посока не стига (виж бележката по-горе) — оттук нататък сравнява
     само това. Двете обвивки отпреди пренаписването (looseMatch/looseMatchTok)
     останаха без нито едно повикване и затова ги няма: мъртъв код до жива
     бележка кара следващия четец да търси несъществуваща разлика. */
  function looseMatchParts(a, b) { return oneWay(a, b) || oneWay(b, a); }
  function oneWay(a, b) {
    if (!a.full.length && !a.init.length) return false;
    if (!b.full.length && !b.init.length) return false;
    const aShorter = a.full.length <= b.full.length;
    const short = aShorter ? a.full : b.full;
    const long = (aShorter ? b.full : a.full).slice();
    const shortInit = aShorter ? a.init : b.init;
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
        /* Хлабавото сравнение минава през union-find, но НЕ всеки с всеки.
           Досега беше всеки с всеки, с преизчисляване на думите при всяка двойка,
           и коментарът твърдеше, че „стойностите са няколкостотин“. При истински
           фонд от 15 000 книги различните автори са ~15 000, а не няколкостотин:
           измерено, повикването отнемаше 2 мин. 21 сек. и през цялото време
           програмата стои залепнала — повикването е синхронно, прозорецът не се
           прерисува и изглежда като увиснала.

           Стесняването е точно, не приблизително: looseMatch иска ВСЯКА пълна
           дума на по-късото име да я има в по-дългото. Значи две имена могат да
           съвпаднат само ако делят поне една пълна дума — освен ако по-късото е
           само от инициали („И. В.“), каквито са единици. Затова се сравняват
           само двойките от една и съща дума, а имената без нито една пълна дума
           се сравняват с всички. Резултатът е същият; работата е много по-малка.
           Думите се смятат ВЕДНЪЖ на стойност, а не наново при всяка двойка. */
        const parent = rows.map((_, i) => i);
        const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
        const parts = rows.map(r => splitName(nameTokens(r.value)));
        const words = new Map();                       // пълна дума → редовете с нея
        const initialsOnly = [];                       // „И. В.“ — няма пълна дума
        parts.forEach((p, i) => {
          if (!p.full.length) { initialsOnly.push(i); return; }
          for (const w of new Set(p.full)) {
            if (!words.has(w)) words.set(w, []);
            words.get(w).push(i);
          }
        });
        /* Проверка само в рамките на една дума — това е ЦЯЛОТО ограничение върху
           работата. Тук стоеше и пропускане на двойките, които вече са в една
           група (`find(i) === find(j)`), но при мутационната проверка се оказа,
           че не държи нищо: измерено при 15 000 различни автора и 208 имена само
           от инициали, повикването отнема 706 ms с него и 643 ms без него.
           Махнато — правилото на този проект е да няма непроверена находчивост.
           (Списък от изпробвани двойки също не влиза: при 15 000 стойности той
           сам по себе си надхвърля тавана на Set.) */
        const pair = (i, j) => {
          if (i === j) return;
          if (looseMatchParts(parts[i], parts[j])) union(i, j);
        };
        for (const list of words.values()) {
          for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) pair(list[a], list[b]);
        }
        for (const i of initialsOnly) for (let j = 0; j < rows.length; j++) pair(i, j);
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
      logAudit('Авторитетни данни', `${AUTHORITY_FIELDS[field]}: ${list.length === 1 ? '1 стойност слята' : list.length + ' стойности слети'} в „${target}“ (${changed === 1 ? '1 документ' : changed + ' документа'})`);
      return { changed, merged: list.length };
    })
  );
};
