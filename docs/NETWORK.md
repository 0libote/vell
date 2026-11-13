# Network inventory

Vell makes **no outbound connections at runtime** except user-triggered model
downloads. Verified by `grep` over `src/`, `sidecar/`, `scripts/lib/`.

## Runtime (after model installed, offline OK)

- None. Dictation, cleanup, dictionary, insertion, history all run locally.
- No account, telemetry, analytics, crash-report, update-check, Discord,
  announcement, or cloud-inference traffic. `electron-updater` removed.
- `discord.exe` strings in `style.js`/`app.js` are local app-classification
  allowlists, not network.

## User-triggered downloads (Settings → Speech engines, explicit consent)

- `api.github.com/repos/0libote/vell` — managed Python runtime, model packs,
  GPU packs (`src/release-download.js`, `src/asr-runtime.js`,
  `src/asr-model.js`). Defaults repointed from `sounak1125/voxden` to
  `0libote/vell`; overrides `VELL_ASR_*` / legacy `VOXDEN_ASR_*` envs kept.
- `huggingface.co` — open model weights (Qwen, Parakeet, Whisper packs in
  `src/speech-model-catalog.json`). Pinned revisions + SHA verification.
- Build-time only: `download.pytorch.org`, `repo.radeon.com`,
  `python.org/ftp`, `astral-sh/python-build-standalone` (runtime pack
  assembly, not app runtime).

## Informational links (no fetch)

- `amd.com` driver release-notes URL in `qwen-accel-catalog.json`.
- `w3.org` SVG namespace.

## Desert Ant Labs (future, not yet integrated)

- No Desert Ant traffic in this build. Once Voz lands, expected connections
  are: first-time model download (explicit onboarding step) + minimal
  MAD-counting telemetry (SDK-generated ID, no audio/text). **Do not disable
  that telemetry.** See `docs/DESERT-ANT.md`. It must be disclosed in the
  privacy notice before shipping any Voz build.

## Audit command

```sh
grep -rniE "fetch\(|axios|https?://|wss?://|electron-updater|sentry|telemetry|openrouter|razorpay|discord\.com/api|account\.voxden|voxden\.app" src/ sidecar/ | grep -v "discord\.exe\|w3\.org\|amd\.com\|huggingface\|api\.github"
# expect: no output
```
