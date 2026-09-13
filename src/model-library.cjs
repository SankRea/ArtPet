const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MODELS, CATALOG_COMMIT, findModel, safeFile } = require('./models.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(filename, signal) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename, { signal })) digest.update(chunk);
  return digest.digest('hex');
}

class ModelLibrary {
  constructor(userData, downloads) {
    this.root = path.join(userData, 'models');
    this.downloads = downloads;
    this.cached = new Map();
    this.revision = 0; this.catalog = null;
    let directories;
    try { directories = new Set(fs.readdirSync(this.root)); } catch { directories = new Set(); }
    for (const model of directories.size ? MODELS : []) {
      if (model.bundled) continue;
      const directory = this.cachePath(model.id);
      if (!directories.has(path.basename(directory))) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
        if (record.modelId === model.id && record.commit === CATALOG_COMMIT && Array.isArray(record.files) && record.files.length >= 3 && record.files.every(item => safeFile(item.file) && fs.statSync(path.join(directory, item.file)).size === item.bytes)) this.cached.set(model.id, record);
      } catch { /* Missing or incomplete cache: offer download on selection. */ }
    }
  }
  cachePath(id) { return path.join(this.root, hash(`${CATALOG_COMMIT}:${id}`).slice(0, 24)); }
  isCached(id) { const model = findModel(id); return Boolean(model && (model.bundled || this.cached.has(model.id))); }
  list() {
    if (!this.catalog) this.catalog = MODELS.map(model => ({ id: model.id, name: model.name, appellation: model.appellation, subtitle: model.subtitle, cached: this.isCached(model.id), bundled: model.bundled }));
    return this.catalog;
  }
  resolve(id, filename) {
    const model = findModel(id);
    if (!model || !safeFile(filename)) return null;
    const actual = filename === 'skeleton.json' ? model.skeleton : filename;
    const allowed = this.cached.get(model.id)?.files.map(item => item.file) || [model.skeleton, model.atlas, ...model.textures];
    if (!allowed.includes(actual)) return null;
    const root = model.bundled ? path.join(__dirname, '..', 'assets', 'surtr') : this.cachePath(model.id);
    return path.join(root, actual);
  }
  async ensure(id, progress, signal) {
    const model = findModel(id);
    if (!model) throw new Error('干员不在当前目录中。');
    if (model.bundled) return model;
    if (this.cached.has(model.id)) {
      const record = this.cached.get(model.id);
      let valid = true;
      for (const file of record.files) {
        try { if (await hashFile(path.join(this.cachePath(model.id), file.file), signal) !== file.sha256) valid = false; }
        catch { valid = false; }
        signal?.throwIfAborted();
        if (!valid) break;
      }
      if (valid) return model;
      this.cached.delete(model.id); this.catalog = null; this.revision++;
    }
    await fs.promises.mkdir(this.root, { recursive: true });
    const temporary = await fs.promises.mkdtemp(path.join(this.root, '.download-'));
    let bytesTotal = 0;
    const records = [];
    const removeCacheDirectory = async directory => {
      if (path.dirname(path.resolve(directory)) !== path.resolve(this.root)) throw new Error('缓存路径无效。');
      await fs.promises.rm(directory, { recursive: true, force: true });
    };
    try {
      const files = [model.atlas, model.skeleton, ...model.textures];
      for (let index = 0; index < files.length; index++) {
        signal?.throwIfAborted();
        const file = files[index];
        if (!safeFile(file)) throw new Error('模型文件名无效。');
        const url = `https://raw.githubusercontent.com/isHarryh/Ark-Models/${CATALOG_COMMIT}/models/${encodeURIComponent(model.sourceFolder)}/${encodeURIComponent(file)}`;
        const destinationFile = path.join(temporary, file);
        const record = await this.downloads.fetch(url, { signal, onProxy: () => progress({ file, index, total: files.length, received: 0, expected: 0, proxied: true }) }, async (response, attemptSignal, touch, proxied) => {
          if (!response.ok || !response.body) throw new Error(`下载 ${file} 失败（HTTP ${response.status}）。`);
          await fs.promises.rm(destinationFile, { force: true });
          const expected = Number(response.headers.get('content-length')) || 0, digest = createHash('sha256');
          let received = 0, prefix = Buffer.alloc(0);
          const inspect = new Transform({
            transform(chunk, _encoding, callback) {
              touch(); received += chunk.length;
              if (received > 32 * 1024 * 1024 || bytesTotal + received > 100 * 1024 * 1024) {
                callback(new Error('模型文件大小超出限制。')); return;
              }
              if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
              digest.update(chunk);
              progress({ file, index, total: files.length, received, expected, proxied });
              callback(null, chunk);
            }
          });
          await pipeline(Readable.fromWeb(response.body), inspect, fs.createWriteStream(destinationFile, { flags: 'wx' }), { signal: attemptSignal });
          if (!received) throw new Error(`${file} 是空文件。`);
          if (/\.png$/i.test(file) && !prefix.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`${file} 不是有效的 PNG 文件。`);
          return { file, bytes: received, sha256: digest.digest('hex') };
        });
        bytesTotal += record.bytes;
        if (file === model.atlas) {
          const lines = (await fs.promises.readFile(destinationFile, 'utf8')).split(/\r?\n/).map(line => line.trim());
          const pages = lines.filter((line, lineIndex) => /\.png$/i.test(line) && (lineIndex === 0 || !lines[lineIndex - 1]));
          if (!pages.length || pages.some(page => !safeFile(page))) throw new Error('模型图集没有有效的纹理页。');
          for (const page of pages) if (!files.includes(page)) files.push(page);
        }
        records.push(record);
        progress({ file, index: index + 1, total: files.length, received: 0, expected: 0 });
      }
      signal?.throwIfAborted();
      const record = { modelId: model.id, commit: CATALOG_COMMIT, repository: 'https://github.com/isHarryh/Ark-Models', files: records };
      await fs.promises.writeFile(path.join(temporary, 'source.json'), JSON.stringify(record, null, 2));
      const destination = this.cachePath(model.id);
      await removeCacheDirectory(destination);
      await fs.promises.rename(temporary, destination);
      this.cached.set(model.id, record); this.catalog = null; this.revision++;
      return model;
    } finally { await removeCacheDirectory(temporary); }
  }
}
module.exports = { ModelLibrary };
