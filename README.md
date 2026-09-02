# Audio Looper

A self-contained, backend-free audio looper for the browser. Record from your mic, and it loops back instantly, normalized to full volume.

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
