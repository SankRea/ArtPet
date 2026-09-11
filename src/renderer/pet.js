/* global PIXI */
const bridge = window.arkpet;
const hit = document.querySelector('#pet-hit');
const bubble = document.querySelector('#bubble');
const loading = document.querySelector('#loading');
const modelUrl = filename => renderModel.assetBase + encodeURIComponent(filename);
let app, pet, world, envelope, renderModel, fit = 1, direction = 1, bubbleTimer;
let prefs = { paused: false, visible: true, wander: true }, pose = 'default', dragging = false, pointerPressed = false;
let actionMap = {}, idleBounds, displayReady = false, animated = false, hitElapsed = 0, lastHitSignature = '', lastPetRect = '';
const voicePlayer = new window.ArkPetVoice(say, (modelId, message) => bridge.voiceError(modelId, message));

function say(text, duration = 3200) {
  clearTimeout(bubbleTimer);
  bubble.textContent = text; bubble.hidden = false;
  bubbleTimer = setTimeout(() => { bubble.hidden = true; }, duration);
}

function play(action) {
  if (!pet) return;
  const name = actionMap[action] || actionMap.default;
  if (!name) return;
  pet.state.clearTracks();
  pet.skeleton.setToSetupPose();
  pet.state.setAnimation(0, name, true);
  pet.update(0);
  pose = action;
  animated = pet.spineData.animations.find(animation => animation.name === name)?.duration > 0;
  if (displayReady) { app.render(); updateHitArea(); updatePlayback(); }
}

function applyAction({ action, manual = true }) {
  if (!pet) return;
  if (!actionMap[action]) { say('这个模型没有对应动作。'); return; }
  play(action);
  const clipId = { interact: '034', special: '036', relax: '010', sit: '010', sleep: '010' }[action];
  if (clipId) voicePlayer.play(clipId, manual);
}

// Sample the model's own poses once so the pool, hair and props have room.
// The resulting fixed envelope prevents the character from bouncing as bounds change.
function measureEnvelope() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const enabledNames = new Set(Object.values(actionMap));
  for (const animation of pet.spineData.animations.filter(item => enabledNames.has(item.name))) {
    pet.state.clearTracks(); pet.skeleton.setToSetupPose();
    pet.state.setAnimation(0, animation.name, false);
    for (let frame = 0; frame <= 16; frame++) {
      pet.update(frame === 0 ? 0 : animation.duration / 16);
      const rect = pet.getLocalBounds();
      if (rect.width <= 0 || rect.height <= 0) continue;
      minX = Math.min(minX, rect.x); minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width); maxY = Math.max(maxY, rect.y + rect.height);
    }
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) throw new Error('模型没有可显示的骨骼区域。');
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function layout() {
  if (!app || !envelope) return;
  if (app.screen.width !== innerWidth || app.screen.height !== innerHeight) app.renderer.resize(innerWidth, innerHeight);
  fit = Math.min((innerWidth - 24) / envelope.width, (innerHeight - 94) / envelope.height);
  world.scale.set(fit * direction, fit);
  world.position.set(innerWidth / 2 - (envelope.minX + envelope.maxX) / 2 * fit * direction, innerHeight - 10 - envelope.maxY * fit);
  bridge.geometry({ width: innerWidth, height: innerHeight, footX: world.x + idleBounds.centerX * fit * direction,
    footY: world.y + idleBounds.bottom * fit, halfWidth: Math.max(8, idleBounds.width * fit * 0.24) });
  updateHitArea();
  if (displayReady) app.render();
}

function configureForm(id) {
  if (!pet) return;
  const form = renderModel.forms.find(item => item.id === id) || renderModel.forms[0];
  prefs.form = form.id;
  const animations = pet.spineData.animations;
  const names = animations.map(animation => animation.name);
  actionMap = {};
  for (const [action, candidates] of Object.entries(form.animations)) {
    const matches = candidates.flatMap(candidate => names.filter(name => name.toLowerCase() === candidate.toLowerCase()).concat(names.filter(name => name.toLowerCase().startsWith(`${candidate.toLowerCase()}_`))));
    const name = matches.find(name => animations.find(animation => animation.name === name).duration > 0) || matches[0];
    if (name) actionMap[action] = name;
  }
  if (!actionMap.default) throw new Error('当前形态缺少待机动画。');
  play('default');
  const bounds = pet.getLocalBounds();
  idleBounds = { centerX: bounds.x + bounds.width / 2, bottom: bounds.y + bounds.height, width: bounds.width };
  envelope = measureEnvelope();
  play('default'); layout();
  bridge.ready({ modelId: renderModel.id, form: form.id, actions: actionMap, animations: pet.spineData.animations.map(animation => ({ name: animation.name, duration: animation.duration })) });
}

