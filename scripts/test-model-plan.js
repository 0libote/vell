'use strict';

// What a machine has to download, and what is merely offered.
//
// Vell ships one engine, Desert Ant Voz, whose ~409MB bundle the provider
// fetches and caches on install. There is nothing else to download and no
// per-device variants: one model, one plan.

const assert = require('assert');
const plan = require('../src/model-plan');
const asr = require('../src/asr');

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

// The real catalogue size, so the figures below are the ones users see.
const SIZES = { voz: 409000000 };
const GB = (n) => Number((n / 1e9).toFixed(2));

function planFor(overrides) {
  return plan.plan(Object.assign({ sizes: SIZES, installed: {} }, overrides));
}

// --- 1. A first run downloads Voz, and nothing else ---------------------------
const firstRun = planFor({ engine: 'voz', device: 'auto' });
eq('a Voz install needs only Voz', firstRun.required, ['voz']);
eq('and that is what it costs', GB(firstRun.requiredBytes), 0.41);
eq('and nothing else is on offer', firstRun.optional, []);
eq('and nothing is hidden', firstRun.hidden, []);

// --- 2. Installed means ready ---------------------------------------------------
const ready = planFor({ engine: 'voz', device: 'auto', installed: { voz: true } });
ok('with the model installed the plan is ready', ready.ready);
eq('and nothing is missing', ready.missing, []);
eq('and nothing costs anything', ready.requiredBytes, 0);

// --- 3. Switching engine always lands on Voz ------------------------------------
eq('an unknown engine falls back to Voz',
  plan.missingFor({ engine: 'whisper', device: 'auto', sizes: SIZES, installed: {} }), ['voz']);

// --- 4. Both platforms offer Voz and only Voz -------------------------------------
const capabilities = require('../src/asr-capabilities');
eq('Windows offers Voz',
  plan.availableEngines('win32'), ['voz']);
eq('a Mac offers Voz too',
  plan.availableEngines('darwin'), ['voz']);
ok('and it is a real engine',
  plan.availableEngines('darwin').every((id) => capabilities.ENGINE_IDS.includes(id)));
eq('an unknown platform is a developer build and sees everything',
  plan.availableEngines('freebsd'), [...capabilities.ENGINE_IDS]);
eq('the list is a copy, so a caller cannot edit the catalogue',
  (() => { plan.availableEngines('darwin').push('qwen3-asr'); return plan.availableEngines('darwin'); })(),
  ['voz']);
eq('the platform defaults to this machine',
  plan.availableEngines(), plan.availableEngines(process.platform));

eq('engineOffered agrees with the list on Windows',
  capabilities.ENGINE_IDS.map((id) => plan.engineOffered(id, 'win32')), [true]);
eq('and on a Mac',
  capabilities.ENGINE_IDS.map((id) => plan.engineOffered(id, 'darwin')), [true]);
ok('engineOffered takes the value as typed', plan.engineOffered(' Voz ', 'darwin'));
ok('and nothing else is an engine', !plan.engineOffered('nonsense', 'win32'));
ok('nor is nothing at all', !plan.engineOffered('', 'darwin') && !plan.engineOffered(undefined, 'win32'));

// The offered engine has to have a model plan behind it, or the picker would
// show an engine that cannot be downloaded.
for (const platform of ['win32', 'darwin']) {
  for (const engine of plan.availableEngines(platform)) {
    eq(platform + ' offers ' + engine + ', and it requires exactly one model',
      planFor({ engine, device: 'auto' }).required.length, 1);
  }
}

// --- 5. Sizes come from the caller, not from here -------------------------------
eq('a component with no size reported costs nothing',
  plan.plan({ engine: 'voz', device: 'auto', sizes: {}, installed: {} }).requiredBytes, 0);
eq('an unknown engine falls back to Voz',
  plan.modelForEngine('nonsense', 'auto'), 'voz');

// --- 6. Only Voz is a known engine -----------------------------------------------
eq('asr knows only Voz', Object.keys(asr.ASR_ENGINES), ['voz']);
eq('and Voz is the default', asr.DEFAULT_ASR_ENGINE, 'voz');
eq('unknown engines normalise to Voz', asr.normalizeAsrEngine('whisper'), 'voz');

process.stdout.write('all ' + checks + ' model plan checks passed\n');
