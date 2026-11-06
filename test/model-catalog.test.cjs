const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { ModelLibrary } = require('../src/main/services/model-library.cjs');
const { DEFAULT_MODEL_ID, findModel } = require('../src/main/services/models.cjs');

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const digest = data => createHash('sha256').update(data).digest('hex');
const progress = () => {};
const signal = () => new AbortController().signal;
const entry = (id, name = '测试干员') => ({ id, name, appellation: 'Test', outfit: '测试时装',
  files: { '.skel': `${id}.skel`, '.atlas': `${id}.atlas`, '.png': [`${id}.png`] } });
const upstream = entries => ({ storageDirectory: { Operator: 'models' }, data: Object.fromEntries(entries.map(item => [item.id, {
  type: 'Operator', name: item.name, appellation: item.appellation, skinGroupName: item.outfit, assetList: item.files
}])) });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artpet-catalog-test-'));
  t.after(() => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
      || !path.basename(directory).startsWith('artpet-catalog-test-')) throw new Error('Unexpected test data directory');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const catalog = path.join(directory, 'model-catalog.json');
  return { directory, catalog,
    save(entries, commit = OLD) { fs.writeFileSync(catalog, JSON.stringify({ commit, entries })); },
    cache(item, commit = OLD, metadata = false) {
      const root = path.join(directory, 'models', digest(`${commit}:${item.id}`).slice(0, 24));
      fs.mkdirSync(root, { recursive: true });
      const files = Object.values(item.files).flat().map(file => {
        const content = Buffer.from(`cached ${file}`);
        fs.writeFileSync(path.join(root, file), content);
        return { file, bytes: content.length, sha256: digest(content) };
      });
      fs.writeFileSync(path.join(root, 'source.json'), JSON.stringify({ modelId: item.id, commit, files,
        ...(metadata ? { entry: { ...item, commit } } : {}) }));
      return root;
    }
  };
}

function responses(...values) {
  return { urls: [], async fetch(url, { signal: requestSignal }, consume) {
    this.urls.push(url); requestSignal.throwIfAborted();
    if (!values.length) throw new Error('Unexpected request');
    const value = values.shift();
    if (value instanceof Error) throw value;
    return consume(new Response(JSON.stringify(value)), requestSignal, () => {}, false);
  } };
}

test('first launch starts with only the bundled model and persists the fetched catalog for offline use', async t => {
  const data = fixture(t), remote = entry('new_operator');
  const downloads = responses([{ sha: NEW }], upstream([remote]));
  const library = new ModelLibrary(data.directory, downloads);
  assert.deepEqual(library.list().map(model => model.id), [DEFAULT_MODEL_ID]);
  assert.equal(library.updateState().initialized, false);
  assert.equal(fs.existsSync(data.catalog), false);
  await library.checkForUpdates(progress, signal());
  assert.equal(new URL(downloads.urls[0]).searchParams.get('path'), 'models_data.json');
  assert.equal(findModel(remote.id), undefined);
  await library.pullUpdates(progress, signal());
  assert.equal(library.updateState().available, false);
  assert.equal(findModel(remote.id).commit, NEW);
  assert.equal(library.isCached(remote.id), false);
  const offline = new ModelLibrary(data.directory, responses());
  assert.equal(offline.updateState().initialized, true);
  assert.equal(findModel(remote.id).name, remote.name);
});

test('unchanged versions keep the cache intact and newer versions wait for an explicit pull', async t => {
  const data = fixture(t), oldEntry = entry('old_operator'), newEntry = entry('new_operator');
  data.save([oldEntry]);
  const before = fs.readFileSync(data.catalog, 'utf8');
  const library = new ModelLibrary(data.directory, responses([{ sha: OLD }], [{ sha: NEW }], upstream([newEntry])));
  await library.checkForUpdates(progress, signal());
  assert.equal(library.updateState().available, false);
  await library.checkForUpdates(progress, signal());
  assert.equal(library.updateState().available, true);
  assert.equal(fs.readFileSync(data.catalog, 'utf8'), before);
  assert.equal(findModel(newEntry.id), undefined);
  await library.pullUpdates(progress, signal());
  assert.equal(findModel(oldEntry.id), undefined);
  assert.equal(findModel(newEntry.id).commit, NEW);
});

