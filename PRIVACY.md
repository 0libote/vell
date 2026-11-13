# Vell privacy notice

Last updated: 13 November 2026

Vell is a local-first dictation app for Windows and macOS. Your voice is
turned into text by a speech model installed on your computer and never
leaves it. There is no account, no sign-in, no cloud transcription, no
advertising, no analytics, and no crash reporting.

## On your computer

Vell keeps these on your computer, in its own data folder, and nowhere else:

- Your dictation history, so you can copy or review what you said.
- Your personal dictionary and the words it learns from your corrections.
- Audio recordings only while "Keep recordings" is on, which it is **off**
  by default: the clip behind each dictation for 14 days, so you can replay
  it or transcribe it again. Audio from a dictation that failed to transcribe
  is kept the same way, so you can recover the words from the Dictation page;
  those clips are transcribed only when you press Recover, using the speech
  engine you have selected at the time. Turning "Keep recordings" off deletes
  all of it. You can delete recordings from Settings at any time.
- Your settings.

## Model downloads

Speech models, the Python speech runtime and GPU packs are downloaded only
when you choose them in Settings → Speech engines, from GitHub releases and
Hugging Face. Each download is hash-verified. No other network access happens
without you asking for it. See `docs/NETWORK.md` for the full inventory.

## What Vell does not do

- No accounts, subscriptions, word limits or paid features.
- No sending of audio or transcripts anywhere, ever.
- No analytics or tracking of what you type or where you dictate.
- No reading of the apps you dictate into beyond placing the text there.

## Desert Ant Labs (future)

Vell's planned on-device engine (Voz) has not been integrated yet, so this
build sends nothing to Desert Ant Labs. When Voz ships, its SDK reports a
minimal device count (monthly active devices) as its licence requires: an
SDK-generated identifier, no audio, no text, no account linkage. That
telemetry cannot be disabled, and it will be disclosed here before any Voz
build ships. Full terms: https://license.desertant.com/1.0

## Deleting your data

Uninstalling Vell and deleting its data folder removes everything it kept.
There is no server copy of anything because there is no server.
