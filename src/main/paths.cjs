const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
module.exports = {
  ROOT,
  PRELOAD: path.join(ROOT, 'src', 'preload'),
  RENDERER: path.join(ROOT, 'src', 'renderer'),
  ICON: path.join(ROOT, 'build', 'icon.png')
};
