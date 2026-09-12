// Периодика — извадени от main.js в отделен модул (Фаза 4, стъпка 26).
// Зависи само от getDb, run, logAudit, today. countOverduePeriodicals се връща
// обратно към main.js, за да го подаде на handlers/dashboard.js — виж коментара
// там (Koha: serials — prediction pattern, силно облекчен за мащаба на една
// читалищна библиотека: само следващата очаквана дата, без пълен календар от
// предвидени броеве и без рекламации).
const { isValidIsoDate } = require('../security-utils');

module.exports = function registerPeriodicalsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  /* Три зависимости, които main.js подава на този модул от v2.4.56 нататък.
     Домейнът дотук нямаше нужда от тях — беше затворен свят без нито един ред
     във фонда. Инвентирането на годишен комплект създава ИСТИНСКИ ред в `books`
     и оттам нататък има:
       • yearOf — за проверката „годината не е от бъдещето“;
       • checkRecordLimit — лимитът на записите от „Настройки“ → „Ограничения“;
         без него точно този път щеше да е единствената врата във фонда, която
         лимитът не пази;
       • scheduleCatalogWrite — новият документ е видим в публичния онлайн
         каталог и katalog.json трябва да се пренапише.
     Всяка от трите се взима от deps, ако е подадена, и иначе пада към
     равностоен местен заместител, за да работи модулът и самостоятелно (както
     в тестовете). Резервният вариант на checkRecordLimit повтаря правилото от
     handlers/books.js нарочно и с ясно съзнание: по-добре повторена проверка,
     отколкото заобиколен лимит. Правилното решение е main.js да подаде и трите
     — описано е в доклада, защото main.js се пипа от друг в момента. */
  const yearOf = deps.yearOf || ((d) => String(d || today()).slice(0, 4));
  const scheduleCatalogWrite = deps.scheduleCatalogWrite || (() => {});
  const checkRecordLimit = deps.checkRecordLimit || ((kind) => {
    if (kind !== 'books') return;
    const s = getDb().prepare('SELECT limit_books FROM settings WHERE id = 1').get() || {};
    const limit = parseInt(s.limit_books, 10) || 0;
    if (limit <= 0) return;
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM books').get().n;
    if (n >= limit) {
      throw new Error('Достигнат е зададеният лимит от ' + limit + ' документи във фонда. '
        + 'Увеличете или премахнете лимита в „Настройки“ → „Ограничения“, за да добавяте нови записи.');
    }
  });

  /* Одит v2.4.29: създаването нормализираше празните полета до NULL, а редакцията
     подаваше формата сурова — издание с периодичност „—“ (freq = NULL) не можеше
     да се редактира изобщо: селектът праща '', тригерът за номенклатурата го отказва
     („Непозната стойност за periodicals.freq“) дори при поправка само на заглавието.
     Един и същ вид запис по двата пътя. */
  function periodicalPayload(p) {
    const title = String(p.title || '').trim();
    if (!title) throw new Error('Заглавието на изданието е задължително.');
    const nz = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
    return { title, freq: nz(p.freq), publisher: nz(p.publisher), issn: nz(p.issn), department: nz(p.department), note: nz(p.note) };
  }

  // Периодичност → SQLite модификатор на date(), за да се пресметне следващият
  // очакван брой от датата на последния постъпил. Стойностите съвпадат с
  // PER_FREQ в src/views/core.js. „нередовно“ (и всяка непозната стойност,
  // напр. празно поле) умишлено остават без предвиждане — за издание с
  // непостоянна периодичност изчислена „закъснялост“ би била само шум.
  const FREQ_INTERVAL = {
    'седмично': { days: 7 },
    'двуседмично': { days: 14 },
    'месечно': { months: 1 },
    'тримесечно': { months: 3 },
    'полугодишно': { months: 6 },
    'годишно': { months: 12 }
  };

  /* Прибавя месеци към дата, като ПРИТИСКА резултата към последния ден на
     целевия месец. Иначе SQLite прелива: date('2026-01-31','+1 month') връща
     '2026-03-03', а не 28 февруари — за месечно списание с брой от 31-ви
     февруари просто изчезва от предвиждането и закъснението се отчита с три
     дни закъснение. Проверено в самия SQLite:
       31.01 + 1 месец  → 2026-03-03 (вярно: 2026-02-28)
       31.03 + 1 месец  → 2026-05-01 (вярно: 2026-04-30)
       29.02 + 1 година → 2025-03-01 (вярно: 2025-02-28)
     Затова се взема по-ранната от двете: „наивното“ събиране и последния ден
     на целевия месец. */
  function addMonths(db, dateStr, n) {
    // Датата се подава два пъти с обикновени „?“ — better-sqlite3 не приема
    // повторно ползван номериран параметър (?1) заедно с позиционно подаване.
    return db.prepare(`SELECT MIN(date(?, ?), date(?, 'start of month', ?, '-1 day')) AS d`)
      .get(dateStr, '+' + n + ' months', dateStr, '+' + (n + 1) + ' months').d;
  }

  // p = { freq, last_issue_date }. Връща следващата очаквана дата (или null,
  // ако freq не е предвидим или изданието още няма нито един вписан брой) и
  // броя дни закъснение (0, ако не е закъсняло или не е предвидимо). Датата
  // на „днес“ идва от инжектираното today() (никога date('now') пряко тук),
  // за да е резултатът тестваем с фиксирана дата — виж правилото в
  // docs/ARCHITECTURE.md.
  function periodicalPrediction(p) {
    const iv = FREQ_INTERVAL[p.freq];
    if (!iv || !p.last_issue_date) return { next_expected: null, issue_overdue_days: 0 };
    const db = getDb();
    const expected = iv.days
      ? db.prepare('SELECT date(?, ?) AS d').get(p.last_issue_date, '+' + iv.days + ' days').d
      : addMonths(db, p.last_issue_date, iv.months);
    // Повредена/непразна, но невалидна дата в базата → date() връща NULL; тогава
    // няма предвиждане, вместо да се смята закъснение спрямо нищо.
    if (!expected) return { next_expected: null, issue_overdue_days: 0 };
    const diff = db.prepare('SELECT CAST(julianday(?) - julianday(?) AS INTEGER) AS d').get(today(), expected).d;
    return { next_expected: expected, issue_overdue_days: Math.max(0, diff || 0) };
  }

  // Брой издания, за които е минал повече от очаквания интервал без нов
  // постъпил брой — за таблото ("За днес"). Само предвидимите (freq в
  // FREQ_INTERVAL) с поне един вписан брой участват.
  function countOverduePeriodicals() {
    const rows = getDb().prepare(`
      SELECT p.freq, (SELECT MAX(date) FROM periodical_issues i WHERE i.periodical_id = p.id) AS last_issue_date
      FROM periodicals p WHERE p.freq IS NOT NULL
    `).all();
    let n = 0;
    for (const p of rows) if (periodicalPrediction(p).issue_overdue_days > 0) n++;
    return n;
  }

  /* ---------------- Годишни комплекти (инвентиране на периодиката) ----------------
     Миграцията стои ТУК, а не в ensureColumns() на main.js, по вече установения в
     проекта образец (виж ensureLoanActColumn в handlers/deaccession-acts.js):
     модулът трябва да работи и зареден самостоятелно (тестове, бъдещо второ
     работно място), а `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT
     EXISTS` са идемпотентни по конструкция — база, която вече работи, не се пипа
     и нито един съществуващ ред не се променя.
     ВАЖНО за вече работещите бази: тази миграция НЕ инвентира нищо със задна дата.
     Изкушението е голямо („нека програмата навакса пропуснатото“), но резултатът
     би бил хиляди нови реда в `books` с днешна дата на вписване — тоест хиляди
     ФАЛШИВИ постъпления в КДБФ Част № 1 за текущата година и годишен отчет, който
     не отговаря на нито един първичен документ. Инвентирането е изрично действие
     на библиотекаря, за изрично избрана година, с изрична партида.
     Проверката се помни за връзката (както в deaccession-acts.js), за да не се
     плаща PRAGMA/DDL при всяко отваряне на кардекс. */
  let volumesTableChecked = null;
  function ensureVolumesTable(db) {
    if (volumesTableChecked === db) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS periodical_volumes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        periodical_id INTEGER NOT NULL REFERENCES periodicals(id) ON DELETE CASCADE,
        year          TEXT NOT NULL,
        book_id       INTEGER REFERENCES books(id) ON DELETE SET NULL,
        issue_count   INTEGER,
        issue_sum     REAL,
        created_at    TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_per_vol_year ON periodical_volumes(periodical_id, year);
      CREATE INDEX IF NOT EXISTS idx_per_vol_book ON periodical_volumes(book_id);
    `);
    volumesTableChecked = db;
  }

  /* Годините на едно издание, така както ги вижда библиотекарят в кардекса:
     всяка година, за която има поне един вписан брой, ПЛЮС всяка вече инвентирана
     година (втората половина не е излишна — броевете на стар комплект може по-късно
     да бъдат изтрити или изданието да е инвентирано за година, чиито броеве идват
     по-късно; годината не бива да изчезва от картона само защото кардексът е празен).
     `substr(i.date,1,4)` е същото четене на година, което ползва и handlers/kdbf.js
     върху register_date — един и същ речник за едни и същи данни.
     Редът с book_id IS NULL (изтрит картон — ON DELETE SET NULL) СЕ ВРЪЩА, но без
     инвентарен номер: за интерфейса той е „неинвентирана година“ и бутонът отново
     работи. Виж дългата бележка в db/schema.sql защо връзката е SET NULL. */
  function volumeRows(db, periodicalId) {
    ensureVolumesTable(db);
    return db.prepare(`
      SELECT y.year AS year,
             (SELECT COUNT(*) FROM periodical_issues i
               WHERE i.periodical_id = @pid AND substr(i.date, 1, 4) = y.year) AS issue_count,
             (SELECT COALESCE(SUM(i.price), 0) FROM periodical_issues i
               WHERE i.periodical_id = @pid AND substr(i.date, 1, 4) = y.year) AS issue_sum,
             v.id AS volume_id, v.book_id, v.issue_count AS registered_issue_count,
             b.inv_number, b.register_date, b.price AS volume_price, b.status,
             b.deaccession_date, a.no AS acq_no, a.year AS acq_year
      FROM (
        SELECT DISTINCT substr(i.date, 1, 4) AS year FROM periodical_issues i
          WHERE i.periodical_id = @pid AND i.date IS NOT NULL AND i.date <> ''
        UNION
        SELECT year FROM periodical_volumes WHERE periodical_id = @pid
      ) y
      LEFT JOIN periodical_volumes v ON v.periodical_id = @pid AND v.year = y.year
      LEFT JOIN books b ON b.id = v.book_id
      LEFT JOIN acquisitions a ON a.id = b.acquisition_id
      WHERE y.year IS NOT NULL AND y.year <> ''
      ORDER BY y.year DESC
    `).all({ pid: periodicalId });
  }

  ipcMain.handle('periodicals:list', () =>
    run(() => {
      const db = getDb();
      ensureVolumesTable(db);
      /* `volume_count` е новата колона „Инвентирани комплекти“ в списъка. Не е
         украса: тя е единственото място, където библиотекарят вижда с един поглед
         кои заглавия влизат в отчета за фонда и кои още не — а именно това
         разминаване се оказа системната грешка. Брои се само комплект с ЖИВ картон
         (b.id IS NOT NULL), защото ред с book_id IS NULL значи изтрит документ, а
         той не е във фонда и не бива да се показва като инвентиран. */
      const rows = db.prepare(`
        SELECT p.*, (SELECT COUNT(*) FROM periodical_issues i WHERE i.periodical_id = p.id) AS issue_count,
               (SELECT MAX(date) FROM periodical_issues i WHERE i.periodical_id = p.id) AS last_issue_date,
               (SELECT COUNT(*) FROM periodical_volumes v JOIN books b ON b.id = v.book_id
                 WHERE v.periodical_id = p.id) AS volume_count
        FROM periodicals p ORDER BY p.title
      `).all();
      for (const p of rows) Object.assign(p, periodicalPrediction(p));
      return rows;
    })
  );
  ipcMain.handle('periodicals:get', (e, id) =>
    run(() => {
      const db = getDb();
      const p = db.prepare('SELECT * FROM periodicals WHERE id = ?').get(id);
      if (!p) return null;
      p.issues = db.prepare('SELECT * FROM periodical_issues WHERE periodical_id = ? ORDER BY date DESC').all(id);
      /* Картонът на изданието вече носи и годишните комплекти. Това е ПОЛОВИНАТА
         от „вижда се и от двете страни“: в инвентарната книга комплектът е
         най-обикновен ред (той Е ред в `books`), а тук, в кардекса, до годината
         пише „инвентиран като инв. № N“. Дотук двата свята не знаеха един за друг
         и точно затова периодиката изпадаше от фонда, без никой да го забележи. */
      p.volumes = volumeRows(db, id);
      return p;
    })
  );
  ipcMain.handle('periodicals:create', (e, p) =>
    run(() => {
      const row = periodicalPayload(p);
      const info = getDb().prepare(`
        INSERT INTO periodicals (title, freq, publisher, issn, department, note)
        VALUES (@title, @freq, @publisher, @issn, @department, @note)
      `).run(row);
      logAudit('Ново периодично издание', row.title);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('periodicals:update', (e, p) =>
    run(() => {
      const row = periodicalPayload(p);
      const upd = getDb().prepare(`
        UPDATE periodicals SET title=@title, freq=@freq, publisher=@publisher, issn=@issn, department=@department, note=@note
        WHERE id=@id
      `).run({ ...row, id: p.id });
      if (!upd.changes) throw new Error('Изданието не е намерено — вероятно е изтрито от друго работно място.');
      logAudit('Редакция на периодично издание', row.title);
    })
  );
  ipcMain.handle('periodicals:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const cnt = db.prepare('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ?').get(id).n;
      if (cnt > 0) throw new Error('Изданието има вписани броеве и не може да бъде изтрито.');
      /* Второто дете на изданието — аналитичните описания (одит v2.4.24). Там
         връзката е ON DELETE SET NULL (db/schema.sql), а не CASCADE, тоест
         изтриването не се проваля: то тихо ЗАЛИЧАВА ИЗТОЧНИКА на всяка статия.
         Читалище, което описва статии от вестник, без да води самия вестник брой
         по брой, има празен кардекс — проверката по-горе минава — и след един клик
         всичките му краеведски описания печатат източник „—“, безвъзвратно.
         Изтриването се и вписва в следата: това е последният от трите пътя тук,
         който мълчеше, докато създаването и редакцията вписват. */
      const anl = db.prepare('SELECT COUNT(*) AS n FROM analytics WHERE periodical_id = ?').get(id).n;
      if (anl > 0) {
        throw new Error('Към изданието има ' + anl + (anl === 1 ? ' аналитично описание' : ' аналитични описания')
          + ' и то не може да бъде изтрито — източникът им ще изчезне. Първо пренасочете или изтрийте статиите.');
      }
      /* ТРЕТОТО дете на изданието (v2.4.56) — инвентираните годишни комплекти.
         `periodical_volumes.periodical_id` е ON DELETE CASCADE, тоест изтриването
         на изданието мълчаливо би отнесло ВРЪЗКАТА, но НЕ и самите документи:
         редовете в `books` остават във фонда, в инвентарната книга и в КДБФ — с
         инвентарен номер, който вече не сочи наникъде. Картонът на инв. № 4312
         продължава да гласи „Труд, 2024“, но програмата вече не знае от кое
         издание е, кардексът го няма и никой не може да проследи откъде е дошъл.
         Затова изтриването се отказва по същия образец като горните две проверки:
         документът във фонда се маха с АКТ за отчисляване (чл. 35), не с изтриване
         на кардекса. */
      ensureVolumesTable(db);
      const vols = db.prepare(`SELECT b.inv_number AS inv, v.year FROM periodical_volumes v
        JOIN books b ON b.id = v.book_id WHERE v.periodical_id = ? ORDER BY v.year`).all(id);
      if (vols.length) {
        throw new Error('Изданието има ' + vols.length + (vols.length === 1 ? ' инвентиран годишен комплект' : ' инвентирани годишни комплекта')
          + ' във фонда (инв. № ' + vols.map(v => (v.inv == null ? '—' : v.inv) + ' за ' + v.year + ' г.').join(', ')
          + ') и не може да бъде изтрито. Тези документи са вписани в инвентарната книга и в КДБФ — от фонда се '
          + 'махат само с акт за отчисляване (чл. 35), не с изтриване на картотеката.');
      }
      const p0 = db.prepare('SELECT title, issn, freq FROM periodicals WHERE id = ?').get(id);
      if (!p0) throw new Error('Изданието не е намерено.');
      db.transaction(() => {
        db.prepare('DELETE FROM periodicals WHERE id = ?').run(id);
        // Краеведските връзки към изданието (v2.4.29) — иначе „Персоналии“/„Летопис“
        // показват „(изтрит запис)“ и броят мъртви връзки.
        db.prepare("DELETE FROM links WHERE (from_kind = 'периодика' AND from_id = ?) OR (to_kind = 'периодика' AND to_id = ?)").run(id, id);
      })();
      /* Следата назовава изданието така, както се разпознава в документите —
         със ISSN и периодичност, а не само със заглавие. „Изтрито периодично
         издание — Труд“ не стига, когато в картотеката е имало и „Труд“ (в-к), и
         „Труд и право“ (сп.): след изтриването не остава нищо, по което да се
         познае кое от двете е изчезнало и какво да се възстанови от копието. */
      logAudit('Изтрито периодично издание', '„' + p0.title + '“'
        + (p0.issn ? ', ISSN ' + p0.issn : '') + (p0.freq ? ', ' + p0.freq : '')
        + ' — без вписани броеве и без инвентирани годишни комплекти');
    })
  );
  ipcMain.handle('periodicalIssues:add', (e, issue) =>
    run(() => {
      /* Одит v2.4.29: без проверки „2026-02-30“ влизаше както е — а прогнозата за
         следващия брой взима MAX(date), date() на невалидна дата е NULL и
         предупреждението „закъснял брой“ угасваше мълчаливо за това издание;
         празен № на брой и цена „abc“ (NaN → NULL) също минаваха. */
      const db = getDb();
      const issueNo = String(issue.issue_no || '').trim();
      if (!issueNo) throw new Error('Номерът на броя е задължителен.');
      const date = issue.date || today();
      if (!isValidIsoDate(date)) throw new Error('Датата на броя (' + issue.date + ') е невалидна.');
      const price = issue.price == null || String(issue.price).trim() === '' ? 0 : Number(String(issue.price).replace(',', '.'));
      if (!Number.isFinite(price) || price < 0) throw new Error('Цената на броя трябва да е число (€).');
      const per = db.prepare('SELECT title FROM periodicals WHERE id = ?').get(issue.periodical_id);
      if (!per) throw new Error('Изданието не е намерено.');
      const info = db.prepare(`
        INSERT INTO periodical_issues (periodical_id, issue_no, date, price, note)
        VALUES (@periodical_id, @issue_no, @date, @price, @note)
      `).run({ periodical_id: issue.periodical_id, issue_no: issueNo, date, price, note: issue.note || null });
      logAudit('Постъпил брой', per.title + ' — бр. ' + issueNo);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('periodicalIssues:delete', (e, id) =>
    run(() => {
      const db = getDb();
      ensureVolumesTable(db);
      const row = db.prepare(`SELECT i.issue_no, i.date, i.price, i.periodical_id, p.title FROM periodical_issues i
        LEFT JOIN periodicals p ON p.id = i.periodical_id WHERE i.id = ?`).get(id);
      if (!row) throw new Error('Броят вече не съществува — вероятно е изтрит от друго работно място.');
      /* Годината на броя се чете ПРЕДИ триенето и влиза в следата отделно от
         датата. Дотук следата пишеше само „бр. 5 от 2025-03-14“ — при проверка
         въпросът обаче е ЗА КОЯ ГОДИШНИНА липсва брой, защото по година се
         подвързва комплектът и по година се отчита фондът; а след триенето реда го
         няма и годината не може да се извади отникъде. */
      const year = row.date ? String(row.date).slice(0, 4) : null;
      /* И най-важното: ако годината вече е ИНВЕНТИРАНА, този брой е физическа част
         от подвързан библиотечен документ с инвентарен номер. Триенето му не се
         отказва — сгрешено вписване трябва да може да се поправи, — но следата
         казва точно кой документ от фонда вече не отговаря на кардекса си, за да
         има какво да се обясни при проверка. Без това изречение разминаването
         между инвентарната книга и картотеката би останало неоткриваемо. */
      const vol = year ? db.prepare(`SELECT b.inv_number AS inv FROM periodical_volumes v
        JOIN books b ON b.id = v.book_id WHERE v.periodical_id = ? AND v.year = ?`).get(row.periodical_id, year) : null;
      db.prepare('DELETE FROM periodical_issues WHERE id = ?').run(id);
      logAudit('Изтрит брой', '„' + (row.title || '—') + '“ — бр. ' + row.issue_no
        + ' от ' + (row.date || '—') + (year ? ' (' + year + ' г.)' : '')
        + ', цена ' + (Number(row.price) || 0).toFixed(2) + ' €'
        + (vol ? '; ВНИМАНИЕ: годината вече е инвентирана като инв. № ' + (vol.inv == null ? '—' : vol.inv)
          + ' — кардексът вече не отговаря на подвързания комплект' : ''));
    })
  );

  /* ============================================================================
     ИНВЕНТИРАНЕ НА ГОДИШЕН КОМПЛЕКТ (v2.4.56)
     ============================================================================
     ДОТУК периодиката беше изцяло извън фонда: нито инвентарен номер, нито
     партида, нито ред в `inventory`. КДБФ Част № 1 се печаташе със заглавие
     „Регистриране на постъпили книги, периодични издания и други материали“ и
     нито едно периодично издание в него; Дневникът, Раздел Б, имаше ред
     „Периодични издания“, който винаги беше нула. А Наредба № 3 (чл. 13, ал. 3,
     т. 1; чл. 14; чл. 16) брои периодичните издания за библиотечни документи и
     изисква същата регистрация като за книгите. Тоест постъпленията и стойността
     на фонда бяха системно занижени — не веднъж, а всяка година.

     ЗАЩО ЕДИН НОМЕР ЗА ЦЯЛАТА ГОДИНА, а не по номер на всеки брой: така се води
     периодиката в библиотечната практика — броевете за една година се подвързват
     и се инвентират като ЕДИН библиотечен документ. Така го брои и статистиката.
     Обратното (52 инвентарни номера за един годишен абонамент за седмичник) би
     надуло фонда и би направило инвентаризацията невъзможна: 52 „екземпляра“,
     които физически са една подвързана книга на рафта.

     ЗАЩО Е ИЗРИЧНО ДЕЙСТВИЕ, а не автоматика: инвентирането е вписване в
     инвентарната книга и в КДБФ — официални регистри. Програмата няма право да
     вписва в тях сама, нито да „навакса“ пропуснатите години със задна дата.
     Библиотекарят избира годината, партидата, цената и датата на вписване, точно
     както при книга.

     ЗАЩО СЪЗДАВА РЕД В `books`, а не отделен вид регистрация: защото „библиотечен
     документ“ е едно понятие и в програмата има едно място — `books` + `inventory`.
     Оттам го четат ВСИЧКИ: инвентарната книга (handlers/inv-book.js), КДБФ
     (handlers/kdbf.js — Част № 1 през `acquisition_id`, Приложение № 2 през
     `categories.name`), статистиката, справките, отчисляването с акт. Тоест
     комплектът влиза във фонда веднага и навсякъде, без нито един от тези
     модули да се пипа. Видът е „продължаващо издание“ — наличната категория,
     която и handlers/dnevnik.js вече преобразува в ред „Периодични издания“
     (b_type_period) на Раздел Б.

     ПОВТОРНО ИНВЕНТИРАНЕ на същата година се отказва — веднъж на две места:
     тук, с обяснение кое е правилното действие, и в самата база с
     UNIQUE(periodical_id, year), която държи и когато две работни места пишат
     едновременно в обща мрежова база. */
  ipcMain.handle('periodicalVolumes:register', (e, v0) =>
    run(() => {
      const db = getDb();
      ensureVolumesTable(db);
      const v = v0 || {};
      /* Транзакцията е .immediate() по същата причина като в books:splitCopies и
         acquisitions:create: инвентарният номер се взима от settings.next_inv_number,
         а правото на запис трябва да се вземе ПРЕДИ четенето му — иначе двете
         работни места към една мрежова база получават един и същ номер и вторият
         запис пада върху UNIQUE(books.inv_number) СЛЕД като е създал партида. */
      const out = db.transaction(() => {
        const p = db.prepare('SELECT * FROM periodicals WHERE id = ?').get(v.periodical_id);
        if (!p) throw new Error('Изданието не е намерено — вероятно е изтрито от друго работно място.');

        // --- Година ---
        const year = String(v.year == null ? '' : v.year).trim();
        if (!/^\d{4}$/.test(year)) throw new Error('Годината на комплекта трябва да е четирицифрена (напр. 2025).');
        /* Горната граница е „следващата календарна година“, а не текущата: абонамент
           за идната година се плаща и получава през декември и комплектът му
           законно се завежда тогава. По-нагоре от това е печатна грешка (2205),
           която иначе би влязла в инвентарната книга завинаги. */
        const maxYear = parseInt(yearOf(), 10) + 1;
        if (parseInt(year, 10) < 1800 || parseInt(year, 10) > maxYear) {
          throw new Error('Годината ' + year + ' не изглежда вярна — допустимо е от 1800 до ' + maxYear + ' г.');
        }

        // --- Повторно инвентиране ---
        const prev = db.prepare(`SELECT v.id, v.book_id, b.inv_number, b.register_date
          FROM periodical_volumes v LEFT JOIN books b ON b.id = v.book_id
          WHERE v.periodical_id = ? AND v.year = ?`).get(p.id, year);
        if (prev && prev.book_id != null) {
          throw new Error('Годишният комплект на „' + p.title + '“ за ' + year + ' г. вече е инвентиран като инв. № '
            + (prev.inv_number == null ? '—' : prev.inv_number)
            + (prev.register_date ? ' (вписан на ' + prev.register_date + ')' : '')
            + '. Един комплект се вписва в инвентарната книга веднъж. Ако описанието или цената са сгрешени, '
            + 'поправете картона на документа във „Фонд“; ако комплектът е излязъл от фонда, отчислете го с акт.');
        }

        // --- Цена ---
        const agg = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS s
          FROM periodical_issues WHERE periodical_id = ? AND substr(date, 1, 4) = ?`).get(p.id, year);
        /* Празно поле → сборът от цените на вписаните броеве. Това е обичайният
           случай и е и най-верният: стойността на комплекта Е сборът на платените
           броеве. Ръчната стойност остава възможна, защото фактурата за абонамент
           често обявява една обща сума (с отстъпка или с пощенски разходи), а в
           КДБФ влиза сумата ПО ДОКУМЕНТА, не пресметнатата от нас. Изрична нула се
           пази като нула — дарен комплект е законен случай (чл. 6). */
        const raw = v.price == null || String(v.price).trim() === '' ? agg.s : String(v.price).replace(',', '.');
        const price = Number(raw);
        if (!Number.isFinite(price) || price < 0) throw new Error('Цената на годишния комплект трябва да е число (€).');

        // --- Дата на вписване ---
        const registerDate = v.register_date || today();
        if (!isValidIsoDate(registerDate)) throw new Error('Датата на вписване (' + v.register_date + ') е невалидна.');

        // --- Партида в КДБФ Част № 1 ---
        /* Абонаментът е постъпление и се вписва в партида точно както книгите
           (чл. 14). Партидата може да е съществуваща или новосъздадена — новата се
           създава през СЪЩИЯ канал acquisitions:create, който ползва и екранът
           „Постъпления“ (виж src/views/periodicals.js), за да няма втора, различна
           бройна логика за номерата на партидите. Тук се приема само готово id и
           се проверява, че съществува: подадена, но несъществуваща партида би
           влязла като NULL заради ON DELETE SET NULL и документът тихо би изпаднал
           от Част № 1 — точно грешката, която поправяме. */
        let acquisitionId = null;
        if (v.acquisition_id != null && String(v.acquisition_id).trim() !== '') {
          acquisitionId = parseInt(v.acquisition_id, 10);
          if (!Number.isFinite(acquisitionId)) throw new Error('Номерът на партидата е невалиден.');
          const acq = db.prepare('SELECT id FROM acquisitions WHERE id = ?').get(acquisitionId);
          if (!acq) throw new Error('Избраната партида не съществува — вероятно е изтрита от друго работно място.');
        }

        // --- Вид документ ---
        /* „продължаващо издание“ е една от началните категории в db/schema.sql и
           единствената, която Наредба № 3 и Дневникът (Раздел Б) отреждат на
           периодиката. Създава се наново, ако библиотекарят я е изтрил от
           „Категории“ — иначе инвентирането би паднало с „no such row“ на място,
           където библиотекарят няма как да се досети какво е станало. */
        const KIND = 'продължаващо издание';
        let cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(KIND);
        if (!cat) {
          db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(KIND);
          cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(KIND);
        }

        // --- Инвентарен номер ---
        /* От СЪЩАТА поредица като книгите (settings.next_inv_number) — инвентарната
           книга е една и номерацията ѝ е непрекъсната (чл. 16, ал. 2). Отделна
           поредица за периодиката би дала два документа с един и същ номер.
           Зает номер се прескача (същата защита като в books:splitCopies): стара
           внесена база може да има номера над next_inv_number. */
        const taken = db.prepare('SELECT 1 FROM books WHERE inv_number = ?');
        let invNumber;
        if (v.inv_number != null && String(v.inv_number).trim() !== '') {
          invNumber = parseInt(v.inv_number, 10);
          if (!Number.isFinite(invNumber) || invNumber <= 0) throw new Error('Инвентарният номер трябва да е цяло положително число.');
          if (taken.get(invNumber)) throw new Error('Инв. № ' + invNumber + ' вече е зает от друг документ.');
        } else {
          const s = db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get() || {};
          invNumber = parseInt(s.next_inv_number, 10) || 1;
          while (taken.get(invNumber)) invNumber++;
        }

        checkRecordLimit('books');

        /* Заглавието е „<издание>, <година>“ — така го изписва и инвентарната
           книга, и така го търси библиотекарят („Труд, 2024“). `volume` носи
           „годишен комплект“, за да се вижда в колона „Том“, че редът не е една
           книга; `series`/`series_no` връзват комплекта към поредицата, от която
           е част, за да се подреждат годините една до друга в списъка на фонда.
           ISSN не се записва: `books` няма колона за него (описано е в доклада). */
        const title = p.title + ', ' + year;
        const info = db.prepare(`
          INSERT INTO books (inv_number, register_date, title, author, category_id, year, volume,
                             publisher, series, series_no, department, status, status_date,
                             price, description, acquisition_id)
          VALUES (@inv_number, @register_date, @title, NULL, @category_id, @year, 'годишен комплект',
                  @publisher, @series, @series_no, @department, 'наличен', @status_date,
                  @price, @description, @acquisition_id)
        `).run({
          inv_number: invNumber, register_date: registerDate, title,
          category_id: cat ? cat.id : null, year,
          publisher: p.publisher || null, series: p.title, series_no: year + ' г.',
          department: p.department || 'периодика', status_date: today(),
          price, acquisition_id: acquisitionId,
          description: String(v.note || '').trim() || null
        });
        const bookId = info.lastInsertRowid;
        // ЕДИН ИНВЕНТАРЕН НОМЕР = ЕДИН ЕКЗЕМПЛЯР — същото правило като при книгите
        // (виж normalizeQuantity в handlers/books.js). Подвързаният комплект е един том.
        db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(bookId);
        if (invNumber >= (parseInt((db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get() || {}).next_inv_number, 10) || 1)) {
          db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(invNumber + 1);
        }

        /* Връзката. Ред със същата година вече може да съществува с book_id IS NULL
           (картонът е бил изтрит) — тогава се ОБНОВЯВА, а не се вмъква нов: иначе
           UNIQUE(periodical_id, year) би отказал записа и годината би останала
           заключена завинаги заради една поправена грешка. */
        if (prev) {
          db.prepare('UPDATE periodical_volumes SET book_id = ?, issue_count = ?, issue_sum = ? WHERE id = ?')
            .run(bookId, agg.n, agg.s, prev.id);
        } else {
          db.prepare('INSERT INTO periodical_volumes (periodical_id, year, book_id, issue_count, issue_sum) VALUES (?, ?, ?, ?, ?)')
            .run(p.id, year, bookId, agg.n, agg.s);
        }

        const acqRow = acquisitionId
          ? db.prepare('SELECT no, year FROM acquisitions WHERE id = ?').get(acquisitionId) : null;
        logAudit('Инвентиран годишен комплект',
          'инв. № ' + invNumber + ' — „' + title + '“ (' + agg.n + ' бр. в кардекса), '
          + price.toFixed(2) + ' €, вписан на ' + registerDate
          + (acqRow ? ', партида № ' + acqRow.no + '/' + acqRow.year : ', без партида'));
        return { book_id: bookId, inv_number: invNumber, year, title, price, issue_count: agg.n };
      }).immediate();
      // Новият документ е част от фонда и се вижда в публичния онлайн каталог.
      scheduleCatalogWrite();
      return out;
    })
  );

  return { countOverduePeriodicals };
};
