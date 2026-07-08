const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  testConnection: (creds) => ipcRenderer.invoke('jira:test', creds),
  pickFolder: () => ipcRenderer.invoke('jira:pickFolder'),
  startDownload: (payload) => ipcRenderer.invoke('jira:download', payload),
  cancelDownload: () => ipcRenderer.invoke('jira:cancel'),
  openFolder: (folder) => ipcRenderer.invoke('jira:openFolder', folder),
  openExternal: (url) => ipcRenderer.invoke('jira:openExternal', url),
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download:progress', listener);
    return () => ipcRenderer.removeListener('download:progress', listener);
  }
});
