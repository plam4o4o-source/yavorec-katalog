// Постъпления (партиди) — извадени от main.js в отделен модул (Фаза 4,
// стъпка 14 от разбиването на монолита на модули по домейн). Първи домейн
// зависим от BOOK_SELECT — споделената SQL заготовка на "Книги" (все още
// неизвадени от main.js). Подава се по стойност (низ), не getter — BOOK_SELECT
// е `const`, никога не се преприсвоява, за разлика от db/mainWindow.
// `yearOf` също по референция (const функция, дефинирана по-рано в main.js).
module.exports = function registerAcquisitionsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, BOOK_SELECT, yearOf } = deps;
  const { parseRegisterNo, isValidIsoDate } = require('../security-utils');

  ipcMain.handle('acquisitions:list', () =>
    run(() => getDb().prepare(`
      -- Бройки екземпляри, не заглавия: същото броене като в КДБФ Част № 1
      -- (handlers/kdbf.js) — иначе екранът „Постъпления" и отпечатаният КДБФ
      -- показват различни числа за една и съща партида.
      SELECT a.*, (SELECT COALESCE(SUM(COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = b.id), 1)),0) FROM books b WHERE b.acquisition_id = a.id) AS registered_count,
             (SELECT COALESCE(SUM(b.price * COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = b.id), 1)),0) FROM books b WHERE b.acquisition_id = a.id) AS registered_value
      FROM acquisitions a ORDER BY a.date DESC, a.no DESC
    `).all())
  );
  ipcMain.handle('acquisitions:get', (e, id) =>
    run(() => {
      const db = getDb();
      const acq = db.prepare('SELECT * FROM acquisitions WHERE id = ?').get(id);
      if (!acq) return null;
      /* `fund_qty` е ОТЧЕТНАТА бройка и нарочно е отделна от `quantity` на
         BOOK_SELECT. Двете правила са различни по същество и това е умишлено:
           quantity = COALESCE(i.quantity, 0) — НАЛИЧНОСТ за заемане; липсващ ред
             в inventory значи, че документът не може да бъде зает (виж тригера
             trg_loans_capacity), затова там нулата е вярна;
           fund_qty = COALESCE(i.quantity, 1) — БРОЙ ДОКУМЕНТИ във фонда; вписаният
             в инвентарната книга документ е поне един физически екземпляр дори
             при стара база без ред в inventory.
         Колоната „По вид" в КДБФ (Приложение № 1) брои документи, затова чете
         fund_qty — иначе би дала 0 за всяка книга от внесена база. */
      acq.items = db.prepare(`${BOOK_SELECT} WHERE b.acquisition_id = ? ORDER BY b.inv_number`).all(id);
      /* Отчетната бройка се долепя с ОТДЕЛНА заявка, а не чрез кърпене на низа
         BOOK_SELECT: той е споделена константа и всяка промяна в подредбата му
         би счупила такава замяна мълчаливо. */
      const fq = new Map(db.prepare(`
        SELECT b.id, COALESCE(i.quantity, 1) AS fund_qty
        FROM books b LEFT JOIN inventory i ON i.book_id = b.id
        WHERE b.acquisition_id = ?
      `).all(id).map(r => [r.id, r.fund_qty]));
      acq.items.forEach(it => { it.fund_qty = fq.has(it.id) ? fq.get(it.id) : 1; });
      return acq;
    })
  );
  /* ЕДНИ И СЪЩИ ПРАВИЛА ЗА ЗАВЕЖДАНЕ И ЗА ПОПРАВКА (v2.4.61).
     =====================================================================
     Дотук acquisitions:update проверяваше датата (isValidIsoDate) и адреса на
     дарителя, а acquisitions:create — НИТО ЕДНОТО. Тоест по-строгата проверка
     стоеше на по-рядко ползвания път: партидата се завежда веднъж, поправя се
     почти никога. Измерено върху прясна база:

       date 'abc'          → yearOf() е slice(0,4), тоест year = 'abc'. Партидата
                             не излиза в НИТО една година на КДБФ Част № 1 —
                             вписана е в официален регистър и я няма в него.
       date ''             → year = текущата, date остава празно: редът се показва
                             без дата, а „Дата“ е първият реквизит по чл. 14, ал. 2.
       date '2026-02-30'   → приемаше се дословно; ден, който не съществува.
       дарение без адрес   → актът по чл. 6 излиза с „Адрес: …………………“.
       total_count −3      → изваждаше се от ОБЩО на Част № 1.
       sum −10             → отрицателна обявена стойност на постъпление.

     Проверките са изнесени тук и се викат от ДВАТА обработчика, за да не могат
     да се разминат отново. */
  function assertAcqDate(a) {
    if (!isValidIsoDate(a.date)) {
      throw new Error('Датата на партидата „' + (a.date == null || a.date === '' ? '—' : a.date)
        + '“ липсва или не е валидна дата. Тя е първият реквизит по чл. 14, ал. 2 и решава в коя година '
        + 'партидата влиза в Книгата за движение на фонда, Част № 1 — без нея редът не съществува в нито '
        + 'една година на регистъра. Въведете деня, месеца и годината на вписването.');
    }
  }
  /* Адресът на дарителя е реквизит на акта за дарение по чл. 6, ал. 5.
     ИЗКЛЮЧЕНИЕТО е партидата БЕЗ първичен документ (чл. 3, ал. 2): там дарител
     в правния смисъл няма — документите са намерени при подреждане или оставени
     анонимно, заместващият документ е протоколът на комисията, не акт за
     дарение, и той не съдържа ред „Адрес на дарителя“. Изискването на адрес
     точно там би спряло единствения законен път за завеждане на такива
     документи, а библиотекарката би вписала измислен адрес, за да продължи. */
  function assertDonorAddress(a) {
    const withoutDoc = String(a.doc_type || '').indexOf('без документ') > -1;
    if (String(a.how || '') === 'дарение' && !withoutDoc && !String(a.donor_address || '').trim()) {
      throw new Error('При дарение адресът на дарителя е задължителен (чл. 6, ал. 5) — той е реквизит на акта '
        + 'за приемане на дарение, който се съставя в три екземпляра и единият отива при дарителя. '
        + 'Попълнете „Адрес на дарителя“. Ако дарителят е неизвестен (намерени при подреждане), изберете '
        + 'вид на документа „без документ — протокол на комисия“ — тогава се съставя протокол по чл. 3, ал. 2, '
        + 'а не акт за дарение.');
    }
  }
  /* Общият брой документи по първичния документ: цяло число, не по-малко от нула.
     Празно поле остава 0, както досега (партидата може да се заведе преди да е
     преброена). */
  function parseAcqCount(x) {
    if (x === undefined || x === null || String(x).trim() === '') return 0;
    const raw = String(x).trim();
    if (!/^\d{1,9}$/.test(raw)) {
      throw new Error('Общият брой документи „' + raw + '“ не е цяло число, по-голямо или равно на нула. '
        + 'Този брой е обявеното в първичния документ количество и влиза в реда ОБЩО на КДБФ Част № 1 — '
        + 'отрицателен или нечислов брой изважда документи от регистъра. Въведете броя с цифри.');
    }
    return Number(raw);
  }
  /* Обявената стойност: празно поле = NULL („документът не обявява стойност“ —
     виж коментара при вписването по-долу), иначе неотрицателно число, закръглено
     до стотинки. Запетаята като десетичен знак се приема — старите фактури и
     българската клавиатура я пишат така (същото правило като при цената на
     документа, handlers/books.js). */
  function parseAcqSum(x) {
    if (x === '' || x === null || x === undefined) return null;
    const raw = String(x).trim();
    if (raw === '') return null;
    const norm = raw.replace(/\s/g, '').replace(',', '.');
    if (!/^\+?\d+(\.\d+)?$/.test(norm) || !Number.isFinite(Number(norm))) {
      throw new Error('Обявената стойност „' + raw + '“ не е сума. Тя се пренася в КДБФ Част № 1 и в акта за '
        + 'дарение / протокола по чл. 3, ал. 2 — отрицателна или нечислова стойност намалява отчетената '
        + 'стойност на фонда. Въведете сумата с цифри (напр. 25,50) или оставете полето празно, ако '
        + 'документът не обявява стойност.');
    }
    return Math.round(Number(norm) * 100) / 100;
  }
  ipcMain.handle('acquisitions:nextNo', (e, year) =>
    run(() => {
      const y = year || yearOf();
      const row = getDb().prepare('SELECT MAX(no) AS m FROM acquisitions WHERE year = ?').get(y);
      return (row.m || 0) + 1;
    })
  );
  ipcMain.handle('acquisitions:create', (e, a) =>
    run(() => {
      const db = getDb();
      const no = parseRegisterNo(a.no, '№ на вписване');
      /* Проверките са ПРЕДИ транзакцията и са същите, които прави и поправката —
         виж assertAcqDate / assertDonorAddress / parseAcqCount / parseAcqSum
         по-горе за какво точно влизаше в регистъра без тях. */
      assertAcqDate(a);
      assertDonorAddress(a);
      const totalCount = parseAcqCount(a.total_count);
      const declaredSum = parseAcqSum(a.sum);
      const year = yearOf(a.date);
      /* Номерът се предлага с MAX(no)+1 при ОТВАРЯНЕ на формата, а schema.sql няма
         UNIQUE(year, no) и не може да го получи наготово (съществуващи бази може
         вече да имат дубликати — миграцията би счупила стартирането). При два
         компютъра към една мрежова база (изрично поддържан режим) и двамата
         получават № 5 и записват две партиди № 5/2026. Затова проверката се прави
         ОТНОВО при самия запис, в транзакция с .immediate(): правото на запис се
         взима ПРЕДИ проверката, така че между нея и INSERT-а никой друг не може да
         вмъкне същия номер. */
      const tx = db.transaction(() => {
        if (db.prepare('SELECT 1 FROM acquisitions WHERE year = ? AND no = ?').get(year, no)) {
          throw new Error('Партида № ' + no + '/' + year + ' вече съществува — най-вероятно е създадена от друго работно място '
            + 'към същата база. Затворете и отворете формата отново, за да получите следващия свободен номер.');
        }
        /* Празно поле → NULL („стойността не е обявена в първичния документ"), а
           не 0. Дотук и двете влизаха като 0 и разпечатката, която чете
           `a.sum || acqValue(...)`, печаташе изчисления сбор като обявена
           стойност — без да казва, че го прави. Изрична нула вече е възможна и
           се пази като нула. */
        const declared = declaredSum;
        const info = db.prepare(`
          INSERT INTO acquisitions (no, year, date, how, from_source, doc_type, doc_no, doc_date, total_count, sum, donor_address, note,
                                    committee1, committee2, committee3)
          VALUES (@no, @year, @date, @how, @from_source, @doc_type, @doc_no, @doc_date, @total_count, @sum, @donor_address, @note,
                  @committee1, @committee2, @committee3)
        `).run({
          no, year, date: a.date, how: a.how || null,
          from_source: a.from_source || null, doc_type: a.doc_type || null, doc_no: a.doc_no || null,
          doc_date: a.doc_date || null, total_count: totalCount,
          sum: declared, donor_address: a.donor_address || null, note: a.note || null,
          /* Снимка на комисията към завеждането — актът за дарение и протоколът по
             чл. 3, ал. 2 се подписват от НЕЯ. Живите Настройки не стават: при всеки
             утвърден акт за отчисляване handlers/deaccession-acts.js ги презаписва. */
          committee1: a.committee1 || null, committee2: a.committee2 || null, committee3: a.committee3 || null
        });
        /* Одит v2.4.24: следата четеше СУРОВИТЕ полета на формата, а в регистъра
           влизат нормализираните. „№ 007“ с „12бр“ броя се вписваше като партида
           № 7/2026 с 12 бр., а дневникът твърдеше „партида № 007 — 12бр бр.“ —
           номер, който Част № 1 на КДБФ не съдържа. */
        logAudit('Постъпление', 'партида № ' + no + '/' + year + ' — ' + totalCount
          + ' бр. от ' + (a.from_source || '—'));
        return info.lastInsertRowid;
      });
      return tx.immediate();
    })
  );
  /* ПОПРАВКА НА ВПИСАНА ПАРТИДА (v2.4.56).
     Дотук имаше само create и delete, а delete отказва, щом поне един документ е
     инвентиран в партидата. Тоест сгрешен номер на фактура, сгрешена дата на
     документа или сгрешен общ брой оставаха ЗАВИНАГИ в КДБФ Част № 1 и излизаха
     при всяка проверка — единственият „изход“ беше да се остави грешно.
     Поправката е позволена, но не е мълчалива: всяко променено поле влиза в
     одитната следа със старата и новата стойност, точно както при документите
     (виж diffFields в handlers/books.js). Номерът и годината НЕ се пипат оттук —
     те са мястото на реда в регистъра; за тях остава изтриване и ново вписване,
     докато няма инвентирани документи. */
  const ACQ_EDITABLE = ['date', 'how', 'from_source', 'doc_type', 'doc_no', 'doc_date',
    'total_count', 'sum', 'donor_address', 'note', 'committee1', 'committee2', 'committee3'];
  const ACQ_LABEL = {
    date: 'дата', how: 'начин', from_source: 'откъде', doc_type: 'вид документ',
    doc_no: 'номер на документа', doc_date: 'дата на документа', total_count: 'общ брой',
    sum: 'обявена стойност', donor_address: 'адрес на дарителя', note: 'забележка',
    committee1: 'комисия 1', committee2: 'комисия 2', committee3: 'комисия 3'
  };
  ipcMain.handle('acquisitions:update', (e, { id, acq }) =>
    run(() => {
      const db = getDb();
      const a = acq || {};
      /* Същите проверки като при завеждането — вече на едно място (v2.4.61). */
      assertAcqDate(a);
      assertDonorAddress(a);
      const totalCount = parseAcqCount(a.total_count);
      const declaredSum = parseAcqSum(a.sum);
      const tx = db.transaction(() => {
        const prev = db.prepare('SELECT * FROM acquisitions WHERE id = ?').get(id);
        if (!prev) throw new Error('Партидата не е намерена — вероятно е изтрита от друго работно място.');
        /* ПОПРАВКАТА НЕ МОЖЕ ДА ИЗНЕСЕ ПАРТИДАТА ИЗВЪН ГОДИНАТА Ѝ (v2.4.61).
           Колоната `year` се попълва ВЕДНЪЖ при завеждането (yearOf(date)) и
           нарочно не се редактира — тя е мястото на реда в регистъра, а номерът
           е пореден в рамките на годината. Поправката на датата обаче се
           записваше, каквато и да е: партида № 7/2025 получаваше дата 03.01.2026
           и оставаше в КДБФ Част № 1 за 2025 г. с дата от 2026 г. — ред, който
           проверяващият не може да съгласува с нищо. По-лошо: № 7/2026 може вече
           да съществува като съвсем друга партида (номерът се предлага с MAX+1 в
           рамките на годината), тоест на две партиди се пада един и същ номер за
           годината, в която едната „изглежда“, че е.
           Затова датата може да се поправя свободно ВЪТРЕ в годината на
           вписването (сгрешен ден или месец — обичайната поправка), а изнасянето
           в друга година се отказва с указание кой е верният път: докато по
           партидата няма инвентирани документи, тя се изтрива и се завежда
           наново в правилната година (със свой номер за нея). */
        const newYear = yearOf(a.date);
        if (String(newYear) !== String(prev.year)) {
          throw new Error('Партида № ' + prev.no + '/' + prev.year + ' не може да получи дата от ' + newYear + ' г. '
            + 'Годината на партидата е мястото ѝ в КДБФ Част № 1 и не се променя с поправка — номерът ѝ е пореден '
            + 'за ' + prev.year + ' г. и в ' + newYear + ' г. същият номер може вече да е зает от друга партида. '
            + 'Поправете датата в рамките на ' + prev.year + ' г.; ако партидата наистина е от ' + newYear + ' г., '
            + 'изтрийте я (възможно е, докато по нея няма инвентирани документи) и я заведете наново с номер за '
            + newYear + ' г.');
        }
        const declared = declaredSum;
        const next = {
          id,
          date: a.date, how: a.how || null, from_source: a.from_source || null,
          doc_type: a.doc_type || null, doc_no: a.doc_no || null, doc_date: a.doc_date || null,
          total_count: totalCount,
          sum: declared,
          donor_address: a.donor_address || null, note: a.note || null,
          committee1: a.committee1 || null, committee2: a.committee2 || null, committee3: a.committee3 || null
        };
        db.prepare(`UPDATE acquisitions SET date=@date, how=@how, from_source=@from_source,
          doc_type=@doc_type, doc_no=@doc_no, doc_date=@doc_date, total_count=@total_count,
          sum=@sum, donor_address=@donor_address, note=@note,
          committee1=@committee1, committee2=@committee2, committee3=@committee3 WHERE id=@id`).run(next);
        const changed = ACQ_EDITABLE
          .filter(k => String(prev[k] == null ? '' : prev[k]) !== String(next[k] == null ? '' : next[k]))
          .map(k => (ACQ_LABEL[k] || k) + ': „' + (prev[k] == null || prev[k] === '' ? '—' : prev[k])
            + '“ → „' + (next[k] == null || next[k] === '' ? '—' : next[k]) + '“');
        /* Следа се пише ВИНАГИ, дори когато нищо не се е променило: отварянето и
           записването на ред от официален регистър е събитие само по себе си. */
        logAudit('Поправена партида', 'партида № ' + prev.no + '/' + prev.year
          + (changed.length ? ' — ' + changed.join('; ') : ' — записана без промяна'));
        return changed.length;
      });
      return tx.immediate();
    })
  );
  /* Одит v2.4.24. Три неща в пет реда:
     • Партидата е вписване в Част № 1 на КДБФ — официален регистър. Това е
       единственият път, по който такъв ред изчезва, и дотук той не оставяше
       НИКАКВА следа, докато създаването, отчисляването и анулирането на акт
       оставят. Номерът се освобождава веднага (acquisitions:nextNo връща MAX+1),
       тоест втора, съвсем друга партида получава същия № — а акт за дарение
       № 3/2026 може вече да е подписан и предаден на дарителя.
     • Броенето и изтриването не бяха в транзакция: документ, инвентиран в
       партидата от другото работно място между двете, губи партидата си
       (books.acquisition_id → NULL при ON DELETE SET NULL) и изпада от Част № 1. */
  ipcMain.handle('acquisitions:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const tx = db.transaction(() => {
        const acq = db.prepare('SELECT no, year, from_source, total_count FROM acquisitions WHERE id = ?').get(id);
        if (!acq) throw new Error('Партидата не е намерена — вероятно вече е изтрита от друго работно място.');
        const cnt = db.prepare('SELECT COUNT(*) AS n FROM books WHERE acquisition_id = ?').get(id).n;
        if (cnt > 0) throw new Error('Партидата има инвентирани документи и не може да бъде изтрита.');
        db.prepare('DELETE FROM acquisitions WHERE id = ?').run(id);
        logAudit('Изтрита партида', 'партида № ' + acq.no + '/' + acq.year + ' — '
          + (acq.total_count || 0) + ' бр. от ' + (acq.from_source || '—')
          + '; номерът се освобождава и ще бъде предложен наново');
      });
      tx.immediate();
    })
  );
};
