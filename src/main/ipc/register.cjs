function registerHandlers({ ipcMain, app, shell, pets, petsByWebContents, getLauncher, launcherState,
  openLauncher, closePet, selectModel, updateModelCatalog, updateLimit, updateProxy, updateAi,
  aiClient, clearAiKey, updateAutoStart, downloadVoice, voices, cancelDownload, selectPet, aiChats }) {
  function senderPet(event) {
    const pet = petsByWebContents.get(event.sender.id);
    return pet?.win?.webContents === event.sender ? pet : undefined;
  }
  function trusted(event) { return event.senderFrame === event.sender.mainFrame && (Boolean(senderPet(event)) || event.sender === getLauncher()?.webContents); }
  function target(event, id) { return trusted(event) ? senderPet(event) || pets.get(id) : undefined; }
  ipcMain.handle('pet:get-state', event => trusted(event) ? senderPet(event)?.state() || launcherState() : null);
  ipcMain.on('pet:settings', (event, { patch, id } = {}) => target(event, id)?.updateSettings(patch));
  ipcMain.on('pet:action', (event, { action, id } = {}) => target(event, id)?.act(action));
  ipcMain.on('pet:interact', event => { if (trusted(event)) senderPet(event)?.interact(); });
  ipcMain.on('pet:walk', (event, { direction, id } = {}) => target(event, id)?.startWalking(direction));
  ipcMain.on('pet:form', (event, { form, id } = {}) => target(event, id)?.setForm(form));
  ipcMain.on('pet:command', (event, { command, id } = {}) => {
    const pet = target(event, id);
    if (!trusted(event)) return;
    if (command === 'settings') { openLauncher(pet?.id); return; }
    if (command === 'quit-all') { app.quit(); return; }
    if (!pet) return;
    const commands = { visibility: () => pet.toggleVisible(), reset: () => pet.reset(), pause: () => pet.togglePause(), reload: () => pet.reload(), quit: () => closePet(pet.id) };
    if (Object.hasOwn(commands, command)) commands[command]();
  });
  ipcMain.handle('launcher:model', (event, request) => trusted(event) && event.sender === getLauncher()?.webContents && request ? selectModel(request) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:catalog-update', (event, action) => trusted(event) && event.sender === getLauncher()?.webContents ? updateModelCatalog(action) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:limit', (event, value) => trusted(event) && event.sender === getLauncher()?.webContents ? updateLimit(value) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:proxy', (event, value) => trusted(event) && event.sender === getLauncher()?.webContents ? updateProxy(value) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:ai-settings', (event, value) => trusted(event) && event.sender === getLauncher()?.webContents ? updateAi(value) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:ai-models', (event, value) => trusted(event) && event.sender === getLauncher()?.webContents ? aiClient.listModels(value) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:ai-test', (event, value) => trusted(event) && event.sender === getLauncher()?.webContents ? aiClient.test(value) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:ai-key-clear', event => trusted(event) && event.sender === getLauncher()?.webContents ? clearAiKey() : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:auto-start', (event, value) => trusted(event) && event.sender === getLauncher()?.webContents ? updateAutoStart(value) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:voice-download', (event, id) => trusted(event) && event.sender === getLauncher()?.webContents ? downloadVoice(id) : { ok: false, error: '请求无效。' });
  ipcMain.on('pet:voice-play', (event, { clipId, id } = {}) => {
    const pet = target(event, id);
    if (pet?.settings.voiceEnabled && pet.ready && voices.state(pet.model.id).cached && voices.state(pet.model.id).clips.some(clip => clip.id === clipId)) pet.send('pet:voice-play', clipId);
  });
  ipcMain.on('pet:voice-stop', (event, id) => target(event, id)?.stopVoice());
  ipcMain.on('pet:voice-text-source', (event, id) => {
    const pet = target(event, id), url = pet && voices.textSource(pet.model.id);
    if (url) shell.openExternal(url).catch(() => {});
  });
  ipcMain.on('pet:voice-caption', (event, data) => { if (trusted(event)) senderPet(event)?.showVoiceCaption(data); });
  ipcMain.on('caption:resize', (event, data) => {
    if (event.senderFrame !== event.sender.mainFrame) return;
    for (const pet of pets.values()) if (pet.caption.win?.webContents === event.sender) { pet.caption.resize(data); break; }
  });
  ipcMain.on('pet:voice-error', (event, { modelId, message } = {}) => {
    const pet = senderPet(event);
    if (trusted(event) && pet && pet.model.id === modelId) {
      pet.voiceError = String(message || '').slice(0, 300);
      if (pet.voiceError) voices.invalidate(modelId);
      pet.changed();
    }
  });
  ipcMain.on('launcher:cancel-download', event => { if (trusted(event) && event.sender === getLauncher()?.webContents) cancelDownload(); });
  ipcMain.on('launcher:select', (event, id) => { if (trusted(event) && event.sender === getLauncher()?.webContents && pets.has(id)) { selectPet(id); } });
  ipcMain.on('launcher:detach', event => { if (trusted(event) && event.sender === getLauncher()?.webContents) getLauncher().close(); });
  ipcMain.on('pet:ready', (event, data) => { if (trusted(event)) senderPet(event)?.loaded(data); });
  ipcMain.on('pet:error', (event, message) => { const pet = senderPet(event); if (trusted(event) && pet) { pet.ready = false; pet.error = String(message).slice(0, 500); pet.changed(); } });
  ipcMain.on('pet:geometry', (event, data) => { if (trusted(event)) senderPet(event)?.setGeometry(data); });
  ipcMain.on('pet:hit-rects', (event, rects) => {
    const pet = senderPet(event);
    if (!trusted(event) || !pet || !Array.isArray(rects)) return;
    pet.hitRects = rects.slice(0, 10).filter(rect => rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0);
  });
  ipcMain.on('pet:drag-start', event => { if (trusted(event)) senderPet(event)?.startDrag(); });
  ipcMain.on('pet:drag-end', (event, cancelled) => { if (trusted(event)) senderPet(event)?.endDrag(Boolean(cancelled)); });
  ipcMain.on('pet:context-menu', event => { if (trusted(event)) senderPet(event)?.contextMenu(); });
  aiChats.register(ipcMain);
}

module.exports = { registerHandlers };
