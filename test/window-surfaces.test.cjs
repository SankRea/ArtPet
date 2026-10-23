const assert = require('node:assert/strict');
const test = require('node:test');
const { WindowSurfaces } = require('../src/window-surfaces.cjs');

function fixture(t, windows = {}) {
  let now = 1000, foreground = 1n;
  t.mock.method(Date, 'now', () => now);
  const lookup = hwnd => ({ className: 'GameWindow', style: 0x90000000, exStyle: 0,
    x: 0, y: 0, width: 1920, height: 1080, ...windows[String(hwnd)] });
  const detector = Object.create(WindowSurfaces.prototype);
  Object.assign(detector, {
    available: true, fullscreenError: '',
    scratch: { processId: [0], cloaked: Buffer.alloc(4), name: Buffer.alloc(512) },
    fullscreenScratch: { client: Buffer.alloc(16), origin: Buffer.alloc(8), monitor: Buffer.alloc(40) },
    foreground: () => foreground,
    visible: hwnd => lookup(hwnd).visible !== false,
    minimized: hwnd => Boolean(lookup(hwnd).minimized),
    pid: (hwnd, output) => { output[0] = lookup(hwnd).pid ?? process.pid + 1; },
    attribute: (hwnd, _attribute, output) => { output.writeUInt32LE(lookup(hwnd).cloaked || 0); return 0; },
    className: (hwnd, output) => { const name = lookup(hwnd).className; output.write(name, 'utf16le'); return name.length; },
    style: (hwnd, index) => index === -16 ? lookup(hwnd).style : lookup(hwnd).exStyle,
    monitorFromWindow: () => 10n,
    monitorInfo: (_monitor, output) => {
      [0, 0, 1920, 1080].forEach((value, i) => output.writeInt32LE(value, 4 + i * 4)); return 1;
    },
    clientRect: (hwnd, output) => {
      const record = lookup(hwnd);
      [0, 0, record.width, record.height].forEach((value, i) => output.writeInt32LE(value, i * 4)); return 1;
    },
    clientToScreen: (hwnd, output) => {
      const record = lookup(hwnd); output.writeInt32LE(record.x, 0); output.writeInt32LE(record.y, 4); return 1;
    }
  });
  return { detector, advance: milliseconds => { now += milliseconds; }, focus: hwnd => { foreground = hwnd; } };
}

test('a normal maximized window filling an auto-hidden taskbar area does not suspend pets', t => {
  const { detector, advance } = fixture(t, { 1: { className: 'Chrome_WidgetWin_1', style: 0x15cf0000 } });
  assert.equal(detector.isForegroundFullscreen(), false);
  advance(1000);
  assert.equal(detector.isForegroundFullscreen(), false);
});

for (const [name, exStyle] of [['tool window', 0x80], ['non-activating window', 0x08000000]]) {
  test(`a full-monitor ${name} used during window switching does not suspend pets`, t => {
    const { detector } = fixture(t, { 1: { exStyle } });
    assert.equal(detector.isForegroundFullscreen(), false);
  });
}

test('a window extending beyond monitor bounds does not count as fullscreen', t => {
  const { detector } = fixture(t, { 1: { x: -100, y: -100, width: 2100, height: 1300 } });
  assert.equal(detector.isForegroundFullscreen(), false);
});

test('a transient fullscreen-sized window does not hide pets before switching back to a normal window', t => {
  const { detector, advance, focus } = fixture(t, { 2: { height: 1032 } });
  assert.equal(detector.isForegroundFullscreen(), null);
  advance(100);
  focus(2n);
  assert.equal(detector.isForegroundFullscreen(), false);
});

test('a real borderless fullscreen window suspends pets after stable confirmation', t => {
  const { detector, advance } = fixture(t);
  assert.equal(detector.isForegroundFullscreen(), null);
  advance(1000);
  assert.equal(detector.isForegroundFullscreen(), true);
});

test('startup can inspect fullscreen before opening pet and settings windows', t => {
  const { detector } = fixture(t);
  assert.equal(detector.fullscreenWindow(), 1n);
});

