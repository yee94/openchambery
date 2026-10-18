const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__OPENCHAMBER_DESKTOP__', {
  imageCache: {
    acquire: (input) => ipcRenderer.invoke('cache:acquire', input),
    append: (leaseId, bytes) => ipcRenderer.invoke('cache:append', leaseId, bytes),
    commit: (leaseId, mime) => ipcRenderer.invoke('cache:commit', leaseId, mime),
    release: (leaseId) => ipcRenderer.invoke('cache:release', leaseId),
  },
  virtualAsset: {
    create: (input) => ipcRenderer.invoke('stream:create', input),
    push: (id, bytes) => ipcRenderer.invoke('stream:push', id, bytes),
    finish: (id) => ipcRenderer.invoke('stream:finish', id),
    cancel: (id) => ipcRenderer.invoke('stream:cancel', id),
  },
});
