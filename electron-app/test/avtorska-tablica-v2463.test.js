'use strict';
/* v2.4.63 — ВГРАДЕНАТА ТАБЛИЦА ЗА АВТОРСКИ ЗНАК.
   =====================================================================
   Дотук програмата не носеше таблица: докато библиотекарката не посочи свой
   файл, копчето „Предложи“ до полето „Авторски знак“ нямаше откъде да предлага
   и сигнатурата (реквизит по чл. 16) се пишеше на ръка за всяка книга.

   Тук се заковава вграденото:
     1) самите данни — цялост на таблицата (букви, непрекъснати числа, формат);
     2) зареждането в ПРАЗНА база при стартиране, през истинския main.js;
     3) внесената таблица НЕ се презаписва при обновяване — знаците на такава
        библиотека са по нейното издание и подреждат нейния рафт;
     4) ръчното връщане към вградената (authorMark:loadBuiltin) — изричен избор;
     5) предложението наистина работи с вградените числа, по истинското правило;
     6) файлът е в списъка за пакетиране — иначе го няма в инсталатора и
        засяването пада само при потребителя, а тук всичко минава.
   Всеки тест е проверен и с връщане на поправката. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { APP_DIR, cleanupTmpDirs, freshDb, fakeIpcMain, runDep } = require('./helpers/audit-fixtures');
const { startMainApp } = require('./helpers/main-app.js');

test.after(cleanupTmpDirs);

const MOD = path.join(APP_DIR, 'handlers', 'author-mark');
const registerAuthorMark = require(MOD);
const { builtinRows, prefixLabel, keyOf, lookup } = require(MOD).pure;
const TABLE = require(path.join(APP_DIR, 'db', 'author-table.js'));

/* ------------------------------------------------------------------ 1 ---- */
test('вградените данни са цели: букви, непрекъснати числа, текстов формат', () => {
  assert.ok(TABLE.length > 2000, 'таблицата е подозрително къса: ' + TABLE.length);
  for (const row of TABLE) {
    assert.ok(Array.isArray(row) && row.length === 2, 'ред не е двойка: ' + JSON.stringify(row));
    assert.equal(typeof row[0], 'string');
    /* Числото е ТЕКСТ и остава текст — „05“ не е 5 и водещата нула е част от
       знака. Ако някой го запише като число в JS, JSON.stringify го връща без
       кавички и водещата нула изчезва безшумно. */
    assert.equal(typeof row[1], 'string', 'числото трябва да е текст: ' + JSON.stringify(row));
    assert.match(row[1], /^\d{1,3}$/, 'числото е само цифри: ' + JSON.stringify(row));
    assert.match(row[0], /^[А-Я]/, 'буквосъчетанието започва с главна кирилска буква: ' + JSON.stringify(row));
  }
  const rows = builtinRows();
  assert.equal(rows.length, TABLE.length, 'зареждането не бива да губи редове');

  const byLetter = new Map();
  for (const r of rows) {
    const L = r.prefix.charAt(0);
    if (!byLetter.has(L)) byLetter.set(L, []);
    byLetter.get(L).push(parseInt(r.mark, 10));
  }
  assert.ok(byLetter.size >= 28, 'очакват се поне 28 букви, намерени ' + byLetter.size);
  /* Числата във всяка буква вървят БЕЗ ПРОПУСКИ — точно това свойство подрежда
     книгите по азбучен ред на рафта и по него се познава здрава таблица.
     Изключението е буква Л: източникът изписва „Лес“ два пъти (48 и 49),
     първото срещане печели и 49 остава неизползвано. Оставено е както е —
     измислено буквосъчетание би подредило чужди книги на грешно място. */
  for (const [L, nums] of byLetter) {
    const uniq = [...new Set(nums)].sort((a, b) => a - b);
    assert.equal(uniq.length, nums.length, 'буква ' + L + ': едно число стои на два реда');
    const gaps = [];
    for (let n = uniq[0]; n <= uniq[uniq.length - 1]; n++) if (!uniq.includes(n)) gaps.push(n);
    assert.deepEqual(gaps, L === 'Л' ? [49] : [],
      'буква ' + L + ': пропуснати числа ' + gaps.join(','));
  }
  // Редовете за конкретен автор оцеляват през човекочетимия запис и обратно.
  const named = rows.filter(r => prefixLabel(r.prefix).includes(', '));
  assert.ok(named.length >= 5, 'редовете за конкретен автор са изгубени: ' + named.length);
  assert.ok(named.some(r => prefixLabel(r.prefix) === 'ВАЗОВ, И'), JSON.stringify(named.map(r => prefixLabel(r.prefix))));
});

/* ------------------------------------------------------------------ 2 ---- */
test('вградената таблица е в списъка за пакетиране — иначе я няма в инсталатора', () => {
  /* Пазачът съществува, защото провалът е НЕВИДИМ тук: db/ се изброява файл по
     файл в package.json, тестовете четат от работното копие и минават, а
     засяването пада чак при библиотекаря, на чиста инсталация. */
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];
  assert.ok(files.includes('db/author-table.js'),
    'db/author-table.js липсва от build.files: ' + JSON.stringify(files.filter(f => f.startsWith('db/'))));
});

