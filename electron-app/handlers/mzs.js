// МЗС (междубиблиотечно заемане) — извадени от main.js в отделен модул
// (Фаза 4, стъпка 27). Зависи от getDb, run, logAudit, yearOf; от v2.4.69 и
// (незадължително) от scheduleCatalogWrite — вж. „МЗС Е СВЪРЗАНО С ФОНДА И
// ГИШЕТО“ по-долу.
const { localDate } = require('../local-date');
const { parseRegisterNo, isValidIsoDate, normalizeScanCode, resolveScannedBook, authorTitleText } = require('../security-utils');

const bgDate = (d) => (d ? String(d).split('-').reverse().join('.') : '—');

/* ==========================================================================
   МЗС Е СВЪРЗАНО С ФОНДА И ГИШЕТО (v2.4.69, кръг 44, К6 и К8)
   ==========================================================================
   (а) КАКВО СТАВАШЕ ДОТУК. МЗС беше само регистър със свободен текст:
       • получена чужда книга не можеше да се даде на читател, без да се впише
         във фонда — а тогава влизаше в инвентарната книга, КДБФ и онлайн
         каталога, без да е наша;
       • наша книга, изпратена по входяща заявка, оставаше „налична“ онлайн и
         гишето я заемаше (тестер № 5: „Заемане: инв. № 1 до 26.10.2026“ за
         книга, която физически е в Габрово);
       • нямаше дати на изпращане, получаване и връщане; състоянието можеше да
         скочи от „заявено“ направо на „върнато“; срокът на получена чужда книга
         не се следеше никъде (тестер № 5: срок, изтекъл преди 10 дни, не се
         вижда нито на таблото, нито в „Просрочени“, нито в регистъра);
       • номерът се предлагаше по ТЕКУЩАТА година и не се пресмяташе при смяна
         на датата (заявка от 20 декември миналата година получи № 3/2025).
   (б) ЗАЩО Е ГРЕШНО. Чуждата книга е задължение към друга библиотека, а
       нашата, изпратена навън — част от фонда, която физически я няма. И двете
       трябва да се виждат там, където библиотекарката решава: на гишето, в
       онлайн каталога и в срока. Регистър без дати не може да отговори на
       въпроса „откога е при тях“, а прескочено състояние оставя книга
       „върната“, без никой да я е получил.
   (в) ЗАЩО ТОЧНО ТАКА.
       • Изходяща заявка може да се свърже с НАШ ЧИТАТЕЛ (reader_id, по номера
         на картата). Получената книга се дава на читателя по самата заявка —
         „получено“ + читател значи „у читателя“; във фонда не се вписва нищо.
         Срокът за връщане е задължителен при „получено“ — по него се следи
         просрочието (mzs:overdue и регистърът).
       • Входяща заявка се свързва с НАШ ДОКУМЕНТ (book_id, по инв. № или
         баркод). Докато е „изпратено“ или „получено“ (при партньора), той не се
         заема на гишето (mzsBlockForBook — изнесена по-долу за handlers/loans.js)
         и излиза „зает“ онлайн (buildCatalogPayload в main.js).
       • Състоянията вървят само напред по реда заявено → изпратено → получено →
         върнато; „отказано“ — от първите две. Една стъпка назад е позволена като
         ПОПРАВКА на погрешно натиснато състояние (датата на отменената стъпка се
         изчиства и в следата пише „поправка“). Всичко друго се отказва с
         обяснение какво може оттук.
       • Датата на всяко състояние се попълва сама (днес), ако не е подадена.
       • Номерът се пресмята по годината на ДАТАТА на заявката: празен № при
         запис → следващият свободен за тази година, в същата транзакция. */
const MZS_FLOW = {
  'заявено': ['изпратено', 'отказано'],
  'изпратено': ['получено', 'отказано'],
  'получено': ['върнато'],
  'върнато': [],
  'отказано': []
};
const MZS_DATE_COL = { 'изпратено': 'date_sent', 'получено': 'date_received', 'върнато': 'date_returned' };
/* Входяща заявка: нашият документ е при партньора в тези състояния. */
const MZS_AWAY = ['изпратено', 'получено'];

