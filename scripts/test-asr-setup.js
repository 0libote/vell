'use strict';

// Voz setup: one model, one download, no sidecar process to start. These tests
// drive the real src/main.js and assert on what setup actually does.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const harness = require('./asr-test-harness');

async function main() {
  const h = harness();
  try {
    h.run('vozModelManager = null;');
    h.run('startSidecar();');
    assert.strictEqual(h.launches.length, 0, 'missing model starts no subprocesses');
    assert.strictEqual(h.run('sidecarState'), 'unavailable');

    const state = { calls: [], installed: false };
    h.context.testVoz = {
      snapshot: () => ({ id: 'voz', installed: !!state.installed, downloadBytes: state.installed ? 0 : 409000000 }),
      installed: () => !!state.installed,
      install: async () => { state.calls.push('voz'); state.installed = true; },
      remove: async () => { state.calls.push('remove-voz'); state.installed = false; },
    };
    h.run('vozModelManager = testVoz;');

    // A fresh install downloads Voz and nothing else.
    const first = h.handlers.get('asr-runtime-install')();
    const second = h.handlers.get('asr-runtime-install')();
    assert.strictEqual(first, second, 'repeated installs share one operation');
    await first;
    assert.deepStrictEqual(state.calls, ['voz'], 'setup downloads only Voz');
    assert.strictEqual(h.run('currentModelPlan().ready'), true);
    assert.strictEqual(h.run('sidecarState'), 'ready', 'a finished setup readies transcription');
    assert.strictEqual(h.run('asrRuntimeWouldHelp()'), false, 'and the banner stops asking');

    // Cancelling mid-install reports cancelled and frees the operation.
    state.installed = false;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    h.context.testVoz.install = async () => { state.calls.push('voz'); await gate; state.installed = true; };
    const installing = h.handlers.get('asr-runtime-install')();
    await Promise.resolve();
    h.handlers.get('asr-runtime-cancel')();
    assert.strictEqual(h.run('asrRuntimeState.status'), 'cancelling');
    release();
    await installing;
    assert.strictEqual(h.run('asrRuntimeState.status'), 'cancelled', 'a cancelled install reports cancelled');
    assert.strictEqual(h.run('asrOperation'), null, 'and frees the operation');

    // Removing Voz disables dictation until it is back.
    await h.handlers.get('asr-runtime-remove')();
    assert.deepStrictEqual(state.calls.slice(-1), ['remove-voz'], 'removal deletes the model');
    assert.strictEqual(h.run('asrIsDisabled()'), true, 'removal records the intent to stay disabled');
    assert.strictEqual(h.run('sidecarState'), 'unavailable');
    assert.strictEqual(h.run('currentModelPlan().ready'), false);
    assert.strictEqual(h.run('asrRuntimeWouldHelp()'), true, 'and the banner offers setup again');
    h.run('fs.rmSync(asrDisabledPath(), { force: true });');

    // One model goes on its own, and an unknown id removes nothing.
    const before = state.calls.length;
    await h.handlers.get('speech-model-remove')(null, 'voz');
    assert.strictEqual(state.calls.length, before + 1, 'the named model is removed');
    assert.strictEqual(h.run('asrIsDisabled()'), false, 'removing one model does not disable dictation');
    assert.strictEqual(h.run('asrOperation'), null);
    await h.handlers.get('speech-model-remove')(null, 'not-a-model');
    assert.strictEqual(state.calls.length, before + 1, 'an unknown id removes nothing');

    // The picker only knows Voz.
    h.run("settings.localModelChosen = false;");
    await h.handlers.get('local-model-setup')(null, 'voz');
    assert.strictEqual(h.run('settings.asrEngine'), 'voz');
    assert.strictEqual(h.run('settings.localModelChosen'), true, 'a Voz install chooses the model');
    assert.throws(() => h.handlers.get('local-model-setup')(null, 'whisper'), /Choose a supported speech model/);

    // Interrupted setup survives app restart, and settings survive removal.
    // The saved run only matters while the model is missing: a completed
    // install already answers the question the banner would ask.
    state.installed = false;
    h.run("asrRuntimeState = {status: 'preparing', step: 'model'}; saveAsrSetupState(); asrRuntimeState = {}; loadAsrSetupState();");
    assert.strictEqual(h.run('asrRuntimeState.status'), 'cancelled', 'interrupted setup survives app restart');
    h.run("settings.asrEngine = 'voz'; saveSettings(); loadSettings();");
    assert.strictEqual(h.run('settings.asrEngine'), 'voz', 'removal preserves model choice');
    assert(fs.existsSync(path.join(h.root, 'data/settings.json')), 'user settings survive removal');
    console.log('all speech setup lifecycle tests passed');
  } finally { await h.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