function clickAction() { bridge.action('interact'); }

function updateHitArea() {
  if (!prefs.visible) return;
  const rectangles = [];
  if (pet && !hit.hidden) {
    const rect = pet.getBounds();
    const left = Math.max(0, Math.floor(rect.x - 3)), top = Math.max(0, Math.floor(rect.y - 3));
    const right = Math.min(innerWidth, Math.ceil(rect.x + rect.width + 3)), bottom = Math.min(innerHeight, Math.ceil(rect.y + rect.height + 3));
    const petRect = `${left},${top},${right},${bottom}`;
    if (petRect !== lastPetRect) {
      lastPetRect = petRect;
      Object.assign(hit.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px` });
      bubble.style.left = `${innerWidth / 2}px`;
      bubble.style.top = `${Math.max(66, top - 12)}px`;
    }
    rectangles.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  if (!loading.hidden) {
    const r = loading.getBoundingClientRect();
    rectangles.push({ x: r.x, y: r.y, width: r.width, height: r.height });
  }
  const signature = JSON.stringify(rectangles);
  if (signature !== lastHitSignature) { lastHitSignature = signature; bridge.hitRects(rectangles); }
}

hit.addEventListener('pointerdown', event => {
  if (event.button !== 0 || prefs.clickThrough) return;
  event.preventDefault();
  pointerPressed = true;
  hit.setPointerCapture(event.pointerId);
  bridge.startDrag();
});
hit.addEventListener('pointerup', event => {
  if (event.button !== 0) return;
  pointerPressed = false;
  bridge.endDrag(false);
  if (hit.hasPointerCapture(event.pointerId)) hit.releasePointerCapture(event.pointerId);
});
hit.addEventListener('pointercancel', () => { pointerPressed = false; bridge.endDrag(true); });
hit.addEventListener('lostpointercapture', () => { if (pointerPressed) { pointerPressed = false; bridge.endDrag(true); } });
hit.addEventListener('dblclick', () => bridge.command('settings'));
hit.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); clickAction(); }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); bridge.walk(event.key === 'ArrowLeft' ? -1 : 1); }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); bridge.contextMenu(); }
});
hit.addEventListener('wheel', event => {
  event.preventDefault();
  bridge.settings({ scale: Math.max(0.5, Math.min(1.5, (prefs.scale || 0.75) + (event.deltaY < 0 ? 0.05 : -0.05))) });
}, { passive: false });
document.addEventListener('contextmenu', event => { event.preventDefault(); bridge.contextMenu(); });
document.querySelector('#retry').addEventListener('click', () => location.reload());
document.querySelector('#open-settings').addEventListener('click', () => bridge.command('settings'));
document.querySelector('#quit').addEventListener('click', () => bridge.command('quit'));

bridge.onDragging(() => {
  dragging = true; hit.classList.add('dragging');
  clearTimeout(bubbleTimer); bubble.hidden = true;
  voicePlayer.stop(); updatePlayback();
});
bridge.onDragEnd(({ moved, cancelled }) => {
  pointerPressed = false; dragging = false; hit.classList.remove('dragging');
  updatePlayback();
  if (!moved && !cancelled) clickAction();
});
bridge.onAction(applyAction);
bridge.onVoice(clipId => voicePlayer.play(clipId));
bridge.onVoiceStop(() => { voicePlayer.stop(true); clearTimeout(bubbleTimer); bubble.hidden = true; });
bridge.onForm(id => { try { configureForm(id); } catch (error) { showError(error); } });
bridge.onMotion(({ walking, direction: nextDirection }) => {
  if (!pet) return;
  if (walking) {
    direction = nextDirection; layout();
    play('move');
  } else if (pose === 'move') play('default');
});
function applyState(value) {
  prefs = value;
  voicePlayer.configure(value);
  if (!value.voiceEnabled || !value.visible || value.paused || value.fullscreenSuspended) { clearTimeout(bubbleTimer); bubble.hidden = true; }
  updatePlayback();
  updateHitArea();
}
function updatePlayback() {
  if (!app) return;
  const frameRate = [15, 24, 30, 45, 60].includes(prefs.frameRate) ? prefs.frameRate : 30;
  if (app.ticker.maxFPS !== frameRate) app.ticker.maxFPS = frameRate;
  if (displayReady && animated && prefs.model?.id === renderModel.id && prefs.visible && !document.hidden && !prefs.paused && !prefs.fullscreenSuspended && !prefs.error && !dragging) app.start();
  else app.stop();
}
bridge.onState(applyState);
window.addEventListener('resize', layout);
document.addEventListener('visibilitychange', () => { updatePlayback(); if (document.hidden) voicePlayer.stop(true); });

async function init() {
  try {
    applyState(await bridge.getState());
    renderModel = prefs.model;
    document.title = `${prefs.model.name} · 桌面宠物`;
    hit.setAttribute('aria-label', `${prefs.model.name}：点击互动，拖动或抛掷，右键菜单`);
    if (!window.PIXI?.spine) throw new Error('渲染依赖缺失，请先在项目目录执行 npm install。');
    // HTMLImageElement + PMA preserves the upstream premultiplied texture.
    await PIXI.Assets.init({ preferences: { preferCreateImageBitmap: false, preferWorkers: false } });
    app = new PIXI.Application({ width: innerWidth, height: innerHeight, backgroundAlpha: 0, antialias: false, autoDensity: true, resolution: 1, powerPreference: 'low-power', autoStart: false });
    // All interaction uses the HTML hit area; disable Pixi's duplicate pointer listeners and system ticker.
    app.renderer.events?.setTargetElement(null);
    app.stage.eventMode = 'none';
    document.querySelector('#scene').appendChild(app.view);
    const atlasResponse = await fetch(modelUrl(renderModel.atlas));
    if (!atlasResponse.ok) throw new Error('本地图集文件缺失。');
    const atlasText = await atlasResponse.text();
    const atlas = await new Promise((resolve, reject) => {
      new PIXI.spine.TextureAtlas(atlasText, (pageName, callback) => {
        if (/[\\/]/.test(pageName) || pageName.includes('..')) { reject(new Error('纹理页路径无效。')); callback(null); return; }
        PIXI.Assets.load({ src: modelUrl(pageName), data: { alphaMode: PIXI.ALPHA_MODES.PMA } })
          .then(texture => { try { callback(texture.baseTexture); } catch (error) { reject(error); } })
          .catch(error => { reject(error); callback(null); });
      }, loaded => loaded ? resolve(loaded) : reject(new Error('无法读取图集。')));
    });
    const skeletonResponse = await fetch(modelUrl(renderModel.skeleton));
    if (!skeletonResponse.ok) throw new Error('本地骨骼文件缺失。');
    const skeletonBytes = await skeletonResponse.arrayBuffer();
    const prefix = new TextDecoder().decode(skeletonBytes.slice(0, 64)).replace(/^\uFEFF/, '').trimStart();
    const skeletonUrl = modelUrl(prefix.startsWith('{') ? 'skeleton.json' : renderModel.skeleton);
    const resource = await PIXI.Assets.load({ src: skeletonUrl, data: { spineAtlas: atlas } });
    pet = new PIXI.spine.Spine(resource.spineData);
    pet.autoUpdate = false;
    pet.localDelayLimit = 0;
    pet.stateData.defaultMix = 0;
    world = new PIXI.Container(); world.addChild(pet); app.stage.addChild(world);
    configureForm(prefs.form);
    if (prefs.model.id !== renderModel.id) return;
    loading.hidden = true; hit.hidden = false; updateHitArea();
    app.ticker.add(() => {
      pet.update(Math.min(app.ticker.deltaMS / 1000, 0.1));
      hitElapsed += app.ticker.deltaMS;
      if (hitElapsed >= 150) { hitElapsed = 0; updateHitArea(); }
    });
    displayReady = true; app.render();
    applyState(prefs);
    say('左键拖动 · 点击互动\n右键菜单 · 双击打开面板', 6500);
  } catch (error) {
    showError(error);
  }
  updateHitArea();
}

function showError(error) {
  displayReady = false;
  voicePlayer.stop(true);
  console.error(error); app?.stop(); hit.hidden = true; loading.hidden = false;
  document.querySelector('#loading-dot').hidden = true;
  document.querySelector('#load-title').textContent = '桌宠暂时迷路了';
  document.querySelector('#load-detail').textContent = error.message || String(error);
  document.querySelector('#error-actions').hidden = false;
  bridge.error(error.message || String(error));
}

window.addEventListener('beforeunload', () => { voicePlayer.stop(true); clearTimeout(bubbleTimer); app?.destroy(true, { children: true }); });
init();
