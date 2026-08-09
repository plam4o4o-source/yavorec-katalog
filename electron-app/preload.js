const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  app: {
    setUser: invoke('app:setUser'),
    getUser: invoke('app:getUser'),
    getVersion: invoke('app:getVersion'),
    checkForUpdates: invoke('app:checkForUpdates'),
    installUpdate: invoke('app:installUpdate'),
    openLogsFolder: invoke('app:openLogsFolder'),
    onUpdateStatus: (cb) => ipcRenderer.on('update:status', (e, data) => cb(data))
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
    restoreBrowse: invoke('backup:restoreBrowse')
  },
  limits: {
    usage: invoke('limits:usage'),
    update: invoke('limits:update')
  },
  categories: {
    list: invoke('categories:list'),
    create: invoke('categories:create'),
    update: invoke('categories:update'),
    delete: invoke('categories:delete')
  },
  books: {
    list: invoke('books:list'),
    get: invoke('books:get'),
    byBarcode: invoke('books:byBarcode'),
    create: invoke('books:create'),
    update: invoke('books:update'),
    delete: invoke('books:delete'),
    addCheck: invoke('books:addCheck'),
    checks: invoke('books:checks'),
    bulkUpdate: invoke('books:bulkUpdate')
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
    delete: invoke('acquisitions:delete')
  },
  deaccessionActs: {
    list: invoke('deaccessionActs:list'),
    get: invoke('deaccessionActs:get'),
    nextNo: invoke('deaccessionActs:nextNo'),
    findBook: invoke('deaccessionActs:findBook'),
    create: invoke('deaccessionActs:create'),
    revoke: invoke('deaccessionActs:revoke')
  },
  kdbf: {
    report: invoke('kdbf:report')
  },
  readers: {
    list: invoke('readers:list'),
    get: invoke('readers:get'),
    byCard: invoke('readers:byCard'),
    create: invoke('readers:create'),
    update: invoke('readers:update'),
    delete: invoke('readers:delete'),
    clearSuspension: invoke('readers:clearSuspension')
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
    delete: invoke('suggestions:delete')
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
    anonymize: invoke('gdpr:anonymize')
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
    run: invoke('import:run')
  },
  mobile: {
    generate: invoke('mobile:generate')
  },
  security: {
    exclusionInfo: invoke('security:exclusionInfo'),
    writeExclusionScript: invoke('security:writeExclusionScript')
  },
  audit: {
    list: invoke('audit:list')
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
    add: invoke('visits:add')
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
