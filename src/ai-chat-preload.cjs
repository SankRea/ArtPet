const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arkpetChat', {
  getState: () => ipcRenderer.invoke('ai-chat:get-state'),
  send: message => ipcRenderer.invoke('ai-chat:send', message),
  clear: () => ipcRenderer.invoke('ai-chat:clear'),
  openSource: () => ipcRenderer.send('ai-chat:open-source'),
  onState: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('ai-chat:state', listener);
    return () => ipcRenderer.removeListener('ai-chat:state', listener);
  }
});
