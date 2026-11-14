'use strict';

// Engine catalog consistency: ASR_ENGINES, capabilities (JS), and the
// transcription provider must agree. Vell ships one engine: Voz.
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
ok('voz is the only engine listed', engineIds.length === 1 && engineIds[0] === 'voz');
ok('voz is listed by name', asr.ASR_ENGINES.voz.name === 'Voz');
ok('voz is the default engine', asr.DEFAULT_ASR_ENGINE === 'voz');
ok('unknown engines fall back to voz', asr.normalizeAsrEngine('whisper') === 'voz');

for (const id of engineIds) {
  const c = caps.capabilitiesFor(id);
  ok(id + ' has capability row', c && c.id === id);
}
ok('catalog holds only voz', caps.ENGINE_IDS.length === 1 && caps.ENGINE_IDS[0] === 'voz');

ok('voz has no auto-detect', caps.capabilitiesFor('voz').autoDetectLanguage === false);
ok('voz vocabulary via repair', caps.vocabularyRoute('voz', 3) === 'repair');
ok('voz listens in 25 languages', caps.capabilitiesFor('voz').languages.length === 25);

const p = provider.createProvider('voz-mock');
ok('mock provider builds', !!p);

process.stdout.write('checks: ' + checks + '\n');
