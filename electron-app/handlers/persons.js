// Краеведски модул: Персоналии — извадено от main.js в отделен модул
// (Фаза 4, стъпка 31). Зависи само от getDb, run, logAudit.
const { isValidIsoDate } = require('../security-utils');

/* Регистър на кирилицата и LIKE-заместителите в търсенето — ПЪЛНАТА бележка
   защо е така и защо не е FTS5 стои в handlers/chronicle.js (v2.4.61). Накратко:
   SQLite сравнява LIKE без оглед на регистъра само за латиница, затова „петров“
   не намираше „Петров, Георги Иванов“; а „%“ и „_“ в текста на търсенето са
   заместители за LIKE и връщаха цялата картотека. */
const KRAE_FN_READY = new WeakSet();
function ensureKraeFunctions(db) {
  if (KRAE_FN_READY.has(db)) return db;
  db.function('bglower', (s) => (s == null ? null : String(s).toLowerCase()));
  KRAE_FN_READY.add(db);
  return db;
}
function bgLikeArg(raw) {
  return '%' + String(raw == null ? '' : raw).toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
}

module.exports = function registerPersonsHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  const PERSON_FIELDS = ['name', 'alt_names', 'birth_date', 'birth_place', 'death_date', 'death_place',
    'activity', 'bio', 'awards', 'sources', 'note'];

  /* ДАТИТЕ НА ПЕРСОНАЛИЯТА СЕ ПРОВЕРЯВАТ (v2.4.61).
     =====================================================================
     Дотук в целия краеведски дял нямаше нито едно повикване на isValidIsoDate,
     докато фондът, заемането и актовете за отчисляване всички го правят.
     Затова „12.03.1890“ (българският изпис вместо ISO) влизаше в base-ата както
     си е — и оттам нататък persons:list го показваше като е, personDates() го
     подаваше на bg() и в картона стоеше безсмислица, а сортирането и справките
     по години на раждане мълчаливо го подминаваха.

     Второто, по-лошото: смърт ПРЕДИ раждане се приемаше без дума. Персоналията
     е краеведска СПРАВКА — тя се преписва в юбилейни издания, в читалищни
     летописи и в справки за читатели, а сгрешените дати оттам нататък живеят
     собствен живот. Библиотекарката, която е разменила двете полета, го разбира
     единствено ако някой забележи, че човекът е починал 10 години преди да се
     роди. Затова проверката е тук, на входа, а не в изгледа: през този канал
     минават и формата, и вносът от стара база, и второто работно място.

     Само НАЛИЧНИТЕ дати се проверяват — за краеведската картотека празната дата
     е нормалното състояние (годината на раждане на местен деец често е
     неизвестна), а сведението „починал 1961 г.“ без дата на раждане е валидно
     сведение. */
  function preparePerson(d) {
    const o = {};
    for (const f of PERSON_FIELDS) o[f] = d[f] ?? null;
    for (const [f, label] of [['birth_date', 'раждане'], ['death_date', 'смъртта']]) {
      const v = String(o[f] ?? '').trim();
      if (!v) { o[f] = null; continue; }
      if (!isValidIsoDate(v)) {
        throw new Error('„' + v + '“ не е валидна дата на ' + label + '. Въведете ден, месец и година '
          + '(напр. 12.03.1890) или оставете полето празно, ако датата не е известна.');
      }
      o[f] = v;
    }
    if (o.birth_date && o.death_date && o.death_date < o.birth_date) {
      throw new Error('Датата на смъртта (' + o.death_date + ') е преди датата на раждане ('
        + o.birth_date + '). Проверете дали двете дати не са разменени.');
    }
    if (!String(o.name ?? '').trim()) throw new Error('Името на персоналията е задължително.');
    return o;
  }

  ipcMain.handle('persons:list', (e, q) =>
    run(() => {
      // Броят на свързаните материали се показва в списъка, за да личи кои
      // персоналии вече имат подкрепящи документи във фонда.
      const db = ensureKraeFunctions(getDb());
      const sql = `
        SELECT p.*, (SELECT COUNT(*) FROM links l WHERE l.from_kind = 'персона' AND l.from_id = p.id) AS links
        FROM persons p ${q ? `WHERE bglower(p.name) LIKE @q ESCAPE '\\' OR bglower(p.alt_names) LIKE @q ESCAPE '\\'
          OR bglower(p.activity) LIKE @q ESCAPE '\\' OR bglower(p.bio) LIKE @q ESCAPE '\\'` : ''}
        ORDER BY p.name`;
      return db.prepare(sql).all(q ? { q: bgLikeArg(q) } : {});
    })
  );
  ipcMain.handle('persons:get', (e, id) => run(() => getDb().prepare('SELECT * FROM persons WHERE id = ?').get(id)));
  ipcMain.handle('persons:create', (e, d) =>
    run(() => {
      const o = preparePerson(d);
      const info = getDb().prepare(`INSERT INTO persons (${PERSON_FIELDS.join(', ')})
        VALUES (${PERSON_FIELDS.map(f => '@' + f).join(', ')})`).run(o);
      logAudit('Персоналии', 'нова персоналия: ' + (o.name || ''));
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('persons:update', (e, d) =>
    run(() => {
      const o = preparePerson(d);
      /* Липсващият ред е ОТКАЗ, а не тиха успешна редакция: при обща мрежова
         база записът може да е изтрит от другото работно място, а одитната
         следа не бива да твърди редакция, каквато не се е случвала. */
      const info = getDb().prepare(`UPDATE persons SET ${PERSON_FIELDS.map(f => f + ' = @' + f).join(', ')} WHERE id = @id`)
        .run({ ...o, id: d.id });
      if (!info.changes) throw new Error('Записът не е намерен — вероятно е изтрит от друго работно място.');
      logAudit('Персоналии', 'редакция: ' + (o.name || ''));
    })
  );
  ipcMain.handle('persons:delete', (e, id) =>
    run(() => {
      const db = getDb();
      const p = db.prepare('SELECT name FROM persons WHERE id = ?').get(id);
      db.transaction(() => {
        db.prepare("DELETE FROM links WHERE (from_kind = 'персона' AND from_id = ?) OR (to_kind = 'персона' AND to_id = ?)").run(id, id);
        db.prepare('DELETE FROM persons WHERE id = ?').run(id);
      }).immediate();
      logAudit('Персоналии', 'изтрита персоналия: ' + (p ? p.name : id));
    })
  );
};
