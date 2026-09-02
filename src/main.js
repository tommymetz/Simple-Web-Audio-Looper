import './style.css';

// `new URL(..., import.meta.url)` is Vite's standard pattern for getting an
// asset's resolved URL in both dev and build, which is what addModule() needs.
const recorderProcessorUrl = new URL('./recorder-processor.js', import.meta.url);

const enableBtn = document.getElementById('enable-btn');
const looper = document.getElementById('looper');
const waveformCanvas = document.getElementById('waveform');
const recordBtn = document.getElementById('record-btn');
const playBtn = document.getElementById('play-btn');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const waveformCtx = waveformCanvas.getContext('2d');

// Fine-tune-only crop: how much of the recording's edge the zoomed drag view
// shows, and the full range the handle can travel — the drag can reach either
// end of this box.
const ZOOM_WINDOW_SECONDS = 0.4;
// Never let a crop leave less audio than this.
const MIN_KEPT_SECONDS = 0.05;
// Grabbing within this many CSS pixels of either edge starts a crop drag.
const EDGE_ZONE_PX = 28;
// Auto-applied after every recording to trim the button-press transient at the
// start. Also applied to the end, but only when recording was stopped with a
// tap (not a press-and-hold-then-release), since a hold's release is already
// timed to the performance rather than a separate button tap.
const AUTO_CROP_SECONDS = 0.05;

/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {MediaStream | null} */
let micStream = null;
/** @type {MediaStreamAudioSourceNode | null} */
let sourceNode = null;
/** @type {AudioWorkletNode | null} */
let workletNode = null;
/** @type {GainNode | null} */
let masterGain = null;

/** @type {Float32Array[]} raw chunks captured during the current recording */
let recordedChunks = [];
/** set by stopRecording(), read once the worklet acknowledges it has stopped */
let pendingStopApplyEndAutoCrop = true;
/** @type {Float32Array | null} full normalized recording, fixed per take — crop is always measured from these true edges */
let originalBuffer = null;
/** @type {Float32Array | null} originalBuffer with the committed crop applied — source of truth for future DSP and the main waveform view */
let masterBuffer = null;
/** @type {AudioBuffer | null} the FULL (uncropped) recording, built once per take — playback always uses this with loopStart/loopEnd so cropping never restarts the source */
let fullBuffer = null;
/** @type {AudioBufferSourceNode | null} recreated only on Record/Play/Pause — crop dragging just nudges its loopStart/loopEnd live */
let loopSource = null;

/** @type {'idle' | 'recording' | 'playing' | 'paused'} */
let state = 'idle';

let cropStartSec = 0;
let cropEndSec = 0;
/** @type {'start' | 'end' | null} which edge is currently being dragged */
let cropMode = null;
/** value being dragged; only meaningful while cropMode is set */
let draftCropSec = 0;
let dragging = false;
let dragRAF = null;

/** @type {number | null} */
let recordHoldTimer = null;
/** whether the press currently on RECORD is the one that started this recording (vs. a later press to stop it) */
let recordPressStartedRecording = false;
/** whether the current press has been held past RECORD_HOLD_MS — if so, release stops the recording */
let recordHoldThresholdPassed = false;
// How long a press has to be held before release stops the recording; a quicker
// release leaves it recording, waiting for a separate tap to stop it.
const RECORD_HOLD_MS = 350;

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function updateUI() {
  switch (state) {
    case 'idle':
      recordBtn.textContent = 'RECORD';
      recordBtn.classList.remove('recording');
      recordBtn.disabled = false;
      playBtn.textContent = 'PLAY';
      playBtn.disabled = !fullBuffer;
      statusEl.textContent = fullBuffer ? 'Ready.' : 'Ready to record.';
      break;
    case 'recording':
      recordBtn.textContent = 'STOP';
      recordBtn.classList.add('recording');
      recordBtn.disabled = false;
      playBtn.disabled = true;
      statusEl.textContent = 'Recording…';
      break;
    case 'playing':
      recordBtn.textContent = 'RECORD';
      recordBtn.classList.remove('recording');
      recordBtn.disabled = false;
      playBtn.textContent = 'PAUSE';
      playBtn.disabled = false;
      statusEl.textContent = 'Playing (looped).';
      break;
    case 'paused':
      recordBtn.textContent = 'RECORD';
      recordBtn.classList.remove('recording');
      recordBtn.disabled = false;
      playBtn.textContent = 'PLAY';
      playBtn.disabled = false;
      statusEl.textContent = 'Paused.';
      break;
  }

  if (cropMode) {
    recordBtn.disabled = true;
    playBtn.disabled = true;
    statusEl.textContent =
      cropMode === 'start' ? 'Dragging start point — release to set it.' : 'Dragging end point — release to set it.';
  }

  waveformCanvas.classList.toggle('cropping', !!cropMode);
}

