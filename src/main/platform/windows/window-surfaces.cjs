const IGNORED_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

// Only inspect other apps' geometry; native attributes affect ArkPet windows only.
class WindowSurfaces {
  constructor(screen) {
    this.screen = screen;
    this.surfaces = [];
    this.revision = 0;
    this.available = false;
    this.error = '';
    this.fullscreenError = '';
    this.fullscreenCandidate = null; this.fullscreenCandidateSince = 0;
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
      this.setAttribute = dwm.func('int32 __stdcall DwmSetWindowAttribute(void *hwnd, uint32 attribute, const void *value, uint32 size)');
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

  excludeFromPeek(win) {
    if (!this.available || win.isDestroyed()) return;
    try {
      const handle = win.getNativeWindowHandle();
      if (handle.length !== 4 && handle.length !== 8) throw new Error('窗口句柄长度无效');
      const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
      const enabled = Buffer.alloc(4); enabled.writeInt32LE(1);
      // Keep ArkPet and its captions visible while Windows previews another window.
      const result = this.setAttribute(hwnd, 12, enabled, 4); // DWMWA_EXCLUDED_FROM_PEEK, BOOL
      if (result !== 0) throw new Error(`DwmSetWindowAttribute 返回 0x${(result >>> 0).toString(16)}`);
    } catch (error) { console.warn(`无法排除任务栏预览隐藏：${error.message}`); }
  }

  isForegroundFullscreen() {
    const hwnd = this.fullscreenWindow();
    if (!hwnd) { this.fullscreenCandidate = null; return hwnd; }
    const now = Date.now();
    if (this.fullscreenCandidate !== hwnd) {
      this.fullscreenCandidate = hwnd; this.fullscreenCandidateSince = now;
      return null;
    }
    // Window switching can briefly expose fullscreen-sized helper windows.
    return now - this.fullscreenCandidateSince >= 300 ? true : null;
  }

  fullscreenWindow() {
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
      // Framed/child windows and non-activating tools are not fullscreen apps,
      // even when custom title bars or an auto-hidden taskbar fill the monitor.
      const style = this.style(hwnd, -16), exStyle = this.style(hwnd, -20);
      if (style & (0x00c00000 | 0x00040000 | 0x40000000)) return false; // WS_CAPTION, WS_THICKFRAME, WS_CHILD
      if (exStyle & (0x80 | 0x08000000)) return false; // WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE
      const monitor = this.monitorFromWindow(hwnd, 2); // MONITOR_DEFAULTTONEAREST
      const scratch = this.fullscreenScratch;
      scratch.monitor.writeUInt32LE(40, 0); // sizeof(MONITORINFO)
      scratch.origin.fill(0);
      if (!monitor || !this.monitorInfo(monitor, scratch.monitor) || !this.clientRect(hwnd, scratch.client) || !this.clientToScreen(hwnd, scratch.origin)) throw new Error('无法读取前台窗口边界');
      const x = scratch.origin.readInt32LE(0), y = scratch.origin.readInt32LE(4);
      const width = scratch.client.readInt32LE(8), height = scratch.client.readInt32LE(12);
      const left = scratch.monitor.readInt32LE(4), top = scratch.monitor.readInt32LE(8);
      const right = scratch.monitor.readInt32LE(12), bottom = scratch.monitor.readInt32LE(16);
      // Do not combine geometry read from a window that has already lost focus.
      if (this.foreground() !== hwnd) return null;
      // Match the monitor bounds, rather than accepting oversized windows that cover it.
      const matches = width > 0 && height > 0 && Math.abs(x - left) <= 2 && Math.abs(y - top) <= 2
        && Math.abs(x + width - right) <= 2 && Math.abs(y + height - bottom) <= 2;
      return matches ? hwnd : false;
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