test('fullscreen confirmation preserves the two-pixel monitor edge tolerance', t => {
  const { detector, advance, focus } = fixture(t, {
    1: { x: 2, y: 2, width: 1916, height: 1076 },
    2: { x: 3, y: 0, width: 1917, height: 1080 }
  });
  assert.equal(detector.isForegroundFullscreen(), null);
  advance(1000);
  assert.equal(detector.isForegroundFullscreen(), true);
  focus(2n);
  assert.equal(detector.isForegroundFullscreen(), false);
});

test('confirmation restarts when a different foreground window replaces the candidate', t => {
  const { detector, advance, focus } = fixture(t);
  assert.equal(detector.isForegroundFullscreen(), null);
  advance(1000);
  focus(2n);
  assert.equal(detector.isForegroundFullscreen(), null);
  advance(1000);
  assert.equal(detector.isForegroundFullscreen(), true);
});

test('losing the foreground window clears a pending fullscreen candidate', t => {
  const { detector, advance, focus } = fixture(t);
  assert.equal(detector.isForegroundFullscreen(), null);
  advance(1000);
  focus(null);
  assert.equal(detector.isForegroundFullscreen(), null);
  focus(1n);
  assert.equal(detector.isForegroundFullscreen(), null);
  advance(1000);
  assert.equal(detector.isForegroundFullscreen(), true);
});

test('a focus change during geometry queries does not suspend pets using stale window data', t => {
  const { detector, focus } = fixture(t);
  const clientToScreen = detector.clientToScreen;
  detector.clientToScreen = (...args) => { const result = clientToScreen(...args); focus(2n); return result; };
  assert.equal(detector.isForegroundFullscreen(), null);
});

test('returning from fullscreen to an ordinary window restores pets immediately', t => {
  const { detector, advance, focus } = fixture(t, { 2: { height: 1032 } });
  detector.isForegroundFullscreen(); advance(1000);
  assert.equal(detector.isForegroundFullscreen(), true);
  focus(2n);
  assert.equal(detector.isForegroundFullscreen(), false);
});

test('ArkPet and cloaked windows never trigger fullscreen suspension', t => {
  const { detector, focus } = fixture(t, { 1: { pid: process.pid }, 2: { cloaked: 1 } });
  assert.equal(detector.isForegroundFullscreen(), false);
  focus(2n);
  assert.equal(detector.isForegroundFullscreen(), false);
});

test('Windows accepts Peek exclusion for an actual hidden native window', { skip: process.platform !== 'win32' }, t => {
  const koffi = require('koffi'), user32 = koffi.load('user32.dll');
  const createWindow = user32.func('void * __stdcall CreateWindowExW(uint32 exStyle, const char16_t *className, const char16_t *name, uint32 style, int x, int y, int width, int height, void *parent, void *menu, void *instance, void *param)');
  const destroyWindow = user32.func('int __stdcall DestroyWindow(void *hwnd)');
  const hwnd = createWindow(0, 'STATIC', 'ArkPet native window test', 0, 0, 0, 100, 100, null, null, null, null);
  assert.ok(hwnd, 'CreateWindowExW must create a test window');
  t.after(() => { assert.equal(destroyWindow(hwnd), 1); });
  const detector = new WindowSurfaces({});
  assert.equal(detector.available, true, detector.error);
  const handle = Buffer.alloc(koffi.sizeof('void *'));
  if (handle.length === 8) handle.writeBigUInt64LE(hwnd);
  else handle.writeUInt32LE(Number(hwnd));
  let result, attribute;
  const setAttribute = detector.setAttribute;
  detector.setAttribute = (...args) => { attribute = args[1]; result = setAttribute(...args); return result; };
  detector.excludeFromPeek({ isDestroyed: () => false, getNativeWindowHandle: () => handle });
  assert.equal(attribute, 12);
  assert.equal(result, 0, 'DWM must accept Peek exclusion for the native handle');
  assert.equal(detector.visible(hwnd), 0, 'the native test must not show a window');
});
