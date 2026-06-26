const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neurion', {
  isDesktop: true,
  pickFolder: (initial) => ipcRenderer.invoke('pick-folder', initial),
});