async function initAudio() {
  audioCtx = new AudioContext();

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });

  await audioCtx.audioWorklet.addModule(recorderProcessorUrl);

  sourceNode = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor');

  // Keep the graph pulling on the worklet without ever feeding back to the speakers.
  const silentSink = audioCtx.createGain();
  silentSink.gain.value = 0;
  sourceNode.connect(workletNode).connect(silentSink).connect(audioCtx.destination);

  masterGain = audioCtx.createGain();
  masterGain.connect(audioCtx.destination);

  workletNode.port.onmessage = (event) => {
    if (event.data === 'stopped') {
      handleWorkletStopped();
      return;
    }
    recordedChunks.push(event.data);
  };
}

function concatChunks(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Scales samples in place so the peak absolute value is 1.0. No-op on silence. */
function normalize(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0 && peak !== 1) {
    const scale = 1 / peak;
    for (let i = 0; i < samples.length; i++) {
      samples[i] *= scale;
    }
  }
}

// Log-like visual compression for the waveform: pulls quiet parts up towards
// full height without touching peaks (1 stays 1). Lower = more compression.
const WAVEFORM_GAMMA = 0.5;

function compressAmplitude(v) {
  return Math.sign(v) * Math.abs(v) ** WAVEFORM_GAMMA;
}

/** Draws a min/max envelope of the whole buffer, scaled to fill the canvas box. */
function drawWaveform(samples) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = waveformCanvas.clientWidth;
  const cssHeight = waveformCanvas.clientHeight;
  waveformCanvas.width = cssWidth * dpr;
  waveformCanvas.height = cssHeight * dpr;
  waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  waveformCtx.clearRect(0, 0, cssWidth, cssHeight);

  if (!samples || !samples.length || !cssWidth) return;

  const mid = cssHeight / 2;
  const samplesPerPixel = samples.length / cssWidth;
  waveformCtx.strokeStyle = '#4a9eff';
  waveformCtx.beginPath();
  for (let x = 0; x < cssWidth; x++) {
    const start = Math.floor(x * samplesPerPixel);
    const end = Math.max(start + 1, Math.floor((x + 1) * samplesPerPixel));
    let min = 1;
    let max = -1;
    for (let i = start; i < end && i < samples.length; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    waveformCtx.moveTo(x + 0.5, mid - compressAmplitude(max) * mid);
    waveformCtx.lineTo(x + 0.5, mid - compressAmplitude(min) * mid);
  }
  waveformCtx.stroke();
}

/** Draws the full-loop waveform, tinting both edge zones to hint they're draggable into crop mode. */
function drawNormalView() {
  drawWaveform(masterBuffer);
  if (!masterBuffer || !masterBuffer.length) return;
  const cssWidth = waveformCanvas.clientWidth;
  const cssHeight = waveformCanvas.clientHeight;
  waveformCtx.fillStyle = 'rgba(74, 158, 255, 0.15)';
  waveformCtx.fillRect(0, 0, EDGE_ZONE_PX, cssHeight);
  waveformCtx.fillRect(cssWidth - EDGE_ZONE_PX, 0, EDGE_ZONE_PX, cssHeight);
}

