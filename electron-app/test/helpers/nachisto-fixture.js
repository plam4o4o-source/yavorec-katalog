'use strict';
/* ============================================================================
   ФИКСТУРА ЗА „ЗАПОЧВАНЕ НА ЧИСТО“ — всяка изтривана таблица с редове в нея.
   ============================================================================
   ЗАЩО СЪЩЕСТВУВА. test/nachisto-v2464.test.js доказва, че изтриването
   изпразва всичко, което описва фонда и хората. Такова твърдение струва нещо
   само ако ПРЕДИ изтриването всяка от тези таблици е имала редове: „празна е“
   върху таблица, която и без това е била празна, не доказва нищо — и точно
   това проверява самият тест (`assert.ok(before[t] > 0, …)`).

   ЗАЩО Е ТУК, А НЕ В /tmp. Първата версия на теста четеше фикстурата от
   `/tmp/r41/fixture.js` — работен файл на машината, на която беше писан. На
   всяка друга машина `fs.existsSync` връщаше false, засяването се пропускаше
   мълчаливо и СЕДЕМ от тринайсетте теста падаха. Тоест тестът за единственото
   НЕОБРАТИМО действие в програмата не се изпълняваше никъде освен там. Затова
   фикстурата живее в хранилището, до теста, който я ползва.

   КАКВО ЗАСЯВА. По ред от родител към дете, с реални български стойности и в
   съгласие с тригерите за изброими колони (db/enum-triggers.js) — стойност
   извън разрешените там се отхвърля от самата база. Обхватът е ТОЧНО списъкът
   WIPE от handlers/reset.js; таблиците, които изтриването ОСТАВЯ (настройки,
   служители, авторска таблица, видове, номенклатури, правила, календар), се
   засяват от seedLibraryIdentity() в самия тест — тук нарочно не се пипат, за
   да остане ясно кой какво твърди.

   Броят книги е параметър: изтриването не става по-вярно от 15 000 реда, а
   поредицата трябва да свършва бързо.
============================================================================ */

/* Дните назад се смятат от подадената дата, а не от „днес“: фикстура, чиито
   падежи се местят всеки ден, прави тестовете зависими от календара — точно
   капанът, който вече веднъж срина поредицата (виж бележката за -0 при
   салдото в test/e2e-workflows.test.js). */
