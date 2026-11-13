# Voz JS spike (no model downloaded)

Date: 2026-11-13. Package `@desert-ant-labs/voz@4.3.0`, 6 deps, installs clean.

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

## Not done here

Model bundle NOT downloaded (409MB) — first `Voz.load()` fetches it with
`onProgress`. Full transcription timing must be measured on target hardware
(Mac/Windows) during onboarding-flow work. See `docs/DESERT-ANT.md` step 1.
