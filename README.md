# Audio Looper

A self-contained, backend-free audio looper for the browser. Record from your mic, and it loops back instantly, normalized to full volume.

See it in action at [simple-web-audio-looper.netlify.app](https://simple-web-audio-looper.netlify.app/)

## Features

- **Record / Play / Pause** — tap RECORD to start and stop, or press and hold to record only while held.
- **Auto-normalize** — every recording is scaled so its peak hits 1.0.
- **Waveform view** — shows the whole loop, with a log-like amplitude curve so quiet parts stay visible.
- **Quick crop** — drag either edge of the waveform to trim a click or a stray moment off the start/end; the loop keeps playing live while you adjust. A tiny crop is also applied automatically after every recording.
- **Keyboard shortcuts** — `Space` = RECORD (tap or hold, same as the button), `Enter` = PLAY/PAUSE.
- **No backend, no build-time secrets** — pure client-side Web Audio API (`AudioWorklet` for capture, `AudioBufferSourceNode` for looped playback).

## Getting started

```bash
npm install
npm run dev
```

Opens a local dev server (Vite) — visit the printed `localhost` URL and click "Enable Microphone" to grant mic access.

## Build

```bash
npm run build
```

Outputs a static site to `dist/` — plain HTML/CSS/JS, no server required.

## Browser notes

- Microphone access requires a secure context — works on `localhost` and any `https://` deploy. `file://` works in Chrome/Firefox but **not** in Safari (especially iOS), so test on a phone via a local server (`https`) or a deployed URL.
- Recording is mono, with echo cancellation/noise suppression/auto-gain disabled so the raw signal isn't altered before capture.

## Known issue: Android Chrome

Recordings made in Chrome on Android tend to have noticeable silence before the loop starts and lose the last bit of audio at the end. This looks like real input latency in Android's audio pipeline — a gap between a sound happening and it actually reaching the browser — so the first stretch captured is often silence from just before you pressed, and the very end of what you said/played hasn't arrived yet by the time you release.

We tried compensating for this (delaying the stop, trimming more automatically) and reverted it: the fix required adding a deliberate wait before the loop starts playing, which defeats the instant tap-to-loop feel and can't be "timed around" by the user anyway. Works well on desktop Chrome/Firefox and iOS Safari, where this latency isn't an issue. On Android, the manual crop (drag the waveform edges) is the best way to fix an imperfect loop after recording it.
