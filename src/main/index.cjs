const { app, Menu, Tray, Notification, ipcMain, protocol, screen, globalShortcut, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setMotionTimerResolution } = require('./platform/windows/motion-timer.cjs');
const { PetWindow } = require('./windows/pet-window.cjs');
const { DEFAULT_MODEL_ID, findModel } = require('./services/models.cjs');
const { ModelLibrary } = require('./services/model-library.cjs');
const { VoiceLibrary } = require('./services/voice-library.cjs');
const { DownloadClient, normaliseProxy, normaliseProxyParts, splitProxy } = require('./services/download-client.cjs');
const defaultConfig = require('../../config.json');
const { WindowSurfaces } = require('./platform/windows/window-surfaces.cjs');
const { floors } = require('./services/physics.cjs');
const { AiSettingsStore } = require('./services/ai-settings-store.cjs');
const { PrtsProfileSource } = require('./services/prts-profile-source.cjs');
const { AiClient } = require('./services/ai-client.cjs');
const { AiChatWindows } = require('./windows/ai-chat-window.cjs');

const product = require('../shared/product.cjs');
const { prepareDataDirectory } = require('./services/data-directory.cjs');
const { createAutoStart } = require('./platform/windows/auto-start.cjs');
const { secureWindow } = require('./windows/security.cjs');
const { createSettingsWindow } = require('./windows/settings-window.cjs');
const { makeIcon } = require('./windows/icon.cjs');
const { registerHandlers } = require('./ipc/register.cjs');
const { registerProtocol } = require('./protocol.cjs');
const { state: autoStartState, update: updateAutoStart } = createAutoStart(app, changed);
const pets = new Map(), petsByWebContents = new Map(), petTrays = new Map();
let launcher, launcherTray, selectedId, settingsPath, saveTimer, loopTimer, changeTimer, fullscreenTimer, reminderTimer;
let surfaces, quitting = false, shortcutStatus = {};
let petTickTimes = new WeakMap();
let library, voices, downloads, modelOperation = null, maxPets = 1, proxyUrl = '';
let aiSettings, profiles, aiClient, aiChats;
let environment, loopRunning = false, nextSurfaceScan = 0, launcherCatalogRevision = -1, lastSavedText;
let dataDirectory, storageMode = 'system', lastClosedPet = null;
let fullscreenActive = false;
let startupCatalogPending = false, catalogNotification, notifiedCatalogCommit = '';
const exists = win => win && !win.isDestroyed();
protocol.registerSchemesAsPrivileged([{ scheme: 'arkpet', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
// Keep the established data location when changing the public product name.
const legacyUserData = path.join(app.getPath('appData'), product.dataDirectoryName);
fs.mkdirSync(legacyUserData, { recursive: true });
app.setPath('userData', legacyUserData);
app.setName(product.name);
app.setAppUserModelId(product.appId);

function globalState() { return { shortcutStatus, windowDetection: { available: surfaces?.available || false, error: surfaces?.error || '' }, fullscreen: { active: fullscreenActive, available: surfaces?.available || false, error: surfaces?.fullscreenError || '' } }; }
function operationState() {
  return modelOperation ? { mode: modelOperation.mode, modelId: modelOperation.modelId, name: modelOperation.name, progress: modelOperation.progress } : null;
}
function launcherState(includeCatalog = true) {
  const state = { application: { name: product.name, version: product.version }, selectedId, pets: [...pets.values()].map(pet => pet.state(pet.id === selectedId)), maxPets, ...splitProxy(proxyUrl), ai: aiSettings?.state() || {}, autoStart: autoStartState(), storage: { directory: dataDirectory, mode: storageMode }, catalogUpdate: library.updateState(), operation: operationState(), ...globalState() };
  if (includeCatalog) { state.models = library.list(); launcherCatalogRevision = library.revision; }
  return state;
}
function launcherVisible() { return exists(launcher) && launcher.isVisible() && !launcher.isMinimized(); }
function notifyLauncher() { if (launcherVisible()) launcher.webContents.send('launcher:state', launcherState(launcherCatalogRevision !== library.revision)); }
function changed() {
  wakeLoop();
  if (quitting || changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null; notifyLauncher(); syncTrays(); notifyCatalogUpdate();
    // 与手动下载共用串行任务，避免目录替换改变正在下载的模型路径。
    if (startupCatalogPending && !modelOperation) {
      startupCatalogPending = false;
      void updateModelCatalog('check', true);
    }
  }, 80);
}
function notifyCatalogUpdate() {
  const update = library.updateState();
  if (!update.initialized || !update.available || update.latestCommit === notifiedCatalogCommit || fullscreenActive) return;
  notifiedCatalogCommit = update.latestCommit;
  if (launcherVisible() || !Notification.isSupported()) return;
  try {
    catalogNotification?.close();
    catalogNotification = new Notification({ title: product.name, body: '干员与时装目录有更新，打开设置中的“干员管理”即可查看。', silent: true, icon: makeIcon() });
    catalogNotification.on('click', () => { if (!quitting) openLauncher(); });
    catalogNotification.on('failed', (_event, error) => console.warn(`模型目录更新通知未显示：${error}`));
    catalogNotification.show();
  } catch (error) { console.warn(`模型目录更新通知未显示：${error.message}`); }
}
function wakeLoop() {
  if (quitting || loopRunning || fullscreenActive) return;
  clearTimeout(loopTimer);
  loopTimer = setTimeout(() => tickLoop(true), 0);
}
function tickLoop(force = false) {
  loopTimer = null;
  const active = [...pets.values()].filter(pet => exists(pet.win) && pet.win.isVisible());
  if (quitting || fullscreenActive || !active.length) { setMotionTimerResolution(false); return; }
  let nextTick = performance.now() + 500;
  loopRunning = true;
  try {
    const now = Date.now(), time = performance.now();
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
    for (const pet of active) {
      const previous = petTickTimes.get(pet);
      const interval = pet.isMoving() ? 1000 / pet.settings.frameRate : !pet.settings.clickThrough ? 200 : 500;
      if (!previous || force || previous.interval !== interval || time + 0.5 >= previous.next) {
        // Cap long stalls while retaining elapsed time at the selected frame rate.
        const dt = previous ? Math.min(Math.max((time - previous.last) / 1000, 0), 0.1) : 0;
        pet.tick(dt, now, cursor);
        const nextInterval = pet.isMoving() ? 1000 / pet.settings.frameRate : !pet.settings.clickThrough ? 200 : 500;
        // Advance from the deadline, not the end of the work, without catch-up bursts.
        const next = previous && !force && previous.interval === nextInterval
          ? previous.next + Math.max(1, Math.floor((time - previous.next + 0.5) / nextInterval) + 1) * nextInterval
          : time + nextInterval;
        petTickTimes.set(pet, { last: time, next, interval: nextInterval });
      }
      nextTick = Math.min(nextTick, petTickTimes.get(pet).next);
    }
  } finally {
    loopRunning = false;
    const moving = !quitting && !fullscreenActive && active.some(pet => pet.isMoving());
    setMotionTimerResolution(moving);
    if (!quitting && !fullscreenActive) loopTimer = setTimeout(tickLoop, Math.max(0, nextTick - performance.now()));
  }
}
function checkFullscreen() {
  if (quitting) return;
  const previousError = surfaces.fullscreenError;
  const detected = surfaces.isForegroundFullscreen();
  if (detected !== null && detected !== fullscreenActive) {
    fullscreenActive = detected;
    clearTimeout(loopTimer); loopTimer = null;
    petTickTimes = new WeakMap(); nextSurfaceScan = 0;
    setMotionTimerResolution(false);
    for (const pet of pets.values()) pet.setFullscreenSuspended(detected);
    changed();
  } else if (previousError !== surfaces.fullscreenError) notifyLauncher();
}
function checkReminders() {
  if (quitting) return;
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  for (const pet of pets.values()) if (pet.settings.reminderTime === time) pet.remind(day + ' ' + time);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!settingsPath) return '设置保存路径尚未准备好。';
  try {
    const contents = JSON.stringify({ version: 4, maxPets, ...splitProxy(proxyUrl), selectedId, lastClosedPet, pets: [...pets.values()].map(pet => pet.serialise()) }, null, 2);
    if (contents === lastSavedText) return '';
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(`${settingsPath}.tmp`, contents);
    fs.renameSync(`${settingsPath}.tmp`, settingsPath);
    lastSavedText = contents;
    return '';
  } catch (error) { console.error('无法保存设置:', error.message); return error.message; }
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 500); }
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
    const previousPet = saved.lastClosedPet;
    lastClosedPet = previousPet && typeof previousPet === 'object' && findModel(previousPet.modelId) ? previousPet : null;
    const savedPets = saved.pets.filter(item => item && typeof item === 'object' && findModel(item.modelId)).slice(0, maxPets)
      .map(item => saved.version < 4 && item.frameRate === 24 ? { ...item, frameRate: 30 } : item);
    return savedPets.length ? savedPets : lastClosedPet ? [lastClosedPet] : [];
  }
  // Migrate the old default once, while preserving an explicitly changed size.
  return [{ ...saved, id: randomUUID(), modelId: DEFAULT_MODEL_ID, scale: !Number.isFinite(saved.scale) || saved.scale === 1 ? 0.75 : saved.scale }];
}
function addPet(modelId, saved = pets.size ? {} : lastClosedPet || {}) {
  if (pets.size >= maxPets || !findModel(modelId) || !library.isCached(modelId)) return;
  const id = typeof saved.id === 'string' && !pets.has(saved.id) ? saved.id : randomUUID();
  const pet = new PetWindow({ globalState, secureWindow, changed, save, surfaces, voices, downloadVoice,
    cachedModels: () => library.list().filter(model => model.cached), modelCached: id => library.isCached(id),
    aiAvailable: () => aiSettings?.state().ready || false, openAiChat, closeAiChat: id => aiChats?.closePet(id),
    environment: () => environment, wakeLoop, openLauncher, closePet, quit: () => app.quit(), closed, spawnIndex: pets.size }, { ...saved, id, modelId });
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
async function updateModelCatalog(action, startup = false) {
  if (!['check', 'pull'].includes(action)) return { ok: false, error: '目录更新请求无效。' };
  if (modelOperation) return { ok: false, error: '正在处理其他资源，请等待完成或取消。' };
  startupCatalogPending = false;
  const controller = new AbortController();
  modelOperation = { mode: `catalog-${action}`, name: action === 'check' ? '检查模型目录更新' : '拉取模型目录更新', controller, progress: null };
  changed();
  let result;
  try {
    let message = action === 'check' ? await library.checkForUpdates(downloadProgress, controller.signal) : await library.pullUpdates(downloadProgress, controller.signal);
    controller.signal.throwIfAborted();
    if (action === 'check' && !library.hasCatalog) {
      modelOperation.name = '首次获取模型目录'; changed();
      message = await library.pullUpdates(downloadProgress, controller.signal);
    }
    for (const pet of pets.values()) pet.refreshModelMetadata();
    aiChats?.refresh();
    if (!library.updateState().available) catalogNotification?.close();
    result = { ok: true, warning: message };
  } catch (error) {
    const message = controller.signal.aborted ? '目录更新操作已取消，可手动重试。' : `${startup ? '启动时检查目录失败，仍可使用本地模型' : '模型目录更新失败'}：${error.message}`;
    library.catalogError = message;
    result = { ok: false, error: message };
  } finally { modelOperation = null; if (!quitting) changed(); }
  if (!quitting) notifyLauncher();
  return { ...result, state: launcherState() };
}
async function selectModel({ mode, modelId, id }) {
  if (modelOperation) return { ok: false, error: '正在下载或更换干员，请等待完成或取消。' };
  if (!['add', 'replace'].includes(mode)) return { ok: false, error: '请选择列表中的干员。' };
  // 首次使用 --model 启动时，也要先获取目录再解析目标模型。
  if (!findModel(modelId) && !library.hasCatalog) {
    const result = await updateModelCatalog('check', true);
    if (!result.ok) return result;
    if (quitting) return { ok: false, error: '程序正在退出。' };
  }
  const model = findModel(modelId);
  if (!model) return { ok: false, error: '请选择列表中的干员。' };
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
    voices?.clearRequests(); profiles?.clear();
    changed();
    return { ok: true, ...splitProxy(proxyUrl) };
  } catch (error) { return { ok: false, error: error.message }; }
}
async function updateAi(value) {
  const result = await aiSettings.save(value);
  if (result.ok) {
    aiClient.clearAll(); aiChats.refresh(); changed();
  }
  return result;
}
async function clearAiKey() {
  const result = await aiSettings.clearKey();
  if (result.ok) {
    aiClient.clearAll(); aiChats.refresh(); changed();
  }
  return result;
}
function openAiChat(id) {
  const pet = pets.get(id);
  if (pet && aiSettings?.state().ready) aiChats.open(pet);
  else if (pet) openLauncher(id);
}
function closed(pet) {
  if (quitting) return;
  // 关闭窗口只移除运行实例，保留配置供重新添加或下次启动恢复。
  lastClosedPet = pet.serialise();
  aiChats?.closePet(pet.id);
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
  launcher = createSettingsWindow({
    onReady: () => { launcher.show(); changed(); },
    onRestore: notifyLauncher,
    onClosed: () => {
      launcher = null;
      if (!quitting) { syncTrays(); if (!pets.size) app.quit(); }
    }
  });
  syncTrays();
}
function syncTrays() {
  if (quitting) return;
  const updateHint = library.updateState().available ? ' · 干员目录有更新' : '';
  if (exists(launcher)) {
    for (const tray of petTrays.values()) tray.destroy();
    petTrays.clear();
    if (!launcherTray) {
      launcherTray = new Tray(makeIcon());
      launcherTray.on('double-click', () => openLauncher());
    }
    launcherTray.setToolTip(`${product.name} · 设置${updateHint}`);
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
      tray.setToolTip(`${product.name} · ${pet.model.name}${updateHint}`);
      tray.setContextMenu(Menu.buildFromTemplate(pet.menu()));
    }
  }
}

