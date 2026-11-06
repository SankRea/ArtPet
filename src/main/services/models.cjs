const bundledSource = require('../../../assets/surtr/source.json');
const DEFAULT_MODEL_ID = bundledSource.modelId;
const UPSTREAM_REPOSITORY = bundledSource.repository;
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
    bundled: entry.id === DEFAULT_MODEL_ID, metadataMissing: entry.metadataMissing === true,
    forms: [{ id: 'default', name: entry.outfit || '默认服装', animations: ACTION_CANDIDATES }]
  };
}
const bundledModel = modelFromEntry({
  id: DEFAULT_MODEL_ID, name: bundledSource.name, appellation: bundledSource.appellation, outfit: bundledSource.outfit,
  files: {
    '.skel': bundledSource.files.find(file => file.file.endsWith('.skel')).file,
    '.atlas': bundledSource.files.find(file => file.file.endsWith('.atlas')).file,
    '.png': bundledSource.files.filter(file => file.file.endsWith('.png')).map(file => file.file)
  }
}, bundledSource.commit);
function modelEntry(model) {
  return { id: model.id, name: model.name, appellation: model.appellation, outfit: model.subtitle,
    commit: model.commit, metadataMissing: model.metadataMissing,
    files: { [model.skeleton.endsWith('.json') ? '.json' : '.skel']: model.skeleton, '.atlas': model.atlas, '.png': model.textures } };
}
function cachedModel(record, knownModel) {
  const names = record.files.map(file => file.file);
  const atlas = names.filter(file => /\.atlas$/i.test(file));
  const skeleton = names.filter(file => !/\.(atlas|png)$/i.test(file));
  if (atlas.length !== 1 || skeleton.length !== 1) throw new Error('缓存模型的骨骼或图集信息不完整。');
  // 旧缓存只有 ID 和文件记录；没有目录时先恢复模型，联网后再补齐名称。
  const metadata = knownModel && !knownModel.metadataMissing ? modelEntry(knownModel) : record.entry;
  if (metadata && metadata.id !== record.modelId) throw new Error('缓存模型信息与 ID 不一致。');
  return modelFromEntry({
    id: record.modelId, name: metadata?.name || record.modelId,
    appellation: metadata?.appellation || '', outfit: metadata?.outfit || '已缓存模型',
    metadataMissing: !metadata || metadata.metadataMissing === true,
    files: { '.skel': skeleton[0], '.atlas': atlas[0], '.png': names.filter(file => /\.png$/i.test(file)) }
  }, record.commit);
}
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
  const catalog = { repository: UPSTREAM_REPOSITORY, commit, entries };
  parseCatalog(catalog);
  return catalog;
}
const MODELS = [bundledModel];
const byId = new Map(MODELS.map(model => [model.id, model]));
function setModels(models) {
  MODELS.splice(0, MODELS.length, ...models);
  byId.clear();
  for (const model of models) byId.set(model.id, model);
}
module.exports = { MODELS, DEFAULT_MODEL_ID, UPSTREAM_REPOSITORY, bundledModel, modelEntry, cachedModel, validCommit, parseCatalog, upstreamCatalog, setModels, safeFile,
  findModel: id => byId.get(id === 'surtr' ? DEFAULT_MODEL_ID : id) };
