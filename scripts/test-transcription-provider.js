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
  ok('engine processing time reported', result.processingTime === 10);
  ok('mock is never a cold start', result.coldStart === false && result.loadMs === 0);
  const warm = provider.normalizeResult({ text: 'hi', coldStart: true, loadMs: 1234 }, 'voz');
  ok('cold start survives normalization', warm.coldStart === true && warm.loadMs === 1234);

  ok('lists real voz provider', provider.listProviders().includes('voz'));
  const real = provider.createProvider('voz');
  ok('real voz provider builds without loading a model', !!real && real.id === 'voz');
  let wavOk = false;
  try {
    provider.readWavMono16k(Buffer.from('RIFF----WAVEfmt '));
  } catch (e) {
    wavOk = /fmt\/data|not a WAV/.test(e.message);
  }
  ok('wav reader rejects garbage cleanly', wavOk);

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
