const catalog = require('../assets/operators.json');
const DEFAULT_MODEL_ID = '350_surtr_summer#9';
const ACTION_CANDIDATES = {
  default: ['Relax', 'Idle', 'Stand', 'Default'], move: ['Move', 'Move_Loop', 'Walk'],
  interact: ['Interact', 'Touch'], relax: ['Relax'], sit: ['Sit'], sleep: ['Sleep'], special: ['Special']
};
const safeFile = value => typeof value === 'string' && value.length > 0 && value.length < 200 && !/[\\/:\0]/.test(value) && !value.includes('..');
const MODELS = catalog.entries.filter(entry => typeof entry.id === 'string' && /^[\w#-]+$/.test(entry.id)).map(entry => {
  const files = entry.files || {};
  const skeleton = files['.skel'] || files['.json'];
  const atlas = files['.atlas'];
  const textures = Object.values(files).flat().filter(file => typeof file === 'string' && /\.png$/i.test(file));
  if (![skeleton, atlas, ...textures].every(safeFile) || !textures.length) return null;
  return {
    id: entry.id, name: entry.name, appellation: entry.appellation || '', subtitle: entry.outfit || '默认服装', type: 'operator',
    sourceFolder: entry.id, skeleton, atlas, textures,
    assetBase: `arkpet://app/models/${encodeURIComponent(entry.id)}/`,
    bundled: entry.id === DEFAULT_MODEL_ID,
    forms: [{ id: 'default', name: entry.outfit || '默认服装', animations: ACTION_CANDIDATES }]
  };
}).filter(Boolean).sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.name.localeCompare(b.name, 'zh-CN') || a.subtitle.localeCompare(b.subtitle, 'zh-CN'));
const byId = new Map(MODELS.map(model => [model.id, model]));
module.exports = { MODELS, DEFAULT_MODEL_ID, CATALOG_COMMIT: catalog.commit, safeFile,
  findModel: id => byId.get(id === 'surtr' ? DEFAULT_MODEL_ID : id) };
