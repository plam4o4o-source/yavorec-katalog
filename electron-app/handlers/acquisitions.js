// Постъпления (партиди) — извадени от main.js в отделен модул (Фаза 4,
// стъпка 14 от разбиването на монолита на модули по домейн). Първи домейн
// зависим от BOOK_SELECT — споделената SQL заготовка на "Книги" (все още
// неизвадени от main.js). Подава се по стойност (низ), не getter — BOOK_SELECT
// е `const`, никога не се преприсвоява, за разлика от db/mainWindow.
// `yearOf` също по референция (const функция, дефинирана по-рано в main.js).
module.exports = function registerAcquisitionsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, BOOK_SELECT, yearOf } = deps;
  const { parseRegisterNo } = require('../security-utils');

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
        const declared = (a.sum === '' || a.sum === null || a.sum === undefined) ? null : parseFloat(a.sum);
        const info = db.prepare(`
          INSERT INTO acquisitions (no, year, date, how, from_source, doc_type, doc_no, doc_date, total_count, sum, donor_address, note,
                                    committee1, committee2, committee3)
          VALUES (@no, @year, @date, @how, @from_source, @doc_type, @doc_no, @doc_date, @total_count, @sum, @donor_address, @note,
                  @committee1, @committee2, @committee3)
        `).run({
          no, year, date: a.date, how: a.how || null,
          from_source: a.from_source || null, doc_type: a.doc_type || null, doc_no: a.doc_no || null,
          doc_date: a.doc_date || null, total_count: parseInt(a.total_count, 10) || 0,
          sum: Number.isFinite(declared) ? declared : null, donor_address: a.donor_address || null, note: a.note || null,
          /* Снимка на комисията към завеждането — актът за дарение и протоколът по
             чл. 3, ал. 2 се подписват от НЕЯ. Живите Настройки не стават: при всеки
             утвърден акт за отчисляване handlers/deaccession-acts.js ги презаписва. */
          committee1: a.committee1 || null, committee2: a.committee2 || null, committee3: a.committee3 || null
        });
        /* Одит v2.4.24: следата четеше СУРОВИТЕ полета на формата, а в регистъра
           влизат нормализираните. „№ 007“ с „12бр“ броя се вписваше като партида
           № 7/2026 с 12 бр., а дневникът твърдеше „партида № 007 — 12бр бр.“ —
           номер, който Част № 1 на КДБФ не съдържа. */
        logAudit('Постъпление', 'партида № ' + no + '/' + year + ' — ' + (parseInt(a.total_count, 10) || 0)
          + ' бр. от ' + (a.from_source || '—'));
        return info.lastInsertRowid;
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