/* Една стъпка назад — поправка на погрешно натиснато състояние. От „отказано“
   се връща там, откъдето е отказано (ако е имало изпращане — „изпратено“). */
function mzsBackStep(cur) {
  const status = cur.status;
  if (status === 'изпратено') return 'заявено';
  if (status === 'получено') return 'изпратено';
  if (status === 'върнато') return 'получено';
  if (status === 'отказано') return cur.date_sent ? 'изпратено' : 'заявено';
  return null;
}
/* Защо преходът не става — за обяснението при отказ. */
function mzsWhyNot(from, to) {
  if (from === 'върнато' || from === 'отказано') return 'заявката е приключена като „' + from + '“';
  if (to === 'получено') return 'документът не може да бъде получен, преди да е изпратен';
  if (to === 'върнато') return from === 'заявено'
    ? 'документът не може да бъде върнат, преди да е изпратен и получен'
    : 'документът не може да бъде върнат, преди да е получен';
  if (to === 'отказано') return 'отказ се отбелязва само докато документът не е получен';
  if (to === 'изпратено') return 'заявката вече е минала това състояние';
  return 'това състояние не следва от „' + from + '“';
}

/* ---------------- Гишето: наш документ, изпратен по МЗС ----------------
   Връща ОПИСАНИЕ (български текст за отказа на гишето) или null.
   Вика се от handlers/loans.js при заемане, преди записа — в същата транзакция:
     const why = mzsBlockForBook(db, bookId); if (why) throw new Error(why);
   Брои бройки, не „има/няма“: стар неразделен запис с 3 бройки, една от които
   е при партньора, все пак има свободни. Отворените заемания се броят, защото
   ако свободните бройки са 0 и без МЗС, отказът е работа на гишето, не на МЗС. */
const MZS_AWAY_SQL = `SELECT no, year, partner, date_sent, due_date FROM mzs_requests
      WHERE book_id = ? AND direction = 'входящо' AND status IN ('изпратено', 'получено')
      ORDER BY id`;
/* Колко НАШИ бройки на записа са при партньора по входяща заявка. Едно място за
   гишето (mzsBlockForBook) и за резервациите (freeCopies в handlers/holds.js) —
   иначе заемането отказва „изпратен по МЗС“, а резервацията отказва „свободен е,
   заемете го“, и читателят не може нито едното (преглед на кръга v2.4.69). */
function mzsAwayCount(db, bookId) {
  return db.prepare(MZS_AWAY_SQL).all(bookId).length;
}
function mzsBlockForBook(db, bookId) {
  const away = db.prepare(MZS_AWAY_SQL).all(bookId);
  if (!away.length) return null;
  const qty = db.prepare('SELECT COALESCE((SELECT quantity FROM inventory WHERE book_id = ?), 1) AS q').get(bookId).q;
  const open = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(bookId).n;
  if (Number(qty) - open - away.length > 0) return null;
  const r = away[away.length - 1];
  return 'Документът е изпратен по междубиблиотечно заемане на ' + r.partner + ' (заявка № ' + r.no + '/' + r.year
    + (r.date_sent ? ', изпратен на ' + bgDate(r.date_sent) : '')
    + (r.due_date ? ', срок за връщане ' + bgDate(r.due_date) : '')
    + ') и физически не е в библиотеката. Когато се върне, отбележете заявката „върнато“ в „МЗС“ — '
    + 'тогава документът отново може да се заема.';
}

