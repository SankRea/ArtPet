const { net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
const sourceUrl = name => `https://prts.wiki/w/${encodeURIComponent(name)}/${encodeURIComponent('语音记录')}`;

class VoiceTextLibrary {
  constructor(userData) {
    this.root = path.join(userData, 'voice-texts');
    this.requests = new Map();
  }
  async get(name) {
    const previous = this.requests.get(name);
    if (previous && previous.expires > Date.now()) return previous.promise;
    const request = { expires: Infinity };
    request.promise = this.load(name).then(result => {
      request.expires = Date.now() + (result.error ? 60000 : CACHE_AGE);
      return result;
    });
    this.requests.set(name, request);
    return request.promise;
  }
  async load(name) {
    const source = sourceUrl(name);
    const file = path.join(this.root, `${createHash('sha256').update(name).digest('hex')}.html`);
    let cached;
    try {
      const stat = await fs.promises.stat(file);
      if (stat.size <= MAX_BYTES) {
        const html = await fs.promises.readFile(file, 'utf8');
        if (html.includes('data-voice-key=')) cached = { html, source };
        if (cached && Date.now() - stat.mtimeMs < CACHE_AGE) return cached;
      }
    } catch { /* Missing cache is fetched only for the selected operator. */ }
    try {
      const response = await net.fetch(source, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > MAX_BYTES) throw new Error('页面超过大小限制');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      const html = Buffer.concat(chunks).toString('utf8');
      if (!html.includes('data-voice-key=')) throw new Error('页面未包含语音记录');
      try {
        await fs.promises.mkdir(this.root, { recursive: true });
        await fs.promises.writeFile(`${file}.tmp`, html);
        await fs.promises.rename(`${file}.tmp`, file);
      } catch { /* A cache write failure must not prevent playback. */ }
      return { html, source };
    } catch (error) {
      return cached || { source, error: `语音文本暂不可用：${error.message}` };
    }
  }
}

module.exports = { VoiceTextLibrary, sourceUrl };
