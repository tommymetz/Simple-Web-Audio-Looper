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
/** @type {Float32Array | null} concatenated, normalized PCM — source of truth for future DSP */
let masterBuffer = null;
/** @type {AudioBuffer | null} playable form rebuilt from masterBuffer */
let audioBuffer = null;
/** @type {AudioBufferSourceNode | null} recreated on every play (one-shot nodes) */
let loopSource = null;

/** @type {'idle' | 'recording' | 'playing' | 'paused'} */
let state = 'idle';
let pauseOffset = 0;
let playStartTime = 0;

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
      playBtn.disabled = !audioBuffer;
      statusEl.textContent = audioBuffer ? 'Ready.' : 'Ready to record.';
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
    if (state === 'recording') {
      recordedChunks.push(event.data);
    }
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
    waveformCtx.moveTo(x + 0.5, mid - max * mid);
    waveformCtx.lineTo(x + 0.5, mid - min * mid);
  }
  waveformCtx.stroke();
}

function buildAudioBuffer() {
  audioBuffer = audioCtx.createBuffer(1, masterBuffer.length, audioCtx.sampleRate);
  audioBuffer.copyToChannel(masterBuffer, 0);
}

function startPlayback(offset) {
  loopSource = audioCtx.createBufferSource();
  loopSource.buffer = audioBuffer;
  loopSource.loop = true;
  loopSource.connect(masterGain);
  loopSource.start(0, offset);
  playStartTime = audioCtx.currentTime;
  pauseOffset = offset;
  state = 'playing';
  updateUI();
}

function pausePlayback() {
  const elapsed = audioCtx.currentTime - playStartTime + pauseOffset;
  pauseOffset = elapsed % audioBuffer.duration;
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
  drawWaveform(null);
  state = 'recording';
  updateUI();
}

function stopRecording() {
  masterBuffer = concatChunks(recordedChunks);
  recordedChunks = [];
  normalize(masterBuffer);
  buildAudioBuffer();
  drawWaveform(masterBuffer);
  startPlayback(0);
}

window.addEventListener('resize', () => drawWaveform(masterBuffer));

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

recordBtn.addEventListener('click', async () => {
  await audioCtx.resume();
  if (state === 'recording') {
    stopRecording();
  } else {
    await startRecording();
  }
});

playBtn.addEventListener('click', async () => {
  await audioCtx.resume();
  if (state === 'playing') {
    pausePlayback();
  } else if (state === 'paused') {
    startPlayback(pauseOffset);
  }
});
