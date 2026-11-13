'use strict';

// Provider-interface smoke test: exercises src/transcription-provider.js with
// the MockVozProvider. No model, no Electron, no network.

const assert = require('assert');
const provider = require('../src/transcription-provider');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

async function main() {
  ok('lists mock provider', provider.listProviders().includes('voz-mock'));

  const p = provider.createProvider('voz-mock');
  const result = await p.transcribe({ language: 'en', vocabularyTerms: ['Vell'] });
  ok('returns tagline text', result.text === 'Speak naturally. Type instantly.');
  ok('returns four words', result.words.length === 4);
  ok('word timestamps present', typeof result.words[0].start === 'number');
  ok('maps to segments', result.segments.length === 1 && result.spans.length === 4);
  ok('engine tagged', result.engine === 'voz-mock');
  ok('vocabulary via repair', result.vocabularyVia === 'repair');

  const empty = provider.wordsToSegments([]);
  ok('empty maps cleanly', empty.text === '' && empty.segments.length === 0);

  const normalized = provider.normalizeResult(null, 'voz-mock');
  ok('null normalizes', normalized.status === 'ok' && normalized.engine === 'voz-mock');

  let threw = false;
  try {
    provider.createProvider('nope');
  } catch (e) {
    threw = true;
  }
  ok('unknown provider throws', threw);

  process.stdout.write('checks: ' + checks + '\n');
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
