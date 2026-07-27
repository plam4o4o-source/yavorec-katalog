const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  categories: {
    list: invoke('categories:list'),
    create: invoke('categories:create'),
    update: invoke('categories:update'),
    delete: invoke('categories:delete')
  },
  books: {
    list: invoke('books:list'),
    get: invoke('books:get'),
    create: invoke('books:create'),
    update: invoke('books:update'),
    delete: invoke('books:delete')
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
    checkout: invoke('loans:checkout'),
    return: invoke('loans:return')
  },
  dashboard: {
    stats: invoke('dashboard:stats')
  }
});
