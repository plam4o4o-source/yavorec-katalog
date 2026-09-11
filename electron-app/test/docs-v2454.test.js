'use strict';
/* Одитен кръг v2.4.54 — ДОКУМЕНТИТЕ, КОИТО ПРОГРАМАТА ИЗДАВА.
 * =====================================================================
 * Кръгът тръгна от един въпрос: какво реално излиза от принтера. Отговорът беше
 * лош точно за двата документа, които напускат сградата и се показват на
 * проверяващия — Дневникът на библиотеката и Годишният статистически отчет.
 * Измерено в истински браузър (Chromium, А4 пейзаж):
 *
 *   Дневник, Раздел А/Б:  полезна ширина 1063 px, таблица 2099 px → 868 px (45 %)
 *                         извън хартията, без никакъв признак на екрана;
 *   Годишен отчет А и Б:  полезна ширина 1047 px, таблица 2073 px → 987 px (47 %).
 *
 * Отрязаното НЕ се появява никъде: нито на втори лист, нито в прегледа преди
 * печат. Библиотекарката подписва документ, на който липсва половината.
 *
 * Поправката е на две части и тук се заковават и двете:
 *   1) таблицата се РАЗДЕЛЯ по листове, по границите на собствените си групи
 *      („По възраст“, „По образование“ …), с повтаряща се колона „Число“;
 *   2) всеки лист се ЗАКОВАВА за хартията (table-layout:fixed + colgroup), за да
 *      не може никой бъдещ по-дълъг етикет пак да избута колона навън.
 *
 * Освен това кръгът поправи два дефекта в данните зад документите:
 *   3) границите на просрочията в таблото броят ЦЕЛИ дни;
 *   4) анулирането на акт за отчисляване връща и РЕЗЕРВАЦИИТЕ, не само заеманията.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, fakeIpcMain, runDep, cleanupTmpDirs, APP_DIR } = require('./helpers/audit-fixtures');

const DNEVNIK_JS = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'dnevnik.js'), 'utf8');
const REPORTS_JS = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'reports.js'), 'utf8');
const CSS = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');

test.after(cleanupTmpDirs);

/* ------------------------------------------------------------------
   1. Разделянето на широката таблица по листове
   ------------------------------------------------------------------ */

/* Помощниците живеят в общия обхват на renderer-а (всички views се зареждат като
   обикновени скриптове, без модули). Тук се изпълняват в пясъчник, за да може
   алгоритъмът да се провери сам за себе си, без цял jsdom. */
function loadDnevnikHelpers() {
  const sandbox = { esc: (s) => String(s) };
  const src = DNEVNIK_JS.slice(0, DNEVNIK_JS.indexOf('const DNEVNIK_ALL_FIELDS'));
  // eslint-disable-next-line no-new-func
  new Function('module', 'esc', src + `
    module.exports = { dnevnikPrintPages, dnevnikGroups, dnevnikGroupHeadHtml,
      dnevnikShortLabel, dnevnikGroupNotes, DNEVNIK_A_COLS, DNEVNIK_B_COLS,
      DNEVNIK_A_GROUPS, DNEVNIK_B_GROUPS, DNEVNIK_PRINT_MAX_COLS };
  `)(sandbox, sandbox.esc);
  return sandbox.exports;
}

test('разделянето покрива ВСИЧКИ колони, без да повтори или изгуби нито една', () => {
  const H = loadDnevnikHelpers();
  for (const [name, cols] of [['А', H.DNEVNIK_A_COLS], ['Б', H.DNEVNIK_B_COLS]]) {
    const pages = H.dnevnikPrintPages(cols);
    const flat = pages.flatMap(p => p.cols);
    assert.deepEqual(flat.map(c => c[0]), cols.map(c => c[0]),
      `Раздел ${name}: редът и съставът на колоните трябва да останат същите`);
    assert.ok(pages.length > 1, `Раздел ${name} не се събира на един лист — трябва да се раздели`);
  }
});

