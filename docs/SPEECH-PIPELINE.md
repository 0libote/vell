# Speech pipeline

## Stages

1. **Audio capture** — `src/overlay.js` (`getUserMedia` → `AudioContext` 48kHz →
   analyser/processor/captureSink), chunked by `src/chunking.js`.
2. **Model management** — `src/voz-model.js` (Voz install/remove/snapshot via
   the SDK cache) + `src/model-plan.js` (single-component plan: Voz).
3. **Transcription** — in-process `VozProvider` (`src/transcription-provider.js`:
   `transcribe({wavPath|pcm16,…}) → {text, words[], engine, …}`, shared
   singleton via `ensureVoz()`/`dropVoz()`), selected via
   `ENGINE_CAPABILITIES` (`src/asr-capabilities.js`, Voz-only).
   `wordsToSegments()` fills legacy `segments/spans` for `repair.js`.
4. **Preprocessing** — VAD/chunk boundaries (`chunking.js`), `speech-gate.js`.
5. **Cleanup & formatting** — `cleanup.js` (voice commands, scratch-that),
   `numbers.js`, `spoken-corrections.js`, `style.js` (per-app fillers).
6. **Dictionary** — `dictionary.js` (`applyDictionary`), `auto-dictionary.js`,
   `correction-learning.js`, `vocabulary.js`, `corpus.js`, `repair.js`
   (phonetic post-match — Voz takes no context input, so terms always apply
   after recognition), `phonetics.js`.
7. **Insertion** — `clipboard-paste.js` → native paste → focus restore.
8. **UI** — Island overlay (`overlay.js`), dashboard (`app.js`).

## Voz notes

- One engine, one device (CPU via `onnxruntime-node`), 25 languages, no
  auto-detect: the first selected language is what the transcript is treated as.
- `planRoute()` can only ever pick Voz; `vocabularyVia` is always `repair`.
- First transcription of a session compiles the model (~10s, then warm);
  `scheduleSidecarWarmStart()` warms it in the background once installed.
