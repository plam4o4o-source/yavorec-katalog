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
  let AUTO_PUSH_TIMER = null;
  function startAutoPushTimer() {
    if (AUTO_PUSH_TIMER) return;
    AUTO_PUSH_TIMER = setInterval(async () => {
      try {
        const s = getDb().prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
        if (!s || !s.catalog_folder || !isGitRepo(s.catalog_folder)) return;
        const r = await gitPublish(s.catalog_folder);
        if (r.ok && r.committed) console.log('Автоматично публикувано в GitHub:', s.catalog_folder);
        else if (!r.ok) console.error('Автоматично публикуване в GitHub — грешка:', r.error);
      } catch (err) {
        console.error('Автоматично публикуване в GitHub — грешка:', err.message);
      }
    }, 5 * 60 * 1000);
  }
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
      const pub = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE status != 'отчислен' AND department != 'служебен'`).get().n;
      const avail = db.prepare(`
        SELECT COUNT(*) AS n FROM books b WHERE b.status != 'отчислен' AND b.department != 'служебен'
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
  ipcMain.handle('catalog:gitPublishNow', async () => {
    const s = getDb().prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
    if (!s || !s.catalog_folder) return { ok: false, error: 'Първо изберете папка (git clone на хранилището).' };
    const w = flushCatalogWrite();
    if (w.blocked) return { ok: false, error: 'Спряно: фондът в тази база данни излиза празен, а публикуваният каталог не е — за да публикувате наистина празен каталог, използвайте „Ръчен експорт“.' };
    const r = await gitPublish(s.catalog_folder);
    if (r.ok) logAudit('Онлайн каталог', 'публикувано в GitHub' + (r.committed ? '' : ' (нямаше промяна)'));
    return r;
  });
  ipcMain.handle('catalog:writeNow', () =>
    run(() => {
      const s = getDb().prepare('SELECT catalog_folder FROM settings WHERE id = 1').get();
      if (!s || !s.catalog_folder) throw new Error('Първо изберете папка за автоматичен запис.');
      const w = flushCatalogWrite();
      if (w.blocked) throw new Error('Спряно: фондът в тази база данни излиза празен, а публикуваният каталог не е — за да публикувате наистина празен каталог, използвайте „Ръчен експорт“.');
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
  function marcRecord(b) {
    const df = [];
    const add = (tag, i1, i2, subs) => {
      const parts = subs.filter(([, v]) => String(v ?? '').trim() !== '');
      if (!parts.length) return;
      df.push(`    <datafield tag="${tag}" ind1="${i1}" ind2="${i2}">\n` +
        parts.map(([c, v]) => `      <subfield code="${c}">${xesc(v)}</subfield>`).join('\n') +
        `\n    </datafield>`);
    };
    if (b.isbn) add('010', ' ', ' ', [['a', b.isbn]]);
    if (b.language) add('101', '0', ' ', [['a', LANG_ISO[b.language] || b.language]]);
    add('200', '1', ' ', [['a', b.title], ['e', b.subtitle], ['f', b.author]]);
    add('210', ' ', ' ', [['a', b.city], ['c', b.publisher], ['d', b.year]]);
    add('215', ' ', ' ', [['a', b.pages]]);
    if (b.volume) add('225', ' ', ' ', [['v', b.volume]]);
    add('330', ' ', ' ', [['a', b.annotation]]);
    for (const kw of String(b.keywords || '').split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
      add('606', ' ', ' ', [['a', kw]]);
    }
    add('675', ' ', ' ', [['a', b.udk]]);
    const n = splitName(b.author);
    if (n) add('700', ' ', '1', [['a', n.a], ['b', n.b]]);
    // 995 е полето за екземпляри в българската практика (COMARC).
    add('995', ' ', ' ', [['f', b.inv_number], ['d', b.department], ['k', b.call_number],
      ['o', b.category_name], ['r', b.status]]);
    return `  <record>\n` +
      `    <leader>     nam  22     3a 4500</leader>\n` +
      `    <controlfield tag="001">${xesc(b.inv_number ?? b.id)}</controlfield>\n` +
      df.join('\n') + `\n  </record>`;
  }
  function buildMarcXml(books) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!-- UNIMARC в MARCXML структура. Изнесено от библиотечна система „Инвентар“. -->\n` +
      `<collection xmlns="http://www.loc.gov/MARC21/slim">\n` +
      books.map(marcRecord).join('\n') + `\n</collection>\n`;
  }
  function buildDublinCore(books, s) {
    const rec = (b) => {
      const el = [];
      const put = (t, v) => { if (String(v ?? '').trim() !== '') el.push(`      <dc:${t}>${xesc(v)}</dc:${t}>`); };
      put('title', [b.title, b.subtitle].filter(Boolean).join(': '));
      put('creator', b.author);
      put('publisher', b.publisher);
      put('date', b.year);
      put('language', LANG_ISO[b.language] || b.language);
      put('description', b.annotation);
      put('type', b.category_name || 'text');
      put('format', b.pages);
      put('identifier', b.isbn ? 'ISBN ' + b.isbn : '');
      put('identifier', 'inv:' + (b.inv_number ?? b.id));
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
  function exportBooksFor() {
    return getDb().prepare(`${BOOK_SELECT} ORDER BY b.inv_number`).all();
  }
  ipcMain.handle('catalog:exportMarc', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Експорт в UNIMARC / MARCXML',
        defaultPath: 'fond-unimarc.xml',
        filters: [{ name: 'MARCXML', extensions: ['xml'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      const books = exportBooksFor();
      fs.writeFileSync(filePath, buildMarcXml(books), 'utf8');
      logAudit('Експорт UNIMARC', filePath + ' — ' + books.length + ' записа');
      return { ok: true, data: { path: filePath, count: books.length } };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('catalog:exportDc', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Експорт в Dublin Core',
        defaultPath: 'fond-dublincore.xml',
        filters: [{ name: 'XML', extensions: ['xml'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      const books = exportBooksFor();
      const s = getDb().prepare('SELECT lib_name, org FROM settings WHERE id = 1').get() || {};
      fs.writeFileSync(filePath, buildDublinCore(books, s), 'utf8');
      logAudit('Експорт Dublin Core', filePath + ' — ' + books.length + ' записа');
      return { ok: true, data: { path: filePath, count: books.length } };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('catalog:export', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Експорт на онлайн каталог',
        defaultPath: 'katalog.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      const payload = buildCatalogPayload();
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
      logAudit('Експорт на каталог', filePath + ' — ' + payload.items.length + ' записа');
      return { ok: true, data: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('catalog:exportCsv', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Експорт на фонда (CSV)',
        defaultPath: 'fond.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (canceled || !filePath) return { ok: false, error: 'Отказано от потребителя.' };
      const rows = getDb().prepare(`${BOOK_SELECT} ORDER BY b.inv_number`).all();
      const h = ['Инв. №', 'Баркод', 'Дата на вписване', 'Категория', 'Автор', 'Заглавие', 'Място', 'Издателство',
        'Година', 'ISBN', 'Език', 'УДК', 'Сигнатура', 'Отдел', 'Цена (лв.)', 'Цена (€)', 'Състояние'];
      // Защита срещу CSV/formula injection (Фаза 3): свободните текстови полета (заглавие,
      // автор и т.н.) идват от каталогизатора и биха могли случайно или нарочно да
      // започват с =, +, -, @ — символи, които Excel/LibreOffice изпълняват като формула
      // при отваряне на файла (напр. заглавие "=cmd|'/c calc'!A1"). Водещ апостроф
      // отпред неутрализира изпълнението, без видимо да променя стойността.
      const esc = csvCell;
      const csv = [h.join(';')].concat(rows.map(b => [
        b.inv_number, b.barcode, b.register_date, b.category_name, b.author, b.title, b.city, b.publisher,
        b.year, b.isbn, b.language, b.udk, b.call_number, b.department,
        (b.price || 0).toFixed(2), ((b.price || 0) / 1.95583).toFixed(2), b.status
      ].map(esc).join(';'))).join('\r\n');
      fs.writeFileSync(filePath, '﻿' + csv, 'utf8');
      return { ok: true, data: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  return { startAutoPushTimer, stopAutoPushTimer };
};
