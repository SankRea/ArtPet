const bridge = window.arkpet;
const byId = id => document.getElementById(id);
const booleanKeys = ['wander', 'autoActions', 'manualMode', 'gravity', 'windowEdges', 'alwaysOnTop', 'translucent', 'clickThrough', 'voiceEnabled', 'idleVoiceEnabled', 'voiceTextEnabled'];
let selectedId, petListSignature = '', formSignature = '', voiceSignature = '', currentData, uiBusy = false, searchTimer;
let catalogIndex = [], modelsById = new Map();
let voicePreviewKey = '';
let aiDirty = false;

function selectSettingsTab(name, focus = false) {
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  if (!tabs.some(tab => tab.dataset.settingsTab === name)) return;
  for (const tab of tabs) {
    const selected = tab.dataset.settingsTab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const panel of document.querySelectorAll('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== name;
}

function options(select, records) {
  select.replaceChildren(...records.map(({ value, label }) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
  }));
}
function updateChoices() {
  if (!currentData) return;
  const selected = byId('model-select').value || currentData.pets.find(pet => pet.id === currentData.selectedId)?.model.id;
  const search = byId('model-search').value.trim().toLocaleLowerCase();
  const matches = catalogIndex.filter(item => item.search.includes(search));
  options(byId('model-select'), matches);
  if (matches.some(item => item.value === selected)) byId('model-select').value = selected;
  byId('catalog-info').textContent = `Ark-Models · ${matches.length} / ${currentData.models.length} 个干员与时装条目`;
  updateButtons();
}
function setAiModels(models, selected = '') {
  const values = [...new Set(models.filter(value => typeof value === 'string' && value))];
  const records = [{ value: '', label: values.length ? '请选择模型' : '请先获取模型列表' }, ...values.map(value => ({ value, label: value }))];
  if (selected && !values.includes(selected)) records.splice(1, 0, { value: selected, label: `${selected}（已保存）` });
  options(byId('ai-model'), records);
  if (selected && records.some(item => item.value === selected)) byId('ai-model').value = selected;
}
function renderAi(ai = {}) {
  if (!aiDirty) {
    byId('ai-enabled').checked = Boolean(ai.enabled);
    byId('ai-gateway').value = ai.gateway || '';
    const known = [...byId('ai-model').options].map(option => option.value);
    if (ai.model && !known.includes(ai.model)) byId('ai-model').add(new Option(`${ai.model}（已保存）`, ai.model));
    byId('ai-model').value = ai.model || '';
  }
  byId('ai-key').placeholder = ai.hasKey ? '已安全保存；留空保持不变' : '请输入 API Key';
  byId('ai-status').textContent = ai.error || (!ai.encryptionAvailable
    ? '系统密钥存储不可用，暂时无法安全保存 API Key。'
    : ai.ready ? `已启用 · ${ai.model}` : ai.hasKey || ai.gateway || ai.model ? '配置已保存，当前未启用。' : '默认关闭。填写配置并保存后，可从桌宠右键菜单开始对话。');
}
function aiForm() {
  return { enabled: byId('ai-enabled').checked, gateway: byId('ai-gateway').value,
    apiKey: byId('ai-key').value, model: byId('ai-model').value };
}
function updateButtons() {
  if (!currentData) return;
  const busy = uiBusy || Boolean(currentData.operation), model = modelsById.get(byId('model-select').value);
  const pet = currentData.pets.find(item => item.id === selectedId);
  byId('add-pet').disabled = busy || !model || currentData.pets.length >= currentData.maxPets;
  byId('replace-pet').disabled = busy || !model || !pet || model.id === pet.model.id;
  byId('replace-pet').textContent = model && !model.cached ? '下载并更换当前干员' : '更换当前干员';
  byId('add-pet').textContent = model && !model.cached ? '下载并添加' : '添加桌宠';
  byId('save-limit').disabled = busy;
  byId('max-pets').disabled = busy;
  byId('save-proxy').disabled = busy;
  byId('proxy-address').disabled = busy;
  byId('proxy-port').disabled = busy;
  for (const id of ['ai-enabled', 'ai-gateway', 'ai-key', 'ai-model', 'load-ai-models', 'save-ai', 'test-ai']) byId(id).disabled = busy;
  byId('clear-ai-key').disabled = busy || !currentData.ai?.hasKey;
  byId('autoStart').disabled = busy || !currentData.autoStart?.available;
  byId('download-voice').disabled = busy || !pet?.voice?.available;
  byId('play-voice').disabled = busy || !pet?.voiceEnabled || !pet?.voice?.cached || !pet?.ready || !pet?.visible || pet?.paused || pet?.fullscreenSuspended || !byId('voice-clip').value;
  byId('voice-clip').disabled = !pet?.voice?.cached;
  byId('stop-voice').disabled = !pet?.voiceEnabled;
  byId('voice-source').disabled = !pet?.voice?.available;
}
function updateVoicePreview() {
  const pet = currentData?.pets.find(item => item.id === selectedId), clipId = byId('voice-clip').value;
  if (!pet?.voiceEnabled || !pet.voice?.available || !clipId) {
    voicePreviewKey = '';
    byId('voice-text').textContent = pet?.voice?.available ? '请选择语音片段。' : '当前干员暂无可用语音。';
    return;
  }
  const key = `${pet.id}:${pet.voice.id}:${clipId}`;
  if (key === voicePreviewKey) return;
  voicePreviewKey = key;
  const clip = pet.voice.clips.find(item => item.id === clipId);
  byId('voice-text').textContent = clip?.text || '当前语音暂无对应的中文文本。';
}
async function request(work, success) {
  uiBusy = true; updateButtons(); byId('operation-message').textContent = '';
  try {
    const result = await work();
    byId('operation-message').textContent = result.ok ? result.warning || success : result.error;
  } catch (error) { byId('operation-message').textContent = error.message; }
  finally { uiBusy = false; updateButtons(); }
}
function renderOperation(operation) {
  byId('download-panel').hidden = !operation;
  if (operation) {
    const progress = operation.progress;
    byId('download-progress').value = progress ? Math.min(1, (progress.index + (progress.expected ? progress.received / progress.expected : 0)) / progress.total) : 0;
    byId('download-text').textContent = progress ? `${operation.name} · ${progress.phase || '资源'}${progress.proxied ? ' · 代理重试' : ''} · ${Math.min(progress.total, progress.index + 1)}/${progress.total} · ${progress.file}` : `正在准备 ${operation.name}…`;
  }
}
function render(data) {
  const catalogChanged = Boolean(data.models);
  currentData = { ...data, models: data.models || currentData?.models || [] };
  if (catalogChanged) {
    modelsById = new Map(data.models.map(model => [model.id, model]));
    catalogIndex = data.models.map((model, order) => ({ value: model.id, label: `${model.name} · ${model.subtitle}${model.cached ? ' [已下载]' : ''}`,
      search: `${model.name} ${model.appellation} ${model.subtitle}`.toLocaleLowerCase(), cached: model.cached, order }))
      .sort((a, b) => Number(b.cached) - Number(a.cached) || a.order - b.order);
  }
  const signature = data.pets.map(pet => `${pet.id}:${pet.model.id}`).join(',');
  if (signature !== petListSignature) {
    options(byId('pet-select'), data.pets.map((pet, index) => ({ value: pet.id, label: `${index + 1}. ${pet.model.name}` })));
    petListSignature = signature;
  }
  const state = data.pets.find(pet => pet.id === data.selectedId) || data.pets[0];
  selectedId = state?.id;
  if (catalogChanged) updateChoices();
  if (document.activeElement !== byId('max-pets')) byId('max-pets').value = data.maxPets;
  if (document.activeElement !== byId('proxy-address')) byId('proxy-address').value = data.proxyAddress || '';
  if (document.activeElement !== byId('proxy-port')) byId('proxy-port').value = data.proxyPort || '';
  renderAi(data.ai);
  const autoStart = data.autoStart || { available: false, enabled: false, registered: false, error: '无法读取开机自动启动状态。' };
  byId('autoStart').checked = autoStart.enabled;
  byId('auto-start-status').textContent = autoStart.error || (autoStart.enabled
    ? '已启用。登录 Windows 后将直接显示桌宠，不打开设置窗口。'
    : autoStart.registered ? '该启动项已被 Windows 停用，可在这里重新开启。' : '默认关闭。开启后将直接显示桌宠，不打开设置窗口。');
  const storageMessages = {
    portable: '便携版的设置与下载数据保存在程序旁，可随程序文件夹一起移动。',
    fallback: '程序所在目录不可写，设置与下载数据已改存到当前用户目录。',
    system: '开发运行时使用当前用户目录；便携版发布后会使用程序旁的 ArkPet-data 文件夹。'
  };
  byId('storage-description').textContent = storageMessages[data.storage?.mode] || storageMessages.system;
  byId('storage-path').textContent = data.storage?.directory || '';
  byId('pet-count').textContent = `${data.pets.length} / ${data.maxPets}`;
  renderOperation(data.operation);
  updateButtons();
  byId('pet-panel').hidden = !state; byId('empty-message').hidden = Boolean(state);
  byId('pet-picker').hidden = data.pets.length <= 1;
  byId('pet-select').disabled = !state;
  byId('shortcuts').textContent = [
    data.shortcutStatus.visibility ? 'Ctrl + Alt + S 显示 / 隐藏全部桌宠' : '显示快捷键被占用，请使用托盘菜单',
    data.shortcutStatus.clickThrough ? 'Ctrl + Alt + P 切换全部桌宠的鼠标穿透' : '穿透快捷键被占用，请使用托盘菜单'
  ].join('\n');
  if (!state) { voicePreviewKey = ''; byId('status').textContent = '未添加桌宠'; return; }
  byId('pet-select').value = state.id;
  for (const key of booleanKeys) byId(key).checked = state[key];
  byId('wander').disabled = state.manualMode;
  byId('autoActions').disabled = state.manualMode;
  byId('windowEdges').disabled = !state.gravity || !data.windowDetection.available;
  byId('window-status').textContent = data.windowDetection.error || (!state.gravity ? '启用重力后可使用窗口边缘停靠。' : '支持可见窗口的上边缘；窗口最小化或关闭后，桌宠受重力影响下落。');
  byId('scale').value = Math.round(state.scale * 100);
  byId('scale-value').textContent = `${Math.round(state.scale * 100)}%`;
  byId('speed').value = state.speed; byId('speed-value').textContent = state.speed;
  byId('frameRate').value = state.frameRate;
  const voice = state.voice;
  byId('voiceEnabled').disabled = !voice?.available && !state.voiceEnabled;
  const nextVoiceSignature = voice ? `${voice.id}:${voice.cached}:${voice.clips.map(clip => clip.id).join(',')}` : '';
  if (nextVoiceSignature !== voiceSignature) {
    voiceSignature = nextVoiceSignature;
    options(byId('voice-clip'), (voice?.clips || []).map(clip => ({ value: clip.id, label: clip.label === '戳一下' ? '点击交互' : clip.label || clip.id })));
    if (voice?.clips.some(clip => clip.id === '034')) byId('voice-clip').value = '034';
  }
  byId('voice-controls').hidden = !state.voiceEnabled;
  byId('voice-status').textContent = state.voiceError || (!voice?.available ? '当前干员无法读取 PRTS 语音。' : voice.cached ? `${voice.language} · PRTS Wiki · 已下载` : 'PRTS Wiki 语音尚未下载，可点击下载或重试。');
  byId('download-voice').hidden = !voice?.available || voice.cached;
  byId('voiceVolume').value = Math.round(state.voiceVolume * 100);
  byId('voiceVolume-value').textContent = `${Math.round(state.voiceVolume * 100)}%`;
  updateVoicePreview();
  updateButtons();
  byId('pause').textContent = state.paused ? '恢复活动' : '暂停活动';
  byId('visibility').textContent = state.fullscreenSuspended ? (state.userHidden ? '恢复后显示桌宠' : '恢复后保持隐藏') : (state.userHidden ? '显示桌宠' : '隐藏桌宠');
  const status = state.error || (state.fullscreenSuspended ? '全屏应用运行中，已自动休眠' : !state.ready ? '正在加载模型…' : !state.visible ? '已隐藏' : state.paused ? '已暂停' : state.manualMode ? '手动模式' : state.clickThrough ? '鼠标穿透已启用' : '自动模式');
  byId('status').textContent = `${state.model.name} · ${status}${data.fullscreen?.error ? ` · ${data.fullscreen.error}` : ''}`;
  for (const button of document.querySelectorAll('[data-action]')) {
    button.disabled = !state.ready || state.fullscreenSuspended || !state.supportedActions.includes(button.dataset.action);
    button.hidden = !Object.hasOwn(state.model.forms.find(form => form.id === state.form).animations, button.dataset.action);
    button.classList.toggle('selected', button.dataset.action === state.pose);
  }
  for (const button of document.querySelectorAll('[data-walk]')) button.disabled = !state.ready || state.fullscreenSuspended || !state.supportedActions.includes('move');
  if (formSignature !== state.model.id) {
    options(byId('form-select'), state.model.forms.map(form => ({ value: form.id, label: form.name })));
    formSignature = state.model.id;
  }
  byId('form-row').hidden = state.model.forms.length < 2;
  byId('form-select').value = state.form;
  byId('form-select').disabled = !state.ready;
}

for (const key of booleanKeys) byId(key).addEventListener('change', event => bridge.settings({ [key]: event.target.checked }, selectedId));
for (const key of ['scale', 'speed']) {
  byId(key).addEventListener('input', event => { byId(`${key}-value`).textContent = key === 'scale' ? `${event.target.value}%` : event.target.value; });
  byId(key).addEventListener('change', event => bridge.settings({ [key]: Number(event.target.value) / (key === 'scale' ? 100 : 1) }, selectedId));
}
for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => bridge.action(button.dataset.action, selectedId));
for (const button of document.querySelectorAll('[data-walk]')) button.addEventListener('click', () => bridge.walk(Number(button.dataset.walk), selectedId));
for (const command of ['pause', 'visibility', 'reset', 'reload', 'quit']) byId(command).addEventListener('click', () => bridge.command(command, selectedId));
byId('form-select').addEventListener('change', event => bridge.form(event.target.value, selectedId));
byId('frameRate').addEventListener('change', event => bridge.settings({ frameRate: Number(event.target.value) }, selectedId));
byId('voiceVolume').addEventListener('input', event => { byId('voiceVolume-value').textContent = `${event.target.value}%`; });
byId('voiceVolume').addEventListener('change', event => bridge.settings({ voiceVolume: Number(event.target.value) / 100 }, selectedId));
byId('voice-clip').addEventListener('change', () => { updateButtons(); updateVoicePreview(); });
byId('voice-source').addEventListener('click', () => bridge.openVoiceTextSource(selectedId));
byId('play-voice').addEventListener('click', () => bridge.playVoice(byId('voice-clip').value, selectedId));
byId('stop-voice').addEventListener('click', () => bridge.stopVoice(selectedId));
byId('download-voice').addEventListener('click', () => request(() => bridge.downloadVoice(selectedId), '语音已下载。'));
byId('pet-select').addEventListener('change', event => bridge.selectPet(event.target.value));
byId('model-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(updateChoices, 120); });
byId('model-select').addEventListener('change', updateButtons);
byId('add-pet').addEventListener('click', () => request(() => bridge.addPet(byId('model-select').value), '已添加桌宠。'));
byId('replace-pet').addEventListener('click', () => request(() => bridge.replacePet(byId('model-select').value, selectedId), '已切换干员。'));
byId('save-limit').addEventListener('click', () => request(() => bridge.setMaxPets(Number(byId('max-pets').value)), '桌宠数量上限已保存。'));
byId('autoStart').addEventListener('change', event => {
  const enabled = event.target.checked;
  request(async () => {
    const result = await bridge.setAutoStart(enabled);
    if (result.ok) {
      currentData.autoStart = result;
      byId('autoStart').checked = result.enabled;
      byId('auto-start-status').textContent = result.enabled
        ? '已启用。登录 Windows 后将直接显示桌宠，不打开设置窗口。'
        : '默认关闭。开启后将直接显示桌宠，不打开设置窗口。';
    } else byId('autoStart').checked = currentData.autoStart?.enabled || false;
    return result;
  }, enabled ? '开机自动启动已启用。' : '开机自动启动已关闭。');
});
byId('save-proxy').addEventListener('click', () => request(async () => {
  const result = await bridge.setProxy(byId('proxy-address').value, byId('proxy-port').value);
  if (result.ok) {
    byId('proxy-address').value = result.proxyAddress;
    byId('proxy-port').value = result.proxyPort;
    voicePreviewKey = ''; updateVoicePreview();
  }
  return result;
}, '下载代理设置已保存。'));
byId('ai-enabled').addEventListener('change', () => { aiDirty = true; });
byId('ai-model').addEventListener('change', () => { aiDirty = true; });
for (const id of ['ai-gateway', 'ai-key']) byId(id).addEventListener('input', () => {
  aiDirty = true; setAiModels([], '');
});
byId('load-ai-models').addEventListener('click', () => request(async () => {
  const selected = byId('ai-model').value;
  const result = await bridge.listAiModels(aiForm());
  if (result.ok) {
    setAiModels(result.models, result.models.includes(selected) ? selected : '');
    aiDirty = true;
    result.warning = `已加载 ${result.models.length} 个模型，请从列表中选择。`;
  }
  return result;
}, '模型列表已加载。'));
byId('save-ai').addEventListener('click', () => request(async () => {
  const result = await bridge.setAi(aiForm());
  if (result.ok) aiDirty = false;
  if (result.ai) { currentData.ai = result.ai; renderAi(result.ai); }
  if (result.ok) byId('ai-key').value = '';
  return result;
}, 'AI 对话配置已保存。'));
byId('test-ai').addEventListener('click', () => request(async () => {
  const result = await bridge.testAi(aiForm());
  if (result.ok) result.warning = result.message;
  return result;
}, 'AI 接口连接成功。'));
byId('clear-ai-key').addEventListener('click', () => {
  if (!window.confirm('清除已保存的 API Key 并停用 AI 对话？')) return;
  request(async () => {
    const result = await bridge.clearAiKey();
    if (result.ok) aiDirty = false;
    if (result.ai) { currentData.ai = result.ai; renderAi(result.ai); }
    if (result.ok) byId('ai-key').value = '';
    return result;
  }, 'API Key 已清除，AI 对话已停用。');
});
byId('cancel-download').addEventListener('click', () => { bridge.cancelDownload(); byId('operation-message').textContent = '正在取消下载…'; });
byId('detach').addEventListener('click', () => bridge.detach());
byId('quit-all').addEventListener('click', () => bridge.command('quit-all'));
for (const tab of document.querySelectorAll('[data-settings-tab]')) {
  tab.addEventListener('click', () => selectSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-settings-tab]')], index = tabs.indexOf(tab);
    selectSettingsTab(tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].dataset.settingsTab, true);
  });
}
selectSettingsTab('pet');
bridge.onLauncherState(render);
bridge.onLauncherProgress(operation => { if (currentData) currentData.operation = operation; renderOperation(operation); updateButtons(); });
window.addEventListener('beforeunload', () => clearTimeout(searchTimer));
bridge.getState().then(render);
