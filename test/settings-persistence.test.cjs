const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { DEFAULT_MODEL_ID, MODELS, findModel } = require('../src/models.cjs');
const proxyHelpers = require('../src/download-client.cjs');

const mainPath = path.join(__dirname, '../src/main.cjs');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const otherModelId = MODELS.find(model => !model.bundled).id;
const originalPet = {
  id: 'saved-pet', modelId: DEFAULT_MODEL_ID, scale: 1.15, frameRate: 45,
  speed: 32, voiceEnabled: true, voiceVolume: 0.35, voiceTextEnabled: false,
  reminderEnabled: true, reminderTime: '18:35', reminderClipId: '034',
  manualMode: true, gravity: false, windowEdges: false, alwaysOnTop: false,
  translucent: true, clickThrough: true, x: 160, y: 240
};
const copy = value => JSON.parse(JSON.stringify(value));

function fixture(t, pets = [originalPet], extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpet-settings-test-'));
  t.after(() => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
      || !path.basename(directory).startsWith('arkpet-settings-test-')) throw new Error('Unexpected test data directory');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'settings.json');
  fs.writeFileSync(filename, JSON.stringify({ version: 4, maxPets: 3, proxyAddress: '127.0.0.1', proxyPort: 7890,
    selectedId: pets[0]?.id, pets, ...extra }));
  return { directory, read: () => JSON.parse(fs.readFileSync(filename, 'utf8')) };
}

// Run the real main-process IPC and persistence code without opening native windows
// or touching the user's data. Electron startup stays pending; timers are explicit.
function runtime(directory, { settingsOpen = true, cached = () => true } = {}) {
  const app = new EventEmitter();
  app.getPath = () => directory;
  app.setName = () => {};
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => new Promise(() => {});
  app.quit = () => app.emit('before-quit');
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const settingsWindow = { isDestroyed: () => false, webContents: { id: 9000, mainFrame: {} } };
  const event = { sender: settingsWindow.webContents, senderFrame: settingsWindow.webContents.mainFrame };
  const electron = { app, ipcMain, protocol: { registerSchemesAsPrivileged() {} }, globalShortcut: { unregisterAll() {} } };
  let nextWebContentsId = 1;
  class PetWindow {
    constructor(host, saved) {
      this.id = saved.id; this.model = findModel(saved.modelId); this.record = copy(saved);
      this.webContentsId = nextWebContentsId++;
      this.win = { isDestroyed: () => false, close: () => { this.win = null; host.closed(this); } };
    }
    serialise() { return copy(this.record); }
  }
  const unusedModules = new Set(['./model-library.cjs', './voice-library.cjs', './window-surfaces.cjs',
    './physics.cjs', './ai-settings-store.cjs', './prts-profile-source.cjs', './ai-client.cjs', './ai-chat-window.cjs']);
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return electron;
      if (id === './pet-window.cjs') return { PetWindow };
      if (id === './models.cjs') return { DEFAULT_MODEL_ID, findModel };
      if (id === './download-client.cjs') return proxyHelpers;
      if (id === '../config.json') return { maxPets: 1 };
      if (unusedModules.has(id)) return {};
      return require(id);
    },
    __dirname: path.dirname(mainPath), console, process,
    setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
    testDirectory: directory, testLibrary: { isCached: cached },
    testLauncher: settingsOpen ? settingsWindow : undefined,
    testAiChats: { register() {}, closePet() {}, closeAll() {} }
  });
  vm.runInContext(mainSource, context, { filename: mainPath });
  const run = code => vm.runInContext(code, context);
  run('dataDirectory = testDirectory; library = testLibrary; launcher = testLauncher; aiChats = testAiChats; registerIpc();');
  return {
    restore() {
      run(`{
        const saved = load(), previousSelection = selectedId;
        for (const item of saved) addPet(item.modelId, item);
        if (!pets.size) addPet(DEFAULT_MODEL_ID);
        if (pets.has(previousSelection)) selectedId = previousSelection;
      }`);
    },
    pets: () => copy(run('[...pets.values()].map(pet => pet.serialise())')),
    change(patch) { context.testPatch = patch; run('Object.assign(pets.get(selectedId).record, testPatch);'); },
    close(id = run('selectedId')) {
      if (settingsOpen) ipcMain.emit('pet:command', event, { command: 'quit', id });
      else { context.testPetId = id; run('closePet(testPetId);'); }
    },
    add(modelId) { context.testModelId = modelId; run('addPet(testModelId);'); },
    quit: () => app.quit()
  };
}

