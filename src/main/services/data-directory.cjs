const fs = require('node:fs');
const path = require('node:path');
const product = require('../../shared/product.cjs');

function prepareDataDirectory(app) {
  const systemDirectory = app.getPath('userData');
  const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;
  if (!app.isPackaged || !portableDirectory || !path.isAbsolute(portableDirectory)) {
    return { directory: systemDirectory, mode: 'system' };
  }
  const preferred = path.join(portableDirectory, product.portableDataDirectoryName);
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.R_OK | fs.constants.W_OK);
    return { directory: preferred, mode: 'portable' };
  } catch (error) {
    console.warn(`便携版数据目录不可用，改用系统用户数据目录：${error.message}`);
    return { directory: systemDirectory, mode: 'fallback' };
  }
}

module.exports = { prepareDataDirectory };