function dayOffset(today, days) {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function seed(db, opts) {
  const o = opts || {};
  const BOOKS = o.books || 600;
  const today = o.today || '2026-09-21';
  const year = today.slice(0, 4);
  const READERS = Math.max(12, Math.floor(BOOKS / 20));

  const catId = db.prepare("SELECT id FROM categories WHERE code = 'book'").get()
    || db.prepare('SELECT id FROM categories ORDER BY id LIMIT 1').get();
  const cat = catId ? catId.id : null;

  db.transaction(() => {
    /* ---- Партиди на постъпване (чл. 12) ---------------------------------- */
    const insAcq = db.prepare(`INSERT INTO acquisitions (no, year, date, how, from_source, doc_type,
        doc_no, doc_date, total_count, sum, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const acqIds = [];
    for (let i = 1; i <= 3; i++) {
      acqIds.push(insAcq.run(i, year, dayOffset(today, -300 + i * 30),
        ['закупуване', 'дарение', 'депозит'][i - 1], 'Книжарница „Хермес“', 'фактура',
        '100' + i, dayOffset(today, -301 + i * 30), Math.floor(BOOKS / 3), 120.5 * i,
        'партида от фикстурата').lastInsertRowid);
    }

    /* ---- Актове за отчисляване (чл. 35) ---------------------------------- */
    const insAct = db.prepare(`INSERT INTO deaccession_acts (no, year, date, order_no, reason_code,
        reason_text, disposal, committee1, committee2, committee3, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const actId = insAct.run(1, year, dayOffset(today, -120), '3', 1, 'морално остарели',
      'предадени за вторични суровини', 'А. Иванова', 'Б. Петров', 'В. Георгиева',
      dayOffset(today, -120), 'Мария Георгиева').lastInsertRowid;

    /* ---- Фондът ----------------------------------------------------------
       Първата книга е нарочно „Под игото“ на „Вазов, Иван“: тестът търси точно
       този низ СУРОВ във файла на базата след VACUUM, за да докаже, че
       изтритите лични данни и записи наистина са изчезнали от страниците. */
    const insBook = db.prepare(`INSERT INTO books (inv_number, barcode, register_date, title, author,
        category_id, year, language, department, status, price, udk, call_number, acquisition_id,
        publisher, city, keywords) VALUES (@inv,@bc,@reg,@title,@author,@cat,@year,@lang,@dep,
        @status,@price,@udk,@cn,@acq,@pub,@city,@kw)`);
    const insInv = db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, ?)');
    const insCheck = db.prepare('INSERT INTO inventory_checks (book_id, date) VALUES (?, ?)');
    const bookIds = [];
    for (let i = 1; i <= BOOKS; i++) {
      const id = insBook.run({
        inv: i, bc: 'B' + i, reg: dayOffset(today, -900 + i),
        title: i === 1 ? 'Под игото' : 'Книга № ' + i,
        author: i === 1 ? 'Вазов, Иван' : 'Автор ' + (i % 40),
        cat, year: String(1950 + (i % 70)), lang: 'български',
        dep: i % 3 === 0 ? 'за деца' : 'за възрастни',
        status: 'наличен', price: (1 + (i % 19)) * 1.1,
        udk: String(i % 9), cn: 'Ч/' + (i % 50), acq: acqIds[i % acqIds.length],
        pub: 'Български писател', city: 'София', kw: 'проба, фикстура'
      }).lastInsertRowid;
      bookIds.push(id);
      insInv.run(id, 1);
      if (i % 5 === 0) insCheck.run(id, dayOffset(today, -60));
    }
    /* Броячът на инвентарните номера — вдигнат. Изтриването трябва да го върне
       на 1 и тестът твърди И двете: че е бил вдигнат, и че е върнат. */
    db.prepare('UPDATE settings SET next_inv_number = ? WHERE id = 1').run(BOOKS + 1);

    /* Няколко документа в акта за отчисляване. */
    const insDeacc = db.prepare(`INSERT INTO deaccession_items (act_id, book_id, inv_number, author,
        title, year, price, udk, category, language, quantity) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 4; i++) {
      const b = db.prepare('SELECT * FROM books WHERE id = ?').get(bookIds[i]);
      insDeacc.run(actId, b.id, b.inv_number, b.author, b.title, b.year, b.price, b.udk,
        'книга', b.language, 1);
    }

    /* ---- Читатели и всичко, което виси на тях -----------------------------
       Първият е „Иванов, Иван“: тестът търси „иван“ в readers_fts. */
    const insReader = db.prepare(`INSERT INTO readers (name, phone, address, email, card_no, egn,
        birth_date, category, registered_at, status, gdpr_consent, gdpr_consent_date, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const readerIds = [];
    for (let i = 1; i <= READERS; i++) {
      readerIds.push(insReader.run(
        i === 1 ? 'Иванов, Иван' : 'Читател № ' + i,
        '088812' + String(1000 + i), 'с. Пробно, ул. „Първа“ № ' + i,
        'chitatel' + i + '@example.com', String(1000 + i),
        /* ЕГН-подобен низ — точно каквото VACUUM трябва да махне от файла. */
        '75010' + String(10000 + i),
        dayOffset(today, -9000 - i), i % 4 === 0 ? 'дете до 14 г.' : 'възрастен',
        dayOffset(today, -400), 'активен', 1, dayOffset(today, -400), 'бележка').lastInsertRowid);
    }

    const insLoan = db.prepare(`INSERT INTO loans (reader_id, book_id, date_out, date_due, date_in,
        fine, renewals) VALUES (?,?,?,?,?,?,?)`);
    const insEvent = db.prepare(`INSERT INTO events (date, kind, book_id, reader_id, reader_category,
        book_language, book_udk, book_category) VALUES (?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < Math.min(BOOKS, READERS * 6); i++) {
      const r = readerIds[i % readerIds.length];
      const b = bookIds[i % bookIds.length];
      const out = dayOffset(today, -40 - (i % 30));
      /* Част от заеманията остават НЕВЪРНАТИ: изтриването трябва да мине и с
         тях, а и „заето“ е състояние, което влиза в инвентаризацията. */
      const back = i % 7 === 0 ? null : dayOffset(today, -10 - (i % 5));
      insLoan.run(r, b, out, dayOffset(today, -19 - (i % 30)), back, 0, i % 3);
      insEvent.run(out, 'заемане', b, r, 'възрастен', 'български', String(i % 9), 'книга');
      if (back) insEvent.run(back, 'връщане', b, r, 'възрастен', 'български', String(i % 9), 'книга');
    }

    const insLine = db.prepare(`INSERT INTO account_lines (reader_id, date, kind, type, amount, note)
      VALUES (?,?,?,?,?,?)`);
    const insHold = db.prepare('INSERT INTO holds (book_id, reader_id, status, note) VALUES (?,?,?,?)');
    const insHbP = db.prepare('INSERT INTO housebound_profiles (reader_id, day, frequency, note) VALUES (?,?,?,?)');
    const insHbV = db.prepare('INSERT INTO housebound_visits (reader_id, date, note) VALUES (?,?,?)');
    const insNotice = db.prepare('INSERT INTO notice_log (reader_id, level, channel, loans_count) VALUES (?,?,?,?)');
    const insSugg = db.prepare(`INSERT INTO suggestions (date, reader_id, reader_name, author, title,
        status, acquisition_id) VALUES (?,?,?,?,?,?,?)`);
    for (let i = 0; i < readerIds.length; i++) {
      const r = readerIds[i];
      insLine.run(r, dayOffset(today, -30), 'начисление', 'годишна такса', 5, 'за ' + year);
      if (i % 2 === 0) insLine.run(r, dayOffset(today, -29), 'плащане', 'плащане', -5, 'в брой');
      if (i % 3 === 0) insHold.run(bookIds[i % bookIds.length], r, 'чака', 'запазена');
      if (i % 4 === 0) {
        insHbP.run(r, 'вторник', 'месечно', 'трудно подвижен читател');
        insHbV.run(r, dayOffset(today, -15), 'занесени 3 книги');
      }
      if (i % 5 === 0) insNotice.run(r, 1, 'печат', 2);
      if (i % 6 === 0) {
        insSugg.run(dayOffset(today, -25), r, 'Читател № ' + (i + 1), 'Йовков, Йордан',
          'Старопланински легенди', 'заявено', acqIds[0]);
      }
    }

    /* ---- Междубиблиотечно заемане (чл. 30, т. 4) ------------------------- */
    const insMzs = db.prepare(`INSERT INTO mzs_requests (no, year, date, direction, partner, author,
        title, requester, status, due_date) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insMzs.run(1, year, dayOffset(today, -50), 'изходящо', 'РБ „П. Славейков“ – Велико Търново',
      'Талев, Димитър', 'Железният светилник', 'Иванов, Иван', 'изпратено', dayOffset(today, -20));
    insMzs.run(2, year, dayOffset(today, -40), 'входящо', 'НЧ „Съгласие“ – Габрово',
      'Каралийчев, Ангел', 'Приказен свят', 'Читател № 3', 'получено', dayOffset(today, -10));

    /* ---- Периодика (чл. 23) ---------------------------------------------- */
    const insPer = db.prepare('INSERT INTO periodicals (title, freq, publisher, issn, department) VALUES (?,?,?,?,?)');
    const insVol = db.prepare('INSERT INTO periodical_volumes (periodical_id, year, book_id, issue_count, issue_sum) VALUES (?,?,?,?,?)');
    const insIss = db.prepare('INSERT INTO periodical_issues (periodical_id, issue_no, date, price, note) VALUES (?,?,?,?,?)');
    const perIds = [];
    for (const [t, f] of [['Читалище', 'месечно'], ['Библиотека', 'двуседмично']]) {
      const pid = insPer.run(t, f, 'СБЧ', '1310-000' + perIds.length, 'за възрастни').lastInsertRowid;
      perIds.push(pid);
      insVol.run(pid, year, bookIds[perIds.length], 12, 24.0);
      for (let i = 1; i <= 6; i++) insIss.run(pid, String(i), dayOffset(today, -30 * i), 4.0, null);
    }

    /* ---- Краезнание (чл. 30, т. 5) --------------------------------------- */
    const insPerson = db.prepare(`INSERT INTO persons (name, birth_date, birth_place, activity, bio, sources)
      VALUES (?,?,?,?,?,?)`);
    const insChron = db.prepare(`INSERT INTO chronicle (year, date, title, body, category, participants, sources)
      VALUES (?,?,?,?,?,?,?)`);
    const insLink = db.prepare('INSERT INTO links (from_kind, from_id, to_kind, to_id, note) VALUES (?,?,?,?,?)');
    const insAnal = db.prepare(`INSERT INTO analytics (title, author, source_kind, periodical_id,
        year, issue, pages, udk, keywords, is_local) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 1; i <= 4; i++) {
      const pid = insPerson.run('Личност № ' + i, '19' + (10 + i) + '-03-0' + i, 'с. Пробно',
        'учител', 'Кратка биография.', 'Летопис на читалището').lastInsertRowid;
      const cid = insChron.run(String(1920 + i), dayOffset(today, -365 * i), 'Събитие № ' + i,
        'Описание на събитието.', 'читалище', 'Личност № ' + i, 'протокол').lastInsertRowid;
      insLink.run('персона', pid, 'летопис', cid, 'участник');
      insLink.run('летопис', cid, 'книга', bookIds[i], 'споменат');
      insAnal.run('Статия № ' + i, 'Личност № ' + i, 'периодика', perIds[i % perIds.length],
        year, String(i), '12–15', '908', 'краезнание', 1);
    }

    /* ---- Онлайн каталог: витрини ----------------------------------------- */
    const insShelf = db.prepare('INSERT INTO catalog_shelves (name, sort) VALUES (?, ?)');
    const insShelfItem = db.prepare('INSERT INTO catalog_shelf_items (shelf_id, book_id, sort) VALUES (?,?,?)');
    for (let s = 1; s <= 2; s++) {
      const sid = insShelf.run(s === 1 ? 'Нови книги' : 'Българска класика', s).lastInsertRowid;
      for (let i = 0; i < 5; i++) insShelfItem.run(sid, bookIds[s * 10 + i], i);
    }

    /* ---- Инвентаризации (чл. 44) ----------------------------------------- */
    const insSess = db.prepare(`INSERT INTO inventory_sessions (date, scope, committee1, committee2,
        committee3, pool_size, closed, mode, no, year, order_no) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const insScan = db.prepare('INSERT INTO inventory_session_scans (session_id, book_id) VALUES (?,?)');
    const insMiss = db.prepare(`INSERT INTO inventory_session_missing (session_id, book_id, inv_number,
        title, author, price, quantity) VALUES (?,?,?,?,?,?,?)`);
    const sid = insSess.run(dayOffset(today, -200), 'целият фонд', 'А. Иванова', 'Б. Петров',
      'В. Георгиева', BOOKS, 1, 'full', 1, year, '5').lastInsertRowid;
    for (let i = 0; i < Math.min(40, bookIds.length); i++) insScan.run(sid, bookIds[i]);
    for (let i = 40; i < Math.min(45, bookIds.length); i++) {
      const b = db.prepare('SELECT * FROM books WHERE id = ?').get(bookIds[i]);
      insMiss.run(sid, b.id, b.inv_number, b.title, b.author, b.price, 1);
    }

    /* ---- Чернови за отчисляване ------------------------------------------ */
    const insDraft = db.prepare(`INSERT INTO deaccession_drafts (date, order_no, reason_code,
        reason_text, committee1, committee2, committee3) VALUES (?,?,?,?,?,?,?)`);
    const insDraftItem = db.prepare('INSERT INTO deaccession_draft_items (draft_id, book_id) VALUES (?,?)');
    const did = insDraft.run(dayOffset(today, -5), '7', 2, 'изгубени от читатели',
      'А. Иванова', 'Б. Петров', 'В. Георгиева').lastInsertRowid;
    for (let i = 50; i < 54; i++) insDraftItem.run(did, bookIds[i]);

    /* ---- Дневник и статистика (чл. 30) ----------------------------------- */
    const insVisit = db.prepare('INSERT INTO visits (date, count) VALUES (?, ?)');
    const insDay = db.prepare(`INSERT INTO dnevnik_days (date, a_hours, a_age_u14, a_age_19_28,
        b_hours, b_type_books, b_lang_bg) VALUES (?,?,?,?,?,?,?)`);
    const insSearch = db.prepare('INSERT INTO search_history (user, kind, query) VALUES (?,?,?)');
    for (let i = 1; i <= 20; i++) {
      insVisit.run(dayOffset(today, -i), 5 + (i % 11));
      insDay.run(dayOffset(today, -i), 6, 2, 3, 6, 4, 4);
      insSearch.run('Мария Георгиева', 'книги', 'вазов ' + i);
    }

    /* ---- Одитната следа — СТАРА, отпреди изтриването ----------------------
       По ред на действие, както я пише logAudit в истинската програма: запис на
       всяка книга и всеки регистриран читател. При 600 книги това са стотици
       реда — колкото има и една истинска библиотека след няколко месеца работа,
       и достатъчно, за да значи нещо „новата следа има точно ЕДИН ред“. */
    const insAudit = db.prepare('INSERT INTO audit_log (user, action, detail, diff) VALUES (?,?,?,?)');
    for (let i = 1; i <= BOOKS; i++) {
      insAudit.run('Мария Георгиева', 'Запис на книга', 'инв. № ' + i + ' е добавен', null);
    }
    for (let i = 1; i <= READERS; i++) {
      insAudit.run('Иванка Петрова', 'Запис на читател', 'карта № ' + (1000 + i), null);
    }
  }).immediate();

  return {
    books: BOOKS,
    readers: READERS
  };
}

module.exports = { seed, dayOffset };