function registerIpc() {
  registerHandlers({ ipcMain, app, shell, pets, petsByWebContents, getLauncher: () => launcher, launcherState,
    openLauncher, closePet, selectModel, updateModelCatalog, updateLimit, updateProxy, updateAi,
    aiClient, clearAiKey, updateAutoStart, downloadVoice, voices, aiChats,
    cancelDownload: () => modelOperation?.controller.abort(),
    selectPet: id => { selectedId = id; changed(); save(); } });
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
  app.whenReady().then(async () => {
    const storage = prepareDataDirectory(app);
    dataDirectory = storage.directory; storageMode = storage.mode;
    downloads = new DownloadClient(() => proxyUrl);
    library = new ModelLibrary(dataDirectory, downloads);
    // 先恢复更新后的目录，才能识别上次保存的新增干员。
    const saved = load(), previousSelection = selectedId;
    voices = new VoiceLibrary(dataDirectory, downloads);
    profiles = new PrtsProfileSource(dataDirectory, downloads);
    aiSettings = new AiSettingsStore(dataDirectory); await aiSettings.load();
    aiClient = new AiClient(aiSettings, profiles, voices);
    aiChats = new AiChatWindows({ settings: aiSettings, client: aiClient, getPet: id => pets.get(id), secureWindow });
    surfaces = new WindowSurfaces(screen);
    const refreshDisplays = () => { const displays = screen.getAllDisplays(); environment = { displays, floors: floors(displays) }; };
    refreshDisplays();
    // 启动时先决定初始可见性，避免在已有全屏应用前弹出窗口。
    fullscreenActive = Boolean(surfaces.fullscreenWindow());
    registerProtocol({ protocol, voices, library }); registerIpc();
    const modelArg = process.argv.find(arg => arg.startsWith('--model='))?.slice(8);
    for (const item of saved) addPet(item.modelId, item);
    if (!pets.size) addPet(DEFAULT_MODEL_ID);
    reminderTimer = setInterval(checkReminders, 1000);
    if (!modelArg && pets.has(previousSelection)) selectedId = previousSelection;
    if (!process.argv.includes('--standalone') && !fullscreenActive) openLauncher();
    startupCatalogPending = true;
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
    changed();
  }).catch(error => { dialog.showErrorBox(`${product.name} 启动失败`, error.message); app.quit(); });
  app.on('before-quit', () => {
    startupCatalogPending = false; catalogNotification?.close();
    quitting = true; setMotionTimerResolution(false); modelOperation?.controller.abort(); aiChats?.closeAll(); clearTimeout(loopTimer); clearTimeout(changeTimer); clearInterval(fullscreenTimer); clearInterval(reminderTimer); saveNow(); globalShortcut.unregisterAll();
    launcherTray?.destroy(); for (const tray of petTrays.values()) tray.destroy(); petTrays.clear();
  });
  app.on('window-all-closed', () => app.quit());
}
