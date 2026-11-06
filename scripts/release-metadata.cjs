const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const lock = require('../package-lock.json');
const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${identifier}(?:\\.${identifier})*)?$`);

function releaseMetadata(tag) {
  if (!versionPattern.test(manifest.version)) throw new Error('版本号必须为 x.y.z 或 x.y.z-beta.1 等预发布版本。');
  if (manifest.name !== 'artpet' || manifest.productName !== 'ArtPet') throw new Error('软件名称与发布配置不一致。');
  if (tag && tag !== `v${manifest.version}`) throw new Error(`标签 ${tag} 与 package.json 版本 ${manifest.version} 不一致。`);
  if (lock.name !== manifest.name || lock.version !== manifest.version
    || lock.packages?.['']?.name !== manifest.name || lock.packages?.['']?.version !== manifest.version) {
    throw new Error('package-lock.json 的软件名称或版本与 package.json 不一致。');
  }
  for (const section of ['dependencies', 'devDependencies']) {
    const declared = manifest[section] || {}, locked = lock.packages[''][section] || {};
    if (Object.keys(declared).length !== Object.keys(locked).length
      || Object.keys(declared).some(key => declared[key] !== locked[key])) throw new Error(`${section} 与锁文件不一致，请先同步依赖。`);
  }
  for (const file of [manifest.main, 'config.json', 'build/icon.ico', 'build/icon.png', 'assets/surtr/source.json', 'THIRD_PARTY_NOTICES.md']) {
    if (!fs.statSync(path.join(ROOT, file)).isFile()) throw new Error(`缺少发布文件：${file}`);
  }
  return {
    version: manifest.version,
    directory: path.join(ROOT, 'release', manifest.version),
    installer: `ArtPet-${manifest.version}-win-x64-setup.exe`,
    portable: `ArtPet-${manifest.version}-win-x64-portable.exe`
  };
}

if (require.main === module) {
  try {
    if (process.argv.length > 3) throw new Error('用法：node scripts/release-metadata.cjs [v版本号]');
    const release = releaseMetadata(process.argv[2]);
    console.log(`ArtPet ${release.version} · release/${release.version}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { ROOT, releaseMetadata };
