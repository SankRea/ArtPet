const IGNORED_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

// Read only window geometry. Never inspect titles, contents, or control another app.
class WindowSurfaces {
  constructor(screen) {
    this.screen = screen;
    this.surfaces = [];
    this.revision = 0;
    this.available = false;
    this.error = '';
    this.fullscreenError = '';
    if (process.platform !== 'win32') { this.error = '窗口上沿检测仅支持 Windows'; return; }
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const dwm = koffi.load('dwmapi.dll');
      koffi.struct('ArkPetRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
      const callback = koffi.proto('int __stdcall ArkPetEnumProc(void *hwnd, intptr_t param)');
      this.enumWindows = user32.func('int __stdcall EnumWindows(ArkPetEnumProc *callback, intptr_t param)');
      this.visible = user32.func('int __stdcall IsWindowVisible(void *hwnd)');
      this.minimized = user32.func('int __stdcall IsIconic(void *hwnd)');
      this.pid = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)');
      this.style = user32.func('int32 __stdcall GetWindowLongW(void *hwnd, int index)');
      this.className = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ char16_t *name, int length)');
      this.rect = user32.func('int __stdcall GetWindowRect(void *hwnd, _Out_ ArkPetRECT *rect)');
      this.attribute = dwm.func('int32 __stdcall DwmGetWindowAttribute(void *hwnd, uint32 attribute, void *value, uint32 size)');
      this.callbackType = callback; // Keep callback metadata alive for the native binding.
      this.scratch = { cloaked: Buffer.alloc(4), name: Buffer.alloc(512), raw: Buffer.alloc(16), processId: [0] };
      this.foreground = user32.func('void * __stdcall GetForegroundWindow()');
      this.clientRect = user32.func('int __stdcall GetClientRect(void *hwnd, void *rect)');
      this.clientToScreen = user32.func('int __stdcall ClientToScreen(void *hwnd, void *point)');
      this.monitorFromWindow = user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32 flags)');
      this.monitorInfo = user32.func('int __stdcall GetMonitorInfoW(void *monitor, void *info)');
      this.fullscreenScratch = { client: Buffer.alloc(16), origin: Buffer.alloc(8), monitor: Buffer.alloc(40) };
      this.available = true;
    } catch (error) { this.error = `窗口检测不可用：${error.message}`; }
  }

  isForegroundFullscreen() {
    if (!this.available) return null;
    try {
      this.fullscreenError = '';
      const hwnd = this.foreground();
      // Windows can temporarily have no foreground window while focus changes.
      if (!hwnd) return null;
      if (!this.visible(hwnd) || this.minimized(hwnd)) return false;
      const { processId, cloaked, name } = this.scratch;
      processId[0] = 0; this.pid(hwnd, processId);
      if (processId[0] === process.pid) return false;
      if (this.attribute(hwnd, 14, cloaked, 4) === 0 && cloaked.readUInt32LE() !== 0) return false;
      const length = this.className(hwnd, name, 256);
      if (IGNORED_CLASSES.has(name.toString('utf16le', 0, Math.max(0, length) * 2))) return false;
      const monitor = this.monitorFromWindow(hwnd, 2); // MONITOR_DEFAULTTONEAREST
      const scratch = this.fullscreenScratch;
      scratch.monitor.writeUInt32LE(40, 0); // sizeof(MONITORINFO)
      scratch.origin.fill(0);
      if (!monitor || !this.monitorInfo(monitor, scratch.monitor) || !this.clientRect(hwnd, scratch.client) || !this.clientToScreen(hwnd, scratch.origin)) throw new Error('无法读取前台窗口边界');
      const x = scratch.origin.readInt32LE(0), y = scratch.origin.readInt32LE(4);
      const width = scratch.client.readInt32LE(8), height = scratch.client.readInt32LE(12);
      const left = scratch.monitor.readInt32LE(4), top = scratch.monitor.readInt32LE(8);
      const right = scratch.monitor.readInt32LE(12), bottom = scratch.monitor.readInt32LE(16);
      // Compare client area to the full physical monitor, not the desktop work area.
      // A normal maximized window's title bar/taskbar leaves part of this area uncovered.
      return width > 0 && height > 0 && x <= left + 2 && y <= top + 2 && x + width >= right - 2 && y + height >= bottom - 2;
    } catch (error) {
      this.fullscreenError = `全屏检测暂时失败：${error.message}`;
      return null;
    }
  }

  refresh() {
    if (!this.available) return;
    try {
      const windows = [];
      this.enumWindows(hwnd => {
        if (!this.visible(hwnd) || this.minimized(hwnd)) return 1;
        const { processId, cloaked, name, raw } = this.scratch;
        processId[0] = 0; this.pid(hwnd, processId);
        if (processId[0] === process.pid) return 1;
        if (this.attribute(hwnd, 14, cloaked, 4) === 0 && cloaked.readUInt32LE() !== 0) return 1;
        const nameLength = this.className(hwnd, name, 256);
        const className = name.toString('utf16le', 0, Math.max(0, nameLength) * 2);
        if (IGNORED_CLASSES.has(className)) return 1;
        let rect;
        if (this.attribute(hwnd, 9, raw, 16) === 0) {
          rect = { left: raw.readInt32LE(0), top: raw.readInt32LE(4), right: raw.readInt32LE(8), bottom: raw.readInt32LE(12) };
        } else {
          rect = {}; if (!this.rect(hwnd, rect)) return 1;
        }
        if (rect.right <= rect.left || rect.bottom <= rect.top) return 1;
        const dip = this.screen.screenToDipRect(null, { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top });
        const exStyle = this.style(hwnd, -20);
        windows.push({ id: `window:${hwnd}`, ...dip, eligible: !(exStyle & 0x80) && !(exStyle & 0x20) && dip.width >= 100 && dip.height >= 60 });
        return 1;
      }, 0);
      const surfaces = [], blockers = [];
      // EnumWindows gives topmost windows first. Subtract covered parts of each ledge.
      for (const win of windows) {
        if (win.eligible) {
          let spans = [[win.x, win.x + win.width]];
          for (const blocker of blockers) {
            if (blocker.y > win.y + 1 || blocker.y + blocker.height <= win.y) continue;
            spans = spans.flatMap(([left, right]) => {
              if (blocker.x >= right || blocker.x + blocker.width <= left) return [[left, right]];
              return [[left, Math.min(right, blocker.x)], [Math.max(left, blocker.x + blocker.width), right]].filter(([a, b]) => b - a > 12);
            });
          }
          for (const [left, right] of spans) surfaces.push({ id: win.id, left, right, y: win.y, originX: win.x, kind: 'window' });
        }
        blockers.push(win);
      }
      const unchanged = surfaces.length === this.surfaces.length && surfaces.every((surface, index) => {
        const previous = this.surfaces[index];
        return surface.id === previous.id && surface.left === previous.left && surface.right === previous.right && surface.y === previous.y && surface.originX === previous.originX;
      });
      if (!unchanged) { this.surfaces = surfaces; this.revision++; }
      this.error = '';
    } catch (error) {
      if (this.surfaces.length) { this.surfaces = []; this.revision++; }
      this.error = `窗口检测暂时失败：${error.message}`;
    }
  }
}

module.exports = { WindowSurfaces };
