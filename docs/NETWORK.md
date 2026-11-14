# Network inventory

Vell makes **no outbound connections at runtime** except the user-triggered
Voz model download and the Desert Ant SDK's mandatory device-count telemetry.
Verified by `grep` over `src/`.

## Runtime (after model installed, offline OK)

- Dictation, cleanup, dictionary, insertion, history all run locally.
- No account, analytics, crash-report, update-check, or cloud-inference
  traffic. `electron-updater` removed.
- `discord.exe` strings in `style.js`/`app.js` are local app-classification
  allowlists, not network.

## User-triggered download (Settings → Speech engines, explicit consent)

- `huggingface.co` — the Voz bundle (~409MB) via the Desert Ant Labs SDK,
  cached under the OS cache root (`Library/Caches/desert-ant-models` on macOS).
  Fetched once on setup, then offline.

## Desert Ant Labs telemetry (mandatory, disclosed)

- The Voz SDK reports a minimal device count (monthly active devices) as its
  licence requires: an SDK-generated ID, no audio, no text, no account
  linkage. **Do not disable that telemetry.** Disclosed in PRIVACY.md,
  Settings → Help → About, and `docs/DESERT-ANT.md`.

## Informational links (no fetch)

- `w3.org` SVG namespace.

## Audit command

```sh
grep -rniE "fetch\(|axios|https?://|wss?://|electron-updater|sentry|telemetry|openrouter|razorpay|discord\.com/api|account\.voxden|voxden\.app" src/ | grep -v "discord\.exe\|w3\.org\|huggingface\|desertant\|license\.desertant"
# expect: no output except the documented Hugging Face + Desert Ant references
```
