const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mobgap', Object.freeze({
  chooseCsv: () => ipcRenderer.invoke('csv:choose'),
  saveResults: (text) => ipcRenderer.invoke('results:save', text),
  saveTableCsv: (payload) => ipcRenderer.invoke('results:save-csv', payload),
  openWebsite: (site) => ipcRenderer.invoke('website:open', site),
}));
