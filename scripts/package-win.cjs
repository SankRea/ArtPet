const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ROOT, releaseMetadata } = require('./release-metadata.cjs');

async function main() {
  const mode = process.argv[2] || 'all';
  if (process.argv.length > 3 || !['all', 'installer', 'portable'].includes(mode)) throw new Error('打包目标必须为 all、installer 或 portable。');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 上打包，或使用仓库的 Windows Release 工作流。');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('打包需要 Node.js 22.12.0 或更新版本。');
  const release = releaseMetadata();
  const targets = mode === 'all' ? ['nsis', 'portable'] : [mode === 'installer' ? 'nsis' : 'portable'];
  const files = targets.map(target => target === 'nsis' ? release.installer : release.portable);
  fs.mkdirSync(release.directory, { recursive: true });
  // Remove only this invocation's outputs so an old executable cannot pass as a new artifact.
  for (const file of [...files, 'SHA256SUMS.txt']) fs.rmSync(path.join(release.directory, file), { force: true });
  const builder = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(process.execPath, [builder, '--config', 'electron-builder.config.cjs', '--win', ...targets, '--x64', '--publish', 'never'],
    { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`打包失败（${result.signal || result.status}），请查看上方 electron-builder 输出。`);
  const checksums = [];
  for (const file of files) {
    const filename = path.join(release.directory, file);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || !stat.size) throw new Error(`未生成发行文件：${file}`);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    checksums.push(`${hash.digest('hex')}  ${file}`);
  }
  fs.writeFileSync(path.join(release.directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  console.log(`发行文件已生成：${release.directory}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
