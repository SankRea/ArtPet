const path = require('node:path');
const { BrowserWindow, shell } = require('electron');
const { sourceUrl } = require('./prts-profile-source.cjs');

const exists = win => win && !win.isDestroyed();

class AiChatWindows {
  constructor(host) {
    this.host = host;
    this.windows = new Map();
    this.byContents = new Map();
  }
  open(pet) {
    if (!pet || !this.host.settings.state().ready) return false;
    const existing = this.windows.get(pet.id);
    if (exists(existing)) { existing.show(); existing.focus(); return true; }
    const win = new BrowserWindow({
      width: 420, height: 560, minWidth: 360, minHeight: 420,
      title: `${pet.model.name} · 对话`, backgroundColor: '#f4f5f8', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'ai-chat-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    const contentsId = win.webContents.id;
    this.windows.set(pet.id, win);
    this.byContents.set(contentsId, pet.id);
    this.host.secureWindow(win);
    win.once('ready-to-show', () => { if (exists(win)) { win.show(); win.focus(); } });
    win.on('closed', () => {
      this.host.client.abort(pet.id);
      this.windows.delete(pet.id);
      this.byContents.delete(contentsId);
    });
    win.loadURL('arkpet://app/renderer/ai-chat.html').catch(() => { if (exists(win)) win.destroy(); });
    return true;
  }
  pet(event) {
    if (event.senderFrame !== event.sender.mainFrame) return null;
    const id = this.byContents.get(event.sender.id), win = id && this.windows.get(id);
    if (!id || !exists(win) || win.webContents !== event.sender) return null;
    return this.host.getPet(id) || null;
  }
  state(pet) {
    if (!pet) return null;
    const settings = this.host.settings.state();
    return { ready: settings.ready, name: pet.model.name, modelId: pet.model.id,
      messages: this.host.client.messages(pet), source: sourceUrl(pet.model.name),
      status: settings.ready ? `使用 ${settings.model} · 对话记录仅保留到本次运行结束` : 'AI 对话配置当前不可用。' };
  }
  register(ipcMain) {
    ipcMain.handle('ai-chat:get-state', event => this.state(this.pet(event)));
    ipcMain.handle('ai-chat:send', async (event, message) => {
      const pet = this.pet(event);
      if (!pet) return { ok: false, error: '对话窗口已失效。' };
      try { return { ok: true, ...await this.host.client.chat(pet, message) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('ai-chat:clear', event => {
      const pet = this.pet(event);
      if (!pet) return { ok: false, error: '对话窗口已失效。' };
      this.host.client.clear(pet);
      return { ok: true, messages: [] };
    });
    ipcMain.on('ai-chat:open-source', event => {
      const pet = this.pet(event);
      if (pet) shell.openExternal(sourceUrl(pet.model.name)).catch(() => {});
    });
  }
  refresh() {
    for (const [petId, win] of this.windows) {
      const pet = this.host.getPet(petId);
      if (pet && exists(win)) win.webContents.send('ai-chat:state', this.state(pet));
    }
  }
  closePet(petId) {
    this.host.client.clearPet(petId);
    const win = this.windows.get(petId);
    if (exists(win)) win.destroy();
  }
  closeAll() {
    this.host.client.abortAll();
    for (const win of this.windows.values()) if (exists(win)) win.destroy();
    this.windows.clear(); this.byContents.clear();
  }
}

module.exports = { AiChatWindows };
