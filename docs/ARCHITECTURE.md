# Vell Architecture

Vell is a local-first Electron dictation app for macOS and Windows.
No account, no word limits, no cloud fallback.

## Processes

- **Main** (`src/main.js`, ~8k lines): owns `BrowserWindow`s, tray, global
  shortcuts, audio session orchestration, Voz lifecycle, settings/history
  stores, clipboard insertion. All privileged work lives here.
- **Renderer — dashboard** (`src/app.js/html`, `src/preload.js`): settings,
  history, dictionary, speech-engine panel. Talks to main only via
  `window.vell` bridge (`preload.js`). No Node in renderer.
- **Renderer — overlay / Island** (`src/overlay.html/js/css`): floating pill,
  mic capture, waveform, drag/positioning. Talks to main via IPC
  (`transcript`, `flushAudio`, `flow-bar-*`, `hud-*`).
- **Renderer — capture** (`src/capture.*`): screenshot annotation + voice.
- **Transcription (in-process)**: `src/transcription-provider.js`
  (`VozProvider`, shared via `ensureVoz()`/`dropVoz()`) + `onnxruntime-node`
  (CPU) + `@desert-ant-labs/voz` SDK. The model bundle (~409MB) is fetched
  once by the SDK and cached under the OS cache root — no Python, no sidecar.
- **Native helpers**: Windows `scripts/win32.ps1` (paste, foreground-watch,
  hotkey-watch); macOS `helper/mac/main.swift` + `src/mac-shell.js` (AXUI
  focus, Cmd+V paste, foreground watcher).

## Key modules

| Area | Files |
|---|---|
| Island bar | `flow-bar.js` (anchor math), `overlay.js` (state machine), `dictation-island.css`, `flow-styles.css`, `overlay.css`, `island-shell.css`, `flow-motion.js`, `energy-orb.js`, `sound-cues.js`, `speech-gate.js`, `overlay-health.js` |
| Shortcuts | `hotkeys.js` + `main.js` `tryRegisterDictationShortcut` (globalShortcut + chord-watch helper) |
| Audio | `overlay.js` (getUserMedia → AudioContext → chunker), `chunking.js`, `media-controller.js` (duck music) |
| Speech | `asr.js` (Voz-only catalog), `asr-capabilities.js` (Voz-only capabilities), `voz-model.js` (install/remove/snapshot), `model-plan.js` (single-component plan), `transcription-provider.js` (Voz + mock providers) |
| Text | `cleanup.js`, `numbers.js`, `spoken-corrections.js`, `style.js` (per-app), `dictionary.js`, `auto-dictionary.js`, `correction-learning.js`, `correction-observer.js`, `corpus.js`, `repair.js`, `hinglish.js`, `phonetics.js`, `vocabulary.js` |
| Insert | `clipboard-paste.js`, `mac-shell.js`, `elevation.js`, `win32.ps1` |
| Stores | `atomic-store.js`, `history-store.js`, `history-usage.js`, `models.js`, `corpus.js` (14d/512MB recordings, default OFF) |
| Infra (removed) | `server/`, `deploy/`, `site/`, `android/`, `training/` deleted; `account.js`, `cloud.js`, `google-auth.js`, `signin.*`, `credits/quota/feedback/polish/updater/billing` deleted |

## Data flow (local dictation)

1. Shortcut → main shows overlay at saved anchor (`flow-bar.js` `resolveAnchor`).
2. Overlay captures mic, streams PCM chunks → `capture-flush` IPC → main.
3. Main routes via `model-plan.js` + `asr-capabilities.js` (`planRoute` → always Voz) → `vozTranscribe`.
4. Transcript → `cleanup` → `numbers` → `dictionary/repair` → `style` → `spoken-corrections`.
5. `clipboard-paste` writes text, sends paste keys, restores clipboard. Focus restored via native helper.
6. History/dictionary persisted locally. `Esc` cancels. No network (except mandatory Desert Ant device-count telemetry).

## Island state machine

`overlay.js` `setMode()`: `idle → hover → arming → recording → transcribing → success | error`, plus `learned`.
Waveform: WebAudio analyser → `barLevel`/`scaleY`; processing orb via `energy-orb.js` rAF.
Position: `main.js` `resolveAnchor`/`positionOverlay`/`overlayDrag` (16ms timer), multi-monitor via `screen.getDisplayMatching`, `BOTTOM_GAP=4`.

See `docs/ISLAND.md`, `docs/SPEECH-PIPELINE.md`.