/* ---------------- Просрочени по МЗС (К6) ----------------
   Изходяща заявка в „получено“ — чуждата книга е при нас (или у нашия читател) и
   трябва да се върне до срока; входяща в „изпратено“/„получено“ — нашият
   документ е при партньора. Просрочена е, когато срокът е ПРЕДИ `on`. */
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
function mzsOverdueRows(db, on) {
  return db.prepare(`
    SELECT m.id, m.no, m.year, m.direction, m.partner, m.author, m.title, m.status, m.due_date,
           m.date_sent, m.date_received, m.reader_id, m.book_id,
           r.name AS reader_name, r.card_no AS reader_card, r.phone AS reader_phone,
           b.inv_number AS book_inv
    FROM mzs_requests m
    LEFT JOIN readers r ON r.id = m.reader_id
    LEFT JOIN books b ON b.id = m.book_id
    WHERE m.due_date IS NOT NULL AND m.due_date <> '' AND m.due_date < ?
      AND ((m.direction = 'изходящо' AND m.status = 'получено')
        OR (m.direction = 'входящо' AND m.status IN ('изпратено', 'получено')))
    ORDER BY m.due_date, m.year, m.no`).all(on).map(r => {
    const days = daysBetween(r.due_date, on);
    const doc = '„' + authorTitleText(r.author, r.title) + '“';
    const ref = 'МЗС № ' + r.no + '/' + r.year;
    const late = 'срокът за връщане изтече на ' + bgDate(r.due_date) + ' (' + (days === 1 ? 'преди 1 ден' : 'преди ' + days + ' дни') + ')';
    const text = r.direction === 'изходящо'
      ? 'Чужда книга ' + doc + ' от ' + r.partner + ' (' + ref + ') — ' + late + '. '
        + (r.reader_name
          ? 'У читателя ' + r.reader_name + (r.reader_card ? ' (карта ' + r.reader_card + ')' : '')
            + (r.reader_phone ? ', тел. ' + r.reader_phone : '') + ' — поискайте я обратно и я върнете на партньора.'
          : 'Върнете я на партньора или поискайте продължение на срока.')
      : 'Наш документ' + (r.book_inv != null ? ' инв. № ' + r.book_inv : '') + ' ' + doc + ' е при ' + r.partner
        + ' (' + ref + ') — ' + late + '. Поискайте го обратно.';
    return Object.assign(r, { days_over: days, text });
  });
}

