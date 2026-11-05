const { nativeImage } = require('electron');
const { ICON } = require('../paths.cjs');

let trayIcon;
function makeIcon() {
  if (!trayIcon) trayIcon = nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 });
  return trayIcon;
}

module.exports = { makeIcon };