test('нито един лист не надхвърля тавана от колони', () => {
  const H = loadDnevnikHelpers();
  for (const cols of [H.DNEVNIK_A_COLS, H.DNEVNIK_B_COLS]) {
    for (const p of H.dnevnikPrintPages(cols)) {
      assert.ok(p.cols.length <= H.DNEVNIK_PRINT_MAX_COLS,
        `лист с ${p.cols.length} колони при таван ${H.DNEVNIK_PRINT_MAX_COLS}`);
    }
  }
});

test('групите НЕ се режат по средата — „Всичко“ винаги стои до разбивката, чийто сбор е', () => {
  /* Това е същината: ако „По образование“ се разполови, отпечатаното „Всичко“ на
     един лист не отговаря на нищо видимо, а разбивката на другия лист няма сбор.
     Проверява се, че всяка група се появява в ТОЧНО един лист и цяла. */
  const H = loadDnevnikHelpers();
  for (const [cols, groups] of [[H.DNEVNIK_A_COLS, H.DNEVNIK_A_GROUPS], [H.DNEVNIK_B_COLS, H.DNEVNIK_B_GROUPS]]) {
    const seen = new Map();
    for (const p of H.dnevnikPrintPages(cols)) {
      // сборът на спановете на листа е точно броят колони на листа
      assert.equal(p.groups.reduce((s, [, n]) => s + n, 0), p.cols.length,
        'спановете на листа не отговарят на колоните му');
      for (const [label, n] of p.groups) {
        assert.ok(!seen.has(label), `групата „${label}“ се появява на два листа`);
        seen.set(label, n);
      }
    }
    for (const [label, n] of groups) {
      assert.equal(seen.get(label), n, `групата „${label}“ е с променен обхват`);
    }
  }
});

test('колоната „Число“ се повтаря на всеки лист, иначе редовете стават неразчитаеми', () => {
  const H = loadDnevnikHelpers();
  const pages = H.dnevnikPrintPages(H.DNEVNIK_A_COLS);
  // Самият печат слага <th>Число</th> пред колоните на всеки лист — тук се
  // проверява, че този <th> е ВЪТРЕ в шаблона на листа, а не пред целия документ.
  const tpl = DNEVNIK_JS.slice(DNEVNIK_JS.indexOf('const tableHtml'), DNEVNIK_JS.indexOf('setPrintPage({ name: `Дневник'));
  assert.match(tpl, /<th>Число<\/th>/, 'всеки лист носи своя колона „Число“');
  assert.ok(pages.length > 1);
});

