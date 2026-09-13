const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('arkpet', {
  getState: () => ipcRenderer.invoke('pet:get-state'),
  settings: (patch, id) => ipcRenderer.send('pet:settings', { patch, id }),
  action: (action, id) => ipcRenderer.send('pet:action', { action, id }),
  interact: () => ipcRenderer.send('pet:interact'),
  walk: (direction, id) => ipcRenderer.send('pet:walk', { direction, id }),
  form: (form, id) => ipcRenderer.send('pet:form', { form, id }),
  command: (command, id) => ipcRenderer.send('pet:command', { command, id }),
  addPet: modelId => ipcRenderer.invoke('launcher:model', { mode: 'add', modelId }),
  replacePet: (modelId, id) => ipcRenderer.invoke('launcher:model', { mode: 'replace', modelId, id }),
  setMaxPets: value => ipcRenderer.invoke('launcher:limit', value),
  setProxy: (address, port) => ipcRenderer.invoke('launcher:proxy', { address, port }),
  downloadVoice: id => ipcRenderer.invoke('launcher:voice-download', id),
  playVoice: (clipId, id) => ipcRenderer.send('pet:voice-play', { clipId, id }),
  openVoiceTextSource: id => ipcRenderer.send('pet:voice-text-source', id),
  voiceCaption: data => ipcRenderer.send('pet:voice-caption', data),
  stopVoice: id => ipcRenderer.send('pet:voice-stop', id),
  voiceError: (modelId, message) => ipcRenderer.send('pet:voice-error', { modelId, message }),
  cancelDownload: () => ipcRenderer.send('launcher:cancel-download'),
  selectPet: id => ipcRenderer.send('launcher:select', id),
  detach: () => ipcRenderer.send('launcher:detach'),
  ready: data => ipcRenderer.send('pet:ready', data),
  error: message => ipcRenderer.send('pet:error', message),
  geometry: data => ipcRenderer.send('pet:geometry', data),
  hitRects: rects => ipcRenderer.send('pet:hit-rects', rects),
  startDrag: () => ipcRenderer.send('pet:drag-start'),
  endDrag: cancelled => ipcRenderer.send('pet:drag-end', cancelled),
  contextMenu: () => ipcRenderer.send('pet:context-menu'),
  onState: callback => subscribe('pet:state', callback),
  onLauncherState: callback => subscribe('launcher:state', callback),
  onLauncherProgress: callback => subscribe('launcher:progress', callback),
  onAction: callback => subscribe('pet:action', callback),
  onVoice: callback => subscribe('pet:voice-play', callback),
  onVoiceStop: callback => subscribe('pet:voice-stop', callback),
  onForm: callback => subscribe('pet:form', callback),
  onMotion: callback => subscribe('pet:motion', callback),
  onDragging: callback => subscribe('pet:dragging', callback),
  onDragEnd: callback => subscribe('pet:drag-end', callback)
});
