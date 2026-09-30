// Краеведски модул: Връзки между краеведските записи и фонда — извадено от
// main.js в отделен модул (Фаза 4, стъпка 31). linkLabel() чете направо от
// books/analytics/chronicle/persons/periodicals по getDb() — не са нужни
// препратки към другите вече извадени/неизвадени модули.

/* Регистър на кирилицата и LIKE-заместителите в търсенето — ПЪЛНАТА бележка
   защо е така и защо не е FTS5 стои в handlers/chronicle.js (v2.4.61). Тук
   тежи двойно: links:search е търсачката, с която се ЗАКАЧАТ връзките, и
   „%“ в полето върнеше целия фонд като предложение за свързване. */
const { authorTitleText } = require('../security-utils'); // Ф7 (v2.4.71) — без двойна точка след инициал
const KRAE_FN_READY = new WeakSet();
function ensureKraeFunctions(db) {
  if (KRAE_FN_READY.has(db)) return db;
  db.function('bglower', (s) => (s == null ? null : String(s).toLowerCase()));
  KRAE_FN_READY.add(db);
  return db;
}
/* СЪИМЕННИЦИТЕ — ЕДНО ПРЕБРОЯВАНЕ, НЕ ПО ЕДНО НА ЕТИКЕТ (v2.4.69, преглед).
   Етикетът на персоналия без години и дейност пита „има ли друг със същото
   име“. Дотук това беше заявка с JS функция върху ВСЕКИ ред на persons за всеки
   етикет — 50 реда в списък при 2 000 картона са 100 000 извиквания. Сега
   ключовете се броят веднъж и броят се пази, докато базата не се промени
   (същият отпечатък като товара на каталога в main.js). Ключът е personKey от
   handlers/persons.js — едно правило за двата модула. */
