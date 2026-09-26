// ГЕНЕРИРАН ФАЙЛ — не се пише на ръка. Източник: preload.js.
// Обновяване: npm run gen:api-types (виж scripts/gen-api-types.js).

/** Методът през ipcRenderer.invoke — връща каквото върне обработчикът в главния процес. */
type InvLibInvoke = (...args: any[]) => Promise<any>;

interface InvLibApi {
  app: {
    /** канал „app:setUser“ */
    setUser: InvLibInvoke;
    /** канал „app:getUser“ */
    getUser: InvLibInvoke;
    /** канал „app:getVersion“ */
    getVersion: InvLibInvoke;
    /** канал „app:checkForUpdates“ */
    checkForUpdates: InvLibInvoke;
    /** канал „app:installUpdate“ */
    installUpdate: InvLibInvoke;
    /** канал „app:openLogsFolder“ */
    openLogsFolder: InvLibInvoke;
    onUpdateStatus: (...args: any[]) => any;
    onUserChanged: (...args: any[]) => any;
  };
  employees: {
    /** канал „employees:list“ */
    list: InvLibInvoke;
    /** канал „employees:create“ */
    create: InvLibInvoke;
    /** канал „employees:update“ */
    update: InvLibInvoke;
    /** канал „employees:delete“ */
    delete: InvLibInvoke;
  };
  settings: {
    /** канал „settings:get“ */
    get: InvLibInvoke;
    /** канал „settings:update“ */
    update: InvLibInvoke;
    /** канал „settings:updateLabelFormat“ */
    updateLabelFormat: InvLibInvoke;
    /** канал „settings:updateTheme“ */
    updateTheme: InvLibInvoke;
    /** канал „settings:updateScanSound“ */
    updateScanSound: InvLibInvoke;
    /** канал „settings:chooseLogo“ */
    chooseLogo: InvLibInvoke;
    /** канал „settings:clearLogo“ */
    clearLogo: InvLibInvoke;
    /** канал „settings:updateNotices“ */
    updateNotices: InvLibInvoke;
    /** канал „settings:noticeDefaults“ */
    noticeDefaults: InvLibInvoke;
  };
  dbLocation: {
    /** канал „dbLocation:get“ */
    get: InvLibInvoke;
    /** канал „dbLocation:choose“ */
    choose: InvLibInvoke;
    /** канал „dbLocation:resetDefault“ */
    resetDefault: InvLibInvoke;
  };
  backup: {
    /** канал „backup:list“ */
    list: InvLibInvoke;
    /** канал „backup:now“ */
    now: InvLibInvoke;
    /** канал „backup:restoreFromList“ */
    restoreFromList: InvLibInvoke;
    /** канал „backup:restoreBrowse“ */
    restoreBrowse: InvLibInvoke;
    /** канал „backup:autoStatus“ */
    autoStatus: InvLibInvoke;
    /** канал „backup:secondFolder“ */
    secondFolder: InvLibInvoke;
    /** канал „backup:chooseSecondFolder“ */
    chooseSecondFolder: InvLibInvoke;
    /** канал „backup:clearSecondFolder“ */
    clearSecondFolder: InvLibInvoke;
    onAutoStatus: (...args: any[]) => any;
  };
  limits: {
    /** канал „limits:usage“ */
    usage: InvLibInvoke;
    /** канал „limits:update“ */
    update: InvLibInvoke;
  };
  authorMark: {
    /** канал „authorMark:status“ */
    status: InvLibInvoke;
    /** канал „authorMark:choose“ */
    choose: InvLibInvoke;
    /** канал „authorMark:confirm“ */
    confirm: InvLibInvoke;
    /** канал „authorMark:clear“ */
    clear: InvLibInvoke;
    /** канал „authorMark:loadBuiltin“ */
    loadBuiltin: InvLibInvoke;
    /** канал „authorMark:suggest“ */
    suggest: InvLibInvoke;
    /** канал „authorMark:audit“ */
    audit: InvLibInvoke;
    /** канал „authorMark:fillPreview“ */
    fillPreview: InvLibInvoke;
    /** канал „authorMark:fillApply“ */
    fillApply: InvLibInvoke;
  };
  categories: {
    /** канал „categories:list“ */
    list: InvLibInvoke;
    /** канал „categories:create“ */
    create: InvLibInvoke;
    /** канал „categories:update“ */
    update: InvLibInvoke;
    /** канал „categories:usage“ */
    usage: InvLibInvoke;
    /** канал „categories:delete“ */
    delete: InvLibInvoke;
  };
  books: {
    /** канал „books:list“ */
    list: InvLibInvoke;
    /** канал „books:get“ */
    get: InvLibInvoke;
    /** канал „books:byBarcode“ */
    byBarcode: InvLibInvoke;
    /** канал „books:create“ */
    create: InvLibInvoke;
    /** канал „books:update“ */
    update: InvLibInvoke;
    /** канал „books:delete“ */
    delete: InvLibInvoke;
    /** канал „books:addCheck“ */
    addCheck: InvLibInvoke;
    /** канал „books:checks“ */
    checks: InvLibInvoke;
    /** канал „books:bulkUpdate“ */
    bulkUpdate: InvLibInvoke;
    /** канал „books:findDuplicateBarcodes“ */
    findDuplicateBarcodes: InvLibInvoke;
    /** канал „books:multiCopyRecords“ */
    multiCopyRecords: InvLibInvoke;
    /** канал „books:splitCopies“ */
    splitCopies: InvLibInvoke;
    /** канал „books:splitCopiesBatch“ */
    splitCopiesBatch: InvLibInvoke;
    /** канал „books:setLendable“ */
    setLendable: InvLibInvoke;
    /** канал „books:deaccessionedWithoutAct“ */
    deaccessionedWithoutAct: InvLibInvoke;
    /** канал „books:clearOrphanDeaccession“ */
    clearOrphanDeaccession: InvLibInvoke;
  };
  isbn: {
    /** канал „isbn:lookup“ */
    lookup: InvLibInvoke;
  };
  sru: {
    /** канал „sru:lookup“ */
    lookup: InvLibInvoke;
  };
  authorities: {
    /** канал „authorities:fields“ */
    fields: InvLibInvoke;
    /** канал „authorities:list“ */
    list: InvLibInvoke;
    /** канал „authorities:suggest“ */
    suggest: InvLibInvoke;
    /** канал „authorities:duplicates“ */
    duplicates: InvLibInvoke;
    /** канал „authorities:merge“ */
    merge: InvLibInvoke;
  };
  invBook: {
    /** канал „invBook:list“ */
    list: InvLibInvoke;
  };
  acquisitions: {
    /** канал „acquisitions:list“ */
    list: InvLibInvoke;
    /** канал „acquisitions:get“ */
    get: InvLibInvoke;
    /** канал „acquisitions:nextNo“ */
    nextNo: InvLibInvoke;
    /** канал „acquisitions:create“ */
    create: InvLibInvoke;
    /** канал „acquisitions:update“ */
    update: InvLibInvoke;
    /** канал „acquisitions:delete“ */
    delete: InvLibInvoke;
  };
  deaccessionActs: {
    /** канал „deaccessionActs:list“ */
    list: InvLibInvoke;
    /** канал „deaccessionActs:get“ */
    get: InvLibInvoke;
    /** канал „deaccessionActs:nextNo“ */
    nextNo: InvLibInvoke;
    /** канал „deaccessionActs:findBook“ */
    findBook: InvLibInvoke;
    /** канал „deaccessionActs:create“ */
    create: InvLibInvoke;
    /** канал „deaccessionActs:revoke“ */
    revoke: InvLibInvoke;
    /** канал „deaccessionActs:drafts“ */
    drafts: InvLibInvoke;
    /** канал „deaccessionActs:getDraft“ */
    getDraft: InvLibInvoke;
    /** канал „deaccessionActs:saveDraft“ */
    saveDraft: InvLibInvoke;
    /** канал „deaccessionActs:deleteDraft“ */
    deleteDraft: InvLibInvoke;
    /** канал „deaccessionActs:approveDraft“ */
    approveDraft: InvLibInvoke;
  };
  kdbf: {
    /** канал „kdbf:report“ */
    report: InvLibInvoke;
  };
  fund: {
    /** канал „fund:check“ */
    check: InvLibInvoke;
    /** канал „fund:checkLogged“ */
    checkLogged: InvLibInvoke;
  };
  print: {
    /** канал „print:savePdf“ */
    savePdf: InvLibInvoke;
  };
  readers: {
    /** канал „readers:list“ */
    list: InvLibInvoke;
    /** канал „readers:get“ */
    get: InvLibInvoke;
    /** канал „readers:byCard“ */
    byCard: InvLibInvoke;
    /** канал „readers:create“ */
    create: InvLibInvoke;
    /** канал „readers:update“ */
    update: InvLibInvoke;
    /** канал „readers:delete“ */
    delete: InvLibInvoke;
    /** канал „readers:clearSuspension“ */
    clearSuspension: InvLibInvoke;
    /** канал „readers:exportCsv“ */
    exportCsv: InvLibInvoke;
  };
  exportAll: {
    /** канал „exportAll:run“ */
    run: InvLibInvoke;
  };
  pdp: {
    /** канал „pdp:status“ */
    status: InvLibInvoke;
    /** канал „pdp:setup“ */
    setup: InvLibInvoke;
    /** канал „pdp:unlock“ */
    unlock: InvLibInvoke;
    /** канал „pdp:lock“ */
    lock: InvLibInvoke;
    /** канал „pdp:changePassword“ */
    changePassword: InvLibInvoke;
  };
  account: {
    /** канал „account:get“ */
    get: InvLibInvoke;
    /** канал „account:charge“ */
    charge: InvLibInvoke;
    /** канал „account:pay“ */
    pay: InvLibInvoke;
    /** канал „account:deleteLine“ */
    deleteLine: InvLibInvoke;
  };
  suggestions: {
    /** канал „suggestions:list“ */
    list: InvLibInvoke;
    /** канал „suggestions:create“ */
    create: InvLibInvoke;
    /** канал „suggestions:setStatus“ */
    setStatus: InvLibInvoke;
    /** канал „suggestions:delete“ */
    delete: InvLibInvoke;
    /** канал „suggestions:matchBook“ */
    matchBook: InvLibInvoke;
  };
  circRules: {
    /** канал „circRules:list“ */
    list: InvLibInvoke;
    /** канал „circRules:save“ */
    save: InvLibInvoke;
    /** канал „circRules:delete“ */
    delete: InvLibInvoke;
    /** канал „circRules:effective“ */
    effective: InvLibInvoke;
  };
  calendar: {
    /** канал „calendar:get“ */
    get: InvLibInvoke;
    /** канал „calendar:saveWorkDays“ */
    saveWorkDays: InvLibInvoke;
    /** канал „calendar:addClosed“ */
    addClosed: InvLibInvoke;
    /** канал „calendar:removeClosed“ */
    removeClosed: InvLibInvoke;
  };
  housebound: {
    /** канал „housebound:get“ */
    get: InvLibInvoke;
    /** канал „housebound:save“ */
    save: InvLibInvoke;
    /** канал „housebound:remove“ */
    remove: InvLibInvoke;
    /** канал „housebound:addVisit“ */
    addVisit: InvLibInvoke;
    /** канал „housebound:list“ */
    list: InvLibInvoke;
  };
  gdpr: {
    /** канал „gdpr:candidates“ */
    candidates: InvLibInvoke;
    /** канал „gdpr:anonymize“ */
    anonymize: InvLibInvoke;
    /** канал „gdpr:forgetReader“ */
    forgetReader: InvLibInvoke;
  };
  av: {
    /** канал „av:categories“ */
    categories: InvLibInvoke;
    /** канал „av:options“ */
    options: InvLibInvoke;
    /** канал „av:save“ */
    save: InvLibInvoke;
  };
  events: {
    /** канал „events:localuse“ */
    localuse: InvLibInvoke;
  };
  notices: {
    /** канал „notices:log“ */
    log: InvLibInvoke;
  };
  loans: {
    /** канал „loans:list“ */
    list: InvLibInvoke;
    /** канал „loans:overdue“ */
    overdue: InvLibInvoke;
    /** канал „loans:overdueByReader“ */
    overdueByReader: InvLibInvoke;
    /** канал „loans:byReader“ */
    byReader: InvLibInvoke;
    /** канал „loans:byBook“ */
    byBook: InvLibInvoke;
    /** канал „loans:checkout“ */
    checkout: InvLibInvoke;
    /** канал „loans:checkoutByCode“ */
    checkoutByCode: InvLibInvoke;
    /** канал „loans:return“ */
    return: InvLibInvoke;
    /** канал „loans:returnByCode“ */
    returnByCode: InvLibInvoke;
    /** канал „loans:extend“ */
    extend: InvLibInvoke;
    /** канал „loans:markLost“ */
    markLost: InvLibInvoke;
    /** канал „loans:lostQuote“ */
    lostQuote: InvLibInvoke;
    /** канал „loans:lost“ */
    lost: InvLibInvoke;
    /** канал „loans:found“ */
    found: InvLibInvoke;
    /** канал „loans:lostPolicy“ */
    lostPolicy: InvLibInvoke;
    /** канал „loans:lostPolicySave“ */
    lostPolicySave: InvLibInvoke;
    /** канал „loans:reminders“ */
    reminders: InvLibInvoke;
    /** канал „loans:mailto“ */
    mailto: InvLibInvoke;
  };
  holds: {
    /** канал „holds:list“ */
    list: InvLibInvoke;
    /** канал „holds:add“ */
    add: InvLibInvoke;
    /** канал „holds:cancel“ */
    cancel: InvLibInvoke;
  };
  dashboard: {
    /** канал „dashboard:stats“ */
    stats: InvLibInvoke;
    /** канал „dashboard:full“ */
    full: InvLibInvoke;
  };
  inventorySessions: {
    /** канал „inventorySessions:list“ */
    list: InvLibInvoke;
    /** канал „inventorySessions:requirement“ */
    requirement: InvLibInvoke;
    /** канал „inventorySessions:start“ */
    start: InvLibInvoke;
    /** канал „inventorySessions:get“ */
    get: InvLibInvoke;
    /** канал „inventorySessions:scan“ */
    scan: InvLibInvoke;
    /** канал „inventorySessions:close“ */
    close: InvLibInvoke;
    /** канал „inventorySessions:importScans“ */
    importScans: InvLibInvoke;
  };
  periodicals: {
    /** канал „periodicals:list“ */
    list: InvLibInvoke;
    /** канал „periodicals:get“ */
    get: InvLibInvoke;
    /** канал „periodicals:create“ */
    create: InvLibInvoke;
    /** канал „periodicals:update“ */
    update: InvLibInvoke;
    /** канал „periodicals:delete“ */
    delete: InvLibInvoke;
  };
  periodicalIssues: {
    /** канал „periodicalIssues:add“ */
    add: InvLibInvoke;
    /** канал „periodicalIssues:delete“ */
    delete: InvLibInvoke;
  };
  periodicalVolumes: {
    /** канал „periodicalVolumes:register“ */
    register: InvLibInvoke;
  };
  mzs: {
    /** канал „mzs:list“ */
    list: InvLibInvoke;
    /** канал „mzs:nextNo“ */
    nextNo: InvLibInvoke;
    /** канал „mzs:create“ */
    create: InvLibInvoke;
    /** канал „mzs:update“ */
    update: InvLibInvoke;
    /** канал „mzs:delete“ */
    delete: InvLibInvoke;
  };
  analytics: {
    /** канал „analytics:list“ */
    list: InvLibInvoke;
    /** канал „analytics:get“ */
    get: InvLibInvoke;
    /** канал „analytics:years“ */
    years: InvLibInvoke;
    /** канал „analytics:create“ */
    create: InvLibInvoke;
    /** канал „analytics:update“ */
    update: InvLibInvoke;
    /** канал „analytics:delete“ */
    delete: InvLibInvoke;
  };
  persons: {
    /** канал „persons:list“ */
    list: InvLibInvoke;
    /** канал „persons:get“ */
    get: InvLibInvoke;
    /** канал „persons:create“ */
    create: InvLibInvoke;
    /** канал „persons:update“ */
    update: InvLibInvoke;
    /** канал „persons:delete“ */
    delete: InvLibInvoke;
  };
  chronicle: {
    /** канал „chronicle:list“ */
    list: InvLibInvoke;
    /** канал „chronicle:get“ */
    get: InvLibInvoke;
    /** канал „chronicle:years“ */
    years: InvLibInvoke;
    /** канал „chronicle:create“ */
    create: InvLibInvoke;
    /** канал „chronicle:update“ */
    update: InvLibInvoke;
    /** канал „chronicle:delete“ */
    delete: InvLibInvoke;
  };
  links: {
    /** канал „links:list“ */
    list: InvLibInvoke;
    /** канал „links:backlinks“ */
    backlinks: InvLibInvoke;
    /** канал „links:add“ */
    add: InvLibInvoke;
    /** канал „links:delete“ */
    delete: InvLibInvoke;
    /** канал „links:search“ */
    search: InvLibInvoke;
  };
  localPhoto: {
    /** канал „localPhoto:choose“ */
    choose: InvLibInvoke;
    /** канал „localPhoto:clear“ */
    clear: InvLibInvoke;
  };
  importData: {
    /** канал „import:choose“ */
    choose: InvLibInvoke;
    /** канал „import:load“ */
    load: InvLibInvoke;
    /** канал „import:run“ */
    run: InvLibInvoke;
    pathOf: (...args: any[]) => any;
  };
  mobile: {
    /** канал „mobile:generate“ */
    generate: InvLibInvoke;
  };
  security: {
    /** канал „security:exclusionInfo“ */
    exclusionInfo: InvLibInvoke;
    /** канал „security:writeExclusionScript“ */
    writeExclusionScript: InvLibInvoke;
  };
  audit: {
    /** канал „audit:list“ */
    list: InvLibInvoke;
    /** канал „audit:export“ */
    export: InvLibInvoke;
  };
  reset: {
    /** канал „reset:plan“ */
    plan: InvLibInvoke;
    /** канал „reset:wipe“ */
    wipe: InvLibInvoke;
  };
  searchHistory: {
    /** канал „searchHistory:log“ */
    log: InvLibInvoke;
    /** канал „searchHistory:suggest“ */
    suggest: InvLibInvoke;
  };
  dnevnik: {
    /** канал „dnevnik:getMonth“ */
    getMonth: InvLibInvoke;
    /** канал „dnevnik:saveDay“ */
    saveDay: InvLibInvoke;
    /** канал „dnevnik:suggest“ */
    suggest: InvLibInvoke;
    /** канал „dnevnik:exportCsv“ */
    exportCsv: InvLibInvoke;
  };
  visits: {
    /** канал „visits:add“ */
    add: InvLibInvoke;
    /** канал „visits:get“ */
    get: InvLibInvoke;
  };
  stats: {
    /** канал „stats:report“ */
    report: InvLibInvoke;
  };
  reports: {
    /** канал „reports:list“ */
    list: InvLibInvoke;
    /** канал „reports:run“ */
    run: InvLibInvoke;
  };
  shelves: {
    /** канал „shelves:list“ */
    list: InvLibInvoke;
    /** канал „shelves:items“ */
    items: InvLibInvoke;
    /** канал „shelves:create“ */
    create: InvLibInvoke;
    /** канал „shelves:rename“ */
    rename: InvLibInvoke;
    /** канал „shelves:delete“ */
    delete: InvLibInvoke;
    /** канал „shelves:addBook“ */
    addBook: InvLibInvoke;
    /** канал „shelves:addBooks“ */
    addBooks: InvLibInvoke;
    /** канал „shelves:removeBook“ */
    removeBook: InvLibInvoke;
  };
  catalog: {
    /** канал „catalog:status“ */
    status: InvLibInvoke;
    /** канал „catalog:autoPushStatus“ */
    autoPushStatus: InvLibInvoke;
    /** канал „catalog:chooseFolder“ */
    chooseFolder: InvLibInvoke;
    /** канал „catalog:disconnectFolder“ */
    disconnectFolder: InvLibInvoke;
    /** канал „catalog:writeNow“ */
    writeNow: InvLibInvoke;
    /** канал „catalog:export“ */
    export: InvLibInvoke;
    /** канал „catalog:exportCsv“ */
    exportCsv: InvLibInvoke;
    /** канал „catalog:exportMarc“ */
    exportMarc: InvLibInvoke;
    /** канал „catalog:exportDc“ */
    exportDc: InvLibInvoke;
    /** канал „catalog:updateGh“ */
    updateGh: InvLibInvoke;
    /** канал „catalog:gitPublishNow“ */
    gitPublishNow: InvLibInvoke;
    /** канал „catalog:remoteCheck“ */
    remoteCheck: InvLibInvoke;
  };
}
