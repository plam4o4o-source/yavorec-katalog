// Онлайн каталог (публикуване през GitHub) + експорт в библиотечни формати —
// извадени от main.js в отделен модул (Фаза 4, стъпка 32). Изнасят се само
// библиографски данни и наличност — никога читатели, цени или служебни
// бележки. Свързаната папка е работно копие (git clone) на GitHub
// хранилището, от което сайтът чете каталога чрез raw.githubusercontent.com.
//
// scheduleCatalogWrite/flushCatalogWrite/buildCatalogPayload НЕ са тук —
// умишлено остават hoisted в main.js (виж коментара там), защото по-рано
// извадени модули (deaccession-acts.js, loans.js) вече ги ползват по пряка
// референция в обекта, подаден на техния require(), който се изпълнява
// ПРЕДИ мястото на този require() — преместването им тук би било същият
// TDZ капан като при logEvent.
//
// startAutoPushTimer/stopAutoPushTimer се връщат обратно към main.js,
// защото app.whenReady()/window-all-closed ги викат — но само вътре в
// отложени callback-и, не веднага при зареждане, така че редът тук е
// без значение (за разлика от scheduleCatalogWrite по-горе).
module.exports = function registerCatalogHandlers(ipcMain, deps) {
  const {
    getDb, run, logAudit, dialog, getMainWindow, fs, path, execFile,
    BOOK_SELECT, csvCell, flushCatalogWrite, buildCatalogPayload
  } = deps;

  function gitRun(folder, args) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: folder, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
        resolve({ ok: !error, code: error ? error.code : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      });
    });
  }
  function isGitRepo(folder) {
    return folder && fs.existsSync(path.join(folder, '.git'));
  }
  // Разчита "потребител/хранилище" от адреса на origin — и за https, и за ssh адрес.
  async function gitRemoteSlug(folder) {
    if (!isGitRepo(folder)) return null;
    // Нарочно се чете суровата стойност от конфигурацията, а не "git remote get-url":
    // второто прилага правилата url.<база>.insteadOf и може да върне пренаписан адрес,
    // който вече не показва към кое хранилище в GitHub сочи папката.
    const r = await gitRun(folder, ['config', '--get', 'remote.origin.url']);
    if (!r.ok || !r.stdout) return null;
    const m = r.stdout.match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
    return m ? { user: m[1], repo: m[2], url: r.stdout } : { user: '', repo: '', url: r.stdout };
  }
  // Пази всяка библиотека да не публикува в чуждо хранилище: сравнява къде наистина сочи
  // папката с това, което е записано в настройките. Точно това е случаят, при който един
  // каталог може да бъде презаписан с данните на друга библиотека.
  async function catalogRemoteCheck(folder, s) {
    const slug = await gitRemoteSlug(folder);
    const u = (s.gh_user || '').trim(), r = (s.gh_repo || '').trim();
    if (!slug || !slug.user || !u || !r) return { slug, mismatch: false };
    const mismatch = slug.user.toLowerCase() !== u.toLowerCase() || slug.repo.toLowerCase() !== r.toLowerCase();
    return { slug, mismatch };
  }
  async function gitPublish(folder) {
    if (!isGitRepo(folder)) return { ok: false, error: 'Папката не е git хранилище (липсва .git). Клонирайте хранилището с "git clone" веднъж, преди да я свържете тук.' };

    const db = getDb();
    const s = db.prepare('SELECT gh_user, gh_repo FROM settings WHERE id = 1').get() || {};
    const chk = await catalogRemoteCheck(folder, s);
    if (chk.mismatch) {
      return { ok: false, error: 'Спряно: свързаната папка сочи към хранилището ' +
        chk.slug.user + '/' + chk.slug.repo + ', а в настройките е записано ' +
        (s.gh_user || '—') + '/' + (s.gh_repo || '—') +
        '. Публикуването е спряно, за да не се презапише чужд каталог. ' +
        'Проверете дали сте клонирали собственото си хранилище.' };
    }

    const branchRes = await gitRun(folder, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchRes.ok && branchRes.stdout ? branchRes.stdout : 'main';

    /* Локална самоличност ПРЕДИ първия commit. Одит v2.4.14: на свеж компютър
       без глобална git конфигурация `git commit` отказва и връща собствения си
       текст за user.email — съобщение, което стига до библиотекаря дословно,
       звучи като счупена програма и не се оправя от само себе си при следващите
       опити. Стойностите са локални за работното копие (--local), не пипат нищо
       друго на компютъра, и се задават само ако липсват. */
    const who = await gitRun(folder, ['config', '--local', '--get', 'user.email']);
    if (!who.ok || !who.stdout) {
      await gitRun(folder, ['config', '--local', 'user.email', 'invlib@localhost']);
      await gitRun(folder, ['config', '--local', 'user.name', 'InvLib']);
    }
    const add = await gitRun(folder, ['add', 'katalog.json']);
    if (!add.ok) return { ok: false, error: 'git add: ' + (add.stderr || 'грешка') };
    const commit = await gitRun(folder, ['commit', '-m', 'Автоматично обновяване на каталога — ' + new Date().toISOString()]);
    if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      return { ok: false, error: 'git commit: ' + (commit.stderr || commit.stdout || 'грешка') };
    }

    let push = await gitRun(folder, ['push', '-u', 'origin', branch]);

    // Отхвърлен push (non-fast-forward) означава, че хранилището е било обновено отдругаде —
    // друг работен компютър, който също публикува каталога, или промяна направена в GitHub.
    // Това е нормално, а не грешка: изтегляме новото състояние, пренасяме нашия commit върху
    // него и опитваме пак. При разминаване в katalog.json печели нашата версия, защото файлът
    // е изцяло генериран от тази база данни — няма ръчни редакции, които да се загубят.
    if (!push.ok && /rejected|non-fast-forward|fetch first|behind/i.test(push.stderr)) {
      const fetch = await gitRun(folder, ['fetch', 'origin', branch]);
      if (!fetch.ok) return { ok: false, error: 'git fetch: ' + (fetch.stderr || 'грешка при изтегляне от GitHub') };

      const rebase = await gitRun(folder, ['rebase', '-X', 'theirs', 'origin/' + branch]);
      if (!rebase.ok) {
        await gitRun(folder, ['rebase', '--abort']);
        return { ok: false, error: 'Хранилището е обновено отдругаде и промените не можаха да се обединят ' +
          'автоматично. Отворете папката на хранилището и изпълнете „git pull“ ръчно, после опитайте пак. ' +
          '(' + (rebase.stderr || rebase.stdout || '') + ')' };
      }
      push = await gitRun(folder, ['push', 'origin', branch]);
    }

    if (!push.ok) return { ok: false, error: 'git push: ' + (push.stderr || 'грешка — проверете интернет връзката и удостоверяването пред GitHub') };
    return { ok: true, committed: commit.ok };
  }
  /* Последният провал на автоматичното публикуване, за да може интерфейсът да го
     покаже. Дотук грешката отиваше САМО в конзолата — а в готово приложение никой
     не отваря конзоли: изтекъл токен или разместено хранилище спираха публикуването
     завинаги, докато екранът продължаваше да обещава обновяване на всеки 5 минути.
     Онлайн каталогът можеше да остане замръзнал с месеци, без никой да разбере. */
  let LAST_AUTO_PUSH = { at: null, error: null, okAt: null };
  function noteAutoPush(error) {
    const now = new Date().toISOString();
    LAST_AUTO_PUSH.at = now;
    LAST_AUTO_PUSH.error = error || null;
    if (!error) LAST_AUTO_PUSH.okAt = now;
  }
  let AUTO_PUSH_TIMER = null;
  function startAutoPushTimer() {
    if (AUTO_PUSH_TIMER) return;
    AUTO_PUSH_TIMER = setInterval(async () => {
      try {
        const s = getDb().prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
        if (!s || !s.catalog_folder || !isGitRepo(s.catalog_folder)) {
          // Папката вече не е свързана — няма какво да се публикува, значи няма и
          // за какво да предупреждаваме. Иначе червената лента оставаше завинаги
          // за каталог, който вече не се публикува изобщо.
          noteAutoPush(null);
          return;
        }
        const r = await gitPublish(s.catalog_folder);
        if (r.ok && r.committed) {
          console.log('Автоматично публикувано в GitHub:', s.catalog_folder);
          noteAutoPush(null);
        } else if (r.ok) {
          noteAutoPush(null); // нямало е промяна за публикуване — това е успех
        } else {
          console.error('Автоматично публикуване в GitHub — грешка:', r.error);
          noteAutoPush(r.error);
          logAudit('Онлайн каталог', 'автоматичното публикуване се провали: ' + r.error);
        }
      } catch (err) {
        console.error('Автоматично публикуване в GitHub — грешка:', err.message);
        noteAutoPush(err.message);
      }
    }, 5 * 60 * 1000);
  }
  // Изгледът „Онлайн каталог“ пита оттук и показва предупреждение, ако последният
  // опит е бил неуспешен.
  ipcMain.handle('catalog:autoPushStatus', () => run(() => LAST_AUTO_PUSH));
  function stopAutoPushTimer() {
    if (AUTO_PUSH_TIMER) { clearInterval(AUTO_PUSH_TIMER); AUTO_PUSH_TIMER = null; }
  }
  function ghRawUrl(s) {
    const u = (s.gh_user || '').trim(), r = (s.gh_repo || '').trim(), b = (s.gh_branch || 'main').trim() || 'main';
    if (!u || !r) return null;
    return `https://raw.githubusercontent.com/${u}/${r}/${b}/katalog.json`;
  }
  // Предлага име на хранилище по името на библиотеката — на латиница, с тирета, защото
  // GitHub не приема кирилица и интервали в имената на хранилища.
  const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sht',ъ:'a',ь:'',ю:'yu',я:'ya' };
  function suggestRepoName(s) {
    const base = (s.lib_name || s.org || '').toLowerCase()
      .replace(/[а-я]/g, c => (c in TRANSLIT ? TRANSLIT[c] : c))
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
    const short = base.split('-').filter(w => w.length > 2).slice(0, 4).join('-');
    return (short || 'biblioteka') + '-katalog';
  }

  ipcMain.handle('catalog:status', () =>
    run(() => {
      const db = getDb();
      const s = db.prepare('SELECT catalog_folder, gh_user, gh_repo, gh_branch, lib_name, org FROM settings WHERE id = 1').get();
      /* Каталожният домейн НАРОЧНО е консервативен и НЕ ползва NULL-безопасната
         форма, за разлика от Таблото и справките: документ с непознат статус
         (внос отпреди enum тригера) НЕ се публикува навън — по-добре да липсва
         от публичния каталог, отколкото сайтът да го обяви за наличен и читател
         да дойде за книга, чието състояние никой не знае. Тази проверка стои и в
         самия износ (buildCatalogPayload в main.js) и в двете броячки тук —
         трите ТРЯБВА да са еднакви, иначе екранът обещава повече записи,
         отколкото файлът съдържа. Виж test/main-catalog-norms.test.js. */
      const pub = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен' AND COALESCE(department,'') != 'служебен'`).get().n;
      /* `b.status = 'наличен'` — дословно същото условие, което слага флага „налична"
         в изнесения файл (publicBookFields в main.js: `b.available > 0 &&
         b.status === 'наличен'`). Дотук тук се броеше само по свободни бройки:
         документ със статус „липсващ“ или „за реставрация“ няма отворено заемане,
         тоест излизаше „наличен“ на екрана, а в каталога — не. Екранът обещаваше
         повече зелени етикети, отколкото сайтът показва. */
      const avail = db.prepare(`
        SELECT COUNT(*) AS n FROM books b WHERE b.status = 'наличен' AND COALESCE(b.department,'') != 'служебен'
        AND COALESCE((SELECT i.quantity FROM inventory i WHERE i.book_id=b.id),0) >
            (SELECT COUNT(*) FROM loans l WHERE l.book_id=b.id AND l.date_in IS NULL)
      `).get().n;
      return {
        folder: s.catalog_folder || null, total: pub, available: avail,
        isGitRepo: isGitRepo(s.catalog_folder), rawUrl: ghRawUrl(s),
        ghUser: s.gh_user, ghRepo: s.gh_repo, ghBranch: s.gh_branch,
        suggestedRepo: suggestRepoName(s), libName: s.lib_name || s.org || ''
      };
    })
  );
  // Проверява накъде наистина сочи свързаната папка. Извиква се от интерфейса, за да се
  // покаже предупреждение, преди да се стигне до публикуване.
  ipcMain.handle('catalog:remoteCheck', async () => {
    try {
      const s = getDb().prepare('SELECT catalog_folder, gh_user, gh_repo FROM settings WHERE id = 1').get() || {};
      if (!s.catalog_folder) return { ok: true, data: null };
      const chk = await catalogRemoteCheck(s.catalog_folder, s);
      return { ok: true, data: { mismatch: chk.mismatch, remote: chk.slug } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('catalog:updateGh', (e, { gh_user, gh_repo, gh_branch }) =>
    run(() => {
      getDb().prepare('UPDATE settings SET gh_user=?, gh_repo=?, gh_branch=? WHERE id=1')
        .run((gh_user || '').trim(), (gh_repo || '').trim(), (gh_branch || 'main').trim() || 'main');
    })
  );
  ipcMain.handle('catalog:chooseFolder', async () => {
    try {
      const db = getDb();
      const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Изберете локалното работно копие (git clone) на GitHub хранилището с каталога',
        properties: ['openDirectory', 'createDirectory']
      });
      if (canceled || !filePaths[0]) return { ok: false, error: 'Отказано от потребителя.' };
      const folder = filePaths[0];
      db.prepare('UPDATE settings SET catalog_folder = ? WHERE id = 1').run(folder);

      // Ако потребителят и хранилището още не са попълнени, се вземат от самата папка —
      // така новата библиотека получава своите настройки, без да ги въвежда на ръка.
      const s = db.prepare('SELECT gh_user, gh_repo FROM settings WHERE id = 1').get() || {};
      const chk = await catalogRemoteCheck(folder, s);
      let adopted = null;
      if (chk.slug && chk.slug.user && !(s.gh_user || '').trim() && !(s.gh_repo || '').trim()) {
        db.prepare('UPDATE settings SET gh_user = ?, gh_repo = ? WHERE id = 1').run(chk.slug.user, chk.slug.repo);
        adopted = chk.slug;
      }

      flushCatalogWrite();
      logAudit('Онлайн каталог', 'папка за автоматичен запис: ' + folder);
      return { ok: true, data: folder, adopted, mismatch: chk.mismatch, remote: chk.slug };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('catalog:disconnectFolder', () =>
    run(() => { getDb().prepare('UPDATE settings SET catalog_folder = NULL WHERE id = 1').run(); })
  );
  // Одит v2.3.1 №8: и двата канала по-долу проверяваха САМО `w.blocked`, а не
  // `w.written` — реален провал на самия запис (напр. изключен мрежов диск:
  // ENOENT) минаваше за успех. `writeCatalogIfConfigured()` (main.js) вече
  // връща `error` с причината в такъв случай — тук се проверява и се показва.
  function assertCatalogWriteOk(w) {
    if (w.blocked) {
      throw new Error('Спряно: фондът в тази база данни излиза празен, а публикуваният каталог не е — за да публикувате наистина празен каталог, използвайте „Ръчно извеждане“.');
    }
    if (!w.written) {
      throw new Error('Записът на каталога не успя' + (w.error ? ': ' + w.error : '.') +
        ' Проверете дали папката е достъпна (свързан ли е мрежовият диск?).');
    }
  }
  ipcMain.handle('catalog:gitPublishNow', async () => {
    const s = getDb().prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
    if (!s || !s.catalog_folder) return { ok: false, error: 'Първо изберете папка (git clone на хранилището).' };
    const w = flushCatalogWrite();
    try { assertCatalogWriteOk(w); }
    catch (err) { noteAutoPush(err.message); return { ok: false, error: err.message }; }
    const r = await gitPublish(s.catalog_folder);
    if (r.ok) logAudit('Онлайн каталог', 'публикувано в GitHub' + (r.committed ? '' : ' (нямаше промяна)'));
    /* И ръчното публикуване обновява състоянието — иначе предупреждението за
       провалено автоматично публикуване продължава да твърди, че каталогът на
       сайта е стар, точно след като библиотекарят го е публикувал по бутона,
       който самото предупреждение му препоръчва. */
    noteAutoPush(r.ok ? null : r.error);
    return r;
  });
  ipcMain.handle('catalog:writeNow', () =>
    run(() => {
      const s = getDb().prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
      if (!s || !s.catalog_folder) throw new Error('Първо изберете папка за автоматичен запис.');
      const w = flushCatalogWrite();
      assertCatalogWriteOk(w);
      return true;
    })
  );

  /* ---------------- Експорт в библиотечни формати ----------------
     UNIMARC/MARCXML и Dublin Core. Целта е данните да не са заключени в тази
     програма: при преминаване към COBISS или към сводния каталог се подава файл,
     вместо да се преписват записите на ръка. */
  const xesc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Управляващите знаци правят XML файла невалиден и някои редактори го отхвърлят
    // изцяло; табулация, нов ред и връщане на каретката са допустими и се пазят.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const LANG_ISO = {
    'български': 'bul', 'английски': 'eng', 'руски': 'rus', 'немски': 'ger', 'френски': 'fre',
    'испански': 'spa', 'италиански': 'ita', 'турски': 'tur', 'гръцки': 'gre', 'румънски': 'rum',
    'сръбски': 'srp', 'македонски': 'mac', 'полски': 'pol', 'чешки': 'cze', 'украински': 'ukr'
  };
  // „Вазов, Иван“ → фамилия $a + име $b, както изисква UNIMARC 700.
  function splitName(name) {
    const s = String(name || '').trim();
    if (!s) return null;
    const i = s.indexOf(',');
    if (i > 0) return { a: s.slice(0, i).trim(), b: s.slice(i + 1).trim() };
    const w = s.split(/\s+/);
    return w.length > 1 ? { a: w[w.length - 1], b: w.slice(0, -1).join(' ') } : { a: s, b: '' };
  }
  /* Контролният номер на записа (UNIMARC 001) трябва да е УНИКАЛЕН в рамките на
     файла — приемащата система отхвърля или, по-лошо, презаписва запис с вече
     срещнат 001. Дотук беше `b.inv_number ?? b.id`: инвентарният номер е UNIQUE в
     схемата, но при документ БЕЗ инвентарен номер се падаше обратно към вътрешния
     rowid, който спокойно може да съвпадне с нечий чужд инвентарен номер (книга с
     инв. № 7 и некаталогизиран запис с id 7 дават два записа с 001 = 7).
     Затова резервният номер носи представка, каквато инвентарен номер няма как да
     има (колоната е INTEGER). Същото важи и за dc:identifier. */
  function recordId(b) {
    return (b.inv_number === null || b.inv_number === undefined || b.inv_number === '')
      ? 'invlib-id-' + b.id : String(b.inv_number);
  }
  function marcRecord(b, s) {
    const df = [];
    const add = (tag, i1, i2, subs) => {
      const parts = subs.filter(([, v]) => String(v ?? '').trim() !== '');
      if (!parts.length) return;
      df.push(`    <datafield tag="${tag}" ind1="${i1}" ind2="${i2}">\n` +
        parts.map(([c, v]) => `      <subfield code="${c}">${xesc(v)}</subfield>`).join('\n') +
        `\n    </datafield>`);
    };
    if (b.isbn) add('010', ' ', ' ', [['a', b.isbn]]);
    /* 101$a е КОДИРАНО поле — трибуквен код по ISO 639-2. Дотук непознат за
       таблицата език влизаше дословно („японски“), тоест файлът съдържаше кодирано
       поле с некодирана стойност и валидиращите системи го отхвърлят. Непознатият
       език става `und` (undetermined), а оригиналното наименование се пази в обща
       бележка 300, за да не се загуби. */
    const langCode = b.language ? (LANG_ISO[b.language] || 'und') : '';
    if (langCode) add('101', '0', ' ', [['a', langCode]]);
    // $h е „номер на част“ — томът на многотомно издание. Дотук той пътуваше в
    // поле 225 ($v) БЕЗ задължителното $a, тоест като поредица без заглавие.
    add('200', '1', ' ', [['a', b.title], ['e', b.subtitle], ['f', b.author], ['h', b.volume]]);
    add('210', ' ', ' ', [['a', b.city], ['c', b.publisher], ['d', b.year]]);
    add('215', ' ', ' ', [['a', b.pages]]);
    // 225 = заявка за поредица. $a (заглавие на поредицата) е задължително, затова
    // полето се строи само когато поредица наистина има.
    if (b.series) add('225', ' ', ' ', [['a', b.series], ['v', b.series_no]]);
    if (b.language && langCode === 'und') add('300', ' ', ' ', [['a', 'Език: ' + b.language]]);
    add('330', ' ', ' ', [['a', b.annotation]]);
    for (const kw of String(b.keywords || '').split(/[,;]/).map(s2 => s2.trim()).filter(Boolean)) {
      add('606', ' ', ' ', [['a', kw]]);
    }
    add('675', ' ', ' ', [['a', b.udk]]);
    const n = splitName(b.author);
    if (n) add('700', ' ', '1', [['a', n.a], ['b', n.b]]);
    /* 801 (Източник на записа) е задължително поле в UNIMARC и дотук липсваше
       изцяло: приемащата система нямаше как да разбере от коя библиотека идват
       записите — при сводния каталог това е точно въпросът, на който файлът трябва
       да отговори. $a страна, $b агенция (библиотеката), $c дата на обработката,
       $g правила за каталогизация. */
    const agency = ((s || {}).lib_name || (s || {}).org || '').trim();
    /* $c е дата в ОСНОВНАТА форма по ISO 8601 — YYYYMMDD, без тирета (одит v2.4.18).
       Дотук се изнасяше „2026-09-01“: стриктният валидатор — същият, заради който
       полето 801 изобщо беше добавено — отхвърля точно него. */
    add('801', ' ', '0', [['a', 'BG'], ['b', agency],
      ['c', new Date().toISOString().slice(0, 10).replace(/-/g, '')], ['g', 'unimarc']]);
    // 995 е полето за екземпляри в българската практика (COMARC).
    add('995', ' ', ' ', [['f', b.inv_number], ['d', b.department], ['k', b.call_number],
      ['o', b.category_name], ['r', b.status]]);
    return `  <record>\n` +
      `    <leader>     nam  22     3a 4500</leader>\n` +
      `    <controlfield tag="001">${xesc(recordId(b))}</controlfield>\n` +
      df.join('\n') + `\n  </record>`;
  }
  function buildMarcXml(books, s) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!-- UNIMARC в MARCXML структура. Изведено от библиотечна система „InvLib“. -->\n` +
      `<collection xmlns="http://www.loc.gov/MARC21/slim">\n` +
      books.map(b => marcRecord(b, s)).join('\n') + `\n</collection>\n`;
  }
  function buildDublinCore(books, s) {
    const rec = (b) => {
      const el = [];
      const put = (t, v) => { if (String(v ?? '').trim() !== '') el.push(`      <dc:${t}>${xesc(v)}</dc:${t}>`); };
      put('title', [b.title, b.subtitle].filter(Boolean).join(': '));
      put('creator', b.author);
      put('publisher', b.publisher);
      put('date', b.year);
      /* Същото правило като при UNIMARC 101 $a (одит v2.4.18: поправката там беше
         направена, а тук — не). dc:language е КОДИРАНО поле по препоръката на Dublin
         Core (ISO 639); „японски“ в него е неразчитаемо за приемащата система, която
         подрежда по код. Непознат език → `und`, а самото наименование се пази в
         бележка, за да не се губи сведението. */
      put('language', b.language ? (LANG_ISO[b.language] || 'und') : '');
      if (b.language && !LANG_ISO[b.language]) put('description', 'Език по описание: ' + b.language);
      put('description', b.annotation);
      put('type', b.category_name || 'text');
      put('format', b.pages);
      put('identifier', b.isbn ? 'ISBN ' + b.isbn : '');
      // Същата представка като при UNIMARC 001 — иначе документ без инвентарен
      // номер получава „inv:<rowid>“, който може да съвпадне с чужд инвентарен номер.
      put('identifier', 'inv:' + recordId(b));
      put('coverage', b.city);
      put('rights', s.lib_name || s.org || '');
      for (const kw of String(b.keywords || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)) put('subject', kw);
      if (b.udk) put('subject', 'УДК ' + b.udk);
      return `    <record>\n${el.join('\n')}\n    </record>`;
    };
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
      books.map(rec).join('\n') + `\n</metadata>\n`;
  }
  /* Изнасяните навън записи следват СЪЩИТЕ изключения като онлайн каталога
     (buildCatalogPayload в main.js и двете броячки в catalog:status): без
     отчислени и без служебния отдел. Дотук UNIMARC и Dublin Core изнасяха ЦЯЛАТА
     таблица: сводният каталог получаваше записи за документи, които библиотеката
     вече не притежава (чл. 30 – 39 ги е отчислила), плюс служебните екземпляри,
     които никога не се предлагат на читател. Дотук числото в потвърждението
     („N записа") също броеше тях. */
  /* NULL-безопасно, за разлика от каталожния домейн по-горе, и това е съзнателна
     разлика: онлайн каталогът обещава наличност пред читател и там непознат статус
     основателно се пази вътре, а тук файлът е ПРЕНОС на записи към COBISS или към
     сводния каталог — да се изгуби запис при мигриране, защото статусът му е NULL
     (внесена база отпреди enum тригера), е по-тежко от това да пътува със статус,
     който приемащата система вижда дословно в 995$r. */
  const EXPORT_WHERE = `WHERE COALESCE(b.status,'') != 'отчислен' AND COALESCE(b.department,'') != 'служебен'`;
  function exportBooksFor() {
    return getDb().prepare(`${BOOK_SELECT} ${EXPORT_WHERE} ORDER BY b.inv_number`).all();
  }
  function exportExcludedCount() {
    return getDb().prepare(`SELECT COUNT(*) AS n FROM books b
      WHERE COALESCE(b.status,'') = 'отчислен' OR COALESCE(b.department,'') = 'служебен'`).get().n;
  }
  ipcMain.handle('catalog:exportMarc', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Извеждане в UNIMARC / MARCXML',
        defaultPath: 'fond-unimarc.xml',
        filters: [{ name: 'MARCXML', extensions: ['xml'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      const books = exportBooksFor();
      const s = getDb().prepare('SELECT lib_name, org FROM settings WHERE id = 1').get() || {};
      fs.writeFileSync(filePath, buildMarcXml(books, s), 'utf8');
      logAudit('Извеждане UNIMARC', filePath + ' — ' + books.length + ' записа');
      return { ok: true, data: { path: filePath, count: books.length, excluded: exportExcludedCount() } };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('catalog:exportDc', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Извеждане в Dublin Core',
        defaultPath: 'fond-dublincore.xml',
        filters: [{ name: 'XML', extensions: ['xml'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      const books = exportBooksFor();
      const s = getDb().prepare('SELECT lib_name, org FROM settings WHERE id = 1').get() || {};
      fs.writeFileSync(filePath, buildDublinCore(books, s), 'utf8');
      logAudit('Извеждане Dublin Core', filePath + ' — ' + books.length + ' записа');
      return { ok: true, data: { path: filePath, count: books.length, excluded: exportExcludedCount() } };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('catalog:export', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Извеждане на онлайн каталог',
        defaultPath: 'katalog.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      const payload = buildCatalogPayload();
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
      logAudit('Извеждане на каталог', filePath + ' — ' + payload.items.length + ' записа');
      return { ok: true, data: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('catalog:exportCsv', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Извеждане на фонда (CSV)',
        defaultPath: 'fond.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      /* Отделна заявка за бройките: BOOK_SELECT връща `quantity` = наличност за
         заемане (COALESCE(i.quantity, 0)), а тук е нужна ОТЧЕТНАТА бройка
         (COALESCE(i.quantity, 1)) — същото правило като в КДБФ и инвентарната
         книга. Без колона за бройка сборът на цените в Excel дава стойност на
         фонда, занижена с всеки втори и следващ екземпляр. */
      const rows = getDb().prepare(`
        ${BOOK_SELECT} ORDER BY b.inv_number
      `).all();
      const fq = new Map(getDb().prepare(
        'SELECT b.id, COALESCE(i.quantity, 1) AS fund_qty FROM books b LEFT JOIN inventory i ON i.book_id = b.id'
      ).all().map(r => [r.id, r.fund_qty]));
      const h = ['Инв. №', 'Баркод', 'Дата на вписване', 'Категория', 'Автор', 'Заглавие', 'Поредица', 'Място', 'Издателство',
        'Година', 'ISBN', 'Език', 'УДК', 'Сигнатура', 'Отдел', 'Бройки', 'Цена (лв.)', 'Цена (€)', 'Обща стойност (лв.)', 'Състояние'];
      // Защита срещу CSV/formula injection (Фаза 3): свободните текстови полета (заглавие,
      // автор и т.н.) идват от каталогизатора и биха могли случайно или нарочно да
      // започват с =, +, -, @ — символи, които Excel/LibreOffice изпълняват като формула
      // при отваряне на файла (напр. заглавие "=cmd|'/c calc'!A1"). Водещ апостроф
      // отпред неутрализира изпълнението, без видимо да променя стойността.
      const esc = csvCell;
      const csv = [h.join(';')].concat(rows.map(b => {
        const q = fq.has(b.id) ? fq.get(b.id) : 1;
        return [
          b.inv_number, b.barcode, b.register_date, b.category_name, b.author, b.title,
          [b.series, b.series_no].filter(Boolean).join(' '), b.city, b.publisher,
          b.year, b.isbn, b.language, b.udk, b.call_number, b.department,
          q, (b.price || 0).toFixed(2), ((b.price || 0) / 1.95583).toFixed(2),
          ((b.price || 0) * q).toFixed(2), b.status
        ].map(esc).join(';');
      })).join('\r\n');
      fs.writeFileSync(filePath, '﻿' + csv, 'utf8');
      // Всяко друго извеждане на данни навън се вписва в одитната следа; това
      // единствено не се вписваше — а изнася целия фонд заедно с цените.
      logAudit('Извеждане на фонда (CSV)', filePath + ' — ' + rows.length + ' записа');
      return { ok: true, data: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  return { startAutoPushTimer, stopAutoPushTimer };
};
