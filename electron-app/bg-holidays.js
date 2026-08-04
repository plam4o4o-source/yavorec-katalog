// Официални празници на България — автоматично попълване на „Календар на
// библиотеката“ (calendar_closed). При всяко стартиране initDb() вика
// ensureHolidaysSeeded(): гарантира, че празниците за ТЕКУЩАТА и за
// СЛЕДВАЩАТА година са вписани. Следващата година се засява отрано нарочно —
// заемане през декември получава падеж през януари и nextWorkDay() трябва
// вече да знае, че 1 януари е затворен ден.
//
// Всяка година се засява точно ВЕДНЪЖ (списъкът на минатите години стои в
// settings.holidays_seeded) и с INSERT OR IGNORE: ако библиотекарят е изтрил
// празник (работят на този ден) или е записал своя причина за същата дата,
// решението му не се презаписва при следващо стартиране.
//
// Списъкът следва чл. 154, ал. 1 от Кодекса на труда, включително правилото
// на ал. 2 (в сила от 2017 г.): когато официален празник — освен
// Великденските дни — се падне в събота или неделя, първият следващ работен
// ден е неприсъствен. Затова декемврийската група (24–26) може да породи два
// компенсационни дни, точно както се случи през 2022 г. (27 и 28 декември).
//
// Датите се смятат ИЗЦЯЛО в UTC (Date.UTC/getUTC*) — виж правилото в
// docs/ARCHITECTURE.md, въведено след дефекта с падежите в v1.65.0: местна
// полунощ + toISOString() връща предишния ден източно от Гринуич.

const FIXED_HOLIDAYS = [
  ['01-01', 'Нова година'],
  ['03-03', 'Ден на Освобождението на България — национален празник'],
  ['05-01', 'Ден на труда и на международната работническа солидарност'],
  ['05-06', 'Гергьовден — Ден на храбростта и Българската армия'],
  ['05-24', 'Ден на светите братя Кирил и Методий, на българската азбука, просвета и култура'],
  ['09-06', 'Ден на Съединението'],
  ['09-22', 'Ден на независимостта на България'],
  ['12-24', 'Бъдни вечер'],
  ['12-25', 'Рождество Христово'],
  ['12-26', 'Рождество Христово — втори ден']
];

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const weekday = (ms) => new Date(ms).getUTCDay(); // 0 = неделя, 6 = събота

/* Православен Великден (този на Българската православна църква) — алгоритъмът
   на Меус за Юлианския календар, после +13 дни за превръщане в Григорианска
   дата. Поправката от 13 дни важи за 1900 – 2099 г., затова извън този
   диапазон се отказваме шумно, вместо да върнем грешна дата. Проверен срещу
   известните дати: 2024 → 5 май, 2025 → 20 април, 2026 → 12 април,
   2027 → 2 май, 2028 → 16 април. */
function orthodoxEaster(year) {
  if (year < 1900 || year > 2099) {
    throw new Error('Изчислението на Великден е валидно само за 1900 – 2099 г. (поправката от 13 дни).');
  }
  const a = year % 4, b = year % 7, c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);   // Юлианска дата…
  const day = ((d + e + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day) + 13 * DAY; // …превърната в Григорианска
}

/* Пълният списък неприсъствени дни за една година: фиксираните празници,
   четирите Великденски дни и компенсационните дни по чл. 154, ал. 2. */
function bulgarianHolidays(year) {
  const out = [];
  const taken = new Set();
  const add = (ms, reason) => { out.push({ date: iso(ms), reason }); taken.add(iso(ms)); };

  const easter = orthodoxEaster(year);
  add(easter - 2 * DAY, 'Велики петък');
  add(easter - DAY, 'Велика събота');
  add(easter, 'Великден');
  add(easter + DAY, 'Великден — втори ден');

  const fixed = FIXED_HOLIDAYS.map(([md, reason]) =>
    [Date.UTC(year, parseInt(md.slice(0, 2), 10) - 1, parseInt(md.slice(3), 10)), reason]);
  for (const [ms, reason] of fixed) if (!taken.has(iso(ms))) add(ms, reason);

  // Компенсационните дни, в реда на самите празници: така декемврийската
  // група се разгъва правилно (падне ли 24-и в събота, компенсацията му
  // прескача и неделята, и заетите 25-и/26-и, и евентуално вече дадени дни).
  for (const [ms, reason] of fixed) {
    const wd = weekday(ms);
    if (wd !== 0 && wd !== 6) continue;
    let t = ms + DAY;
    while (weekday(t) === 0 || weekday(t) === 6 || taken.has(iso(t))) t += DAY;
    add(t, 'Почивен ден за „' + reason + '“ (пада се в събота или неделя)');
  }

  return out.sort((x, y) => x.date < y.date ? -1 : 1);
}

/* Вписва празниците за една година; връща броя реално добавени редове.
   INSERT OR IGNORE — вече съществуващ ред за същата дата (ръчно въведен от
   библиотекаря) остава непокътнат. */
function seedYear(db, year) {
  const ins = db.prepare('INSERT OR IGNORE INTO calendar_closed (date, reason) VALUES (?, ?)');
  let added = 0;
  const tx = db.transaction(() => {
    for (const h of bulgarianHolidays(year)) added += ins.run(h.date, h.reason).changes;
  });
  tx();
  return added;
}

/* Извиква се при всяко стартиране. todayStr — 'YYYY-MM-DD' (подава се, не се
   чете тук, за да е функцията тестваема с фиксирана дата). */
function ensureHolidaysSeeded(db, todayStr) {
  const year = parseInt(String(todayStr).slice(0, 4), 10);
  const row = db.prepare('SELECT holidays_seeded FROM settings WHERE id = 1').get() || {};
  const done = new Set(String(row.holidays_seeded || '').split(',').filter(Boolean).map(Number));
  const seeded = [];
  const addedByYear = {};
  for (const y of [year, year + 1]) {
    if (done.has(y)) continue;
    addedByYear[y] = seedYear(db, y);
    done.add(y);
    seeded.push(y);
  }
  if (seeded.length) {
    db.prepare('UPDATE settings SET holidays_seeded = ? WHERE id = 1')
      .run([...done].sort().join(','));
  }
  return { seededYears: seeded, addedByYear };
}

module.exports = { orthodoxEaster, bulgarianHolidays, seedYear, ensureHolidaysSeeded, FIXED_HOLIDAYS };
