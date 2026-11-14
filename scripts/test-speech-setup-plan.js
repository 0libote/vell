'use strict';

// Setup downloads the Voz model, and nothing else.
//
// There is one engine and one model: the provider fetches and caches its own
// ~409MB bundle, so setup is a single download with one progress bar. These
// tests drive the real src/main.js and assert on what it actually fetches.

const assert = require('assert');
const harness = require('./asr-test-harness');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

// A voz-model stand-in that records installs instead of downloading 409MB.
function install(state) {
  h.context.testVoz = {
    snapshot: () => ({
      id: 'voz',
      installed: !!state.installed,
      downloadBytes: state.installed ? 0 : 409000000,
      installedBytes: state.installed ? 409000000 : 0,
    }),
    installed: () => !!state.installed,
    install: async () => { state.calls.push('voz'); state.installed = true; },
    remove: async () => { state.calls.push('voz-remove'); state.installed = false; },
  };
  h.run('vozModelManager = testVoz;');
}

const h = harness();

async function main() {
  // --- 1. A Voz install fetches Voz only ----------------------------------
  const fresh = { calls: [], installed: false };
  install(fresh);
  h.run("settings.asrEngine = 'voz'; settings.dictationLanguage = 'en';");
  eq('the plan asks for Voz and nothing else',
    h.run('currentModelPlan().required'), ['voz']);
  eq('and prices it on its own',
    Number((h.run('currentModelPlan().requiredBytes') / 1e9).toFixed(2)), 0.41);

  await h.handlers.get('asr-runtime-install')();
  eq('setup downloaded Voz, nothing more', fresh.calls, ['voz']);
  ok('and the model is now installed', h.run('vozModelManager.installed()'));
  eq('so the plan is ready', h.run('currentModelPlan().ready'), true);
  eq('and the banner stops asking', h.run('asrRuntimeWouldHelp()'), false);

  // --- 2. An unknown component is refused ---------------------------------
  const before = fresh.calls.length;
  await h.handlers.get('speech-model-install')(null, 'not-a-model');
  eq('an unknown component downloads nothing', fresh.calls.length, before);

  // --- 3. A missing model is not ready, and the banner says so ------------
  const missing = { calls: [], installed: false };
  install(missing);
  ok('without the model the plan is not ready',
    !h.run('currentModelPlan().ready'));
  eq('and says exactly what is missing', h.run('currentModelPlan().missing'), ['voz']);
  eq('and the banner offers it', h.run('asrRuntimeWouldHelp()'), true);

  // --- 4. The snapshot the renderer reads ----------------------------------
  const snap = h.run('snapshot()');
  ok('the snapshot carries the plan', snap.modelPlan);
  eq('with the engine it was built for', snap.modelPlan.engine, 'voz');
  // Every component lands in exactly one bucket. Counted against the plan's
  // own item list rather than a literal, so a new component does not make
  // this fail for a reason that has nothing to do with what it checks.
  ok('and every component accounted for',
    snap.modelPlan.required.length + snap.modelPlan.optional.length
      + snap.modelPlan.hidden.length === snap.modelPlan.items.length);
  eq('a missing model leaves a nonzero required figure',
    snap.modelPlan.requiredBytes > 0, true);

  // --- 5. The default engine, and who keeps the one they had ----------------
  // A fresh install starts on Voz. A settings file from before the engine
  // key existed belongs to somebody whose model is already on disk.
  const readEngineWith = (installed) => {
    install({ calls: [], installed });
    return h.run("saveSettings(); fs.writeFileSync(SETTINGS_FILE, '{}'); loadSettings(); settings.asrEngine");
  };
  eq('nothing downloaded starts on Voz', readEngineWith({}), 'voz');
  eq('a fresh user sees the model picker', h.run('snapshot().localModelChosen'), false);
  h.run('saveSettings(); loadSettings();');
  eq('saving unrelated settings does not skip the picker', h.run('settings.localModelChosen'), false);
  eq('a named engine is never second-guessed',
    h.run("fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ asrEngine: 'voz' })); loadSettings(); settings.asrEngine"),
    'voz');
  eq('existing users do not repeat onboarding', h.run('settings.localModelChosen'), true);

  // --- 6. The picker downloads Voz and remembers the choice -----------------
  const picked = { calls: [], installed: false };
  install(picked);
  h.run("settings.localModelChosen = false;");
  await h.handlers.get('local-model-setup')(null, 'voz');
  eq('picker downloads only Voz', picked.calls, ['voz']);
  h.run('loadSettings();');
  eq('picker keeps Voz', h.run('settings.asrEngine'), 'voz');
  eq('picker remembers the choice across restart', h.run('settings.localModelChosen'), true);
  assert.throws(() => h.handlers.get('local-model-setup')(null, 'invalid'), /Choose a supported speech model/);

  // --- 7. Languages are an explicit choice, not a detection ------------------
  // Voz covers every offered language on-device, so the picker is never
  // locked and the first selected language is what the text rules use.
  h.run("syncDictationLanguages(['en', 'pt']);");
  eq('the first selected language leads', h.run('textLanguage()'), 'en');
  h.run("syncDictationLanguages(['pt']);");
  eq('an explicit non-English choice is honoured', h.run('textLanguage()'), 'pt');
  h.run("syncDictationLanguages(['hi']);");
  eq('unsupported languages fall back to English', h.run('textLanguage()'), 'en');
  eq('the picker is never locked', h.run('snapshot().dictationLanguageUnlocked'), true);
  eq('and every Voz language is offered', h.run('snapshot().dictationLanguageOffered.length'), 25);

  // --- 8. Recording blocked by setup must land at the controls that can fix it
  h.context.openedSettings = [];
  h.run("openHistory = cat => openedSettings.push(cat); sidecarState = 'unavailable'; startRecording(false);");
  h.run("sidecarState = 'ready'; asrOperation = { kind: 'install' }; startRecording(true); asrOperation = null;");
  h.run("fs.mkdirSync(path.dirname(asrDisabledPath()), { recursive: true }); fs.writeFileSync(asrDisabledPath(), '{}'); startRecording(false);");
  eq('missing, installing, and disabled engines each open Speech engines once',
    h.context.openedSettings, ['speech-engines', 'speech-engines', 'speech-engines']);
  h.run('fs.rmSync(asrDisabledPath());');
  eq('the banner goes quiet once the model is back',
    h.run('vozModelManager.installed() && asrRuntimeWouldHelp()'), false);

  // --- 9. Removing the model disables dictation until it is back ------------
  const gone = { calls: ['voz'], installed: true };
  install(gone);
  await h.handlers.get('speech-model-remove')(null, 'voz');
  eq('removing Voz reports the removal', gone.calls, ['voz', 'voz-remove']);
  ok('and the plan is no longer ready', !h.run('currentModelPlan().ready'));
}

main().then(async () => {
  await h.close();
  process.stdout.write('all ' + checks + ' speech setup plan checks passed\n');
}).catch(async (err) => {
  await h.close();
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});
