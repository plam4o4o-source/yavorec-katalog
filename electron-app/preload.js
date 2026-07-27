const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  app: {
    setUser: invoke('app:setUser'),
    getUser: invoke('app:getUser')
  },
  settings: {
    get: invoke('settings:get'),
    update: invoke('settings:update')
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
    checks: invoke('books:checks')
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
    create: invoke('readers:create'),
    update: invoke('readers:update'),
    delete: invoke('readers:delete')
  },
  loans: {
    list: invoke('loans:list'),
    overdue: invoke('loans:overdue'),
    checkout: invoke('loans:checkout'),
    return: invoke('loans:return'),
    extend: invoke('loans:extend')
  },
  dashboard: {
    stats: invoke('dashboard:stats')
  },
  inventorySessions: {
    list: invoke('inventorySessions:list'),
    requirement: invoke('inventorySessions:requirement'),
    start: invoke('inventorySessions:start'),
    get: invoke('inventorySessions:get'),
    scan: invoke('inventorySessions:scan'),
    close: invoke('inventorySessions:close')
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
  audit: {
    list: invoke('audit:list')
  },
  visits: {
    add: invoke('visits:add')
  },
  stats: {
    report: invoke('stats:report')
  },
  catalog: {
    export: invoke('catalog:export')
  }
});
