const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
const sourceUrl = name => `https://prts.wiki/w/${encodeURIComponent(name)}/${encodeURIComponent('语音记录')}`;
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

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return decodeHtml(match?.[1] || '');
}

function extractDiv(html, start) {
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0, opening;
  for (let match; (match = tags.exec(html));) {
    if (!opening) opening = match;
    if (/^<\/div/i.test(match[0])) depth--;
    else depth++;
    if (!depth && opening) return { tag: opening[0], content: html.slice(opening.index + opening[0].length, match.index), end: tags.lastIndex };
  }
  return null;
}

function divs(html, className) {
  const result = [], openings = /<div\b[^>]*>/gi;
  for (let match; (match = openings.exec(html));) {
    const classes = attribute(match[0], 'class').split(/\s+/);
    if (!classes.includes(className)) continue;
    const block = extractDiv(html, match.index);
    if (!block) continue;
    result.push(block);
    openings.lastIndex = block.end;
  }
  return result;
}

function textContent(html) {
  return decodeHtml(html
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
    .replace(/<sup\b[^>]*class="[^"]*\breference\b[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function audioUrl(basePath, filename) {
  const parts = `${basePath}/${filename.toLowerCase().replace(/\s/g, '_').replace(/\.wav$/i, '.mp3')}`.split('/');
  if (parts.length < 3 || parts.some(part => !part || part === '.' || part === '..' || !/^[\p{L}\p{N}_#(). -]+$/u.test(part))) return '';
  return `https://torappu.prts.wiki/assets/audio/${parts.map(encodeURIComponent).join('/')}`;
}

function parsePrtsVoicePage(html, source = '') {
  const roots = [];
  const openings = /<div\b[^>]*\bdata-voice-key="[^"]+"[^>]*>/gi;
  for (let match; (match = openings.exec(html));) {
    const block = extractDiv(html, match.index);
    if (block) roots.push(block);
    if (block) openings.lastIndex = block.end;
  }
  const root = roots[0];
  if (!root) throw new Error('页面未包含可用的语音记录。');
  const voiceKey = attribute(root.tag, 'data-voice-key');
  if (!/^char_[\w#-]+$/.test(voiceKey)) throw new Error('页面中的干员语音标识无效。');
  const bases = attribute(root.tag, 'data-voice-base').split(',').map(value => {
    const separator = value.indexOf(':');
    return { language: value.slice(0, separator).trim(), path: value.slice(separator + 1).trim() };
  }).filter(item => item.language && item.path);
  const languagePriority = ['日语', '中文-普通话', '英语', '韩语'];
  const base = languagePriority.map(language => bases.find(item => item.language === language)).find(Boolean) || bases[0];
  if (!base) throw new Error('页面未提供语音资源路径。');
  const suffix = base.language.match(/[（(][^()（）]*[)）]$/)?.[0] || '';
  const wantedText = `中文${suffix}`;
  const clips = [];
  const seen = new Set();
  for (const item of divs(root.content, 'voice-data-item')) {
    const index = attribute(item.tag, 'data-voice-index');
    const filename = attribute(item.tag, 'data-voice-filename');
    if (!/^\d{1,3}$/.test(index) || !/^[\w#(). -]+\.wav$/i.test(filename)) continue;
    const id = String(Number(index)).padStart(3, '0');
    if (seen.has(id)) continue;
    const details = new Map(divs(item.content, 'voice-item-detail').map(detail => [attribute(detail.tag, 'data-kind-name'), textContent(detail.content)]));
    const text = details.get(wantedText) || (suffix ? '' : details.get('中文')) || '';
    const url = audioUrl(base.path, filename);
    const label = attribute(item.tag, 'data-title');
    if (!url || !label || !text || text.length > 10000) continue;
    clips.push({ id, label, text, url });
    seen.add(id);
  }
  if (!clips.length) throw new Error('页面没有同时包含音频与中文文本的语音记录。');
  const revision = Number(html.match(/"wgCurRevisionId":(\d+)/)?.[1]) || null;
  return { source, revision, voiceKey, language: base.language, clips };
}

class PrtsVoiceSource {
  constructor(userData, downloads) {
    this.root = path.join(userData, 'prts-pages');
    this.downloads = downloads;
    this.requests = new Map();
  }
  clear() { this.requests.clear(); }
  async get(name, signal) {
    const previous = this.requests.get(name);
    if (previous && previous.expires > Date.now()) return previous.promise;
    const request = { expires: Infinity };
    request.promise = this.load(name, signal).then(result => {
      request.expires = Date.now() + (result.error ? 60000 : CACHE_AGE);
      return result;
    }).catch(error => { this.requests.delete(name); throw error; });
    this.requests.set(name, request);
    return request.promise;
  }
  async load(name, signal) {
    const source = sourceUrl(name);
    const file = path.join(this.root, `${createHash('sha256').update(name).digest('hex')}.html`);
    let cached;
    try {
      const stat = await fs.promises.stat(file);
      if (stat.size <= MAX_PAGE_BYTES) {
        const html = await fs.promises.readFile(file, 'utf8');
        if (html.includes('data-voice-key=') && html.includes('voice-data-item')) cached = { html, source };
        if (cached && Date.now() - stat.mtimeMs < CACHE_AGE) return cached;
      }
    } catch { /* The page is fetched when no valid cache exists. */ }
    try {
      const html = await this.downloads.fetch(source, { signal, directTimeout: 10000, proxyTimeout: 30000 }, async (response, _attemptSignal, touch) => {
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
      if (!html.includes('data-voice-key=') || !html.includes('voice-data-item')) throw new Error('页面未包含语音记录');
      try {
        await fs.promises.mkdir(this.root, { recursive: true });
        await fs.promises.writeFile(`${file}.tmp`, html);
        await fs.promises.rename(`${file}.tmp`, file);
      } catch { /* A page cache failure must not prevent the voice download. */ }
      return { html, source };
    } catch (error) {
      signal?.throwIfAborted();
      return cached || { source, error: `PRTS 语音记录暂不可用：${error.message}` };
    }
  }
}

module.exports = { PrtsVoiceSource, parsePrtsVoicePage, sourceUrl };
