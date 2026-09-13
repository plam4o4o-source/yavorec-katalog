// Предложения за покупка от читатели (Koha: suggestions) — извадени от
// main.js в отделен модул (Фаза 4, стъпка 19). Поток: заявено → одобрено →
// поръчано → получено/отказано. При „получено" може да се закачи към
// партида в Постъпления, за да остане следа откъде реално е дошла книгата.
/* ---------------- Съвпадение „предложение ↔ постъпил документ“ (v2.4.57) ----
   ЧИТАТЕЛЯТ, ПОИСКАЛ КНИГАТА, БЕШЕ ПОСЛЕДНИЯТ, КОЙТО НАУЧАВА.
   Дотук предложението и постъплението бяха два коловоза, които не се пресичаха
   никъде: читател предлага „Нова книга“, книгата постъпва със същото заглавие
   и се вписва в инвентарната книга, а suggestions:list продължава да показва
   „заявено“ — проверено емпирично, статусът не мърда и нищо не се случва.
   Затварянето на предложението зависеше от това библиотекарката да си спомни
   сама, седмици по-късно, че някой е искал точно тази книга.

   Защо това е грешно ЗА БИБЛИОТЕКАТА: предложението е единственият случай, в
   който за конкретен читател СЕ ЗНАЕ СИГУРНО, че иска конкретно заглавие —
   всичко останало е предположение. Книгата стои на рафта нова, а човекът, който
   я е поискал, не разбира; при следващото си идване пита пак за нея. Отделно
   разделът „Предложения“ се пълни с вечни „заявено“ и престава да отговаря на
   въпроса, за който съществува — „какво наистина искат хората“.

   Защо поправката е точно такава: съвпадението СЕ ПРЕДЛАГА, не се прилага.
   Програмата няма как да знае, че постъпилият „Под игото“ (издание 2019, меки
   корици) е същата книга, която читателят е имал предвид, а автоматичното
   „получено“ би заключило чуждо предложение и би пратило писмо за книга, която
   не е дошла. Затова тук се ТЪРСИ и се ВРЪЩА, а решението остава на човека —
   същият модел, по който програмата вече отказва да отчислява, изтрива и
   сплесква записи без изрично питане.

   Сравнението е нормализирано по двата начина, по които едно и също заглавие
   се въвежда различно в едно и също гише:
     • регистър и пунктуация — „Под игото“ / „под игото“ / „Под игото.“;
     • редът на имената — „Вазов, Иван“ (както го изисква картонът по чл. 16) и
       „Иван Вазов“ (както го казва читателят на гишето). Затова авторът се
       сравнява като МНОЖЕСТВО от думи, а не като низ, плюс по-хлабавото
       „фамилия + инициал“ за „Вазов, И.“.
   Празният автор от страна на предложението НЕ отменя съвпадението (читателят
   рядко знае автора), но се отбелязва с author_match:false, за да може
   прозорецът да предупреди, че съвпада само заглавието. */
const CLOSED_SUGGESTION_STATUSES = ['получено', 'отказано'];
/* Кавичките, точките и тиретата падат; регистърът се сгъва. toLowerCase() е
   достатъчен и за кирилица (за разлика от разни ASCII-only сравнения на други
   места в програмата). */
