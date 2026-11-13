# Island recording bar

The compact Wispr Flow-style pill. Do not redesign.

## Files

- `src/flow-bar.js` — pure anchor math (`rectFor`, `clampRect`,
  `displayForPoint`, `resolveAnchor`, `defaultAnchor`, `BOTTOM_GAP=4`). No
  Electron. Unit-tested.
- `src/overlay.html` — shell (loads `flow-motion.js`, `overlay.css`,
  `flow-styles.css`, `theme.css`, `chunking.js`, `speech-gate.js`,
  `energy-orb.js`, `sound-cues.js`, `overlay.js`).
- `src/overlay.js` — state machine + mic + waveform + drag emit
  (`setMode()`: `idle/hover/arming/recording/transcribing/success/error/learned`;
  `flow-idle` class; `pill` class per `hudMode`; analyser → `barLevel`/`scaleY`;
  orb via `energy-orb.js` rAF; drag via `overlay-drag-start/end` IPC).
- `src/flow-motion.js` — `normalizePreference` / `createController`
  (`system/reduced/full` → `data-flow-motion`).
- `src/dictation-island.css`, `src/flow-styles.css`, `src/overlay.css`,
  `src/island-shell.css` — capsule, line-twin, controls, Orb variant.
- `src/overlay-health.js` — `createHealthMonitor`, `createFrameMonitor`.
- `src/main.js` — `overlayWin` (frameless, transparent, always-on-top),
  `resolveAnchor`/`positionOverlay`/`overlayDrag` (16ms timer), multi-monitor
  (`screen.getDisplayMatching`), saved position, `hud-*` IPC, focus restore.
- `src/preload.js` — `window.vell` bridge (`state`, `transcript`, `flushAudio`,
  `flow-bar-*`, `hud-*`).
- `src/hotkeys.js` — defaults, chord-watch, tray labels.

## Behaviour contract

Compact pill at rest → expands on hover → recording with live level →
transcribing spinner → success/error flash. Draggable anywhere, remembered per
monitor. Mic + shortcut + click to dictate. `Esc` cancels. Focus returns to
the previously focused app for paste.

## Tests

`test-flow-bar(-state, -lifecycle, -main, -ui)`, `test-flow-motion*`,
`test-flow-styles-ui`, `test-island-flow-ui`, `test-island-shell-ui`,
`test-flow-animation-lifecycle-ui`, `test-flow-bar-audio-ui`,
`test-flow-bar-input-native`, `test-flow-frame-recovery*`,
`test-overlay-health`, `test-capture*` (screenshot path only).
Cloud/account states were removed; animation system untouched.
Run: `node scripts/test-flow-bar-state.js` etc. (node-only parts pass on
Linux; Electron UI parts need win32/darwin).
