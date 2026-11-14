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

The Voz speech model (~409 MB) is downloaded once, when you set up dictation,
from Hugging Face via the Desert Ant Labs SDK, and cached on this PC. No other
network access happens without you asking for it. See `docs/NETWORK.md` for
the full inventory.

## What Vell does not do

- No accounts, subscriptions, word limits or paid features.
- No sending of audio or transcripts anywhere, ever.
- No analytics or tracking of what you type or where you dictate.
- No reading of the apps you dictate into beyond placing the text there.

## Desert Ant Labs

Vell's speech engine is Voz by Desert Ant Labs (Source-Available License 1.0:
https://license.desertant.com/1.0, free below 100,000 monthly active devices
per platform). Its SDK reports a minimal device count (monthly active
devices) as the licence requires: an SDK-generated identifier, no audio, no
text, no account linkage. That telemetry cannot be disabled.

## Deleting your data

Uninstalling Vell and deleting its data folder removes everything it kept.
There is no server copy of anything because there is no server.
