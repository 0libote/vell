# Dictation shortcuts

Multiple keybinds, each with its own dictation mode. One entry per row in
Settings → Shortcuts, one tray submenu per shortcut.

## Data model

`settings.shortcuts`: array of `{ id, accelerator, mode }`.

- `id`: stable `crypto.randomUUID()`, persisted. Never reused.
- `accelerator`: Electron accelerator string (`CommandOrControl+Shift+Space`).
- `mode`: `toggle` | `ptt` | `both` (`hotkeys.normalizeDictationMode`).
- `purpose`: **reserved, unused**. Future per-shortcut dictation profiles
  (e.g. an email shortcut that forces the email tone). Nothing reads it yet.

`settings.shortcut` / `settings.dictateMode` are legacy scalars, kept as
mirrors of the first (primary) entry by `syncPrimaryShortcutScalars()` for
old settings files and readers. New code reads `dictationShortcuts()`.

Migration: `loadSettings` runs `normalizeShortcuts(settings.shortcuts,
{ accelerator: settings.shortcut, mode: settings.dictateMode })` — an old
file's single chord becomes the first entry; duplicates collapse; an empty
list falls back to the platform default. Always at least one entry.

## Registration and routing (`src/main.js`)

Each shortcut owns two registrations, both keyed by id:

- `registeredGlobals: Map(id → accelerator)` — `globalShortcut`.
- `chordWatchers: Map(id → { proc, accel, mode, restartTimer, restartDelay,
  staleHeld, skipPress })` — one native helper process per shortcut on
  win32/darwin. Every shortcut gets a watcher (toggle needs it for lone-key
  and modifier-only chords whose release *is* the press; edge modes need it
  for DOWN/UP).

Event routing reads the entry's mode **live** at press/release time, so
changing a mode needs no re-registration:

- `toggle`: globalShortcut press alternates start/stop
  (`dictationHotkeyHandler(id)`). Watcher releases only forward lone-key and
  modifier-only chords.
- `ptt` / `both`: the watcher owns both edges (`pttPress({id, mode})` /
  `pttRelease(dirty, {id, mode, heldMs})`); the globalShortcut press is
  ignored to avoid double-handling.

Ownership of a live recording is the string `'game'` or
`'dictation:<id>'` in `pttOwner`. `ownerUsesEdges(owner)` resolves whether
that owner still wants edge semantics (game follows the primary shortcut).

## Modes

| mode | press DOWN | release UP < 300ms | release after hold | next press while locked |
|---|---|---|---|---|
| `toggle` | start (or stop) | — (ignored) | — (ignored) | stop |
| `ptt` | start | **cancel** (discard, hold-only) | stop & transcribe | — |
| `both` | start | **lock on** (`pttLocked`, stops on next press) | stop & transcribe | stop |

`pttLocked` is tap-lock state, not a mode: in `both` it means "a tap is
keeping this alive"; the overlay title already reflects it
(`recordingTitle`). The 300ms constant is `PTT_TAP_MS`.

## IPC (`settings-set` patch keys)

- Legacy `shortcut` (string) / `dictateMode` → apply to the **primary**
  shortcut. Kept for old renderers and tests.
- `shortcutAdd: accelerator` → `{ ok, id?, reason? }` (snapshot carries
  `shortcutAddedId` on success). New entries start as `toggle`.
- `shortcutUpdate: { id, accelerator?, mode? }` → per-field validation with
  the same conflict rules (paste-last, game, other dictation shortcuts) and
  registration rollback as the legacy path.
- `shortcutRemove: id` → refuses the last entry
  (`'Keep at least one dictation shortcut.'`). Stops a live recording the
  removed shortcut owns instead of stranding the bar.

`snapshot()` exposes `shortcuts: [{ id, accelerator, label, mode }]` plus
the primary as `shortcut` / `shortcutLabel` / `dictateMode`. The overlay
receives the *active* recording's mode as `dictateMode` (`activeDictateMode()`),
primary when idle.

## UI (`src/app.html`, `src/app.js`)

The shortcuts dialog renders `#shortcut-list` from `data.shortcuts`: each
row has its keycaps (click to re-capture → `shortcut-change:<id>`), a
three-way segmented mode radio (→ `shortcutUpdate`), and remove (disabled
when alone). `#shortcut-add` captures → `shortcutAdd`. The General panel
lost its Dictation-mode segmented; mode lives only per row.

## Adding per-shortcut purposes (future)

`purpose` is reserved on each entry for profiles such as "email". Suggested
shape when the time comes:

1. `normalizeShortcuts`: accept and validate `purpose` (e.g.
   `'default' | 'email' | ...`, default `'default'`).
2. Carry it through snapshot `shortcuts[]` and the three `shortcut*` IPC ops.
3. Recording path: stash the owner's purpose at `startRecording` (next to
   `pttOwner`, e.g. `pttPurpose`), then apply it in `composeTranscript` —
   the cheapest email semantic is a tone override: pass the purpose's tone
   instead of `style.toneForCategory(...)` when set.
4. UI: one more control per row (or extend the mode segmented into cards);
   tray submenu gains a purpose section under each shortcut.
5. Tests: extend `test-ptt.js` (purpose carried into `composeTranscript`) and
   `test-general-settings-main.js` (IPC validation).
