# Speech pipeline

## Stages

1. **Audio capture** — `src/overlay.js` (`getUserMedia` → `AudioContext` 48kHz →
   analyser/processor/captureSink), chunked by `src/chunking.js`.
2. **Model management** — `src/asr-runtime.js` (Python runtime install),
   `src/asr-model.js` (model download/verify/remove),
   `src/speech-models.js` + `src/speech-model-catalog.json` (packs),
   `src/model-plan.js` (which engine for which request).
3. **Transcription** — sidecar `sidecar/transcribe.py`
   (`WhisperBackend` / `QwenBackend` / `ParakeetBackend` / `RouterBackend`),
   selected via `ENGINE_CAPABILITIES` (`src/asr-capabilities.js`, mirrored in
   Python, parity-tested by `scripts/test-asr-capabilities.js`).
   New neutral façade: `src/transcription-provider.js`
   (`transcribe({wavPath|pcm16,…}) → {text, words[], engine, …}`,
   `wordsToSegments()` for legacy `segments/spans`).
4. **Preprocessing** — VAD/chunk boundaries (`chunking.js`), `speech-gate.js`.
5. **Cleanup & formatting** — `cleanup.js` (voice commands, scratch-that),
   `numbers.js`, `spoken-corrections.js`, `style.js` (per-app fillers),
   `hinglish.js`.
6. **Dictionary** — `dictionary.js` (`applyDictionary`), `auto-dictionary.js`,
   `correction-learning.js`, `vocabulary.js`, `corpus.js`, `repair.js`
   (phonetic post-match for engines with no context input), `phonetics.js`.
7. **Insertion** — `clipboard-paste.js` → native paste → focus restore.
8. **UI** — Island overlay (`overlay.js`), dashboard (`app.js`).

## Adding a transcription provider

1. Implement `transcribe(request)` in `src/transcription-provider.js`
   (or a sidecar backend class with the same result shape):
   input `{ wavPath | pcm16, sampleRate, language, vocabularyTerms[], quality }`,
   output `{ text, words: [{text,start,end}], engine, language,
   realtimeFactor, vocabularyVia, status, error }`.
2. Use `wordsToSegments()` to fill `segments/spans` for `repair.js`.
3. Add capability row to `src/asr-capabilities.js` **and**
   `sidecar/transcribe.py` `ENGINE_CAPABILITIES` (parity test must stay green).
4. Add engine entry to `src/asr.js` `ASR_ENGINES` + model pack to
   `src/speech-model-catalog.json`.
5. Route via `planRoute()` (`vocabularyVia`: `context`/`initial_prompt`/
   `repair`/`none`). Non-detecting engines (Voz) must not accept `auto`.
6. Test with `scripts/test-transcription-provider.js` pattern (mock first,
   then a real WAV through `--check` + one JSON-line request).

## Current local models (temporary, pre-Voz)

Parakeet v3 (default, ~0.6GB), Whisper large-v3 turbo (~1.6GB),
Whisper large-v3 (~3GB), Qwen3-ASR 1.7B (~4.7GB, best with dictionary).
All run in the Python sidecar; downloads are user-triggered from
Settings → Speech engines, hashed and verified. See `docs/DESERT-ANT.md`
for the Voz replacement plan.