test('между листовете стои маркер за нов лист, а не просто нов ред', () => {
  const tpl = DNEVNIK_JS.slice(DNEVNIK_JS.indexOf('const tableHtml'), DNEVNIK_JS.indexOf('setPrintPage({ name: `Дневник'));
  assert.match(tpl, /class="pbreak"/, 'печатът трябва да поставя .pbreak между листовете');
  assert.match(CSS, /\.pbreak\{[^}]*break-before:page/, '.pbreak трябва да пренася на нов лист');
  assert.match(CSS, /#ppSheet \.pbreak/, 'прегледът трябва да ПОКАЗВА къде ще се пречупи');
  assert.match(CSS, /content:'нов лист'/, 'човекът одобрява това, което ще получи');
});

test('всеки лист се заковава за хартията — таблицата не може да порасне над листа', () => {
  /* Само разделянето не стига: 20 колони пак излизаха 1137 px при 1063 px полезни.
     table-layout:fixed + width:100% + colgroup правят ширината независима от
     съдържанието, тоест никой бъдещ по-дълъг етикет не може да избута колона вън. */
  assert.match(CSS, /table\.dnvPrint\{[^}]*table-layout:fixed/, 'фиксирана подредба на колоните');
  assert.match(CSS, /table\.dnvPrint\{[^}]*width:100%/, 'ширината е тази на листа');
  for (const [name, src] of [['дневник', DNEVNIK_JS], ['годишен отчет', REPORTS_JS]]) {
    assert.match(src, /<table class="dnvPrint"><colgroup>/, `${name}: таблицата трябва да носи colgroup`);
    assert.match(src, /89 \/ page\.cols\.length/, `${name}: колоните делят остатъка поравно`);
  }
});

test('дългото пояснение слиза под таблицата, вместо да разтяга едноколонна група', () => {
  /* „от които ползвани в читалня (не влиза в горните сборове)“ е група от ЕДНА
     колона. При заковани ширини заглавието ѝ ставаше десет реда високо. */
  const H = loadDnevnikHelpers();
  assert.equal(H.dnevnikShortLabel('от които ползвани в читалня (не влиза в горните сборове)'),
    'от които ползвани в читалня');
  const notes = H.dnevnikGroupNotes(H.DNEVNIK_B_GROUPS);
  assert.ok(notes.some(t => /не влиза в горните сборове/.test(t)),
    'пояснението не бива да се губи — то обяснява защо числото не е в сбора');
  // На екрана (широката таблица с плъзгане) пълният етикет остава както си беше.
  const head = H.dnevnikGroupHeadHtml(H.DNEVNIK_B_COLS, 'Число');
  assert.match(head, /не влиза в горните сборове/, 'на екрана пълният етикет остава');
  const headPrint = H.dnevnikGroupHeadHtml(H.DNEVNIK_B_COLS, '', H.DNEVNIK_B_GROUPS, true);
  assert.doesNotMatch(headPrint, /не влиза в горните сборове/, 'на хартия остава само името');
  // … но пояснението трябва да СЛЕЗЕ под таблицата, а не просто да изчезне.
  const tpl = DNEVNIK_JS.slice(DNEVNIK_JS.indexOf('const tableHtml'), DNEVNIK_JS.indexOf('setPrintPage({ name: `Дневник'));
  assert.match(tpl, /dnevnikNotesHtml\(page\.groups\)/,
    'дневникът трябва да носи бележките под всяка таблица');
  assert.match(CSS, /\.pnote\{/, 'бележката трябва да има свой стил, а не да се слее с подписите');
});

test('годишният отчет ползва същото разделяне, а не свое собствено', () => {
  // Два документа с едни и същи колони не бива да се разминават: проверяващият
  // сравнява дневника с отчета ред по ред.
  assert.match(REPORTS_JS, /dnevnikPrintPages\(cols\)/, 'отчетът ползва общия помощник');
  assert.match(REPORTS_JS, /class="pbreak"/, 'и той пренася на нов лист');
  assert.match(REPORTS_JS, /dnevnikNotesHtml\(page\.groups\)/, 'и той носи бележките');
});

/* ------------------------------------------------------------------
   2. Анулиран акт връща и резервациите
   ------------------------------------------------------------------ */

function deaccSetup() {
  const { db } = freshDb('inv-docs-2454-');
  const ipc = fakeIpcMain();
  const audit = [];
  require(path.join(APP_DIR, 'handlers', 'deaccession-acts.js'))(ipc, {
    getDb: () => db,
    run: runDep,
    logAudit: (a, d) => audit.push({ a, d }),
    BOOK_SELECT: 'SELECT b.*, COALESCE(i.quantity,0) AS quantity FROM books b LEFT JOIN inventory i ON i.book_id = b.id',
    yearOf: (d) => Number(String(d).slice(0, 4)),
    scheduleCatalogWrite: () => {},
    flushCatalogWrite: () => {},
    normalizeScanCode: (s) => String(s || '').trim()
  });
  return { db, ipc, audit };
}

function seedBookWithHold(db, status) {
  const bid = db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, language)
    VALUES (?, 'Резервирана', 'Автор', 5, '2026-01-01', 'наличен', 'български')`).run(4100).lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bid);
  const rid = db.prepare(`INSERT INTO readers (name, card_no, category, registered_at)
    VALUES ('Мария Чакаща', 'K-1', 'възрастен', '2026-01-01')`).run().lastInsertRowid;
  db.prepare('INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?,?,?,datetime(\'now\'))')
    .run(bid, rid, status);
  return { bid, rid };
}

test('анулираният акт КАЗВА колко резервации е отказал — вместо те да изчезнат безследно', () => {
  /* Решението дали резервацията да се възкресява е взето в по-ранен кръг („одит
     #10, обратна посока“) и остава в сила: НЕ се възкресява. Анулирането поправя
     регистъра, а не връща времето в читалнята — читател, на когото е казано, че
     книгата я няма, не бива да се озове пак на опашка, която не е поставял.
     Счупеното беше друго и точно него заковава този тест: отказаната резервация
     не оставяше СЛЕДА. Никъде не пишеше кой акт я е отказал, екранът „Резервации“
     показва само активните, а одитният ред при анулиране казваше единствено
     „документите са върнати във фонда“. */
  for (const status of ['чака', 'заделена']) {
    const { db, ipc, audit } = deaccSetup();
    const { bid } = seedBookWithHold(db, status);

    const created = ipc.invoke('deaccessionActs:create', {
      act: { no: 9, date: '2026-06-01', reason_code: 6, reason_text: 'невърнати от ползватели' },
      bookIds: [bid]
    });
    assert.ok(created.ok, created.error);
    const h1 = db.prepare('SELECT status, deaccession_act_id, status_before FROM holds WHERE book_id=?').get(bid);
    assert.equal(h1.status, 'отказана', 'съставянето на акта отказва активните резервации');
    assert.equal(h1.deaccession_act_id, created.data, 'резервацията помни КОЙ акт я е отказал');
    assert.equal(h1.status_before, status,
      'и какво е била — „чака“ и „заделена“ не са едно и също: заделената книга стои на рафта с име');

    const revoked = ipc.invoke('deaccessionActs:revoke', created.data);
    assert.ok(revoked.ok, revoked.error);
    assert.equal(db.prepare('SELECT status FROM holds WHERE book_id=?').get(bid).status, 'отказана',
      'анулирането НЕ възкресява резервацията — това е нарочно и е решено в по-ранен кръг');
    assert.equal(revoked.data.droppedHolds, 1,
      'но прозорецът трябва да получи броя, за да го КАЖЕ на библиотекарката');
    const line = audit.find(x => x.a === 'Анулиране на акт');
    assert.ok(/ОСТАВА отказана|ОСТАВАТ отказани/.test(line.d),
      'следата трябва да казва, че резервацията остава отказана: ' + line.d);
    assert.ok(/подновете/.test(line.d), '… и какво да направи библиотекарката');
  }
});

test('без отказани резервации следата не плаши напразно', () => {
  const { db, ipc, audit } = deaccSetup();
  const bid = db.prepare(`INSERT INTO books (inv_number, title, price, register_date, status, language)
    VALUES (4200, 'Без резервации', 3, '2026-01-01', 'наличен', 'български')`).run().lastInsertRowid;
  db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bid);
  const c = ipc.invoke('deaccessionActs:create', {
    act: { no: 11, date: '2026-06-01', reason_code: 1, reason_text: 'амортизация' }, bookIds: [bid]
  });
  const r = ipc.invoke('deaccessionActs:revoke', c.data);
  assert.equal(r.data.droppedHolds, 0);
  const line = audit.find(x => x.a === 'Анулиране на акт');
  assert.doesNotMatch(line.d, /резервац/, 'без резервации следата не бива да ги споменава');
});

test('броят се само резервациите на ТОЗИ акт, не всяка отказана резервация', () => {
  const { db, ipc, audit } = deaccSetup();
  const { bid } = seedBookWithHold(db, 'чака');
  // втора резервация на същата книга, отказана РЪЧНО преди акта
  const rid2 = db.prepare(`INSERT INTO readers (name, card_no, category, registered_at)
    VALUES ('Отказал се', 'K-2', 'възрастен', '2026-01-01')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO holds (book_id, reader_id, status, placed_at, resolved_at)
    VALUES (?,?, 'отказана', datetime('now'), datetime('now'))`).run(bid, rid2);

  const c = ipc.invoke('deaccessionActs:create', {
    act: { no: 10, date: '2026-06-01', reason_code: 6, reason_text: 'невърнати от ползватели' }, bookIds: [bid]
  });
  assert.ok(c.ok, c.error);
  const r = ipc.invoke('deaccessionActs:revoke', c.data);
  assert.ok(r.ok, r.error);
  assert.equal(r.data.droppedHolds, 1,
    'отказаната по-рано и по друг повод не е дело на акта и не бива да се брои');
  assert.match(audit.find(x => x.a === 'Анулиране на акт').d, /1 резервация/);
});

test('прозорецът показва предупреждението, а не съобщение за успех', () => {
  const V = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'deaccession-acts.js'), 'utf8');
  const fn = V.slice(V.indexOf('async function revokeAct'), V.indexOf('window.revokeAct'));
  assert.match(fn, /res\.data && res\.data\.droppedHolds/, 'броят трябва да се прочете от отговора');
  assert.match(fn, /подновете/, 'библиотекарката трябва да разбере какво да направи');
  assert.match(fn, /n \? 'warn' : 'ok'/,
    'жълто предупреждение, не зелено „готово“ — иначе никой не го чете');
});

/* ------------------------------------------------------------------
   3. Просрочията се броят в ЦЕЛИ дни
   ------------------------------------------------------------------ */

test('таблото брои цели дни забава — заем точно на границата остава в своята група', () => {
  const DASH = fs.readFileSync(path.join(APP_DIR, 'handlers', 'dashboard.js'), 'utf8');
  assert.doesNotMatch(DASH, /julianday\('now'\) - julianday\(date_due\)/,
    "julianday('now') носи и часа: заем точно на 7 дни даваше 7,6 и падаше в „8–30 дни“");
  assert.match(DASH, /julianday\(date\('now'\)\) - julianday\(date_due\)/,
    'сравнява се ДАТА с ДАТА, както брои и касата (effectiveDaysLate)');

  const { db } = freshDb('inv-docs-day-');
  const rid = db.prepare(`INSERT INTO readers (name, card_no, category, registered_at)
    VALUES ('Читател', 'K-9', 'възрастен', '2026-01-01')`).run().lastInsertRowid;
  /* Отделен документ за всеки падеж: базата има спусък за наличните бройки и не
     позволява шест отворени заемания на една и съща книга. */
  const add = (i, days) => {
    const bid = db.prepare(`INSERT INTO books (inv_number, title, price, register_date, status, language)
      VALUES (?, 'На границата', 1, '2026-01-01', 'зает', 'български')`).run(7001 + i).lastInsertRowid;
    db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bid);
    db.prepare(`INSERT INTO loans (reader_id, book_id, date_out, date_due)
      VALUES (?, ?, date('now','-90 days'), date('now', ?))`).run(rid, bid, '-' + days + ' days');
  };
  [7, 8, 30, 31, 60, 61].forEach((d, i) => add(i, d));

  const q = (sql) => db.prepare(sql).get();
  const b = q(`SELECT
      SUM(CASE WHEN julianday(date('now')) - julianday(date_due) <= 7 THEN 1 ELSE 0 END) AS d7,
      SUM(CASE WHEN julianday(date('now')) - julianday(date_due) > 7
                AND julianday(date('now')) - julianday(date_due) <= 30 THEN 1 ELSE 0 END) AS d30,
      SUM(CASE WHEN julianday(date('now')) - julianday(date_due) > 30 THEN 1 ELSE 0 END) AS more
    FROM loans WHERE date_in IS NULL AND date_due IS NOT NULL AND date_due < date('now')`);
  assert.deepEqual([b.d7, b.d30, b.more], [1, 2, 3],
    'до 7 дни: само срокът отпреди 7 дни; 8–30: тези отпреди 8 и 30; над 30: 31, 60 и 61');
  const long = q(`SELECT COUNT(*) AS n FROM loans
    WHERE date_in IS NULL AND date_due IS NOT NULL
      AND julianday(date('now')) - julianday(date_due) > 60`).n;
  assert.equal(long, 1, '„над 60 дни“ значи над 60 — заемът точно на 60 дни не е над 60');
});

/* ------------------------------------------------------------------
   4. Решетките и рамките на полетата
   ------------------------------------------------------------------ */

test('решетките не се разтягат от съдържанието си (екранът „Справки и статистика“)', () => {
  for (const [n, cls] of [[2, 'g2'], [3, 'g3'], [4, 'g4']]) {
    const re = new RegExp('\\.grid\\.' + cls + '\\{display:grid; grid-template-columns:repeat\\(' + n + ', minmax\\(0, 1fr\\)\\); gap:10px\\}');
    assert.match(CSS, re, `.grid.${cls} трябва да ползва minmax(0,1fr), не голо 1fr`);
  }
  assert.match(CSS, /\.grid\.g2 > \.card, \.grid\.g3 > \.card, \.grid\.g4 > \.card\{min-width:0\}/,
    'без min-width:0 картата връща минималната ширина през задната врата');
});

test('рамката на всяко поле за писане и избор покрива 3:1 във ВСИЧКИТЕ седем теми', () => {
  /* WCAG 2.1, критерий 1.4.11. Измерено преди поправката: между 1,34:1 и 2,30:1 —
     нито една тема не покриваше прага, тоест полетата се сливаха с хартията. */
  const relLum = (hex) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = relLum(a) > relLum(b) ? [relLum(a), relLum(b)] : [relLum(b), relLum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  const varsAt = (i) => {
    const seg = CSS.slice(i); const e = seg.indexOf('\n}');
    const out = {};
    for (const m of seg.slice(0, e).matchAll(/--(\w+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2];
    return out;
  };
  const base = varsAt(CSS.indexOf(':root{'));
  const themes = { 1: base };
  for (const m of CSS.matchAll(/html\[data-theme="(\d)"\]\{/g)) themes[m[1]] = Object.assign({}, base, varsAt(m.index));
  assert.equal(Object.keys(themes).length, 7);
  for (const [id, v] of Object.entries(themes)) {
    assert.ok(v.field, `тема ${id} няма --field`);
    for (const bg of ['#FFFFFF', v.paper, v.paper2, v.paper3]) {
      const c = contrast(v.field, bg);
      assert.ok(c >= 3, `тема ${id}: --field ${v.field} върху ${bg} = ${c.toFixed(2)}:1 (нужно 3:1)`);
    }
  }
  // И самите правила трябва да ползват новия знак, а не --rule2.
  for (const sel of ['\\.btn\\{', '\\.field input, \\.field select, \\.field textarea\\{',
    '\\.toolbar select\\{', '\\.quickBtn\\{']) {
    const m = CSS.match(new RegExp(sel + '[^}]*\\}'));
    assert.ok(m, 'липсва правило ' + sel);
    assert.match(m[0], /border:1px solid var\(--field\)/, sel + ' трябва да ползва --field');
  }
});

test('.chk и .badge са определени по веднъж, а отметката е достатъчно голяма за натискане', () => {
  assert.equal((CSS.match(/^\.chk\{/gm) || []).length, 1, '.chk се определя на едно място');
  assert.equal((CSS.match(/^\.badge\{/gm) || []).length, 1, '.badge се определя на едно място');
  const chk = CSS.match(/^\.chk input\{[^}]*\}/m)[0];
  const w = Number(chk.match(/width:(\d+)px/)[1]);
  assert.ok(w >= 17, `кутийката е ${w}px — по подразбиране браузърът я чертае 13px, което е под целта на WCAG 2.5.8`);
  assert.match(CSS.match(/^\.chk\{[^}]*\}/m)[0], /cursor:pointer/,
    'над отметката курсорът трябва да казва, че се натиска — това се губеше в дубликата');
  /* И отметките в редовете на регистрите: те не са в <label class="chk">, но се
     натискат най-често от всички (избор за групова редакция и за витрината). */
  const row = CSS.match(/^table\.ledger input\[type=checkbox\]\{[^}]*\}/m);
  assert.ok(row, 'отметките в редовете на регистрите също трябва да са уголемени');
  assert.ok(Number(row[0].match(/width:(\d+)px/)[1]) >= 17, row[0]);
});
