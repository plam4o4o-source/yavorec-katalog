'use strict';
/* СЪГЛАСУВАНЕ НА ФОНДОВИТЕ ЧИСЛА (v2.4.57).
   =====================================================================
   Одитът намери дванайсет места, които показват число за фонда, с осем
   различни условия за броене — и нито едно място, което да сравнява две от тях
   и да каже на библиотекаря, когато се разминат. Разликите не са хипотетични,
   измерени са върху истински данни:

     • „Наличност към 01.01.Y“ в КДБФ Част № 2 се извежда като
       31.12 − постъпили + отчислени, а двете събираеми идват от НЕСЪВМЕСТИМИ
       източници: наличността се чете ЖИВО от books+inventory, а отчисленото —
       от СНИМКАТА в акта. Поправка на „Налични бройки“ на вече отчислен
       документ мени затворена, вече отпечатана година със задна дата. Измерено:
       31.12.2024 = 3, а 01.01.2025 = 5 — две разпечатки в една папка, които не
       се връзват, и нищо, което да го каже.

     • „Библиотечен фонд“ на таблото и „Библиотечен фонд“ в годишния отчет са
       два различни ключа (виж db/fund-sql.js). Три случая ги разминават:
       документ без дата на вписване, документ, отчислен без акт, и документ с
       бъдеща дата на вписване.

     • Документ с НЕРАЗПОЗНАВАЕМА дата на вписване изчезва от регистъра и не се
       брои дори от предупреждението за недатирани — вписването вече го отказва
       (handlers/books.js), но вече създадените редове трябва да се намерят.

   Проверките тук не „поправят“ нищо сами: те СРАВНЯВАТ и ОБЯСНЯВАТ. Числата в
   един официален регистър не се пипат автоматично — това е работа на човека,
   който подписва. Затова всяка находка носи: двете числа, разликата, точната
   причина на човешки език и какво да се направи.

   Пуска се при отваряне на „Проверка на данните“, показва се на таблото, когато
   има разминаване, и се вписва в одитната следа, когато проверката се прави. */
const F = require('../db/fund-sql');

