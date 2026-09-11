const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('voiceCaption', {
  onShow: callback => ipcRenderer.on('caption:show', (_event, data) => callback(data)),
  resize: data => ipcRenderer.send('caption:resize', data)
});
