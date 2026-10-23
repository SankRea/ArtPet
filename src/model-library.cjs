const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MODELS, DEFAULT_MODEL_ID, bundledCatalog, validCommit, parseCatalog, upstreamCatalog, setModels, findModel, safeFile } = require('./models.cjs');
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
    this.catalogPath = path.join(userData, 'model-catalog.json');
    this.snapshot = bundledCatalog;
    this.latestCommit = ''; this.checkedAt = ''; this.catalogError = '';
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.catalogPath, 'utf8'));
      const models = parseCatalog(snapshot);
      this.snapshot = snapshot; setModels(models);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.catalogError = `本地更新目录无法读取，暂用内置目录：${error.message}`;
        console.warn(this.catalogError);
      }
    }
    let directories;
    try { directories = fs.readdirSync(this.root, { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith('.')); } catch { directories = []; }
    for (const entry of directories) {
      const directory = path.join(this.root, entry.name);
      try {
        const record = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
        const model = findModel(record.modelId);
        if (model && !model.bundled && directory === this.cachePath(model.id) && record.commit === model.commit && Array.isArray(record.files) && record.files.length >= 3
          && record.files.every(item => safeFile(item.file) && fs.statSync(path.join(directory, item.file)).size === item.bytes)) this.cached.set(model.id, record);
      } catch { /* Missing or incomplete cache: offer download on selection. */ }
    }
  }
  updateState() {
    return { commit: this.snapshot.commit, latestCommit: this.latestCommit, checkedAt: this.checkedAt,
      available: Boolean(this.latestCommit && this.latestCommit !== this.snapshot.commit), error: this.catalogError };
  }
  async fetchCatalogJson(url, file, progress, signal, limit = 8 * 1024 * 1024) {
    const report = (received = 0, expected = 0, proxied = false) => progress({ phase: '目录', file, index: 0, total: 1, received, expected, proxied });
    report();
    return this.downloads.fetch(url, { signal, onProxy: () => report(0, 0, true) }, async (response, attemptSignal, touch, proxied) => {
      if (!response.ok || !response.body) {
        const hint = response.status === 403 || response.status === 429 ? '，GitHub 可能已限制请求频率，请稍后重试' : '';
        throw new Error(`读取 ${file} 失败（HTTP ${response.status}${hint}）。`);
      }
      const expected = Number(response.headers.get('content-length')) || 0;
      const chunks = []; let received = 0;
      for await (const chunk of Readable.fromWeb(response.body, { signal: attemptSignal })) {
        touch(); received += chunk.length;
        if (received > limit) throw new Error('模型目录大小超出限制。');
        chunks.push(chunk); report(received, expected, proxied);
      }
      attemptSignal.throwIfAborted();
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error(`${file} 不是有效的 JSON 目录。`); }
    });
  }
  async checkForUpdates(progress, signal) {
    const reference = await this.fetchCatalogJson('https://api.github.com/repos/isHarryh/Ark-Models/git/ref/heads/main', '上游版本', progress, signal, 64 * 1024);
    const commit = reference?.object?.sha;
    if (reference?.ref !== 'refs/heads/main' || reference?.object?.type !== 'commit' || !validCommit(commit)) throw new Error('上游返回的模型目录版本无效。');
    signal?.throwIfAborted();
    this.latestCommit = commit; this.checkedAt = new Date().toISOString(); this.catalogError = '';
    return commit === this.snapshot.commit ? '当前模型目录已是最新版本。' : '发现模型目录更新，点击“拉取更新”即可更新列表。';
  }
  async pullUpdates(progress, signal) {
    const commit = this.latestCommit;
    if (!validCommit(commit) || commit === this.snapshot.commit) throw new Error('请先检查模型目录更新。');
    const data = await this.fetchCatalogJson(`https://raw.githubusercontent.com/isHarryh/Ark-Models/${commit}/models_data.json`, 'models_data.json', progress, signal);
    const snapshot = upstreamCatalog(data, commit);
    const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]));
    // 缓存继续使用下载时的文件名与提交，避免目录更新使离线模型失效。
    for (const entry of this.snapshot.entries) {
      if (entry.id === DEFAULT_MODEL_ID || this.cached.has(entry.id)) entries.set(entry.id, { ...entry, commit: entry.commit || this.snapshot.commit });
    }
    snapshot.entries = [...entries.values()];
    const models = parseCatalog(snapshot);
    const added = models.filter(model => !findModel(model.id)).length;
    signal?.throwIfAborted();
    await fs.promises.mkdir(path.dirname(this.catalogPath), { recursive: true });
    const temporary = `${this.catalogPath}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(snapshot));
      signal?.throwIfAborted();
      await fs.promises.rename(temporary, this.catalogPath);
    } finally { await fs.promises.rm(temporary, { force: true }); }
    this.snapshot = snapshot; setModels(models);
    this.catalog = null; this.revision++; this.catalogError = '';
    return `模型目录已更新，新增 ${added} 个条目，当前共 ${models.length} 个干员与时装条目。`;
  }
  cachePath(id) { return path.join(this.root, hash(`${findModel(id)?.commit}:${id}`).slice(0, 24)); }
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
        const url = `https://raw.githubusercontent.com/isHarryh/Ark-Models/${model.commit}/models/${encodeURIComponent(model.sourceFolder)}/${encodeURIComponent(file)}`;
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
      const record = { modelId: model.id, commit: model.commit, repository: 'https://github.com/isHarryh/Ark-Models', files: records };
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
