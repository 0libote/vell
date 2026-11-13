<img src="assets/icon.svg" width="64" height="64" alt="Vell icon">

# Vell

**Fast, private, on-device voice dictation.**

Speak naturally. Type instantly.

Press a key, talk, and the text lands in whatever app you were typing in.
No account. No word limits. Your audio never leaves your computer.

## Status

Local-first Electron app for Windows 10/11 and macOS (Apple silicon).
Island recording bar retained from the Voxden foundation
(`sounak1125/voxden` @ `2d567bc` — see `SOURCE-ATTRIBUTION.md`).

- Dictation runs fully offline once a speech model is installed.
- Model install is explicit (Settings → Speech engines), verified by hash.
- No hosted services, billing, telemetry, or auto-update.

## Quick start (dev)

```sh
npm ci
npm start            # Electron, local sidecar
npm run dist         # Windows installer (never publishes)
npm run dist:mac     # macOS dmg/zip
node scripts/test-transcription-provider.js
node scripts/test-asr-capabilities.js
```

## Docs

- `docs/ARCHITECTURE.md` — processes, modules, dictation flow
- `docs/SPEECH-PIPELINE.md` — stages + how to add a provider
- `docs/ISLAND.md` — recording-bar files, states, tests
- `docs/DESERT-ANT.md` — Voz integration plan, licence/telemetry
- `docs/NETWORK.md` — outbound-connection inventory (none at runtime)
- `SOURCE-ATTRIBUTION.md` — upstream provenance
- `THIRD_PARTY_NOTICES.md` — retained third-party notices

## Licence

MIT (see `package.json`). Third-party model/runtime notices in
`THIRD_PARTY_NOTICES.md` must be kept in distributions.

Desert Ant Labs models (when integrated) use their own
[Source-Available License](https://license.desertant.com/1.0) — free below
100k monthly active devices per platform per model, attribution required,
minimal MAD telemetry must stay on. See `docs/DESERT-ANT.md`.
