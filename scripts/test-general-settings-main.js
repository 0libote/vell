'use strict';

// Real settings IPC and disk persistence in a temporary profile. Windows,
// microphone devices, account services and helper processes remain inert.
const assert = require('assert');
const fs = require('fs');
const harness = require('./asr-test-harness');
const plain = value => JSON.parse(JSON.stringify(value));

(async () => {
  const h = harness();
  const states = [];
  try {
    h.context.testGeneralState = (_channel, state) => states.push(plain(state));
    h.run(`
      // Local-only: no plan and no cloud switch. Every language choice lands
      // on English, the only language local engines hear.
      settings.alwaysShowFlowBar = false;
      overlayWin = { isDestroyed: () => false, webContents: { send: testGeneralState } };
    `);
    const set = h.handlers.get('settings-set');
    const primaryId = h.run('primaryShortcut().id');

    // The mode belongs to one shortcuts entry, set through shortcutUpdate. The
    // snapshot mirrors the primary entry as dictateMode/shortcut for readers
    // from before there was a list.
    for (const mode of ['ptt', 'both', 'toggle']) {
      const snapshot = plain(await set(null, { shortcutUpdate: { id: primaryId, mode } }));
      const entry = snapshot.shortcuts.find(s => s.id === primaryId);
      assert.strictEqual(entry.mode, mode, 'snapshot shortcut mode ' + mode);
      assert.strictEqual(snapshot.dictateMode, mode, 'legacy dictateMode mirrors primary ' + mode);
      const saved = JSON.parse(fs.readFileSync(h.run('SETTINGS_FILE'), 'utf8'));
      assert.strictEqual(saved.shortcuts.find(s => s.id === primaryId).mode, mode, 'mode is written to the settings file');
      assert.strictEqual(saved.dictateMode, mode, 'legacy scalar is written to the settings file');
      h.run('loadSettings()');
      assert.strictEqual(plain(h.run('primaryShortcut().mode')), mode, 'mode survives reloading settings');
      assert.strictEqual(plain(h.run('settings.shortcuts')).find(s => s.id === primaryId).mode, mode, 'list survives reloading settings');
      assert.deepStrictEqual(plain(states.at(-1)).dictateMode, mode, 'mode reaches the recording overlay');
      assert.strictEqual(h.run('isPtt()'), mode !== 'toggle', 'isPtt ' + mode);
    }

    // A legacy dictateMode patch maps onto the primary shortcut.
    for (const mode of ['ptt', 'toggle']) {
      const snapshot = plain(await set(null, { dictateMode: mode }));
      assert.strictEqual(snapshot.shortcuts.find(s => s.id === primaryId).mode, mode, 'legacy patch sets primary mode ' + mode);
      assert.strictEqual(snapshot.dictateMode, mode, 'legacy patch returns the confirmed mode ' + mode);
      const saved = JSON.parse(fs.readFileSync(h.run('SETTINGS_FILE'), 'utf8'));
      assert.strictEqual(saved.shortcuts.find(s => s.id === primaryId).mode, mode, 'legacy patch is written to the settings file');
      h.run('loadSettings()');
      assert.strictEqual(plain(h.run('primaryShortcut().mode')), mode, 'legacy patch survives reloading settings');
      assert.strictEqual(h.run('isPtt()'), mode !== 'toggle', 'isPtt after legacy patch ' + mode);
    }

    const patches = [
      { microphone: 'test-usb-microphone' }, { microphone: 'default' },
      { dictationLanguages: ['hi'] }, { dictationLanguages: ['en', 'hg'] }, { dictationLanguages: ['en'] },
      { autoAddToDictionary: false }, { autoAddToDictionary: true },
    ];
    for (const patch of patches) {
      const [key, rawValue] = Object.entries(patch)[0];
      const value = key === 'dictationLanguages' ? ['en'] : rawValue;
      const snapshot = plain(await set(null, patch));
      const saved = JSON.parse(fs.readFileSync(h.run('SETTINGS_FILE'), 'utf8'));
      assert.deepStrictEqual(snapshot[key], value, key + ' returns the confirmed value');
      assert.deepStrictEqual(saved[key], value, key + ' is written to the settings file');
      h.run('loadSettings()');
      assert.deepStrictEqual(plain(h.run('settings.' + key)), value, key + ' survives reloading settings');
      if (['microphone'].includes(key)) {
        assert.deepStrictEqual(states.at(-1)[key], value, key + ' reaches the recording overlay');
      }
      if (key === 'dictationLanguages') {
        assert.strictEqual(h.run('engineLanguage()'), 'en');
      }
    }
    console.log('General settings: per-shortcut mode plus legacy dictateMode mapping persisted, reloaded, and reached recording mode, microphone and language routing.');
  } finally { await h.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
