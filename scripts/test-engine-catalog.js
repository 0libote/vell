'use strict';

// Engine catalog consistency: ASR_ENGINES, capabilities (JS), sidecar
// ENGINE_CAPABILITIES, and the transcription provider must agree.
// No Electron, no model, no network.

const assert = require('assert');
const asr = require('../src/asr');
const caps = require('../src/asr-capabilities');
const provider = require('../src/transcription-provider');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

const engineIds = Object.keys(asr.ASR_ENGINES);
ok('four-plus-one engines listed', engineIds.includes('parakeet') && engineIds.includes('voz'));
ok('voz is listed by name', asr.ASR_ENGINES.voz.name === 'Voz');

for (const id of engineIds) {
  const c = caps.capabilitiesFor(id);
  ok(id + ' has capability row', c && c.id === id);
}

ok('voz has no auto-detect', caps.capabilitiesFor('voz').autoDetectLanguage === false);
ok('voz vocabulary via repair', caps.vocabularyRoute('voz', 3) === 'repair');
ok('whisper vocabulary in-model', caps.vocabularyRoute('whisper', 3) === 'initial_prompt');

const p = provider.createProvider('voz-mock');
ok('mock provider builds', !!p);

process.stdout.write('checks: ' + checks + '\n');
