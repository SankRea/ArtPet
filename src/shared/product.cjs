const manifest = require('../../package.json');

module.exports = Object.freeze({
  name: manifest.productName,
  version: manifest.version,
  // These identifiers belong to existing installs and user data, not display branding.
  appId: 'local.arkpet.surtr',
  dataDirectoryName: 'ArkPet Surtr',
  portableDataDirectoryName: 'ArkPet-data',
  autoStartName: 'ArkPet Surtr'
});