function buildFullBuffer() {
  fullBuffer = audioCtx.createBuffer(1, originalBuffer.length, audioCtx.sampleRate);
  fullBuffer.copyToChannel(originalBuffer, 0);
}

/** The loop region currently in effect: draft value for whichever edge is being dragged, committed value otherwise. */
function currentLoopBounds() {
  const startSec = cropMode === 'start' ? draftCropSec : cropStartSec;
  const endSec = cropMode === 'end' ? draftCropSec : cropEndSec;
  return { loopStart: startSec, loopEnd: fullBuffer.duration - endSec };
}

/** Nudges the already-playing source's loop points — no restart, so the loop keeps playing through the change. */
function updateLoopPoints() {
  if (!loopSource) return;
  const { loopStart, loopEnd } = currentLoopBounds();
  loopSource.loopStart = loopStart;
  loopSource.loopEnd = loopEnd;
}

/** Re-slices originalBuffer by the committed crop points for the main waveform view and future DSP. */
function applyCrop() {
  const sampleRate = audioCtx.sampleRate;
  const startSample = Math.round(cropStartSec * sampleRate);
  const endSample = originalBuffer.length - Math.round(cropEndSec * sampleRate);
  masterBuffer = originalBuffer.slice(startSample, endSample);
  drawNormalView();
  updateLoopPoints();
}

/** How far this edge is still allowed to crop, given what the opposite edge already took and a minimum kept length. */
function maxCropForSide(side) {
  const originalDuration = originalBuffer.length / audioCtx.sampleRate;
  const oppositeSec = side === 'start' ? cropEndSec : cropStartSec;
  const available = Math.max(0, originalDuration - oppositeSec - MIN_KEPT_SECONDS);
  return Math.min(ZOOM_WINDOW_SECONDS, available);
}

/** Maps a 0-1 position across the zoomed drag view to a crop value in seconds, clamped to what's allowed. */
function draftFromFraction(side, fraction) {
  const raw = side === 'start' ? fraction * ZOOM_WINDOW_SECONDS : (1 - fraction) * ZOOM_WINDOW_SECONDS;
  return Math.min(maxCropForSide(side), Math.max(0, raw));
}

/** Inverse of draftFromFraction, for drawing the handle at the current draft value. */
function fractionFromDraft(side, sec) {
  return side === 'start' ? sec / ZOOM_WINDOW_SECONDS : 1 - sec / ZOOM_WINDOW_SECONDS;
}

/** Draws the near-edge zoom window with a draggable handle and dims the region that will be cropped away. */
function drawCropZoom() {
  const sampleRate = audioCtx.sampleRate;
  const windowSamples = Math.round(ZOOM_WINDOW_SECONDS * sampleRate);
  const startSample = cropMode === 'start' ? 0 : Math.max(0, originalBuffer.length - windowSamples);
  const slice = originalBuffer.subarray(startSample, startSample + windowSamples);

  drawWaveform(slice);

  const cssWidth = waveformCanvas.clientWidth;
  const cssHeight = waveformCanvas.clientHeight;
  const handleX = fractionFromDraft(cropMode, draftCropSec) * cssWidth;

  waveformCtx.fillStyle = 'rgba(211, 51, 51, 0.25)';
  if (cropMode === 'start') {
    waveformCtx.fillRect(0, 0, handleX, cssHeight);
  } else {
    waveformCtx.fillRect(handleX, 0, cssWidth - handleX, cssHeight);
  }

  waveformCtx.strokeStyle = '#d33';
  waveformCtx.lineWidth = 2;
  waveformCtx.beginPath();
  waveformCtx.moveTo(handleX, 0);
  waveformCtx.lineTo(handleX, cssHeight);
  waveformCtx.stroke();
  waveformCtx.lineWidth = 1;
}

function enterCropMode(side) {
  cropMode = side;
  draftCropSec = side === 'start' ? cropStartSec : cropEndSec;
  drawCropZoom();
  if (loopSource) {
    updateLoopPoints();
  } else {
    startPlayback();
  }
  updateUI();
}

