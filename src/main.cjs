const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, protocol, screen, globalShortcut, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PetWindow } = require('./pet-window.cjs');
const { DEFAULT_MODEL_ID, findModel } = require('./models.cjs');
const { ModelLibrary } = require('./model-library.cjs');
const { VoiceLibrary } = require('./voice-library.cjs');
const { DownloadClient, normaliseProxy, normaliseProxyParts, splitProxy } = require('./download-client.cjs');
const defaultConfig = require('../config.json');
const { WindowSurfaces } = require('./window-surfaces.cjs');
const { floors } = require('./physics.cjs');

const ROOT = path.join(__dirname, '..');
const AUTO_START_NAME = 'ArkPet Surtr';
const pets = new Map(), petsByWebContents = new Map(), petTrays = new Map();
let launcher, launcherTray, selectedId, settingsPath, saveTimer, loopTimer, changeTimer, trayIcon, fullscreenTimer;
let surfaces, quitting = false, lastTick = Date.now(), shortcutStatus = {};
let library, voices, downloads, modelOperation = null, maxPets = 1, proxyUrl = '';
let environment, loopRunning = false, nextSurfaceScan = 0, launcherCatalogRevision = -1, lastSavedText;
let dataDirectory, storageMode = 'system';
let fullscreenActive = false;
const exists = win => win && !win.isDestroyed();
protocol.registerSchemesAsPrivileged([{ scheme: 'arkpet', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('ArkPet Surtr');

function prepareDataDirectory() {
  const systemDirectory = app.getPath('userData');
  const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;
  if (!app.isPackaged || !portableDirectory || !path.isAbsolute(portableDirectory)) {
    dataDirectory = systemDirectory;
    storageMode = 'system';
    return;
  }
  const preferred = path.join(portableDirectory, 'ArkPet-data');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.R_OK | fs.constants.W_OK);
    dataDirectory = preferred;
    storageMode = 'portable';
  } catch (error) {
    console.warn(`便携版数据目录不可用，改用系统用户数据目录：${error.message}`);
    dataDirectory = systemDirectory;
    storageMode = 'fallback';
  }
}

function globalState() { return { shortcutStatus, windowDetection: { available: surfaces?.available || false, error: surfaces?.error || '' }, fullscreen: { active: fullscreenActive, available: surfaces?.available || false, error: surfaces?.fullscreenError || '' } }; }
function operationState() {
  return modelOperation ? { mode: modelOperation.mode, modelId: modelOperation.modelId, name: modelOperation.name, progress: modelOperation.progress } : null;
}
function launcherState(includeCatalog = true) {
  const state = { selectedId, pets: [...pets.values()].map(pet => pet.state(pet.id === selectedId)), maxPets, ...splitProxy(proxyUrl), autoStart: autoStartState(), storage: { directory: dataDirectory, mode: storageMode }, operation: operationState(), ...globalState() };
  if (includeCatalog) { state.models = library.list(); launcherCatalogRevision = library.revision; }
  return state;
}
function launcherVisible() { return exists(launcher) && launcher.isVisible() && !launcher.isMinimized(); }
function notifyLauncher() { if (launcherVisible()) launcher.webContents.send('launcher:state', launcherState(launcherCatalogRevision !== library.revision)); }
function changed() {
  wakeLoop();
  if (quitting || changeTimer) return;
  changeTimer = setTimeout(() => { changeTimer = null; notifyLauncher(); syncTrays(); }, 80);
}
function wakeLoop() {
  if (quitting || loopRunning || fullscreenActive) return;
  clearTimeout(loopTimer);
  loopTimer = setTimeout(tickLoop, 0);
}
function tickLoop() {
  loopTimer = null;
  const active = [...pets.values()].filter(pet => exists(pet.win) && pet.win.isVisible());
  if (quitting || fullscreenActive || !active.length) return;
  let delay = 500;
  loopRunning = true;
  try {
    const now = Date.now(), dt = Math.min(Math.max((now - lastTick) / 1000, 0), 0.05); lastTick = now;
    const detectors = surfaces.available ? active.filter(pet => pet.ready && !pet.paused && pet.settings.gravity && pet.settings.windowEdges) : [];
    const movingDetector = detectors.some(pet => pet.isMoving());
    const supportedByWindow = detectors.some(pet => pet.body.support?.kind === 'window');
    const surfaceScanDelay = movingDetector ? 250 : supportedByWindow ? 500 : surfaces.error ? 5000 : 0;
    if (surfaceScanDelay && now >= nextSurfaceScan) {
      const previousError = surfaces.error;
      surfaces.refresh();
      nextSurfaceScan = now + surfaceScanDelay;
      if (previousError !== surfaces.error) for (const pet of active) pet.changed();
    } else if (!surfaceScanDelay) nextSurfaceScan = 0;
    const needsCursor = active.some(pet => !pet.settings.clickThrough || pet.dragging);
    const cursor = needsCursor ? screen.getCursorScreenPoint() : null;
    for (const pet of active) pet.tick(dt, now, cursor);
    delay = active.some(pet => pet.isMoving()) ? 1000 / 30 : needsCursor ? 200 : 500;
  } finally {
    loopRunning = false;
    if (!quitting && !fullscreenActive) loopTimer = setTimeout(tickLoop, delay);
  }
}
function checkFullscreen() {
  if (quitting) return;
  const previousError = surfaces.fullscreenError;
  const detected = surfaces.isForegroundFullscreen();
  if (detected !== null && detected !== fullscreenActive) {
    fullscreenActive = detected;
    clearTimeout(loopTimer); loopTimer = null;
    lastTick = Date.now(); nextSurfaceScan = 0;
    for (const pet of pets.values()) pet.setFullscreenSuspended(detected);
    changed();
  } else if (previousError !== surfaces.fullscreenError) notifyLauncher();
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!settingsPath) return '设置保存路径尚未准备好。';
  try {
    const contents = JSON.stringify({ version: 4, maxPets, ...splitProxy(proxyUrl), selectedId, pets: [...pets.values()].map(pet => pet.serialise()) }, null, 2);
    if (contents === lastSavedText) return '';
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(`${settingsPath}.tmp`, contents);
    fs.renameSync(`${settingsPath}.tmp`, settingsPath);
    lastSavedText = contents;
    return '';
  } catch (error) { console.error('无法保存设置:', error.message); return error.message; }
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 500); }
function autoStartOptions() {
  const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.platform === 'win32' && portableExecutable && path.isAbsolute(portableExecutable)) {
    return { path: portableExecutable, args: ['--standalone'] };
  }
  return { path: process.execPath, args: app.isPackaged ? ['--standalone'] : [ROOT, '--standalone'] };
}
function autoStartState() {
  if (process.platform !== 'win32') return { available: false, enabled: false, registered: false, error: '当前系统不支持开机自动启动设置。' };
  try {
    const options = autoStartOptions();
    const settings = app.getLoginItemSettings(options);
    const executable = path.resolve(options.path).toLowerCase();
    const launchItem = settings.launchItems?.find(item => item.name === AUTO_START_NAME && path.resolve(item.path).toLowerCase() === executable);
    const registered = Boolean(launchItem || settings.openAtLogin);
    const enabled = registered && (launchItem ? launchItem.enabled !== false : settings.executableWillLaunchAtLogin !== false);
    return { available: true, enabled, registered, error: '' };
  } catch (error) {
    return { available: false, enabled: false, registered: false, error: `无法读取系统启动项：${error.message}` };
  }
}
function updateAutoStart(value) {
  if (typeof value !== 'boolean') return { ok: false, error: '开机自动启动设置无效。' };
  const current = autoStartState();
  if (!current.available) return { ok: false, error: current.error };
  try {
    app.setLoginItemSettings({ openAtLogin: value, enabled: value, name: AUTO_START_NAME, ...autoStartOptions() });
    const state = autoStartState();
    if (state.enabled !== value) throw new Error(value ? '系统未能启用该启动项。' : '系统未能移除该启动项。');
    changed();
    return { ok: true, ...state };
  } catch (error) { return { ok: false, error: `无法修改开机自动启动设置：${error.message}` }; }
}
function load() {
  settingsPath = path.join(dataDirectory, 'settings.json');
  const previousSettingsPath = path.join(app.getPath('userData'), 'settings.json');
  const sourcePath = storageMode === 'portable' && !fs.existsSync(settingsPath) && fs.existsSync(previousSettingsPath) ? previousSettingsPath : settingsPath;
  let saved;
  try { saved = JSON.parse(fs.readFileSync(sourcePath, 'utf8')); } catch { saved = {}; }
  if (!saved || typeof saved !== 'object') saved = {};
  try {
    proxyUrl = Object.hasOwn(saved, 'proxyAddress') || Object.hasOwn(saved, 'proxyPort')
      ? normaliseProxyParts(saved.proxyAddress, saved.proxyPort) : normaliseProxy(saved.proxyUrl);
  } catch { proxyUrl = ''; }
  const limit = [3, 4].includes(saved.version) && Number.isInteger(saved.maxPets) ? saved.maxPets : defaultConfig.maxPets;
  maxPets = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 1;
  if ([2, 3, 4].includes(saved.version) && Array.isArray(saved.pets)) {
    selectedId = saved.selectedId;
    return saved.pets.filter(item => item && typeof item === 'object' && findModel(item.modelId)).slice(0, maxPets)
      .map(item => saved.version < 4 && item.frameRate === 24 ? { ...item, frameRate: 30 } : item);
  }
  // Migrate the old default once, while preserving an explicitly changed size.
  return [{ ...saved, id: randomUUID(), modelId: DEFAULT_MODEL_ID, scale: !Number.isFinite(saved.scale) || saved.scale === 1 ? 0.75 : saved.scale }];
}
function secureWindow(win) {
  // Page zoom is shared by origin and bypasses the pet's scale and geometry.
  // Reapply after navigation so model reloads also keep CSS pixels aligned with DIP.
  const disablePageZoom = () => win.webContents.setZoomMode('disabled');
  disablePageZoom();
  win.webContents.on('did-navigate', disablePageZoom);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
}
function addPet(modelId, saved = {}) {
  if (pets.size >= maxPets || !findModel(modelId) || !library.isCached(modelId)) return;
  const id = typeof saved.id === 'string' && !pets.has(saved.id) ? saved.id : randomUUID();
  const pet = new PetWindow({ globalState, secureWindow, changed, save, surfaces, voices, downloadVoice, environment: () => environment, wakeLoop, openLauncher, closePet, quit: () => app.quit(), closed, spawnIndex: pets.size }, { ...saved, id, modelId });
  pets.set(id, pet); petsByWebContents.set(pet.webContentsId, pet); selectedId = id; changed(); save();
  return pet;
}
function downloadProgress(progress) {
  if (!modelOperation) return;
  modelOperation.progress = progress;
  if (Date.now() - (modelOperation.lastNotice || 0) > 250) {
    modelOperation.lastNotice = Date.now();
    if (launcherVisible()) launcher.webContents.send('launcher:progress', operationState());
  }
}
async function downloadVoice(id) {
  const pet = pets.get(id);
  if (!pet || !voices.find(pet.model.id)) return { ok: false, error: '当前干员无法读取 PRTS 语音。' };
  if (modelOperation) {
    pet.voiceError = '正在下载其他资源，完成后可点击“下载语音”重试。'; pet.changed();
    return { ok: false, error: pet.voiceError };
  }
  const controller = new AbortController(), modelId = pet.model.id;
  modelOperation = { mode: 'voice', modelId, name: `${pet.model.name} · 语音`, controller, progress: null };
  pet.voiceError = ''; changed();
  try {
    await voices.ensure(modelId, downloadProgress, controller.signal);
    controller.signal.throwIfAborted();
    return { ok: true };
  } catch (error) {
    const message = controller.signal.aborted ? '语音下载已取消，可重试。' : `语音下载失败：${error.message}`;
    if (pets.get(id)?.model.id === modelId) pet.voiceError = message;
    return { ok: false, error: message };
  } finally {
    modelOperation = null;
    if (!quitting) { for (const current of pets.values()) current.changed(); changed(); }
  }
}
async function selectModel({ mode, modelId, id }) {
  if (modelOperation) return { ok: false, error: '正在下载或更换干员，请等待完成或取消。' };
  const model = findModel(modelId);
  if (!model || !['add', 'replace'].includes(mode)) return { ok: false, error: '请选择列表中的干员。' };
  if (mode === 'add' && pets.size >= maxPets) return { ok: false, error: `已达到 ${maxPets} 个桌宠的上限，可更换当前干员或调整数量上限。` };
  if (mode === 'replace' && !pets.has(id)) return { ok: false, error: '当前桌宠已退出，请重新选择。' };
  const controller = new AbortController();
  modelOperation = { mode, modelId: model.id, name: `${model.name} · ${model.subtitle}`, controller, progress: null };
  changed();
  try {
    await library.ensure(model.id, progress => downloadProgress({ ...progress, phase: '模型' }), controller.signal);
    let voiceWarning = '';
    const voiceEnabled = mode === 'replace' && pets.get(id)?.settings.voiceEnabled;
    if (voiceEnabled) {
      try { await voices.ensure(model.id, downloadProgress, controller.signal); }
      catch (error) { controller.signal.throwIfAborted(); voiceWarning = `模型已下载，但 PRTS 语音下载失败：${error.message}`; }
    }
    controller.signal.throwIfAborted();
    if (quitting) return { ok: false, error: '程序正在退出。' };
    let pet;
    if (mode === 'replace') {
      pet = pets.get(id);
      if (!pet) throw new Error('当前桌宠已退出，下载的模型已缓存。');
      pet.switchModel(model.id);
    } else {
      pet = addPet(model.id);
      if (!pet) throw new Error('已达到桌宠数量上限。');
    }
    if (voiceWarning) { pet.voiceError = voiceWarning; pet.changed(); }
    return { ok: true, warning: voiceWarning };
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? '已取消，当前干员保持不变。' : `更换失败：${error.message} 当前干员保持不变，可以重试。` };
  } finally { modelOperation = null; if (!quitting) { changed(); save(); } }
}
function updateLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) return { ok: false, error: '数量上限需要是 1～100 的整数。' };
  if (pets.size > value) return { ok: false, error: `当前有 ${pets.size} 个桌宠，请先退出多余的桌宠，再降低上限。` };
  const previous = maxPets;
  maxPets = value;
  const saveError = saveNow();
  if (saveError) { maxPets = previous; return { ok: false, error: `无法保存数量上限：${saveError}` }; }
  changed(); return { ok: true };
}
function updateProxy(value) {
  try {
    if (!value || typeof value !== 'object') throw new Error('代理设置无效。');
    const previous = proxyUrl;
    proxyUrl = normaliseProxyParts(value.address, value.port);
    const saveError = saveNow();
    if (saveError) { proxyUrl = previous; return { ok: false, error: `无法保存代理设置：${saveError}` }; }
    voices?.clearRequests();
    changed();
    return { ok: true, ...splitProxy(proxyUrl) };
  } catch (error) { return { ok: false, error: error.message }; }
}
function closed(pet) {
  if (quitting) return;
  pets.delete(pet.id);
  petsByWebContents.delete(pet.webContentsId);
  petTrays.get(pet.id)?.destroy(); petTrays.delete(pet.id);
  if (selectedId === pet.id) selectedId = pets.keys().next().value;
  saveNow(); changed();
  if (!pets.size && !exists(launcher)) app.quit();
}
function closePet(id) { const pet = pets.get(id); if (exists(pet?.win)) pet.win.close(); }