test('closing the last pet from settings preserves its latest configuration and global settings', t => {
  const data = fixture(t), session = runtime(data.directory);
  session.restore();
  session.change({ scale: 1.3, reminderTime: '07:25' });
  session.close();
  assert.deepEqual(session.pets(), []);
  const saved = data.read();
  assert.deepEqual(saved.pets, []);
  assert.deepEqual(saved.lastClosedPet, { ...originalPet, scale: 1.3, reminderTime: '07:25' });
  assert.equal(saved.maxPets, 3);
  assert.equal(saved.proxyAddress, '127.0.0.1');
  assert.equal(saved.proxyPort, 7890);
});

test('restart after closing the last pet restores its model and settings', t => {
  const pet = { ...originalPet, modelId: otherModelId };
  const data = fixture(t, [pet]), first = runtime(data.directory);
  first.restore(); first.close(); first.quit();
  const restarted = runtime(data.directory);
  restarted.restore();
  assert.deepEqual(restarted.pets(), [pet]);
});

for (const modelId of [DEFAULT_MODEL_ID, otherModelId]) {
  test(`adding ${modelId} after closing the last pet reuses its settings`, t => {
    const data = fixture(t), session = runtime(data.directory);
    session.restore(); session.close(); session.add(modelId);
    assert.deepEqual(session.pets(), [{ ...originalPet, modelId }]);
  });
}

test('closing one of multiple pets does not reopen it on restart', t => {
  const remaining = { ...originalPet, id: 'remaining-pet', modelId: otherModelId, scale: 0.6 };
  const data = fixture(t, [originalPet, remaining]), session = runtime(data.directory);
  session.restore(); session.close(originalPet.id);
  assert.deepEqual(data.read().pets, [remaining]);
  const restarted = runtime(data.directory);
  restarted.restore();
  assert.deepEqual(restarted.pets(), [remaining]);
});

test('closing all pets restores only the last closed pet on restart', t => {
  const last = { ...originalPet, id: 'last-pet', modelId: otherModelId, voiceVolume: 0.8 };
  const data = fixture(t, [originalPet, last]), session = runtime(data.directory);
  session.restore(); session.close(originalPet.id); session.close(last.id);
  const restarted = runtime(data.directory);
  restarted.restore();
  assert.deepEqual(restarted.pets(), [last]);
});

test('closing the last pet without the settings window preserves configuration when the app exits', t => {
  const data = fixture(t), session = runtime(data.directory, { settingsOpen: false });
  session.restore(); session.close();
  const restarted = runtime(data.directory);
  restarted.restore();
  assert.deepEqual(restarted.pets(), [originalPet]);
});

test('exiting the application keeps all active pets and their latest settings', t => {
  const second = { ...originalPet, id: 'second-pet', scale: 0.7 };
  const data = fixture(t, [originalPet, second]), session = runtime(data.directory);
  session.restore(); session.change({ scale: 1.4 }); session.quit();
  assert.deepEqual(data.read().pets, [{ ...originalPet, scale: 1.4 }, second]);
});

test('legacy version 3 settings still migrate frame rate and preserve preferences', t => {
  const data = fixture(t, [{ ...originalPet, frameRate: 24 }], { version: 3 }), session = runtime(data.directory);
  session.restore();
  assert.deepEqual(session.pets(), [{ ...originalPet, frameRate: 30 }]);
});

test('an unavailable cached model falls back to the bundled model while preserving preferences', t => {
  const data = fixture(t, [], { lastClosedPet: { ...originalPet, modelId: otherModelId } });
  const session = runtime(data.directory, { cached: id => id === DEFAULT_MODEL_ID });
  session.restore();
  assert.deepEqual(session.pets(), [originalPet]);
});

test('an invalid last-closed model does not prevent the default pet from opening', t => {
  const data = fixture(t, [], { lastClosedPet: { ...originalPet, modelId: 'unknown-model' } });
  const session = runtime(data.directory);
  session.restore();
  assert.equal(session.pets().length, 1);
  assert.equal(session.pets()[0].modelId, DEFAULT_MODEL_ID);
});
