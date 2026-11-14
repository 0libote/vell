# Desert Ant Labs integration

## Status

Voz is the only speech model. Transcription runs in the Electron main process
via the official `@desert-ant-labs/voz` SDK + `onnxruntime-node` (CPU-only,
verified to load under Electron 43 with no rebuild). The Python sidecar
(Parakeet/Whisper/Qwen), GPU packs, and per-engine downloads are gone.
PoC: `docs/VOZ-SPIKE.md` (correct transcript + word timestamps on a real fixture).

## Voz facts

- NVIDIA Parakeet TDT 0.6B v3, converted/compressed. **~409MB bundle**.
  WER 6.43% (beats whisper-turbo 7.00%). Word timestamps, 80ms frames.
- 25 languages: bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro ru
  sk sl es sv uk. **No Hindi.** No language detection — the first selected
  language is what the transcript is treated as; wrong-language audio returns
  fluent-but-wrong text.
- JS: `@desert-ant-labs/voz` + `onnxruntime-node`; `Voz.load()` →
  `transcribe(wavPath)` → `{text, words[], realtimeFactor}`; loaded once and
  reused (`ensureVoz()`), ~1.2GB peak, first-session compile ~10s then warm.
- Vocabulary biasing: Swift/Kotlin yes; **JS not yet** — terms always go via
  repair (`vocabularyVia: 'repair'`).
- Pin: `desert-ant-core 4.3.0`, weights `v0.5.0`.

## Licence / telemetry / attribution (DAL Source-Available 1.0, 2026-07-03)

- Free below **100,000 monthly active devices per platform per model**.
  Above → commercial (`licensing@desertant.com`).
- **Do not disable/tamper telemetry.** MAD-counting only, SDK-generated ID,
  no inputs/outputs/content, no cross-linking. Disclosed in PRIVACY.md and
  Help → About (`Voz by Desert Ant Labs`, https://desertant.com).
- Attribution: one discoverable placement — Settings/About screen + website
  legal page: `Voz by Desert Ant Labs` + link `https://desertant.com`
  (text-only OK offline). Keep file-level notices. 🐜 alone is not enough.
- No competing-model training on models/outputs/logs/embeddings/evals.
  No standalone redistribution. Secure weights. EU AI Act: DAL = model
  provider, Vell = system provider.
- Full terms: https://license.desertant.com/1.0