module.exports = function registerMzsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, yearOf } = deps;
  /* Незадължителна: main.js трябва да я подаде (виж доклада на кръг 44), за да
     стига до онлайн каталога смяната „изпратено“/„върнато“ на наш документ.
     Без нея каталогът се обновява при следващата промяна във фонда. */
  const scheduleCatalogWrite = typeof deps.scheduleCatalogWrite === 'function' ? deps.scheduleCatalogWrite : null;

  const LIST_SELECT = `
    SELECT m.*, r.name AS reader_name, r.card_no AS reader_card,
           b.inv_number AS book_inv, b.title AS book_title
    FROM mzs_requests m
    LEFT JOIN readers r ON r.id = m.reader_id
    LEFT JOIN books b ON b.id = m.book_id`;
  ipcMain.handle('mzs:list', () => run(() => getDb().prepare(`${LIST_SELECT} ORDER BY m.date DESC, m.no DESC`).all()));
  ipcMain.handle('mzs:nextNo', (e, year) =>
    run(() => {
      const y = year || yearOf();
      const row = getDb().prepare('SELECT MAX(no) AS m FROM mzs_requests WHERE year = ?').get(y);
      return (row.m || 0) + 1;
    })
  );
  /* Просрочените по МЗС за таблото и регистъра (К6).
     Канал: `mzs:overdue`, аргумент по желание `{ on: 'YYYY-MM-DD' }` (по
     подразбиране днес по часовника на компютъра). Връща масив, подреден по
     срок, с полета { id, no, year, direction, partner, author, title, status,
     due_date, days_over, date_sent, date_received, reader_id, reader_name,
     reader_card, reader_phone, book_id, book_inv, text } — `text` е готовото
     изречение за екрана. */
  ipcMain.handle('mzs:overdue', (e, arg) =>
    run(() => {
      const on = arg && isValidIsoDate(arg.on) ? arg.on : localDate();
      return mzsOverdueRows(getDb(), on);
    })
  );
  /* Одит v2.4.29: заявка без дата минаваше (year се вземаше от днес, разпечатката
     показваше „Дата на вписване:  г.“), а после нямаше как да се поправи —
     mzs:update пази старата стойност при празно поле. Невалидни дати („2026-13-45“)
     също влизаха. Проверява се като при актовете, партидите и заеманията. */
  function assertMzsDates(date, due) {
    if (!isValidIsoDate(date)) throw new Error('Датата на заявката липсва или е невалидна.');
    if (due != null && due !== '' && !isValidIsoDate(due)) throw new Error('Срокът за връщане (' + due + ') е невалиден.');
    if (due && due < date) throw new Error('Срокът за връщане (' + due + ') е преди датата на заявката (' + date + ').');
  }
  /* Читателят на изходяща заявка — по номер на картата (или id). Връща
     undefined, ако полето не е подадено (пази се старото), null за изрично
     изчистване, иначе id. */
  function resolveReader(db, m) {
    if (m.reader_card !== undefined) {
      const card = String(m.reader_card == null ? '' : m.reader_card).trim();
      if (!card) return null;
      const r = db.prepare('SELECT id FROM readers WHERE card_no = ?').get(card);
      if (!r) throw new Error('Читател с карта № ' + card + ' няма в базата. Проверете номера на картата или '
        + 'оставете полето празно и впишете заявителя като текст.');
      return r.id;
    }
    if (m.reader_id !== undefined) {
      if (m.reader_id === null || m.reader_id === '') return null;
      const r = db.prepare('SELECT id FROM readers WHERE id = ?').get(m.reader_id);
      if (!r) throw new Error('Читателят не е намерен — може да е изтрит от друго работно място.');
      return r.id;
    }
    return undefined;
  }
  /* Нашият документ на входяща заявка — по инв. № или баркод (или id). */
  function resolveBook(db, m, cur) {
    if (m.book_code !== undefined) {
      const raw = String(m.book_code == null ? '' : m.book_code).trim();
      /* Формата връща номера, който сама е показала (v2.4.69, преглед на кръга).
         Тогава свързаният документ остава същият, без ново търсене: иначе номер,
         който съвпада с баркода на друг документ, правеше заявката незаписваема
         (дори само бележката), а документ без инв. № се показваше празен, връщаше
         се празен и връзката тихо падаше. */
      if (cur && cur.book_id != null) {
        const was = db.prepare('SELECT inv_number FROM books WHERE id = ?').get(cur.book_id);
        if (was && raw === (was.inv_number == null ? '' : String(was.inv_number))) return cur.book_id;
      }
      if (!raw) return null;
      const b = resolveScannedBook(db, normalizeScanCode(raw) || raw, 'SELECT id, inv_number, title, status FROM books');
      if (!b) throw new Error('Документ с инв. № или баркод „' + raw + '“ няма във фонда.');
      return b.id;
    }
    if (m.book_id !== undefined) {
      if (m.book_id === null || m.book_id === '') return null;
      const b = db.prepare('SELECT id FROM books WHERE id = ?').get(m.book_id);
      if (!b) throw new Error('Документът не е намерен — може да е изтрит.');
      return b.id;
    }
    return undefined;
  }
  /* Може ли нашият документ да тръгне към партньора сега. */
  function assertBookCanLeave(db, bookId, selfId) {
    const b = db.prepare('SELECT inv_number, title, status FROM books WHERE id = ?').get(bookId);
    if (!b) throw new Error('Документът не е намерен — може да е изтрит.');
    const name = 'инв. № ' + (b.inv_number ?? '—') + ' „' + (b.title || '') + '“';
    if (b.status !== 'наличен') {
      throw new Error('Документът ' + name + ' е „' + (b.status || 'без състояние') + '“ и не може да бъде изпратен '
        + 'по МЗС. Изберете друг екземпляр или откажете заявката.');
    }
    const qty = db.prepare('SELECT COALESCE((SELECT quantity FROM inventory WHERE book_id = ?), 1) AS q').get(bookId).q;
    const open = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL').get(bookId).n;
    const held = db.prepare("SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND status = 'заделена'").get(bookId).n;
    const away = db.prepare(`SELECT COUNT(*) AS n FROM mzs_requests WHERE book_id = ? AND id <> ?
        AND direction = 'входящо' AND status IN ('изпратено', 'получено')`).get(bookId, selfId || 0).n;
    if (Number(qty) - open - held - away <= 0) {
      const why = [open ? 'е зает от читател' : '', held ? 'е заделен по резервация' : '',
        away ? 'вече е изпратен по друга МЗС заявка' : ''].filter(Boolean).join(' и ');
      throw new Error('Документът ' + name + ' ' + (why || 'няма свободна бройка')
        + ' — не може да бъде изпратен сега. Изчакайте връщането или изберете друг екземпляр.');
    }
  }
  /* Проверка на прехода и датата му. Връща { patch, note } — колоните за
     промяна и думите за следата. */
  function transition(cur, next, m, direction, due) {
    const from = cur.status || 'заявено';
    if (next === from) return { patch: {}, note: '' };
    const patch = {};
    if ((MZS_FLOW[from] || []).includes(next)) {
      const col = MZS_DATE_COL[next];
      if (next === 'получено' && direction === 'изходящо' && !due) {
        throw new Error('Въведете „Срок за връщане“ — датата, до която библиотеката партньор очаква книгата обратно. '
          + 'По нея програмата следи просрочието (регистърът на МЗС и таблото). Състоянието не е сменено.');
      }
      if (!col) return { patch, note: 'състояние „' + from + '“ → „' + next + '“' };
      const given = m[col];
      const d = given ? given : localDate();
      if (!isValidIsoDate(d)) throw new Error('Датата „' + next + '“ (' + given + ') е невалидна.');
      if (isValidIsoDate(cur.date) && d < cur.date) {
        throw new Error('Датата „' + next + '“ (' + bgDate(d) + ') е преди датата на заявката (' + bgDate(cur.date) + ').');
      }
      patch[col] = d;
      return { patch, note: 'състояние „' + from + '“ → „' + next + '“ на ' + bgDate(d) };
    }
    if (mzsBackStep(cur) === next) {
      const col = MZS_DATE_COL[from];
      if (col) patch[col] = null;
      return { patch, note: 'ПОПРАВКА на състоянието: „' + from + '“ → „' + next + '“ (отменена погрешна стъпка)' };
    }
    const allowed = (MZS_FLOW[from] || []).map(s => '„' + s + '“');
    const back = mzsBackStep(cur);
    throw new Error('Заявката е „' + from + '“ и не може да стане „' + next + '“: ' + mzsWhyNot(from, next) + '. '
      + (allowed.length ? 'Оттук следва ' + allowed.join(' или ') : 'Заявката е приключена')
      + (back ? ' (или „' + back + '“, ако последната стъпка е натисната по грешка)' : '')
      + '. Редът е заявено → изпратено → получено → върнато; „отказано“ — само от първите две.');
  }
  /* Проверки, общи за create и update, след като е ясно какво ще бъде записано. */
  function assertLinks(db, row, cur) {
    if (row.reader_id != null && row.direction !== 'изходящо') {
      throw new Error('С наш читател се свързва само ИЗХОДЯЩА заявка (ние искаме книга за него). Входящата е за '
        + 'читател на другата библиотека — впишете го като текст в „Заявител“.');
    }
    if (row.book_id != null && row.direction !== 'входящо') {
      throw new Error('С наш документ се свързва само ВХОДЯЩА заявка (друга библиотека иска книга от нас). '
        + 'При изходяща книгата е чужда и не се вписва във фонда.');
    }
    if (row.direction === 'входящо' && MZS_AWAY.includes(row.status)) {
      if (row.book_id == null) {
        throw new Error('Отбележете кой наш документ изпращате („Наш документ“ — инв. № или баркод). Докато е при '
          + 'другата библиотека, програмата не го дава на гишето и го показва „зает“ в онлайн каталога.');
      }
      const wasAway = cur && cur.direction === 'входящо' && MZS_AWAY.includes(cur.status) && cur.book_id === row.book_id;
      if (!wasAway) assertBookCanLeave(db, row.book_id, cur && cur.id);
    }
    if (cur && cur.direction !== row.direction && cur.status !== 'заявено' && cur.status !== 'отказано') {
      throw new Error('Посоката на заявката не може да се смени, след като документът е тръгнал — изтрийте я и '
        + 'впишете нова, ако е сгрешена.');
    }
  }
  /* Засяга ли промяната онлайн каталога (наш документ тръгва или се връща). */
  function touchesCatalog(before, after) {
    const away = (r) => !!(r && r.direction === 'входящо' && r.book_id != null && MZS_AWAY.includes(r.status));
    return away(before) !== away(after) || (away(before) && before.book_id !== after.book_id);
  }

  ipcMain.handle('mzs:create', (e, m) =>
    run(() => {
      const db = getDb();
      assertMzsDates(m.date, m.due_date);
      const year = yearOf(m.date);
      const direction = m.direction || 'изходящо';
      const status = m.status || 'заявено';
      /* Нова заявка започва от „заявено“ (или се вписва направо като отказана):
         иначе би се появила „получена“ без дата на изпращане и получаване, а
         срокът ѝ — без отправна точка. */
      if (status !== 'заявено' && status !== 'отказано') {
        throw new Error('Нова заявка започва от „заявено“. Запишете я и сменете състоянието стъпка по стъпка '
          + '(заявено → изпратено → получено → върнато) — така програмата попълва и датите на всяка стъпка.');
      }
      const reader_id = resolveReader(db, m);
      const book_id = resolveBook(db, m);
      /* Същото като при актовете за отчисляване и партидите на постъпленията:
         номерът се предлага с MAX(no)+1 при отваряне на формата, схемата няма
         UNIQUE(year, no), а две работни места към една мрежова база получават
         един и същ номер. Проверката се повтаря при самия запис, в транзакция с
         .immediate() (правото на запис се взима преди проверката).
         К8 (v2.4.69): празен № → следващият свободен за годината на ДАТАТА. */
      const autoNo = m.no === undefined || m.no === null || String(m.no).trim() === '';
      const tx = db.transaction(() => {
        const no = autoNo
          ? (db.prepare('SELECT MAX(no) AS m FROM mzs_requests WHERE year = ?').get(year).m || 0) + 1
          : parseRegisterNo(m.no, '№ на заявката');
        if (db.prepare('SELECT 1 FROM mzs_requests WHERE year = ? AND no = ?').get(year, no)) {
          throw new Error('Заявка № ' + no + '/' + year + ' вече съществува — най-вероятно е създадена от друго работно място '
            + 'към същата база. Затворете и отворете формата отново, за да получите следващия свободен номер.');
        }
        const row = { no, year, date: m.date, direction, partner: m.partner, author: m.author || null, title: m.title,
          isbn: m.isbn || null, requester: m.requester || null, status, due_date: m.due_date || null,
          note: m.note || null, reader_id: reader_id ?? null, book_id: book_id ?? null };
        assertLinks(db, row, null);
        const info = db.prepare(`
          INSERT INTO mzs_requests (no, year, date, direction, partner, author, title, isbn, requester, status, due_date, note,
                                    reader_id, book_id)
          VALUES (@no, @year, @date, @direction, @partner, @author, @title, @isbn, @requester, @status, @due_date, @note,
                  @reader_id, @book_id)
        `).run(row);
        logAudit('Нова МЗС заявка', '№ ' + (autoNo ? no : m.no) + ' — ' + m.title + ' (' + m.direction + ')');
        return info.lastInsertRowid;
      });
      return tx.immediate();
    })
  );
  /* № и датата се обновяват наистина. Формата ги показва като редактируеми (№ е
     дори задължително поле), но дотук просто липсваха в SET: mzs:update връщаше
     {ok:true}, а редът оставаше със стария номер — сгрешен номер в регистъра на
     МЗС не можеше да се поправи по никакъв начин. Проверката за дубликат е
     същата като в mzs:create (схемата няма UNIQUE(year, no)) и по същата причина
     е в транзакция с .immediate(); тук самият ред се изключва от проверката.
     Непратено/празно поле не изтрива стойността, за да продължат да работят и
     частичните извиквания (само статус, само партньор). */
  ipcMain.handle('mzs:update', (e, m) =>
    run(() => {
      const db = getDb();
      const cur = db.prepare('SELECT * FROM mzs_requests WHERE id = ?').get(m.id);
      if (!cur) throw new Error('Заявката не е намерена.');
      const given = (v) => v !== undefined && v !== null && v !== '';
      const no = given(m.no) ? parseRegisterNo(m.no, '№ на заявката') : cur.no;
      const date = given(m.date) ? m.date : cur.date;
      /* Проверява се само подаденото: частично извикване (само статус) на стар ред
         с празна дата минава, а формата, която праща всичко, се проверява изцяло.
         Извикване, което пипа САМО due_date (проверка при прегледа), не бива да
         преповтаря assertMzsDates(cur.date, …) — тя щеше да отхвърли валиден нов
         срок заради невалидна СТАРА дата на заявка, останала от преди тази
         проверка да съществува (реални бази отпреди v2.4.29), макар потребителят
         изобщо да не я пипа в това извикване. Проверява се само подаденото поле;
         редът спрямо старата дата се сравнява само ако тя самата е валидна. */
      if (given(m.date)) assertMzsDates(m.date, m.due_date !== undefined ? m.due_date : cur.due_date);
      else if (m.due_date !== undefined && m.due_date !== '' && m.due_date !== null) {
        if (!isValidIsoDate(m.due_date)) throw new Error('Срокът за връщане (' + m.due_date + ') е невалиден.');
        if (isValidIsoDate(cur.date) && m.due_date < cur.date) {
          throw new Error('Срокът за връщане (' + m.due_date + ') е преди датата на заявката (' + cur.date + ').');
        }
      }
      const year = yearOf(date);
      const direction = m.direction || cur.direction;
      const status = m.status || cur.status;
      const due_date = m.due_date !== undefined ? (m.due_date || null) : cur.due_date;
      const reader = resolveReader(db, m);
      const book = resolveBook(db, m, cur);
      const reader_id = reader === undefined ? cur.reader_id : reader;
      const book_id = book === undefined ? cur.book_id : book;
      /* Нашият документ не се подменя, докато е при партньора: иначе единият би
         останал „зает“ завинаги, а другият — „наличен“, без да е тук. */
      if (cur.direction === 'входящо' && MZS_AWAY.includes(cur.status) && cur.book_id != null
        && book_id !== cur.book_id && status === cur.status) {
        throw new Error('Документът по тази заявка е при партньора — не може да се подмени с друг, докато не бъде '
          + 'отбелязан „върнато“.');
      }
      const step = transition(Object.assign({}, cur, { date }), status, m, direction, due_date);
      const tx = db.transaction(() => {
        if (db.prepare('SELECT 1 FROM mzs_requests WHERE year = ? AND no = ? AND id <> ?').get(year, no, m.id)) {
          throw new Error('Заявка № ' + no + '/' + year + ' вече съществува — изберете друг номер.');
        }
        const row = {
          id: m.id, no, year, date, direction,
          partner: given(m.partner) ? m.partner : cur.partner,
          /* Непратено (undefined) поле пази старата стойност; ИЗРИЧНО празно го
             изчиства. Дотогава `m.author ?? null` триеше автора, ISBN, заявителя,
             срока и бележката при всяко частично извикване — обратното на обещаното
             два реда по-горе. Днес единственият извикващ праща цялата форма, тоест
             не гърми, но това е капан за следващия бърз бутон „смени статуса". */
          author: m.author !== undefined ? (m.author || null) : cur.author,
          title: given(m.title) ? m.title : cur.title,
          isbn: m.isbn !== undefined ? (m.isbn || null) : cur.isbn,
          requester: m.requester !== undefined ? (m.requester || null) : cur.requester,
          status, due_date,
          note: m.note !== undefined ? (m.note || null) : cur.note,
          reader_id, book_id,
          date_sent: 'date_sent' in step.patch ? step.patch.date_sent : cur.date_sent,
          date_received: 'date_received' in step.patch ? step.patch.date_received : cur.date_received,
          date_returned: 'date_returned' in step.patch ? step.patch.date_returned : cur.date_returned
        };
        assertLinks(db, row, cur);
        db.prepare(`
          UPDATE mzs_requests SET no=@no, year=@year, date=@date, direction=@direction, partner=@partner,
            author=@author, title=@title, isbn=@isbn, requester=@requester, status=@status,
            due_date=@due_date, note=@note, reader_id=@reader_id, book_id=@book_id,
            date_sent=@date_sent, date_received=@date_received, date_returned=@date_returned WHERE id=@id
        `).run(row);
        return row;
      });
      const after = tx.immediate();
      logAudit('Редакция на МЗС заявка', '№ ' + no + ' — ' + (given(m.title) ? m.title : cur.title)
        + (step.note ? '; ' + step.note : ''));
      if (scheduleCatalogWrite && touchesCatalog(cur, after)) scheduleCatalogWrite();
    })
  );
  /* Регистър с номера (v2.4.29): изтриването се вписва в следата, както при
     партидите (v2.4.24), и не мълчи при несъществуващ ред. */
  ipcMain.handle('mzs:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const cur = db.prepare('SELECT * FROM mzs_requests WHERE id = ?').get(id);
      if (!cur) throw new Error('Заявката вече не съществува — вероятно е изтрита от друго работно място.');
      db.prepare('DELETE FROM mzs_requests WHERE id = ?').run(id);
      /* СЛЕДАТА КАЗВА И ПОСЛЕДИЦАТА (v2.4.71, кръг 45, М10). Екранът вече пита с
         инв. № и партньора (mzsDeleteQuestion в src/views/mzs.js); тук остава
         редът за проверката: изтрита заявка „изпратено“/„получено“ за наш
         документ го прави отново наличен за гишето и онлайн, без той да се е
         върнал — после въпросът е точно „кога и кой го освободи“. */
      const released = touchesCatalog(cur, {});
      let inv = null;
      if (released) {
        const b = db.prepare('SELECT inv_number FROM books WHERE id = ?').get(cur.book_id);
        inv = b ? b.inv_number : null;
      }
      logAudit('Изтрита МЗС заявка', '№ ' + cur.no + '/' + cur.year + ' — ' + cur.title + ' (' + cur.direction + ')'
        + (released ? '; заявката беше „' + cur.status + '“ — нашият документ' + (inv != null ? ' инв. № ' + inv : '')
          + ' отново е наличен за гишето и в онлайн каталога, макар да не е отбелязан „върнато“ от ' + cur.partner : ''));
      // Изтрита заявка за наш документ „при партньора“ го връща „наличен“ онлайн.
      if (scheduleCatalogWrite && released) scheduleCatalogWrite();
    })
  );
};
module.exports.mzsBlockForBook = mzsBlockForBook;
module.exports.mzsAwayCount = mzsAwayCount;
module.exports.mzsOverdueRows = mzsOverdueRows;
module.exports.MZS_FLOW = MZS_FLOW;
