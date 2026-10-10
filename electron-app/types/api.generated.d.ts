// ГЕНЕРИРАН ФАЙЛ — не се пише на ръка. Източник: preload.js.
// Обновяване: npm run gen:api-types (виж scripts/gen-api-types.js).

/** Методът през ipcRenderer.invoke — връща каквото върне обработчикът в главния процес. */
type InvLibInvoke = (...args: any[]) => Promise<any>;

interface InvLibApi {
  app: {
    /** канал „app:setUser“ */
    setUser: IpcMethod<'app:setUser'>;
    /** канал „app:getUser“ */
    getUser: IpcMethod<'app:getUser'>;
    /** канал „app:getVersion“ */
    getVersion: IpcMethod<'app:getVersion'>;
    /** канал „app:checkForUpdates“ */
    checkForUpdates: IpcMethod<'app:checkForUpdates'>;
    /** канал „app:installUpdate“ */
    installUpdate: IpcMethod<'app:installUpdate'>;
    /** канал „app:openLogsFolder“ */
    openLogsFolder: IpcMethod<'app:openLogsFolder'>;
    onUpdateStatus: (...args: any[]) => any;
    onUserChanged: (...args: any[]) => any;
  };
  employees: {
    /** канал „employees:list“ */
    list: IpcMethod<'employees:list'>;
    /** канал „employees:create“ */
    create: IpcMethod<'employees:create'>;
    /** канал „employees:update“ */
    update: IpcMethod<'employees:update'>;
    /** канал „employees:delete“ */
    delete: IpcMethod<'employees:delete'>;
  };
  settings: {
    /** канал „settings:get“ */
    get: IpcMethod<'settings:get'>;
    /** канал „settings:update“ */
    update: IpcMethod<'settings:update'>;
    /** канал „settings:updateLabelFormat“ */
    updateLabelFormat: IpcMethod<'settings:updateLabelFormat'>;
    /** канал „settings:updateTheme“ */
    updateTheme: IpcMethod<'settings:updateTheme'>;
    /** канал „settings:updateScanSound“ */
    updateScanSound: IpcMethod<'settings:updateScanSound'>;
    /** канал „settings:chooseLogo“ */
    chooseLogo: IpcMethod<'settings:chooseLogo'>;
    /** канал „settings:clearLogo“ */
    clearLogo: IpcMethod<'settings:clearLogo'>;
    /** канал „settings:updateNotices“ */
    updateNotices: IpcMethod<'settings:updateNotices'>;
    /** канал „settings:noticeDefaults“ */
    noticeDefaults: IpcMethod<'settings:noticeDefaults'>;
  };
  dbLocation: {
    /** канал „dbLocation:get“ */
    get: IpcMethod<'dbLocation:get'>;
    /** канал „dbLocation:choose“ */
    choose: IpcMethod<'dbLocation:choose'>;
    /** канал „dbLocation:resetDefault“ */
    resetDefault: IpcMethod<'dbLocation:resetDefault'>;
  };
  backup: {
    /** канал „backup:list“ */
    list: IpcMethod<'backup:list'>;
    /** канал „backup:now“ */
    now: IpcMethod<'backup:now'>;
    /** канал „backup:restoreFromList“ */
    restoreFromList: IpcMethod<'backup:restoreFromList'>;
    /** канал „backup:restoreBrowse“ */
    restoreBrowse: IpcMethod<'backup:restoreBrowse'>;
    /** канал „backup:autoStatus“ */
    autoStatus: IpcMethod<'backup:autoStatus'>;
    /** канал „backup:secondFolder“ */
    secondFolder: IpcMethod<'backup:secondFolder'>;
    /** канал „backup:chooseSecondFolder“ */
    chooseSecondFolder: IpcMethod<'backup:chooseSecondFolder'>;
    /** канал „backup:clearSecondFolder“ */
    clearSecondFolder: IpcMethod<'backup:clearSecondFolder'>;
    onAutoStatus: (...args: any[]) => any;
  };
  limits: {
    /** канал „limits:usage“ */
    usage: IpcMethod<'limits:usage'>;
    /** канал „limits:update“ */
    update: IpcMethod<'limits:update'>;
  };
  authorMark: {
    /** канал „authorMark:status“ */
    status: IpcMethod<'authorMark:status'>;
    /** канал „authorMark:choose“ */
    choose: IpcMethod<'authorMark:choose'>;
    /** канал „authorMark:confirm“ */
    confirm: IpcMethod<'authorMark:confirm'>;
    /** канал „authorMark:clear“ */
    clear: IpcMethod<'authorMark:clear'>;
    /** канал „authorMark:loadBuiltin“ */
    loadBuiltin: IpcMethod<'authorMark:loadBuiltin'>;
    /** канал „authorMark:suggest“ */
    suggest: IpcMethod<'authorMark:suggest'>;
    /** канал „authorMark:audit“ */
    audit: IpcMethod<'authorMark:audit'>;
    /** канал „authorMark:fillPreview“ */
    fillPreview: IpcMethod<'authorMark:fillPreview'>;
    /** канал „authorMark:fillApply“ */
    fillApply: IpcMethod<'authorMark:fillApply'>;
  };
  categories: {
    /** канал „categories:list“ */
    list: IpcMethod<'categories:list'>;
    /** канал „categories:create“ */
    create: IpcMethod<'categories:create'>;
    /** канал „categories:update“ */
    update: IpcMethod<'categories:update'>;
    /** канал „categories:usage“ */
    usage: IpcMethod<'categories:usage'>;
    /** канал „categories:delete“ */
    delete: IpcMethod<'categories:delete'>;
  };
  books: {
    /** канал „books:list“ */
    list: IpcMethod<'books:list'>;
    /** канал „books:get“ */
    get: IpcMethod<'books:get'>;
    /** канал „books:byBarcode“ */
    byBarcode: IpcMethod<'books:byBarcode'>;
    /** канал „books:create“ */
    create: IpcMethod<'books:create'>;
    /** канал „books:update“ */
    update: IpcMethod<'books:update'>;
    /** канал „books:delete“ */
    delete: IpcMethod<'books:delete'>;
    /** канал „books:addCheck“ */
    addCheck: IpcMethod<'books:addCheck'>;
    /** канал „books:checks“ */
    checks: IpcMethod<'books:checks'>;
    /** канал „books:bulkUpdate“ */
    bulkUpdate: IpcMethod<'books:bulkUpdate'>;
    /** канал „books:findDuplicateBarcodes“ */
    findDuplicateBarcodes: IpcMethod<'books:findDuplicateBarcodes'>;
    /** канал „books:multiCopyRecords“ */
    multiCopyRecords: IpcMethod<'books:multiCopyRecords'>;
    /** канал „books:splitCopies“ */
    splitCopies: IpcMethod<'books:splitCopies'>;
    /** канал „books:splitCopiesBatch“ */
    splitCopiesBatch: IpcMethod<'books:splitCopiesBatch'>;
    /** канал „books:setLendable“ */
    setLendable: IpcMethod<'books:setLendable'>;
    /** канал „books:deaccessionedWithoutAct“ */
    deaccessionedWithoutAct: IpcMethod<'books:deaccessionedWithoutAct'>;
    /** канал „books:clearOrphanDeaccession“ */
    clearOrphanDeaccession: IpcMethod<'books:clearOrphanDeaccession'>;
    /** канал „books:byIsbn“ */
    byIsbn: IpcMethod<'books:byIsbn'>;
    /** канал „books:invGaps“ */
    invGaps: IpcMethod<'books:invGaps'>;
  };
  isbn: {
    /** канал „isbn:lookup“ */
    lookup: IpcMethod<'isbn:lookup'>;
  };
  sru: {
    /** канал „sru:lookup“ */
    lookup: IpcMethod<'sru:lookup'>;
  };
  authorities: {
    /** канал „authorities:fields“ */
    fields: IpcMethod<'authorities:fields'>;
    /** канал „authorities:list“ */
    list: IpcMethod<'authorities:list'>;
    /** канал „authorities:suggest“ */
    suggest: IpcMethod<'authorities:suggest'>;
    /** канал „authorities:duplicates“ */
    duplicates: IpcMethod<'authorities:duplicates'>;
    /** канал „authorities:merge“ */
    merge: IpcMethod<'authorities:merge'>;
  };
  invBook: {
    /** канал „invBook:list“ */
    list: IpcMethod<'invBook:list'>;
  };
  acquisitions: {
    /** канал „acquisitions:list“ */
    list: IpcMethod<'acquisitions:list'>;
    /** канал „acquisitions:get“ */
    get: IpcMethod<'acquisitions:get'>;
    /** канал „acquisitions:nextNo“ */
    nextNo: IpcMethod<'acquisitions:nextNo'>;
    /** канал „acquisitions:create“ */
    create: IpcMethod<'acquisitions:create'>;
    /** канал „acquisitions:update“ */
    update: IpcMethod<'acquisitions:update'>;
    /** канал „acquisitions:delete“ */
    delete: IpcMethod<'acquisitions:delete'>;
  };
  deaccessionActs: {
    /** канал „deaccessionActs:list“ */
    list: IpcMethod<'deaccessionActs:list'>;
    /** канал „deaccessionActs:get“ */
    get: IpcMethod<'deaccessionActs:get'>;
    /** канал „deaccessionActs:nextNo“ */
    nextNo: IpcMethod<'deaccessionActs:nextNo'>;
    /** канал „deaccessionActs:findBook“ */
    findBook: IpcMethod<'deaccessionActs:findBook'>;
    /** канал „deaccessionActs:create“ */
    create: IpcMethod<'deaccessionActs:create'>;
    /** канал „deaccessionActs:revoke“ */
    revoke: IpcMethod<'deaccessionActs:revoke'>;
    /** канал „deaccessionActs:drafts“ */
    drafts: IpcMethod<'deaccessionActs:drafts'>;
    /** канал „deaccessionActs:getDraft“ */
    getDraft: IpcMethod<'deaccessionActs:getDraft'>;
    /** канал „deaccessionActs:saveDraft“ */
    saveDraft: IpcMethod<'deaccessionActs:saveDraft'>;
    /** канал „deaccessionActs:deleteDraft“ */
    deleteDraft: IpcMethod<'deaccessionActs:deleteDraft'>;
    /** канал „deaccessionActs:approveDraft“ */
    approveDraft: IpcMethod<'deaccessionActs:approveDraft'>;
  };
  kdbf: {
    /** канал „kdbf:report“ */
    report: IpcMethod<'kdbf:report'>;
  };
  fund: {
    /** канал „fund:check“ */
    check: IpcMethod<'fund:check'>;
    /** канал „fund:checkLogged“ */
    checkLogged: IpcMethod<'fund:checkLogged'>;
  };
  print: {
    /** канал „print:savePdf“ */
    savePdf: IpcMethod<'print:savePdf'>;
  };
  readers: {
    /** канал „readers:list“ */
    list: IpcMethod<'readers:list'>;
    /** канал „readers:get“ */
    get: IpcMethod<'readers:get'>;
    /** канал „readers:byCard“ */
    byCard: IpcMethod<'readers:byCard'>;
    /** канал „readers:create“ */
    create: IpcMethod<'readers:create'>;
    /** канал „readers:update“ */
    update: IpcMethod<'readers:update'>;
    /** канал „readers:delete“ */
    delete: IpcMethod<'readers:delete'>;
    /** канал „readers:clearSuspension“ */
    clearSuspension: IpcMethod<'readers:clearSuspension'>;
    /** канал „readers:exportCsv“ */
    exportCsv: IpcMethod<'readers:exportCsv'>;
    /** канал „readers:mzsHeld“ */
    mzsHeld: IpcMethod<'readers:mzsHeld'>;
  };
  exportAll: {
    /** канал „exportAll:run“ */
    run: IpcMethod<'exportAll:run'>;
  };
  pdp: {
    /** канал „pdp:status“ */
    status: IpcMethod<'pdp:status'>;
    /** канал „pdp:setup“ */
    setup: IpcMethod<'pdp:setup'>;
    /** канал „pdp:unlock“ */
    unlock: IpcMethod<'pdp:unlock'>;
    /** канал „pdp:lock“ */
    lock: IpcMethod<'pdp:lock'>;
    /** канал „pdp:changePassword“ */
    changePassword: IpcMethod<'pdp:changePassword'>;
  };
  account: {
    /** канал „account:get“ */
    get: IpcMethod<'account:get'>;
    /** канал „account:charge“ */
    charge: IpcMethod<'account:charge'>;
    /** канал „account:pay“ */
    pay: IpcMethod<'account:pay'>;
    /** канал „account:deleteLine“ */
    deleteLine: IpcMethod<'account:deleteLine'>;
  };
  suggestions: {
    /** канал „suggestions:list“ */
    list: IpcMethod<'suggestions:list'>;
    /** канал „suggestions:create“ */
    create: IpcMethod<'suggestions:create'>;
    /** канал „suggestions:setStatus“ */
    setStatus: IpcMethod<'suggestions:setStatus'>;
    /** канал „suggestions:delete“ */
    delete: IpcMethod<'suggestions:delete'>;
    /** канал „suggestions:matchBook“ */
    matchBook: IpcMethod<'suggestions:matchBook'>;
  };
  circRules: {
    /** канал „circRules:list“ */
    list: IpcMethod<'circRules:list'>;
    /** канал „circRules:save“ */
    save: IpcMethod<'circRules:save'>;
    /** канал „circRules:delete“ */
    delete: IpcMethod<'circRules:delete'>;
    /** канал „circRules:effective“ */
    effective: IpcMethod<'circRules:effective'>;
  };
  calendar: {
    /** канал „calendar:get“ */
    get: IpcMethod<'calendar:get'>;
    /** канал „calendar:saveWorkDays“ */
    saveWorkDays: IpcMethod<'calendar:saveWorkDays'>;
    /** канал „calendar:addClosed“ */
    addClosed: IpcMethod<'calendar:addClosed'>;
    /** канал „calendar:removeClosed“ */
    removeClosed: IpcMethod<'calendar:removeClosed'>;
  };
  housebound: {
    /** канал „housebound:get“ */
    get: IpcMethod<'housebound:get'>;
    /** канал „housebound:save“ */
    save: IpcMethod<'housebound:save'>;
    /** канал „housebound:remove“ */
    remove: IpcMethod<'housebound:remove'>;
    /** канал „housebound:addVisit“ */
    addVisit: IpcMethod<'housebound:addVisit'>;
    /** канал „housebound:list“ */
    list: IpcMethod<'housebound:list'>;
  };
  gdpr: {
    /** канал „gdpr:candidates“ */
    candidates: IpcMethod<'gdpr:candidates'>;
    /** канал „gdpr:anonymize“ */
    anonymize: IpcMethod<'gdpr:anonymize'>;
    /** канал „gdpr:forgetReader“ */
    forgetReader: IpcMethod<'gdpr:forgetReader'>;
  };
  online: {
    /** канал „online:status“ */
    status: IpcMethod<'online:status'>;
    /** канал „online:activate“ */
    activate: IpcMethod<'online:activate'>;
    /** канал „online:deactivate“ */
    deactivate: IpcMethod<'online:deactivate'>;
    /** канал „online:updateSettings“ */
    updateSettings: IpcMethod<'online:updateSettings'>;
    /** канал „online:setReaderConsent“ */
    setReaderConsent: IpcMethod<'online:setReaderConsent'>;
    /** канал „online:issuePin“ */
    issuePin: IpcMethod<'online:issuePin'>;
    /** канал „online:revokePin“ */
    revokePin: IpcMethod<'online:revokePin'>;
    /** канал „online:syncNow“ */
    syncNow: IpcMethod<'online:syncNow'>;
    /** канал „online:messages“ */
    messages: IpcMethod<'online:messages'>;
    /** канал „online:sendMessage“ */
    sendMessage: IpcMethod<'online:sendMessage'>;
    /** канал „online:withdrawMessage“ */
    withdrawMessage: IpcMethod<'online:withdrawMessage'>;
  };
  av: {
    /** канал „av:categories“ */
    categories: IpcMethod<'av:categories'>;
    /** канал „av:options“ */
    options: IpcMethod<'av:options'>;
    /** канал „av:save“ */
    save: IpcMethod<'av:save'>;
  };
  events: {
    /** канал „events:localuse“ */
    localuse: IpcMethod<'events:localuse'>;
  };
  notices: {
    /** канал „notices:log“ */
    log: IpcMethod<'notices:log'>;
  };
  loans: {
    /** канал „loans:list“ */
    list: IpcMethod<'loans:list'>;
    /** канал „loans:overdue“ */
    overdue: IpcMethod<'loans:overdue'>;
    /** канал „loans:overdueByReader“ */
    overdueByReader: IpcMethod<'loans:overdueByReader'>;
    /** канал „loans:byReader“ */
    byReader: IpcMethod<'loans:byReader'>;
    /** канал „loans:byBook“ */
    byBook: IpcMethod<'loans:byBook'>;
    /** канал „loans:checkout“ */
    checkout: IpcMethod<'loans:checkout'>;
    /** канал „loans:checkoutByCode“ */
    checkoutByCode: IpcMethod<'loans:checkoutByCode'>;
    /** канал „loans:return“ */
    return: IpcMethod<'loans:return'>;
    /** канал „loans:returnByCode“ */
    returnByCode: IpcMethod<'loans:returnByCode'>;
    /** канал „loans:extend“ */
    extend: IpcMethod<'loans:extend'>;
    /** канал „loans:markLost“ */
    markLost: IpcMethod<'loans:markLost'>;
    /** канал „loans:lostQuote“ */
    lostQuote: IpcMethod<'loans:lostQuote'>;
    /** канал „loans:lost“ */
    lost: IpcMethod<'loans:lost'>;
    /** канал „loans:found“ */
    found: IpcMethod<'loans:found'>;
    /** канал „loans:lostPolicy“ */
    lostPolicy: IpcMethod<'loans:lostPolicy'>;
    /** канал „loans:lostPolicySave“ */
    lostPolicySave: IpcMethod<'loans:lostPolicySave'>;
    /** канал „loans:reminders“ */
    reminders: IpcMethod<'loans:reminders'>;
    /** канал „loans:mailto“ */
    mailto: IpcMethod<'loans:mailto'>;
  };
  holds: {
    /** канал „holds:list“ */
    list: IpcMethod<'holds:list'>;
    /** канал „holds:add“ */
    add: IpcMethod<'holds:add'>;
    /** канал „holds:cancel“ */
    cancel: IpcMethod<'holds:cancel'>;
  };
  dashboard: {
    /** канал „dashboard:stats“ */
    stats: IpcMethod<'dashboard:stats'>;
    /** канал „dashboard:full“ */
    full: IpcMethod<'dashboard:full'>;
  };
  inventorySessions: {
    /** канал „inventorySessions:list“ */
    list: IpcMethod<'inventorySessions:list'>;
    /** канал „inventorySessions:requirement“ */
    requirement: IpcMethod<'inventorySessions:requirement'>;
    /** канал „inventorySessions:start“ */
    start: IpcMethod<'inventorySessions:start'>;
    /** канал „inventorySessions:get“ */
    get: IpcMethod<'inventorySessions:get'>;
    /** канал „inventorySessions:scan“ */
    scan: IpcMethod<'inventorySessions:scan'>;
    /** канал „inventorySessions:close“ */
    close: IpcMethod<'inventorySessions:close'>;
    /** канал „inventorySessions:importScans“ */
    importScans: IpcMethod<'inventorySessions:importScans'>;
  };
  periodicals: {
    /** канал „periodicals:list“ */
    list: IpcMethod<'periodicals:list'>;
    /** канал „periodicals:get“ */
    get: IpcMethod<'periodicals:get'>;
    /** канал „periodicals:create“ */
    create: IpcMethod<'periodicals:create'>;
    /** канал „periodicals:update“ */
    update: IpcMethod<'periodicals:update'>;
    /** канал „periodicals:delete“ */
    delete: IpcMethod<'periodicals:delete'>;
  };
  periodicalIssues: {
    /** канал „periodicalIssues:add“ */
    add: IpcMethod<'periodicalIssues:add'>;
    /** канал „periodicalIssues:delete“ */
    delete: IpcMethod<'periodicalIssues:delete'>;
  };
  periodicalVolumes: {
    /** канал „periodicalVolumes:register“ */
    register: IpcMethod<'periodicalVolumes:register'>;
  };
  mzs: {
    /** канал „mzs:list“ */
    list: IpcMethod<'mzs:list'>;
    /** канал „mzs:nextNo“ */
    nextNo: IpcMethod<'mzs:nextNo'>;
    /** канал „mzs:create“ */
    create: IpcMethod<'mzs:create'>;
    /** канал „mzs:update“ */
    update: IpcMethod<'mzs:update'>;
    /** канал „mzs:delete“ */
    delete: IpcMethod<'mzs:delete'>;
    /** канал „mzs:overdue“ */
    overdue: IpcMethod<'mzs:overdue'>;
  };
  analytics: {
    /** канал „analytics:list“ */
    list: IpcMethod<'analytics:list'>;
    /** канал „analytics:get“ */
    get: IpcMethod<'analytics:get'>;
    /** канал „analytics:years“ */
    years: IpcMethod<'analytics:years'>;
    /** канал „analytics:create“ */
    create: IpcMethod<'analytics:create'>;
    /** канал „analytics:update“ */
    update: IpcMethod<'analytics:update'>;
    /** канал „analytics:delete“ */
    delete: IpcMethod<'analytics:delete'>;
  };
  persons: {
    /** канал „persons:list“ */
    list: IpcMethod<'persons:list'>;
    /** канал „persons:get“ */
    get: IpcMethod<'persons:get'>;
    /** канал „persons:create“ */
    create: IpcMethod<'persons:create'>;
    /** канал „persons:update“ */
    update: IpcMethod<'persons:update'>;
    /** канал „persons:delete“ */
    delete: IpcMethod<'persons:delete'>;
  };
  chronicle: {
    /** канал „chronicle:list“ */
    list: IpcMethod<'chronicle:list'>;
    /** канал „chronicle:get“ */
    get: IpcMethod<'chronicle:get'>;
    /** канал „chronicle:years“ */
    years: IpcMethod<'chronicle:years'>;
    /** канал „chronicle:create“ */
    create: IpcMethod<'chronicle:create'>;
    /** канал „chronicle:update“ */
    update: IpcMethod<'chronicle:update'>;
    /** канал „chronicle:delete“ */
    delete: IpcMethod<'chronicle:delete'>;
  };
  links: {
    /** канал „links:list“ */
    list: IpcMethod<'links:list'>;
    /** канал „links:backlinks“ */
    backlinks: IpcMethod<'links:backlinks'>;
    /** канал „links:add“ */
    add: IpcMethod<'links:add'>;
    /** канал „links:delete“ */
    delete: IpcMethod<'links:delete'>;
    /** канал „links:search“ */
    search: IpcMethod<'links:search'>;
  };
  localPhoto: {
    /** канал „localPhoto:choose“ */
    choose: IpcMethod<'localPhoto:choose'>;
    /** канал „localPhoto:clear“ */
    clear: IpcMethod<'localPhoto:clear'>;
  };
  importData: {
    /** канал „import:choose“ */
    choose: IpcMethod<'import:choose'>;
    /** канал „import:load“ */
    load: IpcMethod<'import:load'>;
    /** канал „import:run“ */
    run: IpcMethod<'import:run'>;
    pathOf: (...args: any[]) => any;
  };
  mobile: {
    /** канал „mobile:generate“ */
    generate: IpcMethod<'mobile:generate'>;
    /** канал „mobile:sessionExport“ */
    sessionExport: IpcMethod<'mobile:sessionExport'>;
    /** канал „mobile:siteInfo“ */
    siteInfo: IpcMethod<'mobile:siteInfo'>;
  };
  security: {
    /** канал „security:exclusionInfo“ */
    exclusionInfo: IpcMethod<'security:exclusionInfo'>;
    /** канал „security:writeExclusionScript“ */
    writeExclusionScript: IpcMethod<'security:writeExclusionScript'>;
  };
  audit: {
    /** канал „audit:list“ */
    list: IpcMethod<'audit:list'>;
    /** канал „audit:export“ */
    export: IpcMethod<'audit:export'>;
  };
  reset: {
    /** канал „reset:plan“ */
    plan: IpcMethod<'reset:plan'>;
    /** канал „reset:wipe“ */
    wipe: IpcMethod<'reset:wipe'>;
  };
  searchHistory: {
    /** канал „searchHistory:log“ */
    log: IpcMethod<'searchHistory:log'>;
    /** канал „searchHistory:suggest“ */
    suggest: IpcMethod<'searchHistory:suggest'>;
  };
  dnevnik: {
    /** канал „dnevnik:getMonth“ */
    getMonth: IpcMethod<'dnevnik:getMonth'>;
    /** канал „dnevnik:saveDay“ */
    saveDay: IpcMethod<'dnevnik:saveDay'>;
    /** канал „dnevnik:suggest“ */
    suggest: IpcMethod<'dnevnik:suggest'>;
    /** канал „dnevnik:exportCsv“ */
    exportCsv: IpcMethod<'dnevnik:exportCsv'>;
  };
  visits: {
    /** канал „visits:add“ */
    add: IpcMethod<'visits:add'>;
    /** канал „visits:get“ */
    get: IpcMethod<'visits:get'>;
  };
  stats: {
    /** канал „stats:report“ */
    report: IpcMethod<'stats:report'>;
  };
  reports: {
    /** канал „reports:list“ */
    list: IpcMethod<'reports:list'>;
    /** канал „reports:run“ */
    run: IpcMethod<'reports:run'>;
  };
  shelves: {
    /** канал „shelves:list“ */
    list: IpcMethod<'shelves:list'>;
    /** канал „shelves:items“ */
    items: IpcMethod<'shelves:items'>;
    /** канал „shelves:create“ */
    create: IpcMethod<'shelves:create'>;
    /** канал „shelves:rename“ */
    rename: IpcMethod<'shelves:rename'>;
    /** канал „shelves:delete“ */
    delete: IpcMethod<'shelves:delete'>;
    /** канал „shelves:addBook“ */
    addBook: IpcMethod<'shelves:addBook'>;
    /** канал „shelves:addBooks“ */
    addBooks: IpcMethod<'shelves:addBooks'>;
    /** канал „shelves:removeBook“ */
    removeBook: IpcMethod<'shelves:removeBook'>;
  };
  catalog: {
    /** канал „catalog:status“ */
    status: IpcMethod<'catalog:status'>;
    /** канал „catalog:autoPushStatus“ */
    autoPushStatus: IpcMethod<'catalog:autoPushStatus'>;
    /** канал „catalog:chooseFolder“ */
    chooseFolder: IpcMethod<'catalog:chooseFolder'>;
    /** канал „catalog:disconnectFolder“ */
    disconnectFolder: IpcMethod<'catalog:disconnectFolder'>;
    /** канал „catalog:writeNow“ */
    writeNow: IpcMethod<'catalog:writeNow'>;
    /** канал „catalog:export“ */
    export: IpcMethod<'catalog:export'>;
    /** канал „catalog:exportCsv“ */
    exportCsv: IpcMethod<'catalog:exportCsv'>;
    /** канал „catalog:exportMarc“ */
    exportMarc: IpcMethod<'catalog:exportMarc'>;
    /** канал „catalog:exportDc“ */
    exportDc: IpcMethod<'catalog:exportDc'>;
    /** канал „catalog:updateGh“ */
    updateGh: IpcMethod<'catalog:updateGh'>;
    /** канал „catalog:gitPublishNow“ */
    gitPublishNow: IpcMethod<'catalog:gitPublishNow'>;
    /** канал „catalog:remoteCheck“ */
    remoteCheck: IpcMethod<'catalog:remoteCheck'>;
  };
}