function exitCropMode() {
  if (cropMode === 'start') {
    cropStartSec = draftCropSec;
  } else {
    cropEndSec = draftCropSec;
  }
  cropMode = null;
  // loopSource keeps playing uninterrupted — applyCrop() just re-affirms the
  // now-committed loop points (already in effect from the last drag update).
  applyCrop();
  updateUI();
}

/** Abandons the in-progress drag (e.g. pointercancel) without committing the draft value. */
function cancelCropMode() {
  cropMode = null;
  applyCrop();
  updateUI();
}

function scheduleDragUpdate() {
  if (dragRAF) return;
  dragRAF = requestAnimationFrame(() => {
    dragRAF = null;
    drawCropZoom();
    updateLoopPoints();
  });
}

function updateDragFromEvent(event) {
  const rect = waveformCanvas.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  draftCropSec = draftFromFraction(cropMode, fraction);
  scheduleDragUpdate();
}

/** Always starts from the top of the (possibly cropped) loop region. */
function startPlayback() {
  const { loopStart, loopEnd } = currentLoopBounds();
  loopSource = audioCtx.createBufferSource();
  loopSource.buffer = fullBuffer;
  loopSource.loop = true;
  loopSource.loopStart = loopStart;
  loopSource.loopEnd = loopEnd;
  loopSource.connect(masterGain);
  loopSource.start(0, loopStart);
  state = 'playing';
  updateUI();
}

function pausePlayback() {
  loopSource.stop();
  loopSource = null;
  state = 'paused';
  updateUI();
}

async function startRecording() {
  await audioCtx.resume();
  if (loopSource) {
    loopSource.stop();
    loopSource = null;
  }
  recordedChunks = [];
  workletNode.port.postMessage('start');
  drawWaveform(null);
  state = 'recording';
  updateUI();
}

/**
 * Tells the worklet to stop and finalizes once it acknowledges — rather than
 * finalizing immediately, which could race a backlog of already-recorded
 * chunks still sitting in the message queue and silently drop them.
 * applyEndAutoCrop is true for a tap-to-stop, false for a held-then-released stop.
 */
function stopRecording(applyEndAutoCrop) {
  pendingStopApplyEndAutoCrop = applyEndAutoCrop;
  workletNode.port.postMessage('stop');
}

function handleWorkletStopped() {
  const applyEndAutoCrop = pendingStopApplyEndAutoCrop;

  originalBuffer = concatChunks(recordedChunks);
  recordedChunks = [];
  normalize(originalBuffer);
  buildFullBuffer();

  cropStartSec = 0;
  cropEndSec = 0;
  cropStartSec = Math.min(AUTO_CROP_SECONDS, maxCropForSide('start'));
  if (applyEndAutoCrop) {
    cropEndSec = Math.min(AUTO_CROP_SECONDS, maxCropForSide('end'));
  }

  applyCrop();
  startPlayback();
}

window.addEventListener('resize', () => {
  if (cropMode) {
    drawCropZoom();
  } else {
    drawNormalView();
  }
});

enableBtn.addEventListener('click', async () => {
  enableBtn.disabled = true;
  try {
    await initAudio();
    enableBtn.hidden = true;
    looper.hidden = false;
    drawWaveform(null);
    state = 'idle';
    updateUI();
  } catch (err) {
    console.error(err);
    enableBtn.disabled = false;
    showError(
      err.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Please allow mic access and try again.'
        : `Could not access microphone: ${err.message}`
    );
  }
});

/** Shared by the RECORD button (pointerdown) and the spacebar (keydown) — same tap-vs-hold logic either way. */
async function handleRecordPress() {
  if (recordBtn.disabled) return;
  recordHoldThresholdPassed = false;

  if (state === 'recording') {
    // A later press, meant to stop the recording already in progress — decided on release.
    recordPressStartedRecording = false;
    return;
  }

  // Start immediately, whether this turns out to be a tap or a hold — no delay,
  // so the beginning of the loop is never lost waiting to see which it is.
  recordPressStartedRecording = true;
  await startRecording();
  recordHoldTimer = setTimeout(() => {
    recordHoldThresholdPassed = true;
  }, RECORD_HOLD_MS);
}

