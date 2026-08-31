// Защита на лични данни: ЕГН / № лична карта (обща парола) — извадено от
// main.js в отделен модул (Фаза 4, стъпка 35). ЕГН и номер на лична карта
// на читателите могат да се защитят с обща парола (AES-256-GCM, виж
// pii-crypto.js) — една и съща парола на всички компютри, които ползват
// тази база данни, включително споделена мрежова база. Останалите данни за
// читателя (име, адрес, телефон, история на заемания) не са засегнати.
//
// Ключът (PDP_KEY) се пази само в паметта на текущия процес ("отключено" за
// тази сесия на програмата) — никога на диск, и е module-scope състояние тук
// (не се връща навън — само функциите, които го ползват, се връщат обратно).
//
// maskReaderRow/maskReaderRows/preparePiiForWrite се връщат обратно към
// main.js, защото handlers/readers.js (извадено по-рано, Фаза 4 стъпка 17)
// вече ги ползва по пряка референция в обект, подаден на неговия require(),
// който стои СЛЕД мястото на този модул в main.js — същият модел на връщане
// напред, установен за LOAN_SELECT/BOOK_SELECT.
module.exports = function registerPdpHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;
  const pii = require('../pii-crypto');

  let PDP_KEY = null;
  const PDP_PLACEHOLDER = 'Защитени данни';
  /* ОТДЕЛЕН плейсхолдър за „ключът е налице, но НЕ разчита стойността“.
     Одит v2.4.14, критична находка: при две работни места върху обща мрежова
     база станция Б отключва сутринта, станция А сменя паролата (базата се
     прекриптира с новия ключ), а ключът на Б остава в паметта ѝ и вече е
     ГРЕШЕН. decryptField() хвърля, старият код слагаше същия низ „Защитени
     данни“ — низ БЕЗ префикса PDPv1:, тоест за preparePiiForWrite чист текст.
     pdp:status междувременно продължаваше да казва unlocked:true, затова
     полетата ЕГН/№ ЛК стояха ОТКЛЮЧЕНИ за редакция; първият запис на този
     читател криптираше думите „Защитени данни“ със стария ключ ВЪРХУ
     истинското ЕГН. Нито една от двете пароли не го връща обратно.

     Три ключалки срещу това, всяка достатъчна сама по себе си:
       1. PDP_STALE — щом едно разкриптиране се провали, сесията се смята за
          негодна и pdp:status връща unlocked:false, тоест интерфейсът заключва
          полетата (виж pdpLocked в src/views/readers.js);
       2. preparePiiForWrite отказва да запише КОЙТО И ДА Е от двата
          плейсхолдъра, каквото и да е състоянието — пази предишната стойност;
       3. pdp:unlock проверява не само проверителя, но и че с този ключ наистина
          се разчита реален ред от базата (виж pdpDataReadable). */
  const PDP_UNREADABLE = 'Защитени данни (ключът не съвпада)';
  const PDP_PLACEHOLDERS = [PDP_PLACEHOLDER, PDP_UNREADABLE];
  let PDP_STALE = false;
  // Броят неразчетени полета, срещнати в тази сесия — служи само за диагностика
  // в pdp:status, за да може екранът да каже колко записа са засегнати.
  let unreadableSeen = 0;
  /* Минимална дължина на НОВА парола. Беше 4 знака — при сол и проверител, които
     стоят в самата база, а базата по документиран сценарий е на споделен мрежов
     дял, четиризначна парола се намира офлайн за секунди дори с по-скъпото
     извеждане на ключа (виж pii-crypto.js). Съществуващите пароли не се пипат:
     старите бази се отключват както преди, изискването важи само при задаване на
     нова и при смяна. */
  const PDP_MIN_PASSWORD = 10;
  /* Ключът и паролата се оставят и в общото състояние на сесията (pii-crypto.js),
     за да може автоматичното дневно копие да се криптира, докато защитата е
     отключена — виж autoBackupIfNeeded в handlers/backup.js. Само в паметта.
     Подава се и ПОВОДЪТ ('setup' / 'unlock' / 'change'): при СМЯНА на паролата
     днешното криптирано копие е останало със старата парола и трябва да се
     прекриптира — иначе копието от деня на смяната се отваря само с паролата,
     която библиотекарят е изоставил (или с компрометираната). */
  /* prevPassword се подава САМО при смяна и служи на едно-единствено място:
     handlers/backup.js прекриптира с него вече направените дневни копия, които
     иначе остават заключени с изоставената парола. Не се запазва никъде — стига
     до абонатите на pii.onSession и толкова. */
  function setPdpKey(password, key, reason, prevPassword) {
    PDP_KEY = key;
    pii.setSession(password, key, { reason, prevPassword });
  }
  function pdpSettingsRow() {
    return getDb().prepare('SELECT pdp_salt, pdp_verifier FROM settings WHERE id = 1').get() || {};
  }
  function pdpConfigured() {
    const s = pdpSettingsRow();
    return !!(s.pdp_salt && s.pdp_verifier);
  }
  // Прилага се към всеки читателски ред, преди да напусне main процеса: разкрипта
  // egn/id_card_no ако защитата е отключена в момента, показва плейсхолдър ако е
  // заключена, и оставя непроменени старите стойности в чист текст (инсталации,
  // които никога не са задавали тази защита — пълна обратна съвместимост).
  /* ЕДИН провален ред НЕ обявява сесията за негодна.

     Одит v2.4.16: предишната версия слагаше PDP_STALE при първия неуспех, а
     проверката при отключване (pdpDataReadable) нарочно ТОЛЕРИРА частична
     повреда, за да не заключи библиотекаря извън останалите записи. Двете се
     оказаха в противоречие и резултатът беше по-лош от изходния дефект:
     отключването успяваше, първото изчертаване на списъка срещаше единствения
     повреден ред, сесията умираше — и при следващото изчертаване ВСИЧКИ
     останали, напълно четими записи също излизаха с надпис „ключът не съвпада“.
     Заключването и отключването наново повтаряше цикъла безкрайно.

     Правилното разграничение е между двете различни причини:
       • ЕДИН ред не се чете → този ред е повреден или е дошъл от друг ключ.
         Показва се надписът само за него; сесията остава изправна. Полето е
         редактируемо — точно това е пътят за поправка: библиотекарят въвежда
         ЕГН-то наново и то се криптира с текущия, верен ключ. Плейсхолдърът не
         може да бъде записан (виж preparePiiForWrite).
       • ЦЯЛА партида не се чете и нито един ред не успява → ключът не отговаря
         на данните изобщо. Това е сценарият със сменена отвън парола и сесията
         се обявява за негодна. */
  /* Освен стойността, редът носи и `pii_masked: true`, когато поне едно поле е
     заменено с надпис вместо с истинска стойност. Одит на документите v2.4.17:
     читателският картон вмъкваше маскираната стойност право в реда „ЕГН:“ и
     печаташе буквално „Защитени данни“ на подписван документ — а заключеното
     състояние е НОРМАЛНОТО в началото на всеки работен ден. Флагът позволява на
     всеки консуматор да реагира, без да сравнява низове с продукционни
     константи, които живеят в този модул. */
  function maskOne(r, stats) {
    if (!r) return r;
    for (const f of ['egn', 'id_card_no']) {
      if (!pii.isEncryptedField(r[f])) continue;
      r.pii_masked = true;
      if (!PDP_KEY || PDP_STALE) { r[f] = PDP_KEY ? PDP_UNREADABLE : PDP_PLACEHOLDER; continue; }
      try { r[f] = pii.decryptField(r[f], PDP_KEY); if (stats) stats.ok++; delete r.pii_masked; }
      catch (e) {
        if (stats) stats.bad++;
        r[f] = PDP_UNREADABLE;
        r.pii_masked = true;
        unreadableSeen++;
      }
    }
    return r;
  }
  function maskReaderRow(r) { return maskOne(r, null); }
  function maskReaderRows(rows) {
    const stats = { ok: 0, bad: 0 };
    rows.forEach(r => maskOne(r, stats));
    /* Партида, в която НИТО ЕДИН криптиран ред не се разчита, а поне един е бил
       опитан — това е подписът на „ключът вече не отговаря на базата“. */
    if (stats.bad && !stats.ok) {
      PDP_STALE = true;
      logAudit('Защита на лични данни', 'ключът в тази сесия вече не разчита записаните ЕГН/№ ЛК — '
        + 'защитата е заключена автоматично; отключете отново с текущата парола');
    } else if (stats.bad) {
      /* Смесен резултат: конкретни повредени редове. Вписва се в одитната следа
         (а не само в дневника за грешки), защото библиотекарят трябва да разбере,
         че тези ЕГН-та са за въвеждане наново — иначе разбира чак при проверка. */
      logAudit('Защита на лични данни', stats.bad + ' записа не се разчитат с текущата парола и се показват '
        + 'като „' + PDP_UNREADABLE + '“ — стойностите им трябва да бъдат въведени наново');
    }
    return rows;
  }
  // Подготвя egn/id_card_no за запис. Ако защитата не е зададена изобщо — без
  // промяна (старо поведение, чист текст). Ако е зададена и отключена — криптира
  // новите стойности. Ако е зададена, но ЗАКЛЮЧЕНА в момента: при редакция се
  // пази предишната (криптирана) стойност непроменена, каквото и да е дошло от
  // интерфейса — тези полета там се показват само за четене, докато не се въведе
  // паролата, точно за да не презапишат криптирана стойност с плейсхолдъра. При
  // нов читател без предишен ред няма какво да се пази, затова се изисква
  // отключване, ако е въведено ЕГН/№ ЛК.
  function preparePiiForWrite(out, prev) {
    if (!pdpConfigured()) return;
    for (const f of ['egn', 'id_card_no']) {
      /* Ключалка №2 срещу критичната находка от одита: плейсхолдърът НЕ Е
         стойност и никога не се записва — нито в чист текст, нито криптиран.
         Каквото и да е дошло от интерфейса, ако е един от двата плейсхолдъра,
         остава предишната (криптирана) стойност. Проверката е ПРЕДИ всичко
         останало, за да важи и в трите състояния (отключено, заключено,
         негодна сесия). */
      if (PDP_PLACEHOLDERS.includes(out[f])) out[f] = prev ? prev[f] : null;
      if (PDP_KEY && !PDP_STALE) {
        if (out[f] && !pii.isEncryptedField(out[f])) out[f] = pii.encryptField(out[f], PDP_KEY);
      } else if (prev) {
        out[f] = prev[f];
      } else if (out[f]) {
        throw new Error(PDP_STALE
          ? 'Защитата на лични данни е отключена с ключ, който вече не отговаря на базата (паролата е сменена '
            + 'от друго работно място). Заключете и отключете отново с новата парола, за да запишете ЕГН/№ ЛК.'
          : 'Отключете защитата на лични данни от „Настройки“, за да запишете ЕГН/№ ЛК на нов читател.');
      }
    }
  }
  // Прекриптира всички съществуващи стойности egn/id_card_no с нов ключ — ползва
  // се и при първо задаване на паролата (стойностите тогава са в чист текст), и
  // при смяна на паролата (стойностите тогава вече са криптирани със стария
  // ключ). readKey е null, ако стойностите в момента са в чист текст.
  function reencryptAllReaders(readKey, writeKey) {
    const db = getDb();
    const rows = db.prepare(`SELECT id, egn, id_card_no FROM readers
      WHERE (egn IS NOT NULL AND egn <> '') OR (id_card_no IS NOT NULL AND id_card_no <> '')`).all();
    const upd = db.prepare('UPDATE readers SET egn = ?, id_card_no = ? WHERE id = ?');
    for (const r of rows) {
      const plainEgn = readKey ? pii.decryptField(r.egn, readKey) : r.egn;
      const plainIdc = readKey ? pii.decryptField(r.id_card_no, readKey) : r.id_card_no;
      upd.run(
        plainEgn ? pii.encryptField(plainEgn, writeKey) : plainEgn,
        plainIdc ? pii.encryptField(plainIdc, writeKey) : plainIdc,
        r.id
      );
    }
    return rows.length;
  }
  /* Ключалка №3: проверителят доказва само че паролата ражда ключа, с който е
     направен САМИЯТ проверител — не че този ключ разчита данните. Двете се
     разминават в два реални случая: (а) някой с достъп до споделената папка е
     подменил pdp_salt/pdp_verifier с двойка от своя парола (записите тогава
     остават криптирани със стария ключ и програмата „отключва“, без да чете
     нищо); (б) прекриптирането е прекъснато по средата. Затова при отключване
     се проверява и един истински ред. Липсата на криптирани редове (нова база,
     нищо още не е въведено) е нормална и минава. */
  function pdpDataReadable(key) {
    /* Проверяват се НЯКОЛКО реда и отказът е само когато НИТО ЕДИН не се чете.
       Първата версия гледаше един ред (LIMIT 1 без подредба, тоест най-малкия
       rowid) и това я правеше грешна и в двете посоки:
         • лъжлив отказ → библиотекарят се заключва завинаги извън собствените си
           данни, ако точно този ред е повреден (напр. презаписан от станция с
           остарял ключ, преди тази версия), докато останалите 499 са наред. А
           изход няма: старата парола вече не минава през проверителя;
         • лъжливо разрешение → прекъснато по средата прекриптиране оставя
           наред точно НАЧАЛНИТЕ редове (reencryptAllReaders върви по id), тоест
           единствената проверена стойност е от „добрата“ половина.
       Редовете се вземат от двата края на подредбата, за да покрият и двата
       случая. */
    const rows = getDb().prepare(`SELECT egn, id_card_no FROM readers
      WHERE egn LIKE 'PDPv1:%' OR id_card_no LIKE 'PDPv1:%'
      ORDER BY id LIMIT 25`).all().concat(
      getDb().prepare(`SELECT egn, id_card_no FROM readers
        WHERE egn LIKE 'PDPv1:%' OR id_card_no LIKE 'PDPv1:%'
        ORDER BY id DESC LIMIT 25`).all());
    if (!rows.length) return true;
    let readable = 0, unreadable = 0;
    let skipped = 0;
    for (const r of rows) {
      const v = pii.isEncryptedField(r.egn) ? r.egn : r.id_card_no;
      /* Заявката по-горе ползва LIKE, който в SQLite е нечувствителен към
         регистъра за ASCII, а isEncryptedField сравнява ТОЧНО с „PDPv1:“.
         Стойност, записана като „pdpv1:…“, минава филтъра и пропада тук — а
         старият код връщаше „всичко е наред“ именно когато не е разбрал нищо. */
      if (!pii.isEncryptedField(v)) { skipped++; continue; }
      try { pii.decryptField(v, key); readable++; } catch (e) { unreadable++; }
    }
    if (skipped && !readable && !unreadable) return false; // разгледани редове, разбран нито един
    if (readable) {
      // Част от редовете не се четат — това е повреда в ДАННИТЕ, не грешна парола.
      // Отключва се (иначе няма достъп до останалите), но се вписва в дневника.
      if (unreadable) {
        logAudit('Защита на лични данни', unreadable + ' от проверените ' + (readable + unreadable)
          + ' записа не се разчитат с тази парола — стойностите им трябва да бъдат въведени наново');
      }
      return true;
    }
    return unreadable === 0;
  }
  ipcMain.handle('pdp:status', () =>
    // unlocked:false при негодна сесия — интерфейсът заключва полетата ЕГН/№ ЛК
    // (виж pdpLocked в src/views/readers.js) вместо да ги остави за редакция с
    // плейсхолдър вътре. `stale` е отделно, за да може екранът да обясни защо.
    run(() => ({ configured: pdpConfigured(), unlocked: !!PDP_KEY && !PDP_STALE, stale: PDP_STALE, unreadable: unreadableSeen }))
  );
  ipcMain.handle('pdp:setup', (e, password) =>
    run(() => {
      const db = getDb();
      if (!password || String(password).length < PDP_MIN_PASSWORD) {
        throw new Error('Паролата трябва да е поне ' + PDP_MIN_PASSWORD + ' знака.');
      }
      if (pdpConfigured()) throw new Error('Защитата вече е зададена — за смяна на паролата ползвайте смяната на паролата.');
      // Новите соли носят версията на параметрите на scrypt (виж pii-crypto.js).
      const salt = pii.generateSalt(pii.CURRENT_KDF_VERSION);
      const key = pii.deriveKey(password, salt);
      const verifier = pii.makeVerifier(key);
      let n = 0;
      db.transaction(() => {
        db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
          .run(salt.toString('base64'), verifier);
        n = reencryptAllReaders(null, key);
      }).immediate();
      setPdpKey(password, key, 'setup');
      logAudit('Защита на лични данни', 'зададена е парола за защита на ЕГН/№ ЛК (' + n + ' читатели засегнати)');
      return true;
    })
  );
  ipcMain.handle('pdp:unlock', (e, password) =>
    run(() => {
      const s = pdpSettingsRow();
      if (!s.pdp_salt || !s.pdp_verifier) throw new Error('Защитата не е зададена.');
      const salt = Buffer.from(s.pdp_salt, 'base64');
      const key = pii.deriveKey(password, salt);
      if (!pii.checkVerifier(s.pdp_verifier, key)) throw new Error('Грешна парола.');
      if (!pdpDataReadable(key)) {
        throw new Error('Паролата отваря защитата, но записаните ЕГН/№ ЛК са криптирани с ДРУГ ключ и не могат да '
          + 'бъдат разчетени с нея. Това означава, че настройките на защитата в базата са променени отделно от самите '
          + 'данни — например от друго работно място или чрез редакция на файла. Защитата остава заключена, за да не '
          + 'бъдат презаписани данните. Опитайте с предишната парола; ако и тя не помогне, възстановете резервно копие.');
      }
      PDP_STALE = false;
      unreadableSeen = 0;
      setPdpKey(password, key, 'unlock');
      /* Старите инсталации не се прекриптират сами: база отпреди v2 си остава на
         по-евтините параметри, а изискването за 10 знака важи само при ЗАДАВАНЕ
         на нова парола — предишният минимум беше 4. Комбинацията „кратка парола
         + евтин ключ“ на споделен дял се търси офлайн за минути, затова тук се
         връща подсказка, а екранът я показва веднъж. Само подсказка: насилствена
         смяна би заключила библиотекаря извън собствените му данни. */
      const weak = pii.saltVersion(salt) < pii.CURRENT_KDF_VERSION || String(password).length < PDP_MIN_PASSWORD;
      return weak
        ? { ok: true, advise: 'Тази парола е зададена по стария, по-слаб ред. Сменете я от „Настройки“ → „Лични данни“ '
            + '— новата ще бъде с по-силна защита (поне ' + PDP_MIN_PASSWORD + ' знака).' }
        : true;
    })
  );
  ipcMain.handle('pdp:lock', () => run(() => { PDP_KEY = null; PDP_STALE = false; unreadableSeen = 0; pii.clearSession(); }));
  ipcMain.handle('pdp:changePassword', (e, { oldPassword, newPassword } = {}) =>
    run(() => {
      const db = getDb();
      const s = pdpSettingsRow();
      if (!s.pdp_salt || !s.pdp_verifier) throw new Error('Защитата не е зададена.');
      if (!newPassword || String(newPassword).length < PDP_MIN_PASSWORD) {
        throw new Error('Новата парола трябва да е поне ' + PDP_MIN_PASSWORD + ' знака.');
      }
      const oldKey = pii.deriveKey(oldPassword, Buffer.from(s.pdp_salt, 'base64'));
      if (!pii.checkVerifier(s.pdp_verifier, oldKey)) throw new Error('Текущата парола е грешна.');
      // Смяната на паролата вдига и версията на параметрите на scrypt — стара
      // база минава на по-скъпото извеждане на ключа без отделна миграция.
      const newSalt = pii.generateSalt(pii.CURRENT_KDF_VERSION);
      const newKey = pii.deriveKey(newPassword, newSalt);
      const newVerifier = pii.makeVerifier(newKey);
      db.transaction(() => {
        db.prepare('UPDATE settings SET pdp_salt = ?, pdp_verifier = ? WHERE id = 1')
          .run(newSalt.toString('base64'), newVerifier);
        reencryptAllReaders(oldKey, newKey);
      }).immediate();
      // Новият ключ е току-що изведен и е верен по построение — сесията вече не е
      // негодна. Без този ред успешната смяна оставяше всяко ЕГН с надпис
      // „ключът не съвпада“ и мълчаливо отхвърляше всяка редакция.
      PDP_STALE = false;
      unreadableSeen = 0;
      setPdpKey(newPassword, newKey, 'change', oldPassword);
      logAudit('Защита на лични данни', 'паролата за защита на ЕГН/№ ЛК е сменена');
      return true;
    })
  );

  return { maskReaderRow, maskReaderRows, preparePiiForWrite };
};
