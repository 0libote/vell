'use strict';

// Voz proof of concept: transcribe a WAV file with the real Desert Ant model.
// No Electron, no sidecar, no fixture committed — pass any 16-bit PCM WAV:
//
//   npm install            # pulls @desert-ant-labs/voz + onnxruntime-node
//   node scripts/voz-poc.js path/to/speech.wav
//
// First run downloads the ~409MB web bundle (cached afterwards). Prints the
// transcript, word timestamps, and the realtime factor as JSON.

const path = require('path');
const provider = require('../src/transcription-provider');

async function main() {
  const wavPath = process.argv[2];
  if (!wavPath) {
    console.error('usage: node scripts/voz-poc.js <speech.wav>');
    process.exit(2);
  }
  const p = provider.createProvider('voz');
  const result = await p.transcribe({
    wavPath: path.resolve(wavPath),
    language: 'en',
    onProgress: (f) => process.stderr.write('\rdownload ' + (f * 100).toFixed(1) + '%'),
  });
  process.stderr.write('\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