/* ------------------------------------------------------------------ 3 ---- */
test('предложението работи с вградените числа по истинското правило', () => {
  const rows = builtinRows();
  const hit = (name) => {
    const r = lookup(rows, keyOf(name));
    return r ? prefixLabel(r.prefix) + '=' + r.mark : null;
  };
  /* Проверката е срещу самата таблица (виж db/author-table.js), а правилото е
     „най-голямото буквосъчетание, което не надминава фамилията“. */
  assert.equal(hit('Вазов'), 'ВАЗ=14');
  assert.equal(hit('Христов'), 'ХРИСТОВ=78');
  assert.equal(hit('Димитров'), 'ДИМИ=59', 'редът „ДИМИТРОВ, Г“ е за Георги Димитров и НЕ участва в търсенето');
  // Й се търси от буква И (в таблиците Й няма собствен раздел).
  assert.equal(hit('Йовков'), 'ИОВК=77');
});

/* ------------------------------------------------------------------ 4 ---- */
test('стартирането зарежда вградената таблица в празна база — през истинския main.js', async () => {
  const app = startMainApp();
  await app.ready();
  const db = new Database(path.join(app.userData, 'library.db'));
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM author_table').get().n;
    assert.equal(n, builtinRows().length, 'новата база трябва да тръгва с готова таблица');
    // И копчето „Предложи“ наистина предлага, без нищо да е внасяно.
    const s = await app.invoke('authorMark:suggest', { author: 'Вазов, Иван' });
    assert.equal(s.ok, true, s.error);
    assert.equal(s.data.ok, true, JSON.stringify(s.data));
    assert.equal(s.data.num, '14');
    assert.match(s.data.mark, /^В.?14$/, s.data.mark);
    const st = await app.invoke('authorMark:status');
    assert.equal(st.data.isBuiltin, true, 'екранът трябва да казва, че стои вградената таблица');
    assert.equal(st.data.builtinRows, builtinRows().length);
  } finally {
    db.close();
    app.stop();
  }
});

/* ------------------------------------------------------------------ 5 ---- */
test('„Зареди вградената“ презаписва — това е изричен избор на човека', () => {
  /* Само ръчният път. Че СТАРТИРАНЕТО не пипа внесена таблица се проверява през
     истинския main.js в test/avtorska-tablica-vnesena-v2463.test.js — отделен
     файл, защото едно зареждане на main.js на процес значи една база. */
  const { db } = freshDb('inv-avt-v2463-');
  const own = [{ prefix: 'ВАЗ', mark: '77' }, { prefix: 'АА', mark: '11' }];
  const ins = db.prepare('INSERT INTO author_table (prefix, mark) VALUES (?, ?)');
  own.forEach(r => ins.run(r.prefix, r.mark));

  const ipcMain = fakeIpcMain();
  const audit = [];
  registerAuthorMark(ipcMain, { getDb: () => db, run: runDep, logAudit: (a, d) => audit.push({ a, d }),
    dialog: {}, getMainWindow: () => ({}), fs, path, importers: require(path.join(APP_DIR, 'importers.js')) });
  const st = ipcMain.invoke('authorMark:status');
  assert.equal(st.data.isBuiltin, false, 'чужда таблица не бива да се представя за вградената');
  assert.equal(st.data.rows, own.length);

  const r = ipcMain.invoke('authorMark:loadBuiltin');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.rows, builtinRows().length);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM author_table').get().n, builtinRows().length);
  assert.equal(db.prepare("SELECT mark FROM author_table WHERE prefix = 'ВАЗ'").get().mark, '14',
    'след изричното зареждане стои вграденото число');
  assert.match(audit[audit.length - 1].d, /вградената таблица/);
  assert.equal(ipcMain.invoke('authorMark:status').data.isBuiltin, true);

  /* „Вградената ли е“ се решава по СЪДЪРЖАНИЕ, не по брой редове. Две издания
     на авторските таблици спокойно имат еднакъв брой редове и различни числа —
     ако екранът гледа само бройката, библиотека със свое издание вижда
     „Вградената таблица“ и копчето „Върни вградената“ изчезва точно когато ѝ е
     нужно. Тук е същият БРОЙ редове с едно различно число. */
  const one = db.prepare("SELECT prefix FROM author_table WHERE mark = '14' AND prefix = 'ВАЗ'").get();
  assert.ok(one, 'очакваше се вграденият ред ВАЗ');
  db.prepare("UPDATE author_table SET mark = '15' WHERE prefix = 'ВАЗ'").run();
  const st2 = ipcMain.invoke('authorMark:status').data;
  assert.equal(st2.rows, builtinRows().length, 'броят редове нарочно остава същият');
  assert.equal(st2.isBuiltin, false, 'една различна стойност значи ДРУГА таблица');
  db.close();
});
