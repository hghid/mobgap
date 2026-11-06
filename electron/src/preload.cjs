const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mobgap', Object.freeze({
  chooseCsv: () => ipcRenderer.invoke('csv:choose'),
  saveResults: (text) => ipcRenderer.invoke('results:save', text),
}));
