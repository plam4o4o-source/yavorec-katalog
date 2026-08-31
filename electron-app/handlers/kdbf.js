// КДБФ — книга за движение на фонда — извадено от main.js (Фаза 4, стъпка 16).
// Единствен обобщаващ справочен handler: чете acquisitions/deaccession_acts/books
// за дадена година, не пише нищо. Зависи само от getDb, run и yearOf (по стойност).
module.exports = function registerKdbfHandlers(ipcMain, deps) {
  const { getDb, run, yearOf } = deps;

  /* КДБФ брои БИБЛИОТЕЧНИ ДОКУМЕНТИ, не заглавия. Програмата изрично поддържа
     няколко екземпляра на едно заглавие — полето „Налични бройки“ в картона на
     книгата (inventory.quantity), заемането и резервациите го четат правилно, а
     наръчникът учи библиотекаря да го попълва. Дотук обаче всеки ред тук броеше
     ЗАГЛАВИЯ: 40 заглавия по 3 екземпляра даваха 40 вместо 120, а стойността на
     фонда беше занижена със същата пропорция.

     COALESCE(..., 1), а не 0: ред без запис в inventory (стара или внесена база)
     е поне един документ — така поправката може само да ДОБАВИ към числата,
     никога да не отнеме от тях спрямо досегашното поведение.
     `price` е цената на един екземпляр („Цена (лв.)“ в картона), затова
     стойността е price * бройки. */
  const QTY = "COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id = b.id), 1)";

  ipcMain.handle('kdbf:report', (e, year) =>
    run(() => {
      const db = getDb();
      const y = year || yearOf();
      const part1 = db.prepare(`
        SELECT a.*, (SELECT COALESCE(SUM(${QTY}),0) FROM books b WHERE b.acquisition_id=a.id) AS registered_count,
               (SELECT COALESCE(SUM(b.price * ${QTY}),0) FROM books b WHERE b.acquisition_id=a.id) AS registered_value,
               (SELECT MIN(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS inv_from,
               (SELECT MAX(inv_number) FROM books b WHERE b.acquisition_id=a.id) AS inv_to
        FROM acquisitions a WHERE a.year = ? ORDER BY a.no
      `).all(y);
      /* Бройките идват от СНИМКАТА в самия акт (deaccession_items.quantity), не
         живо от inventory: редът е документ по чл. 35, ал. 2 и отпечатаният КДБФ за
         минала година не бива да се променя, ако някой редактира „Налични бройки"
         или изтрие документа по-късно. NULL = акт отпреди тази версия → 1. */
      const part3 = db.prepare(`
        SELECT d.*, (SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) FROM deaccession_items i WHERE i.act_id=d.id) AS item_count,
               (SELECT COALESCE(SUM(i.price * COALESCE(i.quantity,1)),0) FROM deaccession_items i WHERE i.act_id=d.id) AS item_value
        FROM deaccession_acts d WHERE d.year = ? ORDER BY d.no
      `).all(y);
      const end = y + '-12-31';
      const stockAt = (d) => db.prepare(`
        SELECT COALESCE(SUM(${QTY}),0) AS n, COALESCE(SUM(b.price * ${QTY}),0) AS v FROM books b
        WHERE b.register_date <= ? AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)
      `).get(d, d);
      const stockEnd = stockAt(end);
      const acquiredYear = db.prepare(
        `SELECT COALESCE(SUM(${QTY}),0) AS n, COALESCE(SUM(b.price * ${QTY}),0) AS v FROM books b WHERE substr(b.register_date,1,4) = ?`
      ).get(y);
      const deaccYear = db.prepare(`
        SELECT COALESCE(SUM(COALESCE(i.quantity,1)),0) AS n,
               COALESCE(SUM(i.price * COALESCE(i.quantity,1)),0) AS v
        FROM deaccession_items i
        JOIN deaccession_acts d ON d.id = i.act_id WHERE d.year = ?
      `).get(y);
      /* ---- Съгласуване между Част № 1 и Част № 2 ----------------------------
         Двете части броят по РАЗЛИЧНИ ключа и това е по същество, не по грешка:
           Част № 1 подрежда ПАРТИДИТЕ по годината на самата партида (a.year);
           Част № 2 брои ДОКУМЕНТИТЕ по годината на вписване в инвентарната книга
             (substr(b.register_date,1,4)) — вписването е моментът, от който
             документът е част от фонда.
         Партида от 30.12.2025, чиито документи се инвентират на 05.01.2026, влиза
         в Част № 1 за 2025 със своите бройки, а в Част № 2 се появява като
         постъпление за 2026. Дотук двете страници на един и същ регистър се
         разминаваха мълчаливо и проверяващият нямаше как да ги съгласува.
         Разликата е точно (crossOut − crossIn):
           Σ(Част № 1 за y) = X + crossOut,  Част № 2 „постъпили през y" = X + crossIn,
         където X са документите, при които и партидата, и вписването са в y. */
      const crossOut = db.prepare(`
        SELECT COALESCE(SUM(${QTY}),0) AS n, COALESCE(SUM(b.price * ${QTY}),0) AS v
        FROM books b JOIN acquisitions a ON a.id = b.acquisition_id
        WHERE a.year = ? AND (b.register_date IS NULL OR substr(b.register_date,1,4) <> ?)
      `).get(y, y);
      const crossIn = db.prepare(`
        SELECT COALESCE(SUM(${QTY}),0) AS n, COALESCE(SUM(b.price * ${QTY}),0) AS v
        FROM books b LEFT JOIN acquisitions a ON a.id = b.acquisition_id
        WHERE substr(b.register_date,1,4) = ? AND (a.id IS NULL OR a.year <> ?)
      `).get(y, y);
      /* ---- Документи БЕЗ дата на вписване ----------------------------------
         stockAt() иска `b.register_date <= ?`, а NULL не е <= нищо: документ без
         дата на вписване (внесена или много стара база) е невидим и за
         наличността, и за постъпленията — фондът в Част № 2 излиза по-малък от
         действителния и никъде не се казва защо. Числото НЕ се променя мълчаливо:
         справката носи бройката, а изгледът я обявява заедно с указание какво да
         се поправи, за да влезе документът в регистъра. */
      const undated = db.prepare(`
        SELECT COALESCE(SUM(${QTY}),0) AS n, COALESCE(SUM(b.price * ${QTY}),0) AS v,
               COUNT(*) AS rows,
               -- От тях: колко изобщо не влизат и в НАЛИЧНОСТТА. Разликата е тънка,
               -- но е разликата между две различни числа в един и същ документ:
               -- NULL не изпълнява сравнението register_date <= край-на-годината и
               -- такъв ред изчезва от stockAt(); празният низ СЕ сравнява по азбучен
               -- ред, минава проверката и остава в наличността — но пак пропада от
               -- постъпленията, защото substr('',1,4) не е година.
               COALESCE(SUM(CASE WHEN b.register_date IS NULL THEN ${QTY} ELSE 0 END),0) AS missing_from_stock
        FROM books b
        WHERE (b.register_date IS NULL OR b.register_date = '')
          AND (b.deaccession_date IS NULL OR b.deaccession_date > ?)
      `).get(end);
      const part1Sum = part1.reduce((s, a) => ({
        n: s.n + (a.registered_count || 0), v: s.v + (a.registered_value || 0)
      }), { n: 0, v: 0 });
      return { part1, part3, stockEnd, acquiredYear, deaccYear, year: y, crossIn, crossOut, undated, part1Sum };
    })
  );
};