function openLauncher(id) {
  if (pets.has(id)) selectedId = id;
  if (exists(launcher)) { launcher.show(); launcher.focus(); changed(); return; }
  launcherCatalogRevision = -1;
  launcher = new BrowserWindow({
    width: 780, height: 700, minWidth: 620, minHeight: 560, title: 'ArkPet 设置',
    backgroundColor: '#ffffff', autoHideMenuBar: true, show: false, icon: makeIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  secureWindow(launcher);
  launcher.once('ready-to-show', () => { launcher.show(); changed(); });
  launcher.on('restore', notifyLauncher);
  launcher.on('closed', () => {
    launcher = null;
    if (!quitting) { syncTrays(); if (!pets.size) app.quit(); }
  });
  launcher.loadURL('arkpet://app/renderer/settings.html'); syncTrays();
}
function makeIcon() {
  if (trayIcon) return trayIcon;
  const size = 32, bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const scoop = (x - 16) ** 2 + (y - 11) ** 2 <= 90;
    const cone = y >= 16 && y <= 29 && Math.abs(x - 16) <= (30 - y) * 0.55;
    if (!scoop && !cone) continue;
    const i = (y * size + x) * 4;
    bitmap[i] = scoop ? 128 : 140; bitmap[i + 1] = scoop ? 125 : 204; bitmap[i + 2] = scoop ? 242 : 247; bitmap[i + 3] = 255;
  }
  trayIcon = nativeImage.createFromBitmap(bitmap, { width: size, height: size });
  return trayIcon;
}
function syncTrays() {
  if (quitting) return;
  if (exists(launcher)) {
    for (const tray of petTrays.values()) tray.destroy();
    petTrays.clear();
    if (!launcherTray) {
      launcherTray = new Tray(makeIcon()); launcherTray.setToolTip('ArkPet · 设置');
      launcherTray.on('double-click', () => openLauncher());
    }
    launcherTray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开设置', click: () => openLauncher() },
      { label: '选择 / 更换干员', click: () => openLauncher() },
      { label: `桌宠数量：${pets.size} / ${maxPets}`, enabled: false },
      { type: 'separator' },
      ...[...pets.values()].map((pet, index) => ({ label: `${index + 1}. ${pet.model.name}`, submenu: pet.menu() })),
      { type: 'separator' },
      { label: '关闭设置窗口', click: () => launcher.close() },
      { label: '退出应用', click: () => app.quit() }
    ]));
  } else {
    launcherTray?.destroy(); launcherTray = null;
    for (const pet of pets.values()) {
      let tray = petTrays.get(pet.id);
      if (!tray) {
        tray = new Tray(makeIcon());
        tray.on('double-click', () => openLauncher(pet.id)); petTrays.set(pet.id, tray);
      }
      tray.setToolTip(`ArkPet · ${pet.model.name}`);
      tray.setContextMenu(Menu.buildFromTemplate(pet.menu()));
    }
  }
}

