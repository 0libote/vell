'use strict';

// What the speech engine can actually do.
//
// Vell ships one engine: Desert Ant Voz. This file states, in one place, what
// it honours, so every caller either uses the stated mechanism or says out
// loud that it could not. Anything that silently drops a capability is a bug
// against this file.

// Vocabulary mechanisms, by what the engine's own API calls them:
//
//   null            No context input at all. Voz takes no vocabulary input on
//                   the JS path yet, so terms are applied after recognition,
//                   from the audio-derived transcript.
const ENGINE_CAPABILITIES = Object.freeze({
  // Desert Ant Voz (Parakeet TDT 0.6B v3, on-device). Vell's only engine.
  // ~409MB bundle, 25 languages, word timestamps at 80ms resolution. No
  // language detection -- the first selected language is what the transcript
  // is treated as. Vocabulary biasing is not available on the JS path yet,
  // so terms go via repair.
  voz: Object.freeze({
    id: 'voz',
    vocabulary: Object.freeze({
      supported: false,
      mechanism: null,
      maxTerms: 0,
      maxTokens: 0,
      note: 'Voz takes no vocabulary input on the JS path yet; terms are applied after recognition.',
    }),
    languages: Object.freeze(["bg","hr","cs","da","nl","en","et","fi","fr","de","el","hu","it","lv","lt","mt","pl","pt","ro","ru","sk","sl","es","sv","uk"]),
    autoDetectLanguage: false,
    segments: true,
    confidence: false,
    timestamps: true,
  }),
});

const ENGINE_IDS = Object.freeze(Object.keys(ENGINE_CAPABILITIES));

function normalizeEngine(value) {
  const id = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ENGINE_CAPABILITIES, id) ? id : 'voz';
}

function capabilitiesFor(engine) {
  return ENGINE_CAPABILITIES[normalizeEngine(engine)];
}

function supportsVocabulary(engine) {
  return capabilitiesFor(engine).vocabulary.supported;
}

function vocabularyMechanism(engine) {
  return capabilitiesFor(engine).vocabulary.mechanism;
}

function vocabularyBudget(engine) {
  const vocab = capabilitiesFor(engine).vocabulary;
  return { maxTerms: vocab.maxTerms, maxTokens: vocab.maxTokens, mechanism: vocab.mechanism };
}

function supportsLanguage(engine, language) {
  const id = String(language || 'en').trim().toLowerCase();
  // 'auto' is what more than one dictation language becomes on the wire:
  // the engine is asked to detect. Only engines that can detect support it.
  if (id === 'auto') return !!capabilitiesFor(engine).autoDetectLanguage;
  return capabilitiesFor(engine).languages.includes(id);
}

// How a vocabulary request is going to be honoured on a given engine.
//
//   'context' / 'initial_prompt'  the engine is told the terms before decoding
//   'repair'                      the engine cannot be told, so the terms are
//                                 matched against what it heard afterwards
//   'none'                        there is no vocabulary to apply
//
// 'repair' is a real route, not a shrug: src/repair.js works on the phonetics
// of what the engine returned, which is audio-derived evidence. It is weaker
// than biasing the decoder and the diagnostics say so, but it is the honest
// answer for an engine with no context input.
function vocabularyRoute(engine, termCount) {
  if (!Number(termCount)) return 'none';
  return supportsVocabulary(engine) ? vocabularyMechanism(engine) : 'repair';
}

// Whether a fast-path swap is allowed to happen for this request.
//
// There is only one engine and no faster path to swap to.
function planRoute(options) {
  const opts = options || {};
  const primary = normalizeEngine(opts.engine);
  const language = String(opts.language || 'en').trim().toLowerCase();
  const termCount = Math.max(0, Number(opts.termCount) || 0);

  const plan = {
    engine: primary,
    fallbackFrom: null,
    reason: '',
    vocabularyVia: vocabularyRoute(primary, termCount),
    lostCapabilities: [],
    degraded: false,
  };

  if (!supportsLanguage(primary, language)) {
    plan.lostCapabilities.push('language:' + language);
    plan.degraded = true;
    plan.reason = engineLabel(primary) + ' does not recognise this language.';
  }
  return plan;
}

const ENGINE_LABELS = Object.freeze({
  voz: 'Voz',
});

function engineLabel(engine) {
  return ENGINE_LABELS[normalizeEngine(engine)] || 'the speech engine';
}

// A one-line, user-facing account of what the engine did and what it cost.
// Shown next to the transcript rather than buried in a log, because a silent
// capability loss is the thing this whole file exists to prevent.
function describeRoute(plan, options) {
  const opts = options || {};
  const p = plan || {};
  const parts = [engineLabel(p.engine)];
  if (opts.device) parts.push('on the ' + opts.device);
  let text = parts.join(' ');
  if (p.vocabularyVia === 'repair') {
    text += ' · dictionary applied after recognition';
  }
  if (p.reason) text += ' · ' + p.reason;
  return text;
}

// The short line shown next to a finished dictation. Longer routing reasons
// stay in the diagnostics record; this is what a person can read at a glance.
function summarizeRoute(plan, options) {
  const opts = options || {};
  const p = plan || {};
  const name = engineLabel(p.engine);
  const via = p.vocabularyVia;
  if (via === 'repair') return name + ' · dictionary applied after recognition';
  return name;
}

module.exports = {
  ENGINE_CAPABILITIES,
  ENGINE_IDS,
  normalizeEngine,
  capabilitiesFor,
  supportsVocabulary,
  vocabularyMechanism,
  vocabularyBudget,
  supportsLanguage,
  vocabularyRoute,
  planRoute,
  engineLabel,
  describeRoute,
  summarizeRoute,
};
