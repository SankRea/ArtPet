const { BrowserWindow } = require('electron');
const path = require('node:path');
const { PRELOAD, ICON } = require('../paths.cjs');
const product = require('../../shared/product.cjs');
const { secureWindow } = require('./security.cjs');

function createSettingsWindow({ onReady, onRestore, onClosed }) {
  const win = new BrowserWindow({
    width: 780, height: 700, minWidth: 620, minHeight: 560, title: `${product.name} 设置`,
    backgroundColor: '#ffffff', autoHideMenuBar: true, show: false, icon: ICON,
    webPreferences: { preload: path.join(PRELOAD, 'pet.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  secureWindow(win);
  win.once('ready-to-show', onReady);
  win.on('restore', onRestore);
  win.on('closed', onClosed);
  win.loadURL('arkpet://app/renderer/settings.html');
  return win;
}

module.exports = { createSettingsWindow };
