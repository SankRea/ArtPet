const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_PROFILE_CHARS = 12000;
const CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
const sourceUrl = name => `https://prts.wiki/w/${encodeURIComponent(name)}`;
const apiUrl = name => `https://prts.wiki/api.php?action=parse&page=${encodeURIComponent(name)}&prop=text%7Crevid&format=json&formatversion=2`;
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', middot: '·' };

function decodeHtml(value = '') {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x';
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return Number.isSafeInteger(point) ? String.fromCodePoint(point) : match; } catch { return match; }
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

function textContent(html) {
  return decodeHtml(String(html || '')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(?:script|style|noscript)\b[^>]*>[^]*?<\/(?:script|style|noscript)>/gi, '')
    .replace(/<sup\b[^>]*class="[^"]*\breference\b[^"]*"[^>]*>[^]*?<\/sup>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<(?:br|\/p|\/div|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractProfile(html) {
  const headings = [];
  const pattern = /<h([1-6])\b[^>]*>[^]*?<\/h\1>/gi;
  for (let match; (match = pattern.exec(html));) headings.push({ level: Number(match[1]), index: match.index, end: pattern.lastIndex, text: textContent(match[0]) });
  const startIndex = headings.findIndex(heading => /(?:干员档案|档案资料)/.test(heading.text));
  if (startIndex < 0) throw new Error('页面中没有找到干员档案。');
  const start = headings[startIndex];
  const end = headings.slice(startIndex + 1).find(heading => heading.level <= start.level);
  const profile = textContent(html.slice(start.end, end?.index || html.length))
    .replace(/^编辑\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (profile.length < 40) throw new Error('干员档案内容为空。');
  return profile.slice(0, MAX_PROFILE_CHARS);
}

class PrtsProfileSource {
  constructor(userData, downloads) {
    this.root = path.join(userData, 'ai-profiles');
    this.downloads = downloads;
    this.requests = new Map();
  }
  clear() { this.requests.clear(); }
  async get(name, signal) {
    const previous = this.requests.get(name);
    if (previous && previous.expires > Date.now()) return previous.promise;
    const request = { expires: Infinity };
    request.promise = this.load(name, signal).then(result => {
      request.expires = Date.now() + (result.stale ? 60000 : CACHE_AGE);
      return result;
    }).catch(error => { this.requests.delete(name); throw error; });
    this.requests.set(name, request);
    return request.promise;
  }
  valid(record, name) {
    return record?.version === 1 && record.provider === 'PRTS Wiki' && record.operatorName === name
      && record.source === sourceUrl(name) && typeof record.text === 'string' && record.text.length >= 40 && record.text.length <= MAX_PROFILE_CHARS;
  }
  async load(name, signal) {
    const file = path.join(this.root, `${createHash('sha256').update(name).digest('hex')}.json`);
    let cached;
    try {
      const stat = await fs.promises.stat(file);
      const record = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (stat.size <= MAX_PAGE_BYTES && this.valid(record, name)) {
        cached = record;
        if (Date.now() - stat.mtimeMs < CACHE_AGE) return record;
      }
    } catch { /* Fetch a fresh profile when no valid cache exists. */ }
    try {
      const body = await this.downloads.fetch(apiUrl(name), { signal, directTimeout: 10000, proxyTimeout: 30000 }, async (response, _attemptSignal, touch) => {
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader(), chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            touch(); bytes += value.length;
            if (bytes > MAX_PAGE_BYTES) throw new Error('页面超过大小限制');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        return Buffer.concat(chunks).toString('utf8');
      });
      const data = JSON.parse(body);
      if (data.error) throw new Error(data.error.info || data.error.code || 'PRTS API 返回错误');
      const html = data.parse?.text;
      if (typeof html !== 'string') throw new Error('PRTS API 未返回页面内容');
      const record = { version: 1, provider: 'PRTS Wiki', operatorName: name, source: sourceUrl(name),
        revision: Number(data.parse?.revid) || null, fetchedAt: new Date().toISOString(), text: extractProfile(html) };
      try {
        await fs.promises.mkdir(this.root, { recursive: true });
        await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(record, null, 2));
        await fs.promises.rename(`${file}.tmp`, file);
      } catch { /* Cache failures do not prevent the current conversation. */ }
      return record;
    } catch (error) {
      signal?.throwIfAborted();
      if (cached) return { ...cached, stale: true };
      throw new Error(`PRTS 干员档案暂不可用：${error.message}`);
    }
  }
}

module.exports = { PrtsProfileSource, extractProfile, sourceUrl };
