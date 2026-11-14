'use strict';

// Vell transcription provider interface.
//
// The Island recording bar and the dictation workflow must not depend on any
// specific speech model. Every engine implements this shape:
//
//   provider.transcribe({ wavPath | pcm16, sampleRate, language, vocabularyTerms[] })
//     → Promise<{ text, words: [{text, start, end}], engine, language,
//                  realtimeFactor, processingTime, vocabularyVia, status }>
//
// - `words` carry 80ms-resolution timestamps where the engine provides them.
//   Engines without timestamps return words with start/end null.
// - `wordsToSegments(words)` maps provider words onto the legacy
//   `segments/spans` shape that repair.js / polish flows consume, so swapping
//   engines never rewrites the text pipeline.
// - `MockVozProvider` below is the test implementation: it exercises the full
//   mapping without a model installed. `VozProvider` is the real Desert Ant
//   backend (onnxruntime-node, in-process) — see docs/DESERT-ANT.md.

function wordsToSegments(words) {
  const list = Array.isArray(words) ? words : [];
  const spans = list.map((w, i) => ({
    text: String((w && w.text) || ''),
    start: w && typeof w.start === 'number' ? w.start : null,
    end: w && typeof w.end === 'number' ? w.end : null,
    index: i,
  })).filter(s => s.text);
  const text = spans.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
  return { text, spans, segments: spans.length ? [{ text, spans }] : [] };
}

function normalizeResult(raw, fallbackEngine) {
  const r = raw || {};
  const words = Array.isArray(r.words) ? r.words.map(w => ({
    text: String((w && w.text) || ''),
    start: w && typeof w.start === 'number' ? w.start : null,
    end: w && typeof w.end === 'number' ? w.end : null,
  })).filter(w => w.text) : [];
  const mapped = wordsToSegments(words);
  const text = typeof r.text === 'string' && r.text ? r.text : mapped.text;
  return {
    text,
    words,
    segments: mapped.segments,
    spans: mapped.spans,
    engine: String(r.engine || fallbackEngine || 'unknown'),
    language: String(r.language || 'en'),
    realtimeFactor: typeof r.realtimeFactor === 'number' ? r.realtimeFactor : null,
    processingTime: typeof r.processingTime === 'number' ? r.processingTime : null,
    coldStart: r.coldStart === true,
    loadMs: typeof r.loadMs === 'number' && r.loadMs >= 0 ? Math.round(r.loadMs) : null,
    vocabularyVia: String(r.vocabularyVia || 'none'),
    status: String(r.status || 'ok'),
    error: r.error ? String(r.error) : null,
  };
}

// Test double shaped like the Voz backend. Returns a fixed transcript
// with word timestamps so Island/flow-bar tests can run without a model.
class MockVozProvider {
  constructor(options) {
    this.id = 'voz-mock';
    this.options = options || {};
  }

  async transcribe(request) {
    const req = request || {};
    const vocab = Array.isArray(req.vocabularyTerms) ? req.vocabularyTerms : [];
    const words = [
      { text: 'Speak', start: 0.0, end: 0.24 },
      { text: 'naturally.', start: 0.24, end: 0.56 },
      { text: 'Type', start: 0.64, end: 0.88 },
      { text: 'instantly.', start: 0.88, end: 1.2 },
    ];
    return normalizeResult({
      text: 'Speak naturally. Type instantly.',
      words,
      engine: 'voz-mock',
      language: req.language || 'en',
      realtimeFactor: 120,
      processingTime: 10,
      coldStart: false,
      loadMs: 0,
      vocabularyVia: vocab.length ? 'repair' : 'none',
      status: 'ok',
    }, 'voz-mock');
  }
}

function resampleLinear(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, samples.length - 1);
    out[i] = samples[low] + (samples[high] - samples[low]) * (at - low);
  }
  return out;
}

// Minimal WAV reader: 16-bit PCM or 32-bit float, any rate, mono or stereo
// (stereo is averaged). No ffmpeg needed; the PoC stays dependency-free.
function readWavMono16k(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const text = (o, n) => String.fromCharCode.apply(null, new Uint8Array(buf.buffer, buf.byteOffset + o, n));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      data = { offset: offset + 8, size };
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV has no fmt/data chunk');
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) throw new Error('WAV must be PCM16 or float32');
  const bytesPerSample = fmt.bitsPerSample / 8;
  const frames = Math.floor(data.size / bytesPerSample / fmt.channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < fmt.channels; ch++) {
      const at = data.offset + (i * fmt.channels + ch) * bytesPerSample;
      sum += fmt.audioFormat === 3 ? view.getFloat32(at, true) : view.getInt16(at, true) / 32768;
    }
    mono[i] = sum / fmt.channels;
  }
  return { samples: resampleLinear(mono, fmt.sampleRate, 16000) };
}

