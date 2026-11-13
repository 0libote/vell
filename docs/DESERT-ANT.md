# Desert Ant Labs integration plan

## Status

Not yet integrated. Local Python sidecar (Parakeet/Whisper/Qwen) is the
temporary backend. `src/transcription-provider.js` is the seam; `voz` is a
hidden, non-default capability row until the worker lands.

## Voz facts

- NVIDIA Parakeet TDT 0.6B v3, converted/compressed. **337MB**.
  WER 6.43% (beats whisper-turbo 7.00%). Word timestamps, 80ms frames.
- 25 languages: bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro ru
  sk sl es sv uk. **No Hindi.** No language detection — gate with Ear or an
  explicit language choice; wrong-language audio returns fluent-but-wrong text.
- Swift: `Voz()` / `transcribe(url|samples:)` / `isDownloaded/download` /
  `LiveConfiguration.vocabulary`. Create once, reuse (warm 0.2s; first CoreML
  compile 10–30s — pre-download during onboarding).
- Windows: Swift SDK runs Voz on GPU via ONNX Runtime + DirectML (same API).
- JS: `@desert-ant-labs/voz` + `onnxruntime-web`; `Voz.load()` →
  `transcribe(File|Blob|ArrayBuffer|samples)` → `{text, words[], realtimeFactor}`;
  encoder WebGPU, decoder WebNN where available; Node CPU-only, ~1.2GB peak.
- Vocabulary biasing: Swift/Kotlin yes; **JS not yet**.
- Pin: `desert-ant-core 4.3.0`, weights `v0.5.0`.

## Licence / telemetry / attribution (DAL Source-Available 1.0, 2026-07-03)

- Free below **100,000 monthly active devices per platform per model**.
  Above → commercial (`licensing@desertant.com`).
- **Do not disable/tamper telemetry.** MAD-counting only, SDK-generated ID,
  no inputs/outputs/content, no cross-linking. Vell must disclose it in the
  privacy notice. Retained: Derived Data only.
- Attribution: one discoverable placement — Settings/About screen + website
  legal page: e.g. `Voz by Desert Ant Labs` + link `https://desertant.com`
  (text-only OK offline). Keep file-level notices. 🐜 alone is not enough.
- No competing-model training on models/outputs/logs/embeddings/evals.
  No standalone redistribution. Secure weights. EU AI Act: DAL = model
  provider, Vell = system provider.
- Full terms: https://license.desertant.com/1.0

## Platform implications

- Swift path needs **macOS 15+ / Swift 6.2+ (Xcode 26)**. Voxden supported
  macOS 12+. Options: (a) gate Voz to 15+ with Parakeet fallback below,
  (b) JS/WASM path in Electron on all versions, (c) Python sidecar ORT/DML.
- Windows: reuse existing `directml` opt-in pattern (`onnx_providers`,
  `gpu_mismatch_note`). No Mac-only architectural dependency — the provider
  interface stays platform-neutral; only worker implementations differ.

## Next steps (in order)

1. Spike outside app: Node `Voz.load({ort: onnxruntime-node})` on fixture WAV;
   record CPU RTF + memory.
2. `voz` hidden engine + capability row — DONE (this repo). Parity green.
3. Sidecar `VozBackend` behind env flag, `--check`-only; one manual WAV via
   JSON-line; verify `words→segments` + Ear gate for `auto`/non-Voz langs.
4. Model pack entry (`desert-ant-labs/voz`), Settings opt-in, onboarding
   pre-download, attribution line + privacy-notice telemetry disclosure.
5. Swap default Parakeet → Voz once quality/latency validated; keep sidecar
   as fallback one release.
