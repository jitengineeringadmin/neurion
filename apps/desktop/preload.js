const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neurion', {
  isDesktop: true,
  pickFolder: (initial) => ipcRenderer.invoke('pick-folder', initial),
  pickModel: () => ipcRenderer.invoke('pick-model'),
  // Start a local ollama the user already installed. Neurion runs its own engine
  // and does not need ollama — but when someone has one sitting there with models
  // already downloaded, refusing to start it just strands them.
  startOllama: () => ipcRenderer.invoke('ollama:start'),
  node: {
    status: () => ipcRenderer.invoke('node:status'),
    start: (creds) => ipcRenderer.invoke('node:start', creds),
    stop: () => ipcRenderer.invoke('node:stop'),
  },
});
