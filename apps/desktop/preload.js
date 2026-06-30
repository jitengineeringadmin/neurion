const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neurion', {
  isDesktop: true,
  pickFolder: (initial) => ipcRenderer.invoke('pick-folder', initial),
  node: {
    status: () => ipcRenderer.invoke('node:status'),
    start: (creds) => ipcRenderer.invoke('node:start', creds),
    stop: () => ipcRenderer.invoke('node:stop'),
  },
});