function normText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[„“”"'«»‘’]/g, ' ')
    .replace(/[.,;:!?()\[\]\/\\–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/* Първият автор от „Габе, Дора; Шишкова, М.“ — същото правило като basisOf()
   в handlers/author-mark.js и splitName() в handlers/catalog.js. */
function firstAuthor(s) { return String(s == null ? '' : s).split(';')[0]; }
/* Множеството думи на името, подредено — така „вазов иван“ излиза еднакво и за
   „Вазов, Иван“, и за „Иван Вазов“. */
function authorWords(s) {
  return normText(firstAuthor(s)).split(' ').filter(Boolean).sort();
}
/* „Фамилия + инициал“ — по-хлабавият ключ, който хваща „Вазов, И.“ срещу
   „Иван Вазов“. Фамилията е частта пред запетаята, а при липса на запетая —
   последната дума (пак както basisOf в handlers/author-mark.js). */
function surnameInitial(s) {
  const raw = firstAuthor(s);
  const c = raw.indexOf(',');
  let surname, rest;
  if (c > 0) {
    surname = normText(raw.slice(0, c));
    rest = normText(raw.slice(c + 1));
  } else {
    const w = normText(raw).split(' ').filter(Boolean);
    if (!w.length) return '';
    surname = w[w.length - 1];
    rest = w.slice(0, -1).join(' ');
  }
  if (!surname) return '';
  return surname + '|' + (rest ? rest.charAt(0) : '');
}
function authorsMatch(a, b) {
  const wa = authorWords(a), wb = authorWords(b);
  if (!wa.length || !wb.length) return false;
  if (wa.join(' ') === wb.join(' ')) return true;
  const sa = surnameInitial(a), sb = surnameInitial(b);
  return !!sa && sa === sb;
}
/* Връща отворените предложения, които отговарят на постъпилия документ.
   Отворени = всичко, което НЕ е „получено“ или „отказано“: отказаното е
   решение на библиотеката и не бива да се отваря наново от само себе си.
   Броят отворени предложения е от порядъка на десетки, затова сравнението е в
   JavaScript — нормализацията по-горе няма как да се напише като SQL условие,
   а индекс по нормализирано заглавие би бил трета схема за поддържане. */
function findOpenSuggestionsForBook(db, book) {
  const title = normText(book && book.title);
  if (!title) return [];
  const rows = db.prepare(`
    SELECT s.id, s.date, s.reader_id, s.reader_name, s.author, s.title, s.status,
           r.name AS reader_name_live
    FROM suggestions s LEFT JOIN readers r ON r.id = s.reader_id
    WHERE COALESCE(s.status, 'заявено') NOT IN (${CLOSED_SUGGESTION_STATUSES.map(() => '?').join(',')})
    ORDER BY s.date
  `).all(...CLOSED_SUGGESTION_STATUSES);
  const out = [];
  for (const s of rows) {
    if (normText(s.title) !== title) continue;
    const bothNamed = !!authorWords(s.author).length && !!authorWords(book && book.author).length;
    /* Различен автор при същото заглавие е РАЗЛИЧНА книга („Пътеписи“ от двама
       автори), а не пропуск в набирането — такова съвпадение не се предлага. */
    if (bothNamed && !authorsMatch(s.author, book.author)) continue;
    out.push({
      id: s.id, date: s.date, title: s.title, author: s.author || null,
      reader_id: s.reader_id, reader_name: s.reader_name_live || s.reader_name || null,
      status: s.status || 'заявено',
      author_match: bothNamed
    });
  }
  return out;
}

module.exports = function registerSuggestionsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  const SUGGESTION_STATUSES = ['заявено', 'одобрено', 'поръчано', 'получено', 'отказано'];

  /* Същото търсене и като отделен канал (v2.4.57): картонът на вече вписан
     документ също трябва да може да попита „някой искал ли е това“ — например
     когато партидата е инвентирана от другото работно място и прозорецът на
     постъплението не е виждал отговора на books:create. */
  ipcMain.handle('suggestions:matchBook', (e, book) =>
    run(() => findOpenSuggestionsForBook(getDb(), book || {}))
  );

  ipcMain.handle('suggestions:list', (e, status) =>
    run(() => {
      const db = getDb();
      const sql = `SELECT s.*, r.name AS reader_name_live, a.no AS acq_no, a.year AS acq_year
        FROM suggestions s LEFT JOIN readers r ON r.id = s.reader_id
        LEFT JOIN acquisitions a ON a.id = s.acquisition_id`;
      const rows = status ? db.prepare(sql + ' WHERE s.status = ? ORDER BY s.date DESC').all(status)
                           : db.prepare(sql + ' ORDER BY s.date DESC').all();
      rows.forEach(r => { if (r.reader_name_live) r.reader_name = r.reader_name_live; });
      return rows;
    })
  );
  ipcMain.handle('suggestions:create', (e, sug) =>
    run(() => {
      if (!(sug.title || '').trim()) throw new Error('Заглавието е задължително.');
      const info = getDb().prepare(`
        INSERT INTO suggestions (date, reader_id, reader_name, author, title, note, status)
        VALUES (?, ?, ?, ?, ?, ?, 'заявено')
      `).run(sug.date || today(), sug.reader_id || null, sug.reader_name || null, sug.author || null, sug.title.trim(), sug.note || null);
      logAudit('Предложение за покупка', sug.title);
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('suggestions:setStatus', (e, { id, status, acquisition_id }) =>
    run(() => {
      const db = getDb();
      if (!SUGGESTION_STATUSES.includes(status)) throw new Error('Непознато състояние.');
      const s = db.prepare('SELECT title FROM suggestions WHERE id = ?').get(id);
      if (!s) throw new Error('Предложението вече не съществува — вероятно е изтрито от друго работно място.');
      db.prepare('UPDATE suggestions SET status = ?, acquisition_id = ? WHERE id = ?')
        .run(status, status === 'получено' ? (acquisition_id || null) : null, id);
      logAudit('Предложение за покупка', s.title + ' → ' + status);
    })
  );
  ipcMain.handle('suggestions:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT title FROM suggestions WHERE id = ?').get(id);
      if (!s) throw new Error('Предложението не е намерено.');
      db.prepare('DELETE FROM suggestions WHERE id = ?').run(id);
      logAudit('Изтрито предложение за покупка', s.title || ('№ ' + id));
    })
  );
};
/* Ползва се и от handlers/books.js: новото постъпление пита още в момента на
   вписването дали някой не е чакал точно тази книга (виж дългата бележка най-
   горе). Изнесено като свойство на модула по вече установения тук модел —
   assertUniqueBarcode в handlers/books.js се споделя по същия начин. */
module.exports.findOpenSuggestionsForBook = findOpenSuggestionsForBook;
