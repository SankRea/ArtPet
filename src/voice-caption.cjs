const { BrowserWindow, screen } = require('electron');
const path = require('node:path');
const { clamp } = require('./physics.cjs');

class VoiceCaption {
  constructor(pet) { this.pet = pet; this.sequence = 0; }
  show(data) {
    if (this.win && !this.win.isDestroyed() && this.data?.playbackId === data.playbackId) {
      this.data = { ...data, token: this.data.token, startedAt: Date.now() };
      if (this.loaded) this.win.webContents.send('caption:show', this.data);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.close(), data.duration * 1000 + 200);
      return;
    }
    this.close();
    const pet = this.pet;
    this.data = { ...data, token: ++this.sequence, startedAt: Date.now() };
    this.win = new BrowserWindow({
      width: 360, height: 160, parent: pet.win, show: false, frame: false,
      transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: pet.settings.alwaysOnTop,
      webPreferences: { preload: path.join(__dirname, 'voice-caption-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    const win = this.win;
    pet.host.secureWindow(win);
    win.setIgnoreMouseEvents(true);
    win.webContents.once('did-finish-load', () => {
      if (this.win !== win) return;
      this.loaded = true;
      this.syncPosition();
      win.webContents.send('caption:show', this.data);
    });
    win.on('closed', () => { if (this.win === win) this.win = null; });
    win.loadURL('arkpet://app/renderer/voice-caption.html').catch(() => { if (this.win === win) this.close(); });
    this.timer = setTimeout(() => this.close(), data.duration * 1000 + 200);
  }
  resize(data) {
    if (!this.win || this.win.isDestroyed() || data?.token !== this.data?.token || !Number.isFinite(data.height)) return;
    this.height = clamp(Math.ceil(data.height), 100, 340);
    this.syncPosition();
    if (!this.pet.userHidden && !this.pet.fullscreenSuspended && this.pet.settings.voiceEnabled && !this.pet.paused) this.win.showInactive();
  }
  syncPosition() {
    if (!this.win || this.win.isDestroyed()) return;
    const { body, geometry } = this.pet;
    const anchor = { x: Math.round(body.x + geometry.footX), y: Math.round(body.y + geometry.footY) };
    const area = screen.getDisplayNearestPoint(anchor).workArea;
    const width = Math.min(360, area.width), height = Math.min(this.height || 160, area.height);
    const x = clamp(Math.round(anchor.x - width / 2), area.x, area.x + area.width - width);
    let y = Math.round(body.y - height - 8);
    if (y < area.y) y = Math.round(anchor.y + 12);
    y = clamp(y, area.y, area.y + area.height - height);
    const bounds = `${x},${y},${width},${height}`;
    if (bounds !== this.bounds) { this.bounds = bounds; this.win.setBounds({ x, y, width, height }); }
    if (this.alwaysOnTop !== this.pet.settings.alwaysOnTop) {
      this.alwaysOnTop = this.pet.settings.alwaysOnTop;
      this.win.setAlwaysOnTop(this.alwaysOnTop, 'floating');
    }
  }
  close() {
    clearTimeout(this.timer);
    const win = this.win; this.win = null; this.data = null; this.height = null; this.bounds = null; this.loaded = false; this.alwaysOnTop = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
module.exports = { VoiceCaption };
