const bundledCatalog = require('../assets/operators.json');
const DEFAULT_MODEL_ID = '350_surtr_summer#9';
const ACTION_CANDIDATES = {
  default: ['Relax', 'Idle', 'Stand', 'Default'], move: ['Move', 'Move_Loop', 'Walk'],
  interact: ['Interact', 'Touch'], relax: ['Relax'], sit: ['Sit'], sleep: ['Sleep'], special: ['Special']
};
const safeFile = value => typeof value === 'string' && value.length > 0 && value.length < 200 && !/[\\/:\0]/.test(value) && !value.includes('..');
const validCommit = value => typeof value === 'string' && /^[a-f\d]{40}$/.test(value);
function modelFromEntry(entry, commit) {
  if (!entry || typeof entry.id !== 'string' || !/^[\w#-]{1,150}$/.test(entry.id) || !safeFile(entry.id)
    || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 200
    || (entry.appellation != null && typeof entry.appellation !== 'string')
    || (entry.outfit != null && typeof entry.outfit !== 'string') || !validCommit(commit)) throw new Error('模型目录包含无效的干员信息。');
  const files = entry.files || {};
  const skeleton = files['.skel'] || files['.json'];
  const atlas = files['.atlas'];
  const textures = Object.values(files).flat().filter(file => typeof file === 'string' && /\.png$/i.test(file));
  // 骨骼类型由目录字段声明；死芒等模型的骨骼文件名没有扩展名，需保留原名。
  if (![skeleton, atlas, ...textures].every(safeFile) || !textures.length || textures.length > 32
    || !/\.atlas$/i.test(atlas)) throw new Error(`模型目录中的 ${entry.id} 文件信息无效。`);
  return {
    id: entry.id, name: entry.name, appellation: entry.appellation || '', subtitle: entry.outfit || '默认服装', type: 'operator',
    sourceFolder: entry.id, skeleton, atlas, textures, commit,
    assetBase: `arkpet://app/models/${encodeURIComponent(entry.id)}/`,
    bundled: entry.id === DEFAULT_MODEL_ID,
    forms: [{ id: 'default', name: entry.outfit || '默认服装', animations: ACTION_CANDIDATES }]
  };
}
const bundledModel = modelFromEntry(bundledCatalog.entries.find(entry => entry.id === DEFAULT_MODEL_ID), bundledCatalog.commit);
function parseCatalog(catalog) {
  if (!catalog || !validCommit(catalog.commit) || !Array.isArray(catalog.entries) || !catalog.entries.length || catalog.entries.length > 10000) throw new Error('模型目录格式无效。');
  const models = catalog.entries.map(entry => modelFromEntry(entry, entry?.commit ?? catalog.commit));
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('模型目录包含重复条目。');
  // 内置模型始终使用随应用发布的文件，不能改用新目录中的文件名。
  return [bundledModel, ...models.filter(model => !model.bundled)]
    .sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.name.localeCompare(b.name, 'zh-CN') || a.subtitle.localeCompare(b.subtitle, 'zh-CN'));
}
function upstreamCatalog(data, commit) {
  if (data?.storageDirectory?.Operator !== 'models' || !data.data || typeof data.data !== 'object' || Array.isArray(data.data)) throw new Error('上游模型目录格式已变化，无法更新。');
  const entries = Object.entries(data.data).filter(([, entry]) => entry?.type === 'Operator').map(([id, entry]) => ({
    id, name: entry.name, appellation: entry.appellation, outfit: entry.skinGroupName, files: entry.assetList
  }));
  const catalog = { repository: bundledCatalog.repository, commit, entries };
  parseCatalog(catalog);
  return catalog;
}
const MODELS = parseCatalog(bundledCatalog);
const byId = new Map(MODELS.map(model => [model.id, model]));
function setModels(models) {
  MODELS.splice(0, MODELS.length, ...models);
  byId.clear();
  for (const model of models) byId.set(model.id, model);
}
module.exports = { MODELS, DEFAULT_MODEL_ID, bundledCatalog, validCommit, parseCatalog, upstreamCatalog, setModels, safeFile,
  findModel: id => byId.get(id === 'surtr' ? DEFAULT_MODEL_ID : id) };
