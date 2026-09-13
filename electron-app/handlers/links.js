// Краеведски модул: Връзки между краеведските записи и фонда — извадено от
// main.js в отделен модул (Фаза 4, стъпка 31). linkLabel() чете направо от
// books/analytics/chronicle/persons/periodicals по getDb() — не са нужни
// препратки към другите вече извадени/неизвадени модули.
module.exports = function registerLinksHandlers(ipcMain, deps) {
  const { getDb, run } = deps;

  const LINK_FROM = ['персона', 'летопис'];
  const LINK_TO = ['книга', 'статия', 'летопис', 'персона', 'периодика'];
  /* КРАЕЗНАНИЕТО ТРЯБВА ДА ЗНАЕ, ЧЕ ДОКУМЕНТЪТ Е ОТЧИСЛЕН (v2.4.57).
     =====================================================================
     Краеведските връзки надживяват фонда — това им е работата. Летописът за
     1944 г. сочи книга, книгата се къса и се отчислява по чл. 30, т. 2, а
     връзката остава и е ПРАВИЛНО да остане: тя описва какво е ползвано, а не
     какво стои на рафта.

     Счупеното беше друго — че никъде не пише, че документът вече го няма:
       • links:list показваше целта като „инв. № 5 · Вазов. Под игото“ —
         неразличима от жива, а links:backlinks изобщо не казваше нищо за
         състоянието на документа, към който сочат връзките;
       • links:search го намираше и предлагаше за НОВА връзка;
       • links:add към отчислен документ минаваше без дума.
     Тоест краеведът праща читател да търси в каталога книга, която библиотеката
     вече не притежава — и научава това чак когато читателят се върне.

     Че грижата е възможна, се вижда от другия край на същата програма:
     books:delete ИЗРИЧНО отказва изтриване на документ, към който има аналитични
     описания. Тоест едната посока на връзката е пазена, а другата — не.

     Поправката е в две части и нарочно с различна строгост:
       • СЪЩЕСТВУВАЩИТЕ връзки се БЕЛЕЖАТ, не се трият (виж по-горе защо);
       • НОВИТЕ връзки към отчислен документ се ОТКАЗВАТ — новата връзка е
         решение, взето днес, и ако наистина се прави съзнателно, мястото ѝ е
         в свободния текст на бележката, а не в жив указател към несъществуващ
         инвентарен номер.

     Анулиран акт не брои: документът по него е върнат във фонда. Затова ВСЯКА
     проверка тук минава през revoked_at IS NULL, както навсякъде другаде. */
  const DEACC_JOIN = 'LEFT JOIN deaccession_acts da ON da.id = b.deaccession_act_id AND da.revoked_at IS NULL';
  /* Добавката към етикета. Номерът на акта се показва, когато го има; отчислен
     БЕЗ акт (внесен от стара таблица) също се бележи — той е също толкова
     несъществуващ за читателя, просто документацията му липсва. */
  const DEACC_MARK = `CASE WHEN b.status = 'отчислен'
      THEN COALESCE(' (отчислен с акт № ' || da.no || '/' || da.year || ')', ' (отчислен)')
      ELSE '' END`;
  /* Същото за JS-пътя — чете се веднъж и се ползва и от етикетите, и от отказа
     при нова връзка. Връща null за жив документ. */
  function deaccNote(db, bookId) {
    const b = db.prepare(`
      SELECT b.status, da.no, da.year FROM books b
      ${DEACC_JOIN} WHERE b.id = ?`).get(bookId);
    if (!b || b.status !== 'отчислен') return null;
    return b.no != null ? 'отчислен с акт № ' + b.no + '/' + b.year : 'отчислен';
  }
  // Описанието на всяка връзка се сглобява от съответната таблица, за да се
  // показва смислен ред, а не само номер.
  function linkLabel(kind, id) {
    const db = getDb();
    if (kind === 'книга') {
      const b = db.prepare(`SELECT b.inv_number, b.author, b.title, b.status, da.no AS act_no, da.year AS act_year
        FROM books b ${DEACC_JOIN} WHERE b.id = ?`).get(id);
      if (!b) return '(изтрит запис)';
      // Белегът е в края на етикета — така началото („инв. № … · Автор. Заглавие“)
      // остава дума по дума същото, каквото връща и links:search, а прозорецът
      // „Аналитично описание“ разчита точно на съвпадението знак по знак.
      const mark = b.status === 'отчислен'
        ? (b.act_no != null ? ` (отчислен с акт № ${b.act_no}/${b.act_year})` : ' (отчислен)')
        : '';
      return `инв. № ${b.inv_number ?? '—'} · ${[b.author, b.title].filter(Boolean).join('. ')}${mark}`;
    }
    if (kind === 'статия') {
      const a = db.prepare('SELECT author, title, year FROM analytics WHERE id = ?').get(id);
      return a ? `${[a.author, a.title].filter(Boolean).join('. ')}${a.year ? ' (' + a.year + ')' : ''}` : '(изтрит запис)';
    }
    if (kind === 'летопис') {
      const c = db.prepare('SELECT year, title FROM chronicle WHERE id = ?').get(id);
      return c ? `${c.year} — ${c.title}` : '(изтрит запис)';
    }
    if (kind === 'персона') {
      const p = db.prepare('SELECT name FROM persons WHERE id = ?').get(id);
      return p ? p.name : '(изтрит запис)';
    }
    if (kind === 'периодика') {
      const p = db.prepare('SELECT title FROM periodicals WHERE id = ?').get(id);
      return p ? p.title : '(изтрит запис)';
    }
    return String(id);
  }
  ipcMain.handle('links:list', (e, { fromKind, fromId }) =>
    run(() => {
      const rows = getDb().prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? ORDER BY to_kind, id')
        .all(fromKind, fromId);
      rows.forEach(r => { r.label = linkLabel(r.to_kind, r.to_id); });
      return rows;
    })
  );
  // Обратната посока: кои персоналии и записи в летописа сочат към даден документ.
  ipcMain.handle('links:backlinks', (e, { toKind, toId }) =>
    run(() => {
      const rows = getDb().prepare('SELECT * FROM links WHERE to_kind = ? AND to_id = ? ORDER BY from_kind, id')
        .all(toKind, toId);
      /* `label` е ИЗТОЧНИКЪТ (персоналията или записът в летописа) — това пита
         обратната посока. Липсваше обаче отговор на другия въпрос, който същият
         екран задава: „а самият документ още ли е във фонда?“. Дотук нищо в тези
         редове не го казваше и списъкът от връзки към отчислена книга изглеждаше
         точно като списък от връзки към жива. Затова се връща и етикетът на ЦЕЛТА,
         който за книга носи белега „(отчислен с акт № N/год.)“ — един и същ низ,
         с един и същ вид, както го дават links:list и links:search. */
      rows.forEach(r => {
        r.label = linkLabel(r.from_kind, r.from_id);
        r.to_label = linkLabel(r.to_kind, r.to_id);
      });
      return rows;
    })
  );
  ipcMain.handle('links:add', (e, { fromKind, fromId, toKind, toId, note }) =>
    run(() => {
      const db = getDb();
      if (!LINK_FROM.includes(fromKind) || !LINK_TO.includes(toKind)) throw new Error('Непозната връзка.');
      if (fromKind === toKind && Number(fromId) === Number(toId)) throw new Error('Записът не може да сочи към себе си.');
      const dup = db.prepare('SELECT id FROM links WHERE from_kind=? AND from_id=? AND to_kind=? AND to_id=?')
        .get(fromKind, fromId, toKind, toId);
      if (dup) throw new Error('Тази връзка вече съществува.');
      /* Нова връзка към отчислен документ се отказва (виж дългата бележка горе).
         Съобщението казва и КАКВО да се направи вместо това — иначе отказът е
         задънена улица, а описанието на статията е набирано на ръка. */
      if (toKind === 'книга') {
        const note = deaccNote(db, toId);
        if (note) {
          throw new Error('Документът е ' + note + ' и вече не е част от фонда — нова връзка към него не се прави. '
            + 'Ако изданието е ползвано като източник, опишете го в бележката към връзката или в свободния текст '
            + 'на аналитичното описание.');
        }
      }
      db.prepare('INSERT INTO links (from_kind, from_id, to_kind, to_id, note) VALUES (?, ?, ?, ?, ?)')
        .run(fromKind, fromId, toKind, toId, note || null);
    })
  );
  ipcMain.handle('links:delete', (e, id) => run(() => getDb().prepare('DELETE FROM links WHERE id = ?').run(id)));
  // Търсене на записи, към които да се направи връзка.
  ipcMain.handle('links:search', (e, { kind, q }) =>
    run(() => {
      const db = getDb();
      const like = '%' + (q || '') + '%';
      if (kind === 'книга') {
        /* Отчислените ОСТАВАТ в резултата, но с белега. Да се скрият изглежда
           по-чисто и е по-лошо: библиотекарят, който търси по инвентарен номер
           от стара картотека, получава „няма такъв документ“ — същата задънена
           улица, която deaccessionActs:findBook вече веднъж отвори и после
           затвори (одит v2.4.25). По-добре го намира и вижда защо не става. */
        return db.prepare(`SELECT b.id, (COALESCE('инв. № ' || b.inv_number || ' · ', '') ||
          COALESCE(b.author || '. ', '') || b.title || ${DEACC_MARK}) AS label
          FROM books b ${DEACC_JOIN}
          WHERE b.title LIKE ? OR b.author LIKE ? OR CAST(b.inv_number AS TEXT) = ? ORDER BY b.title LIMIT 40`)
          .all(like, like, q || '');
      }
      if (kind === 'статия') {
        return db.prepare(`SELECT id, (COALESCE(author || '. ', '') || title ||
          COALESCE(' (' || year || ')', '')) AS label FROM analytics
          WHERE title LIKE ? OR author LIKE ? ORDER BY year DESC, title LIMIT 40`).all(like, like);
      }
      if (kind === 'летопис') {
        return db.prepare(`SELECT id, (year || ' — ' || title) AS label FROM chronicle
          WHERE title LIKE ? OR body LIKE ? ORDER BY year DESC LIMIT 40`).all(like, like);
      }
      if (kind === 'персона') {
        return db.prepare(`SELECT id, name AS label FROM persons
          WHERE name LIKE ? OR alt_names LIKE ? ORDER BY name LIMIT 40`).all(like, like);
      }
      if (kind === 'периодика') {
        return db.prepare(`SELECT id, title AS label FROM periodicals WHERE title LIKE ? ORDER BY title LIMIT 40`).all(like);
      }
      throw new Error('Непознат вид запис.');
    })
  );
};