/** Shared by the RECORD button (pointerup) and the spacebar (keyup). */
function handleRecordRelease() {
  clearTimeout(recordHoldTimer);
  if (!recordPressStartedRecording) {
    // A tap while already recording always stops it, tap or hold — click mode.
    stopRecording(true);
  } else if (recordHoldThresholdPassed) {
    // Held past the threshold — release stops it, hold mode.
    stopRecording(false);
  }
  // Otherwise: released quickly — keep recording, waiting for a separate tap to stop it.
}

recordBtn.addEventListener('pointerdown', (event) => {
  recordBtn.setPointerCapture(event.pointerId);
  handleRecordPress();
});

recordBtn.addEventListener('pointerup', () => {
  handleRecordRelease();
});

recordBtn.addEventListener('pointercancel', () => {
  clearTimeout(recordHoldTimer);
  if (state === 'recording') {
    stopRecording(false);
  }
  recordPressStartedRecording = false;
});

// Keyboard activation (Tab + Enter) doesn't reliably fire pointer events, so it
// falls through to here as a plain toggle. Pointer clicks have detail >= 1 and
// are already fully handled above; Space is handled separately below, with
// preventDefault() on keydown suppressing this synthetic click for it.
recordBtn.addEventListener('click', async (event) => {
  if (event.detail !== 0) return;
  await audioCtx.resume();
  if (state === 'recording') {
    stopRecording(true);
  } else {
    await startRecording();
  }
});

// Spacebar mirrors the RECORD button's own press/release (tap vs. hold), as a global shortcut.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  event.preventDefault();
  handleRecordPress();
});

window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space') return;
  event.preventDefault();
  handleRecordRelease();
});

/** Shared by the PLAY/PAUSE button (click) and Enter (keydown). */
async function togglePlayPause() {
  if (playBtn.disabled) return;
  await audioCtx.resume();
  if (state === 'playing') {
    pausePlayback();
  } else if (state === 'paused') {
    startPlayback();
  }
}

playBtn.addEventListener('click', togglePlayPause);

// Enter mirrors the PLAY/PAUSE button, as a global shortcut.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Enter' || event.repeat) return;
  event.preventDefault();
  togglePlayPause();
});

waveformCanvas.addEventListener('pointerdown', (event) => {
  if (!fullBuffer || state === 'recording') return;

  if (!cropMode) {
    const rect = waveformCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x <= EDGE_ZONE_PX) {
      enterCropMode('start');
    } else if (x >= rect.width - EDGE_ZONE_PX) {
      enterCropMode('end');
    } else {
      return; // not near an edge — nothing to grab
    }
  }

  dragging = true;
  waveformCanvas.setPointerCapture(event.pointerId);
});

waveformCanvas.addEventListener('pointermove', (event) => {
  if (cropMode && dragging) {
    updateDragFromEvent(event);
    return;
  }
  // Not dragging — just show the resize cursor near a grabbable edge.
  if (cropMode || !fullBuffer) return;
  const rect = waveformCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const nearEdge = x <= EDGE_ZONE_PX || x >= rect.width - EDGE_ZONE_PX;
  waveformCanvas.classList.toggle('edge-hover', nearEdge);
});

waveformCanvas.addEventListener('pointerleave', () => {
  if (!cropMode) waveformCanvas.classList.remove('edge-hover');
});

waveformCanvas.addEventListener('pointerup', (event) => {
  if (!cropMode) return;
  dragging = false;
  waveformCanvas.releasePointerCapture(event.pointerId);
  exitCropMode();
});

waveformCanvas.addEventListener('pointercancel', () => {
  dragging = false;
  if (cropMode) cancelCropMode();
});
