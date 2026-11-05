const product = require('./src/shared/product.cjs');

module.exports = {
  appId: product.appId,
  productName: product.name,
  directories: { output: `release/${product.version}`, buildResources: 'build' },
  files: [
    'src/**/*',
    'assets/**/*',
    // Build resources are excluded from the main file set; copy the runtime icon explicitly.
    { from: 'build', to: 'build', filter: ['icon.png'] },
    'config.json',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'package.json'
  ],
  asar: true,
  asarUnpack: ['node_modules/@koromix/**/*', 'node_modules/koffi/**/*.node'],
  // Koffi supplies Node-API prebuilds through its optional platform packages.
  npmRebuild: false,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    icon: 'build/icon.ico',
    executableName: 'ArtPet',
    signAndEditExecutable: true,
    signExecutable: false
  },
  nsis: {
    artifactName: 'ArtPet-${version}-win-${arch}-setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: product.name,
    deleteAppDataOnUninstall: false,
    differentialPackage: false,
    installerLanguages: ['zh_CN', 'en_US']
  },
  portable: { artifactName: 'ArtPet-${version}-win-${arch}-portable.${ext}' }
};
