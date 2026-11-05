function secureWindow(win) {
  // Page zoom is shared by origin and bypasses the pet's scale and geometry.
  // Reapply after navigation so model reloads also keep CSS pixels aligned with DIP.
  const disablePageZoom = () => win.webContents.setZoomMode('disabled');
  disablePageZoom();
  win.webContents.on('did-navigate', disablePageZoom);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
}
module.exports = { secureWindow };