module.exports = function registerFundCheckHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, yearOf } = deps;

  const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

  /* Фондът по ключа „регистър“ към дадена дата — същият, който ползват КДБФ
     Част № 2 и годишният отчет. */
  function stockAt(db, d) {
    return db.prepare(`SELECT COALESCE(SUM(${F.QTY_JOIN}),0) AS n,
      COALESCE(SUM(b.price * ${F.QTY_JOIN}),0) AS v ${F.FROM_BOOKS_INV}
      WHERE ${F.fundByDate('?')}`).get(d, d);
  }
  /* Фондът по ключа „налично днес“ — същият, който ползват таблото и
     инвентарната книга. */
  function stockNow(db) {
    return db.prepare(`SELECT COALESCE(SUM(${F.QTY_JOIN}),0) AS n,
      COALESCE(SUM(b.price * ${F.QTY_JOIN}),0) AS v ${F.FROM_BOOKS_INV}
      WHERE ${F.fundByStatus}`).get();
  }
  function acquiredIn(db, y) {
    return db.prepare(`SELECT COALESCE(SUM(${F.QTY_JOIN}),0) AS n,
      COALESCE(SUM(b.price * ${F.QTY_JOIN}),0) AS v ${F.FROM_BOOKS_INV}
      WHERE b.register_date BETWEEN ? AND ?`).get(y + '-01-01', y + '-12-31');
  }
  function deaccessionedIn(db, y) {
    return db.prepare(`SELECT COALESCE(SUM(${F.DEACC_QTY}),0) AS n,
      COALESCE(SUM(i.price * ${F.DEACC_QTY}),0) AS v
      FROM deaccession_items i JOIN deaccession_acts d ON d.id = i.act_id
      WHERE d.year = ? AND ${F.ACT_LIVE}`).get(String(y));
  }

  function runChecks(db, year) {
    const y = Number(year || yearOf());
    const out = [];
    const add = (o) => out.push(o);

    /* --- 1. Веригата между годините ------------------------------------
       Наличността към 31.12 на една година ТРЯБВА да е равна на наличността
       към 01.01 на следващата. Това е първото, което проверяващият сравнява,
       защото двете числа стоят на два съседни подписани листа. */
    const endPrev = stockAt(db, (y - 1) + '-12-31');
    const startY = endPrev;   // 01.01.Y е състоянието в края на 31.12.(Y-1) — същото число, не ново броене
    const endY = stockAt(db, y + '-12-31');
    const acquired = acquiredIn(db, y);
    const deaccessioned = deaccessionedIn(db, y);
    const derived = {
      n: endY.n - acquired.n + deaccessioned.n,
      v: money(endY.v - acquired.v + deaccessioned.v)
    };
    if (derived.n !== startY.n || Math.abs(derived.v - money(startY.v)) > 0.005) {
      add({
        key: 'chain',
        level: 'важно',
        title: 'Наличността към 01.01.' + y + ' не се връзва с 31.12.' + (y - 1),
        a: { label: 'изведена в Част № 2 (31.12 − постъпили + отчислени)', n: derived.n, v: derived.v },
        b: { label: 'пряко преброена към 31.12.' + (y - 1), n: endPrev.n, v: money(endPrev.v) },
        why: 'Двете числа идват от различни източници: наличността се брои ЖИВО от документите, '
          + 'а отчисленото — от СНИМКАТА в акта (чл. 35, ал. 2), която нарочно не се променя. '
          + 'Най-честата причина е поправка на „Налични бройки“ на документ, който вече е отчислен, '
          + 'или анулиран акт от минала година.',
        todo: 'Отпечатаната Част № 2 за ' + (y - 1) + ' г. остава вярна за деня, в който е подписана. '
          + 'Проверете дали наскоро сте поправяли бройки на отчислен документ.'
      });
    }

    /* --- 2. Двата ключа за „фонд“ -------------------------------------- */
    const byDate = endY;   // същото число като горе — фондът по регистъра към 31.12.Y
    const byStatus = stockNow(db);
    if (byDate.n !== byStatus.n) {
      const bad = db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(${F.QTY_JOIN}),0) AS n
        ${F.FROM_BOOKS_INV} WHERE ${F.BAD_DATE} AND ${F.fundByStatus}`).get();
      /* NOT (BAD_DATE) е задължително тук: SQLite сравнява текст побайтово, а
         кирилски низ като „НЕВАЛИДНА-99-99“ е ПО-ГОЛЯМ от всяка чисто цифрова
         дата (Н е след 0-9 в байтовете) — тоест без този филтър един-единствен
         документ с нечетима дата се брои ДВА пъти: веднъж в bad.n, веднъж тук
         в future.n, а обяснението за разлика от 1 документ сочи towards „2“. */
      const future = db.prepare(`SELECT COALESCE(SUM(${F.QTY_JOIN}),0) AS n
        ${F.FROM_BOOKS_INV} WHERE b.register_date > ? AND NOT (${F.BAD_DATE}) AND ${F.fundByStatus}`).get(y + '-12-31');
      const orphan = db.prepare(`SELECT COALESCE(SUM(${F.QTY_JOIN}),0) AS n
        ${F.FROM_BOOKS_INV} WHERE b.status = 'отчислен'
          AND b.deaccession_act_id IS NULL AND b.deaccession_date IS NULL`).get();
      const causes = [];
      if (bad.n) causes.push(bad.n + ' без разпознаваема дата на вписване');
      if (future.n) causes.push(future.n + ' с дата на вписване след 31.12.' + y);
      if (orphan.n) causes.push(orphan.n + ' отчислени без акт');
      add({
        key: 'keys',
        level: causes.length ? 'важно' : 'бележка',
        title: 'Таблото и годишният отчет броят различен фонд',
        a: { label: 'годишен отчет и КДБФ (по датите в регистъра)', n: byDate.n, v: money(byDate.v) },
        b: { label: 'табло и инвентарна книга (по състоянието днес)', n: byStatus.n, v: money(byStatus.v) },
        why: causes.length
          ? 'Разликата се обяснява изцяло с: ' + causes.join('; ') + '.'
          : 'Двата ключа отговарят на два различни въпроса — „какво пише в регистъра към 31.12“ '
            + 'и „какво стои на рафта днес“. Разлика се появява при документи, вписани след 31.12.' + y + '.',
        todo: bad.n
          ? 'Поправете датата на вписване на документите без разпознаваема дата — те не съществуват '
            + 'в Книгата за движение на фонда, макар да се броят на таблото.'
          : (orphan.n ? 'Съставете акт за отчислените без акт („Проверка на данните“).' : '')
      });
    }

    /* --- 3. Документи, които изобщо ги няма в регистъра ------------------ */
    const bad = db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(${F.QTY_JOIN}),0) AS n,
      COALESCE(SUM(b.price * ${F.QTY_JOIN}),0) AS v
      ${F.FROM_BOOKS_INV} WHERE ${F.BAD_DATE} AND ${F.fundByStatus}`).get();
    if (bad.rows) {
      add({
        key: 'baddate',
        level: 'тежко',
        title: bad.rows + (bad.rows === 1 ? ' документ е без' : ' документа са без') + ' валидна дата на вписване',
        a: { label: 'стойност, която липсва от регистъра', n: bad.n, v: money(bad.v) },
        why: 'Датата на вписване решава в коя година се брои постъплението (чл. 16, ал. 2). '
          + 'Без нея документът се брои на таблото и може да се заема, но НЕ СЪЩЕСТВУВА в Книгата '
          + 'за движение на фонда и в годишния отчет.',
        todo: 'Отворете всеки от тях в „Книги“ и въведете датата, на която е вписан в инвентарната книга.',
        list: db.prepare(`SELECT b.id, b.inv_number, b.title, b.register_date
          ${F.FROM_BOOKS_INV} WHERE ${F.BAD_DATE} AND ${F.fundByStatus}
          ORDER BY b.inv_number LIMIT 200`).all()
      });
    }

    /* --- 4. Част № 1 срещу Част № 2 ------------------------------------- */
    const noBatch = db.prepare(`SELECT COALESCE(SUM(${F.QTY_JOIN}),0) AS n
      ${F.FROM_BOOKS_INV} WHERE b.acquisition_id IS NULL
        AND b.register_date BETWEEN ? AND ?`).get(y + '-01-01', y + '-12-31');
    if (noBatch.n) {
      add({
        key: 'nobatch',
        level: 'бележка',
        title: noBatch.n + (noBatch.n === 1 ? ' документ е вписан' : ' документа са вписани') + ' без партида',
        why: 'Част № 1 регистрира ПАРТИДИТЕ на постъпване (чл. 14), а Част № 2 брои вписаните документи. '
          + 'Документ без партида влиза във втората и липсва в първата — двете части се разминават точно '
          + 'с тази бройка.',
        todo: 'Ако документите са постъпили с първичен документ, заведете партида и ги свържете с нея.'
      });
    }

    return { year: y, findings: out, ok: out.every(f => f.level === 'бележка') };
  }

  ipcMain.handle('fund:check', (e, year) => run(() => runChecks(getDb(), year)));
  /* Отделен канал за вписване в дневника: самата проверка се вика и при всяко
     отваряне на екрана и не бива да пълни следата с еднакви редове. */
  ipcMain.handle('fund:checkLogged', (e, year) =>
    run(() => {
      const r = runChecks(getDb(), year);
      const heavy = r.findings.filter(f => f.level !== 'бележка');
      logAudit('Съгласуване на фонда', 'проверка за ' + r.year + ' г. — '
        + (heavy.length ? heavy.map(f => f.title).join('; ') : 'числата се връзват'));
      return r;
    })
  );

  return { runChecks };
};
