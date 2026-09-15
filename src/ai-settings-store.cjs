const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

function normaliseGateway(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (input.length > 2048) throw new Error('网关地址过长。');
  let url;
  try { url = new URL(input); } catch { throw new Error('网关地址格式无效。'); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('网关需要使用 HTTPS；本机地址可使用 HTTP。');
  if (url.username || url.password) throw new Error('网关地址不能包含用户名或密码。');
  if (url.search || url.hash) throw new Error('网关地址不能包含查询参数或片段。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function apiRoot(gateway) {
  const value = normaliseGateway(gateway);
  if (/\/chat\/completions$/i.test(value)) return value.replace(/\/chat\/completions$/i, '');
  return `${value}${/\/v1$/i.test(value) ? '' : '/v1'}`;
}
function completionUrl(gateway) { return `${apiRoot(gateway)}/chat/completions`; }
function modelsUrl(gateway) { return `${apiRoot(gateway)}/models`; }

function normaliseModel(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  if (model.length > 200) throw new Error('模型标识过长。');
  if (/[\u0000-\u001f\u007f]/.test(model)) throw new Error('模型标识无效。');
  return model;
}

class AiSettingsStore {
  constructor(dataDirectory) {
    this.file = path.join(dataDirectory, 'ai-settings.json');
    this.config = { enabled: false, gateway: '', model: '', key: '' };
    this.encryptionAvailable = false;
    this.error = '';
  }
  async load() {
    try { this.encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable(); }
    catch (error) { this.error = `系统密钥存储不可用：${error.message}`; }
    let saved;
    try { saved = JSON.parse(await fs.promises.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') this.error = `无法读取 AI 设置：${error.message}`;
      return;
    }
    if (saved?.version !== 1) return;
    try {
      const gateway = normaliseGateway(saved.gateway);
      const model = normaliseModel(saved.model);
      let key = '';
      if (saved.encryptedKey) {
        if (!this.encryptionAvailable) throw new Error('系统密钥存储不可用，无法解密已保存的 API Key。');
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(saved.encryptedKey, 'base64'));
        key = decrypted.result;
      }
      this.config = { enabled: Boolean(saved.enabled) && Boolean(gateway && model && key), gateway, model, key };
    } catch (error) {
      this.config = { enabled: false, gateway: '', model: '', key: '' };
      this.error = `AI 设置已停用：${error.message}`;
    }
  }
  state() {
    const { enabled, gateway, model, key } = this.config;
    return { enabled, gateway, model, hasKey: Boolean(key), ready: Boolean(enabled && gateway && model && key),
      encryptionAvailable: this.encryptionAvailable, error: this.error };
  }
  current() { return { ...this.config }; }
  connection(value) {
    if (!value || typeof value !== 'object') throw new Error('AI 设置无效。');
    const gateway = normaliseGateway(value.gateway);
    const providedKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
    const key = providedKey || this.config.key;
    if (!gateway) throw new Error('请填写网关地址。');
    if (!key) throw new Error('请填写 API Key。');
    if (key.length > 4096) throw new Error('API Key 过长。');
    return { gateway, key };
  }
  candidate(value, requireComplete = false) {
    if (!value || typeof value !== 'object') throw new Error('AI 设置无效。');
    const enabled = Boolean(value.enabled);
    const gateway = normaliseGateway(value.gateway);
    const model = normaliseModel(value.model);
    const providedKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
    const key = providedKey || this.config.key;
    if ((enabled || requireComplete) && !gateway) throw new Error('请填写网关地址。');
    if ((enabled || requireComplete) && !model) throw new Error('请先获取模型列表并选择模型。');
    if ((enabled || requireComplete) && !key) throw new Error('请填写 API Key。');
    if (key.length > 4096) throw new Error('API Key 过长。');
    return { enabled, gateway, model, key };
  }
  async write(config) {
    if (config.key && !this.encryptionAvailable) throw new Error('系统密钥存储不可用，无法安全保存 API Key。');
    const encryptedKey = config.key ? (await safeStorage.encryptStringAsync(config.key)).toString('base64') : '';
    const contents = JSON.stringify({ version: 1, enabled: config.enabled, gateway: config.gateway, model: config.model, encryptedKey }, null, 2);
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(`${this.file}.tmp`, contents);
    await fs.promises.rename(`${this.file}.tmp`, this.file);
  }
  async save(value) {
    try {
      const next = this.candidate(value);
      await this.write(next);
      this.config = next; this.error = '';
      return { ok: true, ai: this.state() };
    } catch (error) { return { ok: false, error: error.message, ai: this.state() }; }
  }
  async clearKey() {
    const next = { ...this.config, enabled: false, key: '' };
    try {
      await this.write(next);
      this.config = next; this.error = '';
      return { ok: true, ai: this.state() };
    } catch (error) { return { ok: false, error: error.message, ai: this.state() }; }
  }
}

module.exports = { AiSettingsStore, completionUrl, modelsUrl, normaliseGateway };
