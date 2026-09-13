const { session } = require('electron');

class DownloadTimeoutError extends Error {
  constructor() {
    super('下载超时。');
    this.name = 'DownloadTimeoutError';
  }
}

function isTimeout(error) {
  if (error instanceof DownloadTimeoutError) return true;
  const details = [error?.name, error?.message, error?.code, error?.cause?.message, error?.cause?.code].filter(Boolean).join(' ');
  return /(?:timed?[_ -]?out|timeout|ERR_CONNECTION_TIMED_OUT)/i.test(details);
}

function normaliseProxy(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (input.length > 2048) throw new Error('代理地址过长。');
  let url;
  try { url = new URL(input.includes('://') ? input : `http://${input}`); }
  catch { throw new Error('代理地址格式无效。'); }
  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname) throw new Error('代理地址仅支持 HTTP、HTTPS、SOCKS4 或 SOCKS5。');
  if (url.username || url.password) throw new Error('代理地址暂不支持用户名和密码。');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('代理地址不能包含路径、查询参数或片段。');
  return `${url.protocol}//${url.host}`;
}

class DownloadClient {
  constructor(getProxy) {
    this.getProxy = getProxy;
    this.direct = session.fromPartition('arkpet-download-direct', { cache: false });
    this.proxied = session.fromPartition('arkpet-download-proxy', { cache: false });
    this.directReady = this.direct.setProxy({ mode: 'direct' });
    this.proxyRule = null;
  }
  async configureProxy(rule) {
    if (this.proxyRule === rule) return;
    await this.proxied.setProxy({ mode: 'fixed_servers', proxyRules: rule });
    await this.proxied.closeAllConnections();
    this.proxyRule = rule;
  }
  async attempt(target, url, timeout, signal, consume, proxied) {
    const controller = new AbortController();
    let timer, timedOut = false;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    };
    touch();
    const attemptSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const response = await target.fetch(url, { credentials: 'omit', signal: attemptSignal });
      touch();
      return await consume(response, attemptSignal, touch, proxied);
    } catch (error) {
      if (timedOut && !signal?.aborted) throw new DownloadTimeoutError();
      throw error;
    } finally { clearTimeout(timer); }
  }
  async fetch(url, options, consume) {
    const { signal, directTimeout = 15000, proxyTimeout = 90000, onProxy } = options || {};
    await this.directReady;
    try { return await this.attempt(this.direct, url, directTimeout, signal, consume, false); }
    catch (error) {
      if (!isTimeout(error)) throw error;
      const rule = normaliseProxy(this.getProxy());
      if (!rule) throw error;
      signal?.throwIfAborted();
      onProxy?.();
      await this.configureProxy(rule);
      try { return await this.attempt(this.proxied, url, proxyTimeout, signal, consume, true); }
      catch (proxyError) {
        signal?.throwIfAborted();
        throw new Error(`直连下载超时，使用代理重试仍失败：${proxyError.message}`);
      }
    }
  }
}

module.exports = { DownloadClient, normaliseProxy };
