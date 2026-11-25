const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wbapi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (payload) => ipcRenderer.invoke('set-config', payload),
  close: () => ipcRenderer.invoke('close-settings')
});