function senderPet(event) {
  const pet = petsByWebContents.get(event.sender.id);
  return pet?.win?.webContents === event.sender ? pet : undefined;
}
function trusted(event) { return event.senderFrame === event.sender.mainFrame && (Boolean(senderPet(event)) || event.sender === launcher?.webContents); }
function target(event, id) { return trusted(event) ? senderPet(event) || pets.get(id) : undefined; }
function registerIpc() {
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
  ipcMain.handle('launcher:model', (event, request) => trusted(event) && event.sender === launcher?.webContents && request ? selectModel(request) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:limit', (event, value) => trusted(event) && event.sender === launcher?.webContents ? updateLimit(value) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:proxy', (event, value) => trusted(event) && event.sender === launcher?.webContents ? updateProxy(value) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:auto-start', (event, value) => trusted(event) && event.sender === launcher?.webContents ? updateAutoStart(value) : { ok: false, error: '请求无效。' });
  ipcMain.handle('launcher:voice-download', (event, id) => trusted(event) && event.sender === launcher?.webContents ? downloadVoice(id) : { ok: false, error: '请求无效。' });
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
  ipcMain.on('launcher:cancel-download', event => { if (trusted(event) && event.sender === launcher?.webContents) modelOperation?.controller.abort(); });
  ipcMain.on('launcher:select', (event, id) => { if (trusted(event) && event.sender === launcher?.webContents && pets.has(id)) { selectedId = id; changed(); save(); } });
  ipcMain.on('launcher:detach', event => { if (trusted(event) && event.sender === launcher?.webContents) launcher.close(); });
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
}

function registerProtocol() {
  const vendor = new Map([
    ['/vendor/pixi.js', path.join(ROOT, 'node_modules/pixi.js/dist/pixi.min.js')],
    ['/vendor/pixi-spine.js', path.join(ROOT, 'node_modules/pixi-spine/dist/pixi-spine.js')]
  ]);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.atlas': 'text/plain; charset=utf-8', '.skel': 'application/octet-stream', '.mp3': 'audio/mpeg' };
  protocol.handle('arkpet', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
      const pathname = decodeURIComponent(url.pathname);
      let file = vendor.get(pathname);
      if (pathname.startsWith('/voices/')) {
        const pieces = pathname.split('/');
        if (pieces.length !== 4) return new Response('Forbidden', { status: 403 });
        file = voices.resolve(pieces[2], pieces[3]);
        if (!file) return new Response('Not found', { status: 404 });
      }
      if (pathname.startsWith('/models/')) {
        const pieces = pathname.split('/');
        if (pieces.length !== 4) return new Response('Forbidden', { status: 403 });
        file = library.resolve(pieces[2], pieces[3]);
        if (!file) return new Response('Not found', { status: 404 });
      }
      if (!file) {
        const base = pathname.startsWith('/renderer/') ? path.join(__dirname, 'renderer') : pathname.startsWith('/assets/') ? path.join(ROOT, 'assets') : null;
        if (!base) return new Response('Not found', { status: 404 });
        file = path.resolve(base, pathname.split('/').slice(2).join('/'));
        const relative = path.relative(base, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
      }
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'Content-Type': mime[path.extname(pathname)] || mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', async (_event, argv) => {
    await app.whenReady();
    const model = argv.find(arg => arg.startsWith('--model='))?.slice(8);
    if (model) {
      const result = await selectModel({ mode: pets.size >= maxPets ? 'replace' : 'add', modelId: model, id: selectedId || pets.keys().next().value });
      if (!result.ok) dialog.showErrorBox('无法选择干员', result.error);
    }
    if (!argv.includes('--standalone') || modelOperation) openLauncher();
  });
  app.whenReady().then(() => {
    prepareDataDirectory();
    const saved = load(), previousSelection = selectedId;
    downloads = new DownloadClient(() => proxyUrl);
    library = new ModelLibrary(dataDirectory, downloads); voices = new VoiceLibrary(dataDirectory, downloads); surfaces = new WindowSurfaces(screen);
    const refreshDisplays = () => { const displays = screen.getAllDisplays(); environment = { displays, floors: floors(displays) }; };
    refreshDisplays();
    checkFullscreen();
    registerProtocol(); registerIpc();
    const modelArg = process.argv.find(arg => arg.startsWith('--model='))?.slice(8);
    for (const item of saved) addPet(item.modelId, item);
    if (!pets.size) addPet(DEFAULT_MODEL_ID);
    if (!modelArg && pets.has(previousSelection)) selectedId = previousSelection;
    if (!process.argv.includes('--standalone') && !fullscreenActive) openLauncher();
    if (modelArg) selectModel({ mode: 'replace', modelId: modelArg, id: selectedId }).then(result => { if (!result.ok && !quitting) dialog.showErrorBox('无法选择干员', result.error); });
    shortcutStatus.visibility = globalShortcut.register('CommandOrControl+Alt+S', () => {
      const show = [...pets.values()].some(pet => pet.userHidden);
      for (const pet of pets.values()) { if (show) pet.show(); else if (!pet.userHidden) pet.toggleVisible(); }
    });
    shortcutStatus.clickThrough = globalShortcut.register('CommandOrControl+Alt+P', () => {
      const enable = ![...pets.values()].some(pet => pet.settings.clickThrough);
      for (const pet of pets.values()) pet.updateSettings({ clickThrough: enable });
    });
    const recover = () => {
      refreshDisplays(); nextSurfaceScan = 0; checkFullscreen();
      for (const pet of pets.values()) { pet.endDrag(true); pet.body.support = null; pet.contain(); pet.place(); }
      save(); wakeLoop();
    };
    screen.on('display-added', recover); screen.on('display-removed', recover); screen.on('display-metrics-changed', recover);
    if (surfaces.available) fullscreenTimer = setInterval(checkFullscreen, 1000);
    for (const pet of pets.values()) pet.changed();
  }).catch(error => { dialog.showErrorBox('ArkPet 启动失败', error.message); app.quit(); });
  app.on('before-quit', () => {
    quitting = true; modelOperation?.controller.abort(); clearTimeout(loopTimer); clearTimeout(changeTimer); clearInterval(fullscreenTimer); saveNow(); globalShortcut.unregisterAll();
    launcherTray?.destroy(); for (const tray of petTrays.values()) tray.destroy(); petTrays.clear();
  });
  app.on('window-all-closed', () => app.quit());
}
