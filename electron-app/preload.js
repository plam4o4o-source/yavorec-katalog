const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

/* Пътят на файл, влачен в прозореца. До Electron 31 се четеше направо като
   File.path в изгледа; в Electron 32 това свойство е ПРЕМАХНАТО и замяната е
   webUtils.getPathForFile(), достъпна само тук, в preload — затова минава през
   моста. Проектът е на Electron 43, тоест влаченето на файл за внасяне
   („Приемане на данни от друга система") просто не правеше нищо, при това
   мълчаливо, заради `if (!f.path) return;`. Пази се и резервен път към старото
   свойство, за да не зависи резултатът от версията на Electron. */
function filePath(file) {
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      return webUtils.getPathForFile(file) || '';
    }
  } catch (e) { /* пада към старото свойство по-долу */ }
  return (file && file.path) || '';
}

contextBridge.exposeInMainWorld('api', {
  app: {
    setUser: invoke('app:setUser'),
    getUser: invoke('app:getUser'),
    getVersion: invoke('app:getVersion'),
    checkForUpdates: invoke('app:checkForUpdates'),
    installUpdate: invoke('app:installUpdate'),
    openLogsFolder: invoke('app:openLogsFolder'),
    onUpdateStatus: (cb) => ipcRenderer.on('update:status', (e, data) => cb(data)),
    // Значката „Служител“ следва преименуване/деактивиране от „Настройки“ (v2.4.27).
    onUserChanged: (cb) => ipcRenderer.on('app:userChanged', (e, name) => cb(name))
  },
  employees: {
    list: invoke('employees:list'),
    create: invoke('employees:create'),
    update: invoke('employees:update'),
    delete: invoke('employees:delete')
  },
  settings: {
    get: invoke('settings:get'),
    update: invoke('settings:update'),
    updateLabelFormat: invoke('settings:updateLabelFormat'),
    updateTheme: invoke('settings:updateTheme'),
    updateScanSound: invoke('settings:updateScanSound'),
    chooseLogo: invoke('settings:chooseLogo'),
    clearLogo: invoke('settings:clearLogo'),
    updateNotices: invoke('settings:updateNotices'),
    noticeDefaults: invoke('settings:noticeDefaults')
  },
  dbLocation: {
    get: invoke('dbLocation:get'),
    choose: invoke('dbLocation:choose'),
    resetDefault: invoke('dbLocation:resetDefault')
  },
  backup: {
    list: invoke('backup:list'),
    now: invoke('backup:now'),
    restoreFromList: invoke('backup:restoreFromList'),
    restoreBrowse: invoke('backup:restoreBrowse'),
    // Криптирано ли е днешното автоматично копие и ако не — защо. Показва се в
    // „Настройки“ → „Резервно копие“ (v2.2.1); дотогава предупреждението стигаше
    // до библиотекаря само през одитната следа.
    autoStatus: invoke('backup:autoStatus'),
    /* Втора (незадължителна) папка за копие — USB, външен или мрежов диск.
       Всички копия дотук стояха в backups/ ДО самата база: един изгорял диск
       отнасяше и базата, и 30-те копия наведнъж. Пътят е настройка на този
       компютър (config.json), затова минава през main процеса, а не през
       таблицата settings, която е обща за мрежата. */
    secondFolder: invoke('backup:secondFolder'),
    chooseSecondFolder: invoke('backup:chooseSecondFolder'),
    clearSecondFolder: invoke('backup:clearSecondFolder'),
    /* Дневното копие се прекриптира в main процеса — при отключване и при СМЯНА
       на паролата — и това може да се провали. Дотук резултатът стигаше само до
       console.error. Сега main изпраща известие, а „Настройки“ показва тост и
       опреснява картата (същият модел като app.onUpdateStatus). */
    onAutoStatus: (cb) => ipcRenderer.on('backup:autoStatusChanged', (e, data) => cb(data))
  },
  limits: {
    usage: invoke('limits:usage'),
    update: invoke('limits:update')
  },
  authorMark: {
    status: invoke('authorMark:status'),
    choose: invoke('authorMark:choose'),
    confirm: invoke('authorMark:confirm'),
    clear: invoke('authorMark:clear'),
    loadBuiltin: invoke('authorMark:loadBuiltin'),
    suggest: invoke('authorMark:suggest'),
    audit: invoke('authorMark:audit'),
    fillPreview: invoke('authorMark:fillPreview'),
    fillApply: invoke('authorMark:fillApply')
  },
  categories: {
    list: invoke('categories:list'),
    create: invoke('categories:create'),
    update: invoke('categories:update'),
    usage: invoke('categories:usage'),
    delete: invoke('categories:delete')
  },
  books: {
    /* books.list(query, sort, page) — третият параметър има ТРИ документирани
       вида, всички обслужвани от handlers/books.js:
         • { offset, limit, dept, cat } → { rows, total, depts } — прозорецът на
           списъка „Книги“ (v2.4.31);
         • { idsOnly: true }            → { ids } — за „Избери всички“;
         • { labels: true, from, to }   → МАСИВ с шестте полета, които се печатат
           върху етикет (инв. №, баркод, сигнатура, авторски знак, УДК, статус),
           за инвентарните номера между `from` и `to`; празни граници значат
           целия действащ фонд (v2.4.64).
       Режимът за етикети е параметър на СЪЩИЯ канал, а не нов: питането е едно и
       също („кои документи са в действащия фонд“) и трябва да се решава на едно
       място. Дотук „Баркод етикети“ теглеше целия фонд — 15 000 реда и 4,53 МБ
       по този мост — за да отпечата 300 етикета; сега по моста минават 0,03 МБ.
       Без параметър — пълният масив, както досега (износите). */
    list: invoke('books:list'),
    get: invoke('books:get'),
    byBarcode: invoke('books:byBarcode'),
    create: invoke('books:create'),
    update: invoke('books:update'),
    delete: invoke('books:delete'),
    addCheck: invoke('books:addCheck'),
    checks: invoke('books:checks'),
    bulkUpdate: invoke('books:bulkUpdate'),
    findDuplicateBarcodes: invoke('books:findDuplicateBarcodes'),
    multiCopyRecords: invoke('books:multiCopyRecords'),
    splitCopies: invoke('books:splitCopies'),
    splitCopiesBatch: invoke('books:splitCopiesBatch'),
    setLendable: invoke('books:setLendable'),
    deaccessionedWithoutAct: invoke('books:deaccessionedWithoutAct'),
    clearOrphanDeaccession: invoke('books:clearOrphanDeaccession')
  },
  isbn: {
    lookup: invoke('isbn:lookup')
  },
  sru: {
    lookup: invoke('sru:lookup')
  },
  authorities: {
    fields: invoke('authorities:fields'),
    list: invoke('authorities:list'),
    suggest: invoke('authorities:suggest'),
    duplicates: invoke('authorities:duplicates'),
    merge: invoke('authorities:merge')
  },
  invBook: {
    list: invoke('invBook:list')
  },
  acquisitions: {
    list: invoke('acquisitions:list'),
    get: invoke('acquisitions:get'),
    nextNo: invoke('acquisitions:nextNo'),
    create: invoke('acquisitions:create'),
    // Поправка на вписана партида (v2.4.56). Дотук имаше само create и delete, а
    // delete отказва, щом поне един документ е инвентиран — тоест сгрешен номер
    // на фактура оставаше завинаги в КДБФ Част № 1.
    update: invoke('acquisitions:update'),
    delete: invoke('acquisitions:delete')
  },
  deaccessionActs: {
    list: invoke('deaccessionActs:list'),
    get: invoke('deaccessionActs:get'),
    nextNo: invoke('deaccessionActs:nextNo'),
    findBook: invoke('deaccessionActs:findBook'),
    create: invoke('deaccessionActs:create'),
    revoke: invoke('deaccessionActs:revoke'),
    // Проект на акт (v2.4.56) — виж handlers/deaccession-acts.js: актът вече не
    // се трие, затова грешките трябва да имат къде да се случат преди него.
    drafts: invoke('deaccessionActs:drafts'),
    getDraft: invoke('deaccessionActs:getDraft'),
    saveDraft: invoke('deaccessionActs:saveDraft'),
    deleteDraft: invoke('deaccessionActs:deleteDraft'),
    approveDraft: invoke('deaccessionActs:approveDraft')
  },
  kdbf: {
    report: invoke('kdbf:report')
  },
  /* Съгласуване на фондовите числа (v2.4.57): сравнява какво показват КДБФ,
     годишният отчет, таблото и инвентарната книга, и обяснява разликите. */
  fund: {
    check: invoke('fund:check'),
    checkLogged: invoke('fund:checkLogged')
  },
  print: {
    savePdf: invoke('print:savePdf')
  },
  readers: {
    list: invoke('readers:list'),
    get: invoke('readers:get'),
    byCard: invoke('readers:byCard'),
    create: invoke('readers:create'),
    update: invoke('readers:update'),
    delete: invoke('readers:delete'),
    clearSuspension: invoke('readers:clearSuspension'),
    exportCsv: invoke('readers:exportCsv')
  },
  /* Пълен износ на данните (CSV в ZIP) — handlers/export-all.js. Стои като
     отделна група, а не под `settings`, защото не е настройка, а действие върху
     ЦЯЛАТА база: изнася всяка таблица, не само тази на раздела, от който е
     натиснат бутонът. Групата е с едно повикване, за да има място за
     `exportAll:folder` (папка вместо архив) и за износ по избор на таблици,
     без да се пипа нищо друго. */
  exportAll: {
    run: invoke('exportAll:run')
  },
  pdp: {
    status: invoke('pdp:status'),
    setup: invoke('pdp:setup'),
    unlock: invoke('pdp:unlock'),
    lock: invoke('pdp:lock'),
    changePassword: invoke('pdp:changePassword')
  },
  account: {
    get: invoke('account:get'),
    charge: invoke('account:charge'),
    pay: invoke('account:pay'),
    deleteLine: invoke('account:deleteLine')
  },
  suggestions: {
    list: invoke('suggestions:list'),
    create: invoke('suggestions:create'),
    setStatus: invoke('suggestions:setStatus'),
    delete: invoke('suggestions:delete'),
    // v2.4.57: „някой искал ли е точно тази книга“ — същото съвпадение, което
    // books:create вече връща сам при вписване (поле `suggestions` в отговора);
    // тук е за картона на вече вписан документ.
    matchBook: invoke('suggestions:matchBook')
  },
  circRules: {
    list: invoke('circRules:list'),
    save: invoke('circRules:save'),
    delete: invoke('circRules:delete'),
    effective: invoke('circRules:effective')
  },
  calendar: {
    get: invoke('calendar:get'),
    saveWorkDays: invoke('calendar:saveWorkDays'),
    addClosed: invoke('calendar:addClosed'),
    removeClosed: invoke('calendar:removeClosed')
  },
  housebound: {
    get: invoke('housebound:get'),
    save: invoke('housebound:save'),
    remove: invoke('housebound:remove'),
    addVisit: invoke('housebound:addVisit'),
    list: invoke('housebound:list')
  },
  gdpr: {
    candidates: invoke('gdpr:candidates'),
    anonymize: invoke('gdpr:anonymize'),
    /* Заличаване по искане на ЕДИН човек (чл. 17 ОРЗД), v2.4.65. Анонимизирането
       дотук работеше само по срок назад („всичко отпреди N години“), тоест за
       читател, поискал заличаване тази година, нямаше нито един път — данните му
       оставаха и в `readers`, и в одитната следа. Затова отделен канал, който
       прилага същите правила, но по конкретния читател, независимо от срока. */
    forgetReader: invoke('gdpr:forgetReader')
  },
  av: {
    categories: invoke('av:categories'),
    options: invoke('av:options'),
    save: invoke('av:save')
  },
  events: {
    localuse: invoke('events:localuse')
  },
  notices: {
    log: invoke('notices:log')
  },
  loans: {
    list: invoke('loans:list'),
    overdue: invoke('loans:overdue'),
    overdueByReader: invoke('loans:overdueByReader'),
    byReader: invoke('loans:byReader'),
    byBook: invoke('loans:byBook'),
    checkout: invoke('loans:checkout'),
    checkoutByCode: invoke('loans:checkoutByCode'),
    return: invoke('loans:return'),
    returnByCode: invoke('loans:returnByCode'),
    extend: invoke('loans:extend'),
    /* Изгубен/невърнат от читателя документ (v2.4.56) — виж handlers/loans.js:
       markLost приключва заемането с изричен белег, че документът НЕ е върнат;
       lostQuote дава предложената сума ПРЕДИ решението; lost е списъкът за акта
       по чл. 30, т. 5 с начисленото и събраното по всеки документ. */
    markLost: invoke('loans:markLost'),
    lostQuote: invoke('loans:lostQuote'),
    lost: invoke('loans:lost'),
    /* „Документът се намери“ (v2.4.65). Дотук пътят беше еднопосочен: приключеното
       като изгубено заемане оставаше с белег `lost = 1` завинаги, дори след като
       книгата се върнеше на рафта, тоест тя продължаваше да стои в списъка за акт
       по чл. 30, т. 5, а обезщетението за нея — да тежи на сметката на читателя.
       Обратният път вече е отделно действие, а не редакция на състоянието „на ръка“. */
    found: invoke('loans:found'),
    lostPolicy: invoke('loans:lostPolicy'),
    lostPolicySave: invoke('loans:lostPolicySave'),
    reminders: invoke('loans:reminders'),
    mailto: invoke('loans:mailto')
  },
  holds: {
    list: invoke('holds:list'),
    add: invoke('holds:add'),
    cancel: invoke('holds:cancel')
  },
  dashboard: {
    stats: invoke('dashboard:stats'),
    full: invoke('dashboard:full')
  },
  inventorySessions: {
    list: invoke('inventorySessions:list'),
    requirement: invoke('inventorySessions:requirement'),
    start: invoke('inventorySessions:start'),
    get: invoke('inventorySessions:get'),
    scan: invoke('inventorySessions:scan'),
    close: invoke('inventorySessions:close'),
    importScans: invoke('inventorySessions:importScans')
  },
  periodicals: {
    list: invoke('periodicals:list'),
    get: invoke('periodicals:get'),
    create: invoke('periodicals:create'),
    update: invoke('periodicals:update'),
    delete: invoke('periodicals:delete')
  },
  periodicalIssues: {
    add: invoke('periodicalIssues:add'),
    delete: invoke('periodicalIssues:delete')
  },
  /* Инвентиране на годишния комплект (v2.4.56). Дотук периодиката нямаше НИТО
     ЕДИН канал, който да я свързва с фонда — затова и КДБФ, и годишният отчет я
     пропускаха, макар отпечатаното заглавие на Част № 1 да я изброява поименно.
     register({ periodical_id, year, price, register_date, inv_number, acquisition_id, note })
     създава реда в инвентарната книга и го свързва с изданието; всичко останало
     (партидата) минава през вече съществуващия мост acquisitions по-горе, за да
     няма втора бройна логика за номерата в КДБФ. */
  periodicalVolumes: {
    register: invoke('periodicalVolumes:register')
  },
  mzs: {
    list: invoke('mzs:list'),
    nextNo: invoke('mzs:nextNo'),
    create: invoke('mzs:create'),
    update: invoke('mzs:update'),
    delete: invoke('mzs:delete')
  },
  analytics: {
    list: invoke('analytics:list'),
    get: invoke('analytics:get'),
    years: invoke('analytics:years'),
    create: invoke('analytics:create'),
    update: invoke('analytics:update'),
    delete: invoke('analytics:delete')
  },
  persons: {
    list: invoke('persons:list'),
    get: invoke('persons:get'),
    create: invoke('persons:create'),
    update: invoke('persons:update'),
    delete: invoke('persons:delete')
  },
  chronicle: {
    list: invoke('chronicle:list'),
    get: invoke('chronicle:get'),
    years: invoke('chronicle:years'),
    create: invoke('chronicle:create'),
    update: invoke('chronicle:update'),
    delete: invoke('chronicle:delete')
  },
  links: {
    list: invoke('links:list'),
    backlinks: invoke('links:backlinks'),
    add: invoke('links:add'),
    delete: invoke('links:delete'),
    search: invoke('links:search')
  },
  localPhoto: {
    choose: invoke('localPhoto:choose'),
    clear: invoke('localPhoto:clear')
  },
  importData: {
    choose: invoke('import:choose'),
    load: invoke('import:load'),
    run: invoke('import:run'),
    // Пътят на влачен файл — вижте filePath() в началото на този файл за защо
    // не може да се прочете направо от изгледа в Electron 32+.
    pathOf: (file) => filePath(file)
  },
  mobile: {
    generate: invoke('mobile:generate')
  },
  security: {
    exclusionInfo: invoke('security:exclusionInfo'),
    writeExclusionScript: invoke('security:writeExclusionScript')
  },
  audit: {
    list: invoke('audit:list'),
    export: invoke('audit:export')
  },
  /* „Изтриване на всички данни“ — започване на чисто (v2.4.64).
     Две повиквания, нарочно разделени: `plan` дава какво ИМА и какво ОСТАВА,
     за да може екранът да го покаже ПРЕДИ потвърждението (заедно с думата за
     потвърждение, която идва оттам, а не е преписана в екрана); `wipe` е
     самото действие и приема { word }. Обработчикът отказва без думата — тя не
     е украса на екрана, а условието на необратимото действие. Виж
     handlers/reset.js за целия ред и за решението кое преживява изтриването. */
  reset: {
    plan: invoke('reset:plan'),
    wipe: invoke('reset:wipe')
  },
  searchHistory: {
    log: invoke('searchHistory:log'),
    suggest: invoke('searchHistory:suggest')
  },
  dnevnik: {
    getMonth: invoke('dnevnik:getMonth'),
    saveDay: invoke('dnevnik:saveDay'),
    suggest: invoke('dnevnik:suggest'),
    exportCsv: invoke('dnevnik:exportCsv')
  },
  visits: {
    add: invoke('visits:add'),
    get: invoke('visits:get')
  },
  stats: {
    report: invoke('stats:report')
  },
  reports: {
    list: invoke('reports:list'),
    run: invoke('reports:run')
  },
  shelves: {
    list: invoke('shelves:list'),
    items: invoke('shelves:items'),
    create: invoke('shelves:create'),
    rename: invoke('shelves:rename'),
    delete: invoke('shelves:delete'),
    addBook: invoke('shelves:addBook'),
    addBooks: invoke('shelves:addBooks'),
    removeBook: invoke('shelves:removeBook')
  },
  catalog: {
    status: invoke('catalog:status'),
    autoPushStatus: invoke('catalog:autoPushStatus'),
    chooseFolder: invoke('catalog:chooseFolder'),
    disconnectFolder: invoke('catalog:disconnectFolder'),
    writeNow: invoke('catalog:writeNow'),
    export: invoke('catalog:export'),
    exportCsv: invoke('catalog:exportCsv'),
    exportMarc: invoke('catalog:exportMarc'),
    exportDc: invoke('catalog:exportDc'),
    updateGh: invoke('catalog:updateGh'),
    gitPublishNow: invoke('catalog:gitPublishNow'),
    remoteCheck: invoke('catalog:remoteCheck')
  }
});
