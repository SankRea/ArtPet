const { net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const catalog = require('../assets/voices.json');
const { findModel } = require('./models.cjs');
const { VoiceTextLibrary, sourceUrl } = require('./voice-text-library.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const BUNDLED_VOICE = 'char_350_surtr';

class VoiceLibrary {
  constructor(userData) {
    this.root = path.join(userData, 'voices');
    this.texts = new VoiceTextLibrary(userData);
    this.entries = new Map(); this.cached = new Map(); this.states = new Map();
    let directories;
    try { directories = new Set(fs.readdirSync(this.root)); } catch { directories = new Set(); }
    for (const [id, entry] of Object.entries(catalog.entries)) {
      if (!/^char_[\w#-]+$/.test(id) || !['voice', 'voice_cn', 'voice_kr', 'voice_en', 'voice_custom'].includes(entry.directory)) continue;
      if (!Number.isInteger(entry.size) || entry.size <= 0 || entry.size > 32 * 1024 * 1024 || !Number.isFinite(entry.duration)) continue;
      const clips = entry.clips.filter(clip => /^\d{3}$/.test(clip.id) && Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.start >= 0 && clip.end > clip.start && clip.end <= entry.duration);
      if (!clips.length) continue;
      const voice = { ...entry, id, clips, file: `${id}.ogg` };
      this.entries.set(id, voice);
      const directory = this.directory(voice);
      if (id !== BUNDLED_VOICE && !directories.has(path.basename(directory))) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
        if (record.voiceId === id && record.language === voice.language && record.commit === catalog.commit && record.file === voice.file && record.bytes === voice.size && /^[a-f0-9]{64}$/.test(record.sha256) && fs.statSync(path.join(directory, voice.file)).size === voice.size) this.cached.set(id, record);
      } catch { /* Only the selected operator can trigger a missing voice download. */ }
    }
  }
  directory(voice) {
    if (voice.id === BUNDLED_VOICE) return path.join(__dirname, '..', 'assets', 'voices', 'surtr');
    return path.join(this.root, hash(`${catalog.commit}:${voice.id}:${voice.language}`).slice(0, 24));
  }
  find(modelId) {
    const model = findModel(modelId);
    if (!model) return null;
    const exact = this.entries.get(`char_${model.id}`);
    const base = model.id.match(/^(\d+_[a-zA-Z0-9]+)/)?.[1];
    return exact || this.entries.get(`char_${base}`) || null;
  }
  async text(modelId) {
    const voice = this.find(modelId), model = findModel(modelId);
    if (!voice || !model) return { error: '当前干员暂无语音资源。' };
    return { ...await this.texts.get(model.name), voiceId: voice.id, directory: voice.directory };
  }
  textSource(modelId) { const model = findModel(modelId); return model ? sourceUrl(model.name) : null; }
  state(modelId) {
    const voice = this.find(modelId);
    if (!voice) return { available: false, cached: false, clips: [] };
    if (!this.states.has(voice.id)) this.states.set(voice.id, {
      available: true, cached: this.cached.has(voice.id), id: voice.id, language: voice.languageLabel,
      url: `arkpet://app/voices/${encodeURIComponent(voice.id)}/${encodeURIComponent(voice.file)}`,
      clips: voice.clips
    });
    return this.states.get(voice.id);
  }
  resolve(id, file) {
    const voice = this.entries.get(id);
    return voice && this.cached.has(id) && file === voice.file ? path.join(this.directory(voice), file) : null;
  }
  async ensure(modelId, progress, signal) {
    const voice = this.find(modelId);
    if (!voice) return null;
    if (this.cached.has(voice.id)) {
      if (voice.id === BUNDLED_VOICE) return voice;
      const digest = createHash('sha256');
      try {
        for await (const chunk of fs.createReadStream(path.join(this.directory(voice), voice.file), { signal })) digest.update(chunk);
        if (digest.digest('hex') === this.cached.get(voice.id).sha256) return voice;
      } catch { signal?.throwIfAborted(); }
      this.cached.delete(voice.id); this.states.delete(voice.id);
    }
    if (voice.id === BUNDLED_VOICE) throw new Error('内置史尔特尔语音文件缺失，请恢复 assets/voices/surtr。');
    await fs.promises.mkdir(this.root, { recursive: true });
    const temporary = await fs.promises.mkdtemp(path.join(this.root, '.download-'));
    const remove = async directory => {
      if (path.dirname(path.resolve(directory)) !== path.resolve(this.root)) throw new Error('语音缓存路径无效。');
      await fs.promises.rm(directory, { recursive: true, force: true });
    };
    try {
      const url = `https://raw.githubusercontent.com/isHarryh/Ark-Voice/${catalog.commit}/${voice.directory}/${encodeURIComponent(voice.file)}`;
      const response = await net.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(90000)].filter(Boolean)), credentials: 'omit' });
      if (!response.ok || !response.body) throw new Error(`语音下载失败（HTTP ${response.status}）。`);
      let received = 0, prefix = Buffer.alloc(0);
      const digest = createHash('sha256');
      const inspect = new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > voice.size) { callback(new Error('语音文件大小与目录不符。')); return; }
        if (prefix.length < 4) prefix = Buffer.concat([prefix, chunk.subarray(0, 4 - prefix.length)]);
        digest.update(chunk); progress({ phase: '语音', file: voice.file, index: 0, total: 1, received, expected: voice.size });
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), inspect, fs.createWriteStream(path.join(temporary, voice.file), { flags: 'wx' }), { signal });
      if (received !== voice.size || prefix.toString('ascii') !== 'OggS') throw new Error('语音文件不完整或格式无效。');
      const record = { voiceId: voice.id, language: voice.language, commit: catalog.commit, repository: catalog.repository, file: voice.file, bytes: received, sha256: digest.digest('hex') };
      await fs.promises.writeFile(path.join(temporary, 'source.json'), JSON.stringify(record, null, 2));
      signal?.throwIfAborted();
      const destination = this.directory(voice);
      await remove(destination); await fs.promises.rename(temporary, destination);
      this.cached.set(voice.id, record); this.states.delete(voice.id);
      progress({ phase: '语音', file: voice.file, index: 1, total: 1, received: 0, expected: 0 });
      return voice;
    } finally { await remove(temporary); }
  }
}
module.exports = { VoiceLibrary };
