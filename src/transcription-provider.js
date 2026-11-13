'use strict';

// Vell transcription provider interface.
//
// The Island recording bar and the dictation workflow must not depend on any
// specific speech model. Every engine implements this shape:
//
//   provider.transcribe({ wavPath | pcm16, sampleRate, language, vocabularyTerms[], quality })
//     → Promise<{ text, words: [{text, start, end}], engine, language,
//                  realtimeFactor, vocabularyVia, status }>
//
// - `words` carry 80ms-resolution timestamps where the engine provides them.
//   Engines without timestamps return words with start/end null.
// - `wordsToSegments(words)` maps provider words onto the legacy
//   `segments/spans` shape that repair.js / polish flows consume, so swapping
//   engines never rewrites the text pipeline.
// - `MockVozProvider` below is the test implementation: it exercises the full
//   mapping without a model installed. The real Voz backend (Desert Ant Labs)
//   plugs in here once its SDK/sidecar lands — see docs/DESERT-ANT.md.

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
    vocabularyVia: String(r.vocabularyVia || 'none'),
    status: String(r.status || 'ok'),
    error: r.error ? String(r.error) : null,
  };
}

// Test double shaped like the future Voz backend. Returns a fixed transcript
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
      vocabularyVia: vocab.length ? 'repair' : 'none',
      status: 'ok',
    }, 'voz-mock');
  }
}

const PROVIDERS = Object.freeze({
  'voz-mock': MockVozProvider,
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
  MockVozProvider,
  listProviders,
  createProvider,
};