const { personKey } = require('./persons');
/** @type {{ db: unknown, stamp: string | null, counts: Map<string, number> | null }} */
let NAMESAKES = { db: null, stamp: null, counts: null };
function personKeyCounts(db) {
  const stamp = db.prepare('SELECT total_changes() AS n').get().n + '|' + db.pragma('data_version', { simple: true });
  // counts се записва заедно със stamp — проверката за него е само за tsc.
  if (NAMESAKES.db === db && NAMESAKES.stamp === stamp && NAMESAKES.counts) return NAMESAKES.counts;
  const counts = new Map();
  for (const r of db.prepare('SELECT name FROM persons').all()) {
    const k = personKey(r.name);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  NAMESAKES = { db, stamp, counts };
  return counts;
}
function bgLikeArg(raw) {
  return '%' + String(raw == null ? '' : raw).toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
}

module.exports = function registerLinksHandlers(ipcMain, deps) {
  const { getDb, run } = deps;
  /* ОДИТНА СЛЕДА ЗА ВРЪЗКИТЕ (v2.4.61).
     =====================================================================
     Краеведските връзки се създаваха и триеха без НИТО ЕДИН ред в одитния
     дневник — единственото действие в програмата, което променя базата и не
     оставя следа. А „Махни“ стои на всеки ред в картона и един клик по грешния
     ред махаше връзка, за която после никой не може да каже нито че я е имало,
     нито кой я е махнал. Останалите краеведски канали (летопис, персоналии,
     аналитично описание) вписват всяко създаване, редакция и изтриване.

     main.js подава на този модул само { getDb, run } — без logAudit, за разлика
     от съседните краеведски модули. Този кръг не пипа main.js, затова следата
     се вписва направо в audit_log, а когато някой ден logAudit бъде подаден,
     редът ще носи и ИМЕТО на служителя (тук колоната user остава празна —
     CURRENT_USER живее в main.js). Вписването е в try/catch, защото пропаднала
     одитна следа не бива да отменя самата връзка — но мълчи не остава: грешката
     отива в дневника за грешки. */
  const logAudit = deps.logAudit || ((action, detail) => {
    try {
      getDb().prepare('INSERT INTO audit_log (user, action, detail) VALUES (?, ?, ?)')
        .run('', action, detail || '');
    } catch (err) {
      console.error('Одитният ред за краеведска връзка не можа да се запише:', err);
    }
  });

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
  /* Същото за JS-пътя — чете се веднъж и се ползва и от етикетите, и от отказа
     при нова връзка. Връща null за жив документ. */
  function deaccNote(db, bookId) {
    const b = db.prepare(`
      SELECT b.status, da.no, da.year FROM books b
      ${DEACC_JOIN} WHERE b.id = ?`).get(bookId);
    if (!b || b.status !== 'отчислен') return null;
    return b.no != null ? 'отчислен с акт № ' + b.no + '/' + b.year : 'отчислен';
  }

  /* ЕДИН ЕТИКЕТ, ЕДНА ФУНКЦИЯ (v2.4.61).
     =====================================================================
     Дотук един и същ запис получаваше ДВА различни етикета: links:search го
     сглобяваше в SQL (с COALESCE, което при липсващ инвентарен номер махаше
     цялата представка), а links:list — в JavaScript (където липсващият номер
     ставаше „инв. № — · “). За книга без инвентарен номер — служебно издание,
     дарение, което още не е вписано — двата низа се разминаваха.

     Това не е козметика. Прозорецът „Аналитично описание“ намира book_id, като
     сравнява ЗНАК ПО ЗНАК текста в полето „Книга от фонда“ с етикета, върнат от
     links:search (виж дългата бележка в src/views/analytics.js, одит v2.4.29).
     Щом двата етикета се разминават, сравнението не намира нищо и връзката към
     книгата се къса мълчаливо при първата редакция.

     Затова етикетът вече се прави на ЕДНО място — labelOf() — и links:search
     минава през него, вместо да го сглобява наново в SQL. Липсващият
     инвентарен номер се ПРОПУСКА (както го пропускаше SQL-ът и както го прави
     bookPickLabel() в прозореца на описанието): „инв. № —“ не е номер и не се
     търси по него. Белегът за отчисляване остава В КРАЯ, за да не се мени
     началото на низа. */
  const ROW_SQL = {
    'книга': `SELECT b.id, b.inv_number, b.author, b.title, b.status, da.no AS act_no, da.year AS act_year
              FROM books b ${DEACC_JOIN}`,
    'статия': 'SELECT a.id, a.author, a.title, a.year FROM analytics a',
    'летопис': 'SELECT c.id, c.year, c.title FROM chronicle c',
    'персона': 'SELECT p.id, p.name, p.birth_date, p.death_date, p.activity FROM persons p',
    'периодика': 'SELECT p.id, p.title FROM periodicals p'
  };
  const ROW_ID = { 'книга': 'b.id', 'статия': 'a.id', 'летопис': 'c.id', 'персона': 'p.id', 'периодика': 'p.id' };
  const KIND_TABLE = { 'книга': 'books', 'статия': 'analytics', 'летопис': 'chronicle', 'персона': 'persons', 'периодика': 'periodicals' };
  function labelOf(kind, r) {
    if (!r) return '(изтрит запис)';
    if (kind === 'книга') {
      const mark = r.status === 'отчислен'
        ? (r.act_no != null ? ` (отчислен с акт № ${r.act_no}/${r.act_year})` : ' (отчислен)')
        : '';
      const inv = (r.inv_number == null || r.inv_number === '') ? '' : `инв. № ${r.inv_number} · `;
      return `${inv}${authorTitleText(r.author, r.title)}${mark}`;
    }
    if (kind === 'статия') {
      return `${authorTitleText(r.author, r.title)}${r.year ? ' (' + r.year + ')' : ''}`;
    }
    if (kind === 'летопис') return `${r.year} — ${r.title}`;
    /* СЪИМЕННИЦИТЕ СЕ РАЗЛИЧАВАТ (v2.4.69, Л10).
       Дотук етикетът беше само името: двата картона „Вълчев, Стефан“ (дядото и
       внукът — съименниците в селото са правило, виж handlers/persons.js)
       излизаха в „Намерени“ като два еднакви реда, и връзката отиваше при
       случайния от тях. Сега след името стоят годините и дейността — точно
       каквото различава двама души с едно име в краеведската картотека, — а
       когато картонът няма нито едното И има съименник, номерът му („картон
       № 12“), за да не останат два реда неразличими. Номерът не се лепи на
       всяко име: без съименник той е само шум в картона и на хартия. */
    if (kind === 'персона') {
      const yr = (v) => { const m = /\d{3,4}/.exec(String(v || '')); return m ? m[0] : ''; };
      const b = yr(r.birth_date), d = yr(r.death_date);
      const years = b && d ? b + '–' + d : b ? 'р. ' + b : d ? 'п. ' + d : '';
      const act = String(r.activity || '').trim();
      const extra = [years, act].filter(Boolean).join(', ');
      if (extra) return r.name + ' (' + extra + ')';
      const namesake = (personKeyCounts(getDb()).get(personKey(r.name)) || 0) > 1;
      return r.name + (namesake ? ' (картон № ' + r.id + ')' : '');
    }
    if (kind === 'периодика') return r.title;
    return String(r.id);
  }
  // Описанието на всяка връзка се сглобява от съответната таблица, за да се
  // показва смислен ред, а не само номер.
  function linkLabel(kind, id) {
    if (!ROW_SQL[kind]) return String(id);
    const r = getDb().prepare(`${ROW_SQL[kind]} WHERE ${ROW_ID[kind]} = ?`).get(id);
    return labelOf(kind, r);
  }
  // Съществува ли изобщо записът, за който се говори (виж links:add).
  function recordExists(db, kind, id) {
    const table = KIND_TABLE[kind];
    if (!table) return false;
    return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  }

  ipcMain.handle('links:list', /** @param {unknown} e @param {IpcArg<'links:list'>} arg */ (e, { fromKind, fromId }) =>
    run(() => {
      const rows = getDb().prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? ORDER BY to_kind, id')
        .all(fromKind, fromId);
      rows.forEach(r => { r.label = linkLabel(r.to_kind, r.to_id); });
      return rows;
    })
  );
  // Обратната посока: кои персоналии и записи в летописа сочат към даден документ.
  ipcMain.handle('links:backlinks', /** @param {unknown} e @param {IpcArg<'links:backlinks'>} arg */ (e, { toKind, toId }) =>
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
      /* СТАТИИТЕ, ЧИЙТО ИЗТОЧНИК Е ТОЗИ ДОКУМЕНТ (v2.4.69, Л6).
         Към книга и към периодично издание сочат не само връзките (персоналия →
         книга, летопис → книга), а и аналитичните описания — статия „в“ сборника
         (analytics.book_id) или „в“ броя на вестника (analytics.periodical_id).
         Находката е дословно: „картонът на книга не показва кои персоналии и
         СТАТИИ сочат към нея“. Те се връщат в същия списък с from_kind 'статия'
         и `source: true` — не са ред в `links` и нямат „Махни“ (махат се, като
         се смени източникът в самото описание). */
      if (toKind === 'книга' || toKind === 'периодика') {
        const col = toKind === 'книга' ? 'book_id' : 'periodical_id';
        getDb().prepare(`SELECT id FROM analytics WHERE ${col} = ? ORDER BY year DESC, title`).all(toId)
          .forEach(a => rows.push({ id: null, source: true, from_kind: 'статия', from_id: a.id, to_kind: toKind, to_id: toId,
            label: linkLabel('статия', a.id), to_label: linkLabel(toKind, toId) }));
      }
      return rows;
    })
  );
  ipcMain.handle('links:add', /** @param {unknown} e @param {IpcArg<'links:add'>} arg */ (e, { fromKind, fromId, toKind, toId, note }) =>
    run(() => {
      const db = getDb();
      if (!LINK_FROM.includes(fromKind) || !LINK_TO.includes(toKind)) throw new Error('Непозната връзка.');
      if (fromKind === toKind && Number(fromId) === Number(toId)) throw new Error('Записът не може да сочи към себе си.');
      /* ДВАТА КРАЯ СЕ ПРОВЕРЯВАТ, ЧЕ СЪЩЕСТВУВАТ (v2.4.61).
         =================================================================
         Дотук links:add вписваше всяка двойка числа, която му подадат. Връзка
         към книга с id 999999 (или ОТ персоналия, която другото работно място
         междувременно е изтрило) влизаше в базата и се показваше в картона като
         „(изтрит запис)“ — ред, който не сочи наникъде, не може да се поправи и
         не казва какво е бил. Сираците се раждат тихо: през вноса от стара
         база, през второ работно място и през самия картон, ако записът е
         изтрит, докато прозорецът стои отворен.
         Изтриването отдавна се пази от другата страна — persons:delete,
         chronicle:delete и analytics:delete чистят връзките си в транзакция;
         липсваше само проверката при създаване. */
      if (!recordExists(db, fromKind, fromId)) {
        throw new Error('Записът, от който тръгва връзката, вече не съществува — вероятно е изтрит от '
          + 'друго работно място. Затворете картона, отворете го наново и повторете свързването.');
      }
      if (!recordExists(db, toKind, toId)) {
        throw new Error('Записът, към който сочи връзката, не съществува в базата. Изберете го наново от '
          + 'списъка „Намерени“ — вероятно е изтрит, докато прозорецът е бил отворен.');
      }
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
            /* v2.4.73: дотук съветът сочеше и „бележката към връзката“ — поле, което
               панелът за връзки няма. Остава само пътят, който съществува. */
            + 'Ако изданието е ползвано като източник, опишете го в свободния текст на записа '
            + '(аналитичното описание, летописа или картона на персоната).');
        }
      }
      db.prepare('INSERT INTO links (from_kind, from_id, to_kind, to_id, note) VALUES (?, ?, ?, ?, ?)')
        .run(fromKind, fromId, toKind, toId, note || null);
      logAudit('Краеведски връзки', 'нова връзка: ' + fromKind + ' „' + linkLabel(fromKind, fromId)
        + '“ → ' + toKind + ' „' + linkLabel(toKind, toId) + '“');
    })
  );
  ipcMain.handle('links:delete', /** @param {unknown} e @param {IpcArg<'links:delete'>} id */ (e, id) =>
    run(() => {
      const db = getDb();
      const l = db.prepare('SELECT * FROM links WHERE id = ?').get(id);
      // Както при chronicle:delete: липсващият ред е отказ, а не тих успех —
      // одитната следа не бива да твърди махане, което не се е случило.
      if (!l) throw new Error('Връзката не е намерена — вероятно вече е махната от друго работно място.');
      db.prepare('DELETE FROM links WHERE id = ?').run(id);
      logAudit('Краеведски връзки', 'махната връзка: ' + l.from_kind + ' „' + linkLabel(l.from_kind, l.from_id)
        + '“ → ' + l.to_kind + ' „' + linkLabel(l.to_kind, l.to_id) + '“');
    })
  );
  // Търсене на записи, към които да се направи връзка.
  ipcMain.handle('links:search', /** @param {unknown} e @param {IpcArg<'links:search'>} arg */ (e, { kind, q }) =>
    run(() => {
      const db = ensureKraeFunctions(getDb());
      const raw = String(q == null ? '' : q).trim();
      const like = bgLikeArg(raw);
      if (kind === 'книга') {
        /* ТЪРСЕНЕ ПО ИНВЕНТАРЕН НОМЕР (v2.4.61).
           ==============================================================
           Полето подсказва „заглавие, автор, инв. №…“, а инвентарният номер е
           начинът, по който библиотекарят намира документ от стара картотека.
           Дотук обаче представката „инв. №“ се разпознаваше САМО в прозореца
           „Аналитично описание“ (там на ръка се изрязваше с регулярен израз),
           а панелът „Свързани материали“ подаваше текста както си е — и
           „инв. № 2“ не намираше нищо. Обратно: когато се подаде само числото,
           LIKE '%1%' по заглавието връщаше и всяка книга, в чието заглавие има
           „1“ („100% истина…“), тоест точното питане даваше приблизителен
           отговор.
           Затова разпознаването е ТУК, в канала: и двата прозореца, и вносът, и
           второто работно място питат по един и същ начин. Изрично посочен
           инвентарен номер търси САМО по номер (празно е честен отговор); голо
           число първо опитва номера и чак ако няма такъв документ, пада обратно
           към заглавието — иначе „1985“ като година в заглавие не би се
           намирало. */
        const m = /^инв\.?\s*№?\s*(\d+)/i.exec(raw);
        const bare = /^\d+$/.test(raw);
        if (m || bare) {
          const rows = db.prepare(`${ROW_SQL['книга']} WHERE CAST(b.inv_number AS TEXT) = ?
            ORDER BY b.title LIMIT 40`).all(m ? m[1] : raw);
          if (rows.length || m) return rows.map(r => ({ id: r.id, label: labelOf('книга', r) }));
        }
        /* Отчислените ОСТАВАТ в резултата, но с белега. Да се скрият изглежда
           по-чисто и е по-лошо: библиотекарят, който търси по инвентарен номер
           от стара картотека, получава „няма такъв документ“ — същата задънена
           улица, която deaccessionActs:findBook вече веднъж отвори и после
           затвори (одит v2.4.25). По-добре го намира и вижда защо не става. */
        return db.prepare(`${ROW_SQL['книга']}
          WHERE bglower(b.title) LIKE ? ESCAPE '\\' OR bglower(b.author) LIKE ? ESCAPE '\\'
          ORDER BY b.title LIMIT 40`).all(like, like).map(r => ({ id: r.id, label: labelOf('книга', r) }));
      }
      if (kind === 'статия') {
        return db.prepare(`${ROW_SQL['статия']}
          WHERE bglower(a.title) LIKE ? ESCAPE '\\' OR bglower(a.author) LIKE ? ESCAPE '\\'
          ORDER BY a.year DESC, a.title LIMIT 40`).all(like, like).map(r => ({ id: r.id, label: labelOf('статия', r) }));
      }
      /* ЛЕТОПИСЪТ СЕ НАМИРА И ПО ГОДИНА (v2.4.71, находка Д16 от кръг 45).
         (а) ДОТУК търсачката „Свързани материали“ търсеше записите в летописа
         само по заглавие и текст — „1930“ не намираше „1930 — Построена е
         сградата…“, макар годината да стои първа в етикета, който полето
         показва. (б) Летописът е хронология и краеведът мисли по години: да
         свърже персоналия със „събитието от 1930 г.“ е точно питането, което не
         минаваше. (в) Годината (и датата — „24.05.1922“ се пише и така) влиза в
         търсенето; подредбата остава по година. */
      if (kind === 'летопис') {
        const bgDate = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
        const iso = bgDate ? bgDate[3] + '-' + bgDate[2].padStart(2, '0') + '-' + bgDate[1].padStart(2, '0') : null;
        return db.prepare(`${ROW_SQL['летопис']}
          WHERE bglower(c.title) LIKE ? ESCAPE '\\' OR bglower(c.body) LIKE ? ESCAPE '\\'
             OR bglower(c.year) LIKE ? ESCAPE '\\' OR c.date LIKE ? ESCAPE '\\' OR c.date = ?
          ORDER BY c.year DESC LIMIT 40`).all(like, like, like, like, iso).map(r => ({ id: r.id, label: labelOf('летопис', r) }));
      }
      if (kind === 'персона') {
        return db.prepare(`${ROW_SQL['персона']}
          WHERE bglower(p.name) LIKE ? ESCAPE '\\' OR bglower(p.alt_names) LIKE ? ESCAPE '\\'
          ORDER BY p.name LIMIT 40`).all(like, like).map(r => ({ id: r.id, label: labelOf('персона', r) }));
      }
      if (kind === 'периодика') {
        return db.prepare(`${ROW_SQL['периодика']}
          WHERE bglower(p.title) LIKE ? ESCAPE '\\' ORDER BY p.title LIMIT 40`)
          .all(like).map(r => ({ id: r.id, label: labelOf('периодика', r) }));
      }
      throw new Error('Непознат вид запис.');
    })
  );
};
