# Voz JS spike (model VERIFIED end-to-end)

Date: 2026-11-13. Package `@desert-ant-labs/voz@4.3.0` + `onnxruntime-node`
1.31.1, Linux x64 container, 4 CPUs.

## Confirmed API (from `voz.js` + `index.d.ts`)

- `Voz.load({ ort, modelBaseUrl, revision, webnn, wasmDir, onProgress, cache, ep })`
  - Browser: zero-config (`onnxruntime-web` imported on demand).
  - Node: pass `ort` (`onnxruntime-node`, native addon, not bundled).
  - `modelBaseUrl` must end in `/`; default is Hugging Face bundle (~409MB web).
  - `ep`: `"auto"` (default) → WebGPU if the adapter compiles f16 shaders,
    else CPU/WASM. Memory ~1.2GB (349MB weights).
- `voz.transcribe(input, { onProgress, sampleRate })`
  - Accepts: mono `Float32Array` (no conversion), `{ samples, sampleRate }`
    at any rate (linear resample to 16kHz), or encoded bytes
    (`ArrayBuffer`, `Uint8Array`, `Blob`, `File` — decoded via WebCodecs /
    Node needs WAV first).
  - Returns `{ text, words[{text,start,end}], duration, processingTime,
    realtimeFactor }`. 80ms timestamp resolution. One instance, reused;
    concurrent calls queue.
- `SAMPLE_RATE = 16000`. **No vocabulary param in JS** (Swift/Kotlin only) —
  Vell's `vocabularyVia: 'repair'` routing for voz is correct.

## Verified transcription (this container, CPU)

Fixture: 3.26s Librivox sentence, 16kHz mono
(SpeechBrain test sample `tests/samples/single-mic/example1.wav`).

- Transcript: "The birch canoe slid on the smooth planks." — correct.
- 8 words, start/end timestamps on 80ms frames (e.g. birch 0.24–0.72).
- First `Voz.load()`: ~10s including the ~409MB download (cached after).
- Transcribe wall: ~3.3–6.4s for 3.26s audio (0.5–1x RTF on this weak
  container CPU). Target hardware will be faster; note Node stays CPU-only —
  the GPU path is the browser (WebGPU/WebNN) or the Swift worker.

## In-repo PoC

`node scripts/voz-poc.js path/to/speech.wav` — 16-bit PCM WAV in, JSON
transcript out, via `src/transcription-provider.js` `VozProvider`
(wav parsing, resampling, `words→segments` mapping included).
Needs devDependency `onnxruntime-node` (`npm install`).

## Next

Electron worker wiring: native module rebuild for the packaged app,
model-download progress in the onboarding UI, then flip the fresh-install
default to Voz. See `docs/DESERT-ANT.md`.
