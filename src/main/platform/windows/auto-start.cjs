const path = require('node:path');
const { ROOT } = require('../../paths.cjs');
const { autoStartName: AUTO_START_NAME } = require('../../../shared/product.cjs');

function createAutoStart(app, changed) {
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
  return { state: autoStartState, update: updateAutoStart };
}

module.exports = { createAutoStart };