test('legacy caches recover without a bundled catalog and acquire names without replacing pinned assets', async t => {
  const data = fixture(t), legacy = entry('legacy_operator');
  legacy.files['.skel'] = 'extensionless_skeleton';
  const root = data.cache(legacy);
  const remote = entry(legacy.id, '恢复的干员名称');
  const library = new ModelLibrary(data.directory, responses([{ sha: NEW }], upstream([remote])));
  assert.equal(findModel(legacy.id).name, legacy.id);
  assert.equal(findModel(legacy.id).metadataMissing, true);
  assert.equal(library.resolve(legacy.id, 'skeleton.json'), path.join(root, 'extensionless_skeleton'));
  await library.checkForUpdates(progress, signal());
  await library.pullUpdates(progress, signal());
  const restored = findModel(legacy.id);
  assert.equal(restored.name, remote.name);
  assert.equal(restored.metadataMissing, false);
  assert.equal(restored.commit, OLD);
  assert.equal(restored.skeleton, 'extensionless_skeleton');
  assert.equal(library.cachePath(legacy.id), root);
  await library.ensure(legacy.id, progress, signal());
  const offline = new ModelLibrary(data.directory, responses());
  assert.equal(findModel(legacy.id).name, remote.name);
  assert.equal(offline.isCached(legacy.id), true);
});

test('self-contained caches retain names offline and survive upstream removal', async t => {
  const data = fixture(t), cached = entry('removed_operator');
  data.cache(cached, OLD, true);
  const library = new ModelLibrary(data.directory, responses([{ sha: NEW }], upstream([entry('other_operator')])));
  assert.equal(findModel(cached.id).name, cached.name);
  assert.equal(findModel(cached.id).metadataMissing, false);
  await library.checkForUpdates(progress, signal());
  await library.pullUpdates(progress, signal());
  assert.equal(findModel(cached.id).commit, OLD);
  assert.equal(library.isCached(cached.id), true);
  assert.equal(findModel(DEFAULT_MODEL_ID).bundled, true);
});

test('failed and cancelled pulls leave the existing catalog and model paths untouched', async t => {
  const data = fixture(t), oldEntry = entry('old_operator');
  data.save([oldEntry]);
  const root = data.cache(oldEntry), before = fs.readFileSync(data.catalog, 'utf8');
  const library = new ModelLibrary(data.directory, responses([{ sha: NEW }], { invalid: true }));
  await library.checkForUpdates(progress, signal());
  await assert.rejects(library.pullUpdates(progress, signal()), /上游模型目录格式/);
  const controller = new AbortController();
  library.downloads = { async fetch(_url, { signal: requestSignal }, consume) {
    const result = await consume(new Response(JSON.stringify(upstream([entry('new_operator')]))), requestSignal, () => {}, false);
    controller.abort();
    return result;
  } };
  await assert.rejects(library.pullUpdates(progress, controller.signal), { name: 'AbortError' });
  assert.equal(fs.readFileSync(data.catalog, 'utf8'), before);
  assert.equal(library.cachePath(oldEntry.id), root);
  assert.equal(library.isCached(oldEntry.id), true);
  assert.equal(findModel('new_operator'), undefined);
  assert.equal(library.updateState().available, true);
});

test('offline first launch preserves the bundled model and existing catalogs survive check failures', async t => {
  const data = fixture(t), downloads = responses(new Error('offline'), new Error('offline'));
  const first = new ModelLibrary(data.directory, downloads);
  await assert.rejects(first.checkForUpdates(progress, signal()), /offline/);
  assert.equal(first.isCached(DEFAULT_MODEL_ID), true);
  assert.equal(fs.existsSync(data.catalog), false);
  data.save([entry('old_operator')]);
  const before = fs.readFileSync(data.catalog, 'utf8');
  const existing = new ModelLibrary(data.directory, downloads);
  await assert.rejects(existing.checkForUpdates(progress, signal()), /offline/);
  assert.equal(existing.updateState().initialized, true);
  assert.equal(fs.readFileSync(data.catalog, 'utf8'), before);
  assert.equal(findModel('old_operator').commit, OLD);
});
