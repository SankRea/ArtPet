const { BrowserWindow, Menu, screen } = require('electron');
const path = require('node:path');
const { findModel } = require('./models.cjs');
const { clamp, stepPhysics } = require('./physics.cjs');
const { VoiceCaption } = require('./voice-caption.cjs');

const DEFAULTS = { scale: 0.75, speed: 40, frameRate: 30, voiceEnabled: false, idleVoiceEnabled: false, voiceTextEnabled: true, voiceVolume: 0.6, wander: true, autoActions: true, manualMode: false, gravity: true, windowEdges: true, alwaysOnTop: true, clickThrough: false, translucent: false, form: null, x: null, y: null };
const LABELS = { default: '恢复待机', interact: '交互动作', relax: '休息', sit: '坐下', sleep: '睡眠', special: '特殊动作' };
const IDLE_SLEEP_DELAY = 10 * 60 * 1000;
const exists = win => win && !win.isDestroyed();
const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;

class PetWindow {
  constructor(host, saved) {
    this.host = host; this.id = saved.id; this.model = findModel(saved.modelId);
    this.settings = { ...DEFAULTS, scale: number(saved.scale, DEFAULTS.scale, 0.5, 1.5), speed: number(saved.speed, 40, 15, 90), frameRate: [15, 24, 30, 45, 60].includes(saved.frameRate) ? saved.frameRate : DEFAULTS.frameRate, voiceVolume: number(saved.voiceVolume, 0.6, 0, 1) };
    for (const key of Object.keys(DEFAULTS)) if (typeof DEFAULTS[key] === 'boolean' && typeof saved[key] === 'boolean') this.settings[key] = saved[key];
    this.settings.form = this.model.forms.find(form => form.id === saved.form)?.id || this.model.forms[0].id;
    this.geometry = { footX: 210 * this.settings.scale, footY: 366 * this.settings.scale, halfWidth: 55 * this.settings.scale,
      visualLeft: 0, visualRight: 420 * this.settings.scale };
    const size = this.size(), area = screen.getPrimaryDisplay().workArea;
    this.body = { x: number(saved.x, area.x + area.width - size.width - 36 - host.spawnIndex * 90, -100000, 100000), y: number(saved.y, area.y + area.height - this.geometry.footY, -100000, 100000), vx: 0, vy: 0, support: null };
    this.ready = false; this.error = ''; this.paused = false; this.ignored = false; this.menuOpen = false;
    this.voiceError = '';
    this.caption = new VoiceCaption(this);
    this.userHidden = false;
    this.fullscreenSuspended = host.globalState().fullscreen.active;
    this.suspendedAt = this.fullscreenSuspended ? Date.now() : 0;
    this.hitRects = []; this.animations = []; this.supported = []; this.dragging = null; this.walking = null;
    this.pose = 'default'; this.manualHold = false; this.falling = false; this.resolvedActions = {};
    this.actionVariants = {}; this.idleAnimations = []; this.currentAnimation = null;
    const now = Date.now();
    this.nextBehavior = now + 9000 + Math.random() * 4000;
    this.sleepAt = now + IDLE_SLEEP_DELAY;
    this.win = new BrowserWindow({
      ...size, x: Math.round(this.body.x), y: Math.round(this.body.y), title: `${this.model.name} · ArkPet`,
      transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, maximizable: false,
      fullscreenable: false, minimizable: false, hasShadow: false, skipTaskbar: true, show: false,
      alwaysOnTop: this.settings.alwaysOnTop,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, autoplayPolicy: 'no-user-gesture-required' }
    });
    this.webContentsId = this.win.webContents.id;
    host.secureWindow(this.win);
    const [initialX, initialY] = this.win.getPosition();
    this.position = { x: initialX, y: initialY };
    this.win.on('move', () => {
      if (!exists(this.win)) return;
      const [x, y] = this.win.getPosition();
      this.position = { x, y };
      if (x !== Math.round(this.body.x) || y !== Math.round(this.body.y)) {
        this.body.x = x; this.body.y = y; this.body.support = null; this.host.wakeLoop();
      }
      this.caption.syncPosition();
    });
    this.win.setOpacity(this.settings.translucent ? 0.55 : 1);
    this.contain(); this.place();
    this.win.once('ready-to-show', () => { if (!this.userHidden) this.show(); });
    this.win.on('blur', () => this.endDrag(true));
    this.win.on('hide', () => this.caption.close());
    this.win.on('closed', () => { this.caption.close(); this.win = null; host.closed(this); });
    this.win.webContents.on('render-process-gone', () => { this.ready = false; this.error = '画面进程已停止，请在菜单中重新加载'; this.stopWalking(); this.changed(); });
    this.win.webContents.on('did-fail-load', (_event, code, message) => { if (code !== -3) { this.error = message; this.changed(); } });
    this.win.loadURL('arkpet://app/renderer/pet.html');
  }

  size() { return { width: Math.round(420 * this.settings.scale), height: Math.round(380 * this.settings.scale) }; }
  noteActivity() { this.sleepAt = Date.now() + IDLE_SLEEP_DELAY; }
  send(channel, data) { if (exists(this.win)) this.win.webContents.send(channel, data); }
  form() { return this.model.forms.find(form => form.id === this.settings.form); }
  serialise() { return { id: this.id, modelId: this.model.id, ...this.settings, x: Math.round(this.body.x), y: Math.round(this.body.y) }; }
  state(includeVoice = true) {
    const state = { ...this.serialise(), model: this.model, ready: this.ready, error: this.error, paused: this.paused,
      visible: exists(this.win) && this.win.isVisible(), supportedActions: this.supported, pose: this.pose,
      userHidden: this.userHidden, fullscreenSuspended: this.fullscreenSuspended,
      voiceError: this.voiceError };
    if (includeVoice) state.voice = this.host.voices.state(this.model.id);
    return state;
  }
  changed() {
    if (!this.settings.voiceEnabled || !this.settings.voiceTextEnabled || !this.ready || this.error || this.paused || this.userHidden || this.fullscreenSuspended) this.caption.close();
    else this.caption.syncPosition();
    this.send('pet:state', this.state()); this.host.changed();
  }
  place() {
    if (!exists(this.win)) return;
    const x = Math.round(this.body.x), y = Math.round(this.body.y);
    if (x !== this.position.x || y !== this.position.y) {
      this.position = { x, y }; this.win.setBounds({ x, y, ...this.size() });
    }
    this.caption.syncPosition();
  }
  contain() {
    const { body, geometry } = this;
    const area = screen.getDisplayNearestPoint({ x: Math.round(body.x + geometry.footX), y: Math.round(body.y + geometry.footY - 1) }).workArea;
    const previousX = body.x, previousY = body.y;
    body.x = clamp(body.x, area.x - geometry.visualLeft, area.x + area.width - geometry.visualRight);
    body.y = clamp(body.y, area.y, area.y + area.height - geometry.footY);
    if (body.x !== previousX) body.vx = 0;
    if (body.y !== previousY && body.y === area.y && body.vy < 0) body.vy = 0;
    return area;
  }
  setIgnoring(value) {
    if (!exists(this.win) || this.ignored === value) return;
    this.ignored = value; this.win.setIgnoreMouseEvents(value, { forward: true });
  }
  show() {
    if (!exists(this.win)) return;
    this.userHidden = false;
    if (!this.fullscreenSuspended) { this.contain(); this.place(); this.win.showInactive(); }
    this.changed();
  }
  toggleVisible() {
    this.noteActivity();
    if (!this.userHidden) { this.userHidden = true; this.endDrag(true); this.stopWalking(); this.win.hide(); this.changed(); } else this.show();
  }
  setFullscreenSuspended(value) {
    if (!exists(this.win) || this.fullscreenSuspended === value) return;
    this.fullscreenSuspended = value;
    if (value) {
      this.suspendedAt = Date.now();
      this.endDrag(true);
      this.menuOpen = false;
      this.win.hide();
      this.changed();
    } else {
      const elapsed = Date.now() - this.suspendedAt;
      this.nextBehavior += elapsed;
      this.sleepAt += elapsed;
      if (this.walking) this.walking.until += elapsed;
      this.suspendedAt = 0;
      if (!this.userHidden) { this.contain(); this.place(); this.win.showInactive(); }
      this.changed();
    }
  }
  reset() {
    this.endDrag(true); this.stopWalking();
    this.noteActivity();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    Object.assign(this.body, { x: area.x + area.width - this.geometry.footX - 100, y: area.y + area.height - this.geometry.footY, vx: 0, vy: 0, support: null });
    this.show(); this.host.save();
  }
  updateSettings(patch) {
    if (!patch || typeof patch !== 'object') return;
    const previous = { ...this.settings };
    for (const key of Object.keys(DEFAULTS)) if (typeof DEFAULTS[key] === 'boolean' && typeof patch[key] === 'boolean') this.settings[key] = patch[key];
    if ('scale' in patch) this.settings.scale = number(patch.scale, previous.scale, 0.5, 1.5);
    if ('speed' in patch) this.settings.speed = number(patch.speed, previous.speed, 15, 90);
    if ([15, 24, 30, 45, 60].includes(patch.frameRate)) this.settings.frameRate = patch.frameRate;
    if ('voiceVolume' in patch) this.settings.voiceVolume = number(patch.voiceVolume, previous.voiceVolume, 0, 1);
    if (Object.keys(DEFAULTS).every(key => previous[key] === this.settings[key])) return;
    this.noteActivity();
    if (this.settings.alwaysOnTop !== previous.alwaysOnTop) this.win.setAlwaysOnTop(this.settings.alwaysOnTop, 'floating');
    if (this.settings.translucent !== previous.translucent) this.win.setOpacity(this.settings.translucent ? 0.55 : 1);
    if (this.settings.scale !== previous.scale) {
      this.endDrag(true); this.stopWalking();
      const ratio = this.settings.scale / previous.scale, footX = this.body.x + this.geometry.footX, footY = this.body.y + this.geometry.footY;
      for (const key of ['footX', 'footY', 'halfWidth', 'visualLeft', 'visualRight']) this.geometry[key] *= ratio;
      this.body.x = footX - this.geometry.footX; this.body.y = footY - this.geometry.footY;
      this.contain();
      // Resize and reposition together so move events cannot restore the old origin.
      this.position = { x: Math.round(this.body.x), y: Math.round(this.body.y) };
      this.win.setBounds({ ...this.position, ...this.size() });
    }
    if (!this.settings.wander || this.settings.manualMode) this.stopWalking();
    if (this.settings.clickThrough) this.endDrag(true);
    if (previous.gravity !== this.settings.gravity || previous.windowEdges !== this.settings.windowEdges) Object.assign(this.body, { vx: 0, vy: 0, support: null });
    if ((!previous.wander && this.settings.wander) || (previous.manualMode && !this.settings.manualMode)) { this.manualHold = false; this.act('default', false); }
    this.nextBehavior = Date.now() + 5000;
    this.host.save(); this.changed();
    if (!previous.voiceEnabled && this.settings.voiceEnabled && this.host.voices.state(this.model.id).available && !this.host.voices.state(this.model.id).cached) this.host.downloadVoice(this.id);
  }
  setForm(id) {
    if (id === this.settings.form || !this.model.forms.some(form => form.id === id)) return;
    this.endDrag(true); this.stopWalking();
    this.noteActivity();
    this.settings.form = id; this.ready = false; this.supported = [];
    this.manualHold = false; this.pose = 'default';
    this.host.save(); this.changed(); this.send('pet:form', id);
  }
  loaded(data) {
    if (!data || data.modelId !== this.model.id || data.form !== this.settings.form || !Array.isArray(data.animations)) return;
    this.animations = data.animations.filter(item => item && typeof item.name === 'string' && Number.isFinite(item.duration) && item.duration >= 0 && item.duration <= 600).slice(0, 200);
    this.resolvedActions = Object.fromEntries(Object.entries(data.actions || {}).filter(([action, name]) => Object.hasOwn(this.form().animations, action) && this.animations.some(animation => animation.name === name)));
    this.supported = Object.keys(this.resolvedActions);
    const knownAnimations = new Map(this.animations.map(animation => [animation.name, animation]));
    this.actionVariants = Object.fromEntries(this.supported.map(action => [action, [...new Set([
      this.resolvedActions[action], ...(Array.isArray(data.variants?.[action]) ? data.variants[action] : [])
    ])].filter(name => knownAnimations.has(name))]));
    const idle = new Map();
    for (const action of ['relax', 'sit', 'special', 'default']) {
      for (const name of this.actionVariants[action] || []) {
        if (knownAnimations.get(name).duration > 0 && !idle.has(name)) idle.set(name, { action, name });
      }
    }
    this.idleAnimations = [...idle.values()];
    this.currentAnimation = this.resolvedActions.default;
    this.noteActivity();
    this.error = ''; this.ready = true; this.changed();
  }
  switchModel(id) {
    const model = findModel(id);
    if (!model || model.id === this.model.id) return;
    this.endDrag(true); this.stopWalking();
    this.noteActivity();
    this.model = model; this.settings.form = model.forms[0].id;
    this.voiceError = '';
    this.ready = false; this.error = ''; this.animations = []; this.resolvedActions = {}; this.supported = []; this.hitRects = [];
    this.actionVariants = {}; this.idleAnimations = []; this.currentAnimation = null;
    this.manualHold = false; this.pose = 'default'; this.body.vx = 0; this.body.vy = 0;
    this.win.setTitle(`${model.name} · ArkPet`);
    this.changed(); this.host.save(); this.win.webContents.reload();
  }
  setGeometry(data) {
    const [contentWidth, contentHeight] = this.win.getContentSize();
    if (!data || data.width !== contentWidth || data.height !== contentHeight || !['footX', 'footY', 'halfWidth', 'visualLeft', 'visualRight'].every(key => Number.isFinite(data[key]))) return;
    if (data.footX < 0 || data.footX > contentWidth || data.footY < 0 || data.footY > contentHeight || data.visualLeft < 0 || data.visualRight > contentWidth || data.visualLeft >= data.visualRight) return;
    const footX = this.body.x + this.geometry.footX, footY = this.body.y + this.geometry.footY;
    this.geometry = { footX: data.footX, footY: data.footY, halfWidth: clamp(data.halfWidth, 5, contentWidth / 2),
      visualLeft: data.visualLeft, visualRight: data.visualRight };
    this.body.x = footX - this.geometry.footX; this.body.y = footY - this.geometry.footY;
    this.contain(); this.place(); this.host.wakeLoop();
  }
  stopWalking() {
    if (!this.walking) return;
    this.walking = null; this.pose = 'default';
    this.currentAnimation = this.resolvedActions.default;
    this.send('pet:motion', { walking: false }); this.host.save(); this.changed();
  }
  startWalking(direction, manual = true) {
    if (this.fullscreenSuspended || !this.ready || !this.supported.includes('move') || ![-1, 1].includes(direction)) return;
    this.endDrag(true); this.stopWalking(); this.manualHold = false;
    if (manual) { this.paused = false; this.noteActivity(); this.show(); }
    this.walking = { direction, until: Date.now() + 2400 + Math.random() * 3600 };
    this.pose = 'move'; this.nextBehavior = Date.now() + 15000;
    this.currentAnimation = this.resolvedActions.move;
    this.send('pet:motion', { walking: true, direction }); this.changed();
  }
  act(action, manual = true, voice = true, animation = this.resolvedActions[action]) {
    if (this.fullscreenSuspended || !this.ready || !this.supported.includes(action) || !Object.hasOwn(LABELS, action)) return;
    if (!this.actionVariants[action]?.includes(animation)) return;
    this.endDrag(true); this.stopWalking();
    if (manual) { this.paused = false; this.noteActivity(); }
    this.manualHold = manual && action !== 'default';
    this.pose = action;
    this.currentAnimation = animation;
    const duration = this.animations.find(item => item.name === animation)?.duration || 0;
    // Autonomous poses also finish at least two cycles before another action is chosen.
    this.nextBehavior = Date.now() + Math.max(duration * 2000, action === 'sleep' ? 25000 : 8000) + Math.random() * 12000;
    if (manual) this.show();
    this.send('pet:action', { action, manual, voice, animation }); this.changed();
  }
  interact() {
    if (this.fullscreenSuspended || !this.ready || this.settings.clickThrough || this.dragging) return;
    this.noteActivity();
    if (this.supported.includes('interact')) { this.act('interact', true, false); this.manualHold = false; }
    else if (this.pose === 'sleep' && this.supported.includes('default')) this.act('default', true, false);
    else { this.paused = false; this.show(); }
    const voice = this.host.voices.state(this.model.id);
    if (!this.settings.voiceEnabled || !voice.cached || !voice.clips.length) return;
    const choices = voice.clips.length > 1 ? voice.clips.filter(clip => clip.id !== this.lastClickVoice) : voice.clips;
    const clip = choices[Math.floor(Math.random() * choices.length)];
    this.lastClickVoice = clip.id;
    this.send('pet:voice-play', clip.id);
  }
  stopVoice() { this.caption.close(); this.send('pet:voice-stop'); }
  showVoiceCaption(data) {
    if (!data) { this.caption.close(); return; }
    if (data.modelId !== this.model.id || !this.settings.voiceEnabled || !this.settings.voiceTextEnabled || !this.ready || this.paused || this.userHidden || this.fullscreenSuspended || this.dragging) return;
    const clip = this.host.voices.state(this.model.id).clips.find(item => item.id === data.clipId);
    if (!clip || !Number.isSafeInteger(data.playbackId) || !Number.isFinite(data.duration) || data.duration <= 0 || data.duration > 180) return;
    this.caption.show({ name: this.model.name, label: clip.label === '戳一下' ? '点击交互' : clip.label,
      text: clip.text, hasText: true, duration: data.duration, playbackId: data.playbackId });
  }
  startDrag() {
    if (this.fullscreenSuspended || this.settings.clickThrough || this.dragging) return;
    this.noteActivity();
    if (this.pose === 'sleep' && this.supported.includes('default')) this.act('default', false, false);
    this.stopWalking(); this.body.vx = 0; this.body.vy = 0;
    const cursor = screen.getCursorScreenPoint();
    this.dragging = { cursor, lastCursor: cursor, x: this.body.x, y: this.body.y, vx: 0, vy: 0, moved: false, lastTime: Date.now() };
    this.setIgnoring(false); this.host.wakeLoop();
  }
  endDrag(cancelled) {
    if (!this.dragging) return;
    const drag = this.dragging; this.dragging = null;
    if (drag.moved) {
      const recent = Date.now() - drag.lastTime < 120;
      Object.assign(this.body, { vx: !cancelled && recent && this.settings.gravity ? drag.vx : 0, vy: !cancelled && recent && this.settings.gravity ? drag.vy : 0, support: null });
      this.contain(); this.place();
    }
    this.nextBehavior = Date.now() + 8000;
    this.send('pet:drag-end', { moved: drag.moved, cancelled: Boolean(cancelled) }); this.host.save(); this.host.wakeLoop();
  }
  togglePause() { this.endDrag(true); this.stopWalking(); this.noteActivity(); this.paused = !this.paused; this.changed(); }
  reload() { this.ready = false; this.error = ''; this.endDrag(true); this.stopWalking(); this.noteActivity(); this.changed(); this.win.webContents.reload(); }

  menu() {
    const cachedModels = this.host.cachedModels();
    return [
      { label: `${this.model.name} · ${this.form().name}`, enabled: false },
      { label: '打开设置', click: () => this.host.openLauncher(this.id) },
      { label: '切换干员', enabled: cachedModels.some(model => model.id !== this.model.id), submenu: cachedModels.map(model => ({
        label: `${model.name} · ${model.subtitle}`, type: 'radio', checked: model.id === this.model.id,
        click: () => { if (this.host.modelCached(model.id)) this.switchModel(model.id); }
      })) },
      { label: '动作', enabled: this.ready && !this.fullscreenSuspended, submenu: [
        ...Object.entries(LABELS).filter(([action]) => this.supported.includes(action)).map(([action, label]) => ({ label, click: () => this.act(action) })),
        ...(this.supported.includes('move') ? [
          { label: '向左移动', click: () => this.startWalking(-1) },
          { label: '向右移动', click: () => this.startWalking(1) }
        ] : [])
      ] },
      { type: 'separator' },
      { label: this.paused ? '恢复活动' : '暂停活动', click: () => this.togglePause() },
      { label: '停止当前语音', enabled: this.settings.voiceEnabled, click: () => this.stopVoice() },
      { type: 'separator' },
      { label: this.userHidden ? '显示桌宠' : '隐藏桌宠', click: () => this.toggleVisible() },
      { label: '关闭当前桌宠', click: () => this.host.closePet(this.id) },
      { label: '退出应用', click: () => this.host.quit() }
    ];
  }
  contextMenu() {
    this.noteActivity();
    this.endDrag(true); this.stopWalking(); this.menuOpen = true; this.setIgnoring(false);
    Menu.buildFromTemplate(this.menu()).popup({ window: this.win, callback: () => { this.menuOpen = false; } });
  }

  isMoving() {
    return !this.fullscreenSuspended && Boolean(this.dragging || (this.ready && !this.paused && !this.menuOpen &&
      (this.walking || (this.settings.gravity && (!this.body.support || this.body.vx || this.body.vy)))));
  }
  collisionSurfaces() {
    const environment = this.host.environment(), revision = this.host.surfaces.revision;
    const previous = this.surfaceCache, edges = this.settings.windowEdges, footY = this.geometry.footY;
    if (previous && previous.environment === environment && previous.revision === revision && previous.edges === edges && previous.footY === footY) return previous.values;
    const ledges = edges ? this.host.surfaces.surfaces.filter(surface => environment.displays.some(display =>
      surface.right > display.workArea.x && surface.left < display.workArea.x + display.workArea.width &&
      surface.y - footY >= display.workArea.y && surface.y <= display.workArea.y + display.workArea.height)) : [];
    const values = ledges.length ? [...environment.floors, ...ledges] : environment.floors;
    this.surfaceCache = { environment, revision, edges, footY, values };
    return values;
  }
  tick(dt, now, cursor) {
    if (this.fullscreenSuspended || !exists(this.win) || !this.win.isVisible()) return;
    const bounds = this.position;
    const hovered = cursor && !this.settings.clickThrough && this.hitRects.some(rect => cursor.x >= bounds.x + rect.x && cursor.x <= bounds.x + rect.x + rect.width && cursor.y >= bounds.y + rect.y && cursor.y <= bounds.y + rect.y + rect.height);
    this.setIgnoring(!this.menuOpen && !this.dragging && (this.settings.clickThrough || !hovered));
    if (this.dragging) {
      const drag = this.dragging, dx = cursor.x - drag.cursor.x, dy = cursor.y - drag.cursor.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; this.send('pet:dragging', true); }
      const elapsed = Math.max(0.01, (now - drag.lastTime) / 1000);
      drag.vx = clamp((cursor.x - drag.lastCursor.x) / elapsed, -1200, 1200);
      drag.vy = clamp((cursor.y - drag.lastCursor.y) / elapsed, -1000, 1200);
      drag.lastCursor = cursor; drag.lastTime = now;
      if (drag.moved) { this.body.x = drag.x + dx; this.body.y = drag.y + dy; this.place(); }
      return;
    }
    if (!this.ready || this.paused || this.menuOpen) return;
    if (hovered && !this.settings.clickThrough) this.stopWalking();
    if (this.walking && now >= this.walking.until) this.stopWalking();
    const walkSpeed = this.walking ? this.walking.direction * this.settings.speed * this.settings.scale : 0;
    const wasFalling = this.falling;
    let moved = false;
    if (this.settings.gravity) {
      const surfaces = this.collisionSurfaces();
      if (!this.body.support || walkSpeed || this.body.vx || this.body.vy || this.lastPhysicsSurfaces !== surfaces) {
        this.falling = stepPhysics(this.body, this.geometry, surfaces, dt, walkSpeed);
        this.lastPhysicsSurfaces = surfaces; moved = true;
      }
    } else {
      this.falling = false; this.body.x += walkSpeed * dt; moved = Boolean(walkSpeed);
    }
    if (moved) {
      const oldX = this.body.x;
      this.contain();
      if (oldX !== this.body.x && this.walking) this.stopWalking();
      this.place();
    }
    if (this.falling && this.walking) this.stopWalking();
    if (wasFalling && !this.falling) this.host.save();
    if (this.settings.manualMode || this.manualHold || this.falling || this.walking || this.menuOpen) return;
    if (this.settings.autoActions && !hovered && now >= this.sleepAt && this.supported.includes('sleep')) {
      if (this.pose !== 'sleep') {
        const variants = this.actionVariants.sleep;
        this.act('sleep', false, this.settings.idleVoiceEnabled, variants[Math.floor(Math.random() * variants.length)]);
      } else this.nextBehavior = now + 60000;
      return;
    }
    if (now < this.nextBehavior) return;
    this.nextBehavior = now + 7000 + Math.random() * 11000;
    // Deduplicate aliases (e.g. default/relax) by animation name, then avoid repeats.
    const idle = this.settings.autoActions ? this.idleAnimations.filter(item => item.name !== this.currentAnimation) : [];
    const canWalk = this.settings.wander && this.supported.includes('move') && !hovered;
    if (canWalk && (!idle.length || Math.random() < 0.25)) {
      this.startWalking(Math.random() < 0.5 ? -1 : 1, false);
      return;
    }
    if (idle.length) {
      const next = idle[Math.floor(Math.random() * idle.length)];
      this.act(next.action, false, this.settings.idleVoiceEnabled, next.name);
    } else if (this.pose !== 'default') this.act('default', false);
  }
}

module.exports = { PetWindow, DEFAULTS };