// Real Desert Ant Voz backend (Node path: onnxruntime-node, CPU).
// PoC-verified 2026-11-13 on Linux x64: a 3.26s fixture transcribed correctly
// with word timestamps (see docs/VOZ-SPIKE.md). One instance is loaded and
// reused across the provider and the model manager: the bundle holds ~1.2GB,
// so a second load would double it. Concurrent callers share the in-flight
// load. Call dropVoz() before deleting the cached bundle (model remove),
// never mid-dictation.
let sharedVoz = null;
let sharedVozLoad = null;

function resetSharedVozForTests() {
  sharedVoz = null;
  sharedVozLoad = null;
}

async function ensureVoz(options) {
  if (sharedVoz) return sharedVoz;
  if (!sharedVozLoad) {
    const opts = options || {};
    sharedVozLoad = (async () => {
      let ort;
      try {
        ort = require('onnxruntime-node');
      } catch (e) {
        throw new Error('Voz needs the onnxruntime-node dependency (npm install).');
      }
      const { Voz } = await import('@desert-ant-labs/voz');
      sharedVoz = await Voz.load({
        ort,
        modelBaseUrl: opts.modelBaseUrl,
        revision: opts.revision,
        onProgress: opts.onProgress,
      });
      return sharedVoz;
    })().catch((error) => {
      sharedVozLoad = null;
      throw error;
    });
  }
  return sharedVozLoad;
}

async function dropVoz() {
  sharedVozLoad = null;
  sharedVoz = null;
}

class VozProvider {
  constructor(options) {
    this.id = 'voz';
    this.options = options || {};
  }

  async _ensure(onProgress) {
    return ensureVoz({ ...this.options, onProgress });
  }

  async transcribe(request) {
    const req = request || {};
    const terms = Array.isArray(req.vocabularyTerms) ? req.vocabularyTerms : [];
    let input;
    if (req.samples instanceof Float32Array) {
      input = { samples: resampleLinear(req.samples, req.sampleRate || 16000, 16000) };
    } else if (req.wavPath) {
      input = readWavMono16k(require('fs').readFileSync(req.wavPath));
    } else if (Buffer.isBuffer(req.wavBytes)) {
      input = readWavMono16k(req.wavBytes);
    } else {
      throw new Error('VozProvider needs samples (+sampleRate), wavPath, or wavBytes.');
    }
    const coldStart = !sharedVoz;
    const loadAt = Date.now();
    const voz = await this._ensure(req.onProgress);
    const loadedAt = Date.now();
    const result = await voz.transcribe(input);
    return normalizeResult({
      text: result.text,
      words: result.words,
      engine: 'voz',
      language: req.language || 'en',
      realtimeFactor: result.realtimeFactor,
      processingTime: result.processingTime,
      // Whether this call paid a model (re)load, and how long the load took.
      // Lets the UI name a slow transcription instead of leaving the user
      // guessing, and the history entry record it.
      coldStart,
      loadMs: coldStart ? Math.max(0, loadedAt - loadAt) : 0,
      // The JS SDK takes no vocabulary input yet, so terms go via repair.
      vocabularyVia: terms.length ? 'repair' : 'none',
      status: 'ok',
    }, 'voz');
  }
}

const PROVIDERS = Object.freeze({
  'voz-mock': MockVozProvider,
  voz: VozProvider,
});

function listProviders() {
  return Object.keys(PROVIDERS);
}

function createProvider(id, options) {
  const Cls = PROVIDERS[String(id || '').toLowerCase()];
  if (!Cls) throw new Error('Unknown transcription provider: ' + id);
  return new Cls(options);
}

module.exports = {
  wordsToSegments,
  normalizeResult,
  resampleLinear,
  readWavMono16k,
  ensureVoz,
  dropVoz,
  resetSharedVozForTests,
  MockVozProvider,
  VozProvider,
  listProviders,
  createProvider,
};
