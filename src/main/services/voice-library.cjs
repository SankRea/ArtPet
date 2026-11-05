const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { findModel } = require('./models.cjs');
const { PrtsVoiceSource, parsePrtsVoicePage, sourceUrl } = require('./prts-voice-source.cjs');

const MAX_CLIP_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');

class VoiceLibrary {
  constructor(userData, downloads) {
    this.root = path.join(userData, 'voices');
    this.downloads = downloads;
    this.source = new PrtsVoiceSource(userData, downloads);
    this.records = new Map(); this.states = new Map(); this.ids = new Map();
    let directories;
    try { directories = fs.readdirSync(this.root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name); } catch { directories = []; }
    for (const name of directories) {
      const directory = path.join(this.root, name);
      try {
        const record = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
        if (!this.validRecord(record, directory)) continue;
        this.records.set(record.operatorName, record);
        this.ids.set(this.id(record.operatorName), record.operatorName);
      } catch { /* Old, missing or incomplete voice caches are ignored. */ }
    }
  }
  id(name) { return `prts-${hash(name).slice(0, 24)}`; }
  directory(name) { return path.join(this.root, this.id(name)); }
  validRecord(record, directory) {
    return record?.version === 1 && record.provider === 'PRTS Wiki' && typeof record.operatorName === 'string' && record.operatorName.length <= 100
      && path.basename(directory) === this.id(record.operatorName)
      && record.source === sourceUrl(record.operatorName) && typeof record.language === 'string' && record.language.length <= 50
      && Array.isArray(record.clips) && record.clips.length > 0 && record.clips.length <= 80
      && record.clips.every(clip => /^\d{3}$/.test(clip.id) && clip.file === `${clip.id}.mp3` && typeof clip.label === 'string' && clip.label.length <= 100
        && typeof clip.text === 'string' && clip.text.length > 0 && clip.text.length <= 10000 && Number.isInteger(clip.bytes) && clip.bytes > 0 && clip.bytes <= MAX_CLIP_BYTES
        && /^[a-f\d]{64}$/.test(clip.sha256) && fs.statSync(path.join(directory, clip.file)).size === clip.bytes);
  }
  find(modelId) {
    const model = findModel(modelId);
    return model ? { id: this.id(model.name), operatorName: model.name } : null;
  }
  textSource(modelId) { const model = findModel(modelId); return model ? sourceUrl(model.name) : null; }
  clearRequests() { this.source.clear(); }
  invalidate(modelId) {
    const entry = this.find(modelId);
    if (!entry) return;
    this.records.delete(entry.operatorName); this.ids.delete(entry.id); this.states.clear();
  }
  state(modelId) {
    const entry = this.find(modelId);
    if (!entry) return { available: false, cached: false, clips: [] };
    const record = this.records.get(entry.operatorName);
    const signature = `${entry.id}:${record?.revision || 0}:${record?.clips.length || 0}`;
    if (!this.states.has(signature)) this.states.set(signature, {
      available: true, cached: Boolean(record), id: entry.id, language: record?.language || '', source: sourceUrl(entry.operatorName),
      clips: (record?.clips || []).map(clip => ({ id: clip.id, label: clip.label, text: clip.text, url: `arkpet://app/voices/${entry.id}/${clip.file}` }))
    });
    return this.states.get(signature);
  }
  resolve(id, file) {
    const operatorName = this.ids.get(id), record = operatorName && this.records.get(operatorName);
    return record?.clips.some(clip => clip.file === file) ? path.join(this.directory(operatorName), file) : null;
  }
  async ensure(modelId, progress, signal) {
    const entry = this.find(modelId);
    if (!entry) return null;
    const existing = this.records.get(entry.operatorName);
    if (existing && this.validRecord(existing, this.directory(entry.operatorName))) return entry;
    if (existing) { this.records.delete(entry.operatorName); this.ids.delete(entry.id); this.states.clear(); }
    const page = await this.source.get(entry.operatorName, signal);
    signal?.throwIfAborted();
    if (page.error) throw new Error(page.error);
    const manifest = parsePrtsVoicePage(page.html, page.source);
    await fs.promises.mkdir(this.root, { recursive: true });
    const temporary = await fs.promises.mkdtemp(path.join(this.root, '.download-'));
    const remove = async directory => {
      if (path.dirname(path.resolve(directory)) !== path.resolve(this.root)) throw new Error('语音缓存路径无效。');
      await fs.promises.rm(directory, { recursive: true, force: true });
    };
    try {
      let bytesTotal = 0;
      const clips = [];
      for (let index = 0; index < manifest.clips.length; index++) {
        signal?.throwIfAborted();
        const clip = manifest.clips[index], file = `${clip.id}.mp3`, destinationFile = path.join(temporary, file);
        const downloaded = await this.downloads.fetch(clip.url, {
          signal, directTimeout: 10000, proxyTimeout: 60000,
          onProxy: () => progress({ phase: '语音', file: clip.label, index, total: manifest.clips.length, received: 0, expected: 0, proxied: true })
        }, async (response, attemptSignal, touch, proxied) => {
          if (!response.ok || !response.body) throw new Error(`下载“${clip.label}”失败（HTTP ${response.status}）。`);
          const expected = Number(response.headers.get('content-length')) || 0;
          if (expected > MAX_CLIP_BYTES || bytesTotal + expected > MAX_TOTAL_BYTES) throw new Error('语音资源大小超出限制。');
          let received = 0, prefix = Buffer.alloc(0);
          const digest = createHash('sha256');
          const inspect = new Transform({ transform(chunk, _encoding, callback) {
            touch(); received += chunk.length;
            if (received > MAX_CLIP_BYTES || bytesTotal + received > MAX_TOTAL_BYTES) { callback(new Error('语音资源大小超出限制。')); return; }
            if (prefix.length < 3) prefix = Buffer.concat([prefix, chunk.subarray(0, 3 - prefix.length)]);
            digest.update(chunk);
            progress({ phase: '语音', file: clip.label, index, total: manifest.clips.length, received, expected, proxied });
            callback(null, chunk);
          } });
          await pipeline(Readable.fromWeb(response.body), inspect, fs.createWriteStream(destinationFile, { flags: 'wx' }), { signal: attemptSignal });
          const mp3 = prefix.toString('ascii') === 'ID3' || (prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0);
          if (!received || !mp3) throw new Error(`“${clip.label}”不是有效的 MP3 文件。`);
          return { bytes: received, sha256: digest.digest('hex') };
        });
        bytesTotal += downloaded.bytes;
        clips.push({ id: clip.id, label: clip.label, text: clip.text, file, bytes: downloaded.bytes, sha256: downloaded.sha256, sourceAudio: clip.url });
        progress({ phase: '语音', file: clip.label, index: index + 1, total: manifest.clips.length, received: 0, expected: 0 });
      }
      const record = { version: 1, provider: 'PRTS Wiki', operatorName: entry.operatorName, source: manifest.source, revision: manifest.revision,
        voiceKey: manifest.voiceKey, language: manifest.language, fetchedAt: new Date().toISOString(), clips };
      await fs.promises.writeFile(path.join(temporary, 'source.json'), JSON.stringify(record, null, 2));
      signal?.throwIfAborted();
      const destination = this.directory(entry.operatorName);
      await remove(destination); await fs.promises.rename(temporary, destination);
      this.records.set(entry.operatorName, record); this.ids.set(entry.id, entry.operatorName); this.states.clear();
      return entry;
    } finally { await remove(temporary); }
  }
}

module.exports = { VoiceLibrary };
